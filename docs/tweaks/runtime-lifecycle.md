# Runtime and Lifecycle

Tweaker loads a runtime from the user data directory. That runtime discovers
tweaks, starts main-process tweaks, injects a renderer preload into Codex
windows, and starts renderer tweaks from that preload.

## Processes

| Process | What runs there |
|---|---|
| Main | Tweak discovery, main-scoped tweak loading, disk storage, MCP sync, tweak filesystem IPC, Codex window APIs, store install/update checks. |
| Renderer preload | Settings injection, renderer-scoped tweak loading, DOM access, React fiber helpers, renderer storage, renderer IPC wrapper. |

## Scope Loading Rules

| Manifest `scope` | Main host | Renderer host |
|---|---:|---:|
| `renderer` | no | yes |
| `main` | yes | no |
| `both` | yes | yes |
| omitted | yes | yes |

Set `scope` explicitly. Omitted scope is currently equivalent to `both`.

## Lifecycle

```js
module.exports = {
  async start(api) {
    // Called when this process loads the tweak.
  },

  async stop() {
    // Called during reload/disable/shutdown where possible.
  },
};
```

Main lifecycle:

- Discover tweaks under `<userRoot>/tweaks`.
- Sync MCP servers for enabled tweaks.
- Start enabled main-capable tweaks.
- Stop all main tweaks on hot reload, disable/enable changes, and app shutdown.
- Flush main storage during stop/shutdown.

Renderer lifecycle:

- Ask main for the discovered tweak list and user paths.
- Skip disabled tweaks, missing entries, and `scope: "main"` tweaks.
- Read tweak source through main IPC.
- Evaluate the entry in the sandboxed preload context.
- Call `start(api)`.
- Call `stop()` during hot reload and before reloading renderer tweaks.

## Hot Reload

The main process watches the tweaks directory. Changes are debounced, then the
runtime:

1. Stops all main tweaks.
2. Clears cached tweak modules under the tweaks directory.
3. Re-discovers tweak manifests and entries.
4. Restarts main tweaks.
5. Broadcasts `tweaker:tweaks-changed` to renderers.
6. Renderers stop loaded renderer tweaks and start them again from fresh source.

Make all mutations idempotent. Codex can also re-render its own DOM without a
Tweaker hot reload.

## Cleanup Checklist

Clean these in `stop()`:

- DOM nodes you inserted outside Tweaker settings pages.
- `<style>` tags you inserted.
- Event listeners on `window`, `document`, or Codex DOM nodes.
- `MutationObserver`, `ResizeObserver`, `IntersectionObserver`.
- `setInterval` / `setTimeout`.
- IPC listeners returned from `api.ipc.on`.
- External processes or file handles from main-process tweaks.

`stop()` should tolerate being called more than once.

## Storage Locations

| API | Process | Backing store |
|---|---|---|
| `api.storage` | renderer | `localStorage["tweaker:storage:<id>"]` |
| `api.storage` | main | `<userRoot>/storage/<id>.json` |
| `api.fs` | renderer/main | `<userRoot>/tweak-data/<id>/` |

Renderer `api.fs` calls are proxied through main IPC because the renderer is
sandboxed.

## Renderer Sandbox

Renderer tweaks are evaluated with `new Function` inside the preload context.
They receive `module`, `exports`, and `console`, but not arbitrary Node
`require`. Bundle dependencies into the entry file before installing.

Use [TypeScript and bundling](./typescript-and-bundling.md) for build examples.

## Safe Mode and Enable Flags

Tweaker stores enable flags in `<userRoot>/config.json`.

- Missing enable state means enabled.
- Safe mode disables tweak loading.
- Toggling a tweak from Settings -> Tweaks triggers a full reload cycle.

## Failure Behavior

- Invalid or missing manifests are skipped during discovery.
- Tweak start errors are logged and do not stop other tweaks.
- Renderer load failures are mirrored to `<userRoot>/log/preload.log`.
- Main load failures are written to `<userRoot>/log/main.log`.

## Activation resources (runtime 1.1)

`api.lifecycle.signal` is cancelled when an activation is stopped or fails.
Register cleanup as soon as a resource is acquired with
`api.lifecycle.add(() => resource.dispose())`. Its returned disposer is idempotent.
The host releases tracked IPC, settings pages and host-surface subscriptions after
`stop()`, including a failed startup. Async `stop()` is awaited; a shutdown that
exceeds five seconds holds reload rather than starting an overlapping activation.
Direct DOM changes and unregistered timers still require the tweak's cleanup.
Check the signal after asynchronous work before changing the DOM.

Renderer reload requests arriving during startup are coalesced into another
reload, so a newer enabled state is not dropped.

## Backend hooks

Main-scoped tweaks with `backend-hooks` permission can register isolated modules:

```js
module.exports = {
  async start(api) {
    await api.backend.register({ entry: "hooks.cjs", exportName: "transform", kind: "transform" });
  },
};
```

```js
// hooks.cjs — executes in its own worker; do not depend on start() closures.
exports.transform = ({ params }) => ({
  input: params.input.map(item => item.type === "text"
    ? { ...item, text: item.text + "\nUse concise explanations." }
    : item),
});
```

Transforms apply only to `turn/start` and `turn/steer`. Return a partial update,
not the complete request. Existing text inputs may change; other input items,
request IDs, thread IDs, permission policy and authentication remain native-owned.
`turn/start` also permits `model`, `effort`, and `summary` string/null updates.
Hooks run in tweak-ID order, then registration order. A failed, invalid or timed
out transform returns an explicit error to the caller before provider dispatch.
There is no tool-result replacement or permission override.

`kind: "observe"` receives `{method, params}` for `turn/started`, `turn/completed`,
`item/started`, and `item/completed`. Notifications are observational and cannot
replace output. Failures are isolated and do not delay the native stream.
Each hook has a queue limit of 16, a one-second invocation deadline, a 64 MiB
worker heap limit, and no idle polling. A tweak may register up to eight hooks.
The host closes workers on failed startup, disable and reload. Inspect
`api.backend.diagnostics()` for failed or pending hooks. Workers isolate execution
and memory pressure; they are not a security sandbox for untrusted code.

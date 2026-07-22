# Tweaker

Tweaker lets you install local tweaks into the OpenAI Codex desktop app. Tweaks
can change UI, add settings pages, run main-process code, and use native
OS-level features through the Tweaker bridge.
[Join the Discord community](https://discord.gg/6bY6gGX36H).

<img width="1413" height="1016" alt="Tweaker settings screenshot" src="https://github.com/user-attachments/assets/ea0b2ffc-c30d-4f68-ae12-dd8d6a997b2f" />

> Unofficial project. Not affiliated with OpenAI. Use at your own risk.

## TL;DR

Tweaker patches your local Codex app so Codex loads a small Tweaker runtime on
startup.

That runtime lives in your user data directory, not inside Codex. It finds
tweaks in a local `tweaks/` folder and loads them when Codex opens.

The app patch is tiny. Your tweaks, config, logs, backups, and runtime files
stay outside the app bundle, so you can edit tweaks without rebuilding Codex.

When Codex updates, the patch is usually removed. Tweaker installs a watcher
that notices this and re-applies the patch.

1.0.0 adds cleaner patching, better debug output, Owl runtime detection,
browser-host debugging, and native bridge support for AppKit, Metal, helper
processes, and tweak-owned native modules.

## Table Of Contents

- [Install](#install)
- [What Tweaker Is](#what-tweaker-is)
- [How It Works](#how-it-works)
- [Common Commands](#common-commands)
- [Where Files Live](#where-files-live)
- [Writing Tweaks](#writing-tweaks)
- [Bundled Tweak Namespace](#bundled-tweak-namespace)
- [Owl And Native Bridge](#owl-and-native-bridge)
- [Browser Host Mode](#browser-host-mode)
- [Updates And Recovery](#updates-and-recovery)
- [Security](#security)
- [More Docs](#more-docs)

## Install

Agentic install, from Codex:

```text
Inspect and install this for me: https://github.com/therealityreport/tweakers
Tell me where you install it and send me the local path for adding new tweaks.
```

GitHub source installer:

```sh
curl -fsSL https://raw.githubusercontent.com/therealityreport/tweakers/main/install.sh | bash
```

(The old third-party Homebrew tap is deprecated and untrusted; it points at a
separate donor project. Use the `therealityreport/tweakers` tap instead.)

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/therealityreport/tweakers/main/install.ps1 | iex
```

Bun:

```sh
bun install -g github:therealityreport/tweakers
tweaker install
```

After install, launch Codex normally. Open Settings and look for the Tweaker
section.

## What Tweaker Is

Tweaker is a tweak loader for Codex Desktop.

It gives you:

- A local `tweaks/` folder.
- A runtime that loads renderer and main-process tweaks.
- A Tweaker Settings section inside Codex.
- CLI tools for install, repair, update, debug, and tweak development.
- A watcher that repairs Tweaker after Codex updates.
- A public SDK for tweak authors.
- Native bridge APIs for advanced macOS tweaks.

It does not replace Codex, proxy your account, or run a separate Codex clone.
It modifies your installed app so it can load local code.

## How It Works

Install flow:

1. Tweaker finds your Codex app.
2. It backs up the unpatched app files.
3. It patches Codex `app.asar` so a Tweaker loader runs first.
4. It stages the Tweaker runtime in your user data directory.
5. It re-signs the app when needed.
6. It installs a watcher for future Codex updates.

Runtime flow:

1. You launch Codex.
2. The Tweaker loader starts.
3. The loader starts the Tweaker runtime from disk.
4. Codex starts normally.
5. Tweaker discovers enabled tweaks.
6. Renderer tweaks run in Codex windows.
7. Main-process tweaks run in the Codex main process.
8. The Settings UI shows Tweaker pages and tweak controls.

## Common Commands

| Command | What it does |
|---|---|
| `tweaker install` | Patch Codex and install the runtime. |
| `tweaker status` | Show installed version and patch state. |
| `tweaker debug` | Show app path, runtime type, paths, open state, and bridge status. |
| `tweaker repair` | Re-apply the patch after an app update or broken install. |
| `tweaker update` | Install the latest published Tweakers release; keep the managed runtime unchanged when no release exists. |
| `tweaker update-chatgpt` | Confirm official updates in ChatGPT mode, or show the required mode-switch steps in Tweakers mode. |
| `tweaker update-chatgpt-resume` | Continue a safely paused desktop-update transaction. |
| `tweaker update-chatgpt-cancel` | End a paused transaction while preserving the proved safe app state. |
| `tweaker update-chatgpt-reconcile` | Reconcile an exited updater owner without relaunching the app. |
| `tweaker update-codex` | Compatibility alias for `update-chatgpt`. |
| `tweaker doctor` | Diagnose signatures, integrity, permissions, and common failures. |
| `tweaker safe-mode` | Disable all tweaks without deleting them. |
| `tweaker safe-mode --off` | Leave safe mode. |
| `tweaker uninstall` | Remove Tweaker and restore the app when safe. |
| `tweaker uninstall --purge` | Also delete tweaks, config, logs, backups, and Tweaker user data. |

Tweak development commands:

| Command | What it does |
|---|---|
| `tweaker create-tweak ./my-tweak` | Create a new tweak folder. |
| `tweaker validate-tweak ./my-tweak` | Validate a tweak manifest and entry file. |
| `tweaker dev ./my-tweak` | Link a local tweak into Tweaker for development. |
| `tweaker dev-sync` | Validate, build, and publish one safe development snapshot. |
| `tweaker dev-sync --watch` | Watch the checkout and publish only successful validated builds. |

`dev-sync` never fetches, merges, or changes Git branches. It stages the complete
built tweak set before changing the live snapshot, pauses runtime reloads during
promotion, and emits one reload marker after the snapshot is complete. A failed
validation or build leaves the last working snapshot in place.

Source checkout commands:

```sh
npm run build
npm test
node packages/installer/dist/cli.js install
node packages/installer/dist/cli.js debug
```

## Where Files Live

Tweaker keeps almost everything outside Codex.

| Item | Location |
|---|---|
| Loader patch | Inside Codex `app.asar` |
| Runtime | `<user-data-dir>/runtime/` |
| Managed updater CLI | `<user-data-dir>/managed-runtime/current/` |
| Tweaks | `<user-data-dir>/tweaks/` |
| Tweak data | `<user-data-dir>/tweak-data/` |
| Config | `<user-data-dir>/config.json` |
| State | `<user-data-dir>/state.json` |
| Logs | `<user-data-dir>/log/` |
| Backups | `<user-data-dir>/backup/` |

Default user data paths:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Tweakers/` |
| Windows | `%APPDATA%/Tweakers/` |
| Linux | `$XDG_DATA_HOME/Tweakers/` or `~/.local/share/Tweakers/` |

On Windows Store installs, Tweaker also creates a writable managed app copy
under `%LOCALAPPDATA%/Tweakers/store-apps/`. Use the Tweaker shortcut for
that copy.

The repair watcher runs the managed updater CLI, not a development checkout.
Stable updates are downloaded from published GitHub releases into the managed
runtime. Private repositories use the current GitHub CLI or token authentication
when available. A source checkout is used only as an explicitly marked bootstrap
until its first published release is installed.

## Writing Tweaks

A tweak is a folder with a manifest and an entry file:

```text
my-tweak/
  manifest.json
  index.js
```

Minimal `manifest.json`:

```json
{
  "id": "com.you.my-tweak",
  "name": "My Tweak",
  "version": "0.1.0",
  "githubRepo": "you/my-tweak",
  "description": "Adds a Tweaker settings page.",
  "scope": "renderer",
  "main": "index.js"
}
```

Minimal `index.js`:

```js
module.exports = {
  start(api) {
    api.settings.registerPage({
      id: "main",
      title: api.manifest.name,
      render(root) {
        root.textContent = "Hello from Tweaker.";
      },
    });
  },
  stop() {},
};
```

Local dev loop:

```sh
tweaker create-tweak ./my-tweak --id com.you.my-tweak --name "My Tweak"
tweaker validate-tweak ./my-tweak
tweaker dev ./my-tweak
```

Full docs are in [Writing Tweaks](./docs/WRITING-TWEAKS.md).

## Bundled Tweak Namespace

Tweaks maintained in this repository use privacy-safe `co.tweakers.*`
identifiers and matching `tweaks/co.tweakers.*` source folders. These stable
public identifiers describe the Tweakers project, not an individual maintainer.

Third-party tweak authors should choose their own stable reverse-DNS namespace
rather than reusing `co.tweakers`.

## Owl And Native Bridge

Current macOS Codex builds use Owl: a native app shell with Chromium and an
Electron-compatible JavaScript runtime.

Tweaker 1.0.0 detects Owl and reports capability status through:

```sh
tweaker debug
```

Tweak authors should use the Tweaker SDK, not raw Owl internals:

- `api.codex.runtime.getInfo()`
- `api.codex.runtime.getCapabilities()`
- `api.codex.windows.*`
- `api.codex.cdp.*`
- `api.codex.native.*`

Native bridge support includes:

- Tweak-owned `.node` modules.
- Objective-C++/N-API shims for Swift, AppKit, Metal, and MetalKit.
- Native child panels.
- Metal-backed child-window overlays.
- Helper processes.

Start with [Native Bridge](./docs/tweaks/native-bridge.md).

## Browser Host Mode

Browser host mode opens the Codex React UI in a normal browser tab while a
hidden Codex window provides the private app bridge:

```sh
npm run browser -- --port 8765
```

The command keeps the app-owned server private on `127.0.0.1:8765`, registers
that port as a non-forcing Portless alias, and opens:

```text
https://tweakers.localhost/
```

This is useful for debugging and browser automation. It is experimental. The
in-app browser uses iframe shims in this mode, so some websites may block
embedding. Starting browser host mode may restart Codex, so finish source-side
work and request explicit confirmation before running it. Portless must be
installed globally; a conflicting live `tweakers.localhost` route fails safely
instead of being overwritten.

## Updates And Recovery

Update Tweaker:

```sh
tweaker update
```

There is currently no published GitHub release. Until one exists, `update`
reports that state and keeps the installed managed runtime unchanged.

Use **Update and Reload** in Tweakers Settings to run an official ChatGPT
desktop update on macOS. The operation is durable:

1. Tweakers records the current desktop version and safely enters the pristine,
   OpenAI-signed ChatGPT environment.
2. The native updater installs the official update while Tweakers records
   ownership and heartbeat evidence.
3. After the version and build advance, Tweakers returns to the requested
   environment, refreshes the runtime, and verifies the reopened app.

If the owner exits, startup reconciliation classifies the durable receipt
without relaunching the app. Settings offers **Resume** only when current
official-app proof says continuation is safe, and **Cancel** when it can end
the transaction without guessing. The equivalent commands are:

```sh
tweaker update-chatgpt-resume
tweaker update-chatgpt-cancel
tweaker update-chatgpt-reconcile --json
```

Updater evidence lives under the Tweakers user-data directory:

- Current receipt: `transactions/desktop-update.json`
- Receipt archive: `transactions/desktop-update/`
- Heartbeat: `transactions/desktop-update.heartbeat.json`
- Redacted event log: `log/desktop-update.log`

While a receipt is blocking, the watcher records a deferred cycle and performs
no update or repair mutation. `tweaker status`, `tweaker debug`, and
`tweaker doctor` expose the phase, safety, resumability, staleness, and evidence
paths.

Building and verifying this source checkout does not replace the installed
managed runtime. Promotion and any ChatGPT restart are a separate final action
that occurs only through the validated refresh flow with explicit user
confirmation.

Repair Tweaker:

```sh
tweaker repair --force
```

Disable tweaks temporarily:

```sh
tweaker safe-mode
```

Re-enable normal tweak loading:

```sh
tweaker safe-mode --off
```

Uninstall:

```sh
tweaker uninstall
```

Clean uninstall, including tweaks/config/logs/backups:

```sh
tweaker uninstall --purge
```

## Security

Tweaker runs local code inside your Codex desktop app. Install tweaks only from
sources you trust.

Important details:

- Tweaker does not silently update tweak files.
- Tweak update checks link to GitHub Releases for review.
- Native tweaks can run native code and need extra review.
- Native bridge paths are restricted to files inside the tweak directory.
- Tweak data APIs default to Tweaker's user data directory.

See [Security](./SECURITY.md).

## More Docs

- [Architecture](./docs/ARCHITECTURE.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Writing Tweaks](./docs/WRITING-TWEAKS.md)
- [Tweak API Reference](./docs/tweaks/api-reference.md)
- [Manifest Reference](./docs/tweaks/manifest.md)
- [Runtime And Lifecycle](./docs/tweaks/runtime-lifecycle.md)
- [UI And DOM Patterns](./docs/tweaks/ui-and-dom.md)
- [MCP Servers](./docs/tweaks/mcp.md)
- [Tweak Store And Pages Publishing](./store/README.md)
- [Owl Runtime Surface](./docs/OWL-RUNTIME.md)
- [Owl Bridge Roadmap](./docs/OWL-BRIDGE-ROADMAP.md)

## Contributors

- [Alex Naidis (@TheCrazyLex)](https://github.com/TheCrazyLex) - macOS
  permission hardening and sudo install handling.

## License

MIT.

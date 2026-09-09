# AGENTS.md — Tweaker tweak authoring guide

This file is read by AI coding agents (and humans) authoring tweaks for
Tweaker. **Follow it.**

The repository-level feature-routing, synchronization, testing, live-refresh,
and release workflow is defined by `../AGENTS.md`; follow both files.

## Prime directive

> **Match Codex's existing UI patterns unless the user specifically requests
> otherwise.** Don't invent new visual idioms. Don't hard-code colors, sizes,
> or fonts. Use Codex's Tailwind tokens (`text-token-*`, `bg-token-*`,
> `border-token-border`, `px-row-x`, `py-row-y`, `p-panel`, `h-toolbar`,
> etc.). When in doubt, mirror what the surrounding Codex screen does.

Deviate when the user explicitly requests a custom look; accept ordinary language without requiring a fixed phrase.

## Tweak shape

A tweak contains `manifest.json` plus a runtime-loadable JavaScript entry that exports `start(api)` and may export `stop()`. Bundle ESM or TypeScript before installation; do not depend on checkout-only source at runtime.

- Keep `id`, `name`, `version`, and `githubRepo` valid. Set `scope` explicitly to `renderer`, `main`, or `both`, and keep `main`, permissions, runtime requirements, and update metadata aligned with the built entry.
- Use `stop()` to undo every mutation, handler, observer, timer, view, helper, and listener created by `start()` so reload and disable remain safe.
- Read [Getting started](../docs/tweaks/getting-started.md), [Manifest reference](../docs/tweaks/manifest.md), [Runtime and lifecycle](../docs/tweaks/runtime-lifecycle.md), and [SDK/API reference](../docs/tweaks/api-reference.md) only as the active task requires.

## UI patterns

- Match the target app's current components, design tokens, and accessibility behavior; inspect live evidence when needed.
- Consult [Tweak UI examples](../docs/tweak-ui-examples.md) only for the component being changed. The examples are version-dependent reference material, not mandatory implementations or guaranteed current markup.
- Verify visual changes in the intended app/runtime before claiming visible acceptance.

## Hot reload

Do not link raw checkout files into the live app. After validation and tests,
run `npm run sync:tweaks` and one `tweaker dev-sync` snapshot; use
`tweaker dev-sync --watch` only for an explicitly requested development
session. The sync workflow publishes complete validated builds, and `start()`
may be invoked again after publication. Use `stop()` to undo every DOM
mutation, IPC handler, observer, and event listener.

## Inspecting the live DOM (Chrome DevTools Protocol)

Use CDP only when live DOM, style, screenshot, reload, or renderer evidence is relevant. It is off by default; follow [Owl runtime: Chrome DevTools Protocol](../docs/OWL-RUNTIME.md#chrome-devtools-protocol) for the current opt-in procedure.

- Identify the intended app, process, window, and page before selecting a target. Never assume the first page is the task target; pause the affected check on zero or multiple matches.
- Finish requested implementation and source checks before an authorized reload or promotion. Enabling CDP does not grant permission to restart an app or bypass a tool-level access restriction.
- Verify updated behavior in the intended runtime before claiming visible acceptance.

## Don'ts

- ❌ Don't import React directly — Codex's React isn't a stable dependency.
  Use `api.react.*` or vanilla DOM.
- ❌ Don't use Node `require()` — the renderer is sandboxed. Bundle deps in.
- ❌ Don't hard-code hex colors. Use Codex tokens (`text-token-*`).
- ❌ Don't poll the DOM — use `api.react.waitForElement`.
- ❌ Don't ship your own toggle/button styling — use the current app patterns and the selected UI reference.

## Reference

- SDK types and examples: [SDK/API reference](../docs/tweaks/api-reference.md) and `@therealityreport/tweakers-sdk`.
- Codex's Settings markup samples: `/tmp/codex_panels/*.txt` (when the
  runtime is in dev/dump mode).

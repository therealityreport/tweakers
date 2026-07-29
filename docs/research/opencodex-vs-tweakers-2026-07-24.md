# OpenCodex vs. Tweakers

Date: 2026-07-24

## Audit record

- **Task name:** `opencodex_source_audit`
- **Model:** `gpt-5.6-sol`
- **Reasoning effort:** `high`
- **Purpose:** Inspect current first-party OpenCodex source and compare its architecture and scope with the live Tweakers repository.
- **Status:** Complete
- **Result:** OpenCodex contains neither a Codex/ChatGPT desktop clone nor an `app.asar` patcher like Tweakers. It is a standalone local model-routing proxy, configuration/catalog injector, CLI/service, and separate web management dashboard. Tweakers is an in-process extension system that patches the installed desktop app so an external tweak runtime loads before the official app entry point.

## Bottom line

**There is no clone of the Codex or ChatGPT desktop app in `lidge-jun/opencodex`.**

OpenCodex is best classified as a **companion proxy plus config injector**:

```text
official Codex CLI/App/SDK
        |
        | Responses API, redirected by config.toml
        v
OpenCodex local Bun proxy
        |
        v
OpenAI, Anthropic, Google, OpenRouter, local models, etc.
```

Its maintainer architecture document is unusually explicit: OpenCodex is a local Responses-compatible proxy, “does not patch Codex binaries,” and changes Codex state by writing provider/catalog configuration before serving `/v1/responses` ([OpenCodex product boundary](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/structure/00_overview.md#L20-L38)).

Tweakers is best classified as an **installed-app patcher plus in-process extension runtime**:

```text
official Codex/ChatGPT desktop app
        |
        | patched app.asar entry point
        v
small Tweakers loader
        |
        +--> external Tweakers runtime
        +--> renderer/main/native tweaks
        |
        v
official app main entry
```

Tweakers explicitly patches the local app, while keeping most runtime data outside it ([Tweakers README](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/README.md#L12-L28)). Its loader is copied into `app.asar`, loads the Tweakers runtime before the original app entry, and then falls through to the original main module ([loader source](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/loader/loader.cjs#L1-L15), [runtime load and original-main handoff](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/loader/loader.cjs#L73-L105)).

## Is OpenCodex’s GUI a Codex clone?

No. The repository does contain a substantial GUI, but it is a **React/Vite administration dashboard**, not a chat client:

- Its pages are Dashboard, Providers, Models, Combos, Subagents, Logs, Usage, Storage, Codex Auth, API Keys, Claude Code, and Startup. There is no thread list, chat composer, transcript view, workspace editor, or desktop shell in its application routes ([OpenCodex `App.tsx`](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/gui/src/App.tsx#L1-L25), [navigation](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/gui/src/App.tsx#L81-L92)).
- The GUI package depends on React and Vite, not Electron or another desktop shell ([GUI package](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/gui/package.json#L1-L35)).
- Its compiled static files are served by the same Bun proxy process ([GUI server](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/src/server/gui-static.ts#L19-L27), [static response path](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/src/server/gui-static.ts#L57-L80)). The maintainer source of truth calls it a local control surface for proxy configuration and catalog state ([GUI architecture](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/structure/05_gui-and-management-api.md#L3-L28), [UX boundary](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/structure/05_gui-and-management-api.md#L61-L64)).
- The published npm package contains `bin`, `src`, `gui/dist`, and image/documentation assets. Its runtime dependencies are protobuf, MCP SDK, Bun, and Zod; there is no Electron runtime, Electron builder, ASAR tooling, or desktop application bundle ([root package manifest](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/package.json#L1-L64)).

A repository-wide source scan at audited commit `357acee62458684bc027e9d524e95bd066df3a43` found no `app.asar`, `@electron`, `electron-builder`, `BrowserWindow`, `Codex.app`, or `ChatGPT.app` references in OpenCodex’s root package, runtime, GUI, launchers, scripts, architecture documents, or README.

## Architecture comparison

| Dimension | OpenCodex | Tweakers |
|---|---|---|
| Primary job | Route Codex/Claude model requests to many providers; manage models, credentials, quotas, and account pools | Add UI, settings, process hooks, OS integrations, and tweak-provided MCPs to Codex/ChatGPT Desktop |
| Uses official Codex UI? | Yes. The official client remains the chat/workspace UI | Yes. The official installed desktop app remains the host UI |
| Separate UI | Yes: browser dashboard at the proxy port, for management only | Optional development/browser surfaces, but the primary settings and tweak UI run inside the official app |
| Main hook point | Network/provider layer: `config.toml`, model catalog, local `/v1/responses` endpoint | Desktop bootstrap layer: patched `app.asar` entry point, Electron/Owl main process, injected preload |
| Modifies app bundle | No | Yes |
| Modifies Codex state | Yes: provider/base URL, model catalog/cache, optional profile/history migration; optional CLI autostart shim | Yes: app package/integrity/signing plus user-data runtime; some tweaks/runtime services also reconcile Codex config such as MCPs/features |
| Runtime location | Standalone Bun process/service | Loader inside `app.asar`; main runtime and tweaks primarily in Tweakers user data |
| Extension model | Provider adapters and proxy/server modules | Manifested renderer/main/both-scope tweaks with declared permissions and a public SDK |
| Client coverage | Codex CLI/TUI/App/SDK and Claude Code | Codex/ChatGPT Desktop host runtime |
| Failure boundary | Proxy/config/service availability affects model routing; restore removes routed config/catalog | Injected code runs in or alongside the desktop process; install/repair maintains backups and app validity |
| A cloned OpenAI app? | No | No |

## What OpenCodex actually changes

OpenCodex’s injection code:

1. Reads the active Codex config.
2. Preserves an externally managed provider instead of overwriting it.
3. Removes stale OpenCodex-owned provider/catalog state.
4. Adds a model catalog path.
5. On the normal loopback path, writes a root `openai_base_url` pointing at the local proxy; on a non-loopback path, writes an `opencodex` provider table.
6. Atomically writes the updated config and an optional profile.

That behavior is visible directly in [`injectCodexConfig`](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/src/codex/inject.ts#L505-L571). Its restore path removes OpenCodex-owned routing and catalog entries so native Codex works again ([restore source](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/src/codex/inject.ts#L648-L712)).

This is mutation, but it is **configuration injection**, not executable/app-bundle patching. OpenCodex can also install an optional CLI launcher shim to auto-start the proxy; the runtime architecture documents that separately from its desktop-app integration ([runtime entrypoints](https://github.com/lidge-jun/opencodex/blob/357acee62458684bc027e9d524e95bd066df3a43/structure/01_runtime.md#L3-L18)).

## What Tweakers actually changes

Tweakers’ installer:

1. Backs up the installed app’s ASAR and related metadata.
2. Stages the external runtime.
3. Rewrites `app.asar` so its package entry points to `tweaker-loader.cjs`.
4. Updates ASAR integrity metadata and handles app signing.
5. Keeps a watcher/managed repair path for official app updates.

The ASAR helper extracts, mutates, repacks, and replaces the official archive ([Tweakers ASAR patcher](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/installer/src/asar.ts#L48-L101)). The installer’s actual entry rewrite records the original main module and changes `package.json#main` to `tweaker-loader.cjs` ([Tweakers loader injection](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/installer/src/commands/install.ts#L1429-L1485)). The in-app runtime then hooks Electron’s `BrowserWindow`, adds a preload, and loads main-process and renderer tweaks ([runtime bootstrap](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/runtime/src/main.ts#L1-L20)).

That is a materially deeper hook than OpenCodex’s: Tweakers executes trusted local extension code inside the app’s process/UI boundary, while OpenCodex sits primarily on the model-transport boundary.

## Relationship between the projects

They are **adjacent and potentially complementary**, not equivalent implementations:

- OpenCodex changes the “brain and route”: which model/provider/account receives a Codex request.
- Tweakers changes the “shell and behavior”: what the desktop app UI and processes can do.

In principle, someone could want both. However, coexistence should not be assumed without a focused test because both projects can write Codex state:

- OpenCodex owns provider/base-URL/catalog keys and may migrate provider-tagged history.
- Tweakers can reconcile tweak-provided MCP entries and mutate selected Codex features from its in-app runtime ([SDK MCP contract](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/sdk/src/index.ts#L40-L62)).

Their primary hook points do not inherently collide—network routing versus desktop bootstrap—but config-preservation, start/stop ordering, update/repair behavior, and rollback should be verified in a disposable profile before treating the combination as supported.

## Security and operational distinction

The trust boundaries differ:

- OpenCodex is on the model data path and manages provider credentials/account routing. It can observe and transform model requests and responses by design.
- Tweakers runs enabled tweak code within privileged desktop renderer/main/native surfaces. Its manifest model includes filesystem, network, IPC, Codex runtime/window/view/CDP, native module/helper/view, screen capture, accessibility, and global-shortcut permissions ([Tweakers permission model](https://github.com/therealityreport/tweakers/blob/bf391cd10a455d7926ffdf41da82e5d63fcfb972/packages/sdk/src/index.ts#L73-L109)).

Neither risk model is “a clone”; each extends the official client from a different side.

## Audited revisions and local-state caveat

- **OpenCodex:** `main` at `357acee62458684bc027e9d524e95bd066df3a43`, package version `2.7.39`, commit timestamp `2026-07-24T15:45:17+09:00`.
- **Tweakers:** local `main` at `bf391cd10a455d7926ffdf41da82e5d63fcfb972`, one commit behind `origin/main`, with substantial unrelated modified and untracked work already present.
- The Tweakers files that directly establish the core patch architecture—`README.md`, `packages/loader/loader.cjs`, and `packages/installer/src/asar.ts`—were unmodified in the live worktree at audit time. Current modified implementation files were inspected read-only; their citations above use the pinned committed revision so links remain reproducible. No existing work was changed.
- No app restart, live sync, install, repair, configuration change, build, or test was performed. This was a read-only source audit except for this note.

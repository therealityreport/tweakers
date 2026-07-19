# Tweakers Architecture Map

- Source commit: `401100a627dd3a6754addfc51f79d9ad170466fa`
- Validated against: live working tree on 2026-07-16
- Drift rule: revalidate a section whenever any source paths named in that section change.

## Entry points

- Root CLI shims: `bin/tweaker.js`, `install.sh`, `install.ps1`, `update.sh`, `update.ps1`.
- Installer CLI: `packages/installer/src/cli.ts` registers install, uninstall, repair, update, mode, status, doctor, debug, browser, tweak authoring, and development-sync commands.
- Loader: `packages/loader/loader.cjs` starts the user-data runtime from the patched app bundle.
- Main runtime: `packages/runtime/src/main.ts` integrates Electron/Owl services, IPC, tweak discovery, and lifecycle.
- Renderer preload: `packages/runtime/src/preload/index.ts` initializes React hooks, settings injection, tweak hosting, and the manager UI.
- Tweak entry points: `tweaks/*/index.js` or the safe manifest-selected entry.

## Package or component boundaries

- `packages/sdk` defines shared public contracts and validation helpers.
- `packages/runtime` owns in-app behavior and may depend on the SDK.
- `packages/installer` owns host-side lifecycle, filesystem transactions, runtime publication, watcher control, compatibility migration, and CLI UX.
- `packages/loader` remains minimal and delegates to the managed runtime.
- `packages/native-host` and `packages/switcher` are macOS native helpers built and copied by scripted interfaces.
- `tweaks/` owns canonical tweak behavior; `store/index.json` and `packages/installer/assets/runtime/tweaks` are synchronized derivatives.

Allowed dependency direction is canonical source or public contract toward generated/package output, never generated output back toward source authority.

## Major request, event, and data flows

1. Installer validates an app/candidate, stages loader and runtime assets, records state, then promotes atomically or restores the prior state.
2. The patched loader starts the managed runtime from the user-data root.
3. Main runtime discovers enabled tweaks, binds main-process capabilities, and exposes prefixed IPC.
4. Preload initializes renderer services, injects settings surfaces, and starts renderer-scoped tweak lifecycle.
5. Tweak configuration and data flow through namespaced storage and runtime APIs.
6. `sync:tweaks` validates canonical manifests, updates the catalog, and regenerates packaged tweak output deterministically.
7. Managed watcher/update flows evaluate a candidate before any app cutover, with rollback on failed promotion.

Primary sources: `docs/ARCHITECTURE.md`, `packages/installer/src/commands/install.ts`, `packages/installer/src/dev-sync.ts`, `packages/runtime/src/main.ts`, `packages/runtime/src/preload/index.ts`, and `scripts/sync-tweaks.mjs`.

## Persistent stores and migrations

- Platform data roots are resolved by `packages/installer/src/paths.ts`.
- Installer state is defined in `packages/installer/src/state.ts` and includes app identity, hashes, version/channel, signing, watcher, source root, and mode.
- Transactions and candidates use dedicated roots/state for rollback-safe promotion.
- Runtime/tweak configuration and data are owned by `packages/runtime/src/storage.ts`, `packages/runtime/src/renderer-storage.ts`, and per-tweak namespaces.
- Legacy root, CLI alias, and tweak-namespace compatibility are handled by installer migration/compatibility modules.

## External APIs, queues, infrastructure, and deployments

- GitHub APIs and releases provide stable update/source metadata.
- GitHub Pages hosts the tweak-store registry described in `store/README.md`.
- GitHub Actions runs Node 20/22 CI, generated-state checks, history/privacy checks, and tagged release publication.
- macOS launchd owns managed watcher repair; Windows and Linux use platform-specific roots and process/service behavior.
- There is no queue or database service in the repository architecture.
- A pushed semantic-version tag is publication approval; this audit does not create or push tags.

## Ownership sources

No `CODEOWNERS`, component ownership metadata, or ADR inventory exists. Package boundaries are the strongest current ownership signal; recent contributors may be consulted only to suggest reviewers.

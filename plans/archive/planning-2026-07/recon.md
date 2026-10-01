# Codex Improve Recon

- Source commit: `401100a627dd3a6754addfc51f79d9ad170466fa`
- Audited state: live `main` working tree on 2026-07-16
- Baseline status: 233 modified, renamed, deleted, or untracked paths before these audit artifacts were created
- Repository: `therealityreport/tweakers` (public)
- Audit mode: `deep`, large budget, current working tree

## Current-state warning

The working tree contains a repository-wide privacy and product-name migration. Current files, not `HEAD`, are the audit truth. The audit must preserve all existing changes and must not reset, stash, commit, push, tag, publish, restart the app, or promote a runtime.

## Applicable instructions

- `AGENTS.md`: repository routing, generated-state, test, sync, release, and live-app safety rules.
- `tweaks/AGENTS.md`: tweak manifest, UI, lifecycle, hot-sync, and CDP conventions.
- Canonical tweak source is `tweaks/`.
- Synchronized catalog data is `store/index.json`.
- Generated packaged runtime is `packages/installer/assets/runtime/` and must not be hand-edited.

## Repository and packages

The root npm workspace includes `packages/*` and requires Node.js 20 or newer.

| Package or area | Primary role | Entry/build evidence |
|---|---|---|
| `packages/installer` | CLI, install/repair/update/mode transactions, managed runtime | `src/cli.ts`; TypeScript build plus asset copy |
| `packages/runtime` | Electron/Owl main runtime, preload, tweak lifecycle, storage, watcher integration | `src/main.ts`, `src/preload/index.ts`; TypeScript plus renderer bundle and native host copy |
| `packages/sdk` | Public tweak types and helpers | `src/index.ts`; TypeScript build |
| `packages/loader` | Small `app.asar` bootstrap loader | `loader.cjs` |
| `packages/native-host` | macOS AppKit/Metal bridge | `src/tweaker_native_host.mm`; scripted native build |
| `packages/switcher` | macOS menu-bar mode switcher | `src/tweakers_switcher.m`; scripted native build |
| `tweaks` | Eleven canonical bundled tweaks and their behavior tests | Per-tweak `manifest.json`, package, entry, and tests |
| `scripts` / `store` | Catalog sync, public-history checks, release verification, registry data | Root npm scripts and GitHub workflows |

## Verified commands

From the current root `package.json` and CI/release workflows:

- Install: `npm ci`
- Build: `npm run build`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Dependency audit: `npm run audit`
- Catalog validation: `npm run check:tweak-catalog`
- Deterministic tweak sync check: `npm run sync:tweaks -- --check`
- Public-history check: `npm run check:public-history`
- Release validation: `node scripts/verify-release.mjs`

Runtime-changing commands such as install, repair, mode switching, `dev-sync`, refresh, and release publication are outside this audit.

## Intent and conventions

- `docs/ARCHITECTURE.md` describes loader boot, user-data runtime/tweak/state roots, transactional mode changes, watcher repair, and stable update flow.
- `store/README.md` describes the GitHub Pages registry and approved-commit pinning.
- `scripts/sync-tweaks.mjs` is the only supported catalog and packaged-tweak regeneration interface.
- Candidate installs are expected to validate in disposable locations and promote or roll back atomically.
- App restart or live promotion is a separate, explicitly confirmed final action; neither is part of this audit.

## Ownership

No `CODEOWNERS`, package ownership metadata, or ADR files were found. Suggested review ownership must therefore be inferred from the affected package and recent path contributors without exposing private identities.

## Audit boundaries

Prioritize:

- `packages/installer/src` and `packages/installer/test`
- `packages/runtime/src` and `packages/runtime/test`
- `scripts`, `.github/workflows`, and release/install shell and PowerShell entry points
- Canonical `tweaks/` source and tests
- `store/index.json` and synchronization/release invariants
- `packages/loader`, `packages/sdk`, `packages/native-host`, and `packages/switcher`

Inspect only for generated drift:

- `packages/installer/assets/runtime`
- packaged switcher and native-host binaries

Skip as source:

- `node_modules`, `dist`, `build`, `coverage`, `_workspace`
- `.git`, `.full-review`, `.plan-work`, `${CLAUDE_PLUGIN_ROOT}`
- screenshots and other local review artifacts

## External and persistent systems

- User data lives under the platform-specific Tweakers application-data root, with compatibility handling for the legacy root.
- Persistent state includes config, installer state, self-update state, transaction state, backups, logs, tweak data, and runtime snapshots.
- External reads include GitHub APIs/releases and the GitHub Pages tweak registry.
- Live app/runtime state may be inspected read-only; no mutation, restart, or promotion is authorized.

## Verification baseline

All checks below ran against the live dirty working tree without regenerating tracked assets:

- `npm run lint`: passed with 0 errors and 102 existing warnings.
- `npm run typecheck`: passed.
- `npm run sync:tweaks -- --check`: passed for 11 tweaks.
- `npm run check:tweak-catalog`: passed.
- `npm run check:public-history`: passed.
- `scripts/check-no-bnnett.sh`: passed.
- `git diff --check`: passed.
- Package test bodies: 559 passed, 0 failed.
- Script tests: 11 passed, 0 failed.
- Canonical tweak tests: 153 passed, 0 failed.
- `npm audit`: found one reachable moderate `tar` advisory and one low `esbuild` advisory whose affected development-server path is not used here.

The root `npm test` wrapper and `npm run build` were not invoked because both build native/generated artifacts outside the selected plan directory. Their underlying package, script, and tweak test bodies were run directly.

## Live read-only boundary

- The canonical source, generated assets, and managed CLI are newer than the installed runtime/catalog currently inside the app.
- A valid candidate is held in `pendingPromotion` because the app is running. Source changes are therefore not deployed.
- No status, doctor, repair, install, sync, update, mode-switch, restart, or promotion command ran during this audit.
- Sensitive config values, raw logs, credentials, and private signing identities were not read or recorded.

Security-sensitive finding details are intentionally withheld from this public repository until the user selects an ignored plan location or explicitly authorizes public plan text.

# Changelog

All notable changes to tweaker are documented here.

This project uses semver for the installer, runtime, SDK, and published CLI package. Tweak authors should also use semver release tags so the manager can compare installed and available versions.

## Unreleased

### Added

- Added User Questions 0.5.0 with rich option details and tradeoffs, explicit
  Skip/Other and multi-select answers, task-bound resumable drafts, acknowledged
  enhanced/generic delivery, and retryable `display_failed` recovery.

### Changed

- User Questions answers now state preference-not-rule semantics and conflict
  guidance. Its policy compatibility flow is explicit Preview/Apply/Restore,
  never restarts Codex automatically, and keeps question, answer, task, token,
  and draft content out of diagnostic logs.

- Rebranded all former plus-plus product, CLI, runtime, IPC, storage, native
  host, documentation, and generated-asset identifiers as `Tweaker`,
  `tweaker`, or `TWEAKER` according to context.
- Replaced the requested maintainer and organization display labels with
  `hulibrands` throughout manifests, catalog metadata, and documentation.
- Replaced maintainer-specific bundled tweak identifiers and source folders
  with the project-owned `co.tweakers.*` namespace across source,
  documentation, tests, catalog metadata, and packaged runtime assets.
- Replaced maintainer-specific display names and legacy donor labels with the
  project name in public repository content.

## 1.0.0

### Added

- Added manifest-driven bundled tweak synchronization and repository-level feature-routing instructions.
- Added managed local ChatGPT refresh status, a validated quit/promote/reopen workflow, and a conditional title-bar refresh control.
- Added approval-gated stable release automation for semantic-version tags.

### Fixed

- Fixed User Questions multi-process discovery and made each MCP bridge exit after its response or client disconnects, preventing stale processes and descriptors.

## 0.1.7

Release notes: [docs/releases/0.1.7.md](docs/releases/0.1.7.md)

### Changed

- Updated Settings sidebar injection for the current Codex Desktop Settings UI by scoring known Settings navigation labels instead of depending on the old `Back to app` label.
- Added a solid blue sidebar update pill that opens the Tweaker GitHub Releases page directly.
- Added a Tweak Store sidebar badge showing how many installed tweaks have newer approved versions available.
- Improved self-update command execution diagnostics by capturing stdout/stderr tails when dependency install, build, or repair commands fail.
- Made local macOS signing identity export/import use a generated PKCS#12 password and redact that secret from command failures.
- Documented the safe-mode exit command in CLI help and kept blank `tweaker` invocations mapped to help output.

### Fixed

- Fixed Windows installs against Codex builds whose main-process window-services factory has reordered or quoted object properties.
- Fixed Windows uninstall cleanup so Tweaker removes Explorer context-menu entries it created.
- Fixed uninstall cleanup on installs that were previously run with elevated permissions by repairing ownership before removing runtime files.
- Kept macOS signing ad-hoc by default and added `--local` as an opt-in stable local signing identity for install and repair.
- Added detailed window-services hook diagnostics that report scanned candidate bundles, matched fingerprints, parser errors, and nearby source snippets when Codex changes its internals again.
- Broadened recovered Vite main-bundle scanning to include `main.js` and `main.*.js` layouts.
- Retried and best-effort cleaned temporary unpacked asar directories after patching.
- Removed Codex startup/composer performance patching from the installer.

## 0.1.5

Release notes: [docs/releases/0.1.5.md](docs/releases/0.1.5.md)

### Added

- Added the reviewed Tweak Store with pinned approved commits.
- Added Tweak Store platform compatibility labels.
- Added store card icons and version badges showing installed and latest approved versions.

### Changed

- Tweak Store approval now relies on store icons instead of screenshot submissions.
- Updated Bennett's UI Improvements in the store registry to `0.1.5`.
- Changed macOS repair guidance to direct users to `tweaker repair` from Terminal when the background watcher is blocked.

### Fixed

- Made the auto-repair watcher run Tweaker self-update and app repair as separate steps, then open a Terminal repair fallback when macOS blocks background app modification.

## 0.1.4

Release notes: [docs/releases/0.1.4.md](docs/releases/0.1.4.md)

### Added

- Added Microsoft Store / WindowsApps Codex detection and patch support.
- Added Bun global install support with a first-run bootstrap command.
- Added dedicated macOS App Management permission alerts with an Open Settings action.

### Changed

- Improved auto-repair watcher retries after Codex updates and reduced repair checks to a 5-minute interval.
- Kept Tweaker release checks throttled to hourly while allowing app repair checks to run more often.
- Made Codex.app settle detection depend only on patch-critical inputs.
- Made blank `tweaker` invocations show help instead of a command error.

### Fixed

- Fixed Windows install dependency execution by using `npm.cmd`.
- Fixed Windows Store installs by mirroring locked app resources into a writable managed location.
- Fixed Windows renderer tweak settings.
- Fixed Homebrew command wrappers, executable permissions, reinstall conflicts, and formula tests after self-update.
- Fixed macOS App Management alert text and guidance.

## 0.1.3

Release notes: [docs/releases/0.1.3.md](docs/releases/0.1.3.md)

### Added

- Added hourly Tweaker self-update checks through the watcher.
- Added automatic Tweaker runtime download/build/repair when a newer Tweaker release is available.
- Added restart prompts when Codex is open and needs to reload a freshly updated Tweaker runtime.
- Added visible Codex update mode status while the official Codex updater is running.
- Added Codex beta app metadata support for watcher health checks and repair state.
- Added Markdown rendering for latest Tweaker release notes in Settings.
- Added GitHub issue links to unexpected CLI failure output.

### Changed

- Made Codex update repair alerts faster, clearer, and Codex-branded on macOS.
- Capped Tweaker runtime, loader, and watcher logs at 10 MB.
- Removed bundled example tweak sources from the Tweaker release package. Default tweaks now come from their own release channels.
- Updated the Tweaker Config subtitle to show the installed Tweaker version.
- Fixed Homebrew install instructions.

### Fixed

- Fixed negated installer flags such as `--no-default-tweaks`.
- Fixed the repair flow to avoid unnecessary re-signing when the patch is already intact.
- Fixed Codex beta metadata detection so beta installs report watcher health correctly.

## 0.1.2

Release notes: [docs/releases/0.1.2.md](docs/releases/0.1.2.md)

### Fixed

- Fixed enabling a previously disabled `scope: "main"` or `scope: "both"` tweak from Settings so the main-process half starts immediately instead of requiring Force Reload or an app restart.
- Fixed disabling a main-process tweak from Settings so loaded main-side tweak state is stopped before renderer hosts reload.
- Fixed macOS update self-repair after Codex changed its minified window-services startup shape in version `26.429.20946`, and moved that patcher to a more resilient fingerprint-based hook.
- Fixed the launchd watcher writing unusable TypeScript source paths such as `src/cli.js`, and refreshed it with modern `launchctl bootstrap` registration.

### Added

- Added `create-tweak`, `dev`, `validate-tweak`, and `safe-mode` installer commands for local tweak development and recovery.
- Added manifest validation helpers, permissions metadata, and optional tweak-provided MCP server declarations to the SDK.
- Added automatic Codex MCP config sync for enabled tweaks with `manifest.mcp`.
- Added an Auto-Repair Watcher health card to the Tweaker Config page.
- Added regression tests for tweak enable/disable reload behavior, tweak discovery, and tweak storage.
- Added CI coverage for tests and builds.
- Added macOS system alerts when update repair fails, a GitHub issue report action, and a post-update restart prompt when Codex is already open without Tweaker loaded.

## 0.1.1

### Added

- Added a native Codex window bridge for main-scope tweaks.
- Tweaks can now create Codex-registered chat windows for routes such as `/local/<conversation-id>`, which enables split-screen chat tweaks to render the real Codex chat UI instead of transcript clones or unregistered BrowserViews.
- The installer now exposes Codex's internal window services to the Tweaker runtime during asar patching.
- Added `tweaker` as the preferred CLI command, while keeping `tweakers`,
  `codexplusplus`, and `codex-plusplus` as compatibility aliases.
- Added `tweaker update` / `tweaker self-update` to refresh Tweaker from GitHub source, rebuild it, and run `repair`.
- Added `tweaker update-codex` for macOS Sparkle updates. It restores a signed Codex.app before the official updater runs, then lets the watcher reapply Tweaker after Codex restarts.
- Added a native Windows PowerShell bootstrap script, `install.ps1`.
- Added `update.sh` and `update.ps1` helper scripts for users whose shell does not yet have `tweaker` on PATH.
- Added Homebrew formula scaffolding and Bun/global-install metadata so `tweaker` can be installed as a normal command.

### Fixed

- Fixed the GitHub source installer failing on clean machines when `npm ci` rejects an out-of-sync workspace lockfile.
- The source installer now installs dependencies with `npm ci --workspaces --include-workspace-root --ignore-scripts`.
- If the downloaded lockfile is stale, the installer now removes only that temporary lockfile and falls back to `npm install --workspaces --include-workspace-root --ignore-scripts`.
- Fixed fallback installs missing workspace dependencies such as `electron`, `chokidar`, or `@therealityreport/tweakers-sdk`.
- Fixed Windows install preflight using the macOS-only `Contents` bundle path.
- Expanded Windows app discovery to cover common Squirrel and Electron install locations.
- Hardened Windows scheduled-task repair command quoting.
- Improved installer prerequisite and failure messages with human-readable `[!]` errors.

### Changed

- Source bootstrap installs local CLI shims into a writable PATH directory when possible, so users can run `tweaker repair`, `tweaker status`, and `tweaker update` after the first install.
- macOS installs now preserve a signed Codex.app backup when available, which supports safer official Codex updates.
- Settings injection now hides Tweaker settings surfaces more cleanly when leaving settings.

## 0.1.0

- Initial alpha release.
- One-command GitHub installer via `install.sh`; no npm package or `npx` dependency.
- Runtime-loaded local tweaks with Settings integration.
- App-update repair watcher for re-patching Codex after app updates, using the locally installed CLI.
- Tweaker release checks through GitHub Releases.
- Default tweak seeding from Bennett UI Improvements and Custom Keyboard Shortcuts GitHub release channels, with `--no-default-tweaks`.
- Review-only tweak update checks via required `githubRepo` manifest metadata.
- In-app tweak manager with enable/disable, config, release links, and maintenance actions.

# Architecture

## Source packages and ownership

The root workspace has seven source packages. `tweaks/` is canonical tweak
source, `store/index.json` is synchronized catalog data, and
`packages/installer/assets/runtime/` is generated output.

| Package | Responsibility |
| --- | --- |
| `packages/installer` | CLI adapters, environment and desktop transactions, candidate validation, promotion, recovery evidence, and the sealed manager service. |
| `packages/runtime` | Main-process bootstrap, tweak discovery and lifecycle, Accounts transport, store transactions, and renderer preload/Settings integration. |
| `packages/sdk` | Shared public tweak APIs, manifests, contracts, and common primitives. |
| `packages/loader` | The small injected `loader.cjs` bootstrap in the desktop bundle. |
| `packages/native-host` | macOS native modules, app and manager launchers, and directory/process coordination helpers. |
| `packages/mcp-lifecycle` | Canonical MCP lifecycle assets, templates, and source/package checks. |
| `packages/switcher` | Legacy standalone mode switcher kept for compatibility and migration tests. |

The separate **Menu Bar** application owns the current menu-bar host, manager
discovery, and host trust records. Tweakers publishes its sealed manager
descriptor through `packages/installer/src/manager-descriptor.ts` under
`~/Library/Application Support/Menu Bar/manager-descriptors/`. That publisher
does not own or change Menu Bar's trust decision. `packages/switcher` is not
the current manager host.

## Receipt and process observation boundaries

`packages/installer/src/desktop-update-receipt.ts` owns the schema-v1 desktop
receipt types, validator, historical selection normalization, and reader.
`desktop-update-transaction.ts` keeps compatibility exports and owns the
transaction and durable writer. `lifecycle-lock.ts` reads desktop receipts from
the leaf and environment receipts from the existing
`manager-environment-action.ts` leaf. Reading lifecycle gates does not import
either transaction coordinator.

`packages/installer/src/process-observation.ts` exposes
`observeExactTargetProcesses(target)`. It reads the process census and matches
commands that start under the resolved app path. Census failure rejects the
observation. This service does not stop processes, wait for exit, or change
lifecycle state. Promotion and recovery callers own those decisions.

## Recoverable store replacement

`packages/runtime/src/store-transaction.ts` owns filesystem publication and
reconciliation for store installs. It stages a replacement on the same
filesystem, hashes the old and new trees, records durable intent, and calls
the supplied lifecycle ports before publication and activation. Policy for
catalog metadata, permissions, and approval remains with its caller.

The journal and backup remain under the sibling
`.<tweaks-directory-name>-store-transactions/` directory. Failed activation
requires proof that the replacement stopped before prior files can return.
An uncertain lifecycle outcome keeps the journal and lock, and blocks
admission. Fresh startup reconciliation restores only supported, verified
filesystem states. Malformed or unattributable evidence blocks discovery;
it does not silently delete the transaction.

## Exact manager recovery evidence

`packages/installer/src/manager-recovery-evidence.ts` binds recovery to one
manager operation and promotion journal. The immutable binding records the
operation and promotion IDs, exact user root and app target, app generation
hash, runtime fingerprint, active receipt hash, journal identity hash, receipt
references, and dependency paths. The journal identity hash excludes its
changing phase; the rest of its identity remains bound.

A terminal operation phase alone does not prove recovery. Verification compares
the exact bound journal and filesystem generations. A committed promotion also
requires its matching schema-v3 runtime-ready receipt with main, preload, and
Settings initialization. A recovered promotion requires the prior generations
or proven absence and no readiness receipt for the abandoned operation.
The operation-local binding remains the authority for reconciliation;
unrelated newer receipts cannot release an older operation's hold.

```
┌────────────────────────────────────────────────────────────────────────┐
│                                Codex.app                                │
│  Contents/Resources/                                                    │
│  ├─ app.asar                                                            │
│  │   ├─ package.json   (main: tweaker-loader.cjs)  ◄─ patched   │
│  │   ├─ tweaker-loader.cjs                          ◄─ injected │
│  │   └─ <original Codex code …>                                         │
│  ├─ Frameworks/Codex Framework.framework/.../Codex Framework (Owl)      │
│  │      or Electron Framework.framework on older builds                 │
│  │   └─ optional Electron fuse patch on older Electron-style builds     │
│  └─ Info.plist                                                          │
│      └─ ElectronAsarIntegrity["Resources/app.asar"] = <new hash>  ◄─   │
└────────────────────────────────────────────────────────────────────────┘
                                 │
                  loader.cjs requires runtime/main.js
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│  <Tweakers user root>/                                                  │
│  ├─ runtime/                                                            │
│  │   ├─ main.js          — main process; hooks BrowserWindow            │
│  │   ├─ preload.js       — bundled preload (renderer side)              │
│  │   └─ tweak-discovery.js                                              │
│  ├─ tweaks/                                                             │
│  │   └─ <tweak-id>/                                                     │
│  │       ├─ manifest.json                                               │
│  │       └─ index.js                                                    │
│  ├─ tweak-data/<tweak-id>/   — per-tweak filesystem sandbox             │
│  ├─ backup/                  — original asar / plist / framework binary │
│  ├─ log/                                                                │
│  ├─ state.json               — installer records                        │
│  └─ config.json              — user preferences (enable flags etc.)     │
└────────────────────────────────────────────────────────────────────────┘
```

## Tweak update checks

Tweak updates are deliberately advisory. `manifest.json` must include `githubRepo` in `owner/repo` form. The main process checks GitHub Releases at most once per day per tweak and caches the result in `<user-data-dir>/state.json`.

The renderer only receives cached metadata (`latestVersion`, `releaseUrl`, `updateAvailable`) and can open the GitHub release for review. There is no automatic download, install, or replacement path in the runtime.

## Boot sequence

1. User launches Codex.app.
2. macOS verifies the re-signed app. A promotable candidate uses Tweakers'
   stable local signing identity.
3. The desktop runtime reads `Info.plist` → checks asar integrity hash.
   - The hash now matches the patched asar, so this passes.
   - On older Electron-style bundles, the `EnableEmbeddedAsarIntegrityValidation`
     fuse may also be off as a belt-and-suspenders measure.
4. Electron loads the asar's `package.json#main`, which now points to `tweaker-loader.cjs`.
5. The loader (in the asar):
   - Reads `__tweaker.userRoot` from package.json.
   - Sets `TWEAKER_USER_ROOT` and `TWEAKER_RUNTIME` envs.
   - `require()`s `<userRoot>/runtime/main.js`.
   - `require()`s the original `__tweaker.originalMain` (Codex's real entry).
6. Runtime's `main.js`:
   - Registers our preload via Electron-compatible session APIs (additive —
     Codex's own preload still runs).
   - Discovers tweaks under `<userRoot>/tweaks`.
   - Starts main-scoped tweaks immediately.
   - Sets up IPC handlers.
7. Codex creates its `BrowserWindow`. Both Codex's preload AND our preload run in each renderer.
8. Our preload:
   - Installs a React DevTools-shaped global hook (so we can fiber-walk later).
   - Asks main for the tweak list and user paths over IPC.
   - For each renderer-scoped tweak, requests its source through IPC, evaluates
     it with `new Function` in the preload, and calls `start(api)`.
   - Starts the Settings injector (MutationObserver waiting for the Settings dialog).
   - Mounts the built-in Tweak Manager section.
9. When the user opens Settings, the preload finds the Settings sidebar, inserts
   a Tweakers navigation group, and mounts registered pages in the Settings
   content area.

## Why these choices

### Why patch asar entry instead of always using the fuse?

The fuse alone would let us swap in a new asar, but Codex's asar is large (~115 MB) — pointlessly recopying it every install/update is slow. Patching the entry adds ~1 KB. We do flip the fuse anyway as a safety net: if a future Codex update brings asar integrity back via a different mechanism, the fuse still neutralizes it.

### Why local re-signing instead of disabling SIP?

Re-signing is local-only, reversible, and doesn't compromise system security.
The promotable macOS candidate uses a stable local signing identity; ad-hoc
signing is limited to explicit candidate-only validation. We never touch SIP,
hardened runtime, or kernel-level protections.

### Why a preload, not source-patching the React tree?

Codex is a Vite/Rollup build with a single entry chunk and no module registry exposed at runtime — there's no `webpackChunk` trick. String-patching the minified output is brittle (every Codex release changes the build). Preload + DOM observation uses Settings sidebar and content-area structure; the injector must be checked when upstream markup changes.

### Why a separate runtime in user-dir?

So you can iterate on tweaks (and even on the runtime itself) without re-running the installer. The installer's job is the one-time "punch a hole in the bundle"; everything else lives outside.

### What about Owl?

Current Codex builds use Owl: a native Codex shell with a Chromium framework and
an Electron-compatible JavaScript runtime. Tweaker still patches `app.asar` and
still uses Electron-compatible APIs such as `app`, `BrowserWindow`, `session`,
`ipcMain`, and `ipcRenderer`, but there is no `Electron Framework.framework` in
the current macOS bundle. See [Owl runtime surface](./OWL-RUNTIME.md) for the
observed private APIs.

### Why additive session preloads instead of `webPreferences.preload`?

`webPreferences.preload` is a single string; setting it would replace Codex's
own preload and break the app. The runtime uses
`session.registerPreloadScript()` when available and falls back to
`session.setPreloads()` on older Electron-compatible builds.

## App modes: ChatGPT ⇄ Tweakers (bundle swap)

`/Applications/ChatGPT.app` runs in exactly one of two modes, switched by
swapping the entire payload at that path:

- **chatgpt** — the byte-identical pristine OpenAI Developer-ID bundle is
  live. Genuine Sparkle, Gatekeeper notarization, and the Chrome-extension
  bridge all work; no Tweakers code is injected. The patched payload is
  parked in the payload store (`<user-data-dir>/mode/patched-payload/`).
- **tweakers** — the patched, contained-signed bundle is live and the
  injected runtime, tweaks, and settings UI are active. The pristine payload
  is preserved as the DevID-verified backup (`<user-data-dir>/backup/`).

Both payloads keep the same bundle id and `productName`, so profile/login
state is shared across modes. Switching is owned by the installer CLI —
`tweaker mode <chatgpt|tweakers|status>` — which confirms (unless `--yes`),
quits the app, swaps bundles transactionally (the app path is never empty),
and relaunches. The in-app App Mode control (Settings → Config, tweaker mode
only) confirms in the renderer and then hands the same CLI off via a launchd
job so the helper survives the app quitting and the bundle swap.

The legacy standalone switcher remains for compatibility. The current menu-bar
surface belongs to Menu Bar and invokes Tweakers' sealed manager actions.
Development refresh resolves the registered checkout and validates the candidate
before final promotion. Cutover follows the lifecycle admission locks and exact
target process evidence. Failed acceptance preserves recovery material and
potentially active processes until their state is proved.

Mode discipline:

- In chatgpt mode the watcher, `repair`, `install`, and `refresh-local` all
  stand down — the `tweaker mode` command is the **only** sanctioned way the
  official app path is ever patched, and chatgpt mode is always a
  byte-identical DevID restore away.
- Alternating signers on one bundle id means some macOS TCC permissions
  (Accessibility, Screen Recording) may need re-granting after a switch; the
  confirmation copy discloses this.
- The old soft "vanilla" mode (a per-tweak-storage flag from the retired
  `mode-switcher` tweak that suppressed tweak loading without unpatching) is
  gone; a stale persisted value is cleaned up at runtime startup. "All tweaks
  off without unpatching" remains available via safe-mode.

## Update handling

Official ChatGPT updates are owned exclusively by ChatGPT's native macOS
updater. Tweakers never wraps, routes, repairs, replaces, or otherwise owns
that updater. A native update can remove an injected Tweaker patch; the
separate injected-mode lifecycle may then repair Tweakers' own patch after the
new official bundle has been observed. That patch repair is not an updater.

Independent Tweakers updates use the manager-owned `refresh.independent`
action. It accepts only a sealed official ChatGPT source, builds and promotes
`/Applications/Tweakers.app`, and leaves `/Applications/ChatGPT.app` in its
normal official mode. The separately chosen `refresh.injected` action patches
or restores ChatGPT Tweaker mode; it is a mode operation, not an updater.

The independent deployment keeps its own Electron data, Codex home, cookies,
credentials, and writable databases. A receipt-bound portable-settings lane
handles the small subset of user organization that is safe to reproduce. It
reads validated source fields and writes only local project records, workspace
labels, sanitized Projects nodes, canonical `lh_…` task references, and known
tweak enable flags. Unproven native ordering, native pin, and native appearance
schemas are deliberately excluded. Preview is read-only; apply is offline,
requires the exact preview digest, publishes a receipt last, and has its own
journal and rollback outcome. Canonical shared history is an independent
authority and is never reversed because settings carryover fails.

## Tweaker self-updates

Tweakers runtime and independent-app refreshes are separate from ChatGPT's
native updater. The manager records source, candidate, installation, and live
evidence for `refresh.independent`; it never treats a ChatGPT updater receipt
or a source change as an independent-app update. User tweak folders and
account credentials remain outside the refresh payload.

## What's not protected against

- **A Codex update that changes the asar layout** (e.g., moves the entry script) will break our injection. The installer's `injectLoader` reads `package.json#main` so this should be robust to renames, but if Codex ever ships an executable that doesn't go through Electron's normal asar-loading path, we'd need new strategies.
- **A Codex update that changes the Settings DOM enough that our heuristics fail.** The runtime falls back to a console warning; tweak authors can register sections that simply don't appear until heuristics are updated.
- **Targeted anti-tamper.** Codex doesn't currently appear to do TOCTOU integrity re-checks at runtime. If they ever start, more work is required (LD hooks, MachO patching, etc.) — but this is a different threat model.

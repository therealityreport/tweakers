# Architecture

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
│  <user-data-dir>/tweaker/                                        │
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
2. macOS verifies the (re-signed) ad-hoc signature → Gatekeeper allows launch.
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
   - For each renderer-scoped tweak, `require()`s its entry and calls `start(api)`.
   - Starts the Settings injector (MutationObserver waiting for the Settings dialog).
   - Mounts the built-in Tweak Manager section.
9. When the user opens Settings, our injector:
   - Detects the Radix `[role="dialog"]` matching "Settings".
   - Appends a "Tweaks" tab to the dialog's `[role="tablist"]`.
   - Creates a sibling content panel that shows registered sections when the tab is clicked, and hides itself when other tabs are clicked.

## Why these choices

### Why patch asar entry instead of always using the fuse?

The fuse alone would let us swap in a new asar, but Codex's asar is large (~115 MB) — pointlessly recopying it every install/update is slow. Patching the entry adds ~1 KB. We do flip the fuse anyway as a safety net: if a future Codex update brings asar integrity back via a different mechanism, the fuse still neutralizes it.

### Why local re-signing instead of disabling SIP?

Re-signing is local-only, reversible, and doesn't compromise system security. On macOS, Tweaker creates and reuses a per-machine "Tweaker Local Signing" identity so privacy grants have a stable signer across repair runs. Users can still opt into ad-hoc signing with `--no-local-signing`. We never touch SIP, hardened runtime, or kernel-level protections.

### Why a preload, not source-patching the React tree?

Codex is a Vite/Rollup build with a single entry chunk and no module registry exposed at runtime — there's no `webpackChunk` trick. String-patching the minified output is brittle (every Codex release changes the build). Preload + DOM observation is decoupled from Codex's bundle structure: we only depend on stable affordances (Radix attributes, `[role="dialog"]`, etc.), so most Codex updates just work.

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

The persistent menu-bar switcher exposes mode changes in both modes. While
Tweakers mode is active, it also offers **Reload Tweakers with Latest Changes**.
That action resolves the registered development checkout and starts
`refresh-local --source development`: the checkout is built and a disposable
candidate is validated while ChatGPT stays open, then the app is quit only for
the transactional promotion and relaunch. A failed promotion restores the
previous working payload.

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

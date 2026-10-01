# Dock Icon Customizer Plan

- Plan date: 2026-07-17
- Repository truth: current dirty `main` working tree, installed ChatGPT app,
  and active managed Tweakers runtime
- Installed host inspected: ChatGPT/Codex `26.707.91948`
- Selected route: create `co.tweakers.dock-icon`
- Implementation status: not started

## Outcome

Extend the native macOS Dock icon selector with:

1. A bundled ShadGPT logo.
2. A local custom-image upload.
3. Immediate Dock preview/application without restarting ChatGPT.
4. Persistent selection across launches.
5. Safe restoration of the user's native ChatGPT or Codex choice when the
   custom selection is cleared or the tweak is disabled.

This changes the running app's Dock icon only. It must not rewrite the app
bundle, Finder icon, `Info.plist`, `Assets.car`, or LaunchServices state.

## Located selector

The user-facing path in the installed app is:

```text
Settings -> General -> Appearance -> Dock icon
```

The current selector implementation is inside the installed ASAR at:

```text
/Applications/ChatGPT.app/Contents/Resources/app.asar
  /.vite/build/main-DzYoPEAp.js
  /webview/assets/general-settings-DMO9G9gL.js
```

`general-settings-DMO9G9gL.js` renders a two-column radio group with:

- `aria-label="Dock icon"`;
- `input[name="dock-icon"]`;
- native values `app-default` and `codex-system`;
- accessible choices `Use ChatGPT Dock icon` and `Use Codex Dock icon`.

The main-process implementation in `main-DzYoPEAp.js`:

- reads the `dock-icon-preference` setting;
- restores ChatGPT with `app.dock.setIcon(null)`;
- loads `icon-codex-light.png` or `icon-codex-dark-color.png` for Codex;
- reapplies the Codex variant when the macOS system appearance changes.

The current built-in image resources are:

```text
/Applications/ChatGPT.app/Contents/Resources/icon-chatgpt.png
/Applications/ChatGPT.app/Contents/Resources/icon-codex-light.png
/Applications/ChatGPT.app/Contents/Resources/icon-codex-dark-color.png
```

Hashed bundle filenames and minified function names are discovery evidence,
not implementation selectors. The integration should locate a radio group
containing `input[name="dock-icon"][value="app-default"]` and
`input[name="dock-icon"][value="codex-system"]`, then verify its radio-group
role before changing it.

## Route decision

Create a new tweak named `Dock Icon Customizer` with id
`co.tweakers.dock-icon`, starting at `0.1.0`.

This is an independent, macOS-only capability with its own toggle, binary
asset storage, main-process Electron work, theme lifecycle, and restoration
contract. `co.tweakers.ui-improvements` and
`co.tweakers.shadcn-codex-ui` are renderer-only owners; putting Dock identity
in either would broaden its responsibility and permissions unrelatedly.

Proposed manifest contract:

```json
{
  "id": "co.tweakers.dock-icon",
  "name": "Dock Icon Customizer",
  "version": "0.1.0",
  "githubRepo": "therealityreport/tweakers",
  "description": "Add ShadGPT and local custom images to the macOS Dock icon selector.",
  "author": "hulibrands",
  "tags": ["macos", "dock", "appearance"],
  "scope": "both",
  "permissions": ["settings", "ipc", "filesystem"],
  "minRuntime": ">=1.1.0"
}
```

No network or native-helper permission is required. The main-process half can
use Electron's existing `app`, `nativeImage`, and `nativeTheme` exports.

## Design

### 1. Leave native preference data untouched

The host schema accepts only `app-default` and `codex-system`. Do not write
`shadgpt` or `custom` into that private setting and do not patch `app.asar`.

Maintain a separate Tweakers selection:

```json
{
  "schemaVersion": 1,
  "selection": "shadgpt",
  "basePreference": "codex-system",
  "customImage": null
}
```

Allowed `selection` values are `native`, `shadgpt`, and `custom`.
`basePreference` records the checked native radio immediately before a custom
choice is applied. The native preference remains the fallback underneath the
override.

### 2. Bundle the ShadGPT preset

Add the approved brand image at:

```text
tweaks/co.tweakers.dock-icon/assets/shadgpt-dock-icon.png
```

Use a transparent, square PNG, preferably 1024x1024, with enough padding to
remain legible at Dock sizes. No current ShadGPT-named image was found in the
Tweakers checkout, the ShadGPT project paths inspected, or the installed app,
so implementation must obtain or confirm the canonical asset instead of
renaming a ChatGPT/Codex icon.

The same file can be referenced as the tweak's relative `iconUrl` if desired.
`npm run sync:tweaks` will package the complete tweak tree, including assets.

### 3. Extend the native selector semantically

In the renderer lifecycle:

- observe the General/Appearance settings surface through the existing host
  surface API, with a bounded DOM fallback;
- locate the verified native radio group rather than a hashed class;
- append two owned tiles to its existing two-column grid: `ShadGPT` and
  `Custom`;
- use real radio semantics, the existing `dock-icon` name, visible labels,
  focus rings, and `aria-describedby` help/error text;
- give owned elements a `data-tweaker-dock-icon-*` marker so rerenders cannot
  duplicate them;
- add an `Upload image...` action and hidden file input to the Custom tile;
- show `Replace image...` and `Remove custom image` when an upload exists;
- keep the two native tiles and their React handlers intact.

Selecting either existing native tile clears the Tweakers override after the
host's own change handler runs. Selecting ShadGPT or Custom leaves the host
preference unchanged, updates the owned radio state, and invokes the main
service.

If the expected native selector contract is absent after an app update, do
not guess at another settings row. Log one compatibility warning and leave the
host UI untouched.

### 4. Validate uploads in the main process

Accept PNG and JPEG only:

```text
image/png,image/jpeg,.png,.jpg,.jpeg
```

Validation and storage rules:

- maximum input size: 5 MiB;
- decode from bytes with `nativeImage.createFromBuffer`, never trust filename
  or declared MIME alone;
- reject `image.isEmpty()` and invalid dimensions;
- reject either decoded dimension above 8192 pixels;
- preserve aspect ratio while reducing the longest dimension to at most 1024
  pixels;
- encode the accepted result with `image.toPNG()` so persisted uploads have a
  single format and do not retain the original filename or JPEG metadata;
- cap the normalized PNG at 8 MiB;
- write a temporary file with mode `0600`, fsync if supported, and atomically
  rename it to `custom-dock-icon.png` inside `api.fs.dataDir`;
- write state only after the image write succeeds;
- never accept SVG, remote URLs, data paths supplied by the caller, or files
  outside the selected browser `File` bytes.

The renderer may produce a local preview, but the main process is the
authority for validation, normalization, persistence, and application.

### 5. Add a narrow main-process service

Use tweak-prefixed IPC actions with bounded payloads:

- `state.get` returns selection, base preference, custom preview, capability,
  and any recoverable error;
- `selection.setNative` records `app-default` or `codex-system`, clears the
  active override, and restores that native icon;
- `selection.setShadgpt` validates the bundled asset and applies it;
- `selection.setCustom` validates, stores, and applies uploaded bytes;
- `custom.remove` deletes only the owned custom PNG and falls back safely.

Every response should use a stable `{ ok, value?, error? }` envelope. Reject
unknown actions, invalid preference values, and oversized base64 before
decoding. Broadcast a revision event so every open renderer reconciles.

### 6. Apply and restore the Dock icon safely

After `app.whenReady()` on macOS:

- load the selected ShadGPT/custom file with `nativeImage.createFromPath`;
- reject an empty image;
- call `app.dock?.setIcon(image)`;
- reapply an active custom override after `nativeTheme`'s `updated` event so
  the host's Codex light/dark listener cannot replace it;
- remove that listener during stop.

Restoration must mirror the installed host's public behavior:

- for `app-default`, call `app.dock.setIcon(null)`;
- for `codex-system`, select
  `icon-codex-dark-color.png` or `icon-codex-light.png` from
  `process.resourcesPath` using
  `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`, validate it, and
  call `setIcon`;
- if the Codex resource contract changes or an image is invalid, fall back to
  `setIcon(null)` and return a visible compatibility warning rather than
  leaving a missing/blank Dock icon.

Run this restoration when the user chooses a native tile, removes the active
custom image, or disables the tweak. On the next app launch, the native host
preference remains authoritative unless the persisted Tweakers override is
still active.

Non-macOS hosts should report `unsupported` and inject no controls.

### 7. Keep lifecycle cleanup complete

Renderer stop must:

- disconnect observers;
- remove only owned tiles/help/error nodes;
- revoke preview blob URLs;
- remove file-input, click, change, and native-radio listeners;
- leave the native radio group exactly as found.

Main stop must:

- remove IPC and theme listeners;
- restore `basePreference` before disposing when a custom override is active;
- leave persisted state and the user's uploaded image available for a later
  re-enable;
- never quit, relaunch, or replace ChatGPT.

## Canonical file changes

Create:

- `tweaks/co.tweakers.dock-icon/manifest.json`
- `tweaks/co.tweakers.dock-icon/index.js`
- `tweaks/co.tweakers.dock-icon/assets/shadgpt-dock-icon.png`
- `tweaks/co.tweakers.dock-icon/test/dock-icon.test.js`

After canonical work, run `npm run sync:tweaks`. That command owns all catalog
and packaged copies, including:

- `store/index.json`
- `packages/installer/assets/runtime/catalog.json`
- `packages/installer/assets/runtime/tweaks/co.tweakers.dock-icon/**`

Do not hand-edit generated copies.

## Test plan

### Focused unit and lifecycle coverage

Add tests for:

- manifest id, `0.1.0` version, explicit `both` scope, and permissions;
- state normalization and rejection of unsupported selection/preference values;
- payload limits before base64 decoding;
- valid PNG/JPEG decode, empty/corrupt image rejection, dimension limits,
  aspect-preserving resize, and PNG re-encoding;
- atomic write ordering and failure rollback;
- ShadGPT asset resolution and missing-asset fallback;
- `app-default` restoration via `setIcon(null)`;
- light/dark Codex resource selection and fallback when resources are missing;
- macOS gating and missing `app.dock` behavior;
- theme-change reapplication only while an override is active;
- IPC validation, safe errors, and revision broadcasts;
- one-time selector injection across repeated host rerenders;
- native-radio selection clearing the override without blocking the host;
- upload/replace/remove flows, keyboard use, focus, and accessible names;
- full renderer and main cleanup with no remaining owned nodes/listeners.

Mock Electron in unit tests; do not mutate the real Dock during the test suite.

### Repository verification

Run in order:

```sh
node --test tweaks/co.tweakers.dock-icon/test/dock-icon.test.js
npm run sync:tweaks
npm run sync:tweaks -- --check
npm run check:tweak-catalog
npm run typecheck
npm run build
npm test
```

Also verify the generated tweak tree matches canonical source and that
unrelated dirty work remains untouched.

### Live verification

Only after focused, build, catalog, and full-suite verification succeeds:

1. Run one safe `tweaker dev-sync` snapshot.
2. Open `Settings -> General -> Appearance` in the already-running app.
3. Verify ChatGPT, Codex, ShadGPT, and Custom appear as one accessible group.
4. Select ShadGPT and confirm the Dock changes immediately.
5. Upload representative square and non-square PNG/JPEG images and verify the
   preview, aspect ratio, persistence, replace, and remove flows.
6. Switch macOS light/dark appearance and confirm a custom override remains
   selected; then select Codex and confirm native light/dark behavior resumes.
7. Disable the tweak and confirm the previous native icon is restored and the
   native selector remains usable.
8. Review runtime logs for warnings/errors and confirm no duplicate controls
   after closing/reopening Settings.

No app restart or live promotion is required for this feature. If hot-sync
cannot activate the new main-scoped tweak safely, stop after source
verification and leave any restart/promotion as a separate user-confirmed
final step.

## Acceptance criteria

- The native Dock selector remains the single user-facing surface.
- ShadGPT and Custom appear beside ChatGPT and Codex on supported macOS hosts.
- PNG/JPEG uploads are local-only, validated, normalized, and persistent.
- Applying any choice updates the Dock immediately.
- Theme changes do not override an active ShadGPT/custom selection.
- Native ChatGPT/Codex behavior resumes when the override is cleared or the
  tweak is disabled.
- Host-schema or asset drift fails visibly and safely without ASAR mutation.
- All owned DOM, listeners, IPC handlers, and theme hooks are removed on stop.
- Canonical/catalog/generated state is synchronized and the full suite passes.

## Documentation basis

- Electron documents `dock.setIcon(image)` as the macOS runtime API for a
  custom Dock image.
- Electron `nativeImage.createFromBuffer` decodes PNG/JPEG, `isEmpty()` detects
  an invalid result, `resize()` can preserve aspect ratio, and `toPNG()`
  provides the normalized persisted representation.
- OpenAI's icon and imagery guidance favors recognizable logos, correct aspect
  ratios, and iconography that fits the host visual language. Apply that as
  visual guidance only; it is not a desktop extension API.

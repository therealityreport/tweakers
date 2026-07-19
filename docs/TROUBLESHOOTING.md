# Troubleshooting

## "Codex is damaged and can't be opened" / Gatekeeper rejection

The re-sign step failed or was skipped. Run:

```sh
tweaker doctor
```

If the signature check fails, manually re-sign:

```sh
tweaker repair --force
xattr -dr com.apple.quarantine /Applications/Codex.app
```

On macOS, Tweaker signs ad-hoc by default. `tweaker install --local`
or `tweaker repair --local` opts into a local "Tweaker Local Signing"
identity, but that can involve Keychain access prompts.

## App launches but nothing about tweaker appears

1. Open DevTools (View menu) and look for `[tweaker]` lines.
2. Check `~/Library/Application Support/tweaker/log/loader.log`.
3. If empty, the loader is not being executed → integrity check failed and the app silently fell back. Run `tweaker repair`.

## Codex auto-updated and the patch is gone

The watcher should normally re-apply the patch automatically. To force it immediately, run:

```sh
tweaker repair
```

Check the watcher is installed:

```sh
launchctl list | grep tweaker      # macOS
systemctl --user status tweaker-watcher  # Linux
schtasks /Query /TN tweaker-watcher       # Windows
```

## macOS keeps asking: ChatGPT wants to access key "Codex Storage Key"

The "Codex Storage Key" keychain item is Electron's `safeStorage` encryption
key, created by the original OpenAI-signed app. Its access control list trusts
only that original signature, so after Tweakers re-signs the app with the
local identity, macOS prompts on every access. Clicking plain **Allow** grants
a single access, which is why the prompt reappears.

Fix (one time): click **Always Allow** and enter your login password. The
grant is durable across future Tweakers patches because the local signing
certificate (and therefore the app's designated requirement) never changes.

If prompts continue even after Always Allow, reset the item's partition list
(you will be asked for your login password by `security` itself):

```sh
security set-generic-password-partition-list -S "apple:,unsigned:" \
  -a Codex -l "Codex Storage Key" ~/Library/Keychains/login.keychain-db
```

Do not click **Deny** repeatedly: the app may treat the unreadable key as a
corrupt store and reset its encrypted data, signing you out.

## "Tweaks" tab doesn't appear in Settings

Codex's Settings markup may have changed. The injector's heuristics need an update. As a workaround:

1. Open DevTools, run `document.querySelectorAll('[role=dialog]')` while Settings is open. If nothing matches, the dialog uses different attributes — please file an issue with the markup snippet.
2. Until fixed, your tweaks still load (check the console). Their settings sections just have no UI to attach to yet.

## Tweak fails to load

Check the renderer console:

```
[tweaker] tweak load failed: <id> <error>
```

Common causes:

- `manifest.json` not valid JSON
- Missing `id`/`name`/`version` fields
- Entry script throws during `require`
- ESM-style `export default` in a `.js` file (use `.mjs` or `module.exports`)

## Uninstall is incomplete

The uninstaller only restores files we backed up at install time. If you've upgraded `tweaker` and the original app version no longer matches, the restored backup may be stale. Either:

- Reinstall Codex from a fresh download
- Or `tweaker install` against the new Codex, then `uninstall`

## I want to start fresh

```sh
tweaker uninstall --purge
```

This removes the runtime, watcher, tweaks, config, logs, backups, and Tweaker user data. Then reinstall Codex.app from the official download.

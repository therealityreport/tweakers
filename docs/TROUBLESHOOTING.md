# Troubleshooting

## Accounts are missing or setup is incomplete

**Account setup is incomplete** means the configured shared account service is
missing its registration files. It does not mean the saved accounts were deleted.
Choose **View setup steps** in the account menu. Prepare native-account linking
with `tweaker link-native-accounts --dry-run` and the exact existing account-home
arguments described in [the account-router guide](account-router.md). The preview
must verify both saved sign-ins without copying credentials or history.

Complete source checks and candidate validation while the apps remain running.
Use the existing native-history activation coordinator only in the separately
approved final maintenance window. Do not create an empty shared folder, copy
old account data into it, or re-save accounts as a workaround.

**Accounts are unavailable right now** can instead indicate a temporary service
connection failure. Open **Manage accounts** and choose **Try again**. A retry
does not change account registration or restart either app.

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

ChatGPT updates are owned by ChatGPT's native macOS updater. Tweakers does not
wrap, route, repair, or replace that updater. If ChatGPT updated while an
injected Tweaker mode was installed, inspect Tweakers' patch state first and
repair only the Tweakers injection:

```sh
tweaker status
tweaker doctor
tweaker debug
```

For the independent app, use the manager-owned `refresh.independent` action.
It validates a sealed official ChatGPT source and updates only
`/Applications/Tweakers.app`. The separate `refresh.injected` action patches or
restores ChatGPT Tweaker mode; it is a mode operation, not an updater.

## Independent Tweakers opens but projects or customizations are blank

Do not point Tweakers at ChatGPT's profile or copy the whole ChatGPT/Codex data
directory. That would also copy identity, cookies, account state, and writable
databases. First verify the independent runtime-ready receipt and shared-history
broker. Then, during a separately authorized offline activation window, run
`portable-settings-migration preview` with exact source and target roots. Review
its exclusions and conflicts, then pass its exact intent fingerprint to the
`apply` action. If publication is interrupted, use the same transaction ID with
`recover`; never rerun it under a new ID or overwrite a changed destination.
The command does not quit, start, or restart either app for you.

## Menu Bar says the manager launcher is outside the fixed root

Current builds trust only the sealed manager generation under
`~/Library/Application Support/Tweakers`. A launcher under the retired
`codex-plusplus` location is historical data, not authority. Rebuild the Menu
Bar source and the Tweakers manager generation through their normal candidate
workflows; do not move a launcher by hand or weaken the path check. Manager
actions stay disabled until the root, seal, launcher, Node binary, and manager
bundle all verify together.

## A plugin detail page returns `/backend-api/ps/plugins/...` 404

When the same plugin ID returns 404 in both official ChatGPT and independent
Tweakers, the failure is from the account's remote ChatGPT plugin catalog, not
the local Tweakers patch. Do not copy plugin caches, invent a local catalog
record, or reset profiles to hide it. Preserve the plugin ID and request URL in
diagnostics and report the missing catalog entry to OpenAI; local source work
cannot restore a server-side entitlement or deleted catalog record.

## macOS asks ChatGPT or Tweakers to access key "Codex Storage Key"

The "Codex Storage Key" keychain item is Electron's `safeStorage` encryption
key, created by the original OpenAI-signed app. Its access control list trusts
only that original signature, so after Tweakers signs an injected or independent
app with its stable local identity, macOS asks whether that identity may use the
key. The inherited key name describes the OpenAI desktop engine; it does not
mean ChatGPT and independent Tweakers share a profile, cookie database, account
home, or writable conversation database. Clicking plain **Allow** grants a
single access, which is why the prompt reappears.

Fix (one time): click **Always Allow** and enter your login password. The
grant is durable across future Tweakers patches because the local signing
certificate (and therefore the app's designated requirement) never changes.

Do not make this choice from an automated update or health check. The app may
remain open behind the prompt, but normal startup is blocked until the signed
Tweakers identity is allowed or denied by the user.

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

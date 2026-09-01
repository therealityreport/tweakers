# Accounts

`co.tweakers.account-switcher` is the stable internal ID for the user-facing
**Accounts** feature. Keeping that ID preserves saved accounts, settings, and
receipts. Version 0.4.4 makes the two saved identities recognizable with a
profile name, account email, and optional local username. When no authenticated
account router is running, it also marks the one uniquely matched saved account
that Codex is using now, and explains that automatic routing has not started
for the other saved account. When automatic routing is running, each safely
matched row shows whether it can receive new work or needs attention. Manual
mode keeps the rows labeled as saved accounts because it does not expose a safe
per-row primary marker. Routine hot reloads still never change the saved
routing mode.

## What it shows

- A native-style profile-menu summary with **Weekly usage left**, **2 saved
  accounts**, a combined 0–200% total when both weekly values are current, two
  account rows, and **Manage accounts**.
- Friendly profile names and account emails for generic saved
  filenames. A username can be added or changed locally from Accounts; Codex's
  current structured account data does not provide a username, so Accounts
  never guesses one from the email address. Duplicate profile names receive
  clear `Account 1` and `Account 2` suffixes. Old saved-file numbers can skip,
  so filenames such as `account-2.json` and `account-3.json` do not mean an
  account is missing.
- Safe plan, weekly-usage, reset, assigned-conversation, and eligibility text.
  It never renders provider IDs, tokens, paths, opaque account IDs, or private
  configuration. Email and optional username are presentation only; they never
  become routing, history, quota, plugin, or recovery join keys.
- Each account row says whether it is **Using now**, **Saved — automatic routing
  is not running yet**, **Automatic routing is on**, **Saved account**, or needs
  attention. Those labels are shown only from the live router state and a
  private account reference match; visible names, emails, and usernames never
  establish a connection. An uncertain state is shown as **Status unavailable**.
- A Settings > Accounts page with **Automatic routing for new conversations**,
  **Your current conversations**, **Connect or repair accounts**, manual
  switching, and a plain-language plugin check.

## Routing states

- **Manual** is the default and remains the rollback path.
- **Quota-aware** stages exactly two distinct saved accounts in owner-private
  isolated homes. It uses policy `quota_aware_v1`; compatibility weights remain
  in the config but are not user controls.
- A v2 on-disk config is a pending intent only. It records a monotonically
  increasing generation and an immutable SHA-256 fingerprint over the routing
  intent. Its timestamp uses the runtime's strict UTC ISO form; a timestamp-only
  change cannot alter the fingerprint.
- Before automatic routing can be saved, choose exactly one of the two
  selected saved accounts in **Which account should keep my existing
  conversations?** There is no
  default and the choice is never inferred from the current sign-in, primary
  account, order, label, or account metadata. Staging records a signed,
  private offline-adoption intent; it does not move history or change live
  routing.
- The authenticated local router socket is the only source allowed to claim an
  active generation. A pending manual or quota-aware policy never overwrites
  that live truth in the UI.

## Safety and recovery

- Saved snapshots keep their filenames and remain the source of the two
  enrolled identities. Profile name and account email are projected only for
  display; an optional username is stored separately under the tweak's existing
  data namespace. None of these visible fields is an identity join.
  Each prepared home has its own
  private `auth.json`, SQLite home, and empty strict `config.toml`; global
  configuration, environment values, plugin OAuth state, and private plugins
  are not copied.
- Each source is identity-bound and rechecked before promotion. A failed stage
  writes its bounded receipt batch before the config's final publication. A
  receipt failure leaves no pending config. A retry may reuse only a hardened
  isolated home for the same opaque account identity, preserving any normal
  token rotation already written by that account's official child process.
- A stale account is marked for targeted reauthentication. Manually switch to
  that exact saved account, sign in, then refresh it from Accounts. Recovery
  requires confirmed stopped router control, rechecks the same opaque identity,
  refreshes only that existing saved source and isolated home, and rolls both
  back if it cannot publish the new pending generation. It never creates a
  third snapshot; the other account remains preserved.
- A later offline adoption creates a separately signed private receipt with
  aggregate file and thread counts only. The Accounts page shows only the safe
  selected label and those aggregate counts—never account identifiers, paths,
  session content, source fingerprints, or control secrets. Once history is
  adopted, restaging is allowed only for the same two-account pool and chosen
  owner; generation, mode, label, and compatibility-weight changes do not
  rewrite that ownership.
- When there are one or three-or-more saved snapshots, quota-aware routing is
  unavailable but every saved account remains available for manual switching in
  Advanced and the profile menu.
- Staging, recovery guidance, and rollback staging never restart ChatGPT. A
  separately confirmed restart is required for a pending policy to become
  active.
- Reloading or disabling the Accounts UI does not change the saved routing
  mode. Manual routing must be chosen explicitly before a later restart.
- After history adoption, a Manual pending state applies only to new-thread
  assignment after that separately confirmed restart. It does not globally
  restore or reassign existing adopted history.
- v1 router configuration/status remains readable for compatibility, but new
  staging writes only v2 `quota_aware_v1` or v2 manual intent.

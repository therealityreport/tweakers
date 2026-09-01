# Accounts

`co.tweakers.account-switcher` keeps the existing manual saved-session controls
and optional remote-plugin receipt protection. Version 0.4 makes the native
Accounts page and profile menu a two-account, quota-aware experience.

## What it shows

- A native-style profile-menu summary with **Usage remaining**, **2 connected
  subscriptions**, a 0–200% pool calculated from the two weekly values, two
  account rows, and **Manage Accounts**.
- Safe local labels, plan names, fixed permanent masks, weekly remaining
  values, reset/freshness state, assigned-thread counts, and router eligibility.
  It never renders emails, provider IDs, tokens, paths, opaque account ids, or
  private configuration.
- A Settings > Accounts page with account cards, setup/recovery guidance, and
  manual switching plus remote-plugin protection under Advanced.

## Routing states

- **Manual** is the default and remains the rollback path.
- **Quota-aware** stages exactly two distinct saved accounts in owner-private
  isolated homes. It uses policy `quota_aware_v1`; compatibility weights remain
  in the config but are not user controls.
- A v2 on-disk config is a pending intent only. It records a monotonically
  increasing generation and an immutable SHA-256 fingerprint over the routing
  intent. Its timestamp uses the runtime's strict UTC ISO form; a timestamp-only
  change cannot alter the fingerprint.
- Before quota-aware routing can be staged, choose exactly one of the two
  selected saved accounts in **Keep my existing history with**. There is no
  default and the choice is never inferred from the current sign-in, primary
  account, order, label, or account metadata. Staging records a signed,
  private offline-adoption intent; it does not move history or change live
  routing.
- The authenticated local router socket is the only source allowed to claim an
  active generation. A pending manual or quota-aware policy never overwrites
  that live truth in the UI.

## Safety and recovery

- Saved snapshots keep their names and remain the source of the two enrolled
  identities. Each staged home has its own
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
- After history adoption, a Manual pending state applies only to new-thread
  assignment after that separately confirmed restart. It does not globally
  restore or reassign existing adopted history.
- v1 router configuration/status remains readable for compatibility, but new
  staging writes only v2 `quota_aware_v1` or v2 manual intent.

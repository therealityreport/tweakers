# Easy Account Switcher

`co.tweakers.account-switcher` keeps the existing manual saved-session switcher
and optional remote-plugin receipt protection. Version 0.3 adds a visible,
truthful routing control plane to the existing Accounts page.

## Modes

- **Manual** is the default and remains the rollback path. Existing saved
  snapshots, the current-account marker, and last-known-good snapshot remain
  compatible.
- **Balanced** accepts exactly two distinct saved sessions and integer weights
  from 1 through 100. It creates isolated, owner-private account homes and
  stages a versioned router configuration for a later separately authorized
  restart. Staging does not restart ChatGPT or change the global `auth.json`.

## Privacy and safety

- The router config, migration receipts, state, and control secret are written
  atomically in the owner-private Account Switcher data namespace. The config contains only
  opaque HMAC-derived account keys, inclusion, weights, and fingerprints.
- Each staged home has its own `auth.json`, SQLite home, and empty strict
  `config.toml`; credentials, environment values, MCP secrets, plugin OAuth
  state, and private plugins are not copied.
- A failed pre-promotion import removes only its exact new staging directory.
  It never deletes or overwrites a compatible manual snapshot, marker, LKG,
  global auth file, or another account home.
- The settings page exposes only redacted labels, opaque keys, eligibility,
  normalized local spend, assignment counts, and degraded codes. It never
  displays tokens, raw provider IDs, emails, paths, secret config, or thread
  IDs.

## Balance state

The balance epoch may be reset only when the local router reports no
reservations, correlations, child validation, active work, or refresh/migration
activity. A reset is durable and preserves manual snapshots and isolated homes.
Existing plugin-protection receipts keep their existing observation and
enforcement behavior; no plugin installation, deletion, reconciliation, or
credential copying is performed while staging routing.

Balanced mode is source-stage functionality only until the runtime candidate,
independent evidence, explicit live-account bindings, and separately authorized
restart have all been completed.

## 0.3.0 Accounts-page state

- The Account Switcher row opens the stable `Accounts` settings page. Its routing
  card is always present and names one state: `Not configured`, `Save two
  accounts`, `Ready to stage`, `Manual`, `Balanced staged - restart required`,
  `Running Balanced`, `Direct fallback`, or `Degraded`.
- Two ordinary signed-in sessions are not router snapshots. The page shows only
  a saved-snapshot count for setup, and Balanced mode stays disabled until the
  user explicitly selects exactly two distinct snapshots with valid weights.
- Staging is an explicit button click. It does not save an account, switch an
  account, or restart ChatGPT/Codex.
- `Running Balanced` and its Account A/B assigned-thread counts are displayed
  only after the owner-private mux control socket returns an authenticated,
  redacted status. A staged configuration or local state file never creates a
  live routing badge.

## 0.2.1 routing repair

- Router-owned directories created with the normal owner-readable `0755` mode
  are verified through open descriptors and tightened to `0700`; unsafe,
  symlinked, replaced, or foreign-owned paths are rejected without changing the
  shared parent directory.
- Selecting Manual while no router configuration exists is a successful no-op,
  and an already-manual configuration is not rewritten.
- Snapshot synchronization can repair a stale current-account marker only when
  one secure saved snapshot uniquely matches the live account. A failed marker
  write restores the previous marker.
- Router controls expose only a finite set of safe error codes and fixed user
  messages; lower-level paths and error details stay out of the settings UI and
  logs.

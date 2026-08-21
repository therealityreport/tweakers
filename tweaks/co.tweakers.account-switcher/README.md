# Easy Account Switcher

`co.tweakers.account-switcher` keeps the existing manual saved-session switcher
and optional remote-plugin receipt protection. Version 0.2 adds a staged,
two-account balanced routing control plane for the local runtime.

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

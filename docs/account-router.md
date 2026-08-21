# Account Router

`co.tweakers.account-switcher` 0.2.0 retains its existing Manual account-switching behavior and can stage a two-account Balanced mode for a later, separately authorized restart. It is an unsupported local integration, not an OpenAI-approved feature. It never creates accounts, changes provider limits, shares credentials, retries uncertain requests on a second account, or makes an ineligible account eligible.

Balanced mode remains deliberately inactive until its separately authorized restart and later acceptance gates. Staging it does not restart the app, use a provider account, or publish any configuration outside the local owner-private data directory.

## Operating model

- Manual mode is the default and the direct official app-server path remains the fallback for missing, invalid, unsupported, or unsafe router configuration.
- Balanced mode has exactly two enrolled local snapshots. Each official app-server child receives its own isolated `CODEX_HOME` and SQLite home, and a thread stays with its first selected account.
- New threads use the locally recorded weighted least-spent estimate. A status is marked projected while work is reserved and estimated when exact terminal usage is unavailable; it is not a claim of provider-side equality.
- The router writes only opaque local account identifiers, redacted state, and owner-private configuration. Raw provider IDs, account emails, auth payloads, refresh tokens, file paths, request contents, and the control capability are never rendered or included in operator output.
- A failure after the mux has accepted work stages disable and returns a bounded error. It never swaps an already-open stdio session back to the direct child; a later separately authorized restart returns to Manual/direct mode.

## Operator evidence

`tweaker status` and `tweaker doctor` report four different observations instead of treating one as proof of another:

| Layer | Meaning | Does not prove |
| --- | --- | --- |
| Source | The Account Switcher manifest in the installer state’s recorded source checkout. | Candidate, installed, or live bytes. |
| Candidate | The runtime bundled with the currently running installer package. | That user-dir runtime assets have been promoted. |
| Installed | The runtime files currently staged in the user directory. | That the desktop app has been restarted into them. |
| Live | A successful authenticated read from the currently running mux. | Provider identity, quota, token-refresh, cancellation, delivery, or any authenticated acceptance gate. |

The command also labels the staged configuration (`not staged`, `manual`, `balanced`, `invalid`, or `unsafe`). A `not running` live result is expected before the separately authorized restart; it is not evidence that a router process was launched.

## Local control status

While Balanced mode is actually running, the mux exposes one read-only status request over a deterministic owner-private Unix socket. The endpoint is placed in a short, owner-private `/tmp` directory only because macOS AF_UNIX pathname limits can be shorter than the normal data-root path. Its location is derived from the local Account Switcher router-data root; it does not encode an account identity.

The endpoint accepts one bounded JSONL `status` request per connection. It requires the 256-bit `control-secret.v1` capability stored in the owner-private router directory and compares it in constant time. Invalid, malformed, oversized, or pipelined requests receive no diagnostic payload. Successful responses contain only the redacted status projection. The socket closes on orderly, fatal, and startup-failure cleanup.

The renderer does not connect to this socket. It continues to use the Account Switcher’s scoped IPC and receives only a redacted projection. The installer client uses the same deterministic endpoint only for its local, read-only status/doctor evidence.

## Safety and authority boundaries

- Do not treat source, candidate, installed, or live status as permission to activate Balanced mode.
- Do not use status output to infer account ownership, plan eligibility, administrator approval, provider policy, provider quota, or whether a request was delivered.
- Any provider warning, administrator prohibition, credential ownership mismatch, unsupported protocol, invalid private-file mode, or cross-account mismatch is a fail-closed condition.
- Restart, live activation, authenticated canary work, dev-sync, commit, push, tag, and publication all require their own explicit authority.

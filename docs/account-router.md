# Account Router

`co.tweakers.account-switcher` retains its Manual account-switching behavior. Its v2 `quota_aware_v1` policy can stage exactly two local accounts for quota-aware **new-thread** routing after a separately authorized restart. This is an unsupported local integration, not an OpenAI-approved feature. It does not create accounts, alter provider limits, make an unavailable account eligible, migrate a thread, or retry an uncertain request on another account.

## Routing and availability contract

- V2 has exactly two enrolled, included local accounts. A new thread is assigned using the redacted per-account quota projection. Once assigned, the thread remains with that account for every follow-up, resume, fork, interruption, and turn.
- The router does not fail over or migrate an existing thread. If either account is unavailable, stale in a way that cannot establish eligibility, reauthentication-blocked, depleted, or protocol-blocked, it pauses new-thread assignment rather than silently sending all work to the other account.
- A configuration change is staged disk intent. It applies only to the next qualified app-server start. It cannot switch an existing stdio session or prove a runtime was activated.
- Staging Manual is a rollback request for the next restart. Until that restart, an already-running quota-aware mux can remain active. Likewise, staging quota-aware mode does not turn it on.
- A tweak hot reload or lifecycle stop never stages Manual. Only the explicit Accounts control may change the saved routing mode.

## Operator evidence

`tweaker status` and `tweaker doctor` keep five facts separate:

| Layer | Meaning | Does not prove |
| --- | --- | --- |
| Source | Accounts tweak manifest in the registered development checkout. | Candidate, installed, pending, or live bytes. |
| Candidate | Runtime bundled with this installer package. | That it was promoted to the user directory. |
| Installed | Runtime artifacts in the user directory. | That the desktop restarted into them. |
| Pending | Validated owner-private disk configuration: v2 mode, policy, generation, and fingerprint; legacy v1 is labelled as such. | The active app-server mode or generation. |
| Live | Authenticated read from the discoverable owner-private mux socket: active mode, policy, generation, fingerprint, and any runtime-pending generation. | Provider authorization, policy approval, a delivered request, or live activation of a newly staged configuration. |

The CLI probes a safely discoverable socket even when disk intent is Manual or invalid. This prevents a staged rollback from falsely presenting direct/manual as already active. `not running` means no authenticated mux was found; it is not proof that direct mode was restarted. `unavailable` means the socket could not be safely authenticated or parsed.

V1 config and socket responses remain readable. A v1 `balanced` projection is legacy local-token evidence, not provider quota. V2 output labels the pending and active generations and fingerprints independently; if they differ, the change is pending a restart.

## Redacted quota projection

For each account, v2 output accepts only a safe local routing label, eligibility, a safe plan label, a masked identifier, weekly remaining percentage/reset/freshness, short-window pressure, and assigned-thread count. The saved-account list separately supplies a safe display-only profile name. Generic storage filenames such as `account-2.json` remain stable routing joins but are not shown to the user. Their old sequence numbers can skip, so non-contiguous filenames do not mean an account is missing. The pool display is the sum of the two weekly remaining percentages and is explicitly `0–200%`, not a provider guarantee or a single-account percentage.

The Accounts list may separately show the email from the saved ChatGPT identity and an optional username stored locally by the user. Those presentation fields never enter router configuration, control-socket status, CLI status, logs, quota joins, history joins, plugin receipts, or recovery matching. The current structured account response has no username field, so Accounts does not derive a handle from an email address or provider claims.

The router status reader rejects unexpected fields and never reports raw account or provider IDs, email addresses, usernames, auth payloads, tokens, local paths, thread IDs, request content, control capabilities, or provider error bodies. Missing or stale quota is shown as unavailable/unknown rather than zero. When no authenticated router is running, the settings and profile-menu UI may show **Using now** only when the live account ID, the saved marker, and one unique saved snapshot match across a stable observation. A running router has no single global current account, so router eligibility is shown as **Ready for new conversations**, never **Using now**.

## Local control status

An actually running mux exposes a read-only status request through a deterministic owner-private Unix socket. The endpoint uses a short owner-private `/tmp` directory because macOS AF_UNIX pathname limits can be shorter than the normal data-root path. Its location derives from the local Accounts router-data root and contains no account identity.

Each bounded JSONL request requires the owner-private 256-bit `control-secret.v1` capability. Invalid, malformed, oversized, or pipelined requests receive no diagnostic payload. The renderer never connects to this socket; it receives a separately redacted IPC projection. The installer uses the socket only for local status and doctor evidence.

## Offline history adoption

Staging quota-aware mode creates only a signed adoption intent; it does not copy history, start a mux, or restart the app. Before a quota-aware candidate can be healthy, inspect its redacted history state with `tweaker status` or `tweaker doctor`:

- `required` means no signed intent or adoption proof is present.
- `pending offline adoption` means a signed intent matches the staged configuration, but the offline import has not run.
- `adopted` means the matching signed intent, receipt, and immutable owner proof all verify locally.
- `invalid` means an artifact is missing, unsafe, malformed, or cannot be verified.
- `mismatch` means valid signed proof is bound to a different staged configuration or adoption set.

Run `tweaker adopt-account-history` first. It is a dry run by default. Use `tweaker adopt-account-history --apply` only after the app is fully quit; apply retains the source and creates a retained pre-adoption backup before promoting the adopted owner. Adoption does not open or restart the app. A later runtime activation/restart remains a separate, explicitly confirmed step.

After that separate activation, routing is quota-aware only for new threads. Ownership stays sticky for existing threads and this is not a guarantee of exact 50/50 provider consumption.

## Authority boundary

- Do not treat source, candidate, installed, pending, or live status as authorization to activate quota-aware routing.
- Restart, live activation, authenticated canary work, dev-sync, commit, push, tag, and publication each need their own explicit authority.
- A rollback preserves local accounts, ownership records, and receipts. It stages Manual for a later restart; it does not hot-switch a running mux or delete local data.

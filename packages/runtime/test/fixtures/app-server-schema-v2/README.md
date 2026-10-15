# App-server v2 contract fixtures

These six self-contained JSON Schema documents are the exact response and
notification contracts asserted by `account-router/broker-host.test.ts`. They
were copied byte-for-byte from the isolated experimental Codex app-server
generation retained in `.plan-work/implementation-evidence/account-router/T1-v5-fixtures/schema-experimental/v2`
on 2026-09-24. No runtime, user, account, or credential data is included.
Each document contains only local `#/definitions/` references.

| File | SHA-256 |
| --- | --- |
| `ThreadReadResponse.json` | `02b097305488ce5e0cb28a494c758b1fd2cc36459996df6a2a36533000d204b9` |
| `TurnCompletedNotification.json` | `2b8db1ada05911c6e30c2abf05b1c2fc97a6ad932ef028ae8329db692ed9afbd` |
| `ThreadListResponse.json` | `559b05293484d7398fc117ee092d395e606a361db9c5f20c16f2888da8b74dd5` |
| `ThreadSearchResponse.json` | `93cf7081bdefe6aabb4fe44db322f6f044899b3fc8af85c8bc249b635e406e37` |
| `ThreadTurnsListResponse.json` | `d83b71671897cf82e0d289ab85b07e9a9989a937215d7315ef907c6e3084692d` |
| `ThreadItemsListResponse.json` | `624bc30dc1aa6bdef462cbe707289d1efa629fd051111a4de638cf1397b9659a` |

The deterministic fixture keeps ordinary tests independent of an optional
development Codex binary. Set `TWEAKERS_TEST_CODEX_BINARY` to a reviewed Codex
executable to regenerate these contracts in an isolated temporary home for
current-version acceptance.
This command creates a temporary generation and does not update these checked-in
fixtures automatically.

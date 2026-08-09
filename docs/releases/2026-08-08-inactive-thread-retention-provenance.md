# Provenance — Codex two-layer 60s inactive-thread retention (2026-08-08)

Durable record for the accepted containment candidate: renderer unsubscribes inactive
tasks after 60 s and retains zero inactive owners; backend unloads unsubscribed idle
threads after 60 s. Active, running, and followed tasks remain protected.

## Repo

| Field | Value |
| --- | --- |
| Repository | `therealityreport/tweakers`, branch `main` |
| Base commit at candidate creation | `191008d45cfc5fc8b4ebf5dea483a7cd058306fc` |
| Dirty-delta sha256 (`git diff HEAD`) at record time | `3530872456fef43d4bb428cb6069770f2c4594e3ed281ecacf13fe52a9fb7bc1` |

The working tree also carried an unrelated, uncommitted model-selection feature and
runtime-asset regeneration; only the retention scope (plus the two installer
correctness fixes below) is committed with this record.

## Candidate sources (renderer layer)

| Artifact | sha256 |
| --- | --- |
| `packages/installer/src/codex-inactive-thread-retention.ts` | `07a039d2049ca5f99cb352af607cc01169b018de1396a26cb071143760c56132` |
| `packages/installer/test/codex-inactive-thread-retention.test.ts` | `bd4ab4ed3281fd4244d065b58b55e9df5f37c6956f0fbc590fdf9ac9a7607518` |

Renderer change (minified policy in the installed bundle): `zjn = 3600*1e3 → 60*1e3`
(inactive-thread unsubscribe TTL), `Vjn = 4 → 0` (`maxInactiveOwnerThreads`).
Fingerprint-guarded (four semantic markers within a 12 000-char window), idempotent
(`already-patched` on re-run), fails closed on layout drift or multi-file matches.

## Backend layer

| Field | Value |
| --- | --- |
| Patch | `patches/codex/0.147.0-alpha.6.5-inactive-thread-unload.patch` |
| Patch sha256 | `9e27c2ff0f58011102590ed6efabd1b5779f793a2bd68918da4cf458d88c728f` |
| Change | `THREAD_UNLOADING_DELAY` 30 min → 60 s in `codex-rs/app-server/src/request_processors/thread_lifecycle.rs` |
| Upstream tag | `rust-v0.147.0-alpha.6.5` |
| Upstream source commit | `618b8e9111da9f57fe380b09d0f6516e3f343536` |
| Patched tree | `29d9e3e5ca3dc93b42cbbb515756f67105fc24cd` |
| Cargo.lock sha256 (post-normalization) | `63f5785eeafa0ee15629926603b8dfc01c5cdb8d0a1888406c976d1a1a893b02` |
| Reviewed diff sha256 | `3ffe0c78f5662a35b14e405619b00aed3f22e92d84a222de961b7ff971e2bc06` |
| Lock normalization | 135 local workspace package versions `0.0.0 → 0.147.0-alpha.6.5`; no third-party name, source, checksum, or version changed |
| Build | `CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --locked -p codex-cli --bin codex`, rustc 1.95.0 (59807616e 2026-04-14), arm64 |
| Built binary sha256 | `3c56a086cc10ce299c87c1289893070ae50b9c3e456d20c1395d6c4c610d34b1` |

## Build/test receipts (data root `~/Library/Application Support/codex-plusplus`)

| Receipt | sha256 |
| --- | --- |
| `transactions/inactive-thread-retention-20260808/accepted-build.json` (kind `tweakers-prebuilt-codex-build`, accepted 2026-08-08T23:23:27Z) | `28954d2ec1956eabae75f1a2942a66a84d8aea107b8e398a7f4b26e5b0dcd3d7` |
| `transactions/inactive-thread-retention-20260808/test-evidence.json` | `6602ce272f2dd16e16eee9a2e715e005487717f0486d6ca6104560d1f7422497` |

`test-evidence.json`'s digest equals the `receiptSha256` recorded inside
`accepted-build.json` — the chain is self-consistent.

Test evidence summary: focused Rust lifecycle test
`thread_unsubscribe_keeps_thread_loaded_until_idle_timeout` 1 passed (840 filtered);
tweakers focused retention tests 7 passed; typecheck, build, and full suite passed;
renderer canary patched the exact installed bundle and was idempotent on re-run.

## Installed app at candidate creation

ChatGPT.app `26.803.41515` (build `6321`), bundled backend Codex `0.147.0-alpha.6.5`.

## Promotion attempt history (all failed safe; live app untouched)

1. 2026-08-08T23:34Z — candidate health request expired between prepare and quit;
   stale evidence correctly refused.
2. 2026-08-09T00:47Z — app-bundle shutdown race rewrote a permission record during
   candidate copy; guard refused.
3. 2026-08-09T00:49Z — installer captured the promotion-policy surface at prepare
   start but re-read the live file at the end ("Promotion policy surface must remain
   present and semantically unchanged"); `prepare_failed status=1 phase=invalidated`.

## Installer correctness fixes committed with this record

1. `packages/installer/src/commands/install.ts` — promotion-policy preimages are now
   captured once at candidate-build start (`candidatePromotionPreimages`) and the
   live policy is drift-checked before promotion, instead of being re-fingerprinted
   after shutdown bookkeeping already moved it (root cause of attempt 3).
2. `packages/installer/src/commands/codex-source.ts` — bundled-derived receipt
   consumption resolved the candidate at
   `…/candidate/managedMcp/trustedRunner/ChatGPT.app` while build and canary write
   and record `…/candidate/ChatGPT.app`; consumption now derives the path from
   `codexSourceTransactionPaths` (single source of truth), keeping the receipt-bound
   environment lane viable. Regression test added in
   `packages/installer/test/codex-source-command.test.ts`.

## Headroom MCP route

`~/.codex/config.toml` `[mcp_servers.headroom]` disabled with `enabled = false` as
part of this deployment (only that route; all other MCP entries untouched).

| Field | Value |
| --- | --- |
| Pre-edit config sha256 | `34d032532e999fc4850ffd338be548320d9e4def77d275f1d3992dc5d9acd0fa` |
| Backup | timestamped `~/.codex/config.toml.backup-<UTC>` (recorded in the JSON sidecar once taken) |
| Post-edit config sha256 | recorded in the JSON sidecar once edited |

## Deployment lane

Prebuilt receipt lane (`tweaker prebuilt-combined-candidate prepare|promote`) driven
by the one-shot launchd helper `com.therealityreport.tweakers.retention-fix`
(`promote-after-quit.sh` v4: exact-PID quit wait → full bundle quiesce → policy-file
stability → prepare → promote → health validation → auto-reopen). Rollback floors:
app-install `pristine.app` / `last-known-good.app` / `last-known-good-runtime` and
the archive at `<data root>/backup/Codex.app`.

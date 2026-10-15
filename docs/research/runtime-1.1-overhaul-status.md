# Runtime 1.1 overhaul status — October 4, 2026

The source changes and generated packages are prepared. **The approved plan is not complete: genuine native integration and live acceptance remain blocked. No Tweakers desktop was launched, installed, or promoted.** The resumed work closed historical archival and added a fail-closed native-service startup policy; that policy establishes unavailability, not native capture support.

## Implemented source

- Revised existing owners: UI Improvements 0.3 owns Titlebar Controls and Rich Blocks; Projects 0.8 owns Thread Summary Profiles. Independent toggles remain. Valid destination settings win, malformed child values migrate safely, unsupported UI schemas remain intact, and legacy data is retained.
- Added runtime/SDK 1.1 lifecycle cancellation, tracked asynchronous cleanup, pending-start barriers, reload coalescing, invalid/duplicate manifest rejection, and shared UI-surface snapshots. A held activation prevents an overlapping reload while other initial activations can continue.
- Added isolated worker-based backend observers and explicit text/model request transforms. Queues, invocation deadlines, output sizes, and downstream buffering are bounded. Rejected transforms return an error before dispatch. Authentication, permission policy, non-text inputs, and tool results remain outside the transform contract.
- Replaced custom AppShots screenshot/clipboard/hotkey automation with an adapter to Codex's actual native services. This is source integration, not proof of successful capture or attachment.
- Repaired Accounts enrollment cleanup and User Questions shutdown cleanup. Accounts remains disabled in the installed configuration.

## Verification

Initial build, typecheck, catalog parity, and synchronization checks passed. All 11 bundled tweaks are synchronized. That initial lint run completed with **0 errors and 206 warnings**; later correction checks are listed below.

The broad package run completed 2,741 tests: 2,719 passed, seven failed, and 15 were skipped. The seven failures were repaired and passed in an 81-check affected rerun. They covered a vendor asset relocation in the retention test, the User Questions version assertion, AppShots' missing settings icon, and contract assertions affected by lifecycle wrapping and bundled owner entries. Production retention matching already supported the relocated asset.

An additional 18-check storage run passed after the final Projects migration correction. The remaining root test stages passed separately: 42 script checks, 424 tweak checks, and 87 MCP lifecycle checks. The entire `npm test` command was not repeated after these targeted repairs; unaffected package results were reused. The final build/typecheck/synchronization ran after the source repairs.

The backend checks include a real subprocess and worker: transformed text reaches the child, rejected requests never reach it, hook removal restores unchanged dispatch, and disposal closes the worker. This does not establish live native-backend compatibility.

Independent source review and targeted repair review found no remaining findings within their assigned scope. Evidence logs are retained in `/tmp/tweakers-overhaul-20261004/`.

## Resumed verification and corrections

- Eight native-policy checks passed, including current native 12947 and pristine/installed 10954 bundle fingerprints, idempotent patching, tamper rejection, disabled initial feature flags, no capture/plugin/hotkey side effects, and continued unrelated worker operation.
- Nine artifact-retention checks passed, including restored custom metadata, source changes and newly appearing consumers during verification, dangling/external historical links without dereferencing, and sparse metric-file archival.
- The complete installer test directory passed: 1,599 passed, zero failed, 15 skipped (1,614 total). Build, source/test typechecks, and catalog synchronization checks passed. Lint completed with zero errors and 212 warnings. Previous unaffected runtime, SDK, tweak, script, and MCP results remain applicable.
- Independent focused source reviews found no remaining blockers in the native guard or archive corrections. Native bootstrap behavior still requires live acceptance.
- Historical archives now use explicit macOS metadata preservation and actual restoration onto a non-executable APFS filesystem. Required metadata uses the existing rollback comparator; OS-regenerated provenance/access bookkeeping and storage-only compression representation are excluded. Exact contents, link bytes, ownership, modes, and modification times remain checked. Official-source symlink validation remains strict; only historical archive seals allow unresolved links without following them.

## Blocking native acceptance

The genuine native helper validates the caller's signing identity and trusted ancestry. The independently signed Tweakers app does not satisfy the observed trust requirement, and no supported external attachment interface for Computer History/AppShots was found. Its own native service manager otherwise spawns another helper.

The derived-only startup policy now blocks that launch path, bundled plugin reconciliation, computer-use workers, and global shortcut mutation. It masks computed availability without changing stored native settings, preserves unrelated workers, and refuses unknown vendor fingerprints before candidate construction. The existing runtime flag also prevents refreshing the canonical native helper. This resolves the unsafe duplicate-launch path in source; it does not provide native recording access.

Therefore genuine Computer/Computer History operation, AppShots capture and attachment, ten live lifecycle cycles, five-minute idle and thirty-minute workload comparisons, and final promotion remain unverified. No performance improvement is claimed.

Native ChatGPT remained PID 24712 and its capture service PID 69613, with their original start times. No Tweakers desktop process was running at the final check.

## Artifact reconciliation

The two available slots currently contain installed Tweakers build 10954 and the verified official build 13022 source retained for candidate construction. The previous local rollback was archived, restoration-verified, and retired under receipt `f32e7511-6aaa-47ed-9429-420ea699946a` before reserving the source slot. Its recovery archive remains on SHOWS DB. No derived desktop candidate has been promoted. Generated development outputs remain one rebuilt set.

Historical cleanup is complete for the eligible generations identified during this task. Both Doctor job `cefcdacf-9fbb-4aec-9e03-17f86d5cead4` (596,942,848 bytes) and `b8b09d6f-6430-40cc-b83c-19316852802c` (1,554,276,352 bytes) were archived to SHOWS DB, restored and verified on APFS, then retired locally. Their local receipts are `fb2c2d1d-341a-4181-be91-87203dd87ff3.json` and `eefa9174-5182-473a-82db-333d41374252.json` under `artifact-archives/generation-retention/`. The final retention plan had no eligible leftovers, ambiguities, or blockers.

Two stale artifact reservation device IDs were reconciled through the existing recovery function after verifying unchanged inodes, content fingerprints, and the committed promotion journal. The task's reproducible diagnostic archive and successful temporary restoration images were removed.

The user selected the supported current-official update route. The immutable manager now recognizes both vendor CLI layouts, validates the full native entry chain, retains adoption continuity separately from large archived packets, and preserves the CLI's signed metadata when capturing reduced source evidence. A subprocess pipe failure now rejects pending requests and waits for its owned child to exit instead of crashing Doctor.

The latest full installer run passed **1,711 tests, zero failures, 15 skips** (1,726 total). Build and source/test typechecks passed; lint was clean for the five files in the final CLI-context correction. A real subprocess reproduction failed with uncaught EPIPE in the earlier build and passed in the corrected build. Earlier loader/runtime/SDK/tweak checks with unchanged inputs remain applicable. Doctor completed its current-source check through the newly published manager. It refused candidate construction because Billing Analytics build `billing-analytics-5b6766c9aeca.js` is unreviewed and the retained 0.153.4 backend has four contract differences from 0.160.0, including unsupported structured history cursors. No historical approval was reused.

Available disk space was approximately 42 GiB before the original builds, 38 GiB at an earlier resumed check, and 25 GiB at the final check. These are filesystem observations, not attribution of the differences to this task. The retention rule requires a peak build-space estimate plus a 20 GiB reserve; no qualifying estimate exists for a new Rust backend build, so that build has not been started.


### Current official-source preparation corrections

- The current official source (build 13022) retains the reviewed native-service gate functions. The derived guard now validates the complete early-bootstrap and bootstrap entry chain before patching its reachable main module; unknown entry code still fails closed.
- Current vendor packages may place their CLI in `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`. Source evidence and registration recognize this layout. The derived app explicitly binds the retained registered backend before vendor startup.
- Doctor adoption can require older predecessor records after their large job packets have been archived. Retirement now preserves private, fingerprinted adoption metadata locally; Doctor reads it when the original packet is absent. Historical payloads remain archival storage, not runtime dependencies.
- The signed CLI dependency is stored with its required `Contents` metadata under a directory without an `.app` suffix; no desktop executable or framework is retained there. Older flattened CLI receipts remain readable and require fresh evidence capture from the verified original source.
- The corrected manager finished its required checks and refused candidate construction on the billing and backend compatibility findings above. Live candidate preparation and promotion remain blocked. Native Computer History, Computer Use, and AppShots remain unavailable in the derived app because the vendor service does not authorize its signing identity.

### Remaining transition work

- Review and adapt the current build's Billing Analytics patch; the new vendor module is not covered by an existing reviewed fingerprint.
- Prepare and verify a backend compatible with the current official frontend while preserving the registered shared-native history overlay. The existing resolver registration binds the custom backend identity; disabling Accounts does not remove that binding. Simply replacing the executable with the stock backend is not an accepted history transition.
- The existing source-build adapter stages a complete desktop candidate. It cannot be invoked unchanged while installed Tweakers and the retained official source occupy the two local slots. Resolve the build-space estimate and candidate-slot strategy before a large build.
- Genuine native capture still needs a vendor-supported trust/attachment route. This is independent of the billing and backend blockers.
- After those blockers are resolved: candidate construction, guarded Tweakers-only promotion, live lifecycle and performance acceptance, and final artifact reconciliation.

The final process check found no Tweakers desktop or Doctor worker. Native ChatGPT remained PID 24712 with its original October 3 start time. No additional backend build, live history transition, native restart, or desktop promotion was performed.

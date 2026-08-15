# Ask User Questions Tweaker comprehensive audit

- Audit date: 2026-08-11 EDT
- Repository: `/Users/thomashulihan/Projects/tweakers`
- Baseline: `ce4021eb25a5b887ac86d455e8a86fb904474390`
- Mode: read-only source, generated-state, installed-payload, runtime-status, security, privacy, UX, accessibility, test, dependency, and documentation audit
- Feature route: not applicable because no change was requested. If remediation is authorized, the correct route is **revise the existing `co.tweakers.user-questions` tweak**, preserving its ID and compatible data while bumping its version monotonically.
- Restarts/promotions: none
- Source or generated code changed: none

## Executive assessment

The tweak has a strong foundation: explicit terminal outcomes, bounded public inputs, task-bound resumable drafts, redacted diagnostics, authenticated renderer routing, copy-first migration, rollback checks, and unusually broad focused tests. Canonical source, generated runtime payload, and the currently installed payload are byte-identical for every shipped file.

The audit accepted **20 findings: 16 medium and 4 low**. No critical or high-severity defect was demonstrated. The most important defects are concrete rather than speculative:

1. A valid JSON value such as `null` crashes the MCP process instead of producing a controlled protocol error.
2. Text typed into an Other field can be lost when Escape or Command/Ctrl+Enter is used before blur.
3. The Close control is inert on the saved-draft decision and submitted-recovery screens.
4. A stale draft lock can strand a round indefinitely, while quarantined draft files escape the advertised retention limits.
5. The runtime starts a replacement main-process tweak without awaiting this tweak's asynchronous teardown.

Security review also found medium-risk hardening gaps in durable rollout-receipt validation, MCP admission control, and descriptor-atomic private-file reads. These are local privileged-boundary issues, not evidence of a remote exploit or leaked credential.

## Review team and accountability

| Lane | Reviewer route | Scope | Status |
|---|---|---|---|
| Security and privacy | Lorentz — `gpt-5.6-sol`, high | Broker, MCP abuse boundaries, drafts, policy mutation, receipts, private files | Completed read-only |
| Correctness and architecture | Leibniz — `gpt-5.6-terra`, xhigh | State machine, error handling, lifecycle, architecture, performance | Completed read-only |
| Tests, UX, accessibility | Locke — `gpt-5.6-terra`, xhigh | Keyboard/focus behavior, semantic DOM, coverage and acceptance gaps | Completed read-only |
| Integration and parity | Cicero — `gpt-5.6-terra`, high | Canonical/generated/installed parity, runtime/installer integration, dependencies, docs | Completed read-only |
| Final vetting and synthesis | Primary agent | Independent reproduction, severity calibration, deduplication, final report | Completed |

Assignment records are in `advisor-plans/assignments/`. Every reviewer reported its actual route and changed no repository source or live state.

## Evidence ladder

| Layer | Result | What it proves |
|---|---|---|
| Canonical source | Inspected at the baseline commit | Current implementation and contracts |
| Generated payload | Exact match to canonical source, excluding the intentionally source-only `test/` directory | Synchronization parity |
| Catalog | `store/index.json` and runtime catalog agree on `co.tweakers.user-questions` v0.6.1 | Catalog parity |
| Focused tests | 139/139 canonical tests and 97/97 direct runtime/installer integration tests pass | Source and integration contracts exercised by those suites |
| Installed payload | Exact match to generated payload | Installed bytes are current |
| Installed runtime | Tweakers 1.0.0 reports patched integrity OK; 2/2 optional renderer tweaks active | General runtime integrity, not User Questions exposure |
| MCP exposure | Not active in the current config/task: tweak config says disabled and no User Questions MCP section is present | Current task cannot serve as a visible acceptance oracle |
| Visible/accepted UI | Not tested | A fresh enabled task, real host UI, keyboard/zoom/screen-reader pass, and user acceptance remain unproven |

The repository's source checks are healthy, but they do not prove the actual visible popup/card in a fresh enabled task.

## Findings summary

| ID | Severity | Confidence | Effort | Finding |
|---|---:|---:|---:|---|
| UQ-COR-01 | Medium | High | S | Non-object JSON crashes the MCP process |
| UQ-SEC-02 | Medium | High | M | Interactive MCP calls and stdout backpressure are unbounded |
| UQ-COR-03 | Medium | High | M | Abandoned per-draft locks can strand a round forever |
| UQ-PRI-04 | Medium | High | S | Quarantined drafts bypass privacy-retention and storage bounds |
| UQ-UX-05 | Medium | High | S/M | Keyboard navigation can discard newly typed Other text |
| UQ-UX-06 | Medium | High | S | Close/Escape is invalid on recovery-phase screens |
| UQ-LIF-07 | Medium | Medium | M | Runtime reload does not await asynchronous tweak teardown |
| UQ-A11Y-08 | Medium | High | S | Normal rerenders lose keyboard focus |
| UQ-A11Y-09 | Medium | High | S | Blank Other validation focuses the already-selected radio |
| UQ-A11Y-10 | Medium | High | S | Permission profile radiogroup lacks the radio keyboard contract |
| UQ-SEC-11 | Medium | High | M | Resumed rollout receipts are not rebound to fresh canonical paths |
| UQ-SEC-12 | Medium | High | M | Private-file reads have pathname substitution windows |
| UQ-TEST-13 | Medium | High | M | No disposable-candidate visible-host acceptance receipt exists |
| UQ-REL-14 | Medium | High | S/M | Tweak version regressed from 0.6.3 to 0.6.0 and is now 0.6.1 |
| UQ-DOC-15 | Medium | High | S | Public folder, ownership, and MCP-name docs contradict implementation |
| UQ-DEP-16 | Medium | High | S | The dev-only Electron lock is within three current advisory ranges |
| UQ-SEC-17 | Low | High | S | Policy files, receipt arrays, and transaction scans lack explicit bounds |
| UQ-DX-18 | Low | High | S | Canonical tweak JavaScript is outside the lint gate |
| UQ-ARCH-19 | Low | High | M | The carrier wire contract is duplicated across processes |
| UQ-DOC-20 | Low | High | S | Policy docs repeat a section and the tool description misstates fallback shape |

## Detailed findings

### UQ-COR-01 — Non-object JSON crashes the MCP process

- **Evidence:** `tweaks/user-questions/mcp-server.js:76-80` parses any valid JSON, then immediately dereferences `message.method` without requiring a non-null object.
- **Direct reproduction:** `printf 'null\n' | node tweaks/user-questions/mcp-server.js` exits 1 with `TypeError: Cannot read properties of null (reading 'method')` at line 80.
- **Impact:** One malformed JSON-RPC line terminates the helper and can end active question rounds instead of returning a controlled invalid-request response.
- **Recommendation:** Validate a plain, non-null object before dispatch. Add child-process tests for `null`, arrays, strings, numbers, booleans, missing methods, and duplicate request IDs.
- **Fix risk:** Low.

### UQ-SEC-02 — Interactive MCP calls and stdout backpressure are unbounded

- **Evidence:** `mcp-server.js:40-41` creates unbounded pending-request and active-call maps; line 70 launches every message concurrently; lines 135-144 admit every valid call; lines 439-455 create another pending request and timer; line 483 ignores the return value of `outputStream.write`. The default display timeout is five minutes (`:27`) and can be configured as high as ten minutes (`:1015-1018`).
- **Impact:** A buggy or hostile local MCP client can allocate many prompts, timers, broker connections, draft operations, and queued stdout bytes. The process has per-message byte limits but no concurrency or output-queue limit.
- **Recommendation:** Reject duplicate outstanding IDs, cap active calls and client requests, define a small queue or capacity error, and honor stream backpressure. Verify that exceeding a cap opens no additional forms and leaks no timers or broker peers.
- **Boundary:** This is a local availability issue at a trusted client boundary, not a demonstrated unauthenticated network attack.

### UQ-COR-03 — Abandoned per-draft locks can strand a round forever

- **Evidence:** `draft-store.js:351-364` creates an exclusive `.lock` and removes it only in `finally`. `listDraftEntries()` at `:231-244` enumerates only live `.json` records, so pruning never considers lock files.
- **Direct reproduction:** A temporary saved draft with its corresponding `.lock` left behind causes `load()` to return `revision_conflict`; the lock survives pruning.
- **Impact:** A crash or forced process termination during save/load/discard can make that draft permanently unusable even when its bytes and resume token are valid.
- **Recommendation:** Store bounded lock-owner metadata and reclaim only after a conservative age plus owner-liveness check, or surface a distinct recoverable stale-lock status. Add crash-simulation coverage.
- **Fix risk:** Medium because an over-eager cleanup must not steal a live lock.

### UQ-PRI-04 — Quarantined drafts bypass privacy-retention and storage bounds

- **Evidence:** Normal drafts are limited to 20 records, 2 MiB total, 256 KiB each, and 30 days (`draft-store.js:8-11`). Quarantine renames a record to `.json.corrupt.<timestamp>.<suffix>` (`:377-384`), while retention enumerates only names ending exactly in `64hex.json` (`:231-244`).
- **Direct reproduction:** After corrupting a temporary draft and advancing the test clock by 60 days, `prune()` still leaves the quarantine file. `inspect()` reports zero drafts and zero bytes while that file remains.
- **Impact:** Partial answers and Other text may outlive the documented 30-day boundary, and repeated corruption can create unbounded private disk use invisible to status.
- **Recommendation:** Delete quarantines when recovery is unnecessary, or give them separate strict age, count, and byte budgets. Never parse or log their content during cleanup.
- **Fix risk:** Low.

### UQ-UX-05 — Keyboard navigation can discard newly typed Other text

- **Evidence:** The textarea persists only on `change`/blur (`index.js:506-520`). The card handles Escape and Command/Ctrl+Enter directly on `keydown` (`:764-772`) and sends `cancel_save`, `next`, or `submit` before a focused textarea necessarily emits `change`. Every action rerenders by replacing the card children (`:332-351`, `:635-663`). Current tests manually dispatch `change` and await it before navigation (`test/index.test.js:51-57`).
- **Impact:** Escape can save a draft without the just-typed text. Command/Ctrl+Enter can validate stale empty state, rerender the field, and erase the text. Pointer navigation can also race the asynchronous blur action and require another click when the intended button is disabled as busy.
- **Recommendation:** Keep textarea text in a local model on `input` and synchronously flush that model before every navigation/cancel action, then persist through the existing reducer. Add real event-order tests for Escape, Command/Ctrl+Enter, and a single pointer click after typing.
- **Fix risk:** Low to medium; avoid one IPC write per keystroke unless deliberately debounced.

### UQ-UX-06 — Close/Escape is invalid on recovery-phase screens

- **Evidence:** The shared header always renders “Close and save” (`index.js:354-366`). It is used by the saved-draft choice (`:369-390`) and submitted-recovery view (`:582-588`). Saved drafts begin in phase `cancelled` (`test/index.test.js:800-804`), while `cancel_save` is allowed only in `question` or `review` (`round-state.js:121-127`).
- **Direct reproduction:** A second `cancel_save` on a cancelled state returns `cancel_save is not allowed during cancelled`.
- **Impact:** The visible Close button and Escape key no-op on “Continue your saved answers?”; the same invalid action appears on “Your choices are saved.” Users are forced into Resume/Start over or Retry even though the UI advertises dismissal.
- **Recommendation:** Make the header action phase-specific. On a draft-choice screen, dismiss the host form without mutating or deleting the existing draft. On submitted recovery, preserve the committed state and expose a valid retry/dismiss contract. Add tests for both button and Escape behavior.
- **Fix risk:** Low.

### UQ-LIF-07 — Runtime reload does not await asynchronous tweak teardown

- **Evidence:** User Questions `stop()` is async and awaits broker/session cleanup (`index.js:42-48`; `main-broker.js:257-272`). The runtime types `stop` as `() => void` and calls it without awaiting (`packages/runtime/src/main.ts:1369-1372`, `:4138-4152`). The reload sequence then clears module cache and loads replacements immediately (`packages/runtime/src/tweak-lifecycle.ts:174-208`).
- **Impact:** Hot reload can overlap old broker/socket/IPC cleanup with new registration. The ignored Promise is certain; an actual collision depends on scheduling, which is why confidence in runtime impact is medium.
- **Recommendation:** Change the lifecycle contract to `void | Promise<void>`, await all teardown before cache eviction, and use a bounded timeout with explicit health reporting. Add a test that holds old IPC ownership until teardown resolves.
- **Fix risk:** Medium because this changes the shared runtime lifecycle contract.

### UQ-A11Y-08 — Normal rerenders lose keyboard focus

- **Evidence:** `renderSession()` replaces the complete card subtree (`index.js:332-351`). `sendAction()` rerenders after ordinary Next, Back, Edit, Review, and details actions but restores focus only for validation errors (`:635-663`). Resume already demonstrates a heading-focus mechanism (`:381-388`).
- **Impact:** Keyboard and screen-reader users can lose their active element and reading position after each step transition.
- **Recommendation:** Define an action-to-focus contract: next heading/first answer after navigation, the updated disclosure button after details, and the exact invalid control after failure. Cover it in semantic tests and the real candidate host.
- **Fix risk:** Low.

### UQ-A11Y-09 — Blank Other validation focuses the already-selected radio

- **Evidence:** When any question error exists, every input and textarea is marked invalid (`index.js:414-421`). The focus selector searches inputs before textareas (`:1144-1146`). The current test explicitly expects focus on the radio (`test/index.test.js:258-273`).
- **Impact:** For “Enter an Other response,” focus lands on a correct, selected radio instead of the text field requiring correction.
- **Recommendation:** Return or derive a structured validation target, mark the failing textarea as invalid, and focus it first. Preserve the normal missing-choice focus behavior separately.
- **Fix risk:** Low.

### UQ-A11Y-10 — Permission profile radiogroup lacks the radio keyboard contract

- **Evidence:** The settings control declares `radiogroup` and `radio` roles (`index.js:886-905`) but implements only click and `aria-checked` changes (`:912-928`). It has no arrow-key navigation, roving tab stop, or explicit focus-visible class, unlike ordinary action buttons (`:1177-1184`).
- **Impact:** The control advertises radio semantics but does not behave like a radio group for keyboard users.
- **Recommendation:** Prefer native radio inputs with labels. Otherwise implement one tab stop, ArrowUp/Down/Left/Right, Home/End, Space, and visible focus, with keyboard tests.
- **Fix risk:** Low.

### UQ-SEC-11 — Resumed rollout receipts are not rebound to fresh canonical paths

- **Evidence:** `readUserQuestionsRolloutReceipt()` checks file ownership/mode/size and a few top-level fields but not nested path surfaces, tracked files, archive relationships, or fingerprints (`packages/installer/src/user-questions-transaction.ts:339-361`). Install reuses that persisted object directly (`packages/installer/src/commands/install.ts:1299-1308`). Commit and rollback later trust receipt paths for recursive removal, rename, and copy (`user-questions-transaction.ts:237-272`, `:327-335`, `:480-495`).
- **Impact:** A coherent but corrupted/tampered owner-only receipt can redirect resumed cleanup or rollback away from the expected User Questions roots. Mode 0600 lowers exposure but does not make a durable receipt safe authority for recursive filesystem operations.
- **Recommendation:** Parse the complete nested schema, reconstruct canonical options from current roots, and require exact path/relationship equality before every resumed phase. Add tampered-path, nested-shape, stale-root, and symlink tests.
- **Fix risk:** Medium because recovery and idempotency behavior must remain valid.

### UQ-SEC-12 — Private-file reads have pathname substitution windows

- **Evidence:** Draft, install-secret, broker-metadata, and policy reads validate with `lstat(path)` then reopen by pathname (`draft-store.js:173-189`, `:303`; `broker-protocol.js:294-306`; `policy-state.js:883-900`). The broker route-key reader already shows the safer `O_NOFOLLOW` + `fstat` + descriptor-read pattern (`main-broker.js:408-445`).
- **Impact:** A same-UID concurrent replacement can swap an inode between validation and read. Private parent directories reduce reachability, but the code's promised link/owner checks are not descriptor-atomic.
- **Recommendation:** Centralize a bounded no-follow descriptor reader that validates type, owner, mode, size, and inode on the opened descriptor, then reuse it for all private state.
- **Fix risk:** Medium because it touches compatibility and recovery code paths.

### UQ-TEST-13 — No disposable-candidate visible-host acceptance receipt exists

- **Evidence:** The semantic DOM models styles as plain properties and has no layout engine, viewport geometry, media-query evaluation, assistive-technology tree, or native event behavior (`tweaks/user-questions/test/semantic-dom.js:15-33`, `:112-154`). The example and main guide explicitly say source tests are not visual/installed proof (`examples/README.md:29-48`; `README.md:101-103`).
- **Impact:** Passing tests do not prove owned-card attachment, generic fallback visibility, actual keyboard event order, light/dark layout, narrow width, reduced motion, 200% zoom, or screen-reader behavior in the current host.
- **Recommendation:** Turn the documented matrix into a disposable-candidate acceptance receipt covering owned and fallback paths, Skip/Other, Back/Edit, Resume/Start over, review/submit, one bounded correction, display failure/retry, keyboard focus, screen reader, themes, narrow width, reduced motion, and 200% zoom.
- **Boundary:** This audit did not restart or promote the live app.

### UQ-REL-14 — Tweak version regressed and has no monotonic-history gate

- **Evidence:** Commit `3cc6d26` contains manifest version 0.6.3. Commit `266f00f` changed it to 0.6.0, and `f48f59e` later changed it to the current 0.6.1. The cross-lane test now freezes 0.6.1 (`packages/installer/test/user-questions-cross-lane.test.ts:43-48`) rather than checking history. The store UI treats any installed/catalog inequality as an update (`packages/runtime/src/preload/settings-injector.ts:4448-4460`, `:4841-4853`).
- **Impact:** Any development or installation that saw 0.6.3 can be presented with 0.6.1 as “latest,” allowing accidental downgrade semantics and confusing receipts/cache comparisons.
- **Boundary:** No tag containing the 0.6.3 commit was found, so this report does not claim that 0.6.3 was a public release.
- **Recommendation:** On the next authorized change, choose a version above the historical maximum (at least 0.6.4), use directional semver comparisons, and add a history/release check that rejects decreases.
- **Fix risk:** Low to medium because version repair must align catalog, package, generated assets, receipts, and release history.

### UQ-DOC-15 — Public folder, ownership, and MCP-name docs contradict implementation

- **Evidence:** Root `README.md:276-278` says bundled IDs have matching `tweaks/co.tweakers.*` folders, but the canonical folder is `tweaks/user-questions`. `CONTRIBUTING.md:13` says default tweaks live in separate repositories and must not be vendored, contradicting this bundled source. `docs/tweaks/mcp.md:42-45` says `co.bennett.project-home` becomes `project-home`; implementation and its test preserve the full namespace (`packages/runtime/src/mcp-sync.ts:611-617`; `packages/runtime/test/mcp-sync.test.ts:25-29`).
- **Impact:** Maintainers can create the wrong layout, misunderstand bundled ownership, or configure the wrong MCP server name.
- **Recommendation:** Document actual folder ownership separately from reverse-DNS IDs, replace the obsolete no-vendoring statement, and update naming examples from the tested implementation.
- **Fix risk:** Low.

### UQ-DEP-16 — The dev-only Electron lock is within three advisory ranges

- **Evidence:** `packages/runtime/package.json` declares Electron `^41.3.0`; the lock resolves 41.3.0. Current `npm audit --workspaces --include-workspace-root --json` reports the package as high overall. GitHub's reviewed Electron advisories show fixes at 41.4.0, 41.9.1, and 41.10.3 respectively: [GHSA-v3j7-r9gq-3gjw](https://github.com/advisories/GHSA-v3j7-r9gq-3gjw), [GHSA-r4w5-6pfg-jxp5](https://github.com/advisories/GHSA-r4w5-6pfg-jxp5), and [GHSA-9f4c-93c8-jc8g](https://github.com/advisories/GHSA-9f4c-93c8-jc8g).
- **Scope:** `npm audit --omit=dev` is clean. User Questions imports no Electron package. The one custom protocol found sets both `supportFetchAPI: true` and `corsEnabled: true`, so the first advisory's stated vulnerable condition is not evidenced in that path.
- **Impact:** This is dependency hygiene for local candidate/health-probe tooling, not evidence of a shipped User Questions vulnerability.
- **Recommendation:** Move the lock to at least 41.10.3 through the approved dependency workflow, then rerun audit/typecheck/tests and an isolated candidate protocol/renderer probe.
- **Fix risk:** Medium because Electron minors can change health-probe behavior.

### UQ-SEC-17 — Policy files, receipt arrays, and transaction scans lack explicit bounds

- **Evidence:** `policy-state.js:423-450` scans every matching transaction file; `:547-565` walks every persisted task record; `:691-725` accepts arrays without count ceilings; `:883-900` reads entire files before parsing.
- **Impact:** Corrupt or pathologically large owner-only state can synchronously consume memory and block the Electron main loop.
- **Recommendation:** Add source/artifact byte ceilings, target/evidence/container count limits, and a bounded directory scan that fails closed with a stable recovery status.
- **Fix risk:** Low.

### UQ-DX-18 — Canonical tweak JavaScript is outside the lint gate

- **Evidence:** `package.json:22` runs ESLint only over `packages/*/src` TypeScript, and `eslint.config.js:5-27` defines rules only for that surface. All canonical User Questions production code is CommonJS JavaScript under `tweaks/user-questions/`.
- **Impact:** The source of truth lacks static checks for accidental globals, unreachable code, duplicate cases, debugger statements, and similar hygiene failures.
- **Recommendation:** Add a CommonJS ESLint override for canonical tweak JS, explicitly configure Node/test globals, establish a deliberate warning baseline, and include it in the focused command.
- **Fix risk:** Low.

### UQ-ARCH-19 — The carrier wire contract is duplicated across processes

- **Evidence:** Carrier nonce/Other prefixes, Skip/Other values, and helper naming are repeated in `index.js:4-12`, `:1220-1233`, `mcp-server.js:23-32`, `:995-1035`, and `broker-protocol.js:14`.
- **Impact:** A future change can leave renderer and MCP code generating different field names while their isolated tests still pass.
- **Recommendation:** Extract only dependency-light protocol constants and pure field-name helpers into a shared CommonJS module, with a cross-process contract test.
- **Fix risk:** Low.

### UQ-DOC-20 — Policy docs repeat a section and the tool description misstates fallback shape

- **Evidence:** `tweaks/user-questions/README.md:57-75` repeats both permission-profile descriptions and the Preview/Apply/Restore introduction. `mcp-server.js:805-808` calls the round “a single standard form,” while the implemented generic fallback deliberately asks one real question per form sequentially (`:153-195`, `:197-235`).
- **Impact:** The duplication invites drift, while the public tool description can mislead agents about how many host forms appear under fallback.
- **Recommendation:** Remove the repeated policy paragraph and describe the experience as one bounded round with an enhanced owned card or sequential one-question standard forms.
- **Fix risk:** Low.

## Suggested product and architecture improvements

These are design directions, not accepted defects:

1. **Privacy-preserving delivery health:** expose bounded status-only receipts distinguishing user cancellation, hidden/unacknowledged UI, generic fallback, and route invalidation. Never retain question text, answers, Other text, raw routes, or tokens.
2. **Versioned host-adapter conformance:** define minimum semantic host capabilities, a version/capability contract, and a reusable conformance fixture so host upgrades fail with a clear compatibility result instead of opaque fallback.
3. **Finish native visual parity:** prior task context called for a more native decision flow. Current source still renders a custom progress bar and heavily bordered option tiles (`index.js:399-458`). Reconfirm that direction before implementation because the prior context may be stale; then validate it in the actual host rather than only the semantic DOM.
4. **Operational process accounting:** 16 User Questions MCP helper processes were observed under one app-server parent while the tweak is currently disabled. The MCP lifecycle monitor is healthy and the processes may legitimately belong to active/cached tasks, so this is not a finding. Add task/process correlation and age metrics before deciding whether cleanup behavior needs revision.

## Tested strengths and rejected candidates

- **Explicit ownership works:** `submitted`, `cancelled`, and retryable `display_failed` remain distinct; empty success is rejected.
- **Required-question Skip is intentional:** Skip is a real answer state, not a validation bypass.
- **Sequential generic fallback is intentional:** one real question per standard form avoids an opaque whole-round fallback.
- **Broker routing is strong:** exact renderer/host/conversation binding, constant-time secret comparison, nonce consumption, bounded replay state, and redacted diagnostics were found.
- **Policy mutation is explicit:** ordinary startup and MCP reconciliation observe policy but do not apply/restore it. Preview tokens bind source and mutation shape; Apply and Restore are separate.
- **No credential/log leak was found:** question text, answers, Other text, raw task IDs, resume tokens, and broker secrets are excluded from reviewed diagnostic calls.
- **Electron is not a shipped User Questions finding:** it is dev-only here and the production dependency audit is clean.
- **Multiple helper processes are not yet a leak:** current evidence lacks active-task/process correlation and shows a healthy lifecycle monitor.
- **The current policy is not drifted:** live read-only status is `none`, with no transaction or restart requirement. Older saved context describing drift is stale relative to this check.
- **A general desktop-update failure is not attributed to this tweak:** runtime status marks it nonblocking, while User Questions payload parity is exact.

## Verification record

| Check | Result |
|---|---|
| `npm run test:user-questions` | PASS — 139 tests, 0 failed |
| Direct User Questions runtime/installer test set | PASS — 97 tests, 0 failed |
| `npm run typecheck` | PASS |
| `npm run lint` | Exit 0 — 0 errors, 135 repository warnings; canonical tweak JS not covered |
| `npm run sync:tweaks -- --check` | PASS — 11 tweaks current |
| `npm run check:tweak-catalog` | PASS |
| Source vs generated shipped payload | PASS — exact; source-only `test/` intentionally excluded |
| Generated vs installed User Questions payload | PASS — exact |
| Malformed MCP input reproduction | Confirmed process exit 1 on `null` |
| Stale lock/quarantine temporary reproduction | Confirmed `revision_conflict`; quarantine remains after simulated 60 days |
| Recovery-screen reducer reproduction | Confirmed second `cancel_save` is rejected during `cancelled` |
| `npm audit --workspaces --include-workspace-root --json` | Nonzero — Electron dev dependency advisories |
| `npm audit --workspaces --include-workspace-root --omit=dev --json` | PASS — zero production vulnerabilities |
| `node bin/tweaker.js status` | Installed 2026-08-11; Tweakers 1.0.0; patched integrity OK; 2/2 optional renderer tweaks active |
| MCP lifecycle deep status | PASS — healthy/unchanged |
| Current policy transaction status | `none`; no restart required |

Full `npm test` and `npm run build` were intentionally not run because they generate build output and this was a read-only advisor audit. Their absence is a verification gap, not a failing result.

## Recommended remediation sequence

1. **User-visible correctness first:** UQ-COR-01, UQ-UX-05, UQ-UX-06, UQ-COR-03, and UQ-PRI-04, with regression tests and a monotonic version above 0.6.3.
2. **Lifecycle and privileged boundaries:** UQ-LIF-07, UQ-SEC-02, UQ-SEC-11, UQ-SEC-12, and UQ-SEC-17.
3. **Keyboard and accessibility:** UQ-A11Y-08 through UQ-A11Y-10, preferably using native controls where possible.
4. **Release/tooling clarity:** UQ-REL-14, UQ-DOC-15, UQ-DEP-16, UQ-DX-18, UQ-ARCH-19, and UQ-DOC-20.
5. **Acceptance last:** run the full source/build suite, generate only through `npm run sync:tweaks`, then use a disposable candidate for UQ-TEST-13. A live restart or promotion remains a separate explicit decision.

No implementation plans were created because the audit has not yet been narrowed to user-selected findings.

## Preservation and limitations

- No app was quit, restarted, relaunched, replaced, promoted, or rolled back.
- No tweak, policy, Codex config, installed file, process, provider, Git branch, index, commit, tag, or release was mutated.
- Audit-created files are confined to `advisor-plans/`.
- Pre-existing modified generated/native files were preserved untouched:
  - `packages/installer/assets/runtime/native/tweaker_native_host.node`
  - `packages/installer/assets/runtime/runtime-fingerprint.json`
  - `packages/installer/assets/swap-helper/Tweakers Swap Helper.app/Contents/MacOS/Tweakers Swap Helper`
- The older `.full-review/state.json` and unrelated `plans/` work were not resumed or modified.


# Universal Menu Bar manager contract and safe Portless integration

## Status and decision record

- **Feature route:** revise the existing Tweakers runtime/installer boundary. The manager contract belongs to Tweakers' existing repair, update, mode, and environment lifecycle; it is not a tweak.
- **Plan state:** **IN PROGRESS.** The status-only Tweakers provider, immutable descriptor publication, and Menu Bar host/adapter milestone is complete at source/generated-artifact/build level. Live installation and every action family remain deferred; Program B is out of scope for this execution.
- **Repository baseline:** Tweakers `c947e79d20dd30aa14fd9d318a45464f1b306890`; Menu Bar `f8a0e9f2dc77b8162ab1d7b3baef9a3e6c4a5088`. Both workspaces contain unrelated local work that must be preserved.
- **Portless baseline:** installed CLI and installed Codex plugin are `0.15.6`; a fresh registry lookup on 2026-08-27 resolved npm `latest` to the same exact release, with `dist.integrity` `sha512-uOAwWLF32rmyEGFASzSO0VOaqb/AQxFCCzyZbPGd82UNNOfIEvc09zy92nroNibE5HNfzV4oVB0ObKbPXgkM9A==`. No Portless update is required. Treat this version-plus-integrity pair as the tested pin, recheck both immediately before any future Program B implementation, and stop on any drift rather than silently widening to a newer release.
- **Live-state boundary:** this plan does not authorize app restart, live promotion, helper installation, sudoers mutation, route pruning, or project migration.

### Maintainer-only launcher signing and rotation

- CI and the release workflow never create a private signature. They verify the committed canonical launcher, its exact identifier/arm64/leaf/designated-requirement policy, and byte equality with the installer copy.
- A maintainer who has the pinned signing identity may run `npm run build:manager-launcher:release`. This is the only publisher-launcher signing path; it fails closed unless exactly one identity has the policy's pinned certificate-leaf SHA-1. A same-name or replacement certificate is not accepted.
- The private key and any recovery backup stay outside Git. Neither the repository, generated installer assets, CI logs, nor a release archive may contain private-key material.
- The canonical policy is `packages/native-host/manager-signing-policy.json`; its generated installer copy is `packages/installer/assets/manager-launcher/signing-policy.json`. The descriptor runtime reads the generated copy, and release verification rejects byte drift between the two.
- Signer rotation is deliberate, never an in-place fallback: obtain explicit approval, create the replacement identity and securely back it up outside Git, update the exact policy leaf/designated requirement, rebuild and verify the canonical launcher, regenerate the installer assets, and require host trust reapproval for the new designated requirement before any descriptor/host use. Do not silently accept old trust or a same-name signer.

## Outcome

The long-term design would deliver one universal Menu Bar host that discovers narrow manager modules without learning each product's internals. This in-progress execution records only the completed status-only Tweakers milestone:

1. Tweakers owns a versioned, side-effect-free status contract. No action adapter is enabled in this execution.
2. Menu Bar owns discovery trust, rendering, confirmation UI, timeouts, cancellation, and process isolation.
3. A future Portless Manager remains a separate, unstarted program and is not part of this execution.
4. Project start/stop and router mutation remain out of scope until their authority, lifecycle, and privilege model have an independently approved design.

This replaces the earlier plan's direct jump to broad Portless control and its assumption that the current privileged helper could be reused safely.

## Scope

### Program A — status-only provider/host milestone complete; actions and live promotion deferred

- Completed: pure Tweakers status collection with no directory creation, repair, reconciliation, launchd mutation, process launch, or receipt write.
- Completed at source/build level: publisher-owned immutable descriptor publication, separately managed Menu Bar trust, bounded status invocation, and read-only universal-host adoption.
- Deferred: every Manager action family and installed/running Menu Bar promotion evidence.
- Completed source/generated verification never authorizes installation, relaunch, or live promotion.

### Program B — out of scope

- No Portless Manager code, UI, route inspection, mutation, project declaration work, or helper execution is authorized by this in-progress Program A workstream.
- Program B can be reconsidered only through a new explicit scope/authorization decision and a freshly verified plan artifact.

### Non-goals

- A general plugin marketplace or arbitrary executable discovery.
- Shell commands embedded in descriptors.
- Treating a caller-supplied timestamp as approval.
- Moving Tweakers' `reload-tweaks` in-process runtime operation into an installer CLI.
- Replacing, quitting, or relaunching Codex/ChatGPT during implementation.
- Reusing the current passwordless Portless helper or sudoers entry for new functionality.

## Current reality to preserve

### Tweakers

- `environment status --observe --json` is the closest status seam, but its call graph must be audited so the manager path cannot create paths or reconcile state.
- `mode status --json` currently calls `ensureUserPaths()` and therefore is not a valid read-only primitive without refactoring.
- The installer already has a bounded JSON CLI launcher and typed IPC; extend those seams rather than adding an ad hoc process model.
- `run-tweaker-update` can resolve the recorded source-root CLI. The contract must specify exactly which artifact is invoked for each action and must not assume the managed runtime in every case.
- Generated files under `packages/installer/assets/runtime/` are synchronized output. Never edit them by hand.
- Missing-sidebar probing is already implemented at the current baseline and is not plan 008 work.

### Menu Bar

- Existing Tweakers and Portless code contains product-specific status/action logic. Migration must preserve current behavior until each replacement has passed focused tests.
- The Menu Bar checkout is dirty in overlapping files. Every implementation task must record a baseline diff and preserve it; no reset, stash, blanket formatter, or broad rewrite is allowed.
- Menu Bar may trust a module, but a module publisher must not be able to grant or delete that trust.

### Portless

- `portless doctor` on the implementation baseline reports `0.15.6`, Node.js `26.5.0`, a healthy HTTPS proxy on port 443, two active routes, and one stale route. npm `latest` independently resolves to `0.15.6` with the exact integrity recorded above. The stale route is evidence, not permission to prune it.
- The current passwordless helper/sudoers path ultimately executes `/opt/homebrew/bin/portless`, which resolves through a user-writable Homebrew global package path. Executing that chain as root is a privilege-escalation boundary and is prohibited for this plan.
- Existing project declarations are inconsistent: Menu Bar, THB-BBL, and RobinHoodex use root declarations; TRR's declaration is nested. Migration needs explicit per-project approval and is not implied by this plan.

## Contract v1

### 1. Publisher descriptor and host trust are separate

The publisher writes a descriptor containing only declarative metadata:

```json
{
  "schemaVersion": 1,
  "managerId": "com.thomashulihan.tweakers",
  "displayName": "Tweakers",
  "protocolVersion": 1,
  "executable": "/absolute/path/to/immutable-launcher",
  "publisher": "com.thomashulihan.tweakers",
  "updatedAt": "RFC3339"
}
```

The descriptor must not contain a shell string, environment overrides, arguments supplied by another manager, or a trust decision. Menu Bar keeps an independent allowlist keyed by `managerId` and expected publisher identity.

Before invocation, Menu Bar validates:

- descriptor schema, duplicate keys, size, and canonical manager ID;
- absolute executable path and resolved realpath;
- file owner, mode, and every ancestor against group/world-writable replacement;
- expected publisher or code-signing identity where an immutable native launcher is used;
- protocol compatibility and an exact executable identity captured for the request.

On first discovery, a module is untrusted and cannot execute. Menu Bar shows the manager ID, publisher, resolved path, signing identity, executable SHA-256, and requested protocol; an explicit user confirmation creates `~/Library/Application Support/Menu Bar/manager-trust.json` with owner-only directory permissions and file mode `0600`. The record binds manager ID, expected publisher/signing requirement, resolved path policy, protocol range, and either (a) a designated-requirement/code-signing identity for an immutable native launcher or (b) the exact executable digest. Unsigned/script launchers require exact-digest trust and reapproval after every digest change. A signing-identity trust may accept an update only when the same designated requirement and manager ID validate. Revocation is available only through Menu Bar settings and disables invocation before removing the trust record.

Tweakers may publish, update, or remove its descriptor. It may not add, change, or remove Menu Bar trust. Descriptor removal immediately disables discovery but deliberately preserves the host trust choice until the user revokes it. The v1 threat model prevents cross-manager confusion, unexpected executable replacement, and stale-state actions; it does not claim isolation from a fully compromised same-user account.

### 2. Universal manager protocol (status complete; actions reserved)

Invocation is argv-only and always carries a host-generated UUID:

```text
<manager> status --request-id <uuid> --json
<manager> prepare --request-id <uuid> --operation-id <uuid> --action <fixed-id> --state-token <sha256> --expires-at <rfc3339> --json
<manager> execute --request-id <uuid> --operation-id <uuid> --json
<manager> cancel --request-id <uuid> --operation-id <uuid> --json
```

Never invoke through a shell. The completed milestone accepts only `status`. The `prepare`, `execute`, and `cancel` shapes below are reserved future-contract material, not enabled behavior; any activation requires separately authorized implementation and evidence.

Every response is one strict UTF-8 JSON document with:

```json
{
  "protocolVersion": 1,
  "managerId": "com.thomashulihan.tweakers",
  "requestId": "uuid",
  "generatedAt": "RFC3339",
  "stateToken": "sha256:...",
  "status": {},
  "actions": []
}
```

Every response echoes the host-generated `requestId`. The active status response has `actions: []`; action argv returns `unsupported_action`. Future `prepare`/`execute`/`cancel` responses are reserved to return the fields stated below only after their deferred migration has passed its evidence gates. Every failure is a typed JSON error with `code`, `message`, `retryable`, and optional `currentStateToken`; the process exits nonzero after emitting it. Defined codes include `invalid_request`, `unsupported_protocol`, `unsupported_action`, `stale_state`, `operation_expired`, `operation_consumed`, `operation_conflict`, `cancelled`, `timeout`, and `internal_error`.

The host rejects duplicate keys, trailing data, invalid UTF-8, unknown protocol versions, mismatched manager/operation/request IDs, stdout above 1 MiB, stderr above 256 KiB, timeout, or an exit/result mismatch. Status is capped at 10 seconds, prepare at 5 seconds, and every action declares a fixed maximum capped globally at 30 minutes. It captures stdout and stderr separately, launches a process group, sends graceful cancellation first, waits 2 seconds, then terminates the whole group. Environment variables are reduced to `HOME`, `PATH`, `TMPDIR`, `LANG`, and manager-owned explicit values; the executable path is never resolved from `PATH`.

Reserved action IDs may be compiled as closed vocabulary, but no action executor is enabled. Descriptors and status payloads cannot introduce an executable, arbitrary argv, working directory, or environment.

### 3. Read-only status invariant

`status --json` must not:

- create or chmod files/directories;
- write receipts, caches, logs, defaults, or descriptors;
- repair launchd or reconcile runtime state;
- start, stop, signal, or restart processes;
- fetch, install, update, prune, or migrate anything;
- prompt for credentials or elevate privileges.

Tests compare filesystem/process/receipt snapshots before and after success, partial-state, timeout, and malformed-state cases. Process checks exclude the intentionally launched manager process itself, but require no surviving descendants or persistent process changes. A status implementation that cannot meet this invariant stays behind the compatibility UI.

### 4. State tokens and prepared operations

The state token hashes canonical action-relevant state, including manager/protocol version, resolved executable identity, configuration revision, current mode/environment, installed/runtime version, active operation identity, latest relevant receipt IDs, receipt chronology/revision, and allowed action set. Including chronology prevents an ABA transition from returning to the same visible values with an obsolete approval.

For a consequential action:

1. Menu Bar obtains status and displays impact from that exact response.
2. The user confirms in Menu Bar.
3. Menu Bar asks the manager to prepare an operation bound to manager ID, module identity, action ID, state token, parameters, impact class, expiry, and a random operation ID.
4. The manager validates the prepare request, re-reads state, and persists the complete prepared operation under its coordinator lock with restrictive permissions.
5. Execution atomically validates and marks it consumed before starting work. Replay, expiry, token drift, module drift, or a concurrent operation fails closed. Crash recovery reconciles the consumed record with its receipt rather than reopening approval.

A timestamp, UI boolean, caller-authored JSON blob, or descriptor field is never sufficient approval.

### 5. Tweakers action migration order

Keep the compatibility adapter until every family passes its own evidence gate:

1. status only;
2. cancel/resume an already known operation;
3. environment switch;
4. desktop update using the explicitly resolved artifact;
5. repair, self-update, full refresh, and restart last.

Each action must define fixed inputs, impact level, allowed source states, coordinator lock, receipt lifecycle, cancellation behavior, idempotency, timeout, and recovery result. `reload-tweaks` remains an in-process Menu Bar/runtime operation unless a separate ownership decision changes it.

### 6. Portless read-only contract

Portless Manager v1 exposes only:

- exact CLI version and compatibility (`0.15.6` for the initial implementation baseline);
- proxy health and certificate/trust status as reported by non-mutating commands;
- active and stale routes without automatic pruning;
- declared project status and the reason a project is unavailable or unsupported.

Record the package tarball integrity (`dist.integrity`) with the tested pin. If the latest npm dist-tag or integrity differs from the recorded baseline at implementation time, stop, inspect the official changelog, update compatibility fixtures, rerun the complete Portless test matrix, and explicitly record the new pin/integrity. Never accept an untested major/minor or broad `latest` range at runtime.

Portless v1 has no action endpoint. A later mutation design requires a separate security plan proving an immutable root-owned or signed execution chain, narrow allowlisted operations, argument validation, lock/receipt behavior, uninstall/rollback, and a migration that closes the current passwordless path before enabling replacement functionality.

## Execution plan

### T1 — Freeze baselines, fixtures, and threat model

**Owners:** Tweakers plan/runtime owner plus security reviewer.

- Record exact Git SHA/status and path-scoped diffs for Tweakers and Menu Bar outside tracked source artifacts.
- Capture installed/runtime/receipt/descriptor state and the exact `portless --version`, npm dist-tag, plugin cache version, and read-only `portless doctor` result.
- Add protocol, malformed-output, path-trust, stale-state, replay, cancellation, partial-receipt, and rollback fixtures before behavior changes.
- Write the explicit same-user threat model and the privilege prohibition into code-facing contract documentation.

**Exit evidence:** E1-E3 and security reviewer approval. Any unresolved overlapping edit stops the affected workstream.

### T2 — Extract pure Tweakers status — complete (source/generated milestone)

**Ownership:** Tweakers canonical source and focused tests; generated runtime only through the synchronizer.

- Separate observation from `ensureUserPaths`, reconciliation, repair, and receipt mutation.
- Build one immutable dashboard snapshot from existing mode, environment, updater, installation, runtime, coordinator, and receipt sources.
- Include action availability and reasons, receipt chronology, partial/error states, and the state-token inputs.
- Add zero-side-effect tests covering missing directories and malformed/partial receipts.

**Recorded result:** the fixed launcher invokes only the bundled status CLI; it returns `actions: []`, and action argv is rejected. Descriptor publication and Menu Bar host/adapter source milestones were completed only after this pure status suite passed. No action migration, installation, or relaunch result is claimed.

**Exit evidence:** E4-E5. No descriptor or Menu Bar change is permitted until the pure status suite passes.

### T3 — Publish the Tweakers descriptor — complete (source/generated milestone)

**Ownership:** Tweakers installer/runtime.

- Add deterministic descriptor publication/removal using atomic replacement and restrictive permissions.
- Resolve a stable, validated launcher; do not publish a source-checkout path as a universal executable.
- Keep publisher operations independent from Menu Bar's trust store.
- Synchronize generated runtime only with `npm run sync:tweaks` and verify check mode.

**Exit evidence:** E6. Publishing must not require or trigger an app restart.

**Recorded result:** deterministic immutable-generation publication/removal, restrictive path validation, exact launcher signing policy, and host-independent descriptor ownership are implemented and covered by focused tests. Installed descriptor generation and running-host evidence remain separate promotion checks.

### T4 — Add the universal Menu Bar host and read-only Tweakers adapter — complete (source/build milestone)

**Ownership:** Menu Bar host, trust store, process runner, and UI.

- Implement strict descriptor parsing, independent trust, realpath/ownership/mode checks, bounded process execution, cancellation, and typed response validation.
- Implement and test a Menu Bar promotion transaction in `build.sh`: build/sign a disposable candidate, validate it, preserve the current installed app as a same-volume rollback candidate, stop the live process only after validation, atomically rename the candidate into place, run post-launch health checks, and restore/reopen the preserved app on any promotion or health failure. Never delete the installed app before a validated rollback candidate exists.
- Render Tweakers from the universal status response while retaining the current implementation as a comparison oracle.
- During the adoption window, collect structured mismatches without letting the new path perform actions.
- Keep product-specific display text in the adapter, not the universal process layer.

**Exit evidence:** E7-E9 and E18-E19, including failure-injection tests of the promotion transaction. Do not perform a live install or relaunch.

**Recorded result:** the source-built Menu Bar validates the immutable descriptor and exact signed launcher, stores host-owned trust, invokes only status with bounded process-group cleanup, rejects advertised actions, and leaves the existing Tweakers compatibility view/actions visible. Source build/signature and regressions passed; no installed-app or running-process claim is made.

### T5 — Migrate Tweakers actions serially — deferred

**Ownership:** Tweakers fixed action adapter and Menu Bar confirmation bridge.

- Implement prepared-operation storage/consumption under the coordinator lock.
- Migrate one action family at a time in the required order.
- For each family, test replay, expiry, state drift, wrong manager/module/action, concurrent operation, timeout, cancellation, partial receipt, and recovery.
- Preserve compatibility behavior until old/new result parity and rollback are demonstrated.

**Exit evidence:** E10-E12 per family. High-impact action enablement requires a fresh security review.

### T6 — Resolve Portless root, version, and privilege gates — out of scope

**Ownership:** project owners plus security owner; no source mutation in this task.

- Revalidate the latest dist-tag, `dist.integrity`, and official changelog against the `0.15.6` pin and record E20.
- Inventory the exact project declaration root for Menu Bar, THB-BBL, RobinHoodex, and TRR; do not infer from parent-directory scanning.
- Document the current helper/sudoers chain and a removal/containment path without invoking it.
- Decide whether a future native immutable launcher is warranted. If not, keep Portless permanently read-only in Menu Bar.

**Exit evidence:** E13 and an explicit user-approved project/privilege follow-up plan. Without it, T7 remains read-only and there is no mutation phase.

### T7 — Build a read-only Portless Manager — out of scope

**Ownership:** separate `/Users/thomashulihan/Projects/Portless Manager` project, created only after the user approves that project.

- Pin and test the exact supported Portless CLI version.
- Implement the same descriptor/status protocol with no action endpoint.
- Read explicit project declarations, normalize nested roots, and report unsupported/missing configurations without rewriting them.
- Treat active/stale route data as observations. Never prune or restart from status.
- Add read-only invariants, version-drift tests, hostile declaration fixtures, timeouts, and unavailable-router cases.

**Exit evidence:** E14. This task cannot inherit write authority from Tweakers or Menu Bar.

The dependency record below is future-only. No wave after completed T4 is authorized by this status-only milestone. If the user later approves Program B, stop before dispatch and publish a freshly hashed assignment artifact; no Portless universal-host claim is made by Program A.

### T8 — Adopt Portless read-only UI and complete independent review — out of scope

**Ownership:** Menu Bar adapter and independent reviewer.

- Add a Portless read-only card through the universal host.
- Compare it with existing project/route display using stable fixtures and manual source-run evidence.
- Keep existing Portless mutations disabled or on their current compatibility path; do not route them through the unsafe helper.
- Run an independent R1-R12 plan/implementation review, then close only verified findings.

**Exit evidence:** E15, accepted review, and a separately approved live-promotion request.

## Dependency DAG

```text
Wave 1: T1
Wave 2: T2 || T6
Wave 3: T3
Wave 4: T4
Wave 5A: T5
Wave 6A: T8         (canonical Program A branch; joins T5)

Optional A+B revision after explicit approval:
Wave 5B: T5 || T7   (separate workspaces; T7 also waits for T6)
Wave 6B: T8         (joins T5 and T7)
```

- T4 may begin only after T3 publishes a test descriptor.
- T7 depends on T4's universal host and T6's exact version/root decisions.
- In the canonical A-only artifact, T8 depends on T5. In an explicitly approved A+B artifact, T8 additionally depends on T7.
- The parent serializes each join, verifies the preceding task's evidence, and releases only the listed next wave. T5 and T7 may run in parallel only with disjoint writers.

## Evidence inventory

| ID | Required proof |
|---|---|
| E1 | Exact Tweakers and Menu Bar SHA/status plus preserved path-scoped baseline diffs |
| E2 | Installed Tweakers/runtime/receipt/descriptor inventory with source, generated, installed, and live states separated |
| E3 | Portless CLI/plugin/dist-tag/changelog/doctor snapshot; stale routes reported but untouched |
| E4 | Pure status unit tests prove zero filesystem/process/receipt changes |
| E5 | Deterministic state-token fixtures include receipt chronology and reject ABA cases |
| E6 | Descriptor publication/removal tests plus realpath/owner/mode/ancestor validation |
| E7 | Universal host malformed JSON, duplicate-key, size, timeout, stderr, and process-group tests |
| E8 | Trust-store tests prove publishers cannot grant or delete host trust |
| E9 | Tweakers old/new read-only parity and source-run UI acceptance |
| E10 | Prepared-operation binding, one-time consumption, expiry, and replay rejection |
| E11 | Per-action success/failure/cancellation/partial-receipt/recovery tests |
| E12 | Tweakers focused tests, catalog check, build/typecheck, full suite, and generated check all pass |
| E13 | Security-reviewed Portless version/root/privilege decision; no current helper execution |
| E14 | Portless read-only invariants, version drift, declaration, timeout, and router-unavailable tests |
| E15 | Menu Bar focused/full build tests and independent Program A review; add read-only Portless acceptance only in the A+B branch |
| E16 | Request-correlation plus prepare/execute/cancel success and typed-failure protocol fixtures |
| E17 | Trust onboarding, persistence, signed/digest update, revocation, and descriptor-removal tests |
| E18 | Candidate validation, same-volume backup, atomic rename, and failure-injection rollback tests |
| E19 | Post-launch health-check failure restores and reopens the last working signed app |
| E20 | Exact Portless package version, npm integrity, dist-tag, and changelog compatibility record |

Evidence records must identify whether a claim is planned, local, generated, committed, installed, live-process, or browser/UI verified. One state never substitutes for another.

## Verification commands

Run only commands that exist in the live checkout; confirm package scripts before execution.

### Tweakers

```bash
npm run sync:tweaks
npm run sync:tweaks -- --check
npm run check:tweak-catalog
npm run build
npm run typecheck
npm test
```

Add focused test commands discovered from the relevant package before the full suite. A failed sync/build leaves the current live snapshot untouched. Do not hand-edit generated runtime assets.

### Menu Bar

```bash
swiftc -parse-as-library Sources/TweakersManager.swift Tests/TweakersManagerRegression.swift -o /tmp/menu-bar-tweakers-manager-regression
/tmp/menu-bar-tweakers-manager-regression
swiftc -parse-as-library Sources/PortlessProjectManager.swift Sources/PortlessPrivilegedToggle.swift Tests/PortlessProjectManagerRegression.swift -o /tmp/menu-bar-portless-manager-regression
/tmp/menu-bar-portless-manager-regression
MENU_BAR_BUILD_OUTPUT_DIR="$(mktemp -d /tmp/menu-bar-plan-build.XXXXXX)" ./build.sh
```

The two focused regression compiles are the live checkout's direct `swiftc` test shape; if their source dependency set changes, update the command from the compiler error and record the exact final invocation. The source-only build uses a disposable output directory and must not pass `install`. Do not quit or relaunch the live app until P5 is explicitly approved.

### Portless

```bash
portless --version
npm view portless version dist-tags dist.integrity --json
portless doctor
```

These are read-only planning/compatibility checks. Do not run `portless prune`, service restart, CA/trust mutations, or project start/stop as validation for this plan.

## Promotion gates

- **P1 — contract:** threat model, protocol fixtures, and read-only invariants approved.
- **P2 — Tweakers source:** focused tests, generated synchronization check, catalog check, build/typecheck, and full suite pass.
- **P3 — Menu Bar source:** universal-host tests, direct Swift regression executables, disposable `./build.sh`, old/new parity, promotion failure-injection tests, and manual source-run acceptance pass.
- **P4 — Portless read-only, A+B branch only:** exact-version compatibility and all read-only/declaration tests pass; privilege finding remains contained.
- **P5 — live promotion:** for Program A, only after P1-P3 and independent review; for A+B, only after P1-P4 and independent review. Then ask the user for explicit permission to install/relaunch. T4 owns the tested atomic promotion transaction; the parent owns authorization and observes post-launch health or restoration of the last installed working build.

No app restart appears inside T1-T8. If restart seems necessary earlier, complete safe source work and stop with the blocker.

## Rollback matrix

| Change | Rollback trigger | Recovery |
|---|---|---|
| Pure Tweakers status | side effect, token instability, or parity mismatch | disable manager status and keep current dashboard path |
| Tweakers descriptor | trust/path validation failure | atomically remove publisher descriptor; retain Menu Bar trust record |
| Universal host | crash, timeout leak, or invalid module isolation | feature-disable universal discovery and restore compatibility adapters |
| Tweakers action family | replay/state-drift defect or receipt regression | disable only that family; preserve prior adapter and receipts |
| Portless read-only card | version drift or incorrect project/root mapping | hide card and retain existing read-only display |
| Future privileged work | any writable/root chain or overbroad operation | do not enable; separately remove/contain old helper through approved migration |
| Live app promotion | launch, signature, or acceptance failure | atomically restore last installed working app and reopen it |

Rollback must not delete user configuration, receipts, trust choices, project declarations, stale routes, or unrelated workspace changes.

## STOP conditions

Stop and report the exact missing oracle if any of these occur:

- a required path overlaps unexplained local edits;
- status collection creates or mutates state;
- a stable immutable launcher cannot be established;
- descriptor and trust ownership cannot remain separate;
- prepared operations cannot be atomically bound and consumed under the coordinator lock;
- receipt chronology cannot be represented in the state token;
- Portless latest differs from the tested pin and compatibility has not been revalidated;
- any Portless operation would execute a user-writable path as root;
- a project root/declaration remains ambiguous;
- focused or full verification fails twice with the same substantive error;
- installation, restart, or provider mutation would be needed before explicit user approval.

## Subagent Execution Assignments

These are implementation-time routes, not dispatch authorization. Every task requires a fresh routing check immediately before dispatch; the parent session keeps integration, user decisions, acceptance, and live-promotion authority.

| Task | Semantic role | Model | Effort | Agent type | Responsibility |
|---|---|---|---|---|---|
| T1 | `risk_owner` | `gpt-5.6-sol` | `high` | `sol_high` | freeze baselines, threat model, and contract fixtures |
| T2 | `complex_implementer` | `gpt-5.6-terra` | `xhigh` | `terra_xhigh` | pure Tweakers status and tests |
| T3 | `feature_implementer` | `gpt-5.6-terra` | `xhigh` | `terra_xhigh` | Tweakers descriptor lifecycle |
| T4 | `complex_implementer` | `gpt-5.6-terra` | `xhigh` | `terra_xhigh` | universal Menu Bar host and read-only adoption |
| T5 | `large_implementer` | `gpt-5.6-terra` | `max` | `terra_max` | serial prepared-operation/action migration |
| T6 | `risk_owner` | `gpt-5.6-sol` | `high` | `sol_high` | Portless version/root/privilege decision |
| T7 | `large_implementer` | `gpt-5.6-terra` | `max` | `terra_max` | separate read-only Portless Manager |
| T8 | `adversarial_reviewer` | `gpt-5.6-sol` | `high` | `sol_high` | independent evidence and safety review |

All assignments have `bindingStatus: requires_fresh_resolution`, `dispatchAuthorized: false`, unchanged capability inheritance, explicit ownership boundaries, and acceptance oracles E1-E20. The canonical machine-readable record represents Program A only and is validated against this plan's exact hash before execution; Program B approval requires a new artifact with the conditional dependency/evidence changes above.

### T1 Assignment Contract

Assignment JSON: `{"taskId":"T1","semanticRole":"risk_owner","responsibility":"high_consequence_ownership","roleCatalogSchemaVersion":3,"purpose":"Own the cross-repository contract and privilege boundary before implementation.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":[],"readOnly":["packages/installer","/Users/thomashulihan/Projects/Menu Bar","/opt/homebrew/bin/portless"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":[],"plannedRoute":{"model":"gpt-5.6-sol","reasoningEffort":"high","agentType":"sol_high","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-1","waveIndex":1,"group":"group-T1","mode":"serialized","joinsAt":"J1","integrationOwner":"parent","reviewTaskId":"T8"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E1-E3 and E16-E17 recorded"]},"stopConditions":["Unresolved ownership, privilege, or dirty-worktree overlap"]}`

### T2 Assignment Contract

Assignment JSON: `{"taskId":"T2","semanticRole":"complex_implementer","responsibility":"established_architecture_implementation","roleCatalogSchemaVersion":3,"purpose":"Implement zero-side-effect observation and state-token fixtures.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":["packages/installer/src","packages/installer/test","packages/runtime/src"],"readOnly":["tweaks","store/index.json"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T1"],"plannedRoute":{"model":"gpt-5.6-terra","reasoningEffort":"xhigh","agentType":"terra_xhigh","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-2","waveIndex":2,"group":"group-T2","mode":"serialized","joinsAt":"J2","integrationOwner":"parent","reviewTaskId":"T8"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E4-E5 pass"]},"stopConditions":["Status creates or mutates state"]}`

### T3 Assignment Contract

Assignment JSON: `{"taskId":"T3","semanticRole":"feature_implementer","responsibility":"established_architecture_implementation","roleCatalogSchemaVersion":3,"purpose":"Add the publisher lifecycle without modifying host trust.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":["packages/installer/src","packages/installer/test","packages/installer/assets/runtime"],"readOnly":["store/index.json"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T2"],"plannedRoute":{"model":"gpt-5.6-terra","reasoningEffort":"xhigh","agentType":"terra_xhigh","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-3","waveIndex":3,"group":"group-T3","mode":"serialized","joinsAt":"J3","integrationOwner":"parent","reviewTaskId":"T8"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E6 passes"]},"stopConditions":["No stable validated launcher is available"]}`

### T4 Assignment Contract

Assignment JSON: `{"taskId":"T4","semanticRole":"complex_implementer","responsibility":"established_architecture_implementation","roleCatalogSchemaVersion":3,"purpose":"Create strict discovery, trust, bounded execution, parity UI, and atomic promotion rollback.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":["/Users/thomashulihan/Projects/Menu Bar/Sources","/Users/thomashulihan/Projects/Menu Bar/Tests","/Users/thomashulihan/Projects/Menu Bar/build.sh"],"readOnly":["packages/installer"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T3"],"plannedRoute":{"model":"gpt-5.6-terra","reasoningEffort":"xhigh","agentType":"terra_xhigh","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-4","waveIndex":4,"group":"group-T4","mode":"serialized","joinsAt":"J4","integrationOwner":"parent","reviewTaskId":"T8"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E7-E9 and E16-E19 pass"]},"stopConditions":["Overlap with unexplained Menu Bar edits or trust separation fails"]}`

### T5 Assignment Contract

Assignment JSON: `{"taskId":"T5","semanticRole":"large_implementer","responsibility":"established_architecture_implementation","roleCatalogSchemaVersion":3,"purpose":"Remove duplicate action authority while preserving rollback and receipts.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":["packages/installer/src","packages/installer/test","packages/installer/assets/runtime","/Users/thomashulihan/Projects/Menu Bar/Sources","/Users/thomashulihan/Projects/Menu Bar/Tests"],"readOnly":["tweaks","store/index.json"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T4"],"plannedRoute":{"model":"gpt-5.6-terra","reasoningEffort":"max","agentType":"terra_max","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-5","waveIndex":5,"group":"group-T5","mode":"serialized","joinsAt":"J5","integrationOwner":"parent","reviewTaskId":"T8"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E10-E12 pass"]},"stopConditions":["Prepared operation cannot bind and consume atomically"]}`

### T6 Assignment Contract

Assignment JSON: `{"taskId":"T6","semanticRole":"risk_owner","responsibility":"high_consequence_ownership","roleCatalogSchemaVersion":3,"purpose":"Own the security decision and prohibit unsafe root execution.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":[],"readOnly":["/Users/thomashulihan/Projects/Menu Bar","/Users/thomashulihan/Projects/THB-BBL","/Users/thomashulihan/Projects/TRR","/Users/thomashulihan/Projects/RobinHoodex","/opt/homebrew/bin/portless"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T1"],"plannedRoute":{"model":"gpt-5.6-sol","reasoningEffort":"high","agentType":"sol_high","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-2","waveIndex":2,"group":"group-T6","mode":"serialized","joinsAt":"J6","integrationOwner":"parent","reviewTaskId":"parent_review_gate"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E13 and E20 recorded"]},"stopConditions":["Any path would execute user-writable content as root"]}`

### T7 Assignment Contract

Assignment JSON: `{"taskId":"T7","semanticRole":"large_implementer","responsibility":"established_architecture_implementation","roleCatalogSchemaVersion":3,"purpose":"Implement exact-version read-only status with explicit declarations.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":["/Users/thomashulihan/Projects/Portless Manager"],"readOnly":["/Users/thomashulihan/Projects/Menu Bar","/Users/thomashulihan/Projects/THB-BBL","/Users/thomashulihan/Projects/TRR","/Users/thomashulihan/Projects/RobinHoodex"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T4","T6"],"plannedRoute":{"model":"gpt-5.6-terra","reasoningEffort":"max","agentType":"terra_max","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-5","waveIndex":5,"group":"group-T7","mode":"serialized","joinsAt":"J7","integrationOwner":"parent","reviewTaskId":"parent_review_gate"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E14 passes"]},"stopConditions":["Project creation is not approved or version/root mapping is ambiguous"]}`

### T8 Assignment Contract

Assignment JSON: `{"taskId":"T8","semanticRole":"adversarial_reviewer","responsibility":"review_integration","roleCatalogSchemaVersion":3,"purpose":"Challenge correctness, regressions, privilege boundaries, and promotion readiness.","routeReason":"Managed role and route match the bounded responsibility and consequence level.","ownershipBoundary":"Own only declared paths; parent retains user decisions, integration, acceptance, and promotion.","escalationEvidence":{},"ownership":{"writable":[],"readOnly":["/Users/thomashulihan/Projects/tweakers","/Users/thomashulihan/Projects/Menu Bar","/Users/thomashulihan/Projects/Portless Manager"],"forbidden":[".codex/config.toml","AGENTS.md","unrelated dirty work"]},"dependencies":["T5"],"plannedRoute":{"model":"gpt-5.6-sol","reasoningEffort":"high","agentType":"sol_high","routeBinding":"registered_agent_type","requestedWidth":1,"rationale":"Plan Architect managed route.","policySource":{"label":"subagent-routing-schema-v3","fingerprint":"99801a8eb501c970cefd39a65f1242f1bbe2531bc823d40e4f9cc05feb6b7f6d"}},"dispatchPlan":{"wave":"wave-6","waveIndex":6,"group":"group-T8","mode":"serialized","joinsAt":"J8","integrationOwner":"parent","reviewTaskId":"parent_review_gate"},"acceptanceOracle":{"commands":[],"expectedResults":[],"manualChecks":["E15 and R1-R12 have no blockers"]},"stopConditions":["Evidence is incomplete, target drifted, or reviewer independence is compromised"]}`

## Future completion criteria (not claims of current completion)

### Program A

- Tweakers status is demonstrably read-only and deterministic.
- Descriptor publication and Menu Bar trust are separate and path-safe.
- Universal host failures are bounded and isolated.
- State tokens include receipt chronology; consequential actions use one-time prepared operations.
- Existing Tweakers action families are migrated serially with regression and recovery evidence.
- Generated state is synchronized only through the canonical command.
- Focused and full verification pass with unrelated work preserved.

### Program B — out of scope

- Portless is pinned to the latest tested exact release; drift stops acceptance.
- The first manager is read-only and uses explicit declarations.
- Stale routes are reported, never automatically pruned.
- No user-writable executable is invoked as root.
- Project mutation and privileged router control remain blocked pending separate explicit approval and security design.

### Live completion

- Independent review is accepted with no blocking findings.
- Source, generated, installed, and live evidence are reported separately.
- The user explicitly approves the final install/relaunch step.
- The promoted app passes post-launch acceptance or rolls back atomically.

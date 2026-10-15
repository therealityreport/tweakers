import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ProcessInfo } from "../src/commands/debug";
import {
  createSealedIndependentRefreshExecutorForTest,
  createSealedIndependentBackendRecoveryExecutorForTest,
  createSealedAcceptedRuntimeRepairExecutorForTest,
  createSealedAcceptedRuntimeRepairApprovalExecutorForTest,
  createSealedNativeReplacementExecutorForTest,
  prepareIndependentStartupCapture,
  ManagerActionAdapterError,
  TweakersManagerActionAdapter,
  type InjectedRefreshExecutionInput,
  type InjectedRefreshExecutionResult,
} from "../src/manager-action-adapter";
import type { DeferredTweakersVariantRefresh } from "../src/commands/create-variant";
import type { TweakersManagerActionIdV1 } from "../src/manager-contract";
import { ManagerOperationStore } from "../src/manager-operation-store";
import { createTweakersManagerStatusSnapshot, managerStatusPaths } from "../src/manager-status";
import { ForwardBackendTransitionRecoveryRequired } from "../src/shared-native-backend-transition.js";
import type { ManagerRecoveryBindingV1 } from "../src/manager-recovery-evidence.js";

const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";
const FIRST_OPERATION = "018f0d36-4c08-7a3e-9c1d-123456789abd";
const SECOND_OPERATION = "018f0d36-4c08-7a3e-9c1d-123456789abe";
const NOW = "2026-08-27T23:00:00.000Z";

test("independent startup capture consumes a private request without granting acceptance", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-capture-")));
  try {
    const directory = join(root, "doctor", "startup-diagnostics"), request = join(directory, "request.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(request, JSON.stringify({ version: 1, kind: "tweakers-native-startup-capture-request", requestId: REQUEST_ID, target: "/Applications/Tweakers.app" }), { mode: 0o600 });
    const streams = prepareIndependentStartupCapture(root);
    assert.equal(existsSync(request), false);
    for (const file of Object.values(streams)) { const s = lstatSync(file); assert.equal(s.mode & 0o777, 0o600); assert.equal(s.size, 0); }
    assert.equal(lstatSync(dirname(streams.stdout)).mode & 0o777, 0o700);
    const capture = JSON.parse(readFileSync(join(dirname(streams.stdout), "capture.json"), "utf8"));
    assert.equal(capture.operationId, null); assert.equal(capture.promotionId, null);
    assert.equal(capture.kind, "tweakers-native-startup-diagnostics");
    assert.equal(existsSync(join(root, "variants", "tweakers", "runtime-ready.json")), false);
    assert.throws(() => prepareIndependentStartupCapture(root), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const FUTURE = "2026-08-27T23:05:00.000Z";
const EXECUTABLE = { state: "resolved" as const, path: "/fixed/Tweakers Manager Launcher", sha256: "a".repeat(64) };
const REGISTERED_SOURCE_GENERATION = "018f0d36-4c08-7a3e-9c1d-123456789aff";
const REGISTERED_SOURCE_RECEIPT_DIGEST = "d".repeat(64);
const REGISTERED_SOURCE_CANDIDATE_DIGEST = "e".repeat(64);
const MANAGER_RUNTIME_FINGERPRINT = "f".repeat(64);
const SELECTION_REVISION = `sha256:${"1".repeat(64)}`;
const REGISTRY_REVISION = `sha256:${"2".repeat(64)}`;

type TestProcessObservation = { pid: number; visibleWindow: boolean; startedAtRaw?: string };

function processObservation(value: TestProcessObservation | null): (TestProcessObservation & { startedAtRaw: string }) | null {
  return value === null ? null : { ...value, startedAtRaw: value.startedAtRaw ?? `start-${value.pid}` };
}

test("environment.cancel is status-bound, one-time, consumed before execution, and receipt-complete", async () => {
  const root = fixtureRoot();
  try {
    let now = NOW;
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => now,
      statusDependencies: fixtureStatusDependencies(),
      async executeEnvironmentCancel(transactionId) {
        assert.equal(transactionId, "environment-1");
        writeEnvironmentReceipt(root, "cancelled");
        return { kind: "environment", transactionId, phase: "cancelled" };
      },
    });
    const status = snapshot(root, ["environment.cancel"]);
    assert.equal(status.actions.find((action) => action.actionId === "environment.cancel")?.available, true);
    const prepared = await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "environment.cancel",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    assert.equal(prepared.prepared, true);
    const result = await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    assert.equal(result.outcome, "cancelled");
    assert.deepEqual(result.receiptRefs, ["environment:environment-1"]);
    const stored = new ManagerOperationStore(root).read(FIRST_OPERATION);
    assert.equal(stored?.phase, "completed");
    assert.notEqual(stored?.consumedAt, null);
    await assertAdapterError(
      () => adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE }),
      "operation_consumed",
    );
    now = "2026-08-27T23:01:00.000Z";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared operation rejects stale state, wrong executable, expiry, concurrent preparation, and pre-consumption cancellation", async () => {
  const root = fixtureRoot();
  try {
    let now = NOW;
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => now,
      statusDependencies: fixtureStatusDependencies(),
      async executeEnvironmentCancel(transactionId) {
        return { transactionId, phase: "cancelled" };
      },
    });
    const status = snapshot(root, ["environment.cancel"]);
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "environment.cancel",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    const afterPrepare = snapshot(root, ["environment.cancel"]);
    await assertAdapterError(
      () => adapter.prepare({
        requestId: REQUEST_ID,
        operationId: SECOND_OPERATION,
        actionId: "environment.cancel",
        stateToken: afterPrepare.stateToken,
        expiresAt: FUTURE,
        parameters: {},
        executable: EXECUTABLE,
      }),
      "operation_conflict",
    );
    await assertAdapterError(
      () => adapter.execute({ operationId: FIRST_OPERATION, executable: { ...EXECUTABLE, sha256: "b".repeat(64) } }),
      "operation_conflict",
    );
    const cancelled = await adapter.cancel({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    assert.equal(cancelled.outcome, "cancelled");
    await assertAdapterError(() => adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE }), "cancelled");

    // New prepare, then a durable configuration drift invalidates the stored
    // state token even though the visible target receipt did not change.
    const fresh = snapshot(root, ["environment.cancel"]);
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: SECOND_OPERATION,
      actionId: "environment.cancel",
      stateToken: fresh.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    writeFileSync(managerStatusPaths(root).configFile, '{"changed":true}\n');
    await assertAdapterError(() => adapter.execute({ operationId: SECOND_OPERATION, executable: EXECUTABLE }), "stale_state");
    assert.equal(new ManagerOperationStore(root).read(SECOND_OPERATION)?.phase, "cancelled");

    // A fresh expiry is consumed neither before nor after the deadline.
    writeEnvironmentReceipt(root, "prepared");
    const thirdStatus = snapshot(root, ["environment.cancel"]);
    const thirdOperation = "018f0d36-4c08-7a3e-9c1d-123456789abf";
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: thirdOperation,
      actionId: "environment.cancel",
      stateToken: thirdStatus.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    now = "2026-08-27T23:06:00.000Z";
    await assertAdapterError(() => adapter.execute({ operationId: thirdOperation, executable: EXECUTABLE }), "operation_expired");
    const expired = new ManagerOperationStore(root).read(thirdOperation);
    assert.equal(expired?.phase, "cancelled");
    assert.equal(expired?.consumedAt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a consumed action that throws stays recovery-required and never reopens", async () => {
  const root = fixtureRoot();
  try {
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      statusDependencies: fixtureStatusDependencies(),
      async executeEnvironmentCancel() {
        throw new Error("simulated partial receipt after coordinator handoff");
      },
    });
    const status = snapshot(root, ["environment.cancel"]);
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "environment.cancel",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    const result = await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    assert.equal(result.outcome, "recovery-required");
    const record = new ManagerOperationStore(root).read(FIRST_OPERATION);
    assert.equal(record?.phase, "recovery-required");
    assert.notEqual(record?.consumedAt, null);
    await assertAdapterError(() => adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE }), "operation_consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment.recover invokes only the captured environment receipt and requires a terminal result", async () => {
  const root = fixtureRoot();
  try {
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      statusDependencies: fixtureStatusDependencies(),
      async executeEnvironmentRecover(transactionId) {
        assert.equal(transactionId, "environment-1");
        writeEnvironmentReceipt(root, "committed");
        return { kind: "environment", transactionId, phase: "committed" };
      },
    });
    const status = snapshot(root, ["environment.recover"]);
    assert.equal(status.actions.find((action) => action.actionId === "environment.recover")?.available, true);
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "environment.recover",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    const result = await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    assert.equal(result.outcome, "recovered");
    assert.equal(new ManagerOperationStore(root).read(FIRST_OPERATION)?.phase, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("split refresh actions bind their own receipt prefixes and reach their fixed executors", async () => {
  await assertSplitRefreshDispatch({
    actionId: "refresh.injected",
    operationId: FIRST_OPERATION,
    target: injectedRefreshBinding(),
    outcome: "injected-tweakers-runtime-verified",
  });
  await assertSplitRefreshDispatch({
    actionId: "refresh.independent",
    operationId: SECOND_OPERATION,
    target: `independent-tweakers-patch:independent-version:${REGISTERED_SOURCE_GENERATION}:${REGISTERED_SOURCE_RECEIPT_DIGEST}`,
    outcome: "rebuilt-independent-tweakers",
  });
});

test("refresh timing persists only observable phase boundaries and records hidden stages as unavailable", async () => {
  const root = fixtureRoot();
  try {
    const status = refreshStatusSnapshot("refresh.independent");
    let monotonic = 0;
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      timingMonotonicMs: () => monotonic++,
      status: () => status,
      async executeRefreshIndependent(_execution, timing) {
        assert.ok(timing);
        await timing.unavailable(
          ["apfs-clone", "sign", "verify"],
          "The fixed fixture does not expose this boundary.",
        );
        for (const phase of ["source-validation", "patch-stage", "quiesce-promote", "runtime-ready-wait"] as const) {
          await timing.start(phase);
          await timing.complete(phase);
        }
      },
    });
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "refresh.independent",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    const prepared = new ManagerOperationStore(root).read(FIRST_OPERATION);
    assert.equal(prepared?.timing?.phases["patch-stage"].state, "pending");

    await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    const timing = new ManagerOperationStore(root).read(FIRST_OPERATION)?.timing;
    assert.ok(timing);
    assert.deepEqual(
      ["source-validation", "patch-stage", "quiesce-promote", "runtime-ready-wait"].map((phase) => timing.phases[phase as keyof typeof timing.phases].state),
      ["completed", "completed", "completed", "completed"],
    );
    assert.equal(timing.phases["source-validation"].durationMs, 1);
    assert.equal(timing.phases["apfs-clone"].state, "unavailable");
    assert.doesNotMatch(JSON.stringify(timing), /\/Applications|sourceReceiptDigest|[a-f0-9]{64}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official-source registration binds the exact prepared live-source digest and returns only its durable receipt", async () => {
  const root = fixtureRoot();
  try {
    const status = officialSourceRegistrationStatusSnapshot();
    let input: unknown = null;
    const observedSourceVerifications: Array<string | undefined> = [];
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      status: (snapshotInput) => {
        observedSourceVerifications.push(snapshotInput.officialSourceVerification);
        return status;
      },
      async executeOfficialSourceRegister(value) {
        input = value;
        return {
          receiptRef: `official-source:${REGISTERED_SOURCE_GENERATION}:${REGISTERED_SOURCE_RECEIPT_DIGEST}`,
        };
      },
    });
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "official-source.register",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    const result = await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    assert.deepEqual(input, {
      operationId: FIRST_OPERATION,
      sourceDigest: REGISTERED_SOURCE_CANDIDATE_DIGEST,
      managerExecutable: EXECUTABLE,
    });
    assert.equal(result.outcome, "registered-official-source");
    assert.deepEqual(observedSourceVerifications.slice(0, 2), ["strict", "strict"]);
    assert.deepEqual(result.receiptRefs, [`official-source:${REGISTERED_SOURCE_GENERATION}:${REGISTERED_SOURCE_RECEIPT_DIGEST}`]);
    assert.equal(new ManagerOperationStore(root).read(FIRST_OPERATION)?.phase, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official-source registration rejects projected and drifted strict state before execution", async (t) => {
  await t.test("a projected discovery token cannot authorize strict preparation", async () => {
    const root = fixtureRoot();
    try {
      const projected = officialSourceRegistrationStatusSnapshot(REGISTERED_SOURCE_CANDIDATE_DIGEST, `sha256:${"1".repeat(64)}`);
      const strict = officialSourceRegistrationStatusSnapshot(REGISTERED_SOURCE_CANDIDATE_DIGEST, `sha256:${"2".repeat(64)}`);
      const adapter = new TweakersManagerActionAdapter({
        userRoot: () => root,
        now: () => NOW,
        status: (input) => input.officialSourceVerification === "strict" ? strict : projected,
        async executeOfficialSourceRegister() {
          assert.fail("a projected token must not reach the registration executor");
        },
      });
      await assertAdapterError(() => adapter.prepare({
        requestId: REQUEST_ID,
        operationId: FIRST_OPERATION,
        actionId: "official-source.register",
        stateToken: projected.stateToken,
        expiresAt: FUTURE,
        parameters: {},
        executable: EXECUTABLE,
      }), "stale_state");
      assert.equal(new ManagerOperationStore(root).read(FIRST_OPERATION), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("candidate drift between strict discovery and prepare is rejected", async () => {
    const root = fixtureRoot();
    try {
      const discovered = officialSourceRegistrationStatusSnapshot("3".repeat(64), `sha256:${"4".repeat(64)}`);
      const changed = officialSourceRegistrationStatusSnapshot("5".repeat(64), `sha256:${"6".repeat(64)}`);
      const adapter = new TweakersManagerActionAdapter({
        userRoot: () => root,
        now: () => NOW,
        status: () => changed,
        async executeOfficialSourceRegister() {
          assert.fail("prepare-time candidate drift must not reach the registration executor");
        },
      });
      await assertAdapterError(() => adapter.prepare({
        requestId: REQUEST_ID,
        operationId: FIRST_OPERATION,
        actionId: "official-source.register",
        stateToken: discovered.stateToken,
        expiresAt: FUTURE,
        parameters: {},
        executable: EXECUTABLE,
      }), "stale_state");
      assert.equal(new ManagerOperationStore(root).read(FIRST_OPERATION), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("candidate drift between prepare and execute cancels the record without invoking the executor", async () => {
    const root = fixtureRoot();
    try {
      const preparedStatus = officialSourceRegistrationStatusSnapshot("7".repeat(64), `sha256:${"8".repeat(64)}`);
      const changedStatus = officialSourceRegistrationStatusSnapshot("9".repeat(64), `sha256:${"0".repeat(64)}`);
      let observations = 0;
      let executed = false;
      const adapter = new TweakersManagerActionAdapter({
        userRoot: () => root,
        now: () => NOW,
        status: () => observations++ === 0 ? preparedStatus : changedStatus,
        async executeOfficialSourceRegister() {
          executed = true;
          return { receiptRef: `official-source:${REGISTERED_SOURCE_GENERATION}:${REGISTERED_SOURCE_RECEIPT_DIGEST}` };
        },
      });
      await adapter.prepare({
        requestId: REQUEST_ID,
        operationId: FIRST_OPERATION,
        actionId: "official-source.register",
        stateToken: preparedStatus.stateToken,
        expiresAt: FUTURE,
        parameters: {},
        executable: EXECUTABLE,
      });
      await assertAdapterError(
        () => adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE }),
        "stale_state",
      );
      assert.equal(executed, false);
      assert.equal(new ManagerOperationStore(root).read(FIRST_OPERATION)?.phase, "cancelled");
      assert.equal(new ManagerOperationStore(root).read(FIRST_OPERATION)?.outcome, "stale-state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("injected refresh rejects an unproven committed result instead of reporting completion", async () => {
  const root = fixtureRoot();
  try {
    const status = refreshStatusSnapshot("refresh.injected");
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      status: () => status,
      managerRuntimeFingerprint: () => MANAGER_RUNTIME_FINGERPRINT,
      async executeRefreshInjected(input) {
        return injectedRefreshResult(input.operationId, 41, 41);
      },
    });
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "refresh.injected",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });

    const result = await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });
    assert.equal(result.outcome, "recovery-required");
    const stored = new ManagerOperationStore(root).read(FIRST_OPERATION);
    assert.equal(stored?.phase, "recovery-required");
    assert.equal(stored?.outcome, "recovery-required");
    assert.match(stored?.error ?? "", /new-PID runtime-verified environment receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed independent refresh commits only after a previously running Tweakers app writes matching runtime-ready evidence", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:513",
      "commit",
    ],
    expectedProofPrefix: ["513:true"],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh opens an already-closed Tweakers app solely to establish runtime-ready evidence", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: false,
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:513",
      "commit",
    ],
    expectedProofPrefix: ["513:true"],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh validates recovery before quiescence and reuses account continuity at cutover", async () => {
  const root = fixtureRoot();
  try {
    const events: string[] = [];
    let reopened = false;
    const lifecycle = {
      observe: () => reopened ? processObservation({ pid: 513, visibleWindow: true }) : null,
      quit: () => { throw new Error("closed fixture must not quit"); },
      relatedPids: () => [],
      listProcesses: () => [],
      signal: () => { throw new Error("closed fixture has no helpers"); },
      reopen: () => { events.push("reopen"); reopened = true; },
      async refresh(request: { userRoot: string }, execution: { operationId: string }, _authority: string, beforePromotion: () => Promise<void>) {
        events.push("refresh");
        await beforePromotion();
        return fakeDeferredRefresh(request.userRoot, execution.operationId, events);
      },
      readRuntimeReady: () => ({ operationId: FIRST_OPERATION }),
      now: () => 0,
      async sleep(): Promise<void> {},
      sealedAccountsRuntimeRoot: () => { events.push("sealed-runtime"); return join(root, "sealed-runtime"); },
      verifyAccountsTransferRecovery(runtimeRoot: string): boolean {
        events.push(runtimeRoot.endsWith("sealed-runtime") ? "verify-source-recovery" : "verify-candidate-recovery");
        return true;
      },
      prepareAccountContinuity(stateRoot: string) {
        assert.equal(stateRoot, join(root, "tweak-data", "co.tweakers.account-switcher"));
        events.push("continuity");
        return { state: "ready" as const, reason: "shared-source-rebased" as const };
      },
    };
    const execute = createSealedIndependentRefreshExecutorForTest(() => root, lifecycle);
    await execute({ operationId: FIRST_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST });
    assert.deepEqual(events, [
      "sealed-runtime",
      "verify-source-recovery",
      "refresh",
      "continuity",
      "verify-candidate-recovery",
      "reopen",
      "runtime-ready:513",
      "commit",
    ]);

    const blockedEvents: string[] = [];
    const blocked = createSealedIndependentRefreshExecutorForTest(() => root, {
      ...lifecycle,
      sealedAccountsRuntimeRoot: () => { blockedEvents.push("sealed-runtime"); return join(root, "sealed-runtime"); },
      verifyAccountsTransferRecovery: () => { blockedEvents.push("verify-source-recovery"); return false; },
      async refresh() { blockedEvents.push("refresh"); throw new Error("must not build"); },
      prepareAccountContinuity: () => { blockedEvents.push("continuity"); return { state: "ready" as const, reason: "already-current" as const }; },
    });
    await assert.rejects(
      () => blocked({ operationId: SECOND_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST }),
      /source-bound validated Accounts recovery receipt/,
    );
    assert.deepEqual(blockedEvents, ["sealed-runtime", "verify-source-recovery"]);

    // Unknown/active legacy work must fail before any lifecycle interruption.
    reopened = false;
    const guardedEvents: string[] = [];
    const guarded = createSealedIndependentRefreshExecutorForTest(() => root, {
      ...lifecycle,
      reserveCutover: async () => { guardedEvents.push("reserve"); throw new Error("broker activity is not proven idle"); },
      quit: () => { guardedEvents.push("quit"); },
      signal: () => { guardedEvents.push("signal"); },
      prepareAccountContinuity: () => { guardedEvents.push("continuity"); return {state:"ready" as const,reason:"already-current" as const}; },
    });
    await assert.rejects(() => guarded({operationId: SECOND_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST}), /not proven idle/);
    assert.deepEqual(guardedEvents, ["reserve"]);

    // A process racing admission is refused without signals and releases it.
    let raced = false;
    const raceEvents: string[] = [];
    const race = createSealedIndependentRefreshExecutorForTest(() => root, {
      ...lifecycle,
      reserveCutover: async () => { raced = true; return {async release() {raceEvents.push("release");}}; },
      observe: () => raced ? processObservation({pid: 999, visibleWindow: true}) : null,
      quit: () => {raceEvents.push("quit");}, signal: () => {raceEvents.push("signal");},
    });
    await assert.rejects(() => race({operationId: SECOND_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST}), /appeared during closed-app cutover/);
    assert.deepEqual(raceEvents, ["release"]);

    const failureEvents: string[] = [];
    const failedPromotion = createSealedIndependentRefreshExecutorForTest(() => root, {
      ...lifecycle,
      reserveCutover: async () => ({async release() {failureEvents.push("release");}}),
      async refresh(_request, _execution, _authority, beforePromotion) {
        await beforePromotion(); throw new Error("promotion failed after admission");
      },
    });
    await assert.rejects(() => failedPromotion({operationId: SECOND_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST}), /promotion failed after admission/);
    assert.deepEqual(failureEvents, ["release"]);

    const acceptanceEvents: string[] = [];
    reopened = false;
    const failedAcceptance = createSealedIndependentRefreshExecutorForTest(() => root, {
      ...lifecycle,
      reserveCutover: async () => ({async release() {acceptanceEvents.push("release");}}),
      async refresh(request, execution, _authority, beforePromotion) {
        await beforePromotion();
        return fakeDeferredRefresh(request.userRoot, execution.operationId, acceptanceEvents, new Error("readiness failed"));
      },
      quit: () => {acceptanceEvents.push("quit");}, signal: () => {acceptanceEvents.push("signal");},
    });
    await assert.rejects(() => failedAcceptance({operationId: SECOND_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST}), /rollback\/reopen path was incomplete/);
    assert.deepEqual(acceptanceEvents, ["release", "retain"]);

    // Main exit is not broker closure. Compensation needs fresh admission.
    for (const brokerClosed of [false, true]) {
      reopened = false;
      const recoveryEvents: string[] = [];
      let reservations = 0;
      const afterExit = createSealedIndependentRefreshExecutorForTest(() => root, {
        ...lifecycle,
        reserveCutover: async () => {
          recoveryEvents.push(`reserve:${++reservations}`);
          if (reservations > 1 && !brokerClosed) throw new Error("broker still active after desktop exit");
          return {async release() {recoveryEvents.push("release");}};
        },
        async refresh(request, execution, _authority, beforePromotion, beforeRollback) {
          await beforePromotion();
          const handle = fakeDeferredRefresh(request.userRoot, execution.operationId, recoveryEvents);
          const rollback = handle.rollback.bind(handle);
          handle.rollback = () => {beforeRollback(); rollback();};
          return handle;
        },
        readRuntimeReady: () => {reopened = false; throw new Error("readiness failed after desktop exit");},
        quit: () => {throw new Error("must not quit any desktop");},
        signal: () => {throw new Error("must not signal any process");},
      });
      await assert.rejects(() => afterExit({operationId: SECOND_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST}));
      assert.deepEqual(recoveryEvents, brokerClosed
        ? ["reserve:1", "release", "reserve:2", "rollback", "release"]
        : ["reserve:1", "release", "reserve:2", "retain"]);
    }

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted backend refresh retains forward recovery through publication, canary and commit failures", async () => {
  const root = fixtureRoot();
  try {
    for (const stage of ["publication", "candidate-recovery", "canary", "commit"] as const) {
      const events: string[] = [];
      let reopened = false;
      let recoveryReads = 0;
      const lifecycle = {
        reserveCutover: async () => { events.push("reserve"); return { async release() { events.push("release"); } }; },
        observe: () => reopened ? processObservation({ pid: 513, visibleWindow: true }) : null,
        quit: () => { throw new Error("forward recovery must not quit"); },
        relatedPids: () => [], listProcesses: () => [],
        signal: () => { throw new Error("forward recovery must not signal"); },
        reopen: () => { reopened = true; events.push("reopen"); },
        async refresh(request: { userRoot: string }, execution: { operationId: string }, _authority: string, beforePromotion: () => Promise<void>) {
          await beforePromotion();
          if (stage === "publication") throw new ForwardBackendTransitionRecoveryRequired(join(request.userRoot, "journal.json"));
          const handle = fakeDeferredRefresh(request.userRoot, execution.operationId, events,
            stage === "canary" ? new Error("canary failed") : undefined);
          handle.rollback = () => { events.push("forbidden-rollback"); throw new Error("must not compensate"); };
          if (stage === "commit") handle.commit = () => { throw new Error("commit failed"); };
          return { ...handle, recoveryMode: "forward-only" as const };
        },
        readRuntimeReady: () => ({ operationId: FIRST_OPERATION }), now: () => 0, async sleep() {},
        sealedAccountsRuntimeRoot: () => join(root, "sealed-runtime"),
        verifyAccountsTransferRecovery: () => ++recoveryReads !== 2 || stage !== "candidate-recovery",
        prepareAccountContinuity: () => ({ state: "ready" as const, reason: "already-current" as const }),
      };
      const execute = createSealedIndependentRefreshExecutorForTest(() => root, lifecycle);
      await assert.rejects(() => execute({ operationId: FIRST_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION,
        sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST }));
      assert.deepEqual(events, stage === "publication" ? ["reserve", "release"]
        : stage === "candidate-recovery" ? ["reserve", "retain", "release"]
        : stage === "canary" ? ["reserve", "release", "reopen", "retain"]
        : ["reserve", "release", "reopen", "runtime-ready:513", "retain"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted backend recovery binds the original operation and holds admission through replay", async () => {
  const root = fixtureRoot();
  try {
    const binding: ManagerRecoveryBindingV1 = { schemaVersion: 1, kind: "tweakers-manager-recovery-binding", operationId: FIRST_OPERATION,
      promotionId: SECOND_OPERATION, userRoot: join(root, "variants", "tweakers"), target: "/Applications/Tweakers.app",
      generation: { appSha256: "a".repeat(64), runtimeFingerprint: "b".repeat(64), activeReceiptSha256: "c".repeat(64) },
      journal: { path: join(root, "journal.json"), identitySha256: "d".repeat(64) }, receiptRefs: [], dependencyPaths: [], createdAt: NOW };
    for (const scenario of ["success", "admission-denied", "evidence-drift", "appearing-process", "canary-failure", "already-committed"] as const) {
      const events: string[] = [];
      let held = false, reopened = false, appeared = false, reads = 0;
      const lifecycle = {
        reserveCutover: async () => {
          events.push("reserve"); if (scenario === "admission-denied") throw new Error("broker not closed");
          held = true; return { async release() { held = false; events.push("release"); } };
        },
        observe: () => appeared ? processObservation({ pid: 999, visibleWindow: true }) : reopened ? processObservation({ pid: 513, visibleWindow: true }) : null,
        quit: () => { throw new Error("must not quit"); }, relatedPids: () => [], listProcesses: () => [],
        signal: () => { throw new Error("must not signal"); },
        reopen: () => { assert.equal(held, false); reopened = true; events.push("reopen"); },
        async refresh(): Promise<DeferredTweakersVariantRefresh> { throw new Error("must not create a new promotion"); },
        readRuntimeReady: () => ({ operationId: FIRST_OPERATION }), now: () => 0, async sleep() {},
        sealedAccountsRuntimeRoot: () => join(root, "sealed-runtime"), verifyAccountsTransferRecovery: () => true,
        prepareAccountContinuity: () => ({ state: "ready" as const, reason: "already-current" as const }),
      };
      const execute = createSealedIndependentBackendRecoveryExecutorForTest(() => root, lifecycle, {
        readEvidence(managerRoot, id) {
          assert.equal(managerRoot, root); assert.equal(id, FIRST_OPERATION);
          return { binding, journalSha256: scenario === "evidence-drift" && ++reads > 1 ? "f".repeat(64) : "e".repeat(64),
            committed: scenario === "already-committed" };
        },
        async resume(input, managerRoot, assertClosedAdmission) {
          assert.equal(held, true); assert.equal(managerRoot, root);
          assert.deepEqual(input, { userRoot: binding.userRoot, target: binding.target, promotionId: binding.promotionId,
            operationId: FIRST_OPERATION, expectedJournalSha256: "e".repeat(64) });
          if (scenario === "appearing-process") appeared = true;
          assertClosedAdmission(); events.push("replay");
          return { ...fakeDeferredRefresh(binding.userRoot, FIRST_OPERATION, events,
            scenario === "canary-failure" ? new Error("canary failed") : undefined), recoveryMode: "forward-only" as const };
        },
        settle(managerRoot, id) { assert.equal(managerRoot, root); assert.equal(id, FIRST_OPERATION); events.push("settle"); return true; },
      });
      if (scenario === "success" || scenario === "already-committed") await execute(FIRST_OPERATION);
      else await assert.rejects(() => execute(FIRST_OPERATION));
      assert.deepEqual(events, scenario === "success" ? ["reserve", "replay", "release", "reopen", "runtime-ready:513", "commit", "settle"]
        : scenario === "already-committed" ? ["settle"] : scenario === "admission-denied" ? ["reserve"]
        : scenario === "canary-failure" ? ["reserve", "replay", "release", "reopen", "retain"] : ["reserve", "release"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted runtime repair Manager replays accepted proof and each active rename gap under closed admission without a relaunch or compensation",async()=>{
  for(const phase of ["acceptance:verified","active:archive-planned","active:archived","active:promote-planned","active:promoted","committed"] as const) {
    for(const scenario of ["success","admission-denied","appearing-process","proof-drift","settlement-failure"] as const) {
      let held=false,appeared=false;const events:string[]=[];
      const lifecycle={reserveCutover:async()=>{events.push("reserve");if(scenario==="admission-denied")throw new Error("broker not closed");held=true;return{async release(){held=false;events.push("release");}};},
        observe:()=>appeared?processObservation({pid:999,visibleWindow:true}):null,relatedPids:()=>[],
        quit(){assert.fail("must not quit");},signal(){assert.fail("must not signal");},reopen(){assert.fail("accepted gaps must not relaunch");},
        listProcesses:()=>[],async refresh():Promise<DeferredTweakersVariantRefresh>{assert.fail("must not stage a new promotion");},
        readRuntimeReady:()=>null,now:()=>0,async sleep(){},sealedAccountsRuntimeRoot:()=>"/unused",verifyAccountsTransferRecovery:()=>true,
        prepareAccountContinuity:()=>({state:"ready" as const,reason:"already-current" as const})};
      const verify=()=>{assert.equal(held,true);events.push("verify");if(scenario==="proof-drift")throw new Error("immutable acceptance signature changed");};
      const executor=createSealedAcceptedRuntimeRepairExecutorForTest(lifecycle,{
        readAcceptedRuntimeRepairRecord:()=>({publication:{phase},root:"/private/fixed-child"}) as any,
        readAuthenticatedAcceptedRuntimeRepair:()=>{verify();return{phase:"committed"} as any;},
        finishAcceptedRuntimeRepairFromRetainedAcceptance(id,guard){assert.equal(id,FIRST_OPERATION);if(scenario==="appearing-process")appeared=true;guard();verify();events.push("publish");},
        settleAcceptedRuntimeRepair(id){assert.equal(id,FIRST_OPERATION);assert.equal(held,true);events.push("settle");return scenario!=="settlement-failure";},
        resumeAcceptedRuntimeRepair(){assert.fail("durable acceptance must use exact closed replay");},
      });
      if(scenario==="success"||phase==="committed"&&scenario==="appearing-process")await executor(FIRST_OPERATION);
      else await assert.rejects(()=>executor(FIRST_OPERATION));
      assert.equal(held,false);
      assert.equal(events.filter(event=>event==="reserve").length,1,"no re-reservation/compensation after failure");
      if(scenario!=="admission-denied")assert.equal(events.at(-1),"release");
      if(scenario==="proof-drift")assert.equal(events.includes("settle"),false);
    }
  }
});

test("sealed independent refresh stops only captured exact-path helpers before rebuilding", async () => {
  const root = fixtureRoot();
  try {
    const helper = {
      pid: 5691,
      ppid: 1,
      startedAt: "2026-09-03T05:04:43.000Z",
      startedAtRaw: "Thu Sep  3 01:04:43 2026",
      command: "/Applications/Tweakers.app/Contents/Frameworks/browser_crashpad_handler",
    };
    let processes = [helper];
    let reopened = false;
    const events: string[] = [];
    const execute = createSealedIndependentRefreshExecutorForTest(() => root, {
      observe: () => reopened ? processObservation({ pid: 513, visibleWindow: true }) : null,
      quit: () => { throw new Error("main app is already closed"); },
      relatedPids: () => processes.map((entry) => entry.pid),
      listProcesses: () => processes,
      signal(pid, signal): void {
        events.push(`signal:${pid}:${signal}`);
        if (pid === helper.pid && signal === "SIGTERM") processes = [];
      },
      reopen: (app): void => { events.push(`reopen:${app}`); reopened = true; },
      async refresh(request, execution, _sourceAuthorityRoot, beforePromotion): Promise<DeferredTweakersVariantRefresh> {
        events.push(`refresh:${request.app}<-${request.source === undefined ? "sealed-default-source" : request.source}`);
        await beforePromotion();
        return fakeDeferredRefresh(root, execution.operationId, events);
      },
      readRuntimeReady: () => ({ operationId: FIRST_OPERATION }),
      now: () => 0,
      async sleep(): Promise<void> {},
      sealedAccountsRuntimeRoot: () => join(root, "sealed-runtime"),
      verifyAccountsTransferRecovery: () => true,
      prepareAccountContinuity: () => ({ state: "ready", reason: "already-current" }),
    });

    await execute({ operationId: FIRST_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST });
    assert.deepEqual(events, [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "signal:5691:SIGTERM",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:513",
      "commit",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed independent refresh retains helper identity when quitting reparents it to launchd", async () => {
  const root = fixtureRoot();
  try {
    const events: string[] = [];
    let appState: "running" | "closed" | "reopened" = "running";
    let helper: ProcessInfo | null = {
      pid: 5691,
      ppid: 412,
      startedAt: "2026-09-03T05:04:43.000Z",
      startedAtRaw: "Thu Sep  3 01:04:43 2026",
      command: "/Applications/Tweakers.app/Contents/Resources/native/bare-modifier-monitor --key DoubleCommand --immediate",
    };
    const execute = createSealedIndependentRefreshExecutorForTest(() => root, {
      observe: () => appState === "running"
        ? processObservation({ pid: 412, visibleWindow: true })
        : appState === "reopened"
          ? processObservation({ pid: 913, visibleWindow: true })
          : null,
      quit(app, pid): void {
        events.push(`quit:${app}:${pid}`);
        appState = "closed";
        if (helper !== null) helper = { ...helper, ppid: 1 };
      },
      relatedPids: () => [
        ...(appState === "running" ? [412] : []),
        ...(helper === null ? [] : [helper.pid]),
      ],
      listProcesses: () => helper === null ? [] : [helper],
      signal(pid, signal): void {
        events.push(`signal:${pid}:${signal}`);
        if (helper?.pid === pid && signal === "SIGTERM") helper = null;
      },
      reopen(app): void {
        events.push(`reopen:${app}`);
        appState = "reopened";
      },
      async refresh(request, execution, _sourceAuthorityRoot, beforePromotion): Promise<DeferredTweakersVariantRefresh> {
        events.push(`refresh:${request.app}<-${request.source === undefined ? "sealed-default-source" : request.source}`);
        await beforePromotion();
        return fakeDeferredRefresh(root, execution.operationId, events);
      },
      readRuntimeReady: () => ({ operationId: FIRST_OPERATION }),
      now: () => 0,
      async sleep(): Promise<void> {},
      sealedAccountsRuntimeRoot: () => join(root, "sealed-runtime"),
      verifyAccountsTransferRecovery: () => true,
      prepareAccountContinuity: () => ({ state: "ready", reason: "already-current" }),
    });

    await execute({ operationId: FIRST_OPERATION, sourceGenerationId: REGISTERED_SOURCE_GENERATION, sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST });
    assert.deepEqual(events, [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "signal:5691:SIGTERM",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:913",
      "commit",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed independent refresh leaves Tweakers closed when captured helper quiescence fails", async () => {
  const root = fixtureRoot();
  try {
    const events: string[] = [];
    let appState: "running" | "closed" | "reopened" = "running";
    let now = 0;
    const helper: ProcessInfo = {
      pid: 5691,
      ppid: 412,
      startedAt: "2026-09-03T05:04:43.000Z",
      startedAtRaw: "Thu Sep  3 01:04:43 2026",
      command: "/Applications/Tweakers.app/Contents/Frameworks/browser_crashpad_handler",
    };
    const execute = createSealedIndependentRefreshExecutorForTest(() => root, {
      observe: () => appState === "running" ? processObservation({ pid: 412, visibleWindow: true }) : null,
      quit(app, pid): void {
        events.push(`quit:${app}:${pid}`);
        appState = "closed";
      },
      relatedPids: () => appState === "running" ? [412, helper.pid] : [helper.pid],
      listProcesses: () => [helper],
      signal(pid, signal): void { events.push(`signal:${pid}:${signal}`); },
      reopen(app): void {
        events.push(`reopen:${app}`);
        appState = "reopened";
      },
      async refresh(request, execution, _sourceAuthorityRoot, beforePromotion): Promise<DeferredTweakersVariantRefresh> {
        events.push(`refresh:${request.app}<-${request.source === undefined ? "sealed-default-source" : request.source}`);
        await beforePromotion();
        return fakeDeferredRefresh(root, execution.operationId, events);
      },
      readRuntimeReady: () => null,
      now: () => now,
      async sleep(milliseconds): Promise<void> { now += milliseconds; },
      sealedAccountsRuntimeRoot: () => join(root, "sealed-runtime"),
      verifyAccountsTransferRecovery: () => true,
      prepareAccountContinuity: () => ({ state: "ready", reason: "already-current" }),
    });
    const status = refreshStatusSnapshot("refresh.independent");
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      status: () => status,
      async executeRefreshIndependent(execution) { await execute(execution); },
    });
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "refresh.independent",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });

    const result = await adapter.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE });

    assert.equal(result.outcome, "recovery-required");
    assert.equal(appState, "closed");
    assert.deepEqual(events, [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "signal:5691:SIGTERM",
      "signal:5691:SIGKILL",
    ]);
    assert.doesNotMatch(events.join("\n"), /reopen/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed independent refresh reopens a running Tweakers app after a clean rollback failure", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    refreshError: new Error("simulated ordinary refresh failure after rollback"),
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
    ],
    expectedProofPrefix: ["513:true"],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh leaves a running Tweakers app alone when preparation fails before the promotion hook", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    refreshBeforePromotionError: new Error("candidate static validation failed"),
    expectedOutcome: "recovery-required",
    expectedEvents: ["refresh:/Applications/Tweakers.app<-sealed-default-source"],
    expectedProofPrefix: [],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh cannot report success when reopening Tweakers fails", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    reopenError: new Error("exact Tweakers reopen was rejected"),
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "quit:/Applications/Tweakers.app:513",
      "rollback",
    ],
    expectedProofPrefix: [],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh cannot report success when Tweakers remains absent after reopening", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    reopenObservations: [],
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "rollback",
    ],
    expectedProofPrefix: ["none"],
    expectedSleepCalls: 120,
  });
});

test("sealed independent refresh rejects a reopened Tweakers observation with the stale pre-quit process identity", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    reopenObservations: [{ pid: 412, visibleWindow: true }],
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "rollback",
    ],
    expectedProofPrefix: ["412:true"],
    expectedSleepCalls: 120,
  });
});

test("sealed independent refresh accepts PID reuse only with a new process start token", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    reopenObservations: [{ pid: 412, visibleWindow: true, startedAtRaw: "start-412-reused" }],
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:412",
      "commit",
    ],
    expectedProofPrefix: ["412:true"],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh waits for runtime-ready when System Events reports the new PID hidden", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    reopenObservations: [{ pid: 913, visibleWindow: false }],
    runtimeReady: null,
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "rollback",
    ],
    expectedProofPrefix: ["913:false"],
    expectedSleepCalls: 240,
  });
});

test("sealed independent refresh accepts an exact-PID renderer receipt despite stale System Events visibility", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    reopenObservations: [{ pid: 913, visibleWindow: false }],
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:913",
      "commit",
    ],
    expectedProofPrefix: ["913:false"],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh completes after an eventual exact new Tweakers PID", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    reopenObservations: [
      { pid: 412, visibleWindow: true },
      { pid: 914, visibleWindow: false },
      { pid: 915, visibleWindow: true },
    ],
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:914",
      "commit",
    ],
    expectedProofPrefix: ["412:true", "914:false"],
    expectedSleepCalls: 1,
  });
});

test("sealed independent refresh accepts runtime-ready evidence after a late first visible renderer", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    reopenObservations: [
      ...Array.from({ length: 119 }, () => null),
      { pid: 915, visibleWindow: true },
    ],
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:915",
      "commit",
    ],
    expectedProofPrefix: ["none"],
    expectedSleepCalls: 119,
  });
});

test("sealed independent refresh gives a newly visible Tweakers renderer a full runtime-ready interval", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: true,
    reopenObservations: [
      ...Array.from({ length: 119 }, () => null),
      ...Array.from({ length: 242 }, () => ({ pid: 915, visibleWindow: true })),
    ],
    runtimeReady: null,
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "quit:/Applications/Tweakers.app:915",
      "rollback",
    ],
    expectedProofPrefix: ["none"],
    expectedSleepCalls: 359,
  });
});

test("sealed independent refresh waits for signed native preparation before accepting delayed real readiness", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: false,
    reopenObservations: Array.from({ length: 706 }, () => ({ pid: 513, visibleWindow: true })),
    runtimeReadyAfterMs: 176_250,
    runtimeReadyTimeoutMs: 660_000,
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: ["refresh:/Applications/Tweakers.app<-sealed-default-source", "reopen:/Applications/Tweakers.app", "runtime-ready:513", "commit"],
    expectedProofPrefix: ["513:true"],
    expectedSleepCalls: 705,
  });
});

test("sealed independent refresh keeps the ordinary deadline without a verified preparation extension", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: false,
    reopenObservations: Array.from({ length: 242 }, () => ({ pid: 513, visibleWindow: true })),
    runtimeReadyAfterMs: 176_250,
    expectedOutcome: "recovery-required",
    expectedEvents: ["refresh:/Applications/Tweakers.app<-sealed-default-source", "reopen:/Applications/Tweakers.app", "quit:/Applications/Tweakers.app:513", "rollback"],
    expectedProofPrefix: ["513:true"],
    expectedSleepCalls: 240,
  });
});

test("sealed independent refresh rejects an unbounded preparation deadline before reopening", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: FIRST_OPERATION,
    running: false,
    runtimeReadyTimeoutMs: 660_001,
    expectedOutcome: "recovery-required",
    expectedEvents: ["refresh:/Applications/Tweakers.app<-sealed-default-source", "rollback"],
    expectedProofPrefix: [],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh leaves Tweakers closed after an incomplete rollback", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    refreshError: new AggregateError(
      [new Error("refresh failed"), new Error("rollback could not restore prior app")],
      "Variant promotion failed and its automatic rollback was incomplete. Retained generations are available for recovery.",
    ),
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
    ],
    expectedProofPrefix: [],
    expectedSleepCalls: 0,
  });
});

test("deployment refresh executors are exact-targeted and cannot share a generic lane", () => {
  const source = readFileSync(new URL("../src/manager-action-adapter.ts", import.meta.url), "utf8");
  const injectedExecutorSource = source.slice(
    source.indexOf("function createSealedInjectedRefreshExecutor"),
    source.indexOf("function createSealedIndependentRefreshLifecycle"),
  );
  assert.match(injectedExecutorSource, /acquireRegisteredOfficialSourceLease\(root\)/);
  assert.match(injectedExecutorSource, /verifySealedManagerRuntimeAssets/);
  assert.match(injectedExecutorSource, /verifySealedManagerManagedRuntimeAssets/);
  assert.match(injectedExecutorSource, /new InstallerEnvironmentCoordinator\(/);
  assert.match(injectedExecutorSource, /createId: \(\) => execution\.operationId/);
  assert.match(injectedExecutorSource, /sealedCandidateSourceApp: candidateSource/);
  assert.doesNotMatch(injectedExecutorSource, /createDesktopUpdateTransaction|Sparkle|requirePreparedCandidate|\binstall\(/);
  assert.match(source, /case "refresh\.injected"[\s\S]*?assertInjectedRefreshExecutionResult\(result, record\.operationId, record\)[\s\S]*?injected-tweakers-runtime-verified/);
  assert.match(
    source,
    /createSealedTweakersManagerActionAdapter[\s\S]*?createSealedIndependentRefreshExecutor\(userRoot\)[\s\S]*?executeRefreshIndependent\(input[\s\S]*?executeIndependentRefresh\(input, timing\)/,
  );
  assert.match(source, /createSealedIndependentRefreshExecutor[\s\S]*?const managerUserRoot = userRoot\(\)[\s\S]*?refresh\(refreshInput, execution, managerUserRoot, beforePromotion, beforeRollback\)[\s\S]*?reopenAndProveIndependentTweakers/);
  assert.match(source, /quiesceIndependentTweakers[\s\S]*?relatedPids\(INDEPENDENT_TWEAKERS_APP\)[\s\S]*?lifecycle\.quit\(INDEPENDENT_TWEAKERS_APP, observed\.pid\)[\s\S]*?"SIGTERM"[\s\S]*?"SIGKILL"[\s\S]*?relatedPids\(INDEPENDENT_TWEAKERS_APP\)/);
  assert.match(source, /reopenAndProveIndependentTweakers[\s\S]*?observed\.pid !== previous\.pid[\s\S]*?processStartToken !== previous\.startedAtRaw[\s\S]*?runtimeReadyDeadline \?\?=[\s\S]*?deferred\.verifyRuntimeReady[\s\S]*?await lifecycle\.sleep\(INDEPENDENT_REOPEN_PROOF_POLL_MS\)/);
  assert.match(source, /createSealedIndependentRefreshLifecycle[\s\S]*?prepareDeferredTweakersVariantRefresh\(\{[\s\S]*?runtimeReadyOperationId: execution\.operationId,[\s\S]*?environmentAuthoritySourceRoot: \(\) => sourceAuthorityRoot,[\s\S]*?beforePromotion: async \(\{ target, userRoot \}\)[\s\S]*?target !== input\.app[\s\S]*?userRoot !== input\.userRoot/);
  const independentExecutorSource = source.slice(
    source.indexOf("function createSealedIndependentRefreshExecutor"),
    source.indexOf("async function quiesceIndependentTweakers"),
  );
  assert.match(independentExecutorSource, /const refreshInput: IndependentRefreshInput = \{[\s\S]*?app: INDEPENDENT_TWEAKERS_APP,[\s\S]*?userRoot: join\(managerUserRoot, "variants", "tweakers"\)/);
  assert.doesNotMatch(independentExecutorSource, /\bsource\s*:/);
  assert.match(source, /reopen\(app: string\): void \{[\s\S]*?if \(app !== INDEPENDENT_TWEAKERS_APP\) throw[\s\S]*?openAndActivateCodex\(app,/);
  assert.doesNotMatch(source, /reopen: openAndActivateCodex|reopen: openCodex|\bopenCodex\(app/);
  assert.doesNotMatch(source, /independentRefreshLifecycleForTest/);
  assert.match(source, /refresh\.injected[\s\S]*?injected-chatgpt-patch/);
  assert.match(source, /refresh\.independent[\s\S]*?independent-tweakers-patch/);
  assert.doesNotMatch(source, /refresh\.full/);
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-adapter-"));
  writeEnvironmentReceipt(root, "prepared");
  return root;
}

function writeEnvironmentReceipt(root: string, phase: string): void {
  const path = managerStatusPaths(root).environmentTransactionFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    kind: "environment",
    transactionId: "environment-1",
    phase,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...(phase === "cancelled" ? { cancelledAt: NOW } : {}),
  }), "utf8");
}

function writeDesktopReceipt(root: string, phase: string, resumable: boolean): void {
  const path = managerStatusPaths(root).desktopUpdateReceiptFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    kind: "desktop-update",
    transactionId: "desktop-1",
    phase,
    resumable,
    safeOfficialMode: true,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...(phase === "completed" ? { completedAt: NOW, terminalAt: NOW } : {}),
    ...(phase === "rolled_back" ? { rolledBackAt: NOW, terminalAt: NOW } : {}),
  }), "utf8");
}

function snapshot(root: string, enabledActionIds: readonly TweakersManagerActionIdV1[] = []) {
  return createTweakersManagerStatusSnapshot({ executable: EXECUTABLE, paths: managerStatusPaths(root), enabledActionIds }, {
    ...fixtureStatusDependencies(),
  });
}

function fixtureStatusDependencies() {
  return { registeredOfficialSource: () => readyRegisteredOfficialSource() };
}

async function assertSplitRefreshDispatch(input: {
  actionId: "refresh.injected" | "refresh.independent";
  operationId: string;
  target: string;
  outcome: string;
}): Promise<void> {
  const root = fixtureRoot();
  try {
    let executions = 0;
    const status = refreshStatusSnapshot(input.actionId);
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      status: () => status,
      ...(input.actionId === "refresh.injected"
        ? { managerRuntimeFingerprint: () => MANAGER_RUNTIME_FINGERPRINT }
        : {}),
      ...(input.actionId === "refresh.injected"
        ? {
          async executeRefreshInjected(execution: InjectedRefreshExecutionInput): Promise<InjectedRefreshExecutionResult> {
            executions += 1;
            assert.deepEqual(execution, {
              operationId: input.operationId,
              consumedAt: NOW,
              sourceGenerationId: REGISTERED_SOURCE_GENERATION,
              sourceReceiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST,
              sourceDigest: REGISTERED_SOURCE_CANDIDATE_DIGEST,
              sourceRevision: `sha256:${"c".repeat(64)}`,
              managerRuntimeFingerprint: MANAGER_RUNTIME_FINGERPRINT,
              selectionRevision: SELECTION_REVISION,
              registryRevision: REGISTRY_REVISION,
            });
            return injectedRefreshResult(execution.operationId, 41, 42);
          },
        }
        : { async executeRefreshIndependent() { executions += 1; } }),
    });
    const prepared = await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: input.operationId,
      actionId: input.actionId,
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    assert.equal(prepared.prepared, true);
    assert.equal(new ManagerOperationStore(root).read(input.operationId)?.receiptRefs[0], input.target);

    const result = await adapter.execute({ operationId: input.operationId, executable: EXECUTABLE });
    assert.equal(executions, 1);
    assert.equal(result.outcome, input.outcome);
    assert.deepEqual(
      result.receiptRefs,
      input.actionId === "refresh.injected"
        ? [input.target, `environment:${input.operationId}`]
        : [input.target],
    );
    assert.equal(new ManagerOperationStore(root).read(input.operationId)?.phase, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertSealedIndependentRefreshLifecycle(input: {
  operationId: string;
  running: boolean;
  refreshError?: Error;
  refreshBeforePromotionError?: Error;
  reopenError?: Error;
  reopenObservations?: Array<TestProcessObservation | null>;
  runtimeReady?: unknown | null;
  runtimeReadyAfterMs?: number;
  runtimeReadyTimeoutMs?: number;
  runtimeReadyError?: Error;
  continuityError?: Error;
  continuityDeferred?: boolean;
  expectedOutcome: "rebuilt-independent-tweakers" | "recovery-required";
  expectedEvents: readonly string[];
  expectedProofPrefix: readonly string[];
  expectedSleepCalls: number;
}): Promise<void> {
  const root = fixtureRoot();
  try {
    const events: string[] = [];
    const processTargets: string[] = [];
    const initialObservations: Array<TestProcessObservation | null> = input.running
      ? [{ pid: 412, visibleWindow: true }, null]
      : [null];
    const reopenObservations = input.reopenObservations
      ? [...input.reopenObservations]
      : input.running
        ? [{ pid: 513, visibleWindow: true }]
        : [{ pid: 513, visibleWindow: true }];
    const proofObservations: string[] = [];
    let currentReopenObservation: (TestProcessObservation & { startedAtRaw: string }) | null = null;
    let reopenRequested = false;
    let now = 0;
    let sleepCalls = 0;
    const refreshRequests: Array<{ app: string; source?: string; userRoot: string }> = [];
    const sourceAuthorityRoots: string[] = [];
    const lifecycle = {
      observe(app: string): (TestProcessObservation & { startedAtRaw: string }) | null {
        processTargets.push(app);
        const observation = processObservation((reopenRequested ? reopenObservations : initialObservations).shift() ?? null);
        if (reopenRequested) {
          currentReopenObservation = observation;
          proofObservations.push(observation === null ? "none" : `${observation.pid}:${observation.visibleWindow}`);
        }
        return observation;
      },
      quit(app: string, expectedPid: number): void {
        processTargets.push(app);
        events.push(`quit:${app}:${expectedPid}`);
      },
      relatedPids(app: string): number[] {
        processTargets.push(app);
        return [];
      },
      listProcesses: () => [],
      signal: () => { throw new Error("no captured helpers should be signalled in this fixture"); },
      reopen(app: string): void {
        processTargets.push(app);
        events.push(`reopen:${app}`);
        reopenRequested = true;
        if (input.reopenError) throw input.reopenError;
      },
      async refresh(
        request: { app: string; source?: string; userRoot: string },
        execution: { operationId: string; sourceGenerationId: string; sourceReceiptDigest: string },
        sourceAuthorityRoot: string,
        beforePromotion: () => Promise<void>,
      ): Promise<DeferredTweakersVariantRefresh> {
        refreshRequests.push(request);
        sourceAuthorityRoots.push(sourceAuthorityRoot);
        assert.equal(execution.sourceGenerationId, REGISTERED_SOURCE_GENERATION);
        assert.equal(execution.sourceReceiptDigest, REGISTERED_SOURCE_RECEIPT_DIGEST);
        events.push(`refresh:${request.app}<-${request.source === undefined ? "sealed-default-source" : request.source}`);
        if (input.refreshBeforePromotionError) throw input.refreshBeforePromotionError;
        await beforePromotion();
        if (input.refreshError) throw input.refreshError;
        return fakeDeferredRefresh(request.userRoot, execution.operationId, events, input.runtimeReadyError);
      },
      readRuntimeReady(): unknown | null {
        if (currentReopenObservation === null) return null;
        if (input.runtimeReadyAfterMs !== undefined && now < input.runtimeReadyAfterMs) return null;
        return input.runtimeReady === undefined ? { operationId: input.operationId } : input.runtimeReady;
      },
      ...(input.runtimeReadyTimeoutMs !== undefined ? { runtimeReadyTimeoutMs: () => input.runtimeReadyTimeoutMs! } : {}),
      now(): number {
        return now;
      },
      async sleep(milliseconds: number): Promise<void> {
        assert.equal(milliseconds, 250);
        sleepCalls += 1;
        now += milliseconds;
      },
      sealedAccountsRuntimeRoot: () => join(root, "sealed-runtime"),
      verifyAccountsTransferRecovery: () => true,
      prepareAccountContinuity: () => {
        if (input.continuityError) throw input.continuityError;
        if (input.continuityDeferred) return { state: "deferred" as const, reason: "account-busy" as const };
        return { state: "ready" as const, reason: "already-current" as const };
      },
    };
    const status = refreshStatusSnapshot("refresh.independent");
    const executeIndependentRefresh = createSealedIndependentRefreshExecutorForTest(() => root, lifecycle);
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      status: () => status,
      async executeRefreshIndependent(execution, timing) {
        await executeIndependentRefresh(execution, timing);
      },
    });
    await adapter.prepare({
      requestId: REQUEST_ID,
      operationId: input.operationId,
      actionId: "refresh.independent",
      stateToken: status.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    const result = await adapter.execute({ operationId: input.operationId, executable: EXECUTABLE });

    assert.equal(result.outcome, input.expectedOutcome);
    const stored = new ManagerOperationStore(root).read(input.operationId);
    assert.equal(stored?.phase,
      input.expectedOutcome === "recovery-required" ? "recovery-required" : "completed");
    if (input.expectedOutcome === "rebuilt-independent-tweakers") {
      assert.equal(stored?.timing?.phases["patch-stage"].state, "completed");
      assert.equal(stored?.timing?.phases["runtime-ready-wait"].state, "completed");
      assert.equal(stored?.timing?.phases["source-validation"].state, "unavailable");
      assert.equal(stored?.timing?.phases["quiesce-promote"].state, "completed");
    }
    assert.deepEqual(events, input.expectedEvents);
    if (input.refreshBeforePromotionError) {
      assert.deepEqual(processTargets, []);
    } else {
      assert.ok(processTargets.length > 0);
      assert.ok(processTargets.every((app) => app === "/Applications/Tweakers.app"));
    }
    assert.deepEqual(proofObservations.slice(0, input.expectedProofPrefix.length), input.expectedProofPrefix);
    assert.equal(sleepCalls, input.expectedSleepCalls);
    assert.deepEqual(refreshRequests, [{
      app: "/Applications/Tweakers.app",
      userRoot: join(root, "variants", "tweakers"),
    }]);
    assert.equal(Object.hasOwn(refreshRequests[0]!, "source"), false);
    assert.deepEqual(sourceAuthorityRoots, [root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("sealed independent refresh keeps Tweakers closed when continuity fails after a partial apply", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    continuityError: new Error("account continuity rebase requires recovery after partial apply"),
    expectedOutcome: "recovery-required",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
    ],
    expectedProofPrefix: [],
    expectedSleepCalls: 0,
  });
});

test("sealed independent refresh completes while a busy shared helper safely postpones migration", async () => {
  await assertSealedIndependentRefreshLifecycle({
    operationId: SECOND_OPERATION,
    running: true,
    continuityDeferred: true,
    expectedOutcome: "rebuilt-independent-tweakers",
    expectedEvents: [
      "refresh:/Applications/Tweakers.app<-sealed-default-source",
      "quit:/Applications/Tweakers.app:412",
      "reopen:/Applications/Tweakers.app",
      "runtime-ready:513",
      "commit",
    ],
    expectedProofPrefix: ["513:true"],
    expectedSleepCalls: 0,
  });
});

function fakeDeferredRefresh(
  userRoot: string,
  operationId: string,
  events: string[],
  runtimeReadyError?: Error,
): DeferredTweakersVariantRefresh {
  let settled = false;
  return {
    target: "/Applications/Tweakers.app",
    userRoot,
    runtimeReadyExpectation: {
      operationId,
    } as unknown as DeferredTweakersVariantRefresh["runtimeReadyExpectation"],
    verifyRuntimeReady(value: unknown, pid: number, processStartToken: string): void {
      if (settled) throw new Error("fixture refresh was already finalized");
      if (runtimeReadyError) throw runtimeReadyError;
      assert.deepEqual(value, { operationId });
      assert.equal(processStartToken.length > 0, true);
      events.push(`runtime-ready:${pid}`);
    },
    commit(): void {
      if (settled) throw new Error("fixture refresh was already finalized");
      settled = true;
      events.push("commit");
    },
    retain(): void {
      if (settled) throw new Error("fixture refresh was already finalized");
      settled = true; events.push("retain");
    },
    rollback(): void {
      if (settled) throw new Error("fixture refresh was already finalized");
      settled = true;
      events.push("rollback");
    },
  };
}

function refreshStatusSnapshot(actionId: "refresh.injected" | "refresh.independent") {
  return {
    protocolVersion: 1,
    managerId: "com.thomashulihan.tweakers",
    generatedAt: NOW,
    stateToken: `sha256:${"b".repeat(64)}` as const,
    status: {
      installation: { revision: "injected-revision" },
      tweakersPatch: { installedVersion: "independent-version" },
      environment: {
        registeredStableSource: readyRegisteredOfficialSource(),
        selection: { revision: SELECTION_REVISION },
        registry: { revision: REGISTRY_REVISION },
      },
      operations: { activeOperationId: null },
      receipts: [],
    },
    actions: [{ actionId, available: true, reason: "fixture refresh action" }],
    stateTokenInputs: { receiptChronology: [] },
  } as unknown as ReturnType<typeof createTweakersManagerStatusSnapshot>;
}

function injectedRefreshBinding(): string {
  return [
    "injected-chatgpt-patch",
    "v1",
    REGISTERED_SOURCE_GENERATION,
    REGISTERED_SOURCE_RECEIPT_DIGEST,
    REGISTERED_SOURCE_CANDIDATE_DIGEST,
    `sha256:${"c".repeat(64)}`,
    MANAGER_RUNTIME_FINGERPRINT,
    SELECTION_REVISION,
    REGISTRY_REVISION,
  ].join(":");
}

function injectedRefreshResult(
  transactionId: string,
  oldMainPid: number | null,
  newMainPid: number,
): InjectedRefreshExecutionResult {
  return {
    transactionId,
    phase: "committed",
    oldMainPid,
    newMainPid,
    runtimeVerified: true,
    applied: {
      observedAt: NOW,
      selection: {
        selectedDesktopPath: "/Applications/ChatGPT.app",
        selectedDesktopBundleId: "com.openai.codex",
        releaseProfile: "stable",
        appExperience: "tweakers",
        backendLane: "official-bundled",
        uiFeatures: "on",
        mcpSafetyProvider: "managed-turn-idle",
        recoveryState: "normal-protected",
        migrationState: "verified",
        quarantineReason: null,
        requestedAt: NOW,
        appliedAt: NOW,
      },
      desktopVersion: "26.831.21537",
      desktopBuild: "7579",
      backendVersion: "26.831.21537",
      desktopArtifactDigest: "3".repeat(64),
      asarHeaderHash: "4".repeat(64),
      backendArtifactDigest: "5".repeat(64),
    },
  };
}

function officialSourceRegistrationStatusSnapshot(
  candidateDigest = REGISTERED_SOURCE_CANDIDATE_DIGEST,
  stateToken: `sha256:${string}` = `sha256:${"f".repeat(64)}`,
) {
  return {
    protocolVersion: 1,
    managerId: "com.thomashulihan.tweakers",
    generatedAt: NOW,
    stateToken,
    status: {
      installation: { revision: "fixture" },
      tweakersPatch: { installedVersion: "independent-version" },
      environment: {
        registeredStableSource: {
          ...readyRegisteredOfficialSource(),
          state: "missing" as const,
          generationId: null,
          receiptDigest: null,
          artifactPath: null,
          sourceDigest: null,
          candidateDigest,
        },
      },
      operations: { activeOperationId: null },
      receipts: [],
    },
    actions: [{ actionId: "official-source.register", available: true, reason: "fixture registration action" }],
    stateTokenInputs: { receiptChronology: [] },
  } as unknown as ReturnType<typeof createTweakersManagerStatusSnapshot>;
}

function readyRegisteredOfficialSource() {
  return {
    state: "ready" as const,
    generationId: REGISTERED_SOURCE_GENERATION,
    receiptDigest: REGISTERED_SOURCE_RECEIPT_DIGEST,
    artifactPath: `/private/tweakers/official-source/generations/${REGISTERED_SOURCE_GENERATION}/ChatGPT.app`,
    version: "26.831.21537",
    build: "7579",
    candidateDigest: REGISTERED_SOURCE_CANDIDATE_DIGEST,
    sourceDigest: REGISTERED_SOURCE_CANDIDATE_DIGEST,
    revision: `sha256:${"c".repeat(64)}`,
    problem: null,
  };
}

async function assertAdapterError(body: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(body, (error: unknown) => error instanceof ManagerActionAdapterError && error.code === code);
}

test("accepted runtime repair Manager fences actual successor approval publication and preserves unfenced V1 compatibility",async()=>{
  for(const scenario of ["v1","success","admission-denied","desktop-present","broker-present","appearance-before-write","approval-failed"] as const) {
    let held=false,appeared=false;const events:string[]=[];
    const lifecycle={reserveCutover:async()=>{events.push("reserve");if(scenario==="admission-denied")throw new Error("broker admission denied");held=true;
      return{async release(){held=false;events.push("release");}};},
      observe:()=>scenario==="desktop-present"||appeared?processObservation({pid:999,visibleWindow:true}):null,
      relatedPids:()=>scenario==="broker-present"?[555]:[]};
    const execute=createSealedAcceptedRuntimeRepairApprovalExecutorForTest(lifecycle as any,{
      acceptedRuntimeRepairApprovalRequiresClosedAdmission(id,fp){assert.equal(id,FIRST_OPERATION);assert.equal(fp,"sha256:"+"a".repeat(64));events.push("classify");return scenario!=="v1";},
      approveAcceptedRuntimeRepair(id,fp,guard){assert.equal(id,FIRST_OPERATION);assert.equal(fp,"sha256:"+"a".repeat(64));
        if(scenario==="v1"){assert.equal(held,false);assert.equal(guard,undefined);events.push("write");return{} as any;}
        assert.equal(held,true);assert.ok(guard);if(scenario==="appearance-before-write")appeared=true;
        guard();if(scenario==="approval-failed")throw new Error("signed review drift");events.push("write");return{} as any;},
    });
    if(scenario==="v1"||scenario==="success")await execute(FIRST_OPERATION,"sha256:"+"a".repeat(64));
    else await assert.rejects(execute(FIRST_OPERATION,"sha256:"+"a".repeat(64)));
    assert.equal(held,false);
    assert.deepEqual(events,scenario==="v1"?["classify","write"]:scenario==="success"?["classify","reserve","write","release"]:
      scenario==="admission-denied"?["classify","reserve"]:["classify","reserve","release"]);
  }
});

test("native replacement fences the actual handoff and always releases desktop and broker admission",async()=>{
  for(const scenario of ["success","admission-denied","desktop-present","broker-present","appearance-before-move","retirement-failed"] as const) {
    let held=false,appeared=false;const events:string[]=[];
    const lifecycle={reserveCutover:async()=>{events.push("reserve");if(scenario==="admission-denied")throw new Error("broker admission denied");held=true;
      return{async release(){held=false;events.push("release");}};},
      observe:()=>scenario==="desktop-present"||appeared?processObservation({pid:999,visibleWindow:true}):null,
      relatedPids:()=>scenario==="broker-present"?[555]:[]};
    const execute=createSealedNativeReplacementExecutorForTest(lifecycle as any,{
      async prepareAcceptedRuntimeNativeReplacement(id,guard){assert.equal(id,FIRST_OPERATION);assert.equal(held,true);
        if(scenario==="appearance-before-move")appeared=true;guard();
        if(scenario==="retirement-failed")throw new Error("old app custody changed");
        events.push("move");return{operationId:id,promotionId:SECOND_OPERATION,outcome:"superseded",retiredApp:"/Trash/exact",nativeBackendSha256:"a".repeat(64)};},
    });
    if(scenario==="success")await execute(FIRST_OPERATION);else await assert.rejects(execute(FIRST_OPERATION));
    assert.equal(held,false);assert.deepEqual(events,scenario==="success"?["reserve","move","release"]:scenario==="admission-denied"?["reserve"]:["reserve","release"]);
  }
});

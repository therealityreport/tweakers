import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ManagerActionAdapterError, TweakersManagerActionAdapter } from "../src/manager-action-adapter";
import type { TweakersManagerActionIdV1 } from "../src/manager-contract";
import { ManagerOperationStore } from "../src/manager-operation-store";
import { createTweakersManagerStatusSnapshot, managerStatusPaths } from "../src/manager-status";

const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";
const FIRST_OPERATION = "018f0d36-4c08-7a3e-9c1d-123456789abd";
const SECOND_OPERATION = "018f0d36-4c08-7a3e-9c1d-123456789abe";
const NOW = "2026-08-27T23:00:00.000Z";
const FUTURE = "2026-08-27T23:05:00.000Z";
const EXECUTABLE = { state: "resolved" as const, path: "/fixed/Tweakers Manager Launcher", sha256: "a".repeat(64) };

test("environment.cancel is status-bound, one-time, consumed before execution, and receipt-complete", async () => {
  const root = fixtureRoot();
  try {
    let now = NOW;
    const adapter = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => now,
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

test("desktop resume and cancellation require the captured durable receipt and terminal evidence", async () => {
  const root = fixtureRoot();
  try {
    writeEnvironmentReceipt(root, "cancelled");
    writeDesktopReceipt(root, "waiting_for_native_update", true);
    const resume = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      async executeDesktopResume(transactionId) {
        assert.equal(transactionId, "desktop-1");
        writeDesktopReceipt(root, "completed", false);
        return { transactionId, phase: "completed", resumable: false, safeOfficialMode: true };
      },
    });
    const first = snapshot(root, ["desktop-update.resume"]);
    assert.equal(first.actions.find((action) => action.actionId === "desktop-update.resume")?.available, true);
    await resume.prepare({
      requestId: REQUEST_ID,
      operationId: FIRST_OPERATION,
      actionId: "desktop-update.resume",
      stateToken: first.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    assert.equal((await resume.execute({ operationId: FIRST_OPERATION, executable: EXECUTABLE })).outcome, "resumed");

    writeDesktopReceipt(root, "waiting_for_native_update", true);
    const cancel = new TweakersManagerActionAdapter({
      userRoot: () => root,
      now: () => NOW,
      async executeDesktopCancel(transactionId) {
        assert.equal(transactionId, "desktop-1");
        writeDesktopReceipt(root, "rolled_back", false);
        return { transactionId, phase: "rolled_back", resumable: false, safeOfficialMode: true };
      },
    });
    const second = snapshot(root, ["desktop-update.cancel"]);
    await cancel.prepare({
      requestId: REQUEST_ID,
      operationId: SECOND_OPERATION,
      actionId: "desktop-update.cancel",
      stateToken: second.stateToken,
      expiresAt: FUTURE,
      parameters: {},
      executable: EXECUTABLE,
    });
    assert.equal((await cancel.execute({ operationId: SECOND_OPERATION, executable: EXECUTABLE })).outcome, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  return createTweakersManagerStatusSnapshot({ executable: EXECUTABLE, paths: managerStatusPaths(root), enabledActionIds });
}

async function assertAdapterError(body: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(body, (error: unknown) => error instanceof ManagerActionAdapterError && error.code === code);
}

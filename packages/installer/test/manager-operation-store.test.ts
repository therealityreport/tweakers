import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagerOperationStore, ManagerOperationStoreError } from "../src/manager-operation-store";
import { TWEAKERS_MANAGER_ID, type TweakersManagerPreparedOperationV1 } from "../src/manager-contract";

const OPERATION_ID = "018f0d36-4c08-7a3e-9c1d-123456789abd";
const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";
const NOW = "2026-08-27T23:00:00.000Z";
const LATER = "2026-08-27T23:05:00.000Z";

test("manager operation store atomically persists owner-only prepared records", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-operation-"));
  try {
    const store = new ManagerOperationStore(root);
    const record = preparedRecord();
    store.create(record);
    const file = store.file(OPERATION_ID);
    assert.equal(lstatSync(store.paths.root).mode & 0o7777, 0o700);
    assert.equal(lstatSync(file).mode & 0o7777, 0o600);
    assert.deepEqual(store.read(OPERATION_ID), record);
    assert.throws(() => store.create(record), ManagerOperationStoreError);

    const consumed = { ...record, phase: "consumed" as const, consumedAt: NOW };
    store.replace(consumed);
    assert.deepEqual(store.read(OPERATION_ID), consumed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager operation store rejects symlinked, loose-mode, duplicate-key, and mismatched records", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-operation-"));
  try {
    const store = new ManagerOperationStore(root);
    store.ensureRoot();
    const file = store.file(OPERATION_ID);
    writeFileSync(file, JSON.stringify(preparedRecord()));
    chmodSync(file, 0o644);
    assert.throws(() => store.read(OPERATION_ID), /mode 0600/);

    chmodSync(file, 0o600);
    writeFileSync(file, '{"schemaVersion":1,"schemaVersion":1}', "utf8");
    assert.throws(() => store.read(OPERATION_ID), /repeats key/);

    rmSync(file);
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(preparedRecord()));
    chmodSync(target, 0o600);
    symlinkSync(target, file);
    assert.throws(() => store.read(OPERATION_ID), /single-link regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function preparedRecord(): TweakersManagerPreparedOperationV1 {
  return {
    schemaVersion: 1,
    kind: "tweakers-manager-operation",
    managerId: TWEAKERS_MANAGER_ID,
    protocolVersion: 1,
    operationId: OPERATION_ID,
    preparedRequestId: REQUEST_ID,
    actionId: "environment.cancel",
    moduleIdentity: { state: "resolved", path: "/fixed/Tweakers Manager Launcher", sha256: "a".repeat(64) },
    boundStateToken: `sha256:${"b".repeat(64)}`,
    parameters: {},
    parametersSha256: `sha256:${"c".repeat(64)}`,
    impact: "restart-app",
    createdAt: NOW,
    expiresAt: LATER,
    phase: "prepared",
    consumedAt: null,
    cancelledAt: null,
    completedAt: null,
    failedAt: null,
    recoveryRequiredAt: null,
    stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
    receiptChronologyRevision: `sha256:${"e".repeat(64)}`,
    receiptSnapshot: [{ source: "environment", receiptId: "environment-1", phase: "prepared", revision: "sha256:receipt", active: true }],
    receiptRefs: ["environment:environment-1"],
    outcome: null,
    error: null,
  };
}

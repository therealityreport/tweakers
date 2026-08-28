import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTweakersManagerStatusSnapshot,
  managerStatusPaths,
  type ManagerStatusPaths,
} from "../src/manager-status";
import { ManagerOperationStore } from "../src/manager-operation-store";
import type { TweakersManagerPreparedOperationV1 } from "../src/manager-contract";

const NOW = "2026-08-27T12:00:00.000Z";

test("manager status is side-effect-free for a missing user root", () => {
  const parent = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const root = join(parent, "missing-user-root");
  try {
    const beforeFilesystem = directorySnapshot(parent);
    const beforeProcess = processSnapshot();

    const snapshot = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());

    assert.equal(snapshot.status.installation.state, "not-installed");
    assert.equal(snapshot.status.updater.state, "idle");
    assert.deepEqual(
      snapshot.status.receipts.map((receipt) => [receipt.source, receipt.state, receipt.revision]),
      [
        ["environment", "missing", "missing"],
        ["desktop-update", "missing", "missing"],
        ["environment-mode-cache", "missing", "missing"],
      ],
    );
    assert.equal(snapshot.status.coordinator.state, "idle");
    assert.equal(snapshot.actions.every((action) => action.available === false), true);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.status.receipts), true);
    assert.deepEqual(directorySnapshot(parent), beforeFilesystem);
    assert.deepEqual(processSnapshot(), beforeProcess);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("manager status retains malformed and partial receipt evidence without repairing it", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.environmentSelectionFile, "{\"releaseProfile\":\"stable\"}\n");
    writeFixture(paths.desktopUpdateReceiptFile, "{\"schemaVersion\":1,\"kind\":\"desktop-update\",\"transactionId\":\"update-1\"}\n");
    writeFixture(paths.environmentTransactionFile, "{not JSON\n");
    writeFixture(paths.environmentModeCacheCurrentFile, "{\"schemaVersion\":2,\"kind\":\"environment-mode-pair\"}\n");
    const beforeFilesystem = directorySnapshot(root);
    const beforeProcess = processSnapshot();

    const snapshot = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    const environmentReceipt = receipt(snapshot, "environment");
    const desktopReceipt = receipt(snapshot, "desktop-update");
    const cacheReceipt = receipt(snapshot, "environment-mode-cache");

    assert.equal(snapshot.status.environment.selection.state, "malformed");
    assert.equal(snapshot.status.updater.state, "malformed");
    assert.equal(environmentReceipt.state, "malformed");
    assert.match(environmentReceipt.problem ?? "", /invalid JSON/);
    assert.equal(desktopReceipt.state, "malformed");
    assert.equal(cacheReceipt.state, "malformed");
    assert.notEqual(environmentReceipt.revision, "malformed");
    assert.deepEqual(directorySnapshot(root), beforeFilesystem);
    assert.deepEqual(processSnapshot(), beforeProcess);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state tokens are deterministic and change when receipt chronology changes without a visible ABA change", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  try {
    const paths = managerStatusPaths(root);
    writeFixture(paths.configFile, "{\"tweaker\":{\"safeMode\":false}}\n");
    writeFixture(paths.stateFile, JSON.stringify({
      version: "1.0.0",
      installedAt: NOW,
      appRoot: "/Applications/ChatGPT.app",
      runtimeUpdatedAt: NOW,
      mode: "tweakers",
    }));
    writeFixture(paths.environmentSelectionFile, JSON.stringify({
      releaseProfile: "stable",
      appExperience: "tweakers",
      migrationState: "verified",
    }));
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("A")));

    const first = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    const repeated = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    assert.deepEqual(repeated, first);

    // This extra durable chronology marker is not presented as an operation
    // field. The visible receipt id/phase/timestamps return to the same values
    // (an ABA-shaped observation), while its exact receipt revision changes.
    writeFixture(paths.environmentTransactionFile, JSON.stringify({
      ...environmentReceipt("B"),
      chronologyMarker: "replacement-receipt-with-same-visible-state",
    }));
    const second = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    const firstReceipt = receipt(first, "environment");
    const secondReceipt = receipt(second, "environment");

    assert.equal(secondReceipt.receiptId, firstReceipt.receiptId);
    assert.equal(secondReceipt.phase, firstReceipt.phase);
    assert.equal(secondReceipt.updatedAt, firstReceipt.updatedAt);
    assert.notEqual(secondReceipt.revision, firstReceipt.revision);
    assert.notEqual(second.stateToken, first.stateToken);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager status can be collected from injected readers without touching the host filesystem", () => {
  const root = "/virtual/tweakers";
  const paths = managerStatusPaths(root);
  const files = new Map<string, string>([
    [paths.stateFile, JSON.stringify({ version: "1.0.0", installedAt: NOW, appRoot: "/Applications/ChatGPT.app", mode: "chatgpt" })],
    [paths.environmentTransactionFile, JSON.stringify(environmentReceipt("virtual-environment"))],
  ]);
  const reads: string[] = [];
  const snapshot = createTweakersManagerStatusSnapshot(statusInput(root), {
    now: () => NOW,
    readText(path) {
      reads.push(path);
      const text = files.get(path);
      return text === undefined ? { state: "missing" } : { state: "present", text };
    },
    readDirectory: () => ({ state: "missing" }),
  });

  assert.equal(existsSync(root), false);
  assert.equal(snapshot.status.installation.state, "installed");
  assert.equal(snapshot.status.coordinator.state, "active");
  assert.equal(receipt(snapshot, "environment").receiptId, "environment-1");
  assert.equal(reads.includes(paths.environmentTransactionFile), true);
});

test("status reconciles a crash-consumed record only from its matching terminal receipt without reopening it", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-status-"));
  const operationId = "018f0d36-4c08-7a3e-9c1d-123456789abd";
  try {
    const paths = managerStatusPaths(root);
    // This is the receipt chronology captured at prepare time.
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("before-consume")));
    const store = new ManagerOperationStore(root);
    store.create(consumedEnvironmentCancelRecord(operationId));

    // Simulate a hard kill after `consumed` was fsynced but after the legacy
    // writer made the same receipt terminal, before the manager could replace
    // its own record with `completed`.
    writeFixture(paths.environmentTransactionFile, JSON.stringify(terminalEnvironmentReceipt("environment-1", "cancelled")));
    const beforeStatus = directorySnapshot(root);
    const reconciled = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());

    assert.equal(reconciled.status.operations.state, "valid");
    assert.equal(reconciled.status.operations.activeOperationId, null);
    assert.equal(reconciled.status.operations.preparedCount, 0);
    assert.equal(store.read(operationId)?.phase, "consumed");
    assert.deepEqual(directorySnapshot(root), beforeStatus, "status must not rewrite a consumed record");

    // A matching but non-terminal receipt cannot clear the barrier.  It also
    // proves reconciliation is a projection, never a reopening to prepared.
    writeFixture(paths.environmentTransactionFile, JSON.stringify(environmentReceipt("still-active")));
    const stillBlocked = createTweakersManagerStatusSnapshot(statusInput(root), fixedDependencies());
    assert.equal(stillBlocked.status.operations.activeOperationId, operationId);
    assert.equal(stillBlocked.status.operations.preparedCount, 1);
    assert.equal(store.read(operationId)?.phase, "consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function statusInput(root: string): { executable: { state: "unresolved"; reason: string }; paths: ManagerStatusPaths } {
  return {
    executable: { state: "unresolved", reason: "descriptor publication is outside T2" },
    paths: managerStatusPaths(root),
  };
}

function fixedDependencies() {
  return { now: () => NOW };
}

function environmentReceipt(marker: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: "environment-1",
    phase: "prepared",
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    marker,
  };
}

function terminalEnvironmentReceipt(transactionId: string, phase: "cancelled" | "rolled-back"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId,
    phase,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...(phase === "cancelled" ? { cancelledAt: NOW } : { rolledBackAt: NOW }),
  };
}

function consumedEnvironmentCancelRecord(operationId: string): TweakersManagerPreparedOperationV1 {
  return {
    schemaVersion: 1,
    kind: "tweakers-manager-operation",
    managerId: "com.thomashulihan.tweakers",
    protocolVersion: 1,
    operationId,
    preparedRequestId: "018f0d36-4c08-7a3e-9c1d-123456789abc",
    actionId: "environment.cancel",
    moduleIdentity: { state: "resolved", path: "/fixed/Tweakers Manager Launcher", sha256: "a".repeat(64) },
    boundStateToken: `sha256:${"b".repeat(64)}`,
    parameters: {},
    parametersSha256: `sha256:${"c".repeat(64)}`,
    impact: "restart-app",
    createdAt: NOW,
    expiresAt: "2026-08-27T12:05:00.000Z",
    phase: "consumed",
    consumedAt: NOW,
    cancelledAt: null,
    completedAt: null,
    failedAt: null,
    recoveryRequiredAt: null,
    stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
    receiptChronologyRevision: `sha256:${"e".repeat(64)}`,
    receiptSnapshot: [{
      source: "environment",
      receiptId: "environment-1",
      phase: "prepared",
      revision: `sha256:${"f".repeat(64)}`,
      active: true,
    }],
    receiptRefs: ["environment:environment-1"],
    outcome: null,
    error: null,
  };
}

function receipt(
  snapshot: ReturnType<typeof createTweakersManagerStatusSnapshot>,
  source: "environment" | "desktop-update" | "environment-mode-cache",
) {
  const result = snapshot.status.receipts.find((candidate) => candidate.source === source);
  assert.ok(result, `expected ${source} receipt`);
  return result;
}

function writeFixture(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function directorySnapshot(root: string): readonly [string, string][] {
  if (!existsSync(root)) return [[".", "missing"]];
  const entries: [string, string][] = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryRelative = relative === "." ? entry.name : join(relative, entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([entryRelative, "directory"]);
        visit(path, entryRelative);
      } else if (entry.isFile()) {
        entries.push([entryRelative, `file:${readFileSync(path).toString("base64")}`]);
      } else {
        entries.push([entryRelative, "other"]);
      }
    }
  };
  entries.push([".", "directory"]);
  visit(root, ".");
  return entries;
}

function processSnapshot(): { pid: number; ppid: number; argv: readonly string[] } {
  return { pid: process.pid, ppid: process.ppid, argv: [...process.argv] };
}

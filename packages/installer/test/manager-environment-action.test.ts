import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEnvironmentProfileRegistry,
  createEnvironmentSelection,
  type EnvironmentSelection,
} from "../src/environment-profile";
import { EnvironmentTimingRecorder, type EnvironmentTimingClock } from "../src/environment-timing";
import {
  cancelPreparedEnvironmentTransaction,
  readEnvironmentTransactionReceipt,
  writeEnvironmentTransactionReceipt,
  type EnvironmentTransactionReceipt,
  type PreparedEnvironmentEvidence,
} from "../src/manager-environment-action";
import { createEnvironmentCoordinator } from "../src/environment-transaction";

const NOW = "2026-08-28T01:00:00.000Z";
const TRANSACTION_ID = "manager-safe-pre-cutover-cancel";

test("manager-safe cancellation has exact legacy receipt and archive parity", async () => {
  const managerRoot = fixtureRoot();
  const legacyRoot = fixtureRoot();
  try {
    const manager = fixtureReceipt();
    const legacy = fixtureReceipt();
    const managerFile = join(managerRoot, "transactions", "environment.json");
    const managerArchive = join(managerRoot, "transactions", "environment");
    writeEnvironmentTransactionReceipt(managerFile, manager.receipt);

    const managerResult = cancelPreparedEnvironmentTransaction({
      transactionFile: managerFile,
      receiptRoot: managerArchive,
      transactionId: TRANSACTION_ID,
      ownerPid: process.pid,
      now: () => NOW,
      timing: new EnvironmentTimingRecorder(fixedTimingClock()),
    });

    const coordinator = createEnvironmentCoordinator({ environmentRoot: legacyRoot }, {
      now: () => NOW,
      timingClock: fixedTimingClock(),
      processAlive: () => false,
    });
    writeEnvironmentTransactionReceipt(coordinator.transactionFile, legacy.receipt);
    const legacyResult = await coordinator.cancel(TRANSACTION_ID);

    assert.deepEqual(managerResult, legacyResult);
    assert.deepEqual(
      readEnvironmentTransactionReceipt(join(managerArchive, `${TRANSACTION_ID}.json`)),
      readEnvironmentTransactionReceipt(join(coordinator.receiptRoot, `${TRANSACTION_ID}.json`)),
    );
    assert.deepEqual(
      readEnvironmentTransactionReceipt(managerFile),
      readEnvironmentTransactionReceipt(coordinator.transactionFile),
    );
    assert.equal(managerResult.phase, "cancelled");
    assert.equal(managerResult.error, null);
    assert.equal(managerResult.cancelledAt, NOW);
    assert.equal(managerResult.timing?.phases["terminal-persist"]?.completedAt, NOW);
  } finally {
    rmSync(managerRoot, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});

test("manager-safe cancellation accepts preparing but refuses post-cutover and invalid receipts", () => {
  const root = fixtureRoot();
  try {
    const { receipt } = fixtureReceipt();
    const file = join(root, "transactions", "environment.json");
    const archive = join(root, "transactions", "environment");
    writeEnvironmentTransactionReceipt(file, { ...receipt, phase: "preparing", prepared: null });

    const preparing = cancelPreparedEnvironmentTransaction({
      transactionFile: file,
      receiptRoot: archive,
      transactionId: TRANSACTION_ID,
      ownerPid: process.pid,
      now: () => NOW,
      timing: new EnvironmentTimingRecorder(fixedTimingClock()),
    });
    assert.equal(preparing.phase, "cancelled");

    writeEnvironmentTransactionReceipt(file, { ...receipt, phase: "prepared" });
    assert.throws(
      () => cancelPreparedEnvironmentTransaction({
        transactionFile: file,
        receiptRoot: archive,
        transactionId: "replacement-receipt",
        ownerPid: process.pid,
        now: () => NOW,
        timing: new EnvironmentTimingRecorder(fixedTimingClock()),
      }),
      /Environment transaction mismatch: expected replacement-receipt, found manager-safe-pre-cutover-cancel/,
    );
    assert.equal(readEnvironmentTransactionReceipt(file)?.phase, "prepared");

    writeFileSync(file, `${JSON.stringify({ ...receipt, phase: "prepared", prepared: {
      ...receipt.prepared,
      candidate: { ...receipt.prepared!, candidate: undefined },
    } })}\n`);
    assert.throws(
      () => cancelPreparedEnvironmentTransaction({
        transactionFile: file,
        receiptRoot: archive,
        transactionId: TRANSACTION_ID,
        ownerPid: process.pid,
        now: () => NOW,
        timing: new EnvironmentTimingRecorder(fixedTimingClock()),
      }),
      /Environment transaction receipt is invalid/,
    );
    assert.equal(existsSync(join(archive, `${TRANSACTION_ID}.json`)), true, "existing terminal history is never overwritten by invalid input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "tweakers-manager-environment-action-"));
}

function fixedTimingClock(): EnvironmentTimingClock {
  return {
    nowIso: () => NOW,
    monotonicMs: () => 100,
  };
}

function fixtureReceipt(): { receipt: EnvironmentTransactionReceipt } {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });
  const current = createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "tweakers",
    requestedAt: "2026-08-28T00:00:00.000Z",
    appliedAt: "2026-08-28T00:00:01.000Z",
  });
  const requested = createEnvironmentSelection({
    profile: registry.profiles.alpha,
    appExperience: "tweakers",
    requestedAt: "2026-08-28T00:10:00.000Z",
  });
  const prepared = preparedEvidence(current, requested);
  return {
    receipt: {
      schemaVersion: 1,
      kind: "environment",
      transactionId: TRANSACTION_ID,
      phase: "prepared",
      error: null,
      ownerPid: process.pid,
      source: current,
      requested,
      prepared,
      applied: null,
      oldMainPid: null,
      newMainPid: null,
      attempt: 0,
      timing: {
        schemaVersion: 1,
        approvalAt: null,
        readyAt: null,
        phases: {
          preparation: { startedAt: NOW, completedAt: NOW, durationMs: 0 },
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    },
  };
}

function preparedEvidence(current: EnvironmentSelection, requested: EnvironmentSelection): PreparedEnvironmentEvidence {
  return {
    preparedAt: "2026-08-28T00:10:01.000Z",
    candidate: {
      desktopPath: requested.selectedDesktopPath,
      artifactPath: "/tmp/manager-environment/prepared/ChatGPT (Beta).app",
      bundleId: requested.selectedDesktopBundleId,
      appExperience: requested.appExperience,
      releaseProfile: requested.releaseProfile,
      version: "26.818.1",
      build: "7001",
      artifactDigest: "candidate-sha256",
      asarHeaderHash: "a".repeat(64),
      signature: {
        strict: true,
        gatekeeper: true,
        designatedRequirement: "identifier manager.environment.alpha",
        teamIdentifier: null,
      },
    },
    backend: {
      lane: requested.backendLane,
      binaryPath: "/tmp/manager-environment/prepared/codex-alpha",
      artifactPath: "/tmp/manager-environment/prepared/artifacts/codex-alpha",
      version: "0.147.0-alpha.1",
      artifactDigest: "backend-sha256",
    },
    rollback: {
      selection: current,
      desktopPath: current.selectedDesktopPath,
      desktopArtifactPath: "/tmp/manager-environment/rollback/ChatGPT.app",
      archivePath: "/tmp/manager-environment/archive/ChatGPT.app",
      bundleId: current.selectedDesktopBundleId,
      desktopVersion: "26.818.0",
      desktopBuild: "7000",
      desktopArtifactDigest: "rollback-desktop-sha256",
      desktopAsarHeaderHash: "b".repeat(64),
      backendLane: current.backendLane,
      backendBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      backendArtifactPath: "/tmp/manager-environment/rollback/codex",
      backendVersion: "0.147.0",
      backendArtifactDigest: "rollback-backend-sha256",
    },
  };
}

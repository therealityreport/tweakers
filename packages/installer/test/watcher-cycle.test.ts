import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAutoRepairState } from "../src/auto-repair-state";
import type { DesktopUpdateReceipt } from "../src/desktop-update-transaction";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  resolveEnvironmentProfile,
  type EnvironmentSelection,
} from "../src/environment-profile";
import { runWatcherCycle } from "../src/watcher-cycle";

const NOW = "2026-07-17T12:00:00.000Z";

test("watcher cycle defers both steps while a desktop update blocks lifecycle work", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-cycle-"));
  const calls: string[] = [];
  try {
    writeDesktopReceipt(root, desktopReceipt({
      phase: "awaiting_native_update",
      resumable: true,
    }));

    const receipt = await runWatcherCycle({ userRoot: root }, {
      update: async () => { calls.push("update"); },
      repair: async () => { calls.push("repair"); },
      now: sequenceDates(),
      randomId: () => "blocked-cycle",
    });

    assert.deepEqual(calls, []);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.error, "desktop-update-in-flight");
    assert.deepEqual(receipt.update, {
      status: "pending",
      error: "desktop-update-in-flight",
    });
    assert.deepEqual(receipt.repair, receipt.update);
    assert.deepEqual(readAutoRepairState(root)?.latestCompletedCycle, receipt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watcher cycle never ages out an old blocking desktop update receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-cycle-"));
  let updateCalls = 0;
  let repairCalls = 0;
  const warnings: string[] = [];
  try {
    writeDesktopReceipt(root, desktopReceipt({
      phase: "failed",
      safeOfficialMode: false,
      resumable: false,
      updatedAt: "2020-01-01T00:00:00.000Z",
    }));

    const receipt = await runWatcherCycle({ userRoot: root }, {
      update: async () => { updateCalls += 1; },
      repair: async () => { repairCalls += 1; },
      now: sequenceDates(),
      randomId: () => "old-blocked-cycle",
      warn: (message) => warnings.push(message),
    });

    assert.equal(updateCalls, 0);
    assert.equal(repairCalls, 0);
    assert.equal(receipt.error, "desktop-update-in-flight");
    assert.equal(receipt.update.status, "pending");
    assert.equal(receipt.repair.status, "pending");
    assert.deepEqual(warnings.map((message) => JSON.parse(message).event), [
      "desktop-update-stale-warning",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watcher cycle fails closed when the desktop update receipt is unreadable", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-cycle-"));
  const calls: string[] = [];
  const warnings: string[] = [];
  try {
    const transactions = join(root, "transactions");
    mkdirSync(transactions, { recursive: true });
    writeFileSync(join(transactions, "desktop-update.json"), "{broken");

    const receipt = await runWatcherCycle({ userRoot: root }, {
      update: async () => { calls.push("update"); },
      repair: async () => { calls.push("repair"); },
      now: sequenceDates(),
      randomId: () => "invalid-receipt-cycle",
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(calls, []);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.error, "desktop-update-receipt-invalid");
    assert.deepEqual(receipt.update, {
      status: "pending",
      error: "desktop-update-receipt-invalid",
    });
    assert.deepEqual(receipt.repair, receipt.update);
    assert.deepEqual(warnings.map((message) => JSON.parse(message)), [{
      schemaVersion: 1,
      event: "desktop-update-receipt-invalid",
    }]);
    assert.deepEqual(readAutoRepairState(root)?.latestCompletedCycle, receipt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watcher cycle still repairs when the release update fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-cycle-"));
  const calls: string[] = [];
  try {
    const receipt = await runWatcherCycle({ userRoot: root }, {
      update: async () => {
        calls.push("update");
        throw new Error("network unavailable");
      },
      repair: async () => {
        calls.push("repair");
      },
      now: sequenceDates(),
      randomId: () => "cycle-1",
    });

    assert.deepEqual(calls, ["update", "repair"]);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.update.status, "failed");
    assert.equal(receipt.repair.status, "succeeded");
    assert.equal(readAutoRepairState(root)?.latestCompletedCycle?.cycleId, "cycle-1");
    assert.equal(statSync(join(root, "auto-repair-state.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watcher cycle preserves a deferred repair as pending with its reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-cycle-"));
  try {
    const receipt = await runWatcherCycle({ userRoot: root }, {
      update: async () => {},
      repair: async () => ({ status: "deferred", reason: "runtime-drift-app-running" }),
      now: sequenceDates(),
      randomId: () => "deferred-cycle",
    });

    assert.equal(receipt.outcome, "completed");
    assert.deepEqual(receipt.repair, {
      status: "pending",
      error: "runtime-drift-app-running",
    });
    assert.deepEqual(readAutoRepairState(root)?.latestCompletedCycle?.repair, receipt.repair);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later successful cycle replaces the current warning and retains historical failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-cycle-"));
  try {
    await runWatcherCycle({ userRoot: root }, {
      update: async () => {},
      repair: async () => { throw new Error("repair failed"); },
      now: sequenceDates(),
      randomId: () => "failed-cycle",
    });
    await runWatcherCycle({ userRoot: root }, {
      update: async () => {},
      repair: async () => {},
      now: sequenceDates(),
      randomId: () => "successful-cycle",
    });

    const state = JSON.parse(readFileSync(join(root, "auto-repair-state.json"), "utf8"));
    assert.equal(state.latestCompletedCycle.cycleId, "successful-cycle");
    assert.equal(state.latestCompletedCycle.outcome, "completed");
    assert.equal(state.lastFailure.cycleId, "failed-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sequenceDates(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 17, 0, 0, tick++));
}

function selection(appExperience: "chatgpt" | "tweakers"): EnvironmentSelection {
  return createEnvironmentSelection({
    profile: resolveEnvironmentProfile(defaultEnvironmentProfileRegistry(), "stable"),
    appExperience,
    requestedAt: NOW,
    appliedAt: NOW,
  });
}

function desktopReceipt(overrides: Partial<DesktopUpdateReceipt> = {}): DesktopUpdateReceipt {
  return {
    schemaVersion: 1,
    kind: "desktop-update",
    transactionId: "desktop-1",
    phase: "preparing",
    ownerPid: 123,
    source: selection("tweakers"),
    official: selection("chatgpt"),
    baseline: { marketingVersion: "1.0.0", build: "100" },
    observed: null,
    nativeUpdateHandoffAt: null,
    refreshSource: null,
    environmentTransactionId: null,
    officialMainPid: null,
    safeOfficialMode: false,
    resumable: false,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    rolledBackAt: null,
    ...overrides,
  };
}

function writeDesktopReceipt(root: string, receipt: DesktopUpdateReceipt): void {
  const transactions = join(root, "transactions");
  mkdirSync(transactions, { recursive: true });
  writeFileSync(join(transactions, "desktop-update.json"), `${JSON.stringify(receipt)}\n`);
}

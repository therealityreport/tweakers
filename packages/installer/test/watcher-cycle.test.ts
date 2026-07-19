import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAutoRepairState } from "../src/auto-repair-state";
import { runWatcherCycle } from "../src/watcher-cycle";

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

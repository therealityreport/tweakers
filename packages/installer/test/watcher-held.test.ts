import assert from "node:assert/strict";
import test from "node:test";
import { runHeldPromotion, type HeldPromotionDeps } from "../src/watcher-held";
import type { OpenReport } from "../src/commands/debug";

function report(partial: Partial<OpenReport>): OpenReport {
  return {
    status: "open",
    pid: 100,
    relatedPids: [100],
    hasMainProcess: true,
    openedAt: "2026-07-12T00:00:00.000Z",
    openedAtRaw: "Sat Jul 12 00:00:00 2026",
    detail: null,
    ...partial,
  };
}

interface Recorded {
  calls: string[];
  deps: HeldPromotionDeps;
  quitEffect?: () => void;
}

function makeDeps(reports: OpenReport[], opts: { quitEffect?: () => void } = {}): Recorded {
  const calls: string[] = [];
  let index = 0;
  const next = () => {
    const value = reports[Math.min(index, reports.length - 1)];
    index += 1;
    return value;
  };
  const recorded: Recorded = { calls, deps: undefined as unknown as HeldPromotionDeps };
  recorded.deps = {
    getReport: () => {
      calls.push("getReport");
      return next();
    },
    quitApp: () => {
      calls.push("quitApp");
      opts.quitEffect?.();
    },
    cleanupOrphans: () => calls.push("cleanupOrphans"),
    notifyUpdateQuit: () => calls.push("notify"),
    reenter: async () => {
      calls.push("reenter");
    },
    sleep: async () => {
      calls.push("sleep");
    },
    log: () => {},
  };
  return recorded;
}

test("helper-only background report exits the wait immediately (deadlock fix)", async () => {
  const { deps, calls } = makeDeps([report({ status: "background", hasMainProcess: false })]);

  await runHeldPromotion(deps, { coordinatedQuit: false });

  assert.deepEqual(calls, ["getReport", "cleanupOrphans", "reenter"]);
});

test("passive wait sleeps while the main process runs, then cleans up and re-enters once", async () => {
  const { deps, calls } = makeDeps([
    report({ status: "open", hasMainProcess: true }),
    report({ status: "inactive", hasMainProcess: true }),
    report({ status: "closed", hasMainProcess: false, pid: null }),
  ]);

  await runHeldPromotion(deps, { coordinatedQuit: false });

  assert.equal(calls.filter((c) => c === "sleep").length, 2);
  assert.equal(calls.filter((c) => c === "reenter").length, 1);
  assert.deepEqual(calls.slice(-2), ["cleanupOrphans", "reenter"]);
  assert.ok(!calls.includes("quitApp"));
  assert.ok(!calls.includes("notify"));
});

test("coordinated quit: notify → quit → cleanup → single reenter, no passive wait", async () => {
  const { deps, calls } = makeDeps([report({ status: "closed", hasMainProcess: false, pid: null })]);

  await runHeldPromotion(deps, { coordinatedQuit: true });

  assert.deepEqual(calls, ["notify", "quitApp", "getReport", "cleanupOrphans", "reenter"]);
});

test("coordinated quit falls back to passive wait when the main process survives; quitApp never repeats", async () => {
  const { deps, calls } = makeDeps([
    report({ status: "open", hasMainProcess: true }), // post-quit re-check: survived
    report({ status: "open", hasMainProcess: true }), // wait iteration 1
    report({ status: "background", hasMainProcess: false }), // helpers only → exit wait
  ]);

  await runHeldPromotion(deps, { coordinatedQuit: true });

  assert.equal(calls.filter((c) => c === "quitApp").length, 1);
  assert.equal(calls.filter((c) => c === "sleep").length, 1);
  assert.deepEqual(calls.slice(-2), ["cleanupOrphans", "reenter"]);
});

test("relaunch race: the re-entered run uses coordinatedQuit=false and never quits", async () => {
  // Simulates install()'s re-entry wiring: a second held resolution after the
  // user relaunched Codex must wait passively, not quit again.
  const { deps, calls } = makeDeps([
    report({ status: "open", hasMainProcess: true }),
    report({ status: "closed", hasMainProcess: false, pid: null }),
  ]);

  await runHeldPromotion(deps, { coordinatedQuit: false });

  assert.ok(!calls.includes("quitApp"));
  assert.ok(!calls.includes("notify"));
  assert.equal(calls.filter((c) => c === "reenter").length, 1);
});

test("reenter is invoked exactly once per run in every scenario", async () => {
  const scenarios: Array<{ reports: OpenReport[]; coordinatedQuit: boolean }> = [
    { reports: [report({ status: "closed", hasMainProcess: false, pid: null })], coordinatedQuit: false },
    { reports: [report({ status: "closed", hasMainProcess: false, pid: null })], coordinatedQuit: true },
    { reports: [report({ status: "background", hasMainProcess: false })], coordinatedQuit: true },
    {
      reports: [
        report({ status: "open", hasMainProcess: true }),
        report({ status: "closed", hasMainProcess: false, pid: null }),
      ],
      coordinatedQuit: true,
    },
  ];
  for (const scenario of scenarios) {
    const { deps, calls } = makeDeps(scenario.reports);
    await runHeldPromotion(deps, { coordinatedQuit: scenario.coordinatedQuit });
    assert.equal(calls.filter((c) => c === "reenter").length, 1);
  }
});

test("update recovery v2 preserves every held-promotion sequence", async () => {
  const scenarios: Array<{
    name: string;
    coordinatedQuit: boolean;
    reports: OpenReport[];
  }> = [
    {
      name: "helper-only passive exit",
      coordinatedQuit: false,
      reports: [report({ status: "background", hasMainProcess: false })],
    },
    {
      name: "passive wait",
      coordinatedQuit: false,
      reports: [
        report({ status: "open", hasMainProcess: true }),
        report({ status: "closed", hasMainProcess: false, pid: null }),
      ],
    },
    {
      name: "coordinated immediate close",
      coordinatedQuit: true,
      reports: [report({ status: "closed", hasMainProcess: false, pid: null })],
    },
    {
      name: "coordinated fallback",
      coordinatedQuit: true,
      reports: [
        report({ status: "open", hasMainProcess: true }),
        report({ status: "inactive", hasMainProcess: true }),
        report({ status: "closed", hasMainProcess: false, pid: null }),
      ],
    },
  ];
  const previousFlag = process.env.TWEAKERS_UPDATE_RECOVERY_V2;

  try {
    for (const scenario of scenarios) {
      const legacy = makeDeps(scenario.reports);
      const v2 = makeDeps(scenario.reports);
      process.env.TWEAKERS_UPDATE_RECOVERY_V2 = "0";
      await runHeldPromotion(legacy.deps, { coordinatedQuit: scenario.coordinatedQuit });
      process.env.TWEAKERS_UPDATE_RECOVERY_V2 = "1";
      await runHeldPromotion(v2.deps, { coordinatedQuit: scenario.coordinatedQuit });
      assert.deepEqual(v2.calls, legacy.calls, scenario.name);
      assert.equal(v2.calls.filter((call) => call === "reenter").length, 1, scenario.name);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.TWEAKERS_UPDATE_RECOVERY_V2;
    else process.env.TWEAKERS_UPDATE_RECOVERY_V2 = previousFlag;
  }
});

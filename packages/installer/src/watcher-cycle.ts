import { randomUUID } from "node:crypto";
import {
  updateAutoRepairState,
  type WatcherCycleReceipt,
  type WatcherCycleStep,
} from "./auto-repair-state.js";
import type { RepairOutcome } from "./commands/repair.js";

export interface WatcherCycleOptions {
  userRoot: string;
}

export interface WatcherCycleDependencies {
  update?: () => Promise<void>;
  repair?: () => Promise<void | RepairOutcome>;
  now?: () => Date;
  randomId?: () => string;
}

export async function runWatcherCycle(
  options: WatcherCycleOptions,
  dependencies: WatcherCycleDependencies = {},
): Promise<WatcherCycleReceipt> {
  const now = dependencies.now ?? (() => new Date());
  const update = dependencies.update ?? (async () => {
    const { selfUpdate } = await import("./commands/self-update.js");
    await selfUpdate({ watcher: true, quiet: true, repair: false });
  });
  const repair = dependencies.repair ?? (async () => {
    const command = await import("./commands/repair.js");
    return command.repairWithOutcome({ watcher: true, quiet: true });
  });
  const cycleId = (dependencies.randomId ?? randomUUID)();
  const startedAt = now().toISOString();
  const updateResult = await runStep(update);
  const repairResult = await runStep(repair);
  const completedAt = now().toISOString();
  const outcome = repairResult.status === "failed" ? "failed" : "completed";
  const receipt: WatcherCycleReceipt = {
    schemaVersion: 1,
    cycleId,
    startedAt,
    completedAt,
    update: updateResult,
    repair: repairResult,
    outcome,
    error: repairResult.error,
  };

  updateAutoRepairState(options.userRoot, (current) => ({
    ...(current ?? {}),
    schemaVersion: 1,
    checkedAt: completedAt,
    latestCompletedCycle: receipt,
    ...(outcome === "failed" ? { lastFailure: receipt } : {}),
  }));
  return receipt;
}

async function runStep(operation: () => Promise<void | RepairOutcome>): Promise<WatcherCycleStep> {
  try {
    const outcome = await operation();
    if (outcome?.status === "deferred") {
      return { status: "pending", error: outcome.reason };
    }
    if (outcome?.status === "skipped") {
      return { status: "skipped", error: outcome.reason };
    }
    return { status: "succeeded", error: null };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

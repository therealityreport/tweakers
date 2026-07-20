import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  updateAutoRepairState,
  type WatcherCycleReceipt,
  type WatcherCycleStep,
} from "./auto-repair-state.js";
import type { RepairOutcome } from "./commands/repair.js";
import { desktopReceiptBlocksLifecycle } from "./desktop-update-state.js";
import { readDesktopUpdateReceipt } from "./desktop-update-transaction.js";

export interface WatcherCycleOptions {
  userRoot: string;
}

export interface WatcherCycleDependencies {
  update?: () => Promise<void>;
  repair?: () => Promise<void | RepairOutcome>;
  now?: () => Date;
  randomId?: () => string;
  warn?: (message: string) => void;
}

export const WATCHER_DESKTOP_UPDATE_STALE_WARNING_MS = 5 * 60_000;

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
  const desktopReceiptPath = join(options.userRoot, "transactions", "desktop-update.json");
  let desktopReceipt;
  try {
    desktopReceipt = readDesktopUpdateReceipt(desktopReceiptPath);
  } catch {
    const reason = "desktop-update-receipt-invalid";
    (dependencies.warn ?? console.warn)(JSON.stringify({
      schemaVersion: 1,
      event: reason,
    }));
    return persistDeferredWatcherReceipt(
      options.userRoot,
      cycleId,
      startedAt,
      now().toISOString(),
      reason,
    );
  }
  if (desktopReceipt && desktopReceiptBlocksLifecycle(desktopReceipt)) {
    const completedAtDate = now();
    const completedAt = completedAtDate.toISOString();
    const receiptUpdatedAt = Date.parse(desktopReceipt.updatedAt);
    if (Number.isFinite(receiptUpdatedAt)
      && completedAtDate.getTime() - receiptUpdatedAt > WATCHER_DESKTOP_UPDATE_STALE_WARNING_MS) {
      (dependencies.warn ?? console.warn)(JSON.stringify({
        schemaVersion: 1,
        event: "desktop-update-stale-warning",
        transactionId: desktopReceipt.transactionId,
        phase: desktopReceipt.phase,
        updatedAt: desktopReceipt.updatedAt,
      }));
    }
    return persistDeferredWatcherReceipt(
      options.userRoot,
      cycleId,
      startedAt,
      completedAt,
      "desktop-update-in-flight",
    );
  }

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

  return persistWatcherReceipt(options.userRoot, receipt);
}

function persistDeferredWatcherReceipt(
  userRoot: string,
  cycleId: string,
  startedAt: string,
  completedAt: string,
  reason: string,
): WatcherCycleReceipt {
  const deferred: WatcherCycleStep = {
    status: "pending",
    error: reason,
  };
  return persistWatcherReceipt(userRoot, {
    schemaVersion: 1,
    cycleId,
    startedAt,
    completedAt,
    update: deferred,
    repair: { ...deferred },
    outcome: "completed",
    error: reason,
  });
}

function persistWatcherReceipt(
  userRoot: string,
  receipt: WatcherCycleReceipt,
): WatcherCycleReceipt {
  updateAutoRepairState(userRoot, (current) => ({
    ...(current ?? {}),
    schemaVersion: 1,
    checkedAt: receipt.completedAt,
    latestCompletedCycle: receipt,
    ...(receipt.outcome === "failed" ? { lastFailure: receipt } : {}),
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

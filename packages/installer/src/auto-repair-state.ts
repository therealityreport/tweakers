import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { chownForTargetUser } from "./ownership.js";

export interface WatcherCycleStep {
  /** `pending` means the watcher deliberately deferred work for a later cycle. */
  status: "succeeded" | "failed" | "skipped" | "pending";
  error: string | null;
}

export interface WatcherCycleReceipt {
  schemaVersion: 1;
  cycleId: string;
  startedAt: string;
  completedAt: string;
  update: WatcherCycleStep;
  repair: WatcherCycleStep;
  outcome: "completed" | "failed";
  error: string | null;
}

export interface RuntimeRepairState {
  status: "current" | "pending" | "repairing" | "failed" | "unknown";
  expectedFingerprint: string | null;
  activeFingerprint: string | null;
  checkedAt: string;
  error: string | null;
}

export interface AutoRepairState {
  schemaVersion: 1;
  checkedAt: string;
  latestCompletedCycle?: WatcherCycleReceipt;
  lastFailure?: WatcherCycleReceipt;
  runtime?: RuntimeRepairState;
}

export function autoRepairStatePath(userRoot: string): string {
  return join(userRoot, "auto-repair-state.json");
}

export function readAutoRepairState(userRoot: string): AutoRepairState | null {
  const path = autoRepairStatePath(userRoot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as AutoRepairState;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export function updateAutoRepairState(
  userRoot: string,
  update: (current: AutoRepairState | null) => AutoRepairState,
): AutoRepairState {
  const next = update(readAutoRepairState(userRoot));
  writeAutoRepairState(userRoot, next);
  return next;
}

export function writeAutoRepairState(userRoot: string, state: AutoRepairState): void {
  const path = autoRepairStatePath(userRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  chownForTargetUser(path);
  try {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Some filesystems do not support directory fsync.
  }
}

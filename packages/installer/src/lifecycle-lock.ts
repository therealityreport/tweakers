import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { readDesktopUpdateReceipt } from "./desktop-update-transaction.js";
import { readEnvironmentTransactionReceipt } from "./environment-transaction.js";
import {
  acquireProcessLock,
  isLockHeldByLiveOwner,
} from "./process-lock.js";

interface LifecycleContext {
  lockFile: string;
  operation: string;
}

const lifecycleContext = new AsyncLocalStorage<LifecycleContext>();

export function lifecycleLockFile(userRoot: string): string {
  return join(userRoot, "transactions", "lifecycle.lock");
}

export function isLifecycleLockHeld(userRoot: string): boolean {
  return isLockHeldByLiveOwner(lifecycleLockFile(userRoot));
}

export interface LifecycleReceiptAllowance {
  environmentTransactionId?: string;
  desktopTransactionId?: string;
  /** Disable implicit ownership for preflight checks that run inside a new owner. */
  contextOwned?: boolean;
}

export function currentLifecycleOperation(): string | null {
  return lifecycleContext.getStore()?.operation ?? null;
}

/**
 * Blocking predicate for a durable environment receipt, shared by the
 * lifecycle gate and repair's orphan classifier so the two can never drift.
 * Returns the human-readable block detail, or null when the receipt is idle.
 *
 * A failed environment transaction is normally terminal, but a rollback
 * failure is different: the live app may still be in an unknown state and
 * must block every unrelated lifecycle mutation until explicit recovery.
 */
export function environmentReceiptBlocksLifecycle(
  receipt: { phase: string; error: string | null },
): string | null {
  const rollbackFailed = receipt.phase === "failed"
    && /\brollback failed\b/i.test(receipt.error ?? "");
  if (rollbackFailed) return "failed during rollback and requires explicit recovery";
  if (!["committed", "rolled-back", "failed", "cancelled"].includes(receipt.phase)) {
    return receipt.phase;
  }
  return null;
}

/**
 * Blocking predicate for a durable desktop-update receipt; see
 * environmentReceiptBlocksLifecycle. A failed desktop receipt is only safely
 * terminal when official mode was explicitly proven, no continuation remains,
 * and rollback itself did not fail. Missing safety evidence is treated as
 * unsafe for older/corrupt receipts instead of silently opening the gate.
 */
export function desktopReceiptBlocksLifecycle(
  receipt: { phase: string; error: string | null; safeOfficialMode: boolean; resumable: boolean },
): string | null {
  const rollbackFailed = receipt.phase === "failed"
    && /\brollback failed\b/i.test(receipt.error ?? "");
  const unsafeFailure = receipt.phase === "failed"
    && (receipt.safeOfficialMode !== true || rollbackFailed);
  const active = !["completed", "rolled_back", "failed"].includes(receipt.phase)
    || (receipt.phase === "failed" && (receipt.resumable === true || unsafeFailure));
  if (!active) return null;
  return rollbackFailed
    ? "failed during rollback and requires explicit recovery"
    : unsafeFailure
      ? "failed without confirmed safe official mode and requires explicit recovery"
      : receipt.phase;
}

/** Fail closed on durable transactions even when their short-lived lock owner exited. */
export function assertLifecycleReceiptsIdle(
  userRoot: string,
  allowance: LifecycleReceiptAllowance = {},
): void {
  const context = allowance.contextOwned === false ? null : currentLifecycleOperation();
  const environment = readEnvironmentTransactionReceipt(join(userRoot, "transactions", "environment.json"));
  const environmentDetail = environment === null ? null : environmentReceiptBlocksLifecycle(environment);
  if (environment && environmentDetail !== null) {
    // Operation names are not ownership proof. A fresh prepare and recovery of
    // an existing transaction both run under the same lifecycle operation, so
    // only the exact durable transaction id may cross this gate.
    const ownsEnvironment = environment.transactionId === allowance.environmentTransactionId;
    if (!ownsEnvironment) {
      throw new Error(
        `Environment transaction ${environment.transactionId} is ${environmentDetail}; finish or cancel it before another lifecycle operation`,
      );
    }
  }

  const desktop = readDesktopUpdateReceipt(join(userRoot, "transactions", "desktop-update.json"));
  if (desktop) {
    const detail = desktopReceiptBlocksLifecycle(desktop);
    const desktopRollbackFailed = desktop.phase === "failed"
      && /\brollback failed\b/i.test(desktop.error ?? "");
    const unsafeDesktopFailure = desktop.phase === "failed"
      && (desktop.safeOfficialMode !== true || desktopRollbackFailed);
    const contextOwns = context?.startsWith("desktop update") === true;
    if (detail !== null && desktop.transactionId !== allowance.desktopTransactionId && !contextOwns) {
      const instruction = unsafeDesktopFailure
        ? "recover it explicitly before another lifecycle operation"
        : "resume or cancel it before another lifecycle operation";
      throw new Error(
        `Desktop update ${desktop.transactionId} is ${detail}; ${instruction}`,
      );
    }
  }
}

/**
 * Serialize every live-app lifecycle owner through one cross-process lock.
 * Nested work in the same async operation borrows the lease, while an
 * unrelated call from the same PID still contends (process-lock enforces it).
 */
export async function withLifecycleLock<T>(
  lockFile: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const active = lifecycleContext.getStore();
  if (active?.lockFile === lockFile) return run();

  const lock = acquireProcessLock(lockFile, {
    onContended: (owner) => new Error(
      owner === null
        ? `Another Tweakers lifecycle operation is active; refusing ${operation}`
        : `Another Tweakers lifecycle operation is active (PID ${owner}); refusing ${operation}`,
    ),
  });
  try {
    return await lifecycleContext.run({ lockFile, operation }, run);
  } finally {
    lock.release();
  }
}

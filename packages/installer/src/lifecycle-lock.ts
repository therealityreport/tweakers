import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { readDesktopUpdateReceipt } from "./desktop-update-transaction.js";
import { desktopReceiptBlocksLifecycle } from "./desktop-update-state.js";
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

/** Fail closed on durable transactions even when their short-lived lock owner exited. */
export function assertLifecycleReceiptsIdle(
  userRoot: string,
  allowance: LifecycleReceiptAllowance = {},
): void {
  const context = allowance.contextOwned === false ? null : currentLifecycleOperation();
  const environment = readEnvironmentTransactionReceipt(join(userRoot, "transactions", "environment.json"));
  // A failed environment transaction is normally terminal, but a rollback
  // failure is different: the live app may still be in an unknown state and
  // must block every unrelated lifecycle mutation until explicit recovery.
  const environmentRollbackFailed = environment?.phase === "failed"
    && /\brollback failed\b/i.test(environment.error ?? "");
  if (environment && (environmentRollbackFailed
    || !["committed", "rolled-back", "failed", "cancelled"].includes(environment.phase))) {
    // Operation names are not ownership proof. A fresh prepare and recovery of
    // an existing transaction both run under the same lifecycle operation, so
    // only the exact durable transaction id may cross this gate.
    const ownsEnvironment = environment.transactionId === allowance.environmentTransactionId;
    if (!ownsEnvironment) {
      const detail = environmentRollbackFailed
        ? "failed during rollback and requires explicit recovery"
        : environment.phase;
      throw new Error(
        `Environment transaction ${environment.transactionId} is ${detail}; finish or cancel it before another lifecycle operation`,
      );
    }
  }

  const desktop = readDesktopUpdateReceipt(join(userRoot, "transactions", "desktop-update.json"));
  if (desktop) {
    const desktopRollbackFailed = desktop.phase === "failed"
      && /\brollback failed\b/i.test(desktop.error ?? "");
    const unsafeDesktopFailure = desktop.phase === "failed"
      && (desktop.safeOfficialMode !== true || desktopRollbackFailed);
    const active = desktopReceiptBlocksLifecycle(desktop);
    const contextOwns = context?.startsWith("desktop update") === true;
    if (active && desktop.transactionId !== allowance.desktopTransactionId && !contextOwns) {
      const detail = desktopRollbackFailed
        ? "failed during rollback and requires explicit recovery"
        : unsafeDesktopFailure
          ? "failed without confirmed safe official mode and requires explicit recovery"
          : desktop.phase;
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

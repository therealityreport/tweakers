import { join } from "node:path";
import { readDesktopUpdateReceipt } from "./desktop-update-transaction.js";
import { readEnvironmentTransactionReceipt } from "./environment-transaction.js";
import {
  isLockHeldByLiveOwner,
} from "./process-lock.js";
import {
  currentLifecycleOperation,
  lifecycleLockFile,
  withLifecycleLock,
} from "./lifecycle-lock-core.js";

export {
  currentLifecycleOperation,
  lifecycleLockFile,
  withLifecycleLock,
} from "./lifecycle-lock-core.js";

export function isLifecycleLockHeld(userRoot: string): boolean {
  return isLockHeldByLiveOwner(lifecycleLockFile(userRoot));
}

export interface LifecycleReceiptAllowance {
  environmentTransactionId?: string;
  desktopTransactionId?: string;
  /** Exact independent official-app update allowed to resume or cancel itself. */
  officialUpdateTransactionId?: string;
  /** Disable implicit ownership for preflight checks that run inside a new owner. */
  contextOwned?: boolean;
  /**
   * Set ONLY by environment recovery. Together with environmentTransactionId
   * it lets recovery of the exact environment transaction a blocked desktop
   * receipt recorded cross the desktop gate — and nothing else: forward
   * mutations (prepare/commit/rollback) of a coupled transaction stay blocked
   * so they cannot cut over or swap bytes outside the desktop update's own
   * supervised recovery.
   */
  environmentRecovery?: boolean;
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

  const checkDesktopReceipt = (
    desktop: ReturnType<typeof readDesktopUpdateReceipt>,
    source: "Desktop update" | "Official ChatGPT update",
    allowedTransactionId: string | undefined,
    contextMayOwn: boolean,
  ): void => {
    if (!desktop) return;
    const detail = desktopReceiptBlocksLifecycle(desktop);
    const desktopRollbackFailed = desktop.phase === "failed"
      && /\brollback failed\b/i.test(desktop.error ?? "");
    const unsafeDesktopFailure = desktop.phase === "failed"
      && (desktop.safeOfficialMode !== true || desktopRollbackFailed);
    const contextOwns = contextMayOwn && context?.startsWith("desktop update") === true;
    // Recovering the exact environment transaction that the blocking desktop
    // receipt itself recorded is a prerequisite of that receipt's own
    // continuation, not an unrelated mutation. Without this, `environment
    // recover` and `update-chatgpt-resume` deadlock: each tells the user to
    // run the other first (hit live 2026-08-07). Three conditions keep this
    // narrow: the caller must be a recovery (environmentRecovery flag — a
    // coupled commit/rollback would cut over or swap bytes unsupervised), the
    // ids must couple, and the environment receipt itself must currently
    // block (an idle committed receipt has nothing to recover, so it must not
    // open the desktop gate).
    const ownsCoupledEnvironment = allowance.environmentRecovery === true
      && allowance.environmentTransactionId !== undefined
      && desktop.environmentTransactionId === allowance.environmentTransactionId
      && environment !== null
      && environment.transactionId === allowance.environmentTransactionId
      && environmentDetail !== null;
    if (detail !== null
      && desktop.transactionId !== allowedTransactionId
      && !contextOwns
      && !ownsCoupledEnvironment) {
      const instruction = unsafeDesktopFailure
        ? "recover it explicitly before another lifecycle operation"
        : "resume or cancel it before another lifecycle operation";
      throw new Error(
        `${source} ${desktop.transactionId} is ${detail}; ${instruction}`,
      );
    }
  };

  checkDesktopReceipt(
    readDesktopUpdateReceipt(join(userRoot, "transactions", "desktop-update.json")),
    "Desktop update",
    allowance.desktopTransactionId,
    true,
  );
  // The independent official updater uses a separate durable receipt. It
  // never owns a selected-environment desktop update merely because both
  // operations share the lifecycle-lock label; only its exact id crosses.
  checkDesktopReceipt(
    readDesktopUpdateReceipt(join(userRoot, "transactions", "chatgpt-app-update.json")),
    "Official ChatGPT update",
    allowance.officialUpdateTransactionId,
    false,
  );
}

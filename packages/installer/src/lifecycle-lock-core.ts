import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { acquireProcessLock } from "./process-lock.js";

interface LifecycleContext {
  lockFile: string;
  operation: string;
}

const lifecycleContext = new AsyncLocalStorage<LifecycleContext>();

/**
 * The one cross-process lock shared by every lifecycle coordinator. This
 * intentionally contains no receipt parsing or app/update dependencies so a
 * sealed manager can take the same lease without loading mutation-capable
 * installer graphs merely to serialize its own durable operation record.
 */
export function lifecycleLockFile(userRoot: string): string {
  return join(userRoot, "transactions", "lifecycle.lock");
}

export function currentLifecycleOperation(): string | null {
  return lifecycleContext.getStore()?.operation ?? null;
}

const LIFECYCLE_LOCK_WAIT_ATTEMPTS = 30;
const LIFECYCLE_LOCK_WAIT_INTERVAL_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serialize every live-app lifecycle owner through the common lock. Nested
 * work that was entered through this exact core borrows the existing lease;
 * unrelated calls still contend through process-lock.
 */
export async function withLifecycleLock<T>(
  lockFile: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const active = lifecycleContext.getStore();
  if (active?.lockFile === lockFile) return run();

  let lock: ReturnType<typeof acquireProcessLock>;
  for (let attempt = 1; ; attempt += 1) {
    try {
      lock = acquireProcessLock(lockFile, {
        onContended: (owner) => new Error(
          owner === null
            ? `Another Tweakers lifecycle operation is active; refusing ${operation}`
            : `Another Tweakers lifecycle operation is active (PID ${owner}); refusing ${operation}`,
        ),
      });
      break;
    } catch (error) {
      if (attempt >= LIFECYCLE_LOCK_WAIT_ATTEMPTS
        || !/Another Tweakers lifecycle operation is active/.test(errorMessage(error))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, LIFECYCLE_LOCK_WAIT_INTERVAL_MS));
    }
  }
  try {
    return await lifecycleContext.run({ lockFile, operation }, run);
  } finally {
    lock.release();
  }
}

/**
 * Compatibility-only typed bridge for callers already running inside the
 * installer/runtime graph. It is intentionally not imported by manager-cli:
 * the sealed manager must remain a narrow, standalone Node artifact and may
 * not load Electron/asar, patching, or general installer CLI code.
 */
import { environment } from "./commands/environment.js";
import { createDesktopUpdateTransaction } from "./desktop-update-transaction.js";
import { ManagerActionAdapterError, TweakersManagerActionAdapter } from "./manager-action-adapter.js";

export function createInProcessTweakersManagerActionAdapter(): TweakersManagerActionAdapter {
  return new TweakersManagerActionAdapter({
    executeEnvironmentCancel: (transactionId) => environment("cancel", { transaction: transactionId, quiet: true }),
    executeEnvironmentRecover: (transactionId) => environment("recover", { transaction: transactionId, quiet: true }),
    async executeDesktopResume(transactionId) {
      const transaction = requireBoundDesktopTransaction(transactionId);
      return transaction.resume();
    },
    async executeDesktopCancel(transactionId) {
      const transaction = requireBoundDesktopTransaction(transactionId);
      return transaction.cancel();
    },
  });
}

/** Bind the old typed updater to the captured receipt before it does any work.
 * A replacement receipt can never inherit a manager operation's approval. */
function requireBoundDesktopTransaction(transactionId: string) {
  const transaction = createDesktopUpdateTransaction();
  const receipt = transaction.status();
  if (receipt?.transactionId !== transactionId) {
    throw new ManagerActionAdapterError(
      "stale_state",
      `Desktop update receipt changed from ${transactionId}; refusing to operate on a replacement receipt`,
    );
  }
  return transaction;
}

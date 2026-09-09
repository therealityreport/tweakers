/**
 * Compatibility-only typed bridge for callers already running inside the
 * installer/runtime graph. It is intentionally not imported by manager-cli:
 * the sealed manager must remain a narrow, standalone Node artifact and may
 * not load Electron/asar, patching, or general installer CLI code.
 */
import { environment } from "./commands/environment.js";
import { TweakersManagerActionAdapter } from "./manager-action-adapter.js";

export function createInProcessTweakersManagerActionAdapter(): TweakersManagerActionAdapter {
  return new TweakersManagerActionAdapter({
    executeEnvironmentCancel: (transactionId) => environment("cancel", { transaction: transactionId, quiet: true }),
    executeEnvironmentRecover: (transactionId) => environment("recover", { transaction: transactionId, quiet: true }),
  });
}

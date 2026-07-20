export type DesktopUpdateTerminalPhase = "completed" | "failed" | "rolled_back";

export interface DesktopLifecycleReceipt {
  phase: string;
  safeOfficialMode: boolean;
  resumable: boolean;
  error: string | null;
}

export function isTerminalDesktopUpdatePhaseValue(
  phase: string,
): phase is DesktopUpdateTerminalPhase {
  return phase === "completed" || phase === "failed" || phase === "rolled_back";
}

/**
 * One fail-closed lifecycle gate for desktop-update receipts.
 *
 * A terminal-looking receipt is still blocking when it advertises a
 * continuation, when official-mode safety was not proved, or when rollback
 * itself failed. Callers must not age this durable evidence out.
 */
export function desktopReceiptBlocksLifecycle(receipt: DesktopLifecycleReceipt): boolean {
  if (!isTerminalDesktopUpdatePhaseValue(receipt.phase)) return true;
  if (receipt.resumable) return true;
  if (receipt.phase !== "failed") return false;
  return receipt.safeOfficialMode !== true || /\brollback failed\b/i.test(receipt.error ?? "");
}

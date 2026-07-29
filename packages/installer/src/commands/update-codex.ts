import kleur from "kleur";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createDesktopUpdateTransaction,
  isTerminalDesktopUpdatePhase,
  type DesktopUpdateReceipt,
  type DesktopUpdateTransaction,
} from "../desktop-update-transaction.js";
import { processAlive } from "../process-lock.js";
import { desktopReceiptBlocksLifecycle } from "../desktop-update-state.js";
import { appendLifecycleAuditRecord } from "../desktop-update-log.js";
import { ensureUserPaths } from "../paths.js";

export interface UpdateCodexOptions {
  app?: string;
  json?: boolean;
}

export interface UpdateCodexCommandDeps {
  createTransaction(options: UpdateCodexOptions): DesktopUpdateTransaction;
  print(line: string): void;
}

const PARKED_PATCHED_RE = /^Codex\.app\.patched-/;

export function pruneParkedPatchedApps(
  backupDir: string,
  keep = 1,
  deps: { readdir?: (dir: string) => string[]; removeDir?: (path: string) => void } = {},
): string[] {
  const readdir = deps.readdir ?? ((dir: string) => readdirSync(dir));
  const removeDir = deps.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  let names: string[];
  try { names = readdir(backupDir); } catch { return []; }
  const parked = names.filter((n) => PARKED_PATCHED_RE.test(n)).sort(); // ascending by timestamp
  const doomed = parked.slice(0, Math.max(0, parked.length - keep)); // remove all but the newest `keep`
  const removed: string[] = [];
  for (const name of doomed) {
    const full = join(backupDir, name);
    try { removeDir(full); removed.push(full); } catch { /* best-effort */ }
  }
  return removed;
}

const DEFAULT_DEPS: UpdateCodexCommandDeps = {
  createTransaction: (options) => createDesktopUpdateTransaction({ appPath: options.app }),
  print: (line) => console.log(line),
};

/** Start the durable official-update continuation shared by Config and Menu Bar. */
export async function updateCodex(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): Promise<DesktopUpdateReceipt> {
  // A durable desktop update always originates from an explicit user action
  // (CLI invocation or a Menu Bar button); record that authorization before
  // the transaction takes its first side effect.
  appendLifecycleAuditRecord(ensureUserPaths().desktopUpdateLogFile, {
    event: "user_approval",
    action: "update-chatgpt",
    detail: "Desktop Update and Reload initiated by explicit user command",
  });
  const receipt = await deps.createTransaction(opts).start();
  printReceipt(receipt, opts, deps);
  return receipt;
}

export function codexUpdateStatus(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): DesktopUpdateReceipt | null {
  const transaction = deps.createTransaction(opts);
  const receipt = transaction.status();
  if (receipt) {
    printReceipt(receipt, opts, deps, {
      annotateOwner: true,
      progress: statusProgress(receipt, transaction.heartbeat()),
    });
  }
  else if (opts.json) deps.print(JSON.stringify({ schemaVersion: 1, kind: "desktop-update", transactionId: null, phase: "idle" }));
  else deps.print(kleur.dim("No desktop Update and Reload transaction has started."));
  return receipt;
}

export async function reconcileCodexUpdate(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): Promise<DesktopUpdateReceipt | null> {
  const receipt = await deps.createTransaction(opts).reconcile();
  if (receipt) printReceipt(receipt, opts, deps);
  else if (opts.json) deps.print(JSON.stringify({ transactionId: null, phase: "idle" }));
  return receipt;
}

export interface DesktopUpdateStatusProgress {
  heartbeat: {
    beatAt: string;
    beatAgeMs: number | null;
    phase: string;
    observed: { marketingVersion: string | null; build: string | null } | null;
  } | null;
  phaseUpdatedAt: string;
  phaseAgeMs: number | null;
}

/** Live progress block for status readers (Menu Bar dialog, Config tab):
 * heartbeat beats every 30s during the native wait and carries the sampled
 * disk version, so pollers can render movement without new phases. */
function statusProgress(
  receipt: DesktopUpdateReceipt,
  heartbeat: ReturnType<DesktopUpdateTransaction["heartbeat"]>,
  nowMs: number = Date.now(),
): DesktopUpdateStatusProgress {
  const matches = heartbeat !== null && heartbeat.transactionId === receipt.transactionId;
  const beatMs = matches ? Date.parse(heartbeat.beatAt) : Number.NaN;
  const updatedMs = Date.parse(receipt.updatedAt);
  return {
    heartbeat: matches
      ? {
          beatAt: heartbeat.beatAt,
          beatAgeMs: Number.isFinite(beatMs) ? Math.max(0, nowMs - beatMs) : null,
          phase: heartbeat.phase,
          observed: heartbeat.observed ?? null,
        }
      : null,
    phaseUpdatedAt: receipt.updatedAt,
    phaseAgeMs: Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : null,
  };
}

export async function resumeCodexUpdate(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): Promise<DesktopUpdateReceipt> {
  const transaction = deps.createTransaction(opts);
  let receipt: DesktopUpdateReceipt;
  try {
    receipt = await transaction.resume();
  } catch (error) {
    // A live owner already driving this transaction means the update is
    // progressing — report its receipt instead of failing the resume request,
    // so UI callers do not render a red error over a healthy run.
    const active = transaction.status();
    const message = error instanceof Error ? error.message : String(error);
    if (active !== null && /owner PID \d+ is still active/i.test(message)) {
      printReceipt(active, opts, deps);
      return active;
    }
    throw error;
  }
  printReceipt(receipt, opts, deps);
  return receipt;
}

export async function cancelCodexUpdate(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): Promise<DesktopUpdateReceipt> {
  const receipt = await deps.createTransaction(opts).cancel();
  printReceipt(receipt, opts, deps);
  return receipt;
}

function printReceipt(
  receipt: DesktopUpdateReceipt,
  opts: UpdateCodexOptions,
  deps: UpdateCodexCommandDeps,
  options: { annotateOwner?: boolean; progress?: DesktopUpdateStatusProgress } = {},
): void {
  // Presentation-layer only: ownerAlive is never persisted into the receipt,
  // so durable evidence and receipt validators are untouched. Null for
  // terminal receipts, where owner liveness is meaningless.
  const ownerAlive = options.annotateOwner === true
    ? (isTerminalDesktopUpdatePhase(receipt.phase) ? null : processAlive(receipt.ownerPid))
    : undefined;
  if (opts.json) {
    deps.print(JSON.stringify({
      ...receipt,
      blocksLifecycle: desktopReceiptBlocksLifecycle(receipt),
      ...(ownerAlive === undefined ? {} : { ownerAlive }),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    }));
    return;
  }
  const tone = receipt.phase === "completed" ? kleur.green
    : receipt.phase === "failed" || receipt.phase === "rolled_back" ? kleur.yellow
    : kleur.cyan;
  deps.print(tone(`Desktop Update and Reload: ${receipt.phase}`));
  deps.print(kleur.dim(`Transaction ${receipt.transactionId}`));
  if (options.progress?.heartbeat) {
    const beat = options.progress.heartbeat;
    const observed = beat.observed
      ? ` · disk ${beat.observed.marketingVersion ?? "?"} (${beat.observed.build ?? "?"})`
      : "";
    const age = beat.beatAgeMs === null ? "" : ` · last beat ${Math.round(beat.beatAgeMs / 1000)}s ago`;
    deps.print(kleur.dim(`Owner live${age}${observed}`));
  }
  if (ownerAlive === false) {
    deps.print(kleur.red(
      `Owner process ${receipt.ownerPid} exited before this update reached a terminal phase — `
      + "recovery required (run update-chatgpt-cancel).",
    ));
  }
  // A receipt's terminal timestamp exists only once it IS terminal; never
  // label updatedAt as terminal for an in-flight receipt.
  if (typeof receipt.terminalAt === "string") {
    deps.print(kleur.dim(`Terminal at ${receipt.terminalAt}`));
  } else {
    deps.print(kleur.dim(`Last update at ${receipt.updatedAt}`));
  }
  if (receipt.error) deps.print(kleur.yellow(receipt.error));
}

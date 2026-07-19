import kleur from "kleur";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createDesktopUpdateTransaction,
  type DesktopUpdateReceipt,
  type DesktopUpdateTransaction,
} from "../desktop-update-transaction.js";

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
  const receipt = await deps.createTransaction(opts).start();
  printReceipt(receipt, opts, deps);
  return receipt;
}

export function codexUpdateStatus(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): DesktopUpdateReceipt | null {
  const receipt = deps.createTransaction(opts).status();
  if (receipt) printReceipt(receipt, opts, deps);
  else if (opts.json) deps.print(JSON.stringify({ schemaVersion: 1, kind: "desktop-update", transactionId: null, phase: "idle" }));
  else deps.print(kleur.dim("No desktop Update and Reload transaction has started."));
  return receipt;
}

export async function resumeCodexUpdate(
  opts: UpdateCodexOptions = {},
  deps: UpdateCodexCommandDeps = DEFAULT_DEPS,
): Promise<DesktopUpdateReceipt> {
  const receipt = await deps.createTransaction(opts).resume();
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
): void {
  if (opts.json) {
    deps.print(JSON.stringify(receipt));
    return;
  }
  const tone = receipt.phase === "completed" ? kleur.green
    : receipt.phase === "failed" || receipt.phase === "rolled_back" ? kleur.yellow
    : kleur.cyan;
  deps.print(tone(`Desktop Update and Reload: ${receipt.phase}`));
  deps.print(kleur.dim(`Transaction ${receipt.transactionId}`));
  if (receipt.error) deps.print(kleur.yellow(receipt.error));
}

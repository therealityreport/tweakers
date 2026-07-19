import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  readEnvironmentTransactionReceipt,
  type EnvironmentTransactionReceipt,
} from "./environment-transaction.js";
import { processAlive as defaultProcessAlive } from "./process-lock.js";

export type EnvironmentGcMode = "dry-run" | "apply";

export interface EnvironmentGcEntry {
  transactionId: string;
  phase: string | null;
  updatedAt: string | null;
  ageMs: number | null;
  preparedPath: string;
  bytes: number | null;
  action: "keep" | "delete" | "deleted";
  reason: string;
}

export interface EnvironmentGcResult {
  schemaVersion: 1;
  kind: "environment-gc";
  mode: EnvironmentGcMode;
  receiptRoot: string;
  currentTransactionId: string | null;
  retainedRollbackTransactionId: string | null;
  eligibleBytes: number;
  reclaimedBytes: number;
  entries: EnvironmentGcEntry[];
}

export interface EnvironmentGcOptions {
  receiptRoot: string;
  transactionFile: string;
  mode: EnvironmentGcMode;
  now?: Date;
  processAlive?: (pid: number) => boolean;
  /** Test-only seam used to prove apply revalidates after its initial plan. */
  beforeDelete?: (entry: EnvironmentGcEntry) => void;
  removePrepared?: (path: string) => void;
}

const TERMINAL_PHASES = new Set(["committed", "rolled-back", "failed", "cancelled"]);
const SAFE_TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface ReceiptRecord {
  receipt: EnvironmentTransactionReceipt | null;
  error: string | null;
}

interface GcSnapshot {
  entries: EnvironmentGcEntry[];
  currentTransactionId: string | null;
  retainedRollbackTransactionId: string | null;
}

/**
 * Preview or reclaim terminal environment transaction preparation artifacts.
 * The caller owns the shared lifecycle lock. Apply mode still recomputes the
 * complete store immediately before each deletion so stale plans fail closed.
 */
export function runEnvironmentTransactionGc(options: EnvironmentGcOptions): EnvironmentGcResult {
  const receiptRoot = exactAbsoluteDirectory(options.receiptRoot, "environment receipt root");
  const transactionFile = exactAbsolutePath(options.transactionFile, "environment transaction file");
  const now = options.now ?? new Date();
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const removePrepared = options.removePrepared
    ?? ((path: string) => rmSync(path, { recursive: true, force: false }));
  const first = collectSnapshot(receiptRoot, transactionFile, now, processAlive);
  const eligibleBytes = first.entries.reduce(
    (total, entry) => total + (entry.action === "delete" ? entry.bytes ?? 0 : 0),
    0,
  );

  if (options.mode === "dry-run") {
    return {
      schemaVersion: 1,
      kind: "environment-gc",
      mode: "dry-run",
      receiptRoot,
      currentTransactionId: first.currentTransactionId,
      retainedRollbackTransactionId: first.retainedRollbackTransactionId,
      eligibleBytes,
      reclaimedBytes: 0,
      entries: first.entries,
    };
  }

  const entries: EnvironmentGcEntry[] = [];
  let reclaimedBytes = 0;
  for (const planned of first.entries) {
    if (planned.action !== "delete") {
      entries.push(planned);
      continue;
    }
    options.beforeDelete?.(planned);
    const fresh = collectSnapshot(receiptRoot, transactionFile, now, processAlive);
    const revalidated = fresh.entries.find((entry) => entry.transactionId === planned.transactionId);
    if (!revalidated || revalidated.action !== "delete") {
      entries.push({
        ...(revalidated ?? planned),
        action: "keep",
        reason: revalidated
          ? `apply revalidation refused deletion: ${revalidated.reason}`
          : "apply revalidation refused deletion: transaction disappeared from the store",
      });
      continue;
    }
    removePrepared(revalidated.preparedPath);
    reclaimedBytes += revalidated.bytes ?? 0;
    entries.push({ ...revalidated, action: "deleted", reason: "deleted after locked revalidation" });
  }

  return {
    schemaVersion: 1,
    kind: "environment-gc",
    mode: "apply",
    receiptRoot,
    currentTransactionId: first.currentTransactionId,
    retainedRollbackTransactionId: first.retainedRollbackTransactionId,
    eligibleBytes,
    reclaimedBytes,
    entries,
  };
}

function collectSnapshot(
  receiptRoot: string,
  transactionFile: string,
  now: Date,
  processAlive: (pid: number) => boolean,
): GcSnapshot {
  const receipts = new Map<string, ReceiptRecord>();
  let storeUnsafeReason: string | null = null;
  let currentReceipt: EnvironmentTransactionReceipt | null = null;

  if (existsSync(transactionFile)) {
    try {
      currentReceipt = readEnvironmentTransactionReceipt(transactionFile);
    } catch (error) {
      storeUnsafeReason = `current transaction receipt is unreadable: ${errorMessage(error)}`;
    }
  }

  for (const entry of safeDirectoryEntries(receiptRoot)) {
    if (!entry.name.endsWith(".json")) continue;
    const transactionId = entry.name.slice(0, -".json".length);
    if (!SAFE_TRANSACTION_ID.test(transactionId)) continue;
    const file = join(receiptRoot, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      receipts.set(transactionId, { receipt: null, error: "archived receipt is not a regular file" });
      continue;
    }
    try {
      const receipt = readEnvironmentTransactionReceipt(file);
      if (!receipt || receipt.transactionId !== transactionId) {
        receipts.set(transactionId, { receipt: null, error: "archived receipt identity does not match its filename" });
      } else {
        receipts.set(transactionId, { receipt, error: null });
      }
    } catch (error) {
      receipts.set(transactionId, { receipt: null, error: `archived receipt is unreadable: ${errorMessage(error)}` });
    }
  }

  if (currentReceipt && !receipts.has(currentReceipt.transactionId)) {
    receipts.set(currentReceipt.transactionId, { receipt: currentReceipt, error: null });
  }

  const retainedRollbackTransactionId = latestCommittedReceipt(
    [...receipts.values()].map((record) => record.receipt).filter(isReceipt),
  )?.transactionId ?? null;
  const directoryIds = safeDirectoryEntries(receiptRoot)
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => SAFE_TRANSACTION_ID.test(name));
  const ids = [...new Set([...receipts.keys(), ...directoryIds])].sort();

  const entries = ids.flatMap((transactionId): EnvironmentGcEntry[] => {
    const transactionDirectory = join(receiptRoot, transactionId);
    const preparedPath = join(transactionDirectory, "prepared");
    if (!existsSync(preparedPath)) return [];
    const record = receipts.get(transactionId);
    const receipt = record?.receipt ?? null;
    const size = safePreparedSize(receiptRoot, transactionId, preparedPath);
    const base = {
      transactionId,
      phase: receipt?.phase ?? null,
      updatedAt: receipt?.updatedAt ?? null,
      ageMs: receipt ? Math.max(0, now.getTime() - Date.parse(receipt.updatedAt)) : null,
      preparedPath,
      bytes: size.bytes,
    };
    if (storeUnsafeReason) return [{ ...base, action: "keep", reason: storeUnsafeReason }];
    if (!record) return [{ ...base, action: "keep", reason: "no archived receipt owns this prepared directory" }];
    if (record.error || !receipt) return [{ ...base, action: "keep", reason: record.error ?? "receipt is invalid" }];
    if (currentReceipt?.transactionId === transactionId) {
      return [{ ...base, action: "keep", reason: "referenced by the current environment transaction receipt" }];
    }
    if (!TERMINAL_PHASES.has(receipt.phase)) {
      return [{ ...base, action: "keep", reason: `non-terminal transaction phase ${receipt.phase}` }];
    }
    if (processAlive(receipt.ownerPid)) {
      return [{ ...base, action: "keep", reason: `receipt owner PID ${receipt.ownerPid} is still alive` }];
    }
    if (retainedRollbackTransactionId === transactionId) {
      return [{ ...base, action: "keep", reason: "newest committed rollback candidate" }];
    }
    const evidenceError = preparedEvidencePathError(receipt, preparedPath);
    if (evidenceError) return [{ ...base, action: "keep", reason: evidenceError }];
    if (size.error) return [{ ...base, action: "keep", reason: size.error }];
    return [{ ...base, action: "delete", reason: `terminal ${receipt.phase} transaction is superseded or recoverable evidence is no longer active` }];
  });

  return {
    entries,
    currentTransactionId: currentReceipt?.transactionId ?? null,
    retainedRollbackTransactionId,
  };
}

function latestCommittedReceipt(receipts: EnvironmentTransactionReceipt[]): EnvironmentTransactionReceipt | null {
  return receipts
    .filter((receipt) => receipt.phase === "committed" && receipt.committedAt !== null)
    .sort((a, b) => {
      const byTime = Date.parse(b.committedAt!) - Date.parse(a.committedAt!);
      return byTime !== 0 ? byTime : b.transactionId.localeCompare(a.transactionId);
    })[0] ?? null;
}

function preparedEvidencePathError(receipt: EnvironmentTransactionReceipt, preparedRoot: string): string | null {
  if (!receipt.prepared) return null;
  const paths = [
    receipt.prepared.candidate.artifactPath,
    receipt.prepared.backend.artifactPath,
    receipt.prepared.rollback.desktopArtifactPath,
    receipt.prepared.rollback.backendArtifactPath,
  ];
  return paths.every((path) => exactDescendant(preparedRoot, path))
    ? null
    : "prepared evidence references a path outside its canonical prepared directory";
}

function safePreparedSize(
  receiptRoot: string,
  transactionId: string,
  preparedPath: string,
): { bytes: number | null; error: string | null } {
  try {
    const expectedTransaction = join(receiptRoot, transactionId);
    if (!exactDescendant(receiptRoot, expectedTransaction) || !exactDescendant(expectedTransaction, preparedPath)) {
      return { bytes: null, error: "prepared path is outside the canonical transaction root" };
    }
    if (lstatSync(expectedTransaction).isSymbolicLink() || lstatSync(preparedPath).isSymbolicLink()) {
      return { bytes: null, error: "prepared path or transaction directory is a symlink" };
    }
    const canonicalRoot = realpathSync(receiptRoot);
    const canonicalPrepared = realpathSync(preparedPath);
    if (!exactDescendant(canonicalRoot, canonicalPrepared)) {
      return { bytes: null, error: "prepared path resolves outside the transaction store" };
    }
    return {
      bytes: directoryBytesWithoutFollowingSymlinks(preparedPath, canonicalPrepared),
      error: null,
    };
  } catch (error) {
    return { bytes: null, error: `prepared directory is unsafe or unreadable: ${errorMessage(error)}` };
  }
}

function directoryBytesWithoutFollowingSymlinks(path: string, canonicalPreparedRoot: string): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const canonicalTarget = realpathSync(path);
    if (!exactDescendant(canonicalPreparedRoot, canonicalTarget)) {
      throw new Error(`symlink resolves outside the canonical prepared directory at ${path}`);
    }
    return stat.size;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = stat.size;
  for (const entry of readdirSync(path)) {
    total += directoryBytesWithoutFollowingSymlinks(join(path, entry), canonicalPreparedRoot);
  }
  return total;
}

function safeDirectoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
}

function exactDescendant(parent: string, child: string): boolean {
  if (!isAbsolute(child) || normalize(child) !== child) return false;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function exactAbsoluteDirectory(path: string, label: string): string {
  const exact = exactAbsolutePath(path, label);
  if (existsSync(exact) && lstatSync(exact).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  return exact;
}

function exactAbsolutePath(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || normalize(path) !== path || exact !== path) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return exact;
}

function isReceipt(value: EnvironmentTransactionReceipt | null): value is EnvironmentTransactionReceipt {
  return value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

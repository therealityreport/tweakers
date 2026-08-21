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
import {
  assertEnvironmentModePairMaterialized,
  environmentModePairReceiptDigest,
  environmentModeCacheGenerationPaths,
  environmentModeCacheReachability,
  readCurrentEnvironmentModePair,
  readEnvironmentModePairGeneration,
  type EnvironmentModeCachePaths,
  type EnvironmentModePairReceipt,
} from "./environment-mode-cache.js";
import {
  readEnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitReceipt,
} from "./environment-warm-commit.js";
import { acquireProcessLock } from "./process-lock.js";

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
  /** Schema-v2 sealed-pair payload classification; receipts are never deleted. */
  generationEntries: EnvironmentModeCacheGcEntry[];
}

export interface EnvironmentModeCacheGcEntry {
  generationId: string;
  pinState: string | null;
  generationPath: string;
  bytes: number | null;
  action: "keep" | "delete" | "deleted";
  reason: string;
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
  /** Optional because schema-v2 is default-off and old installations have no cache root. */
  cachePaths?: EnvironmentModeCachePaths;
  /** Test-only seam immediately before one cache payload is revalidated/deleted. */
  beforeDeleteGeneration?: (entry: EnvironmentModeCacheGcEntry) => void;
  removeGenerationPayload?: (paths: string[]) => void;
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

interface ModeCacheGcSnapshot {
  entries: EnvironmentModeCacheGcEntry[];
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
  const removePrepared = options.removePrepared
    ?? ((path: string) => rmSync(path, { recursive: true, force: false }));
  const first = collectSnapshot(receiptRoot, transactionFile, now, options.cachePaths);
  const modeCache = options.cachePaths === undefined
    ? { entries: [] as EnvironmentModeCacheGcEntry[], reclaimedBytes: 0, eligibleBytes: 0 }
    : runEnvironmentModeCacheGc({
      paths: options.cachePaths,
      mode: options.mode,
      beforeDelete: options.beforeDeleteGeneration,
      removePayload: options.removeGenerationPayload,
    });
  const eligibleBytes = first.entries.reduce(
    (total, entry) => total + (entry.action === "delete" ? entry.bytes ?? 0 : 0),
    modeCache.eligibleBytes,
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
      generationEntries: modeCache.entries,
    };
  }

  const entries: EnvironmentGcEntry[] = [];
  let reclaimedBytes = modeCache.reclaimedBytes;
  for (const planned of first.entries) {
    if (planned.action !== "delete") {
      entries.push(planned);
      continue;
    }
    options.beforeDelete?.(planned);
    const fresh = collectSnapshot(receiptRoot, transactionFile, now, options.cachePaths);
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
    generationEntries: modeCache.entries,
  };
}

function collectSnapshot(
  receiptRoot: string,
  transactionFile: string,
  now: Date,
  cachePaths: EnvironmentModeCachePaths | undefined,
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

  const directoryIds = safeDirectoryEntries(receiptRoot)
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => SAFE_TRANSACTION_ID.test(name));
  const ids = [...new Set([...receipts.keys(), ...directoryIds])].sort();
  // A legacy v1 committed preparation remains the only rollback evidence
  // until the *current* v2 pointer proves a completed, materialized warm
  // pair. Generation receipt shadows are deliberately not considered here:
  // current.json is the authority, and a torn shadow cannot retire v1 bytes.
  const retainedRollbackTransactionId = hasProvedCurrentEnvironmentModeV2Pair(cachePaths)
    ? null
    : newestCommittedRollbackTransactionId(receipts, receiptRoot, ids);

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
    if (currentReceipt?.transactionId === transactionId && !TERMINAL_PHASES.has(receipt.phase)) {
      return [{ ...base, action: "keep", reason: "referenced by the current environment transaction receipt" }];
    }
    if (!TERMINAL_PHASES.has(receipt.phase)) {
      return [{ ...base, action: "keep", reason: `non-terminal transaction phase ${receipt.phase}` }];
    }
    if (transactionId === retainedRollbackTransactionId && receipt.phase === "committed") {
      return [{
        ...base,
        action: "keep",
        reason: "newest committed schema-v1 rollback evidence is retained until a proved current schema-v2 pair safely supersedes it",
      }];
    }
    if (hasUnconsumedRollbackEvidence(receipt)) {
      return [{
        ...base,
        action: "keep",
        reason: "failed transaction still owns the only copy of its rollback evidence",
      }];
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

/**
 * Return the sole newest usable v1 committed preparation. We deliberately
 * retain only one bounded candidate and fail closed for unreadable/missing
 * evidence; malformed receipts are already individually protected below.
 */
function newestCommittedRollbackTransactionId(
  receipts: ReadonlyMap<string, ReceiptRecord>,
  receiptRoot: string,
  ids: readonly string[],
): string | null {
  const candidates = ids.flatMap((transactionId) => {
    const receipt = receipts.get(transactionId)?.receipt;
    if (receipt?.phase !== "committed" || receipt.committedAt === null) return [];
    const preparedPath = join(receiptRoot, transactionId, "prepared");
    if (!existsSync(preparedPath)) return [];
    // Retain a real rollback candidate, not merely the newest filename. An
    // unsafe/symlinked tree is individually fail-closed below but must not
    // displace the last usable committed rollback evidence.
    if (receipt.prepared === null
      || preparedEvidencePathError(receipt, preparedPath) !== null
      || safePreparedSize(receiptRoot, transactionId, preparedPath).error !== null) {
      return [];
    }
    return [{ transactionId, committedAt: receipt.committedAt, updatedAt: receipt.updatedAt }];
  });
  candidates.sort((left, right) => {
    const committed = Date.parse(right.committedAt) - Date.parse(left.committedAt);
    if (committed !== 0) return committed;
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updated !== 0) return updated;
    return right.transactionId.localeCompare(left.transactionId);
  });
  return candidates[0]?.transactionId ?? null;
}

/**
 * A v2 generation can supersede the bounded v1 rollback candidate only after
 * the authoritative current pointer, pair materialization, and terminal
 * warm-commit journal all agree on the same completed target direction.
 * Any ambiguity (including a torn generation receipt) retains v1 evidence.
 */
function hasProvedCurrentEnvironmentModeV2Pair(
  cachePaths: EnvironmentModeCachePaths | undefined,
): boolean {
  if (cachePaths === undefined) return false;
  try {
    const current = readCurrentEnvironmentModePair(cachePaths);
    if (current === null
      || current.pin.state !== "prepared"
      || current.pin.releasedAt !== null
      || current.timestamps.lastSuccessfulSwitchAt === null) {
      return false;
    }
    assertEnvironmentModePairMaterialized(cachePaths, current);
    const journal = readEnvironmentWarmCommitReceipt(
      join(current.paths.generationRoot, "warm-commit.json"),
    );
    return journal !== null
      && journal.generationId === current.generationId
      && journal.pairReceiptDigest === environmentModePairReceiptDigest(current)
      && journal.phase === "ready"
      && journal.terminalAt !== null
      && journal.targetMainPid !== null
      && journal.stamps.some((stamp) => stamp.phase === "terminal-target-proven");
  } catch {
    return false;
  }
}

/**
 * Reachability GC for schema-v2 sealed pairs. It removes all generation-owned
 * payload/control/helper artifacts and leaves only the pair receipt plus warm
 * journal as compact audit evidence. The caller owns lifecycle
 * serialization; this function separately owns the cache mutex and repeats
 * the full containment/reachability check immediately before every mutation.
 */
export function runEnvironmentModeCacheGc(options: {
  paths: EnvironmentModeCachePaths;
  mode: EnvironmentGcMode;
  beforeDelete?: (entry: EnvironmentModeCacheGcEntry) => void;
  removePayload?: (paths: string[]) => void;
}): { entries: EnvironmentModeCacheGcEntry[]; eligibleBytes: number; reclaimedBytes: number } {
  if (!existsSync(options.paths.cacheRoot)) {
    return { entries: [], eligibleBytes: 0, reclaimedBytes: 0 };
  }
  assertRealDirectory(options.paths.cacheRoot, "environment mode cache root");
  const lock = acquireProcessLock(options.paths.lockFile, {
    onContended: () => new Error("Environment mode cache GC mutex is already held"),
  });
  try {
    const first = collectModeCacheSnapshot(options.paths);
    const eligibleBytes = first.entries.reduce(
      (total, entry) => total + (entry.action === "delete" ? entry.bytes ?? 0 : 0),
      0,
    );
    if (options.mode === "dry-run") return { entries: first.entries, eligibleBytes, reclaimedBytes: 0 };

    const entries: EnvironmentModeCacheGcEntry[] = [];
    let reclaimedBytes = 0;
    for (const planned of first.entries) {
      if (planned.action !== "delete") {
        entries.push(planned);
        continue;
      }
      options.beforeDelete?.(planned);
      const fresh = collectModeCacheSnapshot(options.paths);
      const revalidated = fresh.entries.find((entry) => entry.generationId === planned.generationId);
      if (revalidated === undefined || revalidated.action !== "delete") {
        entries.push({
          ...(revalidated ?? planned),
          action: "keep",
          reason: revalidated === undefined
            ? "apply revalidation refused deletion: generation disappeared from the store"
            : `apply revalidation refused deletion: ${revalidated.reason}`,
        });
        continue;
      }
      const generation = environmentModeCacheGenerationPaths(options.paths, revalidated.generationId);
      const payloadPaths = environmentModeGenerationPayloadPaths(generation);
      assertGenerationPayloadContained(options.paths, generation.generationRoot, payloadPaths);
      (options.removePayload ?? ((paths) => {
        for (const path of paths) if (existsSync(path)) rmSync(path, { recursive: true, force: false });
      }))(payloadPaths);
      reclaimedBytes += revalidated.bytes ?? 0;
      entries.push({ ...revalidated, action: "deleted", reason: "deleted unreachable generation payload after locked revalidation" });
    }
    return { entries, eligibleBytes, reclaimedBytes };
  } finally {
    lock.release();
  }
}

function collectModeCacheSnapshot(paths: EnvironmentModeCachePaths): ModeCacheGcSnapshot {
  let current: EnvironmentModePairReceipt | null = null;
  let unsafeReason: string | null = null;
  try {
    current = readCurrentEnvironmentModePair(paths);
  } catch (error) {
    unsafeReason = `current mode-cache receipt is unreadable: ${errorMessage(error)}`;
  }
  if (!existsSync(paths.generationsRoot)) return { entries: [] };
  try {
    assertRealDirectory(paths.generationsRoot, "environment mode cache generations root");
  } catch (error) {
    return { entries: [{ generationId: "<generations>", pinState: null, generationPath: paths.generationsRoot, bytes: null, action: "keep", reason: errorMessage(error) }] };
  }
  const entries = safeDirectoryEntries(paths.generationsRoot)
    .filter((entry) => SAFE_TRANSACTION_ID.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry): EnvironmentModeCacheGcEntry => {
      const generation = environmentModeCacheGenerationPaths(paths, entry.name);
      const base = {
        generationId: entry.name,
        pinState: null,
        generationPath: generation.generationRoot,
        bytes: null,
      };
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return { ...base, action: "keep", reason: "generation directory is not a real directory" };
      }
      let receipt: EnvironmentModePairReceipt | null;
      try {
        receipt = readEnvironmentModePairGeneration(paths, entry.name);
      } catch (error) {
        return { ...base, action: "keep", reason: `generation receipt is unsafe or unreadable: ${errorMessage(error)}` };
      }
      if (receipt === null) return { ...base, action: "keep", reason: "generation has no receipt" };
      const withReceipt = { ...base, pinState: receipt.pin.state };
      if (unsafeReason !== null) return { ...withReceipt, action: "keep", reason: unsafeReason };
      let journal: EnvironmentWarmCommitReceipt | null = null;
      try {
        journal = readEnvironmentWarmCommitReceipt(join(generation.generationRoot, "warm-commit.json"));
      } catch (error) {
        return { ...withReceipt, action: "keep", reason: `warm recovery journal is unsafe or unreadable: ${errorMessage(error)}` };
      }
      if (journal !== null && journal.generationId !== receipt.generationId) {
        return { ...withReceipt, action: "keep", reason: "warm recovery journal does not bind this generation" };
      }
      if (current?.generationId === receipt.generationId) {
        // A released current receipt remains the atomic authority until a
        // replacement publication (or an explicit future pointer-clear)
        // commits. Never leave current.json pointing at reclaimed payload.
        return {
          ...withReceipt,
          action: "keep",
          reason: receipt.pin.state === "prepared" && receipt.pin.releasedAt === null
            ? "current prepared grant remains reachable"
            : receipt.pin.state === "post_cutover_recovery" && journal !== null && journal.terminalAt === null
              ? "nonterminal post-cutover recovery journal reaches generation"
            : "current generation is awaiting an atomic replacement or clear",
        };
      }
      const reachability = environmentModeCacheReachability(receipt, current?.generationId ?? null);
      if (reachability === "prepared_grant") {
        return { ...withReceipt, action: "keep", reason: "current prepared grant remains reachable" };
      }
      if (reachability === "post_cutover_recovery" && journal !== null && journal.terminalAt === null) {
        return { ...withReceipt, action: "keep", reason: "nonterminal post-cutover recovery journal reaches generation" };
      }
      if (reachability === "post_cutover_recovery") {
        return { ...withReceipt, action: "keep", reason: "post-cutover reachability lacks a clear nonterminal recovery journal" };
      }
      try {
        const payloadPaths = environmentModeGenerationPayloadPaths(generation);
        assertGenerationPayloadContained(paths, generation.generationRoot, payloadPaths);
        const bytes = payloadPaths.reduce((total, path) => total + (existsSync(path)
          ? directoryBytesWithoutFollowingSymlinks(path, generation.generationRoot)
          : 0), 0);
        return { ...withReceipt, bytes, action: "delete", reason: "generation is unreachable and has no recovery owner" };
      } catch (error) {
        return { ...withReceipt, action: "keep", reason: `generation payload is unsafe or unreadable: ${errorMessage(error)}` };
      }
    });
  return { entries };
}

function assertGenerationPayloadContained(
  paths: EnvironmentModeCachePaths,
  generationRoot: string,
  payloadPaths: string[],
): void {
  assertRealDirectory(paths.cacheRoot, "environment mode cache root");
  assertRealDirectory(paths.generationsRoot, "environment mode cache generations root");
  if (!exactDescendant(paths.generationsRoot, generationRoot)) {
    throw new Error("generation root is outside the canonical generations store");
  }
  if (lstatSync(generationRoot).isSymbolicLink()) throw new Error("generation root is a symlink");
  const canonicalGeneration = realpathSync(generationRoot);
  const allowed = new Set([
    "receipt.json",
    "warm-commit.json",
    "inactive",
    "runtime",
    "managed-runtime",
    "backend",
    "native",
    "projection",
    "control-v2.json",
    "commit-helper.json",
    `co.tweakers.environment.${generationRoot.split("/").at(-1)}.sh`,
    `co.tweakers.environment.${generationRoot.split("/").at(-1)}.stdout.log`,
    `co.tweakers.environment.${generationRoot.split("/").at(-1)}.stderr.log`,
    `co.tweakers.environment.${generationRoot.split("/").at(-1)}.outcome.json`,
  ]);
  for (const entry of readdirSync(generationRoot, { withFileTypes: true })) {
    const previousHelperReceipt = entry.name.startsWith("commit-helper.json.") && entry.name.endsWith(".previous");
    const previousHelperOutcome = entry.name.startsWith(`co.tweakers.environment.${generationRoot.split("/").at(-1)}.outcome.json.`)
      && entry.name.endsWith(".previous");
    if (!allowed.has(entry.name) && !previousHelperReceipt && !previousHelperOutcome) {
      throw new Error(`generation contains an unexpected retained payload entry: ${entry.name}`);
    }
  }
  for (const path of payloadPaths) {
    if (!exactDescendant(generationRoot, path)) throw new Error("generation payload is outside its canonical generation root");
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) throw new Error("generation payload root is a symlink");
    const canonical = realpathSync(path);
    if (!exactDescendant(canonicalGeneration, canonical)) throw new Error("generation payload resolves outside its canonical generation root");
  }
}

function environmentModeGenerationPayloadPaths(
  generation: ReturnType<typeof environmentModeCacheGenerationPaths>,
): string[] {
  const label = `co.tweakers.environment.${generation.generationId}`;
  const fixed = [
    generation.inactiveRoot,
    generation.runtimeRoot,
    generation.managedRuntimeRoot,
    join(generation.generationRoot, "backend"),
    join(generation.generationRoot, "native"),
    join(generation.generationRoot, "projection"),
    join(generation.generationRoot, "control-v2.json"),
    join(generation.generationRoot, "commit-helper.json"),
    join(generation.generationRoot, `${label}.sh`),
    join(generation.generationRoot, `${label}.stdout.log`),
    join(generation.generationRoot, `${label}.stderr.log`),
    join(generation.generationRoot, `${label}.outcome.json`),
  ];
  const previous = safeDirectoryEntries(generation.generationRoot)
    .map((entry) => entry.name)
    .filter((name) => (name.startsWith("commit-helper.json.")
      || name.startsWith(`${label}.outcome.json.`)) && name.endsWith(".previous"))
    .map((name) => join(generation.generationRoot, name));
  return [...fixed, ...previous];
}

/**
 * `failed` is terminal but not necessarily finished: a transaction that failed
 * without ever applying or rolling back still has recovery ahead of it, and its
 * prepared directory holds the only rollback bytes. Collecting those would turn
 * a recoverable receipt into a permanently stuck one.
 */
function hasUnconsumedRollbackEvidence(receipt: EnvironmentTransactionReceipt): boolean {
  return receipt.phase === "failed"
    && receipt.prepared !== null
    && receipt.applied === null
    && receipt.rolledBackAt === null
    && receipt.committedAt === null;
}

function preparedEvidencePathError(receipt: EnvironmentTransactionReceipt, preparedRoot: string): string | null {
  if (!receipt.prepared) return null;
  const paths = [
    receipt.prepared.candidate.artifactPath,
    receipt.prepared.backend.artifactPath,
    receipt.prepared.rollback.desktopArtifactPath,
    receipt.prepared.rollback.backendArtifactPath,
    ...(receipt.prepared.runtime
      ? [
          receipt.prepared.runtime.requested.artifactPath,
          receipt.prepared.runtime.rollback.artifactPath,
        ]
      : []),
    ...(receipt.prepared.managedRuntime
      ? [
          receipt.prepared.managedRuntime.requested.artifactPath,
          receipt.prepared.managedRuntime.rollback.artifactPath,
        ]
      : []),
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

function assertRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function exactAbsolutePath(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || normalize(path) !== path || exact !== path) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return exact;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

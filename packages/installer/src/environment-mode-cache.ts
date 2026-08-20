import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { acquireProcessLock } from "./process-lock.js";
import {
  OPENAI_TEAM_IDENTIFIER,
  type AppExperience,
  type ReleaseProfile,
} from "./environment-profile.js";

/**
 * The pair cache deliberately has its own receipt schema.  It is not an
 * environment-transaction receipt and T2 does not make it authoritative for
 * switching.  Later transaction work may adopt only a fully verified current
 * pair through the typed seam exported from this module.
 */
export const ENVIRONMENT_MODE_CACHE_SCHEMA_VERSION = 2 as const;
export const ENVIRONMENT_MODE_CACHE_KIND = "environment-mode-pair" as const;

const SAFE_GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const EMPTY_CONTENT_PAYLOAD_DIGEST = createHash("sha256").update("").digest("hex");

export type EnvironmentModeCacheState = "ready" | "preparing" | "stale" | "unavailable";
export type EnvironmentModeCachePinState =
  | "prepared"
  | "post_cutover_recovery"
  | "stale_requires_prepare"
  | "cancelled"
  | "abandoned";
export type EnvironmentModeCacheReachability =
  | "prepared_grant"
  | "post_cutover_recovery"
  | "unreachable";
export type EnvironmentModeCacheEntryType = "directory" | "file" | "symlink";
export type EnvironmentModeCacheValidationState = "ready" | "stale_requires_prepare" | "unavailable";

export interface EnvironmentModeCachePaths {
  /** `.../environment-cache`; this is always an installer-owned real directory. */
  cacheRoot: string;
  /** The sole atomic role-state publication point. */
  currentFile: string;
  generationsRoot: string;
  /** Exactly one generation directory may exist below this root while preparing. */
  preparationRoot: string;
  /** Alias retained to make call sites read naturally. */
  nextRoot: string;
  lockFile: string;
}

export interface EnvironmentModeCacheGenerationPaths {
  generationId: string;
  generationRoot: string;
  receiptFile: string;
  inactiveRoot: string;
  /** The inactive app is always neutral and never encodes the active role in its path. */
  inactiveAppPath: string;
  runtimeRoot: string;
  managedRuntimeRoot: string;
}

export interface EnvironmentModeCachePreparationPaths extends EnvironmentModeCacheGenerationPaths {
  preparationRoot: string;
}

export interface EnvironmentModeCacheStatSealRecord {
  /** Empty only for the sealed tree root. All other paths are slash-separated descendants. */
  relativePath: string;
  type: EnvironmentModeCacheEntryType;
  /** Decimal strings preserve bigint filesystem identifiers in JSON. */
  dev: string;
  ino: string;
  size: string;
  mode: string;
  mtimeNs: string;
  ctimeNs: string;
  /** Required for symlinks and null for regular entries. */
  symlinkTarget: string | null;
}

/**
 * Logical payload evidence for one sealed tree entry.  Preparation calculates
 * every file payload digest; directory records bind their path/type/mode with
 * the fixed empty payload digest and symlink records bind the link target.
 * Keeping this independently composable lets a later verified Contents-only
 * exchange re-root the already-bound evidence without rereading file bytes.
 */
export interface EnvironmentModeCacheContentSealRecord {
  relativePath: string;
  type: EnvironmentModeCacheEntryType;
  /** Decimal mode exactly matching the corresponding stat-seal record. */
  mode: string;
  payloadDigest: string;
}

export interface EnvironmentModeCacheTreeStatSeal {
  rootPath: string;
  entries: EnvironmentModeCacheStatSealRecord[];
  /** Ordered logical payload evidence matching `entries` one-for-one. */
  contentEntries: EnvironmentModeCacheContentSealRecord[];
  /** SHA-256 over the ordered stat-seal records, not file-content evidence. */
  sealDigest: string;
  /**
   * SHA-256 over the ordered logical payload records. This remains independent
   * of the stat seal: preserving a size, mtime, or even a complete stat tuple
   * cannot make different staged bytes acceptable.
   */
  contentDigest: string;
}

export interface EnvironmentModeCacheSignatureEvidence {
  strict: boolean;
  gatekeeper: boolean;
  teamIdentifier: string | null;
  designatedRequirement: string | null;
  signatureDigest: string;
}

export interface EnvironmentModeCacheAppEvidence {
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  version: string;
  build: string;
  appDigest: string;
  asarPath: string;
  asarDigest: string;
  asarHeaderDigest: string;
  signature: EnvironmentModeCacheSignatureEvidence;
}

export interface EnvironmentModeCacheArtifactProvenance {
  rootPath: string;
  digest: string;
  fileCount: number;
  provenanceDigest: string;
}

export interface EnvironmentModeCacheTweakersProvenance {
  buildDigest: string;
  patchPayloadDigest: string;
  sourceControlDigest: string;
  runtime: EnvironmentModeCacheArtifactProvenance;
  managedRuntime: EnvironmentModeCacheArtifactProvenance;
  backend: EnvironmentModeCacheArtifactProvenance & {
    lane: "bundled" | "managed-alpha";
    version: string;
  };
  nativeHost: EnvironmentModeCacheArtifactProvenance & {
    executablePath: string;
  };
}

export interface EnvironmentModeCacheRole {
  role: "live" | "inactive";
  experience: AppExperience;
  appPath: string;
  evidence: EnvironmentModeCacheAppEvidence;
}

/**
 * This object is intentionally one receipt field rather than two mutable
 * state files.  A reader observes both roles from the same atomic current
 * publication or neither role at all.
 */
export interface EnvironmentModeCacheRoleState {
  live: EnvironmentModeCacheRole;
  inactive: EnvironmentModeCacheRole;
}

export interface EnvironmentModeCacheReceiptPaths {
  cacheRoot: string;
  currentFile: string;
  generationRoot: string;
  receiptFile: string;
  inactiveAppPath: string;
  runtimeRoot: string;
  managedRuntimeRoot: string;
}

export interface EnvironmentModeCachePairSeals {
  liveApp: EnvironmentModeCacheTreeStatSeal;
  inactiveApp: EnvironmentModeCacheTreeStatSeal;
  runtime: EnvironmentModeCacheTreeStatSeal;
  managedRuntime: EnvironmentModeCacheTreeStatSeal;
}

/** Exact directory identity used to prove a native `RENAME_SWAP` role exchange. */
export interface EnvironmentModeCacheContentsIdentity {
  path: string;
  dev: string;
  ino: string;
}

/**
 * Evidence for the enclosing `.app` directory. `Contents` is the only item
 * exchanged; these facts must therefore survive unchanged on each outer app.
 * The stat record retains the post-exchange timestamp fields needed to rotate
 * a stat seal without rescanning or hashing the complete content tree.
 */
export interface EnvironmentModeCacheOuterAppEvidence {
  path: string;
  stat: EnvironmentModeCacheStatSealRecord;
  uid: string;
  gid: string;
  aclDigest: string;
  xattrDigest: string;
  /** Separate evidence for com.apple.quarantine (including the proven absent state). */
  quarantineDigest: string;
}

/**
 * Captured immediately around one native Contents exchange.  The proof is
 * deliberately independent from the swap implementation so a signed host and
 * a test-owned fake use exactly the same continuity checks.
 */
export interface EnvironmentModePairContentsExchangeProof {
  liveContentsBefore: EnvironmentModeCacheContentsIdentity;
  inactiveContentsBefore: EnvironmentModeCacheContentsIdentity;
  liveContentsAfter: EnvironmentModeCacheContentsIdentity;
  inactiveContentsAfter: EnvironmentModeCacheContentsIdentity;
  liveOuterBefore: EnvironmentModeCacheOuterAppEvidence;
  inactiveOuterBefore: EnvironmentModeCacheOuterAppEvidence;
  liveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
  inactiveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
}

/**
 * Holds the pair-cache mutex across an approved warm exchange.  It exposes no
 * preparation, copying, or deletion capability: the only mutation is the
 * receipt rotation that records an already-proven Contents role exchange.
 */
export interface EnvironmentModePairWarmCommitLease {
  /** Always the newest receipt persisted while the lease remains held. */
  readonly receipt: EnvironmentModePairReceipt;
  /**
   * Release a drifted prepared grant while the warm-commit mutex is held.
   * This is pre-cutover only and never changes application or runtime bytes.
   */
  invalidateBeforeCutover(invalidatedAt: string): EnvironmentModePairReceipt;
  completeContentsExchange(
    proof: EnvironmentModePairContentsExchangeProof,
    switchedAt: string,
  ): EnvironmentModePairReceipt;
  /**
   * Convert the fully proven recovery receipt back into the next reachable
   * prepared grant. The warm adapter calls this only after watcher resume.
   */
  completeTerminalTargetProof(): EnvironmentModePairReceipt;
  /** Restore recovery reachability if terminal receipt persistence later fails. */
  revertTerminalTargetProof(): EnvironmentModePairReceipt;
  release(): void;
}

/** Exact physical Contents roles relative to the durable pair receipt. */
export type EnvironmentModePairContentsRoleState = "as-recorded" | "swapped" | "ambiguous";

export interface EnvironmentModePairContentsRoleObservation {
  state: EnvironmentModePairContentsRoleState;
  live: EnvironmentModeCacheContentsIdentity;
  inactive: EnvironmentModeCacheContentsIdentity;
}

/**
 * Recovery holds the same cache mutex as a warm commit, but accepts a stranded
 * prepared or post-cutover receipt. Its mutations are limited to verified role
 * reconciliation, terminal pin restoration, and verified-official invalidation.
 */
export interface EnvironmentModePairRecoveryLease {
  readonly receipt: EnvironmentModePairReceipt;
  observeContentsRoles(): EnvironmentModePairContentsRoleObservation;
  /** Re-root receipt roles after a physical exchange proven by exact Contents inodes. */
  reconcileSwappedContents(switchedAt: string): EnvironmentModePairReceipt;
  /** Refresh directory metadata after an even number of proven exchanges. */
  reconcileRecordedContents(): EnvironmentModePairReceipt;
  /** Restore a post-cutover recovery pin only after a source or target is terminally proven. */
  completeTerminalRecovery(): EnvironmentModePairReceipt;
  /** A verified newer official desktop permanently releases this cache grant. */
  invalidateForVerifiedOfficialUpdate(invalidatedAt: string): EnvironmentModePairReceipt;
  release(): void;
}

export interface EnvironmentModeCachePin {
  state: EnvironmentModeCachePinState;
  /** The original pin time is retained as an audit record after release. */
  pinnedAt: string;
  /** Null exactly while the current prepared grant or recovery reachability is pinned. */
  releasedAt: string | null;
  releaseReason: "superseded" | "invalidated" | "cancelled" | "helper_failed" | "abandoned" | null;
}

export interface EnvironmentModeCacheSupersession {
  supersededAt: string | null;
  replacementGenerationId: string | null;
}

export interface EnvironmentModeCacheTimestamps {
  preparedAt: string;
  validatedAt: string;
  publishedAt: string | null;
  lastSuccessfulSwitchAt: string | null;
  lastPreCutoverCancellationAt: string | null;
  terminalAt: string | null;
}

/**
 * Every item here is observed again before a prepared grant is reused.  The
 * receipt digest is deliberately outside this snapshot because it is derived
 * from the complete durable receipt after the snapshot has been attached.
 */
export interface EnvironmentModeCacheInvalidationSnapshot {
  official: {
    version: string;
    build: string;
    trustDigest: string;
    signatureDigest: string;
    asarDigest: string;
    asarHeaderDigest: string;
    backendDigest: string;
    updaterDigest: string;
  };
  tweakers: {
    sourceDigest: string;
    buildDigest: string;
    patchPayloadDigest: string;
    runtimeDigest: string;
    managedRuntimeDigest: string;
    backendDigest: string;
    nativeHostDigest: string;
  };
  environment: {
    profileDigest: string;
    pathsDigest: string;
    contentsDevice: string;
    statSealDigest: string;
    mcpHelperDigest: string;
    lifecycleJournalDigest: string;
  };
}

export interface EnvironmentModeCacheInvalidationEvidence extends EnvironmentModeCacheInvalidationSnapshot {
  /** SHA-256 of the full receipt with this field normalized to an empty string. */
  receiptDigest: string;
}

export interface EnvironmentModePairReceipt {
  schemaVersion: typeof ENVIRONMENT_MODE_CACHE_SCHEMA_VERSION;
  kind: typeof ENVIRONMENT_MODE_CACHE_KIND;
  generationId: string;
  releaseProfile: ReleaseProfile;
  paths: EnvironmentModeCacheReceiptPaths;
  roles: EnvironmentModeCacheRoleState;
  tweakers: EnvironmentModeCacheTweakersProvenance;
  seals: EnvironmentModeCachePairSeals;
  invalidation: EnvironmentModeCacheInvalidationEvidence;
  timestamps: EnvironmentModeCacheTimestamps;
  pin: EnvironmentModeCachePin;
  supersession: EnvironmentModeCacheSupersession;
}

export interface EnvironmentModeCacheStateInput {
  current: EnvironmentModePairReceipt | null;
  nextGenerationId?: string | null;
  unavailable?: boolean;
}

/**
 * Read-only, schema-v2 presentation of the sealed pair cache.  This is
 * intentionally narrower than the durable receipt: it exposes the evidence
 * an operator needs to understand readiness without exposing any mutation,
 * validation, preparation, pinning, or recovery capability to status
 * consumers.
 */
export interface EnvironmentModeCacheStatus {
  schemaVersion: 2;
  state: EnvironmentModeCacheState;
  generationId: string | null;
  roles: {
    live: Pick<EnvironmentModeCacheRole, "role" | "experience" | "appPath">;
    inactive: Pick<EnvironmentModeCacheRole, "role" | "experience" | "appPath">;
  } | null;
  invalidationReasons: string[];
  preparation: {
    generationId: string | null;
    phase: "idle" | "reserved" | "receipt-published" | "unavailable";
  };
  pin: Pick<EnvironmentModeCachePin, "state" | "pinnedAt" | "releasedAt" | "releaseReason"> | null;
  supersession: EnvironmentModeCacheSupersession | null;
  timings: EnvironmentModeCacheTimestamps | null;
}

export interface EnvironmentModeCacheGcEligibility {
  generationId: string;
  eligible: boolean;
  reason: string;
}

export interface EnvironmentModeCacheSameDeviceDeps {
  stat?: (path: string) => { dev: number | bigint };
}

export interface PublishEnvironmentModePairOptions {
  /** Injectable clock keeps receipts deterministic in tests. */
  now?: () => string;
  /**
   * Test-only failure seam. It runs after an old generation has been marked
   * stale but before current.json is renamed, so rollback behavior remains
   * directly testable without introducing a runtime fault injector.
   */
  beforeCurrentPublish?: () => void;
}

export interface PrepareEnvironmentModePairCallbacks {
  /**
   * Performs candidate build/copy work only inside `preparation`.  It is
   * intentionally not given a live app, watcher, helper, or process handle.
   */
  stage: (input: { preparation: EnvironmentModeCachePreparationPaths }) => void | Promise<void>;
  /** Proves all bytes in the one reserved `next/<generation>` slot before rename. */
  validatePrepared: (input: { preparation: EnvironmentModeCachePreparationPaths }) => void | Promise<void>;
  /**
   * Runs the full validator again after the atomic next-to-generation rename,
   * then returns a complete final-path receipt.  No current state is changed
   * until this callback and materialization checks both succeed.
   */
  createValidatedReceipt: (input: {
    generation: EnvironmentModeCacheGenerationPaths;
  }) => EnvironmentModePairReceipt | Promise<EnvironmentModePairReceipt>;
}

export interface PrepareEnvironmentModePairOptions extends PublishEnvironmentModePairOptions {
  /** Fault-injection seam immediately before the isolated generation rename. */
  beforeGenerationPromotion?: () => void;
}

export interface EnvironmentModeCacheValidationCallbacks {
  /**
   * Full read-only validator. It is always called even after a stat-seal
   * mismatch, and must never quit or otherwise mutate the live app.
   */
  inspectInvalidation: (receipt: EnvironmentModePairReceipt) => EnvironmentModeCacheInvalidationSnapshot;
}

export interface EnvironmentModeCacheValidationResult {
  state: EnvironmentModeCacheValidationState;
  receipt: EnvironmentModePairReceipt | null;
  reasons: string[];
}

/**
 * The only preparation coordinator exposed by this module. It first proves a
 * published pair is still usable (including the full validator after a seal
 * mismatch), then either returns that exact immutable generation or stages a
 * new one. It has no switch, process, watcher, or confirmation capability.
 */
export interface PrepareOrReuseEnvironmentModePairCallbacks extends PrepareEnvironmentModePairCallbacks,
  EnvironmentModeCacheValidationCallbacks {}

export interface PrepareOrReuseEnvironmentModePairResult {
  state: "cache_hit" | "prepared";
  receipt: EnvironmentModePairReceipt;
  /** Present only when a prior valid generation was terminally invalidated. */
  previousValidation: EnvironmentModeCacheValidationResult | null;
}

/** Build the canonical cache layout below a known installer root. */
export function environmentModeCachePaths(environmentRoot: string): EnvironmentModeCachePaths {
  const cacheRoot = canonicalAbsolute(join(canonicalPhysicalPath(environmentRoot, "environment root"), "environment-cache"));
  return {
    cacheRoot,
    currentFile: join(cacheRoot, "current.json"),
    generationsRoot: join(cacheRoot, "generations"),
    preparationRoot: join(cacheRoot, "next"),
    nextRoot: join(cacheRoot, "next"),
    lockFile: join(cacheRoot, "environment-mode-cache.lock"),
  };
}

export function environmentModeCacheGenerationPaths(
  paths: EnvironmentModeCachePaths,
  generationId: string,
): EnvironmentModeCacheGenerationPaths {
  assertEnvironmentModeCachePaths(paths);
  assertSafeEnvironmentModeCacheGenerationId(generationId);
  const generationRoot = join(paths.generationsRoot, generationId);
  return {
    generationId,
    generationRoot,
    receiptFile: join(generationRoot, "receipt.json"),
    inactiveRoot: join(generationRoot, "inactive"),
    inactiveAppPath: join(generationRoot, "inactive", "ChatGPT.app"),
    runtimeRoot: join(generationRoot, "runtime"),
    managedRuntimeRoot: join(generationRoot, "managed-runtime"),
  };
}

/** The single preparation slot has the same sealed shape as a published generation. */
export function environmentModeCachePreparationPaths(
  paths: EnvironmentModeCachePaths,
  generationId: string,
): EnvironmentModeCachePreparationPaths {
  assertEnvironmentModeCachePaths(paths);
  assertSafeEnvironmentModeCacheGenerationId(generationId);
  const generationRoot = join(paths.preparationRoot, generationId);
  return {
    generationId,
    preparationRoot: paths.preparationRoot,
    generationRoot,
    receiptFile: join(generationRoot, "receipt.json"),
    inactiveRoot: join(generationRoot, "inactive"),
    inactiveAppPath: join(generationRoot, "inactive", "ChatGPT.app"),
    runtimeRoot: join(generationRoot, "runtime"),
    managedRuntimeRoot: join(generationRoot, "managed-runtime"),
  };
}

export function assertSafeEnvironmentModeCacheGenerationId(generationId: string): void {
  if (!SAFE_GENERATION_ID.test(generationId)) {
    throw new Error(`Environment mode cache generation ID is unsafe: ${generationId}`);
  }
}

/** Reject escaped or hand-assembled cache layouts before they can be published. */
export function assertEnvironmentModeCachePaths(paths: EnvironmentModeCachePaths): void {
  const cacheRoot = assertCanonicalAbsolutePath(paths.cacheRoot, "environment mode cache root");
  const expected: EnvironmentModeCachePaths = {
    cacheRoot,
    currentFile: join(cacheRoot, "current.json"),
    generationsRoot: join(cacheRoot, "generations"),
    preparationRoot: join(cacheRoot, "next"),
    nextRoot: join(cacheRoot, "next"),
    lockFile: join(cacheRoot, "environment-mode-cache.lock"),
  };
  for (const key of Object.keys(expected) as Array<keyof EnvironmentModeCachePaths>) {
    if (paths[key] !== expected[key]) {
      throw new Error(`Environment mode cache ${key} must use its canonical path`);
    }
  }
}

/**
 * Ensures the cache root and every existing parent in its path are real
 * directories. This rejects a symlinked cache root before an atomic rename
 * can be redirected outside installer ownership.
 */
export function assertEnvironmentModeCacheRootIsReal(paths: EnvironmentModeCachePaths): void {
  assertEnvironmentModeCachePaths(paths);
  assertNoSymlinkInExistingPath(paths.cacheRoot, "environment mode cache root");
  if (existsSync(paths.cacheRoot)) assertRealDirectory(paths.cacheRoot, "environment mode cache root");
}

/** Creates only the cache metadata roots. It never removes generation bytes. */
export function ensureEnvironmentModeCacheRoots(paths: EnvironmentModeCachePaths): void {
  assertEnvironmentModeCachePaths(paths);
  assertNoSymlinkInExistingPath(paths.cacheRoot, "environment mode cache root");
  mkdirSync(paths.cacheRoot, { recursive: true, mode: 0o700 });
  assertRealDirectory(paths.cacheRoot, "environment mode cache root");
  mkdirSync(paths.generationsRoot, { recursive: true, mode: 0o700 });
  assertRealDirectory(paths.generationsRoot, "environment mode cache generations root");
}

/**
 * The preparation root is a single reservation. Existing material is never
 * replaced here; callers must choose a new root or explicitly resolve the old
 * lifecycle first.
 */
export function assertAtMostOneEnvironmentModeCachePreparation(
  paths: EnvironmentModeCachePaths,
): string | null {
  assertEnvironmentModeCacheRootIsReal(paths);
  if (!existsSync(paths.preparationRoot)) return null;
  assertRealDirectory(paths.preparationRoot, "environment mode cache preparation root");
  const entries = readdirSync(paths.preparationRoot, { withFileTypes: true });
  if (entries.length === 0) return null;
  if (entries.length !== 1) {
    throw new Error("Environment mode cache permits at most one next generation");
  }
  const entry = entries[0]!;
  assertSafeEnvironmentModeCacheGenerationId(entry.name);
  const entryPath = join(paths.preparationRoot, entry.name);
  if (!entry.isDirectory() || entry.isSymbolicLink() || lstatSync(entryPath).isSymbolicLink()) {
    throw new Error("Environment mode cache next generation must be a real directory");
  }
  return entry.name;
}

/** Seal a complete tree without following symlinks. */
export function sealEnvironmentModeCacheTree(rootPath: string): EnvironmentModeCacheTreeStatSeal {
  const root = assertCanonicalAbsolutePath(rootPath, "environment mode cache tree root");
  assertRealDirectory(root, "environment mode cache tree root");
  const records: EnvironmentModeCacheStatSealRecord[] = [];
  const contentEntries: EnvironmentModeCacheContentSealRecord[] = [];
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path, { bigint: true });
    const type: EnvironmentModeCacheEntryType = stat.isDirectory() && !stat.isSymbolicLink()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : unsupportedSealEntry(path);
    const record: EnvironmentModeCacheStatSealRecord = {
      relativePath,
      type,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mode: stat.mode.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      symlinkTarget: type === "symlink" ? readlinkSync(path) : null,
    };
    records.push(record);
    contentEntries.push({
      relativePath,
      type,
      mode: record.mode,
      payloadDigest: environmentModeCachePayloadDigest(path, record),
    });
    if (type !== "directory") return;
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => comparePathNames(left.name, right.name));
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      visit(childPath, relativePath === "" ? entry.name : `${relativePath}/${entry.name}`);
    }
  };
  visit(root, "");
  return {
    rootPath: root,
    entries: records,
    contentEntries,
    sealDigest: environmentModeCacheSealDigest(records),
    contentDigest: environmentModeCacheContentTreeDigest(contentEntries),
  };
}

/** Collect only tree topology and lstat metadata; never open a payload file. */
function collectEnvironmentModeCacheTreeStatSeal(rootPath: string): Pick<EnvironmentModeCacheTreeStatSeal, "entries" | "sealDigest"> {
  const root = assertCanonicalAbsolutePath(rootPath, "environment mode cache tree root");
  assertRealDirectory(root, "environment mode cache tree root");
  const entries: EnvironmentModeCacheStatSealRecord[] = [];
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path, { bigint: true });
    const type: EnvironmentModeCacheEntryType = stat.isDirectory() && !stat.isSymbolicLink()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : unsupportedSealEntry(path);
    entries.push(environmentModeCacheStatSealRecord(path, relativePath, type, stat));
    if (type !== "directory") return;
    const children = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => comparePathNames(left.name, right.name));
    for (const child of children) {
      const childPath = join(path, child.name);
      visit(childPath, relativePath === "" ? child.name : `${relativePath}/${child.name}`);
    }
  };
  visit(root, "");
  return { entries, sealDigest: environmentModeCacheSealDigest(entries) };
}

function environmentModeCacheStatSealRecord(
  path: string,
  relativePath: string,
  type: EnvironmentModeCacheEntryType,
  stat: {
    dev: number | bigint;
    ino: number | bigint;
    size: number | bigint;
    mode: number | bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
): EnvironmentModeCacheStatSealRecord {
  return {
    relativePath,
    type,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    symlinkTarget: type === "symlink" ? readlinkSync(path) : null,
  };
}

/** Verify every stat field, including ctime, so a same-size restored-mtime edit is not accepted. */
export function assertEnvironmentModeCacheTreeSeal(
  rootPath: string,
  expected: EnvironmentModeCacheTreeStatSeal,
): void {
  if (!isEnvironmentModeCacheTreeStatSeal(expected)) {
    throw new Error("Environment mode cache tree seal is invalid");
  }
  const root = assertCanonicalAbsolutePath(rootPath, "environment mode cache tree root");
  if (expected.rootPath !== root) {
    throw new Error("Environment mode cache tree seal root does not match its expected canonical path");
  }
  const actual = sealEnvironmentModeCacheTree(root);
  if (actual.contentDigest !== expected.contentDigest
    || actual.sealDigest !== expected.sealDigest
    || !sameJson(actual.entries, expected.entries)
    || !sameJson(actual.contentEntries, expected.contentEntries)) {
    throw new Error(`Environment mode cache tree stat seal mismatch at ${root}`);
  }
}

/**
 * Re-read the complete directory topology and every stat tuple without reading
 * file bytes or calculating a content hash. This is the only tree-level check
 * permitted on the post-approval warm path; the prepared `contentDigest`
 * remains the already-bound preparation evidence.
 */
export function assertEnvironmentModeCacheTreeStatSealOnly(
  rootPath: string,
  expected: EnvironmentModeCacheTreeStatSeal,
): void {
  if (!isEnvironmentModeCacheTreeStatSeal(expected)) {
    throw new Error("Environment mode cache tree seal is invalid");
  }
  const root = assertCanonicalAbsolutePath(rootPath, "environment mode cache tree root");
  if (expected.rootPath !== root) {
    throw new Error("Environment mode cache tree seal root does not match its expected canonical path");
  }
  const actual = collectEnvironmentModeCacheTreeStatSeal(root);
  if (actual.sealDigest !== expected.sealDigest || !sameJson(actual.entries, expected.entries)) {
    throw new Error(`Environment mode cache tree stat seal mismatch at ${root}`);
  }
}

/**
 * Verify the LIVE role's app tree. The live bundle is not cache-resident:
 * macOS legitimately rewrites ctime across it on first launch (Gatekeeper
 * provenance xattrs) and Sparkle activity touches it, so pinning the full
 * stat tuple turned successful cutovers into failed transactions (live
 * failure 2026-08-20: "stat seal mismatch at /Applications/ChatGPT.app"
 * seconds after a clean cutover). Ordered topology, entry type, mode, size,
 * and symlink targets stay pinned; dev/ino/mtime/ctime do not. With
 * `verifyContent` (the full-validator context, where the strict seal also
 * read bytes) the stat-independent payload digests are verified too, so a
 * same-size content edit is still rejected there. The warm path stays
 * byte-free by doctrine; its residual same-size-edit exposure on the live
 * tree is closed by the full validator before cutover and by the role
 * identity digests.
 */
export function assertEnvironmentModeCacheLiveTreeSeal(
  rootPath: string,
  expected: EnvironmentModeCacheTreeStatSeal,
  options: { verifyContent?: boolean } = {},
): void {
  if (!isEnvironmentModeCacheTreeStatSeal(expected)) {
    throw new Error("Environment mode cache tree seal is invalid");
  }
  const root = assertCanonicalAbsolutePath(rootPath, "environment mode cache tree root");
  if (expected.rootPath !== root) {
    throw new Error("Environment mode cache tree seal root does not match its expected canonical path");
  }
  const shape = (entries: EnvironmentModeCacheStatSealRecord[]) => entries.map((entry) => ({
    relativePath: entry.relativePath,
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    symlinkTarget: entry.symlinkTarget,
  }));
  if (options.verifyContent === true) {
    const actual = sealEnvironmentModeCacheTree(root);
    if (!sameJson(shape(actual.entries), shape(expected.entries))
      || actual.contentDigest !== expected.contentDigest
      || !sameJson(actual.contentEntries, expected.contentEntries)) {
      throw new Error(`Environment mode cache live tree seal mismatch at ${root}`);
    }
    return;
  }
  const actual = collectEnvironmentModeCacheTreeStatSeal(root);
  if (!sameJson(shape(actual.entries), shape(expected.entries))) {
    throw new Error(`Environment mode cache live tree seal mismatch at ${root}`);
  }
}

/**
 * Verify a prepared directory after one same-filesystem rename. APFS preserves
 * the directory and descendant inodes, but legitimately advances the moved
 * root directory's ctime. No descendant stat field may change.
 */
export function assertEnvironmentModeCacheTreeStatSealAfterRename(
  rootPath: string,
  expected: EnvironmentModeCacheTreeStatSeal,
): void {
  if (!isEnvironmentModeCacheTreeStatSeal(expected)) {
    throw new Error("Environment mode cache tree seal is invalid");
  }
  const root = assertCanonicalAbsolutePath(rootPath, "environment mode cache tree root");
  const actual = collectEnvironmentModeCacheTreeStatSeal(root);
  if (actual.entries.length !== expected.entries.length) {
    throw new Error(`Environment mode cache tree stat seal mismatch at ${root}`);
  }
  const rebound = expected.entries.map((entry, index) => index === 0
    ? { ...entry, ctimeNs: actual.entries[0]!.ctimeNs }
    : entry);
  if (!sameJson(actual.entries, rebound)) {
    throw new Error(`Environment mode cache tree stat seal mismatch at ${root}`);
  }
}

export function isEnvironmentModeCacheTreeStatSeal(value: unknown): value is EnvironmentModeCacheTreeStatSeal {
  if (!isRecord(value)
    || !isCanonicalAbsolutePath(value.rootPath)
    || !Array.isArray(value.entries)
    || !Array.isArray(value.contentEntries)
    || !isSha256(value.sealDigest)
    || !isSha256(value.contentDigest)
    || value.entries.length === 0) {
    return false;
  }
  const entries = value.entries;
  const contentEntries = value.contentEntries;
  if (!entries.every(isEnvironmentModeCacheStatSealRecord)
    || !contentEntries.every(isEnvironmentModeCacheContentSealRecord)
    || contentEntries.length !== entries.length) return false;
  if (entries[0]!.relativePath !== "" || entries[0]!.type !== "directory") return false;
  const paths = new Set<string>([""]);
  const directories = new Set<string>([""]);
  const lastChildByDirectory = new Map<string, string>();
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (paths.has(entry.relativePath)) return false;
    paths.add(entry.relativePath);
    const separator = entry.relativePath.lastIndexOf("/");
    const parent = separator < 0 ? "" : entry.relativePath.slice(0, separator);
    const child = separator < 0 ? entry.relativePath : entry.relativePath.slice(separator + 1);
    if (!directories.has(parent)) return false;
    const previousSibling = lastChildByDirectory.get(parent);
    if (previousSibling !== undefined && comparePathNames(previousSibling, child) >= 0) return false;
    lastChildByDirectory.set(parent, child);
    if (entry.type === "directory") directories.add(entry.relativePath);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const stat = entries[index]!;
    const content = contentEntries[index]!;
    if (content.relativePath !== stat.relativePath
      || content.type !== stat.type
      || content.mode !== stat.mode
      || (content.type === "directory" && content.payloadDigest !== EMPTY_CONTENT_PAYLOAD_DIGEST)
      || (content.type === "symlink"
        && content.payloadDigest !== digestEnvironmentModeCachePayload(stat.symlinkTarget ?? ""))) {
      return false;
    }
  }
  return environmentModeCacheSealDigest(entries) === value.sealDigest
    && environmentModeCacheContentTreeDigest(contentEntries) === value.contentDigest;
}

export function isEnvironmentModeCacheStatSealRecord(value: unknown): value is EnvironmentModeCacheStatSealRecord {
  if (!isRecord(value)
    || !isSafeSealRelativePath(value.relativePath)
    || (value.type !== "directory" && value.type !== "file" && value.type !== "symlink")
    || !isDecimalString(value.dev)
    || !isDecimalString(value.ino)
    || !isDecimalString(value.size)
    || !isDecimalString(value.mode)
    || !isDecimalString(value.mtimeNs)
    || !isDecimalString(value.ctimeNs)) {
    return false;
  }
  return value.type === "symlink"
    ? typeof value.symlinkTarget === "string"
    : value.symlinkTarget === null;
}

export function isEnvironmentModeCacheContentSealRecord(value: unknown): value is EnvironmentModeCacheContentSealRecord {
  return isRecord(value)
    && isSafeSealRelativePath(value.relativePath)
    && (value.type === "directory" || value.type === "file" || value.type === "symlink")
    && isDecimalString(value.mode)
    && isSha256(value.payloadDigest);
}

function isEnvironmentModeCacheContentsIdentity(value: unknown): value is EnvironmentModeCacheContentsIdentity {
  return isRecord(value)
    && isCanonicalAbsolutePath(value.path)
    && isDecimalString(value.dev)
    && isDecimalString(value.ino);
}

function isEnvironmentModeCacheOuterAppEvidence(value: unknown): value is EnvironmentModeCacheOuterAppEvidence {
  return isRecord(value)
    && isCanonicalAbsolutePath(value.path)
    && isEnvironmentModeCacheStatSealRecord(value.stat)
    && isDecimalString(value.uid)
    && isDecimalString(value.gid)
    && isSha256(value.aclDigest)
    && isSha256(value.xattrDigest)
    && isSha256(value.quarantineDigest);
}

function isEnvironmentModePairContentsExchangeProof(value: unknown): value is EnvironmentModePairContentsExchangeProof {
  return isRecord(value)
    && isEnvironmentModeCacheContentsIdentity(value.liveContentsBefore)
    && isEnvironmentModeCacheContentsIdentity(value.inactiveContentsBefore)
    && isEnvironmentModeCacheContentsIdentity(value.liveContentsAfter)
    && isEnvironmentModeCacheContentsIdentity(value.inactiveContentsAfter)
    && isEnvironmentModeCacheOuterAppEvidence(value.liveOuterBefore)
    && isEnvironmentModeCacheOuterAppEvidence(value.inactiveOuterBefore)
    && isEnvironmentModeCacheOuterAppEvidence(value.liveOuterAfter)
    && isEnvironmentModeCacheOuterAppEvidence(value.inactiveOuterAfter);
}

/**
 * Strictly validate a receipt as portable JSON. Supplying canonical paths also
 * binds all cache-owned locations to that exact cache instance.
 */
export function isEnvironmentModePairReceipt(
  value: unknown,
  paths?: EnvironmentModeCachePaths,
): value is EnvironmentModePairReceipt {
  try {
    assertEnvironmentModePairReceipt(value, paths);
    return true;
  } catch {
    return false;
  }
}

export function assertEnvironmentModePairReceipt(
  value: unknown,
  paths?: EnvironmentModeCachePaths,
): asserts value is EnvironmentModePairReceipt {
  if (!isRecord(value)
    || value.schemaVersion !== ENVIRONMENT_MODE_CACHE_SCHEMA_VERSION
    || value.kind !== ENVIRONMENT_MODE_CACHE_KIND
    || typeof value.generationId !== "string"
    || (value.releaseProfile !== "stable" && value.releaseProfile !== "alpha")
    || !isRecord(value.paths)
    || !isEnvironmentModeCacheRoleState(value.roles)
    || !isEnvironmentModeCacheTweakersProvenance(value.tweakers)
    || !isEnvironmentModeCachePairSeals(value.seals)
    || !isEnvironmentModeCacheInvalidationEvidence(value.invalidation)
    || !isEnvironmentModeCacheTimestamps(value.timestamps)
    || !isEnvironmentModeCachePin(value.pin)
    || !isEnvironmentModeCacheSupersession(value.supersession)) {
    throw new Error("Environment mode pair receipt has an invalid schema");
  }
  assertSafeEnvironmentModeCacheGenerationId(value.generationId);
  assertReceiptPathShape(value.paths as unknown as EnvironmentModeCacheReceiptPaths);
  const expectedBundle = value.releaseProfile === "stable" ? "com.openai.codex" : "com.openai.codex.beta";
  const roles = value.roles as EnvironmentModeCacheRoleState;
  if (roles.live.role !== "live" || roles.inactive.role !== "inactive"
    || roles.live.experience === roles.inactive.experience
    || roles.live.evidence.bundleId !== expectedBundle
    || roles.inactive.evidence.bundleId !== expectedBundle) {
    throw new Error("Environment mode pair receipt role state is invalid for its release profile");
  }
  assertEnvironmentModeCacheChatgptRoleTrust(roles.live);
  assertEnvironmentModeCacheChatgptRoleTrust(roles.inactive);
  const receiptPaths = value.paths as unknown as EnvironmentModeCacheReceiptPaths;
  const seals = value.seals as unknown as EnvironmentModeCachePairSeals;
  if (roles.live.appPath !== value.seals.liveApp.rootPath
    || roles.inactive.appPath !== receiptPaths.inactiveAppPath
    || roles.inactive.appPath !== value.seals.inactiveApp.rootPath
    || receiptPaths.runtimeRoot !== value.seals.runtime.rootPath
    || receiptPaths.managedRuntimeRoot !== value.seals.managedRuntime.rootPath) {
    throw new Error("Environment mode pair receipt seal roots do not match its roles and artifact paths");
  }
  const provenance = value.tweakers as unknown as EnvironmentModeCacheTweakersProvenance;
  if (provenance.runtime.rootPath !== receiptPaths.runtimeRoot
    || provenance.managedRuntime.rootPath !== receiptPaths.managedRuntimeRoot) {
    throw new Error("Environment mode pair receipt runtime provenance is not bound to its canonical roots");
  }
  assertRoleEvidencePath(roles.live);
  assertRoleEvidencePath(roles.inactive);
  if (paths) {
    assertEnvironmentModeCachePaths(paths);
    const expected = environmentModeCacheGenerationPaths(paths, value.generationId);
    const required: EnvironmentModeCacheReceiptPaths = {
      cacheRoot: paths.cacheRoot,
      currentFile: paths.currentFile,
      generationRoot: expected.generationRoot,
      receiptFile: expected.receiptFile,
      inactiveAppPath: expected.inactiveAppPath,
      runtimeRoot: expected.runtimeRoot,
      managedRuntimeRoot: expected.managedRuntimeRoot,
    };
    for (const key of Object.keys(required) as Array<keyof EnvironmentModeCacheReceiptPaths>) {
      if (receiptPaths[key] !== required[key]) {
        throw new Error(`Environment mode pair receipt ${key} is not the canonical generation path`);
      }
    }
  } else {
    assertContainedPath(receiptPaths.cacheRoot, receiptPaths.generationRoot, "generation root");
    assertContainedPath(receiptPaths.generationRoot, receiptPaths.receiptFile, "generation receipt");
    assertContainedPath(receiptPaths.generationRoot, receiptPaths.inactiveAppPath, "inactive app");
    assertContainedPath(receiptPaths.generationRoot, receiptPaths.runtimeRoot, "runtime root");
    assertContainedPath(receiptPaths.generationRoot, receiptPaths.managedRuntimeRoot, "managed runtime root");
  }
  assertPinLifecycle(value.pin as EnvironmentModeCachePin, value.supersession as EnvironmentModeCacheSupersession);
  if ((value.invalidation as EnvironmentModeCacheInvalidationEvidence).environment.statSealDigest
    !== environmentModePairStatSealDigest(seals)) {
    throw new Error("Environment mode pair receipt stat seal digest does not match its canonical pair seals");
  }
  if ((value.invalidation as EnvironmentModeCacheInvalidationEvidence).receiptDigest
    !== environmentModePairReceiptDigest(value as unknown as EnvironmentModePairReceipt)) {
    throw new Error("Environment mode pair receipt digest does not match its durable contents");
  }
}

/**
 * Canonical receipt digest used to bind cache metadata to its observed
 * invalidation inputs.  The self-referential field is normalized before
 * hashing, so a caller can safely finalize a fresh receipt in one step.
 */
export function environmentModePairReceiptDigest(receipt: EnvironmentModePairReceipt): string {
  const normalized = {
    ...receipt,
    invalidation: { ...receipt.invalidation, receiptDigest: "" },
  };
  return createHash("sha256").update(JSON.stringify(sortCanonicalValue(normalized))).digest("hex");
}

/**
 * Bind invalidation to the four exact role/artifact stat seals. The role names
 * are part of the canonical serialization, so a post-swap rotated live seal
 * cannot be mistaken for its inactive predecessor.
 */
export function environmentModePairStatSealDigest(seals: EnvironmentModeCachePairSeals): string {
  if (!isEnvironmentModeCachePairSeals(seals)) {
    throw new Error("Environment mode pair stat seal digest requires valid canonical pair seals");
  }
  const canonical = {
    liveApp: { rootPath: seals.liveApp.rootPath, sealDigest: seals.liveApp.sealDigest },
    inactiveApp: { rootPath: seals.inactiveApp.rootPath, sealDigest: seals.inactiveApp.sealDigest },
    runtime: { rootPath: seals.runtime.rootPath, sealDigest: seals.runtime.sealDigest },
    managedRuntime: { rootPath: seals.managedRuntime.rootPath, sealDigest: seals.managedRuntime.sealDigest },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Attach deterministic derived invalidation and receipt digests, then reject an incomplete pair. */
export function finalizeEnvironmentModePairReceipt(receipt: EnvironmentModePairReceipt): EnvironmentModePairReceipt {
  const withDerivedStatSeal: EnvironmentModePairReceipt = {
    ...receipt,
    invalidation: {
      ...receipt.invalidation,
      environment: {
        ...receipt.invalidation.environment,
        statSealDigest: environmentModePairStatSealDigest(receipt.seals),
      },
    },
  };
  const finalized: EnvironmentModePairReceipt = {
    ...withDerivedStatSeal,
    invalidation: {
      ...withDerivedStatSeal.invalidation,
      receiptDigest: environmentModePairReceiptDigest(withDerivedStatSeal),
    },
  };
  assertEnvironmentModePairReceipt(finalized);
  return finalized;
}

/** Read only a fully valid current role-state publication. */
export function readCurrentEnvironmentModePair(
  paths: EnvironmentModeCachePaths,
): EnvironmentModePairReceipt | null {
  assertEnvironmentModeCacheRootIsReal(paths);
  if (!existsSync(paths.currentFile)) return null;
  assertRegularFile(paths.currentFile, "environment mode cache current receipt");
  const value = readJson(paths.currentFile, "environment mode cache current receipt");
  assertEnvironmentModePairReceipt(value, paths);
  return value;
}

/** Read a durable generation receipt without treating it as current. */
export function readEnvironmentModePairGeneration(
  paths: EnvironmentModeCachePaths,
  generationId: string,
): EnvironmentModePairReceipt | null {
  const generation = environmentModeCacheGenerationPaths(paths, generationId);
  assertEnvironmentModeCacheRootIsReal(paths);
  if (!existsSync(generation.receiptFile)) return null;
  assertRegularFile(generation.receiptFile, "environment mode cache generation receipt");
  const value = readJson(generation.receiptFile, "environment mode cache generation receipt");
  assertEnvironmentModePairReceipt(value, paths);
  if (value.generationId !== generationId) {
    throw new Error("Environment mode cache generation receipt identity does not match its directory");
  }
  return value;
}

/**
 * Repair the generation-local receipt shadow from `current.json`, which is
 * the sole role-state authority. A process can die after a generation receipt
 * rename/fsync but before the matching current-pointer rename/fsync; readers
 * must never infer a new role from that shadow. This explicit mutator keeps
 * polling/status reads pure while every publication and lease owner can
 * recover deterministically under the cache mutex.
 */
export function reconcileCurrentEnvironmentModePairReceiptShadow(
  paths: EnvironmentModeCachePaths,
): EnvironmentModePairReceipt | null {
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    return reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
  } finally {
    lock.release();
  }
}

function reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(
  paths: EnvironmentModeCachePaths,
): EnvironmentModePairReceipt | null {
  const current = readCurrentEnvironmentModePair(paths);
  if (current === null) return null;
  let shadow: EnvironmentModePairReceipt | null = null;
  try {
    shadow = readEnvironmentModePairGeneration(paths, current.generationId);
  } catch {
    // A valid current pointer remains authoritative even when the local shadow
    // was torn or malformed. `writeEnvironmentModePairGeneration` repeats all
    // path/no-symlink checks before replacing it.
    shadow = null;
  }
  if (shadow !== null && sameJson(shadow, current)) return current;
  writeEnvironmentModePairGeneration(paths, current);
  const repaired = readEnvironmentModePairGeneration(paths, current.generationId);
  if (repaired === null || !sameJson(repaired, current)) {
    throw new Error("Environment mode cache current receipt shadow could not be reconciled");
  }
  return current;
}

/**
 * Claim the one current prepared pair for an approved warm cutover. The caller
 * must hold this lease from its bounded preflight through terminal receipt
 * persistence so preparation cannot replace or invalidate the pair mid-swap.
 */
export function acquireCurrentEnvironmentModePairWarmCommitLease(
  paths: EnvironmentModeCachePaths,
): EnvironmentModePairWarmCommitLease {
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    const receipt = readCurrentEnvironmentModePair(paths);
    if (receipt === null
      || environmentModeCacheReachability(receipt, receipt.generationId) !== "prepared_grant") {
      throw new Error("Environment mode cache has no current reachable prepared pair for warm commit");
    }
    let heldReceipt = receipt;
    let exchanged = false;
    let terminalTargetPrepared = false;
    return {
      get receipt() {
        return heldReceipt;
      },
      invalidateBeforeCutover(invalidatedAt) {
        if (exchanged || terminalTargetPrepared) {
          throw new Error("Environment mode cache cannot invalidate a grant after cutover");
        }
        const current = readCurrentEnvironmentModePair(paths);
        if (current === null
          || current.generationId !== heldReceipt.generationId
          || current.invalidation.receiptDigest !== heldReceipt.invalidation.receiptDigest
          || current.pin.state !== "prepared") {
          throw new Error("Environment mode cache current prepared pair changed before invalidation");
        }
        const next = invalidateEnvironmentModePair(current, invalidatedAt);
        persistEnvironmentModePairWarmCommitInvalidation(paths, current, next);
        heldReceipt = next;
        return next;
      },
      completeContentsExchange(proof, switchedAt) {
        if (exchanged) throw new Error("Environment mode cache warm commit lease has already recorded an exchange");
        const current = readCurrentEnvironmentModePair(paths);
        if (current === null
          || current.generationId !== heldReceipt.generationId
          || current.invalidation.receiptDigest !== heldReceipt.invalidation.receiptDigest
          || environmentModeCacheReachability(current, current.generationId) !== "prepared_grant") {
          throw new Error("Environment mode cache current prepared pair changed during warm commit");
        }
        const next = rotateEnvironmentModePairAfterContentsExchange(current, proof, switchedAt);
        persistEnvironmentModePairWarmCommitRotation(paths, current, next);
        heldReceipt = next;
        exchanged = true;
        return next;
      },
      completeTerminalTargetProof() {
        if (!exchanged || terminalTargetPrepared) {
          throw new Error("Environment mode cache terminal target proof is unavailable before one recorded exchange");
        }
        const current = readCurrentEnvironmentModePair(paths);
        if (current === null
          || current.generationId !== heldReceipt.generationId
          || current.invalidation.receiptDigest !== heldReceipt.invalidation.receiptDigest
          || current.pin.state !== "post_cutover_recovery") {
          throw new Error("Environment mode cache post-cutover recovery receipt changed before terminal target proof");
        }
        const next = markEnvironmentModePairTerminalTargetPrepared(current);
        persistEnvironmentModePairWarmCommitTerminalTargetTransition(paths, current, next, "post_cutover_recovery", "prepared");
        heldReceipt = next;
        terminalTargetPrepared = true;
        return next;
      },
      revertTerminalTargetProof() {
        if (!terminalTargetPrepared) {
          throw new Error("Environment mode cache has no terminal target transition to revert");
        }
        const current = readCurrentEnvironmentModePair(paths);
        if (current === null
          || current.generationId !== heldReceipt.generationId
          || current.invalidation.receiptDigest !== heldReceipt.invalidation.receiptDigest
          || current.pin.state !== "prepared") {
          throw new Error("Environment mode cache terminal target receipt changed before recovery reversion");
        }
        const next = markEnvironmentModePairPostCutoverRecovery(current);
        persistEnvironmentModePairWarmCommitTerminalTargetTransition(paths, current, next, "prepared", "post_cutover_recovery");
        heldReceipt = next;
        terminalTargetPrepared = false;
        return next;
      },
      release() {
        lock.release();
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Claim the current generation for T5 recovery. Unlike a warm-commit lease,
 * this deliberately accepts either a still-prepared pair or the durable
 * post-cutover recovery state, but it never adopts a different generation.
 */
export function acquireCurrentEnvironmentModePairRecoveryLease(
  paths: EnvironmentModeCachePaths,
  expectedGenerationId: string,
): EnvironmentModePairRecoveryLease {
  assertSafeEnvironmentModeCacheGenerationId(expectedGenerationId);
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    const receipt = readCurrentEnvironmentModePair(paths);
    if (receipt === null || receipt.generationId !== expectedGenerationId) {
      throw new Error("Environment mode cache recovery journal does not match the current generation");
    }
    let heldReceipt = receipt;
    const assertCurrent = (): EnvironmentModePairReceipt => {
      const current = readCurrentEnvironmentModePair(paths);
      if (current === null
        || current.generationId !== heldReceipt.generationId
        || current.invalidation.receiptDigest !== heldReceipt.invalidation.receiptDigest) {
        throw new Error("Environment mode cache receipt changed during recovery");
      }
      return current;
    };
    const persist = (next: EnvironmentModePairReceipt): EnvironmentModePairReceipt => {
      const current = assertCurrent();
      persistEnvironmentModePairRecoveryTransition(paths, current, next);
      heldReceipt = next;
      return next;
    };
    return {
      get receipt() {
        return heldReceipt;
      },
      observeContentsRoles() {
        return classifyEnvironmentModePairContentsRoles(heldReceipt);
      },
      reconcileSwappedContents(switchedAt) {
        const current = assertCurrent();
        return persist(reconcileEnvironmentModePairSwappedContents(current, switchedAt));
      },
      reconcileRecordedContents() {
        const current = assertCurrent();
        return persist(reconcileEnvironmentModePairRecordedContents(current));
      },
      completeTerminalRecovery() {
        const current = assertCurrent();
        if (current.pin.state === "prepared") return current;
        if (current.pin.state !== "post_cutover_recovery") {
          throw new Error("Environment mode cache recovery cannot terminally restore a released pair");
        }
        return persist(markEnvironmentModePairTerminalTargetPrepared(current));
      },
      invalidateForVerifiedOfficialUpdate(invalidatedAt) {
        const current = assertCurrent();
        return persist(invalidateEnvironmentModePairForVerifiedOfficialUpdate(current, invalidatedAt));
      },
      release() {
        lock.release();
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Re-root the role evidence after a proven Contents exchange. This function
 * moves only metadata: it rotates existing prepared content digests and stat
 * records, replacing each outer app root record with the post-exchange stat
 * evidence. It never hashes or copies a payload.
 */
export function rotateEnvironmentModePairAfterContentsExchange(
  receipt: EnvironmentModePairReceipt,
  proof: EnvironmentModePairContentsExchangeProof,
  switchedAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(switchedAt, "environment mode cache warm commit time");
  if (receipt.pin.state !== "prepared" || receipt.pin.releasedAt !== null) {
    throw new Error("Only a current prepared environment mode pair may rotate roles after an exchange");
  }
  assertEnvironmentModePairContentsExchangeProof(receipt, proof);
  return rotateEnvironmentModePairRolesAfterContentsExchange(
    receipt,
    proof.liveOuterAfter.stat,
    proof.inactiveOuterAfter.stat,
    switchedAt,
  );
}

/**
 * Classify physical Contents inodes against the durable role receipt. This is
 * intentionally narrower than a payload validator: it is the recovery oracle
 * for whether a native exchange may already have happened.
 */
export function classifyEnvironmentModePairContentsRoles(
  receipt: EnvironmentModePairReceipt,
): EnvironmentModePairContentsRoleObservation {
  assertEnvironmentModePairReceipt(receipt);
  const livePath = join(receipt.roles.live.appPath, "Contents");
  const inactivePath = join(receipt.paths.inactiveAppPath, "Contents");
  const live = readEnvironmentModeCacheContentsIdentity(livePath);
  const inactive = readEnvironmentModeCacheContentsIdentity(inactivePath);
  const expectedLive = environmentModeCacheSealEntry(receipt.seals.liveApp, "Contents");
  const expectedInactive = environmentModeCacheSealEntry(receipt.seals.inactiveApp, "Contents");
  if (expectedLive === null || expectedInactive === null
    || expectedLive.type !== "directory" || expectedInactive.type !== "directory") {
    throw new Error("Environment mode cache pair lacks sealed Contents directories");
  }
  const recorded = live.dev === expectedLive.dev
    && live.ino === expectedLive.ino
    && inactive.dev === expectedInactive.dev
    && inactive.ino === expectedInactive.ino;
  const swapped = live.dev === expectedInactive.dev
    && live.ino === expectedInactive.ino
    && inactive.dev === expectedLive.dev
    && inactive.ino === expectedLive.ino;
  return { state: recorded ? "as-recorded" : swapped ? "swapped" : "ambiguous", live, inactive };
}

/**
 * Reconcile a physical exchange that completed but whose role-state write did
 * not. Every role is bound by exact pre-sealed Contents inodes; the metadata
 * rotation re-reads topology/stat tuples only and never hashes payload bytes.
 */
function reconcileEnvironmentModePairSwappedContents(
  receipt: EnvironmentModePairReceipt,
  switchedAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(switchedAt, "environment mode cache recovery exchange time");
  if (receipt.pin.state !== "prepared" && receipt.pin.state !== "post_cutover_recovery") {
    throw new Error("Environment mode cache cannot reconcile swapped Contents for a released pair");
  }
  if (classifyEnvironmentModePairContentsRoles(receipt).state !== "swapped") {
    throw new Error("Environment mode cache recovery requires exact swapped Contents roles");
  }
  return rotateEnvironmentModePairRolesAfterContentsExchange(
    receipt,
    readEnvironmentModeCacheOuterAppStat(receipt.roles.live.appPath),
    readEnvironmentModeCacheOuterAppStat(receipt.paths.inactiveAppPath),
    switchedAt,
  );
}

/**
 * An even number of exchanges leaves logical roles unchanged but advances
 * directory timestamps. Refresh only stat seals after proving every
 * inode-bearing and non-directory fact remained identical.
 */
function reconcileEnvironmentModePairRecordedContents(
  receipt: EnvironmentModePairReceipt,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  if (receipt.pin.state !== "prepared" && receipt.pin.state !== "post_cutover_recovery") {
    throw new Error("Environment mode cache cannot reconcile recorded Contents for a released pair");
  }
  if (classifyEnvironmentModePairContentsRoles(receipt).state !== "as-recorded") {
    throw new Error("Environment mode cache recovery requires exact recorded Contents roles");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    seals: {
      ...receipt.seals,
      liveApp: refreshEnvironmentModeCacheAppSeal(receipt.seals.liveApp, receipt.roles.live.appPath),
      inactiveApp: refreshEnvironmentModeCacheAppSeal(receipt.seals.inactiveApp, receipt.paths.inactiveAppPath),
    },
  });
}

function rotateEnvironmentModePairRolesAfterContentsExchange(
  receipt: EnvironmentModePairReceipt,
  liveOuterAfter: EnvironmentModeCacheStatSealRecord,
  inactiveOuterAfter: EnvironmentModeCacheStatSealRecord,
  switchedAt: string,
): EnvironmentModePairReceipt {
  const liveAppPath = receipt.roles.live.appPath;
  const inactiveAppPath = receipt.paths.inactiveAppPath;
  const liveRole: EnvironmentModeCacheRole = {
    ...receipt.roles.inactive,
    role: "live",
    appPath: liveAppPath,
    evidence: {
      ...receipt.roles.inactive.evidence,
      asarPath: join(liveAppPath, "Contents", "Resources", "app.asar"),
    },
  };
  const inactiveRole: EnvironmentModeCacheRole = {
    ...receipt.roles.live,
    role: "inactive",
    appPath: inactiveAppPath,
    evidence: {
      ...receipt.roles.live.evidence,
      asarPath: join(inactiveAppPath, "Contents", "Resources", "app.asar"),
    },
  };
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    roles: { live: liveRole, inactive: inactiveRole },
    seals: {
      ...receipt.seals,
      liveApp: rotateEnvironmentModeCacheAppSeal(
        receipt.seals.inactiveApp,
        receipt.seals.liveApp,
        liveAppPath,
        liveOuterAfter,
      ),
      inactiveApp: rotateEnvironmentModeCacheAppSeal(
        receipt.seals.liveApp,
        receipt.seals.inactiveApp,
        inactiveAppPath,
        inactiveOuterAfter,
      ),
    },
    pin: { ...receipt.pin, state: "post_cutover_recovery" },
    timestamps: { ...receipt.timestamps, lastSuccessfulSwitchAt: switchedAt },
  });
}

function readEnvironmentModeCacheOuterAppStat(path: string): EnvironmentModeCacheStatSealRecord {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Environment mode cache outer app is not a real directory: ${path}`);
  }
  return environmentModeCacheStatSealRecord(path, "", "directory", stat);
}

function refreshEnvironmentModeCacheAppSeal(
  prior: EnvironmentModeCacheTreeStatSeal,
  rootPath: string,
): EnvironmentModeCacheTreeStatSeal {
  const observed = collectEnvironmentModeCacheTreeStatSeal(rootPath);
  assertEnvironmentModeCacheComposedAppStatSeal(prior, prior, observed.entries);
  const contentEntries = composeEnvironmentModeCacheAppContentSeal(prior, prior, observed.entries);
  return {
    rootPath,
    entries: observed.entries,
    contentEntries,
    sealDigest: observed.sealDigest,
    contentDigest: environmentModeCacheContentTreeDigest(contentEntries),
  };
}

/**
 * Publish one sealed pair atomically. Replacing a prepared current pair first
 * persists its terminal stale receipt, then atomically renames current.json.
 * A failure before that final rename restores the old durable role state.
 */
export function publishEnvironmentModePair(
  paths: EnvironmentModeCachePaths,
  receipt: EnvironmentModePairReceipt,
  options: PublishEnvironmentModePairOptions = {},
): EnvironmentModePairReceipt {
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    return publishEnvironmentModePairUnlocked(paths, receipt, options);
  } finally {
    lock.release();
  }
}

/**
 * Reserve the only next slot, perform all expensive work before publication,
 * atomically move its complete bytes into a generation, then publish only a
 * fully revalidated final-path receipt. A pre-promotion failure removes only
 * its exact unpublished `next/<generation>` reservation so a corrected build
 * can retry; published generations and prior evidence are never removed here.
 */
export async function prepareAndPublishEnvironmentModePair(
  paths: EnvironmentModeCachePaths,
  generationId: string,
  callbacks: PrepareEnvironmentModePairCallbacks,
  options: PrepareEnvironmentModePairOptions = {},
): Promise<EnvironmentModePairReceipt> {
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    if (assertAtMostOneEnvironmentModeCachePreparation(paths) !== null) {
      throw new Error("Environment mode cache already has a reserved next generation");
    }
    const preparation = environmentModeCachePreparationPaths(paths, generationId);
    const generation = environmentModeCacheGenerationPaths(paths, generationId);
    if (existsSync(generation.generationRoot)) {
      throw new Error(`Environment mode cache generation already exists: ${generationId}`);
    }
    assertNoSymlinkInExistingPath(preparation.preparationRoot, "environment mode cache preparation root");
    mkdirSync(preparation.preparationRoot, { recursive: true, mode: 0o700 });
    assertRealDirectory(preparation.preparationRoot, "environment mode cache preparation root");
    mkdirSync(preparation.generationRoot, { recursive: false, mode: 0o700 });
    assertRealDirectory(preparation.generationRoot, "environment mode cache next generation");

    try {
      // The callbacks receive only the reserved `next` paths until the atomic
      // rename succeeds. In particular, a normal staging implementation has no
      // writable reference to a published generation or to a live app path.
      await callbacks.stage({ preparation });
      await callbacks.validatePrepared({ preparation });
      if (assertAtMostOneEnvironmentModeCachePreparation(paths) !== generationId) {
        throw new Error("Environment mode cache next generation reservation changed during preparation");
      }
      assertRealDirectory(preparation.generationRoot, "environment mode cache next generation");
      assertNoSymlinkInExistingPath(generation.generationRoot, "environment mode cache generation root");
      options.beforeGenerationPromotion?.();
      renameSync(preparation.generationRoot, generation.generationRoot);
      fsyncDirectory(preparation.preparationRoot);
      fsyncDirectory(paths.generationsRoot);

      const receipt = await callbacks.createValidatedReceipt({ generation });
      assertEnvironmentModePairReceipt(receipt, paths);
      assertEnvironmentModePairMaterialized(paths, receipt);
      return publishEnvironmentModePairUnlocked(paths, receipt, options);
    } catch (error) {
      if (!existsSync(generation.generationRoot) && existsSync(preparation.generationRoot)) {
        rmSync(preparation.generationRoot, { recursive: true, force: false });
        fsyncDirectory(preparation.preparationRoot);
      }
      throw error;
    }
  } finally {
    lock.release();
  }
}

function publishEnvironmentModePairUnlocked(
  paths: EnvironmentModeCachePaths,
  receipt: EnvironmentModePairReceipt,
  options: PublishEnvironmentModePairOptions,
): EnvironmentModePairReceipt {
  assertAtMostOneEnvironmentModeCachePreparation(paths);
  assertEnvironmentModePairReceipt(receipt, paths);
  assertCurrentPreparedPair(receipt);
  assertEnvironmentModePairMaterialized(paths, receipt);
  const now = options.now?.() ?? new Date().toISOString();
  assertIsoTimestamp(now, "environment mode cache publication time");
  const next = withPublishedAt(receipt, now);
  const currentBytes = readOptionalBytes(paths.currentFile, "environment mode cache current receipt");
  const previous = currentBytes === null ? null : readCurrentEnvironmentModePair(paths);
  const previousGenerationBytes = previous === null
    ? null
    : readOptionalBytes(environmentModeCacheGenerationPaths(paths, previous.generationId).receiptFile,
      "environment mode cache previous generation receipt");
  try {
    writeEnvironmentModePairGeneration(paths, next);
    if (previous !== null) {
      if (previous.pin.state === "prepared") {
        writeEnvironmentModePairGeneration(
          paths,
          supersedePreparedEnvironmentModePair(previous, next.generationId, now),
        );
      } else if (previous.pin.state === "stale_requires_prepare") {
        // Validation may already have released this pre-cutover grant. Keep
        // that release origin intact, but bind the later replacement before
        // publishing its current pointer.
        writeEnvironmentModePairGeneration(
          paths,
          linkStaleEnvironmentModePairReplacement(previous, next.generationId, now),
        );
      } else if (previous.pin.state === "cancelled" || previous.pin.state === "abandoned") {
        // Terminal pre-cutover states deliberately have no recovery edge.
        // Preserve their compact receipt, then publish a fresh grant.
        writeEnvironmentModePairGeneration(paths, previous);
      } else {
        throw new Error("Only a prepared or terminal pre-cutover environment mode pair may be replaced");
      }
    }
    options.beforeCurrentPublish?.();
    writeJsonAtomically(paths.currentFile, next);
    const observed = reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    if (observed === null || observed.generationId !== next.generationId) {
      throw new Error("Environment mode cache current publication could not be verified");
    }
    return observed;
  } catch (error) {
    // Receipt metadata is small and reversible. Generation app/runtime bytes
    // are intentionally never removed by this module.
    restoreExactBytes(paths.currentFile, currentBytes);
    if (previous !== null) {
      const previousFile = environmentModeCacheGenerationPaths(paths, previous.generationId).receiptFile;
      restoreExactBytes(previousFile, previousGenerationBytes);
    }
    throw error;
  }
}

/** Write an archived generation receipt atomically; it does not change current role state. */
export function writeEnvironmentModePairGeneration(
  paths: EnvironmentModeCachePaths,
  receipt: EnvironmentModePairReceipt,
): void {
  assertEnvironmentModePairReceipt(receipt, paths);
  const generation = environmentModeCacheGenerationPaths(paths, receipt.generationId);
  assertNoSymlinkInExistingPath(generation.generationRoot, "environment mode cache generation root");
  mkdirSync(generation.generationRoot, { recursive: true, mode: 0o700 });
  assertRealDirectory(generation.generationRoot, "environment mode cache generation root");
  writeJsonAtomically(generation.receiptFile, receipt);
}

/** A cache hit is reachable only while it is the current publication and still pinned. */
export function environmentModeCacheReachability(
  receipt: EnvironmentModePairReceipt,
  currentGenerationId: string | null,
): EnvironmentModeCacheReachability {
  if (receipt.generationId !== currentGenerationId || receipt.supersession.supersededAt !== null) {
    return "unreachable";
  }
  if (receipt.pin.state === "prepared" && receipt.pin.releasedAt === null) return "prepared_grant";
  if (receipt.pin.state === "post_cutover_recovery" && receipt.pin.releasedAt === null) {
    return "post_cutover_recovery";
  }
  return "unreachable";
}

/** A pure UI/status helper; it performs no filesystem reads or mutation. */
export function environmentModeCacheState(input: EnvironmentModeCacheStateInput): EnvironmentModeCacheState {
  if (input.unavailable) return "unavailable";
  if (input.nextGenerationId !== undefined && input.nextGenerationId !== null) return "preparing";
  if (input.current === null) return "unavailable";
  return environmentModeCacheReachability(input.current, input.current.generationId) === "prepared_grant"
    ? "ready"
    : "stale";
}

/**
 * Observe cache publication and the one preparation reservation without
 * creating any cache roots, acquiring the cache mutex, or invoking a
 * validator.  Config, Menu Bar, doctor, and status polling all share this
 * strictly read-only view.
 */
export function observeEnvironmentModeCache(paths: EnvironmentModeCachePaths): EnvironmentModeCacheStatus {
  if (!existsSync(paths.cacheRoot)) {
    return unavailableEnvironmentModeCacheStatus("no environment mode cache has been published");
  }

  let current: EnvironmentModePairReceipt | null = null;
  let nextGenerationId: string | null = null;
  let preparationPhase: EnvironmentModeCacheStatus["preparation"]["phase"] = "idle";
  const reasons: string[] = [];
  try {
    current = readCurrentEnvironmentModePair(paths);
    nextGenerationId = assertAtMostOneEnvironmentModeCachePreparation(paths);
    if (nextGenerationId !== null) {
      const next = environmentModeCachePreparationPaths(paths, nextGenerationId);
      preparationPhase = existsSync(next.receiptFile) ? "receipt-published" : "reserved";
    }
  } catch (error) {
    return unavailableEnvironmentModeCacheStatus(errorMessage(error));
  }

  const state = environmentModeCacheState({ current, nextGenerationId });
  if (current === null) reasons.push("no published generation");
  if (current !== null) {
    if (current.supersession.supersededAt !== null) {
      reasons.push(`generation superseded at ${current.supersession.supersededAt}`);
    }
    if (current.pin.releasedAt !== null) {
      reasons.push(current.pin.releaseReason
        ? `generation pin released: ${current.pin.releaseReason}`
        : "generation pin released");
    }
    if (current.pin.state === "post_cutover_recovery") {
      reasons.push("generation requires post-cutover recovery");
    }
  }
  if (state === "preparing") reasons.push("a replacement generation is being prepared");

  return {
    schemaVersion: 2,
    state,
    generationId: current?.generationId ?? nextGenerationId,
    roles: current
      ? {
        live: {
          role: current.roles.live.role,
          experience: current.roles.live.experience,
          appPath: current.roles.live.appPath,
        },
        inactive: {
          role: current.roles.inactive.role,
          experience: current.roles.inactive.experience,
          appPath: current.roles.inactive.appPath,
        },
      }
      : null,
    invalidationReasons: reasons,
    preparation: { generationId: nextGenerationId, phase: preparationPhase },
    pin: current
      ? {
        state: current.pin.state,
        pinnedAt: current.pin.pinnedAt,
        releasedAt: current.pin.releasedAt,
        releaseReason: current.pin.releaseReason,
      }
      : null,
    supersession: current?.supersession ?? null,
    timings: current?.timestamps ?? null,
  };
}

function unavailableEnvironmentModeCacheStatus(reason: string): EnvironmentModeCacheStatus {
  return {
    schemaVersion: 2,
    state: "unavailable",
    generationId: null,
    roles: null,
    invalidationReasons: [reason],
    preparation: { generationId: null, phase: "unavailable" },
    pin: null,
    supersession: null,
    timings: null,
  };
}

/**
 * A cancelled confirmation is terminal before cutover. It never owns recovery
 * bytes, so it must release the prepared grant instead of looking actionable
 * to a later prepare or GC pass.
 */
export function recordEnvironmentModePairPreCutoverCancellation(
  receipt: EnvironmentModePairReceipt,
  cancelledAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(cancelledAt, "environment mode cache cancellation time");
  if (receipt.pin.state === "cancelled") return receipt;
  if (receipt.pin.state !== "prepared") {
    throw new Error("Only a prepared environment mode pair can be cancelled before cutover");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: {
      ...receipt.pin,
      state: "cancelled",
      releasedAt: cancelledAt,
      releaseReason: "cancelled",
    },
    timestamps: {
      ...receipt.timestamps,
      lastPreCutoverCancellationAt: cancelledAt,
      terminalAt: cancelledAt,
    },
  });
}

/**
 * Persist one terminal pre-cutover release under the cache mutex.  This does
 * not clear `current.json`: its released receipt remains the atomic authority
 * until a fresh pair replaces it, so GC can never reclaim payload behind a
 * still-current pointer.  The default-off coordinator exposes no command
 * route here; cancellation/helper owners call this narrow transition when
 * they have durably established that no Contents exchange occurred.
 */
export function releaseCurrentEnvironmentModePairBeforeCutover(
  paths: EnvironmentModeCachePaths,
  generationId: string,
  releasedAt: string,
  reason: "cancelled" | "helper_failed" | "abandoned",
): EnvironmentModePairReceipt {
  assertSafeEnvironmentModeCacheGenerationId(generationId);
  assertIsoTimestamp(releasedAt, "environment mode cache pre-cutover release time");
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    const current = readCurrentEnvironmentModePair(paths);
    if (current === null || current.generationId !== generationId) {
      throw new Error("Environment mode cache current generation changed before pre-cutover release");
    }
    const next = reason === "cancelled"
      ? recordEnvironmentModePairPreCutoverCancellation(current, releasedAt)
      : abandonEnvironmentModePair(current, releasedAt, reason);
    if (next === current) return current;
    persistEnvironmentModePairRecoveryTransition(paths, current, next);
    return next;
  } finally {
    lock.release();
  }
}

/** A successful exchange retains a pin only for durable post-cutover recovery. */
export function markEnvironmentModePairPostCutoverRecovery(
  receipt: EnvironmentModePairReceipt,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  if (receipt.pin.state === "post_cutover_recovery") return receipt;
  if (receipt.pin.state !== "prepared") {
    throw new Error("Only a prepared environment mode pair can enter post-cutover recovery");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: { ...receipt.pin, state: "post_cutover_recovery" },
  });
}

/**
 * A terminal warm target proof restores the already-rotated pair to the sole
 * reusable cache-hit state. This has no clock input: it deliberately retains
 * the immutable `lastSuccessfulSwitchAt` written by the one Contents exchange.
 * Only the held warm-commit lease exposes this as a durable transition.
 */
function markEnvironmentModePairTerminalTargetPrepared(
  receipt: EnvironmentModePairReceipt,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  if (receipt.pin.state !== "post_cutover_recovery"
    || receipt.pin.releasedAt !== null
    || receipt.pin.releaseReason !== null
    || receipt.timestamps.lastSuccessfulSwitchAt === null
    || receipt.supersession.supersededAt !== null
    || receipt.supersession.replacementGenerationId !== null) {
    throw new Error("Only a switched post-cutover recovery pair can become a terminal prepared cache grant");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: { ...receipt.pin, state: "prepared" },
  });
}

/**
 * A replacement can supersede only a pre-cutover prepared grant. Recovery
 * reachability is deliberately non-replaceable until later transaction work
 * proves a terminal direction.
 */
export function supersedePreparedEnvironmentModePair(
  receipt: EnvironmentModePairReceipt,
  replacementGenerationId: string,
  supersededAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertSafeEnvironmentModeCacheGenerationId(replacementGenerationId);
  assertIsoTimestamp(supersededAt, "environment mode cache supersession time");
  if (receipt.generationId === replacementGenerationId) {
    throw new Error("Environment mode cache generation cannot supersede itself");
  }
  if (receipt.pin.state !== "prepared") {
    throw new Error("Only a pre-cutover prepared environment mode pair may be superseded");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: {
      ...receipt.pin,
      state: "stale_requires_prepare",
      releasedAt: supersededAt,
      releaseReason: "superseded",
    },
    supersession: {
      supersededAt,
      replacementGenerationId,
    },
    timestamps: { ...receipt.timestamps, terminalAt: supersededAt },
  });
}

/**
 * A stale grant may have been released because its validation inputs drifted
 * before a replacement exists. Publishing that replacement adds the durable
 * replacement link without rewriting the original invalidation reason or
 * release timestamp.
 */
function linkStaleEnvironmentModePairReplacement(
  receipt: EnvironmentModePairReceipt,
  replacementGenerationId: string,
  replacementPublishedAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertSafeEnvironmentModeCacheGenerationId(replacementGenerationId);
  assertIsoTimestamp(replacementPublishedAt, "environment mode cache replacement publication time");
  if (receipt.generationId === replacementGenerationId) {
    throw new Error("Environment mode cache generation cannot replace itself");
  }
  if (receipt.pin.state !== "stale_requires_prepare") {
    throw new Error("Only a terminal-stale environment mode pair may record a later replacement");
  }
  if (receipt.supersession.supersededAt !== null || receipt.supersession.replacementGenerationId !== null) {
    throw new Error("Terminal-stale environment mode pair already has a replacement link");
  }
  if (receipt.pin.releaseReason !== "invalidated") {
    throw new Error("Only an invalidated terminal-stale pair may receive a later replacement link");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    supersession: {
      supersededAt: replacementPublishedAt,
      replacementGenerationId,
    },
  });
}

/**
 * `stale_requires_prepare` has no recovery responsibility. Cancelling it is
 * terminal and idempotent, so repair/retry callers can safely repeat it.
 */
export function cancelStaleEnvironmentModePair(
  receipt: EnvironmentModePairReceipt,
  cancelledAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(cancelledAt, "environment mode cache cancellation time");
  if (receipt.pin.state === "cancelled") return receipt;
  if (receipt.pin.state !== "stale_requires_prepare") {
    throw new Error("Only stale_requires_prepare environment mode pairs may be cancelled");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    // The terminal state records cancellation; the release reason remains the
    // auditable reason that the grant first became unusable.
    pin: {
      ...receipt.pin,
      state: "cancelled",
      releasedAt: receipt.pin.releasedAt ?? cancelledAt,
      releaseReason: receipt.pin.releaseReason,
    },
    timestamps: { ...receipt.timestamps, terminalAt: cancelledAt },
  });
}

/** Helper failure before cutover abandons an ordinary prepared pin and never creates recovery reachability. */
export function abandonEnvironmentModePair(
  receipt: EnvironmentModePairReceipt,
  abandonedAt: string,
  reason: "helper_failed" | "abandoned" = "abandoned",
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(abandonedAt, "environment mode cache abandonment time");
  if (receipt.pin.state === "abandoned") return receipt;
  if (receipt.pin.state !== "prepared") {
    throw new Error("Only a prepared environment mode pair may be abandoned before cutover");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: { ...receipt.pin, state: "abandoned", releasedAt: abandonedAt, releaseReason: reason },
    timestamps: { ...receipt.timestamps, terminalAt: abandonedAt },
  });
}

export function recordEnvironmentModePairHelperFailure(
  receipt: EnvironmentModePairReceipt,
  failedAt: string,
): EnvironmentModePairReceipt {
  return abandonEnvironmentModePair(receipt, failedAt, "helper_failed");
}

/**
 * A failed revalidation is terminal before cutover: it retains the bytes for
 * audit but releases the grant so a later caller must prepare a fresh pair.
 */
export function invalidateEnvironmentModePair(
  receipt: EnvironmentModePairReceipt,
  invalidatedAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(invalidatedAt, "environment mode cache invalidation time");
  if (receipt.pin.state === "stale_requires_prepare") return receipt;
  if (receipt.pin.state !== "prepared") {
    throw new Error("Only a prepared environment mode pair may be invalidated before cutover");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: {
      ...receipt.pin,
      state: "stale_requires_prepare",
      releasedAt: invalidatedAt,
      releaseReason: "invalidated",
    },
    timestamps: { ...receipt.timestamps, terminalAt: invalidatedAt },
  });
}

/**
 * A verified OpenAI update is an updater-safety boundary, not an ordinary
 * pre-cutover drift. It may arrive while a pair is retained solely for
 * post-cutover recovery, so release either active pin without replacing any
 * application bytes.
 */
export function invalidateEnvironmentModePairForVerifiedOfficialUpdate(
  receipt: EnvironmentModePairReceipt,
  invalidatedAt: string,
): EnvironmentModePairReceipt {
  assertEnvironmentModePairReceipt(receipt);
  assertIsoTimestamp(invalidatedAt, "environment mode cache verified official update time");
  if (receipt.pin.state === "stale_requires_prepare") return receipt;
  if (receipt.pin.state !== "prepared" && receipt.pin.state !== "post_cutover_recovery") {
    throw new Error("Only an active environment mode pair may be invalidated for a verified official update");
  }
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    pin: {
      ...receipt.pin,
      state: "stale_requires_prepare",
      releasedAt: invalidatedAt,
      releaseReason: "invalidated",
    },
    timestamps: { ...receipt.timestamps, terminalAt: invalidatedAt },
  });
}

/**
 * Atomically persist a terminal cache invalidation without touching the app,
 * runtime, watcher, transaction, or any generation bytes.
 */
export function invalidateCurrentEnvironmentModePair(
  paths: EnvironmentModeCachePaths,
  generationId: string,
  invalidatedAt: string,
): EnvironmentModePairReceipt {
  ensureEnvironmentModeCacheRoots(paths);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("Environment mode cache mutex is already held"),
  });
  try {
    reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    const current = readCurrentEnvironmentModePair(paths);
    if (current === null || current.generationId !== generationId) {
      throw new Error("Environment mode cache current generation changed before invalidation");
    }
    const next = invalidateEnvironmentModePair(current, invalidatedAt);
    if (next === current) return current;
    const currentBytes = readOptionalBytes(paths.currentFile, "environment mode cache current receipt");
    const generationFile = environmentModeCacheGenerationPaths(paths, generationId).receiptFile;
    const generationBytes = readOptionalBytes(generationFile, "environment mode cache generation receipt");
    try {
      writeEnvironmentModePairGeneration(paths, next);
      writeJsonAtomically(paths.currentFile, next);
      const observed = reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
      if (observed === null || observed.pin.state !== "stale_requires_prepare") {
        throw new Error("Environment mode cache invalidation could not be verified");
      }
      return observed;
    } catch (error) {
      restoreExactBytes(paths.currentFile, currentBytes);
      restoreExactBytes(generationFile, generationBytes);
      throw error;
    }
  } finally {
    lock.release();
  }
}

/**
 * Validate a current pair for a future warm exchange. The supplied full
 * validator runs even if the stat seal already failed, giving callers a
 * complete stale classification before any later layer could contemplate a
 * quit. This module has no quit or process-control capability.
 */
export function validateCurrentEnvironmentModePair(
  paths: EnvironmentModeCachePaths,
  callbacks: EnvironmentModeCacheValidationCallbacks,
  now: () => string = () => new Date().toISOString(),
): EnvironmentModeCacheValidationResult {
  let receipt: EnvironmentModePairReceipt | null;
  try {
    receipt = readCurrentEnvironmentModePair(paths);
  } catch (error) {
    return { state: "unavailable", receipt: null, reasons: [errorMessage(error)] };
  }
  if (receipt === null) return { state: "unavailable", receipt: null, reasons: ["no published generation"] };
  // A warm exchange deliberately leaves the pair in recovery reachability
  // with mixed outer-app/Contents role evidence. It is audit material for T5,
  // never a candidate for another preparation/cache-hit validation pass.
  if (receipt.pin.state === "post_cutover_recovery") {
    return {
      state: "unavailable",
      receipt,
      reasons: ["current generation requires post-cutover recovery"],
    };
  }
  // Cancellation/abandonment are terminal pre-cutover outcomes, not invalid
  // cache hits and not candidates for a second invalidation. A replacement
  // prepare may safely publish a new generation while retaining these bytes
  // and their compact receipt for audit.
  if (receipt.pin.state === "cancelled" || receipt.pin.state === "abandoned") {
    return {
      state: "unavailable",
      receipt,
      reasons: [`current generation is terminal ${receipt.pin.state}`],
    };
  }

  let sealError: string | null = null;
  try {
    assertEnvironmentModePairMaterialized(paths, receipt);
  } catch (error) {
    sealError = errorMessage(error);
  }

  let observed: EnvironmentModeCacheInvalidationSnapshot | null = null;
  let validatorError: string | null = null;
  try {
    observed = callbacks.inspectInvalidation(receipt);
    if (!isEnvironmentModeCacheInvalidationSnapshot(observed)) {
      throw new Error("environment mode cache full validator returned an invalid snapshot");
    }
  } catch (error) {
    validatorError = errorMessage(error);
  }

  const changes = observed === null
    ? []
    : compareEnvironmentModeCacheInvalidation(receipt.invalidation, observed);
  if (sealError === null && validatorError === null && changes.length === 0) {
    return { state: "ready", receipt, reasons: [] };
  }

  const invalidatedAt = now();
  assertIsoTimestamp(invalidatedAt, "environment mode cache invalidation time");
  const stale = invalidateCurrentEnvironmentModePair(paths, receipt.generationId, invalidatedAt);
  return {
    state: "stale_requires_prepare",
    receipt: stale,
    reasons: [
      ...(sealError === null ? [] : [`stat-seal: ${sealError}`]),
      ...(validatorError === null ? [] : [`full-validator: ${validatorError}`]),
      ...changes.map((change) => `invalidation: ${change}`),
    ],
  };
}

/**
 * Perform the whole T3 pre-confirmation decision atomically from the caller's
 * point of view: a cache hit is returned only after full validation, and a
 * stale pair is terminally marked before a new generation can be built.
 */
export async function prepareOrReuseEnvironmentModePair(
  paths: EnvironmentModeCachePaths,
  generationId: string,
  callbacks: PrepareOrReuseEnvironmentModePairCallbacks,
  options: PrepareEnvironmentModePairOptions = {},
): Promise<PrepareOrReuseEnvironmentModePairResult> {
  const validation = validateCurrentEnvironmentModePair(paths, callbacks, options.now);
  if (validation.state === "ready" && validation.receipt !== null) {
    return { state: "cache_hit", receipt: validation.receipt, previousValidation: null };
  }
  // A malformed/unsafe current pointer is not a cache miss. Refuse before
  // expensive work, because replacing an unreadable authority record would
  // obscure exactly the evidence later recovery needs.
  const replaceableTerminal = validation.receipt?.pin.state === "cancelled"
    || validation.receipt?.pin.state === "abandoned";
  if (validation.state === "unavailable"
    && !validation.reasons.includes("no published generation")
    && !replaceableTerminal) {
    throw new Error(`Environment mode cache cannot prepare from unavailable state: ${validation.reasons.join("; ")}`);
  }
  const receipt = await prepareAndPublishEnvironmentModePair(paths, generationId, callbacks, options);
  return {
    state: "prepared",
    receipt,
    previousValidation: validation.state === "stale_requires_prepare" ? validation : null,
  };
}

/** Return named invalidation groups rather than accepting a stale cache hit. */
export function compareEnvironmentModeCacheInvalidation(
  expected: EnvironmentModeCacheInvalidationEvidence,
  observed: EnvironmentModeCacheInvalidationSnapshot,
): string[] {
  if (!isEnvironmentModeCacheInvalidationEvidence(expected)
    || !isEnvironmentModeCacheInvalidationSnapshot(observed)) {
    throw new Error("Environment mode cache invalidation evidence is invalid");
  }
  const changes: string[] = [];
  if (!sameJson(expected.official, observed.official)) changes.push("official");
  if (!sameJson(expected.tweakers, observed.tweakers)) changes.push("tweakers");
  if (!sameJson(expected.environment, observed.environment)) changes.push("environment");
  return changes;
}

/** Pure bounded-GC classification for T6. This module never deletes generation bytes. */
export function environmentModeCacheGcEligibility(
  receipt: EnvironmentModePairReceipt,
  currentGenerationId: string | null,
): EnvironmentModeCacheGcEligibility {
  assertEnvironmentModePairReceipt(receipt);
  if (receipt.generationId === currentGenerationId) {
    return { generationId: receipt.generationId, eligible: false, reason: "current published generation" };
  }
  if (receipt.pin.releasedAt === null) {
    return { generationId: receipt.generationId, eligible: false, reason: "generation remains pinned" };
  }
  if (receipt.pin.state === "stale_requires_prepare" || receipt.pin.state === "cancelled" || receipt.pin.state === "abandoned") {
    return { generationId: receipt.generationId, eligible: true, reason: `terminal ${receipt.pin.state} generation is unpinned` };
  }
  return { generationId: receipt.generationId, eligible: false, reason: "generation is not terminal" };
}

/** Stable state means exactly one atomic publication and no held next reservation. */
export function assertEnvironmentModeCacheSteadyState(paths: EnvironmentModeCachePaths): EnvironmentModePairReceipt {
  const current = readCurrentEnvironmentModePair(paths);
  if (current === null) throw new Error("Environment mode cache has no published generation");
  if (assertAtMostOneEnvironmentModeCachePreparation(paths) !== null) {
    throw new Error("Environment mode cache is not steady while a next generation exists");
  }
  if (environmentModeCacheReachability(current, current.generationId) !== "prepared_grant") {
    throw new Error("Environment mode cache current generation is not a reachable prepared pair");
  }
  return current;
}

/** Check all required roots are real, mutually same-device directories, and still match their full stat seals. */
export function assertEnvironmentModePairMaterialized(
  paths: EnvironmentModeCachePaths,
  receipt: EnvironmentModePairReceipt,
): void {
  assertEnvironmentModePairReceipt(receipt, paths);
  assertEnvironmentModeCacheRootIsReal(paths);
  const roots = [
    receipt.roles.live.appPath,
    receipt.paths.generationRoot,
    receipt.paths.inactiveAppPath,
    receipt.paths.runtimeRoot,
    receipt.paths.managedRuntimeRoot,
  ];
  for (const root of roots) assertRealDirectory(root, "environment mode pair artifact root");
  assertEnvironmentModeCacheSameDevice(roots);
  assertEnvironmentModePairContentsExchangeable(receipt);
  // The live tree tolerates macOS stat churn but still proves its payloads;
  // cache-resident trees keep the strict full seal.
  assertEnvironmentModeCacheLiveTreeSeal(receipt.roles.live.appPath, receipt.seals.liveApp, { verifyContent: true });
  assertEnvironmentModeCacheTreeSeal(receipt.paths.inactiveAppPath, receipt.seals.inactiveApp);
  assertEnvironmentModeCacheTreeSeal(receipt.paths.runtimeRoot, receipt.seals.runtime);
  assertEnvironmentModeCacheTreeSeal(receipt.paths.managedRuntimeRoot, receipt.seals.managedRuntime);
}

/**
 * Post-approval stat-seal counterpart to `assertEnvironmentModePairMaterialized`.
 *
 * A pin is not a filesystem lock.  Before watcher pause or process quit, warm
 * commit must re-read the complete topology and stat tuple of every sealed
 * app/runtime tree.  In particular, this catches an arbitrary nested edit
 * whose file length and mtime were restored: `ctime` and the ordered topology
 * remain part of every record.  It intentionally does not reread file payloads
 * or calculate content hashes; those immutable payload proofs were completed
 * during preparation.  A disagreement is classified by the full validator
 * before cutover.
 *
 * This uses the existing stat-only walker pending a representative benchmark
 * for a single native/batched walk.  Do not narrow this to root/ASAR checks:
 * that would turn a durable pin into an unsound trust boundary.
 */
export function assertEnvironmentModePairWarmCommitMaterialized(
  paths: EnvironmentModeCachePaths,
  receipt: EnvironmentModePairReceipt,
): void {
  assertEnvironmentModePairReceipt(receipt, paths);
  assertEnvironmentModeCacheRootIsReal(paths);
  const roots = [
    receipt.roles.live.appPath,
    receipt.paths.generationRoot,
    receipt.paths.inactiveAppPath,
    receipt.paths.runtimeRoot,
    receipt.paths.managedRuntimeRoot,
  ];
  for (const root of roots) assertRealDirectory(root, "environment mode pair artifact root");
  assertEnvironmentModeCacheSameDevice(roots);
  assertEnvironmentModePairContentsExchangeable(receipt);
  // Byte-free by doctrine; the live tree additionally tolerates macOS stat
  // churn (first-launch provenance xattrs, Sparkle activity) while its
  // topology, modes, sizes, and symlink targets stay pinned.
  assertEnvironmentModeCacheLiveTreeSeal(receipt.roles.live.appPath, receipt.seals.liveApp);
  assertEnvironmentModeCacheTreeStatSealOnly(receipt.paths.inactiveAppPath, receipt.seals.inactiveApp);
  assertEnvironmentModeCacheTreeStatSealOnly(receipt.paths.runtimeRoot, receipt.seals.runtime);
  assertEnvironmentModeCacheTreeStatSealOnly(receipt.paths.managedRuntimeRoot, receipt.seals.managedRuntime);
}

/**
 * Future swaps exchange `Contents`, not merely their enclosing .app folders.
 * Require those exact real directories to be on the same device while the
 * pair is still only a prepared grant.
 */
export function assertEnvironmentModePairContentsExchangeable(
  receipt: EnvironmentModePairReceipt,
  deps: EnvironmentModeCacheSameDeviceDeps = {},
): void {
  assertEnvironmentModePairReceipt(receipt);
  const contents = [
    join(receipt.roles.live.appPath, "Contents"),
    join(receipt.paths.inactiveAppPath, "Contents"),
  ];
  for (const path of contents) assertRealDirectory(path, "environment mode pair Contents directory");
  assertEnvironmentModeCacheSameDevice(contents, deps);
}

/** Same-device validation is required before any future native exchange can be offered. */
export function assertEnvironmentModeCacheSameDevice(
  paths: readonly string[],
  deps: EnvironmentModeCacheSameDeviceDeps = {},
): void {
  if (paths.length < 2) throw new Error("Environment mode cache same-device check requires at least two paths");
  const stat = deps.stat ?? ((path: string) => statSync(path, { bigint: true }));
  let expected: string | null = null;
  for (const path of paths) {
    assertNoSymlinkInExistingPath(path, "environment mode cache same-device path");
    const device = stat(path).dev.toString();
    if (expected === null) expected = device;
    else if (device !== expected) {
      throw new Error("Environment mode cache artifacts must be on the same filesystem device");
    }
  }
}

/** Atomically persist a generation-preserving recovery transition under the held cache mutex. */
function persistEnvironmentModePairRecoveryTransition(
  paths: EnvironmentModeCachePaths,
  previous: EnvironmentModePairReceipt,
  next: EnvironmentModePairReceipt,
): void {
  assertEnvironmentModePairReceipt(previous, paths);
  assertEnvironmentModePairReceipt(next, paths);
  if (previous.generationId !== next.generationId) {
    throw new Error("Environment mode cache recovery cannot replace a generation");
  }
  reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
  const current = readCurrentEnvironmentModePair(paths);
  const archived = readEnvironmentModePairGeneration(paths, previous.generationId);
  if (current === null || archived === null
    || current.invalidation.receiptDigest !== previous.invalidation.receiptDigest
    || archived.invalidation.receiptDigest !== previous.invalidation.receiptDigest) {
    throw new Error("Environment mode cache receipt changed before recovery persistence");
  }
  const currentBytes = readOptionalBytes(paths.currentFile, "environment mode cache current receipt");
  const generationFile = environmentModeCacheGenerationPaths(paths, previous.generationId).receiptFile;
  const generationBytes = readOptionalBytes(generationFile, "environment mode cache generation receipt");
  try {
    writeEnvironmentModePairGeneration(paths, next);
    writeJsonAtomically(paths.currentFile, next);
    const observed = reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    if (observed === null
      || observed.generationId !== next.generationId
      || observed.invalidation.receiptDigest !== next.invalidation.receiptDigest) {
      throw new Error("Environment mode cache recovery receipt transition could not be verified");
    }
  } catch (error) {
    restoreExactBytes(paths.currentFile, currentBytes);
    restoreExactBytes(generationFile, generationBytes);
    throw error;
  }
}

/** Persist pre-cutover invalidation without reacquiring the already-held cache mutex. */
function persistEnvironmentModePairWarmCommitInvalidation(
  paths: EnvironmentModeCachePaths,
  previous: EnvironmentModePairReceipt,
  next: EnvironmentModePairReceipt,
): void {
  assertEnvironmentModePairReceipt(previous, paths);
  assertEnvironmentModePairReceipt(next, paths);
  if (previous.generationId !== next.generationId
    || previous.pin.state !== "prepared"
    || next.pin.state !== "stale_requires_prepare"
    || next.pin.releaseReason !== "invalidated") {
    throw new Error("Environment mode cache warm commit invalidation has an invalid receipt transition");
  }
  reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
  const current = readCurrentEnvironmentModePair(paths);
  const archived = readEnvironmentModePairGeneration(paths, previous.generationId);
  if (current === null || archived === null
    || current.invalidation.receiptDigest !== previous.invalidation.receiptDigest
    || archived.invalidation.receiptDigest !== previous.invalidation.receiptDigest) {
    throw new Error("Environment mode cache prepared pair changed before warm commit invalidation");
  }
  const currentBytes = readOptionalBytes(paths.currentFile, "environment mode cache current receipt");
  const generationFile = environmentModeCacheGenerationPaths(paths, previous.generationId).receiptFile;
  const generationBytes = readOptionalBytes(generationFile, "environment mode cache generation receipt");
  try {
    writeEnvironmentModePairGeneration(paths, next);
    writeJsonAtomically(paths.currentFile, next);
    const observed = reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    if (observed === null
      || observed.invalidation.receiptDigest !== next.invalidation.receiptDigest
      || observed.pin.state !== "stale_requires_prepare") {
      throw new Error("Environment mode cache warm commit invalidation could not be verified");
    }
  } catch (error) {
    restoreExactBytes(paths.currentFile, currentBytes);
    restoreExactBytes(generationFile, generationBytes);
    throw error;
  }
}

function persistEnvironmentModePairWarmCommitRotation(
  paths: EnvironmentModeCachePaths,
  previous: EnvironmentModePairReceipt,
  next: EnvironmentModePairReceipt,
): void {
  assertEnvironmentModePairReceipt(previous, paths);
  assertEnvironmentModePairReceipt(next, paths);
  if (previous.generationId !== next.generationId
    || previous.pin.state !== "prepared"
    || next.pin.state !== "post_cutover_recovery") {
    throw new Error("Environment mode cache warm commit rotation has an invalid role-state transition");
  }
  reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
  const current = readCurrentEnvironmentModePair(paths);
  const archived = readEnvironmentModePairGeneration(paths, previous.generationId);
  if (current === null || archived === null
    || current.invalidation.receiptDigest !== previous.invalidation.receiptDigest
    || archived.invalidation.receiptDigest !== previous.invalidation.receiptDigest) {
    throw new Error("Environment mode cache prepared pair changed before warm commit receipt rotation");
  }
  const currentBytes = readOptionalBytes(paths.currentFile, "environment mode cache current receipt");
  const generationFile = environmentModeCacheGenerationPaths(paths, previous.generationId).receiptFile;
  const generationBytes = readOptionalBytes(generationFile, "environment mode cache generation receipt");
  try {
    writeEnvironmentModePairGeneration(paths, next);
    writeJsonAtomically(paths.currentFile, next);
    const observed = reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    if (observed === null
      || observed.invalidation.receiptDigest !== next.invalidation.receiptDigest
      || observed.pin.state !== "post_cutover_recovery") {
      throw new Error("Environment mode cache warm commit receipt rotation could not be verified");
    }
  } catch (error) {
    restoreExactBytes(paths.currentFile, currentBytes);
    restoreExactBytes(generationFile, generationBytes);
    throw error;
  }
}

/**
 * Atomically move only the cache receipt between recovery and prepared while
 * the warm lease remains held. App bytes, runtime state, watcher state, and
 * selection are all outside this metadata-only persistence boundary.
 */
function persistEnvironmentModePairWarmCommitTerminalTargetTransition(
  paths: EnvironmentModeCachePaths,
  previous: EnvironmentModePairReceipt,
  next: EnvironmentModePairReceipt,
  previousState: "post_cutover_recovery" | "prepared",
  nextState: "post_cutover_recovery" | "prepared",
): void {
  assertEnvironmentModePairReceipt(previous, paths);
  assertEnvironmentModePairReceipt(next, paths);
  if (previous.generationId !== next.generationId
    || previous.pin.state !== previousState
    || next.pin.state !== nextState
    || previous.timestamps.lastSuccessfulSwitchAt === null
    || next.timestamps.lastSuccessfulSwitchAt !== previous.timestamps.lastSuccessfulSwitchAt) {
    throw new Error("Environment mode cache terminal target transition has an invalid receipt state");
  }
  reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
  const current = readCurrentEnvironmentModePair(paths);
  const archived = readEnvironmentModePairGeneration(paths, previous.generationId);
  if (current === null || archived === null
    || current.invalidation.receiptDigest !== previous.invalidation.receiptDigest
    || archived.invalidation.receiptDigest !== previous.invalidation.receiptDigest) {
    throw new Error("Environment mode cache receipt changed before terminal target transition");
  }
  const currentBytes = readOptionalBytes(paths.currentFile, "environment mode cache current receipt");
  const generationFile = environmentModeCacheGenerationPaths(paths, previous.generationId).receiptFile;
  const generationBytes = readOptionalBytes(generationFile, "environment mode cache generation receipt");
  try {
    writeEnvironmentModePairGeneration(paths, next);
    writeJsonAtomically(paths.currentFile, next);
    const observed = reconcileCurrentEnvironmentModePairReceiptShadowUnlocked(paths);
    if (observed === null
      || observed.invalidation.receiptDigest !== next.invalidation.receiptDigest
      || observed.pin.state !== nextState
      || observed.timestamps.lastSuccessfulSwitchAt !== previous.timestamps.lastSuccessfulSwitchAt) {
      throw new Error("Environment mode cache terminal target transition could not be verified");
    }
  } catch (error) {
    restoreExactBytes(paths.currentFile, currentBytes);
    restoreExactBytes(generationFile, generationBytes);
    throw error;
  }
}

function assertEnvironmentModePairContentsExchangeProof(
  receipt: EnvironmentModePairReceipt,
  proof: EnvironmentModePairContentsExchangeProof,
): void {
  if (!isEnvironmentModePairContentsExchangeProof(proof)) {
    throw new Error("Environment mode cache Contents exchange proof has an invalid schema");
  }
  const liveAppPath = receipt.roles.live.appPath;
  const inactiveAppPath = receipt.paths.inactiveAppPath;
  const liveContents = join(liveAppPath, "Contents");
  const inactiveContents = join(inactiveAppPath, "Contents");
  const liveContentsSeal = environmentModeCacheSealEntry(receipt.seals.liveApp, "Contents");
  const inactiveContentsSeal = environmentModeCacheSealEntry(receipt.seals.inactiveApp, "Contents");
  if (liveContentsSeal === null || inactiveContentsSeal === null
    || liveContentsSeal.type !== "directory" || inactiveContentsSeal.type !== "directory") {
    throw new Error("Environment mode cache pair lacks sealed Contents directories");
  }
  assertContentsIdentity(proof.liveContentsBefore, liveContents, liveContentsSeal);
  assertContentsIdentity(proof.inactiveContentsBefore, inactiveContents, inactiveContentsSeal);
  assertContentsIdentityMatches(proof.liveContentsAfter, liveContents, proof.inactiveContentsBefore);
  assertContentsIdentityMatches(proof.inactiveContentsAfter, inactiveContents, proof.liveContentsBefore);
  assertContentsIdentityMatches(readEnvironmentModeCacheContentsIdentity(liveContents), liveContents, proof.liveContentsAfter);
  assertContentsIdentityMatches(readEnvironmentModeCacheContentsIdentity(inactiveContents), inactiveContents, proof.inactiveContentsAfter);

  assertOuterAppContinuity(
    proof.liveOuterBefore,
    proof.liveOuterAfter,
    liveAppPath,
    receipt.seals.liveApp.entries[0]!,
  );
  assertOuterAppContinuity(
    proof.inactiveOuterBefore,
    proof.inactiveOuterAfter,
    inactiveAppPath,
    receipt.seals.inactiveApp.entries[0]!,
  );
}

function rotateEnvironmentModeCacheAppSeal(
  incoming: EnvironmentModeCacheTreeStatSeal,
  stationaryOuter: EnvironmentModeCacheTreeStatSeal,
  nextRootPath: string,
  outerAfter: EnvironmentModeCacheStatSealRecord,
): EnvironmentModeCacheTreeStatSeal {
  if (!isEnvironmentModeCacheTreeStatSeal(incoming)
    || !isEnvironmentModeCacheTreeStatSeal(stationaryOuter)
    || !isEnvironmentModeCacheStatSealRecord(outerAfter)
    || outerAfter.relativePath !== ""
    || outerAfter.type !== "directory") {
    throw new Error("Environment mode cache app seal cannot rotate without exact outer-app stat evidence");
  }
  const stationaryRoot = stationaryOuter.entries[0]!;
  if (outerAfter.mode !== stationaryRoot.mode) {
    throw new Error("Environment mode cache outer-app permissions changed during Contents exchange");
  }
  // `RENAME_SWAP` composes incoming Contents with the existing enclosing
  // .app directory. Re-read only the topology/stat tuples after exchange;
  // the two prepared full-content digests and the proven inode mapping remain
  // the content authority. This deliberately avoids a post-approval hash.
  const observed = collectEnvironmentModeCacheTreeStatSeal(nextRootPath);
  if (!sameJson(observed.entries[0], outerAfter)) {
    throw new Error("Environment mode cache outer-app stat evidence changed before role seal rotation");
  }
  assertEnvironmentModeCacheComposedAppStatSeal(incoming, stationaryOuter, observed.entries);
  const contentEntries = composeEnvironmentModeCacheAppContentSeal(incoming, stationaryOuter, observed.entries);
  return {
    rootPath: nextRootPath,
    entries: observed.entries,
    contentEntries,
    sealDigest: observed.sealDigest,
    // The post-swap tree is a deterministic composition of the incoming
    // Contents records and the stationary outer-app records. This hashes only
    // already-bound receipt metadata; it never rereads a payload after
    // approval.
    contentDigest: environmentModeCacheContentTreeDigest(contentEntries),
  };
}

/**
 * Verify the exact composition created by a Contents-only exchange. Entries
 * below Contents come from the incoming prepared app; all other descendants
 * remain on their stationary outer app. Directory timestamps may change as a
 * direct filesystem effect of the rename, but file/symlink metadata and every
 * inode-bearing identity must remain exact.
 */
function assertEnvironmentModeCacheComposedAppStatSeal(
  incoming: EnvironmentModeCacheTreeStatSeal,
  stationaryOuter: EnvironmentModeCacheTreeStatSeal,
  observed: readonly EnvironmentModeCacheStatSealRecord[],
): void {
  const incomingByPath = new Map(incoming.entries.map((entry) => [entry.relativePath, entry]));
  const stationaryByPath = new Map(stationaryOuter.entries.map((entry) => [entry.relativePath, entry]));
  const expectedEntryCount = stationaryOuter.entries.filter((entry) => (
    entry.relativePath !== "Contents" && !entry.relativePath.startsWith("Contents/")
  )).length + incoming.entries.filter((entry) => (
    entry.relativePath === "Contents" || entry.relativePath.startsWith("Contents/")
  )).length;
  if (observed.length !== expectedEntryCount) {
    throw new Error("Environment mode cache Contents exchange changed app topology");
  }
  for (const actual of observed) {
    const fromIncoming = actual.relativePath === "Contents" || actual.relativePath.startsWith("Contents/");
    const expected = (fromIncoming ? incomingByPath : stationaryByPath).get(actual.relativePath);
    if (expected === undefined
      || actual.type !== expected.type
      || actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.mode !== expected.mode
      || actual.symlinkTarget !== expected.symlinkTarget
      || (actual.type !== "directory" && actual.size !== expected.size)) {
      throw new Error(`Environment mode cache Contents exchange composition mismatch at ${actual.relativePath || "."}`);
    }
    if (actual.type !== "directory"
      && (actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs)) {
      throw new Error(`Environment mode cache Contents exchange changed non-directory metadata at ${actual.relativePath}`);
    }
  }
}

/**
 * Re-root the full logical content evidence with the exact same Contents
 * boundary used for the observed stat composition. This is deliberately a
 * metadata-only operation: the byte digests were sealed during preparation.
 */
function composeEnvironmentModeCacheAppContentSeal(
  incoming: EnvironmentModeCacheTreeStatSeal,
  stationaryOuter: EnvironmentModeCacheTreeStatSeal,
  observedEntries: readonly EnvironmentModeCacheStatSealRecord[],
): EnvironmentModeCacheContentSealRecord[] {
  const incomingByPath = new Map(incoming.contentEntries.map((entry) => [entry.relativePath, entry]));
  const stationaryByPath = new Map(stationaryOuter.contentEntries.map((entry) => [entry.relativePath, entry]));
  return observedEntries.map((observed) => {
    const fromIncoming = observed.relativePath === "Contents" || observed.relativePath.startsWith("Contents/");
    const selected = (fromIncoming ? incomingByPath : stationaryByPath).get(observed.relativePath);
    if (selected === undefined
      || selected.type !== observed.type
      || selected.mode !== observed.mode) {
      throw new Error(`Environment mode cache Contents exchange content composition mismatch at ${observed.relativePath || "."}`);
    }
    return selected;
  });
}

function assertContentsIdentity(
  identity: EnvironmentModeCacheContentsIdentity,
  expectedPath: string,
  expectedSeal: EnvironmentModeCacheStatSealRecord,
): void {
  if (identity.path !== expectedPath
    || identity.dev !== expectedSeal.dev
    || identity.ino !== expectedSeal.ino) {
    throw new Error(`Environment mode cache Contents identity does not match its prepared seal at ${expectedPath}`);
  }
}

function assertContentsIdentityMatches(
  observed: EnvironmentModeCacheContentsIdentity,
  expectedPath: string,
  prior: EnvironmentModeCacheContentsIdentity,
): void {
  if (observed.path !== expectedPath || observed.dev !== prior.dev || observed.ino !== prior.ino) {
    throw new Error(`Environment mode cache Contents inode role exchange was not proven at ${expectedPath}`);
  }
}

function assertOuterAppContinuity(
  before: EnvironmentModeCacheOuterAppEvidence,
  after: EnvironmentModeCacheOuterAppEvidence,
  expectedPath: string,
  expectedBeforeRoot: EnvironmentModeCacheStatSealRecord,
): void {
  if (before.path !== expectedPath || after.path !== expectedPath
    || !sameJson(before.stat, expectedBeforeRoot)
    || before.stat.relativePath !== ""
    || after.stat.relativePath !== ""
    || before.stat.type !== "directory"
    || after.stat.type !== "directory") {
    throw new Error(`Environment mode cache outer app evidence does not match its prepared seal at ${expectedPath}`);
  }
  if (before.stat.dev !== after.stat.dev
    || before.stat.ino !== after.stat.ino
    || before.stat.mode !== after.stat.mode
    || before.uid !== after.uid
    || before.gid !== after.gid
    || before.aclDigest !== after.aclDigest
    || before.xattrDigest !== after.xattrDigest
    || before.quarantineDigest !== after.quarantineDigest) {
    throw new Error(`Environment mode cache outer app continuity failed at ${expectedPath}`);
  }
  const actual = lstatSync(expectedPath, { bigint: true });
  const observed = environmentModeCacheStatSealRecord(expectedPath, "", "directory", actual);
  if (!sameJson(observed, after.stat)
    || actual.uid.toString() !== after.uid
    || actual.gid.toString() !== after.gid) {
    throw new Error(`Environment mode cache outer app evidence changed during Contents exchange at ${expectedPath}`);
  }
}

function readEnvironmentModeCacheContentsIdentity(path: string): EnvironmentModeCacheContentsIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Environment mode cache Contents path is not a real directory: ${path}`);
  }
  return { path, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function environmentModeCacheSealEntry(
  seal: EnvironmentModeCacheTreeStatSeal,
  relativePath: string,
): EnvironmentModeCacheStatSealRecord | null {
  return seal.entries.find((entry) => entry.relativePath === relativePath) ?? null;
}

function assertCurrentPreparedPair(receipt: EnvironmentModePairReceipt): void {
  if (receipt.pin.state !== "prepared" || receipt.pin.releasedAt !== null
    || receipt.supersession.supersededAt !== null || receipt.supersession.replacementGenerationId !== null) {
    throw new Error("Only a current prepared environment mode pair can be published");
  }
}

function withPublishedAt(receipt: EnvironmentModePairReceipt, publishedAt: string): EnvironmentModePairReceipt {
  return finalizeEnvironmentModePairReceipt({
    ...receipt,
    timestamps: { ...receipt.timestamps, publishedAt },
  });
}

function isEnvironmentModeCacheRoleState(value: unknown): value is EnvironmentModeCacheRoleState {
  return isRecord(value) && isEnvironmentModeCacheRole(value.live) && isEnvironmentModeCacheRole(value.inactive);
}

function isEnvironmentModeCacheRole(value: unknown): value is EnvironmentModeCacheRole {
  return isRecord(value)
    && (value.role === "live" || value.role === "inactive")
    && (value.experience === "chatgpt" || value.experience === "tweakers")
    && isCanonicalAbsolutePath(value.appPath)
    && isEnvironmentModeCacheAppEvidence(value.evidence);
}

function isEnvironmentModeCacheAppEvidence(value: unknown): value is EnvironmentModeCacheAppEvidence {
  return isRecord(value)
    && (value.bundleId === "com.openai.codex" || value.bundleId === "com.openai.codex.beta")
    && isNonEmptyString(value.version)
    && isNonEmptyString(value.build)
    && isSha256(value.appDigest)
    && isCanonicalAbsolutePath(value.asarPath)
    && isSha256(value.asarDigest)
    && isSha256(value.asarHeaderDigest)
    && isEnvironmentModeCacheSignatureEvidence(value.signature);
}

function isEnvironmentModeCacheSignatureEvidence(value: unknown): value is EnvironmentModeCacheSignatureEvidence {
  return isRecord(value)
    && typeof value.strict === "boolean"
    && typeof value.gatekeeper === "boolean"
    && (value.teamIdentifier === null || isNonEmptyString(value.teamIdentifier))
    && (value.designatedRequirement === null || isNonEmptyString(value.designatedRequirement))
    && isSha256(value.signatureDigest);
}

function isEnvironmentModeCacheTweakersProvenance(value: unknown): value is EnvironmentModeCacheTweakersProvenance {
  return isRecord(value)
    && isSha256(value.buildDigest)
    && isSha256(value.patchPayloadDigest)
    && isSha256(value.sourceControlDigest)
    && isEnvironmentModeCacheArtifactProvenance(value.runtime)
    && isEnvironmentModeCacheArtifactProvenance(value.managedRuntime)
    && isEnvironmentModeCacheBackendProvenance(value.backend)
    && isEnvironmentModeCacheNativeHostProvenance(value.nativeHost);
}

function isEnvironmentModeCacheArtifactProvenance(value: unknown): value is EnvironmentModeCacheArtifactProvenance {
  return isRecord(value)
    && isCanonicalAbsolutePath(value.rootPath)
    && isSha256(value.digest)
    && typeof value.fileCount === "number"
    && Number.isSafeInteger(value.fileCount)
    && value.fileCount >= 0
    && isSha256(value.provenanceDigest);
}

function isEnvironmentModeCacheBackendProvenance(value: unknown): value is EnvironmentModeCacheTweakersProvenance["backend"] {
  return isRecord(value)
    && isEnvironmentModeCacheArtifactProvenance(value)
    && (value.lane === "bundled" || value.lane === "managed-alpha")
    && isNonEmptyString(value.version);
}

function isEnvironmentModeCacheNativeHostProvenance(value: unknown): value is EnvironmentModeCacheTweakersProvenance["nativeHost"] {
  return isRecord(value)
    && isEnvironmentModeCacheArtifactProvenance(value)
    && isCanonicalAbsolutePath(value.executablePath);
}

function isEnvironmentModeCachePairSeals(value: unknown): value is EnvironmentModeCachePairSeals {
  return isRecord(value)
    && isEnvironmentModeCacheTreeStatSeal(value.liveApp)
    && isEnvironmentModeCacheTreeStatSeal(value.inactiveApp)
    && isEnvironmentModeCacheTreeStatSeal(value.runtime)
    && isEnvironmentModeCacheTreeStatSeal(value.managedRuntime);
}

function isEnvironmentModeCacheInvalidationEvidence(
  value: unknown,
): value is EnvironmentModeCacheInvalidationEvidence {
  return isRecord(value)
    && isEnvironmentModeCacheInvalidationSnapshot(value)
    && isSha256(value.receiptDigest);
}

function isEnvironmentModeCacheInvalidationSnapshot(
  value: unknown,
): value is EnvironmentModeCacheInvalidationSnapshot {
  if (!isRecord(value)
    || !isRecord(value.official)
    || !isRecord(value.tweakers)
    || !isRecord(value.environment)) return false;
  const official = value.official;
  const tweakers = value.tweakers;
  const environment = value.environment;
  return isNonEmptyString(official.version)
    && isNonEmptyString(official.build)
    && isSha256(official.trustDigest)
    && isSha256(official.signatureDigest)
    && isSha256(official.asarDigest)
    && isSha256(official.asarHeaderDigest)
    && isSha256(official.backendDigest)
    && isSha256(official.updaterDigest)
    && isSha256(tweakers.sourceDigest)
    && isSha256(tweakers.buildDigest)
    && isSha256(tweakers.patchPayloadDigest)
    && isSha256(tweakers.runtimeDigest)
    && isSha256(tweakers.managedRuntimeDigest)
    && isSha256(tweakers.backendDigest)
    && isSha256(tweakers.nativeHostDigest)
    && isSha256(environment.profileDigest)
    && isSha256(environment.pathsDigest)
    && isDecimalString(environment.contentsDevice)
    && isSha256(environment.statSealDigest)
    && isSha256(environment.mcpHelperDigest)
    && isSha256(environment.lifecycleJournalDigest);
}

function isEnvironmentModeCacheTimestamps(value: unknown): value is EnvironmentModeCacheTimestamps {
  return isRecord(value)
    && isIsoTimestamp(value.preparedAt)
    && isIsoTimestamp(value.validatedAt)
    && isNullableIsoTimestamp(value.publishedAt)
    && isNullableIsoTimestamp(value.lastSuccessfulSwitchAt)
    && isNullableIsoTimestamp(value.lastPreCutoverCancellationAt)
    && isNullableIsoTimestamp(value.terminalAt);
}

function isEnvironmentModeCachePin(value: unknown): value is EnvironmentModeCachePin {
  return isRecord(value)
    && (value.state === "prepared" || value.state === "post_cutover_recovery" || value.state === "stale_requires_prepare"
      || value.state === "cancelled" || value.state === "abandoned")
    && isIsoTimestamp(value.pinnedAt)
    && isNullableIsoTimestamp(value.releasedAt)
    && (value.releaseReason === null || value.releaseReason === "superseded" || value.releaseReason === "cancelled"
      || value.releaseReason === "invalidated" || value.releaseReason === "helper_failed" || value.releaseReason === "abandoned");
}

function isEnvironmentModeCacheSupersession(value: unknown): value is EnvironmentModeCacheSupersession {
  return isRecord(value)
    && isNullableIsoTimestamp(value.supersededAt)
    && (value.replacementGenerationId === null
      || (typeof value.replacementGenerationId === "string" && SAFE_GENERATION_ID.test(value.replacementGenerationId)));
}

function assertReceiptPathShape(value: EnvironmentModeCacheReceiptPaths): void {
  const keys: Array<keyof EnvironmentModeCacheReceiptPaths> = [
    "cacheRoot",
    "currentFile",
    "generationRoot",
    "receiptFile",
    "inactiveAppPath",
    "runtimeRoot",
    "managedRuntimeRoot",
  ];
  for (const key of keys) {
    const path = value[key];
    if (!isCanonicalAbsolutePath(path)) {
      throw new Error(`Environment mode pair receipt ${key} must be an exact canonical absolute path`);
    }
  }
}

function assertRoleEvidencePath(role: EnvironmentModeCacheRole): void {
  const expectedAsar = join(role.appPath, "Contents", "Resources", "app.asar");
  if (role.evidence.asarPath !== expectedAsar) {
    throw new Error(`Environment mode pair ${role.role} ASAR path must remain inside its exact app bundle`);
  }
}

/**
 * A schema-v2 ChatGPT role is always a pristine OpenAI trust claim, even when
 * it is currently the inactive target. Tweakers evidence stays intentionally
 * independent because it represents the patched role rather than the official
 * desktop receipt.
 */
function assertEnvironmentModeCacheChatgptRoleTrust(role: EnvironmentModeCacheRole): void {
  if (role.experience !== "chatgpt") return;
  const signature = role.evidence.signature;
  if (signature.strict !== true
    || signature.gatekeeper !== true
    || signature.teamIdentifier !== OPENAI_TEAM_IDENTIFIER
    || !isNonEmptyString(signature.designatedRequirement)) {
    throw new Error(`Environment mode pair ${role.role} ChatGPT role lacks strict OpenAI receipt trust`);
  }
}

function assertPinLifecycle(pin: EnvironmentModeCachePin, supersession: EnvironmentModeCacheSupersession): void {
  const active = pin.state === "prepared" || pin.state === "post_cutover_recovery";
  if (active && (pin.releasedAt !== null || pin.releaseReason !== null)) {
    throw new Error("Environment mode cache active pin has been released");
  }
  if (!active && (pin.releasedAt === null || pin.releaseReason === null)) {
    throw new Error("Environment mode cache terminal pin was not released");
  }
  const superseded = supersession.supersededAt !== null || supersession.replacementGenerationId !== null;
  if (superseded && (supersession.supersededAt === null || supersession.replacementGenerationId === null)) {
    throw new Error("Environment mode cache supersession must record both time and replacement generation");
  }
  if (pin.state === "stale_requires_prepare") {
    const supersededStale = superseded && pin.releaseReason === "superseded";
    // An invalidated grant can acquire a replacement link later. The link is
    // not its release cause, so preserve `invalidated` in either shape.
    const invalidatedStale = pin.releaseReason === "invalidated";
    if (!supersededStale && !invalidatedStale) {
      throw new Error("stale_requires_prepare must be an explicitly superseded or invalidated released pin");
    }
  }
  if (pin.state === "cancelled") {
    const directCancellation = pin.releaseReason === "cancelled" && !superseded;
    const invalidatedOrigin = pin.releaseReason === "invalidated";
    const supersededOrigin = superseded && pin.releaseReason === "superseded";
    // Retain readability for receipts produced before cancellation preserved
    // its origin. Those could only have been superseded under the old guard.
    const legacySupersededCancellation = superseded && pin.releaseReason === "cancelled";
    if (!directCancellation && !invalidatedOrigin && !supersededOrigin && !legacySupersededCancellation) {
      throw new Error("Cancelled environment mode pair must retain a stale release origin");
    }
  }
  if (pin.state === "post_cutover_recovery" && superseded) {
    throw new Error("Post-cutover recovery reachability cannot be superseded");
  }
}

function assertNoSymlinkInExistingPath(path: string, label: string): void {
  const exact = assertCanonicalAbsolutePath(path, label);
  const chain: string[] = [];
  let cursor = exact;
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Inspect every existing ancestor rather than only the nearest one. A
  // symlinked `generations/` or `next/` parent is just as unsafe as a
  // symlinked cache root.
  for (const entry of chain.reverse()) {
    if (!existsSync(entry)) continue;
    if (lstatSync(entry).isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${entry}`);
  }
}

function assertRealDirectory(path: string, label: string): void {
  assertNoSymlinkInExistingPath(path, label);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
}

function assertRegularFile(path: string, label: string): void {
  assertNoSymlinkInExistingPath(path, label);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

function assertContainedPath(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Environment mode pair receipt ${label} escapes its canonical cache root`);
  }
}

function assertCanonicalAbsolutePath(path: string, label: string): string {
  if (!isCanonicalAbsolutePath(path)) throw new Error(`${label} must be an exact canonical absolute path: ${path}`);
  return path;
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && resolve(value) === value;
}

function canonicalAbsolute(path: string): string {
  return assertCanonicalAbsolutePath(resolve(path), "canonical path");
}

/** Resolve existing aliases such as macOS `/var` before they become a durable receipt path. */
function canonicalPhysicalPath(path: string, label: string): string {
  const lexical = assertCanonicalAbsolutePath(path, label);
  let ancestor = lexical;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`${label} has no existing filesystem ancestor`);
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  const tail = relative(ancestor, lexical);
  return canonicalAbsolute(tail === "" ? canonicalAncestor : join(canonicalAncestor, tail));
}

function environmentModeCacheSealDigest(entries: readonly EnvironmentModeCacheStatSealRecord[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Deterministic logical tree digest used by complete preparation validation. */
function environmentModeCacheContentTreeDigest(
  entries: readonly EnvironmentModeCacheContentSealRecord[],
): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function environmentModeCachePayloadDigest(
  path: string,
  record: EnvironmentModeCacheStatSealRecord,
): string {
  if (record.type === "directory") return EMPTY_CONTENT_PAYLOAD_DIGEST;
  if (record.type === "symlink") return digestEnvironmentModeCachePayload(record.symlinkTarget ?? "");
  const hash = createHash("sha256");
  updateEnvironmentModeCacheContentHash(hash, path);
  return hash.digest("hex");
}

function digestEnvironmentModeCachePayload(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hash a potentially multi-gigabyte app artifact without materializing it in process memory. */
function updateEnvironmentModeCacheContentHash(hash: ReturnType<typeof createHash>, file: string): void {
  const fd = openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) return;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
}

function comparePathNames(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function unsupportedSealEntry(path: string): never {
  throw new Error(`Environment mode cache stat seal does not support special filesystem entry: ${path}`);
}

function isSafeSealRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (!isIsoTimestamp(value)) throw new Error(`${label} must be an ISO timestamp`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortCanonicalValue(value[key])]),
  );
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is unreadable at ${file}: ${errorMessage(error)}`);
  }
}

function readOptionalBytes(file: string, label: string): Buffer | null {
  if (!existsSync(file)) return null;
  assertRegularFile(file, label);
  return readFileSync(file);
}

function writeJsonAtomically(file: string, value: object): void {
  assertNoSymlinkInExistingPath(dirname(file), "environment mode cache receipt parent");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  assertRealDirectory(dirname(file), "environment mode cache receipt parent");
  const temporary = join(dirname(file), `.${basenameForTemporary(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    fsyncDirectory(dirname(file));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort for a temporary descriptor */ }
    }
    // This is only an unpromoted metadata temporary, never generation bytes.
    rmSync(temporary, { force: true });
  }
}

function restoreExactBytes(file: string, bytes: Buffer | null): void {
  if (bytes === null) {
    // Only metadata files written by this call may be absent after rollback.
    if (existsSync(file)) rmSync(file, { force: true });
    fsyncDirectory(dirname(file));
    return;
  }
  const temporary = join(dirname(file), `.${basenameForTemporary(file)}.${process.pid}.${Date.now()}.restore`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    fsyncDirectory(dirname(file));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort for a temporary descriptor */ }
    }
    rmSync(temporary, { force: true });
  }
}

function basenameForTemporary(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

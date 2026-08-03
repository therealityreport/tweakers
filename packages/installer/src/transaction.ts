import {
  chmodSync,
  cpSync,
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { signatureInfo } from "./codesign.js";
import { sweepMacOsJunk } from "./fs-copy.js";
import {
  acquireProcessLock,
  isLockHeldByLiveOwner,
  processAlive,
  readLockOwner,
} from "./process-lock.js";
import type {
  PrebuiltCombinedCandidateAuthority,
  PreparedPrebuiltCombinedCandidateEvidence,
} from "./prebuilt-combined-candidate.js";

export type HealthValue = "pass" | "fail" | "unknown";

/** Thirty seconds beyond the contained probe cap, while still rejecting old receipts. */
export const PRODUCTION_HEALTH_RECEIPT_MAX_AGE_MS = 200_000;
/** Narrow allowance for clock skew between the health-request writer and validator. */
export const HEALTH_TIMESTAMP_MAX_FUTURE_SKEW_MS = 5_000;

export interface AppFingerprint {
  version: string;
  build: string;
  hash: string;
}

export interface TransactionHealth {
  host: HealthValue;
  session: HealthValue;
  permissions: Record<string, HealthValue>;
  /** Present only when a schema-v2 promotion receipt was requested and verified. */
  promotionReady?: HealthValue;
}

export const PROMOTION_SURFACE_NAMES = [
  "app",
  "runtime",
  "tweakTree",
  "tweakersConfig",
  "codexConfig",
  "namespaceData",
  "mainStorage",
  "policy",
] as const;

export type PromotionSurfaceName = typeof PROMOTION_SURFACE_NAMES[number];

export interface PromotionSurfaceExpectation {
  preimageHash: string;
  afterHash: string;
}

export interface UserQuestionsPromotionExpectation {
  id: "co.tweakers.user-questions";
  version: string;
  payloadHash: string;
}

export interface LegacyProductionHealthExpectation {
  app: AppFingerprint;
  runtimeHash: string;
  requiredPermissions: string[];
}

export interface ProductionHealthExpectationV2 {
  schemaVersion: 2;
  app: AppFingerprint;
  requiredPermissions: string[];
  surfaces: Record<PromotionSurfaceName, PromotionSurfaceExpectation>;
  userQuestions: UserQuestionsPromotionExpectation;
}

export type ProductionHealthExpectation = LegacyProductionHealthExpectation | ProductionHealthExpectationV2;

export interface ProductionHealthReceiptV1 {
  schemaVersion: 1;
  observedAt: string;
  app: AppFingerprint;
  runtimeHash: string;
  hostReady: HealthValue;
  authenticatedSession: HealthValue;
  declaredPermissions: Record<string, HealthValue>;
}

export interface PromotionSurfaceObservation {
  preimageHash: string;
  expectedHash: string;
  observedHash: string;
  status: HealthValue;
}

export interface UserQuestionsPromotionObservation {
  expected: UserQuestionsPromotionExpectation;
  observed: UserQuestionsPromotionExpectation | null;
  identity: HealthValue;
  mainLifecycle: HealthValue;
  brokerSelfTest: HealthValue;
  schemaSelfTest: HealthValue;
  rendererStorageSelfTest: HealthValue;
  mcpConflictCount: number | null;
  zeroMcpConflicts: HealthValue;
}

export interface RendererPromotionProofObservation {
  capturedWindowCount: number;
  canonicalWebContentsId: number | null;
  canonicalUrl: string | null;
  queryKeys: string[];
  authorized: boolean;
  didFinishLoad: boolean;
  mounted: boolean;
  originalPreload: boolean;
  preloadFailed: boolean;
  loadFailed: boolean;
  rendererExited: boolean;
  cleanup: "pending" | "pass" | "fail";
  failureReason: string | null;
}

export interface ProductionHealthReceiptV2 {
  schemaVersion: 2;
  observedAt: string;
  app: AppFingerprint;
  hostReady: HealthValue;
  rendererProof: RendererPromotionProofObservation;
  authenticatedSession: HealthValue;
  declaredPermissions: Record<string, HealthValue>;
  surfaces: Record<PromotionSurfaceName, PromotionSurfaceObservation>;
  userQuestions: UserQuestionsPromotionObservation;
  promotionReady: HealthValue;
}

export type ProductionHealthReceipt = ProductionHealthReceiptV1 | ProductionHealthReceiptV2;

export interface NativeHealthProbeAdapter {
  probeHostReady(): HealthValue | Promise<HealthValue>;
  probeAuthenticatedSession(): HealthValue | Promise<HealthValue>;
  probeDeclaredPermission(permission: string): HealthValue | Promise<HealthValue>;
}

export type TransactionPhase =
  | "buildingCandidate"
  | "validatingCandidate"
  | "pendingPromotion"
  | "promoting"
  | "checkingHealth"
  | "healthy"
  | "invalidated"
  | "rollingBack"
  | "degraded";

export interface TransactionState {
  schemaVersion: 1;
  appRoot: string;
  runtimeRoot: string;
  source: AppFingerprint;
  /** Hash of the installer code, loader, runtime, and bundled assets used to build the candidate. */
  payloadHash?: string;
  candidateRoot: string;
  pristineRoot: string;
  lastKnownGoodRoot: string;
  lastKnownGoodRuntimeRoot: string;
  phase: TransactionPhase;
  createdAt: string;
  updatedAt: string;
  pendingReason?: string;
  /** PID of the process that last mutated this transaction; used to distinguish a crashed owner from one still running. */
  ownerPid?: number;
  rollbackAttempted: boolean;
  rollbackResult?: "succeeded" | "failed";
  failure?: string;
  failureCount?: number;
  lastFailureAt?: string;
  signingMode?: "local-identity" | "adhoc";
  /**
   * Private receipt-bound authority for a prebuilt backend plus reviewed
   * Tweakers runtime. The payload identity and transaction ID must be supplied
   * unchanged by both candidate preparation and the later promotion call.
   */
  prebuiltCombinedCandidate?: {
    authority: PrebuiltCombinedCandidateAuthority;
    prepared?: PreparedPrebuiltCombinedCandidateEvidence;
    supersededTransactionArchive?: string;
  };
}

export interface TransactionOptions {
  appRoot: string;
  runtimeRoot: string;
  workRoot: string;
  stateFile: string;
  source: AppFingerprint;
  /** Rebuilds a held candidate whenever its patch payload changes, even if the official app did not. */
  payloadHash?: string;
  requiredPermissions: string[];
  /** Real promotion entrypoints require the complete schema-v2 surface/User Questions proof. */
  requirePromotionHealthV2?: boolean;
  candidateOnly?: boolean;
  candidateOnlyReason?: "explicit" | "baseline-health-unavailable" | "coordinated-refresh";
  maxCandidateAgeMs?: number;
  now?: Date;
  signingMode?: "local-identity" | "adhoc";
  prebuiltCombinedCandidate?: PrebuiltCombinedCandidateAuthority;
  /** Promotion-only entrypoints must consume an exact held candidate and may never rebuild. */
  requirePreparedCandidate?: boolean;
}

export interface PreparedPrebuiltCandidateValidationContext {
  now: Date;
  maxCandidateAgeMs: number;
}

export interface TransactionAdapters {
  isAppRunning(appRoot: string): boolean | Promise<boolean>;
  copyApp(source: string, destination: string): void | Promise<void>;
  removeApp(path: string): void | Promise<void>;
  buildCandidate(pristineRoot: string, candidateRoot: string): void | Promise<void>;
  validateCandidate(candidateRoot: string): boolean | void | Promise<boolean | void>;
  probeCandidateHealth(input: { candidateRoot: string; requiredPermissions: string[] }): TransactionHealth | Promise<TransactionHealth>;
  fingerprintApp(appRoot: string): AppFingerprint | Promise<AppFingerprint>;
  isAppComplete(appRoot: string): boolean | Promise<boolean>;
  snapshotRuntime(runtimeRoot: string, destination: string): void | Promise<void>;
  promoteCandidate(candidateRoot: string, appRoot: string): void | Promise<void>;
  restoreApp(lastKnownGoodRoot: string, appRoot: string): void | Promise<void>;
  restoreRuntime(lastKnownGoodRuntimeRoot: string, runtimeRoot: string): void | Promise<void>;
  /**
   * Validates the app restored from last-known-good. The snapshot may be a
   * pristine (unpatched) app — e.g. right after an official Codex update — so
   * this must NOT require the Tweakers patch marker. Falls back to
   * validateCandidate when absent (legacy behavior).
   */
  validateRestoredApp?(appRoot: string): boolean | void | Promise<boolean | void>;
  probeHealth(input: {
    appRoot: string;
    requiredPermissions: string[];
  }): TransactionHealth | Promise<TransactionHealth>;
  /** Runs only after health passes, before the transaction is marked healthy. */
  acceptPromotion?(health: TransactionHealth): void | Promise<void>;
  /** Unwinds sidecar/config/snapshot work when promotion or acceptance fails. */
  rollbackPromotion?(): void | Promise<void>;
  openApp(appRoot: string): void | Promise<void>;
  /** Re-probes the receipt, source binary/runtime, and source app under the app-install lock. */
  validatePrebuiltCombinedCandidateAuthority?(
    authority: PrebuiltCombinedCandidateAuthority,
  ): void | Promise<void>;
  /** Proves rollback roots before a stale pending authority can be superseded. */
  validatePrebuiltRollbackRoots?(state: TransactionState): void | Promise<void>;
  /** Removes only stale candidate/pristine/private build artifacts after strict archival. */
  removeSupersededPrebuiltCandidateArtifacts?(state: TransactionState): void | Promise<void>;
  /** Captures candidate/backend/runtime/rollback evidence after candidate health passes. */
  capturePreparedPrebuiltCombinedCandidateEvidence?(
    state: TransactionState,
  ): PreparedPrebuiltCombinedCandidateEvidence | Promise<PreparedPrebuiltCombinedCandidateEvidence>;
  /** Re-probes the persisted candidate and rollback evidence before any later cutover. */
  validatePreparedPrebuiltCombinedCandidateEvidence?(
    state: TransactionState,
    context: PreparedPrebuiltCandidateValidationContext,
  ): void | Promise<void>;
}

export interface TransactionResult {
  status: "candidate-ready" | "held" | "promoted" | "invalidated" | "rolled-back" | "blocked";
  state: TransactionState;
}

const DEFAULT_MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_INVALIDATED_RETRIES = 2;
const INVALIDATED_RETRY_BACKOFF_MS = (failureCount: number): number =>
  Math.min(2 ** failureCount * 60_000, 30 * 60_000);

export interface SweepStaleTempDirsDeps {
  readdir?: (dir: string) => string[];
  entryMtimeMs?: (path: string) => number;
  isProcessAlive?: (pid: number) => boolean;
  removeDir?: (path: string) => void;
  now?: number;
  maxAgeMs?: number;
}

const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// <dest>.tweakers-{replacement,previous,incoming}-<pid>
const SUFFIX_TEMP_RE = /\.tweakers-(?:replacement|previous|incoming)-(\d+)$/;
// .next-<pid> / .previous-<pid>
const DOT_TEMP_RE = /^\.(?:next|previous)-(\d+)$/;

export function installTransactionSweepDirectories(
  options: Pick<TransactionOptions, "appRoot" | "runtimeRoot" | "workRoot" | "candidateOnly" | "signingMode">,
): string[] {
  const directories = [dirname(resolve(options.runtimeRoot)), resolve(options.workRoot)];
  if (!options.candidateOnly && options.signingMode !== "adhoc") {
    directories.unshift(dirname(resolve(options.appRoot)));
  }
  return [...new Set(directories)];
}

/**
 * Best-effort sweep of interrupted-run temp dirs: remove entries whose owning
 * PID is dead AND whose mtime is older than maxAgeMs. Never throws; a missing
 * directory or unreadable entry is skipped. Returns the removed paths.
 */
export function sweepStaleTempDirs(directories: string[], deps: SweepStaleTempDirsDeps = {}): string[] {
  const readdir = deps.readdir ?? ((dir: string) => readdirSync(dir));
  const entryMtimeMs = deps.entryMtimeMs ?? ((path: string) => statSync(path).mtimeMs);
  const isAlive = deps.isProcessAlive ?? processAlive;
  const removeDir = deps.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const now = deps.now ?? Date.now();
  const maxAgeMs = deps.maxAgeMs ?? STALE_TEMP_MAX_AGE_MS;
  const removed: string[] = [];
  for (const directory of new Set(directories.map((d) => resolve(d)))) {
    let names: string[];
    try { names = readdir(directory); } catch { continue; }
    for (const name of names) {
      const match = SUFFIX_TEMP_RE.exec(name) ?? DOT_TEMP_RE.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (isAlive(pid)) continue;
      const full = join(directory, name);
      let mtime: number;
      try { mtime = entryMtimeMs(full); } catch { continue; }
      if (now - mtime <= maxAgeMs) continue;
      try { removeDir(full); removed.push(full); } catch { /* best-effort */ }
    }
  }
  return removed;
}

export interface CloneAppTreeDeps {
  execFileSync?: typeof execFileSync;
  copyDir?: (source: string, destination: string) => void;
  removeDir?: (path: string) => void;
  platform?: () => NodeJS.Platform;
}

/**
 * Copy an app bundle preferring APFS clonefile (`cp -Rc`) — a near-instant
 * copy-on-write clone on the same volume. Falls back to a byte copy (cpSync,
 * preserving symlinks + mode bits) when clonefile is unavailable (non-darwin,
 * cross-volume EXDEV/ENOTSUP, or any cp failure). clonefile preserves
 * symlinks, mode bits, and xattrs; the fallback preserves symlinks + mode.
 */
export function cloneAppTree(source: string, destination: string, deps: CloneAppTreeDeps = {}): void {
  const exec = deps.execFileSync ?? execFileSync;
  const currentPlatform = (deps.platform ?? platform)();
  const removeDir = deps.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const copyDir = deps.copyDir ?? ((from: string, to: string) => cpSync(from, to, { recursive: true, verbatimSymlinks: true }));
  removeDir(destination);
  mkdirSync(dirname(destination), { recursive: true });
  if (currentPlatform === "darwin") {
    try {
      // -R recurse, -c clonefile, -p preserve attributes.
      exec("cp", ["-Rcp", source, destination], { stdio: "ignore" });
      // Finder junk cloned from a browsed source bundle must not enter a
      // receipt-owned artifact: its digest becomes durable evidence, and
      // Apple's sealed-resource rules omit .DS_Store, so removal can never
      // invalidate a signature.
      sweepMacOsJunk(destination);
      return;
    } catch {
      // clonefile unavailable / cross-volume — fall back to a byte copy.
      removeDir(destination);
    }
  }
  copyDir(source, destination);
  sweepMacOsJunk(destination);
}

/**
 * Build, hold, promote, and verify an installer candidate without ever owning a
 * quit or prompt capability. A running application can only produce `held`.
 */
export async function runInstallTransaction(
  options: TransactionOptions,
  adapters: TransactionAdapters,
): Promise<TransactionResult> {
  assertSafeTransactionPaths(options);
  const lock = acquireTransactionLock(transactionLockFile(options.stateFile));
  try {
    return await runLockedInstallTransaction(options, adapters);
  } finally {
    lock.release();
  }
}

async function runLockedInstallTransaction(
  options: TransactionOptions,
  adapters: TransactionAdapters,
): Promise<TransactionResult> {
  const now = options.now ?? new Date();
  const existing = readTransactionState(options.stateFile);
  const requestedPrebuilt = options.prebuiltCombinedCandidate;
  if (requestedPrebuilt) {
    if (options.payloadHash !== requestedPrebuilt.payloadIdentity) {
      throw new Error("Prebuilt combined candidate payload identity is not bound to the installer transaction");
    }
    if (!adapters.validatePrebuiltCombinedCandidateAuthority) {
      throw new Error("Prebuilt combined candidate authority validator is unavailable");
    }
    if (!options.candidateOnly && !options.requirePreparedCandidate) {
      throw new Error("Prebuilt combined candidates require an explicit prepare or promotion-only action");
    }
    try {
      await adapters.validatePrebuiltCombinedCandidateAuthority(requestedPrebuilt);
    } catch (error) {
      if (
        existing?.phase === "pendingPromotion"
        && samePayload(existing.payloadHash, options.payloadHash)
        && samePrebuiltCombinedCandidate(existing, requestedPrebuilt)
      ) {
        return invalidatePreparedPrebuiltCandidate(options, adapters, existing, now, {
          pendingReason: "candidate-evidence-drift",
          failure: `prepared combined candidate evidence drifted: ${errorMessage(error)}`,
        });
      }
      throw error;
    }
  } else if (options.requirePreparedCandidate) {
    throw new Error("Prepared-candidate-only promotion requires prebuilt combined candidate authority");
  }
  try {
    sweepStaleTempDirs(installTransactionSweepDirectories(options));
  } catch { /* best-effort startup sweep */ }

  if (
    existing?.phase === "healthy" &&
    sameFingerprint(existing.source, options.source) &&
    samePayload(existing.payloadHash, options.payloadHash) &&
    samePrebuiltCombinedCandidate(existing, requestedPrebuilt)
  ) {
    return { status: "promoted", state: existing };
  }

  if (
    options.requirePreparedCandidate
    && !(
      existing?.phase === "pendingPromotion"
      && samePayload(existing.payloadHash, options.payloadHash)
      && samePrebuiltCombinedCandidate(existing, requestedPrebuilt)
      && candidateIntentMatches(existing, options)
      && existing.prebuiltCombinedCandidate?.prepared
    )
  ) {
    throw new Error(
      "No exact receipt-bound prepared candidate exists for this transaction; promotion will not rebuild",
    );
  }

  let supersededTransactionArchive: string | undefined;
  if (existing?.phase === "degraded" && existing.rollbackAttempted) {
    // A degraded transaction blocks retries of the SAME source to prevent a
    // promote → fail → rollback → promote loop. A different source (e.g. the
    // next official Codex update) is a fresh situation: archive the stale
    // record and start over instead of blocking forever.
    if (sameFingerprint(existing.source, options.source) && samePayload(existing.payloadHash, options.payloadHash)) {
      return { status: "blocked", state: existing };
    }
    archiveTransactionState(options.stateFile, existing);
  } else if (existing?.phase === "invalidated") {
    if (sameFingerprint(existing.source, options.source) && samePayload(existing.payloadHash, options.payloadHash)) {
      const failureCount = existing.failureCount ?? 0;
      if (failureCount >= MAX_INVALIDATED_RETRIES) {
        return { status: "invalidated", state: existing };
      }
      const lastFailureAt = Date.parse(existing.lastFailureAt ?? "");
      const lastFailureAge = now.getTime() - lastFailureAt;
      if (
        requestedPrebuilt
        && (!Number.isFinite(lastFailureAt) || !Number.isFinite(lastFailureAge) || lastFailureAge < 0)
      ) {
        return { status: "invalidated", state: existing };
      }
      if (
        Number.isFinite(lastFailureAt) &&
        now.getTime() < lastFailureAt + INVALIDATED_RETRY_BACKOFF_MS(failureCount)
      ) {
        return { status: "invalidated", state: existing };
      }
    } else {
      archiveTransactionState(options.stateFile, existing);
    }
  } else if (existing?.phase === "pendingPromotion") {
    if (
      samePayload(existing.payloadHash, options.payloadHash) &&
      samePrebuiltCombinedCandidate(existing, requestedPrebuilt) &&
      candidateIntentMatches(existing, options)
    ) {
      return continuePendingPromotion(options, adapters, existing, now);
    }
    if (requestedPrebuilt) {
      if (
        !adapters.validatePrebuiltRollbackRoots
        || !adapters.removeSupersededPrebuiltCandidateArtifacts
      ) {
        throw new Error("Prebuilt stale-candidate reconciliation adapters are unavailable");
      }
      await adapters.validatePrebuiltRollbackRoots(existing);
      const archived = archiveTransactionState(options.stateFile, existing);
      if (archived === null) {
        throw new Error("Stale pending-promotion receipt could not be archived; authority was preserved");
      }
      supersededTransactionArchive = archived;
      await adapters.removeSupersededPrebuiltCandidateArtifacts(existing);
    } else {
      await adapters.removeApp(existing.candidateRoot);
      const sameInstallerPayload = samePayload(existing.payloadHash, options.payloadHash);
      existing.pendingReason = sameInstallerPayload
        ? "candidate-intent-drift"
        : "installer-payload-drift";
      existing.failure = sameInstallerPayload
        ? "candidate promotion intent changed after the candidate was built"
        : "installer payload changed after the candidate was built";
      invalidateTransactionState(options.stateFile, existing, now);
    }
  } else if (existing && phaseMayHaveMutatedLiveApp(existing.phase)) {
    // The lock proves no live owner holds this transaction, but a state file
    // written by a still-running legacy (pre-lock) process must not be treated
    // as a crash: recovery would fight its in-flight promotion.
    if (existing.ownerPid !== undefined && existing.ownerPid !== process.pid && processAlive(existing.ownerPid)) {
      return { status: "held", state: existing };
    }
    return recoverInterruptedPromotion(options, adapters, existing, now);
  }

  const paths = transactionPaths(options.workRoot);
  const state: TransactionState = {
    schemaVersion: 1,
    appRoot: resolve(options.appRoot),
    runtimeRoot: resolve(options.runtimeRoot),
    source: options.source,
    payloadHash: options.payloadHash,
    candidateRoot: paths.candidateRoot,
    pristineRoot: paths.pristineRoot,
    lastKnownGoodRoot: paths.lastKnownGoodRoot,
    lastKnownGoodRuntimeRoot: paths.lastKnownGoodRuntimeRoot,
    phase: "buildingCandidate",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    rollbackAttempted: false,
    signingMode: options.signingMode,
    ...(requestedPrebuilt ? {
      prebuiltCombinedCandidate: {
        authority: requestedPrebuilt,
        ...(supersededTransactionArchive ? { supersededTransactionArchive } : {}),
      },
    } : {}),
  };
  writeTransactionState(options.stateFile, state);

  await adapters.removeApp(paths.candidateRoot);
  await adapters.removeApp(paths.pristineRoot);
  await adapters.copyApp(options.appRoot, paths.pristineRoot);

  // The build input is always an isolated pristine copy, never the live app.
  await adapters.copyApp(paths.pristineRoot, paths.candidateRoot);
  try {
    await adapters.buildCandidate(paths.pristineRoot, paths.candidateRoot);
  } catch (error) {
    await adapters.removeApp(paths.candidateRoot);
    state.failure = errorMessage(error);
    invalidateTransactionState(options.stateFile, state, now, existing);
    throw error;
  }

  updateState(options.stateFile, state, "validatingCandidate", now);
  let validationFailure: string | null = null;
  try {
    const valid = await adapters.validateCandidate(paths.candidateRoot);
    if (valid === false) validationFailure = "candidate validator returned false without a reason";
  } catch (error) {
    validationFailure = errorMessage(error);
  }
  if (validationFailure !== null) {
    await adapters.removeApp(paths.candidateRoot);
    state.failure = validationFailure;
    invalidateTransactionState(options.stateFile, state, now, existing);
    return { status: "invalidated", state };
  }

  if (options.candidateOnly || options.signingMode === "adhoc") {
    const candidateFailure = healthFailure(await adapters.probeCandidateHealth({
      candidateRoot: state.candidateRoot,
      requiredPermissions: [...options.requiredPermissions],
    }), options.requiredPermissions, options.requirePromotionHealthV2 === true);
    if (candidateFailure) {
      await adapters.removeApp(state.candidateRoot);
      state.failure = `candidate health: ${candidateFailure}`;
      invalidateTransactionState(options.stateFile, state, now, existing);
      return { status: "invalidated", state };
    }
    if (requestedPrebuilt) {
      if (!adapters.capturePreparedPrebuiltCombinedCandidateEvidence) {
        throw new Error("Prebuilt prepared-candidate evidence adapter is unavailable");
      }
      state.prebuiltCombinedCandidate!.prepared =
        await adapters.capturePreparedPrebuiltCombinedCandidateEvidence(state);
    }
    state.phase = "pendingPromotion";
    state.pendingReason = options.signingMode === "adhoc"
      ? "adhoc-never-promotes"
      : options.candidateOnlyReason === "baseline-health-unavailable"
        ? "baseline-health-unavailable"
        : options.candidateOnlyReason === "coordinated-refresh"
          ? "coordinated-refresh"
        : "explicit-candidate-only";
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
    return { status: "candidate-ready", state };
  }

  if (await adapters.isAppRunning(options.appRoot)) {
    state.phase = "pendingPromotion";
    state.pendingReason = "app-running";
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
    return { status: "held", state };
  }

  const candidateFailure = healthFailure(await adapters.probeCandidateHealth({
    candidateRoot: state.candidateRoot,
    requiredPermissions: [...options.requiredPermissions],
  }), options.requiredPermissions, options.requirePromotionHealthV2 === true);
  if (candidateFailure) {
    await adapters.removeApp(state.candidateRoot);
    state.failure = `candidate health: ${candidateFailure}`;
    invalidateTransactionState(options.stateFile, state, now, existing);
    return { status: "invalidated", state };
  }

  return promoteAndVerify(options, adapters, state, now);
}

async function invalidatePreparedPrebuiltCandidate(
  options: TransactionOptions,
  adapters: TransactionAdapters,
  state: TransactionState,
  now: Date,
  reason: { pendingReason: string; failure: string },
): Promise<TransactionResult> {
  state.pendingReason = reason.pendingReason;
  state.failure = reason.failure;
  invalidateTransactionState(options.stateFile, state, now);
  try {
    await adapters.validatePrebuiltRollbackRoots?.(state);
    await adapters.removeSupersededPrebuiltCandidateArtifacts?.(state);
  } catch (cleanupError) {
    state.failure = `${state.failure}; candidate cleanup: ${errorMessage(cleanupError)}`;
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
  }
  return { status: "invalidated", state };
}

async function recoverInterruptedPromotion(
  options: TransactionOptions,
  adapters: TransactionAdapters,
  state: TransactionState,
  now: Date,
): Promise<TransactionResult> {
  if (state.rollbackAttempted) {
    state.phase = "degraded";
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
    return { status: "blocked", state };
  }
  const interruptedPhase = state.phase;
  state.phase = "rollingBack";
  state.rollbackAttempted = true;
  state.failure = `interrupted during ${interruptedPhase}`;
  state.updatedAt = now.toISOString();
  writeTransactionState(options.stateFile, state);
  try {
    const rollbackErrors: string[] = [];
    try { await adapters.rollbackPromotion?.(); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try { await adapters.restoreApp(state.lastKnownGoodRoot, options.appRoot); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try { await adapters.restoreRuntime(state.lastKnownGoodRuntimeRoot, options.runtimeRoot); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try {
      const validate = adapters.validateRestoredApp ?? adapters.validateCandidate;
      const valid = await validate(options.appRoot);
      if (valid === false) throw new Error("Restored app validation failed");
    } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try { await adapters.openApp(options.appRoot); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    if (rollbackErrors.length > 0) throw new Error(rollbackErrors.join("; "));
    state.rollbackResult = "succeeded";
  } catch (error) {
    state.rollbackResult = "failed";
    state.failure = `${state.failure}; rollback: ${errorMessage(error)}`;
  }
  state.phase = "degraded";
  state.updatedAt = now.toISOString();
  writeTransactionState(options.stateFile, state);
  return { status: "rolled-back", state };
}

async function continuePendingPromotion(
  options: TransactionOptions,
  adapters: TransactionAdapters,
  state: TransactionState,
  now: Date,
): Promise<TransactionResult> {
  if (options.prebuiltCombinedCandidate) {
    if (
      !state.prebuiltCombinedCandidate?.prepared
      || !adapters.validatePreparedPrebuiltCombinedCandidateEvidence
    ) {
      throw new Error("Prepared prebuilt combined candidate evidence is unavailable");
    }
    try {
      await adapters.validatePreparedPrebuiltCombinedCandidateEvidence(state, {
        now,
        maxCandidateAgeMs: options.maxCandidateAgeMs ?? DEFAULT_MAX_CANDIDATE_AGE_MS,
      });
    } catch (error) {
      return invalidatePreparedPrebuiltCandidate(options, adapters, state, now, {
        pendingReason: "candidate-evidence-drift",
        failure: `prepared combined candidate evidence drifted: ${errorMessage(error)}`,
      });
    }
  }

  const createdAt = Date.parse(state.createdAt);
  const age = now.getTime() - createdAt;
  const maxAge = options.maxCandidateAgeMs ?? DEFAULT_MAX_CANDIDATE_AGE_MS;
  const expired =
    !Number.isFinite(createdAt)
    || !Number.isFinite(age)
    || !Number.isFinite(maxAge)
    || maxAge < 0
    || age < 0
    || age > maxAge;
  if (expired && options.prebuiltCombinedCandidate) {
    return invalidatePreparedPrebuiltCandidate(options, adapters, state, now, {
      pendingReason: "candidate-expired",
      failure: "candidate expired before promotion (a newer app landed first)",
    });
  }

  if (
    options.candidateOnly ||
    state.signingMode === "adhoc" ||
    state.pendingReason === "adhoc-never-promotes" ||
    state.pendingReason === "explicit-candidate-only"
  ) {
    return { status: "candidate-ready", state };
  }

  if (expired) {
    await adapters.removeApp(state.candidateRoot);
    state.pendingReason = "candidate-expired";
    state.failure = "candidate expired before promotion (a newer app landed first)";
    invalidateTransactionState(options.stateFile, state, now);
    return { status: "invalidated", state };
  }

  const live = await adapters.fingerprintApp(options.appRoot);
  if (!sameFingerprint(live, state.source) || !sameFingerprint(options.source, state.source)) {
    if (!await adapters.isAppComplete(options.appRoot)) {
      state.pendingReason = "live-app-incomplete";
      state.failure = "official Codex update still in progress; live app signature is incomplete";
      state.updatedAt = now.toISOString();
      writeTransactionState(options.stateFile, state);
      return { status: "held", state };
    }

    // A complete official update is a new build input, not a failed candidate.
    // Archive the stale record and rebuild while retaining this transaction lock.
    archiveTransactionState(options.stateFile, state);
    return runLockedInstallTransaction({ ...options, source: live }, adapters);
  }

  if (await adapters.isAppRunning(options.appRoot)) {
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
    return { status: "held", state };
  }

  const candidateFailure = healthFailure(await adapters.probeCandidateHealth({
    candidateRoot: state.candidateRoot,
    requiredPermissions: [...options.requiredPermissions],
  }), options.requiredPermissions, options.requirePromotionHealthV2 === true);
  if (candidateFailure) {
    await adapters.removeApp(state.candidateRoot);
    state.failure = `candidate health: ${candidateFailure}`;
    invalidateTransactionState(options.stateFile, state, now);
    return { status: "invalidated", state };
  }

  return promoteAndVerify(options, adapters, state, now);
}

export function readProductionHealthReceipt(
  receiptFile: string,
  expected: ProductionHealthExpectation,
  options: { now?: Date; maxAgeMs?: number; maxBytes?: number } = {},
): TransactionHealth {
  const v2Expected = isV2HealthExpectation(expected);
  const unknown = unknownHealth(expected.requiredPermissions, v2Expected);
  try {
    const stat = lstatSync(receiptFile);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > (options.maxBytes ?? 256 * 1024)
    ) return unknown;
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as unknown;
    if (!plainRecord(receipt) || !sameFingerprintValue(receipt.app, expected.app)) return unknown;
    const now = (options.now ?? new Date()).getTime();
    const observedAt = Date.parse(typeof receipt.observedAt === "string" ? receipt.observedAt : "");
    if (
      !Number.isFinite(observedAt)
      || observedAt > now + HEALTH_TIMESTAMP_MAX_FUTURE_SKEW_MS
      || now - observedAt > (options.maxAgeMs ?? PRODUCTION_HEALTH_RECEIPT_MAX_AGE_MS)
    ) return unknown;
    if (v2Expected) return readV2HealthReceipt(receipt, expected, unknown);
    if (!validLegacyHealthReceipt(receipt, expected)) return unknown;
    return {
      host: validHealthValue(receipt.hostReady),
      session: validHealthValue(receipt.authenticatedSession),
      permissions: Object.fromEntries(expected.requiredPermissions.map((permission) => [
        permission,
        validHealthValue(receipt.declaredPermissions?.[permission]),
      ])),
    };
  } catch {
    return unknown;
  }
}

export async function probeNativeHealth(
  adapter: NativeHealthProbeAdapter,
  requiredPermissions: string[],
): Promise<TransactionHealth> {
  const safeProbe = async (probe: () => HealthValue | Promise<HealthValue>): Promise<HealthValue> => {
    try {
      return validHealthValue(await probe());
    } catch {
      return "unknown";
    }
  };
  return {
    host: await safeProbe(() => adapter.probeHostReady()),
    session: await safeProbe(() => adapter.probeAuthenticatedSession()),
    permissions: Object.fromEntries(await Promise.all(requiredPermissions.map(async (permission) => [
      permission,
      await safeProbe(() => adapter.probeDeclaredPermission(permission)),
    ]))),
  };
}

/** Atomically publish a fail-safe observation from the native probe surface. */
export async function generateProductionHealthReceipt(
  receiptFile: string,
  expected: LegacyProductionHealthExpectation,
  adapter: NativeHealthProbeAdapter,
  options: { now?: Date } = {},
): Promise<TransactionHealth> {
  const health = await probeNativeHealth(adapter, expected.requiredPermissions);
  writeProductionHealthReceipt(receiptFile, {
    schemaVersion: 1,
    observedAt: (options.now ?? new Date()).toISOString(),
    app: { ...expected.app },
    runtimeHash: expected.runtimeHash,
    hostReady: health.host,
    authenticatedSession: health.session,
    declaredPermissions: Object.fromEntries(expected.requiredPermissions.map((permission) => [
      permission,
      health.permissions[permission] ?? "unknown",
    ])),
  });
  return health;
}

export function writeProductionHealthReceipt(receiptFile: string, receipt: ProductionHealthReceipt): void {
  const directory = dirname(receiptFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${process.pid}.${Date.now()}.promotion.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, receiptFile);
    chmodSync(receiptFile, 0o600);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
    throw error;
  }
}

async function promoteAndVerify(
  options: TransactionOptions,
  adapters: TransactionAdapters,
  state: TransactionState,
  now: Date,
): Promise<TransactionResult> {
  // Recheck immediately before any live mutation to close the watcher race.
  if (await adapters.isAppRunning(options.appRoot)) {
    state.phase = "pendingPromotion";
    state.pendingReason = "app-running";
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
    return { status: "held", state };
  }
  if (options.prebuiltCombinedCandidate) {
    if (!adapters.validatePreparedPrebuiltCombinedCandidateEvidence) {
      throw new Error("Prepared prebuilt combined candidate revalidation is unavailable");
    }
    try {
      await adapters.validatePreparedPrebuiltCombinedCandidateEvidence(state, {
        now,
        maxCandidateAgeMs: options.maxCandidateAgeMs ?? DEFAULT_MAX_CANDIDATE_AGE_MS,
      });
    } catch (error) {
      return invalidatePreparedPrebuiltCandidate(options, adapters, state, now, {
        pendingReason: "candidate-evidence-drift",
        failure: `prepared combined candidate evidence drifted: ${errorMessage(error)}`,
      });
    }
  }

  updateState(options.stateFile, state, "promoting", now);
  await adapters.removeApp(state.lastKnownGoodRoot);
  await adapters.copyApp(options.appRoot, state.lastKnownGoodRoot);
  await adapters.removeApp(state.lastKnownGoodRuntimeRoot);
  await adapters.snapshotRuntime(options.runtimeRoot, state.lastKnownGoodRuntimeRoot);
  if (options.prebuiltCombinedCandidate) {
    if (!adapters.capturePreparedPrebuiltCombinedCandidateEvidence) {
      throw new Error("Prebuilt rollback snapshot evidence adapter is unavailable");
    }
    state.prebuiltCombinedCandidate!.prepared =
      await adapters.capturePreparedPrebuiltCombinedCandidateEvidence(state);
    writeTransactionState(options.stateFile, state);
  }
  await adapters.promoteCandidate(state.candidateRoot, options.appRoot);

  updateState(options.stateFile, state, "checkingHealth", now);
  await adapters.openApp(options.appRoot);
  let health: TransactionHealth;
  try {
    health = await adapters.probeHealth({
      appRoot: options.appRoot,
      requiredPermissions: [...options.requiredPermissions],
    });
  } catch (error) {
    health = {
      host: "unknown",
      session: "unknown",
      permissions: Object.fromEntries(options.requiredPermissions.map((permission) => [permission, "unknown"])),
    };
    state.failure = errorMessage(error);
  }

  let failure = healthFailure(
    health,
    options.requiredPermissions,
    options.requirePromotionHealthV2 === true,
  );
  if (!failure) {
    try {
      await adapters.acceptPromotion?.(health);
    } catch (error) {
      failure = `promotion acceptance: ${errorMessage(error)}`;
    }
  }
  if (!failure) {
    state.phase = "healthy";
    state.pendingReason = undefined;
    state.updatedAt = now.toISOString();
    writeTransactionState(options.stateFile, state);
    // GC the build inputs; only the last-known-good copy is needed for rollback.
    try { await adapters.removeApp(state.pristineRoot); } catch { /* best-effort */ }
    try { await adapters.removeApp(state.candidateRoot); } catch { /* best-effort */ }
    return { status: "promoted", state };
  }

  state.phase = "rollingBack";
  state.rollbackAttempted = true;
  state.failure = state.failure ?? failure;
  state.updatedAt = now.toISOString();
  writeTransactionState(options.stateFile, state);
  try {
    const rollbackErrors: string[] = [];
    try { await adapters.rollbackPromotion?.(); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try { await adapters.restoreApp(state.lastKnownGoodRoot, options.appRoot); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try { await adapters.restoreRuntime(state.lastKnownGoodRuntimeRoot, options.runtimeRoot); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try {
      const validate = adapters.validateRestoredApp ?? adapters.validateCandidate;
      const valid = await validate(options.appRoot);
      if (valid === false) throw new Error("Restored app validation failed");
    } catch (error) { rollbackErrors.push(errorMessage(error)); }
    try { await adapters.openApp(options.appRoot); } catch (error) { rollbackErrors.push(errorMessage(error)); }
    if (rollbackErrors.length > 0) throw new Error(rollbackErrors.join("; "));
    state.rollbackResult = "succeeded";
  } catch (error) {
    state.rollbackResult = "failed";
    state.failure = `${state.failure}; rollback: ${errorMessage(error)}`;
  }
  state.phase = "degraded";
  state.updatedAt = now.toISOString();
  writeTransactionState(options.stateFile, state);
  return { status: "rolled-back", state };
}

export function readTransactionState(stateFile: string): TransactionState | null {
  if (!existsSync(stateFile)) return null;
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8")) as TransactionState;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export function writeTransactionState(stateFile: string, state: TransactionState): void {
  state.ownerPid = process.pid;
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, stateFile);
    chmodSync(stateFile, 0o600);
    fsyncDirectory(dirname(stateFile));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort after the primary failure */ }
    }
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function transactionLockFile(stateFile: string): string {
  return `${stateFile}.lock`;
}

export class TransactionLockHeldError extends Error {
  constructor(public readonly ownerPid: number) {
    super(`Another Tweakers install transaction is already running (PID ${ownerPid}).`);
    this.name = "TransactionLockHeldError";
  }
}

/**
 * Exclusive cross-process lock for the install transaction. Without it a
 * watcher `repair` fired by WatchPaths on app.asar can observe a live
 * promotion's "promoting" state, misread it as a crash, and roll back the
 * live app mid-copy (the 2026-07-13 degraded-install incident).
 */
export function acquireTransactionLock(lockFile: string): { release(): void } {
  return acquireProcessLock(lockFile, {
    onContended: (owner) => new TransactionLockHeldError(owner ?? -1),
  });
}

export function readTransactionLockOwner(lockFile: string): number | null {
  return readLockOwner(lockFile);
}

export function isTransactionLockHeld(lockFile: string): boolean {
  return isLockHeldByLiveOwner(lockFile);
}

/** Move a stale/degraded transaction record aside so a fresh transaction can start; never deletes evidence. */
export function archiveTransactionState(stateFile: string, state: TransactionState): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = `${stateFile.replace(/\.json$/, "")}.${stamp}.${state.phase}.json`;
  try {
    if (existsSync(archived)) return null;
    renameSync(stateFile, archived);
    fsyncDirectory(dirname(stateFile));
    return archived;
  } catch {
    // Preserve the source journal when archival cannot be completed. Receipt-
    // bound callers treat null as a hard stop before removing candidate bytes.
    return null;
  }
}

export function filesystemTransactionAdapters(overrides: Partial<TransactionAdapters> = {}): TransactionAdapters {
  const defaults: TransactionAdapters = {
    isAppRunning: () => false,
    copyApp: (source, destination) => cloneAppTree(source, destination),
    removeApp: (path) => rmSync(path, { recursive: true, force: true }),
    buildCandidate: () => {
      throw new Error("A signed candidate builder is required");
    },
    validateCandidate: () => {
      throw new Error("A candidate signature/structure validator is required");
    },
    probeCandidateHealth: () => unknownHealth([]),
    fingerprintApp: () => {
      throw new Error("An app fingerprint adapter is required");
    },
    isAppComplete: (appRoot) => signatureInfo(appRoot).ok,
    snapshotRuntime: (source, destination) => {
      rmSync(destination, { recursive: true, force: true });
      if (!existsSync(source)) return;
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    },
    promoteCandidate: () => {
      throw new Error("An atomic candidate promotion adapter is required");
    },
    restoreApp: () => {
      throw new Error("An app rollback adapter is required");
    },
    restoreRuntime: () => {
      throw new Error("A runtime rollback adapter is required");
    },
    probeHealth: () => ({ host: "unknown", session: "unknown", permissions: {} }),
    openApp: () => {},
  };
  return { ...defaults, ...overrides };
}

function transactionPaths(workRoot: string): Pick<
  TransactionState,
  "candidateRoot" | "pristineRoot" | "lastKnownGoodRoot" | "lastKnownGoodRuntimeRoot"
> {
  const root = resolve(workRoot);
  return {
    candidateRoot: join(root, "candidate.app"),
    pristineRoot: join(root, "pristine.app"),
    lastKnownGoodRoot: join(root, "last-known-good.app"),
    lastKnownGoodRuntimeRoot: join(root, "last-known-good-runtime"),
  };
}

function assertSafeTransactionPaths(options: TransactionOptions): void {
  const app = resolve(options.appRoot);
  const runtime = resolve(options.runtimeRoot);
  const work = resolve(options.workRoot);
  if (work === app || work.startsWith(`${app}/`) || app.startsWith(`${work}/`)) {
    throw new Error("Transaction workRoot and live appRoot must be separate");
  }
  if (work === runtime || work.startsWith(`${runtime}/`)) {
    throw new Error("Transaction workRoot must not be inside the live runtimeRoot");
  }
}

function updateState(stateFile: string, state: TransactionState, phase: TransactionPhase, now: Date): void {
  state.phase = phase;
  state.updatedAt = now.toISOString();
  writeTransactionState(stateFile, state);
}

function invalidateTransactionState(
  stateFile: string,
  state: TransactionState,
  now: Date,
  previous: TransactionState | null = state,
): void {
  const priorFailureCount = previous &&
    sameFingerprint(previous.source, state.source) &&
    samePayload(previous.payloadHash, state.payloadHash)
    ? previous.failureCount ?? 0
    : 0;
  state.phase = "invalidated";
  state.failureCount = priorFailureCount + 1;
  state.lastFailureAt = now.toISOString();
  state.updatedAt = now.toISOString();
  writeTransactionState(stateFile, state);
}

function sameFingerprint(left: AppFingerprint, right: AppFingerprint): boolean {
  return left.version === right.version && left.build === right.build && left.hash === right.hash;
}

function samePayload(left: string | undefined, right: string | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

function samePrebuiltCombinedCandidate(
  state: TransactionState,
  requested: PrebuiltCombinedCandidateAuthority | undefined,
): boolean {
  const existing = state.prebuiltCombinedCandidate?.authority;
  if (!existing || !requested) return existing === undefined && requested === undefined;
  return existing.transactionId === requested.transactionId
    && existing.payloadIdentity === requested.payloadIdentity
    && JSON.stringify(existing) === JSON.stringify(requested);
}

function candidateIntentMatches(state: TransactionState, options: TransactionOptions): boolean {
  if (options.signingMode === "adhoc") return state.pendingReason === "adhoc-never-promotes";
  if (options.candidateOnly) {
    const expected = options.candidateOnlyReason === "baseline-health-unavailable"
      ? "baseline-health-unavailable"
      : options.candidateOnlyReason === "coordinated-refresh"
        ? "coordinated-refresh"
        : "explicit-candidate-only";
    return state.pendingReason === expected && state.signingMode !== "adhoc";
  }
  return state.pendingReason !== "explicit-candidate-only"
    && state.pendingReason !== "adhoc-never-promotes"
    && state.signingMode !== "adhoc";
}

function healthFailure(
  health: TransactionHealth,
  requiredPermissions: string[],
  requirePromotionHealthV2 = false,
): string | null {
  if (health.host !== "pass") return `host health ${health.host}`;
  if (health.session !== "pass") return `session health ${health.session}`;
  for (const permission of requiredPermissions) {
    const value = health.permissions[permission] ?? "unknown";
    if (value !== "pass") return `${permission} permission health ${value}`;
  }
  if (requirePromotionHealthV2 && health.promotionReady !== "pass") {
    return `promotion proof ${health.promotionReady ?? "unknown"}`;
  }
  return null;
}

function phaseMayHaveMutatedLiveApp(phase: TransactionPhase): boolean {
  return phase === "promoting" || phase === "checkingHealth" || phase === "rollingBack";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknownHealth(requiredPermissions: string[], promotionV2 = false): TransactionHealth {
  return {
    host: "unknown",
    session: "unknown",
    permissions: Object.fromEntries(requiredPermissions.map((permission) => [permission, "unknown"])),
    ...(promotionV2 ? { promotionReady: "unknown" as const } : {}),
  };
}

function validHealthValue(value: unknown): HealthValue {
  return value === "pass" || value === "fail" || value === "unknown" ? value : "unknown";
}

function isV2HealthExpectation(value: ProductionHealthExpectation): value is ProductionHealthExpectationV2 {
  return "schemaVersion" in value && value.schemaVersion === 2;
}

export function isValidProductionHealthExpectationV2(
  value: unknown,
): value is ProductionHealthExpectationV2 {
  if (
    !plainRecord(value)
    || !exactKeys(value, ["schemaVersion", "app", "requiredPermissions", "surfaces", "userQuestions"])
    || value.schemaVersion !== 2
    || !plainRecord(value.app)
    || !exactKeys(value.app, ["version", "build", "hash"])
    || typeof value.app.version !== "string"
    || value.app.version.length === 0
    || typeof value.app.build !== "string"
    || value.app.build.length === 0
    || !validPromotionHash(value.app.hash)
    || !Array.isArray(value.requiredPermissions)
    || !value.requiredPermissions.every(
      (permission) => permission === "accessibility" || permission === "screen-recording",
    )
    || new Set(value.requiredPermissions).size !== value.requiredPermissions.length
  ) return false;
  return validPromotionExpectation(value as unknown as ProductionHealthExpectationV2);
}

function validLegacyHealthReceipt(
  value: Record<string, unknown>,
  expected: LegacyProductionHealthExpectation,
): value is ProductionHealthReceiptV1 & Record<string, unknown> {
  return exactKeys(value, [
    "schemaVersion",
    "observedAt",
    "app",
    "runtimeHash",
    "hostReady",
    "authenticatedSession",
    "declaredPermissions",
  ])
    && value.schemaVersion === 1
    && value.runtimeHash === expected.runtimeHash
    && sameFingerprintValue(value.app, expected.app)
    && validPermissionHealth(value.declaredPermissions, expected.requiredPermissions);
}

function readV2HealthReceipt(
  value: Record<string, unknown>,
  expected: ProductionHealthExpectationV2,
  unknown: TransactionHealth,
): TransactionHealth {
  if (!validV2HealthReceipt(value, expected)) return unknown;
  return {
    host: value.hostReady,
    session: value.authenticatedSession,
    permissions: Object.fromEntries(expected.requiredPermissions.map((permission) => [
      permission,
      value.declaredPermissions[permission]!,
    ])),
    promotionReady: value.promotionReady,
  };
}

function validV2HealthReceipt(
  value: Record<string, unknown>,
  expected: ProductionHealthExpectationV2,
): value is ProductionHealthReceiptV2 & Record<string, unknown> {
  if (!exactKeys(value, [
    "schemaVersion",
    "observedAt",
    "app",
    "hostReady",
    "rendererProof",
    "authenticatedSession",
    "declaredPermissions",
    "surfaces",
    "userQuestions",
    "promotionReady",
  ])) return false;
  if (
    value.schemaVersion !== 2
    || !sameFingerprintValue(value.app, expected.app)
    || validHealthValue(value.hostReady) !== value.hostReady
    || !validRendererProofReceipt(value.rendererProof)
    || validHealthValue(value.authenticatedSession) !== value.authenticatedSession
    || !validPermissionHealth(value.declaredPermissions, expected.requiredPermissions)
    || !validPromotionExpectation(expected)
    || !plainRecord(value.surfaces)
    || !exactKeys(value.surfaces, [...PROMOTION_SURFACE_NAMES])
  ) return false;

  const surfaceStatuses: HealthValue[] = [];
  for (const name of PROMOTION_SURFACE_NAMES) {
    const observed = value.surfaces[name];
    const wanted = expected.surfaces[name];
    if (!plainRecord(observed) || !exactKeys(observed, [
      "preimageHash", "expectedHash", "observedHash", "status",
    ])) return false;
    if (observed.preimageHash !== wanted.preimageHash || observed.expectedHash !== wanted.afterHash) return false;
    if (observed.observedHash !== "unknown" && !validPromotionHash(observed.observedHash)) return false;
    const expectedStatus: HealthValue = observed.observedHash === wanted.afterHash
      ? "pass"
      : observed.observedHash === "unknown" ? "unknown" : "fail";
    if (observed.status !== expectedStatus) return false;
    surfaceStatuses.push(expectedStatus);
  }

  if (!validUserQuestionsReceipt(value.userQuestions, expected.userQuestions)) return false;
  const userQuestions = value.userQuestions;
  const declaredPermissions = value.declaredPermissions as Record<string, HealthValue>;
  const allPermissionsPass = expected.requiredPermissions.every((permission) => (
    declaredPermissions[permission] === "pass"
  ));
  const allUserQuestionsPass = [
    userQuestions.identity,
    userQuestions.mainLifecycle,
    userQuestions.brokerSelfTest,
    userQuestions.schemaSelfTest,
    userQuestions.rendererStorageSelfTest,
    userQuestions.zeroMcpConflicts,
  ].every((status) => status === "pass");
  const expectedReady: HealthValue = surfaceStatuses.every((status) => status === "pass")
    && value.hostReady === "pass"
    && passingRendererProofReceipt(value.rendererProof)
    && allPermissionsPass
    && allUserQuestionsPass
    && value.authenticatedSession === "pass"
    ? "pass"
    : "fail";
  return value.promotionReady === expectedReady;
}

function validRendererProofReceipt(value: unknown): value is RendererPromotionProofObservation {
  if (!plainRecord(value) || !exactKeys(value, [
    "capturedWindowCount",
    "canonicalWebContentsId",
    "canonicalUrl",
    "queryKeys",
    "authorized",
    "didFinishLoad",
    "mounted",
    "originalPreload",
    "preloadFailed",
    "loadFailed",
    "rendererExited",
    "cleanup",
    "failureReason",
  ])) return false;
  const queryKeys = value.queryKeys;
  if (!Array.isArray(queryKeys)) return false;
  return Number.isSafeInteger(value.capturedWindowCount)
    && (value.capturedWindowCount as number) >= 0
    && (value.capturedWindowCount as number) <= 64
    && (value.canonicalWebContentsId === null || (
      Number.isSafeInteger(value.canonicalWebContentsId)
      && (value.canonicalWebContentsId as number) > 0
    ))
    && (value.canonicalUrl === null || value.canonicalUrl === "app://-/index.html")
    && queryKeys.every((key) => key === "hostId" || key === "initialRoute")
    && new Set(queryKeys).size === queryKeys.length
    && [...queryKeys].sort().every((key, index) => key === queryKeys[index])
    && typeof value.authorized === "boolean"
    && typeof value.didFinishLoad === "boolean"
    && typeof value.mounted === "boolean"
    && typeof value.originalPreload === "boolean"
    && typeof value.preloadFailed === "boolean"
    && typeof value.loadFailed === "boolean"
    && typeof value.rendererExited === "boolean"
    && (value.cleanup === "pending" || value.cleanup === "pass" || value.cleanup === "fail")
    && (value.failureReason === null || (
      typeof value.failureReason === "string"
      && value.failureReason.length > 0
      && value.failureReason.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(value.failureReason)
    ));
}

function passingRendererProofReceipt(value: RendererPromotionProofObservation): boolean {
  return value.capturedWindowCount >= 1
    && value.canonicalWebContentsId !== null
    && value.canonicalUrl !== null
    && value.authorized
    && value.didFinishLoad
    && value.mounted
    && value.originalPreload
    && !value.preloadFailed
    && !value.loadFailed
    && !value.rendererExited
    && value.cleanup === "pass"
    && value.failureReason === null;
}

function validUserQuestionsReceipt(
  value: unknown,
  expected: UserQuestionsPromotionExpectation,
): value is UserQuestionsPromotionObservation {
  if (!plainRecord(value) || !exactKeys(value, [
    "expected",
    "observed",
    "identity",
    "mainLifecycle",
    "brokerSelfTest",
    "schemaSelfTest",
    "rendererStorageSelfTest",
    "mcpConflictCount",
    "zeroMcpConflicts",
  ])) return false;
  if (!sameUserQuestionsExpectation(value.expected, expected)) return false;
  const observed = value.observed === null
    ? null
    : validUserQuestionsExpectation(value.observed) ? value.observed : undefined;
  if (observed === undefined) return false;
  const expectedIdentity: HealthValue = observed === null
    ? "unknown"
    : sameUserQuestionsExpectation(observed, expected) ? "pass" : "fail";
  if (value.identity !== expectedIdentity) return false;
  if (
    validHealthValue(value.mainLifecycle) !== value.mainLifecycle
    || validHealthValue(value.brokerSelfTest) !== value.brokerSelfTest
    || validHealthValue(value.schemaSelfTest) !== value.schemaSelfTest
    || validHealthValue(value.rendererStorageSelfTest) !== value.rendererStorageSelfTest
  ) return false;
  if (value.mcpConflictCount !== null && (
    !Number.isInteger(value.mcpConflictCount) || (value.mcpConflictCount as number) < 0
  )) return false;
  const zeroMcpConflicts: HealthValue = value.mcpConflictCount === null
    ? "unknown"
    : value.mcpConflictCount === 0 ? "pass" : "fail";
  return value.zeroMcpConflicts === zeroMcpConflicts;
}

function validPromotionExpectation(expected: ProductionHealthExpectationV2): boolean {
  if (
    !validUserQuestionsExpectation(expected.userQuestions)
    || !plainRecord(expected.surfaces)
    || !exactKeys(expected.surfaces, [...PROMOTION_SURFACE_NAMES])
    || expected.surfaces.app.afterHash !== expected.app.hash
  ) return false;
  return PROMOTION_SURFACE_NAMES.every((name) => (
    validPromotionHash(expected.surfaces[name].preimageHash)
    && validPromotionHash(expected.surfaces[name].afterHash)
  ));
}

function validUserQuestionsExpectation(value: unknown): value is UserQuestionsPromotionExpectation {
  return plainRecord(value)
    && exactKeys(value, ["id", "version", "payloadHash"])
    && value.id === "co.tweakers.user-questions"
    && typeof value.version === "string"
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)
    && validPromotionHash(value.payloadHash)
    && value.payloadHash !== "missing";
}

function sameUserQuestionsExpectation(value: unknown, expected: UserQuestionsPromotionExpectation): boolean {
  return validUserQuestionsExpectation(value)
    && value.id === expected.id
    && value.version === expected.version
    && value.payloadHash === expected.payloadHash;
}

function validPermissionHealth(value: unknown, requiredPermissions: string[]): value is Record<string, HealthValue> {
  return plainRecord(value)
    && exactKeys(value, requiredPermissions)
    && requiredPermissions.every((permission) => validHealthValue(value[permission]) === value[permission]);
}

function sameFingerprintValue(value: unknown, expected: AppFingerprint): value is AppFingerprint {
  return plainRecord(value)
    && exactKeys(value, ["version", "build", "hash"])
    && value.version === expected.version
    && value.build === expected.build
    && value.hash === expected.hash;
}

function validPromotionHash(value: unknown): value is string {
  return value === "missing" || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

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
import {
  acquireProcessLock,
  isLockHeldByLiveOwner,
  processAlive,
  readLockOwner,
} from "./process-lock.js";

export type HealthValue = "pass" | "fail" | "unknown";

export interface AppFingerprint {
  version: string;
  build: string;
  hash: string;
}

export interface TransactionHealth {
  host: HealthValue;
  session: HealthValue;
  permissions: Record<string, HealthValue>;
}

export interface ProductionHealthReceipt {
  schemaVersion: 1;
  observedAt: string;
  app: AppFingerprint;
  runtimeHash: string;
  hostReady: HealthValue;
  authenticatedSession: HealthValue;
  declaredPermissions: Record<string, HealthValue>;
}

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
  candidateOnly?: boolean;
  candidateOnlyReason?: "explicit" | "baseline-health-unavailable" | "coordinated-refresh";
  maxCandidateAgeMs?: number;
  now?: Date;
  signingMode?: "local-identity" | "adhoc";
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
  openApp(appRoot: string): void | Promise<void>;
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
      return;
    } catch {
      // clonefile unavailable / cross-volume — fall back to a byte copy.
      removeDir(destination);
    }
  }
  copyDir(source, destination);
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
  try {
    sweepStaleTempDirs([
      dirname(resolve(options.appRoot)),
      dirname(resolve(options.runtimeRoot)),
      resolve(options.workRoot),
    ]);
  } catch { /* best-effort startup sweep */ }

  if (
    existing?.phase === "healthy" &&
    sameFingerprint(existing.source, options.source) &&
    samePayload(existing.payloadHash, options.payloadHash)
  ) {
    return { status: "promoted", state: existing };
  }

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
      candidateIntentMatches(existing, options)
    ) {
      return continuePendingPromotion(options, adapters, existing, now);
    }
    await adapters.removeApp(existing.candidateRoot);
    const sameInstallerPayload = samePayload(existing.payloadHash, options.payloadHash);
    existing.pendingReason = sameInstallerPayload
      ? "candidate-intent-drift"
      : "installer-payload-drift";
    existing.failure = sameInstallerPayload
      ? "candidate promotion intent changed after the candidate was built"
      : "installer payload changed after the candidate was built";
    invalidateTransactionState(options.stateFile, existing, now);
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
  }), options.requiredPermissions);
  if (candidateFailure) {
    await adapters.removeApp(state.candidateRoot);
    state.failure = `candidate health: ${candidateFailure}`;
    invalidateTransactionState(options.stateFile, state, now, existing);
    return { status: "invalidated", state };
  }

  return promoteAndVerify(options, adapters, state, now);
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
    await adapters.restoreApp(state.lastKnownGoodRoot, options.appRoot);
    await adapters.restoreRuntime(state.lastKnownGoodRuntimeRoot, options.runtimeRoot);
    const validate = adapters.validateRestoredApp ?? adapters.validateCandidate;
    const valid = await validate(options.appRoot);
    if (valid === false) throw new Error("Restored app validation failed");
    await adapters.openApp(options.appRoot);
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
  if (
    options.candidateOnly ||
    state.signingMode === "adhoc" ||
    state.pendingReason === "adhoc-never-promotes" ||
    state.pendingReason === "explicit-candidate-only"
  ) {
    return { status: "candidate-ready", state };
  }

  const age = now.getTime() - Date.parse(state.createdAt);
  const maxAge = options.maxCandidateAgeMs ?? DEFAULT_MAX_CANDIDATE_AGE_MS;
  if (age < 0 || age > maxAge) {
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
  }), options.requiredPermissions);
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
  expected: { app: AppFingerprint; runtimeHash: string; requiredPermissions: string[] },
  options: { now?: Date; maxAgeMs?: number; maxBytes?: number } = {},
): TransactionHealth {
  const unknown = unknownHealth(expected.requiredPermissions);
  try {
    const stat = lstatSync(receiptFile);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > (options.maxBytes ?? 64 * 1024)
    ) return unknown;
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as ProductionHealthReceipt;
    if (receipt.schemaVersion !== 1 || !sameFingerprint(receipt.app, expected.app) || receipt.runtimeHash !== expected.runtimeHash) return unknown;
    const now = (options.now ?? new Date()).getTime();
    const observedAt = Date.parse(receipt.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > now + 5_000 || now - observedAt > (options.maxAgeMs ?? 60_000)) return unknown;
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
  expected: { app: AppFingerprint; runtimeHash: string; requiredPermissions: string[] },
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

  updateState(options.stateFile, state, "promoting", now);
  await adapters.removeApp(state.lastKnownGoodRoot);
  await adapters.copyApp(options.appRoot, state.lastKnownGoodRoot);
  await adapters.removeApp(state.lastKnownGoodRuntimeRoot);
  await adapters.snapshotRuntime(options.runtimeRoot, state.lastKnownGoodRuntimeRoot);
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

  const failure = healthFailure(health, options.requiredPermissions);
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
    await adapters.restoreApp(state.lastKnownGoodRoot, options.appRoot);
    await adapters.restoreRuntime(state.lastKnownGoodRuntimeRoot, options.runtimeRoot);
    const validate = adapters.validateRestoredApp ?? adapters.validateCandidate;
    const valid = await validate(options.appRoot);
    if (valid === false) throw new Error("Restored app validation failed");
    await adapters.openApp(options.appRoot);
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
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, stateFile);
  chmodSync(stateFile, 0o600);
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
export function archiveTransactionState(stateFile: string, state: TransactionState): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = `${stateFile.replace(/\.json$/, "")}.${stamp}.${state.phase}.json`;
  try {
    renameSync(stateFile, archived);
  } catch {
    try { unlinkSync(stateFile); } catch { /* already gone */ }
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

function healthFailure(health: TransactionHealth, requiredPermissions: string[]): string | null {
  if (health.host !== "pass") return `host health ${health.host}`;
  if (health.session !== "pass") return `session health ${health.session}`;
  for (const permission of requiredPermissions) {
    const value = health.permissions[permission] ?? "unknown";
    if (value !== "pass") return `${permission} permission health ${value}`;
  }
  return null;
}

function phaseMayHaveMutatedLiveApp(phase: TransactionPhase): boolean {
  return phase === "promoting" || phase === "checkingHealth" || phase === "rollingBack";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknownHealth(requiredPermissions: string[]): TransactionHealth {
  return {
    host: "unknown",
    session: "unknown",
    permissions: Object.fromEntries(requiredPermissions.map((permission) => [permission, "unknown"])),
  };
}

function validHealthValue(value: unknown): HealthValue {
  return value === "pass" || value === "fail" || value === "unknown" ? value : "unknown";
}

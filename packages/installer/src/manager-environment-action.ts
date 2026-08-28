/**
 * Node-only durable receipt primitives for the one manager-safe environment
 * action family. This module deliberately owns no app/process/watchers/proof
 * adapters: cancelling a receipt before cutover is a closed metadata-only
 * transition, while v1 recovery is not safe to expose without the legacy
 * coordinator's live-app proof graph.
 *
 * The receipt codec and terminal writer are extracted verbatim from the
 * legacy coordinator's authority. Both paths therefore reject and persist
 * exactly the same schema-v1 receipt shapes.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  isEnvironmentSelection,
  normalizeEnvironmentSelection,
  type AppExperience,
  type BackendLane,
  type EnvironmentSelection,
  type ReleaseProfile,
} from "./environment-profile.js";
import {
  ENVIRONMENT_TIMING_PHASES,
  EnvironmentTimingRecorder,
  type EnvironmentTimingEvidence,
} from "./environment-timing.js";

export const ENVIRONMENT_TRANSACTION_SCHEMA_VERSION = 1 as const;

export const ENVIRONMENT_TRANSACTION_PHASES = [
  "preparing",
  "prepared",
  "committing",
  "applying",
  "reopening",
  "verifying",
  "committed",
  "rolling-back",
  "rolled-back",
  "failed",
  "cancelled",
] as const;

export type EnvironmentTransactionPhase = typeof ENVIRONMENT_TRANSACTION_PHASES[number];

export interface PreparedCandidateSignatureEvidence {
  strict: boolean;
  gatekeeper: boolean;
  designatedRequirement: string;
  teamIdentifier: string | null;
}

export interface PreparedDesktopCandidateEvidence {
  desktopPath: string;
  artifactPath: string;
  bundleId: EnvironmentSelection["selectedDesktopBundleId"];
  appExperience: AppExperience;
  releaseProfile: ReleaseProfile;
  version: string;
  build: string;
  artifactDigest: string;
  asarHeaderHash?: string;
  signature: PreparedCandidateSignatureEvidence;
}

export interface PreparedBackendEvidence {
  lane: BackendLane;
  binaryPath: string;
  artifactPath: string;
  version: string;
  artifactDigest: string;
}

export interface PreparedRollbackEvidence {
  selection: EnvironmentSelection;
  desktopPath: string;
  desktopArtifactPath: string;
  archivePath: string;
  bundleId: EnvironmentSelection["selectedDesktopBundleId"];
  desktopVersion: string;
  desktopBuild: string;
  desktopArtifactDigest: string;
  desktopAsarHeaderHash?: string;
  signature?: PreparedCandidateSignatureEvidence;
  backendLane: BackendLane;
  backendBinaryPath: string;
  backendArtifactPath: string;
  backendVersion: string;
  backendArtifactDigest: string;
}

export interface PreparedSwapHostEvidence {
  path: string;
  sourceAppPath: string;
  digest: string;
  strict: boolean;
  designatedRequirement: string;
  teamIdentifier: string | null;
  authority: string[];
  certificateLeafHash: string | null;
}

export interface PreparedRuntimeArtifactEvidence {
  artifactPath: string;
  artifactDigest: string;
  runtimeFingerprint: string;
  fileCount: number;
}

export interface PreparedRuntimeRollbackArtifactEvidence {
  existed: boolean;
  artifactPath: string;
  artifactDigest: string | null;
  runtimeFingerprint: string | null;
  fileCount: number | null;
}

export interface PreparedRuntimeEvidence {
  targetPath: string;
  requested: PreparedRuntimeArtifactEvidence;
  rollback: PreparedRuntimeRollbackArtifactEvidence;
}

export interface PreparedManagedRuntimeArtifactEvidence extends PreparedRuntimeArtifactEvidence {
  sourceRuntimeHash: string | null;
  cliPath?: string;
  cliArtifactDigest?: string;
}

export interface PreparedManagedRuntimeRollbackArtifactEvidence extends PreparedRuntimeRollbackArtifactEvidence {
  sourceRuntimeHash: string | null;
}

export interface PreparedManagedRuntimeEvidence {
  targetPath: string;
  requested: PreparedManagedRuntimeArtifactEvidence;
  rollback: PreparedManagedRuntimeRollbackArtifactEvidence;
}

export interface PreparedEnvironmentEvidence {
  preparedAt: string;
  candidate: PreparedDesktopCandidateEvidence;
  backend: PreparedBackendEvidence;
  swapHost?: PreparedSwapHostEvidence;
  runtime?: PreparedRuntimeEvidence;
  managedRuntime?: PreparedManagedRuntimeEvidence;
  rollback: PreparedRollbackEvidence;
}

export interface EnvironmentAppliedEvidence {
  observedAt: string;
  selection: EnvironmentSelection;
  desktopVersion: string;
  desktopBuild: string;
  backendVersion: string;
  desktopArtifactDigest: string;
  asarHeaderHash?: string;
  backendArtifactDigest: string;
  runtimeArtifactDigest?: string;
  managedRuntimeArtifactDigest?: string;
}

export interface EnvironmentTransactionReceipt {
  schemaVersion: typeof ENVIRONMENT_TRANSACTION_SCHEMA_VERSION;
  kind: "environment";
  transactionId: string;
  phase: EnvironmentTransactionPhase;
  error: string | null;
  ownerPid: number;
  source: EnvironmentSelection;
  requested: EnvironmentSelection;
  prepared: PreparedEnvironmentEvidence | null;
  applied: EnvironmentAppliedEvidence | null;
  oldMainPid: number | null;
  newMainPid: number | null;
  attempt: number;
  applyProgress?: string | null;
  timing?: EnvironmentTimingEvidence;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  rolledBackAt: string | null;
  cancelledAt: string | null;
}

export interface EnvironmentTransactionStorage {
  transactionFile: string;
  receiptRoot: string;
}

export interface CancelPreparedEnvironmentTransactionInput extends EnvironmentTransactionStorage {
  transactionId?: string;
  ownerPid: number;
  now: () => string;
  /** Supplied by the legacy coordinator so terminal timing evidence is exact. */
  timing: EnvironmentTimingRecorder;
}

export function isTerminalEnvironmentPhase(phase: EnvironmentTransactionPhase): boolean {
  return phase === "committed" || phase === "rolled-back" || phase === "failed" || phase === "cancelled";
}

/**
 * The manager-safe action is intentionally limited to receipts that have not
 * begun cutover. Its writer archives the terminal state before publishing the
 * current receipt, exactly like the legacy coordinator.
 */
export function cancelPreparedEnvironmentTransaction(
  input: CancelPreparedEnvironmentTransactionInput,
): EnvironmentTransactionReceipt {
  const receipt = requireEnvironmentTransactionReceipt(input.transactionFile, input.transactionId);
  if (receipt.phase !== "prepared" && receipt.phase !== "preparing") {
    throw new Error(`Environment transaction ${receipt.transactionId} cannot be cancelled from phase ${receipt.phase}`);
  }
  return updateEnvironmentTransactionReceipt(receipt, {
    phase: "cancelled",
    ownerPid: input.ownerPid,
    cancelledAt: input.now(),
    error: null,
  }, true, input);
}

export function readEnvironmentTransactionReceipt(file: string): EnvironmentTransactionReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Environment transaction receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  const normalized = normalizeTerminalEnvironmentTransactionReceipt(value);
  if (!isEnvironmentTransactionReceipt(normalized)) {
    throw new Error(`Environment transaction receipt is invalid at ${file}`);
  }
  return normalized;
}

export function writeEnvironmentTransactionReceipt(
  file: string,
  receipt: EnvironmentTransactionReceipt,
): void {
  if (!isEnvironmentTransactionReceipt(receipt)) {
    throw new Error("Refusing to write an invalid environment transaction receipt");
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    fsyncDirectory(dirname(file));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

export function preparedEvidenceMatches(
  prepared: PreparedEnvironmentEvidence,
  current: EnvironmentSelection,
  requested: EnvironmentSelection,
): boolean {
  return isPreparedEnvironmentEvidence(prepared)
    && prepared.candidate.desktopPath === requested.selectedDesktopPath
    && prepared.candidate.bundleId === requested.selectedDesktopBundleId
    && prepared.candidate.appExperience === requested.appExperience
    && prepared.candidate.releaseProfile === requested.releaseProfile
    && prepared.backend.lane === requested.backendLane
    && prepared.rollback.desktopPath === current.selectedDesktopPath
    && selectionsMatch(prepared.rollback.selection, current, true)
    && prepared.rollback.bundleId === current.selectedDesktopBundleId
    && prepared.rollback.backendLane === current.backendLane;
}

export function appliedEvidenceProvesRequest(
  applied: EnvironmentAppliedEvidence,
  requested: EnvironmentSelection,
  prepared: PreparedEnvironmentEvidence,
  direction: "requested" | "rollback",
): boolean {
  if (!isEnvironmentAppliedEvidence(applied) || !selectionsMatch(applied.selection, requested, false)) return false;
  if (applied.selection.appliedAt === null
    || Date.parse(applied.selection.appliedAt) < Date.parse(requested.requestedAt)
    || Date.parse(applied.observedAt) < Date.parse(requested.requestedAt)) return false;
  if (direction === "requested") {
    const baseMatches = applied.desktopVersion === prepared.candidate.version
      && applied.desktopBuild === prepared.candidate.build
      && applied.backendVersion === prepared.backend.version
      && applied.desktopArtifactDigest === prepared.candidate.artifactDigest
      && applied.asarHeaderHash === prepared.candidate.asarHeaderHash
      && applied.backendArtifactDigest === prepared.backend.artifactDigest;
    return baseMatches
      && (!prepared.runtime
        || applied.runtimeArtifactDigest === prepared.runtime.requested.artifactDigest)
      && (!prepared.managedRuntime
        || applied.managedRuntimeArtifactDigest === prepared.managedRuntime.requested.artifactDigest);
  }
  const baseMatches = applied.desktopVersion === prepared.rollback.desktopVersion
    && applied.desktopBuild === prepared.rollback.desktopBuild
    && applied.backendVersion === prepared.rollback.backendVersion
    && applied.desktopArtifactDigest === prepared.rollback.desktopArtifactDigest
    && applied.asarHeaderHash === prepared.rollback.desktopAsarHeaderHash
    && applied.backendArtifactDigest === prepared.rollback.backendArtifactDigest;
  const rollbackRuntimeDigest = prepared.runtime?.rollback.artifactDigest;
  const rollbackManagedRuntimeDigest = prepared.managedRuntime?.rollback.artifactDigest;
  return baseMatches
    && (!prepared.runtime
      || (rollbackRuntimeDigest === null
        ? applied.runtimeArtifactDigest === undefined
        : applied.runtimeArtifactDigest === rollbackRuntimeDigest))
    && (!prepared.managedRuntime
      || (rollbackManagedRuntimeDigest === null
        ? applied.managedRuntimeArtifactDigest === undefined
        : applied.managedRuntimeArtifactDigest === rollbackManagedRuntimeDigest));
}

function requireEnvironmentTransactionReceipt(
  file: string,
  transactionId: string | undefined,
): EnvironmentTransactionReceipt {
  const receipt = readEnvironmentTransactionReceipt(file);
  if (receipt === null) throw new Error("No environment transaction receipt exists");
  if (transactionId !== undefined && receipt.transactionId !== transactionId) {
    throw new Error(`Environment transaction mismatch: expected ${transactionId}, found ${receipt.transactionId}`);
  }
  return receipt;
}

function updateEnvironmentTransactionReceipt(
  receipt: EnvironmentTransactionReceipt,
  patch: Partial<EnvironmentTransactionReceipt>,
  terminal: boolean,
  input: CancelPreparedEnvironmentTransactionInput,
): EnvironmentTransactionReceipt {
  let next = { ...receipt, ...patch, updatedAt: input.now() };
  if (!terminal || next.timing === undefined) {
    persistEnvironmentTransactionReceipt(next, terminal, input);
    return next;
  }
  const terminalTiming = input.timing.start(next.timing, "terminal-persist");
  next = { ...next, timing: terminalTiming };
  persistEnvironmentTransactionReceipt(next, true, input);
  const completedTiming = input.timing.complete(terminalTiming, "terminal-persist");
  next = {
    ...next,
    timing: (next.phase === "committed" || next.phase === "rolled-back")
      ? input.timing.markReady(completedTiming)
      : completedTiming,
    updatedAt: input.now(),
  };
  persistEnvironmentTransactionReceipt(next, true, input);
  return next;
}

function persistEnvironmentTransactionReceipt(
  receipt: EnvironmentTransactionReceipt,
  terminal: boolean,
  input: EnvironmentTransactionStorage,
): void {
  if (terminal) {
    writeEnvironmentTransactionReceipt(join(input.receiptRoot, `${receipt.transactionId}.json`), receipt);
  }
  writeEnvironmentTransactionReceipt(input.transactionFile, receipt);
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function normalizeTerminalEnvironmentTransactionReceipt(value: unknown): unknown {
  if (!isRecord(value)
    || (value.phase !== "committed"
      && value.phase !== "rolled-back"
      && value.phase !== "failed"
      && value.phase !== "cancelled")) return value;

  const source = normalizeEnvironmentSelection(value.source);
  const requested = normalizeEnvironmentSelection(value.requested);
  if (source === null || requested === null) return value;

  let prepared = value.prepared;
  if (isRecord(prepared)) {
    if (!isRecord(prepared.rollback)) return value;
    const rollbackSelection = normalizeEnvironmentSelection(prepared.rollback.selection);
    if (rollbackSelection === null) return value;
    prepared = {
      ...prepared,
      rollback: { ...prepared.rollback, selection: rollbackSelection },
    };
  }

  let applied = value.applied;
  if (isRecord(applied)) {
    const appliedSelection = normalizeEnvironmentSelection(applied.selection);
    if (appliedSelection === null) return value;
    applied = { ...applied, selection: appliedSelection };
  }

  return { ...value, source, requested, prepared, applied };
}

function isEnvironmentTransactionReceipt(value: unknown): value is EnvironmentTransactionReceipt {
  if (!isRecord(value)) return false;
  const baseValid = value.schemaVersion === ENVIRONMENT_TRANSACTION_SCHEMA_VERSION
    && value.kind === "environment"
    && typeof value.transactionId === "string"
    && value.transactionId.length > 0
    && isEnvironmentTransactionPhase(value.phase)
    && (value.error === null || typeof value.error === "string")
    && positiveInteger(value.ownerPid)
    && isEnvironmentSelection(value.source)
    && isEnvironmentSelection(value.requested)
    && (value.prepared === null || isPreparedEnvironmentEvidence(value.prepared))
    && (value.applied === null || isEnvironmentAppliedEvidence(value.applied))
    && (value.oldMainPid === null || positiveInteger(value.oldMainPid))
    && (value.newMainPid === null || positiveInteger(value.newMainPid))
    && typeof value.attempt === "number"
    && Number.isInteger(value.attempt)
    && value.attempt >= 0
    && (value.applyProgress === undefined
      || value.applyProgress === null
      || typeof value.applyProgress === "string")
    && (value.timing === undefined || isEnvironmentTimingEvidence(value.timing))
    && validIso(value.createdAt)
    && validIso(value.updatedAt)
    && nullableIso(value.committedAt)
    && nullableIso(value.rolledBackAt)
    && nullableIso(value.cancelledAt);
  if (!baseValid) return false;
  const receipt = value as unknown as EnvironmentTransactionReceipt;
  if (receipt.prepared !== null && !preparedEvidenceMatches(receipt.prepared, receipt.source, receipt.requested)) {
    return false;
  }
  if (phaseRequiresPreparedEvidence(receipt.phase) && receipt.prepared === null) return false;
  const terminalPhase = receipt.phase === "committed"
    || receipt.phase === "rolled-back"
    || receipt.phase === "failed"
    || receipt.phase === "cancelled";
  if (!terminalPhase && receipt.prepared !== null
    && (receipt.prepared.candidate.asarHeaderHash === undefined
      || receipt.prepared.rollback.desktopAsarHeaderHash === undefined)) {
    return false;
  }
  if (receipt.phase === "committed") {
    return receipt.prepared !== null
      && receipt.applied !== null
      && receipt.committedAt !== null
      && receipt.newMainPid !== null
      && appliedEvidenceProvesRequest(receipt.applied, receipt.requested, receipt.prepared, "requested");
  }
  if (receipt.phase === "rolled-back") {
    return receipt.prepared !== null
      && receipt.applied !== null
      && receipt.rolledBackAt !== null
      && receipt.newMainPid !== null
      && appliedEvidenceProvesRequest(
        receipt.applied,
        receipt.prepared.rollback.selection,
        receipt.prepared,
        "rollback",
      );
  }
  if (receipt.phase === "cancelled" && receipt.cancelledAt === null) return false;
  return true;
}

function isEnvironmentTimingEvidence(value: unknown): value is EnvironmentTimingEvidence {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !nullableIso(value.approvalAt)
    || !nullableIso(value.readyAt)
    || !isRecord(value.phases)) return false;
  return Object.entries(value.phases).every(([phase, evidence]) =>
    (ENVIRONMENT_TIMING_PHASES as readonly string[]).includes(phase)
    && isRecord(evidence)
    && validIso(evidence.startedAt)
    && nullableIso(evidence.completedAt)
    && (evidence.durationMs === null
      || (typeof evidence.durationMs === "number" && Number.isFinite(evidence.durationMs) && evidence.durationMs >= 0)),
  );
}

function phaseRequiresPreparedEvidence(phase: EnvironmentTransactionPhase): boolean {
  return phase === "prepared"
    || phase === "committing"
    || phase === "applying"
    || phase === "reopening"
    || phase === "verifying"
    || phase === "committed"
    || phase === "rolling-back"
    || phase === "rolled-back";
}

function isEnvironmentTransactionPhase(value: unknown): value is EnvironmentTransactionPhase {
  return typeof value === "string"
    && (ENVIRONMENT_TRANSACTION_PHASES as readonly string[]).includes(value);
}

function isPreparedEnvironmentEvidence(value: unknown): value is PreparedEnvironmentEvidence {
  if (!isRecord(value) || !validIso(value.preparedAt)) return false;
  const candidate = value.candidate;
  const backend = value.backend;
  const rollback = value.rollback;
  if (!isRecord(candidate)
    || !exactAbsolutePath(candidate.desktopPath)
    || !exactAbsolutePath(candidate.artifactPath)
    || !isBundleId(candidate.bundleId)
    || !isAppExperience(candidate.appExperience)
    || !isReleaseProfile(candidate.releaseProfile)
    || !nonEmpty(candidate.version)
    || !nonEmpty(candidate.build)
    || !nonEmpty(candidate.artifactDigest)
    || (candidate.asarHeaderHash !== undefined && !validDigest(candidate.asarHeaderHash))
    || !isPreparedSignatureEvidence(candidate.signature)) return false;
  if (!isRecord(backend)
    || !isBackendLane(backend.lane)
    || !exactAbsolutePath(backend.binaryPath)
    || !exactAbsolutePath(backend.artifactPath)
    || !nonEmpty(backend.version)
    || !nonEmpty(backend.artifactDigest)) return false;
  if (value.swapHost !== undefined && !isPreparedSwapHostEvidence(value.swapHost)) return false;
  const runtimePresent = value.runtime !== undefined;
  const managedRuntimePresent = value.managedRuntime !== undefined;
  if (runtimePresent !== managedRuntimePresent) return false;
  if (runtimePresent
    && (!isPreparedRuntimeEvidence(value.runtime)
      || !isPreparedManagedRuntimeEvidence(value.managedRuntime))) return false;
  return isRecord(rollback)
    && isEnvironmentSelection(rollback.selection)
    && exactAbsolutePath(rollback.desktopPath)
    && exactAbsolutePath(rollback.desktopArtifactPath)
    && exactAbsolutePath(rollback.archivePath)
    && isBundleId(rollback.bundleId)
    && nonEmpty(rollback.desktopVersion)
    && nonEmpty(rollback.desktopBuild)
    && nonEmpty(rollback.desktopArtifactDigest)
    && (rollback.desktopAsarHeaderHash === undefined || validDigest(rollback.desktopAsarHeaderHash))
    && (rollback.signature === undefined || isPreparedSignatureEvidence(rollback.signature))
    && isBackendLane(rollback.backendLane)
    && exactAbsolutePath(rollback.backendBinaryPath)
    && exactAbsolutePath(rollback.backendArtifactPath)
    && nonEmpty(rollback.backendVersion)
    && nonEmpty(rollback.backendArtifactDigest)
    && rollback.desktopPath === rollback.selection.selectedDesktopPath
    && rollback.bundleId === rollback.selection.selectedDesktopBundleId
    && rollback.backendLane === rollback.selection.backendLane;
}

function isPreparedRuntimeEvidence(value: unknown): value is PreparedRuntimeEvidence {
  return isRecord(value)
    && exactAbsolutePath(value.targetPath)
    && isPreparedRuntimeArtifactEvidence(value.requested)
    && isPreparedRuntimeRollbackArtifactEvidence(value.rollback);
}

function isPreparedManagedRuntimeEvidence(value: unknown): value is PreparedManagedRuntimeEvidence {
  return isRecord(value)
    && exactAbsolutePath(value.targetPath)
    && isPreparedManagedRuntimeArtifactEvidence(value.requested)
    && isPreparedManagedRuntimeRollbackArtifactEvidence(value.rollback);
}

function isPreparedRuntimeArtifactEvidence(value: unknown): value is PreparedRuntimeArtifactEvidence {
  return isRecord(value)
    && exactAbsolutePath(value.artifactPath)
    && nonEmpty(value.artifactDigest)
    && sha256(value.runtimeFingerprint)
    && nonNegativeInteger(value.fileCount);
}

function isPreparedRuntimeRollbackArtifactEvidence(
  value: unknown,
): value is PreparedRuntimeRollbackArtifactEvidence {
  if (!isRecord(value)
    || typeof value.existed !== "boolean"
    || !exactAbsolutePath(value.artifactPath)) return false;
  if (!value.existed) {
    return value.artifactDigest === null
      && value.runtimeFingerprint === null
      && value.fileCount === null;
  }
  return nonEmpty(value.artifactDigest)
    && ((value.runtimeFingerprint === null && value.fileCount === null)
      || (sha256(value.runtimeFingerprint) && nonNegativeInteger(value.fileCount)));
}

function isPreparedManagedRuntimeArtifactEvidence(
  value: unknown,
): value is PreparedManagedRuntimeArtifactEvidence {
  return isPreparedRuntimeArtifactEvidence(value)
    && isRecord(value)
    && (value.sourceRuntimeHash === null || sha256(value.sourceRuntimeHash))
    && (value.cliPath === undefined || exactAbsolutePath(value.cliPath))
    && (value.cliArtifactDigest === undefined || sha256(value.cliArtifactDigest))
    && ((value.cliPath === undefined) === (value.cliArtifactDigest === undefined));
}

function isPreparedManagedRuntimeRollbackArtifactEvidence(
  value: unknown,
): value is PreparedManagedRuntimeRollbackArtifactEvidence {
  return isPreparedRuntimeRollbackArtifactEvidence(value)
    && isRecord(value)
    && (value.sourceRuntimeHash === null || sha256(value.sourceRuntimeHash));
}

function isPreparedSwapHostEvidence(value: unknown): value is PreparedSwapHostEvidence {
  return isRecord(value)
    && exactAbsolutePath(value.path)
    && exactAbsolutePath(value.sourceAppPath)
    && sha256(value.digest)
    && value.strict === true
    && nonEmpty(value.designatedRequirement)
    && (value.teamIdentifier === null || nonEmpty(value.teamIdentifier))
    && Array.isArray(value.authority)
    && value.authority.every((entry) => nonEmpty(entry))
    && (value.certificateLeafHash === null || nonEmpty(value.certificateLeafHash));
}

function isPreparedSignatureEvidence(value: unknown): value is PreparedCandidateSignatureEvidence {
  return isRecord(value)
    && typeof value.strict === "boolean"
    && typeof value.gatekeeper === "boolean"
    && nonEmpty(value.designatedRequirement)
    && (value.teamIdentifier === null || nonEmpty(value.teamIdentifier));
}

function isEnvironmentAppliedEvidence(value: unknown): value is EnvironmentAppliedEvidence {
  return isRecord(value)
    && validIso(value.observedAt)
    && isEnvironmentSelection(value.selection)
    && nonEmpty(value.desktopVersion)
    && nonEmpty(value.desktopBuild)
    && nonEmpty(value.backendVersion)
    && nonEmpty(value.desktopArtifactDigest)
    && (value.asarHeaderHash === undefined || validDigest(value.asarHeaderHash))
    && nonEmpty(value.backendArtifactDigest)
    && (value.runtimeArtifactDigest === undefined || nonEmpty(value.runtimeArtifactDigest))
    && (value.managedRuntimeArtifactDigest === undefined || nonEmpty(value.managedRuntimeArtifactDigest));
}

export function selectionsMatch(
  applied: EnvironmentSelection,
  requested: EnvironmentSelection,
  includeAppliedAt: boolean,
): boolean {
  return applied.selectedDesktopPath === requested.selectedDesktopPath
    && applied.selectedDesktopBundleId === requested.selectedDesktopBundleId
    && applied.appExperience === requested.appExperience
    && applied.releaseProfile === requested.releaseProfile
    && applied.backendLane === requested.backendLane
    && applied.uiFeatures === requested.uiFeatures
    && applied.mcpSafetyProvider === requested.mcpSafetyProvider
    && applied.recoveryState === requested.recoveryState
    && applied.migrationState === requested.migrationState
    && applied.quarantineReason === requested.quarantineReason
    && applied.requestedAt === requested.requestedAt
    && (!includeAppliedAt || applied.appliedAt === requested.appliedAt);
}

function exactAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && isAbsolute(value)
    && normalize(value) === value
    && dirname(value) !== value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validDigest(value: unknown): value is string {
  return sha256(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableIso(value: unknown): value is string | null {
  return value === null || validIso(value);
}

function isBundleId(value: unknown): value is EnvironmentSelection["selectedDesktopBundleId"] {
  return value === "com.openai.codex" || value === "com.openai.codex.beta";
}

function isAppExperience(value: unknown): value is AppExperience {
  return value === "chatgpt" || value === "tweakers";
}

function isReleaseProfile(value: unknown): value is ReleaseProfile {
  return value === "stable" || value === "alpha";
}

function isBackendLane(value: unknown): value is BackendLane {
  return value === "official-bundled" || value === "bundled" || value === "managed-alpha";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
import { dirname, join } from "node:path";
import {
  assertTagIdentityStable,
  compareSemverPrecedence,
  parseCodexReleaseTag,
  parseSemver,
  type CodexSourceChannel,
  type TagPeelIdentity,
} from "./codex-source-release.js";
import {
  assertManagedMcpPreparedRuntimeEvidence,
  managedMcpPreparedRuntimeEvidenceShapeIsValid,
  type ManagedMcpPreparedRuntimeEvidence,
} from "./managed-mcp-lifecycle.js";

export const CODEX_DERIVED_RECEIPT_SCHEMA_VERSION = 2 as const;

export const CODEX_DERIVED_PHASES = [
  "preparing",
  "prepared",
  "canary-passed",
  "promoting",
  "promoted",
  "soaking",
  "completed",
  "rolling-back",
  "rolled-back",
  "failed",
  "superseded",
] as const;

export type CodexDerivedPhase = typeof CODEX_DERIVED_PHASES[number];
export type CodexResolutionCheckpointName = "R1" | "R2" | "R3";

export interface NamedDigest {
  algorithm: "sha256" | "sha512";
  value: string;
  scope: string;
}

export interface CodexResolutionCheckpoint {
  name: CodexResolutionCheckpointName;
  channel: CodexSourceChannel;
  endpoint: string;
  resolvedTag: string;
  normalizedVersion: string;
  peeledCommit: string;
  checkedAt: string;
  etag: string | null;
  responseBodySha256?: string | null;
  tagObjectShas: readonly string[];
}

export interface RestartWindow {
  opensAt: string;
  closesAt: string;
}

export interface CodexResolutionEvidence {
  endpoint: string;
  requestedApiVersion: string;
  resolvedTag: string;
  normalizedVersion: string;
  peeledCommit: string;
  checkedAt: string;
  etag: string | null;
  responseBodySha256: string | null;
  tagObjectShas: readonly string[];
  checkpoints: readonly CodexResolutionCheckpoint[];
  restartWindow: RestartWindow | null;
  frozenAt: string | null;
}

export interface CodexSourceEvidence {
  repository: string;
  checkoutCommit: string;
  archiveDigest: NamedDigest | null;
  treeDigest: NamedDigest;
  patchSeriesDigest: NamedDigest;
  toolchainDigests: readonly NamedDigest[];
  lockfileDigests: readonly NamedDigest[];
}

export interface LockedDependencyEvidence {
  name: string;
  version: string;
  integrity: string;
  entrypoint: string | null;
  contentDigests: readonly NamedDigest[];
}

export interface CodexTrustedSourceEvidence {
  sourcePath: string;
  sha256: string;
}

export interface CodexRustLifecycleTestEvidence {
  schemaVersion: 1;
  kind: "codex-rust-lifecycle-tests";
  sourceCommit: string;
  patchedTreeSha256: string;
  cargoLockSha256: string;
  command: readonly string[];
  exitCode: 0;
  passedTests: readonly string[];
  stdoutFile: string;
  stdoutSha256: string;
  stderrFile: string;
  stderrSha256: string;
  candidateBinarySha256: string;
  startedAt: string;
  completedAt: string;
}

export interface SignatureEvidence {
  identity: string;
  teamIdentifier: string | null;
  designatedRequirement: string | null;
}

export interface ArtifactEvidence {
  source: string;
  platform: string;
  architecture: string;
  version: string;
  digests: readonly NamedDigest[];
  signature: SignatureEvidence | null;
}

export interface FrontendControlEvidence extends ArtifactEvidence {
  bundleId: string;
  build: string;
  embeddedBackendVersion: string;
  embeddedBackendDigests: readonly NamedDigest[];
}

export interface WatcherPromotionEvidence {
  previousFingerprints: Readonly<Record<string, string>>;
  promotedFingerprints: Readonly<Record<string, string>>;
  pauseTokenDigest: NamedDigest | null;
  expectedFingerprintUpdatedAt: string | null;
  rearmedAt: string | null;
  wasEnabled: boolean;
}

export interface CodexCanaryEvidenceReference {
  schemaVersion: 1;
  kind: "codex-source-canary-reference";
  sidecarPath: string;
  sidecarSha256: string;
  candidatePath: string;
  candidateSha256: string;
  managedMcpOverlaySha256?: string;
  managedMcpFleetFingerprint?: string;
  trustedRunnerIdentity?: string;
  trustedRunnerAttestationSha256?: string;
  trustedObservationAdapterIdentity?: string;
  trustedObservationAdapterAttestationSha256?: string;
  startedAt: string;
  completedAt: string;
}

export interface CodexDerivedReceipt {
  schemaVersion: typeof CODEX_DERIVED_RECEIPT_SCHEMA_VERSION;
  kind: "codex-derived";
  transactionId: string;
  phase: CodexDerivedPhase;
  channel: CodexSourceChannel;
  version: string;
  label: string;
  resolution: CodexResolutionEvidence;
  source: CodexSourceEvidence;
  dependencies: readonly LockedDependencyEvidence[];
  frontendControl: FrontendControlEvidence;
  controlBinary: ArtifactEvidence;
  candidateBinary: ArtifactEvidence;
  /** Required for complete on-demand rollout receipts; absent only on legacy schema-v2 evidence. */
  managedMcp?: ManagedMcpPreparedRuntimeEvidence;
  trustedCanaryRunner?: CodexTrustedSourceEvidence;
  trustedCanaryAdapter?: CodexTrustedSourceEvidence;
  rustLifecycleTests?: CodexRustLifecycleTestEvidence;
  /** Present on source-build receipts; omitted only for older schema-v2 receipts. */
  canary?: CodexCanaryEvidenceReference | null;
  watcher: WatcherPromotionEvidence;
  supersedes: string | null;
  supersededBy: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
  soakCompletedAt: string | null;
  rolledBackAt: string | null;
}

export type CodexReceiptTransitionTarget =
  | "promoting"
  | "promoted"
  | "soaking"
  | "completed"
  | "rolling-back"
  | "rolled-back"
  | "failed";

export interface CodexReceiptTransitionInput {
  receiptFile: string;
  to: CodexReceiptTransitionTarget;
  now?: string;
  error?: string;
  watcher?: Partial<WatcherPromotionEvidence>;
}

/** The compact receipt emitted by the pre-channel prototype. */
export interface LegacyCodexDerivedReceiptV1 {
  schemaVersion: 1;
  kind: "codex-derived";
  transactionId: string;
  phase: string;
  version: string;
  tag: string;
  commit: string;
  createdAt: string;
  updatedAt: string;
}

export type ReadableCodexDerivedReceipt = CodexDerivedReceipt | LegacyCodexDerivedReceiptV1;

export interface CodexResolutionCycleState {
  channel: CodexSourceChannel;
  status: "active" | "frozen" | "superseded";
  candidate: CodexResolutionCheckpoint;
  checkpoints: readonly CodexResolutionCheckpoint[];
  restartWindow: RestartWindow | null;
  frozenAt: string | null;
  supersededBy: CodexResolutionCheckpoint | null;
  newerAvailable: CodexResolutionCheckpoint | null;
}

export function codexDerivedLabel(channel: CodexSourceChannel, version: string): string {
  if (!parseSemver(version)) throw new Error(`Invalid Codex derived version: ${version}`);
  return channel === "bundled"
    ? `${version} · desktop-bundled-derived`
    : `${version} · ${channel}-derived`;
}

export function createCodexResolutionCycle(checkpoint: CodexResolutionCheckpoint): CodexResolutionCycleState {
  assertCheckpoint(checkpoint);
  if (checkpoint.name !== "R1") throw new Error("A Codex resolution cycle must begin at R1");
  return {
    channel: channelForCheckpoint(checkpoint),
    status: "active",
    candidate: checkpoint,
    checkpoints: [checkpoint],
    restartWindow: null,
    frozenAt: null,
    supersededBy: null,
    newerAvailable: null,
  };
}

/**
 * Record the source-tree/build/pre-promotion identity gates. A newer version
 * before R3 supersedes the cycle; R3 freezes only an unchanged candidate.
 */
export function recordCodexResolutionCheckpoint(
  state: CodexResolutionCycleState,
  checkpoint: CodexResolutionCheckpoint,
  options: { restartWindow?: RestartWindow; now?: string } = {},
): CodexResolutionCycleState {
  assertCheckpoint(checkpoint);
  if (state.status !== "active") throw new Error(`Cannot record ${checkpoint.name} on a ${state.status} cycle`);
  if (channelForCheckpoint(checkpoint) !== state.channel) throw new Error("Codex resolution channel changed within a cycle");

  const expected = state.checkpoints.length === 1 ? "R2" : state.checkpoints.length === 2 ? "R3" : null;
  if (checkpoint.name !== expected) {
    const existing = state.checkpoints.find((item) => item.name === checkpoint.name);
    if (existing && checkpointIdentityEqual(existing, checkpoint)) return state;
    throw new Error(`Expected ${expected ?? "no further checkpoint"}, received ${checkpoint.name}`);
  }

  assertTagIdentityStable([...state.checkpoints, checkpoint].map(tagIdentity));
  const comparison = compareSemverPrecedence(checkpoint.normalizedVersion, state.candidate.normalizedVersion);
  if (comparison < 0) {
    throw new Error(
      `Codex resolution moved backward from ${state.candidate.normalizedVersion} to ${checkpoint.normalizedVersion}`,
    );
  }
  if (comparison === 0 && !checkpointIdentityEqual(state.candidate, checkpoint)) {
    throw new Error("Codex release identity changed without a semantic-version increase");
  }
  if (comparison > 0) {
    return {
      ...state,
      status: "superseded",
      supersededBy: checkpoint,
      checkpoints: [...state.checkpoints, checkpoint],
    };
  }

  const checkpoints = [...state.checkpoints, checkpoint];
  if (checkpoint.name !== "R3") return { ...state, checkpoints };
  const restartWindow = options.restartWindow;
  if (!restartWindow) throw new Error("R3 requires an approved restart window");
  const now = options.now ?? checkpoint.checkedAt;
  assertRestartWindow(restartWindow, now);
  return {
    ...state,
    status: "frozen",
    checkpoints,
    restartWindow,
    frozenAt: now,
  };
}

/** A post-freeze detector may report a newer release, but cannot supersede the frozen transaction. */
export function observeCodexReleaseAfterFreeze(
  state: CodexResolutionCycleState,
  observed: CodexResolutionCheckpoint,
): CodexResolutionCycleState {
  assertCheckpoint(observed);
  if (state.status !== "frozen") throw new Error("Newer-available deferral requires a frozen resolution cycle");
  assertTagIdentityStable([...state.checkpoints, observed].map(tagIdentity));
  if (compareSemverPrecedence(observed.normalizedVersion, state.candidate.normalizedVersion) <= 0) return state;
  return { ...state, newerAvailable: observed };
}

export function resolutionEvidenceFromCycle(
  state: CodexResolutionCycleState,
  requestedApiVersion: string,
): CodexResolutionEvidence {
  if (state.status !== "frozen" || !state.frozenAt || !state.restartWindow) {
    throw new Error("Only a frozen R1/R2/R3 cycle can become receipt resolution evidence");
  }
  const selected = state.checkpoints[state.checkpoints.length - 1]!;
  return {
    endpoint: selected.endpoint,
    requestedApiVersion,
    resolvedTag: selected.resolvedTag,
    normalizedVersion: selected.normalizedVersion,
    peeledCommit: selected.peeledCommit,
    checkedAt: selected.checkedAt,
    etag: selected.etag,
    responseBodySha256: selected.responseBodySha256 ?? null,
    tagObjectShas: selected.tagObjectShas,
    checkpoints: state.checkpoints,
    restartWindow: state.restartWindow,
    frozenAt: state.frozenAt,
  };
}

export function linkCodexReceiptSupersession(
  older: CodexDerivedReceipt,
  newer: CodexDerivedReceipt,
  now: string,
): { older: CodexDerivedReceipt; newer: CodexDerivedReceipt } {
  if (!isCodexDerivedReceipt(older) || !isCodexDerivedReceipt(newer)) {
    throw new Error("Cannot link invalid Codex derived receipts");
  }
  if (older.transactionId === newer.transactionId) throw new Error("A Codex receipt cannot supersede itself");
  if (older.channel !== newer.channel) throw new Error("Cross-channel receipts cannot be linked as supersession");
  if (compareSemverPrecedence(newer.version, older.version) <= 0) {
    throw new Error("A superseding Codex receipt must have higher semantic-version precedence");
  }
  return {
    older: {
      ...older,
      phase: "superseded",
      supersededBy: newer.transactionId,
      updatedAt: now,
    },
    newer: {
      ...newer,
      supersedes: older.transactionId,
      updatedAt: now,
    },
  };
}

export function readCodexDerivedReceipt(file: string): ReadableCodexDerivedReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Codex derived receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  if (!isReadableCodexDerivedReceipt(value)) throw new Error(`Codex derived receipt is invalid at ${file}`);
  return value;
}

export function writeCodexDerivedReceipt(file: string, receipt: CodexDerivedReceipt): void {
  if (!isCodexDerivedReceipt(receipt)) throw new Error("Refusing to write an invalid Codex derived receipt");
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    fsyncDirectory(dirname(file));
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

/**
 * Atomically advances the source-derived receipt through promotion, soak, or
 * rollback. The channel current pointer is published only after a full 24-hour
 * soak completes.
 */
export function transitionCodexDerivedReceipt(input: CodexReceiptTransitionInput): CodexDerivedReceipt {
  const readable = readCodexDerivedReceipt(input.receiptFile);
  if (!readable || readable.schemaVersion !== CODEX_DERIVED_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Codex derived receipt is missing or is not schema v2 at ${input.receiptFile}`);
  }
  const receipt = readable;
  const now = input.now ?? new Date().toISOString();
  if (!timestamp(now)) throw new Error("Codex receipt transition timestamp is invalid");
  const legal: Readonly<Record<CodexReceiptTransitionTarget, readonly CodexDerivedPhase[]>> = {
    promoting: ["canary-passed"],
    promoted: ["promoting"],
    soaking: ["promoted"],
    completed: ["soaking"],
    "rolling-back": ["canary-passed", "promoting", "promoted", "soaking", "failed"],
    "rolled-back": ["rolling-back"],
    failed: ["canary-passed", "promoting", "promoted", "soaking", "rolling-back"],
  };
  if (!legal[input.to].includes(receipt.phase)) {
    throw new Error(`Illegal Codex receipt transition ${receipt.phase} -> ${input.to}`);
  }
  if (input.to === "failed" && (!input.error || input.error.trim().length === 0)) {
    throw new Error("A failed Codex receipt transition requires an error");
  }
  if (input.to === "completed") {
    if (!receipt.promotedAt || Date.parse(now) - Date.parse(receipt.promotedAt) < 24 * 60 * 60 * 1_000) {
      throw new Error("Codex derived receipt requires a full 24-hour soak before completion");
    }
  }
  if (input.to === "promoting" && receipt.managedMcp) {
    assertManagedMcpPreparedRuntimeEvidence(receipt.managedMcp);
  }
  const next: CodexDerivedReceipt = {
    ...receipt,
    phase: input.to,
    watcher: { ...receipt.watcher, ...(input.watcher ?? {}) },
    error: input.to === "failed" ? input.error!.trim() : receipt.error,
    updatedAt: now,
    promotedAt: input.to === "promoted" ? now : receipt.promotedAt,
    soakCompletedAt: input.to === "completed" ? now : receipt.soakCompletedAt,
    rolledBackAt: input.to === "rolled-back" ? now : receipt.rolledBackAt,
  };
  writeCodexDerivedReceipt(input.receiptFile, next);
  if (input.to === "completed") {
    const codexSourceRoot = dirname(dirname(input.receiptFile));
    writeCodexDerivedReceipt(join(codexSourceRoot, `current-${next.channel}.json`), next);
  }
  return next;
}

export function isReadableCodexDerivedReceipt(value: unknown): value is ReadableCodexDerivedReceipt {
  return isCodexDerivedReceipt(value) || isLegacyCodexDerivedReceipt(value);
}

export function isCodexDerivedReceipt(value: unknown): value is CodexDerivedReceipt {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== CODEX_DERIVED_RECEIPT_SCHEMA_VERSION
    || value.kind !== "codex-derived"
    || !nonEmptyString(value.transactionId)
    || !CODEX_DERIVED_PHASES.includes(value.phase as CodexDerivedPhase)
    || (value.channel !== "bundled" && value.channel !== "stable" && value.channel !== "edge")
    || !validSemver(value.version)
    || value.label !== codexDerivedLabel(value.channel as CodexSourceChannel, value.version as string)
    || !isResolutionEvidence(value.resolution)
    || !isSourceEvidence(value.source)
    || !Array.isArray(value.dependencies)
    || !value.dependencies.every(isDependencyEvidence)
    || !isFrontendEvidence(value.frontendControl)
    || !isArtifactEvidence(value.controlBinary)
    || !isArtifactEvidence(value.candidateBinary)
    || (value.managedMcp !== undefined && !managedMcpPreparedRuntimeEvidenceShapeIsValid(value.managedMcp))
    || (value.trustedCanaryRunner !== undefined && !isTrustedSourceEvidence(value.trustedCanaryRunner))
    || (value.trustedCanaryAdapter !== undefined && !isTrustedSourceEvidence(value.trustedCanaryAdapter))
    || (value.rustLifecycleTests !== undefined && !isRustLifecycleTestEvidence(value.rustLifecycleTests))
    || !isOptionalCanaryReference(value.canary)
    || !isWatcherEvidence(value.watcher)
    || !nullableString(value.supersedes)
    || !nullableString(value.supersededBy)
    || !nullableString(value.error)
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || !nullableTimestamp(value.promotedAt)
    || !nullableTimestamp(value.soakCompletedAt)
    || !nullableTimestamp(value.rolledBackAt)
  ) return false;
  if (
    ["canary-passed", "promoting", "promoted", "soaking", "completed"].includes(value.phase as string)
    && (!isCanaryReference(value.canary)
      || (value.managedMcp !== undefined
        && (!isTrustedSourceEvidence(value.trustedCanaryRunner)
          || !isTrustedSourceEvidence(value.trustedCanaryAdapter)
          || !isRustLifecycleTestEvidence(value.rustLifecycleTests))))
  ) return false;
  const resolution = value.resolution as CodexResolutionEvidence;
  return resolution.normalizedVersion === value.version
    && (value.source as CodexSourceEvidence).checkoutCommit === resolution.peeledCommit
    && (value.candidateBinary as ArtifactEvidence).version === value.version
    && resolution.checkpoints.length === 3
    && resolution.checkpoints.map((item) => item.name).join(",") === "R1,R2,R3"
    && resolution.checkpoints.every((item) => item.channel === value.channel);
}

function isTrustedSourceEvidence(value: unknown): value is CodexTrustedSourceEvidence {
  return isRecord(value) && nonEmptyString(value.sourcePath) && validDigestValue(value.sha256, 64);
}

function isRustLifecycleTestEvidence(value: unknown): value is CodexRustLifecycleTestEvidence {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.kind === "codex-rust-lifecycle-tests"
    && validCommit(value.sourceCommit)
    && validDigestValue(value.patchedTreeSha256, 64)
    && validDigestValue(value.cargoLockSha256, 64)
    && Array.isArray(value.command)
    && value.command.every(nonEmptyString)
    && value.exitCode === 0
    && Array.isArray(value.passedTests)
    && value.passedTests.every(nonEmptyString)
    && nonEmptyString(value.stdoutFile)
    && validDigestValue(value.stdoutSha256, 64)
    && nonEmptyString(value.stderrFile)
    && validDigestValue(value.stderrSha256, 64)
    && validDigestValue(value.candidateBinarySha256, 64)
    && timestamp(value.startedAt)
    && timestamp(value.completedAt)
    && Date.parse(value.startedAt as string) <= Date.parse(value.completedAt as string);
}

function isOptionalCanaryReference(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return isCanaryReference(value);
}

function isCanaryReference(value: unknown): value is CodexCanaryEvidenceReference {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.kind === "codex-source-canary-reference"
    && nonEmptyString(value.sidecarPath)
    && validDigestValue(value.sidecarSha256, 64)
    && nonEmptyString(value.candidatePath)
    && validDigestValue(value.candidateSha256, 64)
    && legacyOrManagedCanaryReference(value)
    && timestamp(value.startedAt)
    && timestamp(value.completedAt)
    && Date.parse(value.startedAt as string) <= Date.parse(value.completedAt as string);
}

function legacyOrManagedCanaryReference(value: Record<string, unknown>): boolean {
  const fields = [
    value.managedMcpOverlaySha256,
    value.managedMcpFleetFingerprint,
    value.trustedRunnerIdentity,
    value.trustedRunnerAttestationSha256,
    value.trustedObservationAdapterIdentity,
    value.trustedObservationAdapterAttestationSha256,
  ];
  if (fields.every((field) => field === undefined)) return true;
  return validDigestValue(value.managedMcpOverlaySha256, 64)
    && typeof value.managedMcpFleetFingerprint === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value.managedMcpFleetFingerprint)
    && nonEmptyString(value.trustedRunnerIdentity)
    && validDigestValue(value.trustedRunnerAttestationSha256, 64)
    && nonEmptyString(value.trustedObservationAdapterIdentity)
    && validDigestValue(value.trustedObservationAdapterAttestationSha256, 64);
}

function isLegacyCodexDerivedReceipt(value: unknown): value is LegacyCodexDerivedReceiptV1 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.kind === "codex-derived"
    && nonEmptyString(value.transactionId)
    && nonEmptyString(value.phase)
    && validSemver(value.version)
    && typeof value.tag === "string"
    && parseCodexReleaseTag(value.tag) !== null
    && validCommit(value.commit)
    && timestamp(value.createdAt)
    && timestamp(value.updatedAt);
}

function isResolutionEvidence(value: unknown): value is CodexResolutionEvidence {
  if (!isRecord(value)) return false;
  if (
    !nonEmptyString(value.endpoint)
    || !nonEmptyString(value.requestedApiVersion)
    || !nonEmptyString(value.resolvedTag)
    || !parseCodexReleaseTag(value.resolvedTag)
    || !validSemver(value.normalizedVersion)
    || !validCommit(value.peeledCommit)
    || !timestamp(value.checkedAt)
    || !nullableString(value.etag)
    || !nullableDigestValue(value.responseBodySha256, 64)
    || !validCommitList(value.tagObjectShas)
    || !Array.isArray(value.checkpoints)
    || !value.checkpoints.every(isCheckpoint)
    || !isRestartWindow(value.restartWindow)
    || !timestamp(value.frozenAt)
  ) return false;
  const parsed = parseCodexReleaseTag(value.resolvedTag);
  if (!parsed || parsed.normalized !== value.normalizedVersion) return false;
  const checkpoints = value.checkpoints as CodexResolutionCheckpoint[];
  if (!checkpoints.every((checkpoint) =>
    checkpoint.resolvedTag === value.resolvedTag
    && checkpoint.normalizedVersion === value.normalizedVersion
    && checkpoint.peeledCommit === value.peeledCommit
  )) return false;
  try {
    assertTagIdentityStable(checkpoints.map(tagIdentity));
  } catch {
    return false;
  }
  return true;
}

function isCheckpoint(value: unknown): value is CodexResolutionCheckpoint {
  if (!isRecord(value)) return false;
  if (
    (value.name !== "R1" && value.name !== "R2" && value.name !== "R3")
    || (value.channel !== "bundled" && value.channel !== "stable" && value.channel !== "edge")
    || !nonEmptyString(value.endpoint)
    || typeof value.resolvedTag !== "string"
    || !parseCodexReleaseTag(value.resolvedTag)
    || !validSemver(value.normalizedVersion)
    || !validCommit(value.peeledCommit)
    || !timestamp(value.checkedAt)
    || !nullableString(value.etag)
    || !validCommitList(value.tagObjectShas)
  ) return false;
  if (value.responseBodySha256 !== undefined && !nullableDigestValue(value.responseBodySha256, 64)) return false;
  return parseCodexReleaseTag(value.resolvedTag)?.normalized === value.normalizedVersion;
}

function isSourceEvidence(value: unknown): value is CodexSourceEvidence {
  return isRecord(value)
    && nonEmptyString(value.repository)
    && validCommit(value.checkoutCommit)
    && (value.archiveDigest === null || isNamedDigest(value.archiveDigest))
    && isNamedDigest(value.treeDigest)
    && isNamedDigest(value.patchSeriesDigest)
    && Array.isArray(value.toolchainDigests)
    && value.toolchainDigests.every(isNamedDigest)
    && Array.isArray(value.lockfileDigests)
    && value.lockfileDigests.every(isNamedDigest);
}

function isDependencyEvidence(value: unknown): value is LockedDependencyEvidence {
  return isRecord(value)
    && nonEmptyString(value.name)
    && nonEmptyString(value.version)
    && nonEmptyString(value.integrity)
    && nullableString(value.entrypoint)
    && Array.isArray(value.contentDigests)
    && value.contentDigests.every(isNamedDigest);
}

function isArtifactEvidence(value: unknown): value is ArtifactEvidence {
  return isRecord(value)
    && nonEmptyString(value.source)
    && nonEmptyString(value.platform)
    && nonEmptyString(value.architecture)
    && nonEmptyString(value.version)
    && Array.isArray(value.digests)
    && value.digests.length > 0
    && value.digests.every(isNamedDigest)
    && (value.signature === null || isSignatureEvidence(value.signature));
}

function isFrontendEvidence(value: unknown): value is FrontendControlEvidence {
  if (!isArtifactEvidence(value)) return false;
  const frontend = value as ArtifactEvidence & Record<string, unknown>;
  return nonEmptyString(frontend.bundleId)
    && nonEmptyString(frontend.build)
    && nonEmptyString(frontend.embeddedBackendVersion)
    && Array.isArray(frontend.embeddedBackendDigests)
    && frontend.embeddedBackendDigests.length > 0
    && frontend.embeddedBackendDigests.every(isNamedDigest);
}

function isSignatureEvidence(value: unknown): value is SignatureEvidence {
  return isRecord(value)
    && nonEmptyString(value.identity)
    && nullableString(value.teamIdentifier)
    && nullableString(value.designatedRequirement);
}

function isWatcherEvidence(value: unknown): value is WatcherPromotionEvidence {
  return isRecord(value)
    && stringRecord(value.previousFingerprints)
    && stringRecord(value.promotedFingerprints)
    && (value.pauseTokenDigest === null || isNamedDigest(value.pauseTokenDigest))
    && nullableTimestamp(value.expectedFingerprintUpdatedAt)
    && nullableTimestamp(value.rearmedAt)
    && typeof value.wasEnabled === "boolean";
}

function isNamedDigest(value: unknown): value is NamedDigest {
  if (!isRecord(value) || (value.algorithm !== "sha256" && value.algorithm !== "sha512") || !nonEmptyString(value.scope)) {
    return false;
  }
  return validDigestValue(value.value, value.algorithm === "sha256" ? 64 : 128);
}

function assertCheckpoint(value: CodexResolutionCheckpoint): void {
  if (!isCheckpoint(value)) throw new Error("Invalid Codex resolution checkpoint");
}

function channelForCheckpoint(checkpoint: CodexResolutionCheckpoint): CodexSourceChannel {
  return checkpoint.channel;
}

function checkpointIdentityEqual(a: CodexResolutionCheckpoint, b: CodexResolutionCheckpoint): boolean {
  return a.resolvedTag === b.resolvedTag
    && a.normalizedVersion === b.normalizedVersion
    && a.peeledCommit === b.peeledCommit;
}

function tagIdentity(checkpoint: CodexResolutionCheckpoint): TagPeelIdentity {
  return {
    tag: checkpoint.resolvedTag,
    refSha: checkpoint.tagObjectShas[0] ?? checkpoint.peeledCommit,
    tagObjectShas: checkpoint.tagObjectShas,
    peeledCommit: checkpoint.peeledCommit,
  };
}

function assertRestartWindow(window: RestartWindow, now: string): void {
  if (!isRestartWindow(window) || !timestamp(now)) throw new Error("Invalid restart window");
  const instant = Date.parse(now);
  if (instant < Date.parse(window.opensAt) || instant > Date.parse(window.closesAt)) {
    throw new Error("R3 occurred outside the approved restart window");
  }
}

function isRestartWindow(value: unknown): value is RestartWindow {
  return isRecord(value)
    && timestamp(value.opensAt)
    && timestamp(value.closesAt)
    && Date.parse(value.opensAt) <= Date.parse(value.closesAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function validSemver(value: unknown): value is string {
  return typeof value === "string" && parseSemver(value) !== null;
}

function validCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function validCommitList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(validCommit);
}

function nullableDigestValue(value: unknown, length: number): value is string | null {
  return value === null || (typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value));
}

function validDigestValue(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value);
}

function stringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

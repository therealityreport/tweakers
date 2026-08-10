import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeaderHash } from "./asar.js";
import { copyDirectoryPreservingModes, isMacOsJunkName } from "./fs-copy.js";
import { desktopVersionAdvanced } from "./desktop-version.js";
import {
  commitVerifiedOfficialDesktop,
  officialAdoptionError,
  proveVerifiedOfficialDesktop,
  type AdoptedOfficialDesktop,
  type VerifiedOfficialDesktopProof,
} from "./adopt-official-desktop.js";
import {
  observeCodexMainProcess,
  openAndActivateCodex,
  quitCodexMainProcess,
  type CodexMainProcessObservation,
} from "./alerts.js";
import {
  isEnvironmentSelection,
  ALPHA_DESKTOP_PATH,
  loadEnvironmentState,
  fingerprintAppContents,
  publishEnvironmentSelection,
  readEnvironmentProfileRegistry,
  validateOfficialEnvironmentProfile,
  writeEnvironmentProfileRegistry,
  writeEnvironmentSelection,
  type AppExperience,
  type BackendLane,
  type EnvironmentProfileRecord,
  type EnvironmentProfileRegistry,
  type EnvironmentSelection,
  type ReleaseProfile,
  STABLE_DESKTOP_PATH,
} from "./environment-profile.js";
import { readConfigFile } from "./config.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import {
  bundledDerivedBackendPath,
  buildPatchedCandidateOnly,
  loadVerifiedSwapHost,
  readAsarMarker,
  replaceAppBundlePreservingIdentity,
  stageAssets,
  stagePreparedSwapHost,
  stagedNativeHostPath,
  verifyStagedNativeHostForApp,
} from "./commands/install.js";
import {
  readValidatedBundledDerivedArtifact,
  type ValidatedBundledDerivedArtifact,
} from "./commands/codex-source.js";
import { terminateStaleHelperProcesses } from "./orphans.js";
import { userPaths } from "./paths.js";
import { LEGACY_USER_ROOT_ENV } from "./legacy-compat.js";
import { readPlist } from "./plist.js";
import { acquireProcessLock, processAlive } from "./process-lock.js";
import { assertLifecycleReceiptsIdle, withLifecycleLock } from "./lifecycle-lock.js";
import { createMcpModeBridge } from "./mcp-mode-bridge.js";
import { assertInternalStoragePath } from "./internal-storage.js";
import { targetUserHome } from "./ownership.js";
import { readState, writeState } from "./state.js";
import { cloneAppTree } from "./transaction.js";
import {
  beginWatcherPromotion,
  finishWatcherPromotion,
} from "./watcher-promotion.js";
import { payloadMetadataFile, writePayloadMetadata } from "./mode-transition.js";
import {
  fingerprintManagedRuntimeControlPlane,
  fingerprintManagedRuntimeSource,
  managedSourceRoot,
  sanitizeManagedRuntimeSymlinks,
  stageManagedRuntime,
  type ManagedRuntimeProvenance,
} from "./managed-runtime.js";
import { getLocalRefreshStatus, hashTree } from "./commands/refresh-local.js";
import { readRuntimeFingerprintEvidence, type RuntimeTreeFingerprint } from "./runtime-fingerprint.js";
import { findSourceRoot } from "./source-root.js";

export const ENVIRONMENT_TRANSACTION_SCHEMA_VERSION = 1 as const;

export function defaultCodexMcpConfigFile(home: string = targetUserHome()): string {
  return join(home, ".codex", "config.toml");
}

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
  /** Null when the exact source app was closed during preparation. */
  oldMainPid: number | null;
  newMainPid: number | null;
  attempt: number;
  /**
   * Last durably-stamped sub-step of applyPreparedEnvironment, formatted
   * `<direction>:<step>` (e.g. `requested:bundle-swap-start`). Forensic
   * evidence only: a stamp proves a step STARTED, never that it completed,
   * so recovery predicates must not treat it as byte-state authority.
   * Optional and additive — schemaVersion stays 1; legacy receipts omit it,
   * and legacy binaries that rebuild receipts as fresh literals may drop it.
   */
  applyProgress?: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  rolledBackAt: string | null;
  cancelledAt: string | null;
}

export interface PrepareEnvironmentInput {
  current: EnvironmentSelection;
  requested: EnvironmentSelection;
}

export interface EnvironmentDesktopObservation extends CodexMainProcessObservation {}

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
  /**
   * Electron integrity hash for the exact app.asar carried by this candidate.
   * Absent on legacy receipts written before integrity evidence existed; only
   * terminal-phase receipts may omit it.
   */
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
  /**
   * Electron integrity hash for the exact rollback app.asar. Absent on legacy
   * receipts written before integrity evidence existed.
   */
  desktopAsarHeaderHash?: string;
  /** Additive schema-v1 trust evidence; newly prepared receipts always include it. */
  signature?: PreparedCandidateSignatureEvidence;
  backendLane: BackendLane;
  backendBinaryPath: string;
  backendArtifactPath: string;
  backendVersion: string;
  backendArtifactDigest: string;
}

/**
 * The atomic bundle exchange needs a signed `renameatx_np` addon, but neither
 * app payload is a dependable source: a pristine→pristine restore carries no
 * Tweakers host at all, and loading one out of the live app or the repository
 * would tie recovery to bytes the transaction does not own. Every transaction
 * therefore copies one signed host into its own receipt directory and records
 * exactly what it copied, so rollback depends only on rollback artifacts plus
 * this helper.
 */
export interface PreparedSwapHostEvidence {
  /** Receipt-owned path; always inside the transaction's prepared root. */
  path: string;
  /** The prepared payload the host was copied out of, for provenance only. */
  sourceAppPath: string;
  digest: string;
  strict: boolean;
  designatedRequirement: string;
  teamIdentifier: string | null;
  authority: string[];
  certificateLeafHash: string | null;
}

export interface PreparedEnvironmentEvidence {
  preparedAt: string;
  candidate: PreparedDesktopCandidateEvidence;
  backend: PreparedBackendEvidence;
  /**
   * Additive schema-v1 evidence. Newly prepared receipts always include it;
   * legacy receipts migrate on first recovery (see `migrateLegacySwapHost`).
   */
  swapHost?: PreparedSwapHostEvidence;
  /**
   * Runtime evidence is additive for schema-v1 compatibility. Every newly
   * prepared transaction involving Tweakers must include both runtime stores;
   * legacy receipts remain readable so they can be cancelled or inspected.
   */
  runtime?: PreparedRuntimeEvidence;
  managedRuntime?: PreparedManagedRuntimeEvidence;
  rollback: PreparedRollbackEvidence;
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
  /** Additive schema-v1 evidence; newly prepared receipts always include both fields. */
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

export interface EnvironmentAppliedEvidence {
  observedAt: string;
  selection: EnvironmentSelection;
  desktopVersion: string;
  desktopBuild: string;
  backendVersion: string;
  desktopArtifactDigest: string;
  /**
   * Re-observed Electron integrity hash for the running app.asar. Absent on
   * legacy receipts written before integrity evidence existed.
   */
  asarHeaderHash?: string;
  backendArtifactDigest: string;
  runtimeArtifactDigest?: string;
  managedRuntimeArtifactDigest?: string;
}

export interface EnvironmentRuntimeProof {
  schemaVersion: 2;
  kind: "environment-runtime-proof";
  pid: number;
  appRoot: string;
  bundleId: EnvironmentSelection["selectedDesktopBundleId"];
  desktopVersion: string;
  desktopBuild: string;
  appAsarHeaderHash: string;
  appExperience: "tweakers";
  releaseProfile: ReleaseProfile;
  backendLane: "bundled" | "managed-alpha";
  binaryPath: string;
  backendVersion: string;
  backendFingerprint: string;
  runtimePath: string;
  runtimeFingerprint: string;
  runtimeFileCount: number;
  managedRuntimePath: string;
  managedRuntimeFingerprint: string;
  managedRuntimeFileCount: number;
  managedSourceRuntimeHash: string | null;
  observedAt: string;
}

export interface EnvironmentVerification {
  ok: boolean;
  observedPid: number | null;
  visibleWindow: boolean;
  appliedSelection: EnvironmentSelection | null;
  appliedEvidence: EnvironmentAppliedEvidence | null;
  error: string | null;
}

export interface EnvironmentCoordinator {
  prepare(input: PrepareEnvironmentInput): Promise<EnvironmentTransactionReceipt>;
  commit(transactionId?: string): Promise<EnvironmentTransactionReceipt>;
  status(): EnvironmentTransactionReceipt | null;
  verify(transactionId?: string): Promise<EnvironmentVerification>;
  rollback(transactionId?: string): Promise<EnvironmentTransactionReceipt>;
  cancel(transactionId?: string): Promise<EnvironmentTransactionReceipt>;
  /**
   * Resolve a stranded receipt from live proof alone, without replacing any
   * bytes. Rollback restores what the receipt recorded; recovery instead asks
   * what the machine can currently prove — which is the only safe answer once
   * the official desktop has updated underneath a failed transaction.
   */
  recover(transactionId?: string): Promise<EnvironmentTransactionReceipt>;
}

export interface EnvironmentCoordinatorOptions {
  environmentRoot?: string;
  transactionFile?: string;
  receiptRoot?: string;
  selectionFile?: string;
  registryFile?: string;
  configFile?: string;
  stateFile?: string;
  runtimeProofFile?: string;
  mcpStateFile?: string;
  tweaksRoot?: string;
  mcpConfigFile?: string;
  lockFile?: string;
  lifecycleLockFile?: string;
  watcherPromotionFile?: string;
  bundledDerivedReceiptFile?: string;
  verificationPolls?: number;
  verificationIntervalMs?: number;
}

export interface EnvironmentCoordinatorDeps {
  now?: () => string;
  createId?: () => string;
  preparePrerequisites?: (input: {
    transactionId: string;
    current: EnvironmentSelection;
    requested: EnvironmentSelection;
    oldMainPid: number | null;
  }) => PreparedEnvironmentEvidence | Promise<PreparedEnvironmentEvidence>;
  stagePreparedEnvironment?: (input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
  }) => void | Promise<void>;
  applyPreparedEnvironment?: (input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
    /** Durably stamp a sub-step before it executes; see applyProgress. */
    onProgress?: (step: string) => void;
  }) => void | Promise<void>;
  validatePreparedEnvironment?: (input: {
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
    direction?: "requested" | "rollback";
  }) => void | Promise<void>;
  /**
   * Bring a schema-v1 receipt prepared before receipt-owned swap evidence up to
   * date. Returns the staged evidence, or null when neither prepared payload
   * carries a native host.
   */
  migrateSwapHost?: (input: {
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
  }) => PreparedSwapHostEvidence | null | Promise<PreparedSwapHostEvidence | null>;
  /** Prove a newer live official desktop without changing durable state. */
  proveOfficialDesktop?: (input: {
    selection: EnvironmentSelection;
    baseline: { marketingVersion: string | null; build: string | null };
    excludedMainPid: number | null;
  }) => VerifiedOfficialDesktopProof | null | Promise<VerifiedOfficialDesktopProof | null>;
  /** Commit an unchanged proof after the coordinator has serialized recovery. */
  commitOfficialDesktop?: (input: {
    selection: EnvironmentSelection;
    baseline: { marketingVersion: string | null; build: string | null };
    excludedMainPid: number | null;
    proof: VerifiedOfficialDesktopProof;
  }) => AdoptedOfficialDesktop | Promise<AdoptedOfficialDesktop>;
  observeDesktop?: (path: string) => EnvironmentDesktopObservation | null | Promise<EnvironmentDesktopObservation | null>;
  quitDesktop?: (path: string, expectedPid: number) => void | Promise<void>;
  processAlive?: (pid: number) => boolean;
  cleanupHelpers?: (path: string, stoppedMainPid: number) => void | Promise<void>;
  reopenDesktop?: (path: string) => void | Promise<void>;
  pauseWatcher?: (input: {
    transactionId: string;
    sourceAppRoot: string;
    requestedAppRoot: string;
    sourceExpectedFingerprint: string;
  }) => void | Promise<void>;
  resumeWatcher?: (input: {
    transactionId: string;
    targetAppRoot: string;
    targetExpectedFingerprint: string;
  }) => void | Promise<void>;
  /** Backward-compatible test seam; production uses the durable pause/resume receipt. */
  refreshWatcher?: (path: string) => void | Promise<void>;
  proveAppliedEnvironment?: (input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    expected: EnvironmentSelection;
    observation: EnvironmentDesktopObservation;
    prepared: PreparedEnvironmentEvidence;
  }) => EnvironmentAppliedEvidence | null | Promise<EnvironmentAppliedEvidence | null>;
  publishSelection?: (selection: EnvironmentSelection) => void | Promise<void>;
  /**
   * Durably binds the watcher-facing installer state to the proven target
   * before the watcher is allowed to resume.
   */
  bindWatcherTarget?: (input: {
    direction: "requested" | "rollback";
    applied: EnvironmentAppliedEvidence;
    prepared: PreparedEnvironmentEvidence;
  }) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DefaultEnvironmentAdapterOptions {
  registryFile: string;
  receiptRoot: string;
  configFile: string;
  stateFile: string;
  selectionFile?: string;
  environmentRoot?: string;
  runtimeProofFile?: string;
  mcpModeHelperFile?: string;
  mcpConfigFile?: string;
  mcpStateFile?: string;
  tweaksRoot?: string;
  sourceRoot?: string;
  /**
   * Explicit opt-in receipt for a backend derived from the exact Codex tag
   * bundled in the installed desktop. It remains on the bundled lane.
   */
  bundledDerivedReceiptFile?: string;
}

export interface DefaultEnvironmentAdapterDeps {
  cloneApp?: (source: string, destination: string) => void;
  replaceApp?: (
    source: string,
    destination: string,
    validate: (destination: string) => boolean,
    swapDirectories?: (first: string, second: string) => void,
  ) => void;
  /**
   * The production bundle replacer needs a signed native host whenever an
   * existing destination must be exchanged. Custom replacement adapters may
   * explicitly own another atomic mechanism.
   */
  requiresSwapHostForExistingApp?: boolean;
  /**
   * Copy a signed native host out of the first prepared payload that carries
   * one into the transaction's own receipt directory.
   */
  stageSwapHost?: (
    candidateAppPaths: string[],
    destination: string,
  ) => (Omit<PreparedSwapHostEvidence, "path" | "sourceAppPath"> & { sourceAppPath: string }) | null;
  /** Verify receipt-owned swap-host evidence and return its swap function. */
  loadSwapHost?: (evidence: PreparedSwapHostEvidence) => (first: string, second: string) => void;
  copyBackend?: (source: string, destination: string) => void;
  preparePatchedPayload?: (
    profile: EnvironmentProfileRecord,
    destination: string,
    runtimeDestination: string,
    bundledDerivedBackend?: ValidatedBundledDerivedArtifact,
  ) => void | Promise<void>;
  prepareRuntimeAssets?: (destination: string) => void | Promise<void>;
  prepareManagedRuntime?: (
    sourceRoot: string,
    destination: string,
    provenance: ManagedRuntimeProvenance,
  ) => void | Promise<void>;
  prepareDevelopmentSource?: (sourceRoot: string) => void | Promise<void>;
  executionSourceRoot?: () => string;
  cloneDirectory?: (source: string, destination: string) => void;
  replaceDirectory?: (source: string, destination: string) => void;
  directoryFingerprint?: (root: string) => string;
  readRuntimeFingerprintEvidence?: (root: string) => RuntimeTreeFingerprint | null;
  prepareManagedBackend?: (profile: EnvironmentProfileRecord, destination: string) => void | Promise<void>;
  readBundledDerivedArtifact?: (receiptPath: string) => ValidatedBundledDerivedArtifact;
  readMarker?: (asarPath: string) => "present" | "absent" | "unreadable";
  readAsarHeaderHash?: (appRoot: string) => string;
  appFingerprint?: (appRoot: string) => string;
  fileFingerprint?: (file: string) => string;
  readDesktopIdentity?: (appRoot: string) => { bundleId: string | null; version: string | null; build: string | null };
  verifyOfficial?: (selection: EnvironmentSelection) => PreparedCandidateSignatureEvidence;
  verifyPatched?: (appRoot: string) => PreparedCandidateSignatureEvidence;
  readBackendVersion?: (binaryPath: string) => string | null;
  readBackendLane?: (configFile: string) => BackendLane | null;
  writeBackendLane?: (
    configFile: string,
    lane: BackendLane,
    selected?: { binaryPath: string; version: string; fingerprint: string },
  ) => void;
  readAppState?: (stateFile: string) => {
    appExperience: AppExperience;
    appRoot: string;
    bundleId: string | null;
    originalAsarHash: string;
    patchedAsarHash: string;
  } | null;
  readRuntimeProof?: (file: string) => EnvironmentRuntimeProof | null;
  /**
   * Proves the headless MCP mode helper is available before the desktop is
   * stopped. A missing helper must fail preparation, never strand a cutover
   * between app replacement and MCP reconciliation.
   */
  assertMcpModeReady?: () => void;
  /** Applies the MCP ownership projection for the selected app experience. */
  reconcileMcpMode?: (appExperience: AppExperience) => void;
  /** Read-only proof that the selected app experience owns the live MCP set. */
  proveMcpMode?: (appExperience: AppExperience) => boolean;
  readPatchedAsarEvidence?: (appRoot: string) => EnvironmentPatchedAsarEvidence;
  writeAppState?: (
    stateFile: string,
    selection: EnvironmentSelection,
    desktopVersion: string,
    patchedAsarEvidence: EnvironmentPatchedAsarEvidence | null,
    originalAsarHash: string | null,
  ) => void;
  loadState?: typeof loadEnvironmentState;
  now?: () => string;
}

export interface EnvironmentPatchedAsarEvidence {
  headerHash: string;
  stat: {
    size: number;
    mtimeMs: number;
  };
}

export interface ManagedCodexCliPreparationManager {
  installBeta(): Promise<unknown>;
  validateCurrent(): Promise<{ valid: boolean; binary: string | null; error?: string }>;
}

export interface EnvironmentPreparationCapabilities {
  patchedPayloadBuildable: boolean;
  backendInstallable: boolean;
}

export interface ManagedAlphaBackendStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  fingerprint: string | null;
  error: string | null;
}

/** Capabilities that the runtime may safely advertise before app cutover. */
export function environmentPreparationCapabilities(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): EnvironmentPreparationCapabilities {
  return {
    patchedPayloadBuildable: platform === "darwin",
    backendInstallable: platform === "darwin" && architecture === "arm64",
  };
}

/**
 * Adapt the runtime-owned managed CLI installer to the coordinator's staging
 * contract. Installation and validation finish while the current app is still
 * alive; only the exact validated binary is copied into immutable evidence.
 */
export function createManagedAlphaBackendPreparer(
  manager: ManagedCodexCliPreparationManager,
  deps: {
    copyBackend?: (source: string, destination: string) => void;
    readBackendVersion?: (binary: string) => string | null;
  } = {},
): (profile: EnvironmentProfileRecord, destination: string) => Promise<void> {
  const copyBackend = deps.copyBackend ?? copyBackendAtomically;
  const readBackendVersion = deps.readBackendVersion ?? defaultReadBackendVersion;
  return async (profile, destination) => {
    await manager.installBeta();
    const validation = await manager.validateCurrent();
    if (!validation.valid || !validation.binary || !exactAbsolutePath(validation.binary)) {
      throw new Error(validation.error ?? "Managed Alpha installation did not produce an exact validated binary");
    }
    const version = readBackendVersion(validation.binary);
    if (!version || !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) {
      throw new Error("Managed Alpha installation returned a non-Alpha binary");
    }
    if (profile.backendVersion !== null && profile.backendVersion !== version) {
      throw new Error(`Managed Alpha version mismatch: expected ${profile.backendVersion}, got ${version}`);
    }
    copyBackend(validation.binary, destination);
  };
}

export interface EnvironmentCommitHelperReceipt {
  schemaVersion: 1;
  kind: "environment-commit-helper";
  transactionId: string;
  label: string;
  cliPath: string;
  /** Additive schema-v1 binding for the receipt-owned commit control plane. */
  cliArtifactDigest?: string;
  managedRuntimeArtifactPath?: string;
  managedRuntimeArtifactDigest?: string;
  userRoot: string;
  wrapperFile: string;
  stdoutFile: string;
  stderrFile: string;
  outcomeFile: string;
  phase: "submitted" | "submit-failed";
  submittedAt: string;
  error: string | null;
}

export interface EnvironmentCommitHelperOutcome {
  schemaVersion: 1;
  kind: "environment-commit-helper-outcome";
  transactionId: string;
  label: string;
  phase: "not-started" | "running" | "succeeded" | "failed";
  pid?: number | null;
  startedAt: string | null;
  heartbeatAt?: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface SubmitEnvironmentCommitHelperInput {
  transactionId: string;
  cliPath: string;
  cliArtifactDigest: string;
  managedRuntimeArtifactPath: string;
  managedRuntimeArtifactDigest: string;
  userRoot: string;
  /** Exact Node runtime for a JavaScript CLI. Defaults to this process for *.js entrypoints. */
  runtimePath?: string;
  receiptFile: string;
  now?: string;
  staleAfterMs?: number;
}

export interface SubmitEnvironmentCommitHelperDeps {
  submit?: (command: string, args: string[]) => { status: number | null; output: string };
  remove?: (label: string) => void;
  processAlive?: (pid: number) => boolean;
}

export interface PreparedEnvironmentCommitCli {
  cliPath: string;
  cliArtifactDigest: string;
  managedRuntimeArtifactPath: string;
  managedRuntimeArtifactDigest: string;
}

/**
 * Resolve the only CLI allowed to submit a prepared transaction.
 *
 * The control plane lives inside the receipt-owned managed-runtime snapshot,
 * not in the mutable checkout or installed runtime that happens to receive the
 * confirmation click.
 */
export function resolvePreparedEnvironmentCommitCli(
  receipt: EnvironmentTransactionReceipt,
  receiptRoot: string,
): PreparedEnvironmentCommitCli {
  if (receipt.phase !== "prepared" || receipt.prepared === null) {
    throw new Error(
      `Environment transaction ${receipt.transactionId} cannot resolve a commit CLI from phase ${receipt.phase}`,
    );
  }
  const evidence = receipt.prepared.managedRuntime?.requested;
  if (!evidence || !evidence.cliPath || !evidence.cliArtifactDigest) {
    throw new Error(
      `Environment transaction ${receipt.transactionId} predates receipt-owned CLI evidence; `
      + "cancel it and prepare a new candidate",
    );
  }
  const preparedRoot = join(receiptRoot, receipt.transactionId, "prepared");
  const expectedManagedRuntimePath = join(preparedRoot, "managed-runtime", "requested");
  if (evidence.artifactPath !== expectedManagedRuntimePath) {
    throw new Error("Prepared managed runtime does not use its exact receipt-owned path");
  }
  assertPreparedArtifactContained(
    receiptRoot,
    preparedRoot,
    "prepared transaction root",
    false,
    "directory",
  );
  assertPreparedArtifactContained(
    preparedRoot,
    evidence.artifactPath,
    "requested managed runtime artifact",
    false,
    "directory",
  );
  assertSelfContainedSymlinks(evidence.artifactPath, "requested managed runtime");
  if (fingerprintDirectoryTree(evidence.artifactPath) !== evidence.artifactDigest) {
    throw new Error("Prepared requested managed runtime artifact is missing or changed");
  }
  const expectedCliPath = join(evidence.artifactPath, "packages", "installer", "dist", "cli.js");
  if (evidence.cliPath !== expectedCliPath) {
    throw new Error("Prepared requested managed runtime CLI path does not match its receipt");
  }
  assertPreparedArtifactContained(
    evidence.artifactPath,
    evidence.cliPath,
    "requested managed runtime CLI",
    false,
    "file",
  );
  if (sha256File(evidence.cliPath) !== evidence.cliArtifactDigest.toLowerCase()) {
    throw new Error("Prepared requested managed runtime CLI is missing or changed");
  }
  return {
    cliPath: evidence.cliPath,
    cliArtifactDigest: evidence.cliArtifactDigest.toLowerCase(),
    managedRuntimeArtifactPath: evidence.artifactPath,
    managedRuntimeArtifactDigest: evidence.artifactDigest,
  };
}

/**
 * Hand commit ownership to a launchd process before the desktop quits. The
 * durable submission receipt lets the next process distinguish "never
 * launched" from an environment transaction that is merely still preparing.
 */
export function submitEnvironmentCommitHelper(
  input: SubmitEnvironmentCommitHelperInput,
  deps: SubmitEnvironmentCommitHelperDeps = {},
): EnvironmentCommitHelperReceipt {
  if (exactAbsolutePath(input.managedRuntimeArtifactPath)
    && exactAbsolutePath(input.receiptFile)
    && pathWithinOrEqual(input.managedRuntimeArtifactPath, input.receiptFile)) {
    throw new Error("Environment helper receipt must be outside the immutable managed runtime");
  }
  const lock = acquireProcessLock(`${input.receiptFile}.lock`, {
    onContended: (owner) => new Error(
      owner === null
        ? `Environment helper ${input.transactionId} is already being submitted`
        : `Environment helper ${input.transactionId} is already being submitted (PID ${owner})`,
    ),
  });
  try {
    return submitEnvironmentCommitHelperUnlocked(input, deps);
  } finally {
    lock.release();
  }
}

function submitEnvironmentCommitHelperUnlocked(
  input: SubmitEnvironmentCommitHelperInput,
  deps: SubmitEnvironmentCommitHelperDeps,
): EnvironmentCommitHelperReceipt {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.transactionId)) {
    throw new Error("Environment helper transaction ID is invalid");
  }
  if (!exactAbsolutePath(input.cliPath)) throw new Error("Environment helper CLI path must be exact and absolute");
  if (!sha256(input.cliArtifactDigest)) {
    throw new Error("Environment helper CLI digest must be a SHA-256 value");
  }
  if (!sha256(input.managedRuntimeArtifactDigest)) {
    throw new Error("Environment helper managed-runtime digest must be a SHA-256 value");
  }
  if (!exactAbsolutePath(input.managedRuntimeArtifactPath)) {
    throw new Error("Environment helper managed-runtime path must be exact and absolute");
  }
  const managedRuntimeStat = lstatSync(input.managedRuntimeArtifactPath);
  if (!managedRuntimeStat.isDirectory() || managedRuntimeStat.isSymbolicLink()) {
    throw new Error("Environment helper managed runtime must be a real directory");
  }
  assertPreparedArtifactContained(
    input.managedRuntimeArtifactPath,
    input.cliPath,
    "managed-runtime CLI",
    false,
    "file",
  );
  assertSelfContainedSymlinks(input.managedRuntimeArtifactPath, "environment helper managed runtime");
  const managedRuntimeArtifactDigest = input.managedRuntimeArtifactDigest.toLowerCase();
  if (fingerprintDirectoryTree(input.managedRuntimeArtifactPath) !== managedRuntimeArtifactDigest) {
    throw new Error("Environment helper managed runtime changed before submission");
  }
  const cliStat = lstatSync(input.cliPath);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) {
    throw new Error("Environment helper CLI must be a real file");
  }
  const cliArtifactDigest = input.cliArtifactDigest.toLowerCase();
  if (sha256File(input.cliPath) !== cliArtifactDigest) {
    throw new Error("Environment helper CLI changed before submission");
  }
  if (!exactAbsolutePath(input.userRoot)) throw new Error("Environment helper user root must be exact and absolute");
  if (!exactAbsolutePath(input.receiptFile)) throw new Error("Environment helper receipt path must be exact and absolute");
  if (pathWithinOrEqual(input.managedRuntimeArtifactPath, input.receiptFile)) {
    throw new Error("Environment helper receipt must be outside the immutable managed runtime");
  }
  const runtimePath = input.runtimePath ?? (input.cliPath.endsWith(".js") ? process.execPath : null);
  if (runtimePath !== null && !exactAbsolutePath(runtimePath)) {
    throw new Error("Environment helper runtime path must be exact and absolute");
  }
  const label = `co.tweakers.environment.${input.transactionId}`;
  const submittedAt = input.now ?? new Date().toISOString();
  if (!validIso(submittedAt)) throw new Error("Environment helper submission time is invalid");
  const helperRoot = dirname(input.receiptFile);
  const wrapperFile = join(helperRoot, `${label}.sh`);
  const stdoutFile = join(helperRoot, `${label}.stdout.log`);
  const stderrFile = join(helperRoot, `${label}.stderr.log`);
  const outcomeFile = join(helperRoot, `${label}.outcome.json`);
  mkdirSync(helperRoot, { recursive: true, mode: 0o700 });
  const existing = readEnvironmentCommitHelperReceipt(input.receiptFile);
  if (existing !== null) {
    if (existing.transactionId !== input.transactionId
      || existing.cliPath !== input.cliPath
      || existing.cliArtifactDigest !== cliArtifactDigest
      || existing.managedRuntimeArtifactPath !== input.managedRuntimeArtifactPath
      || existing.managedRuntimeArtifactDigest !== managedRuntimeArtifactDigest
      || existing.userRoot !== input.userRoot
      || existing.outcomeFile !== outcomeFile) {
      throw new Error("Existing environment helper receipt does not match this submission");
    }
    const outcome = readEnvironmentCommitHelperOutcome(outcomeFile);
    const reference = outcome?.phase === "running"
      ? outcome.heartbeatAt ?? outcome.startedAt
      : existing.submittedAt;
    const referenceTime = reference ? Date.parse(reference) : Number.NaN;
    const staleAfterMs = Math.max(1_000, input.staleAfterMs ?? 5 * 60_000);
    const liveRunningHelper = outcome?.phase === "running"
      && typeof outcome.pid === "number"
      && Number.isInteger(outcome.pid)
      && outcome.pid > 0
      && (deps.processAlive ?? processAlive)(outcome.pid);
    const stale = !liveRunningHelper && (
      !Number.isFinite(referenceTime)
      || Date.parse(submittedAt) - referenceTime >= staleAfterMs
    );
    const completed = outcome?.phase === "succeeded";
    const inFlight = existing.phase === "submitted"
      && (outcome === null || outcome.phase === "not-started" || outcome.phase === "running");
    if (completed || (inFlight && (!stale || liveRunningHelper))) return existing;

    const remove = deps.remove ?? ((helperLabel: string) => {
      spawnSync("launchctl", ["remove", helperLabel], { stdio: "ignore" });
    });
    try { remove(label); } catch { /* stale launchd cleanup is best effort */ }
    const attemptSuffix = `${Date.now()}.${randomUUID()}.previous`;
    if (existsSync(input.receiptFile)) renameSync(input.receiptFile, `${input.receiptFile}.${attemptSuffix}`);
    if (existsSync(outcomeFile)) renameSync(outcomeFile, `${outcomeFile}.${attemptSuffix}`);
    rmSync(wrapperFile, { force: true });
  }
  writeFileSync(stdoutFile, "", { flag: "a", mode: 0o600 });
  writeFileSync(stderrFile, "", { flag: "a", mode: 0o600 });
  chmodSync(stdoutFile, 0o600);
  chmodSync(stderrFile, 0o600);
  const initialOutcome: EnvironmentCommitHelperOutcome = {
    schemaVersion: 1,
    kind: "environment-commit-helper-outcome",
    transactionId: input.transactionId,
    label,
    phase: "not-started",
    pid: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
  };
  writeJsonObjectAtomically(outcomeFile, initialOutcome);
  writeEnvironmentCommitHelperWrapper({
    transactionId: input.transactionId,
    label,
    cliPath: input.cliPath,
    cliArtifactDigest,
    managedRuntimeArtifactPath: input.managedRuntimeArtifactPath,
    managedRuntimeArtifactDigest,
    userRoot: input.userRoot,
    runtimePath,
    verifierRuntimePath: process.execPath,
    wrapperFile,
    outcomeFile,
  });
  const args = [
    "submit",
    "-l",
    label,
    "-o",
    stdoutFile,
    "-e",
    stderrFile,
    "--",
    "/bin/sh",
    wrapperFile,
  ];
  const submit = deps.submit ?? ((command, commandArgs) => {
    const result = spawnSync(command, commandArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    };
  });
  let result: { status: number | null; output: string };
  try {
    result = submit("launchctl", args);
  } catch (error) {
    result = { status: null, output: errorMessage(error) };
  }
  const receipt: EnvironmentCommitHelperReceipt = {
    schemaVersion: 1,
    kind: "environment-commit-helper",
    transactionId: input.transactionId,
    label,
    cliPath: input.cliPath,
    cliArtifactDigest,
    managedRuntimeArtifactPath: input.managedRuntimeArtifactPath,
    managedRuntimeArtifactDigest,
    userRoot: input.userRoot,
    wrapperFile,
    stdoutFile,
    stderrFile,
    outcomeFile,
    phase: result.status === 0 ? "submitted" : "submit-failed",
    submittedAt,
    error: result.status === 0 ? null : result.output || `launchctl exited ${result.status ?? "without status"}`,
  };
  writeJsonObjectAtomically(input.receiptFile, receipt);
  if (receipt.phase === "submit-failed") {
    rmSync(wrapperFile, { force: true });
    throw new Error(`Could not submit environment commit helper: ${receipt.error}`);
  }
  return receipt;
}

export function readEnvironmentCommitHelperReceipt(file: string): EnvironmentCommitHelperReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Environment helper receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  if (!isEnvironmentCommitHelperReceipt(value)) {
    throw new Error(`Environment helper receipt is invalid at ${file}`);
  }
  return value;
}

export function readEnvironmentCommitHelperOutcome(file: string): EnvironmentCommitHelperOutcome | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Environment helper outcome is unreadable at ${file}: ${errorMessage(error)}`);
  }
  if (!isEnvironmentCommitHelperOutcome(value)) {
    throw new Error(`Environment helper outcome is invalid at ${file}`);
  }
  return value;
}

const ENVIRONMENT_COMMIT_TREE_VERIFIER_SOURCE = [
  'const { createHash } = require("node:crypto");',
  'const { lstatSync, readdirSync, readFileSync, readlinkSync } = require("node:fs");',
  'const { join, relative } = require("node:path");',
  "const root = process.argv[1];",
  "const expected = process.argv[2];",
  "const rootStat = lstatSync(root);",
  'if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) process.exit(65);',
  'const hash = createHash("sha256");',
  "const addEntry = (type, relativePath, mode, payload) => {",
  '  const header = `${type}\\0${relativePath.replaceAll("\\\\", "/")}\\0${(mode & 0o7777).toString(8)}\\0${payload.length}\\0`;',
  "  hash.update(header);",
  "  hash.update(payload);",
  "};",
  "const visit = (directory) => {",
  "  const entries = readdirSync(directory, { withFileTypes: true })",
  "    .sort((left, right) => left.name.localeCompare(right.name));",
  "  for (const entry of entries) {",
  "    // Must stay in lockstep with fingerprintDirectoryTree's junk skip:",
  "    // the digest this verifies was computed by the junk-skipping hasher.",
  '    if (entry.name === ".DS_Store") continue;',
  "    const path = join(directory, entry.name);",
  "    const relativePath = relative(root, path);",
  "    const stat = lstatSync(path);",
  "    if (stat.isDirectory() && !stat.isSymbolicLink()) {",
  '      addEntry("directory", relativePath, stat.mode, Buffer.alloc(0));',
  "      visit(path);",
  "    } else if (stat.isFile()) {",
  '      addEntry("file", relativePath, stat.mode, readFileSync(path));',
  "    } else if (stat.isSymbolicLink()) {",
  '      addEntry("symlink", relativePath, stat.mode, Buffer.from(readlinkSync(path), "utf8"));',
  "    } else {",
  "      process.exit(65);",
  "    }",
  "  }",
  "};",
  "visit(root);",
  'process.exit(hash.digest("hex") === expected ? 0 : 65);',
].join("\n");

function writeEnvironmentCommitHelperWrapper(input: {
  transactionId: string;
  label: string;
  cliPath: string;
  cliArtifactDigest: string;
  managedRuntimeArtifactPath: string;
  managedRuntimeArtifactDigest: string;
  userRoot: string;
  runtimePath: string | null;
  verifierRuntimePath: string;
  wrapperFile: string;
  outcomeFile: string;
}): void {
  const identity = `"schemaVersion":1,"kind":"environment-commit-helper-outcome","transactionId":${JSON.stringify(input.transactionId)},"label":${JSON.stringify(input.label)}`;
  const running = `{${identity},"phase":"running","pid":%s,"startedAt":"%s","heartbeatAt":"%s","finishedAt":null,"exitCode":null,"error":null}\\n`;
  const succeeded = `{${identity},"phase":"succeeded","pid":%s,"startedAt":"%s","heartbeatAt":"%s","finishedAt":"%s","exitCode":%s,"error":null}\\n`;
  const failed = `{${identity},"phase":"failed","pid":%s,"startedAt":"%s","heartbeatAt":"%s","finishedAt":"%s","exitCode":%s,"error":"environment commit exited non-zero"}\\n`;
  const command = [
    ...(input.runtimePath === null ? [] : [input.runtimePath]),
    input.cliPath,
    "environment",
    "commit",
    "--transaction",
    input.transactionId,
  ]
    .map(shellSingleQuote)
    .join(" ");
  const treeVerifierCommand = [
    input.verifierRuntimePath,
    "--input-type=commonjs",
    "-e",
    ENVIRONMENT_COMMIT_TREE_VERIFIER_SOURCE,
    input.managedRuntimeArtifactPath,
    input.managedRuntimeArtifactDigest,
  ]
    .map(shellSingleQuote)
    .join(" ");
  const script = [
    "#!/bin/sh",
    "set -u",
    "umask 077",
    `LABEL=${shellSingleQuote(input.label)}`,
    `WRAPPER=${shellSingleQuote(input.wrapperFile)}`,
    `OUTCOME=${shellSingleQuote(input.outcomeFile)}`,
    `CLI=${shellSingleQuote(input.cliPath)}`,
    `EXPECTED_CLI_SHA=${shellSingleQuote(input.cliArtifactDigest)}`,
    `MANAGED_RUNTIME=${shellSingleQuote(input.managedRuntimeArtifactPath)}`,
    `EXPECTED_MANAGED_RUNTIME_SHA=${shellSingleQuote(input.managedRuntimeArtifactDigest)}`,
    "HELPER_PID=$$",
    "HEARTBEAT_PID=",
    `export TWEAKERS_HOME=${shellSingleQuote(input.userRoot)}`,
    `export TWEAKER_HOME=${shellSingleQuote(input.userRoot)}`,
    `export TWEAKERS_USER_ROOT=${shellSingleQuote(input.userRoot)}`,
    `export TWEAKER_USER_ROOT=${shellSingleQuote(input.userRoot)}`,
    `export ${LEGACY_USER_ROOT_ENV}=${shellSingleQuote(input.userRoot)}`,
    "cleanup() {",
    "  if [ -n \"$HEARTBEAT_PID\" ]; then /bin/kill \"$HEARTBEAT_PID\" >/dev/null 2>&1 || true; fi",
    "  /bin/rm -f -- \"$WRAPPER\"",
    "  /bin/launchctl remove \"$LABEL\" >/dev/null 2>&1 || /bin/launchctl bootout \"gui/$(/usr/bin/id -u)/$LABEL\" >/dev/null 2>&1 || true",
    "}",
    "trap cleanup EXIT HUP INT TERM",
    "STARTED_AT=\"$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')\"",
    "TEMPORARY=\"${OUTCOME}.tmp.$$\"",
    `printf ${shellSingleQuote(running)} \"$HELPER_PID\" \"$STARTED_AT\" \"$STARTED_AT\" > \"$TEMPORARY\"`,
    "/bin/mv -f \"$TEMPORARY\" \"$OUTCOME\"",
    "heartbeat() {",
    "  HEARTBEAT_SLEEP_PID=",
    "  trap 'if [ -n \"$HEARTBEAT_SLEEP_PID\" ]; then /bin/kill \"$HEARTBEAT_SLEEP_PID\" >/dev/null 2>&1 || true; fi; exit 0' HUP INT TERM",
    "  while /bin/kill -0 \"$HELPER_PID\" >/dev/null 2>&1; do",
    "    HEARTBEAT_AT=\"$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')\"",
    "    TEMPORARY=\"${OUTCOME}.tmp.$$\"",
    `    printf ${shellSingleQuote(running)} \"$HELPER_PID\" \"$STARTED_AT\" \"$HEARTBEAT_AT\" > \"$TEMPORARY\"`,
    "    /bin/mv -f \"$TEMPORARY\" \"$OUTCOME\"",
    "    /bin/sleep 5 &",
    "    HEARTBEAT_SLEEP_PID=$!",
    "    wait \"$HEARTBEAT_SLEEP_PID\" >/dev/null 2>&1 || true",
    "    HEARTBEAT_SLEEP_PID=",
    "  done",
    "}",
    "heartbeat &",
    "HEARTBEAT_PID=$!",
    `${treeVerifierCommand}`,
    "TREE_STATUS=$?",
    "if [ \"$TREE_STATUS\" -eq 0 ]; then",
    "  ACTUAL_CLI_SHA=\"$(/usr/bin/shasum -a 256 \"$CLI\" 2>/dev/null | /usr/bin/awk '{print $1}')\"",
    "  if [ \"$ACTUAL_CLI_SHA\" = \"$EXPECTED_CLI_SHA\" ]; then",
    // The wrapper's own receipt and log writes stay owner-only under umask 077
    // (they also set explicit 0600 modes). The commit itself copies app and
    // runtime payloads whose permission bits are fingerprinted evidence, so it
    // must run under a deterministic umask instead of inheriting 077.
    "    (",
    "      umask 022",
    `      ${command}`,
    "    )",
    "    STATUS=$?",
    "  else",
    "    STATUS=65",
    "  fi",
    "else",
    "  STATUS=65",
    "fi",
    "/bin/kill \"$HEARTBEAT_PID\" >/dev/null 2>&1 || true",
    "wait \"$HEARTBEAT_PID\" >/dev/null 2>&1 || true",
    "HEARTBEAT_PID=",
    "FINISHED_AT=\"$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')\"",
    "if [ \"$STATUS\" -eq 0 ]; then",
    `  printf ${shellSingleQuote(succeeded)} \"$HELPER_PID\" \"$STARTED_AT\" \"$FINISHED_AT\" \"$FINISHED_AT\" \"$STATUS\" > \"$TEMPORARY\"`,
    "else",
    `  printf ${shellSingleQuote(failed)} \"$HELPER_PID\" \"$STARTED_AT\" \"$FINISHED_AT\" \"$FINISHED_AT\" \"$STATUS\" > \"$TEMPORARY\"`,
    "fi",
    "/bin/mv -f \"$TEMPORARY\" \"$OUTCOME\"",
    "exit \"$STATUS\"",
    "",
  ].join("\n");
  const temporary = `${input.wrapperFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, script, { encoding: "utf8", mode: 0o700, flag: "wx" });
    renameSync(temporary, input.wrapperFile);
    chmodSync(input.wrapperFile, 0o700);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createDefaultEnvironmentAdapters(
  options: DefaultEnvironmentAdapterOptions,
  deps: DefaultEnvironmentAdapterDeps = {},
): Pick<
  Required<EnvironmentCoordinatorDeps>,
  "preparePrerequisites" | "validatePreparedEnvironment" | "stagePreparedEnvironment"
  | "applyPreparedEnvironment" | "proveAppliedEnvironment" | "bindWatcherTarget"
  | "migrateSwapHost"
> {
  const adapters = resolvedDefaultEnvironmentAdapterDeps(options, deps);
  return {
    preparePrerequisites: (input) => prepareEnvironmentPrerequisites(input, options, adapters),
    validatePreparedEnvironment: (input) => validatePreparedEnvironment(input, options, adapters),
    stagePreparedEnvironment: (input) => stagePreparedEnvironment(input, options, adapters),
    applyPreparedEnvironment: (input) => applyPreparedEnvironment(input, options, adapters),
    proveAppliedEnvironment: (input) => proveAppliedEnvironment(input, options, adapters),
    bindWatcherTarget: (input) => bindWatcherTarget(input, options, adapters),
    migrateSwapHost: (input) => migrateLegacySwapHost(input, options, adapters),
  };
}

/**
 * Receipts prepared before receipt-owned swap evidence existed can still be
 * recovered: their prepared payloads are immutable, so a host copied out of
 * them now carries the same provenance it would have had at preparation. The
 * payload is re-proven against its recorded digest first, and the migration
 * runs while the live app is still up so a mismatch fails before any quit.
 */
function migrateLegacySwapHost(
  input: { receipt: EnvironmentTransactionReceipt; prepared: PreparedEnvironmentEvidence },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): PreparedSwapHostEvidence | null {
  const { receipt, prepared } = input;
  const preparedRoot = join(options.receiptRoot, receipt.transactionId, "prepared");
  const payloads: Array<{ path: string; digest: string; label: string }> = [
    {
      path: prepared.candidate.artifactPath,
      digest: prepared.candidate.artifactDigest,
      label: "requested desktop artifact",
    },
    {
      path: prepared.rollback.desktopArtifactPath,
      digest: prepared.rollback.desktopArtifactDigest,
      label: "rollback desktop artifact",
    },
  ];
  const usable: string[] = [];
  for (const payload of payloads) {
    if (!existsSync(stagedNativeHostPath(payload.path))) continue;
    if (usable.length === 0) {
      assertPreparedArtifactContained(
        options.receiptRoot,
        preparedRoot,
        "prepared transaction root",
        false,
        "directory",
      );
    }
    assertPreparedArtifactContained(preparedRoot, payload.path, payload.label, false, "directory");
    if (deps.appFingerprint(payload.path) !== payload.digest) {
      throw new Error(
        `Environment transaction ${receipt.transactionId} cannot migrate swap evidence: `
        + `its ${payload.label} no longer matches the prepared digest`,
      );
    }
    usable.push(payload.path);
  }
  if (usable.length === 0) return null;
  const path = preparedSwapHostPath(preparedRoot);
  const staged = deps.stageSwapHost(usable, path);
  return staged === null ? null : { ...staged, path };
}

type ResolvedDefaultEnvironmentAdapterDeps = Required<DefaultEnvironmentAdapterDeps>;

interface ManagedRuntimeSourcePlan {
  sourceRoot: string;
  provenance: ManagedRuntimeProvenance;
  sourceRuntimeHash: string | null;
  sourceArtifactHash: string;
  sourceControlHash: string;
}

function resolvedDefaultEnvironmentAdapterDeps(
  options: DefaultEnvironmentAdapterOptions,
  deps: DefaultEnvironmentAdapterDeps,
): ResolvedDefaultEnvironmentAdapterDeps {
  const environmentRoot = options.environmentRoot ?? dirname(options.configFile);
  const mcpModeBridge = createMcpModeBridge({
    ...(options.mcpModeHelperFile ? { helperFile: options.mcpModeHelperFile } : {}),
    configPath: options.mcpConfigFile ?? defaultCodexMcpConfigFile(),
    statePath: options.mcpStateFile ?? join(environmentRoot, "mcp-sync-state.json"),
    tweaksRoot: options.tweaksRoot ?? join(environmentRoot, "tweaks"),
    tweakersConfigPath: options.configFile,
  });
  return {
    cloneApp: deps.cloneApp ?? ((source, destination) => {
      rmSync(destination, { recursive: true, force: true });
      cloneAppTree(source, destination);
    }),
    replaceApp: deps.replaceApp ?? ((source, destination, validate, swapDirectories) => {
      replaceAppBundlePreservingIdentity(source, destination, {
        validateDestination: validate,
        swapDirectories,
      });
    }),
    requiresSwapHostForExistingApp:
      deps.requiresSwapHostForExistingApp ?? deps.replaceApp === undefined,
    stageSwapHost: deps.stageSwapHost ?? ((candidateAppPaths, destination) => {
      const staged = stagePreparedSwapHost(candidateAppPaths, destination);
      return staged === null ? null : { ...staged.identity, sourceAppPath: staged.sourceAppPath };
    }),
    loadSwapHost: deps.loadSwapHost ?? ((evidence) => loadVerifiedSwapHost(evidence)),
    copyBackend: deps.copyBackend ?? copyBackendAtomically,
    preparePatchedPayload: deps.preparePatchedPayload ?? (async (
      profile,
      destination,
      runtimeDestination,
      bundledDerivedBackend,
    ) => {
      const officialAsar = join(profile.officialPath, "Contents", "Resources", "app.asar");
      const sourceApp = existsSync(profile.officialPath) && readAsarMarker(officialAsar) === "absent"
        ? profile.officialPath
        : profile.pristineBackupPath;
      if (!existsSync(sourceApp)) {
        throw new Error(`No pristine ${profile.releaseProfile} app is available to build a patched payload`);
      }
      await buildPatchedCandidateOnly({
        sourceApp,
        destinationApp: destination,
        destinationRuntime: runtimeDestination,
        finalUserRoot: options.environmentRoot ?? userPaths().root,
        ...(bundledDerivedBackend ? { bundledDerivedBackend } : {}),
      });
    }),
    prepareRuntimeAssets: deps.prepareRuntimeAssets ?? ((destination) => {
      stageAssets(destination);
    }),
    prepareManagedRuntime: deps.prepareManagedRuntime ?? ((sourceRoot, destination, provenance) => {
      stageManagedRuntime(sourceRoot, destination, { provenance });
    }),
    prepareDevelopmentSource: deps.prepareDevelopmentSource ?? buildDevelopmentSource,
    executionSourceRoot: deps.executionSourceRoot
      ?? (() => findSourceRoot(dirname(fileURLToPath(import.meta.url)))),
    cloneDirectory: deps.cloneDirectory ?? cloneDirectorySnapshot,
    replaceDirectory: deps.replaceDirectory ?? replaceDirectoryAtomically,
    directoryFingerprint: deps.directoryFingerprint ?? fingerprintDirectoryTree,
    readRuntimeFingerprintEvidence: deps.readRuntimeFingerprintEvidence ?? readRuntimeFingerprintEvidence,
    prepareManagedBackend: deps.prepareManagedBackend ?? ((profile, destination) => {
      const status = inspectManagedAlphaBackend(options.environmentRoot ?? userPaths().root);
      if (!status.installed || !status.binaryPath || !status.version) {
        throw new Error(status.error ?? "No validated managed Alpha backend is installed");
      }
      if (profile.backendVersion !== null && profile.backendVersion !== status.version) {
        throw new Error(`Managed Alpha version mismatch: expected ${profile.backendVersion}, got ${status.version}`);
      }
      copyBackendAtomically(status.binaryPath, destination);
    }),
    readBundledDerivedArtifact: deps.readBundledDerivedArtifact ?? readValidatedBundledDerivedArtifact,
    readMarker: deps.readMarker ?? readAsarMarker,
    readAsarHeaderHash: deps.readAsarHeaderHash ?? ((appRoot) =>
      readHeaderHash(join(appRoot, "Contents", "Resources", "app.asar")).headerHash),
    // Profiles record the canonical Contents fingerprint. Reuse the same
    // implementation here: hashDirectoryTree intentionally treats symlinks
    // differently for installer payloads and would reject a valid profile.
    appFingerprint: deps.appFingerprint ?? fingerprintAppContents,
    fileFingerprint: deps.fileFingerprint ?? sha256File,
    readDesktopIdentity: deps.readDesktopIdentity ?? readDesktopIdentity,
    verifyOfficial: deps.verifyOfficial ?? defaultVerifyOfficialCandidate,
    verifyPatched: deps.verifyPatched ?? defaultVerifyPatchedCandidate,
    readBackendVersion: deps.readBackendVersion ?? defaultReadBackendVersion,
    readBackendLane: deps.readBackendLane ?? defaultReadBackendLane,
    writeBackendLane: deps.writeBackendLane ?? defaultWriteBackendLane,
    readAppState: deps.readAppState ?? ((stateFile) => {
      const state = readState(stateFile);
      if (!state || (state.mode !== "chatgpt" && state.mode !== "tweakers")) return null;
      return {
        appExperience: state.mode,
        appRoot: state.appRoot,
        bundleId: state.codexBundleId ?? null,
        originalAsarHash: state.originalAsarHash,
        patchedAsarHash: state.patchedAsarHash,
      };
    }),
    readRuntimeProof: deps.readRuntimeProof ?? readEnvironmentRuntimeProof,
    assertMcpModeReady: deps.assertMcpModeReady ?? mcpModeBridge.assertReady,
    reconcileMcpMode: deps.reconcileMcpMode ?? ((appExperience) => {
      mcpModeBridge.reconcile(appExperience);
    }),
    proveMcpMode: deps.proveMcpMode ?? mcpModeBridge.prove,
    readPatchedAsarEvidence: deps.readPatchedAsarEvidence ?? ((appRoot) => {
      const asarPath = join(appRoot, "Contents", "Resources", "app.asar");
      const asarStat = lstatSync(asarPath);
      if (!asarStat.isFile()) throw new Error(`Patched app.asar is not a regular file at ${asarPath}`);
      return {
        headerHash: readHeaderHash(asarPath).headerHash,
        stat: {
          size: asarStat.size,
          mtimeMs: asarStat.mtimeMs,
        },
      };
    }),
    writeAppState: deps.writeAppState ?? ((
      stateFile,
      selection,
      desktopVersion,
      patchedAsarEvidence,
      originalAsarHash,
    ) => {
      const state = readState(stateFile);
      if (!state) throw new Error(`Installer state is missing at ${stateFile}`);
      const {
        patchedAsarStat: _previousPatchedAsarStat,
        watcherStatGuardPasses: _previousWatcherStatGuardPasses,
        ...stateWithoutLiveAsarEvidence
      } = state;
      if (selection.appExperience === "tweakers" && patchedAsarEvidence === null) {
        throw new Error("Tweakers environment state requires live patched app.asar evidence");
      }
      writeState(stateFile, {
        ...stateWithoutLiveAsarEvidence,
        mode: selection.appExperience,
        appRoot: selection.selectedDesktopPath,
        codexBundleId: selection.selectedDesktopBundleId,
        codexChannel: selection.releaseProfile === "alpha" ? "beta" : "stable",
        codexVersion: desktopVersion,
        ...(originalAsarHash === null ? {} : { originalAsarHash }),
        ...(patchedAsarEvidence === null
          ? {}
          : {
            patchedAsarHash: patchedAsarEvidence.headerHash,
            patchedAsarStat: patchedAsarEvidence.stat,
            watcherStatGuardPasses: 0,
          }),
      });
    }),
    loadState: deps.loadState ?? loadEnvironmentState,
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

async function prepareManagedRuntimeSourcePlan(
  environmentRoot: string,
  managedRuntimeTarget: string,
  preparedAt: string,
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): Promise<ManagedRuntimeSourcePlan> {
  if (options.sourceRoot) {
    if (!pathEntryExists(options.sourceRoot)) {
      throw new Error(`No managed runtime source is available at ${options.sourceRoot}`);
    }
    const sourceRuntimeHash = hashTree(options.sourceRoot, false);
    const sourceArtifactHash = fingerprintManagedRuntimeSource(options.sourceRoot);
    const sourceControlHash = fingerprintManagedRuntimeControlPlane(options.sourceRoot);
    return {
      sourceRoot: options.sourceRoot,
      sourceRuntimeHash,
      sourceArtifactHash,
      sourceControlHash,
      provenance: {
        kind: "development-bootstrap",
        installedAt: preparedAt,
        sourceRuntimeHash,
        sourceArtifactHash,
        sourceControlHash,
      },
    };
  }

  const refreshStatus = getLocalRefreshStatus(environmentRoot);
  if (refreshStatus.source === "development") {
    const sourceRoot = refreshStatus.developmentSourceRoot;
    if (!sourceRoot || !pathEntryExists(sourceRoot)) {
      throw new Error("The selected development refresh source is unavailable");
    }
    const executionSourceRoot = deps.executionSourceRoot();
    if (!sameCanonicalPath(sourceRoot, executionSourceRoot)) {
      throw new Error(
        "Refusing to build a development candidate from a checkout that does not own the executing installer: "
        + `${sourceRoot} != ${executionSourceRoot}`,
      );
    }
    const sourceHashBeforeBuild = hashTree(sourceRoot, false);
    const sourceControlHashBeforeBuild = fingerprintManagedRuntimeControlPlane(sourceRoot);
    await deps.prepareDevelopmentSource(sourceRoot);
    const sourceRuntimeHash = hashTree(sourceRoot, false);
    if (sourceRuntimeHash !== sourceHashBeforeBuild) {
      throw new Error("Development source changed while the promotion candidate was being built");
    }
    const sourceControlHash = fingerprintManagedRuntimeControlPlane(sourceRoot);
    if (sourceControlHash !== sourceControlHashBeforeBuild) {
      throw new Error(
        "Development installer control-plane bytes changed during the candidate build; "
        + "retry preparation so the rebuilt CLI owns the complete transaction",
      );
    }
    const sourceArtifactHash = fingerprintManagedRuntimeSource(sourceRoot);
    return {
      sourceRoot,
      sourceRuntimeHash,
      sourceArtifactHash,
      sourceControlHash,
      provenance: {
        kind: "development-bootstrap",
        installedAt: preparedAt,
        sourceRuntimeHash,
        sourceArtifactHash,
        sourceControlHash,
      },
    };
  }

  if (refreshStatus.source === "stable") {
    throw new Error(
      "A newer stable Tweakers release is available but has not been materialized; "
      + "run the stable self-update preparation before environment promotion",
    );
  }
  if (!pathEntryExists(managedRuntimeTarget)) {
    throw new Error(`No managed runtime source is available at ${managedRuntimeTarget}`);
  }
  const executionSourceRoot = deps.executionSourceRoot();
  if (!sameCanonicalPath(managedRuntimeTarget, executionSourceRoot)) {
    throw new Error(
      "Refusing to prepare the current managed runtime from an installer owned by another source: "
      + `${managedRuntimeTarget} != ${executionSourceRoot}`,
    );
  }
  const provenance = readManagedRuntimeProvenance(managedRuntimeTarget);
  if (provenance === null) {
    throw new Error(`Managed runtime provenance is missing or invalid at ${managedRuntimeTarget}`);
  }
  return {
    sourceRoot: managedRuntimeTarget,
    provenance,
    sourceRuntimeHash: readManagedSourceRuntimeHash(managedRuntimeTarget),
    sourceArtifactHash: fingerprintManagedRuntimeSource(managedRuntimeTarget),
    sourceControlHash: fingerprintManagedRuntimeControlPlane(managedRuntimeTarget),
  };
}

function buildDevelopmentSource(sourceRoot: string): void {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["run", "build"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === 0 && !result.error) return;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const detail = result.error?.message
    ?? (result.signal ? `signal ${result.signal}` : `status ${result.status ?? "unknown"}`);
  throw new Error(
    `Development candidate build failed with ${detail}${output ? `: ${output.slice(-8_000)}` : ""}`,
  );
}

function sameCanonicalPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

async function prepareEnvironmentPrerequisites(
  input: { transactionId: string; current: EnvironmentSelection; requested: EnvironmentSelection; oldMainPid: number | null },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): Promise<PreparedEnvironmentEvidence> {
  deps.assertMcpModeReady();
  const preparedAt = deps.now();
  const registry = ensureEnvironmentRegistryForPrepare(input, options, deps);
  const requestedProfile = registry.profiles[input.requested.releaseProfile];
  const currentProfile = registry.profiles[input.current.releaseProfile];
  const requestedAvailability = requestedProfile.availability[input.requested.appExperience];
  if (!requestedAvailability.available) {
    throw new Error(
      `${input.requested.releaseProfile}/${input.requested.appExperience} environment is unavailable: ${requestedAvailability.unavailableReasons.join("; ")}`,
    );
  }
  assertSelectionUsesProfile(input.requested, requestedProfile);
  assertSelectionUsesProfile(input.current, currentProfile);
  if (registry.selected !== null && !selectionsMatch(registry.selected, input.current, true)) {
    throw new Error("Environment registry selected value does not match the current transition source");
  }
  assertObservedAppExperience(input.current.selectedDesktopPath, input.current.appExperience, deps);

  const preparedRoot = join(options.receiptRoot, input.transactionId, "prepared");
  rmSync(preparedRoot, { recursive: true, force: true });
  mkdirSync(preparedRoot, { recursive: true });
  const candidateArtifactPath = join(preparedRoot, "candidate.app");
  const rollbackArtifactPath = join(preparedRoot, "rollback.app");
  const requestedRuntimeArtifactPath = join(preparedRoot, "runtime", "requested");
  const rollbackRuntimeArtifactPath = join(preparedRoot, "runtime", "rollback");
  const requestedManagedRuntimeArtifactPath = join(preparedRoot, "managed-runtime", "requested");
  const rollbackManagedRuntimeArtifactPath = join(preparedRoot, "managed-runtime", "rollback");
  const needsRuntimeEvidence = input.current.appExperience === "tweakers"
    || input.requested.appExperience === "tweakers";
  const environmentRoot = options.environmentRoot ?? dirname(options.configFile);
  const activeRuntimeTarget = join(environmentRoot, "runtime");
  const managedRuntimeTarget = managedSourceRoot(environmentRoot);
  const requestedManagedRuntimePlan = input.requested.appExperience === "tweakers"
    ? await prepareManagedRuntimeSourcePlan(
      environmentRoot,
      managedRuntimeTarget,
      preparedAt,
      options,
      deps,
    )
    : null;
  const officialPathIsPristine = observedAppExperience(requestedProfile.officialPath, deps) === "chatgpt";
  const candidateSource = input.requested.appExperience === "chatgpt"
    ? officialPathIsPristine ? requestedProfile.officialPath : requestedProfile.pristineBackupPath
    : requestedProfile.patchedPayloadPath;
  const expectedCandidateFingerprint = input.requested.appExperience === "chatgpt"
    ? officialPathIsPristine ? null : requestedProfile.pristineBackupFingerprint
    : requestedProfile.patchedPayloadFingerprint;
  const bundledDerivedBackend = input.requested.appExperience === "tweakers"
    && (input.requested.backendLane === "official-bundled"
      || input.requested.backendLane === "bundled")
    && options.bundledDerivedReceiptFile !== undefined
    ? loadBundledDerivedBackend(options.bundledDerivedReceiptFile, requestedProfile, deps)
    : undefined;
  if (input.requested.appExperience === "tweakers"
    && requestedProfile.patchedPayloadBuildable) {
    // A patched app is coupled to the external runtime it loads. Rebuild it
    // for every new transaction so the receipt captures those exact bytes.
    await deps.preparePatchedPayload(
      requestedProfile,
      candidateArtifactPath,
      requestedRuntimeArtifactPath,
      bundledDerivedBackend,
    );
  } else {
    if (!existsSync(candidateSource)) throw new Error(`requested desktop artifact is missing at ${candidateSource}`);
    if (expectedCandidateFingerprint !== null) {
      requireArtifact(candidateSource, expectedCandidateFingerprint, deps.appFingerprint, "requested desktop");
    }
    deps.cloneApp(candidateSource, candidateArtifactPath);
  }
  deps.cloneApp(input.current.selectedDesktopPath, rollbackArtifactPath);

  let runtime: PreparedRuntimeEvidence | undefined;
  let managedRuntime: PreparedManagedRuntimeEvidence | undefined;
  if (needsRuntimeEvidence) {
    const rollbackRuntime = snapshotRuntimeArtifact(
      activeRuntimeTarget,
      rollbackRuntimeArtifactPath,
      deps,
    );
    if (input.current.appExperience === "tweakers"
      && (!rollbackRuntime.existed || rollbackRuntime.runtimeFingerprint === null)) {
      throw new Error("The running Tweakers environment has no valid active runtime rollback evidence");
    }
    if (input.requested.appExperience === "tweakers") {
      // Production candidate construction writes this exact runtime. Custom
      // adapters may leave it absent; fill that seam from the packaged assets.
      if (!existsSync(requestedRuntimeArtifactPath)) {
        await deps.prepareRuntimeAssets(requestedRuntimeArtifactPath);
      }
    } else {
      if (!rollbackRuntime.existed) {
        throw new Error("The running Tweakers environment has no active runtime to preserve");
      }
      deps.cloneDirectory(rollbackRuntimeArtifactPath, requestedRuntimeArtifactPath);
    }
    const requestedRuntime = requireRuntimeArtifact(
      requestedRuntimeArtifactPath,
      deps,
      "requested runtime",
    );
    runtime = {
      targetPath: activeRuntimeTarget,
      requested: requestedRuntime,
      rollback: rollbackRuntime,
    };

    const rollbackManagedRuntime = snapshotManagedRuntimeArtifact(
      managedRuntimeTarget,
      rollbackManagedRuntimeArtifactPath,
      deps,
    );
    if (input.current.appExperience === "tweakers"
      && (!rollbackManagedRuntime.existed || rollbackManagedRuntime.runtimeFingerprint === null)) {
      throw new Error("The running Tweakers environment has no valid managed runtime rollback evidence");
    }
    let requestedManagedSourceHash: string | null;
    if (input.requested.appExperience === "tweakers") {
      if (requestedManagedRuntimePlan === null) {
        throw new Error("Managed runtime preparation plan is missing");
      }
      requestedManagedSourceHash = requestedManagedRuntimePlan.sourceRuntimeHash;
      await deps.prepareManagedRuntime(
        requestedManagedRuntimePlan.sourceRoot,
        requestedManagedRuntimeArtifactPath,
        requestedManagedRuntimePlan.provenance,
      );
      if (fingerprintManagedRuntimeSource(requestedManagedRuntimePlan.sourceRoot)
        !== requestedManagedRuntimePlan.sourceArtifactHash) {
        throw new Error("Managed runtime source changed while its candidate artifact was being staged");
      }
    } else {
      if (!rollbackManagedRuntime.existed) {
        throw new Error("The running Tweakers environment has no managed runtime to preserve");
      }
      deps.cloneDirectory(rollbackManagedRuntimeArtifactPath, requestedManagedRuntimeArtifactPath);
      sanitizeManagedRuntimeSymlinks(requestedManagedRuntimeArtifactPath);
      requestedManagedSourceHash = rollbackManagedRuntime.sourceRuntimeHash;
    }
    managedRuntime = {
      targetPath: managedRuntimeTarget,
      requested: requireManagedRuntimeArtifact(
        requestedManagedRuntimeArtifactPath,
        requestedManagedSourceHash,
        requestedManagedRuntimePlan?.provenance ?? null,
        requestedManagedRuntimePlan?.sourceControlHash ?? null,
        deps,
        "requested managed runtime",
      ),
      rollback: rollbackManagedRuntime,
    };
    if (input.requested.appExperience === "tweakers"
      && (runtime.requested.runtimeFingerprint.toLowerCase()
        !== managedRuntime.requested.runtimeFingerprint.toLowerCase()
        || runtime.requested.fileCount !== managedRuntime.requested.fileCount
        || runtime.requested.artifactDigest
          !== deps.directoryFingerprint(
            managedPackagedRuntimePath(managedRuntime.requested.artifactPath),
          ))) {
      throw new Error(
        "Prepared active runtime and managed packaged runtime were not built from the same assets",
      );
    }
  }

  const candidateIdentity = deps.readDesktopIdentity(candidateArtifactPath);
  if (candidateIdentity.bundleId !== input.requested.selectedDesktopBundleId) {
    throw new Error(
      `Prepared desktop bundle mismatch: expected ${input.requested.selectedDesktopBundleId}, got ${candidateIdentity.bundleId ?? "unknown"}`,
    );
  }
  if (candidateIdentity.version !== requestedProfile.officialVersion
    || candidateIdentity.build !== requestedProfile.officialBuild) {
    throw new Error("Prepared desktop version/build does not match the requested profile registry");
  }
  assertObservedAppExperience(candidateArtifactPath, input.requested.appExperience, deps);
  const candidateSignature = input.requested.appExperience === "chatgpt"
    ? deps.verifyOfficial({ ...input.requested, selectedDesktopPath: candidateArtifactPath })
    : deps.verifyPatched(candidateArtifactPath);
  if (!candidateSignature.strict || candidateSignature.designatedRequirement.trim().length === 0) {
    throw new Error("Prepared desktop candidate did not pass its signature contract");
  }

  const rollbackIdentity = deps.readDesktopIdentity(rollbackArtifactPath);
  if (rollbackIdentity.bundleId !== input.current.selectedDesktopBundleId) {
    throw new Error("Prepared rollback desktop bundle does not match the current selection");
  }
  if (rollbackIdentity.version === null || rollbackIdentity.build === null) {
    throw new Error("Prepared rollback desktop version/build is unreadable");
  }
  assertObservedAppExperience(rollbackArtifactPath, input.current.appExperience, deps);
  const rollbackSignature = input.current.appExperience === "chatgpt"
    ? deps.verifyOfficial({ ...input.current, selectedDesktopPath: rollbackArtifactPath })
    : deps.verifyPatched(rollbackArtifactPath);
  if (!rollbackSignature.strict || rollbackSignature.designatedRequirement.trim().length === 0) {
    throw new Error("Prepared rollback desktop did not pass its signature contract");
  }
  const candidateDigest = deps.appFingerprint(candidateArtifactPath);
  const rollbackDigest = deps.appFingerprint(rollbackArtifactPath);
  const candidateAsarHeaderHash = deps.readAsarHeaderHash(candidateArtifactPath);
  const rollbackAsarHeaderHash = deps.readAsarHeaderHash(rollbackArtifactPath);

  // Stage the swap helper only after both payloads proved their signature
  // contract, so the receipt-owned copy inherits verified provenance. Exactly
  // one side of a real transition carries a Tweakers host: the candidate on
  // the way in, the rollback clone on the way out.
  const swapHostPath = preparedSwapHostPath(preparedRoot);
  const stagedSwapHost = deps.stageSwapHost(
    [candidateArtifactPath, rollbackArtifactPath],
    swapHostPath,
  );
  const swapHost: PreparedSwapHostEvidence | undefined = stagedSwapHost === null
    ? undefined
    : { ...stagedSwapHost, path: swapHostPath };

  const requestedBackendRegistryPath = input.requested.backendLane === "official-bundled"
    ? requestedProfile.officialBackendPath
    : requestedProfile.backendPath;
  const candidateBackendSource = backendSourcePath(
    input.requested,
    requestedBackendRegistryPath,
    candidateArtifactPath,
  );
  const candidateBackendTarget = backendTargetPath(input.requested, requestedBackendRegistryPath);
  const candidateBackendArtifact = join(preparedRoot, "backend", "requested-codex");
  if (input.requested.backendLane === "managed-alpha") {
    // Never trust a pre-existing channel copy by version/hash alone. Every
    // Alpha preparation is sourced again from the manager's committed receipt
    // and strict OpenAI signature/team/architecture validation.
    await deps.prepareManagedBackend(requestedProfile, candidateBackendArtifact);
  } else {
    stageBackend(candidateBackendSource, candidateBackendArtifact, deps);
  }
  const candidateBackendDigest = deps.fileFingerprint(candidateBackendArtifact);
  const expectedBackendFingerprint = input.requested.backendLane === "managed-alpha"
    ? requestedProfile.backendFingerprint
    : bundledDerivedBackend?.fingerprint ?? requestedProfile.officialBackendFingerprint;
  if (expectedBackendFingerprint !== null && expectedBackendFingerprint !== candidateBackendDigest) {
    throw new Error(
      `Prepared backend fingerprint ${candidateBackendDigest} does not match expected ${expectedBackendFingerprint}`,
    );
  }
  const candidateBackendVersion = deps.readBackendVersion(candidateBackendArtifact)
    ?? (input.requested.backendLane === "managed-alpha"
      ? requestedProfile.backendVersion
      : bundledDerivedBackend?.version ?? requestedProfile.officialBackendVersion);
  if (candidateBackendVersion === null) throw new Error("Prepared backend version is unknown");
  const expectedBackendVersion = input.requested.backendLane === "managed-alpha"
    ? requestedProfile.backendVersion
    : bundledDerivedBackend?.version ?? requestedProfile.officialBackendVersion;
  if (expectedBackendVersion !== null && candidateBackendVersion !== expectedBackendVersion) {
    throw new Error("Prepared backend version does not match the requested bundled-derived artifact");
  }

  const rollbackBackendRegistryPath = input.current.backendLane === "official-bundled"
    ? currentProfile.officialBackendPath
    : currentProfile.backendPath;
  const rollbackBackendSource = backendSourcePath(
    input.current,
    rollbackBackendRegistryPath,
    rollbackArtifactPath,
  );
  const rollbackBackendTarget = backendTargetPath(input.current, rollbackBackendRegistryPath);
  const rollbackBackendArtifact = join(preparedRoot, "backend", "rollback-codex");
  if (input.current.backendLane === "managed-alpha") {
    const runningDesktopIdentity = deps.readDesktopIdentity(input.current.selectedDesktopPath);
    const runningAsarHeaderHash = deps.readAsarHeaderHash(input.current.selectedDesktopPath);
    const proof = deps.readRuntimeProof(
      options.runtimeProofFile ?? join(dirname(options.configFile), "environment-runtime-proof.json"),
    );
    if (!proof
      || (input.oldMainPid !== null && proof.pid !== input.oldMainPid)
      || proof.appRoot !== input.current.selectedDesktopPath
      || proof.bundleId !== input.current.selectedDesktopBundleId
      || proof.desktopVersion !== runningDesktopIdentity.version
      || proof.desktopBuild !== runningDesktopIdentity.build
      || proof.appAsarHeaderHash.toLowerCase() !== runningAsarHeaderHash.toLowerCase()
      || proof.releaseProfile !== input.current.releaseProfile
      || proof.backendLane !== "managed-alpha"
      || proof.binaryPath !== rollbackBackendSource
      || proof.backendVersion !== currentProfile.backendVersion
      || proof.backendFingerprint.toLowerCase() !== (currentProfile.backendFingerprint ?? "").toLowerCase()
      || !existsSync(rollbackBackendSource)
      || deps.fileFingerprint(rollbackBackendSource).toLowerCase() !== proof.backendFingerprint.toLowerCase()
      || deps.readBackendVersion(rollbackBackendSource) !== proof.backendVersion) {
      throw new Error("Managed Alpha rollback backend does not match the exact running runtime proof");
    }
  }
  stageBackend(rollbackBackendSource, rollbackBackendArtifact, deps);
  const rollbackBackendVersion = deps.readBackendVersion(rollbackBackendArtifact)
    ?? (input.current.backendLane === "official-bundled" || input.current.backendLane === "bundled"
      ? currentProfile.officialBackendVersion
      : currentProfile.backendVersion);
  if (rollbackBackendVersion === null) throw new Error("Prepared rollback backend version is unknown");

  return {
    preparedAt,
    candidate: {
      desktopPath: input.requested.selectedDesktopPath,
      artifactPath: candidateArtifactPath,
      bundleId: input.requested.selectedDesktopBundleId,
      appExperience: input.requested.appExperience,
      releaseProfile: input.requested.releaseProfile,
      version: candidateIdentity.version!,
      build: candidateIdentity.build!,
      artifactDigest: candidateDigest,
      asarHeaderHash: candidateAsarHeaderHash,
      signature: candidateSignature,
    },
    swapHost,
    backend: {
      lane: input.requested.backendLane,
      binaryPath: candidateBackendTarget,
      artifactPath: candidateBackendArtifact,
      version: candidateBackendVersion,
      artifactDigest: candidateBackendDigest,
    },
    ...(runtime ? { runtime } : {}),
    ...(managedRuntime ? { managedRuntime } : {}),
    rollback: {
      selection: input.current,
      desktopPath: input.current.selectedDesktopPath,
      desktopArtifactPath: rollbackArtifactPath,
      archivePath: input.current.appExperience === "chatgpt"
        ? currentProfile.pristineBackupPath
        : currentProfile.patchedPayloadPath,
      bundleId: input.current.selectedDesktopBundleId,
      desktopVersion: rollbackIdentity.version!,
      desktopBuild: rollbackIdentity.build!,
      desktopArtifactDigest: rollbackDigest,
      desktopAsarHeaderHash: rollbackAsarHeaderHash,
      signature: rollbackSignature,
      backendLane: input.current.backendLane,
      backendBinaryPath: rollbackBackendTarget,
      backendArtifactPath: rollbackBackendArtifact,
      backendVersion: rollbackBackendVersion,
      backendArtifactDigest: deps.fileFingerprint(rollbackBackendArtifact),
    },
  };
}

/** One stable receipt-owned path per transaction, so `require` caches once. */
function preparedSwapHostPath(preparedRoot: string): string {
  return join(preparedRoot, "swap", "tweaker_native_host.node");
}

function loadBundledDerivedBackend(
  receiptFile: string,
  profile: EnvironmentProfileRecord,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): ValidatedBundledDerivedArtifact {
  if (!exactAbsolutePath(receiptFile)) {
    throw new Error("Bundled-derived receipt path must be exact and absolute");
  }
  assertInternalStoragePath(receiptFile, "Bundled-derived receipt");
  const artifact = deps.readBundledDerivedArtifact(receiptFile);
  for (const [label, path] of [
    ["binary", artifact.binaryPath],
    ["receipt", artifact.receiptPath],
  ] as const) {
    if (!exactAbsolutePath(path)) {
      throw new Error(`Bundled-derived ${label} path must be exact and absolute`);
    }
    assertInternalStoragePath(path, `Bundled-derived ${label}`);
  }
  if (artifact.receiptPath !== receiptFile) {
    throw new Error("Bundled-derived artifact receipt does not match the configured receipt");
  }
  if (!validDigest(artifact.fingerprint)) {
    throw new Error("Bundled-derived artifact fingerprint is invalid");
  }
  if (profile.officialBackendVersion === null
    || artifact.version !== profile.officialBackendVersion) {
    throw new Error(
      `Bundled-derived backend version ${artifact.version} does not match desktop control `
      + `${profile.officialBackendVersion ?? "unknown"}`,
    );
  }
  return artifact;
}

function requireRuntimeArtifact(
  artifactPath: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
  label: string,
): PreparedRuntimeArtifactEvidence {
  if (!pathEntryExists(artifactPath)) throw new Error(`${label} is missing at ${artifactPath}`);
  assertSelfContainedSymlinks(artifactPath, label);
  const runtime = deps.readRuntimeFingerprintEvidence(artifactPath);
  if (!runtime) throw new Error(`${label} fingerprint evidence is invalid at ${artifactPath}`);
  return {
    artifactPath,
    artifactDigest: deps.directoryFingerprint(artifactPath),
    runtimeFingerprint: runtime.fingerprint,
    fileCount: runtime.fileCount,
  };
}

function snapshotRuntimeArtifact(
  source: string,
  destination: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): PreparedRuntimeRollbackArtifactEvidence {
  rmSync(destination, { recursive: true, force: true });
  if (!pathEntryExists(source)) {
    return {
      existed: false,
      artifactPath: destination,
      artifactDigest: null,
      runtimeFingerprint: null,
      fileCount: null,
    };
  }
  deps.cloneDirectory(source, destination);
  assertRollbackContainedSymlinks(destination, "rollback runtime");
  const runtime = deps.readRuntimeFingerprintEvidence(destination);
  return {
    existed: true,
    artifactPath: destination,
    artifactDigest: deps.directoryFingerprint(destination),
    runtimeFingerprint: runtime?.fingerprint ?? null,
    fileCount: runtime?.fileCount ?? null,
  };
}

function requireManagedRuntimeArtifact(
  artifactPath: string,
  expectedSourceRuntimeHash: string | null,
  expectedProvenance: ManagedRuntimeProvenance | null,
  expectedControlHash: string | null,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
  label: string,
): PreparedManagedRuntimeArtifactEvidence {
  if (!pathEntryExists(artifactPath)) throw new Error(`${label} is missing at ${artifactPath}`);
  assertSelfContainedSymlinks(artifactPath, label);
  const packagedRuntimePath = managedPackagedRuntimePath(artifactPath);
  const runtime = deps.readRuntimeFingerprintEvidence(packagedRuntimePath);
  if (!runtime) {
    throw new Error(`${label} packaged runtime fingerprint is invalid at ${packagedRuntimePath}`);
  }
  const sourceRuntimeHash = readManagedSourceRuntimeHash(artifactPath);
  if (expectedSourceRuntimeHash !== null
    && sourceRuntimeHash?.toLowerCase() !== expectedSourceRuntimeHash.toLowerCase()) {
    throw new Error(`${label} provenance does not match the staged source`);
  }
  if (expectedProvenance !== null) {
    const provenance = readManagedRuntimeProvenance(artifactPath);
    if (provenance === null || stableJson(provenance) !== stableJson(expectedProvenance)) {
      throw new Error(`${label} full provenance does not match the staged source`);
    }
  }
  const sourceControlHash = fingerprintManagedRuntimeControlPlane(artifactPath);
  if (expectedControlHash !== null && sourceControlHash !== expectedControlHash) {
    throw new Error(`${label} control-plane bytes do not match the executing source`);
  }
  const cliPath = join(artifactPath, "packages", "installer", "dist", "cli.js");
  assertPreparedArtifactContained(artifactPath, cliPath, `${label} CLI`, false, "file");
  return {
    artifactPath,
    artifactDigest: deps.directoryFingerprint(artifactPath),
    runtimeFingerprint: runtime.fingerprint,
    fileCount: runtime.fileCount,
    sourceRuntimeHash,
    cliPath,
    cliArtifactDigest: sha256File(cliPath),
  };
}

function snapshotManagedRuntimeArtifact(
  source: string,
  destination: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): PreparedManagedRuntimeRollbackArtifactEvidence {
  rmSync(destination, { recursive: true, force: true });
  if (!pathEntryExists(source)) {
    return {
      existed: false,
      artifactPath: destination,
      artifactDigest: null,
      runtimeFingerprint: null,
      fileCount: null,
      sourceRuntimeHash: null,
    };
  }
  deps.cloneDirectory(source, destination);
  assertRollbackContainedSymlinks(destination, "rollback managed runtime");
  const runtime = deps.readRuntimeFingerprintEvidence(managedPackagedRuntimePath(destination));
  return {
    existed: true,
    artifactPath: destination,
    artifactDigest: deps.directoryFingerprint(destination),
    runtimeFingerprint: runtime?.fingerprint ?? null,
    fileCount: runtime?.fileCount ?? null,
    sourceRuntimeHash: readManagedSourceRuntimeHash(destination),
  };
}

function managedPackagedRuntimePath(root: string): string {
  return join(root, "packages", "installer", "assets", "runtime");
}

function readManagedSourceRuntimeHash(root: string): string | null {
  const value = readManagedRuntimeProvenance(root);
  const sourceRuntimeHash = value?.sourceRuntimeHash;
  return typeof sourceRuntimeHash === "string" && /^[a-f0-9]{64}$/i.test(sourceRuntimeHash)
    ? sourceRuntimeHash
    : null;
}

function readManagedRuntimeProvenance(root: string): ManagedRuntimeProvenance | null {
  try {
    const value = JSON.parse(readFileSync(join(root, ".tweakers-provenance.json"), "utf8")) as unknown;
    return isRecord(value) ? { ...value } : null;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  const normalizeValue = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalizeValue);
    if (!isRecord(input)) return input;
    return Object.fromEntries(
      Object.entries(input)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeValue(entry)]),
    );
  };
  return JSON.stringify(normalizeValue(value));
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export function fingerprintDirectoryTree(root: string): string {
  if (!pathEntryExists(root)) return "missing";
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Directory fingerprint root must be a real directory: ${root}`);
  }
  const hash = createHash("sha256");
  const addEntry = (
    type: "directory" | "file" | "symlink",
    relativePath: string,
    mode: number,
    payload: Buffer,
  ): void => {
    const header = `${type}\0${relativePath.replaceAll("\\", "/")}\0${(mode & 0o7777).toString(8)}\0${payload.length}\0`;
    hash.update(header);
    hash.update(payload);
  };
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      // Finder drops .DS_Store into browsed directories; hashing it would let
      // casual browsing permanently invalidate receipt-owned evidence.
      if (isMacOsJunkName(entry.name)) continue;
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        addEntry("directory", relativePath, stat.mode, Buffer.alloc(0));
        visit(path);
      } else if (stat.isFile()) {
        addEntry("file", relativePath, stat.mode, readFileSync(path));
      } else if (stat.isSymbolicLink()) {
        addEntry("symlink", relativePath, stat.mode, Buffer.from(readlinkSync(path), "utf8"));
      } else {
        throw new Error(`Directory fingerprint does not support special entry ${path}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function assertSelfContainedSymlinks(root: string, label: string): void {
  assertContainedSymlinks(root, label, false);
}

function assertRollbackContainedSymlinks(root: string, label: string): void {
  assertContainedSymlinks(root, label, true);
}

function assertContainedSymlinks(
  root: string,
  label: string,
  allowBrokenInternal: boolean,
): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root must be a real directory`);
  }
  const lexicalRoot = resolve(root);
  const canonicalRoot = realpathSync(root);
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(path);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const target = readlinkSync(path);
      if (isAbsolute(target)) {
        throw new Error(`${label} contains an absolute symlink at ${path}`);
      }
      const lexicalTarget = resolve(dirname(path), target);
      if (!pathWithinOrEqual(lexicalRoot, lexicalTarget)) {
        throw new Error(`${label} contains an escaping symlink at ${path}`);
      }
      let canonicalTarget: string;
      try {
        canonicalTarget = realpathSync(path);
      } catch (error) {
        if (allowBrokenInternal && isFileSystemError(error, "ENOENT")) continue;
        throw new Error(`${label} contains a broken or cyclic symlink at ${path}`);
      }
      if (!pathWithinOrEqual(canonicalRoot, canonicalTarget)) {
        throw new Error(`${label} contains a canonically escaping symlink at ${path}`);
      }
    }
  };
  visit(root);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function cloneDirectorySnapshot(source: string, destination: string): void {
  if (!pathEntryExists(source)) throw new Error(`Directory snapshot source is missing at ${source}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  copyDirectoryPreservingModes(source, destination);
}

function replaceDirectoryAtomically(source: string, destination: string): void {
  if (!pathEntryExists(source)) throw new Error(`Directory replacement source is missing at ${source}`);
  const temporary = `${destination}.environment-next-${process.pid}-${randomUUID()}`;
  const previous = `${destination}.environment-previous-${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(temporary, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  let previousMoved = false;
  let replacementMoved = false;
  let previousReleasedOrRestored = false;
  try {
    copyDirectoryPreservingModes(source, temporary);
    if (existsSync(destination)) {
      renameSync(destination, previous);
      previousMoved = true;
    }
    renameSync(temporary, destination);
    replacementMoved = true;
    rmSync(previous, { recursive: true, force: true });
    previousReleasedOrRestored = true;
  } catch (error) {
    let recoveryError: unknown = null;
    try {
      if (replacementMoved) rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        if (!existsSync(previous)) {
          throw new Error(`previous directory disappeared during recovery: ${previous}`);
        }
        if (existsSync(destination)) {
          throw new Error(`replacement directory could not be removed during recovery: ${destination}`);
        }
        renameSync(previous, destination);
      }
      previousReleasedOrRestored = true;
    } catch (caught) {
      recoveryError = caught;
    }
    if (recoveryError !== null) {
      throw new Error(
        `Directory replacement failed: ${errorMessage(error)}; recovery failed: ${errorMessage(recoveryError)}; `
        + `previous directory retained at ${previous}`,
      );
    }
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (previousReleasedOrRestored) {
      rmSync(previous, { recursive: true, force: true });
    }
  }
}

function ensureEnvironmentRegistryForPrepare(
  input: { current: EnvironmentSelection },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): EnvironmentProfileRegistry {
  const existing = readEnvironmentProfileRegistry(options.registryFile);
  if (existing !== null) return existing;
  const environmentRoot = options.environmentRoot ?? dirname(options.configFile);
  const selectionFile = options.selectionFile ?? join(environmentRoot, "environment-selection.json");
  const stableDesktopPath = input.current.releaseProfile === "stable"
    ? input.current.selectedDesktopPath
    : STABLE_DESKTOP_PATH;
  const alphaDesktopPath = input.current.releaseProfile === "alpha"
    ? input.current.selectedDesktopPath
    : ALPHA_DESKTOP_PATH;
  const loaded = deps.loadState({
    legacyStateFile: options.stateFile,
    registryFile: options.registryFile,
    selectionFile,
    environmentRoot,
    stableDesktopPath,
    alphaDesktopPath,
    now: input.current.requestedAt,
  });
  if (!selectionsMatch(loaded.current, input.current, true)) {
    throw new Error("Legacy environment truth does not match the requested transaction source");
  }
  const registry = {
    ...loaded.registry,
    selected: input.current,
    lastKnownWorkingSelection: loaded.registry.lastKnownWorkingSelection ?? input.current,
  };
  // Publishing recomputed registry evidence is safe during preparation; the
  // requested selection file remains untouched until post-reopen proof.
  writeEnvironmentProfileRegistry(options.registryFile, registry);
  return registry;
}

function validatePreparedEnvironment(
  input: {
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
    direction?: "requested" | "rollback";
  },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  const { receipt, prepared } = input;
  const requiresRuntime = receipt.source.appExperience === "tweakers"
    || receipt.requested.appExperience === "tweakers";
  if (requiresRuntime && (!prepared.runtime || !prepared.managedRuntime)) {
    throw new Error(
      `Environment transaction ${receipt.transactionId} predates atomic runtime evidence; cancel it and prepare a new candidate`,
    );
  }
  const directions: Array<"requested" | "rollback"> = input.direction
    ? [input.direction]
    : ["requested", "rollback"];
  const preparedRoot = join(options.receiptRoot, receipt.transactionId, "prepared");
  assertPreparedArtifactContained(
    options.receiptRoot,
    preparedRoot,
    "prepared transaction root",
    false,
    "directory",
  );
  // The swap helper is proven here, before any caller stops the live app, so a
  // transaction that cannot exchange bundles fails without costing a quit.
  if (prepared.swapHost !== undefined) {
    assertPreparedArtifactContained(
      preparedRoot,
      prepared.swapHost.path,
      "prepared swap host",
      false,
      "file",
    );
    deps.loadSwapHost(prepared.swapHost);
  }
  for (const direction of directions) {
    const requestedDirection = direction === "requested";
    const appPath = requestedDirection
      ? prepared.candidate.artifactPath
      : prepared.rollback.desktopArtifactPath;
    const appDigest = requestedDirection
      ? prepared.candidate.artifactDigest
      : prepared.rollback.desktopArtifactDigest;
    const appSelection = requestedDirection ? receipt.requested : prepared.rollback.selection;
    const appVersion = requestedDirection
      ? prepared.candidate.version
      : prepared.rollback.desktopVersion;
    const appBuild = requestedDirection
      ? prepared.candidate.build
      : prepared.rollback.desktopBuild;
    const appSignature = requestedDirection
      ? prepared.candidate.signature
      : prepared.rollback.signature;
    const backendPath = requestedDirection
      ? prepared.backend.artifactPath
      : prepared.rollback.backendArtifactPath;
    const backendDigest = requestedDirection
      ? prepared.backend.artifactDigest
      : prepared.rollback.backendArtifactDigest;
    assertLivePayloadIsNotNewer(appSelection.selectedDesktopPath, appVersion, appBuild, direction, deps);
    assertPreparedArtifactContained(
      preparedRoot,
      appPath,
      `${direction} desktop artifact`,
      false,
      "directory",
    );
    assertPreparedArtifactContained(
      preparedRoot,
      backendPath,
      `${direction} backend artifact`,
      false,
      "file",
    );
    if (!appSignature) {
      throw new Error(
        `Environment transaction ${receipt.transactionId} predates rollback trust evidence; `
        + "cancel it and prepare a new candidate",
      );
    }
    validatePreparedAppArtifact(
      appPath,
      appDigest,
      appSelection,
      appVersion,
      appBuild,
      appSignature,
      direction,
      deps,
    );
    if (deps.requiresSwapHostForExistingApp
      && prepared.swapHost === undefined
      && liveDesktopRequiresAtomicExchange(appSelection, appDigest, deps)) {
      throw new Error(
        `Prepared ${direction} desktop requires an atomic exchange at `
        + `${appSelection.selectedDesktopPath}, but environment transaction `
        + `${receipt.transactionId} has no signed receipt-owned swap host`,
      );
    }
    validatePreparedBackendArtifact(backendPath, backendDigest, direction, deps);
    if (!requiresRuntime || !prepared.runtime || !prepared.managedRuntime) continue;
    const environmentRoot = options.environmentRoot ?? dirname(options.configFile);
    if (prepared.runtime.targetPath !== join(environmentRoot, "runtime")
      || prepared.managedRuntime.targetPath !== managedSourceRoot(environmentRoot)) {
      throw new Error("Prepared runtime targets do not match the managed environment root");
    }
    const runtimeEvidence = requestedDirection
      ? prepared.runtime.requested
      : prepared.runtime.rollback;
    const managedRuntimeEvidence = requestedDirection
      ? prepared.managedRuntime.requested
      : prepared.managedRuntime.rollback;
    const runtimeMissing = "existed" in runtimeEvidence && !runtimeEvidence.existed;
    const managedRuntimeMissing = "existed" in managedRuntimeEvidence && !managedRuntimeEvidence.existed;
    assertPreparedArtifactContained(
      preparedRoot,
      runtimeEvidence.artifactPath,
      `${direction} runtime artifact`,
      runtimeMissing,
      "directory",
    );
    assertPreparedArtifactContained(
      preparedRoot,
      managedRuntimeEvidence.artifactPath,
      `${direction} managed runtime artifact`,
      managedRuntimeMissing,
      "directory",
    );
    if (requestedDirection) {
      validateRequestedRuntimeEvidence(prepared.runtime.requested, "requested runtime", deps);
      validateRequestedManagedRuntimeEvidence(
        prepared.managedRuntime.requested,
        "requested managed runtime",
        deps,
      );
    } else {
      validateRollbackRuntimeEvidence(prepared.runtime.rollback, "rollback runtime", deps);
      validateRollbackManagedRuntimeEvidence(
        prepared.managedRuntime.rollback,
        "rollback managed runtime",
        deps,
      );
    }
  }
}

function validatePreparedAppArtifact(
  path: string,
  digest: string,
  selection: EnvironmentSelection,
  version: string,
  build: string,
  expectedSignature: PreparedCandidateSignatureEvidence,
  direction: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!existsSync(path) || deps.appFingerprint(path) !== digest) {
    throw new Error(`Prepared ${direction} desktop artifact is missing or changed`);
  }
  const identity = deps.readDesktopIdentity(path);
  if (identity.bundleId !== selection.selectedDesktopBundleId
    || identity.version !== version
    || identity.build !== build
    || observedAppExperience(path, deps) !== selection.appExperience) {
    throw new Error(`Prepared ${direction} desktop identity or experience is missing or changed`);
  }
  const signature = selection.appExperience === "chatgpt"
    ? deps.verifyOfficial({ ...selection, selectedDesktopPath: path })
    : deps.verifyPatched(path);
  if (signature.strict !== expectedSignature.strict
    || signature.gatekeeper !== expectedSignature.gatekeeper
    || signature.designatedRequirement !== expectedSignature.designatedRequirement
    || signature.teamIdentifier !== expectedSignature.teamIdentifier) {
    throw new Error(`Prepared ${direction} desktop signature evidence is missing or changed`);
  }
}

function validatePreparedBackendArtifact(
  path: string,
  digest: string,
  direction: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!existsSync(path) || deps.fileFingerprint(path) !== digest) {
    throw new Error(`Prepared ${direction} backend artifact is missing or changed`);
  }
}

function liveDesktopRequiresAtomicExchange(
  selection: EnvironmentSelection,
  expectedDigest: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): boolean {
  if (!existsSync(selection.selectedDesktopPath)) return false;
  const identity = deps.readDesktopIdentity(selection.selectedDesktopPath);
  return identity.bundleId !== selection.selectedDesktopBundleId
    || deps.appFingerprint(selection.selectedDesktopPath) !== expectedDigest
    || observedAppExperience(selection.selectedDesktopPath, deps) !== selection.appExperience;
}

function validateRequestedRuntimeEvidence(
  evidence: PreparedRuntimeArtifactEvidence,
  label: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!pathEntryExists(evidence.artifactPath)
    || deps.directoryFingerprint(evidence.artifactPath) !== evidence.artifactDigest) {
    throw new Error(`Prepared ${label} artifact is missing or changed`);
  }
  assertSelfContainedSymlinks(evidence.artifactPath, label);
  const runtime = deps.readRuntimeFingerprintEvidence(evidence.artifactPath);
  if (!runtime
    || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
    || runtime.fileCount !== evidence.fileCount) {
    throw new Error(`Prepared ${label} fingerprint evidence is missing or changed`);
  }
}

function validateRollbackRuntimeEvidence(
  evidence: PreparedRuntimeRollbackArtifactEvidence,
  label: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!evidence.existed) {
    if (pathEntryExists(evidence.artifactPath)) throw new Error(`Prepared absent ${label} unexpectedly exists`);
    return;
  }
  assertRollbackContainedSymlinks(evidence.artifactPath, label);
  if (!pathEntryExists(evidence.artifactPath)
    || evidence.artifactDigest === null
    || deps.directoryFingerprint(evidence.artifactPath) !== evidence.artifactDigest) {
    throw new Error(`Prepared ${label} artifact is missing or changed`);
  }
  if (evidence.runtimeFingerprint !== null) {
    const runtime = deps.readRuntimeFingerprintEvidence(evidence.artifactPath);
    if (!runtime
      || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
      || runtime.fileCount !== evidence.fileCount) {
      throw new Error(`Prepared ${label} fingerprint evidence is missing or changed`);
    }
  }
}

function validateRequestedManagedRuntimeEvidence(
  evidence: PreparedManagedRuntimeArtifactEvidence,
  label: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!pathEntryExists(evidence.artifactPath)
    || deps.directoryFingerprint(evidence.artifactPath) !== evidence.artifactDigest) {
    throw new Error(`Prepared ${label} artifact is missing or changed`);
  }
  assertSelfContainedSymlinks(evidence.artifactPath, label);
  const runtime = deps.readRuntimeFingerprintEvidence(managedPackagedRuntimePath(evidence.artifactPath));
  if (!runtime
    || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
    || runtime.fileCount !== evidence.fileCount
    || readManagedSourceRuntimeHash(evidence.artifactPath) !== evidence.sourceRuntimeHash) {
    throw new Error(`Prepared ${label} fingerprint or provenance evidence is missing or changed`);
  }
  const expectedCliPath = join(evidence.artifactPath, "packages", "installer", "dist", "cli.js");
  if (evidence.cliPath !== expectedCliPath || !sha256(evidence.cliArtifactDigest)) {
    throw new Error(`Prepared ${label} predates receipt-owned CLI evidence`);
  }
  assertPreparedArtifactContained(
    evidence.artifactPath,
    evidence.cliPath,
    `${label} CLI`,
    false,
    "file",
  );
  if (sha256File(evidence.cliPath) !== evidence.cliArtifactDigest.toLowerCase()) {
    throw new Error(`Prepared ${label} CLI is missing or changed`);
  }
}

function validateRollbackManagedRuntimeEvidence(
  evidence: PreparedManagedRuntimeRollbackArtifactEvidence,
  label: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!evidence.existed) {
    if (pathEntryExists(evidence.artifactPath)) throw new Error(`Prepared absent ${label} unexpectedly exists`);
    return;
  }
  assertRollbackContainedSymlinks(evidence.artifactPath, label);
  if (!pathEntryExists(evidence.artifactPath)
    || evidence.artifactDigest === null
    || deps.directoryFingerprint(evidence.artifactPath) !== evidence.artifactDigest) {
    throw new Error(`Prepared ${label} artifact is missing or changed`);
  }
  if (evidence.runtimeFingerprint !== null) {
    const runtime = deps.readRuntimeFingerprintEvidence(managedPackagedRuntimePath(evidence.artifactPath));
    if (!runtime
      || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
      || runtime.fileCount !== evidence.fileCount) {
      throw new Error(`Prepared ${label} fingerprint evidence is missing or changed`);
    }
  }
  if (readManagedSourceRuntimeHash(evidence.artifactPath) !== evidence.sourceRuntimeHash) {
    throw new Error(`Prepared ${label} provenance evidence is missing or changed`);
  }
}

function pathWithin(root: string, candidate: string): boolean {
  if (!pathWithinOrEqual(root, candidate)) return false;
  const relativePath = relative(normalize(root), normalize(candidate));
  return relativePath !== "";
}

/**
 * The official desktop can update itself while a transaction is stranded, and
 * nothing else compares the recorded payload against the live bundle. Restoring
 * an older recorded payload over a newer live one would silently downgrade the
 * user's app, so refuse here — before any caller stops it.
 */
function assertLivePayloadIsNotNewer(
  desktopPath: string,
  preparedVersion: string,
  preparedBuild: string,
  direction: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!existsSync(desktopPath)) return;
  const live = deps.readDesktopIdentity(desktopPath);
  const advanced = desktopVersionAdvanced(
    { marketingVersion: preparedVersion, build: preparedBuild },
    { marketingVersion: live.version, build: live.build },
  );
  if (!advanced) return;
  throw new Error(
    `Refusing to replace ${desktopPath} with the prepared ${direction} payload: `
    + `the live desktop is ${live.version ?? "unknown"} (build ${live.build ?? "unknown"}) `
    + `and the prepared payload is the older ${preparedVersion} (build ${preparedBuild})`,
  );
}

function assertPreparedArtifactContained(
  root: string,
  candidate: string,
  label: string,
  allowMissing: boolean,
  expectedKind: "directory" | "file",
): void {
  if (!pathWithin(root, candidate)) {
    throw new Error(`Prepared transaction artifact escapes its receipt root: ${candidate}`);
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Prepared transaction containment root is not a real directory: ${root}`);
  }
  const canonicalRoot = realpathSync(root);
  const relativePath = relative(normalize(root), normalize(candidate));
  let cursor = normalize(root);
  for (const segment of relativePath.split(/[\\/]/)) {
    cursor = join(cursor, segment);
    if (!pathEntryExists(cursor)) {
      if (allowMissing) return;
      throw new Error(`Prepared ${label} is missing at ${cursor}`);
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Prepared ${label} uses a symlink alias at ${cursor}`);
    }
  }
  const candidateStat = lstatSync(candidate);
  if ((expectedKind === "directory" && !candidateStat.isDirectory())
    || (expectedKind === "file" && !candidateStat.isFile())) {
    throw new Error(`Prepared ${label} is not a real ${expectedKind}`);
  }
  const canonicalCandidate = realpathSync(candidate);
  if (!pathWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error(`Prepared ${label} is not canonically contained by its receipt`);
  }
}

function pathWithinOrEqual(root: string, candidate: string): boolean {
  const relativePath = relative(normalize(root), normalize(candidate));
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(relativePath));
}

function applyPreparedEnvironment(
  input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
    onProgress?: (step: string) => void;
  },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  // Each stamp is persisted synchronously by the caller before the next
  // sub-step executes, so a process death mid-apply leaves a durable record
  // of how far it got. A stamp proves a step started, not that it completed.
  const stamp = (step: string): void => {
    input.onProgress?.(step);
  };
  stamp("validate");
  validatePreparedEnvironment(
    { receipt: input.receipt, prepared: input.prepared, direction: input.direction },
    options,
    deps,
  );
  const requestedDirection = input.direction === "requested";
  const selection = requestedDirection ? input.receipt.requested : input.prepared.rollback.selection;
  const artifactPath = requestedDirection
    ? input.prepared.candidate.artifactPath
    : input.prepared.rollback.desktopArtifactPath;
  const expectedDigest = requestedDirection
    ? input.prepared.candidate.artifactDigest
    : input.prepared.rollback.desktopArtifactDigest;
  if (requestedDirection && selection.appExperience === "tweakers" && existsSync(selection.selectedDesktopPath)) {
    const marker = observedAppExperience(selection.selectedDesktopPath, deps);
    if (marker === "chatgpt") {
      const registry = readEnvironmentProfileRegistry(options.registryFile);
      const profile = registry?.profiles[selection.releaseProfile];
      if (!profile) throw new Error(`Cannot preserve the ${selection.releaseProfile} pristine desktop without its registry profile`);
      const identity = deps.readDesktopIdentity(selection.selectedDesktopPath);
      if (identity.bundleId !== selection.selectedDesktopBundleId) {
        throw new Error(`Refusing to archive a pristine desktop with the wrong bundle at ${selection.selectedDesktopPath}`);
      }
      stamp("pristine-backup");
      const pristineDigest = deps.appFingerprint(selection.selectedDesktopPath);
      deps.cloneApp(selection.selectedDesktopPath, profile.pristineBackupPath);
      if (deps.appFingerprint(profile.pristineBackupPath) !== pristineDigest
        || observedAppExperience(profile.pristineBackupPath, deps) !== "chatgpt") {
        throw new Error(`Could not preserve the ${selection.releaseProfile} pristine desktop before cutover`);
      }
    } else if (marker === null) {
      throw new Error(`Cannot determine whether ${selection.selectedDesktopPath} is pristine before cutover`);
    }
  }
  const provesTarget = (destination: string): boolean => (
    !liveDesktopRequiresAtomicExchange(
      { ...selection, selectedDesktopPath: destination },
      expectedDigest,
      deps,
    )
  );
  // A destination that already proves the target needs no bundle exchange:
  // swapping identical bytes buys nothing and would demand a native host that
  // a pristine→pristine restore cannot have.
  if (!existsSync(selection.selectedDesktopPath) || !provesTarget(selection.selectedDesktopPath)) {
    stamp("bundle-swap-start");
    deps.replaceApp(
      artifactPath,
      selection.selectedDesktopPath,
      provesTarget,
      input.prepared.swapHost === undefined
        ? undefined
        : deps.loadSwapHost(input.prepared.swapHost),
    );
    stamp("bundle-swap-done");
  }
  if (requestedDirection) {
    // Preserve the exact outgoing app in its own channel store. This is done
    // only after the live replacement validates and before state publication;
    // a copy failure therefore enters the coordinator's prepared rollback.
    stamp("archive-outgoing");
    deps.cloneApp(input.prepared.rollback.desktopArtifactPath, input.prepared.rollback.archivePath);
    const environmentRoot = options.environmentRoot ?? dirname(options.configFile);
    const legacyPatchedArchive = join(environmentRoot, "mode", "patched-payload", "ChatGPT.app");
    if (input.prepared.rollback.selection.appExperience === "tweakers"
      && normalize(input.prepared.rollback.archivePath) === normalize(legacyPatchedArchive)) {
      writePayloadMetadata(payloadMetadataFile(environmentRoot), {
        schemaVersion: 1,
        baseVersion: input.prepared.rollback.desktopVersion,
        baseBuild: input.prepared.rollback.desktopBuild,
        patchedAsarHash: readState(options.stateFile)?.patchedAsarHash ?? null,
        parkedAt: deps.now(),
      });
    }
  }

  if (input.prepared.runtime && input.prepared.managedRuntime) {
    const runtimeEvidence = requestedDirection
      ? input.prepared.runtime.requested
      : input.prepared.runtime.rollback;
    const managedRuntimeEvidence = requestedDirection
      ? input.prepared.managedRuntime.requested
      : input.prepared.managedRuntime.rollback;
    stamp("runtime-artifacts");
    applyRuntimeArtifact(runtimeEvidence, input.prepared.runtime.targetPath, deps, input.direction);
    applyManagedRuntimeArtifact(
      managedRuntimeEvidence,
      input.prepared.managedRuntime.targetPath,
      deps,
      input.direction,
    );
  }

  const backendArtifact = requestedDirection
    ? input.prepared.backend.artifactPath
    : input.prepared.rollback.backendArtifactPath;
  const backendTarget = requestedDirection
    ? input.prepared.backend.binaryPath
    : input.prepared.rollback.backendBinaryPath;
  const backendDigest = requestedDirection
    ? input.prepared.backend.artifactDigest
    : input.prepared.rollback.backendArtifactDigest;
  stamp("backend");
  if (selection.backendLane === "managed-alpha") deps.copyBackend(backendArtifact, backendTarget);
  if (!existsSync(backendTarget) || deps.fileFingerprint(backendTarget) !== backendDigest) {
    throw new Error(`Applied ${input.direction} backend fingerprint does not match prepared evidence`);
  }
  deps.writeBackendLane(
    options.configFile,
    selection.backendLane,
    selection.backendLane === "managed-alpha"
      ? { binaryPath: backendTarget, version: requestedDirection
        ? input.prepared.backend.version
        : input.prepared.rollback.backendVersion, fingerprint: backendDigest }
      : undefined,
  );
  const desktopVersion = requestedDirection
    ? input.prepared.candidate.version
    : input.prepared.rollback.desktopVersion;
  const patchedAsarEvidence = selection.appExperience === "tweakers"
    ? deps.readPatchedAsarEvidence(selection.selectedDesktopPath)
    : null;
  const originalAsarHash = selection.appExperience === "chatgpt"
    ? deps.readAsarHeaderHash(selection.selectedDesktopPath)
    : requestedDirection && input.prepared.rollback.selection.appExperience === "chatgpt"
      ? deps.readAsarHeaderHash(input.prepared.rollback.desktopArtifactPath)
      : null;
  stamp("state-write");
  deps.writeAppState(
    options.stateFile,
    selection,
    desktopVersion,
    patchedAsarEvidence,
    originalAsarHash,
  );
  // The source desktop is already stopped when this adapter runs. Project the
  // target MCP ownership before reopen so regular ChatGPT never inherits
  // Tweakers MCP servers, and rollback restores the source projection before
  // its desktop is reopened.
  stamp("mcp-reconcile");
  deps.reconcileMcpMode(selection.appExperience);
  stamp("done");
}

function applyRuntimeArtifact(
  evidence: PreparedRuntimeArtifactEvidence | PreparedRuntimeRollbackArtifactEvidence,
  target: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
  direction: string,
): void {
  if ("existed" in evidence && !evidence.existed) {
    rmSync(target, { recursive: true, force: true });
    if (pathEntryExists(target)) throw new Error(`Applied ${direction} runtime should be absent`);
    return;
  }
  if (evidence.artifactDigest === null) {
    throw new Error(`Prepared ${direction} runtime digest is missing`);
  }
  deps.replaceDirectory(evidence.artifactPath, target);
  if (!pathEntryExists(target) || deps.directoryFingerprint(target) !== evidence.artifactDigest) {
    throw new Error(`Applied ${direction} runtime fingerprint does not match prepared evidence`);
  }
  if (evidence.runtimeFingerprint !== null) {
    const runtime = deps.readRuntimeFingerprintEvidence(target);
    if (!runtime
      || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
      || runtime.fileCount !== evidence.fileCount) {
      throw new Error(`Applied ${direction} runtime package does not match prepared evidence`);
    }
  }
}

function applyManagedRuntimeArtifact(
  evidence: PreparedManagedRuntimeArtifactEvidence | PreparedManagedRuntimeRollbackArtifactEvidence,
  target: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
  direction: string,
): void {
  if ("existed" in evidence && !evidence.existed) {
    rmSync(target, { recursive: true, force: true });
    if (pathEntryExists(target)) throw new Error(`Applied ${direction} managed runtime should be absent`);
    return;
  }
  if (evidence.artifactDigest === null) {
    throw new Error(`Prepared ${direction} managed runtime digest is missing`);
  }
  deps.replaceDirectory(evidence.artifactPath, target);
  if (!pathEntryExists(target) || deps.directoryFingerprint(target) !== evidence.artifactDigest) {
    throw new Error(`Applied ${direction} managed runtime fingerprint does not match prepared evidence`);
  }
  if (evidence.runtimeFingerprint !== null) {
    const runtime = deps.readRuntimeFingerprintEvidence(managedPackagedRuntimePath(target));
    if (!runtime
      || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
      || runtime.fileCount !== evidence.fileCount) {
      throw new Error(`Applied ${direction} managed runtime package does not match prepared evidence`);
    }
  }
  if (readManagedSourceRuntimeHash(target) !== evidence.sourceRuntimeHash) {
    throw new Error(`Applied ${direction} managed runtime provenance does not match prepared evidence`);
  }
}

function proveAppliedRuntimeArtifact(
  evidence: PreparedRuntimeArtifactEvidence | PreparedRuntimeRollbackArtifactEvidence | undefined,
  target: string | undefined,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
  managed: boolean,
): { ok: boolean; artifactDigest: string | null } {
  if (evidence === undefined || target === undefined) {
    return { ok: evidence === undefined && target === undefined, artifactDigest: null };
  }
  if ("existed" in evidence && !evidence.existed) {
    return { ok: !pathEntryExists(target), artifactDigest: null };
  }
  if (evidence.artifactDigest === null || !pathEntryExists(target)) {
    return { ok: false, artifactDigest: null };
  }
  const artifactDigest = deps.directoryFingerprint(target);
  if (artifactDigest !== evidence.artifactDigest) {
    return { ok: false, artifactDigest };
  }
  if (evidence.runtimeFingerprint !== null) {
    const runtime = deps.readRuntimeFingerprintEvidence(
      managed ? managedPackagedRuntimePath(target) : target,
    );
    if (!runtime
      || runtime.fingerprint.toLowerCase() !== evidence.runtimeFingerprint.toLowerCase()
      || runtime.fileCount !== evidence.fileCount) {
      return { ok: false, artifactDigest };
    }
  }
  if (managed
    && readManagedSourceRuntimeHash(target)
      !== (evidence as PreparedManagedRuntimeArtifactEvidence
        | PreparedManagedRuntimeRollbackArtifactEvidence).sourceRuntimeHash) {
    return { ok: false, artifactDigest };
  }
  return { ok: true, artifactDigest };
}

function stagePreparedEnvironment(
  input: { direction: "requested" | "rollback"; receipt: EnvironmentTransactionReceipt; prepared: PreparedEnvironmentEvidence },
  _options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  const requestedDirection = input.direction === "requested";
  const artifactPath = requestedDirection
    ? input.prepared.candidate.artifactPath
    : input.prepared.rollback.desktopArtifactPath;
  const expectedDigest = requestedDirection
    ? input.prepared.candidate.artifactDigest
    : input.prepared.rollback.desktopArtifactDigest;
  if (!existsSync(artifactPath) || deps.appFingerprint(artifactPath) !== expectedDigest) {
    throw new Error(`Prepared ${input.direction} desktop artifact is missing or changed`);
  }
  const backendArtifact = requestedDirection
    ? input.prepared.backend.artifactPath
    : input.prepared.rollback.backendArtifactPath;
  const backendDigest = requestedDirection
    ? input.prepared.backend.artifactDigest
    : input.prepared.rollback.backendArtifactDigest;
  if (!existsSync(backendArtifact) || deps.fileFingerprint(backendArtifact) !== backendDigest) {
    throw new Error(`Prepared ${input.direction} backend artifact is missing or changed`);
  }
}

function proveAppliedEnvironment(
  input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    expected: EnvironmentSelection;
    observation: EnvironmentDesktopObservation;
    prepared: PreparedEnvironmentEvidence;
  },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): EnvironmentAppliedEvidence | null {
  if (!input.observation.visibleWindow) return null;
  const expected = input.expected;
  const identity = deps.readDesktopIdentity(expected.selectedDesktopPath);
  const requestedDirection = input.direction === "requested";
  const desktopVersion = requestedDirection
    ? input.prepared.candidate.version
    : input.prepared.rollback.desktopVersion;
  const desktopBuild = requestedDirection
    ? input.prepared.candidate.build
    : input.prepared.rollback.desktopBuild;
  const desktopDigest = requestedDirection
    ? input.prepared.candidate.artifactDigest
    : input.prepared.rollback.desktopArtifactDigest;
  const asarHeaderHash = requestedDirection
    ? input.prepared.candidate.asarHeaderHash
    : input.prepared.rollback.desktopAsarHeaderHash;
  // Legacy prepared evidence (no asar integrity hash) can never prove an
  // applied environment; fail closed instead of matching on undefined.
  if (asarHeaderHash === undefined) return null;
  const backendPath = requestedDirection
    ? input.prepared.backend.binaryPath
    : input.prepared.rollback.backendBinaryPath;
  const backendVersion = requestedDirection
    ? input.prepared.backend.version
    : input.prepared.rollback.backendVersion;
  const backendDigest = requestedDirection
    ? input.prepared.backend.artifactDigest
    : input.prepared.rollback.backendArtifactDigest;
  const runtimeEvidence = requestedDirection
    ? input.prepared.runtime?.requested
    : input.prepared.runtime?.rollback;
  const managedRuntimeEvidence = requestedDirection
    ? input.prepared.managedRuntime?.requested
    : input.prepared.managedRuntime?.rollback;
  const state = deps.readAppState(options.stateFile);
  const stateAsarHash = expected.appExperience === "tweakers"
    ? state?.patchedAsarHash
    : state?.originalAsarHash;
  const configuredLane = deps.readBackendLane(options.configFile);
  const runtimeProof = expected.appExperience === "tweakers"
    ? deps.readRuntimeProof(options.runtimeProofFile ?? join(dirname(options.configFile), "environment-runtime-proof.json"))
    : null;
  // Identity and backend checks are cheap; the runtime tree proofs hash whole
  // directories. Disprove on the cheap evidence first so a mismatched desktop
  // costs a plist read instead of two full-tree walks per poll.
  if (identity.bundleId !== expected.selectedDesktopBundleId
    || identity.version !== desktopVersion
    || identity.build !== desktopBuild
    || observedAppExperience(expected.selectedDesktopPath, deps) !== expected.appExperience
    || state?.appExperience !== expected.appExperience
    || state.appRoot !== expected.selectedDesktopPath
    || state.bundleId !== expected.selectedDesktopBundleId
    || stateAsarHash !== asarHeaderHash
    || deps.readAsarHeaderHash(expected.selectedDesktopPath) !== asarHeaderHash
    || !backendLanesProve(configuredLane, expected.backendLane)
    || !existsSync(backendPath)
    || deps.readBackendVersion(backendPath) !== backendVersion
    || deps.fileFingerprint(backendPath) !== backendDigest) {
    return null;
  }
  const runtimeTreeProof = proveAppliedRuntimeArtifact(
    runtimeEvidence,
    input.prepared.runtime?.targetPath,
    deps,
    false,
  );
  const managedRuntimeTreeProof = proveAppliedRuntimeArtifact(
    managedRuntimeEvidence,
    input.prepared.managedRuntime?.targetPath,
    deps,
    true,
  );
  if (!runtimeTreeProof.ok
    || !managedRuntimeTreeProof.ok
    || (expected.appExperience === "tweakers" && !runtimeProofMatches(
      runtimeProof,
      input.observation.pid,
      expected,
      desktopVersion,
      desktopBuild,
      asarHeaderHash,
      backendPath,
      backendVersion,
      backendDigest,
      runtimeEvidence,
      input.prepared.runtime?.targetPath,
      managedRuntimeEvidence,
      input.prepared.managedRuntime?.targetPath,
      input.receipt.createdAt,
    ))
    || !deps.proveMcpMode(expected.appExperience)
    // Full artifact hashes are intentionally last. Missing/stale live proof is
    // polled cheaply instead of re-reading a multi-gigabyte app on every tick.
    || deps.appFingerprint(expected.selectedDesktopPath) !== desktopDigest
    || deps.fileFingerprint(backendPath) !== backendDigest) {
    return null;
  }
  const observedAt = deps.now();
  return {
    observedAt,
    selection: { ...expected, appliedAt: observedAt },
    desktopVersion,
    desktopBuild,
    backendVersion,
    desktopArtifactDigest: desktopDigest,
    asarHeaderHash,
    backendArtifactDigest: backendDigest,
    ...(runtimeTreeProof.artifactDigest
      ? { runtimeArtifactDigest: runtimeTreeProof.artifactDigest }
      : {}),
    ...(managedRuntimeTreeProof.artifactDigest
      ? { managedRuntimeArtifactDigest: managedRuntimeTreeProof.artifactDigest }
      : {}),
  };
}

function bindWatcherTarget(
  input: {
    direction: "requested" | "rollback";
    applied: EnvironmentAppliedEvidence;
    prepared: PreparedEnvironmentEvidence;
  },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  const expectedAsarHeaderHash = input.direction === "requested"
    ? input.prepared.candidate.asarHeaderHash
    : input.prepared.rollback.desktopAsarHeaderHash;
  if (expectedAsarHeaderHash === undefined) {
    throw new Error("Prepared evidence lacks asar integrity hashes; a legacy transaction cannot bind a watcher target");
  }
  if (input.applied.asarHeaderHash !== expectedAsarHeaderHash) {
    throw new Error("Proven target ASAR hash does not match prepared watcher evidence");
  }
  if (deps.readAsarHeaderHash(input.applied.selection.selectedDesktopPath) !== expectedAsarHeaderHash) {
    throw new Error("Target app.asar changed before watcher expectation could be bound");
  }
  const patchedAsarEvidence = input.applied.selection.appExperience === "tweakers"
    ? deps.readPatchedAsarEvidence(input.applied.selection.selectedDesktopPath)
    : null;
  const originalAsarHash = input.applied.selection.appExperience === "chatgpt"
    ? expectedAsarHeaderHash
    : null;
  deps.writeAppState(
    options.stateFile,
    input.applied.selection,
    input.applied.desktopVersion,
    patchedAsarEvidence,
    originalAsarHash,
  );
  const state = deps.readAppState(options.stateFile);
  const stateAsarHash = input.applied.selection.appExperience === "tweakers"
    ? state?.patchedAsarHash
    : state?.originalAsarHash;
  if (state === null
    || state.appExperience !== input.applied.selection.appExperience
    || state.appRoot !== input.applied.selection.selectedDesktopPath
    || state.bundleId !== input.applied.selection.selectedDesktopBundleId
    || stateAsarHash !== expectedAsarHeaderHash
    || deps.readAsarHeaderHash(input.applied.selection.selectedDesktopPath) !== expectedAsarHeaderHash) {
    throw new Error("Watcher target expectation did not persist exact proven app state");
  }
}

export function readEnvironmentRuntimeProof(file: string): EnvironmentRuntimeProof | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isEnvironmentRuntimeProof(value) ? value : null;
  } catch {
    return null;
  }
}

function isEnvironmentRuntimeProof(value: unknown): value is EnvironmentRuntimeProof {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 2
    && value.kind === "environment-runtime-proof"
    && positiveInteger(value.pid)
    && typeof value.appRoot === "string"
    && (value.bundleId === "com.openai.codex" || value.bundleId === "com.openai.codex.beta")
    && typeof value.desktopVersion === "string"
    && value.desktopVersion.length > 0
    && typeof value.desktopBuild === "string"
    && value.desktopBuild.length > 0
    && /^[a-f0-9]{64}$/i.test(typeof value.appAsarHeaderHash === "string" ? value.appAsarHeaderHash : "")
    && value.appExperience === "tweakers"
    && (value.releaseProfile === "stable" || value.releaseProfile === "alpha")
    && (value.backendLane === "bundled" || value.backendLane === "managed-alpha")
    && typeof value.binaryPath === "string"
    && typeof value.backendVersion === "string"
    && /^[a-f0-9]{64}$/i.test(typeof value.backendFingerprint === "string" ? value.backendFingerprint : "")
    && exactAbsolutePath(value.runtimePath)
    && /^[a-f0-9]{64}$/i.test(typeof value.runtimeFingerprint === "string" ? value.runtimeFingerprint : "")
    && nonNegativeInteger(value.runtimeFileCount)
    && exactAbsolutePath(value.managedRuntimePath)
    && /^[a-f0-9]{64}$/i.test(
      typeof value.managedRuntimeFingerprint === "string" ? value.managedRuntimeFingerprint : "",
    )
    && nonNegativeInteger(value.managedRuntimeFileCount)
    && (value.managedSourceRuntimeHash === null
      || /^[a-f0-9]{64}$/i.test(
        typeof value.managedSourceRuntimeHash === "string" ? value.managedSourceRuntimeHash : "",
      ))
    && validIso(value.observedAt);
}

function runtimeProofMatches(
  proof: EnvironmentRuntimeProof | null,
  pid: number,
  expected: EnvironmentSelection,
  desktopVersion: string,
  desktopBuild: string,
  appAsarHeaderHash: string,
  backendPath: string,
  backendVersion: string,
  backendFingerprint: string,
  runtimeEvidence: PreparedRuntimeArtifactEvidence | PreparedRuntimeRollbackArtifactEvidence | undefined,
  runtimeTarget: string | undefined,
  managedRuntimeEvidence: PreparedManagedRuntimeArtifactEvidence | PreparedManagedRuntimeRollbackArtifactEvidence | undefined,
  managedRuntimeTarget: string | undefined,
  transactionCreatedAt: string,
): boolean {
  return proof !== null
    && runtimeEvidence !== undefined
    && runtimeTarget !== undefined
    && managedRuntimeEvidence !== undefined
    && managedRuntimeTarget !== undefined
    && runtimeEvidence.runtimeFingerprint !== null
    && runtimeEvidence.fileCount !== null
    && managedRuntimeEvidence.runtimeFingerprint !== null
    && managedRuntimeEvidence.fileCount !== null
    && proof.pid === pid
    && proof.appRoot === expected.selectedDesktopPath
    && proof.bundleId === expected.selectedDesktopBundleId
    && proof.desktopVersion === desktopVersion
    && proof.desktopBuild === desktopBuild
    && proof.appAsarHeaderHash.toLowerCase() === appAsarHeaderHash.toLowerCase()
    && proof.releaseProfile === expected.releaseProfile
    && backendLanesProve(proof.backendLane, expected.backendLane)
    && proof.binaryPath === backendPath
    && proof.backendVersion === backendVersion
    && proof.backendFingerprint.toLowerCase() === backendFingerprint.toLowerCase()
    && proof.runtimePath === runtimeTarget
    && proof.runtimeFingerprint.toLowerCase() === runtimeEvidence.runtimeFingerprint.toLowerCase()
    && proof.runtimeFileCount === runtimeEvidence.fileCount
    && proof.managedRuntimePath === managedPackagedRuntimePath(managedRuntimeTarget)
    && proof.managedRuntimeFingerprint.toLowerCase() === managedRuntimeEvidence.runtimeFingerprint.toLowerCase()
    && proof.managedRuntimeFileCount === managedRuntimeEvidence.fileCount
    && proof.managedSourceRuntimeHash === managedRuntimeEvidence.sourceRuntimeHash
    && Date.parse(proof.observedAt) >= Date.parse(transactionCreatedAt);
}

function assertSelectionUsesProfile(
  selection: EnvironmentSelection,
  profile: EnvironmentProfileRecord,
): void {
  if (selection.selectedDesktopPath !== profile.officialPath
    || selection.selectedDesktopBundleId !== profile.officialBundleId
    || selection.releaseProfile !== profile.releaseProfile) {
    throw new Error(`Environment selection does not match the ${profile.releaseProfile} registry profile`);
  }
}

function requireArtifact(
  path: string,
  expectedFingerprint: string | null,
  fingerprint: (path: string) => string,
  label: string,
): void {
  if (!existsSync(path)) throw new Error(`${label} artifact is missing at ${path}`);
  if (expectedFingerprint === null) throw new Error(`${label} fingerprint is missing from the registry`);
  if (fingerprint(path) !== expectedFingerprint) {
    throw new Error(`${label} artifact fingerprint does not match the registry`);
  }
}

function stageBackend(
  source: string,
  destination: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  if (!existsSync(source)) throw new Error(`Backend artifact is missing at ${source}`);
  deps.copyBackend(source, destination);
}

function backendSourcePath(
  selection: EnvironmentSelection,
  managedPath: string,
  stagedDesktopPath: string,
): string {
  return selection.backendLane === "managed-alpha"
    ? managedPath
    : join(stagedDesktopPath, "Contents", "Resources", "codex");
}

function backendTargetPath(selection: EnvironmentSelection, managedPath: string): string {
  return selection.backendLane === "managed-alpha"
    ? managedPath
    : join(selection.selectedDesktopPath, "Contents", "Resources", "codex");
}

function readDesktopIdentity(appRoot: string): {
  bundleId: string | null;
  version: string | null;
  build: string | null;
} {
  try {
    const plist = readPlist(join(appRoot, "Contents", "Info.plist"));
    return {
      bundleId: typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : null,
      version: typeof plist.CFBundleShortVersionString === "string" ? plist.CFBundleShortVersionString : null,
      build: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : null,
    };
  } catch {
    return { bundleId: null, version: null, build: null };
  }
}

function observedAppExperience(
  appRoot: string,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): AppExperience | null {
  const marker = deps.readMarker(join(appRoot, "Contents", "Resources", "app.asar"));
  return marker === "present" ? "tweakers" : marker === "absent" ? "chatgpt" : null;
}

function assertObservedAppExperience(
  appRoot: string,
  expected: AppExperience,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  const observed = observedAppExperience(appRoot, deps);
  if (observed !== expected) {
    throw new Error(
      `Desktop at ${appRoot} does not prove ${expected} experience (observed ${observed ?? "unreadable"})`,
    );
  }
}

function defaultVerifyOfficialCandidate(selection: EnvironmentSelection): PreparedCandidateSignatureEvidence {
  const validated = validateOfficialEnvironmentProfile(selection);
  return {
    strict: validated.trust.strictSignature.ok,
    gatekeeper: validated.trust.gatekeeper.ok,
    designatedRequirement: validated.trust.designatedRequirement.requirement ?? "",
    teamIdentifier: validated.trust.signatureIdentity.teamIdentifier,
  };
}

function defaultVerifyPatchedCandidate(appRoot: string): PreparedCandidateSignatureEvidence {
  const strict = verifySignature(appRoot);
  if (!strict.ok) throw new Error(`Prepared patched candidate failed strict signature verification: ${strict.output}`);
  verifyStagedNativeHostForApp(appRoot);
  const identity = signatureInfo(appRoot);
  const requirementResult = spawnSync("codesign", ["-dr", "-", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const requirementOutput = `${requirementResult.stdout ?? ""}${requirementResult.stderr ?? ""}`.trim();
  const requirement = requirementOutput
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("designated =>"))
    ?.trim() ?? "";
  if (requirementResult.status !== 0 || requirement.length === 0) {
    throw new Error("Prepared patched candidate has no valid designated requirement");
  }
  const gatekeeperResult = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    strict: true,
    gatekeeper: gatekeeperResult.status === 0,
    designatedRequirement: requirement,
    teamIdentifier: identity.teamIdentifier,
  };
}

function defaultReadBackendVersion(binaryPath: string): string | null {
  if (!existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.split(/\s+/).at(-1) ?? null;
}

interface ManagedAlphaReceipt {
  schemaVersion: 1;
  version: string;
  releaseTag: string;
  digest: string;
  binaryDigest: string;
  architecture: "aarch64-apple-darwin";
  relativeDirectory: string;
  binaryRelativePath: string;
  verifiedAt: string;
}

/** Read and independently revalidate the runtime manager's committed pointer. */
export function inspectManagedAlphaBackend(environmentRoot: string = userPaths().root): ManagedAlphaBackendStatus {
  try {
    if (!exactAbsolutePath(environmentRoot)) throw new Error("Environment root must be an exact absolute path");
    const managedRoot = join(environmentRoot, "codex-cli");
    const state = JSON.parse(readFileSync(join(managedRoot, "state.json"), "utf8")) as { schemaVersion?: unknown; current?: unknown };
    if (state.schemaVersion !== 1 || !isManagedAlphaReceipt(state.current)) {
      throw new Error("Managed Alpha state has no valid current receipt");
    }
    const receipt = state.current;
    const releasesRoot = join(managedRoot, "releases");
    const releaseDirectory = checkedManagedChild(releasesRoot, receipt.relativeDirectory, true);
    const diskReceipt = JSON.parse(readFileSync(join(releaseDirectory, "receipt.json"), "utf8")) as unknown;
    if (!isManagedAlphaReceipt(diskReceipt) || !managedAlphaReceiptsMatch(receipt, diskReceipt)) {
      throw new Error("Managed Alpha disk receipt does not match state");
    }
    const binary = checkedManagedChild(releaseDirectory, receipt.binaryRelativePath, false);
    const strict = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    if (strict.status !== 0) throw new Error("Managed Alpha binary failed strict signature verification");
    const requirement = spawnSync("/usr/bin/codesign", [
      "-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"",
      "--verify",
      binary,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    if (requirement.status !== 0) throw new Error("Managed Alpha binary is not signed by the OpenAI team");
    const architecture = spawnSync("/usr/bin/file", ["-b", binary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    if (architecture.status !== 0 || !/arm64|aarch64/i.test(architecture.stdout ?? "")) {
      throw new Error("Managed Alpha binary architecture is not arm64");
    }
    const version = defaultReadBackendVersion(binary);
    if (version !== receipt.version) throw new Error("Managed Alpha binary version does not match its receipt");
    const binaryDigest = sha256File(binary);
    if (binaryDigest !== receipt.binaryDigest.toLowerCase()) {
      throw new Error("Managed Alpha binary digest does not match its receipt");
    }
    return { installed: true, binaryPath: binary, version, fingerprint: binaryDigest, error: null };
  } catch (error) {
    return { installed: false, binaryPath: null, version: null, fingerprint: null, error: errorMessage(error) };
  }
}

function isManagedAlphaReceipt(value: unknown): value is ManagedAlphaReceipt {
  if (!isRecord(value)) return false;
  const relativeDirectory = value.relativeDirectory;
  const binaryRelativePath = value.binaryRelativePath;
  return value.schemaVersion === 1
    && typeof value.version === "string"
    && /^\d+\.\d+\.\d+-alpha\.\d+$/.test(value.version)
    && value.releaseTag === `rust-v${value.version}`
    && typeof value.digest === "string"
    && /^[a-fA-F0-9]{64}$/.test(value.digest)
    && typeof value.binaryDigest === "string"
    && /^[a-fA-F0-9]{64}$/.test(value.binaryDigest)
    && value.architecture === "aarch64-apple-darwin"
    && typeof relativeDirectory === "string"
    && /^[A-Za-z0-9._-]+$/.test(relativeDirectory)
    && typeof binaryRelativePath === "string"
    && safeManagedRelativePath(binaryRelativePath)
    && validIso(value.verifiedAt);
}

function safeManagedRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function checkedManagedChild(root: string, relativePath: string, directory: boolean): string {
  if (!safeManagedRelativePath(relativePath)) throw new Error("Managed Alpha receipt contains an unsafe path");
  let cursor = root;
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Managed Alpha release root is unsafe");
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]!);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error("Managed Alpha path contains a symbolic link");
    const final = index === segments.length - 1;
    if (!final && !info.isDirectory()) throw new Error("Managed Alpha path has a non-directory parent");
    if (final && directory && !info.isDirectory()) throw new Error("Managed Alpha release is not a directory");
    if (final && !directory && (!info.isFile() || (info.mode & 0o111) === 0)) {
      throw new Error("Managed Alpha backend is not a regular executable file");
    }
  }
  return cursor;
}

function managedAlphaReceiptsMatch(first: ManagedAlphaReceipt, second: ManagedAlphaReceipt): boolean {
  return first.version === second.version
    && first.releaseTag === second.releaseTag
    && first.digest.toLowerCase() === second.digest.toLowerCase()
    && first.binaryDigest.toLowerCase() === second.binaryDigest.toLowerCase()
    && first.architecture === second.architecture
    && first.relativeDirectory === second.relativeDirectory
    && first.binaryRelativePath === second.binaryRelativePath
    && first.verifiedAt === second.verifiedAt;
}

function defaultReadBackendLane(configFile: string): BackendLane | null {
  const config = readConfigFile(configFile);
  const section = config.tweaker;
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const lane = (section as Record<string, unknown>).codexCliLane;
  if (lane === "bundled" || lane === "official-bundled") return "bundled";
  if (lane === "beta" || lane === "managed-alpha") return "managed-alpha";
  return null;
}

function defaultWriteBackendLane(
  configFile: string,
  lane: BackendLane,
  selected?: { binaryPath: string; version: string; fingerprint: string },
): void {
  const config = readConfigFile(configFile);
  const section = config.tweaker && typeof config.tweaker === "object" && !Array.isArray(config.tweaker)
    ? config.tweaker as Record<string, unknown>
    : {};
  section.codexCliLane = lane === "managed-alpha" ? "beta" : "bundled";
  if (lane === "managed-alpha") {
    if (!selected || !exactAbsolutePath(selected.binaryPath)
      || !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(selected.version)
      || !/^[a-f0-9]{64}$/i.test(selected.fingerprint)) {
      throw new Error("Managed Alpha selection evidence is invalid");
    }
    section.codexCliPath = selected.binaryPath;
    section.codexCliVersion = selected.version;
    section.codexCliFingerprint = selected.fingerprint.toLowerCase();
  } else {
    delete section.codexCliPath;
    delete section.codexCliVersion;
    delete section.codexCliFingerprint;
  }
  config.tweaker = section;
  writeJsonObjectAtomically(configFile, config);
}

function backendLanesProve(observed: BackendLane | null, expected: BackendLane): boolean {
  if (expected === "official-bundled" || expected === "bundled") return observed === "bundled";
  return observed === "managed-alpha";
}

function copyBackendAtomically(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeJsonObjectAtomically(file: string, value: object): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

export function createEnvironmentCoordinator(
  options: EnvironmentCoordinatorOptions = {},
  deps: EnvironmentCoordinatorDeps = {},
): EnvironmentCoordinator {
  return new InstallerEnvironmentCoordinator(options, deps);
}

function resolveCoordinatorEnvironmentRoot(
  options: EnvironmentCoordinatorOptions,
  defaultRoot: string,
): string {
  const candidate = options.environmentRoot
    ?? (options.stateFile ? dirname(options.stateFile) : undefined)
    ?? (options.configFile ? dirname(options.configFile) : undefined)
    ?? (options.selectionFile ? dirname(options.selectionFile) : undefined)
    ?? (options.registryFile ? dirname(options.registryFile) : undefined)
    ?? defaultRoot;
  if (!isAbsolute(candidate) || normalize(candidate) !== candidate) {
    throw new Error(`Coordinator environment root must be an exact absolute path: ${candidate}`);
  }
  return candidate;
}

function assertCoordinatorOwnedPath(root: string, path: string, label: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || !pathWithinOrEqual(root, path)) {
    throw new Error(`Coordinator ${label} must be contained by ${root}: ${path}`);
  }
}

export class InstallerEnvironmentCoordinator implements EnvironmentCoordinator {
  readonly environmentRoot: string;
  readonly transactionFile: string;
  readonly receiptRoot: string;
  readonly selectionFile: string;
  readonly registryFile: string;
  readonly configFile: string;
  readonly stateFile: string;
  readonly runtimeProofFile: string;
  readonly mcpStateFile: string;
  readonly tweaksRoot: string;
  readonly mcpConfigFile: string;
  readonly lockFile: string;
  readonly lifecycleLockFile: string;
  readonly watcherPromotionFile: string;
  readonly verificationPolls: number;
  readonly verificationIntervalMs: number;

  private readonly deps: Required<EnvironmentCoordinatorDeps>;

  constructor(options: EnvironmentCoordinatorOptions = {}, deps: EnvironmentCoordinatorDeps = {}) {
    const paths = userPaths();
    this.environmentRoot = resolveCoordinatorEnvironmentRoot(options, paths.root);
    this.transactionFile = options.transactionFile
      ?? join(this.environmentRoot, "transactions", "environment.json");
    this.receiptRoot = options.receiptRoot
      ?? join(this.environmentRoot, "transactions", "environment");
    this.selectionFile = options.selectionFile
      ?? join(this.environmentRoot, "environment-selection.json");
    this.registryFile = options.registryFile
      ?? join(this.environmentRoot, "environment-registry.json");
    this.configFile = options.configFile ?? join(this.environmentRoot, "config.json");
    this.stateFile = options.stateFile ?? join(this.environmentRoot, "state.json");
    this.runtimeProofFile = options.runtimeProofFile
      ?? join(this.environmentRoot, "environment-runtime-proof.json");
    this.mcpStateFile = options.mcpStateFile ?? join(this.environmentRoot, "mcp-sync-state.json");
    this.tweaksRoot = options.tweaksRoot ?? join(this.environmentRoot, "tweaks");
    this.mcpConfigFile = options.mcpConfigFile ?? defaultCodexMcpConfigFile();
    this.lockFile = options.lockFile
      ?? join(this.environmentRoot, "transactions", "environment.lock");
    this.lifecycleLockFile = options.lifecycleLockFile
      ?? join(this.environmentRoot, "transactions", "lifecycle.lock");
    this.watcherPromotionFile = options.watcherPromotionFile
      ?? join(this.environmentRoot, "transactions", "environment-watcher.json");
    for (const [label, path] of [
      ["transaction file", this.transactionFile],
      ["receipt root", this.receiptRoot],
      ["selection file", this.selectionFile],
      ["registry file", this.registryFile],
      ["Tweakers config file", this.configFile],
      ["installer state file", this.stateFile],
      ["runtime proof file", this.runtimeProofFile],
      ["MCP state file", this.mcpStateFile],
      ["tweaks root", this.tweaksRoot],
      ["environment lock file", this.lockFile],
      ["lifecycle lock file", this.lifecycleLockFile],
      ["watcher promotion file", this.watcherPromotionFile],
    ] as const) {
      assertCoordinatorOwnedPath(this.environmentRoot, path, label);
    }
    if (!isAbsolute(this.mcpConfigFile) || normalize(this.mcpConfigFile) !== this.mcpConfigFile) {
      throw new Error(`Coordinator MCP config file must be an exact absolute path: ${this.mcpConfigFile}`);
    }
    // Cold Electron + Gatekeeper launches regularly exceed five seconds.
    // Production gets a one-minute readiness window; tests remain fully
    // deterministic through the configurable poll count/interval.
    this.verificationPolls = Math.max(1, options.verificationPolls ?? 240);
    this.verificationIntervalMs = Math.max(0, options.verificationIntervalMs ?? 250);
    const defaultAdapters = createDefaultEnvironmentAdapters({
      registryFile: this.registryFile,
      receiptRoot: this.receiptRoot,
      configFile: this.configFile,
      stateFile: this.stateFile,
      selectionFile: this.selectionFile,
      environmentRoot: this.environmentRoot,
      runtimeProofFile: this.runtimeProofFile,
      mcpConfigFile: this.mcpConfigFile,
      mcpStateFile: this.mcpStateFile,
      tweaksRoot: this.tweaksRoot,
      ...(options.bundledDerivedReceiptFile
        ? { bundledDerivedReceiptFile: options.bundledDerivedReceiptFile }
        : {}),
    });
    const defaultAdoptionIsScoped = this.environmentRoot === paths.root
      || options.mcpConfigFile !== undefined;
    const assertDefaultAdoptionScope = (): void => {
      if (!defaultAdoptionIsScoped) {
        throw new Error(
          "A custom environment coordinator must provide mcpConfigFile or inject official adoption dependencies",
        );
      }
    };
    this.deps = {
      now: deps.now ?? (() => new Date().toISOString()),
      createId: deps.createId ?? randomUUID,
      preparePrerequisites: deps.preparePrerequisites ?? defaultAdapters.preparePrerequisites,
      validatePreparedEnvironment: deps.validatePreparedEnvironment
        ?? (deps.preparePrerequisites ? (() => {}) : defaultAdapters.validatePreparedEnvironment),
      stagePreparedEnvironment: deps.stagePreparedEnvironment
        ?? (deps.preparePrerequisites ? (() => {}) : defaultAdapters.stagePreparedEnvironment),
      applyPreparedEnvironment: deps.applyPreparedEnvironment ?? defaultAdapters.applyPreparedEnvironment,
      // Injected preparation seams own their own evidence shape, so migration
      // stays inert for them exactly like validation does.
      migrateSwapHost: deps.migrateSwapHost
        ?? (deps.preparePrerequisites ? (() => null) : defaultAdapters.migrateSwapHost),
      observeDesktop: deps.observeDesktop ?? observeCodexMainProcess,
      quitDesktop: deps.quitDesktop ?? quitCodexMainProcess,
      processAlive: deps.processAlive ?? processAlive,
      cleanupHelpers: deps.cleanupHelpers ?? ((path, stoppedMainPid) => {
        terminateStaleHelperProcesses(path, { excludePids: [stoppedMainPid] });
      }),
      reopenDesktop: deps.reopenDesktop ?? ((path) => { openAndActivateCodex(path); }),
      pauseWatcher: deps.pauseWatcher ?? (this.transactionFile === paths.environmentTransactionFile
        ? ((input) => { beginWatcherPromotion(this.watcherPromotionFile, input); })
        : (() => undefined)),
      resumeWatcher: deps.resumeWatcher ?? (deps.refreshWatcher
        ? ((input) => deps.refreshWatcher!(input.targetAppRoot))
        : this.transactionFile === paths.environmentTransactionFile
          ? ((input) => { finishWatcherPromotion(this.watcherPromotionFile, input); })
          : (() => undefined)),
      refreshWatcher: deps.refreshWatcher ?? (() => undefined),
      proveAppliedEnvironment: deps.proveAppliedEnvironment ?? defaultAdapters.proveAppliedEnvironment,
      bindWatcherTarget: deps.bindWatcherTarget ?? (deps.proveAppliedEnvironment
        ? (() => undefined)
        : defaultAdapters.bindWatcherTarget),
      publishSelection: deps.publishSelection ?? ((selection) => {
        if (existsSync(this.registryFile)) {
          publishEnvironmentSelection(this.registryFile, this.selectionFile, selection);
        } else {
          // Explicitly injected coordinator tests may not own a registry. The
          // production adapter refuses preparation without one.
          writeEnvironmentSelection(this.selectionFile, selection);
        }
      }),
      proveOfficialDesktop: deps.proveOfficialDesktop ?? ((input) => {
        assertDefaultAdoptionScope();
        return proveVerifiedOfficialDesktop(input, {
          root: this.environmentRoot,
          installerStateFile: this.stateFile,
          environmentRegistryFile: this.registryFile,
          environmentSelectionFile: this.selectionFile,
          runtimeProofFile: this.runtimeProofFile,
          mcpConfigFile: this.mcpConfigFile,
          mcpStateFile: this.mcpStateFile,
          tweaksRoot: this.tweaksRoot,
          tweakersConfigFile: this.configFile,
          now: this.deps.now(),
        });
      }),
      commitOfficialDesktop: deps.commitOfficialDesktop ?? ((input) => {
        assertDefaultAdoptionScope();
        return commitVerifiedOfficialDesktop(input, input.proof, {
          root: this.environmentRoot,
          installerStateFile: this.stateFile,
          environmentRegistryFile: this.registryFile,
          environmentSelectionFile: this.selectionFile,
          runtimeProofFile: this.runtimeProofFile,
          mcpConfigFile: this.mcpConfigFile,
          mcpStateFile: this.mcpStateFile,
          tweaksRoot: this.tweaksRoot,
          tweakersConfigFile: this.configFile,
          now: this.deps.now(),
        });
      }),
      sleep: deps.sleep ?? sleep,
    };
  }

  async prepare(input: PrepareEnvironmentInput): Promise<EnvironmentTransactionReceipt> {
    return this.withMutationLock(() => this.prepareUnlocked(input));
  }

  private async prepareUnlocked(input: PrepareEnvironmentInput): Promise<EnvironmentTransactionReceipt> {
    const existing = this.status();
    if (existing !== null && !isTerminalEnvironmentPhase(existing.phase)) {
      throw new Error(
        `Environment transaction ${existing.transactionId} is still ${existing.phase} (owner PID ${existing.ownerPid})`,
      );
    }

    const requested = { ...input.requested, appliedAt: null };
    const oldProcess = await this.deps.observeDesktop(input.current.selectedDesktopPath);
    if (oldProcess !== null && (!Number.isInteger(oldProcess.pid) || oldProcess.pid <= 0)) {
      throw new Error(`Cannot prepare environment transaction: invalid main PID at ${input.current.selectedDesktopPath}`);
    }

    const now = this.deps.now();
    const transactionId = this.deps.createId();
    let receipt: EnvironmentTransactionReceipt = {
      schemaVersion: ENVIRONMENT_TRANSACTION_SCHEMA_VERSION,
      kind: "environment",
      transactionId,
      phase: "preparing",
      error: null,
      ownerPid: process.pid,
      source: input.current,
      requested,
      prepared: null,
      applied: null,
      oldMainPid: oldProcess?.pid ?? null,
      newMainPid: null,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      committedAt: null,
      rolledBackAt: null,
      cancelledAt: null,
    };
    this.persist(receipt);
    try {
      const prepared = await this.deps.preparePrerequisites({
        transactionId,
        current: input.current,
        requested,
        oldMainPid: oldProcess?.pid ?? null,
      });
      if (!preparedEvidenceMatches(prepared, input.current, requested)) {
        throw new Error("Environment prerequisite evidence does not match the requested transition");
      }
      await this.deps.validatePreparedEnvironment({
        receipt: {
          ...receipt,
          phase: "prepared",
          prepared,
          updatedAt: this.deps.now(),
        },
        prepared,
      });
      receipt = this.update(receipt, { phase: "prepared", prepared });
      return receipt;
    } catch (error) {
      receipt = this.update(receipt, { phase: "failed", error: errorMessage(error) }, true);
      throw new Error(`Could not prepare environment transaction: ${receipt.error}`);
    }
  }

  async commit(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        return await this.withMutationLock(
          () => this.commitUnlocked(transactionId),
          { continueTransaction: true, transactionId },
        );
      } catch (error) {
        if (attempt === 24 || !/Another Tweakers lifecycle operation is active/.test(errorMessage(error))) {
          throw error;
        }
        await this.deps.sleep(100);
      }
    }
    throw new Error("Environment commit could not acquire the lifecycle lease");
  }

  private async commitUnlocked(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    let receipt = this.requireReceipt(transactionId);
    if (receipt.phase !== "prepared") {
      throw new Error(`Environment transaction ${receipt.transactionId} cannot commit from phase ${receipt.phase}`);
    }
    if (receipt.prepared === null) {
      throw new Error(`Environment transaction ${receipt.transactionId} has no prepared evidence`);
    }
    const prepared = receipt.prepared;

    try {
      await this.deps.validatePreparedEnvironment({ receipt, prepared });
    } catch (error) {
      throw new Error(
        `Environment transaction ${receipt.transactionId} cannot commit before cutover: ${errorMessage(error)}`,
      );
    }
    receipt = this.update(receipt, { phase: "committing", error: null, ownerPid: process.pid });
    let sourceObservedAfterStopFailure = false;
    let watcherPaused = false;
    const reopenFailures: string[] = [];
    try {
      await this.deps.pauseWatcher({
        transactionId: receipt.transactionId,
        sourceAppRoot: receipt.source.selectedDesktopPath,
        requestedAppRoot: receipt.requested.selectedDesktopPath,
        sourceExpectedFingerprint: prepared.rollback.desktopArtifactDigest,
      });
      watcherPaused = true;
      await this.deps.stagePreparedEnvironment({
        direction: "requested",
        receipt,
        prepared,
      });
      if (receipt.oldMainPid === null) {
        // The app was closed at preparation. Re-observe immediately before
        // cutover: if it appeared, bind only a process that proves the exact
        // immutable source evidence, then stop it through the normal path.
        const appeared = await this.proveReplacementSourcePid(receipt, prepared);
        if (appeared.pid !== null) {
          receipt = this.update(receipt, { oldMainPid: appeared.pid, error: null });
          await this.stopAndClean(receipt.source.selectedDesktopPath, appeared.pid);
        } else if (appeared.sourceObserved) {
          sourceObservedAfterStopFailure = true;
          throw new Error(
            `Refusing cutover: a source process appeared at ${receipt.source.selectedDesktopPath} but did not match prepared rollback evidence`,
          );
        }
      } else {
        try {
          await this.stopAndClean(receipt.source.selectedDesktopPath, receipt.oldMainPid);
        } catch (stopError) {
          // Preparation can take long enough for Electron to replace its main
          // process. Rebind only when the replacement process proves the exact
          // immutable source artifacts captured for rollback; a path match or a
          // newer PID alone is never sufficient authority to quit it.
          const replacement = await this.proveReplacementSourcePid(receipt, prepared);
          if (replacement.pid === null) {
            sourceObservedAfterStopFailure = replacement.sourceObserved;
            throw stopError;
          }
          receipt = this.update(receipt, { oldMainPid: replacement.pid, error: null });
          await this.stopAndClean(receipt.source.selectedDesktopPath, replacement.pid);
        }
      }
      receipt = this.update(receipt, { phase: "applying", applyProgress: null });
      await this.deps.applyPreparedEnvironment({
        direction: "requested",
        receipt,
        prepared,
        // Reassigns the enclosing `receipt` so every later this.update —
        // including the terminal write — carries the last durable stamp.
        onProgress: (step) => {
          receipt = this.update(receipt, { applyProgress: `requested:${step}` });
        },
      });

      let lastVerification: EnvironmentVerification | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        receipt = this.update(receipt, { phase: "reopening", attempt, newMainPid: null });
        let reopenError: string | null = null;
        try {
          await this.deps.reopenDesktop(receipt.requested.selectedDesktopPath);
        } catch (error) {
          reopenError = errorMessage(error);
          reopenFailures.push(`attempt ${attempt}: ${reopenError}`);
        }
        receipt = this.update(receipt, { phase: "verifying", error: reopenError });
        lastVerification = await this.verify(receipt.transactionId);
        if (lastVerification.ok
          && lastVerification.appliedSelection !== null
          && lastVerification.appliedEvidence !== null
          && lastVerification.observedPid !== null) {
          await this.deps.bindWatcherTarget({
            direction: "requested",
            applied: lastVerification.appliedEvidence,
            prepared,
          });
          await this.deps.publishSelection(lastVerification.appliedSelection);
          await this.deps.resumeWatcher({
            transactionId: receipt.transactionId,
            targetAppRoot: receipt.requested.selectedDesktopPath,
            targetExpectedFingerprint: lastVerification.appliedEvidence.desktopArtifactDigest,
          });
          watcherPaused = false;
          receipt = this.update(receipt, {
            phase: "committed",
            requested: lastVerification.appliedSelection,
            applied: lastVerification.appliedEvidence,
            newMainPid: lastVerification.observedPid,
            committedAt: this.deps.now(),
            error: null,
          }, true);
          return receipt;
        }

        if (attempt === 1 && lastVerification.observedPid !== null) {
          await this.stopAndClean(receipt.requested.selectedDesktopPath, lastVerification.observedPid);
        } else if (attempt === 1
          && receipt.oldMainPid !== null
          && !this.deps.processAlive(receipt.oldMainPid)) {
          await this.deps.cleanupHelpers(receipt.requested.selectedDesktopPath, receipt.oldMainPid);
        }
      }

      const reason = [
        lastVerification?.error ?? "requested environment did not become ready",
        reopenFailureSummary(reopenFailures),
      ].filter((value): value is string => value !== null).join("; ");
      receipt = this.update(receipt, { error: reason });
      return this.rollbackInternal(receipt, `Commit failed after one retry: ${reason}`);
    } catch (error) {
      const reason = [
        errorMessage(error),
        reopenFailureSummary(reopenFailures),
      ].filter((value): value is string => value !== null).join("; ");
      receipt = this.update(receipt, { error: reason });
      if (receipt.attempt === 0 && receipt.phase === "committing") {
        // applyPreparedEnvironment has not started, so the live bundle is
        // still the source artifact. A PID can legitimately change while the
        // candidate is being prepared (for example, an app self-restart).
        // Never "roll back" bytes that were not cut over: doing so can stop
        // the replacement process and overwrite an already-correct app.
        try {
          const current = sourceObservedAfterStopFailure && receipt.oldMainPid !== null
            ? { pid: receipt.oldMainPid, visibleWindow: true }
            : await this.deps.observeDesktop(receipt.source.selectedDesktopPath);
          if (current === null) {
            await this.deps.reopenDesktop(receipt.source.selectedDesktopPath);
          }
          if (watcherPaused) {
            await this.deps.resumeWatcher({
              transactionId: receipt.transactionId,
              targetAppRoot: receipt.source.selectedDesktopPath,
              targetExpectedFingerprint: prepared.rollback.desktopArtifactDigest,
            });
            watcherPaused = false;
          }
          return this.update(receipt, {
            phase: "cancelled",
            cancelledAt: this.deps.now(),
            error: reason,
          }, true);
        } catch (recoveryError) {
          return this.update(receipt, {
            phase: "failed",
            error: `${reason}; source recovery failed: ${errorMessage(recoveryError)}`,
          }, true);
        }
      }
      return this.rollbackInternal(receipt, `Commit failed: ${reason}`);
    }
  }

  status(): EnvironmentTransactionReceipt | null {
    return readEnvironmentTransactionReceipt(this.transactionFile);
  }

  async verify(transactionId?: string): Promise<EnvironmentVerification> {
    const receipt = this.requireReceipt(transactionId);
    if (receipt.prepared === null) {
      throw new Error(`Environment transaction ${receipt.transactionId} has no prepared evidence`);
    }
    const prepared = receipt.prepared;
    let latest: EnvironmentVerification = {
      ok: false,
      observedPid: null,
      visibleWindow: false,
      appliedSelection: null,
      appliedEvidence: null,
      error: "requested desktop was not observed",
    };
    for (let poll = 0; poll < this.verificationPolls; poll++) {
      const observed = await this.deps.observeDesktop(receipt.requested.selectedDesktopPath);
      if (observed === null) {
        latest = { ...latest, error: "requested desktop main process was not observed" };
      } else if (receipt.oldMainPid !== null && observed.pid === receipt.oldMainPid) {
        latest = {
          ok: false,
          observedPid: observed.pid,
          visibleWindow: observed.visibleWindow,
          appliedSelection: null,
          appliedEvidence: null,
          error: `requested desktop reused old main PID ${receipt.oldMainPid}`,
        };
      } else if (!observed.visibleWindow) {
        latest = {
          ok: false,
          observedPid: observed.pid,
          visibleWindow: false,
          appliedSelection: null,
          appliedEvidence: null,
          error: `requested desktop PID ${observed.pid} has no visible window`,
        };
      } else {
        const applied = await this.deps.proveAppliedEnvironment({
          direction: "requested",
          receipt,
          expected: receipt.requested,
          observation: observed,
          prepared,
        });
        if (applied !== null && appliedEvidenceProvesRequest(
          applied,
          receipt.requested,
          prepared,
          "requested",
        )) {
          return {
            ok: true,
            observedPid: observed.pid,
            visibleWindow: true,
            appliedSelection: applied.selection,
            appliedEvidence: applied,
            error: null,
          };
        }
        latest = {
          ok: false,
          observedPid: observed.pid,
          visibleWindow: true,
          appliedSelection: applied?.selection ?? null,
          appliedEvidence: applied,
          error: "requested environment state has not been applied",
        };
      }
      if (poll + 1 < this.verificationPolls) await this.deps.sleep(this.verificationIntervalMs);
    }
    return latest;
  }

  async rollback(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    return this.withMutationLock(
      () => this.rollbackUnlocked(transactionId),
      { continueTransaction: true, transactionId },
    );
  }

  private async rollbackUnlocked(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    let receipt = this.requireReceipt(transactionId);
    if (receipt.phase === "rolled-back") return receipt;
    if (receipt.phase === "preparing" || receipt.phase === "prepared") {
      throw new Error(`Environment transaction ${receipt.transactionId} has not cut over; cancel it instead`);
    }
    if (receipt.phase === "cancelled") {
      throw new Error(`Environment transaction ${receipt.transactionId} is already cancelled`);
    }
    // Bring legacy evidence forward while the live app is still running, so a
    // receipt that predates receipt-owned swap evidence can still recover.
    receipt = await this.ensureSwapHostEvidence(receipt);
    // For in-flight phases the original owner may still be mid-apply, and a
    // live-state proof could race the swap; only a dead (or same-process)
    // owner makes the proof trustworthy. A failed receipt has no active
    // applier, so it needs no liveness check.
    if (environmentReceiptMayBePreCutover(receipt)
      && (receipt.phase === "failed"
        || receipt.ownerPid === process.pid
        || !this.deps.processAlive(receipt.ownerPid))) {
      const recovered = await this.tryRecoverProvenPreCutoverFailure(receipt);
      if (recovered !== null) return recovered;
    }
    const failedOldMainPid = receipt.oldMainPid;
    if (receipt.phase === "failed" && failedOldMainPid !== null) {
      const source = await this.deps.observeDesktop(receipt.source.selectedDesktopPath);
      if (source?.pid === failedOldMainPid) {
        throw new Error(
          `Environment transaction ${receipt.transactionId} failed before cutover; the exact source app is still running and no rollback is required`,
        );
      }
    }
    return this.rollbackInternal({ ...receipt, ownerPid: process.pid }, "Rollback requested");
  }

  /**
   * Idempotent and safe to retry after a crash: staging rewrites one stable
   * receipt-owned path, and the receipt is only republished once the evidence
   * exists. The original failure text is preserved so migrating never erases
   * the forensic record of why the transaction stopped.
   */
  private async ensureSwapHostEvidence(
    receipt: EnvironmentTransactionReceipt,
  ): Promise<EnvironmentTransactionReceipt> {
    const prepared = receipt.prepared;
    if (prepared === null || prepared.swapHost !== undefined) return receipt;
    const swapHost = await this.deps.migrateSwapHost({ receipt, prepared });
    if (swapHost === null) return receipt;
    return this.update(receipt, { prepared: { ...prepared, swapHost } });
  }

  /**
   * A replacement adapter can fail before its first swap even though the
   * coordinator has entered `applying`. Prove the exact prepared source bytes
   * before deciding that no rollback is required; otherwise return null and
   * leave artifact restoration to the normal rollback path.
   */
  private async tryRecoverProvenPreCutoverFailure(
    receipt: EnvironmentTransactionReceipt,
  ): Promise<EnvironmentTransactionReceipt | null> {
    if (receipt.prepared === null) return null;
    const observed = await this.observeOrReopenSource(receipt.source.selectedDesktopPath);
    if (observed === null) return null;
    let applied: EnvironmentAppliedEvidence | null;
    try {
      applied = await this.deps.proveAppliedEnvironment({
        direction: "rollback",
        receipt,
        expected: receipt.prepared.rollback.selection,
        observation: observed,
        prepared: receipt.prepared,
      });
    } catch (proofError) {
      // A throwing proof is not the same as a disproved one. Record why the
      // safe path was abandoned before falling through to byte restoration.
      this.update(receipt, {
        error: `${receipt.error ?? "unknown pre-cutover failure"}; safe recovery could not be proven: `
          + errorMessage(proofError),
      });
      return null;
    }
    if (applied === null || !appliedEvidenceProvesRequest(
      applied,
      receipt.prepared.rollback.selection,
      receipt.prepared,
      "rollback",
    )) {
      return null;
    }
    await this.deps.bindWatcherTarget({ direction: "rollback", applied, prepared: receipt.prepared });
    await this.deps.publishSelection(applied.selection);
    await this.deps.resumeWatcher({
      transactionId: receipt.transactionId,
      targetAppRoot: receipt.source.selectedDesktopPath,
      targetExpectedFingerprint: applied.desktopArtifactDigest,
    });
    return this.update(receipt, {
      phase: "cancelled",
      ownerPid: process.pid,
      applied,
      newMainPid: observed.pid,
      cancelledAt: this.deps.now(),
      error: `Recovered safely without replacing the app. Previous failure: ${
        receipt.error ?? `owner exited during ${receipt.phase} before cutover`}`,
    }, true);
  }

  /**
   * A closed app proves nothing either way, and a failed rollback attempt can
   * be what closed it. Reopen once and re-observe so safe recovery is decided
   * on evidence rather than on whether the user happened to relaunch.
   */
  private async observeOrReopenSource(path: string): Promise<EnvironmentDesktopObservation | null> {
    const observed = await this.deps.observeDesktop(path);
    if (observed !== null) return observed;
    try {
      await this.deps.reopenDesktop(path);
    } catch {
      return null;
    }
    for (let poll = 0; poll < this.verificationPolls; poll++) {
      const reopened = await this.deps.observeDesktop(path);
      if (reopened !== null && reopened.visibleWindow) return reopened;
      if (poll + 1 < this.verificationPolls) await this.deps.sleep(this.verificationIntervalMs);
    }
    return null;
  }

  async recover(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    return this.withMutationLock(
      () => this.recoverUnlocked(transactionId),
      // `recovery` lets this cross the desktop-update gate when the blocked
      // desktop receipt recorded exactly this environment transaction — the
      // deadlock-breaking direction. Only recover() may claim it.
      { continueTransaction: true, transactionId, recovery: true },
    );
  }

  /**
   * Ordered by how much the machine can prove, strongest first. Nothing here
   * replaces bytes: a receipt whose recorded payload is stale — because the
   * official desktop updated after the transaction failed — can only be
   * resolved honestly by adopting what is actually installed.
   */
  private async recoverUnlocked(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    const receipt = await this.ensureSwapHostEvidence(this.requireReceipt(transactionId));
    if (isTerminalEnvironmentPhase(receipt.phase) && receipt.phase !== "failed") return receipt;
    const prepared = receipt.prepared;
    if (prepared === null) {
      throw new Error(`Environment transaction ${receipt.transactionId} has no prepared evidence to recover from`);
    }

    const proven = await this.proveEitherDirection(receipt, prepared);
    if (proven !== null) {
      await this.deps.publishSelection(proven.applied.selection);
      const requested = proven.direction === "requested";
      return this.update(receipt, {
        phase: requested ? "committed" : "rolled-back",
        ownerPid: process.pid,
        applied: proven.applied,
        newMainPid: proven.observedPid,
        ...(requested
          ? { committedAt: this.deps.now() }
          : { rolledBackAt: this.deps.now() }),
        error: `Recovered by proving the live ${requested ? "requested" : "rollback"} environment. `
          + `Previous failure: ${receipt.error ?? "unknown"}`,
      }, true);
    }

    const adopted = await this.tryAdoptLiveOfficialDesktop(receipt, prepared);
    if (adopted !== null) {
      return this.update(receipt, {
        phase: "cancelled",
        ownerPid: process.pid,
        newMainPid: adopted.mainPid,
        cancelledAt: this.deps.now(),
        error: officialAdoptionError(receipt.error),
      }, true);
    }

    throw new Error(
      `Environment transaction ${receipt.transactionId} could not be recovered from live evidence: `
      + "the live desktop proves neither the requested nor the rollback environment, and it is not a "
      + "verified official update that advanced past the recorded payload. "
      + `Last failure: ${receipt.error ?? "unknown"}`,
    );
  }

  private async proveEitherDirection(
    receipt: EnvironmentTransactionReceipt,
    prepared: PreparedEnvironmentEvidence,
  ): Promise<{ direction: "requested" | "rollback"; applied: EnvironmentAppliedEvidence; observedPid: number } | null> {
    const attempts: Array<{ direction: "requested" | "rollback"; expected: EnvironmentSelection }> = [
      { direction: "requested", expected: receipt.requested },
      { direction: "rollback", expected: prepared.rollback.selection },
    ];
    for (const attempt of attempts) {
      const observed = await this.deps.observeDesktop(attempt.expected.selectedDesktopPath);
      if (observed === null || !observed.visibleWindow) continue;
      let applied: EnvironmentAppliedEvidence | null;
      try {
        applied = await this.deps.proveAppliedEnvironment({
          direction: attempt.direction,
          receipt,
          expected: attempt.expected,
          observation: observed,
          prepared,
        });
      } catch {
        continue;
      }
      if (applied !== null && appliedEvidenceProvesRequest(
        applied,
        attempt.expected,
        prepared,
        attempt.direction,
      )) {
        return { direction: attempt.direction, applied, observedPid: observed.pid };
      }
    }
    return null;
  }

  private async tryAdoptLiveOfficialDesktop(
    receipt: EnvironmentTransactionReceipt,
    prepared: PreparedEnvironmentEvidence,
  ): Promise<AdoptedOfficialDesktop | null> {
    const candidates = [
      {
        selection: receipt.requested,
        baseline: { marketingVersion: prepared.candidate.version, build: prepared.candidate.build },
      },
      {
        selection: prepared.rollback.selection,
        baseline: {
          marketingVersion: prepared.rollback.desktopVersion,
          build: prepared.rollback.desktopBuild,
        },
      },
    ];
    for (const candidate of candidates) {
      if (candidate.selection.appExperience !== "chatgpt") continue;
      const input = {
        selection: candidate.selection,
        baseline: candidate.baseline,
        excludedMainPid: receipt.oldMainPid,
      };
      const proof = await this.deps.proveOfficialDesktop(input);
      if (proof === null) continue;
      return this.deps.commitOfficialDesktop({ ...input, proof });
    }
    return null;
  }

  async cancel(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    return this.withMutationLock(
      () => this.cancelUnlocked(transactionId),
      { continueTransaction: true, transactionId },
    );
  }

  private async cancelUnlocked(transactionId?: string): Promise<EnvironmentTransactionReceipt> {
    const receipt = this.requireReceipt(transactionId);
    if (receipt.phase !== "prepared" && receipt.phase !== "preparing") {
      throw new Error(`Environment transaction ${receipt.transactionId} cannot be cancelled from phase ${receipt.phase}`);
    }
    return this.update(receipt, {
      phase: "cancelled",
      ownerPid: process.pid,
      cancelledAt: this.deps.now(),
      error: null,
    }, true);
  }

  private async rollbackInternal(
    initial: EnvironmentTransactionReceipt,
    reason: string,
  ): Promise<EnvironmentTransactionReceipt> {
    if (initial.prepared === null) {
      return this.update(initial, {
        phase: "failed",
        error: `${reason}; rollback failed: prepared rollback evidence is missing`,
      }, true);
    }
    const prepared = initial.prepared;
    let receipt = this.update(initial, { phase: "rolling-back", error: reason });
    try {
      // Prove recovery bytes while the currently running target is still
      // untouched. Rollback depends only on rollback evidence; a corrupted
      // requested artifact must never prevent restoration.
      await this.deps.validatePreparedEnvironment({
        receipt,
        prepared,
        direction: "rollback",
      });
      const target = await this.deps.observeDesktop(receipt.requested.selectedDesktopPath);
      if (target !== null) {
        await this.stopAndClean(receipt.requested.selectedDesktopPath, target.pid);
      }
      const oldMainPid = receipt.oldMainPid;
      if (oldMainPid !== null && this.deps.processAlive(oldMainPid)) {
        const source = await this.deps.observeDesktop(receipt.source.selectedDesktopPath);
        if (source === null || source.pid !== oldMainPid) {
          throw new Error(
            `Refusing rollback while original source PID ${oldMainPid} is alive but cannot be proven at ${receipt.source.selectedDesktopPath}`,
          );
        }
        await this.stopAndClean(receipt.source.selectedDesktopPath, oldMainPid);
      }
      receipt = this.update(receipt, { phase: "applying", applyProgress: null });
      await this.deps.applyPreparedEnvironment({
        direction: "rollback",
        receipt,
        prepared,
        // Reassigns the enclosing `receipt` so every later this.update —
        // including the terminal write — carries the last durable stamp.
        onProgress: (step) => {
          receipt = this.update(receipt, { applyProgress: `rollback:${step}` });
        },
      });
      await this.deps.reopenDesktop(receipt.source.selectedDesktopPath);
      let restored: EnvironmentDesktopObservation | null = null;
      let applied: EnvironmentAppliedEvidence | null = null;
      let rollbackError = "rollback desktop was not observed";
      for (let poll = 0; poll < this.verificationPolls; poll++) {
        const observed = await this.deps.observeDesktop(receipt.source.selectedDesktopPath);
        if (observed === null) {
          rollbackError = "rollback desktop main process was not observed";
        } else if (receipt.oldMainPid !== null && observed.pid === receipt.oldMainPid) {
          rollbackError = `rollback desktop reused old main PID ${receipt.oldMainPid}`;
        } else if (!observed.visibleWindow) {
          rollbackError = `rollback desktop PID ${observed.pid} has no activated visible window`;
        } else {
          const proof = await this.deps.proveAppliedEnvironment({
            direction: "rollback",
            receipt,
            expected: prepared.rollback.selection,
            observation: observed,
            prepared,
          });
          if (proof !== null && appliedEvidenceProvesRequest(
            proof,
            prepared.rollback.selection,
            prepared,
            "rollback",
          )) {
            restored = observed;
            applied = proof;
            break;
          }
          rollbackError = "rollback environment state has not been proven";
        }
        if (poll + 1 < this.verificationPolls) await this.deps.sleep(this.verificationIntervalMs);
      }
      if (restored === null || applied === null) throw new Error(rollbackError);
      await this.deps.bindWatcherTarget({ direction: "rollback", applied, prepared });
      await this.deps.publishSelection(applied.selection);
      await this.deps.resumeWatcher({
        transactionId: receipt.transactionId,
        targetAppRoot: receipt.source.selectedDesktopPath,
        targetExpectedFingerprint: applied.desktopArtifactDigest,
      });
      receipt = this.update(receipt, {
        phase: "rolled-back",
        applied,
        newMainPid: restored.pid,
        rolledBackAt: this.deps.now(),
        error: reason,
      }, true);
      return receipt;
    } catch (rollbackError) {
      return this.update(receipt, {
        phase: "failed",
        error: `${reason}; rollback failed: ${errorMessage(rollbackError)}`,
      }, true);
    }
  }

  private async stopAndClean(path: string, expectedPid: number): Promise<void> {
    await this.deps.quitDesktop(path, expectedPid);
    if (this.deps.processAlive(expectedPid)) {
      throw new Error(`Refusing helper cleanup while exact main PID ${expectedPid} is still alive`);
    }
    await this.deps.cleanupHelpers(path, expectedPid);
  }

  private async proveReplacementSourcePid(
    receipt: EnvironmentTransactionReceipt,
    prepared: PreparedEnvironmentEvidence,
  ): Promise<{ pid: number | null; sourceObserved: boolean }> {
    try {
      const observed = await this.deps.observeDesktop(receipt.source.selectedDesktopPath);
      if (observed === null) return { pid: null, sourceObserved: false };
      if (receipt.oldMainPid !== null && observed.pid === receipt.oldMainPid) {
        return { pid: null, sourceObserved: true };
      }
      const applied = await this.deps.proveAppliedEnvironment({
        direction: "rollback",
        receipt,
        expected: prepared.rollback.selection,
        observation: observed,
        prepared,
      });
      return applied !== null && appliedEvidenceProvesRequest(
        applied,
        prepared.rollback.selection,
        prepared,
        "rollback",
      ) ? { pid: observed.pid, sourceObserved: true } : { pid: null, sourceObserved: true };
    } catch {
      return { pid: null, sourceObserved: false };
    }
  }

  private async withMutationLock<T>(
    operation: () => Promise<T>,
    allowance: { continueTransaction?: boolean; transactionId?: string; recovery?: boolean } = {},
  ): Promise<T> {
    return withLifecycleLock(this.lifecycleLockFile, "environment transaction", async () => {
      if (!allowance.continueTransaction) this.reconcileDeadOwnerBeforeNewTransaction();
      const environmentTransactionId = allowance.continueTransaction
        ? allowance.transactionId ?? this.status()?.transactionId
        : undefined;
      assertLifecycleReceiptsIdle(dirname(dirname(this.lifecycleLockFile)), {
        environmentTransactionId,
        environmentRecovery: allowance.recovery === true,
      });
      const lock = acquireProcessLock(this.lockFile, {
        onContended: (owner) => new Error(
          owner === null
            ? "Another environment transaction holds the installer lock"
            : `Another environment transaction holds the installer lock (PID ${owner})`,
        ),
      });
      try {
        return await operation();
      } finally {
        lock.release();
      }
    });
  }

  private reconcileDeadOwnerBeforeNewTransaction(): void {
    const receipt = this.status();
    if (receipt === null
      || (receipt.phase !== "preparing" && receipt.phase !== "prepared")
      || receipt.ownerPid === process.pid
      || this.deps.processAlive(receipt.ownerPid)) return;
    this.update(receipt, {
      phase: "cancelled",
      ownerPid: process.pid,
      cancelledAt: this.deps.now(),
      error: `Cancelled automatically after owner PID ${receipt.ownerPid} exited before cutover.`,
    }, true);
  }

  private requireReceipt(transactionId?: string): EnvironmentTransactionReceipt {
    const receipt = this.status();
    if (receipt === null) throw new Error("No environment transaction receipt exists");
    if (transactionId !== undefined && receipt.transactionId !== transactionId) {
      throw new Error(`Environment transaction mismatch: expected ${transactionId}, found ${receipt.transactionId}`);
    }
    return receipt;
  }

  private update(
    receipt: EnvironmentTransactionReceipt,
    patch: Partial<EnvironmentTransactionReceipt>,
    terminal = false,
  ): EnvironmentTransactionReceipt {
    const next = { ...receipt, ...patch, updatedAt: this.deps.now() };
    this.persist(next, terminal);
    return next;
  }

  private persist(receipt: EnvironmentTransactionReceipt, terminal = false): void {
    if (terminal) {
      // The archived receipt is durable evidence, while the current receipt is
      // the lifecycle gate. Publish the gate-opening terminal state last so an
      // interrupted archive write can never make incomplete recovery look done.
      writeEnvironmentTransactionReceipt(join(this.receiptRoot, `${receipt.transactionId}.json`), receipt);
    }
    writeEnvironmentTransactionReceipt(this.transactionFile, receipt);
  }
}

export function isTerminalEnvironmentPhase(phase: EnvironmentTransactionPhase): boolean {
  return phase === "committed" || phase === "rolled-back" || phase === "failed" || phase === "cancelled";
}

/**
 * Recognize the one legacy receipt shape that proves cutover never began.
 * Keep this deliberately narrow: ambiguous rollback failures must continue to
 * fail closed and use the normal artifact-restoration path. `attempt` stays in
 * the test because a receipt that already reached `reopening` had a candidate
 * bound to the live path, so its rollback selection cannot be proven honestly
 * from bytes alone. Receipts this misses are served by `recover`, which asks
 * the machine what it can prove instead of assuming.
 */
export function environmentFailureMayBePreCutover(
  receipt: EnvironmentTransactionReceipt,
): boolean {
  return receipt.phase === "failed"
    && receipt.prepared !== null
    && receipt.applied === null
    && receipt.newMainPid === null
    && receipt.attempt === 0
    && receipt.committedAt === null
    && receipt.rolledBackAt === null;
}

/**
 * Eligibility (never a conclusion) for the proof-based "cutover never began"
 * recovery: also admits receipts stranded mid-`committing`/`applying` by an
 * exited owner, which carry the identical nothing-applied evidence. Excludes
 * `reopening`/`verifying` (attempt >= 1 means a candidate was bound to the
 * live path) and `rolling-back` (a prior rollback attempt may have partially
 * restored bytes). The live-state proof in tryRecoverProvenPreCutoverFailure
 * remains the only authority for the actual conclusion.
 */
export function environmentReceiptMayBePreCutover(
  receipt: EnvironmentTransactionReceipt,
): boolean {
  // rollbackInternal also runs under phase "applying" (stamping a
  // "rollback:"-prefixed applyProgress): that is post-cutover byte
  // restoration, where the live bundle may be a half-restored mix — never
  // eligible for a pre-cutover conclusion. Unstamped legacy receipts stay
  // admitted; the live-state proof remains the byte-state authority there.
  if ((receipt.applyProgress ?? "").startsWith("rollback:")) return false;
  return (receipt.phase === "failed"
    || receipt.phase === "committing"
    || receipt.phase === "applying")
    && receipt.prepared !== null
    && receipt.applied === null
    && receipt.newMainPid === null
    && receipt.attempt === 0
    && receipt.committedAt === null
    && receipt.rolledBackAt === null;
}

export function readEnvironmentTransactionReceipt(file: string): EnvironmentTransactionReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Environment transaction receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  if (!isEnvironmentTransactionReceipt(value)) {
    throw new Error(`Environment transaction receipt is invalid at ${file}`);
  }
  return value;
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

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
  // Legacy receipts predate asar integrity evidence. Only terminal phases may
  // omit it: an in-flight transaction without the hashes cannot be verified,
  // so it must stay invalid (fail closed) rather than resume unverifiable.
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

function isEnvironmentCommitHelperReceipt(value: unknown): value is EnvironmentCommitHelperReceipt {
  const hasCliDigest = isRecord(value) && value.cliArtifactDigest !== undefined;
  const hasManagedRuntimePath = isRecord(value) && value.managedRuntimeArtifactPath !== undefined;
  const hasManagedRuntimeDigest = isRecord(value) && value.managedRuntimeArtifactDigest !== undefined;
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "environment-commit-helper"
    && nonEmpty(value.transactionId)
    && nonEmpty(value.label)
    && exactAbsolutePath(value.cliPath)
    && (value.cliArtifactDigest === undefined || sha256(value.cliArtifactDigest))
    && (value.managedRuntimeArtifactPath === undefined || exactAbsolutePath(value.managedRuntimeArtifactPath))
    && (value.managedRuntimeArtifactDigest === undefined || sha256(value.managedRuntimeArtifactDigest))
    && (hasCliDigest === hasManagedRuntimePath)
    && (hasCliDigest === hasManagedRuntimeDigest)
    && exactAbsolutePath(value.userRoot)
    && exactAbsolutePath(value.wrapperFile)
    && exactAbsolutePath(value.stdoutFile)
    && exactAbsolutePath(value.stderrFile)
    && exactAbsolutePath(value.outcomeFile)
    && (value.phase === "submitted" || value.phase === "submit-failed")
    && validIso(value.submittedAt)
    && (value.error === null || typeof value.error === "string")
    && ((value.phase === "submitted" && value.error === null)
      || (value.phase === "submit-failed" && nonEmpty(value.error)));
}

function isEnvironmentCommitHelperOutcome(value: unknown): value is EnvironmentCommitHelperOutcome {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "environment-commit-helper-outcome"
    || !nonEmpty(value.transactionId)
    || !nonEmpty(value.label)
    || (value.phase !== "not-started" && value.phase !== "running" && value.phase !== "succeeded" && value.phase !== "failed")
    || (value.pid !== undefined && value.pid !== null
      && (!Number.isInteger(value.pid) || (value.pid as number) <= 0))
    || !nullableIso(value.startedAt)
    || (value.heartbeatAt !== undefined && !nullableIso(value.heartbeatAt))
    || !nullableIso(value.finishedAt)
    || (value.exitCode !== null && (!Number.isInteger(value.exitCode) || (value.exitCode as number) < 0))
    || (value.error !== null && typeof value.error !== "string")) {
    return false;
  }
  if (value.phase === "not-started") {
    return (value.pid === undefined || value.pid === null)
      && value.startedAt === null
      && (value.heartbeatAt === undefined || value.heartbeatAt === null)
      && value.finishedAt === null
      && value.exitCode === null
      && value.error === null;
  }
  if (value.phase === "running") {
    return validIso(value.startedAt)
      && (value.heartbeatAt === undefined || validIso(value.heartbeatAt))
      && value.finishedAt === null
      && value.exitCode === null
      && value.error === null;
  }
  if (!validIso(value.startedAt) || !validIso(value.finishedAt) || !Number.isInteger(value.exitCode)) return false;
  return value.phase === "succeeded"
    ? value.exitCode === 0 && value.error === null
    : (value.exitCode as number) > 0 && nonEmpty(value.error);
}

function preparedEvidenceMatches(
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

function appliedEvidenceProvesRequest(
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

function selectionsMatch(
  applied: EnvironmentSelection,
  requested: EnvironmentSelection,
  includeAppliedAt: boolean,
): boolean {
  return applied.selectedDesktopPath === requested.selectedDesktopPath
    && applied.selectedDesktopBundleId === requested.selectedDesktopBundleId
    && applied.appExperience === requested.appExperience
    && applied.releaseProfile === requested.releaseProfile
    && applied.backendLane === requested.backendLane
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

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableIso(value: unknown): value is string | null {
  return value === null || validIso(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_CHILD_PROCESS_DIAGNOSTIC_CHARS = 2_048;

function reopenFailureSummary(failures: string[]): string | null {
  return failures.length > 0
    ? `relaunch command failure${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}`
    : null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRecord(error)) return message;

  const failedCommand = message.match(/^Command failed: (\S+)/)?.[1];
  if (!failedCommand) return message;

  const diagnostics = [error.stderr, error.stdout]
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value ?? "").trim())
    .find(Boolean);
  if (diagnostics === undefined) return message;

  const boundedDiagnostics = diagnostics.length > MAX_CHILD_PROCESS_DIAGNOSTIC_CHARS
    ? `[truncated ${diagnostics.length - MAX_CHILD_PROCESS_DIAGNOSTIC_CHARS} chars]\n` +
      diagnostics.slice(-MAX_CHILD_PROCESS_DIAGNOSTIC_CHARS)
    : diagnostics;
  const status = typeof error.status === "number" ? ` (exit ${error.status})` : "";
  return `${failedCommand} failed${status}: ${boundedDiagnostics}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

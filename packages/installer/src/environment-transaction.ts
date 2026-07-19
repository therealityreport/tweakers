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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
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
  buildPatchedCandidateOnly,
  readAsarMarker,
  replaceAppBundlePreservingIdentity,
  stagedNativeHostPath,
  verifyStagedNativeHostForApp,
} from "./commands/install.js";
import { terminateStaleHelperProcesses } from "./orphans.js";
import { userPaths } from "./paths.js";
import { LEGACY_USER_ROOT_ENV } from "./legacy-compat.js";
import { readPlist } from "./plist.js";
import { acquireProcessLock, processAlive } from "./process-lock.js";
import { assertLifecycleReceiptsIdle, withLifecycleLock } from "./lifecycle-lock.js";
import { createMcpModeBridge } from "./mcp-mode-bridge.js";
import { targetUserHome } from "./ownership.js";
import { readState, writeState } from "./state.js";
import { cloneAppTree } from "./transaction.js";
import { installWatcher } from "./watcher.js";
import { payloadMetadataFile, writePayloadMetadata } from "./mode-transition.js";

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
  backendLane: BackendLane;
  backendBinaryPath: string;
  backendArtifactPath: string;
  backendVersion: string;
  backendArtifactDigest: string;
}

export interface PreparedEnvironmentEvidence {
  preparedAt: string;
  candidate: PreparedDesktopCandidateEvidence;
  backend: PreparedBackendEvidence;
  rollback: PreparedRollbackEvidence;
}

export interface EnvironmentAppliedEvidence {
  observedAt: string;
  selection: EnvironmentSelection;
  desktopVersion: string;
  desktopBuild: string;
  backendVersion: string;
  desktopArtifactDigest: string;
  backendArtifactDigest: string;
}

export interface EnvironmentRuntimeProof {
  schemaVersion: 1;
  kind: "environment-runtime-proof";
  pid: number;
  appRoot: string;
  bundleId: EnvironmentSelection["selectedDesktopBundleId"];
  appExperience: "tweakers";
  releaseProfile: ReleaseProfile;
  backendLane: "bundled" | "managed-alpha";
  binaryPath: string;
  backendVersion: string;
  backendFingerprint: string;
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
}

export interface EnvironmentCoordinatorOptions {
  transactionFile?: string;
  receiptRoot?: string;
  selectionFile?: string;
  registryFile?: string;
  configFile?: string;
  stateFile?: string;
  lockFile?: string;
  lifecycleLockFile?: string;
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
  applyPreparedEnvironment?: (input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    prepared: PreparedEnvironmentEvidence;
  }) => void | Promise<void>;
  observeDesktop?: (path: string) => EnvironmentDesktopObservation | null | Promise<EnvironmentDesktopObservation | null>;
  quitDesktop?: (path: string, expectedPid: number) => void | Promise<void>;
  processAlive?: (pid: number) => boolean;
  cleanupHelpers?: (path: string, stoppedMainPid: number) => void | Promise<void>;
  reopenDesktop?: (path: string) => void | Promise<void>;
  refreshWatcher?: (path: string) => void | Promise<void>;
  proveAppliedEnvironment?: (input: {
    direction: "requested" | "rollback";
    receipt: EnvironmentTransactionReceipt;
    expected: EnvironmentSelection;
    observation: EnvironmentDesktopObservation;
    prepared: PreparedEnvironmentEvidence;
  }) => EnvironmentAppliedEvidence | null | Promise<EnvironmentAppliedEvidence | null>;
  publishSelection?: (selection: EnvironmentSelection) => void | Promise<void>;
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
}

export interface DefaultEnvironmentAdapterDeps {
  cloneApp?: (source: string, destination: string) => void;
  replaceApp?: (source: string, destination: string, validate: (destination: string) => boolean) => void;
  copyBackend?: (source: string, destination: string) => void;
  preparePatchedPayload?: (profile: EnvironmentProfileRecord, destination: string) => void | Promise<void>;
  prepareManagedBackend?: (profile: EnvironmentProfileRecord, destination: string) => void | Promise<void>;
  readMarker?: (asarPath: string) => "present" | "absent" | "unreadable";
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
  readAppState?: (stateFile: string) => { appExperience: AppExperience; appRoot: string; bundleId: string | null } | null;
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
  writeAppState?: (stateFile: string, selection: EnvironmentSelection, desktopVersion: string) => void;
  loadState?: typeof loadEnvironmentState;
  now?: () => string;
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

/**
 * Hand commit ownership to a launchd process before the desktop quits. The
 * durable submission receipt lets the next process distinguish "never
 * launched" from an environment transaction that is merely still preparing.
 */
export function submitEnvironmentCommitHelper(
  input: SubmitEnvironmentCommitHelperInput,
  deps: SubmitEnvironmentCommitHelperDeps = {},
): EnvironmentCommitHelperReceipt {
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
  if (!exactAbsolutePath(input.userRoot)) throw new Error("Environment helper user root must be exact and absolute");
  if (!exactAbsolutePath(input.receiptFile)) throw new Error("Environment helper receipt path must be exact and absolute");
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
    userRoot: input.userRoot,
    runtimePath,
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

function writeEnvironmentCommitHelperWrapper(input: {
  transactionId: string;
  label: string;
  cliPath: string;
  userRoot: string;
  runtimePath: string | null;
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
  const script = [
    "#!/bin/sh",
    "set -u",
    "umask 077",
    `LABEL=${shellSingleQuote(input.label)}`,
    `WRAPPER=${shellSingleQuote(input.wrapperFile)}`,
    `OUTCOME=${shellSingleQuote(input.outcomeFile)}`,
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
    command,
    "STATUS=$?",
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
): Pick<Required<EnvironmentCoordinatorDeps>, "preparePrerequisites" | "applyPreparedEnvironment" | "proveAppliedEnvironment"> {
  const adapters = resolvedDefaultEnvironmentAdapterDeps(options, deps);
  return {
    preparePrerequisites: (input) => prepareEnvironmentPrerequisites(input, options, adapters),
    applyPreparedEnvironment: (input) => applyPreparedEnvironment(input, options, adapters),
    proveAppliedEnvironment: (input) => proveAppliedEnvironment(input, options, adapters),
  };
}

type ResolvedDefaultEnvironmentAdapterDeps = Required<DefaultEnvironmentAdapterDeps>;

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
    replaceApp: deps.replaceApp ?? ((source, destination, validate) => {
      replaceAppBundlePreservingIdentity(source, destination, { validateDestination: validate });
    }),
    copyBackend: deps.copyBackend ?? copyBackendAtomically,
    preparePatchedPayload: deps.preparePatchedPayload ?? (async (profile, destination) => {
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
        finalUserRoot: options.environmentRoot ?? userPaths().root,
      });
    }),
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
    readMarker: deps.readMarker ?? readAsarMarker,
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
      };
    }),
    readRuntimeProof: deps.readRuntimeProof ?? readEnvironmentRuntimeProof,
    assertMcpModeReady: deps.assertMcpModeReady ?? mcpModeBridge.assertReady,
    reconcileMcpMode: deps.reconcileMcpMode ?? ((appExperience) => {
      mcpModeBridge.reconcile(appExperience);
    }),
    proveMcpMode: deps.proveMcpMode ?? mcpModeBridge.prove,
    writeAppState: deps.writeAppState ?? ((stateFile, selection, desktopVersion) => {
      const state = readState(stateFile);
      if (!state) throw new Error(`Installer state is missing at ${stateFile}`);
      writeState(stateFile, {
        ...state,
        mode: selection.appExperience,
        appRoot: selection.selectedDesktopPath,
        codexBundleId: selection.selectedDesktopBundleId,
        codexChannel: selection.releaseProfile === "alpha" ? "beta" : "stable",
        codexVersion: desktopVersion,
      });
    }),
    loadState: deps.loadState ?? loadEnvironmentState,
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

async function prepareEnvironmentPrerequisites(
  input: { transactionId: string; current: EnvironmentSelection; requested: EnvironmentSelection; oldMainPid: number | null },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): Promise<PreparedEnvironmentEvidence> {
  deps.assertMcpModeReady();
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
  const officialPathIsPristine = observedAppExperience(requestedProfile.officialPath, deps) === "chatgpt";
  const candidateSource = input.requested.appExperience === "chatgpt"
    ? officialPathIsPristine ? requestedProfile.officialPath : requestedProfile.pristineBackupPath
    : requestedProfile.patchedPayloadPath;
  const expectedCandidateFingerprint = input.requested.appExperience === "chatgpt"
    ? officialPathIsPristine ? null : requestedProfile.pristineBackupFingerprint
    : requestedProfile.patchedPayloadFingerprint;
  const reusablePatchedPayload = input.requested.appExperience === "tweakers"
    && patchedPayloadMatchesProfile(
      candidateSource,
      expectedCandidateFingerprint,
      requestedProfile,
      deps,
    );
  if (input.requested.appExperience === "tweakers"
    && !reusablePatchedPayload
    && requestedProfile.patchedPayloadBuildable) {
    await deps.preparePatchedPayload(requestedProfile, candidateArtifactPath);
  } else {
    if (!existsSync(candidateSource)) throw new Error(`requested desktop artifact is missing at ${candidateSource}`);
    if (expectedCandidateFingerprint !== null) {
      requireArtifact(candidateSource, expectedCandidateFingerprint, deps.appFingerprint, "requested desktop");
    }
    deps.cloneApp(candidateSource, candidateArtifactPath);
  }
  deps.cloneApp(input.current.selectedDesktopPath, rollbackArtifactPath);

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
  const candidateDigest = deps.appFingerprint(candidateArtifactPath);
  const rollbackDigest = deps.appFingerprint(rollbackArtifactPath);

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
    : requestedProfile.officialBackendFingerprint;
  if (expectedBackendFingerprint !== null && expectedBackendFingerprint !== candidateBackendDigest) {
    throw new Error("Prepared backend fingerprint does not match the registry");
  }
  const candidateBackendVersion = deps.readBackendVersion(candidateBackendArtifact)
    ?? (input.requested.backendLane === "managed-alpha"
      ? requestedProfile.backendVersion
      : requestedProfile.officialBackendVersion);
  if (candidateBackendVersion === null) throw new Error("Prepared backend version is unknown");

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
    const proof = deps.readRuntimeProof(
      options.runtimeProofFile ?? join(dirname(options.configFile), "environment-runtime-proof.json"),
    );
    if (!proof
      || (input.oldMainPid !== null && proof.pid !== input.oldMainPid)
      || proof.appRoot !== input.current.selectedDesktopPath
      || proof.bundleId !== input.current.selectedDesktopBundleId
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
    ?? (input.current.backendLane === "official-bundled"
      ? currentProfile.officialBackendVersion
      : currentProfile.backendVersion);
  if (rollbackBackendVersion === null) throw new Error("Prepared rollback backend version is unknown");

  return {
    preparedAt: deps.now(),
    candidate: {
      desktopPath: input.requested.selectedDesktopPath,
      artifactPath: candidateArtifactPath,
      bundleId: input.requested.selectedDesktopBundleId,
      appExperience: input.requested.appExperience,
      releaseProfile: input.requested.releaseProfile,
      version: candidateIdentity.version!,
      build: candidateIdentity.build!,
      artifactDigest: candidateDigest,
      signature: candidateSignature,
    },
    backend: {
      lane: input.requested.backendLane,
      binaryPath: candidateBackendTarget,
      artifactPath: candidateBackendArtifact,
      version: candidateBackendVersion,
      artifactDigest: candidateBackendDigest,
    },
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
      backendLane: input.current.backendLane,
      backendBinaryPath: rollbackBackendTarget,
      backendArtifactPath: rollbackBackendArtifact,
      backendVersion: rollbackBackendVersion,
      backendArtifactDigest: deps.fileFingerprint(rollbackBackendArtifact),
    },
  };
}

function patchedPayloadMatchesProfile(
  artifactPath: string,
  expectedFingerprint: string | null,
  profile: EnvironmentProfileRecord,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): boolean {
  if (!existsSync(artifactPath) || expectedFingerprint === null) return false;
  if (deps.appFingerprint(artifactPath) !== expectedFingerprint) return false;
  const identity = deps.readDesktopIdentity(artifactPath);
  return identity.bundleId === profile.officialBundleId
    && identity.version === profile.officialVersion
    && identity.build === profile.officialBuild
    && observedAppExperience(artifactPath, deps) === "tweakers"
    && existsSync(stagedNativeHostPath(artifactPath));
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

function applyPreparedEnvironment(
  input: { direction: "requested" | "rollback"; receipt: EnvironmentTransactionReceipt; prepared: PreparedEnvironmentEvidence },
  options: DefaultEnvironmentAdapterOptions,
  deps: ResolvedDefaultEnvironmentAdapterDeps,
): void {
  const requestedDirection = input.direction === "requested";
  const selection = requestedDirection ? input.receipt.requested : input.prepared.rollback.selection;
  const artifactPath = requestedDirection
    ? input.prepared.candidate.artifactPath
    : input.prepared.rollback.desktopArtifactPath;
  const expectedDigest = requestedDirection
    ? input.prepared.candidate.artifactDigest
    : input.prepared.rollback.desktopArtifactDigest;
  if (!existsSync(artifactPath) || deps.appFingerprint(artifactPath) !== expectedDigest) {
    throw new Error(`Prepared ${input.direction} desktop artifact is missing or changed`);
  }
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
  deps.replaceApp(artifactPath, selection.selectedDesktopPath, (destination) => {
    const identity = deps.readDesktopIdentity(destination);
    return identity.bundleId === selection.selectedDesktopBundleId
      && deps.appFingerprint(destination) === expectedDigest
      && observedAppExperience(destination, deps) === selection.appExperience;
  });
  if (requestedDirection) {
    // Preserve the exact outgoing app in its own channel store. This is done
    // only after the live replacement validates and before state publication;
    // a copy failure therefore enters the coordinator's prepared rollback.
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

  const backendArtifact = requestedDirection
    ? input.prepared.backend.artifactPath
    : input.prepared.rollback.backendArtifactPath;
  const backendTarget = requestedDirection
    ? input.prepared.backend.binaryPath
    : input.prepared.rollback.backendBinaryPath;
  const backendDigest = requestedDirection
    ? input.prepared.backend.artifactDigest
    : input.prepared.rollback.backendArtifactDigest;
  if (!existsSync(backendArtifact) || deps.fileFingerprint(backendArtifact) !== backendDigest) {
    throw new Error(`Prepared ${input.direction} backend artifact is missing or changed`);
  }
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
  deps.writeAppState(options.stateFile, selection, desktopVersion);
  // The source desktop is already stopped when this adapter runs. Project the
  // target MCP ownership before reopen so regular ChatGPT never inherits
  // Tweakers MCP servers, and rollback restores the source projection before
  // its desktop is reopened.
  deps.reconcileMcpMode(selection.appExperience);
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
  const backendPath = requestedDirection
    ? input.prepared.backend.binaryPath
    : input.prepared.rollback.backendBinaryPath;
  const backendVersion = requestedDirection
    ? input.prepared.backend.version
    : input.prepared.rollback.backendVersion;
  const backendDigest = requestedDirection
    ? input.prepared.backend.artifactDigest
    : input.prepared.rollback.backendArtifactDigest;
  const state = deps.readAppState(options.stateFile);
  const configuredLane = deps.readBackendLane(options.configFile);
  const runtimeProof = expected.appExperience === "tweakers"
    ? deps.readRuntimeProof(options.runtimeProofFile ?? join(dirname(options.configFile), "environment-runtime-proof.json"))
    : null;
  if (identity.bundleId !== expected.selectedDesktopBundleId
    || identity.version !== desktopVersion
    || identity.build !== desktopBuild
    || observedAppExperience(expected.selectedDesktopPath, deps) !== expected.appExperience
    || deps.appFingerprint(expected.selectedDesktopPath) !== desktopDigest
    || state?.appExperience !== expected.appExperience
    || state.appRoot !== expected.selectedDesktopPath
    || state.bundleId !== expected.selectedDesktopBundleId
    || !backendLanesProve(configuredLane, expected.backendLane)
    || !existsSync(backendPath)
    || deps.readBackendVersion(backendPath) !== backendVersion
    || deps.fileFingerprint(backendPath) !== backendDigest
    || (expected.appExperience === "tweakers" && !runtimeProofMatches(
      runtimeProof,
      input.observation.pid,
      expected,
      backendPath,
      backendVersion,
      backendDigest,
      input.receipt.createdAt,
    ))
    || !deps.proveMcpMode(expected.appExperience)) {
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
    backendArtifactDigest: backendDigest,
  };
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
  return value.schemaVersion === 1
    && value.kind === "environment-runtime-proof"
    && positiveInteger(value.pid)
    && typeof value.appRoot === "string"
    && (value.bundleId === "com.openai.codex" || value.bundleId === "com.openai.codex.beta")
    && value.appExperience === "tweakers"
    && (value.releaseProfile === "stable" || value.releaseProfile === "alpha")
    && (value.backendLane === "bundled" || value.backendLane === "managed-alpha")
    && typeof value.binaryPath === "string"
    && typeof value.backendVersion === "string"
    && /^[a-f0-9]{64}$/i.test(typeof value.backendFingerprint === "string" ? value.backendFingerprint : "")
    && validIso(value.observedAt);
}

function runtimeProofMatches(
  proof: EnvironmentRuntimeProof | null,
  pid: number,
  expected: EnvironmentSelection,
  backendPath: string,
  backendVersion: string,
  backendFingerprint: string,
  transactionCreatedAt: string,
): boolean {
  return proof !== null
    && proof.pid === pid
    && proof.appRoot === expected.selectedDesktopPath
    && proof.bundleId === expected.selectedDesktopBundleId
    && proof.releaseProfile === expected.releaseProfile
    && backendLanesProve(proof.backendLane, expected.backendLane)
    && proof.binaryPath === backendPath
    && proof.backendVersion === backendVersion
    && proof.backendFingerprint.toLowerCase() === backendFingerprint.toLowerCase()
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

export class InstallerEnvironmentCoordinator implements EnvironmentCoordinator {
  readonly transactionFile: string;
  readonly receiptRoot: string;
  readonly selectionFile: string;
  readonly registryFile: string;
  readonly configFile: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly lifecycleLockFile: string;
  readonly verificationPolls: number;
  readonly verificationIntervalMs: number;

  private readonly deps: Required<EnvironmentCoordinatorDeps>;

  constructor(options: EnvironmentCoordinatorOptions = {}, deps: EnvironmentCoordinatorDeps = {}) {
    const paths = userPaths();
    this.transactionFile = options.transactionFile ?? paths.environmentTransactionFile;
    this.receiptRoot = options.receiptRoot ?? paths.environmentReceiptRoot;
    this.selectionFile = options.selectionFile ?? paths.environmentSelectionFile;
    // A caller that isolates the selection document must not silently pair it
    // with the real user registry. Besides breaking the atomic document pair,
    // that allowed coordinator tests to publish fixture selections into the
    // live Tweakers environment registry. Keep an explicitly relocated pair
    // together unless the caller also supplies an exact registry path.
    this.registryFile = options.registryFile
      ?? (options.selectionFile
        ? join(dirname(options.selectionFile), "environment-registry.json")
        : paths.environmentRegistryFile);
    this.configFile = options.configFile ?? paths.configFile;
    this.stateFile = options.stateFile ?? paths.stateFile;
    this.lockFile = options.lockFile
      ?? (options.transactionFile ? join(dirname(options.transactionFile), "environment.lock") : paths.environmentLockFile);
    this.lifecycleLockFile = options.lifecycleLockFile
      ?? (options.transactionFile ? join(dirname(options.transactionFile), "lifecycle.lock") : join(paths.root, "transactions", "lifecycle.lock"));
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
      environmentRoot: paths.root,
      runtimeProofFile: paths.environmentRuntimeProofFile,
      mcpConfigFile: defaultCodexMcpConfigFile(),
      mcpStateFile: join(paths.root, "mcp-sync-state.json"),
      tweaksRoot: paths.tweaks,
    });
    this.deps = {
      now: deps.now ?? (() => new Date().toISOString()),
      createId: deps.createId ?? randomUUID,
      preparePrerequisites: deps.preparePrerequisites ?? defaultAdapters.preparePrerequisites,
      applyPreparedEnvironment: deps.applyPreparedEnvironment ?? defaultAdapters.applyPreparedEnvironment,
      observeDesktop: deps.observeDesktop ?? observeCodexMainProcess,
      quitDesktop: deps.quitDesktop ?? quitCodexMainProcess,
      processAlive: deps.processAlive ?? processAlive,
      cleanupHelpers: deps.cleanupHelpers ?? ((path, stoppedMainPid) => {
        terminateStaleHelperProcesses(path, { excludePids: [stoppedMainPid] });
      }),
      reopenDesktop: deps.reopenDesktop ?? ((path) => { openAndActivateCodex(path); }),
      refreshWatcher: deps.refreshWatcher ?? (this.transactionFile === paths.environmentTransactionFile
        ? ((path) => { installWatcher(path); })
        : (() => {})),
      proveAppliedEnvironment: deps.proveAppliedEnvironment ?? defaultAdapters.proveAppliedEnvironment,
      publishSelection: deps.publishSelection ?? ((selection) => {
        if (existsSync(this.registryFile)) {
          publishEnvironmentSelection(this.registryFile, this.selectionFile, selection);
        } else {
          // Explicitly injected coordinator tests may not own a registry. The
          // production adapter refuses preparation without one.
          writeEnvironmentSelection(this.selectionFile, selection);
        }
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

    receipt = this.update(receipt, { phase: "committing", error: null, ownerPid: process.pid });
    let sourceObservedAfterStopFailure = false;
    try {
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
      receipt = this.update(receipt, { phase: "applying" });
      await this.deps.applyPreparedEnvironment({
        direction: "requested",
        receipt,
        prepared,
      });

      let lastVerification: EnvironmentVerification | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        receipt = this.update(receipt, { phase: "reopening", attempt, newMainPid: null });
        await this.deps.reopenDesktop(receipt.requested.selectedDesktopPath);
        receipt = this.update(receipt, { phase: "verifying" });
        lastVerification = await this.verify(receipt.transactionId);
        if (lastVerification.ok
          && lastVerification.appliedSelection !== null
          && lastVerification.appliedEvidence !== null
          && lastVerification.observedPid !== null) {
          await this.deps.refreshWatcher(receipt.requested.selectedDesktopPath);
          await this.deps.publishSelection(lastVerification.appliedSelection);
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

      const reason = lastVerification?.error ?? "requested environment did not become ready";
      receipt = this.update(receipt, { error: reason });
      return this.rollbackInternal(receipt, `Commit failed after one retry: ${reason}`);
    } catch (error) {
      const reason = errorMessage(error);
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
    const receipt = this.requireReceipt(transactionId);
    if (receipt.phase === "rolled-back") return receipt;
    if (receipt.phase === "preparing" || receipt.phase === "prepared") {
      throw new Error(`Environment transaction ${receipt.transactionId} has not cut over; cancel it instead`);
    }
    if (receipt.phase === "cancelled") {
      throw new Error(`Environment transaction ${receipt.transactionId} is already cancelled`);
    }
    if (environmentFailureMayBePreCutover(receipt)) {
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
   * A replacement adapter can fail before its first swap even though the
   * coordinator has entered `applying`. Prove the exact prepared source bytes
   * before deciding that no rollback is required; otherwise return null and
   * leave artifact restoration to the normal rollback path.
   */
  private async tryRecoverProvenPreCutoverFailure(
    receipt: EnvironmentTransactionReceipt,
  ): Promise<EnvironmentTransactionReceipt | null> {
    if (receipt.prepared === null) return null;
    const observed = await this.deps.observeDesktop(receipt.source.selectedDesktopPath);
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
    } catch {
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
    await this.deps.publishSelection(applied.selection);
    return this.update(receipt, {
      phase: "cancelled",
      ownerPid: process.pid,
      applied,
      newMainPid: observed.pid,
      cancelledAt: this.deps.now(),
      error: `Recovered safely without replacing the app. Previous failure: ${receipt.error ?? "unknown pre-cutover failure"}`,
    }, true);
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
      receipt = this.update(receipt, { phase: "applying" });
      await this.deps.applyPreparedEnvironment({
        direction: "rollback",
        receipt,
        prepared,
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
      await this.deps.refreshWatcher(receipt.source.selectedDesktopPath);
      await this.deps.publishSelection(applied.selection);
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
    allowance: { continueTransaction?: boolean; transactionId?: string } = {},
  ): Promise<T> {
    return withLifecycleLock(this.lifecycleLockFile, "environment transaction", async () => {
      if (!allowance.continueTransaction) this.reconcileDeadOwnerBeforeNewTransaction();
      const environmentTransactionId = allowance.continueTransaction
        ? allowance.transactionId ?? this.status()?.transactionId
        : undefined;
      assertLifecycleReceiptsIdle(dirname(dirname(this.lifecycleLockFile)), {
        environmentTransactionId,
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
    writeEnvironmentTransactionReceipt(this.transactionFile, receipt);
    if (terminal) {
      writeEnvironmentTransactionReceipt(join(this.receiptRoot, `${receipt.transactionId}.json`), receipt);
    }
  }
}

export function isTerminalEnvironmentPhase(phase: EnvironmentTransactionPhase): boolean {
  return phase === "committed" || phase === "rolled-back" || phase === "failed" || phase === "cancelled";
}

/**
 * Recognize the one legacy receipt shape that proves cutover never began.
 * Keep this deliberately narrow: ambiguous rollback failures must continue to
 * fail closed and use the normal artifact-restoration path.
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

/** Backward-compatible classifier for receipts emitted by older runtimes. */
export function environmentFailureIsLegacyPreCutover(
  receipt: EnvironmentTransactionReceipt,
): boolean {
  return environmentFailureMayBePreCutover(receipt)
    && /^Commit failed: Refusing to quit .+: expected main PID \d+ is not current; rollback failed:/i.test(
      receipt.error ?? "",
    );
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
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "environment-commit-helper"
    && nonEmpty(value.transactionId)
    && nonEmpty(value.label)
    && exactAbsolutePath(value.cliPath)
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
    || !isPreparedSignatureEvidence(candidate.signature)) return false;
  if (!isRecord(backend)
    || !isBackendLane(backend.lane)
    || !exactAbsolutePath(backend.binaryPath)
    || !exactAbsolutePath(backend.artifactPath)
    || !nonEmpty(backend.version)
    || !nonEmpty(backend.artifactDigest)) return false;
  return isRecord(rollback)
    && isEnvironmentSelection(rollback.selection)
    && exactAbsolutePath(rollback.desktopPath)
    && exactAbsolutePath(rollback.desktopArtifactPath)
    && exactAbsolutePath(rollback.archivePath)
    && isBundleId(rollback.bundleId)
    && nonEmpty(rollback.desktopVersion)
    && nonEmpty(rollback.desktopBuild)
    && nonEmpty(rollback.desktopArtifactDigest)
    && isBackendLane(rollback.backendLane)
    && exactAbsolutePath(rollback.backendBinaryPath)
    && exactAbsolutePath(rollback.backendArtifactPath)
    && nonEmpty(rollback.backendVersion)
    && nonEmpty(rollback.backendArtifactDigest)
    && rollback.desktopPath === rollback.selection.selectedDesktopPath
    && rollback.bundleId === rollback.selection.selectedDesktopBundleId
    && rollback.backendLane === rollback.selection.backendLane;
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
    && nonEmpty(value.backendArtifactDigest);
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
    return applied.desktopVersion === prepared.candidate.version
      && applied.desktopBuild === prepared.candidate.build
      && applied.backendVersion === prepared.backend.version
      && applied.desktopArtifactDigest === prepared.candidate.artifactDigest
      && applied.backendArtifactDigest === prepared.backend.artifactDigest;
  }
  return applied.desktopVersion === prepared.rollback.desktopVersion
    && applied.desktopBuild === prepared.rollback.desktopBuild
    && applied.backendVersion === prepared.rollback.backendVersion
    && applied.desktopArtifactDigest === prepared.rollback.desktopArtifactDigest
    && applied.backendArtifactDigest === prepared.rollback.backendArtifactDigest;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

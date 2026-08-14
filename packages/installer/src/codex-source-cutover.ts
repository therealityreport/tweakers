import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  readCodexDerivedReceipt,
  transitionCodexDerivedReceipt,
  type CodexDerivedReceipt,
  type WatcherPromotionEvidence,
} from "./codex-derived-receipt.js";
import {
  finalizeManagedMcpRuntimeCutover,
  promoteManagedMcpRuntime,
  readManagedMcpCutoverReceipt,
  rollbackManagedMcpRuntime,
  type ManagedMcpCutoverReceipt,
} from "./managed-mcp-cutover.js";
import {
  attestManagedMcpArtifact,
  readAndVerifyManagedMcpLifecycleOverlay,
  type ManagedMcpArtifactEvidence,
  type ManagedMcpConfigReconciliationPlan,
  type ManagedMcpLifecycleOverlay,
  type ManagedMcpPreparedRuntimeEvidence,
} from "./managed-mcp-lifecycle.js";
import {
  beginWatcherPromotion,
  finishWatcherPromotion,
  readWatcherPromotionReceipt,
  type WatcherPromotionDeps,
} from "./watcher-promotion.js";
import { assertInternalStoragePath } from "./internal-storage.js";
import { verifySignature } from "./codesign.js";
import {
  sha256TrustedManagedMcpCanaryRunnerSource,
  trustedManagedMcpCanaryRunnerSourcePath,
} from "./managed-mcp-canary-runner.js";
import {
  sha256TrustedManagedMcpAppServerAdapterSource,
  trustedManagedMcpAppServerAdapterSourcePath,
} from "./managed-mcp-canary-app-server-adapter.js";

export type CodexSourceCutoverPhase = "promoting" | "verified" | "rolled-back" | "failed";

export const CODEX_SOURCE_CUTOVER_STEPS = [
  "watcher-paused",
  "app-stopped",
  "app-promoted",
  "plugins-installing",
  "plugins-installed",
  "runtime-promoting",
  "runtime-promoted",
  "config-applying",
  "config-applied",
  "app-started",
  "installed-verified",
  "watcher-rearming",
  "watcher-rearmed",
  "runtime-finalized",
] as const;

export type CodexSourceCutoverStep = typeof CODEX_SOURCE_CUTOVER_STEPS[number];

export interface CodexSourceInstalledPlugin {
  artifactId: string;
  pluginId: string;
  version: string;
  owner: string;
  installedPath: string;
  sha256: string;
  entryCount: number;
}

export interface CodexSourceCutoverReceipt {
  schemaVersion: 1;
  kind: "codex-source-cutover";
  transactionId: string;
  phase: CodexSourceCutoverPhase;
  sourceReceiptFile: string;
  candidateApp: string;
  liveApp: string;
  appRollback: string;
  liveConfig: string;
  configSnapshot: string;
  liveRuntime: string;
  runtimeRollback: string;
  managedCutoverReceipt: string;
  watcherReceipt: string;
  pluginCacheRoot: string;
  pluginCacheSnapshot: string | null;
  pluginCacheSnapshotSha256: string | null;
  approvalSha256: string;
  sourceAppFingerprint: string;
  sourceConfigSha256: string;
  targetAppFingerprint: string | null;
  configSha256: string | null;
  installedVerificationFile: string;
  installedVerificationSha256: string | null;
  plugins: readonly CodexSourceInstalledPlugin[];
  completedSteps: readonly CodexSourceCutoverStep[];
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  rolledBackAt: string | null;
  error: string | null;
}

export interface CodexSourceCutoverInput {
  transactionId: string;
  sourceReceiptFile: string;
  candidateApp: string;
  liveApp: string;
  liveCodexHome: string;
  liveConfig: string;
  watcherReceipt: string;
  transactionRoot: string;
  approvalFile: string;
  approvalToken: string;
  now(): string;
}

export interface CodexSourceCutoverDeps {
  watcher?: WatcherPromotionDeps;
  restart?: {
    stopGracefully(appRoot: string): void;
    start(appRoot: string): void;
  };
  installPlugins?: (input: {
    candidateBinary: string;
    codexHome: string;
    marketplaceRoot: string;
    marketplaceName: string;
    artifacts: readonly ManagedMcpArtifactEvidence[];
  }) => readonly CodexSourceInstalledPlugin[];
  verifyCandidateSignature?: (appRoot: string) => { ok: boolean; output: string };
  promoteApp?: typeof promoteAppAtomically;
  promoteRuntime?: typeof promoteManagedMcpRuntime;
  reconcileConfig?: typeof reconcileCodexSourceLiveConfig;
  finalizeRuntime?: typeof finalizeManagedMcpRuntimeCutover;
  verifyInstalled?: (input: {
    liveApp: string;
    liveConfig: string;
    codexHome: string;
    activeRuntime: string;
    expectedCandidateSha256: string;
    expectedFleetFingerprint: string;
    plugins: readonly CodexSourceInstalledPlugin[];
    verificationFile: string;
  }) => string;
}

export interface CodexSourceRestartApproval {
  schemaVersion: 1;
  kind: "codex-source-restart-approval";
  transactionId: string;
  action: "cutover" | "rollback";
  sourceReceiptSha256: string;
  candidateSha256: string;
  liveApp: string;
  liveCodexHome: string;
  liveConfig: string;
  watcherReceipt: string;
  tokenSha256: string;
  issuedAt: string;
  expiresAt: string;
}

interface CodexSourceCutoverPaths {
  receiptFile: string;
  configSnapshot: string;
  appRollback: string;
  runtimeRollback: string;
  managedCutoverReceipt: string;
  liveRuntime: string;
  pluginCacheSnapshot: string;
  verificationFile: string;
}

export function executeCodexSourceCutover(
  input: CodexSourceCutoverInput,
  deps: CodexSourceCutoverDeps = {},
): CodexSourceCutoverReceipt {
  const paths = cutoverPaths(input);
  const receipt = requireCanaryPassedReceipt(input.sourceReceiptFile, input.transactionId);
  const prepared = requireManagedRuntime(receipt);
  const candidateBinary = exactFile(join(input.candidateApp, "Contents", "Resources", "codex"), "candidate Codex binary");
  const expectedCandidateSha256 = receipt.candidateBinary.digests.find((digest) =>
    digest.algorithm === "sha256" && digest.scope === "derived candidate binary"
  )?.value;
  if (!expectedCandidateSha256 || sha256(readFileSync(candidateBinary)) !== expectedCandidateSha256) {
    throw new Error("Cutover candidate does not match the frozen receipt");
  }
  assertFrozenCanaryReference(receipt, candidateBinary, expectedCandidateSha256, prepared);
  assertFrozenRustLifecycleTests(receipt, expectedCandidateSha256);
  const approvalSha256 = assertRestartApproval(input, receipt, expectedCandidateSha256, "cutover");
  const candidateSignature = (deps.verifyCandidateSignature ?? verifySignature)(input.candidateApp);
  if (!candidateSignature.ok) throw new Error(`Cutover candidate signature is invalid: ${candidateSignature.output}`);
  if (existsSync(paths.receiptFile)) throw new Error(`Codex source cutover receipt already exists: ${paths.receiptFile}`);
  mkdirSync(input.transactionRoot, { recursive: true });
  const sourceAppFingerprint = digestTree(exactDirectory(input.liveApp, "live app"));
  mkdirSync(dirname(paths.configSnapshot), { recursive: true });
  cpSync(exactFile(input.liveConfig, "live Codex config"), paths.configSnapshot);
  const sourceConfigSha256 = sha256(readFileSync(paths.configSnapshot));
  const pluginCacheRoot = join(input.liveCodexHome, "plugins", "cache", "codex-on-demand-managed");
  let state: CodexSourceCutoverReceipt = {
    schemaVersion: 1,
    kind: "codex-source-cutover",
    transactionId: input.transactionId,
    phase: "promoting",
    sourceReceiptFile: input.sourceReceiptFile,
    candidateApp: input.candidateApp,
    liveApp: input.liveApp,
    appRollback: paths.appRollback,
    liveConfig: input.liveConfig,
    configSnapshot: paths.configSnapshot,
    liveRuntime: paths.liveRuntime,
    runtimeRollback: paths.runtimeRollback,
    managedCutoverReceipt: paths.managedCutoverReceipt,
    watcherReceipt: input.watcherReceipt,
    pluginCacheRoot,
    pluginCacheSnapshot: null,
    pluginCacheSnapshotSha256: null,
    approvalSha256,
    sourceAppFingerprint,
    sourceConfigSha256,
    targetAppFingerprint: null,
    configSha256: null,
    installedVerificationFile: paths.verificationFile,
    installedVerificationSha256: null,
    plugins: [],
    completedSteps: [],
    createdAt: input.now(),
    updatedAt: input.now(),
    verifiedAt: null,
    rolledBackAt: null,
    error: null,
  };
  writeCutoverReceipt(paths.receiptFile, state);
  try {
    transitionCodexDerivedReceipt({ receiptFile: input.sourceReceiptFile, to: "promoting", now: input.now() });
    beginWatcherPromotion(input.watcherReceipt, {
      transactionId: input.transactionId,
      sourceAppRoot: input.liveApp,
      requestedAppRoot: input.liveApp,
      sourceExpectedFingerprint: sourceAppFingerprint,
    }, deps.watcher);
    state = recordCompletedStep(paths.receiptFile, state, "watcher-paused", input.now);
    (deps.restart ?? defaultRestartController()).stopGracefully(input.liveApp);
    state = recordCompletedStep(paths.receiptFile, state, "app-stopped", input.now);
    if (existsSync(pluginCacheRoot)) {
      if (existsSync(paths.pluginCacheSnapshot)) throw new Error("Managed plugin-cache rollback snapshot already exists");
      mkdirSync(dirname(paths.pluginCacheSnapshot), { recursive: true });
      renameSync(pluginCacheRoot, paths.pluginCacheSnapshot);
      state = {
        ...state,
        pluginCacheSnapshot: paths.pluginCacheSnapshot,
        pluginCacheSnapshotSha256: digestTree(paths.pluginCacheSnapshot),
        updatedAt: input.now(),
      };
      writeCutoverReceipt(paths.receiptFile, state);
    }
    (deps.promoteApp ?? promoteAppAtomically)(input.candidateApp, input.liveApp, paths.appRollback);
    state = recordCompletedStep(paths.receiptFile, state, "app-promoted", input.now);
    const marketplaceRoot = preparePluginMarketplace(prepared, join(input.transactionRoot, "live-marketplace"), "codex-on-demand-managed");
    const install = deps.installPlugins ?? installPluginsWithCandidateManager;
    state = recordCompletedStep(paths.receiptFile, state, "plugins-installing", input.now);
    const plugins = install({
      candidateBinary: exactFile(join(input.liveApp, "Contents", "Resources", "codex"), "installed candidate binary"),
      codexHome: input.liveCodexHome,
      marketplaceRoot,
      marketplaceName: "codex-on-demand-managed",
      artifacts: prepared.artifacts.filter((artifact) => artifact.kind === "plugin-bundle"),
    });
    assertInstalledPlugins(prepared, plugins, input.liveCodexHome);
    state = {
      ...recordCompletedStep(paths.receiptFile, state, "plugins-installed", input.now),
      plugins,
      updatedAt: input.now(),
    };
    writeCutoverReceipt(paths.receiptFile, state);
    const overrides = Object.fromEntries(plugins.map((plugin) => [plugin.artifactId, plugin.installedPath]));
    state = recordCompletedStep(paths.receiptFile, state, "runtime-promoting", input.now);
    (deps.promoteRuntime ?? promoteManagedMcpRuntime)({
      transactionId: input.transactionId,
      prepared,
      activeRuntimeRoot: paths.liveRuntime,
      rollbackRuntimeRoot: paths.runtimeRollback,
      receiptFile: paths.managedCutoverReceipt,
      watcherReceiptFile: input.watcherReceipt,
      artifactDestinationOverrides: overrides,
      now: input.now,
    });
    state = recordCompletedStep(paths.receiptFile, state, "runtime-promoted", input.now);
    state = recordCompletedStep(paths.receiptFile, state, "config-applying", input.now);
    (deps.reconcileConfig ?? reconcileCodexSourceLiveConfig)(input.liveConfig, prepared.configReconciliation);
    state = recordCompletedStep(paths.receiptFile, state, "config-applied", input.now);
    const configSha256 = sha256(readFileSync(input.liveConfig));
    const targetAppFingerprint = digestTree(input.liveApp);
    (deps.restart ?? defaultRestartController()).start(input.liveApp);
    state = recordCompletedStep(paths.receiptFile, state, "app-started", input.now);
    const verify = deps.verifyInstalled ?? verifyInstalledDefault;
    const installedVerificationSha256 = verify({
      liveApp: input.liveApp,
      liveConfig: input.liveConfig,
      codexHome: input.liveCodexHome,
      activeRuntime: paths.liveRuntime,
      expectedCandidateSha256,
      expectedFleetFingerprint: readAndVerifyManagedMcpLifecycleOverlay(join(paths.liveRuntime, "managed-mcp-lifecycle.v1.json")).fleetFingerprint,
      plugins,
      verificationFile: paths.verificationFile,
    });
    const verificationFile = exactFile(paths.verificationFile, "installed verification output");
    if (sha256(readFileSync(verificationFile)) !== installedVerificationSha256) {
      throw new Error("Installed verifier returned a digest that does not match its evidence file");
    }
    state = {
      ...recordCompletedStep(paths.receiptFile, state, "installed-verified", input.now),
      installedVerificationSha256,
      updatedAt: input.now(),
    };
    writeCutoverReceipt(paths.receiptFile, state);
    state = recordCompletedStep(paths.receiptFile, state, "watcher-rearming", input.now);
    finishWatcherPromotion(input.watcherReceipt, {
      transactionId: input.transactionId,
      targetAppRoot: input.liveApp,
      targetExpectedFingerprint: targetAppFingerprint,
    }, deps.watcher);
    state = recordCompletedStep(paths.receiptFile, state, "watcher-rearmed", input.now);
    (deps.finalizeRuntime ?? finalizeManagedMcpRuntimeCutover)(paths.managedCutoverReceipt, {
      installedVerificationFile: paths.verificationFile,
      now: input.now,
    });
    state = recordCompletedStep(paths.receiptFile, state, "runtime-finalized", input.now);
    const watcher = watcherEvidence(sourceAppFingerprint, targetAppFingerprint, input.watcherReceipt, input.now());
    transitionCodexDerivedReceipt({ receiptFile: input.sourceReceiptFile, to: "promoted", now: input.now(), watcher });
    state = {
      ...state,
      phase: "verified",
      targetAppFingerprint,
      configSha256,
      installedVerificationSha256,
      plugins,
      updatedAt: input.now(),
      verifiedAt: input.now(),
    };
    writeCutoverReceipt(paths.receiptFile, state);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { rollbackCutoverState(state, deps.watcher, input.now, deps.restart); } catch (rollbackError) {
      const failure = `${message}; rollback failed: ${String(rollbackError)}`;
      state = { ...state, phase: "failed", error: failure, updatedAt: input.now() };
      writeCutoverReceipt(paths.receiptFile, state);
      throw new Error(failure);
    }
    state = { ...state, phase: "rolled-back", error: message, updatedAt: input.now(), rolledBackAt: input.now() };
    writeCutoverReceipt(paths.receiptFile, state);
    throw error;
  }
}

/** Explicit operator rollback. It requires a distinct, short-lived rollback approval. */
export function rollbackCodexSourceCutover(
  input: CodexSourceCutoverInput,
  deps: Pick<CodexSourceCutoverDeps, "watcher" | "restart"> = {},
): CodexSourceCutoverReceipt {
  const paths = cutoverPaths(input);
  const state = readCodexSourceCutoverReceipt(paths.receiptFile);
  if (state.transactionId !== input.transactionId) throw new Error("Codex source cutover transaction mismatch");
  if (state.phase === "rolled-back") return state;
  const source = requireSourceReceipt(input.sourceReceiptFile, input.transactionId);
  const expectedCandidateSha256 = source.candidateBinary.digests.find((digest) =>
    digest.algorithm === "sha256" && digest.scope === "derived candidate binary"
  )?.value;
  if (!expectedCandidateSha256) throw new Error("Source receipt lacks candidate binary digest");
  assertRestartApproval(input, source, expectedCandidateSha256, "rollback");
  rollbackCutoverState(state, deps.watcher, input.now, deps.restart);
  const rolledBack: CodexSourceCutoverReceipt = {
    ...state,
    phase: "rolled-back",
    updatedAt: input.now(),
    rolledBackAt: input.now(),
    error: null,
  };
  writeCutoverReceipt(paths.receiptFile, rolledBack);
  return rolledBack;
}

export function readCodexSourceCutoverReceipt(file: string): CodexSourceCutoverReceipt {
  const exact = exactFile(file, "Codex source cutover receipt");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(exact, "utf8"));
  } catch (error) {
    throw new Error(`Codex source cutover receipt is unreadable: ${String(error)}`);
  }
  if (!isCutoverReceipt(value)) throw new Error("Codex source cutover receipt is invalid");
  return value;
}

function cutoverPaths(input: CodexSourceCutoverInput): CodexSourceCutoverPaths {
  assertTransactionId(input.transactionId);
  const transactionRoot = exactFuturePath(input.transactionRoot, "Codex source cutover root");
  const liveCodexHome = exactDirectory(input.liveCodexHome, "live CODEX_HOME");
  return {
    receiptFile: join(transactionRoot, "cutover.json"),
    configSnapshot: join(transactionRoot, "rollback", "config.toml"),
    appRollback: join(transactionRoot, "rollback", "ChatGPT.app"),
    runtimeRollback: join(transactionRoot, "rollback", "managed-runtime"),
    managedCutoverReceipt: join(transactionRoot, "managed-mcp-cutover.json"),
    liveRuntime: join(liveCodexHome, "managed-runtime"),
    pluginCacheSnapshot: join(transactionRoot, "rollback", "managed-plugin-cache"),
    verificationFile: join(transactionRoot, "installed-verification.json"),
  };
}

function requireSourceReceipt(file: string, transactionId: string): CodexDerivedReceipt {
  const readable = readCodexDerivedReceipt(exactFile(file, "Codex source receipt"));
  if (!readable || readable.schemaVersion !== 2 || readable.transactionId !== transactionId) {
    throw new Error("Codex source receipt is missing or belongs to another transaction");
  }
  return readable;
}

function requireCanaryPassedReceipt(file: string, transactionId: string): CodexDerivedReceipt {
  const receipt = requireSourceReceipt(file, transactionId);
  if (receipt.phase !== "canary-passed" || !receipt.canary) {
    throw new Error("Cutover requires a frozen receipt with a passed isolated canary");
  }
  const window = receipt.resolution.restartWindow;
  if (!window) throw new Error("Cutover receipt lacks a frozen restart window");
  return receipt;
}

function requireManagedRuntime(receipt: CodexDerivedReceipt): ManagedMcpPreparedRuntimeEvidence {
  if (!receipt.managedMcp) throw new Error("Cutover receipt lacks managed MCP fleet evidence");
  readAndVerifyManagedMcpLifecycleOverlay(receipt.managedMcp.overlayFile);
  return receipt.managedMcp;
}

function assertFrozenCanaryReference(
  receipt: CodexDerivedReceipt,
  candidateBinary: string,
  candidateSha256: string,
  prepared: ManagedMcpPreparedRuntimeEvidence,
): void {
  const canary = receipt.canary;
  const runner = receipt.trustedCanaryRunner;
  const adapter = receipt.trustedCanaryAdapter;
  if (!canary) throw new Error("Frozen source receipt lacks isolated canary evidence");
  const sidecar = exactFile(canary.sidecarPath, "frozen canary sidecar");
  if (sha256(readFileSync(sidecar)) !== canary.sidecarSha256
    || canary.candidatePath !== candidateBinary
    || canary.candidateSha256 !== candidateSha256
    || canary.managedMcpFleetFingerprint !== prepared.fleetFingerprint
    || !runner
    || canary.trustedRunnerIdentity !== runner.sourcePath
    || canary.trustedRunnerAttestationSha256 !== runner.sha256
    || !adapter
    || canary.trustedObservationAdapterIdentity !== adapter.sourcePath
    || canary.trustedObservationAdapterAttestationSha256 !== adapter.sha256) {
    throw new Error("Frozen isolated canary reference drifted before cutover");
  }
  const source = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
  if (source.transactionId !== receipt.transactionId
    || source.candidatePath !== candidateBinary
    || source.candidateSha256 !== candidateSha256
    || !isRecord(source.managedMcp)
    || source.managedMcp.overlaySha256 !== canary.managedMcpOverlaySha256
    || !isRecord(source.trustedRunner)
    || source.trustedRunner.identity !== canary.trustedRunnerIdentity
    || source.trustedRunner.attestationSha256 !== canary.trustedRunnerAttestationSha256
    || !isRecord(source.trustedObservationAdapter)
    || source.trustedObservationAdapter.identity !== canary.trustedObservationAdapterIdentity
    || source.trustedObservationAdapter.attestationSha256 !== canary.trustedObservationAdapterAttestationSha256) {
    throw new Error("Frozen isolated canary sidecar is not bound to its receipt");
  }
}

function assertFrozenRustLifecycleTests(receipt: CodexDerivedReceipt, candidateSha256: string): void {
  const runner = receipt.trustedCanaryRunner;
  const adapter = receipt.trustedCanaryAdapter;
  const tests = receipt.rustLifecycleTests;
  if (!runner
    || runner.sourcePath !== trustedManagedMcpCanaryRunnerSourcePath()
    || runner.sha256 !== sha256TrustedManagedMcpCanaryRunnerSource(runner.sourcePath)
    || !adapter
    || adapter.sourcePath !== trustedManagedMcpAppServerAdapterSourcePath()
    || adapter.sha256 !== sha256TrustedManagedMcpAppServerAdapterSource(adapter.sourcePath)
    || !tests
    || tests.sourceCommit !== receipt.source.checkoutCommit
    || tests.patchedTreeSha256 !== receipt.source.treeDigest.value
    || tests.cargoLockSha256 !== receipt.source.lockfileDigests.find((item) => item.scope === "Cargo.lock")?.value
    || tests.candidateBinarySha256 !== candidateSha256
    || tests.exitCode !== 0
    || JSON.stringify(tests.command) !== JSON.stringify(["cargo", "test", "--locked", "--package", "codex-mcp", "--lib"])) {
    throw new Error("Frozen receipt lacks candidate-bound green Rust lifecycle evidence");
  }
  const stdout = exactFile(tests.stdoutFile, "Rust lifecycle stdout receipt");
  const stderr = exactFile(tests.stderrFile, "Rust lifecycle stderr receipt");
  if (sha256(readFileSync(stdout)) !== tests.stdoutSha256 || sha256(readFileSync(stderr)) !== tests.stderrSha256) {
    throw new Error("Frozen Rust lifecycle output evidence drifted before cutover");
  }
  const required = [
    /connection_manager::tests::deferred_shutdown_does_not_ignite_never_started_servers$/,
    /connection_manager::tests::cancelled_startup_never_reaches_the_transport$/,
    /connection_manager::tests::shutdown_continues_after_caller_is_aborted$/,
    /connection_manager::tests::capture_binding_exposes_cached_tools_before_startup$/,
    /connection_manager::tests::cancelling_startup_does_not_disable_a_ready_client$/,
    /connection_manager::tests::shutdown_cancels_pending_tool_listing$/,
  ];
  if (required.some((pattern) => !tests.passedTests.some((name) => pattern.test(name)))) {
    throw new Error("Frozen Rust lifecycle receipt is missing a required fault or shutdown proof");
  }
}

function assertRestartApproval(
  input: CodexSourceCutoverInput,
  receipt: CodexDerivedReceipt,
  candidateSha256: string,
  action: "cutover" | "rollback",
): string {
  const file = exactFile(input.approvalFile, "Codex restart approval");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`Codex restart approval is unreadable: ${String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Codex restart approval is invalid");
  const approval = value as unknown as CodexSourceRestartApproval;
  const expectedToken = sha256(Buffer.from(input.approvalToken));
  const now = Date.parse(input.now());
  const window = receipt.resolution.restartWindow;
  if (
    approval.schemaVersion !== 1
    || approval.kind !== "codex-source-restart-approval"
    || approval.transactionId !== input.transactionId
    || approval.action !== action
    || approval.sourceReceiptSha256 !== sha256(readFileSync(input.sourceReceiptFile))
    || approval.candidateSha256 !== candidateSha256
    || approval.liveApp !== input.liveApp
    || approval.liveCodexHome !== input.liveCodexHome
    || approval.liveConfig !== input.liveConfig
    || approval.watcherReceipt !== input.watcherReceipt
    || approval.tokenSha256 !== expectedToken
    || !Number.isFinite(now)
    || !Number.isFinite(Date.parse(approval.issuedAt))
    || !Number.isFinite(Date.parse(approval.expiresAt))
    || now < Date.parse(approval.issuedAt)
    || now > Date.parse(approval.expiresAt)
    || (action === "cutover" && (!window
      || now < Date.parse(window.opensAt)
      || now > Date.parse(window.closesAt)))
  ) throw new Error(`Codex ${action} approval is absent, expired, or not bound to this exact operation`);
  return sha256(readFileSync(file));
}

function promoteAppAtomically(candidate: string, live: string, rollback: string): void {
  exactDirectory(candidate, "candidate app");
  exactDirectory(live, "live app");
  const rollbackPath = exactFuturePath(rollback, "app rollback");
  if (existsSync(rollbackPath)) throw new Error("App rollback snapshot already exists");
  mkdirSync(dirname(rollbackPath), { recursive: true });
  const incoming = `${live}.incoming-${process.pid}-${randomUUID()}`;
  cpSync(candidate, incoming, { recursive: true, verbatimSymlinks: true });
  if (digestTree(incoming) !== digestTree(candidate)) {
    rmSync(incoming, { recursive: true, force: true });
    throw new Error("Candidate app changed while staging cutover");
  }
  renameSync(live, rollbackPath);
  try { renameSync(incoming, live); } catch (error) {
    renameSync(rollbackPath, live);
    rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
}

function preparePluginMarketplace(
  prepared: ManagedMcpPreparedRuntimeEvidence,
  root: string,
  name: string,
): string {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  const artifacts = prepared.artifacts.filter((artifact) => artifact.kind === "plugin-bundle");
  if (artifacts.length === 0) throw new Error("Cutover fleet lacks receipt-bound plugin bundles");
  const plugins = artifacts.map((artifact) => {
    if (!artifact.destination || !artifact.version || !artifact.runtimeRelativePath) {
      throw new Error(`Plugin artifact ${artifact.id} is incomplete`);
    }
    const parts = artifact.runtimeRelativePath.split("/");
    const pluginId = parts.length === 3 ? parts[1] : null;
    if (!pluginId) throw new Error(`Plugin artifact ${artifact.id} has invalid path`);
    const destination = join(root, "plugins", pluginId);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(artifact.destination, destination, { recursive: true, verbatimSymlinks: true });
    const copied = attestManagedMcpArtifact(destination, "plugin-bundle");
    if (copied.sha256 !== artifact.sha256 || copied.entryCount !== artifact.entryCount) {
      throw new Error(`Plugin artifact ${pluginId} drifted during marketplace staging`);
    }
    return { name: pluginId, source: { source: "local", path: `./plugins/${pluginId}` } };
  });
  atomicJsonWrite(join(root, ".agents", "plugins", "marketplace.json"), {
    name,
    interface: { displayName: "Codex On-Demand Managed" },
    plugins: plugins.map((plugin) => ({ ...plugin, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" })),
  });
  return root;
}

function installPluginsWithCandidateManager(input: {
  candidateBinary: string;
  codexHome: string;
  marketplaceRoot: string;
  marketplaceName: string;
  artifacts: readonly ManagedMcpArtifactEvidence[];
}): readonly CodexSourceInstalledPlugin[] {
  const env = { ...process.env, CODEX_HOME: input.codexHome };
  execFileSync(input.candidateBinary, ["plugin", "marketplace", "add", input.marketplaceRoot, "--json"], { env, stdio: ["ignore", "pipe", "inherit"] });
  return input.artifacts.map((artifact) => {
    if (!artifact.runtimeRelativePath || !artifact.version) throw new Error(`Plugin artifact ${artifact.id} is incomplete`);
    const pluginId = artifact.runtimeRelativePath.split("/")[1];
    if (!pluginId) throw new Error(`Plugin artifact ${artifact.id} has invalid path`);
    const bytes = execFileSync(input.candidateBinary, ["plugin", "add", `${pluginId}@${input.marketplaceName}`, "--json"], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    return {
      artifactId: artifact.id,
      pluginId,
      version: String(value.version),
      owner: `plugin:${pluginId}@${String(value.version)}`,
      installedPath: String(value.installedPath),
      sha256: artifact.sha256,
      entryCount: artifact.entryCount,
    };
  });
}

function assertInstalledPlugins(
  prepared: ManagedMcpPreparedRuntimeEvidence,
  installed: readonly CodexSourceInstalledPlugin[],
  codexHome: string,
): void {
  const expected = prepared.artifacts.filter((artifact) => artifact.kind === "plugin-bundle");
  if (installed.length !== expected.length) throw new Error("Plugin manager did not install the complete fleet");
  for (const artifact of expected) {
    const actual = installed.find((plugin) => plugin.artifactId === artifact.id);
    const pluginId = artifact.runtimeRelativePath?.split("/")[1];
    if (!actual || !pluginId || actual.pluginId !== pluginId || actual.version !== artifact.version
      || actual.owner !== `plugin:${pluginId}@${artifact.version}`
      || !isWithin(codexHome, actual.installedPath)) {
      throw new Error(`Installed plugin evidence drift for ${artifact.id}`);
    }
    const attested = attestManagedMcpArtifact(actual.installedPath, "plugin-bundle");
    if (attested.sha256 !== artifact.sha256 || attested.entryCount !== artifact.entryCount) {
      throw new Error(`Installed plugin bundle drift for ${artifact.id}`);
    }
  }
}

export function reconcileCodexSourceLiveConfig(file: string, plan: ManagedMcpConfigReconciliationPlan): void {
  const exact = exactFile(file, "live Codex config");
  let text = readFileSync(exact, "utf8");
  const routeNames = new Set(plan.routes.map((route) => route.server));
  text = removeTomlMcpRouteTables(text, routeNames);
  text = setTomlFeature(text, plan.feature.key, plan.feature.value);
  const replacementBlocks = plan.routes
    .filter((route) => route.action !== "archive-shadow")
    .map((route) => renderMcpRoute(route));
  const next = `${text.trimEnd()}${replacementBlocks.length ? `\n\n${replacementBlocks.join("\n\n")}` : ""}\n`;
  atomicTextWrite(exact, Buffer.from(next));
}

function removeTomlMcpRouteTables(text: string, routes: ReadonlySet<string>): string {
  const lines = text.split(/(?<=\n)/);
  const output: string[] = [];
  let skip = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]\n]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
    if (header) {
      const server = mcpServerFromTable(header[1]);
      skip = server !== null && routes.has(server);
    }
    if (!skip) output.push(line);
  }
  return output.join("");
}

function mcpServerFromTable(table: string): string | null {
  const trimmed = table.trim();
  if (!trimmed.startsWith("mcp_servers.")) return null;
  const suffix = trimmed.slice("mcp_servers.".length);
  if (suffix.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < suffix.length; index += 1) {
      const character = suffix[index];
      if (character === '"' && !escaped) {
        try { return JSON.parse(suffix.slice(0, index + 1)) as string; } catch { return null; }
      }
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
    }
    return null;
  }
  return suffix.split(".")[0]?.trim() || null;
}

function setTomlFeature(text: string, key: string, value: boolean): string {
  const lines = text.split(/(?<=\n)/);
  let featuresStart = -1;
  let featuresEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*\[([^\]\n]+)\]/.exec(lines[index]);
    if (!header) continue;
    if (header[1].trim() === "features") {
      if (featuresStart !== -1) throw new Error("Live Codex config contains duplicate [features] tables");
      featuresStart = index;
      continue;
    }
    if (featuresStart !== -1 && featuresEnd === lines.length) featuresEnd = index;
  }
  const assignment = `${key} = ${value ? "true" : "false"}\n`;
  if (featuresStart === -1) return `${text.trimEnd()}\n\n[features]\n${assignment}`;
  let found = -1;
  for (let index = featuresStart + 1; index < featuresEnd; index += 1) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[index])) {
      if (found !== -1) throw new Error(`Live Codex config contains duplicate features.${key} assignments`);
      found = index;
    }
  }
  if (found === -1) lines.splice(featuresEnd, 0, assignment);
  else lines[found] = assignment;
  return lines.join("");
}

function renderMcpRoute(route: ManagedMcpConfigReconciliationPlan["routes"][number]): string {
  const declaration = route.effectiveDeclaration;
  if (!declaration) throw new Error(`Config reconciliation route ${route.server} lacks a materialized declaration`);
  const lines = [
    `[mcp_servers.${JSON.stringify(route.server)}]`,
    `command = ${JSON.stringify(declaration.command)}`,
    `args = ${JSON.stringify(declaration.args)}`,
  ];
  if (declaration.cwd !== null) lines.push(`cwd = ${JSON.stringify(declaration.cwd)}`);
  if (Object.keys(declaration.explicitEnv).length > 0) {
    const env = Object.entries(declaration.explicitEnv).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`).join(", ");
    lines.push(`env = { ${env} }`);
  }
  return lines.join("\n");
}

function verifyInstalledDefault(input: {
  liveApp: string;
  liveConfig: string;
  codexHome: string;
  activeRuntime: string;
  expectedCandidateSha256: string;
  expectedFleetFingerprint: string;
  plugins: readonly CodexSourceInstalledPlugin[];
  verificationFile: string;
}): string {
  const signature = verifySignature(exactDirectory(input.liveApp, "installed app"));
  if (!signature.ok) throw new Error(`Installed app signature verification failed: ${signature.output}`);
  const binary = exactFile(join(input.liveApp, "Contents", "Resources", "codex"), "installed Codex binary");
  if (sha256(readFileSync(binary)) !== input.expectedCandidateSha256) throw new Error("Installed Codex binary drifted");
  const overlay = readAndVerifyManagedMcpLifecycleOverlay(join(input.activeRuntime, "managed-mcp-lifecycle.v1.json"));
  if (overlay.fleetFingerprint !== input.expectedFleetFingerprint) throw new Error("Installed MCP fleet fingerprint drifted");
  const config = readFileSync(exactFile(input.liveConfig, "installed Codex config"), "utf8");
  if (!/^\s*mcp_on_demand\s*=\s*true\s*(?:#.*)?$/m.test(config)) {
    throw new Error("Installed Codex config did not enable features.mcp_on_demand");
  }
  for (const plugin of input.plugins) {
    const attested = attestManagedMcpArtifact(plugin.installedPath, "plugin-bundle");
    if (attested.sha256 !== plugin.sha256 || attested.entryCount !== plugin.entryCount) {
      throw new Error(`Installed plugin verification failed for ${plugin.pluginId}`);
    }
  }
  const statusBytes = execFileSync(binary, ["mcp", "list", "--json"], {
    env: {
      ...process.env,
      CODEX_HOME: input.codexHome,
      CODEX_MANAGED_MCP_ROOT: join(input.activeRuntime, "packages"),
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  let status: unknown;
  try { status = JSON.parse(statusBytes.toString("utf8")); } catch (error) {
    throw new Error(`Installed MCP status is not JSON: ${String(error)}`);
  }
  assertInstalledManagedMcpStatus(status, overlay);
  const commands = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const targetedProcesses = commands.split("\n").filter((line) =>
    /chrome-devtools-mcp|(?:@playwright\/mcp|playwright-mcp)|xcodebuildmcp|pdfx(?:-cli)?\s+mcp|shadcn.*\smcp|react-doctor-mcp|SkyComputerUseClient|node_repl|headroom.*mcp|(?:mcp\/server\.mjs|server\.cjs|server\.bundle\.mjs)/i.test(line)
  );
  if (targetedProcesses.length > 0) {
    throw new Error(`Installed MCP process census is not idle: ${targetedProcesses.join(" | ")}`);
  }
  const evidence = {
    schemaVersion: 1,
    kind: "codex-source-installed-verification",
    app: input.liveApp,
    appFingerprint: digestTree(input.liveApp),
    binarySha256: input.expectedCandidateSha256,
    config: input.liveConfig,
    configSha256: sha256(Buffer.from(config)),
    activeRuntime: input.activeRuntime,
    fleetFingerprint: overlay.fleetFingerprint,
    plugins: input.plugins,
    mcpStatusSha256: sha256(statusBytes),
    targetedProcesses,
    verifiedAt: new Date().toISOString(),
  };
  atomicJsonWrite(input.verificationFile, evidence);
  return sha256(readFileSync(input.verificationFile));
}

/**
 * Verify the exact JSON schema emitted by `codex mcp list --json` and bind it
 * to the receipt-owned overlay. The CLI intentionally emits snake_case even
 * though the app-server protocol serializes the analogous fields as camelCase.
 */
export function assertInstalledManagedMcpStatus(
  status: unknown,
  overlay: ManagedMcpLifecycleOverlay,
): void {
  if (!Array.isArray(status) || !status.every(isRecord)) {
    throw new Error("Installed MCP status is not an array of objects");
  }
  const local = status.filter((row) => isRecord(row.transport)
    && row.transport.type === "stdio"
    && row.enabled === true);
  const expected = [...overlay.entries].sort((left, right) =>
    left.owner.localeCompare(right.owner) || left.server.localeCompare(right.server)
  );
  const actual = local.map((row) => {
    const name = typeof row.name === "string" ? row.name : null;
    const owner = typeof row.owner === "string" ? row.owner : null;
    const lifecycle = row.lifecycle === "on_demand_call" || row.lifecycle === "on_demand_task"
      ? row.lifecycle
      : null;
    const lifecycleState = row.lifecycle_state;
    const catalogDigest = typeof row.catalog_digest === "string" ? row.catalog_digest : null;
    if (!name || !owner || !lifecycle || lifecycleState !== "dormant" || !catalogDigest || row.reason !== null) {
      throw new Error("Installed MCP status contains a local route without exact dormant on-demand CLI evidence");
    }
    return { name, owner, lifecycle, catalogDigest };
  }).sort((left, right) => left.owner.localeCompare(right.owner) || left.name.localeCompare(right.name));
  if (actual.length !== expected.length) {
    throw new Error(`Installed MCP local route set differs from receipt: expected ${expected.length}, observed ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index]!;
    const observed = actual[index]!;
    const expectedLifecycle = wanted.lifecycle === "call" ? "on_demand_call" : "on_demand_task";
    if (observed.name !== wanted.server
      || observed.owner !== wanted.owner
      || observed.lifecycle !== expectedLifecycle
      || observed.catalogDigest !== wanted.catalog.sha256) {
      throw new Error(
        `Installed MCP route identity drift: expected ${wanted.owner}/${wanted.server}/${expectedLifecycle}/${wanted.catalog.sha256}, `
        + `observed ${observed.owner}/${observed.name}/${observed.lifecycle}/${observed.catalogDigest}`,
      );
    }
  }
}

function watcherEvidence(
  sourceFingerprint: string,
  targetFingerprint: string,
  receiptFile: string,
  now: string,
): WatcherPromotionEvidence {
  const watcher = readWatcherPromotionReceipt(exactFile(receiptFile, "watcher promotion receipt"));
  if (!watcher || watcher.phase !== "resumed" || watcher.targetExpectedFingerprint !== targetFingerprint) {
    throw new Error("Watcher was not rearmed with the promoted app fingerprint");
  }
  return {
    previousFingerprints: { [watcher.sourceAppRoot]: sourceFingerprint },
    promotedFingerprints: { [watcher.activeTargetAppRoot ?? watcher.requestedAppRoot]: targetFingerprint },
    pauseTokenDigest: { algorithm: "sha256", value: sha256(readFileSync(receiptFile)), scope: "watcher promotion receipt" },
    expectedFingerprintUpdatedAt: now,
    rearmedAt: watcher.resumedAt,
    wasEnabled: watcher.snapshot.enabled,
  };
}

function rollbackCutoverState(
  state: CodexSourceCutoverReceipt,
  watcherDeps: WatcherPromotionDeps | undefined,
  now: () => string,
  restart: CodexSourceCutoverDeps["restart"],
): void {
  const sourceReceipt = requireSourceReceipt(state.sourceReceiptFile, state.transactionId);
  if (!["rolling-back", "rolled-back"].includes(sourceReceipt.phase)) {
    if (["canary-passed", "promoting", "promoted", "soaking", "failed"].includes(sourceReceipt.phase)) {
      transitionCodexDerivedReceipt({ receiptFile: state.sourceReceiptFile, to: "rolling-back", now: now() });
    }
  }
  const watcher = readWatcherPromotionReceipt(state.watcherReceipt);
  if (watcher?.phase === "resumed") {
    beginWatcherPromotion(state.watcherReceipt, {
      transactionId: state.transactionId,
      sourceAppRoot: state.liveApp,
      requestedAppRoot: state.liveApp,
      sourceExpectedFingerprint: watcher.targetExpectedFingerprint ?? state.sourceAppFingerprint,
    }, watcherDeps);
  }
  (restart ?? defaultRestartController()).stopGracefully(state.liveApp);
  if (existsSync(state.appRollback)) {
    const displaced = `${state.liveApp}.failed-${state.transactionId}`;
    if (existsSync(displaced)) throw new Error(`Failed app evidence already exists: ${displaced}`);
    if (existsSync(state.liveApp)) renameSync(state.liveApp, displaced);
    renameSync(state.appRollback, state.liveApp);
    if (digestTree(state.liveApp) !== state.sourceAppFingerprint) throw new Error("Restored app does not match pre-cutover fingerprint");
  }
  if (existsSync(state.configSnapshot)) {
    const snapshot = readFileSync(state.configSnapshot);
    if (sha256(snapshot) !== state.sourceConfigSha256) throw new Error("Codex config rollback snapshot drifted");
    atomicTextWrite(state.liveConfig, snapshot);
  }
  if (existsSync(state.managedCutoverReceipt)) {
    const currentRuntimeReceipt = readManagedMcpCutoverReceipt(state.managedCutoverReceipt);
    if (currentRuntimeReceipt.phase === "promoted" || currentRuntimeReceipt.phase === "verified") {
      const runtimeReceipt = rollbackManagedMcpRuntime(state.managedCutoverReceipt, now);
      if (runtimeReceipt.phase !== "rolled-back") throw new Error("Managed MCP runtime rollback did not complete");
    } else if (currentRuntimeReceipt.phase !== "failed") {
      throw new Error(`Managed MCP runtime cannot be rolled back from ${currentRuntimeReceipt.phase}`);
    }
  }
  if (existsSync(state.pluginCacheRoot)) {
    const displaced = `${state.pluginCacheRoot}.failed-${state.transactionId}`;
    if (existsSync(displaced)) throw new Error(`Failed plugin-cache evidence already exists: ${displaced}`);
    renameSync(state.pluginCacheRoot, displaced);
  }
  if (state.pluginCacheSnapshot && existsSync(state.pluginCacheSnapshot)) {
    if (!state.pluginCacheSnapshotSha256
      || digestTree(state.pluginCacheSnapshot) !== state.pluginCacheSnapshotSha256) {
      throw new Error("Managed plugin-cache rollback snapshot drifted");
    }
    mkdirSync(dirname(state.pluginCacheRoot), { recursive: true });
    renameSync(state.pluginCacheSnapshot, state.pluginCacheRoot);
  }
  const afterWatcher = readWatcherPromotionReceipt(state.watcherReceipt);
  if (afterWatcher?.phase === "paused") {
    finishWatcherPromotion(state.watcherReceipt, {
      transactionId: state.transactionId,
      targetAppRoot: state.liveApp,
      targetExpectedFingerprint: state.sourceAppFingerprint,
    }, watcherDeps);
  }
  (restart ?? defaultRestartController()).start(state.liveApp);
  const current = requireSourceReceipt(state.sourceReceiptFile, state.transactionId);
  if (current.phase === "rolling-back") {
    transitionCodexDerivedReceipt({ receiptFile: state.sourceReceiptFile, to: "rolled-back", now: now() });
  }
}

function defaultRestartController(): NonNullable<CodexSourceCutoverDeps["restart"]> {
  return {
    stopGracefully(appRoot) {
      const executable = join(appRoot, "Contents", "MacOS", "ChatGPT");
      execFileSync("/usr/bin/osascript", ["-e", 'tell application id "com.openai.chat" to quit'], { stdio: "ignore" });
      waitForAppProcess(executable, false, 30_000);
    },
    start(appRoot) {
      execFileSync("/usr/bin/open", [appRoot], { stdio: "ignore" });
      waitForAppProcess(join(appRoot, "Contents", "MacOS", "ChatGPT"), true, 30_000);
    },
  };
}

function waitForAppProcess(executable: string, expectedRunning: boolean, deadlineMs: number): void {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() <= deadline) {
    const output = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
    const running = output.split("\n").some((line) => line === executable || line.startsWith(`${executable} `));
    if (running === expectedRunning) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`ChatGPT app did not ${expectedRunning ? "start" : "stop"} within the approved restart window`);
}

function writeCutoverReceipt(file: string, receipt: CodexSourceCutoverReceipt): void {
  if (!isCutoverReceipt(receipt)) throw new Error("Refusing to write invalid Codex source cutover receipt");
  atomicJsonWrite(file, receipt);
}

function recordCompletedStep(
  receiptFile: string,
  state: CodexSourceCutoverReceipt,
  step: CodexSourceCutoverStep,
  now: () => string,
): CodexSourceCutoverReceipt {
  if (state.completedSteps.includes(step)) return state;
  const expectedIndex = state.completedSteps.length;
  if (CODEX_SOURCE_CUTOVER_STEPS[expectedIndex] !== step) {
    throw new Error(`Codex source cutover step ${step} is out of order`);
  }
  const next = {
    ...state,
    completedSteps: [...state.completedSteps, step],
    updatedAt: now(),
  };
  writeCutoverReceipt(receiptFile, next);
  return next;
}

function isCutoverReceipt(value: unknown): value is CodexSourceCutoverReceipt {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.kind === "codex-source-cutover"
    && typeof value.transactionId === "string"
    && ["promoting", "verified", "rolled-back", "failed"].includes(String(value.phase))
    && typeof value.sourceReceiptFile === "string"
    && typeof value.candidateApp === "string"
    && typeof value.liveApp === "string"
    && typeof value.appRollback === "string"
    && typeof value.liveConfig === "string"
    && typeof value.configSnapshot === "string"
    && typeof value.liveRuntime === "string"
    && typeof value.runtimeRollback === "string"
    && typeof value.managedCutoverReceipt === "string"
    && typeof value.watcherReceipt === "string"
    && typeof value.pluginCacheRoot === "string"
    && (value.pluginCacheSnapshot === null || typeof value.pluginCacheSnapshot === "string")
    && (value.pluginCacheSnapshotSha256 === null || validSha(value.pluginCacheSnapshotSha256))
    && ((value.pluginCacheSnapshot === null) === (value.pluginCacheSnapshotSha256 === null))
    && validSha(value.approvalSha256)
    && validSha(value.sourceAppFingerprint)
    && validSha(value.sourceConfigSha256)
    && (value.targetAppFingerprint === null || validSha(value.targetAppFingerprint))
    && (value.configSha256 === null || validSha(value.configSha256))
    && typeof value.installedVerificationFile === "string"
    && (value.installedVerificationSha256 === null || validSha(value.installedVerificationSha256))
    && Array.isArray(value.plugins)
    && value.plugins.every((plugin) => isRecord(plugin)
      && typeof plugin.artifactId === "string"
      && typeof plugin.pluginId === "string"
      && typeof plugin.version === "string"
      && typeof plugin.owner === "string"
      && typeof plugin.installedPath === "string"
      && validSha(plugin.sha256)
      && Number.isSafeInteger(plugin.entryCount)
      && (plugin.entryCount as number) > 0)
    && Array.isArray(value.completedSteps)
    && value.completedSteps.every((step) => CODEX_SOURCE_CUTOVER_STEPS.includes(step as CodexSourceCutoverStep))
    && new Set(value.completedSteps).size === value.completedSteps.length
    && value.completedSteps.every((step, index) => CODEX_SOURCE_CUTOVER_STEPS[index] === step)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && (value.verifiedAt === null || typeof value.verifiedAt === "string")
    && (value.rolledBackAt === null || typeof value.rolledBackAt === "string")
    && (value.error === null || typeof value.error === "string")
    && (value.phase !== "verified" || (
      validSha(value.targetAppFingerprint)
      && validSha(value.configSha256)
      && validSha(value.installedVerificationSha256)
      && typeof value.verifiedAt === "string"
      && value.plugins.length > 0
      && value.completedSteps.length === CODEX_SOURCE_CUTOVER_STEPS.length
      && value.error === null
    ))
    && (value.phase !== "rolled-back" || typeof value.rolledBackAt === "string");
}

function digestTree(root: string): string {
  const exact = exactDirectory(root, "digest tree");
  const records: Array<Record<string, string | number>> = [];
  const collect = (path: string): void => {
    const stat = lstatSync(path);
    const local = relative(exact, path).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) collect(join(path, name));
    } else if (stat.isFile()) {
      records.push({ path: local, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(path)) });
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = resolve(dirname(path), target);
      if (!isWithin(exact, resolvedTarget)) throw new Error(`Tree symlink ${local} escapes its root`);
      records.push({ path: local, type: "symlink", mode: stat.mode & 0o7777, target });
    } else throw new Error(`Tree contains unsupported entry ${local}`);
  };
  collect(exact);
  return sha256(Buffer.from(JSON.stringify(records)));
}

function exactFile(path: string, label: string): string {
  const exact = exactExistingPath(path, label);
  const stat = lstatSync(exact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return exact;
}

function exactDirectory(path: string, label: string): string {
  const exact = exactExistingPath(path, label);
  const stat = lstatSync(exact);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  return exact;
}

function exactExistingPath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || !existsSync(path)) {
    throw new Error(`${label} must be an exact, absolute, existing path`);
  }
  assertInternalStoragePath(path, label);
  return path;
}

function exactFuturePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be exact and absolute`);
  assertInternalStoragePath(path, label);
  return path;
}

function isWithin(root: string, path: string): boolean {
  return isAbsolute(root) && isAbsolute(path) && resolve(root) === root && resolve(path) === path
    && (path === root || path.startsWith(`${root}${sep}`));
}

function assertTransactionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("Invalid Codex source cutover transaction ID");
}

function atomicJsonWrite(file: string, value: unknown): void {
  atomicTextWrite(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function atomicTextWrite(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

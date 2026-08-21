/**
 * Production-only bindings for the schema-v2 sealed environment pair.
 *
 * This module deliberately owns adapters, not a second coordinator.  The
 * Environment coordinator supplies the one pre-confirmation builder and then
 * invokes these bindings through its default-off v2 seams.  Keeping the
 * low-level actions here makes it possible to prove that the enabled route
 * cannot accidentally call the schema-v1 coordinator methods.
 */
import { createHash } from "node:crypto";
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
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  observeCodexMainProcess,
  openAndActivateCodex,
  quitCodexMainProcess,
  type CodexMainProcessObservation,
} from "./alerts.js";
import { readHeaderHash } from "./asar.js";
import { bindVerifiedPreparedContentsExchange, readAsarMarker } from "./commands/install.js";
import { readConfigFile, updateConfigFile } from "./config.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import {
  assertEnvironmentModePairMaterialized,
  assertEnvironmentModePairWarmCommitMaterialized,
  assertEnvironmentModeCacheTreeStatSealOnly,
  assertEnvironmentModeCacheTreeStatSealAfterRename,
  compareEnvironmentModeCacheInvalidation,
  environmentModeCachePaths,
  finalizeEnvironmentModePairReceipt,
  isEnvironmentModeCacheTreeStatSeal,
  prepareOrReuseEnvironmentModePair,
  readCurrentEnvironmentModePair,
  releaseCurrentEnvironmentModePairBeforeCutover,
  sealEnvironmentModeCacheTree,
  type EnvironmentModeCacheInvalidationSnapshot,
  type EnvironmentModeCachePaths,
  type EnvironmentModeCacheTreeStatSeal,
  type EnvironmentModePairReceipt,
} from "./environment-mode-cache.js";
import {
  fingerprintAppContents,
  publishEnvironmentSelection,
  readEnvironmentProfileRegistry,
  validateOfficialEnvironmentProfile,
  type AppExperience,
  type EnvironmentSelection,
} from "./environment-profile.js";
import {
  captureEnvironmentModeCacheContentsIdentity,
  captureEnvironmentModeCacheOuterAppEvidence,
  environmentWarmCommitLiveTargetIdentity,
  type EnvironmentWarmCommitDeps,
  type EnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitExactTargetStopProof,
  type EnvironmentWarmCommitLiveTargetIdentity,
  type EnvironmentWarmCommitLiveTargetObservation,
  type EnvironmentWarmCommitLiveTargetProcess,
  type EnvironmentWarmCommitPreflight,
  type EnvironmentWarmCommitPreflightReady,
  type EnvironmentWarmCommitProjection,
  type EnvironmentWarmCommitSourceProjectionIdentity,
  type EnvironmentWarmCommitTargetProof,
} from "./environment-warm-commit.js";
import {
  type EnvironmentWarmRecoveryDeps,
  type EnvironmentWarmRecoveryOfficialAdoption,
  type EnvironmentWarmRecoveryOfficialUpdate,
} from "./environment-warm-recovery.js";
import { copyDirectoryPreservingModes } from "./fs-copy.js";
import { managedSourceRoot } from "./managed-runtime.js";
import { createMcpModeBridge, defaultMcpModeHelperFile, type McpModeBridge } from "./mcp-mode-bridge.js";
import { getOpenReport, listProcesses, type ProcessInfo } from "./commands/debug.js";
import { locateCodexAtExactPath } from "./platform.js";
import { readPlist } from "./plist.js";
import { readState, writeState } from "./state.js";
import { beginWatcherPromotion, finishWatcherPromotion } from "./watcher-promotion.js";
import {
  fingerprintDirectoryTree,
  type EnvironmentModeCacheV2PreparationResult,
  type PrepareEnvironmentModeCacheV2Input,
  type PreparedEnvironmentEvidence,
  type PreparedSwapHostEvidence,
} from "./environment-transaction.js";

export const ENVIRONMENT_MODE_V2_CONTROL_SCHEMA_VERSION = 1 as const;
export const ENVIRONMENT_MODE_V2_CONTROL_KIND = "environment-mode-v2-control" as const;
/** The one rollout flag. Missing, malformed, or untrusted config means off. */
export const ENVIRONMENT_MODE_CACHE_V2_FLAG = "environmentModeCacheV2" as const;

const CONTROL_FILE = "control-v2.json";
const PROJECTION_ROOT = "projection";
const MANAGED_CLI_RELATIVE_PATH = join("packages", "installer", "dist", "cli.js");
const SHA256 = /^[a-f0-9]{64}$/i;

type PreparedV2Evidence = PreparedEnvironmentEvidence & {
  runtime: NonNullable<PreparedEnvironmentEvidence["runtime"]>;
  managedRuntime: NonNullable<PreparedEnvironmentEvidence["managedRuntime"]>;
  swapHost: PreparedSwapHostEvidence;
};

/**
 * Durable, generation-bound helper and projection authority. It is written
 * while the generation is still in `next/`, then its byte digest is bound in
 * the published pair's invalidation evidence. No post-approval code trusts a
 * v1 receipt root or a current checkout to find the commit helper.
 */
export interface EnvironmentModeV2Control {
  schemaVersion: typeof ENVIRONMENT_MODE_V2_CONTROL_SCHEMA_VERSION;
  kind: typeof ENVIRONMENT_MODE_V2_CONTROL_KIND;
  generationId: string;
  preparedAt: string;
  source: EnvironmentSelection;
  requested: EnvironmentSelection;
  managedRuntime: {
    artifactDigest: string;
    runtimeFingerprint: string;
    fileCount: number;
    cliRelativePath: string;
    cliArtifactDigest: string;
  };
  runtime: {
    artifactDigest: string;
    runtimeFingerprint: string;
    fileCount: number;
  };
  backend: {
    lane: "bundled" | "managed-alpha";
    version: string;
    artifactDigest: string;
    targetPath: string;
    cacheRelativePath: string;
    projectionRelativePath: string;
  };
  nativeHost: {
    relativePath: string;
    digest: string;
    strict: boolean;
    designatedRequirement: string;
    teamIdentifier: string | null;
    authority: string[];
    certificateLeafHash: string | null;
  };
  projection: {
    runtimeRelativePath: string;
    managedRuntimeRelativePath: string;
    /** Complete stat-only seal for the pre-staged runtime projection. */
    runtimeStatSeal: EnvironmentModeCacheTreeStatSeal;
    /** Complete stat-only seal for the pre-staged managed-runtime projection. */
    managedRuntimeStatSeal: EnvironmentModeCacheTreeStatSeal;
  };
}

export interface EnvironmentModeV2PreparedCommitCli {
  transactionId: string;
  cliPath: string;
  cliArtifactDigest: string;
  managedRuntimeArtifactPath: string;
  managedRuntimeArtifactDigest: string;
  receiptFile: string;
}

export interface EnvironmentModeProductionOptions {
  environmentRoot: string;
  registryFile: string;
  selectionFile: string;
  configFile: string;
  stateFile: string;
  runtimeProofFile: string;
  mcpConfigFile: string;
  mcpStateFile: string;
  tweaksRoot: string;
  watcherPromotionFile: string;
  /** Exact runtime helper whose bytes are included in cache invalidation. */
  mcpModeHelperFile?: string;
  /** A direct low-level pre-confirmation builder; never a coordinator method. */
  preparePrerequisites(input: {
    transactionId: string;
    current: EnvironmentSelection;
    requested: EnvironmentSelection;
    oldMainPid: number | null;
  }): PreparedEnvironmentEvidence | Promise<PreparedEnvironmentEvidence>;
}

/**
 * Narrow test seams. The defaults are production adapters; tests must provide
 * disposable roots and can replace only the external process/MCP boundaries.
 */
export interface EnvironmentModeProductionDeps {
  now?: () => string;
  copyDirectory?: (source: string, destination: string) => void;
  copyFile?: (source: string, destination: string) => void;
  appFingerprint?: (appRoot: string) => string;
  directoryFingerprint?: (root: string) => string;
  fileFingerprint?: (file: string) => string;
  readHeader?: (appRoot: string) => string;
  observeDesktop?: (appRoot: string) => CodexMainProcessObservation | null;
  quitDesktop?: (appRoot: string, pid: number) => void;
  reopenDesktop?: (appRoot: string) => void;
  relatedPids?: (appRoot: string) => number[];
  listProcesses?: () => ProcessInfo[];
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  mcpBridge?: McpModeBridge;
  validateOfficial?: (selection: EnvironmentSelection) => void;
  bindExchange?: (
    liveContents: string,
    inactiveContents: string,
    swapHost: PreparedSwapHostEvidence,
  ) => (first: string, second: string) => void;
  beginWatcher?: typeof beginWatcherPromotion;
  finishWatcher?: typeof finishWatcherPromotion;
  publishSelection?: (selection: EnvironmentSelection) => void;
  /** Recovery must inject a real newer-official oracle; missing oracle fails closed. */
  checkForVerifiedNewerOfficial?: (input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
    control: EnvironmentModeV2Control;
    source: EnvironmentWarmCommitSourceProjectionIdentity;
  }) => EnvironmentWarmRecoveryOfficialUpdate | Promise<EnvironmentWarmRecoveryOfficialUpdate>;
  adoptVerifiedNewerOfficial?: (input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
    control: EnvironmentModeV2Control;
    update: EnvironmentWarmRecoveryOfficialUpdate;
  }) => EnvironmentWarmRecoveryOfficialAdoption | Promise<EnvironmentWarmRecoveryOfficialAdoption>;
}

export interface EnvironmentModeProductionBindings {
  prepare(input: PrepareEnvironmentModeCacheV2Input): Promise<EnvironmentModeCacheV2PreparationResult>;
  cancel(input: { transactionId: string; cancelledAt?: string }): EnvironmentModePairReceipt;
  resolvePreparedCommitCli(transactionId: string): EnvironmentModeV2PreparedCommitCli;
  warmCommit: EnvironmentWarmCommitDeps;
  warmRecovery: EnvironmentWarmRecoveryDeps;
}

/** Read the single explicit, default-off rollout flag without creating state. */
export function environmentModeCacheV2Enabled(configFile: string): boolean {
  const config = readConfigFile(configFile);
  const section = config.tweaker;
  return section !== null
    && typeof section === "object"
    && !Array.isArray(section)
    && (section as Record<string, unknown>)[ENVIRONMENT_MODE_CACHE_V2_FLAG] === true;
}

/** Create all real v2 adapters used by the single Environment coordinator. */
export function createEnvironmentModeProductionBindings(
  options: EnvironmentModeProductionOptions,
  dependencies: EnvironmentModeProductionDeps = {},
): EnvironmentModeProductionBindings {
  assertProductionOptions(options);
  const paths = environmentModeCachePaths(options.environmentRoot);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const copyDirectory = dependencies.copyDirectory ?? copyDirectoryExactly;
  const copyFile = dependencies.copyFile ?? copyFileExactly;
  const appFingerprint = dependencies.appFingerprint ?? fingerprintAppContents;
  // Artifact validation must use the builder's digest. Cache stat/content
  // seals are separate evidence and are intentionally not interchangeable.
  const directoryFingerprint = dependencies.directoryFingerprint ?? fingerprintDirectoryTree;
  const fileFingerprint = dependencies.fileFingerprint ?? sha256File;
  const readHeader = dependencies.readHeader ?? ((appRoot) => (
    readHeaderHash(join(appRoot, "Contents", "Resources", "app.asar")).headerHash
  ));
  const observeDesktop = dependencies.observeDesktop ?? observeCodexMainProcess;
  const quitDesktop = dependencies.quitDesktop ?? quitCodexMainProcess;
  const reopenDesktop = dependencies.reopenDesktop ?? ((appRoot) => { openAndActivateCodex(appRoot); });
  const relatedPids = dependencies.relatedPids ?? ((appRoot) => (
    getOpenReport(locateCodexAtExactPath(appRoot)).relatedPids
  ));
  const inspectProcesses = dependencies.listProcesses ?? listProcesses;
  const signalProcess = dependencies.signalProcess ?? ((pid: number, signal: NodeJS.Signals) => {
    process.kill(pid, signal);
  });
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const mcp = dependencies.mcpBridge ?? createMcpModeBridge({
    ...(options.mcpModeHelperFile ? { helperFile: options.mcpModeHelperFile } : {}),
    configPath: options.mcpConfigFile,
    statePath: options.mcpStateFile,
    tweaksRoot: options.tweaksRoot,
    tweakersConfigPath: options.configFile,
  });
  const validateOfficial = dependencies.validateOfficial ?? ((selection) => {
    validateOfficialEnvironmentProfile(selection);
  });
  const beginWatcher = dependencies.beginWatcher ?? beginWatcherPromotion;
  const finishWatcher = dependencies.finishWatcher ?? finishWatcherPromotion;
  const publishSelection = dependencies.publishSelection ?? ((selection) => {
    publishEnvironmentSelection(options.registryFile, options.selectionFile, selection);
  });

  const readControl = (pair: EnvironmentModePairReceipt): EnvironmentModeV2Control => (
    readEnvironmentModeV2Control(pair, fileFingerprint)
  );
  const controlPath = (root: string): string => join(root, CONTROL_FILE);

  const prepare = async (
    input: PrepareEnvironmentModeCacheV2Input,
  ): Promise<EnvironmentModeCacheV2PreparationResult> => {
    assertModePairInput(input);
    let prepared: PreparedV2Evidence | null = null;
    let control: EnvironmentModeV2Control | null = null;
    const result = await prepareOrReuseEnvironmentModePair(paths, input.generationId, {
      stage: async ({ preparation }) => {
        // The builder receives a cache-owned ephemeral receipt root. It may
        // build/clone only here, before approval, and cannot reach the v1
        // transaction file or coordinator commit path.
        const built = await options.preparePrerequisites({
          // This is the durable cache generation identity. Reusing a constant
          // would let a later/superseding prepare collide in the low-level
          // builder's receipt root even though pair publication is serialized.
          transactionId: input.generationId,
          current: input.current,
          requested: input.requested,
          oldMainPid: null,
        });
        const evidence = requirePreparedV2Evidence(built, input);
        prepared = evidence;
        copyDirectory(evidence.candidate.artifactPath, preparation.inactiveAppPath);
        copyDirectory(evidence.runtime.requested.artifactPath, preparation.runtimeRoot);
        copyDirectory(evidence.managedRuntime.requested.artifactPath, preparation.managedRuntimeRoot);
        const backendPath = join(preparation.generationRoot, "backend", "codex");
        copyFile(evidence.backend.artifactPath, backendPath);
        const nativeHostPath = join(preparation.generationRoot, "native", "tweaker_native_host.node");
        copyFile(evidence.swapHost.path, nativeHostPath);
        // Projection slots are copied now, not after confirmation. Commit
        // later promotes these exact staged directories by rename only.
        copyDirectory(preparation.runtimeRoot, join(preparation.generationRoot, PROJECTION_ROOT, "runtime"));
        copyDirectory(
          preparation.managedRuntimeRoot,
          join(preparation.generationRoot, PROJECTION_ROOT, "managed-runtime"),
        );
        copyFile(backendPath, join(preparation.generationRoot, PROJECTION_ROOT, "backend", "codex"));
        control = createEnvironmentModeV2Control({
          generationId: input.generationId,
          generationRoot: preparation.generationRoot,
          preparedAt: evidence.preparedAt,
          source: input.current,
          requested: input.requested,
          prepared: evidence,
        });
        writeJsonAtomically(controlPath(preparation.generationRoot), control);
      },
      validatePrepared: ({ preparation }) => {
        if (prepared === null || control === null) throw new Error("v2 preparation did not retain staged evidence");
        validateStagedEnvironmentModePair({
          preparation,
          input,
          prepared,
          control,
          appFingerprint,
          directoryFingerprint,
          fileFingerprint,
          readHeader,
          validateOfficial,
        });
      },
      createValidatedReceipt: ({ generation }) => {
        if (prepared === null || control === null) throw new Error("v2 generation promotion lost staged evidence");
        const stagedControl = readEnvironmentModeV2ControlAt(controlPath(generation.generationRoot), fileFingerprint);
        if (!sameJson(stagedControl, control)) throw new Error("v2 generation control receipt changed during promotion");
        const promotedControl = rebaseEnvironmentModeV2ControlProjectionSeals(stagedControl, generation.generationRoot);
        writeJsonAtomically(controlPath(generation.generationRoot), promotedControl);
        const finalControl = readEnvironmentModeV2ControlAt(controlPath(generation.generationRoot), fileFingerprint);
        if (!sameJson(finalControl, promotedControl)) {
          throw new Error("v2 generation control receipt changed while binding promoted projection seals");
        }
        return createValidatedEnvironmentModePairReceipt({
          paths,
          generation,
          input,
          prepared,
          control: finalControl,
          now: now(),
          appFingerprint,
          directoryFingerprint,
          fileFingerprint,
          readHeader,
          validateOfficial,
          mcpHelperDigest: mcpHelperDigest(mcp, options.mcpModeHelperFile ?? defaultMcpModeHelperFile()),
        });
      },
      inspectInvalidation: (pair) => fullEnvironmentModeV2InvalidationSnapshot({
        pair,
        control: readControl(pair),
        options,
        appFingerprint,
        directoryFingerprint,
        fileFingerprint,
        readHeader,
        validateOfficial,
        mcpHelperDigest: mcpHelperDigest(mcp, options.mcpModeHelperFile ?? defaultMcpModeHelperFile()),
      }),
    }, { now });
    return { state: "ready", receipt: result.receipt };
  };

  const cancel = (input: { transactionId: string; cancelledAt?: string }): EnvironmentModePairReceipt => {
    const pair = requireCurrentGeneration(paths, input.transactionId);
    // Read the durable control before releasing the grant. A guessed generation
    // ID must never release a different prepared pair.
    readControl(pair);
    return releaseCurrentEnvironmentModePairBeforeCutover(
      paths,
      input.transactionId,
      input.cancelledAt ?? now(),
      "cancelled",
    );
  };

  const resolvePreparedCommitCli = (transactionId: string): EnvironmentModeV2PreparedCommitCli => {
    const pair = requireCurrentGeneration(paths, transactionId);
    if (pair.pin.state !== "prepared" || pair.pin.releasedAt !== null) {
      throw new Error(`Environment mode v2 generation ${transactionId} is not an active prepared grant`);
    }
    const control = readControl(pair);
    const cliPath = resolveControlledPath(pair.paths.managedRuntimeRoot, control.managedRuntime.cliRelativePath);
    if (fileFingerprint(cliPath) !== control.managedRuntime.cliArtifactDigest) {
      throw new Error("Environment mode v2 helper CLI changed after preparation");
    }
    if (control.managedRuntime.artifactDigest !== pair.tweakers.managedRuntime.digest) {
      throw new Error("Environment mode v2 helper control does not bind the cached managed runtime");
    }
    return {
      transactionId,
      cliPath,
      cliArtifactDigest: control.managedRuntime.cliArtifactDigest,
      managedRuntimeArtifactPath: pair.paths.managedRuntimeRoot,
      managedRuntimeArtifactDigest: pair.tweakers.managedRuntime.digest,
      receiptFile: join(pair.paths.generationRoot, "commit-helper.json"),
    };
  };

  const assertBoundedPairBase = (pair: EnvironmentModePairReceipt): EnvironmentModeV2Control => {
    assertEnvironmentModePairWarmCommitMaterialized(paths, pair);
    const control = readControl(pair);
    if (pair.invalidation.environment.lifecycleJournalDigest !== fileFingerprint(controlPath(pair.paths.generationRoot))) {
      throw new Error("Environment mode v2 control receipt digest changed");
    }
    assertBoundedRoleIdentity(pair.roles.live, readHeader, fileFingerprint);
    assertBoundedRoleIdentity(pair.roles.inactive, readHeader, fileFingerprint);
    assertBoundedCachedArtifactIdentity(pair, control, fileFingerprint);
    return control;
  };

  const assertBoundedPair = (pair: EnvironmentModePairReceipt): EnvironmentModeV2Control => {
    const control = assertBoundedPairBase(pair);
    assertBoundedProjectionIdentity(pair, control, fileFingerprint, options.environmentRoot);
    return control;
  };

  const preflight = (pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflight => {
    try {
      assertBoundedPair(pair);
      const source = observeDesktop(pair.roles.live.appPath);
      if (source === null || !source.visibleWindow) {
        return { state: "stale_requires_prepare", reason: "exact source process with visible window is absent" };
      }
      const target = pair.roles.inactive;
      return {
        state: "ready",
        source: { appPath: pair.roles.live.appPath, pid: source.pid, visibleWindow: source.visibleWindow },
        target: environmentModeWarmCommitTargetIdentity(pair, target),
        exchangeBefore: exchangeBefore(pair),
      };
    } catch (error) {
      return { state: "stale_requires_prepare", reason: errorMessage(error) };
    }
  };

  const classifyStaleBeforeCutover = (pair: EnvironmentModePairReceipt, boundedReason: string): readonly string[] => {
    const reasons = [boundedReason];
    try {
      // This is intentionally the *only* full tree validation reachable from
      // the warm path. The caller invokes it only before watcher pause/quit.
      assertEnvironmentModePairMaterialized(paths, pair);
      const control = readControl(pair);
      const observed = fullEnvironmentModeV2InvalidationSnapshot({
        pair,
        control,
        options,
        appFingerprint,
        directoryFingerprint,
        fileFingerprint,
        readHeader,
        validateOfficial,
        mcpHelperDigest: mcpHelperDigest(mcp, options.mcpModeHelperFile ?? defaultMcpModeHelperFile()),
      });
      reasons.push(...compareEnvironmentModeCacheInvalidation(pair.invalidation, observed));
    } catch (error) {
      reasons.push(`full-validator: ${errorMessage(error)}`);
    }
    return [...new Set(reasons)];
  };

  const processIdentity = (entry: ProcessInfo): string => (
    `${entry.pid}\0${entry.startedAtRaw ?? ""}\0${entry.command}`
  );

  const stopExact = async (appPath: string, pid: number): Promise<void> => {
    const capturedRelatedPids = new Set(relatedPids(appPath).filter((relatedPid) => relatedPid !== pid));
    const capturedHelpers = inspectProcesses().filter((entry) => capturedRelatedPids.has(entry.pid));

    await quitDesktop(appPath, pid);
    const current = observeDesktop(appPath);
    if (current !== null) throw new Error(`Exact main PID ${pid} is still present at ${appPath}`);

    const remainingCapturedHelpers = (): ProcessInfo[] => {
      const currentByIdentity = new Map(inspectProcesses().map((entry) => [processIdentity(entry), entry]));
      return capturedHelpers.filter((entry) => currentByIdentity.has(processIdentity(entry)));
    };
    const signalCapturedHelpers = (entries: readonly ProcessInfo[], signal: NodeJS.Signals): void => {
      for (const entry of entries) {
        try { signalProcess(entry.pid, signal); } catch { /* exact helper already exited */ }
      }
    };
    const waitForCapturedHelpers = async (timeoutMs: number): Promise<ProcessInfo[]> => {
      const deadline = Date.now() + timeoutMs;
      let remaining = remainingCapturedHelpers();
      while (remaining.length > 0 && Date.now() < deadline) {
        await sleep(100);
        remaining = remainingCapturedHelpers();
      }
      return remaining;
    };

    signalCapturedHelpers(remainingCapturedHelpers(), "SIGTERM");
    let remaining = await waitForCapturedHelpers(2_000);
    signalCapturedHelpers(remaining, "SIGKILL");
    remaining = await waitForCapturedHelpers(1_000);
    if (remaining.length > 0) {
      throw new Error(`Exact captured helpers did not stop at ${appPath}: ${remaining.map((entry) => entry.pid).join(", ")}`);
    }

    const helpers = relatedPids(appPath);
    if (helpers.length > 0) {
      throw new Error(`Exact helper quiescence is not proven at ${appPath}: ${helpers.join(", ")}`);
    }
  };

  const observeExactLiveTarget = (input: {
    pair: EnvironmentModePairReceipt;
    expected: EnvironmentWarmCommitLiveTargetIdentity;
    recordedMainPid: number | null;
  }): EnvironmentWarmCommitLiveTargetObservation => {
    // Post-launch recovery must not reuse the pre-launch whole-tree/projection
    // seal. Bind the exact live app cryptographically here; runtime/MCP proof
    // remains the separate target-readiness gate.
    const control = readControl(input.pair);
    assertBoundedRoleIdentity(input.pair.roles.live, readHeader, fileFingerprint);
    assertBoundedCachedArtifactIdentity(input.pair, control, fileFingerprint);
    const observation = observeDesktop(input.expected.appPath);
    if (observation === null) {
      if (relatedPids(input.expected.appPath).length > 0) {
        throw new Error("Warm target has helpers but no exact main PID; inverse exchange is prohibited");
      }
      return { state: "absent" };
    }
    if (input.recordedMainPid !== null && observation.pid === input.recordedMainPid) {
      throw new Error("Warm target observation reused the recorded source PID");
    }
    const live = input.pair.roles.live;
    assertBoundedRoleIdentity(live, readHeader, fileFingerprint);
    const expected = input.expected;
    const actual: EnvironmentWarmCommitLiveTargetProcess = {
      ...expected,
      pid: observation.pid,
      visibleWindow: observation.visibleWindow,
    };
    return { state: "exact", process: actual };
  };

  const stopExactLiveTarget = async (input: {
    pair: EnvironmentModePairReceipt;
    expected: EnvironmentWarmCommitLiveTargetIdentity;
    process: EnvironmentWarmCommitLiveTargetProcess | null;
  }): Promise<EnvironmentWarmCommitExactTargetStopProof> => {
    if (input.process !== null) await stopExact(input.expected.appPath, input.process.pid);
    else if (relatedPids(input.expected.appPath).length > 0) {
      throw new Error("Warm target helpers are present without an exact target PID");
    }
    return {
      pid: input.process?.pid ?? null,
      appPath: input.expected.appPath,
      processStopped: true,
      helpersStopped: true,
    };
  };

  const exchangeContents = (first: string, second: string): void => {
    const pair = readCurrentEnvironmentModePair(paths);
    if (pair === null) throw new Error("Environment mode v2 exchange has no current pair");
    const control = readControl(pair);
    const nativeHost = controlNativeHost(pair, control);
    const bound = dependencies.bindExchange
      ? dependencies.bindExchange(first, second, nativeHost)
      : bindVerifiedPreparedContentsExchange(first, second, nativeHost);
    bound(first, second);
  };

  const projectTarget = (pair: EnvironmentModePairReceipt): EnvironmentWarmCommitProjection => {
    const control = readControl(pair);
    const target = selectionForExperience(control, pair.roles.live.experience);
    if (target.selectedDesktopPath !== pair.roles.live.appPath) {
      throw new Error("Environment mode v2 target selection does not bind the live outer app path");
    }
    const restoration: Array<() => void> = [];
    try {
      if (target.appExperience === "tweakers") {
        const stagedRuntime = resolveControlledPath(pair.paths.generationRoot, control.projection.runtimeRelativePath);
        const activeRuntime = join(options.environmentRoot, "runtime");
        if (existsSync(stagedRuntime)) {
          restoration.push(promotePreparedDirectory(stagedRuntime, activeRuntime));
        } else {
          assertEnvironmentModeV2ProjectionTree(stagedRuntime, activeRuntime, control.projection.runtimeStatSeal);
        }
        const stagedManagedRuntime = resolveControlledPath(
          pair.paths.generationRoot,
          control.projection.managedRuntimeRelativePath,
        );
        const activeManagedRuntime = managedSourceRoot(options.environmentRoot);
        if (existsSync(stagedManagedRuntime)) {
          restoration.push(promotePreparedDirectory(stagedManagedRuntime, activeManagedRuntime));
        } else {
          assertEnvironmentModeV2ProjectionTree(
            stagedManagedRuntime,
            activeManagedRuntime,
            control.projection.managedRuntimeStatSeal,
          );
        }
        if (control.backend.lane === "managed-alpha") {
          const stagedBackend = resolveControlledPath(pair.paths.generationRoot, control.backend.projectionRelativePath);
          if (existsSync(stagedBackend)) {
            restoration.push(promotePreparedFile(stagedBackend, control.backend.targetPath));
          } else if (fileFingerprint(control.backend.targetPath) !== control.backend.artifactDigest) {
            throw new Error("Environment mode v2 activated backend projection changed before target reopen");
          }
        }
      }
      const restoreState = snapshotSmallFile(options.stateFile);
      const restoreConfig = snapshotSmallFile(options.configFile);
      restoration.push(restoreConfig, restoreState);
      writeProjectionConfig(options.configFile, target, control);
      writeProjectionState(options.stateFile, target, pair.roles.live);
      mcp.reconcile(target.appExperience);
      return {
        selection: { ...target, appliedAt: null },
        targetExpectedFingerprint: pair.roles.live.evidence.appDigest,
        restore: () => {
          // The warm implementation first performs its exact inverse exchange;
          // restoration then rebuilds the source projection from its durable
          // selection and returns the small state/config bytes exactly.
          for (const restore of [...restoration].reverse()) restore();
          mcp.reconcile(selectionForExperience(control, pair.roles.inactive.experience).appExperience);
        },
      };
    } catch (error) {
      for (const restore of [...restoration].reverse()) {
        try { restore(); } catch {}
      }
      throw error;
    }
  };

  const proveTarget = async (input: {
    pair: EnvironmentModePairReceipt;
    oldMainPid: number;
    projection: EnvironmentWarmCommitProjection;
  }): Promise<EnvironmentWarmCommitTargetProof> => {
    const process = await waitForFreshVisibleProcess(
      input.pair.roles.live.appPath,
      input.oldMainPid,
      observeDesktop,
      sleep,
    );
    assertBoundedPair(input.pair);
    const target = input.projection.selection;
    assertTargetProjection({
      pair: input.pair,
      target,
      pid: process.pid,
      stateFile: options.stateFile,
      runtimeProofFile: options.runtimeProofFile,
      configFile: options.configFile,
      control: readControl(input.pair),
      fileFingerprint,
      mcp,
    });
    return targetProof(input.pair, target, process.pid, process.visibleWindow, readHeader, fileFingerprint);
  };

  const bindWatcherTarget = (input: {
    pair: EnvironmentModePairReceipt;
    proof: EnvironmentWarmCommitTargetProof;
    targetExpectedFingerprint: string;
  }): void => {
    if (input.proof.desktopArtifactDigest !== input.targetExpectedFingerprint
      || input.targetExpectedFingerprint !== input.pair.roles.live.evidence.appDigest) {
      throw new Error("Environment mode v2 watcher target proof is not bound to the sealed live app");
    }
    // State was projected before reopen; re-read the fixed ASAR identity before
    // the durable watcher receipt is resumed.
    assertBoundedRoleIdentity(input.pair.roles.live, readHeader, fileFingerprint);
  };

  const warmCommit: EnvironmentWarmCommitDeps = {
    now,
    preflight,
    classifyStaleBeforeCutover,
    pauseWatcher: (input) => { beginWatcher(options.watcherPromotionFile, {
      transactionId: input.transactionId,
      sourceAppRoot: input.sourceAppRoot,
      requestedAppRoot: input.targetAppRoot,
      sourceExpectedFingerprint: input.sourceExpectedFingerprint,
    }); },
    stopExactSource: (input) => stopExact(input.appPath, input.pid),
    observeExactLiveTarget,
    stopExactLiveTarget,
    recheckSourceAfterShutdown: (pair) => { assertBoundedPair(pair); },
    exchangeContents,
    captureExchangeProof: ({ pair, before }) => ({
      ...before,
      liveContentsAfter: captureEnvironmentModeCacheContentsIdentity(join(pair.roles.live.appPath, "Contents")),
      inactiveContentsAfter: captureEnvironmentModeCacheContentsIdentity(join(pair.paths.inactiveAppPath, "Contents")),
      liveOuterAfter: captureEnvironmentModeCacheOuterAppEvidence(pair.roles.live.appPath),
      inactiveOuterAfter: captureEnvironmentModeCacheOuterAppEvidence(pair.paths.inactiveAppPath),
    }),
    projectTarget,
    reopenTarget: reopenDesktop,
    proveTarget,
    bindWatcherTarget,
    publishSelection,
    resumeWatcher: (input) => { finishWatcher(options.watcherPromotionFile, input); },
  };

  const restoreSource = (input: {
    pair: EnvironmentModePairReceipt;
    source: EnvironmentWarmCommitSourceProjectionIdentity;
  }): EnvironmentWarmCommitProjection => {
    const control = readControl(input.pair);
    const sourceSelection = selectionForExperience(control, input.source.appExperience);
    if (sourceSelection.selectedDesktopPath !== input.pair.roles.live.appPath) {
      throw new Error("Environment mode v2 recovery source selection is not at the live path");
    }
    writeProjectionConfig(options.configFile, sourceSelection, control);
    writeProjectionState(options.stateFile, sourceSelection, input.pair.roles.live);
    mcp.reconcile(sourceSelection.appExperience);
    return {
      selection: { ...sourceSelection, appliedAt: null },
      targetExpectedFingerprint: input.pair.roles.live.evidence.appDigest,
      restore: () => {},
    };
  };

  const proveRecovered = (pair: EnvironmentModePairReceipt, selection: EnvironmentSelection): EnvironmentWarmCommitTargetProof | null => {
    const observed = observeDesktop(pair.roles.live.appPath);
    if (observed === null || !observed.visibleWindow) return null;
    try {
      const control = selection.appExperience === "tweakers"
        ? assertBoundedPair(pair)
        : assertBoundedPairBase(pair);
      assertTargetProjection({
        pair,
        target: selection,
        pid: observed.pid,
        stateFile: options.stateFile,
        runtimeProofFile: options.runtimeProofFile,
        configFile: options.configFile,
        control,
        fileFingerprint,
        mcp,
      });
      return targetProof(pair, selection, observed.pid, observed.visibleWindow, readHeader, fileFingerprint);
    } catch {
      return null;
    }
  };

  const recoveryCheckOfficial = dependencies.checkForVerifiedNewerOfficial ?? (() => {
    throw new Error("Environment mode v2 recovery requires a bound verified-official updater oracle");
  });
  const recoveryAdoptOfficial = dependencies.adoptVerifiedNewerOfficial ?? ((input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
    control: EnvironmentModeV2Control;
    update: EnvironmentWarmRecoveryOfficialUpdate;
  }) => {
    throw new Error(
      `Environment mode v2 requires a verified-official adoption adapter for generation ${input.pair.generationId}`,
    );
  });
  const warmRecovery: EnvironmentWarmRecoveryDeps = {
    now,
    pauseWatcher: (input) => { beginWatcher(options.watcherPromotionFile, {
      transactionId: input.transactionId,
      sourceAppRoot: input.sourceAppRoot,
      requestedAppRoot: input.targetAppRoot,
      sourceExpectedFingerprint: input.sourceExpectedFingerprint,
    }); },
    observeExactLiveTarget,
    stopExactLiveTarget,
    checkForVerifiedNewerOfficial: ({ pair, journal }) => recoveryCheckOfficial({
      pair,
      journal,
      control: readControl(pair),
      source: requireSourceProjection(journal.sourceProjection),
    }),
    adoptVerifiedNewerOfficial: ({ pair, journal, update }) => recoveryAdoptOfficial({
      pair,
      journal,
      control: readControl(pair),
      update,
    }),
    captureExchangeBefore: (pair) => exchangeBefore(pair),
    captureExchangeProof: ({ pair, before }) => ({
      liveContentsAfter: captureEnvironmentModeCacheContentsIdentity(join(pair.roles.live.appPath, "Contents")),
      inactiveContentsAfter: captureEnvironmentModeCacheContentsIdentity(join(pair.paths.inactiveAppPath, "Contents")),
      liveOuterAfter: captureEnvironmentModeCacheOuterAppEvidence(pair.roles.live.appPath),
      inactiveOuterAfter: captureEnvironmentModeCacheOuterAppEvidence(pair.paths.inactiveAppPath),
    }),
    exchangeContents,
    restoreSource: ({ pair, source }) => restoreSource({ pair, source }),
    observeSource: ({ pair, projection }) => proveRecovered(pair, projection.selection),
    reopenSource: reopenDesktop,
    proveSource: ({ pair, projection }) => proveRecovered(pair, projection.selection),
    proveTarget: ({ pair }) => proveRecovered(pair, selectionForExperience(readControl(pair), pair.roles.live.experience)),
    bindWatcherTarget,
    publishSelection,
    resumeWatcher: (input) => { finishWatcher(options.watcherPromotionFile, input); },
  };

  return { prepare, cancel, resolvePreparedCommitCli, warmCommit, warmRecovery };
}

export function resolveEnvironmentModeV2PreparedCommitCli(
  environmentRoot: string,
  transactionId: string,
  fileFingerprint: (file: string) => string = sha256File,
): EnvironmentModeV2PreparedCommitCli {
  const paths = environmentModeCachePaths(environmentRoot);
  const pair = requireCurrentGeneration(paths, transactionId);
  if (pair.pin.state !== "prepared" || pair.pin.releasedAt !== null) {
    throw new Error(`Environment mode v2 generation ${transactionId} is not an active prepared grant`);
  }
  const control = readEnvironmentModeV2Control(pair, fileFingerprint);
  const cliPath = resolveControlledPath(pair.paths.managedRuntimeRoot, control.managedRuntime.cliRelativePath);
  if (fileFingerprint(cliPath) !== control.managedRuntime.cliArtifactDigest) {
    throw new Error("Environment mode v2 helper CLI changed after preparation");
  }
  return {
    transactionId,
    cliPath,
    cliArtifactDigest: control.managedRuntime.cliArtifactDigest,
    managedRuntimeArtifactPath: pair.paths.managedRuntimeRoot,
    managedRuntimeArtifactDigest: pair.tweakers.managedRuntime.digest,
    receiptFile: join(pair.paths.generationRoot, "commit-helper.json"),
  };
}

export function readEnvironmentModeV2Control(
  pair: EnvironmentModePairReceipt,
  fileFingerprint: (file: string) => string = sha256File,
): EnvironmentModeV2Control {
  const file = join(pair.paths.generationRoot, CONTROL_FILE);
  if (pair.invalidation.environment.lifecycleJournalDigest !== fileFingerprint(file)) {
    throw new Error("Environment mode v2 control receipt digest does not match the pair receipt");
  }
  const control = readEnvironmentModeV2ControlAt(file, fileFingerprint);
  if (control.generationId !== pair.generationId
    || control.managedRuntime.artifactDigest !== pair.tweakers.managedRuntime.digest
    || control.runtime.artifactDigest !== pair.tweakers.runtime.digest
    || control.backend.artifactDigest !== pair.tweakers.backend.digest
    || control.nativeHost.digest !== pair.tweakers.nativeHost.digest) {
    throw new Error("Environment mode v2 control receipt is not bound to the current pair");
  }
  if (control.projection.runtimeStatSeal.rootPath
      !== resolveControlledPath(pair.paths.generationRoot, control.projection.runtimeRelativePath)
    || control.projection.managedRuntimeStatSeal.rootPath
      !== resolveControlledPath(pair.paths.generationRoot, control.projection.managedRuntimeRelativePath)) {
    throw new Error("Environment mode v2 projection stat seals are not bound to the current generation");
  }
  return control;
}

function createEnvironmentModeV2Control(input: {
  generationId: string;
  generationRoot: string;
  preparedAt: string;
  source: EnvironmentSelection;
  requested: EnvironmentSelection;
  prepared: PreparedEnvironmentEvidence & {
    runtime: NonNullable<PreparedEnvironmentEvidence["runtime"]>;
    managedRuntime: NonNullable<PreparedEnvironmentEvidence["managedRuntime"]>;
    swapHost: PreparedSwapHostEvidence;
  };
}): EnvironmentModeV2Control {
  const managed = input.prepared.managedRuntime.requested;
  if (!managed.cliPath || !managed.cliArtifactDigest) {
    throw new Error("Environment mode v2 managed runtime lacks its CLI control evidence");
  }
  const relativeCli = relative(input.prepared.managedRuntime.requested.artifactPath, managed.cliPath);
  if (relativeCli !== MANAGED_CLI_RELATIVE_PATH || relativeCli.startsWith("..")) {
    throw new Error("Environment mode v2 managed CLI path is not canonical");
  }
  return {
    schemaVersion: ENVIRONMENT_MODE_V2_CONTROL_SCHEMA_VERSION,
    kind: ENVIRONMENT_MODE_V2_CONTROL_KIND,
    generationId: input.generationId,
    preparedAt: input.preparedAt,
    source: input.source,
    requested: input.requested,
    managedRuntime: {
      artifactDigest: managed.artifactDigest,
      runtimeFingerprint: managed.runtimeFingerprint,
      fileCount: managed.fileCount,
      cliRelativePath: relativeCli,
      cliArtifactDigest: managed.cliArtifactDigest,
    },
    runtime: {
      artifactDigest: input.prepared.runtime.requested.artifactDigest,
      runtimeFingerprint: input.prepared.runtime.requested.runtimeFingerprint,
      fileCount: input.prepared.runtime.requested.fileCount,
    },
    backend: {
      lane: input.prepared.backend.lane === "managed-alpha" ? "managed-alpha" : "bundled",
      version: input.prepared.backend.version,
      artifactDigest: input.prepared.backend.artifactDigest,
      targetPath: input.prepared.backend.binaryPath,
      cacheRelativePath: join("backend", "codex"),
      projectionRelativePath: join(PROJECTION_ROOT, "backend", "codex"),
    },
    nativeHost: {
      relativePath: join("native", "tweaker_native_host.node"),
      digest: input.prepared.swapHost.digest,
      strict: input.prepared.swapHost.strict,
      designatedRequirement: input.prepared.swapHost.designatedRequirement,
      teamIdentifier: input.prepared.swapHost.teamIdentifier,
      authority: [...input.prepared.swapHost.authority],
      certificateLeafHash: input.prepared.swapHost.certificateLeafHash,
    },
    projection: {
      runtimeRelativePath: join(PROJECTION_ROOT, "runtime"),
      managedRuntimeRelativePath: join(PROJECTION_ROOT, "managed-runtime"),
      runtimeStatSeal: sealEnvironmentModeCacheTree(join(input.generationRoot, PROJECTION_ROOT, "runtime")),
      managedRuntimeStatSeal: sealEnvironmentModeCacheTree(
        join(input.generationRoot, PROJECTION_ROOT, "managed-runtime"),
      ),
    },
  };
}

/**
 * `next/<generation>` is atomically renamed to `generations/<generation>`.
 * Rename preserves every inode/stat tuple, so only the absolute seal root is
 * re-bound here; the ordered stat and content evidence is never regenerated.
 */
function rebaseEnvironmentModeV2ControlProjectionSeals(
  control: EnvironmentModeV2Control,
  generationRoot: string,
): EnvironmentModeV2Control {
  const runtimePath = resolveControlledPath(generationRoot, control.projection.runtimeRelativePath);
  const managedRuntimePath = resolveControlledPath(
    generationRoot,
    control.projection.managedRuntimeRelativePath,
  );
  return {
    ...control,
    projection: {
      ...control.projection,
      runtimeStatSeal: rebaseEnvironmentModeV2ProjectionSeal(
        control.projection.runtimeStatSeal,
        runtimePath,
      ),
      managedRuntimeStatSeal: rebaseEnvironmentModeV2ProjectionSeal(
        control.projection.managedRuntimeStatSeal,
        managedRuntimePath,
      ),
    },
  };
}

function rebaseEnvironmentModeV2ProjectionSeal(
  seal: EnvironmentModeCacheTreeStatSeal,
  rootPath: string,
): EnvironmentModeCacheTreeStatSeal {
  if (!isEnvironmentModeCacheTreeStatSeal(seal) || !exactAbsolutePath(rootPath)) {
    throw new Error("Environment mode v2 projection stat seal cannot be rebound");
  }
  return { ...seal, rootPath };
}

function requirePreparedV2Evidence(
  prepared: PreparedEnvironmentEvidence | null,
  input: PrepareEnvironmentModeCacheV2Input,
): PreparedEnvironmentEvidence & {
  runtime: NonNullable<PreparedEnvironmentEvidence["runtime"]>;
  managedRuntime: NonNullable<PreparedEnvironmentEvidence["managedRuntime"]>;
  swapHost: PreparedSwapHostEvidence;
} {
  if (prepared === null || !prepared.runtime || !prepared.managedRuntime || !prepared.swapHost) {
    throw new Error("Environment mode v2 requires prepared runtime, managed runtime, and verified native exchange evidence");
  }
  if (prepared.candidate.appExperience !== input.requested.appExperience
    || prepared.rollback.selection.appExperience !== input.current.appExperience) {
    throw new Error("Environment mode v2 prepared evidence does not bind the requested source and target experiences");
  }
  return prepared as PreparedEnvironmentEvidence & {
    runtime: NonNullable<PreparedEnvironmentEvidence["runtime"]>;
    managedRuntime: NonNullable<PreparedEnvironmentEvidence["managedRuntime"]>;
    swapHost: PreparedSwapHostEvidence;
  };
}

function validateStagedEnvironmentModePair(input: {
  preparation: { generationRoot: string; inactiveAppPath: string; runtimeRoot: string; managedRuntimeRoot: string };
  input: PrepareEnvironmentModeCacheV2Input;
  prepared: PreparedEnvironmentEvidence & {
    runtime: NonNullable<PreparedEnvironmentEvidence["runtime"]>;
    managedRuntime: NonNullable<PreparedEnvironmentEvidence["managedRuntime"]>;
    swapHost: PreparedSwapHostEvidence;
  };
  control: EnvironmentModeV2Control;
  appFingerprint: (appRoot: string) => string;
  directoryFingerprint: (root: string) => string;
  fileFingerprint: (file: string) => string;
  readHeader: (appRoot: string) => string;
  validateOfficial: (selection: EnvironmentSelection) => void;
}): void {
  const { preparation, prepared, control } = input;
  if (input.appFingerprint(input.input.current.selectedDesktopPath) !== prepared.rollback.desktopArtifactDigest
    || input.appFingerprint(preparation.inactiveAppPath) !== prepared.candidate.artifactDigest) {
    throw new Error("Environment mode v2 full preparation validation found changed desktop bytes");
  }
  if (input.readHeader(input.input.current.selectedDesktopPath) !== prepared.rollback.desktopAsarHeaderHash
    || input.readHeader(preparation.inactiveAppPath) !== prepared.candidate.asarHeaderHash) {
    throw new Error("Environment mode v2 full preparation validation found changed ASAR headers");
  }
  if (input.directoryFingerprint(preparation.runtimeRoot) !== prepared.runtime.requested.artifactDigest
    || input.directoryFingerprint(preparation.managedRuntimeRoot) !== prepared.managedRuntime.requested.artifactDigest) {
    throw new Error("Environment mode v2 full preparation validation found changed runtime artifacts");
  }
  const backend = resolveControlledPath(preparation.generationRoot, control.backend.cacheRelativePath);
  const host = resolveControlledPath(preparation.generationRoot, control.nativeHost.relativePath);
  if (input.fileFingerprint(backend) !== prepared.backend.artifactDigest
    || input.fileFingerprint(host) !== prepared.swapHost.digest) {
    throw new Error("Environment mode v2 full preparation validation found changed backend/native exchange evidence");
  }
  validateOfficialForPair(input.input.current, input.validateOfficial);
  // Full seals are deliberately calculated during preparation only.
  sealEnvironmentModeCacheTree(input.input.current.selectedDesktopPath);
  sealEnvironmentModeCacheTree(preparation.inactiveAppPath);
  sealEnvironmentModeCacheTree(preparation.runtimeRoot);
  sealEnvironmentModeCacheTree(preparation.managedRuntimeRoot);
  assertEnvironmentModeCacheTreeStatSealOnly(
    resolveControlledPath(preparation.generationRoot, control.projection.runtimeRelativePath),
    control.projection.runtimeStatSeal,
  );
  assertEnvironmentModeCacheTreeStatSealOnly(
    resolveControlledPath(preparation.generationRoot, control.projection.managedRuntimeRelativePath),
    control.projection.managedRuntimeStatSeal,
  );
  readEnvironmentModeV2ControlAt(join(preparation.generationRoot, CONTROL_FILE), input.fileFingerprint);
}

function createValidatedEnvironmentModePairReceipt(input: {
  paths: EnvironmentModeCachePaths;
  generation: {
    generationId: string;
    generationRoot: string;
    receiptFile: string;
    inactiveAppPath: string;
    runtimeRoot: string;
    managedRuntimeRoot: string;
  };
  input: PrepareEnvironmentModeCacheV2Input;
  prepared: PreparedEnvironmentEvidence & {
    runtime: NonNullable<PreparedEnvironmentEvidence["runtime"]>;
    managedRuntime: NonNullable<PreparedEnvironmentEvidence["managedRuntime"]>;
    swapHost: PreparedSwapHostEvidence;
  };
  control: EnvironmentModeV2Control;
  now: string;
  appFingerprint: (appRoot: string) => string;
  directoryFingerprint: (root: string) => string;
  fileFingerprint: (file: string) => string;
  readHeader: (appRoot: string) => string;
  validateOfficial: (selection: EnvironmentSelection) => void;
  mcpHelperDigest: string;
}): EnvironmentModePairReceipt {
  const { generation, prepared } = input;
  validateOfficialForPair(input.input.current, input.validateOfficial);
  if (input.appFingerprint(input.input.current.selectedDesktopPath) !== prepared.rollback.desktopArtifactDigest
    || input.appFingerprint(generation.inactiveAppPath) !== prepared.candidate.artifactDigest
    || input.directoryFingerprint(generation.runtimeRoot) !== prepared.runtime.requested.artifactDigest
    || input.directoryFingerprint(generation.managedRuntimeRoot) !== prepared.managedRuntime.requested.artifactDigest) {
    throw new Error("Environment mode v2 generation did not survive full promotion validation");
  }
  assertEnvironmentModeCacheTreeStatSealOnly(
    resolveControlledPath(generation.generationRoot, input.control.projection.runtimeRelativePath),
    input.control.projection.runtimeStatSeal,
  );
  assertEnvironmentModeCacheTreeStatSealOnly(
    resolveControlledPath(generation.generationRoot, input.control.projection.managedRuntimeRelativePath),
    input.control.projection.managedRuntimeStatSeal,
  );
  const live = appEvidence({
    appPath: input.input.current.selectedDesktopPath,
    bundleId: input.input.current.selectedDesktopBundleId,
    version: prepared.rollback.desktopVersion,
    build: prepared.rollback.desktopBuild,
    appDigest: prepared.rollback.desktopArtifactDigest,
    asarHeaderDigest: required(prepared.rollback.desktopAsarHeaderHash, "rollback ASAR header"),
    signature: required(prepared.rollback.signature, "rollback signature"),
    fileFingerprint: input.fileFingerprint,
  });
  const inactive = appEvidence({
    appPath: generation.inactiveAppPath,
    bundleId: input.input.requested.selectedDesktopBundleId,
    version: prepared.candidate.version,
    build: prepared.candidate.build,
    appDigest: prepared.candidate.artifactDigest,
    asarHeaderDigest: required(prepared.candidate.asarHeaderHash, "candidate ASAR header"),
    signature: prepared.candidate.signature,
    fileFingerprint: input.fileFingerprint,
  });
  const runtime = artifactEvidence(generation.runtimeRoot, prepared.runtime.requested.artifactDigest, prepared.runtime.requested.fileCount, {
    runtimeFingerprint: prepared.runtime.requested.runtimeFingerprint,
  });
  const managedRuntime = artifactEvidence(
    generation.managedRuntimeRoot,
    prepared.managedRuntime.requested.artifactDigest,
    prepared.managedRuntime.requested.fileCount,
    {
      runtimeFingerprint: prepared.managedRuntime.requested.runtimeFingerprint,
      sourceRuntimeHash: prepared.managedRuntime.requested.sourceRuntimeHash,
      cliDigest: input.control.managedRuntime.cliArtifactDigest,
    },
  );
  const backendPath = resolveControlledPath(generation.generationRoot, input.control.backend.cacheRelativePath);
  const nativeHostPath = resolveControlledPath(generation.generationRoot, input.control.nativeHost.relativePath);
  const backend = artifactEvidence(dirname(backendPath), input.fileFingerprint(backendPath), 1, {
    lane: input.control.backend.lane,
    version: input.control.backend.version,
  });
  const nativeHost = artifactEvidence(dirname(nativeHostPath), input.fileFingerprint(nativeHostPath), 1, {
    nativeHost: input.control.nativeHost,
  });
  const seals = {
    liveApp: sealEnvironmentModeCacheTree(input.input.current.selectedDesktopPath),
    inactiveApp: sealEnvironmentModeCacheTree(generation.inactiveAppPath),
    runtime: sealEnvironmentModeCacheTree(generation.runtimeRoot),
    managedRuntime: sealEnvironmentModeCacheTree(generation.managedRuntimeRoot),
  };
  const official = input.input.current.appExperience === "chatgpt" ? live : inactive;
  const controlDigest = input.fileFingerprint(join(generation.generationRoot, CONTROL_FILE));
  return finalizeEnvironmentModePairReceipt({
    schemaVersion: 2,
    kind: "environment-mode-pair",
    generationId: generation.generationId,
    releaseProfile: input.input.current.releaseProfile,
    paths: {
      cacheRoot: input.paths.cacheRoot,
      currentFile: input.paths.currentFile,
      generationRoot: generation.generationRoot,
      receiptFile: generation.receiptFile,
      inactiveAppPath: generation.inactiveAppPath,
      runtimeRoot: generation.runtimeRoot,
      managedRuntimeRoot: generation.managedRuntimeRoot,
    },
    roles: {
      live: { role: "live", experience: input.input.current.appExperience, appPath: input.input.current.selectedDesktopPath, evidence: live },
      inactive: { role: "inactive", experience: input.input.requested.appExperience, appPath: generation.inactiveAppPath, evidence: inactive },
    },
    tweakers: {
      buildDigest: digestJson({ runtime, managedRuntime, backend, nativeHost }),
      patchPayloadDigest: input.input.requested.appExperience === "tweakers" ? inactive.appDigest : live.appDigest,
      sourceControlDigest: managedRuntime.provenanceDigest,
      runtime,
      managedRuntime,
      backend: { ...backend, lane: input.control.backend.lane, version: input.control.backend.version },
      nativeHost: { ...nativeHost, executablePath: nativeHostPath },
    },
    seals,
    invalidation: {
      official: {
        version: official.version,
        build: official.build,
        trustDigest: official.signature.signatureDigest,
        signatureDigest: official.signature.signatureDigest,
        asarDigest: official.asarDigest,
        asarHeaderDigest: official.asarHeaderDigest,
        backendDigest: input.control.backend.artifactDigest,
        updaterDigest: digestJson({ version: official.version, build: official.build, asar: official.asarDigest }),
      },
      tweakers: {
        sourceDigest: managedRuntime.provenanceDigest,
        buildDigest: digestJson({ runtime, managedRuntime, backend }),
        patchPayloadDigest: input.input.requested.appExperience === "tweakers" ? inactive.appDigest : live.appDigest,
        runtimeDigest: runtime.digest,
        managedRuntimeDigest: managedRuntime.digest,
        backendDigest: backend.digest,
        nativeHostDigest: nativeHost.digest,
      },
      environment: {
        profileDigest: profileDigest(input.input.current.releaseProfile, input.input.current.selectedDesktopPath),
        pathsDigest: digestJson({
          live: input.input.current.selectedDesktopPath,
          inactive: generation.inactiveAppPath,
          runtime: generation.runtimeRoot,
          managedRuntime: generation.managedRuntimeRoot,
        }),
        contentsDevice: statSync(join(input.input.current.selectedDesktopPath, "Contents"), { bigint: true }).dev.toString(),
        statSealDigest: "0".repeat(64),
        mcpHelperDigest: input.mcpHelperDigest,
        lifecycleJournalDigest: controlDigest,
      },
      receiptDigest: "0".repeat(64),
    },
    timestamps: {
      preparedAt: input.now,
      validatedAt: input.now,
      publishedAt: null,
      lastSuccessfulSwitchAt: null,
      lastPreCutoverCancellationAt: null,
      terminalAt: null,
    },
    pin: { state: "prepared", pinnedAt: input.now, releasedAt: null, releaseReason: null },
    supersession: { supersededAt: null, replacementGenerationId: null },
  });
}

function fullEnvironmentModeV2InvalidationSnapshot(input: {
  pair: EnvironmentModePairReceipt;
  control: EnvironmentModeV2Control;
  options: EnvironmentModeProductionOptions;
  appFingerprint: (appRoot: string) => string;
  directoryFingerprint: (root: string) => string;
  fileFingerprint: (file: string) => string;
  readHeader: (appRoot: string) => string;
  validateOfficial: (selection: EnvironmentSelection) => void;
  mcpHelperDigest: string;
}): EnvironmentModeCacheInvalidationSnapshot {
  assertEnvironmentModePairMaterialized(environmentModeCachePaths(input.options.environmentRoot), input.pair);
  const chatgpt = input.pair.roles.live.experience === "chatgpt" ? input.pair.roles.live : input.pair.roles.inactive;
  // The chatgpt selection always points at the shared live desktop path; only
  // validate the OpenAI profile there when ChatGPT is the live role. The
  // inactive official role is proven by its receipt-pinned evidence plus the
  // assertFullRoleIdentity re-verification at its own appPath just below.
  if (chatgpt.role === "live") input.validateOfficial(selectionForExperience(input.control, "chatgpt"));
  assertFullRoleIdentity(input.pair.roles.live, input.appFingerprint, input.readHeader, input.fileFingerprint);
  assertFullRoleIdentity(input.pair.roles.inactive, input.appFingerprint, input.readHeader, input.fileFingerprint);
  const backendPath = resolveControlledPath(input.pair.paths.generationRoot, input.control.backend.cacheRelativePath);
  const hostPath = resolveControlledPath(input.pair.paths.generationRoot, input.control.nativeHost.relativePath);
  return {
    official: {
      version: chatgpt.evidence.version,
      build: chatgpt.evidence.build,
      trustDigest: chatgpt.evidence.signature.signatureDigest,
      signatureDigest: chatgpt.evidence.signature.signatureDigest,
      asarDigest: chatgpt.evidence.asarDigest,
      asarHeaderDigest: chatgpt.evidence.asarHeaderDigest,
      backendDigest: input.control.backend.artifactDigest,
      updaterDigest: digestJson({ version: chatgpt.evidence.version, build: chatgpt.evidence.build, asar: chatgpt.evidence.asarDigest }),
    },
    tweakers: {
      sourceDigest: input.pair.tweakers.sourceControlDigest,
      buildDigest: input.pair.tweakers.buildDigest,
      patchPayloadDigest: input.pair.tweakers.patchPayloadDigest,
      runtimeDigest: input.directoryFingerprint(input.pair.paths.runtimeRoot),
      managedRuntimeDigest: input.directoryFingerprint(input.pair.paths.managedRuntimeRoot),
      backendDigest: input.fileFingerprint(backendPath),
      nativeHostDigest: input.fileFingerprint(hostPath),
    },
    environment: {
      profileDigest: profileDigest(input.pair.releaseProfile, selectionForExperience(input.control, "chatgpt").selectedDesktopPath),
      pathsDigest: digestJson({
        live: input.pair.roles.live.appPath,
        inactive: input.pair.paths.inactiveAppPath,
        runtime: input.pair.paths.runtimeRoot,
        managedRuntime: input.pair.paths.managedRuntimeRoot,
      }),
      contentsDevice: statSync(join(input.pair.roles.live.appPath, "Contents"), { bigint: true }).dev.toString(),
      statSealDigest: input.pair.invalidation.environment.statSealDigest,
      mcpHelperDigest: input.mcpHelperDigest,
      lifecycleJournalDigest: input.fileFingerprint(join(input.pair.paths.generationRoot, CONTROL_FILE)),
    },
  };
}

function appEvidence(input: {
  appPath: string;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  version: string;
  build: string;
  appDigest: string;
  asarHeaderDigest: string;
  signature: { strict: boolean; gatekeeper: boolean; designatedRequirement: string; teamIdentifier: string | null };
  fileFingerprint: (file: string) => string;
}) {
  const asarPath = join(input.appPath, "Contents", "Resources", "app.asar");
  const signature = {
    strict: input.signature.strict,
    gatekeeper: input.signature.gatekeeper,
    teamIdentifier: input.signature.teamIdentifier,
    designatedRequirement: input.signature.designatedRequirement,
    signatureDigest: digestJson({
      strict: input.signature.strict,
      gatekeeper: input.signature.gatekeeper,
      teamIdentifier: input.signature.teamIdentifier,
      designatedRequirement: input.signature.designatedRequirement,
    }),
  };
  return {
    bundleId: input.bundleId,
    version: input.version,
    build: input.build,
    appDigest: input.appDigest,
    asarPath,
    asarDigest: input.fileFingerprint(asarPath),
    asarHeaderDigest: input.asarHeaderDigest,
    signature,
  };
}

function artifactEvidence(rootPath: string, digest: string, fileCount: number, provenance: unknown) {
  return { rootPath, digest, fileCount, provenanceDigest: digestJson(provenance) };
}

function assertModePairInput(input: PrepareEnvironmentModeCacheV2Input): void {
  if (input.current.releaseProfile !== input.requested.releaseProfile
    || input.current.selectedDesktopPath !== input.requested.selectedDesktopPath
    || input.current.selectedDesktopBundleId !== input.requested.selectedDesktopBundleId
    || input.current.appExperience === input.requested.appExperience) {
    throw new Error("Environment mode v2 requires one exact release/app path and opposite mode experiences");
  }
}

/**
 * Both selections in a pair share one live desktop path, so the OpenAI-signed
 * official profile can only be proven there while the ChatGPT experience is
 * actually live. When Tweakers is live, the official desktop exists only as
 * the staged/inactive bundle: its trust is the prepared candidate signature
 * evidence pinned into the pair receipt by
 * assertEnvironmentModeCacheChatgptRoleTrust and re-verified on disk by
 * assertFullRoleIdentity at the inactive role's own appPath. Validating the
 * live path in that state failed every Tweakers-live prepare/observe with
 * "Environment desktop is not signed by OpenAI Team" (live failure 2026-08-19).
 */
function validateOfficialForPair(
  source: EnvironmentSelection,
  validateOfficial: (selection: EnvironmentSelection) => void,
): void {
  if (source.appExperience === "chatgpt") validateOfficial(source);
}

function assertBoundedRoleIdentity(
  role: EnvironmentModePairReceipt["roles"]["live"],
  readHeader: (appRoot: string) => string,
  fileFingerprint: (file: string) => string,
): void {
  const identity = readAppIdentity(role.appPath);
  if (identity.bundleId !== role.evidence.bundleId
    || identity.version !== role.evidence.version
    || identity.build !== role.evidence.build
    || readHeader(role.appPath) !== role.evidence.asarHeaderDigest
    || fileFingerprint(role.evidence.asarPath) !== role.evidence.asarDigest) {
    throw new Error(`Environment mode v2 bounded role identity mismatch at ${role.appPath}`);
  }
  const marker = readAsarMarker(role.evidence.asarPath);
  if ((role.experience === "tweakers" && marker !== "present")
    || (role.experience === "chatgpt" && marker !== "absent")) {
    throw new Error(`Environment mode v2 bounded mode marker mismatch at ${role.appPath}`);
  }
  const signature = signatureInfo(role.appPath);
  if (!signature.ok || signature.teamIdentifier !== role.evidence.signature.teamIdentifier) {
    throw new Error(`Environment mode v2 bounded signature identity mismatch at ${role.appPath}`);
  }
  const strict = verifySignature(role.appPath);
  if (!strict.ok || role.evidence.signature.strict !== true) {
    throw new Error(`Environment mode v2 strict signature check failed at ${role.appPath}`);
  }
}

/**
 * The cache's backend/native files are not tree roots, so bind their complete
 * file digests directly.  This also detects a same-length/restored-mtime edit.
 */
function assertBoundedCachedArtifactIdentity(
  pair: EnvironmentModePairReceipt,
  control: EnvironmentModeV2Control,
  fileFingerprint: (file: string) => string,
): void {
  const backend = resolveControlledPath(pair.paths.generationRoot, control.backend.cacheRelativePath);
  const nativeHost = resolveControlledPath(pair.paths.generationRoot, control.nativeHost.relativePath);
  if (fileFingerprint(backend) !== control.backend.artifactDigest
    || fileFingerprint(backend) !== pair.tweakers.backend.digest) {
    throw new Error("Environment mode v2 cached backend identity changed after preparation");
  }
  if (fileFingerprint(nativeHost) !== control.nativeHost.digest
    || fileFingerprint(nativeHost) !== pair.tweakers.nativeHost.digest) {
    throw new Error("Environment mode v2 cached native exchange identity changed after preparation");
  }
}

/**
 * Projection directories are prepared before confirmation.  They may be
 * renamed into the active runtime only after the exchange, so validate the
 * complete stat seal either at the staged source or at its activated target.
 * Both paths are receipt-controlled and a rename preserves the bound tuples.
 */
function assertBoundedProjectionIdentity(
  pair: EnvironmentModePairReceipt,
  control: EnvironmentModeV2Control,
  fileFingerprint: (file: string) => string,
  environmentRoot: string,
): void {
  assertEnvironmentModeV2ProjectionTree(
    resolveControlledPath(pair.paths.generationRoot, control.projection.runtimeRelativePath),
    join(environmentRoot, "runtime"),
    control.projection.runtimeStatSeal,
  );
  assertEnvironmentModeV2ProjectionTree(
    resolveControlledPath(pair.paths.generationRoot, control.projection.managedRuntimeRelativePath),
    managedSourceRoot(environmentRoot),
    control.projection.managedRuntimeStatSeal,
  );
  const stagedBackend = resolveControlledPath(pair.paths.generationRoot, control.backend.projectionRelativePath);
  if (existsSync(stagedBackend)) {
    if (fileFingerprint(stagedBackend) !== control.backend.artifactDigest) {
      throw new Error("Environment mode v2 staged backend projection changed after preparation");
    }
    return;
  }
  if (control.backend.lane !== "managed-alpha"
    || fileFingerprint(control.backend.targetPath) !== control.backend.artifactDigest) {
    throw new Error("Environment mode v2 activated backend projection changed after preparation");
  }
}

function assertEnvironmentModeV2ProjectionTree(
  stagedPath: string,
  activatedPath: string,
  seal: EnvironmentModeCacheTreeStatSeal,
): void {
  if (existsSync(stagedPath)) {
    assertEnvironmentModeCacheTreeStatSealOnly(stagedPath, seal);
    return;
  }
  assertEnvironmentModeCacheTreeStatSealAfterRename(
    activatedPath,
    rebaseEnvironmentModeV2ProjectionSeal(seal, activatedPath),
  );
}

function assertFullRoleIdentity(
  role: EnvironmentModePairReceipt["roles"]["live"],
  appFingerprint: (appRoot: string) => string,
  readHeader: (appRoot: string) => string,
  fileFingerprint: (file: string) => string,
): void {
  assertBoundedRoleIdentity(role, readHeader, fileFingerprint);
  if (appFingerprint(role.appPath) !== role.evidence.appDigest) {
    throw new Error(`Environment mode v2 full role content mismatch at ${role.appPath}`);
  }
}

export function environmentModeWarmCommitTargetIdentity(
  pair: EnvironmentModePairReceipt,
  role: EnvironmentModePairReceipt["roles"]["inactive"],
): EnvironmentWarmCommitPreflightReady["target"] {
  return {
    appPath: role.appPath,
    appExperience: role.experience,
    bundleId: role.evidence.bundleId,
    version: role.evidence.version,
    build: role.evidence.build,
    asarHeaderDigest: role.evidence.asarHeaderDigest,
    signatureDigest: role.evidence.signature.signatureDigest,
    // These digests bind the complete prepared pair, not only the target
    // experience. A pristine ChatGPT target still belongs to the generation
    // that carries the cached Tweakers artifacts needed for the inverse
    // transition, so preflight must preserve those exact identities too.
    backendDigest: pair.tweakers.backend.digest,
    runtimeDigest: pair.tweakers.runtime.digest,
    managedRuntimeDigest: pair.tweakers.managedRuntime.digest,
    nativeHostDigest: pair.tweakers.nativeHost.digest,
  };
}

function exchangeBefore(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflightReady["exchangeBefore"] {
  return {
    liveContentsBefore: captureEnvironmentModeCacheContentsIdentity(join(pair.roles.live.appPath, "Contents")),
    inactiveContentsBefore: captureEnvironmentModeCacheContentsIdentity(join(pair.paths.inactiveAppPath, "Contents")),
    liveOuterBefore: captureEnvironmentModeCacheOuterAppEvidence(pair.roles.live.appPath),
    inactiveOuterBefore: captureEnvironmentModeCacheOuterAppEvidence(pair.paths.inactiveAppPath),
  };
}

function controlNativeHost(pair: EnvironmentModePairReceipt, control: EnvironmentModeV2Control): PreparedSwapHostEvidence {
  return {
    path: resolveControlledPath(pair.paths.generationRoot, control.nativeHost.relativePath),
    sourceAppPath: pair.roles.inactive.experience === "tweakers"
      ? pair.paths.inactiveAppPath
      : pair.roles.live.appPath,
    digest: control.nativeHost.digest,
    strict: control.nativeHost.strict,
    designatedRequirement: control.nativeHost.designatedRequirement,
    teamIdentifier: control.nativeHost.teamIdentifier,
    authority: [...control.nativeHost.authority],
    certificateLeafHash: control.nativeHost.certificateLeafHash,
  };
}

function selectionForExperience(control: EnvironmentModeV2Control, experience: AppExperience): EnvironmentSelection {
  const selection = control.source.appExperience === experience ? control.source : control.requested;
  if (selection.appExperience !== experience) {
    throw new Error(`Environment mode v2 control has no ${experience} selection`);
  }
  return selection;
}

function writeProjectionConfig(
  file: string,
  selection: EnvironmentSelection,
  control: EnvironmentModeV2Control,
): void {
  updateConfigFile(file, (config) => {
    const tweaker = config.tweaker && typeof config.tweaker === "object" && !Array.isArray(config.tweaker)
      ? config.tweaker as Record<string, unknown>
      : {};
    tweaker.codexCliLane = selection.backendLane === "managed-alpha" ? "beta" : "bundled";
    if (selection.backendLane === "managed-alpha") {
      tweaker.codexCliPath = control.backend.targetPath;
      tweaker.codexCliVersion = control.backend.version;
      tweaker.codexCliFingerprint = control.backend.artifactDigest;
    } else {
      delete tweaker.codexCliPath;
      delete tweaker.codexCliVersion;
      delete tweaker.codexCliFingerprint;
    }
    config.tweaker = tweaker;
  });
}

function writeProjectionState(
  file: string,
  selection: EnvironmentSelection,
  role: EnvironmentModePairReceipt["roles"]["live"],
): void {
  const state = readState(file);
  if (state === null) throw new Error(`Environment mode v2 installer state is missing at ${file}`);
  const { patchedAsarStat: _patched, watcherStatGuardPasses: _passes, ...rest } = state;
  writeState(file, {
    ...rest,
    mode: selection.appExperience,
    appRoot: selection.selectedDesktopPath,
    codexBundleId: selection.selectedDesktopBundleId,
    codexChannel: selection.releaseProfile === "alpha" ? "beta" : "stable",
    codexVersion: role.evidence.version,
    ...(selection.appExperience === "tweakers"
      ? { patchedAsarHash: role.evidence.asarHeaderDigest, watcherStatGuardPasses: 0 }
      : { originalAsarHash: role.evidence.asarHeaderDigest }),
  });
}

function assertTargetProjection(input: {
  pair: EnvironmentModePairReceipt;
  target: EnvironmentSelection;
  pid: number;
  stateFile: string;
  runtimeProofFile: string;
  configFile: string;
  control: EnvironmentModeV2Control;
  fileFingerprint: (file: string) => string;
  mcp: McpModeBridge;
}): void {
  const state = readState(input.stateFile);
  if (state === null || state.mode !== input.target.appExperience
    || state.appRoot !== input.target.selectedDesktopPath
    || state.codexBundleId !== input.target.selectedDesktopBundleId) {
    throw new Error("Environment mode v2 state projection is not bound to the target selection");
  }
  const config = readConfigFile(input.configFile);
  const tweaker = config.tweaker && typeof config.tweaker === "object" && !Array.isArray(config.tweaker)
    ? config.tweaker as Record<string, unknown>
    : {};
  const expectedLane = input.target.backendLane === "managed-alpha" ? "beta" : "bundled";
  if (tweaker.codexCliLane !== expectedLane) {
    throw new Error("Environment mode v2 backend lane projection is not bound to the target selection");
  }
  if (input.target.appExperience === "tweakers" && input.target.backendLane === "managed-alpha") {
    if (tweaker.codexCliPath !== input.control.backend.targetPath
      || tweaker.codexCliFingerprint !== input.control.backend.artifactDigest
      || input.fileFingerprint(input.control.backend.targetPath) !== input.control.backend.artifactDigest) {
      throw new Error("Environment mode v2 managed backend projection is not bound to the cached artifact");
    }
  }
  // Runtime writes its PID-bound proof after protected bootstrap. The bridge
  // proof is required for both modes and is never inferred from config writes.
  if (input.target.appExperience === "tweakers") {
    const proof = readRuntimeProof(input.runtimeProofFile);
    if (proof === null || proof.pid !== input.pid
      || proof.appRoot !== input.target.selectedDesktopPath
      || proof.backendFingerprint !== input.control.backend.artifactDigest
      || proof.runtimeFingerprint !== input.control.runtime.runtimeFingerprint
      || proof.managedRuntimeFingerprint !== input.control.managedRuntime.runtimeFingerprint) {
      throw new Error("Environment mode v2 runtime proof is not fresh for the reopened target");
    }
  }
  if (!input.mcp.prove(input.target.appExperience)) {
    throw new Error("Environment mode v2 MCP projection proof failed");
  }
}

function targetProof(
  pair: EnvironmentModePairReceipt,
  target: EnvironmentSelection,
  pid: number,
  visibleWindow: boolean,
  readHeader: (appRoot: string) => string,
  fileFingerprint: (file: string) => string,
): EnvironmentWarmCommitTargetProof {
  const role = pair.roles.live;
  assertBoundedRoleIdentity(role, readHeader, fileFingerprint);
  const tweakers = target.appExperience === "tweakers";
  return {
    pid,
    visibleWindow,
    appPath: role.appPath,
    appExperience: role.experience,
    bundleId: role.evidence.bundleId,
    version: role.evidence.version,
    build: role.evidence.build,
    asarHeaderDigest: role.evidence.asarHeaderDigest,
    signatureDigest: role.evidence.signature.signatureDigest,
    selection: { ...target, appliedAt: new Date().toISOString() },
    desktopArtifactDigest: role.evidence.appDigest,
    backendDigest: tweakers ? pair.tweakers.backend.digest : null,
    runtimeDigest: tweakers ? pair.tweakers.runtime.digest : null,
    managedRuntimeDigest: tweakers ? pair.tweakers.managedRuntime.digest : null,
    tweakersLoaderActive: tweakers,
    mcpEnabled: tweakers,
  };
}

function promotePreparedDirectory(source: string, destination: string): () => void {
  assertRealPath(source, "prepared projection directory", "directory");
  const previous = `${destination}.environment-v2-previous-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(previous)) throw new Error(`Environment mode v2 previous projection already exists at ${previous}`);
  const hadPrevious = existsSync(destination);
  if (hadPrevious) renameSync(destination, previous);
  try {
    renameSync(source, destination);
  } catch (error) {
    if (hadPrevious && !existsSync(destination) && existsSync(previous)) renameSync(previous, destination);
    throw error;
  }
  return () => {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    if (hadPrevious && existsSync(previous)) renameSync(previous, destination);
  };
}

function promotePreparedFile(source: string, destination: string): () => void {
  assertRealPath(source, "prepared projection file", "file");
  const previous = `${destination}.environment-v2-previous-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(destination), { recursive: true });
  const hadPrevious = existsSync(destination);
  if (hadPrevious) renameSync(destination, previous);
  try {
    renameSync(source, destination);
  } catch (error) {
    if (hadPrevious && !existsSync(destination) && existsSync(previous)) renameSync(previous, destination);
    throw error;
  }
  return () => {
    if (existsSync(destination)) rmSync(destination, { force: true });
    if (hadPrevious && existsSync(previous)) renameSync(previous, destination);
  };
}

function snapshotSmallFile(file: string): () => void {
  const bytes = existsSync(file) ? readFileSync(file) : null;
  return () => {
    if (bytes === null) {
      rmSync(file, { force: true });
      return;
    }
    writeFileAtomically(file, bytes);
  };
}

function readRuntimeProof(file: string): {
  pid: number;
  appRoot: string;
  backendFingerprint: string;
  runtimeFingerprint: string;
  managedRuntimeFingerprint: string;
} | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof value.pid === "number"
      && typeof value.appRoot === "string"
      && typeof value.backendFingerprint === "string"
      && typeof value.runtimeFingerprint === "string"
      && typeof value.managedRuntimeFingerprint === "string"
      ? value as { pid: number; appRoot: string; backendFingerprint: string; runtimeFingerprint: string; managedRuntimeFingerprint: string }
      : null;
  } catch {
    return null;
  }
}

async function waitForFreshVisibleProcess(
  appPath: string,
  oldPid: number,
  observe: (path: string) => CodexMainProcessObservation | null,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CodexMainProcessObservation> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const observed = observe(appPath);
    if (observed !== null && observed.pid !== oldPid && observed.visibleWindow) return observed;
    await sleep(250);
  }
  throw new Error(`Environment mode v2 did not observe a fresh visible target PID at ${appPath}`);
}

function requireSourceProjection(value: EnvironmentWarmCommitSourceProjectionIdentity | null | undefined): EnvironmentWarmCommitSourceProjectionIdentity {
  if (value === null || value === undefined) throw new Error("Environment mode v2 recovery journal lacks its source projection");
  return value;
}

function requireCurrentGeneration(paths: EnvironmentModeCachePaths, transactionId: string): EnvironmentModePairReceipt {
  const pair = readCurrentEnvironmentModePair(paths);
  if (pair === null || pair.generationId !== transactionId) {
    throw new Error(`Environment mode v2 generation mismatch: expected ${transactionId}`);
  }
  return pair;
}

function readEnvironmentModeV2ControlAt(
  file: string,
  fileFingerprint: (file: string) => string,
): EnvironmentModeV2Control {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Environment mode v2 control receipt is unreadable: ${errorMessage(error)}`);
  }
  if (!isEnvironmentModeV2Control(value)) throw new Error("Environment mode v2 control receipt is invalid");
  if (!SHA256.test(fileFingerprint(file))) throw new Error("Environment mode v2 control receipt fingerprint is invalid");
  return value;
}

function isEnvironmentModeV2Control(value: unknown): value is EnvironmentModeV2Control {
  if (!isRecord(value)
    || value.schemaVersion !== ENVIRONMENT_MODE_V2_CONTROL_SCHEMA_VERSION
    || value.kind !== ENVIRONMENT_MODE_V2_CONTROL_KIND
    || !safeGenerationId(value.generationId)
    || typeof value.preparedAt !== "string"
    || !isEnvironmentSelection(value.source)
    || !isEnvironmentSelection(value.requested)
    || !isRecord(value.managedRuntime)
    || !isRecord(value.runtime)
    || !isRecord(value.backend)
    || !isRecord(value.nativeHost)
    || !isRecord(value.projection)) return false;
  const managed = value.managedRuntime;
  const runtime = value.runtime;
  const backend = value.backend;
  const host = value.nativeHost;
  const projection = value.projection;
  return SHA256.test(String(managed.artifactDigest))
    && SHA256.test(String(managed.cliArtifactDigest))
    && typeof managed.runtimeFingerprint === "string"
    && Number.isInteger(managed.fileCount)
    && managed.cliRelativePath === MANAGED_CLI_RELATIVE_PATH
    && SHA256.test(String(runtime.artifactDigest))
    && typeof runtime.runtimeFingerprint === "string"
    && Number.isInteger(runtime.fileCount)
    && (backend.lane === "bundled" || backend.lane === "managed-alpha")
    && typeof backend.version === "string"
    && SHA256.test(String(backend.artifactDigest))
    && exactAbsolutePath(backend.targetPath)
    && backend.cacheRelativePath === join("backend", "codex")
    && backend.projectionRelativePath === join(PROJECTION_ROOT, "backend", "codex")
    && host.relativePath === join("native", "tweaker_native_host.node")
    && SHA256.test(String(host.digest))
    && typeof host.strict === "boolean"
    && typeof host.designatedRequirement === "string"
    && (host.teamIdentifier === null || typeof host.teamIdentifier === "string")
    && Array.isArray(host.authority) && host.authority.every((entry) => typeof entry === "string")
    && (host.certificateLeafHash === null || typeof host.certificateLeafHash === "string")
    && projection.runtimeRelativePath === join(PROJECTION_ROOT, "runtime")
    && projection.managedRuntimeRelativePath === join(PROJECTION_ROOT, "managed-runtime")
    && isEnvironmentModeCacheTreeStatSeal(projection.runtimeStatSeal)
    && isEnvironmentModeCacheTreeStatSeal(projection.managedRuntimeStatSeal);
}

function assertProductionOptions(options: EnvironmentModeProductionOptions): void {
  for (const [label, path] of Object.entries({
    environmentRoot: options.environmentRoot,
    registryFile: options.registryFile,
    selectionFile: options.selectionFile,
    configFile: options.configFile,
    stateFile: options.stateFile,
    runtimeProofFile: options.runtimeProofFile,
    mcpConfigFile: options.mcpConfigFile,
    mcpStateFile: options.mcpStateFile,
    tweaksRoot: options.tweaksRoot,
    watcherPromotionFile: options.watcherPromotionFile,
  })) {
    if (!exactAbsolutePath(path)) throw new Error(`Environment mode v2 ${label} must be an exact absolute path`);
  }
}

function copyDirectoryExactly(source: string, destination: string): void {
  assertRealPath(source, "v2 source directory", "directory");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  copyDirectoryPreservingModes(source, destination);
}

function copyFileExactly(source: string, destination: string): void {
  assertRealPath(source, "v2 source file", "file");
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  copyFileSync(source, destination);
  chmodSync(destination, lstatSync(source).mode & 0o777);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function mcpHelperDigest(mcp: McpModeBridge, helperFile: string): string {
  // `assertReady` rejects missing/symlinked helpers; hash the one exact file
  // afterward so a cache hit cannot silently adopt changed MCP behavior.
  mcp.assertReady();
  return sha256File(helperFile);
}

function profileDigest(releaseProfile: string, appPath: string): string {
  return digestJson({ releaseProfile, appPath });
}

function readAppIdentity(appPath: string): { bundleId: string | null; version: string | null; build: string | null } {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    return {
      bundleId: typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : null,
      version: typeof plist.CFBundleShortVersionString === "string" ? plist.CFBundleShortVersionString : null,
      build: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : null,
    };
  } catch {
    return { bundleId: null, version: null, build: null };
  }
}

function resolveControlledPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === ".." || part.length === 0)) {
    throw new Error("Environment mode v2 control path is unsafe");
  }
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}/`)) throw new Error("Environment mode v2 control path escapes its generation");
  return path;
}

function assertRealPath(path: string, label: string, expected: "file" | "directory"): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (expected === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`${label} is not a real ${expected}: ${path}`);
  }
}

function writeJsonAtomically(file: string, value: object): void {
  writeFileAtomically(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function writeFileAtomically(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Environment mode v2 lacks ${label}`);
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function isEnvironmentSelection(value: unknown): value is EnvironmentSelection {
  return isRecord(value)
    && (value.appExperience === "chatgpt" || value.appExperience === "tweakers")
    && (value.releaseProfile === "stable" || value.releaseProfile === "alpha")
    && typeof value.selectedDesktopPath === "string"
    && (value.selectedDesktopBundleId === "com.openai.codex" || value.selectedDesktopBundleId === "com.openai.codex.beta");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeGenerationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function exactAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

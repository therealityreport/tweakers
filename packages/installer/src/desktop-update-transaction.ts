import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { desktopVersionAdvanced, type DesktopVersionIdentity } from "./desktop-version.js";
// Re-exported from its new home so existing importers keep working.
export { desktopVersionAdvanced, type DesktopVersionIdentity };
import {
  commitVerifiedOfficialDesktop,
  officialAdoptionError,
  OFFICIAL_ADOPTION_MESSAGE,
  proveVerifiedOfficialDesktop,
} from "./adopt-official-desktop.js";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  inspectEnvironmentProfile,
  isEnvironmentSelection,
  normalizeEnvironmentSelection,
  loadEnvironmentState,
  migrateLegacyEnvironmentSelection,
  publishEnvironmentSelection,
  readEnvironmentSelection,
  readEnvironmentProfileRegistry,
  resolveEnvironmentProfile,
  validateOfficialEnvironmentProfile,
  writeEnvironmentProfileRegistry,
  type EnvironmentSelection,
} from "./environment-profile.js";
import {
  createEnvironmentCoordinator,
  defaultCodexMcpConfigFile,
  environmentPreparationCapabilities,
  inspectManagedAlphaBackend,
  readEnvironmentRuntimeProof,
  writeEnvironmentTransactionReceipt,
  type EnvironmentCoordinator,
  type EnvironmentTransactionReceipt,
} from "./environment-transaction.js";
import {
  environmentModeCachePaths,
  readCurrentEnvironmentModePair,
  type EnvironmentModePairReceipt,
} from "./environment-mode-cache.js";
import { environmentModeCacheV2Enabled } from "./environment-mode-production.js";
import type { EnvironmentWarmCommitReceipt } from "./environment-warm-commit.js";
import { userPaths } from "./paths.js";
import { assertInstallerUpdateQuarantineClear } from "./protected-update-quarantine.js";
import { readPlist } from "./plist.js";
import { readHeaderHash } from "./asar.js";
import { acquireProcessLock, processAlive as isProcessAlive } from "./process-lock.js";
import {
  assertLifecycleReceiptsIdle,
  environmentReceiptBlocksLifecycle,
  withLifecycleLock,
} from "./lifecycle-lock.js";
import { readState, writeState } from "./state.js";
import {
  getLocalRefreshStatus,
  preferredDesktopRefreshSource,
  refreshLocal,
  type RefreshSource,
} from "./commands/refresh-local.js";
import {
  observeCodexMainProcess,
  openCodex,
  requestCodexNativeUpdate,
  showUpdateModePausedAlert,
  type NativeUpdateHandoffFailureKind,
  type NativeUpdateHandoffResult,
} from "./alerts.js";
import { type AsarMarker, isDeveloperIdSignedBackup, readAsarMarker } from "./commands/install.js";
import { probeDesktopAppcast, type DesktopAppcastProbeResult } from "./desktop-appcast-probe.js";
import { readConfigFile } from "./config.js";
import { createMcpModeBridge } from "./mcp-mode-bridge.js";
import { proveRegularChatGptMcpRuntime } from "./mcp-runtime-proof.js";
import {
  readDesktopUpdateHeartbeat,
  removeDesktopUpdateHeartbeat,
  writeDesktopUpdateHeartbeat,
  type DesktopUpdateHeartbeat,
} from "./desktop-update-heartbeat.js";
import { appendDesktopUpdateLog, type DesktopUpdateLogEvent } from "./desktop-update-log.js";
import { readProcessStartToken } from "./orphans.js";

export const DESKTOP_UPDATE_SCHEMA_VERSION = 1 as const;

export type DesktopUpdatePhase =
  | "preparing"
  | "switching_to_chatgpt"
  | "awaiting_native_update"
  | "returning_to_tweakers"
  | "refreshing_runtime"
  | "verifying"
  | "completed"
  | "failed"
  | "rolled_back";

export type DesktopUpdateRefreshSource = Exclude<RefreshSource, "current">;

export interface DesktopUpdateReceipt {
  schemaVersion: typeof DESKTOP_UPDATE_SCHEMA_VERSION;
  kind: "desktop-update";
  transactionId: string;
  phase: DesktopUpdatePhase;
  ownerPid: number;
  /** Stable OS process-start identity. Missing on legacy receipts. */
  ownerToken?: string | null;
  /** Fresh fencing UUID for each explicit ownership claim. Missing on legacy receipts. */
  ownerGeneration?: string | null;
  source: EnvironmentSelection;
  official: EnvironmentSelection;
  baseline: DesktopVersionIdentity;
  observed: DesktopVersionIdentity | null;
  nativeUpdateHandoffAt: string | null;
  refreshSource: DesktopUpdateRefreshSource | null;
  environmentTransactionId: string | null;
  /** Additive discriminator for receipts created after sealed-pair switching shipped. */
  environmentTransactionKind?: "legacy" | "mode-cache-v2" | null;
  /** PID proven when the official environment was entered before native update. */
  officialMainPid?: number | null;
  safeOfficialMode: boolean;
  resumable: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Immutable time of the current terminal outcome. Additive schema-v1 field:
   * legacy receipts omit it and consumers fall back to updatedAt.
   */
  terminalAt?: string | null;
  /**
   * Audit time for abandoning the last recovery continuation. This must not
   * replace terminalAt or the causal terminal error.
   */
  continuationAbandonedAt?: string | null;
  completedAt: string | null;
  rolledBackAt: string | null;
}

export interface WaitForDesktopVersionChangeInput {
  transactionId: string;
  appPath: string;
  baseline: DesktopVersionIdentity;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface InitiateNativeDesktopUpdateInput {
  transactionId: string;
  selection: EnvironmentSelection;
  baseline: DesktopVersionIdentity;
  officialMainPid: number | null;
}

export interface LiveOfficialDesktopObservation {
  version: DesktopVersionIdentity;
  mainPid: number;
}

export interface RefreshTweakersInput {
  source: DesktopUpdateRefreshSource;
  selection: EnvironmentSelection;
  observedDesktop: DesktopVersionIdentity;
}

export interface SynchronousLocalRefreshOptions {
  env?: NodeJS.ProcessEnv;
  refresh?: (options: { source: "development" | "stable"; app: string }) => void | Promise<void>;
}

export interface VerifyDesktopUpdateInput {
  expected: EnvironmentSelection;
  baseline: DesktopVersionIdentity;
  observed: DesktopVersionIdentity;
  previousMainPid: number | null;
  environmentTransactionKind: "legacy" | "mode-cache-v2" | null;
  environmentTransactionId: string | null;
  modeCachePair: DesktopUpdateModeCachePair | null;
}

export interface RecoveredOfficialUpdate {
  observed: DesktopVersionIdentity;
  selection: EnvironmentSelection;
  mainPid: number;
}

export interface DesktopUpdateModeCachePair {
  generationId: string;
  releaseProfile: EnvironmentSelection["releaseProfile"];
  pinState: EnvironmentModePairReceipt["pin"]["state"];
  live: {
    experience: EnvironmentSelection["appExperience"];
    appPath: string;
    bundleId: EnvironmentSelection["selectedDesktopBundleId"];
    version: string;
    build: string;
  };
  inactive: {
    experience: EnvironmentSelection["appExperience"];
    appPath: string;
    bundleId: EnvironmentSelection["selectedDesktopBundleId"];
    version: string;
    build: string;
    strictSignature: boolean;
  };
}

export interface DesktopUpdateModeCacheSwitchResult {
  transactionId: string;
  phase: EnvironmentWarmCommitReceipt["phase"];
  error: string | null;
  selection: EnvironmentSelection | null;
  targetMainPid: number | null;
  pair: DesktopUpdateModeCachePair | null;
}

export interface DesktopUpdateModeCacheAdapter {
  current(): DesktopUpdateModeCachePair | null;
  switchCurrent(input: {
    current: EnvironmentSelection;
    requested: EnvironmentSelection;
    transactionId: string;
    approvalAt: string;
  }): Promise<DesktopUpdateModeCacheSwitchResult>;
  prepareAndSwitch(input: {
    current: EnvironmentSelection;
    requested: EnvironmentSelection;
    transactionId: string;
    approvalAt: string;
  }): Promise<DesktopUpdateModeCacheSwitchResult>;
  recover(transactionId: string): Promise<DesktopUpdateModeCacheSwitchResult>;
}

export interface DesktopUpdateDependencies {
  environment: EnvironmentCoordinator;
  /** Null preserves the complete schema-v1 update path. */
  modeCacheV2: DesktopUpdateModeCacheAdapter | null;
  readCurrentSelection(): EnvironmentSelection | null | Promise<EnvironmentSelection | null>;
  readDesktopVersion(appPath: string): DesktopVersionIdentity | Promise<DesktopVersionIdentity>;
  readDesktopBundleIdentifier(appPath: string): string | null | Promise<string | null>;
  /** Owner-dead recovery seam; defaults to reading the live bundle's asar patch marker. */
  readDesktopAsarMarker?(appPath: string): AsarMarker;
  /**
   * Advisory pre-check of the signed Sparkle appcast before any environment
   * swap. Only an unambiguous "current" result short-circuits the update;
   * "unavailable" always fails open into the native updater flow.
   */
  probeAppcast?(input: {
    appPath: string;
    baseline: DesktopVersionIdentity;
  }): DesktopAppcastProbeResult | Promise<DesktopAppcastProbeResult>;
  /** Prove the exact live desktop is pristine, OpenAI-signed, visible, and version-readable. */
  inspectLiveOfficialDesktop(
    selection: EnvironmentSelection,
  ): LiveOfficialDesktopObservation | Promise<LiveOfficialDesktopObservation>;
  /** Open the exact selected official app so a resume does not dead-end when
   * the user closed ChatGPT after a failed handoff. */
  launchOfficialDesktop(selection: EnvironmentSelection): void;
  /**
   * Ask the live official ChatGPT to open its native updater. Returning a
   * failed result (or void for legacy adapters that throw instead) does not
   * necessarily abort the update: click-level failures are recoverable
   * because ChatGPT also checks for updates on its own at launch.
   */
  initiateNativeUpdate(
    input: InitiateNativeDesktopUpdateInput,
  ): NativeUpdateHandoffResult | void | Promise<NativeUpdateHandoffResult | void>;
  waitForVersionChange(input: WaitForDesktopVersionChangeInput): Promise<DesktopVersionIdentity | null>;
  /** Test/adapter seam after the native wait settles but before its atomic receipt transition. */
  beforeNativeWaitTransition?(): void | Promise<void>;
  /**
   * Recompute profile/artifact evidence without changing the identity of the
   * environment that the desktop-update transaction already captured.
   */
  refreshEnvironmentTruth(
    current: EnvironmentSelection,
  ): EnvironmentSelection | void | Promise<EnvironmentSelection | void>;
  selectRefreshSource(): DesktopUpdateRefreshSource | Promise<DesktopUpdateRefreshSource>;
  refreshTweakers(input: RefreshTweakersInput): void | Promise<void>;
  verifyFinal(input: VerifyDesktopUpdateInput): { ok: boolean; error: string | null } | Promise<{ ok: boolean; error: string | null }>;
  /**
   * Recover the narrow crash window where Sparkle installed and reopened a
   * newer, pristine OpenAI app after the environment transaction had already
   * failed. Returning null means the live app did not satisfy every proof.
   */
  recoverVerifiedOfficialUpdate(input: {
    receipt: DesktopUpdateReceipt;
    environmentReceipt: EnvironmentTransactionReceipt;
  }): RecoveredOfficialUpdate | null | Promise<RecoveredOfficialUpdate | null>;
  processAlive(pid: number): boolean;
  readProcessStartToken(pid: number): string | null;
  now(): string;
  createId(): string;
  createOwnerGeneration(): string;
  createModeCacheGenerationId(): string;
}

export interface DesktopUpdateTransactionOptions {
  root?: string;
  stateFile?: string;
  receiptRoot?: string;
  lockFile?: string;
  heartbeatFile?: string;
  logFile?: string;
  jobLabel?: string | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Bounded wait for the official app to present a visible window after a
   * resume-triggered relaunch. */
  resumeLaunchWaitMs?: number;
  appPath?: string;
}

export interface DesktopUpdateTransaction {
  start(): Promise<DesktopUpdateReceipt>;
  resume(): Promise<DesktopUpdateReceipt>;
  cancel(): Promise<DesktopUpdateReceipt>;
  reconcile(): Promise<DesktopUpdateReceipt | null>;
  status(): DesktopUpdateReceipt | null;
  /** Latest owner heartbeat, if one exists — live progress for status readers. */
  heartbeat(): DesktopUpdateHeartbeat | null;
}

/** Handoff failures that do not disprove the update itself. ChatGPT checks
 * for updates on its own at launch, so a failed menu click never aborts the
 * transaction — the version wait continues. process_not_proven is usually the
 * SUCCESS signature: Sparkle installed the update and relaunched the app,
 * killing the recorded PID; the version wait then returns immediately. Only
 * unsupported_platform is fatal. */
const RECOVERABLE_NATIVE_HANDOFF_KINDS: ReadonlySet<NativeUpdateHandoffFailureKind> = new Set([
  "menu_item_not_found",
  "menu_item_disabled",
  "script_failed",
  "automation_permission_denied",
  "process_not_proven",
  "window_not_visible",
]);

function createProductionDesktopUpdateModeCacheAdapter(input: {
  environment: EnvironmentCoordinator;
  environmentRoot: string;
  readCurrentSelection(): EnvironmentSelection | null | Promise<EnvironmentSelection | null>;
}): DesktopUpdateModeCacheAdapter {
  const coordinator = requireDesktopUpdateModeCacheCoordinator(input.environment);
  const paths = environmentModeCachePaths(input.environmentRoot);
  const current = (): DesktopUpdateModeCachePair | null => {
    const pair = readCurrentEnvironmentModePair(paths);
    return pair === null ? null : projectDesktopUpdateModeCachePair(pair);
  };
  const result = async (
    transactionId: string,
    warm: EnvironmentWarmCommitReceipt,
  ): Promise<DesktopUpdateModeCacheSwitchResult> => ({
    transactionId,
    phase: warm.phase,
    error: warm.error,
    selection: await input.readCurrentSelection(),
    targetMainPid: warm.targetMainPid,
    pair: current(),
  });
  const switchCurrent = async (request: {
    current: EnvironmentSelection;
    requested: EnvironmentSelection;
    transactionId: string;
    approvalAt: string;
  }): Promise<DesktopUpdateModeCacheSwitchResult> => {
    const before = current();
    assertDesktopUpdateModeCacheTransition(before, request.current, request.requested, request.transactionId);
    const warm = await coordinator.commitModeCacheV2({
      transactionId: request.transactionId,
      approvalAt: request.approvalAt,
    });
    const switched = await result(request.transactionId, warm);
    if (switched.phase === "ready") {
      assertDesktopUpdateModeCacheResult(switched, request.requested);
    }
    return switched;
  };
  return {
    current,
    switchCurrent,
    async prepareAndSwitch(request) {
      const prepared = await coordinator.prepareModeCacheV2({
        current: request.current,
        requested: request.requested,
        generationId: request.transactionId,
      });
      if (prepared.state !== "ready"
        || prepared.receipt === null
        || prepared.receipt.generationId !== request.transactionId) {
        throw new Error("Desktop update could not prepare a fresh sealed environment pair");
      }
      return switchCurrent(request);
    },
    async recover(transactionId) {
      const recovered = await coordinator.recoverModeCacheV2({ transactionId });
      if (recovered.kind !== "environment-warm-commit") {
        throw new Error("Desktop update v2 recovery returned a legacy environment receipt");
      }
      return result(transactionId, recovered);
    },
  };
}

function requireDesktopUpdateModeCacheCoordinator(
  coordinator: EnvironmentCoordinator,
): Required<Pick<EnvironmentCoordinator, "prepareModeCacheV2" | "commitModeCacheV2" | "recoverModeCacheV2">>
  & EnvironmentCoordinator {
  if (!coordinator.prepareModeCacheV2 || !coordinator.commitModeCacheV2 || !coordinator.recoverModeCacheV2) {
    throw new Error("environmentModeCacheV2 is enabled but the desktop updater has no bound v2 production adapter");
  }
  return coordinator as Required<Pick<
    EnvironmentCoordinator,
    "prepareModeCacheV2" | "commitModeCacheV2" | "recoverModeCacheV2"
  >> & EnvironmentCoordinator;
}

function projectDesktopUpdateModeCachePair(pair: EnvironmentModePairReceipt): DesktopUpdateModeCachePair {
  return {
    generationId: pair.generationId,
    releaseProfile: pair.releaseProfile,
    pinState: pair.pin.state,
    live: {
      experience: pair.roles.live.experience,
      appPath: pair.roles.live.appPath,
      bundleId: pair.roles.live.evidence.bundleId,
      version: pair.roles.live.evidence.version,
      build: pair.roles.live.evidence.build,
    },
    inactive: {
      experience: pair.roles.inactive.experience,
      appPath: pair.roles.inactive.appPath,
      bundleId: pair.roles.inactive.evidence.bundleId,
      version: pair.roles.inactive.evidence.version,
      build: pair.roles.inactive.evidence.build,
      strictSignature: pair.roles.inactive.evidence.signature.strict,
    },
  };
}

function desktopUpdateModeCachePairBinds(
  pair: DesktopUpdateModeCachePair | null,
  current: EnvironmentSelection,
  requested: EnvironmentSelection,
): pair is DesktopUpdateModeCachePair {
  return pair !== null
    && pair.pinState === "prepared"
    && pair.releaseProfile === current.releaseProfile
    && requested.releaseProfile === current.releaseProfile
    && pair.live.appPath === current.selectedDesktopPath
    && requested.selectedDesktopPath === current.selectedDesktopPath
    && pair.live.bundleId === current.selectedDesktopBundleId
    && pair.inactive.bundleId === requested.selectedDesktopBundleId
    && pair.live.experience === current.appExperience
    && pair.inactive.experience === requested.appExperience;
}

function assertDesktopUpdateModeCacheTransition(
  pair: DesktopUpdateModeCachePair | null,
  current: EnvironmentSelection,
  requested: EnvironmentSelection,
  transactionId: string,
): asserts pair is DesktopUpdateModeCachePair {
  if (!desktopUpdateModeCachePairBinds(pair, current, requested) || pair.generationId !== transactionId) {
    throw new Error("Desktop update sealed pair does not bind the requested environment transition");
  }
}

function assertDesktopUpdateModeCacheResult(
  result: DesktopUpdateModeCacheSwitchResult,
  requested: EnvironmentSelection,
): void {
  if (result.pair === null
    || result.selection === null
    || result.targetMainPid === null
    || result.pair.generationId !== result.transactionId
    || result.pair.pinState !== "prepared"
    || result.pair.live.experience !== requested.appExperience
    || result.pair.live.appPath !== requested.selectedDesktopPath
    || result.pair.live.bundleId !== requested.selectedDesktopBundleId
    || !sameEnvironmentSelection(result.selection, requested)
    || result.selection.appliedAt === null) {
    throw new Error("Desktop update sealed-pair commit did not prove the requested live environment");
  }
}

export function createDesktopUpdateTransaction(
  options: DesktopUpdateTransactionOptions = {},
  overrides: Partial<DesktopUpdateDependencies> = {},
): DesktopUpdateTransaction {
  const paths = userPaths();
  const root = options.root ?? paths.root;
  const stateFile = options.stateFile ?? join(root, "transactions", "desktop-update.json");
  const receiptRoot = options.receiptRoot ?? join(root, "transactions", "desktop-update");
  const lockFile = options.lockFile ?? join(root, "transactions", "desktop-update.lock");
  const heartbeatFile = options.heartbeatFile
    ?? join(root, "transactions", "desktop-update.heartbeat.json");
  const logFile = options.logFile ?? join(root, "log", "desktop-update.log");
  const environmentRegistryFile = join(root, "environment-registry.json");
  const environmentSelectionFile = join(root, "environment-selection.json");
  const environmentTransactionFile = join(root, "transactions", "environment.json");
  const environmentReceiptRoot = join(root, "transactions", "environment");
  const environmentLockFile = join(root, "transactions", "environment.lock");
  const lifecycleLockFile = join(root, "transactions", "lifecycle.lock");
  const installerStateFile = join(root, "state.json");
  const configFile = join(root, "config.json");
  const timeoutMs = Math.max(1, options.timeoutMs ?? configuredNativeUpdateTimeoutMs(configFile));
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 2_000);
  const resumeLaunchWaitMs = Math.max(0, options.resumeLaunchWaitMs ?? 30_000);
  const now = overrides.now ?? (() => new Date().toISOString());
  const modeCacheV2Enabled = overrides.modeCacheV2 !== undefined
    ? overrides.modeCacheV2 !== null
    : environmentModeCacheV2Enabled(configFile);
  const environment = overrides.environment ?? createEnvironmentCoordinator({
    environmentRoot: root,
    transactionFile: environmentTransactionFile,
    receiptRoot: environmentReceiptRoot,
    selectionFile: environmentSelectionFile,
    registryFile: environmentRegistryFile,
    stateFile: installerStateFile,
    configFile,
    runtimeProofFile: join(root, "environment-runtime-proof.json"),
    mcpStateFile: join(root, "mcp-sync-state.json"),
    tweaksRoot: join(root, "tweaks"),
    lockFile: environmentLockFile,
    lifecycleLockFile,
    ...(modeCacheV2Enabled ? { environmentModeCacheV2: true } : {}),
  });
  const readCurrentSelection = overrides.readCurrentSelection ?? (() => {
    const saved = readEnvironmentSelection(environmentSelectionFile);
    if (saved) return saved;
    const legacy = readState(installerStateFile);
    return migrateLegacyEnvironmentSelection({ mode: legacy?.mode });
  });
  const modeCacheV2 = overrides.modeCacheV2 !== undefined
    ? overrides.modeCacheV2
    : modeCacheV2Enabled
      ? createProductionDesktopUpdateModeCacheAdapter({
        environment,
        environmentRoot: root,
        readCurrentSelection,
      })
      : null;
  const deps: DesktopUpdateDependencies = {
    environment,
    modeCacheV2,
    readCurrentSelection,
    readDesktopVersion: overrides.readDesktopVersion ?? readDesktopVersion,
    readDesktopBundleIdentifier: overrides.readDesktopBundleIdentifier ?? ((appPath) => (
      readDesktopBundleIdentity(appPath).bundleId
    )),
    readDesktopAsarMarker: overrides.readDesktopAsarMarker ?? ((appPath) => (
      readAsarMarker(join(appPath, "Contents", "Resources", "app.asar"))
    )),
    probeAppcast: overrides.probeAppcast ?? ((input) => probeDesktopAppcast(input)),
    inspectLiveOfficialDesktop: overrides.inspectLiveOfficialDesktop ?? inspectLiveOfficialDesktop,
    launchOfficialDesktop: overrides.launchOfficialDesktop ?? ((selection) => {
      openCodex(selection.selectedDesktopPath);
    }),
    initiateNativeUpdate: overrides.initiateNativeUpdate ?? (async ({ selection, baseline, officialMainPid }) => {
      let result: NativeUpdateHandoffResult = {
        ok: false,
        kind: "process_not_proven",
        message: "The exact ChatGPT process was not recorded after entering official mode.",
        permissionGuidance: null,
      };
      if (officialMainPid !== null) {
        result = await requestCodexNativeUpdate(selection.selectedDesktopPath, officialMainPid);
      }
      if (!result.ok) {
        showUpdateModePausedAlert(selection.selectedDesktopPath, baseline.marketingVersion, result);
        return result;
      }
      showUpdateModePausedAlert(selection.selectedDesktopPath, baseline.marketingVersion);
      return result;
    }),
    waitForVersionChange: overrides.waitForVersionChange ?? ((input) => waitForVersionChange(
      input,
      readDesktopVersion,
      () => {
        const latest = readDesktopUpdateReceipt(stateFile);
        return latest?.transactionId === input.transactionId
          && latest.phase === "failed"
          && !latest.resumable;
      },
    )),
    beforeNativeWaitTransition: overrides.beforeNativeWaitTransition,
    refreshEnvironmentTruth: overrides.refreshEnvironmentTruth ?? ((current) => {
      const capabilities = environmentPreparationCapabilities();
      const managedAlpha = inspectManagedAlphaBackend(root);
      const loaded = loadEnvironmentState({
        legacyStateFile: installerStateFile,
        registryFile: environmentRegistryFile,
        selectionFile: environmentSelectionFile,
        environmentRoot: root,
        // Before the first schema-1 selection has been published, loading
        // environment truth migrates the legacy mode in memory. Reuse the
        // transaction's captured timestamp so a profile refresh cannot turn
        // the same source environment into a timestamp-distinct selection.
        now: current.requestedAt,
        stableEvidence: {
          patchedPayloadBuildable: capabilities.patchedPayloadBuildable,
        },
        alphaEvidence: {
          backendInstallable: capabilities.backendInstallable,
          patchedPayloadBuildable: capabilities.patchedPayloadBuildable,
        },
      }, {
        inspectProfile: (profile, current) => {
          const evidence = inspectEnvironmentProfile(profile, current);
          if (profile.releaseProfile === "alpha") {
            evidence.backendVersion = managedAlpha.installed ? managedAlpha.version : null;
            evidence.backendFingerprint = managedAlpha.installed ? managedAlpha.fingerprint : null;
          }
          return evidence;
        },
      });
      writeEnvironmentProfileRegistry(environmentRegistryFile, loaded.registry);
      return loaded.current;
    }),
    selectRefreshSource: overrides.selectRefreshSource ?? (() => (
      preferredDesktopRefreshSource(getLocalRefreshStatus(root))
    )),
    refreshTweakers: overrides.refreshTweakers ?? runSynchronousLocalRefresh,
    verifyFinal: overrides.verifyFinal ?? ((input) => verifyFinalDesktopReturn(
      input,
      environmentSelectionFile,
      join(root, "environment-runtime-proof.json"),
      join(root, "config.json"),
    )),
    recoverVerifiedOfficialUpdate: overrides.recoverVerifiedOfficialUpdate ?? ((input) => (
      adoptVerifiedOfficialUpdate(input, {
        root,
        installerStateFile,
        environmentRegistryFile,
        environmentSelectionFile,
        environmentTransactionFile,
        environmentReceiptRoot,
        environmentLockFile,
        runtimeProofFile: join(root, "environment-runtime-proof.json"),
        now: now(),
      })
    )),
    processAlive: overrides.processAlive ?? isProcessAlive,
    readProcessStartToken: overrides.readProcessStartToken ?? readProcessStartToken,
    now,
    createId: overrides.createId ?? randomUUID,
    createOwnerGeneration: overrides.createOwnerGeneration ?? randomUUID,
    createModeCacheGenerationId: overrides.createModeCacheGenerationId ?? randomUUID,
  };

  const persist = (
    receipt: DesktopUpdateReceipt,
    terminal = false,
    event?: DesktopUpdateLogEvent,
  ): DesktopUpdateReceipt => {
    const previous = readDesktopUpdateReceipt(stateFile);
    writeDesktopUpdateReceipt(stateFile, receipt);
    if (terminal) writeDesktopUpdateReceipt(join(receiptRoot, `${receipt.transactionId}.json`), receipt);
    if (receipt.phase === "awaiting_native_update"
      && receipt.ownerToken
      && receipt.ownerGeneration) {
      writeDesktopUpdateHeartbeat(heartbeatFile, {
        schemaVersion: 1,
        transactionId: receipt.transactionId,
        ownerPid: receipt.ownerPid,
        ownerToken: receipt.ownerToken,
        ownerGeneration: receipt.ownerGeneration,
        phase: receipt.phase,
        beatAt: deps.now(),
      });
    } else {
      removeDesktopUpdateHeartbeat(heartbeatFile);
    }
    const transitionEvent = event
      ?? (previous === null || previous.ownerGeneration !== receipt.ownerGeneration
        ? "owner_started"
        : terminal
          ? receipt.phase === "completed" ? "owner_completed" : "handled_failure"
          : previous.phase !== receipt.phase ? "phase_transition" : null);
    if (transitionEvent !== null) {
      appendDesktopUpdateLog(logFile, {
        transactionId: receipt.transactionId,
        phase: receipt.phase,
        ownerPid: receipt.ownerPid,
        ownerToken: receipt.ownerToken ?? null,
        ownerGeneration: receipt.ownerGeneration ?? null,
        event: transitionEvent,
        ...(receipt.error === null ? {} : { error: receipt.error }),
        jobLabel: options.jobLabel
          ?? process.env.TWEAKERS_DESKTOP_UPDATE_JOB_LABEL
          ?? null,
        phaseElapsedMs: previous === null || previous.transactionId !== receipt.transactionId
          ? null
          : Date.parse(receipt.updatedAt) - Date.parse(previous.updatedAt),
      }, {
        now: deps.now,
        userRoot: root,
      });
    }
    return receipt;
  };

  const update = (
    receipt: DesktopUpdateReceipt,
    patch: Partial<DesktopUpdateReceipt>,
    terminal = false,
  ): DesktopUpdateReceipt => {
    const updatedAt = deps.now();
    const updated: DesktopUpdateReceipt = { ...receipt, ...patch, updatedAt };
    if (terminal) {
      updated.terminalAt = receipt.terminalAt
        ?? patch.terminalAt
        ?? patch.completedAt
        ?? patch.rolledBackAt
        ?? updatedAt;
      updated.continuationAbandonedAt ??= null;
    } else if (isTerminalDesktopUpdatePhase(receipt.phase)
      && !isTerminalDesktopUpdatePhase(updated.phase)) {
      // A resumed continuation creates a new outcome. Its next terminal
      // transition receives a new immutable causal timestamp.
      updated.terminalAt = null;
      updated.continuationAbandonedAt = null;
      updated.completedAt = null;
      updated.rolledBackAt = null;
    }
    return persist(updated, terminal);
  };

  const status = (): DesktopUpdateReceipt | null => readDesktopUpdateReceipt(stateFile);

  async function start(): Promise<DesktopUpdateReceipt> {
    return withLifecycleLock(lifecycleLockFile, "desktop update", startUnlocked);
  }

  async function startUnlocked(): Promise<DesktopUpdateReceipt> {
    assertInstallerUpdateQuarantineClear(root, "desktop-update");
    assertLifecycleReceiptsIdle(root, { contextOwned: false });
    const receipt = await withDesktopUpdateLock(lockFile, async () => {
      const existing = status();
      if (existing?.resumable) {
        throw new Error(
          `Desktop update ${existing.transactionId} is resumable from ${existing.phase}; resume or cancel it before starting another update`,
        );
      }
      if (existing && !isTerminalDesktopUpdatePhase(existing.phase)) {
        throw new Error(`Desktop update ${existing.transactionId} is already ${existing.phase}`);
      }
      const source = await deps.readCurrentSelection();
      if (!source) throw new Error("No current environment selection is available");
      await assertRequestedDesktopApp(options.appPath, source, deps.readDesktopBundleIdentifier);
      const baseline = await deps.readDesktopVersion(source.selectedDesktopPath);
      if (baseline.marketingVersion === null && baseline.build === null) {
        throw new Error(
          `Cannot start desktop update because both the ChatGPT version and build are unreadable at ${source.selectedDesktopPath}. No transaction was created.`,
        );
      }
      const profile = resolveEnvironmentProfile(defaultEnvironmentProfileRegistry(), source.releaseProfile);
      const official = createEnvironmentSelection({
        profile: {
          ...profile,
          selectedDesktopPath: source.selectedDesktopPath,
          selectedDesktopBundleId: source.selectedDesktopBundleId,
        },
        appExperience: "chatgpt",
        requestedAt: deps.now(),
      });
      const now = deps.now();
      const ownerToken = deps.readProcessStartToken(process.pid);
      if (!ownerToken) {
        throw new Error(`Cannot establish a stable process identity for desktop update owner PID ${process.pid}`);
      }
      // Advisory appcast pre-check before any environment swap: when the
      // signed feed unambiguously proves the installed build is current, the
      // whole update (two environment swaps + a native wait + a runtime
      // refresh) is a no-op and completes here in seconds. Every ambiguous or
      // failed probe falls open into the unchanged native updater flow.
      const probe = await deps.probeAppcast!({ appPath: source.selectedDesktopPath, baseline });
      const created = persist({
        schemaVersion: DESKTOP_UPDATE_SCHEMA_VERSION,
        kind: "desktop-update",
        transactionId: deps.createId(),
        phase: "preparing",
        ownerPid: process.pid,
        ownerToken,
        ownerGeneration: deps.createOwnerGeneration(),
        source,
        official,
        baseline,
        observed: null,
        nativeUpdateHandoffAt: null,
        refreshSource: null,
        environmentTransactionId: null,
        environmentTransactionKind: null,
        officialMainPid: null,
        safeOfficialMode: false,
        resumable: false,
        error: null,
        createdAt: now,
        updatedAt: now,
        terminalAt: null,
        continuationAbandonedAt: null,
        completedAt: null,
        rolledBackAt: null,
      });
      appendDesktopUpdateLog(logFile, {
        transactionId: created.transactionId,
        phase: created.phase,
        ownerPid: created.ownerPid,
        ownerToken: created.ownerToken ?? null,
        ownerGeneration: created.ownerGeneration ?? null,
        event: "appcast_probe",
        detail: probe.detail,
        jobLabel: options.jobLabel ?? process.env.TWEAKERS_DESKTOP_UPDATE_JOB_LABEL ?? null,
      }, { now: deps.now, userRoot: root });
      if (probe.state === "current") {
        return update(created, {
          phase: "completed",
          safeOfficialMode: created.source.appExperience === "chatgpt",
          resumable: false,
          error: null,
          completedAt: deps.now(),
        }, true);
      }
      return created;
    });
    if (receipt.phase === "completed") return receipt;
    return switchToOfficial(receipt);
  }

  async function switchToOfficial(initial: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    let receipt = update(initial, { phase: "switching_to_chatgpt", error: null });
    try {
      // A local refresh can atomically replace both the patched payload and
      // pristine backup. Recompute their fingerprints immediately before
      // preparation so the coordinator never validates fresh artifacts
      // against a stale registry snapshot.
      await deps.refreshEnvironmentTruth(receipt.source);
    } catch (error) {
      return update(receipt, {
        phase: "failed",
        error: `Could not verify the current desktop environment: ${errorMessage(error)}`,
      }, true);
    }

    if (deps.modeCacheV2 !== null) {
      if (receipt.source.appExperience === "chatgpt") {
        try {
          const live = await deps.inspectLiveOfficialDesktop(receipt.official);
          receipt = update(receipt, {
            phase: "awaiting_native_update",
            official: receipt.source,
            safeOfficialMode: true,
            resumable: true,
            officialMainPid: live.mainPid,
          });
          return handoffAndAwaitNativeUpdate(receipt);
        } catch (error) {
          return update(receipt, {
            phase: "failed",
            safeOfficialMode: false,
            resumable: false,
            error: `Could not prove the current official desktop: ${errorMessage(error)}`,
          }, true);
        }
      }

      // A refresh (or any invalidation) releases the current generation's
      // grant, and a released or mismatched pair can never bind this
      // transition — failing on it made every post-refresh update dead on
      // arrival (live failures 2026-08-19/20). Reuse the current pair only
      // when it still binds; otherwise prepare a fresh sealed pair, exactly
      // as the return leg already does.
      const pair = deps.modeCacheV2.current();
      const reusableGenerationId = desktopUpdateModeCachePairBinds(pair, receipt.source, receipt.official)
        ? pair.generationId
        : null;
      const generationId = reusableGenerationId ?? deps.createModeCacheGenerationId();
      receipt = update(receipt, {
        environmentTransactionId: generationId,
        environmentTransactionKind: "mode-cache-v2",
      });
      try {
        const request = {
          current: receipt.source,
          requested: receipt.official,
          transactionId: generationId,
          approvalAt: receipt.createdAt,
        };
        const switched = reusableGenerationId !== null
          ? await deps.modeCacheV2.switchCurrent(request)
          : await deps.modeCacheV2.prepareAndSwitch(request);
        if (switched.phase !== "ready"
          || switched.selection === null
          || switched.targetMainPid === null) {
          return modeCacheFailure(receipt, switched, false);
        }
        receipt = update(receipt, {
          phase: "awaiting_native_update",
          official: switched.selection,
          safeOfficialMode: true,
          resumable: true,
          officialMainPid: switched.targetMainPid,
        });
        return handoffAndAwaitNativeUpdate(receipt);
      } catch (error) {
        let liveOfficial: LiveOfficialDesktopObservation | null = null;
        try {
          liveOfficial = await deps.inspectLiveOfficialDesktop(receipt.official);
        } catch {
          // The caught switch error remains authoritative unless independent
          // live proof establishes a safe official continuation.
        }
        return update(receipt, {
          phase: "failed",
          officialMainPid: liveOfficial?.mainPid ?? receipt.officialMainPid ?? null,
          safeOfficialMode: liveOfficial !== null,
          resumable: liveOfficial !== null,
          error: errorMessage(error),
        }, true);
      }
    }

    try {
      const prepared = await deps.environment.prepare({ current: receipt.source, requested: receipt.official });
      receipt = update(receipt, {
        environmentTransactionId: prepared.transactionId,
        environmentTransactionKind: "legacy",
      });
      const committed = await deps.environment.commit(prepared.transactionId);
      if (committed.phase !== "committed") return environmentFailure(receipt, committed, false);
      receipt = update(receipt, {
        phase: "awaiting_native_update",
        official: committed.requested,
        safeOfficialMode: true,
        resumable: true,
        officialMainPid: committed.newMainPid,
      });
      return handoffAndAwaitNativeUpdate(receipt);
    } catch (error) {
      const failedPreparation = receipt.environmentTransactionId === null
        ? correlatedFailedPreparation(receipt, deps.environment.status())
        : null;
      return update(receipt, {
        phase: "failed",
        environmentTransactionId: receipt.environmentTransactionId ?? failedPreparation?.transactionId ?? null,
        environmentTransactionKind: receipt.environmentTransactionKind
          ?? (failedPreparation === null ? null : "legacy"),
        resumable: receipt.safeOfficialMode,
        error: errorMessage(error),
      }, true);
    }
  }

  async function handoffAndAwaitNativeUpdate(initial: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    try {
      const result = await deps.initiateNativeUpdate({
        transactionId: initial.transactionId,
        selection: initial.official,
        baseline: initial.baseline,
        officialMainPid: initial.officialMainPid ?? null,
      });
      if (result && !result.ok && !RECOVERABLE_NATIVE_HANDOFF_KINDS.has(result.kind)) {
        return update(initial, {
          phase: "failed",
          safeOfficialMode: true,
          resumable: true,
          error: `Native updater handoff failed: ${result.message}`,
        }, true);
      }
      const handoff = result && !result.ok
        ? persist({
          ...initial,
          error: `Native updater handoff warning: ${result.message}`,
          updatedAt: deps.now(),
        }, false, "handoff_result")
        : persist({
          ...initial,
          nativeUpdateHandoffAt: deps.now(),
          updatedAt: deps.now(),
        }, false, "handoff_result");
      return awaitNativeUpdate(handoff);
    } catch (error) {
      return update(initial, {
        phase: "failed",
        safeOfficialMode: true,
        resumable: true,
        error: `Native updater handoff failed: ${errorMessage(error)}`,
      }, true);
    }
  }

  async function awaitNativeUpdate(initial: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    const observed = await deps.waitForVersionChange({
      transactionId: initial.transactionId,
      appPath: initial.official.selectedDesktopPath,
      baseline: initial.baseline,
      timeoutMs,
      pollIntervalMs,
    });
    await deps.beforeNativeWaitTransition?.();
    const transitioned = await withDesktopUpdateLock(lockFile, async () => {
      const latest = status();
      if (!latest || latest.transactionId !== initial.transactionId) {
        throw new Error(`Desktop update ${initial.transactionId} changed before its native wait could be recorded`);
      }
      // A cancellation or another exact continuation that won the lock is
      // authoritative. Never write the waiter's stale snapshot over it.
      if (latest.phase !== "awaiting_native_update") return { receipt: latest, shouldContinue: false };
      if (observed === null) {
        return {
          receipt: update(latest, {
            phase: "failed",
            safeOfficialMode: true,
            resumable: true,
            error: "The official update did not complete before the timeout. ChatGPT remains safely in official mode."
              + (latest.error ? ` Earlier: ${latest.error}` : ""),
          }, true),
          shouldContinue: false,
        };
      }
      if (!desktopVersionAdvanced(latest.baseline, observed)) {
        return {
          receipt: update(latest, {
            phase: "failed",
            safeOfficialMode: true,
            resumable: true,
            error: "The observed desktop version/build did not advance. ChatGPT remains safely in official mode.",
          }, true),
          shouldContinue: false,
        };
      }
      return {
        receipt: update(latest, {
          phase: latest.source.appExperience === "chatgpt" ? "verifying" : "returning_to_tweakers",
          observed,
          resumable: false,
          error: null,
        }),
        shouldContinue: true,
      };
    });
    return transitioned.shouldContinue
      ? returnToRequestedEnvironment(transitioned.receipt)
      : transitioned.receipt;
  }

  async function returnToRequestedEnvironment(initial: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    if (!initial.observed) throw new Error("Desktop update observation is missing");
    const observed = initial.observed;

    if (initial.environmentTransactionKind === "mode-cache-v2"
      && initial.environmentTransactionId !== null
      && deps.modeCacheV2 !== null) {
      const pair = deps.modeCacheV2.current();
      const current = await deps.readCurrentSelection();
      if (pairProvesLiveEnvironment(
        pair,
        current,
        initial.source,
        initial.environmentTransactionId,
        observed,
      )) {
        const provenCurrent = current!;
        const receipt = initial.phase === "verifying" && initial.error === null
          ? initial
          : update(initial, {
            phase: "verifying",
            source: provenCurrent,
            resumable: false,
            error: null,
          });
        return verifyAndComplete(receipt, provenCurrent, null, pair);
      }
    }

    // A resume may arrive after environment recovery proved the REQUESTED
    // Tweakers environment live (the return leg's commit had landed before
    // the original owner failed). The official app is not running in that
    // state, so refreshing official truth or re-preparing the return would
    // fabricate a safeOfficialMode failure that contradicts the published
    // selection. Only the runtime refresh and final verification remain; run
    // exactly those. This must precede the official-truth refresh below.
    const recoveredCommit = initial.environmentTransactionKind === "mode-cache-v2"
      || initial.environmentTransactionId === null
      ? null
      : deps.environment.status();
    if (recoveredCommit !== null
      && recoveredCommit.transactionId === initial.environmentTransactionId
      && recoveredCommit.phase === "committed"
      && initial.source.appExperience === "tweakers"
      && recoveredCommit.requested.appExperience === "tweakers") {
      const receipt = initial.phase === "returning_to_tweakers" && initial.error === null
        ? initial
        : update(initial, { phase: "returning_to_tweakers", resumable: false, error: null });
      try {
        return await refreshRuntimeAndVerify(receipt, recoveredCommit.requested, recoveredCommit.newMainPid, observed);
      } catch (error) {
        // Tweakers is proven live, so this failure is explicitly NOT a safe
        // official-mode state; fail closed for supervised recovery.
        return update(status() ?? receipt, {
          phase: "failed",
          safeOfficialMode: false,
          resumable: false,
          error: errorMessage(error),
        }, true);
      }
    }

    let refreshedOfficial: EnvironmentSelection | null = null;
    try {
      refreshedOfficial = (await deps.refreshEnvironmentTruth(initial.official)) ?? null;
      if (refreshedOfficial !== null
        && !sameEnvironmentSelection(refreshedOfficial, initial.official)) {
        throw new Error("Refreshed environment truth does not match the proved official ChatGPT selection");
      }
    } catch (error) {
      return update(initial, {
        phase: "failed",
        safeOfficialMode: true,
        resumable: true,
        error: `Could not verify the updated desktop environment: ${errorMessage(error)}`,
      }, true);
    }
    const reconciled = refreshedOfficial === null
      ? initial
      : update(initial, { official: refreshedOfficial });
    if (reconciled.source.appExperience === "chatgpt") {
      return verifyAndComplete(
        reconciled.phase === "verifying" ? reconciled : update(reconciled, { phase: "verifying" }),
        reconciled.official,
        reconciled.officialMainPid ?? null,
      );
    }

    let receipt = reconciled.phase === "returning_to_tweakers"
      ? reconciled
      : update(reconciled, { phase: "returning_to_tweakers", resumable: false });

    if (deps.modeCacheV2 !== null) {
      const requested = {
        ...receipt.source,
        requestedAt: deps.now(),
        appliedAt: null,
      };
      const generationId = deps.createModeCacheGenerationId();
      const refreshSource = await deps.selectRefreshSource();
      receipt = update(receipt, {
        phase: "refreshing_runtime",
        refreshSource,
        environmentTransactionId: generationId,
        environmentTransactionKind: "mode-cache-v2",
      });
      try {
        const switched = await deps.modeCacheV2.prepareAndSwitch({
          current: receipt.official,
          requested,
          transactionId: generationId,
          approvalAt: receipt.createdAt,
        });
        if (switched.phase !== "ready"
          || switched.selection === null
          || switched.targetMainPid === null
          || switched.pair === null) {
          return modeCacheFailure(receipt, switched, true);
        }
        receipt = update(receipt, {
          phase: "verifying",
          source: switched.selection,
        });
        return verifyAndComplete(receipt, switched.selection, switched.targetMainPid, switched.pair);
      } catch (error) {
        const latest = status() ?? receipt;
        const pair = deps.modeCacheV2.current();
        const current = await deps.readCurrentSelection();
        let safeOfficial = pairProvesLiveEnvironment(
          pair,
          current,
          latest.official,
          generationId,
          observed,
        );
        let officialMainPid = latest.officialMainPid ?? null;
        if (!safeOfficial) {
          try {
            const live = await deps.inspectLiveOfficialDesktop(latest.official);
            safeOfficial = true;
            officialMainPid = live.mainPid;
          } catch {
            // Keep the generation proof result. A failed preparation is only
            // resumable when either the pair or live pristine-app proof says
            // official ChatGPT remains safe.
          }
        }
        return update(latest, {
          phase: "failed",
          officialMainPid,
          safeOfficialMode: safeOfficial,
          resumable: safeOfficial,
          error: errorMessage(error),
        }, true);
      }
    }

    let returnTransactionId: string | null = null;
    try {
      const requested = {
        ...receipt.source,
        requestedAt: deps.now(),
        appliedAt: null,
      };
      const prepared = await deps.environment.prepare({ current: receipt.official, requested });
      returnTransactionId = prepared.transactionId;
      receipt = update(receipt, {
        environmentTransactionId: returnTransactionId,
        environmentTransactionKind: "legacy",
      });
      const committed = await deps.environment.commit(returnTransactionId);
      if (committed.phase !== "committed") return environmentFailure(receipt, committed, true);
      return await refreshRuntimeAndVerify(receipt, committed.requested, committed.newMainPid, observed);
    } catch (error) {
      const reason = errorMessage(error);
      // Refresh/verify transitions persist inside refreshRuntimeAndVerify;
      // rebase the failure on the latest persisted receipt so those fields
      // (refreshSource, phase progression) survive into the terminal write.
      receipt = status() ?? receipt;
      if (returnTransactionId) {
        try {
          const rolledBack = await deps.environment.rollback(returnTransactionId);
          if (rolledBack.phase === "rolled-back") {
            return update(receipt, {
              phase: "rolled_back",
              safeOfficialMode: true,
              resumable: true,
              error: reason,
              rolledBackAt: deps.now(),
            }, true);
          }
        } catch (rollbackError) {
          return update(receipt, {
            phase: "failed",
            safeOfficialMode: false,
            resumable: false,
            error: `${reason}; rollback failed: ${errorMessage(rollbackError)}`,
          }, true);
        }
      }
      return update(receipt, { phase: "failed", safeOfficialMode: true, resumable: true, error: reason }, true);
    }
  }

  /**
   * The shared tail of the return-to-Tweakers leg: rebuild the runtime for
   * the requested selection, then verify the final state. Reached from the
   * normal prepare/commit path and from a resume whose return-leg environment
   * transaction was recovered as already committed.
   */
  async function refreshRuntimeAndVerify(
    receiptIn: DesktopUpdateReceipt,
    requestedSelection: EnvironmentSelection,
    newMainPid: number | null,
    observed: DesktopVersionIdentity,
  ): Promise<DesktopUpdateReceipt> {
    const refreshSource = await deps.selectRefreshSource();
    let receipt = update(receiptIn, {
      phase: "refreshing_runtime",
      source: requestedSelection,
      refreshSource,
    });
    await deps.refreshTweakers({ source: refreshSource, selection: requestedSelection, observedDesktop: observed });
    receipt = update(receipt, { phase: "verifying" });
    const verification = await deps.verifyFinal({
      expected: requestedSelection,
      baseline: receipt.baseline,
      observed: receipt.observed!,
      previousMainPid: newMainPid,
      environmentTransactionKind: receipt.environmentTransactionKind ?? null,
      environmentTransactionId: receipt.environmentTransactionId,
      modeCachePair: deps.modeCacheV2?.current() ?? null,
    });
    if (!verification.ok) {
      throw new Error(verification.error ?? "Desktop update verification failed");
    }
    return update(receipt, {
      phase: "completed",
      safeOfficialMode: false,
      resumable: false,
      error: null,
      completedAt: deps.now(),
    }, true);
  }

  async function verifyAndComplete(
    receipt: DesktopUpdateReceipt,
    expected: EnvironmentSelection,
    previousMainPid: number | null,
    modeCachePair: DesktopUpdateModeCachePair | null = deps.modeCacheV2?.current() ?? null,
  ): Promise<DesktopUpdateReceipt> {
    const verification = await deps.verifyFinal({
      expected,
      baseline: receipt.baseline,
      observed: receipt.observed!,
      previousMainPid,
      environmentTransactionKind: receipt.environmentTransactionKind ?? null,
      environmentTransactionId: receipt.environmentTransactionId,
      modeCachePair,
    });
    if (!verification.ok) {
      return update(receipt, {
        phase: "failed",
        safeOfficialMode: expected.appExperience === "chatgpt",
        resumable: expected.appExperience === "chatgpt",
        error: verification.error ?? "Desktop update verification failed",
      }, true);
    }
    return update(receipt, {
      phase: "completed",
      safeOfficialMode: false,
      resumable: false,
      error: null,
      completedAt: deps.now(),
    }, true);
  }

  function environmentFailure(
    receipt: DesktopUpdateReceipt,
    environmentReceipt: EnvironmentTransactionReceipt,
    returning: boolean,
  ): DesktopUpdateReceipt {
    const rolledBack = environmentReceipt.phase === "rolled-back";
    return update(receipt, {
      phase: rolledBack ? "rolled_back" : "failed",
      safeOfficialMode: returning && rolledBack,
      resumable: returning && rolledBack,
      error: environmentReceipt.error ?? `Environment transaction ended in ${environmentReceipt.phase}`,
      rolledBackAt: rolledBack ? deps.now() : null,
    }, true);
  }

  function modeCacheFailure(
    receipt: DesktopUpdateReceipt,
    result: DesktopUpdateModeCacheSwitchResult,
    returning: boolean,
  ): DesktopUpdateReceipt {
    const liveOfficial = pairProvesLiveEnvironment(
      result.pair,
      result.selection,
      receipt.official,
      result.transactionId,
      returning && receipt.observed !== null ? receipt.observed : receipt.baseline,
    );
    const liveSource = pairProvesLiveEnvironment(
      result.pair,
      result.selection,
      receipt.source,
      result.transactionId,
      returning && receipt.observed !== null ? receipt.observed : receipt.baseline,
    );
    return update(receipt, {
      phase: liveSource ? "rolled_back" : "failed",
      safeOfficialMode: liveOfficial,
      resumable: liveOfficial,
      error: result.error ?? `Environment mode-cache transaction ended in ${result.phase}`,
      rolledBackAt: liveSource ? deps.now() : null,
    }, true);
  }

  async function resume(): Promise<DesktopUpdateReceipt> {
    return withLifecycleLock(lifecycleLockFile, "desktop update resume", resumeUnlocked);
  }

  /**
   * Resume can arrive with the official app quit (the user closed ChatGPT
   * after a failed handoff, or clicked Resume the next day). When the only
   * obstacle is a missing or windowless process — the disk proofs (pristine
   * asar, official profile) all passed — launch the exact selected app and
   * re-observe within a bounded window instead of dead-ending the resume.
   */
  async function inspectLiveOfficialDesktopRelaunchingIfNeeded(
    official: EnvironmentSelection,
  ): Promise<LiveOfficialDesktopObservation> {
    let lastError: unknown;
    try {
      return await deps.inspectLiveOfficialDesktop(official);
    } catch (error) {
      if (resumeLaunchWaitMs === 0 || !isRecoverableLiveProcessError(error)) throw error;
      lastError = error;
    }
    deps.launchOfficialDesktop(official);
    const deadline = Date.now() + resumeLaunchWaitMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
      try {
        return await deps.inspectLiveOfficialDesktop(official);
      } catch (error) {
        if (!isRecoverableLiveProcessError(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async function resumeUnlocked(): Promise<DesktopUpdateReceipt> {
    assertInstallerUpdateQuarantineClear(root, "desktop-update-resume");
    const receipt = await withDesktopUpdateLock(lockFile, async () => {
      const existing = status();
      if (!existing) throw new Error("No desktop update exists to resume");
      assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        desktopTransactionId: existing.transactionId,
        environmentTransactionId: existing.environmentTransactionId ?? undefined,
      });
      if (!isTerminalDesktopUpdatePhase(existing.phase)
        && existing.ownerPid !== process.pid
        && deps.processAlive(existing.ownerPid)) {
        throw new Error(`Desktop update owner PID ${existing.ownerPid} is still active`);
      }
      if (!existing.resumable || !existing.safeOfficialMode) {
        throw new Error(
          `Desktop update ${existing.transactionId} is not resumable from ${existing.phase}; cancel it to recover an exited owner`,
        );
      }
      const resumed: DesktopUpdateReceipt = {
        ...existing,
        terminalAt: null,
        continuationAbandonedAt: null,
        completedAt: null,
        rolledBackAt: null,
      };
      // The requested Tweakers environment is proven live (its return-leg
      // transaction committed), so official ChatGPT is NOT running: skip the
      // official inspection — it would throw on the patched asar and stamp a
      // false safeOfficialMode failure. Only the runtime refresh and final
      // verification remain; hand off to the return leg's recovered-commit
      // path.
      const continueFromCommittedTweakers = (): DesktopUpdateReceipt => {
        if (resumed.observed === null) {
          return update(resumed, {
            phase: "failed",
            ownerPid: process.pid,
            safeOfficialMode: false,
            resumable: false,
            error: `Environment recovery proved Tweakers live for ${existing.environmentTransactionId}, `
              + "but the receipt never recorded the observed update version; recover the desktop update explicitly.",
          }, true);
        }
        return update(resumed, {
          phase: "returning_to_tweakers",
          ownerPid: process.pid,
          resumable: false,
          error: null,
        });
      };
      if (existing.environmentTransactionKind === "mode-cache-v2"
        && existing.environmentTransactionId !== null
        && resumed.observed !== null
        && deps.modeCacheV2 !== null) {
        const pair = deps.modeCacheV2.current();
        const current = await deps.readCurrentSelection();
        if (pairProvesLiveEnvironment(
          pair,
          current,
          resumed.source,
          existing.environmentTransactionId,
          resumed.observed,
        )) {
          return continueFromCommittedTweakers();
        }
      }
      const coupledReceipt = existing.environmentTransactionKind === "mode-cache-v2"
        || existing.environmentTransactionId === null
        ? null
        : deps.environment.status();
      const coupledEnvironment = coupledReceipt !== null
        && coupledReceipt.transactionId === existing.environmentTransactionId
        ? coupledReceipt
        : null;
      if (coupledEnvironment !== null
        && environmentReceiptBlocksLifecycle(coupledEnvironment) !== null) {
        // A prior failure stranded this update's own environment transaction
        // mid-rollback. That receipt blocks every lifecycle gate — including
        // the returning leg's fresh prepare — so recover it from live
        // evidence first instead of dead-ending in a recover/resume deadlock
        // where each command tells the user to run the other (hit live
        // 2026-08-07).
        try {
          const recoveredReceipt = await deps.environment.recover(existing.environmentTransactionId!);
          if (recoveredReceipt.phase === "committed"
            && recoveredReceipt.requested.appExperience === "tweakers"
            && resumed.source.appExperience === "tweakers") {
            return continueFromCommittedTweakers();
          }
        } catch (error) {
          // The environment error text usually quotes its own "rollback
          // failed" diagnostic. Reproducing that phrase verbatim would make
          // desktopReceiptBlocksLifecycle misclassify THIS receipt as a
          // desktop-level rollback failure (permanently blocking after a
          // cancel), so neutralize it before persisting.
          const reason = errorMessage(error).replace(/\brollback failed\b/gi, "rollback unsuccessful");
          return update(resumed, {
            phase: "failed",
            ownerPid: process.pid,
            safeOfficialMode: true,
            resumable: true,
            error: `Could not recover environment transaction ${existing.environmentTransactionId} `
              + `before resuming: ${reason}`,
          }, true);
        }
      } else if (coupledEnvironment !== null
        && coupledEnvironment.phase === "committed"
        && coupledEnvironment.requested.appExperience === "tweakers"
        && resumed.source.appExperience === "tweakers") {
        // The user already ran `environment recover` standalone (the gate's
        // coupling allowance exists exactly for that) and it proved the
        // requested Tweakers environment live. Do not inspect official
        // ChatGPT — the same false-safe failure as above would result.
        return continueFromCommittedTweakers();
      }
      let liveOfficial: LiveOfficialDesktopObservation;
      try {
        liveOfficial = await inspectLiveOfficialDesktopRelaunchingIfNeeded(resumed.official);
      } catch (error) {
        return update(resumed, {
          phase: "failed",
          ownerPid: process.pid,
          safeOfficialMode: true,
          resumable: true,
          error: `Could not verify live official ChatGPT before resuming: ${errorMessage(error)}`,
        }, true);
      }

      if (desktopVersionAdvanced(resumed.baseline, liveOfficial.version)) {
        return update(resumed, {
          phase: "returning_to_tweakers",
          ownerPid: process.pid,
          observed: liveOfficial.version,
          officialMainPid: liveOfficial.mainPid,
          resumable: false,
          error: null,
        });
      }
      if (resumed.observed !== null) {
        return update(resumed, {
          phase: "failed",
          ownerPid: process.pid,
          observed: null,
          officialMainPid: liveOfficial.mainPid,
          safeOfficialMode: true,
          resumable: true,
          error: "The live official version/build did not advance from the transaction baseline; refusing to restart into Tweakers.",
        }, true);
      }
      return update(resumed, {
        phase: "awaiting_native_update",
        ownerPid: process.pid,
        officialMainPid: liveOfficial.mainPid,
        resumable: false,
        error: null,
      });
    });
    // Terminal failures from the lock section are final for this resume —
    // check BEFORE observed: several failure writes (e.g. an unrecoverable
    // environment transaction) keep the previously observed version, and
    // re-entering the return leg would clobber their diagnostic with a
    // lifecycle-gate error.
    if (receipt.phase === "failed") return receipt;
    if (receipt.observed) return returnToRequestedEnvironment(receipt);
    return handoffAndAwaitNativeUpdate(receipt);
  }

  async function cancel(): Promise<DesktopUpdateReceipt> {
    let existing = status();
    if (!existing) throw new Error("No desktop update exists to cancel");

    // The native updater wait intentionally holds the lifecycle lease while it
    // polls. Cancellation may bypass that lease only when the desktop receipt
    // is still authoritatively in that exact wait phase under its own lock.
    // If the waiter already advanced, fall back to the ordinary lifecycle path
    // so an active same-process continuation cannot be mistaken for a dead
    // owner and rolled back underneath itself.
    if (existing.phase === "awaiting_native_update") {
      const cancelled = await cancelAwaitingNativeWait(existing.transactionId);
      if (cancelled) return cancelled;
      const latest = status();
      if (!latest) throw new Error("No desktop update exists to cancel");
      if (latest.transactionId !== existing.transactionId) {
        throw new Error(
          `Desktop update changed from ${existing.transactionId} to ${latest.transactionId}; refusing to cancel a different transaction`,
        );
      }
      existing = latest;
    }

    if (!isTerminalDesktopUpdatePhase(existing.phase)
      && deps.processAlive(existing.ownerPid)) {
      throw new Error(`Desktop update owner PID ${existing.ownerPid} is still active`);
    }

    return withLifecycleLock(
      lifecycleLockFile,
      "desktop update cancel",
      () => cancelUnlocked(existing.transactionId),
    );
  }

  async function cancelAwaitingNativeWait(
    expectedTransactionId: string,
  ): Promise<DesktopUpdateReceipt | null> {
    return withDesktopUpdateLock(lockFile, async () => {
      const existing = status();
      if (!existing) throw new Error("No desktop update exists to cancel");
      if (existing.transactionId !== expectedTransactionId) {
        throw new Error(
          `Desktop update changed from ${expectedTransactionId} to ${existing.transactionId}; refusing to cancel a different transaction`,
        );
      }
      if (existing.phase !== "awaiting_native_update") return null;
      assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        desktopTransactionId: existing.transactionId,
        environmentTransactionId: existing.environmentTransactionId ?? undefined,
      });
      return update(existing, {
        phase: "failed",
        ownerPid: process.pid,
        safeOfficialMode: true,
        resumable: false,
        error: "Desktop update was cancelled; ChatGPT remains in official mode.",
      }, true);
    });
  }

  async function cancelUnlocked(expectedTransactionId: string): Promise<DesktopUpdateReceipt> {
    return withDesktopUpdateLock(lockFile, async () => {
      const existing = status();
      if (!existing) throw new Error("No desktop update exists to cancel");
      if (existing.transactionId !== expectedTransactionId) {
        throw new Error(
          `Desktop update changed from ${expectedTransactionId} to ${existing.transactionId}; refusing to cancel a different transaction`,
        );
      }
      assertLifecycleReceiptsIdle(root, {
        contextOwned: false,
        desktopTransactionId: existing.transactionId,
        environmentTransactionId: existing.environmentTransactionId ?? undefined,
      });
      if (existing.phase !== "awaiting_native_update"
        && !isTerminalDesktopUpdatePhase(existing.phase)
        && existing.ownerPid !== process.pid
        && deps.processAlive(existing.ownerPid)) {
        throw new Error(`Desktop update owner PID ${existing.ownerPid} is still active`);
      }
      if (existing.phase === "awaiting_native_update") {
        return update(existing, {
          phase: "failed",
          ownerPid: process.pid,
          safeOfficialMode: true,
          resumable: false,
          error: "Desktop update was cancelled; ChatGPT remains in official mode.",
        }, true);
      }

      if ((existing.phase === "failed" || existing.phase === "rolled_back")
        && existing.resumable) {
        // This action abandons a recovery continuation; it does not replace
        // the failure that made recovery necessary. Preserve the causal phase
        // and diagnostic verbatim so the durable receipt remains useful after
        // its last available continuation is dismissed.
        return update(existing, {
          ownerPid: process.pid,
          resumable: false,
          // A legacy schema-v1 failure has no terminalAt. Freeze its last
          // causal update before recording the later abandonment separately.
          terminalAt: existing.terminalAt ?? existing.rolledBackAt ?? existing.updatedAt,
          continuationAbandonedAt: deps.now(),
        }, true);
      }

      if (existing.phase === "preparing") {
        return update(existing, {
          phase: "rolled_back",
          ownerPid: process.pid,
          safeOfficialMode: existing.source.appExperience === "chatgpt",
          resumable: false,
          error: "Desktop update recovery cancelled before environment preparation began.",
          rolledBackAt: deps.now(),
        }, true);
      }

      const recoverableActive = existing.phase === "switching_to_chatgpt"
        || existing.phase === "returning_to_tweakers"
        || existing.phase === "refreshing_runtime"
        || existing.phase === "verifying";
      const recoverableUnsafeFailure = existing.phase === "failed"
        && !existing.safeOfficialMode
        && existing.environmentTransactionId !== null;
      if (!recoverableActive && !recoverableUnsafeFailure) {
        throw new Error(
          `Desktop update ${existing.transactionId} cannot be safely cancelled from ${existing.phase}`,
        );
      }

      return recoverExitedOwner(existing);
    });
  }

  async function recoverExitedOwner(existing: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    const returning = existing.observed !== null
      || existing.phase === "returning_to_tweakers"
      || existing.phase === "refreshing_runtime"
      || existing.phase === "verifying";
    if (existing.environmentTransactionKind === "mode-cache-v2") {
      if (deps.modeCacheV2 === null || existing.environmentTransactionId === null) {
        return unsafeRecoveryFailure(existing, "sealed-pair recovery is not available for the recorded generation");
      }
      try {
        const recovered = await deps.modeCacheV2.recover(existing.environmentTransactionId);
        if (recovered.phase !== "ready" && recovered.phase !== "stale_requires_prepare") {
          return unsafeRecoveryFailure(
            existing,
            recovered.error ?? `sealed-pair recovery ended in ${recovered.phase}`,
          );
        }
        const liveOfficial = pairProvesLiveEnvironment(
          recovered.pair,
          recovered.selection,
          existing.official,
          existing.environmentTransactionId,
          existing.observed ?? existing.baseline,
        );
        const liveSource = pairProvesLiveEnvironment(
          recovered.pair,
          recovered.selection,
          existing.source,
          existing.environmentTransactionId,
          returning && existing.observed !== null ? existing.observed : existing.baseline,
        );
        if (!liveOfficial && !liveSource) {
          // A released sealed pair can never prove liveness through its grant.
          // When the recovery returned terminal history and the update never
          // reached the official leg, prove the untouched source payload
          // directly from durable bytes: the published selection, the bundle
          // identity, the recorded baseline version, and the asar patch
          // marker together rule out a half-swapped desktop (live wedge
          // 2026-08-20 behind a stale invalidated grant).
          if (!returning && await sourceSelectionProvenByBytes(existing, recovered.selection, deps)) {
            return update(existing, {
              phase: "rolled_back",
              ownerPid: process.pid,
              safeOfficialMode: existing.source.appExperience === "chatgpt",
              resumable: false,
              error: "Desktop update owner exited; the sealed pair was terminal history and the source payload was proven live by its published selection, patch marker, and version identity.",
              rolledBackAt: deps.now(),
            }, true);
          }
          return unsafeRecoveryFailure(existing, "sealed-pair recovery did not prove either bound environment live");
        }
        return update(existing, {
          phase: "rolled_back",
          ownerPid: process.pid,
          source: liveSource ? recovered.selection! : existing.source,
          official: liveOfficial ? recovered.selection! : existing.official,
          safeOfficialMode: liveOfficial,
          resumable: liveOfficial,
          error: liveOfficial
            ? "Desktop update owner exited; sealed-pair recovery proved official ChatGPT live."
            : "Desktop update owner exited; sealed-pair recovery proved the source environment live.",
          rolledBackAt: deps.now(),
        }, true);
      } catch (error) {
        return unsafeRecoveryFailure(existing, `sealed-pair recovery failed: ${errorMessage(error)}`);
      }
    }
    const observedEnvironmentReceipt = deps.environment.status();
    // Without a recorded ID, only an in-flight environment receipt can belong
    // to the crash window between prepare() persisting and returning its ID.
    // A terminal receipt may be historical and must never be rolled back as if
    // this desktop update owned it.
    const environmentReceipt = existing.environmentTransactionId === null
      && observedEnvironmentReceipt !== null
      && ["committed", "rolled-back", "failed", "cancelled"].includes(observedEnvironmentReceipt.phase)
      ? null
      : observedEnvironmentReceipt;

    if (environmentReceipt === null) {
      if (existing.environmentTransactionId === null
        && (existing.phase === "switching_to_chatgpt" || existing.phase === "returning_to_tweakers")) {
        return update(existing, {
          phase: "rolled_back",
          ownerPid: process.pid,
          safeOfficialMode: returning || existing.source.appExperience === "chatgpt",
          resumable: returning && existing.observed !== null,
          error: returning
            ? "Desktop update recovery cancelled before the return environment was prepared; ChatGPT remains in official mode."
            : "Desktop update recovery cancelled before the official environment was prepared.",
          rolledBackAt: deps.now(),
        }, true);
      }
      return unsafeRecoveryFailure(existing, "environment transaction state is missing");
    }

    if (existing.environmentTransactionId !== null
      && environmentReceipt.transactionId !== existing.environmentTransactionId) {
      return unsafeRecoveryFailure(
        existing,
        `environment transaction ${environmentReceipt.transactionId} does not match ${existing.environmentTransactionId}`,
      );
    }

    const rollbackFailed = environmentReceipt.phase === "failed"
      && /\brollback failed\b/i.test(environmentReceipt.error ?? "");
    const alreadyAdoptedOfficial = environmentReceipt.phase === "cancelled"
      && (environmentReceipt.error ?? "").startsWith(OFFICIAL_ADOPTION_MESSAGE);
    if (rollbackFailed || alreadyAdoptedOfficial) {
      if (environmentReceipt.ownerPid !== process.pid
        && deps.processAlive(environmentReceipt.ownerPid)) {
        return unsafeRecoveryFailure(
          existing,
          `environment transaction owner PID ${environmentReceipt.ownerPid} is still active`,
        );
      }
      const failedBeforeFirstReopen = rollbackFailed
        && returning
        && environmentReceipt.attempt === 0
        && environmentReceipt.applied == null
        && environmentReceipt.newMainPid === null
        && sameEnvironmentSelection(environmentReceipt.source, existing.official)
        && sameEnvironmentSelection(environmentReceipt.requested, existing.source);
      if (failedBeforeFirstReopen) {
        try {
          const recovered = await deps.environment.rollback(environmentReceipt.transactionId);
          if ((recovered.phase === "cancelled" || recovered.phase === "rolled-back")
            && recovered.applied !== null
            && sameEnvironmentSelection(recovered.applied.selection, existing.official)) {
            return update(existing, {
              phase: "rolled_back",
              ownerPid: process.pid,
              safeOfficialMode: true,
              resumable: existing.observed !== null,
              error: "Desktop update owner exited; the environment was recovered to safe official mode.",
              rolledBackAt: deps.now(),
            }, true);
          }
        } catch {
          // If exact-source proof cannot recover this attempt-zero failure,
          // retain the existing independently verified official-adoption path.
        }
      }
      // Switching-leg twin of failedBeforeFirstReopen: the owner died before
      // any cutover on the way TO official ChatGPT, so the proven-live target
      // is the original source environment, not official mode.
      const failedBeforeFirstSwapProven = rollbackFailed
        && !returning
        && environmentReceipt.attempt === 0
        && environmentReceipt.applied == null
        && environmentReceipt.newMainPid === null
        && sameEnvironmentSelection(environmentReceipt.source, existing.source)
        && sameEnvironmentSelection(environmentReceipt.requested, existing.official);
      if (failedBeforeFirstSwapProven) {
        try {
          const recovered = await deps.environment.rollback(environmentReceipt.transactionId);
          if ((recovered.phase === "cancelled" || recovered.phase === "rolled-back")
            && recovered.applied !== null
            && sameEnvironmentSelection(recovered.applied.selection, existing.source)) {
            return update(existing, {
              phase: "rolled_back",
              ownerPid: process.pid,
              safeOfficialMode: existing.source.appExperience === "chatgpt",
              resumable: false,
              error: "Desktop update owner exited before cutover; the source environment was proven live and the update was rolled back.",
              rolledBackAt: deps.now(),
            }, true);
          }
        } catch {
          // If exact-source proof cannot recover this attempt-zero failure,
          // retain the existing independently verified official-adoption path.
        }
      }
      try {
        const adopted = await deps.recoverVerifiedOfficialUpdate({
          receipt: existing,
          environmentReceipt,
        });
        if (adopted !== null) {
          return update(existing, {
            phase: "completed",
            ownerPid: process.pid,
            official: adopted.selection,
            observed: adopted.observed,
            officialMainPid: adopted.mainPid,
            safeOfficialMode: false,
            resumable: false,
            error: null,
            completedAt: deps.now(),
          }, true);
        }
      } catch (error) {
        return unsafeRecoveryFailure(
          existing,
          `verified official update adoption failed: ${errorMessage(error)}`,
        );
      }
    }

    if (rollbackFailed) {
      return unsafeRecoveryFailure(
        existing,
        environmentReceipt.error ?? "environment rollback failed",
      );
    }

    try {
      let recovered: EnvironmentTransactionReceipt;
      const failedBeforePreparationCompleted = environmentReceipt.phase === "failed"
        && environmentReceipt.attempt === 0
        && environmentReceipt.prepared == null
        && environmentReceipt.applied == null;
      const failedInitialPreparation = failedBeforePreparationCompleted
        && !returning
        && sameEnvironmentSelection(environmentReceipt.source, existing.source)
        && sameEnvironmentSelection(environmentReceipt.requested, existing.official);
      const failedReturnPreparation = failedBeforePreparationCompleted
        && returning
        && sameEnvironmentSelection(environmentReceipt.source, existing.official)
        && sameEnvironmentSelection(environmentReceipt.requested, existing.source);
      if (failedInitialPreparation || failedReturnPreparation) {
        // Environment preparation never cuts over. A correlated attempt-zero
        // failure proves the original source selection was left in place. On
        // the return leg that source is already-proven official ChatGPT.
        recovered = environmentReceipt;
      } else if (environmentReceipt.phase === "preparing" || environmentReceipt.phase === "prepared") {
        recovered = await deps.environment.cancel(environmentReceipt.transactionId);
        if (recovered.phase !== "cancelled") {
          return unsafeRecoveryFailure(existing, `environment cancellation ended in ${recovered.phase}`);
        }
      } else if (environmentReceipt.phase === "rolled-back" || environmentReceipt.phase === "cancelled") {
        recovered = environmentReceipt;
      } else {
        recovered = await deps.environment.rollback(environmentReceipt.transactionId);
        // A proof-based recovery concludes "cancelled" with applied evidence
        // proving the expected selection live; accept it alongside a real
        // byte-restoring "rolled-back". A bare "cancelled" without proven
        // applied evidence must still fail closed.
        const provenCancelled = recovered.phase === "cancelled"
          && recovered.applied !== null
          && sameEnvironmentSelection(
            recovered.applied.selection,
            returning ? existing.official : existing.source,
          );
        if (recovered.phase !== "rolled-back" && !provenCancelled) {
          return unsafeRecoveryFailure(existing, `environment rollback ended in ${recovered.phase}`);
        }
      }

      return update(existing, {
        phase: "rolled_back",
        ownerPid: process.pid,
        safeOfficialMode: returning || existing.source.appExperience === "chatgpt",
        resumable: returning && existing.observed !== null,
        error: returning
          ? "Desktop update owner exited; the environment was recovered to safe official mode."
          : "Desktop update owner exited; the environment was recovered to its source selection.",
        rolledBackAt: deps.now(),
      }, true);
    } catch (error) {
      return unsafeRecoveryFailure(existing, errorMessage(error));
    }
  }

  function unsafeRecoveryFailure(existing: DesktopUpdateReceipt, reason: string): DesktopUpdateReceipt {
    return update(existing, {
      phase: "failed",
      ownerPid: process.pid,
      safeOfficialMode: false,
      resumable: false,
      error: `Desktop update owner-dead recovery failed: ${reason}`,
    }, true);
  }

  async function reconcile(): Promise<DesktopUpdateReceipt | null> {
    const observed = status();
    if (!observed || isTerminalDesktopUpdatePhase(observed.phase)) return observed;
    if (deps.processAlive(observed.ownerPid)) return observed;
    return withLifecycleLock(
      lifecycleLockFile,
      "desktop update reconcile",
      () => withDesktopUpdateLock(lockFile, async () => {
        const existing = status();
        if (!existing || isTerminalDesktopUpdatePhase(existing.phase)) return existing;
        if (deps.processAlive(existing.ownerPid)) return existing;
        return recoverExitedOwner(existing);
      }),
    );
  }

  const heartbeat = (): DesktopUpdateHeartbeat | null => readDesktopUpdateHeartbeat(heartbeatFile);

  return { start, resume, cancel, reconcile, status, heartbeat };
}

async function assertRequestedDesktopApp(
  requestedPath: string | undefined,
  selection: EnvironmentSelection,
  readBundleIdentifier: (appPath: string) => string | null | Promise<string | null>,
): Promise<void> {
  if (requestedPath === undefined) return;
  if (!isAbsolute(requestedPath) || normalize(requestedPath) !== requestedPath || !/\.app$/i.test(requestedPath)) {
    throw new Error(`The requested desktop app must be an exact absolute .app path: ${requestedPath}`);
  }
  if (requestedPath !== selection.selectedDesktopPath) {
    throw new Error(
      `The requested app path ${requestedPath} does not match the selected ${selection.releaseProfile} environment at ${selection.selectedDesktopPath}`,
    );
  }
  const observedBundleId = await readBundleIdentifier(requestedPath);
  if (observedBundleId !== selection.selectedDesktopBundleId) {
    throw new Error(
      `The requested app bundle ${requestedPath} has identifier ${observedBundleId ?? "unreadable"}; expected ${selection.selectedDesktopBundleId}`,
    );
  }
}

interface VerifiedOfficialUpdateFiles {
  root: string;
  installerStateFile: string;
  environmentRegistryFile: string;
  environmentSelectionFile: string;
  environmentTransactionFile: string;
  environmentReceiptRoot: string;
  environmentLockFile: string;
  runtimeProofFile: string;
  now: string;
}

/**
 * Adopt an update only when the live app independently proves that Sparkle
 * finished after our coordinator failed: exact path and bundle, pristine ASAR,
 * strict OpenAI trust, a numerically newer build, and a new visible process.
 * No mutation occurs until every one of those checks has passed.
 */
function adoptVerifiedOfficialUpdate(
  input: {
    receipt: DesktopUpdateReceipt;
    environmentReceipt: EnvironmentTransactionReceipt;
  },
  files: VerifiedOfficialUpdateFiles,
): RecoveredOfficialUpdate | null {
  const environmentLock = acquireProcessLock(files.environmentLockFile, {
    onContended: (owner) => new Error(
      owner === null
        ? "Another environment transaction is running"
        : `Another environment transaction is running (PID ${owner})`,
    ),
  });
  try {
    return adoptVerifiedOfficialUpdateLocked(input, files);
  } finally {
    environmentLock.release();
  }
}

function adoptVerifiedOfficialUpdateLocked(
  input: {
    receipt: DesktopUpdateReceipt;
    environmentReceipt: EnvironmentTransactionReceipt;
  },
  files: VerifiedOfficialUpdateFiles,
): RecoveredOfficialUpdate | null {
  const { receipt, environmentReceipt } = input;
  const selection = receipt.official;
  const initialSwitch = sameEnvironmentSelection(environmentReceipt.source, receipt.source)
    && sameEnvironmentSelection(environmentReceipt.requested, selection);
  const failedReturn = sameEnvironmentSelection(environmentReceipt.source, selection)
    && sameEnvironmentSelection(environmentReceipt.requested, receipt.source);
  if (selection.appExperience !== "chatgpt"
    || selection.backendLane !== "official-bundled"
    || (!initialSwitch && !failedReturn)
    || environmentReceipt.transactionId !== receipt.environmentTransactionId) {
    return null;
  }

  const adoptionInput = {
    selection,
    baseline: receipt.baseline,
    excludedMainPid: environmentReceipt.oldMainPid,
  };
  const adoptionFiles = {
    root: files.root,
    installerStateFile: files.installerStateFile,
    environmentRegistryFile: files.environmentRegistryFile,
    environmentSelectionFile: files.environmentSelectionFile,
    runtimeProofFile: files.runtimeProofFile,
    mcpConfigFile: defaultCodexMcpConfigFile(),
    mcpStateFile: join(files.root, "mcp-sync-state.json"),
    tweaksRoot: join(files.root, "tweaks"),
    tweakersConfigFile: join(files.root, "config.json"),
    now: files.now,
  };
  const proof = proveVerifiedOfficialDesktop(adoptionInput, adoptionFiles);
  if (proof === null) return null;
  const adopted = commitVerifiedOfficialDesktop(adoptionInput, proof, adoptionFiles);

  const terminalEnvironment: EnvironmentTransactionReceipt = {
    ...environmentReceipt,
    phase: "cancelled",
    ownerPid: process.pid,
    newMainPid: adopted.mainPid,
    error: officialAdoptionError(environmentReceipt.error),
    updatedAt: files.now,
    cancelledAt: files.now,
  };
  writeEnvironmentTransactionReceipt(
    join(files.environmentReceiptRoot, `${terminalEnvironment.transactionId}.json`),
    terminalEnvironment,
  );
  // The current receipt is the commit point. If the process exits after the
  // archive write, the still-failed current receipt remains safely blocking;
  // if it exits after this write, retry recognizes the recovery marker and
  // idempotently finishes the desktop receipt.
  writeEnvironmentTransactionReceipt(files.environmentTransactionFile, terminalEnvironment);

  return adopted;
}

function correlatedFailedPreparation(
  desktop: DesktopUpdateReceipt,
  environment: EnvironmentTransactionReceipt | null,
): EnvironmentTransactionReceipt | null {
  if (environment === null
    || environment.phase !== "failed"
    || environment.attempt !== 0
    || environment.ownerPid !== process.pid
    || Date.parse(environment.updatedAt) < Date.parse(desktop.updatedAt)
    || !sameEnvironmentSelection(environment.source, desktop.source)
    || !sameEnvironmentSelection(environment.requested, desktop.official)) {
    return null;
  }
  return environment;
}

export function isTerminalDesktopUpdatePhase(phase: DesktopUpdatePhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "rolled_back";
}

export function pristineBackupProvesObservedDesktop(
  backupAppPath: string,
  observed: DesktopVersionIdentity,
  adapters: {
    verifyDeveloperId?: (appPath: string) => boolean;
    readVersion?: (appPath: string) => DesktopVersionIdentity;
  } = {},
): boolean {
  if (!observed.marketingVersion || !observed.build) return false;
  const verifyDeveloperId = adapters.verifyDeveloperId ?? isDeveloperIdSignedBackup;
  const readVersion = adapters.readVersion ?? readDesktopVersion;
  try {
    if (!verifyDeveloperId(backupAppPath)) return false;
    const backup = readVersion(backupAppPath);
    return backup.marketingVersion === observed.marketingVersion
      && backup.build === observed.build;
  } catch {
    return false;
  }
}

export function sealedModeCachePairProvesObservedDesktop(
  pair: DesktopUpdateModeCachePair | null,
  expected: EnvironmentSelection,
  observed: DesktopVersionIdentity,
  generationId: string | null,
): boolean {
  return generationId !== null
    && observed.marketingVersion !== null
    && observed.build !== null
    && pair !== null
    && pair.generationId === generationId
    && pair.pinState === "prepared"
    && pair.releaseProfile === expected.releaseProfile
    && pair.live.experience === "tweakers"
    && pair.live.appPath === expected.selectedDesktopPath
    && pair.live.bundleId === expected.selectedDesktopBundleId
    && pair.live.version === observed.marketingVersion
    && pair.live.build === observed.build
    && pair.inactive.experience === "chatgpt"
    && pair.inactive.bundleId === expected.selectedDesktopBundleId
    && pair.inactive.version === observed.marketingVersion
    && pair.inactive.build === observed.build
    && pair.inactive.strictSignature;
}

export async function runSynchronousLocalRefresh(
  input: RefreshTweakersInput,
  options: SynchronousLocalRefreshOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const refresh = options.refresh ?? refreshLocal;
  const key = "TWEAKERS_REFRESH_LOCAL_DETACHED";
  const previous = env[key];
  env[key] = "1";
  try {
    await refresh({ source: input.source, app: input.selection.selectedDesktopPath });
  } finally {
    if (previous === undefined) delete env[key];
    else env[key] = previous;
  }
}

async function verifyFinalDesktopReturn(
  input: VerifyDesktopUpdateInput,
  selectionFile: string,
  runtimeProofFile: string,
  configFile: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (!desktopVersionAdvanced(input.baseline, input.observed)) {
    return { ok: false, error: "The official desktop version/build did not advance" };
  }

  if (input.expected.appExperience === "tweakers") {
    if (input.environmentTransactionKind === "mode-cache-v2") {
      if (!sealedModeCachePairProvesObservedDesktop(
        input.modeCachePair,
        input.expected,
        input.observed,
        input.environmentTransactionId,
      )) {
        return {
          ok: false,
          error: "The current sealed environment pair does not prove updated Tweakers and official payloads",
        };
      }
    } else {
      const pristineBackup = join(dirname(selectionFile), "backup", "Codex.app");
      if (!pristineBackupProvesObservedDesktop(pristineBackup, input.observed)) {
        return {
          ok: false,
          error: "The pristine official backup is not Developer ID valid at the updated desktop version/build",
        };
      }
    }
  }

  if (input.expected.appExperience === "chatgpt") {
    openCodex(input.expected.selectedDesktopPath);
  }

  let lastError = "The requested desktop did not reopen with an activated visible window";
  for (let poll = 0; poll < 240; poll += 1) {
    const applied = readEnvironmentSelection(selectionFile);
    if (!applied || !sameEnvironmentSelection(applied, input.expected)) {
      lastError = "The requested environment selection was not published";
    } else {
      const observed = observeCodexMainProcess(input.expected.selectedDesktopPath);
      if (!observed) {
        lastError = "The exact requested desktop main process was not observed";
      } else if (input.previousMainPid !== null && observed.pid === input.previousMainPid) {
        lastError = `The runtime refresh has not produced a new main PID (still ${observed.pid})`;
      } else if (!observed.visibleWindow) {
        lastError = `The reopened desktop PID ${observed.pid} has no activated visible window`;
      } else {
        const identity = readDesktopBundleIdentity(input.expected.selectedDesktopPath);
        const marker = readAsarMarker(join(
          input.expected.selectedDesktopPath,
          "Contents",
          "Resources",
          "app.asar",
        ));
        if (identity.bundleId !== input.expected.selectedDesktopBundleId) {
          lastError = "The reopened desktop bundle identifier is wrong";
        } else if ((input.expected.appExperience === "tweakers" && marker !== "present")
          || (input.expected.appExperience === "chatgpt" && marker !== "absent")) {
          lastError = "The reopened desktop marker does not match the requested app experience";
        } else if (input.expected.appExperience === "tweakers") {
          const proof = readEnvironmentRuntimeProof(runtimeProofFile);
          const expectedBackendPath = selectedBackendPath(input.expected, configFile);
          if (!proof
            || proof.pid !== observed.pid
            || proof.appRoot !== input.expected.selectedDesktopPath
            || proof.bundleId !== input.expected.selectedDesktopBundleId
            || proof.desktopVersion !== identity.version
            || proof.desktopBuild !== identity.build
            || proof.appAsarHeaderHash !== readDesktopAsarHeaderHash(input.expected.selectedDesktopPath)
            || proof.releaseProfile !== input.expected.releaseProfile
            || proof.backendLane !== (input.expected.backendLane === "managed-alpha" ? "managed-alpha" : "bundled")
            || proof.binaryPath !== expectedBackendPath
            || !backendBytesMatchRuntimeProof(proof.binaryPath, proof.backendVersion, proof.backendFingerprint)) {
            lastError = "The reopened Tweakers runtime did not prove its exact backend path, version, and bytes";
          } else {
            return { ok: true, error: null };
          }
        } else {
          return { ok: true, error: null };
        }
      }
    }
    if (poll + 1 < 240) await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, error: lastError };
}

const DEFAULT_NATIVE_UPDATE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Native-wait ceiling for the Sparkle handoff. Ten minutes covers a real
 * download+install with margin; a phased-rollout build the updater refuses to
 * surface should cost minutes, not the historical half hour, and the timeout
 * already lands resumable in safe official mode. `tweaker.desktopUpdateTimeoutMinutes`
 * (clamped 2-30) overrides it.
 */
function configuredNativeUpdateTimeoutMs(configFile: string): number {
  const section = readConfigFile(configFile).tweaker;
  const minutes = section !== null && typeof section === "object" && !Array.isArray(section)
    ? (section as Record<string, unknown>).desktopUpdateTimeoutMinutes
    : undefined;
  if (typeof minutes === "number" && Number.isFinite(minutes)) {
    return Math.min(30, Math.max(2, Math.round(minutes))) * 60_000;
  }
  return DEFAULT_NATIVE_UPDATE_TIMEOUT_MS;
}

async function sourceSelectionProvenByBytes(
  existing: DesktopUpdateReceipt,
  selection: EnvironmentSelection | null,
  deps: DesktopUpdateDependencies,
): Promise<boolean> {
  if (selection === null || !sameEnvironmentSelection(selection, existing.source) || selection.appliedAt === null) {
    return false;
  }
  const bundleId = await deps.readDesktopBundleIdentifier(existing.source.selectedDesktopPath);
  if (bundleId !== existing.source.selectedDesktopBundleId) return false;
  const version = await deps.readDesktopVersion(existing.source.selectedDesktopPath);
  if (existing.baseline.marketingVersion !== null && version.marketingVersion !== existing.baseline.marketingVersion) {
    return false;
  }
  if (existing.baseline.build !== null && version.build !== existing.baseline.build) return false;
  const readMarker = deps.readDesktopAsarMarker
    ?? ((appPath: string) => readAsarMarker(join(appPath, "Contents", "Resources", "app.asar")));
  const marker = readMarker(existing.source.selectedDesktopPath);
  return existing.source.appExperience === "tweakers" ? marker === "present" : marker === "absent";
}

function sameEnvironmentSelection(first: EnvironmentSelection, second: EnvironmentSelection): boolean {
  return first.appExperience === second.appExperience
    && first.releaseProfile === second.releaseProfile
    && first.backendLane === second.backendLane
    && first.selectedDesktopPath === second.selectedDesktopPath
    && first.selectedDesktopBundleId === second.selectedDesktopBundleId;
}

function pairProvesLiveEnvironment(
  pair: DesktopUpdateModeCachePair | null,
  current: EnvironmentSelection | null,
  expected: EnvironmentSelection,
  generationId: string,
  version: DesktopVersionIdentity,
): pair is DesktopUpdateModeCachePair {
  return pair !== null
    && current !== null
    && pair.generationId === generationId
    && pair.pinState === "prepared"
    && pair.releaseProfile === expected.releaseProfile
    && pair.live.experience === expected.appExperience
    && pair.live.appPath === expected.selectedDesktopPath
    && pair.live.bundleId === expected.selectedDesktopBundleId
    && (version.marketingVersion === null || pair.live.version === version.marketingVersion)
    && (version.build === null || pair.live.build === version.build)
    && sameEnvironmentSelection(current, expected)
    && current.appliedAt !== null;
}

function readDesktopBundleIdentity(appPath: string): {
  bundleId: string | null;
  version: string | null;
  build: string | null;
} {
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

function readDesktopAsarHeaderHash(appPath: string): string | null {
  try {
    return readHeaderHash(join(appPath, "Contents", "Resources", "app.asar")).headerHash;
  } catch {
    return null;
  }
}

function selectedBackendPath(selection: EnvironmentSelection, configFile: string): string {
  if (selection.backendLane !== "managed-alpha") {
    return join(selection.selectedDesktopPath, "Contents", "Resources", "codex");
  }
  const config = readConfigFile(configFile);
  const section = config.tweaker && typeof config.tweaker === "object" && !Array.isArray(config.tweaker)
    ? config.tweaker as Record<string, unknown>
    : {};
  return typeof section.codexCliPath === "string" ? section.codexCliPath : "";
}

function backendBytesMatchRuntimeProof(path: string, version: string, fingerprint: string): boolean {
  if (!existsSync(path) || !/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
  try {
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (digest !== fingerprint.toLowerCase()) return false;
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0) return false;
    const actual = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\s+/).at(-1) ?? null;
    return actual === version;
  } catch {
    return false;
  }
}

export function readDesktopUpdateReceipt(file: string): DesktopUpdateReceipt | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Desktop update receipt is unreadable at ${file}: ${errorMessage(error)}`);
  }
  const normalized = normalizeNonResumableDesktopUpdateReceipt(value);
  if (!isDesktopUpdateReceipt(normalized)) throw new Error(`Desktop update receipt is invalid at ${file}`);
  return normalized;
}

/**
 * A non-resumable terminal desktop receipt is history only. Normalize its two
 * embedded schema-1 selections so an abandoned legacy update cannot poison
 * unrelated lifecycle work. Resumable and in-flight receipts stay byte-strict
 * because their selections may still control live recovery.
 */
function normalizeNonResumableDesktopUpdateReceipt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const receipt = value as Record<string, unknown>;
  const terminal = receipt.phase === "completed"
    || receipt.phase === "rolled_back"
    || (receipt.phase === "failed" && receipt.resumable === false);
  if (!terminal) return value;
  const source = normalizeEnvironmentSelection(receipt.source);
  const official = normalizeEnvironmentSelection(receipt.official);
  if (source === null || official === null) return value;
  return { ...receipt, source, official };
}

export function writeDesktopUpdateReceipt(file: string, receipt: DesktopUpdateReceipt): void {
  if (!isDesktopUpdateReceipt(receipt)) throw new Error("Refusing to write an invalid desktop update receipt");
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  let fd: number | null = null;
  try {
    rmSync(temporary, { force: true });
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
      try { closeSync(fd); } catch {
        // The descriptor may already have been closed after a successful fsync.
      }
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

function isDesktopUpdateReceipt(value: unknown): value is DesktopUpdateReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<DesktopUpdateReceipt>;
  return receipt.schemaVersion === DESKTOP_UPDATE_SCHEMA_VERSION
    && receipt.kind === "desktop-update"
    && typeof receipt.transactionId === "string"
    && isDesktopUpdatePhase(receipt.phase)
    && typeof receipt.ownerPid === "number"
    && (receipt.ownerToken === undefined || receipt.ownerToken === null
      || typeof receipt.ownerToken === "string")
    && (receipt.ownerGeneration === undefined || receipt.ownerGeneration === null
      || typeof receipt.ownerGeneration === "string")
    && isEnvironmentSelection(receipt.source)
    && isEnvironmentSelection(receipt.official)
    && isDesktopVersion(receipt.baseline)
    && (receipt.observed === null || isDesktopVersion(receipt.observed))
    && (receipt.nativeUpdateHandoffAt === null || isIsoDate(receipt.nativeUpdateHandoffAt))
    && (receipt.refreshSource === null || receipt.refreshSource === "development" || receipt.refreshSource === "stable")
    && (receipt.environmentTransactionId === null || typeof receipt.environmentTransactionId === "string")
    && (receipt.environmentTransactionKind === undefined
      || receipt.environmentTransactionKind === null
      || receipt.environmentTransactionKind === "legacy"
      || receipt.environmentTransactionKind === "mode-cache-v2")
    && (receipt.officialMainPid === undefined || receipt.officialMainPid === null
      || (typeof receipt.officialMainPid === "number" && Number.isInteger(receipt.officialMainPid) && receipt.officialMainPid > 0))
    && typeof receipt.safeOfficialMode === "boolean"
    && typeof receipt.resumable === "boolean"
    && (receipt.error === null || typeof receipt.error === "string")
    && isIsoDate(receipt.createdAt)
    && isIsoDate(receipt.updatedAt)
    && (receipt.terminalAt === undefined || receipt.terminalAt === null || isIsoDate(receipt.terminalAt))
    && (receipt.continuationAbandonedAt === undefined
      || receipt.continuationAbandonedAt === null
      || isIsoDate(receipt.continuationAbandonedAt))
    && (receipt.completedAt === null || isIsoDate(receipt.completedAt))
    && (receipt.rolledBackAt === null || isIsoDate(receipt.rolledBackAt));
}

function isDesktopUpdatePhase(value: unknown): value is DesktopUpdatePhase {
  return typeof value === "string" && [
    "preparing",
    "switching_to_chatgpt",
    "awaiting_native_update",
    "returning_to_tweakers",
    "refreshing_runtime",
    "verifying",
    "completed",
    "failed",
    "rolled_back",
  ].includes(value);
}

function isDesktopVersion(value: unknown): value is DesktopVersionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = value as Partial<DesktopVersionIdentity>;
  return (version.marketingVersion === null || typeof version.marketingVersion === "string")
    && (version.build === null || typeof version.build === "string");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readDesktopVersion(appPath: string): DesktopVersionIdentity {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    return {
      marketingVersion: typeof plist.CFBundleShortVersionString === "string" ? plist.CFBundleShortVersionString : null,
      build: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : null,
    };
  } catch {
    return { marketingVersion: null, build: null };
  }
}

/** Process-level failures from inspectLiveOfficialDesktop that a relaunch of
 * the exact selected app can cure. Disk-level proofs (pristine asar, official
 * profile, readable version) rethrow immediately. */
function isRecoverableLiveProcessError(error: unknown): boolean {
  return /process could not be proven|has no visible window/i.test(errorMessage(error));
}

function inspectLiveOfficialDesktop(
  selection: EnvironmentSelection,
): LiveOfficialDesktopObservation {
  if (selection.appExperience !== "chatgpt" || selection.backendLane !== "official-bundled") {
    throw new Error("The resumable desktop selection is not an official ChatGPT environment");
  }
  const appPath = selection.selectedDesktopPath;
  const asarPath = join(appPath, "Contents", "Resources", "app.asar");
  if (readAsarMarker(asarPath) !== "absent") {
    throw new Error(`The live desktop at ${appPath} is not pristine ChatGPT`);
  }
  validateOfficialEnvironmentProfile(selection);
  const processObservation = observeCodexMainProcess(appPath);
  if (processObservation === null) {
    throw new Error(`The exact official ChatGPT process could not be proven at ${appPath}`);
  }
  if (!processObservation.visibleWindow) {
    throw new Error(`The official ChatGPT process ${processObservation.pid} has no visible window`);
  }
  const version = readDesktopVersion(appPath);
  if (version.marketingVersion === null && version.build === null) {
    throw new Error(`The official ChatGPT version and build are unreadable at ${appPath}`);
  }
  return { version, mainPid: processObservation.pid };
}

async function waitForVersionChange(
  input: WaitForDesktopVersionChangeInput,
  readVersion: (path: string) => DesktopVersionIdentity,
  shouldStop: () => boolean = () => false,
): Promise<DesktopVersionIdentity | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    if (shouldStop()) return null;
    const observed = readVersion(input.appPath);
    if (desktopVersionAdvanced(input.baseline, observed)) return observed;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, input.pollIntervalMs);
    });
  }
  return null;
}

async function withDesktopUpdateLock<T>(lockFile: string, operation: () => Promise<T>): Promise<T> {
  const lock = acquireProcessLock(lockFile, {
    onContended: (owner) => new Error(
      owner === null
        ? "Another desktop update transaction is running"
        : `Another desktop update transaction is running (PID ${owner})`,
    ),
  });
  try {
    return await operation();
  } finally {
    lock.release();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

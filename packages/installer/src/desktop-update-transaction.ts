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
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  inspectEnvironmentProfile,
  isEnvironmentSelection,
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
import { userPaths } from "./paths.js";
import { readPlist } from "./plist.js";
import { acquireProcessLock, processAlive as isProcessAlive } from "./process-lock.js";
import { assertLifecycleReceiptsIdle, withLifecycleLock } from "./lifecycle-lock.js";
import { readState, writeState } from "./state.js";
import { getLocalRefreshStatus, refreshLocal, type LocalRefreshStatus, type RefreshSource } from "./commands/refresh-local.js";
import {
  observeCodexMainProcess,
  openCodex,
  requestCodexNativeUpdate,
  showUpdateModePausedAlert,
  type NativeUpdateHandoffResult,
} from "./alerts.js";
import { isDeveloperIdSignedBackup, readAsarMarker } from "./commands/install.js";
import { readConfigFile } from "./config.js";
import { createMcpModeBridge } from "./mcp-mode-bridge.js";
import { proveRegularChatGptMcpRuntime } from "./mcp-runtime-proof.js";
import {
  desktopReceiptBlocksLifecycle,
  isTerminalDesktopUpdatePhaseValue,
} from "./desktop-update-state.js";
import {
  desktopUpdateOwnerIsLive,
  readDesktopUpdateHeartbeat,
  removeDesktopUpdateHeartbeat,
  writeDesktopUpdateHeartbeat,
  type DesktopUpdateHeartbeat,
} from "./desktop-update-heartbeat.js";
import { appendDesktopUpdateLog, type DesktopUpdateLogEvent } from "./desktop-update-log.js";
import { readProcessStartToken } from "./orphans.js";
import {
  compareDesktopVersionIdentity,
  type DesktopVersionComparison,
  type DesktopVersionIdentity,
} from "./desktop-version.js";
import { parkedPayloadRoot } from "./mode-transition.js";

export type { DesktopVersionComparison, DesktopVersionIdentity } from "./desktop-version.js";
export { compareDesktopVersionIdentity } from "./desktop-version.js";

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
  /** PID proven when the official environment was entered before native update. */
  officialMainPid?: number | null;
  safeOfficialMode: boolean;
  resumable: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
}

export interface RecoveredOfficialUpdate {
  observed: DesktopVersionIdentity;
  selection: EnvironmentSelection;
  mainPid: number;
}

export interface DesktopUpdateDependencies {
  environment: EnvironmentCoordinator;
  readCurrentSelection(): EnvironmentSelection | null | Promise<EnvironmentSelection | null>;
  readDesktopVersion(appPath: string): DesktopVersionIdentity | Promise<DesktopVersionIdentity>;
  readDesktopBundleIdentifier(appPath: string): string | null | Promise<string | null>;
  /** Prove the exact live desktop is pristine, OpenAI-signed, visible, and version-readable. */
  inspectLiveOfficialDesktop(
    selection: EnvironmentSelection,
  ): LiveOfficialDesktopObservation | Promise<LiveOfficialDesktopObservation>;
  initiateNativeUpdate(input: InitiateNativeDesktopUpdateInput): void | Promise<void>;
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
  appPath?: string;
}

export interface DesktopUpdateTransaction {
  start(): Promise<DesktopUpdateReceipt>;
  resume(): Promise<DesktopUpdateReceipt>;
  cancel(): Promise<DesktopUpdateReceipt>;
  reconcile(): Promise<DesktopUpdateReceipt | null>;
  status(): DesktopUpdateReceipt | null;
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
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30 * 60 * 1_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 2_000);
  const now = overrides.now ?? (() => new Date().toISOString());
  const environment = overrides.environment ?? createEnvironmentCoordinator({
    transactionFile: environmentTransactionFile,
    receiptRoot: environmentReceiptRoot,
    selectionFile: environmentSelectionFile,
    registryFile: environmentRegistryFile,
    stateFile: installerStateFile,
    configFile: join(root, "config.json"),
    lockFile: environmentLockFile,
    lifecycleLockFile,
  });
  const deps: DesktopUpdateDependencies = {
    environment,
    readCurrentSelection: overrides.readCurrentSelection ?? (() => {
      const saved = readEnvironmentSelection(environmentSelectionFile);
      if (saved) return saved;
      const legacy = readState(installerStateFile);
      return migrateLegacyEnvironmentSelection({ mode: legacy?.mode });
    }),
    readDesktopVersion: overrides.readDesktopVersion ?? readDesktopVersion,
    readDesktopBundleIdentifier: overrides.readDesktopBundleIdentifier ?? ((appPath) => (
      readDesktopBundleIdentity(appPath).bundleId
    )),
    inspectLiveOfficialDesktop: overrides.inspectLiveOfficialDesktop ?? inspectLiveOfficialDesktop,
    initiateNativeUpdate: overrides.initiateNativeUpdate ?? (async ({ selection, baseline, officialMainPid }) => {
      const result: NativeUpdateHandoffResult = officialMainPid !== null
        ? await requestCodexNativeUpdate(selection.selectedDesktopPath, officialMainPid)
        : {
            ok: false,
            kind: "process_not_proven",
            message: "The exact ChatGPT process was not recorded after entering official mode.",
            permissionGuidance: null,
          };
      if (!result.ok) {
        showUpdateModePausedAlert(selection.selectedDesktopPath, baseline.marketingVersion, result);
        throw new Error(
          `${result.message}${result.permissionGuidance ? ` ${result.permissionGuidance}` : ""}`,
        );
      }
      showUpdateModePausedAlert(selection.selectedDesktopPath, baseline.marketingVersion);
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
    selectRefreshSource: overrides.selectRefreshSource ?? (
      () => preferredDesktopRefreshSource(getLocalRefreshStatus(root))
    ),
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
  };

  const ownerIdentity = (): Pick<
    DesktopUpdateReceipt,
    "ownerPid" | "ownerToken" | "ownerGeneration"
  > => {
    const ownerToken = deps.readProcessStartToken(process.pid);
    if (!ownerToken) {
      throw new Error(`Cannot establish a stable process identity for desktop update owner PID ${process.pid}`);
    }
    return {
      ownerPid: process.pid,
      ownerToken,
      ownerGeneration: deps.createOwnerGeneration(),
    };
  };

  const writeHeartbeat = (receipt: DesktopUpdateReceipt): void => {
    if (!receipt.ownerToken || !receipt.ownerGeneration) return;
    writeDesktopUpdateHeartbeat(heartbeatFile, {
      schemaVersion: 1,
      transactionId: receipt.transactionId,
      ownerPid: receipt.ownerPid,
      ownerToken: receipt.ownerToken,
      ownerGeneration: receipt.ownerGeneration,
      phase: receipt.phase,
      beatAt: deps.now(),
    });
  };

  const persist = (
    receipt: DesktopUpdateReceipt,
    terminal = false,
    event?: DesktopUpdateLogEvent,
  ): DesktopUpdateReceipt => {
    const previous = readDesktopUpdateReceipt(stateFile);
    writeDesktopUpdateReceipt(stateFile, receipt);
    if (terminal) writeDesktopUpdateReceipt(join(receiptRoot, `${receipt.transactionId}.json`), receipt);
    if (receipt.phase === "awaiting_native_update") writeHeartbeat(receipt);
    else removeDesktopUpdateHeartbeat(heartbeatFile);

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
    event?: DesktopUpdateLogEvent,
  ): DesktopUpdateReceipt => {
    const latest = readDesktopUpdateReceipt(stateFile);
    if (receipt.ownerGeneration
      && latest?.transactionId === receipt.transactionId
      && latest.ownerGeneration !== receipt.ownerGeneration) {
      return latest;
    }
    return persist(
      { ...receipt, ...patch, updatedAt: deps.now() },
      terminal,
      event,
    );
  };

  const status = (): DesktopUpdateReceipt | null => readDesktopUpdateReceipt(stateFile);

  async function start(): Promise<DesktopUpdateReceipt> {
    const receipt = await withLifecycleLock(lifecycleLockFile, "desktop update", startUnlocked);
    return receipt.phase === "awaiting_native_update"
      ? awaitNativeUpdate(receipt)
      : receipt;
  }

  async function startUnlocked(): Promise<DesktopUpdateReceipt> {
    assertLifecycleReceiptsIdle(root, { contextOwned: false });
    const receipt = await withDesktopUpdateLock(lockFile, async () => {
      const existing = status();
      if (existing && desktopReceiptBlocksLifecycle(existing)) {
        throw new Error(
          `Desktop update ${existing.transactionId} is blocking from ${existing.phase}; resume or cancel it before starting another update`,
        );
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
      const identity = ownerIdentity();
      return persist({
        schemaVersion: DESKTOP_UPDATE_SCHEMA_VERSION,
        kind: "desktop-update",
        transactionId: deps.createId(),
        phase: "preparing",
        ...identity,
        source,
        official,
        baseline,
        observed: null,
        nativeUpdateHandoffAt: null,
        refreshSource: null,
        environmentTransactionId: null,
        officialMainPid: null,
        safeOfficialMode: false,
        resumable: false,
        error: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        rolledBackAt: null,
      });
    });
    return withDesktopUpdateLock(lockFile, () => switchToOfficial(receipt));
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
    try {
      const prepared = await deps.environment.prepare({ current: receipt.source, requested: receipt.official });
      receipt = update(receipt, { environmentTransactionId: prepared.transactionId });
      const committed = await deps.environment.commit(prepared.transactionId);
      if (committed.phase !== "committed") return environmentFailure(receipt, committed, false);
      receipt = update(receipt, {
        phase: "awaiting_native_update",
        official: committed.requested,
        safeOfficialMode: true,
        resumable: true,
        officialMainPid: committed.newMainPid,
      });
      return handoffNativeUpdate(receipt);
    } catch (error) {
      const failedPreparation = receipt.environmentTransactionId === null
        ? correlatedFailedPreparation(receipt, deps.environment.status())
        : null;
      return update(receipt, {
        phase: "failed",
        environmentTransactionId: receipt.environmentTransactionId ?? failedPreparation?.transactionId ?? null,
        resumable: receipt.safeOfficialMode,
        error: errorMessage(error),
      }, true);
    }
  }

  async function handoffNativeUpdate(initial: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    try {
      await deps.initiateNativeUpdate({
        transactionId: initial.transactionId,
        selection: initial.official,
        baseline: initial.baseline,
        officialMainPid: initial.officialMainPid ?? null,
      });
      return update(initial, { nativeUpdateHandoffAt: deps.now() });
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
    const heartbeatTimer = setInterval(() => {
      void withDesktopUpdateLock(lockFile, async () => {
        const latest = status();
        if (latest?.transactionId === initial.transactionId
          && latest.phase === "awaiting_native_update"
          && latest.ownerGeneration === initial.ownerGeneration) {
          writeHeartbeat(latest);
        }
      }).catch(() => {
        // The receipt remains authoritative; a failed beat is diagnosed by
        // stale-owner reconciliation instead of crashing the updater owner.
      });
    }, 30_000);
    heartbeatTimer.unref();
    let observed: DesktopVersionIdentity | null;
    try {
      observed = await deps.waitForVersionChange({
        transactionId: initial.transactionId,
        appPath: initial.official.selectedDesktopPath,
        baseline: initial.baseline,
        timeoutMs,
        pollIntervalMs,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
    await deps.beforeNativeWaitTransition?.();
    const transitioned = await withDesktopUpdateLock(lockFile, async () => {
      const latest = status();
      if (!latest || latest.transactionId !== initial.transactionId) {
        throw new Error(`Desktop update ${initial.transactionId} changed before its native wait could be recorded`);
      }
      // A cancellation or another exact continuation that won the lock is
      // authoritative. Never write the waiter's stale snapshot over it.
      if (latest.phase !== "awaiting_native_update") return { receipt: latest, shouldContinue: false };
      if (initial.ownerGeneration
        && latest.ownerGeneration !== initial.ownerGeneration) {
        return { receipt: latest, shouldContinue: false };
      }
      if (observed === null) {
        return {
          receipt: update(latest, {
            phase: "failed",
            safeOfficialMode: true,
            resumable: true,
            error: "The official update did not complete before the timeout. ChatGPT remains safely in official mode.",
          }, true),
          shouldContinue: false,
        };
      }
      const versionComparison = compareDesktopVersionIdentity(latest.baseline, observed);
      if (versionComparison !== "newer") {
        return {
          receipt: update(latest, {
            phase: "failed",
            safeOfficialMode: true,
            resumable: true,
            error: versionComparison === "unknown"
              ? "The observed desktop version/build could not be compared safely. ChatGPT remains in official mode and the update is blocked."
              : "The observed desktop version/build did not advance. ChatGPT remains safely in official mode.",
          }, true),
          shouldContinue: false,
        };
      }
      return {
        receipt: update(latest, {
          phase: latest.source.appExperience === "chatgpt" ? "verifying" : "returning_to_tweakers",
          observed,
          resumable: false,
        }),
        shouldContinue: true,
      };
    });
    return transitioned.shouldContinue
      ? withLifecycleLock(
        lifecycleLockFile,
        "desktop update continuation",
        async () => {
          return withDesktopUpdateLock(lockFile, async () => {
            const latest = status();
            if (!latest
              || latest.transactionId !== transitioned.receipt.transactionId
              || latest.ownerGeneration !== transitioned.receipt.ownerGeneration) {
              return latest ?? transitioned.receipt;
            }
            assertLifecycleReceiptsIdle(root, {
              contextOwned: false,
              desktopTransactionId: latest.transactionId,
              environmentTransactionId: latest.environmentTransactionId ?? undefined,
            });
            return returnToRequestedEnvironment(latest);
          });
        },
      )
      : transitioned.receipt;
  }

  async function returnToRequestedEnvironment(initial: DesktopUpdateReceipt): Promise<DesktopUpdateReceipt> {
    if (!initial.observed) throw new Error("Desktop update observation is missing");
    const observed = initial.observed;
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
    let returnTransactionId: string | null = null;
    try {
      const requested = {
        ...receipt.source,
        requestedAt: deps.now(),
        appliedAt: null,
      };
      const prepared = await deps.environment.prepare({ current: receipt.official, requested });
      returnTransactionId = prepared.transactionId;
      receipt = update(receipt, { environmentTransactionId: returnTransactionId });
      const committed = await deps.environment.commit(returnTransactionId);
      if (committed.phase !== "committed") return environmentFailure(receipt, committed, true);
      const refreshSource = await deps.selectRefreshSource();
      receipt = update(receipt, {
        phase: "refreshing_runtime",
        source: committed.requested,
        refreshSource,
      });
      await deps.refreshTweakers({ source: refreshSource, selection: committed.requested, observedDesktop: observed });
      receipt = update(receipt, { phase: "verifying" });
      const verification = await deps.verifyFinal({
        expected: committed.requested,
        baseline: receipt.baseline,
        observed: receipt.observed!,
        previousMainPid: committed.newMainPid,
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
        rolledBackAt: null,
      }, true);
    } catch (error) {
      const reason = errorMessage(error);
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

  async function verifyAndComplete(
    receipt: DesktopUpdateReceipt,
    expected: EnvironmentSelection,
    previousMainPid: number | null,
  ): Promise<DesktopUpdateReceipt> {
    const verification = await deps.verifyFinal({
      expected,
      baseline: receipt.baseline,
      observed: receipt.observed!,
      previousMainPid,
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
      rolledBackAt: null,
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

  async function resume(): Promise<DesktopUpdateReceipt> {
    const receipt = await withLifecycleLock(
      lifecycleLockFile,
      "desktop update resume",
      async () => {
        const claimed = await resumeUnlocked();
        return claimed.phase === "awaiting_native_update"
          ? withDesktopUpdateLock(lockFile, async () => {
            const latest = status();
            if (!latest
              || latest.transactionId !== claimed.transactionId
              || latest.ownerGeneration !== claimed.ownerGeneration
              || latest.phase !== "awaiting_native_update") {
              return latest ?? claimed;
            }
            return handoffNativeUpdate(latest);
          })
          : claimed;
      },
    );
    if (receipt.observed) {
      return withLifecycleLock(
        lifecycleLockFile,
        "desktop update continuation",
        () => withDesktopUpdateLock(lockFile, async () => {
          const latest = status();
          if (!latest
            || latest.transactionId !== receipt.transactionId
            || latest.ownerGeneration !== receipt.ownerGeneration) {
            return latest ?? receipt;
          }
          assertLifecycleReceiptsIdle(root, {
            contextOwned: false,
            desktopTransactionId: latest.transactionId,
            environmentTransactionId: latest.environmentTransactionId ?? undefined,
          });
          return returnToRequestedEnvironment(latest);
        }),
      );
    }
    if (receipt.phase === "failed") return receipt;
    return awaitNativeUpdate(receipt);
  }

  async function resumeUnlocked(): Promise<DesktopUpdateReceipt> {
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
        && desktopUpdateOwnerIsLive({
          receipt: existing,
          heartbeat: readDesktopUpdateHeartbeat(heartbeatFile),
          nowMs: Date.parse(deps.now()),
          processAlive: deps.processAlive,
          readProcessStartToken: deps.readProcessStartToken,
        })) {
        throw new Error(`Desktop update owner PID ${existing.ownerPid} is still active`);
      }
      if (!existing.resumable || !existing.safeOfficialMode) {
        throw new Error(
          `Desktop update ${existing.transactionId} is not resumable from ${existing.phase}; cancel it to recover an exited owner`,
        );
      }
      const identity = ownerIdentity();
      let liveOfficial: LiveOfficialDesktopObservation;
      try {
        liveOfficial = await deps.inspectLiveOfficialDesktop(existing.official);
      } catch (error) {
        return update(existing, {
          phase: "failed",
          ...identity,
          safeOfficialMode: true,
          resumable: true,
          error: `Could not verify live official ChatGPT before resuming: ${errorMessage(error)}`,
        }, true);
      }

      const liveVersionComparison = compareDesktopVersionIdentity(
        existing.baseline,
        liveOfficial.version,
      );
      if (liveVersionComparison === "newer") {
        return update(existing, {
          phase: "returning_to_tweakers",
          ...identity,
          observed: liveOfficial.version,
          officialMainPid: liveOfficial.mainPid,
          resumable: false,
          error: null,
        });
      }
      if (liveVersionComparison === "unknown") {
        return update(existing, {
          phase: "failed",
          ...identity,
          observed: null,
          officialMainPid: liveOfficial.mainPid,
          safeOfficialMode: true,
          resumable: true,
          error: "The live official version/build could not be compared safely; refusing to restart into Tweakers.",
        }, true);
      }
      if (existing.observed !== null) {
        return update(existing, {
          phase: "failed",
          ...identity,
          observed: null,
          officialMainPid: liveOfficial.mainPid,
          safeOfficialMode: true,
          resumable: true,
          error: "The live official version/build did not advance from the transaction baseline; refusing to restart into Tweakers.",
        }, true);
      }
      return update(existing, {
        phase: "awaiting_native_update",
        ...identity,
        officialMainPid: liveOfficial.mainPid,
        resumable: false,
        error: null,
      });
    });
    return receipt;
  }

  async function cancel(): Promise<DesktopUpdateReceipt> {
    let existing = status();
    if (!existing) throw new Error("No desktop update exists to cancel");

    // The native updater wait intentionally releases the lifecycle lease while
    // it polls. Cancellation may bypass the ordinary lifecycle path only when the desktop receipt
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
      && desktopUpdateOwnerIsLive({
        receipt: existing,
        heartbeat: readDesktopUpdateHeartbeat(heartbeatFile),
        nowMs: Date.parse(deps.now()),
        processAlive: deps.processAlive,
        readProcessStartToken: deps.readProcessStartToken,
      })) {
      throw new Error(`Desktop update owner PID ${existing.ownerPid} is still active`);
    }

    return withLifecycleLock(
      lifecycleLockFile,
      "desktop update cancel",
      () => cancelUnlocked(existing.transactionId),
    );
  }

  async function reconcile(): Promise<DesktopUpdateReceipt | null> {
    const observed = status();
    if (!observed || isTerminalDesktopUpdatePhase(observed.phase)) return observed;
    if (desktopUpdateOwnerIsLive({
      receipt: observed,
      heartbeat: readDesktopUpdateHeartbeat(heartbeatFile),
      nowMs: Date.parse(deps.now()),
      processAlive: deps.processAlive,
      readProcessStartToken: deps.readProcessStartToken,
    })) {
      return observed;
    }

    return withLifecycleLock(
      lifecycleLockFile,
      "desktop update reconcile",
      () => withDesktopUpdateLock(lockFile, async () => {
        const existing = status();
        if (!existing || isTerminalDesktopUpdatePhase(existing.phase)) return existing;
        if (desktopUpdateOwnerIsLive({
          receipt: existing,
          heartbeat: readDesktopUpdateHeartbeat(heartbeatFile),
          nowMs: Date.parse(deps.now()),
          processAlive: deps.processAlive,
          readProcessStartToken: deps.readProcessStartToken,
        })) {
          return existing;
        }
        assertLifecycleReceiptsIdle(root, {
          contextOwned: false,
          desktopTransactionId: existing.transactionId,
          environmentTransactionId: existing.environmentTransactionId ?? undefined,
        });
        const identity = ownerIdentity();

        if (existing.phase === "awaiting_native_update") {
          let liveOfficial: LiveOfficialDesktopObservation;
          try {
            liveOfficial = await deps.inspectLiveOfficialDesktop(existing.official);
          } catch (error) {
            return update(existing, {
              phase: "failed",
              ...identity,
              safeOfficialMode: false,
              resumable: false,
              error: `Could not prove the current official ChatGPT state during reconciliation: ${errorMessage(error)}`,
            }, true);
          }
          const liveVersionComparison = compareDesktopVersionIdentity(
            existing.baseline,
            liveOfficial.version,
          );
          if (liveVersionComparison === "unknown") {
            return update(existing, {
              phase: "failed",
              ...identity,
              observed: null,
              officialMainPid: liveOfficial.mainPid,
              safeOfficialMode: false,
              resumable: false,
              error: "Desktop update owner exited and the current official version/build could not be compared safely.",
            }, true);
          }
          if (liveVersionComparison === "not-newer") {
            return update(existing, {
              phase: "failed",
              ...identity,
              observed: null,
              officialMainPid: liveOfficial.mainPid,
              safeOfficialMode: true,
              resumable: false,
              error: "Desktop update owner exited before the official version/build advanced; ChatGPT remains safely in official mode.",
            }, true);
          }
          return update(existing, {
            phase: "failed",
            ...identity,
            observed: liveOfficial.version,
            officialMainPid: liveOfficial.mainPid,
            safeOfficialMode: true,
            resumable: true,
            error: "Desktop update owner exited after the official update advanced; resume to return to the requested environment.",
          }, true);
        }

        const returning = existing.phase === "returning_to_tweakers"
          || existing.phase === "refreshing_runtime"
          || existing.phase === "verifying";
        if (returning) {
          let liveOfficial: LiveOfficialDesktopObservation;
          try {
            liveOfficial = await deps.inspectLiveOfficialDesktop(existing.official);
          } catch (error) {
            return unsafeRecoveryFailure(
              existing,
              `current advanced official proof failed: ${errorMessage(error)}`,
              identity,
            );
          }
          const liveVersionComparison = compareDesktopVersionIdentity(
            existing.baseline,
            liveOfficial.version,
          );
          if (liveVersionComparison !== "newer") {
            return unsafeRecoveryFailure(
              existing,
              liveVersionComparison === "unknown"
                ? "the current pristine official version/build could not be compared safely"
                : "the current pristine official version/build did not advance from the baseline",
              identity,
            );
          }
          const current = update(existing, {
            ...identity,
            observed: liveOfficial.version,
            officialMainPid: liveOfficial.mainPid,
            safeOfficialMode: true,
          });
          if (current.source.appExperience === "chatgpt") {
            const verification = await deps.verifyFinal({
              expected: current.source,
              baseline: current.baseline,
              observed: liveOfficial.version,
              previousMainPid: current.officialMainPid ?? null,
            });
            if (!verification.ok) {
              return unsafeRecoveryFailure(
                current,
                verification.error ?? "final ChatGPT verification failed",
                identity,
              );
            }
            return update(current, {
              phase: "completed",
              safeOfficialMode: false,
              resumable: false,
              error: null,
              completedAt: deps.now(),
              rolledBackAt: null,
            }, true);
          }
          return recoverExitedOwner(current, identity);
        }

        return recoverExitedOwner(existing, identity);
      }),
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
      const identity = ownerIdentity();
      return update(existing, {
        phase: "failed",
        ...identity,
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
        && desktopUpdateOwnerIsLive({
          receipt: existing,
          heartbeat: readDesktopUpdateHeartbeat(heartbeatFile),
          nowMs: Date.parse(deps.now()),
          processAlive: deps.processAlive,
          readProcessStartToken: deps.readProcessStartToken,
        })) {
        throw new Error(`Desktop update owner PID ${existing.ownerPid} is still active`);
      }
      const identity = ownerIdentity();
      const supported = existing.phase === "awaiting_native_update"
        || (isTerminalDesktopUpdatePhase(existing.phase) && existing.resumable);
      if (supported) {
        const safeOfficialMode = existing.phase === "awaiting_native_update" || existing.safeOfficialMode;
        return update(existing, {
          phase: "failed",
          ...identity,
          safeOfficialMode,
          resumable: false,
          error: safeOfficialMode
            ? "Desktop update was cancelled; ChatGPT remains in official mode."
            : "Desktop update was cancelled before safe official mode was confirmed.",
        }, true);
      }

      if (existing.phase === "preparing") {
        return update(existing, {
          phase: "rolled_back",
          ...identity,
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

      return recoverExitedOwner(existing, identity);
    });
  }

  async function recoverExitedOwner(
    existing: DesktopUpdateReceipt,
    identity: Pick<DesktopUpdateReceipt, "ownerPid" | "ownerToken" | "ownerGeneration">,
  ): Promise<DesktopUpdateReceipt> {
    const recoveryFailure = (reason: string): DesktopUpdateReceipt => (
      unsafeRecoveryFailure(existing, reason, identity)
    );
    const returning = existing.observed !== null
      || existing.phase === "returning_to_tweakers"
      || existing.phase === "refreshing_runtime"
      || existing.phase === "verifying";
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
          ...identity,
          safeOfficialMode: returning || existing.source.appExperience === "chatgpt",
          resumable: returning && existing.observed !== null,
          error: returning
            ? "Desktop update recovery cancelled before the return environment was prepared; ChatGPT remains in official mode."
            : "Desktop update recovery cancelled before the official environment was prepared.",
          rolledBackAt: deps.now(),
        }, true);
      }
      return recoveryFailure("environment transaction state is missing");
    }

    if (existing.environmentTransactionId !== null
      && environmentReceipt.transactionId !== existing.environmentTransactionId) {
      return recoveryFailure(
        `environment transaction ${environmentReceipt.transactionId} does not match ${existing.environmentTransactionId}`,
      );
    }

    const rollbackFailed = environmentReceipt.phase === "failed"
      && /\brollback failed\b/i.test(environmentReceipt.error ?? "");
    const alreadyAdoptedOfficial = environmentReceipt.phase === "cancelled"
      && (environmentReceipt.error ?? "").startsWith(
        "Recovered by adopting the verified live official ChatGPT update.",
      );
    if (rollbackFailed || alreadyAdoptedOfficial) {
      if (environmentReceipt.ownerPid !== process.pid
        && deps.processAlive(environmentReceipt.ownerPid)) {
        return recoveryFailure(
          `environment transaction owner PID ${environmentReceipt.ownerPid} is still active`,
        );
      }
      const failedBeforeFirstReopen = rollbackFailed
        && returning
        && environmentReceipt.attempt === 0
        && (environmentReceipt.applied === null || environmentReceipt.applied === undefined)
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
              ...identity,
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
      try {
        const adopted = await deps.recoverVerifiedOfficialUpdate({
          receipt: existing,
          environmentReceipt,
        });
        if (adopted !== null) {
          return update(existing, {
            phase: "completed",
            ...identity,
            official: adopted.selection,
            observed: adopted.observed,
            officialMainPid: adopted.mainPid,
            safeOfficialMode: false,
            resumable: false,
            error: null,
            completedAt: deps.now(),
            rolledBackAt: null,
          }, true);
        }
      } catch (error) {
        return recoveryFailure(
          `verified official update adoption failed: ${errorMessage(error)}`,
        );
      }
    }

    if (rollbackFailed) {
      return recoveryFailure(
        environmentReceipt.error ?? "environment rollback failed",
      );
    }

    try {
      let recovered: EnvironmentTransactionReceipt;
      const failedBeforePreparationCompleted = environmentReceipt.phase === "failed"
        && environmentReceipt.attempt === 0
        && (environmentReceipt.prepared === null || environmentReceipt.prepared === undefined)
        && (environmentReceipt.applied === null || environmentReceipt.applied === undefined);
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
          return recoveryFailure(`environment cancellation ended in ${recovered.phase}`);
        }
      } else if (environmentReceipt.phase === "rolled-back" || environmentReceipt.phase === "cancelled") {
        recovered = environmentReceipt;
      } else {
        recovered = await deps.environment.rollback(environmentReceipt.transactionId);
        if (recovered.phase !== "rolled-back") {
          return recoveryFailure(`environment rollback ended in ${recovered.phase}`);
        }
      }

      return update(existing, {
        phase: "rolled_back",
        ...identity,
        safeOfficialMode: returning || existing.source.appExperience === "chatgpt",
        resumable: returning && existing.observed !== null,
        error: returning
          ? "Desktop update owner exited; the environment was recovered to safe official mode."
          : "Desktop update owner exited; the environment was recovered to its source selection.",
        rolledBackAt: deps.now(),
      }, true);
    } catch (error) {
      return recoveryFailure(errorMessage(error));
    }
  }

  function unsafeRecoveryFailure(
    existing: DesktopUpdateReceipt,
    reason: string,
    identity: Pick<DesktopUpdateReceipt, "ownerPid" | "ownerToken" | "ownerGeneration">,
  ): DesktopUpdateReceipt {
    return update(existing, {
      phase: "failed",
      ...identity,
      safeOfficialMode: false,
      resumable: false,
      error: `Desktop update owner-dead recovery failed: ${reason}`,
    }, true);
  }

  return { start, resume, cancel, reconcile, status };
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

  const appPath = selection.selectedDesktopPath;
  const asarPath = join(appPath, "Contents", "Resources", "app.asar");
  if (readAsarMarker(asarPath) !== "absent") return null;
  validateOfficialEnvironmentProfile(selection);

  const observed = readDesktopVersion(appPath);
  if (compareDesktopVersionIdentity(receipt.baseline, observed) !== "newer") return null;
  const identity = readDesktopBundleIdentity(appPath);
  if (identity.bundleId !== selection.selectedDesktopBundleId) return null;
  const processObservation = observeCodexMainProcess(appPath);
  if (processObservation === null
    || !processObservation.visibleWindow
    || processObservation.pid === environmentReceipt.oldMainPid) {
    return null;
  }

  const state = readState(files.installerStateFile);
  const registry = readEnvironmentProfileRegistry(files.environmentRegistryFile);
  if (state === null || state.appRoot !== appPath || registry === null) return null;
  const registeredProfile = resolveEnvironmentProfile(registry, selection.releaseProfile);
  if (registeredProfile.officialPath !== selection.selectedDesktopPath
    || registeredProfile.officialBundleId !== selection.selectedDesktopBundleId
    || registeredProfile.releaseProfile !== selection.releaseProfile) {
    return null;
  }

  const appliedSelection: EnvironmentSelection = {
    ...selection,
    appliedAt: files.now,
  };
  const mcpConfigPath = defaultCodexMcpConfigFile();
  const mcpModeBridge = createMcpModeBridge({
    configPath: mcpConfigPath,
    statePath: join(files.root, "mcp-sync-state.json"),
    tweaksRoot: join(files.root, "tweaks"),
    tweakersConfigPath: join(files.root, "config.json"),
  });
  const mcpReconciliation = mcpModeBridge.reconcile("chatgpt");
  mcpModeBridge.prove("chatgpt");
  const mcpRuntimeProof = proveRegularChatGptMcpRuntime({
    mainPid: processObservation.pid,
    configPath: mcpConfigPath,
    tweaksRoot: join(files.root, "tweaks"),
    configurationChanged: mcpReconciliation.restartRequired,
  });
  if (!mcpRuntimeProof.ok) {
    throw new Error(mcpRuntimeProof.error ?? "Regular ChatGPT MCP runtime could not be proven clean");
  }

  const invalidatedPayload = invalidateParkedPayloadForOfficialAdoption(files.root);
  const {
    patchedAsarStat: _patchedAsarStat,
    watcherStatGuardPasses: _watcherStatGuardPasses,
    ...stateWithoutPatchedRuntimeStats
  } = state;
  writeState(files.installerStateFile, {
    ...stateWithoutPatchedRuntimeStats,
    appRoot: appPath,
    mode: "chatgpt",
    codexVersion: observed.marketingVersion,
    codexChannel: selection.releaseProfile === "alpha" ? "beta" : "stable",
    codexBundleId: selection.selectedDesktopBundleId,
  });
  publishEnvironmentSelection(
    files.environmentRegistryFile,
    files.environmentSelectionFile,
    appliedSelection,
  );

  const capabilities = environmentPreparationCapabilities();
  const managedAlpha = inspectManagedAlphaBackend(files.root);
  const loaded = loadEnvironmentState({
    legacyStateFile: files.installerStateFile,
    registryFile: files.environmentRegistryFile,
    selectionFile: files.environmentSelectionFile,
    environmentRoot: files.root,
    now: files.now,
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
  writeEnvironmentProfileRegistry(files.environmentRegistryFile, loaded.registry);
  rmSync(files.runtimeProofFile, { force: true });

  const previousFailure = environmentReceipt.error?.trim() ?? "";
  const recoveryMessage = "Recovered by adopting the verified live official ChatGPT update.";
  const terminalEnvironment: EnvironmentTransactionReceipt = {
    ...environmentReceipt,
    phase: "cancelled",
    ownerPid: process.pid,
    newMainPid: processObservation.pid,
    error: previousFailure.startsWith(recoveryMessage)
      ? previousFailure
      : `${recoveryMessage}${previousFailure ? ` Previous failure: ${previousFailure}` : ""}`,
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
  if (invalidatedPayload !== null) {
    rmSync(invalidatedPayload, { recursive: true, force: true });
  }

  return {
    observed,
    selection: appliedSelection,
    mainPid: processObservation.pid,
  };
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
  return isTerminalDesktopUpdatePhaseValue(phase);
}

export function desktopVersionAdvanced(
  baseline: DesktopVersionIdentity,
  observed: DesktopVersionIdentity,
): boolean {
  return compareDesktopVersionIdentity(baseline, observed) === "newer";
}

export function invalidateParkedPayloadForOfficialAdoption(
  userRoot: string,
  adapters: {
    exists?: (path: string) => boolean;
    rename?: (source: string, destination: string) => void;
  } = {},
): string | null {
  const exists = adapters.exists ?? existsSync;
  const rename = adapters.rename ?? renameSync;
  const current = parkedPayloadRoot(userRoot);
  const invalidated = `${current}.invalidated`;
  const currentExists = exists(current);
  const invalidatedExists = exists(invalidated);
  if (currentExists && invalidatedExists) {
    throw new Error(
      `Refusing official update adoption because both the active and invalidated parked payloads exist (${current}, ${invalidated})`,
    );
  }
  if (invalidatedExists) return invalidated;
  if (!currentExists) return null;
  rename(current, invalidated);
  return invalidated;
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

/**
 * Prefer a registered development checkout even when it is hash-current: the
 * stable path stages a published GitHub release, which may not exist or may
 * lag the freshly updated desktop, while the dev checkout rebuilds against
 * exactly the installed app.
 */
export function preferredDesktopRefreshSource(
  status: Pick<LocalRefreshStatus, "source" | "developmentSourceRoot">,
): DesktopUpdateRefreshSource {
  return status.source === "development" || status.developmentSourceRoot !== null
    ? "development"
    : "stable";
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
  const versionComparison = compareDesktopVersionIdentity(input.baseline, input.observed);
  if (versionComparison !== "newer") {
    return {
      ok: false,
      error: versionComparison === "unknown"
        ? "The official desktop version/build could not be compared safely"
        : "The official desktop version/build did not advance",
    };
  }

  if (input.expected.appExperience === "tweakers") {
    const pristineBackup = join(dirname(selectionFile), "backup", "Codex.app");
    if (!pristineBackupProvesObservedDesktop(pristineBackup, input.observed)) {
      return {
        ok: false,
        error: "The pristine official backup is not Developer ID valid at the updated desktop version/build",
      };
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

function sameEnvironmentSelection(first: EnvironmentSelection, second: EnvironmentSelection): boolean {
  return first.appExperience === second.appExperience
    && first.releaseProfile === second.releaseProfile
    && first.backendLane === second.backendLane
    && first.selectedDesktopPath === second.selectedDesktopPath
    && first.selectedDesktopBundleId === second.selectedDesktopBundleId;
}

function readDesktopBundleIdentity(appPath: string): { bundleId: string | null } {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    return { bundleId: typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : null };
  } catch {
    return { bundleId: null };
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
  if (!isDesktopUpdateReceipt(value)) throw new Error(`Desktop update receipt is invalid at ${file}`);
  return value;
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
      || (typeof receipt.ownerToken === "string" && receipt.ownerToken.length > 0))
    && (receipt.ownerGeneration === undefined || receipt.ownerGeneration === null
      || (typeof receipt.ownerGeneration === "string" && receipt.ownerGeneration.length > 0))
    && (
      (receipt.ownerToken === null || receipt.ownerToken === undefined)
      === (receipt.ownerGeneration === null || receipt.ownerGeneration === undefined)
    )
    && isEnvironmentSelection(receipt.source)
    && isEnvironmentSelection(receipt.official)
    && isDesktopVersion(receipt.baseline)
    && (receipt.observed === null || isDesktopVersion(receipt.observed))
    && (receipt.nativeUpdateHandoffAt === null || isIsoDate(receipt.nativeUpdateHandoffAt))
    && (receipt.refreshSource === null || receipt.refreshSource === "development" || receipt.refreshSource === "stable")
    && (receipt.environmentTransactionId === null || typeof receipt.environmentTransactionId === "string")
    && (receipt.officialMainPid === undefined || receipt.officialMainPid === null
      || (typeof receipt.officialMainPid === "number" && Number.isInteger(receipt.officialMainPid) && receipt.officialMainPid > 0))
    && typeof receipt.safeOfficialMode === "boolean"
    && typeof receipt.resumable === "boolean"
    && (receipt.error === null || typeof receipt.error === "string")
    && isIsoDate(receipt.createdAt)
    && isIsoDate(receipt.updatedAt)
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

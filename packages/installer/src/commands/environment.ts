import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import {
  ALPHA_DESKTOP_PATH,
  STABLE_DESKTOP_PATH,
  createRequestedEnvironmentSelection,
  inspectEnvironmentProfile,
  environmentCommitJournalFile,
  readEnvironmentProfileRegistry,
  recoverEnvironmentDocumentCommit,
  registerAlphaDesktopProfile,
  loadEnvironmentState,
  writeEnvironmentProfileRegistry,
  type AppExperience,
  type EnvironmentProfileRecord,
  type EnvironmentProfileEvidenceInput,
  type EnvironmentProfileRegistry,
  type LoadedEnvironmentState,
  type ReleaseProfile,
} from "../environment-profile.js";
import {
  createEnvironmentCoordinator,
  environmentPreparationCapabilities,
  inspectManagedAlphaBackend,
  resolvePreparedEnvironmentCommitCli,
  submitEnvironmentCommitHelper,
  type EnvironmentCommitHelperReceipt,
  type EnvironmentCoordinator,
  type EnvironmentCoordinatorOptions,
  type EnvironmentModeCacheV2PreparationResult,
  type EnvironmentPreparationCapabilities,
  type PreparedEnvironmentCommitCli,
  type EnvironmentTransactionReceipt,
  type EnvironmentVerification,
  type SubmitEnvironmentCommitHelperInput,
  isTerminalEnvironmentPhase,
  readEnvironmentTransactionReceipt,
} from "../environment-transaction.js";
import type { EnvironmentTimingEvidence } from "../environment-timing.js";
import { processAlive } from "../process-lock.js";
import { userPaths, type ResolvedUserPaths } from "../paths.js";
import { isLifecycleLockHeld, lifecycleLockFile, withLifecycleLock } from "../lifecycle-lock.js";
import { modeTransitionFile } from "../mode-transition.js";
import { readAsarMarker } from "./install.js";
import {
  environmentModeCachePaths,
  observeEnvironmentModeCache,
  readCurrentEnvironmentModePair,
  type EnvironmentModePairReceipt,
  type EnvironmentModeCacheStatus,
} from "../environment-mode-cache.js";
import { environmentModeCacheV2Enabled } from "../environment-mode-production.js";
import {
  environmentWarmCommitJournalFile,
  readEnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitReceipt,
} from "../environment-warm-commit.js";
import {
  runEnvironmentTransactionGc,
  type EnvironmentGcResult,
} from "../environment-gc.js";

export const ENVIRONMENT_ACTIONS = [
  "status",
  "register-alpha",
  "transaction",
  "prepare",
  "submit",
  "commit",
  "verify",
  "rollback",
  "recover",
  "cancel",
  "gc",
] as const;

export type EnvironmentAction = typeof ENVIRONMENT_ACTIONS[number];

export interface EnvironmentCommandOptions {
  appExperience?: string;
  "app-experience"?: string;
  releaseProfile?: string;
  "release-profile"?: string;
  transaction?: string;
  appPath?: string;
  "app-path"?: string;
  app?: string;
  bundledDerivedReceipt?: string;
  "bundled-derived-receipt"?: string;
  observe?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  apply?: boolean;
  json?: boolean;
  /** Internal compatibility clients may consume the typed result directly. */
  quiet?: boolean;
  /** Deliberate confirmation timestamp forwarded through the detached helper. */
  approvalAt?: string;
  /** Sade preserves kebab-case long option names instead of camel-casing them. */
  "approval-at"?: string;
}

export interface EnvironmentChannelStatus extends EnvironmentProfileRecord {
  availability: EnvironmentProfileRecord["availability"];
}

export interface EnvironmentStatusResult {
  schemaVersion: 1;
  selected: LoadedEnvironmentState["current"];
  channels: {
    stable: EnvironmentChannelStatus;
    alpha: EnvironmentChannelStatus;
  };
  observation?: EnvironmentObservationStatus;
  /** Additive schema-v2 sealed-pair cache evidence; schema-v1 readers may ignore it. */
  cacheV2: EnvironmentModeCacheStatus;
}

export interface EnvironmentObservationStatus {
  appExperience: AppExperience | null;
  selectionDrift: boolean;
  lifecycleContended: boolean;
  commitJournalPresent: boolean;
  transitionJournalPresent: boolean;
  transaction: {
    transactionId: string;
    phase: string;
    timing?: EnvironmentTransactionTimingStatus;
  } | null;
  freshness: "current" | "contended";
}

/** Output-only timing projection; durable schema-v1 receipts remain unchanged. */
export interface EnvironmentTransactionTimingStatus {
  approvalAt: string | null;
  readyAt: string | null;
  approvalToReadyDurationMs: number | null;
  phases: EnvironmentTimingEvidence["phases"];
}

export interface IdleEnvironmentTransaction {
  schemaVersion: 1;
  kind: "environment";
  transactionId: null;
  phase: "idle";
}

/**
 * Read-only schema-v2 transaction projection for the sealed-pair control
 * plane.  It is deliberately output-only: `current.json` and the
 * generation-local warm journal remain the durable authorities.
 *
 * `phase`, `error`, and `timing` come from the warm journal whenever one is
 * present. Before a warm commit starts, the current pair's durable pin state
 * is the only available phase evidence.
 */
export interface EnvironmentModeCacheV2TransactionStatus {
  schemaVersion: 2;
  kind: "environment-mode-v2-transaction";
  transactionId: string | null;
  generationId: string | null;
  phase: string;
  error: string | null;
  timing: EnvironmentTimingEvidence | null;
  createdAt: string | null;
  updatedAt: string | null;
  terminalAt: string | null;
  pinState: EnvironmentModePairReceipt["pin"]["state"] | null;
  /** Target bound by the prepared pair or durable warm-commit journal. */
  requested: Pick<LoadedEnvironmentState["current"], "appExperience" | "releaseProfile"> | null;
}

/**
 * Additive command projection of the v2 preparer result.  Keeping `state`
 * and `receipt` preserves mode-command compatibility while the top-level
 * transaction identity lets Config consume it through the normal transaction
 * path without a schema-v1 fallback.
 */
export interface EnvironmentModeCacheV2PreparationProjection
  extends EnvironmentModeCacheV2PreparationResult {
  receipt: NonNullable<EnvironmentModeCacheV2PreparationResult["receipt"]>;
  schemaVersion: 2;
  kind: "environment-mode-v2-transaction";
  transactionId: string;
  generationId: string;
  phase: "prepared";
  error: null;
  timing: null;
  createdAt: string;
  updatedAt: string;
  terminalAt: null;
  pinState: EnvironmentModePairReceipt["pin"]["state"];
  requested: Pick<LoadedEnvironmentState["current"], "appExperience" | "releaseProfile">;
}

/** Receipt plus an output-only ownerPid liveness annotation (never persisted). */
export type AnnotatedEnvironmentTransactionReceipt = EnvironmentTransactionReceipt & {
  ownerAlive: boolean;
  timingSummary?: EnvironmentTransactionTimingStatus;
};

export type EnvironmentCommandResult =
  | EnvironmentStatusResult
  | IdleEnvironmentTransaction
  | EnvironmentTransactionReceipt
  | AnnotatedEnvironmentTransactionReceipt
  | EnvironmentCommitHelperReceipt
  | EnvironmentModeCacheV2PreparationResult
  | EnvironmentModeCacheV2PreparationProjection
  | EnvironmentModeCacheV2TransactionStatus
  | EnvironmentWarmCommitReceipt
  | EnvironmentModePairReceipt
  | EnvironmentVerification
  | EnvironmentGcResult;

/**
 * Callers trust the CLI exit code. A coordinator can return a durable failure
 * receipt without throwing, so translate every result that did not reach its
 * action's success phase into a non-zero outcome while leaving the receipt
 * itself intact on stdout for recovery diagnostics.
 */
const ENVIRONMENT_SUCCESS_PHASES: Partial<Record<EnvironmentAction, string[]>> = {
  commit: ["committed"],
  rollback: ["rolled-back", "cancelled"],
  recover: ["committed", "rolled-back", "cancelled"],
};

export function assertEnvironmentCliSuccess(
  action: EnvironmentAction,
  result: EnvironmentCommandResult,
): void {
  if ((action === "commit" || action === "recover")
    && "kind" in result
    && result.kind === "environment-warm-commit"
    && "phase" in result
    && result.phase === "ready") {
    return;
  }
  if (action === "cancel"
    && "kind" in result
    && result.kind === "environment-mode-pair"
    && "pin" in result
    && result.pin.state === "cancelled") {
    return;
  }
  const expected = ENVIRONMENT_SUCCESS_PHASES[action];
  if (!expected) return;
  if (!("kind" in result)
    || result.kind !== "environment"
    || !("transactionId" in result)
    || result.transactionId === null
    || !("phase" in result)
    || typeof result.phase !== "string"
    || !expected.includes(result.phase)) {
    const phase = "phase" in result && typeof result.phase === "string"
      ? result.phase
      : "invalid";
    throw new Error(`Environment ${action} did not succeed (phase ${phase})`);
  }
}

export interface EnvironmentCommandDependencies {
  paths(): ResolvedUserPaths;
  loadState: typeof loadEnvironmentState;
  inspectProfile: typeof inspectEnvironmentProfile;
  inspectManagedAlpha: typeof inspectManagedAlphaBackend;
  writeRegistry(file: string, registry: EnvironmentProfileRegistry): void;
  preparationCapabilities(): EnvironmentPreparationCapabilities;
  createRequestedSelection: typeof createRequestedEnvironmentSelection;
  createCoordinator(options: EnvironmentCoordinatorOptions): EnvironmentCoordinator;
  submitCommitHelper(input: SubmitEnvironmentCommitHelperInput): EnvironmentCommitHelperReceipt;
  resolvePreparedCommitCli(
    receipt: EnvironmentTransactionReceipt,
    receiptRoot: string,
  ): PreparedEnvironmentCommitCli;
  environmentModeCacheV2Enabled?(configFile: string): boolean;
  createModeCacheGenerationId?(): string;
  /** Read-only v2 poll seam; production defaults to current pair + warm journal. */
  observeModeCacheV2Transaction?(environmentRoot: string): EnvironmentModeCacheV2TransactionStatus;
  print(value: string): void;
  registerAlpha?: (registry: EnvironmentProfileRegistry, appPath: string) => EnvironmentProfileRegistry;
  readRegistry(file: string): EnvironmentProfileRegistry | null;
}

const DEFAULT_DEPENDENCIES: EnvironmentCommandDependencies = {
  paths: userPaths,
  loadState: loadEnvironmentState,
  inspectProfile: inspectEnvironmentProfile,
  inspectManagedAlpha: inspectManagedAlphaBackend,
  writeRegistry: writeEnvironmentProfileRegistry,
  preparationCapabilities: environmentPreparationCapabilities,
  createRequestedSelection: createRequestedEnvironmentSelection,
  createCoordinator: createEnvironmentCoordinator,
  submitCommitHelper: submitEnvironmentCommitHelper,
  resolvePreparedCommitCli: resolvePreparedEnvironmentCommitCli,
  environmentModeCacheV2Enabled,
  createModeCacheGenerationId: randomUUID,
  observeModeCacheV2Transaction: observeEnvironmentModeCacheV2Transaction,
  print: (value) => console.log(value),
  registerAlpha: registerAlphaDesktopProfile,
  readRegistry: readEnvironmentProfileRegistry,
};

/**
 * Run one durable environment action. The command owns no desktop lifecycle;
 * all mutation remains inside the transaction coordinator and its external
 * commit helper.
 */
export async function environment(
  rawAction: string,
  options: EnvironmentCommandOptions = {},
  dependencies: EnvironmentCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<EnvironmentCommandResult> {
  const action = parseEnvironmentAction(rawAction);
  const paths = dependencies.paths();
  const run = (): Promise<EnvironmentCommandResult> => runEnvironmentAction(
    action,
    options,
    dependencies,
    paths,
  );

  // Transaction polling is deliberately read-only and must remain observable
  // while an external helper owns the lifecycle lease. Every action that can
  // recover or publish environment documents is serialized before its first
  // read-modify-write operation.
  if ((action === "status" && options.observe === true)
    || action === "transaction"
    || ["commit", "verify", "rollback", "recover", "cancel"].includes(action)) {
    return run();
  }
  return withLifecycleLock(
    lifecycleLockFile(paths.root),
    `environment command ${action}`,
    run,
  );
}

async function runEnvironmentAction(
  action: EnvironmentAction,
  options: EnvironmentCommandOptions,
  dependencies: EnvironmentCommandDependencies,
  paths: ResolvedUserPaths,
): Promise<EnvironmentCommandResult> {
  let coordinatorInstance: EnvironmentCoordinator | null = null;
  // The only command-level rollout decision. A missing or untrusted config
  // value is false, so ordinary commands construct the unchanged schema-v1
  // coordinator and never create a cache generation or helper pin.
  const modeCacheV2 = dependencies.environmentModeCacheV2Enabled?.(paths.configFile) === true;
  const configuredBundledDerivedReceipt = optionValue(
    options.bundledDerivedReceipt,
    options["bundled-derived-receipt"],
    "bundled-derived receipt",
  );
  if (configuredBundledDerivedReceipt !== undefined && action !== "prepare") {
    throw new Error("Bundled-derived receipt may be configured only during environment prepare");
  }
  const bundledDerivedReceiptFile = configuredBundledDerivedReceipt === undefined
    ? undefined
    : parseBundledDerivedReceiptPath(configuredBundledDerivedReceipt);
  const coordinator = (): EnvironmentCoordinator => {
    coordinatorInstance ??= dependencies.createCoordinator(coordinatorOptions(
      paths,
      bundledDerivedReceiptFile,
      modeCacheV2,
    ));
    return coordinatorInstance;
  };

  let result: EnvironmentCommandResult;
  switch (action) {
    case "status": {
      const observe = options.observe === true;
      const loaded = recomputeEnvironmentTruth(paths, dependencies, observe);
      result = environmentStatus(
        loaded,
        observe ? observeEnvironment(paths, loaded.current) : undefined,
        paths.root,
      );
      break;
    }
    case "register-alpha": {
      const explicitPath = optionValue(options.appPath, options["app-path"], "app path");
      const appPath = optionValue(explicitPath, options.app, "app path");
      if (typeof appPath !== "string") throw new Error("OpenAI Beta app path is required");
      const exactPath = normalize(appPath);
      if (!isAbsolute(appPath) || exactPath !== appPath || !/\.app$/i.test(appPath)) {
        throw new Error("OpenAI Beta app path must be an exact absolute .app path");
      }
      recoverEnvironmentDocumentCommit(paths.environmentRegistryFile, paths.environmentSelectionFile);
      const existing = dependencies.readRegistry(paths.environmentRegistryFile);
      if (!existing) throw new Error("Environment profile registry is missing");
      const current = existing.selected ?? existing.lastKnownWorkingSelection;
      if (!current) throw new Error("Environment selection is missing");
      const registered = dependencies.registerAlpha!(existing, appPath);
      if (current.releaseProfile === "alpha"
        && current.selectedDesktopPath !== registered.profiles.alpha.officialPath) {
        throw new Error("Cannot replace the registered Alpha desktop while Alpha is selected");
      }
      result = environmentStatus({
        registry: registered,
        current,
        migratedFromLegacy: false,
      }, undefined, paths.root);
      dependencies.writeRegistry(paths.environmentRegistryFile, registered);
      break;
    }
    case "transaction": {
      if (modeCacheV2) {
        // A v2 poll must never ask the legacy coordinator for a schema-v1
        // receipt: a prepared pair and its warm journal are a separate,
        // durable control plane with no compatible legacy status record.
        result = (dependencies.observeModeCacheV2Transaction
          ?? observeEnvironmentModeCacheV2Transaction)(paths.root);
        break;
      }
      const receipt = coordinator().status();
      // Output-only owner-liveness annotation; the receipt file is never
      // rewritten, so durable evidence and validators are untouched.
      result = receipt === null
        ? idleEnvironmentTransaction()
        : isTerminalEnvironmentPhase(receipt.phase)
          ? annotateEnvironmentTransaction(receipt)
          : annotateEnvironmentTransaction(receipt, receipt.ownerPid === process.pid || processAlive(receipt.ownerPid));
      break;
    }
    case "prepare": {
      const appExperience = parseAppExperience(optionValue(
        options.appExperience,
        options["app-experience"],
        "app experience",
      ));
      const releaseProfile = parseReleaseProfile(optionValue(
        options.releaseProfile,
        options["release-profile"],
        "release profile",
      ));
      const loaded = recomputeEnvironmentTruth(paths, dependencies);

      const requested = dependencies.createRequestedSelection(loaded.registry, {
        appExperience,
        releaseProfile,
      });
      // Preparation may publish refreshed evidence, but never the requested
      // selection. Selection publication belongs exclusively to post-reopen
      // proof in the coordinator.
      dependencies.writeRegistry(paths.environmentRegistryFile, loaded.registry);
      if (modeCacheV2) {
        const generationId = requireModeCacheGenerationId(
          dependencies.createModeCacheGenerationId?.() ?? randomUUID(),
        );
        const prepared = await requireModeCacheV2Coordinator(coordinator()).prepareModeCacheV2!({
          current: loaded.current,
          requested,
          generationId,
        });
        result = projectEnvironmentModeCacheV2Preparation(prepared);
      } else {
        result = await coordinator().prepare({ current: loaded.current, requested });
      }
      break;
    }
    case "submit": {
      const transactionId = parseTransactionId(options.transaction);
      const approvalAt = optionValue(
        options.approvalAt,
        options["approval-at"],
        "approval timestamp",
      );
      if (modeCacheV2) {
        if (typeof approvalAt !== "string") {
          throw new Error("Environment mode v2 submit requires a captured approval timestamp");
        }
        const controlPlane = requireModeCacheV2Coordinator(coordinator()).resolvePreparedModeCacheV2CommitCli!(transactionId);
        result = dependencies.submitCommitHelper({
          transactionId,
          approvalAt,
          cliPath: controlPlane.cliPath,
          cliArtifactDigest: controlPlane.cliArtifactDigest,
          managedRuntimeArtifactPath: controlPlane.managedRuntimeArtifactPath,
          managedRuntimeArtifactDigest: controlPlane.managedRuntimeArtifactDigest,
          userRoot: paths.root,
          receiptFile: controlPlane.receiptFile,
        });
        break;
      }
      const receipt = requireTransaction(coordinator(), transactionId);
      if (receipt.phase !== "prepared") {
        throw new Error(
          `Environment transaction ${transactionId} cannot submit from phase ${receipt.phase}`,
        );
      }
      const controlPlane = dependencies.resolvePreparedCommitCli(
        receipt,
        paths.environmentReceiptRoot,
      );
      result = dependencies.submitCommitHelper({
        transactionId,
        cliPath: controlPlane.cliPath,
        cliArtifactDigest: controlPlane.cliArtifactDigest,
        managedRuntimeArtifactPath: controlPlane.managedRuntimeArtifactPath,
        managedRuntimeArtifactDigest: controlPlane.managedRuntimeArtifactDigest,
        userRoot: paths.root,
        receiptFile: join(paths.environmentReceiptRoot, transactionId, "commit-helper.json"),
      });
      break;
    }
    case "commit": {
      const transactionId = parseTransactionId(options.transaction);
      const approvalAt = optionValue(
        options.approvalAt,
        options["approval-at"],
        "approval timestamp",
      );
      if (modeCacheV2) {
        if (typeof approvalAt !== "string") {
          throw new Error("Environment mode v2 commit requires a captured approval timestamp");
        }
        result = await requireModeCacheV2Coordinator(coordinator()).commitModeCacheV2!({
          transactionId,
          approvalAt,
        });
      } else {
        result = await coordinator().commit(transactionId, approvalAt);
      }
      break;
    }
    case "verify": {
      result = await coordinator().verify(parseTransactionId(options.transaction));
      break;
    }
    case "rollback": {
      result = await coordinator().rollback(parseTransactionId(options.transaction));
      break;
    }
    case "recover": {
      const transactionId = options.transaction === undefined ? undefined : parseTransactionId(options.transaction);
      result = modeCacheV2
        ? await requireModeCacheV2Coordinator(coordinator()).recoverModeCacheV2!({
          ...(transactionId === undefined ? {} : { transactionId }),
        })
        : await coordinator().recover(transactionId);
      break;
    }
    case "cancel": {
      const transactionId = parseTransactionId(options.transaction);
      if (modeCacheV2) {
        await requireModeCacheV2Coordinator(coordinator()).cancelModeCacheV2!({ transactionId });
        result = (dependencies.observeModeCacheV2Transaction ?? observeEnvironmentModeCacheV2Transaction)(paths.root);
      } else {
        result = await coordinator().cancel(transactionId);
      }
      break;
    }
    case "gc": {
      const dryRun = options.dryRun === true || options["dry-run"] === true;
      const apply = options.apply === true;
      if (dryRun === apply) {
        throw new Error("Environment GC requires exactly one of --dry-run or --apply");
      }
      result = runEnvironmentTransactionGc({
        receiptRoot: paths.environmentReceiptRoot,
        transactionFile: paths.environmentTransactionFile,
        cachePaths: environmentModeCachePaths(paths.root),
        mode: apply ? "apply" : "dry-run",
      });
      break;
    }
  }

  if (options.quiet !== true) printResult(result, options.json === true, dependencies.print);
  return result;
}

function recomputeEnvironmentTruth(
  paths: ResolvedUserPaths,
  dependencies: EnvironmentCommandDependencies,
  observe = false,
): LoadedEnvironmentState {
  const capabilities = dependencies.preparationCapabilities();
  const input = {
    legacyStateFile: paths.stateFile,
    registryFile: paths.environmentRegistryFile,
    selectionFile: paths.environmentSelectionFile,
    environmentRoot: paths.root,
    stableDesktopPath: STABLE_DESKTOP_PATH,
    alphaDesktopPath: ALPHA_DESKTOP_PATH,
    stableEvidence: {
      patchedPayloadBuildable: capabilities.patchedPayloadBuildable,
    },
    alphaEvidence: {
      backendInstallable: capabilities.backendInstallable,
      patchedPayloadBuildable: capabilities.patchedPayloadBuildable,
    },
  };
  if (observe) {
    return dependencies.loadState(input, {
      recoverCommit: false,
      inspectProfile: (profile, _current, persistedProfile) => (
        cachedProfileEvidence(persistedProfile ?? profile)
      ),
    });
  }

  const managedAlpha = dependencies.inspectManagedAlpha(paths.root);
  return dependencies.loadState(input, {
    recoverCommit: true,
    inspectProfile: (profile, current) => {
      const evidence = dependencies.inspectProfile(profile, current);
      if (profile.releaseProfile === "alpha") {
        evidence.backendVersion = managedAlpha.installed ? managedAlpha.version : null;
        evidence.backendFingerprint = managedAlpha.installed ? managedAlpha.fingerprint : null;
        if (!managedAlpha.installed && !capabilities.backendInstallable) {
          evidence.unavailableReasons = [
            ...(evidence.unavailableReasons ?? []),
            managedAlpha.error ?? "Managed Alpha backend validation failed",
          ];
        }
      }
      return evidence;
    },
  });
}

/**
 * Passive status readers consume the last evidence published by a verified
 * lifecycle operation. This keeps menus and settings panels observational:
 * they never hash app trees or launch codesign merely to render current state.
 * Mutation paths still call the live inspectors above before publishing.
 */
function cachedProfileEvidence(profile: EnvironmentProfileRecord): EnvironmentProfileEvidenceInput {
  return {
    officialVersion: profile.officialVersion,
    officialBuild: profile.officialBuild,
    strictSignature: profile.strictSignature,
    gatekeeper: profile.gatekeeper,
    teamIdentifier: profile.teamIdentifier,
    designatedRequirement: profile.designatedRequirement,
    signatureCheckedAt: profile.signatureCheckedAt,
    officialBackendPath: profile.officialBackendPath,
    officialBackendVersion: profile.officialBackendVersion,
    officialBackendFingerprint: profile.officialBackendFingerprint,
    backendPath: profile.backendPath,
    backendVersion: profile.backendVersion,
    backendChannel: profile.backendChannel,
    backendFingerprint: profile.backendFingerprint,
    pristineBackupPath: profile.pristineBackupPath,
    pristineBackupFingerprint: profile.pristineBackupFingerprint,
    patchedPayloadPath: profile.patchedPayloadPath,
    patchedPayloadFingerprint: profile.patchedPayloadFingerprint,
    backendInstallable: profile.backendInstallable,
    patchedPayloadBuildable: profile.patchedPayloadBuildable,
    unavailableReasons: profile.unavailableReasons,
  };
}

function environmentStatus(
  loaded: LoadedEnvironmentState,
  observation?: EnvironmentObservationStatus,
  environmentRoot: string = userPaths().root,
): EnvironmentStatusResult {
  return {
    schemaVersion: 1,
    selected: loaded.current,
    channels: {
      stable: loaded.registry.profiles.stable,
      alpha: loaded.registry.profiles.alpha,
    },
    ...(observation ? { observation } : {}),
    // This helper only reads the existing cache layout. It never creates
    // roots, takes a lease, validates bytes, or changes a pin/journal.
    cacheV2: observeEnvironmentModeCache(environmentModeCachePaths(environmentRoot)),
  };
}

function observeEnvironment(
  paths: ResolvedUserPaths,
  selected: LoadedEnvironmentState["current"],
): EnvironmentObservationStatus {
  const marker = readAsarMarker(join(
    selected.selectedDesktopPath,
    "Contents",
    "Resources",
    "app.asar",
  ));
  const appExperience = marker === "present"
    ? "tweakers"
    : marker === "absent"
      ? "chatgpt"
      : null;
  const lifecycleContended = isLifecycleLockHeld(paths.root);
  const commitJournalPresent = existsSync(environmentCommitJournalFile(paths.environmentRegistryFile));
  const transitionJournalPresent = existsSync(modeTransitionFile(paths.root));
  let transaction: EnvironmentObservationStatus["transaction"] = null;
  try {
    const receipt = readEnvironmentTransactionReceipt(paths.environmentTransactionFile);
    if (receipt !== null) {
      transaction = {
        transactionId: receipt.transactionId,
        phase: receipt.phase,
        ...(receipt.timing ? { timing: environmentTransactionTimingStatus(receipt.timing) } : {}),
      };
    }
  } catch {
    // A malformed receipt remains a mutation/recovery concern. Observation
    // stays available and reports no trusted transaction identity.
  }
  return {
    appExperience,
    selectionDrift: appExperience !== null && appExperience !== selected.appExperience,
    lifecycleContended,
    commitJournalPresent,
    transitionJournalPresent,
    transaction,
    freshness: lifecycleContended || commitJournalPresent ? "contended" : "current",
  };
}

function annotateEnvironmentTransaction(
  receipt: EnvironmentTransactionReceipt,
  ownerAlive = true,
): AnnotatedEnvironmentTransactionReceipt {
  return {
    ...receipt,
    ownerAlive,
    ...(receipt.timing ? { timingSummary: environmentTransactionTimingStatus(receipt.timing) } : {}),
  };
}

export function environmentTransactionTimingStatus(
  timing: EnvironmentTimingEvidence,
): EnvironmentTransactionTimingStatus {
  const approvalMs = timing.approvalAt === null ? Number.NaN : Date.parse(timing.approvalAt);
  const readyMs = timing.readyAt === null ? Number.NaN : Date.parse(timing.readyAt);
  const approvalToReadyDurationMs = Number.isFinite(approvalMs)
    && Number.isFinite(readyMs)
    && readyMs >= approvalMs
    ? readyMs - approvalMs
    : null;
  return {
    approvalAt: timing.approvalAt,
    readyAt: timing.readyAt,
    approvalToReadyDurationMs,
    phases: timing.phases,
  };
}

function idleEnvironmentTransaction(): IdleEnvironmentTransaction {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: null,
    phase: "idle",
  };
}

/**
 * Convert a successful v2 preparation to the ordinary transaction envelope
 * without discarding the pair receipt that existing mode commands consume.
 */
export function projectEnvironmentModeCacheV2Preparation(
  prepared: EnvironmentModeCacheV2PreparationResult,
): EnvironmentModeCacheV2PreparationProjection {
  if (prepared.state !== "ready" || prepared.receipt === null) {
    throw new Error("Environment mode v2 prepare did not return a ready sealed-pair receipt");
  }
  const pair = prepared.receipt;
  if (pair.pin.state !== "prepared" || pair.pin.releasedAt !== null) {
    throw new Error("Environment mode v2 prepare returned a non-prepared sealed-pair receipt");
  }
  return {
    ...prepared,
    receipt: pair,
    schemaVersion: 2,
    kind: "environment-mode-v2-transaction",
    transactionId: pair.generationId,
    generationId: pair.generationId,
    phase: "prepared",
    error: null,
    timing: null,
    createdAt: pair.timestamps.preparedAt,
    updatedAt: pair.timestamps.validatedAt,
    terminalAt: null,
    pinState: pair.pin.state,
    requested: {
      appExperience: pair.roles.inactive.experience,
      releaseProfile: pair.releaseProfile,
    },
  };
}

/**
 * Observe the current schema-v2 pair and its generation-local journal without
 * constructing the legacy coordinator or reading its transaction receipt.
 * A malformed authoritative record is surfaced as an error rather than being
 * misreported as idle, because a caller must not prepare over unknown state.
 */
export function observeEnvironmentModeCacheV2Transaction(
  environmentRoot: string,
): EnvironmentModeCacheV2TransactionStatus {
  const pair = readCurrentEnvironmentModePair(environmentModeCachePaths(environmentRoot));
  if (pair === null) {
    return {
      schemaVersion: 2,
      kind: "environment-mode-v2-transaction",
      transactionId: null,
      generationId: null,
      phase: "idle",
      error: null,
      timing: null,
      createdAt: null,
      updatedAt: null,
      terminalAt: null,
      pinState: null,
      requested: null,
    };
  }

  const journal = readEnvironmentWarmCommitReceipt(environmentWarmCommitJournalFile(pair));
  if (journal !== null
    && (journal.generationId !== pair.generationId || journal.transactionId !== pair.generationId)) {
    throw new Error(
      `Environment mode v2 warm journal identity ${journal.transactionId}/${journal.generationId} does not match current generation ${pair.generationId}`,
    );
  }
  return projectEnvironmentModeCacheV2PairTransaction(pair, journal);
}

function projectEnvironmentModeCacheV2PairTransaction(
  pair: EnvironmentModePairReceipt,
  journal: EnvironmentWarmCommitReceipt | null,
): EnvironmentModeCacheV2TransactionStatus {
  return {
    schemaVersion: 2,
    kind: "environment-mode-v2-transaction",
    transactionId: pair.generationId,
    generationId: pair.generationId,
    // The journal is the durable mutation authority as soon as it exists;
    // otherwise the pair's persistent pin is the only truthful phase.
    phase: journal?.phase ?? pair.pin.state,
    error: journal?.error ?? null,
    timing: journal?.timing ?? null,
    createdAt: journal?.createdAt ?? pair.timestamps.preparedAt,
    updatedAt: journal?.updatedAt ?? modeCacheV2PairUpdatedAt(pair),
    terminalAt: journal?.terminalAt ?? pair.timestamps.terminalAt,
    pinState: pair.pin.state,
    requested: {
      appExperience: journal?.targetExperience ?? pair.roles.inactive.experience,
      releaseProfile: pair.releaseProfile,
    },
  };
}

function modeCacheV2PairUpdatedAt(pair: EnvironmentModePairReceipt): string {
  return pair.timestamps.terminalAt
    ?? pair.timestamps.lastPreCutoverCancellationAt
    ?? pair.timestamps.lastSuccessfulSwitchAt
    ?? pair.timestamps.publishedAt
    ?? pair.timestamps.validatedAt;
}

function coordinatorOptions(
  paths: ResolvedUserPaths,
  bundledDerivedReceiptFile?: string,
  environmentModeCacheV2 = false,
): EnvironmentCoordinatorOptions {
  return {
    environmentRoot: paths.root,
    transactionFile: paths.environmentTransactionFile,
    receiptRoot: paths.environmentReceiptRoot,
    selectionFile: paths.environmentSelectionFile,
    registryFile: paths.environmentRegistryFile,
    configFile: paths.configFile,
    stateFile: paths.stateFile,
    runtimeProofFile: paths.environmentRuntimeProofFile,
    mcpStateFile: join(paths.root, "mcp-sync-state.json"),
    tweaksRoot: paths.tweaks,
    lockFile: paths.environmentLockFile,
    ...(environmentModeCacheV2 ? { environmentModeCacheV2: true } : {}),
    ...(bundledDerivedReceiptFile ? { bundledDerivedReceiptFile } : {}),
  };
}

function requireModeCacheV2Coordinator(coordinator: EnvironmentCoordinator): Required<Pick<
  EnvironmentCoordinator,
  "prepareModeCacheV2" | "commitModeCacheV2" | "cancelModeCacheV2" | "recoverModeCacheV2" | "resolvePreparedModeCacheV2CommitCli"
>> & EnvironmentCoordinator {
  if (!coordinator.prepareModeCacheV2
    || !coordinator.commitModeCacheV2
    || !coordinator.cancelModeCacheV2
    || !coordinator.recoverModeCacheV2
    || !coordinator.resolvePreparedModeCacheV2CommitCli) {
    throw new Error("environmentModeCacheV2 is enabled but the Environment coordinator has no bound v2 production adapter");
  }
  return coordinator as Required<Pick<
    EnvironmentCoordinator,
    "prepareModeCacheV2" | "commitModeCacheV2" | "cancelModeCacheV2" | "recoverModeCacheV2" | "resolvePreparedModeCacheV2CommitCli"
  >> & EnvironmentCoordinator;
}

function requireModeCacheGenerationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Environment mode v2 generation ID is invalid");
  }
  return value;
}

function parseBundledDerivedReceiptPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error("Bundled-derived receipt path must be exact and absolute");
  }
  if (value === "/Volumes" || value.startsWith("/Volumes/")) {
    throw new Error("Bundled-derived receipt must remain on the internal filesystem");
  }
  return value;
}

function requireTransaction(
  coordinator: EnvironmentCoordinator,
  transactionId: string,
): EnvironmentTransactionReceipt {
  const receipt = coordinator.status();
  if (receipt === null) throw new Error("No environment transaction receipt exists");
  if (receipt.transactionId !== transactionId) {
    throw new Error(
      `Environment transaction mismatch: expected ${transactionId}, found ${receipt.transactionId}`,
    );
  }
  return receipt;
}

function parseEnvironmentAction(value: string): EnvironmentAction {
  if ((ENVIRONMENT_ACTIONS as readonly string[]).includes(value)) return value as EnvironmentAction;
  throw new Error(`Unknown environment action: ${value}`);
}

function parseAppExperience(value: string | undefined): AppExperience {
  if (value === "chatgpt" || value === "tweakers") return value;
  throw new Error("Environment app experience must be chatgpt or tweakers");
}

function parseReleaseProfile(value: string | undefined): ReleaseProfile {
  if (value === "stable" || value === "alpha") return value;
  throw new Error("Environment release profile must be stable or alpha");
}

function parseTransactionId(value: string | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Environment transaction ID is invalid");
  }
  return value;
}

function optionValue(
  camelCase: string | undefined,
  hyphenated: string | undefined,
  label: string,
): string | undefined {
  if (camelCase !== undefined && hyphenated !== undefined && camelCase !== hyphenated) {
    throw new Error(`Conflicting ${label} options`);
  }
  return camelCase ?? hyphenated;
}

function printResult(
  result: EnvironmentCommandResult,
  json: boolean,
  print: (value: string) => void,
): void {
  print(JSON.stringify(result, null, json ? undefined : 2));
}

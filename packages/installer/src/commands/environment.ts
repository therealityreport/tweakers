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
  type EnvironmentPreparationCapabilities,
  type PreparedEnvironmentCommitCli,
  type EnvironmentTransactionReceipt,
  type EnvironmentVerification,
  type SubmitEnvironmentCommitHelperInput,
  isTerminalEnvironmentPhase,
  readEnvironmentTransactionReceipt,
} from "../environment-transaction.js";
import { processAlive } from "../process-lock.js";
import { userPaths, type ResolvedUserPaths } from "../paths.js";
import { isLifecycleLockHeld, lifecycleLockFile, withLifecycleLock } from "../lifecycle-lock.js";
import { modeTransitionFile } from "../mode-transition.js";
import { readAsarMarker } from "./install.js";
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
  observe?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  apply?: boolean;
  json?: boolean;
  /** Internal compatibility clients may consume the typed result directly. */
  quiet?: boolean;
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
}

export interface EnvironmentObservationStatus {
  appExperience: AppExperience | null;
  selectionDrift: boolean;
  lifecycleContended: boolean;
  commitJournalPresent: boolean;
  transitionJournalPresent: boolean;
  transaction: { transactionId: string; phase: string } | null;
  freshness: "current" | "contended";
}

export interface IdleEnvironmentTransaction {
  schemaVersion: 1;
  kind: "environment";
  transactionId: null;
  phase: "idle";
}

/** Receipt plus an output-only ownerPid liveness annotation (never persisted). */
export type AnnotatedEnvironmentTransactionReceipt = EnvironmentTransactionReceipt & {
  ownerAlive: boolean;
};

export type EnvironmentCommandResult =
  | EnvironmentStatusResult
  | IdleEnvironmentTransaction
  | EnvironmentTransactionReceipt
  | AnnotatedEnvironmentTransactionReceipt
  | EnvironmentCommitHelperReceipt
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
  const coordinator = (): EnvironmentCoordinator => {
    coordinatorInstance ??= dependencies.createCoordinator(coordinatorOptions(paths));
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
      });
      dependencies.writeRegistry(paths.environmentRegistryFile, registered);
      break;
    }
    case "transaction": {
      const receipt = coordinator().status();
      // Output-only owner-liveness annotation; the receipt file is never
      // rewritten, so durable evidence and validators are untouched.
      result = receipt === null
        ? idleEnvironmentTransaction()
        : isTerminalEnvironmentPhase(receipt.phase)
          ? receipt
          : { ...receipt, ownerAlive: receipt.ownerPid === process.pid || processAlive(receipt.ownerPid) };
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
      result = await coordinator().prepare({ current: loaded.current, requested });
      break;
    }
    case "submit": {
      const transactionId = parseTransactionId(options.transaction);
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
      result = await coordinator().commit(parseTransactionId(options.transaction));
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
      result = await coordinator().recover(parseTransactionId(options.transaction));
      break;
    }
    case "cancel": {
      result = await coordinator().cancel(parseTransactionId(options.transaction));
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
): EnvironmentStatusResult {
  return {
    schemaVersion: 1,
    selected: loaded.current,
    channels: {
      stable: loaded.registry.profiles.stable,
      alpha: loaded.registry.profiles.alpha,
    },
    ...(observation ? { observation } : {}),
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
      transaction = { transactionId: receipt.transactionId, phase: receipt.phase };
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

function idleEnvironmentTransaction(): IdleEnvironmentTransaction {
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: null,
    phase: "idle",
  };
}

function coordinatorOptions(paths: ResolvedUserPaths): EnvironmentCoordinatorOptions {
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
  };
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

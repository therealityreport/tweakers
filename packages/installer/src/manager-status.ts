import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MANAGER_PROTOCOL_VERSION,
  MANAGER_REFRESH_TIMING_PHASES_V1,
  MANAGER_STATUS_SCHEMA_VERSION,
  TWEAKERS_MANAGER_ID,
  canonicalManagerJson,
  createManagerStateToken,
  type ManagerActionAvailabilityV1,
  type ManagerDashboardCoordinatorV1,
  type ManagerDashboardEnvironmentV1,
  type ManagerDashboardInstallationV1,
  type ManagerDashboardInjectedPatchV1,
  type ManagerDashboardModeV1,
  type ManagerOperationDetailV1,
  type ManagerDashboardOperationsV1,
  type ManagerDashboardRuntimeV1,
  type ManagerDashboardTweakersPatchV1,
  type ManagerDashboardUpdaterV1,
  type ManagerDocumentStateV1,
  type ManagerExecutableIdentityV1,
  type ManagerReceiptChronologyEntryV1,
  type ManagerReceiptSourceV1,
  type ManagerStateTokenInputsV1,
  type TweakersManagerActionIdV1,
  type TweakersManagerStatusSnapshotV1,
  TWEAKERS_MANAGER_ACTION_IDS_V1,
} from "./manager-contract.js";
import { isCandidateCopyPrecutoverFailure, isManagerOperationId, parsePreparedOperation } from "./manager-operation-store.js";
import { parseManagerStrictJsonObject } from "./manager-strict-json.js";
import {
  readRegisteredOfficialSource,
  readRegisteredOfficialSourceStatusProjection,
  type RegisteredOfficialSourceStatus,
} from "./official-source-registration.js";
import { userPaths } from "./paths.js";

const UPDATE_MODE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_CODEX_DERIVED_RECEIPTS = 64;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ManagerStatusPaths {
  root: string;
  configFile: string;
  stateFile: string;
  independentStateFile: string;
  updateModeFile: string;
  environmentRegistryFile: string;
  environmentSelectionFile: string;
  environmentTransactionFile: string;
  chatgptAppUpdateReceiptFile: string;
  desktopUpdateReceiptFile: string;
  environmentModeCacheCurrentFile: string;
  officialSourceTransactionFile: string;
  lifecycleLockFile: string;
  managerOperationRoot: string;
  managedRuntimeProvenanceFile: string;
  codexDerivedReceiptRoot: string;
}

export type ManagerStatusTextRead =
  | { state: "missing" }
  | { state: "present"; text: string }
  | { state: "unreadable"; problem: string };

export type ManagerStatusDirectoryRead =
  | { state: "missing" }
  | { state: "present"; entries: readonly string[] }
  | { state: "unreadable"; problem: string };

/**
 * Every filesystem dependency is injectable. The default implementation is
 * intentionally read-only: it does not call ensureUserPaths, chmod, repair,
 * launch a process, or rewrite a receipt/operation. It may project an exact
 * terminal receipt as completion of an already-consumed manager record.
 */
export interface ManagerStatusDependencies {
  now?: () => string;
  readText?: (path: string) => ManagerStatusTextRead;
  readDirectory?: (path: string) => ManagerStatusDirectoryRead;
  /** Source-store verification is injectable for strict status fixtures. The
   * production default validates the sealed pointer/receipt and exact source
   * metadata without rescanning whole app trees. The refresh executor performs
   * the full tree/signature/Gatekeeper validation before using any bytes. */
  registeredOfficialSource?: (root: string) => RegisteredOfficialSourceStatus;
  /** Strict on-demand observer used only by the fixed registration protocol.
   * Keeping this separate prevents a projected test/caller seam from
   * weakening a requested strict observation. */
  strictRegisteredOfficialSource?: (root: string) => RegisteredOfficialSourceStatus;
}

export interface CreateTweakersManagerStatusSnapshotInput {
  executable: ManagerExecutableIdentityV1;
  /**
   * Generic dashboard polling uses the metadata-only projection. The fixed
   * official-source registration query/prepare/execute path opts into a full
   * tree/signature observation so a changed official app can be bound without
   * making every status poll rescan the application.
   */
  officialSourceVerification?: "projected" | "strict";
  /**
   * Compiled manager-safe executors linked into this exact runtime. Status
   * never learns capabilities from a descriptor or receipt. The sealed CLI
   * currently passes none until each family has a narrow standalone executor.
   */
  enabledActionIds?: readonly TweakersManagerActionIdV1[];
  /** Defaults to userPaths().root, which only resolves a path and never creates it. */
  paths?: ManagerStatusPaths;
  /**
   * Internal execute-time projection. The exact already-bound operation is
   * omitted so persisting its approval does not invalidate the approval by
   * itself. Every other operation, receipt, config, and executable remains in
   * the token and therefore still causes a stale-state rejection.
   */
  excludeOperationId?: string;
}

interface ReadDocument {
  state: ManagerDocumentStateV1;
  revision: string;
  value: Record<string, unknown> | null;
  problem: string | null;
}

interface ParsedReceipt {
  entry: ManagerReceiptChronologyEntryV1;
  activeOperationId: string | null;
}

interface ManagerStatusObservations {
  generatedAt: string;
  configurationRevision: string;
  installation: ManagerDashboardInstallationV1;
  independentInstallation: ManagerDashboardInstallationV1;
  mode: ManagerDashboardModeV1;
  environment: ManagerDashboardEnvironmentV1;
  chatgptAppUpdate: ManagerDashboardUpdaterV1;
  injectedPatch: ManagerDashboardInjectedPatchV1;
  tweakersPatch: ManagerDashboardTweakersPatchV1;
  updater: ManagerDashboardUpdaterV1;
  runtime: ManagerDashboardRuntimeV1;
  receipts: readonly ParsedReceipt[];
  coordinator: ManagerDashboardCoordinatorV1;
}

export function managerStatusPaths(root: string): ManagerStatusPaths {
  return {
    root,
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    independentStateFile: join(root, "variants", "tweakers", "state.json"),
    updateModeFile: join(root, "update-mode.json"),
    environmentRegistryFile: join(root, "environment-registry.json"),
    environmentSelectionFile: join(root, "environment-selection.json"),
    environmentTransactionFile: join(root, "transactions", "environment.json"),
    chatgptAppUpdateReceiptFile: join(root, "transactions", "chatgpt-app-update.json"),
    desktopUpdateReceiptFile: join(root, "transactions", "desktop-update.json"),
    environmentModeCacheCurrentFile: join(root, "environment-cache", "current.json"),
    officialSourceTransactionFile: join(root, "transactions", "official-source-registration.json"),
    lifecycleLockFile: join(root, "transactions", "lifecycle.lock"),
    managerOperationRoot: join(root, "transactions", "manager-operations"),
    managedRuntimeProvenanceFile: join(root, "managed-runtime", "current", ".tweakers-provenance.json"),
    codexDerivedReceiptRoot: join(root, "codex-source", "receipts"),
  };
}

/**
 * Read the installer dashboard without creating or repairing anything.
 *
 * Malformed durable state stays visible (and affects the token) rather than
 * being normalized, recreated, or ignored. The returned graph is deeply
 * frozen so a caller cannot accidentally mutate the captured snapshot.
 */
export function createTweakersManagerStatusSnapshot(
  input: CreateTweakersManagerStatusSnapshotInput,
  dependencies: ManagerStatusDependencies = {},
): TweakersManagerStatusSnapshotV1 {
  const paths = input.paths ?? managerStatusPaths(userPaths().root);
  const readText = dependencies.readText ?? defaultReadText;
  const readDirectory = dependencies.readDirectory ?? defaultReadDirectory;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const generatedAt = assertRfc3339(now(), "manager status clock");
  const observations = observeManagerStatus(
    paths,
    readText,
    readDirectory,
    generatedAt,
    input.officialSourceVerification === "strict"
      ? dependencies.strictRegisteredOfficialSource ?? readRegisteredOfficialSource
      : dependencies.registeredOfficialSource ?? readRegisteredOfficialSourceStatusProjection,
  );
  const operations = observeManagerOperations(
    paths.root,
    paths.managerOperationRoot,
    readText,
    readDirectory,
    observations.receipts,
    observations.chatgptAppUpdate,
    observations.updater,
    input.excludeOperationId,
  );
  const enabledActionIds = compiledEnabledActionIds(input.enabledActionIds);
  return createManagerStatusSnapshotProjection(
    input.executable,
    observations,
    operations,
    enabledActionIds,
    actionAvailability(
      observations.receipts,
      observations.injectedPatch,
      observations.tweakersPatch,
      observations.environment,
      observations.installation,
      observations.independentInstallation,
      operations,
      enabledActionIds,
    ),
  );
}

/**
 * Production status-only projection. It deliberately omits the manager
 * operation store and action availability graph so the sealed bundle cannot
 * acquire an action dependency merely by collecting status.
 */
export function createTweakersManagerReadOnlyStatusSnapshot(
  input: Pick<CreateTweakersManagerStatusSnapshotInput, "executable" | "paths">,
  dependencies: ManagerStatusDependencies = {},
): TweakersManagerStatusSnapshotV1 {
  const paths = input.paths ?? managerStatusPaths(userPaths().root);
  const readText = dependencies.readText ?? defaultReadText;
  const readDirectory = dependencies.readDirectory ?? defaultReadDirectory;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const generatedAt = assertRfc3339(now(), "manager status clock");
  const observations = observeManagerStatus(
    paths,
    readText,
    readDirectory,
    generatedAt,
    dependencies.registeredOfficialSource ?? readRegisteredOfficialSourceStatusProjection,
  );
  const operations: ManagerDashboardOperationsV1 = {
    state: "missing",
    revision: "status-only",
    activeOperationId: null,
    preparedCount: 0,
    detail: null,
    problem: null,
  };
  return createManagerStatusSnapshotProjection(input.executable, observations, operations, [], []);
}

function observeManagerStatus(
  paths: ManagerStatusPaths,
  readText: (path: string) => ManagerStatusTextRead,
  readDirectory: (path: string) => ManagerStatusDirectoryRead,
  generatedAt: string,
  registeredOfficialSource: (root: string) => RegisteredOfficialSourceStatus,
): ManagerStatusObservations {
  const config = readDocument(paths.configFile, readText);
  const installerState = readDocument(paths.stateFile, readText);
  const independentInstallerState = readDocument(paths.independentStateFile, readText);
  const updateMode = readDocument(paths.updateModeFile, readText);
  const environmentRegistry = readDocument(paths.environmentRegistryFile, readText);
  const environmentSelection = readDocument(paths.environmentSelectionFile, readText);
  const environmentReceipt = readDocument(paths.environmentTransactionFile, readText);
  const chatgptAppUpdateReceipt = readDocument(paths.chatgptAppUpdateReceiptFile, readText);
  const desktopReceipt = readDocument(paths.desktopUpdateReceiptFile, readText);
  const modeCacheReceipt = readDocument(paths.environmentModeCacheCurrentFile, readText);
  const officialSourceRegistration = readDocument(paths.officialSourceTransactionFile, readText);
  const runtimeProvenance = readDocument(paths.managedRuntimeProvenanceFile, readText);
  const lifecycleLock = readText(paths.lifecycleLockFile);
  const installation = observeInstallation(installerState);
  const independentInstallation = observeInstallation(independentInstallerState);
  const mode = observeMode(installerState, updateMode, generatedAt);
  const registeredStableSource = registeredOfficialSource(paths.root);
  const environment = observeEnvironment(environmentRegistry, environmentSelection, modeCacheReceipt, registeredStableSource);
  const chatgptAppUpdate = observeUpdater(chatgptAppUpdateReceipt);
  const updater = observeUpdater(desktopReceipt);
  const injectedPatch = observeInjectedPatch(installation, mode, environment);
  const tweakersPatch = observeTweakersPatch(independentInstallation, registeredStableSource);
  const runtime = observeRuntime(runtimeProvenance);
  const receipts = [
    observeEnvironmentReceipt(environmentReceipt),
    observeDesktopUpdateReceipt(chatgptAppUpdateReceipt, "chatgpt-app-update"),
    observeDesktopUpdateReceipt(desktopReceipt),
    observeModeCacheReceipt(modeCacheReceipt),
    observeOfficialSourceRegistrationReceipt(officialSourceRegistration),
    ...observeCodexDerivedReceipts(paths.codexDerivedReceiptRoot, readText, readDirectory),
  ];
  return {
    generatedAt,
    configurationRevision: config.revision,
    installation,
    independentInstallation,
    mode,
    environment,
    chatgptAppUpdate,
    injectedPatch,
    tweakersPatch,
    updater,
    runtime,
    receipts,
    coordinator: observeCoordinator(receipts, lifecycleLock),
  };
}

function createManagerStatusSnapshotProjection(
  executable: ManagerExecutableIdentityV1,
  observations: ManagerStatusObservations,
  operations: ManagerDashboardOperationsV1,
  allowedActions: readonly TweakersManagerActionIdV1[],
  actions: readonly ManagerActionAvailabilityV1[],
): TweakersManagerStatusSnapshotV1 {
  const stateTokenInputs: ManagerStateTokenInputsV1 = {
    schemaVersion: MANAGER_STATUS_SCHEMA_VERSION,
    manager: {
      id: TWEAKERS_MANAGER_ID,
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      executable,
    },
    configurationRevision: observations.configurationRevision,
    installation: {
      state: observations.installation.state,
      version: observations.installation.version,
      codexVersion: observations.installation.codexVersion,
      appRoot: observations.installation.appRoot,
      runtimeUpdatedAt: observations.installation.runtimeUpdatedAt,
      revision: observations.installation.revision,
    },
    independentInstallation: {
      state: observations.independentInstallation.state,
      version: observations.independentInstallation.version,
      codexVersion: observations.independentInstallation.codexVersion,
      appRoot: observations.independentInstallation.appRoot,
      runtimeUpdatedAt: observations.independentInstallation.runtimeUpdatedAt,
      revision: observations.independentInstallation.revision,
    },
    mode: observations.mode,
    environment: observations.environment,
    chatgptAppUpdate: observations.chatgptAppUpdate,
    injectedPatch: observations.injectedPatch,
    tweakersPatch: observations.tweakersPatch,
    updater: observations.updater,
    runtime: observations.runtime,
    coordinator: {
      state: observations.coordinator.state,
      activeOperationId: observations.coordinator.activeOperationId,
    },
    operations,
    receiptChronology: observations.receipts.map((receipt) => ({
      source: receipt.entry.source,
      receiptId: receipt.entry.receiptId,
      phase: receipt.entry.phase,
      updatedAt: receipt.entry.updatedAt,
      terminalAt: receipt.entry.terminalAt,
      error: receipt.entry.error,
      state: receipt.entry.state,
      revision: receipt.entry.revision,
      active: receipt.entry.active,
    })),
    // The token binds the executable capability set itself. A status response
    // that cannot execute a family must not advertise that family in a token
    // which could later be replayed against a different manager generation.
    allowedActions,
  };
  return deepFreeze({
    protocolVersion: MANAGER_PROTOCOL_VERSION,
    managerId: TWEAKERS_MANAGER_ID,
    generatedAt: observations.generatedAt,
    stateToken: createManagerStateToken(stateTokenInputs),
    status: {
      schemaVersion: MANAGER_STATUS_SCHEMA_VERSION,
      installation: observations.installation,
      independentInstallation: observations.independentInstallation,
      mode: observations.mode,
      environment: observations.environment,
      chatgptAppUpdate: observations.chatgptAppUpdate,
      injectedPatch: observations.injectedPatch,
      tweakersPatch: observations.tweakersPatch,
      updater: observations.updater,
      runtime: observations.runtime,
      coordinator: observations.coordinator,
      operations,
      receipts: observations.receipts.map((receipt) => receipt.entry),
    },
    actions,
    stateTokenInputs,
  });
}

function defaultReadText(path: string): ManagerStatusTextRead {
  try {
    return { state: "present", text: readFileSync(path, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { state: "missing" };
    return { state: "unreadable", problem: errorMessage(error) };
  }
}

function defaultReadDirectory(path: string): ManagerStatusDirectoryRead {
  try {
    return { state: "present", entries: readdirSync(path).sort((left, right) => left.localeCompare(right)) };
  } catch (error) {
    if (isMissingFileError(error)) return { state: "missing" };
    return { state: "unreadable", problem: errorMessage(error) };
  }
}

function readDocument(path: string, readText: (path: string) => ManagerStatusTextRead): ReadDocument {
  const file = readText(path);
  if (file.state === "missing") return { state: "missing", revision: "missing", value: null, problem: null };
  if (file.state === "unreadable") {
    return { state: "unreadable", revision: "unreadable", value: null, problem: file.problem };
  }
  const revision = sha256(file.text);
  try {
    const value: unknown = JSON.parse(file.text);
    if (!isRecord(value)) return { state: "malformed", revision, value: null, problem: "expected a JSON object" };
    return { state: "valid", revision, value, problem: null };
  } catch (error) {
    return { state: "malformed", revision, value: null, problem: `invalid JSON: ${errorMessage(error)}` };
  }
}

function observeInstallation(document: ReadDocument): ManagerDashboardInstallationV1 {
  if (document.state === "missing") {
    return { state: "not-installed", version: null, codexVersion: null, installedAt: null, appRoot: null, runtimeUpdatedAt: null, revision: document.revision };
  }
  if (document.state !== "valid" || document.value === null) {
    return { state: document.state === "unreadable" ? "unreadable" : "malformed", version: null, codexVersion: null, installedAt: null, appRoot: null, runtimeUpdatedAt: null, revision: document.revision };
  }
  const version = stringValue(document.value.version);
  const codexVersion = document.value.codexVersion === undefined
    ? null
    : nullableStringValue(document.value.codexVersion);
  const installedAt = isoValue(document.value.installedAt);
  const appRoot = stringValue(document.value.appRoot);
  const runtimeUpdatedAt = document.value.runtimeUpdatedAt === undefined
    ? null
    : nullableIsoValue(document.value.runtimeUpdatedAt);
  if (version === null || codexVersion === undefined || installedAt === null || appRoot === null || runtimeUpdatedAt === undefined) {
    return { state: "malformed", version: null, codexVersion: null, installedAt: null, appRoot: null, runtimeUpdatedAt: null, revision: document.revision };
  }
  return { state: "installed", version, codexVersion, installedAt, appRoot, runtimeUpdatedAt, revision: document.revision };
}

function observeMode(installer: ReadDocument, updateMode: ReadDocument, now: string): ManagerDashboardModeV1 {
  const current = installer.state === "valid" && installer.value !== null
    ? installer.value.mode === "chatgpt" || installer.value.mode === "tweakers" ? installer.value.mode : "unknown"
    : "unknown";
  if (updateMode.state === "missing") {
    return { current, updatePause: { state: "inactive", enabledAt: null, codexVersion: null, revision: updateMode.revision } };
  }
  if (updateMode.state !== "valid" || updateMode.value === null) {
    return {
      current,
      updatePause: {
        state: updateMode.state === "unreadable" ? "unreadable" : "malformed",
        enabledAt: null,
        codexVersion: null,
        revision: updateMode.revision,
      },
    };
  }
  const enabledAt = isoValue(updateMode.value.enabledAt);
  const codexVersion = nullableStringValue(updateMode.value.codexVersion);
  if (enabledAt === null || codexVersion === undefined) {
    return { current, updatePause: { state: "malformed", enabledAt: null, codexVersion: null, revision: updateMode.revision } };
  }
  const enabledMs = Date.parse(enabledAt);
  const nowMs = Date.parse(now);
  const fresh = Number.isFinite(enabledMs) && Number.isFinite(nowMs) && nowMs - enabledMs < UPDATE_MODE_MAX_AGE_MS;
  return { current, updatePause: { state: fresh ? "active" : "stale", enabledAt, codexVersion, revision: updateMode.revision } };
}

function observeEnvironment(
  registry: ReadDocument,
  selection: ReadDocument,
  modeCache: ReadDocument,
  registeredStableSource: RegisteredOfficialSourceStatus,
): ManagerDashboardEnvironmentV1 {
  const selectionState = selection.state;
  const selectionValue = selection.value;
  const releaseProfile = selectionValue?.releaseProfile === "stable" || selectionValue?.releaseProfile === "alpha"
    ? selectionValue.releaseProfile
    : null;
  const experience = selectionValue?.appExperience === "chatgpt" || selectionValue?.appExperience === "tweakers"
    ? selectionValue.appExperience
    : null;
  const migrationState = nullableStringValue(selectionValue?.migrationState);
  const selectionMalformed = selectionState === "valid"
    && (releaseProfile === null || experience === null || migrationState === undefined);
  const cache = observeModeCache(modeCache);
  const profile = releaseProfile === null || registry.value === null
    ? null
    : (registry.value.profiles as Record<string, unknown> | undefined)?.[releaseProfile];
  const profileRecord = isRecord(profile) ? profile : null;
  const expectedBundleId = releaseProfile === "alpha" ? "com.openai.codex.beta" : "com.openai.codex";
  const officialPath = profileRecord ? stringValue(profileRecord.officialPath) : null;
  const officialBundleId = profileRecord?.officialBundleId === expectedBundleId ? expectedBundleId : null;
  const officialVersion = profileRecord ? nullableStringValue(profileRecord.officialVersion) : undefined;
  const officialBuild = profileRecord ? nullableStringValue(profileRecord.officialBuild) : undefined;
  const officialValid = registry.state === "valid"
    && releaseProfile !== null
    && officialPath !== null
    && officialBundleId !== null
    && officialVersion !== undefined
    && officialBuild !== undefined
    && profileRecord?.strictSignature === true
    && profileRecord?.gatekeeper === true;
  return {
    selection: {
      state: selectionMalformed ? "malformed" : selectionState,
      releaseProfile: selectionMalformed ? null : releaseProfile,
      experience: selectionMalformed ? null : experience,
      migrationState: selectionMalformed ? null : migrationState ?? null,
      revision: selection.revision,
      problem: selectionMalformed ? "selection is missing v2 environment fields" : selection.problem,
    },
    registry: { state: registry.state, revision: registry.revision, problem: registry.problem },
    officialApp: {
      state: officialValid ? "valid" : registry.state === "valid" ? "malformed" : registry.state,
      appPath: officialValid ? officialPath : null,
      bundleId: officialValid ? officialBundleId : null,
      version: officialValid ? officialVersion ?? null : null,
      build: officialValid ? officialBuild ?? null : null,
      problem: officialValid ? null : registry.problem ?? "registry has no verified official app for the selected profile",
    },
    modeCache: cache,
    registeredStableSource: {
      state: registeredStableSource.state,
      generationId: registeredStableSource.generationId,
      receiptDigest: registeredStableSource.receiptDigest,
      artifactPath: registeredStableSource.artifactPath,
      version: registeredStableSource.version,
      build: registeredStableSource.build,
      candidateDigest: registeredStableSource.candidateDigest,
      sourceDigest: registeredStableSource.sourceDigest,
      revision: registeredStableSource.revision,
      problem: registeredStableSource.problem,
    },
  };
}

function observeModeCache(document: ReadDocument): ManagerDashboardEnvironmentV1["modeCache"] {
  if (document.state === "missing") {
    return { state: "unavailable", generationId: null, pinState: null, revision: document.revision, problem: null };
  }
  if (document.state !== "valid" || document.value === null) {
    return {
      state: document.state === "unreadable" ? "unreadable" : "malformed",
      generationId: null,
      pinState: null,
      revision: document.revision,
      problem: document.problem,
    };
  }
  const generationId = stringValue(document.value.generationId);
  const pin = recordValue(document.value.pin);
  const pinState = stringValue(pin?.state);
  const releasedAt = nullableIsoValue(pin?.releasedAt);
  if (generationId === null || pinState === null || releasedAt === undefined) {
    return { state: "malformed", generationId: null, pinState: null, revision: document.revision, problem: "invalid mode-cache receipt" };
  }
  const state = pinState === "prepared" && releasedAt === null
    ? "ready"
    : pinState === "post_cutover_recovery"
      ? "preparing"
      : "stale";
  return { state, generationId, pinState, revision: document.revision, problem: null };
}

function observeUpdater(document: ReadDocument): ManagerDashboardUpdaterV1 {
  if (document.state === "missing") {
    return { state: "idle", transactionId: null, phase: null, resumable: null, safeOfficialMode: null, error: null, revision: document.revision, problem: null };
  }
  if (document.state !== "valid" || document.value === null) {
    return {
      state: document.state === "unreadable" ? "unreadable" : "malformed",
      transactionId: null,
      phase: null,
      resumable: null,
      safeOfficialMode: null,
      error: null,
      revision: document.revision,
      problem: document.problem,
    };
  }
  const transactionId = stringValue(document.value.transactionId);
  const phase = stringValue(document.value.phase);
  const resumable = booleanValue(document.value.resumable);
  const safeOfficialMode = booleanValue(document.value.safeOfficialMode);
  const updatedAt = isoValue(document.value.updatedAt);
  const error = nullableStringValue(document.value.error);
  if (transactionId === null || phase === null || resumable === null || safeOfficialMode === null || updatedAt === null || error === undefined) {
    return { state: "malformed", transactionId: null, phase: null, resumable: null, safeOfficialMode: null, error: null, revision: document.revision, problem: "invalid desktop-update receipt" };
  }
  const active = isActiveDesktopPhase(phase, resumable, safeOfficialMode, error);
  return {
    state: active ? "active" : "terminal",
    transactionId,
    phase,
    resumable,
    safeOfficialMode,
    error,
    revision: document.revision,
    problem: null,
  };
}

function observeTweakersPatch(
  installation: ManagerDashboardInstallationV1,
  registeredStableSource: RegisteredOfficialSourceStatus,
): ManagerDashboardTweakersPatchV1 {
  // `version` is the Tweakers package release (currently 1.0.0), not the
  // ChatGPT desktop payload used to build Tweakers.app. Compare like with
  // like so a freshly rebuilt app does not remain permanently "out of date".
  const installedVersion = installation.codexVersion ?? installation.version;
  const officialVersion = registeredStableSource.state === "ready"
    ? registeredStableSource.version
    : null;
  if (installation.state !== "installed" || installedVersion === null) {
    return { state: "unknown", installedVersion, officialVersion, problem: "Tweakers installation version is unavailable" };
  }
  if (registeredStableSource.state === "ready" && officialVersion !== null) {
    return {
      state: installedVersion === officialVersion ? "current" : "source-changes-available",
      installedVersion,
      officialVersion,
      problem: null,
    };
  }
  return {
    state: "unknown",
    installedVersion,
    officialVersion,
    problem: registeredStableSource.problem ?? "A manager-registered official source is required",
  };
}

function observeInjectedPatch(
  installation: ManagerDashboardInstallationV1,
  mode: ManagerDashboardModeV1,
  environment: ManagerDashboardEnvironmentV1,
): ManagerDashboardInjectedPatchV1 {
  const source = environment.registeredStableSource;
  const officialVersion = source.state === "ready" ? source.version : environment.officialApp.version;
  const installedVersion = installation.state === "installed"
    ? installation.codexVersion ?? installation.version
    : null;
  const readinessProblem = injectedCandidatePreparationProblem(environment);
  const isProvenCurrent = readinessProblem === null
    && installation.state === "installed"
    && installation.appRoot === "/Applications/ChatGPT.app"
    && installedVersion === source.version
    && mode.current === "tweakers"
    && environment.selection.state === "valid"
    && environment.selection.releaseProfile === "stable"
    && environment.selection.experience === "tweakers"
    && environment.selection.migrationState === "verified";
  const isPreparationSelection = environment.selection.state === "valid"
    && environment.selection.releaseProfile === "stable"
    && environment.selection.experience === "chatgpt"
    && environment.selection.migrationState === "verified";

  if (isProvenCurrent) {
    return {
      state: "current",
      installedVersion,
      officialVersion,
      // Reapplication is deliberately allowed from a proven current state
      // only after it has returned to the fixed official selection. Status
      // does not construct a candidate while displaying this projection.
      candidateReady: false,
      problem: null,
    };
  }
  if (readinessProblem === null && isPreparationSelection) {
    return {
      state: "reinjection-required",
      installedVersion,
      officialVersion,
      candidateReady: true,
      problem: installedVersion === null
        ? "pristine stable ChatGPT has no injected state; a receipt-bound initial injection can be prepared"
        : "stable ChatGPT requires a receipt-bound reinjection candidate",
    };
  }
  return {
    state: readinessProblem === null ? "reinjection-required" : "unknown",
    installedVersion,
    officialVersion,
    candidateReady: false,
    problem: readinessProblem ?? "the fixed stable ChatGPT selection is not ready for injection",
  };
}

/**
 * This is a status-only availability predicate. The executor reacquires the
 * immutable source lease and fully seals its tree before candidate bytes are
 * used; a dashboard projection is never source authority.
 */
function injectedCandidatePreparationProblem(environment: ManagerDashboardEnvironmentV1): string | null {
  const selection = environment.selection;
  if (selection.state !== "valid"
    || selection.releaseProfile !== "stable"
    || (selection.experience !== "chatgpt" && selection.experience !== "tweakers")
    || selection.migrationState !== "verified") {
    return "the stable environment selection is not a verified ChatGPT/Tweakers projection";
  }
  const official = environment.officialApp;
  if (official.state !== "valid"
    || official.appPath !== "/Applications/ChatGPT.app"
    || official.bundleId !== "com.openai.codex"
    || official.version === null
    || official.build === null) {
    return "the fixed stable ChatGPT app is not strictly verified";
  }
  const source = environment.registeredStableSource;
  if (source.state !== "ready"
    || source.generationId === null
    || source.receiptDigest === null
    || source.sourceDigest === null
    || source.version === null
    || source.build === null
    || !isLowerUuid(source.generationId)
    || !isLowerSha256(source.receiptDigest)
    || !isLowerSha256(source.sourceDigest)
    || !isSha256Revision(source.revision)) {
    return source.problem ?? "a complete manager-registered stable ChatGPT source is required";
  }
  if (source.version !== official.version || source.build !== official.build) {
    return "the registered stable source version/build no longer matches verified ChatGPT";
  }
  return null;
}

function observeRuntime(document: ReadDocument): ManagerDashboardRuntimeV1 {
  if (document.state !== "valid" || document.value === null) {
    return {
      state: document.state,
      provenanceKind: null,
      installedAt: null,
      sourceRuntimeHash: null,
      revision: document.revision,
      problem: document.problem,
    };
  }
  const kind = nullableStringValue(document.value.kind);
  const installedAt = nullableIsoValue(document.value.installedAt);
  const sourceRuntimeHash = nullableStringValue(document.value.sourceRuntimeHash);
  if (kind === undefined || installedAt === undefined || sourceRuntimeHash === undefined) {
    return { state: "malformed", provenanceKind: null, installedAt: null, sourceRuntimeHash: null, revision: document.revision, problem: "invalid runtime provenance" };
  }
  return { state: "valid", provenanceKind: kind, installedAt, sourceRuntimeHash, revision: document.revision, problem: null };
}

function observeEnvironmentReceipt(document: ReadDocument): ParsedReceipt {
  return observeReceipt(document, "environment", (value) => {
    if (value.schemaVersion !== 1 || value.kind !== "environment") return null;
    const receiptId = stringValue(value.transactionId);
    const phase = stringValue(value.phase);
    const createdAt = isoValue(value.createdAt);
    const updatedAt = isoValue(value.updatedAt);
    const error = nullableStringValue(value.error);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || error === undefined) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: nullableIsoValue(value.committedAt) ?? nullableIsoValue(value.rolledBackAt) ?? nullableIsoValue(value.cancelledAt) ?? null,
      error,
      active: !["committed", "rolled-back", "failed", "cancelled"].includes(phase),
    };
  });
}

function observeDesktopUpdateReceipt(
  document: ReadDocument,
  source: "desktop-update" | "chatgpt-app-update" = "desktop-update",
): ParsedReceipt {
  return observeReceipt(document, source, (value) => {
    if (value.schemaVersion !== 1 || value.kind !== "desktop-update") return null;
    const receiptId = stringValue(value.transactionId);
    const phase = stringValue(value.phase);
    const createdAt = isoValue(value.createdAt);
    const updatedAt = isoValue(value.updatedAt);
    const resumable = booleanValue(value.resumable);
    const safeOfficialMode = booleanValue(value.safeOfficialMode);
    const error = nullableStringValue(value.error);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || resumable === null || safeOfficialMode === null || error === undefined) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: nullableIsoValue(value.terminalAt) ?? nullableIsoValue(value.completedAt) ?? nullableIsoValue(value.rolledBackAt) ?? null,
      error,
      active: isActiveDesktopPhase(phase, resumable, safeOfficialMode, error),
    };
  });
}

function observeModeCacheReceipt(document: ReadDocument): ParsedReceipt {
  return observeReceipt(document, "environment-mode-cache", (value) => {
    if (value.schemaVersion !== 2 || value.kind !== "environment-mode-pair") return null;
    const receiptId = stringValue(value.generationId);
    const pin = recordValue(value.pin);
    const timestamps = recordValue(value.timestamps);
    const phase = stringValue(pin?.state);
    const createdAt = isoValue(timestamps?.preparedAt);
    const updatedAt = isoValue(timestamps?.validatedAt);
    const releasedAt = nullableIsoValue(pin?.releasedAt);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || releasedAt === undefined) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: releasedAt,
      error: null,
      active: ["prepared", "post_cutover_recovery"].includes(phase) && releasedAt === null,
    };
  });
}

function observeOfficialSourceRegistrationReceipt(document: ReadDocument): ParsedReceipt {
  return observeReceipt(document, "official-source", (value) => {
    if (value.schemaVersion !== 1 || value.kind !== "tweakers-stable-official-source-registration") return null;
    const receiptId = stringValue(value.operationId);
    const phase = stringValue(value.phase);
    const createdAt = isoValue(value.createdAt);
    const updatedAt = isoValue(value.updatedAt);
    const error = nullableStringValue(value.error);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || error === undefined) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: phase === "completed" || phase === "failed" || phase === "recovery-required" ? updatedAt : null,
      error,
      active: phase === "preparing" || phase === "published",
    };
  });
}

function observeCodexDerivedReceipts(
  root: string,
  readText: (path: string) => ManagerStatusTextRead,
  readDirectory: (path: string) => ManagerStatusDirectoryRead,
): ParsedReceipt[] {
  const directory = readDirectory(root);
  if (directory.state === "missing") return [];
  if (directory.state === "unreadable") {
    return [{
      entry: malformedReceipt("codex-derived", "unreadable", directory.problem),
      activeOperationId: null,
    }];
  }
  const names = directory.entries.filter((name) => name.endsWith(".json")).slice(0, MAX_CODEX_DERIVED_RECEIPTS);
  const receipts = names.map((name) => {
    const document = readDocument(join(root, name), readText);
    return observeReceipt(document, "codex-derived", (value) => {
      if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.kind !== "codex-derived") return null;
      const receiptId = stringValue(value.transactionId);
      const phase = stringValue(value.phase);
      const createdAt = isoValue(value.createdAt);
      const updatedAt = isoValue(value.updatedAt);
      const error = nullableStringValue(value.error);
      if (receiptId === null || phase === null || createdAt === null || updatedAt === null || error === undefined) return null;
      return {
        receiptId,
        phase,
        createdAt,
        updatedAt,
        terminalAt: nullableIsoValue(value.soakCompletedAt) ?? nullableIsoValue(value.rolledBackAt) ?? null,
        error,
        active: !["completed", "rolled-back", "failed", "superseded"].includes(phase),
      };
    });
  });
  if (directory.entries.filter((name) => name.endsWith(".json")).length > MAX_CODEX_DERIVED_RECEIPTS) {
    receipts.push({
      entry: malformedReceipt("codex-derived", "malformed", `too many codex-derived receipts (maximum ${MAX_CODEX_DERIVED_RECEIPTS})`),
      activeOperationId: null,
    });
  }
  return receipts;
}

/**
 * Manager-operation records are observed directly instead of through the
 * mutating store API. This keeps status side-effect-free even when the root
 * does not exist or contains a hostile/malformed file. An empty directory is
 * normalized to the same token projection as an absent directory so the
 * operation being prepared can be excluded during execute-time validation.
 */
function observeManagerOperations(
  managerRoot: string,
  root: string,
  readText: (path: string) => ManagerStatusTextRead,
  readDirectory: (path: string) => ManagerStatusDirectoryRead,
  receipts: readonly ParsedReceipt[],
  chatgptAppUpdate: ManagerDashboardUpdaterV1,
  legacyUpdater: ManagerDashboardUpdaterV1,
  excludeOperationId: string | undefined,
): ManagerDashboardOperationsV1 {
  const directory = readDirectory(root);
  if (directory.state === "missing") {
    return { state: "missing", revision: "missing", activeOperationId: null, preparedCount: 0, detail: null, problem: null };
  }
  if (directory.state === "unreadable") {
    return { state: "unreadable", revision: "unreadable", activeOperationId: null, preparedCount: 0, detail: null, problem: directory.problem };
  }

  const names = directory.entries.filter((name) => name.endsWith(".json")).sort((left, right) => left.localeCompare(right));
  if (names.length > 64) {
    return {
      state: "malformed",
      revision: `sha256:${createHash("sha256").update(names.join("\n"), "utf8").digest("hex")}`,
      activeOperationId: null,
      preparedCount: 0,
      detail: null,
      problem: "too many manager operation records (maximum 64)",
    };
  }

  const observed: Array<ManagerOperationDetailV1 & { revision: string; settledByDurableEvidence: boolean }> = [];
  for (const name of names) {
    const operationId = name.slice(0, -".json".length);
    if (!isManagerOperationId(operationId)) {
      return {
        state: "malformed",
        revision: `sha256:${createHash("sha256").update(names.join("\n"), "utf8").digest("hex")}`,
        activeOperationId: null,
        preparedCount: 0,
        detail: null,
        problem: `manager operation filename is invalid: ${name}`,
      };
    }
    if (excludeOperationId === operationId) continue;
    const document = readText(join(root, name));
    if (document.state === "missing") {
      return { state: "malformed", revision: "missing-record", activeOperationId: null, preparedCount: 0, detail: null, problem: `manager operation disappeared: ${operationId}` };
    }
    if (document.state === "unreadable") {
      return { state: "unreadable", revision: "unreadable-record", activeOperationId: null, preparedCount: 0, detail: null, problem: document.problem };
    }
    const revision = sha256(document.text);
    try {
      const record = parsePreparedOperation(
        parseManagerStrictJsonObject(document.text, { maxBytes: 64 * 1024, label: `manager operation ${operationId}` }),
        operationId,
      );
      // A crash after the fsynced consumed barrier but before the manager can
      // write its own terminal record must not permanently prevent recovery.
      // The durable receipt is the only authority that can reconcile that
      // projection.  We deliberately leave the raw operation record unchanged:
      // it is never reopened to `prepared`, and a missing, malformed, stale, or
      // mismatched receipt stays closed. A failed `desktop-update.start` may
      // release only to the exact newly-created official-update receipt so the
      // separately prepared resume/cancel action can settle it.
      const settledByDurableEvidence = independentRefreshHasProvenRetryableFailure(
        record,
        managerRoot,
        readText,
        readDirectory,
      )
        || operationReachedBoundReceipt(record, receipts, chatgptAppUpdate, legacyUpdater);
      observed.push({
        operationId,
        actionId: record.actionId,
        phase: record.phase,
        timing: record.timing ?? null,
        revision,
        settledByDurableEvidence,
      });
    } catch (error) {
      return { state: "malformed", revision, activeOperationId: null, preparedCount: 0, detail: null, problem: errorMessage(error) };
    }
  }

  if (observed.length === 0) {
    return { state: "missing", revision: "missing", activeOperationId: null, preparedCount: 0, detail: null, problem: null };
  }
  const active = observed.filter((record) => (
    record.phase === "prepared"
    || (record.phase === "consumed" && !record.settledByDurableEvidence)
    || (record.phase === "recovery-required" && !record.settledByDurableEvidence)
  ));
  const revision = `sha256:${createHash("sha256").update(canonicalManagerJson(observed), "utf8").digest("hex")}`;
  if (active.length > 1) {
    return {
      state: "malformed",
      revision,
      activeOperationId: null,
      preparedCount: active.length,
      detail: null,
      problem: `multiple active manager operations: ${active.map((record) => record.operationId).join(", ")}`,
    };
  }
  return {
    state: "valid",
    revision,
    activeOperationId: active[0]?.operationId ?? null,
    preparedCount: active.length,
    detail: active[0] === undefined
      ? null
      : {
        operationId: active[0].operationId,
        actionId: active[0].actionId,
        phase: active[0].phase,
        timing: active[0].timing,
      },
    problem: null,
  };
}

/**
 * These conflicts are emitted either before the refresh writer is called or
 * while staging runtime assets before VariantPromotion exists. The fsynced
 * manager record's exact diagnostic is therefore evidence that installed app
 * bytes were not touched. Releasing the projection permits a fresh separately
 * prepared retry; it never re-executes the consumed operation and never hides
 * post-promotion or ambiguous failures.
 */
function independentRefreshHasProvenRetryableFailure(
  record: ReturnType<typeof parsePreparedOperation>,
  managerRoot: string,
  readText: (path: string) => ManagerStatusTextRead,
  readDirectory: (path: string) => ManagerStatusDirectoryRead,
): boolean {
  if (record.phase !== "recovery-required"
    || record.actionId !== "refresh.independent"
    || record.consumedAt === null
    || record.receiptRefs.length !== 1
    || !record.receiptRefs[0]?.startsWith("independent-tweakers-patch:")
    || record.error === null) return false;
  if (isCandidateCopyPrecutoverFailure(record)) return true;
  // The exact recovery preflight rejection occurs before candidate staging or
  // cutover. Preserve the raw failure, but do not treat it as unfinished recovery.
  if (record.error.startsWith("Independent Tweakers refresh requires a source-bound validated Accounts recovery receipt in the sealed runtime.")) {
    return !!record.timing && MANAGER_REFRESH_TIMING_PHASES_V1.every(key => {
      const phase = record.timing!.phases[key];
      return phase.state === "skipped" && phase.startedAt === null && phase.completedAt === null;
    });
  }
  if (record.error === "Independent Tweakers refresh failed and the rollback/reopen path was incomplete.") {
    return recoveredIndependentPromotionSetIsTerminal(record.operationId, managerRoot, readText, readDirectory);
  }
  return record.error === "The exact /Applications/Tweakers.app process did not quiesce before refresh."
    || /^Exact captured Tweakers helpers did not stop: [0-9]+(?:, [0-9]+)*$/.test(record.error)
    || /^Exact Tweakers helper quiescence is not proven: [0-9]+(?:, [0-9]+)*$/.test(record.error)
    || /^loader\.cjs not found at \/.+\/managers\/com\.thomashulihan\.tweakers\/assets\/loader\.cjs or \/.+\/loader\/loader\.cjs$/.test(record.error)
    || /^Tweakers Manager Launcher asset is missing: \/.+\/managers\/com\.thomashulihan\.tweakers\/generations\/assets\/manager-launcher\/Tweakers Manager Launcher$/.test(record.error)
    // This exact bootstrap mismatch is thrown after promotion only when the
    // create-variant compensating rollback completed.  An incomplete rollback
    // is wrapped in AggregateError and recorded with a different outer error,
    // so the diagnostic is sufficient durable evidence for a fresh approval.
    || /^Canonical manager official ChatGPT officialBackend(?:Version|Fingerprint) does not match the revalidated app$/.test(record.error)
    // Both runtime-ready timeout diagnostics are thrown only before commit.
    // The sealed executor records them only after it has quiesced the failed
    // candidate and completed the deferred transaction's rollback; an
    // incomplete rollback is wrapped in AggregateError with a different outer
    // diagnostic and remains blocking.
    || record.error === "The exact /Applications/Tweakers.app reopen did not produce a new visible main PID with an operation-bound runtime-ready receipt."
    || record.error === "The exact /Applications/Tweakers.app reopen produced a new visible main PID, but did not publish an operation-bound runtime-ready receipt before the readiness deadline."
    || record.error === "The exact /Applications/Tweakers.app reopen did not produce a new visible main PID before the process deadline."
    || record.error === "The exact /Applications/Tweakers.app reopen did not produce a new main PID before the process deadline."
    || /^Runtime assets not found\. Expected at \/.+\/managers\/com\.thomashulihan\.tweakers\/assets\/runtime \(built package\) or \/.+\/runtime\/dist \(dev\)\.\nRun `npm run build` from the workspace root\.$/.test(record.error);
}

/**
 * A generic rollback-incomplete diagnostic remains blocking until the exact
 * variant journals prove that recovery subsequently finished. Status never
 * performs that recovery: it only observes owner-private journals. Requiring
 * every journal to be terminal prevents an unrelated historical recovery from
 * hiding the still-interrupted generation that produced this manager record.
 */
function recoveredIndependentPromotionSetIsTerminal(
  operationId: string,
  managerRoot: string,
  readText: (path: string) => ManagerStatusTextRead,
  readDirectory: (path: string) => ManagerStatusDirectoryRead,
): boolean {
  const variantRoot = join(managerRoot, "variants", "tweakers");
  for (const evidence of ["runtime-ready-expectation.json", "runtime-ready.json"]) {
    const document = readText(join(variantRoot, evidence));
    if (document.state === "missing") continue;
    if (document.state !== "present") return false;
    let ready: Record<string, unknown>;
    try {
      ready = parseManagerStrictJsonObject(document.text, {
        maxBytes: 64 * 1024,
        label: `independent ${evidence}`,
      });
    } catch {
      return false;
    }
    // A later refresh is allowed to retain its own readiness receipt. Only
    // readiness evidence for this failed operation keeps its recovery open.
    if (ready.operationId === operationId) return false;
  }
  const journalRoot = join(variantRoot, "transactions", "variant-promotion");
  const directory = readDirectory(journalRoot);
  if (directory.state !== "present") return false;
  const names = directory.entries.filter((name) => name.endsWith(".json") && name !== "active.json");
  if (names.length === 0 || names.length > 128) return false;
  let recovered = false;
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    if (!isManagerOperationId(id)) return false;
    const document = readText(join(journalRoot, name));
    if (document.state !== "present") return false;
    let journal: Record<string, unknown>;
    try {
      journal = parseManagerStrictJsonObject(document.text, {
        maxBytes: 64 * 1024,
        label: `variant promotion journal ${id}`,
      });
    } catch {
      return false;
    }
    if (journal.id !== id
      || journal.userRoot !== variantRoot
      || journal.target !== "/Applications/Tweakers.app"
      || (journal.phase !== "committed" && journal.phase !== "recovered")) return false;
    if (journal.phase === "recovered") recovered = true;
  }
  return recovered;
}

/**
 * Reconciliation is intentionally a read-only status projection.  It only
 * closes a consumed manager record when the *same bound receipt* now contains
 * an action-specific durable terminal proof.  It never mutates the operation
 * record and, in particular, never turns `consumed` back into `prepared`.
 */
function operationReachedBoundReceipt(
  record: ReturnType<typeof parsePreparedOperation>,
  receipts: readonly ParsedReceipt[],
  chatgptAppUpdate: ManagerDashboardUpdaterV1,
  legacyUpdater: ManagerDashboardUpdaterV1,
): boolean {
  if (startRecordReachedNewOfficialUpdateReceipt(record, receipts, chatgptAppUpdate)) return true;
  if (record.actionId === "refresh.injected") {
    return injectedRefreshReachedBoundEnvironmentReceipt(record, receipts);
  }
  if (record.phase !== "consumed" || record.consumedAt === null || record.receiptRefs.length !== 1) return false;

  const target = parseBoundReceiptReference(record.receiptRefs[0]);
  if (target === null) return false;
  const expectedSource = record.actionId.startsWith("environment.")
    ? "environment"
    : record.actionId.startsWith("desktop-update.")
      ? target.source === "chatgpt-app-update" || target.source === "desktop-update"
        ? target.source
        : null
      : null;
  if (expectedSource === null || target.source !== expectedSource) return false;

  // The manager generated this snapshot during prepare.  Requiring it here
  // prevents a malformed/corrupted record from using an unrelated terminal
  // receipt to clear a consumed barrier.
  if (!record.receiptSnapshot.some((receipt) => (
    receipt.source === target.source
    && receipt.receiptId === target.receiptId
    && receipt.active
  ))) return false;

  const current = receipts.find((receipt) => receipt.entry.source === target.source)?.entry;
  if (current?.state !== "valid" || current.receiptId !== target.receiptId) return false;

  if (record.actionId === "environment.cancel") {
    return !current.active && (current.phase === "cancelled" || current.phase === "rolled-back");
  }
  if (record.actionId === "environment.recover") {
    return !current.active && (current.phase === "cancelled" || current.phase === "rolled-back" || current.phase === "committed");
  }
  if (record.actionId === "desktop-update.resume" || record.actionId === "desktop-update.cancel") {
    const updater = target.source === "chatgpt-app-update" ? chatgptAppUpdate : legacyUpdater;
    return current.active === false
      && (current.phase === "completed" || current.phase === "rolled_back" || current.phase === "failed")
      && updater.state === "terminal"
      && updater.transactionId === target.receiptId
      && updater.resumable === false
      && updater.safeOfficialMode === true;
  }
  return false;
}

/**
 * Initial injection cannot have an environment receipt at prepare time, but
 * its manager operation ID is already the receipt ID. Status may therefore
 * observe exactly that future receipt after a crash without reopening the
 * consumed operation or treating an unrelated terminal receipt as recovery.
 */
function injectedRefreshReachedBoundEnvironmentReceipt(
  record: ReturnType<typeof parsePreparedOperation>,
  receipts: readonly ParsedReceipt[],
): boolean {
  if ((record.phase !== "consumed" && record.phase !== "recovery-required")
    || record.consumedAt === null
    || record.receiptRefs.length !== 2) return false;
  const binding = parseInjectedRefreshBindingReference(record.receiptRefs[0]);
  const environment = parseBoundReceiptReference(record.receiptRefs[1]);
  if (binding === null
    || environment === null
    || environment.source !== "environment"
    || environment.receiptId !== record.operationId) return false;
  const current = receipts.find((receipt) => receipt.entry.source === "environment")?.entry;
  if (current?.state !== "valid"
    || current.receiptId !== record.operationId
    || current.createdAt === null
    || Date.parse(current.createdAt) < Date.parse(record.consumedAt)) return false;
  if (current.phase === "committed" || current.phase === "rolled-back" || current.phase === "cancelled") {
    return current.active === false;
  }
  // A failed receipt is terminal only when it did not report rollback failure.
  // The latter means byte restoration is incomplete and must remain blocking.
  return current.phase === "failed"
    && current.active === false
    && !/\brollback failed\b/i.test(current.error ?? "");
}

function startRecordReachedNewOfficialUpdateReceipt(
  record: ReturnType<typeof parsePreparedOperation>,
  receipts: readonly ParsedReceipt[],
  updater: ManagerDashboardUpdaterV1,
): boolean {
  if ((record.phase !== "consumed" && record.phase !== "recovery-required")
    || record.actionId !== "desktop-update.start"
    || record.consumedAt === null
    || record.receiptRefs.length !== 1
    || record.receiptRefs[0] !== "chatgpt-app-update:new") return false;

  const before = record.receiptSnapshot.find((receipt) => receipt.source === "chatgpt-app-update");
  const current = receipts.find((receipt) => receipt.entry.source === "chatgpt-app-update")?.entry;
  if (before === undefined
    || before.active
    || current?.state !== "valid"
    || current.receiptId === null
    || current.createdAt === null
    || before.receiptId === current.receiptId
    || Date.parse(current.createdAt) < Date.parse(record.consumedAt)) return false;

  return (updater.state === "active" || updater.state === "terminal")
    && updater.transactionId === current.receiptId
    && updater.phase === current.phase;
}

function parseBoundReceiptReference(value: string | undefined): { source: "environment" | "chatgpt-app-update" | "desktop-update"; receiptId: string } | null {
  const match = /^(environment|chatgpt-app-update|desktop-update):(.+)$/.exec(value ?? "");
  if (match === null || match[2] === "") return null;
  return { source: match[1] as "environment" | "chatgpt-app-update" | "desktop-update", receiptId: match[2] };
}

function parseInjectedRefreshBindingReference(value: string | undefined): {
  generationId: string;
  receiptDigest: string;
  sourceDigest: string;
  sourceRevision: string;
  managerRuntimeFingerprint: string;
  selectionRevision: string;
  registryRevision: string;
} | null {
  const match = /^injected-chatgpt-patch:v1:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([a-f0-9]{64}):([a-f0-9]{64}):(sha256:[a-f0-9]{64}):([a-f0-9]{64}):(sha256:[a-f0-9]{64}):(sha256:[a-f0-9]{64})$/.exec(value ?? "");
  if (match === null) return null;
  return {
    generationId: match[1]!,
    receiptDigest: match[2]!,
    sourceDigest: match[3]!,
    sourceRevision: match[4]!,
    managerRuntimeFingerprint: match[5]!,
    selectionRevision: match[6]!,
    registryRevision: match[7]!,
  };
}

function observeReceipt(
  document: ReadDocument,
  source: ManagerReceiptSourceV1,
  parse: (value: Record<string, unknown>) => {
    receiptId: string;
    phase: string;
    createdAt: string;
    updatedAt: string;
    terminalAt: string | null;
    error: string | null;
    active: boolean;
  } | null,
): ParsedReceipt {
  if (document.state === "missing") {
    return { entry: { source, receiptId: null, phase: null, createdAt: null, updatedAt: null, terminalAt: null, error: null, state: "missing", revision: document.revision, active: false, problem: null }, activeOperationId: null };
  }
  if (document.state !== "valid" || document.value === null) {
    return {
      entry: malformedReceipt(
        source,
        document.state === "unreadable" ? "unreadable" : "malformed",
        document.problem,
        document.revision,
      ),
      activeOperationId: null,
    };
  }
  const parsed = parse(document.value);
  if (parsed === null) {
    return {
      entry: malformedReceipt(
        source,
        "malformed",
        "receipt is missing required v1 chronology fields",
        document.revision,
      ),
      activeOperationId: null,
    };
  }
  return {
    entry: {
      source,
      receiptId: parsed.receiptId,
      phase: parsed.phase,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      terminalAt: parsed.terminalAt,
      error: parsed.error,
      state: "valid",
      revision: document.revision,
      active: parsed.active,
      problem: null,
    },
    activeOperationId: parsed.active ? parsed.receiptId : null,
  };
}

function malformedReceipt(
  source: ManagerReceiptSourceV1,
  state: Exclude<ManagerDocumentStateV1, "missing" | "valid">,
  problem: string | null,
  revision: string = state,
): ManagerReceiptChronologyEntryV1 {
  return { source, receiptId: null, phase: null, createdAt: null, updatedAt: null, terminalAt: null, error: null, state, revision, active: false, problem };
}

function observeCoordinator(
  receipts: readonly ParsedReceipt[],
  lifecycleLock: ManagerStatusTextRead,
): ManagerDashboardCoordinatorV1 {
  const activeIds = receipts
    .map((receipt) => receipt.activeOperationId)
    .filter((receiptId): receiptId is string => receiptId !== null);
  const lifecycleLockState = lifecycleLock.state === "missing"
    ? "absent"
    : lifecycleLock.state === "present"
      ? "present"
      : "unreadable";
  if (activeIds.length > 1) {
    return { state: "conflicted", activeOperationId: null, lifecycleLock: lifecycleLockState, problem: `multiple active receipts: ${activeIds.join(", ")}` };
  }
  if (activeIds.length === 1) {
    return { state: "active", activeOperationId: activeIds[0], lifecycleLock: lifecycleLockState, problem: null };
  }
  if (lifecycleLock.state === "unreadable") {
    return { state: "unknown", activeOperationId: null, lifecycleLock: lifecycleLockState, problem: lifecycleLock.problem };
  }
  return { state: "idle", activeOperationId: null, lifecycleLock: lifecycleLockState, problem: null };
}

function actionAvailability(
  receipts: readonly ParsedReceipt[],
  injectedPatch: ManagerDashboardInjectedPatchV1,
  tweakersPatch: ManagerDashboardTweakersPatchV1,
  dashboardEnvironment: ManagerDashboardEnvironmentV1,
  installation: ManagerDashboardInstallationV1,
  independentInstallation: ManagerDashboardInstallationV1,
  operations: ManagerDashboardOperationsV1,
  enabledActionIds: readonly TweakersManagerActionIdV1[],
): readonly ManagerActionAvailabilityV1[] {
  const enabled = new Set(enabledActionIds);
  const unavailableWithoutExecutor = (actionId: TweakersManagerActionIdV1): ManagerActionAvailabilityV1 => ({
    actionId,
    available: false,
    reason: `${actionId} has no manager-safe executor in this sealed runtime`,
  });
  if (enabled.size === 0) return TWEAKERS_MANAGER_ACTION_IDS_V1.map(unavailableWithoutExecutor);
  if (operations.state === "malformed" || operations.state === "unreadable") {
    return TWEAKERS_MANAGER_ACTION_IDS_V1.map((actionId) => ({
      actionId,
      available: false,
      reason: `manager operation state is unsafe: ${operations.problem ?? operations.state}`,
    }));
  }
  if (operations.activeOperationId !== null) {
    return TWEAKERS_MANAGER_ACTION_IDS_V1.map((actionId) => ({
      actionId,
      available: false,
      reason: `manager operation ${operations.activeOperationId} is already ${operations.preparedCount === 1 ? "pending" : "active"}`,
    }));
  }

  const environment = receipts.find((receipt) => receipt.entry.source === "environment")?.entry;
  const activeDetail = receipts.filter((receipt) => receipt.entry.active)
    .map((receipt) => `${receipt.entry.source}:${receipt.entry.receiptId}`)
    .join(", ") || "no active receipt";
  const unavailable = (actionId: TweakersManagerActionIdV1, reason: string): ManagerActionAvailabilityV1 => ({
    actionId,
    available: false,
    reason,
  });
  const environmentCanCancel = environment?.state === "valid"
    && environment.active
    && environment.receiptId !== null
    && environment.phase === "prepared";
  const environmentCanRecover = environment?.state === "valid"
    && environment.receiptId !== null
    && (environment.active || (environment.phase === "failed" && /\brollback failed\b/i.test(environment.error ?? "")));
  const environmentActive = environment?.state === "valid" && environment.active && environment.receiptId !== null;
  const registeredSource = dashboardEnvironment.registeredStableSource;
  const normalStableChatgpt = dashboardEnvironment.selection.state === "valid"
    && dashboardEnvironment.selection.releaseProfile === "stable"
    && dashboardEnvironment.selection.experience === "chatgpt"
    && dashboardEnvironment.selection.migrationState === "verified";
  const canRegisterOfficialSource = normalStableChatgpt
    && registeredSource.candidateDigest !== null
    && (registeredSource.state === "missing" || registeredSource.state === "stale");
  const availability: ManagerActionAvailabilityV1[] = [
    environmentCanCancel
      ? { actionId: "environment.cancel", available: true, reason: "cancel the exact prepared environment receipt" }
      : unavailable("environment.cancel", `no cancellable prepared environment receipt (${activeDetail})`),
    environmentCanRecover
      ? { actionId: "environment.recover", available: true, reason: "recover the exact blocking environment receipt" }
      : unavailable("environment.recover", `no recoverable environment receipt (${activeDetail})`),
    unavailable("environment.switch", "environment switching is not yet migrated to the manager adapter"),
    unavailable("repair.run", "repair requires a dedicated durable recovery receipt before manager migration"),
    unavailable("self-update.run", "self-update requires a dedicated durable recovery receipt before manager migration"),
    injectedPatch.candidateReady && !environmentActive
      ? {
        actionId: "refresh.injected",
        available: true,
        reason: "prepare one receipt-bound injection from the sealed stable ChatGPT source",
      }
      : unavailable("refresh.injected", environmentActive
        ? `an environment receipt is already active (${activeDetail})`
        : injectedPatch.problem ?? "injected ChatGPT has no manager-verified receipt-bound candidate ready to consume"),
    !environmentActive
      && registeredSource.state === "ready"
      && registeredSource.generationId !== null
      && registeredSource.receiptDigest !== null
      && (tweakersPatch.state === "source-changes-available" || tweakersPatch.state === "current")
      && independentInstallation.state === "installed"
      && independentInstallation.appRoot === "/Applications/Tweakers.app"
      ? {
        actionId: "refresh.independent",
        available: true,
        reason: tweakersPatch.state === "current"
          ? "reapply Tweakers from the verified official app without updating ChatGPT"
          : "rebuild only the independent Tweakers app from verified official source",
      }
      : unavailable("refresh.independent", environmentActive
        ? `an environment receipt is already active (${activeDetail})`
        : "the independent Tweakers app has no verified official source to reapply"),
    !environmentActive && canRegisterOfficialSource
      ? {
        actionId: "official-source.register",
        available: true,
        reason: "seal the exact current stable ChatGPT app for independent Tweakers only",
      }
      : unavailable("official-source.register", environmentActive
        ? `an environment receipt is already active (${activeDetail})`
        : registeredSource.state === "ready"
        ? "the exact current stable ChatGPT app is already sealed by the manager"
        : registeredSource.problem ?? "normal verified ChatGPT mode and a strict current-source proof are required"),
    unavailable("app.restart-runtime-proof", "restart has no dedicated durable receipt and remains unavailable"),
  ];
  return availability.map((action) => enabled.has(action.actionId) ? action : unavailableWithoutExecutor(action.actionId));
}

function compiledEnabledActionIds(
  requested: readonly TweakersManagerActionIdV1[] | undefined,
): readonly TweakersManagerActionIdV1[] {
  if (requested === undefined || requested.length === 0) return [];
  const enabled = new Set(requested);
  // Canonical compiled order protects deterministic state tokens and rejects
  // any accidental non-contract capability supplied by a caller.
  return TWEAKERS_MANAGER_ACTION_IDS_V1.filter((actionId) => enabled.has(actionId));
}

function isActiveDesktopPhase(phase: string, resumable: boolean, safeOfficialMode: boolean, error: string | null): boolean {
  if (!["completed", "failed", "rolled_back"].includes(phase)) return true;
  if (resumable) return true;
  return phase === "failed" && (!safeOfficialMode || /\brollback failed\b/i.test(error ?? ""));
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function isLowerSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isLowerUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}

function isSha256Revision(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function assertRfc3339(value: string, label: string): string {
  if (!RFC3339_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must return an RFC3339 timestamp`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Undefined means invalid; null is a valid explicitly absent source field. */
function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isoValue(value: unknown): string | null {
  return typeof value === "string" && RFC3339_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Undefined means invalid; null is a valid explicitly absent timestamp. */
function nullableIsoValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return isoValue(value) ?? undefined;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

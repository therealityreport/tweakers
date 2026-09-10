/**
 * Private, one-shot coordinator for the final native-history activation.
 *
 * This is deliberately outside the public manager action protocol.  It has
 * one fixed manager argv route, one operation-bound private context, and no
 * caller-selected apps, executables, roots, shell text, or migration input.
 * Existing native history stays in its original account homes; the only new
 * data is the signed broker registration published by `setupNativeHistory`.
 */
import { spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  observeCodexMainProcess,
  openAndActivateCodex,
  quitCodexMainProcess,
  type CodexMainProcessObservation,
} from "./alerts.js";
import {
  readIndependentTweakersBrokerAuthorityExpectation,
  routerControlSocketPath,
} from "./account-router-status.js";
import { canonicalJson } from "./account-history-adoption.js";
import {
  prepareDeferredTweakersVariantRefresh,
  readIndependentTweakersRuntimeReadyReceipt,
  VariantPrePromotionAbortedError,
  type DeferredTweakersVariantRefresh,
} from "./commands/create-variant.js";
import { getOpenReport, listProcesses, type ProcessInfo, type OpenReport } from "./commands/debug.js";
import {
  InstallerEnvironmentCoordinator,
  readEnvironmentTransactionReceipt,
  type EnvironmentCoordinator,
  type EnvironmentTransactionReceipt,
  type PreparedEnvironmentEvidence,
} from "./environment-transaction.js";
import {
  createRequestedEnvironmentSelection,
  fingerprintAppContents,
  readEnvironmentProfileRegistry,
  readEnvironmentSelection,
} from "./environment-profile.js";
import { managerStatusPaths } from "./manager-status.js";
import {
  parseTweakersManagerTargetSeal,
  canonicalTweakersManagerRoot,
  resolveSealedTweakersManagerUserRoot,
} from "./manager-descriptor.js";
import { resolveManagerExecutableIdentity } from "./manager-launcher-identity.js";
import {
  resolveSealedManagerManagedRuntimeAssets,
  resolveSealedManagerRuntimeAssets,
  verifySealedManagerManagedRuntimeAssets,
  verifySealedManagerRuntimeAssets,
} from "./manager-runtime-assets.js";
import {
  acquireRegisteredOfficialSourceLease,
  readRegisteredOfficialSource,
} from "./official-source-registration.js";
import {
  nativeHistorySetupIdle,
  setupNativeHistory,
  type NativeHistorySetupInput,
} from "./native-history-setup.js";
import { targetUserHome } from "./ownership.js";
import { locateCodexAtExactPath } from "./platform.js";
import { preflightCanonicalHistoryStore } from "./shared-history-migration.js";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";

export const NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION = 1 as const;
import { portableDesktopLayout, runPortableDesktopHandoff } from "./portable-desktop-launch.js";

export const NATIVE_HISTORY_ACTIVATION_KIND = "native-history-activation" as const;
export const NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND = "native-history-activation-run-v1" as const;
export const NATIVE_HISTORY_ACTIVATION_CONTEXT_FILE = "context.v1.json" as const;
export const NATIVE_HISTORY_ACTIVATION_JOURNAL_FILE = "journal.v1.json" as const;
export const NATIVE_HISTORY_ACTIVATION_ARCHIVE_DIRECTORY = "registration-archive" as const;
export const NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX = "com.therealityreport.tweakers.native-history-activation" as const;

export const NATIVE_HISTORY_ACTIVATION_CHATGPT_APP = "/Applications/ChatGPT.app" as const;
export const NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP = "/Applications/Tweakers.app" as const;

const CONTEXT_MAX_BYTES = 64 * 1024;
const JOURNAL_MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BROKER_SOCKET_FILE = "accounts-broker.v1.sock";
const BROKER_HOST_FILE = "broker-host.js";
const BROKER_APP_SERVER_FILE = "broker-app-server.js";
const REGISTRATION_SECRET_FILE = "control-secret.v1";
const REGISTRATION_CONFIG_FILE = "account-router-config.json";
const REGISTRATION_SOURCE_FILE = "native-history-source.v1.json";
const REGISTRATION_CANONICAL_HISTORY_FILE = "canonical-history.v1.json";
const REGISTRATION_MARKER_FILE = "native-history-setup.v1.json";
const REGISTRATION_BOOTSTRAP_FILES = [
  REGISTRATION_SECRET_FILE,
  REGISTRATION_CONFIG_FILE,
  REGISTRATION_SOURCE_FILE,
  REGISTRATION_CANONICAL_HISTORY_FILE,
  REGISTRATION_MARKER_FILE,
] as const;
const REGISTRATION_SECRET_BYTES = 32;
const REGISTRATION_JSON_MAX_BYTES = 64 * 1024;
const BROKER_STOP_TERM_TIMEOUT_MS = 2_000;
const BROKER_STOP_KILL_TIMEOUT_MS = 1_000;
const RUNTIME_READY_TIMEOUT_MS = 60_000;
const RUNTIME_READY_POLL_MS = 250;

export type NativeHistoryActivationPhase =
  | "prepared"
  | "candidates-ready"
  | "apps-quiesced"
  | "registration-published"
  | "independent-promoted"
  | "injected-committed"
  | "independent-verified"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "recovery-required";

export interface NativeHistoryActivationDirectoryIdentity {
  device: number;
  inode: number;
  uid: number;
  mode: number;
}

export interface NativeHistoryActivationFileSeal {
  path: string;
  bytes: number;
  sha256: string;
}

export interface NativeHistoryActivationManagerBindingV1 {
  generationId: string;
  generationRoot: string;
  managerBundle: NativeHistoryActivationFileSeal;
  targetSeal: NativeHistoryActivationFileSeal;
  launcher: NativeHistoryActivationFileSeal;
  node: NativeHistoryActivationFileSeal;
  runtime: {
    root: string;
    fingerprint: string;
    brokerHost: NativeHistoryActivationFileSeal;
  };
  managedRuntime: {
    root: string;
    fingerprint: string;
  };
}

export interface NativeHistoryActivationSourceBindingV1 {
  generationId: string;
  receiptDigest: string;
  sourceDigest: string;
  revision: string;
}

export interface NativeHistoryActivationEnvironmentBindingV1 {
  registryFile: string;
  registryRevision: string;
  selectionFile: string;
  selectionRevision: string;
}

export interface NativeHistoryActivationTweakersBindingV1 {
  appPath: typeof NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP;
  appIdentity: NativeHistoryActivationDirectoryIdentity;
  userRoot: string;
  stateFile: string;
  stateRevision: string;
}

export interface NativeHistoryActivationRootsV1 {
  legacyRouterRoot: string;
  sourceCodexRoot: string;
  sourceSqliteRoot: string;
  secondaryCodexRoot: string;
  secondarySqliteRoot: string;
  globalRoot: string;
  legacyConfigFingerprint: string;
  legacyConfigGeneration: number;
  legacyRouterIdentity: NativeHistoryActivationDirectoryIdentity;
  sourceCodexIdentity: NativeHistoryActivationDirectoryIdentity;
  sourceSqliteIdentity: NativeHistoryActivationDirectoryIdentity;
  secondaryCodexIdentity: NativeHistoryActivationDirectoryIdentity;
  secondarySqliteIdentity: NativeHistoryActivationDirectoryIdentity;
}

export interface NativeHistoryActivationRegistrationBindingV1 {
  issuedAt: string;
  registrationFingerprint: string;
  globalRootAbsent: true;
  reservationAbsent: true;
}

export interface NativeHistoryActivationRunnerBindingV1 {
  kind: "launchd-one-shot";
  label: string;
  plistPath: string;
}

/** One owner-private context contains every mutable binding consumed at cutover. */
export interface NativeHistoryActivationContextV1 {
  version: typeof NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION;
  kind: typeof NATIVE_HISTORY_ACTIVATION_KIND;
  operationId: string;
  managerRoot: string;
  operationRoot: string;
  approvedAt: string;
  preparedAt: string;
  /** Omitted on historical two-app contexts; explicit scope never touches native Codex. */
  activationScope?: "tweakers-only";
  apps: {
    chatgpt: typeof NATIVE_HISTORY_ACTIVATION_CHATGPT_APP;
    tweakers: typeof NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP;
  };
  manager: NativeHistoryActivationManagerBindingV1;
  source: NativeHistoryActivationSourceBindingV1;
  environment: NativeHistoryActivationEnvironmentBindingV1;
  tweakers: NativeHistoryActivationTweakersBindingV1;
  roots: NativeHistoryActivationRootsV1;
  registration: NativeHistoryActivationRegistrationBindingV1;
  runner: NativeHistoryActivationRunnerBindingV1;
}

export interface NativeHistoryActivationRegistrationReceiptV1 {
  registrationFingerprint: string;
  globalRoot: NativeHistoryActivationDirectoryIdentity;
  reservation: NativeHistoryActivationDirectoryIdentity;
}

export interface NativeHistoryActivationBrokerIdentityV1 {
  pid: number;
  processStartToken: string;
  parentPid: number | null;
  parentProcessStartToken: string | null;
  brokerHostPath: string;
  brokerHostSha256: string;
  socketPath: string;
  configSha256: string;
}

/** A bounded, read-only process projection used only for broker owner proof. */
export interface NativeHistoryActivationProcessObservation {
  pid: number;
  ppid: number | null;
  processStartToken: string;
  command: string;
}

/**
 * Test seams for the read-only broker owner proof. They do not expose a
 * process-control capability and production supplies every observation.
 */
export interface NativeHistoryActivationBrokerObservationDependencies {
  processes?: () => readonly NativeHistoryActivationProcessObservation[];
  socketOwnerPids?: (socketPath: string) => readonly number[];
  participatingAppPids?: (context: NativeHistoryActivationContextV1) => readonly number[];
  verifyRuntime?: (context: NativeHistoryActivationContextV1) => void;
}

export interface NativeHistoryActivationArchiveV1 {
  archiveRoot: string;
  globalRootArchive: string;
  reservationArchive: string;
}

export interface NativeHistoryActivationJournalV1 {
  version: typeof NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION;
  kind: "native-history-activation-journal";
  operationId: string;
  phase: NativeHistoryActivationPhase;
  attemptStartedAt: string;
  updatedAt: string;
  registrationFingerprint: string | null;
  registration: NativeHistoryActivationRegistrationReceiptV1 | null;
  broker: NativeHistoryActivationBrokerIdentityV1 | null;
  archive: NativeHistoryActivationArchiveV1 | null;
  /** Omitted in older journals or before capture; null means observed absent. */
  previousTweakers?: NativeHistoryActivationAppProcessIdentity | null;
  error: string | null;
}

export interface NativeHistoryActivationInvocation {
  operationId: string;
  contextBytes: number;
  contextSha256: string;
}

export interface NativeHistoryActivationLaunchctlResult {
  status: number | null;
  output?: string;
  error?: string;
}

export interface NativeHistoryActivationLaunchctl {
  bootstrap(domain: string, plistPath: string): NativeHistoryActivationLaunchctlResult;
  print(service: string): NativeHistoryActivationLaunchctlResult;
  bootout?(domain: string, service: string): NativeHistoryActivationLaunchctlResult;
}

export interface NativeHistoryActivationPreparedInjected {
  commit(): Promise<EnvironmentTransactionReceipt>;
  cancel(): Promise<void>;
  rollback(): Promise<void>;
  /** Accepts a proven cancellation only while registration is still absent. */
  restoreBeforeRegistration(): Promise<void>;
}

export interface NativeHistoryActivationPreparedIndependent {
  deferred: DeferredTweakersVariantRefresh;
  previousTweakers: NativeHistoryActivationAppProcessIdentity | null;
}

export interface NativeHistoryActivationAppProcessIdentity {
  pid: number;
  processStartToken: string;
}

export interface NativeHistoryActivationCoordinatorDependencies {
  now?: () => string;
  /** Revalidates all source/runtime/manager bindings before any candidate work. */
  verifyContext?: (context: NativeHistoryActivationContextV1) => void | Promise<void>;
  prepareInjected?: (
    context: NativeHistoryActivationContextV1,
    beforeApply: () => Promise<void>,
  ) => Promise<NativeHistoryActivationPreparedInjected>;
  /** The implementation must invoke `beforePromotion` only after its candidate is fully staged. */
  prepareIndependent?: (
    context: NativeHistoryActivationContextV1,
    beforePromotion: () => Promise<void>,
    /** Internal rollback-only capture; it is never a manager command capability. */
    capturePreviousTweakers: (previous: NativeHistoryActivationAppProcessIdentity | null) => void,
  ) => Promise<NativeHistoryActivationPreparedIndependent>;
  /** Must fail closed when any enrolled client or native writer is present. */
  finalWriterCensus?: (context: NativeHistoryActivationContextV1) => boolean;
  /** Runs after ordinary ChatGPT main-process shutdown, before the final census. */
  quiesceInjectedBeforeRegistration?: (context: NativeHistoryActivationContextV1) => Promise<void>;
  /** After publication, requires all writers and the broker listener to be gone. */
  postPublicationWriterCensus?: (context: NativeHistoryActivationContextV1) => boolean;
  prepareOfflineAccountContinuity?: (context: NativeHistoryActivationContextV1) => Promise<void>;
  quiesceVerifiedInjected?: (context: NativeHistoryActivationContextV1) => Promise<void>;
  applyNativeHistory?: (context: NativeHistoryActivationContextV1) => NativeHistoryActivationRegistrationReceiptV1;
  /**
   * On a publication throw, distinguish a definitely absent destination from
   * the setup helper's retained reservation/published root. It is internal
   * lifecycle evidence, never a caller-selected recovery surface.
   */
  inspectPublishedRegistration?: (
    context: NativeHistoryActivationContextV1,
  ) => NativeHistoryActivationRegistrationReceiptV1 | null;
  /** Require operation-bound runtime readiness for the newly promoted independent app. */
  reopenAndProveIndependent?: (
    context: NativeHistoryActivationContextV1,
    prepared: NativeHistoryActivationPreparedIndependent,
  ) => Promise<void>;
  /** Returns only the exact sealed broker that owns the registration socket. */
  observeBroker?: (context: NativeHistoryActivationContextV1) => NativeHistoryActivationBrokerIdentityV1;
  /** Stops only a broker proven by socket, sealed command, start token, and ancestry. */
  stopBroker?: (
    context: NativeHistoryActivationContextV1,
    known: NativeHistoryActivationBrokerIdentityV1 | null,
  ) => void | Promise<void>;
  /** Stops exact current participant processes before registration archive recovery. */
  stopParticipatingApps?: (context: NativeHistoryActivationContextV1) => Promise<void>;
  archiveRegistration?: (
    context: NativeHistoryActivationContextV1,
    registration: NativeHistoryActivationRegistrationReceiptV1,
  ) => NativeHistoryActivationArchiveV1;
  reopenPreviousTweakers?: (
    context: NativeHistoryActivationContextV1,
    previous: NativeHistoryActivationAppProcessIdentity | null,
  ) => Promise<void>;
  readJournal?: (context: NativeHistoryActivationContextV1) => NativeHistoryActivationJournalV1 | null;
  writeJournal?: (context: NativeHistoryActivationContextV1, journal: NativeHistoryActivationJournalV1) => void;
}

export interface NativeHistoryActivationManagerCommandDependencies
  extends NativeHistoryActivationCoordinatorDependencies {
  managerRoot?: () => string;
  /** Test-only origin proof seam. Production proves launchd ownership itself. */
  assertRunner?: (
    context: NativeHistoryActivationContextV1,
    contextSeal: NativeHistoryActivationFileSeal,
    invocation: NativeHistoryActivationInvocation,
  ) => void;
}

export interface PrepareNativeHistoryActivationContextInput {
  operationId: string;
  /** Durable record of the final user-approved cutover window. */
  approvedAt: string;
  activationScope?: "tweakers-only";
}

export interface PrepareNativeHistoryActivationContextDependencies {
  now?: () => string;
  managerRoot?: () => string;
  home?: () => string;
}

/** Paths are derived only from the canonical global manager root and operation ID. */
export function nativeHistoryActivationPaths(managerRoot: string, operationId: string): {
  operationRoot: string;
  context: string;
  journal: string;
  archive: string;
} {
  const root = exactAbsolute(managerRoot, "Native history activation manager root");
  assertUuid(operationId, "Native history activation operation ID");
  const operationRoot = join(root, "transactions", "native-history-activation", operationId);
  return {
    operationRoot,
    context: join(operationRoot, NATIVE_HISTORY_ACTIVATION_CONTEXT_FILE),
    journal: join(operationRoot, NATIVE_HISTORY_ACTIVATION_JOURNAL_FILE),
    archive: join(operationRoot, NATIVE_HISTORY_ACTIVATION_ARCHIVE_DIRECTORY),
  };
}

/**
 * Create the sole context accepted by the private manager route.  This does
 * not arm launchd, stop an app, create a broker root, or copy any history.
 */
export function prepareNativeHistoryActivationContext(
  input: PrepareNativeHistoryActivationContextInput,
  dependencies: PrepareNativeHistoryActivationContextDependencies = {},
): NativeHistoryActivationContextV1 {
  assertUuid(input.operationId, "Native history activation operation ID");
  assertTimestamp(input.approvedAt, "Native history activation approval time");
  if (input.activationScope !== undefined && input.activationScope !== "tweakers-only") throw new Error("Invalid native history activation scope");
  const home = exactAbsolute((dependencies.home ?? targetUserHome)(), "Native history activation home");
  const canonicalRoot = canonicalTweakersManagerRoot(home);
  const managerRoot = exactAbsolute((dependencies.managerRoot ?? resolveSealedTweakersManagerUserRoot)(), "Native history activation manager root");
  if (managerRoot !== canonicalRoot) {
    throw new Error("Native history activation requires the canonical global Tweakers manager root");
  }
  const paths = nativeHistoryActivationPaths(managerRoot, input.operationId);
  if (existsSync(paths.operationRoot)) {
    throw new Error("Native history activation operation root already exists; inspect its journal rather than replaying it");
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const preparedAt = canonicalTimestamp(now(), "Native history activation preparation time");
  const fixed = fixedRoots(home, managerRoot);
  const { tweakersUserRoot, ...roots } = fixed;
  const setupInput: NativeHistorySetupInput = {
    legacyRouterRoot: roots.legacyRouterRoot,
    sourceCodexRoot: roots.sourceCodexRoot,
    sourceSqliteRoot: roots.sourceSqliteRoot,
    secondaryCodexRoot: roots.secondaryCodexRoot,
    secondarySqliteRoot: roots.secondarySqliteRoot,
    globalRoot: roots.globalRoot,
    appPaths: [NATIVE_HISTORY_ACTIVATION_CHATGPT_APP, NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP],
  };
  if (existsSync(roots.globalRoot) || existsSync(reservationPath(roots.globalRoot))) {
    throw new Error("Native history activation requires an absent global registration root and reservation");
  }
  const preview = setupNativeHistory(setupInput, { now: () => preparedAt });
  if (preview.state !== "preview") throw new Error("Native history activation preview did not remain non-mutating");
  const legacyConfig = readLegacyConfigBinding(roots.legacyRouterRoot);
  const source = readCurrentSourceBinding(managerRoot);
  const environment = readCurrentEnvironmentBinding(managerRoot);
  const manager = readCurrentManagerBinding();
  const stateFile = join(tweakersUserRoot, "state.json");
  const context: NativeHistoryActivationContextV1 = {
    version: NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION,
    kind: NATIVE_HISTORY_ACTIVATION_KIND,
    operationId: input.operationId,
    managerRoot,
    operationRoot: paths.operationRoot,
    approvedAt: input.approvedAt,
    preparedAt,
    ...(input.activationScope === "tweakers-only" ? { activationScope: input.activationScope } : {}),
    apps: { chatgpt: NATIVE_HISTORY_ACTIVATION_CHATGPT_APP, tweakers: NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP },
    manager,
    source,
    environment,
    tweakers: {
      appPath: NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP,
      appIdentity: directoryIdentity(NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP, "Tweakers app"),
      userRoot: tweakersUserRoot,
      stateFile,
      stateRevision: fileRevision(stateFile, "Tweakers state"),
    },
    roots: {
      ...roots,
      legacyConfigFingerprint: legacyConfig.fingerprint,
      legacyConfigGeneration: legacyConfig.generation,
      legacyRouterIdentity: directoryIdentity(roots.legacyRouterRoot, "Legacy account router root"),
      sourceCodexIdentity: directoryIdentity(roots.sourceCodexRoot, "Native Codex root"),
      sourceSqliteIdentity: directoryIdentity(roots.sourceSqliteRoot, "Native SQLite root"),
      secondaryCodexIdentity: directoryIdentity(roots.secondaryCodexRoot, "Secondary Codex root"),
      secondarySqliteIdentity: directoryIdentity(roots.secondarySqliteRoot, "Secondary SQLite root"),
    },
    registration: {
      issuedAt: preparedAt,
      registrationFingerprint: preview.registrationFingerprint,
      globalRootAbsent: true,
      reservationAbsent: true,
    },
    runner: {
      kind: "launchd-one-shot",
      label: `${NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX}.${input.operationId}`,
      plistPath: join(home, "Library", "LaunchAgents", `${NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX}.${input.operationId}.plist`),
    },
  };
  assertNativeHistoryActivationContext(context, { managerRoot, home });
  mkdirSync(dirname(paths.operationRoot), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(dirname(paths.operationRoot), "Native history activation transaction parent");
  mkdirSync(paths.operationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(paths.operationRoot, "Native history activation operation root");
  fsyncDirectory(dirname(paths.operationRoot));
  try {
    writePrivateJsonNew(paths.context, context, "Native history activation context");
    return context;
  } catch (error) {
    // The context root is intentionally retained as evidence. A failed
    // preparation cannot be replayed into a different operation identity.
    throw error;
  }
}

/**
 * Arm a one-shot launchd worker after a context has been independently
 * prepared.  This is private plumbing for the final user-approved window;
 * it is never a manager status/action protocol capability.
 */
export function armNativeHistoryActivationLaunchAgent(
  managerRoot = resolveSealedTweakersManagerUserRoot(),
  operationId: string,
  launchctl: NativeHistoryActivationLaunchctl = systemLaunchctl(),
): void {
  const contextSeal = readNativeHistoryActivationContext(managerRoot, operationId);
  const context = contextSeal.context;
  const domain = launchdDomain();
  const service = `${domain}/${context.runner.label}`;
  const existing = launchctl.print(service);
  if (existing.status === 0) throw new Error("Native history activation launchd service is already loaded");
  if (existing.status !== 113) throw new Error("Native history activation launchd service state is indeterminate");
  if (existsSync(context.runner.plistPath)) {
    throw new Error("Native history activation launchd plist already exists; inspect it rather than replacing it");
  }
  assertPrivateDirectory(dirname(context.runner.plistPath), "Native history activation LaunchAgents directory", false);
  writePrivateTextNew(
    context.runner.plistPath,
    nativeHistoryActivationLaunchAgentPlist(context, contextSeal.seal),
    "Native history activation launchd plist",
  );
  const bootstrapped = launchctl.bootstrap(domain, context.runner.plistPath);
  if (bootstrapped.status !== 0 || launchctl.print(service).status !== 0) {
    throw new Error("Native history activation launchd worker did not load");
  }
}

/** Strict fixed argv parser; a context path is never caller-selectable. */
export function parseNativeHistoryActivationManagerInvocation(
  argv: readonly string[],
): NativeHistoryActivationInvocation {
  if (!Array.isArray(argv)
    || argv.length !== 7
    || argv[0] !== NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND
    || argv[1] !== "--operation-id"
    || argv[3] !== "--context-bytes"
    || argv[5] !== "--context-sha256") {
    throw new Error("Native history activation manager arguments are invalid");
  }
  const operationId = argv[2] ?? "";
  assertUuid(operationId, "Native history activation operation ID");
  const bytesText = argv[4] ?? "";
  if (!/^[1-9][0-9]*$/.test(bytesText)) {
    throw new Error("Native history activation manager context bytes are invalid");
  }
  const contextBytes = Number(bytesText);
  if (!Number.isSafeInteger(contextBytes) || contextBytes > CONTEXT_MAX_BYTES) {
    throw new Error("Native history activation manager context bytes are invalid");
  }
  const contextSha256 = argv[6] ?? "";
  if (!SHA256_FINGERPRINT.test(contextSha256)) {
    throw new Error("Native history activation manager context fingerprint is invalid");
  }
  return { operationId, contextBytes, contextSha256 };
}

/**
 * Fixed manager entrypoint. It first proves its launchd-owned sealed route,
 * then invokes the bounded coordinator. It accepts no context path or other
 * host-provided lifecycle data.
 */
export async function runNativeHistoryActivationManagerCommand(
  argv: readonly string[],
  dependencies: NativeHistoryActivationManagerCommandDependencies = {},
): Promise<NativeHistoryActivationJournalV1> {
  const invocation = parseNativeHistoryActivationManagerInvocation(argv);
  const managerRoot = exactAbsolute((dependencies.managerRoot ?? resolveSealedTweakersManagerUserRoot)(), "Native history activation manager root");
  const sealed = readNativeHistoryActivationContext(managerRoot, invocation.operationId);
  if (sealed.seal.bytes !== invocation.contextBytes || sealed.seal.sha256 !== invocation.contextSha256) {
    throw new Error("Native history activation invocation does not match its sealed private context");
  }
  assertNativeHistoryActivationContext(sealed.context, { managerRoot, home: targetUserHome() });
  (dependencies.assertRunner ?? assertNativeHistoryActivationLaunchdRunner)(sealed.context, sealed.seal, invocation);
  return runNativeHistoryActivation(sealed.context, dependencies);
}

/**
 * Core activation sequence. Exported for focused lifecycle tests; production
 * reaches it only through the fixed manager entrypoint above.
 */
export async function runNativeHistoryActivation(
  context: NativeHistoryActivationContextV1,
  dependencies: NativeHistoryActivationCoordinatorDependencies = {},
): Promise<NativeHistoryActivationJournalV1> {
  assertNativeHistoryActivationContext(context);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const readJournal = dependencies.readJournal ?? defaultReadJournal;
  const writeJournal = dependencies.writeJournal ?? defaultWriteJournal;
  const existing = readJournal(context);
  if (existing !== null) {
    assertNativeHistoryActivationJournal(existing, context);
    if (existing.phase === "committed") return existing;
    throw new Error(`Native history activation ${context.operationId} already started (${existing.phase}); recovery is required instead of replay`);
  }
  let journal: NativeHistoryActivationJournalV1 = newJournal(context, canonicalTimestamp(now(), "Native history activation clock"));
  writeJournal(context, journal);
  const record = (patch: Partial<Omit<NativeHistoryActivationJournalV1, "version" | "kind" | "operationId" | "attemptStartedAt">>): void => {
    journal = {
      ...journal,
      ...patch,
      updatedAt: canonicalTimestamp(now(), "Native history activation clock"),
    };
    assertNativeHistoryActivationJournal(journal, context);
    writeJournal(context, journal);
  };

  const verifyContext = dependencies.verifyContext ?? verifyNativeHistoryActivationContextCurrent;
  const prepareInjected = dependencies.prepareInjected ?? prepareDefaultInjected;
  const prepareIndependent = dependencies.prepareIndependent ?? prepareDefaultIndependent;
  const finalWriterCensus = dependencies.finalWriterCensus ?? defaultFinalWriterCensus;
  const postPublicationWriterCensus = dependencies.postPublicationWriterCensus ?? defaultPostPublicationWriterCensus;
  const applyNativeHistory = dependencies.applyNativeHistory ?? defaultApplyNativeHistory;
  const inspectPublishedRegistration = dependencies.inspectPublishedRegistration ?? defaultInspectPublishedRegistration;
  const reopenAndProveIndependent = dependencies.reopenAndProveIndependent ?? defaultReopenAndProveIndependent;
  const observeBroker = dependencies.observeBroker ?? defaultObserveBroker;
  const stopBroker = dependencies.stopBroker ?? defaultStopBroker;
  const stopParticipatingApps = dependencies.stopParticipatingApps ?? defaultStopParticipatingApps;
  const archiveRegistration = dependencies.archiveRegistration ?? defaultArchiveRegistration;
  const reopenPreviousTweakers = dependencies.reopenPreviousTweakers ?? defaultReopenPreviousTweakers;

  let injected: NativeHistoryActivationPreparedInjected | null = null;
  let independent: NativeHistoryActivationPreparedIndependent | null = null;
  let independentPromise: Promise<NativeHistoryActivationPreparedIndependent> | null = null;
  let injectedCommitStarted = false;
  let independentCommitStarted = false;
  let independentCommitted = false;
  let registration: NativeHistoryActivationRegistrationReceiptV1 | null = null;
  let broker: NativeHistoryActivationBrokerIdentityV1 | null = null;
  let previousTweakers: NativeHistoryActivationAppProcessIdentity | null = null;
  let previousTweakersCaptured = false;
  let unresolvedPublication = false;
  const barrier = deferredBarrier();

  const capturePreviousTweakers = (previous: NativeHistoryActivationAppProcessIdentity | null): void => {
    if (previousTweakersCaptured && !sameAppProcessIdentity(previousTweakers, previous)) {
      throw new Error("Native history activation independent candidate changed its previous Tweakers identity");
    }
    previousTweakers = previous;
    previousTweakersCaptured = true;
    record({ previousTweakers: previous });
  };

  const rejectIndependentBarrier = (reason: unknown): void => barrier.reject(reason);
  try {
    await verifyContext(context);
    if (context.activationScope === "tweakers-only") {
      independentPromise = prepareIndependent(context, async () => {
        record({ phase: "candidates-ready", error: null });
        if (!finalWriterCensus(context)) throw new Error("Native history activation Tweakers account is not idle");
        record({ phase: "apps-quiesced", error: null });
        try {
          registration = applyNativeHistory(context);
        } catch (error) {
          try {
            registration = inspectPublishedRegistration(context);
            unresolvedPublication = registration === null && registrationArtifactsPresent(context);
          } catch (inspectionError) {
            unresolvedPublication = true;
            throw new AggregateError([error, inspectionError], "Native history activation publication is ambiguous and requires recovery");
          }
          throw error;
        }
        if (registration.registrationFingerprint !== context.registration.registrationFingerprint) {
          throw new Error("Native history activation registration changed during Tweakers-only publication");
        }
        record({ phase: "registration-published", registration, registrationFingerprint: registration.registrationFingerprint, error: null });
        await (dependencies.prepareOfflineAccountContinuity ?? defaultPrepareOfflineAccountContinuity)(context);
      }, capturePreviousTweakers);
      independent = await independentPromise;
      capturePreviousTweakers(independent.previousTweakers);
      record({ phase: "independent-promoted", error: null });
      await reopenAndProveIndependent(context, independent);
      broker = observeBroker(context);
      record({ phase: "independent-verified", broker, error: null });
      independentCommitStarted = true;
      independent.deferred.commit();
      independentCommitted = true;
      record({ phase: "committed", error: null });
      return journal;
    }
    injected = await prepareInjected(context, async () => {
      if (!barrier.ready) throw new Error("Native history activation reached ChatGPT apply before the independent candidate quiesced");
      await (dependencies.quiesceInjectedBeforeRegistration
        ?? ((current) => quiesceExactApp(current.apps.chatgpt, null)))(context);
      record({ phase: "apps-quiesced", error: null });
      if (!finalWriterCensus(context)) {
        throw new Error("Native history activation final writer census was not idle");
      }
      let appliedRegistration: NativeHistoryActivationRegistrationReceiptV1;
      try {
        appliedRegistration = applyNativeHistory(context);
      } catch (applyError) {
        // setupNativeHistory intentionally retains its reservation and can
        // throw after either reservation creation or destination rename. Do
        // not let a null assignment turn such evidence into a pre-publication
        // rollback that reopens an old client against it.
        try {
          const observed = inspectPublishedRegistration(context);
          if (observed !== null) {
            registration = observed;
            record({
              phase: "registration-published",
              registrationFingerprint: observed.registrationFingerprint,
              registration: observed,
              error: safeErrorMessage(applyError),
            });
          } else if (registrationArtifactsPresent(context)) {
            unresolvedPublication = true;
          }
        } catch (inspectionError) {
          unresolvedPublication = true;
          throw new AggregateError([applyError, inspectionError], "Native history activation publication is ambiguous and requires recovery");
        }
        throw applyError;
      }
      registration = appliedRegistration;
      if (appliedRegistration.registrationFingerprint !== context.registration.registrationFingerprint) {
        throw new Error("Native history activation registration fingerprint differs from the sealed preview");
      }
      record({
        phase: "registration-published",
        registrationFingerprint: appliedRegistration.registrationFingerprint,
        registration: appliedRegistration,
        error: null,
      });
      await (dependencies.prepareOfflineAccountContinuity ?? defaultPrepareOfflineAccountContinuity)(context);
      barrier.release();
      independent = await requireIndependent(independentPromise);
      capturePreviousTweakers(independent.previousTweakers);
      record({ phase: "independent-promoted", error: null });
    });

    const startedIndependent = prepareIndependent(context, async () => {
      barrier.markReady();
      await barrier.waitForRelease();
    }, capturePreviousTweakers);
    independentPromise = startedIndependent;
    // A rejection before beforePromotion must also wake the candidate-ready
    // wait rather than leaving a manager worker indefinitely suspended.
    void startedIndependent.catch((error) => rejectIndependentBarrier(error));
    await barrier.waitUntilReady();
    record({ phase: "candidates-ready", error: null });

    injectedCommitStarted = true;
    const preparedInjected = injected;
    if (preparedInjected === null) throw new Error("Native history activation injected candidate was not prepared");
    const committed = await preparedInjected.commit();
    if (committed.transactionId !== context.operationId || committed.phase !== "committed"
      || committed.applied === null || !positiveInteger(committed.newMainPid)) {
      const detail = typeof committed.error === "string" && committed.error.trim().length > 0
        ? `: ${safeErrorMessage(committed.error)}` : "";
      throw new Error(`Native history activation injected transaction did not prove a committed new runtime${detail}`);
    }
    broker = observeBroker(context);
    record({ phase: "injected-committed", broker, error: null });

    independent = await requireIndependent(independentPromise);
    capturePreviousTweakers(independent.previousTweakers);
    await (dependencies.quiesceVerifiedInjected ?? ((current) => quiesceExactApp(current.apps.chatgpt)))(context);
    await reopenAndProveIndependent(context, independent);
    const afterIndependentBroker = observeBroker(context);
    if (!sameBrokerIdentity(afterIndependentBroker, broker)) {
      throw new Error("Native history activation independent runtime did not connect to the same exact broker authority");
    }
    record({ phase: "independent-verified", broker: afterIndependentBroker, error: null });
    if (independent === null) throw new Error("Native history activation independent candidate disappeared before commit");
    independentCommitStarted = true;
    independent.deferred.commit();
    independentCommitted = true;
    record({ phase: "committed", error: null });
    return journal;
  } catch (error) {
    const message = safeErrorMessage(error);
    rejectIndependentBarrier(error);
    if (independentCommitStarted) {
      // Independent commit has its own durable journal and compensating
      // window. Once invoked, an outer journal/lock-release failure cannot
      // establish that the variant is still rollbackable. Retain its account
      // registration and app state for journal-bound recovery.
      const detail = independentCommitted
        ? `Independent Tweakers committed; activation journal recovery is required: ${message}`
        : `Independent Tweakers commit outcome requires recovery: ${message}`;
      try { record({ phase: "recovery-required", error: safeErrorMessage(detail) }); } catch {}
      throw new Error(detail);
    }
    const rollbackErrors: unknown[] = [];
    try {
      record({ phase: "rolling-back", error: message });
    } catch (journalError) {
      rollbackErrors.push(journalError);
    }
    if (unresolvedPublication && registration === null) {
      // Do not archive a partial/unproven root and do not reopen either app.
      // The retained artifacts are the recovery evidence needed to decide
      // whether this operation ever owned the reservation/publication.
      try { await stopParticipatingApps(context); } catch (stopError) { rollbackErrors.push(stopError); }
      await rollbackBeforeRegistration({
        context,
        injected,
        independent,
        independentPromise,
        independentCaptureOccurred: previousTweakersCaptured,
        injectedCommitStarted,
        allowInjectedRollback: false,
        reopenPreviousTweakers,
        previousTweakers,
        reopenPrevious: false,
        errors: rollbackErrors,
      });
      const recoveryError = new AggregateError([error, ...rollbackErrors], "Native history activation publication is ambiguous; preserved artifacts require recovery");
      try { record({ phase: "recovery-required", error: safeErrorMessage(recoveryError) }); } catch {}
      throw recoveryError;
    }
    if (registration === null) {
      await rollbackBeforeRegistration({
        context,
        injected,
        independent,
        independentPromise,
        independentCaptureOccurred: previousTweakersCaptured,
        injectedCommitStarted,
        allowInjectedRollback: true,
        reopenPreviousTweakers,
        previousTweakers,
        reopenPrevious: true,
        errors: rollbackErrors,
      });
    } else {
      await rollbackAfterRegistration({
        context,
        injected,
        independent,
        independentPromise,
        independentCaptureOccurred: previousTweakersCaptured,
        injectedCommitStarted,
        broker,
        observeBroker,
        stopParticipatingApps,
        stopBroker,
        postPublicationWriterCensus,
        archiveRegistration,
        registration,
        recordArchive: (archive: NativeHistoryActivationArchiveV1) => record({ archive }),
        reopenPreviousTweakers,
        previousTweakers,
        errors: rollbackErrors,
      });
    }
    if (rollbackErrors.length > 0) {
      const recoveryError = new AggregateError([error, ...rollbackErrors], "Native history activation rollback was incomplete; preserved evidence requires recovery");
      try { record({ phase: "recovery-required", error: safeErrorMessage(recoveryError) }); } catch {}
      throw recoveryError;
    }
    record({ phase: "rolled-back", error: message });
    throw error;
  }
}

interface NativeHistoryActivationContextSeal {
  context: NativeHistoryActivationContextV1;
  seal: NativeHistoryActivationFileSeal;
}

interface NativeHistoryActivationFixedRoots extends Omit<NativeHistoryActivationRootsV1,
  "legacyConfigFingerprint" | "legacyConfigGeneration" | "legacyRouterIdentity" | "sourceCodexIdentity"
  | "sourceSqliteIdentity" | "secondaryCodexIdentity" | "secondarySqliteIdentity"> {
  tweakersUserRoot: string;
}

function fixedRoots(home: string, managerRoot: string): NativeHistoryActivationFixedRoots {
  return {
    legacyRouterRoot: join(home, "Library", "Application Support", "codex-plusplus", "tweak-data", "co.tweakers.account-switcher"),
    sourceCodexRoot: join(home, ".codex"),
    sourceSqliteRoot: join(home, ".codex"),
    secondaryCodexRoot: join(managerRoot, "variants", "tweakers", "codex-home"),
    secondarySqliteRoot: join(managerRoot, "variants", "tweakers", "codex-home"),
    globalRoot: join(managerRoot, "tweak-data", "co.tweakers.account-switcher"),
    tweakersUserRoot: join(managerRoot, "variants", "tweakers"),
  };
}

function reservationPath(globalRoot: string): string {
  return `${globalRoot}.native-setup-reservation`;
}

function exactAbsolute(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return value;
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} must be a lowercase RFC4122 UUID`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be RFC3339`);
  }
}

function canonicalTimestamp(value: string, label: string): string {
  assertTimestamp(value, label);
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function safeErrorMessage(error: unknown, depth = 0): string {
  const raw = error instanceof AggregateError && depth < 3
    ? [error.message, ...error.errors.slice(0, 4).map((cause) => safeErrorMessage(cause, depth + 1))].join("; ")
    : error instanceof Error
      ? [error.message, ...(error.cause !== undefined && depth < 3 ? [safeErrorMessage(error.cause, depth + 1)] : [])].join("; ")
      : String(error);
  // Context/journal values must never become a sink for command lines or
  // material that could have come from a backend response.
  return raw.replace(/[\r\n\u0000]+/g, " ").slice(0, 512);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function directoryIdentity(path: string, label: string): NativeHistoryActivationDirectoryIdentity {
  const canonical = exactAbsolute(path, label);
  if (realpathSync(canonical) !== canonical) throw new Error(`${label} must not resolve through a link`);
  const stat = lstatSync(canonical);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} has an unsafe directory identity`);
  }
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}

function sameDirectoryIdentity(
  left: NativeHistoryActivationDirectoryIdentity,
  right: NativeHistoryActivationDirectoryIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode
    && left.uid === right.uid && left.mode === right.mode;
}

function assertDirectoryIdentity(value: unknown, label: string): asserts value is NativeHistoryActivationDirectoryIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["device", "inode", "uid", "mode"])
    || !nonnegativeInteger(value.device)
    || !nonnegativeInteger(value.inode)
    || !nonnegativeInteger(value.uid)
    || !nonnegativeInteger(value.mode) || value.mode > 0o7777) {
    throw new Error(`${label} is invalid`);
  }
}

function fileRevision(path: string, label: string): string {
  const bytes = readPrivateBytes(path, CONTEXT_MAX_BYTES, label);
  try {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally {
    bytes.fill(0);
  }
}

function fileSeal(path: string, label: string): NativeHistoryActivationFileSeal {
  const canonical = exactAbsolute(path, label);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(canonical) !== canonical || stat.nlink !== 1) {
    throw new Error(`${label} must be a canonical regular file`);
  }
  const bytes = readFileSync(canonical);
  try {
    return {
      path: canonical,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    bytes.fill(0);
  }
}

function assertFileSeal(value: unknown, label: string): asserts value is NativeHistoryActivationFileSeal {
  if (!isRecord(value) || !hasExactKeys(value, ["bytes", "path", "sha256"])
    || typeof value.path !== "string" || !isAbsolute(value.path) || resolve(value.path) !== value.path
    || !positiveInteger(value.bytes) || !SHA256.test(String(value.sha256))) {
    throw new Error(`${label} is invalid`);
  }
}

function sameFileSeal(left: NativeHistoryActivationFileSeal, right: NativeHistoryActivationFileSeal): boolean {
  return left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
}

function assertPrivateDirectory(path: string, label: string, requirePrivate = true): void {
  const canonical = exactAbsolute(path, label);
  if (realpathSync(canonical) !== canonical) throw new Error(`${label} must not resolve through a link`);
  const stat = lstatSync(canonical);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o022) !== 0 || (requirePrivate && (stat.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be an owner-private real directory`);
  }
}

function readPrivateBytes(path: string, maxBytes: number, label: string): Buffer {
  const canonical = exactAbsolute(path, label);
  const stat = lstatSync(canonical);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(canonical) !== canonical || stat.nlink !== 1
    || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0
    || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`${label} is not a bounded owner-private regular file`);
  }
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(canonical);
    if (bytes.byteLength !== before.size || after.size !== before.size || after.ino !== before.ino
      || current.ino !== before.ino || current.dev !== before.dev) {
      bytes.fill(0);
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writePrivateJsonNew(path: string, value: unknown, label: string): void {
  writePrivateTextNew(path, `${JSON.stringify(value)}\n`, label);
}

function writePrivateTextNew(path: string, value: string, label: string): void {
  const canonical = exactAbsolute(path, label);
  const fd = openSync(canonical, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(canonical));
}

function writePrivateJsonAtomic(path: string, value: unknown, label: string): void {
  const canonical = exactAbsolute(path, label);
  const temporary = join(dirname(canonical), `.${NATIVE_HISTORY_ACTIVATION_JOURNAL_FILE}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, canonical);
  fsyncDirectory(dirname(canonical));
}

function readLegacyConfigBinding(root: string): { fingerprint: string; generation: number } {
  const bytes = readPrivateBytes(join(root, "account-router-config.json"), CONTEXT_MAX_BYTES, "Native history legacy account-router config");
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isRecord(value) || !positiveInteger(value.generation)
      || typeof value.fingerprint !== "string" || !SHA256_FINGERPRINT.test(value.fingerprint)) {
      throw new Error("Native history legacy account-router config has no valid generation binding");
    }
    return { fingerprint: value.fingerprint, generation: value.generation };
  } finally {
    bytes.fill(0);
  }
}

function readCurrentSourceBinding(managerRoot: string): NativeHistoryActivationSourceBindingV1 {
  const source = readRegisteredOfficialSource(managerRoot);
  if (source.state !== "ready" || source.generationId === null || source.receiptDigest === null
    || source.sourceDigest === null || !SHA256.test(source.receiptDigest) || !SHA256.test(source.sourceDigest)) {
    throw new Error(source.problem ?? "Native history activation requires a current registered official source");
  }
  return {
    generationId: source.generationId,
    receiptDigest: source.receiptDigest,
    sourceDigest: source.sourceDigest,
    revision: source.revision,
  };
}

function readCurrentEnvironmentBinding(managerRoot: string): NativeHistoryActivationEnvironmentBindingV1 {
  const paths = managerStatusPaths(managerRoot);
  if (readEnvironmentProfileRegistry(paths.environmentRegistryFile) === null
    || readEnvironmentSelection(paths.environmentSelectionFile) === null) {
    throw new Error("Native history activation requires a current environment registry and selection");
  }
  return {
    registryFile: paths.environmentRegistryFile,
    registryRevision: fileRevision(paths.environmentRegistryFile, "Native history environment registry"),
    selectionFile: paths.environmentSelectionFile,
    selectionRevision: fileRevision(paths.environmentSelectionFile, "Native history environment selection"),
  };
}

function readCurrentManagerBinding(): NativeHistoryActivationManagerBindingV1 {
  // Preparation is called by an authorized operator importing the published
  // bundle; execution is called by launchd. Bind both to the module whose code
  // actually runs, never to the operator's entrypoint or mutable argv text.
  // The runner separately requires its exact launchd argv and process identity.
  const bundle = exactAbsolute(fileURLToPath(import.meta.url), "Native history manager bundle");
  const executable = resolveManagerExecutableIdentity(bundle);
  if (executable.state !== "resolved") throw new Error("Native history activation requires a resolved sealed manager launcher");
  if (realpathSync(bundle) !== bundle) throw new Error("Native history manager bundle must not resolve through a link");
  const generationRoot = dirname(bundle);
  const targetSealPath = join(generationRoot, "target.seal");
  const targetSeal = fileSeal(targetSealPath, "Native history manager target seal");
  const parsed = parseTweakersManagerTargetSeal(readFileSync(targetSealPath, "utf8"));
  const managerBundle = fileSeal(bundle, "Native history manager bundle");
  const launcher = fileSeal(executable.path, "Native history manager launcher");
  const node = fileSeal(parsed.nodePath, "Native history manager Node executable");
  if (managerBundle.sha256 !== parsed.managerSha256 || launcher.sha256 !== parsed.launcherSha256
    || node.sha256 !== parsed.nodeSha256) {
    throw new Error("Native history manager generation does not match its target seal");
  }
  const runtime = resolveSealedManagerRuntimeAssets();
  const managedRuntime = resolveSealedManagerManagedRuntimeAssets();
  if (runtime === null || managedRuntime === null) {
    throw new Error("Native history activation requires compiled sealed runtime and managed-runtime generations");
  }
  verifySealedManagerRuntimeAssets(runtime);
  verifySealedManagerManagedRuntimeAssets(managedRuntime);
  if (parsed.managedRuntimeFingerprint !== managedRuntime.fingerprint) {
    throw new Error("Native history manager target seal does not bind the compiled managed runtime");
  }
  return {
    generationId: parsed.generationId,
    generationRoot,
    managerBundle,
    targetSeal,
    launcher,
    node,
    runtime: {
      root: runtime.root,
      fingerprint: runtime.fingerprint,
      brokerHost: fileSeal(join(runtime.root, "account-router", BROKER_HOST_FILE), "Native history broker host"),
    },
    managedRuntime: { root: managedRuntime.root, fingerprint: managedRuntime.fingerprint },
  };
}

function assertNativeHistoryActivationContext(
  value: unknown,
  expected: { managerRoot?: string; home?: string } = {},
): asserts value is NativeHistoryActivationContextV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "approvedAt", "apps", "environment", "kind", "manager", "managerRoot", "operationId", "operationRoot",
    "preparedAt", "registration", "roots", "runner", "source", "tweakers", "version",
    ...(value.activationScope === "tweakers-only" ? ["activationScope"] : []),
  ]) || value.version !== NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION || value.kind !== NATIVE_HISTORY_ACTIVATION_KIND) {
    throw new Error("Native history activation context has an invalid schema");
  }
  assertUuid(value.operationId, "Native history activation context operation ID");
  assertTimestamp(value.approvedAt, "Native history activation context approval time");
  assertTimestamp(value.preparedAt, "Native history activation context preparation time");
  const managerRoot = exactAbsolute(String(value.managerRoot), "Native history activation context manager root");
  const paths = nativeHistoryActivationPaths(managerRoot, value.operationId);
  if (value.operationRoot !== paths.operationRoot) throw new Error("Native history activation context operation root is not derived from its owner and ID");
  if (!isRecord(value.apps) || !hasExactKeys(value.apps, ["chatgpt", "tweakers"])
    || value.apps.chatgpt !== NATIVE_HISTORY_ACTIVATION_CHATGPT_APP
    || value.apps.tweakers !== NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP) {
    throw new Error("Native history activation context has invalid app targets");
  }
  assertContextManager(value.manager);
  assertContextSource(value.source);
  assertContextEnvironment(value.environment);
  assertContextTweakers(value.tweakers);
  assertContextRoots(value.roots);
  assertContextRegistration(value.registration);
  assertContextRunner(value.runner, value.operationId);
  if (expected.managerRoot !== undefined && managerRoot !== exactAbsolute(expected.managerRoot, "Native history activation expected manager root")) {
    throw new Error("Native history activation context is bound to a different manager root");
  }
  if (expected.home !== undefined) {
    const home = exactAbsolute(expected.home, "Native history activation expected home");
    if (managerRoot !== canonicalTweakersManagerRoot(home)) {
      throw new Error("Native history activation context is not bound to the canonical global manager root");
    }
    const roots = fixedRoots(home, managerRoot);
    const contextRoots = value.roots as NativeHistoryActivationRootsV1;
    if (contextRoots.legacyRouterRoot !== roots.legacyRouterRoot
      || contextRoots.sourceCodexRoot !== roots.sourceCodexRoot
      || contextRoots.sourceSqliteRoot !== roots.sourceSqliteRoot
      || contextRoots.secondaryCodexRoot !== roots.secondaryCodexRoot
      || contextRoots.secondarySqliteRoot !== roots.secondarySqliteRoot
      || contextRoots.globalRoot !== roots.globalRoot
      || (value.tweakers as NativeHistoryActivationTweakersBindingV1).userRoot !== roots.tweakersUserRoot) {
      throw new Error("Native history activation context root bindings are not canonical");
    }
  }
}

function assertContextManager(value: unknown): asserts value is NativeHistoryActivationManagerBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["generationId", "generationRoot", "launcher", "managedRuntime", "managerBundle", "node", "runtime", "targetSeal"])
    || typeof value.generationId !== "string" || !SHA256.test(value.generationId)
    || typeof value.generationRoot !== "string" || !isAbsolute(value.generationRoot) || resolve(value.generationRoot) !== value.generationRoot) {
    throw new Error("Native history activation manager binding is invalid");
  }
  assertFileSeal(value.managerBundle, "Native history manager bundle seal");
  assertFileSeal(value.targetSeal, "Native history manager target seal");
  assertFileSeal(value.launcher, "Native history manager launcher seal");
  assertFileSeal(value.node, "Native history manager Node seal");
  if (!isRecord(value.runtime) || !hasExactKeys(value.runtime, ["brokerHost", "fingerprint", "root"])
    || typeof value.runtime.root !== "string" || !isAbsolute(value.runtime.root) || resolve(value.runtime.root) !== value.runtime.root
    || typeof value.runtime.fingerprint !== "string" || !SHA256.test(value.runtime.fingerprint)) {
    throw new Error("Native history activation runtime binding is invalid");
  }
  assertFileSeal(value.runtime.brokerHost, "Native history broker host seal");
  if (!isRecord(value.managedRuntime) || !hasExactKeys(value.managedRuntime, ["fingerprint", "root"])
    || typeof value.managedRuntime.root !== "string" || !isAbsolute(value.managedRuntime.root) || resolve(value.managedRuntime.root) !== value.managedRuntime.root
    || typeof value.managedRuntime.fingerprint !== "string" || !SHA256.test(value.managedRuntime.fingerprint)) {
    throw new Error("Native history activation managed runtime binding is invalid");
  }
}

function assertContextSource(value: unknown): asserts value is NativeHistoryActivationSourceBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["generationId", "receiptDigest", "revision", "sourceDigest"])
    || typeof value.generationId !== "string" || !UUID.test(value.generationId)
    || typeof value.receiptDigest !== "string" || !SHA256.test(value.receiptDigest)
    || typeof value.sourceDigest !== "string" || !SHA256.test(value.sourceDigest)
    || typeof value.revision !== "string" || !SHA256_FINGERPRINT.test(value.revision)) {
    throw new Error("Native history activation official-source binding is invalid");
  }
}

function assertContextEnvironment(value: unknown): asserts value is NativeHistoryActivationEnvironmentBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["registryFile", "registryRevision", "selectionFile", "selectionRevision"])
    || typeof value.registryFile !== "string" || !isAbsolute(value.registryFile) || resolve(value.registryFile) !== value.registryFile
    || typeof value.selectionFile !== "string" || !isAbsolute(value.selectionFile) || resolve(value.selectionFile) !== value.selectionFile
    || typeof value.registryRevision !== "string" || !SHA256_FINGERPRINT.test(value.registryRevision)
    || typeof value.selectionRevision !== "string" || !SHA256_FINGERPRINT.test(value.selectionRevision)) {
    throw new Error("Native history activation environment binding is invalid");
  }
}

function assertContextTweakers(value: unknown): asserts value is NativeHistoryActivationTweakersBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["appIdentity", "appPath", "stateFile", "stateRevision", "userRoot"])
    || value.appPath !== NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP
    || typeof value.userRoot !== "string" || !isAbsolute(value.userRoot) || resolve(value.userRoot) !== value.userRoot
    || typeof value.stateFile !== "string" || !isAbsolute(value.stateFile) || resolve(value.stateFile) !== value.stateFile
    || typeof value.stateRevision !== "string" || !SHA256_FINGERPRINT.test(value.stateRevision)) {
    throw new Error("Native history activation Tweakers binding is invalid");
  }
  assertDirectoryIdentity(value.appIdentity, "Native history activation Tweakers app identity");
}

function assertContextRoots(value: unknown): asserts value is NativeHistoryActivationRootsV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "globalRoot", "legacyConfigFingerprint", "legacyConfigGeneration", "legacyRouterIdentity", "legacyRouterRoot",
    "secondaryCodexIdentity", "secondaryCodexRoot", "secondarySqliteIdentity", "secondarySqliteRoot",
    "sourceCodexIdentity", "sourceCodexRoot", "sourceSqliteIdentity", "sourceSqliteRoot",
  ])) {
    throw new Error("Native history activation root binding has an invalid schema");
  }
  for (const key of ["legacyRouterRoot", "sourceCodexRoot", "sourceSqliteRoot", "secondaryCodexRoot", "secondarySqliteRoot", "globalRoot"] as const) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key] as string) || resolve(value[key] as string) !== value[key]) {
      throw new Error(`Native history activation ${key} is invalid`);
    }
  }
  if (typeof value.legacyConfigFingerprint !== "string" || !SHA256_FINGERPRINT.test(value.legacyConfigFingerprint)
    || !positiveInteger(value.legacyConfigGeneration)) {
    throw new Error("Native history activation legacy router binding is invalid");
  }
  assertDirectoryIdentity(value.legacyRouterIdentity, "Native history legacy router identity");
  assertDirectoryIdentity(value.sourceCodexIdentity, "Native history source Codex identity");
  assertDirectoryIdentity(value.sourceSqliteIdentity, "Native history source SQLite identity");
  assertDirectoryIdentity(value.secondaryCodexIdentity, "Native history secondary Codex identity");
  assertDirectoryIdentity(value.secondarySqliteIdentity, "Native history secondary SQLite identity");
}

function assertContextRegistration(value: unknown): asserts value is NativeHistoryActivationRegistrationBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["globalRootAbsent", "issuedAt", "registrationFingerprint", "reservationAbsent"])
    || value.globalRootAbsent !== true || value.reservationAbsent !== true
    || typeof value.registrationFingerprint !== "string" || !SHA256_FINGERPRINT.test(value.registrationFingerprint)) {
    throw new Error("Native history activation registration binding is invalid");
  }
  assertTimestamp(value.issuedAt, "Native history activation registration time");
}

function assertContextRunner(value: unknown, operationId: string): asserts value is NativeHistoryActivationRunnerBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "label", "plistPath"])
    || value.kind !== "launchd-one-shot" || typeof value.label !== "string"
    || value.label !== `${NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX}.${operationId}`
    || typeof value.plistPath !== "string" || !isAbsolute(value.plistPath) || resolve(value.plistPath) !== value.plistPath) {
    throw new Error("Native history activation runner binding is invalid");
  }
}

function readNativeHistoryActivationContext(managerRoot: string, operationId: string): NativeHistoryActivationContextSeal {
  const root = exactAbsolute(managerRoot, "Native history activation manager root");
  const paths = nativeHistoryActivationPaths(root, operationId);
  assertPrivateDirectory(paths.operationRoot, "Native history activation operation root");
  const bytes = readPrivateBytes(paths.context, CONTEXT_MAX_BYTES, "Native history activation context");
  try {
    const seal: NativeHistoryActivationFileSeal = {
      path: paths.context,
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    const context = JSON.parse(bytes.toString("utf8")) as unknown;
    assertNativeHistoryActivationContext(context, { managerRoot: root });
    return { context, seal };
  } finally {
    bytes.fill(0);
  }
}

function assertNativeHistoryActivationJournal(
  value: unknown,
  context: NativeHistoryActivationContextV1,
): asserts value is NativeHistoryActivationJournalV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "archive", "attemptStartedAt", "broker", "error", "kind", "operationId", "phase", "registration",
    "registrationFingerprint", "updatedAt", "version", ...(isRecord(value) && "previousTweakers" in value ? ["previousTweakers"] : []),
  ]) || value.version !== NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION
    || value.kind !== "native-history-activation-journal" || value.operationId !== context.operationId
    || typeof value.phase !== "string" || ![
      "prepared", "candidates-ready", "apps-quiesced", "registration-published", "independent-promoted",
      "injected-committed", "independent-verified", "committed", "rolling-back", "rolled-back", "recovery-required",
    ].includes(value.phase)) {
    throw new Error("Native history activation journal is invalid");
  }
  assertTimestamp(value.attemptStartedAt, "Native history activation journal start time");
  assertTimestamp(value.updatedAt, "Native history activation journal update time");
  if ("previousTweakers" in value && value.previousTweakers !== null
    && (!isRecord(value.previousTweakers) || !hasExactKeys(value.previousTweakers, ["pid", "processStartToken"])
      || !positiveInteger(value.previousTweakers.pid) || typeof value.previousTweakers.processStartToken !== "string"
      || value.previousTweakers.processStartToken.length === 0 || value.previousTweakers.processStartToken.length > 128)) {
    throw new Error("Native history activation previous Tweakers identity is invalid");
  }
  if (value.registrationFingerprint !== null && (typeof value.registrationFingerprint !== "string" || !SHA256_FINGERPRINT.test(value.registrationFingerprint))) {
    throw new Error("Native history activation journal registration fingerprint is invalid");
  }
  if (value.error !== null && (typeof value.error !== "string" || value.error.length > 512)) {
    throw new Error("Native history activation journal error is invalid");
  }
  if (value.registration !== null) assertRegistrationReceipt(value.registration, context);
  if (value.broker !== null) assertBrokerIdentity(value.broker, context);
  if (value.archive !== null) assertArchive(value.archive, context);
  if (value.registration === null && value.registrationFingerprint !== null) {
    throw new Error("Native history activation journal has a registration fingerprint without a receipt");
  }
  if (value.registration !== null && value.registrationFingerprint !== value.registration.registrationFingerprint) {
    throw new Error("Native history activation journal registration fingerprint does not match its receipt");
  }
  if (value.broker !== null && value.registration === null) {
    throw new Error("Native history activation journal has broker evidence without a registration");
  }
  if (value.archive !== null && (value.registration === null
    || !["rolling-back", "rolled-back", "recovery-required"].includes(value.phase))) {
    throw new Error("Native history activation journal archive is incoherent with its phase");
  }
  if (value.phase === "committed" && (value.registration === null
    || value.registrationFingerprint !== context.registration.registrationFingerprint
    || value.broker === null || value.archive !== null || value.error !== null)) {
    throw new Error("Native history activation committed journal lacks coherent final evidence");
  }
}

function newJournal(context: NativeHistoryActivationContextV1, now: string): NativeHistoryActivationJournalV1 {
  return {
    version: NATIVE_HISTORY_ACTIVATION_SCHEMA_VERSION,
    kind: "native-history-activation-journal",
    operationId: context.operationId,
    phase: "prepared",
    attemptStartedAt: now,
    updatedAt: now,
    registrationFingerprint: null,
    registration: null,
    broker: null,
    archive: null,
    error: null,
  };
}

function defaultReadJournal(context: NativeHistoryActivationContextV1): NativeHistoryActivationJournalV1 | null {
  const path = nativeHistoryActivationPaths(context.managerRoot, context.operationId).journal;
  if (!existsSync(path)) return null;
  const bytes = readPrivateBytes(path, JOURNAL_MAX_BYTES, "Native history activation journal");
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    assertNativeHistoryActivationJournal(value, context);
    return value;
  } finally {
    bytes.fill(0);
  }
}

function defaultWriteJournal(context: NativeHistoryActivationContextV1, journal: NativeHistoryActivationJournalV1): void {
  assertNativeHistoryActivationJournal(journal, context);
  const paths = nativeHistoryActivationPaths(context.managerRoot, context.operationId);
  assertPrivateDirectory(paths.operationRoot, "Native history activation operation root");
  writePrivateJsonAtomic(paths.journal, journal, "Native history activation journal");
}

function assertRegistrationReceipt(
  value: unknown,
  context: NativeHistoryActivationContextV1,
): asserts value is NativeHistoryActivationRegistrationReceiptV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["globalRoot", "registrationFingerprint", "reservation"])
    || value.registrationFingerprint !== context.registration.registrationFingerprint) {
    throw new Error("Native history activation registration receipt is invalid");
  }
  assertDirectoryIdentity(value.globalRoot, "Native history activation registration root identity");
  assertDirectoryIdentity(value.reservation, "Native history activation registration reservation identity");
}

function assertBrokerIdentity(value: unknown, context: NativeHistoryActivationContextV1): asserts value is NativeHistoryActivationBrokerIdentityV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "brokerHostPath", "brokerHostSha256", "configSha256", "parentPid", "parentProcessStartToken",
    "pid", "processStartToken", "socketPath",
  ]) || !positiveInteger(value.pid) || typeof value.processStartToken !== "string" || value.processStartToken.length === 0
    || (value.parentPid !== null && !positiveInteger(value.parentPid))
    || (value.parentProcessStartToken !== null && (typeof value.parentProcessStartToken !== "string" || value.parentProcessStartToken.length === 0))
    || value.brokerHostPath !== boundBrokerHostPath(context)
    || value.brokerHostSha256 !== context.manager.runtime.brokerHost.sha256
    || value.socketPath !== routerControlSocketPath(context.roots.globalRoot, BROKER_SOCKET_FILE)
    || typeof value.configSha256 !== "string" || !SHA256.test(value.configSha256)) {
    throw new Error("Native history activation broker identity is invalid");
  }
}

function assertArchive(value: unknown, context: NativeHistoryActivationContextV1): asserts value is NativeHistoryActivationArchiveV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["archiveRoot", "globalRootArchive", "reservationArchive"])
    || value.archiveRoot !== nativeHistoryActivationPaths(context.managerRoot, context.operationId).archive
    || value.globalRootArchive !== join(value.archiveRoot as string, "global-root")
    || value.reservationArchive !== join(value.archiveRoot as string, "native-setup-reservation")) {
    throw new Error("Native history activation registration archive is invalid");
  }
}

function nativeHistoryActivationManagerArguments(
  context: NativeHistoryActivationContextV1,
  contextSeal: NativeHistoryActivationFileSeal,
): readonly string[] {
  return [
    context.manager.node.path,
    context.manager.managerBundle.path,
    NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND,
    "--operation-id",
    context.operationId,
    "--context-bytes",
    String(contextSeal.bytes),
    "--context-sha256",
    contextSeal.sha256,
  ];
}

function nativeHistoryActivationLaunchAgentPlist(
  context: NativeHistoryActivationContextV1,
  contextSeal: NativeHistoryActivationFileSeal,
): string {
  const argumentsList = nativeHistoryActivationManagerArguments(context, contextSeal)
    .map((entry) => `    <string>${xmlEscape(entry)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(context.runner.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentsList,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    // This explicitly requested, one-shot cutover blocks reopening the app.
    // Background I/O/CPU throttling can exhaust the bounded native probes
    // and even prevent rollback from obtaining its writer census.
    '  <string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Native history activation requires a numeric launchd user domain");
  }
  return `gui/${uid}`;
}

function systemLaunchctl(): NativeHistoryActivationLaunchctl {
  const invoke = (args: readonly string[]): NativeHistoryActivationLaunchctlResult => {
    const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      status: result.status,
      ...(typeof result.stdout === "string" ? { output: result.stdout } : {}),
      ...(result.error ? { error: result.error.message } : {}),
    };
  };
  return {
    bootstrap(domain, plistPath) { return invoke(["bootstrap", domain, plistPath]); },
    print(service) { return invoke(["print", service]); },
    bootout(domain, service) { return invoke(["bootout", domain, service]); },
  };
}

/** Prove that the manager process was started by the exact one-shot LaunchAgent. */
function assertNativeHistoryActivationLaunchdRunner(
  context: NativeHistoryActivationContextV1,
  contextSeal: NativeHistoryActivationFileSeal,
  invocation: NativeHistoryActivationInvocation,
): void {
  const expected = nativeHistoryActivationManagerArguments(context, contextSeal);
  if (process.ppid !== 1 || process.execPath !== context.manager.node.path || process.argv[1] !== context.manager.managerBundle.path
    || !sameStringArray(process.argv.slice(2), expected.slice(2))) {
    throw new Error("Native history activation manager process is not bound to the sealed launchd route");
  }
  const launchctl = systemLaunchctl();
  const service = `${launchdDomain()}/${context.runner.label}`;
  const printed = launchctl.print(service);
  if (printed.status !== 0 || typeof printed.output !== "string"
    || !printed.output.includes(`\tpath = ${context.runner.plistPath}`)
    || !printed.output.includes(`\tpid = ${process.pid}`)) {
    throw new Error("Native history activation launchd service does not bind the current manager process");
  }
  const plist = readPrivateBytes(context.runner.plistPath, CONTEXT_MAX_BYTES, "Native history activation launchd plist");
  try {
    if (plist.toString("utf8") !== nativeHistoryActivationLaunchAgentPlist(context, contextSeal)) {
      throw new Error("Native history activation launchd plist does not match the sealed context");
    }
  } finally {
    plist.fill(0);
  }
  if (invocation.operationId !== context.operationId || invocation.contextBytes !== contextSeal.bytes
    || invocation.contextSha256 !== contextSeal.sha256) {
    throw new Error("Native history activation launchd invocation capability differs from its sealed context");
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function deferredBarrier(): {
  readonly ready: boolean;
  markReady(): void;
  waitUntilReady(): Promise<void>;
  release(): void;
  waitForRelease(): Promise<void>;
  reject(reason: unknown): void;
} {
  let ready = false;
  let released = false;
  let failed: unknown = null;
  let readyResolve!: () => void;
  let readyReject!: (reason: unknown) => void;
  let releaseResolve!: () => void;
  let releaseReject!: (reason: unknown) => void;
  const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    readyResolve = resolvePromise;
    readyReject = rejectPromise;
  });
  const releasePromise = new Promise<void>((resolvePromise, rejectPromise) => {
    releaseResolve = resolvePromise;
    releaseReject = rejectPromise;
  });
  // A candidate can fail before its pre-promotion hook begins waiting on the
  // release barrier. Keep the original promises rejecting for their real
  // consumers while marking those early rejections handled internally.
  void readyPromise.catch(() => {});
  void releasePromise.catch(() => {});
  return {
    get ready() { return ready; },
    markReady() {
      if (failed !== null || ready) throw new Error("Native history activation independent barrier was signaled more than once");
      ready = true;
      readyResolve();
    },
    waitUntilReady() { return readyPromise; },
    release() {
      if (failed !== null || !ready || released) throw new Error("Native history activation independent barrier release is invalid");
      released = true;
      releaseResolve();
    },
    waitForRelease() { return releasePromise; },
    reject(reason) {
      if (failed !== null || released) return;
      failed = reason ?? new Error("Native history activation barrier failed");
      readyReject(failed);
      releaseReject(failed);
    },
  };
}

async function requireIndependent(
  value: Promise<NativeHistoryActivationPreparedIndependent> | null,
): Promise<NativeHistoryActivationPreparedIndependent> {
  if (value === null) throw new Error("Native history activation independent candidate was not started");
  return value;
}

function verifyNativeHistoryActivationContextCurrent(context: NativeHistoryActivationContextV1): void {
  const home = targetUserHome();
  assertNativeHistoryActivationContext(context, { managerRoot: context.managerRoot, home });
  const manager = readCurrentManagerBinding();
  if (!sameManagerBinding(manager, context.manager)) {
    throw new Error("Native history activation sealed manager generation changed after context preparation");
  }
  const lease = acquireRegisteredOfficialSourceLease(context.managerRoot);
  try {
    const source = readCurrentSourceBinding(context.managerRoot);
    if (!sameSourceBinding(source, context.source)
      || lease.pointer.generationId !== context.source.generationId
      || lease.receiptDigest !== context.source.receiptDigest
      || lease.pointer.sourceDigest !== context.source.sourceDigest) {
      throw new Error("Native history activation registered official source changed after context preparation");
    }
  } finally {
    lease.release();
  }
  const environment = readCurrentEnvironmentBinding(context.managerRoot);
  if (!sameEnvironmentBinding(environment, context.environment)) {
    throw new Error("Native history activation environment selection changed after context preparation");
  }
  const registry = readEnvironmentProfileRegistry(context.environment.registryFile);
  const selection = readEnvironmentSelection(context.environment.selectionFile);
  if (registry === null || selection === null || selection.selectedDesktopPath !== NATIVE_HISTORY_ACTIVATION_CHATGPT_APP
    || selection.selectedDesktopBundleId !== "com.openai.codex" || selection.releaseProfile !== "stable"
    || selection.appExperience !== "chatgpt" || selection.migrationState !== "verified") {
    throw new Error("Native history activation requires the verified pristine stable ChatGPT selection");
  }
  // This derives the requested form from the sealed registry rather than
  // trusting a context-supplied target selection.
  const requested = createRequestedEnvironmentSelection(registry, { releaseProfile: "stable", appExperience: "tweakers" }, context.approvedAt);
  if (requested.selectedDesktopPath !== NATIVE_HISTORY_ACTIVATION_CHATGPT_APP || requested.selectedDesktopBundleId !== "com.openai.codex") {
    throw new Error("Native history activation environment registry produced an unexpected ChatGPT target");
  }
  if (!sameDirectoryIdentity(directoryIdentity(context.tweakers.appPath, "Native history activation Tweakers app"), context.tweakers.appIdentity)
    || fileRevision(context.tweakers.stateFile, "Native history activation Tweakers state") !== context.tweakers.stateRevision) {
    throw new Error("Native history activation Tweakers installation changed after context preparation");
  }
  const roots = context.roots;
  const legacy = readLegacyConfigBinding(roots.legacyRouterRoot);
  if (legacy.fingerprint !== roots.legacyConfigFingerprint || legacy.generation !== roots.legacyConfigGeneration
    || !sameDirectoryIdentity(directoryIdentity(roots.legacyRouterRoot, "Native history legacy router root"), roots.legacyRouterIdentity)
    || !sameDirectoryIdentity(directoryIdentity(roots.sourceCodexRoot, "Native history source Codex root"), roots.sourceCodexIdentity)
    || !sameDirectoryIdentity(directoryIdentity(roots.sourceSqliteRoot, "Native history source SQLite root"), roots.sourceSqliteIdentity)
    || !sameDirectoryIdentity(directoryIdentity(roots.secondaryCodexRoot, "Native history secondary Codex root"), roots.secondaryCodexIdentity)
    || !sameDirectoryIdentity(directoryIdentity(roots.secondarySqliteRoot, "Native history secondary SQLite root"), roots.secondarySqliteIdentity)) {
    throw new Error("Native history activation account-root binding changed after context preparation");
  }
  if (registrationArtifactsPresent(context)) {
    throw new Error("Native history activation destination was consumed before cutover");
  }
  const preview = setupNativeHistory(nativeHistorySetupInput(context), { now: () => context.registration.issuedAt });
  if (preview.state !== "preview" || preview.registrationFingerprint !== context.registration.registrationFingerprint) {
    throw new Error("Native history activation registration preview changed after context preparation");
  }
  const active = readEnvironmentTransactionReceipt(managerStatusPaths(context.managerRoot).environmentTransactionFile);
  if (active !== null && !["committed", "rolled-back", "cancelled", "failed", "ready"].includes(active.phase)) {
    throw new Error("Native history activation refuses an active environment transaction");
  }
}

function sameManagerBinding(left: NativeHistoryActivationManagerBindingV1, right: NativeHistoryActivationManagerBindingV1): boolean {
  return left.generationId === right.generationId && left.generationRoot === right.generationRoot
    && sameFileSeal(left.managerBundle, right.managerBundle) && sameFileSeal(left.targetSeal, right.targetSeal)
    && sameFileSeal(left.launcher, right.launcher) && sameFileSeal(left.node, right.node)
    && left.runtime.root === right.runtime.root && left.runtime.fingerprint === right.runtime.fingerprint
    && sameFileSeal(left.runtime.brokerHost, right.runtime.brokerHost)
    && left.managedRuntime.root === right.managedRuntime.root && left.managedRuntime.fingerprint === right.managedRuntime.fingerprint;
}

function sameSourceBinding(left: NativeHistoryActivationSourceBindingV1, right: NativeHistoryActivationSourceBindingV1): boolean {
  return left.generationId === right.generationId && left.receiptDigest === right.receiptDigest
    && left.sourceDigest === right.sourceDigest && left.revision === right.revision;
}

function sameEnvironmentBinding(left: NativeHistoryActivationEnvironmentBindingV1, right: NativeHistoryActivationEnvironmentBindingV1): boolean {
  return left.registryFile === right.registryFile && left.registryRevision === right.registryRevision
    && left.selectionFile === right.selectionFile && left.selectionRevision === right.selectionRevision;
}

function nativeHistorySetupInput(context: NativeHistoryActivationContextV1): NativeHistorySetupInput {
  return {
    legacyRouterRoot: context.roots.legacyRouterRoot,
    sourceCodexRoot: context.roots.sourceCodexRoot,
    sourceSqliteRoot: context.roots.sourceSqliteRoot,
    secondaryCodexRoot: context.roots.secondaryCodexRoot,
    secondarySqliteRoot: context.roots.secondarySqliteRoot,
    globalRoot: context.roots.globalRoot,
    appPaths: [NATIVE_HISTORY_ACTIVATION_CHATGPT_APP, NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP],
  };
}

async function prepareDefaultInjected(
  context: NativeHistoryActivationContextV1,
  beforeApply: () => Promise<void>,
): Promise<NativeHistoryActivationPreparedInjected> {
  verifyNativeHistoryActivationContextCurrent(context);
  const root = context.managerRoot;
  const paths = managerStatusPaths(root);
  const lease = acquireRegisteredOfficialSourceLease(root);
  let coordinator: InstallerEnvironmentCoordinator;
  try {
    if (lease.pointer.generationId !== context.source.generationId || lease.receiptDigest !== context.source.receiptDigest
      || lease.pointer.sourceDigest !== context.source.sourceDigest) {
      throw new Error("Native history activation source lease differs from the sealed operation binding");
    }
    const registry = readEnvironmentProfileRegistry(paths.environmentRegistryFile);
    const current = readEnvironmentSelection(paths.environmentSelectionFile);
    if (registry === null || current === null || current.selectedDesktopPath !== NATIVE_HISTORY_ACTIVATION_CHATGPT_APP
      || current.selectedDesktopBundleId !== "com.openai.codex" || current.releaseProfile !== "stable"
      || current.appExperience !== "chatgpt" || current.migrationState !== "verified") {
      throw new Error("Native history activation requires the exact pristine stable ChatGPT environment");
    }
    const requested = createRequestedEnvironmentSelection(
      registry,
      { releaseProfile: "stable", appExperience: "tweakers" },
      context.approvedAt,
    );
    const runtime = resolveSealedManagerRuntimeAssets();
    const managedRuntime = resolveSealedManagerManagedRuntimeAssets();
    if (runtime === null || managedRuntime === null || runtime.root !== context.manager.runtime.root
      || runtime.fingerprint !== context.manager.runtime.fingerprint || managedRuntime.root !== context.manager.managedRuntime.root
      || managedRuntime.fingerprint !== context.manager.managedRuntime.fingerprint) {
      throw new Error("Native history activation sealed runtime changed after context preparation");
    }
    verifySealedManagerRuntimeAssets(runtime);
    verifySealedManagerManagedRuntimeAssets(managedRuntime);
    const candidateSource = lease.receipt.artifact.appPath;
    if (candidateSource === NATIVE_HISTORY_ACTIVATION_CHATGPT_APP) {
      throw new Error("Native history activation refuses to stage a candidate from live ChatGPT");
    }
    coordinator = new InstallerEnvironmentCoordinator({
      environmentRoot: root,
      transactionFile: paths.environmentTransactionFile,
      receiptRoot: join(root, "transactions", "environment"),
      registryFile: paths.environmentRegistryFile,
      selectionFile: paths.environmentSelectionFile,
      configFile: paths.configFile,
      stateFile: paths.stateFile,
      sealedCandidateSourceApp: candidateSource,
      sealedManagedRuntime: {
        sourceRoot: managedRuntime.root,
        generationId: managedRuntime.fingerprint,
        fingerprint: managedRuntime.fingerprint,
        sourceRuntimeHash: null,
      },
    }, {
      createId: () => context.operationId,
      beforeApplyPreparedEnvironment: beforeApply,
      // Once setup has retained either publication artifact, the environment
      // transaction must persist its failure and leave recovery to this
      // coordinator. Its ordinary automatic rollback can reopen ChatGPT
      // against an ambiguous shared authority.
      deferCommitFailureRecovery: () => registrationArtifactsPresent(context),
    });
    const prepared = await coordinator.prepare({ current, requested });
    if (prepared.transactionId !== context.operationId || prepared.phase !== "prepared") {
      throw new Error("Native history activation did not persist the exact injected candidate receipt");
    }
  } finally {
    lease.release();
  }
  const currentReceipt = (action: "cancel" | "rollback"): EnvironmentTransactionReceipt => {
    const receipt = readEnvironmentTransactionReceipt(paths.environmentTransactionFile);
    if (receipt === null || receipt.transactionId !== context.operationId) {
      throw new Error(`Native history activation environment ${action} lost its operation-bound receipt`);
    }
    return receipt;
  };
  const requirePersistedPhase = (
    action: "cancel" | "rollback",
    phase: "cancelled" | "rolled-back",
  ): void => {
    const receipt = currentReceipt(action);
    if (receipt.phase !== phase) {
      throw new Error(`Native history activation environment ${action} did not persist ${phase}`);
    }
  };
  const rollback = async (): Promise<void> => {
    const before = currentReceipt("rollback");
    if (before.phase === "rolled-back") return;
    if (before.phase === "cancelled") {
      throw new Error("Native history activation environment was cancelled instead of rolled back");
    }
    const rolledBack = await coordinator.rollback(context.operationId);
    if (rolledBack.transactionId !== context.operationId || rolledBack.phase !== "rolled-back") {
      throw new Error("Native history activation environment rollback did not return a rolled-back receipt");
    }
    requirePersistedPhase("rollback", "rolled-back");
  };
  return {
    commit: () => coordinator.commit(context.operationId, context.approvedAt),
    cancel: async () => {
      const before = currentReceipt("cancel");
      // A prior rollback has already restored the injected environment. A
      // prior cancellation never started cutover. Both are deliberately
      // terminal rather than being sent back through cancel(), which rejects
      // terminal receipts.
      if (before.phase === "rolled-back" || before.phase === "cancelled") return;
      if (before.phase !== "preparing" && before.phase !== "prepared") {
        throw new Error(`Native history activation environment cannot cancel from ${before.phase}`);
      }
      const cancelled = await coordinator.cancel(context.operationId);
      if (cancelled.transactionId !== context.operationId || cancelled.phase !== "cancelled") {
        throw new Error("Native history activation environment cancel did not return a cancelled receipt");
      }
      requirePersistedPhase("cancel", "cancelled");
    },
    restoreBeforeRegistration: async () => {
      const before = currentReceipt("rollback");
      if (before.phase === "cancelled") {
        if (!nativeHistoryActivationCancelledBeforeApply(before, context.operationId)
          || registrationArtifactsPresent(context)
          || !sameEnvironmentBinding(readCurrentEnvironmentBinding(context.managerRoot), context.environment)
          || before.source.selectedDesktopPath !== context.apps.chatgpt
          || fingerprintAppContents(context.apps.chatgpt) !== before.prepared!.rollback.desktopArtifactDigest) {
          throw new Error("Native history activation cancelled environment lacks unchanged source and pre-publication proof");
        }
        return;
      }
      await rollback();
    },
    rollback,
  };
}

/** Receipt eligibility only; the production adapter also proves unchanged source bytes and absent registration. */
export function nativeHistoryActivationCancelledBeforeApply(receipt: EnvironmentTransactionReceipt, operationId: string): boolean {
  return receipt.transactionId === operationId && receipt.phase === "cancelled" && receipt.attempt === 0
    && receipt.prepared !== null && receipt.applied === null && receipt.newMainPid === null
    && receipt.committedAt === null && receipt.rolledBackAt === null
    && !(receipt.applyProgress ?? "").startsWith("rollback:");
}

async function prepareDefaultIndependent(
  context: NativeHistoryActivationContextV1,
  beforePromotion: () => Promise<void>,
  capturePreviousTweakers: (previous: NativeHistoryActivationAppProcessIdentity | null) => void,
): Promise<NativeHistoryActivationPreparedIndependent> {
  let previous: NativeHistoryActivationAppProcessIdentity | null = null;
  const deferred = await prepareDeferredTweakersVariantRefresh({
    app: NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP,
    userRoot: context.tweakers.userRoot,
    runtimeReadyOperationId: context.operationId,
  }, {
    environmentAuthoritySourceRoot: () => context.managerRoot,
    registeredOfficialSourceAuthorityRoot: () => context.managerRoot,
    registeredOfficialSourceBinding: () => ({
      generationId: context.source.generationId,
      receiptDigest: context.source.receiptDigest,
    }),
    beforePromotion: async ({ target, userRoot }) => {
      if (target !== NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP || userRoot !== context.tweakers.userRoot) {
        throw new Error("Native history activation independent candidate is not bound to the exact Tweakers target");
      }
      const observed = observeCodexMainProcess(NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP);
      previous = observed === null ? null : appProcessIdentity(observed, "Native history activation Tweakers process");
      // Candidate construction can reject after quiescence. Capture the exact
      // pre-existing app before that point so rollback never guesses whether
      // reopening it would be safe.
      capturePreviousTweakers(previous);
      await quiesceExactApp(NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP, observed);
      await beforePromotion();
    },
  });
  return { deferred, previousTweakers: previous };
}

function appProcessIdentity(
  observed: CodexMainProcessObservation,
  label: string,
): NativeHistoryActivationAppProcessIdentity {
  if (!positiveInteger(observed.pid) || typeof observed.startedAtRaw !== "string" || observed.startedAtRaw.length === 0) {
    throw new Error(`${label} lacks an exact PID/start-token identity`);
  }
  return { pid: observed.pid, processStartToken: observed.startedAtRaw };
}

export interface NativeHistoryActivationAppQuiescenceDependencies {
  processes?: () => ProcessInfo[];
  report?: (processes: ProcessInfo[]) => OpenReport;
  observeMain?: () => CodexMainProcessObservation | null;
  quitMain?: (pid: number) => void;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  delay?: (milliseconds: number) => Promise<void>;
}

/** Internal process-control helper, never exposed as a manager command. */
export async function quiesceExactApp(
  app: string,
  observed = observeCodexMainProcess(app),
  dependencies: NativeHistoryActivationAppQuiescenceDependencies = {},
): Promise<void> {
  const processes = dependencies.processes ?? listProcesses;
  const report = dependencies.report ?? ((snapshot) => getOpenReport(locateCodexAtExactPath(app), snapshot));
  const observeMain = dependencies.observeMain ?? (() => observeCodexMainProcess(app));
  const snapshot = processes();
  const open = report(snapshot);
  if (open.hasMainProcess && (observed === null || open.pid !== observed.pid || open.openedAtRaw !== observed.startedAtRaw)) {
    throw new Error(`Native history activation ${app} main process changed before helper shutdown`);
  }
  const mainPid = observed?.pid ?? null;
  const related = open.relatedPids.filter((pid) => pid !== mainPid);
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const helpers = related.map((pid) => byPid.get(pid)).filter((entry): entry is ProcessInfo => entry !== undefined);
  if (helpers.length !== related.length || helpers.some((entry) => !entry.startedAtRaw)) {
    throw new Error(`Native history activation cannot prove every exact ${app} helper identity`);
  }
  if (observed !== null) {
    (dependencies.quitMain ?? ((pid) => quitCodexMainProcess(app, pid)))(observed.pid);
    if (observeMain() !== null) throw new Error(`Native history activation did not quiesce the exact ${app} main process`);
  }
  const sameProcess = (entry: ProcessInfo, current: readonly ProcessInfo[]): boolean => current.some((candidate) => candidate.pid === entry.pid
    && candidate.startedAtRaw === entry.startedAtRaw && candidate.command === entry.command);
  const remaining = (): ProcessInfo[] => {
    const current = processes();
    return helpers.filter((entry) => sameProcess(entry, current));
  };
  const signal = (entries: readonly ProcessInfo[], signalName: NodeJS.Signals): void => {
    const current = processes();
    for (const entry of entries) {
      if (!sameProcess(entry, current)) continue;
      try {
        (dependencies.signal ?? ((pid, signal) => { process.kill(pid, signal); }))(entry.pid, signalName);
      } catch (error) {
        // A captured helper may exit after the last identity observation.
        // Only kernel-proven absence is benign; the final census still runs.
        if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
      }
    }
  };
  const waitForExit = async (milliseconds: number): Promise<ProcessInfo[]> => {
    const deadline = Date.now() + milliseconds;
    let value = remaining();
    while (value.length > 0 && Date.now() < deadline) {
      await (dependencies.delay ?? sleep)(100);
      value = remaining();
    }
    return value;
  };
  signal(remaining(), "SIGTERM");
  let stillRunning = await waitForExit(2_000);
  signal(stillRunning, "SIGKILL");
  stillRunning = await waitForExit(1_000);
  if (stillRunning.length > 0 || report(processes()).relatedPids.length > 0) {
    throw new Error(`Native history activation could not prove exact ${app} helper quiescence`);
  }
}

async function defaultReopenAndProveIndependent(
  context: NativeHistoryActivationContextV1,
  prepared: NativeHistoryActivationPreparedIndependent,
): Promise<void> {
  openAndActivateCodex(NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP);
  const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = observeCodexMainProcess(NATIVE_HISTORY_ACTIVATION_TWEAKERS_APP);
    if (observed !== null && (prepared.previousTweakers === null
      || observed.pid !== prepared.previousTweakers.pid || observed.startedAtRaw !== prepared.previousTweakers.processStartToken)
      && typeof observed.startedAtRaw === "string" && observed.startedAtRaw.length > 0) {
      const receipt = readIndependentTweakersRuntimeReadyReceipt(prepared.deferred.userRoot);
      if (receipt !== null) {
        prepared.deferred.verifyRuntimeReady(receipt, observed.pid, observed.startedAtRaw);
        const authority = readIndependentTweakersBrokerAuthorityExpectation(context.roots.globalRoot);
        if (authority.globalRootState !== "valid-v3") {
          throw new Error("Native history activation independent runtime is not bound to a valid global broker authority");
        }
        return;
      }
    }
    await sleep(RUNTIME_READY_POLL_MS);
  }
  throw new Error("Native history activation independent Tweakers runtime-ready proof timed out");
}

function defaultFinalWriterCensus(context: NativeHistoryActivationContextV1): boolean {
  if (registrationArtifactsPresent(context)) return false;
  let obstruction = "census unavailable";
  const idle = nativeHistorySetupIdle([
    ...(context.activationScope === "tweakers-only" ? [] : [context.roots.sourceCodexRoot, context.roots.sourceSqliteRoot]),
    context.roots.secondaryCodexRoot,
    context.roots.secondarySqliteRoot,
  ], context.activationScope === "tweakers-only" ? [context.apps.tweakers] : [context.apps.chatgpt, context.apps.tweakers], {
    onBlocked: ({ reason, pids }) => { obstruction = `${reason}; PIDs ${pids.join(",") || "none"}`; },
  });
  if (!idle) throw new Error(`Native history activation final writer census was not idle: ${obstruction}`);
  return true;
}

// Structural ports keep the installer independent of runtime source compilation.
interface OfflinePreparationResult { state: string; reason?: string }
function offlinePreparationError(message: string, result: OfflinePreparationResult): Error {
  return new Error(message, { cause: new Error(result.reason ?? result.state) });
}
interface OfflineAccount { opaqueAccountId: string; codexHome: string; sqliteHome: string; codexHomeIdentity: { device: number; inode: number } }
interface OfflineBinding { accounts: OfflineAccount[]; source: { metadataAccountId: string } }
interface OfflineHistoryPort {
  readAndPreflightNativeHistorySourceStaticV1(root: string, config: object, secret: Buffer):
    { state: "ready"; binding: OfflineBinding } | { state: "invalid" | "absent" };
  nativeHistoryBindingSafeV1(binding: OfflineBinding): boolean;
}
interface OfflineTransferPort {
  NativeTransferCoordinatorV1: new (options: { stateRoot: string; accounts: { accountId: string; codexHome: string; sqliteHome: string }[];
    primaryAccountId: string; db: object; capabilityProbe: () => Promise<OfflinePreparationResult>;
    bindingPreflight: () => boolean; writerCensus: () => boolean }) => {
      probeCapability(): Promise<OfflinePreparationResult>;
      provisionSharedWriterLocks(): OfflinePreparationResult;
      convertOfflineWriterLockDirectory(id: string, options: { offlinePreflight: () => boolean }): OfflinePreparationResult;
      convertIdleSecondaryWriterLockDirectory(id: string, options: { offlinePreflight: () => boolean }): OfflinePreparationResult;
      preflightSharedWriterLocks(): OfflinePreparationResult;
      reconcileCatalog(options: { project: false }): Promise<OfflinePreparationResult>;
    };
  Sqlite3NativeCatalogDbV1: new () => object;
  probeNativeTransferCapabilityV1(options: { command: string; args: string[] }): Promise<OfflinePreparationResult>;
}
interface OfflineContinuityPort {
  DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: object;
  loadSharedAccountBase(stateRoot: string): object | null;
  loadSharedPluginsManifestV1(stateRoot: string): object | null;
  rebaseAccountContinuitySharedSource(input: { stateRoot: string; primaryOpaqueAccountId: string; sharedSourceOpaqueAccountId: string;
    accounts: { opaqueAccountId: string; codexHome: string }[]; schema: object; priorShared: object; priorPlugins: object;
    accountWriteEvidence: Record<string, { accountChildAbsent: true; nativeWriterCensus: () => "zero" | "running" }>;
    apply: true }): OfflinePreparationResult & { shared?: object; plugins?: object };
  bootstrapAccountContinuity(input: { stateRoot: string; primaryOpaqueAccountId: string; sharedSourceOpaqueAccountId?: string;
    accounts: { opaqueAccountId: string; codexHome: string }[]; schema: object; apply: true }): OfflinePreparationResult & { shared?: object; plugins?: object };
  prepareAccountConfigBeforeSpawn(input: { stateRoot: string; account: { opaqueAccountId: string; codexHome: string };
    shared: object; plugins: object; schema: object; apply: true;
    writeEvidence: { accountChildAbsent: true; nativeWriterCensus: () => "zero" | "running" } }): OfflinePreparationResult;
  observeExistingNativeAccountContinuity(input: { stateRoot: string; account: { opaqueAccountId: string; codexHome: string };
    shared: object; plugins: object; schema: object; apply: true;
    nativeHomeIdentity: { device: number; inode: number }; nativeBindingPreflight: () => boolean }): OfflinePreparationResult;
  captureUnmaterializedNativeChangesBeforeSpawn(input: { stateRoot: string; account: { opaqueAccountId: string; codexHome: string };
    shared: object; plugins: object; schema: object; apply: true;
    nativeHomeIdentity: { device: number; inode: number }; nativeBindingPreflight: () => boolean;
    writeEvidence: { accountChildAbsent: true; nativeWriterCensus: () => "zero" | "running" } }): OfflinePreparationResult;
}

/** Final activation: native-home writes are limited to independently idle accounts. */
async function defaultPrepareOfflineAccountContinuity(context: NativeHistoryActivationContextV1): Promise<void> {
  verifyCurrentSealedBrokerRuntime(context);
  const runtimeRequire = createRequire(import.meta.url);
  const history = runtimeRequire(join(context.manager.runtime.root, "account-router/native-history.js")) as OfflineHistoryPort;
  const transfer = runtimeRequire(join(context.manager.runtime.root, "account-router/native-transfer.js")) as OfflineTransferPort;
  const continuity = runtimeRequire(join(context.manager.runtime.root, "account-router/account-continuity.js")) as OfflineContinuityPort;
  const stateRoot = context.roots.globalRoot;
  const secret = readPrivateBytes(join(stateRoot, REGISTRATION_SECRET_FILE), REGISTRATION_SECRET_BYTES, "Account continuity registration secret");
  try {
    const config = JSON.parse(readPrivateBytes(join(stateRoot, REGISTRATION_CONFIG_FILE), REGISTRATION_JSON_MAX_BYTES, "Account continuity config").toString("utf8"));
    const preflight = history.readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
    if (preflight.state !== "ready") throw new Error("Offline account continuity source preflight failed");
    const binding = preflight.binding;
    let obstruction = "census unavailable";
    const globalIdle = () => nativeHistorySetupIdle([context.roots.sourceCodexRoot, context.roots.sourceSqliteRoot,
      context.roots.secondaryCodexRoot, context.roots.secondarySqliteRoot], [context.apps.chatgpt, context.apps.tweakers], {
      onBlocked: ({ reason, pids }) => { obstruction = `${reason}; PIDs ${pids.join(",") || "none"}`; },
    });
    const accountIdle = (account: OfflineAccount) => nativeHistorySetupIdle([account.codexHome, account.sqliteHome],
      [account.opaqueAccountId === binding.source.metadataAccountId ? context.apps.chatgpt : context.apps.tweakers], {
        onBlocked: ({ reason, pids }) => { obstruction = `${reason}; PIDs ${pids.join(",") || "none"}`; },
      });
    const concurrent = context.activationScope === "tweakers-only";
    const idle = concurrent ? () => binding.accounts.filter((account) => account.opaqueAccountId !== binding.source.metadataAccountId).every(accountIdle) : globalIdle;
    if (!idle() || !idle()) throw new Error(`Offline account continuity requires idle apps: ${obstruction}`);
    const coordinator = new transfer.NativeTransferCoordinatorV1({
      stateRoot, accounts: binding.accounts.map((account) => ({ accountId: account.opaqueAccountId, codexHome: account.codexHome, sqliteHome: account.sqliteHome })),
      primaryAccountId: binding.source.metadataAccountId, db: new transfer.Sqlite3NativeCatalogDbV1(),
      capabilityProbe: async () => {
        const lease = acquireRegisteredOfficialSourceLease(context.managerRoot);
        try {
          if (lease.pointer.generationId !== context.source.generationId || lease.receiptDigest !== context.source.receiptDigest
            || lease.pointer.sourceDigest !== context.source.sourceDigest) throw new Error("Native transfer probe source changed");
          return await transfer.probeNativeTransferCapabilityV1({ command: join(lease.receipt.artifact.appPath, "Contents/Resources/codex"), args: ["app-server"] });
        } finally { lease.release(); }
      },
      bindingPreflight: () => history.nativeHistoryBindingSafeV1(binding), writerCensus: globalIdle,
    });
    const capability = await coordinator.probeCapability();
    if (capability.state !== "ready") throw offlinePreparationError("Native thread transfer capability could not be verified", capability);
    if (!concurrent) coordinator.provisionSharedWriterLocks();
    for (const account of binding.accounts) {
      if (account.opaqueAccountId === binding.source.metadataAccountId) continue;
      const locks = join(account.codexHome, "thread-writer-locks");
      if (concurrent) {
        const converted = coordinator.convertIdleSecondaryWriterLockDirectory(account.opaqueAccountId, { offlinePreflight: () => accountIdle(account) });
        if (converted.state !== "ready") throw offlinePreparationError("Native secondary writer locks could not be prepared without changing the primary", converted);
      } else if (existsSync(locks) && lstatSync(locks).isDirectory()) coordinator.convertOfflineWriterLockDirectory(account.opaqueAccountId, { offlinePreflight: idle });
    }
    const sharedLocks = concurrent ? coordinator.preflightSharedWriterLocks() : coordinator.provisionSharedWriterLocks();
    if (sharedLocks.state !== "ready") throw offlinePreparationError("Native thread writer locks could not be prepared", sharedLocks);
    const inventory = await coordinator.reconcileCatalog({ project: false });
    if (inventory.state !== "ready") throw offlinePreparationError("Native thread inventory could not be prepared", inventory);
    if (!idle() || !idle()) throw new Error(`Account continuity lost its offline window: ${obstruction}`);
    const accounts = binding.accounts.map((account) => ({ opaqueAccountId: account.opaqueAccountId, codexHome: account.codexHome }));
    const priorShared = continuity.loadSharedAccountBase(stateRoot);
    const priorPlugins = continuity.loadSharedPluginsManifestV1(stateRoot);
    if ((priorShared === null) !== (priorPlugins === null)) throw new Error("Existing account continuity is incomplete");
    const continuityInput = { stateRoot, primaryOpaqueAccountId: config.primaryOpaqueAccountId,
      sharedSourceOpaqueAccountId: binding.source.metadataAccountId,
      accounts, schema: continuity.DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true as const };
    const bootstrapped = priorShared && priorPlugins
      ? continuity.rebaseAccountContinuitySharedSource({ ...continuityInput, priorShared, priorPlugins,
        accountWriteEvidence: Object.fromEntries(binding.accounts.map((account) => [account.opaqueAccountId, {
          accountChildAbsent: true as const, nativeWriterCensus: () => accountIdle(account) ? "zero" as const : "running" as const,
        }])) })
      : continuity.bootstrapAccountContinuity(continuityInput);
    if (bootstrapped.state !== "ready" || !bootstrapped.shared || !bootstrapped.plugins) throw offlinePreparationError("Account continuity bootstrap failed", bootstrapped);
    for (const account of accounts) {
      const native = binding.accounts.find((candidate) => candidate.opaqueAccountId === account.opaqueAccountId)!;
      if (concurrent && !accountIdle(native)) {
        const observed = continuity.observeExistingNativeAccountContinuity({ stateRoot, account, shared: bootstrapped.shared,
          plugins: bootstrapped.plugins, schema: continuity.DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
          nativeHomeIdentity: native.codexHomeIdentity, nativeBindingPreflight: () => history.nativeHistoryBindingSafeV1(binding) });
        if (observed.state !== "ready" && observed.state !== "would_write") throw offlinePreparationError("Existing native account continuity could not be verified", observed);
        continue;
      }
      if (concurrent && !existsSync(join(stateRoot, "accounts", account.opaqueAccountId, "config-materialization.v1.json"))) {
        const captured = continuity.captureUnmaterializedNativeChangesBeforeSpawn({ stateRoot, account, shared: bootstrapped.shared,
          plugins: bootstrapped.plugins, schema: continuity.DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
          nativeHomeIdentity: native.codexHomeIdentity, nativeBindingPreflight: () => history.nativeHistoryBindingSafeV1(binding),
          writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => accountIdle(native) ? "zero" : "running" } });
        if (captured.state === "blocked") throw offlinePreparationError("Account continuity changes could not be captured before first materialization", captured);
      }
      const prepared = continuity.prepareAccountConfigBeforeSpawn({ stateRoot, account, shared: bootstrapped.shared,
        plugins: bootstrapped.plugins, schema: continuity.DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
        writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => accountIdle(native) ? "zero" : "running" } });
      if (prepared.state !== "ready") throw offlinePreparationError("Account continuity materialization failed", prepared);
    }
    const layout = portableDesktopLayout();
    if (layout.nativeThreadInventoryStateRoot !== stateRoot) throw new Error("Desktop continuity root binding changed");
    if (!existsSync(layout.continuityRoot)) mkdirSync(layout.continuityRoot, { mode: 0o700 });
    const handoff = runPortableDesktopHandoff({ target: "tweakers" });
    if (handoff.status !== "applied" && handoff.status !== "already-applied" && !(concurrent && handoff.status === "postponed")) throw new Error(`Offline desktop handoff requires attention: ${handoff.status}`);
  } finally { secret.fill(0); }
}

function defaultApplyNativeHistory(context: NativeHistoryActivationContextV1): NativeHistoryActivationRegistrationReceiptV1 {
  const result = setupNativeHistory({ ...nativeHistorySetupInput(context), apply: true }, {
    now: () => context.registration.issuedAt,
  });
  if (result.state !== "registered" || result.registrationFingerprint !== context.registration.registrationFingerprint) {
    throw new Error("Native history activation setup did not return its sealed registration fingerprint");
  }
  const registration = defaultInspectPublishedRegistration(context);
  if (registration === null) throw new Error("Native history activation setup did not publish its registration artifacts");
  return registration;
}

/**
 * This is deliberately a no-follow presence check. A dangling link, unreadable
 * entry, or another lookup failure is retained evidence, never a clean absent
 * publication window.
 */
function noFollowPathState(path: string): "absent" | "present" {
  try {
    lstatSync(path);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "present";
  }
}

function registrationArtifactsPresent(context: NativeHistoryActivationContextV1): boolean {
  return noFollowPathState(context.roots.globalRoot) === "present"
    || noFollowPathState(reservationPath(context.roots.globalRoot)) === "present";
}

function brokerSocketPath(context: NativeHistoryActivationContextV1): string {
  return routerControlSocketPath(context.roots.globalRoot, BROKER_SOCKET_FILE);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function registrationConfigFingerprint(config: Record<string, unknown>): string {
  const accounts = config.accounts;
  if (!Array.isArray(accounts)) throw new Error("Native history activation registration config accounts are invalid");
  return `sha256:${createHash("sha256").update(canonicalJson({
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: accounts.map((account) => {
      if (!isRecord(account)) throw new Error("Native history activation registration account is invalid");
      return {
        opaqueAccountId: account.opaqueAccountId,
        included: account.included,
        weight: account.weight,
        capabilityFingerprint: account.capabilityFingerprint,
        label: account.label,
      };
    }),
  })).digest("hex")}`;
}

function assertRegistrationConfiguration(
  config: unknown,
  context: NativeHistoryActivationContextV1,
): asserts config is Record<string, unknown> {
  if (!isRecord(config) || !hasExactKeys(config, [
    "accounts", "fingerprint", "generation", "mode", "policy", "primaryOpaqueAccountId", "protocolFingerprint", "schemaVersion", "updatedAt",
  ]) || config.schemaVersion !== 3 || config.mode !== "quota_aware" || config.policy !== "quota_aware_v2"
    || !positiveInteger(config.generation) || typeof config.protocolFingerprint !== "string" || !SHA256_FINGERPRINT.test(config.protocolFingerprint)
    || typeof config.primaryOpaqueAccountId !== "string" || !/^ar_[A-Za-z0-9_-]{43}$/.test(config.primaryOpaqueAccountId)
    || typeof config.updatedAt !== "string" || canonicalTimestamp(config.updatedAt, "Native history activation registration config timestamp") !== context.registration.issuedAt
    || typeof config.fingerprint !== "string" || !SHA256_FINGERPRINT.test(config.fingerprint)
    || !Array.isArray(config.accounts) || config.accounts.length !== 2) {
    throw new Error("Native history activation registration config is invalid");
  }
  const accountIds = new Set<string>();
  for (const account of config.accounts) {
    const weight = isRecord(account) ? account.weight : undefined;
    if (!isRecord(account) || !hasExactKeys(account, ["capabilityFingerprint", "included", "label", "opaqueAccountId", "weight"])
      || typeof account.opaqueAccountId !== "string" || !/^ar_[A-Za-z0-9_-]{43}$/.test(account.opaqueAccountId)
      || account.included !== true || typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 1 || weight > 100
      || typeof account.capabilityFingerprint !== "string" || !SHA256_FINGERPRINT.test(account.capabilityFingerprint)
      || typeof account.label !== "string" || account.label.length === 0 || account.label.length > 80
      || /[\u0000-\u001f\u007f@/\\]/.test(account.label) || accountIds.has(account.opaqueAccountId)) {
      throw new Error("Native history activation registration account is invalid");
    }
    accountIds.add(account.opaqueAccountId);
  }
  if (!accountIds.has(config.primaryOpaqueAccountId)
    || !timingSafeStringEqual(config.fingerprint, registrationConfigFingerprint(config))) {
    throw new Error("Native history activation registration config fingerprint is invalid");
  }
}

function assertRegistrationSource(
  source: unknown,
  config: Record<string, unknown>,
  secret: Buffer,
  context: NativeHistoryActivationContextV1,
): asserts source is Record<string, unknown> {
  if (!isRecord(source) || !hasExactKeys(source, [
    "accountSetFingerprint", "accounts", "issuedAt", "kind", "metadataAccountId", "mode", "protocolFingerprint", "signature", "version",
  ]) || source.version !== 1 || source.kind !== "account-router-native-history-source" || source.mode !== "in_place"
    || source.protocolFingerprint !== config.protocolFingerprint || typeof source.accountSetFingerprint !== "string"
    || !SHA256_FINGERPRINT.test(source.accountSetFingerprint) || typeof source.metadataAccountId !== "string"
    || typeof source.issuedAt !== "string" || canonicalTimestamp(source.issuedAt, "Native history activation registration source timestamp") !== context.registration.issuedAt
    || typeof source.signature !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(source.signature)
    || !Array.isArray(source.accounts) || !Array.isArray(config.accounts) || source.accounts.length !== config.accounts.length) {
    throw new Error("Native history activation registration source is invalid");
  }
  const configIds = new Set(config.accounts.map((account) => isRecord(account) ? account.opaqueAccountId : ""));
  const sourceIds: string[] = [];
  for (const account of source.accounts) {
    if (!isRecord(account) || !hasExactKeys(account, [
      "authIdentityHmac", "codexHome", "codexHomeIdentity", "opaqueAccountId", "sqliteHome", "sqliteHomeIdentity",
    ]) || typeof account.opaqueAccountId !== "string" || !configIds.has(account.opaqueAccountId)
      || typeof account.codexHome !== "string" || !isAbsolute(account.codexHome) || resolve(account.codexHome) !== account.codexHome
      || typeof account.sqliteHome !== "string" || !isAbsolute(account.sqliteHome) || resolve(account.sqliteHome) !== account.sqliteHome
      || typeof account.authIdentityHmac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(account.authIdentityHmac)
      || sourceIds.includes(account.opaqueAccountId)) {
      throw new Error("Native history activation registration source account is invalid");
    }
    assertDirectoryIdentity(account.codexHomeIdentity, "Native history activation registration source Codex identity");
    assertDirectoryIdentity(account.sqliteHomeIdentity, "Native history activation registration source SQLite identity");
    sourceIds.push(account.opaqueAccountId);
  }
  if (!configIds.has(source.metadataAccountId) || sourceIds.length !== configIds.size
    || sourceIds.some((id) => !configIds.has(id))) {
    throw new Error("Native history activation registration source accounts differ from config");
  }
  const expectedSetFingerprint = `sha256:${createHash("sha256")
    .update(canonicalJson([...sourceIds].sort()), "utf8").digest("hex")}`;
  if (!timingSafeStringEqual(source.accountSetFingerprint, expectedSetFingerprint)) {
    throw new Error("Native history activation registration source account set fingerprint is invalid");
  }
  const { signature, ...unsigned } = source;
  const expectedSignature = `hmac-sha256:${createHmac("sha256", secret)
    .update(`account-router:native-history-source:v1\0${canonicalJson(unsigned)}`, "utf8").digest("hex")}`;
  if (!timingSafeStringEqual(signature, expectedSignature)) {
    throw new Error("Native history activation registration source signature is invalid");
  }
}

function assertRegistrationMarker(value: unknown, context: NativeHistoryActivationContextV1): void {
  if (!isRecord(value) || !hasExactKeys(value, ["createdAt", "mode", "registrationFingerprint", "version"])
    || value.version !== 1 || value.mode !== "in_place" || value.registrationFingerprint !== context.registration.registrationFingerprint
    || value.createdAt !== context.registration.issuedAt
    || canonicalTimestamp(String(value.createdAt), "Native history activation registration marker timestamp") !== context.registration.issuedAt) {
    throw new Error("Native history activation registration marker is invalid");
  }
}

function assertBootstrapCanonicalHistory(value: unknown, requireEmpty: boolean): void {
  if (!isRecord(value) || !hasExactKeys(value, ["conversations", "version"])
    || value.version !== 1 || !Array.isArray(value.conversations)
    || (requireEmpty && value.conversations.length !== 0)) {
    throw new Error("Native history activation canonical history bootstrap is invalid");
  }
}

function inspectPublishedRegistration(
  context: NativeHistoryActivationContextV1,
  options: {
    runtimeActive: boolean;
    expectedRegistration?: NativeHistoryActivationRegistrationReceiptV1;
  },
): NativeHistoryActivationRegistrationReceiptV1 | null {
  const root = context.roots.globalRoot;
  const reservation = reservationPath(root);
  const rootState = noFollowPathState(root);
  const reservationState = noFollowPathState(reservation);
  if (rootState === "absent" && reservationState === "absent") return null;
  if (rootState !== "present" || reservationState !== "present") {
    throw new Error("Native history activation registration is only partially published");
  }
  assertPrivateDirectory(root, "Native history activation registration root");
  assertPrivateDirectory(reservation, "Native history activation registration reservation");
  const globalRoot = directoryIdentity(root, "Native history activation registration root");
  const reservationIdentity = directoryIdentity(reservation, "Native history activation registration reservation");
  if (options.expectedRegistration !== undefined
    && (!sameDirectoryIdentity(globalRoot, options.expectedRegistration.globalRoot)
      || !sameDirectoryIdentity(reservationIdentity, options.expectedRegistration.reservation))) {
    throw new Error("Native history activation registration identity changed after publication");
  }
  if (!options.runtimeActive) {
    const entries = readdirSync(root).sort();
    if (!sameStringArray(entries, [...REGISTRATION_BOOTSTRAP_FILES].sort())) {
      throw new Error("Native history activation registration bootstrap files are not exact");
    }
  }

  let secret: Buffer | null = null;
  let legacySecret: Buffer | null = null;
  let configBytes: Buffer | null = null;
  let sourceBytes: Buffer | null = null;
  let canonicalHistoryBytes: Buffer | null = null;
  let markerBytes: Buffer | null = null;
  try {
    secret = readPrivateBytes(join(root, REGISTRATION_SECRET_FILE), REGISTRATION_SECRET_BYTES, "Native history activation registration secret");
    legacySecret = readPrivateBytes(join(context.roots.legacyRouterRoot, REGISTRATION_SECRET_FILE), REGISTRATION_SECRET_BYTES, "Native history activation legacy registration secret");
    if (secret.byteLength !== REGISTRATION_SECRET_BYTES || legacySecret.byteLength !== REGISTRATION_SECRET_BYTES
      || !timingSafeEqual(secret, legacySecret)) {
      throw new Error("Native history activation registration secret differs from the sealed legacy authority");
    }
    configBytes = readPrivateBytes(join(root, REGISTRATION_CONFIG_FILE), REGISTRATION_JSON_MAX_BYTES, "Native history activation registration config");
    sourceBytes = readPrivateBytes(join(root, REGISTRATION_SOURCE_FILE), REGISTRATION_JSON_MAX_BYTES, "Native history activation registration source");
    canonicalHistoryBytes = readPrivateBytes(join(root, REGISTRATION_CANONICAL_HISTORY_FILE), REGISTRATION_JSON_MAX_BYTES, "Native history activation canonical history");
    markerBytes = readPrivateBytes(join(root, REGISTRATION_MARKER_FILE), REGISTRATION_JSON_MAX_BYTES, "Native history activation registration marker");
    const config = JSON.parse(configBytes.toString("utf8")) as unknown;
    const source = JSON.parse(sourceBytes.toString("utf8")) as unknown;
    const canonicalHistory = JSON.parse(canonicalHistoryBytes.toString("utf8")) as unknown;
    const marker = JSON.parse(markerBytes.toString("utf8")) as unknown;
    assertRegistrationConfiguration(config, context);
    assertRegistrationSource(source, config, secret, context);
    assertRegistrationMarker(marker, context);
    assertBootstrapCanonicalHistory(canonicalHistory, !options.runtimeActive);
    const fingerprint = `sha256:${createHash("sha256").update(canonicalJson({ config, source }), "utf8").digest("hex")}`;
    if (!timingSafeStringEqual(fingerprint, context.registration.registrationFingerprint)) {
      throw new Error("Native history activation registration fingerprint differs from the sealed preview");
    }
    if (options.runtimeActive && preflightCanonicalHistoryStore(root).state !== "ready") {
      throw new Error("Native history activation runtime canonical history is invalid");
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Native history activation registration inspection failed");
  } finally {
    secret?.fill(0);
    legacySecret?.fill(0);
    configBytes?.fill(0);
    sourceBytes?.fill(0);
    canonicalHistoryBytes?.fill(0);
    markerBytes?.fill(0);
  }
  return {
    registrationFingerprint: context.registration.registrationFingerprint,
    globalRoot,
    reservation: reservationIdentity,
  };
}

function defaultInspectPublishedRegistration(
  context: NativeHistoryActivationContextV1,
): NativeHistoryActivationRegistrationReceiptV1 | null {
  return inspectPublishedRegistration(context, { runtimeActive: false });
}

function defaultPostPublicationWriterCensus(context: NativeHistoryActivationContextV1): boolean {
  // A socket artifact is never treated as an absent listener: it can be a
  // live owner, a stale endpoint, a link, or an unreadable collision.
  if (noFollowPathState(brokerSocketPath(context)) !== "absent") return false;
  return nativeHistorySetupIdle([
    ...(context.activationScope === "tweakers-only" ? [context.roots.globalRoot] : [context.roots.sourceCodexRoot, context.roots.sourceSqliteRoot]),
    context.roots.secondaryCodexRoot,
    context.roots.secondarySqliteRoot,
  ], context.activationScope === "tweakers-only" ? [context.apps.tweakers] : [context.apps.chatgpt, context.apps.tweakers]);
}

function assertPrivateBrokerSocket(path: string): void {
  const socket = lstatSync(path);
  const parent = lstatSync(dirname(path));
  const uid = process.getuid?.();
  if (!socket.isSocket() || socket.isSymbolicLink() || (uid !== undefined && socket.uid !== uid)
    || (socket.mode & 0o077) !== 0 || !parent.isDirectory() || parent.isSymbolicLink()
    || (uid !== undefined && parent.uid !== uid) || (parent.mode & 0o077) !== 0) {
    throw new Error("Native history activation broker socket is not owner-private");
  }
}

function validProcessObservation(value: unknown): value is NativeHistoryActivationProcessObservation {
  return isRecord(value) && hasExactKeys(value, ["command", "pid", "ppid", "processStartToken"])
    && positiveInteger(value.pid) && (value.ppid === null || value.ppid === 0 || positiveInteger(value.ppid))
    && typeof value.processStartToken === "string" && value.processStartToken.length > 0 && value.processStartToken.length <= 256
    && typeof value.command === "string" && value.command.length > 0 && value.command.length <= 16 * 1024;
}

function currentBrokerProcessObservations(
  dependencies: NativeHistoryActivationBrokerObservationDependencies,
): NativeHistoryActivationProcessObservation[] {
  const observed = dependencies.processes?.() ?? listProcesses().map((process) => ({
    pid: process.pid,
    ppid: process.ppid,
    processStartToken: process.startedAtRaw ?? "",
    command: process.command,
  }));
  if (!Array.isArray(observed) || observed.length === 0 || !observed.every(validProcessObservation)
    || new Set(observed.map((process) => process.pid)).size !== observed.length) {
    throw new Error("Native history activation broker process census is unavailable");
  }
  return [...observed];
}

function defaultSocketOwnerPids(socketPath: string): readonly number[] {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-t", "--", socketPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string"
    || (typeof result.stderr === "string" && result.stderr.trim().length > 0)) {
    throw new Error("Native history activation could not prove broker socket ownership");
  }
  const pids = result.stdout.split("\n").filter((line) => line.length > 0).map((line) => Number(line));
  if (pids.some((pid) => !positiveInteger(pid)) || new Set(pids).size !== pids.length) {
    throw new Error("Native history activation broker socket ownership output is invalid");
  }
  return pids;
}

function defaultParticipatingAppPids(context: NativeHistoryActivationContextV1): readonly number[] {
  const pids = new Set<number>();
  for (const app of context.activationScope === "tweakers-only" ? [context.apps.tweakers] : [context.apps.chatgpt, context.apps.tweakers]) {
    const report = getOpenReport(locateCodexAtExactPath(app));
    if (report.pid !== null) pids.add(report.pid);
    for (const pid of report.relatedPids) if (positiveInteger(pid)) pids.add(pid);
  }
  return [...pids];
}

function boundBrokerHostPath(context: NativeHistoryActivationContextV1): string {
  return context.activationScope === "tweakers-only"
    ? join(context.tweakers.userRoot, "runtime", "account-router", BROKER_HOST_FILE)
    : context.manager.runtime.brokerHost.path;
}

function boundBrokerAppServerPath(context: NativeHistoryActivationContextV1): string {
  return join(dirname(boundBrokerHostPath(context)), BROKER_APP_SERVER_FILE);
}

function verifyCurrentSealedBrokerRuntime(context: NativeHistoryActivationContextV1): void {
  const runtime = resolveSealedManagerRuntimeAssets();
  if (runtime === null || runtime.root !== context.manager.runtime.root || runtime.fingerprint !== context.manager.runtime.fingerprint) {
    throw new Error("Native history activation broker runtime binding changed");
  }
  verifySealedManagerRuntimeAssets(runtime);
  if (!sameFileSeal(fileSeal(context.manager.runtime.brokerHost.path, "Native history activation broker host"), context.manager.runtime.brokerHost)) {
    throw new Error("Native history activation broker host changed");
  }
  fileSeal(join(dirname(context.manager.runtime.brokerHost.path), BROKER_APP_SERVER_FILE), "Native history activation sealed broker app-server");
}

function verifyCurrentBrokerRuntime(context: NativeHistoryActivationContextV1): void {
  verifyCurrentSealedBrokerRuntime(context);
  if (context.activationScope === "tweakers-only") {
    const sealedAppServer = fileSeal(join(dirname(context.manager.runtime.brokerHost.path), BROKER_APP_SERVER_FILE), "Native history activation sealed broker app-server");
    const activeRoot = join(context.tweakers.userRoot, "runtime");
    assertPrivateDirectory(context.tweakers.userRoot, "Native history activation Tweakers root");
    // The desktop starts the runtime installed under its own profile. Bind
    // that exact tree to the manager's sealed bytes before accepting its argv.
    const assertOwnedTree = (path: string): void => {
      const stat = lstatSync(path);
      const uid = process.getuid?.();
      if (stat.isSymbolicLink() || realpathSync(path) !== path || (uid !== undefined && stat.uid !== uid)
        || (stat.mode & 0o022) !== 0 || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error("Native history activation active broker runtime is not an owned canonical tree");
      }
      if (stat.isDirectory()) for (const name of readdirSync(path)) assertOwnedTree(join(path, name));
    };
    assertPrivateDirectory(activeRoot, "Native history activation active broker runtime");
    assertOwnedTree(activeRoot);
    const active = readRuntimeFingerprintEvidence(activeRoot);
    if (active?.fingerprint !== context.manager.runtime.fingerprint) {
      throw new Error("Native history activation active broker runtime fingerprint changed");
    }
    const host = fileSeal(boundBrokerHostPath(context), "Native history activation active broker host");
    const appServer = fileSeal(boundBrokerAppServerPath(context), "Native history activation active broker app-server");
    if (host.bytes !== context.manager.runtime.brokerHost.bytes || host.sha256 !== context.manager.runtime.brokerHost.sha256
      || appServer.bytes !== sealedAppServer.bytes || appServer.sha256 !== sealedAppServer.sha256) {
      throw new Error("Native history activation active broker entrypoints differ from the sealed runtime");
    }
  }
}

function parseBrokerProcessCommand(
  command: string,
  entrypoint: string,
  configPath: string,
  stateRoot: string,
  label: string,
): string {
  const marker = ` ${entrypoint} --config ${configPath} --state-root ${stateRoot} -- `;
  const index = command.indexOf(marker);
  if (index <= 0 || command.indexOf(marker, index + marker.length) !== -1) {
    throw new Error(`${label} does not have the exact sealed broker argv`);
  }
  const executable = command.slice(0, index).trim();
  const tail = command.slice(index + marker.length);
  // Both broker processes are spawned with `process.execPath`, followed by
  // one sealed entrypoint.  Accepting interpreter flags here would turn a
  // substring match into authority over a process that is not the exact
  // sealed bridge we are permitted to stop.
  if (executable.length === 0 || !isAbsolute(executable) || resolve(executable) !== executable || /\s|[\u0000\r\n]/.test(executable)
    || tail.length === 0 || /[\u0000\r\n]/.test(tail)) {
    throw new Error(`${label} has an unsafe broker process command`);
  }
  return tail;
}

function hasParticipatingAppAncestor(
  parent: NativeHistoryActivationProcessObservation,
  processes: ReadonlyMap<number, NativeHistoryActivationProcessObservation>,
  participants: ReadonlySet<number>,
): boolean {
  const visited = new Set<number>();
  let pid = parent.ppid;
  while (pid !== null && pid > 0 && !visited.has(pid) && visited.size < 64) {
    if (participants.has(pid)) return true;
    visited.add(pid);
    const next = processes.get(pid);
    if (next === undefined) return false;
    pid = next.ppid;
  }
  return false;
}

interface BrokerObservationOptions {
  expected?: NativeHistoryActivationBrokerIdentityV1;
  allowCapturedParentOrphan?: boolean;
}

function observeNativeHistoryActivationBrokerInternal(
  context: NativeHistoryActivationContextV1,
  dependencies: NativeHistoryActivationBrokerObservationDependencies,
  options: BrokerObservationOptions = {},
): NativeHistoryActivationBrokerIdentityV1 {
  const socketPath = brokerSocketPath(context);
  assertPrivateBrokerSocket(socketPath);
  (dependencies.verifyRuntime ?? verifyCurrentBrokerRuntime)(context);
  const owners = dependencies.socketOwnerPids?.(socketPath) ?? defaultSocketOwnerPids(socketPath);
  if (!Array.isArray(owners) || owners.length !== 1 || !positiveInteger(owners[0])) {
    throw new Error("Native history activation broker socket must have exactly one owner PID");
  }
  const processes = currentBrokerProcessObservations(dependencies);
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const broker = byPid.get(owners[0]!);
  if (broker === undefined) throw new Error("Native history activation broker owner has no process identity");
  const configPath = join(context.roots.globalRoot, REGISTRATION_CONFIG_FILE);
  const brokerTail = parseBrokerProcessCommand(
    broker.command,
    boundBrokerHostPath(context),
    configPath,
    context.roots.globalRoot,
    "Native history activation broker",
  );
  const expected = options.expected;
  const parent = broker.ppid === null ? undefined : byPid.get(broker.ppid);
  const allowOrphan = expected !== undefined && options.allowCapturedParentOrphan === true
    && broker.ppid === 1 && expected.parentPid !== null
    && !processes.some((candidate) => candidate.pid === expected.parentPid && candidate.processStartToken === expected.parentProcessStartToken);
  let parentPid: number | null;
  let parentProcessStartToken: string | null;
  if (allowOrphan) {
    parentPid = null;
    parentProcessStartToken = null;
  } else {
    if (parent === undefined) throw new Error("Native history activation broker has no sealed app-server parent");
    const parentTail = parseBrokerProcessCommand(
      parent.command,
      boundBrokerAppServerPath(context),
      configPath,
      context.roots.globalRoot,
      "Native history activation broker parent",
    );
    if (parentTail !== brokerTail) {
      throw new Error("Native history activation broker and app-server parent arguments differ");
    }
    const participants = new Set(dependencies.participatingAppPids?.(context) ?? defaultParticipatingAppPids(context));
    if (participants.size === 0 || [...participants].some((pid) => !positiveInteger(pid))
      || !hasParticipatingAppAncestor(parent, byPid, participants)) {
      throw new Error("Native history activation broker app-server has no participating app ancestry");
    }
    parentPid = parent.pid;
    parentProcessStartToken = parent.processStartToken;
  }
  let configBytes: Buffer | null = null;
  try {
    configBytes = readPrivateBytes(configPath, REGISTRATION_JSON_MAX_BYTES, "Native history activation broker config");
    const identity: NativeHistoryActivationBrokerIdentityV1 = {
      pid: broker.pid,
      processStartToken: broker.processStartToken,
      parentPid,
      parentProcessStartToken,
      brokerHostPath: boundBrokerHostPath(context),
      brokerHostSha256: context.manager.runtime.brokerHost.sha256,
      socketPath,
      configSha256: createHash("sha256").update(configBytes).digest("hex"),
    };
    assertBrokerIdentity(identity, context);
    if (expected !== undefined && (!sameBrokerCoreIdentity(identity, expected)
      || (!allowOrphan && (identity.parentPid !== expected.parentPid
        || identity.parentProcessStartToken !== expected.parentProcessStartToken)))) {
      throw new Error("Native history activation broker identity changed before recovery");
    }
    return identity;
  } finally {
    configBytes?.fill(0);
  }
}

/**
 * Read-only owner proof used by the coordinator and isolated tests. It never
 * signals a process or creates a socket.
 */
export function observeNativeHistoryActivationBroker(
  context: NativeHistoryActivationContextV1,
  dependencies: NativeHistoryActivationBrokerObservationDependencies = {},
): NativeHistoryActivationBrokerIdentityV1 {
  return observeNativeHistoryActivationBrokerInternal(context, dependencies);
}

function defaultObserveBroker(context: NativeHistoryActivationContextV1): NativeHistoryActivationBrokerIdentityV1 {
  return observeNativeHistoryActivationBroker(context);
}

function sameBrokerCoreIdentity(
  left: NativeHistoryActivationBrokerIdentityV1,
  right: NativeHistoryActivationBrokerIdentityV1,
): boolean {
  return left.pid === right.pid && left.processStartToken === right.processStartToken
    && left.brokerHostPath === right.brokerHostPath && left.brokerHostSha256 === right.brokerHostSha256
    && left.socketPath === right.socketPath && left.configSha256 === right.configSha256;
}

function sameBrokerIdentity(
  left: NativeHistoryActivationBrokerIdentityV1,
  right: NativeHistoryActivationBrokerIdentityV1,
): boolean {
  return sameBrokerCoreIdentity(left, right) && left.parentPid === right.parentPid
    && left.parentProcessStartToken === right.parentProcessStartToken;
}

function sameAppProcessIdentity(
  left: NativeHistoryActivationAppProcessIdentity | null,
  right: NativeHistoryActivationAppProcessIdentity | null,
): boolean {
  return left === right || (left !== null && right !== null
    && left.pid === right.pid && left.processStartToken === right.processStartToken);
}

function brokerArtifactsAreGone(context: NativeHistoryActivationContextV1, known: NativeHistoryActivationBrokerIdentityV1): boolean {
  const socketState = noFollowPathState(brokerSocketPath(context));
  const processes = currentBrokerProcessObservations({});
  const matching = processes.some((process) => process.pid === known.pid && process.processStartToken === known.processStartToken);
  if (socketState === "absent" && !matching) return true;
  if (socketState === "absent" || !matching) {
    throw new Error("Native history activation broker process and socket evidence disagree");
  }
  return false;
}

async function defaultStopBroker(
  context: NativeHistoryActivationContextV1,
  known: NativeHistoryActivationBrokerIdentityV1 | null,
): Promise<void> {
  const socketPath = brokerSocketPath(context);
  if (known === null) {
    if (noFollowPathState(socketPath) === "absent") return;
    known = defaultObserveBroker(context);
  }
  if (brokerArtifactsAreGone(context, known)) return;
  const proveCurrent = (): NativeHistoryActivationBrokerIdentityV1 => {
    const current = observeNativeHistoryActivationBrokerInternal(context, {}, {
      expected: known!,
      allowCapturedParentOrphan: true,
    });
    if (!sameBrokerCoreIdentity(current, known!)) {
      throw new Error("Native history activation broker identity changed before signal");
    }
    return current;
  };
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (brokerArtifactsAreGone(context, known!)) return true;
      await sleep(100);
    }
    return brokerArtifactsAreGone(context, known!);
  };
  const current = proveCurrent();
  process.kill(current.pid, "SIGTERM");
  if (await waitForExit(BROKER_STOP_TERM_TIMEOUT_MS)) return;
  const afterTerm = proveCurrent();
  process.kill(afterTerm.pid, "SIGKILL");
  if (!await waitForExit(BROKER_STOP_KILL_TIMEOUT_MS)) {
    throw new Error("Native history activation broker did not stop after bounded signals");
  }
}

async function defaultStopParticipatingApps(context: NativeHistoryActivationContextV1): Promise<void> {
  if (context.activationScope !== "tweakers-only") await quiesceExactApp(context.apps.chatgpt);
  await quiesceExactApp(context.apps.tweakers);
}

function assertArchiveDestinationAbsent(path: string, label: string): void {
  if (noFollowPathState(path) !== "absent") {
    throw new Error(`${label} already exists or is unreadable`);
  }
}

function defaultArchiveRegistration(
  context: NativeHistoryActivationContextV1,
  registration: NativeHistoryActivationRegistrationReceiptV1,
): NativeHistoryActivationArchiveV1 {
  assertRegistrationReceipt(registration, context);
  const inspected = inspectPublishedRegistration(context, {
    runtimeActive: true,
    expectedRegistration: registration,
  });
  if (inspected === null) throw new Error("Native history activation registration disappeared before archive");
  const paths = nativeHistoryActivationPaths(context.managerRoot, context.operationId);
  const globalParent = dirname(context.roots.globalRoot);
  const reservation = reservationPath(context.roots.globalRoot);
  assertPrivateDirectory(globalParent, "Native history activation registration parent", false);
  assertPrivateDirectory(paths.operationRoot, "Native history activation operation root");
  assertArchiveDestinationAbsent(paths.archive, "Native history activation archive root");
  const operationIdentity = directoryIdentity(paths.operationRoot, "Native history activation operation root");
  const sourceParentIdentity = directoryIdentity(globalParent, "Native history activation registration parent");
  if (operationIdentity.device !== sourceParentIdentity.device) {
    throw new Error("Native history activation archive is not on the registration filesystem");
  }
  mkdirSync(paths.archive, { mode: PRIVATE_DIRECTORY_MODE });
  fsyncDirectory(paths.operationRoot);
  assertPrivateDirectory(paths.archive, "Native history activation archive root");
  const archive: NativeHistoryActivationArchiveV1 = {
    archiveRoot: paths.archive,
    globalRootArchive: join(paths.archive, "global-root"),
    reservationArchive: join(paths.archive, "native-setup-reservation"),
  };
  assertArchive(archive, context);
  assertArchiveDestinationAbsent(archive.globalRootArchive, "Native history activation global-root archive");
  assertArchiveDestinationAbsent(archive.reservationArchive, "Native history activation reservation archive");
  // The global root is the authority boundary. Move it first and retain a
  // partial archive for recovery if the reservation rename cannot complete.
  renameSync(context.roots.globalRoot, archive.globalRootArchive);
  fsyncDirectory(globalParent);
  fsyncDirectory(paths.archive);
  if (!sameDirectoryIdentity(directoryIdentity(archive.globalRootArchive, "Native history activation archived registration root"), registration.globalRoot)
    || noFollowPathState(context.roots.globalRoot) !== "absent") {
    throw new Error("Native history activation global registration archive identity is invalid");
  }
  renameSync(reservation, archive.reservationArchive);
  fsyncDirectory(globalParent);
  fsyncDirectory(paths.archive);
  if (!sameDirectoryIdentity(directoryIdentity(archive.reservationArchive, "Native history activation archived reservation"), registration.reservation)
    || noFollowPathState(reservation) !== "absent") {
    throw new Error("Native history activation reservation archive identity is invalid");
  }
  return archive;
}

async function defaultReopenPreviousTweakers(
  context: NativeHistoryActivationContextV1,
  previous: NativeHistoryActivationAppProcessIdentity | null,
): Promise<void> {
  if (previous === null) return;
  const assertCurrentInstallation = (): void => {
    if (!sameDirectoryIdentity(directoryIdentity(context.tweakers.appPath, "Native history activation previous Tweakers app"), context.tweakers.appIdentity)
      || fileRevision(context.tweakers.stateFile, "Native history activation previous Tweakers state") !== context.tweakers.stateRevision) {
      throw new Error("Native history activation previous Tweakers installation changed during recovery");
    }
  };
  assertCurrentInstallation();
  if (observeCodexMainProcess(context.apps.tweakers) !== null) {
    throw new Error("Native history activation refuses to reopen over an existing Tweakers process");
  }
  openAndActivateCodex(context.apps.tweakers);
  const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = observeCodexMainProcess(context.apps.tweakers);
    if (observed !== null && (observed.pid !== previous.pid || observed.startedAtRaw !== previous.processStartToken)
      && typeof observed.startedAtRaw === "string" && observed.startedAtRaw.length > 0) {
      assertCurrentInstallation();
      return;
    }
    await sleep(RUNTIME_READY_POLL_MS);
  }
  throw new Error("Native history activation previous Tweakers reopen proof timed out");
}

interface BeforeRegistrationRollbackInput {
  context: NativeHistoryActivationContextV1;
  injected: NativeHistoryActivationPreparedInjected | null;
  independent: NativeHistoryActivationPreparedIndependent | null;
  independentPromise: Promise<NativeHistoryActivationPreparedIndependent> | null;
  independentCaptureOccurred: boolean;
  injectedCommitStarted: boolean;
  allowInjectedRollback: boolean;
  reopenPreviousTweakers: (
    context: NativeHistoryActivationContextV1,
    previous: NativeHistoryActivationAppProcessIdentity | null,
  ) => Promise<void>;
  previousTweakers: NativeHistoryActivationAppProcessIdentity | null;
  reopenPrevious: boolean;
  errors: unknown[];
}

async function resolveIndependentForRollback(
  independent: NativeHistoryActivationPreparedIndependent | null,
  independentPromise: Promise<NativeHistoryActivationPreparedIndependent> | null,
  captureOccurred: boolean,
  errors: unknown[],
): Promise<NativeHistoryActivationPreparedIndependent | null> {
  if (independent !== null) return independent;
  if (independentPromise === null) return null;
  try {
    return await independentPromise;
  } catch (error) {
    // A failure before the callback ever captured an old app happened before
    // quiescence/promotion. The outer operation already retains that cause;
    // cancellation is sufficient and does not need a recovery journal.
    if (captureOccurred && !(error instanceof VariantPrePromotionAbortedError)) errors.push(error);
    return null;
  }
}

async function rollbackIndependent(
  independent: NativeHistoryActivationPreparedIndependent | null,
  errors: unknown[],
): Promise<void> {
  if (independent === null) return;
  try {
    independent.deferred.rollback();
  } catch (error) {
    errors.push(error);
  }
}

async function rollbackBeforeRegistration(input: BeforeRegistrationRollbackInput): Promise<void> {
  const independent = await resolveIndependentForRollback(
    input.independent,
    input.independentPromise,
    input.independentCaptureOccurred,
    input.errors,
  );
  await rollbackIndependent(independent, input.errors);
  // A failed independent restoration is an uncertain writer state. Do not let
  // an environment rollback reopen ChatGPT or otherwise mask that uncertainty.
  if (input.errors.length > 0) return;
  if (input.injected !== null) {
    try {
      if (!input.injectedCommitStarted) {
        await input.injected.cancel();
      } else if (input.allowInjectedRollback) {
        await input.injected.restoreBeforeRegistration();
      } else {
        throw new Error("Native history activation retains an ambiguous publication after injected commit began");
      }
    } catch (error) {
      input.errors.push(error);
    }
  }
  if (input.errors.length === 0 && input.reopenPrevious) {
    try {
      await input.reopenPreviousTweakers(input.context, input.previousTweakers);
    } catch (error) {
      input.errors.push(error);
    }
  }
}

interface AfterRegistrationRollbackInput {
  context: NativeHistoryActivationContextV1;
  injected: NativeHistoryActivationPreparedInjected | null;
  independent: NativeHistoryActivationPreparedIndependent | null;
  independentPromise: Promise<NativeHistoryActivationPreparedIndependent> | null;
  independentCaptureOccurred: boolean;
  injectedCommitStarted: boolean;
  broker: NativeHistoryActivationBrokerIdentityV1 | null;
  observeBroker: (context: NativeHistoryActivationContextV1) => NativeHistoryActivationBrokerIdentityV1;
  stopParticipatingApps: (context: NativeHistoryActivationContextV1) => Promise<void>;
  stopBroker: (context: NativeHistoryActivationContextV1, known: NativeHistoryActivationBrokerIdentityV1 | null) => void | Promise<void>;
  postPublicationWriterCensus: (context: NativeHistoryActivationContextV1) => boolean;
  archiveRegistration: (
    context: NativeHistoryActivationContextV1,
    registration: NativeHistoryActivationRegistrationReceiptV1,
  ) => NativeHistoryActivationArchiveV1;
  registration: NativeHistoryActivationRegistrationReceiptV1;
  recordArchive: (archive: NativeHistoryActivationArchiveV1) => void;
  reopenPreviousTweakers: (
    context: NativeHistoryActivationContextV1,
    previous: NativeHistoryActivationAppProcessIdentity | null,
  ) => Promise<void>;
  previousTweakers: NativeHistoryActivationAppProcessIdentity | null;
  errors: unknown[];
}

async function rollbackAfterRegistration(input: AfterRegistrationRollbackInput): Promise<void> {
  let broker = input.broker;
  try {
    // Capture a fresh owner proof before closing an app can orphan its bridge.
    if (broker !== null || noFollowPathState(brokerSocketPath(input.context)) === "present") {
      const observed = input.observeBroker(input.context);
      if (broker !== null && !sameBrokerIdentity(observed, broker)) {
        throw new Error("Native history activation broker identity changed before participant shutdown");
      }
      broker = observed;
    }
    await input.stopParticipatingApps(input.context);
    await input.stopBroker(input.context, broker);
    if (!input.postPublicationWriterCensus(input.context)) {
      throw new Error("Native history activation post-publication writer census was not idle");
    }
    const archive = input.archiveRegistration(input.context, input.registration);
    // The archive receipt is persisted before any restoration can reopen an
    // old writer. A failed journal write leaves retained evidence in place.
    input.recordArchive(archive);
  } catch (error) {
    input.errors.push(error);
    return;
  }

  const independent = await resolveIndependentForRollback(
    input.independent,
    input.independentPromise,
    input.independentCaptureOccurred,
    input.errors,
  );
  await rollbackIndependent(independent, input.errors);
  if (input.errors.length > 0) return;
  if (input.injected === null && input.context.activationScope !== "tweakers-only") {
    input.errors.push(new Error("Native history activation injected transaction is unavailable for rollback"));
    return;
  }
  try {
    if (input.injected !== null) {
      if (input.injectedCommitStarted) await input.injected.rollback();
      else await input.injected.cancel();
    }
  } catch (error) {
    input.errors.push(error);
    return;
  }
  if (input.errors.length === 0) {
    try {
      await input.reopenPreviousTweakers(input.context, input.previousTweakers);
    } catch (error) {
      input.errors.push(error);
    }
  }
}

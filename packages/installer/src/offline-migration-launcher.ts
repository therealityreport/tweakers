import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJson,
  canonicalSha256Fingerprint,
  observeHistoryAdoptionCensus,
  type HistoryAdoptionCensusInput,
} from "./account-history-adoption.js";
import {
  CANONICAL_HISTORY_FILE,
  inspectSharedHistoryCapacityReceipt,
  inspectSharedHistoryRollback,
  migrateSharedHistoryV2ToGlobalV3,
  type SharedHistoryCapacityReceiptInspectionV1,
  type SharedHistoryMigrationInput,
  type SharedHistoryMigrationResult,
  type SharedHistoryRollbackView,
} from "./shared-history-migration.js";
import {
  INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
  INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
  type IndependentTweakersRuntimeReadyAppearanceBinding,
} from "./commands/create-variant.js";
import { readHeaderHash } from "./asar.js";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";
import {
  REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS,
  TWEAKERS_VARIANT_BUNDLE_ID,
  TWEAKERS_ORIGINAL_EXECUTABLE,
} from "./macos-variant.js";
import {
  parseTweakersManagerTargetSeal,
  TWEAKERS_MANAGER_BUNDLE_NAME,
  TWEAKERS_MANAGER_LAUNCHER_NAME,
  TWEAKERS_MANAGER_SEAL_NAME,
  type TweakersManagerTargetSealV1,
} from "./manager-descriptor.js";

/** A private, one-shot launchd coordinator for the explicit offline v3 migration. */
export const OFFLINE_MIGRATION_LAUNCHER_SCHEMA_VERSION = 1 as const;
export const OFFLINE_MIGRATION_LAUNCHER_LABEL_PREFIX = "com.therealityreport.tweakers.offline-migration" as const;
export const OFFLINE_MIGRATION_LAUNCHER_CONTEXT_FILE = "offline-migration-launcher.v1.json" as const;
export const OFFLINE_MIGRATION_LAUNCHER_WAITING_FILE = "offline-migration-waiting.v1.json" as const;
export const OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE = "offline-migration-attempt.v1.json" as const;
export const OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE = "offline-migration-terminal-result.v1.json" as const;
export const OFFLINE_MIGRATION_LAUNCHER_ORIGIN_PROOF_DIAGNOSTIC_FILE = "offline-migration-origin-proof-diagnostic.v1.json" as const;
/** Deliberately excluded from the public manager protocol and ordinary installer CLI. */
export const OFFLINE_MIGRATION_MANAGER_RUN_COMMAND = "offline-migration-launcher-run-v1" as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_SEALED_DATA_MODE = 0o400;
const PRIVATE_EXECUTOR_MODE = 0o500;
const MAX_PRIVATE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MANAGER_NODE_BYTES = 512 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_MIGRATION_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_READY_RECEIPT_AGE_MS = 5 * 60 * 1000;
const DEFAULT_ZERO_WRITER_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_ZERO_WRITER_POLL_INTERVAL_MS = 1_000;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9-]{8,128}$/;
const LAUNCHCTL_SERVICE_NOT_FOUND_STATUS = 113;
const MAX_MIGRATION_TREE_FILES = 250_000;
const MAX_MIGRATION_TREE_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_SHARED_SKILLS_FILES = 32_768;
const MAX_SHARED_SKILLS_BYTES = 512 * 1024 * 1024;
const MAX_SHARED_PLUGIN_PACKAGES = 512;
const MAX_SHARED_PLUGIN_INVENTORY_BYTES = 2 * 1024 * 1024;
const EMPTY_SHA256_FINGERPRINT = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as Sha256Fingerprint;

type Sha256Fingerprint = `sha256:${string}`;

/** Local exact validators for the published shared-history journal contract. */
interface MigrationTreeManifestEntry {
  path: string;
  bytes: number;
  sha256: Sha256Fingerprint;
}

interface MigrationTreeManifestLink {
  path: string;
  target: "../../../../shared-plugins/cache";
}

interface MigrationTreeManifest {
  directories: readonly string[];
  files: readonly MigrationTreeManifestEntry[];
  links: readonly MigrationTreeManifestLink[];
  fingerprint: Sha256Fingerprint;
}

interface MigrationSharedSkillsTrustedRoot {
  path: string;
  device: number;
  inode: number;
  uid: number;
  mode: number;
}

interface MigrationSharedSkillsManifest {
  version: 1;
  kind: "account-router-shared-skills";
  directories: readonly string[];
  files: readonly MigrationTreeManifestEntry[];
  trustedRoots: readonly MigrationSharedSkillsTrustedRoot[];
  trustedRootsFingerprint: Sha256Fingerprint;
  fingerprint: Sha256Fingerprint;
}

interface MigrationSharedPluginExcludedFile {
  path: string;
  bytes: number;
  sha256: Sha256Fingerprint;
  reason: "credential" | "transient-lock";
}

interface MigrationSharedPluginPackage {
  pluginId: string;
  registry: string;
  name: string;
  version: string;
  fingerprint: Sha256Fingerprint;
  exclusionsFingerprint: Sha256Fingerprint;
  excludedFiles: readonly MigrationSharedPluginExcludedFile[];
  fileCount: number;
  bytes: number;
}

interface MigrationSharedPluginsManifest {
  version: 1;
  kind: "account-router-shared-plugins";
  inventoryFingerprint: Sha256Fingerprint;
  exclusionsFingerprint: Sha256Fingerprint;
  packages: readonly MigrationSharedPluginPackage[];
  fingerprint: Sha256Fingerprint;
}

interface MigrationSharedPluginInventory {
  version: 1;
  plugins: readonly { pluginId: string; version: string }[];
}

export interface OfflineMigrationLauncherManagerGenerationInput {
  /** Immutable manager generation containing the exact target.seal and manager.mjs. */
  generationRoot: string;
}

export interface OfflineMigrationLauncherPrepareInput {
  transactionId: string;
  /** Absent, owner-private directory created solely for this one transaction. */
  launcherRoot: string;
  /** Explicit LaunchAgents directory; tests supply a disposable directory. */
  launchAgentsRoot: string;
  /** Existing immutable manager generation; caller-selected scripts and PATH are forbidden. */
  managerGeneration: OfflineMigrationLauncherManagerGenerationInput;
  migration: Omit<SharedHistoryMigrationInput, "apply" | "transactionId">;
  /** Additional owner-private selection inventories that must not drift. */
  sealedInventoryPaths?: readonly string[];
  /** Current independent Tweakers runtime-ready receipt, bound byte-for-byte. */
  tweakersPromotionReceipt: string;
  /** SHA-256 of tweakersPromotionReceipt at review time. */
  tweakersPromotionFingerprint: Sha256Fingerprint;
}

/** The sealed launcher context always carries the resolved definitions root. */
type NormalizedOfflineMigrationInput = Omit<
  SharedHistoryMigrationInput,
  "apply" | "transactionId" | "legacyDefinitionsRoot" | "capacityReceiptPath"
> & {
  legacyDefinitionsRoot: string;
  /** Absent only in a historical context that may be inspected but never armed. */
  capacityReceiptPath?: string;
};

export interface OfflineMigrationSealedFile {
  path: string;
  bytes: number;
  sha256: Sha256Fingerprint;
}

/** The only LaunchAgent route: exact Node binary plus immutable manager bundle. */
export interface OfflineMigrationManagerExecutorBinding {
  generationRoot: string;
  generationId: string;
  targetSeal: OfflineMigrationSealedFile;
  node: OfflineMigrationSealedFile;
  managerBundle: OfflineMigrationSealedFile;
  managerLauncher: OfflineMigrationSealedFile;
}

export interface OfflineMigrationTweakersPromotionBinding {
  receipt: OfflineMigrationSealedFile;
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  pid: number;
  processStartToken: string;
  runtimeFingerprint: string;
  appAsarHeaderHash: string;
  appRoot: string;
  bundleId: typeof TWEAKERS_VARIANT_BUNDLE_ID;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: OfflineMigrationPreMigrationBrokerAuthorityExpectation;
  appearance: IndependentTweakersRuntimeReadyAppearanceBinding;
  observedAt: string;
}

/** The only broker expectation compatible with a not-yet-published v3 root. */
export interface OfflineMigrationPreMigrationBrokerAuthorityExpectation {
  globalRootState: "absent";
  configSha256: null;
}

interface CurrentTweakersRuntimeReadyReceipt {
  schemaVersion: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION;
  kind: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND;
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  pid: number;
  processStartToken: string;
  appRoot: string;
  bundleId: typeof TWEAKERS_VARIANT_BUNDLE_ID;
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: OfflineMigrationPreMigrationBrokerAuthorityExpectation;
  appearance: IndependentTweakersRuntimeReadyAppearanceBinding;
  mainInitialized: true;
  preloadInitialized: true;
  settingsMounted: true;
  sharedHistoryBrokerState: "connected" | "blocked";
  initializedTweakIds: readonly string[];
  observedAt: string;
}

export interface OfflineMigrationRollbackBinding {
  kind: "global-v3-read-only-viewer";
  globalRoot: string;
  canonicalHistoryFile: typeof CANONICAL_HISTORY_FILE;
  requiresBrokerWriteStop: true;
  legacyV2RestoreForbidden: true;
}

export interface OfflineMigrationLauncherContextV1 {
  version: typeof OFFLINE_MIGRATION_LAUNCHER_SCHEMA_VERSION;
  kind: "offline-migration-launcher";
  transactionId: string;
  launcherRoot: string;
  launchAgentsRoot: string;
  label: string;
  plistPath: string;
  executor: OfflineMigrationManagerExecutorBinding;
  inventories: readonly OfflineMigrationSealedFile[];
  promotion: OfflineMigrationTweakersPromotionBinding;
  rollback: OfflineMigrationRollbackBinding;
  migration: NormalizedOfflineMigrationInput;
  /** Required for every newly prepared context; absent historical contexts stay inspectable only. */
  capacityReceipt?: SharedHistoryCapacityReceiptInspectionV1;
  migrationJournalPath: string;
  preparedAt: string;
}

export interface OfflineMigrationWriterCensus {
  observedAt: string;
  chatgptWriters: number;
  tweakersWriters: number;
  brokerWriters: number;
  historyWriters: number;
}

export interface OfflineMigrationTweakersRuntimeReadyProbeInput {
  receiptPath: string;
  runtimeRoot: string;
  appRoot: string;
  expectedPid: number;
}

export interface OfflineMigrationTweakersRuntimeReadyProbeResult {
  process: {
    pid: number;
    processStartToken: string;
    command: string;
  } | null;
  appAsarHeaderHash: string | null;
  runtimeFingerprint: string | null;
}

export type OfflineMigrationLauncherTerminalState =
  | "migrated"
  | "blocked"
  | "manual-recovery-required"
  | "arm-failed";

export interface OfflineMigrationLauncherTerminalResultV1 {
  version: 1;
  kind: "offline-migration-launcher-terminal-result";
  transactionId: string;
  state: OfflineMigrationLauncherTerminalState;
  phase: "arm" | "preflight" | "census" | "apply" | "rollback-verification";
  reason: string | null;
  migrationJournalPath: string;
  globalRoot: string;
  firstCensus: OfflineMigrationWriterCensus | null;
  secondCensus: OfflineMigrationWriterCensus | null;
  migrationResult: SharedHistoryMigrationResult | null;
  rollback: SharedHistoryRollbackView | null;
  committedAt: string;
}

export interface OfflineMigrationLauncherOriginProofDiagnosticV1 {
  version: 1;
  kind: "offline-migration-launcher-origin-proof-diagnostic";
  transactionId: string;
  phase: "origin-proof";
  reason: string;
  recordedAt: string;
}

export interface OfflineMigrationLaunchctlResult {
  status: number | null;
  error?: string;
  /** launchctl print output used only to prove exact running-service identity. */
  output?: string;
}

/** Kept injectable so the test suite never calls the host launchd service. */
export interface OfflineMigrationLaunchctl {
  bootstrap(domain: string, plistPath: string): OfflineMigrationLaunchctlResult;
  bootout(domain: string, service: string): OfflineMigrationLaunchctlResult;
  print(service: string): OfflineMigrationLaunchctlResult;
}

export interface OfflineMigrationLauncherEvent {
  event:
    | "first-zero-writer-census"
    | "second-zero-writer-census"
    | "terminal-result-committed"
    | "plist-removed"
    | "launchd-bootout"
    | "self-removal-verified";
  transactionId: string;
}

export interface OfflineMigrationLauncherDependencies {
  launchctl?: OfflineMigrationLaunchctl;
  writerCensus?: (context: OfflineMigrationLauncherContextV1) => OfflineMigrationWriterCensus;
  migrate?: (input: SharedHistoryMigrationInput) => SharedHistoryMigrationResult;
  inspectRollback?: (globalRoot: string) => SharedHistoryRollbackView;
  now?: () => string;
  /** Test-only probe of the actual node/manager argv route. */
  currentExecutionRoute?: () => OfflineMigrationManagerExecutionRoute;
  /** Test-only process identity/liveness probes; production uses process.pid and signal 0. */
  currentProcessId?: () => number;
  /** Test-only parent identity probe; a real LaunchAgent worker is parented by launchd (PID 1). */
  currentParentProcessId?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  /** Exact manager argv capability. Production parses process.argv. */
  managerInvocation?: OfflineMigrationManagerRunInvocation;
  /** Prepare-only proof that the supplied v4 receipt belongs to the live app. */
  runtimeReadyProbe?: (
    input: OfflineMigrationTweakersRuntimeReadyProbeInput,
  ) => OfflineMigrationTweakersRuntimeReadyProbeResult;
  /** Test-only override; production uses the exported signed capacity-receipt inspector. */
  inspectCapacityReceipt?: typeof inspectSharedHistoryCapacityReceipt;
  /** Monotonic time and sleep are injectable for the bounded waiting state. */
  waitNow?: () => number;
  wait?: (milliseconds: number) => void;
  waitTimeoutMs?: number;
  waitPollIntervalMs?: number;
  onEvent?: (event: OfflineMigrationLauncherEvent) => void;
}

export interface OfflineMigrationManagerRunInvocation {
  launcherRoot: string;
  contextBytes: number;
  contextSha256: Sha256Fingerprint;
}

export interface OfflineMigrationManagerExecutionRoute {
  pid: number;
  nodePath: string;
  managerBundlePath: string;
  argv: readonly string[];
}

export interface OfflineMigrationLauncherInspection {
  state: "prepared" | "armed" | "waiting" | "terminal" | "interrupted" | "manual-recovery-required";
  transactionId: string;
  label: string;
  plistPath: string;
  plistPresent: boolean;
  launchdLoaded: boolean | null;
  workerPid: number | null;
  workerLive: boolean | null;
  waitingPresent: boolean;
  attemptPresent: boolean;
  migrationJournalPresent: boolean;
  globalRootPresent: boolean;
  terminalResult: OfflineMigrationLauncherTerminalResultV1 | null;
  originProofDiagnostic: OfflineMigrationLauncherOriginProofDiagnosticV1 | null;
}

export interface OfflineMigrationLauncherCliOptions {
  transaction?: string;
  launcherRoot?: string;
  "launcher-root"?: string;
  launchAgentsRoot?: string;
  "launch-agents-root"?: string;
  managerGenerationRoot?: string;
  "manager-generation-root"?: string;
  legacyRouterRoot?: string;
  "legacy-router-root"?: string;
  legacyCodexRoot?: string;
  "legacy-codex-root"?: string;
  legacySqliteRoot?: string;
  "legacy-sqlite-root"?: string;
  legacyDefinitionsRoot?: string;
  "legacy-definitions-root"?: string;
  globalRoot?: string;
  "global-root"?: string;
  app?: string;
  tweakersApp?: string;
  "tweakers-app"?: string;
  sharedSkillsRoot?: string | readonly string[];
  "shared-skills-root"?: string | readonly string[];
  sharedPluginInventory?: string;
  "shared-plugin-inventory"?: string;
  /** Commander maps --capacity-receipt to this camel-case key. */
  capacityReceipt?: string;
  capacityReceiptPath?: string;
  "capacity-receipt"?: string;
  sealedInventory?: string | readonly string[];
  "sealed-inventory"?: string | readonly string[];
  tweakersPromotionReceipt?: string;
  "tweakers-promotion-receipt"?: string;
  tweakersPromotionFingerprint?: string;
  "tweakers-promotion-fingerprint"?: string;
}

export interface OfflineMigrationLauncherCommandDependencies extends OfflineMigrationLauncherDependencies {
  print?: (line: string) => void;
}

export class OfflineMigrationLauncherError extends Error {
  constructor(readonly code: string) {
    super(`Offline migration launcher stopped safely: ${code}`);
    this.name = "OfflineMigrationLauncherError";
  }
}

function fail(code: string): never {
  throw new OfflineMigrationLauncherError(code);
}

/** Paths are exported for exact, read-only inspection and disposable tests. */
export function offlineMigrationLauncherPaths(launcherRoot: string): {
  context: string;
  waiting: string;
  attempt: string;
  terminalResult: string;
  originProofDiagnostic: string;
} {
  const root = exactAbsolute(launcherRoot, "invalid-launcher-root");
  return {
    context: join(root, OFFLINE_MIGRATION_LAUNCHER_CONTEXT_FILE),
    waiting: join(root, OFFLINE_MIGRATION_LAUNCHER_WAITING_FILE),
    attempt: join(root, OFFLINE_MIGRATION_LAUNCHER_ATTEMPT_FILE),
    terminalResult: join(root, OFFLINE_MIGRATION_LAUNCHER_TERMINAL_RESULT_FILE),
    originProofDiagnostic: join(root, OFFLINE_MIGRATION_LAUNCHER_ORIGIN_PROOF_DIAGNOSTIC_FILE),
  };
}

/**
 * Create one immutable, owner-private context. This writes no plist and makes
 * no launchd call; arming remains a separate explicit action.
 */
export function prepareOfflineMigrationLauncher(
  input: OfflineMigrationLauncherPrepareInput,
  dependencies: Pick<OfflineMigrationLauncherDependencies, "now" | "runtimeReadyProbe" | "inspectCapacityReceipt"> = {},
): OfflineMigrationLauncherContextV1 {
  const transactionId = validatedTransactionId(input.transactionId);
  const launcherRoot = exactAbsolute(input.launcherRoot, "invalid-launcher-root");
  const launchAgentsRoot = exactAbsolute(input.launchAgentsRoot, "invalid-launch-agents-root");
  const normalizedMigration = normalizeMigrationInput(input.migration);
  // Capacity validation is intentionally complete before the launcher root,
  // context, attempt, or LaunchAgent can exist.
  const initialCapacityReceipt = inspectCapacityReceipt(normalizedMigration, dependencies);
  const capacityReceiptPath = initialCapacityReceipt.receipt.path;
  const migration: NormalizedOfflineMigrationInput = {
    ...normalizedMigration,
    capacityReceiptPath,
  };
  const label = `${OFFLINE_MIGRATION_LAUNCHER_LABEL_PREFIX}.${transactionId}`;
  const plistPath = join(launchAgentsRoot, `${label}.plist`);
  const migrationJournalPath = sharedHistoryMigrationJournalPath(migration.globalRoot, transactionId);

  assertAbsent(launcherRoot, "launcher-root-already-exists");
  assertOwnerControlledDirectory(dirname(launcherRoot), "launcher-root-parent");
  assertOwnerControlledDirectory(launchAgentsRoot, "launch-agents-root");
  assertPrivateDirectory(dirname(migration.globalRoot), "global-v3-parent");
  assertAbsent(migration.globalRoot, "global-v3-root-already-exists");
  assertAbsent(migrationJournalPath, "shared-history-migration-journal-already-exists");
  assertAbsent(plistPath, "launch-agent-plist-already-exists");
  assertCanonicalDirectory(migration.legacyRouterRoot, "legacy-router-root");
  assertCanonicalDirectory(migration.legacyCodexRoot, "legacy-codex-root");
  assertCanonicalDirectory(migration.legacySqliteRoot, "legacy-sqlite-root");
  assertOwnerControlledDirectory(migration.legacyDefinitionsRoot, "legacy-definitions-root");
  for (const root of migration.sharedSkillsRoots) assertCanonicalDirectory(root, "shared-skills-root");
  assertCanonicalDirectory(migration.appPath, "chatgpt-app");
  assertCanonicalDirectory(migration.tweakersAppPath, "tweakers-app");

  const executor = sealManagerGeneration(input.managerGeneration);
  const inventories = sealInventories([
    migration.sharedPluginInventory,
    capacityReceiptPath,
    ...(input.sealedInventoryPaths ?? []),
  ]);
  const sealedCapacityReceipt = inventories.find((entry) => entry.path === capacityReceiptPath);
  if (sealedCapacityReceipt === undefined || !sameSealedFile(sealedCapacityReceipt, initialCapacityReceipt.receipt)) {
    fail("shared-history-capacity-receipt-changed-during-prepare");
  }
  const capacityReceipt = inspectCapacityReceipt(migration, dependencies);
  if (canonicalJson(capacityReceipt) !== canonicalJson(initialCapacityReceipt)) {
    fail("shared-history-capacity-receipt-changed-during-prepare");
  }
  const promotion = sealTweakersPromotion(
    input.tweakersPromotionReceipt,
    input.tweakersPromotionFingerprint,
    migration.tweakersAppPath,
    migration.globalRoot,
  );
  assertPromotionCurrentAtPrepare(
    promotion,
    dependencies.now ?? (() => new Date().toISOString()),
    dependencies.runtimeReadyProbe ?? defaultRuntimeReadyProbe,
  );
  const rollback: OfflineMigrationRollbackBinding = {
    kind: "global-v3-read-only-viewer",
    globalRoot: migration.globalRoot,
    canonicalHistoryFile: CANONICAL_HISTORY_FILE,
    requiresBrokerWriteStop: true,
    legacyV2RestoreForbidden: true,
  };
  const preparedAt = canonicalNow((dependencies.now ?? (() => new Date().toISOString()))());
  const context: OfflineMigrationLauncherContextV1 = {
    version: OFFLINE_MIGRATION_LAUNCHER_SCHEMA_VERSION,
    kind: "offline-migration-launcher",
    transactionId,
    launcherRoot,
    launchAgentsRoot,
    label,
    plistPath,
    executor,
    inventories,
    promotion,
    rollback,
    migration,
    capacityReceipt,
    migrationJournalPath,
    preparedAt,
  };
  mkdirSync(launcherRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(launcherRoot, "launcher-root");
  fsyncDirectory(dirname(launcherRoot));
  assertContext(context, launcherRoot);
  writePrivateJsonNew(offlineMigrationLauncherPaths(launcherRoot).context, context, "launcher-context");
  return context;
}

/** Read the sealed context without changing launchd or migration state. */
export function readOfflineMigrationLauncherContext(launcherRoot: string): OfflineMigrationLauncherContextV1 {
  return readSealedOfflineMigrationLauncherContext(launcherRoot).context;
}

/**
 * Read the exact bytes that launchd later binds in fixed argv. A parsed object
 * alone is insufficient because an owner-private JSON file remains mutable.
 */
function readSealedOfflineMigrationLauncherContext(launcherRoot: string): {
  context: OfflineMigrationLauncherContextV1;
  seal: OfflineMigrationSealedFile;
} {
  const paths = offlineMigrationLauncherPaths(launcherRoot);
  assertPrivateDirectory(dirname(paths.context), "launcher-root");
  const bytes = readPrivateBytes(paths.context, MAX_CONTEXT_BYTES, "launcher-context");
  try {
    const seal: OfflineMigrationSealedFile = {
      path: paths.context,
      bytes: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Fingerprint,
    };
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      fail("launcher-context-invalid-json");
    }
    assertContext(value, dirname(paths.context));
    return { context: value, seal };
  } finally {
    bytes.fill(0);
  }
}

/**
 * Bootstrap exactly one private RunAtLoad LaunchAgent. It never performs the
 * migration itself, and it refuses a consumed, ambiguous, or already-published
 * transaction before launchd is asked to load anything.
 */
export function armOfflineMigrationLauncher(
  launcherRoot: string,
  dependencies: OfflineMigrationLauncherDependencies = {},
): OfflineMigrationLauncherInspection {
  const { context, seal: contextSeal } = readSealedOfflineMigrationLauncherContext(launcherRoot);
  verifyContextSeals(context, dependencies);
  assertNotConsumedBeforeApply(context);
  assertAbsent(context.plistPath, "launch-agent-plist-already-exists");
  const launchctl = dependencies.launchctl ?? systemLaunchctl();
  const domain = launchdDomain();
  if (isLaunchdLoaded(launchctl, `${domain}/${context.label}`)) fail("launchd-label-already-loaded");

  writePrivateTextNew(context.plistPath, launchAgentPlist(context, contextSeal), "launch-agent-plist");
  const bootstrap = launchctl.bootstrap(domain, context.plistPath);
  if (bootstrap.status !== 0) {
    const result = armFailureResult(context, bootstrap, dependencies.now ?? (() => new Date().toISOString()));
    writeTerminalResult(context, result);
    selfRemove(context, dependencies);
    fail("launchd-bootstrap-failed");
  }
  if (!isLaunchdLoaded(launchctl, `${domain}/${context.label}`)) {
    const result = armFailureResult(context, { status: null, error: "label-not-loaded-after-bootstrap" }, dependencies.now ?? (() => new Date().toISOString()));
    writeTerminalResult(context, result);
    selfRemove(context, dependencies);
    fail("launchd-label-not-loaded-after-bootstrap");
  }
  return inspectOfflineMigrationLauncher(launcherRoot, { launchctl });
}

/**
 * The private LaunchAgent invokes this one-shot entrypoint. It is deliberately
 * not a recovery command: a prior attempt, a journal, or a v3 root is durable
 * evidence requiring an explicit human-led recovery path.
 */
export function runOfflineMigrationLauncher(
  launcherRoot: string,
  dependencies: OfflineMigrationLauncherDependencies = {},
): OfflineMigrationLauncherTerminalResultV1 {
  const invocation = dependencies.managerInvocation ?? managerInvocationFromCurrentProcess();
  const { context, seal: contextSeal } = readSealedOfflineMigrationLauncherContext(launcherRoot);
  assertManagerInvocation(context, contextSeal, invocation);
  const paths = offlineMigrationLauncherPaths(context.launcherRoot);
  const existing = readTerminalResultIfPresent(paths.terminalResult);
  if (existing !== null) {
    assertTerminalResult(existing, context);
    selfRemove(context, dependencies);
    return existing;
  }
  // Origin proof is deliberately outside the terminal-result catch. A shell
  // that merely knows the transaction directory must not consume or remove it.
  try {
    assertInternalRunner(context, contextSeal, invocation, dependencies);
  } catch (error) {
    writeOriginProofDiagnostic(context, error, dependencies.now ?? (() => new Date().toISOString()));
    throw error;
  }

  let firstCensus: OfflineMigrationWriterCensus | null = null;
  let secondCensus: OfflineMigrationWriterCensus | null = null;
  let terminal: OfflineMigrationLauncherTerminalResultV1;
  try {
    verifyContextSeals(context, dependencies);
    assertNotConsumedBeforeApply(context);
    // A durable waiting record makes an interrupted worker visibly manual-only,
    // but does not consume the migration. Active writers merely keep this one
    // launchd process waiting for the user-controlled shutdown window.
    writeWaiting(context, dependencies.now ?? (() => new Date().toISOString()));
    ({ firstCensus, secondCensus } = waitForZeroWriterWindow(context, dependencies));

    // Re-read and bind the raw context and launchd process at the final
    // mutable boundary. This is immediately before the durable attempt latch.
    const finalBinding = readSealedOfflineMigrationLauncherContext(context.launcherRoot);
    assertManagerInvocation(finalBinding.context, finalBinding.seal, invocation);
    if (canonicalJson(finalBinding.context) !== canonicalJson(context)) {
      fail("launcher-context-changed-after-launchd-bind");
    }
    assertInternalRunner(finalBinding.context, finalBinding.seal, invocation, dependencies);
    verifyContextSeals(finalBinding.context, dependencies);
    assertNotConsumedBeforeApply(finalBinding.context, { allowCurrentWaiting: true });

    // Latch only after two spaced idle observations. A crash after this point
    // is intentionally ambiguous and must never be retried automatically.
    writeAttempt(context, dependencies.now ?? (() => new Date().toISOString()));
    // Recheck every consumed identity at the final mutable boundary. The core
    // repeats its own v2 census; this outer census additionally covers broker
    // and history writers and records two independent observations.
    verifyContextSeals(context, dependencies);
    assertNotConsumedBeforeApply(context, { allowCurrentWaiting: true, allowCurrentAttempt: true });
    const migrationResult = (dependencies.migrate ?? migrateSharedHistoryV2ToGlobalV3)({
      ...context.migration,
      transactionId: context.transactionId,
      apply: true,
    });
    if (migrationResult.status !== "migrated") fail("migration-did-not-publish-global-v3");
    if (!existsNoFollow(context.migration.globalRoot)) fail("migration-global-v3-root-missing-after-success");
    const rollback = (dependencies.inspectRollback ?? inspectSharedHistoryRollback)(context.migration.globalRoot);
    assertMigratedEvidence(context, migrationResult, rollback);
    terminal = terminalResult(context, {
      state: "migrated",
      phase: "rollback-verification",
      reason: null,
      firstCensus,
      secondCensus,
      migrationResult,
      rollback,
      now: dependencies.now,
    });
  } catch (error) {
    const failure = errorCode(error);
    terminal = terminalResult(context, {
      state: isWriterFailure(failure) ? "blocked" : "manual-recovery-required",
      phase: failurePhase(failure),
      reason: failure,
      firstCensus,
      secondCensus,
      migrationResult: null,
      rollback: null,
      now: dependencies.now,
    });
  }

  // The result is the idempotency sentinel. It is fully fsynced before the
  // service asks launchd to terminate itself, so a signal cannot create a retry.
  writeTerminalResult(context, terminal);
  emit(dependencies, "terminal-result-committed", context);
  selfRemove(context, dependencies);
  return terminal;
}

/**
 * Fixed internal manager entrypoint. It is intentionally not an ordinary
 * installer CLI action or a manager status/action protocol command.
 */
export function runOfflineMigrationLauncherManagerCommand(
  argv: readonly string[],
  dependencies: OfflineMigrationLauncherDependencies = {},
): OfflineMigrationLauncherTerminalResultV1 {
  const invocation = parseManagerInvocation(argv);
  if (dependencies.managerInvocation !== undefined) fail("manager-runner-invocation-injection-forbidden");
  return runOfflineMigrationLauncher(invocation.launcherRoot, { ...dependencies, managerInvocation: invocation });
}

function waitForZeroWriterWindow(
  context: OfflineMigrationLauncherContextV1,
  dependencies: OfflineMigrationLauncherDependencies,
): { firstCensus: OfflineMigrationWriterCensus; secondCensus: OfflineMigrationWriterCensus } {
  const census = dependencies.writerCensus ?? defaultWriterCensus;
  const waitNow = dependencies.waitNow ?? Date.now;
  const sleep = dependencies.wait ?? blockingSleep;
  const timeout = boundedWaitMilliseconds(
    dependencies.waitTimeoutMs,
    DEFAULT_ZERO_WRITER_WAIT_TIMEOUT_MS,
    "invalid-zero-writer-wait-timeout",
  );
  const poll = boundedWaitMilliseconds(
    dependencies.waitPollIntervalMs,
    DEFAULT_ZERO_WRITER_POLL_INTERVAL_MS,
    "invalid-zero-writer-poll-interval",
  );
  const startedAt = waitNow();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) fail("invalid-zero-writer-clock");
  const deadline = startedAt + timeout;
  if (!Number.isSafeInteger(deadline)) fail("invalid-zero-writer-deadline");

  while (true) {
    assertNotConsumedBeforeApply(context, { allowCurrentWaiting: true });
    const firstCensus = census(context);
    assertWriterCensusShape(firstCensus);
    if (isZeroWriterCensus(firstCensus)) {
      emit(dependencies, "first-zero-writer-census", context);
      const beforeSecond = waitNow();
      if (!Number.isSafeInteger(beforeSecond) || beforeSecond < startedAt || beforeSecond >= deadline) {
        fail("zero-writer-window-timeout");
      }
      sleep(Math.min(poll, deadline - beforeSecond));
      assertNotConsumedBeforeApply(context, { allowCurrentWaiting: true });
      const secondCensus = census(context);
      assertWriterCensusShape(secondCensus);
      if (isZeroWriterCensus(secondCensus)) {
        emit(dependencies, "second-zero-writer-census", context);
        return { firstCensus, secondCensus };
      }
      if (waitNow() >= deadline) fail("zero-writer-window-timeout");
    } else if (waitNow() >= deadline) {
      fail("zero-writer-window-timeout");
    }
    const current = waitNow();
    if (!Number.isSafeInteger(current) || current < startedAt || current >= deadline) {
      fail("zero-writer-window-timeout");
    }
    sleep(Math.min(poll, deadline - current));
  }
}

/** A read-only status view; it never tries to resume, revert, or retry. */
export function inspectOfflineMigrationLauncher(
  launcherRoot: string,
  dependencies: Pick<OfflineMigrationLauncherDependencies, "launchctl" | "isProcessAlive"> = {},
): OfflineMigrationLauncherInspection {
  const context = readOfflineMigrationLauncherContext(launcherRoot);
  const paths = offlineMigrationLauncherPaths(context.launcherRoot);
  const terminalResult = readTerminalResultIfPresent(paths.terminalResult);
  if (terminalResult !== null) assertTerminalResult(terminalResult, context);
  const originProofDiagnostic = readOriginProofDiagnosticIfPresent(paths.originProofDiagnostic, context);
  const waitingPresent = existsNoFollow(paths.waiting);
  const attemptPresent = existsNoFollow(paths.attempt);
  const migrationJournalPresent = existsNoFollow(context.migrationJournalPath);
  const globalRootPresent = existsNoFollow(context.migration.globalRoot);
  const plistPresent = existsNoFollow(context.plistPath);
  const service = inspectLaunchdService(
    dependencies.launchctl ?? systemLaunchctl(),
    `${launchdDomain()}/${context.label}`,
    dependencies.isProcessAlive,
  );
  // `armed` is a complete durable binding, not merely a plist written before
  // bootstrap or a stray launchd job. Either half missing is an interruption
  // requiring manual recovery because a subsequent arm refuses to overwrite
  // the exact plist path.
  const exactLiveArmedBinding = plistPresent && service.loaded === true && service.live === true;
  const state = terminalResult !== null
    ? "terminal"
    : attemptPresent
      ? "interrupted"
      : migrationJournalPresent || globalRootPresent
        ? "manual-recovery-required"
        : waitingPresent
          ? exactLiveArmedBinding
            ? "waiting"
            : "interrupted"
        : !plistPresent && service.loaded === false
          ? "prepared"
          : exactLiveArmedBinding
          ? "armed"
          : "interrupted";
  return {
    state,
    transactionId: context.transactionId,
    label: context.label,
    plistPath: context.plistPath,
    plistPresent,
    launchdLoaded: service.loaded,
    workerPid: service.pid,
    workerLive: service.live,
    waitingPresent,
    attemptPresent,
    migrationJournalPresent,
    globalRootPresent,
    terminalResult,
    originProofDiagnostic,
  };
}

/** Explicit public CLI surface. The runner is manager-internal only. */
export function offlineMigrationLauncherCommand(
  action: string,
  options: OfflineMigrationLauncherCliOptions = {},
  dependencies: OfflineMigrationLauncherCommandDependencies = {},
): OfflineMigrationLauncherContextV1 | OfflineMigrationLauncherInspection {
  const normalizedAction = action.trim().toLowerCase();
  const print = dependencies.print ?? console.log;
  const launcherRoot = cliPath(options.launcherRoot ?? options["launcher-root"], "--launcher-root");
  if (normalizedAction === "inspect") {
    const result = inspectOfflineMigrationLauncher(launcherRoot, dependencies);
    print(JSON.stringify(result));
    return result;
  }
  if (normalizedAction === "arm") {
    const result = armOfflineMigrationLauncher(launcherRoot, dependencies);
    print(JSON.stringify(result));
    return result;
  }
  if (normalizedAction !== "prepare") {
    throw new Error("offline-migration-launcher action must be prepare, inspect, or arm; run is manager-internal only");
  }
  const result = prepareOfflineMigrationLauncher({
    transactionId: cliString(options.transaction, "--transaction"),
    launcherRoot,
    launchAgentsRoot: cliPath(options.launchAgentsRoot ?? options["launch-agents-root"], "--launch-agents-root"),
    managerGeneration: {
      generationRoot: cliPath(
        options.managerGenerationRoot ?? options["manager-generation-root"],
        "--manager-generation-root",
      ),
    },
    migration: {
      legacyRouterRoot: cliPath(options.legacyRouterRoot ?? options["legacy-router-root"], "--legacy-router-root"),
      legacyCodexRoot: cliPath(options.legacyCodexRoot ?? options["legacy-codex-root"], "--legacy-codex-root"),
      legacySqliteRoot: cliPath(options.legacySqliteRoot ?? options["legacy-sqlite-root"], "--legacy-sqlite-root"),
      ...((options.legacyDefinitionsRoot ?? options["legacy-definitions-root"]) === undefined
        ? {}
        : { legacyDefinitionsRoot: cliPath(options.legacyDefinitionsRoot ?? options["legacy-definitions-root"], "--legacy-definitions-root") }),
      globalRoot: cliPath(options.globalRoot ?? options["global-root"], "--global-root"),
      appPath: cliPath(options.app, "--app"),
      tweakersAppPath: cliPath(options.tweakersApp ?? options["tweakers-app"], "--tweakers-app"),
      sharedSkillsRoots: cliPaths(options.sharedSkillsRoot ?? options["shared-skills-root"], "--shared-skills-root"),
      sharedPluginInventory: cliPath(options.sharedPluginInventory ?? options["shared-plugin-inventory"], "--shared-plugin-inventory"),
      capacityReceiptPath: cliPath(
        options.capacityReceipt ?? options.capacityReceiptPath ?? options["capacity-receipt"],
        "--capacity-receipt",
      ),
    },
    sealedInventoryPaths: cliStrings(options.sealedInventory ?? options["sealed-inventory"]).map((path) => cliPath(path, "--sealed-inventory")),
    tweakersPromotionReceipt: cliPath(options.tweakersPromotionReceipt ?? options["tweakers-promotion-receipt"], "--tweakers-promotion-receipt"),
    tweakersPromotionFingerprint: cliFingerprint(options.tweakersPromotionFingerprint ?? options["tweakers-promotion-fingerprint"], "--tweakers-promotion-fingerprint"),
  }, dependencies);
  print(JSON.stringify(result));
  return result;
}

function normalizeMigrationInput(
  input: Omit<SharedHistoryMigrationInput, "apply" | "transactionId">,
): NormalizedOfflineMigrationInput {
  if (!isRecord(input)) fail("invalid-migration-input");
  const legacyCodexRoot = exactAbsolute(input.legacyCodexRoot, "invalid-legacy-codex-root");
  const migration = {
    legacyRouterRoot: exactAbsolute(input.legacyRouterRoot, "invalid-legacy-router-root"),
    legacyCodexRoot,
    legacySqliteRoot: exactAbsolute(input.legacySqliteRoot, "invalid-legacy-sqlite-root"),
    legacyDefinitionsRoot: exactAbsolute(
      input.legacyDefinitionsRoot ?? legacyCodexRoot,
      "invalid-legacy-definitions-root",
    ),
    ...(input.capacityReceiptPath === undefined
      ? {}
      : { capacityReceiptPath: exactAbsolute(input.capacityReceiptPath, "invalid-shared-history-capacity-receipt") }),
    globalRoot: exactAbsolute(input.globalRoot, "invalid-global-root"),
    appPath: exactAbsolute(input.appPath, "invalid-chatgpt-app"),
    tweakersAppPath: exactAbsolute(input.tweakersAppPath, "invalid-tweakers-app"),
    sharedSkillsRoots: normalizePaths(input.sharedSkillsRoots, "invalid-shared-skills-roots"),
    sharedPluginInventory: exactAbsolute(input.sharedPluginInventory, "invalid-shared-plugin-inventory"),
  };
  if (migration.appPath === migration.tweakersAppPath) fail("duplicate-desktop-app-path");
  if (migration.globalRoot === migration.legacyRouterRoot
    || migration.globalRoot === migration.legacyCodexRoot
    || migration.globalRoot === migration.legacySqliteRoot
    || pathsOverlap(migration.globalRoot, migration.legacyDefinitionsRoot)
    || (migration.capacityReceiptPath !== undefined && pathsOverlap(migration.globalRoot, migration.capacityReceiptPath))) {
    fail("global-v3-root-overlaps-legacy-input");
  }
  return migration;
}

/**
 * Capacity proof is a sealed input, not a deferred apply-time convenience.
 * The core validator owns HMAC, adoption, and normalized history-root checks;
 * the launcher additionally ties the receipt to its strictly allowlisted
 * shared Skills/plugin definitions before persisting any context.
 */
function inspectCapacityReceipt(
  migration: NormalizedOfflineMigrationInput,
  dependencies: Pick<OfflineMigrationLauncherDependencies, "inspectCapacityReceipt">,
): SharedHistoryCapacityReceiptInspectionV1 {
  if (migration.capacityReceiptPath === undefined) fail("shared-history-capacity-receipt-required");
  const inspected = (dependencies.inspectCapacityReceipt ?? inspectSharedHistoryCapacityReceipt)({
    legacyRouterRoot: migration.legacyRouterRoot,
    legacyCodexRoot: migration.legacyCodexRoot,
    legacySqliteRoot: migration.legacySqliteRoot,
    legacyDefinitionsRoot: migration.legacyDefinitionsRoot,
    sharedSkillsRoots: migration.sharedSkillsRoots,
    sharedPluginInventory: migration.sharedPluginInventory,
    capacityReceiptPath: migration.capacityReceiptPath,
  });
  if (inspected.receipt.path !== migration.capacityReceiptPath) {
    fail("shared-history-capacity-receipt-binding-invalid");
  }
  return inspected;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function sealManagerGeneration(input: OfflineMigrationLauncherManagerGenerationInput): OfflineMigrationManagerExecutorBinding {
  if (!isRecord(input) || typeof input.generationRoot !== "string") fail("invalid-manager-generation-input");
  const generationRoot = exactAbsolute(input.generationRoot, "invalid-manager-generation-root");
  assertPrivateDirectory(generationRoot, "manager-generation-root");
  if ((lstatNoFollow(generationRoot, "manager-generation-root").mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    fail("manager-generation-root-not-immutable");
  }
  assertOwnerControlledDirectory(dirname(generationRoot), "manager-generation-parent");
  const expectedEntries = [
    TWEAKERS_MANAGER_BUNDLE_NAME,
    TWEAKERS_MANAGER_LAUNCHER_NAME,
    TWEAKERS_MANAGER_SEAL_NAME,
  ].sort(compareCodeUnits);
  let entries: string[];
  try {
    entries = readdirSync(generationRoot).sort(compareCodeUnits);
  } catch {
    fail("manager-generation-unreadable");
  }
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    fail("manager-generation-layout-invalid");
  }
  const targetSealPath = join(generationRoot, TWEAKERS_MANAGER_SEAL_NAME);
  const managerBundlePath = join(generationRoot, TWEAKERS_MANAGER_BUNDLE_NAME);
  const managerLauncherPath = join(generationRoot, TWEAKERS_MANAGER_LAUNCHER_NAME);
  assertExactPrivateMode(targetSealPath, PRIVATE_SEALED_DATA_MODE, "manager-target-seal");
  assertExactPrivateMode(managerBundlePath, PRIVATE_SEALED_DATA_MODE, "manager-bundle");
  assertExactPrivateMode(managerLauncherPath, PRIVATE_EXECUTOR_MODE, "manager-launcher");
  const targetSeal = sealFile(targetSealPath, "manager-target-seal");
  const managerBundle = sealFile(managerBundlePath, "manager-bundle");
  const managerLauncher = sealFile(managerLauncherPath, "manager-launcher");
  const parsedSeal = parseManagerTargetSeal(targetSealPath);
  if (parsedSeal.generationId !== basename(generationRoot)
    || parsedSeal.managerSha256 !== stripFingerprint(managerBundle.sha256)
    || parsedSeal.launcherSha256 !== stripFingerprint(managerLauncher.sha256)) {
    fail("manager-generation-target-seal-mismatch");
  }
  const node = sealManagerNode(parsedSeal.nodePath);
  if (parsedSeal.nodeSha256 !== stripFingerprint(node.sha256)) fail("manager-generation-node-mismatch");
  return {
    generationRoot,
    generationId: parsedSeal.generationId,
    targetSeal,
    node,
    managerBundle,
    managerLauncher,
  };
}

function parseManagerTargetSeal(path: string): TweakersManagerTargetSealV1 {
  const bytes = readPrivateBytes(path, MAX_PRIVATE_FILE_BYTES, "manager-target-seal");
  try {
    return parseTweakersManagerTargetSeal(bytes.toString("utf8"));
  } catch {
    fail("manager-target-seal-invalid");
  } finally {
    bytes.fill(0);
  }
}

function sealManagerNode(pathValue: string): OfflineMigrationSealedFile {
  const path = exactAbsolute(pathValue, "invalid-manager-node-path");
  assertSafeManagerNodeAncestors(dirname(path));
  const stat = lstatNoFollow(path, "manager-node");
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)
    || (stat.mode & 0o022) !== 0 || (stat.mode & 0o7000) !== 0 || (stat.mode & 0o111) === 0) {
    fail("manager-node-not-sealed-executable");
  }
  assertCanonicalPath(path, "manager-node");
  if (stat.size > MAX_MANAGER_NODE_BYTES) fail("manager-node-capacity-exceeded");
  return { path, bytes: stat.size, sha256: fingerprintPrivateFile(path, stat, "manager-node") };
}

function assertSafeManagerNodeAncestors(path: string): void {
  const uid = process.getuid?.();
  let current = exactAbsolute(path, "invalid-manager-node-parent");
  while (true) {
    const stat = lstatNoFollow(current, "manager-node-parent");
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)
      || (stat.mode & 0o022) !== 0) {
      fail("manager-node-parent-not-safe");
    }
    assertCanonicalPath(current, "manager-node-parent");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertExactPrivateMode(path: string, mode: number, label: string): void {
  const stat = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(stat, label);
  if ((stat.mode & 0o7777) !== mode) fail(`${label}-mode-invalid`);
  assertCanonicalPath(path, label);
}

function stripFingerprint(value: Sha256Fingerprint): string {
  return value.slice("sha256:".length);
}

function sealInventories(paths: readonly string[]): readonly OfflineMigrationSealedFile[] {
  const normalized = normalizePaths(paths, "invalid-sealed-inventories");
  const inventories = normalized.map((path) => sealFile(path, "sealed-inventory"));
  if (inventories.length === 0) fail("sealed-inventory-required");
  return inventories.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function sealTweakersPromotion(
  pathValue: string,
  expectedFingerprint: Sha256Fingerprint,
  expectedAppRoot: string,
  expectedBrokerRoot: string,
): OfflineMigrationTweakersPromotionBinding {
  const path = exactAbsolute(pathValue, "invalid-tweakers-promotion-receipt");
  const receipt = sealFile(path, "tweakers-promotion-receipt");
  if (receipt.sha256 !== fingerprint(expectedFingerprint, "invalid-tweakers-promotion-fingerprint")) {
    fail("tweakers-promotion-fingerprint-mismatch");
  }
  const value = readPrivateJson(path, MAX_PRIVATE_FILE_BYTES, "tweakers-promotion-receipt");
  assertCurrentTweakersRuntimeReadyReceipt(value, expectedAppRoot, expectedBrokerRoot);
  return {
    receipt,
    operationId: value.operationId,
    promotionId: value.promotionId,
    activePromotionReceiptSha256: String(value.activePromotionReceiptSha256).toLowerCase(),
    pid: value.pid,
    processStartToken: value.processStartToken,
    runtimeFingerprint: String(value.runtimeFingerprint).toLowerCase(),
    appAsarHeaderHash: String(value.appAsarHeaderHash).toLowerCase(),
    appRoot: expectedAppRoot,
    bundleId: TWEAKERS_VARIANT_BUNDLE_ID,
    appUserDataRoot: value.appUserDataRoot,
    codexHomeRoot: value.codexHomeRoot,
    accountsBrokerRoot: value.accountsBrokerRoot,
    brokerAuthorityExpectation: {
      globalRootState: "absent",
      configSha256: null,
    },
    appearance: { status: "normal", normalized: true },
    observedAt: value.observedAt,
  };
}

/**
 * This is deliberately a prepare-time proof only. The user is expected to
 * close Tweakers before the one-shot worker applies the migration, so checking
 * this live PID again from the LaunchAgent would reject the intended window.
 */
function assertPromotionCurrentAtPrepare(
  promotion: OfflineMigrationTweakersPromotionBinding,
  now: () => string,
  probe: (input: OfflineMigrationTweakersRuntimeReadyProbeInput) => OfflineMigrationTweakersRuntimeReadyProbeResult,
): void {
  const preparedAt = canonicalNow(now());
  const receiptObservedAt = Date.parse(promotion.observedAt);
  const preparedAtMs = Date.parse(preparedAt);
  if (receiptObservedAt > preparedAtMs || preparedAtMs - receiptObservedAt > MAX_RUNTIME_READY_RECEIPT_AGE_MS) {
    fail("tweakers-runtime-ready-receipt-stale");
  }
  const current = probe({
    receiptPath: promotion.receipt.path,
    runtimeRoot: join(dirname(promotion.receipt.path), "runtime"),
    appRoot: promotion.appRoot,
    expectedPid: promotion.pid,
  });
  if (current.process === null || current.process.pid !== promotion.pid) {
    fail("tweakers-runtime-ready-process-not-current");
  }
  if (current.process.processStartToken !== promotion.processStartToken) {
    fail("tweakers-runtime-ready-process-start-token-mismatch");
  }
  // The signed wrapper execs the preserved Electron binary in place. The
  // runtime-ready PID therefore belongs to that post-exec process, not to the
  // short-lived wrapper named by CFBundleExecutable. Bind both the exact
  // bundle-local executable and the signed singleton/user-data argument; do
  // not accept a helper, a bare Electron process, or caller-supplied extras.
  const expectedCommand = `${join(
    promotion.appRoot,
    "Contents",
    "MacOS",
    TWEAKERS_ORIGINAL_EXECUTABLE,
  )} --user-data-dir=${promotion.appUserDataRoot}`;
  if (current.process.command !== expectedCommand) {
    fail("tweakers-runtime-ready-main-command-mismatch");
  }
  if (current.appAsarHeaderHash?.toLowerCase() !== promotion.appAsarHeaderHash) {
    fail("tweakers-runtime-ready-asar-fingerprint-mismatch");
  }
  if (current.runtimeFingerprint?.toLowerCase() !== promotion.runtimeFingerprint) {
    fail("tweakers-runtime-ready-runtime-fingerprint-mismatch");
  }
}

function defaultRuntimeReadyProbe(
  input: OfflineMigrationTweakersRuntimeReadyProbeInput,
): OfflineMigrationTweakersRuntimeReadyProbeResult {
  let process: OfflineMigrationTweakersRuntimeReadyProbeResult["process"] = null;
  try {
    const result = spawnSync("/bin/ps", ["-p", String(input.expectedPid), "-o", "pid=,lstart=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = result.status === 0 && typeof result.stdout === "string"
      ? result.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? ""
      : "";
    const match = /^\s*(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
    if (match !== null && Number.isSafeInteger(Number(match[1]))) {
      process = {
        pid: Number(match[1]),
        processStartToken: match[2]!.trim(),
        command: match[3]!,
      };
    }
  } catch {
    process = null;
  }
  let appAsarHeaderHash: string | null = null;
  try {
    appAsarHeaderHash = readHeaderHash(join(input.appRoot, "Contents", "Resources", "app.asar")).headerHash.toLowerCase();
  } catch {
    appAsarHeaderHash = null;
  }
  const runtimeFingerprint = readRuntimeFingerprintEvidence(input.runtimeRoot)?.fingerprint.toLowerCase() ?? null;
  return { process, appAsarHeaderHash, runtimeFingerprint };
}

function verifyContextSeals(
  context: OfflineMigrationLauncherContextV1,
  dependencies: Pick<OfflineMigrationLauncherDependencies, "inspectCapacityReceipt">,
): void {
  const capacityReceipt = inspectCapacityReceipt(context.migration, dependencies);
  if (context.capacityReceipt === undefined
    || canonicalJson(capacityReceipt) !== canonicalJson(context.capacityReceipt)) {
    fail("shared-history-capacity-receipt-changed-after-prepare");
  }
  const executor = sealManagerGeneration({ generationRoot: context.executor.generationRoot });
  if (!sameManagerExecutorBinding(executor, context.executor)) fail("manager-generation-changed-after-prepare");
  assertOwnerControlledDirectory(context.migration.legacyDefinitionsRoot, "legacy-definitions-root");
  const expectedInventory = new Map(context.inventories.map((entry) => [entry.path, entry]));
  if (!expectedInventory.has(context.migration.sharedPluginInventory)) fail("shared-plugin-inventory-not-sealed");
  if (!expectedInventory.has(capacityReceipt.receipt.path)) fail("shared-history-capacity-receipt-not-sealed");
  for (const entry of context.inventories) {
    const current = sealFile(entry.path, "sealed-inventory");
    if (current.bytes !== entry.bytes || current.sha256 !== entry.sha256) fail("sealed-inventory-changed-after-prepare");
  }
  const promotion = sealTweakersPromotion(
    context.promotion.receipt.path,
    context.promotion.receipt.sha256,
    context.migration.tweakersAppPath,
    context.migration.globalRoot,
  );
  if (promotion.operationId !== context.promotion.operationId
    || promotion.promotionId !== context.promotion.promotionId
    || promotion.activePromotionReceiptSha256 !== context.promotion.activePromotionReceiptSha256
    || promotion.pid !== context.promotion.pid
    || promotion.processStartToken !== context.promotion.processStartToken
    || promotion.runtimeFingerprint !== context.promotion.runtimeFingerprint
    || promotion.appAsarHeaderHash !== context.promotion.appAsarHeaderHash
    || promotion.appRoot !== context.promotion.appRoot
    || promotion.bundleId !== context.promotion.bundleId
    || promotion.appUserDataRoot !== context.promotion.appUserDataRoot
    || promotion.codexHomeRoot !== context.promotion.codexHomeRoot
    || promotion.accountsBrokerRoot !== context.promotion.accountsBrokerRoot
    || !sameNormalizedAppearanceBinding(promotion.appearance, context.promotion.appearance)
    || promotion.observedAt !== context.promotion.observedAt
    || !sameBrokerAuthorityExpectation(
      promotion.brokerAuthorityExpectation,
      context.promotion.brokerAuthorityExpectation,
    )) {
    fail("tweakers-promotion-changed-after-prepare");
  }
}

function sameManagerExecutorBinding(
  left: OfflineMigrationManagerExecutorBinding,
  right: OfflineMigrationManagerExecutorBinding,
): boolean {
  return left.generationRoot === right.generationRoot
    && left.generationId === right.generationId
    && sameSealedFile(left.targetSeal, right.targetSeal)
    && sameSealedFile(left.node, right.node)
    && sameSealedFile(left.managerBundle, right.managerBundle)
    && sameSealedFile(left.managerLauncher, right.managerLauncher);
}

function sameSealedFile(left: OfflineMigrationSealedFile, right: OfflineMigrationSealedFile): boolean {
  return left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
}

function assertNotConsumedBeforeApply(
  context: OfflineMigrationLauncherContextV1,
  options: { allowCurrentWaiting?: boolean; allowCurrentAttempt?: boolean } = {},
): void {
  assertPrivateDirectory(dirname(context.migration.globalRoot), "global-v3-parent");
  const paths = offlineMigrationLauncherPaths(context.launcherRoot);
  if (existsNoFollow(paths.terminalResult)) fail("terminal-result-already-exists");
  if (!options.allowCurrentWaiting && existsNoFollow(paths.waiting)) fail("interrupted-wait-requires-manual-recovery");
  if (!options.allowCurrentAttempt && existsNoFollow(paths.attempt)) fail("interrupted-attempt-requires-manual-recovery");
  if (existsNoFollow(context.migrationJournalPath)) fail("shared-history-migration-journal-already-exists");
  if (existsNoFollow(context.migration.globalRoot)) fail("global-v3-root-already-exists");
}

function writeWaiting(context: OfflineMigrationLauncherContextV1, now: () => string): void {
  const path = offlineMigrationLauncherPaths(context.launcherRoot).waiting;
  writePrivateJsonNew(path, {
    version: 1,
    kind: "offline-migration-launcher-waiting",
    transactionId: context.transactionId,
    waitingAt: canonicalNow(now()),
  }, "launcher-waiting");
}

function writeAttempt(context: OfflineMigrationLauncherContextV1, now: () => string): void {
  const path = offlineMigrationLauncherPaths(context.launcherRoot).attempt;
  writePrivateJsonNew(path, {
    version: 1,
    kind: "offline-migration-launcher-attempt",
    transactionId: context.transactionId,
    startedAt: canonicalNow(now()),
  }, "launcher-attempt");
}

function terminalResult(
  context: OfflineMigrationLauncherContextV1,
  input: Omit<OfflineMigrationLauncherTerminalResultV1, "version" | "kind" | "transactionId" | "migrationJournalPath" | "globalRoot" | "committedAt"> & {
    now?: () => string;
  },
): OfflineMigrationLauncherTerminalResultV1 {
  return {
    version: 1,
    kind: "offline-migration-launcher-terminal-result",
    transactionId: context.transactionId,
    state: input.state,
    phase: input.phase,
    reason: input.reason,
    migrationJournalPath: context.migrationJournalPath,
    globalRoot: context.migration.globalRoot,
    firstCensus: input.firstCensus,
    secondCensus: input.secondCensus,
    migrationResult: input.migrationResult,
    rollback: input.rollback,
    committedAt: canonicalNow((input.now ?? (() => new Date().toISOString()))()),
  };
}

function armFailureResult(
  context: OfflineMigrationLauncherContextV1,
  result: OfflineMigrationLaunchctlResult,
  now: () => string,
): OfflineMigrationLauncherTerminalResultV1 {
  return terminalResult(context, {
    state: "arm-failed",
    phase: "arm",
    reason: result.error ?? `launchctl-status-${result.status ?? "unknown"}`,
    firstCensus: null,
    secondCensus: null,
    migrationResult: null,
    rollback: null,
    now,
  });
}

function writeTerminalResult(context: OfflineMigrationLauncherContextV1, result: OfflineMigrationLauncherTerminalResultV1): void {
  assertTerminalResult(result, context);
  const path = offlineMigrationLauncherPaths(context.launcherRoot).terminalResult;
  writePrivateJsonNew(path, result, "terminal-result");
}

function writeOriginProofDiagnostic(
  context: OfflineMigrationLauncherContextV1,
  error: unknown,
  now: () => string,
): void {
  const diagnostic: OfflineMigrationLauncherOriginProofDiagnosticV1 = {
    version: 1,
    kind: "offline-migration-launcher-origin-proof-diagnostic",
    transactionId: context.transactionId,
    phase: "origin-proof",
    reason: originProofDiagnosticReason(error),
    recordedAt: canonicalNow(now()),
  };
  try {
    // This is evidence only. O_EXCL makes a prior diagnostic immutable and
    // prevents a later failed invocation from overwriting its first cause.
    writePrivateJsonNew(
      offlineMigrationLauncherPaths(context.launcherRoot).originProofDiagnostic,
      diagnostic,
      "origin-proof-diagnostic",
    );
  } catch (diagnosticError) {
    // Preserve the original origin-proof failure when a prior diagnostic is
    // already present. Any other write failure remains a hard failure rather
    // than pretending that durable evidence was recorded.
    if (diagnosticError instanceof OfflineMigrationLauncherError
      && diagnosticError.code === "origin-proof-diagnostic-already-exists") return;
    throw diagnosticError;
  }
}

function originProofDiagnosticReason(error: unknown): string {
  const code = error instanceof OfflineMigrationLauncherError ? error.code : "origin-proof-failed";
  return /^[a-z0-9][a-z0-9-]{0,127}$/.test(code) ? code : "origin-proof-failed";
}

function readTerminalResultIfPresent(path: string): OfflineMigrationLauncherTerminalResultV1 | null {
  if (!existsNoFollow(path)) return null;
  const value = readPrivateJson(path, MAX_CONTEXT_BYTES, "terminal-result");
  assertTerminalResultShape(value);
  return value;
}

function readOriginProofDiagnosticIfPresent(
  path: string,
  context: OfflineMigrationLauncherContextV1,
): OfflineMigrationLauncherOriginProofDiagnosticV1 | null {
  if (!existsNoFollow(path)) return null;
  const value = readPrivateJson(path, MAX_CONTEXT_BYTES, "origin-proof-diagnostic");
  assertOriginProofDiagnostic(value, context);
  return value;
}

function assertRollbackBinding(binding: OfflineMigrationRollbackBinding, rollback: SharedHistoryRollbackView): void {
  if (binding.kind !== "global-v3-read-only-viewer"
    || binding.canonicalHistoryFile !== CANONICAL_HISTORY_FILE
    || binding.requiresBrokerWriteStop !== true
    || binding.legacyV2RestoreForbidden !== true
    || rollback.state !== "ready"
    || rollback.requiresBrokerWriteStop !== true
    || rollback.legacySqliteFlattened !== false
    || rollback.canonicalFingerprint === null) {
    fail("global-v3-rollback-binding-invalid");
  }
}

function assertMigratedEvidence(
  context: OfflineMigrationLauncherContextV1,
  result: SharedHistoryMigrationResult,
  rollback: SharedHistoryRollbackView,
): void {
  assertMigrationResultShape(result);
  assertRollbackViewShape(rollback);
  if (result.status !== "migrated"
    || result.transactionId !== context.transactionId
    || result.sourceFingerprint === null
    || result.candidateFingerprint === null
    || result.sharedSkillsFingerprint === null
    || result.sharedSkillsTrustedRootsFingerprint === null
    || result.sharedPluginsFingerprint === null
    || result.sharedPluginInventoryFingerprint === null
    || result.sharedPluginExclusionsFingerprint === null
    || result.nextAction !== "activate-remains-user-confirmed"
    || !sameStringArray(result.sharedSkillsTrustedRoots, context.migration.sharedSkillsRoots)
    || rollback.conversationCount !== result.conversationCount
    || rollback.segmentCount !== result.segmentCount) {
    fail("migrated-terminal-evidence-invalid");
  }
  assertRollbackBinding(context.rollback, rollback);
  assertMigratedJournalBinding(context, result, rollback);
}

function assertMigratedJournalBinding(
  context: OfflineMigrationLauncherContextV1,
  result: SharedHistoryMigrationResult,
  rollback: SharedHistoryRollbackView,
): void {
  assertPrivateDirectory(dirname(context.migration.globalRoot), "global-v3-parent");
  const artifactPaths = sharedHistoryMigrationArtifactPaths(context.migration.globalRoot, context.transactionId);
  const journal = readPrivateJson(
    context.migrationJournalPath,
    MAX_MIGRATION_JOURNAL_BYTES,
    "shared-history-migration-journal",
  );
  if (!isRecord(journal) || !hasExactKeys(journal, [
    "version", "kind", "id", "legacyRouterRoot", "legacyCodexRoot", "legacySqliteRoot", "globalRoot", "snapshotRoot",
    "candidateRoot", "quarantineRoot", "phase", "preAdoptionManifest", "preMigrationManifest", "candidateManifest", "canonical",
    "sharedSkills", "sharedPluginInventoryFingerprint", "sharedPluginExclusionsFingerprint", "sharedPlugins", "legacyDefinitionsRoot",
  ])
    || journal.version !== 2
    || journal.kind !== "shared-history-migration"
    || journal.id !== context.transactionId
    || journal.legacyRouterRoot !== context.migration.legacyRouterRoot
    || journal.legacyCodexRoot !== context.migration.legacyCodexRoot
    || journal.legacySqliteRoot !== context.migration.legacySqliteRoot
    || journal.legacyDefinitionsRoot !== context.migration.legacyDefinitionsRoot
    || journal.globalRoot !== context.migration.globalRoot
    || journal.snapshotRoot !== artifactPaths.snapshotRoot
    || journal.candidateRoot !== artifactPaths.candidateRoot
    || journal.quarantineRoot !== artifactPaths.quarantineRoot
    || journal.phase !== "published") {
    fail("migrated-terminal-journal-binding-invalid");
  }

  // The journal has crossed the publication boundary, so every phase-required
  // nested record must be present and validate exactly as the shared-history
  // reader would validate it. A shallow fingerprint comparison lets forged
  // self-consistent records masquerade as durable migration evidence.
  parseMigrationTreeManifest(journal.preAdoptionManifest);
  const preMigrationManifest = parseMigrationTreeManifest(journal.preMigrationManifest);
  const candidateManifest = parseMigrationTreeManifest(journal.candidateManifest);
  const canonical = parseMigrationCanonicalSummary(journal.canonical);
  const sharedSkills = parseMigrationSharedSkillsManifest(journal.sharedSkills);
  const sharedPlugins = parseMigrationSharedPluginsManifest(journal.sharedPlugins);
  const trustedRoots = currentMigrationSharedSkillsTrustedRoots(context.migration.sharedSkillsRoots);
  const inventory = readMigrationSharedPluginInventory(context.migration.sharedPluginInventory);
  const inventoryFingerprint = canonicalSha256Fingerprint(inventory);

  if (preMigrationManifest.fingerprint !== result.sourceFingerprint
    || candidateManifest.fingerprint !== result.candidateFingerprint
    || canonical.fingerprint !== rollback.canonicalFingerprint
    || canonical.conversationCount !== result.conversationCount
    || canonical.segmentCount !== result.segmentCount
    || !sameMigrationTrustedRoots(sharedSkills.trustedRoots, trustedRoots)
    || !sameStringArray(sharedSkills.trustedRoots.map((entry) => entry.path), context.migration.sharedSkillsRoots)
    || !sameStringArray(sharedSkills.trustedRoots.map((entry) => entry.path), result.sharedSkillsTrustedRoots)
    || sharedSkills.fingerprint !== result.sharedSkillsFingerprint
    || sharedSkills.trustedRootsFingerprint !== result.sharedSkillsTrustedRootsFingerprint
    || journal.sharedPluginInventoryFingerprint !== inventoryFingerprint
    || journal.sharedPluginInventoryFingerprint !== result.sharedPluginInventoryFingerprint
    || journal.sharedPluginExclusionsFingerprint !== result.sharedPluginExclusionsFingerprint
    || sharedPlugins.fingerprint !== result.sharedPluginsFingerprint
    || sharedPlugins.inventoryFingerprint !== journal.sharedPluginInventoryFingerprint
    || sharedPlugins.exclusionsFingerprint !== journal.sharedPluginExclusionsFingerprint
    || !sameMigrationPluginPackageProjection(sharedPlugins.packages, inventory.plugins)
    || !sameMigrationPluginPackageProjection(sharedPlugins.packages, result.sharedPluginPackages)
    || !sameStringArray(sharedPlugins.packages.map((entry) => entry.pluginId), result.sharedPluginIds)) {
    fail("migrated-terminal-journal-binding-invalid");
  }
}

function parseMigrationTreeManifest(value: unknown): MigrationTreeManifest {
  if (!isRecord(value) || !hasExactKeys(value, ["directories", "files", "links", "fingerprint"])
    || !Array.isArray(value.directories) || !Array.isArray(value.files) || !Array.isArray(value.links)
    || !isFingerprint(value.fingerprint)) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  if (value.directories.length + value.files.length + value.links.length > MAX_MIGRATION_TREE_FILES) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const directories: string[] = [];
  let prior = "";
  for (const directory of value.directories) {
    if (typeof directory !== "string" || !isMigrationSafeRelativePath(directory)
      || (prior && compareCodeUnits(prior, directory) >= 0)) {
      fail("migrated-terminal-journal-binding-invalid");
    }
    directories.push(directory);
    prior = directory;
  }
  const files: MigrationTreeManifestEntry[] = [];
  prior = "";
  let totalBytes = 0;
  for (const entry of value.files) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "bytes", "sha256"])
      || typeof entry.path !== "string" || !isMigrationSafeRelativePath(entry.path)
      || !isNonNegativeInteger(entry.bytes) || !isFingerprint(entry.sha256)
      || (prior && compareCodeUnits(prior, entry.path) >= 0)) {
      fail("migrated-terminal-journal-binding-invalid");
    }
    totalBytes += entry.bytes;
    if (totalBytes > MAX_MIGRATION_TREE_BYTES) fail("migrated-terminal-journal-binding-invalid");
    files.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
    prior = entry.path;
  }
  const links: MigrationTreeManifestLink[] = [];
  prior = "";
  for (const entry of value.links) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "target"])
      || typeof entry.path !== "string" || !isMigrationSafeRelativePath(entry.path)
      || entry.target !== "../../../../shared-plugins/cache"
      || (prior && compareCodeUnits(prior, entry.path) >= 0)) {
      fail("migrated-terminal-journal-binding-invalid");
    }
    links.push({ path: entry.path, target: "../../../../shared-plugins/cache" });
    prior = entry.path;
  }
  const normalized = { directories, files, links };
  if (canonicalSha256Fingerprint(normalized) !== value.fingerprint) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return { ...normalized, fingerprint: value.fingerprint };
}

function parseMigrationCanonicalSummary(value: unknown): {
  fingerprint: Sha256Fingerprint;
  conversationCount: number;
  segmentCount: number;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["fingerprint", "conversationCount", "segmentCount"])
    || !isFingerprint(value.fingerprint)
    || !isNonNegativeInteger(value.conversationCount)
    || !isNonNegativeInteger(value.segmentCount)) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return {
    fingerprint: value.fingerprint,
    conversationCount: value.conversationCount,
    segmentCount: value.segmentCount,
  };
}

function parseMigrationSharedSkillsManifest(value: unknown): MigrationSharedSkillsManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "directories", "files", "trustedRoots", "trustedRootsFingerprint", "fingerprint",
  ])
    || value.version !== 1
    || value.kind !== "account-router-shared-skills"
    || !Array.isArray(value.directories)
    || !Array.isArray(value.files)
    || !Array.isArray(value.trustedRoots)
    || !isFingerprint(value.trustedRootsFingerprint)
    || !isFingerprint(value.fingerprint)) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const directories = value.directories.map((entry) => typeof entry === "string"
    && isMigrationSafeRelativePath(entry)
    && entry.split("/").every(isMigrationSafeSharedSkillsName)
    ? entry
    : null);
  const files = value.files.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "bytes", "sha256"])
      || typeof entry.path !== "string" || !isMigrationSafeRelativePath(entry.path)
      || !entry.path.split("/").every(isMigrationSafeSharedSkillsName)
      || !isNonNegativeInteger(entry.bytes) || !isFingerprint(entry.sha256)) {
      return null;
    }
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 } as MigrationTreeManifestEntry;
  });
  const trustedRoots = value.trustedRoots.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "device", "inode", "uid", "mode"])
      || typeof entry.path !== "string" || !isExactAbsolute(entry.path)
      || !isNonNegativeInteger(entry.device) || !isNonNegativeInteger(entry.inode)
      || !isNonNegativeInteger(entry.uid) || !isNonNegativeInteger(entry.mode)
      || entry.mode > 0o777 || (entry.mode & 0o022) !== 0) {
      return null;
    }
    return {
      path: entry.path,
      device: entry.device,
      inode: entry.inode,
      uid: entry.uid,
      mode: entry.mode,
    } as MigrationSharedSkillsTrustedRoot;
  });
  if (directories.some((entry) => entry === null)
    || files.some((entry) => entry === null)
    || trustedRoots.some((entry) => entry === null)
    || directories.length > MAX_SHARED_SKILLS_FILES
    || files.length > MAX_SHARED_SKILLS_FILES
    || trustedRoots.length > 128
    || files.reduce((total, entry) => total + (entry?.bytes ?? 0), 0) > MAX_SHARED_SKILLS_BYTES) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const normalized = {
    directories: [...directories as string[]].sort(compareCodeUnits),
    files: [...files as MigrationTreeManifestEntry[]].sort((left, right) => compareCodeUnits(left.path, right.path)),
    trustedRoots: [...trustedRoots as MigrationSharedSkillsTrustedRoot[]].sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
  if (new Set(normalized.directories).size !== normalized.directories.length
    || new Set(normalized.files.map((entry) => entry.path)).size !== normalized.files.length
    || new Set(normalized.trustedRoots.map((entry) => entry.path)).size !== normalized.trustedRoots.length
    || canonicalSha256Fingerprint(normalized.trustedRoots) !== value.trustedRootsFingerprint
    || canonicalSha256Fingerprint({ ...normalized, trustedRootsFingerprint: value.trustedRootsFingerprint }) !== value.fingerprint) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return {
    version: 1,
    kind: "account-router-shared-skills",
    ...normalized,
    trustedRootsFingerprint: value.trustedRootsFingerprint,
    fingerprint: value.fingerprint,
  };
}

function currentMigrationSharedSkillsTrustedRoots(paths: readonly string[]): readonly MigrationSharedSkillsTrustedRoot[] {
  const roots: MigrationSharedSkillsTrustedRoot[] = [];
  for (const path of paths) {
    if (!isExactAbsolute(path)) fail("migrated-terminal-journal-binding-invalid");
    let canonical: string;
    let stat: Stats;
    try {
      canonical = realpathSync.native(path);
      stat = lstatSync(path);
    } catch {
      fail("migrated-terminal-journal-binding-invalid");
    }
    const uid = process.getuid?.();
    if (canonical !== path
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || (uid !== undefined && stat.uid !== uid)
      || (stat.mode & 0o022) !== 0) {
      fail("migrated-terminal-journal-binding-invalid");
    }
    roots.push({ path, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 });
  }
  roots.sort((left, right) => compareCodeUnits(left.path, right.path));
  if (roots.length > 128 || new Set(roots.map((root) => root.path)).size !== roots.length) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return roots;
}

function sameMigrationTrustedRoots(
  left: readonly MigrationSharedSkillsTrustedRoot[],
  right: readonly MigrationSharedSkillsTrustedRoot[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function readMigrationSharedPluginInventory(path: string): MigrationSharedPluginInventory {
  try {
    return parseMigrationSharedPluginInventory(readPrivateJson(path, MAX_SHARED_PLUGIN_INVENTORY_BYTES, "shared-plugin-inventory"));
  } catch {
    fail("migrated-terminal-journal-binding-invalid");
  }
}

function parseMigrationSharedPluginInventory(value: unknown): MigrationSharedPluginInventory {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "plugins"])
    || value.version !== 1 || !Array.isArray(value.plugins)
    || value.plugins.length === 0 || value.plugins.length > MAX_SHARED_PLUGIN_PACKAGES) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const plugins: { pluginId: string; version: string }[] = [];
  let prior = "";
  for (const entry of value.plugins) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["pluginId", "version"])
      || typeof entry.pluginId !== "string" || !isMigrationSharedPluginId(entry.pluginId)
      || typeof entry.version !== "string" || !isMigrationSafeSharedPluginVersion(entry.version)
      || (prior && compareCodeUnits(prior, entry.pluginId) >= 0)) {
      fail("migrated-terminal-journal-binding-invalid");
    }
    plugins.push({ pluginId: entry.pluginId, version: entry.version });
    prior = entry.pluginId;
  }
  return { version: 1, plugins };
}

function parseMigrationSharedPluginsManifest(value: unknown): MigrationSharedPluginsManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "inventoryFingerprint", "exclusionsFingerprint", "packages", "fingerprint",
  ])
    || value.version !== 1
    || value.kind !== "account-router-shared-plugins"
    || !isFingerprint(value.inventoryFingerprint)
    || !isFingerprint(value.exclusionsFingerprint)
    || !Array.isArray(value.packages)
    || !isFingerprint(value.fingerprint)) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const packages = value.packages.map((entry) => parseMigrationSharedPluginPackage(entry));
  if (packages.length === 0 || packages.length > MAX_SHARED_PLUGIN_PACKAGES) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const normalized = [...packages].sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId));
  if (new Set(normalized.map((entry) => entry.pluginId)).size !== normalized.length
    || migrationSharedPluginExclusionsFingerprint(normalized) !== value.exclusionsFingerprint
    || canonicalSha256Fingerprint({
      inventoryFingerprint: value.inventoryFingerprint,
      exclusionsFingerprint: value.exclusionsFingerprint,
      packages: normalized,
    }) !== value.fingerprint) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return {
    version: 1,
    kind: "account-router-shared-plugins",
    inventoryFingerprint: value.inventoryFingerprint,
    exclusionsFingerprint: value.exclusionsFingerprint,
    packages: normalized,
    fingerprint: value.fingerprint,
  };
}

function parseMigrationSharedPluginPackage(value: unknown): MigrationSharedPluginPackage {
  if (!isRecord(value) || !hasExactKeys(value, [
    "pluginId", "registry", "name", "version", "fingerprint", "exclusionsFingerprint", "excludedFiles", "fileCount", "bytes",
  ])
    || typeof value.pluginId !== "string" || !isMigrationSharedPluginId(value.pluginId)
    || typeof value.registry !== "string" || typeof value.name !== "string" || value.pluginId !== `${value.name}@${value.registry}`
    || typeof value.version !== "string" || !isMigrationSafeSharedPluginVersion(value.version)
    || !isFingerprint(value.fingerprint) || !isFingerprint(value.exclusionsFingerprint)
    || !Array.isArray(value.excludedFiles)
    || !isNonNegativeInteger(value.fileCount) || !isNonNegativeInteger(value.bytes)) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  const excludedFiles = value.excludedFiles.map((entry) => parseMigrationSharedPluginExcludedFile(entry));
  const normalizedExcluded = [...excludedFiles].sort((left, right) => compareCodeUnits(left.path, right.path));
  if (new Set(normalizedExcluded.map((entry) => entry.path)).size !== normalizedExcluded.length
    || canonicalSha256Fingerprint(normalizedExcluded) !== value.exclusionsFingerprint) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return {
    pluginId: value.pluginId,
    registry: value.registry,
    name: value.name,
    version: value.version,
    fingerprint: value.fingerprint,
    exclusionsFingerprint: value.exclusionsFingerprint,
    excludedFiles: normalizedExcluded,
    fileCount: value.fileCount,
    bytes: value.bytes,
  };
}

function parseMigrationSharedPluginExcludedFile(value: unknown): MigrationSharedPluginExcludedFile {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "bytes", "sha256", "reason"])
    || typeof value.path !== "string" || !isNonNegativeInteger(value.bytes)
    || !isFingerprint(value.sha256)
    || (value.reason !== "credential" && value.reason !== "transient-lock")
    || !isValidMigrationSharedPluginExclusion({
      path: value.path,
      bytes: value.bytes,
      sha256: value.sha256,
      reason: value.reason,
    })) {
    fail("migrated-terminal-journal-binding-invalid");
  }
  return { path: value.path, bytes: value.bytes, sha256: value.sha256, reason: value.reason };
}

function migrationSharedPluginExclusionsFingerprint(packages: readonly MigrationSharedPluginPackage[]): Sha256Fingerprint {
  const exclusions = packages.flatMap((entry) => entry.excludedFiles.map((file) => ({ pluginId: entry.pluginId, ...file })))
    .sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId) || compareCodeUnits(left.path, right.path));
  return canonicalSha256Fingerprint(exclusions) as Sha256Fingerprint;
}

function isValidMigrationSharedPluginExclusion(value: MigrationSharedPluginExcludedFile): boolean {
  return value.reason === "credential"
    ? isMigrationSharedPluginExcludedPath(value.path)
    : value.path === ".venv/.lock" && value.bytes === 0 && value.sha256 === EMPTY_SHA256_FINGERPRINT;
}

function isMigrationSharedPluginExcludedPath(value: string): boolean {
  const components = value.split("/");
  return components.length > 0 && components.every(isMigrationSafeSharedPluginName)
    && components.at(-1) !== "config.toml" && isMigrationSharedPluginCredentialName(components.at(-1)!);
}

function isMigrationSafeSharedPluginName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function isMigrationSafeSharedPluginVersion(value: string): boolean {
  return isMigrationSafeSharedPluginName(value);
}

function isMigrationSharedPluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function isMigrationSharedPluginCredentialName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.")
    || [
      "env", "env_vars", "auth", "auth.json", "authorization.json", "cookies", "cookies.json", "credentials", "credentials.json",
      "oauth", "oauth.json", "token", "token.json", "tokens", "tokens.json", "secret.json", "secrets.json", "client_secret.json",
      "api-key.json", "api_key.json", ".netrc", "config.toml",
    ].includes(normalized)
    || normalized.endsWith(".sqlite");
}

function isMigrationSafeSharedSkillsName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value)
    && !isMigrationSharedSkillsCredentialFileName(value);
}

function isMigrationSharedSkillsCredentialFileName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.") || [
    "auth.json", "authorization.json", "cookies.json", "credentials.json", "oauth.json",
    "token.json", "tokens.json", "client_secret.json", ".netrc", ".npmrc",
  ].includes(normalized);
}

function isMigrationSafeRelativePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"));
}

function sameMigrationPluginPackageProjection(
  left: readonly { pluginId: string; version: string }[],
  right: readonly { pluginId: string; version: string }[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.pluginId === right[index]?.pluginId && entry.version === right[index]?.version);
}

function sharedHistoryMigrationArtifactPaths(globalRoot: string, transactionId: string): {
  snapshotRoot: string;
  candidateRoot: string;
  quarantineRoot: string;
} {
  const parent = dirname(globalRoot);
  const base = basename(globalRoot);
  if (!base || base === "." || base === "..") fail("invalid-global-root");
  return {
    snapshotRoot: join(parent, `.${base}.shared-history-pre-migration-${transactionId}`),
    candidateRoot: join(parent, `.${base}.shared-history-candidate-${transactionId}`),
    quarantineRoot: join(parent, `.${base}.shared-history-quarantine-${transactionId}`),
  };
}

function assertMigrationResultShape(value: unknown): asserts value is SharedHistoryMigrationResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "status", "transactionId", "sourceFingerprint", "candidateFingerprint", "conversationCount", "segmentCount",
    "sharedSkillsFingerprint", "sharedSkillsTrustedRoots", "sharedSkillsTrustedRootsFingerprint", "sharedPluginsFingerprint",
    "sharedPluginInventoryFingerprint", "sharedPluginExclusionsFingerprint", "sharedPluginIds", "sharedPluginPackages", "nextAction",
  ])
    || !["dry-run", "adoption-required", "migrated", "already-published", "collision-quarantined", "recovered"].includes(String(value.status))
    || !(typeof value.transactionId === "string" || value.transactionId === null)
    || !isFingerprintOrNull(value.sourceFingerprint)
    || !isFingerprintOrNull(value.candidateFingerprint)
    || !isNonNegativeInteger(value.conversationCount)
    || !isNonNegativeInteger(value.segmentCount)
    || !isFingerprintOrNull(value.sharedSkillsFingerprint)
    || !isCanonicalPathArray(value.sharedSkillsTrustedRoots)
    || !isFingerprintOrNull(value.sharedSkillsTrustedRootsFingerprint)
    || !isFingerprintOrNull(value.sharedPluginsFingerprint)
    || !isFingerprintOrNull(value.sharedPluginInventoryFingerprint)
    || !isFingerprintOrNull(value.sharedPluginExclusionsFingerprint)
    || !isStringSet(value.sharedPluginIds)
    || !isSharedPluginPackageArray(value.sharedPluginPackages)
    || ![
      "apply-offline-migration", "initialize-v2-adoption-first", "complete-v2-adoption-first",
      "activate-remains-user-confirmed", "inspect-retained-evidence", "none",
    ].includes(String(value.nextAction))) {
    fail("invalid-migrated-result");
  }
  const packages = value.sharedPluginPackages as readonly { pluginId: string; version: string }[];
  const ids = value.sharedPluginIds as readonly string[];
  if (!sameStringArray(ids, packages.map((entry) => entry.pluginId))) fail("invalid-migrated-result");
}

function assertRollbackViewShape(value: unknown): asserts value is SharedHistoryRollbackView {
  if (!isRecord(value) || !hasExactKeys(value, [
    "state", "canonicalFingerprint", "conversationCount", "segmentCount", "requiresBrokerWriteStop", "legacySqliteFlattened",
  ])
    || !["ready", "missing", "invalid"].includes(String(value.state))
    || !isFingerprintOrNull(value.canonicalFingerprint)
    || !isNonNegativeInteger(value.conversationCount)
    || !isNonNegativeInteger(value.segmentCount)
    || value.requiresBrokerWriteStop !== true
    || value.legacySqliteFlattened !== false) {
    fail("invalid-rollback-view");
  }
}

function isFingerprintOrNull(value: unknown): value is Sha256Fingerprint | null {
  return value === null || isFingerprint(value);
}

function isCanonicalPathArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((entry) => isCanonicalAbsoluteString(entry))
    && isSortedUnique(value);
}

function isStringSet(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/.test(entry))
    && isSortedUnique(value);
}

function isSharedPluginPackageArray(value: unknown): value is readonly { pluginId: string; version: string }[] {
  return Array.isArray(value)
    && value.every((entry) => isRecord(entry)
      && hasExactKeys(entry, ["pluginId", "version"])
      && typeof entry.pluginId === "string"
      && /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.pluginId)
      && typeof entry.version === "string"
      && entry.version.length > 0
      && entry.version.length <= 128
      && !/[\u0000-\u001f\u007f]/.test(entry.version))
    && isSortedUnique(value.map((entry) => (entry as { pluginId: string }).pluginId));
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((entry, index) => index === 0 || compareCodeUnits(values[index - 1]!, entry) < 0);
}

function assertInternalRunner(
  context: OfflineMigrationLauncherContextV1,
  contextSeal: OfflineMigrationSealedFile,
  invocation: OfflineMigrationManagerRunInvocation,
  dependencies: OfflineMigrationLauncherDependencies,
): void {
  assertManagerInvocation(context, contextSeal, invocation);
  assertExactPlist(context, contextSeal);
  const route = (dependencies.currentExecutionRoute ?? currentManagerExecutionRoute)();
  const selfPid = (dependencies.currentProcessId ?? (() => process.pid))();
  const parentPid = (dependencies.currentParentProcessId ?? (() => process.ppid))();
  const expectedArgv = managerRunArguments(context, contextSeal);
  if (!isPositiveSafeInteger(selfPid)
    || parentPid !== 1
    || route.pid !== selfPid
    || route.nodePath !== context.executor.node.path
    || route.managerBundlePath !== context.executor.managerBundle.path
    || !sameStringArray(route.argv, expectedArgv.slice(2))) {
    fail("internal-manager-execution-route-mismatch");
  }
  const launchctl = dependencies.launchctl ?? systemLaunchctl();
  const service = `${launchdDomain()}/${context.label}`;
  const printed = launchctl.print(service);
  const identity = parseLaunchdServiceIdentity(printed, service);
  if (printed.status !== 0
    || identity.state !== "running"
    || identity.pid !== selfPid
    || identity.path !== context.plistPath
    || identity.program !== context.executor.node.path
    || !sameStringArray(identity.arguments, expectedArgv)) {
    fail("internal-manager-launchd-service-binding-mismatch");
  }
}

function assertManagerInvocation(
  context: OfflineMigrationLauncherContextV1,
  contextSeal: OfflineMigrationSealedFile,
  invocation: OfflineMigrationManagerRunInvocation,
): void {
  if (invocation.launcherRoot !== context.launcherRoot
    || invocation.contextBytes !== contextSeal.bytes
    || invocation.contextSha256 !== contextSeal.sha256) {
    fail("internal-manager-context-capability-mismatch");
  }
}

function managerInvocationFromCurrentProcess(): OfflineMigrationManagerRunInvocation {
  return parseManagerInvocation(process.argv.slice(2));
}

function parseManagerInvocation(argv: readonly string[]): OfflineMigrationManagerRunInvocation {
  if (!Array.isArray(argv)
    || argv.length !== 7
    || argv[0] !== OFFLINE_MIGRATION_MANAGER_RUN_COMMAND
    || argv[1] !== "--launcher-root"
    || argv[3] !== "--context-bytes"
    || argv[5] !== "--context-sha256") {
    fail("internal-manager-run-arguments-invalid");
  }
  const launcherRoot = exactAbsolute(argv[2] ?? "", "internal-manager-run-arguments-invalid");
  const contextBytesText = argv[4] ?? "";
  if (!/^[1-9][0-9]*$/.test(contextBytesText)) fail("internal-manager-run-arguments-invalid");
  const contextBytes = Number(contextBytesText);
  if (!Number.isSafeInteger(contextBytes) || contextBytes > MAX_CONTEXT_BYTES) {
    fail("internal-manager-run-arguments-invalid");
  }
  return {
    launcherRoot,
    contextBytes,
    contextSha256: fingerprint(argv[6] ?? "", "internal-manager-run-arguments-invalid"),
  };
}

function currentManagerExecutionRoute(): OfflineMigrationManagerExecutionRoute {
  return {
    pid: process.pid,
    nodePath: process.execPath,
    managerBundlePath: process.argv[1] ?? "",
    argv: process.argv.slice(2),
  };
}

function assertExactPlist(context: OfflineMigrationLauncherContextV1, contextSeal: OfflineMigrationSealedFile): void {
  const bytes = readPrivateBytes(context.plistPath, MAX_CONTEXT_BYTES, "launch-agent-plist");
  try {
    if (bytes.toString("utf8") !== launchAgentPlist(context, contextSeal)) {
      fail("launch-agent-plist-context-binding-mismatch");
    }
  } finally {
    bytes.fill(0);
  }
}

interface LaunchdServiceIdentity {
  state: string | null;
  pid: number | null;
  path: string | null;
  program: string | null;
  arguments: readonly string[] | null;
}

function parseLaunchdServiceIdentity(result: OfflineMigrationLaunchctlResult, service: string): LaunchdServiceIdentity {
  const output = result.output;
  if (typeof output !== "string") return { state: null, pid: null, path: null, program: null, arguments: null };
  const invalid = (): LaunchdServiceIdentity => ({ state: null, pid: null, path: null, program: null, arguments: null });
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== `${service} = {`) return invalid();
  const fields = new Map<string, string>();
  let argumentsList: readonly string[] | null = null;
  let closed = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "" || line === "}") {
      if (line === "}") {
        if (lines.slice(index + 1).some((entry) => entry.length > 0)) return invalid();
        closed = true;
        break;
      }
      continue;
    }
    const block = /^\t([a-z][a-z ]*) = \{$/.exec(line);
    if (block !== null) {
      const name = block[1]!;
      if (name !== "arguments") {
        const closingIndex = skipNestedLaunchdBlock(lines, index);
        if (closingIndex === null) return invalid();
        index = closingIndex;
        continue;
      }
      if (argumentsList !== null) return invalid();
      const parsed: string[] = [];
      index += 1;
      for (; index < lines.length && lines[index] !== "\t}"; index += 1) {
        const argument = /^\t\t([^\r\n]+)$/.exec(lines[index]!);
        if (argument === null) return invalid();
        parsed.push(argument[1]!);
      }
      if (lines[index] !== "\t}") return invalid();
      argumentsList = parsed;
      continue;
    }
    // `launchctl print` includes legitimate one-tab scalar keys with a
    // parenthesized qualifier (currently the jetsam active/inactive limits).
    // Keep the grammar narrow: identity extraction below still recognizes
    // only the exact state/pid/path/program keys, and malformed qualifiers
    // must continue to fail closed.
    const scalar = /^\t([a-z][a-z_ ]*(?:\((?:active|inactive)\))?) = (.+)$/.exec(line);
    if (scalar !== null) {
      const [, name, value] = scalar;
      if (["state", "pid", "path", "program"].includes(name!)) {
        if (fields.has(name!)) return invalid();
        fields.set(name!, value!);
      }
      continue;
    }
    return invalid();
  }
  if (!closed) return invalid();
  const state = fields.get("state") ?? null;
  const pidText = fields.get("pid") ?? null;
  const pid = pidText !== null && /^[1-9][0-9]*$/.test(pidText) && Number.isSafeInteger(Number(pidText))
    ? Number(pidText)
    : null;
  return { state, pid, path: fields.get("path") ?? null, program: fields.get("program") ?? null, arguments: argumentsList };
}

function skipNestedLaunchdBlock(lines: readonly string[], openingIndex: number): number | null {
  let depth = 1;
  for (let index = openingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^(\t+)([^\r\n]*)$/.exec(line);
    if (match === null) return null;
    const indentation = match[1]!.length;
    const trimmed = match[2]!.trim();
    if (trimmed === "}") {
      if (indentation !== depth) return null;
      depth -= 1;
      if (depth === 0) return index;
    } else if (trimmed.endsWith("{")) {
      if (indentation !== depth + 1) return null;
      depth += 1;
    } else if (indentation !== depth + 1) {
      return null;
    }
  }
  return null;
}

function inspectLaunchdService(
  launchctl: OfflineMigrationLaunchctl,
  service: string,
  isAlive: ((pid: number) => boolean) | undefined,
): { loaded: boolean | null; pid: number | null; live: boolean | null } {
  const printed = launchctl.print(service);
  // `launchctl print` returns 113 when this exact service is definitively
  // absent. Every other non-success result is indeterminate rather than a
  // license to present a potentially crashed worker as merely armed.
  if (printed.status === LAUNCHCTL_SERVICE_NOT_FOUND_STATUS) return { loaded: false, pid: null, live: false };
  if (printed.status !== 0) return { loaded: null, pid: null, live: null };
  const identity = parseLaunchdServiceIdentity(printed, service);
  const pid = identity.pid;
  const probe = isAlive ?? isProcessAlive;
  return {
    loaded: true,
    pid,
    live: identity.state === "running" && pid !== null && probe(pid),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sameStringArray(left: readonly string[] | null, right: readonly string[]): boolean {
  return left !== null && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function selfRemove(context: OfflineMigrationLauncherContextV1, dependencies: OfflineMigrationLauncherDependencies): void {
  const launchctl = dependencies.launchctl ?? systemLaunchctl();
  const domain = launchdDomain();
  const service = `${domain}/${context.label}`;
  removeInertPlist(context);
  emit(dependencies, "plist-removed", context);
  const bootout = launchctl.bootout(domain, service);
  emit(dependencies, "launchd-bootout", context);
  // A nonzero bootout is acceptable only when the one exact service is absent
  // on the immediately following inspection. There is deliberately no retry.
  if (isLaunchdLoaded(launchctl, service)) {
    const detail = bootout.error ?? `status-${bootout.status ?? "unknown"}`;
    fail(`launchd-label-remained-loaded-${detail}`);
  }
  if (existsNoFollow(context.plistPath)) fail("launch-agent-plist-remained-after-self-removal");
  emit(dependencies, "self-removal-verified", context);
}

function removeInertPlist(context: OfflineMigrationLauncherContextV1): void {
  if (!existsNoFollow(context.plistPath)) return;
  assertPrivateRegularFile(context.plistPath, "launch-agent-plist");
  unlinkSync(context.plistPath);
  fsyncDirectory(context.launchAgentsRoot);
  if (existsNoFollow(context.plistPath)) fail("launch-agent-plist-removal-unverified");
}

function defaultWriterCensus(context: OfflineMigrationLauncherContextV1): OfflineMigrationWriterCensus {
  const observedAt = new Date().toISOString();
  const base: Omit<HistoryAdoptionCensusInput, "appPath"> = {
    protectedPaths: [
      context.migration.legacyRouterRoot,
      context.migration.legacyCodexRoot,
      context.migration.legacySqliteRoot,
      context.migration.legacyDefinitionsRoot,
      ...(context.migration.capacityReceiptPath === undefined ? [] : [context.migration.capacityReceiptPath]),
    ].filter((path, index, values) => values.indexOf(path) === index),
  };
  const primary = observeHistoryAdoptionCensus({ ...base, appPath: context.migration.appPath });
  const tweakers = observeHistoryAdoptionCensus({ ...base, appPath: context.migration.tweakersAppPath });
  const primaryIdle = primary.app === "idle" && primary.main === "idle" && primary.appServer === "idle" && primary.openFileCount === 0;
  const tweakersIdle = tweakers.app === "idle" && tweakers.main === "idle" && tweakers.appServer === "idle" && tweakers.openFileCount === 0;
  if (!primaryIdle || !tweakersIdle) {
    return {
      observedAt,
      chatgptWriters: primaryIdle ? 0 : 1,
      tweakersWriters: tweakersIdle ? 0 : 1,
      brokerWriters: primary.appServer === "idle" && tweakers.appServer === "idle" ? 0 : 1,
      historyWriters: Math.max(0, primary.openFileCount) + Math.max(0, tweakers.openFileCount),
    };
  }
  return { observedAt, chatgptWriters: 0, tweakersWriters: 0, brokerWriters: 0, historyWriters: 0 };
}

function assertWriterCensusShape(census: unknown): asserts census is OfflineMigrationWriterCensus {
  if (!isRecord(census)
    || !isCanonicalTimestamp(census.observedAt)
    || !isNonNegativeInteger(census.chatgptWriters)
    || !isNonNegativeInteger(census.tweakersWriters)
    || !isNonNegativeInteger(census.brokerWriters)
    || !isNonNegativeInteger(census.historyWriters)) {
    fail("invalid-zero-writer-census");
  }
}

function isZeroWriterCensus(census: OfflineMigrationWriterCensus): boolean {
  return census.chatgptWriters === 0
    && census.tweakersWriters === 0
    && census.brokerWriters === 0
    && census.historyWriters === 0;
}

function launchAgentPlist(context: OfflineMigrationLauncherContextV1, contextSeal: OfflineMigrationSealedFile): string {
  const argumentsList = managerRunArguments(context, contextSeal)
    .map((entry) => `    <string>${xmlEscape(entry)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(context.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentsList,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join("\n");
}

function managerRunArguments(
  context: OfflineMigrationLauncherContextV1,
  contextSeal: OfflineMigrationSealedFile,
): readonly string[] {
  return [
    context.executor.node.path,
    context.executor.managerBundle.path,
    OFFLINE_MIGRATION_MANAGER_RUN_COMMAND,
    "--launcher-root",
    context.launcherRoot,
    "--context-bytes",
    String(contextSeal.bytes),
    "--context-sha256",
    contextSeal.sha256,
  ];
}

function systemLaunchctl(): OfflineMigrationLaunchctl {
  const invoke = (args: readonly string[]): OfflineMigrationLaunchctlResult => {
    const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      status: result.status,
      ...(typeof result.stdout === "string" ? { output: result.stdout } : {}),
      ...(result.error ? { error: result.error.message } : {}),
    };
  };
  return {
    bootstrap(domain, plistPath) { return invoke(["bootstrap", domain, plistPath]); },
    bootout(domain, service) { return invoke(["bootout", domain, service]); },
    print(service) { return invoke(["print", service]); },
  };
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isSafeInteger(uid) || uid === null || uid < 0) fail("launchd-gui-domain-unavailable");
  return `gui/${uid}`;
}

function isLaunchdLoaded(launchctl: OfflineMigrationLaunchctl, service: string): boolean {
  return launchctl.print(service).status === 0;
}

function sharedHistoryMigrationJournalPath(globalRoot: string, transactionId: string): string {
  const base = basename(globalRoot);
  if (!base || base === "." || base === "..") fail("invalid-global-root");
  return join(dirname(globalRoot), `.${base}.shared-history-migration-${transactionId}.json`);
}

function assertContext(value: unknown, expectedRoot: string): asserts value is OfflineMigrationLauncherContextV1 {
  const legacyContextKeys = [
    "version", "kind", "transactionId", "launcherRoot", "launchAgentsRoot", "label", "plistPath", "executor", "inventories",
    "promotion", "rollback", "migration", "migrationJournalPath", "preparedAt",
  ] as const;
  const currentContextKeys = [...legacyContextKeys, "capacityReceipt"] as const;
  if (!isRecord(value)) fail("invalid-launcher-context");
  const currentContext = hasExactKeys(value, currentContextKeys);
  const legacyContext = hasExactKeys(value, legacyContextKeys);
  if (!currentContext && !legacyContext) fail("invalid-launcher-context");
  const context = value as Record<string, unknown>;
  if (context.version !== OFFLINE_MIGRATION_LAUNCHER_SCHEMA_VERSION
    || context.kind !== "offline-migration-launcher"
    || !isCanonicalTimestamp(context.preparedAt)
    || typeof context.transactionId !== "string"
    || !TRANSACTION_ID.test(context.transactionId)
    || context.launcherRoot !== expectedRoot
    || typeof context.launchAgentsRoot !== "string"
    || !isCanonicalAbsoluteString(context.launchAgentsRoot)
    || typeof context.label !== "string"
    || context.label !== `${OFFLINE_MIGRATION_LAUNCHER_LABEL_PREFIX}.${context.transactionId}`
    || typeof context.plistPath !== "string"
    || !isCanonicalAbsoluteString(context.plistPath)
    || context.plistPath !== join(String(context.launchAgentsRoot), `${context.label}.plist`)
    || typeof context.migrationJournalPath !== "string"
    || !isCanonicalAbsoluteString(context.migrationJournalPath)) {
    fail("invalid-launcher-context");
  }
  const rawMigration = context.migration;
  const migration = normalizeMigrationInput(rawMigration as Omit<SharedHistoryMigrationInput, "apply" | "transactionId">);
  const currentMigrationKeys = [
    "legacyRouterRoot", "legacyCodexRoot", "legacySqliteRoot", "legacyDefinitionsRoot", "globalRoot", "appPath", "tweakersAppPath", "sharedSkillsRoots", "sharedPluginInventory", "capacityReceiptPath",
  ] as const;
  const definitionsMigrationKeys = [
    "legacyRouterRoot", "legacyCodexRoot", "legacySqliteRoot", "legacyDefinitionsRoot", "globalRoot", "appPath", "tweakersAppPath", "sharedSkillsRoots", "sharedPluginInventory",
  ] as const;
  const legacyMigrationKeys = [
    "legacyRouterRoot", "legacyCodexRoot", "legacySqliteRoot", "globalRoot", "appPath", "tweakersAppPath", "sharedSkillsRoots", "sharedPluginInventory",
  ] as const;
  const currentMigration = isRecord(rawMigration) && hasExactKeys(rawMigration, currentMigrationKeys);
  const definitionsMigration = isRecord(rawMigration) && hasExactKeys(rawMigration, definitionsMigrationKeys);
  const legacyMigration = isRecord(rawMigration) && hasExactKeys(rawMigration, legacyMigrationKeys);
  if ((!currentMigration && !definitionsMigration && !legacyMigration)
    || ((currentMigration || definitionsMigration) && canonicalJson(migration) !== canonicalJson(rawMigration))
    || (legacyMigration && migration.legacyDefinitionsRoot !== migration.legacyCodexRoot)
    || (currentContext !== (migration.capacityReceiptPath !== undefined))
    || context.migrationJournalPath !== sharedHistoryMigrationJournalPath(migration.globalRoot, context.transactionId)) {
    fail("invalid-launcher-context");
  }
  if (currentContext) {
    assertCapacityReceiptInspectionShape(context.capacityReceipt);
    if (migration.capacityReceiptPath !== context.capacityReceipt.receipt.path) {
      fail("invalid-launcher-context");
    }
  }
  // Context v1 predates the optional root. Keep that exact old object shape
  // readable, but operate only on its normalized implicit value in memory.
  context.migration = migration;
  assertPrivateDirectory(String(context.launcherRoot), "launcher-root");
  assertOwnerControlledDirectory(String(context.launchAgentsRoot), "launch-agents-root");
  assertManagerExecutorBindingShape(context.executor);
  if (!Array.isArray(context.inventories) || context.inventories.length === 0) fail("invalid-launcher-context");
  const inventoryPaths = new Set<string>();
  for (const entry of context.inventories) {
    assertSealedFileShape(entry, "sealed-inventory");
    if (inventoryPaths.has(entry.path)) fail("invalid-launcher-context");
    inventoryPaths.add(entry.path);
  }
  if (!inventoryPaths.has(migration.sharedPluginInventory)) fail("invalid-launcher-context");
  if (migration.capacityReceiptPath !== undefined && !inventoryPaths.has(migration.capacityReceiptPath)) {
    fail("invalid-launcher-context");
  }
  assertPromotionBinding(context.promotion, migration.tweakersAppPath, migration.globalRoot);
  assertRollbackBindingShape(context.rollback, migration.globalRoot);
}

function assertSealedFileShape(
  value: unknown,
  label: string,
  maxBytes = MAX_PRIVATE_FILE_BYTES,
): asserts value is OfflineMigrationSealedFile {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "bytes", "sha256"])
    || typeof value.path !== "string" || !isExactAbsolute(value.path)
    || !isNonNegativeInteger(value.bytes) || value.bytes > maxBytes
    || !isFingerprint(value.sha256)) fail(`invalid-${label}-binding`);
}

function assertCapacityReceiptInspectionShape(value: unknown): asserts value is SharedHistoryCapacityReceiptInspectionV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "receipt", "issuedAt", "proof", "sources", "projection", "roots",
  ])
    || value.version !== 1
    || value.kind !== "shared-history-capacity-receipt-inspection"
    || !isCanonicalTimestamp(value.issuedAt)
    || !isRecord(value.proof)
    || !isRecord(value.sources)
    || !isRecord(value.projection)
    || !isRecord(value.roots)) {
    fail("invalid-shared-history-capacity-receipt-binding");
  }
  if (!isRecord(value.receipt) || !hasExactKeys(value.receipt, ["path", "bytes", "sha256", "device", "inode", "uid", "mode", "nlink"])
    || typeof value.receipt.path !== "string" || !isExactAbsolute(value.receipt.path)
    || !isNonNegativeInteger(value.receipt.bytes) || value.receipt.bytes > MAX_PRIVATE_FILE_BYTES
    || !isFingerprint(value.receipt.sha256)
    || !isNonNegativeInteger(value.receipt.device)
    || !isNonNegativeInteger(value.receipt.inode)
    || !isNonNegativeInteger(value.receipt.uid)
    || !isNonNegativeInteger(value.receipt.mode) || value.receipt.mode > 0o7777
    || !isNonNegativeInteger(value.receipt.nlink) || value.receipt.nlink === 0
    || !isCapacityReceiptSourceBinding(value.sources)
    || !isCapacityReceiptRootBinding(value.roots.router)
    || !isCapacityReceiptRootBinding(value.roots.codex)
    || !isCapacityReceiptRootBinding(value.roots.sqlite)
    || !isCapacityReceiptRootBinding(value.roots.definitions)
    || canonicalJson(value.sources.definitionsRoot) !== canonicalJson(value.roots.definitions)) {
    fail("invalid-shared-history-capacity-receipt-binding");
  }
}

function isCapacityReceiptSourceBinding(value: unknown): value is {
  definitionsRoot: SharedHistoryCapacityReceiptInspectionV1["roots"]["definitions"];
} {
  return isRecord(value) && hasExactKeys(value, [
    "routerManifestFingerprint", "sourceDatabaseManifestFingerprint", "normalizedSourceDatabaseManifestFingerprint", "sharedSkillsManifestFingerprint", "sharedPluginsManifestFingerprint", "definitionsRoot",
  ])
    && isFingerprint(value.routerManifestFingerprint)
    && isFingerprint(value.sourceDatabaseManifestFingerprint)
    && isFingerprint(value.normalizedSourceDatabaseManifestFingerprint)
    && isFingerprint(value.sharedSkillsManifestFingerprint)
    && isFingerprint(value.sharedPluginsManifestFingerprint)
    && isCapacityReceiptRootBinding(value.definitionsRoot);
}

function isCapacityReceiptRootBinding(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["path", "device", "inode", "uid", "mode", "nlink"])
    && typeof value.path === "string" && isExactAbsolute(value.path)
    && isNonNegativeInteger(value.device)
    && isNonNegativeInteger(value.inode)
    && isNonNegativeInteger(value.uid)
    && isNonNegativeInteger(value.mode) && value.mode <= 0o7777
    && isNonNegativeInteger(value.nlink) && value.nlink > 0;
}

function assertManagerExecutorBindingShape(value: unknown): asserts value is OfflineMigrationManagerExecutorBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "generationRoot", "generationId", "targetSeal", "node", "managerBundle", "managerLauncher",
  ])) fail("invalid-manager-executor-binding");
  if (!isCanonicalAbsoluteString(value.generationRoot)
    || typeof value.generationId !== "string" || !SHA256_HEX.test(value.generationId)
    || basename(value.generationRoot) !== value.generationId) {
    fail("invalid-manager-executor-binding");
  }
  assertSealedFileShape(value.targetSeal, "manager-target-seal");
  assertSealedFileShape(value.managerBundle, "manager-bundle");
  assertSealedFileShape(value.managerLauncher, "manager-launcher");
  assertSealedFileShape(value.node, "manager-node", MAX_MANAGER_NODE_BYTES);
  if (value.targetSeal.path !== join(value.generationRoot, TWEAKERS_MANAGER_SEAL_NAME)
    || value.managerBundle.path !== join(value.generationRoot, TWEAKERS_MANAGER_BUNDLE_NAME)
    || value.managerLauncher.path !== join(value.generationRoot, TWEAKERS_MANAGER_LAUNCHER_NAME)) {
    fail("invalid-manager-executor-binding");
  }
}

function assertPromotionBinding(
  value: unknown,
  expectedAppRoot: string,
  expectedBrokerRoot: string,
): asserts value is OfflineMigrationTweakersPromotionBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "receipt", "operationId", "promotionId", "activePromotionReceiptSha256", "pid", "processStartToken", "runtimeFingerprint", "appAsarHeaderHash", "appRoot",
    "bundleId", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation",
    "appearance", "observedAt",
  ])) fail("invalid-tweakers-promotion-binding");
  assertSealedFileShape(value.receipt, "tweakers-promotion-receipt");
  if (!isPromotionBindingIdentifier(value.operationId)
    || !isPromotionBindingIdentifier(value.promotionId)
    || !SHA256_HEX.test(String(value.activePromotionReceiptSha256 ?? ""))
    || !isPositiveSafeInteger(value.pid)
    || !isRuntimeReadyProcessToken(value.processStartToken)
    || !SHA256_HEX.test(String(value.runtimeFingerprint ?? ""))
    || !SHA256_HEX.test(String(value.appAsarHeaderHash ?? ""))
    || value.appRoot !== expectedAppRoot
    || value.bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || !isCanonicalAbsoluteString(value.appUserDataRoot)
    || !isCanonicalAbsoluteString(value.codexHomeRoot)
    || value.accountsBrokerRoot !== expectedBrokerRoot
    || !isAbsentBrokerAuthorityExpectation(value.brokerAuthorityExpectation)
    || !isNormalizedAppearanceBinding(value.appearance)
    || !isCanonicalTimestamp(value.observedAt)) {
    fail("invalid-tweakers-promotion-binding");
  }
}

function assertCurrentTweakersRuntimeReadyReceipt(
  value: unknown,
  expectedAppRoot: string,
  expectedBrokerRoot: string,
): asserts value is CurrentTweakersRuntimeReadyReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "pid", "processStartToken",
    "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint", "appUserDataRoot", "codexHomeRoot",
    "accountsBrokerRoot", "brokerAuthorityExpectation", "mainInitialized", "preloadInitialized", "settingsMounted",
    "sharedHistoryBrokerState", "initializedTweakIds", "appearance", "observedAt",
  ])) fail("invalid-tweakers-promotion-binding");
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION
    || receipt.kind !== INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND
    || !isPromotionBindingIdentifier(receipt.operationId)
    || !isPromotionBindingIdentifier(receipt.promotionId)
    || !SHA256_HEX.test(String(receipt.activePromotionReceiptSha256 ?? ""))
    || !isPositiveSafeInteger(receipt.pid)
    || !isRuntimeReadyProcessToken(receipt.processStartToken)
    || receipt.appRoot !== expectedAppRoot
    || receipt.bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || !SHA256_HEX.test(String(receipt.appAsarHeaderHash ?? ""))
    || !SHA256_HEX.test(String(receipt.runtimeFingerprint ?? ""))
    || !isCanonicalAbsoluteString(receipt.appUserDataRoot)
    || !isCanonicalAbsoluteString(receipt.codexHomeRoot)
    || receipt.accountsBrokerRoot !== expectedBrokerRoot
    || !isAbsentBrokerAuthorityExpectation(receipt.brokerAuthorityExpectation)
    || !isNormalizedAppearanceBinding(receipt.appearance)
    || receipt.mainInitialized !== true
    || receipt.preloadInitialized !== true
    || receipt.settingsMounted !== true
    || receipt.sharedHistoryBrokerState !== "blocked"
    || !hasExactIndependentTweakersTweakIds(receipt.initializedTweakIds)
    || !isCanonicalTimestamp(receipt.observedAt)) {
    fail("invalid-tweakers-promotion-binding");
  }
}

function isNormalizedAppearanceBinding(value: unknown): value is IndependentTweakersRuntimeReadyAppearanceBinding {
  return isRecord(value)
    && hasExactKeys(value, ["status", "normalized"])
    && value.status === "normal"
    && value.normalized === true;
}

function sameNormalizedAppearanceBinding(
  left: IndependentTweakersRuntimeReadyAppearanceBinding,
  right: IndependentTweakersRuntimeReadyAppearanceBinding,
): boolean {
  return left.status === right.status && left.normalized === right.normalized;
}

function isAbsentBrokerAuthorityExpectation(value: unknown): value is OfflineMigrationPreMigrationBrokerAuthorityExpectation {
  if (!isRecord(value) || !hasExactKeys(value, ["globalRootState", "configSha256"])) return false;
  return value.globalRootState === "absent" && value.configSha256 === null;
}

function sameBrokerAuthorityExpectation(
  left: OfflineMigrationPreMigrationBrokerAuthorityExpectation,
  right: OfflineMigrationPreMigrationBrokerAuthorityExpectation,
): boolean {
  return left.globalRootState === right.globalRootState && left.configSha256 === right.configSha256;
}

function assertRollbackBindingShape(value: unknown, globalRoot: string): asserts value is OfflineMigrationRollbackBinding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "globalRoot", "canonicalHistoryFile", "requiresBrokerWriteStop", "legacyV2RestoreForbidden",
  ])
    || value.kind !== "global-v3-read-only-viewer"
    || value.globalRoot !== globalRoot
    || value.canonicalHistoryFile !== CANONICAL_HISTORY_FILE
    || value.requiresBrokerWriteStop !== true
    || value.legacyV2RestoreForbidden !== true) fail("invalid-global-v3-rollback-binding");
}

function assertTerminalResult(value: unknown, context: OfflineMigrationLauncherContextV1): asserts value is OfflineMigrationLauncherTerminalResultV1 {
  assertTerminalResultShape(value);
  if (value.transactionId !== context.transactionId
    || value.migrationJournalPath !== context.migrationJournalPath
    || value.globalRoot !== context.migration.globalRoot) fail("invalid-terminal-result");
  assertTerminalStateCorrelation(value, context);
}

function assertTerminalResultShape(value: unknown): asserts value is OfflineMigrationLauncherTerminalResultV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "transactionId", "state", "phase", "reason", "migrationJournalPath", "globalRoot", "firstCensus", "secondCensus",
    "migrationResult", "rollback", "committedAt",
  ])
    || value.version !== 1
    || value.kind !== "offline-migration-launcher-terminal-result"
    || typeof value.transactionId !== "string" || !TRANSACTION_ID.test(value.transactionId)
    || !["migrated", "blocked", "manual-recovery-required", "arm-failed"].includes(String(value.state))
    || !["arm", "preflight", "census", "apply", "rollback-verification"].includes(String(value.phase))
    || !(typeof value.reason === "string" || value.reason === null)
    || typeof value.migrationJournalPath !== "string" || !isExactAbsolute(value.migrationJournalPath)
    || typeof value.globalRoot !== "string" || !isExactAbsolute(value.globalRoot)
    || !(value.firstCensus === null || isWriterCensus(value.firstCensus))
    || !(value.secondCensus === null || isWriterCensus(value.secondCensus))
    || !(value.migrationResult === null || isRecord(value.migrationResult))
    || !(value.rollback === null || isRecord(value.rollback))
    || !isCanonicalTimestamp(value.committedAt)) fail("invalid-terminal-result");
}

function assertOriginProofDiagnostic(
  value: unknown,
  context: OfflineMigrationLauncherContextV1,
): asserts value is OfflineMigrationLauncherOriginProofDiagnosticV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "transactionId", "phase", "reason", "recordedAt",
  ])
    || value.version !== 1
    || value.kind !== "offline-migration-launcher-origin-proof-diagnostic"
    || value.transactionId !== context.transactionId
    || value.phase !== "origin-proof"
    || typeof value.reason !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value.reason)
    || !isCanonicalTimestamp(value.recordedAt)) fail("invalid-origin-proof-diagnostic");
}

function assertTerminalStateCorrelation(
  terminal: OfflineMigrationLauncherTerminalResultV1,
  context: OfflineMigrationLauncherContextV1,
): void {
  const zeroCensuses = terminal.firstCensus !== null
    && terminal.secondCensus !== null
    && isZeroWriterCensus(terminal.firstCensus)
    && isZeroWriterCensus(terminal.secondCensus);
  if (terminal.state === "migrated") {
    if (terminal.phase !== "rollback-verification" || terminal.reason !== null
      || !zeroCensuses || terminal.migrationResult === null || terminal.rollback === null) {
      fail("invalid-terminal-result");
    }
    assertMigratedEvidence(context, terminal.migrationResult, terminal.rollback);
    return;
  }
  if (terminal.migrationResult !== null || terminal.rollback !== null || !isTerminalReason(terminal.reason)) {
    fail("invalid-terminal-result");
  }
  if (terminal.state === "blocked") {
    if (terminal.phase !== "census" || terminal.reason !== "zero-writer-window-timeout"
      || terminal.firstCensus !== null || terminal.secondCensus !== null) {
      fail("invalid-terminal-result");
    }
    return;
  }
  if (terminal.state === "arm-failed") {
    if (terminal.phase !== "arm" || terminal.firstCensus !== null || terminal.secondCensus !== null) {
      fail("invalid-terminal-result");
    }
    return;
  }
  if (terminal.phase === "arm") fail("invalid-terminal-result");
  if ((terminal.phase === "apply" || terminal.phase === "rollback-verification") && !zeroCensuses) {
    fail("invalid-terminal-result");
  }
}

function isTerminalReason(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isWriterCensus(value: unknown): value is OfflineMigrationWriterCensus {
  return isRecord(value)
    && isCanonicalTimestamp(value.observedAt)
    && isNonNegativeInteger(value.chatgptWriters)
    && isNonNegativeInteger(value.tweakersWriters)
    && isNonNegativeInteger(value.brokerWriters)
    && isNonNegativeInteger(value.historyWriters);
}

function sealFile(pathValue: string, label: string): OfflineMigrationSealedFile {
  const path = exactAbsolute(pathValue, `invalid-${label}-path`);
  assertOwnerControlledDirectory(dirname(path), `${label}-parent`);
  const stat = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(stat, label);
  if (stat.size > MAX_PRIVATE_FILE_BYTES) fail(`${label}-capacity-exceeded`);
  return { path, bytes: stat.size, sha256: fingerprintPrivateFile(path, stat, label) };
}

function fingerprintPrivateFile(path: string, expected: Stats, label: string): Sha256Fingerprint {
  let descriptor: number | undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!sameFile(before, expected)) fail(`${label}-changed-during-read`);
    let bytes = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    if (bytes !== expected.size || !sameFile(fstatSync(descriptor), expected)) fail(`${label}-changed-during-read`);
    return `sha256:${hash.digest("hex")}` as Sha256Fingerprint;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    buffer.fill(0);
  }
}

function writePrivateTextNew(path: string, text: string, label: string): void {
  writePrivateBytesNew(path, Buffer.from(text, "utf8"), label);
}

function writePrivateJsonNew(path: string, value: unknown, label: string): void {
  writePrivateBytesNew(path, Buffer.from(`${canonicalJson(value)}\n`, "utf8"), label);
}

function writePrivateBytesNew(path: string, bytes: Buffer, label: string): void {
  assertOwnerControlledDirectory(dirname(path), `${label}-parent`);
  assertAbsent(path, `${label}-already-exists`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes.fill(0);
  }
  assertPrivateRegularFile(path, label);
  fsyncDirectory(dirname(path));
}

function readPrivateJson(path: string, maxBytes: number, label: string): unknown {
  const bytes = readPrivateBytes(path, maxBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail(`${label}-invalid-json`);
  } finally {
    bytes.fill(0);
  }
}

function readPrivateBytes(path: string, maxBytes: number, label: string): Buffer {
  const expected = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(expected, label);
  if (expected.size > maxBytes) fail(`${label}-capacity-exceeded`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!sameFile(before, expected)) fail(`${label}-changed-during-read`);
    const bytes = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== bytes.byteLength || !sameFile(fstatSync(descriptor), expected)) {
      bytes.fill(0);
      fail(`${label}-changed-during-read`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatNoFollow(path, label);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o077) !== 0) fail(`${label}-not-private-directory`);
  assertCanonicalPath(path, label);
}

function assertOwnerControlledDirectory(path: string, label: string): void {
  const stat = lstatNoFollow(path, label);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o022) !== 0) fail(`${label}-not-owner-controlled-directory`);
  assertCanonicalPath(path, label);
}

function assertCanonicalDirectory(path: string, label: string): void {
  const stat = lstatNoFollow(path, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}-not-directory`);
  assertCanonicalPath(path, label);
}

function assertPrivateRegularFile(path: string, label: string): void {
  const stat = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(stat, label);
  assertCanonicalPath(path, label);
}

function assertPrivateRegularFileStat(stat: Stats, label: string): void {
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o077) !== 0) fail(`${label}-not-private-regular-file`);
}

function assertCanonicalPath(path: string, label: string): void {
  let resolved: string;
  try { resolved = realpathSync.native(path); }
  catch { fail(`${label}-symlink-refused`); }
  if (resolved !== path) fail(`${label}-symlink-refused`);
}

function lstatNoFollow(path: string, label: string): Stats {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`${label}-symlink-refused`);
    return stat;
  } catch (error) {
    if (error instanceof OfflineMigrationLauncherError) throw error;
    fail(`${label}-missing-or-unsafe`);
  }
}

function assertAbsent(path: string, code: string): void {
  if (existsNoFollow(path)) fail(code);
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch {
    // macOS can reject directory fsync even when the regular file data is
    // durable. File fsync remains mandatory; the next identity check detects
    // any interrupted rename or deletion rather than treating it as success.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function normalizePaths(values: readonly string[], code: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) fail(code);
  const paths = values.map((value) => exactAbsolute(value, code)).sort(compareCodeUnits);
  if (new Set(paths).size !== paths.length) fail(code);
  return paths;
}

function exactAbsolute(value: string, code: string): string {
  if (typeof value !== "string" || !isExactAbsolute(value)) fail(code);
  return value;
}

function isExactAbsolute(value: string): boolean {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
}

function isCanonicalAbsoluteString(value: unknown): value is string {
  return typeof value === "string" && isExactAbsolute(value);
}

function validatedTransactionId(value: string): string {
  if (typeof value !== "string" || !TRANSACTION_ID.test(value)) fail("invalid-transaction-id");
  return value;
}

function fingerprint(value: string, code: string): Sha256Fingerprint {
  if (typeof value !== "string" || !SHA256_FINGERPRINT.test(value)) fail(code);
  return value as Sha256Fingerprint;
}

function canonicalNow(value: string): string {
  if (!isCanonicalTimestamp(value)) fail("invalid-timestamp");
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedWaitMilliseconds(value: unknown, fallback: number, code: string): number {
  const milliseconds = value === undefined ? fallback : value;
  if (typeof milliseconds !== "number"
    || !Number.isSafeInteger(milliseconds)
    || milliseconds <= 0
    || milliseconds > 24 * 60 * 60 * 1000) fail(code);
  return milliseconds;
}

function blockingSleep(milliseconds: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isPromotionBindingIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value !== "active"
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && basename(value) === value;
}

function isRuntimeReadyProcessToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasExactIndependentTweakersTweakIds(value: unknown): value is readonly string[] {
  const expected = [...REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS].sort(compareCodeUnits);
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isFingerprint(value: unknown): value is Sha256Fingerprint {
  return typeof value === "string" && SHA256_FINGERPRINT.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort(compareCodeUnits)[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function emit(dependencies: OfflineMigrationLauncherDependencies, event: OfflineMigrationLauncherEvent["event"], context: OfflineMigrationLauncherContextV1): void {
  dependencies.onEvent?.({ event, transactionId: context.transactionId });
}

function errorCode(error: unknown): string {
  return error instanceof OfflineMigrationLauncherError
    ? error.code
    : error instanceof Error
      ? error.message.slice(0, 512)
      : String(error).slice(0, 512);
}

function isWriterFailure(code: string): boolean {
  return code === "zero-writer-window-timeout";
}

function failurePhase(code: string): OfflineMigrationLauncherTerminalResultV1["phase"] {
  if (code === "zero-writer-window-timeout" || code === "invalid-zero-writer-census") return "census";
  // These are checked before the waiting/attempt latch. A pre-existing v3
  // root or migration journal must never be recorded as though this worker
  // reached apply, because that would manufacture false zero-census evidence.
  if (code === "shared-history-migration-journal-already-exists"
    || code === "global-v3-root-already-exists"
    || code === "terminal-result-already-exists"
    || code === "interrupted-wait-requires-manual-recovery"
    || code === "interrupted-attempt-requires-manual-recovery") return "preflight";
  if (code.includes("rollback")) return "rollback-verification";
  if (code.includes("migration") || code.includes("global-v3-root-missing")) return "apply";
  return "preflight";
}

function cliPath(value: string | undefined, option: string): string {
  if (typeof value !== "string" || !isExactAbsolute(value)) throw new Error(`${option} must be an exact absolute path`);
  return value;
}

function cliPaths(value: string | readonly string[] | undefined, option: string): readonly string[] {
  const values = cliStrings(value);
  if (values.length === 0) throw new Error(`${option} must be supplied at least once`);
  return values.map((entry) => cliPath(entry, option));
}

function cliStrings(value: string | readonly string[] | undefined): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? [...value] : [];
}

function cliString(value: string | undefined, option: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${option} is required`);
  return value;
}

function cliFingerprint(value: string | undefined, option: string): Sha256Fingerprint {
  if (typeof value !== "string" || !SHA256_FINGERPRINT.test(value)) throw new Error(`${option} must be a sha256 fingerprint`);
  return value as Sha256Fingerprint;
}

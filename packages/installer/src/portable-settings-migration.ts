import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  canonicalJson,
  isCanonicalUtcTimestamp,
  observeHistoryAdoptionCensus,
  type HistoryAdoptionCensus,
  type HistoryAdoptionCensusInput,
} from "./account-history-adoption.js";
import {
  CANONICAL_HISTORY_FILE,
  preflightCanonicalHistoryStore,
} from "./shared-history-migration.js";

export const PORTABLE_SETTINGS_MIGRATION_SCHEMA_VERSION = 1 as const;
export const PORTABLE_SETTINGS_DECISION_ID = "PSCM-2026-09-04-v1" as const;
export const PORTABLE_SETTINGS_JOURNAL_FILE = "journal.v1.json" as const;
export const PORTABLE_SETTINGS_RECEIPT_FILE = "receipt.v1.json" as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EVIDENCE_MODE = 0o400;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTS_BYTES = 512 * 1024;
const MAX_PROJECTS = 100;
const MAX_PROJECT_NODES = 200;
const MAX_PROJECT_PATHS = 8;
const MAX_PINNED_TASKS = 100;
const MAX_TWEAKS = 512;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9-]{8,128}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PUBLIC_THREAD_ID = /^lh_[A-Za-z0-9_-]{16,128}$/;
const EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F)?$/u;
const ICONIFY = /^[a-z0-9-]{1,40}:[a-z0-9-]{1,80}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const TASK_SORT = new Set(["created-desc", "created-asc", "updated-desc", "updated-asc"]);
const COLOR_MODE = new Set(["auto", "manual"]);
const OVERLAY = new Set(["off", "subtle", "medium", "strong"]);

type Sha256Fingerprint = `sha256:${string}`;
type ArtifactName = "global-state" | "projects" | "config";
type PortableSettingsPhase =
  | "journal-prepared"
  | "source-sealed"
  | "destination-preimages-preserved"
  | "candidate-prepared"
  | "candidate-verified"
  | "publishing"
  | "published"
  | "receipt-published"
  | "rolled-back"
  | "manual-recovery-required";
type PortableSettingsBoundary = PortableSettingsPhase | "transaction-root-created";

export interface PortableSettingsWriterCensus {
  observedAt: string;
  chatgpt: "idle" | "running" | "unknown";
  tweakers: "idle" | "running" | "unknown";
  appServers: "idle" | "running" | "unknown";
  openFileCount: number;
}

export interface PortableSettingsMigrationInput {
  transactionId: string;
  sourceCodexHomeRoot: string;
  sourceTweakersRoot: string;
  targetCodexHomeRoot: string;
  targetTweakersRoot: string;
  globalRoot: string;
  chatgptAppPath: string;
  tweakersAppPath: string;
  apply?: boolean;
  expectedIntentFingerprint?: Sha256Fingerprint;
}

export interface PortableSettingsMigrationDependencies {
  census?: (input: {
    chatgptAppPath: string;
    tweakersAppPath: string;
    protectedPaths: readonly string[];
  }) => PortableSettingsWriterCensus;
  wait?: (milliseconds: number) => void;
  now?: () => string;
  beforePhase?: (phase: PortableSettingsBoundary) => void;
  isProcessAlive?: (pid: number) => boolean;
}

export interface PortableSettingsMigrationCliOptions {
  transaction?: string;
  sourceCodexHomeRoot?: string;
  "source-codex-home-root"?: string;
  sourceTweakersRoot?: string;
  "source-tweakers-root"?: string;
  targetCodexHomeRoot?: string;
  "target-codex-home-root"?: string;
  targetTweakersRoot?: string;
  "target-tweakers-root"?: string;
  globalRoot?: string;
  "global-root"?: string;
  app?: string;
  tweakersApp?: string;
  "tweakers-app"?: string;
  intentFingerprint?: string;
  "intent-fingerprint"?: string;
  apply?: boolean;
}

export interface PortableSettingsMigrationCommandDependencies extends PortableSettingsMigrationDependencies {
  print?: (line: string) => void;
}

export interface PortableSettingsArtifactReceipt {
  name: ArtifactName;
  targetPath: string;
  sourceFingerprint: Sha256Fingerprint;
  preimageFingerprint: Sha256Fingerprint | null;
  postimageFingerprint: Sha256Fingerprint;
  hadTarget: boolean;
  changed: boolean;
}

export interface PortableSettingsMigrationResult {
  schemaVersion: typeof PORTABLE_SETTINGS_MIGRATION_SCHEMA_VERSION;
  kind: "portable-settings-migration-result";
  decisionId: typeof PORTABLE_SETTINGS_DECISION_ID;
  transactionId: string;
  status: "preview" | "applied" | "already-applied" | "rolled-back" | "manual-recovery-required";
  intentFingerprint: Sha256Fingerprint;
  canonicalHistoryFingerprint: Sha256Fingerprint;
  artifacts: readonly PortableSettingsArtifactReceipt[];
  projectCount: number;
  projectNodeCount: number;
  tweakFlagCount: number;
  exclusions: readonly string[];
  conflicts: readonly string[];
  journalPath: string;
  receiptPath: string;
  holdActivation: boolean;
  nextAction: "apply-with-intent" | "activation-remains-user-confirmed" | "recover-explicitly" | "none";
}

interface PortableSettingsPaths {
  transactionParent: string;
  transactionRoot: string;
  journal: string;
  receipt: string;
  lock: string;
  candidates: string;
  preimages: string;
  quarantine: string;
}

interface PortableSettingsIntentV1 {
  schemaVersion: 1;
  kind: "portable-settings-intent";
  decisionId: typeof PORTABLE_SETTINGS_DECISION_ID;
  transactionId: string;
  roots: {
    sourceCodexHomeRoot: string;
    sourceTweakersRoot: string;
    targetCodexHomeRoot: string;
    targetTweakersRoot: string;
    globalRoot: string;
  };
  canonicalHistoryFingerprint: Sha256Fingerprint;
  artifacts: readonly PortableSettingsArtifactReceipt[];
  projectCount: number;
  projectNodeCount: number;
  tweakFlagCount: number;
  exclusions: readonly string[];
  conflicts: readonly string[];
}

interface PortableSettingsJournalV1 {
  schemaVersion: 1;
  kind: "portable-settings-migration-journal";
  decisionId: typeof PORTABLE_SETTINGS_DECISION_ID;
  transactionId: string;
  phase: PortableSettingsPhase;
  intent: PortableSettingsIntentV1;
  intentFingerprint: Sha256Fingerprint;
  publishedArtifacts: readonly ArtifactName[];
  preparedAt: string;
  updatedAt: string;
  reason: string | null;
}

interface PortableSettingsReceiptV1 {
  schemaVersion: 1;
  kind: "portable-settings-migration-receipt";
  decisionId: typeof PORTABLE_SETTINGS_DECISION_ID;
  transactionId: string;
  intentFingerprint: Sha256Fingerprint;
  canonicalHistoryFingerprint: Sha256Fingerprint;
  artifacts: readonly PortableSettingsArtifactReceipt[];
  projectCount: number;
  projectNodeCount: number;
  tweakFlagCount: number;
  exclusions: readonly string[];
  committedAt: string;
}

interface PlannedArtifact extends PortableSettingsArtifactReceipt {
  bytes: Buffer;
}

interface PortableSettingsPlan {
  intent: PortableSettingsIntentV1;
  intentFingerprint: Sha256Fingerprint;
  artifacts: readonly PlannedArtifact[];
}

interface CanonicalThreadMap {
  fingerprint: Sha256Fingerprint;
  nativeToPublic: ReadonlyMap<string, string>;
  publicIds: ReadonlySet<string>;
}

interface PortableProjectNode {
  id: string;
  type: "group" | "project";
  parentId: string | null;
  name: string;
  icon: { kind: "emoji" | "iconify"; value: string };
  color: string;
  connections: Record<string, never>;
  colorMode?: "auto" | "manual";
  overlayIntensity?: "off" | "subtle" | "medium" | "strong";
  taskSort?: string;
  pinnedTaskIds?: string[];
  projectPath?: string;
}

export class PortableSettingsMigrationError extends Error {
  constructor(readonly code: string) {
    super(`Portable settings migration stopped safely: ${code}`);
    this.name = "PortableSettingsMigrationError";
  }
}

/** Explicit operator surface. It never installs, launches, quits, or restarts either app. */
export function portableSettingsMigrationCommand(
  action: string,
  options: PortableSettingsMigrationCliOptions = {},
  dependencies: PortableSettingsMigrationCommandDependencies = {},
): PortableSettingsMigrationResult {
  const normalizedAction = action.trim().toLowerCase();
  const transactionId = cliString(options.transaction, "--transaction");
  const targetTweakersRoot = cliPath(
    options.targetTweakersRoot ?? options["target-tweakers-root"],
    "--target-tweakers-root",
  );
  let result: PortableSettingsMigrationResult;
  if (normalizedAction === "inspect") {
    result = inspectPortableSettingsMigration(targetTweakersRoot, transactionId);
  } else {
    const input = {
      transactionId,
      sourceCodexHomeRoot: cliPath(
        options.sourceCodexHomeRoot ?? options["source-codex-home-root"],
        "--source-codex-home-root",
      ),
      sourceTweakersRoot: cliPath(
        options.sourceTweakersRoot ?? options["source-tweakers-root"],
        "--source-tweakers-root",
      ),
      targetCodexHomeRoot: cliPath(
        options.targetCodexHomeRoot ?? options["target-codex-home-root"],
        "--target-codex-home-root",
      ),
      targetTweakersRoot,
      globalRoot: cliPath(options.globalRoot ?? options["global-root"], "--global-root"),
      chatgptAppPath: cliPath(options.app, "--app"),
      tweakersAppPath: cliPath(options.tweakersApp ?? options["tweakers-app"], "--tweakers-app"),
    };
    if (normalizedAction === "preview") {
      if (options.apply === true) fail("preview-cannot-apply");
      result = migratePortableSettings(input, dependencies);
    } else if (normalizedAction === "apply") {
      if (options.apply !== true) fail("apply-flag-required");
      result = migratePortableSettings({
        ...input,
        apply: true,
        expectedIntentFingerprint: fingerprint(
          options.intentFingerprint ?? options["intent-fingerprint"],
          "invalid-intent-fingerprint",
        ),
      }, dependencies);
    } else if (normalizedAction === "recover") {
      result = recoverPortableSettingsMigration(input, dependencies);
    } else {
      fail("action-must-be-preview-apply-recover-or-inspect");
    }
  }
  (dependencies.print ?? console.log)(JSON.stringify(result));
  return result;
}

function fail(code: string): never {
  throw new PortableSettingsMigrationError(code);
}

export function portableSettingsMigrationPaths(
  targetTweakersRoot: string,
  transactionId: string,
): PortableSettingsPaths {
  const root = exactAbsolute(targetTweakersRoot, "invalid-target-tweakers-root");
  const id = validatedTransactionId(transactionId);
  const transactionParent = join(root, "transactions", "portable-settings");
  const transactionRoot = join(transactionParent, id);
  return {
    transactionParent,
    transactionRoot,
    journal: join(transactionRoot, PORTABLE_SETTINGS_JOURNAL_FILE),
    receipt: join(transactionRoot, PORTABLE_SETTINGS_RECEIPT_FILE),
    lock: join(root, "transactions", "portable-settings.lock"),
    candidates: join(transactionRoot, "candidates"),
    preimages: join(transactionRoot, "preimages"),
    quarantine: join(transactionRoot, "quarantine"),
  };
}

export function migratePortableSettings(
  input: PortableSettingsMigrationInput,
  dependencies: PortableSettingsMigrationDependencies = {},
): PortableSettingsMigrationResult {
  const normalized = normalizeInput(input);
  const paths = portableSettingsMigrationPaths(normalized.targetTweakersRoot, normalized.transactionId);
  assertSourceAndTargetRoots(normalized);
  const censuses = observeZeroWriterWindow(normalized, dependencies);
  void censuses;
  if (normalized.apply === true) {
    const existing = inspectPortableSettingsMigration(normalized.targetTweakersRoot, normalized.transactionId);
    if (existing.status === "applied" || existing.status === "already-applied") {
      return assertAppliedState(paths, normalized);
    }
    if (existing.status !== "preview") fail("transaction-exists-use-recover");
  }
  const plan = createPlan(normalized);
  const preview = resultFromPlan(plan, paths, "preview");
  if (normalized.apply !== true) return preview;
  if (plan.intent.conflicts.length > 0) fail("destination-conflict");
  if (!normalized.expectedIntentFingerprint) fail("expected-intent-fingerprint-required");
  if (normalized.expectedIntentFingerprint !== plan.intentFingerprint) fail("preview-intent-mismatch");

  ensureTransactionParent(paths, normalized.targetTweakersRoot);
  const lockBytes = acquireLock(paths.lock, normalized.transactionId);
  let released = false;
  try {
    createPrivateDirectoryNew(paths.transactionRoot, "transaction-root");
    boundary(dependencies, "transaction-root-created");
    const now = dependencies.now ?? (() => new Date().toISOString());
    let journal: PortableSettingsJournalV1 = {
      schemaVersion: 1,
      kind: "portable-settings-migration-journal",
      decisionId: PORTABLE_SETTINGS_DECISION_ID,
      transactionId: normalized.transactionId,
      phase: "journal-prepared",
      intent: plan.intent,
      intentFingerprint: plan.intentFingerprint,
      publishedArtifacts: [],
      preparedAt: canonicalNow(now()),
      updatedAt: canonicalNow(now()),
      reason: null,
    };
    writePrivateJsonNew(paths.journal, journal, PRIVATE_FILE_MODE, "journal");
    createPrivateDirectoryNew(paths.candidates, "candidate-root");
    createPrivateDirectoryNew(paths.preimages, "preimage-root");
    createPrivateDirectoryNew(paths.quarantine, "quarantine-root");
    boundary(dependencies, "journal-prepared");
    journal = updateJournal(paths, journal, "source-sealed", now);
    boundary(dependencies, "source-sealed");

    for (const artifact of plan.artifacts) {
      if (artifact.hadTarget) {
        copyBoundPrivateFile(artifact.targetPath, artifactPath(paths.preimages, artifact.name), "destination-preimage");
        assertFingerprint(artifactPath(paths.preimages, artifact.name), artifact.preimageFingerprint!, "destination-preimage");
      }
    }
    journal = updateJournal(paths, journal, "destination-preimages-preserved", now);
    boundary(dependencies, "destination-preimages-preserved");

    for (const artifact of plan.artifacts) {
      writePrivateBytesNew(artifactPath(paths.candidates, artifact.name), artifact.bytes, PRIVATE_FILE_MODE, "candidate");
    }
    journal = updateJournal(paths, journal, "candidate-prepared", now);
    boundary(dependencies, "candidate-prepared");
    verifyStagedArtifacts(paths, plan.intent.artifacts);
    journal = updateJournal(paths, journal, "candidate-verified", now);
    boundary(dependencies, "candidate-verified");

    // Nothing consumed by the preview may drift before the first destination
    // mutation. This also repeats the offline proof at the mutable boundary.
    observeZeroWriterWindow(normalized, dependencies);
    const finalPlan = createPlan(normalized);
    if (finalPlan.intentFingerprint !== plan.intentFingerprint) fail("settings-drift-before-publication");

    journal = updateJournal(paths, journal, "publishing", now);
    boundary(dependencies, "publishing");
    const published: ArtifactName[] = [];
    for (const artifact of plan.artifacts) {
      assertCurrentTarget(artifact);
      renameSync(artifactPath(paths.candidates, artifact.name), artifact.targetPath);
      fsyncDirectory(dirname(artifact.targetPath));
      assertFingerprint(artifact.targetPath, artifact.postimageFingerprint, "published-artifact");
      published.push(artifact.name);
      journal = updateJournal(paths, { ...journal, publishedArtifacts: [...published] }, "publishing", now);
      boundary(dependencies, "publishing");
    }
    journal = updateJournal(paths, journal, "published", now);
    boundary(dependencies, "published");
    const receipt: PortableSettingsReceiptV1 = {
      schemaVersion: 1,
      kind: "portable-settings-migration-receipt",
      decisionId: PORTABLE_SETTINGS_DECISION_ID,
      transactionId: normalized.transactionId,
      intentFingerprint: plan.intentFingerprint,
      canonicalHistoryFingerprint: plan.intent.canonicalHistoryFingerprint,
      artifacts: plan.intent.artifacts,
      projectCount: plan.intent.projectCount,
      projectNodeCount: plan.intent.projectNodeCount,
      tweakFlagCount: plan.intent.tweakFlagCount,
      exclusions: plan.intent.exclusions,
      committedAt: canonicalNow(now()),
    };
    writePrivateJsonNew(paths.receipt, receipt, PRIVATE_EVIDENCE_MODE, "receipt");
    journal = updateJournal(paths, journal, "receipt-published", now);
    boundary(dependencies, "receipt-published");
    releaseLock(paths.lock, lockBytes);
    released = true;
    return resultFromPlan(plan, paths, plan.artifacts.every((entry) => !entry.changed) ? "already-applied" : "applied");
  } finally {
    // A fault-injection boundary deliberately leaves its lock and journal as
    // crash evidence. Ordinary pre-journal validation never acquires a lock.
    if (!released && !existsNoFollow(paths.journal)) releaseLock(paths.lock, lockBytes);
  }
}

export function recoverPortableSettingsMigration(
  input: Omit<PortableSettingsMigrationInput, "apply" | "expectedIntentFingerprint">,
  dependencies: PortableSettingsMigrationDependencies = {},
): PortableSettingsMigrationResult {
  const normalized = normalizeInput({ ...input, apply: false });
  const paths = portableSettingsMigrationPaths(normalized.targetTweakersRoot, normalized.transactionId);
  assertSourceAndTargetRoots(normalized);
  observeZeroWriterWindow(normalized, dependencies);
  if (!existsNoFollow(paths.journal)) {
    return recoverPreJournalPortableSettings(paths, normalized.transactionId, dependencies);
  }
  let journal = readJournal(paths.journal, normalized);
  const plan: PortableSettingsPlan = {
    intent: journal.intent,
    intentFingerprint: journal.intentFingerprint,
    artifacts: journal.intent.artifacts.map((entry) => ({ ...entry, bytes: Buffer.alloc(0) })),
  };
  if (journal.phase === "receipt-published") {
    if (existsNoFollow(paths.lock)) {
      const completedLock = takeRecoveryLock(paths.lock, normalized.transactionId, dependencies.isProcessAlive);
      releaseLock(paths.lock, completedLock);
    }
    return assertAppliedState(paths, normalized);
  }
  const lockBytes = takeRecoveryLock(paths.lock, normalized.transactionId, dependencies.isProcessAlive);
  let released = false;
  try {
    const drifted: ArtifactName[] = [];
    for (const artifact of journal.intent.artifacts) {
      const current = fingerprintOptionalFile(artifact.targetPath, "recovery-target");
      const preimage = artifact.preimageFingerprint;
      if (current !== preimage && current !== artifact.postimageFingerprint) drifted.push(artifact.name);
    }
    if (drifted.length > 0) {
      journal = updateJournal(paths, { ...journal, reason: `target-drift:${drifted.sort().join(",")}` }, "manual-recovery-required", dependencies.now ?? (() => new Date().toISOString()));
      releaseLock(paths.lock, lockBytes);
      released = true;
      return resultFromPlan(plan, paths, "manual-recovery-required");
    }
    for (const artifact of journal.intent.artifacts) {
      const current = fingerprintOptionalFile(artifact.targetPath, "recovery-target");
      const preimage = artifact.preimageFingerprint;
      if (current === preimage) continue;
      const quarantine = artifactPath(paths.quarantine, artifact.name);
      if (existsNoFollow(quarantine)) fail("recovery-quarantine-collision");
      renameSync(artifact.targetPath, quarantine);
      fsyncDirectory(dirname(artifact.targetPath));
      if (artifact.hadTarget) {
        const preimagePath = artifactPath(paths.preimages, artifact.name);
        assertFingerprint(preimagePath, artifact.preimageFingerprint!, "recovery-preimage");
        const restore = `${preimagePath}.restore`;
        copyBoundPrivateFile(preimagePath, restore, "recovery-restore", PRIVATE_FILE_MODE);
        renameSync(restore, artifact.targetPath);
        fsyncDirectory(dirname(artifact.targetPath));
      }
      if (fingerprintOptionalFile(artifact.targetPath, "recovery-restored-target") !== preimage) {
        drifted.push(artifact.name);
      }
    }
    journal = updateJournal(paths, { ...journal, reason: null }, "rolled-back", dependencies.now ?? (() => new Date().toISOString()));
    void journal;
    releaseLock(paths.lock, lockBytes);
    released = true;
    return resultFromPlan(plan, paths, "rolled-back");
  } finally {
    if (!released && !existsNoFollow(paths.journal)) releaseLock(paths.lock, lockBytes);
  }
}

export function inspectPortableSettingsMigration(
  targetTweakersRoot: string,
  transactionId: string,
): PortableSettingsMigrationResult {
  const targetRoot = exactAbsolute(targetTweakersRoot, "invalid-target-tweakers-root");
  assertCanonicalDirectory(targetRoot, "target-tweakers-root", true);
  const paths = portableSettingsMigrationPaths(targetRoot, transactionId);
  if (!existsNoFollow(paths.journal)) {
    const interrupted = existsNoFollow(paths.transactionRoot) || existsNoFollow(paths.lock);
    return emptyMigrationResult(paths, validatedTransactionId(transactionId), interrupted
      ? "manual-recovery-required"
      : "preview");
  }
  assertCanonicalDirectory(paths.transactionRoot, "transaction-root", true);
  const raw = readPrivateJson(paths.journal, MAX_JSON_BYTES, "journal");
  const journal = parseJournal(raw);
  if (journal.transactionId !== validatedTransactionId(transactionId)
    || journal.intent.roots.targetTweakersRoot !== targetRoot) fail("inspection-journal-binding-mismatch");
  const plan: PortableSettingsPlan = {
    intent: journal.intent,
    intentFingerprint: journal.intentFingerprint,
    artifacts: journal.intent.artifacts.map((entry) => ({ ...entry, bytes: Buffer.alloc(0) })),
  };
  if (journal.phase === "receipt-published") {
    try {
      return assertAppliedEvidence(paths, journal);
    } catch (error) {
      if (!(error instanceof PortableSettingsMigrationError)) throw error;
      return resultFromPlan(plan, paths, "manual-recovery-required");
    }
  }
  if (journal.phase === "rolled-back") return resultFromPlan(plan, paths, "rolled-back");
  return resultFromPlan(plan, paths, "manual-recovery-required");
}

function createPlan(input: Required<Omit<PortableSettingsMigrationInput, "expectedIntentFingerprint">> & { expectedIntentFingerprint?: Sha256Fingerprint }): PortableSettingsPlan {
  const canonical = readCanonicalThreadMap(input.globalRoot);
  const exclusions = new Set<string>([
    "native-project-order:unproven-schema",
    "native-project-pins:unproven-schema",
    "native-global-appearance:unproven-schema",
    "thread-project-assignments:unproven-schema",
    "sidebar-project-thread-orders:unproven-schema",
    "credentials-cookies-tokens-databases:never-copied",
  ]);
  const conflicts: string[] = [];
  const artifacts: PlannedArtifact[] = [];

  const global = planGlobalState(input, exclusions, conflicts);
  if (global) artifacts.push(global.artifact);
  const projects = planProjects(input, canonical, exclusions, conflicts);
  if (projects) artifacts.push(projects.artifact);
  const config = planConfig(input, exclusions, conflicts);
  if (config) artifacts.push(config.artifact);
  if (artifacts.length === 0) fail("no-portable-settings-found");

  const intent: PortableSettingsIntentV1 = {
    schemaVersion: 1,
    kind: "portable-settings-intent",
    decisionId: PORTABLE_SETTINGS_DECISION_ID,
    transactionId: input.transactionId,
    roots: {
      sourceCodexHomeRoot: input.sourceCodexHomeRoot,
      sourceTweakersRoot: input.sourceTweakersRoot,
      targetCodexHomeRoot: input.targetCodexHomeRoot,
      targetTweakersRoot: input.targetTweakersRoot,
      globalRoot: input.globalRoot,
    },
    canonicalHistoryFingerprint: canonical.fingerprint,
    artifacts: artifacts.map(({ bytes: _bytes, ...entry }) => entry),
    projectCount: global?.count ?? 0,
    projectNodeCount: projects?.count ?? 0,
    tweakFlagCount: config?.count ?? 0,
    exclusions: [...exclusions].sort(compareCodeUnits),
    conflicts: [...new Set(conflicts)].sort(compareCodeUnits),
  };
  return { intent, intentFingerprint: fingerprintCanonical(intent), artifacts };
}

function planGlobalState(
  input: Required<Omit<PortableSettingsMigrationInput, "expectedIntentFingerprint">> & { expectedIntentFingerprint?: Sha256Fingerprint },
  exclusions: Set<string>,
  conflicts: string[],
): { artifact: PlannedArtifact; count: number } | null {
  const sourcePath = join(input.sourceCodexHomeRoot, ".codex-global-state.json");
  if (!existsNoFollow(sourcePath)) {
    exclusions.add("global-state:source-absent");
    return null;
  }
  const sourceBytes = readBoundPrivateFile(sourcePath, MAX_JSON_BYTES, "source-global-state");
  const sourceRaw = parseJsonRecord(sourceBytes, "source-global-state");
  const sourceProjects = projectNativeLocalProjects(sourceRaw);
  if (sourceProjects.projects.size === 0) {
    exclusions.add("global-state:local-projects-absent");
    return null;
  }
  const targetPath = join(input.targetCodexHomeRoot, ".codex-global-state.json");
  const target = readTargetRecord(targetPath, "target-global-state");
  const output = cloneJson(target.value);
  mergeProjectMap(output, sourceProjects.projects, conflicts);
  mergeWorkspaceLabels(output, sourceProjects.labels, conflicts);
  const bytes = jsonBytes(output);
  return {
    artifact: artifactReceipt("global-state", targetPath, sourceBytes, target.bytes, bytes),
    count: sourceProjects.projects.size,
  };
}

function planProjects(
  input: Required<Omit<PortableSettingsMigrationInput, "expectedIntentFingerprint">> & { expectedIntentFingerprint?: Sha256Fingerprint },
  canonical: CanonicalThreadMap,
  exclusions: Set<string>,
  conflicts: string[],
): { artifact: PlannedArtifact; count: number } | null {
  const sourcePath = join(input.sourceTweakersRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json");
  if (!existsNoFollow(sourcePath)) {
    exclusions.add("projects:source-absent");
    return null;
  }
  assertCanonicalDirectory(dirname(sourcePath), "source-projects-parent", true);
  const sourceBytes = readBoundPrivateFile(sourcePath, MAX_PROJECTS_BYTES, "source-projects");
  const projected = projectProjectsState(parseJsonRecord(sourceBytes, "source-projects"), canonical, exclusions);
  const targetPath = join(input.targetTweakersRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json");
  const target = readTargetProjects(targetPath);
  const output = mergeProjectNodes(target.value, projected, canonical, conflicts);
  const bytes = jsonBytes(output);
  return {
    artifact: artifactReceipt("projects", targetPath, sourceBytes, target.bytes, bytes),
    count: projected.nodes.length,
  };
}

function planConfig(
  input: Required<Omit<PortableSettingsMigrationInput, "expectedIntentFingerprint">> & { expectedIntentFingerprint?: Sha256Fingerprint },
  exclusions: Set<string>,
  conflicts: string[],
): { artifact: PlannedArtifact; count: number } | null {
  const sourcePath = join(input.sourceTweakersRoot, "config.json");
  if (!existsNoFollow(sourcePath)) {
    exclusions.add("tweak-enablement:source-absent");
    return null;
  }
  const sourceBytes = readBoundPrivateFile(sourcePath, MAX_JSON_BYTES, "source-config");
  const source = parseJsonRecord(sourceBytes, "source-config");
  const allowed = readBundledTweakIds(join(input.targetTweakersRoot, "tweaks"));
  const flags = projectTweakFlags(source, allowed, exclusions);
  if (flags.size === 0) {
    exclusions.add("tweak-enablement:no-explicit-flags");
    return null;
  }
  const targetPath = join(input.targetTweakersRoot, "config.json");
  const target = readTargetRecord(targetPath, "target-config");
  const output = cloneJson(target.value);
  const targetTweaks = isRecord(output.tweaks) ? output.tweaks as Record<string, unknown> : {};
  for (const [id, enabled] of flags) {
    const current = targetTweaks[id];
    if (current === undefined) {
      targetTweaks[id] = { enabled };
      continue;
    }
    if (!isRecord(current) || (current.enabled !== undefined && typeof current.enabled !== "boolean")) {
      conflicts.push(`config.tweaks.${id}`);
      continue;
    }
    if (current.enabled !== undefined && current.enabled !== enabled) {
      conflicts.push(`config.tweaks.${id}.enabled`);
      continue;
    }
    if (current.enabled === undefined) current.enabled = enabled;
  }
  output.tweaks = targetTweaks;
  const bytes = jsonBytes(output);
  return {
    artifact: artifactReceipt("config", targetPath, sourceBytes, target.bytes, bytes),
    count: flags.size,
  };
}

function projectNativeLocalProjects(value: Record<string, unknown>): {
  projects: Map<string, Record<string, unknown>>;
  labels: Map<string, string>;
} {
  if (!isRecord(value["local-projects"])) fail("source-local-projects-invalid");
  const raw = value["local-projects"] as Record<string, unknown>;
  if (Object.keys(raw).length > MAX_PROJECTS) fail("source-local-projects-capacity-exceeded");
  const projects = new Map<string, Record<string, unknown>>();
  const roots = new Set<string>();
  for (const key of Object.keys(raw).sort(compareCodeUnits)) {
    const candidate = raw[key];
    if (!safeId(key) || !isRecord(candidate) || candidate.id !== key) fail("source-local-project-invalid");
    const name = safeText(candidate.name, 120, "source-project-name-invalid");
    if (!Array.isArray(candidate.rootPaths) || candidate.rootPaths.length < 1 || candidate.rootPaths.length > MAX_PROJECT_PATHS) {
      fail("source-project-roots-invalid");
    }
    const rootPaths = unique(candidate.rootPaths.map((entry) => portablePath(entry, "source-project-root-invalid")));
    if (rootPaths.length < 1) fail("source-project-roots-invalid");
    const projected: Record<string, unknown> = { id: key, name, rootPaths };
    projects.set(key, projected);
    rootPaths.forEach((path) => roots.add(path));
  }
  const labels = new Map<string, string>();
  const rawLabels = value["electron-workspace-root-labels"];
  if (rawLabels !== undefined) {
    if (!isRecord(rawLabels) || Object.keys(rawLabels).length > MAX_PROJECTS * MAX_PROJECT_PATHS) fail("source-workspace-labels-invalid");
    for (const [pathValue, labelValue] of Object.entries(rawLabels).sort(([left], [right]) => compareCodeUnits(left, right))) {
      const path = portablePath(pathValue, "source-workspace-label-path-invalid");
      if (!roots.has(path)) continue;
      labels.set(path, safeText(labelValue, 120, "source-workspace-label-invalid"));
    }
  }
  return { projects, labels };
}

function mergeProjectMap(
  target: Record<string, unknown>,
  source: ReadonlyMap<string, Record<string, unknown>>,
  conflicts: string[],
): void {
  const current = target["local-projects"];
  if (current !== undefined && !isRecord(current)) {
    conflicts.push("global-state.local-projects");
    return;
  }
  const merged = current === undefined ? {} : cloneJson(current as Record<string, unknown>);
  for (const [id, project] of source) {
    if (merged[id] === undefined) merged[id] = project;
    else if (!isRecord(merged[id]) || canonicalJson(projectComparable(merged[id] as Record<string, unknown>)) !== canonicalJson(project)) {
      conflicts.push(`global-state.local-projects.${id}`);
    }
  }
  target["local-projects"] = merged;
}

function mergeWorkspaceLabels(
  target: Record<string, unknown>,
  source: ReadonlyMap<string, string>,
  conflicts: string[],
): void {
  if (source.size === 0) return;
  const current = target["electron-workspace-root-labels"];
  if (current !== undefined && !isRecord(current)) {
    conflicts.push("global-state.electron-workspace-root-labels");
    return;
  }
  const merged = current === undefined ? {} : cloneJson(current as Record<string, unknown>);
  for (const [path, label] of source) {
    if (merged[path] === undefined) merged[path] = label;
    else if (merged[path] !== label) conflicts.push(`global-state.electron-workspace-root-labels.${fingerprintText(path)}`);
  }
  target["electron-workspace-root-labels"] = merged;
}

function projectComparable(value: Record<string, unknown>): Record<string, unknown> {
  const id = safeText(value.id, 80, "target-project-id-invalid");
  const name = safeText(value.name, 120, "target-project-name-invalid");
  if (!Array.isArray(value.rootPaths)) fail("target-project-roots-invalid");
  const result: Record<string, unknown> = {
    id,
    name,
    rootPaths: unique(value.rootPaths.map((entry) => portablePath(entry, "target-project-root-invalid"))),
  };
  return result;
}

function projectProjectsState(
  value: Record<string, unknown>,
  canonical: CanonicalThreadMap,
  exclusions: Set<string>,
): { schemaVersion: 1; nodes: PortableProjectNode[]; includePinnedTaskIds: boolean } {
  if (value.schemaVersion !== 1 || !Array.isArray(value.nodes) || value.nodes.length > MAX_PROJECT_NODES) {
    fail("source-projects-state-invalid");
  }
  let pinnedMappingFailed = false;
  const nodes = value.nodes.map((entry) => projectProjectNode(entry, canonical, () => { pinnedMappingFailed = true; }));
  validateProjectTree(nodes);
  if (pinnedMappingFailed) {
    exclusions.add("projects.pinnedTaskIds:unmapped-family-excluded");
    for (const node of nodes) delete node.pinnedTaskIds;
  }
  return { schemaVersion: 1, nodes, includePinnedTaskIds: !pinnedMappingFailed };
}

function projectProjectNode(
  value: unknown,
  canonical: CanonicalThreadMap,
  markPinnedFailure: () => void,
): PortableProjectNode {
  if (!isRecord(value) || (value.type !== "group" && value.type !== "project")) fail("source-project-node-invalid");
  const id = safeText(value.id, 80, "source-project-node-id-invalid");
  if (!SAFE_ID.test(id)) fail("source-project-node-id-invalid");
  const parentId = value.parentId === null || value.parentId === undefined
    ? null
    : safeText(value.parentId, 80, "source-project-parent-invalid");
  if (parentId !== null && !SAFE_ID.test(parentId)) fail("source-project-parent-invalid");
  const node: PortableProjectNode = {
    id,
    type: value.type,
    parentId,
    name: safeText(value.name, 80, "source-project-node-name-invalid"),
    icon: projectIcon(value.icon),
    color: projectColor(value.color),
    connections: {},
  };
  if (value.type === "project") {
    node.colorMode = COLOR_MODE.has(String(value.colorMode)) ? value.colorMode as "auto" | "manual" : (value.color ? "manual" : "auto");
    node.overlayIntensity = OVERLAY.has(String(value.overlayIntensity ?? "medium"))
      ? String(value.overlayIntensity ?? "medium") as PortableProjectNode["overlayIntensity"]
      : fail("source-project-overlay-invalid");
    if (value.taskSort !== undefined && value.taskSort !== null && value.taskSort !== "") {
      if (!TASK_SORT.has(String(value.taskSort))) fail("source-project-task-sort-invalid");
      node.taskSort = String(value.taskSort);
    }
    if (value.projectPath !== undefined && value.projectPath !== null && value.projectPath !== "") {
      node.projectPath = portablePath(value.projectPath, "source-project-path-invalid");
    }
    if (value.pinnedTaskIds !== undefined && value.pinnedTaskIds !== null) {
      if (!Array.isArray(value.pinnedTaskIds) || value.pinnedTaskIds.length > MAX_PINNED_TASKS) fail("source-project-pins-invalid");
      const mapped: string[] = [];
      for (const candidate of value.pinnedTaskIds) {
        if (typeof candidate !== "string" || !safeId(candidate)) fail("source-project-pin-invalid");
        const publicId = canonical.publicIds.has(candidate) ? candidate : canonical.nativeToPublic.get(candidate);
        if (!publicId) {
          markPinnedFailure();
          continue;
        }
        if (!mapped.includes(publicId)) mapped.push(publicId);
      }
      if (mapped.length > 0) node.pinnedTaskIds = mapped;
    }
  }
  return node;
}

function mergeProjectNodes(
  target: { schemaVersion: 1; nodes: unknown[] },
  source: { schemaVersion: 1; nodes: PortableProjectNode[]; includePinnedTaskIds: boolean },
  canonical: CanonicalThreadMap,
  conflicts: string[],
): { schemaVersion: 1; nodes: unknown[] } {
  if (target.nodes.length === 0) return { schemaVersion: 1, nodes: source.nodes };
  const output = cloneJson(target);
  const byId = new Map<string, unknown>();
  const byPath = new Map<string, string>();
  for (const value of output.nodes) {
    if (!isRecord(value) || typeof value.id !== "string") fail("target-projects-state-invalid");
    byId.set(value.id, value);
    if (typeof value.projectPath === "string") byPath.set(portablePath(value.projectPath, "target-project-path-invalid"), value.id);
  }
  for (const node of source.nodes) {
    const existing = byId.get(node.id);
    const pathOwner = node.projectPath ? byPath.get(node.projectPath) : undefined;
    if (pathOwner !== undefined && pathOwner !== node.id) {
      conflicts.push(`projects.projectPath.${fingerprintText(node.projectPath!)}`);
      continue;
    }
    if (existing === undefined) {
      output.nodes.push(node);
      byId.set(node.id, node);
      if (node.projectPath) byPath.set(node.projectPath, node.id);
    } else {
      let targetPinnedMappingFailed = false;
      const comparable = projectProjectNode(existing, canonical, () => { targetPinnedMappingFailed = true; });
      if (!source.includePinnedTaskIds) delete comparable.pinnedTaskIds;
      if ((source.includePinnedTaskIds && targetPinnedMappingFailed) || canonicalJson(comparable) !== canonicalJson(node)) {
        conflicts.push(`projects.nodes.${node.id}`);
      }
    }
  }
  return output;
}

function validateProjectTree(nodes: readonly PortableProjectNode[]): void {
  const byId = new Map<string, PortableProjectNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) fail("source-project-node-duplicate");
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    let current = node;
    const seen = new Set([node.id]);
    let depth = 0;
    while (current.parentId !== null) {
      if (seen.has(current.parentId)) fail("source-project-tree-cycle");
      seen.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent || parent.type !== "group" || ++depth > 8) fail("source-project-parent-invalid");
      current = parent;
    }
  }
}

function projectIcon(value: unknown): PortableProjectNode["icon"] {
  if (!isRecord(value)) return { kind: "emoji", value: "📁" };
  if (value.kind === "emoji" && typeof value.value === "string" && EMOJI.test(value.value)) return { kind: "emoji", value: value.value };
  if (value.kind === "iconify" && typeof value.value === "string" && ICONIFY.test(value.value)) return { kind: "iconify", value: value.value };
  fail("source-project-icon-invalid");
}

function projectColor(value: unknown): string {
  if (value === undefined || value === null || value === "") return "#6b7280";
  if (typeof value !== "string" || !COLOR.test(value)) fail("source-project-color-invalid");
  return value.toLowerCase();
}

function readTargetProjects(path: string): { value: { schemaVersion: 1; nodes: unknown[] }; bytes: Buffer | null } {
  if (!existsNoFollow(path)) return { value: { schemaVersion: 1, nodes: [] }, bytes: null };
  const bytes = readBoundPrivateFile(path, MAX_PROJECTS_BYTES, "target-projects");
  const value = parseJsonRecord(bytes, "target-projects");
  if (value.schemaVersion !== 1 || !Array.isArray(value.nodes) || value.nodes.length > MAX_PROJECT_NODES) fail("target-projects-state-invalid");
  return { value: value as unknown as { schemaVersion: 1; nodes: unknown[] }, bytes };
}

function projectTweakFlags(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  exclusions: Set<string>,
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  if (source.tweaks === undefined) return result;
  if (!isRecord(source.tweaks) || Object.keys(source.tweaks).length > MAX_TWEAKS) fail("source-tweak-flags-invalid");
  for (const [id, value] of Object.entries(source.tweaks).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (!allowed.has(id)) {
      exclusions.add(`tweak-enablement:unknown-id:${fingerprintText(id)}`);
      continue;
    }
    if (!isRecord(value) || (value.enabled !== undefined && typeof value.enabled !== "boolean")) fail("source-tweak-flag-invalid");
    if (typeof value.enabled === "boolean") result.set(id, value.enabled);
  }
  return result;
}

function readBundledTweakIds(root: string): Set<string> {
  assertCanonicalDirectory(root, "target-tweaks-root", false);
  let entries: string[];
  try {
    entries = readFileDirectory(root);
  } catch {
    fail("target-tweaks-root-unreadable");
  }
  if (entries.length > MAX_TWEAKS) fail("target-tweaks-capacity-exceeded");
  const ids = new Set<string>();
  for (const entry of entries) {
    const entryRoot = join(root, entry);
    let entryStat: Stats;
    try { entryStat = lstatSync(entryRoot); } catch { fail("target-tweak-directory-unreadable"); }
    if (entryStat.isSymbolicLink()) fail("target-tweak-directory-unsafe");
    if (!entryStat.isDirectory()) continue;
    assertCanonicalDirectory(entryRoot, "target-tweak-directory", true);
    const manifest = join(entryRoot, "manifest.json");
    if (!existsNoFollow(manifest)) continue;
    const value = parseJsonRecord(readBoundFile(manifest, MAX_PROJECTS_BYTES, "target-tweak-manifest", false), "target-tweak-manifest");
    if (typeof value.id !== "string" || !safeId(value.id) || value.id !== entry || ids.has(value.id)) fail("target-tweak-manifest-invalid");
    ids.add(value.id);
  }
  if (ids.size === 0) fail("target-tweak-manifests-missing");
  return ids;
}

function readCanonicalThreadMap(globalRoot: string): CanonicalThreadMap {
  const preflight = preflightCanonicalHistoryStore(globalRoot);
  if (preflight.state !== "ready") fail("canonical-history-not-ready");
  const path = join(globalRoot, CANONICAL_HISTORY_FILE);
  const bytes = readBoundPrivateFile(path, MAX_JSON_BYTES, "canonical-history");
  const value = parseJsonRecord(bytes, "canonical-history");
  if (value.version !== 1 || !Array.isArray(value.conversations)) fail("canonical-history-invalid");
  const nativeToPublic = new Map<string, string>();
  const publicIds = new Set<string>();
  for (const conversation of value.conversations) {
    if (!isRecord(conversation) || typeof conversation.publicThreadId !== "string" || !PUBLIC_THREAD_ID.test(conversation.publicThreadId)
      || typeof conversation.rootNativeThreadId !== "string" || !Array.isArray(conversation.segments)) fail("canonical-history-invalid");
    if (publicIds.has(conversation.publicThreadId)) fail("canonical-history-public-id-conflict");
    publicIds.add(conversation.publicThreadId);
    const nativeIds = [conversation.rootNativeThreadId];
    for (const segment of conversation.segments) {
      if (!isRecord(segment) || typeof segment.nativeThreadId !== "string") fail("canonical-history-invalid");
      nativeIds.push(segment.nativeThreadId);
    }
    for (const nativeId of nativeIds) {
      const existing = nativeToPublic.get(nativeId);
      if (existing && existing !== conversation.publicThreadId) fail("canonical-history-native-id-conflict");
      nativeToPublic.set(nativeId, conversation.publicThreadId);
    }
  }
  return { fingerprint: fingerprintBytes(bytes), nativeToPublic, publicIds };
}

function normalizeInput(input: PortableSettingsMigrationInput): Required<Omit<PortableSettingsMigrationInput, "expectedIntentFingerprint">> & { expectedIntentFingerprint?: Sha256Fingerprint } {
  if (!isRecord(input)) fail("invalid-input");
  const normalized = {
    transactionId: validatedTransactionId(input.transactionId),
    sourceCodexHomeRoot: exactAbsolute(input.sourceCodexHomeRoot, "invalid-source-codex-home-root"),
    sourceTweakersRoot: exactAbsolute(input.sourceTweakersRoot, "invalid-source-tweakers-root"),
    targetCodexHomeRoot: exactAbsolute(input.targetCodexHomeRoot, "invalid-target-codex-home-root"),
    targetTweakersRoot: exactAbsolute(input.targetTweakersRoot, "invalid-target-tweakers-root"),
    globalRoot: exactAbsolute(input.globalRoot, "invalid-global-root"),
    chatgptAppPath: exactAbsolute(input.chatgptAppPath, "invalid-chatgpt-app-path"),
    tweakersAppPath: exactAbsolute(input.tweakersAppPath, "invalid-tweakers-app-path"),
    apply: input.apply === true,
    ...(input.expectedIntentFingerprint ? { expectedIntentFingerprint: fingerprint(input.expectedIntentFingerprint, "invalid-intent-fingerprint") } : {}),
  };
  if (normalized.chatgptAppPath === normalized.tweakersAppPath
    || normalized.sourceCodexHomeRoot === normalized.targetCodexHomeRoot
    || normalized.sourceTweakersRoot === normalized.targetTweakersRoot) fail("source-target-roots-not-isolated");
  return normalized;
}

function assertSourceAndTargetRoots(input: ReturnType<typeof normalizeInput>): void {
  assertCanonicalDirectory(input.sourceCodexHomeRoot, "source-codex-home-root", true);
  assertCanonicalDirectory(input.sourceTweakersRoot, "source-tweakers-root", true);
  assertCanonicalDirectory(input.targetCodexHomeRoot, "target-codex-home-root", true);
  assertCanonicalDirectory(input.targetTweakersRoot, "target-tweakers-root", true);
  assertCanonicalDirectory(input.globalRoot, "global-root", true);
  assertCanonicalDirectory(input.chatgptAppPath, "chatgpt-app", false);
  assertCanonicalDirectory(input.tweakersAppPath, "tweakers-app", false);
  for (const [left, right] of [
    [input.sourceCodexHomeRoot, input.targetCodexHomeRoot],
    [input.sourceTweakersRoot, input.targetTweakersRoot],
    [input.globalRoot, input.sourceCodexHomeRoot],
    [input.globalRoot, input.targetCodexHomeRoot],
  ] as const) {
    if (pathContains(left, right) || pathContains(right, left)) fail("portable-settings-roots-overlap");
  }
  assertCanonicalDirectory(dirname(join(input.targetTweakersRoot, "config.json")), "target-config-parent", true);
  assertCanonicalDirectory(dirname(join(input.targetCodexHomeRoot, ".codex-global-state.json")), "target-global-state-parent", true);
  assertCanonicalDirectory(dirname(join(input.targetTweakersRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json")), "target-projects-parent", true);
}

function observeZeroWriterWindow(
  input: ReturnType<typeof normalizeInput>,
  dependencies: PortableSettingsMigrationDependencies,
): readonly [PortableSettingsWriterCensus, PortableSettingsWriterCensus] {
  const protectedPaths = unique([
    input.sourceCodexHomeRoot,
    input.sourceTweakersRoot,
    input.targetCodexHomeRoot,
    input.targetTweakersRoot,
    input.globalRoot,
  ]);
  const census = dependencies.census ?? defaultPortableSettingsCensus;
  const observe = () => census({
    chatgptAppPath: input.chatgptAppPath,
    tweakersAppPath: input.tweakersAppPath,
    protectedPaths,
  });
  const first = observe();
  assertZeroWriterCensus(first);
  (dependencies.wait ?? defaultWait)(1_000);
  const second = observe();
  assertZeroWriterCensus(second);
  return [first, second];
}

function defaultPortableSettingsCensus(input: {
  chatgptAppPath: string;
  tweakersAppPath: string;
  protectedPaths: readonly string[];
}): PortableSettingsWriterCensus {
  const observe = (appPath: string): HistoryAdoptionCensus => observeHistoryAdoptionCensus({ appPath, protectedPaths: input.protectedPaths });
  const chatgpt = observe(input.chatgptAppPath);
  const tweakers = observe(input.tweakersAppPath);
  const classify = (value: HistoryAdoptionCensus): "idle" | "running" | "unknown" => value.app === "unknown" || value.main === "unknown"
    ? "unknown"
    : value.app === "idle" && value.main === "idle" ? "idle" : "running";
  const servers = chatgpt.appServer === "unknown" || tweakers.appServer === "unknown"
    ? "unknown"
    : chatgpt.appServer === "idle" && tweakers.appServer === "idle" ? "idle" : "running";
  return {
    observedAt: new Date().toISOString(),
    chatgpt: classify(chatgpt),
    tweakers: classify(tweakers),
    appServers: servers,
    openFileCount: chatgpt.openFileCount < 0 || tweakers.openFileCount < 0
      ? -1
      : chatgpt.openFileCount + tweakers.openFileCount,
  };
}

function assertZeroWriterCensus(value: PortableSettingsWriterCensus): void {
  if (!isRecord(value) || !isCanonicalUtcTimestamp(value.observedAt)
    || value.chatgpt !== "idle" || value.tweakers !== "idle" || value.appServers !== "idle"
    || value.openFileCount !== 0) fail("portable-settings-writers-not-zero");
}

function defaultWait(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function artifactReceipt(
  name: ArtifactName,
  targetPath: string,
  sourceBytes: Buffer,
  targetBytes: Buffer | null,
  outputBytes: Buffer,
): PlannedArtifact {
  return {
    name,
    targetPath,
    sourceFingerprint: fingerprintBytes(sourceBytes),
    preimageFingerprint: targetBytes === null ? null : fingerprintBytes(targetBytes),
    postimageFingerprint: fingerprintBytes(outputBytes),
    hadTarget: targetBytes !== null,
    changed: targetBytes === null || !targetBytes.equals(outputBytes),
    bytes: outputBytes,
  };
}

function resultFromPlan(
  plan: PortableSettingsPlan,
  paths: PortableSettingsPaths,
  status: PortableSettingsMigrationResult["status"],
): PortableSettingsMigrationResult {
  const holdActivation = plan.intent.conflicts.length > 0 || status === "manual-recovery-required" || status === "rolled-back";
  const nextAction = status === "preview"
    ? plan.intent.conflicts.length > 0 ? "none" : "apply-with-intent"
    : status === "manual-recovery-required" ? "recover-explicitly"
      : status === "applied" || status === "already-applied" ? "activation-remains-user-confirmed"
        : "none";
  return {
    schemaVersion: 1,
    kind: "portable-settings-migration-result",
    decisionId: PORTABLE_SETTINGS_DECISION_ID,
    transactionId: plan.intent.transactionId,
    status,
    intentFingerprint: plan.intentFingerprint,
    canonicalHistoryFingerprint: plan.intent.canonicalHistoryFingerprint,
    artifacts: plan.intent.artifacts,
    projectCount: plan.intent.projectCount,
    projectNodeCount: plan.intent.projectNodeCount,
    tweakFlagCount: plan.intent.tweakFlagCount,
    exclusions: plan.intent.exclusions,
    conflicts: plan.intent.conflicts,
    journalPath: paths.journal,
    receiptPath: paths.receipt,
    holdActivation,
    nextAction,
  };
}

function assertAppliedState(paths: PortableSettingsPaths, input: ReturnType<typeof normalizeInput>): PortableSettingsMigrationResult {
  const journal = readJournal(paths.journal, input);
  return assertAppliedEvidence(paths, journal);
}

function assertAppliedEvidence(
  paths: PortableSettingsPaths,
  journal: PortableSettingsJournalV1,
): PortableSettingsMigrationResult {
  if (journal.phase !== "receipt-published" || !existsNoFollow(paths.receipt)) fail("applied-receipt-missing");
  const receipt = parseReceipt(readPrivateJson(paths.receipt, MAX_JSON_BYTES, "receipt"), journal);
  for (const artifact of receipt.artifacts) assertFingerprint(artifact.targetPath, artifact.postimageFingerprint, "applied-target");
  const plan: PortableSettingsPlan = {
    intent: journal.intent,
    intentFingerprint: journal.intentFingerprint,
    artifacts: journal.intent.artifacts.map((entry) => ({ ...entry, bytes: Buffer.alloc(0) })),
  };
  return resultFromPlan(plan, paths, receipt.artifacts.every((entry) => !entry.changed) ? "already-applied" : "applied");
}

function verifyStagedArtifacts(paths: PortableSettingsPaths, artifacts: readonly PortableSettingsArtifactReceipt[]): void {
  for (const artifact of artifacts) assertFingerprint(artifactPath(paths.candidates, artifact.name), artifact.postimageFingerprint, "candidate");
}

function assertCurrentTarget(artifact: PortableSettingsArtifactReceipt): void {
  if (fingerprintOptionalFile(artifact.targetPath, "publication-target") !== artifact.preimageFingerprint) {
    fail(`destination-drift-${artifact.name}`);
  }
}

function artifactPath(root: string, name: ArtifactName): string {
  return join(root, `${name}.json`);
}

function ensureTransactionParent(paths: PortableSettingsPaths, targetRoot: string): void {
  const transactions = join(targetRoot, "transactions");
  ensurePrivateChildDirectory(targetRoot, transactions, "transactions-root");
  ensurePrivateChildDirectory(transactions, paths.transactionParent, "portable-settings-transaction-root");
}

function ensurePrivateChildDirectory(parent: string, path: string, label: string): void {
  assertCanonicalDirectory(parent, `${label}-parent`, true);
  if (!existsNoFollow(path)) {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    fsyncDirectory(parent);
  }
  assertCanonicalDirectory(path, label, true);
}

function createPrivateDirectoryNew(path: string, label: string): void {
  if (existsNoFollow(path)) fail(`${label}-already-exists`);
  mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertCanonicalDirectory(path, label, true);
  fsyncDirectory(dirname(path));
}

function updateJournal(
  paths: PortableSettingsPaths,
  journal: PortableSettingsJournalV1,
  phase: PortableSettingsPhase,
  now: () => string,
): PortableSettingsJournalV1 {
  const updated: PortableSettingsJournalV1 = { ...journal, phase, updatedAt: canonicalNow(now()) };
  const staging = join(paths.transactionRoot, `.journal-${phase}.tmp`);
  writePrivateJsonNew(staging, updated, PRIVATE_FILE_MODE, "journal-staging");
  renameSync(staging, paths.journal);
  fsyncDirectory(paths.transactionRoot);
  return updated;
}

function boundary(dependencies: PortableSettingsMigrationDependencies, phase: PortableSettingsBoundary): void {
  dependencies.beforePhase?.(phase);
}

function recoverPreJournalPortableSettings(
  paths: PortableSettingsPaths,
  transactionId: string,
  dependencies: PortableSettingsMigrationDependencies,
): PortableSettingsMigrationResult {
  const hadTransactionRoot = existsNoFollow(paths.transactionRoot);
  const hadLock = existsNoFollow(paths.lock);
  if (!hadTransactionRoot && !hadLock) fail("recovery-journal-missing");
  const lockBytes = takeRecoveryLock(paths.lock, transactionId, dependencies.isProcessAlive);
  let released = false;
  try {
    if (hadTransactionRoot) {
      assertCanonicalDirectory(paths.transactionRoot, "pre-journal-transaction-root", true);
      if (readFileDirectory(paths.transactionRoot).length !== 0) fail("pre-journal-transaction-root-not-empty");
      const retained = `${paths.transactionRoot}.pre-journal-aborted`;
      if (existsNoFollow(retained)) fail("pre-journal-retention-collision");
      renameSync(paths.transactionRoot, retained);
      fsyncDirectory(paths.transactionParent);
    }
    releaseLock(paths.lock, lockBytes);
    released = true;
    return emptyMigrationResult(paths, transactionId, "rolled-back");
  } finally {
    if (!released) releaseLock(paths.lock, lockBytes);
  }
}

function emptyMigrationResult(
  paths: PortableSettingsPaths,
  transactionId: string,
  status: "preview" | "rolled-back" | "manual-recovery-required",
): PortableSettingsMigrationResult {
  const holdActivation = status !== "preview";
  return {
    schemaVersion: 1,
    kind: "portable-settings-migration-result",
    decisionId: PORTABLE_SETTINGS_DECISION_ID,
    transactionId,
    status,
    intentFingerprint: emptyFingerprint(),
    canonicalHistoryFingerprint: emptyFingerprint(),
    artifacts: [],
    projectCount: 0,
    projectNodeCount: 0,
    tweakFlagCount: 0,
    exclusions: [],
    conflicts: [],
    journalPath: paths.journal,
    receiptPath: paths.receipt,
    holdActivation,
    nextAction: status === "preview" ? "apply-with-intent"
      : status === "manual-recovery-required" ? "recover-explicitly"
        : "none",
  };
}

function readJournal(path: string, input: ReturnType<typeof normalizeInput>): PortableSettingsJournalV1 {
  const journal = parseJournal(readPrivateJson(path, MAX_JSON_BYTES, "journal"));
  if (journal.transactionId !== input.transactionId
    || journal.intent.roots.sourceCodexHomeRoot !== input.sourceCodexHomeRoot
    || journal.intent.roots.sourceTweakersRoot !== input.sourceTweakersRoot
    || journal.intent.roots.targetCodexHomeRoot !== input.targetCodexHomeRoot
    || journal.intent.roots.targetTweakersRoot !== input.targetTweakersRoot
    || journal.intent.roots.globalRoot !== input.globalRoot) fail("recovery-journal-binding-mismatch");
  return journal;
}

function parseJournal(value: unknown): PortableSettingsJournalV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "kind", "decisionId", "transactionId", "phase", "intent", "intentFingerprint",
    "publishedArtifacts", "preparedAt", "updatedAt", "reason",
  ]) || value.schemaVersion !== 1 || value.kind !== "portable-settings-migration-journal"
    || value.decisionId !== PORTABLE_SETTINGS_DECISION_ID || typeof value.transactionId !== "string"
    || !TRANSACTION_ID.test(value.transactionId) || !isPortableSettingsPhase(value.phase)
    || !isFingerprint(value.intentFingerprint) || !Array.isArray(value.publishedArtifacts)
    || !isCanonicalUtcTimestamp(value.preparedAt) || !isCanonicalUtcTimestamp(value.updatedAt)
    || !(value.reason === null || typeof value.reason === "string")) fail("journal-invalid");
  const intent = parseIntent(value.intent);
  if (fingerprintCanonical(intent) !== value.intentFingerprint || intent.transactionId !== value.transactionId) fail("journal-intent-mismatch");
  const publishedArtifacts = value.publishedArtifacts.map((entry) => artifactName(entry));
  if (new Set(publishedArtifacts).size !== publishedArtifacts.length) fail("journal-invalid");
  return {
    schemaVersion: 1,
    kind: "portable-settings-migration-journal",
    decisionId: PORTABLE_SETTINGS_DECISION_ID,
    transactionId: value.transactionId,
    phase: value.phase,
    intent,
    intentFingerprint: value.intentFingerprint,
    publishedArtifacts,
    preparedAt: value.preparedAt,
    updatedAt: value.updatedAt,
    reason: value.reason,
  } as PortableSettingsJournalV1;
}

function parseIntent(value: unknown): PortableSettingsIntentV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "kind", "decisionId", "transactionId", "roots", "canonicalHistoryFingerprint", "artifacts",
    "projectCount", "projectNodeCount", "tweakFlagCount", "exclusions", "conflicts",
  ]) || value.schemaVersion !== 1 || value.kind !== "portable-settings-intent" || value.decisionId !== PORTABLE_SETTINGS_DECISION_ID
    || typeof value.transactionId !== "string" || !TRANSACTION_ID.test(value.transactionId)
    || !isFingerprint(value.canonicalHistoryFingerprint) || !Array.isArray(value.artifacts)
    || !nonNegativeInteger(value.projectCount) || !nonNegativeInteger(value.projectNodeCount) || !nonNegativeInteger(value.tweakFlagCount)
    || !stringArray(value.exclusions) || !stringArray(value.conflicts) || !isRecord(value.roots)
    || !hasExactKeys(value.roots, ["sourceCodexHomeRoot", "sourceTweakersRoot", "targetCodexHomeRoot", "targetTweakersRoot", "globalRoot"])) fail("intent-invalid");
  const roots = value.roots as Record<string, unknown>;
  for (const key of Object.keys(roots)) if (typeof roots[key] !== "string" || exactAbsolute(roots[key] as string, "intent-root-invalid") !== roots[key]) fail("intent-root-invalid");
  const artifacts = value.artifacts.map(parseArtifactReceipt);
  if (artifacts.length < 1 || artifacts.length > 3
    || new Set(artifacts.map((entry) => entry.name)).size !== artifacts.length) fail("intent-invalid");
  const intent = {
    schemaVersion: 1,
    kind: "portable-settings-intent",
    decisionId: PORTABLE_SETTINGS_DECISION_ID,
    transactionId: value.transactionId,
    roots: roots as PortableSettingsIntentV1["roots"],
    canonicalHistoryFingerprint: value.canonicalHistoryFingerprint,
    artifacts,
    projectCount: value.projectCount,
    projectNodeCount: value.projectNodeCount,
    tweakFlagCount: value.tweakFlagCount,
    exclusions: value.exclusions,
    conflicts: value.conflicts,
  } as PortableSettingsIntentV1;
  assertIntentArtifactTargets(intent);
  return intent;
}

function assertIntentArtifactTargets(intent: PortableSettingsIntentV1): void {
  const expected: Record<ArtifactName, string> = {
    "global-state": join(intent.roots.targetCodexHomeRoot, ".codex-global-state.json"),
    projects: join(intent.roots.targetTweakersRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json"),
    config: join(intent.roots.targetTweakersRoot, "config.json"),
  };
  for (const artifact of intent.artifacts) {
    if (artifact.targetPath !== expected[artifact.name]) fail("artifact-target-binding-mismatch");
  }
}

function parseArtifactReceipt(value: unknown): PortableSettingsArtifactReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "name", "targetPath", "sourceFingerprint", "preimageFingerprint", "postimageFingerprint", "hadTarget", "changed",
  ])) fail("artifact-receipt-invalid");
  const name = artifactName(value.name);
  if (typeof value.targetPath !== "string" || exactAbsolute(value.targetPath, "artifact-target-invalid") !== value.targetPath
    || !isFingerprint(value.sourceFingerprint) || !(value.preimageFingerprint === null || isFingerprint(value.preimageFingerprint))
    || !isFingerprint(value.postimageFingerprint) || typeof value.hadTarget !== "boolean" || typeof value.changed !== "boolean"
    || value.hadTarget !== (value.preimageFingerprint !== null)) fail("artifact-receipt-invalid");
  return value as unknown as PortableSettingsArtifactReceipt;
}

function parseReceipt(value: unknown, journal: PortableSettingsJournalV1): PortableSettingsReceiptV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "kind", "decisionId", "transactionId", "intentFingerprint", "canonicalHistoryFingerprint",
    "artifacts", "projectCount", "projectNodeCount", "tweakFlagCount", "exclusions", "committedAt",
  ]) || value.schemaVersion !== 1 || value.kind !== "portable-settings-migration-receipt"
    || value.decisionId !== PORTABLE_SETTINGS_DECISION_ID || value.transactionId !== journal.transactionId
    || value.intentFingerprint !== journal.intentFingerprint || value.canonicalHistoryFingerprint !== journal.intent.canonicalHistoryFingerprint
    || !Array.isArray(value.artifacts) || !nonNegativeInteger(value.projectCount) || !nonNegativeInteger(value.projectNodeCount)
    || !nonNegativeInteger(value.tweakFlagCount) || !stringArray(value.exclusions) || !isCanonicalUtcTimestamp(value.committedAt)) fail("receipt-invalid");
  const artifacts = value.artifacts.map(parseArtifactReceipt);
  if (canonicalJson(artifacts) !== canonicalJson(journal.intent.artifacts)
    || value.projectCount !== journal.intent.projectCount || value.projectNodeCount !== journal.intent.projectNodeCount
    || value.tweakFlagCount !== journal.intent.tweakFlagCount || canonicalJson(value.exclusions) !== canonicalJson(journal.intent.exclusions)) fail("receipt-journal-mismatch");
  return {
    schemaVersion: 1,
    kind: "portable-settings-migration-receipt",
    decisionId: PORTABLE_SETTINGS_DECISION_ID,
    transactionId: value.transactionId,
    intentFingerprint: value.intentFingerprint,
    canonicalHistoryFingerprint: value.canonicalHistoryFingerprint,
    artifacts,
    projectCount: value.projectCount,
    projectNodeCount: value.projectNodeCount,
    tweakFlagCount: value.tweakFlagCount,
    exclusions: value.exclusions,
    committedAt: value.committedAt,
  } as PortableSettingsReceiptV1;
}

function acquireLock(path: string, transactionId: string): Buffer {
  if (existsNoFollow(path)) fail("portable-settings-lock-held");
  const bytes = jsonBytes({ version: 1, transactionId, pid: process.pid, createdAt: new Date().toISOString() });
  writePrivateBytesNew(path, bytes, PRIVATE_FILE_MODE, "portable-settings-lock");
  return bytes;
}

function takeRecoveryLock(path: string, transactionId: string, isAlive: ((pid: number) => boolean) | undefined): Buffer {
  if (existsNoFollow(path)) {
    const bytes = readBoundPrivateFile(path, MAX_PROJECTS_BYTES, "portable-settings-lock");
    const value = parseJsonRecord(bytes, "portable-settings-lock");
    if (value.version !== 1 || value.transactionId !== transactionId || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
      fail("portable-settings-lock-invalid");
    }
    const alive = (isAlive ?? defaultIsProcessAlive)(value.pid as number);
    if (alive) fail("portable-settings-lock-owner-active");
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  }
  return acquireLock(path, transactionId);
}

function defaultIsProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function releaseLock(path: string, expected: Buffer): void {
  if (!existsNoFollow(path)) return;
  const current = readBoundPrivateFile(path, MAX_PROJECTS_BYTES, "portable-settings-lock");
  if (!current.equals(expected)) fail("portable-settings-lock-changed");
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function copyBoundPrivateFile(
  source: string,
  destination: string,
  label: string,
  mode: number = PRIVATE_EVIDENCE_MODE,
): void {
  if (existsNoFollow(destination)) fail(`${label}-destination-exists`);
  const expected = fingerprintOptionalFile(source, label);
  if (expected === null) fail(`${label}-source-missing`);
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  const descriptor = openSync(destination, fsConstants.O_RDONLY | noFollowFlag());
  try { fchmodSync(descriptor, mode); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  fsyncDirectory(dirname(destination));
  assertFingerprint(destination, expected, label);
}

function writePrivateJsonNew(path: string, value: unknown, mode: number, label: string): void {
  writePrivateBytesNew(path, jsonBytes(value), mode, label);
}

function writePrivateBytesNew(path: string, bytes: Buffer, mode: number, label: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), mode);
  } catch {
    fail(`${label}-already-exists-or-unsafe`);
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) fail(`${label}-short-write`);
      offset += written;
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function readTargetRecord(path: string, label: string): { value: Record<string, unknown>; bytes: Buffer | null } {
  if (!existsNoFollow(path)) return { value: {}, bytes: null };
  const bytes = readBoundPrivateFile(path, MAX_JSON_BYTES, label);
  return { value: parseJsonRecord(bytes, label), bytes };
}

function readPrivateJson(path: string, max: number, label: string): unknown {
  return parseJson(readBoundPrivateFile(path, max, label), label);
}

function readBoundPrivateFile(path: string, max: number, label: string): Buffer {
  return readBoundFile(path, max, label, true);
}

function readBoundFile(path: string, max: number, label: string, ownerPrivate: boolean): Buffer {
  let descriptor: number;
  try { descriptor = openSync(path, fsConstants.O_RDONLY | noFollowFlag()); } catch { fail(`${label}-unreadable`); }
  try {
    const before = fstatSync(descriptor);
    assertRegularFileStat(before, label, ownerPrivate, max);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameStat(before, after) || bytes.length !== before.size) fail(`${label}-changed-during-read`);
    return bytes;
  } finally { closeSync(descriptor); }
}

function assertRegularFileStat(stat: Stats, label: string, ownerPrivate: boolean, max: number): void {
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max
    || (uid !== undefined && (ownerPrivate ? stat.uid !== uid : stat.uid !== uid && stat.uid !== 0))
    || (ownerPrivate && (stat.mode & 0o077) !== 0)) fail(`${label}-unsafe`);
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertCanonicalDirectory(path: string, label: string, ownerPrivate: boolean): void {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { fail(`${label}-missing`); }
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (uid !== undefined && (ownerPrivate ? stat.uid !== uid : stat.uid !== uid && stat.uid !== 0))
    || (stat.mode & 0o022) !== 0 || (ownerPrivate && (stat.mode & 0o077) !== 0)) fail(`${label}-unsafe`);
  let canonical: string;
  try { canonical = realpathSync.native(path); } catch { fail(`${label}-unsafe`); }
  if (canonical !== path) fail(`${label}-not-canonical`);
}

function assertFingerprint(path: string, expected: Sha256Fingerprint, label: string): void {
  const actual = fingerprintOptionalFile(path, label);
  if (actual !== expected) fail(`${label}-fingerprint-mismatch`);
}

function fingerprintOptionalFile(path: string, label: string): Sha256Fingerprint | null {
  if (!existsNoFollow(path)) return null;
  return fingerprintBytes(readBoundPrivateFile(path, MAX_JSON_BYTES, label));
}

function existsNoFollow(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail("filesystem-inspection-failed");
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function fingerprintBytes(bytes: Buffer): Sha256Fingerprint {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Fingerprint;
}

function fingerprintCanonical(value: unknown): Sha256Fingerprint {
  return fingerprintBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function emptyFingerprint(): Sha256Fingerprint {
  return fingerprintBytes(Buffer.alloc(0));
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch { fail(`${label}-invalid-json`); }
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  const value = parseJson(bytes, label);
  if (!isRecord(value)) fail(`${label}-invalid-record`);
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function exactAbsolute(value: unknown, code: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value)) fail(code);
  return value;
}

function portablePath(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || !isAbsolute(value) || /[\0\r\n]/.test(value)) fail(code);
  const result = normalize(value).replace(/[\\/]$/, "") || "/";
  if (!isAbsolute(result) || result.length > 4096) fail(code);
  return result;
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function validatedTransactionId(value: unknown): string {
  if (typeof value !== "string" || !TRANSACTION_ID.test(value)) fail("invalid-transaction-id");
  return value;
}

function fingerprint(value: unknown, code: string): Sha256Fingerprint {
  if (!isFingerprint(value)) fail(code);
  return value;
}

function isFingerprint(value: unknown): value is Sha256Fingerprint {
  return typeof value === "string" && SHA256_FINGERPRINT.test(value);
}

function canonicalNow(value: string): string {
  if (!isCanonicalUtcTimestamp(value)) fail("invalid-clock");
  return value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeText(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(code);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort(compareCodeUnits).join("\0") === [...keys].sort(compareCodeUnits).join("\0");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function artifactName(value: unknown): ArtifactName {
  if (value === "global-state" || value === "projects" || value === "config") return value;
  fail("artifact-name-invalid");
}

function isPortableSettingsPhase(value: unknown): value is PortableSettingsPhase {
  return value === "journal-prepared" || value === "source-sealed" || value === "destination-preimages-preserved"
    || value === "candidate-prepared" || value === "candidate-verified" || value === "publishing"
    || value === "published" || value === "receipt-published" || value === "rolled-back"
    || value === "manual-recovery-required";
}

function cliString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`missing-${name.slice(2)}`);
  return value;
}

function cliPath(value: unknown, name: string): string {
  return exactAbsolute(cliString(value, name), `invalid-${name.slice(2)}`);
}

function readFileDirectory(path: string): string[] {
  // Dynamic import is unnecessary here; this wrapper keeps directory reads in
  // one audited location and rejects non-directory entries at manifest read.
  return readdirSync(path).sort(compareCodeUnits);
}

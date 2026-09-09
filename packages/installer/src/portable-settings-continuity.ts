import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
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
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  canonicalJson,
  canonicalSha256Fingerprint,
  isCanonicalUtcTimestamp,
  observeHistoryAdoptionCensus,
  type HistoryAdoptionCensus,
} from "./account-history-adoption.js";
import {
  CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  PortableContinuityProjectionError,
  assertSupportedPortableDesktopSchema,
  mergePortableEndpointProjections,
  type EndpointKey,
  type NativeThreadInventoryV1,
  type PortableContinuityLedgerV2,
  type PortableEndpointStateV1,
  type PortableProjectionMergeResultV1,
  type Sha256,
} from "./portable-continuity-projection.js";

export const PORTABLE_SETTINGS_CONTINUITY_SCHEMA_VERSION = 2 as const;
export const PORTABLE_SETTINGS_CONTINUITY_DIRECTORY = "portable-continuity" as const;
export const PORTABLE_CONTINUITY_LEDGER_FILE = "continuity-state.v2.json" as const;
export const PORTABLE_CONTINUITY_LOCK_FILE = "handoff.lock" as const;
export const PORTABLE_CONTINUITY_JOURNAL_FILE = "journal.v2.json" as const;
export const PORTABLE_CONTINUITY_INTENT_FILE = "intent.v2.json" as const;
export const PORTABLE_CONTINUITY_RECEIPT_FILE = "receipt.v2.json" as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_RECEIPT_MODE = 0o400;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const TRANSACTION_ID = /^[A-Za-z0-9-]{8,128}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
type ContentPermissions = boolean | "native";
const SAFE_TWEAK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export interface PortableEndpointV1 {
  endpointKey: EndpointKey;
  appBundlePath: string;
  codexHomeRoot: string;
  tweakersRoot: string;
  bundleSchemaFingerprint: Sha256;
}

export interface PortableHandoffInputV2 {
  transactionId: string;
  globalRoot: string;
  source: PortableEndpointV1;
  destination: PortableEndpointV1;
  /**
   * Kept as a private binding reference for the manager hook. The continuity
   * module does not open this path: native-transfer owns its catalog format.
   */
  nativeTransferReceiptPath?: string;
  /** Defaults to globalRoot; native-transfer consumes this as its state root. */
  nativeThreadInventoryStateRoot?: string;
  expectedIntentFingerprint?: Sha256;
  apply: boolean;
  /** Optional manager-created proof after a managed close. */
  precondition?: PortableHandoffPreconditionV1;
}

export interface PortableHandoffRecoveryInputV2 {
  transactionId: string;
  globalRoot: string;
}

export interface PortableWriterCensusV1 {
  observedAt: string;
  state: "zero" | "running" | "unknown";
  openFileCount: number;
  /** Count only; never expose paths or process identities through result values. */
  unexpectedProcessCount: number;
}

export interface PortableAlreadyIdleProofV1 {
  kind: "already-idle";
  first: PortableWriterCensusV1;
  second: PortableWriterCensusV1;
}

export interface PortableExactCloseProofV1 {
  kind: "exact-close";
  /** The manager records an opaque fingerprint of exact main/helper identities. */
  closeEvidenceFingerprint: Sha256;
  observedAt: string;
}

export type PortableHandoffPreconditionV1 = PortableAlreadyIdleProofV1 | PortableExactCloseProofV1;

export interface NativeThreadInventoryReadResultV1 {
  state: "ready" | "unavailable";
  fingerprint?: Sha256;
  threadIds?: readonly string[];
  /** A bounded diagnostic code; native-transfer never includes identity data. */
  reason?: string;
}

export interface PortableContinuityDependencies {
  /**
   * Production binds this to native-transfer's
   * readCommittedNativeThreadInventoryV1({ stateRoot }). It is intentionally
   * an offline reader, never a live Broker callback.
   */
  readNativeThreadInventory?: (input: { stateRoot: string }) => NativeThreadInventoryReadResultV1;
  census?: (input: {
    sourceAppBundlePath: string;
    destinationAppBundlePath: string;
    protectedPaths: readonly string[];
    allowedPids: readonly number[];
  }) => PortableWriterCensusV1;
  /** A manager may bind a physically verified bundle schema before apply. */
  verifyBundleSchema?: (endpoint: PortableEndpointV1) => Sha256;
  wait?: (milliseconds: number) => void;
  now?: () => string;
  beforePhase?: (phase: PortableHandoffPhaseV2) => void;
  isProcessAlive?: (pid: number) => boolean;
  randomId?: () => string;
}

/**
 * Explicit production constructor. The manager supplies the native-transfer
 * reader; this avoids importing another package's source graph into the
 * installer bundle while still requiring a concrete offline provider.
 */
export function createPortableContinuityDependencies(
  dependencies: PortableContinuityDependencies & Required<Pick<PortableContinuityDependencies, "readNativeThreadInventory">>,
): PortableContinuityDependencies {
  return { ...dependencies };
}

export type PortableHandoffPhaseV2 =
  | "journal-prepared"
  | "intent-published"
  | "preimages-preserved"
  | "candidates-prepared"
  | "candidate-verified"
  | "publishing"
  | "artifacts-published"
  | "ledger-published"
  | "receipt-published"
  | "rolled-back"
  | "manual-recovery-required";

export interface PortableHandoffResultV2 {
  schemaVersion: 2;
  kind: "portable-desktop-handoff-result";
  transactionId: string;
  status: "preview" | "applied" | "already-applied" | "rolled-back" | "manual-recovery-required" | "unsupported-schema" | "no-transaction";
  intentFingerprint: Sha256 | null;
  nativeThreadInventoryFingerprint: Sha256 | null;
  priorLedgerGeneration: number | null;
  nextLedgerGeneration: number | null;
  selectedFieldCount: number;
  destinationWriteFieldCount: number;
  conflictFieldIds: readonly string[];
  excludedFieldIds: readonly string[];
  precondition: PortableHandoffPreconditionV1 | null;
  nextAction: "apply-with-intent" | "recover-explicitly" | "none";
}

export interface PortableContinuityPathsV2 {
  root: string;
  ledger: string;
  lock: string;
  transactions: string;
  transactionRoot: string;
  journal: string;
  intent: string;
  receipt: string;
  preimages: string;
}

interface PortableArtifactPlanV2 {
  name: "global-state" | "projects" | "config" | "ledger";
  targetPath: string;
  candidateBytes: Buffer;
  preimageFingerprint: Sha256 | null;
  postimageFingerprint: Sha256;
  changed: boolean;
}

interface PortableHandoffIntentV2 {
  schemaVersion: 2;
  kind: "portable-desktop-handoff-intent";
  transactionId: string;
  sourceEndpointKey: EndpointKey;
  destinationEndpointKey: EndpointKey;
  /** Private recovery bindings; these paths are never returned in status. */
  globalRoot: string;
  destinationCodexHomeRoot: string;
  destinationTweakersRoot: string;
  sourceAppBundlePath: string;
  destinationAppBundlePath: string;
  sourceSchemaFingerprint: Sha256;
  destinationSchemaFingerprint: Sha256;
  sourceProjectionFingerprint: Sha256;
  destinationProjectionFingerprint: Sha256;
  candidateFingerprint: Sha256;
  nativeThreadInventoryFingerprint: Sha256;
  priorLedgerGeneration: number;
  precondition: PortableHandoffPreconditionV1;
  artifacts: readonly Omit<PortableArtifactPlanV2, "candidateBytes">[];
  selectedFieldIds: readonly string[];
  destinationWriteFieldIds: readonly string[];
  conflictFieldIds: readonly string[];
  excludedFieldIds: readonly string[];
  protectedPaths: readonly string[];
}

interface PortableHandoffJournalV2 {
  schemaVersion: 2;
  kind: "portable-desktop-handoff-journal";
  transactionId: string;
  phase: PortableHandoffPhaseV2;
  intent: PortableHandoffIntentV2;
  intentFingerprint: Sha256;
  publishedArtifacts: readonly PortableArtifactPlanV2["name"][];
  preparedAt: string;
  updatedAt: string;
  reason: string | null;
}

interface PortableHandoffReceiptV2 {
  schemaVersion: 2;
  kind: "portable-desktop-handoff-receipt";
  transactionId: string;
  intentFingerprint: Sha256;
  nativeThreadInventoryFingerprint: Sha256;
  candidateFingerprint: Sha256;
  artifacts: readonly Omit<PortableArtifactPlanV2, "candidateBytes">[];
  committedAt: string;
}

interface PortableHandoffPlanV2 {
  merge: PortableProjectionMergeResultV1;
  inventory: NativeThreadInventoryV1;
  precondition: PortableHandoffPreconditionV1;
  intent: PortableHandoffIntentV2;
  intentFingerprint: Sha256;
  artifacts: readonly PortableArtifactPlanV2[];
}

export class PortableSettingsContinuityError extends Error {
  constructor(readonly code: string) {
    super(`Portable desktop handoff stopped safely: ${code}`);
    this.name = "PortableSettingsContinuityError";
  }
}

export function portableContinuityPaths(globalRoot: string, transactionId: string): PortableContinuityPathsV2 {
  const root = exactAbsolute(globalRoot, "global-root-invalid");
  const id = validatedTransactionId(transactionId);
  const continuity = join(root, PORTABLE_SETTINGS_CONTINUITY_DIRECTORY);
  const transactionRoot = join(continuity, "transactions", id);
  return {
    root: continuity,
    ledger: join(continuity, PORTABLE_CONTINUITY_LEDGER_FILE),
    lock: join(continuity, PORTABLE_CONTINUITY_LOCK_FILE),
    transactions: join(continuity, "transactions"),
    transactionRoot,
    journal: join(transactionRoot, PORTABLE_CONTINUITY_JOURNAL_FILE),
    intent: join(transactionRoot, PORTABLE_CONTINUITY_INTENT_FILE),
    receipt: join(transactionRoot, PORTABLE_CONTINUITY_RECEIPT_FILE),
    preimages: join(transactionRoot, "preimages"),
  };
}

export function previewPortableHandoff(
  input: Omit<PortableHandoffInputV2, "apply" | "expectedIntentFingerprint">,
  dependencies: PortableContinuityDependencies = {},
): PortableHandoffResultV2 {
  const normalized = normalizeInput({ ...input, apply: false });
  try {
    const plan = createPlan(normalized, dependencies);
    return resultFromPlan(plan, "preview");
  } catch (error) {
    if (isUnsupportedSchema(error)) return unsupportedResult(normalized.transactionId);
    throw error;
  }
}

export function applyPortableHandoff(
  input: PortableHandoffInputV2 & { apply: true; expectedIntentFingerprint: Sha256 },
  dependencies: PortableContinuityDependencies = {},
): PortableHandoffResultV2 {
  const normalized = normalizeInput(input);
  // A preview proof is part of the fingerprint.  Recomputing it here would
  // produce a different intent and would make an otherwise valid preview
  // impossible to apply.  We still take a fresh census immediately before
  // publication below.
  if (normalized.precondition === undefined) fail("apply-precondition-required");
  const paths = portableContinuityPaths(normalized.globalRoot, normalized.transactionId);
  try {
    if (existsNoFollow(paths.receipt)) return inspectApplied(paths);
    if (existsNoFollow(paths.journal)) fail("incomplete-transaction-requires-recovery");
    const preview = createPlan(normalized, dependencies);
    if (preview.intentFingerprint !== normalized.expectedIntentFingerprint) fail("preview-intent-mismatch");
    ensurePrivateContinuityRoots(paths, normalized.globalRoot);
    const lock = acquireLock(paths.lock, normalized.transactionId, dependencies.isProcessAlive);
    let release = true;
    try {
      if (existsNoFollow(paths.journal) || existsNoFollow(paths.receipt)) fail("transaction-raced");
      const finalPlan = createPlan(normalized, dependencies, { allowExistingJournal: true });
      if (finalPlan.intentFingerprint !== preview.intentFingerprint) fail("preimage-drift-before-journal");
      const now = dependencies.now ?? (() => new Date().toISOString());
      createPrivateDirectory(paths.transactionRoot, "transaction-root");
      let journal: PortableHandoffJournalV2 = {
        schemaVersion: 2,
        kind: "portable-desktop-handoff-journal",
        transactionId: normalized.transactionId,
        phase: "journal-prepared",
        intent: finalPlan.intent,
        intentFingerprint: finalPlan.intentFingerprint,
        publishedArtifacts: [],
        preparedAt: canonicalNow(now()),
        updatedAt: canonicalNow(now()),
        reason: null,
      };
      writePrivateJsonNew(paths.intent, finalPlan.intent, PRIVATE_FILE_MODE, "intent");
      writePrivateJsonNew(paths.journal, journal, PRIVATE_FILE_MODE, "journal");
      boundary(dependencies, "journal-prepared");
      journal = updateJournal(paths, journal, "intent-published", now);
      boundary(dependencies, "intent-published");

      createPrivateDirectory(paths.preimages, "preimages");
      for (const artifact of finalPlan.artifacts) {
        if (!artifact.changed || artifact.preimageFingerprint === null) continue;
        const current = readBoundFile(artifact.targetPath, MAX_JSON_BYTES, "destination-preimage", false);
        assertFingerprint(current, artifact.preimageFingerprint, "destination-preimage-drift");
        writePrivateBytesNew(join(paths.preimages, artifact.name), current, PRIVATE_FILE_MODE, "preimage");
      }
      journal = updateJournal(paths, journal, "preimages-preserved", now);
      boundary(dependencies, "preimages-preserved");

      const candidates = new Map<PortableArtifactPlanV2["name"], string>();
      for (const artifact of finalPlan.artifacts) {
        if (!artifact.changed) continue;
        const temporary = writeLocalCandidate(artifact.targetPath, artifact.candidateBytes, normalized.transactionId, artifact.name);
        candidates.set(artifact.name, temporary);
      }
      journal = updateJournal(paths, journal, "candidates-prepared", now);
      boundary(dependencies, "candidates-prepared");
      for (const artifact of finalPlan.artifacts) {
        if (!artifact.changed) continue;
        const candidate = candidates.get(artifact.name);
        if (candidate === undefined) fail("candidate-missing");
        assertFingerprint(readBoundFile(candidate, MAX_JSON_BYTES, "candidate", true), artifact.postimageFingerprint, "candidate-invalid");
      }
      journal = updateJournal(paths, journal, "candidate-verified", now);
      boundary(dependencies, "candidate-verified");

      // Re-observe the same quiet interval and reconstruct every preimage
      // before the first rename. A manual idle source is accepted here only
      // when this evidence is current; it never invents a process-close event.
      const publishPlan = createPlan(normalized, dependencies, { allowExistingJournal: true });
      if (publishPlan.intentFingerprint !== finalPlan.intentFingerprint) fail("preimage-drift-before-publication");
      observeAlreadyIdle(normalized, dependencies);
      journal = updateJournal(paths, journal, "publishing", now);
      boundary(dependencies, "publishing");
      const published: PortableArtifactPlanV2["name"][] = [];
      for (const artifact of finalPlan.artifacts) {
        if (!artifact.changed) continue;
        assertCurrentArtifact(artifact);
        const candidate = candidates.get(artifact.name);
        if (candidate === undefined) fail("candidate-missing");
        renameSync(candidate, artifact.targetPath);
        fsyncDirectory(dirname(artifact.targetPath));
        assertFingerprint(readBoundFile(artifact.targetPath, MAX_JSON_BYTES, "published-artifact", false), artifact.postimageFingerprint, "published-artifact-invalid");
        published.push(artifact.name);
        journal = updateJournal(paths, { ...journal, publishedArtifacts: [...published] }, "publishing", now);
        boundary(dependencies, "publishing");
      }
      journal = updateJournal(paths, journal, "artifacts-published", now);
      boundary(dependencies, "artifacts-published");
      journal = updateJournal(paths, journal, "ledger-published", now);
      boundary(dependencies, "ledger-published");
      const receipt: PortableHandoffReceiptV2 = {
        schemaVersion: 2,
        kind: "portable-desktop-handoff-receipt",
        transactionId: normalized.transactionId,
        intentFingerprint: finalPlan.intentFingerprint,
        nativeThreadInventoryFingerprint: finalPlan.inventory.fingerprint,
        candidateFingerprint: finalPlan.merge.candidateFingerprint,
        artifacts: finalPlan.artifacts.map(withoutBytes),
        committedAt: canonicalNow(now()),
      };
      writePrivateJsonNew(paths.receipt, receipt, PRIVATE_RECEIPT_MODE, "receipt");
      journal = updateJournal(paths, journal, "receipt-published", now);
      boundary(dependencies, "receipt-published");
      releaseLock(paths.lock, lock);
      release = false;
      return resultFromPlan(finalPlan, finalPlan.artifacts.some((entry) => entry.changed) ? "applied" : "already-applied");
    } finally {
      // A caught failure leaves its journal for explicit recovery, but it must
      // not leave a live process's lock behind. A process crash never reaches
      // this finally block and is handled by stale-lock recovery instead.
      if (release) releaseLock(paths.lock, lock);
    }
  } catch (error) {
    if (isUnsupportedSchema(error)) return unsupportedResult(normalized.transactionId);
    throw error;
  }
}

export function recoverPortableHandoff(
  input: PortableHandoffRecoveryInputV2,
  dependencies: PortableContinuityDependencies = {},
): PortableHandoffResultV2 {
  const transactionId = validatedTransactionId(input.transactionId);
  const globalRoot = exactAbsolute(input.globalRoot, "global-root-invalid");
  const paths = portableContinuityPaths(globalRoot, transactionId);
  if (!existsNoFollow(paths.journal)) return noTransactionResult(transactionId);
  const journal = readJournal(paths.journal, globalRoot);
  if (existsNoFollow(paths.receipt) && journal.phase === "receipt-published") return inspectApplied(paths);
  ensurePrivateContinuityRoots(paths, globalRoot);
  const lock = acquireLock(paths.lock, transactionId, dependencies.isProcessAlive);
  let release = true;
  try {
    const current = readJournal(paths.journal, globalRoot);
    if (existsNoFollow(paths.receipt) && current.phase === "receipt-published") return inspectApplied(paths);
    observeJournalIdle(current.intent, dependencies);
    const artifacts = current.intent.artifacts;
    for (const artifact of [...artifacts].reverse()) {
      if (!current.publishedArtifacts.includes(artifact.name) || !artifact.changed) continue;
      const currentFingerprint = fingerprintOptionalFile(artifact.targetPath, "recovery-target");
      if (currentFingerprint === artifact.preimageFingerprint) continue;
      if (currentFingerprint !== artifact.postimageFingerprint) {
        const manual = updateJournal(paths, { ...current, reason: "artifact-drift" }, "manual-recovery-required", dependencies.now ?? (() => new Date().toISOString()));
        void manual;
        return manualRecoveryResult(current);
      }
      if (artifact.preimageFingerprint === null) {
        unlinkExactPostimage(artifact.targetPath, artifact.postimageFingerprint);
      } else {
        const preimage = join(paths.preimages, artifact.name);
        const bytes = readBoundFile(preimage, MAX_JSON_BYTES, "recovery-preimage", true);
        assertFingerprint(bytes, artifact.preimageFingerprint, "recovery-preimage-invalid");
        const temporary = writeLocalCandidate(artifact.targetPath, bytes, transactionId, `restore-${artifact.name}`);
        renameSync(temporary, artifact.targetPath);
        fsyncDirectory(dirname(artifact.targetPath));
      }
    }
    updateJournal(paths, current, "rolled-back", dependencies.now ?? (() => new Date().toISOString()));
    releaseLock(paths.lock, lock);
    release = false;
    return rolledBackResult(current);
  } finally {
    if (release) releaseLock(paths.lock, lock);
  }
}

export function inspectPortableHandoff(
  input: PortableHandoffRecoveryInputV2,
): PortableHandoffResultV2 {
  const paths = portableContinuityPaths(input.globalRoot, input.transactionId);
  if (!existsNoFollow(paths.journal)) return noTransactionResult(paths.transactionRoot.split("/").at(-1) ?? input.transactionId);
  const journal = readJournal(paths.journal, input.globalRoot);
  if (!existsNoFollow(paths.receipt)) return manualRecoveryResult(journal);
  let receipt: PortableHandoffReceiptV2;
  try { receipt = parseReceipt(readPrivateJson(paths.receipt, MAX_JSON_BYTES, "receipt", true)); } catch { return manualRecoveryResult(journal); }
  if (receipt.intentFingerprint !== journal.intentFingerprint || receipt.transactionId !== journal.transactionId || journal.phase !== "receipt-published") {
    return manualRecoveryResult(journal);
  }
  try {
    for (const artifact of receipt.artifacts) {
      if (!artifact.changed) continue;
      if (fingerprintOptionalFile(artifact.targetPath, "receipt-target") !== artifact.postimageFingerprint) return manualRecoveryResult(journal);
    }
  } catch { return manualRecoveryResult(journal); }
  return resultFromJournal(journal, receipt.artifacts.some((entry) => entry.changed) ? "applied" : "already-applied");
}

function createPlan(
  input: ReturnType<typeof normalizeInput>,
  dependencies: PortableContinuityDependencies,
  options: { allowExistingJournal?: boolean } = {},
): PortableHandoffPlanV2 {
  assertInputRoots(input);
  verifyBundleSchemas(input, dependencies);
  const paths = portableContinuityPaths(input.globalRoot, input.transactionId);
  if (!options.allowExistingJournal && existsNoFollow(paths.journal)) fail("incomplete-transaction-requires-recovery");
  // A busy endpoint cannot participate in a merge. Validate roots, bundle
  // provenance and recovery state first, then defer before reading its mutable
  // preference files or traversing installed capability directories.
  const precondition = input.precondition ?? observeAlreadyIdle(input, dependencies);
  validatePrecondition(precondition);
  const inventory = readNativeThreadInventory(input, dependencies);
  const knownTweakIds = discoverKnownTweakIds(input.destination.tweakersRoot);
  const sourceArtifacts = readEndpointArtifacts(input.source);
  const destinationArtifacts = readEndpointArtifacts(input.destination);
  const ledger = existsNoFollow(paths.ledger) ? readLedger(paths.ledger) : null;
  const merge = mergePortableEndpointProjections({
    source: sourceArtifacts.state,
    destination: destinationArtifacts.state,
    options: { nativeThreadInventory: inventory, knownTweakIds },
    ledger,
    observedAt: preconditionObservedAt(precondition),
  });
  const artifacts = planArtifacts(input, paths, merge, destinationArtifacts);
  const protectedPaths = unique([
    input.globalRoot,
    input.source.codexHomeRoot,
    input.source.tweakersRoot,
    input.destination.codexHomeRoot,
    input.destination.tweakersRoot,
    ...artifacts.map((entry) => dirname(entry.targetPath)),
  ]).sort(compareCodeUnits);
  const intent: PortableHandoffIntentV2 = {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-intent",
    transactionId: input.transactionId,
    sourceEndpointKey: input.source.endpointKey,
    destinationEndpointKey: input.destination.endpointKey,
    globalRoot: input.globalRoot,
    destinationCodexHomeRoot: input.destination.codexHomeRoot,
    destinationTweakersRoot: input.destination.tweakersRoot,
    sourceAppBundlePath: input.source.appBundlePath,
    destinationAppBundlePath: input.destination.appBundlePath,
    sourceSchemaFingerprint: input.source.bundleSchemaFingerprint,
    destinationSchemaFingerprint: input.destination.bundleSchemaFingerprint,
    sourceProjectionFingerprint: merge.source.fingerprint,
    destinationProjectionFingerprint: merge.destination.fingerprint,
    candidateFingerprint: merge.candidateFingerprint,
    nativeThreadInventoryFingerprint: inventory.fingerprint,
    priorLedgerGeneration: ledger?.generation ?? 0,
    precondition,
    artifacts: artifacts.map(withoutBytes),
    selectedFieldIds: merge.selectedFields.map((entry) => entry.fieldId),
    destinationWriteFieldIds: merge.selectedFields.filter((entry) => entry.writesDestination).map((entry) => entry.fieldId),
    conflictFieldIds: merge.conflicts.map((entry) => entry.fieldId),
    excludedFieldIds: unique([...merge.source.excludedFieldIds, ...merge.destination.excludedFieldIds]).sort(compareCodeUnits),
    protectedPaths,
  };
  return { merge, inventory, precondition, intent, intentFingerprint: canonicalSha256Fingerprint(intent), artifacts };
}

function planArtifacts(
  input: ReturnType<typeof normalizeInput>,
  paths: PortableContinuityPathsV2,
  merge: PortableProjectionMergeResultV1,
  destination: EndpointArtifacts,
): PortableArtifactPlanV2[] {
  const targets: Array<{
    name: PortableArtifactPlanV2["name"];
    path: string;
    current: JsonArtifact;
    candidate: unknown;
  }> = [
    { name: "global-state", path: globalStatePath(input.destination), current: destination.globalState, candidate: merge.candidate.globalState },
    { name: "projects", path: projectsPath(input.destination), current: destination.projects, candidate: merge.candidate.projects },
    { name: "config", path: configPath(input.destination), current: destination.config, candidate: merge.candidate.config },
    { name: "ledger", path: paths.ledger, current: readOptionalJson(paths.ledger, "ledger", true), candidate: merge.nextLedger },
  ];
  const result: PortableArtifactPlanV2[] = [];
  for (const entry of targets) {
    if (entry.candidate === null) {
      if (entry.current.value !== null) fail("candidate-artifact-absent");
      continue;
    }
    const bytes = jsonBytes(entry.candidate);
    const changed = entry.current.value === null || canonicalJson(entry.current.value) !== canonicalJson(entry.candidate);
    result.push({
      name: entry.name,
      targetPath: entry.path,
      candidateBytes: bytes,
      preimageFingerprint: entry.current.bytes === null ? null : fingerprintBytes(entry.current.bytes),
      postimageFingerprint: fingerprintBytes(bytes),
      changed,
    });
  }
  return result;
}

interface JsonArtifact { value: unknown | null; bytes: Buffer | null; }
interface EndpointArtifacts { state: PortableEndpointStateV1; globalState: JsonArtifact; projects: JsonArtifact; config: JsonArtifact; }

function readEndpointArtifacts(endpoint: PortableEndpointV1): EndpointArtifacts {
  const globalState = readOptionalJson(globalStatePath(endpoint), "global-state", "native");
  const projects = readOptionalJson(projectsPath(endpoint), "projects", true);
  const config = readOptionalJson(configPath(endpoint), "config", true);
  return {
    state: {
      endpointKey: endpoint.endpointKey,
      bundleSchemaFingerprint: endpoint.bundleSchemaFingerprint,
      globalState: globalState.value ?? {},
      projects: projects.value,
      config: config.value,
    },
    globalState,
    projects,
    config,
  };
}

function readNativeThreadInventory(input: ReturnType<typeof normalizeInput>, dependencies: PortableContinuityDependencies): NativeThreadInventoryV1 {
  const reader = dependencies.readNativeThreadInventory;
  if (reader === undefined) fail("native-thread-inventory-provider-required");
  const result = reader({ stateRoot: input.nativeThreadInventoryStateRoot });
  if (!isRecord(result) || result.state !== "ready" || !isSha256(result.fingerprint) || !Array.isArray(result.threadIds)) {
    fail("native-thread-inventory-unavailable");
  }
  return { version: 1, fingerprint: result.fingerprint, threadIds: result.threadIds };
}

function verifyBundleSchemas(input: ReturnType<typeof normalizeInput>, dependencies: PortableContinuityDependencies): void {
  for (const endpoint of [input.source, input.destination]) {
    assertSupportedPortableDesktopSchema(endpoint.bundleSchemaFingerprint);
    const observed = dependencies.verifyBundleSchema?.(endpoint) ?? endpoint.bundleSchemaFingerprint;
    if (observed !== endpoint.bundleSchemaFingerprint || observed !== CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1) {
      fail("unsupported-schema");
    }
  }
}

function observeAlreadyIdle(input: ReturnType<typeof normalizeInput>, dependencies: PortableContinuityDependencies): PortableAlreadyIdleProofV1 {
  const protectedPaths = unique([
    input.globalRoot,
    input.source.codexHomeRoot,
    input.source.tweakersRoot,
    input.destination.codexHomeRoot,
    input.destination.tweakersRoot,
  ]).sort(compareCodeUnits);
  const observe = dependencies.census ?? defaultCensus;
  const call = () => observe({
    sourceAppBundlePath: input.source.appBundlePath,
    destinationAppBundlePath: input.destination.appBundlePath,
    protectedPaths,
    allowedPids: [],
  });
  const first = parseCensus(call());
  if (first.state !== "zero" || first.openFileCount !== 0 || first.unexpectedProcessCount !== 0) fail("writers-not-zero");
  (dependencies.wait ?? defaultWait)(1_000);
  const second = parseCensus(call());
  if (second.state !== "zero" || second.openFileCount !== 0 || second.unexpectedProcessCount !== 0) fail("writers-not-zero");
  return { kind: "already-idle", first, second };
}

/** Recovery has no live endpoint object, so it uses the sealed private intent. */
function observeJournalIdle(intent: PortableHandoffIntentV2, dependencies: PortableContinuityDependencies): PortableAlreadyIdleProofV1 {
  const observe = dependencies.census ?? defaultCensus;
  const call = () => observe({
    sourceAppBundlePath: intent.sourceAppBundlePath,
    destinationAppBundlePath: intent.destinationAppBundlePath,
    protectedPaths: intent.protectedPaths,
    allowedPids: [],
  });
  const first = parseCensus(call());
  if (first.state !== "zero" || first.openFileCount !== 0 || first.unexpectedProcessCount !== 0) fail("writers-not-zero");
  (dependencies.wait ?? defaultWait)(1_000);
  const second = parseCensus(call());
  if (second.state !== "zero" || second.openFileCount !== 0 || second.unexpectedProcessCount !== 0) fail("writers-not-zero");
  return { kind: "already-idle", first, second };
}

function defaultCensus(input: {
  sourceAppBundlePath: string;
  destinationAppBundlePath: string;
  protectedPaths: readonly string[];
}): PortableWriterCensusV1 {
  const observations = [input.sourceAppBundlePath, input.destinationAppBundlePath].map((appPath) => (
    observeHistoryAdoptionCensus({ appPath, protectedPaths: input.protectedPaths })
  ));
  const states = observations.map(censusState);
  const state = states.includes("unknown") ? "unknown" : states.includes("running") ? "running" : "zero";
  const openFileCount = observations.reduce((total, entry) => total + Math.max(0, entry.openFileCount), 0);
  return { observedAt: new Date().toISOString(), state, openFileCount, unexpectedProcessCount: 0 };
}

function censusState(value: HistoryAdoptionCensus): PortableWriterCensusV1["state"] {
  const all = [value.app, value.main, value.appServer];
  if (all.includes("unknown")) return "unknown";
  return all.every((entry) => entry === "idle") ? "zero" : "running";
}

function validatePrecondition(value: PortableHandoffPreconditionV1): void {
  if (!isRecord(value)) fail("handoff-precondition-invalid");
  if (value.kind === "already-idle") {
    const first = parseCensus(value.first);
    const second = parseCensus(value.second);
    if (first.state !== "zero" || second.state !== "zero" || first.openFileCount !== 0 || second.openFileCount !== 0
      || first.unexpectedProcessCount !== 0 || second.unexpectedProcessCount !== 0) fail("handoff-precondition-invalid");
    return;
  }
  if (value.kind === "exact-close" && isSha256(value.closeEvidenceFingerprint) && isCanonicalUtcTimestamp(value.observedAt)) return;
  fail("handoff-precondition-invalid");
}

function preconditionObservedAt(value: PortableHandoffPreconditionV1): string {
  validatePrecondition(value);
  return value.kind === "already-idle" ? value.second.observedAt : value.observedAt;
}

function discoverKnownTweakIds(tweakersRoot: string): string[] {
  const root = join(tweakersRoot, "tweaks");
  if (!existsNoFollow(root)) return [];
  assertDirectory(root, "tweaks-root", "native");
  const names = readDirectoryNames(root);
  if (names.length > MAX_MANIFEST_BYTES / 8) fail("tweaks-capacity-exceeded");
  const ids: string[] = [];
  for (const name of names) {
    if (!SAFE_TWEAK_ID.test(name)) continue;
    const directory = join(root, name);
    const stat = lstatSafe(directory, "tweak-directory");
    if (stat.isSymbolicLink()) fail("tweak-directory-unsafe");
    if (!stat.isDirectory()) continue;
    assertDirectory(directory, "tweak-directory", "native");
    const manifest = join(directory, "manifest.json");
    if (!existsNoFollow(manifest)) continue;
    const parsed = readPrivateJson(manifest, MAX_MANIFEST_BYTES, "tweak-manifest", false);
    if (!isRecord(parsed) || parsed.id !== name) fail("tweak-manifest-invalid");
    ids.push(name);
  }
  return [...new Set(ids)].sort(compareCodeUnits);
}

function ensurePrivateContinuityRoots(paths: PortableContinuityPathsV2, globalRoot: string): void {
  assertDirectory(globalRoot, "global-root", true);
  ensurePrivateChild(globalRoot, paths.root, "continuity-root");
  ensurePrivateChild(paths.root, paths.transactions, "continuity-transactions");
}

function ensurePrivateChild(parent: string, path: string, label: string): void {
  assertDirectory(parent, `${label}-parent`, true);
  if (!existsNoFollow(path)) mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertDirectory(path, label, true);
}

function createPrivateDirectory(path: string, label: string): void {
  if (existsNoFollow(path)) fail(`${label}-exists`);
  mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertDirectory(path, label, true);
  fsyncDirectory(dirname(path));
}

function updateJournal(
  paths: PortableContinuityPathsV2,
  journal: PortableHandoffJournalV2,
  phase: PortableHandoffPhaseV2,
  now: () => string,
): PortableHandoffJournalV2 {
  const next: PortableHandoffJournalV2 = { ...journal, phase, updatedAt: canonicalNow(now()) };
  writePrivateJsonAtomic(paths.journal, next, PRIVATE_FILE_MODE, "journal");
  return next;
}

function boundary(dependencies: PortableContinuityDependencies, phase: PortableHandoffPhaseV2): void {
  dependencies.beforePhase?.(phase);
}

function readLedger(path: string): PortableContinuityLedgerV2 {
  const parsed = readPrivateJson(path, MAX_JSON_BYTES, "continuity-ledger", true);
  if (!isRecord(parsed)) fail("continuity-ledger-invalid");
  return parsed as unknown as PortableContinuityLedgerV2;
}

function readJournal(path: string, expectedGlobalRoot?: string): PortableHandoffJournalV2 {
  const raw = readPrivateJson(path, MAX_JSON_BYTES, "handoff-journal", true);
  if (!isRecord(raw) || raw.schemaVersion !== 2 || raw.kind !== "portable-desktop-handoff-journal"
    || typeof raw.transactionId !== "string" || !TRANSACTION_ID.test(raw.transactionId)
    || typeof raw.phase !== "string" || !isRecord(raw.intent) || !isSha256(raw.intentFingerprint)
    || !Array.isArray(raw.publishedArtifacts) || !isCanonicalUtcTimestamp(raw.preparedAt)
    || !isCanonicalUtcTimestamp(raw.updatedAt) || (raw.reason !== null && typeof raw.reason !== "string")) fail("handoff-journal-invalid");
  const intent = parseIntent(raw.intent);
  if (expectedGlobalRoot !== undefined && intent.globalRoot !== exactAbsolute(expectedGlobalRoot, "handoff-journal-invalid")) {
    fail("handoff-journal-invalid");
  }
  if (canonicalSha256Fingerprint(intent) !== raw.intentFingerprint || intent.transactionId !== raw.transactionId) fail("handoff-journal-invalid");
  const publishedArtifacts = raw.publishedArtifacts.map((entry) => artifactName(entry));
  if (new Set(publishedArtifacts).size !== publishedArtifacts.length) fail("handoff-journal-invalid");
  return {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-journal",
    transactionId: raw.transactionId,
    phase: handoffPhase(raw.phase),
    intent,
    intentFingerprint: raw.intentFingerprint,
    publishedArtifacts,
    preparedAt: raw.preparedAt,
    updatedAt: raw.updatedAt,
    reason: raw.reason,
  };
}

function parseIntent(value: unknown): PortableHandoffIntentV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.kind !== "portable-desktop-handoff-intent"
    || typeof value.transactionId !== "string" || !TRANSACTION_ID.test(value.transactionId)
    || !isSha256(value.sourceEndpointKey) || !isSha256(value.destinationEndpointKey)
    || typeof value.globalRoot !== "string" || typeof value.destinationCodexHomeRoot !== "string"
    || typeof value.destinationTweakersRoot !== "string" || typeof value.sourceAppBundlePath !== "string"
    || typeof value.destinationAppBundlePath !== "string"
    || !isSha256(value.sourceSchemaFingerprint) || !isSha256(value.destinationSchemaFingerprint)
    || !isSha256(value.sourceProjectionFingerprint) || !isSha256(value.destinationProjectionFingerprint)
    || !isSha256(value.candidateFingerprint) || !isSha256(value.nativeThreadInventoryFingerprint)
    || !Number.isSafeInteger(value.priorLedgerGeneration) || typeof value.priorLedgerGeneration !== "number" || value.priorLedgerGeneration < 0
    || !Array.isArray(value.artifacts) || !Array.isArray(value.selectedFieldIds) || !Array.isArray(value.destinationWriteFieldIds)
    || !Array.isArray(value.conflictFieldIds) || !Array.isArray(value.excludedFieldIds) || !Array.isArray(value.protectedPaths)) fail("handoff-intent-invalid");
  validatePrecondition(value.precondition as PortableHandoffPreconditionV1);
  const artifacts = value.artifacts.map(parseArtifact);
  if (new Set(artifacts.map((entry) => entry.name)).size !== artifacts.length) fail("handoff-intent-invalid");
  const strings = (entries: unknown, code: string) => {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry.length > 256)) fail(code);
    return [...entries] as string[];
  };
  const priorLedgerGeneration = value.priorLedgerGeneration;
  if (typeof priorLedgerGeneration !== "number") fail("handoff-intent-invalid");
  const globalRoot = exactAbsolute(value.globalRoot, "handoff-intent-invalid");
  const destinationCodexHomeRoot = exactAbsolute(value.destinationCodexHomeRoot, "handoff-intent-invalid");
  const destinationTweakersRoot = exactAbsolute(value.destinationTweakersRoot, "handoff-intent-invalid");
  const sourceAppBundlePath = exactAbsolute(value.sourceAppBundlePath, "handoff-intent-invalid");
  const destinationAppBundlePath = exactAbsolute(value.destinationAppBundlePath, "handoff-intent-invalid");
  const protectedPaths = strings(value.protectedPaths, "handoff-intent-invalid").map((path) => exactAbsolute(path, "handoff-intent-invalid"));
  const result: PortableHandoffIntentV2 = {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-intent",
    transactionId: value.transactionId,
    sourceEndpointKey: value.sourceEndpointKey,
    destinationEndpointKey: value.destinationEndpointKey,
    globalRoot,
    destinationCodexHomeRoot,
    destinationTweakersRoot,
    sourceAppBundlePath,
    destinationAppBundlePath,
    sourceSchemaFingerprint: value.sourceSchemaFingerprint,
    destinationSchemaFingerprint: value.destinationSchemaFingerprint,
    sourceProjectionFingerprint: value.sourceProjectionFingerprint,
    destinationProjectionFingerprint: value.destinationProjectionFingerprint,
    candidateFingerprint: value.candidateFingerprint,
    nativeThreadInventoryFingerprint: value.nativeThreadInventoryFingerprint,
    priorLedgerGeneration,
    precondition: value.precondition as PortableHandoffPreconditionV1,
    artifacts,
    selectedFieldIds: strings(value.selectedFieldIds, "handoff-intent-invalid"),
    destinationWriteFieldIds: strings(value.destinationWriteFieldIds, "handoff-intent-invalid"),
    conflictFieldIds: strings(value.conflictFieldIds, "handoff-intent-invalid"),
    excludedFieldIds: strings(value.excludedFieldIds, "handoff-intent-invalid"),
    protectedPaths,
  };
  assertIntentArtifactTargets(result);
  return result;
}

function assertIntentArtifactTargets(intent: PortableHandoffIntentV2): void {
  const expected: Record<PortableArtifactPlanV2["name"], string> = {
    "global-state": join(intent.destinationCodexHomeRoot, ".codex-global-state.json"),
    projects: join(intent.destinationTweakersRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json"),
    config: join(intent.destinationTweakersRoot, "config.json"),
    ledger: join(intent.globalRoot, PORTABLE_SETTINGS_CONTINUITY_DIRECTORY, PORTABLE_CONTINUITY_LEDGER_FILE),
  };
  for (const artifact of intent.artifacts) {
    if (artifact.targetPath !== expected[artifact.name]) fail("handoff-artifact-target-invalid");
  }
  if (!intent.artifacts.some((artifact) => artifact.name === "global-state")
    || !intent.artifacts.some((artifact) => artifact.name === "ledger")) fail("handoff-artifact-target-invalid");
}

function parseArtifact(value: unknown): Omit<PortableArtifactPlanV2, "candidateBytes"> {
  if (!isRecord(value) || !artifactNameSafe(value.name) || typeof value.targetPath !== "string"
    || !isSha256(value.postimageFingerprint) || (value.preimageFingerprint !== null && !isSha256(value.preimageFingerprint))
    || typeof value.changed !== "boolean") fail("handoff-artifact-invalid");
  return {
    name: value.name,
    targetPath: exactAbsolute(value.targetPath, "handoff-artifact-invalid"),
    preimageFingerprint: value.preimageFingerprint,
    postimageFingerprint: value.postimageFingerprint,
    changed: value.changed,
  };
}

function parseReceipt(value: unknown): PortableHandoffReceiptV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.kind !== "portable-desktop-handoff-receipt"
    || typeof value.transactionId !== "string" || !TRANSACTION_ID.test(value.transactionId)
    || !isSha256(value.intentFingerprint) || !isSha256(value.nativeThreadInventoryFingerprint)
    || !isSha256(value.candidateFingerprint) || !Array.isArray(value.artifacts) || !isCanonicalUtcTimestamp(value.committedAt)) {
    fail("handoff-receipt-invalid");
  }
  return {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-receipt",
    transactionId: value.transactionId,
    intentFingerprint: value.intentFingerprint,
    nativeThreadInventoryFingerprint: value.nativeThreadInventoryFingerprint,
    candidateFingerprint: value.candidateFingerprint,
    artifacts: value.artifacts.map(parseArtifact),
    committedAt: value.committedAt,
  };
}

function inspectApplied(paths: PortableContinuityPathsV2): PortableHandoffResultV2 {
  return inspectPortableHandoff({ globalRoot: dirname(paths.root), transactionId: paths.transactionRoot.split("/").at(-1)! });
}

function assertCurrentArtifact(artifact: PortableArtifactPlanV2): void {
  if (fingerprintOptionalFile(artifact.targetPath, "publication-target") !== artifact.preimageFingerprint) fail("destination-drift-before-publication");
}

function writeLocalCandidate(targetPath: string, bytes: Buffer, transactionId: string, label: string): string {
  const parent = dirname(targetPath);
  assertDirectory(parent, "candidate-parent", basename(targetPath) === ".codex-global-state.json" ? "native" : true);
  const temporary = join(parent, `.${basename(targetPath)}.portable-${transactionId}-${label}-${randomUUID()}.tmp`);
  writePrivateBytesNew(temporary, bytes, PRIVATE_FILE_MODE, "candidate");
  return temporary;
}

function unlinkExactPostimage(path: string, expected: Sha256): void {
  const bytes = readBoundFile(path, MAX_JSON_BYTES, "recovery-delete-target", false);
  assertFingerprint(bytes, expected, "recovery-delete-target-drift");
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function normalizeInput(input: PortableHandoffInputV2): PortableHandoffInputV2 & {
  transactionId: string;
  globalRoot: string;
  source: PortableEndpointV1;
  destination: PortableEndpointV1;
  nativeThreadInventoryStateRoot: string;
} {
  if (!isRecord(input) || input.apply !== true && input.apply !== false) fail("input-invalid");
  const result = {
    ...input,
    transactionId: validatedTransactionId(input.transactionId),
    globalRoot: exactAbsolute(input.globalRoot, "global-root-invalid"),
    source: normalizeEndpoint(input.source, "source"),
    destination: normalizeEndpoint(input.destination, "destination"),
    nativeThreadInventoryStateRoot: exactAbsolute(input.nativeThreadInventoryStateRoot ?? input.globalRoot, "inventory-state-root-invalid"),
  };
  if (result.source.endpointKey === result.destination.endpointKey
    || result.source.codexHomeRoot === result.destination.codexHomeRoot
    || result.source.tweakersRoot === result.destination.tweakersRoot) fail("endpoints-not-isolated");
  if (result.expectedIntentFingerprint !== undefined && !isSha256(result.expectedIntentFingerprint)) fail("intent-fingerprint-invalid");
  if (result.nativeTransferReceiptPath !== undefined) exactAbsolute(result.nativeTransferReceiptPath, "native-proof-reference-invalid");
  if (result.precondition !== undefined) validatePrecondition(result.precondition);
  return result;
}

function normalizeEndpoint(value: unknown, label: string): PortableEndpointV1 {
  if (!isRecord(value) || !isSha256(value.endpointKey) || !isSha256(value.bundleSchemaFingerprint)) fail(`${label}-endpoint-invalid`);
  return {
    endpointKey: value.endpointKey,
    appBundlePath: exactAbsolute(value.appBundlePath, `${label}-app-invalid`),
    codexHomeRoot: exactAbsolute(value.codexHomeRoot, `${label}-codex-root-invalid`),
    tweakersRoot: exactAbsolute(value.tweakersRoot, `${label}-tweakers-root-invalid`),
    bundleSchemaFingerprint: value.bundleSchemaFingerprint,
  };
}

function assertInputRoots(input: ReturnType<typeof normalizeInput>): void {
  assertDirectory(input.globalRoot, "global-root", true);
  assertDirectory(input.nativeThreadInventoryStateRoot, "inventory-state-root", true);
  assertDirectory(input.source.codexHomeRoot, "source-codex-root", "native");
  assertDirectory(input.source.tweakersRoot, "source-tweakers-root", true);
  assertDirectory(input.destination.codexHomeRoot, "destination-codex-root", "native");
  assertDirectory(input.destination.tweakersRoot, "destination-tweakers-root", true);
  assertDirectory(input.source.appBundlePath, "source-app", false);
  assertDirectory(input.destination.appBundlePath, "destination-app", false);
  // Installation containers may nest (the variant lives under Tweakers), but
  // the exact mutable documents and the independent journal root may not.
  const containers = [input.source.codexHomeRoot, input.source.tweakersRoot, input.destination.codexHomeRoot, input.destination.tweakersRoot];
  if (containers.some((root) => containsPath(root, input.globalRoot) || containsPath(input.globalRoot, root))) fail("continuity-roots-overlap");
  const artifacts = [input.source, input.destination].flatMap((endpoint) => [globalStatePath(endpoint), projectsPath(endpoint), configPath(endpoint)]);
  for (let index = 0; index < artifacts.length; index += 1) {
    for (let other = index + 1; other < artifacts.length; other += 1) {
      if (containsPath(artifacts[index]!, artifacts[other]!) || containsPath(artifacts[other]!, artifacts[index]!)) fail("continuity-roots-overlap");
    }
  }
}

function globalStatePath(endpoint: PortableEndpointV1): string { return join(endpoint.codexHomeRoot, ".codex-global-state.json"); }
function projectsPath(endpoint: PortableEndpointV1): string { return join(endpoint.tweakersRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json"); }
function configPath(endpoint: PortableEndpointV1): string { return join(endpoint.tweakersRoot, "config.json"); }

function readOptionalJson(path: string, label: string, ownerPrivate: ContentPermissions): JsonArtifact {
  if (!existsNoFollow(path)) return { value: null, bytes: null };
  const bytes = readBoundFile(path, MAX_JSON_BYTES, label, ownerPrivate);
  return { value: parseJson(bytes, label), bytes };
}

function readPrivateJson(path: string, max: number, label: string, ownerPrivate: ContentPermissions): unknown {
  return parseJson(readBoundFile(path, max, label, ownerPrivate), label);
}

function readBoundFile(path: string, max: number, label: string, ownerPrivate: ContentPermissions): Buffer {
  const descriptor = noFollowFlag();
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | descriptor);
    const before = fstatFromDescriptor(fd, label);
    assertRegular(before, label, ownerPrivate, max);
    const bytes = readFileSync(fd);
    const after = fstatFromDescriptor(fd, label);
    if (!sameStat(before, after) || bytes.byteLength > max) fail(`${label}-drift`);
    return bytes;
  } catch (error) {
    if (error instanceof PortableSettingsContinuityError) throw error;
    return fail(`${label}-unreadable`);
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
  }
}

function fstatFromDescriptor(fd: number, label: string): Stats {
  try { return fstatSync(fd); } catch { return fail(`${label}-unreadable`); }
}

function writePrivateJsonNew(path: string, value: unknown, mode: number, label: string): void {
  writePrivateBytesNew(path, jsonBytes(value), mode, label);
}

function writePrivateBytesNew(path: string, bytes: Buffer, mode: number, label: string): void {
  if (existsNoFollow(path)) fail(`${label}-exists`);
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), mode);
    fchmodSync(fd, mode);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0) fail(`${label}-short-write`);
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    if (error instanceof PortableSettingsContinuityError) throw error;
    fail(`${label}-write-failed`);
  } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
  }
  assertRegular(lstatSafe(path, label), label, mode === PRIVATE_FILE_MODE || mode === PRIVATE_RECEIPT_MODE, MAX_JSON_BYTES);
  fsyncDirectory(dirname(path));
}

function writePrivateJsonAtomic(path: string, value: unknown, mode: number, label: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writePrivateBytesNew(temporary, jsonBytes(value), mode, `${label}-temporary`);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function acquireLock(path: string, transactionId: string, isProcessAlive: ((pid: number) => boolean) | undefined): Buffer {
  const body = Buffer.from(`${JSON.stringify({ transactionId, pid: process.pid })}\n`, "utf8");
  try {
    writePrivateBytesNew(path, body, PRIVATE_FILE_MODE, "handoff-lock");
    return body;
  } catch (error) {
    if (!(error instanceof PortableSettingsContinuityError) || error.code !== "handoff-lock-exists") throw error;
  }
  const existing = readBoundFile(path, 4096, "handoff-lock", true);
  let owner: unknown;
  try { owner = JSON.parse(existing.toString("utf8")); } catch { fail("handoff-lock-invalid"); }
  if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || typeof owner.pid !== "number" || owner.pid <= 0 || typeof owner.transactionId !== "string") fail("handoff-lock-invalid");
  const ownerPid = owner.pid;
  const ownerTransactionId = owner.transactionId;
  if (typeof ownerPid !== "number" || typeof ownerTransactionId !== "string") fail("handoff-lock-invalid");
  const alive = (isProcessAlive ?? defaultProcessAlive)(ownerPid);
  if (alive) fail("handoff-lock-held");
  const stale = `${path}.stale-${ownerTransactionId}-${randomUUID()}`;
  renameSync(path, stale);
  fsyncDirectory(dirname(path));
  writePrivateBytesNew(path, body, PRIVATE_FILE_MODE, "handoff-lock");
  return body;
}

function releaseLock(path: string, expected: Buffer): void {
  if (!existsNoFollow(path)) return;
  const current = readBoundFile(path, 4096, "handoff-lock", true);
  if (!current.equals(expected)) fail("handoff-lock-ownership-lost");
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function assertDirectory(path: string, label: string, ownerPrivate: ContentPermissions): void {
  const stat = lstatSafe(path, label);
  // POSIX directories normally have two or more links (their own `.` plus
  // child `..` references), so a regular-file single-link rule is invalid
  // here. Symlinks are rejected by lstat; directory hard links are not a
  // supported POSIX surface.
  if (!stat.isDirectory() || stat.isSymbolicLink() || (ownerPrivate === true && (stat.mode & 0o077) !== 0)) fail(`${label}-unsafe`);
  if (ownerPrivate === "native") {
    const mode = stat.mode & 0o777;
    if ((typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (mode !== 0o700 && mode !== 0o755)) fail(`${label}-unsafe`);
    if (realpathSync(path) !== path) fail(`${label}-noncanonical`);
  }
  if (resolve(path) !== path) fail(`${label}-noncanonical`);
}

function assertRegular(stat: Stats, label: string, ownerPrivate: ContentPermissions, max: number): void {
  if (ownerPrivate === "native") {
    const mode = stat.mode & 0o777;
    if ((typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (mode !== 0o600 && mode !== 0o644)) fail(`${label}-unsafe`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 0 || stat.size > max || (ownerPrivate === true && (stat.mode & 0o077) !== 0)) {
    fail(`${label}-unsafe`);
  }
}

function lstatSafe(path: string, label: string): Stats {
  try { return lstatSync(path); } catch { fail(`${label}-missing`); }
}

function existsNoFollow(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try { fd = openSync(path, fsConstants.O_RDONLY); fsyncSync(fd); } finally { if (fd !== null) closeSync(fd); }
}

function noFollowFlag(): number { return fsConstants.O_NOFOLLOW ?? 0; }

function fingerprintOptionalFile(path: string, label: string): Sha256 | null {
  if (!existsNoFollow(path)) return null;
  return fingerprintBytes(readBoundFile(path, MAX_JSON_BYTES, label, false));
}

function assertFingerprint(bytes: Buffer, expected: Sha256, code: string): void {
  if (fingerprintBytes(bytes) !== expected) fail(code);
}

function fingerprintBytes(bytes: Buffer): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function parseJson(bytes: Buffer, label: string): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_JSON_BYTES) fail(`${label}-invalid`);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch { fail(`${label}-invalid`); }
}

function defaultWait(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parseCensus(value: unknown): PortableWriterCensusV1 {
  if (!isRecord(value)) fail("writer-census-invalid");
  const observedAt = value.observedAt;
  const state = value.state;
  const openFileCount = value.openFileCount;
  const unexpectedProcessCount = value.unexpectedProcessCount;
  if (!isCanonicalUtcTimestamp(observedAt) || (state !== "zero" && state !== "running" && state !== "unknown")
    || typeof openFileCount !== "number" || !Number.isSafeInteger(openFileCount) || openFileCount < 0
    || typeof unexpectedProcessCount !== "number" || !Number.isSafeInteger(unexpectedProcessCount) || unexpectedProcessCount < 0) {
    fail("writer-census-invalid");
  }
  if (typeof observedAt !== "string") fail("writer-census-invalid");
  return { observedAt, state, openFileCount, unexpectedProcessCount };
}

function resultFromPlan(plan: PortableHandoffPlanV2, status: PortableHandoffResultV2["status"]): PortableHandoffResultV2 {
  return {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-result",
    transactionId: plan.intent.transactionId,
    status,
    intentFingerprint: plan.intentFingerprint,
    nativeThreadInventoryFingerprint: plan.inventory.fingerprint,
    priorLedgerGeneration: plan.intent.priorLedgerGeneration,
    nextLedgerGeneration: plan.merge.nextLedger.generation,
    selectedFieldCount: plan.merge.selectedFields.length,
    destinationWriteFieldCount: plan.merge.selectedFields.filter((entry) => entry.writesDestination).length,
    conflictFieldIds: plan.merge.conflicts.map((entry) => entry.fieldId),
    excludedFieldIds: plan.intent.excludedFieldIds,
    precondition: plan.precondition,
    nextAction: status === "preview" ? "apply-with-intent" : "none",
  };
}

function resultFromJournal(journal: PortableHandoffJournalV2, status: "applied" | "already-applied"): PortableHandoffResultV2 {
  return {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-result",
    transactionId: journal.transactionId,
    status,
    intentFingerprint: journal.intentFingerprint,
    nativeThreadInventoryFingerprint: journal.intent.nativeThreadInventoryFingerprint,
    priorLedgerGeneration: journal.intent.priorLedgerGeneration,
    nextLedgerGeneration: journal.intent.priorLedgerGeneration + (journal.intent.selectedFieldIds.length > 0 ? 1 : 0),
    selectedFieldCount: journal.intent.selectedFieldIds.length,
    destinationWriteFieldCount: journal.intent.destinationWriteFieldIds.length,
    conflictFieldIds: journal.intent.conflictFieldIds,
    excludedFieldIds: journal.intent.excludedFieldIds,
    precondition: journal.intent.precondition,
    nextAction: "none",
  };
}

function manualRecoveryResult(journal: PortableHandoffJournalV2): PortableHandoffResultV2 {
  return {
    ...resultFromJournal(journal, "applied"),
    status: "manual-recovery-required",
    nextAction: "recover-explicitly",
  };
}

function rolledBackResult(journal: PortableHandoffJournalV2): PortableHandoffResultV2 {
  return {
    ...resultFromJournal(journal, "applied"),
    status: "rolled-back",
    nextAction: "none",
  };
}

function unsupportedResult(transactionId: string): PortableHandoffResultV2 {
  return {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-result",
    transactionId,
    status: "unsupported-schema",
    intentFingerprint: null,
    nativeThreadInventoryFingerprint: null,
    priorLedgerGeneration: null,
    nextLedgerGeneration: null,
    selectedFieldCount: 0,
    destinationWriteFieldCount: 0,
    conflictFieldIds: [],
    excludedFieldIds: [],
    precondition: null,
    nextAction: "none",
  };
}

function noTransactionResult(transactionId: string): PortableHandoffResultV2 {
  return {
    schemaVersion: 2,
    kind: "portable-desktop-handoff-result",
    transactionId,
    status: "no-transaction",
    intentFingerprint: null,
    nativeThreadInventoryFingerprint: null,
    priorLedgerGeneration: null,
    nextLedgerGeneration: null,
    selectedFieldCount: 0,
    destinationWriteFieldCount: 0,
    conflictFieldIds: [],
    excludedFieldIds: [],
    precondition: null,
    nextAction: "none",
  };
}

function withoutBytes(value: PortableArtifactPlanV2): Omit<PortableArtifactPlanV2, "candidateBytes"> {
  const { candidateBytes: _candidateBytes, ...result } = value;
  return result;
}

function artifactName(value: unknown): PortableArtifactPlanV2["name"] {
  if (!artifactNameSafe(value)) fail("artifact-name-invalid");
  return value;
}

function artifactNameSafe(value: unknown): value is PortableArtifactPlanV2["name"] {
  return value === "global-state" || value === "projects" || value === "config" || value === "ledger";
}

function exactAbsolute(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 2 || !isAbsolute(value) || normalize(value) !== value || resolve(value) !== value) fail(code);
  return value;
}

function validatedTransactionId(value: unknown): string {
  if (typeof value !== "string" || !TRANSACTION_ID.test(value)) fail("transaction-id-invalid");
  return value;
}

function containsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSha256(value: unknown): value is Sha256 { return typeof value === "string" && SHA256.test(value); }
function canonicalNow(value: string): string { if (!isCanonicalUtcTimestamp(value)) fail("timestamp-invalid"); return value; }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function isUnsupportedSchema(error: unknown): boolean {
  return (error instanceof PortableSettingsContinuityError && error.code === "unsupported-schema")
    || (error instanceof PortableContinuityProjectionError && error.code === "unsupported-schema");
}
function handoffPhase(value: unknown): PortableHandoffPhaseV2 {
  const phases: readonly PortableHandoffPhaseV2[] = [
    "journal-prepared", "intent-published", "preimages-preserved", "candidates-prepared", "candidate-verified",
    "publishing", "artifacts-published", "ledger-published", "receipt-published", "rolled-back", "manual-recovery-required",
  ];
  if (!phases.includes(value as PortableHandoffPhaseV2)) fail("handoff-journal-invalid");
  return value as PortableHandoffPhaseV2;
}
function fail(code: string): never { throw new PortableSettingsContinuityError(code); }

function readDirectoryNames(path: string): string[] {
  // Directory traversal is bounded by stat validation above and never follows entries.
  try { return readdirSync(path).sort(compareCodeUnits); } catch { return fail("directory-unreadable"); }
}

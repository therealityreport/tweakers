import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE,
  HISTORY_ADOPTION_MAX_ALIASES_BYTES,
  adoptAccountHistory,
  assertHistoryAdoptionAliasesBindCompletedProof,
  canonicalJson,
  canonicalSha256Fingerprint,
  historyAdoptionIntentFingerprint,
  historyAdoptionReceiptFingerprint,
  historyAdoptionCensusInput,
  initializeMissingLegacyV2HistoryAdoption,
  inspectCompletedLegacyV2HistoryAdoption,
  isHistoryAdoptionIdleCensus,
  isCanonicalUtcTimestamp,
  isOpaqueAccountId,
  isSha256Fingerprint,
  observeHistoryAdoptionCensus,
  parseHistoryAdoptionAliases,
  verifyHistoryAdoptionAliases,
  type AdoptAccountHistoryInput,
  type CompletedLegacyV2HistoryAdoptionProof,
  type HistoryAdoptionAliasRecordV1,
  type HistoryAdoptionAliasesV1,
  type HistoryAdoptionCensus,
  type HistoryAdoptionCensusInput,
  type HistoryAdoptionDependencies,
  type HistoryAdoptionInitializationDependencies,
  type HistoryAdoptionInitializationPhase,
  type HistoryAdoptionInitializationResult,
  type HistoryAdoptionResult,
  type OpaqueAccountId,
  type Sha256Fingerprint,
} from "./account-history-adoption.js";
import {
  assertCandidatePackageExistingDirectory,
  assertCandidatePackageParentAnchor,
  assertCandidatePackagePathsDisjoint,
  closeCandidatePackageParentAnchor,
  closeCandidatePackageScratchAnchor,
  createCandidatePackageScratch,
  openCandidatePackageParentAnchor,
  projectCandidatePackagePath,
  publishCandidatePackageExclusively,
  retainCandidatePackageEvidence,
  type CandidatePackageParentAnchor,
  type CandidatePackageScratchAnchor,
} from "./candidate-package-filesystem.js";

/** The runtime-owned private canonical store.  This module is only its explicit offline producer. */
export const CANONICAL_HISTORY_FILE = "canonical-history.v1.json" as const;
/** Migration-owned, HMAC-bound provenance for partial legacy imports. */
export const CANONICAL_HISTORY_MIGRATION_SOURCES_FILE = "canonical-history-migration-sources.v1.json" as const;
export const SHARED_HISTORY_MIGRATION_JOURNAL_VERSION = 2 as const;
export const SHARED_HISTORY_ROLLBACK_VIEWER_FILE = "rollback-viewer.v1.json" as const;
/** Immutable manager-global Skills source materialized only by the offline v3 migration. */
export const SHARED_SKILLS_DIRECTORY = "shared-skills" as const;
/** Non-secret content manifest binding every account-local Skills copy to that source. */
export const SHARED_SKILLS_MANIFEST_FILE = "shared-skills.v1.json" as const;
/** One sealed source package cache, projected into every routed child without N physical copies. */
export const SHARED_PLUGINS_DIRECTORY = "shared-plugins" as const;
export const SHARED_PLUGINS_MANIFEST_FILE = "shared-plugins.v1.json" as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_TREE_FILES = 250_000;
const MAX_TREE_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
/** Mirrors the runtime-owned canonical-history capacity contract. */
export const CANONICAL_HISTORY_MAX_BYTES_V1 = 128 * 1024 * 1024;
/** Mirrors the runtime-owned full write-ahead record capacity contract. */
export const CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1 = CANONICAL_HISTORY_MAX_BYTES_V1 + 1024;
/** Mirrors the runtime-owned logical-conversation capacity contract. */
export const CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 = 16_384;
/** The installer-owned migration-source evidence is bounded separately. */
export const CANONICAL_HISTORY_MIGRATION_EVIDENCE_MAX_BYTES_V1 = 16 * 1024 * 1024;
export const SHARED_HISTORY_CAPACITY_PROJECTION_FILE = "canonical-history-capacity-projection.v1.json" as const;
export const SHARED_HISTORY_CAPACITY_RECEIPT_FILE = "shared-history-capacity-receipt.v1.json" as const;
const MAX_SHARED_HISTORY_CAPACITY_RECEIPT_BYTES = 64 * 1024;
const MAX_SEGMENTS_PER_CONVERSATION = 64;
const MAX_TURNS_PER_SEGMENT = 1_024;
const MAX_NATIVE_ID_BYTES = 512;
const MAX_SERIALIZED_INPUT_BYTES = 24 * 1024;
const MAX_PORTABLE_TRANSCRIPT_BYTES = 96 * 1024;
const MAX_PORTABLE_TRANSCRIPT_ITEMS = 256;
const MAX_PORTABLE_TEXT_BYTES = 96 * 1024;
const MAX_LEGACY_ROLLOUT_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_ROLLOUT_LINES = 65_536;
const MAX_LEGACY_TITLE_BYTES = 240;
const MAX_SHARED_SKILL_FILES = 32_768;
const MAX_SHARED_SKILL_BYTES = 512 * 1024 * 1024;
const MAX_SHARED_PLUGIN_FILES = 250_000;
const MAX_SHARED_PLUGIN_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_SHARED_PLUGIN_INVENTORY_BYTES = 2 * 1024 * 1024;
const EMPTY_SHA256_FINGERPRINT = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as Sha256Fingerprint;

type CanonicalAvailability = "complete" | "partial" | "incomplete" | "ambiguous";
type CanonicalSegmentState = "committed" | "active" | "incomplete" | "ambiguous";
type CanonicalTurnState = "committed" | "active" | "incomplete" | "ambiguous";
type CanonicalTurnPhase = "prepared" | "dispatching" | "active" | "committed" | "aborted" | "ambiguous";

export interface CanonicalHistoryTurnV1 {
  turnId: `lt_${string}`;
  /** Null unless the immutable legacy completion actually persisted a native turn id. */
  nativeTurnId: string | null;
  /** Persisted source item IDs only; omitted/unknown remains an empty array. */
  nativeItemIds: readonly string[];
  state: CanonicalTurnState;
  phase: CanonicalTurnPhase;
  startedAt: string;
  committedAt?: string;
  serializedInput: { digest: Sha256Fingerprint; text: string } | null;
  portableTranscript: CanonicalPortableTranscriptV1 | null;
}

export type CanonicalPortableTranscriptItemV1 =
  | { kind: "user" | "assistant" | "plan"; text: string }
  | { kind: "tool"; name: string; result: string };

export interface CanonicalPortableTranscriptV1 {
  digest: Sha256Fingerprint;
  items: readonly CanonicalPortableTranscriptItemV1[];
}

export interface CanonicalHistorySegmentV1 {
  segmentId: `ls_${string}`;
  opaqueAccountId: OpaqueAccountId;
  nativeThreadId: string;
  state: CanonicalSegmentState;
  createdAt: string;
  committedAt?: string;
  turns: readonly CanonicalHistoryTurnV1[];
}

export interface CanonicalHistoryConversationV1 {
  conversationId: `lc_${string}`;
  /** Owner-private root native id; never project this outside the private store. */
  rootNativeThreadId: string;
  /** Safe derived title only; null delegates to the core's stable fallback. */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  availability: CanonicalAvailability;
  /** HMAC handle only; provider/native thread ids remain private. */
  publicThreadId: `lh_${string}`;
  activeClient: null | { clientId: `br_${string}`; label: string };
  segments: readonly CanonicalHistorySegmentV1[];
}

export interface CanonicalHistoryStoreV1 {
  version: 1;
  conversations: readonly CanonicalHistoryConversationV1[];
}

export interface CanonicalHistoryStorePreflight {
  version: 1;
  fileName: typeof CANONICAL_HISTORY_FILE;
  state: "ready" | "missing" | "invalid";
  conversationCount: number;
  segmentCount: number;
}

export type SharedHistoryMigrationPhase =
  | "legacy-adoption-initialization-journal-prepared"
  | "legacy-adoption-initialization-intent-published"
  | "legacy-adoption-initialization-router-state-published"
  | "legacy-adoption-initialization-complete"
  | "journal-prepared"
  | "legacy-adoption-complete"
  | "pre-migration-snapshot-created"
  | "candidate-copied"
  | "candidate-canonicalized"
  | "candidate-preflight-ready"
  | "published"
  | "collision-quarantined"
  | "recovered";

export interface SharedHistoryMigrationInput {
  /** Exact v2 account-router root. It is copied, never replaced. */
  legacyRouterRoot: string;
  /** Exact source used only by the existing receipt-backed v2 adoption. */
  legacyCodexRoot: string;
  /** Exact source used only by the existing receipt-backed v2 adoption. */
  legacySqliteRoot: string;
  /**
   * Exact offline source for the strictly allowlisted Skills and selected
   * plugin-cache definitions. Omission preserves the legacy one-root layout.
   */
  legacyDefinitionsRoot?: string;
  /** Exact, absent manager-global v3 broker root to publish exclusively. */
  globalRoot: string;
  /** Exact primary ChatGPT desktop path preserved for the v2 adoption census. */
  appPath: string;
  /** Exact separate Tweakers desktop path required by every migration census. */
  tweakersAppPath: string;
  /**
   * Exact canonical directories permitted to supply a flattened target for a
   * legacy Skills symlink. These are migration inputs, never runtime roots.
   */
  sharedSkillsRoots: readonly string[];
  /**
   * Exact owner-private, normalized v1 list of every effective plugin ID and
   * installed version.
   * This is the only plugin-selection authority; legacy config.toml is never
   * consulted by this migration.
   */
  sharedPluginInventory: string;
  /** Omitted/false performs a read-only preview. */
  apply?: boolean;
  /**
   * Optional, explicit private review directory written only by preview. It is
   * never a migration input and is deliberately outside every source manifest.
   */
  projectionOutputRoot?: string;
  /** Explicit owner-private receipt produced by a matching capacity preview. */
  capacityReceiptPath?: string;
  /** Stable caller-generated ID; omitted only for a new transaction. */
  transactionId?: string;
}

/** Inputs for the one explicit v2 preparation action; it never creates a v3 root. */
export interface SharedHistoryAdoptionPreparationInput {
  legacyRouterRoot: string;
  legacyCodexRoot: string;
  legacySqliteRoot: string;
  appPath: string;
  tweakersAppPath: string;
}

export interface SharedHistoryAdoptionPreparationResult {
  status: "prepared" | "already-prepared";
  adoptionReceiptFingerprint: Sha256Fingerprint;
  importedThreadCount: number;
  nextAction: "preview-capacity";
}

export interface SharedHistoryMigrationDependencies {
  adopt?: (
    input: AdoptAccountHistoryInput,
    dependencies?: Partial<HistoryAdoptionDependencies>,
  ) => HistoryAdoptionResult;
  inspectLegacyAdoption?: (routerRoot: string) => CompletedLegacyV2HistoryAdoptionProof;
  adoptionDependencies?: Partial<HistoryAdoptionDependencies>;
  /**
   * Strictly limited v2 prerequisite materialization.  It is only used while
   * the legacy v2 layout remains authoritative and never writes a receipt,
   * copies history, or starts a broker.
   */
  initializeLegacyAdoption?: (
    input: AdoptAccountHistoryInput,
    dependencies?: Partial<HistoryAdoptionInitializationDependencies>,
  ) => HistoryAdoptionInitializationResult;
  initializationDependencies?: Partial<HistoryAdoptionInitializationDependencies>;
  /**
   * The migration independently proves the supplied legacy layout is idle
   * before creating its journal and again immediately before publication.
   * It uses the same exact-root, observation-only contract as v2 adoption.
   */
  census?: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus;
  /** The core-owned verifier is injectable; the strict local contract is the safe default. */
  preflightCanonicalHistoryStore?: (root: string) => CanonicalHistoryStorePreflight;
  now?: () => string;
  randomId?: () => string;
  /** Test-only durable-boundary hook. A thrown crash is intentionally not rolled back. */
  beforePhase?: (phase: SharedHistoryMigrationPhase) => void;
}

export interface SharedHistoryMigrationResult {
  status: "dry-run" | "adoption-required" | "migrated" | "already-published" | "collision-quarantined" | "recovered";
  transactionId: string | null;
  sourceFingerprint: Sha256Fingerprint | null;
  candidateFingerprint: Sha256Fingerprint | null;
  conversationCount: number;
  segmentCount: number;
  /** Non-secret source definition proof emitted even by a read-only preview. */
  sharedSkillsFingerprint: Sha256Fingerprint | null;
  /** Canonical, operator-declared roots used for any legacy Skills links. */
  sharedSkillsTrustedRoots: readonly string[];
  /** Binds those roots and their owner-private filesystem identities. */
  sharedSkillsTrustedRootsFingerprint: Sha256Fingerprint | null;
  sharedPluginsFingerprint: Sha256Fingerprint | null;
  /** Fingerprint of the explicit, normalized effective-plugin inventory. */
  sharedPluginInventoryFingerprint: Sha256Fingerprint | null;
  /** Metadata-only proof for credential-shaped package files excluded from the snapshot. */
  sharedPluginExclusionsFingerprint: Sha256Fingerprint | null;
  sharedPluginIds: readonly string[];
  /** Exact package versions bound into the manifest, journal, and result. */
  sharedPluginPackages: readonly SharedPluginInventoryEntryV1[];
  /** Exact bounded-capacity evidence, present only after a completed v2 adoption. */
  capacity: SharedHistoryCapacityPreviewV1 | null;
  nextAction: "apply-offline-migration" | "prepare-adoption-first" | "initialize-v2-adoption-first" | "complete-v2-adoption-first" | "capacity-exceeded" | "activate-remains-user-confirmed" | "inspect-retained-evidence" | "none";
}

export interface SharedHistoryCapacityLimitsV1 {
  snapshotBytes: number;
  journalBytes: number;
  conversations: number;
  sourceEvidenceBytes: number;
}

export interface SharedHistoryCapacityCountsV1 {
  conversations: number;
  segments: number;
  turns: number;
  fullConversations: number;
  partialConversations: number;
}

export interface SharedHistoryCapacityByteProofV1 {
  bytes: number;
  sha256: Sha256Fingerprint;
}

export interface SharedHistoryCapacityMarginsV1 {
  snapshotBytes: number;
  journalBytes: number;
  conversations: number;
  sourceEvidenceBytes: number;
}

export interface SharedHistoryCapacityProofBindingV1 {
  configFingerprint: Sha256Fingerprint;
  protocolFingerprint: Sha256Fingerprint;
  poolFingerprint: Sha256Fingerprint;
  intentFingerprint: Sha256Fingerprint;
  adoptionReceiptFingerprint: Sha256Fingerprint;
  sourceFingerprint: Sha256Fingerprint;
  destinationFingerprint: Sha256Fingerprint;
  ownersFingerprint: Sha256Fingerprint;
  aliasesFingerprint: Sha256Fingerprint | null;
}

export interface SharedHistoryCapacitySourceBindingV1 {
  routerManifestFingerprint: Sha256Fingerprint;
  sourceDatabaseManifestFingerprint: Sha256Fingerprint;
  normalizedSourceDatabaseManifestFingerprint: Sha256Fingerprint;
  sharedSkillsManifestFingerprint: Sha256Fingerprint;
  sharedPluginsManifestFingerprint: Sha256Fingerprint;
  /** Exact definitions-root identity prevents same-content root replacement. */
  definitionsRoot: SharedHistoryCapacityReceiptRootBindingV1;
}

export interface SharedHistoryCapacityProjectionBindingV1 {
  snapshot: SharedHistoryCapacityByteProofV1;
  journal: SharedHistoryCapacityByteProofV1;
  sourceEvidence: SharedHistoryCapacityByteProofV1;
}

interface SharedHistoryCapacityReceiptV1 {
  version: 1;
  kind: "shared-history-capacity-receipt";
  proof: SharedHistoryCapacityProofBindingV1;
  sources: SharedHistoryCapacitySourceBindingV1;
  caps: SharedHistoryCapacityLimitsV1;
  projection: SharedHistoryCapacityProjectionBindingV1;
  counts: SharedHistoryCapacityCountsV1;
  margins: SharedHistoryCapacityMarginsV1;
  issuedAt: string;
  hmac: `hmac-sha256:${string}`;
}

export interface SharedHistoryCapacityPreviewV1 {
  version: 1;
  withinCapacity: boolean;
  caps: SharedHistoryCapacityLimitsV1;
  projection: SharedHistoryCapacityProjectionBindingV1;
  counts: SharedHistoryCapacityCountsV1;
  margins: SharedHistoryCapacityMarginsV1;
  receiptFingerprint: Sha256Fingerprint | null;
  reviewOutput: null | {
    projectionFile: typeof SHARED_HISTORY_CAPACITY_PROJECTION_FILE;
    receiptFile: typeof SHARED_HISTORY_CAPACITY_RECEIPT_FILE;
  };
}

/** Immutable filesystem identity sealed by the offline launcher with a receipt. */
export interface SharedHistoryCapacityReceiptRootBindingV1 {
  path: string;
  device: number;
  inode: number;
  uid: number;
  mode: number;
  nlink: number;
}

/** Exact private receipt file seal; its digest is over the on-disk newline JSON. */
export interface SharedHistoryCapacityReceiptFileSealV1 {
  path: string;
  bytes: number;
  sha256: Sha256Fingerprint;
  device: number;
  inode: number;
  uid: number;
  mode: number;
  nlink: number;
}

/** Read-only input accepted by the offline launcher before it seals a context. */
export interface SharedHistoryCapacityReceiptInspectionInput {
  legacyRouterRoot: string;
  legacyCodexRoot: string;
  legacySqliteRoot: string;
  /** Omitted only for a legacy one-root layout, where Codex is the definition root. */
  legacyDefinitionsRoot?: string;
  /** These and the inventory must be supplied together to bind definition manifests. */
  sharedSkillsRoots?: readonly string[];
  /** These and trusted roots must be supplied together to bind definition manifests. */
  sharedPluginInventory?: string;
  capacityReceiptPath: string;
}

/**
 * Non-secret receipt metadata that a launcher may seal and compare at every
 * boundary.  It intentionally omits the HMAC and all canonical document data.
 */
export interface SharedHistoryCapacityReceiptInspectionV1 {
  version: 1;
  kind: "shared-history-capacity-receipt-inspection";
  receipt: SharedHistoryCapacityReceiptFileSealV1;
  issuedAt: string;
  proof: SharedHistoryCapacityProofBindingV1;
  sources: SharedHistoryCapacitySourceBindingV1;
  projection: SharedHistoryCapacityProjectionBindingV1;
  roots: {
    router: SharedHistoryCapacityReceiptRootBindingV1;
    codex: SharedHistoryCapacityReceiptRootBindingV1;
    sqlite: SharedHistoryCapacityReceiptRootBindingV1;
    definitions: SharedHistoryCapacityReceiptRootBindingV1;
  };
}

export interface SharedHistoryRollbackView {
  state: "ready" | "missing" | "invalid";
  canonicalFingerprint: Sha256Fingerprint | null;
  conversationCount: number;
  segmentCount: number;
  /** This source-only helper never stops a live broker itself. */
  requiresBrokerWriteStop: true;
  legacySqliteFlattened: false;
}

export interface SharedHistoryRollbackExportInput {
  globalRoot: string;
  outputRoot: string;
  transactionId?: string;
}

export interface SharedHistoryRollbackExportResult extends SharedHistoryRollbackView {
  status: "exported" | "collision-quarantined";
  transactionId: string;
  archiveFingerprint: Sha256Fingerprint | null;
}

interface TreeManifestEntry {
  path: string;
  bytes: number;
  sha256: Sha256Fingerprint;
}

interface TreeManifestLink {
  path: string;
  target: string;
}

interface TreeManifest {
  directories: readonly string[];
  files: readonly TreeManifestEntry[];
  links: readonly TreeManifestLink[];
  fingerprint: Sha256Fingerprint;
}

interface SharedSkillsTrustedRootV1 {
  path: string;
  device: number;
  inode: number;
  uid: number;
  mode: number;
}

interface SharedSkillsManifestV1 {
  version: 1;
  kind: "account-router-shared-skills";
  directories: readonly string[];
  files: readonly TreeManifestEntry[];
  trustedRoots: readonly SharedSkillsTrustedRootV1[];
  trustedRootsFingerprint: Sha256Fingerprint;
  fingerprint: Sha256Fingerprint;
}

interface SharedSkillsSourceFileV1 extends TreeManifestEntry {
  sourcePath: string;
  device: number;
  inode: number;
  mtimeMs: number;
}

interface SharedSkillsSourceScanV1 {
  manifest: SharedSkillsManifestV1;
  sourceRoot: string;
  files: readonly SharedSkillsSourceFileV1[];
}

interface SharedPluginPackageV1 {
  pluginId: string;
  registry: string;
  name: string;
  /** Exact installed version; package-name roots and `local` pointers are never materialized. */
  version: string;
  fingerprint: Sha256Fingerprint;
  exclusionsFingerprint: Sha256Fingerprint;
  excludedFiles: readonly SharedPluginExcludedFileV1[];
  fileCount: number;
  bytes: number;
}

/** Metadata-only proof for a credential-shaped package file never copied into the shared cache. */
type SharedPluginExclusionReasonV1 = "credential" | "transient-lock";

interface SharedPluginExcludedFileV1 {
  path: string;
  bytes: number;
  sha256: Sha256Fingerprint;
  reason: SharedPluginExclusionReasonV1;
}

interface SharedPluginsManifestV1 {
  version: 1;
  kind: "account-router-shared-plugins";
  inventoryFingerprint: Sha256Fingerprint;
  exclusionsFingerprint: Sha256Fingerprint;
  packages: readonly SharedPluginPackageV1[];
  fingerprint: Sha256Fingerprint;
}

/**
 * The external, owner-private selection receipt deliberately contains no
 * registry aliases, settings, credentials, package locations, or enablement
 * values. Each pair must already be the effective `codex plugin list --json`
 * entry and therefore maps directly to cache/<registry>/<name>/<version>.
 */
interface SharedPluginInventoryEntryV1 {
  pluginId: string;
  version: string;
}

interface SharedPluginInventoryV1 {
  version: 1;
  plugins: readonly SharedPluginInventoryEntryV1[];
}

interface SharedPluginSourceFileV1 extends TreeManifestEntry {
  sourcePath: string;
  device: number;
  inode: number;
  mtimeMs: number;
}

interface SharedPluginExcludedSourceFileV1 extends SharedPluginExcludedFileV1 {
  sourcePath: string;
  device: number;
  inode: number;
  mtimeMs: number;
}

interface SharedPluginSourcePackageV1 {
  package: SharedPluginPackageV1;
  sourceRoot: string;
  directories: readonly string[];
  files: readonly SharedPluginSourceFileV1[];
  excludedFiles: readonly SharedPluginExcludedSourceFileV1[];
}

interface SharedPluginsSourceScanV1 {
  manifest: SharedPluginsManifestV1;
  /** Exact definition root re-scanned after the sealed copy is written. */
  legacyDefinitionsRoot: string;
  /** Exact private inventory re-read before publication to detect drift. */
  inventoryPath: string;
  inventoryFingerprint: Sha256Fingerprint;
  packages: readonly SharedPluginSourcePackageV1[];
}

interface CanonicalJournalSummary {
  fingerprint: Sha256Fingerprint;
  conversationCount: number;
  segmentCount: number;
}

type MigrationSourceDisposition = "imported" | "partial" | "receipt-only";

/**
 * A private, HMAC-bound link from each logical conversation to the immutable
 * pre-migration snapshot that justified it. This is deliberately outside the
 * strict runtime canonical document: normal logical reads must never reopen a
 * legacy account home or SQLite store.
 */
interface MigrationSourceReferenceV1 {
  conversationId: `lc_${string}`;
  opaqueAccountId: OpaqueAccountId;
  nativeThreadId: string;
  disposition: MigrationSourceDisposition;
  snapshotRelativePath: string | null;
  sourceDigest: Sha256Fingerprint;
  importedTurnCount: number;
  physicalAliases: readonly MigrationPhysicalAliasV1[];
}

/** Owner-private only; canonical list/read projection never sees these bindings. */
interface MigrationPhysicalAliasV1 {
  copyOperationId: string;
  opaqueAccountId: OpaqueAccountId;
  nativeThreadId: string;
  snapshotRelativePath: string;
  sourceDigest: Sha256Fingerprint;
  portableTranscriptDigest: Sha256Fingerprint;
}

interface MigrationSourceEvidenceV1 {
  version: 1;
  kind: "canonical-history-migration-sources";
  snapshotFingerprint: Sha256Fingerprint;
  references: readonly MigrationSourceReferenceV1[];
  hmac: `hmac-sha256:${string}`;
}

interface ImportedLegacyConversation {
  opaqueAccountId: OpaqueAccountId;
  nativeThreadId: string;
  sourceRelativePath: string | null;
  sourceDigest: Sha256Fingerprint;
  turns: readonly CanonicalHistoryTurnV1[];
  title: string | null;
  partial: boolean;
  createdAt: string;
  updatedAt: string;
  portableTranscriptDigest: Sha256Fingerprint | null;
}

interface SharedHistoryMigrationJournalV1 {
  version: 1;
  kind: "shared-history-migration";
  id: string;
  legacyRouterRoot: string;
  legacyCodexRoot: string;
  legacySqliteRoot: string;
  globalRoot: string;
  snapshotRoot: string;
  candidateRoot: string;
  quarantineRoot: string;
  phase: SharedHistoryMigrationPhase;
  preAdoptionManifest: TreeManifest;
  preMigrationManifest: TreeManifest | null;
  candidateManifest: TreeManifest | null;
  canonical: CanonicalJournalSummary | null;
  sharedSkills: SharedSkillsManifestV1 | null;
  sharedPluginInventoryFingerprint: Sha256Fingerprint;
  sharedPluginExclusionsFingerprint: Sha256Fingerprint;
  sharedPlugins: SharedPluginsManifestV1 | null;
}

/**
 * New journals bind the separate definitions root. Recovery still accepts a
 * strictly shaped v1 journal only when the caller resolves that root to its
 * historical implicit legacy CODEX_HOME value.
 */
interface SharedHistoryMigrationJournalV2 extends Omit<SharedHistoryMigrationJournalV1, "version"> {
  version: typeof SHARED_HISTORY_MIGRATION_JOURNAL_VERSION;
  legacyDefinitionsRoot: string;
}

type SharedHistoryMigrationJournal = SharedHistoryMigrationJournalV1 | SharedHistoryMigrationJournalV2;

interface LegacyDefinitionsRootIdentity {
  path: string;
  device: number;
  inode: number;
  uid: number;
  mode: number;
}

interface MigrationPaths {
  legacyRouterRoot: string;
  legacyCodexRoot: string;
  legacySqliteRoot: string;
  legacyDefinitionsRoot: string;
  legacyDefinitionsRootIdentity: LegacyDefinitionsRootIdentity;
  globalRoot: string;
  appPath: string;
  tweakersAppPath: string;
  sharedSkillsTrustedRoots: readonly SharedSkillsTrustedRootV1[];
  sharedPluginInventory: string;
  parentRoot: string;
  transactionId: string;
  journalPath: string;
  journalStagingPath: string;
  snapshotRoot: string;
  candidateRoot: string;
  quarantineRoot: string;
}

interface SharedHistoryAdoptionPreparationPaths {
  legacyRouterRoot: string;
  legacyCodexRoot: string;
  legacySqliteRoot: string;
  appPath: string;
  tweakersAppPath: string;
}

class SharedHistoryMigrationFailure extends Error {
  constructor(readonly code: string) {
    super(`Shared history migration stopped safely: ${code}`);
    this.name = "SharedHistoryMigrationFailure";
  }
}

/** Test helpers may throw this to model a process death after a durable boundary. */
export class SharedHistoryMigrationCrash extends Error {
  constructor(readonly phase: SharedHistoryMigrationPhase) {
    super(`simulated process death after durable shared-history migration phase ${phase}`);
    this.name = "SharedHistoryMigrationCrash";
  }
}

function fail(code: string): never {
  throw new SharedHistoryMigrationFailure(code);
}

/**
 * Materialize and complete only the existing signed v2 adoption. The resulting
 * proof remains in the legacy router root; this action intentionally does not
 * create a global-v3 journal, snapshot, candidate, or root.
 */
export function prepareSharedHistoryAdoption(
  input: SharedHistoryAdoptionPreparationInput,
  suppliedDependencies: SharedHistoryMigrationDependencies = {},
): SharedHistoryAdoptionPreparationResult {
  const dependencies = migrationDependencies(suppliedDependencies);
  const paths = sharedHistoryAdoptionPreparationPaths(input);
  const adoptionInput = legacyAdoptionInput(paths);
  const census = dualDesktopMigrationCensus(
    dependencies.census,
    paths.appPath,
    paths.tweakersAppPath,
  );
  const adoptionDependencies: Partial<HistoryAdoptionDependencies> = {
    ...dependencies.adoptionDependencies,
    census,
  };
  const initialization = dependencies.initializeLegacyAdoption({ ...adoptionInput, apply: true }, {
    ...dependencies.initializationDependencies,
    census,
    now: dependencies.now,
    beforePhase: (phase) => {
      dependencies.initializationDependencies?.beforePhase?.(phase);
      dependencies.beforePhase?.(sharedHistoryInitializationPhase(phase));
    },
  });
  if (initialization.status === "initialization-required") fail("legacy-v2-adoption-initialization-not-completed");
  const adoption = dependencies.adopt({ ...adoptionInput, apply: true }, adoptionDependencies);
  if (adoption.status === "dry-run") fail("legacy-v2-adoption-not-completed");
  const proof = dependencies.inspectLegacyAdoption(paths.legacyRouterRoot);
  assertLegacyProofMatchesPreview(proof, adoption);
  return {
    status: adoption.status === "adopted" ? "prepared" : "already-prepared",
    adoptionReceiptFingerprint: historyAdoptionReceiptFingerprint(proof.receipt),
    importedThreadCount: proof.owners.threadIds.length,
    nextAction: "preview-capacity",
  };
}

/**
 * Explicit, offline-only migration entrypoint. Nothing in runtime imports or
 * invokes this module; callers must separately pass `apply: true` after a
 * read-only preview and a broker-safe offline window.
 */
export function migrateSharedHistoryV2ToGlobalV3(
  input: SharedHistoryMigrationInput,
  suppliedDependencies: SharedHistoryMigrationDependencies = {},
): SharedHistoryMigrationResult {
  const dependencies = migrationDependencies(suppliedDependencies);
  const paths = migrationPaths(input, dependencies.randomId);
  // This is deliberately before every mutable migration boundary. A preview
  // therefore proves the exact legacy Skills source and its declared external
  // provenance without materializing anything.
  const sharedSkillsSource = scanLegacySharedSkillsTree(join(paths.legacyDefinitionsRoot, "skills"), paths.sharedSkillsTrustedRoots);
  const sharedPluginsSource = scanLegacySharedPlugins(paths.legacyDefinitionsRoot, paths.sharedPluginInventory);
  const capacityReceiptPath = input.apply === true
    ? requiredCapacityReceiptPath(input.capacityReceiptPath)
    : null;
  if (capacityReceiptPath !== null) {
    assertSharedHistoryCapacityReceiptPathDisjoint(paths, capacityReceiptPath);
  }
  const adoptionInput = legacyAdoptionInput(paths);
  const census = dualDesktopMigrationCensus(
    dependencies.census,
    paths.appPath,
    paths.tweakersAppPath,
    [
      paths.legacyDefinitionsRoot,
      ...(capacityReceiptPath === null ? [] : [capacityReceiptPath]),
    ],
  );
  const adoptionDependencies: Partial<HistoryAdoptionDependencies> = {
    ...dependencies.adoptionDependencies,
    census,
  };
  const preview = dependencies.adopt({ ...adoptionInput, apply: false }, adoptionDependencies);
  if (preview.status === "dry-run") {
    return migrationResult("adoption-required", null, null, null, 0, 0, "prepare-adoption-first", sharedSkillsSource.manifest, sharedPluginsSource.manifest);
  }
  const proof = dependencies.inspectLegacyAdoption(paths.legacyRouterRoot);
  assertLegacyProofMatchesPreview(proof, preview);
  let preMigrationManifest = scanPrivateTree(paths.legacyRouterRoot);
  let capacityReceipt: SharedHistoryCapacityReceiptV1 | null = null;
  const projectionAt = input.apply === true
    ? (capacityReceipt = readSharedHistoryCapacityReceipt(
      capacityReceiptPath!,
      paths.legacyRouterRoot,
    )).issuedAt
    : canonicalCapacityTimestamp(dependencies.now());
  let capacity = buildSharedHistoryCapacityPreview({
    paths,
    proof,
    routerManifest: preMigrationManifest,
    sharedSkills: sharedSkillsSource.manifest,
    sharedPlugins: sharedPluginsSource.manifest,
    projectedAt: projectionAt,
  });

  if (input.apply !== true) {
    if (input.projectionOutputRoot !== undefined && capacity.withinCapacity) {
      const receipt = createSharedHistoryCapacityReceipt({
        capacity,
        paths,
        proof,
        routerManifest: preMigrationManifest,
        sharedSkills: sharedSkillsSource.manifest,
        sharedPlugins: sharedPluginsSource.manifest,
        issuedAt: projectionAt,
      });
      writeSharedHistoryCapacityReviewOutput(
        input.projectionOutputRoot,
        capacity,
        receipt,
        paths,
        proof,
        preMigrationManifest,
        dependencies.randomId,
      );
      capacity = {
        ...capacity,
        receiptFingerprint: capacityReceiptFingerprint(receipt),
        reviewOutput: {
          projectionFile: SHARED_HISTORY_CAPACITY_PROJECTION_FILE,
          receiptFile: SHARED_HISTORY_CAPACITY_RECEIPT_FILE,
        },
      };
    }
    return migrationResult(
      "dry-run",
      null,
      preMigrationManifest.fingerprint,
      null,
      capacity.counts.conversations,
      capacity.counts.segments,
      capacity.withinCapacity ? "apply-offline-migration" : "capacity-exceeded",
      sharedSkillsSource.manifest,
      sharedPluginsSource.manifest,
      capacity,
    );
  }

  if (!capacityReceipt) fail("shared-history-capacity-receipt-required");
  assertSharedHistoryCapacityReceipt(capacityReceipt, capacity, paths, proof, preMigrationManifest, sharedSkillsSource.manifest, sharedPluginsSource.manifest);
  assertSharedHistoryCapacityWithinBounds(capacity);

  // The same receipt is rechecked after the final two-desktop idle gate and
  // exact re-scan. No global migration artifact exists until this succeeds.
  assertMigrationLegacyLayoutIdle(paths, census);
  const finalPreview = dependencies.adopt({ ...adoptionInput, apply: false }, adoptionDependencies);
  if (finalPreview.status === "dry-run") fail("legacy-v2-adoption-not-completed");
  const finalProof = dependencies.inspectLegacyAdoption(paths.legacyRouterRoot);
  assertLegacyProofMatchesPreview(finalProof, finalPreview);
  preMigrationManifest = scanPrivateTree(paths.legacyRouterRoot);
  const finalSharedSkillsSource = scanLegacySharedSkillsTree(join(paths.legacyDefinitionsRoot, "skills"), paths.sharedSkillsTrustedRoots);
  const finalSharedPluginsSource = scanLegacySharedPlugins(paths.legacyDefinitionsRoot, paths.sharedPluginInventory);
  const finalCapacityReceipt = readSharedHistoryCapacityReceipt(capacityReceiptPath!, paths.legacyRouterRoot);
  if (canonicalJson(finalCapacityReceipt) !== canonicalJson(capacityReceipt)) {
    fail("shared-history-capacity-receipt-changed-during-apply");
  }
  capacityReceipt = finalCapacityReceipt;
  capacity = buildSharedHistoryCapacityPreview({
    paths,
    proof: finalProof,
    routerManifest: preMigrationManifest,
    sharedSkills: finalSharedSkillsSource.manifest,
    sharedPlugins: finalSharedPluginsSource.manifest,
    projectedAt: capacityReceipt.issuedAt,
  });
  assertSharedHistoryCapacityReceipt(
    capacityReceipt,
    capacity,
    paths,
    finalProof,
    preMigrationManifest,
    finalSharedSkillsSource.manifest,
    finalSharedPluginsSource.manifest,
  );
  assertSharedHistoryCapacityWithinBounds(capacity);
  assertGlobalRootAbsent(paths.globalRoot);
  const parent = openMigrationParent(paths.parentRoot);
  let candidate: CandidatePackageScratchAnchor | null = null;
  let journal: SharedHistoryMigrationJournalV2 | null = null;
  try {
    journal = {
      version: SHARED_HISTORY_MIGRATION_JOURNAL_VERSION,
      kind: "shared-history-migration",
      id: paths.transactionId,
      legacyRouterRoot: paths.legacyRouterRoot,
      legacyCodexRoot: paths.legacyCodexRoot,
      legacySqliteRoot: paths.legacySqliteRoot,
      legacyDefinitionsRoot: paths.legacyDefinitionsRoot,
      globalRoot: paths.globalRoot,
      snapshotRoot: paths.snapshotRoot,
      candidateRoot: paths.candidateRoot,
      quarantineRoot: paths.quarantineRoot,
      phase: "journal-prepared",
      preAdoptionManifest: preMigrationManifest,
      preMigrationManifest: null,
      candidateManifest: null,
      canonical: null,
      sharedSkills: null,
      sharedPluginInventoryFingerprint: finalSharedPluginsSource.inventoryFingerprint,
      sharedPluginExclusionsFingerprint: finalSharedPluginsSource.manifest.exclusionsFingerprint,
      sharedPlugins: null,
    };
    writeInitialJournal(paths, journal);
    durableBoundary(paths, journal, "journal-prepared", dependencies);

    journal.preMigrationManifest = preMigrationManifest;
    durableBoundary(paths, journal, "legacy-adoption-complete", dependencies);

    const snapshot = createCandidatePackageScratch(paths.snapshotRoot, parent);
    try {
      copyPrivateTree(paths.legacyRouterRoot, snapshot.path, preMigrationManifest);
      assertTreeManifest(snapshot.path, preMigrationManifest, "pre-migration-snapshot-mismatch");
    } finally {
      closeCandidatePackageScratchAnchor(snapshot);
    }
    durableBoundary(paths, journal, "pre-migration-snapshot-created", dependencies);

    candidate = createCandidatePackageScratch(paths.candidateRoot, parent);
    copyPrivateTree(paths.snapshotRoot, candidate.path, preMigrationManifest);
    assertTreeManifest(candidate.path, preMigrationManifest, "candidate-copy-mismatch");
    durableBoundary(paths, journal, "candidate-copied", dependencies);

    const sharedSkills = materializeSharedSkillsCandidate(
      candidate.path,
      finalSharedSkillsSource,
      finalProof.accountOpaqueIds,
    );
    const sharedPlugins = materializeSharedPluginsCandidate(candidate.path, finalSharedPluginsSource, finalProof.accountOpaqueIds);
    const canonical = materializeCanonicalHistoryCandidate(
      candidate.path,
      paths.snapshotRoot,
      preMigrationManifest,
      finalProof,
      capacityReceipt.issuedAt,
      capacity,
    );
    const candidateManifest = scanPrivateTree(candidate.path, true);
    journal.candidateManifest = candidateManifest;
    journal.canonical = canonical;
    journal.sharedSkills = sharedSkills;
    journal.sharedPlugins = sharedPlugins;
    durableBoundary(paths, journal, "candidate-canonicalized", dependencies);

    assertTreeManifest(paths.snapshotRoot, preMigrationManifest, "pre-migration-snapshot-changed");
    assertTreeManifest(paths.legacyRouterRoot, preMigrationManifest, "legacy-router-root-changed-during-migration");
    assertLegacyDefinitionsRootUnchanged(paths);
    assertLegacySharedSkillsSource(finalSharedSkillsSource.sourceRoot, paths.sharedSkillsTrustedRoots, finalSharedSkillsSource);
    assertLegacySharedPluginsSource(paths.legacyDefinitionsRoot, finalSharedPluginsSource);
    assertLegacyDefinitionsRootUnchanged(paths);
    const preflight = dependencies.preflightCanonicalHistoryStore(candidate.path);
    if (preflight.state !== "ready"
      || preflight.conversationCount !== canonical.conversationCount
      || preflight.segmentCount !== canonical.segmentCount) {
      fail("canonical-history-broker-preflight-failed");
    }
    assertGlobalV3Candidate(candidate.path, finalProof, canonical, preMigrationManifest.fingerprint, sharedSkills, sharedPlugins);
    durableBoundary(paths, journal, "candidate-preflight-ready", dependencies);

    assertMigrationLegacyLayoutIdle(paths, census);
    const publication = publishCandidatePackageExclusively({
      source: candidate,
      destination: paths.globalRoot,
      retentionDestination: paths.quarantineRoot,
      parent,
    });
    if (publication === "destination-exists") {
      const retained = retainCandidatePackageEvidence({ source: candidate, destination: paths.quarantineRoot, parent });
      closeCandidatePackageScratchAnchor(candidate);
      candidate = null;
      if (retained !== "renamed") fail("candidate-collision-quarantine-failed");
      durableBoundary(paths, journal, "collision-quarantined", dependencies);
      return migrationResult(
        "collision-quarantined",
        paths.transactionId,
        preMigrationManifest.fingerprint,
        candidateManifest.fingerprint,
        canonical.conversationCount,
        canonical.segmentCount,
        "inspect-retained-evidence",
        sharedSkills,
        sharedPlugins,
        capacity,
      );
    }
    if (publication !== "renamed") fail("exclusive-global-publication-unverified");
    closeCandidatePackageScratchAnchor(candidate);
    candidate = null;
    assertTreeManifest(paths.globalRoot, candidateManifest, "published-global-root-mismatch", true);
    durableBoundary(paths, journal, "published", dependencies);
    return migrationResult(
      "migrated",
      paths.transactionId,
      preMigrationManifest.fingerprint,
      candidateManifest.fingerprint,
        canonical.conversationCount,
        canonical.segmentCount,
        "activate-remains-user-confirmed",
        sharedSkills,
        sharedPlugins,
        capacity,
    );
  } catch (error) {
    if (error instanceof SharedHistoryMigrationCrash) throw error;
    if (candidate && existsNoFollow(candidate.path)) {
      try {
        const retained = retainCandidatePackageEvidence({ source: candidate, destination: paths.quarantineRoot, parent });
        if (retained === "renamed" && journal) {
          journal.phase = "collision-quarantined";
          writeJournal(paths, journal);
        }
      } catch {
        // The still-held candidate is deliberately left in place as evidence.
      }
    }
    throw redactMigrationFailure(error);
  } finally {
    if (candidate) closeCandidatePackageScratchAnchor(candidate);
    closeCandidatePackageParentAnchor(parent);
  }
}

/**
 * Recover only one exact, caller-bound transaction. Recovery never resumes a
 * migration: it either proves an already-published candidate or retains the
 * unfinished candidate for inspection.
 */
export function recoverSharedHistoryMigration(
  input: SharedHistoryMigrationInput,
  suppliedDependencies: Pick<SharedHistoryMigrationDependencies, "randomId"> = {},
): SharedHistoryMigrationResult {
  const paths = migrationPaths(input, suppliedDependencies.randomId ?? (() => randomUUID()), true);
  const journal = readJournal(paths);
  const parent = openMigrationParent(paths.parentRoot);
  try {
    if (existsNoFollow(paths.globalRoot)) {
      if (journal.candidateManifest && treeMatches(paths.globalRoot, journal.candidateManifest, true)) {
        journal.phase = "published";
        writeJournal(paths, journal);
        return migrationResult(
          "already-published",
          paths.transactionId,
          journal.preMigrationManifest?.fingerprint ?? null,
          journal.candidateManifest.fingerprint,
          journal.canonical?.conversationCount ?? 0,
          journal.canonical?.segmentCount ?? 0,
          "activate-remains-user-confirmed",
          journal.sharedSkills,
          journal.sharedPlugins,
        );
      }
      if (existsNoFollow(paths.candidateRoot)) {
        retainExistingCandidate(paths, parent, journal);
        return migrationResult(
          "collision-quarantined",
          paths.transactionId,
          journal.preMigrationManifest?.fingerprint ?? null,
          journal.candidateManifest?.fingerprint ?? null,
          journal.canonical?.conversationCount ?? 0,
          journal.canonical?.segmentCount ?? 0,
          "inspect-retained-evidence",
          journal.sharedSkills,
          journal.sharedPlugins,
        );
      }
      fail("recovery-global-root-collision");
    }
    if (existsNoFollow(paths.candidateRoot)) {
      retainExistingCandidate(paths, parent, journal);
      return migrationResult(
        "recovered",
        paths.transactionId,
        journal.preMigrationManifest?.fingerprint ?? null,
        journal.candidateManifest?.fingerprint ?? null,
        journal.canonical?.conversationCount ?? 0,
        journal.canonical?.segmentCount ?? 0,
        "inspect-retained-evidence",
        journal.sharedSkills,
        journal.sharedPlugins,
      );
    }
    journal.phase = "recovered";
    writeJournal(paths, journal);
    return migrationResult(
      "recovered",
      paths.transactionId,
      journal.preMigrationManifest?.fingerprint ?? null,
      journal.candidateManifest?.fingerprint ?? null,
      journal.canonical?.conversationCount ?? 0,
      journal.canonical?.segmentCount ?? 0,
      "none",
      journal.sharedSkills,
      journal.sharedPlugins,
    );
  } catch (error) {
    throw redactMigrationFailure(error);
  } finally {
    closeCandidatePackageParentAnchor(parent);
  }
}

/** Strict local mirror of the exported runtime preflight contract. It only reads a private candidate root. */
export function preflightCanonicalHistoryStore(root: string): CanonicalHistoryStorePreflight {
  const unavailable = (state: "missing" | "invalid"): CanonicalHistoryStorePreflight => ({
    version: 1,
    fileName: CANONICAL_HISTORY_FILE,
    state,
    conversationCount: 0,
    segmentCount: 0,
  });
  try {
    assertPrivateDirectory(root, "canonical-history-root");
    const file = join(root, CANONICAL_HISTORY_FILE);
    if (!existsNoFollow(file)) return unavailable("missing");
    const bytes = readPrivateRegularFile(file, CANONICAL_HISTORY_MAX_BYTES_V1, "canonical-history");
    try {
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      const parsed = parseCanonicalHistoryStore(value);
      return {
        version: 1,
        fileName: CANONICAL_HISTORY_FILE,
        state: "ready",
        conversationCount: parsed.conversations.length,
        segmentCount: parsed.conversations.reduce((count, conversation) => count + conversation.segments.length, 0),
      };
    } finally {
      bytes.fill(0);
    }
  } catch {
    return unavailable("invalid");
  }
}

/** Read-only rollback preparation. It never stops a broker, rewrites state, or flattens a legacy SQLite store. */
export function inspectSharedHistoryRollback(globalRoot: string): SharedHistoryRollbackView {
  const preflight = preflightCanonicalHistoryStore(exactAbsolute(globalRoot, "invalid-global-root"));
  if (preflight.state !== "ready") {
    return {
      state: preflight.state,
      canonicalFingerprint: null,
      conversationCount: 0,
      segmentCount: 0,
      requiresBrokerWriteStop: true,
      legacySqliteFlattened: false,
    };
  }
  const bytes = readPrivateRegularFile(join(globalRoot, CANONICAL_HISTORY_FILE), CANONICAL_HISTORY_MAX_BYTES_V1, "canonical-history");
  try {
    return {
      state: "ready",
      canonicalFingerprint: sha256(bytes),
      conversationCount: preflight.conversationCount,
      segmentCount: preflight.segmentCount,
      requiresBrokerWriteStop: true,
      legacySqliteFlattened: false,
    };
  } finally {
    bytes.fill(0);
  }
}

/**
 * Create a portable, read-only canonical-history archive. It copies neither
 * account homes nor SQLite databases, so account-local segments stay explicit
 * in the canonical store and no legacy database is flattened or replaced.
 */
export function exportSharedHistoryRollback(
  input: SharedHistoryRollbackExportInput,
  randomId: () => string = () => randomUUID(),
): SharedHistoryRollbackExportResult {
  const globalRoot = exactAbsolute(input.globalRoot, "invalid-global-root");
  const outputRoot = exactAbsolute(input.outputRoot, "invalid-rollback-output-root");
  const view = inspectSharedHistoryRollback(globalRoot);
  if (view.state !== "ready" || !view.canonicalFingerprint) fail("rollback-export-canonical-history-not-ready");
  const id = validatedTransactionId(input.transactionId ?? randomId());
  assertOutputRootAbsent(outputRoot);
  const parentRoot = dirname(outputRoot);
  const parent = openMigrationParent(parentRoot);
  const scratchPath = join(parentRoot, `.${basename(outputRoot)}.rollback-export-${id}`);
  const failedPath = join(parentRoot, `.${basename(outputRoot)}.rollback-export-failed-${id}`);
  let scratch: CandidatePackageScratchAnchor | null = null;
  try {
    scratch = createCandidatePackageScratch(scratchPath, parent);
    copyOnePrivateFile(join(globalRoot, CANONICAL_HISTORY_FILE), join(scratch.path, CANONICAL_HISTORY_FILE), view.canonicalFingerprint);
    writePrivateJsonNew(join(scratch.path, SHARED_HISTORY_ROLLBACK_VIEWER_FILE), {
      version: 1,
      kind: "shared-history-read-only-viewer",
      canonicalFile: CANONICAL_HISTORY_FILE,
      canonicalFingerprint: view.canonicalFingerprint,
      conversationCount: view.conversationCount,
      segmentCount: view.segmentCount,
      readOnly: true,
      legacySqliteFlattened: false,
    });
    assertRollbackArchiveLayout(scratch.path, view);
    const archiveManifest = scanPrivateTree(scratch.path);
    const publication = publishCandidatePackageExclusively({
      source: scratch,
      destination: outputRoot,
      retentionDestination: failedPath,
      parent,
    });
    if (publication === "destination-exists") {
      const retained = retainCandidatePackageEvidence({ source: scratch, destination: failedPath, parent });
      closeCandidatePackageScratchAnchor(scratch);
      scratch = null;
      if (retained !== "renamed") fail("rollback-export-collision-quarantine-failed");
      return { ...view, status: "collision-quarantined", transactionId: id, archiveFingerprint: archiveManifest.fingerprint };
    }
    if (publication !== "renamed") fail("rollback-export-publication-unverified");
    closeCandidatePackageScratchAnchor(scratch);
    scratch = null;
    assertTreeManifest(outputRoot, archiveManifest, "rollback-export-published-mismatch");
    return { ...view, status: "exported", transactionId: id, archiveFingerprint: archiveManifest.fingerprint };
  } catch (error) {
    if (scratch && existsNoFollow(scratch.path)) {
      try { retainCandidatePackageEvidence({ source: scratch, destination: failedPath, parent }); } catch {}
    }
    throw redactMigrationFailure(error);
  } finally {
    if (scratch) closeCandidatePackageScratchAnchor(scratch);
    closeCandidatePackageParentAnchor(parent);
  }
}

/** No default roots: operators must bind every offline migration to exact paths. */
export interface SharedHistoryMigrationCliOptions {
  apply?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
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
  projectionOutput?: string;
  "projection-output"?: string;
  capacityReceipt?: string;
  "capacity-receipt"?: string;
  transaction?: string;
  output?: string;
}

export interface SharedHistoryMigrationCommandDependencies {
  prepareAdoption?: (
    input: SharedHistoryAdoptionPreparationInput,
    dependencies?: SharedHistoryMigrationDependencies,
  ) => SharedHistoryAdoptionPreparationResult;
  migrate?: (input: SharedHistoryMigrationInput, dependencies?: SharedHistoryMigrationDependencies) => SharedHistoryMigrationResult;
  recover?: (input: SharedHistoryMigrationInput) => SharedHistoryMigrationResult;
  inspectRollback?: (globalRoot: string) => SharedHistoryRollbackView;
  exportRollback?: (input: SharedHistoryRollbackExportInput) => SharedHistoryRollbackExportResult;
  migrationDependencies?: SharedHistoryMigrationDependencies;
  print?: (line: string) => void;
}

/**
 * Explicit installer-owned surface. Runtime startup never reaches it, and
 * there are no live-root defaults hidden behind this command.
 */
export function sharedHistoryMigrationCommand(
  action: string,
  options: SharedHistoryMigrationCliOptions = {},
  dependencies: SharedHistoryMigrationCommandDependencies = {},
): SharedHistoryMigrationResult | SharedHistoryAdoptionPreparationResult | SharedHistoryRollbackView | SharedHistoryRollbackExportResult {
  const normalizedAction = action.trim().toLowerCase();
  const print = dependencies.print ?? console.log;
  if (normalizedAction === "rollback-view") {
    const result = (dependencies.inspectRollback ?? inspectSharedHistoryRollback)(sharedHistoryCliPath(options.globalRoot ?? options["global-root"], "--global-root"));
    print(JSON.stringify(formatSharedHistoryRollbackView(result)));
    return result;
  }
  if (normalizedAction === "export") {
    const result = (dependencies.exportRollback ?? exportSharedHistoryRollback)({
      globalRoot: sharedHistoryCliPath(options.globalRoot ?? options["global-root"], "--global-root"),
      outputRoot: sharedHistoryCliPath(options.output, "--output"),
      ...(options.transaction === undefined ? {} : { transactionId: options.transaction }),
    });
    print(JSON.stringify(formatSharedHistoryRollbackExport(result)));
    return result;
  }
  if (normalizedAction === "prepare-adoption") {
    if (options.apply !== true || options.dryRun === true || options["dry-run"] === true) {
      throw new Error("shared-history-migration prepare-adoption requires --apply");
    }
    const result = (dependencies.prepareAdoption ?? prepareSharedHistoryAdoption)({
      legacyRouterRoot: sharedHistoryCliPath(options.legacyRouterRoot ?? options["legacy-router-root"], "--legacy-router-root"),
      legacyCodexRoot: sharedHistoryCliPath(options.legacyCodexRoot ?? options["legacy-codex-root"], "--legacy-codex-root"),
      legacySqliteRoot: sharedHistoryCliPath(options.legacySqliteRoot ?? options["legacy-sqlite-root"], "--legacy-sqlite-root"),
      appPath: sharedHistoryCliPath(options.app, "--app"),
      tweakersAppPath: sharedHistoryCliPath(options.tweakersApp ?? options["tweakers-app"], "--tweakers-app"),
    }, dependencies.migrationDependencies);
    print(JSON.stringify(formatSharedHistoryAdoptionPreparationResult(result)));
    return result;
  }
  if (normalizedAction !== "preview" && normalizedAction !== "apply" && normalizedAction !== "recover") {
    throw new Error("shared-history-migration action must be prepare-adoption, preview, apply, recover, rollback-view, or export");
  }
  const apply = normalizedAction === "apply" && options.apply === true && options.dryRun !== true && options["dry-run"] !== true;
  const projectionOutput = options.projectionOutput ?? options["projection-output"];
  const capacityReceipt = options.capacityReceipt ?? options["capacity-receipt"];
  if (projectionOutput !== undefined && normalizedAction !== "preview") {
    throw new Error("--projection-output is accepted only by shared-history-migration preview");
  }
  if (capacityReceipt !== undefined && !apply) {
    throw new Error("--capacity-receipt requires shared-history-migration apply --apply");
  }
  const input: SharedHistoryMigrationInput = {
    legacyRouterRoot: sharedHistoryCliPath(options.legacyRouterRoot ?? options["legacy-router-root"], "--legacy-router-root"),
    legacyCodexRoot: sharedHistoryCliPath(options.legacyCodexRoot ?? options["legacy-codex-root"], "--legacy-codex-root"),
    legacySqliteRoot: sharedHistoryCliPath(options.legacySqliteRoot ?? options["legacy-sqlite-root"], "--legacy-sqlite-root"),
    ...((options.legacyDefinitionsRoot ?? options["legacy-definitions-root"]) === undefined
      ? {}
      : { legacyDefinitionsRoot: sharedHistoryCliPath(options.legacyDefinitionsRoot ?? options["legacy-definitions-root"], "--legacy-definitions-root") }),
    globalRoot: sharedHistoryCliPath(options.globalRoot ?? options["global-root"], "--global-root"),
    appPath: sharedHistoryCliPath(options.app, "--app"),
    tweakersAppPath: sharedHistoryCliPath(options.tweakersApp ?? options["tweakers-app"], "--tweakers-app"),
    sharedSkillsRoots: sharedHistoryCliPaths(options.sharedSkillsRoot ?? options["shared-skills-root"], "--shared-skills-root"),
    sharedPluginInventory: sharedHistoryCliPath(options.sharedPluginInventory ?? options["shared-plugin-inventory"], "--shared-plugin-inventory"),
    apply,
    ...(projectionOutput === undefined ? {} : { projectionOutputRoot: sharedHistoryCliPath(projectionOutput, "--projection-output") }),
    ...(apply ? { capacityReceiptPath: sharedHistoryCliPath(capacityReceipt, "--capacity-receipt") } : {}),
    ...(options.transaction === undefined ? {} : { transactionId: options.transaction }),
  };
  if (normalizedAction === "recover") {
    if (options.transaction === undefined) throw new Error("shared-history-migration recover requires --transaction");
    const result = (dependencies.recover ?? recoverSharedHistoryMigration)(input);
    print(JSON.stringify(formatSharedHistoryMigrationResult(result)));
    return result;
  }
  const result = (dependencies.migrate ?? migrateSharedHistoryV2ToGlobalV3)(input, dependencies.migrationDependencies);
  print(JSON.stringify(formatSharedHistoryMigrationResult(result)));
  return result;
}

export function formatSharedHistoryAdoptionPreparationResult(
  result: SharedHistoryAdoptionPreparationResult,
): Record<string, unknown> {
  return {
    state: result.status,
    adoptionReceiptFingerprint: result.adoptionReceiptFingerprint,
    importedThreadCount: result.importedThreadCount,
    nextAction: result.nextAction,
  };
}

function sharedHistoryCliPath(value: string | undefined, option: string): string {
  if (typeof value !== "string" || value.trim() !== value || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    throw new Error(`${option} must be an exact absolute path`);
  }
  return value;
}

function sharedHistoryCliPaths(value: string | readonly string[] | undefined, option: string): readonly string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  if (values.length === 0) throw new Error(`${option} must be supplied at least once`);
  return values.map((entry) => sharedHistoryCliPath(entry, option));
}

export function formatSharedHistoryMigrationResult(result: SharedHistoryMigrationResult): Record<string, unknown> {
  return {
    state: result.status,
    transactionId: result.transactionId,
    sourceFingerprint: result.sourceFingerprint,
    candidateFingerprint: result.candidateFingerprint,
    conversationCount: result.conversationCount,
    segmentCount: result.segmentCount,
    sharedSkillsFingerprint: result.sharedSkillsFingerprint,
    sharedSkillsTrustedRoots: result.sharedSkillsTrustedRoots,
    sharedSkillsTrustedRootsFingerprint: result.sharedSkillsTrustedRootsFingerprint,
    sharedPluginsFingerprint: result.sharedPluginsFingerprint,
    sharedPluginInventoryFingerprint: result.sharedPluginInventoryFingerprint,
    sharedPluginExclusionsFingerprint: result.sharedPluginExclusionsFingerprint,
    sharedPluginIds: result.sharedPluginIds,
    sharedPluginPackages: result.sharedPluginPackages,
    capacity: result.capacity,
    nextAction: result.nextAction,
  };
}

export function formatSharedHistoryRollbackView(result: SharedHistoryRollbackView): Record<string, unknown> {
  return {
    state: result.state,
    canonicalFingerprint: result.canonicalFingerprint,
    conversationCount: result.conversationCount,
    segmentCount: result.segmentCount,
    requiresBrokerWriteStop: result.requiresBrokerWriteStop,
    legacySqliteFlattened: result.legacySqliteFlattened,
  };
}

export function formatSharedHistoryRollbackExport(result: SharedHistoryRollbackExportResult): Record<string, unknown> {
  return {
    ...formatSharedHistoryRollbackView(result),
    state: result.status,
    transactionId: result.transactionId,
    archiveFingerprint: result.archiveFingerprint,
  };
}

function migrationDependencies(input: SharedHistoryMigrationDependencies): Required<Pick<
  SharedHistoryMigrationDependencies,
  "adopt" | "inspectLegacyAdoption" | "initializeLegacyAdoption" | "preflightCanonicalHistoryStore" | "now" | "randomId" | "census"
>> & SharedHistoryMigrationDependencies {
  return {
    ...input,
    adopt: input.adopt ?? adoptAccountHistory,
    inspectLegacyAdoption: input.inspectLegacyAdoption ?? inspectCompletedLegacyV2HistoryAdoption,
    initializeLegacyAdoption: input.initializeLegacyAdoption ?? initializeMissingLegacyV2HistoryAdoption,
    preflightCanonicalHistoryStore: input.preflightCanonicalHistoryStore ?? preflightCanonicalHistoryStore,
    now: input.now ?? (() => new Date().toISOString()),
    randomId: input.randomId ?? (() => randomUUID()),
    census: input.census ?? input.adoptionDependencies?.census ?? observeHistoryAdoptionCensus,
  };
}

function sharedHistoryInitializationPhase(
  phase: HistoryAdoptionInitializationPhase,
): SharedHistoryMigrationPhase {
  switch (phase) {
    case "initialization-journal-prepared":
      return "legacy-adoption-initialization-journal-prepared";
    case "initialization-intent-published":
      return "legacy-adoption-initialization-intent-published";
    case "initialization-router-state-published":
      return "legacy-adoption-initialization-router-state-published";
    case "initialization-complete":
      return "legacy-adoption-initialization-complete";
  }
}

function migrationPaths(
  input: SharedHistoryMigrationInput,
  randomId: () => string,
  requireTransactionId = false,
): MigrationPaths {
  const legacyRouterRoot = exactAbsolute(input.legacyRouterRoot, "invalid-legacy-router-root");
  const legacyCodexRoot = exactAbsolute(input.legacyCodexRoot, "invalid-legacy-codex-root");
  const legacySqliteRoot = exactAbsolute(input.legacySqliteRoot, "invalid-legacy-sqlite-root");
  const legacyDefinitionsRoot = exactAbsolute(
    input.legacyDefinitionsRoot ?? legacyCodexRoot,
    "invalid-legacy-definitions-root",
  );
  const globalRoot = exactAbsolute(input.globalRoot, "invalid-global-root");
  const appPath = exactAbsolute(input.appPath, "invalid-app-path");
  const tweakersAppPath = exactAbsolute(input.tweakersAppPath, "invalid-tweakers-app-path");
  const sharedSkillsTrustedRoots = normalizeSharedSkillsTrustedRoots(input.sharedSkillsRoots);
  const sharedPluginInventory = canonicalPrivateSharedPluginInventory(input.sharedPluginInventory);
  // Parse before any migration state is created. This also refuses symlinks,
  // loose modes, aliases, duplicate IDs, and malformed inventory receipts.
  readSharedPluginInventory(sharedPluginInventory);
  if (appPath === tweakersAppPath) fail("duplicate-desktop-app-path");
  const suppliedId = input.transactionId;
  if (requireTransactionId && suppliedId === undefined) fail("migration-recovery-requires-transaction-id");
  const transactionId = validatedTransactionId(suppliedId ?? randomId());
  const parentRoot = dirname(globalRoot);
  if (!basename(globalRoot) || basename(globalRoot) === "." || basename(globalRoot) === "..") fail("invalid-global-root");
  const routerProjection = projectCandidatePackagePath(legacyRouterRoot, "legacy v2 router root");
  const codexProjection = projectCandidatePackagePath(legacyCodexRoot, "legacy CODEX_HOME source root");
  const sqliteProjection = projectCandidatePackagePath(legacySqliteRoot, "legacy CODEX_SQLITE_HOME source root");
  const definitionsProjection = projectCandidatePackagePath(legacyDefinitionsRoot, "legacy definitions source root");
  const destinationProjection = projectCandidatePackagePath(globalRoot, "global v3 broker root");
  const definitionsStat = assertCandidatePackageExistingDirectory(definitionsProjection, "legacy definitions source root");
  assertOwnerControlledDirectory(legacyDefinitionsRoot, "legacy-definitions-root");
  const legacyDefinitionsRootIdentity: LegacyDefinitionsRootIdentity = {
    path: legacyDefinitionsRoot,
    device: definitionsStat.dev,
    inode: definitionsStat.ino,
    uid: definitionsStat.uid,
    mode: definitionsStat.mode & 0o777,
  };
  assertCandidatePackagePathsDisjoint(routerProjection, codexProjection, "legacy v2 router root", "legacy CODEX_HOME source root");
  assertCandidatePackagePathsDisjoint(routerProjection, sqliteProjection, "legacy v2 router root", "legacy CODEX_SQLITE_HOME source root");
  assertLegacySourcesDisjointOrExactlyShared(codexProjection, sqliteProjection);
  assertCandidatePackagePathsDisjoint(routerProjection, destinationProjection, "legacy v2 router root", "global v3 broker root");
  assertCandidatePackagePathsDisjoint(codexProjection, destinationProjection, "legacy CODEX_HOME source root", "global v3 broker root");
  assertCandidatePackagePathsDisjoint(sqliteProjection, destinationProjection, "legacy CODEX_SQLITE_HOME source root", "global v3 broker root");
  assertCandidatePackagePathsDisjoint(definitionsProjection, destinationProjection, "legacy definitions source root", "global v3 broker root");
  const base = basename(globalRoot);
  const journalPath = join(parentRoot, `.${base}.shared-history-migration-${transactionId}.json`);
  const journalStagingPath = join(parentRoot, `.${base}.shared-history-migration-${transactionId}.json.tmp`);
  const snapshotRoot = join(parentRoot, `.${base}.shared-history-pre-migration-${transactionId}`);
  const candidateRoot = join(parentRoot, `.${base}.shared-history-candidate-${transactionId}`);
  const quarantineRoot = join(parentRoot, `.${base}.shared-history-quarantine-${transactionId}`);
  for (const [artifactPath, label] of [
    [journalPath, "shared-history migration journal"],
    [journalStagingPath, "shared-history migration journal staging"],
    [snapshotRoot, "shared-history pre-migration snapshot"],
    [candidateRoot, "shared-history candidate"],
    [quarantineRoot, "shared-history quarantine"],
  ] as const) {
    assertCandidatePackagePathsDisjoint(
      definitionsProjection,
      projectCandidatePackagePath(artifactPath, label),
      "legacy definitions source root",
      label,
    );
  }
  return {
    legacyRouterRoot,
    legacyCodexRoot,
    legacySqliteRoot,
    legacyDefinitionsRoot,
    legacyDefinitionsRootIdentity,
    globalRoot,
    appPath,
    tweakersAppPath,
    sharedSkillsTrustedRoots,
    sharedPluginInventory,
    parentRoot,
    transactionId,
    journalPath,
    journalStagingPath,
    snapshotRoot,
    candidateRoot,
    quarantineRoot,
  };
}

/**
 * The persisted receipt is a mutable external input to apply.  It must stay
 * outside every copied, scanned, or publication path so its own identity can
 * be protected by the dual-desktop zero-writer census without changing a
 * source manifest or becoming part of the candidate.
 */
function assertSharedHistoryCapacityReceiptPathDisjoint(
  paths: MigrationPaths,
  capacityReceiptPath: string,
): void {
  const receipt = projectCandidatePackagePath(capacityReceiptPath, "shared-history capacity receipt");
  for (const [projection, label] of [
    [projectCandidatePackagePath(paths.legacyRouterRoot, "legacy v2 router root"), "legacy v2 router root"],
    [projectCandidatePackagePath(paths.legacyCodexRoot, "legacy CODEX_HOME source root"), "legacy CODEX_HOME source root"],
    [projectCandidatePackagePath(paths.legacySqliteRoot, "legacy CODEX_SQLITE_HOME source root"), "legacy CODEX_SQLITE_HOME source root"],
    [projectCandidatePackagePath(paths.legacyDefinitionsRoot, "legacy definitions source root"), "legacy definitions source root"],
    [projectCandidatePackagePath(paths.globalRoot, "global v3 broker root"), "global v3 broker root"],
    [projectCandidatePackagePath(paths.sharedPluginInventory, "shared plugin inventory"), "shared plugin inventory"],
    [projectCandidatePackagePath(paths.journalPath, "shared-history migration journal"), "shared-history migration journal"],
    [projectCandidatePackagePath(paths.journalStagingPath, "shared-history migration journal staging"), "shared-history migration journal staging"],
    [projectCandidatePackagePath(paths.snapshotRoot, "shared-history pre-migration snapshot"), "shared-history pre-migration snapshot"],
    [projectCandidatePackagePath(paths.candidateRoot, "shared-history candidate"), "shared-history candidate"],
    [projectCandidatePackagePath(paths.quarantineRoot, "shared-history quarantine"), "shared-history quarantine"],
    ...paths.sharedSkillsTrustedRoots.map((root) => [
      projectCandidatePackagePath(root.path, "shared Skills trusted root"),
      "shared Skills trusted root",
    ] as const),
  ] as const) {
    assertCandidatePackagePathsDisjoint(receipt, projection, "shared-history capacity receipt", label);
  }
}

function sharedHistoryAdoptionPreparationPaths(
  input: SharedHistoryAdoptionPreparationInput,
): SharedHistoryAdoptionPreparationPaths {
  const legacyRouterRoot = exactAbsolute(input.legacyRouterRoot, "invalid-legacy-router-root");
  const legacyCodexRoot = exactAbsolute(input.legacyCodexRoot, "invalid-legacy-codex-root");
  const legacySqliteRoot = exactAbsolute(input.legacySqliteRoot, "invalid-legacy-sqlite-root");
  const appPath = exactAbsolute(input.appPath, "invalid-app-path");
  const tweakersAppPath = exactAbsolute(input.tweakersAppPath, "invalid-tweakers-app-path");
  if (appPath === tweakersAppPath) fail("duplicate-desktop-app-path");
  const routerProjection = projectCandidatePackagePath(legacyRouterRoot, "legacy v2 router root");
  const codexProjection = projectCandidatePackagePath(legacyCodexRoot, "legacy CODEX_HOME source root");
  const sqliteProjection = projectCandidatePackagePath(legacySqliteRoot, "legacy CODEX_SQLITE_HOME source root");
  assertCandidatePackageExistingDirectory(routerProjection, "legacy v2 router root");
  assertCandidatePackageExistingDirectory(codexProjection, "legacy CODEX_HOME source root");
  assertCandidatePackageExistingDirectory(sqliteProjection, "legacy CODEX_SQLITE_HOME source root");
  assertCandidatePackagePathsDisjoint(routerProjection, codexProjection, "legacy v2 router root", "legacy CODEX_HOME source root");
  assertCandidatePackagePathsDisjoint(routerProjection, sqliteProjection, "legacy v2 router root", "legacy CODEX_SQLITE_HOME source root");
  assertLegacySourcesDisjointOrExactlyShared(codexProjection, sqliteProjection);
  return { legacyRouterRoot, legacyCodexRoot, legacySqliteRoot, appPath, tweakersAppPath };
}

/**
 * Operator declarations are intentionally exact physical directories rather
 * than prefixes resolved later. The identity is sealed into the manifest so a
 * later receipt can show precisely which external source trees were allowed.
 */
function normalizeSharedSkillsTrustedRoots(value: readonly string[]): readonly SharedSkillsTrustedRootV1[] {
  if (!Array.isArray(value)) fail("invalid-shared-skills-trusted-roots");
  const roots: SharedSkillsTrustedRootV1[] = [];
  for (const raw of value) {
    const path = exactAbsolute(raw, "invalid-shared-skills-trusted-root");
    let canonical: string;
    try {
      canonical = realpathSync.native(path);
    } catch {
      fail("invalid-shared-skills-trusted-root");
    }
    // The option itself must name the canonical directory, never an alias or
    // an externally controlled link that happens to resolve to one.
    if (canonical !== path) fail("invalid-shared-skills-trusted-root");
    const stat = lstatNoFollow(path, "shared-skills-trusted-root");
    assertSharedSkillsDirectory(stat, "shared-skills-trusted-root", false);
    roots.push({ path, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 });
  }
  roots.sort((left, right) => compareCodeUnits(left.path, right.path));
  if (roots.length > 128 || new Set(roots.map((root) => root.path)).size !== roots.length) {
    fail("invalid-shared-skills-trusted-roots");
  }
  return roots;
}

/**
 * Old installations sometimes kept the allowlisted rollout files and SQLite
 * databases in one private root.  That is safe only when both caller values
 * are the same exact, existing canonical directory.  All aliases, nesting,
 * and every other pair still use the normal disjointness oracle.
 */
function assertLegacySourcesDisjointOrExactlyShared(
  codex: ReturnType<typeof projectCandidatePackagePath>,
  sqlite: ReturnType<typeof projectCandidatePackagePath>,
): void {
  const exactlyShared = codex.path === sqlite.path
    && codex.unresolvedTail.length === 0
    && sqlite.unresolvedTail.length === 0
    && codex.physicalPath === sqlite.physicalPath
    && codex.finalIdentity !== null
    && sqlite.finalIdentity !== null
    && codex.finalIdentity.dev === sqlite.finalIdentity.dev
    && codex.finalIdentity.ino === sqlite.finalIdentity.ino;
  if (exactlyShared) {
    assertCandidatePackageExistingDirectory(codex, "shared legacy CODEX/SQLite source root");
    return;
  }
  assertCandidatePackagePathsDisjoint(codex, sqlite, "legacy CODEX_HOME source root", "legacy CODEX_SQLITE_HOME source root");
}

function legacyAdoptionInput(
  paths: Pick<MigrationPaths | SharedHistoryAdoptionPreparationPaths,
    "legacyCodexRoot" | "legacySqliteRoot" | "legacyRouterRoot" | "appPath">,
): AdoptAccountHistoryInput {
  return {
    sourceCodexRoot: paths.legacyCodexRoot,
    sourceSqliteRoot: paths.legacySqliteRoot,
    routerRoot: paths.legacyRouterRoot,
    appPath: paths.appPath,
    requireLegacyV2: true,
  };
}

/**
 * Preserve the adoption census's exact root set, while making the migration
 * independently enforce it even after adoption has returned an existing
 * receipt. The observer is read-only and every malformed/failed observation
 * fails closed before a mutable migration boundary.
 */
function assertMigrationLegacyLayoutIdle(
  paths: MigrationPaths,
  census: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus,
): void {
  let observed: HistoryAdoptionCensus;
  try {
    observed = census(historyAdoptionCensusInput(legacyAdoptionInput(paths)));
  } catch {
    fail("migration-legacy-layout-not-idle");
  }
  if (!isHistoryAdoptionIdleCensus(observed)) fail("migration-legacy-layout-not-idle");
}

function assertLegacyDefinitionsRootUnchanged(paths: MigrationPaths): void {
  assertOwnerControlledDirectory(paths.legacyDefinitionsRoot, "legacy-definitions-root");
  const stat = lstatNoFollow(paths.legacyDefinitionsRoot, "legacy-definitions-root");
  const expected = paths.legacyDefinitionsRootIdentity;
  if (stat.dev !== expected.device
    || stat.ino !== expected.inode
    || stat.uid !== expected.uid
    || (stat.mode & 0o777) !== expected.mode) {
    fail("legacy-definitions-root-changed-during-migration");
  }
}

/**
 * v2 adoption intentionally retains its one-path public input. The migration
 * composes that exact census with a separate exact Tweakers path so every
 * initialization, adoption, and publication boundary fails closed unless both
 * desktop paths are independently observed idle over the same protected roots.
 */
function dualDesktopMigrationCensus(
  observe: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus,
  primaryAppPath: string,
  tweakersAppPath: string,
  extraProtectedPaths: readonly string[] = [],
): (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus {
  return (input) => {
    if (input.appPath !== primaryAppPath) return unknownDualDesktopCensus();
    const protectedPaths = [...input.protectedPaths, ...extraProtectedPaths]
      .filter((path, index, values) => values.indexOf(path) === index);
    const primary = observe({ ...input, protectedPaths });
    const tweakers = observe({ ...input, appPath: tweakersAppPath, protectedPaths });
    if (!isHistoryAdoptionIdleCensus(primary)) return primary;
    if (!isHistoryAdoptionIdleCensus(tweakers)) return tweakers;
    return primary;
  };
}

function unknownDualDesktopCensus(): HistoryAdoptionCensus {
  return {
    app: "unknown",
    main: "unknown",
    appServer: "unknown",
    openFileCount: -1,
    observedAt: new Date().toISOString(),
  };
}

function migrationResult(
  status: SharedHistoryMigrationResult["status"],
  transactionId: string | null,
  sourceFingerprint: Sha256Fingerprint | null,
  candidateFingerprint: Sha256Fingerprint | null,
  conversationCount: number,
  segmentCount: number,
  nextAction: SharedHistoryMigrationResult["nextAction"],
  sharedSkills: SharedSkillsManifestV1 | null = null,
  sharedPlugins: SharedPluginsManifestV1 | null = null,
  capacity: SharedHistoryCapacityPreviewV1 | null = null,
): SharedHistoryMigrationResult {
  return {
    status,
    transactionId,
    sourceFingerprint,
    candidateFingerprint,
    conversationCount,
    segmentCount,
    sharedSkillsFingerprint: sharedSkills?.fingerprint ?? null,
    sharedSkillsTrustedRoots: sharedSkills?.trustedRoots.map((root) => root.path) ?? [],
    sharedSkillsTrustedRootsFingerprint: sharedSkills?.trustedRootsFingerprint ?? null,
    sharedPluginsFingerprint: sharedPlugins?.fingerprint ?? null,
    sharedPluginInventoryFingerprint: sharedPlugins?.inventoryFingerprint ?? null,
    sharedPluginExclusionsFingerprint: sharedPlugins?.exclusionsFingerprint ?? null,
    sharedPluginIds: sharedPlugins?.packages.map((entry) => entry.pluginId) ?? [],
    sharedPluginPackages: sharedPlugins?.packages.map((entry) => ({ pluginId: entry.pluginId, version: entry.version })) ?? [],
    capacity,
    nextAction,
  };
}

interface SharedHistoryCapacityPreviewBuildInput {
  paths: MigrationPaths;
  proof: CompletedLegacyV2HistoryAdoptionProof;
  routerManifest: TreeManifest;
  sharedSkills: SharedSkillsManifestV1;
  sharedPlugins: SharedPluginsManifestV1;
  projectedAt: string;
}

function canonicalCapacityTimestamp(value: string): string {
  if (!isCanonicalUtcTimestamp(value)) fail("invalid-shared-history-migration-clock");
  return value;
}

function sharedHistoryCapacityLimits(): SharedHistoryCapacityLimitsV1 {
  return {
    snapshotBytes: CANONICAL_HISTORY_MAX_BYTES_V1,
    journalBytes: CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1,
    conversations: CANONICAL_HISTORY_MAX_CONVERSATIONS_V1,
    sourceEvidenceBytes: CANONICAL_HISTORY_MIGRATION_EVIDENCE_MAX_BYTES_V1,
  };
}

/**
 * Read-only capacity calculation. It invokes the exact same pure canonical
 * projection later materialized into the candidate; it never creates a root,
 * journal, snapshot, or candidate.
 */
function buildSharedHistoryCapacityPreview(input: SharedHistoryCapacityPreviewBuildInput): SharedHistoryCapacityPreviewV1 {
  const projected = projectCanonicalHistory(
    input.paths.legacyRouterRoot,
    input.routerManifest,
    input.proof,
    canonicalCapacityTimestamp(input.projectedAt),
  );
  try {
    const caps = sharedHistoryCapacityLimits();
    const counts: SharedHistoryCapacityCountsV1 = {
      conversations: projected.store.conversations.length,
      segments: projected.store.conversations.reduce((sum, conversation) => sum + conversation.segments.length, 0),
      turns: projected.store.conversations.reduce((sum, conversation) => sum + conversation.segments.reduce((turns, segment) => turns + segment.turns.length, 0), 0),
      fullConversations: projected.store.conversations.filter((conversation) => conversation.availability === "complete").length,
      partialConversations: projected.store.conversations.filter((conversation) => conversation.availability === "partial").length,
    };
    const projection: SharedHistoryCapacityProjectionBindingV1 = {
      snapshot: { bytes: projected.snapshotBytes.byteLength, sha256: sha256(projected.snapshotBytes) },
      journal: { bytes: projected.journalBytes.byteLength, sha256: sha256(projected.journalBytes) },
      sourceEvidence: { bytes: projected.sourceEvidenceBytes.byteLength, sha256: sha256(projected.sourceEvidenceBytes) },
    };
    const margins: SharedHistoryCapacityMarginsV1 = {
      snapshotBytes: caps.snapshotBytes - projection.snapshot.bytes,
      journalBytes: caps.journalBytes - projection.journal.bytes,
      conversations: caps.conversations - counts.conversations,
      sourceEvidenceBytes: caps.sourceEvidenceBytes - projection.sourceEvidence.bytes,
    };
    return {
      version: 1,
      withinCapacity: Object.values(margins).every((margin) => margin >= 0),
      caps,
      projection,
      counts,
      margins,
      receiptFingerprint: null,
      reviewOutput: null,
    };
  } finally {
    projected.dispose();
  }
}

/**
 * Persist only an operator-requested review package. This is intentionally
 * outside every legacy root and contains the byte-for-byte runtime snapshot
 * plus the HMAC receipt; it never creates a migration journal or v3 root.
 */
function writeSharedHistoryCapacityReviewOutput(
  outputRootValue: string,
  capacity: SharedHistoryCapacityPreviewV1,
  receipt: SharedHistoryCapacityReceiptV1,
  paths: MigrationPaths,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  routerManifest: TreeManifest,
  randomId: () => string,
): void {
  const outputRoot = exactAbsolute(outputRootValue, "invalid-shared-history-capacity-review-output");
  if (existsNoFollow(outputRoot)) fail("shared-history-capacity-review-output-already-exists");
  const outputProjection = projectCandidatePackagePath(outputRoot, "shared-history capacity review output");
  for (const [projection, label] of [
    [projectCandidatePackagePath(paths.legacyRouterRoot, "legacy v2 router root"), "legacy v2 router root"],
    [projectCandidatePackagePath(paths.legacyCodexRoot, "legacy CODEX_HOME source root"), "legacy CODEX_HOME source root"],
    [projectCandidatePackagePath(paths.legacySqliteRoot, "legacy CODEX_SQLITE_HOME source root"), "legacy CODEX_SQLITE_HOME source root"],
    [projectCandidatePackagePath(paths.legacyDefinitionsRoot, "legacy definitions source root"), "legacy definitions source root"],
    [projectCandidatePackagePath(paths.globalRoot, "global v3 broker root"), "global v3 broker root"],
    [projectCandidatePackagePath(paths.sharedPluginInventory, "shared plugin inventory"), "shared plugin inventory"],
    ...paths.sharedSkillsTrustedRoots.map((root) => [
      projectCandidatePackagePath(root.path, "shared Skills trusted root"),
      "shared Skills trusted root",
    ] as const),
  ] as const) {
    assertCandidatePackagePathsDisjoint(outputProjection, projection, "shared-history capacity review output", label);
  }
  const parentRoot = dirname(outputRoot);
  const parent = openCandidatePackageParentAnchor(
    projectCandidatePackagePath(parentRoot, "shared-history capacity review output parent"),
    "shared-history capacity review output parent",
  );
  const id = validatedTransactionId(randomId());
  const base = basename(outputRoot);
  const scratchPath = join(parentRoot, `.${base}.shared-history-capacity-review-${id}`);
  const conflictPath = join(parentRoot, `.${base}.shared-history-capacity-review-conflict-${id}`);
  let scratch: CandidatePackageScratchAnchor | null = null;
  let projected: CanonicalHistoryProjectionV1 | null = null;
  let receiptBytes: Buffer | null = null;
  try {
    projected = projectCanonicalHistory(paths.legacyRouterRoot, routerManifest, proof, receipt.issuedAt);
    assertCanonicalProjectionMatchesCapacity(projected, capacity);
    assertSharedHistoryCapacityWithinBounds(capacity);
    receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
    if (receiptBytes.byteLength > MAX_SHARED_HISTORY_CAPACITY_RECEIPT_BYTES) {
      fail("shared-history-capacity-receipt-capacity-exceeded");
    }
    scratch = createCandidatePackageScratch(scratchPath, parent);
    writePrivateFileNew(
      join(scratch.path, SHARED_HISTORY_CAPACITY_PROJECTION_FILE),
      projected.snapshotBytes,
      "shared-history-capacity-projection",
    );
    writePrivateFileNew(
      join(scratch.path, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
      receiptBytes,
      "shared-history-capacity-receipt",
    );
    fsyncDirectory(scratch.path);
    assertSharedHistoryCapacityReviewOutput(scratch.path, capacity, receipt);
    const publication = publishCandidatePackageExclusively({ source: scratch, destination: outputRoot, parent });
    if (publication === "destination-exists") {
      const retained = retainCandidatePackageEvidence({ source: scratch, destination: conflictPath, parent });
      closeCandidatePackageScratchAnchor(scratch);
      scratch = null;
      if (retained !== "renamed") fail("shared-history-capacity-review-output-collision-quarantine-failed");
      fail("shared-history-capacity-review-output-already-exists");
    }
    if (publication !== "renamed") fail("shared-history-capacity-review-output-publication-unverified");
    closeCandidatePackageScratchAnchor(scratch);
    scratch = null;
    assertSharedHistoryCapacityReviewOutput(outputRoot, capacity, receipt);
  } catch (error) {
    if (scratch && existsNoFollow(scratch.path)) {
      try { retainCandidatePackageEvidence({ source: scratch, destination: conflictPath, parent }); } catch {}
    }
    throw error;
  } finally {
    if (scratch) closeCandidatePackageScratchAnchor(scratch);
    receiptBytes?.fill(0);
    projected?.dispose();
    closeCandidatePackageParentAnchor(parent);
  }
}

function assertSharedHistoryCapacityReviewOutput(
  root: string,
  capacity: SharedHistoryCapacityPreviewV1,
  receipt: SharedHistoryCapacityReceiptV1,
): void {
  assertPrivateDirectory(root, "shared-history-capacity-review-output");
  const names = readdirNoFollow(root, "shared-history-capacity-review-output");
  if (canonicalJson(names) !== canonicalJson([
    SHARED_HISTORY_CAPACITY_PROJECTION_FILE,
    SHARED_HISTORY_CAPACITY_RECEIPT_FILE,
  ].sort(compareCodeUnits))) {
    fail("invalid-shared-history-capacity-review-output");
  }
  const projectionPath = join(root, SHARED_HISTORY_CAPACITY_PROJECTION_FILE);
  const projectionBytes = readPrivateRegularFile(
    projectionPath,
    CANONICAL_HISTORY_MAX_BYTES_V1,
    "shared-history-capacity-projection",
  );
  const receiptPath = join(root, SHARED_HISTORY_CAPACITY_RECEIPT_FILE);
  const receiptBytes = readPrivateRegularFile(
    receiptPath,
    MAX_SHARED_HISTORY_CAPACITY_RECEIPT_BYTES,
    "shared-history-capacity-receipt",
  );
  try {
    if (projectionBytes.byteLength !== capacity.projection.snapshot.bytes
      || sha256(projectionBytes) !== capacity.projection.snapshot.sha256) {
      fail("shared-history-capacity-review-projection-mismatch");
    }
    const projection = parseCanonicalHistoryStore(JSON.parse(projectionBytes.toString("utf8")) as unknown);
    const normalizedBytes = runtimeCanonicalJsonBytes(projection);
    try {
      if (!normalizedBytes.equals(projectionBytes)) fail("shared-history-capacity-review-projection-format-mismatch");
    } finally {
      normalizedBytes.fill(0);
    }
    const expectedReceiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
    try {
      if (!expectedReceiptBytes.equals(receiptBytes)) fail("shared-history-capacity-review-receipt-mismatch");
    } finally {
      expectedReceiptBytes.fill(0);
    }
  } catch (error) {
    if (error instanceof SharedHistoryMigrationFailure) throw error;
    fail("invalid-shared-history-capacity-review-output");
  } finally {
    projectionBytes.fill(0);
    receiptBytes.fill(0);
  }
}

function assertSharedHistoryCapacityWithinBounds(capacity: SharedHistoryCapacityPreviewV1): void {
  if (!capacity.withinCapacity) fail("canonical-history-capacity-exceeded");
}

function capacityProofBinding(proof: CompletedLegacyV2HistoryAdoptionProof): SharedHistoryCapacityProofBindingV1 {
  return {
    configFingerprint: proof.configFingerprint,
    protocolFingerprint: proof.intent.protocolFingerprint,
    poolFingerprint: proof.poolFingerprint,
    intentFingerprint: historyAdoptionIntentFingerprint(proof.intent),
    adoptionReceiptFingerprint: historyAdoptionReceiptFingerprint(proof.receipt),
    sourceFingerprint: proof.receipt.sourceFingerprint,
    destinationFingerprint: proof.receipt.destinationFingerprint,
    ownersFingerprint: proof.owners.threadOwnersFingerprint,
    aliasesFingerprint: proof.aliases === null ? null : canonicalSha256Fingerprint(proof.aliases),
  };
}

function capacitySourceBinding(
  routerManifest: TreeManifest,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  sharedSkills: SharedSkillsManifestV1,
  sharedPlugins: SharedPluginsManifestV1,
  paths: Pick<MigrationPaths, "legacyDefinitionsRoot">,
): SharedHistoryCapacitySourceBindingV1 {
  return {
    routerManifestFingerprint: routerManifest.fingerprint,
    sourceDatabaseManifestFingerprint: canonicalSha256Fingerprint({
      sourceFingerprint: proof.receipt.sourceFingerprint,
      databases: proof.receipt.databases,
      histories: proof.receipt.histories,
    }),
    normalizedSourceDatabaseManifestFingerprint: canonicalSha256Fingerprint({
      destinationFingerprint: proof.receipt.destinationFingerprint,
      databases: proof.receipt.databases,
      histories: proof.receipt.histories,
    }),
    sharedSkillsManifestFingerprint: sharedSkills.fingerprint,
    sharedPluginsManifestFingerprint: sharedPlugins.fingerprint,
    definitionsRoot: sharedHistoryCapacityReceiptRootBinding(paths.legacyDefinitionsRoot, "legacy-definitions-root"),
  };
}

function createSharedHistoryCapacityReceipt(input: Omit<SharedHistoryCapacityPreviewBuildInput, "projectedAt"> & {
  capacity: SharedHistoryCapacityPreviewV1;
  issuedAt: string;
}): SharedHistoryCapacityReceiptV1 {
  const issuedAt = canonicalCapacityTimestamp(input.issuedAt);
  assertSharedHistoryCapacityWithinBounds(input.capacity);
  const unsigned: Omit<SharedHistoryCapacityReceiptV1, "hmac"> = {
    version: 1,
    kind: "shared-history-capacity-receipt",
    proof: capacityProofBinding(input.proof),
    sources: capacitySourceBinding(input.routerManifest, input.proof, input.sharedSkills, input.sharedPlugins, input.paths),
    caps: input.capacity.caps,
    projection: input.capacity.projection,
    counts: input.capacity.counts,
    margins: input.capacity.margins,
    issuedAt,
  };
  const secret = readSharedHistoryCapacitySecret(input.paths.legacyRouterRoot);
  try {
    return { ...unsigned, hmac: sharedHistoryCapacityHmac(secret, unsigned) };
  } finally {
    secret.fill(0);
  }
}

function sharedHistoryCapacityHmac(secret: Buffer, payload: Omit<SharedHistoryCapacityReceiptV1, "hmac">): `hmac-sha256:${string}` {
  if (secret.byteLength !== 32) fail("invalid-candidate-control-secret");
  return `hmac-sha256:${createHmac("sha256", secret)
    .update("shared-history-capacity-receipt:v1\0", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex")}` as `hmac-sha256:${string}`;
}

function capacityReceiptFingerprint(receipt: SharedHistoryCapacityReceiptV1): Sha256Fingerprint {
  return canonicalSha256Fingerprint(withoutHmac(receipt));
}

function requiredCapacityReceiptPath(value: string | undefined): string {
  if (value === undefined) fail("shared-history-capacity-receipt-required");
  return exactAbsolute(value, "invalid-shared-history-capacity-receipt");
}

function readSharedHistoryCapacitySecret(routerRoot: string): Buffer {
  const secret = readPrivateRegularFile(join(routerRoot, "control-secret.v1"), 64, "capacity-receipt-control-secret");
  if (secret.byteLength !== 32) {
    secret.fill(0);
    fail("invalid-candidate-control-secret");
  }
  return secret;
}

interface ReadSharedHistoryCapacityReceiptV1 {
  receipt: SharedHistoryCapacityReceiptV1;
  seal: SharedHistoryCapacityReceiptFileSealV1;
}

function readSharedHistoryCapacityReceipt(path: string, routerRoot: string): SharedHistoryCapacityReceiptV1 {
  return readSharedHistoryCapacityReceiptWithSeal(path, routerRoot).receipt;
}

function readSharedHistoryCapacityReceiptWithSeal(path: string, routerRoot: string): ReadSharedHistoryCapacityReceiptV1 {
  assertOwnerControlledDirectory(dirname(path), "shared-history-capacity-receipt-parent");
  const before = lstatNoFollow(path, "shared-history-capacity-receipt");
  assertPrivateRegularFileStat(before, "shared-history-capacity-receipt");
  if (before.size > MAX_SHARED_HISTORY_CAPACITY_RECEIPT_BYTES) {
    fail("shared-history-capacity-receipt-capacity-exceeded");
  }
  const bytes = readPrivateRegularFile(path, MAX_SHARED_HISTORY_CAPACITY_RECEIPT_BYTES, "shared-history-capacity-receipt");
  let secret: Buffer | null = null;
  try {
    const receipt = parseSharedHistoryCapacityReceipt(JSON.parse(bytes.toString("utf8")) as unknown);
    secret = readSharedHistoryCapacitySecret(routerRoot);
    const expected = sharedHistoryCapacityHmac(secret, withoutHmac(receipt));
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(receipt.hmac, "utf8");
    try {
      if (expectedBytes.byteLength !== actualBytes.byteLength || !timingSafeEqual(expectedBytes, actualBytes)) {
        fail("shared-history-capacity-receipt-hmac-invalid");
      }
    } finally {
      expectedBytes.fill(0);
      actualBytes.fill(0);
    }
    const after = lstatNoFollow(path, "shared-history-capacity-receipt");
    if (!sameFile(before, after)) fail("shared-history-capacity-receipt-changed-during-read");
    return {
      receipt,
      seal: {
        path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        device: before.dev,
        inode: before.ino,
        uid: before.uid,
        mode: before.mode & 0o777,
        nlink: before.nlink,
      },
    };
  } catch (error) {
    if (error instanceof SharedHistoryMigrationFailure) throw error;
    throw new SharedHistoryMigrationFailure("invalid-shared-history-capacity-receipt");
  } finally {
    bytes.fill(0);
    secret?.fill(0);
  }
}

/**
 * Verify a persisted preview receipt without creating any migration artifact.
 * The source recheck intentionally uses the same completed-v2 adoption
 * verifier as apply, so an HMAC from a different normalized Codex/SQLite pair
 * cannot be sealed into an offline launcher context.
 */
export function inspectSharedHistoryCapacityReceipt(
  input: SharedHistoryCapacityReceiptInspectionInput,
  suppliedDependencies: Pick<SharedHistoryMigrationDependencies, "adopt" | "inspectLegacyAdoption" | "adoptionDependencies"> = {},
): SharedHistoryCapacityReceiptInspectionV1 {
  const legacyRouterRoot = exactAbsolute(input.legacyRouterRoot, "invalid-legacy-router-root");
  const legacyCodexRoot = exactAbsolute(input.legacyCodexRoot, "invalid-legacy-codex-root");
  const legacySqliteRoot = exactAbsolute(input.legacySqliteRoot, "invalid-legacy-sqlite-root");
  const legacyDefinitionsRoot = exactAbsolute(
    input.legacyDefinitionsRoot ?? legacyCodexRoot,
    "invalid-legacy-definitions-root",
  );
  const capacityReceiptPath = requiredCapacityReceiptPath(input.capacityReceiptPath);
  const routerProjection = projectCandidatePackagePath(legacyRouterRoot, "legacy v2 router root");
  const codexProjection = projectCandidatePackagePath(legacyCodexRoot, "legacy CODEX_HOME source root");
  const sqliteProjection = projectCandidatePackagePath(legacySqliteRoot, "legacy CODEX_SQLITE_HOME source root");
  const definitionsProjection = projectCandidatePackagePath(legacyDefinitionsRoot, "legacy definitions source root");
  const receiptProjection = projectCandidatePackagePath(capacityReceiptPath, "shared-history capacity receipt");
  assertCandidatePackageExistingDirectory(routerProjection, "legacy v2 router root");
  assertCandidatePackageExistingDirectory(codexProjection, "legacy CODEX_HOME source root");
  assertCandidatePackageExistingDirectory(sqliteProjection, "legacy CODEX_SQLITE_HOME source root");
  assertCandidatePackageExistingDirectory(definitionsProjection, "legacy definitions source root");
  assertCandidatePackagePathsDisjoint(routerProjection, codexProjection, "legacy v2 router root", "legacy CODEX_HOME source root");
  assertCandidatePackagePathsDisjoint(routerProjection, sqliteProjection, "legacy v2 router root", "legacy CODEX_SQLITE_HOME source root");
  assertLegacySourcesDisjointOrExactlyShared(codexProjection, sqliteProjection);
  assertCandidatePackagePathsDisjoint(routerProjection, receiptProjection, "legacy v2 router root", "shared-history capacity receipt");
  assertCandidatePackagePathsDisjoint(codexProjection, receiptProjection, "legacy CODEX_HOME source root", "shared-history capacity receipt");
  assertCandidatePackagePathsDisjoint(sqliteProjection, receiptProjection, "legacy CODEX_SQLITE_HOME source root", "shared-history capacity receipt");
  assertCandidatePackagePathsDisjoint(definitionsProjection, receiptProjection, "legacy definitions source root", "shared-history capacity receipt");
  assertPrivateDirectory(legacyRouterRoot, "legacy-router-root");
  assertOwnerControlledDirectory(legacyCodexRoot, "legacy-codex-root");
  assertOwnerControlledDirectory(legacySqliteRoot, "legacy-sqlite-root");
  assertOwnerControlledDirectory(legacyDefinitionsRoot, "legacy-definitions-root");
  const hasDefinitionBinding = input.sharedSkillsRoots !== undefined || input.sharedPluginInventory !== undefined;
  if (hasDefinitionBinding && (input.sharedSkillsRoots === undefined || input.sharedPluginInventory === undefined)) {
    fail("shared-history-capacity-receipt-definition-binding-incomplete");
  }
  const initialRoots = {
    router: sharedHistoryCapacityReceiptRootBinding(legacyRouterRoot, "legacy-router-root"),
    codex: sharedHistoryCapacityReceiptRootBinding(legacyCodexRoot, "legacy-codex-root"),
    sqlite: sharedHistoryCapacityReceiptRootBinding(legacySqliteRoot, "legacy-sqlite-root"),
    definitions: sharedHistoryCapacityReceiptRootBinding(legacyDefinitionsRoot, "legacy-definitions-root"),
  };
  const read = readSharedHistoryCapacityReceiptWithSeal(capacityReceiptPath, legacyRouterRoot);
  if (canonicalJson(read.receipt.caps) !== canonicalJson(sharedHistoryCapacityLimits())
    || Object.values(read.receipt.margins).some((margin) => margin < 0)) {
    fail("shared-history-capacity-receipt-capacity-mismatch");
  }
  if (read.receipt.sources.routerManifestFingerprint !== scanPrivateTree(legacyRouterRoot).fingerprint) {
    fail("shared-history-capacity-receipt-router-manifest-mismatch");
  }
  if (canonicalJson(read.receipt.sources.definitionsRoot) !== canonicalJson(initialRoots.definitions)) {
    fail("shared-history-capacity-receipt-definitions-root-mismatch");
  }
  const adopt = suppliedDependencies.adopt ?? adoptAccountHistory;
  const inspect = suppliedDependencies.inspectLegacyAdoption ?? inspectCompletedLegacyV2HistoryAdoption;
  const preview = adopt({
    sourceCodexRoot: legacyCodexRoot,
    sourceSqliteRoot: legacySqliteRoot,
    routerRoot: legacyRouterRoot,
    // `apply: false` does not observe this path. It is nevertheless kept exact
    // because the established adoption API requires an app path in every call.
    appPath: legacyCodexRoot,
    requireLegacyV2: true,
    apply: false,
  }, suppliedDependencies.adoptionDependencies);
  if (preview.status !== "already-adopted") fail("legacy-v2-adoption-not-completed");
  const proof = inspect(legacyRouterRoot);
  assertLegacyProofMatchesPreview(proof, preview);
  const expectedProof = capacityProofBinding(proof);
  if (canonicalJson(read.receipt.proof) !== canonicalJson(expectedProof)) {
    fail("shared-history-capacity-receipt-proof-mismatch");
  }
  const expectedSourceDatabaseManifestFingerprint = canonicalSha256Fingerprint({
    sourceFingerprint: proof.receipt.sourceFingerprint,
    databases: proof.receipt.databases,
    histories: proof.receipt.histories,
  });
  const expectedNormalizedSourceDatabaseManifestFingerprint = canonicalSha256Fingerprint({
    destinationFingerprint: proof.receipt.destinationFingerprint,
    databases: proof.receipt.databases,
    histories: proof.receipt.histories,
  });
  if (read.receipt.sources.sourceDatabaseManifestFingerprint !== expectedSourceDatabaseManifestFingerprint
    || read.receipt.sources.normalizedSourceDatabaseManifestFingerprint !== expectedNormalizedSourceDatabaseManifestFingerprint) {
    fail("shared-history-capacity-receipt-source-mismatch");
  }
  if (hasDefinitionBinding) {
    const trustedRoots = normalizeSharedSkillsTrustedRoots(input.sharedSkillsRoots!);
    const inventory = canonicalPrivateSharedPluginInventory(input.sharedPluginInventory!);
    const sharedSkills = scanLegacySharedSkillsTree(join(legacyDefinitionsRoot, "skills"), trustedRoots);
    const sharedPlugins = scanLegacySharedPlugins(legacyDefinitionsRoot, inventory);
    if (read.receipt.sources.sharedSkillsManifestFingerprint !== sharedSkills.manifest.fingerprint
      || read.receipt.sources.sharedPluginsManifestFingerprint !== sharedPlugins.manifest.fingerprint) {
      fail("shared-history-capacity-receipt-definition-manifest-mismatch");
    }
  }
  const finalRoots = {
    router: sharedHistoryCapacityReceiptRootBinding(legacyRouterRoot, "legacy-router-root"),
    codex: sharedHistoryCapacityReceiptRootBinding(legacyCodexRoot, "legacy-codex-root"),
    sqlite: sharedHistoryCapacityReceiptRootBinding(legacySqliteRoot, "legacy-sqlite-root"),
    definitions: sharedHistoryCapacityReceiptRootBinding(legacyDefinitionsRoot, "legacy-definitions-root"),
  };
  if (canonicalJson(initialRoots) !== canonicalJson(finalRoots)) fail("shared-history-capacity-receipt-root-changed-during-inspection");
  return {
    version: 1,
    kind: "shared-history-capacity-receipt-inspection",
    receipt: read.seal,
    issuedAt: read.receipt.issuedAt,
    proof: read.receipt.proof,
    sources: read.receipt.sources,
    projection: read.receipt.projection,
    roots: finalRoots,
  };
}

function sharedHistoryCapacityReceiptRootBinding(
  path: string,
  label: string,
): SharedHistoryCapacityReceiptRootBindingV1 {
  const stat = lstatNoFollow(path, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}-not-directory`);
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
  };
}

function parseSharedHistoryCapacityReceipt(value: unknown): SharedHistoryCapacityReceiptV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "proof", "sources", "caps", "projection", "counts", "margins", "issuedAt", "hmac",
  ]) || value.version !== 1 || value.kind !== "shared-history-capacity-receipt"
    || !isCanonicalUtcTimestamp(value.issuedAt)
    || typeof value.hmac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.hmac)) {
    fail("invalid-shared-history-capacity-receipt");
  }
  const proof = parseSharedHistoryCapacityProofBinding(value.proof);
  const sources = parseSharedHistoryCapacitySourceBinding(value.sources);
  const caps = parseSharedHistoryCapacityLimits(value.caps);
  const projection = parseSharedHistoryCapacityProjectionBinding(value.projection);
  const counts = parseSharedHistoryCapacityCounts(value.counts);
  const margins = parseSharedHistoryCapacityMargins(value.margins);
  if (!capacityMarginsMatch(caps, projection, counts, margins)) fail("invalid-shared-history-capacity-receipt");
  return {
    version: 1,
    kind: "shared-history-capacity-receipt",
    proof,
    sources,
    caps,
    projection,
    counts,
    margins,
    issuedAt: value.issuedAt,
    hmac: value.hmac as `hmac-sha256:${string}`,
  };
}

function parseSharedHistoryCapacityProofBinding(value: unknown): SharedHistoryCapacityProofBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "configFingerprint", "protocolFingerprint", "poolFingerprint", "intentFingerprint", "adoptionReceiptFingerprint", "sourceFingerprint", "destinationFingerprint", "ownersFingerprint", "aliasesFingerprint",
  ])) fail("invalid-shared-history-capacity-receipt");
  const fingerprints = [
    value.configFingerprint, value.protocolFingerprint, value.poolFingerprint, value.intentFingerprint,
    value.adoptionReceiptFingerprint, value.sourceFingerprint, value.destinationFingerprint, value.ownersFingerprint,
  ];
  if (fingerprints.some((fingerprint) => !isSha256Fingerprint(fingerprint))
    || !(value.aliasesFingerprint === null || isSha256Fingerprint(value.aliasesFingerprint))) {
    fail("invalid-shared-history-capacity-receipt");
  }
  return {
    configFingerprint: value.configFingerprint as Sha256Fingerprint,
    protocolFingerprint: value.protocolFingerprint as Sha256Fingerprint,
    poolFingerprint: value.poolFingerprint as Sha256Fingerprint,
    intentFingerprint: value.intentFingerprint as Sha256Fingerprint,
    adoptionReceiptFingerprint: value.adoptionReceiptFingerprint as Sha256Fingerprint,
    sourceFingerprint: value.sourceFingerprint as Sha256Fingerprint,
    destinationFingerprint: value.destinationFingerprint as Sha256Fingerprint,
    ownersFingerprint: value.ownersFingerprint as Sha256Fingerprint,
    aliasesFingerprint: value.aliasesFingerprint as Sha256Fingerprint | null,
  };
}

function parseSharedHistoryCapacitySourceBinding(value: unknown): SharedHistoryCapacitySourceBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "routerManifestFingerprint", "sourceDatabaseManifestFingerprint", "normalizedSourceDatabaseManifestFingerprint", "sharedSkillsManifestFingerprint", "sharedPluginsManifestFingerprint", "definitionsRoot",
  ]) || !isSha256Fingerprint(value.routerManifestFingerprint)
    || !isSha256Fingerprint(value.sourceDatabaseManifestFingerprint)
    || !isSha256Fingerprint(value.normalizedSourceDatabaseManifestFingerprint)
    || !isSha256Fingerprint(value.sharedSkillsManifestFingerprint)
    || !isSha256Fingerprint(value.sharedPluginsManifestFingerprint)) {
    fail("invalid-shared-history-capacity-receipt");
  }
  return {
    routerManifestFingerprint: value.routerManifestFingerprint as Sha256Fingerprint,
    sourceDatabaseManifestFingerprint: value.sourceDatabaseManifestFingerprint as Sha256Fingerprint,
    normalizedSourceDatabaseManifestFingerprint: value.normalizedSourceDatabaseManifestFingerprint as Sha256Fingerprint,
    sharedSkillsManifestFingerprint: value.sharedSkillsManifestFingerprint as Sha256Fingerprint,
    sharedPluginsManifestFingerprint: value.sharedPluginsManifestFingerprint as Sha256Fingerprint,
    definitionsRoot: parseSharedHistoryCapacityReceiptRootBinding(value.definitionsRoot),
  };
}

function parseSharedHistoryCapacityReceiptRootBinding(value: unknown): SharedHistoryCapacityReceiptRootBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "device", "inode", "uid", "mode", "nlink"])
    || typeof value.path !== "string" || !isExactAbsolutePath(value.path)
    || !isNonNegativeInteger(value.device) || !isNonNegativeInteger(value.inode)
    || !isNonNegativeInteger(value.uid) || !isNonNegativeInteger(value.mode)
    || !isNonNegativeInteger(value.nlink)) {
    fail("invalid-shared-history-capacity-receipt");
  }
  return {
    path: value.path,
    device: value.device,
    inode: value.inode,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
  };
}

function parseSharedHistoryCapacityLimits(value: unknown): SharedHistoryCapacityLimitsV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["snapshotBytes", "journalBytes", "conversations", "sourceEvidenceBytes"])
    || Object.values(value).some((entry) => !isNonNegativeInteger(entry))) fail("invalid-shared-history-capacity-receipt");
  return {
    snapshotBytes: value.snapshotBytes as number,
    journalBytes: value.journalBytes as number,
    conversations: value.conversations as number,
    sourceEvidenceBytes: value.sourceEvidenceBytes as number,
  };
}

function parseSharedHistoryCapacityProjectionBinding(value: unknown): SharedHistoryCapacityProjectionBindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["snapshot", "journal", "sourceEvidence"])) fail("invalid-shared-history-capacity-receipt");
  return {
    snapshot: parseSharedHistoryCapacityByteProof(value.snapshot),
    journal: parseSharedHistoryCapacityByteProof(value.journal),
    sourceEvidence: parseSharedHistoryCapacityByteProof(value.sourceEvidence),
  };
}

function parseSharedHistoryCapacityByteProof(value: unknown): SharedHistoryCapacityByteProofV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["bytes", "sha256"])
    || !isNonNegativeInteger(value.bytes) || !isSha256Fingerprint(value.sha256)) {
    fail("invalid-shared-history-capacity-receipt");
  }
  return { bytes: value.bytes, sha256: value.sha256 };
}

function parseSharedHistoryCapacityCounts(value: unknown): SharedHistoryCapacityCountsV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["conversations", "segments", "turns", "fullConversations", "partialConversations"])
    || Object.values(value).some((entry) => !isNonNegativeInteger(entry))
    || (value.fullConversations as number) + (value.partialConversations as number) > (value.conversations as number)) {
    fail("invalid-shared-history-capacity-receipt");
  }
  return {
    conversations: value.conversations as number,
    segments: value.segments as number,
    turns: value.turns as number,
    fullConversations: value.fullConversations as number,
    partialConversations: value.partialConversations as number,
  };
}

function parseSharedHistoryCapacityMargins(value: unknown): SharedHistoryCapacityMarginsV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["snapshotBytes", "journalBytes", "conversations", "sourceEvidenceBytes"])
    || Object.values(value).some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry))) {
    fail("invalid-shared-history-capacity-receipt");
  }
  return {
    snapshotBytes: value.snapshotBytes as number,
    journalBytes: value.journalBytes as number,
    conversations: value.conversations as number,
    sourceEvidenceBytes: value.sourceEvidenceBytes as number,
  };
}

function capacityMarginsMatch(
  caps: SharedHistoryCapacityLimitsV1,
  projection: SharedHistoryCapacityProjectionBindingV1,
  counts: SharedHistoryCapacityCountsV1,
  margins: SharedHistoryCapacityMarginsV1,
): boolean {
  return margins.snapshotBytes === caps.snapshotBytes - projection.snapshot.bytes
    && margins.journalBytes === caps.journalBytes - projection.journal.bytes
    && margins.conversations === caps.conversations - counts.conversations
    && margins.sourceEvidenceBytes === caps.sourceEvidenceBytes - projection.sourceEvidence.bytes;
}

function assertSharedHistoryCapacityReceipt(
  receipt: SharedHistoryCapacityReceiptV1,
  capacity: SharedHistoryCapacityPreviewV1,
  paths: MigrationPaths,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  routerManifest: TreeManifest,
  sharedSkills: SharedSkillsManifestV1,
  sharedPlugins: SharedPluginsManifestV1,
): void {
  const expected = createSharedHistoryCapacityReceipt({
    capacity,
    paths,
    proof,
    routerManifest,
    sharedSkills,
    sharedPlugins,
    issuedAt: receipt.issuedAt,
  });
  if (canonicalJson(receipt) !== canonicalJson(expected)) fail("shared-history-capacity-receipt-stale");
}

function assertLegacyProofMatchesPreview(
  proof: CompletedLegacyV2HistoryAdoptionProof,
  result: HistoryAdoptionResult,
): void {
  if (result.status === "dry-run"
    || result.poolFingerprint !== proof.poolFingerprint
    || result.intentFingerprint !== canonicalSha256Fingerprint(withoutHmac(proof.intent))
    || result.importedThreadCount !== proof.owners.threadIds.length
    || result.destinationFingerprint !== proof.receipt.destinationFingerprint) {
    fail("legacy-v2-adoption-proof-mismatch");
  }
}

function validatedTransactionId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(value)) fail("invalid-shared-history-migration-id");
  return value;
}

function exactAbsolute(value: string, code: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) fail(code);
  return value;
}

/**
 * The inventory is an external selection authority. Refuse both final links
 * and lexical aliases, then require an owner-private regular file in an
 * owner-controlled parent before any source package is opened. The inventory
 * has no credentials, so its parent may be readable but never writable by a
 * group or another user.
 */
function canonicalPrivateSharedPluginInventory(value: string): string {
  const path = exactAbsolute(value, "invalid-shared-plugin-inventory");
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    fail("invalid-shared-plugin-inventory");
  }
  if (canonical !== path) fail("invalid-shared-plugin-inventory");
  assertOwnerControlledDirectory(dirname(path), "shared-plugin-inventory-parent");
  assertPrivateRegularFile(path, MAX_SHARED_PLUGIN_INVENTORY_BYTES, "shared-plugin-inventory");
  return path;
}

function assertGlobalRootAbsent(path: string): void {
  if (existsNoFollow(path)) fail("global-v3-root-already-exists");
}

function assertOutputRootAbsent(path: string): void {
  if (existsNoFollow(path)) fail("rollback-export-output-already-exists");
}

function openMigrationParent(path: string): CandidatePackageParentAnchor {
  const projection = projectCandidatePackagePath(path, "shared-history migration parent");
  return openCandidatePackageParentAnchor(projection, "shared-history migration parent");
}

function durableBoundary(
  paths: MigrationPaths,
  journal: SharedHistoryMigrationJournalV2,
  phase: SharedHistoryMigrationPhase,
  dependencies: SharedHistoryMigrationDependencies,
): void {
  journal.phase = phase;
  writeJournal(paths, journal);
  dependencies.beforePhase?.(phase);
}

function writeInitialJournal(paths: MigrationPaths, journal: SharedHistoryMigrationJournalV2): void {
  assertPrivateDirectory(paths.parentRoot, "shared-history-migration-parent");
  if (existsNoFollow(paths.journalPath) || existsNoFollow(paths.journalStagingPath)) fail("shared-history-migration-journal-already-exists");
  const bytes = journalBytes(journal);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(paths.journalPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes.fill(0);
  }
  assertPrivateRegularFile(paths.journalPath, MAX_JOURNAL_BYTES, "shared-history-migration-journal");
  fsyncDirectory(paths.parentRoot);
}

function writeJournal(paths: MigrationPaths, journal: SharedHistoryMigrationJournalV2): void {
  assertJournalShape(journal, paths);
  assertPrivateDirectory(paths.parentRoot, "shared-history-migration-parent");
  assertPrivateRegularFile(paths.journalPath, MAX_JOURNAL_BYTES, "shared-history-migration-journal");
  if (existsNoFollow(paths.journalStagingPath)) fail("shared-history-migration-journal-staging-exists");
  const bytes = journalBytes(journal);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(paths.journalStagingPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes.fill(0);
  }
  assertPrivateRegularFile(paths.journalStagingPath, MAX_JOURNAL_BYTES, "shared-history-migration-journal-staging");
  renameSync(paths.journalStagingPath, paths.journalPath);
  assertPrivateRegularFile(paths.journalPath, MAX_JOURNAL_BYTES, "shared-history-migration-journal");
  fsyncDirectory(paths.parentRoot);
}

function journalBytes(journal: SharedHistoryMigrationJournalV2): Buffer {
  const bytes = Buffer.from(`${canonicalJson(journal)}\n`, "utf8");
  if (bytes.byteLength > MAX_JOURNAL_BYTES) {
    bytes.fill(0);
    fail("shared-history-migration-journal-capacity-exceeded");
  }
  return bytes;
}

function readJournal(paths: MigrationPaths): SharedHistoryMigrationJournalV2 {
  const bytes = readPrivateRegularFile(paths.journalPath, MAX_JOURNAL_BYTES, "shared-history-migration-journal");
  try {
    const raw = JSON.parse(bytes.toString("utf8")) as SharedHistoryMigrationJournal;
    if (!isRecord(raw)) fail("invalid-shared-history-migration-journal");
    if (raw.version === 1) {
      assertJournalV1Shape(raw, paths);
      return {
        ...raw,
        version: SHARED_HISTORY_MIGRATION_JOURNAL_VERSION,
        legacyDefinitionsRoot: raw.legacyCodexRoot,
      };
    }
    assertJournalShape(raw, paths);
    return raw;
  } catch (error) {
    if (error instanceof SharedHistoryMigrationFailure) throw error;
    fail("invalid-shared-history-migration-journal");
  } finally {
    bytes.fill(0);
  }
}

function assertJournalShape(value: unknown, paths: MigrationPaths): asserts value is SharedHistoryMigrationJournalV2 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "id", "legacyRouterRoot", "legacyCodexRoot", "legacySqliteRoot", "globalRoot", "snapshotRoot",
    "candidateRoot", "quarantineRoot", "phase", "preAdoptionManifest", "preMigrationManifest", "candidateManifest", "canonical", "sharedSkills", "sharedPluginInventoryFingerprint", "sharedPluginExclusionsFingerprint", "sharedPlugins",
    "legacyDefinitionsRoot",
  ])) fail("invalid-shared-history-migration-journal");
  const journal = value as Record<string, unknown>;
  if (journal.version !== SHARED_HISTORY_MIGRATION_JOURNAL_VERSION
    || journal.legacyDefinitionsRoot !== paths.legacyDefinitionsRoot
  ) fail("invalid-shared-history-migration-journal");
  assertJournalBody(journal, paths);
}

/**
 * A v1 journal had no definitions-root key. Accept only that exact legacy
 * shape, and only while the caller's resolved root preserves the old implicit
 * `legacyCodexRoot` binding. A v1 journal carrying a new key is rejected.
 */
function assertJournalV1Shape(value: unknown, paths: MigrationPaths): asserts value is SharedHistoryMigrationJournalV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "id", "legacyRouterRoot", "legacyCodexRoot", "legacySqliteRoot", "globalRoot", "snapshotRoot",
    "candidateRoot", "quarantineRoot", "phase", "preAdoptionManifest", "preMigrationManifest", "candidateManifest", "canonical", "sharedSkills", "sharedPluginInventoryFingerprint", "sharedPluginExclusionsFingerprint", "sharedPlugins",
  ])) fail("invalid-shared-history-migration-journal");
  const journal = value as Record<string, unknown>;
  if (journal.version !== 1 || paths.legacyDefinitionsRoot !== paths.legacyCodexRoot) {
    fail("invalid-shared-history-migration-journal");
  }
  assertJournalBody(journal, paths);
}

function assertJournalBody(journal: Record<string, unknown>, paths: MigrationPaths): void {
  if (journal.kind !== "shared-history-migration"
    || journal.id !== paths.transactionId
    || journal.legacyRouterRoot !== paths.legacyRouterRoot
    || journal.legacyCodexRoot !== paths.legacyCodexRoot
    || journal.legacySqliteRoot !== paths.legacySqliteRoot
    || journal.globalRoot !== paths.globalRoot
    || journal.snapshotRoot !== paths.snapshotRoot
    || journal.candidateRoot !== paths.candidateRoot
    || journal.quarantineRoot !== paths.quarantineRoot
    || !isMigrationPhase(journal.phase)) fail("invalid-shared-history-migration-journal");
  assertManifest(journal.preAdoptionManifest);
  if (journal.preMigrationManifest !== null) assertManifest(journal.preMigrationManifest);
  if (journal.candidateManifest !== null) assertManifest(journal.candidateManifest);
  if (journal.canonical !== null) assertCanonicalSummary(journal.canonical);
  if (journal.sharedSkills !== null) {
    const sharedSkills = parseSharedSkillsManifest(journal.sharedSkills);
    if (!sameTrustedRoots(sharedSkills.trustedRoots, paths.sharedSkillsTrustedRoots)) fail("invalid-shared-history-migration-journal");
  }
  if (!isSha256Fingerprint(journal.sharedPluginInventoryFingerprint)
    || journal.sharedPluginInventoryFingerprint !== canonicalSha256Fingerprint(readSharedPluginInventory(paths.sharedPluginInventory))) {
    fail("invalid-shared-history-migration-journal");
  }
  if (!isSha256Fingerprint(journal.sharedPluginExclusionsFingerprint)) fail("invalid-shared-history-migration-journal");
  if (journal.sharedPlugins !== null) {
    const sharedPlugins = parseSharedPluginsManifest(journal.sharedPlugins);
    if (sharedPlugins.inventoryFingerprint !== journal.sharedPluginInventoryFingerprint
      || sharedPlugins.exclusionsFingerprint !== journal.sharedPluginExclusionsFingerprint) {
      fail("invalid-shared-history-migration-journal");
    }
  }
}

function isMigrationPhase(value: unknown): value is SharedHistoryMigrationPhase {
  return value === "journal-prepared"
    || value === "legacy-adoption-complete"
    || value === "pre-migration-snapshot-created"
    || value === "candidate-copied"
    || value === "candidate-canonicalized"
    || value === "candidate-preflight-ready"
    || value === "published"
    || value === "collision-quarantined"
    || value === "recovered";
}

function assertCanonicalSummary(value: unknown): asserts value is CanonicalJournalSummary {
  if (!isRecord(value) || !hasExactKeys(value, ["fingerprint", "conversationCount", "segmentCount"])
    || !isSha256Fingerprint(value.fingerprint)
    || !isNonNegativeInteger(value.conversationCount)
    || !isNonNegativeInteger(value.segmentCount)) fail("invalid-shared-history-migration-journal");
}

function retainExistingCandidate(
  paths: MigrationPaths,
  parent: CandidatePackageParentAnchor,
  journal: SharedHistoryMigrationJournalV2,
): void {
  const candidate = openExistingCandidate(paths.candidateRoot, parent);
  try {
    const retained = retainCandidatePackageEvidence({ source: candidate, destination: paths.quarantineRoot, parent });
    if (retained !== "renamed") fail("recovery-candidate-quarantine-failed");
  } finally {
    closeCandidatePackageScratchAnchor(candidate);
  }
  journal.phase = "collision-quarantined";
  writeJournal(paths, journal);
}

function openExistingCandidate(path: string, parent: CandidatePackageParentAnchor): CandidatePackageScratchAnchor {
  assertCandidatePackageParentAnchor(parent);
  if (dirname(path) !== parent.path || basename(path) === "." || basename(path) === "..") fail("recovery-candidate-path-invalid");
  const stat = lstatNoFollow(path, "recovery-candidate");
  assertPrivateDirectoryStat(stat, "recovery-candidate");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const observed = fstatSync(descriptor);
    if (!sameDirectory(stat, observed)) fail("recovery-candidate-identity-changed");
    const candidate = { path, name: basename(path), descriptor, dev: observed.dev, ino: observed.ino };
    descriptor = undefined;
    return candidate;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function scanPrivateTree(root: string, allowSharedPluginProjectionLinks = false): TreeManifest {
  assertPrivateDirectory(root, "tree-root");
  const directories: string[] = [];
  const files: TreeManifestEntry[] = [];
  const links: TreeManifestLink[] = [];
  let totalBytes = 0;
  const visit = (directory: string, local: string): void => {
    const names = readdirNoFollow(directory, "tree-directory");
    for (const name of names) {
      assertSafeRelativeComponent(name, "tree-entry");
      const path = join(directory, name);
      const relativePath = local ? `${local}/${name}` : name;
      let stat: Stats;
      try { stat = lstatSync(path); } catch { fail("tree-entry-missing-or-unsafe"); }
      if (stat.isSymbolicLink()) {
        if (!allowSharedPluginProjectionLinks || !isExpectedSharedPluginProjectionLink(root, path, relativePath)) fail("tree-entry-symlink-refused");
        let target: string;
        try { target = readlinkSync(path); } catch { fail("tree-entry-symlink-refused"); }
        const expectedTarget = relative(dirname(path), join(root, SHARED_PLUGINS_DIRECTORY, "cache"));
        if (target !== expectedTarget) fail("tree-entry-symlink-refused");
        links.push({ path: relativePath, target });
        continue;
      }
      if (stat.isDirectory()) {
        assertPrivateDirectoryStat(stat, "tree-directory");
        directories.push(relativePath);
        if (directories.length + files.length > MAX_TREE_FILES) fail("shared-history-tree-file-count-exceeded");
        visit(path, relativePath);
        continue;
      }
      assertPrivateRegularFileStat(stat, "tree-file");
      const digest = digestPrivateFile(path, stat, "tree-file");
      totalBytes += stat.size;
      if (totalBytes > MAX_TREE_BYTES) fail("shared-history-tree-byte-limit-exceeded");
      files.push({ path: relativePath, bytes: stat.size, sha256: digest });
      if (directories.length + files.length > MAX_TREE_FILES) fail("shared-history-tree-file-count-exceeded");
    }
  };
  visit(root, "");
  directories.sort(compareCodeUnits);
  files.sort((left, right) => compareCodeUnits(left.path, right.path));
  links.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    directories,
    files,
    links,
    fingerprint: canonicalSha256Fingerprint({ directories, files, links }),
  };
}

function isExpectedSharedPluginProjectionLink(root: string, path: string, relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.length === 5 && parts[0] === "accounts" && isOpaqueAccountId(parts[1]!)
    && parts[2] === "codex-home" && parts[3] === "plugins" && parts[4] === "cache";
}

function assertManifest(value: unknown): asserts value is TreeManifest {
  if (!isRecord(value) || !hasExactKeys(value, ["directories", "files", "links", "fingerprint"])
    || !Array.isArray(value.directories) || !Array.isArray(value.files) || !Array.isArray(value.links) || !isSha256Fingerprint(value.fingerprint)) {
    fail("invalid-shared-history-tree-manifest");
  }
  const directories = value.directories;
  const files = value.files;
  if (directories.length + files.length + value.links.length > MAX_TREE_FILES) fail("invalid-shared-history-tree-manifest");
  let prior = "";
  for (const directory of directories) {
    if (typeof directory !== "string" || !isSafeRelativePath(directory) || (prior && compareCodeUnits(prior, directory) >= 0)) {
      fail("invalid-shared-history-tree-manifest");
    }
    prior = directory;
  }
  prior = "";
  let total = 0;
  for (const entry of files) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "bytes", "sha256"])
      || typeof entry.path !== "string" || !isSafeRelativePath(entry.path)
      || !isNonNegativeInteger(entry.bytes) || !isSha256Fingerprint(entry.sha256)
      || (prior && compareCodeUnits(prior, entry.path) >= 0)) {
      fail("invalid-shared-history-tree-manifest");
    }
    total += entry.bytes;
    if (total > MAX_TREE_BYTES) fail("invalid-shared-history-tree-manifest");
    prior = entry.path;
  }
  const links = value.links;
  prior = "";
  for (const entry of links) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "target"])
      || typeof entry.path !== "string" || !isSafeRelativePath(entry.path)
      || entry.target !== "../../../../shared-plugins/cache"
      || (prior && compareCodeUnits(prior, entry.path) >= 0)) fail("invalid-shared-history-tree-manifest");
    prior = entry.path;
  }
  const normalized = { directories: [...directories], files: files.map((entry) => ({ ...entry })), links: links.map((entry) => ({ ...entry as TreeManifestLink })) };
  if (canonicalSha256Fingerprint(normalized) !== value.fingerprint) fail("invalid-shared-history-tree-manifest");
}

function copyPrivateTree(sourceRoot: string, destinationRoot: string, manifest: TreeManifest): void {
  assertManifest(manifest);
  assertPrivateDirectory(sourceRoot, "copy-source-root");
  assertPrivateDirectory(destinationRoot, "copy-destination-root");
  if (readdirNoFollow(destinationRoot, "copy-destination-root").length !== 0) fail("copy-destination-not-empty");
  for (const directory of [...manifest.directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareCodeUnits(left, right);
  })) {
    const destination = resolvedChild(destinationRoot, directory, "copy-directory");
    mkdirSync(destination, { mode: PRIVATE_DIRECTORY_MODE });
    assertPrivateDirectory(destination, "copy-directory");
  }
  for (const entry of manifest.files) {
    const source = resolvedChild(sourceRoot, entry.path, "copy-source-file");
    const destination = resolvedChild(destinationRoot, entry.path, "copy-destination-file");
    copyOnePrivateFile(source, destination, entry.sha256);
  }
  assertTreeManifest(destinationRoot, manifest, "copy-manifest-mismatch");
  fsyncTree(destinationRoot);
}

function copyOnePrivateFile(source: string, destination: string, expected: Sha256Fingerprint): void {
  const sourceStat = lstatNoFollow(source, "copy-source-file");
  assertPrivateRegularFileStat(sourceStat, "copy-source-file");
  if (existsNoFollow(destination)) fail("copy-destination-file-already-exists");
  assertPrivateDirectory(dirname(destination), "copy-destination-parent");
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    sourceDescriptor = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedSource = fstatSync(sourceDescriptor);
    if (!sameFile(sourceStat, openedSource)) fail("copy-source-file-changed");
    destinationDescriptor = openSync(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    let offset = 0;
    while (true) {
      const read = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += writeSync(destinationDescriptor, buffer, written, read - written);
      offset += read;
    }
    if (offset !== sourceStat.size) fail("copy-source-file-changed");
    const after = fstatSync(sourceDescriptor);
    if (!sameFile(sourceStat, after)) fail("copy-source-file-changed");
    const actual = `sha256:${hash.digest("hex")}` as Sha256Fingerprint;
    if (actual !== expected) fail("copy-source-fingerprint-changed");
    fsyncSync(destinationDescriptor);
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    buffer.fill(0);
  }
  chmodSync(destination, PRIVATE_FILE_MODE);
  const destinationStat = lstatNoFollow(destination, "copy-destination-file");
  assertPrivateRegularFileStat(destinationStat, "copy-destination-file");
  if (digestPrivateFile(destination, destinationStat, "copy-destination-file") !== expected) fail("copy-destination-fingerprint-mismatch");
}

function assertTreeManifest(root: string, expected: TreeManifest, code: string, allowSharedPluginProjectionLinks = false): void {
  const actual = scanPrivateTree(root, allowSharedPluginProjectionLinks);
  if (actual.fingerprint !== expected.fingerprint) fail(code);
}

function treeMatches(root: string, expected: TreeManifest, allowSharedPluginProjectionLinks = false): boolean {
  try {
    assertTreeManifest(root, expected, "tree-mismatch", allowSharedPluginProjectionLinks);
    return true;
  } catch {
    return false;
  }
}

function fsyncTree(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatNoFollow(path, "fsync-tree");
    if (stat.isDirectory()) {
      for (const name of readdirNoFollow(path, "fsync-tree")) visit(join(path, name));
      fsyncDirectory(path);
      return;
    }
    if (stat.isFile()) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
      return;
    }
    fail("fsync-tree-unsupported-entry");
  };
  visit(root);
}

/**
 * Copy the one exact legacy CODEX_HOME Skills tree into the candidate's
 * manager-global source, then make an identical, read-only tree for every
 * account home. This deliberately refuses an existing account `skills/`
 * directory instead of replacing it: an unexpected local tree is evidence of
 * drift, not permission to discard account-local data.
 */
function materializeSharedSkillsCandidate(
  candidateRoot: string,
  legacySource: SharedSkillsSourceScanV1,
  accounts: readonly OpaqueAccountId[],
): SharedSkillsManifestV1 {
  const source = legacySource.manifest;
  if (source.files.length === 0) fail("legacy-shared-skills-source-empty");
  const candidateSkillsRoot = join(candidateRoot, SHARED_SKILLS_DIRECTORY);
  if (existsNoFollow(candidateSkillsRoot)) fail("candidate-shared-skills-source-already-exists");
  copyLegacySharedSkillsTree(legacySource, candidateSkillsRoot);
  lockSharedSkillsTree(candidateSkillsRoot, source);
  const sealed = scanMaterializedSharedSkillsTree(candidateSkillsRoot, true, source.trustedRoots);
  if (!sameSharedSkillsManifest(source, sealed)) fail("candidate-shared-skills-source-mismatch");
  writePrivateJsonNew(join(candidateRoot, SHARED_SKILLS_MANIFEST_FILE), sealed);
  for (const account of accounts) {
    const codexHome = join(candidateRoot, "accounts", account, "codex-home");
    assertPrivateDirectory(codexHome, "candidate-account-codex-home");
    const accountSkillsRoot = join(codexHome, "skills");
    if (existsNoFollow(accountSkillsRoot)) fail("candidate-account-shared-skills-already-exists");
    copySharedSkillsTree(candidateSkillsRoot, accountSkillsRoot, sealed, true);
    lockSharedSkillsTree(accountSkillsRoot, sealed);
    if (!sameSharedSkillsManifest(scanMaterializedSharedSkillsTree(accountSkillsRoot, true, sealed.trustedRoots), sealed)) {
      fail("candidate-account-shared-skills-mismatch");
    }
  }
  // The legacy source is still authoritative until publication. Check it at
  // the end of the full fan-out so a concurrent edit, link swap, or trusted
  // root replacement cannot become the source for only some account homes.
  assertLegacySharedSkillsSource(legacySource.sourceRoot, source.trustedRoots, legacySource);
  return sealed;
}

/** Read-only operator probe used by preview acceptance; it never creates a candidate or journal. */
export function inspectSharedSkillsSource(
  legacyDefinitionsRoot: string,
  sharedSkillsRoots: readonly string[],
): Readonly<Pick<SharedSkillsManifestV1, "fingerprint" | "directories" | "files" | "trustedRoots" | "trustedRootsFingerprint">> {
  const sourceRoot = join(exactAbsolute(legacyDefinitionsRoot, "invalid-legacy-definitions-root"), "skills");
  const roots = normalizeSharedSkillsTrustedRoots(sharedSkillsRoots);
  return scanLegacySharedSkillsTree(sourceRoot, roots).manifest;
}

function assertLegacySharedSkillsSource(
  sourceRoot: string,
  trustedRoots: readonly SharedSkillsTrustedRootV1[],
  expected: SharedSkillsSourceScanV1,
): void {
  const actual = scanLegacySharedSkillsTree(sourceRoot, trustedRoots);
  if (!sameSharedSkillsSourceScan(actual, expected)) fail("legacy-shared-skills-source-changed-during-migration");
}

/**
 * The only source scan that may flatten links. Each link's fully resolved
 * target is bound to either the canonical legacy Skills root or an exact
 * caller-declared trusted root. The emitted manifest itself contains no link.
 */
function scanLegacySharedSkillsTree(
  root: string,
  trustedRoots: readonly SharedSkillsTrustedRootV1[],
): SharedSkillsSourceScanV1 {
  const sourceRoot = canonicalSharedSkillsDirectory(root, "legacy-shared-skills-root", false);
  const sourceRootIdentity = sharedSkillsTrustedRoot(sourceRoot);
  const directories: string[] = [];
  const files: TreeManifestEntry[] = [];
  const sourceFiles: SharedSkillsSourceFileV1[] = [];
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string, ancestors: ReadonlySet<string>): void => {
    const directoryStat = lstatNoFollow(directory, "shared-skills-directory");
    assertSharedSkillsDirectory(directoryStat, "shared-skills-directory", false);
    const identity = `${directoryStat.dev}:${directoryStat.ino}`;
    if (ancestors.has(identity)) fail("shared-skills-directory-cycle");
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(identity);
    let names: string[];
    try {
      names = readdirSync(directory).sort(compareCodeUnits);
    } catch {
      fail("shared-skills-directory-unreadable");
    }
    for (const name of names) {
      if (!isSafeSharedSkillsName(name)) fail("unsafe-shared-skills-path");
      const path = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const entry = resolveLegacySharedSkillsEntry(path, sourceRootIdentity, trustedRoots);
      if (entry.stat.isDirectory()) {
        assertSharedSkillsDirectory(entry.stat, "shared-skills-directory", false);
        directories.push(relativePath);
        if (directories.length + files.length > MAX_SHARED_SKILL_FILES) fail("shared-skills-file-count-exceeded");
        visit(entry.path, relativePath, nextAncestors);
        continue;
      }
      assertSharedSkillsFile(entry.stat, "shared-skills-file", false);
      totalBytes += entry.stat.size;
      if (totalBytes > MAX_SHARED_SKILL_BYTES || directories.length + files.length >= MAX_SHARED_SKILL_FILES) {
        fail("shared-skills-capacity-exceeded");
      }
      const bytes = readSharedSkillsFile(entry.path, entry.stat, "shared-skills-file");
      try {
        const file = { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) } as TreeManifestEntry;
        files.push(file);
        sourceFiles.push({
          ...file,
          sourcePath: entry.path,
          device: entry.stat.dev,
          inode: entry.stat.ino,
          mtimeMs: entry.stat.mtimeMs,
        });
      } finally {
        bytes.fill(0);
      }
    }
  };
  visit(sourceRoot, "", new Set());
  const normalizedDirectories = directories.sort(compareCodeUnits);
  const normalizedFiles = files.sort((left, right) => compareCodeUnits(left.path, right.path));
  const manifest = sharedSkillsManifest(normalizedDirectories, normalizedFiles, trustedRoots);
  return {
    manifest,
    sourceRoot,
    files: sourceFiles.sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
}

/** Scans the sealed source and account materializations; links are always refused here. */
function scanMaterializedSharedSkillsTree(
  root: string,
  requireReadOnly: boolean,
  trustedRoots: readonly SharedSkillsTrustedRootV1[],
): SharedSkillsManifestV1 {
  const rootStat = lstatNoFollow(root, "shared-skills-root");
  assertSharedSkillsDirectory(rootStat, "shared-skills-root", requireReadOnly);
  const directories: string[] = [];
  const files: TreeManifestEntry[] = [];
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory).sort(compareCodeUnits);
    } catch {
      fail("shared-skills-directory-unreadable");
    }
    for (const name of names) {
      if (!isSafeSharedSkillsName(name)) fail("unsafe-shared-skills-path");
      const path = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatNoFollow(path, "shared-skills-entry");
      if (stat.isDirectory()) {
        assertSharedSkillsDirectory(stat, "shared-skills-directory", requireReadOnly);
        directories.push(relativePath);
        if (directories.length + files.length > MAX_SHARED_SKILL_FILES) fail("shared-skills-file-count-exceeded");
        visit(path, relativePath);
        continue;
      }
      assertSharedSkillsFile(stat, "shared-skills-file", requireReadOnly);
      totalBytes += stat.size;
      if (totalBytes > MAX_SHARED_SKILL_BYTES || directories.length + files.length >= MAX_SHARED_SKILL_FILES) {
        fail("shared-skills-capacity-exceeded");
      }
      const bytes = readSharedSkillsFile(path, stat, "shared-skills-file");
      try {
        files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
      } finally {
        bytes.fill(0);
      }
    }
  };
  visit(root, "");
  return sharedSkillsManifest(
    directories.sort(compareCodeUnits),
    files.sort((left, right) => compareCodeUnits(left.path, right.path)),
    trustedRoots,
  );
}

function resolveLegacySharedSkillsEntry(
  path: string,
  sourceRoot: SharedSkillsTrustedRootV1,
  trustedRoots: readonly SharedSkillsTrustedRootV1[],
): { path: string; stat: Stats } {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    fail("shared-skills-entry-missing-or-unsafe");
  }
  if (!stat.isSymbolicLink()) return { path, stat };
  let resolved: string;
  try {
    resolved = realpathSync.native(path);
  } catch {
    fail("shared-skills-symlink-unresolved");
  }
  const allowed = [sourceRoot, ...trustedRoots]
    .filter((root) => isWithinSharedSkillsRoot(root.path, resolved))
    .sort((left, right) => right.path.length - left.path.length || compareCodeUnits(left.path, right.path))[0];
  if (!allowed) fail("shared-skills-symlink-target-untrusted");
  const resolvedStat = assertResolvedSharedSkillsPath(allowed, resolved);
  return { path: resolved, stat: resolvedStat };
}

function canonicalSharedSkillsDirectory(path: string, label: string, requireReadOnly: boolean): string {
  const stat = lstatNoFollow(path, label);
  assertSharedSkillsDirectory(stat, label, requireReadOnly);
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    fail(`${label}-missing-or-unsafe`);
  }
  if (canonical !== path) fail(`${label}-not-canonical`);
  return canonical;
}

function sharedSkillsTrustedRoot(path: string): SharedSkillsTrustedRootV1 {
  const stat = lstatNoFollow(path, "shared-skills-trusted-root");
  assertSharedSkillsDirectory(stat, "shared-skills-trusted-root", false);
  return { path, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}

function assertResolvedSharedSkillsPath(root: SharedSkillsTrustedRootV1, target: string): Stats {
  if (!isWithinSharedSkillsRoot(root.path, target)) fail("shared-skills-symlink-target-untrusted");
  const rootStat = lstatNoFollow(root.path, "shared-skills-trusted-root");
  assertSharedSkillsDirectory(rootStat, "shared-skills-trusted-root", false);
  if (!sameTrustedRoot(root, rootStat)) fail("shared-skills-trusted-root-changed");
  const relativeTarget = relative(root.path, target);
  let current = root.path;
  let currentStat = rootStat;
  for (const component of relativeTarget ? relativeTarget.split(sep) : []) {
    if (!isSafeSharedSkillsName(component)) fail("shared-skills-symlink-target-unsafe");
    current = join(current, component);
    currentStat = lstatNoFollow(current, "shared-skills-symlink-target");
    if (current !== target) assertSharedSkillsDirectory(currentStat, "shared-skills-symlink-target", false);
  }
  return currentStat;
}

function isWithinSharedSkillsRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const suffix = relative(root, target);
  return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function copySharedSkillsTree(
  sourceRoot: string,
  destinationRoot: string,
  manifest: SharedSkillsManifestV1,
  sourceReadOnly: boolean,
): void {
  if (existsNoFollow(destinationRoot)) fail("shared-skills-copy-destination-exists");
  mkdirSync(destinationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(destinationRoot, "shared-skills-copy-destination");
  for (const directory of manifest.directories) {
    const destination = resolvedChild(destinationRoot, directory, "shared-skills-copy-directory");
    mkdirSync(destination, { mode: PRIVATE_DIRECTORY_MODE });
    assertPrivateDirectory(destination, "shared-skills-copy-directory");
  }
  for (const entry of manifest.files) {
    const source = resolvedChild(sourceRoot, entry.path, "shared-skills-copy-source");
    const stat = lstatNoFollow(source, "shared-skills-copy-source");
    assertSharedSkillsFile(stat, "shared-skills-copy-source", sourceReadOnly);
    if (stat.size !== entry.bytes) fail("shared-skills-source-drift");
    const bytes = readSharedSkillsFile(source, stat, "shared-skills-copy-source");
    try {
      if (sha256(bytes) !== entry.sha256) fail("shared-skills-source-drift");
      const destination = resolvedChild(destinationRoot, entry.path, "shared-skills-copy-destination");
      writePrivateFileNew(destination, bytes, "shared-skills-copy-destination");
    } finally {
      bytes.fill(0);
    }
  }
  if (!sameSharedSkillsManifest(scanMaterializedSharedSkillsTree(sourceRoot, sourceReadOnly, manifest.trustedRoots), manifest)
    || !sameSharedSkillsManifest(scanMaterializedSharedSkillsTree(destinationRoot, false, manifest.trustedRoots), manifest)) {
    fail("shared-skills-copy-mismatch");
  }
}

/** Copies a scan's no-follow resolved file origins, flattening only validated links. */
function copyLegacySharedSkillsTree(source: SharedSkillsSourceScanV1, destinationRoot: string): void {
  const manifest = source.manifest;
  if (existsNoFollow(destinationRoot)) fail("shared-skills-copy-destination-exists");
  mkdirSync(destinationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateDirectory(destinationRoot, "shared-skills-copy-destination");
  for (const directory of manifest.directories) {
    const destination = resolvedChild(destinationRoot, directory, "shared-skills-copy-directory");
    mkdirSync(destination, { mode: PRIVATE_DIRECTORY_MODE });
    assertPrivateDirectory(destination, "shared-skills-copy-directory");
  }
  for (const entry of source.files) {
    const stat = lstatNoFollow(entry.sourcePath, "shared-skills-copy-source");
    assertSharedSkillsFile(stat, "shared-skills-copy-source", false);
    if (stat.dev !== entry.device || stat.ino !== entry.inode || stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.bytes) {
      fail("legacy-shared-skills-source-changed-during-migration");
    }
    const bytes = readSharedSkillsFile(entry.sourcePath, stat, "shared-skills-copy-source");
    try {
      if (sha256(bytes) !== entry.sha256) fail("legacy-shared-skills-source-changed-during-migration");
      writePrivateFileNew(resolvedChild(destinationRoot, entry.path, "shared-skills-copy-destination"), bytes, "shared-skills-copy-destination");
    } finally {
      bytes.fill(0);
    }
  }
  if (!sameSharedSkillsManifest(scanMaterializedSharedSkillsTree(destinationRoot, false, manifest.trustedRoots), manifest)) {
    fail("shared-skills-copy-mismatch");
  }
}

function lockSharedSkillsTree(root: string, manifest: SharedSkillsManifestV1): void {
  for (const entry of manifest.files) chmodSync(resolvedChild(root, entry.path, "shared-skills-lock-file"), 0o400);
  for (const directory of [...manifest.directories].sort((left, right) => compareCodeUnits(right, left))) {
    chmodSync(resolvedChild(root, directory, "shared-skills-lock-directory"), 0o500);
  }
  chmodSync(root, 0o500);
}

function readSharedSkillsManifest(root: string): SharedSkillsManifestV1 {
  const value = readPrivateJson(join(root, SHARED_SKILLS_MANIFEST_FILE), 4 * 1024 * 1024, "shared-skills-manifest");
  return parseSharedSkillsManifest(value);
}

function parseSharedSkillsManifest(value: unknown): SharedSkillsManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "kind", "directories", "files", "trustedRoots", "trustedRootsFingerprint", "fingerprint"])
    || value.version !== 1 || value.kind !== "account-router-shared-skills" || !Array.isArray(value.directories)
    || !Array.isArray(value.files) || !Array.isArray(value.trustedRoots)
    || !isSha256Fingerprint(value.trustedRootsFingerprint) || !isSha256Fingerprint(value.fingerprint)) fail("invalid-shared-skills-manifest");
  const directories = value.directories.map((entry) => typeof entry === "string" && isSafeRelativePath(entry) && entry.split("/").every(isSafeSharedSkillsName) ? entry : null);
  const files = value.files.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "bytes", "sha256"])
      || typeof entry.path !== "string" || !isSafeRelativePath(entry.path) || !entry.path.split("/").every(isSafeSharedSkillsName)
      || !isNonNegativeInteger(entry.bytes) || !isSha256Fingerprint(entry.sha256)) return null;
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 } as TreeManifestEntry;
  });
  const trustedRoots = value.trustedRoots.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "device", "inode", "uid", "mode"])
      || typeof entry.path !== "string" || !isExactAbsolutePath(entry.path)
      || !isNonNegativeInteger(entry.device) || !isNonNegativeInteger(entry.inode)
      || !isNonNegativeInteger(entry.uid) || !isNonNegativeInteger(entry.mode)
      || entry.mode > 0o777 || (entry.mode & 0o022) !== 0) return null;
    return { path: entry.path, device: entry.device, inode: entry.inode, uid: entry.uid, mode: entry.mode } as SharedSkillsTrustedRootV1;
  });
  if (directories.some((entry) => entry === null) || files.some((entry) => entry === null)
    || trustedRoots.some((entry) => entry === null)
    || directories.length > MAX_SHARED_SKILL_FILES || files.length > MAX_SHARED_SKILL_FILES
    || trustedRoots.length > 128 || files.reduce((total, entry) => total + (entry?.bytes ?? 0), 0) > MAX_SHARED_SKILL_BYTES) fail("invalid-shared-skills-manifest");
  const normalized = {
    directories: [...directories as string[]].sort(compareCodeUnits),
    files: [...files as TreeManifestEntry[]].sort((left, right) => compareCodeUnits(left.path, right.path)),
    trustedRoots: [...trustedRoots as SharedSkillsTrustedRootV1[]].sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
  if (new Set(normalized.directories).size !== normalized.directories.length
    || new Set(normalized.files.map((entry) => entry.path)).size !== normalized.files.length
    || new Set(normalized.trustedRoots.map((entry) => entry.path)).size !== normalized.trustedRoots.length
    || canonicalSha256Fingerprint(normalized.trustedRoots) !== value.trustedRootsFingerprint
    || canonicalSha256Fingerprint({ ...normalized, trustedRootsFingerprint: value.trustedRootsFingerprint }) !== value.fingerprint) fail("invalid-shared-skills-manifest");
  return {
    version: 1,
    kind: "account-router-shared-skills",
    ...normalized,
    trustedRootsFingerprint: value.trustedRootsFingerprint,
    fingerprint: value.fingerprint,
  };
}

function sameSharedSkillsManifest(left: SharedSkillsManifestV1, right: SharedSkillsManifestV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSharedSkillsSourceScan(left: SharedSkillsSourceScanV1, right: SharedSkillsSourceScanV1): boolean {
  return left.sourceRoot === right.sourceRoot
    && sameSharedSkillsManifest(left.manifest, right.manifest)
    && canonicalJson(left.files) === canonicalJson(right.files);
}

function sameTrustedRoots(left: readonly SharedSkillsTrustedRootV1[], right: readonly SharedSkillsTrustedRootV1[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameTrustedRoot(expected: SharedSkillsTrustedRootV1, actual: Stats): boolean {
  return expected.device === actual.dev && expected.inode === actual.ino
    && expected.uid === actual.uid && expected.mode === (actual.mode & 0o777);
}

function sharedSkillsManifest(
  directories: readonly string[],
  files: readonly TreeManifestEntry[],
  trustedRoots: readonly SharedSkillsTrustedRootV1[],
): SharedSkillsManifestV1 {
  const normalized = {
    directories: [...directories].sort(compareCodeUnits),
    files: [...files].sort((left, right) => compareCodeUnits(left.path, right.path)),
    trustedRoots: [...trustedRoots].sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
  const trustedRootsFingerprint = canonicalSha256Fingerprint(normalized.trustedRoots);
  return {
    version: 1,
    kind: "account-router-shared-skills",
    ...normalized,
    trustedRootsFingerprint,
    fingerprint: canonicalSha256Fingerprint({ ...normalized, trustedRootsFingerprint }),
  };
}

function isExactAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && !value.includes("\0");
}

/**
 * Plugin packages are copied once into a sealed manager-global cache. Unlike
 * Skills, account homes contain only a validated link to that exact snapshot,
 * avoiding an N-times copy of a multi-gigabyte cache while keeping all auth,
 * config, MCP declarations, and SQLite state account-local.
 */
function materializeSharedPluginsCandidate(
  candidateRoot: string,
  source: SharedPluginsSourceScanV1,
  accounts: readonly OpaqueAccountId[],
): SharedPluginsManifestV1 {
  const sourceRoot = join(candidateRoot, SHARED_PLUGINS_DIRECTORY);
  if (existsNoFollow(sourceRoot)) fail("candidate-shared-plugins-source-already-exists");
  mkdirSync(sourceRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const cacheRoot = join(sourceRoot, "cache");
  mkdirSync(cacheRoot, { mode: PRIVATE_DIRECTORY_MODE });
  for (const entry of source.packages) copyLegacySharedPluginPackage(entry, cacheRoot);
  lockSharedPluginCache(sourceRoot, source.manifest);
  const sealed = scanMaterializedSharedPlugins(sourceRoot, true, source.manifest);
  if (!sameSharedPluginsManifest(sealed, source.manifest)) fail("candidate-shared-plugins-source-mismatch");
  writePrivateJsonNew(join(candidateRoot, SHARED_PLUGINS_MANIFEST_FILE), sealed);
  for (const account of accounts) {
    const codexHome = join(candidateRoot, "accounts", account, "codex-home");
    assertPrivateDirectory(codexHome, "candidate-account-codex-home");
    if (!materializeSharedPluginsProjection(candidateRoot, codexHome)) fail("candidate-account-shared-plugins-projection-failed");
    if (!sharedPluginsProjectionMatches(candidateRoot, codexHome, sealed)) fail("candidate-account-shared-plugins-mismatch");
  }
  assertLegacySharedPluginsSource(source.legacyDefinitionsRoot, source);
  return sealed;
}

/** Read-only package-source inspection for an operator preview. */
export function inspectSharedPluginPackages(
  legacyDefinitionsRoot: string,
  sharedPluginInventory: string,
): Readonly<SharedPluginsManifestV1> {
  const inventoryPath = canonicalPrivateSharedPluginInventory(sharedPluginInventory);
  return scanLegacySharedPlugins(exactAbsolute(legacyDefinitionsRoot, "invalid-legacy-definitions-root"), inventoryPath).manifest;
}

function scanLegacySharedPlugins(legacyDefinitionsRoot: string, inventoryPath: string): SharedPluginsSourceScanV1 {
  const inventory = readSharedPluginInventory(inventoryPath);
  if (inventory.plugins.length === 0) fail("legacy-shared-plugins-none-enabled");
  const cacheRoot = canonicalSharedPluginDirectory(join(legacyDefinitionsRoot, "plugins", "cache"), "legacy-shared-plugins-cache", false);
  const packages = inventory.plugins.map((plugin) => scanLegacySharedPluginPackage(cacheRoot, plugin));
  const normalizedPackages = packages.map((entry) => entry.package).sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId));
  const inventoryFingerprint = canonicalSha256Fingerprint(inventory);
  const exclusionsFingerprint = sharedPluginExclusionsFingerprint(normalizedPackages);
  const manifest: SharedPluginsManifestV1 = {
    version: 1,
    kind: "account-router-shared-plugins",
    inventoryFingerprint,
    exclusionsFingerprint,
    packages: normalizedPackages,
    fingerprint: canonicalSha256Fingerprint({
      inventoryFingerprint,
      exclusionsFingerprint,
      packages: normalizedPackages,
    }),
  };
  return { manifest, legacyDefinitionsRoot, inventoryPath, inventoryFingerprint, packages };
}

function readSharedPluginInventory(path: string): SharedPluginInventoryV1 {
  const bytes = readPrivateRegularFile(path, MAX_SHARED_PLUGIN_INVENTORY_BYTES, "shared-plugin-inventory");
  try {
    return parseSharedPluginInventory(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof SharedHistoryMigrationFailure) throw error;
    fail("invalid-shared-plugin-inventory");
  } finally {
    bytes.fill(0);
  }
}

function parseSharedPluginInventory(value: unknown): SharedPluginInventoryV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "plugins"])
    || value.version !== 1 || !Array.isArray(value.plugins)
    || value.plugins.length === 0 || value.plugins.length > 512) {
    fail("invalid-shared-plugin-inventory");
  }
  const plugins = value.plugins.map((entry) => isRecord(entry) && hasExactKeys(entry, ["pluginId", "version"])
    && typeof entry.pluginId === "string" && isSharedPluginId(entry.pluginId)
    && typeof entry.version === "string" && isSafeSharedPluginVersion(entry.version)
    ? { pluginId: entry.pluginId, version: entry.version } : null);
  if (plugins.some((entry) => entry === null)) fail("invalid-shared-plugin-inventory");
  const normalized = plugins as SharedPluginInventoryEntryV1[];
  if (normalized.some((entry, index) => index > 0 && compareCodeUnits(normalized[index - 1]!.pluginId, entry.pluginId) >= 0)) {
    fail("invalid-shared-plugin-inventory");
  }
  return { version: 1, plugins: normalized };
}

function scanLegacySharedPluginPackage(cacheRoot: string, plugin: SharedPluginInventoryEntryV1): SharedPluginSourcePackageV1 {
  const parsed = /^([a-z0-9][a-z0-9._-]{0,127})@([a-z0-9][a-z0-9._-]{0,127})$/.exec(plugin.pluginId);
  if (!parsed) fail("invalid-shared-plugin-id");
  const name = parsed[1]!;
  const registry = parsed[2]!;
  const version = plugin.version;
  const sourceRoot = canonicalSharedPluginDirectory(join(cacheRoot, registry, name, version), "legacy-shared-plugin-package", false);
  const directories: string[] = [];
  const files: SharedPluginSourceFileV1[] = [];
  const excludedFiles: SharedPluginExcludedSourceFileV1[] = [];
  let bytesTotal = 0;
  const visit = (directory: string, relativeDirectory: string, ancestors: ReadonlySet<string>): void => {
    const stat = lstatNoFollow(directory, "shared-plugin-directory");
    assertSharedPluginDirectory(stat, "shared-plugin-directory", false);
    const identity = `${stat.dev}:${stat.ino}`;
    if (ancestors.has(identity)) fail("shared-plugin-directory-cycle");
    const nextAncestors = new Set(ancestors); nextAncestors.add(identity);
    let names: string[];
    try { names = readdirSync(directory).sort(compareCodeUnits); } catch { fail("shared-plugin-directory-unreadable"); }
    for (const namePart of names) {
      if (!isSafeSharedPluginName(namePart)) fail("unsafe-shared-plugin-path");
      const relativePath = relativeDirectory ? `${relativeDirectory}/${namePart}` : namePart;
      const entry = resolveLegacySharedPluginEntry(join(directory, namePart), sourceRoot);
      if (entry.stat.isDirectory()) {
        if (isSharedPluginCredentialDirectoryName(namePart)) fail("shared-plugin-credential-directory-refused");
        assertSharedPluginDirectory(entry.stat, "shared-plugin-directory", false);
        directories.push(relativePath);
        if (directories.length + files.length > MAX_SHARED_PLUGIN_FILES) fail("shared-plugin-file-count-exceeded");
        visit(entry.path, relativePath, nextAncestors);
        continue;
      }
      if (isExactSharedPluginTransientLock(relativePath)) {
        if (entry.wasSymbolicLink) fail("shared-plugin-transient-lock-unsafe");
        assertSharedPluginTransientLock(entry.stat, "shared-plugin-transient-lock");
        excludedFiles.push({
          path: relativePath,
          bytes: entry.stat.size,
          sha256: digestPrivateFile(entry.path, entry.stat, "shared-plugin-excluded-source"),
          reason: "transient-lock",
          sourcePath: entry.path,
          device: entry.stat.dev,
          inode: entry.stat.ino,
          mtimeMs: entry.stat.mtimeMs,
        });
        if (directories.length + files.length + excludedFiles.length > MAX_SHARED_PLUGIN_FILES) fail("shared-plugin-file-count-exceeded");
        continue;
      }
      assertSharedPluginFile(entry.stat, "shared-plugin-file", false);
      if (namePart !== "config.toml" && isSharedPluginCredentialName(namePart)) {
        if (entry.wasSymbolicLink) fail("shared-plugin-credential-symlink-refused");
        excludedFiles.push({
          path: relativePath,
          bytes: entry.stat.size,
          sha256: digestPrivateFile(entry.path, entry.stat, "shared-plugin-excluded-source"),
          reason: "credential",
          sourcePath: entry.path,
          device: entry.stat.dev,
          inode: entry.stat.ino,
          mtimeMs: entry.stat.mtimeMs,
        });
        if (directories.length + files.length + excludedFiles.length > MAX_SHARED_PLUGIN_FILES) fail("shared-plugin-file-count-exceeded");
        continue;
      }
      const bytes = readSharedSkillsFile(entry.path, entry.stat, "shared-plugin-file");
      try {
        if (namePart === "config.toml") {
          if (!isApprovedSharedPluginConfig(relativePath, bytes)) fail("shared-plugin-config-not-approved");
          if (entry.wasSymbolicLink) fail("shared-plugin-config-symlink-refused");
        }
        bytesTotal += entry.stat.size;
        if (bytesTotal > MAX_SHARED_PLUGIN_BYTES || directories.length + files.length >= MAX_SHARED_PLUGIN_FILES) fail("shared-plugin-capacity-exceeded");
        files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes), sourcePath: entry.path, device: entry.stat.dev, inode: entry.stat.ino, mtimeMs: entry.stat.mtimeMs });
      } finally { bytes.fill(0); }
    }
  };
  visit(sourceRoot, "", new Set());
  const tree = {
    directories: directories.sort(compareCodeUnits),
    files: files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })).sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
  const normalizedExcluded = excludedFiles
    .map(({ path, bytes, sha256: digest, reason }) => ({ path, bytes, sha256: digest, reason }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    package: {
      pluginId: plugin.pluginId,
      registry,
      name,
      version,
      fingerprint: canonicalSha256Fingerprint(tree),
      exclusionsFingerprint: canonicalSha256Fingerprint(normalizedExcluded),
      excludedFiles: normalizedExcluded,
      fileCount: tree.files.length,
      bytes: bytesTotal,
    },
    sourceRoot,
    directories: tree.directories,
    files: files.sort((left, right) => compareCodeUnits(left.path, right.path)),
    excludedFiles: excludedFiles.sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
}

function isSharedPluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function isSafeSharedPluginVersion(value: string): boolean { return isSafeSharedPluginName(value); }

function resolveLegacySharedPluginEntry(path: string, packageRoot: string): { path: string; stat: Stats; wasSymbolicLink: boolean } {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { fail("shared-plugin-entry-missing-or-unsafe"); }
  if (!stat.isSymbolicLink()) return { path, stat, wasSymbolicLink: false };
  let target: string;
  try { target = realpathSync.native(path); } catch { fail("shared-plugin-symlink-unresolved"); }
  if (!isWithinSharedSkillsRoot(packageRoot, target)) fail("shared-plugin-symlink-target-untrusted");
  return { path: target, stat: assertResolvedSharedPluginPath(packageRoot, target), wasSymbolicLink: true };
}

function canonicalSharedPluginDirectory(path: string, label: string, requireReadOnly: boolean): string {
  const stat = lstatNoFollow(path, label); assertSharedPluginDirectory(stat, label, requireReadOnly);
  let canonical: string;
  try { canonical = realpathSync.native(path); } catch { fail(`${label}-missing-or-unsafe`); }
  if (canonical !== path) fail(`${label}-not-canonical`);
  return canonical;
}

function assertResolvedSharedPluginPath(root: string, target: string): Stats {
  if (!isWithinSharedSkillsRoot(root, target)) fail("shared-plugin-symlink-target-untrusted");
  let current = root;
  let stat = lstatNoFollow(root, "shared-plugin-package");
  assertSharedPluginDirectory(stat, "shared-plugin-package", false);
  const suffix = relative(root, target);
  for (const component of suffix ? suffix.split(sep) : []) {
    if (!isSafeSharedPluginName(component)) fail("shared-plugin-symlink-target-unsafe");
    current = join(current, component); stat = lstatNoFollow(current, "shared-plugin-symlink-target");
    if (current !== target) assertSharedPluginDirectory(stat, "shared-plugin-symlink-target", false);
  }
  return stat;
}

function copyLegacySharedPluginPackage(source: SharedPluginSourcePackageV1, cacheRoot: string): void {
  const destinationRoot = join(cacheRoot, source.package.registry, source.package.name, source.package.version);
  mkdirSync(dirname(destinationRoot), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  mkdirSync(destinationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  for (const directory of source.directories) mkdirSync(resolvedChild(destinationRoot, directory, "shared-plugin-copy-directory"), { mode: PRIVATE_DIRECTORY_MODE });
  for (const entry of source.files) {
    const stat = lstatNoFollow(entry.sourcePath, "shared-plugin-copy-source");
    assertSharedPluginFile(stat, "shared-plugin-copy-source", false);
    if (stat.dev !== entry.device || stat.ino !== entry.inode || stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.bytes) fail("legacy-shared-plugins-source-changed-during-migration");
    const bytes = readSharedSkillsFile(entry.sourcePath, stat, "shared-plugin-copy-source");
    try {
      if (sha256(bytes) !== entry.sha256) fail("legacy-shared-plugins-source-changed-during-migration");
      writePrivateFileNew(resolvedChild(destinationRoot, entry.path, "shared-plugin-copy-destination"), bytes, "shared-plugin-copy-destination");
    } finally { bytes.fill(0); }
  }
  // Excluded credentials are never materialized, but their immutable metadata
  // remains a source-drift boundary. Re-read and hash every one before the
  // candidate can advance so a swap cannot disappear from the receipt.
  for (const entry of source.excludedFiles) {
    const stat = lstatNoFollow(entry.sourcePath, "shared-plugin-excluded-source");
    if (entry.reason === "transient-lock") assertSharedPluginTransientLock(stat, "shared-plugin-transient-lock");
    else assertSharedPluginFile(stat, "shared-plugin-excluded-source", false);
    if (stat.dev !== entry.device || stat.ino !== entry.inode || stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.bytes) {
      fail("legacy-shared-plugins-source-changed-during-migration");
    }
    if (digestPrivateFile(entry.sourcePath, stat, "shared-plugin-excluded-source") !== entry.sha256) {
      fail("legacy-shared-plugins-source-changed-during-migration");
    }
  }
}

function scanMaterializedSharedPlugins(root: string, requireReadOnly: boolean, expected: SharedPluginsManifestV1): SharedPluginsManifestV1 {
  const cacheRoot = join(root, "cache");
  assertSharedPluginDirectory(lstatNoFollow(root, "shared-plugins-root"), "shared-plugins-root", requireReadOnly);
  assertSharedPluginDirectory(lstatNoFollow(cacheRoot, "shared-plugins-cache"), "shared-plugins-cache", requireReadOnly);
  const byRegistry = new Map<string, Map<string, SharedPluginPackageV1>>();
  for (const entry of expected.packages) {
    const byName = byRegistry.get(entry.registry) ?? new Map<string, SharedPluginPackageV1>();
    if (byName.has(entry.name)) fail("invalid-shared-plugins-manifest");
    byName.set(entry.name, entry); byRegistry.set(entry.registry, byName);
  }
  assertExactSharedPluginNames(cacheRoot, [...byRegistry.keys()], "shared-plugins-cache");
  const packages: SharedPluginPackageV1[] = [];
  for (const [registry, byName] of byRegistry) {
    const registryRoot = join(cacheRoot, registry);
    assertSharedPluginDirectory(lstatNoFollow(registryRoot, "shared-plugin-registry"), "shared-plugin-registry", requireReadOnly);
    assertExactSharedPluginNames(registryRoot, [...byName.keys()], "shared-plugin-registry");
    for (const [name, expectedPackage] of byName) {
      const nameRoot = join(registryRoot, name);
      assertSharedPluginDirectory(lstatNoFollow(nameRoot, "shared-plugin-name"), "shared-plugin-name", requireReadOnly);
      assertExactSharedPluginNames(nameRoot, [expectedPackage.version], "shared-plugin-name");
      const packageRoot = join(nameRoot, expectedPackage.version);
      const tree = scanMaterializedSharedPluginPackage(packageRoot, requireReadOnly);
      const actual = { ...expectedPackage, fingerprint: canonicalSha256Fingerprint(tree), fileCount: tree.files.length, bytes: tree.files.reduce((sum, file) => sum + file.bytes, 0) };
      if (actual.fingerprint !== expectedPackage.fingerprint || actual.fileCount !== expectedPackage.fileCount || actual.bytes !== expectedPackage.bytes) fail("shared-plugin-package-drift");
      packages.push(actual);
    }
  }
  packages.sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId));
  return {
    version: 1,
    kind: "account-router-shared-plugins",
    inventoryFingerprint: expected.inventoryFingerprint,
    exclusionsFingerprint: expected.exclusionsFingerprint,
    packages,
    fingerprint: canonicalSha256Fingerprint({
      inventoryFingerprint: expected.inventoryFingerprint,
      exclusionsFingerprint: expected.exclusionsFingerprint,
      packages,
    }),
  };
}

function assertExactSharedPluginNames(path: string, expected: readonly string[], label: string): void {
  let actual: string[];
  try { actual = readdirSync(path).sort(compareCodeUnits); } catch { fail(`${label}-unreadable`); }
  const normalizedExpected = [...expected].sort(compareCodeUnits);
  if (actual.length !== normalizedExpected.length || actual.some((name, index) => name !== normalizedExpected[index])) {
    fail(`${label}-unexpected-entry`);
  }
}

function scanMaterializedSharedPluginPackage(root: string, requireReadOnly: boolean): { directories: string[]; files: TreeManifestEntry[] } {
  assertSharedPluginDirectory(lstatNoFollow(root, "shared-plugin-package"), "shared-plugin-package", requireReadOnly);
  const directories: string[] = []; const files: TreeManifestEntry[] = []; let bytesTotal = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort(compareCodeUnits)) {
      if (!isSafeSharedPluginName(name)) fail("unsafe-shared-plugin-path");
      const path = join(directory, name); const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatNoFollow(path, "shared-plugin-entry");
      if (stat.isDirectory()) {
        if (isSharedPluginCredentialDirectoryName(name)) fail("shared-plugin-credential-directory-refused");
        assertSharedPluginDirectory(stat, "shared-plugin-directory", requireReadOnly); directories.push(relativePath); visit(path, relativePath); continue;
      }
      assertSharedPluginFile(stat, "shared-plugin-file", requireReadOnly); bytesTotal += stat.size;
      if (bytesTotal > MAX_SHARED_PLUGIN_BYTES || directories.length + files.length >= MAX_SHARED_PLUGIN_FILES) fail("shared-plugin-capacity-exceeded");
      if (name !== "config.toml" && isSharedPluginCredentialName(name)) fail("shared-plugin-credential-file-refused");
      const bytes = readSharedSkillsFile(path, stat, "shared-plugin-file");
      try {
        if (name === "config.toml" && !isApprovedSharedPluginConfig(relativePath, bytes)) fail("shared-plugin-config-not-approved");
        files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
      } finally { bytes.fill(0); }
    }
  };
  visit(root, "");
  return { directories: directories.sort(compareCodeUnits), files: files.sort((left, right) => compareCodeUnits(left.path, right.path)) };
}

function lockSharedPluginCache(root: string, manifest: SharedPluginsManifestV1): void {
  const cacheRoot = join(root, "cache");
  for (const entry of manifest.packages) {
    const packageRoot = join(cacheRoot, entry.registry, entry.name, entry.version);
    const tree = scanMaterializedSharedPluginPackage(packageRoot, false);
    for (const file of tree.files) chmodSync(resolvedChild(packageRoot, file.path, "shared-plugin-lock-file"), 0o400);
    for (const directory of [...tree.directories].sort((left, right) => compareCodeUnits(right, left))) chmodSync(resolvedChild(packageRoot, directory, "shared-plugin-lock-directory"), 0o500);
    chmodSync(packageRoot, 0o500); chmodSync(dirname(packageRoot), 0o500); chmodSync(dirname(dirname(packageRoot)), 0o500);
  }
  chmodSync(cacheRoot, 0o500); chmodSync(root, 0o500);
}

function materializeSharedPluginsProjection(stateRoot: string, codexHome: string): boolean {
  try {
    const manifest = readSharedPluginsManifest(stateRoot);
    if (!manifest || !sameSharedPluginsManifest(scanMaterializedSharedPlugins(join(stateRoot, SHARED_PLUGINS_DIRECTORY), true, manifest), manifest)) return false;
    const pluginsRoot = join(codexHome, "plugins"); const projection = join(pluginsRoot, "cache");
    if (existsNoFollow(pluginsRoot)) return false;
    mkdirSync(pluginsRoot, { mode: PRIVATE_DIRECTORY_MODE }); assertPrivateDirectory(pluginsRoot, "shared-plugin-projection-parent");
    symlinkSync(relative(pluginsRoot, join(stateRoot, SHARED_PLUGINS_DIRECTORY, "cache")), projection);
    return sharedPluginsProjectionMatches(stateRoot, codexHome, manifest);
  } catch { return false; }
}

function sharedPluginsProjectionMatches(stateRoot: string, codexHome: string, manifest?: SharedPluginsManifestV1): boolean {
  try {
    const expected = manifest ?? readSharedPluginsManifest(stateRoot);
    if (!expected || !sameSharedPluginsManifest(scanMaterializedSharedPlugins(join(stateRoot, SHARED_PLUGINS_DIRECTORY), true, expected), expected)) return false;
    const pluginsRoot = join(codexHome, "plugins"); assertPrivateDirectory(pluginsRoot, "shared-plugin-projection-parent");
    const projection = join(pluginsRoot, "cache"); const stat = lstatSync(projection);
    if (!stat.isSymbolicLink() || realpathSync.native(projection) !== join(stateRoot, SHARED_PLUGINS_DIRECTORY, "cache")) return false;
    return sameSharedPluginsManifest(scanMaterializedSharedPlugins(join(stateRoot, SHARED_PLUGINS_DIRECTORY), true, expected), expected);
  } catch { return false; }
}

function assertLegacySharedPluginsSource(legacyDefinitionsRoot: string, expected: SharedPluginsSourceScanV1): void {
  const actual = scanLegacySharedPlugins(legacyDefinitionsRoot, expected.inventoryPath);
  if (actual.inventoryFingerprint !== expected.inventoryFingerprint || !sameSharedPluginsManifest(actual.manifest, expected.manifest)) {
    fail("legacy-shared-plugins-source-changed-during-migration");
  }
}

function readSharedPluginsManifest(root: string): SharedPluginsManifestV1 {
  return parseSharedPluginsManifest(readPrivateJson(join(root, SHARED_PLUGINS_MANIFEST_FILE), 32 * 1024 * 1024, "shared-plugins-manifest"));
}

function parseSharedPluginsManifest(value: unknown): SharedPluginsManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "kind", "inventoryFingerprint", "exclusionsFingerprint", "packages", "fingerprint"])
    || value.version !== 1 || value.kind !== "account-router-shared-plugins" || !isSha256Fingerprint(value.inventoryFingerprint)
    || !isSha256Fingerprint(value.exclusionsFingerprint)
    || !Array.isArray(value.packages) || !isSha256Fingerprint(value.fingerprint)) fail("invalid-shared-plugins-manifest");
  const packages = value.packages.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["pluginId", "registry", "name", "version", "fingerprint", "exclusionsFingerprint", "excludedFiles", "fileCount", "bytes"])
      || typeof entry.pluginId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.pluginId)
      || typeof entry.registry !== "string" || typeof entry.name !== "string" || entry.pluginId !== `${entry.name}@${entry.registry}`
      || typeof entry.version !== "string" || !isSafeSharedPluginVersion(entry.version)
      || !isSha256Fingerprint(entry.fingerprint) || !isSha256Fingerprint(entry.exclusionsFingerprint)
      || !Array.isArray(entry.excludedFiles) || !isNonNegativeInteger(entry.fileCount) || !isNonNegativeInteger(entry.bytes)) return null;
    const excludedFiles = entry.excludedFiles.map((file) => {
      if (!isRecord(file) || !hasExactKeys(file, ["path", "bytes", "sha256", "reason"])
        || typeof file.path !== "string" || !isNonNegativeInteger(file.bytes)
        || !isSha256Fingerprint(file.sha256) || !isSharedPluginExclusionReason(file.reason)
        || !isValidSharedPluginExclusion(file as { path: string; bytes: number; sha256: Sha256Fingerprint; reason: SharedPluginExclusionReasonV1 })) return null;
      return file as unknown as SharedPluginExcludedFileV1;
    });
    if (excludedFiles.some((file) => file === null)) return null;
    const normalizedExcluded = [...excludedFiles as SharedPluginExcludedFileV1[]].sort((left, right) => compareCodeUnits(left.path, right.path));
    if (new Set(normalizedExcluded.map((file) => file.path)).size !== normalizedExcluded.length
      || canonicalSha256Fingerprint(normalizedExcluded) !== entry.exclusionsFingerprint) return null;
    return { ...entry, excludedFiles: normalizedExcluded } as unknown as SharedPluginPackageV1;
  });
  if (packages.some((entry) => entry === null) || packages.length === 0 || packages.length > 512) fail("invalid-shared-plugins-manifest");
  const normalized = [...packages as SharedPluginPackageV1[]].sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId));
  if (new Set(normalized.map((entry) => entry.pluginId)).size !== normalized.length
    || sharedPluginExclusionsFingerprint(normalized) !== value.exclusionsFingerprint
    || canonicalSha256Fingerprint({ inventoryFingerprint: value.inventoryFingerprint, exclusionsFingerprint: value.exclusionsFingerprint, packages: normalized }) !== value.fingerprint) {
    fail("invalid-shared-plugins-manifest");
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

function isSharedPluginExcludedPath(value: string): boolean {
  const components = value.split("/");
  return components.length > 0 && components.every(isSafeSharedPluginName)
    && components.at(-1) !== "config.toml" && isSharedPluginCredentialName(components.at(-1)!);
}

function isExactSharedPluginTransientLock(value: string): boolean { return value === ".venv/.lock"; }

function isSharedPluginExclusionReason(value: unknown): value is SharedPluginExclusionReasonV1 {
  return value === "credential" || value === "transient-lock";
}

function isValidSharedPluginExclusion(value: SharedPluginExcludedFileV1): boolean {
  return value.reason === "credential" ? isSharedPluginExcludedPath(value.path)
    : isExactSharedPluginTransientLock(value.path) && value.bytes === 0 && value.sha256 === EMPTY_SHA256_FINGERPRINT;
}

function sameSharedPluginsManifest(left: SharedPluginsManifestV1, right: SharedPluginsManifestV1): boolean { return canonicalJson(left) === canonicalJson(right); }

function isSafeSharedPluginName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function isSharedPluginCredentialName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.")
    || ["env", "env_vars", "auth", "auth.json", "authorization.json", "cookies", "cookies.json", "credentials", "credentials.json", "oauth", "oauth.json", "token", "token.json", "tokens", "tokens.json", "secret.json", "secrets.json", "client_secret.json", "api-key.json", "api_key.json", ".netrc", "config.toml"].includes(normalized)
    || normalized.endsWith(".sqlite");
}

/** Code packages commonly have `auth`/`cookie` source directories; only names
 * that can themselves be credential containers are rejected as directories. */
function isSharedPluginCredentialDirectoryName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.")
    || ["env", "env_vars", "credentials", "secrets", "auth.json", "authorization.json", "cookies.json", "credentials.json", "oauth.json", "token.json", "tokens.json", "secret.json", "secrets.json", "client_secret.json", "api-key.json", "api_key.json", ".netrc", "config.toml"].includes(normalized)
    || normalized.endsWith(".sqlite");
}

/** The only package-internal configuration admitted to the sanitized snapshot. */
function isApprovedSharedPluginConfig(relativePath: string, bytes: Buffer): boolean {
  const components = relativePath.split("/");
  if (components.length < 2 || components.at(-1) !== "config.toml" || components.at(-2) !== ".codex") return false;
  return bytes.toString("utf8") === "[features]\nhooks = true\n"
    || bytes.toString("utf8") === "[features]\nhooks = false\n";
}

function sharedPluginExclusionsFingerprint(packages: readonly SharedPluginPackageV1[]): Sha256Fingerprint {
  const exclusions = packages.flatMap((entry) => entry.excludedFiles.map((file) => ({ pluginId: entry.pluginId, ...file })))
    .sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId) || compareCodeUnits(left.path, right.path));
  return canonicalSha256Fingerprint(exclusions);
}

function assertSharedPluginDirectory(stat: Stats, label: string, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  const mode = stat.mode & 0o7777;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0 || (requireReadOnly && mode !== 0o500)) fail(`${label}-unsafe`);
}

function assertSharedPluginFile(stat: Stats, label: string, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  const mode = stat.mode & 0o7777;
  // Marketplace cache files are legitimately mode 0664.  The input stays
  // safe because it is owner-bound and every read is identity/hash rechecked;
  // only the manager-global materialization must be exactly sealed 0400.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner)
    || (!requireReadOnly && ((mode & 0o002) !== 0 || (mode & 0o6000) !== 0))
    || (requireReadOnly && mode !== 0o400)) fail(`${label}-unsafe`);
}

function assertSharedPluginTransientLock(stat: Stats, label: string): void {
  const owner = process.getuid?.();
  const mode = stat.mode & 0o7777;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0
    || (owner !== undefined && stat.uid !== owner) || (mode & 0o6000) !== 0) fail(`${label}-unsafe`);
}

function isSafeSharedSkillsName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value)
    && !isSharedSkillsCredentialFileName(value);
}

function isSharedSkillsCredentialFileName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.") || [
    "auth.json", "authorization.json", "cookies.json", "credentials.json", "oauth.json",
    "token.json", "tokens.json", "client_secret.json", ".netrc", ".npmrc",
  ].includes(normalized);
}

function assertSharedSkillsDirectory(stat: Stats, label: string, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0 || (requireReadOnly && (stat.mode & 0o200) !== 0)) {
    fail(`${label}-unsafe`);
  }
}

function assertSharedSkillsFile(stat: Stats, label: string, requireReadOnly: boolean): void {
  const owner = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0 || (requireReadOnly && (stat.mode & 0o200) !== 0)) {
    fail(`${label}-unsafe`);
  }
}

function readSharedSkillsFile(path: string, expected: Stats, label: string): Buffer {
  let descriptor: number | undefined;
  let bytes: Buffer | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) {
      fail(`${label}-changed-during-read`);
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!read) fail(`${label}-short-read`);
      offset += read;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail(`${label}-changed-during-read`);
    }
    const result = bytes;
    bytes = null;
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes?.fill(0);
  }
}

/**
 * The sole canonical-history producer used by both capacity preview and apply.
 * It reads a sealed legacy snapshot and allocates buffers only in memory; the
 * caller owns their disposal and any later filesystem materialization.
 */
interface CanonicalHistoryProjectionV1 {
  store: CanonicalHistoryStoreV1;
  evidence: MigrationSourceEvidenceV1;
  snapshotBytes: Buffer;
  journalBytes: Buffer;
  sourceEvidenceBytes: Buffer;
  dispose(): void;
}

function projectCanonicalHistory(
  snapshotRoot: string,
  snapshotManifest: TreeManifest,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  projectedAt: string,
): CanonicalHistoryProjectionV1 {
  if (!isCanonicalUtcTimestamp(projectedAt)) fail("invalid-shared-history-migration-clock");
  assertPrivateDirectory(snapshotRoot, "pre-migration-snapshot-root");
  assertManifest(snapshotManifest);
  assertTreeManifest(snapshotRoot, snapshotManifest, "pre-migration-snapshot-changed-before-canonicalization");
  const secret = readPrivateRegularFile(join(snapshotRoot, "control-secret.v1"), 64, "candidate-control-secret");
  if (secret.byteLength !== 32) {
    secret.fill(0);
    fail("invalid-candidate-control-secret");
  }
  let snapshotBytes: Buffer | null = null;
  let journalBytes: Buffer | null = null;
  let sourceEvidenceBytes: Buffer | null = null;
  try {
    const aliases = readSnapshotHistoryAdoptionAliases(snapshotRoot, snapshotManifest, proof, secret);
    const imported = importLegacyConversations(snapshotRoot, snapshotManifest, proof, secret, projectedAt);
    const { store, evidence } = createCanonicalHistoryStore(
      proof,
      secret,
      snapshotManifest.fingerprint,
      imported,
      aliases,
      true,
    );
    // Preview must measure an over-capacity document rather than treating a
    // recoverable capacity condition as malformed source data. Apply checks
    // `withinCapacity` before writing a runtime-readable candidate.
    const parsed = parseCanonicalHistoryStore(store, true);
    assertMigrationSourceEvidence(evidence, secret, snapshotManifest.fingerprint, parsed);
    snapshotBytes = runtimeCanonicalJsonBytes(parsed);
    journalBytes = runtimeCanonicalJournalBytes(parsed);
    sourceEvidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`, "utf8");
    const resultSnapshotBytes = snapshotBytes;
    const resultJournalBytes = journalBytes;
    const resultSourceEvidenceBytes = sourceEvidenceBytes;
    const result: CanonicalHistoryProjectionV1 = {
      store: parsed,
      evidence,
      snapshotBytes: resultSnapshotBytes,
      journalBytes: resultJournalBytes,
      sourceEvidenceBytes: resultSourceEvidenceBytes,
      dispose: () => {
        resultSnapshotBytes.fill(0);
        resultJournalBytes.fill(0);
        resultSourceEvidenceBytes.fill(0);
      },
    };
    snapshotBytes = null;
    journalBytes = null;
    sourceEvidenceBytes = null;
    return result;
  } finally {
    secret.fill(0);
    snapshotBytes?.fill(0);
    journalBytes?.fill(0);
    sourceEvidenceBytes?.fill(0);
  }
}

/** Exact runtime formatting: insertion order and newline must match its writer. */
function runtimeCanonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

/** Exact full runtime WAL envelope, including its digest over JSON.stringify(store). */
function runtimeCanonicalJournalBytes(store: CanonicalHistoryStoreV1): Buffer {
  const serializedStore = JSON.stringify(store);
  const record = {
    version: 1 as const,
    digest: `sha256:${createHash("sha256").update(serializedStore, "utf8").digest("hex")}` as Sha256Fingerprint,
    document: store,
  };
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function assertCanonicalProjectionMatchesCapacity(
  projected: CanonicalHistoryProjectionV1,
  capacity: SharedHistoryCapacityPreviewV1,
): void {
  const counts: SharedHistoryCapacityCountsV1 = {
    conversations: projected.store.conversations.length,
    segments: projected.store.conversations.reduce((sum, conversation) => sum + conversation.segments.length, 0),
    turns: projected.store.conversations.reduce(
      (sum, conversation) => sum + conversation.segments.reduce((turns, segment) => turns + segment.turns.length, 0),
      0,
    ),
    fullConversations: projected.store.conversations.filter((conversation) => conversation.availability === "complete").length,
    partialConversations: projected.store.conversations.filter((conversation) => conversation.availability === "partial").length,
  };
  const projection: SharedHistoryCapacityProjectionBindingV1 = {
    snapshot: { bytes: projected.snapshotBytes.byteLength, sha256: sha256(projected.snapshotBytes) },
    journal: { bytes: projected.journalBytes.byteLength, sha256: sha256(projected.journalBytes) },
    sourceEvidence: { bytes: projected.sourceEvidenceBytes.byteLength, sha256: sha256(projected.sourceEvidenceBytes) },
  };
  if (canonicalJson(counts) !== canonicalJson(capacity.counts)
    || canonicalJson(projection) !== canonicalJson(capacity.projection)) {
    fail("shared-history-capacity-projection-mismatch");
  }
}

function materializeCanonicalHistoryCandidate(
  candidateRoot: string,
  snapshotRoot: string,
  snapshotManifest: TreeManifest,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  projectedAt: string,
  capacity: SharedHistoryCapacityPreviewV1,
): CanonicalJournalSummary {
  if (!isCanonicalUtcTimestamp(projectedAt)) fail("invalid-shared-history-migration-clock");
  assertPrivateDirectory(candidateRoot, "candidate-root");
  const projected = projectCanonicalHistory(snapshotRoot, snapshotManifest, proof, projectedAt);
  const secret = readPrivateRegularFile(join(candidateRoot, "control-secret.v1"), 64, "candidate-control-secret");
  if (secret.byteLength !== 32) {
    secret.fill(0);
    projected.dispose();
    fail("invalid-candidate-control-secret");
  }
  try {
    assertCanonicalProjectionMatchesCapacity(projected, capacity);
    assertSharedHistoryCapacityWithinBounds(capacity);
    const configPath = join(candidateRoot, "account-router-config.json");
    const config = parseLegacyV2Config(readPrivateJson(configPath, 64 * 1024, "candidate-v2-config"));
    if (config.fingerprint !== proof.configFingerprint) fail("candidate-v2-config-proof-mismatch");
    writePrivateJsonReplace(configPath, createGlobalV3Config(config, projectedAt));
    const canonicalPath = join(candidateRoot, CANONICAL_HISTORY_FILE);
    writePrivateFileNew(canonicalPath, projected.snapshotBytes, "candidate-canonical-history");
    const evidencePath = join(candidateRoot, CANONICAL_HISTORY_MIGRATION_SOURCES_FILE);
    writePrivateFileNew(evidencePath, projected.sourceEvidenceBytes, "candidate-canonical-history-source-evidence");
    fsyncDirectory(candidateRoot);
    const bytes = readPrivateRegularFile(canonicalPath, CANONICAL_HISTORY_MAX_BYTES_V1, "candidate-canonical-history");
    try {
      const parsed = parseCanonicalHistoryStore(JSON.parse(bytes.toString("utf8")) as unknown);
      if (sha256(bytes) !== capacity.projection.snapshot.sha256 || bytes.byteLength !== capacity.projection.snapshot.bytes) {
        fail("shared-history-capacity-projection-mismatch");
      }
      assertMigrationSourceEvidence(
        readPrivateJson(
          evidencePath,
          CANONICAL_HISTORY_MIGRATION_EVIDENCE_MAX_BYTES_V1,
          "candidate-canonical-history-source-evidence",
        ),
        secret,
        snapshotManifest.fingerprint,
        parsed,
      );
      return {
        fingerprint: sha256(bytes),
        conversationCount: parsed.conversations.length,
        segmentCount: parsed.conversations.reduce((count, conversation) => count + conversation.segments.length, 0),
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    secret.fill(0);
    projected.dispose();
  }
}

/**
 * Consume alias provenance only from the immutable migration snapshot. A
 * previously inspected proof is compared byte-for-byte at the canonical JSON
 * layer, so a late artifact write cannot become an unreviewed alias edge.
 */
function readSnapshotHistoryAdoptionAliases(
  snapshotRoot: string,
  snapshotManifest: TreeManifest,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  secret: Buffer,
): HistoryAdoptionAliasesV1 | null {
  const entry = snapshotManifest.files.find((candidate) => candidate.path === ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE) ?? null;
  if (proof.aliases === null) {
    if (entry !== null) fail("history-adoption-aliases-snapshot-mismatch");
    return null;
  }
  if (entry === null) fail("history-adoption-aliases-snapshot-mismatch");
  const path = resolvedChild(snapshotRoot, entry.path, "history-adoption-aliases-snapshot");
  const aliases = parseHistoryAdoptionAliases(readPrivateRegularFile(
    path,
    HISTORY_ADOPTION_MAX_ALIASES_BYTES,
    "history-adoption-aliases-snapshot",
  ));
  if (!verifyHistoryAdoptionAliases(aliases, secret)) fail("history-adoption-aliases-hmac-invalid");
  assertHistoryAdoptionAliasesBindCompletedProof({
    aliases,
    intent: proof.intent,
    receipt: proof.receipt,
    owners: proof.owners,
    accountOpaqueIds: proof.accountOpaqueIds,
  });
  if (canonicalJson(aliases) !== canonicalJson(proof.aliases)) {
    fail("history-adoption-aliases-snapshot-mismatch");
  }
  return aliases;
}

interface LegacyV2Config {
  schemaVersion: 2;
  mode: "manual" | "quota_aware";
  policy: "quota_aware_v1" | null;
  generation: number;
  fingerprint: Sha256Fingerprint;
  protocolFingerprint: Sha256Fingerprint;
  primaryOpaqueAccountId: OpaqueAccountId;
  accounts: Array<{
    opaqueAccountId: OpaqueAccountId;
    included: boolean;
    weight: number;
    capabilityFingerprint: Sha256Fingerprint;
    label: string;
  }>;
  updatedAt: string;
}

interface GlobalV3Config {
  schemaVersion: 3;
  mode: "manual" | "quota_aware";
  policy: "quota_aware_v2" | null;
  generation: number;
  fingerprint: Sha256Fingerprint;
  protocolFingerprint: Sha256Fingerprint;
  primaryOpaqueAccountId: OpaqueAccountId;
  accounts: LegacyV2Config["accounts"];
  updatedAt: string;
}

function parseLegacyV2Config(value: unknown): LegacyV2Config {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ])) fail("invalid-candidate-v2-config");
  if (value.schemaVersion !== 2
    || (value.mode !== "manual" && value.mode !== "quota_aware")
    || (value.mode === "quota_aware" ? value.policy !== "quota_aware_v1" : value.policy !== null)
    || !isPositiveInteger(value.generation)
    || !isSha256Fingerprint(value.fingerprint)
    || !isSha256Fingerprint(value.protocolFingerprint)
    || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !isCanonicalUtcTimestamp(value.updatedAt)
    || !Array.isArray(value.accounts) || value.accounts.length !== 2) {
    fail("invalid-candidate-v2-config");
  }
  const accounts = value.accounts.map((account) => parseLegacyV2Account(account));
  if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length
    || !accounts.every((account) => account.included)
    || !accounts.some((account) => account.opaqueAccountId === value.primaryOpaqueAccountId)) {
    fail("invalid-candidate-v2-config");
  }
  const config: LegacyV2Config = {
    schemaVersion: 2,
    mode: value.mode as LegacyV2Config["mode"],
    policy: value.policy as LegacyV2Config["policy"],
    generation: value.generation,
    fingerprint: value.fingerprint,
    protocolFingerprint: value.protocolFingerprint,
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    accounts,
    updatedAt: value.updatedAt,
  };
  if (routerConfigDigest(config) !== config.fingerprint) fail("candidate-v2-config-fingerprint-mismatch");
  return config;
}

function parseLegacyV2Account(value: unknown): LegacyV2Config["accounts"][number] {
  if (!isRecord(value) || !hasExactKeys(value, ["opaqueAccountId", "included", "weight", "capabilityFingerprint", "label"])
    || !isOpaqueAccountId(value.opaqueAccountId)
    || typeof value.included !== "boolean"
    || !isPositiveInteger(value.weight) || value.weight > 100
    || !isSha256Fingerprint(value.capabilityFingerprint)
    || !isSafeLocalLabel(value.label)) fail("invalid-candidate-v2-config");
  return {
    opaqueAccountId: value.opaqueAccountId,
    included: value.included,
    weight: value.weight,
    capabilityFingerprint: value.capabilityFingerprint,
    label: value.label,
  };
}

function isSafeLocalLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s+/g, " ");
  return value === normalized
    && value.length >= 1
    && value.length <= 80
    && !/[@/\\]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function createGlobalV3Config(config: LegacyV2Config, updatedAt: string): GlobalV3Config {
  if (!isCanonicalUtcTimestamp(updatedAt) || config.generation >= Number.MAX_SAFE_INTEGER) fail("invalid-global-v3-config-generation");
  const unsigned = {
    schemaVersion: 3 as const,
    mode: config.mode,
    policy: config.mode === "quota_aware" ? "quota_aware_v2" as const : null,
    generation: config.generation + 1,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: config.accounts.map((account) => ({ ...account })),
  };
  return {
    ...unsigned,
    fingerprint: routerConfigDigest(unsigned),
    updatedAt,
  };
}

function routerConfigDigest(config: Pick<GlobalV3Config | LegacyV2Config,
  "schemaVersion" | "mode" | "policy" | "generation" | "protocolFingerprint" | "primaryOpaqueAccountId" | "accounts">): Sha256Fingerprint {
  return canonicalSha256Fingerprint({
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
      weight: account.weight,
      capabilityFingerprint: account.capabilityFingerprint,
      label: account.label,
    })),
  });
}

function createCanonicalHistoryStore(
  proof: CompletedLegacyV2HistoryAdoptionProof,
  secret: Buffer,
  snapshotFingerprint: Sha256Fingerprint,
  imported: readonly ImportedLegacyConversation[],
  aliases: HistoryAdoptionAliasesV1 | null,
  allowConversationCapacityOverflow = false,
): { store: CanonicalHistoryStoreV1; evidence: MigrationSourceEvidenceV1 } {
  const byMember = new Map(imported.map((entry) => [legacyMemberKey(entry.opaqueAccountId, entry.nativeThreadId), entry]));
  if (byMember.size !== imported.length) fail("legacy-snapshot-duplicate-thread-source");
  const aliasBySource = new Map<string, { record: HistoryAdoptionAliasRecordV1; copy: ImportedLegacyConversation }>();
  const aliasCopies = new Set<string>();
  for (const alias of aliases?.aliases ?? []) {
    const sourceKey = legacyMemberKey(alias.sourceOpaqueAccountId, alias.sourceNativeThreadId);
    const copyKey = legacyMemberKey(alias.copyOpaqueAccountId, alias.copyNativeThreadId);
    const source = byMember.get(sourceKey);
    const copy = byMember.get(copyKey);
    if (!source || !copy || aliasBySource.has(sourceKey) || aliasCopies.has(copyKey)) {
      fail("history-adoption-aliases-snapshot-member-missing");
    }
    assertAliasMatchesImmutableSnapshot(alias, source, copy);
    aliasBySource.set(sourceKey, { record: alias, copy });
    aliasCopies.add(copyKey);
  }
  const roots = imported.filter((entry) => !aliasCopies.has(legacyMemberKey(entry.opaqueAccountId, entry.nativeThreadId)));
  const references: MigrationSourceReferenceV1[] = [];
  const conversations = roots.map((source) => {
    const nativeThreadId = source.nativeThreadId;
    const opaqueAccountId = source.opaqueAccountId;
    assertNativeId(nativeThreadId, "legacy-native-thread-id");
    const alias = aliasBySource.get(legacyMemberKey(opaqueAccountId, nativeThreadId));
    const binding = {
      sourceFingerprint: proof.receipt.sourceFingerprint,
      opaqueAccountId,
      rootNativeThreadId: nativeThreadId,
    };
    const conversationId = deterministicHandle(secret, "lc_", { kind: "conversation", ...binding }) as `lc_${string}`;
    const segmentId = deterministicHandle(secret, "ls_", { kind: "segment", ...binding }) as `ls_${string}`;
    const publicThreadId = deterministicHandle(secret, "lh_", { kind: "public-thread", ...binding }) as `lh_${string}`;
    const timestamp = source.createdAt;
    const turns = source.turns;
    const availability = source.partial || turns.length === 0 ? "partial" as const : "complete" as const;
    references.push({
      conversationId,
      opaqueAccountId,
      nativeThreadId,
      disposition: source.sourceRelativePath === null ? "receipt-only" : availability === "complete" ? "imported" : "partial",
      snapshotRelativePath: source.sourceRelativePath,
      sourceDigest: source.sourceDigest,
      importedTurnCount: turns.length,
      physicalAliases: alias ? [{
        copyOperationId: alias.record.copyOperationId,
        opaqueAccountId: alias.copy.opaqueAccountId,
        nativeThreadId: alias.copy.nativeThreadId,
        snapshotRelativePath: alias.copy.sourceRelativePath!,
        sourceDigest: alias.copy.sourceDigest,
        portableTranscriptDigest: alias.record.portableTranscriptDigest,
      }] : [],
    });
    return {
      conversationId,
      rootNativeThreadId: nativeThreadId,
      title: source.title,
      createdAt: timestamp,
      updatedAt: source.updatedAt,
      availability,
      publicThreadId,
      activeClient: null,
      segments: [{
        segmentId,
        opaqueAccountId,
        nativeThreadId,
        state: "committed" as const,
        createdAt: timestamp,
        committedAt: source.updatedAt,
        turns,
      }],
    };
  }).sort((left, right) => compareCodeUnits(left.conversationId, right.conversationId));
  const store: CanonicalHistoryStoreV1 = { version: 1, conversations };
  parseCanonicalHistoryStore(store, allowConversationCapacityOverflow);
  const unsigned = {
    version: 1 as const,
    kind: "canonical-history-migration-sources" as const,
    snapshotFingerprint,
    references: references.sort((left, right) => compareCodeUnits(left.conversationId, right.conversationId)),
  };
  const evidence: MigrationSourceEvidenceV1 = {
    ...unsigned,
    hmac: migrationHmac(secret, unsigned),
  };
  return { store, evidence };
}

function assertAliasMatchesImmutableSnapshot(
  alias: HistoryAdoptionAliasRecordV1,
  source: ImportedLegacyConversation,
  copy: ImportedLegacyConversation,
): void {
  if (source.sourceRelativePath === null || copy.sourceRelativePath === null
    || source.sourceDigest !== alias.sourceRolloutSha256
    || copy.sourceDigest !== alias.copyRolloutSha256
    || source.portableTranscriptDigest === null
    || copy.portableTranscriptDigest === null
    || source.portableTranscriptDigest !== alias.portableTranscriptDigest
    || copy.portableTranscriptDigest !== alias.portableTranscriptDigest) {
    fail("history-adoption-aliases-snapshot-digest-mismatch");
  }
}

function legacyMemberKey(opaqueAccountId: OpaqueAccountId, nativeThreadId: string): string {
  return `${opaqueAccountId}\0${nativeThreadId}`;
}

function deterministicHandle(secret: Buffer, prefix: string, payload: unknown): string {
  if (secret.byteLength !== 32) fail("invalid-candidate-control-secret");
  return `${prefix}${createHmac("sha256", secret)
    .update("shared-history-migration:v1\0", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("base64url")}`;
}

function migrationHmac(secret: Buffer, payload: unknown): `hmac-sha256:${string}` {
  if (secret.byteLength !== 32) fail("invalid-candidate-control-secret");
  return `hmac-sha256:${createHmac("sha256", secret)
    .update("shared-history-migration-source-evidence:v1\0", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex")}` as `hmac-sha256:${string}`;
}

/**
 * Decode every physical rollout in a receipt-bound account home as a distinct
 * logical source. Equality is never consulted here: only a separate signed
 * alias proof can later collapse two of these sources into one conversation.
 */
function importLegacyConversations(
  snapshotRoot: string,
  snapshotManifest: TreeManifest,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  secret: Buffer,
  fallbackTimestamp: string,
): readonly ImportedLegacyConversation[] {
  if (!isCanonicalUtcTimestamp(fallbackTimestamp)) fail("invalid-shared-history-migration-clock");
  const owner = proof.legacyOwnerOpaqueAccountId;
  const allowedAccounts = new Set(proof.accountOpaqueIds);
  const byMember = new Map<string, ImportedLegacyConversation>();
  for (const entry of snapshotManifest.files) {
    const opaqueAccountId = legacyRolloutOpaqueAccountId(entry.path, allowedAccounts);
    if (!opaqueAccountId) continue;
    const sourcePath = resolvedChild(snapshotRoot, entry.path, "legacy-snapshot-rollout");
    const threadId = legacyRolloutThreadId(sourcePath);
    if (!threadId) fail("legacy-snapshot-rollout-invalid-thread-id");
    const key = legacyMemberKey(opaqueAccountId, threadId);
    if (byMember.has(key)) fail("legacy-snapshot-duplicate-thread-source");
    const parsed = parseLegacyRollout(sourcePath, threadId, entry.sha256, secret, fallbackTimestamp);
    byMember.set(key, {
      opaqueAccountId,
      nativeThreadId: threadId,
      sourceRelativePath: entry.path,
      sourceDigest: entry.sha256,
      turns: parsed.turns,
      title: parsed.title,
      partial: parsed.partial,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      portableTranscriptDigest: portableTranscriptDigestForAlias(parsed.turns, parsed.partial),
    });
  }

  for (const nativeThreadId of proof.owners.threadIds) {
    const key = legacyMemberKey(owner, nativeThreadId);
    if (!byMember.has(key)) {
      byMember.set(key, {
        opaqueAccountId: owner,
        nativeThreadId,
        sourceRelativePath: null,
        sourceDigest: proof.receipt.sourceFingerprint,
        turns: [],
        title: null,
        partial: true,
        createdAt: proof.owners.adoptedAt,
        updatedAt: proof.owners.adoptedAt,
        portableTranscriptDigest: null,
      });
    }
  }
  return [...byMember.values()].sort((left, right) => compareCodeUnits(
    legacyMemberKey(left.opaqueAccountId, left.nativeThreadId),
    legacyMemberKey(right.opaqueAccountId, right.nativeThreadId),
  ));
}

function legacyRolloutOpaqueAccountId(
  path: string,
  allowedAccounts: ReadonlySet<OpaqueAccountId>,
): OpaqueAccountId | null {
  if (!path.endsWith(".jsonl")) return null;
  const parts = path.split("/");
  if (parts.length < 5 || parts[0] !== "accounts" || !isOpaqueAccountId(parts[1])
    || parts[2] !== "codex-home" || (parts[3] !== "sessions" && parts[3] !== "archived_sessions")) {
    return null;
  }
  return allowedAccounts.has(parts[1]) ? parts[1] : null;
}

/** Hash safe, ordered complete transcript items only; never native IDs or timing. */
function portableTranscriptDigestForAlias(
  turns: readonly CanonicalHistoryTurnV1[],
  partial: boolean,
): Sha256Fingerprint | null {
  if (partial || turns.length === 0) return null;
  const transcripts = [] as CanonicalPortableTranscriptItemV1[][];
  for (const turn of turns) {
    if (turn.state !== "committed" || turn.phase !== "committed" || turn.portableTranscript === null) return null;
    transcripts.push([...turn.portableTranscript.items]);
  }
  const bytes = Buffer.from(JSON.stringify(transcripts), "utf8");
  try {
    return bytes.byteLength <= MAX_LEGACY_ROLLOUT_BYTES ? sha256(bytes) : null;
  } finally {
    bytes.fill(0);
  }
}

function legacyRolloutThreadId(path: string): string | null {
  const first = readFirstPrivateLine(path, "legacy-snapshot-rollout");
  let value: unknown;
  try {
    value = JSON.parse(first) as unknown;
  } catch {
    return null;
  }
  const payload = isRecord(value) && value.type === "session_meta" && isRecord(value.payload)
    ? value.payload
    : isRecord(value) && isRecord(value.session_meta) && isRecord(value.session_meta.payload)
      ? value.session_meta.payload
      : null;
  return payload && isNativeId(payload.id) ? payload.id : null;
}

function readFirstPrivateLine(path: string, label: string): string {
  const expected = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(expected, label);
  let descriptor: number | undefined;
  const chunks: Buffer[] = [];
  let used = 0;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!sameFile(expected, fstatSync(descriptor))) fail(`${label}-changed`);
    const block = Buffer.allocUnsafe(4 * 1024);
    try {
      while (used <= 128 * 1024) {
        const count = readSync(descriptor, block, 0, block.byteLength, null);
        if (count === 0) break;
        const end = block.subarray(0, count).indexOf(0x0a);
        if (end >= 0) {
          chunks.push(Buffer.from(block.subarray(0, end)));
          used += end;
          break;
        }
        chunks.push(Buffer.from(block.subarray(0, count)));
        used += count;
      }
    } finally {
      block.fill(0);
    }
    if (used > 128 * 1024 || !sameFile(expected, fstatSync(descriptor))) fail(`${label}-first-line-invalid`);
    const line = Buffer.concat(chunks).toString("utf8");
    if (!line || /[\u0000-\u001f\u007f]/.test(line)) fail(`${label}-first-line-invalid`);
    return line;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    for (const chunk of chunks) chunk.fill(0);
  }
}

interface ParsedLegacyRollout {
  turns: readonly CanonicalHistoryTurnV1[];
  title: string | null;
  partial: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PendingLegacyEnvelopeTurn {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string | null;
  readonly startedAt: string;
  readonly items: LegacyCollectedItem[];
  ambiguous: boolean;
}

interface LegacyCollectedItem {
  readonly value: Record<string, unknown>;
  readonly sourceItemId: string | null;
  readonly digest: Sha256Fingerprint;
  /** At most one persisted copy from each envelope family may mirror this item. */
  readonly origins: Set<"event_msg" | "response_item">;
}

function parseLegacyRollout(
  sourcePath: string,
  expectedThreadId: string,
  sourceDigest: Sha256Fingerprint,
  secret: Buffer,
  fallbackTimestamp: string,
): ParsedLegacyRollout {
  const stat = lstatNoFollow(sourcePath, "legacy-snapshot-rollout");
  assertPrivateRegularFileStat(stat, "legacy-snapshot-rollout");
  if (stat.size > MAX_LEGACY_ROLLOUT_BYTES) {
    return emptyPartialLegacyRollout(fallbackTimestamp);
  }
  const bytes = readPrivateRegularFile(sourcePath, MAX_LEGACY_ROLLOUT_BYTES, "legacy-snapshot-rollout");
  try {
    const text = bytes.toString("utf8");
    if (text.length === 0 || /\u0000/.test(text)) return emptyPartialLegacyRollout(fallbackTimestamp);
    const rawLines = text.split("\n");
    if (rawLines.at(-1) === "") rawLines.pop();
    if (rawLines.length < 1 || rawLines.length > MAX_LEGACY_ROLLOUT_LINES) return emptyPartialLegacyRollout(fallbackTimestamp);
    const first = parseLegacyJsonLine(rawLines[0] ?? "");
    if (!first || legacySessionMetaId(first) !== expectedThreadId) return emptyPartialLegacyRollout(fallbackTimestamp);
    const sourceTitle = legacySessionMetaTitle(first);
    const sourceStartedAt = legacySessionMetaTimestamp(first) ?? fallbackTimestamp;

    const pending = new Map<string, PendingLegacyEnvelopeTurn>();
    const turns: CanonicalHistoryTurnV1[] = [];
    const nativeTurnIds = new Set<string>();
    let partial = false;
    for (const line of rawLines.slice(1)) {
      const record = parseLegacyJsonLine(line);
      if (!record) {
        partial = true;
        continue;
      }
      const direct = parseDirectCompletedLegacyTurn(record, expectedThreadId, sourceDigest, secret, turns.length);
      if (direct.kind === "parsed") {
        if ((direct.turn.nativeTurnId && nativeTurnIds.has(direct.turn.nativeTurnId)) || turns.some((turn) => turn.turnId === direct.turn.turnId)) {
          partial = true;
        } else {
          if (direct.turn.nativeTurnId) nativeTurnIds.add(direct.turn.nativeTurnId);
          turns.push(direct.turn);
        }
        continue;
      }
      if (direct.kind === "invalid") {
        partial = true;
        continue;
      }
      const envelope = parseLegacyEnvelopeRecord(record, expectedThreadId, sourceDigest, secret, turns.length, pending);
      if (envelope.kind === "parsed") {
        if ((envelope.turn.nativeTurnId && nativeTurnIds.has(envelope.turn.nativeTurnId)) || turns.some((turn) => turn.turnId === envelope.turn.turnId)) {
          partial = true;
        } else {
          if (envelope.turn.nativeTurnId) nativeTurnIds.add(envelope.turn.nativeTurnId);
          turns.push(envelope.turn);
        }
      } else if (envelope.kind === "invalid") {
        partial = true;
      }
    }
    if (pending.size > 0) partial = true;
    turns.sort((left, right) => compareCodeUnits(left.startedAt, right.startedAt) || compareCodeUnits(left.turnId, right.turnId));
    const timestamps = turns.flatMap((turn) => turn.committedAt ? [turn.startedAt, turn.committedAt] : [turn.startedAt]);
    const createdAt = timestamps.length > 0 ? [...timestamps].sort(compareCodeUnits)[0]! : sourceStartedAt;
    const updatedAt = timestamps.length > 0 ? [...timestamps].sort(compareCodeUnits).at(-1)! : sourceStartedAt;
    return {
      turns,
      title: sourceTitle,
      partial: partial || turns.length === 0,
      createdAt,
      updatedAt,
    };
  } finally {
    bytes.fill(0);
  }
}

function emptyPartialLegacyRollout(timestamp: string): ParsedLegacyRollout {
  return { turns: [], title: null, partial: true, createdAt: timestamp, updatedAt: timestamp };
}

function parseLegacyJsonLine(line: string): Record<string, unknown> | null {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_PORTABLE_TRANSCRIPT_BYTES) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function legacySessionMetaId(value: Record<string, unknown>): string | null {
  const payload = legacySessionMetaPayload(value);
  return payload && isNativeId(payload.id) ? payload.id : null;
}

function legacySessionMetaTitle(value: Record<string, unknown>): string | null {
  // The legacy owners/receipt proof signs thread ownership and source digests,
  // not a display-title claim. A raw session_meta title therefore cannot cross
  // into a canonical logical record; the core supplies its stable safe
  // fallback until a future signed title provenance format exists.
  void value;
  return null;
}

function legacySessionMetaTimestamp(value: Record<string, unknown>): string | null {
  const payload = legacySessionMetaPayload(value);
  return payload ? canonicalTimestampField(payload, "timestamp", "timestamp") : null;
}

function legacySessionMetaPayload(value: Record<string, unknown>): Record<string, unknown> | null {
  return value.type === "session_meta" && isRecord(value.payload)
    ? value.payload
    : isRecord(value.session_meta) && isRecord(value.session_meta.payload)
      ? value.session_meta.payload
      : null;
}

type LegacyTurnParse = { kind: "parsed"; turn: CanonicalHistoryTurnV1 } | { kind: "ignored" | "invalid" };

function parseDirectCompletedLegacyTurn(
  record: Record<string, unknown>,
  expectedThreadId: string,
  sourceDigest: Sha256Fingerprint,
  secret: Buffer,
  ordinal: number,
): LegacyTurnParse {
  if (record.method !== "turn/completed") return { kind: "ignored" };
  if (!isRecord(record.params)) return { kind: "invalid" };
  const completedAt = canonicalRecordTimestamp(record);
  return completedLegacyTurnFromSnapshot(record.params, expectedThreadId, sourceDigest, secret, ordinal, completedAt);
}

function parseLegacyEnvelopeRecord(
  record: Record<string, unknown>,
  expectedThreadId: string,
  sourceDigest: Sha256Fingerprint,
  secret: Buffer,
  ordinal: number,
  pending: Map<string, PendingLegacyEnvelopeTurn>,
): LegacyTurnParse {
  if (record.type !== "turn_context" && record.type !== "response_item" && record.type !== "event_msg") {
    return { kind: "ignored" };
  }
  if (!isRecord(record.payload)) return { kind: "invalid" };
  const payload = record.payload;

  // Codex rollout JSONL deliberately does not repeat a thread id on every
  // envelope. The signed snapshot path and its `session_meta.payload.id` bind
  // these events to the one expected native thread; an unbound event is not
  // adopted. We require the persisted task lifecycle rather than inferring a
  // turn boundary from a message, title, timestamp, or raw id.
  if (record.type === "event_msg") {
    if (payload.type === "task_started") {
      const turnId = legacyEnvelopeId(payload, "turnId", "turn_id");
      const startedAt = canonicalTimestampField(payload, "startedAt", "started_at");
      const threadId = legacyEnvelopeId(payload, "threadId", "thread_id");
      if (!turnId || !startedAt || (threadId !== null && threadId !== expectedThreadId)) return { kind: "invalid" };
      const key = `${expectedThreadId}\0${turnId}`;
      if (pending.has(key)) return { kind: "invalid" };
      pending.set(key, {
        nativeThreadId: expectedThreadId,
        nativeTurnId: turnId,
        startedAt,
        items: [],
        ambiguous: false,
      });
      return { kind: "ignored" };
    }

    if (payload.type === "task_complete") {
      const binding = resolveLegacyEnvelopeBinding(payload, expectedThreadId, pending);
      const completedAt = canonicalTimestampField(payload, "completedAt", "completed_at");
      if (!binding || !completedAt || binding.active.ambiguous) return { kind: "invalid" };
      const { key, active } = binding;
      pending.delete(key);
      return completedLegacyTurnFromCollectedItems(
        active.nativeThreadId,
        active.nativeTurnId,
        active.items,
        active.startedAt,
        completedAt,
        sourceDigest,
        secret,
        ordinal,
        true,
      );
    }

    if (payload.type === "user_message" || payload.type === "agent_message") {
      const binding = resolveLegacyEnvelopeBinding(payload, expectedThreadId, pending);
      if (!binding) return { kind: "invalid" };
      const item = legacyEventMessageItem(payload, payload.type === "user_message" ? "user" : "assistant");
      if (!item) {
        binding.active.ambiguous = true;
        return { kind: "invalid" };
      }
      if (!appendLegacyCollectedItem(binding.active, item, "event_msg")) return { kind: "invalid" };
      return { kind: "ignored" };
    }

    // The persisted rollout records reasoning, tool calls/arguments, and
    // status chatter alongside portable message items. Those records do not
    // constitute transcript data and cannot start, finish, or complete a turn.
    if (isIgnorableLegacyEventType(payload.type)) return { kind: "ignored" };
    return { kind: "invalid" };
  }

  if (record.type === "turn_context") {
    const turnId = legacyEnvelopeId(payload, "turnId", "turn_id");
    const threadId = legacyEnvelopeId(payload, "threadId", "thread_id");
    if (!turnId || (threadId !== null && threadId !== expectedThreadId)
      || !resolveLegacyEnvelopeBinding(payload, expectedThreadId, pending)) return { kind: "invalid" };
    return { kind: "ignored" };
  }

  const binding = resolveLegacyEnvelopeBinding(payload, expectedThreadId, pending);
  if (!binding) return { kind: "invalid" };
  const { active } = binding;
  if (record.type === "response_item") {
    const item = legacyResponseItem(payload);
    if (!item) {
      active.ambiguous = true;
      return { kind: "invalid" };
    }
    if (!appendLegacyCollectedItem(active, item, "response_item")) return { kind: "invalid" };
    return { kind: "ignored" };
  }
  return { kind: "invalid" };
}

function legacyEventMessageItem(
  payload: Record<string, unknown>,
  kind: "user" | "assistant",
): LegacyCollectedItemInput | null {
  const text = legacyMessageText(payload);
  if (text === null) return null;
  const sourceItemId = legacySourceItemId(payload);
  return {
    value: kind === "user"
      ? { type: "userMessage", ...(sourceItemId ? { id: sourceItemId } : {}), content: [{ type: "text", text }] }
      : { type: "agentMessage", ...(sourceItemId ? { id: sourceItemId } : {}), text },
    sourceItemId,
  };
}

/**
 * Normalize only the persisted, portable subset of a real response_item.
 * Unsupported item classes are ignored rather than converted to synthetic
 * text; malformed message-like records make the enclosing turn partial.
 */
function legacyResponseItem(payload: Record<string, unknown>): LegacyCollectedItemInput | null {
  const item = isRecord(payload.item) ? payload.item : isRecord(payload.message) ? payload.message : payload;
  const type = typeof item.type === "string" ? item.type : null;
  const role = typeof item.role === "string" ? item.role : null;
  if (type !== null && type !== "message" && type !== "userMessage" && type !== "agentMessage") {
    return null;
  }
  const kind = role === "user" || type === "userMessage"
    ? "user"
    : role === "assistant" || type === "agentMessage"
      ? "assistant"
      : null;
  if (!kind) return null;
  const text = legacyMessageText(item);
  if (text === null) return null;
  const sourceItemId = legacySourceItemId(payload, item);
  return {
    value: kind === "user"
      ? { type: "userMessage", ...(sourceItemId ? { id: sourceItemId } : {}), content: [{ type: "text", text }] }
      : { type: "agentMessage", ...(sourceItemId ? { id: sourceItemId } : {}), text },
    sourceItemId,
  };
}

interface LegacyCollectedItemInput {
  readonly value: Record<string, unknown>;
  readonly sourceItemId: string | null;
}

function appendLegacyCollectedItem(
  active: PendingLegacyEnvelopeTurn,
  input: LegacyCollectedItemInput,
  origin: "event_msg" | "response_item",
): boolean {
  const portable = portableLegacyItem(input.value);
  if (!portable || active.items.length >= MAX_PORTABLE_TRANSCRIPT_ITEMS) {
    active.ambiguous = true;
    return false;
  }
  const digest = canonicalSha256Fingerprint(portable);
  const matchingId = input.sourceItemId === null
    ? undefined
    : active.items.find((item) => item.sourceItemId === input.sourceItemId);
  if (matchingId) {
    if (matchingId.digest === digest) return true;
    active.ambiguous = true;
    return false;
  }
  const matchingDigest = active.items.find((item) => item.digest === digest);
  if (matchingDigest) {
    // Only collapse an exact mirrored message crossing the two independent
    // persisted envelope families. A second copy in either family is
    // ambiguous: a digest identifies content, not a repeated turn item.
    if (!matchingDigest.origins.has(origin)) {
      matchingDigest.origins.add(origin);
      return true;
    }
    active.ambiguous = true;
    return false;
  }
  active.items.push({ value: input.value, sourceItemId: input.sourceItemId, digest, origins: new Set([origin]) });
  return true;
}

function legacyMessageText(value: Record<string, unknown>): string | null {
  if (!hasOnlyPortableLegacyMessageFields(value)) return null;
  const candidates: string[] = [];
  collectLegacyMessageText(value.text, candidates);
  collectLegacyMessageText(value.text_elements, candidates);
  collectLegacyMessageText(value.content, candidates);
  if (isRecord(value.message)) {
    collectLegacyMessageText(value.message.text, candidates);
    collectLegacyMessageText(value.message.text_elements, candidates);
    collectLegacyMessageText(value.message.content, candidates);
  } else {
    collectLegacyMessageText(value.message, candidates);
  }
  const unique = [...new Set(candidates)];
  return unique.length === 1 && isPortableText(unique[0]!) ? unique[0]! : null;
}

function collectLegacyMessageText(value: unknown, candidates: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) candidates.push(value);
    return;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return;
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (!entry) return;
      texts.push(entry);
      continue;
    }
    if (!isRecord(entry) || (entry.type !== "text" && entry.type !== "input_text" && entry.type !== "output_text") || typeof entry.text !== "string" || !entry.text) return;
    texts.push(entry.text);
  }
  if (texts.length > 0) candidates.push(texts.join("\n"));
}

function hasOnlyPortableLegacyMessageFields(value: Record<string, unknown>): boolean {
  const nested = isRecord(value.message) ? [value.message] : [];
  for (const candidate of [value, ...nested]) {
    if (hasForbiddenLegacyMessageMetadata(candidate)) return false;
    for (const field of ["content", "text_elements"] as const) {
      if (candidate[field] !== undefined && !isPortableLegacyTextContainer(candidate[field])) return false;
    }
    if (candidate.text !== undefined && (typeof candidate.text !== "string" || !candidate.text)) return false;
  }
  return true;
}

function hasForbiddenLegacyMessageMetadata(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => /(?:^|_)(?:attachment|attachments|image|images|file|files|path|paths|resource|resources|url|uri|ref|arguments|args|reasoning|metadata|native|tool_call|function_call)(?:_|$)/i.test(key));
}

function isPortableLegacyTextContainer(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return false;
  return value.every((entry) => (typeof entry === "string" && entry.length > 0)
    || (isRecord(entry)
      && (entry.type === "text" || entry.type === "input_text" || entry.type === "output_text")
      && typeof entry.text === "string" && entry.text.length > 0
      && hasExactKeys(entry, ["type", "text"])));
}

function legacySourceItemId(...values: readonly Record<string, unknown>[]): string | null {
  const candidates = values.flatMap((value) => [
    value.itemId,
    value.item_id,
    value.id,
    isRecord(value.item) ? value.item.id : undefined,
    isRecord(value.message) ? value.message.id : undefined,
  ]).filter((value): value is string => isNativeId(value));
  const rawValues = values.flatMap((value) => [
    value.itemId,
    value.item_id,
    value.id,
    isRecord(value.item) ? value.item.id : undefined,
    isRecord(value.message) ? value.message.id : undefined,
  ]);
  return rawValues.every((value) => value === undefined || isNativeId(value)) && new Set(candidates).size <= 1
    ? candidates[0] ?? null
    : null;
}

function isIgnorableLegacyEventType(value: unknown): boolean {
  return value === "reasoning" || value === "reasoning_message" || value === "tool_call"
    || value === "function_call" || value === "function_call_arguments" || value === "tool_arguments"
    || value === "token_count" || value === "turn_context" || value === "session_status";
}

function resolveLegacyEnvelopeBinding(
  payload: Record<string, unknown>,
  expectedThreadId: string,
  pending: ReadonlyMap<string, PendingLegacyEnvelopeTurn>,
): { key: string; active: PendingLegacyEnvelopeTurn } | null {
  const threadId = legacyEnvelopeId(payload, "threadId", "thread_id");
  const turnId = legacyEnvelopeId(payload, "turnId", "turn_id");
  const candidates = [...pending.entries()].filter(([key, turn]) => {
    const [thread] = key.split("\0", 1);
    return turn.nativeThreadId === expectedThreadId
      && (threadId === null || thread === threadId)
      && (turnId === null || turn.nativeTurnId === turnId);
  });
  if (candidates.length !== 1) return null;
  const [key, active] = candidates[0]!;
  return { key, active };
}

function legacyEnvelopeId(payload: Record<string, unknown>, camel: string, snake: string): string | null {
  const camelValue = payload[camel];
  const snakeValue = payload[snake];
  if (camelValue !== undefined && snakeValue !== undefined && camelValue !== snakeValue) return null;
  const value = camelValue ?? snakeValue;
  return isNativeId(value) ? value : null;
}

function canonicalRecordTimestamp(record: Record<string, unknown>): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  const values = [record.timestamp, record.at, payload?.timestamp, payload?.at]
    .filter((value): value is string => typeof value === "string");
  const unique = [...new Set(values)];
  return unique.length === 1 && isCanonicalUtcTimestamp(unique[0]) ? unique[0] : null;
}

function canonicalTimestampField(payload: Record<string, unknown>, camel: string, snake: string): string | null {
  const camelValue = payload[camel];
  const snakeValue = payload[snake];
  if (camelValue !== undefined && snakeValue !== undefined && camelValue !== snakeValue) return null;
  const value = camelValue ?? snakeValue;
  return typeof value === "string" && isCanonicalUtcTimestamp(value) ? value : null;
}

function completedLegacyTurnFromSnapshot(
  params: Record<string, unknown>,
  expectedThreadId: string,
  sourceDigest: Sha256Fingerprint,
  secret: Buffer,
  ordinal: number,
  completedAt: string | null,
): LegacyTurnParse {
  if (params.threadId !== expectedThreadId || !isRecord(params.turn) || !completedAt) return { kind: "invalid" };
  const turn = params.turn;
  if (turn.status !== "completed" || turn.itemsView !== "full" || !Array.isArray(turn.items)) return { kind: "invalid" };
  const nativeTurnId = turn.id === undefined || turn.id === null ? null : isNativeId(turn.id) ? turn.id : null;
  if (turn.id !== undefined && turn.id !== null && nativeTurnId === null) return { kind: "invalid" };
  const startedAt = isCanonicalUtcTimestamp(turn.startedAt) ? turn.startedAt : completedAt;
  return completedLegacyTurnFromItems(expectedThreadId, nativeTurnId, turn.items, startedAt, completedAt, sourceDigest, secret, ordinal);
}

function completedLegacyTurnFromItems(
  nativeThreadId: string,
  nativeTurnId: string | null,
  items: readonly unknown[],
  startedAt: string,
  committedAt: string,
  sourceDigest: Sha256Fingerprint,
  secret: Buffer,
  ordinal: number,
): LegacyTurnParse {
  if (!isCanonicalUtcTimestamp(startedAt) || !isCanonicalUtcTimestamp(committedAt)
    || compareCodeUnits(startedAt, committedAt) > 0 || items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS) {
    return { kind: "invalid" };
  }
  const portable = portableTranscriptFromLegacyItems(items);
  if (!portable) return { kind: "invalid" };
  const nativeItemIds = nativeItemIdsFromLegacyItems(items);
  const turnId = deterministicHandle(secret, "lt_", {
    kind: "legacy-turn",
    sourceDigest,
    nativeThreadId,
    nativeTurnId,
    ordinal,
    transcriptDigest: portable.digest,
  }) as `lt_${string}`;
  return {
    kind: "parsed",
    turn: {
      turnId,
      nativeTurnId,
      nativeItemIds,
      state: "committed",
      phase: "committed",
      startedAt,
      committedAt,
      serializedInput: serializedInputFromPortableItems(portable.items),
      portableTranscript: portable,
    },
  };
}

function completedLegacyTurnFromCollectedItems(
  nativeThreadId: string,
  nativeTurnId: string | null,
  items: readonly LegacyCollectedItem[],
  startedAt: string,
  committedAt: string,
  sourceDigest: Sha256Fingerprint,
  secret: Buffer,
  ordinal: number,
  requireDialogue: boolean,
): LegacyTurnParse {
  if (items.length < 1 || (requireDialogue
    && (!items.some((item) => portableLegacyItem(item.value)?.kind === "user")
      || !items.some((item) => portableLegacyItem(item.value)?.kind === "assistant")))) {
    return { kind: "invalid" };
  }
  return completedLegacyTurnFromItems(
    nativeThreadId,
    nativeTurnId,
    items.map((item) => item.value),
    startedAt,
    committedAt,
    sourceDigest,
    secret,
    ordinal,
  );
}

function nativeItemIdsFromLegacyItems(items: readonly unknown[]): readonly string[] {
  const values = items.map((item) => isRecord(item) && isNativeId(item.id) ? item.id : null);
  return values.every((value): value is string => value !== null) && new Set(values).size === values.length ? values : [];
}

function portableTranscriptFromLegacyItems(items: readonly unknown[]): CanonicalPortableTranscriptV1 | null {
  if (items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS) return null;
  const portable: CanonicalPortableTranscriptItemV1[] = [];
  for (const item of items) {
    const value = portableLegacyItem(item);
    if (!value) return null;
    portable.push(value);
  }
  const bytes = Buffer.from(JSON.stringify(portable), "utf8");
  try {
    return bytes.byteLength <= MAX_PORTABLE_TRANSCRIPT_BYTES
      ? { digest: sha256(bytes), items: portable }
      : null;
  } finally {
    bytes.fill(0);
  }
}

function portableLegacyItem(value: unknown): CanonicalPortableTranscriptItemV1 | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "userMessage") {
    if (!Array.isArray(value.content) || value.content.length < 1 || value.content.length > 32) return null;
    const text = value.content.map((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string" && isPortableText(entry.text) ? entry.text : null);
    return text.every((entry): entry is string => entry !== null) ? { kind: "user", text: text.join("\n") } : null;
  }
  if (value.type === "agentMessage" && typeof value.text === "string" && isPortableText(value.text)) return { kind: "assistant", text: value.text };
  if (value.type === "plan" && typeof value.text === "string" && isPortableText(value.text)) return { kind: "plan", text: value.text };
  if (value.type === "functionCallOutput" && typeof value.name === "string" && isPortableText(value.name)) {
    const output = portableLegacyToolOutput(value.output);
    return output === null ? null : { kind: "tool", name: value.name, result: output };
  }
  return null;
}

function portableLegacyToolOutput(value: unknown): string | null {
  const text = typeof value === "string"
    ? value
    : Array.isArray(value) && value.length <= 32
      ? value.map((entry) => isRecord(entry) && entry.type === "input_text" && typeof entry.text === "string" ? entry.text : null)
        .every((entry): entry is string => entry !== null)
        ? (value as Array<Record<string, unknown>>).map((entry) => entry.text as string).join("\n")
        : null
      : null;
  if (text === null || !isPortableText(text) || Buffer.byteLength(text, "utf8") > 16 * 1024) return null;
  return /(?:^|[\s"'])(?:\/|~\/|file:|data:|blob:|https?:\/\/)/i.test(text) ? null : text;
}

function serializedInputFromPortableItems(items: readonly CanonicalPortableTranscriptItemV1[]): { digest: Sha256Fingerprint; text: string } | null {
  const userTexts: string[] = [];
  for (const item of items) {
    if (item.kind === "user" && "text" in item) userTexts.push(item.text);
  }
  const text = userTexts.join("\n");
  if (!text || Buffer.byteLength(text, "utf8") > MAX_SERIALIZED_INPUT_BYTES || !isPortableText(text)) return null;
  return { digest: sha256(Buffer.from(text, "utf8")), text };
}

function assertMigrationSourceEvidence(
  value: unknown,
  secret: Buffer,
  snapshotFingerprint: Sha256Fingerprint,
  store: CanonicalHistoryStoreV1,
): asserts value is MigrationSourceEvidenceV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "kind", "snapshotFingerprint", "references", "hmac"])
    || value.version !== 1 || value.kind !== "canonical-history-migration-sources"
    || value.snapshotFingerprint !== snapshotFingerprint || !Array.isArray(value.references)
    || typeof value.hmac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.hmac)) {
    fail("invalid-canonical-history-source-evidence");
  }
  const unsigned = {
    version: 1 as const,
    kind: "canonical-history-migration-sources" as const,
    snapshotFingerprint: value.snapshotFingerprint,
    references: value.references,
  };
  if (migrationHmac(secret, unsigned) !== value.hmac || value.references.length !== store.conversations.length) {
    fail("invalid-canonical-history-source-evidence");
  }
  const byConversation = new Map(store.conversations.map((conversation) => [conversation.conversationId, conversation]));
  const seen = new Set<string>();
  const physicalAliases = new Set<string>();
  const copyOperations = new Set<string>();
  const canonicalBindings = new Set<string>();
  for (const conversation of store.conversations) {
    for (const segment of conversation.segments) {
      canonicalBindings.add(legacyMemberKey(segment.opaqueAccountId, segment.nativeThreadId));
    }
  }
  for (const reference of value.references) {
    if (!isRecord(reference) || !hasExactKeys(reference, [
      "conversationId", "opaqueAccountId", "nativeThreadId", "disposition", "snapshotRelativePath", "sourceDigest", "importedTurnCount", "physicalAliases",
    ])
      || !isPrivateHandle(reference.conversationId, "lc_")
      || !isOpaqueAccountId(reference.opaqueAccountId)
      || !isNativeId(reference.nativeThreadId)
      || (reference.disposition !== "imported" && reference.disposition !== "partial" && reference.disposition !== "receipt-only")
      || !(reference.snapshotRelativePath === null || (typeof reference.snapshotRelativePath === "string" && isSafeRelativePath(reference.snapshotRelativePath)))
      || !isSha256Fingerprint(reference.sourceDigest)
      || !isNonNegativeInteger(reference.importedTurnCount)
      || !Array.isArray(reference.physicalAliases) || reference.physicalAliases.length > 1
      || seen.has(reference.conversationId)) {
      fail("invalid-canonical-history-source-evidence");
    }
    seen.add(reference.conversationId);
    const conversation = byConversation.get(reference.conversationId as `lc_${string}`);
    if (!conversation || conversation.rootNativeThreadId !== reference.nativeThreadId
      || conversation.segments[0]?.opaqueAccountId !== reference.opaqueAccountId
      || conversation.segments[0]?.turns.length !== reference.importedTurnCount
      || (reference.disposition === "imported") !== (conversation.availability === "complete")
      || (reference.disposition === "receipt-only" && reference.snapshotRelativePath !== null)) {
      fail("invalid-canonical-history-source-evidence");
    }
    for (const alias of reference.physicalAliases) {
      if (!isRecord(alias) || !hasExactKeys(alias, [
        "copyOperationId", "opaqueAccountId", "nativeThreadId", "snapshotRelativePath", "sourceDigest", "portableTranscriptDigest",
      ])
        || !isCopyOperationId(alias.copyOperationId)
        || !isOpaqueAccountId(alias.opaqueAccountId)
        || !isNativeId(alias.nativeThreadId)
        || typeof alias.snapshotRelativePath !== "string" || !isSafeRelativePath(alias.snapshotRelativePath)
        || !isSha256Fingerprint(alias.sourceDigest)
        || !isSha256Fingerprint(alias.portableTranscriptDigest)) {
        fail("invalid-canonical-history-source-evidence");
      }
      const binding = legacyMemberKey(alias.opaqueAccountId, alias.nativeThreadId);
      const sourceBinding = legacyMemberKey(reference.opaqueAccountId, reference.nativeThreadId);
      if (binding === sourceBinding || canonicalBindings.has(binding)
        || physicalAliases.has(binding) || copyOperations.has(alias.copyOperationId)
        || portableTranscriptDigestForAlias(conversation.segments[0]!.turns, conversation.availability !== "complete")
          !== alias.portableTranscriptDigest) {
        fail("invalid-canonical-history-source-evidence");
      }
      physicalAliases.add(binding);
      copyOperations.add(alias.copyOperationId);
    }
  }
}

function assertGlobalV3Candidate(
  root: string,
  proof: CompletedLegacyV2HistoryAdoptionProof,
  canonical: CanonicalJournalSummary,
  snapshotFingerprint: Sha256Fingerprint,
  sharedSkills: SharedSkillsManifestV1,
  sharedPlugins: SharedPluginsManifestV1,
): void {
  const config = readPrivateJson(join(root, "account-router-config.json"), 64 * 1024, "candidate-v3-config");
  if (!isRecord(config) || !hasExactKeys(config, [
    "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ])
    || config.schemaVersion !== 3
    || (config.mode !== "manual" && config.mode !== "quota_aware")
    || (config.mode === "quota_aware" ? config.policy !== "quota_aware_v2" : config.policy !== null)
    || !isPositiveInteger(config.generation)
    || !isSha256Fingerprint(config.fingerprint)
    || !isSha256Fingerprint(config.protocolFingerprint)
    || !isOpaqueAccountId(config.primaryOpaqueAccountId)
    || !isCanonicalUtcTimestamp(config.updatedAt)
    || !Array.isArray(config.accounts) || config.accounts.length !== proof.accountOpaqueIds.length) {
    fail("invalid-global-v3-candidate-config");
  }
  const accounts = config.accounts.map((account) => parseLegacyV2Account(account));
  if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length
    || !accounts.some((account) => account.opaqueAccountId === config.primaryOpaqueAccountId)
    || canonicalSha256Fingerprint([...accounts.map((account) => account.opaqueAccountId)].sort())
      !== canonicalSha256Fingerprint([...proof.accountOpaqueIds].sort())) {
    fail("global-v3-candidate-account-mismatch");
  }
  const projected = {
    schemaVersion: 3 as const,
    mode: config.mode as GlobalV3Config["mode"],
    policy: config.policy as GlobalV3Config["policy"],
    generation: config.generation as number,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId as OpaqueAccountId,
    accounts,
  };
  if (routerConfigDigest(projected) !== config.fingerprint) fail("global-v3-candidate-config-fingerprint-mismatch");
  const manifest = readSharedSkillsManifest(root);
  if (!sameSharedSkillsManifest(manifest, sharedSkills)
    || !sameSharedSkillsManifest(scanMaterializedSharedSkillsTree(join(root, SHARED_SKILLS_DIRECTORY), true, manifest.trustedRoots), manifest)) {
    fail("invalid-global-v3-shared-skills-source");
  }
  for (const account of accounts) {
    if (!sameSharedSkillsManifest(scanMaterializedSharedSkillsTree(join(root, "accounts", account.opaqueAccountId, "codex-home", "skills"), true, manifest.trustedRoots), manifest)) {
      fail("global-v3-shared-skills-account-mismatch");
    }
  }
  const pluginManifest = readSharedPluginsManifest(root);
  if (!sameSharedPluginsManifest(pluginManifest, sharedPlugins)
    || !sameSharedPluginsManifest(scanMaterializedSharedPlugins(join(root, SHARED_PLUGINS_DIRECTORY), true, pluginManifest), pluginManifest)) {
    fail("invalid-global-v3-shared-plugins-source");
  }
  for (const account of accounts) {
    if (!sharedPluginsProjectionMatches(root, join(root, "accounts", account.opaqueAccountId, "codex-home"), pluginManifest)) {
      fail("global-v3-shared-plugins-account-mismatch");
    }
  }
  const bytes = readPrivateRegularFile(join(root, CANONICAL_HISTORY_FILE), CANONICAL_HISTORY_MAX_BYTES_V1, "candidate-canonical-history");
  try {
    if (sha256(bytes) !== canonical.fingerprint) fail("candidate-canonical-history-fingerprint-mismatch");
    const parsed = parseCanonicalHistoryStore(JSON.parse(bytes.toString("utf8")) as unknown);
    const secret = readPrivateRegularFile(join(root, "control-secret.v1"), 64, "candidate-control-secret");
    try {
      if (secret.byteLength !== 32) fail("invalid-candidate-control-secret");
      assertMigrationSourceEvidence(
        readPrivateJson(
          join(root, CANONICAL_HISTORY_MIGRATION_SOURCES_FILE),
          CANONICAL_HISTORY_MIGRATION_EVIDENCE_MAX_BYTES_V1,
          "candidate-canonical-history-source-evidence",
        ),
        secret,
        snapshotFingerprint,
        parsed,
      );
    } finally {
      secret.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

function parseCanonicalHistoryStore(value: unknown, allowConversationCapacityOverflow = false): CanonicalHistoryStoreV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "conversations"])
    || value.version !== 1 || !Array.isArray(value.conversations)
    || (!allowConversationCapacityOverflow && value.conversations.length > CANONICAL_HISTORY_MAX_CONVERSATIONS_V1)) {
    fail("invalid-canonical-history-store");
  }
  const conversations = value.conversations.map((conversation) => parseCanonicalConversation(conversation));
  const conversationIds = new Set<string>();
  const publicThreadIds = new Set<string>();
  const nativeBindings = new Set<string>();
  for (const conversation of conversations) {
    if (conversationIds.has(conversation.conversationId) || publicThreadIds.has(conversation.publicThreadId)) {
      fail("invalid-canonical-history-store");
    }
    conversationIds.add(conversation.conversationId);
    publicThreadIds.add(conversation.publicThreadId);
    for (const segment of conversation.segments) {
      const binding = `${segment.opaqueAccountId}\0${segment.nativeThreadId}`;
      if (nativeBindings.has(binding)) fail("invalid-canonical-history-store");
      nativeBindings.add(binding);
    }
  }
  return { version: 1, conversations };
}

function parseCanonicalConversation(value: unknown): CanonicalHistoryConversationV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "conversationId", "rootNativeThreadId", "title", "publicThreadId", "createdAt", "updatedAt", "availability", "activeClient", "segments",
  ])
    || !isPrivateHandle(value.conversationId, "lc_")
    || !isNativeId(value.rootNativeThreadId)
    || !(value.title === null || isSafeCanonicalTitle(value.title))
    || !isCanonicalUtcTimestamp(value.createdAt)
    || !isCanonicalUtcTimestamp(value.updatedAt)
    || compareCodeUnits(value.createdAt, value.updatedAt) > 0
    || !isCanonicalAvailability(value.availability)
    || !isPublicConversationHandle(value.publicThreadId)
    || !(value.activeClient === null || isCanonicalActiveClient(value.activeClient))
    || !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > MAX_SEGMENTS_PER_CONVERSATION) {
    fail("invalid-canonical-history-store");
  }
  const segments = value.segments.map((segment) => parseCanonicalSegment(segment));
  const ids = new Set<string>();
  for (const segment of segments) {
    if (ids.has(segment.segmentId)) fail("invalid-canonical-history-store");
    ids.add(segment.segmentId);
  }
  if (segments[0]?.nativeThreadId !== value.rootNativeThreadId) fail("invalid-canonical-history-store");
  return {
    conversationId: value.conversationId as `lc_${string}`,
    rootNativeThreadId: value.rootNativeThreadId,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    availability: value.availability,
    publicThreadId: value.publicThreadId as `lh_${string}`,
    activeClient: value.activeClient === null ? null : {
      clientId: value.activeClient.clientId as `br_${string}`,
      label: value.activeClient.label,
    },
    segments,
  };
}

function parseCanonicalSegment(value: unknown): CanonicalHistorySegmentV1 {
  if (!isRecord(value) || !hasSegmentKeys(value)
    || !isPrivateHandle(value.segmentId, "ls_")
    || !isOpaqueAccountId(value.opaqueAccountId)
    || !isNativeId(value.nativeThreadId)
    || !isCanonicalSegmentState(value.state)
    || !isCanonicalUtcTimestamp(value.createdAt)
    || !(value.committedAt === undefined || isCanonicalUtcTimestamp(value.committedAt))
    || !Array.isArray(value.turns) || value.turns.length > MAX_TURNS_PER_SEGMENT) {
    fail("invalid-canonical-history-store");
  }
  const turns = value.turns.map((turn) => parseCanonicalTurn(turn));
  const turnIds = new Set<string>();
  for (const turn of turns) {
    if (turnIds.has(turn.turnId)) fail("invalid-canonical-history-store");
    turnIds.add(turn.turnId);
  }
  return {
    segmentId: value.segmentId as `ls_${string}`,
    opaqueAccountId: value.opaqueAccountId,
    nativeThreadId: value.nativeThreadId,
    state: value.state,
    createdAt: value.createdAt,
    ...(value.committedAt === undefined ? {} : { committedAt: value.committedAt }),
    turns,
  };
}

function parseCanonicalTurn(value: unknown): CanonicalHistoryTurnV1 {
  if (!isRecord(value) || !hasTurnKeys(value)
    || !isPrivateHandle(value.turnId, "lt_")
    || !(value.nativeTurnId === null || isNativeId(value.nativeTurnId))
    || !Array.isArray(value.nativeItemIds) || value.nativeItemIds.length > MAX_PORTABLE_TRANSCRIPT_ITEMS
    || !value.nativeItemIds.every(isNativeId) || new Set(value.nativeItemIds).size !== value.nativeItemIds.length
    || !isCanonicalTurnState(value.state)
    || !isCanonicalTurnPhase(value.phase)
    || !isCanonicalUtcTimestamp(value.startedAt)
    || !(value.committedAt === undefined || isCanonicalUtcTimestamp(value.committedAt))
    || !(value.serializedInput === null || isSerializedInput(value.serializedInput))
    || !(value.portableTranscript === null || isPortableTranscript(value.portableTranscript))) {
    fail("invalid-canonical-history-store");
  }
  return {
    turnId: value.turnId as `lt_${string}`,
    nativeTurnId: value.nativeTurnId,
    nativeItemIds: [...value.nativeItemIds],
    state: value.state,
    phase: value.phase,
    startedAt: value.startedAt,
    ...(value.committedAt === undefined ? {} : { committedAt: value.committedAt }),
    serializedInput: value.serializedInput,
    portableTranscript: value.portableTranscript,
  };
}

function isSerializedInput(value: unknown): value is { digest: Sha256Fingerprint; text: string } {
  if (!isRecord(value) || !hasExactKeys(value, ["digest", "text"])
    || !isSha256Fingerprint(value.digest) || typeof value.text !== "string"
    || Buffer.byteLength(value.text, "utf8") > MAX_SERIALIZED_INPUT_BYTES
    || !isPortableText(value.text)) return false;
  return sha256(Buffer.from(value.text, "utf8")) === value.digest;
}

function hasTurnKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort(compareCodeUnits);
  const required = ["turnId", "nativeTurnId", "nativeItemIds", "state", "phase", "startedAt", "serializedInput", "portableTranscript"].sort(compareCodeUnits);
  const committed = [...required, "committedAt"].sort(compareCodeUnits);
  return canonicalJson(keys) === canonicalJson(required) || canonicalJson(keys) === canonicalJson(committed);
}

function hasSegmentKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort(compareCodeUnits);
  const required = ["segmentId", "opaqueAccountId", "nativeThreadId", "state", "createdAt", "turns"].sort(compareCodeUnits);
  const committed = [...required, "committedAt"].sort(compareCodeUnits);
  return canonicalJson(keys) === canonicalJson(required) || canonicalJson(keys) === canonicalJson(committed);
}

function isPortableTranscript(value: unknown): value is CanonicalPortableTranscriptV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["digest", "items"])
    || !isSha256Fingerprint(value.digest) || !Array.isArray(value.items)
    || value.items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS) return false;
  const items = value.items.map((item) => parsePortableTranscriptItem(item));
  const bytes = Buffer.from(JSON.stringify(items), "utf8");
  try {
    return bytes.byteLength <= MAX_PORTABLE_TRANSCRIPT_BYTES && sha256(bytes) === value.digest;
  } finally {
    bytes.fill(0);
  }
}

function parsePortableTranscriptItem(value: unknown): CanonicalPortableTranscriptItemV1 {
  if (!isRecord(value) || typeof value.kind !== "string") fail("invalid-canonical-history-store");
  if ((value.kind === "user" || value.kind === "assistant" || value.kind === "plan")
    && hasExactKeys(value, ["kind", "text"])
    && typeof value.text === "string" && isPortableText(value.text)) {
    return { kind: value.kind, text: value.text };
  }
  if (value.kind === "tool" && hasExactKeys(value, ["kind", "name", "result"])
    && typeof value.name === "string" && typeof value.result === "string"
    && isPortableText(value.name) && isPortableText(value.result)) {
    return { kind: "tool", name: value.name, result: value.result };
  }
  fail("invalid-canonical-history-store");
}

function isPortableText(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_PORTABLE_TEXT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
  return !/(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|cookie|authorization)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|BEGIN [A-Z ]+PRIVATE KEY)/i.test(value);
}

function isCanonicalAvailability(value: unknown): value is CanonicalAvailability {
  return value === "complete" || value === "partial" || value === "incomplete" || value === "ambiguous";
}

function isCanonicalSegmentState(value: unknown): value is CanonicalSegmentState {
  return value === "committed" || value === "active" || value === "incomplete" || value === "ambiguous";
}

function isCanonicalTurnState(value: unknown): value is CanonicalTurnState {
  return value === "committed" || value === "active" || value === "incomplete" || value === "ambiguous";
}

function isCanonicalTurnPhase(value: unknown): value is CanonicalTurnPhase {
  return value === "prepared" || value === "dispatching" || value === "active"
    || value === "committed" || value === "aborted" || value === "ambiguous";
}

function isPrivateHandle(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${escapeRegex(prefix)}[A-Za-z0-9_-]{16,128}$`).test(value);
}

function isPublicConversationHandle(value: unknown): value is `lh_${string}` {
  return typeof value === "string" && /^lh_[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isSafeCanonicalTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && Buffer.byteLength(value, "utf8") <= MAX_LEGACY_TITLE_BYTES
    && isPortableText(value);
}

function isCanonicalActiveClient(value: unknown): value is { clientId: `br_${string}`; label: string } {
  return isRecord(value) && hasExactKeys(value, ["clientId", "label"])
    && isPrivateHandle(value.clientId, "br_")
    && isSafeLocalLabel(value.label);
}

function assertNativeId(value: unknown, code: string): asserts value is string {
  if (!isNativeId(value)) fail(code);
}

function isNativeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_ID_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCopyOperationId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertRollbackArchiveLayout(root: string, view: SharedHistoryRollbackView): void {
  assertPrivateDirectory(root, "rollback-export-root");
  const names = readdirNoFollow(root, "rollback-export-root");
  if (canonicalJson(names) !== canonicalJson([CANONICAL_HISTORY_FILE, SHARED_HISTORY_ROLLBACK_VIEWER_FILE])) {
    fail("invalid-rollback-export-layout");
  }
  const canonical = readPrivateRegularFile(join(root, CANONICAL_HISTORY_FILE), CANONICAL_HISTORY_MAX_BYTES_V1, "rollback-export-canonical-history");
  try {
    if (sha256(canonical) !== view.canonicalFingerprint) fail("rollback-export-canonical-history-mismatch");
  } finally {
    canonical.fill(0);
  }
  const viewer = readPrivateJson(join(root, SHARED_HISTORY_ROLLBACK_VIEWER_FILE), 64 * 1024, "rollback-export-viewer");
  if (!isRecord(viewer) || !hasExactKeys(viewer, [
    "version", "kind", "canonicalFile", "canonicalFingerprint", "conversationCount", "segmentCount", "readOnly", "legacySqliteFlattened",
  ])
    || viewer.version !== 1
    || viewer.kind !== "shared-history-read-only-viewer"
    || viewer.canonicalFile !== CANONICAL_HISTORY_FILE
    || viewer.canonicalFingerprint !== view.canonicalFingerprint
    || viewer.conversationCount !== view.conversationCount
    || viewer.segmentCount !== view.segmentCount
    || viewer.readOnly !== true
    || viewer.legacySqliteFlattened !== false) fail("invalid-rollback-export-viewer");
}

function writePrivateFileNew(path: string, value: Buffer, label: string): void {
  if (existsNoFollow(path)) fail(`${label}-already-exists`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeAll(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertPrivateRegularFile(path, Math.max(value.byteLength, 1), label);
}

function writePrivateJsonNew(path: string, value: unknown): void {
  if (existsNoFollow(path)) fail("private-json-file-already-exists");
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes.fill(0);
  }
  assertPrivateRegularFile(path, Math.max(CANONICAL_HISTORY_MAX_BYTES_V1, 64 * 1024), "private-json-file");
  fsyncDirectory(dirname(path));
}

function writePrivateJsonReplace(path: string, value: unknown): void {
  assertPrivateRegularFile(path, 64 * 1024, "private-json-replacement-source");
  const parent = dirname(path);
  const staging = `${path}.migration-tmp`;
  if (existsNoFollow(staging)) fail("private-json-replacement-staging-exists");
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(staging, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes.fill(0);
  }
  assertPrivateRegularFile(staging, 64 * 1024, "private-json-replacement-staging");
  renameSync(staging, path);
  assertPrivateRegularFile(path, 64 * 1024, "private-json-replacement");
  fsyncDirectory(parent);
}

function readPrivateJson(path: string, maxBytes: number, label: string): unknown {
  const bytes = readPrivateRegularFile(path, maxBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail(`${label}-invalid-json`);
  } finally {
    bytes.fill(0);
  }
}

function readPrivateRegularFile(path: string, maxBytes: number, label: string): Buffer {
  const stat = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(stat, label);
  if (stat.size > maxBytes) fail(`${label}-capacity-exceeded`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!sameFile(stat, opened)) fail(`${label}-changed`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== bytes.byteLength || !sameFile(stat, fstatSync(descriptor))) {
      bytes.fill(0);
      fail(`${label}-changed`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function digestPrivateFile(path: string, expected: Stats, label: string): Sha256Fingerprint {
  let descriptor: number | undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!sameFile(expected, fstatSync(descriptor))) fail(`${label}-changed`);
    let bytes = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    if (bytes !== expected.size || !sameFile(expected, fstatSync(descriptor))) fail(`${label}-changed`);
    return `sha256:${hash.digest("hex")}` as Sha256Fingerprint;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    buffer.fill(0);
  }
}

function sha256(value: Buffer): Sha256Fingerprint {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Sha256Fingerprint;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
}

function readdirNoFollow(path: string, label: string): string[] {
  const stat = lstatNoFollow(path, label);
  assertPrivateDirectoryStat(stat, label);
  try {
    return readFileDirectory(path).sort(compareCodeUnits);
  } catch {
    fail(`${label}-unreadable`);
  }
}

function readFileDirectory(path: string): string[] {
  // `readdirSync` does not follow a final symlink after the lstat gate above;
  // a private parent and no-follow child validation protect every descendant.
  return readdirSync(path);
}

function lstatNoFollow(path: string, label: string): Stats {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`${label}-symlink-refused`);
    return stat;
  } catch (error) {
    if (error instanceof SharedHistoryMigrationFailure) throw error;
    fail(`${label}-missing-or-unsafe`);
  }
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  assertPrivateDirectoryStat(lstatNoFollow(path, label), label);
}

function assertOwnerControlledDirectory(path: string, label: string): void {
  const stat = lstatNoFollow(path, label);
  const owner = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o022) !== 0) fail(`${label}-not-owner-controlled-directory`);
}

function assertPrivateDirectoryStat(stat: Stats, label: string): void {
  const owner = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o077) !== 0) fail(`${label}-not-owner-private-directory`);
}

function assertPrivateRegularFile(path: string, maxBytes: number, label: string): void {
  const stat = lstatNoFollow(path, label);
  assertPrivateRegularFileStat(stat, label);
  if (stat.size > maxBytes) fail(`${label}-capacity-exceeded`);
}

function assertPrivateRegularFileStat(stat: Stats, label: string): void {
  const owner = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (owner !== undefined && stat.uid !== owner)
    || (stat.mode & 0o077) !== 0) fail(`${label}-not-owner-private-regular-file`);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch {
    // Some macOS filesystems reject directory fsync; every file has already
    // been fsynced and same-directory renames retain the bounded transaction.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolvedChild(root: string, local: string, label: string): string {
  if (!isSafeRelativePath(local)) fail(`${label}-path-escape`);
  const result = resolve(root, ...local.split("/"));
  const suffix = relative(root, result);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) fail(`${label}-path-escape`);
  return result;
}

function isSafeRelativePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"));
}

function assertSafeRelativeComponent(value: string, label: string): void {
  if (!isSafeRelativePath(value) || value.includes("/")) fail(`${label}-path-escape`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function withoutHmac<T extends { hmac: unknown }>(value: T): Omit<T, "hmac"> {
  const { hmac: _hmac, ...payload } = value;
  return payload;
}

function redactMigrationFailure(error: unknown): Error {
  if (error instanceof SharedHistoryMigrationFailure) return error;
  return new SharedHistoryMigrationFailure("unexpected-shared-history-migration-failure");
}

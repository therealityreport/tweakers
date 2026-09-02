import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  readlinkSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  OFFICIAL_CODEX_DATABASES,
  canonicalSha256Fingerprint,
  historyAdoptionProcessCensus,
  type HistoryAdoptionCensus,
  type HistoryAdoptionProcessCensus,
  type OfficialCodexDatabase,
  type Sha256Fingerprint,
} from "./account-history-adoption.js";

/**
 * Produces an immutable, owner-private source snapshot for the existing
 * account-history adoption transaction. It never changes a source history,
 * source database, account home, router file, application, or archive target.
 */

export const PRIVATE_HISTORY_NORMALIZATION_SCHEMA_VERSION = 1 as const;
export const PRIVATE_HISTORY_NORMALIZATION_MANIFEST = "history-normalization-manifest.v1.json" as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_HISTORY_FILES = 250_000;
const MAX_HISTORY_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_FIRST_RECORD_BYTES = 128 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = MAX_HISTORY_FILES;
const MAX_ARCHIVE_BYTES = MAX_HISTORY_BYTES;
const TRUSTED_DESKTOP_APP_PATHS = [
  "/Applications/Tweakers.app",
  "/Applications/Tweakers ChatGPT.app",
  "/Applications/ChatGPT.app",
  "/Applications/Codex.app",
] as const;

type HistoryTree = "sessions" | "archived_sessions";

export interface PrivateHistoryNormalizationInput {
  sourceCodexRoot: string;
  sourceSqliteRoot: string;
  snapshotRoot: string;
  allowedLinkRoot: string;
  appPath: string;
  /** Additional exact roots that must remain disjoint from snapshotRoot. */
  forbiddenRoots: readonly string[];
  /** Omitted/false performs a read-only plan. */
  apply?: boolean;
}

export interface PrivateHistoryThreadRow extends Record<string, unknown> {
  id: string;
  rollout_path: string | null;
}

export interface PrivateHistoryRolloutUpdate {
  id: string;
  expectedRolloutPath: string;
  rolloutPath: string | null;
}

export interface PrivateHistoryNormalizationSqliteAdapter {
  backup(source: string, destination: string): void;
  integrityCheck(path: string): "ok";
  readThreadRows(path: string): readonly PrivateHistoryThreadRow[];
  rewriteThreadRolloutPaths(path: string, updates: readonly PrivateHistoryRolloutUpdate[]): void;
}

export interface PrivateHistoryNormalizationDependencies {
  sqlite: PrivateHistoryNormalizationSqliteAdapter;
  census(input: { appPath: string; protectedPaths: readonly string[] }): HistoryAdoptionCensus;
  now(): string;
  randomId(): string;
  beforePhase?(phase: PrivateHistoryNormalizationPhase): void;
}

export type PrivateHistoryNormalizationPhase =
  | "after-first-census"
  | "after-plan"
  | "after-second-census"
  | "after-candidate-created"
  | "after-history-copied"
  | "after-databases-cloned"
  | "after-database-rewrite"
  | "before-publication";

export interface PrivateHistoryNormalizationResult {
  status: "dry-run" | "normalized";
  sourceFingerprint: Sha256Fingerprint;
  normalizedFingerprint: Sha256Fingerprint | null;
  regularHistoryFiles: number;
  linkedHistoryFiles: number;
  historyBytes: number;
  databaseThreadCount: number;
  importedThreadCount: number;
  rewrittenRolloutPaths: number;
  clearedMissingRolloutPaths: number;
  databasesPresent: number;
  sessionIndexPresent: boolean;
  nextAction: "apply-normalization" | "run-adoption-dry-run";
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  mode: number;
}

interface DirectoryEvidence {
  relativePath: string;
  identity: FileIdentity;
}

interface ParentEvidence {
  path: string;
  identity: FileIdentity;
}

interface SnapshotParentAnchor {
  path: string;
  dev: number;
  ino: number;
  descriptor: number;
}

interface SnapshotCandidateAnchor {
  dev: number;
  ino: number;
}

interface HistoryFileEvidence {
  artifact: HistoryTree | "session_index.jsonl";
  relativePath: string;
  sourcePath: string;
  copySourcePath: string;
  kind: "regular" | "linked";
  sourceIdentity: FileIdentity;
  targetIdentity: FileIdentity | null;
  linkText: string | null;
  targetParents: readonly ParentEvidence[];
  sha256: Sha256Fingerprint;
  bytes: number;
}

interface HistoryInventory {
  directories: readonly DirectoryEvidence[];
  files: readonly HistoryFileEvidence[];
  fingerprint: Sha256Fingerprint;
  regularHistoryFiles: number;
  linkedHistoryFiles: number;
  historyBytes: number;
  sessionIndexPresent: boolean;
}

interface DatabaseEvidence {
  name: OfficialCodexDatabase;
  present: boolean;
  bytes: number;
  sha256: Sha256Fingerprint | null;
  integrity: "ok" | null;
}

interface DatabaseInventory {
  entries: readonly DatabaseEvidence[];
  paths: ReadonlyMap<OfficialCodexDatabase, string>;
  fingerprint: Sha256Fingerprint;
}

interface ArchiveDirectoryEvidence {
  relativePath: string;
  path: string;
  identity: FileIdentity;
  names: readonly string[];
}

interface ArchiveFileEvidence {
  relativePath: string;
  path: string;
  id: string;
  identity: FileIdentity;
  sha256: Sha256Fingerprint;
  bytes: number;
}

interface ArchiveInventory {
  directories: readonly ArchiveDirectoryEvidence[];
  files: readonly ArchiveFileEvidence[];
  entryPaths: ReadonlySet<string>;
  fingerprint: Sha256Fingerprint;
}

interface ArchiveScanState {
  directories: ArchiveDirectoryEvidence[];
  files: ArchiveFileEvidence[];
  entryPaths: Set<string>;
  seenIds: Set<string>;
  bytes: number;
}

interface PhysicalRecord {
  id: string;
  localPath: string;
}

interface NormalizationPlan {
  histories: HistoryInventory;
  databases: DatabaseInventory;
  archive: ArchiveInventory;
  threadRows: readonly PrivateHistoryThreadRow[];
  threadRowsFingerprint: Sha256Fingerprint;
  nonRolloutRowsFingerprint: Sha256Fingerprint;
  physicalRecords: readonly PhysicalRecord[];
  updates: readonly PrivateHistoryRolloutUpdate[];
  importedThreadIds: readonly string[];
  missingFingerprint: Sha256Fingerprint;
  rewriteFingerprint: Sha256Fingerprint;
  sourceFingerprint: Sha256Fingerprint;
}

interface PrivateHistoryNormalizationManifestV1 {
  schemaVersion: typeof PRIVATE_HISTORY_NORMALIZATION_SCHEMA_VERSION;
  kind: "private-history-normalization";
  createdAt: string;
  sourceFingerprint: Sha256Fingerprint;
  normalizedFingerprint: Sha256Fingerprint;
  historyFingerprint: Sha256Fingerprint;
  databaseFingerprint: Sha256Fingerprint;
  threadRowsFingerprint: Sha256Fingerprint;
  nonRolloutRowsFingerprint: Sha256Fingerprint;
  missingFingerprint: Sha256Fingerprint;
  rewriteFingerprint: Sha256Fingerprint;
  counts: {
    regularHistoryFiles: number;
    linkedHistoryFiles: number;
    historyBytes: number;
    databaseThreadCount: number;
    importedThreadCount: number;
    rewrittenRolloutPaths: number;
    clearedMissingRolloutPaths: number;
    databasesPresent: number;
  };
  histories: readonly {
    artifact: HistoryFileEvidence["artifact"];
    relativePath: string;
    kind: HistoryFileEvidence["kind"];
    bytes: number;
    sha256: Sha256Fingerprint;
    sourceIdentityFingerprint: Sha256Fingerprint;
    targetIdentityFingerprint: Sha256Fingerprint | null;
  }[];
  databasesBefore: readonly DatabaseEvidence[];
  databasesAfter: readonly DatabaseEvidence[];
}

class PrivateHistoryNormalizationFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PrivateHistoryNormalizationFailure";
  }
}

export function normalizePrivateHistory(
  input: PrivateHistoryNormalizationInput,
  suppliedDependencies: Partial<PrivateHistoryNormalizationDependencies> = {},
): PrivateHistoryNormalizationResult {
  const dependencies = {
    ...defaultDependencies(),
    ...suppliedDependencies,
  } as PrivateHistoryNormalizationDependencies;
  const paths = normalizationPaths(input);
  const apply = input.apply === true;
  let candidateRoot: string | null = null;
  let snapshotParent: SnapshotParentAnchor | null = null;
  let candidateAnchor: SnapshotCandidateAnchor | null = null;
  try {
    snapshotParent = validateRoots(paths, input.forbiddenRoots);
    if (existsSync(paths.snapshotRoot)) throw failure("snapshot-exists");

    if (apply) {
      assertIdle(dependencies.census({ appPath: paths.appPath, protectedPaths: protectedPaths(paths) }));
      dependencies.beforePhase?.("after-first-census");
    }

    const plan = buildPlan(paths, dependencies.sqlite);
    dependencies.beforePhase?.("after-plan");
    if (!apply) return resultFor("dry-run", plan, null);

    assertIdle(dependencies.census({ appPath: paths.appPath, protectedPaths: protectedPaths(paths) }));
    dependencies.beforePhase?.("after-second-census");

    candidateRoot = uniqueSibling(paths.snapshotRoot, ".history-normalization-candidate", dependencies.randomId());
    createSnapshotRoot(candidateRoot, snapshotParent);
    candidateAnchor = captureSnapshotCandidateAnchor(candidateRoot, snapshotParent);
    dependencies.beforePhase?.("after-candidate-created");

    const candidateCodexRoot = join(candidateRoot, "codex-home");
    const candidateSqliteRoot = join(candidateRoot, "sqlite-home");
    copyHistoryInventory(plan.histories, candidateCodexRoot);
    dependencies.beforePhase?.("after-history-copied");

    cloneDatabases(plan.databases, candidateSqliteRoot, dependencies.sqlite);
    dependencies.beforePhase?.("after-databases-cloned");
    rewriteCandidateState(plan, candidateSqliteRoot, dependencies.sqlite);
    dependencies.beforePhase?.("after-database-rewrite");

    const normalizedHistories = inspectNormalizedHistories(candidateCodexRoot);
    assertNormalizedHistories(plan.histories, normalizedHistories);
    const normalizedDatabases = inspectDatabases(candidateSqliteRoot, dependencies.sqlite);
    assertCandidateDatabaseRows(plan, candidateSqliteRoot, dependencies.sqlite);

    const latestPlan = buildPlan(paths, dependencies.sqlite);
    if (latestPlan.sourceFingerprint !== plan.sourceFingerprint) throw failure("source-drift");
    assertIdle(dependencies.census({ appPath: paths.appPath, protectedPaths: protectedPaths(paths) }));

    const normalizedFingerprint = canonicalSha256Fingerprint({
      histories: normalizedHistories.fingerprint,
      databases: normalizedDatabases.fingerprint,
      threadRows: threadRowsFingerprint(dependencies.sqlite.readThreadRows(join(candidateSqliteRoot, "state_5.sqlite"))),
    });
    const manifest = createManifest(plan, normalizedHistories, normalizedDatabases, normalizedFingerprint, dependencies.now());
    writePrivateJsonNew(join(candidateRoot, PRIVATE_HISTORY_NORMALIZATION_MANIFEST), manifest);
    dependencies.beforePhase?.("before-publication");
    const retainedOnPublicationFailure = uniqueSibling(
      paths.snapshotRoot,
      ".history-normalization-failed",
      dependencies.randomId(),
    );
    const publication = renamePrivateSibling(
      candidateRoot,
      paths.snapshotRoot,
      snapshotParent,
      candidateAnchor,
      retainedOnPublicationFailure,
    );
    candidateRoot = null;
    if (publication === "retained") throw failure("snapshot-publication-path-drift");
    return resultFor("normalized", plan, normalizedFingerprint);
  } catch (error) {
    if (candidateRoot && snapshotParent && candidateAnchor && !isCommittedRenameFailure(error)) {
      try {
        renamePrivateSibling(
          candidateRoot,
          uniqueSibling(paths.snapshotRoot, ".history-normalization-failed", dependencies.randomId()),
          snapshotParent,
          candidateAnchor,
        );
      } catch {
        throw failure("failed-snapshot-retention-incomplete");
      }
    }
    throw redactFailure(error);
  } finally {
    if (snapshotParent) {
      try { closeSync(snapshotParent.descriptor); }
      catch { /* descriptor cleanup must not replace the original outcome */ }
    }
  }
}

function defaultDependencies(): PrivateHistoryNormalizationDependencies {
  return {
    sqlite: privateHistoryNormalizationSqliteAdapter(),
    census: defaultCensus,
    now: () => new Date().toISOString(),
    randomId: () => randomUUID(),
  };
}

function normalizationPaths(input: PrivateHistoryNormalizationInput): {
  sourceCodexRoot: string;
  sourceSqliteRoot: string;
  snapshotRoot: string;
  allowedLinkRoot: string;
  appPath: string;
} {
  return {
    sourceCodexRoot: exactAbsolute(input.sourceCodexRoot, "invalid-source-codex-root"),
    sourceSqliteRoot: exactAbsolute(input.sourceSqliteRoot, "invalid-source-sqlite-root"),
    snapshotRoot: exactAbsolute(input.snapshotRoot, "invalid-snapshot-root"),
    allowedLinkRoot: exactAbsolute(input.allowedLinkRoot, "invalid-allowed-link-root"),
    appPath: exactAbsolute(input.appPath, "invalid-app-path"),
  };
}

function validateRoots(
  paths: ReturnType<typeof normalizationPaths>,
  forbiddenRoots: readonly string[],
): SnapshotParentAnchor {
  assertExactDirectory(paths.sourceCodexRoot, "source-codex-root", false);
  assertExactDirectory(paths.sourceSqliteRoot, "source-sqlite-root", false);
  assertExactDirectory(paths.allowedLinkRoot, "allowed-link-root", false);
  const snapshotParent = dirname(paths.snapshotRoot);
  const snapshotParentStat = assertExactDirectory(snapshotParent, "snapshot-parent", true);
  if (basename(paths.snapshotRoot).startsWith(".")) throw failure("invalid-snapshot-root");
  const disallowed = [
    paths.sourceCodexRoot,
    paths.sourceSqliteRoot,
    paths.allowedLinkRoot,
    paths.appPath,
    ...forbiddenRoots.map((root) => exactAbsolute(root, "invalid-forbidden-root")),
  ];
  for (const root of disallowed) {
    const canonical = existsSync(root) ? exactExistingPath(root, "invalid-forbidden-root") : root;
    if (pathsOverlap(paths.snapshotRoot, canonical)) throw failure("snapshot-root-overlap");
  }
  return openSnapshotParentAnchor(snapshotParent, snapshotParentStat);
}

function buildPlan(
  paths: ReturnType<typeof normalizationPaths>,
  sqlite: PrivateHistoryNormalizationSqliteAdapter,
): NormalizationPlan {
  const histories = inspectSourceHistories(paths.sourceCodexRoot, paths.allowedLinkRoot);
  const databases = inspectDatabases(paths.sourceSqliteRoot, sqlite);
  const archive = inspectAllowedArchive(paths.allowedLinkRoot);
  const statePath = databases.paths.get("state_5.sqlite");
  const threadRows = statePath ? readThreadRows(sqlite, statePath) : [];
  const physicalRecords = physicalRecordMap(histories);
  const physicalByLocal = new Map(physicalRecords.map((record) => [record.localPath, record.id]));
  const physicalById = new Map(physicalRecords.map((record) => [record.id, record.localPath]));
  const archiveById = new Map(archive.files.map((record) => [record.id, record.relativePath]));
  const seenDatabaseIds = new Set<string>();
  const updates: PrivateHistoryRolloutUpdate[] = [];
  const missingEvidence: Array<{ id: string; rolloutPath: string }> = [];

  for (const row of threadRows) {
    if (!isCanonicalThreadId(row.id) || seenDatabaseIds.has(row.id)) throw failure("invalid-or-duplicate-thread-id");
    seenDatabaseIds.add(row.id);
    if (row.rollout_path === null || row.rollout_path === "") continue;
    const local = containedRolloutLocal(paths.sourceCodexRoot, row.rollout_path);
    const sourcePath = join(paths.sourceCodexRoot, ...local.split("/"));
    let sourceStat: Stats | null = null;
    try {
      sourceStat = lstatSync(sourcePath);
    } catch (error) {
      if (!isEnoent(error)) throw failure("missing-path-not-proven");
    }
    if (sourceStat) {
      const recordId = physicalByLocal.get(local);
      if (!recordId || recordId !== row.id) throw failure("rollout-database-disagreement");
      updates.push({
        id: row.id,
        expectedRolloutPath: row.rollout_path,
        rolloutPath: join(paths.snapshotRoot, "codex-home", ...local.split("/")),
      });
      continue;
    }
    if (physicalById.has(row.id) || archiveById.has(row.id)) throw failure("missing-path-recoverable");
    assertNoExactArchiveCandidate(archive, local);
    missingEvidence.push({ id: row.id, rolloutPath: row.rollout_path });
    updates.push({ id: row.id, expectedRolloutPath: row.rollout_path, rolloutPath: null });
  }

  const importedThreadIds = [...new Set([...seenDatabaseIds, ...physicalById.keys()])].sort();
  const threadFingerprint = threadRowsFingerprint(threadRows);
  const nonRolloutFingerprint = nonRolloutRowsFingerprint(threadRows);
  const missingFingerprint = canonicalSha256Fingerprint(missingEvidence.sort(compareId));
  const rewriteFingerprint = canonicalSha256Fingerprint(updates.map(redactedUpdate).sort(compareId));
  const sourceFingerprint = canonicalSha256Fingerprint({
    histories: histories.fingerprint,
    databases: databases.fingerprint,
    archive: archive.fingerprint,
    threadRows: threadFingerprint,
    nonRolloutRows: nonRolloutFingerprint,
    missing: missingFingerprint,
    rewrites: rewriteFingerprint,
  });
  return {
    histories,
    databases,
    archive,
    threadRows,
    threadRowsFingerprint: threadFingerprint,
    nonRolloutRowsFingerprint: nonRolloutFingerprint,
    physicalRecords,
    updates: updates.sort((left, right) => left.id.localeCompare(right.id)),
    importedThreadIds,
    missingFingerprint,
    rewriteFingerprint,
    sourceFingerprint,
  };
}

function inspectSourceHistories(sourceCodexRoot: string, allowedLinkRoot: string): HistoryInventory {
  const directories: DirectoryEvidence[] = [];
  const files: HistoryFileEvidence[] = [];
  for (const artifact of ["sessions", "archived_sessions"] as const) {
    const root = join(sourceCodexRoot, artifact);
    if (optionalLstat(root, "history-artifact") === null) continue;
    scanHistoryDirectory(root, artifact, "", allowedLinkRoot, directories, files);
  }
  const index = join(sourceCodexRoot, "session_index.jsonl");
  if (optionalLstat(index, "session-index") !== null) {
    files.push(regularHistoryFile(index, "session_index.jsonl", "session_index.jsonl"));
  }
  return finalizeHistoryInventory(directories, files);
}

/**
 * The approved archive root may contain records which are no longer linked
 * from CODEX_HOME. Inventorying the whole exact root makes a missing database
 * pointer provably absent only when no physical record for that id remains.
 *
 * This is deliberately stricter than the source-history scan: an archive is
 * an authority for recovery, so every entry must be a unique, stable rollout
 * record. A malformed, linked, hard-linked, unreadable, or changing entry is
 * an ambiguity, not something to ignore.
 */
function inspectAllowedArchive(allowedRoot: string): ArchiveInventory {
  assertExactDirectory(allowedRoot, "archive-root", false);
  const state: ArchiveScanState = {
    directories: [],
    files: [],
    entryPaths: new Set<string>(),
    seenIds: new Set<string>(),
    bytes: 0,
  };
  scanArchiveDirectory(allowedRoot, allowedRoot, "", state);
  const directories = [...state.directories].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const files = [...state.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const inventory: ArchiveInventory = {
    directories,
    files,
    entryPaths: new Set(state.entryPaths),
    fingerprint: canonicalSha256Fingerprint({
      directories: directories.map((entry) => ({
        path: entry.relativePath,
        identity: entry.identity,
        names: entry.names,
      })),
      files: files.map((entry) => ({
        path: entry.relativePath,
        id: entry.id,
        identity: entry.identity,
        bytes: entry.bytes,
        sha256: entry.sha256,
      })),
    }),
  };
  revalidateArchiveInventory(allowedRoot, inventory);
  return inventory;
}

function scanArchiveDirectory(
  allowedRoot: string,
  directory: string,
  relativeDirectory: string,
  state: ArchiveScanState,
): void {
  assertArchivePath(allowedRoot, directory, relativeDirectory);
  const directoryStat = safeLstat(directory, "archive-directory");
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure("archive-directory-unsafe");
  const names = listArchiveNames(directory);
  state.directories.push({
    relativePath: relativeDirectory,
    path: directory,
    identity: identity(directoryStat),
    names,
  });
  if (relativeDirectory) state.entryPaths.add(relativeDirectory);
  assertArchiveInventoryLimits(state);

  for (const name of names) {
    if (!isArchiveEntryName(name)) throw failure("archive-path-escape");
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const path = archivePath(allowedRoot, relativePath);
    const stat = safeLstat(path, "archive-entry");
    if (stat.isSymbolicLink()) throw failure("archive-symlink-refused");
    state.entryPaths.add(relativePath);
    if (stat.isDirectory()) {
      scanArchiveDirectory(allowedRoot, path, relativePath, state);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0) throw failure("archive-entry-unsafe");
    assertArchivePath(allowedRoot, path, relativePath);
    const id = rolloutFirstRecordThreadId(path, stat);
    if (state.seenIds.has(id)) throw failure("duplicate-rollout-thread-id");
    const sha256 = hashStableRegular(path, stat);
    if (!sameIdentity(identity(safeLstat(path, "archive-file")), identity(stat))) {
      throw failure("archive-file-drift");
    }
    state.seenIds.add(id);
    state.files.push({
      relativePath,
      path,
      id,
      identity: identity(stat),
      sha256,
      bytes: stat.size,
    });
    state.bytes += stat.size;
    assertArchiveInventoryLimits(state);
  }
}

function revalidateArchiveInventory(allowedRoot: string, inventory: ArchiveInventory): void {
  revalidateArchiveDirectories(allowedRoot, inventory);
  const seenIds = new Set<string>();
  for (const file of inventory.files) {
    const path = archivePath(allowedRoot, file.relativePath);
    if (path !== file.path) throw failure("archive-path-escape");
    assertArchivePath(allowedRoot, path, file.relativePath);
    const stat = safeLstat(path, "archive-file");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0
      || !sameIdentity(identity(stat), file.identity)) {
      throw failure("archive-file-drift");
    }
    if (rolloutFirstRecordThreadId(path, stat) !== file.id || seenIds.has(file.id)) {
      throw failure("archive-file-drift");
    }
    if (hashStableRegular(path, stat) !== file.sha256) throw failure("archive-file-drift");
    seenIds.add(file.id);
  }
  // A final directory pass detects changes made while file identities and
  // hashes were being revalidated, including a newly inserted symlink.
  revalidateArchiveDirectories(allowedRoot, inventory);
}

function revalidateArchiveDirectories(allowedRoot: string, inventory: ArchiveInventory): void {
  for (const directory of inventory.directories) {
    const path = archivePath(allowedRoot, directory.relativePath);
    if (path !== directory.path) throw failure("archive-path-escape");
    assertArchivePath(allowedRoot, path, directory.relativePath);
    const stat = safeLstat(path, "archive-directory");
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), directory.identity)) {
      throw failure("archive-directory-drift");
    }
    const names = listArchiveNames(path);
    if (!sameNames(names, directory.names)) throw failure("archive-enumeration-drift");
    for (const name of names) {
      const child = directory.relativePath ? `${directory.relativePath}/${name}` : name;
      if (!inventory.entryPaths.has(child)) throw failure("archive-enumeration-drift");
    }
  }
}

function assertArchiveInventoryLimits(state: ArchiveScanState): void {
  const entryCount = state.directories.length + state.files.length;
  if (!Number.isSafeInteger(entryCount) || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw failure("archive-entry-count-exceeded");
  }
  if (!Number.isSafeInteger(state.bytes) || state.bytes > MAX_ARCHIVE_BYTES) {
    throw failure("archive-size-exceeded");
  }
}

function assertArchivePath(allowedRoot: string, path: string, relativePath: string): void {
  if (!isValidArchiveRelativePath(relativePath)
    || (relativePath ? !isContainedPath(allowedRoot, path) : path !== allowedRoot)
    || exactExistingPath(path, "archive-path-escape") !== path) {
    throw failure("archive-path-escape");
  }
}

function archivePath(allowedRoot: string, relativePath: string): string {
  if (!isValidArchiveRelativePath(relativePath)) throw failure("archive-path-escape");
  if (!relativePath) return allowedRoot;
  const path = join(allowedRoot, ...relativePath.split("/"));
  if (!isContainedPath(allowedRoot, path)) throw failure("archive-path-escape");
  return path;
}

function isValidArchiveRelativePath(value: string): boolean {
  return value === "" || (value.length > 0 && value.split("/").every(isArchiveEntryName));
}

function isArchiveEntryName(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".."
    && !value.includes("/") && !value.includes("\\");
}

function listArchiveNames(path: string): string[] {
  try { return readdirSync(path).sort((left, right) => left.localeCompare(right)); }
  catch { throw failure("archive-directory-read-failed"); }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function inspectNormalizedHistories(codexRoot: string): HistoryInventory {
  const directories: DirectoryEvidence[] = [];
  const files: HistoryFileEvidence[] = [];
  for (const artifact of ["sessions", "archived_sessions"] as const) {
    const root = join(codexRoot, artifact);
    if (optionalLstat(root, "normalized-history-artifact") === null) continue;
    scanNormalizedDirectory(root, artifact, "", directories, files);
  }
  const index = join(codexRoot, "session_index.jsonl");
  const indexStat = optionalLstat(index, "normalized-session-index");
  if (indexStat !== null) {
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.nlink !== 1 || !isOwnerPrivate(indexStat)) {
      throw failure("normalized-history-unsafe");
    }
    files.push(regularHistoryFile(index, "session_index.jsonl", "session_index.jsonl"));
  }
  return finalizeHistoryInventory(directories, files);
}

function scanHistoryDirectory(
  directory: string,
  artifact: HistoryTree,
  localRoot: string,
  allowedLinkRoot: string,
  directories: DirectoryEvidence[],
  files: HistoryFileEvidence[],
): void {
  const directoryStat = safeLstat(directory, "history-directory");
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure("unsafe-history-directory");
  directories.push({ relativePath: localRoot ? `${artifact}/${localRoot}` : artifact, identity: identity(directoryStat) });
  for (const name of listNames(directory)) {
    const path = join(directory, name);
    const local = localRoot ? `${localRoot}/${name}` : name;
    const stat = safeLstat(path, "history-entry");
    if (stat.isDirectory()) {
      scanHistoryDirectory(path, artifact, local, allowedLinkRoot, directories, files);
    } else if (stat.isSymbolicLink()) {
      files.push(linkedHistoryFile(path, artifact, local, allowedLinkRoot, stat));
    } else if (stat.isFile()) {
      files.push(regularHistoryFile(path, artifact, local));
    } else {
      throw failure("unsafe-history-entry");
    }
    assertInventoryLimits(files);
  }
}

function scanNormalizedDirectory(
  directory: string,
  artifact: HistoryTree,
  localRoot: string,
  directories: DirectoryEvidence[],
  files: HistoryFileEvidence[],
): void {
  const directoryStat = safeLstat(directory, "normalized-history-directory");
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !isOwnerPrivate(directoryStat)) {
    throw failure("normalized-history-unsafe");
  }
  directories.push({ relativePath: localRoot ? `${artifact}/${localRoot}` : artifact, identity: identity(directoryStat) });
  for (const name of listNames(directory)) {
    const path = join(directory, name);
    const local = localRoot ? `${localRoot}/${name}` : name;
    const stat = safeLstat(path, "normalized-history-entry");
    if (stat.isDirectory()) {
      scanNormalizedDirectory(path, artifact, local, directories, files);
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && isOwnerPrivate(stat)) {
      files.push(regularHistoryFile(path, artifact, local));
    } else {
      throw failure("normalized-history-unsafe");
    }
    assertInventoryLimits(files);
  }
}

function regularHistoryFile(
  path: string,
  artifact: HistoryFileEvidence["artifact"],
  relativePath: string,
): HistoryFileEvidence {
  const stat = safeLstat(path, "history-file");
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure("unsafe-history-file");
  const sha256 = hashStableRegular(path, stat);
  return {
    artifact,
    relativePath,
    sourcePath: path,
    copySourcePath: path,
    kind: "regular",
    sourceIdentity: identity(stat),
    targetIdentity: null,
    linkText: null,
    targetParents: [],
    sha256,
    bytes: stat.size,
  };
}

function linkedHistoryFile(
  sourcePath: string,
  artifact: HistoryTree,
  relativePath: string,
  allowedLinkRoot: string,
  linkStat: Stats,
): HistoryFileEvidence {
  if (linkStat.nlink !== 1) throw failure("history-link-hardlink-refused");
  const linkText = readLink(sourcePath);
  const target = resolve(dirname(sourcePath), linkText);
  const targetStat = safeLstat(target, "linked-history-target");
  if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
    throw failure("linked-history-target-unsafe");
  }
  let canonicalTarget: string;
  try { canonicalTarget = realpathSync(target); }
  catch { throw failure("linked-history-target-unsafe"); }
  if (canonicalTarget !== target || !isContainedPath(allowedLinkRoot, target)) {
    throw failure("link-outside-approved-root");
  }
  const targetParents = collectStableParents(allowedLinkRoot, dirname(target));
  const sha256 = hashStableRegular(target, targetStat);
  assertStableLink(sourcePath, linkStat, linkText);
  revalidateParents(targetParents);
  return {
    artifact,
    relativePath,
    sourcePath,
    copySourcePath: target,
    kind: "linked",
    sourceIdentity: identity(linkStat),
    targetIdentity: identity(targetStat),
    linkText,
    targetParents,
    sha256,
    bytes: targetStat.size,
  };
}

function finalizeHistoryInventory(
  directories: readonly DirectoryEvidence[],
  files: readonly HistoryFileEvidence[],
): HistoryInventory {
  const sortedDirectories = [...directories].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const sortedFiles = [...files].sort((left, right) => historyLocalPath(left).localeCompare(historyLocalPath(right)));
  assertInventoryLimits(sortedFiles);
  return {
    directories: sortedDirectories,
    files: sortedFiles,
    fingerprint: canonicalSha256Fingerprint({
      directories: sortedDirectories.map((entry) => ({ path: entry.relativePath, identity: entry.identity })),
      files: sortedFiles.map(fileFingerprintEvidence),
    }),
    regularHistoryFiles: sortedFiles.filter((file) => file.artifact !== "session_index.jsonl" && file.kind === "regular").length,
    linkedHistoryFiles: sortedFiles.filter((file) => file.kind === "linked").length,
    historyBytes: sortedFiles.reduce((sum, file) => sum + file.bytes, 0),
    sessionIndexPresent: sortedFiles.some((file) => file.artifact === "session_index.jsonl"),
  };
}

function inspectDatabases(root: string, sqlite: PrivateHistoryNormalizationSqliteAdapter): DatabaseInventory {
  assertExactDirectory(root, "sqlite-root", false);
  const paths = new Map<OfficialCodexDatabase, string>();
  const entries = OFFICIAL_CODEX_DATABASES.map((name): DatabaseEvidence => {
    const path = join(root, name);
    if (optionalLstat(path, `database-${name}`) === null) {
      return { name, present: false, bytes: 0, sha256: null, integrity: null };
    }
    const stat = assertRegular(path, "database", false, false);
    let integrity: "ok";
    try { integrity = sqlite.integrityCheck(path); }
    catch { throw failure("database-integrity-failed"); }
    if (integrity !== "ok") throw failure("database-integrity-failed");
    paths.set(name, path);
    return { name, present: true, bytes: stat.size, sha256: hashStableRegular(path, stat), integrity };
  });
  return { entries, paths, fingerprint: canonicalSha256Fingerprint(entries) };
}

function physicalRecordMap(histories: HistoryInventory): PhysicalRecord[] {
  const records: PhysicalRecord[] = [];
  const seenIds = new Set<string>();
  for (const file of histories.files) {
    if (file.artifact === "session_index.jsonl") continue;
    const id = rolloutFirstRecordThreadId(file.copySourcePath);
    if (seenIds.has(id)) throw failure("duplicate-rollout-thread-id");
    seenIds.add(id);
    records.push({ id, localPath: historyLocalPath(file) });
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function copyHistoryInventory(source: HistoryInventory, destinationCodexRoot: string): void {
  for (const artifact of ["sessions", "archived_sessions"] as const) {
    if (!source.directories.some((entry) => entry.relativePath === artifact)) continue;
    mkdirPrivateNew(join(destinationCodexRoot, artifact));
  }
  for (const directory of source.directories) {
    if (directory.relativePath === "sessions" || directory.relativePath === "archived_sessions") continue;
    mkdirPrivateNew(join(destinationCodexRoot, ...directory.relativePath.split("/")));
  }
  for (const file of source.files) {
    const destination = file.artifact === "session_index.jsonl"
      ? join(destinationCodexRoot, "session_index.jsonl")
      : join(destinationCodexRoot, file.artifact, ...file.relativePath.split("/"));
    copyStableRegular(file, destination);
  }
}

function cloneDatabases(
  source: DatabaseInventory,
  destinationSqliteRoot: string,
  sqlite: PrivateHistoryNormalizationSqliteAdapter,
): void {
  for (const entry of source.entries) {
    if (!entry.present) continue;
    const sourcePath = source.paths.get(entry.name);
    if (!sourcePath) throw failure("database-source-missing");
    const destination = join(destinationSqliteRoot, entry.name);
    try { sqlite.backup(sourcePath, destination); }
    catch { throw failure("database-backup-failed"); }
    chmodSync(destination, PRIVATE_FILE_MODE);
    assertRegular(destination, "normalized-database", true, false);
    try {
      if (sqlite.integrityCheck(destination) !== "ok") throw new Error("not ok");
    } catch {
      throw failure("database-integrity-failed");
    }
  }
}

function rewriteCandidateState(
  plan: NormalizationPlan,
  candidateSqliteRoot: string,
  sqlite: PrivateHistoryNormalizationSqliteAdapter,
): void {
  if (plan.updates.length === 0) return;
  const state = join(candidateSqliteRoot, "state_5.sqlite");
  if (!existsSync(state)) throw failure("candidate-state-database-missing");
  const before = readThreadRows(sqlite, state);
  if (threadRowsFingerprint(before) !== plan.threadRowsFingerprint) throw failure("database-backup-row-mismatch");
  try { sqlite.rewriteThreadRolloutPaths(state, plan.updates); }
  catch { throw failure("database-rewrite-failed"); }
  const after = readThreadRows(sqlite, state);
  assertThreadRewrite(plan, before, after);
  if (sqlite.integrityCheck(state) !== "ok") throw failure("database-integrity-failed");
}

function assertCandidateDatabaseRows(
  plan: NormalizationPlan,
  candidateSqliteRoot: string,
  sqlite: PrivateHistoryNormalizationSqliteAdapter,
): void {
  const state = join(candidateSqliteRoot, "state_5.sqlite");
  if (!existsSync(state)) {
    if (plan.threadRows.length !== 0) throw failure("candidate-state-database-missing");
    return;
  }
  const rows = readThreadRows(sqlite, state);
  assertThreadRewrite(plan, plan.threadRows, rows);
}

function assertThreadRewrite(
  plan: NormalizationPlan,
  before: readonly PrivateHistoryThreadRow[],
  after: readonly PrivateHistoryThreadRow[],
): void {
  if (before.length !== after.length || after.length !== plan.threadRows.length) throw failure("database-row-count-mismatch");
  if (nonRolloutRowsFingerprint(before) !== nonRolloutRowsFingerprint(after)
    || nonRolloutRowsFingerprint(after) !== plan.nonRolloutRowsFingerprint) {
    throw failure("database-non-rollout-change");
  }
  const beforeById = new Map(before.map((row) => [row.id, row]));
  const afterById = new Map(after.map((row) => [row.id, row]));
  const updateById = new Map(plan.updates.map((update) => [update.id, update]));
  if (beforeById.size !== before.length || afterById.size !== after.length) throw failure("invalid-or-duplicate-thread-id");
  for (const [id, prior] of beforeById) {
    const current = afterById.get(id);
    if (!current) throw failure("database-id-set-mismatch");
    const update = updateById.get(id);
    const expected = update ? update.rolloutPath : prior.rollout_path;
    if (prior.rollout_path !== (update?.expectedRolloutPath ?? prior.rollout_path)
      || current.rollout_path !== expected) throw failure("database-rewrite-mismatch");
  }
}

function assertNormalizedHistories(source: HistoryInventory, normalized: HistoryInventory): void {
  const sourceFiles = source.files.map((file) => ({
    local: historyLocalPath(file),
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  const normalizedFiles = normalized.files.map((file) => ({
    local: historyLocalPath(file),
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  if (canonicalSha256Fingerprint(sourceFiles) !== canonicalSha256Fingerprint(normalizedFiles)
    || normalized.linkedHistoryFiles !== 0
    || normalized.regularHistoryFiles !== source.regularHistoryFiles + source.linkedHistoryFiles
    || normalized.sessionIndexPresent !== source.sessionIndexPresent) {
    throw failure("normalized-history-mismatch");
  }
}

function createManifest(
  plan: NormalizationPlan,
  normalizedHistories: HistoryInventory,
  normalizedDatabases: DatabaseInventory,
  normalizedFingerprint: Sha256Fingerprint,
  now: string,
): PrivateHistoryNormalizationManifestV1 {
  if (!isCanonicalTimestamp(now)) throw failure("invalid-timestamp");
  return {
    schemaVersion: PRIVATE_HISTORY_NORMALIZATION_SCHEMA_VERSION,
    kind: "private-history-normalization",
    createdAt: now,
    sourceFingerprint: plan.sourceFingerprint,
    normalizedFingerprint,
    historyFingerprint: normalizedHistories.fingerprint,
    databaseFingerprint: normalizedDatabases.fingerprint,
    threadRowsFingerprint: plan.threadRowsFingerprint,
    nonRolloutRowsFingerprint: plan.nonRolloutRowsFingerprint,
    missingFingerprint: plan.missingFingerprint,
    rewriteFingerprint: plan.rewriteFingerprint,
    counts: {
      regularHistoryFiles: plan.histories.regularHistoryFiles,
      linkedHistoryFiles: plan.histories.linkedHistoryFiles,
      historyBytes: plan.histories.historyBytes,
      databaseThreadCount: plan.threadRows.length,
      importedThreadCount: plan.importedThreadIds.length,
      rewrittenRolloutPaths: plan.updates.filter((update) => update.rolloutPath !== null).length,
      clearedMissingRolloutPaths: plan.updates.filter((update) => update.rolloutPath === null).length,
      databasesPresent: plan.databases.entries.filter((entry) => entry.present).length,
    },
    histories: plan.histories.files.map((file) => ({
      artifact: file.artifact,
      relativePath: file.relativePath,
      kind: file.kind,
      bytes: file.bytes,
      sha256: file.sha256,
      sourceIdentityFingerprint: canonicalSha256Fingerprint(file.sourceIdentity),
      targetIdentityFingerprint: file.targetIdentity ? canonicalSha256Fingerprint(file.targetIdentity) : null,
    })),
    databasesBefore: plan.databases.entries,
    databasesAfter: normalizedDatabases.entries,
  };
}

function resultFor(
  status: PrivateHistoryNormalizationResult["status"],
  plan: NormalizationPlan,
  normalizedFingerprint: Sha256Fingerprint | null,
): PrivateHistoryNormalizationResult {
  return {
    status,
    sourceFingerprint: plan.sourceFingerprint,
    normalizedFingerprint,
    regularHistoryFiles: plan.histories.regularHistoryFiles,
    linkedHistoryFiles: plan.histories.linkedHistoryFiles,
    historyBytes: plan.histories.historyBytes,
    databaseThreadCount: plan.threadRows.length,
    importedThreadCount: plan.importedThreadIds.length,
    rewrittenRolloutPaths: plan.updates.filter((update) => update.rolloutPath !== null).length,
    clearedMissingRolloutPaths: plan.updates.filter((update) => update.rolloutPath === null).length,
    databasesPresent: plan.databases.entries.filter((entry) => entry.present).length,
    sessionIndexPresent: plan.histories.sessionIndexPresent,
    nextAction: status === "dry-run" ? "apply-normalization" : "run-adoption-dry-run",
  };
}

function readThreadRows(
  sqlite: PrivateHistoryNormalizationSqliteAdapter,
  path: string,
): readonly PrivateHistoryThreadRow[] {
  let rows: readonly PrivateHistoryThreadRow[];
  try { rows = sqlite.readThreadRows(path); }
  catch { throw failure("database-thread-read-failed"); }
  if (!Array.isArray(rows)) throw failure("database-thread-read-failed");
  return rows.map((row) => {
    if (!isPlainRecord(row) || typeof row.id !== "string"
      || !(typeof row.rollout_path === "string" || row.rollout_path === null)) {
      throw failure("database-thread-read-failed");
    }
    return structuredClone(row) as PrivateHistoryThreadRow;
  });
}

function threadRowsFingerprint(rows: readonly PrivateHistoryThreadRow[]): Sha256Fingerprint {
  return canonicalSha256Fingerprint([...rows].sort(compareId));
}

function nonRolloutRowsFingerprint(rows: readonly PrivateHistoryThreadRow[]): Sha256Fingerprint {
  return canonicalSha256Fingerprint([...rows].sort(compareId).map((row) => {
    const { rollout_path: _rolloutPath, ...copy } = row;
    return copy;
  }));
}

/** Production SQLite adapter, exported solely for direct guarded-update tests. */
export function privateHistoryNormalizationSqliteAdapter(): PrivateHistoryNormalizationSqliteAdapter {
  const invoke = (path: string, args: readonly string[], input?: string): string => {
    const result = spawnSync("/usr/bin/sqlite3", [...args, path], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") throw failure("sqlite-command-failed");
    return result.stdout;
  };
  return {
    backup(source, destination) {
      if (existsSync(destination)) throw failure("snapshot-destination-exists");
      const result = spawnSync("/usr/bin/sqlite3", [source, `.backup ${sqliteString(destination)}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error || result.status !== 0) throw failure("database-backup-failed");
    },
    integrityCheck(path) {
      if (invoke(path, [], "PRAGMA integrity_check;\n").trim() !== "ok") throw failure("database-integrity-failed");
      return "ok";
    },
    readThreadRows(path) {
      const output = invoke(path, ["-json"], "SELECT * FROM threads ORDER BY id;\n");
      let parsed: unknown;
      try { parsed = JSON.parse(output) as unknown; }
      catch { throw failure("database-thread-read-failed"); }
      if (!Array.isArray(parsed)) throw failure("database-thread-read-failed");
      return parsed as PrivateHistoryThreadRow[];
    },
    rewriteThreadRolloutPaths(path, updates) {
      const statements = [
        ".bail on",
        "BEGIN IMMEDIATE;",
        "CREATE TEMP TABLE _tweakers_history_guard(value INTEGER CHECK(value = 1));",
      ];
      for (const update of updates) {
        statements.push(
          `UPDATE threads SET rollout_path=${update.rolloutPath === null ? "NULL" : sqliteString(update.rolloutPath)} `
            + `WHERE id=${sqliteString(update.id)} AND rollout_path=${sqliteString(update.expectedRolloutPath)};`,
          "INSERT INTO _tweakers_history_guard(value) VALUES(changes());",
          "DELETE FROM _tweakers_history_guard;",
        );
      }
      statements.push("DROP TABLE _tweakers_history_guard;", "COMMIT;");
      invoke(path, [], `${statements.join("\n")}\n`);
    },
  };
}

function defaultCensus(input: { appPath: string; protectedPaths: readonly string[] }): HistoryAdoptionCensus {
  const observedAt = new Date().toISOString();
  try {
    const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") return unknownCensus(observedAt);
    const processCensus = privateHistoryProcessCensus(ps.stdout, input.appPath);
    let openFileCount = 0;
    for (const path of input.protectedPaths) {
      const lsof = spawnSync("/usr/sbin/lsof", ["-nP", "+D", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (lsof.error || (lsof.status !== 0 && lsof.status !== 1)) return unknownCensus(observedAt);
      if (typeof lsof.stdout === "string") openFileCount += lsof.stdout.split("\n").filter((line) => line.trim()).length;
    }
    return { ...processCensus, openFileCount, observedAt };
  } catch {
    return unknownCensus(observedAt);
  }
}

/** Aggregate-only trusted desktop-process gate used by private history setup. */
export function privateHistoryProcessCensus(
  output: string,
  inputAppPath: string,
  selfPid: number = process.pid,
): HistoryAdoptionProcessCensus {
  const processCensuses = [...new Set([...TRUSTED_DESKTOP_APP_PATHS, inputAppPath])]
    .map((appPath) => historyAdoptionProcessCensus(output, appPath, selfPid));
  return {
    app: processCensuses.some((entry) => entry.app === "running") ? "running" : "idle",
    main: processCensuses.some((entry) => entry.main === "running") ? "running" : "idle",
    // app-server detection is global in historyAdoptionProcessCensus. Keep it
    // fail-closed even if a caller supplies a different app path.
    appServer: processCensuses.some((entry) => entry.appServer === "running") ? "running" : "idle",
  };
}

function protectedPaths(paths: ReturnType<typeof normalizationPaths>): readonly string[] {
  return [paths.sourceCodexRoot, paths.sourceSqliteRoot, paths.allowedLinkRoot, dirname(paths.snapshotRoot)];
}

function assertIdle(census: HistoryAdoptionCensus): void {
  if (!isPlainRecord(census) || census.app !== "idle" || census.main !== "idle" || census.appServer !== "idle"
    || census.openFileCount !== 0 || !Number.isSafeInteger(census.openFileCount)
    || !isCanonicalTimestamp(census.observedAt)) throw failure("not-idle");
}

function unknownCensus(observedAt: string): HistoryAdoptionCensus {
  return { app: "unknown", main: "unknown", appServer: "unknown", openFileCount: -1, observedAt };
}

function createSnapshotRoot(root: string, snapshotParent: SnapshotParentAnchor): void {
  mkdirPrivateNew(root, snapshotParent);
  mkdirPrivateNew(join(root, "codex-home"));
  mkdirPrivateNew(join(root, "sqlite-home"));
}

function mkdirPrivateNew(path: string, expectedParent?: SnapshotParentAnchor): void {
  if (existsSync(path)) throw failure("snapshot-destination-exists");
  const parent = dirname(path);
  if (expectedParent) {
    if (parent !== expectedParent.path) throw failure("snapshot-parent-drift");
    assertSnapshotParentAnchor(expectedParent);
  } else {
    assertExactDirectory(parent, "private-parent", true);
  }
  try { mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE }); }
  catch { throw failure("private-directory-create-failed"); }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  assertExactDirectory(path, "private-directory", true);
}

function writePrivateJsonNew(path: string, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(path, PRIVATE_FILE_MODE);
    assertRegular(path, "manifest", true, false);
    fsyncDirectory(dirname(path));
  } catch (error) {
    throw error instanceof PrivateHistoryNormalizationFailure ? error : failure("manifest-write-failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    bytes.fill(0);
  }
}

function copyStableRegular(file: HistoryFileEvidence, destination: string): void {
  if (existsSync(destination)) throw failure("snapshot-destination-exists");
  revalidateHistoryEvidence(file);
  const expected = file.targetIdentity ?? file.sourceIdentity;
  const source = file.copySourcePath;
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  const hash = createHash("sha256");
  try {
    sourceDescriptor = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!sameIdentity(identity(fstatSync(sourceDescriptor)), expected)) throw failure("copy-source-drift");
    destinationDescriptor = openSync(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    let position = 0;
    while (position < expected.size) {
      const count = readSync(sourceDescriptor, buffer, 0, Math.min(buffer.byteLength, expected.size - position), position);
      if (count <= 0) throw failure("copy-source-read-failed");
      let written = 0;
      while (written < count) {
        const justWritten = writeSync(destinationDescriptor, buffer, written, count - written, position + written);
        if (justWritten <= 0) throw failure("snapshot-history-write-failed");
        written += justWritten;
      }
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (!sameIdentity(identity(fstatSync(sourceDescriptor)), expected)) throw failure("copy-source-drift");
    fsyncSync(destinationDescriptor);
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    chmodSync(destination, PRIVATE_FILE_MODE);
    const destinationStat = assertRegular(destination, "snapshot-history", true, expected.size === 0);
    if (destinationStat.size !== expected.size || `sha256:${hash.digest("hex")}` !== file.sha256) {
      throw failure("snapshot-history-copy-mismatch");
    }
    revalidateHistoryEvidence(file);
  } catch (error) {
    throw error instanceof PrivateHistoryNormalizationFailure ? error : failure("snapshot-history-copy-failed");
  } finally {
    buffer.fill(0);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
  }
}

function hashStableRegular(path: string, expectedStat: Stats): Sha256Fingerprint {
  const expected = identity(expectedStat);
  let descriptor: number | undefined;
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  const hash = createHash("sha256");
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!sameIdentity(identity(fstatSync(descriptor)), expected)) throw failure("hash-source-drift");
    let position = 0;
    while (position < expected.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, expected.size - position), position);
      if (count <= 0) throw failure("hash-source-read-failed");
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (!sameIdentity(identity(fstatSync(descriptor)), expected)
      || !sameIdentity(identity(safeLstat(path, "hash-source")), expected)) throw failure("hash-source-drift");
    return `sha256:${hash.digest("hex")}`;
  } catch (error) {
    throw error instanceof PrivateHistoryNormalizationFailure ? error : failure("hash-source-failed");
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function revalidateHistoryEvidence(file: HistoryFileEvidence): void {
  const sourceStat = safeLstat(file.sourcePath, "history-source");
  if (!sameIdentity(identity(sourceStat), file.sourceIdentity)) throw failure("source-drift");
  if (file.kind === "linked") {
    if (!sourceStat.isSymbolicLink() || readLink(file.sourcePath) !== file.linkText) throw failure("source-drift");
    if (!file.targetIdentity || !sameIdentity(identity(safeLstat(file.copySourcePath, "linked-target")), file.targetIdentity)) {
      throw failure("linked-target-drift");
    }
    revalidateParents(file.targetParents);
  } else if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw failure("source-drift");
  }
}

function collectStableParents(root: string, targetDirectory: string): ParentEvidence[] {
  if (targetDirectory !== root && !isContainedPath(root, targetDirectory)) throw failure("link-outside-approved-root");
  const output: ParentEvidence[] = [];
  let cursor = root;
  output.push(parentEvidence(cursor));
  const local = relative(root, targetDirectory);
  if (!local) return output;
  for (const part of local.split(sep)) {
    if (!part || part === "." || part === "..") throw failure("link-outside-approved-root");
    cursor = join(cursor, part);
    output.push(parentEvidence(cursor));
  }
  return output;
}

function parentEvidence(path: string): ParentEvidence {
  const stat = safeLstat(path, "linked-target-parent");
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("linked-target-parent-unsafe");
  return { path, identity: identity(stat) };
}

function revalidateParents(parents: readonly ParentEvidence[]): void {
  for (const parent of parents) {
    const stat = safeLstat(parent.path, "linked-target-parent");
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), parent.identity)) {
      throw failure("linked-target-parent-drift");
    }
  }
}

function assertStableLink(path: string, expected: Stats, linkText: string): void {
  const current = safeLstat(path, "history-link");
  if (!current.isSymbolicLink() || !sameIdentity(identity(current), identity(expected)) || readLink(path) !== linkText) {
    throw failure("history-link-drift");
  }
}

function assertNoExactArchiveCandidate(archive: ArchiveInventory, local: string): void {
  const parts = local.split("/");
  const candidates = [
    local,
    parts.slice(1).join("/"),
  ];
  if (candidates.some((candidate) => archive.entryPaths.has(candidate))) {
    throw failure("missing-path-recoverable");
  }
}

function containedRolloutLocal(sourceCodexRoot: string, rolloutPath: string): string {
  if (!isAbsolute(rolloutPath) || resolve(rolloutPath) !== rolloutPath) throw failure("rollout-path-escape");
  for (const artifact of ["sessions", "archived_sessions"] as const) {
    const root = join(sourceCodexRoot, artifact);
    if (!isContainedPath(root, rolloutPath)) continue;
    const local = relative(root, rolloutPath).split(sep).join("/");
    if (!local || local.split("/").some((part) => !part || part === "." || part === "..")) {
      throw failure("rollout-path-escape");
    }
    return `${artifact}/${local}`;
  }
  throw failure("rollout-path-escape");
}

function rolloutFirstRecordThreadId(path: string, suppliedStat?: Stats): string {
  const stat = suppliedStat ?? assertRegular(path, "rollout-first-record", false, false);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0
    || !sameIdentity(identity(safeLstat(path, "rollout-first-record")), identity(stat))) {
    throw failure("rollout-first-record-drift");
  }
  const expected = identity(stat);
  const capacity = Math.min(stat.size, MAX_FIRST_RECORD_BYTES);
  const buffer = Buffer.alloc(capacity);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!sameIdentity(identity(fstatSync(descriptor)), expected)) throw failure("rollout-first-record-drift");
    const count = readSync(descriptor, buffer, 0, capacity, 0);
    if (!sameIdentity(identity(fstatSync(descriptor)), expected)
      || !sameIdentity(identity(safeLstat(path, "rollout-first-record")), expected)) {
      throw failure("rollout-first-record-drift");
    }
    const newline = buffer.subarray(0, count).indexOf(0x0a);
    if (newline < 0) throw failure("invalid-rollout-first-record");
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as unknown; }
    catch { throw failure("invalid-rollout-first-record"); }
    let id: unknown = null;
    if (isPlainRecord(value) && value.type === "session_meta" && isPlainRecord(value.payload)) id = value.payload.id;
    if (id === null && isPlainRecord(value) && isPlainRecord(value.session_meta)
      && isPlainRecord(value.session_meta.payload)) id = value.session_meta.payload.id;
    if (!isCanonicalThreadId(id)) throw failure("invalid-rollout-thread-id");
    return id;
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertInventoryLimits(files: readonly HistoryFileEvidence[]): void {
  if (files.length > MAX_HISTORY_FILES) throw failure("history-file-count-exceeded");
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_HISTORY_BYTES) throw failure("history-size-exceeded");
}

function fileFingerprintEvidence(file: HistoryFileEvidence): Record<string, unknown> {
  return {
    path: historyLocalPath(file),
    kind: file.kind,
    bytes: file.bytes,
    sha256: file.sha256,
    sourceIdentity: file.sourceIdentity,
    targetIdentity: file.targetIdentity,
    linkTextFingerprint: file.linkText === null ? null : canonicalSha256Fingerprint(file.linkText),
    targetParents: file.targetParents.map((parent) => ({ identity: parent.identity })),
  };
}

function historyLocalPath(file: Pick<HistoryFileEvidence, "artifact" | "relativePath">): string {
  return file.artifact === "session_index.jsonl" ? "session_index.jsonl" : `${file.artifact}/${file.relativePath}`;
}

function identity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    nlink: stat.nlink,
    mode: stat.mode,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink && left.mode === right.mode;
}

function assertExactDirectory(path: string, label: string, ownerPrivate: boolean): Stats {
  const stat = safeLstat(path, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(`${label}-unsafe`);
  if (exactExistingPath(path, `${label}-unsafe`) !== path) throw failure(`${label}-symlink-refused`);
  if (ownerPrivate && !isOwnerPrivate(stat)) throw failure(`${label}-not-private`);
  return stat;
}

function assertSnapshotParentAnchor(anchor: SnapshotParentAnchor): void {
  assertSnapshotParentDescriptor(anchor);
  const stat = assertExactDirectory(anchor.path, "snapshot-parent", true);
  if (stat.dev !== anchor.dev || stat.ino !== anchor.ino) throw failure("snapshot-parent-drift");
}

function openSnapshotParentAnchor(path: string, expected: Stats): SnapshotParentAnchor {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory() || !isOwnerPrivate(stat) || stat.dev !== expected.dev || stat.ino !== expected.ino
      || exactExistingPath(path, "snapshot-parent-drift") !== path) {
      throw failure("snapshot-parent-drift");
    }
    const ownedDescriptor = descriptor;
    descriptor = undefined;
    return { path, dev: stat.dev, ino: stat.ino, descriptor: ownedDescriptor };
  } catch (error) {
    throw error instanceof PrivateHistoryNormalizationFailure ? error : failure("snapshot-parent-open-failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSnapshotParentDescriptor(anchor: SnapshotParentAnchor): void {
  let stat: Stats;
  try { stat = fstatSync(anchor.descriptor); }
  catch { throw failure("snapshot-parent-descriptor-failed"); }
  if (!stat.isDirectory() || !isOwnerPrivate(stat) || stat.dev !== anchor.dev || stat.ino !== anchor.ino) {
    throw failure("snapshot-parent-drift");
  }
}

function captureSnapshotCandidateAnchor(path: string, parent: SnapshotParentAnchor): SnapshotCandidateAnchor {
  assertSnapshotParentAnchor(parent);
  if (dirname(path) !== parent.path) throw failure("unsafe-snapshot-rename");
  const stat = safeLstat(path, "snapshot-candidate");
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnerPrivate(stat) || stat.dev !== parent.dev
    || exactExistingPath(path, "unsafe-snapshot-rename") !== path) {
    throw failure("unsafe-snapshot-rename");
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertRegular(path: string, label: string, ownerPrivate: boolean, allowEmpty: boolean): Stats {
  const stat = safeLstat(path, label);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (!allowEmpty && stat.size <= 0)) {
    throw failure(`${label}-unsafe`);
  }
  if (ownerPrivate && !isOwnerPrivate(stat)) throw failure(`${label}-not-private`);
  return stat;
}

function safeLstat(path: string, label: string): Stats {
  try { return lstatSync(path); }
  catch { throw failure(`${label}-missing-or-unsafe`); }
}

function optionalLstat(path: string, label: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if (isEnoent(error)) return null;
    throw failure(`${label}-unreadable`);
  }
}

function exactExistingPath(path: string, code: string): string {
  try { return realpathSync(path); }
  catch { throw failure(code); }
}

function exactAbsolute(path: string, code: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw failure(code);
  return path;
}

function isOwnerPrivate(stat: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return (uid === null || stat.uid === uid) && (stat.mode & 0o077) === 0;
}

function listNames(path: string): string[] {
  try { return readdirSync(path).sort((left, right) => left.localeCompare(right)); }
  catch { throw failure("history-directory-read-failed"); }
}

function readLink(path: string): string {
  try { return readlinkSync(path); }
  catch { throw failure("history-link-read-failed"); }
}

function isContainedPath(root: string, path: string): boolean {
  const local = relative(root, path);
  return local.length > 0 && !local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isContainedPath(left, right) || isContainedPath(right, left);
}

function uniqueSibling(path: string, prefix: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw failure("invalid-random-id");
  return join(dirname(path), `${prefix}-${id}`);
}

type PrivateRenameOutcome = "renamed" | "retained" | "source-retained";

/*
 * A path-based rename can be redirected when a same-user process replaces the
 * parent directory between lstat and rename. This helper anchors both names to
 * one O_DIRECTORY|O_NOFOLLOW descriptor and uses Darwin RENAME_EXCL so a
 * raced destination cannot be overwritten. It prints only one fixed status
 * token; no path, account, or history data crosses the process boundary.
 */
const ANCHORED_PRIVATE_RENAME_HELPER = String.raw`
import ctypes
import os
import stat
import sys

RENAME_EXCL = 0x00000004

def finish(token, status):
    sys.stdout.write(token)
    sys.exit(status)

def valid_name(value):
    return bool(value) and value not in (".", "..") and "/" not in value and "\\" not in value and "\x00" not in value

if len(sys.argv) != 9:
    finish("failed", 2)

parent, source, destination, retention, parent_dev, parent_ino, source_dev, source_ino = sys.argv[1:]
try:
    parent_dev = int(parent_dev)
    parent_ino = int(parent_ino)
    source_dev = int(source_dev)
    source_ino = int(source_ino)
except Exception:
    finish("failed", 2)

if (not os.path.isabs(parent) or os.path.normpath(parent) != parent
        or not valid_name(source) or not valid_name(destination)
        or source == destination
        or (retention and (not valid_name(retention) or retention in (source, destination)))):
    finish("failed", 2)

def same_identity(value, dev, ino):
    return value.st_dev == dev and value.st_ino == ino

def private_directory(value):
    return (stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid()
            and (value.st_mode & 0o077) == 0)

try:
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameatx_np.restype = ctypes.c_int
except Exception:
    finish("failed", 2)

def rename_exclusive(fd, old_name, new_name):
    ctypes.set_errno(0)
    return renameatx_np(fd, os.fsencode(old_name), fd, os.fsencode(new_name), RENAME_EXCL) == 0

def lstat_at(fd, name):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def parent_fd_valid(fd):
    value = os.fstat(fd)
    return private_directory(value) and same_identity(value, parent_dev, parent_ino)

def source_fd_valid(fd, name):
    value = lstat_at(fd, name)
    return value is not None and private_directory(value) and same_identity(value, source_dev, source_ino)

def visible_path_valid(fd, name):
    if not parent_fd_valid(fd):
        return False
    try:
        visible_parent = os.lstat(parent)
        visible_child = os.lstat(os.path.join(parent, name))
    except OSError:
        return False
    return (private_directory(visible_parent) and same_identity(visible_parent, parent_dev, parent_ino)
            and private_directory(visible_child) and same_identity(visible_child, source_dev, source_ino)
            and os.path.realpath(parent) == parent
            and os.path.realpath(os.path.join(parent, name)) == os.path.join(parent, name)
            and source_fd_valid(fd, name))

committed = False
fd = 3
try:
    if not parent_fd_valid(fd) or not source_fd_valid(fd, source):
        finish("failed", 2)
    if lstat_at(fd, destination) is not None:
        finish("failed", 2)
    if retention and lstat_at(fd, retention) is not None:
        finish("failed", 2)

    # The original parent descriptor is held by the Node process for the
    # entire normalization. If the visible path was replaced before this
    # helper started, retain through that descriptor and never touch the
    # replacement path.
    if not visible_path_valid(fd, source):
        if retention:
            if not rename_exclusive(fd, source, retention) or not source_fd_valid(fd, retention):
                finish("commit-retention-incomplete", 12)
            try:
                os.fsync(fd)
            except OSError:
                pass
            finish("retained", 0)
        finish("source-retained", 0)

    if not rename_exclusive(fd, source, destination):
        finish("failed", 2)
    committed = True
    if visible_path_valid(fd, destination):
        try:
            os.fsync(fd)
        except OSError:
            pass
        finish("renamed", 0)

    # The actual rename was contained by fd but its visible canonical path
    # changed. Retain the candidate through that same fd rather than touching
    # a replacement parent path.
    fallback = retention if retention else source
    if not source_fd_valid(fd, destination) or not rename_exclusive(fd, destination, fallback):
        finish("commit-retention-incomplete", 12)
    if not source_fd_valid(fd, fallback):
        finish("commit-retention-incomplete", 12)
    try:
        os.fsync(fd)
    except OSError:
        pass
    finish("retained" if retention else "source-retained", 0)
except Exception:
    finish("commit-retention-incomplete" if committed else "failed", 12 if committed else 2)
`;

function renamePrivateSibling(
  source: string,
  destination: string,
  snapshotParent: SnapshotParentAnchor,
  candidateAnchor: SnapshotCandidateAnchor,
  retentionDestination?: string,
): PrivateRenameOutcome {
  const parent = snapshotParent.path;
  const sourceName = privateSiblingName(source, parent);
  const destinationName = privateSiblingName(destination, parent);
  if (sourceName === destinationName) throw failure("unsafe-snapshot-rename");
  let retentionName = "";
  if (retentionDestination) {
    retentionName = privateSiblingName(retentionDestination, parent);
    if (retentionName === sourceName || retentionName === destinationName) throw failure("unsafe-snapshot-rename");
  }
  assertSnapshotParentDescriptor(snapshotParent);
  const result = spawnSync("/usr/bin/python3", [
    "-c",
    ANCHORED_PRIVATE_RENAME_HELPER,
    parent,
    sourceName,
    destinationName,
    retentionName,
    String(snapshotParent.dev),
    String(snapshotParent.ino),
    String(candidateAnchor.dev),
    String(candidateAnchor.ino),
  ], {
    encoding: "utf8",
    // Child fd 3 is the original O_DIRECTORY|O_NOFOLLOW snapshot parent.
    stdio: ["ignore", "pipe", "pipe", snapshotParent.descriptor],
  });
  if (result.error || typeof result.stdout !== "string") throw failure("snapshot-rename-failed");
  const outcome = result.stdout.trim();
  if (result.status === 0 && outcome === "renamed") {
    assertSnapshotParentAnchor(snapshotParent);
    const published = safeLstat(destination, "published-snapshot");
    if (!published.isDirectory() || published.isSymbolicLink() || !isOwnerPrivate(published)
      || published.dev !== candidateAnchor.dev || published.ino !== candidateAnchor.ino
      || exactExistingPath(destination, "snapshot-publication-path-drift") !== destination) {
      throw failure("snapshot-publication-path-drift");
    }
    return "renamed";
  }
  if (result.status === 0 && outcome === "retained" && retentionDestination) return "retained";
  if (result.status === 0 && outcome === "source-retained" && !retentionDestination) return "source-retained";
  if (outcome === "commit-retention-incomplete") throw failure("snapshot-rename-retention-incomplete");
  throw failure("snapshot-rename-failed");
}

function privateSiblingName(path: string, parent: string): string {
  const name = basename(path);
  if (dirname(path) !== parent || join(parent, name) !== path || !isPrivateSiblingName(name)) {
    throw failure("unsafe-snapshot-rename");
  }
  return name;
}

function isPrivateSiblingName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".."
    && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function isCommittedRenameFailure(error: unknown): boolean {
  return error instanceof PrivateHistoryNormalizationFailure
    && error.code === "history-normalization-snapshot-rename-retention-incomplete";
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // APFS may reject directory fsync. File fsync and same-directory rename
    // still retain the bounded, non-destructive publication path.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function redactedUpdate(update: PrivateHistoryRolloutUpdate): { id: string; old: Sha256Fingerprint; next: Sha256Fingerprint | null } {
  return {
    id: update.id,
    old: canonicalSha256Fingerprint(update.expectedRolloutPath),
    next: update.rolloutPath === null ? null : canonicalSha256Fingerprint(update.rolloutPath),
  };
}

function compareId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function isCanonicalThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return isPlainRecord(error) && error.code === "ENOENT";
}

function failure(suffix: string): PrivateHistoryNormalizationFailure {
  return new PrivateHistoryNormalizationFailure(`history-normalization-${suffix}`);
}

function redactFailure(error: unknown): PrivateHistoryNormalizationFailure {
  return error instanceof PrivateHistoryNormalizationFailure ? error : failure("unexpected-failure");
}

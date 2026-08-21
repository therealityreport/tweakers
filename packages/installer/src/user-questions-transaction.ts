import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { copyDirectoryPreservingModes } from "./fs-copy.js";
import {
  fingerprintPath,
  LEGACY_USER_QUESTIONS_TWEAK_IDS,
  type PathFingerprint,
  USER_QUESTIONS_FOLDER,
  USER_QUESTIONS_TWEAK_ID,
} from "./user-questions-source.js";

export type UserQuestionsSurfaceName = "live_payload" | "tweak_data" | "renderer_storage";
export type UserQuestionsSurfaceStatus = "absent" | "copy" | "canonical" | "conflict" | "ambiguous";

export interface UserQuestionsPathSurfaceSpec {
  name: UserQuestionsSurfaceName;
  canonicalPath: string;
  legacyPaths: string[];
  required?: boolean;
}

export interface UserQuestionsRolloutOptions {
  receiptFile: string;
  archiveRoot: string;
  pathSurfaces: UserQuestionsPathSurfaceSpec[];
  tweakersConfigPath: string;
  codexConfigPath: string;
  configNamespaceParents?: string[][];
  transactionId?: string;
  now?: Date;
}

export interface UserQuestionsPathSurfaceReceipt extends UserQuestionsPathSurfaceSpec {
  status: UserQuestionsSurfaceStatus;
  holdPromotion: boolean;
  canonicalBefore: PathFingerprint;
  canonicalAfter: PathFingerprint;
  selectedLegacyPath: string | null;
  selectedLegacyBefore: PathFingerprint;
  createdCanonical: boolean;
  preimagePath: string;
  legacyArchivePath: string | null;
}

export interface UserQuestionsConfigNamespaceReceipt {
  parent: string[];
  status: UserQuestionsSurfaceStatus;
  holdPromotion: boolean;
  selectedLegacyKey: string | null;
}

export interface UserQuestionsTrackedFileReceipt {
  path: string;
  before: PathFingerprint;
  after: PathFingerprint;
  preimagePath: string;
  commitBefore?: PathFingerprint;
  commitImagePath?: string;
}

export interface UserQuestionsRolloutReceipt {
  schemaVersion: 1;
  transactionId: string;
  phase: "planned" | "held" | "prepared" | "sealed" | "committing" | "committed" | "rolled_back";
  plannedAt: string;
  updatedAt: string;
  holdPromotion: boolean;
  mcpConflictCount: number | null;
  pathSurfaces: UserQuestionsPathSurfaceReceipt[];
  tweakersConfig: UserQuestionsTrackedFileReceipt;
  codexConfig: UserQuestionsTrackedFileReceipt;
  configNamespaces: UserQuestionsConfigNamespaceReceipt[];
  receiptFile: string;
  archiveRoot: string;
}

const DEFAULT_CONFIG_PARENTS = [["tweaks"], ["tweakUpdateChecks"]];

export function defaultUserQuestionsRolloutOptions(input: {
  userRoot: string;
  liveTweaksRoot: string;
  tweakersConfigPath: string;
  codexConfigPath: string;
  receiptFile: string;
  archiveRoot: string;
  transactionId?: string;
  now?: Date;
}): UserQuestionsRolloutOptions {
  const legacyIds = [...LEGACY_USER_QUESTIONS_TWEAK_IDS];
  return {
    receiptFile: input.receiptFile,
    archiveRoot: input.archiveRoot,
    transactionId: input.transactionId,
    now: input.now,
    tweakersConfigPath: input.tweakersConfigPath,
    codexConfigPath: input.codexConfigPath,
    configNamespaceParents: DEFAULT_CONFIG_PARENTS,
    pathSurfaces: [
      {
        name: "live_payload",
        canonicalPath: join(input.liveTweaksRoot, USER_QUESTIONS_FOLDER),
        legacyPaths: legacyIds.map((id) => join(input.liveTweaksRoot, id)),
        required: true,
      },
      {
        // Runtime-owned and boot-volatile: the tweak's broker rotates its
        // handshake file (fresh secret) and binds a Unix socket in this
        // directory on every app boot, including the promotion health probe.
        // Post-seal drift here is designed behavior — do not re-tighten the
        // canonical-after assertion for this surface (live failure 2026-08-19).
        name: "tweak_data",
        canonicalPath: join(input.userRoot, "tweak-data", USER_QUESTIONS_TWEAK_ID),
        legacyPaths: legacyIds.map((id) => join(input.userRoot, "tweak-data", id)),
      },
      {
        name: "renderer_storage",
        canonicalPath: join(input.userRoot, "storage", `${USER_QUESTIONS_TWEAK_ID}.json`),
        legacyPaths: legacyIds.map((id) => join(input.userRoot, "storage", `${id}.json`)),
      },
    ],
  };
}

export function planUserQuestionsRollout(options: UserQuestionsRolloutOptions): UserQuestionsRolloutReceipt {
  validateOptions(options);
  const transactionId = options.transactionId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(transactionId)) throw new Error("rollout transaction ID is invalid");
  const now = (options.now ?? new Date()).toISOString();
  const transactionRoot = join(options.archiveRoot, transactionId);
  const pathSurfaces = options.pathSurfaces.map((surface) => planPathSurface(surface, transactionRoot));
  const config = readJsonObject(options.tweakersConfigPath);
  const configNamespaces = (options.configNamespaceParents ?? DEFAULT_CONFIG_PARENTS).map((parent) => (
    planConfigNamespace(config, parent)
  ));
  const holdPromotion = pathSurfaces.some((surface) => surface.holdPromotion)
    || configNamespaces.some((namespace) => namespace.holdPromotion);
  return {
    schemaVersion: 1,
    transactionId,
    phase: "planned",
    plannedAt: now,
    updatedAt: now,
    holdPromotion,
    mcpConflictCount: null,
    pathSurfaces,
    tweakersConfig: trackedFile(options.tweakersConfigPath, join(transactionRoot, "preimages", "tweakers-config.json")),
    codexConfig: trackedFile(options.codexConfigPath, join(transactionRoot, "preimages", "codex-config.toml")),
    configNamespaces,
    receiptFile: options.receiptFile,
    archiveRoot: options.archiveRoot,
  };
}

export function prepareUserQuestionsRollout(receipt: UserQuestionsRolloutReceipt): UserQuestionsRolloutReceipt {
  if (receipt.phase === "prepared" || receipt.phase === "sealed" || receipt.phase === "committed") return receipt;
  if (receipt.phase !== "planned" && receipt.phase !== "held") throw new Error(`cannot prepare transaction in phase ${receipt.phase}`);
  if (receipt.holdPromotion) {
    const held = { ...receipt, phase: "held" as const, updatedAt: new Date().toISOString() };
    writeReceipt(held);
    return held;
  }

  const created: string[] = [];
  try {
    backupTrackedFile(receipt.tweakersConfig);
    backupTrackedFile(receipt.codexConfig);
    for (const surface of receipt.pathSurfaces) {
      backupPath(surface.canonicalPath, surface.canonicalBefore, surface.preimagePath);
      if (surface.status === "copy" && surface.selectedLegacyPath) {
        copyPathAtomic(surface.selectedLegacyPath, surface.canonicalPath);
        created.push(surface.canonicalPath);
        const observed = fingerprintPath(surface.canonicalPath);
        if (observed.hash !== surface.selectedLegacyBefore.hash || observed.mode !== surface.selectedLegacyBefore.mode) {
          throw new Error(`prepared ${surface.name} did not match its legacy source`);
        }
        surface.createdCanonical = true;
      }
      surface.canonicalAfter = fingerprintPath(surface.canonicalPath);
    }

    const config = readJsonObject(receipt.tweakersConfig.path);
    let configChanged = false;
    for (const namespace of receipt.configNamespaces) {
      if (namespace.status !== "copy" || namespace.selectedLegacyKey === null) continue;
      const parent = getOrCreateRecord(config, namespace.parent);
      if (Object.hasOwn(parent, USER_QUESTIONS_TWEAK_ID)) {
        throw new Error(`canonical config namespace appeared during prepare: ${namespace.parent.join(".")}`);
      }
      parent[USER_QUESTIONS_TWEAK_ID] = cloneJson(parent[namespace.selectedLegacyKey]);
      configChanged = true;
    }
    if (configChanged) writeJsonAtomic(receipt.tweakersConfig.path, config, receipt.tweakersConfig.before.mode ?? 0o600);
    receipt.tweakersConfig.after = fingerprintPath(receipt.tweakersConfig.path);
    receipt.codexConfig.after = fingerprintPath(receipt.codexConfig.path);
    const prepared = { ...receipt, phase: "prepared" as const, updatedAt: new Date().toISOString() };
    writeReceipt(prepared);
    return prepared;
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { recursive: true, force: true });
    restoreTrackedFileUnchecked(receipt.tweakersConfig);
    throw error;
  }
}

/** Capture post-promotion hashes only after T6 reports zero MCP conflicts. */
export function sealUserQuestionsRollout(
  receipt: UserQuestionsRolloutReceipt,
  input: { mcpConflictCount: number },
): UserQuestionsRolloutReceipt {
  if (receipt.phase === "sealed" || receipt.phase === "committed") return receipt;
  if (receipt.phase !== "prepared") throw new Error(`cannot seal transaction in phase ${receipt.phase}`);
  if (!Number.isInteger(input.mcpConflictCount) || input.mcpConflictCount !== 0) {
    throw new Error("User Questions rollout cannot seal with MCP conflicts");
  }
  for (const surface of receipt.pathSurfaces) surface.canonicalAfter = fingerprintPath(surface.canonicalPath);
  receipt.tweakersConfig.after = fingerprintPath(receipt.tweakersConfig.path);
  receipt.codexConfig.after = fingerprintPath(receipt.codexConfig.path);
  const sealed = {
    ...receipt,
    phase: "sealed" as const,
    mcpConflictCount: 0,
    updatedAt: new Date().toISOString(),
  };
  writeReceipt(sealed);
  return sealed;
}

export function commitUserQuestionsRollout(receipt: UserQuestionsRolloutReceipt): UserQuestionsRolloutReceipt {
  if (receipt.phase === "committed") return receipt;
  if ((receipt.phase !== "sealed" && receipt.phase !== "committing") || receipt.holdPromotion || receipt.mcpConflictCount !== 0) {
    throw new Error("User Questions rollout is not accepted and sealed");
  }
  assertCanonicalAfterState(receipt, { allowCommitBefore: receipt.phase === "committing" });
  for (const surface of receipt.pathSurfaces) {
    if (surface.selectedLegacyPath === null || surface.selectedLegacyBefore.kind === "missing") continue;
    const currentLegacy = fingerprintPath(surface.selectedLegacyPath);
    if (
      currentLegacy.kind === "missing"
      && receipt.phase === "committing"
      && surface.legacyArchivePath !== null
      && sameFingerprint(fingerprintPath(surface.legacyArchivePath), surface.selectedLegacyBefore)
    ) continue;
    if (!sameFingerprint(currentLegacy, surface.selectedLegacyBefore)) {
      throw new Error(`${surface.name} legacy state changed before commit`);
    }
  }

  const committing: UserQuestionsRolloutReceipt = receipt.phase === "committing"
    ? receipt
    : { ...receipt, phase: "committing", updatedAt: new Date().toISOString() };
  writeReceipt(committing);
  for (const surface of committing.pathSurfaces) {
    if (surface.selectedLegacyPath === null || surface.selectedLegacyBefore.kind === "missing") continue;
    const archivePath = join(committing.archiveRoot, committing.transactionId, "legacy", surface.name, basename(surface.selectedLegacyPath));
    mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
    if (!existsSync(archivePath)) copyPathAtomic(surface.selectedLegacyPath, archivePath);
    if (!sameFingerprint(fingerprintPath(archivePath), surface.selectedLegacyBefore)) {
      throw new Error(`${surface.name} legacy archive verification failed`);
    }
    surface.legacyArchivePath = archivePath;
    writeReceipt(committing);
    if (existsSync(surface.selectedLegacyPath)) rmSync(surface.selectedLegacyPath, { recursive: true, force: true });
  }

  if (!committing.tweakersConfig.commitImagePath) {
    const config = readJsonObject(committing.tweakersConfig.path);
    for (const namespace of committing.configNamespaces) {
      if (namespace.selectedLegacyKey === null) continue;
      const parent = getRecord(config, namespace.parent);
      if (parent) delete parent[namespace.selectedLegacyKey];
    }
    const commitImagePath = join(
      committing.archiveRoot,
      committing.transactionId,
      "commit-images",
      "tweakers-config.json",
    );
    writeJsonAtomic(commitImagePath, config, committing.tweakersConfig.after.mode ?? 0o600);
    committing.tweakersConfig.commitBefore = committing.tweakersConfig.after;
    committing.tweakersConfig.commitImagePath = commitImagePath;
    committing.tweakersConfig.after = fingerprintPath(commitImagePath);
    writeReceipt(committing);
  }
  const configCurrent = fingerprintPath(committing.tweakersConfig.path);
  if (sameFingerprint(configCurrent, committing.tweakersConfig.commitBefore!)) {
    writeBytesAtomic(
      committing.tweakersConfig.path,
      readFileSync(committing.tweakersConfig.commitImagePath!),
      committing.tweakersConfig.after.mode ?? 0o600,
    );
  } else if (!sameFingerprint(configCurrent, committing.tweakersConfig.after)) {
    throw new Error("Tweakers config changed during commit");
  }
  const committed = { ...committing, phase: "committed" as const, updatedAt: new Date().toISOString() };
  writeReceipt(committed);
  return committed;
}

export function rollbackUserQuestionsRollout(receipt: UserQuestionsRolloutReceipt): UserQuestionsRolloutReceipt {
  if (receipt.phase === "rolled_back") return receipt;
  if (receipt.phase === "planned" || receipt.phase === "held") {
    const rolledBack = { ...receipt, phase: "rolled_back" as const, updatedAt: new Date().toISOString() };
    writeReceipt(rolledBack);
    return rolledBack;
  }
  for (const surface of receipt.pathSurfaces) {
    if (surface.legacyArchivePath === null) continue;
    if (!sameFingerprint(fingerprintPath(surface.legacyArchivePath), surface.selectedLegacyBefore)) {
      throw new Error(`${surface.name} legacy archive changed before rollback`);
    }
    const liveLegacy = fingerprintPath(surface.selectedLegacyPath!);
    if (liveLegacy.kind !== "missing" && !sameFingerprint(liveLegacy, surface.selectedLegacyBefore)) {
      throw new Error(`${surface.name} legacy path changed before rollback`);
    }
  }

  for (const surface of receipt.pathSurfaces) {
    // The rollout owns a canonical path only when prepare created it from a
    // legacy source. Pre-existing payload, data, and renderer storage remain
    // live user/runtime surfaces: app startup may legitimately update them
    // after sealing, and the outer app-install transaction owns any payload
    // rollback. Never replace those paths with this migration's observation.
    if (surface.createdCanonical) retireCreatedCanonical(surface, receipt);
  }
  restoreTrackedFile(receipt.tweakersConfig, receipt.phase === "committing");
  restoreTrackedFile(receipt.codexConfig);
  for (const surface of receipt.pathSurfaces) {
    if (surface.legacyArchivePath === null || surface.selectedLegacyPath === null) continue;
    if (!existsSync(surface.selectedLegacyPath)) copyPathAtomic(surface.legacyArchivePath, surface.selectedLegacyPath);
  }
  const rolledBack = { ...receipt, phase: "rolled_back" as const, updatedAt: new Date().toISOString() };
  writeReceipt(rolledBack);
  return rolledBack;
}

export function readUserQuestionsRolloutReceipt(path: string): UserQuestionsRolloutReceipt | null {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || stat.size > 256 * 1024
    ) return null;
    const receipt = JSON.parse(readFileSync(path, "utf8")) as UserQuestionsRolloutReceipt;
    const phases = new Set(["planned", "held", "prepared", "sealed", "committing", "committed", "rolled_back"]);
    if (
      receipt.schemaVersion !== 1
      || typeof receipt.transactionId !== "string"
      || !/^[A-Za-z0-9._-]{1,128}$/.test(receipt.transactionId)
      || !phases.has(receipt.phase)
      || receipt.receiptFile !== path
      || !Array.isArray(receipt.pathSurfaces)
      || !Array.isArray(receipt.configNamespaces)
    ) return null;
    return receipt;
  } catch { return null; }
}

function planPathSurface(surface: UserQuestionsPathSurfaceSpec, transactionRoot: string): UserQuestionsPathSurfaceReceipt {
  const canonicalBefore = fingerprintPath(surface.canonicalPath);
  const existingLegacy = surface.legacyPaths
    .map((path) => ({ path, fingerprint: fingerprintPath(path) }))
    .filter((entry) => entry.fingerprint.kind !== "missing");
  let status: UserQuestionsSurfaceStatus;
  let holdPromotion = false;
  if (existingLegacy.length > 1) {
    status = "ambiguous";
    holdPromotion = true;
  } else if (canonicalBefore.kind === "missing" && existingLegacy.length === 1) {
    status = "copy";
  } else if (canonicalBefore.kind === "missing") {
    status = "absent";
    holdPromotion = surface.required === true;
  } else if (existingLegacy.length === 0) {
    status = "canonical";
  } else if (sameFingerprint(canonicalBefore, existingLegacy[0]!.fingerprint)) {
    status = "canonical";
  } else {
    status = "conflict";
    holdPromotion = true;
  }
  const selected = existingLegacy.length === 1 ? existingLegacy[0]! : null;
  return {
    ...surface,
    legacyPaths: [...surface.legacyPaths],
    status,
    holdPromotion,
    canonicalBefore,
    canonicalAfter: canonicalBefore,
    selectedLegacyPath: selected?.path ?? null,
    selectedLegacyBefore: selected?.fingerprint ?? { kind: "missing", mode: null, hash: "missing" },
    createdCanonical: false,
    preimagePath: join(transactionRoot, "preimages", surface.name, "canonical"),
    legacyArchivePath: null,
  };
}

function planConfigNamespace(config: Record<string, unknown>, parentPath: string[]): UserQuestionsConfigNamespaceReceipt {
  const parent = getRecord(config, parentPath);
  if (!parent) return { parent: [...parentPath], status: "absent", holdPromotion: false, selectedLegacyKey: null };
  const legacyKeys = LEGACY_USER_QUESTIONS_TWEAK_IDS.filter((key) => Object.hasOwn(parent, key));
  const canonicalPresent = Object.hasOwn(parent, USER_QUESTIONS_TWEAK_ID);
  if (legacyKeys.length > 1) return { parent: [...parentPath], status: "ambiguous", holdPromotion: true, selectedLegacyKey: null };
  const selectedLegacyKey = legacyKeys[0] ?? null;
  if (!canonicalPresent && selectedLegacyKey) return { parent: [...parentPath], status: "copy", holdPromotion: false, selectedLegacyKey };
  if (!canonicalPresent) return { parent: [...parentPath], status: "absent", holdPromotion: false, selectedLegacyKey: null };
  if (!selectedLegacyKey) return { parent: [...parentPath], status: "canonical", holdPromotion: false, selectedLegacyKey: null };
  const equal = JSON.stringify(parent[USER_QUESTIONS_TWEAK_ID]) === JSON.stringify(parent[selectedLegacyKey]);
  return { parent: [...parentPath], status: equal ? "canonical" : "conflict", holdPromotion: !equal, selectedLegacyKey };
}

function trackedFile(path: string, preimagePath: string): UserQuestionsTrackedFileReceipt {
  const before = fingerprintPath(path);
  if (before.kind === "directory") throw new Error(`tracked config must not be a directory: ${path}`);
  return { path, before, after: before, preimagePath };
}

function validateOptions(options: UserQuestionsRolloutOptions): void {
  const paths = [options.receiptFile, options.archiveRoot, options.tweakersConfigPath, options.codexConfigPath];
  for (const surface of options.pathSurfaces) paths.push(surface.canonicalPath, ...surface.legacyPaths);
  for (const path of paths) {
    if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error(`rollout path must be exact and absolute: ${path}`);
  }
  if (new Set(options.pathSurfaces.map((surface) => surface.name)).size !== options.pathSurfaces.length) {
    throw new Error("rollout surface names must be unique");
  }
  const mutablePaths = [
    options.receiptFile,
    options.tweakersConfigPath,
    options.codexConfigPath,
    ...options.pathSurfaces.flatMap((surface) => [surface.canonicalPath, ...surface.legacyPaths]),
  ];
  if (new Set(mutablePaths).size !== mutablePaths.length) throw new Error("rollout paths must be unique");
  for (const parent of options.configNamespaceParents ?? DEFAULT_CONFIG_PARENTS) {
    if (parent.length === 0 || parent.some((key) => !/^[A-Za-z0-9._-]{1,128}$/.test(key))) {
      throw new Error("config namespace parent is invalid");
    }
  }
}

function backupTrackedFile(file: UserQuestionsTrackedFileReceipt): void {
  backupPath(file.path, file.before, file.preimagePath);
}

function backupPath(source: string, fingerprint: PathFingerprint, destination: string): void {
  if (fingerprint.kind === "missing") return;
  if (existsSync(destination)) {
    if (!sameFingerprint(fingerprintPath(destination), fingerprint)) throw new Error(`preimage collision: ${destination}`);
    return;
  }
  copyPathAtomic(source, destination);
  if (!sameFingerprint(fingerprintPath(destination), fingerprint)) throw new Error(`preimage verification failed: ${destination}`);
}

function copyPathAtomic(source: string, destination: string): void {
  const sourceProof = fingerprintPath(source);
  if (sourceProof.kind === "missing") throw new Error(`copy source is missing: ${source}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    if (sourceProof.kind === "directory") {
      copyDirectoryPreservingModes(source, temporary);
    } else {
      cpSync(source, temporary, { errorOnExist: true, force: false, verbatimSymlinks: true });
      if (sourceProof.mode !== null) chmodSync(temporary, sourceProof.mode);
    }
    if (existsSync(destination)) throw new Error(`copy destination already exists: ${destination}`);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Remove a canonical path this migration created. `createdCanonical` implies
 * the preimage was "missing", so restoring it means clearing the path. The
 * runtime may have legitimately rewritten the path after sealing (broker
 * handshake rotation during the promotion health probe — live failure
 * 2026-08-19), and fingerprinting can even throw while the running app holds
 * a socket inside the directory. Rollback must still clear the created path —
 * a leftover copy plans as a conflict and holds every future rollout — so
 * drifted contents are salvaged into the transaction archive instead of
 * blocking rollback or being destroyed. Never throws; safe to retry.
 */
function retireCreatedCanonical(surface: UserQuestionsPathSurfaceReceipt, receipt: UserQuestionsRolloutReceipt): void {
  let drifted = true;
  try {
    const current = fingerprintPath(surface.canonicalPath);
    if (current.kind === "missing") return;
    drifted = !sameFingerprint(current, surface.canonicalAfter);
  } catch {
    // Unsupported entries (e.g. a live broker socket) count as drift.
  }
  if (!drifted) {
    rmSync(surface.canonicalPath, { recursive: true, force: true });
    return;
  }
  try {
    const salvageRoot = join(receipt.archiveRoot, receipt.transactionId, "salvage");
    mkdirSync(salvageRoot, { recursive: true, mode: 0o700 });
    let destination = join(salvageRoot, surface.name);
    if (existsSync(destination)) destination = `${destination}-${process.pid}-${randomUUID()}`;
    renameSync(surface.canonicalPath, destination);
  } catch {
    try {
      renameSync(surface.canonicalPath, `${surface.canonicalPath}.salvaged.${process.pid}.${randomUUID()}`);
    } catch {
      // The path vanished or cannot move; leave it for the next rollout plan.
    }
  }
}

function restoreTrackedFile(file: UserQuestionsTrackedFileReceipt, allowCommitBefore = false): void {
  const current = fingerprintPath(file.path);
  if (
    !sameFingerprint(current, file.after)
    && !(allowCommitBefore && file.commitBefore && sameFingerprint(current, file.commitBefore))
  ) throw new Error(`tracked file changed before rollback: ${file.path}`);
  restoreTrackedFileUnchecked(file);
}

function restoreTrackedFileUnchecked(file: UserQuestionsTrackedFileReceipt): void {
  if (file.before.kind === "missing") {
    rmSync(file.path, { force: true });
    return;
  }
  const bytes = readFileSync(file.preimagePath);
  writeBytesAtomic(file.path, bytes, file.before.mode ?? 0o600);
}

function assertCanonicalAfterState(
  receipt: UserQuestionsRolloutReceipt,
  options: { allowCommitBefore?: boolean } = {},
): void {
  for (const surface of receipt.pathSurfaces) {
    // Only the installer-owned live payload must stay byte-stable between
    // sealing and commit, and only when this migration created it. The
    // runtime-owned data and renderer-storage surfaces are legitimately
    // rewritten by app boots inside the acceptance window (broker handshake
    // rotation during the promotion health probe — live failure 2026-08-19).
    if (surface.name !== "live_payload" || !surface.createdCanonical) continue;
    if (!sameFingerprint(fingerprintPath(surface.canonicalPath), surface.canonicalAfter)) {
      throw new Error(`${surface.name} canonical state changed after sealing`);
    }
  }
  for (const file of [receipt.tweakersConfig, receipt.codexConfig]) {
    const observed = fingerprintPath(file.path);
    if (sameFingerprint(observed, file.after)) continue;
    if (options.allowCommitBefore && file.commitBefore && sameFingerprint(observed, file.commitBefore)) continue;
    throw new Error(`tracked file changed after sealing: ${file.path}`);
  }
}

function sameFingerprint(a: PathFingerprint, b: PathFingerprint): boolean {
  return a.kind === b.kind && a.mode === b.mode && a.hash === b.hash;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`config must contain a JSON object: ${path}`);
  return parsed as Record<string, unknown>;
}

function getRecord(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current: Record<string, unknown> = root;
  for (const key of path) {
    const value = current[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    current = value as Record<string, unknown>;
  }
  return current;
}

function getOrCreateRecord(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const value = current[key];
    if (value === undefined) current[key] = {};
    else if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`config namespace parent is not an object: ${path.join(".")}`);
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function writeJsonAtomic(path: string, value: Record<string, unknown>, mode: number): void {
  writeBytesAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode);
}

function writeReceipt(receipt: UserQuestionsRolloutReceipt): void {
  writeBytesAtomic(receipt.receiptFile, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600);
}

function writeBytesAtomic(path: string, bytes: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
  chmodSync(path, mode);
}

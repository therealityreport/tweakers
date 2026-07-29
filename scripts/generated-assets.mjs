import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Return conflict-copy entries only when the canonical sibling exists. This
 * deliberately avoids treating legitimate names ending in a number as
 * conflicts and never inspects paths outside the exact generated root.
 */
export function findGeneratedConflictCopies(root) {
  if (!existsSync(root)) return [];
  const conflicts = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const canonical = conflictCopyCanonicalName(entry.name);
      const path = join(directory, entry.name);
      if (canonical && names.has(canonical)) {
        conflicts.push(path);
        continue;
      }
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(resolve(root));
  return conflicts.sort();
}

export function removeGeneratedConflictCopies(root) {
  const conflicts = findGeneratedConflictCopies(root);
  for (const path of conflicts.sort((a, b) => b.length - a.length)) {
    rmSync(path, { recursive: true, force: true });
  }
  return conflicts;
}

export function assertNoGeneratedConflictCopies(root) {
  const conflicts = findGeneratedConflictCopies(root);
  if (conflicts.length > 0) {
    throw new Error(`generated asset staging contains conflict copies: ${conflicts.join(", ")}`);
  }
}

/**
 * Build and fully validate a desired generated tree beside its destination,
 * then reconcile it path-by-path. Unchanged files and directories retain
 * their inodes. Changed files are published with rename-over-existing (there
 * is no unlink/write gap). A private journal restores every mutation if any
 * later publication step fails.
 */
export function publishGeneratedDirectorySync(destination, populate, dependencies = {}) {
  const destinationPath = resolve(destination);
  const parent = dirname(destinationPath);
  mkdirSync(parent, { recursive: true });

  const makeTemporaryDirectory = dependencies.mkdtemp ?? mkdtempSync;
  const rename = dependencies.rename ?? renameSync;
  const remove = dependencies.remove ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const cleanupWorkspace = dependencies.cleanupWorkspace ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const onCleanupError = dependencies.onCleanupError ?? defaultCleanupReporter;
  const afterMutation = dependencies.afterMutation ?? (() => {});
  const workspace = makeTemporaryDirectory(join(parent, `.${basename(destinationPath)}.publish-`));
  const staged = join(workspace, "next");
  const journal = join(workspace, "journal");
  const rollback = [];
  let mutationCount = 0;
  let committed = false;
  let publicationResult = null;

  const mutated = (path, operation) => {
    mutationCount += 1;
    afterMutation({ path, operation, mutationCount });
  };

  try {
    populate(staged);
    if (!existsSync(staged) || !lstatSync(staged).isDirectory()) {
      throw new Error(`generated asset staging did not create a directory: ${staged}`);
    }
    assertNoGeneratedConflictCopies(staged);

    // Reading every staged file and symlink before the first destination
    // mutation makes truncated, unreadable, or unsupported output fail closed.
    const desired = scanGeneratedTree(staged);
    const current = existsSync(destinationPath) ? scanGeneratedTree(destinationPath) : null;
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    const companionFiles = prepareCompanionFiles(
      typeof dependencies.companionFiles === "function"
        ? dependencies.companionFiles()
        : dependencies.companionFiles,
      workspace,
    );

    if (!current) {
      mkdirSync(destinationPath, { mode: desired.rootMode });
      rollback.push({ kind: "remove", path: destinationPath });
      mutated(destinationPath, "create-directory");
    } else if (current.rootType !== "directory") {
      throw new Error(`generated asset destination is not a directory: ${destinationPath}`);
    } else if (current.rootMode !== desired.rootMode) {
      rollback.push({ kind: "chmod", path: destinationPath, mode: current.rootMode });
      chmodSync(destinationPath, desired.rootMode);
      mutated(destinationPath, "chmod-directory");
    }

    const desiredDirectories = [...desired.entries.entries()]
      .filter(([, entry]) => entry.type === "directory")
      .sort(([a], [b]) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
    for (const [name, entry] of desiredDirectories) {
      const target = join(destinationPath, name);
      const existing = pathEntry(target);
      if (!existing) {
        mkdirSync(target, { mode: entry.mode });
        rollback.push({ kind: "remove", path: target });
        mutated(target, "create-directory");
      } else if (existing.type !== "directory") {
        const backup = backupNode(existing, target, journal, rollback.length);
        rollback.push({ kind: "restore", path: target, backup, type: existing.type });
        remove(target);
        mkdirSync(target, { mode: entry.mode });
        mutated(target, "replace-with-directory");
      } else if (existing.mode !== entry.mode) {
        rollback.push({ kind: "chmod", path: target, mode: existing.mode });
        chmodSync(target, entry.mode);
        mutated(target, "chmod-directory");
      }
    }

    const desiredLeaves = [...desired.entries.entries()]
      .filter(([, entry]) => entry.type !== "directory")
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name, entry] of desiredLeaves) {
      const source = join(staged, name);
      const target = join(destinationPath, name);
      const existing = pathEntry(target, true);
      if (existing && generatedEntriesEqual(existing, entry)) continue;

      if (existing) {
        const backup = backupNode(existing, target, journal, rollback.length);
        rollback.push({ kind: "restore", path: target, backup, type: existing.type });
        // rename(2) atomically replaces files and symlinks. A directory must
        // be removed first because POSIX will not replace it with a leaf.
        if (existing.type === "directory") remove(target);
      } else {
        rollback.push({ kind: "remove", path: target });
      }
      rename(source, target);
      mutated(target, existing ? "replace-leaf" : "create-leaf");
    }

    // Stale removal is intentionally last, after the complete desired tree has
    // been validated and all desired paths have been published successfully.
    const published = scanGeneratedTree(destinationPath);
    const staleRoots = [...published.entries.keys()]
      .filter((name) => !desired.entries.has(name))
      .filter((name, _index, stale) => !ancestorNames(name).some((ancestor) => stale.includes(ancestor)))
      .sort((a, b) => pathDepth(b) - pathDepth(a) || b.localeCompare(a));
    for (const name of staleRoots) {
      const target = join(destinationPath, name);
      const existing = pathEntry(target);
      if (!existing) continue;
      const backup = backupNode(existing, target, journal, rollback.length);
      rollback.push({ kind: "restore", path: target, backup, type: existing.type });
      remove(target);
      mutated(target, "remove-stale");
    }

    for (const companion of companionFiles) {
      const existing = pathEntry(companion.destination, true);
      if (existing && generatedEntriesEqual(existing, companion.entry)) continue;
      if (existing && existing.type !== "file") {
        throw new Error(`generated companion destination is not a file: ${companion.destination}`);
      }
      if (existing) {
        const backup = backupNode(existing, companion.destination, journal, rollback.length);
        rollback.push({ kind: "restore", path: companion.destination, backup, type: existing.type });
      } else {
        mkdirSync(dirname(companion.destination), { recursive: true });
        rollback.push({ kind: "remove", path: companion.destination });
      }
      rename(companion.staged, companion.destination);
      mutated(companion.destination, existing ? "replace-companion" : "create-companion");
    }

    publicationResult = { mutationCount, cleanupErrors: [] };
    committed = true;
    return publicationResult;
  } catch (error) {
    const rollbackErrors = [];
    for (const action of rollback.reverse()) {
      try {
        if (action.kind === "remove") {
          remove(action.path);
        } else if (action.kind === "chmod") {
          if (existsSync(action.path)) chmodSync(action.path, action.mode);
        } else {
          restoreBackup(action.backup, action.path, action.type, rename, remove);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `generated asset publication and rollback failed: ${destinationPath}`);
    }
    throw error;
  } finally {
    // Cleanup is outside the commit decision. Once every journaled mutation
    // succeeds, a FileProvider cleanup error may leave a private temp path but
    // must not turn the committed publication into an unrolled-back failure.
    try {
      cleanupWorkspace(workspace);
    } catch (cleanupError) {
      publicationResult?.cleanupErrors.push({ workspace, message: errorMessage(cleanupError) });
      reportCleanupError(onCleanupError, cleanupError, { committed, workspace });
    }
  }
}

/** Atomically replace one changed generated file without touching an equal one. */
export function replaceGeneratedFileSync(source, destination, dependencies = {}) {
  const sourceEntry = pathEntry(source, true);
  if (!sourceEntry || sourceEntry.type !== "file") throw new Error(`generated file source is missing: ${source}`);
  const destinationEntry = pathEntry(destination, true);
  if (destinationEntry && generatedEntriesEqual(sourceEntry, destinationEntry)) return false;

  const destinationPath = resolve(destination);
  const parent = dirname(destinationPath);
  mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, `.${basename(destinationPath)}.publish-`));
  const staged = join(workspace, "next");
  let committed = false;
  try {
    copyFileSync(source, staged);
    chmodSync(staged, sourceEntry.mode);
    renameSync(staged, destinationPath);
    committed = true;
    return true;
  } finally {
    try {
      (dependencies.cleanupWorkspace ?? ((path) => rmSync(path, { recursive: true, force: true })))(workspace);
    } catch (cleanupError) {
      reportCleanupError(dependencies.onCleanupError ?? defaultCleanupReporter, cleanupError, { committed, workspace });
    }
  }
}

function scanGeneratedTree(root) {
  const rootEntry = pathEntry(root);
  if (!rootEntry) throw new Error(`generated asset tree is missing: ${root}`);
  const entries = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      const info = pathEntry(path, true);
      if (!info) throw new Error(`generated asset disappeared during validation: ${path}`);
      entries.set(name, info);
      if (info.type === "directory") visit(path);
    }
  };
  if (rootEntry.type === "directory") visit(root);
  return { rootType: rootEntry.type, rootMode: rootEntry.mode, entries };
}

function pathEntry(path, includeData = false) {
  if (!existsSync(path) && !isDanglingSymlink(path)) return null;
  const stat = lstatSync(path);
  const mode = stat.mode & 0o7777;
  if (stat.isDirectory()) return { type: "directory", mode };
  if (stat.isFile()) return { type: "file", mode, ...(includeData ? { data: readFileSync(path) } : {}) };
  if (stat.isSymbolicLink()) return { type: "symlink", mode, target: readlinkSync(path) };
  throw new Error(`unsupported generated asset type: ${path}`);
}

function generatedEntriesEqual(left, right) {
  if (left.type !== right.type || left.mode !== right.mode) return false;
  if (left.type === "file") return left.data.equals(right.data);
  if (left.type === "symlink") return left.target === right.target;
  return true;
}

function backupNode(entry, source, journal, index) {
  const backup = join(journal, String(index));
  if (entry.type === "directory") {
    cpSync(source, backup, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  } else if (entry.type === "symlink") {
    symlinkSync(entry.target, backup);
  } else {
    // A hard-link journal retains the exact old inode after rename-overwrite,
    // allowing rollback to restore identity as well as bytes and mode.
    linkSync(source, backup);
  }
  return backup;
}

function prepareCompanionFiles(companions = [], workspace) {
  const root = join(workspace, "companions");
  const prepared = [];
  for (const [index, companion] of (companions ?? []).entries()) {
    if (!companion || typeof companion.destination !== "string") {
      throw new Error("generated companion destination is required");
    }
    const data = Buffer.isBuffer(companion.data) ? companion.data : Buffer.from(String(companion.data ?? ""));
    const destination = resolve(companion.destination);
    const current = pathEntry(destination, true);
    const mode = companion.mode ?? (current?.type === "file" ? current.mode : 0o644);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const staged = join(root, String(index));
    writeFileSync(staged, data, { mode });
    chmodSync(staged, mode);
    prepared.push({ destination, staged, entry: { type: "file", mode, data } });
  }
  return prepared;
}

function restoreBackup(backup, destination, type, rename, remove) {
  mkdirSync(dirname(destination), { recursive: true });
  const current = pathEntry(destination);
  if (current?.type === "directory" || type === "directory") remove(destination);
  rename(backup, destination);
}

function ancestorNames(name) {
  const parts = name.split("/");
  const ancestors = [];
  for (let index = 1; index < parts.length; index += 1) ancestors.push(parts.slice(0, index).join("/"));
  return ancestors;
}

function pathDepth(name) {
  return name.split("/").length;
}

function isDanglingSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function reportCleanupError(callback, error, context) {
  try {
    callback(error, context);
  } catch {
    // Observability must never change the already-decided commit outcome.
  }
}

function defaultCleanupReporter(error, context) {
  console.warn(
    `[generated-assets] workspace cleanup failed after ${context.committed ? "commit" : "rollback"}; retained exact root ${context.workspace}: ${errorMessage(error)}`,
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function conflictCopyCanonicalName(name) {
  const withExtension = /^(.*) ([0-9]+)(\.[^/]+)$/.exec(name);
  if (withExtension && Number(withExtension[2]) >= 2) return `${withExtension[1]}${withExtension[3]}`;
  const withoutExtension = /^(.*) ([0-9]+)$/.exec(name);
  return withoutExtension && Number(withoutExtension[2]) >= 2 ? withoutExtension[1] : null;
}

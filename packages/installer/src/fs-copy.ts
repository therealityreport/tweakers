import {
  chmodSync,
  cpSync,
  lchmodSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Finder writes `.DS_Store` into any directory the user merely browses,
 * including receipt-owned prepared artifacts — which permanently breaks their
 * recorded fingerprints and strands transactions in unrecoverable states.
 * The junk policy is deliberately limited to `.DS_Store`: AppleDouble `._*`
 * names do not materialize on APFS and can collide with legitimate content
 * (e.g. inside node_modules), and `.localized` carries user-visible semantics.
 */
export function isMacOsJunkName(name: string): boolean {
  return name === ".DS_Store";
}

/**
 * Remove Finder junk from a staged artifact tree. Only regular files whose
 * name matches the junk policy are unlinked; symlinks are never followed, so
 * a symlink named like junk inside a receipt-owned artifact cannot be used to
 * delete anything outside the tree.
 */
export function sweepMacOsJunk(root: string): void {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    // Finder can rewrite or remove its own junk concurrently; an entry that
    // vanished between readdir and lstat is exactly the outcome the sweep
    // wanted, never a reason to abort the enclosing copy or rollback.
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      sweepMacOsJunk(path);
      continue;
    }
    if (stat.isFile() && isMacOsJunkName(entry.name)) {
      rmSync(path, { force: true });
    }
  }
}

/**
 * `cpSync` applies the process umask to newly created entries. Environment
 * evidence fingerprints permission bits, so a receipt-owned helper running
 * with umask 077 must restore the source permissions before the copy can be
 * trusted. Symlink modes are restored with lchmod so their targets are never
 * followed.
 */
export function copyDirectoryPreservingModes(source: string, destination: string): void {
  const sourceRoot = lstatSync(source);
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) {
    throw new Error(`Directory copy source must be a real directory: ${source}`);
  }
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  sweepMacOsJunk(destination);
  restoreDirectoryModes(source, destination);
}

/**
 * `lchmod` exists only where the platform provides it (macOS). Everywhere else
 * a symlink carries no independent mode, so there is nothing to restore.
 */
const canChmodSymlinks = typeof lchmodSync === "function";

export function restoreDirectoryModes(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  const destinationStat = lstatSync(destination);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()
    || !destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error(`Directory copy did not preserve directory structure at ${source}`);
  }

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    // Junk swept from the destination has no counterpart to restore.
    if (isMacOsJunkName(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const sourceEntry = lstatSync(sourcePath);
    const destinationEntry = lstatSync(destinationPath);
    if (sourceEntry.isSymbolicLink()) {
      if (!destinationEntry.isSymbolicLink()) {
        throw new Error(`Directory copy did not preserve symlink at ${sourcePath}`);
      }
      if (canChmodSymlinks && (destinationEntry.mode & 0o7777) !== (sourceEntry.mode & 0o7777)) {
        lchmodSync(destinationPath, sourceEntry.mode & 0o7777);
      }
      continue;
    }
    if (sourceEntry.isDirectory()) {
      restoreDirectoryModes(sourcePath, destinationPath);
      continue;
    }
    if (!sourceEntry.isFile() || !destinationEntry.isFile()) {
      throw new Error(`Directory copy does not support special entry ${sourcePath}`);
    }
    chmodSync(destinationPath, sourceEntry.mode & 0o7777);
  }

  // Directories must be chmodded after their children so restrictive source
  // modes cannot prevent traversal while the copy is being repaired.
  chmodSync(destination, sourceStat.mode & 0o7777);
}

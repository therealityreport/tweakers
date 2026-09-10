import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

export interface CandidatePackagePathIdentity {
  dev: number;
  ino: number;
  ctimeMs: number;
}

/**
 * A path projected without following any existing symlink. `physicalPath` is
 * the canonical existing ancestor plus the validated unresolved tail, so it
 * remains useful when the selected leaf does not exist yet.
 */
export interface CandidatePackagePathProjection {
  path: string;
  physicalPath: string;
  existingAncestor: string;
  unresolvedTail: readonly string[];
  existingAncestorIdentity: CandidatePackagePathIdentity;
  finalIdentity: CandidatePackagePathIdentity | null;
}

export interface CandidatePackageParentAnchor {
  path: string;
  descriptor: number;
  dev: number;
  ino: number;
}

export interface CandidatePackageScratchAnchor {
  path: string;
  name: string;
  descriptor: number;
  dev: number;
  ino: number;
}

export class CandidatePackageFilesystemError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CandidatePackageFilesystemError";
  }
}

function fail(code: string, detail?: string): never {
  throw new CandidatePackageFilesystemError(code, detail);
}

function identity(stat: Stats): CandidatePackagePathIdentity {
  return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

function sameDirectoryIdentity(stat: Stats, expected: Pick<CandidatePackagePathIdentity, "dev" | "ino">): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("candidate-path-unreadable", path);
  }
}

function assertExactAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("candidate-path-not-exact-absolute", label);
  }
  return path;
}

function assertSafePathComponent(component: string, label: string): void {
  if (!component || component === "." || component === ".." || component.includes("/") || component.includes("\\") || component.includes("\0")) {
    fail("candidate-path-component-invalid", label);
  }
}

/**
 * Walk every existing path component with lstat. A lexical path that reaches
 * an existing alias, symlink, unreadable node, or non-directory intermediary
 * is rejected rather than canonicalized into a potentially dangerous target.
 */
export function projectCandidatePackagePath(path: string, label: string): CandidatePackagePathProjection {
  const exact = assertExactAbsolute(path, label);
  const parts = exact.split(sep).filter(Boolean);
  let cursor: string = sep;
  let finalIdentity: CandidatePackagePathIdentity | null = null;

  const root = lstatOrNull(cursor);
  if (!root || !root.isDirectory() || root.isSymbolicLink() || realpathSync(cursor) !== cursor) {
    fail("candidate-path-root-unsafe", label);
  }
  let ancestor = cursor;
  let ancestorStat = root;

  for (let index = 0; index < parts.length; index += 1) {
    const component = parts[index]!;
    assertSafePathComponent(component, label);
    cursor = cursor === sep ? `${sep}${component}` : join(cursor, component);
    const stat = lstatOrNull(cursor);
    if (stat === null) {
      const unresolvedTail = parts.slice(index);
      return {
        path: exact,
        physicalPath: join(ancestor, ...unresolvedTail),
        existingAncestor: ancestor,
        unresolvedTail,
        existingAncestorIdentity: identity(ancestorStat),
        finalIdentity: null,
      };
    }
    if (stat.isSymbolicLink()) fail("candidate-path-symlink-refused", `${label}: ${cursor}`);
    if (realpathSync(cursor) !== cursor) fail("candidate-path-physical-alias-refused", `${label}: ${cursor}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail("candidate-path-non-directory-intermediate", `${label}: ${cursor}`);
    }
    ancestor = cursor;
    ancestorStat = stat;
    if (index === parts.length - 1) finalIdentity = identity(stat);
  }

  return {
    path: exact,
    physicalPath: ancestor,
    existingAncestor: ancestor,
    unresolvedTail: [],
    existingAncestorIdentity: identity(ancestorStat),
    finalIdentity,
  };
}

function pathContains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

export function assertCandidatePackagePathsDisjoint(
  left: CandidatePackagePathProjection,
  right: CandidatePackagePathProjection,
  leftLabel: string,
  rightLabel: string,
): void {
  if (pathContains(left.physicalPath, right.physicalPath) || pathContains(right.physicalPath, left.physicalPath)) {
    fail("candidate-path-overlap", `${leftLabel} and ${rightLabel}`);
  }
  if (left.finalIdentity && right.finalIdentity
    && left.finalIdentity.dev === right.finalIdentity.dev
    && left.finalIdentity.ino === right.finalIdentity.ino) {
    fail("candidate-path-identity-alias", `${leftLabel} and ${rightLabel}`);
  }
}

export function assertCandidatePackageExistingDirectory(
  projection: CandidatePackagePathProjection,
  label: string,
): Stats {
  if (projection.unresolvedTail.length !== 0) fail("candidate-path-missing", label);
  const stat = lstatOrNull(projection.path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(projection.path) !== projection.path) {
    fail("candidate-path-directory-unsafe", label);
  }
  return stat;
}

function assertOwnerPrivateDirectory(stat: Stats, label: string): void {
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (uid !== undefined && stat.uid !== uid)
    || (Number(stat.mode) & 0o077) !== 0) {
    fail("candidate-owner-private-parent-required", label);
  }
}

export function openCandidatePackageParentAnchor(
  projection: CandidatePackagePathProjection,
  label: string,
): CandidatePackageParentAnchor {
  const expected = assertCandidatePackageExistingDirectory(projection, label);
  assertOwnerPrivateDirectory(expected, label);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(projection.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const observed = fstatSync(descriptor);
    if (!sameDirectoryIdentity(observed, expected) || realpathSync(projection.path) !== projection.path) {
      fail("candidate-parent-anchor-drift", label);
    }
    const anchor = { path: projection.path, descriptor, dev: observed.dev, ino: observed.ino };
    descriptor = undefined;
    return anchor;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function closeCandidatePackageParentAnchor(anchor: CandidatePackageParentAnchor): void {
  closeSync(anchor.descriptor);
}

/** Close the no-follow scratch descriptor after publication or retained failure evidence is observed. */
export function closeCandidatePackageScratchAnchor(anchor: CandidatePackageScratchAnchor): void {
  closeSync(anchor.descriptor);
}

/** Revalidate both the inherited descriptor and the visible parent spelling. */
export function assertCandidatePackageParentAnchor(anchor: CandidatePackageParentAnchor): void {
  let descriptorStat: Stats;
  try {
    descriptorStat = fstatSync(anchor.descriptor);
  } catch {
    fail("candidate-parent-descriptor-unavailable", anchor.path);
  }
  if (!sameDirectoryIdentity(descriptorStat, anchor)) fail("candidate-parent-descriptor-drift", anchor.path);
  assertOwnerPrivateDirectory(descriptorStat, anchor.path);
  const visible = lstatOrNull(anchor.path);
  if (!visible || !sameDirectoryIdentity(visible, anchor) || realpathSync(anchor.path) !== anchor.path) {
    fail("candidate-parent-visible-drift", anchor.path);
  }
}

function privateSiblingName(path: string, anchor: CandidatePackageParentAnchor, label: string): string {
  if (resolve(path) !== path || dirnameOf(path) !== anchor.path) {
    fail("candidate-sibling-not-anchored", label);
  }
  const name = basename(path);
  assertSafePathComponent(name, label);
  if (join(anchor.path, name) !== path) fail("candidate-sibling-not-anchored", label);
  return name;
}

function dirnameOf(path: string): string {
  const lastSeparator = path.lastIndexOf(sep);
  return lastSeparator <= 0 ? sep : path.slice(0, lastSeparator);
}

const ANCHORED_CANDIDATE_PACKAGE_HELPER = String.raw`
import ctypes
import errno
import os
import stat
import sys

RENAME_EXCL = 0x00000004

def finish(token, status):
    sys.stdout.write(token)
    sys.exit(status)

def valid_name(value):
    return bool(value) and value not in (".", "..") and "/" not in value and "\\" not in value and "\x00" not in value

if len(sys.argv) != 10:
    finish("failed", 2)

operation, parent, source, destination, retention, parent_dev, parent_ino, source_dev, source_ino = sys.argv[1:]
try:
    parent_dev = int(parent_dev)
    parent_ino = int(parent_ino)
    source_dev = int(source_dev)
    source_ino = int(source_ino)
except Exception:
    finish("failed", 2)

if operation not in ("mkdir", "rename", "retain") or not os.path.isabs(parent) or os.path.normpath(parent) != parent:
    finish("failed", 2)
if not valid_name(source) or (operation != "mkdir" and not valid_name(destination)):
    finish("failed", 2)
if operation == "rename" and retention and (not valid_name(retention) or retention in (source, destination)):
    finish("failed", 2)

def same_identity(value, dev, ino):
    return value.st_dev == dev and value.st_ino == ino

def private_directory(value):
    return stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid() and (value.st_mode & 0o077) == 0

def parent_fd_valid(fd):
    value = os.fstat(fd)
    return private_directory(value) and same_identity(value, parent_dev, parent_ino)

def lstat_at(fd, name):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def source_valid(fd, name):
    value = lstat_at(fd, name)
    return value is not None and private_directory(value) and same_identity(value, source_dev, source_ino)

def visible_parent_valid():
    try:
        value = os.lstat(parent)
        return private_directory(value) and same_identity(value, parent_dev, parent_ino) and os.path.realpath(parent) == parent
    except Exception:
        return False

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

try:
    fd = 3
    if not parent_fd_valid(fd):
        finish("parent-drift", 3)
    if operation == "mkdir":
        if lstat_at(fd, source) is not None:
            finish("destination-exists", 4)
        os.mkdir(source, 0o700, dir_fd=fd)
        value = lstat_at(fd, source)
        if value is None or not private_directory(value):
            finish("failed", 2)
        try:
            os.fsync(fd)
        except OSError:
            pass
        finish("created", 0)

    if operation == "rename" and not visible_parent_valid():
        finish("parent-drift", 3)
    if not source_valid(fd, source):
        finish("source-drift", 3)
    if lstat_at(fd, destination) is not None:
        finish("destination-exists", 4)
    if not rename_exclusive(fd, source, destination):
        if lstat_at(fd, destination) is not None:
            finish("destination-exists", 4)
        finish("failed", 2)
    try:
        os.fsync(fd)
    except OSError:
        pass
    if not source_valid(fd, destination):
        finish("commit-retention-incomplete", 12)
    if visible_parent_valid():
        try:
            visible = os.lstat(os.path.join(parent, destination))
            if private_directory(visible) and same_identity(visible, source_dev, source_ino) and os.path.realpath(os.path.join(parent, destination)) == os.path.join(parent, destination):
                finish("renamed", 0)
        except Exception:
            pass
    if operation == "rename" and retention and lstat_at(fd, retention) is None and rename_exclusive(fd, destination, retention):
        try:
            os.fsync(fd)
        except OSError:
            pass
        if source_valid(fd, retention):
            finish("retained", 0)
    finish("commit-retention-incomplete", 12)
except Exception:
    finish("failed", 2)
`;

function runAnchoredHelper(
  anchor: CandidatePackageParentAnchor,
  operation: "mkdir" | "rename" | "retain",
  source: string,
  destination: string,
  retention: string,
  sourceIdentity: Pick<CandidatePackageScratchAnchor, "dev" | "ino">,
): string {
  const result = spawnSync("/usr/bin/python3", [
    "-c",
    ANCHORED_CANDIDATE_PACKAGE_HELPER,
    operation,
    anchor.path,
    source,
    destination,
    retention,
    String(anchor.dev),
    String(anchor.ino),
    String(sourceIdentity.dev),
    String(sourceIdentity.ino),
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", anchor.descriptor],
  });
  if (result.error || typeof result.stdout !== "string") {
    fail("candidate-anchored-helper-unavailable", String(result.error ?? "no result"));
  }
  return result.stdout.trim();
}

export function createCandidatePackageScratch(
  path: string,
  anchor: CandidatePackageParentAnchor,
): CandidatePackageScratchAnchor {
  assertCandidatePackageParentAnchor(anchor);
  const name = privateSiblingName(path, anchor, "candidate scratch");
  const result = runAnchoredHelper(anchor, "mkdir", name, "-", "", { dev: anchor.dev, ino: anchor.ino });
  if (result === "destination-exists") fail("candidate-scratch-exists", path);
  if (result === "parent-drift") fail("candidate-parent-visible-drift", anchor.path);
  if (result !== "created") fail("candidate-scratch-create-failed", result);
  assertCandidatePackageParentAnchor(anchor);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const descriptorStat = fstatSync(descriptor);
    const visible = lstatOrNull(path);
    if (!visible || !sameDirectoryIdentity(visible, descriptorStat)
      || !descriptorStat.isDirectory()
      || descriptorStat.dev !== anchor.dev
      || realpathSync(path) !== path) {
      fail("candidate-scratch-identity-invalid", path);
    }
    assertOwnerPrivateDirectory(descriptorStat, path);
    const scratch = { path, name, descriptor, dev: descriptorStat.dev, ino: descriptorStat.ino };
    descriptor = undefined;
    return scratch;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertCandidatePackageScratchAnchor(
  scratch: CandidatePackageScratchAnchor,
  parent: CandidatePackageParentAnchor,
): void {
  assertCandidatePackageParentAnchor(parent);
  if (dirnameOf(scratch.path) !== parent.path || privateSiblingName(scratch.path, parent, "candidate scratch") !== scratch.name) {
    fail("candidate-scratch-parent-drift", scratch.path);
  }
  let descriptorStat: Stats;
  try {
    descriptorStat = fstatSync(scratch.descriptor);
  } catch {
    fail("candidate-scratch-descriptor-unavailable", scratch.path);
  }
  if (!sameDirectoryIdentity(descriptorStat, scratch)) fail("candidate-scratch-descriptor-drift", scratch.path);
  assertOwnerPrivateDirectory(descriptorStat, scratch.path);
  const stat = lstatOrNull(scratch.path);
  if (!stat || !sameDirectoryIdentity(stat, scratch) || realpathSync(scratch.path) !== scratch.path) {
    fail("candidate-scratch-identity-drift", scratch.path);
  }
  assertOwnerPrivateDirectory(stat, scratch.path);
}

export type CandidatePackagePublicationOutcome = "renamed" | "destination-exists" | "retained" | "source-retained";

/**
 * Rename a direct scratch sibling without replacement. The caller must retain
 * the parent descriptor until it has either observed the final package or
 * reported the preserved source evidence.
 */
export function publishCandidatePackageExclusively(input: {
  source: CandidatePackageScratchAnchor;
  destination: string;
  retentionDestination?: string;
  parent: CandidatePackageParentAnchor;
}): CandidatePackagePublicationOutcome {
  const sourceName = privateSiblingName(input.source.path, input.parent, "candidate source");
  const destinationName = privateSiblingName(input.destination, input.parent, "candidate destination");
  const retentionName = input.retentionDestination
    ? privateSiblingName(input.retentionDestination, input.parent, "candidate retention")
    : "";
  if (sourceName === destinationName || sourceName === retentionName || destinationName === retentionName) {
    fail("candidate-publication-name-conflict");
  }
  const result = runAnchoredHelper(input.parent, "rename", sourceName, destinationName, retentionName, input.source);
  if (result === "renamed" || result === "retained") return result;
  if (result === "destination-exists") return result;
  if (result === "parent-drift") fail("candidate-parent-visible-drift", input.parent.path);
  if (result === "commit-retention-incomplete") fail("candidate-publication-retention-incomplete", input.destination);
  fail("candidate-publication-failed", result);
}

/** Preserve a partial only through its already-held parent descriptor. */
export function retainCandidatePackageEvidence(input: {
  source: CandidatePackageScratchAnchor;
  destination: string;
  parent: CandidatePackageParentAnchor;
}): CandidatePackagePublicationOutcome {
  const sourceName = privateSiblingName(input.source.path, input.parent, "candidate source");
  const destinationName = privateSiblingName(input.destination, input.parent, "candidate failed evidence");
  if (sourceName === destinationName) fail("candidate-publication-name-conflict");
  const result = runAnchoredHelper(input.parent, "retain", sourceName, destinationName, "", input.source);
  if (result === "renamed") return "renamed";
  if (result === "destination-exists") return result;
  if (result === "parent-drift") return "source-retained";
  if (result === "commit-retention-incomplete") return "source-retained";
  return "source-retained";
}

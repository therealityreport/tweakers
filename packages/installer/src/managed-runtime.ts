import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { installCliShims, type CliShimOptions, type CliShimResult } from "./cli-shim.js";
import { isMacOsJunkName, sweepMacOsJunk } from "./fs-copy.js";

const MANAGED_RUNTIME_COPY_ALLOWLIST = [
  "package.json",
  "package-lock.json",
  "bin",
  "node_modules",
  join("packages", "installer", "package.json"),
  join("packages", "installer", "dist"),
  join("packages", "installer", "assets"),
  join("packages", "sdk", "package.json"),
  join("packages", "sdk", "dist"),
] as const;

const MANAGED_RUNTIME_CONTROL_PLANE_ALLOWLIST = [
  "package.json",
  "package-lock.json",
  "bin",
  join("packages", "installer", "package.json"),
  join("packages", "installer", "dist"),
  join("packages", "sdk", "package.json"),
  join("packages", "sdk", "dist"),
] as const;

export interface ManagedRuntimeProvenance {
  kind?: string;
  installedAt?: string;
  sourceRuntimeHash?: string;
  [key: string]: unknown;
}

export interface StageManagedRuntimeOptions {
  /**
   * Provenance for this exact staged copy. Supplying it keeps candidate
   * staging deterministic; the normal install path retains its timestamped
   * development-bootstrap receipt.
   */
  provenance?: ManagedRuntimeProvenance;
}

export function managedSourceRoot(userRoot: string): string {
  return join(userRoot, "managed-runtime", "current");
}

export function managedCliPath(userRoot: string): string {
  return join(managedSourceRoot(userRoot), "packages", "installer", "dist", "cli.js");
}

function fingerprintManagedRuntimeEntries(
  sourceRoot: string,
  allowlist: readonly string[],
): string {
  const root = resolve(sourceRoot);
  const hash = createHash("sha256");
  const add = (type: string, relativePath: string, mode: number, payload: Buffer): void => {
    hash.update(`${type}\0${relativePath.replaceAll("\\", "/")}\0${(mode & 0o7777).toString(8)}\0${payload.length}\0`);
    hash.update(payload);
  };
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const relativePath = relative(root, path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      add("directory", relativePath, stat.mode, Buffer.alloc(0));
      for (const entry of readdirSync(path).sort((left, right) => left.localeCompare(right))) {
        if (isMacOsJunkName(entry)) continue;
        visit(join(path, entry));
      }
    } else if (stat.isFile()) {
      add("file", relativePath, stat.mode, readFileSync(path));
    } else if (stat.isSymbolicLink()) {
      add("symlink", relativePath, stat.mode, Buffer.from(readlinkSync(path), "utf8"));
    } else {
      throw new Error(`Managed runtime source contains unsupported special entry ${path}`);
    }
  };
  for (const relativePath of allowlist) {
    const path = join(root, relativePath);
    if (!pathEntryExists(path)) {
      hash.update(`missing\0${relativePath.replaceAll("\\", "/")}\0`);
      continue;
    }
    visit(path);
  }
  return hash.digest("hex");
}

/** Fingerprint every source entry that can enter a managed-runtime stage. */
export function fingerprintManagedRuntimeSource(sourceRoot: string): string {
  return fingerprintManagedRuntimeEntries(sourceRoot, MANAGED_RUNTIME_COPY_ALLOWLIST);
}

/**
 * Fingerprint the compiled control plane loaded by the installer CLI.
 *
 * Development preparation builds before staging. Comparing this digest on
 * both sides of that build proves the already-running CLI did not become
 * stale while it was constructing the candidate.
 */
export function fingerprintManagedRuntimeControlPlane(sourceRoot: string): string {
  return fingerprintManagedRuntimeEntries(
    sourceRoot,
    MANAGED_RUNTIME_CONTROL_PLANE_ALLOWLIST,
  );
}

/**
 * Materialize the managed-runtime allowlist into an explicit destination.
 *
 * This deliberately performs no rename or swap: callers that need atomic
 * promotion stage into an isolated directory and own that promotion step.
 */
export function stageManagedRuntime(
  sourceRoot: string,
  destination: string,
  options: StageManagedRuntimeOptions = {},
): string {
  if (resolve(sourceRoot) === resolve(destination)) return destination;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const relative of MANAGED_RUNTIME_COPY_ALLOWLIST) {
    const source = join(sourceRoot, relative);
    if (!existsSync(source)) continue;
    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  }
  sanitizeManagedRuntimeSymlinks(destination);
  // Junk copied from a Finder-browsed source checkout must never enter a
  // staged artifact whose digest becomes durable evidence.
  sweepMacOsJunk(destination);
  const provenance = options.provenance ?? {
    kind: "development-bootstrap",
    installedAt: new Date().toISOString(),
  };
  writeFileSync(join(destination, ".tweakers-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");
  return destination;
}

export function sanitizeManagedRuntimeSymlinks(root: string): void {
  const lexicalRoot = resolve(root);
  const canonicalRoot = realpathSync(root);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(path);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const target = readlinkSync(path);
      const lexicalTarget = isAbsolute(target) ? null : resolve(dirname(path), target);
      let canonicalTarget: string | null = null;
      if (lexicalTarget !== null && pathWithinOrEqual(lexicalRoot, lexicalTarget)) {
        try {
          canonicalTarget = realpathSync(path);
        } catch {
          canonicalTarget = null;
        }
      }
      if (canonicalTarget === null || !pathWithinOrEqual(canonicalRoot, canonicalTarget)) {
        rmSync(path, { force: true });
      }
    }
  };
  visit(root);
}

function pathWithinOrEqual(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(relativePath));
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function installManagedRuntime(sourceRoot: string, userRoot: string): string {
  const destination = managedSourceRoot(userRoot);
  if (resolve(sourceRoot) === resolve(destination)) return destination;
  const parent = dirname(destination);
  const next = join(parent, `.next-${process.pid}`);
  const previous = join(parent, `.previous-${process.pid}`);
  mkdirSync(parent, { recursive: true });
  rmSync(next, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  stageManagedRuntime(sourceRoot, next);
  if (existsSync(destination)) renameSync(destination, previous);
  try {
    renameSync(next, destination);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, destination);
    throw error;
  }
  return destination;
}

export function ensureManagedRuntime(sourceRoot: string, userRoot: string): string {
  return existsSync(managedCliPath(userRoot))
    ? managedSourceRoot(userRoot)
    : installManagedRuntime(sourceRoot, userRoot);
}

/**
 * Restore the public CLI entrypoints against the durable managed runtime.
 *
 * This is intentionally separate from candidate staging: normal install and
 * manual repair may call it even when no app promotion is required, while
 * watcher and disposable-candidate flows must remain side-effect free.
 */
export function reconcileManagedCliShims(
  sourceRoot: string,
  userRoot: string,
  shimDir: string,
  options: CliShimOptions = {},
): CliShimResult {
  ensureManagedRuntime(sourceRoot, userRoot);
  return installCliShims(shimDir, managedCliPath(userRoot), options);
}

export function hasReleaseProvenance(sourceRoot: string, ref: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(sourceRoot, ".tweakers-provenance.json"), "utf8")) as {
      kind?: unknown;
      ref?: unknown;
    };
    return value.kind === "github-release" && value.ref === ref;
  } catch { return false; }
}

export function writeReleaseProvenance(sourceRoot: string, ref: string): void {
  writeFileSync(join(sourceRoot, ".tweakers-provenance.json"), JSON.stringify({
    kind: "github-release",
    ref,
    installedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

export function writeDevelopmentProvenanceHash(sourceRoot: string, sourceRuntimeHash: string): void {
  const path = join(sourceRoot, ".tweakers-provenance.json");
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch {}
  writeFileSync(path, JSON.stringify({ ...value, kind: "development-bootstrap", sourceRuntimeHash }, null, 2) + "\n", "utf8");
}

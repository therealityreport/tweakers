/** Validate and build a checkout, then publish a rollback-safe live snapshot. */
import kleur from "kleur";
import {
  chmodSync,
  cpSync,
  existsSync,
  watch as watchFs,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureUserPaths } from "../paths.js";
import { readConfigFile, readDevTweaksRoot, updateConfigFile } from "../config.js";
import { isSymlinkInto } from "../symlinks.js";
import { findSourceRoot } from "../source-root.js";
import { readValidManifest } from "./dev-tweak.js";
import { registerDevelopmentCheckout } from "./refresh-local.js";
import { stageBundledTweaks } from "./install.js";
import { LEGACY_DEV_SNAPSHOT_FILE } from "../legacy-compat.js";

export interface DevSyncResult {
  linked: string[];
  removedStale: string[];
  skippedInvalid: string[];
  changed: boolean;
}

interface DevSyncOpts {
  off?: boolean;
  quiet?: boolean;
  watch?: boolean;
}

export interface DevSyncCycleOptions {
  sourceRoot: string;
  liveTweaks: string;
  build?: (sourceRoot: string) => void | Promise<void>;
}

type SnapshotPathKind = "missing" | "file" | "directory" | "symlink";

export interface DevSnapshotFolderProof {
  folder: string;
  id: string;
  version: string;
  hash: string;
}

interface DevSnapshotPathProof {
  kind: SnapshotPathKind;
  hash: string;
}

interface DevSnapshotSurface {
  folder: string;
  before: DevSnapshotPathProof;
  after: DevSnapshotPathProof;
  preimagePath: string | null;
}

export interface DevSnapshotReceipt {
  schemaVersion: 2;
  transactionId: string;
  phase: "pending_acceptance" | "accepted" | "rolled_back";
  createdAt: string;
  updatedAt: string;
  sourcePayloadHash: string;
  /** Kept as names for older bundled-staging readers; folderProofs is authoritative. */
  folders: string[];
  folderProofs: DevSnapshotFolderProof[];
  surfaces: DevSnapshotSurface[];
  priorTreeRoot: string;
  archivedLegacySnapshots: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

export async function devSync(opts: DevSyncOpts = {}): Promise<void> {
  if (platform() !== "darwin") {
    throw new Error("tweaker dev-sync is only supported on macOS.");
  }
  const paths = ensureUserPaths();

  if (opts.off === true) {
    const previousRoot = readDevTweaksRoot(paths.configFile);
    updateConfigFile(paths.configFile, (config) => {
      const section = config.tweaker;
      if (section && typeof section === "object") {
        delete (section as Record<string, unknown>).devTweaksRoot;
      }
    });
    if (previousRoot) removeDevSymlinks(paths.tweaks, previousRoot);
    rmSync(join(paths.tweaks, ".tweaker-dev-snapshot.json"), { force: true });
    rmSync(join(paths.tweaks, LEGACY_DEV_SNAPSHOT_FILE), { force: true });
    stageBundledTweaks(paths.tweaks, paths.runtime);
    touchDevReloadMarker(paths.tweaks);
    if (!opts.quiet) {
      console.log(kleur.green().bold("✓ Dev mode off."));
      console.log("  Bundled tweak copies restored; repo symlinks removed.");
    }
    return;
  }

  const sourceRoot = resolveDevSyncSourceRoot(paths.configFile, findSourceRoot(here));
  const devTweaksRoot = join(sourceRoot, "tweaks");
  if (!existsSync(devTweaksRoot)) {
    throw new Error(`Source tweaks directory not found: ${devTweaksRoot}`);
  }

  clearLegacyDevMode(paths.configFile, paths.tweaks);

  await runDevSyncCycle({ sourceRoot, liveTweaks: paths.tweaks });
  registerDevelopmentCheckout(paths.configFile, sourceRoot);

  if (!opts.quiet) {
    console.log(kleur.green().bold("✓ Development snapshot published."));
    console.log(`  Source: ${kleur.cyan(devTweaksRoot)}`);
    console.log(kleur.dim("  The live runtime changed only after validation and a successful build."));
  }

  if (opts.watch) await watchDevelopmentSource(sourceRoot, paths.tweaks, opts.quiet === true);
}

export function resolveDevSyncSourceRoot(configFile: string, invokedSourceRoot: string): string {
  const config = readConfigFile(configFile);
  const section = config.tweaker && typeof config.tweaker === "object"
    ? config.tweaker as Record<string, unknown>
    : {};
  const registered = typeof section.developmentSourceRoot === "string"
    ? resolve(section.developmentSourceRoot)
    : null;
  if (
    registered &&
    existsSync(join(registered, "package.json")) &&
    existsSync(join(registered, "tweaks")) &&
    existsSync(join(registered, "packages", "installer"))
  ) {
    return registered;
  }
  return resolve(invokedSourceRoot);
}

export async function runDevSyncCycle(options: DevSyncCycleOptions): Promise<void> {
  const sourceTweaks = join(options.sourceRoot, "tweaks");
  for (const folder of listDirectories(sourceTweaks)) {
    const manifest = join(sourceTweaks, folder, "manifest.json");
    if (!existsSync(manifest)) continue;
    readValidManifest(manifest);
  }
  if (options.build) await options.build(options.sourceRoot);
  else runDevelopmentBuild(options.sourceRoot);
  prepareDevSnapshot(
    join(options.sourceRoot, "packages", "installer", "assets", "runtime", "tweaks"),
    options.liveTweaks,
  );
  touchDevReloadMarker(options.liveTweaks);
}

export function clearLegacyDevMode(configFile: string, liveTweaks: string): void {
  const previousRoot = readDevTweaksRoot(configFile);
  updateConfigFile(configFile, (config) => {
    const section = config.tweaker;
    if (section && typeof section === "object") delete (section as Record<string, unknown>).devTweaksRoot;
  });
  if (previousRoot) removeDevSymlinks(liveTweaks, previousRoot);
}

function runDevelopmentBuild(sourceRoot: string): void {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const script of ["sync:tweaks", "build"]) {
    const result = spawnSync(npm, ["run", script], { cwd: sourceRoot, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Development ${script} failed with status ${result.status ?? "unknown"}`);
  }
}

/**
 * Publish an already-built complete tweak tree as a rollback-safe pending
 * snapshot. This seam intentionally performs no build or source checkout work.
 */
export function prepareDevSnapshot(builtTweaks: string, liveTweaks: string): DevSnapshotReceipt {
  if (!existsSync(builtTweaks)) throw new Error(`Built tweaks directory not found: ${builtTweaks}`);
  mkdirSync(liveTweaks, { recursive: true });
  const manifestPath = join(liveTweaks, ".tweaker-dev-snapshot.json");
  const legacyManifestPath = join(liveTweaks, LEGACY_DEV_SNAPSHOT_FILE);
  const publishLock = join(liveTweaks, ".tweaker-dev-publishing");
  const existing = readDevSnapshotReceipt(manifestPath);
  const pending = existing?.phase === "pending_acceptance" ? existing : null;
  if (pending) assertDevSnapshotCas(pending, liveTweaks);
  const legacySources = [manifestPath, legacyManifestPath].filter((path) => {
    if (!existsSync(path)) return false;
    return path !== manifestPath || existing === null;
  });
  const priorFolders = existing?.folders ?? readLegacySnapshotFolders(...legacySources);
  const transactionId = pending?.transactionId ?? randomUUID();
  const transactionRoot = join(liveTweaks, ".tweaker-dev-history", transactionId);
  const nextRoot = join(transactionRoot, "next");
  const previousRoot = pending?.priorTreeRoot ?? join(transactionRoot, "previous");
  const replacedRoot = join(transactionRoot, "replaced");
  const archiveRoot = join(transactionRoot, "legacy-snapshots");
  const folderProofs = inspectBuiltTweakTree(builtTweaks);
  const nextFolders = folderProofs.map((proof) => proof.folder);
  const affected = [...new Set([...(pending?.surfaces.map((surface) => surface.folder) ?? priorFolders), ...nextFolders])].sort();
  const priorManaged = new Set(priorFolders);
  for (const folder of nextFolders) {
    if (!priorManaged.has(folder) && pathPresent(join(liveTweaks, folder))) {
      throw new Error(`Refusing to replace untracked custom tweak folder: ${folder}`);
    }
  }
  rmSync(nextRoot, { recursive: true, force: true });
  rmSync(replacedRoot, { recursive: true, force: true });
  mkdirSync(nextRoot, { recursive: true });
  mkdirSync(previousRoot, { recursive: true });
  if (pending) mkdirSync(replacedRoot, { recursive: true });
  for (const folder of nextFolders) {
    cpSync(join(builtTweaks, folder), join(nextRoot, folder), { recursive: true, verbatimSymlinks: true });
    const expected = folderProofs.find((proof) => proof.folder === folder)!;
    if (fingerprintSnapshotPath(join(nextRoot, folder)).hash !== expected.hash) {
      throw new Error(`Staged development tweak hash mismatch: ${folder}`);
    }
  }
  const archivedLegacySnapshots = pending?.archivedLegacySnapshots ?? archiveLegacySnapshots(legacySources, archiveRoot);
  const pendingSurfaces = new Map(pending?.surfaces.map((surface) => [surface.folder, surface]) ?? []);
  const surfaces: DevSnapshotSurface[] = affected.map((folder) => ({
    folder,
    before: pendingSurfaces.get(folder)?.before ?? fingerprintSnapshotPath(join(liveTweaks, folder)),
    after: fingerprintSnapshotPath(join(nextRoot, folder)),
    preimagePath: pendingSurfaces.get(folder)?.preimagePath ??
      (pathPresent(join(liveTweaks, folder)) ? join(previousRoot, folder) : null),
  }));
  const moved: string[] = [];
  const promoted: string[] = [];
  writeFileSync(publishLock, String(Date.now()), "utf8");
  try {
    for (const folder of affected) {
      const destination = join(liveTweaks, folder);
      if (existsSync(destination) || symlinkTargetIsPresent(destination)) {
        renameSync(destination, join(pending ? replacedRoot : previousRoot, folder));
        moved.push(folder);
      }
    }
    for (const folder of nextFolders) {
      renameSync(join(nextRoot, folder), join(liveTweaks, folder));
      promoted.push(folder);
    }
    for (const surface of surfaces) {
      if (!sameSnapshotProof(fingerprintSnapshotPath(join(liveTweaks, surface.folder)), surface.after)) {
        throw new Error(`Published development tweak failed verification: ${surface.folder}`);
      }
      if (surface.preimagePath && !sameSnapshotProof(fingerprintSnapshotPath(surface.preimagePath), surface.before)) {
        throw new Error(`Development tweak preimage failed verification: ${surface.folder}`);
      }
    }
    const now = new Date().toISOString();
    const receipt: DevSnapshotReceipt = {
      schemaVersion: 2,
      transactionId,
      phase: "pending_acceptance",
      createdAt: pending?.createdAt ?? now,
      updatedAt: now,
      sourcePayloadHash: fingerprintSnapshotPath(builtTweaks).hash,
      folders: nextFolders,
      folderProofs,
      surfaces,
      priorTreeRoot: previousRoot,
      archivedLegacySnapshots,
    };
    writeJsonAtomic(manifestPath, receipt);
    rmSync(legacyManifestPath, { force: true });
    return receipt;
  } catch (error) {
    for (const folder of promoted) rmSync(join(liveTweaks, folder), { recursive: true, force: true });
    for (const folder of moved) renameSync(join(pending ? replacedRoot : previousRoot, folder), join(liveTweaks, folder));
    throw error;
  } finally {
    rmSync(nextRoot, { recursive: true, force: true });
    rmSync(replacedRoot, { recursive: true, force: true });
    rmSync(publishLock, { force: true });
  }
}

export function acceptDevSnapshot(liveTweaks: string): DevSnapshotReceipt {
  const manifestPath = join(liveTweaks, ".tweaker-dev-snapshot.json");
  const receipt = requirePendingDevSnapshot(manifestPath);
  assertDevSnapshotCas(receipt, liveTweaks);
  const accepted = { ...receipt, phase: "accepted" as const, updatedAt: new Date().toISOString() };
  writeJsonAtomic(manifestPath, accepted);
  rmSync(receipt.priorTreeRoot, { recursive: true, force: true });
  return accepted;
}

export function rollbackDevSnapshot(liveTweaks: string): DevSnapshotReceipt {
  const manifestPath = join(liveTweaks, ".tweaker-dev-snapshot.json");
  const receipt = requirePendingDevSnapshot(manifestPath);
  assertDevSnapshotCas(receipt, liveTweaks);
  const rollbackRoot = join(dirname(receipt.priorTreeRoot), `rollback-${process.pid}`);
  mkdirSync(rollbackRoot, { recursive: true });
  const retired: string[] = [];
  const restored: string[] = [];
  try {
    for (const surface of receipt.surfaces) {
      const live = join(liveTweaks, surface.folder);
      if (pathPresent(live)) {
        renameSync(live, join(rollbackRoot, surface.folder));
        retired.push(surface.folder);
      }
      if (surface.preimagePath) {
        renameSync(surface.preimagePath, live);
        restored.push(surface.folder);
      }
    }
  } catch (error) {
    for (const folder of restored.reverse()) renameSync(join(liveTweaks, folder), join(receipt.priorTreeRoot, folder));
    for (const folder of retired.reverse()) renameSync(join(rollbackRoot, folder), join(liveTweaks, folder));
    throw error;
  }
  const rolledBack = { ...receipt, phase: "rolled_back" as const, updatedAt: new Date().toISOString() };
  writeJsonAtomic(manifestPath, rolledBack);
  rmSync(rollbackRoot, { recursive: true, force: true });
  rmSync(receipt.priorTreeRoot, { recursive: true, force: true });
  return rolledBack;
}

export function readDevSnapshotReceipt(path: string): DevSnapshotReceipt | null {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DevSnapshotReceipt>;
    if (
      parsed.schemaVersion !== 2 ||
      typeof parsed.transactionId !== "string" ||
      !["pending_acceptance", "accepted", "rolled_back"].includes(String(parsed.phase)) ||
      typeof parsed.sourcePayloadHash !== "string" ||
      !Array.isArray(parsed.folders) ||
      !Array.isArray(parsed.folderProofs) ||
      !Array.isArray(parsed.surfaces) ||
      typeof parsed.priorTreeRoot !== "string" ||
      !Array.isArray(parsed.archivedLegacySnapshots)
    ) return null;
    const receipt = parsed as DevSnapshotReceipt;
    if (!/^[0-9a-f-]{36}$/.test(receipt.transactionId)) return null;
    if (!receipt.folders.every(isSafeFolder) || new Set(receipt.folders).size !== receipt.folders.length || receipt.folderProofs.length !== receipt.folders.length) return null;
    if (!receipt.folderProofs.every((proof) => (
      isSafeFolder(proof.folder) &&
      typeof proof.id === "string" && proof.id.length > 0 &&
      typeof proof.version === "string" && proof.version.length > 0 &&
      isHash(proof.hash)
    ))) return null;
    if (receipt.folderProofs.some((proof, index) => proof.folder !== receipt.folders[index])) return null;
    if (!isHash(receipt.sourcePayloadHash)) return null;
    const expectedTransactionRoot = join(dirname(path), ".tweaker-dev-history", receipt.transactionId);
    if (receipt.priorTreeRoot !== join(expectedTransactionRoot, "previous")) return null;
    if (new Set(receipt.surfaces.map((surface) => surface.folder)).size !== receipt.surfaces.length) return null;
    if (!receipt.surfaces.every((surface) => (
      isSafeFolder(surface.folder) &&
      validSnapshotProof(surface.before) &&
      validSnapshotProof(surface.after) &&
      (surface.before.kind === "missing"
        ? surface.preimagePath === null
        : surface.preimagePath === join(receipt.priorTreeRoot, surface.folder))
    ))) return null;
    if (!receipt.archivedLegacySnapshots.every((archive) => (
      typeof archive === "string" && dirname(archive) === join(expectedTransactionRoot, "legacy-snapshots")
    ))) return null;
    return receipt;
  } catch { return null; }
}

function requirePendingDevSnapshot(path: string): DevSnapshotReceipt {
  const receipt = readDevSnapshotReceipt(path);
  if (!receipt) throw new Error("Development snapshot provenance is missing or unverifiable.");
  if (receipt.phase !== "pending_acceptance") throw new Error(`Development snapshot is not pending acceptance: ${receipt.phase}`);
  return receipt;
}

function assertDevSnapshotCas(receipt: DevSnapshotReceipt, liveTweaks: string): void {
  for (const surface of receipt.surfaces) {
    if (!sameSnapshotProof(fingerprintSnapshotPath(join(liveTweaks, surface.folder)), surface.after)) {
      throw new Error(`Development snapshot changed before accept/rollback: ${surface.folder}`);
    }
    if (surface.preimagePath && !sameSnapshotProof(fingerprintSnapshotPath(surface.preimagePath), surface.before)) {
      throw new Error(`Development snapshot preimage changed before accept/rollback: ${surface.folder}`);
    }
  }
}

function inspectBuiltTweakTree(root: string): DevSnapshotFolderProof[] {
  return listDirectories(root).map((folder) => {
    if (!isSafeFolder(folder)) throw new Error(`Unsafe built tweak folder: ${folder}`);
    const manifest = readValidManifest(join(root, folder, "manifest.json"));
    return {
      folder,
      id: manifest.id,
      version: manifest.version,
      hash: fingerprintSnapshotPath(join(root, folder)).hash,
    };
  });
}

function readLegacySnapshotFolders(...paths: string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { folders?: unknown };
      if (!Array.isArray(parsed.folders)) throw new Error("folders missing");
      for (const value of parsed.folders) {
        const folder = typeof value === "string" ? value : null;
        if (!folder || !isSafeFolder(folder)) throw new Error(`unsafe folder in legacy snapshot: ${String(value)}`);
        folders.add(folder);
      }
    } catch (error) {
      throw new Error(`Unverifiable legacy development snapshot ${path}: ${errorMessage(error)}`);
    }
  }
  return [...folders].sort();
}

function archiveLegacySnapshots(paths: string[], archiveRoot: string): string[] {
  const archived: string[] = [];
  for (const [index, path] of paths.entries()) {
    mkdirSync(archiveRoot, { recursive: true });
    const destination = join(archiveRoot, `${index}-${path.endsWith(LEGACY_DEV_SNAPSHOT_FILE) ? "legacy" : "snapshot"}.json`);
    cpSync(path, destination);
    if (fingerprintSnapshotPath(destination).hash !== fingerprintSnapshotPath(path).hash) {
      throw new Error(`Legacy snapshot archive verification failed: ${path}`);
    }
    archived.push(destination);
  }
  return archived;
}

function fingerprintSnapshotPath(path: string): DevSnapshotPathProof {
  if (!pathPresent(path)) return { kind: "missing", hash: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", hash: createHash("sha256").update("symlink\0").update(readlinkSync(path)).digest("hex") };
  }
  const hash = createHash("sha256");
  const visit = (entryPath: string, relativeName: string): void => {
    const entryStat = lstatSync(entryPath);
    const mode = entryStat.mode & 0o777;
    hash.update(relativeName).update("\0").update(String(mode)).update("\0");
    if (entryStat.isDirectory()) {
      hash.update("directory\0");
      for (const name of readdirSync(entryPath).sort()) visit(join(entryPath, name), relativeName ? `${relativeName}/${name}` : name);
    } else if (entryStat.isFile()) {
      hash.update("file\0").update(readFileSync(entryPath));
    } else if (entryStat.isSymbolicLink()) {
      hash.update("symlink\0").update(readlinkSync(entryPath));
    } else {
      throw new Error(`Unsupported development snapshot entry: ${entryPath}`);
    }
  };
  visit(path, "");
  return { kind: stat.isDirectory() ? "directory" : "file", hash: hash.digest("hex") };
}

function validSnapshotProof(value: unknown): value is DevSnapshotPathProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<DevSnapshotPathProof>;
  return ["missing", "file", "directory", "symlink"].includes(String(proof.kind)) &&
    (proof.kind === "missing" ? proof.hash === "missing" : isHash(proof.hash));
}

function sameSnapshotProof(a: DevSnapshotPathProof, b: DevSnapshotPathProof): boolean {
  return a.kind === b.kind && a.hash === b.hash;
}

function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafeFolder(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function symlinkTargetIsPresent(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

async function watchDevelopmentSource(sourceRoot: string, liveTweaks: string, quiet: boolean): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let rerun = false;
  const run = async (): Promise<void> => {
    if (running) { rerun = true; return; }
    running = true;
    try {
      await runDevSyncCycle({ sourceRoot, liveTweaks });
      if (!quiet) console.log(kleur.green("✓ Development changes published."));
    } catch (error) {
      console.error(kleur.yellow(`Development changes rejected; live runtime preserved: ${errorMessage(error)}`));
    } finally {
      running = false;
      if (rerun) { rerun = false; void run(); }
    }
  };
  const watcher = watchFs(sourceRoot, { recursive: true }, (_event, filename) => {
    const path = filename?.toString() ?? "";
    if (shouldIgnoreDevWatchPath(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), 250);
  });
  if (!quiet) console.log(kleur.cyan("Watching the development checkout. Press Ctrl+C to stop."));
  await new Promise<void>((resolve) => {
    const stop = (): void => { watcher.close(); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function shouldIgnoreDevWatchPath(path: string): boolean {
  return /(^|\/)(?:\.git|node_modules|dist|packages\/installer\/assets\/runtime)(\/|$)/.test(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Idempotent reconciliation of the user tweaks dir against the source
 * checkout's tweaks dir. Cheap (readdir + lstat) — safe to run on every
 * watcher repair pass, including while Codex is running (tweak files
 * hot-reload; only the runtime bundle requires the app to be closed).
 */
export function reconcileDevTweaks(
  tweaksDir: string,
  devTweaksRoot: string,
  log?: (message: string) => void,
): DevSyncResult {
  const result: DevSyncResult = { linked: [], removedStale: [], skippedInvalid: [], changed: false };
  mkdirSync(tweaksDir, { recursive: true });

  const sourceFolders = listDirectories(devTweaksRoot);
  const validSources = new Map<string, { sourceDir: string; id: string }>();
  for (const folder of sourceFolders) {
    const sourceDir = join(devTweaksRoot, folder);
    try {
      const manifest = readValidManifest(join(sourceDir, "manifest.json"));
      validSources.set(folder, { sourceDir, id: manifest.id });
    } catch {
      result.skippedInvalid.push(folder);
      log?.(`skipping ${folder}: invalid manifest or entry`);
    }
  }

  for (const [folder, { sourceDir, id }] of validSources) {
    const linkPath = join(tweaksDir, folder);
    if (ensureLink(linkPath, sourceDir, log)) {
      result.linked.push(folder);
      result.changed = true;
    }
    // A prior `tweaker dev` may have linked the same source under its
    // manifest id; discovery is a directory scan, so both would load.
    if (id !== folder) {
      const dupePath = join(tweaksDir, id);
      if (symlinkTargetIs(dupePath, sourceDir)) {
        rmSync(dupePath, { recursive: false, force: true });
        result.changed = true;
        log?.(`removed duplicate id-named link ${id}`);
      }
    }
  }

  // Sweep dev symlinks whose repo folder vanished (tweak deleted or renamed).
  for (const entry of listEntries(tweaksDir)) {
    const linkPath = join(tweaksDir, entry);
    if (!isSymlinkInto(linkPath, devTweaksRoot)) continue;
    const target = resolve(dirname(linkPath), readlinkSync(linkPath));
    if (!existsSync(target)) {
      rmSync(linkPath, { recursive: false, force: true });
      result.removedStale.push(entry);
      result.changed = true;
      log?.(`removed stale link ${entry} (source gone)`);
    }
  }

  if (result.changed) touchDevReloadMarker(tweaksDir);
  return result;
}

export function touchDevReloadMarker(tweaksDir: string): void {
  // Written at the tweaks-dir ROOT, never through a symlink — writing through
  // a dev link would drop an untracked file into the repo working tree and
  // block the watcher's clean-tree self-update.
  try {
    mkdirSync(tweaksDir, { recursive: true });
    writeFileSync(join(tweaksDir, ".tweaker-dev-reload"), String(Date.now()), "utf8");
  } catch {
    // Best effort: link churn itself also wakes the runtime watcher.
  }
}

function ensureLink(linkPath: string, sourceDir: string, log?: (message: string) => void): boolean {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    symlinkSync(sourceDir, linkPath, "dir");
    return true;
  }

  if (stat.isSymbolicLink()) {
    if (symlinkTargetIs(linkPath, sourceDir)) return false;
    rmSync(linkPath, { recursive: false, force: true });
    symlinkSync(sourceDir, linkPath, "dir");
    return true;
  }

  // Real directory (staged bundled copy or manual edits). The repo is the
  // canonical source in dev mode; local edits in the live dir are discarded.
  log?.(`replacing staged copy ${linkPath} with repo symlink (repo is canonical; live-dir edits discarded)`);
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(sourceDir, linkPath, "dir");
  return true;
}

function removeDevSymlinks(tweaksDir: string, devTweaksRoot: string): void {
  for (const entry of listEntries(tweaksDir)) {
    const linkPath = join(tweaksDir, entry);
    if (isSymlinkInto(linkPath, devTweaksRoot)) {
      rmSync(linkPath, { recursive: false, force: true });
    }
  }
}

function symlinkTargetIs(linkPath: string, sourceDir: string): boolean {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    return resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(sourceDir);
  } catch {
    return false;
  }
}

function listDirectories(root: string): string[] {
  return listEntries(root).filter((entry) => {
    try {
      return lstatSync(join(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listEntries(root: string): string[] {
  try {
    return readdirSync(root).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

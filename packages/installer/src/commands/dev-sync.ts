/** Validate and build a checkout, then publish a rollback-safe live snapshot. */
import kleur from "kleur";
import {
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

const here = dirname(fileURLToPath(import.meta.url));

export async function devSync(opts: DevSyncOpts = {}): Promise<void> {
  if (platform() !== "darwin") {
    throw new Error("tweakers dev-sync is only supported on macOS.");
  }
  const paths = ensureUserPaths();

  if (opts.off === true) {
    const previousRoot = readDevTweaksRoot(paths.configFile);
    updateConfigFile(paths.configFile, (config) => {
      const section = config.codexPlusPlus;
      if (section && typeof section === "object") {
        delete (section as Record<string, unknown>).devTweaksRoot;
      }
    });
    if (previousRoot) removeDevSymlinks(paths.tweaks, previousRoot);
    rmSync(join(paths.tweaks, ".codexpp-dev-snapshot.json"), { force: true });
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
  const section = config.codexPlusPlus && typeof config.codexPlusPlus === "object"
    ? config.codexPlusPlus as Record<string, unknown>
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
  publishBuiltTweaks(
    join(options.sourceRoot, "packages", "installer", "assets", "runtime", "tweaks"),
    options.liveTweaks,
  );
  touchDevReloadMarker(options.liveTweaks);
}

export function clearLegacyDevMode(configFile: string, liveTweaks: string): void {
  const previousRoot = readDevTweaksRoot(configFile);
  updateConfigFile(configFile, (config) => {
    const section = config.codexPlusPlus;
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

function publishBuiltTweaks(builtTweaks: string, liveTweaks: string): void {
  if (!existsSync(builtTweaks)) throw new Error(`Built tweaks directory not found: ${builtTweaks}`);
  mkdirSync(liveTweaks, { recursive: true });
  const nextRoot = join(liveTweaks, `.dev-sync-next-${process.pid}`);
  const previousRoot = join(liveTweaks, `.dev-sync-previous-${process.pid}`);
  const manifestPath = join(liveTweaks, ".codexpp-dev-snapshot.json");
  const publishLock = join(liveTweaks, ".codexpp-dev-publishing");
  const nextFolders = listDirectories(builtTweaks);
  const priorFolders = readSnapshotFolders(manifestPath);
  const affected = [...new Set([...priorFolders, ...nextFolders])].sort();
  rmSync(nextRoot, { recursive: true, force: true });
  rmSync(previousRoot, { recursive: true, force: true });
  mkdirSync(nextRoot, { recursive: true });
  mkdirSync(previousRoot, { recursive: true });
  for (const folder of nextFolders) {
    cpSync(join(builtTweaks, folder), join(nextRoot, folder), { recursive: true, verbatimSymlinks: true });
  }
  const moved: string[] = [];
  const promoted: string[] = [];
  writeFileSync(publishLock, String(Date.now()), "utf8");
  try {
    for (const folder of affected) {
      const destination = join(liveTweaks, folder);
      if (existsSync(destination) || symlinkTargetIsPresent(destination)) {
        renameSync(destination, join(previousRoot, folder));
        moved.push(folder);
      }
    }
    for (const folder of nextFolders) {
      renameSync(join(nextRoot, folder), join(liveTweaks, folder));
      promoted.push(folder);
    }
    writeFileSync(manifestPath, JSON.stringify({ folders: nextFolders }, null, 2) + "\n", "utf8");
  } catch (error) {
    for (const folder of promoted) rmSync(join(liveTweaks, folder), { recursive: true, force: true });
    for (const folder of moved) renameSync(join(previousRoot, folder), join(liveTweaks, folder));
    throw error;
  } finally {
    rmSync(nextRoot, { recursive: true, force: true });
    rmSync(previousRoot, { recursive: true, force: true });
    rmSync(publishLock, { force: true });
  }
}

function readSnapshotFolders(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { folders?: unknown };
    return Array.isArray(parsed.folders) ? parsed.folders.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
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
    // A prior `tweakers dev` may have linked the same source under its
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
    writeFileSync(join(tweaksDir, ".codexpp-dev-reload"), String(Date.now()), "utf8");
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

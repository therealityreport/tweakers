import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform as currentPlatform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import plist from "plist";
import { readPlist } from "./plist.js";
import { chownForTargetUser, targetUserHome, targetUserOwnership } from "./ownership.js";

const LAUNCH_SERVICES_TOOL = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const DOCK_DOMAIN = "com.apple.dock";

type DockTile = Record<string, unknown>;
export type DockPreferences = Record<string, unknown> & {
  "persistent-apps"?: DockTile[];
  "recent-apps"?: DockTile[];
};

export interface DockDedupeResult {
  preferences: DockPreferences;
  changed: boolean;
  removedPersistent: number;
  removedRecent: number;
}

export function dedupeDockPreferences(
  preferences: DockPreferences,
  target: { appRoot: string; bundleId: string },
): DockDedupeResult {
  const persistent = Array.isArray(preferences["persistent-apps"]) ? preferences["persistent-apps"] : [];
  const recent = Array.isArray(preferences["recent-apps"]) ? preferences["recent-apps"] : [];
  const matchingPinned = persistent.filter((tile) => isTargetDockTile(tile, target));
  const canonicalPinned = matchingPinned.find((tile) => dockTileTargetsAppRoot(tile, target.appRoot))
    ?? (matchingPinned[0] ? canonicalizeDockTile(matchingPinned[0], target) : null);
  let keptPinned = false;
  let removedPersistent = 0;
  const nextPersistent = persistent.flatMap((tile) => {
    if (!isTargetDockTile(tile, target)) return [tile];
    if (!keptPinned) {
      keptPinned = true;
      return canonicalPinned ? [canonicalPinned] : [];
    }
    removedPersistent += 1;
    return [];
  });

  let removedRecent = 0;
  const nextRecent = recent.filter((tile) => {
    if (!isTargetDockTile(tile, target)) return true;
    removedRecent += 1;
    return false;
  });
  const canonicalized = canonicalPinned !== null && canonicalPinned !== matchingPinned[0];
  const changed = canonicalized || removedPersistent > 0 || removedRecent > 0;
  if (!changed) return { preferences, changed, removedPersistent, removedRecent };
  return {
    preferences: {
      ...preferences,
      "persistent-apps": nextPersistent,
      "recent-apps": nextRecent,
    },
    changed,
    removedPersistent,
    removedRecent,
  };
}

function canonicalizeDockTile(tile: DockTile, target: { appRoot: string; bundleId: string }): DockTile {
  const data = tile["tile-data"] as Record<string, unknown>;
  const fileData = data["file-data"] && typeof data["file-data"] === "object" && !Array.isArray(data["file-data"])
    ? data["file-data"] as Record<string, unknown>
    : {};
  const nextData: Record<string, unknown> = {
    ...data,
    "bundle-identifier": target.bundleId,
    "file-data": {
      ...fileData,
      "_CFURLString": pathToFileURL(`${resolve(target.appRoot)}/`).href,
      "_CFURLStringType": 15,
    },
  };
  delete nextData.book;
  return { ...tile, "tile-data": nextData };
}

function dockTileTargetsAppRoot(tile: DockTile, appRoot: string): boolean {
  const data = tile["tile-data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const fileData = (data as Record<string, unknown>)["file-data"];
  if (!fileData || typeof fileData !== "object" || Array.isArray(fileData)) return false;
  const storedUrl = (fileData as Record<string, unknown>)["_CFURLString"];
  if (typeof storedUrl !== "string") return false;
  try {
    return resolve(decodeURIComponent(new URL(storedUrl).pathname)) === resolve(appRoot);
  } catch {
    return false;
  }
}

function isTargetDockTile(tile: DockTile, target: { appRoot: string; bundleId: string }): boolean {
  const data = tile["tile-data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const tileData = data as Record<string, unknown>;
  if (tileData["bundle-identifier"] === target.bundleId) return true;
  return dockTileTargetsAppRoot(tile, target.appRoot);
}

export interface LaunchServicesResult {
  unregistered: string[];
  skipped: string[];
  failed: Array<{ path: string; error: string }>;
  registeredCanonical: boolean;
  garbageCollected: boolean;
}

interface LaunchServicesAdapters {
  platform?: string;
  exists?: (path: string) => boolean;
  bundleIdentifier?: (appRoot: string) => string | null;
  run?: (command: string, args: string[]) => void;
}

export interface TargetGuiCommandInput {
  currentUid: number;
  targetUid: number;
  home: string;
}

export function targetGuiCommand(
  command: string,
  args: string[],
  input: TargetGuiCommandInput,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...process.env, HOME: input.home };
  if (input.currentUid !== 0 || input.targetUid === 0 || input.currentUid === input.targetUid) {
    return { command, args, env };
  }
  return {
    command: "launchctl",
    args: [
      "asuser",
      String(input.targetUid),
      "/usr/bin/sudo",
      "-u",
      `#${input.targetUid}`,
      "/usr/bin/env",
      `HOME=${input.home}`,
      command,
      ...args,
    ],
    env,
  };
}

function runTargetGuiCommand(command: string, args: string[], encoding: BufferEncoding | undefined = "utf8"): string {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const owner = targetUserOwnership();
  if (currentUid === 0 && (!owner || owner.uid === 0)) {
    throw new Error("Could not resolve the logged-in GUI user for macOS app identity cleanup");
  }
  const invocation = targetGuiCommand(command, args, {
    currentUid,
    targetUid: owner?.uid ?? currentUid,
    home: targetUserHome(),
  });
  return execFileSync(invocation.command, invocation.args, {
    encoding,
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function reconcileLaunchServices(
  options: { appRoot: string; bundleId: string; nonLiveAppRoots: string[]; garbageCollect?: boolean },
  adapters: LaunchServicesAdapters = {},
): LaunchServicesResult {
  const result: LaunchServicesResult = {
    unregistered: [],
    skipped: [],
    failed: [],
    registeredCanonical: false,
    garbageCollected: false,
  };
  if ((adapters.platform ?? currentPlatform()) !== "darwin") return result;
  const exists = adapters.exists ?? existsSync;
  const bundleIdentifier = adapters.bundleIdentifier ?? readBundleIdentifier;
  const run = adapters.run ?? ((command, args) => {
    runTargetGuiCommand(command, args);
  });
  const canonical = resolve(options.appRoot);
  const seen = new Set<string>();

  for (const appRoot of options.nonLiveAppRoots) {
    const normalized = resolve(appRoot);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (normalized === canonical || !exists(normalized) || bundleIdentifier(normalized) !== options.bundleId) {
      result.skipped.push(normalized);
      continue;
    }
    try {
      run(LAUNCH_SERVICES_TOOL, ["-u", normalized]);
      result.unregistered.push(normalized);
    } catch (error) {
      if (launchServicesRegistrationAbsent(error)) result.skipped.push(normalized);
      else result.failed.push({ path: normalized, error: commandErrorMessage(error) });
    }
  }

  if (exists(canonical) && bundleIdentifier(canonical) === options.bundleId) {
    try {
      run(LAUNCH_SERVICES_TOOL, ["-f", canonical]);
      result.registeredCanonical = true;
    } catch (error) {
      result.failed.push({ path: canonical, error: commandErrorMessage(error) });
    }
  }
  if (options.garbageCollect) {
    try {
      run(LAUNCH_SERVICES_TOOL, ["-gc"]);
      result.garbageCollected = true;
    } catch (error) {
      result.failed.push({ path: "LaunchServices database", error: commandErrorMessage(error) });
    }
  }
  return result;
}

function readBundleIdentifier(appRoot: string): string | null {
  const infoPlist = join(appRoot, "Contents", "Info.plist");
  if (currentPlatform() === "darwin") {
    try {
      const value = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist], {
        encoding: "utf8",
      }).trim();
      if (value) return value;
    } catch {
      // XML fallback below also supports non-macOS unit fixtures.
    }
  }
  try {
    const value = readPlist(infoPlist)["CFBundleIdentifier"];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export interface DockReconcileResult extends DockDedupeResult {
  backupPath: string | null;
}

interface DockReconcileAdapters {
  platform?: string;
  home?: string;
  run?: (command: string, args: string[], options: { encoding?: BufferEncoding; env: NodeJS.ProcessEnv }) => string;
}

export function reconcileDock(
  options: { appRoot: string; bundleId: string; backupDir: string; now?: Date },
  adapters: DockReconcileAdapters = {},
): DockReconcileResult {
  const unchanged: DockReconcileResult = {
    preferences: {},
    changed: false,
    removedPersistent: 0,
    removedRecent: 0,
    backupPath: null,
  };
  if ((adapters.platform ?? currentPlatform()) !== "darwin") return unchanged;

  const home = adapters.home ?? targetUserHome();
  const environment = { ...process.env, HOME: home };
  const run = adapters.run ?? ((command, args, runOptions) => runTargetGuiCommand(
    command,
    args,
    runOptions.encoding ?? "utf8",
  ));
  const exported = run("defaults", ["export", DOCK_DOMAIN, "-"], { encoding: "utf8", env: environment });
  const preferences = plist.parse(exported) as unknown as DockPreferences;
  const deduped = dedupeDockPreferences(preferences, options);
  if (!deduped.changed) return { ...deduped, backupPath: null };

  mkdirSync(options.backupDir, { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = join(options.backupDir, `com.apple.dock.before-codex-dedupe.${stamp}.plist`);
  writeFileSync(backupPath, exported, { mode: 0o600 });
  chownForTargetUser(backupPath);

  const work = mkdtempSync(join(tmpdir(), "tweakers-dock-"));
  const importFile = join(work, "com.apple.dock.plist");
  try {
    writeFileSync(importFile, plist.build(deduped.preferences as plist.PlistValue), { mode: 0o600 });
    chownForTargetUser(work, { recursive: true });
    run("defaults", ["import", DOCK_DOMAIN, importFile], { env: environment });
    run("killall", ["Dock"], { env: environment });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { ...deduped, backupPath: existsSync(backupPath) ? backupPath : null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return errorMessage(error);
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
  return detail.trim() || errorMessage(error);
}

function launchServicesRegistrationAbsent(error: unknown): boolean {
  return /(?:^|\s)-10814(?:\s|$)/.test(commandErrorMessage(error));
}

/**
 * Tracks installer state across runs so `repair` and `uninstall` know what
 * we did, and so `doctor` can detect drift.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chownForTargetUser } from "./ownership.js";

/**
 * Which variation owns /Applications/ChatGPT.app right now.
 * "chatgpt"  — pristine OpenAI Developer-ID payload; all patch machinery stands down.
 * "tweakers" — patched, contained-signed payload; normal repair/watcher behavior.
 */
export type AppMode = "chatgpt" | "tweakers";

export interface InstallerState {
  version: string;
  installedAt: string;
  /** Absolute path to the patched Codex install. */
  appRoot: string;
  /** Hash of the original asar header (pre-patch). */
  originalAsarHash: string;
  /** Hash of the patched asar header (what's currently on disk if intact). */
  patchedAsarHash: string;
  /** Codex version string we patched against (CFBundleShortVersionString). */
  codexVersion: string | null;
  /** Release channel inferred from app metadata. */
  codexChannel?: "stable" | "beta" | "unknown";
  /** macOS bundle id, when available. */
  codexBundleId?: string | null;
  /** Whether we flipped the Electron fuse. */
  fuseFlipped: boolean;
  /** Whether we re-signed the patched app. */
  resigned: boolean;
  /** Signing mode used for the patched app. Older installs may not have this. */
  signingMode?: "local-identity" | "adhoc";
  /** Common name or ad-hoc marker used for the last signing pass. */
  signingIdentity?: string;
  /** SHA-1 hash of the local code signing identity, when applicable. */
  signingIdentityHash?: string;
  /** Original entry point ("main" field) of the asar's package.json. */
  originalEntryPoint: string;
  /** Watcher install method, if any. */
  watcher: "launchd" | "login-item" | "scheduled-task" | "systemd" | "none";
  /** Source tree that owns the installed CLI/runtime. */
  sourceRoot?: string;
  /** Last time the user-dir runtime assets were refreshed by repair. */
  runtimeUpdatedAt?: string;
  /**
   * Size + mtime of the patched app.asar at the last confirmed-intact repair.
   * Enables the watcher stat-guard early-exit; absent on older installs.
   */
  patchedAsarStat?: { size: number; mtimeMs: number };
  /**
   * Number of consecutive watcher stat-guard early-exits since the last full
   * pass. Cleanup hygiene runs every Nth guard hit. Absent on older installs.
   */
  watcherStatGuardPasses?: number;
  /**
   * Current app mode. Absent on installs that predate the mode toggle; use
   * resolveMode() so absence is inferred from the live patch marker.
   */
  mode?: AppMode;
}

/**
 * Resolve repair intent. Explicit state remains authoritative here so an
 * interrupted or externally replaced Tweakers payload enters the existing
 * mismatch/recovery gates instead of being silently reclassified. Read-only
 * status surfaces use live marker/signature evidence directly.
 */
export function resolveMode(state: InstallerState | null, liveMarkerPresent: boolean): AppMode {
  if (state?.mode === "chatgpt" || state?.mode === "tweakers") return state.mode;
  return liveMarkerPresent ? "tweakers" : "chatgpt";
}

export function readState(stateFile: string): InstallerState | null {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as InstallerState;
  } catch {
    return null;
  }
}

export function writeState(stateFile: string, state: InstallerState): void {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, stateFile);
  chmodSync(stateFile, 0o600);
  chownForTargetUser(stateFile);
}

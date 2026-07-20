import { platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { chownForTargetUser, targetUserHome } from "./ownership.js";
import { LEGACY_DATA_DIR, LEGACY_HOME_ENV, LEGACY_USER_ROOT_ENV } from "./legacy-compat.js";

/**
 * User-data directory layout. Picked per platform conventions; created lazily.
 *
 *   <root>/
 *     runtime/        — extracted runtime bundle (loader pulls from here)
 *     tweaks/         — user tweaks
 *     backup/         — original Codex.app artifacts (asar, plist, framework binary)
 *     config.json     — installer state + per-tweak enable flags
 *     log/            — runtime + installer logs
 *     state.json      — installer state (paths, hashes, version installed against)
 *     self-update-state.json — last Tweakers self-update result
 */
export interface UserPaths {
  root: string;
  runtime: string;
  tweaks: string;
  backup: string;
  configFile: string;
  stateFile: string;
  /** Present on paths produced by userPaths(); optional for legacy test fixtures. */
  deferredRepairFile?: string;
  updateModeFile: string;
  selfUpdateStateFile: string;
  binDir: string;
  logDir: string;
  transactionRoot: string;
  transactionStateFile: string;
  /** Optional only for legacy callers that construct a partial UserPaths fixture. */
  environmentProfileFile?: string;
  environmentRegistryFile?: string;
  legacyEnvironmentProfileFile?: string;
  environmentSelectionFile?: string;
  environmentTransactionFile?: string;
  environmentReceiptRoot?: string;
  environmentLockFile?: string;
  environmentRuntimeProofFile?: string;
  desktopUpdateReceiptFile?: string;
  desktopUpdateArchiveRoot?: string;
  desktopUpdateLockFile?: string;
  desktopUpdateHeartbeatFile?: string;
  desktopUpdateLogFile?: string;
}

export interface EnvironmentUserPaths {
  environmentRegistryFile: string;
  /** Deprecated alias for environmentRegistryFile. */
  environmentProfileFile: string;
  legacyEnvironmentProfileFile: string;
  environmentSelectionFile: string;
  environmentTransactionFile: string;
  environmentReceiptRoot: string;
  environmentLockFile: string;
  environmentRuntimeProofFile: string;
}

export interface DesktopUpdateUserPaths {
  desktopUpdateReceiptFile: string;
  desktopUpdateArchiveRoot: string;
  desktopUpdateLockFile: string;
  desktopUpdateHeartbeatFile: string;
  desktopUpdateLogFile: string;
}

export type ResolvedUserPaths = UserPaths & EnvironmentUserPaths & DesktopUpdateUserPaths;

export function userPaths(): ResolvedUserPaths {
  const root = userRoot();
  const paths: ResolvedUserPaths = {
    root,
    runtime: join(root, "runtime"),
    tweaks: join(root, "tweaks"),
    backup: join(root, "backup"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    deferredRepairFile: join(root, "deferred-repair.json"),
    updateModeFile: join(root, "update-mode.json"),
    selfUpdateStateFile: join(root, "self-update-state.json"),
    binDir: join(root, "bin"),
    logDir: join(root, "log"),
    transactionRoot: join(root, "transactions", "app-install"),
    transactionStateFile: join(root, "transactions", "app-install.json"),
    environmentRegistryFile: join(root, "environment-registry.json"),
    environmentProfileFile: join(root, "environment-registry.json"),
    legacyEnvironmentProfileFile: join(root, "environment-profiles.json"),
    environmentSelectionFile: join(root, "environment-selection.json"),
    environmentTransactionFile: join(root, "transactions", "environment.json"),
    environmentReceiptRoot: join(root, "transactions", "environment"),
    environmentLockFile: join(root, "transactions", "environment.lock"),
    environmentRuntimeProofFile: join(root, "environment-runtime-proof.json"),
    desktopUpdateReceiptFile: join(root, "transactions", "desktop-update.json"),
    desktopUpdateArchiveRoot: join(root, "transactions", "desktop-update"),
    desktopUpdateLockFile: join(root, "transactions", "desktop-update.lock"),
    desktopUpdateHeartbeatFile: join(root, "transactions", "desktop-update.heartbeat.json"),
    desktopUpdateLogFile: join(root, "log", "desktop-update.log"),
  };
  return paths;
}

export function ensureUserPaths(): ResolvedUserPaths {
  const p = userPaths();
  for (const dir of [
    p.root,
    p.runtime,
    p.tweaks,
    p.backup,
    p.binDir,
    p.logDir,
    p.transactionRoot,
    p.environmentReceiptRoot,
    p.desktopUpdateArchiveRoot,
  ]) {
    mkdirSync(dir, { recursive: true });
    chownForTargetUser(dir);
  }
  return p;
}

function userRoot(): string {
  // Installer-home overrides remain authoritative for explicit CLI/test
  // isolation. Runtime-spawned CLIs bind these aliases to the loader's exact
  // root, while the user-root aliases still support health/candidate launches
  // that intentionally provide only runtime metadata.
  if (process.env.TWEAKER_HOME) return process.env.TWEAKER_HOME;
  if (process.env.TWEAKERS_HOME) return process.env.TWEAKERS_HOME;
  if (process.env.TWEAKERS_USER_ROOT) return process.env.TWEAKERS_USER_ROOT;
  if (process.env.TWEAKER_USER_ROOT) return process.env.TWEAKER_USER_ROOT;
  const legacyUserRoot = process.env[LEGACY_USER_ROOT_ENV];
  if (legacyUserRoot) return legacyUserRoot;
  const legacyHome = process.env[LEGACY_HOME_ENV];
  if (legacyHome) return legacyHome;

  const home = targetUserHome();
  switch (platform()) {
    case "darwin":
      return existingInstallRoot(
        join(home, "Library", "Application Support", "Tweakers"),
        join(home, "Library", "Application Support", LEGACY_DATA_DIR),
      );
    case "win32":
      return existingInstallRoot(
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Tweakers"),
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), LEGACY_DATA_DIR),
      );
    default:
      return existingInstallRoot(join(
        process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
        "Tweakers",
      ), join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), LEGACY_DATA_DIR));
  }
}

/** Existing state remains authoritative until a dedicated data move is run. */
export function existingInstallRoot(nextRoot: string, legacyRoot: string): string {
  return existsSync(legacyRoot) ? legacyRoot : nextRoot;
}

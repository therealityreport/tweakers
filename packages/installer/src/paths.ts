import { platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { chownForTargetUser, targetUserHome } from "./ownership.js";

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
}

export function userPaths(): UserPaths {
  const root = userRoot();
  const paths: UserPaths = {
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
  };
  return paths;
}

export function ensureUserPaths(): UserPaths {
  const p = userPaths();
  for (const dir of [p.root, p.runtime, p.tweaks, p.backup, p.binDir, p.logDir, p.transactionRoot]) {
    mkdirSync(dir, { recursive: true });
    chownForTargetUser(dir);
  }
  return p;
}

function userRoot(): string {
  if (process.env.TWEAKERS_HOME) return process.env.TWEAKERS_HOME;
  // Preserve the old override for existing installs while new installs use Tweakers.
  if (process.env.CODEX_PLUSPLUS_HOME) return process.env.CODEX_PLUSPLUS_HOME;

  const home = targetUserHome();
  switch (platform()) {
    case "darwin":
      return migratedRoot(join(home, "Library", "Application Support", "Tweakers"), join(home, "Library", "Application Support", "codex-plusplus"));
    case "win32":
      return migratedRoot(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Tweakers"), join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "codex-plusplus"));
    default:
      return migratedRoot(join(
        process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
        "Tweakers",
      ), join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "codex-plusplus"));
  }
}

function migratedRoot(nextRoot: string, legacyRoot: string): string {
  // Existing state remains authoritative until explicitly migrated.
  return requireLegacyRoot(legacyRoot) ? legacyRoot : nextRoot;
}

function requireLegacyRoot(root: string): boolean {
  return existsSync(root);
}

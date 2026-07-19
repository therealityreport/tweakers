import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { migrateLegacyConfigSection } from "./legacy-compat.js";

/**
 * Shared config.json access. The file is co-owned by the runtime (tweak
 * enabled flags, update-check caches) and the installer, so every write MUST
 * round-trip unknown keys — read, mutate in place, write back.
 */
export type ConfigFile = Record<string, unknown>;

/**
 * A config file is trusted only when it is owned by the current user and is not
 * writable by group or other. On Windows (no POSIX uid/mode) we cannot check this,
 * so we trust it. A non-existent file is trusted (there is nothing to trust yet).
 * Returns false (untrusted) if the file cannot be stat'd.
 */
export function configFileIsTrusted(configFile: string): boolean {
  if (process.platform === "win32") return true;
  if (!existsSync(configFile)) return true;
  let stats;
  try {
    stats = statSync(configFile);
  } catch {
    return false;
  }
  const uid = process.getuid?.();
  if (typeof uid === "number" && stats.uid !== uid) return false;
  if ((stats.mode & 0o022) !== 0) return false;
  return true;
}

export function readConfigFile(configFile: string): ConfigFile {
  if (!existsSync(configFile)) return {};
  if (!configFileIsTrusted(configFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? migrateLegacyConfigSection(parsed as ConfigFile)
      : {};
  } catch {
    return {};
  }
}

export function updateConfigFile(configFile: string, mutate: (config: ConfigFile) => void): void {
  const config = readConfigFile(configFile);
  mutate(config);
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(configFile, 0o600);
    } catch {
      // Best-effort hardening.
    }
  }
}

/** Dev-mode source root (the checkout's tweaks/ dir) or null when dev mode is off. */
export function readDevTweaksRoot(configFile: string): string | null {
  const config = readConfigFile(configFile);
  const section = config.tweaker;
  if (!section || typeof section !== "object") return null;
  const value = (section as Record<string, unknown>).devTweaksRoot;
  return typeof value === "string" && value.length > 0 ? value : null;
}

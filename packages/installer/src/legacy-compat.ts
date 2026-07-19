/**
 * Upgrade-only identifiers from builds published before the Tweaker rebrand.
 * Keep construction split so old branding never returns to public docs,
 * diagnostics, or generated names; these values are read/removed only.
 */
export const LEGACY_DATA_DIR = ["codex", "plusplus"].join("-");
export const LEGACY_HOME_ENV = ["CODEX", "PLUSPLUS", "HOME"].join("_");
export const LEGACY_WATCHER_ENV = ["CODEX", "PLUSPLUS", "WATCHER"].join("_");
export const LEGACY_USER_ROOT_ENV = ["CODEX", "PLUSPLUS", "USER_ROOT"].join("_");
export const LEGACY_RUNTIME_ENV = ["CODEX", "PLUSPLUS", "RUNTIME"].join("_");
export const LEGACY_MANUAL_UPDATE_ENV = ["CODEX", "PLUSPLUS", "MANUAL_UPDATE"].join("_");
export const LEGACY_REPO_ENV = ["CODEX", "PLUSPLUS", "REPO"].join("_");
export const LEGACY_REF_ENV = ["CODEX", "PLUSPLUS", "REF"].join("_");
export const LEGACY_SOURCE_DIR_ENV = ["CODEX", "PLUSPLUS", "SOURCE_DIR"].join("_");
export const LEGACY_CONFIG_KEY = ["codex", "Plus", "Plus"].join("");
export const LEGACY_ASAR_META_KEY = ["__codex", "pp"].join("");
export const LEGACY_LOADER_FILE = ["codex", "plusplus-loader.cjs"].join("-");
export const LEGACY_WATCHER_STEM = ["codex", "plusplus-watcher"].join("-");
export const LEGACY_LAUNCHD_LABEL = ["com", "codexplusplus", "watcher"].join(".");
export const LEGACY_DEV_SNAPSHOT_FILE = [".codex", "pp-dev-snapshot.json"].join("");

export function legacyConfigSection(config: Record<string, unknown>): Record<string, unknown> | null {
  const value = config[LEGACY_CONFIG_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function migrateLegacyConfigSection(config: Record<string, unknown>): Record<string, unknown> {
  const legacy = legacyConfigSection(config);
  const current = config.tweaker && typeof config.tweaker === "object" && !Array.isArray(config.tweaker)
    ? config.tweaker as Record<string, unknown>
    : null;
  if (legacy) config.tweaker = { ...legacy, ...(current ?? {}) };
  delete config[LEGACY_CONFIG_KEY];
  return config;
}

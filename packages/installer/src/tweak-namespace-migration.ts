import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfigFile, updateConfigFile } from "./config.js";

const CURRENT_PUBLISHER = "co.tweakers.";
// Namespace migration is ownership-sensitive. Only publishers that this
// project actually shipped may be rewritten; a matching tweak suffix alone is
// not evidence that another publisher's data belongs to Tweakers.
const LEGACY_PUBLISHERS = ["co.thomashulihan."] as const;

/** Atomically renames unambiguous legacy paths; existing targets win conflicts. */
export function migrateLegacyTweakNamespaces(userRoot: string, configFile: string): void {
  const dataRoot = join(userRoot, "tweak-data");
  const storageRoot = join(userRoot, "storage");
  if (!existsSync(dataRoot) && !existsSync(storageRoot) && !existsSync(configFile)) return;
  const legacyPublisher = discoverLegacyPublisher(dataRoot, storageRoot, readConfigFile(configFile));
  if (!legacyPublisher) return;
  if (existsSync(dataRoot)) {
    for (const suffix of canonicalSuffixes()) {
      const legacy = join(dataRoot, `${legacyPublisher}${suffix}`);
      const current = join(dataRoot, `${CURRENT_PUBLISHER}${suffix}`);
      if (!existsSync(legacy)) continue;
      mkdirSync(dataRoot, { recursive: true });
      if (!existsSync(current)) renameSync(legacy, current);
      else {
        cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false });
        rmSync(legacy, { recursive: true, force: true });
      }
    }
  }
  if (existsSync(storageRoot)) {
    for (const suffix of canonicalSuffixes()) {
      const legacy = join(storageRoot, `${legacyPublisher}${suffix}.json`);
      const current = join(storageRoot, `${CURRENT_PUBLISHER}${suffix}.json`);
      if (existsSync(legacy) && !existsSync(current)) renameSync(legacy, current);
      else if (existsSync(legacy)) rmSync(legacy, { force: true });
    }
  }
  updateConfigFile(configFile, (config) => rewriteLegacyKeys(config, legacyPublisher));
}

/** Rollback-safe pre-health copy: old paths/keys remain valid until promotion. */
export function prepareLegacyTweakNamespaces(userRoot: string, configFile: string): void {
  const dataRoot = join(userRoot, "tweak-data");
  const storageRoot = join(userRoot, "storage");
  const rawConfig = readRawConfig(configFile);
  const legacyPublisher = discoverLegacyPublisher(dataRoot, storageRoot, rawConfig);
  if (!legacyPublisher) return;
  for (const suffix of canonicalSuffixes()) {
    const legacyData = join(dataRoot, `${legacyPublisher}${suffix}`);
    const currentData = join(dataRoot, `${CURRENT_PUBLISHER}${suffix}`);
    if (existsSync(legacyData) && !existsSync(currentData)) {
      cpSync(legacyData, currentData, { recursive: true, force: false, errorOnExist: false });
    }
    const legacyStorage = join(storageRoot, `${legacyPublisher}${suffix}.json`);
    const currentStorage = join(storageRoot, `${CURRENT_PUBLISHER}${suffix}.json`);
    if (existsSync(legacyStorage) && !existsSync(currentStorage)) cpSync(legacyStorage, currentStorage);
  }
  duplicateLegacyKeys(rawConfig, legacyPublisher);
  writeRawConfig(configFile, rawConfig);
}

function discoverLegacyPublisher(dataRoot: string, storageRoot: string, config: Record<string, unknown>): string | null {
  const suffixes = new Set(canonicalSuffixes());
  const publishers = new Set<string>();
  const inspect = (name: string): void => {
    const normalized = name.endsWith(".json") ? name.slice(0, -5) : name;
    for (const suffix of suffixes) {
      const ending = `.${suffix}`;
      if (!normalized.endsWith(ending)) continue;
      const publisher = `${normalized.slice(0, -ending.length)}.`;
      if ((LEGACY_PUBLISHERS as readonly string[]).includes(publisher)) publishers.add(publisher);
    }
  };
  for (const root of [dataRoot, storageRoot]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) inspect(name);
  }
  collectConfigKeys(config, inspect);
  return publishers.size === 1 ? [...publishers][0]! : null;
}

function collectConfigKeys(value: unknown, inspect: (key: string) => void): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    inspect(key);
    collectConfigKeys(child, inspect);
  }
}

function duplicateLegacyKeys(value: unknown, legacyPublisher: string): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const nextKey = canonicalKeyForOwnedLegacyId(key, legacyPublisher);
    if (nextKey) {
      value[nextKey] = mergeValues(child, value[nextKey]);
    }
    duplicateLegacyKeys(child, legacyPublisher);
  }
}

function readRawConfig(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeRawConfig(path: string, config: Record<string, unknown>): void {
  if (!existsSync(path) && Object.keys(config).length === 0) return;
  const temporary = `${path}.${process.pid}.migration`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function canonicalSuffixes(): string[] {
  return [
    "account-switcher",
    "appshots",
    "developer-tools",
    "followup",
    "projects",
    "shadcn-codex-ui",
    "thread-summary-profiles",
    "titlebar-controls",
    "ui-improvements",
    "usage-limit-resets-tracker",
    "user-questions",
  ];
}

function rewriteLegacyKeys(value: unknown, legacyPublisher: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    const nextKey = canonicalKeyForOwnedLegacyId(key, legacyPublisher);
    if (nextKey) {
      const current = record[nextKey];
      record[nextKey] = mergeValues(child, current);
      delete record[key];
      rewriteLegacyKeys(record[nextKey], legacyPublisher);
    } else {
      rewriteLegacyKeys(child, legacyPublisher);
    }
  }
}

function canonicalKeyForOwnedLegacyId(key: string, legacyPublisher: string): string | null {
  for (const suffix of canonicalSuffixes()) {
    if (key === `${legacyPublisher}${suffix}`) return `${CURRENT_PUBLISHER}${suffix}`;
  }
  return null;
}

function mergeValues(legacy: unknown, current: unknown): unknown {
  if (current === undefined) return legacy;
  if (isRecord(legacy) && isRecord(current)) return { ...legacy, ...current };
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

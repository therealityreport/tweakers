import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
  ACCOUNT_ROUTER_SCHEMA_VERSION,
  ACCOUNT_ROUTER_SCHEMA_VERSION_V2,
  ACCOUNT_ROUTER_SCHEMA_VERSION_V3,
  type RouterConfig,
  type RouterConfigV1,
  type RouterConfigV2,
  type RouterConfigV3,
  isFingerprint,
  isOpaqueAccountId,
  isPlainRecord,
} from "./types";

export const ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
export const ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";

export type RouterLaunchReason =
  | "balanced"
  | "quota_aware"
  | "manual"
  | "history-adoption-required"
  | "missing-config"
  | "invalid-config"
  | "unsupported-protocol";

export interface RouterLaunchSelection {
  mode: "mux" | "direct";
  reason: RouterLaunchReason;
  config: RouterConfig | null;
}

export function defaultAccountRouterConfigPath(userRoot: string | undefined): string | null {
  if (!userRoot) return null;
  return join(userRoot, "tweak-data", ACCOUNT_SWITCHER_TWEAK_ID, ACCOUNT_ROUTER_CONFIG_FILE);
}

export function readRouterLaunchSelection(
  configPath: string | null | undefined,
  readFile: (path: string, encoding: BufferEncoding) => string = readFileSync,
  pathExists: (path: string) => boolean = existsSync,
): RouterLaunchSelection {
  if (!configPath || !pathExists(configPath)) return { mode: "direct", reason: "missing-config", config: null };
  try {
    const config = validateRouterConfig(JSON.parse(readFile(configPath, "utf8")));
    if (!config) return { mode: "direct", reason: "invalid-config", config: null };
    if (config.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT) {
      return { mode: "direct", reason: "unsupported-protocol", config: null };
    }
    // Legacy v1 remains readable for UI/installer compatibility, but it has
    // no signed history-adoption contract and therefore can never select a
    // process mux. V2 manual is mux-backed after the preflight receipt gate.
    if (config.schemaVersion !== 2 && config.schemaVersion !== 3) {
      return { mode: "direct", reason: "history-adoption-required", config };
    }
    return { mode: "mux", reason: config.mode, config };
  } catch {
    return { mode: "direct", reason: "invalid-config", config: null };
  }
}

/** Strictly validates the redacted v1 config before the parent changes process topology. */
export function validateRouterConfig(value: unknown): RouterConfig | null {
  if (!isPlainRecord(value)) return null;
  if (value.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION) return validateRouterConfigV1(value);
  if (value.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION_V2) return validateRouterConfigV2(value);
  if (value.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION_V3) return validateRouterConfigV3(value);
  return null;
}

function validateRouterConfigV3(value: Record<string, unknown>): RouterConfigV3 | null {
  const allowed = new Set([
    "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const mode = value.mode === "manual" || value.mode === "quota_aware" ? value.mode : null;
  const policy = value.policy === "quota_aware_v2" || value.policy === "balanced_tokens_v1" ? value.policy : value.policy === null ? null : undefined;
  if (!mode || policy === undefined || (mode === "quota_aware" && policy !== "quota_aware_v2" && policy !== "balanced_tokens_v1") || (mode === "manual" && policy !== null)) return null;
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 || !isFingerprint(value.fingerprint)) return null;
  if (!isFingerprint(value.protocolFingerprint) || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !isOpaqueAccountId(value.primaryOpaqueAccountId)) return null;
  if (!isIsoTimestamp(value.updatedAt) || !Array.isArray(value.accounts) || value.accounts.length < 1) return null;
  const accounts = value.accounts.map(validateAccountConfigV2);
  if (accounts.some((account) => account === null)) return null;
  const validAccounts = accounts as RouterConfigV3["accounts"];
  if (new Set(validAccounts.map((account) => account.opaqueAccountId)).size !== validAccounts.length) return null;
  const primary = validAccounts.find((account) => account.opaqueAccountId === value.primaryOpaqueAccountId);
  if (!primary || !primary.included || (mode === "quota_aware" && !validAccounts.some((account) => account.included))) return null;
  const config: RouterConfigV3 = {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION_V3,
    mode,
    policy,
    generation: value.generation,
    fingerprint: value.fingerprint,
    protocolFingerprint: value.protocolFingerprint,
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    accounts: validAccounts,
    updatedAt: value.updatedAt,
  };
  return routerConfigFingerprint(config) === config.fingerprint ? config : null;
}

/** Strict legacy validator: do not make a v1 file acquire v2 requirements. */
function validateRouterConfigV1(value: Record<string, unknown>): RouterConfigV1 | null {
  const allowed = new Set([
    "schemaVersion", "mode", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION) return null;
  if (value.mode !== "manual" && value.mode !== "balanced") return null;
  if (!isFingerprint(value.protocolFingerprint) || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !isOpaqueAccountId(value.primaryOpaqueAccountId)) return null;
  if (typeof value.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.updatedAt)) return null;
  if (!Array.isArray(value.accounts) || value.accounts.length !== 2) return null;
  const accounts = value.accounts.map(validateAccountConfigV1);
  if (accounts.some((account) => account === null)) return null;
  const validAccounts = accounts as NonNullable<typeof accounts[number]>[];
  if (new Set(validAccounts.map((account) => account.opaqueAccountId)).size !== 2) return null;
  const primary = validAccounts.find((account) => account.opaqueAccountId === value.primaryOpaqueAccountId);
  if (!primary || !primary.included) return null;
  return {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    mode: value.mode,
    protocolFingerprint: value.protocolFingerprint,
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    accounts: [validAccounts[0], validAccounts[1]],
    updatedAt: value.updatedAt,
  };
}

function validateRouterConfigV2(value: Record<string, unknown>): RouterConfigV2 | null {
  const allowed = new Set([
    "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const mode = value.mode === "manual" || value.mode === "quota_aware" ? value.mode : null;
  const policy = value.policy === "quota_aware_v1" ? "quota_aware_v1" : value.policy === null ? null : undefined;
  const generation = value.generation;
  if (!mode || policy === undefined) return null;
  if ((mode === "quota_aware" && policy !== "quota_aware_v1") || (mode === "manual" && policy !== null)) return null;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !isFingerprint(value.fingerprint)) return null;
  if (!isFingerprint(value.protocolFingerprint) || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !isOpaqueAccountId(value.primaryOpaqueAccountId)) return null;
  if (!isIsoTimestamp(value.updatedAt) || !Array.isArray(value.accounts) || value.accounts.length !== 2) return null;
  const accounts = value.accounts.map(validateAccountConfigV2);
  if (accounts.some((account) => account === null)) return null;
  const validAccounts = accounts as RouterConfigV2["accounts"];
  if (new Set(validAccounts.map((account) => account.opaqueAccountId)).size !== 2 || validAccounts.some((account) => !account.included)) return null;
  if (!validAccounts.some((account) => account.opaqueAccountId === value.primaryOpaqueAccountId)) return null;
  const config: RouterConfigV2 = {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION_V2,
    mode,
    policy,
    generation,
    fingerprint: value.fingerprint,
    protocolFingerprint: value.protocolFingerprint,
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    accounts: [validAccounts[0], validAccounts[1]],
    updatedAt: value.updatedAt,
  };
  return routerConfigFingerprint(config) === config.fingerprint ? config : null;
}

function validateAccountConfigV1(value: unknown): RouterConfigV1["accounts"][number] | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set(["opaqueAccountId", "included", "weight", "capabilityFingerprint"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!isOpaqueAccountId(value.opaqueAccountId) || typeof value.included !== "boolean") return null;
  const weight = value.weight;
  if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > 100) return null;
  if (!isFingerprint(value.capabilityFingerprint)) return null;
  return {
    opaqueAccountId: value.opaqueAccountId,
    included: value.included,
    weight,
    capabilityFingerprint: value.capabilityFingerprint,
  };
}

function validateAccountConfigV2(value: unknown): RouterConfigV2["accounts"][number] | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set(["opaqueAccountId", "included", "weight", "capabilityFingerprint", "label"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const legacy = validateAccountConfigV1({
    opaqueAccountId: value.opaqueAccountId,
    included: value.included,
    weight: value.weight,
    capabilityFingerprint: value.capabilityFingerprint,
  });
  if (!legacy || !isSafeLocalLabel(value.label)) return null;
  return { ...legacy, label: value.label };
}

/**
 * The same stable serialization must be used by the v2 config writer. It
 * purposefully excludes `fingerprint` and `updatedAt`; timestamp-only writes
 * therefore cannot pretend to be a new routing generation.
 */
export function routerConfigFingerprint(
  config: Omit<RouterConfigV2, "fingerprint"> | RouterConfigV2 | Omit<RouterConfigV3, "fingerprint"> | RouterConfigV3,
): `sha256:${string}` {
  const canonical = {
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
      weight: account.weight,
      capabilityFingerprint: account.capabilityFingerprint,
      label: account.label,
    })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

export function isRouterConfigV2(config: RouterConfig): config is RouterConfigV2 {
  return config.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION_V2;
}

export function isRouterConfigV3(config: RouterConfig): config is RouterConfigV3 {
  return config.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION_V3;
}

export function isQuotaAwareRouterConfig(config: RouterConfig): config is RouterConfigV2 | RouterConfigV3 {
  return isRouterConfigV2(config) || isRouterConfigV3(config);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  // Date.parse normalizes impossible calendar values; round-tripping through
  // the canonical UTC ISO form rejects those and fractional truncation alike.
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Labels are local presentation text, never an email or provider identifier. */
function isSafeLocalLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return value === normalized
    && !/[@/\\]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

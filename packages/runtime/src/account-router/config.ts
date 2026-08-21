import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
  ACCOUNT_ROUTER_SCHEMA_VERSION,
  type RouterConfig,
  isFingerprint,
  isOpaqueAccountId,
  isPlainRecord,
} from "./types";

export const ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
export const ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";

export type RouterLaunchReason =
  | "balanced"
  | "manual"
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
    if (config.mode !== "balanced") return { mode: "direct", reason: "manual", config };
    if (config.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT) {
      return { mode: "direct", reason: "unsupported-protocol", config: null };
    }
    return { mode: "mux", reason: "balanced", config };
  } catch {
    return { mode: "direct", reason: "invalid-config", config: null };
  }
}

/** Strictly validates the redacted v1 config before the parent changes process topology. */
export function validateRouterConfig(value: unknown): RouterConfig | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set([
    "schemaVersion", "mode", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION) return null;
  if (value.mode !== "manual" && value.mode !== "balanced") return null;
  if (!isFingerprint(value.protocolFingerprint) || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !isOpaqueAccountId(value.primaryOpaqueAccountId)) return null;
  if (typeof value.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.updatedAt)) return null;
  if (!Array.isArray(value.accounts) || value.accounts.length !== 2) return null;
  const accounts = value.accounts.map(validateAccountConfig);
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

function validateAccountConfig(value: unknown): RouterConfig["accounts"][number] | null {
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

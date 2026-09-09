"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNT_ROUTER_CONFIG_FILE = exports.ACCOUNT_SWITCHER_TWEAK_ID = void 0;
exports.defaultAccountRouterConfigPath = defaultAccountRouterConfigPath;
exports.readRouterLaunchSelection = readRouterLaunchSelection;
exports.validateRouterConfig = validateRouterConfig;
exports.routerConfigFingerprint = routerConfigFingerprint;
exports.isRouterConfigV2 = isRouterConfigV2;
exports.isRouterConfigV3 = isRouterConfigV3;
exports.isQuotaAwareRouterConfig = isQuotaAwareRouterConfig;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const types_1 = require("./types");
exports.ACCOUNT_SWITCHER_TWEAK_ID = "co.tweakers.account-switcher";
exports.ACCOUNT_ROUTER_CONFIG_FILE = "account-router-config.json";
function defaultAccountRouterConfigPath(userRoot) {
    if (!userRoot)
        return null;
    return (0, node_path_1.join)(userRoot, "tweak-data", exports.ACCOUNT_SWITCHER_TWEAK_ID, exports.ACCOUNT_ROUTER_CONFIG_FILE);
}
function readRouterLaunchSelection(configPath, readFile = node_fs_1.readFileSync, pathExists = node_fs_1.existsSync) {
    if (!configPath || !pathExists(configPath))
        return { mode: "direct", reason: "missing-config", config: null };
    try {
        const config = validateRouterConfig(JSON.parse(readFile(configPath, "utf8")));
        if (!config)
            return { mode: "direct", reason: "invalid-config", config: null };
        if (config.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT) {
            return { mode: "direct", reason: "unsupported-protocol", config: null };
        }
        // Legacy v1 remains readable for UI/installer compatibility, but it has
        // no signed history-adoption contract and therefore can never select a
        // process mux. V2 manual is mux-backed after the preflight receipt gate.
        if (config.schemaVersion !== 2 && config.schemaVersion !== 3) {
            return { mode: "direct", reason: "history-adoption-required", config };
        }
        return { mode: "mux", reason: config.mode, config };
    }
    catch {
        return { mode: "direct", reason: "invalid-config", config: null };
    }
}
/** Strictly validates the redacted v1 config before the parent changes process topology. */
function validateRouterConfig(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    if (value.schemaVersion === types_1.ACCOUNT_ROUTER_SCHEMA_VERSION)
        return validateRouterConfigV1(value);
    if (value.schemaVersion === types_1.ACCOUNT_ROUTER_SCHEMA_VERSION_V2)
        return validateRouterConfigV2(value);
    if (value.schemaVersion === types_1.ACCOUNT_ROUTER_SCHEMA_VERSION_V3)
        return validateRouterConfigV3(value);
    return null;
}
function validateRouterConfigV3(value) {
    const allowed = new Set([
        "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return null;
    const mode = value.mode === "manual" || value.mode === "quota_aware" ? value.mode : null;
    const policy = value.policy === "quota_aware_v2" || value.policy === "balanced_tokens_v1" ? value.policy : value.policy === null ? null : undefined;
    if (!mode || policy === undefined || (mode === "quota_aware" && policy !== "quota_aware_v2" && policy !== "balanced_tokens_v1") || (mode === "manual" && policy !== null))
        return null;
    if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 || !(0, types_1.isFingerprint)(value.fingerprint))
        return null;
    if (!(0, types_1.isFingerprint)(value.protocolFingerprint) || value.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !(0, types_1.isOpaqueAccountId)(value.primaryOpaqueAccountId))
        return null;
    if (!isIsoTimestamp(value.updatedAt) || !Array.isArray(value.accounts) || value.accounts.length < 1)
        return null;
    const accounts = value.accounts.map(validateAccountConfigV2);
    if (accounts.some((account) => account === null))
        return null;
    const validAccounts = accounts;
    if (new Set(validAccounts.map((account) => account.opaqueAccountId)).size !== validAccounts.length)
        return null;
    const primary = validAccounts.find((account) => account.opaqueAccountId === value.primaryOpaqueAccountId);
    if (!primary || !primary.included || (mode === "quota_aware" && !validAccounts.some((account) => account.included)))
        return null;
    const config = {
        schemaVersion: types_1.ACCOUNT_ROUTER_SCHEMA_VERSION_V3,
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
function validateRouterConfigV1(value) {
    const allowed = new Set([
        "schemaVersion", "mode", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return null;
    if (value.schemaVersion !== types_1.ACCOUNT_ROUTER_SCHEMA_VERSION)
        return null;
    if (value.mode !== "manual" && value.mode !== "balanced")
        return null;
    if (!(0, types_1.isFingerprint)(value.protocolFingerprint) || value.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !(0, types_1.isOpaqueAccountId)(value.primaryOpaqueAccountId))
        return null;
    if (typeof value.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.updatedAt))
        return null;
    if (!Array.isArray(value.accounts) || value.accounts.length !== 2)
        return null;
    const accounts = value.accounts.map(validateAccountConfigV1);
    if (accounts.some((account) => account === null))
        return null;
    const validAccounts = accounts;
    if (new Set(validAccounts.map((account) => account.opaqueAccountId)).size !== 2)
        return null;
    const primary = validAccounts.find((account) => account.opaqueAccountId === value.primaryOpaqueAccountId);
    if (!primary || !primary.included)
        return null;
    return {
        schemaVersion: types_1.ACCOUNT_ROUTER_SCHEMA_VERSION,
        mode: value.mode,
        protocolFingerprint: value.protocolFingerprint,
        primaryOpaqueAccountId: value.primaryOpaqueAccountId,
        accounts: [validAccounts[0], validAccounts[1]],
        updatedAt: value.updatedAt,
    };
}
function validateRouterConfigV2(value) {
    const allowed = new Set([
        "schemaVersion", "mode", "policy", "generation", "fingerprint", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return null;
    const mode = value.mode === "manual" || value.mode === "quota_aware" ? value.mode : null;
    const policy = value.policy === "quota_aware_v1" ? "quota_aware_v1" : value.policy === null ? null : undefined;
    const generation = value.generation;
    if (!mode || policy === undefined)
        return null;
    if ((mode === "quota_aware" && policy !== "quota_aware_v1") || (mode === "manual" && policy !== null))
        return null;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !(0, types_1.isFingerprint)(value.fingerprint))
        return null;
    if (!(0, types_1.isFingerprint)(value.protocolFingerprint) || value.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !(0, types_1.isOpaqueAccountId)(value.primaryOpaqueAccountId))
        return null;
    if (!isIsoTimestamp(value.updatedAt) || !Array.isArray(value.accounts) || value.accounts.length !== 2)
        return null;
    const accounts = value.accounts.map(validateAccountConfigV2);
    if (accounts.some((account) => account === null))
        return null;
    const validAccounts = accounts;
    if (new Set(validAccounts.map((account) => account.opaqueAccountId)).size !== 2 || validAccounts.some((account) => !account.included))
        return null;
    if (!validAccounts.some((account) => account.opaqueAccountId === value.primaryOpaqueAccountId))
        return null;
    const config = {
        schemaVersion: types_1.ACCOUNT_ROUTER_SCHEMA_VERSION_V2,
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
function validateAccountConfigV1(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    const allowed = new Set(["opaqueAccountId", "included", "weight", "capabilityFingerprint"]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return null;
    if (!(0, types_1.isOpaqueAccountId)(value.opaqueAccountId) || typeof value.included !== "boolean")
        return null;
    const weight = value.weight;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > 100)
        return null;
    if (!(0, types_1.isFingerprint)(value.capabilityFingerprint))
        return null;
    return {
        opaqueAccountId: value.opaqueAccountId,
        included: value.included,
        weight,
        capabilityFingerprint: value.capabilityFingerprint,
    };
}
function validateAccountConfigV2(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    const allowed = new Set(["opaqueAccountId", "included", "weight", "capabilityFingerprint", "label"]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return null;
    const legacy = validateAccountConfigV1({
        opaqueAccountId: value.opaqueAccountId,
        included: value.included,
        weight: value.weight,
        capabilityFingerprint: value.capabilityFingerprint,
    });
    if (!legacy || !isSafeLocalLabel(value.label))
        return null;
    return { ...legacy, label: value.label };
}
/**
 * The same stable serialization must be used by the v2 config writer. It
 * purposefully excludes `fingerprint` and `updatedAt`; timestamp-only writes
 * therefore cannot pretend to be a new routing generation.
 */
function routerConfigFingerprint(config) {
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
    return `sha256:${(0, node_crypto_1.createHash)("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}
function isRouterConfigV2(config) {
    return config.schemaVersion === types_1.ACCOUNT_ROUTER_SCHEMA_VERSION_V2;
}
function isRouterConfigV3(config) {
    return config.schemaVersion === types_1.ACCOUNT_ROUTER_SCHEMA_VERSION_V3;
}
function isQuotaAwareRouterConfig(config) {
    return isRouterConfigV2(config) || isRouterConfigV3(config);
}
function isIsoTimestamp(value) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
        return false;
    const timestamp = Date.parse(value);
    // Date.parse normalizes impossible calendar values; round-tripping through
    // the canonical UTC ISO form rejects those and fractional truncation alike.
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
/** Labels are local presentation text, never an email or provider identifier. */
function isSafeLocalLabel(value) {
    if (typeof value !== "string")
        return false;
    const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
    return value === normalized
        && !/[@/\\]/.test(value)
        && !/[\u0000-\u001f\u007f]/.test(value)
        && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if ((0, types_1.isPlainRecord)(value))
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}
//# sourceMappingURL=config.js.map
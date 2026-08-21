"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNT_ROUTER_CONFIG_FILE = exports.ACCOUNT_SWITCHER_TWEAK_ID = void 0;
exports.defaultAccountRouterConfigPath = defaultAccountRouterConfigPath;
exports.readRouterLaunchSelection = readRouterLaunchSelection;
exports.validateRouterConfig = validateRouterConfig;
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
        if (config.mode !== "balanced")
            return { mode: "direct", reason: "manual", config };
        if (config.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT) {
            return { mode: "direct", reason: "unsupported-protocol", config: null };
        }
        return { mode: "mux", reason: "balanced", config };
    }
    catch {
        return { mode: "direct", reason: "invalid-config", config: null };
    }
}
/** Strictly validates the redacted v1 config before the parent changes process topology. */
function validateRouterConfig(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
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
    const accounts = value.accounts.map(validateAccountConfig);
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
function validateAccountConfig(value) {
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
//# sourceMappingURL=config.js.map
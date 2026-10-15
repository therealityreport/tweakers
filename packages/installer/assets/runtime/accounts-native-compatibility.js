"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL = void 0;
exports.readAccountsNativeCompatibility = readAccountsNativeCompatibility;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tweakers_sdk_1 = require("@therealityreport/tweakers-sdk");
exports.ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL = "tweaker:accounts-native-compatibility";
let cached = null;
/** Electron's filesystem reads ASAR entries without extracting or changing it. */
function readAccountsNativeCompatibility(asarRoot) {
    try {
        const stat = (0, node_fs_1.statSync)(asarRoot);
        const key = `${asarRoot}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        if (cached?.key === key)
            return cached.status;
        const pkg = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(asarRoot, "package.json"), "utf8"));
        const status = (0, tweakers_sdk_1.validateAccountsNativeCompatibility)(pkg?.__tweaker?.accountsNative, (path) => (0, node_fs_1.readFileSync)((0, node_path_1.join)(asarRoot, path), "utf8"), (source) => (0, node_crypto_1.createHash)("sha256").update(source).digest("hex"));
        cached = { key, status };
        return status;
    }
    catch {
        return { compatible: false, reason: "Accounts requires a compatible desktop refresh.", hookSetSha256: null, build: null };
    }
}
//# sourceMappingURL=accounts-native-compatibility.js.map
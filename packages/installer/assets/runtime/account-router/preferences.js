"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountsPreferencesStore = exports.DEFAULT_ACCOUNTS_PREFERENCES = exports.ACCOUNTS_PREFERENCES_FILE = void 0;
exports.isAccountsPreferences = isAccountsPreferences;
exports.isAccountsPreferencesPatch = isAccountsPreferencesPatch;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
exports.ACCOUNTS_PREFERENCES_FILE = "accounts-preferences.v1.json";
exports.DEFAULT_ACCOUNTS_PREFERENCES = Object.freeze({
    failoverMode: "automatic",
    unifiedCatalogEnabled: false,
});
function isAccountsPreferences(value) {
    return (0, types_1.isPlainRecord)(value)
        && Object.keys(value).sort().join("\0") === "failoverMode\0unifiedCatalogEnabled"
        && (value.failoverMode === "automatic" || value.failoverMode === "ask")
        && typeof value.unifiedCatalogEnabled === "boolean";
}
function isAccountsPreferencesPatch(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).length > 0
        && Object.keys(value).every((key) => key === "failoverMode" || key === "unifiedCatalogEnabled")
        && (!("failoverMode" in value) || value.failoverMode === "automatic" || value.failoverMode === "ask")
        && (!("unifiedCatalogEnabled" in value) || typeof value.unifiedCatalogEnabled === "boolean");
}
/** The elected broker is the only writer; reading never creates registration. */
class AccountsPreferencesStore {
    root;
    current;
    constructor(root) {
        this.root = root;
        this.current = this.read();
    }
    snapshot() { return { ...this.current }; }
    update(patch) {
        if (!isAccountsPreferencesPatch(patch))
            throw new Error("invalid Accounts preferences");
        // Detect an external edit instead of silently replacing it from stale memory.
        if (JSON.stringify(this.read()) !== JSON.stringify(this.current))
            throw new Error("Accounts preferences changed outside their owner");
        const next = { ...this.current, ...patch };
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.root, exports.ACCOUNTS_PREFERENCES_FILE, { version: 1, ...next }, 4_096);
        this.current = next;
        return this.snapshot();
    }
    read() {
        const path = (0, node_path_1.join)(this.root, exports.ACCOUNTS_PREFERENCES_FILE);
        try {
            (0, node_fs_1.lstatSync)(path);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return { ...exports.DEFAULT_ACCOUNTS_PREFERENCES };
            throw error;
        }
        (0, state_store_1.assertPrivateRegularFile)(path, 4_096);
        const value = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (!(0, types_1.isPlainRecord)(value) || value.version !== 1)
            throw new Error("invalid Accounts preferences version");
        const { version: _version, ...preferences } = value;
        if (!isAccountsPreferences(preferences))
            throw new Error("invalid Accounts preferences");
        return { failoverMode: preferences.failoverMode, unifiedCatalogEnabled: preferences.unifiedCatalogEnabled };
    }
}
exports.AccountsPreferencesStore = AccountsPreferencesStore;
//# sourceMappingURL=preferences.js.map
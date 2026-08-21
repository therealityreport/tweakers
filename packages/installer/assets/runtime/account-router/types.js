"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ELIGIBILITY_STATES = exports.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT = exports.ACCOUNT_ROUTER_CONTRACT_FINGERPRINT = exports.ACCOUNT_ROUTER_SCHEMA_VERSION = void 0;
exports.isOpaqueAccountId = isOpaqueAccountId;
exports.isFingerprint = isFingerprint;
exports.isJsonRpcId = isJsonRpcId;
exports.isPlainRecord = isPlainRecord;
exports.ACCOUNT_ROUTER_SCHEMA_VERSION = 1;
exports.ACCOUNT_ROUTER_CONTRACT_FINGERPRINT = "sha256:6f9d6889bd23ff1122a89b417348b7346cdaa76ced1173eae8c7f8d0608113c2";
exports.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT = "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
exports.ELIGIBILITY_STATES = new Set([
    "validating", "eligible", "reserved", "active", "cooldown", "quota_depleted",
    "reauth_required", "plugin_blocked", "protocol_blocked", "disabled", "unhealthy",
]);
function isOpaqueAccountId(value) {
    return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value);
}
function isFingerprint(value) {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function isJsonRpcId(value) {
    return (typeof value === "string" && value.length <= 4_096)
        || (typeof value === "number" && Number.isSafeInteger(value));
}
function isPlainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=types.js.map
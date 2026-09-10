"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ELIGIBILITY_STATES = exports.ACCOUNTS_BROKER_HANDOFF_TTL_MS = exports.ACCOUNTS_BROKER_IDLE_EVICTION_MS = exports.ACCOUNTS_BROKER_MAX_CLIENTS = exports.ACCOUNTS_BROKER_MAX_CHILD_START_CONCURRENCY = exports.ACCOUNTS_BROKER_MAX_RESIDENT_CHILDREN = exports.ACCOUNTS_BROKER_VERSION = exports.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT = exports.ACCOUNT_ROUTER_CONTRACT_FINGERPRINT = exports.ACCOUNT_ROUTER_SCHEMA_VERSION_V3 = exports.ACCOUNT_ROUTER_SCHEMA_VERSION_V2 = exports.ACCOUNT_ROUTER_SCHEMA_VERSION = void 0;
exports.isOpaqueAccountId = isOpaqueAccountId;
exports.isOpaqueRendererRef = isOpaqueRendererRef;
exports.isOpaqueAppToolsRef = isOpaqueAppToolsRef;
exports.isOpaqueTaskRef = isOpaqueTaskRef;
exports.isOpaqueHandoffRef = isOpaqueHandoffRef;
exports.isOpaqueConversationId = isOpaqueConversationId;
exports.isOpaqueSegmentId = isOpaqueSegmentId;
exports.isOpaqueTurnId = isOpaqueTurnId;
exports.isOpaqueConfirmationId = isOpaqueConfirmationId;
exports.isOpaqueConnectionDefinitionRef = isOpaqueConnectionDefinitionRef;
exports.isOpaqueEnrollmentRef = isOpaqueEnrollmentRef;
exports.isFingerprint = isFingerprint;
exports.isJsonRpcId = isJsonRpcId;
exports.isPlainRecord = isPlainRecord;
/** The legacy on-disk/state contract. Keep this export for v1 consumers. */
exports.ACCOUNT_ROUTER_SCHEMA_VERSION = 1;
exports.ACCOUNT_ROUTER_SCHEMA_VERSION_V2 = 2;
exports.ACCOUNT_ROUTER_SCHEMA_VERSION_V3 = 3;
exports.ACCOUNT_ROUTER_CONTRACT_FINGERPRINT = "sha256:6f9d6889bd23ff1122a89b417348b7346cdaa76ced1173eae8c7f8d0608113c2";
exports.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT = "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
/**
 * Accounts broker v1 is intentionally a separate, renderer-safe contract from
 * the router's private on-disk configuration.  In particular, no provider
 * account id, home path, credential, cookie, request body, or app-server id is
 * valid in any of the types below.
 */
exports.ACCOUNTS_BROKER_VERSION = 1;
/** Hard configuration bound; the resident target is every enabled subscription. */
exports.ACCOUNTS_BROKER_MAX_RESIDENT_CHILDREN = 64;
exports.ACCOUNTS_BROKER_MAX_CHILD_START_CONCURRENCY = 4;
/** Desktop renderer sessions are bounded independently from child residency. */
exports.ACCOUNTS_BROKER_MAX_CLIENTS = 16;
exports.ACCOUNTS_BROKER_IDLE_EVICTION_MS = 300_000;
exports.ACCOUNTS_BROKER_HANDOFF_TTL_MS = 60_000;
exports.ELIGIBILITY_STATES = new Set([
    "validating", "eligible", "reserved", "active", "cooldown", "quota_depleted",
    "reauth_required", "plugin_blocked", "protocol_blocked", "disabled", "unhealthy",
]);
function isOpaqueAccountId(value) {
    return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value);
}
function isOpaqueRendererRef(value) {
    return typeof value === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueAppToolsRef(value) {
    return typeof value === "string" && /^bat_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueTaskRef(value) {
    return typeof value === "string" && /^bt_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueHandoffRef(value) {
    return typeof value === "string" && /^bh_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueConversationId(value) {
    return typeof value === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueSegmentId(value) {
    return typeof value === "string" && /^ls_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueTurnId(value) {
    return typeof value === "string" && /^lt_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueConfirmationId(value) {
    return typeof value === "string" && /^bc_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueConnectionDefinitionRef(value) {
    return typeof value === "string" && /^bd_[A-Za-z0-9_-]{16,128}$/.test(value);
}
function isOpaqueEnrollmentRef(value) {
    return typeof value === "string" && /^be_[A-Za-z0-9_-]{16,128}$/.test(value);
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
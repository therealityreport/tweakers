"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HISTORY_ADOPTION_MAX_OWNERS_BYTES = exports.HISTORY_ADOPTION_MAX_ARTIFACT_BYTES = exports.ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE = exports.ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE = exports.ACCOUNT_HISTORY_ADOPTION_INTENT_FILE = void 0;
exports.canonicalJson = canonicalJson;
exports.historyAdoptionPoolFingerprint = historyAdoptionPoolFingerprint;
exports.historyAdoptionIntentFingerprint = historyAdoptionIntentFingerprint;
exports.historyAdoptionThreadOwnersFingerprint = historyAdoptionThreadOwnersFingerprint;
exports.parseHistoryAdoptionIntent = parseHistoryAdoptionIntent;
exports.parseHistoryAdoptionOwners = parseHistoryAdoptionOwners;
exports.parseHistoryAdoptionReceipt = parseHistoryAdoptionReceipt;
exports.verifyHistoryAdoptionIntent = verifyHistoryAdoptionIntent;
exports.verifyHistoryAdoptionOwners = verifyHistoryAdoptionOwners;
exports.verifyHistoryAdoptionReceipt = verifyHistoryAdoptionReceipt;
exports.validateHistoryAdoptionEvidence = validateHistoryAdoptionEvidence;
exports.validateHistoryAdoptionArtifacts = validateHistoryAdoptionArtifacts;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const types_1 = require("./types");
/** Offline-published evidence names. The runtime only verifies them. */
exports.ACCOUNT_HISTORY_ADOPTION_INTENT_FILE = "history-adoption-intent.v1.json";
exports.ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE = "history-adoption-receipt.v1.json";
exports.ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE = "history-adoption-owners.v1.json";
exports.HISTORY_ADOPTION_MAX_ARTIFACT_BYTES = 64 * 1024;
exports.HISTORY_ADOPTION_MAX_OWNERS_BYTES = 2 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const DATABASE_NAMES = [
    "goals_1.sqlite", "logs_2.sqlite", "memories_1.sqlite", "queue_1.sqlite", "state_5.sqlite", "thread_history_1.sqlite",
];
const HISTORY_NAMES = ["archived_sessions", "session_index.jsonl", "sessions"];
class HistoryAdoptionError extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
/** Recursively key-sorted JSON shared with the offline publisher, without an import boundary. */
function canonicalJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new HistoryAdoptionError("history_adoption_invalid");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    if (!(0, types_1.isPlainRecord)(value))
        throw new HistoryAdoptionError("history_adoption_invalid");
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function historyAdoptionPoolFingerprint(protocolFingerprint, accountOpaqueIds) {
    if (!(0, types_1.isFingerprint)(protocolFingerprint) || protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT)
        throw invalid();
    if (accountOpaqueIds.length < 2 || accountOpaqueIds.some((account) => !(0, types_1.isOpaqueAccountId)(account)))
        throw invalid();
    const sorted = [...accountOpaqueIds].sort();
    if (new Set(sorted).size !== sorted.length)
        throw invalid();
    return sha256(canonicalJson({ protocolFingerprint, accountOpaqueIds: sorted }));
}
function historyAdoptionIntentFingerprint(intent) {
    const { hmac: _hmac, ...payload } = intent;
    return sha256(canonicalJson(payload));
}
function historyAdoptionThreadOwnersFingerprint(threadIds, legacyOwnerOpaqueAccountId) {
    const sorted = canonicalThreadIds(threadIds);
    if (!(0, types_1.isOpaqueAccountId)(legacyOwnerOpaqueAccountId))
        throw invalid();
    return sha256(canonicalJson(sorted.map((threadId) => ({ threadId, opaqueAccountId: legacyOwnerOpaqueAccountId }))));
}
function parseHistoryAdoptionIntent(bytes) {
    const raw = parseBounded(bytes, exports.HISTORY_ADOPTION_MAX_ARTIFACT_BYTES);
    if (!(0, types_1.isPlainRecord)(raw) || !hasExactKeys(raw, [
        "schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "configGeneration", "configFingerprint",
        "legacyOwnerOpaqueAccountId", "createdAt", "hmac",
    ]))
        throw invalid();
    if (raw.schemaVersion !== SCHEMA_VERSION || raw.kind !== "account-router-history-adoption-intent"
        || !(0, types_1.isFingerprint)(raw.protocolFingerprint) || raw.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
        || !(0, types_1.isFingerprint)(raw.poolFingerprint) || !isPositiveInteger(raw.configGeneration)
        || !(0, types_1.isFingerprint)(raw.configFingerprint) || !(0, types_1.isOpaqueAccountId)(raw.legacyOwnerOpaqueAccountId)
        || !isCanonicalUtcTimestamp(raw.createdAt) || !isHmac(raw.hmac))
        throw invalid();
    return {
        schemaVersion: SCHEMA_VERSION, kind: "account-router-history-adoption-intent", protocolFingerprint: raw.protocolFingerprint,
        poolFingerprint: raw.poolFingerprint, configGeneration: raw.configGeneration, configFingerprint: raw.configFingerprint,
        legacyOwnerOpaqueAccountId: raw.legacyOwnerOpaqueAccountId, createdAt: raw.createdAt, hmac: raw.hmac,
    };
}
function parseHistoryAdoptionOwners(bytes) {
    const raw = parseBounded(bytes, exports.HISTORY_ADOPTION_MAX_OWNERS_BYTES);
    if (!(0, types_1.isPlainRecord)(raw) || !hasExactKeys(raw, [
        "schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "legacyOwnerOpaqueAccountId", "threadIds",
        "threadOwnersFingerprint", "adoptedAt", "hmac",
    ]))
        throw invalid();
    if (raw.schemaVersion !== SCHEMA_VERSION || raw.kind !== "account-router-history-adoption-owners"
        || !(0, types_1.isFingerprint)(raw.protocolFingerprint) || raw.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
        || !(0, types_1.isFingerprint)(raw.poolFingerprint) || !(0, types_1.isOpaqueAccountId)(raw.legacyOwnerOpaqueAccountId)
        || !Array.isArray(raw.threadIds) || !(0, types_1.isFingerprint)(raw.threadOwnersFingerprint)
        || !isCanonicalUtcTimestamp(raw.adoptedAt) || !isHmac(raw.hmac))
        throw invalid();
    const threadIds = canonicalThreadIds(raw.threadIds);
    if (canonicalJson(threadIds) !== canonicalJson(raw.threadIds)
        || raw.threadOwnersFingerprint !== historyAdoptionThreadOwnersFingerprint(threadIds, raw.legacyOwnerOpaqueAccountId))
        throw invalid();
    return {
        schemaVersion: SCHEMA_VERSION, kind: "account-router-history-adoption-owners", protocolFingerprint: raw.protocolFingerprint,
        poolFingerprint: raw.poolFingerprint, legacyOwnerOpaqueAccountId: raw.legacyOwnerOpaqueAccountId,
        threadIds, threadOwnersFingerprint: raw.threadOwnersFingerprint, adoptedAt: raw.adoptedAt, hmac: raw.hmac,
    };
}
function parseHistoryAdoptionReceipt(bytes) {
    const raw = parseBounded(bytes, exports.HISTORY_ADOPTION_MAX_ARTIFACT_BYTES);
    if (!(0, types_1.isPlainRecord)(raw) || !hasExactKeys(raw, [
        "schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "intentFingerprint", "legacyOwnerOpaqueAccountId",
        "sourceFingerprint", "destinationFingerprint", "databases", "histories", "importedThreadCount",
        "threadOwnersFingerprint", "backupFingerprint", "adoptedAt", "hmac",
    ]))
        throw invalid();
    const importedThreadCount = raw.importedThreadCount;
    if (raw.schemaVersion !== SCHEMA_VERSION || raw.kind !== "account-router-history-adoption-receipt"
        || !(0, types_1.isFingerprint)(raw.protocolFingerprint) || raw.protocolFingerprint !== types_1.ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
        || !(0, types_1.isFingerprint)(raw.poolFingerprint) || !(0, types_1.isFingerprint)(raw.intentFingerprint)
        || !(0, types_1.isOpaqueAccountId)(raw.legacyOwnerOpaqueAccountId) || !(0, types_1.isFingerprint)(raw.sourceFingerprint)
        || !(0, types_1.isFingerprint)(raw.destinationFingerprint) || !Array.isArray(raw.databases) || !Array.isArray(raw.histories)
        || !isNonNegativeInteger(importedThreadCount)
        || !(0, types_1.isFingerprint)(raw.threadOwnersFingerprint) || !(0, types_1.isFingerprint)(raw.backupFingerprint)
        || !isCanonicalUtcTimestamp(raw.adoptedAt) || !isHmac(raw.hmac))
        throw invalid();
    const databases = parseDatabases(raw.databases);
    const histories = parseHistories(raw.histories);
    return {
        schemaVersion: SCHEMA_VERSION, kind: "account-router-history-adoption-receipt", protocolFingerprint: raw.protocolFingerprint,
        poolFingerprint: raw.poolFingerprint, intentFingerprint: raw.intentFingerprint,
        legacyOwnerOpaqueAccountId: raw.legacyOwnerOpaqueAccountId, sourceFingerprint: raw.sourceFingerprint,
        destinationFingerprint: raw.destinationFingerprint, databases, histories, importedThreadCount,
        threadOwnersFingerprint: raw.threadOwnersFingerprint, backupFingerprint: raw.backupFingerprint,
        adoptedAt: raw.adoptedAt, hmac: raw.hmac,
    };
}
function verifyHistoryAdoptionIntent(intent, secret) {
    return verifyHmac(intent, secret, parseHistoryAdoptionIntent);
}
function verifyHistoryAdoptionOwners(owners, secret) {
    return verifyHmac(owners, secret, parseHistoryAdoptionOwners);
}
function verifyHistoryAdoptionReceipt(receipt, secret) {
    return verifyHmac(receipt, secret, parseHistoryAdoptionReceipt);
}
/**
 * Validates immutable offline evidence against the active v2 intent and the
 * strict durable owner state. It deliberately accepts later non-historical
 * thread owner growth; only the signed manifest subset is required here.
 */
function validateHistoryAdoptionEvidence(config, state, secret, raw) {
    try {
        if (secret.byteLength !== 32)
            return { ok: false, reason: "history_adoption_invalid" };
        const intent = parseHistoryAdoptionIntent(raw.intent);
        const owners = parseHistoryAdoptionOwners(raw.owners);
        const receipt = parseHistoryAdoptionReceipt(raw.receipt);
        if (!verifyHistoryAdoptionIntent(intent, secret) || !verifyHistoryAdoptionOwners(owners, secret) || !verifyHistoryAdoptionReceipt(receipt, secret)) {
            return { ok: false, reason: "history_adoption_hmac_invalid" };
        }
        const poolFingerprint = matchingAdoptionPoolFingerprint(config, intent.poolFingerprint);
        if (!poolFingerprint)
            return { ok: false, reason: "history_adoption_config_mismatch" };
        // The signed intent remains an immutable description of the original
        // offline adoption. Once its receipt exists, later v2 pending intent may
        // change mode, primary, generation, or config fingerprint while retaining
        // the exact protocol, two-account pool, and selected history owner.
        if (intent.protocolFingerprint !== config.protocolFingerprint || intent.poolFingerprint !== poolFingerprint
            || !config.accounts.some((account) => account.opaqueAccountId === intent.legacyOwnerOpaqueAccountId)) {
            return { ok: false, reason: "history_adoption_config_mismatch" };
        }
        if (owners.protocolFingerprint !== config.protocolFingerprint || owners.poolFingerprint !== poolFingerprint
            || owners.legacyOwnerOpaqueAccountId !== intent.legacyOwnerOpaqueAccountId
            || receipt.protocolFingerprint !== config.protocolFingerprint || receipt.poolFingerprint !== poolFingerprint
            || receipt.legacyOwnerOpaqueAccountId !== intent.legacyOwnerOpaqueAccountId
            || receipt.intentFingerprint !== historyAdoptionIntentFingerprint(intent)
            || receipt.adoptedAt !== owners.adoptedAt || receipt.importedThreadCount !== owners.threadIds.length
            || receipt.threadOwnersFingerprint !== owners.threadOwnersFingerprint) {
            return { ok: false, reason: "history_adoption_config_mismatch" };
        }
        for (const threadId of owners.threadIds) {
            if (state.threadOwners[threadId] !== owners.legacyOwnerOpaqueAccountId)
                return { ok: false, reason: "history_adoption_state_mismatch" };
            const pending = state.pendingThreadOwners[threadId];
            if (pending !== undefined && pending !== owners.legacyOwnerOpaqueAccountId)
                return { ok: false, reason: "history_adoption_state_mismatch" };
        }
        return { ok: true, evidence: { intent, owners, receipt } };
    }
    catch (error) {
        return { ok: false, reason: error instanceof HistoryAdoptionError ? error.reason : "history_adoption_invalid" };
    }
}
function matchingAdoptionPoolFingerprint(config, expected) {
    const ids = config.accounts.map((account) => account.opaqueAccountId);
    const complete = historyAdoptionPoolFingerprint(config.protocolFingerprint, ids);
    if (complete === expected)
        return complete;
    for (let left = 0; left < ids.length; left += 1) {
        for (let right = left + 1; right < ids.length; right += 1) {
            const candidate = historyAdoptionPoolFingerprint(config.protocolFingerprint, [ids[left], ids[right]]);
            if (candidate === expected)
                return candidate;
        }
    }
    return null;
}
/**
 * Startup only checks artifact shape and private ownership; replaying hashes
 * would both be expensive and invalidate ordinary future history writes.
 */
function validateHistoryAdoptionArtifacts(receipt, ownerCodexHome, ownerSqliteHome) {
    try {
        for (const database of receipt.databases) {
            const path = (0, node_path_1.join)(ownerSqliteHome, database.name);
            // An adoption record proves that a source artifact was absent; later
            // ordinary child operation may legitimately create it. Present records
            // must remain private regular files, but their bytes naturally change as
            // Codex writes history and SQLite state after adoption.
            if (database.present && !isOwnerPrivateRegular(path))
                return false;
        }
        for (const history of receipt.histories) {
            const path = (0, node_path_1.join)(ownerCodexHome, history.name);
            if (!history.present)
                continue;
            if (history.name === "session_index.jsonl") {
                if (!isOwnerPrivateRegular(path))
                    return false;
            }
            else if (!isOwnerPrivateDirectory(path))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function parseDatabases(value) {
    if (value.length !== DATABASE_NAMES.length)
        throw invalid();
    return value.map((entry, index) => {
        if (!(0, types_1.isPlainRecord)(entry) || !hasExactKeys(entry, ["name", "present", "sha256", "bytes", "integrity"])
            || entry.name !== DATABASE_NAMES[index] || typeof entry.present !== "boolean"
            || !isNonNegativeInteger(entry.bytes) || (entry.present
            ? (!(0, types_1.isFingerprint)(entry.sha256) || entry.integrity !== "ok")
            : (entry.sha256 !== null || entry.bytes !== 0 || entry.integrity !== null)))
            throw invalid();
        return { name: entry.name, present: entry.present, sha256: entry.sha256, bytes: entry.bytes, integrity: entry.integrity };
    });
}
function parseHistories(value) {
    if (value.length !== HISTORY_NAMES.length)
        throw invalid();
    return value.map((entry, index) => {
        if (!(0, types_1.isPlainRecord)(entry) || !hasExactKeys(entry, ["name", "present", "sha256", "bytes", "fileCount"])
            || entry.name !== HISTORY_NAMES[index] || typeof entry.present !== "boolean"
            || !isNonNegativeInteger(entry.bytes) || !isNonNegativeInteger(entry.fileCount)
            || (entry.present ? !(0, types_1.isFingerprint)(entry.sha256) : (entry.sha256 !== null || entry.bytes !== 0 || entry.fileCount !== 0)))
            throw invalid();
        return { name: entry.name, present: entry.present, sha256: entry.sha256, bytes: entry.bytes, fileCount: entry.fileCount };
    });
}
function verifyHmac(value, secret, parser) {
    try {
        if (secret.byteLength !== 32)
            return false;
        // Re-parse to ensure programmatic callers cannot bypass strict fields.
        parser(Buffer.from(JSON.stringify(value), "utf8"));
        const actual = Buffer.from(value.hmac, "utf8");
        const expected = Buffer.from(hmac(secret, withoutHmac(value)), "utf8");
        return actual.byteLength === expected.byteLength && (0, node_crypto_1.timingSafeEqual)(actual, expected);
    }
    catch {
        return false;
    }
}
function hmac(secret, value) {
    return `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update(canonicalJson(value), "utf8").digest("hex")}`;
}
function withoutHmac(value) {
    const { hmac: _hmac, ...payload } = value;
    return payload;
}
function sha256(value) {
    return `sha256:${(0, node_crypto_1.createHash)("sha256").update(value, "utf8").digest("hex")}`;
}
function parseBounded(bytes, maxBytes) {
    const source = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    if (source.byteLength === 0 || source.byteLength > maxBytes)
        throw invalid();
    try {
        return JSON.parse(source.toString("utf8"));
    }
    catch {
        throw invalid();
    }
}
function canonicalThreadIds(value) {
    if (!value.every(isCanonicalUuid))
        throw invalid();
    const sorted = [...value].sort();
    if (sorted.some((threadId, index) => index > 0 && sorted[index - 1] === threadId))
        throw invalid();
    return sorted;
}
function isCanonicalUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function isCanonicalUtcTimestamp(value) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
        return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function isHmac(value) {
    return typeof value === "string" && /^hmac-sha256:[a-f0-9]{64}$/.test(value);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isOwnerPrivateRegular(path) {
    const stat = (0, node_fs_1.lstatSync)(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.()
        && (stat.mode & 0o077) === 0;
}
function isOwnerPrivateDirectory(path) {
    const stat = (0, node_fs_1.lstatSync)(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}
function invalid() {
    return new HistoryAdoptionError("history_adoption_invalid");
}
//# sourceMappingURL=history-adoption.js.map
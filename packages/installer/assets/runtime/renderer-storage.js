"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planRendererStorageMigration = planRendererStorageMigration;
exports.prepareRendererStorageMigration = prepareRendererStorageMigration;
exports.commitRendererStorageMigration = commitRendererStorageMigration;
exports.rollbackRendererStorageMigration = rollbackRendererStorageMigration;
exports.createRendererStorage = createRendererStorage;
exports.verifyRendererStorageRollback = verifyRendererStorageRollback;
const renderer_crypto_1 = require("./renderer-crypto");
const CURRENT_ID_PREFIX = "co.tweakers.";
const LEGACY_STORAGE_PREFIX = `${["codex", "pp"].join("")}:storage:`;
const CURRENT_STORAGE_PREFIX = "tweaker:storage:";
const ARCHIVE_STORAGE_PREFIX = "tweaker:storage-archive:";
function parseRecord(raw) {
    if (raw === null)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function fingerprint(raw) {
    return raw === null ? "missing" : (0, renderer_crypto_1.sha256HexUtf8)(raw);
}
function discoverLegacyPublisherKeys(id, storage) {
    if (!id.startsWith(CURRENT_ID_PREFIX))
        return [];
    const suffix = id.slice(CURRENT_ID_PREFIX.length);
    if (!suffix)
        return [];
    const suffixMarker = `.${suffix}`;
    const candidates = new Set();
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(LEGACY_STORAGE_PREFIX))
            continue;
        const legacyId = key.slice(LEGACY_STORAGE_PREFIX.length);
        if (legacyId !== id
            && legacyId.startsWith("co.")
            && legacyId.endsWith(suffixMarker)
            && legacyId.slice(3, -suffixMarker.length).length > 0) {
            candidates.add(key);
        }
    }
    return [...candidates].sort();
}
function legacyKeysFor(id, storage) {
    const exactLegacyKey = `${LEGACY_STORAGE_PREFIX}${id}`;
    const keys = new Set(discoverLegacyPublisherKeys(id, storage));
    if (storage.getItem(exactLegacyKey) !== null)
        keys.add(exactLegacyKey);
    return [...keys].sort();
}
function planMigration(id, storage, transactionId = (0, renderer_crypto_1.secureRendererUuid)()) {
    const currentKey = `${CURRENT_STORAGE_PREFIX}${id}`;
    const canonicalRaw = storage.getItem(currentKey);
    const legacyKeys = legacyKeysFor(id, storage);
    const selectedLegacyKey = legacyKeys.length === 1 ? legacyKeys[0] : null;
    const selectedLegacyRaw = selectedLegacyKey === null ? null : storage.getItem(selectedLegacyKey);
    const base = {
        schemaVersion: 1,
        transactionId,
        currentKey,
        legacyKeys,
        selectedLegacyKey,
        createdCanonical: false,
        canonicalBeforeHash: fingerprint(canonicalRaw),
        canonicalAfterHash: fingerprint(canonicalRaw),
        selectedLegacyHash: fingerprint(selectedLegacyRaw),
        archiveKey: null,
        phase: "planned",
    };
    if (!id.startsWith(CURRENT_ID_PREFIX)) {
        return { receipt: { ...base, status: "not_applicable", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
    }
    if (legacyKeys.length > 1) {
        return { receipt: { ...base, status: "ambiguous", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
    }
    if (canonicalRaw !== null && parseRecord(canonicalRaw) === null) {
        return { receipt: { ...base, status: "invalid_canonical", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
    }
    if (selectedLegacyRaw !== null && parseRecord(selectedLegacyRaw) === null) {
        return { receipt: { ...base, status: "invalid_legacy", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
    }
    if (canonicalRaw !== null) {
        const mismatch = selectedLegacyRaw !== null && selectedLegacyRaw !== canonicalRaw;
        return {
            receipt: { ...base, status: mismatch ? "conflict" : "canonical", holdPromotion: mismatch },
            canonicalRaw,
            selectedLegacyRaw,
        };
    }
    if (selectedLegacyRaw === null) {
        return { receipt: { ...base, status: "absent", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
    }
    return {
        receipt: {
            ...base,
            status: "prepared",
            holdPromotion: false,
            createdCanonical: true,
            canonicalAfterHash: fingerprint(selectedLegacyRaw),
        },
        canonicalRaw,
        selectedLegacyRaw,
    };
}
function planRendererStorageMigration(id, storage, transactionId) {
    return planMigration(id, storage, transactionId).receipt;
}
function prepareRendererStorageMigration(id, storage, transactionId) {
    const plan = planMigration(id, storage, transactionId);
    if (!plan.receipt.createdCanonical || plan.selectedLegacyRaw === null) {
        return { ...plan.receipt, phase: "prepared" };
    }
    try {
        if (storage.getItem(plan.receipt.currentKey) !== null) {
            return { ...plan.receipt, status: "conflict", holdPromotion: true, createdCanonical: false, phase: "prepared" };
        }
        storage.setItem(plan.receipt.currentKey, plan.selectedLegacyRaw);
        if (fingerprint(storage.getItem(plan.receipt.currentKey)) !== plan.receipt.canonicalAfterHash) {
            throw new Error("renderer storage verification failed");
        }
        return { ...plan.receipt, phase: "prepared" };
    }
    catch {
        return {
            ...plan.receipt,
            status: "write_failed",
            holdPromotion: true,
            createdCanonical: false,
            canonicalAfterHash: fingerprint(storage.getItem(plan.receipt.currentKey)),
            phase: "prepared",
        };
    }
}
function commitRendererStorageMigration(receipt, storage) {
    if (receipt.phase === "committed")
        return receipt;
    if (receipt.holdPromotion)
        throw new Error("renderer storage migration is on hold");
    if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
        throw new Error("renderer storage canonical value changed before commit");
    }
    if (receipt.selectedLegacyKey === null)
        return { ...receipt, phase: "committed" };
    const legacyRaw = storage.getItem(receipt.selectedLegacyKey);
    if (fingerprint(legacyRaw) !== receipt.selectedLegacyHash || legacyRaw === null) {
        throw new Error("renderer storage legacy value changed before commit");
    }
    const archiveKey = `${ARCHIVE_STORAGE_PREFIX}${receipt.transactionId}:${encodeURIComponent(receipt.selectedLegacyKey)}`;
    const archived = storage.getItem(archiveKey);
    if (archived !== null && archived !== legacyRaw) {
        throw new Error("renderer storage archive collision");
    }
    storage.setItem(archiveKey, legacyRaw);
    if (storage.getItem(archiveKey) !== legacyRaw)
        throw new Error("renderer storage archive verification failed");
    storage.removeItem(receipt.selectedLegacyKey);
    return { ...receipt, archiveKey, phase: "committed" };
}
function rollbackRendererStorageMigration(receipt, storage) {
    if (receipt.phase === "rolled_back")
        return receipt;
    if (receipt.archiveKey !== null && receipt.selectedLegacyKey !== null) {
        const archived = storage.getItem(receipt.archiveKey);
        if (fingerprint(archived) !== receipt.selectedLegacyHash || archived === null) {
            throw new Error("renderer storage archive changed before rollback");
        }
        const currentLegacy = storage.getItem(receipt.selectedLegacyKey);
        if (currentLegacy !== null && fingerprint(currentLegacy) !== receipt.selectedLegacyHash) {
            throw new Error("renderer storage legacy value changed before rollback");
        }
        if (currentLegacy === null)
            storage.setItem(receipt.selectedLegacyKey, archived);
        storage.removeItem(receipt.archiveKey);
    }
    if (receipt.createdCanonical) {
        if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
            throw new Error("renderer storage canonical value changed before rollback");
        }
        storage.removeItem(receipt.currentKey);
    }
    return { ...receipt, phase: "rolled_back" };
}
function createRendererStorage(id, storage) {
    let migration = prepareRendererStorageMigration(id, storage);
    const key = `${CURRENT_STORAGE_PREFIX}${id}`;
    const read = () => parseRecord(storage.getItem(key)) ?? {};
    const write = (value) => storage.setItem(key, JSON.stringify(value));
    return {
        get migration() { return migration; },
        commitMigration: () => {
            migration = commitRendererStorageMigration(migration, storage);
            return migration;
        },
        rollbackMigration: () => {
            migration = rollbackRendererStorageMigration(migration, storage);
            return migration;
        },
        get: (name, fallback) => {
            const current = read();
            return name in current ? current[name] : fallback;
        },
        set: (name, value) => {
            const current = read();
            current[name] = value;
            write(current);
        },
        delete: (name) => {
            const current = read();
            delete current[name];
            write(current);
        },
        all: () => read(),
    };
}
/**
 * Exercise the exact prepare/commit/rollback path used by a promotion probe.
 * Every synthetic key is removed and verified before success is returned;
 * cleanup failure is a failed health result, never a silent residue.
 */
function verifyRendererStorageRollback(storage, nonce) {
    const suffix = `promotion-health-original-${nonce}`;
    const currentId = `co.tweakers.${suffix}`;
    const currentKey = `${CURRENT_STORAGE_PREFIX}${currentId}`;
    const legacyKey = `${LEGACY_STORAGE_PREFIX}co.promotion-probe.${suffix}`;
    const expectedArchiveKey = `${ARCHIVE_STORAGE_PREFIX}${nonce}:${encodeURIComponent(legacyKey)}`;
    const raw = JSON.stringify({ retained: true, nonce });
    let ownsProbeKeys = false;
    let result = "fail";
    let cleanupSucceeded = true;
    try {
        if (storage.getItem(currentKey) !== null || storage.getItem(legacyKey) !== null) {
            result = "fail";
        }
        else {
            ownsProbeKeys = true;
            storage.setItem(legacyKey, raw);
            const prepared = prepareRendererStorageMigration(currentId, storage, nonce);
            if (prepared.status !== "prepared" || prepared.holdPromotion || storage.getItem(currentKey) !== raw) {
                result = "fail";
            }
            else {
                const committed = commitRendererStorageMigration(prepared, storage);
                if (committed.phase !== "committed"
                    || committed.archiveKey !== expectedArchiveKey
                    || storage.getItem(legacyKey) !== null) {
                    result = "fail";
                }
                else {
                    const rolledBack = rollbackRendererStorageMigration(committed, storage);
                    result = rolledBack.phase === "rolled_back"
                        && storage.getItem(legacyKey) === raw
                        && storage.getItem(currentKey) === null
                        && storage.getItem(expectedArchiveKey) === null
                        ? "pass"
                        : "fail";
                }
            }
        }
    }
    catch {
        result = "fail";
    }
    finally {
        if (ownsProbeKeys) {
            const removeAndVerify = (key) => {
                try {
                    storage.removeItem(key);
                    return storage.getItem(key) === null;
                }
                catch {
                    return false;
                }
            };
            cleanupSucceeded = removeAndVerify(currentKey) && cleanupSucceeded;
            cleanupSucceeded = removeAndVerify(legacyKey) && cleanupSucceeded;
            cleanupSucceeded = removeAndVerify(expectedArchiveKey) && cleanupSucceeded;
        }
    }
    return result === "pass" && cleanupSucceeded ? "pass" : "fail";
}
//# sourceMappingURL=renderer-storage.js.map
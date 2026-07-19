"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRendererStorage = createRendererStorage;
const CURRENT_ID_PREFIX = "co.tweakers.";
const LEGACY_STORAGE_PREFIX = `${["codex", "pp"].join("")}:storage:`;
const CURRENT_STORAGE_PREFIX = "tweaker:storage:";
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
function discoverLegacyPublisherKey(id, storage) {
    if (!id.startsWith(CURRENT_ID_PREFIX))
        return null;
    const suffix = id.slice(CURRENT_ID_PREFIX.length);
    if (!suffix)
        return null;
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
    return candidates.size === 1 ? [...candidates][0] : null;
}
function createRendererStorage(id, storage) {
    const key = `${CURRENT_STORAGE_PREFIX}${id}`;
    const legacyCurrentIdKey = `${LEGACY_STORAGE_PREFIX}${id}`;
    const read = () => {
        const current = parseRecord(storage.getItem(key));
        const legacyCurrentId = parseRecord(storage.getItem(legacyCurrentIdKey));
        const legacyPublisherKey = discoverLegacyPublisherKey(id, storage);
        const legacyPublisher = legacyPublisherKey === null
            ? null
            : parseRecord(storage.getItem(legacyPublisherKey));
        const legacyKeys = [
            legacyCurrentId === null ? null : legacyCurrentIdKey,
            legacyPublisher === null ? null : legacyPublisherKey,
        ].filter((candidate) => candidate !== null);
        if (legacyKeys.length === 0)
            return current ?? {};
        const merged = {
            ...(legacyPublisher ?? {}),
            ...(legacyCurrentId ?? {}),
            ...(current ?? {}),
        };
        try {
            storage.setItem(key, JSON.stringify(merged));
        }
        catch {
            return merged;
        }
        for (const legacyKey of legacyKeys)
            storage.removeItem(legacyKey);
        return merged;
    };
    const write = (value) => storage.setItem(key, JSON.stringify(value));
    return {
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
//# sourceMappingURL=renderer-storage.js.map
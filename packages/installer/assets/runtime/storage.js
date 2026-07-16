"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDiskStorage = createDiskStorage;
exports.removeLegacyModeSwitcherState = removeLegacyModeSwitcherState;
/**
 * Disk-backed key/value storage for main-process tweaks.
 *
 * Each tweak gets one JSON file under `<userRoot>/storage/<id>.json`.
 * Writes are debounced (50 ms) and atomic (write to <file>.tmp then rename).
 * Reads are eager + cached in-memory; we load on first access.
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const FLUSH_DELAY_MS = 50;
function createDiskStorage(rootDir, id) {
    const dir = (0, node_path_1.join)(rootDir, "storage");
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    const file = (0, node_path_1.join)(dir, `${sanitize(id)}.json`);
    let data = {};
    if ((0, node_fs_1.existsSync)(file)) {
        try {
            data = JSON.parse((0, node_fs_1.readFileSync)(file, "utf8"));
        }
        catch {
            // Corrupt file — start fresh, but don't clobber the original until we
            // successfully write again. (Move it aside for forensics.)
            try {
                (0, node_fs_1.renameSync)(file, `${file}.corrupt-${Date.now()}`);
            }
            catch { }
            data = {};
        }
    }
    let dirty = false;
    let timer = null;
    const scheduleFlush = () => {
        dirty = true;
        if (timer)
            return;
        timer = setTimeout(() => {
            timer = null;
            if (dirty)
                flush();
        }, FLUSH_DELAY_MS);
    };
    const flush = () => {
        if (!dirty)
            return;
        const tmp = `${file}.tmp`;
        try {
            (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(data, null, 2), "utf8");
            (0, node_fs_1.renameSync)(tmp, file);
            dirty = false;
        }
        catch (e) {
            // Leave dirty=true so a future flush retries.
            console.error("[codex-plusplus] storage flush failed:", id, e);
        }
    };
    return {
        get: (k, d) => Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d,
        set(k, v) {
            data[k] = v;
            scheduleFlush();
        },
        delete(k) {
            if (k in data) {
                delete data[k];
                scheduleFlush();
            }
        },
        all: () => ({ ...data }),
        flush,
    };
}
function sanitize(id) {
    // Tweak ids are author-controlled; clamp to a safe filename.
    return id.replace(/[^a-zA-Z0-9._@-]/g, "_");
}
/**
 * One-time migration (2026-07): the retired `mode-switcher` tweak persisted a
 * soft app mode under the `modeState` key, where `"vanilla"` suppressed
 * loading every other tweak. Real mode switching is now a bundle swap owned
 * by the installer (`tweakers mode <chatgpt|tweakers>`), and this injected
 * runtime only ever executes inside the patched (Tweakers) bundle — so a
 * stale persisted "vanilla" must never gate tweak loading again. Dropping the
 * key is the entire migration: nothing reads it anymore, and absence always
 * meant "tweakers". The storage file is removed once it holds nothing else.
 */
function removeLegacyModeSwitcherState(rootDir) {
    const file = (0, node_path_1.join)(rootDir, "storage", "co.tweakers.mode-switcher.json");
    try {
        if (!(0, node_fs_1.existsSync)(file))
            return;
        const data = JSON.parse((0, node_fs_1.readFileSync)(file, "utf8"));
        if (!Object.prototype.hasOwnProperty.call(data, "modeState"))
            return;
        delete data.modeState;
        if (Object.keys(data).length === 0) {
            (0, node_fs_1.rmSync)(file, { force: true });
            return;
        }
        const tmp = `${file}.tmp`;
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(data, null, 2), "utf8");
        (0, node_fs_1.renameSync)(tmp, file);
    }
    catch {
        // Best-effort: a corrupt or unreadable legacy file cannot gate anything —
        // no runtime code path reads modeState anymore.
    }
}
//# sourceMappingURL=storage.js.map
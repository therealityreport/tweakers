"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverTweaks = discoverTweaks;
/**
 * Discover tweaks under <userRoot>/tweaks. Each tweak is a directory with a
 * manifest.json and an entry script. Entry resolution is manifest.main first,
 * then index.js, index.mjs, and index.cjs.
 *
 * The manifest gate is intentionally strict. A tweak must identify its GitHub
 * repository so the manager can check releases without granting the tweak an
 * update/install channel. Update checks are advisory only.
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"];
function discoverTweaks(tweaksDir) {
    if (!(0, node_fs_1.existsSync)(tweaksDir))
        return [];
    const out = [];
    for (const name of (0, node_fs_1.readdirSync)(tweaksDir).sort((a, b) => a.localeCompare(b))) {
        const dir = (0, node_path_1.join)(tweaksDir, name);
        if (!(0, node_fs_1.statSync)(dir).isDirectory())
            continue;
        const manifestPath = (0, node_path_1.join)(dir, "manifest.json");
        if (!(0, node_fs_1.existsSync)(manifestPath))
            continue;
        let manifest;
        try {
            manifest = JSON.parse((0, node_fs_1.readFileSync)(manifestPath, "utf8"));
        }
        catch {
            continue;
        }
        if (!isValidManifest(manifest))
            continue;
        const entry = resolveEntry(dir, manifest);
        if (!entry)
            continue;
        out.push({ dir, entry, manifest });
    }
    return out;
}
function isValidManifest(m) {
    if (!m.id || !m.name || !m.version || !m.githubRepo)
        return false;
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(m.githubRepo))
        return false;
    if (m.scope && !["renderer", "main", "both"].includes(m.scope))
        return false;
    return true;
}
function resolveEntry(dir, m) {
    if (m.main) {
        const p = (0, node_path_1.join)(dir, m.main);
        return (0, node_fs_1.existsSync)(p) ? p : null;
    }
    for (const c of ENTRY_CANDIDATES) {
        const p = (0, node_path_1.join)(dir, c);
        if ((0, node_fs_1.existsSync)(p))
            return p;
    }
    return null;
}
//# sourceMappingURL=tweak-discovery.js.map
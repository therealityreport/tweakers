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
const tweakers_sdk_1 = require("@therealityreport/tweakers-sdk");
const ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"];
function discoverTweaks(tweaksDir, options = {}) {
    if (!(0, node_fs_1.existsSync)(tweaksDir))
        return [];
    const out = [];
    for (const name of (0, node_fs_1.readdirSync)(tweaksDir).sort((a, b) => a.localeCompare(b))) {
        const dir = (0, node_path_1.join)(tweaksDir, name);
        // A removed development target can leave a dangling top-level symlink.
        // Treat one unreadable entry as invalid instead of taking every installed
        // tweak offline.
        try {
            if (!(0, node_fs_1.statSync)(dir).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        const manifestPath = (0, node_path_1.join)(dir, "manifest.json");
        if (!(0, node_fs_1.existsSync)(manifestPath))
            continue;
        let value;
        try {
            value = JSON.parse((0, node_fs_1.readFileSync)(manifestPath, "utf8"));
        }
        catch {
            options.onInvalid?.(dir, "manifest is unreadable or invalid JSON");
            continue;
        }
        const validation = (0, tweakers_sdk_1.validateTweakManifest)(value);
        if (!validation.ok) {
            options.onInvalid?.(dir, validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
            continue;
        }
        const manifest = value;
        if (options.runtimeVersion && manifest.minRuntime && !supportsMinimumRuntime(options.runtimeVersion, manifest.minRuntime)) {
            options.onInvalid?.(dir, `requires runtime ${manifest.minRuntime}; current runtime is ${options.runtimeVersion}`);
            continue;
        }
        const entry = resolveEntry(dir, manifest);
        if (!entry) {
            options.onInvalid?.(dir, "entry must be a readable file inside the tweak directory");
            continue;
        }
        out.push({ dir, entry, manifest });
    }
    const counts = new Map();
    for (const tweak of out)
        counts.set(tweak.manifest.id, (counts.get(tweak.manifest.id) ?? 0) + 1);
    return out.filter((tweak) => {
        if (counts.get(tweak.manifest.id) === 1)
            return true;
        options.onInvalid?.(tweak.dir, `duplicate tweak id: ${tweak.manifest.id}`);
        return false;
    });
}
function resolveEntry(dir, m) {
    for (const name of m.main ? [m.main] : ENTRY_CANDIDATES) {
        if ((0, node_path_1.isAbsolute)(name) || name.includes("\\") || name.split("/").includes(".."))
            return null;
        const entry = (0, node_path_1.resolve)(dir, name);
        try {
            const within = (0, node_path_1.relative)((0, node_fs_1.realpathSync)(dir), (0, node_fs_1.realpathSync)(entry));
            if (!within || within === ".." || within.startsWith(`..${node_path_1.sep}`) || (0, node_path_1.isAbsolute)(within))
                return null;
            if ((0, node_fs_1.statSync)(entry).isFile())
                return entry;
        }
        catch { /* Missing or unreadable entries do not poison sibling discovery. */ }
    }
    return null;
}
function supportsMinimumRuntime(current, minimum) {
    const parse = (value) => /^(?:>=\s*)?v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())?.slice(1).map(Number);
    const available = parse(current), required = parse(minimum);
    if (!available || !required)
        return false;
    for (let index = 0; index < 3; index++) {
        if (available[index] !== required[index])
            return available[index] > required[index];
    }
    return true;
}
//# sourceMappingURL=tweak-discovery.js.map
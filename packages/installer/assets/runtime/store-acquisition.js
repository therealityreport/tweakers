"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireStoreTweak = acquireStoreTweak;
exports.validateStoreTweakSource = validateStoreTweakSource;
exports.assertStoreTweakCleanForAutoUpdate = assertStoreTweakCleanForAutoUpdate;
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tweak_store_1 = require("./tweak-store");
const LEGACY_STORE_METADATA = [".codex", "pp-store.json"].join("");
async function acquireStoreTweak(entry, options) {
    const { work, stagedTarget } = options;
    const archive = (0, node_path_1.join)(work, "source.tar.gz"), extractDir = (0, node_path_1.join)(work, "extract");
    let source;
    if (entry.source?.kind === "bundled") {
        // The catalog path is constrained to `tweaks/<id>` by normalization;
        // resolving it here keeps traversal and cross-entry installs closed.
        const bundledPath = entry.source.path;
        if (typeof bundledPath !== "string")
            throw new Error(`bundled source for ${entry.id} is missing a path`);
        source = (0, tweak_store_1.resolveBundledTweakPath)(options.runtimeDir, { ...entry, source: { kind: "bundled", path: bundledPath } });
        if (!(0, node_fs_1.existsSync)(source) || !(0, node_fs_1.statSync)(source).isDirectory()) {
            throw new Error(`bundled source for ${entry.id} is missing from the installer runtime`);
        }
        options.log(`installing bundled tweak ${entry.id} from ${source}`);
    }
    else {
        const url = (0, tweak_store_1.storeArchiveUrl)(entry);
        options.log(`installing store tweak ${entry.id} from ${entry.repo ?? "(unknown)"}@${entry.approvedCommitSha ?? "(unknown)"}`);
        const res = await fetch(url, {
            headers: { "User-Agent": `tweaker/${options.runtimeVersion}` },
            redirect: "follow",
        });
        if (!res.ok)
            throw new Error(`download failed: ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        (0, node_fs_1.writeFileSync)(archive, bytes);
        (0, node_fs_1.mkdirSync)(extractDir, { recursive: true });
        extractTarArchive(archive, extractDir);
        source = findTweakRoot(extractDir) ?? "";
        if (!source)
            throw new Error("downloaded archive did not contain manifest.json");
    }
    validateStoreTweakSource(entry, source);
    (0, node_fs_1.rmSync)(stagedTarget, { recursive: true, force: true });
    copyTweakSource(source, stagedTarget);
    const stagedFiles = hashTweakSource(stagedTarget);
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(stagedTarget, ".tweaker-store.json"), JSON.stringify({
        ...(entry.repo ? { repo: entry.repo } : {}),
        ...(entry.approvedCommitSha ? { approvedCommitSha: entry.approvedCommitSha } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        installedAt: new Date().toISOString(),
        storeIndexUrl: options.storeIndexUrl,
        files: stagedFiles,
    }, null, 2));
}
class StoreTweakModifiedError extends Error {
    constructor(tweakName) {
        super(`${tweakName} has local source changes, so Tweakers can't auto-update it. Revert your local changes or reinstall the tweak manually.`);
        this.name = "StoreTweakModifiedError";
    }
}
function extractTarArchive(archive, targetDir) {
    const result = (0, node_child_process_1.spawnSync)("tar", ["-xzf", archive, "-C", targetDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        throw new Error(`tar extraction failed: ${result.stderr || result.stdout || result.status}`);
    }
}
function validateStoreTweakSource(entry, source) {
    const manifestPath = (0, node_path_1.join)(source, "manifest.json");
    const manifest = JSON.parse((0, node_fs_1.readFileSync)(manifestPath, "utf8"));
    if (manifest.id !== entry.manifest.id) {
        throw new Error(`downloaded tweak id ${manifest.id} does not match approved id ${entry.manifest.id}`);
    }
    const approvedRepo = entry.source?.kind === "remote" ? entry.source.repo : entry.repo;
    if (approvedRepo && manifest.githubRepo !== approvedRepo) {
        throw new Error(`downloaded tweak repo ${manifest.githubRepo} does not match approved repo ${approvedRepo}`);
    }
    if (manifest.version !== entry.manifest.version) {
        throw new Error(`downloaded tweak version ${manifest.version} does not match approved version ${entry.manifest.version}`);
    }
}
function findTweakRoot(dir) {
    if (!(0, node_fs_1.existsSync)(dir))
        return null;
    if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, "manifest.json")))
        return dir;
    for (const name of (0, node_fs_1.readdirSync)(dir)) {
        const child = (0, node_path_1.join)(dir, name);
        try {
            if (!(0, node_fs_1.statSync)(child).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        const found = findTweakRoot(child);
        if (found)
            return found;
    }
    return null;
}
function copyTweakSource(source, target) {
    (0, node_fs_1.cpSync)(source, target, {
        recursive: true,
        filter: (src) => !/(^|[/\\])(?:\.git|node_modules)(?:[/\\]|$)/.test(src),
    });
}
async function assertStoreTweakCleanForAutoUpdate(entry, target, work, runtimeVersion) {
    if (!(0, node_fs_1.existsSync)(target))
        return;
    const metadata = readStoreInstallMetadata(target);
    if (!metadata)
        throw new Error("Cannot replace a tweak without verified installation metadata");
    if (metadata.repo !== entry.repo) {
        throw new StoreTweakModifiedError(entry.manifest.name);
    }
    const currentFiles = hashTweakSource(target);
    const baselineFiles = metadata.files ?? await fetchBaselineStoreTweakHashes(metadata, work, runtimeVersion);
    if (!sameFileHashes(currentFiles, baselineFiles)) {
        throw new StoreTweakModifiedError(entry.manifest.name);
    }
}
function readStoreInstallMetadata(target) {
    const currentPath = (0, node_path_1.join)(target, ".tweaker-store.json");
    const legacyPath = (0, node_path_1.join)(target, LEGACY_STORE_METADATA);
    const metadataPath = (0, node_fs_1.existsSync)(currentPath) ? currentPath : legacyPath;
    if (!(0, node_fs_1.existsSync)(metadataPath))
        return null;
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(metadataPath, "utf8"));
        const bundled = parsed.source?.kind === "bundled";
        if (!bundled && (typeof parsed.repo !== "string" || typeof parsed.approvedCommitSha !== "string"))
            return null;
        return {
            ...(typeof parsed.repo === "string" ? { repo: parsed.repo } : {}),
            ...(typeof parsed.approvedCommitSha === "string" ? { approvedCommitSha: parsed.approvedCommitSha } : {}),
            ...(parsed.source ? { source: parsed.source } : {}),
            installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
            storeIndexUrl: typeof parsed.storeIndexUrl === "string" ? parsed.storeIndexUrl : "",
            files: isHashRecord(parsed.files) ? parsed.files : undefined,
        };
    }
    catch {
        return null;
    }
}
async function fetchBaselineStoreTweakHashes(metadata, work, runtimeVersion) {
    if (!metadata.repo || !metadata.approvedCommitSha) {
        throw new Error("Could not verify local tweak changes before update: source baseline is not remote");
    }
    const baselineDir = (0, node_path_1.join)(work, "baseline");
    const archive = (0, node_path_1.join)(work, "baseline.tar.gz");
    const res = await fetch(`https://codeload.github.com/${metadata.repo}/tar.gz/${metadata.approvedCommitSha}`, {
        headers: { "User-Agent": `tweaker/${runtimeVersion}` },
        redirect: "follow",
    });
    if (!res.ok)
        throw new Error(`Could not verify local tweak changes before update: ${res.status}`);
    (0, node_fs_1.writeFileSync)(archive, Buffer.from(await res.arrayBuffer()));
    (0, node_fs_1.mkdirSync)(baselineDir, { recursive: true });
    extractTarArchive(archive, baselineDir);
    const source = findTweakRoot(baselineDir);
    if (!source)
        throw new Error("Could not verify local tweak changes before update: baseline manifest missing");
    return hashTweakSource(source);
}
function hashTweakSource(root) {
    const out = {};
    collectTweakFileHashes(root, root, out);
    return out;
}
function collectTweakFileHashes(root, dir, out) {
    for (const name of (0, node_fs_1.readdirSync)(dir).sort()) {
        if (name === ".git" || name === "node_modules" || name === ".tweaker-store.json" || name === LEGACY_STORE_METADATA)
            continue;
        const full = (0, node_path_1.join)(dir, name);
        const rel = (0, node_path_1.relative)(root, full).split("\\").join("/");
        const stat = (0, node_fs_1.lstatSync)(full);
        if (stat.isSymbolicLink())
            throw new Error("Cannot verify tweak source through symlinks");
        if (stat.isDirectory()) {
            collectTweakFileHashes(root, full, out);
            continue;
        }
        if (!stat.isFile())
            continue;
        out[rel] = (0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(full)).digest("hex");
    }
}
function sameFileHashes(a, b) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length)
        return false;
    for (let i = 0; i < ak.length; i++) {
        const key = ak[i];
        if (key !== bk[i] || a[key] !== b[key])
            return false;
    }
    return true;
}
function isHashRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    return Object.values(value).every((v) => typeof v === "string");
}
//# sourceMappingURL=store-acquisition.js.map
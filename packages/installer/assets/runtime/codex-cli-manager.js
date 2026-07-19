"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveCodexCliPaths = deriveCodexCliPaths;
exports.validateArchiveEntries = validateArchiveEntries;
exports.createCodexCliManager = createCodexCliManager;
exports.applyManagedCodexCliLaneAtBootstrap = applyManagedCodexCliLaneAtBootstrap;
exports.mutateCodexFeature = mutateCodexFeature;
exports.sha256Buffer = sha256Buffer;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const EMPTY_STATE = { schemaVersion: 1, current: null, previous: null, updatedAt: "" };
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const RECEIPT_FILE = "receipt.json";
const ALLOWED_ASSET = "codex-package-aarch64-apple-darwin.tar.gz";
function deriveCodexCliPaths(home, activeUserRoot) {
    const root = (0, node_path_1.join)(activeUserRoot ?? (0, node_path_1.join)((0, node_path_1.resolve)(home), "Library", "Application Support", "Tweakers"), "codex-cli");
    return { root, releases: (0, node_path_1.join)(root, "releases"), staging: (0, node_path_1.join)(root, "staging"), state: (0, node_path_1.join)(root, "state.json"), lock: (0, node_path_1.join)(root, "operation.lock") };
}
function validateArchiveEntries(entries) {
    if (entries.length === 0)
        throw new Error("Unsafe archive: no entries");
    for (const entry of entries) {
        const normalized = entry.path.replaceAll("\\", "/");
        const segments = normalized.split("/");
        if (!normalized || normalized.includes("\0") || (0, node_path_1.isAbsolute)(normalized) || segments.includes("..")) {
            throw new Error("Unsafe archive path");
        }
        if (!["file", "directory"].includes(entry.type))
            throw new Error("Unsafe archive entry type");
        if (entry.linkPath)
            throw new Error("Unsafe archive link");
    }
}
function createCodexCliManager(input) {
    const paths = deriveCodexCliPaths(input.home, input.userRoot);
    const deps = input.deps;
    let busy = false;
    let state = readState(paths.state);
    let progress = emptyProgress();
    ensureDirectories(paths);
    const manager = {
        async installBeta() {
            return runExclusive("install", async (operationId) => {
                const operationDir = safeChild(paths.staging, operationId);
                const archive = (0, node_path_1.join)(operationDir, "download.tar.gz");
                const extracted = (0, node_path_1.join)(operationDir, "extracted");
                (0, node_fs_1.mkdirSync)(operationDir, { recursive: false, mode: 0o700 });
                try {
                    setProgress("resolving");
                    const release = await deps.resolveRelease();
                    validateRelease(release);
                    progress.version = release.version;
                    setProgress("downloading");
                    const downloaded = await deps.download(release, archive, (bytes) => {
                        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_DOWNLOAD_BYTES)
                            throw new Error("Download exceeds maximum size");
                        progress.bytes = bytes;
                    });
                    progress.bytes = downloaded.bytes;
                    if (downloaded.bytes < 1 || downloaded.bytes > MAX_DOWNLOAD_BYTES)
                        throw new Error("Download length is invalid or exceeds maximum size");
                    setProgress("verifying-digest");
                    if (downloaded.digest.toLowerCase() !== release.digest.toLowerCase())
                        throw new Error("Digest verification failed");
                    const entries = await deps.listArchive(archive);
                    validateArchiveEntries(entries);
                    setProgress("extracting");
                    (0, node_fs_1.mkdirSync)(extracted, { recursive: false, mode: 0o700 });
                    await deps.extractArchive(archive, extracted);
                    const binary = locateBinary(extracted);
                    (0, node_fs_1.chmodSync)(binary, 0o755);
                    setProgress("verifying-signature");
                    if (!(await deps.verifySignature(binary)))
                        throw new Error("Signature verification failed");
                    setProgress("probing");
                    const [version, architecture] = await Promise.all([deps.probeVersion(binary), deps.probeArchitecture(binary)]);
                    if (normalizeVersion(version) !== release.version)
                        throw new Error(`Version validation failed (expected ${release.version})`);
                    if (architecture !== release.architecture)
                        throw new Error(`Architecture validation failed (expected ${release.architecture})`);
                    const baseDirectoryName = `${release.version}-${release.architecture}`;
                    // A reinstall must not replace a directory referenced by the durable
                    // state. Promote into a unique sibling and commit by atomically
                    // swapping the state pointer; pruning happens only after that commit.
                    const directoryName = (0, node_fs_1.existsSync)(safeChild(paths.releases, baseDirectoryName))
                        ? `${baseDirectoryName}-incoming-${safeOperationId(operationId)}`
                        : baseDirectoryName;
                    const releaseDir = safeChild(paths.releases, directoryName);
                    const binaryRelativePath = (0, node_path_1.relative)(extracted, binary);
                    const receipt = {
                        schemaVersion: 1,
                        version: release.version,
                        releaseTag: release.tag,
                        digest: release.digest.toLowerCase(),
                        binaryDigest: (0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(binary)).digest("hex"),
                        architecture: release.architecture,
                        relativeDirectory: directoryName,
                        binaryRelativePath,
                        verifiedAt: deps.now().toISOString(),
                    };
                    atomicJsonWrite((0, node_path_1.join)(extracted, RECEIPT_FILE), receipt);
                    syncTreeCritical(extracted, [binaryRelativePath, RECEIPT_FILE]);
                    setProgress("promoting");
                    if ((0, node_fs_1.existsSync)(releaseDir))
                        throw new Error("Unique incoming release directory already exists");
                    deps.onCrashPoint?.("before-release-rename");
                    (0, node_fs_1.renameSync)(extracted, releaseDir);
                    fsyncDirectory(paths.releases);
                    deps.onCrashPoint?.("after-release-rename");
                    const next = { schemaVersion: 1, current: receipt, previous: state.current, updatedAt: deps.now().toISOString() };
                    deps.onCrashPoint?.("before-state-write");
                    atomicJsonWrite(paths.state, next);
                    state = next;
                    deps.onCrashPoint?.("after-state-write");
                    pruneUnreferencedReleases(paths, state);
                    return clone(state);
                }
                finally {
                    (0, node_fs_1.rmSync)(operationDir, { recursive: true, force: true });
                }
            });
        },
        async rollbackBeta() {
            return runExclusive("rollback", async () => {
                setProgress("rolling-back");
                const previous = state.previous;
                if (!previous)
                    throw new Error("No previous managed Beta is available");
                const validation = await validateReceiptAsync(paths, previous, deps);
                if (!validation.valid)
                    throw new Error(validation.error ?? "Previous managed Beta is invalid");
                const next = { schemaVersion: 1, current: previous, previous: state.current, updatedAt: deps.now().toISOString() };
                atomicJsonWrite(paths.state, next);
                state = next;
                return clone(state);
            });
        },
        recover() {
            ensureDirectories(paths);
            removeDirectoryChildrenWithoutFollowing(paths.staging);
            // Operations are in-process and bounded. Clear an abandoned lock only
            // after staging cleanup; never steal one owned by another live process.
            if (!lockBelongsToLiveOtherProcess(paths.lock))
                (0, node_fs_1.rmSync)(paths.lock, { force: true });
            state = readState(paths.state);
            state = reconcileStateSync(paths, state);
            atomicJsonWrite(paths.state, state);
            pruneUnreferencedReleases(paths, state);
            return clone(state);
        },
        getState: () => clone(state),
        getProgress: () => clone(progress),
        getSelectedBinary: () => state.current ? binaryForReceipt(paths, state.current) : null,
        async validateCurrent() {
            if (!state.current)
                return { valid: false, binary: null, error: "No managed Beta is installed" };
            const result = await validateReceiptAsync(paths, state.current, deps);
            return { ...result, binary: result.valid ? binaryForReceipt(paths, state.current) : null };
        },
        listManagedVersions: () => safeDirectoryNames(paths.releases).map((name) => readReceipt((0, node_path_1.join)(paths.releases, name))?.version).filter((value) => Boolean(value)),
        listStagingOperations: () => safeDirectoryNames(paths.staging),
    };
    function setProgress(phase) { progress.phase = phase; }
    async function runExclusive(kind, fn) {
        if (busy)
            throw new Error("A Codex CLI operation is already in progress");
        busy = true;
        const operationId = deps.operationId();
        progress = { operationId, phase: kind === "install" ? "resolving" : "rolling-back", bytes: 0, version: null, error: null, startedAt: deps.now().toISOString(), completedAt: null };
        let lockFd = null;
        let ownsLock = false;
        try {
            try {
                lockFd = (0, node_fs_1.openSync)(paths.lock, "wx", 0o600);
                ownsLock = true;
                (0, node_fs_1.writeFileSync)(lockFd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, operationId, kind, startedAt: progress.startedAt })}\n`);
                (0, node_fs_1.fsyncSync)(lockFd);
            }
            catch (error) {
                if (lockFd !== null)
                    (0, node_fs_1.closeSync)(lockFd);
                lockFd = null;
                throw (0, node_fs_1.existsSync)(paths.lock) ? new Error("A Codex CLI operation is already in progress") : error;
            }
            const result = await fn(operationId);
            progress.phase = "complete";
            progress.completedAt = deps.now().toISOString();
            return result;
        }
        catch (error) {
            progress.phase = "failed";
            progress.error = safeError(error);
            progress.completedAt = deps.now().toISOString();
            throw new Error(progress.error);
        }
        finally {
            if (lockFd !== null)
                (0, node_fs_1.closeSync)(lockFd);
            if (ownsLock)
                (0, node_fs_1.rmSync)(paths.lock, { force: true });
            busy = false;
        }
    }
    return manager;
}
function applyManagedCodexCliLaneAtBootstrap(input) {
    const env = input.env ?? process.env;
    if (input.lane == null) {
        const hasOverride = Boolean(env.CODEX_CLI_PATH);
        return { requestedLane: null, effectiveLane: hasOverride ? "beta" : "bundled", binary: hasOverride ? env.CODEX_CLI_PATH : null, userOverridePreserved: hasOverride, fallback: false, error: null };
    }
    if (input.lane === "bundled") {
        delete env.CODEX_CLI_PATH;
        return { requestedLane: "bundled", effectiveLane: "bundled", binary: null, userOverridePreserved: false, fallback: false, error: null };
    }
    if (input.selectedManagedCli) {
        const selected = input.selectedManagedCli;
        const validation = (input.validateSelectedManagedBinary ?? validateSelectedManagedBinarySync)(selected);
        if (validation.valid) {
            env.CODEX_CLI_PATH = selected.binaryPath;
            return {
                requestedLane: "beta",
                effectiveLane: "beta",
                binary: selected.binaryPath,
                userOverridePreserved: false,
                fallback: false,
                error: null,
            };
        }
        delete env.CODEX_CLI_PATH;
        const error = safeError(validation.error ?? "Selected managed Alpha validation failed");
        input.persistFailure?.(error);
        return {
            requestedLane: "beta",
            effectiveLane: "bundled",
            binary: null,
            userOverridePreserved: false,
            fallback: true,
            error,
        };
    }
    const paths = deriveCodexCliPaths(input.home, input.userRoot);
    const state = readState(paths.state);
    const receipt = state.current;
    const binary = receipt ? binaryForReceipt(paths, receipt) : "";
    const validation = receipt
        ? (input.validateManagedBinary ?? ((candidate, current) => validateManagedBinarySync(paths, candidate, current)))(binary, receipt)
        : { valid: false, error: "No managed Beta is installed" };
    if (validation.valid) {
        env.CODEX_CLI_PATH = binary;
        return { requestedLane: "beta", effectiveLane: "beta", binary, userOverridePreserved: false, fallback: false, error: null };
    }
    delete env.CODEX_CLI_PATH;
    const error = safeError(validation.error ?? "Managed Beta validation failed");
    input.persistFailure?.(error);
    return { requestedLane: "beta", effectiveLane: "bundled", binary: null, userOverridePreserved: false, fallback: true, error };
}
function validateSelectedManagedBinarySync(selected) {
    try {
        if (!(0, node_path_1.isAbsolute)(selected.binaryPath) || (0, node_path_1.resolve)(selected.binaryPath) !== selected.binaryPath) {
            throw new Error("Selected managed Alpha path is not exact and absolute");
        }
        if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(selected.version)) {
            throw new Error("Selected managed Alpha version is invalid");
        }
        if (!/^[a-f0-9]{64}$/i.test(selected.fingerprint)) {
            throw new Error("Selected managed Alpha fingerprint is invalid");
        }
        const info = (0, node_fs_1.lstatSync)(selected.binaryPath);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
            throw new Error("Selected managed Alpha binary is not a regular executable file");
        }
        const actualFingerprint = (0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(selected.binaryPath)).digest("hex");
        if (actualFingerprint !== selected.fingerprint.toLowerCase()) {
            throw new Error("Selected managed Alpha fingerprint does not match");
        }
        if (process.platform === "darwin") {
            (0, node_child_process_1.execFileSync)("/usr/bin/codesign", ["--verify", "--deep", "--strict", selected.binaryPath], {
                stdio: "pipe",
                timeout: 5_000,
            });
            (0, node_child_process_1.execFileSync)("/usr/bin/codesign", [
                "-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"",
                "--verify",
                selected.binaryPath,
            ], { stdio: "pipe", timeout: 5_000 });
            const architecture = (0, node_child_process_1.execFileSync)("/usr/bin/file", ["-b", selected.binaryPath], {
                encoding: "utf8",
                timeout: 5_000,
            });
            if (!/arm64|aarch64/i.test(architecture))
                throw new Error("Selected managed Alpha architecture is invalid");
        }
        const version = (0, node_child_process_1.execFileSync)(selected.binaryPath, ["--version"], {
            encoding: "utf8",
            timeout: 5_000,
            maxBuffer: 64 * 1024,
        });
        if (normalizeVersion(version) !== selected.version) {
            throw new Error("Selected managed Alpha version does not match");
        }
        return { valid: true };
    }
    catch (error) {
        return { valid: false, error: safeError(error) };
    }
}
async function mutateCodexFeature(input, deps) {
    if ((input.lane !== "bundled" && input.lane !== "beta") || typeof input.enabled !== "boolean" || !/^[A-Za-z0-9_-]+$/.test(input.name))
        throw new Error("Invalid feature mutation request");
    const before = await deps.inventory(input.lane);
    const feature = before.find((entry) => entry.name === input.name);
    if (!feature)
        throw new Error("Feature is not reported by the selected CLI");
    if (feature.stage === "deprecated" || feature.stage === "removed")
        throw new Error("Feature is read-only in the selected CLI");
    await deps.execFile(deps.binaryPath?.(input.lane) ?? input.lane, ["features", input.enabled ? "enable" : "disable", input.name], { timeout: 5_000, shell: false });
    return deps.inventory(input.lane);
}
function ensureDirectories(paths) {
    (0, node_fs_1.mkdirSync)(paths.releases, { recursive: true, mode: 0o700 });
    (0, node_fs_1.mkdirSync)(paths.staging, { recursive: true, mode: 0o700 });
}
function validateRelease(release) {
    if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(release.version))
        throw new Error("Resolved release is not an alpha prerelease");
    if (release.tag !== `rust-v${release.version}`)
        throw new Error("Release tag does not match version");
    if (release.assetName !== ALLOWED_ASSET || !release.assetUrl.startsWith("https://github.com/openai/codex/releases/"))
        throw new Error("Release asset is not allowlisted");
    if (!/^[a-fA-F0-9]{64}$/.test(release.digest))
        throw new Error("Release digest is not SHA-256");
    if (release.architecture !== "aarch64-apple-darwin")
        throw new Error("Release architecture is not allowlisted");
}
function locateBinary(root) {
    const matches = [];
    const visit = (dir) => {
        for (const entry of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true })) {
            const path = (0, node_path_1.join)(dir, entry.name);
            if (entry.isSymbolicLink())
                throw new Error("Extracted package contains an unsafe link");
            if (entry.isDirectory())
                visit(path);
            else if (entry.isFile() && entry.name === "codex")
                matches.push(path);
        }
    };
    visit(root);
    if (matches.length !== 1)
        throw new Error("Extracted package must contain exactly one codex binary");
    return matches[0];
}
async function validateReceiptAsync(paths, receipt, deps) {
    try {
        const binary = binaryForReceipt(paths, receipt);
        validateReceiptFiles(paths, receipt, binary);
        if (!(await deps.verifySignature(binary)))
            throw new Error("Signature verification failed");
        const [version, architecture] = await Promise.all([deps.probeVersion(binary), deps.probeArchitecture(binary)]);
        if (normalizeVersion(version) !== receipt.version)
            throw new Error("Version validation failed");
        if (architecture !== receipt.architecture)
            throw new Error("Architecture validation failed");
        return { valid: true };
    }
    catch (error) {
        return { valid: false, error: safeError(error) };
    }
}
function validateManagedBinarySync(paths, binary, receipt) {
    try {
        validateReceiptFiles(paths, receipt, binary);
        if (process.platform === "darwin") {
            (0, node_child_process_1.execFileSync)("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary], { stdio: "pipe", timeout: 5_000 });
            (0, node_child_process_1.execFileSync)("/usr/bin/codesign", ["-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"", "--verify", binary], { stdio: "pipe", timeout: 5_000 });
            const architecture = (0, node_child_process_1.execFileSync)("/usr/bin/file", ["-b", binary], { encoding: "utf8", timeout: 5_000 });
            if (!/arm64|aarch64/i.test(architecture))
                throw new Error("Architecture validation failed");
        }
        const version = (0, node_child_process_1.execFileSync)(binary, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
        if (normalizeVersion(version) !== receipt.version)
            throw new Error("Version validation failed");
        return { valid: true };
    }
    catch (error) {
        return { valid: false, error: safeError(error) };
    }
}
function validateReceiptFiles(paths, receipt, binary) {
    if (!validReceipt(receipt))
        throw new Error("Managed Beta receipt is invalid");
    const releaseDir = safeChild(paths.releases, receipt.relativeDirectory);
    if (!isContained(releaseDir, binary))
        throw new Error("Managed Beta binary escapes its release directory");
    const diskReceipt = readReceipt(releaseDir);
    if (!diskReceipt
        || diskReceipt.version !== receipt.version
        || diskReceipt.digest !== receipt.digest
        || diskReceipt.binaryDigest !== receipt.binaryDigest
        || diskReceipt.relativeDirectory !== receipt.relativeDirectory
        || diskReceipt.binaryRelativePath !== receipt.binaryRelativePath) {
        throw new Error("Managed Beta receipt or digest does not agree with state");
    }
    const info = (0, node_fs_1.lstatSync)(binary);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0)
        throw new Error("Managed Beta binary is not a regular executable file");
    const binaryDigest = (0, node_crypto_1.createHash)("sha256").update((0, node_fs_1.readFileSync)(binary)).digest("hex");
    if (binaryDigest !== receipt.binaryDigest)
        throw new Error("Managed Beta binary digest does not agree with its receipt");
}
function reconcileStateSync(paths, value) {
    const valid = (receipt) => {
        if (!receipt)
            return false;
        try {
            validateReceiptFiles(paths, receipt, binaryForReceipt(paths, receipt));
            return true;
        }
        catch {
            return false;
        }
    };
    const current = valid(value.current) ? value.current : null;
    const previous = valid(value.previous) && value.previous.relativeDirectory !== current?.relativeDirectory ? value.previous : null;
    return { schemaVersion: 1, current, previous, updatedAt: value.updatedAt };
}
function readState(path) {
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (parsed.schemaVersion !== 1)
            return clone(EMPTY_STATE);
        return { schemaVersion: 1, current: validReceipt(parsed.current) ? parsed.current : null, previous: validReceipt(parsed.previous) ? parsed.previous : null, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
    }
    catch {
        return clone(EMPTY_STATE);
    }
}
function readReceipt(directory) {
    try {
        const info = (0, node_fs_1.lstatSync)((0, node_path_1.join)(directory, RECEIPT_FILE));
        if (!info.isFile() || info.isSymbolicLink())
            return null;
        const value = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(directory, RECEIPT_FILE), "utf8"));
        return validReceipt(value) ? value : null;
    }
    catch {
        return null;
    }
}
function validReceipt(value) {
    if (!value || typeof value !== "object")
        return false;
    const receipt = value;
    return receipt.schemaVersion === 1 && typeof receipt.version === "string" && typeof receipt.releaseTag === "string" && /^[a-f0-9]{64}$/i.test(receipt.digest ?? "") && /^[a-f0-9]{64}$/i.test(receipt.binaryDigest ?? "") && receipt.architecture === "aarch64-apple-darwin" && typeof receipt.relativeDirectory === "string" && (0, node_path_1.basename)(receipt.relativeDirectory) === receipt.relativeDirectory && typeof receipt.binaryRelativePath === "string" && !(0, node_path_1.isAbsolute)(receipt.binaryRelativePath) && !receipt.binaryRelativePath.split(/[\\/]/).includes("..") && typeof receipt.verifiedAt === "string";
}
function binaryForReceipt(paths, receipt) {
    return safeChild(safeChild(paths.releases, receipt.relativeDirectory), receipt.binaryRelativePath);
}
function pruneUnreferencedReleases(paths, state) {
    const keep = new Set([state.current?.relativeDirectory, state.previous?.relativeDirectory].filter((value) => Boolean(value)));
    for (const name of safeDirectoryNames(paths.releases))
        if (!keep.has(name))
            (0, node_fs_1.rmSync)(safeChild(paths.releases, name), { recursive: true, force: true });
}
function safeDirectoryNames(root) {
    try {
        return (0, node_fs_1.readdirSync)(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
    }
    catch {
        return [];
    }
}
function removeDirectoryChildrenWithoutFollowing(root) {
    let names;
    try {
        names = (0, node_fs_1.readdirSync)(root);
    }
    catch {
        return;
    }
    for (const name of names)
        (0, node_fs_1.rmSync)(safeChild(root, name), { recursive: true, force: true });
}
function lockBelongsToLiveOtherProcess(path) {
    try {
        const value = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (!Number.isInteger(value.pid) || value.pid <= 0 || value.pid === process.pid)
            return false;
        process.kill(value.pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function safeChild(root, child) {
    const candidate = (0, node_path_1.resolve)(root, child);
    if (!isContained((0, node_path_1.resolve)(root), candidate) || candidate === (0, node_path_1.resolve)(root))
        throw new Error("Managed path escapes its root");
    return candidate;
}
function isContained(root, candidate) { return candidate.startsWith(`${root}${node_path_1.sep}`); }
function atomicJsonWrite(path, value) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const fd = (0, node_fs_1.openSync)(temporary, "wx", 0o600);
    try {
        (0, node_fs_1.writeFileSync)(fd, `${JSON.stringify(value, null, 2)}\n`);
        (0, node_fs_1.fsyncSync)(fd);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
    (0, node_fs_1.renameSync)(temporary, path);
    fsyncDirectory((0, node_path_1.dirname)(path));
}
function syncTreeCritical(root, paths) {
    for (const relativePath of paths) {
        const fd = (0, node_fs_1.openSync)(safeChild(root, relativePath), "r");
        try {
            (0, node_fs_1.fsyncSync)(fd);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
    }
    fsyncDirectory(root);
}
function fsyncDirectory(path) {
    const fd = (0, node_fs_1.openSync)(path, "r");
    try {
        (0, node_fs_1.fsyncSync)(fd);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
function normalizeVersion(output) { return output.trim().replace(/^codex-cli\s+/, ""); }
function safeOperationId(value) {
    const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
    if (!safe)
        throw new Error("Operation id is invalid");
    return safe;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function emptyProgress() { return { operationId: null, phase: "idle", bytes: 0, version: null, error: null, startedAt: null, completedAt: null }; }
function safeError(error) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/(?:\/[\w .+@=-]+){2,}/g, "[managed path]").replace(/https?:\/\/\S+/g, "[release URL]").slice(0, 500) || "Codex CLI operation failed";
}
// Useful for injected download implementations that stream chunks.
function sha256Buffer(chunks) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    for (const chunk of chunks)
        hash.update(chunk);
    return hash.digest("hex");
}
//# sourceMappingURL=codex-cli-manager.js.map
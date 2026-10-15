"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCEPTANCE_TWEAK_IDS = exports.ACCEPTANCE_CONFIG_ENV = void 0;
exports.runRuntimeDiagnosticDiskOperation = runRuntimeDiagnosticDiskOperation;
exports.resolveAcceptanceConfig = resolveAcceptanceConfig;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
exports.ACCEPTANCE_CONFIG_ENV = "TWEAKERS_ACCEPTANCE_CONFIG_FILE";
exports.ACCEPTANCE_TWEAK_IDS = [
    "co.tweakers.developer-tools", "co.tweakers.followup", "co.tweakers.usage-limit-resets-tracker",
];
const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail() { throw new Error("Acceptance configuration is invalid or changed; acceptance must stop"); }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const digest = (bytes) => (0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex");
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** Acceptance diagnostics stay in memory. No diagnostic descendant is a sink,
 * even when a valid acceptance directory contains a linked diagnostic leaf. */
function runRuntimeDiagnosticDiskOperation(acceptance, operation) {
    if (acceptance) {
        acceptance.read();
        return undefined;
    }
    return operation();
}
/** The override changes settings only: no data-root, account, or backend routing. */
function resolveAcceptanceConfig(input) {
    const requested = (input.environment ?? process.env)[exports.ACCEPTANCE_CONFIG_ENV];
    if (requested === undefined)
        return null;
    if (!input.derivedVariant || input.healthCheckOnly || !requested
        || !(0, node_path_1.isAbsolute)(input.userRoot) || (0, node_path_1.resolve)(input.userRoot) !== input.userRoot
        || !(0, node_path_1.isAbsolute)(requested) || (0, node_path_1.resolve)(requested) !== requested)
        fail();
    const parts = (0, node_path_1.relative)((0, node_path_1.join)(input.userRoot, "acceptance"), requested).split(/[\\/]/);
    if (parts.length !== 2 || !UUID.test(parts[0]) || parts[1] !== "config.json")
        fail();
    const canonicalPath = (0, node_path_1.join)(input.userRoot, "config.json");
    const directory = (0, node_path_1.dirname)(requested);
    const parents = [input.userRoot, (0, node_path_1.join)(input.userRoot, "acceptance"), directory];
    const uid = process.getuid?.();
    if (uid === undefined || node_fs_1.constants.O_NOFOLLOW === undefined)
        fail();
    const parentIdentities = parents.map((path, index) => {
        const stat = (0, node_fs_1.lstatSync)(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (0, node_fs_1.realpathSync)(path) !== path
            || stat.uid !== uid || (index > 0 && (stat.mode & 0o777) !== 0o700))
            fail();
        return stat;
    });
    function checkParents() {
        parents.forEach((path, index) => {
            const stat = (0, node_fs_1.lstatSync)(path);
            if (!sameFile(stat, parentIdentities[index]) || !stat.isDirectory()
                || stat.isSymbolicLink() || stat.uid !== uid || (0, node_fs_1.realpathSync)(path) !== path
                || (index > 0 && (stat.mode & 0o777) !== 0o700))
                fail();
        });
    }
    function openFile(path, writable, identity) {
        checkParents();
        const fd = (0, node_fs_1.openSync)(path, (writable ? node_fs_1.constants.O_RDWR : node_fs_1.constants.O_RDONLY) | node_fs_1.constants.O_NOFOLLOW);
        try {
            const stat = (0, node_fs_1.fstatSync)(fd);
            const named = (0, node_fs_1.lstatSync)(path);
            if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.size > MAX_BYTES
                || named.isSymbolicLink() || !sameFile(stat, named)
                || (identity && !sameFile(stat, identity))
                || (writable && (stat.mode & 0o777) !== 0o600))
                fail();
            checkParents();
            return fd;
        }
        catch (error) {
            (0, node_fs_1.closeSync)(fd);
            throw error;
        }
    }
    function bytes(fd) {
        const stat = (0, node_fs_1.fstatSync)(fd);
        if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1 || stat.uid !== uid)
            fail();
        const result = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < result.length) {
            const count = (0, node_fs_1.readSync)(fd, result, offset, result.length - offset, offset);
            if (!count)
                fail();
            offset += count;
        }
        const after = (0, node_fs_1.fstatSync)(fd);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
            fail();
        return result;
    }
    function parse(value) {
        let config;
        try {
            config = JSON.parse(value.toString("utf8"));
        }
        catch {
            fail();
        }
        if (!record(config))
            fail();
        return config;
    }
    const canonicalFd = openFile(canonicalPath, false);
    let pinnedFd;
    try {
        const canonicalIdentity = (0, node_fs_1.fstatSync)(canonicalFd);
        const canonicalBytes = bytes(canonicalFd);
        const canonicalHash = digest(canonicalBytes);
        const baseline = parse(canonicalBytes);
        // Ordinary configuration migration must finish before this narrow launch.
        if (Object.prototype.hasOwnProperty.call(baseline, ["codex", "Plus", "Plus"].join("")))
            fail();
        if (!record(baseline.tweaks))
            fail();
        for (const id of exports.ACCEPTANCE_TWEAK_IDS) {
            const tweak = baseline.tweaks[id];
            if (!record(tweak) || tweak.enabled !== false)
                fail();
        }
        pinnedFd = openFile(requested, true);
        const sink = pinnedFd;
        const identity = (0, node_fs_1.fstatSync)(sink);
        if (sameFile(identity, canonicalIdentity))
            fail();
        let closed = false;
        let invalid = false;
        let rejectedWrites = 0;
        function validate(value) {
            const normalized = JSON.parse(JSON.stringify(value));
            if (!record(normalized) || !record(normalized.tweaks))
                fail();
            for (const id of exports.ACCEPTANCE_TWEAK_IDS) {
                const tweak = normalized.tweaks[id];
                if (!record(tweak) || typeof tweak.enabled !== "boolean")
                    fail();
                tweak.enabled = false;
            }
            if (!(0, node_util_1.isDeepStrictEqual)(normalized, baseline))
                fail();
        }
        function read() {
            if (closed || invalid)
                fail();
            try {
                const currentCanonical = openFile(canonicalPath, false, canonicalIdentity);
                try {
                    const stat = (0, node_fs_1.fstatSync)(currentCanonical);
                    if (stat.mode !== canonicalIdentity.mode || stat.mtimeMs !== canonicalIdentity.mtimeMs
                        || stat.ctimeMs !== canonicalIdentity.ctimeMs || digest(bytes(currentCanonical)) !== canonicalHash)
                        fail();
                }
                finally {
                    (0, node_fs_1.closeSync)(currentCanonical);
                }
                const current = openFile(requested, true, identity);
                try {
                    const value = parse(bytes(current));
                    validate(value);
                    return value;
                }
                finally {
                    (0, node_fs_1.closeSync)(current);
                }
            }
            catch (error) {
                invalid = true;
                throw error;
            }
        }
        read();
        return {
            path: requested, directory, read,
            get rejectedWrites() { return rejectedWrites; },
            write(value) {
                read();
                let content;
                try {
                    content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
                    if (content.length > MAX_BYTES)
                        fail();
                    validate(parse(content));
                }
                catch (error) {
                    rejectedWrites++;
                    throw error;
                }
                const stat = (0, node_fs_1.fstatSync)(sink);
                if (!sameFile(stat, identity) || stat.nlink !== 1 || stat.uid !== uid
                    || !stat.isFile() || (stat.mode & 0o777) !== 0o600)
                    fail();
                // This disposable file deliberately uses the pinned descriptor instead
                // of a path-based rename. A directory swap cannot redirect the write.
                try {
                    let offset = 0;
                    while (offset < content.length) {
                        const count = (0, node_fs_1.writeSync)(sink, content, offset, content.length - offset, offset);
                        if (!count)
                            fail();
                        offset += count;
                    }
                    (0, node_fs_1.ftruncateSync)(sink, content.length);
                    (0, node_fs_1.fsyncSync)(sink);
                    read();
                }
                catch (error) {
                    invalid = true;
                    throw error;
                }
            },
            close() { if (!closed) {
                closed = true;
                (0, node_fs_1.closeSync)(sink);
            } },
        };
    }
    catch (error) {
        if (pinnedFd !== undefined)
            (0, node_fs_1.closeSync)(pinnedFd);
        throw error;
    }
    finally {
        (0, node_fs_1.closeSync)(canonicalFd);
    }
}
//# sourceMappingURL=acceptance-config.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireNativeThreadWriterLease = acquireNativeThreadWriterLease;
exports.proveNativeThreadWriterLease = proveNativeThreadWriterLease;
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
/** Only the reviewed native host can acquire the shared native writer lock. */
function acquireNativeThreadWriterLease(lockDirectory, threadId) {
    if (process.platform !== "darwin" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId))
        return { state: "unavailable" };
    try {
        const directory = (0, node_fs_1.realpathSync)(lockDirectory);
        const stat = (0, node_fs_1.lstatSync)(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 18n) !== 0n)
            return { state: "unavailable" };
        // The broker uses the runtime-local packaged host, never a development
        // checkout, global module path, or caller-selected native executable.
        const host = require((0, node_path_1.join)(__dirname, "..", "native", "tweaker_native_host.node"));
        if (typeof host.acquireNativeThreadWriterLease !== "function")
            return { state: "unavailable" };
        const lease = host.acquireNativeThreadWriterLease(directory, `${threadId}.lock`, String(stat.dev), String(stat.ino));
        return lease ? { state: "ready", lease } : { state: "busy" };
    }
    catch {
        return { state: "unavailable" };
    }
}
/** Prove the fresh target is the sole process holding the prepared lock inode. */
function proveNativeThreadWriterLease(lockDirectory, threadId, identity, targetPid) {
    if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino))
        return false;
    try {
        const directory = (0, node_fs_1.realpathSync)(lockDirectory);
        const file = (0, node_path_1.join)(directory, `${threadId}.lock`);
        const sameFile = () => {
            const stat = (0, node_fs_1.lstatSync)(file, { bigint: true });
            return stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid())
                && (stat.mode & 18n) === 0n && stat.size === 0n
                && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
        };
        const occupied = () => {
            const result = acquireNativeThreadWriterLease(directory, threadId);
            if (result.state === "ready")
                result.lease.release();
            return result.state === "busy";
        };
        if (!sameFile() || !occupied())
            return false;
        // macOS lsof does not expose flock ownership. Require the target to be
        // the only process with this private inode open, in addition to actual
        // nonblocking flock contention. Merely finding the target FD is weaker.
        const result = (0, node_child_process_1.spawnSync)("/usr/sbin/lsof", ["-nP", "-F", "pfinD", "--", file], {
            encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status !== 0 || result.stderr.trim())
            return false;
        let pid = 0;
        let descriptor = null;
        const descriptors = [];
        for (const line of result.stdout.split("\n")) {
            if (line[0] === "p") {
                pid = Number(line.slice(1));
                if (pid !== targetPid)
                    return false;
            }
            if (line[0] === "f") {
                descriptor = { pid };
                descriptors.push(descriptor);
            }
            if (descriptor && line[0] === "D")
                descriptor.dev = BigInt(line.slice(1)).toString();
            if (descriptor && line[0] === "i")
                descriptor.ino = line.slice(1);
            if (descriptor && line[0] === "n")
                descriptor.name = line.slice(1);
        }
        return descriptors.length > 0 && descriptors.every((entry) => entry.pid === targetPid
            && entry.dev === identity.dev && entry.ino === identity.ino && entry.name === file)
            && sameFile() && occupied() && sameFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=native-thread-writer-lease.js.map
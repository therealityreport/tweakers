"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemProcessTreeAccessV1 = void 0;
exports.readProcessIdentitiesV1 = readProcessIdentitiesV1;
exports.captureOwnedRootV1 = captureOwnedRootV1;
exports.captureOwnedTreeV1 = captureOwnedTreeV1;
exports.verifiedSurvivorsV1 = verifiedSurvivorsV1;
exports.signalVerifiedTreeV1 = signalVerifiedTreeV1;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const STARTED = /^(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/;
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const MAX_OWNED_TREE_PROCESSES = 128;
/** A failed or partial census is unknown, never an empty process tree. */
async function readProcessIdentitiesV1(pid, deadlineAt) {
    if (process.platform !== "darwin")
        return null;
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0))
        return null;
    const remainingMs = deadlineAt === undefined ? 2_000 : deadlineAt - Date.now();
    if (remainingMs <= 0)
        return null;
    let output;
    try {
        ({ stdout: output } = await execFileAsync("/bin/ps", pid === undefined
            ? ["-axo", "pid=,ppid=,lstart="] : ["-p", String(pid), "-o", "pid=,ppid=,lstart="], {
            encoding: "utf8", timeout: Math.max(1, Math.floor(Math.min(2_000, remainingMs))), maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        }));
    }
    catch (error) {
        // ps exits 1 when an exact PID has disappeared. Other failures mean an
        // unknown census and must retain broker recovery ownership.
        const failed = error;
        if (pid !== undefined && (failed.code === 1 || failed.code === "1") && !failed.stdout?.trim() && !failed.stderr?.trim())
            return [];
        return null;
    }
    try {
        const rows = [];
        const seen = new Set();
        for (const line of output.split("\n")) {
            if (!line.trim())
                continue;
            const match = STARTED.exec(line.trim());
            if (!match)
                return null;
            const pid = Number(match[1]);
            const ppid = Number(match[2]);
            if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || seen.has(pid))
                return null;
            seen.add(pid);
            rows.push({ pid, ppid, started: match[3] });
        }
        return rows.length > 0 || pid !== undefined ? rows : null;
    }
    catch {
        return null;
    }
}
exports.systemProcessTreeAccessV1 = {
    read: readProcessIdentitiesV1,
    signal(pid, signal) { try {
        process.kill(pid, signal);
        return true;
    }
    catch {
        return false;
    } },
};
function sameIdentity(a, b) {
    return a.pid === b.pid && a.started === b.started;
}
/** The direct child must be observed while still parented to this owner. */
async function captureOwnedRootV1(pid, access, deadlineAt) {
    if (!pid)
        return null;
    const rows = await access.read(pid, deadlineAt);
    return rows?.find(row => row.pid === pid && row.ppid === process.pid) ?? null;
}
/** Transitive descendants are proven from one complete table while the root identity is still present. */
async function captureOwnedTreeV1(root, access, deadlineAt) {
    const rows = await access.read(undefined, deadlineAt);
    if (!rows)
        return null;
    const current = rows.find(row => row.pid === root.pid);
    if (!current || !sameIdentity(current, root) || current.ppid !== process.pid)
        return null;
    const owned = [current];
    const seen = new Set([current.pid]);
    for (let index = 0; index < owned.length; index++) {
        for (const row of rows)
            if (row.ppid === owned[index].pid && !seen.has(row.pid)) {
                seen.add(row.pid);
                owned.push(row);
                if (owned.length > MAX_OWNED_TREE_PROCESSES)
                    return null;
            }
    }
    return owned;
}
/** A reparented descendant may still be signalled, but only with its captured start identity. */
async function verifiedSurvivorsV1(tree, access, deadlineAt) {
    const rows = await access.read(undefined, deadlineAt);
    if (!rows)
        return null;
    const byPid = new Map(rows.map(row => [row.pid, row]));
    return tree.filter(row => {
        const current = byPid.get(row.pid);
        return current && sameIdentity(current, row);
    });
}
/** Signal deepest verified descendants first; unknown or reused identities are left alone. */
async function signalVerifiedTreeV1(tree, access, signal, deadlineAt = Date.now() + 5_000) {
    let signalled = true;
    for (const row of tree.slice().reverse()) {
        if (Date.now() >= deadlineAt)
            return false;
        // Re-read the exact PID immediately before signalling. A table captured
        // before signalling its siblings is insufficient under PID reuse.
        const current = await access.read(row.pid, deadlineAt);
        if (!current)
            return false;
        if (current.some(candidate => sameIdentity(candidate, row)) && !access.signal(row.pid, signal))
            signalled = false;
    }
    return signalled;
}
//# sourceMappingURL=owned-process-tree.js.map
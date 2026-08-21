"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNT_ROUTER_CONTROL_TIMEOUT_MS = exports.ACCOUNT_ROUTER_CONTROL_MAX_FRAME_BYTES = exports.ACCOUNT_ROUTER_CONTROL_SOCKET_FILE = void 0;
exports.startRouterControlSocket = startRouterControlSocket;
exports.routerControlSocketPath = routerControlSocketPath;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_net_1 = require("node:net");
const node_path_1 = require("node:path");
const redaction_1 = require("./redaction");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
exports.ACCOUNT_ROUTER_CONTROL_SOCKET_FILE = "router-control.v1.sock";
exports.ACCOUNT_ROUTER_CONTROL_MAX_FRAME_BYTES = 4 * 1024;
exports.ACCOUNT_ROUTER_CONTROL_TIMEOUT_MS = 2_000;
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 100;
/**
 * Owner-private, local-only status endpoint. One authenticated JSONL request
 * is accepted per Unix connection, so a duplicated frame cannot be replayed
 * within a transport session. The only successful payload is the already
 * redacted status projection.
 */
async function startRouterControlSocket(options) {
    if (options.secret.byteLength !== 32)
        throw new Error("invalid account-router control capability");
    const root = (0, node_path_1.resolve)(options.root);
    (0, state_store_1.ensurePrivateDirectory)(root);
    const socketFileName = options.socketFileName ?? exports.ACCOUNT_ROUTER_CONTROL_SOCKET_FILE;
    if ((0, node_path_1.basename)(socketFileName) !== socketFileName || socketFileName.includes(".."))
        throw new Error("unsafe account-router control socket name");
    const path = routerControlSocketPath(root, socketFileName);
    (0, state_store_1.ensurePrivateDirectory)((0, node_path_1.dirname)(path));
    const maxFrameBytes = options.maxFrameBytes ?? exports.ACCOUNT_ROUTER_CONTROL_MAX_FRAME_BYTES;
    const requestTimeoutMs = options.requestTimeoutMs ?? exports.ACCOUNT_ROUTER_CONTROL_TIMEOUT_MS;
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 256 || maxFrameBytes > 64 * 1024)
        throw new Error("invalid account-router control frame bound");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000)
        throw new Error("invalid account-router control timeout");
    await removeStaleSocket(path);
    const connections = new Set();
    const server = (0, node_net_1.createServer)((socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        socket.setNoDelay(true);
        socket.setTimeout(requestTimeoutMs, () => socket.destroy());
        serveSocket(socket, options.secret, options.status, maxFrameBytes);
    });
    try {
        await listen(server, path);
        // The parent directory is 0700 before bind, preventing traversal while
        // the kernel creates the socket. Tighten the endpoint itself immediately.
        (0, node_fs_1.chmodSync)(path, 0o600);
        assertPrivateSocket(path);
    }
    catch (error) {
        await closeServer(server, connections);
        await removeStaleSocket(path);
        throw error;
    }
    let closed = false;
    return {
        path,
        async close() {
            if (closed)
                return;
            closed = true;
            await closeServer(server, connections);
            await removeStaleSocket(path);
        },
    };
}
/**
 * macOS limits AF_UNIX paths to roughly 104 bytes. The normal account-switcher
 * data root can exceed that, so retain a deterministic logical namespace while
 * locating the endpoint under an owner-private short system-temp directory.
 * The hash contains no credential or provider identity and is not renderer
 * output; T3/T4 can derive the same endpoint from the router data root.
 */
function routerControlSocketPath(root, socketFileName = exports.ACCOUNT_ROUTER_CONTROL_SOCKET_FILE) {
    const rootHash = (0, node_crypto_1.createHash)("sha256").update((0, node_path_1.resolve)(root), "utf8").digest("hex").slice(0, 24);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "local";
    // Do not use os.tmpdir() here: on macOS it commonly expands to a long
    // per-user path that itself consumes most of AF_UNIX's fixed pathname limit.
    // /tmp is the short public alias; its child is immediately re-resolved and
    // verified as an owner-private 0700 directory before listening.
    const path = (0, node_path_1.join)("/tmp", `arc-${uid}`, `${rootHash}-${socketFileName}`);
    if (Buffer.byteLength(path, "utf8") > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES)
        throw new Error("account-router control socket path exceeds platform bound");
    return path;
}
function serveSocket(socket, secret, status, maxFrameBytes) {
    let byteLength = 0;
    let pending = "";
    let terminal = false;
    socket.on("data", (chunk) => {
        if (terminal)
            return;
        byteLength += chunk.byteLength;
        if (byteLength > maxFrameBytes) {
            terminal = true;
            socket.destroy();
            return;
        }
        pending += chunk.toString("utf8");
        const newline = pending.indexOf("\n");
        if (newline < 0)
            return;
        const frame = pending.slice(0, newline);
        const remainder = pending.slice(newline + 1);
        // One frame per connection: a second/replayed frame, including a
        // pipelined one, receives no response and cannot cause a second status.
        if (remainder.trim().length > 0) {
            terminal = true;
            socket.destroy();
            return;
        }
        terminal = true;
        const request = parseRequest(frame, maxFrameBytes);
        pending = "";
        if (!request || !matchesSecret(request.secret, secret)) {
            socket.end();
            return;
        }
        try {
            const projection = status();
            (0, redaction_1.assertRedacted)(projection);
            const response = Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, status: projection }) + "\n");
            if (response.byteLength > maxFrameBytes) {
                socket.destroy();
                return;
            }
            socket.end(response);
        }
        catch {
            // An invalid internal projection is never replaced with a potentially
            // revealing error object.
            socket.destroy();
        }
    });
}
function parseRequest(frame, maxFrameBytes) {
    if (Buffer.byteLength(frame, "utf8") > maxFrameBytes)
        return null;
    try {
        const value = JSON.parse(frame);
        if (!(0, types_1.isPlainRecord)(value))
            return null;
        const keys = Object.keys(value).sort();
        if (keys.length !== 4 || keys.join("\0") !== ["method", "requestId", "secret", "version"].join("\0"))
            return null;
        if (value.version !== 1 || value.method !== "status" || !(0, types_1.isJsonRpcId)(value.requestId) || typeof value.secret !== "string" || value.secret.length > 128)
            return null;
        return { version: 1, requestId: value.requestId, method: "status", secret: value.secret };
    }
    catch {
        return null;
    }
}
function matchesSecret(serialized, secret) {
    const candidate = Buffer.alloc(secret.byteLength);
    let decoded;
    try {
        decoded = Buffer.from(serialized, "base64url");
        if (decoded.byteLength === secret.byteLength && decoded.toString("base64url") === serialized)
            decoded.copy(candidate);
        return (0, node_crypto_1.timingSafeEqual)(candidate, secret);
    }
    finally {
        decoded?.fill(0);
        candidate.fill(0);
    }
}
function assertPrivateSocket(path) {
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error("account-router control socket is not owner-private");
    }
}
async function removeStaleSocket(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return;
    assertPrivateSocket(path);
    if (await socketIsLive(path))
        throw new Error("account-router control socket is already active");
    // The exact owner-private socket was proved inactive. Do not glob or remove
    // any parent directory or other router artifact.
    (0, node_fs_1.unlinkSync)(path);
}
function socketIsLive(path) {
    return new Promise((resolvePromise, reject) => {
        const socket = (0, node_net_1.createConnection)(path);
        let settled = false;
        const finish = (result, error) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            if (error)
                reject(error);
            else
                resolvePromise(result);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", (error) => {
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
                finish(false);
            else
                finish(false, error);
        });
        socket.setTimeout(250, () => finish(false, new Error("account-router control socket probe timed out")));
    });
}
function listen(server, path) {
    return new Promise((resolvePromise, reject) => {
        const onError = (error) => {
            server.removeListener("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(path);
    });
}
async function closeServer(server, connections) {
    for (const socket of connections)
        socket.destroy();
    if (!server.listening)
        return;
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
//# sourceMappingURL=control-socket.js.map
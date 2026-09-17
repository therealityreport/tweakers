"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountsBrokerSocketClientV1 = exports.AccountsBrokerManagerClientV1 = exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS = exports.ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS = exports.ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES = exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES = exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES = exports.ACCOUNTS_BROKER_SECRET_FILE = exports.ACCOUNTS_BROKER_CONTROL_SOCKET_FILE = exports.ACCOUNTS_BROKER_SOCKET_FILE = void 0;
exports.resolveAccountsBrokerRootResolution = resolveAccountsBrokerRootResolution;
exports.resolveAccountsBrokerRoot = resolveAccountsBrokerRoot;
exports.accountsBrokerConfigPath = accountsBrokerConfigPath;
exports.accountsBrokerSocketPath = accountsBrokerSocketPath;
exports.readAccountsBrokerSecret = readAccountsBrokerSecret;
exports.startAccountsBrokerSocket = startAccountsBrokerSocket;
exports.reserveAccountsBrokerSocket = reserveAccountsBrokerSocket;
exports.startBrokerControlSocket = startBrokerControlSocket;
exports.accountsBrokerRootHash = accountsBrokerRootHash;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_net_1 = require("node:net");
const node_path_1 = require("node:path");
const broker_1 = require("./broker");
const control_socket_1 = require("./control-socket");
const redaction_1 = require("./redaction");
const state_store_1 = require("./state-store");
const native_request_1 = require("./native-request");
const types_1 = require("./types");
exports.ACCOUNTS_BROKER_SOCKET_FILE = "accounts-broker.v1.sock";
exports.ACCOUNTS_BROKER_CONTROL_SOCKET_FILE = "broker-control.v1.sock";
exports.ACCOUNTS_BROKER_SECRET_FILE = "control-secret.v1";
exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES = 16 * 1024;
/** Bounded, schema-validated projections may contain the full connection catalog. */
exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES = 1024 * 1024;
/** Only a correlated, validated native response may use this payload plus envelope budget. */
exports.ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES = native_request_1.NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES + 16 * 1024;
exports.ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS = 5_000;
/** A command is never replayed after this owner-private response deadline. */
exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS = 15_000;
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 100;
/**
 * Resolve the only root allowed to own cross-app broker state.  Every desktop
 * must receive the explicit manager-global rendezvous root; deriving from an
 * app-local user root could elect two owners with separate ledgers.
 */
function resolveAccountsBrokerRootResolution(options) {
    const environment = options.environment ?? process.env;
    const primary = environment.TWEAKERS_ACCOUNTS_BROKER_ROOT;
    const compatibility = environment.TWEAKER_ACCOUNTS_BROKER_ROOT;
    const primaryConfigured = primary !== undefined;
    const compatibilityConfigured = compatibility !== undefined;
    if (!primaryConfigured && !compatibilityConfigured)
        return { root: null, configured: false };
    // The aliases are two spellings for the one manager-global rendezvous root.
    // Do not silently choose one alias when they differ, including when one is
    // malformed and the other happens to be valid.
    if (primaryConfigured && compatibilityConfigured && primary !== compatibility) {
        return { root: null, configured: true };
    }
    const explicit = primaryConfigured ? primary : compatibility;
    if (!isCanonicalAccountsBrokerRoot(explicit))
        return { root: null, configured: true };
    return { root: explicit, configured: true };
}
/** Compatibility projection for callers that only need the valid root. */
function resolveAccountsBrokerRoot(options) {
    return resolveAccountsBrokerRootResolution(options).root;
}
function isCanonicalAccountsBrokerRoot(value) {
    return typeof value === "string" && value.length > 0 && (0, node_path_1.isAbsolute)(value) && (0, node_path_1.resolve)(value) === value;
}
function accountsBrokerConfigPath(root) {
    const resolved = assertBrokerRoot(root);
    return (0, node_path_1.join)(resolved, "account-router-config.json");
}
function accountsBrokerSocketPath(root, socketFileName = exports.ACCOUNTS_BROKER_SOCKET_FILE) {
    validateSocketFileName(socketFileName);
    const path = (0, control_socket_1.routerControlSocketPath)(assertBrokerRoot(root), socketFileName);
    if (Buffer.byteLength(path, "utf8") > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES) {
        throw new Error("accounts broker socket path exceeds platform bound");
    }
    return path;
}
/** Read the exact owner-private capability shared by the global broker host. */
function readAccountsBrokerSecret(root) {
    const path = (0, node_path_1.join)(assertBrokerRoot(root), exports.ACCOUNTS_BROKER_SECRET_FILE);
    try {
        if (!(0, node_fs_1.existsSync)(path))
            return null;
        (0, state_store_1.assertPrivateRegularFile)(path, 512);
        const secret = Buffer.from((0, node_fs_1.readFileSync)(path));
        if (secret.byteLength !== 32) {
            secret.fill(0);
            return null;
        }
        return secret;
    }
    catch {
        return null;
    }
}
/**
 * A single owner-private, authenticated broker endpoint.  Each peer must
 * prove a fresh opaque renderer/app-tools session before sending a command.
 * JSONL is bounded and every event remains targeted by the broker itself.
 */
async function startAccountsBrokerSocket(options) {
    const reservation = await reserveAccountsBrokerSocket(options);
    return reservation.activate({ broker: options.broker, mapNativeTargets: options.mapNativeTargets,
        resolveNativeBrowserContext: options.resolveNativeBrowserContext, invokeNativeBrowserRequest: options.invokeNativeBrowserRequest,
        managerExecution: options.managerExecution });
}
/**
 * Bind the owner-election socket before touching any shared broker state.
 * A contender that cannot bind this endpoint has no authority to recover or
 * mutate the shared root.  While reserved, early client connections are
 * closed so their normal bounded retry can find the activated owner.
 */
async function reserveAccountsBrokerSocket(options) {
    if (options.secret.byteLength !== 32)
        throw new Error("invalid accounts broker capability");
    const root = assertBrokerRoot(options.root);
    assertPrivateBrokerRoot(root);
    const socketFileName = options.socketFileName ?? exports.ACCOUNTS_BROKER_SOCKET_FILE;
    const path = accountsBrokerSocketPath(root, socketFileName);
    (0, state_store_1.ensurePrivateDirectory)((0, node_path_1.dirname)(path));
    const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES);
    await removeStaleSocket(path);
    const connections = new Set();
    let activation = null;
    const server = (0, node_net_1.createServer)((socket) => {
        // A peer can disappear after writable was checked but before the OS
        // completes a handshake/event write. Its async error belongs to this
        // connection, including connections arriving before owner activation.
        socket.on("error", () => socket.destroy());
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        socket.setNoDelay(true);
        if (!activation) {
            socket.destroy();
            return;
        }
        serveBrokerPeer(socket, activation.broker, options.secret, maxFrameBytes, activation.mapNativeTargets, activation.resolveNativeBrowserContext, activation.invokeNativeBrowserRequest, activation.managerExecution);
    });
    try {
        await listen(server, path);
        (0, node_fs_1.chmodSync)(path, 0o600);
        assertPrivateSocket(path);
    }
    catch (error) {
        await closeServer(server, connections);
        // Do not unlink here: a concurrent winner may own the path that caused
        // this contender's bind to fail.
        throw error;
    }
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        activation = null;
        await closeServer(server, connections);
        await removeStaleSocket(path);
    };
    return {
        path,
        activate(activated) {
            if (closed || activation)
                throw new Error("accounts broker reservation is unavailable");
            activation = activated;
            return { path, close };
        },
        close,
    };
}
/**
 * One-shot status endpoint.  Its exact successful response is
 * `{version:1,requestId,status:BrokerControlStatusV1}`; malformed or
 * unauthenticated requests receive no status projection.
 */
async function startBrokerControlSocket(options) {
    if (options.secret.byteLength !== 32)
        throw new Error("invalid accounts broker capability");
    const root = assertBrokerRoot(options.root);
    (0, state_store_1.ensurePrivateDirectory)(root);
    const socketFileName = options.socketFileName ?? exports.ACCOUNTS_BROKER_CONTROL_SOCKET_FILE;
    const path = accountsBrokerSocketPath(root, socketFileName);
    (0, state_store_1.ensurePrivateDirectory)((0, node_path_1.dirname)(path));
    const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES);
    await removeStaleSocket(path);
    const connections = new Set();
    const server = (0, node_net_1.createServer)((socket) => {
        socket.on("error", () => socket.destroy());
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        socket.setNoDelay(true);
        serveControlPeer(socket, options.secret, options.status, maxFrameBytes);
    });
    try {
        await listen(server, path);
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
/** Owner-private manager client. Each operation uses one authenticated frame and is never replayed by the transport. */
class AccountsBrokerManagerClientV1 {
    root;
    secret;
    socketFileName;
    maxFrameBytes;
    sockets = new Set();
    closed = false;
    constructor(options) {
        this.root = assertBrokerRoot(options.root);
        if (options.secret.byteLength !== 32)
            throw new Error("invalid accounts broker manager capability");
        this.secret = Buffer.from(options.secret);
        this.socketFileName = options.socketFileName ?? exports.ACCOUNTS_BROKER_SOCKET_FILE;
        this.maxFrameBytes = boundedFrameBytes(options.maxFrameBytes ?? exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES);
    }
    async prepareAuthenticationRecovery(requestId) {
        const request = { version: 1, action: "prepare_auth_recovery", requestId };
        if (!isDoctorExecutionLeaseRequest(request))
            return false;
        return (await this.invoke(request)).status === "recovery_ready";
    }
    async acquireDoctorReviewLease(input) {
        const request = { version: 1, action: "acquire", ...input };
        if (!isDoctorExecutionLeaseRequest(request))
            return managerUnavailable("invalid_request");
        const result = await this.invoke(request);
        return isDoctorExecutionAcquireResult(result) ? result : managerUnavailable("broker_unavailable");
    }
    async markDoctorReviewLeaseDispatched(input) {
        const request = { version: 1, action: "mark_dispatched", ...input };
        if (!isDoctorExecutionLeaseRequest(request))
            return managerUnavailable("invalid_request");
        const result = await this.invoke(request);
        return isDoctorExecutionMarkResult(result) ? result : managerUnavailable("broker_unavailable");
    }
    async settleDoctorReviewLease(input) {
        const request = { version: 1, action: "settle", ...input };
        if (!isDoctorExecutionLeaseRequest(request))
            return managerUnavailable("invalid_request");
        const result = await this.invoke(request);
        return isDoctorExecutionSettleResult(result) ? result : managerUnavailable("broker_unavailable");
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        this.secret.fill(0);
    }
    invoke(request) {
        if (this.closed)
            return Promise.resolve(managerUnavailable("broker_unavailable"));
        const path = accountsBrokerSocketPath(this.root, this.socketFileName);
        return new Promise((resolvePromise) => {
            const socket = (0, node_net_1.createConnection)(path);
            this.sockets.add(socket);
            let buffered = "", bytes = 0, settled = false;
            let timer = null;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                this.sockets.delete(socket);
                socket.destroy();
                resolvePromise(result);
            };
            timer = setTimeout(() => finish(managerUnavailable("broker_unavailable")), exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
            timer.unref();
            socket.once("error", () => finish(managerUnavailable("broker_unavailable")));
            socket.once("close", () => finish(managerUnavailable("broker_unavailable")));
            socket.setEncoding("utf8");
            socket.on("data", (chunk) => {
                bytes += Buffer.byteLength(chunk, "utf8");
                if (bytes > this.maxFrameBytes * 2)
                    return finish(managerUnavailable("broker_unavailable"));
                buffered += chunk;
                const newline = buffered.indexOf("\n");
                if (newline < 0)
                    return;
                if (buffered.slice(newline + 1).trim())
                    return finish(managerUnavailable("broker_unavailable"));
                try {
                    const frame = JSON.parse(buffered.slice(0, newline));
                    if (!isManagerExecutionResultFrame(frame) || frame.requestId !== request.requestId)
                        return finish(managerUnavailable("broker_unavailable"));
                    finish(frame.result);
                }
                catch {
                    finish(managerUnavailable("broker_unavailable"));
                }
            });
            socket.once("connect", () => {
                const frame = { version: 1, kind: "manager-execution", request,
                    proof: doctorExecutionProof(this.secret, request) };
                if (!writeManagerExecutionFrame(socket, frame, this.maxFrameBytes))
                    finish(managerUnavailable("broker_unavailable"));
            });
        });
    }
}
exports.AccountsBrokerManagerClientV1 = AccountsBrokerManagerClientV1;
/**
 * Main-process-only client.  It never retries a command after a connection
 * loss: the owner consumed its request id before execution, so automatic
 * replay could duplicate a handoff or any later mutating operation.
 */
class AccountsBrokerSocketClientV1 {
    options;
    socket = null;
    connecting = null;
    closed = false;
    connected = false;
    pending = new Map();
    pendingNativeMaps = new Map();
    pendingNativeBrowser = new Map();
    pendingNativeBrowserRequests = new Map();
    subscribers = new Set();
    buffered = "";
    byteLength = 0;
    constructor(options) {
        this.options = options;
        if (options.secret.byteLength !== 32)
            throw new Error("invalid accounts broker capability");
        assertBrokerRoot(options.root);
        boundedFrameBytes(options.maxFrameBytes ?? exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES);
    }
    async invoke(envelope) {
        if (this.closed)
            return unavailable(envelope.requestId);
        try {
            await this.ensureConnected();
        }
        catch {
            return unavailable(envelope.requestId);
        }
        const socket = this.socket;
        if (!socket || !this.connected)
            return unavailable(envelope.requestId);
        return new Promise((resolvePromise) => {
            if (this.pending.has(envelope.requestId)) {
                resolvePromise({ version: 1, requestId: envelope.requestId, ok: false, error: { code: "request_replayed", retryable: false } });
                return;
            }
            const timer = setTimeout(() => {
                const pending = this.pending.get(envelope.requestId);
                if (!pending)
                    return;
                this.pending.delete(envelope.requestId);
                pending.resolve(unavailable(envelope.requestId));
            }, exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
            timer.unref();
            this.pending.set(envelope.requestId, { resolve: resolvePromise, timer, nativeScope: nativeRequestScope(envelope) });
            if (!writeFrame(socket, { version: 1, kind: "command", envelope }, this.frameBytes())) {
                const pending = this.pending.get(envelope.requestId);
                this.pending.delete(envelope.requestId);
                if (pending)
                    clearTimeout(pending.timer);
                resolvePromise(unavailable(envelope.requestId));
            }
        });
    }
    /** Runtime-owned exact-ID mapping; it is intentionally not a broker command. */
    async mapNativeTargets(request) {
        if (!isNativeTargetMapRequest(request) || this.closed)
            return nativeUnavailable();
        try {
            await this.ensureConnected();
        }
        catch {
            return nativeUnavailable();
        }
        const socket = this.socket;
        if (!socket || !this.connected)
            return nativeUnavailable();
        const requestId = `native-map-${(0, node_crypto_1.randomBytes)(12).toString("base64url")}`;
        return new Promise((resolvePromise) => {
            const timer = setTimeout(() => {
                const pending = this.pendingNativeMaps.get(requestId);
                if (!pending)
                    return;
                this.pendingNativeMaps.delete(requestId);
                pending.resolve(nativeUnavailable());
            }, exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
            timer.unref();
            this.pendingNativeMaps.set(requestId, { resolve: resolvePromise, timer });
            if (!writeOwnerFrame(socket, { version: 1, kind: "native-target-map", requestId, request }, this.frameBytes())) {
                const pending = this.pendingNativeMaps.get(requestId);
                this.pendingNativeMaps.delete(requestId);
                if (pending)
                    clearTimeout(pending.timer);
                resolvePromise(nativeUnavailable());
            }
        });
    }
    async resolveNativeBrowserContext(opaqueAccountId) {
        if (!/^ar_[A-Za-z0-9_-]{16,128}$/.test(opaqueAccountId) || this.closed)
            return nativeBrowserUnavailable();
        try {
            await this.ensureConnected();
        }
        catch {
            return nativeBrowserUnavailable();
        }
        const socket = this.socket;
        if (!socket || !this.connected)
            return nativeBrowserUnavailable();
        const requestId = `native-browser-${(0, node_crypto_1.randomBytes)(12).toString("base64url")}`;
        return new Promise((resolvePromise) => {
            const timer = setTimeout(() => {
                const pending = this.pendingNativeBrowser.get(requestId);
                if (!pending)
                    return;
                this.pendingNativeBrowser.delete(requestId);
                pending.resolve(nativeBrowserUnavailable());
            }, exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
            timer.unref();
            this.pendingNativeBrowser.set(requestId, { resolve: resolvePromise, timer });
            if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context", requestId, opaqueAccountId }, this.frameBytes())) {
                const pending = this.pendingNativeBrowser.get(requestId);
                this.pendingNativeBrowser.delete(requestId);
                if (pending)
                    clearTimeout(pending.timer);
                resolvePromise(nativeBrowserUnavailable());
            }
        });
    }
    async invokeNativeBrowserRequest(opaqueAccountId, method, params) {
        const request = (0, native_request_1.parseNativeBrowserChildRequestV1)(method, params);
        if (!/^ar_[A-Za-z0-9_-]{16,128}$/.test(opaqueAccountId) || !request || this.closed)
            return null;
        try {
            await this.ensureConnected();
        }
        catch {
            return null;
        }
        const socket = this.socket;
        if (!socket || !this.connected)
            return null;
        const requestId = `native-browser-rpc-${(0, node_crypto_1.randomBytes)(12).toString("base64url")}`;
        return new Promise((resolvePromise) => {
            const timer = setTimeout(() => {
                const pending = this.pendingNativeBrowserRequests.get(requestId);
                if (!pending)
                    return;
                this.pendingNativeBrowserRequests.delete(requestId);
                pending.resolve(null);
            }, exports.ACCOUNTS_BROKER_COMMAND_TIMEOUT_MS);
            timer.unref();
            this.pendingNativeBrowserRequests.set(requestId, { resolve: resolvePromise, timer });
            if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-request", requestId, opaqueAccountId, ...request }, this.frameBytes())) {
                const pending = this.pendingNativeBrowserRequests.get(requestId);
                this.pendingNativeBrowserRequests.delete(requestId);
                if (pending)
                    clearTimeout(pending.timer);
                resolvePromise(null);
            }
        });
    }
    subscribe(handler) {
        if (this.closed)
            return () => { };
        this.subscribers.add(handler);
        // Subscription is intentionally non-blocking for the main tweak API. A
        // later invoke reconnects after an unavailable owner; no command is sent
        // here and therefore no mutating action can be replayed.
        void this.ensureConnected().catch(() => { });
        return () => this.subscribers.delete(handler);
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.failPending();
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
        this.subscribers.clear();
    }
    async ensureConnected() {
        if (this.closed)
            throw new Error("accounts broker client is closed");
        if (this.socket && this.connected)
            return;
        if (this.connecting)
            return this.connecting;
        this.connecting = this.open();
        try {
            await this.connecting;
        }
        finally {
            this.connecting = null;
        }
    }
    open() {
        const path = accountsBrokerSocketPath(this.options.root, this.options.socketFileName ?? exports.ACCOUNTS_BROKER_SOCKET_FILE);
        const maxFrameBytes = this.frameBytes();
        return new Promise((resolvePromise, reject) => {
            // A failed connection may have ended in the middle of a JSONL frame.
            // Never let those bytes become a prefix on the next authenticated peer.
            this.buffered = "";
            this.byteLength = 0;
            let settled = false;
            let handshakeTimer = null;
            const socket = (0, node_net_1.createConnection)(path);
            const settle = (error) => {
                if (settled)
                    return;
                settled = true;
                if (handshakeTimer)
                    clearTimeout(handshakeTimer);
                if (error)
                    reject(error);
                else
                    resolvePromise();
            };
            const fail = () => {
                this.connected = false;
                if (this.socket === socket)
                    this.socket = null;
                this.failPending();
                settle(new Error("accounts broker unavailable"));
            };
            socket.setNoDelay(true);
            socket.once("error", () => fail());
            socket.once("close", () => {
                this.connected = false;
                if (this.socket === socket)
                    this.socket = null;
                this.failPending();
                if (!settled)
                    settle(new Error("accounts broker unavailable"));
            });
            socket.setEncoding("utf8");
            socket.on("data", (chunk) => {
                if (this.socket !== socket)
                    return;
                const receiveLimit = [...this.pending.values()].some((pending) => pending.nativeScope !== null)
                    ? exports.ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES : exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES;
                this.consumeFrameChunk(chunk, receiveLimit, (frame, frameBytes) => {
                    if (frameBytes > exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES && (!isBrokerWireFrame(frame) || frame.kind !== "response"
                        || !nativeResponseMatches(frame.response, this.pending.get(frame.response.requestId)?.nativeScope))) {
                        socket.destroy();
                        return;
                    }
                    if (!isBrokerWireFrame(frame)) {
                        if (isNativeTargetResultFrame(frame)) {
                            const pending = this.pendingNativeMaps.get(frame.requestId);
                            if (!pending)
                                return;
                            this.pendingNativeMaps.delete(frame.requestId);
                            clearTimeout(pending.timer);
                            pending.resolve(frame.result);
                            return;
                        }
                        if (isNativeBrowserContextResultFrame(frame)) {
                            const pending = this.pendingNativeBrowser.get(frame.requestId);
                            if (!pending)
                                return;
                            this.pendingNativeBrowser.delete(frame.requestId);
                            clearTimeout(pending.timer);
                            pending.resolve(frame.result);
                            return;
                        }
                        if (isNativeBrowserRequestResultFrame(frame)) {
                            const pending = this.pendingNativeBrowserRequests.get(frame.requestId);
                            if (!pending)
                                return;
                            this.pendingNativeBrowserRequests.delete(frame.requestId);
                            clearTimeout(pending.timer);
                            pending.resolve(frame.result);
                            return;
                        }
                        socket.destroy();
                        return;
                    }
                    if (frame.kind === "handshake-result") {
                        if (!frame.ok) {
                            socket.destroy();
                            settle(new Error("accounts broker rejected client"));
                            return;
                        }
                        this.connected = true;
                        settle();
                        return;
                    }
                    if (frame.kind === "response") {
                        const pending = this.pending.get(frame.response.requestId);
                        if (!pending)
                            return;
                        if (pending.nativeScope && frame.response.ok && !nativeResponseMatches(frame.response, pending.nativeScope)) {
                            socket.destroy();
                            return;
                        }
                        this.pending.delete(frame.response.requestId);
                        clearTimeout(pending.timer);
                        pending.resolve(frame.response);
                        return;
                    }
                    if (frame.kind === "event") {
                        for (const handler of this.subscribers) {
                            try {
                                handler(frame.event);
                            }
                            catch { /* observer isolation */ }
                        }
                    }
                });
            });
            socket.once("connect", () => {
                this.socket = socket;
                const unsigned = {
                    version: 1,
                    clientKind: this.options.clientKind,
                    rendererRef: this.options.rendererRef,
                    appToolsRef: this.options.appToolsRef,
                    nonce: (0, node_crypto_1.randomBytes)(24).toString("base64url"),
                };
                const handshake = {
                    ...unsigned,
                    proof: (0, broker_1.createBrokerHandshakeProof)(this.options.secret, unsigned),
                };
                if (!writeFrame(socket, { version: 1, kind: "handshake", handshake }, maxFrameBytes)) {
                    socket.destroy();
                    return;
                }
                handshakeTimer = setTimeout(() => socket.destroy(), exports.ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS);
                handshakeTimer.unref();
            });
        });
    }
    consumeFrameChunk(chunk, maxFrameBytes, onFrame) {
        const socket = this.socket;
        this.byteLength += Buffer.byteLength(chunk, "utf8");
        if (this.byteLength > maxFrameBytes * 2) {
            this.socket?.destroy();
            return;
        }
        this.buffered += chunk;
        while (true) {
            // A semantic rejection may destroy the socket inside onFrame. Do not
            // dispatch any later frames already buffered from that rejected peer.
            if (!socket || socket.destroyed || this.socket !== socket)
                return;
            const newline = this.buffered.indexOf("\n");
            if (newline < 0)
                return;
            const line = this.buffered.slice(0, newline);
            this.buffered = this.buffered.slice(newline + 1);
            this.byteLength = Buffer.byteLength(this.buffered, "utf8");
            if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
                this.socket?.destroy();
                return;
            }
            try {
                onFrame(JSON.parse(line), Buffer.byteLength(line, "utf8"));
            }
            catch {
                this.socket?.destroy();
                return;
            }
        }
    }
    failPending() {
        for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.resolve(unavailable(requestId));
        }
        this.pending.clear();
        for (const [requestId, pending] of this.pendingNativeMaps) {
            clearTimeout(pending.timer);
            pending.resolve(nativeUnavailable());
        }
        this.pendingNativeMaps.clear();
        for (const [requestId, pending] of this.pendingNativeBrowser) {
            clearTimeout(pending.timer);
            pending.resolve(nativeBrowserUnavailable());
        }
        this.pendingNativeBrowser.clear();
        for (const [, pending] of this.pendingNativeBrowserRequests) {
            clearTimeout(pending.timer);
            pending.resolve(null);
        }
        this.pendingNativeBrowserRequests.clear();
    }
    frameBytes() {
        return boundedFrameBytes(this.options.maxFrameBytes ?? exports.ACCOUNTS_BROKER_MAX_FRAME_BYTES);
    }
}
exports.AccountsBrokerSocketClientV1 = AccountsBrokerSocketClientV1;
function serveBrokerPeer(socket, broker, secret, maxFrameBytes, mapNativeTargets, resolveNativeBrowserContext, invokeNativeBrowserRequest, managerExecution) {
    let buffered = "";
    let byteLength = 0;
    let rendererRef = null;
    let managerRequestConsumed = false;
    let unsubscribe = null;
    let handshakeTimer = setTimeout(() => socket.destroy(), exports.ACCOUNTS_BROKER_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();
    const close = () => {
        if (handshakeTimer)
            clearTimeout(handshakeTimer);
        handshakeTimer = null;
        unsubscribe?.();
        unsubscribe = null;
    };
    socket.once("close", close);
    socket.on("data", (chunk) => {
        if (managerRequestConsumed) {
            socket.destroy();
            return;
        }
        byteLength += chunk.byteLength;
        if (byteLength > maxFrameBytes * 2) {
            socket.destroy();
            return;
        }
        buffered += chunk.toString("utf8");
        while (true) {
            const newline = buffered.indexOf("\n");
            if (newline < 0)
                return;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            byteLength = Buffer.byteLength(buffered, "utf8");
            if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
                socket.destroy();
                return;
            }
            let frame;
            try {
                frame = JSON.parse(line);
            }
            catch {
                socket.destroy();
                return;
            }
            if (!rendererRef) {
                if (isManagerExecutionRequestFrame(frame)) {
                    if (buffered.trim().length > 0 || !managerExecution || !verifyDoctorExecutionProof(secret, frame.request, frame.proof)) {
                        socket.destroy();
                        return;
                    }
                    managerRequestConsumed = true;
                    socket.pause();
                    if (handshakeTimer)
                        clearTimeout(handshakeTimer);
                    handshakeTimer = null;
                    void managerExecution(frame.request).then((result) => {
                        if (!isDoctorExecutionResultForRequest(frame.request, result)
                            || !writeManagerExecutionFrame(socket, { version: 1, kind: "manager-execution-result", requestId: frame.request.requestId, result }, maxFrameBytes)) {
                            socket.destroy();
                            return;
                        }
                        socket.end();
                    }).catch(() => {
                        writeManagerExecutionFrame(socket, { version: 1, kind: "manager-execution-result", requestId: frame.request.requestId,
                            result: managerUnavailable("broker_unavailable") }, maxFrameBytes);
                        socket.end();
                    });
                    return;
                }
                if (!isBrokerHandshakeFrame(frame)) {
                    socket.destroy();
                    return;
                }
                const result = broker.handshake(frame.handshake);
                if (!result.ok) {
                    writeFrame(socket, { version: 1, kind: "handshake-result", ok: false, code: result.code ?? "unauthenticated" }, maxFrameBytes);
                    socket.end();
                    return;
                }
                rendererRef = frame.handshake.rendererRef;
                if (handshakeTimer)
                    clearTimeout(handshakeTimer);
                handshakeTimer = null;
                if (!writeFrame(socket, { version: 1, kind: "handshake-result", ok: true, pool: result.pool }, maxFrameBytes))
                    return;
                unsubscribe = broker.subscribe(rendererRef, (event) => {
                    try {
                        (0, broker_1.assertBrokerRedacted)(event);
                        if (!writeFrame(socket, { version: 1, kind: "event", event }, exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES))
                            socket.destroy();
                    }
                    catch {
                        socket.destroy();
                    }
                });
                continue;
            }
            if (isNativeTargetMapFrame(frame)) {
                const result = mapNativeTargets?.(rendererRef, frame.request) ?? nativeUnavailable();
                if (!writeOwnerFrame(socket, { version: 1, kind: "native-target-result", requestId: frame.requestId, result }, maxFrameBytes))
                    socket.destroy();
                continue;
            }
            if (isNativeBrowserContextFrame(frame)) {
                void (resolveNativeBrowserContext?.(rendererRef, frame.opaqueAccountId) ?? Promise.resolve(nativeBrowserUnavailable())).then((result) => {
                    if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context-result", requestId: frame.requestId, result }, maxFrameBytes))
                        socket.destroy();
                }).catch(() => {
                    if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-context-result", requestId: frame.requestId, result: nativeBrowserUnavailable() }, maxFrameBytes))
                        socket.destroy();
                });
                continue;
            }
            if (isNativeBrowserRequestFrame(frame)) {
                void (invokeNativeBrowserRequest?.(rendererRef, frame.opaqueAccountId, frame.method, frame.params) ?? Promise.resolve(null)).then((result) => {
                    if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-request-result", requestId: frame.requestId, result }, exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES))
                        socket.destroy();
                }).catch(() => {
                    if (!writeOwnerFrame(socket, { version: 1, kind: "native-browser-request-result", requestId: frame.requestId, result: null }, maxFrameBytes))
                        socket.destroy();
                });
                continue;
            }
            if (!isBrokerCommandFrame(frame)) {
                socket.destroy();
                return;
            }
            void broker.invoke(rendererRef, frame.envelope).then((response) => {
                try {
                    if (response.ok)
                        (0, broker_1.assertBrokerCommandResult)(frame.envelope.command, response.result);
                    else
                        (0, broker_1.assertBrokerRedacted)(response);
                    const nativeScope = nativeRequestScope(frame.envelope);
                    if (nativeScope && response.ok && !nativeResponseMatches(response, nativeScope))
                        throw new Error("native response account mismatch");
                    const responseLimit = nativeScope && response.ok ? exports.ACCOUNTS_BROKER_MAX_NATIVE_RESPONSE_FRAME_BYTES : exports.ACCOUNTS_BROKER_MAX_PROJECTION_FRAME_BYTES;
                    if (!writeFrame(socket, { version: 1, kind: "response", response }, responseLimit, frame.envelope.command))
                        socket.destroy();
                }
                catch {
                    socket.destroy();
                }
            });
        }
    });
}
function serveControlPeer(socket, secret, status, maxFrameBytes) {
    let byteLength = 0;
    let buffered = "";
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
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline < 0)
            return;
        const frame = buffered.slice(0, newline);
        const remainder = buffered.slice(newline + 1);
        terminal = true;
        if (remainder.trim().length > 0 || Buffer.byteLength(frame, "utf8") > maxFrameBytes) {
            socket.destroy();
            return;
        }
        const request = parseControlRequest(frame);
        if (!request || !matchesSecret(request.secret, secret)) {
            socket.end();
            return;
        }
        try {
            const projection = status();
            (0, redaction_1.assertRedacted)(projection);
            const response = { version: 1, requestId: request.requestId, status: projection };
            const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
            if (encoded.byteLength > maxFrameBytes) {
                socket.destroy();
                return;
            }
            socket.end(encoded);
        }
        catch {
            socket.destroy();
        }
    });
}
function isBrokerHandshakeFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["handshake", "kind", "version"].join("\0")
        && value.version === 1 && value.kind === "handshake" && (0, types_1.isPlainRecord)(value.handshake);
}
function isBrokerCommandFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["envelope", "kind", "version"].join("\0")
        && value.version === 1 && value.kind === "command" && (0, types_1.isPlainRecord)(value.envelope);
}
function isBrokerWireFrame(value) {
    if (!(0, types_1.isPlainRecord)(value) || value.version !== 1 || typeof value.kind !== "string")
        return false;
    if (value.kind === "handshake-result") {
        return value.ok === true || (value.ok === false && (value.code === "incompatible_client" || value.code === "unauthenticated"));
    }
    if (value.kind === "response")
        return (0, types_1.isPlainRecord)(value.response) && typeof value.response.requestId === "string" && typeof value.response.ok === "boolean";
    if (value.kind === "event")
        return (0, types_1.isPlainRecord)(value.event) && value.event.version === 1 && typeof value.event.sequence === "number" && typeof value.event.type === "string";
    return false;
}
function parseControlRequest(frame) {
    try {
        const value = JSON.parse(frame);
        if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== ["method", "requestId", "secret", "version"].join("\0"))
            return null;
        if (value.version !== 1 || value.method !== "status" || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
            || typeof value.secret !== "string" || value.secret.length > 128)
            return null;
        return { requestId: value.requestId, secret: value.secret };
    }
    catch {
        return null;
    }
}
function nativeRequestScope(envelope) {
    const value = envelope.params;
    if (envelope.command !== "native.request" || !(0, types_1.isPlainRecord)(value)
        || Object.keys(value).sort().join("\0") !== "method\0opaqueAccountId\0params\0surface"
        || typeof value.opaqueAccountId !== "string" || !/^ar_[A-Za-z0-9_-]{43}$/.test(value.opaqueAccountId))
        return null;
    const request = (0, native_request_1.parseNativeRequestV1)({ method: value.method, surface: value.surface, params: value.params });
    return request ? { opaqueAccountId: value.opaqueAccountId, surface: request.surface } : null;
}
function nativeResponseMatches(response, scope) {
    return Boolean(scope && response.ok && (0, types_1.isPlainRecord)(response.result)
        && Object.keys(response.result).sort().join("\0") === "opaqueAccountId\0result\0surface"
        && response.result.opaqueAccountId === scope.opaqueAccountId && response.result.surface === scope.surface
        && (0, native_request_1.isBoundedNativeResultV1)(response.result.result, scope.surface));
}
function writeFrame(socket, frame, maxFrameBytes, command) {
    try {
        // Broker profile projections intentionally carry a strictly masked email
        // (for example `abc***@example.test`); the generic control redactor
        // rejects every @-bearing value. Control status continues to use that
        // generic rule, while authenticated broker frames use the narrow broker
        // exception already enforced by the broker itself. Validated native tool
        // schemas likewise stay response-only: their field names may describe
        // authorization inputs without being account credentials.
        if ((command === "profile.email" || command === "native.request") && frame.kind === "response" && frame.response.ok) {
            (0, broker_1.assertBrokerCommandResult)(command, frame.response.result);
            (0, broker_1.assertBrokerRedacted)({ ...frame, response: { ...frame.response, result: null } });
        }
        else
            (0, broker_1.assertBrokerRedacted)(frame);
        const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
        if (encoded.byteLength > maxFrameBytes)
            return false;
        if (!socket.writable)
            return false;
        socket.write(encoded);
        return true;
    }
    catch {
        return false;
    }
}
function writeOwnerFrame(socket, frame, maxFrameBytes) {
    try {
        if (frame.kind === "native-target-map") {
            if (!isNativeTargetMapRequest(frame.request) || !safeNativeMapRequestId(frame.requestId))
                return false;
        }
        else if (frame.kind === "native-target-result") {
            if (!isNativeTargetMapResult(frame.result) || !safeNativeMapRequestId(frame.requestId))
                return false;
        }
        else if (frame.kind === "native-browser-context") {
            if (!safeNativeMapRequestId(frame.requestId) || !/^ar_[A-Za-z0-9_-]{16,128}$/.test(frame.opaqueAccountId))
                return false;
        }
        else if (frame.kind === "native-browser-context-result") {
            if (!safeNativeMapRequestId(frame.requestId) || !isNativeBrowserContext(frame.result))
                return false;
        }
        else if (frame.kind === "native-browser-request") {
            if (!safeNativeMapRequestId(frame.requestId) || !/^ar_[A-Za-z0-9_-]{16,128}$/.test(frame.opaqueAccountId)
                || !(0, native_request_1.parseNativeBrowserChildRequestV1)(frame.method, frame.params))
                return false;
        }
        else if (frame.kind === "native-browser-request-result") {
            if (!safeNativeMapRequestId(frame.requestId) || !(0, native_request_1.isBoundedNativeResultV1)(frame.result, "plugins"))
                return false;
        }
        else {
            (0, broker_1.assertBrokerRedacted)(frame);
        }
        const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
        if (encoded.byteLength > maxFrameBytes || !socket.writable)
            return false;
        socket.write(encoded);
        return true;
    }
    catch {
        return false;
    }
}
function isNativeTargetMapFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "request", "requestId", "version"].join("\0")
        && value.version === 1 && value.kind === "native-target-map" && safeNativeMapRequestId(value.requestId) && isNativeTargetMapRequest(value.request);
}
function isNativeTargetResultFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0")
        && value.version === 1 && value.kind === "native-target-result" && safeNativeMapRequestId(value.requestId) && isNativeTargetMapResult(value.result);
}
function isNativeBrowserContextFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "opaqueAccountId", "requestId", "version"].join("\0")
        && value.version === 1 && value.kind === "native-browser-context" && safeNativeMapRequestId(value.requestId)
        && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId);
}
function isNativeBrowserContextResultFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0")
        && value.version === 1 && value.kind === "native-browser-context-result" && safeNativeMapRequestId(value.requestId)
        && isNativeBrowserContext(value.result);
}
function isNativeBrowserRequestFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "method", "opaqueAccountId", "params", "requestId", "version"].join("\0")
        && value.version === 1 && value.kind === "native-browser-request" && safeNativeMapRequestId(value.requestId)
        && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId)
        && (0, native_request_1.parseNativeBrowserChildRequestV1)(value.method, value.params) !== null;
}
function isNativeBrowserRequestResultFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["kind", "requestId", "result", "version"].join("\0")
        && value.version === 1 && value.kind === "native-browser-request-result" && safeNativeMapRequestId(value.requestId)
        && (0, native_request_1.isBoundedNativeResultV1)(value.result, "plugins");
}
function isManagerExecutionRequestFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === "kind\0proof\0request\0version"
        && value.version === 1 && value.kind === "manager-execution" && typeof value.proof === "string"
        && /^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(value.proof) && isDoctorExecutionLeaseRequest(value.request);
}
function isManagerExecutionResultFrame(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === "kind\0requestId\0result\0version"
        && value.version === 1 && value.kind === "manager-execution-result" && isDoctorExecutionRequestId(value.requestId)
        && isDoctorExecutionLeaseResult(value.result);
}
function isDoctorExecutionLeaseRequest(value) {
    if (!(0, types_1.isPlainRecord)(value) || value.version !== 1 || !isDoctorExecutionRequestId(value.requestId))
        return false;
    if (value.action === "prepare_auth_recovery")
        return Object.keys(value).sort().join() === "action,requestId,version";
    if (value.action === "acquire")
        return Object.keys(value).sort().join("\0") === "action\0estimatedCost\0purpose\0requestId\0version"
            && value.purpose === "doctor_review" && Number.isSafeInteger(value.estimatedCost) && Number(value.estimatedCost) >= 1 && Number(value.estimatedCost) <= 1_000_000;
    if (value.action === "mark_dispatched")
        return Object.keys(value).sort().join("\0") === "action\0leaseId\0requestId\0version"
            && isDoctorExecutionLeaseId(value.leaseId);
    if (value.action === "settle") {
        const allowed = new Set(["action", "leaseId", "outcome", "requestId", "usage", "version"]);
        if (Object.keys(value).some((key) => !allowed.has(key)) || !isDoctorExecutionLeaseId(value.leaseId)
            || !["pre_dispatch", "completed", "ambiguous"].includes(String(value.outcome)))
            return false;
        if (value.outcome === "completed")
            return isDoctorExecutionUsage(value.usage);
        return value.usage === undefined;
    }
    return false;
}
function isDoctorExecutionLeaseResult(value) {
    return ((0, types_1.isPlainRecord)(value) && value.status === "recovery_ready" && Object.keys(value).join() === "status") || isDoctorExecutionAcquireResult(value) || isDoctorExecutionMarkResult(value) || isDoctorExecutionSettleResult(value);
}
function isDoctorExecutionAcquireResult(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    if (value.status === "unavailable")
        return isManagerUnavailable(value);
    return value.status === "ready" && Object.keys(value).sort().join("\0") === "codexHome\0leaseId\0opaqueAccountId\0status"
        && isDoctorExecutionLeaseId(value.leaseId) && typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value.opaqueAccountId)
        && typeof value.codexHome === "string" && (0, node_path_1.isAbsolute)(value.codexHome) && (0, node_path_1.resolve)(value.codexHome) === value.codexHome;
}
function isDoctorExecutionMarkResult(value) {
    return (0, types_1.isPlainRecord)(value) && (value.status === "unavailable" ? isManagerUnavailable(value)
        : value.status === "dispatched" && Object.keys(value).sort().join("\0") === "leaseId\0status" && isDoctorExecutionLeaseId(value.leaseId));
}
function isDoctorExecutionSettleResult(value) {
    return (0, types_1.isPlainRecord)(value) && (value.status === "unavailable" ? isManagerUnavailable(value)
        : value.status === "settled" && Object.keys(value).sort().join("\0") === "leaseId\0outcome\0status"
            && isDoctorExecutionLeaseId(value.leaseId) && ["pre_dispatch", "completed", "ambiguous"].includes(String(value.outcome)));
}
function isDoctorExecutionResultForRequest(request, result) {
    if ((0, types_1.isPlainRecord)(result) && result.status === "unavailable")
        return isManagerUnavailable(result);
    if (request.action === "prepare_auth_recovery")
        return (0, types_1.isPlainRecord)(result) && result.status === "recovery_ready" && Object.keys(result).join() === "status";
    return request.action === "acquire" ? isDoctorExecutionAcquireResult(result)
        : request.action === "mark_dispatched" ? isDoctorExecutionMarkResult(result)
            : isDoctorExecutionSettleResult(result) && result.status === "settled" && result.outcome === request.outcome;
}
function isManagerUnavailable(value) {
    return Object.keys(value).sort().join("\0") === "reason\0status" && value.status === "unavailable"
        && ["broker_unavailable", "pool_depleted", "quota_unavailable", "binding_unavailable", "request_replayed", "invalid_request"].includes(String(value.reason));
}
function managerUnavailable(reason) {
    return { status: "unavailable", reason };
}
function doctorExecutionProof(secret, request) {
    const normalized = request.action === "prepare_auth_recovery" ? { version: 1, requestId: request.requestId, action: request.action } : request.action === "acquire"
        ? { version: 1, requestId: request.requestId, action: request.action, purpose: request.purpose, estimatedCost: request.estimatedCost }
        : request.action === "mark_dispatched"
            ? { version: 1, requestId: request.requestId, action: request.action, leaseId: request.leaseId }
            : { version: 1, requestId: request.requestId, action: request.action, leaseId: request.leaseId, outcome: request.outcome, ...(request.usage ? { usage: request.usage } : {}) };
    return `hmac-sha256:${(0, node_crypto_1.createHmac)("sha256", secret).update(`manager-execution:v1:${JSON.stringify(normalized)}`, "utf8").digest("base64url")}`;
}
function verifyDoctorExecutionProof(secret, request, proof) {
    try {
        const expected = Buffer.from(doctorExecutionProof(secret, request));
        const actual = Buffer.from(proof);
        return expected.byteLength === actual.byteLength && (0, node_crypto_1.timingSafeEqual)(expected, actual);
    }
    catch {
        return false;
    }
}
function writeManagerExecutionFrame(socket, frame, maxFrameBytes) {
    try {
        if (frame.kind === "manager-execution") {
            if (!isDoctorExecutionLeaseRequest(frame.request) || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(frame.proof))
                return false;
        }
        else if (!isDoctorExecutionRequestId(frame.requestId) || !isDoctorExecutionLeaseResult(frame.result))
            return false;
        const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
        if (encoded.byteLength > maxFrameBytes || !socket.writable)
            return false;
        socket.write(encoded);
        return true;
    }
    catch {
        return false;
    }
}
function isDoctorExecutionRequestId(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isDoctorExecutionLeaseId(value) { return typeof value === "string" && /^rs_[A-Za-z0-9_-]{16,64}$/.test(value); }
function isDoctorExecutionUsage(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === "inputTokens\0outputTokens"
        && Number.isSafeInteger(value.inputTokens) && Number(value.inputTokens) >= 0
        && Number.isSafeInteger(value.outputTokens) && Number(value.outputTokens) >= 0;
}
function isNativeBrowserContext(value) {
    if (!(0, types_1.isPlainRecord)(value) || value.version !== 1)
        return false;
    if (value.status === "unavailable")
        return Object.keys(value).sort().join("\0") === "status\0version";
    if (value.status !== "ready" || Object.keys(value).some((key) => !["appServerVersion", "codexHome", "configFile", "opaqueAccountId", "status", "version"].includes(key)))
        return false;
    return typeof value.opaqueAccountId === "string" && /^ar_[A-Za-z0-9_-]{16,128}$/.test(value.opaqueAccountId)
        && typeof value.codexHome === "string" && (0, node_path_1.isAbsolute)(value.codexHome) && (0, node_path_1.resolve)(value.codexHome) === value.codexHome
        && typeof value.configFile === "string" && value.configFile === (0, node_path_1.join)(value.codexHome, "config.toml")
        && typeof value.appServerVersion === "string" && value.appServerVersion.length > 0 && value.appServerVersion.length <= 128;
}
function isNativeTargetMapRequest(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"].join("\0")
        && value.version === 1 && validNativeTargetId(value.conversationNativeId) && validNativeTargetId(value.composerNativeId)
        && Array.isArray(value.assistantTurnNativeIds) && value.assistantTurnNativeIds.length <= 128 && value.assistantTurnNativeIds.every(validNativeTargetId);
}
function isNativeTargetMapResult(value) {
    return (0, types_1.isPlainRecord)(value) && value.version === 1 && (value.status === "unavailable" ? Object.keys(value).length === 3
        : value.status === "mapped" && typeof value.conversationId === "string" && /^conversation_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId)
            && Array.isArray(value.turnIds) && value.turnIds.length <= 128 && value.turnIds.every((turnId) => typeof turnId === "string" && /^turn_[A-Za-z0-9_-]{16,128}$/.test(turnId)));
}
function nativeUnavailable() { return { version: 1, status: "unavailable" }; }
function nativeBrowserUnavailable() { return { version: 1, status: "unavailable" }; }
function safeNativeMapRequestId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value); }
function validNativeTargetId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function unavailable(requestId) {
    return { version: 1, requestId, ok: false, error: { code: "broker_unavailable", retryable: true } };
}
function assertBrokerRoot(root) {
    if (typeof root !== "string" || !(0, node_path_1.isAbsolute)(root) || (0, node_path_1.resolve)(root) !== root)
        throw new Error("invalid accounts broker root");
    return root;
}
/** Read-only validation for owner election. Election must not chmod or mkdir the shared root. */
function assertPrivateBrokerRoot(root) {
    const stat = (0, node_fs_1.lstatSync)(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error("accounts broker root is not owner-private");
    }
}
function validateSocketFileName(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 48 || value !== value.trim() || /[^A-Za-z0-9._-]/.test(value) || value.includes("..")) {
        throw new Error("unsafe accounts broker socket name");
    }
}
function boundedFrameBytes(value) {
    if (!Number.isInteger(value) || value < 512 || value > 64 * 1024)
        throw new Error("invalid accounts broker frame bound");
    return value;
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
        throw new Error("accounts broker socket is not owner-private");
    }
}
async function removeStaleSocket(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return;
    assertPrivateSocket(path);
    if (await socketIsLive(path))
        throw new Error("accounts broker socket is already active");
    (0, node_fs_1.unlinkSync)(path);
}
function socketIsLive(path) {
    return new Promise((resolvePromise) => {
        const socket = (0, node_net_1.createConnection)(path);
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            resolvePromise(value);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(250, () => finish(false));
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
/** Stable hash helper for tests/status agents; no consumer should expose it. */
function accountsBrokerRootHash(root) {
    return (0, node_crypto_1.createHash)("sha256").update(assertBrokerRoot(root), "utf8").digest("hex").slice(0, 24);
}
//# sourceMappingURL=broker-socket.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACCOUNTS_BROKER_STARTUP_TIMEOUT_MS = void 0;
exports.runAccountsBrokerAppServerCli = runAccountsBrokerAppServerCli;
exports.connectAccountsBrokerForStartup = connectAccountsBrokerForStartup;
exports.readBrokerDesktopIdentityBootstrap = readBrokerDesktopIdentityBootstrap;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_readline_1 = require("node:readline");
const node_path_1 = require("node:path");
const node_net_1 = require("node:net");
const node_perf_hooks_1 = require("node:perf_hooks");
const codex_app_server_parent_1 = require("../codex-app-server-parent");
const broker_host_1 = require("./broker-host");
const broker_socket_1 = require("./broker-socket");
const config_1 = require("./config");
const protocol_1 = require("./protocol");
const redaction_1 = require("./redaction");
const app_server_mux_1 = require("./app-server-mux");
const types_1 = require("./types");
const OWNER_CONNECT_DELAY_MS = 100;
exports.ACCOUNTS_BROKER_STARTUP_TIMEOUT_MS = 20_000;
/**
 * Per-desktop stdio client for the shared daemon. It never launches Codex
 * directly: an absent/unavailable broker is a terminal redacted app-server
 * failure, not authority to create a second SQLite writer.
 */
async function runAccountsBrokerAppServerCli(argv = process.argv.slice(2)) {
    const started = node_perf_hooks_1.performance.now();
    const deadline = started + exports.ACCOUNTS_BROKER_STARTUP_TIMEOUT_MS;
    const diagnostic = (stage, code) => {
        process.stderr.write(`Tweakers Accounts bridge: ${JSON.stringify({ stage, code, elapsedMs: Math.round(node_perf_hooks_1.performance.now() - started) })}\n`);
    };
    const parsed = parseArguments(argv);
    if (!parsed) {
        diagnostic("preflight", "unavailable");
        process.exitCode = 1;
        return;
    }
    const selection = (0, config_1.readRouterLaunchSelection)(parsed.configPath);
    if (selection.mode !== "mux" || !selection.config || selection.config.schemaVersion !== 3 || !(0, app_server_mux_1.preflightRouterHomes)(selection.config, parsed.stateRoot)) {
        diagnostic("preflight", "unavailable");
        process.exitCode = 1;
        return;
    }
    const secret = (0, broker_socket_1.readAccountsBrokerSecret)(parsed.stateRoot);
    if (!secret) {
        diagnostic("preflight", "unavailable");
        process.exitCode = 1;
        return;
    }
    const clientKind = process.env.TWEAKERS_DERIVED_VARIANT === "1" ? "tweakers" : "chatgpt";
    let identity = desktopBrokerIdentityFromEnvironment();
    if (!identity && process.env[codex_app_server_parent_1.ACCOUNTS_BROKER_IDENTITY_FD_ENV] === "3") {
        try {
            identity = await readBrokerDesktopIdentityBootstrap(new node_net_1.Socket({ fd: 3, readable: true, writable: false }), Math.max(0, deadline - node_perf_hooks_1.performance.now()));
        }
        catch { /* Emit only the bounded stage result below. */ }
    }
    // Random bridge identities would disconnect the app-server task from the
    // renderer that is allowed to confirm a handoff and receive reverse tools.
    // A v3 child without the main-bound identity must fail closed.
    if (!identity) {
        diagnostic("identity", node_perf_hooks_1.performance.now() >= deadline ? "deadline_exceeded" : "unavailable");
        secret.fill(0);
        process.exitCode = 1;
        return;
    }
    diagnostic("identity", "ready");
    const clientOptions = {
        root: parsed.stateRoot,
        secret,
        clientKind,
        rendererRef: identity.rendererRef,
        appToolsRef: identity.appToolsRef,
    };
    const bridge = await connectAccountsBrokerForStartup(clientOptions, writeDesktop, deadline, () => startOwner(parsed));
    if (!bridge) {
        diagnostic("connect", "deadline_exceeded");
        secret.fill(0);
        process.exitCode = 1;
        return;
    }
    diagnostic("connect", "ready");
    const input = (0, node_readline_1.createInterface)({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
        const message = (0, protocol_1.parseJsonRpcLine)(line);
        if (!message) {
            writeDesktop((0, redaction_1.redactedRouterError)(null, "invalid_request"));
            return;
        }
        if (!bridge.send(message)) {
            process.exitCode = 1;
            input.close();
        }
    });
    const shutdown = () => {
        input.close();
        bridge?.close();
        secret.fill(0);
    };
    // A closed broker transport must become a visible app-server failure. Never
    // leave native requests waiting on a bridge that can no longer answer them.
    void bridge.whenClosed.then(() => { process.exitCode = 1; shutdown(); });
    input.once("close", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}
/** Retry only transport establishment. No desktop JSON-RPC is read or replayed. */
async function connectAccountsBrokerForStartup(options, onMessage, deadline, launchOwner) {
    let launched = false;
    while (node_perf_hooks_1.performance.now() < deadline) {
        try {
            const connection = await (0, broker_host_1.connectAccountsBrokerAppServerClient)({ ...options,
                timeoutMs: Math.min(5_000, Math.max(1, deadline - node_perf_hooks_1.performance.now())) }, onMessage);
            if (node_perf_hooks_1.performance.now() < deadline)
                return connection;
            connection.close();
            return null;
        }
        catch {
            const remainingMs = deadline - node_perf_hooks_1.performance.now();
            if (remainingMs <= 0)
                break;
            // A connection attempt can establish its socket and then consume nearly
            // the entire startup budget waiting for the authenticated handshake. Do
            // not launch a competing owner when there is no full retry interval left.
            if (!launched && remainingMs > OWNER_CONNECT_DELAY_MS) {
                launched = true;
                launchOwner();
            }
            await delay(Math.min(OWNER_CONNECT_DELAY_MS, remainingMs));
        }
    }
    return null;
}
function startOwner(parsed) {
    const entrypoint = (0, node_path_1.join)(__dirname, "broker-host.js");
    if (!(0, node_fs_1.existsSync)(entrypoint))
        return;
    const environment = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
        if (typeof process.env[key] === "string")
            environment[key] = process.env[key];
    }
    environment.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
    try {
        const child = (0, node_child_process_1.spawn)(process.execPath, [
            entrypoint,
            "--config", parsed.configPath,
            "--state-root", parsed.stateRoot,
            "--", parsed.command, ...parsed.args,
        ], {
            cwd: process.cwd(),
            env: environment,
            detached: true,
            stdio: "ignore",
        });
        child.once("error", () => { });
        child.unref();
    }
    catch {
        // The caller emits only a generic broker-unavailable failure after its
        // bounded connect wait; no spawn error/path becomes desktop output.
    }
}
function writeDesktop(message) {
    try {
        process.stdout.write(`${JSON.stringify(message)}\n`);
    }
    catch {
        process.exitCode = 1;
    }
}
function parseArguments(argv) {
    const separator = argv.indexOf("--");
    if (separator < 0)
        return null;
    const flags = argv.slice(0, separator);
    const configPath = flagValue(flags, "--config");
    const stateRoot = flagValue(flags, "--state-root");
    const command = argv[separator + 1];
    const args = argv.slice(separator + 2);
    if (!configPath || !stateRoot || !command || !(0, node_path_1.isAbsolute)(configPath) || !(0, node_path_1.isAbsolute)(stateRoot)
        || (0, node_path_1.resolve)(configPath) !== configPath || (0, node_path_1.resolve)(stateRoot) !== stateRoot)
        return null;
    return { configPath, stateRoot, command, args };
}
function flagValue(flags, name) {
    const index = flags.indexOf(name);
    return index >= 0 && typeof flags[index + 1] === "string" ? flags[index + 1] : null;
}
function delay(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
function desktopBrokerIdentityFromEnvironment() {
    const rendererRef = process.env.TWEAKERS_ACCOUNTS_BROKER_RENDERER_REF;
    const appToolsRef = process.env.TWEAKERS_ACCOUNTS_BROKER_APP_TOOLS_REF;
    return (0, types_1.isOpaqueRendererRef)(rendererRef) && (0, types_1.isOpaqueAppToolsRef)(appToolsRef) ? { rendererRef, appToolsRef } : null;
}
/** One private, bounded frame. Never consume the native JSON-RPC stdin here. */
function readBrokerDesktopIdentityBootstrap(input, timeoutMs = codex_app_server_parent_1.ACCOUNTS_BROKER_IDENTITY_TIMEOUT_MS) {
    return new Promise((resolvePromise, reject) => {
        let bytes = Buffer.alloc(0);
        let settled = false;
        const finish = (identity) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            input.removeListener("data", onData);
            input.removeListener("end", onEnd);
            input.removeListener("close", onClose);
            input.destroy();
            if (identity)
                resolvePromise(identity);
            else
                reject(new Error("identity bootstrap unavailable"));
        };
        const onData = (chunk) => {
            const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (bytes.length + next.length > 1024) {
                finish(null);
                return;
            }
            bytes = Buffer.concat([bytes, next]);
        };
        const onEnd = () => {
            try {
                const value = JSON.parse(bytes.toString("utf8"));
                finish(value && (0, types_1.isOpaqueRendererRef)(value.rendererRef) && (0, types_1.isOpaqueAppToolsRef)(value.appToolsRef)
                    ? { rendererRef: value.rendererRef, appToolsRef: value.appToolsRef } : null);
            }
            catch {
                finish(null);
            }
        };
        const onClose = () => finish(null);
        const timer = setTimeout(() => finish(null), timeoutMs);
        input.on("data", onData);
        input.once("end", onEnd);
        input.once("close", onClose);
        input.on("error", onClose);
    });
}
if (require.main === module) {
    void runAccountsBrokerAppServerCli().catch(() => { process.exitCode = 1; });
}
//# sourceMappingURL=broker-app-server.js.map
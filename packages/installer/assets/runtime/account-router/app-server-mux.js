"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAccountRouterMuxCli = runAccountRouterMuxCli;
exports.preflightRouterHomes = preflightRouterHomes;
exports.sanitizedChildEnvironment = sanitizedChildEnvironment;
exports.defaultMuxPaths = defaultMuxPaths;
const node_child_process_1 = require("node:child_process");
const node_readline_1 = require("node:readline");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const mux_1 = require("./mux");
const control_socket_1 = require("./control-socket");
const protocol_1 = require("./protocol");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
const CHILD_INITIALIZE_TIMEOUT_MS = 10_000;
const GRACEFUL_SHUTDOWN_MS = 2_000;
const FORCED_SHUTDOWN_OBSERVATION_MS = 1_000;
/** Executable entry point run under ChatGPT's bundled signed Node parent. */
async function runAccountRouterMuxCli(argv = process.argv.slice(2)) {
    const parsed = parseArguments(argv);
    if (!parsed) {
        process.exitCode = 1;
        return;
    }
    const selection = (0, config_1.readRouterLaunchSelection)(parsed.configPath);
    if (selection.mode !== "mux" || !selection.config || !preflightRouterHomes(selection.config, parsed.stateRoot)) {
        process.exitCode = 1;
        return;
    }
    const secret = readControlSecret(parsed.stateRoot);
    if (!secret) {
        process.exitCode = 1;
        return;
    }
    const store = new state_store_1.RouterStateStore(parsed.stateRoot, selection.config);
    let input = null;
    let control = null;
    let fatalExitScheduled = false;
    const scheduleFatalExit = () => {
        if (fatalExitScheduled)
            return;
        fatalExitScheduled = true;
        process.exitCode = 1;
        input?.close();
        process.stdin.pause();
        void control?.close();
        const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
        force.unref();
    };
    const mux = new mux_1.AccountRouterMux({
        config: selection.config,
        store,
        controlSecret: secret,
        childFactory: new ProcessRouterChildFactory(parsed.command, parsed.args, parsed.stateRoot),
        writeDesktop: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
        onFatal: scheduleFatalExit,
        onShutdown: () => { void control?.close(); },
    });
    try {
        control = await (0, control_socket_1.startRouterControlSocket)({
            root: parsed.stateRoot,
            secret,
            status: () => mux.status(),
        });
    }
    catch {
        process.exitCode = 1;
        return;
    }
    if (!mux.start()) {
        await control.close();
        process.exitCode = 1;
        return;
    }
    input = (0, node_readline_1.createInterface)({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => mux.receiveDesktopLine(line));
    const shutdown = () => {
        input.close();
        mux.shutdown();
        void control?.close();
        const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
        force.unref();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}
function preflightRouterHomes(config, stateRoot) {
    try {
        (0, state_store_1.ensurePrivateDirectory)(stateRoot);
        if (!stateAllowsBalancedStartup(stateRoot))
            return false;
        for (const account of config.accounts) {
            if (!account.included)
                continue;
            for (const directory of [
                (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId),
                (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "codex-home"),
                (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "sqlite-home"),
            ]) {
                if (!(0, node_fs_1.existsSync)(directory))
                    return false;
                (0, state_store_1.ensurePrivateDirectory)(directory);
            }
        }
        return Boolean(readControlSecret(stateRoot));
    }
    catch {
        return false;
    }
}
/** A staged disable or uncertain dispatch is never reopened by a restart. */
function stateAllowsBalancedStartup(stateRoot) {
    const stateFile = (0, node_path_1.join)(stateRoot, "router-state.json");
    if (!(0, node_fs_1.existsSync)(stateFile))
        return true;
    try {
        (0, state_store_1.assertPrivateRegularFile)(stateFile, 2 * 1024 * 1024);
        const state = JSON.parse((0, node_fs_1.readFileSync)(stateFile, "utf8"));
        if (!(0, types_1.isPlainRecord)(state) || state.stagedDisable !== null || !Array.isArray(state.correlations) || !(0, types_1.isPlainRecord)(state.pendingThreadOwners))
            return false;
        return state.correlations.length === 0 && Object.keys(state.pendingThreadOwners).length === 0;
    }
    catch {
        return false;
    }
}
function readControlSecret(stateRoot) {
    const path = (0, node_path_1.join)(stateRoot, "control-secret.v1");
    try {
        if (!(0, node_fs_1.existsSync)(path))
            return null;
        (0, state_store_1.assertPrivateRegularFile)(path, 512);
        const secret = Buffer.from((0, node_fs_1.readFileSync)(path));
        return secret.byteLength === 32 ? secret : null;
    }
    catch {
        return null;
    }
}
class ProcessRouterChildFactory {
    command;
    args;
    stateRoot;
    constructor(command, args, stateRoot) {
        this.command = command;
        this.args = args;
        this.stateRoot = stateRoot;
    }
    create(account, handlers) {
        const accountRoot = (0, node_path_1.join)(this.stateRoot, "accounts", account);
        const codexHome = (0, node_path_1.join)(accountRoot, "codex-home");
        const sqliteHome = (0, node_path_1.join)(accountRoot, "sqlite-home");
        const child = (0, node_child_process_1.spawn)(this.command, [...this.args], {
            cwd: process.cwd(),
            env: sanitizedChildEnvironment(codexHome, sqliteHome),
            stdio: ["pipe", "pipe", "ignore"],
        });
        if (!child.stdin || !child.stdout)
            throw new Error("account-router child lacks JSONL stdio");
        const lines = (0, node_readline_1.createInterface)({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => {
            const message = (0, protocol_1.parseJsonRpcLine)(line);
            if (message)
                handlers.onMessage(message);
            else
                handlers.onFailure();
        });
        child.once("error", () => handlers.onFailure());
        child.once("exit", () => handlers.onFailure());
        const initializeTimeout = setTimeout(() => handlers.onFailure(), CHILD_INITIALIZE_TIMEOUT_MS);
        initializeTimeout.unref();
        return new ProcessRouterChild(account, child, () => clearTimeout(initializeTimeout));
    }
}
class ProcessRouterChild {
    opaqueAccountId;
    child;
    clearInitializeTimeout;
    constructor(opaqueAccountId, child, clearInitializeTimeout) {
        this.opaqueAccountId = opaqueAccountId;
        this.child = child;
        this.clearInitializeTimeout = clearInitializeTimeout;
    }
    send(message) {
        if (!this.child.stdin || this.child.exitCode !== null || this.child.signalCode !== null)
            throw new Error("account-router child is unavailable");
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    terminate(signal) {
        this.clearInitializeTimeout();
        this.child.kill(signal);
        const force = setTimeout(() => {
            if (this.child.exitCode === null && this.child.signalCode === null)
                this.child.kill("SIGKILL");
        }, GRACEFUL_SHUTDOWN_MS);
        force.unref();
    }
    markInitialized() {
        this.clearInitializeTimeout();
    }
}
function sanitizedChildEnvironment(codexHome, sqliteHome, source = process.env) {
    // The child receives only operating-system launch values. In particular, no
    // arbitrary parent env, headers, OAuth state, or provider token is copied
    // into an account home through process inheritance.
    const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
    const environment = {};
    for (const key of allowed) {
        if (typeof source[key] === "string")
            environment[key] = source[key];
    }
    return { ...environment, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
}
function parseArguments(argv) {
    const separator = argv.indexOf("--");
    if (separator < 0)
        return null;
    const flags = argv.slice(0, separator);
    const command = argv[separator + 1];
    const args = argv.slice(separator + 2);
    const configPath = flagValue(flags, "--config");
    const stateRoot = flagValue(flags, "--state-root");
    if (!configPath || !stateRoot || !command)
        return null;
    return { configPath, stateRoot, command, args };
}
function flagValue(flags, name) {
    const index = flags.indexOf(name);
    return index >= 0 && typeof flags[index + 1] === "string" ? flags[index + 1] : null;
}
function defaultMuxPaths(userRoot = process.env.TWEAKERS_USER_ROOT ?? process.env.TWEAKER_USER_ROOT) {
    const configPath = (0, config_1.defaultAccountRouterConfigPath)(userRoot);
    return configPath ? { configPath, stateRoot: (0, node_path_1.dirname)(configPath) } : null;
}
if (require.main === module) {
    void runAccountRouterMuxCli().catch(() => { process.exitCode = 1; });
}
//# sourceMappingURL=app-server-mux.js.map
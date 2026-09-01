"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMuxCliShutdown = createMuxCliShutdown;
exports.runAccountRouterMuxCli = runAccountRouterMuxCli;
exports.preflightRouterHomes = preflightRouterHomes;
exports.preflightRouterHomesDetail = preflightRouterHomesDetail;
exports.sanitizedChildEnvironment = sanitizedChildEnvironment;
exports.defaultMuxPaths = defaultMuxPaths;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_readline_1 = require("node:readline");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const history_adoption_1 = require("./history-adoption");
const mux_1 = require("./mux");
const control_socket_1 = require("./control-socket");
const protocol_1 = require("./protocol");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
const CHILD_INITIALIZE_TIMEOUT_MS = 10_000;
const GRACEFUL_SHUTDOWN_MS = 2_000;
const FORCED_SHUTDOWN_OBSERVATION_MS = 1_000;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_CHILD_CONFIG_BYTES = 4 * 1024;
/** Shared EOF/signal cleanup: idempotent and deliberately does not close stdin. */
function createMuxCliShutdown(mux, closeControl, pauseInput, scheduleForceExit) {
    let started = false;
    return () => {
        if (started)
            return;
        started = true;
        mux.shutdown();
        void closeControl();
        pauseInput();
        scheduleForceExit();
    };
}
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
        // A later v2 config is pending intent only. The running mux keeps the
        // startup config as active truth and never changes its route mid-session.
        readPendingConfig: () => (0, config_1.readRouterLaunchSelection)(parsed.configPath).config,
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
    const shutdown = createMuxCliShutdown(mux, () => control?.close(), () => process.stdin.pause(), () => {
        const force = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS + FORCED_SHUTDOWN_OBSERVATION_MS);
        force.unref();
    });
    // `close` is also raised on stdin EOF. This shared callback must not call
    // input.close(), otherwise EOF recursively re-enters readline shutdown.
    input.once("close", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}
function preflightRouterHomes(config, stateRoot) {
    return preflightRouterHomesDetail(config, stateRoot).ok;
}
/**
 * Non-secret startup evidence for the parent/direct-fallback decision. File
 * names, homes, identities, and provider data deliberately never escape it.
 */
function preflightRouterHomesDetail(config, stateRoot) {
    if (!(0, config_1.isRouterConfigV2)(config))
        return { ok: false, reason: "history_adoption_required" };
    const secret = readControlSecret(stateRoot);
    if (!secret)
        return { ok: false, reason: "startup_selfcheck_failed" };
    let intentBytes = null;
    let receiptBytes = null;
    let ownersBytes = null;
    try {
        (0, state_store_1.ensurePrivateDirectory)(stateRoot);
        const state = stateAllowsBalancedStartup(config, stateRoot);
        if (!state)
            return { ok: false, reason: "startup_selfcheck_failed" };
        intentBytes = readOwnerPrivateRegularFile((0, node_path_1.join)(stateRoot, history_adoption_1.ACCOUNT_HISTORY_ADOPTION_INTENT_FILE), history_adoption_1.HISTORY_ADOPTION_MAX_ARTIFACT_BYTES, false);
        receiptBytes = readOwnerPrivateRegularFile((0, node_path_1.join)(stateRoot, history_adoption_1.ACCOUNT_HISTORY_ADOPTION_RECEIPT_FILE), history_adoption_1.HISTORY_ADOPTION_MAX_ARTIFACT_BYTES, false);
        ownersBytes = readOwnerPrivateRegularFile((0, node_path_1.join)(stateRoot, history_adoption_1.ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE), history_adoption_1.HISTORY_ADOPTION_MAX_OWNERS_BYTES, false);
        if (!intentBytes || !receiptBytes || !ownersBytes)
            return { ok: false, reason: "history_adoption_required" };
        const adoption = (0, history_adoption_1.validateHistoryAdoptionEvidence)(config, state, secret, {
            intent: intentBytes, receipt: receiptBytes, owners: ownersBytes,
        });
        if (!adoption.ok)
            return adoption;
        const owner = adoption.evidence.receipt.legacyOwnerOpaqueAccountId;
        if (!(0, history_adoption_1.validateHistoryAdoptionArtifacts)(adoption.evidence.receipt, (0, node_path_1.join)(stateRoot, "accounts", owner, "codex-home"), (0, node_path_1.join)(stateRoot, "accounts", owner, "sqlite-home")))
            return { ok: false, reason: "history_adoption_artifact_mismatch" };
        for (const account of config.accounts) {
            if (!account.included)
                continue;
            for (const directory of [
                (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId),
                (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "codex-home"),
                (0, node_path_1.join)(stateRoot, "accounts", account.opaqueAccountId, "sqlite-home"),
            ]) {
                if (!(0, node_fs_1.existsSync)(directory))
                    return { ok: false, reason: "startup_selfcheck_failed" };
                (0, state_store_1.ensurePrivateDirectory)(directory);
            }
            if (!validateIsolatedAccountHome(account.opaqueAccountId, stateRoot, secret))
                return { ok: false, reason: "startup_selfcheck_failed" };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, reason: "startup_selfcheck_failed" };
    }
    finally {
        intentBytes?.fill(0);
        receiptBytes?.fill(0);
        ownersBytes?.fill(0);
        secret.fill(0);
    }
}
/**
 * Stage-time hardening is rechecked immediately before the parent chooses the
 * mux. No source auth, symlink, custom config, or post-stage swap is trusted.
 */
function validateIsolatedAccountHome(account, stateRoot, secret) {
    const codexHome = (0, node_path_1.join)(stateRoot, "accounts", account, "codex-home");
    const authBytes = readOwnerPrivateRegularFile((0, node_path_1.join)(codexHome, "auth.json"), MAX_AUTH_BYTES, false);
    const configBytes = readOwnerPrivateRegularFile((0, node_path_1.join)(codexHome, "config.toml"), MAX_CHILD_CONFIG_BYTES, true);
    try {
        if (!authBytes || !configBytes || configBytes.byteLength !== 0)
            return false;
        const parsed = JSON.parse(authBytes.toString("utf8"));
        const rawAccountId = authAccountId(parsed);
        if (!rawAccountId)
            return false;
        const expected = `ar_${(0, node_crypto_1.createHmac)("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`;
        return expected.length === account.length
            && (0, node_crypto_1.timingSafeEqual)(Buffer.from(expected, "utf8"), Buffer.from(account, "utf8"));
    }
    catch {
        return false;
    }
    finally {
        authBytes?.fill(0);
        configBytes?.fill(0);
    }
}
/** Read a bounded, owner-private, single-link regular file without following symlinks. */
function readOwnerPrivateRegularFile(path, maxBytes, allowEmpty) {
    let descriptor;
    let bytes = null;
    let succeeded = false;
    try {
        descriptor = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
        const before = (0, node_fs_1.fstatSync)(descriptor);
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
            || (before.mode & 0o077) !== 0 || before.size > maxBytes || (!allowEmpty && before.size <= 0))
            return null;
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const count = (0, node_fs_1.readSync)(descriptor, bytes, offset, bytes.byteLength - offset, offset);
            if (!count)
                return null;
            offset += count;
        }
        const after = (0, node_fs_1.fstatSync)(descriptor);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            return null;
        succeeded = true;
        return bytes;
    }
    catch {
        return null;
    }
    finally {
        if (descriptor !== undefined)
            (0, node_fs_1.closeSync)(descriptor);
        // Ownership transfers only after every validation succeeds. Callers clear
        // the returned byte buffer promptly; failed reads never retain auth data.
        if (bytes && !succeeded)
            bytes.fill(0);
    }
}
function authAccountId(value) {
    if (!(0, types_1.isPlainRecord)(value) || !(0, types_1.isPlainRecord)(value.tokens))
        return null;
    const accountId = value.tokens.account_id;
    return typeof accountId === "string" && accountId.length > 0 && accountId.length <= 1_024 ? accountId : null;
}
/** A staged disable or uncertain dispatch is never reopened by a restart. */
function stateAllowsBalancedStartup(config, stateRoot) {
    const stateFile = (0, node_path_1.join)(stateRoot, "router-state.json");
    // A receipt proves a particular imported owner subset. A missing state
    // cannot prove that subset, so v2 falls back before any child process exists.
    if (!(0, node_fs_1.existsSync)(stateFile))
        return null;
    try {
        (0, state_store_1.assertPrivateRegularFile)(stateFile, 2 * 1024 * 1024);
        const state = JSON.parse((0, node_fs_1.readFileSync)(stateFile, "utf8"));
        // The store constructor is intentionally strict about configured accounts
        // and ledger weights. Check the entire candidate here so the signed parent
        // retains its direct app-server fallback instead of selecting a mux that
        // will fail moments later on a v1-to-v2 (or pair/order/weight) mismatch.
        if (!(0, state_store_1.validateRouterState)(state, config))
            return null;
        return state.stagedDisable === null
            && state.correlations.length === 0
            && Object.keys(state.pendingThreadOwners).length === 0
            // A persisted reservation is ambiguous after a process crash: without
            // an atomic reservation-to-thread recovery proof, start direct/manual.
            && state.reservations.every((reservation) => reservation.state !== "reserved" && reservation.state !== "stranded_ambiguous")
            ? state
            : null;
    }
    catch {
        return null;
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
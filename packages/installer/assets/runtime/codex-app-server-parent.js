"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_APP_SERVER_PARENT_SOURCE = void 0;
exports.isCodexAppServerSpawn = isCodexAppServerSpawn;
exports.buildCodexAppServerParentArgs = buildCodexAppServerParentArgs;
exports.buildAccountRouterMuxArgs = buildAccountRouterMuxArgs;
exports.installCodexAppServerParent = installCodexAppServerParent;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./account-router/config");
const app_server_mux_1 = require("./account-router/app-server-mux");
const INSTALL_MARKER = Symbol.for("co.tweakers.codex-app-server-parent");
/**
 * The native browser peer authorizer validates three generations of process
 * ancestry. A locally re-signed desktop app therefore cannot be the direct
 * grandparent of the signed Codex browser processes. This tiny signed-Node
 * parent keeps the desktop app outside that three-process window without
 * changing the native host or its authorization policy.
 */
exports.CODEX_APP_SERVER_PARENT_SOURCE = String.raw `
"use strict";
const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(1);
if (!command) {
  process.stderr.write("Tweakers Codex parent: missing child command\n");
  process.exit(1);
}
const child = spawn(command, args, {
  cwd: process.cwd(),
  // A signed Node parent is part of the native peer trust chain. Never let a
  // caller turn NODE_OPTIONS preloads into code running inside that process or
  // pass them onward to the signed Codex descendants it authorizes.
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS")),
  stdio: "inherit",
});
let forwardedSignal = null;
let escalationTimer = null;
const childIsRunning = () => child.exitCode === null && child.signalCode === null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (forwardedSignal === null) forwardedSignal = signal;
    if (!childIsRunning()) return;
    child.kill(signal);
    if (escalationTimer === null) {
      escalationTimer = setTimeout(() => {
        escalationTimer = null;
        if (childIsRunning()) child.kill("SIGKILL");
      }, 1000);
    }
  });
}
child.once("error", (error) => {
  if (escalationTimer !== null) clearTimeout(escalationTimer);
  process.stderr.write("Tweakers Codex parent: " + error.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (escalationTimer !== null) clearTimeout(escalationTimer);
  if (typeof code === "number") {
    process.exit(code);
    return;
  }
  const exitSignal = signal || forwardedSignal;
  if (exitSignal) {
    process.removeAllListeners(exitSignal);
    process.kill(process.pid, exitSignal);
    return;
  }
  process.exit(1);
});
`;
function isCodexAppServerSpawn(command, args, options) {
    if (typeof command !== "string" || (0, node_path_1.basename)(command) !== "codex")
        return false;
    if (!Array.isArray(args))
        return false;
    if (!args.every((value) => typeof value === "string"))
        return false;
    const directLaunch = args[0] === "app-server";
    const desktopLaunch = args[0] === "-c"
        && args[1] === "features.code_mode_host=true"
        && args[2] === "app-server";
    if (!directLaunch && !desktopLaunch)
        return false;
    const appServerIndex = directLaunch ? 0 : 2;
    if (args.lastIndexOf("app-server") !== appServerIndex)
        return false;
    if (options?.shell || options?.detached)
        return false;
    // The parent script preserves the normal stdin/stdout/stderr contract. Do
    // not interpose on launches that depend on IPC or extra inherited file
    // descriptors because those cannot be faithfully proxied through `node -e`.
    if (Array.isArray(options?.stdio) && options.stdio.length > 3)
        return false;
    if (options?.stdio === "ignore")
        return false;
    return true;
}
function buildCodexAppServerParentArgs(command, args) {
    return ["-e", exports.CODEX_APP_SERVER_PARENT_SOURCE, "--", command, ...args];
}
function buildAccountRouterMuxArgs(entrypoint, configPath, command, args) {
    return [entrypoint, "--config", configPath, "--state-root", (0, node_path_1.dirname)(configPath), "--", command, ...args];
}
function installCodexAppServerParent(options = {}) {
    const childProcess = options.childProcess ??
        require("node:child_process");
    const platform = options.platform ?? process.platform;
    const resourcesPath = options.resourcesPath ??
        (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
    const pathExists = options.pathExists ?? node_fs_1.existsSync;
    const existing = childProcess[INSTALL_MARKER];
    if (existing) {
        // A caller that did not install the hook must not be able to remove the
        // first caller's installation through the returned handle.
        return result(false, null, "already-installed", childProcess);
    }
    if (platform !== "darwin") {
        return result(false, null, "unsupported-platform", childProcess);
    }
    if (!resourcesPath) {
        return result(false, null, "missing-bundled-node", childProcess);
    }
    const bundledNodePath = (0, node_path_1.join)(resourcesPath, "cua_node", "bin", "node");
    if (!pathExists(bundledNodePath)) {
        return result(false, bundledNodePath, "missing-bundled-node", childProcess);
    }
    const originalSpawn = childProcess.spawn;
    const installed = {
        originalSpawn,
        wrappedSpawn: undefined,
        children: new Set(),
        cleanupStarted: false,
    };
    const wrappedSpawn = function wrappedCodexSpawn(command, argsOrOptions, maybeOptions) {
        if (Array.isArray(argsOrOptions) &&
            isCodexAppServerSpawn(command, argsOrOptions, maybeOptions)) {
            if (installed.cleanupStarted) {
                throw new Error("Tweakers Codex parent: app-server cleanup has started");
            }
            const router = accountRouterLaunch({
                router: options.accountRouter,
                bundledNodePath,
                defaultPathExists: pathExists,
            });
            const childArgs = router
                ? buildAccountRouterMuxArgs(router.entrypoint, router.configPath, command, argsOrOptions)
                : buildCodexAppServerParentArgs(command, argsOrOptions);
            const child = Reflect.apply(originalSpawn, this, [
                bundledNodePath,
                childArgs,
                sanitizeParentSpawnOptions(maybeOptions),
            ]);
            installed.children.add(child);
            child.once?.("exit", () => installed.children.delete(child));
            child.once?.("error", () => installed.children.delete(child));
            return child;
        }
        return Reflect.apply(originalSpawn, this, [command, argsOrOptions, maybeOptions]);
    };
    installed.wrappedSpawn = wrappedSpawn;
    childProcess.spawn = wrappedSpawn;
    childProcess[INSTALL_MARKER] = installed;
    return result(true, bundledNodePath, "installed", childProcess, installed);
}
function accountRouterLaunch(options) {
    const userRoot = options.router?.userRoot ?? process.env.TWEAKERS_USER_ROOT ?? process.env.TWEAKER_USER_ROOT;
    const configPath = options.router?.configPath ?? (0, config_1.defaultAccountRouterConfigPath)(userRoot);
    const pathExists = options.router?.pathExists ?? options.defaultPathExists;
    const selection = (0, config_1.readRouterLaunchSelection)(configPath, options.router?.readFile, pathExists);
    if (selection.mode !== "mux" || !configPath)
        return null;
    const entrypoint = options.router?.runtimeEntrypointPath ?? (0, node_path_1.join)(__dirname, "account-router", "app-server-mux.js");
    if (!pathExists(entrypoint) || !(0, app_server_mux_1.preflightRouterHomes)(selection.config, (0, node_path_1.dirname)(configPath)))
        return null;
    return { entrypoint, configPath };
}
function sanitizeParentSpawnOptions(options) {
    const env = { ...(options?.env ?? process.env) };
    delete env.NODE_OPTIONS;
    return { ...(options ?? {}), env };
}
function result(installed, bundledNodePath, reason, childProcess, state) {
    return {
        installed,
        bundledNodePath,
        reason,
        async cleanupTrackedParents(options = {}) {
            if (!state || childProcess[INSTALL_MARKER] !== state) {
                return { tracked: 0, terminated: 0, forced: 0, failed: 0 };
            }
            state.cleanupStarted = true;
            if (state.cleanupInFlight)
                return state.cleanupInFlight;
            state.cleanupInFlight = drainTrackedParents(state, options.termTimeoutMs ?? 2_000, options.killTimeoutMs ?? 1_000);
            try {
                return await state.cleanupInFlight;
            }
            finally {
                state.cleanupInFlight = undefined;
            }
        },
        uninstall() {
            if (!state || childProcess[INSTALL_MARKER] !== state)
                return;
            if (childProcess.spawn === state.wrappedSpawn)
                childProcess.spawn = state.originalSpawn;
            delete childProcess[INSTALL_MARKER];
        },
    };
}
async function terminateTrackedParent(child, termTimeoutMs, killTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return "already-exited";
    if (!child.kill("SIGTERM"))
        return "failed";
    const completionTimeoutMs = Math.max(0, termTimeoutMs) + Math.max(0, killTimeoutMs);
    if (!await waitForChildExit(child, completionTimeoutMs))
        return "failed";
    return child.signalCode === "SIGKILL" ? "forced" : "terminated";
}
async function drainTrackedParents(state, termTimeoutMs, killTimeoutMs) {
    const attempted = new Set();
    let terminated = 0;
    let forced = 0;
    let failed = 0;
    while (true) {
        const pending = [...state.children].filter((child) => !attempted.has(child));
        if (pending.length === 0)
            break;
        for (const child of pending) {
            attempted.add(child);
            const outcome = await terminateTrackedParent(child, termTimeoutMs, killTimeoutMs);
            if (outcome === "terminated")
                terminated += 1;
            else if (outcome === "forced")
                forced += 1;
            else if (outcome === "failed")
                failed += 1;
            if (outcome !== "failed")
                state.children.delete(child);
        }
    }
    return { tracked: attempted.size, terminated, forced, failed };
}
function waitForChildExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
    return new Promise((resolvePromise) => {
        let settled = false;
        const settle = (exited) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            child.removeListener("error", onError);
            resolvePromise(exited);
        };
        const onExit = () => settle(true);
        const onError = () => settle(false);
        const timer = setTimeout(() => settle(false), Math.max(0, timeoutMs));
        child.once("exit", onExit);
        child.once("error", onError);
    });
}
//# sourceMappingURL=codex-app-server-parent.js.map
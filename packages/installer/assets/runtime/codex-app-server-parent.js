"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_APP_SERVER_PARENT_SOURCE = void 0;
exports.isCodexAppServerSpawn = isCodexAppServerSpawn;
exports.buildCodexAppServerParentArgs = buildCodexAppServerParentArgs;
exports.installCodexAppServerParent = installCodexAppServerParent;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
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
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    forwardedSignal = signal;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.once("error", (error) => {
  process.stderr.write("Tweakers Codex parent: " + error.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
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
    const wrappedSpawn = function wrappedCodexSpawn(command, argsOrOptions, maybeOptions) {
        if (Array.isArray(argsOrOptions) &&
            isCodexAppServerSpawn(command, argsOrOptions, maybeOptions)) {
            return Reflect.apply(originalSpawn, this, [
                bundledNodePath,
                buildCodexAppServerParentArgs(command, argsOrOptions),
                sanitizeParentSpawnOptions(maybeOptions),
            ]);
        }
        return Reflect.apply(originalSpawn, this, [command, argsOrOptions, maybeOptions]);
    };
    const installed = { originalSpawn, wrappedSpawn };
    childProcess.spawn = wrappedSpawn;
    childProcess[INSTALL_MARKER] = installed;
    return result(true, bundledNodePath, "installed", childProcess, installed);
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
        uninstall() {
            if (!state || childProcess[INSTALL_MARKER] !== state)
                return;
            if (childProcess.spawn === state.wrappedSpawn)
                childProcess.spawn = state.originalSpawn;
            delete childProcess[INSTALL_MARKER];
        },
    };
}
//# sourceMappingURL=codex-app-server-parent.js.map
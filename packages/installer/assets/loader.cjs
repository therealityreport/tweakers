/* eslint-disable */
/**
 * tweaker loader stub. This file is copied into Codex.app/Contents/Resources/app.asar
 * by the installer, and `package.json#main` is rewritten to point at it.
 *
 * Responsibilities:
 *   1. Resolve the original entry point that we replaced (stored in
 *      package.json#__tweaker.originalMain) and the user runtime location
 *      (also recorded in __tweaker.userRoot).
 *   2. Hook `require` so renderer preloads can find our runtime.
 *   3. Load the runtime's main-process entry BEFORE the original main entry.
 *      The runtime patches Electron's BrowserWindow to inject our preload script.
 *   4. Load the original main entry. A normal ChatGPT launch may continue in
 *      degraded mode when the optional Tweakers runtime fails. The independent
 *      Tweakers bundle is different: it must fail closed rather than silently
 *      presenting an unmodified ChatGPT shell.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const pkg = require("./package.json");
const meta = pkg.__tweaker || {};
const originalMain = meta.originalMain;
const appUserDataRoot = meta.appUserDataRoot;
const independentTweakers = isIndependentTweakersBundle();
// The installer writes this exact manager-owned rendezvous into both desktop
// packages. It must win over a parent-process environment so standard ChatGPT
// and the derived Tweakers app cannot select different brokers.
const accountsBrokerRoot = typeof meta.accountsBrokerRoot === "string"
  && path.isAbsolute(meta.accountsBrokerRoot)
  && path.resolve(meta.accountsBrokerRoot) === meta.accountsBrokerRoot
  ? meta.accountsBrokerRoot
  : undefined;
const healthCheckOnly = process.env.TWEAKERS_HEALTH_CHECK_ONLY === "1";
const runOriginalMainDuringHealth = process.env.TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN === "1";
const configuredHealthUserRoot = process.env.TWEAKERS_HEALTH_USER_ROOT;
const validHealthUserRoot = healthCheckOnly
  && typeof configuredHealthUserRoot === "string"
  && isContainedHealthUserRoot(configuredHealthUserRoot);
// Health launches never fall back to the live metadata root. The paired
// original-main probe is allowed only when the installer supplied an exact,
// absolute root whose runtime paths remain contained below that root.
const userRoot = healthCheckOnly
  ? (validHealthUserRoot ? configuredHealthUserRoot : undefined)
  : meta.userRoot;
const normalLaunch = !healthCheckOnly && !runOriginalMainDuringHealth;
const pairedOriginalMainHealthLaunch = healthCheckOnly
  && runOriginalMainDuringHealth
  && validHealthUserRoot;
let runtimeInitialized = false;
let runtimeBootstrapError = null;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function isIndependentTweakersBundle() {
  // productName is rewritten inside app.asar and remains available even when
  // an older bundle lost its LSEnvironment marker. The Info.plist check is a
  // second binding for launches where the package metadata is stale.
  if (pkg.productName === "Tweakers") return true;
  try {
    const resourcesPath = process.resourcesPath;
    if (typeof resourcesPath !== "string") return false;
    const appRoot = path.dirname(path.dirname(resourcesPath));
    const info = fs.readFileSync(path.join(appRoot, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>com\.therealityreport\.tweakers<\/string>/.test(info);
  } catch {
    return false;
  }
}

function isContainedHealthUserRoot(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) return false;
  try {
    const rootStat = fs.lstatSync(root);
    const runtimeDir = path.join(root, "runtime");
    const runtimeStat = fs.lstatSync(runtimeDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) return false;
    const relativeRuntime = path.relative(fs.realpathSync(root), fs.realpathSync(runtimeDir));
    return relativeRuntime !== ""
      && !path.isAbsolute(relativeRuntime)
      && relativeRuntime !== ".."
      && !relativeRuntime.startsWith(`..${path.sep}`);
  } catch {
    return false;
  }
}

function appendCappedLog(file, line) {
  const incoming = Buffer.from(line);
  if (incoming.byteLength >= MAX_LOG_BYTES) {
    fs.writeFileSync(file, incoming.subarray(incoming.byteLength - MAX_LOG_BYTES));
    return;
  }
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    const allowedExisting = MAX_LOG_BYTES - incoming.byteLength;
    if (size > allowedExisting) {
      const existing = fs.readFileSync(file);
      fs.writeFileSync(file, existing.subarray(Math.max(0, existing.byteLength - allowedExisting)));
    }
  }
  fs.appendFileSync(file, incoming);
}

function showIndependentTweakersRecovery() {
  const title = "Tweakers failed to start";
  const message = [
    "Tweakers stopped because its runtime did not pass startup verification.",
    "",
    "The ordinary ChatGPT interface was not opened in its place.",
    "Rebuild Independent Tweakers from the verified Tweakers manager, or review the Tweakers loader log for details.",
  ].join("\n");
  try {
    const electron = require("electron");
    if (electron?.dialog && typeof electron.dialog.showErrorBox === "function") {
      // Electron explicitly supports showErrorBox before app.ready, which is
      // the only dependable native surface after an early loader failure.
      electron.dialog.showErrorBox(title, message);
    }
    if (electron?.app && typeof electron.app.exit === "function") {
      electron.app.exit(1);
    }
  } catch (error) {
    process.stderr.write(`[tweaker] native recovery surface unavailable: ${error}\n`);
  }
}

function showChatGPTOverlayUnavailable() {
  const options = {
    type: "warning",
    title: "Tweakers overlay unavailable",
    message: "ChatGPT opened without Tweakers customizations.",
    detail: [
      "The Tweakers runtime did not pass startup verification, so no Tweakers code was loaded.",
      "Your ChatGPT data was not changed. Review the Tweakers loader log before reapplying the overlay.",
    ].join("\n\n"),
    buttons: ["Continue to ChatGPT"],
    defaultId: 0,
  };
  try {
    const electron = require("electron");
    const show = () => {
      if (!electron?.dialog || typeof electron.dialog.showMessageBox !== "function") return;
      Promise.resolve(electron.dialog.showMessageBox(options)).catch((error) => {
        process.stderr.write(`[tweaker] overlay-unavailable notice failed: ${error}\n`);
      });
    };
    if (electron?.app && typeof electron.app.isReady === "function" && electron.app.isReady()) {
      show();
    } else if (electron?.app && typeof electron.app.whenReady === "function") {
      Promise.resolve(electron.app.whenReady()).then(show).catch((error) => {
        process.stderr.write(`[tweaker] overlay-unavailable notice scheduling failed: ${error}\n`);
      });
    }
  } catch (error) {
    process.stderr.write(`[tweaker] overlay-unavailable notice unavailable: ${error}\n`);
  }
}

function safe(label, fn) {
  try {
    fn();
  } catch (e) {
    runtimeBootstrapError ||= e;
    try {
      if (!userRoot) throw e;
      const logDir = path.join(userRoot, "log");
      fs.mkdirSync(logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] ${label}: ${(e && e.stack) || e}\n`;
      appendCappedLog(path.join(logDir, "loader.log"), line);
    } catch (_) {
      // last resort: stderr
      process.stderr.write(`[tweaker loader] ${label}: ${e}\n`);
    }
  }
}

if (appUserDataRoot && normalLaunch) {
  safe("app-user-data", () => {
    fs.mkdirSync(appUserDataRoot, { recursive: true });
    // OpenAI's early bootstrap computes userData again immediately before it
    // acquires Electron's single-instance lock. Bind its supported override so
    // a derived Tweakers launch cannot be routed into the live ChatGPT process.
    process.env.CODEX_ELECTRON_USER_DATA_PATH = appUserDataRoot;
    require("electron").app.setPath("userData", appUserDataRoot);
  });
}

safe("init", () => {
  if (!originalMain) {
    throw new Error("loader: package.json missing __tweaker.originalMain");
  }
  if (!userRoot) {
    throw new Error("loader: package.json missing __tweaker.userRoot");
  }
  if (accountsBrokerRoot) {
    process.env.TWEAKERS_ACCOUNTS_BROKER_ROOT = accountsBrokerRoot;
    process.env.TWEAKER_ACCOUNTS_BROKER_ROOT = accountsBrokerRoot;
  }

  // Allow user-installed runtime modules to be require()d from anywhere.
  const runtimeDir = path.join(userRoot, "runtime");
  if (fs.existsSync(runtimeDir)) {
    Module.globalPaths.push(path.join(runtimeDir, "node_modules"));
    process.env.TWEAKERS_USER_ROOT = userRoot;
    process.env.TWEAKERS_RUNTIME = runtimeDir;
    // Legacy aliases remain for already-patched Tweaker installs.
    process.env.TWEAKER_USER_ROOT = userRoot;
    process.env.TWEAKER_RUNTIME = runtimeDir;
    process.env[["CODEX", "PLUSPLUS", "USER_ROOT"].join("_")] = userRoot;
    process.env[["CODEX", "PLUSPLUS", "RUNTIME"].join("_")] = runtimeDir;
    // Load the runtime main-process bootstrap. It will hook BrowserWindow
    // before Codex creates any windows.
    safe("runtime", () => {
      require(path.join(runtimeDir, "main.js"));
      runtimeInitialized = true;
    });
  } else {
    runtimeBootstrapError = new Error(`runtime missing at ${runtimeDir}`);
    process.stderr.write(
      `[tweaker] runtime missing at ${runtimeDir}; independent Tweakers launch refused.\n`,
    );
  }
});

// Normal launches always start Codex. A disposable health launch starts it
// only through the exact paired opt-in above; a bare health flag, a run flag
// on its own, or a non-absolute health root all fail closed.
if (normalLaunch && independentTweakers && !runtimeInitialized) {
  const detail = runtimeBootstrapError && (runtimeBootstrapError.stack || runtimeBootstrapError.message)
    || "runtime initialization did not complete";
  process.stderr.write(`[tweaker] independent Tweakers launch refused: ${detail}\n`);
  process.exitCode = 1;
  showIndependentTweakersRecovery();
} else if (normalLaunch || (pairedOriginalMainHealthLaunch && runtimeInitialized)) {
  if (normalLaunch && !independentTweakers && !runtimeInitialized) {
    showChatGPTOverlayUnavailable();
  }
  require("./" + originalMain);
}

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
 *   4. Load the original main entry. If anything in our pipeline throws, log
 *      it but always fall through to the original main so Codex still launches
 *      (broken tweak system > broken Codex).
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const pkg = require("./package.json");
const meta = pkg.__tweaker || {};
const originalMain = meta.originalMain;
const appUserDataRoot = meta.appUserDataRoot;
const userRoot = process.env.TWEAKERS_HEALTH_CHECK_ONLY === "1" && process.env.TWEAKERS_HEALTH_USER_ROOT
  ? process.env.TWEAKERS_HEALTH_USER_ROOT
  : meta.userRoot;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

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

function safe(label, fn) {
  try {
    fn();
  } catch (e) {
    try {
      const logDir = path.join(userRoot || "", "log");
      fs.mkdirSync(logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] ${label}: ${(e && e.stack) || e}\n`;
      appendCappedLog(path.join(logDir, "loader.log"), line);
    } catch (_) {
      // last resort: stderr
      process.stderr.write(`[tweaker loader] ${label}: ${e}\n`);
    }
  }
}

if (appUserDataRoot && process.env.TWEAKERS_HEALTH_CHECK_ONLY !== "1") {
  safe("app-user-data", () => {
    fs.mkdirSync(appUserDataRoot, { recursive: true });
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
    safe("runtime", () => require(path.join(runtimeDir, "main.js")));
  } else {
    process.stderr.write(
      `[tweaker] runtime missing at ${runtimeDir}; loading Codex untweaked.\n`,
    );
  }
});

// A disposable promotion probe must never initialize the normal Codex main
// process. The runtime owns this one-shot mode and exits after writing health.
if (process.env.TWEAKERS_HEALTH_CHECK_ONLY !== "1") {
  require("./" + originalMain);
}

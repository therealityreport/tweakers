"use strict";

// Canonical source asset for the normal-protected shell.  It intentionally
// does not load the Tweakers runtime, renderer preload, settings injector, or
// BrowserWindow hooks.  Packaging copies the reviewed bootstrap module beside
// this file; the generated app artifact is not edited in the source checkout.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

const METADATA_FILE = "tweakers-protected.json";
const BOOTSTRAP_FILE = "protected-bootstrap.cjs";

function exactChild(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the protected shell`);
  }
  return candidate;
}

function readJson(file, label) {
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function isExactAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 1
    && path.isAbsolute(value)
    && path.resolve(value) === value;
}

function resolveAuthorityFile(authorityRoot, relativePath, label) {
  if (!isExactAbsolutePath(authorityRoot)) {
    throw new Error("Protected authority root must be an exact absolute path");
  }
  return exactChild(authorityRoot, relativePath, label);
}

/**
 * A protected shell's immutable metadata remains in app.asar, but its mutable
 * launch grant and receipts must be kept in the transaction-owned user root.
 * Writing either into app.asar after contained signing would invalidate the
 * candidate that the grant is intended to prove. Health launches may point at
 * their sealed disposable root; normal launches always use the exact root
 * recorded by the candidate metadata.
 */
function resolveAuthorityRoot(metadata) {
  const healthRoot = process.env.TWEAKERS_HEALTH_USER_ROOT;
  if (process.env.TWEAKERS_HEALTH_CHECK_ONLY === "1" && isExactAbsolutePath(healthRoot)) {
    return healthRoot;
  }
  if (!isExactAbsolutePath(metadata.authorityRoot)) {
    throw new Error("Protected metadata authority root is invalid");
  }
  return metadata.authorityRoot;
}

function armUpdateQuarantine(bootstrap, metadata, authorityRoot, receipt) {
  if (metadata.updateQuarantineFile === undefined) return;
  const quarantineFile = resolveAuthorityFile(
    authorityRoot,
    metadata.updateQuarantineFile,
    "Protected update quarantine path",
  );
  if (typeof bootstrap.armProtectedUpdateQuarantine !== "function") {
    throw new Error("Protected update quarantine authority is unavailable");
  }
  bootstrap.armProtectedUpdateQuarantine({
    transactionId: metadata.transactionId,
    attempt: metadata.attempt,
    preflightReceiptSha256: receipt.receiptSha256,
    armedAt: receipt.emittedAt,
    // This is deliberately mode-independent.  Any update path must consume a
    // fresh authority instead of restoring a bundled backend behind the
    // protected loader's back.
    normalLaunchBlockedUntilFreshAuthority: true,
  }, (marker) => writeJsonAtomically(quarantineFile, marker));
}

function loadReviewedRuntime(metadata, authorityRoot) {
  if (metadata.uiFeatures !== "on") return;
  const runtimeMain = resolveAuthorityFile(authorityRoot, metadata.runtimeMain, "Protected reviewed runtime path");
  if (typeof metadata.runtimeMainSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(metadata.runtimeMainSha256)) {
    throw new Error("Protected reviewed runtime digest is invalid");
  }
  const status = fs.lstatSync(runtimeMain);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error("Protected reviewed runtime main must be a regular file");
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(runtimeMain)).digest("hex");
  if (actual.toLowerCase() !== metadata.runtimeMainSha256.toLowerCase()) {
    throw new Error("Protected reviewed runtime digest mismatch");
  }
  const runtimeDirectory = path.dirname(runtimeMain);
  Module.globalPaths.push(path.join(runtimeDirectory, "node_modules"));
  process.env.TWEAKERS_USER_ROOT = authorityRoot;
  process.env.TWEAKERS_RUNTIME = runtimeDirectory;
  process.env.TWEAKER_USER_ROOT = authorityRoot;
  process.env.TWEAKER_RUNTIME = runtimeDirectory;
  require(runtimeMain);
}

/**
 * Capture the pre-main module path from inside the protected loader itself.
 * The later UI-off absence receipt binds this exact trace digest; it cannot be
 * substituted with an installer-side guess about what Electron loaded.
 */
function recordProtectedRuntimeLoadTrace(metadata, root, authorityRoot, receipt) {
  if (metadata.runtimeLoadTraceFile === undefined) return;
  const traceFile = resolveAuthorityFile(
    authorityRoot,
    metadata.runtimeLoadTraceFile,
    "Protected runtime load trace path",
  );
  const loaderPath = exactChild(root, "protected-loader.cjs", "Protected loader path");
  const originalMain = exactChild(root, metadata.originalMain, "Recorded OpenAI main path");
  const events = [
    { sequence: 1, kind: "module-load", originPath: loaderPath, target: loaderPath, sha256: null },
    { sequence: 2, kind: "module-load", originPath: loaderPath, target: originalMain, sha256: null },
  ];
  writeJsonAtomically(traceFile, {
    schemaVersion: 1,
    kind: "protected-runtime-load-trace",
    transactionId: metadata.transactionId,
    attempt: metadata.attempt,
    preflightReceiptSha256: receipt.receiptSha256,
    uiFeatures: metadata.uiFeatures,
    events,
    recordedAt: new Date().toISOString(),
  });
}

/**
 * Preflight and then load exactly the recorded OpenAI main entry.  This is a
 * deliberately dependency-injected function so candidate tests can provide
 * a sealed metadata/grant directory without loading Electron.
 */
function bootstrapProtectedApp(options = {}) {
  const root = options.root || __dirname;
  const metadataFile = exactChild(root, METADATA_FILE, "Protected metadata path");
  const metadata = readJson(metadataFile, "Protected metadata");
  const authorityRoot = resolveAuthorityRoot(metadata);
  const grantFile = resolveAuthorityFile(authorityRoot, metadata.grantFile, "Protected launch grant path");
  const receiptFile = resolveAuthorityFile(authorityRoot, metadata.preflightReceiptFile, "Protected preflight receipt path");
  const originalMain = exactChild(root, metadata.originalMain, "Recorded OpenAI main path");
  const bootstrapFile = exactChild(root, BOOTSTRAP_FILE, "Protected bootstrap path");
  const bootstrap = options.bootstrap || require(bootstrapFile);
  if (!bootstrap || typeof bootstrap.runProtectedBootstrapPreflight !== "function"
    || typeof bootstrap.applyProtectedBootstrapEnvironment !== "function") {
    throw new Error("Protected bootstrap implementation is unavailable");
  }

  const grant = readJson(grantFile, "Applied pending launch grant");
  const desktop = options.desktop || {
    pid: process.pid,
    kernelStart: process.env.TWEAKERS_DESKTOP_KERNEL_START || "unbound-kernel-start",
  };
  const receipt = bootstrap.runProtectedBootstrapPreflight({
    grant,
    expectedTransactionId: metadata.transactionId,
    expectedAttempt: metadata.attempt,
    desktop,
  }, {
    consumeGrant: (expected, consumed) => {
      const current = readJson(grantFile, "Applied pending launch grant");
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      writeJsonAtomically(grantFile, consumed);
      return true;
    },
    emit: (next) => writeJsonAtomically(receiptFile, next),
    probeVersion: options.probeVersion || (() => metadata.backendVersion),
    probeArchitecture: options.probeArchitecture || (() => "arm64"),
  });
  if (receipt.verdict !== "PASS") {
    // Never clear CODEX_CLI_PATH or fall back to the bundled backend here.
    throw new Error(`Protected bootstrap preflight failed: ${receipt.reason || "unknown"}`);
  }
  const environment = bootstrap.applyProtectedBootstrapEnvironment(receipt, process.env);
  process.env.CODEX_CLI_PATH = environment.CODEX_CLI_PATH;
  process.env.TWEAKERS_PROTECTED_TRANSACTION_ID = metadata.transactionId;
  process.env.TWEAKERS_PROTECTED_ATTEMPT = String(metadata.attempt);
  process.env.TWEAKERS_PROTECTED_PREFLIGHT_RECEIPT = receiptFile;
  process.env.TWEAKERS_PROTECTED_AUTHORITY_ROOT = authorityRoot;
  armUpdateQuarantine(bootstrap, metadata, authorityRoot, receipt);
  recordProtectedRuntimeLoadTrace(metadata, root, authorityRoot, receipt);
  // UI-on uses the same passed protected preflight as UI-off. Only after that
  // PASS may it load the digest-bound reviewed runtime before OpenAI main.
  loadReviewedRuntime(metadata, authorityRoot);
  if (typeof options.loadMain === "function") return options.loadMain(originalMain, receipt);
  return require(originalMain);
}

module.exports = {
  bootstrapProtectedApp,
  exactChild,
  loadReviewedRuntime,
  recordProtectedRuntimeLoadTrace,
};

if (require.main === module) bootstrapProtectedApp();

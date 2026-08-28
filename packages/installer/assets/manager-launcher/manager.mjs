// src/manager-status-cli.ts
import { createHash as createHash3 } from "node:crypto";
import { lstatSync, readFileSync as readFileSync2, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join as join3, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/manager-contract.ts
import { createHash } from "node:crypto";
var MANAGER_PROTOCOL_VERSION = 1;
var MANAGER_STATUS_SCHEMA_VERSION = 1;
var TWEAKERS_MANAGER_ID = "com.thomashulihan.tweakers";
function canonicalManagerJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Manager state-token inputs must not contain non-finite numbers");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalManagerJson).join(",")}]`;
      return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonicalManagerJson(value[key])}`).join(",")}}`;
    default:
      throw new Error("Manager state-token inputs must be JSON values");
  }
}
function createManagerStateToken(inputs) {
  const digest = createHash("sha256").update(canonicalManagerJson(inputs), "utf8").digest("hex");
  return `sha256:${digest}`;
}

// src/manager-status.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";

// src/paths.ts
import { platform as platform2 } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// src/ownership.ts
import { execFileSync } from "node:child_process";
import { homedir, platform, userInfo } from "node:os";
function targetUserHome() {
  if (platform() === "win32") return homedir();
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  return resolveTargetUserHome({
    currentUid,
    sudoUser: process.env.SUDO_USER,
    fallbackHome: homedir(),
    lookupHome: resolveUserHome
  });
}
function resolveTargetUserHome(input) {
  if (input.currentUid !== 0) return input.fallbackHome;
  const sudoUser = input.sudoUser;
  if (!sudoUser || sudoUser === "root") return input.fallbackHome;
  return input.lookupHome(sudoUser) ?? input.fallbackHome;
}
function resolveUserHome(username) {
  try {
    if (platform() === "darwin") {
      const out2 = execFileSync("dscl", [".", "-read", `/Users/${username}`, "NFSHomeDirectory"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      const home = out2.match(/\bNFSHomeDirectory:\s*(.+)\s*$/m)?.[1]?.trim();
      return home || null;
    }
    const out = execFileSync("getent", ["passwd", username], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split(":")[5] || null;
  } catch {
    return null;
  }
}

// src/legacy-compat.ts
var LEGACY_DATA_DIR = ["codex", "plusplus"].join("-");
var LEGACY_HOME_ENV = ["CODEX", "PLUSPLUS", "HOME"].join("_");
var LEGACY_WATCHER_ENV = ["CODEX", "PLUSPLUS", "WATCHER"].join("_");
var LEGACY_USER_ROOT_ENV = ["CODEX", "PLUSPLUS", "USER_ROOT"].join("_");
var LEGACY_RUNTIME_ENV = ["CODEX", "PLUSPLUS", "RUNTIME"].join("_");
var LEGACY_MANUAL_UPDATE_ENV = ["CODEX", "PLUSPLUS", "MANUAL_UPDATE"].join("_");
var LEGACY_REPO_ENV = ["CODEX", "PLUSPLUS", "REPO"].join("_");
var LEGACY_REF_ENV = ["CODEX", "PLUSPLUS", "REF"].join("_");
var LEGACY_SOURCE_DIR_ENV = ["CODEX", "PLUSPLUS", "SOURCE_DIR"].join("_");
var LEGACY_CONFIG_KEY = ["codex", "Plus", "Plus"].join("");
var LEGACY_ASAR_META_KEY = ["__codex", "pp"].join("");
var LEGACY_LOADER_FILE = ["codex", "plusplus-loader.cjs"].join("-");
var LEGACY_WATCHER_STEM = ["codex", "plusplus-watcher"].join("-");
var LEGACY_LAUNCHD_LABEL = ["com", "codexplusplus", "watcher"].join(".");
var LEGACY_DEV_SNAPSHOT_FILE = [".codex", "pp-dev-snapshot.json"].join("");

// src/paths.ts
function userPaths() {
  const root = userRoot();
  const paths = {
    root,
    runtime: join(root, "runtime"),
    managedMcpRoot: join(root, "managed-mcp"),
    tweaks: join(root, "tweaks"),
    backup: join(root, "backup"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    deferredRepairFile: join(root, "deferred-repair.json"),
    updateModeFile: join(root, "update-mode.json"),
    selfUpdateStateFile: join(root, "self-update-state.json"),
    binDir: join(root, "bin"),
    logDir: join(root, "log"),
    transactionRoot: join(root, "transactions", "app-install"),
    transactionStateFile: join(root, "transactions", "app-install.json"),
    environmentRegistryFile: join(root, "environment-registry.json"),
    environmentProfileFile: join(root, "environment-registry.json"),
    legacyEnvironmentProfileFile: join(root, "environment-profiles.json"),
    environmentSelectionFile: join(root, "environment-selection.json"),
    environmentTransactionFile: join(root, "transactions", "environment.json"),
    environmentReceiptRoot: join(root, "transactions", "environment"),
    environmentLockFile: join(root, "transactions", "environment.lock"),
    environmentRuntimeProofFile: join(root, "environment-runtime-proof.json"),
    desktopUpdateReceiptFile: join(root, "transactions", "desktop-update.json"),
    desktopUpdateArchiveRoot: join(root, "transactions", "desktop-update"),
    desktopUpdateLockFile: join(root, "transactions", "desktop-update.lock"),
    desktopUpdateHeartbeatFile: join(root, "transactions", "desktop-update.heartbeat.json"),
    desktopUpdateLogFile: join(root, "log", "desktop-update.log"),
    environmentWatcherPromotionFile: join(root, "transactions", "environment-watcher.json"),
    environmentModeCacheRoot: join(root, "environment-cache"),
    environmentModeCacheCurrentFile: join(root, "environment-cache", "current.json"),
    environmentModeCacheGenerationsRoot: join(root, "environment-cache", "generations"),
    environmentModeCachePreparationRoot: join(root, "environment-cache", "next"),
    environmentModeCacheLockFile: join(root, "environment-cache", "environment-mode-cache.lock")
  };
  return paths;
}
function userRoot() {
  if (process.env.TWEAKER_HOME) return process.env.TWEAKER_HOME;
  if (process.env.TWEAKERS_HOME) return process.env.TWEAKERS_HOME;
  if (process.env.TWEAKERS_USER_ROOT) return process.env.TWEAKERS_USER_ROOT;
  if (process.env.TWEAKER_USER_ROOT) return process.env.TWEAKER_USER_ROOT;
  const legacyUserRoot = process.env[LEGACY_USER_ROOT_ENV];
  if (legacyUserRoot) return legacyUserRoot;
  const legacyHome = process.env[LEGACY_HOME_ENV];
  if (legacyHome) return legacyHome;
  if (process.env.TWEAKERS_TEST_ROOT_PRELOAD === "active" && process.env.TWEAKERS_TEST_FALLBACK_ROOT) {
    return process.env.TWEAKERS_TEST_FALLBACK_ROOT;
  }
  const home = targetUserHome();
  switch (platform2()) {
    case "darwin":
      return existingInstallRoot(
        join(home, "Library", "Application Support", "Tweakers"),
        join(home, "Library", "Application Support", LEGACY_DATA_DIR)
      );
    case "win32":
      return existingInstallRoot(
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Tweakers"),
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), LEGACY_DATA_DIR)
      );
    default:
      return existingInstallRoot(join(
        process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
        "Tweakers"
      ), join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), LEGACY_DATA_DIR));
  }
}
function existingInstallRoot(nextRoot, legacyRoot) {
  return existsSync(legacyRoot) ? legacyRoot : nextRoot;
}

// src/manager-status.ts
var UPDATE_MODE_MAX_AGE_MS = 6 * 60 * 60 * 1e3;
var MAX_CODEX_DERIVED_RECEIPTS = 64;
var RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function managerStatusPaths(root) {
  return {
    root,
    configFile: join2(root, "config.json"),
    stateFile: join2(root, "state.json"),
    updateModeFile: join2(root, "update-mode.json"),
    environmentRegistryFile: join2(root, "environment-registry.json"),
    environmentSelectionFile: join2(root, "environment-selection.json"),
    environmentTransactionFile: join2(root, "transactions", "environment.json"),
    desktopUpdateReceiptFile: join2(root, "transactions", "desktop-update.json"),
    environmentModeCacheCurrentFile: join2(root, "environment-cache", "current.json"),
    lifecycleLockFile: join2(root, "transactions", "lifecycle.lock"),
    managerOperationRoot: join2(root, "transactions", "manager-operations"),
    managedRuntimeProvenanceFile: join2(root, "managed-runtime", "current", ".tweakers-provenance.json"),
    codexDerivedReceiptRoot: join2(root, "codex-source", "receipts")
  };
}
function createTweakersManagerReadOnlyStatusSnapshot(input, dependencies = {}) {
  const paths = input.paths ?? managerStatusPaths(userPaths().root);
  const readText = dependencies.readText ?? defaultReadText;
  const readDirectory = dependencies.readDirectory ?? defaultReadDirectory;
  const now = dependencies.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const generatedAt = assertRfc3339(now(), "manager status clock");
  const config = readDocument(paths.configFile, readText);
  const installerState = readDocument(paths.stateFile, readText);
  const updateMode = readDocument(paths.updateModeFile, readText);
  const environmentRegistry = readDocument(paths.environmentRegistryFile, readText);
  const environmentSelection = readDocument(paths.environmentSelectionFile, readText);
  const environmentReceipt = readDocument(paths.environmentTransactionFile, readText);
  const desktopReceipt = readDocument(paths.desktopUpdateReceiptFile, readText);
  const modeCacheReceipt = readDocument(paths.environmentModeCacheCurrentFile, readText);
  const runtimeProvenance = readDocument(paths.managedRuntimeProvenanceFile, readText);
  const lifecycleLock = readText(paths.lifecycleLockFile);
  const installation = observeInstallation(installerState);
  const mode = observeMode(installerState, updateMode, generatedAt);
  const environment = observeEnvironment(environmentRegistry, environmentSelection, modeCacheReceipt);
  const updater = observeUpdater(desktopReceipt);
  const runtime = observeRuntime(runtimeProvenance);
  const receipts = [
    observeEnvironmentReceipt(environmentReceipt),
    observeDesktopUpdateReceipt(desktopReceipt),
    observeModeCacheReceipt(modeCacheReceipt),
    ...observeCodexDerivedReceipts(paths.codexDerivedReceiptRoot, readText, readDirectory)
  ];
  const coordinator = observeCoordinator(receipts, lifecycleLock);
  const operations = {
    state: "missing",
    revision: "status-only",
    activeOperationId: null,
    preparedCount: 0,
    problem: null
  };
  const stateTokenInputs = {
    schemaVersion: MANAGER_STATUS_SCHEMA_VERSION,
    manager: {
      id: TWEAKERS_MANAGER_ID,
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      executable: input.executable
    },
    configurationRevision: config.revision,
    installation: {
      state: installation.state,
      version: installation.version,
      appRoot: installation.appRoot,
      runtimeUpdatedAt: installation.runtimeUpdatedAt,
      revision: installation.revision
    },
    mode,
    environment,
    updater,
    runtime,
    coordinator: {
      state: coordinator.state,
      activeOperationId: coordinator.activeOperationId
    },
    operations,
    receiptChronology: receipts.map((receipt) => ({
      source: receipt.entry.source,
      receiptId: receipt.entry.receiptId,
      phase: receipt.entry.phase,
      updatedAt: receipt.entry.updatedAt,
      terminalAt: receipt.entry.terminalAt,
      error: receipt.entry.error,
      state: receipt.entry.state,
      revision: receipt.entry.revision,
      active: receipt.entry.active
    })),
    allowedActions: []
  };
  return deepFreeze({
    protocolVersion: MANAGER_PROTOCOL_VERSION,
    managerId: TWEAKERS_MANAGER_ID,
    generatedAt,
    stateToken: createManagerStateToken(stateTokenInputs),
    status: {
      schemaVersion: MANAGER_STATUS_SCHEMA_VERSION,
      installation,
      mode,
      environment,
      updater,
      runtime,
      coordinator,
      operations,
      receipts: receipts.map((receipt) => receipt.entry)
    },
    actions: [],
    stateTokenInputs
  });
}
function defaultReadText(path) {
  try {
    return { state: "present", text: readFileSync(path, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { state: "missing" };
    return { state: "unreadable", problem: errorMessage(error) };
  }
}
function defaultReadDirectory(path) {
  try {
    return { state: "present", entries: readdirSync(path).sort((left, right) => left.localeCompare(right)) };
  } catch (error) {
    if (isMissingFileError(error)) return { state: "missing" };
    return { state: "unreadable", problem: errorMessage(error) };
  }
}
function readDocument(path, readText) {
  const file = readText(path);
  if (file.state === "missing") return { state: "missing", revision: "missing", value: null, problem: null };
  if (file.state === "unreadable") {
    return { state: "unreadable", revision: "unreadable", value: null, problem: file.problem };
  }
  const revision = sha256(file.text);
  try {
    const value = JSON.parse(file.text);
    if (!isRecord(value)) return { state: "malformed", revision, value: null, problem: "expected a JSON object" };
    return { state: "valid", revision, value, problem: null };
  } catch (error) {
    return { state: "malformed", revision, value: null, problem: `invalid JSON: ${errorMessage(error)}` };
  }
}
function observeInstallation(document) {
  if (document.state === "missing") {
    return { state: "not-installed", version: null, installedAt: null, appRoot: null, runtimeUpdatedAt: null, revision: document.revision };
  }
  if (document.state !== "valid" || document.value === null) {
    return { state: document.state === "unreadable" ? "unreadable" : "malformed", version: null, installedAt: null, appRoot: null, runtimeUpdatedAt: null, revision: document.revision };
  }
  const version = stringValue(document.value.version);
  const installedAt = isoValue(document.value.installedAt);
  const appRoot = stringValue(document.value.appRoot);
  const runtimeUpdatedAt = document.value.runtimeUpdatedAt === void 0 ? null : nullableIsoValue(document.value.runtimeUpdatedAt);
  if (version === null || installedAt === null || appRoot === null || runtimeUpdatedAt === void 0) {
    return { state: "malformed", version: null, installedAt: null, appRoot: null, runtimeUpdatedAt: null, revision: document.revision };
  }
  return { state: "installed", version, installedAt, appRoot, runtimeUpdatedAt, revision: document.revision };
}
function observeMode(installer, updateMode, now) {
  const current = installer.state === "valid" && installer.value !== null ? installer.value.mode === "chatgpt" || installer.value.mode === "tweakers" ? installer.value.mode : "unknown" : "unknown";
  if (updateMode.state === "missing") {
    return { current, updatePause: { state: "inactive", enabledAt: null, codexVersion: null, revision: updateMode.revision } };
  }
  if (updateMode.state !== "valid" || updateMode.value === null) {
    return {
      current,
      updatePause: {
        state: updateMode.state === "unreadable" ? "unreadable" : "malformed",
        enabledAt: null,
        codexVersion: null,
        revision: updateMode.revision
      }
    };
  }
  const enabledAt = isoValue(updateMode.value.enabledAt);
  const codexVersion = nullableStringValue(updateMode.value.codexVersion);
  if (enabledAt === null || codexVersion === void 0) {
    return { current, updatePause: { state: "malformed", enabledAt: null, codexVersion: null, revision: updateMode.revision } };
  }
  const enabledMs = Date.parse(enabledAt);
  const nowMs = Date.parse(now);
  const fresh = Number.isFinite(enabledMs) && Number.isFinite(nowMs) && nowMs - enabledMs < UPDATE_MODE_MAX_AGE_MS;
  return { current, updatePause: { state: fresh ? "active" : "stale", enabledAt, codexVersion, revision: updateMode.revision } };
}
function observeEnvironment(registry, selection, modeCache) {
  const selectionState = selection.state;
  const selectionValue = selection.value;
  const releaseProfile = selectionValue?.releaseProfile === "stable" || selectionValue?.releaseProfile === "alpha" ? selectionValue.releaseProfile : null;
  const experience = selectionValue?.appExperience === "chatgpt" || selectionValue?.appExperience === "tweakers" ? selectionValue.appExperience : null;
  const migrationState = nullableStringValue(selectionValue?.migrationState);
  const selectionMalformed = selectionState === "valid" && (releaseProfile === null || experience === null || migrationState === void 0);
  const cache = observeModeCache(modeCache);
  return {
    selection: {
      state: selectionMalformed ? "malformed" : selectionState,
      releaseProfile: selectionMalformed ? null : releaseProfile,
      experience: selectionMalformed ? null : experience,
      migrationState: selectionMalformed ? null : migrationState ?? null,
      revision: selection.revision,
      problem: selectionMalformed ? "selection is missing v2 environment fields" : selection.problem
    },
    registry: { state: registry.state, revision: registry.revision, problem: registry.problem },
    modeCache: cache
  };
}
function observeModeCache(document) {
  if (document.state === "missing") {
    return { state: "unavailable", generationId: null, pinState: null, revision: document.revision, problem: null };
  }
  if (document.state !== "valid" || document.value === null) {
    return {
      state: document.state === "unreadable" ? "unreadable" : "malformed",
      generationId: null,
      pinState: null,
      revision: document.revision,
      problem: document.problem
    };
  }
  const generationId = stringValue(document.value.generationId);
  const pin = recordValue(document.value.pin);
  const pinState = stringValue(pin?.state);
  const releasedAt = nullableIsoValue(pin?.releasedAt);
  if (generationId === null || pinState === null || releasedAt === void 0) {
    return { state: "malformed", generationId: null, pinState: null, revision: document.revision, problem: "invalid mode-cache receipt" };
  }
  const state = pinState === "prepared" && releasedAt === null ? "ready" : pinState === "post_cutover_recovery" ? "preparing" : "stale";
  return { state, generationId, pinState, revision: document.revision, problem: null };
}
function observeUpdater(document) {
  if (document.state === "missing") {
    return { state: "idle", transactionId: null, phase: null, resumable: null, safeOfficialMode: null, error: null, revision: document.revision, problem: null };
  }
  if (document.state !== "valid" || document.value === null) {
    return {
      state: document.state === "unreadable" ? "unreadable" : "malformed",
      transactionId: null,
      phase: null,
      resumable: null,
      safeOfficialMode: null,
      error: null,
      revision: document.revision,
      problem: document.problem
    };
  }
  const transactionId = stringValue(document.value.transactionId);
  const phase = stringValue(document.value.phase);
  const resumable = booleanValue(document.value.resumable);
  const safeOfficialMode = booleanValue(document.value.safeOfficialMode);
  const updatedAt = isoValue(document.value.updatedAt);
  const error = nullableStringValue(document.value.error);
  if (transactionId === null || phase === null || resumable === null || safeOfficialMode === null || updatedAt === null || error === void 0) {
    return { state: "malformed", transactionId: null, phase: null, resumable: null, safeOfficialMode: null, error: null, revision: document.revision, problem: "invalid desktop-update receipt" };
  }
  const active = isActiveDesktopPhase(phase, resumable, safeOfficialMode, error);
  return {
    state: active ? "active" : "terminal",
    transactionId,
    phase,
    resumable,
    safeOfficialMode,
    error,
    revision: document.revision,
    problem: null
  };
}
function observeRuntime(document) {
  if (document.state !== "valid" || document.value === null) {
    return {
      state: document.state,
      provenanceKind: null,
      installedAt: null,
      sourceRuntimeHash: null,
      revision: document.revision,
      problem: document.problem
    };
  }
  const kind = nullableStringValue(document.value.kind);
  const installedAt = nullableIsoValue(document.value.installedAt);
  const sourceRuntimeHash = nullableStringValue(document.value.sourceRuntimeHash);
  if (kind === void 0 || installedAt === void 0 || sourceRuntimeHash === void 0) {
    return { state: "malformed", provenanceKind: null, installedAt: null, sourceRuntimeHash: null, revision: document.revision, problem: "invalid runtime provenance" };
  }
  return { state: "valid", provenanceKind: kind, installedAt, sourceRuntimeHash, revision: document.revision, problem: null };
}
function observeEnvironmentReceipt(document) {
  return observeReceipt(document, "environment", (value) => {
    if (value.schemaVersion !== 1 || value.kind !== "environment") return null;
    const receiptId = stringValue(value.transactionId);
    const phase = stringValue(value.phase);
    const createdAt = isoValue(value.createdAt);
    const updatedAt = isoValue(value.updatedAt);
    const error = nullableStringValue(value.error);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || error === void 0) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: nullableIsoValue(value.committedAt) ?? nullableIsoValue(value.rolledBackAt) ?? nullableIsoValue(value.cancelledAt) ?? null,
      error,
      active: !["committed", "rolled-back", "failed", "cancelled"].includes(phase)
    };
  });
}
function observeDesktopUpdateReceipt(document) {
  return observeReceipt(document, "desktop-update", (value) => {
    if (value.schemaVersion !== 1 || value.kind !== "desktop-update") return null;
    const receiptId = stringValue(value.transactionId);
    const phase = stringValue(value.phase);
    const createdAt = isoValue(value.createdAt);
    const updatedAt = isoValue(value.updatedAt);
    const resumable = booleanValue(value.resumable);
    const safeOfficialMode = booleanValue(value.safeOfficialMode);
    const error = nullableStringValue(value.error);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || resumable === null || safeOfficialMode === null || error === void 0) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: nullableIsoValue(value.terminalAt) ?? nullableIsoValue(value.completedAt) ?? nullableIsoValue(value.rolledBackAt) ?? null,
      error,
      active: isActiveDesktopPhase(phase, resumable, safeOfficialMode, error)
    };
  });
}
function observeModeCacheReceipt(document) {
  return observeReceipt(document, "environment-mode-cache", (value) => {
    if (value.schemaVersion !== 2 || value.kind !== "environment-mode-pair") return null;
    const receiptId = stringValue(value.generationId);
    const pin = recordValue(value.pin);
    const timestamps = recordValue(value.timestamps);
    const phase = stringValue(pin?.state);
    const createdAt = isoValue(timestamps?.preparedAt);
    const updatedAt = isoValue(timestamps?.validatedAt);
    const releasedAt = nullableIsoValue(pin?.releasedAt);
    if (receiptId === null || phase === null || createdAt === null || updatedAt === null || releasedAt === void 0) return null;
    return {
      receiptId,
      phase,
      createdAt,
      updatedAt,
      terminalAt: releasedAt,
      error: null,
      active: ["prepared", "post_cutover_recovery"].includes(phase) && releasedAt === null
    };
  });
}
function observeCodexDerivedReceipts(root, readText, readDirectory) {
  const directory = readDirectory(root);
  if (directory.state === "missing") return [];
  if (directory.state === "unreadable") {
    return [{
      entry: malformedReceipt("codex-derived", "unreadable", directory.problem),
      activeOperationId: null
    }];
  }
  const names = directory.entries.filter((name) => name.endsWith(".json")).slice(0, MAX_CODEX_DERIVED_RECEIPTS);
  const receipts = names.map((name) => {
    const document = readDocument(join2(root, name), readText);
    return observeReceipt(document, "codex-derived", (value) => {
      if (value.schemaVersion !== 1 && value.schemaVersion !== 2 || value.kind !== "codex-derived") return null;
      const receiptId = stringValue(value.transactionId);
      const phase = stringValue(value.phase);
      const createdAt = isoValue(value.createdAt);
      const updatedAt = isoValue(value.updatedAt);
      const error = nullableStringValue(value.error);
      if (receiptId === null || phase === null || createdAt === null || updatedAt === null || error === void 0) return null;
      return {
        receiptId,
        phase,
        createdAt,
        updatedAt,
        terminalAt: nullableIsoValue(value.soakCompletedAt) ?? nullableIsoValue(value.rolledBackAt) ?? null,
        error,
        active: !["completed", "rolled-back", "failed", "superseded"].includes(phase)
      };
    });
  });
  if (directory.entries.filter((name) => name.endsWith(".json")).length > MAX_CODEX_DERIVED_RECEIPTS) {
    receipts.push({
      entry: malformedReceipt("codex-derived", "malformed", `too many codex-derived receipts (maximum ${MAX_CODEX_DERIVED_RECEIPTS})`),
      activeOperationId: null
    });
  }
  return receipts;
}
function observeReceipt(document, source, parse) {
  if (document.state === "missing") {
    return { entry: { source, receiptId: null, phase: null, createdAt: null, updatedAt: null, terminalAt: null, error: null, state: "missing", revision: document.revision, active: false, problem: null }, activeOperationId: null };
  }
  if (document.state !== "valid" || document.value === null) {
    return {
      entry: malformedReceipt(
        source,
        document.state === "unreadable" ? "unreadable" : "malformed",
        document.problem,
        document.revision
      ),
      activeOperationId: null
    };
  }
  const parsed = parse(document.value);
  if (parsed === null) {
    return {
      entry: malformedReceipt(
        source,
        "malformed",
        "receipt is missing required v1 chronology fields",
        document.revision
      ),
      activeOperationId: null
    };
  }
  return {
    entry: {
      source,
      receiptId: parsed.receiptId,
      phase: parsed.phase,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      terminalAt: parsed.terminalAt,
      error: parsed.error,
      state: "valid",
      revision: document.revision,
      active: parsed.active,
      problem: null
    },
    activeOperationId: parsed.active ? parsed.receiptId : null
  };
}
function malformedReceipt(source, state, problem, revision = state) {
  return { source, receiptId: null, phase: null, createdAt: null, updatedAt: null, terminalAt: null, error: null, state, revision, active: false, problem };
}
function observeCoordinator(receipts, lifecycleLock) {
  const activeIds = receipts.map((receipt) => receipt.activeOperationId).filter((receiptId) => receiptId !== null);
  const lifecycleLockState = lifecycleLock.state === "missing" ? "absent" : lifecycleLock.state === "present" ? "present" : "unreadable";
  if (activeIds.length > 1) {
    return { state: "conflicted", activeOperationId: null, lifecycleLock: lifecycleLockState, problem: `multiple active receipts: ${activeIds.join(", ")}` };
  }
  if (activeIds.length === 1) {
    return { state: "active", activeOperationId: activeIds[0], lifecycleLock: lifecycleLockState, problem: null };
  }
  if (lifecycleLock.state === "unreadable") {
    return { state: "unknown", activeOperationId: null, lifecycleLock: lifecycleLockState, problem: lifecycleLock.problem };
  }
  return { state: "idle", activeOperationId: null, lifecycleLock: lifecycleLockState, problem: null };
}
function isActiveDesktopPhase(phase, resumable, safeOfficialMode, error) {
  if (!["completed", "failed", "rolled_back"].includes(phase)) return true;
  if (resumable) return true;
  return phase === "failed" && (!safeOfficialMode || /\brollback failed\b/i.test(error ?? ""));
}
function sha256(text) {
  return `sha256:${createHash2("sha256").update(text, "utf8").digest("hex")}`;
}
function assertRfc3339(value, label) {
  if (!RFC3339_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must return an RFC3339 timestamp`);
  }
  return value;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function recordValue(value) {
  return isRecord(value) ? value : null;
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function nullableStringValue(value) {
  if (value === null) return null;
  return typeof value === "string" ? value : void 0;
}
function booleanValue(value) {
  return typeof value === "boolean" ? value : null;
}
function isoValue(value) {
  return typeof value === "string" && RFC3339_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function nullableIsoValue(value) {
  if (value === null) return null;
  return isoValue(value) ?? void 0;
}
function isMissingFileError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

// src/manager-status-cli.ts
var MANAGER_LAUNCHER_NAME = "Tweakers Manager Launcher";
var LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseTweakersManagerStatusArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "status" || argv[1] !== "--request-id" || argv[3] !== "--json") {
    throw new Error("Expected: status --request-id <lowercase-uuid> --json");
  }
  const requestId = argv[2] ?? "";
  if (!LOWERCASE_UUID.test(requestId)) throw new Error("request-id must be a lowercase RFC4122 UUID");
  return { requestId };
}
function runTweakersManagerStatusCli(argv, dependencies = {}) {
  const write = dependencies.write ?? ((line) => writeSync(1, line));
  const now = dependencies.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  let requestId = maybeRequestId(argv);
  try {
    const parsed = parseTweakersManagerStatusArguments(argv);
    requestId = parsed.requestId;
    const executable = (dependencies.executable ?? resolveManagerExecutableIdentity)();
    const snapshot = (dependencies.status ?? createTweakersManagerReadOnlyStatusSnapshot)({ executable });
    const response = {
      protocolVersion: snapshot.protocolVersion,
      managerId: snapshot.managerId,
      requestId: parsed.requestId,
      generatedAt: snapshot.generatedAt,
      stateToken: snapshot.stateToken,
      status: snapshot.status,
      actions: []
    };
    write(`${JSON.stringify(response)}
`);
    return 0;
  } catch (error) {
    write(`${JSON.stringify({
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      managerId: TWEAKERS_MANAGER_ID,
      requestId,
      generatedAt: safeNow(now),
      error: {
        code: argv[0] && argv[0] !== "status" ? "unsupported_action" : "invalid_request",
        message: errorMessage2(error),
        retryable: false
      }
    })}
`);
    return 64;
  }
}
function resolveManagerExecutableIdentity(entrypoint = process.argv[1]) {
  try {
    if (!entrypoint) throw new Error("manager bundle entrypoint is unavailable");
    if (!isAbsolute(entrypoint) || resolve(entrypoint) !== entrypoint) {
      throw new Error("manager bundle entrypoint must be an exact absolute path");
    }
    const bundle = realpathSync(entrypoint);
    const launcher = join3(dirname(bundle), MANAGER_LAUNCHER_NAME);
    const stat = lstatSync(launcher);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(launcher) !== launcher) {
      throw new Error("fixed sibling launcher is not a canonical regular single-link file");
    }
    return {
      state: "resolved",
      path: launcher,
      sha256: createHash3("sha256").update(readFileSync2(launcher)).digest("hex")
    };
  } catch (error) {
    return { state: "unresolved", reason: errorMessage2(error) };
  }
}
function maybeRequestId(argv) {
  const index = argv.indexOf("--request-id");
  const candidate = index >= 0 ? argv[index + 1] ?? "" : "";
  return LOWERCASE_UUID.test(candidate) ? candidate : null;
}
function safeNow(now) {
  try {
    const value = now();
    return Number.isFinite(Date.parse(value)) ? value : (/* @__PURE__ */ new Date()).toISOString();
  } catch {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function isDirectExecution() {
  const entrypoint = process.argv[1];
  if (!entrypoint || !isAbsolute(entrypoint)) return false;
  try {
    return realpathSync(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isDirectExecution()) process.exitCode = runTweakersManagerStatusCli(process.argv.slice(2));
export {
  parseTweakersManagerStatusArguments,
  resolveManagerExecutableIdentity,
  runTweakersManagerStatusCli
};

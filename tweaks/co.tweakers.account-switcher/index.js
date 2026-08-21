"use strict";

const IPC = "accounts";
const SERVICE_KEY = "__tweakersAccountServiceV1";
const HANDLER_KEY = "__tweakersAccountHandlerV1";
const MAX_AUTH_BYTES = 1024 * 1024;
const INTENT_TTL_MS = 30_000;
const PLUGIN_PROFILE_KEY = "remote-plugin-profile-v1";
const PLUGIN_RECEIPTS_KEY = "remote-plugin-receipts-v1";
const PLUGIN_PROFILE_SCHEMA_VERSION = 1;
const PLUGIN_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const PLUGIN_PROBE_TIMEOUT_MS = 8_000;
const PLUGIN_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const ACCOUNT_ROUTER_SCHEMA_VERSION = 1;
const ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT = "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
const ACCOUNT_ROUTER_CONFIG_NAME = "account-router-config.json";
const ACCOUNT_ROUTER_STATE_NAME = "router-state.json";
const ACCOUNT_ROUTER_CONTROL_SECRET_NAME = "control-secret.v1";
const ACCOUNT_ROUTER_RECEIPTS_NAME = "migration-receipts.v1.json";
const MAX_ROUTER_STATE_BYTES = 512 * 1024;
// These are stable remote package identifiers returned by Codex's experimental
// app-server `plugin/installed` reconciliation endpoint. Keep this list free of
// private/created-by-me plugins: a local account switcher must never assume it
// can safely provision, copy, or even enumerate another account's private work.
const DEFAULT_REQUIRED_PLUGINS = Object.freeze([
  { id: "app-693b20fccbac8191bdc178bb493de3e5@openai-curated-remote", name: "Mailchimp" },
  { id: "app-6a3c407853888191beddc2151c2b6f8b@openai-curated-remote", name: "Resend" },
]);
// Kept inline so the only program, script, and arguments passed to the helper
// are fixed by this source. The inherited fd 3 is a descriptor for the already
// opened home root; no filesystem path crosses the process boundary.
const LEGACY_ANALYTICS_NEUTRALIZER = String.raw`import os

_root_fd = 3
_opened = []

def _trusted_directory(fd, uid):
    _stat = os.fstat(fd)
    return (
        (_stat.st_mode & 0o170000) == 0o040000
        and _stat.st_uid == uid
        and (_stat.st_mode & 0o022) == 0
    )

try:
    _uid = os.getuid()
    _directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    _file_flags = os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    _home_fd = os.open(".", _directory_flags, dir_fd=_root_fd)
    _opened.append(_home_fd)
    _current_fd = _home_fd
    if not _trusted_directory(_current_fd, _uid):
        raise OSError
    for _component in ("Library", "Application Support", "codex-plusplus"):
        _next_fd = os.open(_component, _directory_flags, dir_fd=_current_fd)
        _opened.append(_next_fd)
        _current_fd = _next_fd
        if not _trusted_directory(_current_fd, _uid):
            raise OSError
    _target_fd = os.open("account-analytics.v1.json", _file_flags, dir_fd=_current_fd)
    _opened.append(_target_fd)
    _target_stat = os.fstat(_target_fd)
    if (
        (_target_stat.st_mode & 0o170000) != 0o100000
        or _target_stat.st_uid != _uid
        or _target_stat.st_nlink != 1
        or (_target_stat.st_mode & 0o077) != 0
    ):
        raise OSError
    os.ftruncate(_target_fd, 0)
    os.fsync(_target_fd)
except BaseException:
    pass
finally:
    for _fd in reversed(_opened):
        try:
            os.close(_fd)
        except OSError:
            pass
`;

module.exports = {
  start(api) {
    if (api.process === "main") return startMain(api);
    return startRenderer(api);
  },
  stop() {
    if (typeof window === "undefined") {
      const service = globalThis[SERVICE_KEY];
      // Disabling this tweak is a staged rollback: retain diagnostic state and
      // isolated homes, but make the next authorized startup take the direct
      // manual path. It never interrupts an already-open stdio session.
      try { service?.disableRouter?.(); } catch {}
      service?.dispose?.();
      if (globalThis[SERVICE_KEY] === service) globalThis[SERVICE_KEY] = null;
      // Remove the IPC handler and reset the guard so a later start() re-registers
      // cleanly instead of leaking a handler bound to a disposed service.
      const unregister = globalThis[HANDLER_KEY];
      if (typeof unregister === "function") { try { unregister(); } catch {} }
      globalThis[HANDLER_KEY] = null;
    } else {
      cleanupRenderer();
    }
  },
  _test: {
    validateReferenceName, validateAuthObject, redact, createAccountService,
    stableRef, authPaths, displayLabelFromAuth, syncActiveSnapshot,
    cleanupLegacyAnalytics, accountMenuTargetFromCandidates, startRenderer, disposeRenderer,
    defaultPluginProfile, normalizePluginProfile, profileHash, evaluatePluginReceipt,
    makePluginReceipt, inventoryPlugins, validateOfficialInventory, runtimeCodexBinding, readOfficialPluginInventory,
    accountRouterPaths, opaqueAccountId, validateRouterConfig, routerPublicStatus,
    stageBalancedRouterConfig, stageManualRouterConfig, resetRouterBalanceEpoch,
    readRouterConfig, readRouterState,
  },
};

function startMain(api) {
  const deps = nodeDeps();
  const paths = authPaths(deps);
  cleanupLegacyAnalytics(deps);
  const service = createAccountService(api, { deps, paths, onSwitched: () => scheduleHostRestart(api) });
  globalThis[SERVICE_KEY] = service;
  if (!globalThis[HANDLER_KEY]) {
    const unregister = api.ipc.handle?.(IPC, (message) => {
      const active = globalThis[SERVICE_KEY];
      if (!active) return safeFailure("unavailable");
      return active.handle(message);
    });
    globalThis[HANDLER_KEY] = typeof unregister === "function" ? unregister : true;
  }
  // Deliberately advisory: startup/update observation consults stored receipts
  // only. Codex's official inventory call can reconcile the active account's
  // remote bundle cache, so it is never invoked automatically here.
  void service.observeStartup();
  api.log.info("Account switcher service ready");
}

function createAccountService(api, options = {}) {
  const deps = options.deps || nodeDeps();
  const paths = options.paths || authPaths(deps);
  // The runtime reads its launch config from this existing tweak data
  // namespace. Main-process APIs expose its real absolute path; tests and
  // older hosts use the same deterministic user-root fallback.
  if (typeof paths.routerDataDir !== "string") {
    paths.routerDataDir = options.routerDataDir || api?.fs?.dataDir
      || deps.path.join(deps.homedir(), "tweak-data", "co.tweakers.account-switcher");
  }
  const intents = new Map();
  const refs = new Map();
  let disposed = false;
  let queue = Promise.resolve();

  const enqueue = (task) => {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const enqueueIntent = (message) => enqueue(() => executeIntent(deps, paths, refs, intents, message, options, api));
  const service = {
    handle(message) {
      if (disposed) return Promise.resolve(safeFailure("unavailable"));
      if (message?.action === "list") return service.list();
      if (message?.action === "plugin-protection-status") return service.pluginProtectionStatus();
      if (message?.action === "plugin-protection-verify-current") return service.verifyCurrentPlugins();
      if (message?.action === "plugin-protection-configure") return service.configurePluginProtection(message);
      if (message?.action === "prepare-switch") return service.prepareSwitch(message.ref, false);
      if (message?.action === "prepare-switch-bypass") return service.prepareSwitch(message.ref, true);
      if (message?.action === "prepare-save") return service.prepareSave(message.name);
      if (message?.action === "switch") return service.switch(message.intent);
      if (message?.action === "save") return service.save(message.intent);
      if (message?.action === "router-status") return service.routerStatus();
      if (message?.action === "router-configure") return service.configureRouter(message);
      if (message?.action === "router-reset-balance-epoch") return service.resetRouterBalanceEpoch();
      return Promise.resolve(safeFailure("invalid-request"));
    },
    async list() { return listAccounts(deps, paths, refs, await pluginProtectionSnapshot(api, deps, paths)); },
    async pluginProtectionStatus() { return pluginProtectionSnapshot(api, deps, paths); },
    // Verification may invoke Codex's reconciliation endpoint. Serialize it
    // with auth-changing operations, then re-check active auth immediately
    // before receipt persistence so a receipt can never be written for the
    // account that was active only when the probe began.
    verifyCurrentPlugins() { return enqueue(() => verifyCurrentPluginReceipt(api, deps, paths, options)); },
    configurePluginProtection(message) { return enqueue(() => configurePluginProtection(api, message)); },
    async prepareSwitch(ref, bypass) {
      return prepareSwitchWithPluginGuard(api, deps, paths, refs, intents, ref, bypass, options);
    },
    prepareSave(name) { return Promise.resolve(prepareIntent(deps, paths, refs, intents, "save", name)); },
    switch(intent) { return enqueueIntent({ action: "switch", intent }); },
    save(intent) { return enqueueIntent({ action: "save", intent }); },
    routerStatus() { return routerStatus(api, deps, paths); },
    configureRouter(message) { return enqueue(() => configureRouter(api, deps, paths, refs, message)); },
    resetRouterBalanceEpoch() { return enqueue(() => resetRouterBalanceEpoch(deps, accountRouterPaths(deps, paths))); },
    disableRouter() { return stageManualRouterConfig(deps, paths); },
    dispose() { disposed = true; stopSnapshotSync(); intents.clear(); refs.clear(); },
    async observeStartup() {
      const result = await pluginProtectionSnapshot(api, deps, paths);
      if (!result.active.valid) api.log?.warn?.("remote plugin protection receipt is not current", result.active.code);
      return { ok: true, pluginProtection: publicPluginProtection(result) };
    },
  };

  // Refresh tokens rotate on every renewal, so a saved snapshot goes stale
  // the moment the live session refreshes; restoring a stale snapshot trips
  // OAuth reuse detection and the server REVOKES the whole token family
  // (observed 2026-07-13). Keep the active account's snapshot in lockstep
  // with auth.json so switching back always presents current tokens.
  const stopSnapshotSync = startActiveSnapshotSync(deps, paths, api, () => disposed);
  return service;
}

function startActiveSnapshotSync(deps, paths, api, isDisposed) {
  const fs = deps.fs;
  if (typeof fs.watch !== "function") return () => {};
  let timer = null;
  let watcher = null;
  const sync = () => {
    timer = null;
    if (isDisposed()) return;
    try {
      syncActiveSnapshot(deps, paths);
    } catch (error) {
      api.log?.warn?.("active account snapshot sync failed", String(error?.code || error));
    }
  };
  try {
    // Watch the directory, not the file: auth.json is replaced atomically
    // (rename), which drops a direct file watch on some platforms.
    watcher = fs.watch(paths.codexDir, { persistent: false }, (_event, name) => {
      if (name && name !== "auth.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(sync, 1_000);
    });
  } catch (error) {
    api.log?.warn?.("active account snapshot sync unavailable", String(error?.code || error));
    return () => {};
  }
  // Also reconcile once at startup: the app may have rotated tokens while
  // this tweak was not running.
  timer = setTimeout(sync, 2_000);
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher?.close(); } catch { /* already closed */ }
  };
}

function syncActiveSnapshot(deps, paths) {
  const fs = deps.fs;
  const marker = readCurrentMarker(fs, paths.currentMarker);
  if (marker.status !== "ok" || !marker.value) return;
  const target = sourceFilePath(deps.path, paths.accountsDir, marker.value);
  let readingSnapshot = true;
  try {
    return withSecureAuth(fs, target, (snapshot) => {
      readingSnapshot = false;
      return withSecureAuth(fs, paths.authFile, (current) => {
        if (!current.bytes.length || current.hash === snapshot.hash) return;
        // Only propagate tokens for the SAME account; a manual re-login to a
        // different account must not overwrite another account's snapshot.
        const currentAccount = authAccountId(current.value);
        const snapshotAccount = authAccountId(snapshot.value);
        if (!currentAccount || currentAccount !== snapshotAccount) return;
        atomicWrite(deps, paths.accountsDir, target, current.bytes);
      });
    });
  } catch (error) {
    if (readingSnapshot) return; // Snapshot missing/invalid: nothing safe to sync into.
    throw error;
  }
}

function authAccountId(value) {
  const id = value?.tokens?.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function listAccounts(deps, paths, refs, protection = null) {
  try {
    refs.clear();
    const accountsDirectoryExists = deps.fs.existsSync(paths.accountsDir);
    if (accountsDirectoryExists) ensureAccountsDirectory(deps.fs, paths.accountsDir, false);
    const current = readCurrentMarker(deps.fs, paths.currentMarker);
    let liveAccountId = null;
    try {
      liveAccountId = withSecureAuth(deps.fs, paths.authFile, (live) => authAccountId(live.value));
    } catch {}
    const accounts = [];
    if (accountsDirectoryExists) {
      for (const entry of deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const name = entry.name.slice(0, -5);
        try {
          validateReferenceName(name);
          // Stable, deterministic ref for a filename. The renderer re-lists on
          // every DOM mutation; with random UUIDs a re-list invalidated the refs
          // already rendered on the buttons, so Switch failed with
          // "unknown-reference". A filename-derived hash stays valid across lists.
          const opaque = stableRef(entry.name);
          const account = withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, entry.name), (auth) => ({
            ref: opaque,
            label: displayLabelFromAuth(auth.value, name),
            active: current.value === entry.name
              && Boolean(liveAccountId)
              && authAccountId(auth.value) === liveAccountId,
            pluginProtection: publicReceiptStatus(
              evaluatePluginReceipt(
                protection?.receipts?.[authAccountId(auth.value)],
                protection?.profile,
                authAccountId(auth.value),
                protection?.runtimeBinding,
                deps.now(),
              ),
            ),
          }));
          refs.set(opaque, entry.name);
          accounts.push(account);
        } catch {}
      }
    }
    accounts.sort((a, b) => a.label.localeCompare(b.label));
    const markerStatus = current.value && !accounts.some((item) => item.active)
      ? (accounts.some((item) => refs.get(item.ref) === current.value) ? "identity-mismatch" : "dangling-reference")
      : current.status;
    return redact({ ok: true, accounts, markerStatus, pluginProtection: publicPluginProtection(protection) });
  } catch {
    return safeFailure("account-list-unavailable");
  }
}

function prepareIntent(deps, paths, refs, intents, action, rawValue) {
  try {
    let target;
    if (action === "switch") {
      target = refs.get(rawValue);
      if (!target) throw coded("unknown-reference");
      const snapshot = withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, target), (value) => ({
        identity: value.identity,
        hash: value.hash,
      }));
      pruneIntents(intents, deps.now());
      const intent = deps.randomUUID();
      intents.set(intent, { action, target, snapshot, expiresAt: deps.now() + INTENT_TTL_MS });
      return { ok: true, intent, confirmation: "Switch Codex to this saved session?" };
    } else {
      target = validateReferenceName(rawValue);
      if (deps.fs.existsSync(sourcePath(deps.path, paths.accountsDir, target))) throw coded("account-exists");
      withSecureAuth(deps.fs, paths.authFile, () => undefined);
    }
    pruneIntents(intents, deps.now());
    const intent = deps.randomUUID();
    intents.set(intent, { action, target, expiresAt: deps.now() + INTENT_TTL_MS });
    return { ok: true, intent, confirmation: action === "switch" ? "Switch Codex to this saved session?" : "Save the current Codex session under this name?" };
  } catch (error) {
    return safeFailure(errorCode(error));
  }
}

async function prepareSwitchWithPluginGuard(api, deps, paths, refs, intents, ref, bypass, options) {
  try {
    const target = refs.get(ref);
    if (!target) throw coded("unknown-reference");
    const targetAccountId = withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, target), (auth) => authAccountId(auth.value));
    if (!targetAccountId) throw coded("plugin-protection-account-unknown");
    const protection = await pluginProtectionSnapshot(api, deps, paths);
    const receipt = evaluatePluginReceipt(
      protection.receipts[targetAccountId], protection.profile, targetAccountId, protection.runtimeBinding, deps.now(),
    );
    if (protection.profile.enforcement && !receipt.valid && !bypass) {
      return {
        ok: false,
        error: { code: "plugin-protection-receipt-required", message: "A current remote plugin receipt is required before switching." },
        pluginProtection: publicReceiptStatus(receipt),
      };
    }
    // A bypass can only be minted by this fresh target-specific preparation.
    // It lives inside the single-use, short-lived switch intent and is consumed
    // before any write is attempted in executeIntent.
    const prepared = prepareIntent(deps, paths, refs, intents, "switch", ref);
    if (!prepared.ok) return prepared;
    const intent = intents.get(prepared.intent);
    intent.pluginProtection = {
      accountId: targetAccountId,
      profileHash: profileHash(protection.profile),
      bypass: Boolean(bypass && protection.profile.enforcement && !receipt.valid),
    };
    return {
      ...prepared,
      confirmation: intent.pluginProtection.bypass
        ? "Switch once without a current plugin receipt? This bypass is only valid for this one switch."
        : prepared.confirmation,
      pluginProtection: publicReceiptStatus(receipt),
    };
  } catch (error) {
    return safeFailure(errorCode(error));
  }
}

async function executeIntent(deps, paths, refs, intents, message, options = {}, api) {
  const intent = intents.get(message.intent);
  intents.delete(message.intent);
  if (!intent || intent.action !== message.action || intent.expiresAt < deps.now()) return safeFailure("invalid-or-expired-intent");
  try {
    if (intent.action === "switch") {
      const guard = await recheckPluginGuard(api, deps, paths, intent, options);
      if (!guard.ok) return guard;
    }
    if (intent.action === "switch") switchAccount(deps, paths, intent.target, intent.snapshot);
    else saveCurrent(deps, paths, intent.target);
    refs.clear();
    const restartScheduled = intent.action === "switch" ? options.onSwitched?.() === true : false;
    return { ok: true, action: intent.action, restartScheduled };
  } catch (error) {
    return safeFailure(errorCode(error));
  }
}

async function recheckPluginGuard(api, deps, paths, intent) {
  const bound = intent.pluginProtection;
  // Intents made before this version, or a profile that remains in observation
  // mode, retain the pre-existing switch behavior.
  if (!bound) return { ok: true };
  const protection = await pluginProtectionSnapshot(api, deps, paths);
  if (!protection.profile.enforcement) return { ok: true };
  if (profileHash(protection.profile) !== bound.profileHash) return safeFailure("plugin-protection-profile-changed");
  if (bound.bypass) return { ok: true, bypassed: true };
  const receipt = evaluatePluginReceipt(
    protection.receipts[bound.accountId], protection.profile, bound.accountId, protection.runtimeBinding, deps.now(),
  );
  if (!receipt.valid) {
    return {
      ok: false,
      error: { code: "plugin-protection-receipt-required", message: "A current remote plugin receipt is required before switching." },
      pluginProtection: publicReceiptStatus(receipt),
    };
  }
  return { ok: true };
}

function defaultPluginProfile() {
  return {
    schemaVersion: PLUGIN_PROFILE_SCHEMA_VERSION,
    requiredBaseline: DEFAULT_REQUIRED_PLUGINS.map((plugin) => ({ id: plugin.id, name: plugin.name })),
    accountAdditions: {},
    enforcement: false,
  };
}

function normalizePluginProfile(value) {
  const fallback = defaultPluginProfile();
  if (!isRecord(value) || value.schemaVersion !== PLUGIN_PROFILE_SCHEMA_VERSION) return fallback;
  // The profile is deliberately not a way to weaken the global protection
  // contract. Mailchimp and Resend remain required for every account; account
  // additions may only add public curated remote plugin IDs.
  const requiredBaseline = fallback.requiredBaseline;
  const accountAdditions = {};
  if (isRecord(value.accountAdditions)) {
    for (const [accountId, ids] of Object.entries(value.accountAdditions)) {
      if (!validAccountId(accountId) || !Array.isArray(ids)) continue;
      const allowed = ids.filter((id) => typeof id === "string" && isPublicRemotePluginId(id));
      if (allowed.length) accountAdditions[accountId] = [...new Set(allowed)].sort();
    }
  }
  return { schemaVersion: PLUGIN_PROFILE_SCHEMA_VERSION, requiredBaseline, accountAdditions, enforcement: value.enforcement === true };
}

function validAccountId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && !/[\s@/\\\u0000-\u001f\u007f]/.test(value);
}

function isPublicRemotePluginId(value) {
  // A profile may name public remote plugins only. Created-by-me remote IDs are
  // intentionally not accepted as a target-account prerequisite.
  return typeof value === "string"
    && /^app-[a-zA-Z0-9-]+@openai-curated-remote$/.test(value);
}

function profileHash(profile) {
  const { createHash } = require("node:crypto");
  const normalized = normalizePluginProfile(profile);
  const canonical = {
    schemaVersion: normalized.schemaVersion,
    requiredBaseline: normalized.requiredBaseline.map((plugin) => plugin.id).sort(),
    accountAdditions: Object.fromEntries(Object.entries(normalized.accountAdditions).sort().map(([accountId, ids]) => [accountId, [...ids].sort()])),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function requiredPluginIds(profile, accountId) {
  const normalized = normalizePluginProfile(profile);
  const additions = validAccountId(accountId) ? (normalized.accountAdditions[accountId] || []) : [];
  return [...new Set([...normalized.requiredBaseline.map((plugin) => plugin.id), ...additions])].sort();
}

function evaluatePluginReceipt(receipt, profile, accountId, runtimeBinding, now = Date.now()) {
  const required = requiredPluginIds(profile, accountId);
  if (!validAccountId(accountId)) return { valid: false, code: "account-unknown", required };
  if (!validRuntimeBinding(runtimeBinding)) return { valid: false, code: "build-unavailable", required };
  if (!isRecord(receipt) || receipt.schemaVersion !== PLUGIN_PROFILE_SCHEMA_VERSION) return { valid: false, code: "missing", required };
  if (receipt.accountId !== accountId) return { valid: false, code: "wrong-account", required };
  if (receipt.profileHash !== profileHash(profile)) return { valid: false, code: "wrong-profile", required };
  if (receipt.desktopVersion !== runtimeBinding.desktopVersion || receipt.buildFlavor !== runtimeBinding.buildFlavor || receipt.bundledCliVersion !== runtimeBinding.bundledCliVersion) return { valid: false, code: "wrong-build", required };
  if (!Number.isFinite(receipt.verifiedAt) || receipt.verifiedAt > now || now - receipt.verifiedAt > PLUGIN_RECEIPT_MAX_AGE_MS) return { valid: false, code: "stale", required };
  const installed = new Map(Array.isArray(receipt.plugins) ? receipt.plugins.map((plugin) => [plugin?.id, plugin]) : []);
  const missing = required.filter((id) => !installed.get(id)?.installed || !installed.get(id)?.enabled);
  if (missing.length) return { valid: false, code: "plugins-missing", required, missing };
  return { valid: true, code: "current", required };
}

function publicReceiptStatus(status) {
  return { valid: Boolean(status?.valid), code: status?.code || "missing", required: Array.isArray(status?.required) ? status.required : [], missing: Array.isArray(status?.missing) ? status.missing : [] };
}

async function readPluginProfile(api) {
  try { return normalizePluginProfile(await api?.storage?.get?.(PLUGIN_PROFILE_KEY)); } catch { return defaultPluginProfile(); }
}

async function readPluginReceipts(api) {
  try {
    const value = await api?.storage?.get?.(PLUGIN_RECEIPTS_KEY);
    if (!isRecord(value) || value.schemaVersion !== PLUGIN_PROFILE_SCHEMA_VERSION || !isRecord(value.receipts)) return {};
    const receipts = {};
    for (const [accountId, receipt] of Object.entries(value.receipts)) if (validAccountId(accountId) && isRecord(receipt)) receipts[accountId] = receipt;
    return receipts;
  } catch { return {}; }
}

async function pluginProtectionSnapshot(api, deps, paths) {
  const [profile, receipts] = await Promise.all([readPluginProfile(api), readPluginReceipts(api)]);
  let accountId = null;
  try { accountId = withSecureAuth(deps.fs, paths.authFile, (auth) => authAccountId(auth.value)); } catch {}
  const runtimeBinding = await runtimeCodexBinding(api, deps);
  return { profile, receipts, accountId, runtimeBinding, active: publicReceiptStatus(evaluatePluginReceipt(receipts[accountId], profile, accountId, runtimeBinding, deps.now())) };
}

function publicPluginProtection(protection) {
  if (!protection) return { mode: "observation", baseline: DEFAULT_REQUIRED_PLUGINS.map((plugin) => ({ id: plugin.id, name: plugin.name })), active: { valid: false, code: "unavailable", required: [] } };
  return {
    mode: protection.profile.enforcement ? "enforcement" : "observation",
    baseline: protection.profile.requiredBaseline.map((plugin) => ({ id: plugin.id, name: plugin.name })),
    active: protection.active,
    desktopVersion: protection.runtimeBinding?.desktopVersion || null,
    bundledCliVersion: protection.runtimeBinding?.bundledCliVersion || null,
  };
}

async function configurePluginProtection(api, message) {
  if (typeof message?.enforcement !== "boolean") return safeFailure("invalid-plugin-protection-config");
  const profile = await readPluginProfile(api);
  const next = { ...profile, enforcement: message.enforcement };
  try {
    if (typeof api?.storage?.set !== "function") throw new Error("storage unavailable");
    await api.storage.set(PLUGIN_PROFILE_KEY, next);
    await api.storage.flush?.();
    return { ok: true, pluginProtection: publicPluginProtection({ profile: next, receipts: {}, accountId: null, runtimeBinding: null, active: { valid: false, code: "missing", required: [] } }) };
  } catch { return safeFailure("plugin-protection-storage-unavailable"); }
}

async function verifyCurrentPluginReceipt(api, deps, paths, options = {}) {
  let active;
  try {
    active = withSecureAuth(deps.fs, paths.authFile, (auth) => ({ accountId: authAccountId(auth.value), hash: auth.hash, identity: auth.identity }));
  } catch { return safeFailure("plugin-protection-account-unknown"); }
  const accountId = active.accountId;
  if (!validAccountId(accountId)) return safeFailure("plugin-protection-account-unknown");
  const profile = await readPluginProfile(api);
  const runtimeBinding = await runtimeCodexBinding(api, deps);
  if (!validRuntimeBinding(runtimeBinding)) return safeFailure("plugin-protection-build-unavailable");
  let plugins;
  try { plugins = await (options.inventory || ((probeDeps) => readOfficialPluginInventory(api, probeDeps, runtimeBinding)))(deps); } catch { return safeFailure("plugin-protection-inventory-unavailable"); }
  const inventory = validateOfficialInventory(plugins, requiredPluginIds(profile, accountId));
  if (!inventory.valid) {
    return { ok: false, error: { code: "plugin-protection-verification-incomplete", message: "The current account did not prove one unambiguous installed and enabled row for each required remote plugin." }, pluginProtection: { valid: false, code: inventory.code, required: requiredPluginIds(profile, accountId), missing: inventory.missing } };
  }
  const receipt = makePluginReceipt(profile, accountId, runtimeBinding, plugins, deps.now());
  const status = evaluatePluginReceipt(receipt, profile, accountId, runtimeBinding, deps.now());
  // Missing or incomplete remote rows are not proof. Preserve any last known
  // good receipt rather than laundering a degraded inventory into freshness.
  if (!status.valid) {
    return { ok: false, error: { code: "plugin-protection-verification-incomplete", message: "The current account did not prove all required remote plugins are installed and enabled." }, pluginProtection: publicReceiptStatus(status) };
  }
  try {
    if (typeof api?.storage?.get !== "function" || typeof api?.storage?.set !== "function") throw new Error("storage unavailable");
    const latestProfile = await readPluginProfile(api);
    if (profileHash(latestProfile) !== profileHash(profile)) return safeFailure("plugin-protection-profile-changed");
    const receipts = await readPluginReceipts(api);
    // This is intentionally the final operation before persistence. A manual
    // login/token rotation while Codex reconciles plugins leaves no new receipt
    // behind for the earlier snapshot.
    const current = withSecureAuth(deps.fs, paths.authFile, (auth) => ({ accountId: authAccountId(auth.value), hash: auth.hash, identity: auth.identity }));
    if (current.accountId !== active.accountId || current.hash !== active.hash || current.identity !== active.identity) {
      return safeFailure("plugin-protection-account-changed");
    }
    receipts[accountId] = receipt;
    await api.storage.set(PLUGIN_RECEIPTS_KEY, { schemaVersion: PLUGIN_PROFILE_SCHEMA_VERSION, receipts });
    await api.storage.flush?.();
    return { ok: true, pluginProtection: publicReceiptStatus(status) };
  } catch { return safeFailure("plugin-protection-storage-unavailable"); }
}

function makePluginReceipt(profile, accountId, runtimeBinding, plugins, verifiedAt = Date.now()) {
  const inventory = new Map(inventoryPlugins(plugins).map((plugin) => [plugin.id, plugin]));
  const required = requiredPluginIds(profile, accountId);
  return {
    schemaVersion: PLUGIN_PROFILE_SCHEMA_VERSION,
    accountId,
    profileHash: profileHash(profile),
    desktopVersion: runtimeBinding?.desktopVersion || null,
    buildFlavor: runtimeBinding?.buildFlavor || null,
    bundledCliVersion: runtimeBinding?.bundledCliVersion || null,
    verifiedAt,
    plugins: required.map((id) => {
      const plugin = inventory.get(id);
      return { id, installed: plugin?.installed === true, enabled: plugin?.enabled === true, version: typeof plugin?.version === "string" ? plugin.version.slice(0, 100) : null };
    }),
  };
}

function inventoryPlugins(response) {
  const marketplaces = Array.isArray(response?.marketplaces) ? response.marketplaces : [];
  const plugins = [];
  for (const marketplace of marketplaces) {
    const marketplaceName = typeof marketplace?.name === "string" ? marketplace.name : marketplace?.id;
    if (marketplaceName !== "openai-curated-remote") continue;
    for (const plugin of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
      if (!isRecord(plugin)) continue;
      const sourceType = typeof plugin?.source?.type === "string" ? plugin.source.type : "";
      if (sourceType !== "remote") continue;
      const id = typeof plugin.id === "string" && plugin.id.endsWith(`@${marketplaceName}`)
        ? plugin.id
        : null;
      if (typeof id !== "string") continue;
      if (!isPublicRemotePluginId(id)) continue;
      plugins.push({
        id,
        installed: plugin.installed,
        enabled: plugin.enabled,
        version: typeof plugin.version === "string" ? plugin.version : (typeof plugin.localVersion === "string" ? plugin.localVersion : null),
      });
    }
  }
  return plugins;
}

function validateOfficialInventory(response, requiredIds) {
  if (!isRecord(response) || !Array.isArray(response.marketplaces) || !Array.isArray(response.marketplaceLoadErrors) || response.marketplaceLoadErrors.length !== 0) {
    return { valid: false, code: "inventory-incomplete", missing: requiredIds };
  }
  const rows = inventoryPlugins(response);
  const missing = [];
  for (const id of requiredIds) {
    const matches = rows.filter((plugin) => plugin.id === id);
    if (matches.length !== 1 || matches[0].installed !== true || matches[0].enabled !== true) missing.push(id);
  }
  return missing.length ? { valid: false, code: "inventory-incomplete", missing } : { valid: true, code: "current", missing: [] };
}

function validRuntimeBinding(value) {
  return isRecord(value)
    && typeof value.desktopVersion === "string" && value.desktopVersion.length > 0
    && typeof value.buildFlavor === "string" && value.buildFlavor.length > 0
    && typeof value.bundledCliVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.bundledCliVersion)
    && typeof value.executable === "string" && value.executable.length > 0;
}

function bundledCliVersion(deps, executable) {
  try {
    const injected = deps?.probeBundledCliVersion?.(executable);
    if (typeof injected === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(injected)) return injected;
    const probe = deps.spawnSync?.(executable, ["--version"], { encoding: "utf8", timeout: 2_000, shell: false, windowsHide: true });
    const text = `${probe?.stdout || ""}\n${probe?.stderr || ""}`;
    return text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] || null;
  } catch { return null; }
}

async function runtimeCodexBinding(api, deps) {
  let info;
  try { info = await api?.codex?.runtime?.getInfo?.(); } catch { return null; }
  const desktopVersion = typeof info?.codexVersion === "string" ? info.codexVersion.trim() : "";
  const buildFlavor = typeof info?.buildFlavor === "string" ? info.buildFlavor.trim() : "";
  const resourcesPath = typeof info?.resourcesPath === "string" ? info.resourcesPath.trim() : "";
  if (!desktopVersion || !buildFlavor || !resourcesPath) return null;
  const root = deps.path.resolve(resourcesPath);
  const executable = deps.path.resolve(root, "codex");
  if (deps.path.dirname(executable) !== root) return null;
  try { if (!deps.fs.statSync(executable).isFile()) return null; } catch { return null; }
  const cliVersion = bundledCliVersion(deps, executable);
  if (!cliVersion) return null;
  return { desktopVersion, buildFlavor, bundledCliVersion: cliVersion, executable };
}

async function readOfficialPluginInventory(api, deps, binding) {
  const executable = binding?.executable;
  if (!validRuntimeBinding(binding) || !executable || typeof deps?.spawn !== "function") return Promise.reject(coded("plugin-protection-inventory-unavailable"));
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let output = "";
    let initialized = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill?.("SIGKILL"); } catch {}
      if (error) reject(coded("plugin-protection-inventory-unavailable"));
      else resolve(value);
    };
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(new Error("write failed")); }
    };
    const consume = (chunk) => {
      output += String(chunk);
      if (Buffer.byteLength(output, "utf8") > PLUGIN_PROBE_MAX_OUTPUT_BYTES) return finish(new Error("output limit"));
      const lines = output.split("\n");
      output = lines.pop();
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1 && message?.result && !initialized) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "plugin/installed", params: { cwds: [], installSuggestionPluginNames: [] } });
        } else if (message?.id === 2 && message?.result) {
          finish(null, message.result);
        } else if (message?.id === 2 && message?.error) {
          finish(new Error("inventory error"));
        }
      }
    };
    const timer = setTimeout(() => finish(new Error("timeout")), PLUGIN_PROBE_TIMEOUT_MS);
    try {
      child = deps.spawn(executable, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true });
      child.on("error", () => finish(new Error("spawn failed")));
      child.on("exit", () => { if (!settled) finish(new Error("exited")); });
      child.stdout?.on("data", consume);
      send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { clientInfo: { name: "tweakers-account-switcher", version: "0.1.10" }, capabilities: { experimentalApi: true } },
      });
    } catch { finish(new Error("spawn failed")); }
  });
}

function scheduleHostRestart(api) {
  try {
    const app = require("electron")?.app;
    if (!app?.relaunch || !app?.exit) throw new Error("Electron app lifecycle is unavailable");
    setTimeout(() => {
      try {
        app.relaunch();
        app.exit(0);
      } catch (error) {
        api.log.error("Account switch restart failed", String(error));
      }
    }, 150);
    api.log.info("Account switch complete; app restart scheduled");
    return true;
  } catch (error) {
    api.log.warn("Account switched, but app restart could not be scheduled", String(error));
    return false;
  }
}

function switchAccount(deps, paths, filename, snapshot) {
  const fs = deps.fs;
  assertTrustedDirectory(fs, paths.codexDir);
  assertTrustedDirectory(fs, paths.accountsDir);
  const source = sourceFilePath(deps.path, paths.accountsDir, filename);
  return withSecureAuth(fs, source, (selected) => {
    if (!snapshot || selected.identity !== snapshot.identity || selected.hash !== snapshot.hash) throw coded("source-changed");
    return withSecureAuth(fs, paths.authFile, (current) => {
      if (!current.bytes.length) throw coded("no-last-known-good");
      return withSecureAuth(fs, source, (revalidated) => {
        if (selected.identity !== revalidated.identity || selected.hash !== revalidated.hash) throw coded("source-changed");
        return withOptionalSecureBytes(fs, paths.currentMarker, 256, (previousMarker) => (
          withOptionalSecureBytes(fs, paths.lkgFile, MAX_AUTH_BYTES, (previousLkg) => (
            commitSwitch(deps, paths, filename, current, revalidated, previousMarker, previousLkg)
          ))
        ));
      });
    });
  });
}

function commitSwitch(deps, paths, filename, current, revalidated, previousMarker, previousLkg) {
  const fs = deps.fs;
  const active = readCurrentMarker(fs, paths.currentMarker);
  let activeSnapshotPath = null;
  let previousActiveSnapshot = null;
  let mutated = false;
  let completed = false;
  try {
    // Persist the session being left synchronously. The background watcher
    // handles normal token rotation, but this closes the last-second race
    // between a refresh-token write and the user clicking Switch.
    if (active.status === "ok" && active.value && active.value !== filename) {
      activeSnapshotPath = sourceFilePath(deps.path, paths.accountsDir, active.value);
      if (fs.existsSync(activeSnapshotPath)) {
        previousActiveSnapshot = withSecureAuth(fs, activeSnapshotPath, (savedActive) => {
          const liveAccount = authAccountId(current.value);
          const savedAccount = authAccountId(savedActive.value);
          if (!liveAccount || liveAccount !== savedAccount) throw coded("active-account-mismatch");
          return Buffer.from(savedActive.bytes);
        });
        mutated = true;
        atomicWrite(deps, paths.accountsDir, activeSnapshotPath, current.bytes);
      } else {
        activeSnapshotPath = null;
      }
    }
    mutated = true;
    atomicWrite(deps, paths.codexDir, paths.authFile, revalidated.bytes);
    atomicWrite(deps, paths.codexDir, paths.currentMarker, Buffer.from(`${filename}\n`, "utf8"));
    // The fixed LKG rotates only after auth and marker are both durable.
    atomicWrite(deps, paths.codexDir, paths.lkgFile, current.bytes);
    completed = true;
  } catch (error) {
    if (mutated) {
      try {
        atomicWrite(deps, paths.codexDir, paths.authFile, current.bytes);
        restoreOptional(deps, paths.codexDir, paths.currentMarker, previousMarker);
        restoreOptional(deps, paths.codexDir, paths.lkgFile, previousLkg);
        if (activeSnapshotPath && previousActiveSnapshot) {
          atomicWrite(deps, paths.accountsDir, activeSnapshotPath, previousActiveSnapshot);
        }
      } catch { throw coded("rollback-failed"); }
    }
    throw coded(errorCode(error));
  } finally {
    clearSecretBuffer(previousActiveSnapshot);
  }
  if (!completed) throw coded("auth-write-failed");
}

function saveCurrent(deps, paths, name) {
  assertTrustedDirectory(deps.fs, paths.codexDir);
  ensureAccountsDirectory(deps.fs, paths.accountsDir, true);
  assertTrustedDirectory(deps.fs, paths.accountsDir);
  return withSecureAuth(deps.fs, paths.authFile, (current) => {
    const target = sourcePath(deps.path, paths.accountsDir, name);
    createExclusiveAtomic(deps, paths.accountsDir, target, current.bytes);
  });
}

function withSecureAuth(fs, file, callback) {
  let snapshot;
  try {
    snapshot = readSecureAuth(fs, file);
    return callback(snapshot);
  } finally {
    clearSecretBuffer(snapshot?.bytes);
  }
}

function withOptionalSecureBytes(fs, file, maxBytes, callback) {
  let bytes;
  try {
    bytes = readOptionalSecureBytes(fs, file, maxBytes);
    return callback(bytes);
  } finally {
    clearSecretBuffer(bytes);
  }
}

function clearSecretBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function readSecureAuth(fs, file) {
  let fd;
  let bytes;
  let transferred = false;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > MAX_AUTH_BYTES) throw coded("invalid-auth-source");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length) throw coded("invalid-auth-source");
    const value = JSON.parse(bytes.toString("utf8"));
    validateAuthObject(value);
    const { createHash } = require("node:crypto");
    const snapshot = { bytes, value, hash: createHash("sha256").update(bytes).digest("hex"), identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
    fs.closeSync(fd);
    fd = undefined;
    transferred = true;
    return snapshot;
  } catch (error) {
    if (error?.code && String(error.code).startsWith("invalid-")) throw error;
    throw coded("invalid-auth-source");
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (!transferred) clearSecretBuffer(bytes);
    }
  }
}

function readOptionalSecureBytes(fs, file, maxBytes) {
  let bytes;
  let transferred = false;
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw coded("invalid-existing-state");
    bytes = fs.readFileSync(file);
    transferred = true;
    return bytes;
  } finally {
    if (!transferred) clearSecretBuffer(bytes);
  }
}

function restoreOptional(deps, dir, file, bytes) {
  if (bytes) return atomicWrite(deps, dir, file, bytes);
  try { deps.fs.unlinkSync(file); fsyncDirectory(deps.fs, dir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function validateAuthObject(value) {
  if (!isRecord(value) || typeof value.auth_mode !== "string") throw coded("invalid-auth-source");
  const hasApiKey = typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY.length > 0;
  const tokens = value.tokens;
  const hasTokens = isRecord(tokens) && [tokens.access_token, tokens.refresh_token, tokens.id_token].some((item) => typeof item === "string" && item.length > 0);
  if (!hasApiKey && !hasTokens) throw coded("invalid-auth-source");
  return true;
}

function atomicWrite(deps, dir, target, bytes) {
  const fs = deps.fs;
  const tmp = `${target}.tmp-${deps.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    fsyncDirectory(fs, dir);
  } catch (error) {
    throw coded(errorCode(error) === "operation-failed" ? "auth-write-failed" : errorCode(error));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function createExclusiveAtomic(deps, dir, target, bytes) {
  const fs = deps.fs;
  const tmp = `${target}.tmp-${deps.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(tmp, target);
    fs.unlinkSync(tmp);
    fs.chmodSync(target, 0o600);
    fsyncDirectory(fs, dir);
  } catch (error) {
    if (error?.code === "EEXIST") throw coded("account-exists");
    throw coded("auth-write-failed");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function fsyncDirectory(fs, dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureAccountsDirectory(fs, dir, create) {
  if (!fs.existsSync(dir)) {
    if (!create) throw coded("account-list-unavailable");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("invalid-accounts-directory");
}

function assertTrustedDirectory(fs, dir) {
  const stat = fs.lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw coded("untrusted-auth-directory");
}

function readCurrentMarker(fs, file) {
  let fd;
  try {
    // Open with O_NOFOLLOW and fstat the fd (TOCTOU-safe), matching the rigor of
    // readSecureAuth rather than lstat-then-read.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 256) return { value: null, status: "invalid" };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const value = buffer.toString("utf8").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(value)) return { value: null, status: "invalid" };
    return { value, status: "ok" };
  } catch (error) {
    return { value: null, status: error?.code === "ENOENT" ? "missing" : "invalid" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateReferenceName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw coded("invalid-reference");
  return value;
}

function sourcePath(path, dir, name) {
  const target = path.resolve(dir, `${validateReferenceName(name)}.json`);
  if (path.dirname(target) !== path.resolve(dir)) throw coded("invalid-reference");
  return target;
}

function sourceFilePath(path, dir, filename) {
  if (typeof filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(filename) || filename.endsWith(".json.json")) throw coded("invalid-reference");
  const target = path.resolve(dir, filename);
  if (path.dirname(target) !== path.resolve(dir)) throw coded("invalid-reference");
  return target;
}

function pruneIntents(intents, now) {
  for (const [id, intent] of intents) if (intent.expiresAt < now) intents.delete(id);
  while (intents.size >= 32) intents.delete(intents.keys().next().value);
}

function authPaths(deps) {
  // Honor CODEX_HOME (the runtime and Codex itself do); otherwise ~/.codex.
  const codexDir = deps.codexHome && deps.codexHome.trim()
    ? deps.path.resolve(deps.codexHome)
    : deps.path.join(deps.homedir(), ".codex");
  return {
    codexDir,
    accountsDir: deps.path.join(codexDir, "auth_accounts"),
    authFile: deps.path.join(codexDir, "auth.json"),
    currentMarker: deps.path.join(codexDir, "current_account"),
    lkgFile: deps.path.join(codexDir, "auth.account-switcher-lkg.json"),
  };
}

// Account Router state is intentionally separate from the compatible manual
// snapshots.  The router receives opaque ids and private copies only; the
// renderer gets the small redacted projection built below.
function accountRouterPaths(deps, paths) {
  const routerDir = deps.path.resolve(paths.routerDataDir || deps.path.join(deps.homedir(), "tweak-data", "co.tweakers.account-switcher"));
  return {
    routerDir,
    accountsDir: deps.path.join(routerDir, "accounts"),
    configFile: deps.path.join(routerDir, ACCOUNT_ROUTER_CONFIG_NAME),
    stateFile: deps.path.join(routerDir, ACCOUNT_ROUTER_STATE_NAME),
    controlSecretFile: deps.path.join(routerDir, ACCOUNT_ROUTER_CONTROL_SECRET_NAME),
    receiptsFile: deps.path.join(routerDir, ACCOUNT_ROUTER_RECEIPTS_NAME),
  };
}

function ensureOwnerPrivateDirectory(deps, directory) {
  const fs = deps.fs;
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const uid = typeof deps.getuid === "function" ? deps.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw coded("untrusted-router-directory");
  fs.chmodSync(directory, 0o700);
}

function ensureRouterRoot(deps, paths) {
  assertTrustedDirectory(deps.fs, paths.codexDir);
  const routerPaths = accountRouterPaths(deps, paths);
  ensureOwnerPrivateDirectory(deps, deps.path.dirname(routerPaths.routerDir));
  ensureOwnerPrivateDirectory(deps, routerPaths.routerDir);
  ensureOwnerPrivateDirectory(deps, routerPaths.accountsDir);
  return routerPaths;
}

function routerSecret(deps, routerPaths) {
  const fs = deps.fs;
  ensureOwnerPrivateDirectory(deps, routerPaths.routerDir);
  if (!fs.existsSync(routerPaths.controlSecretFile)) {
    const { randomBytes } = require("node:crypto");
    const generated = randomBytes(32);
    try { createExclusiveAtomic(deps, routerPaths.routerDir, routerPaths.controlSecretFile, generated); }
    finally { clearSecretBuffer(generated); }
  }
  return withOptionalSecureBytes(fs, routerPaths.controlSecretFile, 64, (bytes) => {
    if (!bytes || bytes.length !== 32) throw coded("invalid-router-control-secret");
    return Buffer.from(bytes);
  });
}

function opaqueAccountId(secret, rawAccountId) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32 || typeof rawAccountId !== "string" || !rawAccountId.length || rawAccountId.length > 1024) throw coded("invalid-account-identity");
  const { createHmac } = require("node:crypto");
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`;
}

function isOpaqueAccountId(value) { return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value); }
function isFingerprint(value) { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function isoNow(deps) { return new Date(deps.now()).toISOString(); }
function pendingCapabilityFingerprint(opaqueId) {
  const { createHash } = require("node:crypto");
  return `sha256:${createHash("sha256").update(`account-router:v1:pending-capability:${opaqueId}`).digest("hex")}`;
}

function validateRouterConfig(value) {
  if (!isRecord(value) || Object.keys(value).length !== 6
    || value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
    || !["manual", "balanced"].includes(value.mode)
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !Array.isArray(value.accounts) || value.accounts.length !== 2
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw coded("invalid-router-config");
  const seen = new Set();
  for (const account of value.accounts) {
    if (!isRecord(account) || Object.keys(account).length !== 4
      || !isOpaqueAccountId(account.opaqueAccountId) || typeof account.included !== "boolean"
      || !Number.isInteger(account.weight) || account.weight < 1 || account.weight > 100
      || !isFingerprint(account.capabilityFingerprint) || seen.has(account.opaqueAccountId)) throw coded("invalid-router-config");
    seen.add(account.opaqueAccountId);
  }
  if (!seen.has(value.primaryOpaqueAccountId)) throw coded("invalid-router-config");
  if (value.mode === "balanced" && value.accounts.filter((account) => account.included).length !== 2) throw coded("invalid-router-config");
  return value;
}

function readPrivateJson(deps, file, maxBytes, errorCode) {
  return withOptionalSecureBytes(deps.fs, file, maxBytes, (bytes) => {
    if (!bytes) return null;
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw coded(errorCode); }
  });
}

function readRouterConfig(deps, routerPaths) {
  const value = readPrivateJson(deps, routerPaths.configFile, 32 * 1024, "invalid-router-config");
  return value === null ? null : validateRouterConfig(value);
}

function validateRouterState(value) {
  if (!isRecord(value) || value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !Number.isInteger(value.epoch) || value.epoch < 1
    || !isRecord(value.ledger) || !isRecord(value.accountEligibility)
    || !Array.isArray(value.reservations) || !Array.isArray(value.correlations)
    || !isRecord(value.threadOwners) || !isRecord(value.pendingThreadOwners)
    || !(value.stagedDisable === null || isRecord(value.stagedDisable))) throw coded("invalid-router-state");
  return value;
}

function readRouterState(deps, routerPaths) {
  const value = readPrivateJson(deps, routerPaths.stateFile, MAX_ROUTER_STATE_BYTES, "invalid-router-state");
  return value === null ? null : validateRouterState(value);
}

function writePrivateJson(deps, directory, file, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  try { atomicWrite(deps, directory, file, bytes); } finally { clearSecretBuffer(bytes); }
}

function safeRouterReceipt(deps, routerPaths, entry) {
  const existing = readPrivateJson(deps, routerPaths.receiptsFile, MAX_ROUTER_STATE_BYTES, "invalid-router-receipts") || [];
  if (!Array.isArray(existing) || existing.some((item) => !isRecord(item))) throw coded("invalid-router-receipts");
  existing.push(entry);
  writePrivateJson(deps, routerPaths.routerDir, routerPaths.receiptsFile, existing.slice(-32));
}

function exactRouterChild(deps, routerPaths, opaqueId) {
  if (!isOpaqueAccountId(opaqueId)) throw coded("invalid-account-identity");
  return deps.path.join(routerPaths.accountsDir, opaqueId);
}

function cleanupStagingHome(deps, routerPaths, staging) {
  const fs = deps.fs;
  const relative = deps.path.relative(routerPaths.accountsDir, staging);
  if (!relative || relative.startsWith("..") || deps.path.isAbsolute(relative) || !/^\.staging-[A-Za-z0-9-]+$/.test(relative)) throw coded("invalid-router-staging");
  const codexHome = deps.path.join(staging, "codex-home");
  const sqliteHome = deps.path.join(staging, "sqlite-home");
  for (const file of [deps.path.join(codexHome, "auth.json"), deps.path.join(codexHome, "config.toml")]) {
    try { fs.unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  for (const directory of [sqliteHome, codexHome, staging]) {
    try { fs.rmdirSync(directory); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function stageRouterHome(deps, paths, routerPaths, filename, opaqueId, secret) {
  const source = sourceFilePath(deps.path, paths.accountsDir, filename);
  let sourceSnapshot;
  let promoted = false;
  let staging;
  try {
    sourceSnapshot = readSecureAuth(deps.fs, source);
    if (opaqueAccountId(secret, authAccountId(sourceSnapshot.value)) !== opaqueId) throw coded("router-account-identity-changed");
    const target = exactRouterChild(deps, routerPaths, opaqueId);
    if (deps.fs.existsSync(target)) {
      const authFile = deps.path.join(target, "codex-home", "auth.json");
      ensureOwnerPrivateDirectory(deps, target);
      ensureOwnerPrivateDirectory(deps, deps.path.join(target, "codex-home"));
      withSecureAuth(deps.fs, authFile, (existing) => {
        if (existing.hash !== sourceSnapshot.hash) throw coded("router-home-conflict");
      });
      return { reused: true, hash: sourceSnapshot.hash };
    }
    staging = deps.path.join(routerPaths.accountsDir, `.staging-${deps.randomUUID()}`);
    ensureOwnerPrivateDirectory(deps, staging);
    const codexHome = deps.path.join(staging, "codex-home");
    const sqliteHome = deps.path.join(staging, "sqlite-home");
    ensureOwnerPrivateDirectory(deps, codexHome);
    ensureOwnerPrivateDirectory(deps, sqliteHome);
    atomicWrite(deps, codexHome, deps.path.join(codexHome, "auth.json"), sourceSnapshot.bytes);
    // v1 never copies live config/environment/MCP credentials. This empty file
    // makes the deny-by-default capability policy explicit for the runtime.
    atomicWrite(deps, codexHome, deps.path.join(codexHome, "config.toml"), Buffer.alloc(0));
    withSecureAuth(deps.fs, source, (revalidated) => {
      if (revalidated.identity !== sourceSnapshot.identity || revalidated.hash !== sourceSnapshot.hash
        || opaqueAccountId(secret, authAccountId(revalidated.value)) !== opaqueId) throw coded("router-source-changed");
    });
    deps.fs.renameSync(staging, target);
    promoted = true;
    return { reused: false, hash: sourceSnapshot.hash };
  } finally {
    clearSecretBuffer(sourceSnapshot?.bytes);
    if (staging && !promoted) cleanupStagingHome(deps, routerPaths, staging);
  }
}

function stageBalancedRouterConfig(deps, paths, refs, message) {
  const routerPaths = ensureRouterRoot(deps, paths);
  const refsInput = Array.isArray(message?.refs) ? message.refs : [];
  if (refsInput.length !== 2 || new Set(refsInput).size !== 2) throw coded("router-requires-exactly-two-accounts");
  const filenames = refsInput.map((ref) => refs.get(ref));
  if (filenames.some((filename) => typeof filename !== "string")) throw coded("unknown-reference");
  const weights = Array.isArray(message?.weights) ? message.weights : [1, 1];
  if (weights.length !== 2 || weights.some((weight) => !Number.isInteger(weight) || weight < 1 || weight > 100)) throw coded("invalid-router-weight");
  const secret = routerSecret(deps, routerPaths);
  try {
    const accounts = filenames.map((filename, index) => withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, filename), (snapshot) => {
      const rawId = authAccountId(snapshot.value);
      if (!rawId) throw coded("invalid-account-identity");
      return { filename, opaqueAccountId: opaqueAccountId(secret, rawId), included: true, weight: weights[index], capabilityFingerprint: pendingCapabilityFingerprint(opaqueAccountId(secret, rawId)) };
    }));
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== 2) throw coded("router-requires-distinct-accounts");
    const primaryRef = typeof message?.primaryRef === "string" ? message.primaryRef : refsInput[0];
    const primaryIndex = refsInput.indexOf(primaryRef);
    if (primaryIndex < 0) throw coded("invalid-router-primary");
    for (const account of accounts) {
      const result = stageRouterHome(deps, paths, routerPaths, account.filename, account.opaqueAccountId, secret);
      safeRouterReceipt(deps, routerPaths, { schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION, opaqueAccountId: account.opaqueAccountId, snapshotHash: `sha256:${result.hash}`, protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, result: result.reused ? "reused" : "staged", stagedAt: isoNow(deps) });
      delete account.filename;
    }
    const config = validateRouterConfig({ schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accounts[primaryIndex].opaqueAccountId, accounts, updatedAt: isoNow(deps) });
    writePrivateJson(deps, routerPaths.routerDir, routerPaths.configFile, config);
    return config;
  } finally {
    clearSecretBuffer(secret);
  }
}

function stageManualRouterConfig(deps, paths) {
  const routerPaths = ensureRouterRoot(deps, paths);
  const existing = readRouterConfig(deps, routerPaths);
  if (!existing) return null;
  const config = { ...existing, mode: "manual", updatedAt: isoNow(deps) };
  writePrivateJson(deps, routerPaths.routerDir, routerPaths.configFile, config);
  return config;
}

function routerDegradedReason(state) {
  const code = state?.stagedDisable?.reasonCode;
  return ({ protocol_drift: "unsupported_protocol", isolation_failure: "capability_mismatch", policy_stop: "policy_stop", post_start_failure: "post_start_failure" })[code] || null;
}

function routerPublicStatus(deps, config, state) {
  if (!config) return { schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION, mode: "manual", protocolState: "supported", fairnessPrecision: "exact_completed_spend", accounts: [], restartRequired: false, degradedReason: null };
  const invalid = config.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT;
  const degradedReason = invalid ? "invalid_config" : routerDegradedReason(state);
  const mode = degradedReason ? "direct_fallback" : config.mode;
  const accounts = (config?.accounts || []).map((account, index) => {
    const ledger = state?.ledger?.[account.opaqueAccountId];
    const completed = Number.isInteger(ledger?.completedInputTokens) ? ledger.completedInputTokens : 0;
    const output = Number.isInteger(ledger?.completedOutputTokens) ? ledger.completedOutputTokens : 0;
    const reserved = Number.isInteger(ledger?.reservedRequestCost) ? ledger.reservedRequestCost : 0;
    return {
      opaqueAccountId: account.opaqueAccountId,
      label: index === 0 ? "Account A" : "Account B",
      eligibility: state?.accountEligibility?.[account.opaqueAccountId] || "validating",
      normalizedSpend: (completed + output + reserved) / account.weight,
      assignedThreadCount: Number.isInteger(ledger?.assignedThreadCount) ? ledger.assignedThreadCount : 0,
    };
  });
  const inFlight = Boolean(state?.reservations?.length || state?.correlations?.length || accounts.some((account) => ["validating", "reserved", "active"].includes(account.eligibility)));
  return redact({ schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION, mode, protocolState: invalid ? "unknown" : "supported", fairnessPrecision: inFlight ? "projected" : "exact_completed_spend", accounts, restartRequired: mode === "balanced" || mode === "direct_fallback", degradedReason });
}

async function routerStatus(_api, deps, paths) {
  const routerPaths = accountRouterPaths(deps, paths);
  try {
    const config = readRouterConfig(deps, routerPaths);
    const state = readRouterState(deps, routerPaths);
    return { ok: true, router: routerPublicStatus(deps, config, state) };
  } catch {
    // A malformed/stale persisted control record never blocks manual behavior.
    // The runtime will select direct mode; the renderer receives only its code.
    return { ok: true, router: { schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION, mode: "direct_fallback", protocolState: "unknown", fairnessPrecision: "estimated", accounts: [], restartRequired: true, degradedReason: "invalid_config" } };
  }
}

async function configureRouter(_api, deps, paths, refs, message) {
  try {
    const config = message?.mode === "balanced"
      ? stageBalancedRouterConfig(deps, paths, refs, message)
      : message?.mode === "manual" ? stageManualRouterConfig(deps, paths) : (() => { throw coded("invalid-router-mode"); })();
    return { ok: true, router: routerPublicStatus(deps, config, null) };
  } catch (error) { return safeFailure(errorCode(error)); }
}

function routerIsIdle(state) {
  return state.reservations.length === 0 && state.correlations.length === 0
    && !Object.values(state.accountEligibility).some((value) => ["validating", "reserved", "active"].includes(value));
}

function resetRouterBalanceEpoch(deps, routerPaths) {
  try {
    ensureOwnerPrivateDirectory(deps, routerPaths.routerDir);
    const state = readRouterState(deps, routerPaths);
    if (!state) throw coded("router-state-unavailable");
    if (!routerIsIdle(state)) throw coded("router-not-idle");
    for (const ledger of Object.values(state.ledger)) {
      if (!isRecord(ledger)) throw coded("invalid-router-state");
      ledger.completedInputTokens = 0;
      ledger.completedOutputTokens = 0;
      ledger.reservedRequestCost = 0;
      ledger.assignedThreadCount = 0;
    }
    state.epoch += 1;
    writePrivateJson(deps, routerPaths.routerDir, routerPaths.stateFile, state);
    return { ok: true, epoch: state.epoch };
  } catch (error) { return safeFailure(errorCode(error)); }
}

function cleanupLegacyAnalytics(deps) {
  const fs = deps?.fs;
  const path = deps?.path;
  const spawnSync = deps?.spawnSync;
  const constants = fs?.constants;
  if (!fs || !path || typeof deps?.homedir !== "function" || typeof fs.openSync !== "function" || typeof fs.closeSync !== "function" || typeof spawnSync !== "function") return;
  if (!Number.isInteger(constants?.O_RDONLY) || !Number.isInteger(constants?.O_DIRECTORY) || !Number.isInteger(constants?.O_NOFOLLOW)) return;

  let homeDir;
  let homeFd;
  try {
    homeDir = path.resolve(deps.homedir());
    // Opening this root once binds the helper to a stable descriptor. The
    // helper traverses the fixed descendants fd-relatively with O_NOFOLLOW.
    homeFd = fs.openSync(homeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    spawnSync("/usr/bin/python3", ["-I", "-S", "-c", LEGACY_ANALYTICS_NEUTRALIZER], {
      stdio: ["ignore", "ignore", "ignore", homeFd],
      timeout: 2_000,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
    });
  } catch {
    // This best-effort expiry is deliberately content-blind and nonfatal.
  } finally {
    try {
      if (Number.isInteger(homeFd)) fs.closeSync(homeFd);
    } catch {
      // Do not let an opaque close failure change startup behavior.
    }
  }
}

function stableRef(filename) {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(String(filename)).digest("hex").slice(0, 32);
}

function validLabel(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}

function nodeDeps() {
  const { randomUUID } = require("node:crypto");
  const { spawn, spawnSync } = require("node:child_process");
  return {
    fs: require("node:fs"),
    path: require("node:path"),
    homedir: require("node:os").homedir,
    codexHome: typeof process !== "undefined" ? (process.env.CODEX_HOME || null) : null,
    getuid: typeof process !== "undefined" && typeof process.getuid === "function" ? () => process.getuid() : null,
    spawn, spawnSync,
    randomUUID,
    now: Date.now,
  };
}

function startRenderer(api) {
  const state = { api, observer: null, disposed: false, timer: null, page: null, accountMenus: [] };
  globalThis.__tweakersAccountRendererV1?.dispose?.();
  globalThis.__tweakersAccountRendererV1 = { dispose: () => disposeRenderer(state) };
  const schedule = () => {
    if (state.disposed || state.timer) return;
    state.timer = window.setTimeout(() => { state.timer = null; void injectAccountMenus(state); }, 50);
  };
  const disposeHost = api.react?.host?.observe?.(["account-menu"], (snapshots) => {
    const accountMenu = snapshots?.find((snapshot) => snapshot?.kind === "account-menu");
    state.accountMenus = (accountMenu?.matches || [])
      .filter((match) => match?.kind === "account-menu" && match?.confidence === "high" && match.element)
      .map((match) => match.element);
    schedule();
  });
  state.observer = typeof disposeHost === "function" ? { disconnect: disposeHost } : null;
  state.page = api.settings?.registerPage?.({
    id: "accounts",
    title: "Accounts",
    description: "Saved ChatGPT accounts available on this Mac.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="6.5" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M4 16c.7-3 2.7-4.5 6-4.5s5.3 1.5 6 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    render(root) { return renderAccountsPage(state, root); },
  });
  schedule();
}

function renderAccountsPage(state, root) {
  let disposed = false;
  root.textContent = "Loading accounts…";
  state.api.ipc.invoke(IPC, { action: "list" }).then((response) => {
    if (disposed) return;
    root.replaceChildren();
    if (!response?.ok) { root.textContent = "Accounts are unavailable."; return; }
    state.pluginProtectionMode = response.pluginProtection?.mode || "observation";
    const card = document.createElement("div");
    card.className = "border-token-border divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border";
    for (const account of response.accounts) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-4 p-3";
      const copy = document.createElement("div");
      copy.className = "min-w-0";
      copy.innerHTML = `<div class="truncate text-sm text-token-text-primary"></div><div class="text-sm text-token-text-secondary">${account.active ? "Current account" : "Saved account"}${account.pluginProtection ? ` · Plugin receipt: ${pluginStatusLabel(account.pluginProtection)}` : ""}</div>`;
      copy.firstElementChild.textContent = account.label;
      row.append(copy, accountButton(state, account));
      card.append(row);
    }
    if (!response.accounts.length) card.textContent = "No saved accounts yet.";
    const status = document.createElement("div");
    status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
    status.textContent = response.accounts.some((account) => account.active) ? "Ready. The current account is marked below." : "No saved account matches the current session.";
    state.statusElement = status;
    const protection = pluginProtectionCard(state, response.pluginProtection);
    const router = routerControlCard(state, response.accounts);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "self-start rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
    save.textContent = "Save Current";
    save.addEventListener("click", async () => {
      status.textContent = "Saving current account…";
      const saved = await saveCurrentFromMenu(state);
      if (!disposed) status.textContent = saved ? "Current account saved. Reopen this page to refresh the list." : "Save cancelled or unavailable; no success was recorded.";
    });
    root.append(router, protection);
    root.append(status, save, card);
  }).catch(() => { if (!disposed) root.textContent = "Accounts are unavailable."; });
  return () => { disposed = true; root.replaceChildren(); };
}

function routerControlCard(state, accounts) {
  const card = document.createElement("div");
  card.className = "border-token-border mb-3 flex flex-col divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border";
  const summary = document.createElement("div");
  summary.className = "flex flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Account routing";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  description.textContent = "Manual switching remains the default. Balanced routing stages two saved accounts for the next separately authorized restart; it does not restart ChatGPT from this page.";
  summary.append(title, description);
  const body = document.createElement("div");
  body.className = "flex flex-col gap-3 p-3";
  const status = document.createElement("div");
  status.className = "text-sm text-token-text-secondary";
  status.textContent = "Checking staged router status…";
  const selected = new Set(accounts.slice(0, 2).map((account) => account.ref));
  const weights = new Map(accounts.map((account) => [account.ref, 1]));
  const choices = document.createElement("div");
  choices.className = "flex flex-col gap-2";
  for (const account of accounts) {
    const row = document.createElement("label");
    row.className = "flex items-center justify-between gap-3 text-sm text-token-text-primary";
    const inclusion = document.createElement("input");
    inclusion.type = "checkbox";
    inclusion.checked = selected.has(account.ref);
    const label = document.createElement("span");
    label.className = "min-w-0 flex-1 truncate";
    label.textContent = account.label;
    const weight = document.createElement("input");
    weight.type = "number"; weight.min = "1"; weight.max = "100"; weight.value = "1";
    weight.className = "border-token-border bg-token-foreground/5 w-16 rounded-md border px-2 py-1 text-sm text-token-text-primary";
    inclusion.addEventListener("change", () => {
      if (inclusion.checked && selected.size >= 2) { inclusion.checked = false; return; }
      if (inclusion.checked) selected.add(account.ref); else selected.delete(account.ref);
    });
    weight.addEventListener("change", () => weights.set(account.ref, Number(weight.value)));
    row.append(inclusion, label, weight);
    choices.append(row);
  }
  const controls = document.createElement("div");
  controls.className = "flex flex-wrap items-center gap-2";
  const balanced = document.createElement("button");
  balanced.type = "button";
  balanced.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
  balanced.textContent = "Stage Balanced Mode";
  balanced.addEventListener("click", async () => {
    const refs = [...selected];
    if (refs.length !== 2) { status.textContent = "Choose exactly two saved accounts before staging balanced mode."; return; }
    status.textContent = "Staging isolated account homes…";
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "router-configure", mode: "balanced", refs, primaryRef: refs[0], weights: refs.map((ref) => weights.get(ref)) });
      status.textContent = result?.ok ? "Balanced mode is staged for the next authorized restart." : "Balanced mode could not be staged safely.";
    } catch { status.textContent = "Balanced mode could not be staged safely."; }
  });
  const manual = document.createElement("button");
  manual.type = "button";
  manual.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
  manual.textContent = "Use Manual Mode";
  manual.addEventListener("click", async () => {
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "router-configure", mode: "manual" });
      status.textContent = result?.ok ? "Manual mode is staged. Existing saved sessions remain unchanged." : "Manual mode could not be staged safely.";
    } catch { status.textContent = "Manual mode could not be staged safely."; }
  });
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "rounded-full px-2 py-0.5 text-sm bg-token-charts-red/10 text-token-charts-red hover:bg-token-charts-red/20";
  reset.textContent = "Reset balance";
  reset.addEventListener("click", async () => {
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "router-reset-balance-epoch" });
      status.textContent = result?.ok ? "Balance epoch reset while idle." : "Balance reset requires an idle router.";
    } catch { status.textContent = "Balance reset was unavailable."; }
  });
  controls.append(balanced, manual, reset);
  body.append(status, choices, controls);
  card.append(summary, body);
  void state.api.ipc.invoke(IPC, { action: "router-status" }).then((result) => {
    if (!result?.ok) { status.textContent = "Router status is unavailable; manual switching remains available."; return; }
    const router = result.router;
    const degraded = router.degradedReason ? ` Degraded: ${router.degradedReason.replace(/_/g, " ")}.` : "";
    status.textContent = `${router.mode === "balanced" ? "Balanced mode is staged." : "Manual mode is active."}${degraded}`;
  }).catch(() => { status.textContent = "Router status is unavailable; manual switching remains available."; });
  return card;
}

function pluginProtectionCard(state, protection) {
  const info = protection || { mode: "observation", baseline: DEFAULT_REQUIRED_PLUGINS, active: { valid: false, code: "unavailable" } };
  const card = document.createElement("div");
  card.className = "border-token-border mb-3 flex flex-col divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border";
  const summary = document.createElement("div");
  summary.className = "flex flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Remote plugin protection";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  const names = (info.baseline || []).map((plugin) => plugin.name || plugin.id).join(", ");
  description.textContent = `Required baseline: ${names || "None"}. Current receipt: ${pluginStatusLabel(info.active)}.`;
  summary.append(title, description);
  const actions = document.createElement("div");
  actions.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const note = document.createElement("div");
  note.className = "max-w-xl text-sm text-token-text-secondary";
  note.textContent = info.mode === "enforcement"
    ? "Enforcement blocks switches to accounts without a current receipt."
    : "Observation mode shows receipt status and warns before switching, but does not block it.";
  const controls = document.createElement("div");
  controls.className = "flex items-center gap-2";
  const verify = document.createElement("button");
  verify.type = "button";
  verify.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
  verify.textContent = "Reconcile & Verify";
  verify.title = "Codex will reconcile the current account's remote plugin bundles. It may add or remove locally cached bundles; it does not change server-installed plugins or OAuth connections.";
  verify.addEventListener("click", async () => {
    if (!window.confirm("Reconcile and verify the current account’s remote plugins? Codex may add or remove locally cached remote bundles for this account. This does not change the server-installed profile or OAuth connections.")) return;
    if (state.statusElement) state.statusElement.textContent = "Verifying the current account’s remote plugin inventory…";
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "plugin-protection-verify-current" });
      if (state.statusElement) state.statusElement.textContent = result?.ok
        ? "Current account receipt verified. Reopen this page to refresh status."
        : "Verification did not prove the required remote plugins; no receipt was refreshed.";
    } catch { if (state.statusElement) state.statusElement.textContent = "Verification was unavailable; no receipt was refreshed."; }
  });
  const mode = document.createElement("button");
  mode.type = "button";
  mode.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
  mode.textContent = info.mode === "enforcement" ? "Use Observation" : "Enable Enforcement";
  mode.addEventListener("click", async () => {
    const enabling = info.mode !== "enforcement";
    if (enabling && !window.confirm("Enable enforcement? A target account without a current plugin receipt will be blocked, but you can explicitly bypass one switch.")) return;
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "plugin-protection-configure", enforcement: enabling });
      if (state.statusElement) state.statusElement.textContent = result?.ok ? "Protection setting saved. Reopen this page to refresh status." : "Protection setting could not be saved.";
    } catch { if (state.statusElement) state.statusElement.textContent = "Protection setting could not be saved."; }
  });
  controls.append(verify, mode);
  actions.append(note, controls);
  card.append(summary, actions);
  return card;
}

function pluginStatusLabel(status) {
  if (status?.valid) return "current";
  const code = status?.code || "unavailable";
  return code.replace(/-/g, " ");
}

async function injectAccountMenus(state) {
  const targetMenu = accountMenuTargetFromCandidates(state.accountMenus || []);
  cleanupAccountSwitcherPanels(targetMenu);
  if (!targetMenu || hasDirectAccountSwitcherPanel(targetMenu)) return;
  // Only hit the main process when there is actually a menu to inject into —
  // dedupe BEFORE the IPC so re-scans of an already-injected menu don't trigger
  // a filesystem list on every DOM mutation.
  let response;
  try {
    response = await state.api.ipc.invoke(IPC, { action: "list" });
  } catch { return; }
  if (!response?.ok || state.disposed) return;
  state.pluginProtectionMode = response.pluginProtection?.mode || "observation";
  const currentTarget = accountMenuTargetFromCandidates(state.accountMenus || []);
  if (currentTarget !== targetMenu) {
    cleanupAccountSwitcherPanels(currentTarget);
    return;
  }
  cleanupAccountSwitcherPanels(targetMenu);
  if (hasDirectAccountSwitcherPanel(targetMenu)) return;
  const panel = document.createElement("div");
  panel.dataset.tweakersAccountSwitcher = "true";
  panel.className = "border-token-border my-1 border-t px-2 py-2";
  const title = document.createElement("div");
  title.className = "px-2 pb-1 text-xs font-medium text-token-text-secondary";
  title.textContent = "Switch ChatGPT account";
  panel.append(title);
  for (const account of response.accounts) panel.append(accountButton(state, account));
  const save = document.createElement("button");
  save.type = "button"; save.className = menuButtonClass(); save.textContent = "Save current session…";
  save.addEventListener("click", () => void saveCurrentFromMenu(state));
  panel.append(save);
  targetMenu.append(panel);
}

function accountButton(state, account) {
  const button = document.createElement("button");
  button.type = "button"; button.className = menuButtonClass();
  button.textContent = `${account.active ? "✓ " : ""}${account.label}`;
  button.disabled = account.active;
  button.addEventListener("click", async () => {
    try {
      if (state.pluginProtectionMode === "observation" && account.pluginProtection && !account.pluginProtection.valid) {
        const proceed = window.confirm(`This saved account has no current remote-plugin receipt (${pluginStatusLabel(account.pluginProtection)}). Switch anyway? Observation mode will not block this switch.`);
        if (!proceed) return;
      }
      if (state.statusElement) state.statusElement.textContent = `Preparing to switch to ${account.label}…`;
      const prepared = await state.api.ipc.invoke(IPC, { action: "prepare-switch", ref: account.ref });
      if (!prepared?.ok) {
        if (prepared?.error?.code === "plugin-protection-receipt-required") {
          const bypass = window.confirm("This account does not have a current plugin receipt. Switch once anyway? This bypass is only for this one confirmed switch.");
          if (!bypass) return;
          const bypassPrepared = await state.api.ipc.invoke(IPC, { action: "prepare-switch-bypass", ref: account.ref });
          if (!bypassPrepared?.ok) { alertFailure(state, "The account could not be switched safely.", bypassPrepared); return; }
          if (!window.confirm(bypassPrepared.confirmation)) return;
          const bypassResult = await state.api.ipc.invoke(IPC, { action: "switch", intent: bypassPrepared.intent });
          if (!bypassResult?.ok) { alertFailure(state, "The account could not be switched safely.", bypassResult); return; }
          if (state.statusElement) state.statusElement.textContent = `Switching to ${account.label}; ChatGPT will restart to finish.`;
          if (!bypassResult.restartScheduled) window.alert("The account was changed. Restart ChatGPT to finish switching.");
          return;
        }
        alertFailure(state, "The account could not be switched safely.", prepared); return;
      }
      if (!window.confirm(prepared.confirmation)) return;
      const result = await state.api.ipc.invoke(IPC, { action: "switch", intent: prepared.intent });
      if (result?.ok) {
        if (state.statusElement) state.statusElement.textContent = `Switching to ${account.label}; ChatGPT will restart to finish.`;
        if (!result.restartScheduled) window.alert("The account was changed. Restart ChatGPT to finish switching.");
      } else {
        alertFailure(state, "The account could not be switched safely.", result);
      }
    } catch (error) {
      state.api?.log?.warn?.("account switch failed", String(error));
      window.alert("The account could not be switched safely.");
    }
  });
  return button;
}

async function saveCurrentFromMenu(state) {
  const name = window.prompt("Session name (letters, numbers, dots, dashes, or underscores)");
  if (!name) return false;
  try {
    const prepared = await state.api.ipc.invoke(IPC, { action: "prepare-save", name });
    if (!prepared?.ok) { alertFailure(state, "The session could not be saved safely.", prepared); return false; }
    if (!window.confirm(prepared.confirmation)) return false;
    const result = await state.api.ipc.invoke(IPC, { action: "save", intent: prepared.intent });
    if (!result?.ok) { alertFailure(state, "The session could not be saved safely.", result); return false; }
    return true;
  } catch (error) {
    state.api?.log?.warn?.("account save failed", String(error));
    window.alert("The session could not be saved safely.");
    return false;
  }
}

function alertFailure(state, message, response) {
  const code = response?.error?.code;
  state.api?.log?.warn?.(message, code || "unknown");
  window.alert(code ? `${message}\n(${code})` : message);
}

function cleanupRenderer() {
  globalThis.__tweakersAccountRendererV1?.dispose?.();
  globalThis.__tweakersAccountRendererV1 = null;
}

function disposeRenderer(state) {
  if (state.disposed) return;
  state.disposed = true; state.observer?.disconnect();
  if (state.timer) clearTimeout(state.timer);
  state.page?.unregister?.();
  document.querySelectorAll("[data-tweakers-account-switcher]").forEach((node) => node.remove());
}

function menuButtonClass() { return "hover:bg-token-foreground/5 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-token-text-primary disabled:opacity-60"; }
function accountMenuTargetFromCandidates(elements) {
  const candidates = uniqueElements(elements)
    .filter(isAccountMenuCandidate)
    .filter((element, _index, all) => !all.some((other) => other !== element && element.contains(other) && isAccountMenuCandidate(other)));
  return candidates.length === 1 ? candidates[0] : null;
}
function isAccountMenuCandidate(element) {
  const role = element?.getAttribute?.("role");
  if (role !== "menu" && role !== "dialog") return false;
  const text = element?.textContent || "";
  if (!/log\s*out/i.test(text)) return false;
  if (!/settings|usage\s+remaining|account/i.test(text)) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width < 160 || rect.height < 120) return false;
  if (rect.width > Math.min(620, window.innerWidth) || rect.height > Math.min(900, window.innerHeight)) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
  return true;
}
function cleanupAccountSwitcherPanels(targetMenu) {
  const panels = Array.from(document.querySelectorAll("[data-tweakers-account-switcher]"));
  let kept = false;
  for (const panel of panels) {
    if (targetMenu && panel.parentElement === targetMenu && !kept) {
      kept = true;
      continue;
    }
    panel.remove();
  }
}
function hasDirectAccountSwitcherPanel(menu) {
  return Array.from(menu?.children || []).some((child) => child?.dataset?.tweakersAccountSwitcher === "true");
}
function uniqueElements(elements) { return [...new Set(elements)].filter(Boolean); }
function displayLabelFromAuth(value, fallback) {
  const directEmail = [value?.user?.email, value?.account?.email, value?.email]
    .find((item) => typeof item === "string" && item.trim());
  if (directEmail) {
    const label = directEmail.trim().slice(0, 120);
    if (validLabel(label)) return label;
  }
  const directName = [value?.user?.name, value?.account?.name, value?.name]
    .find((item) => typeof item === "string" && item.trim());
  const token = value?.tokens?.id_token;
  if (typeof token === "string") {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      const claim = [claims.email, claims.preferred_username, claims.name].find((item) => typeof item === "string" && item.trim());
      if (claim) {
        const label = claim.trim().slice(0, 120);
        if (validLabel(label)) return label;
      }
    } catch {}
  }
  if (directName) {
    const label = directName.trim().slice(0, 120);
    if (validLabel(label)) return label;
  }
  const fallbackLabel = String(fallback || "Saved account").slice(0, 120);
  return validLabel(fallbackLabel) ? fallbackLabel : "Saved account";
}
function safeFailure(code) { return { ok: false, error: { code, message: "The account request could not be completed safely." } }; }
function coded(code) { const error = new Error(code); error.code = code; return error; }
function errorCode(error) { return typeof error?.code === "string" && /^[a-z0-9-]+$/.test(error.code) ? error.code : "operation-failed"; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return typeof value === "string" ? value.replace(/(?:Bearer\s+\S+|(?:gh[opsu]|sk)-[A-Za-z0-9_-]+)/g, "[redacted]") : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = /token|cookie|secret|password|authorization|path|env|credential/i.test(key) ? "[redacted]" : redact(item);
  return out;
}

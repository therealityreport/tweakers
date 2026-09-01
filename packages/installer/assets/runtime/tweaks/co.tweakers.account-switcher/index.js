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
const ACCOUNT_ROUTER_SCHEMA_VERSION = 2;
const ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION = 1;
const ACCOUNT_ROUTER_QUOTA_POLICY = "quota_aware_v1";
const ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT = "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
const ACCOUNT_ROUTER_CONFIG_NAME = "account-router-config.json";
const ACCOUNT_ROUTER_STATE_NAME = "router-state.json";
const ACCOUNT_ROUTER_CONTROL_SECRET_NAME = "control-secret.v1";
const ACCOUNT_ROUTER_RECEIPTS_NAME = "migration-receipts.v1.json";
const ACCOUNT_ROUTER_HISTORY_ADOPTION_INTENT_NAME = "history-adoption-intent.v1.json";
const ACCOUNT_ROUTER_HISTORY_ADOPTION_RECEIPT_NAME = "history-adoption-receipt.v1.json";
const ACCOUNT_ROUTER_HISTORY_ADOPTION_OWNERS_NAME = "history-adoption-owners.v1.json";
const ACCOUNT_ROUTER_CONTROL_SOCKET_NAME = "router-control.v1.sock";
const MAX_ROUTER_STATE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_ADOPTION_BYTES = 64 * 1024;
const MAX_HISTORY_ADOPTION_OWNERS_BYTES = 2 * 1024 * 1024;
const ROUTER_CONTROL_FRAME_LIMIT = 4 * 1024;
const ROUTER_CONTROL_TIMEOUT_MS = 2_000;
const ROUTER_TERMINAL_RESERVATION_STATES = new Set(["released_pre_dispatch", "reconciled"]);
const ROUTER_PUBLIC_ERROR_CODES = new Set([
  "invalid-router-mode",
  "untrusted-router-directory",
  "router-requires-exactly-two-accounts",
  "invalid-router-weight",
  "router-requires-distinct-accounts",
  "router-history-owner-required",
  "router-history-owner-not-selected",
  "router-history-adoption-invalid",
  "router-history-adoption-mismatch",
  "router-state-mismatch-requires-reset",
  "router-not-idle",
  "router-recovery-router-running",
  "router-recovery-router-status-unavailable",
  "router-recovery-account-mismatch",
  "router-recovery-not-needed",
  "router-operation-failed",
]);
const ROUTER_PUBLIC_ELIGIBILITY = new Set([
  "validating", "eligible", "reserved", "active", "cooldown", "quota_depleted",
  "reauth_required", "plugin_blocked", "protocol_blocked", "disabled", "unhealthy",
]);
const ROUTER_PUBLIC_DEGRADED_REASONS = new Set([
  "invalid_config", "unsupported_protocol", "startup_selfcheck_failed", "pool_depleted",
  "capability_mismatch", "policy_stop", "post_start_failure", "account_unauthenticated",
  "account_disabled", "account_unhealthy", "quota_depleted", "quota_stale", "quota_unknown",
]);
const ROUTER_CONTROL_FAILURE_MESSAGES = Object.freeze({
  "invalid-router-mode": "The requested router mode is unavailable.",
  "untrusted-router-directory": "Router storage could not be verified safely.",
  "router-requires-exactly-two-accounts": "Choose exactly two saved accounts before staging balanced mode.",
  "invalid-router-weight": "Each selected account needs a routing weight from 1 to 100.",
  "router-requires-distinct-accounts": "Choose two different saved accounts before staging balanced mode.",
  "router-history-owner-required": "Choose which selected account should keep your existing history before staging.",
  "router-history-owner-not-selected": "The history owner must be one of the two selected saved accounts.",
  "router-history-adoption-invalid": "The saved offline history-adoption record could not be verified safely.",
  "router-history-adoption-mismatch": "Existing adopted history belongs to a different selected account pool or owner.",
  "router-state-mismatch-requires-reset": "Existing router history does not match this account pool or weights. Restore its original pool, or keep Manual pending until explicit recovery is available.",
  "router-not-idle": "Balance reset requires an idle router.",
  "router-recovery-router-running": "Recovery is blocked while the router is running. Stop it first, then retry recovery.",
  "router-recovery-router-status-unavailable": "Recovery needs a confirmed stopped router, but its status could not be verified.",
  "router-recovery-account-mismatch": "The current sign-in does not match the saved account selected for recovery.",
  "router-recovery-not-needed": "The isolated account home already matches the current saved authentication.",
  "router-operation-failed": "The router action could not be completed safely.",
});
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
      // isolated homes, but make the next authorized startup keep the adopted
      // history mux while assigning new threads to the primary account only.
      // It never interrupts an already-open stdio session.
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
    stableRef, authPaths, displayLabelFromAuth, safeSnapshotLabel, syncActiveSnapshot,
    cleanupLegacyAnalytics, accountMenuTargetFromCandidates, startRenderer, disposeRenderer,
    defaultPluginProfile, normalizePluginProfile, profileHash, evaluatePluginReceipt,
    makePluginReceipt, inventoryPlugins, validateOfficialInventory, runtimeCodexBinding, readOfficialPluginInventory,
    accountRouterPaths, opaqueAccountId, validateRouterConfig, routerConfigFingerprint, routerPublicStatus,
    historyPoolFingerprint, historyAdoptionIntentFingerprint, historyAdoptionThreadOwnersFingerprint,
    signHistoryAdoptionIntent, signHistoryAdoptionOwners, signHistoryAdoptionReceipt,
    validateHistoryAdoptionIntent, validateHistoryAdoptionOwners, validateHistoryAdoptionReceipt,
    readHistoryAdoptionRecords, historyAdoptionProjection,
    stageBalancedRouterConfig, stageManualRouterConfig, recoverRouterAccount, resetRouterBalanceEpoch,
    readRouterConfig, readRouterState, routerControlFailure, routerPresentation,
    authenticatedRouterStatus, routerControlSocketPath, parseAuthenticatedRouterStatus, routerControlCard,
    quotaPoolRemainingPercent, accountDetailsFor, accountMenuRows, advancedAccountsCard, accountRecoveryCard, maskIdentifier, safeAccountLabel,
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
      if (message?.action === "router-recover") return service.recoverRouterAccount(message);
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
    recoverRouterAccount(message) { return enqueue(() => recoverRouterAccount(api, deps, paths, refs, message)); },
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
  const stopSnapshotSync = startActiveSnapshotSync(deps, paths, api, () => disposed, enqueue);
  return service;
}

function startActiveSnapshotSync(deps, paths, api, isDisposed, enqueue) {
  const fs = deps.fs;
  if (typeof fs.watch !== "function") return () => {};
  let timer = null;
  let watcher = null;
  const warn = () => api.log?.warn?.("Account Router marker reconciliation failed", "router-operation-failed");
  const sync = () => {
    timer = null;
    if (isDisposed()) return;
    const task = () => {
      if (!isDisposed()) syncActiveSnapshot(deps, paths);
    };
    if (typeof enqueue === "function") {
      Promise.resolve(enqueue(task)).catch(warn);
    } else {
      try { task(); } catch { warn(); }
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
    api.log?.warn?.("Account Router marker reconciliation unavailable", "router-operation-failed");
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
  const live = readLiveAuthMetadata(deps, paths);
  if (!live) return;

  if (marker.status === "ok" && marker.value) {
    try {
      const marked = readSnapshotMetadata(deps, paths, marker.value);
      if (marked.accountId === live.accountId) {
        syncMarkedSnapshot(deps, paths, marker.value, live, marked);
        return;
      }
    } catch {
      // The deterministic inventory below must reject an unsafe candidate
      // before it can be considered for a marker repair.
    }
  }
  reconcileCurrentMarker(deps, paths, marker, live);
}

function authAccountId(value) {
  const id = value?.tokens?.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function authSnapshotMetadata(snapshot, filename = null) {
  const accountId = authAccountId(snapshot.value);
  return accountId ? { filename, accountId, identity: snapshot.identity, hash: snapshot.hash } : null;
}

function readLiveAuthMetadata(deps, paths) {
  return withSecureAuth(deps.fs, paths.authFile, (snapshot) => authSnapshotMetadata(snapshot));
}

function readSnapshotMetadata(deps, paths, filename) {
  const target = sourceFilePath(deps.path, paths.accountsDir, filename);
  return withSecureAuth(deps.fs, target, (snapshot) => {
    const metadata = authSnapshotMetadata(snapshot, filename);
    if (!metadata) throw coded("router-operation-failed");
    return metadata;
  });
}

function sameAuthMetadata(left, right) {
  return Boolean(left && right
    && left.accountId === right.accountId
    && left.identity === right.identity
    && left.hash === right.hash);
}

function sameMarker(left, right) {
  return left?.status === right?.status && left?.value === right?.value;
}

function trustedRepairMarker(marker) {
  return (marker?.status === "missing" && marker.value === null)
    || (marker?.status === "ok" && typeof marker.value === "string");
}

function sameMarkerSnapshot(left, right) {
  if (!sameMarker(left, right)) return false;
  if (left?.status === "missing") return left.bytes === null && right?.bytes === null;
  return Buffer.isBuffer(left?.bytes) && Buffer.isBuffer(right?.bytes) && left.bytes.equals(right.bytes);
}

function snapshotInventory(deps, paths) {
  const fs = deps.fs;
  if (!routerPathStatOrNull(fs, paths.accountsDir)) return [];
  assertTrustedDirectory(fs, paths.codexDir);
  assertTrustedDirectory(fs, paths.accountsDir);
  const entries = fs.readdirSync(paths.accountsDir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  return entries.map((entry) => {
    if (!entry.isFile()) throw coded("router-operation-failed");
    return readSnapshotMetadata(deps, paths, entry.name);
  });
}

function sameSnapshotInventory(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.filename === other?.filename
      && entry.accountId === other.accountId
      && entry.identity === other.identity
      && entry.hash === other.hash;
  });
}

function syncMarkedSnapshot(deps, paths, filename, expectedLive, expectedSnapshot) {
  if (expectedLive.hash === expectedSnapshot.hash) return;
  const target = sourceFilePath(deps.path, paths.accountsDir, filename);
  withSecureAuth(deps.fs, paths.authFile, (liveSnapshot) => {
    const live = authSnapshotMetadata(liveSnapshot);
    if (!sameAuthMetadata(live, expectedLive)) return;
    return withSecureAuth(deps.fs, target, (selectedSnapshot) => {
      const selected = authSnapshotMetadata(selectedSnapshot, filename);
      if (!sameAuthMetadata(selected, expectedSnapshot) || selected.accountId !== live.accountId) return;
      if (live.hash !== selected.hash) atomicWrite(deps, paths.accountsDir, target, liveSnapshot.bytes);
    });
  });
}

function inventoryMatchesReconciledLive(before, after, selectedFilename, live) {
  if (before.length !== after.length) return false;
  for (const expected of before) {
    const observed = after.find((item) => item.filename === expected.filename);
    if (!observed || observed.accountId !== expected.accountId) return false;
    if (expected.filename === selectedFilename) {
      if (observed.hash !== live.hash) return false;
    } else if (!sameAuthMetadata(expected, observed)) {
      return false;
    }
  }
  return after.filter((item) => item.accountId === live.accountId).length === 1;
}

function writeReconciledMarker(deps, paths, filename, expectedMarker) {
  if (!trustedRepairMarker(expectedMarker)) return false;
  let previous;
  let rechecked;
  let bytes;
  let writeAttempted = false;
  try {
    previous = readCurrentMarkerSnapshot(deps.fs, paths.currentMarker);
    if (!trustedRepairMarker(previous) || !sameMarker(previous, expectedMarker)) return false;
    rechecked = readCurrentMarkerSnapshot(deps.fs, paths.currentMarker);
    if (!sameMarkerSnapshot(previous, rechecked)) return false;
    clearSecretBuffer(rechecked.bytes); rechecked = undefined;
    bytes = Buffer.from(`${filename}\n`, "utf8");
    writeAttempted = true;
    atomicWrite(deps, paths.codexDir, paths.currentMarker, bytes);
    const written = readCurrentMarker(deps.fs, paths.currentMarker);
    if (written.status !== "ok" || written.value !== filename) throw coded("router-operation-failed");
    return true;
  } catch {
    if (writeAttempted) {
      try {
        restoreReconciledMarker(deps, paths, previous);
      } catch {
        throw coded("router-operation-failed");
      }
    }
    throw coded("router-operation-failed");
  } finally {
    clearSecretBuffer(bytes);
    clearSecretBuffer(rechecked?.bytes);
    clearSecretBuffer(previous?.bytes);
  }
}

function restoreReconciledMarker(deps, paths, previous) {
  if (!trustedRepairMarker(previous)) throw coded("router-operation-failed");
  restoreOptional(deps, paths.codexDir, paths.currentMarker, previous.status === "ok" ? previous.bytes : null);
  const restored = readCurrentMarkerSnapshot(deps.fs, paths.currentMarker);
  try {
    if (!sameMarkerSnapshot(previous, restored)) throw coded("router-operation-failed");
  } finally {
    clearSecretBuffer(restored.bytes);
  }
}

function reconcileCurrentMarker(deps, paths, expectedMarker, expectedLive) {
  if (!trustedRepairMarker(expectedMarker)) return;
  const initial = snapshotInventory(deps, paths);
  const matches = initial.filter((snapshot) => snapshot.accountId === expectedLive.accountId);
  if (matches.length !== 1) return;
  const selected = matches[0];
  const rechecked = snapshotInventory(deps, paths);
  if (!sameSnapshotInventory(initial, rechecked) || !sameMarker(readCurrentMarker(deps.fs, paths.currentMarker), expectedMarker)) return;

  const target = sourceFilePath(deps.path, paths.accountsDir, selected.filename);
  const updated = withSecureAuth(deps.fs, paths.authFile, (liveSnapshot) => {
    const live = authSnapshotMetadata(liveSnapshot);
    if (!sameAuthMetadata(live, expectedLive)) return false;
    return withSecureAuth(deps.fs, target, (selectedSnapshot) => {
      const currentSelected = authSnapshotMetadata(selectedSnapshot, selected.filename);
      if (!sameAuthMetadata(currentSelected, selected) || currentSelected.accountId !== live.accountId) return false;
      if (live.hash !== currentSelected.hash) atomicWrite(deps, paths.accountsDir, target, liveSnapshot.bytes);
      return true;
    });
  });
  if (!updated) return;

  const finalLive = readLiveAuthMetadata(deps, paths);
  const finalInventory = snapshotInventory(deps, paths);
  if (!sameAuthMetadata(finalLive, expectedLive)
    || !inventoryMatchesReconciledLive(initial, finalInventory, selected.filename, finalLive)) return;
  writeReconciledMarker(deps, paths, selected.filename, expectedMarker);
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
      const entries = deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name));
      const labels = savedSnapshotLabels(entries);
      for (const entry of entries) {
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
            // This is the renderer boundary. `displayLabelFromAuth` deliberately
            // excludes emails and provider fields; only a safe local label and a
            // fixed permanent mask may cross into renderer-facing account rows.
            label: labels.get(entry.name) || safeSnapshotLabel(auth.value, entry.name, 1),
            identifierMasked: maskIdentifier(),
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
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw coded("invalid-existing-state");
    }
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

function readCurrentMarkerSnapshot(fs, file) {
  let fd;
  let bytes;
  let transferred = false;
  try {
    // Open with O_NOFOLLOW and fstat the fd (TOCTOU-safe), matching the rigor of
    // readSecureAuth rather than lstat-then-read.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 256) return { value: null, status: "invalid", bytes: null };
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length) return { value: null, status: "invalid", bytes: null };
    const value = bytes.toString("utf8").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(value)) return { value: null, status: "invalid", bytes: null };
    transferred = true;
    return { value, status: "ok", bytes };
  } catch (error) {
    return { value: null, status: error?.code === "ENOENT" ? "missing" : "invalid", bytes: null };
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (!transferred) clearSecretBuffer(bytes);
    }
  }
}

function readCurrentMarker(fs, file) {
  const marker = readCurrentMarkerSnapshot(fs, file);
  try {
    return { value: marker.value, status: marker.status };
  } finally {
    clearSecretBuffer(marker.bytes);
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
    historyAdoptionIntentFile: deps.path.join(routerDir, ACCOUNT_ROUTER_HISTORY_ADOPTION_INTENT_NAME),
    historyAdoptionReceiptFile: deps.path.join(routerDir, ACCOUNT_ROUTER_HISTORY_ADOPTION_RECEIPT_NAME),
    historyAdoptionOwnersFile: deps.path.join(routerDir, ACCOUNT_ROUTER_HISTORY_ADOPTION_OWNERS_NAME),
  };
}

function routerPathStatOrNull(fs, target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    if (["ENOTDIR", "ELOOP"].includes(error?.code)) throw coded("untrusted-router-directory");
    throw coded("router-operation-failed");
  }
}

function routerUid(deps) {
  const uid = typeof deps?.getuid === "function" ? deps.getuid() : null;
  if (!Number.isInteger(uid)) throw coded("untrusted-router-directory");
  return uid;
}

function sameDirectoryIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.uid === right?.uid;
}

function trustedRouterDirectoryStat(stat, uid) {
  return Boolean(stat && typeof stat.isDirectory === "function" && stat.isDirectory()
    && stat.uid === uid && (stat.mode & 0o022) === 0);
}

function inspectRouterDirectory(deps, directory, harden) {
  const fs = deps.fs;
  const constants = fs?.constants;
  if (!Number.isInteger(constants?.O_RDONLY) || !Number.isInteger(constants?.O_DIRECTORY)
    || !Number.isInteger(constants?.O_NOFOLLOW) || typeof fs?.openSync !== "function"
    || typeof fs?.fstatSync !== "function" || typeof fs?.closeSync !== "function"
    || (harden && typeof fs?.fchmodSync !== "function")) throw coded("untrusted-router-directory");
  const uid = routerUid(deps);
  let fd;
  try {
    fd = fs.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!trustedRouterDirectoryStat(before, uid)) throw coded("untrusted-router-directory");
    if (!harden) return before;

    // A shared parent is only inspected. Router-owned descendants are hardened
    // through this opened descriptor, never with a path-level chmod.
    fs.fchmodSync(fd, 0o700);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(directory);
    if (!trustedRouterDirectoryStat(after, uid) || (after.mode & 0o777) !== 0o700
      || !trustedRouterDirectoryStat(current, uid) || current.isSymbolicLink()
      || !sameDirectoryIdentity(after, current)) throw coded("untrusted-router-directory");
    return after;
  } catch (error) {
    if (error?.code === "untrusted-router-directory") throw error;
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw coded("untrusted-router-directory");
    throw coded("router-operation-failed");
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail closed before caller mutation */ }
    }
  }
}

function hardenRouterChild(deps, parent, child, create) {
  const fs = deps.fs;
  const parentPath = deps.path.resolve(parent);
  const childPath = deps.path.resolve(child);
  if (deps.path.dirname(childPath) !== parentPath) throw coded("untrusted-router-directory");
  const parentBefore = inspectRouterDirectory(deps, parentPath, false);
  const existing = routerPathStatOrNull(fs, childPath);
  if (!existing) {
    if (!create) throw coded("untrusted-router-directory");
    try { fs.mkdirSync(childPath, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw coded("router-operation-failed");
    }
  }
  const childStat = inspectRouterDirectory(deps, childPath, true);
  const parentAfter = inspectRouterDirectory(deps, parentPath, false);
  if (!sameDirectoryIdentity(parentBefore, parentAfter)) throw coded("untrusted-router-directory");
  return childStat;
}

function ensureRouterRoot(deps, paths) {
  assertTrustedDirectory(deps.fs, paths.codexDir);
  const routerPaths = accountRouterPaths(deps, paths);
  // `tweak-data` is a runtime-owned shared parent. It may be 0755, but it
  // must be trusted and is never chmodded by this tweak.
  hardenRouterChild(deps, deps.path.dirname(routerPaths.routerDir), routerPaths.routerDir, true);
  hardenRouterChild(deps, routerPaths.routerDir, routerPaths.accountsDir, true);
  return routerPaths;
}

function routerSecret(deps, routerPaths) {
  const fs = deps.fs;
  hardenRouterChild(deps, deps.path.dirname(routerPaths.routerDir), routerPaths.routerDir, false);
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
// Legacy v1 intent accepted optional fractional seconds. Keep that read-only
// compatibility while making every new v2 generation match Date#toISOString.
function isUtcIsoTimestamp(value) { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value); }
function isCanonicalUtcIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function isoNow(deps) { return new Date(deps.now()).toISOString(); }
function safeAccountLabel(value, fallback = "Saved account") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
  // Account labels are renderer-visible. Do not let a snapshot filename or a
  // provider identifier turn into a display identifier by accident.
  if (!normalized || /[@/\\\\]/.test(normalized) || !validLabel(normalized)) return fallback;
  return normalized;
}
function maskIdentifier(_value) { return "••••••••"; }
function canonicalRouterIntent(value) {
  return {
    schemaVersion: value.schemaVersion,
    mode: value.mode,
    policy: value.policy,
    generation: value.generation,
    protocolFingerprint: value.protocolFingerprint,
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    accounts: value.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
      weight: account.weight,
      capabilityFingerprint: account.capabilityFingerprint,
      ...(account.label ? { label: account.label } : {}),
    })),
  };
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function routerConfigFingerprint(value) {
  const { createHash } = require("node:crypto");
  return `sha256:${createHash("sha256").update(canonicalJson(canonicalRouterIntent(value)), "utf8").digest("hex")}`;
}

function canonicalFingerprint(value) {
  const { createHash } = require("node:crypto");
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function historyPoolFingerprint(protocolFingerprint, opaqueAccountIds) {
  if (protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !Array.isArray(opaqueAccountIds) || opaqueAccountIds.length !== 2
    || opaqueAccountIds.some((opaqueId) => !isOpaqueAccountId(opaqueId))
    || new Set(opaqueAccountIds).size !== 2) throw coded("invalid-history-adoption-intent");
  return canonicalFingerprint({
    protocolFingerprint,
    accountOpaqueIds: [...opaqueAccountIds].sort(),
  });
}

function historyUnsigned(value) {
  if (!isRecord(value)) return null;
  const { hmac, ...unsigned } = value;
  return unsigned;
}

function historyHmac(secret, value) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32 || !isRecord(value)) throw coded("invalid-history-adoption-intent");
  const { createHmac } = require("node:crypto");
  return `hmac-sha256:${createHmac("sha256", secret).update(canonicalJson(historyUnsigned(value)), "utf8").digest("hex")}`;
}

function matchesHistoryHmac(secret, value) {
  if (typeof value?.hmac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.hmac)) return false;
  const expected = historyHmac(secret, value);
  const { timingSafeEqual } = require("node:crypto");
  return timingSafeEqual(Buffer.from(value.hmac, "utf8"), Buffer.from(expected, "utf8"));
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function signHistoryAdoptionIntent(secret, value) {
  const unsigned = historyUnsigned(value);
  if (!unsigned) throw coded("invalid-history-adoption-intent");
  return { ...unsigned, hmac: historyHmac(secret, unsigned) };
}

function historyAdoptionIntentFingerprint(value) {
  const unsigned = historyUnsigned(value);
  if (!unsigned) throw coded("invalid-history-adoption-intent");
  return canonicalFingerprint(unsigned);
}

function canonicalHistoryThreadIds(value) {
  if (!Array.isArray(value)
    || value.some((threadId) => typeof threadId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(threadId))) {
    throw coded("invalid-history-adoption-owners");
  }
  const sorted = [...value].sort();
  if (sorted.some((threadId, index) => index > 0 && sorted[index - 1] === threadId)) {
    throw coded("invalid-history-adoption-owners");
  }
  return sorted;
}

function historyAdoptionThreadOwnersFingerprint(threadIds, legacyOwnerOpaqueAccountId) {
  if (!isOpaqueAccountId(legacyOwnerOpaqueAccountId)) throw coded("invalid-history-adoption-owners");
  return canonicalFingerprint(canonicalHistoryThreadIds(threadIds)
    .map((threadId) => ({ threadId, opaqueAccountId: legacyOwnerOpaqueAccountId })));
}

function validateHistoryAdoptionIntent(value, secret) {
  const keys = ["schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "configGeneration", "configFingerprint", "legacyOwnerOpaqueAccountId", "createdAt", "hmac"];
  if (!hasExactKeys(value, keys)
    || value.schemaVersion !== 1 || value.kind !== "account-router-history-adoption-intent"
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isFingerprint(value.poolFingerprint) || !Number.isInteger(value.configGeneration) || value.configGeneration < 1
    || !isFingerprint(value.configFingerprint) || !isOpaqueAccountId(value.legacyOwnerOpaqueAccountId)
    || !isCanonicalUtcIsoTimestamp(value.createdAt) || !matchesHistoryHmac(secret, value)) throw coded("invalid-history-adoption-intent");
  return value;
}

function signHistoryAdoptionOwners(secret, value) {
  const unsigned = historyUnsigned(value);
  if (!unsigned) throw coded("invalid-history-adoption-owners");
  return { ...unsigned, hmac: historyHmac(secret, unsigned) };
}

function validateHistoryAdoptionOwners(value, secret) {
  const keys = ["schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "legacyOwnerOpaqueAccountId", "threadIds", "threadOwnersFingerprint", "adoptedAt", "hmac"];
  if (!hasExactKeys(value, keys)
    || value.schemaVersion !== 1 || value.kind !== "account-router-history-adoption-owners"
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isFingerprint(value.poolFingerprint) || !isOpaqueAccountId(value.legacyOwnerOpaqueAccountId)
    || !Array.isArray(value.threadIds) || !isFingerprint(value.threadOwnersFingerprint)
    || !isCanonicalUtcIsoTimestamp(value.adoptedAt) || !matchesHistoryHmac(secret, value)) {
    throw coded("invalid-history-adoption-owners");
  }
  const threadIds = canonicalHistoryThreadIds(value.threadIds);
  if (canonicalJson(threadIds) !== canonicalJson(value.threadIds)
    || value.threadOwnersFingerprint !== historyAdoptionThreadOwnersFingerprint(threadIds, value.legacyOwnerOpaqueAccountId)) {
    throw coded("invalid-history-adoption-owners");
  }
  return { ...value, threadIds };
}

const HISTORY_ADOPTION_DATABASE_NAMES = Object.freeze([
  "goals_1.sqlite", "logs_2.sqlite", "memories_1.sqlite", "queue_1.sqlite", "state_5.sqlite", "thread_history_1.sqlite",
]);
const HISTORY_ADOPTION_HISTORY_NAMES = Object.freeze(["archived_sessions", "session_index.jsonl", "sessions"]);

function validateHistoryAdoptionDatabases(value) {
  return Array.isArray(value) && value.length === HISTORY_ADOPTION_DATABASE_NAMES.length
    && value.every((entry, index) => hasExactKeys(entry, ["name", "present", "sha256", "bytes", "integrity"])
      && entry.name === HISTORY_ADOPTION_DATABASE_NAMES[index] && typeof entry.present === "boolean"
      && Number.isInteger(entry.bytes) && entry.bytes >= 0
      && (entry.present
        ? isFingerprint(entry.sha256) && entry.integrity === "ok"
        : entry.sha256 === null && entry.bytes === 0 && entry.integrity === null));
}

function validateHistoryAdoptionHistories(value) {
  return Array.isArray(value) && value.length === HISTORY_ADOPTION_HISTORY_NAMES.length
    && value.every((entry, index) => hasExactKeys(entry, ["name", "present", "sha256", "bytes", "fileCount"])
      && entry.name === HISTORY_ADOPTION_HISTORY_NAMES[index] && typeof entry.present === "boolean"
      && Number.isInteger(entry.bytes) && entry.bytes >= 0 && Number.isInteger(entry.fileCount) && entry.fileCount >= 0
      && (entry.present
        ? isFingerprint(entry.sha256)
        : entry.sha256 === null && entry.bytes === 0 && entry.fileCount === 0));
}

function signHistoryAdoptionReceipt(secret, value) {
  const unsigned = historyUnsigned(value);
  if (!unsigned) throw coded("invalid-history-adoption-receipt");
  return { ...unsigned, hmac: historyHmac(secret, unsigned) };
}

function validateHistoryAdoptionReceipt(value, secret) {
  const keys = ["schemaVersion", "kind", "protocolFingerprint", "poolFingerprint", "intentFingerprint", "legacyOwnerOpaqueAccountId", "sourceFingerprint", "destinationFingerprint", "databases", "histories", "importedThreadCount", "threadOwnersFingerprint", "backupFingerprint", "adoptedAt", "hmac"];
  if (!hasExactKeys(value, keys)
    || value.schemaVersion !== 1 || value.kind !== "account-router-history-adoption-receipt"
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isFingerprint(value.poolFingerprint) || !isFingerprint(value.intentFingerprint)
    || !isOpaqueAccountId(value.legacyOwnerOpaqueAccountId)
    || !isFingerprint(value.sourceFingerprint) || !isFingerprint(value.destinationFingerprint)
    || !validateHistoryAdoptionDatabases(value.databases) || !validateHistoryAdoptionHistories(value.histories)
    || !Number.isInteger(value.importedThreadCount) || value.importedThreadCount < 0
    || !isFingerprint(value.threadOwnersFingerprint) || !isFingerprint(value.backupFingerprint)
    || !isCanonicalUtcIsoTimestamp(value.adoptedAt) || !matchesHistoryHmac(secret, value)) throw coded("invalid-history-adoption-receipt");
  return value;
}

function historyAdoptionFilePresent(deps, file) {
  return Boolean(routerPathStatOrNull(deps.fs, file));
}

function readHistoryAdoptionRecords(deps, routerPaths, suppliedSecret = null) {
  let intentPresent;
  let receiptPresent;
  let ownersPresent;
  try {
    intentPresent = historyAdoptionFilePresent(deps, routerPaths.historyAdoptionIntentFile);
    receiptPresent = historyAdoptionFilePresent(deps, routerPaths.historyAdoptionReceiptFile);
    ownersPresent = historyAdoptionFilePresent(deps, routerPaths.historyAdoptionOwnersFile);
  } catch {
    return { intent: null, receipt: null, owners: null, intentInvalid: true, receiptInvalid: true, ownersInvalid: true };
  }
  if (!intentPresent && !receiptPresent && !ownersPresent) {
    return { intent: null, receipt: null, owners: null, intentInvalid: false, receiptInvalid: false, ownersInvalid: false };
  }
  let secret = suppliedSecret;
  let ownsSecret = false;
  try {
    if (!secret) { secret = existingRouterSecret(deps, routerPaths); ownsSecret = true; }
    let intent = null;
    let receipt = null;
    let owners = null;
    let intentInvalid = false;
    let receiptInvalid = false;
    let ownersInvalid = false;
    if (intentPresent) {
      try { intent = validateHistoryAdoptionIntent(readPrivateJson(deps, routerPaths.historyAdoptionIntentFile, MAX_HISTORY_ADOPTION_BYTES, "invalid-history-adoption-intent"), secret); }
      catch { intentInvalid = true; }
    }
    if (receiptPresent) {
      try { receipt = validateHistoryAdoptionReceipt(readPrivateJson(deps, routerPaths.historyAdoptionReceiptFile, MAX_HISTORY_ADOPTION_BYTES, "invalid-history-adoption-receipt"), secret); }
      catch { receiptInvalid = true; }
    }
    if (ownersPresent) {
      try { owners = validateHistoryAdoptionOwners(readPrivateJson(deps, routerPaths.historyAdoptionOwnersFile, MAX_HISTORY_ADOPTION_OWNERS_BYTES, "invalid-history-adoption-owners"), secret); }
      catch { ownersInvalid = true; }
    }
    return { intent, receipt, owners, intentInvalid, receiptInvalid, ownersInvalid };
  } catch {
    return {
      intent: null,
      receipt: null,
      owners: null,
      intentInvalid: intentPresent,
      receiptInvalid: receiptPresent,
      ownersInvalid: ownersPresent,
    };
  } finally {
    if (ownsSecret) clearSecretBuffer(secret);
  }
}

function historyOwnerLabel(config, opaqueId) {
  const index = config?.accounts?.findIndex((account) => account.opaqueAccountId === opaqueId);
  return index >= 0 ? safeAccountLabel(config.accounts[index].label, `Account ${index + 1}`) : null;
}

function historyAdoptionReceiptMatchesIntent(records) {
  return Boolean(records?.intent) && !records.intentInvalid && !records.receiptInvalid
    && records.receipt?.intentFingerprint === historyAdoptionIntentFingerprint(records.intent)
    && records.receipt.protocolFingerprint === records.intent.protocolFingerprint
    && records.receipt.poolFingerprint === records.intent.poolFingerprint
    && records.receipt.legacyOwnerOpaqueAccountId === records.intent.legacyOwnerOpaqueAccountId;
}

function completedHistoryAdoptionState(config, state, records) {
  if (records?.intentInvalid || records?.receiptInvalid || records?.ownersInvalid) return "invalid";
  if (!records?.receipt && !records?.owners) return null;
  if (!records.intent || !records.receipt || !records.owners || !historyAdoptionReceiptMatchesIntent(records)) return "invalid";
  const usableConfig = config?.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION
    && Array.isArray(config.accounts) && config.accounts.length === 2;
  if (!usableConfig) return "mismatch";
  const poolFingerprint = historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId));
  const owner = records.intent.legacyOwnerOpaqueAccountId;
  if (records.intent.poolFingerprint !== poolFingerprint || !config.accounts.some((account) => account.opaqueAccountId === owner)) {
    return "mismatch";
  }
  if (records.receipt.protocolFingerprint !== config.protocolFingerprint
    || records.receipt.poolFingerprint !== poolFingerprint
    || records.receipt.legacyOwnerOpaqueAccountId !== owner
    || records.owners.protocolFingerprint !== config.protocolFingerprint
    || records.owners.poolFingerprint !== poolFingerprint
    || records.owners.legacyOwnerOpaqueAccountId !== owner
    || records.receipt.adoptedAt !== records.owners.adoptedAt
    || records.receipt.importedThreadCount !== records.owners.threadIds.length
    || records.receipt.threadOwnersFingerprint !== records.owners.threadOwnersFingerprint) return "invalid";
  if (!state || !isRecord(state.threadOwners) || !isRecord(state.pendingThreadOwners)) return "invalid";
  for (const threadId of records.owners.threadIds) {
    if (state.threadOwners[threadId] !== owner) return "invalid";
    const pending = state.pendingThreadOwners[threadId];
    if (pending !== undefined && pending !== owner) return "invalid";
  }
  return "adopted";
}

function historyAdoptionProjection(config, records = null, state = null) {
  const required = { state: "required", ownerLabel: null, importedThreadCount: 0, databaseCount: 0, historyCount: 0 };
  const source = records || {
    intent: null, receipt: null, owners: null, intentInvalid: false, receiptInvalid: false, ownersInvalid: false,
  };
  const completed = completedHistoryAdoptionState(config, state, source);
  if (completed === "invalid" || completed === "mismatch") return { ...required, state: completed };
  const usableConfig = config?.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION && Array.isArray(config.accounts) && config.accounts.length === 2;
  if (completed === "adopted") {
    const ownerLabel = historyOwnerLabel(config, source.receipt.legacyOwnerOpaqueAccountId);
    if (!ownerLabel) return { ...required, state: "mismatch" };
    return {
      state: "adopted",
      ownerLabel,
      importedThreadCount: source.receipt.importedThreadCount,
      databaseCount: source.receipt.databases.filter((entry) => entry.present).length,
      historyCount: source.receipt.histories.filter((entry) => entry.present).length,
    };
  }
  if (source.intentInvalid) return { ...required, state: "invalid" };
  if (!source.intent) return required;
  if (!usableConfig) return { ...required, state: "mismatch" };
  const poolFingerprint = historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId));
  const ownerLabel = historyOwnerLabel(config, source.intent.legacyOwnerOpaqueAccountId);
  if (source.intent.poolFingerprint !== poolFingerprint || source.intent.configGeneration !== config.generation
    || source.intent.configFingerprint !== config.fingerprint || !ownerLabel) return { ...required, state: "mismatch" };
  return { ...required, state: "pending_offline_adoption", ownerLabel };
}

function createHistoryAdoptionIntent(deps, config, legacyOwnerOpaqueAccountId, secret) {
  const poolFingerprint = historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId));
  return signHistoryAdoptionIntent(secret, {
    schemaVersion: 1,
    kind: "account-router-history-adoption-intent",
    protocolFingerprint: config.protocolFingerprint,
    poolFingerprint,
    configGeneration: config.generation,
    configFingerprint: config.fingerprint,
    legacyOwnerOpaqueAccountId,
    createdAt: isoNow(deps),
  });
}

function writeHistoryAdoptionIntent(deps, routerPaths, intent) {
  const bytes = Buffer.from(JSON.stringify(intent), "utf8");
  try {
    if (bytes.length > MAX_HISTORY_ADOPTION_BYTES) throw coded("invalid-history-adoption-intent");
    atomicWrite(deps, routerPaths.routerDir, routerPaths.historyAdoptionIntentFile, bytes);
  } finally { clearSecretBuffer(bytes); }
}

function assertHistoryAdoptionMayStage(config, records, legacyOwnerOpaqueAccountId, state = null) {
  if (records.intentInvalid || records.receiptInvalid || records.ownersInvalid) throw coded("router-history-adoption-invalid");
  if (!records.receipt && !records.owners) {
    // A valid pre-adoption intent is deliberately replaceable by this explicit
    // staging action. A tampered one is not silently overwritten.
    return;
  }
  const evidenceState = completedHistoryAdoptionState(config, state, records);
  if (evidenceState === "mismatch") throw coded("router-history-adoption-mismatch");
  if (evidenceState !== "adopted") throw coded("router-history-adoption-invalid");
  if (legacyOwnerOpaqueAccountId !== null && legacyOwnerOpaqueAccountId !== undefined
    && records.intent.legacyOwnerOpaqueAccountId !== legacyOwnerOpaqueAccountId) throw coded("router-history-adoption-mismatch");
}

function routerConfigGeneration(existing) {
  return existing?.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION && Number.isInteger(existing.generation)
    ? existing.generation + 1
    : 1;
}
function pendingCapabilityFingerprint(opaqueId) {
  const { createHash } = require("node:crypto");
  return `sha256:${createHash("sha256").update(`account-router:v1:pending-capability:${opaqueId}`).digest("hex")}`;
}

function validateRouterConfig(value) {
  if (!isRecord(value)) throw coded("invalid-router-config");
  if (value.schemaVersion === ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION) return validateLegacyRouterConfig(value);
  if (value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
    || Object.keys(value).length !== 9
    || !["manual", "quota_aware"].includes(value.mode)
    || (value.mode === "quota_aware" ? value.policy !== ACCOUNT_ROUTER_QUOTA_POLICY : value.policy !== null)
    || !Number.isInteger(value.generation) || value.generation < 1
    || !isFingerprint(value.fingerprint)
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !Array.isArray(value.accounts) || value.accounts.length !== 2
    || !isCanonicalUtcIsoTimestamp(value.updatedAt)) throw coded("invalid-router-config");
  const seen = new Set();
  for (const account of value.accounts) {
    if (!isRecord(account) || Object.keys(account).length !== 5
      || !isOpaqueAccountId(account.opaqueAccountId) || typeof account.included !== "boolean"
      || !Number.isInteger(account.weight) || account.weight < 1 || account.weight > 100
      || !isFingerprint(account.capabilityFingerprint)
      || safeAccountLabel(account.label, "") !== account.label
      || seen.has(account.opaqueAccountId)) throw coded("invalid-router-config");
    seen.add(account.opaqueAccountId);
  }
  if (!seen.has(value.primaryOpaqueAccountId) || value.accounts.some((account) => account.included !== true)
    || routerConfigFingerprint(value) !== value.fingerprint) throw coded("invalid-router-config");
  return value;
}

function validateLegacyRouterConfig(value) {
  if (Object.keys(value).length !== 6
    || !["manual", "balanced"].includes(value.mode)
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !Array.isArray(value.accounts) || value.accounts.length !== 2
    || !isUtcIsoTimestamp(value.updatedAt)) throw coded("invalid-router-config");
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
  if (!isRecord(value) || value.schemaVersion !== ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION
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

function accountKeysMatch(value, accounts) {
  const expected = new Set(accounts.map((account) => account.opaqueAccountId));
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((opaqueId) => expected.has(opaqueId));
}

function routerStateMatchesPendingIntent(state, config) {
  if (!routerStateIsTerminalAndIdle(state)
    || !accountKeysMatch(state.ledger, config.accounts)
    || !accountKeysMatch(state.accountEligibility, config.accounts)) return false;
  const configured = new Set(config.accounts.map((account) => account.opaqueAccountId));
  if (!Object.values(state.threadOwners).every((owner) => configured.has(owner))
    || !Object.values(state.pendingThreadOwners).every((owner) => configured.has(owner))) return false;
  return config.accounts.every((account) => {
    const ledger = state.ledger[account.opaqueAccountId];
    return isRecord(ledger) && ledger.weight === account.weight
      && typeof state.accountEligibility[account.opaqueAccountId] === "string";
  });
}

function assertRouterStateMatchesPendingIntent(deps, routerPaths, config) {
  const state = readRouterState(deps, routerPaths);
  if (state && !routerStateMatchesPendingIntent(state, config)) throw coded("router-state-mismatch-requires-reset");
}

function writePrivateJson(deps, directory, file, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  try { atomicWrite(deps, directory, file, bytes); } finally { clearSecretBuffer(bytes); }
}

function nextRouterReceipts(deps, routerPaths, entries) {
  const existing = readPrivateJson(deps, routerPaths.receiptsFile, MAX_ROUTER_STATE_BYTES, "invalid-router-receipts") || [];
  if (!Array.isArray(existing) || existing.some((item) => !isRecord(item))) throw coded("invalid-router-receipts");
  if (!Array.isArray(entries) || entries.some((item) => !isRecord(item))) throw coded("invalid-router-receipts");
  return [...existing, ...entries].slice(-32);
}

function migrationReceiptEntries(deps, config, migrations) {
  return migrations.map(({ account, result }) => ({
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    opaqueAccountId: account.opaqueAccountId,
    snapshotHash: `sha256:${result.hash}`,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    // A receipt records a prepared private home, not a claim that this pending
    // config has become live. Config publication is the final operation below.
    result: result.refreshed ? "refreshed" : result.reused ? "reused" : "prepared",
    generation: config.generation,
    intentFingerprint: config.fingerprint,
    stagedAt: isoNow(deps),
  }));
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
    if (routerPathStatOrNull(deps.fs, target)) {
      const authFile = deps.path.join(target, "codex-home", "auth.json");
      const configFile = deps.path.join(target, "codex-home", "config.toml");
      hardenRouterChild(deps, routerPaths.accountsDir, target, false);
      hardenRouterChild(deps, target, deps.path.join(target, "codex-home"), false);
      hardenRouterChild(deps, target, deps.path.join(target, "sqlite-home"), false);
      const hasExpectedConfig = () => withOptionalSecureBytes(deps.fs, configFile, 4 * 1024,
        (bytes) => Buffer.isBuffer(bytes) && bytes.length === 0);
      if (!hasExpectedConfig()) throw coded("router-home-conflict");
      const existing = withSecureAuth(deps.fs, authFile, (snapshot) => {
        if (opaqueAccountId(secret, authAccountId(snapshot.value)) !== opaqueId) throw coded("router-home-conflict");
        return { hash: snapshot.hash, identity: snapshot.identity };
      });
      // A saved source can legitimately lag behind an isolated home after the
      // router refreshes its own token. Revalidate both identities, but never
      // replace that hardened home during ordinary restaging.
      withSecureAuth(deps.fs, source, (revalidated) => {
        if (revalidated.identity !== sourceSnapshot.identity || revalidated.hash !== sourceSnapshot.hash
          || opaqueAccountId(secret, authAccountId(revalidated.value)) !== opaqueId) throw coded("router-source-changed");
      });
      withSecureAuth(deps.fs, authFile, (revalidated) => {
        if (revalidated.identity !== existing.identity || revalidated.hash !== existing.hash
          || opaqueAccountId(secret, authAccountId(revalidated.value)) !== opaqueId) throw coded("router-home-conflict");
      });
      if (!hasExpectedConfig()) throw coded("router-home-conflict");
      return { reused: true, hash: existing.hash };
    }
    staging = deps.path.join(routerPaths.accountsDir, `.staging-${deps.randomUUID()}`);
    hardenRouterChild(deps, routerPaths.accountsDir, staging, true);
    const codexHome = deps.path.join(staging, "codex-home");
    const sqliteHome = deps.path.join(staging, "sqlite-home");
    hardenRouterChild(deps, staging, codexHome, true);
    hardenRouterChild(deps, staging, sqliteHome, true);
    atomicWrite(deps, codexHome, deps.path.join(codexHome, "auth.json"), sourceSnapshot.bytes);
    // v1 never copies live config/environment/MCP credentials. This empty file
    // makes the deny-by-default capability policy explicit for the runtime.
    atomicWrite(deps, codexHome, deps.path.join(codexHome, "config.toml"), Buffer.alloc(0));
    withSecureAuth(deps.fs, source, (revalidated) => {
      if (revalidated.identity !== sourceSnapshot.identity || revalidated.hash !== sourceSnapshot.hash
        || opaqueAccountId(secret, authAccountId(revalidated.value)) !== opaqueId) throw coded("router-source-changed");
    });
    if (routerPathStatOrNull(deps.fs, target)) throw coded("router-home-conflict");
    deps.fs.renameSync(staging, target);
    promoted = true;
    hardenRouterChild(deps, routerPaths.accountsDir, target, false);
    hardenRouterChild(deps, target, deps.path.join(target, "codex-home"), false);
    hardenRouterChild(deps, target, deps.path.join(target, "sqlite-home"), false);
    return { reused: false, hash: sourceSnapshot.hash };
  } finally {
    clearSecretBuffer(sourceSnapshot?.bytes);
    if (staging && !promoted) cleanupStagingHome(deps, routerPaths, staging);
  }
}

function stageBalancedRouterConfig(deps, paths, refs, message) {
  const routerPaths = ensureRouterRoot(deps, paths);
  // Validate the prior pending intent before preparing any new isolated home.
  // A malformed prior config must fail before it can leave a partial retry
  // footprint alongside a new intended generation.
  const existing = readRouterConfig(deps, routerPaths);
  const refsInput = Array.isArray(message?.refs) ? message.refs : [];
  if (refsInput.length !== 2 || new Set(refsInput).size !== 2) throw coded("router-requires-exactly-two-accounts");
  const legacyOwnerRef = typeof message?.legacyOwnerRef === "string" ? message.legacyOwnerRef : null;
  if (!legacyOwnerRef) throw coded("router-history-owner-required");
  if (!refsInput.includes(legacyOwnerRef)) throw coded("router-history-owner-not-selected");
  const filenames = refsInput.map((ref) => refs.get(ref));
  if (filenames.some((filename) => typeof filename !== "string")) throw coded("unknown-reference");
  const labels = savedSnapshotLabels(deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true }));
  const weights = Array.isArray(message?.weights) ? message.weights : [1, 1];
  if (weights.length !== 2 || weights.some((weight) => !Number.isInteger(weight) || weight < 1 || weight > 100)) throw coded("invalid-router-weight");
  const secret = routerSecret(deps, routerPaths);
  try {
    const accounts = filenames.map((filename, index) => withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, filename), (snapshot) => {
      const rawId = authAccountId(snapshot.value);
      if (!rawId) throw coded("invalid-account-identity");
      const opaqueId = opaqueAccountId(secret, rawId);
      return {
        filename,
        opaqueAccountId: opaqueId,
        included: true,
        // Kept for v1 compatibility; quota_aware_v1 does not expose weights in
        // normal UI and the runtime owns any future allocation policy changes.
        weight: weights[index],
        capabilityFingerprint: pendingCapabilityFingerprint(opaqueId),
        label: labels.get(filename) || safeSnapshotLabel(snapshot.value, filename, index + 1),
      };
    }));
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== 2) throw coded("router-requires-distinct-accounts");
    const legacyOwnerOpaqueAccountId = accounts[refsInput.indexOf(legacyOwnerRef)].opaqueAccountId;
    const primaryRef = typeof message?.primaryRef === "string" ? message.primaryRef : refsInput[0];
    const primaryIndex = refsInput.indexOf(primaryRef);
    if (primaryIndex < 0) throw coded("invalid-router-primary");
    const candidateAccounts = accounts.map(({ filename, ...account }) => account);
    const draft = {
      schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
      mode: "quota_aware",
      policy: ACCOUNT_ROUTER_QUOTA_POLICY,
      generation: routerConfigGeneration(existing),
      protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
      primaryOpaqueAccountId: candidateAccounts[primaryIndex].opaqueAccountId,
      accounts: candidateAccounts,
      updatedAt: isoNow(deps),
    };
    const config = validateRouterConfig({ ...draft, fingerprint: routerConfigFingerprint(draft) });
    // Router state is private runtime history. A new pair or per-account weight
    // must never be published beside incompatible history: the runtime would
    // fail closed at startup, so fail before preparing homes or receipts here.
    const routerState = readRouterState(deps, routerPaths);
    const historyRecords = readHistoryAdoptionRecords(deps, routerPaths, secret);
    assertHistoryAdoptionMayStage(config, historyRecords, legacyOwnerOpaqueAccountId, routerState);
    assertRouterStateMatchesPendingIntent(deps, routerPaths, config);
    // Each source is read and identity-bound before its isolated home is
    // promoted. A failure never changes a source snapshot or publishes a
    // router config; a subsequent run reuses only an identity-matching,
    // hardened home and preserves its independently rotated token bytes.
    const migrations = [];
    for (const account of accounts) {
      const result = stageRouterHome(deps, paths, routerPaths, account.filename, account.opaqueAccountId, secret);
      migrations.push({ account, result });
      delete account.filename;
    }
    // Prepare the ordinary home-migration receipts, then publish the signed
    // offline-adoption intent before the config's final commit. If a later
    // write fails, that intent is only stale pre-adoption evidence and a new
    // deliberate stage may replace it; it never claims live routing changed.
    const receiptBatch = nextRouterReceipts(deps, routerPaths, migrationReceiptEntries(deps, config, migrations));
    // Before adoption, a deliberate restage replaces stale intent. After a
    // valid receipt, preserve the original signed intent byte-for-byte: that
    // receipt/owners chain is independent from later v2 config generations.
    if (!historyRecords.receipt) {
      const historyIntent = createHistoryAdoptionIntent(deps, config, legacyOwnerOpaqueAccountId, secret);
      writeHistoryAdoptionIntent(deps, routerPaths, historyIntent);
    }
    writePrivateJson(deps, routerPaths.routerDir, routerPaths.receiptsFile, receiptBatch);
    writePrivateJson(deps, routerPaths.routerDir, routerPaths.configFile, config);
    return config;
  } finally {
    clearSecretBuffer(secret);
  }
}

function stageManualRouterConfig(deps, paths) {
  const routerPaths = accountRouterPaths(deps, paths);
  // Manual mode is a no-op when the router has never been configured. Do not
  // create, chmod, or otherwise touch the runtime-owned namespace in that case.
  if (!routerPathStatOrNull(deps.fs, routerPaths.configFile)) return null;
  hardenRouterChild(deps, deps.path.dirname(routerPaths.routerDir), routerPaths.routerDir, false);
  const existing = readRouterConfig(deps, routerPaths);
  if (!existing) return null;
  const accounts = existing.accounts.map((account, index) => ({
    opaqueAccountId: account.opaqueAccountId,
    included: true,
    weight: account.weight,
    capabilityFingerprint: account.capabilityFingerprint,
    label: safeAccountLabel(account.label, `Account ${index + 1}`),
  }));
  const draft = {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    mode: "manual",
    policy: null,
    generation: routerConfigGeneration(existing),
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: existing.primaryOpaqueAccountId,
    accounts,
    updatedAt: isoNow(deps),
  };
  const config = validateRouterConfig({ ...draft, fingerprint: routerConfigFingerprint(draft) });
  const state = readRouterState(deps, routerPaths);
  const historyRecords = readHistoryAdoptionRecords(deps, routerPaths);
  if (historyRecords.receipt || historyRecords.owners || historyRecords.receiptInvalid || historyRecords.ownersInvalid) {
    assertHistoryAdoptionMayStage(config, historyRecords, null, state);
  }
  writePrivateJson(deps, routerPaths.routerDir, routerPaths.configFile, config);
  return config;
}

function existingRouterSecret(deps, routerPaths) {
  hardenRouterChild(deps, deps.path.dirname(routerPaths.routerDir), routerPaths.routerDir, false);
  return withOptionalSecureBytes(deps.fs, routerPaths.controlSecretFile, 64, (bytes) => {
    if (!bytes || bytes.length !== 32) throw coded("invalid-router-control-secret");
    return Buffer.from(bytes);
  });
}

function recoveryCandidate(deps, paths, routerPaths, filename, opaqueId, secret) {
  const sourceFile = sourceFilePath(deps.path, paths.accountsDir, filename);
  const target = exactRouterChild(deps, routerPaths, opaqueId);
  const homeDir = deps.path.join(target, "codex-home");
  const homeAuthFile = deps.path.join(homeDir, "auth.json");
  let source;
  let current;
  let home;
  try {
    hardenRouterChild(deps, routerPaths.accountsDir, target, false);
    hardenRouterChild(deps, target, homeDir, false);
    source = readSecureAuth(deps.fs, sourceFile);
    current = readSecureAuth(deps.fs, paths.authFile);
    home = readSecureAuth(deps.fs, homeAuthFile);
    const sameOpaqueIdentity = (snapshot) => {
      const accountId = authAccountId(snapshot.value);
      return accountId && opaqueAccountId(secret, accountId) === opaqueId;
    };
    if (![source, current, home].every(sameOpaqueIdentity)) throw coded("router-recovery-account-mismatch");
    return {
      sourceFile,
      homeDir,
      homeAuthFile,
      sourceIdentity: source.identity,
      sourceHash: source.hash,
      currentIdentity: current.identity,
      currentHash: current.hash,
      homeIdentity: home.identity,
      homeHash: home.hash,
      sourceBytes: Buffer.from(source.bytes),
      currentBytes: Buffer.from(current.bytes),
      homeBytes: Buffer.from(home.bytes),
    };
  } finally {
    clearSecretBuffer(source?.bytes);
    clearSecretBuffer(current?.bytes);
    clearSecretBuffer(home?.bytes);
  }
}

function sameRecoveryCandidate(left, right) {
  return left?.sourceIdentity === right?.sourceIdentity && left?.sourceHash === right?.sourceHash
    && left?.currentIdentity === right?.currentIdentity && left?.currentHash === right?.currentHash
    && left?.homeIdentity === right?.homeIdentity && left?.homeHash === right?.homeHash;
}

function recoveryConfig(existing, refreshedOpaqueId, refreshedLabel, deps) {
  if (existing?.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION) throw coded("router-operation-failed");
  const accounts = existing.accounts.map((account, index) => ({
    opaqueAccountId: account.opaqueAccountId,
    included: true,
    weight: account.weight,
    capabilityFingerprint: account.capabilityFingerprint,
    label: account.opaqueAccountId === refreshedOpaqueId
      ? safeAccountLabel(refreshedLabel, `Account ${index + 1}`)
      : safeAccountLabel(account.label, `Account ${index + 1}`),
  }));
  const draft = {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    mode: existing.mode,
    policy: existing.policy,
    generation: routerConfigGeneration(existing),
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: existing.primaryOpaqueAccountId,
    accounts,
    updatedAt: isoNow(deps),
  };
  return validateRouterConfig({ ...draft, fingerprint: routerConfigFingerprint(draft) });
}

async function recoverRouterAccount(_api, deps, paths, refs, message) {
  let secret;
  let before;
  let current;
  let priorConfigBytes;
  let receiptBatch;
  let sourceWritten = false;
  let homeWritten = false;
  let receiptPublished = false;
  let configPublicationStarted = false;
  let configPublished = false;
  try {
    const ref = typeof message?.ref === "string" ? message.ref : null;
    const filename = ref ? refs.get(ref) : null;
    if (!filename) throw coded("unknown-reference");
    const routerPaths = accountRouterPaths(deps, paths);
    hardenRouterChild(deps, deps.path.dirname(routerPaths.routerDir), routerPaths.routerDir, false);
    hardenRouterChild(deps, routerPaths.routerDir, routerPaths.accountsDir, false);
    const existing = readRouterConfig(deps, routerPaths);
    if (!existing || existing.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION) throw coded("router-operation-failed");
    priorConfigBytes = withOptionalSecureBytes(deps.fs, routerPaths.configFile, 32 * 1024,
      (bytes) => bytes ? Buffer.from(bytes) : null);
    if (!priorConfigBytes) throw coded("router-operation-failed");
    secret = existingRouterSecret(deps, routerPaths);
    const source = sourceFilePath(deps.path, paths.accountsDir, filename);
    const sourceAccountId = withSecureAuth(deps.fs, source, (snapshot) => authAccountId(snapshot.value));
    const opaqueId = sourceAccountId ? opaqueAccountId(secret, sourceAccountId) : null;
    const configured = opaqueId && existing.accounts.find((account) => account.opaqueAccountId === opaqueId);
    if (!configured) throw coded("router-recovery-account-mismatch");
    before = recoveryCandidate(deps, paths, routerPaths, filename, opaqueId, secret);
    if (before.sourceHash === before.currentHash && before.homeHash === before.currentHash) throw coded("router-recovery-not-needed");

    // A missing/refused socket proves this generation is not running. Any live
    // response or unverifiable control path fails closed before a home changes.
    const live = await authenticatedRouterStatus(deps, routerPaths);
    if (live.state === "active") throw coded("router-recovery-router-running");
    if (live.state !== "not_running") throw coded("router-recovery-router-status-unavailable");

    current = recoveryCandidate(deps, paths, routerPaths, filename, opaqueId, secret);
    if (!sameRecoveryCandidate(before, current)) throw coded("router-source-changed");
    const recheckedConfig = readRouterConfig(deps, routerPaths);
    if (recheckedConfig?.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
      || recheckedConfig.generation !== existing.generation
      || recheckedConfig.fingerprint !== existing.fingerprint) throw coded("router-operation-failed");

    // Refresh the existing source and its isolated copy as one recoverable
    // pre-publication change. Neither snapshot is deleted or renamed, and the
    // source remains the same named account rather than becoming a third entry.
    atomicWrite(deps, paths.accountsDir, current.sourceFile, current.currentBytes);
    sourceWritten = true;
    atomicWrite(deps, current.homeDir, current.homeAuthFile, current.currentBytes);
    homeWritten = true;
    const labels = savedSnapshotLabels(deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true }));
    const config = recoveryConfig(existing, opaqueId, labels.get(filename), deps);
    receiptBatch = nextRouterReceipts(deps, routerPaths, migrationReceiptEntries(deps, config, [{
      account: config.accounts.find((account) => account.opaqueAccountId === opaqueId),
      result: { hash: current.currentHash, refreshed: true },
    }]));
    // Receipt commit is deliberately before the config final commit. A receipt
    // write failure therefore rolls back both refreshed auth files without
    // publishing a pending generation.
    writePrivateJson(deps, routerPaths.routerDir, routerPaths.receiptsFile, receiptBatch);
    receiptPublished = true;
    configPublicationStarted = true;
    writePrivateJson(deps, routerPaths.routerDir, routerPaths.configFile, config);
    configPublished = true;
    const state = readRouterState(deps, routerPaths);
    const historyRecords = readHistoryAdoptionRecords(deps, routerPaths);
    return { ok: true, router: routerPublicStatus(deps, config, state, historyRecords), live: { state: "not_running", status: null } };
  } catch (error) {
    if (!configPublished) {
      try {
        // `atomicWrite` can only fail after its rename on a later metadata
        // operation. Restore the prior valid config before restoring auth so an
        // IPC failure never leaves a new router generation claiming recovery.
        if (configPublicationStarted && priorConfigBytes) {
          const routerPaths = accountRouterPaths(deps, paths);
          atomicWrite(deps, routerPaths.routerDir, routerPaths.configFile, priorConfigBytes);
        }
        if (homeWritten && current) atomicWrite(deps, current.homeDir, current.homeAuthFile, current.homeBytes);
        if (sourceWritten && current) atomicWrite(deps, paths.accountsDir, current.sourceFile, current.sourceBytes);
        // The receipt file is only diagnostic. If a final config write throws,
        // retain an explicit aborted record rather than a false claim that this
        // new generation was published or silently deleting private evidence.
        if (receiptPublished && receiptBatch) {
          const aborted = receiptBatch.map((entry) => entry?.intentFingerprint
            ? { ...entry, result: "aborted", abortedAt: isoNow(deps) } : entry);
          const routerPaths = accountRouterPaths(deps, paths);
          writePrivateJson(deps, routerPaths.routerDir, routerPaths.receiptsFile, aborted);
        }
      } catch { return safeRouterFailure(coded("router-operation-failed")); }
    }
    return safeRouterFailure(error);
  } finally {
    clearSecretBuffer(secret);
    clearSecretBuffer(priorConfigBytes);
    for (const candidate of [before, current]) {
      clearSecretBuffer(candidate?.sourceBytes);
      clearSecretBuffer(candidate?.currentBytes);
      clearSecretBuffer(candidate?.homeBytes);
    }
  }
}

function routerDegradedReason(state) {
  const code = state?.stagedDisable?.reasonCode;
  return ({ protocol_drift: "unsupported_protocol", isolation_failure: "capability_mismatch", policy_stop: "policy_stop", post_start_failure: "post_start_failure" })[code] || null;
}

function routerPublicStatus(deps, config, state, historyRecords = null) {
  if (!config) return {
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    mode: "manual",
    policy: null,
    active: null,
    pending: null,
    protocolState: "supported",
    accounts: [],
    restartRequired: false,
    degradedReason: null,
    historyAdoption: historyAdoptionProjection(null, historyRecords, state),
  };
  if (config.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION) {
    const invalid = config.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT;
    const degradedReason = invalid ? "invalid_config" : routerDegradedReason(state);
    return redact({
      schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
      mode: config.mode,
      policy: config.policy,
      // This is a disk projection only. `active` is intentionally null: only
      // the authenticated mux socket is allowed to claim current live truth.
      active: null,
      pending: {
        mode: config.mode,
        policy: config.policy,
        generation: config.generation,
        fingerprint: config.fingerprint,
      },
      protocolState: invalid ? "unknown" : "supported",
      accounts: config.accounts.map((account, index) => ({
        label: safeAccountLabel(account.label, `Account ${index + 1}`),
        eligibility: state?.accountEligibility?.[account.opaqueAccountId] || "validating",
        assignedThreadCount: Number.isInteger(state?.ledger?.[account.opaqueAccountId]?.assignedThreadCount)
          ? state.ledger[account.opaqueAccountId].assignedThreadCount : 0,
      })),
      restartRequired: true,
      degradedReason,
      historyAdoption: historyAdoptionProjection(config, historyRecords, state),
    });
  }
  const invalid = config.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT;
  const degradedReason = invalid ? "invalid_config" : routerDegradedReason(state);
  const mode = degradedReason ? "direct_fallback" : config.mode;
  const accounts = (config?.accounts || []).map((account, index) => {
    const ledger = state?.ledger?.[account.opaqueAccountId];
    const completed = Number.isInteger(ledger?.completedInputTokens) ? ledger.completedInputTokens : 0;
    const output = Number.isInteger(ledger?.completedOutputTokens) ? ledger.completedOutputTokens : 0;
    const reserved = Number.isInteger(ledger?.reservedRequestCost) ? ledger.reservedRequestCost : 0;
    return {
      label: index === 0 ? "Account A" : "Account B",
      eligibility: state?.accountEligibility?.[account.opaqueAccountId] || "validating",
      normalizedSpend: (completed + output + reserved) / account.weight,
      assignedThreadCount: Number.isInteger(ledger?.assignedThreadCount) ? ledger.assignedThreadCount : 0,
    };
  });
  const inFlight = Boolean(state?.reservations?.length || state?.correlations?.length || accounts.some((account) => ["validating", "reserved", "active"].includes(account.eligibility)));
  return redact({ schemaVersion: ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION, mode, protocolState: invalid ? "unknown" : "supported", fairnessPrecision: inFlight ? "projected" : "exact_completed_spend", accounts, restartRequired: mode === "balanced" || mode === "direct_fallback", degradedReason, historyAdoption: historyAdoptionProjection(config, historyRecords, state) });
}

async function routerStatus(_api, deps, paths) {
  const routerPaths = accountRouterPaths(deps, paths);
  // The socket is the only active-truth authority. Query it first so a later
  // bad pending config or state record cannot erase an authenticated running
  // generation from the renderer's view.
  let live;
  try { live = await authenticatedRouterStatus(deps, routerPaths); }
  catch { live = { state: "unavailable", status: null }; }
  try {
    const config = readRouterConfig(deps, routerPaths);
    const state = readRouterState(deps, routerPaths);
    const historyRecords = readHistoryAdoptionRecords(deps, routerPaths);
    const router = routerPublicStatus(deps, config, state, historyRecords);
    return { ok: true, router, live };
  } catch {
    // A malformed/stale persisted control record never blocks manual behavior.
    // It is a pending-disk failure, not a claim about an independently
    // authenticated running mux, which remains available in `live`.
    return {
      ok: true,
      router: {
        schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
        mode: "manual",
        policy: null,
        active: null,
        pending: null,
        protocolState: "unknown",
        accounts: [],
        restartRequired: false,
        degradedReason: "invalid_config",
        // A corrupt persisted config/state cannot identify a safe history
        // owner or pool. Report that offline record as invalid instead of
        // falling back to a misleading "required" choice.
        historyAdoption: { state: "invalid", ownerLabel: null, importedThreadCount: 0, databaseCount: 0, historyCount: 0 },
      },
      live,
    };
  }
}

function routerControlSocketPath(deps, routerPaths) {
  const { createHash } = require("node:crypto");
  const rootHash = createHash("sha256").update(deps.path.resolve(routerPaths.routerDir), "utf8").digest("hex").slice(0, 24);
  return deps.path.join("/tmp", `arc-${routerUid(deps)}`, `${rootHash}-${ACCOUNT_ROUTER_CONTROL_SOCKET_NAME}`);
}

function authenticatedRouterStatus(deps, routerPaths) {
  const fs = deps.fs;
  let secret = null;
  try {
    secret = withOptionalSecureBytes(fs, routerPaths.controlSecretFile, 64, (bytes) => {
      if (!bytes || bytes.length !== 32) return null;
      return Buffer.from(bytes);
    });
    if (!secret || typeof deps?.net?.createConnection !== "function") return Promise.resolve({ state: "unavailable", status: null });
    const socketPath = routerControlSocketPath(deps, routerPaths);
    const socketStat = fs.lstatSync(socketPath);
    const parentStat = fs.lstatSync(deps.path.dirname(socketPath));
    if (!socketStat.isSocket?.() || socketStat.isSymbolicLink?.() || socketStat.uid !== routerUid(deps) || (socketStat.mode & 0o077) !== 0
      || !parentStat.isDirectory?.() || parentStat.isSymbolicLink?.() || parentStat.uid !== routerUid(deps) || (parentStat.mode & 0o077) !== 0) {
      secret.fill(0);
      return Promise.resolve({ state: "unavailable", status: null });
    }
    return requestAuthenticatedRouterStatus(deps, socketPath, secret);
  } catch (error) {
    try { secret?.fill(0); } catch {}
    return Promise.resolve({ state: error?.code === "ENOENT" || error?.code === "ECONNREFUSED" ? "not_running" : "unavailable", status: null });
  }
}

function requestAuthenticatedRouterStatus(deps, socketPath, secret) {
  return new Promise((resolve) => {
    const requestId = `account-switcher-${deps.randomUUID()}`;
    const request = Buffer.from(`${JSON.stringify({ version: 1, requestId, method: "status", secret: secret.toString("base64url") })}\n`);
    let response = Buffer.alloc(0);
    let settled = false;
    const socket = deps.net.createConnection(socketPath);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      request.fill(0); response.fill(0); secret.fill(0);
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.setTimeout?.(ROUTER_CONTROL_TIMEOUT_MS, () => finish({ state: "unavailable", status: null }));
    socket.once?.("connect", () => socket.end(request));
    socket.on?.("data", (chunk) => {
      if (response.length + chunk.length > ROUTER_CONTROL_FRAME_LIMIT) return finish({ state: "unavailable", status: null });
      response = Buffer.concat([response, chunk]);
    });
    socket.once?.("end", () => finish({ state: "active", status: parseAuthenticatedRouterStatus(response, requestId) }));
    socket.once?.("error", (error) => finish({ state: error?.code === "ENOENT" || error?.code === "ECONNREFUSED" ? "not_running" : "unavailable", status: null }));
  }).then((result) => result.status ? result : { ...result, state: "unavailable" });
}

function parseAuthenticatedRouterStatus(bytes, requestId) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["requestId", "status", "version"].join("\0")
      || value.version !== 1 || value.requestId !== requestId || !isRecord(value.status)) return null;
    const status = value.status;
    if (status.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION) return parseQuotaAwareRouterStatus(status);
    return parseLegacyRouterStatus(status);
  } catch { return null; }
}

function parseLegacyRouterStatus(status) {
  try {
    const allowed = ["accounts", "degradedReason", "fairnessPrecision", "mode", "protocolState", "restartRequired", "schemaVersion"];
    if (Object.keys(status).some((key) => !allowed.includes(key)) || status.schemaVersion !== ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION
      || !["manual", "balanced", "direct_fallback"].includes(status.mode)
      || !["supported", "unsupported", "drifted", "unknown"].includes(status.protocolState)
      || !["projected", "exact_completed_spend", "estimated"].includes(status.fairnessPrecision)
      || typeof status.restartRequired !== "boolean" || !(status.degradedReason === null || ROUTER_PUBLIC_DEGRADED_REASONS.has(status.degradedReason))
      || !Array.isArray(status.accounts) || status.accounts.length > 2) return null;
    const accounts = [];
    for (const account of status.accounts) {
      if (!isRecord(account) || Object.keys(account).sort().join("\0") !== ["assignedThreadCount", "eligibility", "label", "normalizedSpend", "opaqueAccountId"].join("\0")
        || !isOpaqueAccountId(account.opaqueAccountId) || !["Account A", "Account B"].includes(account.label)
        || !ROUTER_PUBLIC_ELIGIBILITY.has(account.eligibility) || !Number.isFinite(account.normalizedSpend) || account.normalizedSpend < 0
        || !Number.isInteger(account.assignedThreadCount) || account.assignedThreadCount < 0) return null;
      accounts.push({ label: account.label, eligibility: account.eligibility, normalizedSpend: account.normalizedSpend, assignedThreadCount: account.assignedThreadCount });
    }
    return redact({ schemaVersion: status.schemaVersion, mode: status.mode, protocolState: status.protocolState, fairnessPrecision: status.fairnessPrecision, accounts, restartRequired: status.restartRequired, degradedReason: status.degradedReason });
  } catch { return null; }
}

function parseQuotaAwareRouterIntent(value) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["fingerprint", "generation", "mode", "policy"].join("\0")
    || !["manual", "quota_aware"].includes(value.mode)
    || (value.mode === "quota_aware" ? value.policy !== ACCOUNT_ROUTER_QUOTA_POLICY : value.policy !== null)
    || !Number.isInteger(value.generation) || value.generation < 1 || !isFingerprint(value.fingerprint)) return null;
  return { mode: value.mode, policy: value.policy, generation: value.generation, fingerprint: value.fingerprint };
}

function parseQuotaAwareWeekly(value) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["freshness", "remainingPercent", "resetAt"].join("\0")
    || !(value.remainingPercent === null || (Number.isFinite(value.remainingPercent) && value.remainingPercent >= 0 && value.remainingPercent <= 100))
    || !["fresh", "stale", "unknown"].includes(value.freshness)
    || !(value.resetAt === null || (typeof value.resetAt === "string" && Number.isFinite(Date.parse(value.resetAt))))) return null;
  return { remainingPercent: value.remainingPercent === null ? null : Math.round(value.remainingPercent), resetAt: value.resetAt, freshness: value.freshness };
}

function parseQuotaAwarePressure(value) {
  if (value === null) return null;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : undefined;
}

function parseQuotaAwareRouterAccount(value) {
  const allowed = ["assignedThreadCount", "eligibility", "identifierMasked", "label", "opaqueAccountId", "plan", "shortWindowPressure", "weekly"];
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== allowed.join("\0")
    || !isOpaqueAccountId(value.opaqueAccountId) || !ROUTER_PUBLIC_ELIGIBILITY.has(value.eligibility)
    || !Number.isInteger(value.assignedThreadCount) || value.assignedThreadCount < 0
    || safeAccountLabel(value.label, "") !== value.label || !(value.plan === null || safeAccountLabel(value.plan, "") === value.plan)
    || typeof value.identifierMasked !== "string" || !/^[•*]{4,80}$/.test(value.identifierMasked)) return null;
  const weekly = parseQuotaAwareWeekly(value.weekly);
  const shortWindowPressure = parseQuotaAwarePressure(value.shortWindowPressure);
  if (!weekly || shortWindowPressure === undefined) return null;
  return {
    label: value.label,
    eligibility: value.eligibility,
    plan: value.plan,
    identifierMasked: value.identifierMasked,
    weekly,
    shortWindowPressure,
    assignedThreadCount: value.assignedThreadCount,
  };
}

function parseQuotaAwareRouterStatus(status) {
  const allowed = ["accounts", "active", "degradedReason", "pending", "poolRemainingPercent", "protocolState", "restartRequired", "schemaVersion"];
  const active = parseQuotaAwareRouterIntent(status.active);
  const pending = status.pending === null ? null : parseQuotaAwareRouterIntent(status.pending);
  if (Object.keys(status).sort().join("\0") !== allowed.join("\0")
    || status.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
    || !["supported", "unsupported", "drifted", "unknown"].includes(status.protocolState)
    || typeof status.restartRequired !== "boolean"
    || !(status.degradedReason === null || ROUTER_PUBLIC_DEGRADED_REASONS.has(status.degradedReason))
    || !(status.poolRemainingPercent === null || (Number.isFinite(status.poolRemainingPercent) && status.poolRemainingPercent >= 0 && status.poolRemainingPercent <= 200))
    || !active || (status.pending !== null && !pending)
    || !Array.isArray(status.accounts) || status.accounts.length !== 2) return null;
  const accounts = status.accounts.map(parseQuotaAwareRouterAccount);
  if (accounts.some((account) => account === null)) return null;
  return redact({
    schemaVersion: ACCOUNT_ROUTER_SCHEMA_VERSION,
    active,
    pending,
    protocolState: status.protocolState,
    restartRequired: status.restartRequired,
    accounts,
    // Do not use the transport-provided pool for presentation. The renderer
    // recomputes the visible 0–200% value from the two redacted weekly rows.
    poolRemainingPercent: status.poolRemainingPercent === null ? null : Math.round(status.poolRemainingPercent),
    degradedReason: status.degradedReason,
  });
}

async function configureRouter(_api, deps, paths, refs, message) {
  try {
    const config = ["quota_aware", "balanced"].includes(message?.mode)
      ? stageBalancedRouterConfig(deps, paths, refs, message)
      : message?.mode === "manual" ? stageManualRouterConfig(deps, paths) : (() => { throw coded("invalid-router-mode"); })();
    const routerPaths = config ? accountRouterPaths(deps, paths) : null;
    const historyRecords = routerPaths ? readHistoryAdoptionRecords(deps, routerPaths) : null;
    const state = routerPaths ? readRouterState(deps, routerPaths) : null;
    return { ok: true, router: routerPublicStatus(deps, config, state, historyRecords) };
  } catch (error) { return safeRouterFailure(error); }
}

function routerIsIdle(state) {
  return state.reservations.every((reservation) => isRecord(reservation)
      && ROUTER_TERMINAL_RESERVATION_STATES.has(reservation.state))
    && state.correlations.length === 0
    && !Object.values(state.accountEligibility).some((value) => ["validating", "reserved", "active"].includes(value));
}

function routerStateIsTerminalAndIdle(state) {
  return routerIsIdle(state) && state.stagedDisable === null
    && Object.keys(state.pendingThreadOwners).length === 0;
}

function resetRouterBalanceEpoch(deps, routerPaths) {
  try {
    hardenRouterChild(deps, deps.path.dirname(routerPaths.routerDir), routerPaths.routerDir, false);
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
  } catch (error) { return safeRouterFailure(error); }
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
    net: require("node:net"),
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
  Promise.all([
    state.api.ipc.invoke(IPC, { action: "list" }),
    state.api.ipc.invoke(IPC, { action: "router-status" }).catch(() => null),
  ]).then(([response, routerStatus]) => {
    if (disposed) return;
    root.replaceChildren();
    if (!response?.ok) { root.textContent = "Accounts are unavailable."; return; }
    state.pluginProtectionMode = response.pluginProtection?.mode || "observation";
    const savedAccounts = Array.isArray(response.accounts) ? response.accounts : [];
    // Routing is a fixed two-account pool. Manual access remains independent
    // so a one- or three-plus-snapshot inventory never disappears from UI.
    const accounts = savedAccounts.length === 2 ? savedAccounts : [];
    const liveStatus = routerStatus?.live?.state === "active" && isRecord(routerStatus.live.status)
      ? routerStatus.live.status : null;
    const status = document.createElement("div");
    status.className = "text-token-text-secondary text-sm";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    applyRouterPresentation(status, routerStatus?.router, routerStatus?.live, savedAccounts.length);
    state.statusElement = status;
    const page = document.createElement("div");
    page.className = "flex flex-col gap-6";
    page.append(usageSummaryCard(accounts, liveStatus));
    page.append(accountCards(accounts, liveStatus));
    page.append(routerControlCard(state, accounts, routerStatus));
    page.append(historyAdoptionCard(routerStatus?.router?.historyAdoption));
    page.append(accountRecoveryCard(state, accounts, savedAccounts.length, liveStatus, status));
    page.append(advancedAccountsCard(state, savedAccounts, response.pluginProtection, status));
    page.append(status);
    root.append(page);
  }).catch(() => { if (!disposed) root.textContent = "Accounts are unavailable."; });
  return () => { disposed = true; root.replaceChildren(); };
}

function settingsCard() {
  const card = document.createElement("div");
  card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  if (card.style) card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  return card;
}

function quotaPoolRemainingPercent(accounts) {
  if (!Array.isArray(accounts) || accounts.length !== 2) return null;
  const weekly = accounts.map((account) => account?.weekly);
  if (weekly.some((value) => value?.freshness !== "fresh" || !Number.isFinite(value.remainingPercent))) return null;
  const remaining = weekly.map((value) => value.remainingPercent);
  return remaining.reduce((total, value) => total + Math.max(0, Math.min(100, Math.round(value))), 0);
}

function accountDetailsFor(account, liveStatus) {
  if (liveStatus?.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION || !Array.isArray(liveStatus.accounts)) return null;
  // The safe local label is the only renderer-visible join key. Opaque account
  // ids stay inside the router boundary and are never rendered or persisted by
  // this UI layer.
  const candidates = liveStatus.accounts.filter((candidate) => candidate?.label === account.label);
  return candidates.length === 1 ? candidates[0] : null;
}

function initials(label) {
  const parts = safeAccountLabel(label, "Account").split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part.slice(0, 1).toUpperCase()).join("") || "A";
}

function accountAvatar(label) {
  const avatar = document.createElement("div");
  avatar.className = "bg-token-foreground/10 text-token-text-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = initials(label);
  return avatar;
}

function quotaSummaryText(liveStatus) {
  const pool = quotaPoolRemainingPercent(liveStatus?.accounts);
  return pool === null ? "Usage unavailable" : `${pool}% left`;
}

function usageSummaryCard(accounts, liveStatus) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = "Usage remaining";
  const detail = document.createElement("div");
  detail.className = "text-token-text-secondary min-w-0 text-sm";
  detail.textContent = accounts.length === 2 ? "2 connected subscriptions" : "Set up exactly two saved subscriptions";
  copy.append(title, detail);
  const value = document.createElement("div");
  value.className = "shrink-0 text-sm text-token-text-secondary";
  value.textContent = quotaSummaryText(liveStatus);
  row.append(copy, value);
  card.append(row);
  return card;
}

function accountCards(accounts, liveStatus) {
  const card = settingsCard();
  if (accounts.length !== 2) {
    const row = document.createElement("div");
    row.className = "p-3 text-sm text-token-text-secondary";
    row.textContent = "Quota-aware routing uses exactly two saved subscriptions. Manual switching remains available in Advanced for every saved account.";
    card.append(row);
    return card;
  }
  for (const account of accounts) {
    const detail = accountDetailsFor(account, liveStatus);
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 p-3";
    const identity = document.createElement("div");
    identity.className = "flex min-w-0 items-center gap-3";
    const copy = document.createElement("div");
    copy.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "truncate text-sm text-token-text-primary";
    title.textContent = account.label;
    const meta = document.createElement("div");
    meta.className = "text-token-text-secondary truncate text-sm";
    const plan = detail?.plan || "Plan unavailable";
    const weekly = Number.isFinite(detail?.weekly?.remainingPercent) ? `${Math.round(detail.weekly.remainingPercent)}% weekly remaining` : "Weekly usage unavailable";
    meta.textContent = `${plan} · ${maskIdentifier(detail?.identifierMasked)} · ${weekly}`;
    copy.append(title, meta);
    identity.append(accountAvatar(account.label), copy);
    const state = document.createElement("div");
    state.className = "text-token-text-secondary shrink-0 text-right text-sm";
    const freshness = detail?.weekly?.freshness || "unknown";
    const reset = detail?.weekly?.resetAt ? ` · resets ${formatResetAt(detail.weekly.resetAt)}` : "";
    const threads = Number.isInteger(detail?.assignedThreadCount) ? ` · ${detail.assignedThreadCount} assigned ${detail.assignedThreadCount === 1 ? "thread" : "threads"}` : "";
    const pressure = detail?.shortWindowPressure === null || detail?.shortWindowPressure === undefined
      ? "" : ` · short window ${String(detail.shortWindowPressure)}`;
    state.textContent = `${routerEligibilityLabel(detail?.eligibility)} · ${freshness}${reset}${threads}${pressure}`;
    row.append(identity, state);
    card.append(row);
  }
  return card;
}

function formatResetAt(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "later";
}

function routerEligibilityLabel(value) {
  if (value === "reauth_required") return "Reauthentication needed";
  if (value === "quota_depleted") return "Weekly quota used";
  if (value === "active") return "Active";
  if (value === "eligible") return "Ready";
  if (value === "validating") return "Checking";
  if (value === "plugin_blocked") return "Plugin protection blocked";
  return "Status unavailable";
}

function routerControlCard(state, accounts, initialStatus = null) {
  const card = settingsCard();
  const summary = document.createElement("div");
  summary.className = "flex flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Quota-aware routing";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  description.textContent = "New work can use the two enrolled accounts according to their available weekly quota. Staging a change never restarts ChatGPT.";
  summary.append(title, description);
  const body = document.createElement("div");
  body.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const status = document.createElement("div");
  status.className = "text-token-text-secondary min-w-0 text-sm";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  applyRouterPresentation(status, initialStatus?.router, initialStatus?.live, accounts.length);
  const controls = document.createElement("div");
  controls.className = "flex flex-wrap items-center gap-2";
  const historyOwner = document.createElement("select");
  historyOwner.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer max-w-[240px] rounded-md border px-3 text-sm text-token-text-primary";
  historyOwner.setAttribute("aria-label", "Keep my existing history with");
  const historyPrompt = document.createElement("option");
  historyPrompt.value = "";
  historyPrompt.textContent = "Keep my existing history with…";
  historyPrompt.disabled = true;
  historyPrompt.selected = true;
  historyOwner.append(historyPrompt);
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.ref;
    option.textContent = account.label;
    historyOwner.append(option);
  }
  let legacyOwnerRef = null;
  const stage = document.createElement("button");
  stage.type = "button";
  stage.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary disabled:cursor-not-allowed disabled:opacity-60";
  stage.textContent = "Stage quota-aware routing";
  const updateStageAvailability = () => { stage.disabled = accounts.length !== 2 || legacyOwnerRef === null; };
  updateStageAvailability();
  historyOwner.addEventListener("change", () => {
    legacyOwnerRef = accounts.some((account) => account.ref === historyOwner.value) ? historyOwner.value : null;
    updateStageAvailability();
  });
  stage.addEventListener("click", async () => {
    if (accounts.length !== 2) { reportRouterControlFailure(state, status, "router-requires-exactly-two-accounts"); return; }
    if (!legacyOwnerRef) { reportRouterControlFailure(state, status, "router-history-owner-required"); return; }
    status.textContent = "Staging selected account homes and offline history adoption intent…";
    try {
      const primary = accounts.find((account) => account.active) || accounts[0];
      const result = await state.api.ipc.invoke(IPC, { action: "router-configure", mode: "quota_aware", refs: accounts.map((account) => account.ref), primaryRef: primary.ref, legacyOwnerRef, weights: [1, 1] });
      if (result?.ok) applyRouterPresentation(status, result.router, result.live, accounts.length);
      else reportRouterControlFailure(state, status, result?.error?.code);
    } catch { reportRouterControlFailure(state, status); }
  });
  controls.append(historyOwner, stage);
  body.append(status, controls);
  card.append(summary, body);
  return card;
}

function historyAdoptionCard(projection) {
  const history = projection && ["required", "pending_offline_adoption", "adopted", "invalid", "mismatch"].includes(projection.state)
    ? projection : { state: "required", ownerLabel: null, importedThreadCount: 0, databaseCount: 0, historyCount: 0 };
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex min-w-0 flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Existing history";
  const detail = document.createElement("div");
  detail.className = "text-token-text-secondary text-sm";
  if (history.state === "pending_offline_adoption") {
    detail.textContent = `${history.ownerLabel || "The selected account"} is selected for an offline history-adoption step later. No live routing or history has changed.`;
  } else if (history.state === "adopted") {
    detail.textContent = `${history.ownerLabel || "The selected account"} has adopted existing history offline: ${history.importedThreadCount} threads across ${history.databaseCount} data stores and ${history.historyCount} history groups. Live routing remains separately reported.`;
  } else if (history.state === "invalid") {
    detail.textContent = "The saved offline history-adoption record could not be verified. No live routing or history change is being claimed.";
  } else if (history.state === "mismatch") {
    detail.textContent = "The saved history-adoption record belongs to a different account pool or selected owner. No live routing or history change is being claimed.";
  } else {
    detail.textContent = "Choose one of the two selected saved accounts before staging. History adoption is an offline step later; no live routing or history changes now.";
  }
  row.append(title, detail);
  card.append(row);
  return card;
}

function routerPresentation(router, live, savedSnapshotCount) {
  const savedCount = Number.isInteger(savedSnapshotCount) && savedSnapshotCount >= 0 ? savedSnapshotCount : 0;
  const liveStatus = live?.state === "active" && isRecord(live.status) ? live.status : null;
  if (liveStatus?.degradedReason) return { label: "Router needs attention", message: `The router reported ${String(liveStatus.degradedReason).replace(/_/g, " ")}. No live fallback state is being claimed here.`, accounts: [] };
  if (liveStatus?.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION) {
    const active = liveStatus.active;
    const pending = liveStatus.pending;
    const diskNotice = router?.degradedReason
      ? " The staged local record needs attention, but it does not replace authenticated live status."
      : "";
    if (active?.mode === "quota_aware") return {
      label: "Quota-aware routing is active",
      message: pending
        ? `Active ${routerIntentSummary(active)}. Pending ${routerIntentSummary(pending)} will apply only after a separately confirmed restart.${diskNotice}`
        : `Active ${routerIntentSummary(active)} from the authenticated local router.${diskNotice}`,
      accounts: Array.isArray(liveStatus.accounts) ? liveStatus.accounts : [],
    };
    if (pending) return {
      label: "Routing change staged",
      message: `Pending ${routerIntentSummary(pending)} will take effect only after a separately confirmed restart. Current live routing is unchanged.${diskNotice}`,
      accounts: [],
    };
    if (active?.mode === "manual") return { label: "Manual routing is active", message: `Active ${routerIntentSummary(active)} from the authenticated local router.${diskNotice}`, accounts: [] };
    return { label: "Router status unavailable", message: `No active router generation was provided by the authenticated local socket.${diskNotice}`, accounts: [] };
  }
  if (liveStatus?.mode === "balanced") {
    return {
      label: "Running Balanced",
      message: "Balanced routing is running. Account and thread counts below come from the authenticated local mux.",
      accounts: Array.isArray(liveStatus.accounts) ? liveStatus.accounts : [],
    };
  }
  if (router?.degradedReason) return { label: "Router needs attention", message: `The staged router record reported ${String(router.degradedReason).replace(/_/g, " ")}. No live fallback state is being claimed here.`, accounts: [] };
  if (router?.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION && router?.pending?.mode === "manual"
    && router?.historyAdoption?.state === "adopted") return {
    label: "Manual new-thread assignment pending",
    message: "Manual routing is staged only for new-thread assignment after a separately confirmed restart. Existing adopted history is not globally restored or reassigned.",
    accounts: [],
  };
  if (router?.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION && router?.pending) return {
    label: "Routing change staged",
    message: "The saved policy is pending. It does not claim that live routing has changed.",
    accounts: [],
  };
  if (router?.mode === "direct_fallback") return { label: "Fallback staged", message: "A direct fallback is staged. Live state could not be verified from the authenticated local router.", accounts: [] };
  if (router?.mode === "balanced" || router?.restartRequired) return { label: "Balanced staged - restart required", message: "Balanced mode is staged but not running yet. A later separately authorized restart is required.", accounts: [] };
  if (savedCount === 0) return { label: "Not configured", message: "Manual switching is active. Save two account snapshots before quota-aware routing can be staged.", accounts: [] };
  if (savedCount === 1) return { label: "Save two accounts", message: "Manual switching is active. One more saved snapshot is needed before quota-aware routing can be staged.", accounts: [] };
  if (savedCount === 2) return { label: "Ready to stage", message: "Manual switching is active. Explicitly stage quota-aware routing when ready.", accounts: [] };
  return { label: "Manual", message: "Manual switching is active. Quota-aware routing is available only while exactly two snapshots are saved.", accounts: [] };
}

function routerIntentSummary(intent) {
  const fingerprint = typeof intent?.fingerprint === "string" ? intent.fingerprint.slice(7, 19) : "unknown";
  return `generation ${intent?.generation ?? "unknown"} (${fingerprint})`;
}

function applyRouterPresentation(status, router, live, savedCount) {
  const presentation = routerPresentation(router, live, savedCount);
  status.replaceChildren?.();
  const label = document.createElement("span");
  label.className = "font-medium text-token-text-primary";
  label.textContent = `${presentation.label}. `;
  const message = document.createElement("span");
  message.textContent = presentation.message;
  status.append(label, message);
  if (presentation.accounts.length > 0) {
    const list = document.createElement("ul");
    list.className = "mt-2 list-disc pl-5 text-token-text-secondary";
    for (const account of presentation.accounts) {
      const item = document.createElement("li");
      item.textContent = `${account.label}: ${account.assignedThreadCount} assigned ${account.assignedThreadCount === 1 ? "thread" : "threads"} (${account.eligibility}).`;
      list.append(item);
    }
    status.append(list);
  }
}

function accountRecoveryCard(state, accounts, savedSnapshotCount, liveStatus, status) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Set up and recover";
  const note = document.createElement("div");
  note.className = "text-token-text-secondary text-sm";
  const stale = accounts.find((account) => accountDetailsFor(account, liveStatus)?.eligibility === "reauth_required");
  note.textContent = stale
    ? `${stale.label} needs reauthentication. Use its Manual switch row to sign in, then refresh this existing saved account while the router is stopped.`
    : savedSnapshotCount === 2
      ? "The two saved subscriptions are ready to review. Original snapshots stay unchanged during router setup."
      : savedSnapshotCount > 2
        ? "Quota-aware routing needs exactly two saved subscriptions. Manual switching remains available below for every saved account."
        : "Save the current account until exactly two subscriptions are available.";
  copy.append(title, note);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer shrink-0 rounded-md border px-3 text-sm text-token-text-primary";
  save.textContent = stale ? "Refresh reauthenticated account" : "Save current account";
  save.addEventListener("click", async () => {
    if (stale) {
      status.textContent = "Checking that the router is stopped before refreshing this account…";
      try {
        const refreshed = await state.api.ipc.invoke(IPC, { action: "router-recover", ref: stale.ref });
        status.textContent = refreshed?.ok
          ? "The existing saved account and isolated home were refreshed. The pending generation needs a separately confirmed restart; no live routing change is claimed."
          : routerControlFailure(refreshed?.error?.code).message;
      } catch { status.textContent = "The reauthenticated account could not be refreshed safely."; }
      return;
    }
    status.textContent = "Saving the current account…";
    const saved = await saveCurrentFromMenu(state);
    status.textContent = saved ? "Current account saved. Reopen Accounts to refresh the two subscriptions." : "No account was saved.";
  });
  row.append(copy, save);
  card.append(row);
  return card;
}

function advancedAccountsCard(state, accounts, protection, status) {
  const card = settingsCard();
  const header = document.createElement("div");
  header.className = "flex flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Advanced";
  const note = document.createElement("div");
  note.className = "text-token-text-secondary text-sm";
  note.textContent = "Manual switching, staged rollback, and remote-plugin protection.";
  header.append(title, note);
  const manualRow = document.createElement("div");
  manualRow.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const manualCopy = document.createElement("div");
  manualCopy.className = "text-token-text-secondary text-sm";
  manualCopy.textContent = "Stage manual routing for the next confirmed restart. Existing isolated account homes are preserved.";
  const manual = document.createElement("button");
  manual.type = "button";
  manual.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary";
  manual.textContent = "Stage manual routing";
  manual.disabled = false;
  manual.addEventListener("click", async () => {
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "router-configure", mode: "manual" });
      status.textContent = result?.ok
        ? "Manual routing is staged for the next confirmed restart; current live routing is unchanged."
        : routerControlFailure(result?.error?.code).message;
    } catch { status.textContent = "Manual routing could not be staged safely."; }
  });
  manualRow.append(manualCopy, manual);
  const switches = document.createElement("div");
  switches.className = "flex flex-col divide-y-[0.5px] divide-token-border";
  for (const account of accounts) switches.append(accountButton(state, account));
  card.append(header, manualRow, switches, pluginProtectionCard(state, protection));
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
  let routerStatus;
  try {
    [response, routerStatus] = await Promise.all([
      state.api.ipc.invoke(IPC, { action: "list" }),
      state.api.ipc.invoke(IPC, { action: "router-status" }).catch(() => null),
    ]);
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
  const panel = accountMenuRows(state, response.accounts, routerStatus);
  panel.dataset.tweakersAccountSwitcher = "true";
  targetMenu.append(panel);
}

function accountMenuRows(state, suppliedAccounts, routerStatus) {
  const savedAccounts = Array.isArray(suppliedAccounts) ? suppliedAccounts : [];
  const accounts = savedAccounts.length === 2 ? savedAccounts : [];
  const liveStatus = routerStatus?.live?.state === "active" && isRecord(routerStatus.live.status)
    ? routerStatus.live.status : null;
  const panel = document.createElement("div");
  panel.className = "border-token-border my-1 flex flex-col border-t px-2 py-1";
  const usage = document.createElement("div");
  usage.className = "flex items-center justify-between gap-3 px-2 py-1.5 text-sm text-token-text-primary";
  const usageCopy = document.createElement("div");
  usageCopy.className = "flex min-w-0 flex-col";
  const usageTitle = document.createElement("span");
  usageTitle.textContent = "Usage remaining";
  const subscriptions = document.createElement("span");
  subscriptions.className = "text-token-text-secondary text-xs";
  subscriptions.textContent = accounts.length === 2 ? "2 connected subscriptions" : "Set up exactly two saved subscriptions";
  usageCopy.append(usageTitle, subscriptions);
  const pool = document.createElement("span");
  pool.className = "text-token-text-secondary shrink-0";
  pool.textContent = quotaSummaryText(liveStatus);
  usage.append(usageCopy, pool);
  panel.append(usage);

  if (accounts.length === 2) {
    for (const account of accounts) {
      const detail = accountDetailsFor(account, liveStatus);
      const row = document.createElement("div");
      row.className = "hover:bg-token-foreground/5 flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm text-token-text-primary";
      const identity = document.createElement("div");
      identity.className = "flex min-w-0 items-center gap-2";
      const copy = document.createElement("div");
      copy.className = "flex min-w-0 flex-col";
      const label = document.createElement("span");
      label.className = "truncate";
      label.textContent = account.label;
      const detailText = document.createElement("span");
      detailText.className = "text-token-text-secondary truncate text-xs";
      const plan = detail?.plan || "Plan unavailable";
      const weekly = Number.isFinite(detail?.weekly?.remainingPercent) ? `${Math.round(detail.weekly.remainingPercent)}% weekly` : "Weekly usage unavailable";
      detailText.textContent = `${plan} · ${maskIdentifier(detail?.identifierMasked)} · ${weekly}`;
      copy.append(label, detailText);
      identity.append(accountAvatar(account.label), copy);
      row.append(identity);
      panel.append(row);
    }
  } else {
    const setup = document.createElement("div");
    setup.className = "px-2 py-1.5 text-sm text-token-text-secondary";
    setup.textContent = "Set up exactly two saved subscriptions in Accounts.";
    panel.append(setup);
    if (savedAccounts.length > 0) {
      const manualTitle = document.createElement("div");
      manualTitle.className = "px-2 pt-2 text-xs text-token-text-secondary";
      manualTitle.textContent = "Manual switching";
      panel.append(manualTitle);
      for (const account of savedAccounts) panel.append(accountButton(state, account));
    }
  }

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = menuButtonClass();
  manage.textContent = "Manage Accounts";
  manage.setAttribute("aria-label", "Manage Accounts settings");
  manage.addEventListener("click", async () => {
    const result = await state.api.settings?.openPage?.("accounts");
    if (!result?.ok) state.api.log?.warn?.("Accounts settings page could not be opened", result?.reason || "unavailable");
  });
  panel.append(manage);
  return panel;
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
  const directName = [value?.user?.name, value?.account?.name, value?.name]
    .find((item) => typeof item === "string" && item.trim() && !/@/.test(item));
  const token = value?.tokens?.id_token;
  if (typeof token === "string") {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      const claim = [claims.name, claims.preferred_username].find((item) => typeof item === "string" && item.trim() && !/@/.test(item));
      if (claim) {
        const label = safeAccountLabel(claim, "");
        if (label) return label;
      }
    } catch {}
  }
  if (directName) {
    const label = safeAccountLabel(directName, "");
    if (label) return label;
  }
  return safeAccountLabel(typeof fallback === "string" ? fallback : "", "");
}
function safeSnapshotLabel(value, filename, ordinal = 1) {
  const filenameLabel = typeof filename === "string" ? filename.replace(/\.json$/i, "") : "";
  const fromSnapshot = safeAccountLabel(filenameLabel, "");
  if (fromSnapshot) return fromSnapshot;
  const fromProfile = displayLabelFromAuth(value, "");
  return fromProfile || `Account ${Math.max(1, Number.isInteger(ordinal) ? ordinal : 1)}`;
}
function savedSnapshotLabels(entries) {
  const records = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.isFile?.() && typeof entry.name === "string" && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry, index) => {
      try {
        validateReferenceName(entry.name.slice(0, -5));
        return [{ filename: entry.name, base: safeSnapshotLabel(null, entry.name, index + 1) }];
      } catch { return []; }
    });
  const counts = new Map();
  for (const record of records) {
    const key = record.base.toLocaleLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const next = new Map();
  const ordinals = new Map();
  for (const record of records) {
    const key = record.base.toLocaleLowerCase();
    const ordinal = (ordinals.get(key) || 0) + 1;
    ordinals.set(key, ordinal);
    const label = counts.get(key) > 1
      ? safeAccountLabel(`${record.base.slice(0, 76)} ${ordinal}`, `Account ${ordinal}`)
      : record.base;
    next.set(record.filename, label);
  }
  return next;
}
function safeFailure(code) { return { ok: false, error: { code, message: "The account request could not be completed safely." } }; }
function routerPublicErrorCode(code) {
  return typeof code === "string" && ROUTER_PUBLIC_ERROR_CODES.has(code) ? code : "router-operation-failed";
}
function routerControlFailure(code) {
  const safeCode = routerPublicErrorCode(code);
  return { code: safeCode, message: ROUTER_CONTROL_FAILURE_MESSAGES[safeCode] };
}
function reportRouterControlFailure(state, status, code) {
  const failure = routerControlFailure(code);
  try { state.api.log?.warn?.("Account Router control failure", failure.code); } catch {}
  status.textContent = failure.message;
}
function safeRouterFailure(error) {
  return safeFailure(routerPublicErrorCode(error?.code));
}
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

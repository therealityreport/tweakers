"use strict";

const IPC = "accounts";
const ACCOUNT_EVENTS_CHANNEL = "accounts.events";
const ACCOUNT_BROKER_VERSION = 1;
const ACCOUNT_BROKER_ACTION = "broker";
const ACCOUNT_AUTHORITY_STATUS_ACTION = "authority-status";
const ACCOUNT_AUTHORITY_MODES = new Set(["global-v3", "legacy", "blocked"]);
const ACCOUNT_AUTHORITY_UNAVAILABLE = "account-authority-unavailable";
const ACCOUNT_BROKER_COMMANDS = new Set([
  "enrollment.start", "enrollment.status", "enrollment.cancel",
  "reconnect.start", "reconnect.status", "reconnect.cancel",
  "profile.read", "profile.statistics", "profile.update", "enabled.set", "quota.read",
  "native.request",
  "connection.list", "connection.status", "connection.authorize",
  "resetCredit.consume", "handoff.confirm", "handoff.cancel",
  // balance.* remains accepted for legacy compatibility, but Accounts no
  // longer renders or requests token-balancing controls.
  "history.read", "balance.read", "balance.set",
  "preferences.read", "preferences.update", "profile.email",
  "remote.status", "remote.enable", "remote.disable",
  "remote.pairing.start", "remote.pairing.status", "remote.pairing.close",
  "remote.devices.list", "remote.devices.revoke",
  "events.subscribe", "events.unsubscribe",
]);
const ACCOUNT_BROKER_EVENT_TYPES = new Set([
  "profile.updated", "quota.updated", "enabled.changed", "connection.updated",
  "enrollment.updated", "reconnect.updated", "resetCredit.updated",
  "continuation.pending", "continuation.resolved", "handoff.updated",
  "history.updated", "conversation.updated", "turn.committed",
]);
const ACCOUNT_BROKER_SHARED_HISTORY_INVALIDATION_TYPES = new Set([
  "history.updated", "conversation.updated", "turn.committed",
]);
const ACCOUNT_BROKER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Every identifier crossing the renderer boundary is a broker-issued public
// HMAC projection. Never accept a plausible provider/account/login ID here.
const ACCOUNT_BROKER_ACCOUNT_ID = /^account_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_CONNECTION_ID = /^connection_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_ENROLLMENT_ID = /^enrollment_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_CONFIRMATION_ID = /^confirmation_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_CONVERSATION_ID = /^conversation_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_SEGMENT_ID = /^segment_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_CLIENT_ID = /^client_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_TURN_ID = /^turn_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_BROKER_DEVICE_ID = /^device_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_PROVIDER_LOGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
// Account pools intentionally have no cardinality cap. Bound complete IPC or
// stored values by bytes instead, then validate every row before rendering.
const ACCOUNT_SERIALIZED_VALUE_MAX_BYTES = 512 * 1024;
const ACCOUNT_NATIVE_RESULT_MAX_BYTES = 4 * 1024 * 1024;
const ACCOUNT_BROKER_MAX_CONNECTIONS = 128;
const ACCOUNT_BROKER_MAX_REMOTE_DEVICES = 128;
const ACCOUNT_BROKER_MAX_PROFILE_ACTIVITY_BUCKETS = 3_660;
const ACCOUNT_BROKER_MAX_PROFILE_TOP_INVOCATIONS = 128;
const ACCOUNT_BROKER_REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);
const ACCOUNT_REMOTE_PAIRING_POLL_MS = 2_000;
// These are the only native settings surfaces that may receive a per-login
// account connection control. Do not substitute generic settings rows: the
// host proves each of these page boundaries independently.
const ACCOUNT_NATIVE_CONNECTION_SURFACES = Object.freeze([
  Object.freeze({ kind: "apps-settings", surface: "apps", title: "Apps" }),
  Object.freeze({ kind: "mcp-settings", surface: "mcp", title: "MCP" }),
]);
const ACCOUNT_NATIVE_CONNECTION_SURFACE_KINDS = Object.freeze(
  ACCOUNT_NATIVE_CONNECTION_SURFACES.map((surface) => surface.kind),
);
const ACCOUNT_NATIVE_CONNECTION_SURFACE_ATTR = "data-tweakers-account-connection-surface";
const SERVICE_KEY = "__tweakersAccountServiceV1";
const HANDLER_KEY = "__tweakersAccountHandlerV1";
const BROKER_KEY = "__tweakersAccountsBrokerBridgeV1";
const MAX_AUTH_BYTES = 1024 * 1024;
const INTENT_TTL_MS = 30_000;
const PLUGIN_PROFILE_KEY = "remote-plugin-profile-v1";
const PLUGIN_RECEIPTS_KEY = "remote-plugin-receipts-v1";
const ACCOUNT_USERNAMES_KEY = "account-usernames-v1";
const ACCOUNT_PROFILES_KEY = "account-profiles-v3";
const MAX_IDENTITY_CLAIMS_BYTES = 64 * 1024;
const PLUGIN_PROFILE_SCHEMA_VERSION = 1;
const PLUGIN_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const PLUGIN_PROBE_TIMEOUT_MS = 8_000;
const PLUGIN_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const ACCOUNT_ROUTER_SCHEMA_VERSION = 3;
const ACCOUNT_ROUTER_V2_SCHEMA_VERSION = 2;
const ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION = 1;
const ACCOUNT_ROUTER_QUOTA_POLICY = "quota_aware_v2";
const ACCOUNT_ROUTER_V2_QUOTA_POLICY = "quota_aware_v1";
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
  "router-requires-at-least-two-accounts",
  "invalid-router-enabled-accounts",
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
  "router-requires-exactly-two-accounts": "Save at least two different accounts before setting up automatic routing.",
  "router-requires-at-least-two-accounts": "Save at least two different accounts before setting up automatic routing.",
  "invalid-router-enabled-accounts": "Keep at least one saved account enabled for routing.",
  "invalid-router-weight": "The saved routing setup is invalid.",
  "router-requires-distinct-accounts": "The two saved accounts must be different.",
  "router-history-owner-required": "Choose which account should keep the conversations you already have.",
  "router-history-owner-not-selected": "Choose one of the two saved accounts for your current conversations.",
  "router-history-adoption-invalid": "We could not verify the saved conversation setup. Nothing was moved.",
  "router-history-adoption-mismatch": "The saved conversation setup belongs to different accounts. Nothing was moved.",
  "router-state-mismatch-requires-reset": "This setup does not match the accounts used before. Keep manual routing on until the account setup is repaired.",
  "router-not-idle": "Wait for current work to finish before resetting routing usage.",
  "router-recovery-router-running": "Turn automatic routing off before repairing this saved account.",
  "router-recovery-router-status-unavailable": "We could not confirm that routing is stopped, so this account was not changed.",
  "router-recovery-account-mismatch": "The account signed in now is not the saved account you chose to repair.",
  "router-recovery-not-needed": "This saved account is already up to date.",
  "router-operation-failed": "The account routing change could not be completed safely.",
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
      // stop() also runs during ordinary source hot reloads. It must only
      // release process resources; routing changes require an explicit Accounts
      // action and are never inferred from lifecycle teardown.
      service?.dispose?.();
      if (globalThis[SERVICE_KEY] === service) globalThis[SERVICE_KEY] = null;
      const broker = globalThis[BROKER_KEY];
      broker?.dispose?.();
      if (globalThis[BROKER_KEY] === broker) globalThis[BROKER_KEY] = null;
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
    stableRef, authPaths, accountIdentityFromAuth, displayLabelFromAuth, safeEmail, safeUsername,
    safeSnapshotLabel, displaySnapshotLabels, displaySnapshotIdentities, readAccountUsernames, updateAccountUsername,
    syncActiveSnapshot,
    cleanupLegacyAnalytics, accountMenuTargetFromCandidates, startRenderer, disposeRenderer,
    nativeAccountSettingsSurfaceTarget, projectBrokerConnection,
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
    quotaPoolRemainingPercent, freshWeeklyRemainingPercent, accountDetailsFor, accountDisplayLabel, accountIdentitySummary,
    accountChoiceLabel, accountUsingNow, accountRowStatus, accountCards, accountMenuRows, advancedAccountsCard,
    accountRecoveryCard, historyAdoptionCard, maskIdentifier, safeAccountLabel,
    createAccountBrokerBridge, normalizeAccountBrokerRequest, normalizeAccountBrokerResponse,
    projectAccountBrokerResult, projectAccountBrokerEvent, accountBrokerFailure, freshBrokerQuotaRemainingPercent, brokerPoolStats, brokerQuotaText, brokerUsageValueText,
    projectProfileSafeStats, projectProfileStatistics, refreshProfileStatistics, profileStatisticsResultFor,
    brokerProfileActivityCard, profileStatisticsPicker,
    applyAllAccountQuotaResult, refreshAllBrokerQuotas, accountSurfacesVisible,
    requestAccountsNativeValue, projectAccountsNativeValue, nativeWhamProfile,
    projectNativeUsageWindow, projectNativeUsageWindows, projectNativeUsageStatus, nativePooledQuota,
    projectNativeUsageResetModal,
    mountAccountSwitcherPanel, syncAccountsNativeSelections,
    subscribeToAccountBroker, isSerializedValueWithinBound, brokerAccountSelector, brokerAccountAvatar, accountBrokerDisplayMessage,
    accountConnectionDisplayMessage, renderBrokerUnavailable,
    projectBrokerPreferences, projectBrokerEmail, projectBrokerRemote, safeBrokerDeviceId,
    brokerRoutingPreferencesCard, brokerAccountPoolCard, brokerAccountDisclosure, brokerRemoteControls,
    beginBrokerRemotePairing, updateBrokerRemoteEnabled, clearRemotePairing, refreshBrokerRemote,
    renderBrokerAccountsContents, brokerEnrollmentStatusCard,
    projectDeviceLogin, cancelAccountEnrollment, publicEnrollment,
    projectBrokerSharedHistory, projectBrokerTurnAttribution, sharedHistoryAvailabilityText,
    brokerSharedHistoryCard, projectBrokerBalance, renderSharedHistoryConversationAdapter,
    refreshSharedHistoryConversationAdapter, clearSharedHistoryConversationAdapter,
    handleAccountBrokerEvent, refreshSharedHistory, eligibleContinuationDestinations, brokerContinuationCard,
    accountAuthorityModeFromRuntime, normalizeAccountAuthorityMode, injectAccountMenus,
  },
};

function startMain(api) {
  const deps = nodeDeps();
  const paths = authPaths(deps);
  // The runtime owns this mode. Do not consult a renderer message, local broker
  // health, or a legacy file here: configured-but-unavailable global v3 stays
  // authoritative and local state must remain read-only.
  const authorityMode = accountAuthorityModeFromRuntime(api);
  if (authorityMode === "legacy") cleanupLegacyAnalytics(deps);
  const service = createAccountService(api, {
    deps,
    paths,
    authorityMode,
    onSwitched: () => scheduleHostRestart(api),
  });
  globalThis[SERVICE_KEY] = service;
  const broker = createAccountBrokerBridge(api);
  globalThis[BROKER_KEY] = broker;
  if (!globalThis[HANDLER_KEY]) {
    const handle = (context, message) => {
      const active = globalThis[SERVICE_KEY];
      if (!active) return safeFailure("unavailable");
      if (isAccountBrokerEnvelope(message)) {
        return globalThis[BROKER_KEY]?.handle(context, message)
          || accountBrokerFailure(accountBrokerRequestId(message), "broker_unavailable");
      }
      return active.handle(message);
    };
    // Broker actions carry account lifecycle authority. They must have an
    // owned renderer identity, so old hosts may retain only their legacy
    // read-only compatibility path and never gain broker access.
    const unregister = typeof api.ipc?.handleWithContext === "function"
      ? api.ipc.handleWithContext(IPC, handle)
      : api.ipc.handle?.(IPC, (message) => {
        if (isAccountBrokerEnvelope(message)) {
          return accountBrokerFailure(accountBrokerRequestId(message), "broker_unavailable");
        }
        return handle(null, message);
      });
    globalThis[HANDLER_KEY] = typeof unregister === "function" ? unregister : true;
  }
  // Deliberately advisory: startup/update observation consults stored receipts
  // only. Codex's official inventory call can reconcile the active account's
  // remote bundle cache, so it is never invoked automatically here.
  void service.observeStartup();
  api.log.info("Account switcher service ready");
}

/**
 * The Accounts renderer never talks to an account home, app-server child, or
 * provider API directly. This small adapter is intentionally the only
 * renderer-facing route to the runtime-owned broker. It validates the public
 * envelope, binds it to the owned sender, and projects every response/event
 * again before it can reach a DOM node.
 */
function createAccountBrokerBridge(api) {
  const subscriptions = new Map();
  let disposed = false;

  const detach = (webContentsId) => {
    const cleanup = subscriptions.get(webContentsId);
    subscriptions.delete(webContentsId);
    try { cleanup?.(); } catch {}
  };

  const attach = (webContentsId) => {
    if (subscriptions.has(webContentsId)) return true;
    const accounts = api?.codex?.accounts;
    if (typeof accounts?.subscribe !== "function" || typeof api?.ipc?.sendToRenderer !== "function") return false;
    try {
      const cleanup = accounts.subscribe({ webContentsId }, (event) => {
        if (disposed || !subscriptions.has(webContentsId)) return;
        const projected = projectAccountBrokerEvent(event);
        if (!projected) return;
        try {
          const delivered = api.ipc.sendToRenderer(webContentsId, ACCOUNT_EVENTS_CHANNEL, projected);
          if (delivered === false) detach(webContentsId);
        } catch { detach(webContentsId); }
      });
      if (typeof cleanup !== "function") return false;
      subscriptions.set(webContentsId, cleanup);
      return true;
    } catch {
      return false;
    }
  };

  return {
    async handle(context, message) {
      const request = normalizeAccountBrokerRequest(message);
      if (!request) return accountBrokerFailure(accountBrokerRequestId(message), "broker_invalid_request");
      const webContentsId = Number.isSafeInteger(context?.sender?.webContentsId)
        && context.sender.webContentsId > 0 ? context.sender.webContentsId : null;
      if (!webContentsId || disposed) return accountBrokerFailure(request.requestId, "broker_unavailable");
      const accounts = api?.codex?.accounts;
      if (typeof accounts?.invoke !== "function") return accountBrokerFailure(request.requestId, "broker_unavailable");

      let response;
      try {
        // Preserve the main-created sender context object. It carries an
        // unforgeable, non-renderer-visible document binding for MCP OAuth,
        // so a same-WebContents reload cannot complete an older handoff.
        response = await accounts.invoke(context.sender, request);
      } catch {
        return accountBrokerFailure(request.requestId, "broker_unavailable", true);
      }
      const normalized = normalizeAccountBrokerResponse(request, response);
      if (!normalized.ok) return normalized;

      if (request.command === "events.subscribe" && !attach(webContentsId)) {
        return accountBrokerFailure(request.requestId, "broker_unavailable", true);
      }
      if (request.command === "events.unsubscribe") detach(webContentsId);
      return normalized;
    },
    dispose() {
      disposed = true;
      for (const webContentsId of [...subscriptions.keys()]) detach(webContentsId);
    },
  };
}

function isAccountBrokerEnvelope(message) {
  return isRecord(message) && message.action === ACCOUNT_BROKER_ACTION;
}

function accountBrokerRequestId(message) {
  return typeof message?.requestId === "string" && ACCOUNT_BROKER_REQUEST_ID.test(message.requestId)
    ? message.requestId : null;
}

function normalizeAccountBrokerRequest(message) {
  if (!isAccountBrokerEnvelope(message)
    || message.version !== ACCOUNT_BROKER_VERSION
    || !ACCOUNT_BROKER_REQUEST_ID.test(message.requestId || "")
    || !ACCOUNT_BROKER_COMMANDS.has(message.command)
    || (message.params !== undefined && !isRecord(message.params))) return null;
  const params = projectAccountBrokerParams(message.command, message.params || {});
  if (params === null) return null;
  return {
    version: ACCOUNT_BROKER_VERSION,
    action: ACCOUNT_BROKER_ACTION,
    requestId: message.requestId,
    command: message.command,
    ...(Object.keys(params).length ? { params } : {}),
  };
}

function projectAccountBrokerParams(command, value) {
  const accountId = safeBrokerAccountId(value.accountId);
  const enrollmentId = safeBrokerEnrollmentId(value.enrollmentId);
  const confirmationId = safeBrokerConfirmationId(value.confirmationId);
  const connectionId = safeBrokerConnectionId(value.connectionId);
  const deviceId = safeBrokerDeviceId(value.deviceId);
  const surface = safeConnectionSurface(value.surface);
  if (["profile.read", "history.read", "balance.read", "preferences.read", "events.subscribe", "events.unsubscribe"].includes(command)) {
    return Object.keys(value).length === 0 ? {} : null;
  }
  if (command === "profile.statistics") {
    const selection = value.selection === "pooled" ? "pooled" : safeBrokerAccountId(value.selection);
    return selection && Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, "selection")
      ? { selection } : null;
  }
  if (command === "balance.set") {
    return Object.keys(value).length === 1 && typeof value.enabled === "boolean" ? { enabled: value.enabled } : null;
  }
  if (command === "profile.update") {
    const label = safeAccountLabel(value.label, "");
    return accountId && label && Object.keys(value).every((key) => ["accountId", "label"].includes(key)) ? { accountId, label } : null;
  }
  if (command === "profile.email") {
    return accountId && Object.keys(value).every((key) => key === "accountId") ? { accountId } : null;
  }
  if (command === "preferences.update") {
    const allowed = ["failoverMode", "unifiedCatalogEnabled"];
    const hasFailoverMode = Object.prototype.hasOwnProperty.call(value, "failoverMode");
    const hasUnifiedCatalogEnabled = Object.prototype.hasOwnProperty.call(value, "unifiedCatalogEnabled");
    if (!Object.keys(value).length || !Object.keys(value).every((key) => allowed.includes(key))) return null;
    if (hasFailoverMode && !["automatic", "ask"].includes(value.failoverMode)) return null;
    if (hasUnifiedCatalogEnabled && typeof value.unifiedCatalogEnabled !== "boolean") return null;
    return {
      ...(hasFailoverMode ? { failoverMode: value.failoverMode } : {}),
      ...(hasUnifiedCatalogEnabled ? { unifiedCatalogEnabled: value.unifiedCatalogEnabled } : {}),
    };
  }
  if (["remote.status", "remote.enable", "remote.disable", "remote.pairing.start", "remote.pairing.status", "remote.pairing.close", "remote.devices.list"].includes(command)) {
    return accountId && Object.keys(value).every((key) => key === "accountId") ? { accountId } : null;
  }
  if (command === "remote.devices.revoke") {
    return accountId && deviceId && Object.keys(value).every((key) => ["accountId", "deviceId"].includes(key))
      ? { accountId, deviceId } : null;
  }
  if (command === "enabled.set") {
    return accountId && typeof value.enabled === "boolean" && Object.keys(value).every((key) => ["accountId", "enabled"].includes(key))
      ? { accountId, enabled: value.enabled } : null;
  }
  if (command === "quota.read") {
    return Object.keys(value).length === 0 ? {} : accountId && Object.keys(value).every((key) => key === "accountId") ? { accountId } : null;
  }
  if (command === "native.request") {
    const method = typeof value.method === "string" && /^[A-Za-z][A-Za-z0-9/_.:-]{0,127}$/.test(value.method)
      ? value.method : null;
    return accountId && surface && method && isRecord(value.params)
      && Object.keys(value).sort().join("\0") === "accountId\0method\0params\0surface"
      && isSerializedValueWithinBound(value.params)
      ? { accountId, surface, method, params: value.params } : null;
  }
  if (["connection.list", "connection.status"].includes(command)) {
    if (!accountId || !surface || !Object.keys(value).every((key) => ["accountId", "surface", "connectionId"].includes(key))) return null;
    return { accountId, surface, ...(connectionId ? { connectionId } : {}) };
  }
  if (command === "connection.authorize") {
    // The current app-server contract proves OAuth only for MCP. Apps and
    // Plugins remain account-local status views; reject forged connect actions
    // instead of presenting a provider flow that does not exist.
    return accountId && surface === "mcp" && connectionId
      && Object.keys(value).every((key) => ["accountId", "surface", "connectionId"].includes(key))
      ? { accountId, surface, connectionId } : null;
  }
  if (command === "resetCredit.consume") {
    return accountId && Object.keys(value).every((key) => key === "accountId") ? { accountId } : null;
  }
  if (["handoff.confirm", "handoff.cancel"].includes(command)) {
    const allowed = command === "handoff.confirm" ? ["confirmationId", "accountId"] : ["confirmationId"];
    if (!confirmationId || !Object.keys(value).every((key) => allowed.includes(key))) return null;
    return command === "handoff.confirm" && accountId ? { confirmationId, accountId } : { confirmationId };
  }
  if (["enrollment.start", "reconnect.start"].includes(command)) {
    const allowed = command === "reconnect.start" ? ["accountId"] : [];
    if (!Object.keys(value).every((key) => allowed.includes(key))) return null;
    return command === "reconnect.start" ? (accountId ? { accountId } : null) : {};
  }
  if (["enrollment.status", "enrollment.cancel", "reconnect.status", "reconnect.cancel"].includes(command)) {
    return enrollmentId && Object.keys(value).every((key) => key === "enrollmentId") ? { enrollmentId } : null;
  }
  return null;
}

function accountBrokerFailure(requestId, code, retryable = false) {
  const safeCode = typeof code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(code)
    ? code : "broker_unavailable";
  return {
    version: ACCOUNT_BROKER_VERSION,
    requestId: requestId || null,
    ok: false,
    error: { code: safeCode, retryable: retryable === true },
  };
}

function normalizeAccountBrokerResponse(request, response) {
  const responseLimit = request.command === "native.request" ? ACCOUNT_NATIVE_RESULT_MAX_BYTES : ACCOUNT_SERIALIZED_VALUE_MAX_BYTES;
  if (!isRecord(response)
    || response.version !== ACCOUNT_BROKER_VERSION
    || response.requestId !== request.requestId
    || typeof response.ok !== "boolean"
    || !isSerializedValueWithinBound(response, responseLimit)) {
    return accountBrokerFailure(request.requestId, "broker_invalid_response");
  }
  if (!response.ok) {
    const code = typeof response.error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(response.error.code)
      ? response.error.code : "broker_unavailable";
    return accountBrokerFailure(request.requestId, code, response.error?.retryable === true);
  }
  const result = projectAccountBrokerResult(request.command, response.result);
  if (result === null || !isSerializedValueWithinBound(result, responseLimit)) return accountBrokerFailure(request.requestId, "broker_invalid_response");
  return { version: ACCOUNT_BROKER_VERSION, requestId: request.requestId, ok: true, result };
}

function serializedValueByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).byteLength;
    if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") return Buffer.byteLength(serialized, "utf8");
    return encodeURIComponent(serialized).replace(/%[0-9A-F]{2}|./gi, "x").length;
  } catch {
    return null;
  }
}

function isSerializedValueWithinBound(value, maxBytes = ACCOUNT_SERIALIZED_VALUE_MAX_BYTES) {
  const bytes = serializedValueByteLength(value);
  return Number.isInteger(bytes) && bytes >= 0 && bytes <= maxBytes;
}

function safeBrokerAccountId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_ACCOUNT_ID.test(value) ? value : null;
}

function safeBrokerConnectionId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_CONNECTION_ID.test(value) ? value : null;
}

function safeBrokerDeviceId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_DEVICE_ID.test(value) ? value : null;
}

function safeBrokerEnrollmentId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_ENROLLMENT_ID.test(value) ? value : null;
}

function safeBrokerConfirmationId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_CONFIRMATION_ID.test(value) ? value : null;
}

function safeBrokerConversationId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_CONVERSATION_ID.test(value) ? value : null;
}

function safeBrokerSegmentId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_SEGMENT_ID.test(value) ? value : null;
}

function safeBrokerClientId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_CLIENT_ID.test(value) ? value : null;
}

function safeBrokerTurnId(value) {
  return typeof value === "string" && ACCOUNT_BROKER_TURN_ID.test(value) ? value : null;
}

function safeProviderLoginId(value) {
  return typeof value === "string" && ACCOUNT_PROVIDER_LOGIN_ID.test(value) ? value : null;
}

function safeConnectionSurface(value) {
  return ["apps", "plugins", "mcp", "usage"].includes(value) ? value : null;
}

function safeBrokerUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function safeBrokerAvatarUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    // Browser-safe projections may fetch only a parsed HTTP(S) origin. Strip
    // query and fragment fields before the value can reach img.src so a
    // broker/provider token cannot become a renderer-visible URL capability.
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.origin === "null" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function safeBrokerTimestamp(value) {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeMaskedEmail(value) {
  const raw = typeof value === "string" ? value.trim().slice(0, 254) : "";
  const full = safeEmail(raw);
  if (full) {
    const [local, domain] = full.split("@");
    return `${local.slice(0, 1)}${"•".repeat(Math.max(3, Math.min(8, local.length - 1 || 3)))}@${domain}`;
  }
  return /^[A-Za-z0-9•*._-]{1,64}@[A-Za-z0-9.-]{3,190}$/.test(raw) && /[•*]/.test(raw) ? raw : null;
}

function projectBrokerQuota(value) {
  if (!isRecord(value)) return null;
  const remainingPercent = Number.isFinite(value.remainingPercent)
    && value.remainingPercent >= 0 && value.remainingPercent <= 100 ? Math.round(value.remainingPercent) : null;
  const freshness = ["fresh", "stale", "unknown"].includes(value.freshness) ? value.freshness : "unknown";
  const resetAt = safeBrokerTimestamp(value.resetAt);
  const resetCredits = Number.isInteger(value.resetCredits) && value.resetCredits >= 0 && value.resetCredits <= 10_000
    ? value.resetCredits : null;
  const refreshState = ["idle", "loading", "error"].includes(value.refreshState) ? value.refreshState : "idle";
  const errorCode = ["authentication", "connection", "unavailable"].includes(value.errorCode) ? value.errorCode : null;
  const lastAttemptAt = safeBrokerTimestamp(value.lastAttemptAt);
  return {
    remainingPercent,
    freshness,
    resetAt,
    depleted: value.depleted === true || remainingPercent === 0,
    resetCredits,
    refreshState,
    errorCode,
    lastAttemptAt,
  };
}

function projectBrokerAccount(value) {
  if (!isRecord(value)) return null;
  const accountId = safeBrokerAccountId(value.accountId);
  const email = safeMaskedEmail(value.maskedEmail || value.email);
  const label = email || safeAccountLabel(value.label || value.displayLabel, "");
  if (!accountId || !label) return null;
  const quota = projectBrokerQuota(value.quota || value.weekly || value);
  const assignedTaskCount = Number.isInteger(value.assignedTaskCount ?? value.assignedThreadCount)
    && (value.assignedTaskCount ?? value.assignedThreadCount) >= 0
    && (value.assignedTaskCount ?? value.assignedThreadCount) <= 1_000_000
    ? (value.assignedTaskCount ?? value.assignedThreadCount) : 0;
  return {
    accountId,
    label,
    avatarUrl: safeBrokerAvatarUrl(value.avatarUrl || value.avatar),
    email,
    plan: safeAccountLabel(value.plan, "") || null,
    enabled: value.enabled !== false,
    quota,
    assignedTaskCount,
    currentTaskOwner: value.currentTaskOwner === true,
    ...(value.continuityState === "ready" || value.continuityState === "deferred" ? { continuityState: value.continuityState } : {}),
    ...(["migration_pending", "account_in_use", "source_changed", "recovery_required"].includes(value.continuityReason) ? { continuityReason: value.continuityReason } : {}),
    ...(safeAccountLabel(value.continuityBlocker, "") ? { continuityBlocker: safeAccountLabel(value.continuityBlocker, "") } : {}),
    status: ["ready", "depleted", "disabled", "reauth_required", "unavailable", "active"].includes(value.status)
      ? value.status : "unavailable",
  };
}

function projectBrokerConnection(value) {
  if (!isRecord(value)) return null;
  const connectionId = safeBrokerConnectionId(value.connectionId);
  const surface = safeConnectionSurface(value.surface);
  const label = safeAccountLabel(value.label || value.name, "");
  const status = ["connected", "setup_required", "expired", "unavailable"].includes(value.status)
    ? value.status : null;
  if (!connectionId || !surface || !label || !status) return null;
  return {
    connectionId,
    surface,
    label,
    status,
    authorizationAvailable: surface === "mcp" && value.authorizationAvailable === true,
  };
}

function projectBrokerEnrollment(value) {
  if (!isRecord(value)) return null;
  const enrollmentId = safeBrokerEnrollmentId(value.enrollmentId);
  const state = ["starting", "waiting", "complete", "cancelled", "failed", "expired"].includes(value.state)
    ? value.state : null;
  if (!enrollmentId || !state) return null;
  const code = typeof value.userCode === "string" && /^[A-Za-z0-9-]{4,32}$/.test(value.userCode) ? value.userCode : null;
  const verificationUrl = safeBrokerUrl(value.verificationUrl);
  return {
    enrollmentId,
    state,
    userCode: state === "waiting" ? code : null,
    verificationUrl: state === "waiting" ? verificationUrl : null,
    expiresAt: safeBrokerTimestamp(value.expiresAt),
    accountId: safeBrokerAccountId(value.accountId),
  };
}

function projectBrokerHistorySubscription(value) {
  if (!isRecord(value)) return null;
  const accountId = safeBrokerAccountId(value.accountId);
  const label = safeMaskedEmail(value.label) || safeAccountLabel(value.label, "");
  return accountId && label ? { accountId, label } : null;
}

function projectBrokerHistorySegment(value) {
  if (!isRecord(value)) return null;
  const segmentId = safeBrokerSegmentId(value.segmentId);
  const subscription = projectBrokerHistorySubscription(value.subscription);
  const state = ["committed", "active", "incomplete", "ambiguous"].includes(value.state) ? value.state : null;
  if (!segmentId || !subscription || !state) return null;
  return { segmentId, subscription, state, committedAt: safeBrokerTimestamp(value.committedAt) };
}

function projectBrokerActiveClient(value) {
  if (!isRecord(value)) return null;
  const clientId = safeBrokerClientId(value.clientId);
  const label = safeAccountLabel(value.label, "");
  const subscription = projectBrokerHistorySubscription(value.subscription);
  return clientId && label && subscription ? { clientId, label, subscription } : null;
}

function projectBrokerTurnAttribution(value) {
  if (!isRecord(value)) return null;
  const turnId = safeBrokerTurnId(value.turnId);
  const subscription = projectBrokerHistorySubscription(value.subscription);
  return turnId && subscription && value.state === "committed" ? { turnId, subscription, state: "committed" } : null;
}

function projectBrokerSharedHistory(value) {
  if (!isRecord(value)) return null;
  const conversationId = safeBrokerConversationId(value.conversationId);
  const availability = ["complete", "partial", "incomplete", "ambiguous"].includes(value.availability)
    ? value.availability : null;
  const segments = Array.isArray(value.segments) ? value.segments.map(projectBrokerHistorySegment) : null;
  const updatedAt = safeBrokerTimestamp(value.updatedAt);
  if (!conversationId || !availability || !segments || segments.some((segment) => segment === null)
    || typeof value.peerBusy !== "boolean" || !updatedAt) return null;
  const segmentIds = new Set(segments.map((segment) => segment.segmentId));
  if (segmentIds.size !== segments.length) return null;
  const activeClient = value.activeClient === null ? null : projectBrokerActiveClient(value.activeClient);
  if (value.activeClient !== null && activeClient === null) return null;
  return {
    conversationId,
    availability,
    ...(value.historyWarning === null || ["content_gap", "ambiguous"].includes(value.historyWarning) ? { historyWarning: value.historyWarning } : {}),
    segments,
    activeClient,
    peerBusy: value.peerBusy && activeClient !== null,
    updatedAt,
  };
}

function projectBrokerContinuation(value) {
  if (!isRecord(value)) return null;
  const confirmationId = safeBrokerConfirmationId(value.confirmationId);
  if (!confirmationId) return null;
  const conversationId = safeBrokerConversationId(value.conversationId);
  const fromSubscription = projectBrokerHistorySubscription(value.fromSubscription);
  const toSubscription = projectBrokerHistorySubscription(value.toSubscription);
  const kind = value.kind === "subscription_switch" ? value.kind : null;
  if (kind && (!conversationId || !fromSubscription || !toSubscription)) return null;
  return {
    confirmationId,
    state: ["pending", "confirmed", "cancelled", "expired"].includes(value.state) ? value.state : "pending",
    expiresAt: safeBrokerTimestamp(value.expiresAt),
    ...(kind ? { kind, conversationId, fromSubscription, toSubscription } : {}),
  };
}

function projectBrokerBalance(value) {
  if (!isRecord(value) || !["balanced_tokens_v1", "quota_aware_v2", "manual"].includes(value.policy)
    || !Array.isArray(value.accounts) || ![null, "account_unavailable", "usage_unknown", "requires_two_accounts"].includes(value.degradedReason)
    || !(value.baselineAt === null || safeBrokerTimestamp(value.baselineAt))) return null;
  const seen = new Set();
  const accounts = [];
  for (const row of value.accounts) {
    const accountId = safeBrokerAccountId(row?.accountId);
    if (!accountId || seen.has(accountId) || !Number.isSafeInteger(row.completedTokens) || row.completedTokens < 0
      || !Number.isSafeInteger(row.unreportedTokens) || row.unreportedTokens < 0
      || !Number.isSafeInteger(row.reservedTokens) || row.reservedTokens < 0
      || !(row.sharePercent === null || Number.isFinite(row.sharePercent) && row.sharePercent >= 0 && row.sharePercent <= 100)
      || !["exact", "partial", "unknown"].includes(row.precision)) return null;
    seen.add(accountId);
    accounts.push({ accountId, completedTokens: row.completedTokens, reservedTokens: row.reservedTokens, unreportedTokens: row.unreportedTokens,
      sharePercent: row.sharePercent, precision: row.precision });
  }
  const nextAccountId = value.nextAccountId === null ? null : safeBrokerAccountId(value.nextAccountId);
  if (value.nextAccountId !== null && (!nextAccountId || !seen.has(nextAccountId))) return null;
  return { policy: value.policy, baselineAt: safeBrokerTimestamp(value.baselineAt), accounts, nextAccountId, degradedReason: value.degradedReason };
}

function projectBrokerPreferences(value) {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !["failoverMode", "unifiedCatalogEnabled"].includes(key))) return null;
  const failoverMode = ["automatic", "ask"].includes(value.failoverMode) ? value.failoverMode : null;
  if (!failoverMode || typeof value.unifiedCatalogEnabled !== "boolean") return null;
  return { failoverMode, unifiedCatalogEnabled: value.unifiedCatalogEnabled };
}

function projectBrokerEmail(value) {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !["accountId", "email"].includes(key))) return null;
  const accountId = safeBrokerAccountId(value.accountId);
  const email = safeEmail(value.email);
  return accountId && email ? { accountId, email } : null;
}

function projectBrokerRemotePairing(value) {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const code = typeof value.code === "string" && /^[A-Za-z0-9-]{4,64}$/.test(value.code) ? value.code : null;
  if (!code) return undefined;
  if (value.expiresAt === null) return { code, expiresAt: null };
  const expiresAt = safeBrokerTimestamp(value.expiresAt);
  return expiresAt ? { code, expiresAt } : undefined;
}

function projectBrokerRemoteDevice(value) {
  if (!isRecord(value)) return null;
  const deviceId = safeBrokerDeviceId(value.deviceId);
  const label = safeAccountLabel(value.label, "");
  return deviceId && label && label.length <= 128 ? { deviceId, label } : null;
}

function projectBrokerRemote(value) {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !["accountId", "enabled", "state", "pairing", "devices"].includes(key))) return null;
  const accountId = safeBrokerAccountId(value.accountId);
  const state = ["disabled", "ready", "pairing", "mfa_required", "unavailable"].includes(value.state) ? value.state : null;
  const pairing = projectBrokerRemotePairing(value.pairing);
  const devices = Array.isArray(value.devices) ? value.devices.map(projectBrokerRemoteDevice) : null;
  if (!accountId || typeof value.enabled !== "boolean" || !state || pairing === undefined
    || !devices || devices.length > ACCOUNT_BROKER_MAX_REMOTE_DEVICES || devices.some((device) => device === null)) return null;
  const seen = new Set(devices.map((device) => device.deviceId));
  if (seen.size !== devices.length) return null;
  return { accountId, enabled: value.enabled, state, pairing, devices };
}

function safeProfileStatisticCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

function safeProfileStatisticPercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function safeProfileStatisticDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function projectProfileActivityBucket(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "startDate" && key !== "tokens")) return null;
  const startDate = safeProfileStatisticDate(value.startDate);
  const tokens = safeProfileStatisticCounter(value.tokens);
  return startDate && tokens !== null ? { startDate, tokens } : null;
}

function safeProfileActivityText(value, maxLength = 80) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  // The broker supplies presentation labels, never identifiers. Keep this DOM
  // sink equally strict so a malformed cache cannot turn a provider handle or
  // URL into visible activity text.
  if (!normalized || normalized.length > maxLength || /[@/\\\\]/.test(normalized) || !validLabel(normalized)) return null;
  return normalized;
}

function projectProfileTopInvocation(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["type", "label", "usageCount"].includes(key))) return null;
  const type = safeProfileActivityText(value.type, 32);
  const label = safeProfileActivityText(value.label, 80);
  const usageCount = safeProfileStatisticCounter(value.usageCount);
  return type && label && usageCount !== null ? { type, label, usageCount } : null;
}

function projectProfileSafeStats(value) {
  if (!isRecord(value)) return null;
  const keys = [
    "lifetimeTokens", "peakDailyTokens", "currentStreakDays", "longestStreakDays",
    "totalThreads", "longestRunningTurnSec", "fastModeUsagePercentage", "totalSkillsUsed",
    "uniqueSkillsUsed", "mostUsedReasoningEffort", "mostUsedReasoningEffortPercentage",
    "dailyUsageBuckets", "cumulativeDailyUsageBuckets", "weeklyUsageBuckets", "topInvocations",
  ];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) return null;
  const counters = ["lifetimeTokens", "peakDailyTokens", "currentStreakDays", "longestStreakDays", "totalThreads", "longestRunningTurnSec", "totalSkillsUsed", "uniqueSkillsUsed"];
  const projectedCounters = {};
  for (const key of counters) {
    const counter = safeProfileStatisticCounter(value[key]);
    if (counter === null) return null;
    projectedCounters[key] = counter;
  }
  const fastModeUsagePercentage = safeProfileStatisticPercentage(value.fastModeUsagePercentage);
  const mostUsedReasoningEffortPercentage = safeProfileStatisticPercentage(value.mostUsedReasoningEffortPercentage);
  const mostUsedReasoningEffort = value.mostUsedReasoningEffort === null
    ? null : ACCOUNT_BROKER_REASONING_EFFORTS.has(value.mostUsedReasoningEffort) ? value.mostUsedReasoningEffort : null;
  if (fastModeUsagePercentage === null || mostUsedReasoningEffortPercentage === null
    || (value.mostUsedReasoningEffort !== null && mostUsedReasoningEffort === null)) return null;
  const projectBuckets = (buckets) => Array.isArray(buckets) && buckets.length <= ACCOUNT_BROKER_MAX_PROFILE_ACTIVITY_BUCKETS
    ? buckets.map(projectProfileActivityBucket) : null;
  const dailyUsageBuckets = projectBuckets(value.dailyUsageBuckets);
  const cumulativeDailyUsageBuckets = projectBuckets(value.cumulativeDailyUsageBuckets);
  const weeklyUsageBuckets = projectBuckets(value.weeklyUsageBuckets);
  const topInvocations = Array.isArray(value.topInvocations) && value.topInvocations.length <= ACCOUNT_BROKER_MAX_PROFILE_TOP_INVOCATIONS
    ? value.topInvocations.map(projectProfileTopInvocation) : null;
  if (!dailyUsageBuckets || !cumulativeDailyUsageBuckets || !weeklyUsageBuckets || !topInvocations
    || dailyUsageBuckets.some((bucket) => bucket === null)
    || cumulativeDailyUsageBuckets.some((bucket) => bucket === null)
    || weeklyUsageBuckets.some((bucket) => bucket === null)
    || topInvocations.some((entry) => entry === null)) return null;
  return {
    ...projectedCounters,
    fastModeUsagePercentage,
    mostUsedReasoningEffort,
    mostUsedReasoningEffortPercentage,
    dailyUsageBuckets,
    cumulativeDailyUsageBuckets,
    weeklyUsageBuckets,
    topInvocations,
  };
}

function projectProfileStatisticsAccount(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["accountId", "state", "stats"].includes(key))) return null;
  const accountId = safeBrokerAccountId(value.accountId);
  const state = value.state === "ready" || value.state === "unavailable" ? value.state : null;
  const stats = value.stats === null ? null : projectProfileSafeStats(value.stats);
  return accountId && state && (value.stats === null || stats) ? { accountId, state, stats } : null;
}

function projectProfileStatistics(value) {
  if (!isRecord(value)) return null;
  const keys = ["selection", "partial", "accounts", "stats", "observedAt"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) return null;
  const selection = value.selection === "pooled" ? "pooled" : safeBrokerAccountId(value.selection);
  const accounts = Array.isArray(value.accounts) ? value.accounts.map(projectProfileStatisticsAccount) : null;
  const stats = value.stats === null ? null : projectProfileSafeStats(value.stats);
  const observedAt = Number.isSafeInteger(value.observedAt) && value.observedAt >= 0 ? value.observedAt : null;
  if (!selection || !accounts || accounts.some((account) => account === null) || !stats && value.stats !== null
    || observedAt === null || typeof value.partial !== "boolean") return null;
  const accountIds = new Set(accounts.map((account) => account.accountId));
  if (accountIds.size !== accounts.length || (selection !== "pooled" && !accountIds.has(selection))) return null;
  return { selection, partial: value.partial, accounts, stats, observedAt };
}

function projectAccountBrokerResult(command, value) {
  if (command === "balance.read" || command === "balance.set") return isSerializedValueWithinBound(value) ? projectBrokerBalance(value) : null;
  if (!isRecord(value)) return value === undefined || value === null ? {} : null;
  if (!isSerializedValueWithinBound(value, command === "native.request" ? ACCOUNT_NATIVE_RESULT_MAX_BYTES : ACCOUNT_SERIALIZED_VALUE_MAX_BYTES)) return null;
  const source = isRecord(value.profile) ? value.profile : value;
  if (command === "profile.read") {
    if (!Array.isArray(source.accounts)) return null;
    const accounts = source.accounts.map(projectBrokerAccount);
    if (accounts.some((account) => account === null)) return null;
    const ids = new Set(accounts.map((account) => account.accountId));
    if (ids.size !== accounts.length) return null;
    const selectedAccountId = safeBrokerAccountId(source.selectedAccountId);
    return {
      accounts,
      selectedAccountId: selectedAccountId && ids.has(selectedAccountId) ? selectedAccountId : null,
    };
  }
  if (command === "profile.statistics") return projectProfileStatistics(value);
  if (command === "native.request") {
    const accountId = safeBrokerAccountId(value.accountId);
    const surface = safeConnectionSurface(value.surface);
    return accountId && surface && Object.prototype.hasOwnProperty.call(value, "result")
      && isSerializedValueWithinBound(value.result, ACCOUNT_NATIVE_RESULT_MAX_BYTES)
      ? { accountId, surface, result: value.result } : null;
  }
  if (["preferences.read", "preferences.update"].includes(command)) return projectBrokerPreferences(value);
  if (command === "profile.email") return projectBrokerEmail(value);
  if (["remote.status", "remote.enable", "remote.disable", "remote.pairing.start", "remote.pairing.status", "remote.pairing.close", "remote.devices.list", "remote.devices.revoke"].includes(command)) {
    return projectBrokerRemote(value);
  }
  if (command === "quota.read") {
    if (Array.isArray(value.accounts)) {
      const accounts = value.accounts.map((entry) => {
        const accountId = safeBrokerAccountId(entry?.accountId);
        const quota = projectBrokerQuota(entry?.quota);
        return accountId && quota ? { accountId, quota } : null;
      });
      const accountIds = new Set(accounts.map((entry) => entry?.accountId));
      return accounts.some((entry) => entry === null) || accountIds.size !== accounts.length || typeof value.partial !== "boolean"
        ? null : { accounts, partial: value.partial };
    }
    const accountId = safeBrokerAccountId(value.accountId);
    const quota = projectBrokerQuota(value.quota || value);
    return quota ? { ...(accountId ? { accountId } : {}), quota } : null;
  }
  if (command === "history.read") {
    // An empty v3 canonical store is a successful current-state answer. Keep
    // it distinct from a failed/malformed response so a prior subscription's
    // conversation cannot remain rendered as if it were still current.
    const historyValue = Object.prototype.hasOwnProperty.call(value, "conversation")
      ? value.conversation
      : value.history || value.sharedHistory || value;
    const turns = Array.isArray(value.turns) ? value.turns.map(projectBrokerTurnAttribution) : [];
    if (turns.some((turn) => turn === null)) return null;
    if (historyValue === null) return turns.length === 0 ? { conversation: null, turns: [] } : null;
    const history = projectBrokerSharedHistory(historyValue);
    if (!history) return null;
    const turnIds = new Set(turns.map((turn) => turn.turnId));
    return turnIds.size === turns.length ? { conversation: history, turns } : null;
  }
  if (["connection.list", "connection.status", "connection.authorize"].includes(command)) {
    const accountId = safeBrokerAccountId(value.accountId);
    const candidates = Array.isArray(value.connections)
      ? value.connections
      : value.connection ? [value.connection] : [];
    if (!accountId || candidates.length > ACCOUNT_BROKER_MAX_CONNECTIONS) return null;
    const connections = candidates.map(projectBrokerConnection);
    if (connections.some((connection) => connection === null)) return null;
    return { accountId, connections };
  }
  if (["enrollment.start", "enrollment.status", "enrollment.cancel", "reconnect.start", "reconnect.status", "reconnect.cancel"].includes(command)) {
    const enrollment = projectBrokerEnrollment(value.enrollment || value);
    return enrollment ? { enrollment } : null;
  }
  if (["profile.update", "enabled.set"].includes(command)) {
    const account = projectBrokerAccount(value.account || value);
    if (!account) return null;
    const lifecycle = ["no_new_work", "active_runs_finishing", "idle_child_stopped", "lazy"].includes(value.lifecycle)
      ? value.lifecycle : null;
    return { account, ...(lifecycle ? { lifecycle } : {}) };
  }
  if (command === "resetCredit.consume") {
    const accountId = safeBrokerAccountId(value.accountId);
    const quota = projectBrokerQuota(value.quota || value);
    const continuation = projectBrokerContinuation(value.continuation);
    if (!accountId) return null;
    return { accountId, consumed: value.consumed === true, ...(quota ? { quota } : {}), ...(continuation ? { continuation } : {}) };
  }
  if (["handoff.confirm", "handoff.cancel"].includes(command)) {
    const continuation = projectBrokerContinuation(value.continuation || value);
    return continuation ? { continuation } : null;
  }
  if (["events.subscribe", "events.unsubscribe"].includes(command)) return {};
  return null;
}

function projectAccountBrokerEvent(event) {
  if (!isRecord(event) || event.version !== ACCOUNT_BROKER_VERSION
    || !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > Number.MAX_SAFE_INTEGER
    || !ACCOUNT_BROKER_EVENT_TYPES.has(event.type)
    || !isSerializedValueWithinBound(event)) return null;
  if (ACCOUNT_BROKER_SHARED_HISTORY_INVALIDATION_TYPES.has(event.type)
    && event.payload !== undefined && !isRecord(event.payload)) return null;
  const payload = isRecord(event.payload) ? event.payload : {};
  let projected;
  if (event.type === "profile.updated") projected = projectAccountBrokerResult("profile.read", payload);
  else if (event.type === "quota.updated") projected = projectAccountBrokerResult("quota.read", payload);
  else if (["connection.updated"].includes(event.type)) projected = projectAccountBrokerResult("connection.status", payload);
  else if (["enrollment.updated", "reconnect.updated"].includes(event.type)) projected = projectAccountBrokerResult("enrollment.status", payload);
  else if (["continuation.pending", "continuation.resolved", "handoff.updated"].includes(event.type)) {
    const continuation = projectBrokerContinuation(payload.continuation || payload);
    projected = continuation ? { continuation } : null;
  } else if (ACCOUNT_BROKER_SHARED_HISTORY_INVALIDATION_TYPES.has(event.type)) {
    // Events intentionally contain no transcript or authoritative turn data.
    // Treat every accepted signal as an invalidation and fetch the canonical
    // redacted projection before updating either app's conversation metadata.
    projected = {};
  } else if (event.type === "enabled.changed") {
    const account = projectBrokerAccount(payload.account || payload);
    const lifecycle = ["no_new_work", "active_runs_finishing", "idle_child_stopped", "lazy"].includes(payload.lifecycle)
      ? payload.lifecycle : null;
    projected = account ? { account, ...(lifecycle ? { lifecycle } : {}) } : null;
  } else if (event.type === "resetCredit.updated") {
    const accountId = safeBrokerAccountId(payload.accountId);
    const quota = projectBrokerQuota(payload.quota || payload);
    projected = accountId && quota ? { accountId, quota } : null;
  }
  if (projected === null) return null;
  const result = { version: ACCOUNT_BROKER_VERSION, sequence: event.sequence, type: event.type, payload: projected };
  return isSerializedValueWithinBound(result) ? result : null;
}

function createAccountService(api, options = {}) {
  const deps = options.deps || nodeDeps();
  const paths = options.paths || authPaths(deps);
  const authorityMode = normalizeAccountAuthorityMode(options.authorityMode);
  const legacyAuthority = authorityMode === "legacy";
  // The runtime reads its launch config from this existing tweak data
  // namespace. Main-process APIs expose its real absolute path; tests and
  // older hosts use the same deterministic user-root fallback.
  if (typeof paths.routerDataDir !== "string") {
    paths.routerDataDir = options.routerDataDir || api?.fs?.dataDir
      || deps.path.join(deps.homedir(), "tweak-data", "co.tweakers.account-switcher");
  }
  const intents = new Map();
  const refs = new Map();
  const enrollments = new Map();
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
      if (message?.action === ACCOUNT_AUTHORITY_STATUS_ACTION) {
        return Promise.resolve({ ok: true, authorityMode });
      }
      // This fixed browser action writes no account state and is shared by
      // broker and legacy enrollment. Renderer input never selects its URL.
      if (message?.action === "open-device-sign-in") {
        if (Object.keys(message).length !== 1) return Promise.resolve(safeFailure("invalid-request"));
        return openDeviceSignInExternally(deps);
      }
      // This is the sole legacy-writer guard. It is deliberately before every
      // local profile/auth/config/enrollment action, so renderer-provided mode
      // fields cannot make a configured global broker fall back to local state.
      if (!legacyAuthority) return Promise.resolve(accountAuthorityUnavailable());
      if (message?.action === "list") return service.list();
      if (message?.action === "plugin-protection-status") return service.pluginProtectionStatus();
      if (message?.action === "plugin-protection-verify-current") return service.verifyCurrentPlugins();
      if (message?.action === "plugin-protection-configure") return service.configurePluginProtection(message);
      if (message?.action === "account-username-set") return service.setAccountUsername(message);
      if (message?.action === "account-profile-set") return service.setAccountProfile(message);
      if (message?.action === "account-enroll-start") return service.startEnrollment(message);
      if (message?.action === "account-enroll-status") return service.enrollmentStatus(message);
      if (message?.action === "account-enroll-cancel") return service.cancelEnrollment(message);
      if (message?.action === "account-reset-consume") return service.consumeResetCredit(message);
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
    async list() {
      const [protection, usernames, profiles] = await Promise.all([
        pluginProtectionSnapshot(api, deps, paths),
        readAccountUsernames(api),
        readAccountProfiles(api),
      ]);
      return listAccounts(deps, paths, refs, protection, usernames, profiles);
    },
    async pluginProtectionStatus() {
      const protection = await pluginProtectionSnapshot(api, deps, paths);
      return { ok: true, pluginProtection: publicPluginProtection(protection) };
    },
    // Verification may invoke Codex's reconciliation endpoint. Serialize it
    // with auth-changing operations, then re-check active auth immediately
    // before receipt persistence so a receipt can never be written for the
    // account that was active only when the probe began.
    verifyCurrentPlugins() { return enqueue(() => verifyCurrentPluginReceipt(api, deps, paths, options)); },
    configurePluginProtection(message) { return enqueue(() => configurePluginProtection(api, message)); },
    setAccountUsername(message) { return enqueue(() => updateAccountUsername(api, deps, paths, refs, message)); },
    setAccountProfile(message) { return enqueue(() => updateAccountProfile(api, deps, paths, refs, message)); },
    startEnrollment(message) { return enqueue(() => startAccountEnrollment(api, deps, paths, enrollments, message)); },
    enrollmentStatus(message) { return Promise.resolve(accountEnrollmentStatus(enrollments, message)); },
    cancelEnrollment(message) { return enqueue(() => cancelAccountEnrollment(enrollments, message)); },
    consumeResetCredit(message) { return enqueue(() => consumeAccountResetCredit(api, deps, paths, refs, message)); },
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
    dispose() {
      disposed = true; stopSnapshotSync(); intents.clear(); refs.clear();
      for (const enrollment of enrollments.values()) { try { enrollment.child?.kill?.("SIGTERM"); } catch {} }
      enrollments.clear();
    },
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
  // Auth snapshot reconciliation writes local state; it belongs only to the
  // proven legacy mode and must not even start in global-v3 or blocked mode.
  const stopSnapshotSync = legacyAuthority
    ? startActiveSnapshotSync(deps, paths, api, () => disposed, enqueue)
    : () => {};
  return service;
}

function normalizeAccountAuthorityMode(value) {
  return ACCOUNT_AUTHORITY_MODES.has(value) ? value : "blocked";
}

function accountAuthorityModeFromRuntime(api) {
  try {
    const authorityMode = api?.codex?.accounts?.authorityMode;
    return typeof authorityMode === "function"
      ? normalizeAccountAuthorityMode(authorityMode())
      : "blocked";
  } catch {
    return "blocked";
  }
}

function accountAuthorityUnavailable() {
  return safeFailure(ACCOUNT_AUTHORITY_UNAVAILABLE);
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

async function readAccountUsernames(api) {
  try {
    const stored = await api?.storage?.get?.(ACCOUNT_USERNAMES_KEY);
    if (!isRecord(stored) || !isSerializedValueWithinBound(stored)) return {};
    const usernames = {};
    for (const [ref, value] of Object.entries(stored)) {
      if (!/^[a-f0-9]{32}$/.test(ref)) continue;
      if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["binding", "username"].join("\0")) continue;
      const username = safeUsername(value.username);
      if (username && /^sha256:[a-f0-9]{64}$/.test(value.binding)) {
        usernames[ref] = { username, binding: value.binding };
      }
    }
    return usernames;
  } catch {
    return {};
  }
}

async function readAccountProfiles(api) {
  try {
    const stored = await api?.storage?.get?.(ACCOUNT_PROFILES_KEY);
    if (!isRecord(stored) || !isSerializedValueWithinBound(stored)
      || stored.schemaVersion !== 3 || !isRecord(stored.accounts)) return {};
    const profiles = {};
    for (const [ref, value] of Object.entries(stored.accounts)) {
      if (!/^[a-f0-9]{32}$/.test(ref) || !isRecord(value)) continue;
      const label = safeAccountLabel(value.label, "");
      if (!label || typeof value.enabled !== "boolean" || !/^sha256:[a-f0-9]{64}$/.test(value.binding)) continue;
      profiles[ref] = {
        label,
        enabled: value.enabled,
        binding: value.binding,
        connections: {
          apps: safeConnectionState(value.connections?.apps),
          plugins: safeConnectionState(value.connections?.plugins),
          mcp: safeConnectionState(value.connections?.mcp),
        },
      };
    }
    return profiles;
  } catch { return {}; }
}

function safeConnectionState(value) {
  return ["connected", "setup_required", "expired", "unavailable"].includes(value) ? value : "setup_required";
}

function accountUsernameBinding(rawAccountId) {
  if (typeof rawAccountId !== "string" || !rawAccountId || rawAccountId.length > 1024) return "";
  const { createHash } = require("node:crypto");
  return `sha256:${createHash("sha256").update(`account-username:v1:${rawAccountId}`, "utf8").digest("hex")}`;
}

function storedAccountUsername(record, rawAccountId) {
  const binding = accountUsernameBinding(rawAccountId);
  return binding && record?.binding === binding ? safeUsername(record.username) : "";
}

async function updateAccountUsername(api, deps, paths, refs, message) {
  try {
    const ref = typeof message?.ref === "string" ? message.ref : "";
    const filename = refs.get(ref);
    if (!filename) throw coded("unknown-reference");
    const requested = typeof message?.username === "string" ? message.username.trim() : null;
    if (requested === null) throw coded("invalid-account-username");
    const username = requested === "" ? "" : safeUsername(requested);
    if (requested !== "" && !username) throw coded("invalid-account-username");
    const rawAccountId = withSecureAuth(
      deps.fs,
      sourceFilePath(deps.path, paths.accountsDir, filename),
      (snapshot) => authAccountId(snapshot.value),
    );
    const binding = accountUsernameBinding(rawAccountId);
    if (!binding) throw coded("invalid-account-identity");
    const usernames = await readAccountUsernames(api);
    if (username) usernames[ref] = { username, binding };
    else delete usernames[ref];
    if (typeof api?.storage?.set !== "function") throw coded("account-username-unavailable");
    await api.storage.set(ACCOUNT_USERNAMES_KEY, usernames);
    await api.storage.flush?.();
    return { ok: true, username: username || null };
  } catch (error) {
    return safeFailure(errorCode(error));
  }
}

async function updateAccountProfile(api, deps, paths, refs, message) {
  try {
    const ref = typeof message?.ref === "string" ? message.ref : "";
    const filename = refs.get(ref);
    if (!filename) throw coded("unknown-reference");
    const rawAccountId = withSecureAuth(
      deps.fs,
      sourceFilePath(deps.path, paths.accountsDir, filename),
      (snapshot) => authAccountId(snapshot.value),
    );
    const binding = accountUsernameBinding(rawAccountId);
    if (!binding) throw coded("invalid-account-identity");
    const profiles = await readAccountProfiles(api);
    const current = profiles[ref] || { label: "Saved account", enabled: true, binding, connections: {} };
    if (current.binding && current.binding !== binding) throw coded("invalid-account-identity");
    const label = message.label === undefined ? current.label : safeAccountLabel(message.label, "");
    const enabled = message.enabled === undefined ? current.enabled : message.enabled;
    if (!label || typeof enabled !== "boolean") throw coded("invalid-request");
    profiles[ref] = {
      label,
      enabled,
      binding,
      connections: {
        apps: safeConnectionState(current.connections?.apps),
        plugins: safeConnectionState(current.connections?.plugins),
        mcp: safeConnectionState(current.connections?.mcp),
      },
    };
    if (!Object.values(profiles).some((profile) => profile.enabled)) throw coded("invalid-router-enabled-accounts");
    if (typeof api?.storage?.set !== "function") throw coded("unavailable");
    await api.storage.set(ACCOUNT_PROFILES_KEY, { schemaVersion: 3, accounts: profiles });
    await api.storage.flush?.();
    return redact({ ok: true, profile: profiles[ref] });
  } catch (error) { return safeFailure(errorCode(error)); }
}

function listAccounts(deps, paths, refs, protection = null, usernames = {}, profiles = {}) {
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
    const accountRecords = [];
    let entryNames = [];
    if (accountsDirectoryExists) {
      const entries = deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name));
      entryNames = entries.map((entry) => entry.name);
      const labels = savedSnapshotLabels(entries);
      const identities = displaySnapshotIdentities(deps, paths, entries);
      for (const entry of entries) {
        const name = entry.name.slice(0, -5);
        try {
          validateReferenceName(name);
          // Stable, deterministic ref for a filename. The renderer re-lists on
          // every DOM mutation; with random UUIDs a re-list invalidated the refs
          // already rendered on the buttons, so Switch failed with
          // "unknown-reference". A filename-derived hash stays valid across lists.
          const opaque = stableRef(entry.name);
          const projectedIdentity = identities.get(entry.name) || {};
          const record = withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, entry.name), (auth) => {
            const rawAccountId = authAccountId(auth.value);
            const profile = profiles?.[opaque];
            const profileMatches = profile?.binding === accountUsernameBinding(rawAccountId);
            return {
              filename: entry.name,
              rawAccountId,
              snapshotIdentity: auth.identity,
              snapshotHash: auth.hash,
              account: {
                ref: opaque,
                // This is the renderer boundary. Only explicit identity fields
                // cross it: a safe display name, account email, and optional
                // local username. Provider ids, tokens, paths, and filenames do not.
                label: labels.get(entry.name) || safeSnapshotLabel(auth.value, entry.name, 1),
                displayLabel: profileMatches ? profile.label : (projectedIdentity.displayLabel || labels.get(entry.name) || "Saved account"),
                email: projectedIdentity.email || null,
                username: storedAccountUsername(usernames?.[opaque], rawAccountId) || null,
                identifierMasked: maskIdentifier(),
                active: false,
                enabled: profileMatches ? profile.enabled : true,
                connections: profileMatches ? profile.connections : { apps: "setup_required", plugins: "setup_required", mcp: "setup_required" },
                pluginProtection: publicReceiptStatus(
                  evaluatePluginReceipt(
                    protection?.receipts?.[rawAccountId],
                    protection?.profile,
                    rawAccountId,
                    protection?.runtimeBinding,
                    deps.now(),
                  ),
                ),
              },
            };
          });
          refs.set(opaque, entry.name);
          accountRecords.push(record);
          accounts.push(record.account);
        } catch {}
      }
    }
    let proofStable = false;
    let finalCurrent = current;
    try {
      finalCurrent = readCurrentMarker(deps.fs, paths.currentMarker);
      const finalLiveAccountId = withSecureAuth(deps.fs, paths.authFile, (live) => authAccountId(live.value));
      const finalEntryNames = accountsDirectoryExists
        ? deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right))
        : [];
      const snapshotsStable = entryNames.length === finalEntryNames.length
        && entryNames.every((name, index) => name === finalEntryNames[index])
        && accountRecords.every((record) => {
          const observed = readSnapshotMetadata(deps, paths, record.filename);
          return observed.accountId === record.rawAccountId
            && observed.identity === record.snapshotIdentity
            && observed.hash === record.snapshotHash;
        });
      proofStable = sameMarker(current, finalCurrent)
        && liveAccountId === finalLiveAccountId
        && snapshotsStable;
    } catch {
      proofStable = false;
    }
    const liveMatches = liveAccountId
      ? accountRecords.filter((record) => record.rawAccountId === liveAccountId)
      : [];
    // Claim one current account only when the marker, live identity, and unique
    // saved snapshot all agree. Duplicate or stale snapshots fail closed.
    if (proofStable && current.status === "ok" && current.value && liveMatches.length === 1
      && liveMatches[0].filename === current.value) {
      liveMatches[0].account.active = true;
    }
    accounts.sort((a, b) => a.label.localeCompare(b.label));
    const markerStatus = !proofStable
      ? "identity-mismatch"
      : finalCurrent.value && !accounts.some((item) => item.active)
        ? (accounts.some((item) => refs.get(item.ref) === finalCurrent.value) ? "identity-mismatch" : "dangling-reference")
        : finalCurrent.status;
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
      return { ok: true, intent, confirmation: "Switch to this saved account? Codex will restart to finish." };
    } else {
      target = validateReferenceName(rawValue);
      if (deps.fs.existsSync(sourcePath(deps.path, paths.accountsDir, target))) throw coded("account-exists");
      withSecureAuth(deps.fs, paths.authFile, () => undefined);
    }
    pruneIntents(intents, deps.now());
    const intent = deps.randomUUID();
    intents.set(intent, { action, target, expiresAt: deps.now() + INTENT_TTL_MS });
    return { ok: true, intent, confirmation: action === "switch" ? "Switch to this saved account? Codex will restart to finish." : "Save the account in use now under this name?" };
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
        error: { code: "plugin-protection-receipt-required", message: "This account must pass the plugin check before switching." },
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
        ? "Switch once without a current plugin check? This approval applies only to this switch."
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
      error: { code: "plugin-protection-receipt-required", message: "This account must pass the plugin check before switching." },
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

async function startAccountEnrollment(api, deps, paths, enrollments, message) {
  try {
    if (enrollments.size >= 4) throw coded("unavailable");
    const binding = await runtimeCodexBinding(api, deps);
    if (!validRuntimeBinding(binding) || typeof deps.spawn !== "function") throw coded("unavailable");
    const id = deps.randomUUID();
    const root = deps.path.join(paths.routerDataDir, "enrollments", id);
    const codexHome = deps.path.join(root, "codex-home");
    const sqliteHome = deps.path.join(root, "sqlite-home");
    for (const directory of [deps.path.dirname(root), root, codexHome, sqliteHome]) {
      deps.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      deps.fs.chmodSync(directory, 0o700);
    }
    const job = {
      id, root, codexHome, sqliteHome, child: null, state: "starting", userCode: null,
      verificationUrl: null, expiresAt: null, loginId: null, savedRef: null, error: null, output: "", nextId: 2,
    };
    enrollments.set(id, job);
    const environment = isolatedEnrollmentEnvironment(codexHome, sqliteHome);
    const child = deps.spawn(binding.executable, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true, env: environment,
    });
    job.child = child;
    const send = (payload) => child.stdin?.write?.(`${JSON.stringify(payload)}\n`);
    const fail = () => {
      if (["complete", "cancelled"].includes(job.state)) return;
      job.state = "failed"; job.error = "login_unavailable"; job.loginId = null;
      try { child.kill?.("SIGTERM"); } catch {}
    };
    const timer = setTimeout(fail, 15 * 60_000);
    timer.unref?.();
    child.on?.("error", fail);
    child.on?.("exit", () => { if (!['complete', 'cancelled'].includes(job.state)) fail(); });
    child.stdout?.on?.("data", (chunk) => {
      job.output += String(chunk);
      if (Buffer.byteLength(job.output, "utf8") > PLUGIN_PROBE_MAX_OUTPUT_BYTES) return fail();
      const lines = job.output.split("\n");
      job.output = lines.pop() || "";
      for (const line of lines) {
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response?.id === 1 && response?.result) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } });
        } else if (response?.id === 2 && response?.result) {
          const projected = projectDeviceLogin(response.result, deps.now());
          if (!projected) return fail();
          Object.assign(job, projected, { state: "waiting" });
        } else if (response?.id === 2 && response?.error) {
          fail();
        } else if (response?.method === "account/login/completed") {
          setTimeout(() => finalizeAccountEnrollment(api, deps, paths, job), 100);
        }
      }
    });
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "tweakers-accounts", version: "0.5.0" }, capabilities: { experimentalApi: true } },
    });
    return { ok: true, enrollment: publicEnrollment(job) };
  } catch (error) { return safeFailure(errorCode(error)); }
}

function isolatedEnrollmentEnvironment(codexHome, sqliteHome) {
  const env = { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    if (typeof process?.env?.[key] === "string") env[key] = process.env[key];
  }
  return env;
}

function projectDeviceLogin(result, now) {
  if (!isRecord(result)) return null;
  const loginId = safeProviderLoginId(result.loginId);
  const userCode = [result.userCode, result.user_code, result.code].find((value) => typeof value === "string" && /^[A-Z0-9-]{4,32}$/i.test(value));
  const rawUrl = [result.verificationUrl, result.verificationUri, result.verification_url, result.authUrl].find((value) => typeof value === "string");
  let verificationUrl = null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "https:" && /(^|\.)(openai\.com|chatgpt\.com)$/.test(url.hostname)) verificationUrl = url.toString();
  } catch {}
  if (!loginId || !userCode || !verificationUrl) return null;
  const expiresIn = [result.expiresIn, result.expires_in].find((value) => Number.isInteger(value) && value >= 60 && value <= 3600) || 900;
  return { loginId, userCode, verificationUrl, expiresAt: new Date(now() + expiresIn * 1000).toISOString() };
}

function finalizeAccountEnrollment(api, deps, paths, job) {
  if (!job || ["complete", "cancelled"].includes(job.state)) return;
  let snapshot;
  try {
    snapshot = readSecureAuth(deps.fs, deps.path.join(job.codexHome, "auth.json"));
    if (!authAccountId(snapshot.value)) throw coded("invalid-account-identity");
    ensureAccountsDirectory(deps.fs, paths.accountsDir, true);
    const base = validateReferenceName(`subscription-${String(deps.now()).slice(-10)}-${job.id.slice(0, 8)}`);
    const target = sourcePath(deps.path, paths.accountsDir, base);
    if (deps.fs.existsSync(target)) throw coded("account-exists");
    atomicWrite(deps, paths.accountsDir, target, snapshot.bytes);
    job.savedRef = stableRef(`${base}.json`);
    job.state = "complete";
    job.userCode = null;
    job.verificationUrl = null;
    job.expiresAt = null;
    job.loginId = null;
    try { job.child?.kill?.("SIGTERM"); } catch {}
    api.log?.info?.("A new subscription was enrolled into its isolated account home");
  } catch {
    job.state = "failed"; job.error = "enrollment_save_failed";
  } finally { clearSecretBuffer(snapshot?.bytes); }
}

function publicEnrollment(job) {
  if (!job) return null;
  return redact({
    id: job.id,
    state: job.state,
    userCode: job.userCode,
    verificationUrl: job.verificationUrl,
    expiresAt: job.expiresAt,
    savedRef: job.savedRef,
    error: job.error,
  });
}

function accountEnrollmentStatus(enrollments, message) {
  const id = typeof message?.id === "string" ? message.id : "";
  const job = enrollments.get(id);
  return job ? { ok: true, enrollment: publicEnrollment(job) } : safeFailure("invalid-request");
}

function cancelAccountEnrollment(enrollments, message) {
  const id = typeof message?.id === "string" ? message.id : "";
  const job = enrollments.get(id);
  if (!job) return safeFailure("invalid-request");
  const loginId = safeProviderLoginId(job.loginId);
  job.state = "cancelled"; job.userCode = null; job.verificationUrl = null; job.expiresAt = null;
  job.loginId = null;
  // The sealed provider contract requires the exact provider login handle.
  // Never send a legacy empty cancel payload that could target the wrong flow.
  if (loginId) {
    try { job.child?.stdin?.write?.(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "account/login/cancel", params: { loginId } })}\n`); } catch {}
  }
  try { job.child?.kill?.("SIGTERM"); } catch {}
  return { ok: true, enrollment: publicEnrollment(job) };
}

async function consumeAccountResetCredit(api, deps, paths, refs, message) {
  let secret;
  try {
    const ref = typeof message?.ref === "string" ? message.ref : "";
    const filename = refs.get(ref);
    if (!filename) throw coded("unknown-reference");
    const routerPaths = accountRouterPaths(deps, paths);
    const live = await authenticatedRouterStatus(deps, routerPaths);
    if (live.state === "active") throw coded("router-not-idle");
    secret = existingRouterSecret(deps, routerPaths);
    const opaqueId = withSecureAuth(
      deps.fs,
      sourceFilePath(deps.path, paths.accountsDir, filename),
      (snapshot) => opaqueAccountId(secret, authAccountId(snapshot.value)),
    );
    const accountHome = exactRouterChild(deps, routerPaths, opaqueId);
    const codexHome = deps.path.join(accountHome, "codex-home");
    const sqliteHome = deps.path.join(accountHome, "sqlite-home");
    hardenRouterChild(deps, routerPaths.accountsDir, accountHome, false);
    hardenRouterChild(deps, accountHome, codexHome, false);
    hardenRouterChild(deps, accountHome, sqliteHome, false);
    const binding = await runtimeCodexBinding(api, deps);
    if (!validRuntimeBinding(binding)) throw coded("unavailable");
    await accountScopedOneShot(deps, binding.executable, codexHome, sqliteHome, "account/rateLimitResetCredit/consume", {});
    return { ok: true, consumed: true };
  } catch (error) { return safeFailure(errorCode(error)); }
  finally { clearSecretBuffer(secret); }
}

function accountScopedOneShot(deps, executable, codexHome, sqliteHome, method, params) {
  return new Promise((resolve, reject) => {
    let child; let output = ""; let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { child?.kill?.("SIGTERM"); } catch {}
      if (error) reject(error); else resolve(result);
    };
    const send = (payload) => child.stdin?.write?.(`${JSON.stringify(payload)}\n`);
    const timer = setTimeout(() => finish(coded("unavailable")), PLUGIN_PROBE_TIMEOUT_MS);
    try {
      child = deps.spawn(executable, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true,
        env: isolatedEnrollmentEnvironment(codexHome, sqliteHome),
      });
      child.on?.("error", () => finish(coded("unavailable")));
      child.on?.("exit", () => { if (!settled) finish(coded("unavailable")); });
      child.stdout?.on?.("data", (chunk) => {
        output += String(chunk);
        if (Buffer.byteLength(output, "utf8") > PLUGIN_PROBE_MAX_OUTPUT_BYTES) return finish(coded("unavailable"));
        const lines = output.split("\n"); output = lines.pop() || "";
        for (const line of lines) {
          let response; try { response = JSON.parse(line); } catch { continue; }
          if (response?.id === 1 && response?.result) {
            send({ jsonrpc: "2.0", method: "initialized", params: {} });
            send({ jsonrpc: "2.0", id: 2, method, params });
          } else if (response?.id === 2 && response?.result !== undefined) finish(null, true);
          else if (response?.id === 2 && response?.error) finish(coded("unavailable"));
        }
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "tweakers-accounts", version: "0.5.0" }, capabilities: { experimentalApi: true } } });
    } catch { finish(coded("unavailable")); }
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
    || !Array.isArray(opaqueAccountIds) || opaqueAccountIds.length < 2
    || opaqueAccountIds.some((opaqueId) => !isOpaqueAccountId(opaqueId))
    || new Set(opaqueAccountIds).size !== opaqueAccountIds.length) throw coded("invalid-history-adoption-intent");
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
  const usableConfig = [ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(config?.schemaVersion)
    && Array.isArray(config.accounts) && config.accounts.length >= 1;
  if (!usableConfig) return "mismatch";
  const poolFingerprint = historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId));
  const owner = records.intent.legacyOwnerOpaqueAccountId;
  const poolMatches = records.intent.poolFingerprint === poolFingerprint;
  if ((!poolMatches && (config.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION || config.accounts.length === 2))
    || !config.accounts.some((account) => account.opaqueAccountId === owner)) {
    return "mismatch";
  }
  if (records.receipt.protocolFingerprint !== config.protocolFingerprint
    || records.receipt.poolFingerprint !== records.intent.poolFingerprint
    || records.receipt.legacyOwnerOpaqueAccountId !== owner
    || records.owners.protocolFingerprint !== config.protocolFingerprint
    || records.owners.poolFingerprint !== records.intent.poolFingerprint
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

function historyAdoptionProjection(config, records = null, state = null, refsByOpaqueId = null) {
  const includeOwnerRef = refsByOpaqueId instanceof Map;
  const required = {
    state: "required",
    ownerLabel: null,
    ...(includeOwnerRef ? { ownerRef: null } : {}),
    importedThreadCount: 0,
    databaseCount: 0,
    historyCount: 0,
  };
  const source = records || {
    intent: null, receipt: null, owners: null, intentInvalid: false, receiptInvalid: false, ownersInvalid: false,
  };
  const completed = completedHistoryAdoptionState(config, state, source);
  if (completed === "invalid" || completed === "mismatch") return { ...required, state: completed };
  const usableConfig = [ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(config?.schemaVersion)
    && Array.isArray(config.accounts) && config.accounts.length >= 1;
  if (completed === "adopted") {
    const ownerOpaqueId = source.receipt.legacyOwnerOpaqueAccountId;
    const ownerLabel = historyOwnerLabel(config, ownerOpaqueId);
    if (!ownerLabel) return { ...required, state: "mismatch" };
    return {
      state: "adopted",
      ownerLabel,
      ...(includeOwnerRef ? { ownerRef: refsByOpaqueId.get(ownerOpaqueId) || null } : {}),
      importedThreadCount: source.receipt.importedThreadCount,
      databaseCount: source.receipt.databases.filter((entry) => entry.present).length,
      historyCount: source.receipt.histories.filter((entry) => entry.present).length,
    };
  }
  if (source.intentInvalid) return { ...required, state: "invalid" };
  if (!source.intent) return required;
  if (!usableConfig) return { ...required, state: "mismatch" };
  const poolFingerprint = historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId));
  const ownerOpaqueId = source.intent.legacyOwnerOpaqueAccountId;
  const ownerLabel = historyOwnerLabel(config, ownerOpaqueId);
  if (source.intent.poolFingerprint !== poolFingerprint || source.intent.configGeneration !== config.generation
    || source.intent.configFingerprint !== config.fingerprint || !ownerLabel) return { ...required, state: "mismatch" };
  return {
    ...required,
    state: "pending_offline_adoption",
    ownerLabel,
    ...(includeOwnerRef ? { ownerRef: refsByOpaqueId.get(ownerOpaqueId) || null } : {}),
  };
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
  return [ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(existing?.schemaVersion)
    && Number.isInteger(existing.generation)
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
  if (value.schemaVersion === ACCOUNT_ROUTER_V2_SCHEMA_VERSION) return validateV2RouterConfig(value);
  if (value.schemaVersion !== ACCOUNT_ROUTER_SCHEMA_VERSION
    || Object.keys(value).length !== 9
    || !["manual", "quota_aware"].includes(value.mode)
    || (value.mode === "quota_aware" ? ![ACCOUNT_ROUTER_QUOTA_POLICY, "balanced_tokens_v1"].includes(value.policy) : value.policy !== null)
    || !Number.isInteger(value.generation) || value.generation < 1
    || !isFingerprint(value.fingerprint)
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT
    || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !Array.isArray(value.accounts) || value.accounts.length < 1
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
  const primary = value.accounts.find((account) => account.opaqueAccountId === value.primaryOpaqueAccountId);
  if (!primary?.included || (value.mode === "quota_aware" && !value.accounts.some((account) => account.included))
    || routerConfigFingerprint(value) !== value.fingerprint) throw coded("invalid-router-config");
  return value;
}

function validateV2RouterConfig(value) {
  if (Object.keys(value).length !== 9
    || !["manual", "quota_aware"].includes(value.mode)
    || (value.mode === "quota_aware" ? value.policy !== ACCOUNT_ROUTER_V2_QUOTA_POLICY : value.policy !== null)
    || !Number.isInteger(value.generation) || value.generation < 1 || !isFingerprint(value.fingerprint)
    || value.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !Array.isArray(value.accounts) || value.accounts.length !== 2 || !isCanonicalUtcIsoTimestamp(value.updatedAt)) {
    throw coded("invalid-router-config");
  }
  const seen = new Set();
  for (const account of value.accounts) {
    if (!isRecord(account) || Object.keys(account).length !== 5 || !isOpaqueAccountId(account.opaqueAccountId)
      || account.included !== true || !Number.isInteger(account.weight) || account.weight < 1 || account.weight > 100
      || !isFingerprint(account.capabilityFingerprint) || safeAccountLabel(account.label, "") !== account.label
      || seen.has(account.opaqueAccountId)) throw coded("invalid-router-config");
    seen.add(account.opaqueAccountId);
  }
  if (!seen.has(value.primaryOpaqueAccountId) || routerConfigFingerprint(value) !== value.fingerprint) throw coded("invalid-router-config");
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
  if (!routerStateIsTerminalAndIdle(state)) return false;
  const configured = new Set(config.accounts.map((account) => account.opaqueAccountId));
  const ledgerIds = Object.keys(state.ledger);
  const eligibilityIds = Object.keys(state.accountEligibility);
  if (ledgerIds.length !== eligibilityIds.length
    || ledgerIds.some((opaqueId) => !configured.has(opaqueId) || !eligibilityIds.includes(opaqueId))) return false;
  if (!Object.values(state.threadOwners).every((owner) => configured.has(owner))
    || !Object.values(state.pendingThreadOwners).every((owner) => configured.has(owner))) return false;
  return config.accounts.every((account) => {
    const ledger = state.ledger[account.opaqueAccountId];
    if (!ledger) return config.schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION;
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
  if (refsInput.length < 2 || new Set(refsInput).size !== refsInput.length) throw coded("router-requires-at-least-two-accounts");
  const legacyOwnerRef = typeof message?.legacyOwnerRef === "string" ? message.legacyOwnerRef : null;
  if (!legacyOwnerRef) throw coded("router-history-owner-required");
  if (!refsInput.includes(legacyOwnerRef)) throw coded("router-history-owner-not-selected");
  const filenames = refsInput.map((ref) => refs.get(ref));
  if (filenames.some((filename) => typeof filename !== "string")) throw coded("unknown-reference");
  const labels = savedSnapshotLabels(deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true }));
  const weights = Array.isArray(message?.weights) ? message.weights : refsInput.map(() => 1);
  if (weights.length !== refsInput.length || weights.some((weight) => !Number.isInteger(weight) || weight < 1 || weight > 100)) throw coded("invalid-router-weight");
  const enabledRefs = new Set(Array.isArray(message?.enabledRefs) ? message.enabledRefs : refsInput);
  if ([...enabledRefs].some((ref) => !refsInput.includes(ref)) || enabledRefs.size < 1) throw coded("invalid-router-enabled-accounts");
  const secret = routerSecret(deps, routerPaths);
  try {
    const accounts = filenames.map((filename, index) => withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, filename), (snapshot) => {
      const rawId = authAccountId(snapshot.value);
      if (!rawId) throw coded("invalid-account-identity");
      const opaqueId = opaqueAccountId(secret, rawId);
      return {
        filename,
        opaqueAccountId: opaqueId,
        included: enabledRefs.has(refsInput[index]),
        // Retained for migration compatibility. v3 routing combines quota,
        // freshness, short-window pressure, reset timing and assigned load.
        weight: weights[index],
        capabilityFingerprint: pendingCapabilityFingerprint(opaqueId),
        label: labels.get(filename) || safeSnapshotLabel(snapshot.value, filename, index + 1),
      };
    }));
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length) throw coded("router-requires-distinct-accounts");
    const legacyOwnerOpaqueAccountId = accounts[refsInput.indexOf(legacyOwnerRef)].opaqueAccountId;
    const primaryRef = typeof message?.primaryRef === "string" ? message.primaryRef : refsInput[0];
    const primaryIndex = refsInput.indexOf(primaryRef);
    if (primaryIndex < 0 || !enabledRefs.has(primaryRef)) throw coded("invalid-router-primary");
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
    const refsByOpaqueId = savedAccountRefsByOpaqueId(deps, paths, routerPaths);
    return { ok: true, router: routerPublicStatus(deps, config, state, historyRecords, refsByOpaqueId), live: { state: "not_running", status: null } };
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

function savedAccountRefsByOpaqueId(deps, paths, routerPaths) {
  let secret = null;
  try {
    secret = existingRouterSecret(deps, routerPaths);
    const entries = deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    const candidates = new Map();
    for (const entry of entries) {
      try {
        validateReferenceName(entry.name.slice(0, -5));
        const rawAccountId = withSecureAuth(
          deps.fs,
          sourceFilePath(deps.path, paths.accountsDir, entry.name),
          (snapshot) => authAccountId(snapshot.value),
        );
        if (!rawAccountId) continue;
        const opaqueId = opaqueAccountId(secret, rawAccountId);
        const refs = candidates.get(opaqueId) || [];
        refs.push(stableRef(entry.name));
        candidates.set(opaqueId, refs);
      } catch {}
    }
    const unique = new Map();
    for (const [opaqueId, refs] of candidates) {
      if (refs.length === 1) unique.set(opaqueId, refs[0]);
    }
    return unique;
  } catch {
    return new Map();
  } finally {
    clearSecretBuffer(secret);
  }
}

function projectAuthenticatedRouterRefs(live, refsByOpaqueId) {
  if (live?.state !== "active" || !isRecord(live.status) || !Array.isArray(live.status.accounts)) {
    return live?.state ? { state: live.state, status: null } : { state: "unavailable", status: null };
  }
  const accounts = live.status.accounts.map((account) => {
    const { opaqueAccountId: rawOpaqueId, ...publicAccount } = account;
    return {
      ...publicAccount,
      ref: isOpaqueAccountId(rawOpaqueId) ? (refsByOpaqueId.get(rawOpaqueId) || null) : null,
    };
  });
  return redact({ state: "active", status: { ...live.status, accounts } });
}

function routerPublicStatus(deps, config, state, historyRecords = null, refsByOpaqueId = null) {
  const includeRefs = refsByOpaqueId instanceof Map;
  const refMap = refsByOpaqueId instanceof Map ? refsByOpaqueId : new Map();
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
    historyAdoption: historyAdoptionProjection(null, historyRecords, state, refsByOpaqueId),
  };
  if ([ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(config.schemaVersion)) {
    const invalid = config.protocolFingerprint !== ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT;
    const degradedReason = invalid ? "invalid_config" : routerDegradedReason(state);
    return redact({
      schemaVersion: config.schemaVersion,
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
        ...(includeRefs ? { ref: refMap.get(account.opaqueAccountId) || null } : {}),
        label: safeAccountLabel(account.label, `Account ${index + 1}`),
        eligibility: state?.accountEligibility?.[account.opaqueAccountId] || "validating",
        assignedThreadCount: Number.isInteger(state?.ledger?.[account.opaqueAccountId]?.assignedThreadCount)
          ? state.ledger[account.opaqueAccountId].assignedThreadCount : 0,
      })),
      restartRequired: true,
      degradedReason,
      historyAdoption: historyAdoptionProjection(config, historyRecords, state, refsByOpaqueId),
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
      ...(includeRefs ? { ref: refMap.get(account.opaqueAccountId) || null } : {}),
      label: index === 0 ? "Account A" : "Account B",
      eligibility: state?.accountEligibility?.[account.opaqueAccountId] || "validating",
      normalizedSpend: (completed + output + reserved) / account.weight,
      assignedThreadCount: Number.isInteger(ledger?.assignedThreadCount) ? ledger.assignedThreadCount : 0,
    };
  });
  const inFlight = Boolean(state?.reservations?.length || state?.correlations?.length || accounts.some((account) => ["validating", "reserved", "active"].includes(account.eligibility)));
  return redact({ schemaVersion: ACCOUNT_ROUTER_LEGACY_SCHEMA_VERSION, mode, protocolState: invalid ? "unknown" : "supported", fairnessPrecision: inFlight ? "projected" : "exact_completed_spend", accounts, restartRequired: mode === "balanced" || mode === "direct_fallback", degradedReason, historyAdoption: historyAdoptionProjection(config, historyRecords, state, refsByOpaqueId) });
}

async function routerStatus(_api, deps, paths) {
  const routerPaths = accountRouterPaths(deps, paths);
  // The socket is the only active-truth authority. Query it first so a later
  // bad pending config or state record cannot erase an authenticated running
  // generation from the renderer's view.
  let live;
  try { live = await authenticatedRouterStatus(deps, routerPaths); }
  catch { live = { state: "unavailable", status: null }; }
  const refsByOpaqueId = savedAccountRefsByOpaqueId(deps, paths, routerPaths);
  live = projectAuthenticatedRouterRefs(live, refsByOpaqueId);
  try {
    const config = readRouterConfig(deps, routerPaths);
    const state = readRouterState(deps, routerPaths);
    const historyRecords = readHistoryAdoptionRecords(deps, routerPaths);
    const router = routerPublicStatus(deps, config, state, historyRecords, refsByOpaqueId);
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
    socket.once?.("end", () => finish({
      state: "active",
      // Opaque ids exist only long enough for the main process to associate
      // each runtime row with a renderer-safe saved-account ref.
      status: parseAuthenticatedRouterStatus(response, requestId, true),
    }));
    socket.once?.("error", (error) => finish({ state: error?.code === "ENOENT" || error?.code === "ECONNREFUSED" ? "not_running" : "unavailable", status: null }));
  }).then((result) => result.status ? result : { ...result, state: "unavailable" });
}

function parseAuthenticatedRouterStatus(bytes, requestId, includeOpaqueAccountIds = false) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["requestId", "status", "version"].join("\0")
      || value.version !== 1 || value.requestId !== requestId || !isRecord(value.status)) return null;
    const status = value.status;
    if ([ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(status.schemaVersion)) {
      return parseQuotaAwareRouterStatus(status, includeOpaqueAccountIds);
    }
    return parseLegacyRouterStatus(status, includeOpaqueAccountIds);
  } catch { return null; }
}

function parseLegacyRouterStatus(status, includeOpaqueAccountIds = false) {
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
      accounts.push({
        ...(includeOpaqueAccountIds ? { opaqueAccountId: account.opaqueAccountId } : {}),
        label: account.label,
        eligibility: account.eligibility,
        normalizedSpend: account.normalizedSpend,
        assignedThreadCount: account.assignedThreadCount,
      });
    }
    return redact({ schemaVersion: status.schemaVersion, mode: status.mode, protocolState: status.protocolState, fairnessPrecision: status.fairnessPrecision, accounts, restartRequired: status.restartRequired, degradedReason: status.degradedReason });
  } catch { return null; }
}

function parseQuotaAwareRouterIntent(value, schemaVersion = ACCOUNT_ROUTER_SCHEMA_VERSION) {
  const expectedPolicy = schemaVersion === ACCOUNT_ROUTER_V2_SCHEMA_VERSION
    ? ACCOUNT_ROUTER_V2_QUOTA_POLICY : ACCOUNT_ROUTER_QUOTA_POLICY;
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["fingerprint", "generation", "mode", "policy"].join("\0")
    || !["manual", "quota_aware"].includes(value.mode)
    || (value.mode === "quota_aware" ? !(value.policy === expectedPolicy || schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION && value.policy === "balanced_tokens_v1") : value.policy !== null)
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

function parseQuotaAwareRouterAccount(value, includeOpaqueAccountIds = false) {
  const allowed = ["assignedThreadCount", "eligibility", "identifierMasked", "label", "opaqueAccountId", "plan", "resetCredits", "shortWindowPressure", "weekly"];
  const keys = isRecord(value) ? Object.keys(value).sort() : [];
  const required = allowed.filter((key) => key !== "resetCredits");
  if (!isRecord(value) || keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))
    || !isOpaqueAccountId(value.opaqueAccountId) || !ROUTER_PUBLIC_ELIGIBILITY.has(value.eligibility)
    || !Number.isInteger(value.assignedThreadCount) || value.assignedThreadCount < 0
    || safeAccountLabel(value.label, "") !== value.label || !(value.plan === null || safeAccountLabel(value.plan, "") === value.plan)
    || typeof value.identifierMasked !== "string" || !/^[•*]{4,80}$/.test(value.identifierMasked)
    || !(value.resetCredits === undefined || value.resetCredits === null || (Number.isInteger(value.resetCredits) && value.resetCredits >= 0 && value.resetCredits <= 10_000))) return null;
  const weekly = parseQuotaAwareWeekly(value.weekly);
  const shortWindowPressure = parseQuotaAwarePressure(value.shortWindowPressure);
  if (!weekly || shortWindowPressure === undefined) return null;
  return {
    ...(includeOpaqueAccountIds ? { opaqueAccountId: value.opaqueAccountId } : {}),
    label: value.label,
    eligibility: value.eligibility,
    plan: value.plan,
    identifierMasked: value.identifierMasked,
    weekly,
    shortWindowPressure,
    assignedThreadCount: value.assignedThreadCount,
    resetCredits: value.resetCredits ?? null,
  };
}

function parseQuotaAwareRouterStatus(status, includeOpaqueAccountIds = false) {
  const allowed = ["accounts", "active", "degradedReason", "pending", "poolRemainingPercent", "protocolState", "restartRequired", "schemaVersion"];
  const schemaVersion = status.schemaVersion;
  const active = parseQuotaAwareRouterIntent(status.active, schemaVersion);
  const pending = status.pending === null ? null : parseQuotaAwareRouterIntent(status.pending, schemaVersion);
  const accountCountValid = schemaVersion === ACCOUNT_ROUTER_V2_SCHEMA_VERSION
    ? Array.isArray(status.accounts) && status.accounts.length === 2
    : schemaVersion === ACCOUNT_ROUTER_SCHEMA_VERSION && Array.isArray(status.accounts) && status.accounts.length >= 1;
  const maxPoolRemaining = Array.isArray(status.accounts) ? status.accounts.length * 100 : 0;
  if (Object.keys(status).sort().join("\0") !== allowed.join("\0")
    || ![ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(schemaVersion)
    || !["supported", "unsupported", "drifted", "unknown"].includes(status.protocolState)
    || typeof status.restartRequired !== "boolean"
    || !(status.degradedReason === null || ROUTER_PUBLIC_DEGRADED_REASONS.has(status.degradedReason))
    || !(status.poolRemainingPercent === null || (Number.isFinite(status.poolRemainingPercent) && status.poolRemainingPercent >= 0 && status.poolRemainingPercent <= maxPoolRemaining))
    || !active || (status.pending !== null && !pending)
    || !accountCountValid) return null;
  const accounts = status.accounts.map((account) => parseQuotaAwareRouterAccount(account, includeOpaqueAccountIds));
  if (accounts.some((account) => account === null)) return null;
  return redact({
    schemaVersion,
    active,
    pending,
    protocolState: status.protocolState,
    restartRequired: status.restartRequired,
    accounts,
    // Do not use the transport-provided pool for presentation. The renderer
    // recomputes the visible pool from the bounded redacted weekly rows.
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
    const refsByOpaqueId = savedAccountRefsByOpaqueId(deps, paths, routerPaths);
    return { ok: true, router: routerPublicStatus(deps, config, state, historyRecords, refsByOpaqueId) };
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
    openExternal: (url) => require("electron").shell.openExternal(url),
    randomUUID,
    now: Date.now,
  };
}

function startRenderer(api) {
  const state = {
    api,
    observer: null,
    disposed: false,
    timer: null,
    page: null,
    accountMenus: [],
    cleanups: [],
    brokerSequence: 0,
    brokerRequestNonce: 0,
    brokerSubscribed: false,
    brokerRoots: new Set(),
    enrollmentTimers: new Map(),
    remoteTimers: new Map(),
    profile: null,
    preferences: null,
    preferencesRefreshPromise: null,
    remoteByAccountId: new Map(),
    remotePairings: new Map(),
    remoteErrors: new Map(),
    remoteActions: new Set(),
    profileStatistics: new Map(),
    profileStatisticsLoading: new Set(),
    profileStatisticsErrors: new Map(),
    profileStatisticsRevisions: new Map(),
    profileStatisticsSelection: "pooled",
    expandedBrokerAccountId: null,
    menuExpandedBrokerAccountId: null,
    menuProfileRefreshPromise: null,
    selectedAccountId: null,
    aggregateSelectionId: null,
    usageSelectionId: null,
    pendingContinuation: null,
    sharedHistory: null,
    sharedHistoryTurns: [],
    sharedHistoryRevision: 0,
    sharedHistoryRefreshPromise: null,
    sharedHistoryAdapterCleanup: null,
    sharedHistoryAdapterRevision: 0,
    refreshQueued: false,
    nativeSettingsTargets: new Map(),
    nativeSettingsPanels: new Map(),
    nativeConnectionSelections: new Map(),
    nativeConnectionDataRevision: 0,
    nativeSurfaceRevision: 0,
    nativeProfileRefreshPromise: null,
    nativeUsageResetProjections: new Map(),
    quotaRefreshPromise: null,
    quotaRefreshTimer: null,
    visibleAccountMenuTarget: null,
  };
  globalThis.__tweakersAccountRendererV1?.dispose?.();
  globalThis.__tweakersAccountRendererV1 = { dispose: () => disposeRenderer(state) };
  if (typeof api.accountsNative?.register === "function") {
    const disposeNative = api.accountsNative.register({
      project: (surface, kind, input) => projectAccountsNativeValue(state, surface, kind, input),
      request: (surface, method, params, selection) => requestAccountsNativeValue(state, surface, method, params, selection),
    });
    if (typeof disposeNative === "function") state.cleanups.push(disposeNative);
  }
  if (typeof api.ipc?.on === "function") {
    const unsubscribe = api.ipc.on(ACCOUNT_EVENTS_CHANNEL, (event) => handleAccountBrokerEvent(state, event));
    if (typeof unsubscribe === "function") state.cleanups.push(unsubscribe);
  }
  const onUsageSelection = (event) => {
    const accountId = safeBrokerAccountId(event?.detail?.accountId);
    if (!accountId || !state.profile?.accounts?.some((account) => account.accountId === accountId)) return;
    state.selectedAccountId = accountId;
    state.usageSelectionId = accountId;
    publishAccountsContext(state);
    refreshBrokerRoots(state);
  };
  const onUsageResetRequest = (event) => {
    const accountId = safeBrokerAccountId(event?.detail?.accountId);
    const requestId = typeof event?.detail?.requestId === "string" && ACCOUNT_BROKER_REQUEST_ID.test(event.detail.requestId)
      ? event.detail.requestId : null;
    if (!accountId || !requestId) return;
    void consumeResetCreditFromUsage(state, accountId, requestId);
  };
  const onUsageContextRequest = () => publishAccountsContext(state);
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("tweakers:accounts-select", onUsageSelection);
    window.addEventListener("tweakers:accounts-reset-credit-request", onUsageResetRequest);
    window.addEventListener("tweakers:accounts-context-request", onUsageContextRequest);
    state.cleanups.push(() => window.removeEventListener("tweakers:accounts-select", onUsageSelection));
    state.cleanups.push(() => window.removeEventListener("tweakers:accounts-reset-credit-request", onUsageResetRequest));
    state.cleanups.push(() => window.removeEventListener("tweakers:accounts-context-request", onUsageContextRequest));
    const refreshVisibleQuotas = () => {
      if (accountSurfacesVisible(state)) void refreshAllBrokerQuotas(state);
    };
    window.addEventListener("online", refreshVisibleQuotas);
    window.addEventListener("visibilitychange", refreshVisibleQuotas);
    state.cleanups.push(() => window.removeEventListener("online", refreshVisibleQuotas));
    state.cleanups.push(() => window.removeEventListener("visibilitychange", refreshVisibleQuotas));
    if (typeof window.setInterval === "function") {
      state.quotaRefreshTimer = window.setInterval(refreshVisibleQuotas, 60_000);
      state.cleanups.push(() => window.clearInterval?.(state.quotaRefreshTimer));
    }
  }
  installNativeUsageResetModalProjection(state);
  const schedule = () => {
    if (state.disposed || state.timer) return;
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void injectAccountMenus(state);
      void refreshNativeAccountConnectionSurfaces(state);
      renderAccountsNativeSlots(state);
      void refreshSharedHistoryConversationAdapter(state);
    }, 50);
  };
  const disposeHost = api.react?.host?.observe?.(["account-menu", "assistant-turns", "composer", ...ACCOUNT_NATIVE_CONNECTION_SURFACE_KINDS], (snapshots) => {
    const accountMenu = snapshots?.find((snapshot) => snapshot?.kind === "account-menu");
    state.accountMenus = (accountMenu?.matches || [])
      .filter((match) => match?.kind === "account-menu" && match?.confidence === "high" && match.element)
      .map((match) => match.element);
    const visibleTarget = accountMenuTargetFromCandidates(state.accountMenus);
    if (visibleTarget !== state.visibleAccountMenuTarget) {
      state.visibleAccountMenuTarget = visibleTarget;
      if (visibleTarget && state.profile) void refreshAllBrokerQuotas(state);
    }
    if (!state.accountMenus.length && state.menuExpandedBrokerAccountId) {
      clearRemotePairing(state, state.menuExpandedBrokerAccountId);
      state.menuExpandedBrokerAccountId = null;
    }
    updateNativeAccountSettingsTargets(state, snapshots);
    schedule();
  });
  state.observer = typeof disposeHost === "function" ? { disconnect: disposeHost } : null;
  state.page = api.settings?.registerPage?.({
    id: "accounts",
    title: "Accounts",
    description: "Manage saved subscriptions, pooled usage, connections, and task ownership.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="6.5" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M4 16c.7-3 2.7-4.5 6-4.5s5.3 1.5 6 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    render(root) { return renderAccountsPage(state, root); },
  });
  void subscribeToAccountBroker(state);
  schedule();
}

function renderAccountsPage(state, root) {
  state.brokerRoots.add(root);
  root.textContent = "Loading accounts…";
  void refreshBrokerProfile(state, root);
  return () => {
    state.brokerRoots.delete(root);
    if (!state.brokerRoots.size && !state.menuExpandedBrokerAccountId) {
      for (const accountId of [...state.remotePairings.keys()]) clearRemotePairing(state, accountId);
    }
    root.replaceChildren();
  };
}

function nextAccountBrokerRequestId(state) {
  state.brokerRequestNonce = (state.brokerRequestNonce || 0) + 1;
  const entropy = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : state.brokerRequestNonce.toString(36);
  return `accounts-${Date.now().toString(36)}-${entropy}`.slice(0, 64);
}

async function invokeAccountBroker(state, command, params) {
  const request = {
    version: ACCOUNT_BROKER_VERSION,
    action: ACCOUNT_BROKER_ACTION,
    requestId: nextAccountBrokerRequestId(state),
    command,
    ...(params && Object.keys(params).length ? { params } : {}),
  };
  const normalizedRequest = normalizeAccountBrokerRequest(request);
  if (!normalizedRequest || typeof state?.api?.ipc?.invoke !== "function") {
    return accountBrokerFailure(request.requestId, "broker_unavailable");
  }
  try {
    const response = await state.api.ipc.invoke(IPC, normalizedRequest);
    return normalizeAccountBrokerResponse(normalizedRequest, response);
  } catch {
    return accountBrokerFailure(normalizedRequest.requestId, "broker_unavailable", true);
  }
}

async function subscribeToAccountBroker(state) {
  if (state.disposed || state.brokerSubscribed) return;
  const response = await invokeAccountBroker(state, "events.subscribe");
  // Hot reload can finish while the subscription round trip is in flight.
  // Explicitly release a late success instead of resurrecting a renderer that
  // has already removed its listeners and page roots.
  if (state.disposed) {
    if (response.ok) void invokeAccountBroker(state, "events.unsubscribe");
    return;
  }
  state.brokerSubscribed = response.ok === true;
}

function handleAccountBrokerEvent(state, event) {
  if (state.disposed) return;
  const projected = projectAccountBrokerEvent(event);
  if (!projected || projected.sequence <= state.brokerSequence) return;
  state.brokerSequence = projected.sequence;
  if (ACCOUNT_BROKER_SHARED_HISTORY_INVALIDATION_TYPES.has(projected.type)) {
    return refreshSharedHistory(state);
  }
  if (projected.type === "profile.updated") state.profile = projected.payload;
  if (projected.type === "quota.updated" && state.profile) updateBrokerAccountQuota(state.profile, projected.payload.accountId, projected.payload.quota);
  if (projected.type === "enabled.changed" && state.profile) updateBrokerAccount(state.profile, projected.payload.account);
  if (projected.type === "resetCredit.updated" && state.profile) updateBrokerAccountQuota(state.profile, projected.payload.accountId, projected.payload.quota);
  if (["profile.updated", "enabled.changed", "connection.updated"].includes(projected.type)) {
    state.nativeSurfaceRevision += 1;
  }
  if (projected.type === "connection.updated") state.nativeConnectionDataRevision += 1;
  if (["enrollment.updated", "reconnect.updated"].includes(projected.type)) {
    state.activeEnrollment = projected.payload.enrollment;
    const startCommand = projected.type === "reconnect.updated" ? "reconnect.start" : "enrollment.start";
    scheduleBrokerEnrollmentStatus(state, startCommand, state.activeEnrollment);
  }
  if (["continuation.pending", "continuation.resolved", "handoff.updated"].includes(projected.type)) {
    state.pendingContinuation = projected.payload.continuation;
  }
  publishAccountsContext(state);
  refreshBrokerRoots(state);
}

function updateBrokerAccount(profile, account) {
  if (!profile?.accounts || !account) return;
  const index = profile.accounts.findIndex((candidate) => candidate.accountId === account.accountId);
  if (index >= 0) profile.accounts[index] = account;
}

function updateBrokerAccountQuota(profile, accountId, quota) {
  if (!profile?.accounts || !accountId || !quota) return;
  const account = profile.accounts.find((candidate) => candidate.accountId === accountId);
  if (account) account.quota = quota;
}

async function refreshBrokerPreferences(state, render = true) {
  if (state.disposed) return;
  if (state.preferencesRefreshPromise) return state.preferencesRefreshPromise;
  state.preferencesRefreshPromise = (async () => {
    const response = await invokeAccountBroker(state, "preferences.read");
    if (state.disposed) return;
    state.preferences = response.ok ? response.result : null;
    if (render) for (const root of state.brokerRoots) renderBrokerAccountsContents(state, root);
  })();
  try { await state.preferencesRefreshPromise; } finally { state.preferencesRefreshPromise = null; }
}

function refreshBrokerRoots(state) {
  if (state.disposed || state.refreshQueued) return;
  state.refreshQueued = true;
  queueMicrotask(() => {
    state.refreshQueued = false;
    if (!state.disposed) {
      rerenderBrokerRoots(state);
      refreshNativeAccountConnectionSurfaces(state);
    }
  });
}

function applyAllAccountQuotaResult(state, result) {
  if (!state?.profile?.accounts || !Array.isArray(result?.accounts)) return false;
  const known = new Set(state.profile.accounts.map((account) => account.accountId));
  if (result.accounts.some((entry) => !known.has(entry.accountId))) return false;
  for (const entry of result.accounts) updateBrokerAccountQuota(state.profile, entry.accountId, entry.quota);
  return true;
}

async function refreshAllBrokerQuotas(state, render = true) {
  if (state?.disposed) return null;
  if (state.quotaRefreshPromise) return state.quotaRefreshPromise;
  state.quotaRefreshPromise = (async () => {
    const response = await invokeAccountBroker(state, "quota.read");
    if (state.disposed) return response;
    if (response.ok) applyAllAccountQuotaResult(state, response.result);
    if (render) {
      publishAccountsContext(state);
      rerenderBrokerRoots(state);
    }
    return response;
  })();
  try { return await state.quotaRefreshPromise; } finally { state.quotaRefreshPromise = null; }
}

function accountSurfacesVisible(state) {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return Boolean(
    state?.brokerRoots?.size
    || accountMenuTargetFromCandidates(state?.accountMenus || [])
    || state?.nativeSettingsTargets?.size,
  );
}

async function refreshBrokerProfile(state, requestedRoot = null) {
  const response = await invokeAccountBroker(state, "profile.read");
  const roots = requestedRoot ? [requestedRoot] : [...state.brokerRoots];
  if (state.disposed) return response;
  if (!response.ok) {
    for (const root of roots) renderBrokerUnavailable(root, response.error?.code, state);
    removeNativeAccountConnectionSurfaces(state);
    return response;
  }
  state.profile = response.result;
  await refreshBrokerPreferences(state, false);
  if (state.disposed) return response;
  state.nativeSurfaceRevision += 1;
  const accounts = state.profile.accounts || [];
  if (!accounts.some((account) => account.accountId === state.selectedAccountId)) {
    state.selectedAccountId = state.profile.selectedAccountId
      || accounts.find((account) => account.enabled)?.accountId
      || accounts[0]?.accountId
      || null;
  }
  if (!accounts.some((account) => account.accountId === state.aggregateSelectionId)) state.aggregateSelectionId = null;
  if (!accounts.some((account) => account.accountId === state.usageSelectionId)) state.usageSelectionId = null;
  if (state.profileStatisticsSelection !== "pooled" && !accounts.some((account) => account.accountId === state.profileStatisticsSelection)) {
    state.profileStatisticsSelection = "pooled";
  }
  if (!accounts.some((account) => account.accountId === state.expandedBrokerAccountId)) state.expandedBrokerAccountId = null;
  if (!accounts.some((account) => account.accountId === state.menuExpandedBrokerAccountId)) state.menuExpandedBrokerAccountId = null;
  // A visible Accounts surface refreshes every enabled subscription. The
  // broker owns coalescing and retains cached successes when another account
  // fails, so the renderer never fans out private-account requests itself.
  await refreshAllBrokerQuotas(state, false);
  if (state.disposed) return response;
  const historyRevision = (state.sharedHistoryRevision || 0) + 1;
  state.sharedHistoryRevision = historyRevision;
  const history = await invokeAccountBroker(state, "history.read");
  if (state.disposed) return response;
  if (history.ok && historyRevision === state.sharedHistoryRevision) {
    state.sharedHistory = history.result.conversation;
    state.sharedHistoryTurns = history.result.turns;
  }
  publishAccountsContext(state);
  for (const root of roots) {
    if (state.brokerRoots.has(root)) renderBrokerAccountsContents(state, root);
  }
  refreshNativeAccountConnectionSurfaces(state);
  void refreshSharedHistoryConversationAdapter(state);
  return response;
}

function profileStatisticsStateMap(state, key) {
  if (!(state?.[key] instanceof Map)) state[key] = new Map();
  return state[key];
}

function profileStatisticsStateSet(state, key) {
  if (!(state?.[key] instanceof Set)) state[key] = new Set();
  return state[key];
}

function profileStatisticsSelection(state, accounts) {
  const requested = state?.profileStatisticsSelection;
  return requested === "pooled" || accounts.some((account) => account.accountId === requested)
    ? requested : "pooled";
}

function profileStatisticsResultFor(state, selection, accounts) {
  const result = profileStatisticsStateMap(state, "profileStatistics").get(selection);
  if (!result || result.selection !== selection) return null;
  const knownAccounts = new Set(accounts.map((account) => account.accountId));
  // Cache only the public projection for the current account list. A result
  // for a removed account cannot be carried into a later menu or settings
  // render, even if the opaque string happens to look valid.
  if (result.accounts.length !== knownAccounts.size || result.accounts.some((account) => !knownAccounts.has(account.accountId))) return null;
  if (selection !== "pooled" && !knownAccounts.has(selection)) return null;
  return result;
}

async function refreshProfileStatistics(state, selection = null) {
  const accounts = state?.profile?.accounts || [];
  const requested = selection || profileStatisticsSelection(state, accounts);
  if (requested !== "pooled" && !accounts.some((account) => account.accountId === requested)) return null;
  const loading = profileStatisticsStateSet(state, "profileStatisticsLoading");
  if (loading.has(requested)) return null;
  const revisions = profileStatisticsStateMap(state, "profileStatisticsRevisions");
  const revision = (revisions.get(requested) || 0) + 1;
  revisions.set(requested, revision);
  loading.add(requested);
  profileStatisticsStateMap(state, "profileStatisticsErrors").delete(requested);
  rerenderBrokerRoots(state);
  const response = await invokeAccountBroker(state, "profile.statistics", { selection: requested });
  loading.delete(requested);
  if (state?.disposed || revisions.get(requested) !== revision) return response;
  const knownAccounts = state?.profile?.accounts || [];
  const valid = response.ok && response.result?.selection === requested
    && response.result.accounts.length === knownAccounts.length
    && response.result.accounts.every((account) => knownAccounts.some((known) => known.accountId === account.accountId));
  if (valid) profileStatisticsStateMap(state, "profileStatistics").set(requested, response.result);
  else profileStatisticsStateMap(state, "profileStatisticsErrors").set(requested, response.error?.code || "broker_invalid_response");
  rerenderBrokerRoots(state);
  return response;
}

function selectProfileStatistics(state, accountId, accounts) {
  const selection = accountId === "pooled" ? "pooled" : safeBrokerAccountId(accountId);
  if (!selection || selection !== "pooled" && !accounts.some((account) => account.accountId === selection)) return;
  state.profileStatisticsSelection = selection;
  syncAccountsNativeSelections(state);
  rerenderBrokerRoots(state);
  void refreshProfileStatistics(state, selection);
}

function formatProfileStatisticNumber(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "Not available";
  try { return new Intl.NumberFormat().format(value); } catch { return String(value); }
}

function formatProfileStatisticPercentage(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) return "Not available";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function formatProfileStatisticDuration(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return "Not available";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function profileStatisticsPicker(state, accounts, selected) {
  const selector = document.createElement("select");
  selector.className = "border-token-border bg-token-foreground/5 h-token-button-composer max-w-[280px] rounded-md border px-3 text-sm text-token-text-primary";
  selector.setAttribute("aria-label", "Profile activity subscription");
  const pooled = document.createElement("option");
  pooled.value = "pooled";
  pooled.textContent = "Combined subscriptions";
  selector.append(pooled);
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = account.label;
    selector.append(option);
  }
  selector.value = selected;
  selector.addEventListener("change", () => selectProfileStatistics(state, selector.value, accounts));
  return selector;
}

function profileStatisticsMetric(label, value) {
  const item = document.createElement("div");
  item.className = "bg-token-foreground/5 flex min-w-[140px] flex-1 flex-col gap-1 rounded-md p-3";
  const title = document.createElement("div");
  title.className = "text-token-text-secondary text-xs";
  title.textContent = label;
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-primary";
  detail.textContent = value;
  item.append(title, detail);
  return item;
}

function profileStatisticsBucketSummary(label, buckets) {
  const item = document.createElement("div");
  item.className = "text-token-text-secondary text-xs";
  const latest = buckets[buckets.length - 1] || null;
  item.textContent = latest ? `${label}: ${formatProfileStatisticNumber(latest.tokens)} tokens on ${latest.startDate}` : `${label}: no provider activity reported`;
  return item;
}

function appendProfileStatisticsDetails(container, result, accounts) {
  const stats = result.stats;
  if (!stats) {
    const unavailable = document.createElement("div");
    unavailable.className = "text-token-text-secondary text-sm";
    unavailable.textContent = "Profile activity is unavailable for this selection.";
    container.append(unavailable);
    return;
  }
  const metrics = document.createElement("div");
  metrics.className = "flex flex-wrap gap-2";
  metrics.append(
    profileStatisticsMetric("Lifetime tokens", formatProfileStatisticNumber(stats.lifetimeTokens)),
    profileStatisticsMetric("Peak day", formatProfileStatisticNumber(stats.peakDailyTokens)),
    profileStatisticsMetric("Current streak", `${formatProfileStatisticNumber(stats.currentStreakDays)} days`),
    profileStatisticsMetric("Longest streak", `${formatProfileStatisticNumber(stats.longestStreakDays)} days`),
    profileStatisticsMetric("Total threads", formatProfileStatisticNumber(stats.totalThreads)),
    profileStatisticsMetric("Longest running turn", formatProfileStatisticDuration(stats.longestRunningTurnSec)),
    profileStatisticsMetric("Fast Mode usage", formatProfileStatisticPercentage(stats.fastModeUsagePercentage)),
    profileStatisticsMetric("Skills used", `${formatProfileStatisticNumber(stats.totalSkillsUsed)} total · ${formatProfileStatisticNumber(stats.uniqueSkillsUsed)} unique`),
    profileStatisticsMetric("Most used reasoning", stats.mostUsedReasoningEffort
      ? `${stats.mostUsedReasoningEffort} · ${formatProfileStatisticPercentage(stats.mostUsedReasoningEffortPercentage)}` : "Not reported"),
  );
  container.append(metrics);
  const activity = document.createElement("div");
  activity.className = "flex flex-col gap-1";
  activity.append(
    profileStatisticsBucketSummary("Latest daily activity", stats.dailyUsageBuckets),
    profileStatisticsBucketSummary("Latest cumulative activity", stats.cumulativeDailyUsageBuckets),
    profileStatisticsBucketSummary("Latest weekly activity", stats.weeklyUsageBuckets),
  );
  container.append(activity);
  if (stats.topInvocations.length) {
    const invocationTitle = document.createElement("div");
    invocationTitle.className = "text-token-text-secondary text-xs";
    invocationTitle.textContent = "Top invocations";
    const invocationList = document.createElement("div");
    invocationList.className = "flex flex-col gap-1";
    for (const invocation of stats.topInvocations.slice(0, 8)) {
      const item = document.createElement("div");
      item.className = "text-token-text-secondary flex flex-wrap justify-between gap-2 text-xs";
      const label = document.createElement("span");
      label.textContent = `${invocation.type}: ${invocation.label}`;
      const count = document.createElement("span");
      count.textContent = `${formatProfileStatisticNumber(invocation.usageCount)} uses`;
      item.append(label, count);
      invocationList.append(item);
    }
    container.append(invocationTitle, invocationList);
  }
  if (result.selection === "pooled") {
    const availability = document.createElement("div");
    availability.className = "text-token-text-secondary text-xs";
    const accountById = new Map(accounts.map((account) => [account.accountId, account]));
    availability.textContent = result.accounts
      .map((account) => `${accountById.get(account.accountId)?.label || "Subscription"}: ${account.state === "ready" ? "activity available" : "activity unavailable"}`)
      .join(" · ");
    container.append(availability);
  }
}

function brokerProfileActivityCard(state, accounts, options = {}) {
  const menu = options.menu === true;
  const card = document.createElement("div");
  card.className = menu
    ? "border-token-border flex flex-col gap-3 border-t px-2 py-3"
    : "border-token-border flex flex-col gap-3 overflow-hidden rounded-lg border p-3";
  const header = document.createElement("div");
  header.className = "flex flex-wrap items-center justify-between gap-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Profile activity";
  const detail = document.createElement("div");
  detail.className = "text-token-text-secondary text-xs";
  detail.textContent = "Provider-reported activity totals for combined or individual subscriptions.";
  copy.append(title, detail);
  const selection = profileStatisticsSelection(state, accounts);
  state.profileStatisticsSelection = selection;
  const controls = document.createElement("div");
  controls.className = "flex flex-wrap items-center gap-2";
  controls.append(profileStatisticsPicker(state, accounts, selection));
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "text-token-text-link-foreground text-sm hover:underline disabled:opacity-60";
  refresh.textContent = "Refresh profile activity";
  const loading = profileStatisticsStateSet(state, "profileStatisticsLoading").has(selection);
  refresh.disabled = loading;
  refresh.addEventListener("click", () => void refreshProfileStatistics(state, selection));
  controls.append(refresh);
  header.append(copy, controls);
  card.append(header);
  const result = profileStatisticsResultFor(state, selection, accounts);
  const error = profileStatisticsStateMap(state, "profileStatisticsErrors").get(selection);
  if (!result) {
    const message = document.createElement("div");
    message.className = "text-token-text-secondary text-sm";
    message.textContent = loading ? "Loading profile activity…" : error
      ? accountBrokerDisplayMessage(error) : "Profile activity has not been loaded yet.";
    card.append(message);
    if (!loading && !error) queueMicrotask(() => { void refreshProfileStatistics(state, selection); });
    return card;
  }
  const stateCopy = document.createElement("div");
  stateCopy.className = "text-token-text-secondary text-xs";
  const observed = new Date(result.observedAt);
  stateCopy.textContent = `${loading ? "Refreshing activity · " : ""}${result.partial ? "Some subscriptions are unavailable · " : ""}Observed ${Number.isFinite(observed.getTime()) ? observed.toLocaleString() : "recently"}`;
  card.append(stateCopy);
  appendProfileStatisticsDetails(card, result, accounts);
  return card;
}

// Broker events never carry transcript or authoritative turn state. Fetch the
// current redacted projection immediately, then update all mounted Accounts
// roots and the exact host adapter from that one result.
function refreshSharedHistory(state) {
  if (state?.disposed) return Promise.resolve(null);
  // Core emits paired history/conversation invalidations for one committed
  // revision. They share this in-flight read; the first starts immediately and
  // its canonical response is sufficient for both content-free signals.
  if (state.sharedHistoryRefreshPromise) return state.sharedHistoryRefreshPromise;
  const refresh = (async () => {
    const revision = (state.sharedHistoryRevision || 0) + 1;
    state.sharedHistoryRevision = revision;
    const history = await invokeAccountBroker(state, "history.read");
    if (state.disposed || revision !== state.sharedHistoryRevision || !history.ok) return history;
    state.sharedHistory = history.result.conversation;
    state.sharedHistoryTurns = history.result.turns;
    publishAccountsContext(state);
    for (const root of state.brokerRoots || []) {
      if (state.brokerRoots.has(root)) renderBrokerAccountsContents(state, root);
    }
    void refreshSharedHistoryConversationAdapter(state);
    return history;
  })();
  state.sharedHistoryRefreshPromise = refresh;
  void refresh.then(
    () => { if (state.sharedHistoryRefreshPromise === refresh) state.sharedHistoryRefreshPromise = null; },
    () => { if (state.sharedHistoryRefreshPromise === refresh) state.sharedHistoryRefreshPromise = null; },
  );
  return refresh;
}

function clearSharedHistoryConversationAdapter(state) {
  const cleanup = state?.sharedHistoryAdapterCleanup;
  state.sharedHistoryAdapterCleanup = null;
  try { cleanup?.(); } catch {}
}

async function refreshSharedHistoryConversationAdapter(state) {
  const revision = (state.sharedHistoryAdapterRevision || 0) + 1;
  state.sharedHistoryAdapterRevision = revision;
  clearSharedHistoryConversationAdapter(state);
  const history = state.sharedHistory;
  const resolveTarget = state?.api?.react?.host?.getSharedHistoryTarget;
  if (state.disposed || !history || typeof resolveTarget !== "function") return;
  let result;
  try { result = await resolveTarget(); } catch { return; }
  if (state.disposed || revision !== state.sharedHistoryAdapterRevision || result?.status !== "available") return;
  const target = result.target;
  if (!target?.isCurrent?.() || target.conversationId !== history.conversationId) return;
  const mounted = renderSharedHistoryConversationAdapter(target, history, state.sharedHistoryTurns);
  if (state.disposed || revision !== state.sharedHistoryAdapterRevision || !target.isCurrent?.()) {
    try { mounted?.cleanup?.(); } catch {}
    return;
  }
  state.sharedHistoryAdapterCleanup = typeof mounted?.cleanup === "function" ? mounted.cleanup : null;
}

function nativeAccountSettingsSurfaceTarget(kind, matches) {
  if (!ACCOUNT_NATIVE_CONNECTION_SURFACE_KINDS.includes(kind)) return null;
  const candidates = [...new Set((Array.isArray(matches) ? matches : [])
    .filter((match) => match?.kind === kind && match.confidence === "high"
      && match.element?.isConnected !== false && typeof match.element?.append === "function")
    .map((match) => match.element))];
  // A named native page is safe only when the host proves one exact target.
  // Do not select a parent/child winner when two roots are reported: that
  // would leave a subscription control attached to an uncertain settings page.
  return candidates.length === 1 ? candidates[0] : null;
}

function updateNativeAccountSettingsTargets(state, snapshots) {
  const source = Array.isArray(snapshots) ? snapshots : [];
  // The shared catalog can contain an Apps heading/card and match the Apps
  // host heuristic. Never mount subscription controls on Plugins or Skills.
  const sharedCatalog = typeof document !== "undefined" && typeof document.querySelectorAll === "function"
    && Array.from(document.querySelectorAll("h1,h2,[role='heading']"))
      .some((heading) => /^(Skills|Plugins)$/.test(String(heading.textContent || "").trim()));
  for (const definition of ACCOUNT_NATIVE_CONNECTION_SURFACES) {
    const matches = source
      .filter((snapshot) => snapshot?.kind === definition.kind)
      .flatMap((snapshot) => Array.isArray(snapshot.matches) ? snapshot.matches : []);
    const target = sharedCatalog ? null : (namedAccountsNativeSlot(definition.surface)
      || nativeAccountSettingsSurfaceTarget(definition.kind, matches));
    if (state.nativeSettingsTargets.get(definition.kind) === target) continue;
    state.nativeSurfaceRevision += 1;
    if (target) state.nativeSettingsTargets.set(definition.kind, target);
    else state.nativeSettingsTargets.delete(definition.kind);
    const panel = state.nativeSettingsPanels.get(definition.kind);
    if (panel && (!target || panel.parentElement !== target)) {
      try { panel.remove?.(); } catch {}
      state.nativeSettingsPanels.delete(definition.kind);
    }
  }
}

function removeNativeAccountConnectionSurface(state, kind) {
  const panel = state?.nativeSettingsPanels?.get?.(kind);
  try { panel?.remove?.(); } catch {}
  state?.nativeSettingsPanels?.delete?.(kind);
}

function removeNativeAccountConnectionSurfaces(state) {
  for (const definition of ACCOUNT_NATIVE_CONNECTION_SURFACES) {
    removeNativeAccountConnectionSurface(state, definition.kind);
  }
}

function nativeConnectionSelectionFor(state, definition, accounts) {
  const known = new Set(accounts.map((account) => account.accountId));
  const remembered = safeBrokerAccountId(state.nativeConnectionSelections.get(definition.kind));
  const selected = remembered && known.has(remembered)
    ? remembered
    : safeBrokerAccountId(state.selectedAccountId) && known.has(state.selectedAccountId)
      ? state.selectedAccountId
      : accounts[0]?.accountId || null;
  if (selected) state.nativeConnectionSelections.set(definition.kind, selected);
  if (selected) state.api?.accountsNative?.select?.(definition.surface, selected);
  return selected;
}

function nativeAccountConnectionPanelIsCurrent(state, definition, target, panel, revision) {
  if (state?.disposed || !panel || panel.isConnected === false) return false;
  if (state.nativeSettingsTargets.get(definition.kind) !== target || state.nativeSettingsPanels.get(definition.kind) !== panel) return false;
  if (panel.parentElement !== target) return false;
  return panel.dataset?.tweakersAccountConnectionSurfaceRevision === String(revision);
}

function nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, accountId, revision) {
  const selectedAccountId = safeBrokerAccountId(accountId);
  return Boolean(selectedAccountId
    && nativeAccountConnectionPanelIsCurrent(state, definition, target, panel, revision)
    && state.nativeConnectionSelections.get(definition.kind) === selectedAccountId
    && state.profile?.accounts?.some((account) => account.accountId === selectedAccountId));
}

function connectionResponseMatchesAccount(response, accountId) {
  return response?.result?.accountId === accountId;
}

function nativeAccountConnectionSurfaceRevision(definition, accounts, selectedAccountId) {
  const accountRevision = accounts
    .map((account) => [account.accountId, account.label, account.enabled].join(":"))
    .join(",");
  return `${definition.kind}:${selectedAccountId}:${accountRevision}`;
}

function refreshNativeAccountConnectionSurfaces(state) {
  if (typeof document === "undefined" || state?.disposed) return;
  if (!state.nativeSettingsTargets?.size) {
    removeNativeAccountConnectionSurfaces(state);
    return;
  }
  const accounts = state.profile?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    removeNativeAccountConnectionSurfaces(state);
    if (!state.profile && !state.nativeProfileRefreshPromise) {
      const pending = Promise.resolve(refreshBrokerProfile(state)).finally(() => {
        if (state.nativeProfileRefreshPromise === pending) state.nativeProfileRefreshPromise = null;
      });
      state.nativeProfileRefreshPromise = pending;
    }
    return;
  }
  for (const definition of ACCOUNT_NATIVE_CONNECTION_SURFACES) {
    const target = state.nativeSettingsTargets.get(definition.kind);
    if (!target) {
      removeNativeAccountConnectionSurface(state, definition.kind);
      continue;
    }
    const selectedAccountId = nativeConnectionSelectionFor(state, definition, accounts);
    if (!selectedAccountId) {
      removeNativeAccountConnectionSurface(state, definition.kind);
      continue;
    }
    const revision = nativeAccountConnectionSurfaceRevision(definition, accounts, selectedAccountId);
    const existing = state.nativeSettingsPanels.get(definition.kind);
    if (nativeAccountConnectionPanelIsCurrent(state, definition, target, existing, revision)) {
      if (existing.dataset?.tweakersAccountConnectionDataRevision !== String(state.nativeConnectionDataRevision)) {
        existing.dataset.tweakersAccountConnectionDataRevision = String(state.nativeConnectionDataRevision);
        const rows = existing.querySelector?.('[data-tweakers-account-connection-rows="true"]');
        if (rows) void loadNativeAccountConnections(state, definition, target, existing, rows, selectedAccountId, revision);
      }
      continue;
    }
    removeNativeAccountConnectionSurface(state, definition.kind);
    const rendered = renderNativeAccountConnectionSurface(state, definition, accounts, selectedAccountId, revision);
    if (!rendered || state.disposed || state.nativeSettingsTargets.get(definition.kind) !== target) continue;
    target.append(rendered.panel);
    state.nativeSettingsPanels.set(definition.kind, rendered.panel);
    void loadNativeAccountConnections(state, definition, target, rendered.panel, rendered.rows, selectedAccountId, revision);
  }
}

function renderNativeAccountConnectionSurface(state, definition, accounts, selectedAccountId, revision) {
  if (typeof document === "undefined") return null;
  const panel = document.createElement("div");
  panel.className = "border-token-border bg-token-foreground/5 mt-3 flex flex-col gap-3 rounded-md border p-3";
  panel.dataset.tweakersAccountConnectionSurface = definition.kind;
  panel.dataset.tweakersAccountConnectionSurfaceRevision = String(revision);
  panel.dataset.tweakersAccountConnectionDataRevision = String(state.nativeConnectionDataRevision);
  panel.setAttribute(ACCOUNT_NATIVE_CONNECTION_SURFACE_ATTR, definition.kind);
  const header = document.createElement("div");
  header.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = `${definition.title} account connection`;
  const note = document.createElement("div");
  note.className = "text-sm text-token-text-secondary";
  note.textContent = "Shared Skills and installed plugin packages are read-only. Connection status is separate for each subscription. Only MCP can be authorized here; Apps and Plugins are status-only. Credentials are never copied.";
  const selector = document.createElement("select");
  selector.className = "border-token-border bg-token-bg-primary h-token-button-composer max-w-[280px] rounded-md border px-3 text-sm text-token-text-primary";
  selector.setAttribute("aria-label", `${definition.title} subscription`);
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = account.label;
    selector.append(option);
  }
  selector.value = selectedAccountId;
  selector.addEventListener("change", () => {
    const nextAccountId = safeBrokerAccountId(selector.value);
    if (!nextAccountId || !state.profile?.accounts?.some((account) => account.accountId === nextAccountId)) return;
    state.nativeConnectionSelections.set(definition.kind, nextAccountId);
    state.selectedAccountId = nextAccountId;
    publishAccountsContext(state);
    refreshNativeAccountConnectionSurfaces(state);
    refreshBrokerRoots(state);
  });
  header.append(title, note, selector);
  const rows = document.createElement("div");
  rows.className = "flex flex-col divide-y-[0.5px] divide-token-border";
  rows.dataset.tweakersAccountConnectionRows = "true";
  panel.append(header, rows);
  return { panel, rows };
}

async function loadNativeAccountConnections(state, definition, target, panel, rows, accountId, revision) {
  const requestedAccountId = safeBrokerAccountId(accountId);
  if (!requestedAccountId || !nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision)) return;
  const requestGeneration = (Number(panel.__tweakersAccountConnectionRequestGeneration) || 0) + 1;
  panel.__tweakersAccountConnectionRequestGeneration = requestGeneration;
  const requestIsCurrent = () => panel.__tweakersAccountConnectionRequestGeneration === requestGeneration
    && nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision);
  rows.textContent = "Checking connection status…";
  const response = await invokeAccountBroker(state, "connection.list", { accountId: requestedAccountId, surface: definition.surface });
  if (!requestIsCurrent()) return;
  if (!response.ok) {
    renderConnectionServiceFailure(rows, definition.surface, response.error?.code, () => {
      void loadNativeAccountConnections(state, definition, target, panel, rows, requestedAccountId, revision);
    });
    return;
  }
  if (!connectionResponseMatchesAccount(response, requestedAccountId)) {
    rows.textContent = "Connection status is unavailable right now.";
    return;
  }
  const connections = Array.isArray(response.result?.connections) ? response.result.connections : [];
  // The broker must return only the requested integration. A mixed response
  // is an ownership mismatch, not a reason to surface another integration's
  // login state on this native settings page.
  if (connections.some((connection) => connection.surface !== definition.surface)) {
    rows.textContent = "Connection status is unavailable right now.";
    return;
  }
  renderNativeAccountConnectionRows(state, definition, target, panel, rows, requestedAccountId, revision, connections);
}

function renderNativeAccountConnectionRows(state, definition, target, panel, rows, accountId, revision, connections) {
  const requestedAccountId = safeBrokerAccountId(accountId);
  if (!requestedAccountId || !nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision)) return;
  rows.replaceChildren();
  if (!connections.length) {
    const empty = document.createElement("div");
    empty.className = "text-token-text-secondary p-1 text-sm";
    empty.textContent = "No connections are available for this subscription.";
    rows.append(empty);
    return;
  }
  for (const connection of connections) {
    const row = document.createElement("div");
    row.className = "flex flex-wrap items-center justify-between gap-2 py-1";
    const name = document.createElement("span");
    name.className = "text-sm text-token-text-primary";
    name.textContent = connection.label;
    const actions = document.createElement("div");
    actions.className = "flex items-center gap-2";
    const status = document.createElement("span");
    status.className = "text-sm text-token-text-secondary";
    status.textContent = connectionStatusLabel(connection.status);
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "text-token-text-secondary text-sm underline underline-offset-2";
    refresh.textContent = "Refresh status";
    refresh.addEventListener("click", async () => {
      const requestConnectionId = safeBrokerConnectionId(connection.connectionId);
      if (!requestConnectionId || !nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision)) return;
      refresh.disabled = true;
      const response = await invokeAccountBroker(state, "connection.status", {
        accountId: requestedAccountId, surface: definition.surface, connectionId: requestConnectionId,
      });
      refresh.disabled = false;
      if (!nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision)) return;
      if (!response.ok) { status.textContent = accountConnectionDisplayMessage(definition.surface, response.error?.code); return; }
      if (!connectionResponseMatchesAccount(response, requestedAccountId)) { status.textContent = "Connection status is unavailable right now."; return; }
      void loadNativeAccountConnections(state, definition, target, panel, rows, requestedAccountId, revision);
    });
    actions.append(status, refresh);
    if (connection.authorizationAvailable && ["setup_required", "expired"].includes(connection.status)) {
      const authorize = document.createElement("button");
      authorize.type = "button";
      authorize.className = "text-token-text-link-foreground text-sm hover:underline";
      authorize.textContent = "Authorize";
      authorize.addEventListener("click", async () => {
        const requestConnectionId = safeBrokerConnectionId(connection.connectionId);
        if (!requestConnectionId || !nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision)) return;
        authorize.disabled = true;
        const response = await invokeAccountBroker(state, "connection.authorize", {
          accountId: requestedAccountId, surface: definition.surface, connectionId: requestConnectionId,
        });
        authorize.disabled = false;
        if (!nativeAccountConnectionRequestIsCurrent(state, definition, target, panel, requestedAccountId, revision)) return;
        if (!response.ok) { status.textContent = accountConnectionDisplayMessage(definition.surface, response.error?.code); return; }
        if (!connectionResponseMatchesAccount(response, requestedAccountId)) { status.textContent = "Connection status is unavailable right now."; return; }
        void loadNativeAccountConnections(state, definition, target, panel, rows, requestedAccountId, revision);
      });
      actions.append(authorize);
    }
    row.append(name, actions);
    rows.append(row);
  }
}

function renderBrokerUnavailable(root, code, state) {
  root.replaceChildren();
  const panel = document.createElement("div");
  panel.className = "flex flex-col gap-2 p-panel text-sm text-token-text-secondary";
  const title = document.createElement("div");
  title.className = "text-token-text-primary font-medium";
  title.textContent = accountBrokerUnavailableTitle(code);
  const detail = document.createElement("div");
  detail.textContent = accountBrokerDisplayMessage(code);
  panel.append(title, detail);
  if (code === "broker_setup_required") {
    const steps = document.createElement("div");
    steps.className = "flex flex-col gap-2 border-t border-token-border pt-3";
    const heading = document.createElement("div");
    heading.className = "text-token-text-primary font-medium";
    heading.textContent = "Restore your saved accounts";
    const instructions = document.createElement("p");
    instructions.textContent = "Ask Codex to prepare shared account activation and verify your saved sign-ins. After those checks pass, approve the final maintenance restart for ChatGPT and Tweakers. Your account homes and conversation history stay in place.";
    steps.append(heading, instructions);
    panel.append(steps);
  } else if (state) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = menuButtonClass();
    retry.textContent = "Try again";
    retry.addEventListener("click", async () => {
      if (state.disposed || !state.brokerRoots.has(root)) return;
      retry.disabled = true;
      await refreshBrokerProfile(state, root);
    });
    panel.append(retry);
  }
  root.append(panel);
}

function accountBrokerUnavailableTitle(code) {
  return code === "broker_setup_required" ? "Account setup is incomplete" : "Accounts are unavailable right now";
}

function accountBrokerDisplayMessage(code) {
  if (code === "broker_setup_required") return "The shared account service has not been set up. Saved accounts cannot be shown until account linking is complete. No account changes were made.";
  if (code === "broker_unavailable") return "The secure account service is not available. No account changes were made.";
  if (code === "account_history_busy") return "Account-history setup is still running. Wait for it to finish, close the conflicting app if it remains open, then Retry.";
  if (code === "account_already_enrolled") return "That subscription is already in this account pool. Nothing was changed.";
  if (code === "enrollment_expired") return "The sign-in code expired. Start again when you are ready.";
  if (code === "duplicate_account") return "That subscription is already saved. Nothing was changed.";
  if (code === "continuation_expired") return "That confirmation expired. Nothing was changed.";
  if (code === "linked_continuation_required") return "That item was not transferred between subscriptions. Start a separate linked continuation with the intended subscription, then restate or reattach the missing item there.";
  if (code === "handoff_unavailable") return "This continuation proposal is no longer available. Start a new linked continuation when you are ready.";
  return "The secure account request could not be completed. No account changes were made.";
}

function accountConnectionDisplayMessage(surface, code) {
  if (surface === "plugins" && code === "broker_unavailable") {
    return "Plugin service unavailable. Cached plugins were not changed. Retry later or report the service issue.";
  }
  return accountBrokerDisplayMessage(code);
}

function renderConnectionServiceFailure(container, surface, code, retry) {
  container.replaceChildren();
  const panel = document.createElement("div");
  panel.className = "flex flex-wrap items-center justify-between gap-3 p-3 text-sm text-token-text-secondary";
  const message = document.createElement("span");
  message.textContent = accountConnectionDisplayMessage(surface, code);
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-3";
  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "text-token-text-link-foreground text-sm hover:underline";
  retryButton.textContent = "Retry";
  retryButton.addEventListener("click", () => retry());
  actions.append(retryButton);
  if (surface === "plugins") {
    const report = document.createElement("a");
    report.className = "text-token-text-secondary text-sm underline underline-offset-2";
    report.textContent = "Report issue";
    report.href = "https://help.openai.com/en/articles/20001256";
    report.target = "_blank";
    report.rel = "noreferrer";
    actions.append(report);
  }
  panel.append(message, actions);
  container.append(panel);
}

function renderBrokerAccountsContents(state, root) {
  root.replaceChildren();
  const page = document.createElement("div");
  page.className = "flex flex-col gap-6";
  const accounts = state.profile?.accounts || [];
  const status = document.createElement("div");
  status.className = "text-token-text-secondary text-sm";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  state.brokerStatus = status;
  page.append(
    brokerRoutingPreferencesCard(state),
    ...(state.sharedHistory ? [brokerSharedHistoryCard(state)] : []),
    brokerAccountPoolCard(state, accounts),
    brokerEnrollmentCard(state, accounts),
  );
  if (state.pendingContinuation?.state === "pending") page.append(brokerContinuationCard(state));
  page.append(status);
  root.append(page);
}

function brokerAggregateCard(state, accounts) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Combined profile";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  const stats = brokerPoolStats(accounts);
  detail.textContent = `${accounts.length} ${accounts.length === 1 ? "subscription" : "subscriptions"} · ${stats.enabled} enabled · ${stats.assigned} assigned ${stats.assigned === 1 ? "task" : "tasks"}`;
  const selector = brokerAccountSelector(state, accounts, "Profile subscription", true, (accountId) => {
    state.aggregateSelectionId = accountId || null;
    if (accountId) state.selectedAccountId = accountId;
    publishAccountsContext(state);
    refreshBrokerRoots(state);
  }, state.aggregateSelectionId);
  copy.append(title, detail, selector);
  const avatars = document.createElement("div");
  avatars.className = "flex -space-x-2";
  for (const account of accounts) {
    const avatar = brokerAccountAvatar(account);
    avatar.className += " border-2 border-token-bg-primary";
    avatars.append(avatar);
  }
  row.append(copy, avatars);
  card.append(row);
  return card;
}

function brokerUsageCard(state, accounts) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Usage";
  const selector = brokerAccountSelector(state, accounts, "Usage subscription", true, (accountId) => {
    state.usageSelectionId = accountId || null;
    if (accountId) state.selectedAccountId = accountId;
    publishAccountsContext(state);
    refreshBrokerRoots(state);
  }, state.usageSelectionId);
  const selected = state.usageSelectionId ? accounts.find((account) => account.accountId === state.usageSelectionId) || null : null;
  const pool = brokerPoolStats(accounts);
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  detail.textContent = selected
    ? brokerQuotaText(selected.quota)
    : pool.allDepleted
      ? `All enabled subscriptions are depleted${pool.earliestResetAt ? ` · earliest reset ${formatResetAt(pool.earliestResetAt)}` : ""}`
      : brokerPoolQuotaText(pool);
  copy.append(title, selector, detail);
  const value = document.createElement("div");
  value.className = "text-token-text-secondary shrink-0 text-sm";
  value.textContent = brokerUsageValueText(selected, pool);
  row.append(copy, value);
  card.append(row);
  return card;
}

function brokerRoutingPreferencesCard(state) {
  const card = settingsCard();
  const body = document.createElement("div");
  body.className = "flex flex-col gap-3 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Routing preferences";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  description.textContent = "Choose how new work moves between enabled subscriptions. Active work keeps its current owner.";
  body.append(title, description);
  if (!state.preferences) {
    const unavailable = document.createElement("div");
    unavailable.className = "text-sm text-token-text-secondary";
    unavailable.textContent = "Routing preferences are unavailable right now.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "text-token-text-link-foreground w-fit text-sm hover:underline";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void refreshBrokerPreferences(state));
    body.append(unavailable, retry);
    card.append(body);
    return card;
  }
  const modeRow = document.createElement("label");
  modeRow.className = "flex flex-wrap items-center justify-between gap-3 text-sm";
  const modeCopy = document.createElement("span");
  modeCopy.className = "flex min-w-0 flex-col gap-1";
  const modeTitle = document.createElement("span");
  modeTitle.className = "text-token-text-primary";
  modeTitle.textContent = "When another subscription can continue safely";
  const modeNote = document.createElement("span");
  modeNote.className = "text-token-text-secondary text-xs";
  modeNote.textContent = "Automatic keeps work moving when account state is current. Ask first leaves the choice with you.";
  modeCopy.append(modeTitle, modeNote);
  const mode = document.createElement("select");
  mode.className = "border-token-border bg-token-foreground/5 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary";
  mode.setAttribute("aria-label", "Subscription failover preference");
  for (const [value, label] of [["automatic", "Automatic when safe"], ["ask", "Ask first"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }
  mode.value = state.preferences.failoverMode;
  mode.addEventListener("change", async () => {
    mode.disabled = true;
    await updateBrokerPreferences(state, { failoverMode: mode.value });
    mode.disabled = false;
  });
  modeRow.append(modeCopy, mode);
  const catalogRow = document.createElement("label");
  catalogRow.className = "flex items-start gap-3 text-sm";
  const catalog = document.createElement("input");
  catalog.type = "checkbox";
  catalog.checked = state.preferences.unifiedCatalogEnabled;
  catalog.setAttribute("aria-label", "Share conversations with paired devices");
  const catalogCopy = document.createElement("span");
  catalogCopy.className = "flex min-w-0 flex-col gap-1";
  const catalogTitle = document.createElement("span");
  catalogTitle.className = "text-token-text-primary";
  catalogTitle.textContent = "Share conversations with paired devices";
  const catalogNote = document.createElement("span");
  catalogNote.className = "text-token-text-secondary text-xs";
  catalogNote.textContent = "Optional catalog sharing lets a paired device see available conversations. Remote work uses that device’s connected subscription.";
  catalogCopy.append(catalogTitle, catalogNote);
  catalog.addEventListener("change", async () => {
    catalog.disabled = true;
    await updateBrokerPreferences(state, { unifiedCatalogEnabled: catalog.checked === true });
    catalog.disabled = false;
  });
  catalogRow.append(catalog, catalogCopy);
  body.append(modeRow, catalogRow);
  card.append(body);
  return card;
}

async function updateBrokerPreferences(state, patch) {
  const response = await invokeAccountBroker(state, "preferences.update", patch);
  if (state.disposed) return;
  if (!response.ok) {
    statusBrokerFailure(state, response.error?.code);
    rerenderBrokerRoots(state);
    return;
  }
  state.preferences = response.result;
  rerenderBrokerRoots(state);
}

function rerenderBrokerRoots(state) {
  if (state?.disposed) return;
  for (const root of state.brokerRoots || []) {
    if (state.brokerRoots.has(root)) renderBrokerAccountsContents(state, root);
  }
  rerenderBrokerAccountMenu(state);
  renderAccountsNativeSlots(state);
}

function rerenderBrokerAccountMenu(state) {
  if (!state?.profile || state.disposed) return;
  const targetMenu = accountMenuTargetFromCandidates(state.accountMenus || []);
  if (!targetMenu) return;
  const panel = brokerAccountMenuRows(state, state.profile);
  mountAccountSwitcherPanel(accountMenuOwnedTarget(targetMenu), panel);
}

function brokerAccountPoolCard(state, accounts) {
  const card = settingsCard();
  if (!accounts.length) {
    const empty = document.createElement("div");
    empty.className = "p-3 text-sm text-token-text-secondary";
    empty.textContent = "Sign in to add a subscription to this account pool.";
    card.append(empty);
    return card;
  }
  const count = document.createElement("div");
  count.className = "p-3 text-sm text-token-text-secondary";
  count.textContent = `${accounts.length} ${accounts.length === 1 ? "subscription" : "subscriptions"}`;
  card.append(count);
  for (const account of accounts) {
    const expanded = state.expandedBrokerAccountId === account.accountId;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "hover:bg-token-foreground/5 flex w-full flex-wrap items-center justify-between gap-4 p-3 text-left";
    row.setAttribute("aria-expanded", String(expanded));
    row.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} account details for ${account.label}`);
    const identity = document.createElement("span");
    identity.className = "flex min-w-0 items-center gap-3";
    const copy = document.createElement("span");
    copy.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("span");
    title.className = "truncate text-sm text-token-text-primary";
    title.textContent = account.label;
    const identityText = document.createElement("span");
    identityText.className = "text-token-text-secondary truncate text-xs";
    identityText.textContent = [account.email !== account.label ? account.email : null, account.plan].filter(Boolean).join(" · ") || "Masked identity and plan unavailable";
    const quota = document.createElement("span");
    quota.className = "text-token-text-secondary truncate text-xs";
    quota.textContent = `${brokerQuotaText(account.quota)} · ${account.assignedTaskCount} assigned ${account.assignedTaskCount === 1 ? "task" : "tasks"}${account.currentTaskOwner ? " · current task owner" : ""}`;
    copy.append(title, identityText, quota);
    identity.append(brokerAccountAvatar(account), copy);
    const status = document.createElement("span");
    status.className = "text-token-text-secondary shrink-0 text-xs";
    status.textContent = `${brokerAccountStatusLabel(account)} · ${expanded ? "Hide details" : "Show details"}`;
    row.append(identity, status);
    row.addEventListener("click", () => {
      const next = state.expandedBrokerAccountId === account.accountId ? null : account.accountId;
      state.expandedBrokerAccountId = next;
      if (!next) clearRemotePairing(state, account.accountId);
      rerenderBrokerRoots(state);
      if (next) void refreshBrokerRemote(state, account.accountId);
    });
    card.append(row);
    if (expanded) card.append(brokerAccountDisclosure(state, account));
  }
  return card;
}

function brokerAccountDisclosure(state, account) {
  const details = document.createElement("div");
  details.className = "border-token-border flex flex-col gap-3 border-t p-3";
  if (account.continuityState === "deferred") {
    const notice = document.createElement("p");
    notice.className = "text-token-text-secondary text-xs";
    notice.textContent = brokerContinuityDetail(account);
    details.append(notice);
  }
  const actions = document.createElement("div");
  actions.className = "flex flex-wrap items-center gap-3";
  const copyEmail = document.createElement("button");
  copyEmail.type = "button";
  copyEmail.className = "text-token-text-link-foreground text-sm hover:underline";
  copyEmail.textContent = "Copy email";
  copyEmail.addEventListener("click", async () => {
    copyEmail.disabled = true;
    const response = await invokeAccountBroker(state, "profile.email", { accountId: account.accountId });
    copyEmail.disabled = false;
    if (state.disposed) return;
    if (!response.ok || response.result.accountId !== account.accountId) {
      statusBrokerFailure(state, response.error?.code);
      return;
    }
    const copied = await writeBrokerClipboard(response.result.email);
    if (state.disposed) return;
    if (copied) setBrokerStatus(state, "Email copied to the clipboard.");
    else setBrokerStatus(state, "The email could not be copied. Try again.");
  });
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "text-token-text-secondary text-sm underline underline-offset-2";
  rename.textContent = "Rename";
  rename.addEventListener("click", async () => {
    const next = globalThis.window?.prompt?.(`Name for ${account.label}`, account.label);
    if (next === null || next === undefined) return;
    const response = await invokeAccountBroker(state, "profile.update", { accountId: account.accountId, label: String(next).trim() });
    if (!response.ok) { statusBrokerFailure(state, response.error?.code); return; }
    updateBrokerAccount(state.profile, response.result.account);
    setBrokerStatus(state, `${response.result.account.label} was renamed.`);
    publishAccountsContext(state);
    refreshBrokerRoots(state);
  });
  const enabled = document.createElement("button");
  enabled.type = "button";
  enabled.className = "text-token-text-secondary text-sm underline underline-offset-2";
  enabled.textContent = account.enabled ? "Disable" : "Enable";
  enabled.addEventListener("click", async () => {
    enabled.disabled = true;
    const response = await invokeAccountBroker(state, "enabled.set", { accountId: account.accountId, enabled: !account.enabled });
    enabled.disabled = false;
    if (!response.ok) { statusBrokerFailure(state, response.error?.code); return; }
    updateBrokerAccount(state.profile, response.result.account);
    setBrokerStatus(state, enabledLifecycleMessage(response.result.account, response.result.lifecycle));
    publishAccountsContext(state);
    refreshBrokerRoots(state);
  });
  actions.append(copyEmail, rename, enabled);
  if (account.status === "reauth_required" || account.status === "unavailable") {
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.className = "text-token-text-secondary text-sm underline underline-offset-2";
    reconnect.textContent = "Reconnect";
    reconnect.addEventListener("click", () => void startBrokerEnrollment(state, "reconnect.start", account.accountId));
    actions.append(reconnect);
  }
  details.append(actions, brokerRemoteControls(state, account));
  return details;
}

function setBrokerStatus(state, message) {
  if (state?.brokerStatus) state.brokerStatus.textContent = message;
}

async function writeBrokerClipboard(text) {
  if (typeof text !== "string" || !text) return false;
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText !== "function") return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function remoteResultMatchesAccount(response, accountId) {
  return response?.ok === true && response.result?.accountId === accountId;
}

function rememberBrokerRemote(state, accountId, response, capturePairing = false) {
  if (!remoteResultMatchesAccount(response, accountId)) {
    state.remoteErrors.set(accountId, response?.error?.code || "broker_invalid_response");
    return false;
  }
  const { pairing, ...remote } = response.result;
  state.remoteByAccountId.set(accountId, remote);
  state.remoteErrors.delete(accountId);
  if (capturePairing) {
    if (pairing) {
      state.remotePairings.set(accountId, pairing);
      scheduleRemotePairingStatus(state, accountId);
    } else {
      clearRemotePairing(state, accountId);
    }
  }
  return true;
}

async function refreshBrokerRemote(state, accountId) {
  const validAccountId = safeBrokerAccountId(accountId);
  if (!validAccountId || state.disposed) return;
  let response = await invokeAccountBroker(state, "remote.status", { accountId: validAccountId });
  // Devices change independently of the on/off status. The status projection
  // is useful immediately; the dedicated list request makes an expanded
  // disclosure current without trusting an old pairing response.
  if (remoteResultMatchesAccount(response, validAccountId)) {
    response = await invokeAccountBroker(state, "remote.devices.list", { accountId: validAccountId });
  }
  if (state.disposed) return;
  rememberBrokerRemote(state, validAccountId, response, false);
  rerenderBrokerRoots(state);
}

async function beginBrokerRemotePairing(state, accountId) {
  const validAccountId = safeBrokerAccountId(accountId);
  if (!validAccountId || state.disposed || state.remoteActions.has(validAccountId)) return;
  state.remoteActions.add(validAccountId);
  try {
    let response = await invokeAccountBroker(state, "remote.status", { accountId: validAccountId });
    if (!remoteResultMatchesAccount(response, validAccountId)) { rememberBrokerRemote(state, validAccountId, response); return; }
    if (!response.result.enabled) {
      response = await invokeAccountBroker(state, "remote.enable", { accountId: validAccountId });
      if (!remoteResultMatchesAccount(response, validAccountId)) { rememberBrokerRemote(state, validAccountId, response); return; }
    }
    response = await invokeAccountBroker(state, "remote.pairing.start", { accountId: validAccountId });
    rememberBrokerRemote(state, validAccountId, response, true);
  } finally {
    state.remoteActions.delete(validAccountId);
    if (!state.disposed) rerenderBrokerRoots(state);
  }
}

async function updateBrokerRemoteEnabled(state, accountId, enabled) {
  const validAccountId = safeBrokerAccountId(accountId);
  if (!validAccountId || state.disposed || state.remoteActions.has(validAccountId)) return;
  state.remoteActions.add(validAccountId);
  try {
    const response = await invokeAccountBroker(state, enabled ? "remote.enable" : "remote.disable", { accountId: validAccountId });
    rememberBrokerRemote(state, validAccountId, response, false);
    if (!enabled) clearRemotePairing(state, validAccountId);
  } finally {
    state.remoteActions.delete(validAccountId);
    if (!state.disposed) rerenderBrokerRoots(state);
  }
}

async function revokeBrokerRemoteDevice(state, accountId, deviceId) {
  const validAccountId = safeBrokerAccountId(accountId);
  const validDeviceId = safeBrokerDeviceId(deviceId);
  if (!validAccountId || !validDeviceId || state.disposed) return;
  const response = await invokeAccountBroker(state, "remote.devices.revoke", { accountId: validAccountId, deviceId: validDeviceId });
  if (state.disposed) return;
  rememberBrokerRemote(state, validAccountId, response, false);
  rerenderBrokerRoots(state);
}

function scheduleRemotePairingStatus(state, accountId) {
  clearRemotePairingTimer(state, accountId);
  const pairing = state.remotePairings.get(accountId);
  if (!pairing || state.disposed || !isBrokerAccountExpanded(state, accountId)) return;
  const expiresAt = pairing.expiresAt ? Date.parse(pairing.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    clearRemotePairing(state, accountId);
    rerenderBrokerRoots(state);
    return;
  }
  const delay = Math.max(250, Math.min(ACCOUNT_REMOTE_PAIRING_POLL_MS, Number.isFinite(expiresAt) ? expiresAt - Date.now() : ACCOUNT_REMOTE_PAIRING_POLL_MS));
  const timer = (globalThis.window?.setTimeout || setTimeout)(async () => {
    state.remoteTimers.delete(accountId);
    if (state.disposed || !isBrokerAccountExpanded(state, accountId)) return;
    const response = await invokeAccountBroker(state, "remote.pairing.status", { accountId });
    if (state.disposed) return;
    rememberBrokerRemote(state, accountId, response, true);
    rerenderBrokerRoots(state);
  }, delay);
  state.remoteTimers.set(accountId, timer);
}

function isBrokerAccountExpanded(state, accountId) {
  return state?.expandedBrokerAccountId === accountId || state?.menuExpandedBrokerAccountId === accountId;
}

function clearRemotePairingTimer(state, accountId) {
  const timer = state?.remoteTimers?.get(accountId);
  if (timer !== undefined) (globalThis.window?.clearTimeout || clearTimeout)(timer);
  state?.remoteTimers?.delete(accountId);
}

function clearRemotePairing(state, accountId) {
  if (state?.remotePairings?.has(accountId)) void invokeAccountBroker(state, "remote.pairing.close", { accountId });
  clearRemotePairingTimer(state, accountId);
  state?.remotePairings?.delete(accountId);
}

function brokerRemoteControls(state, account) {
  const accountId = account.accountId;
  const remote = state.remoteByAccountId.get(accountId) || null;
  const pairing = state.remotePairings.get(accountId) || null;
  const error = state.remoteErrors.get(accountId) || null;
  const box = document.createElement("div");
  box.className = "bg-token-foreground/5 flex flex-col gap-2 rounded-md p-3";
  const heading = document.createElement("div");
  heading.className = "text-sm text-token-text-primary";
  heading.textContent = "Paired devices";
  const message = document.createElement("div");
  message.className = "text-token-text-secondary text-xs";
  if (error) message.textContent = accountBrokerDisplayMessage(error);
  else if (!remote) message.textContent = "Checking paired-device access…";
  else if (remote.state === "mfa_required") message.textContent = "Additional sign-in is required before this subscription can manage paired devices.";
  // The public remote projection has no typed MFA failure. Keep the recovery
  // guidance honest: native MFA may be required, but an unavailable result
  // does not prove that it is the cause and Retry remains the next action.
  else if (remote.state === "unavailable") message.textContent = "Paired-device access is unavailable right now. Complete any required MFA in the native app, then Retry.";
  else if (!remote.enabled || remote.state === "disabled") message.textContent = "Paired-device access is off.";
  else if (pairing) message.textContent = pairing.expiresAt ? `Pairing code expires ${new Date(pairing.expiresAt).toLocaleTimeString()}.` : "Pairing code is ready.";
  else message.textContent = "Pair another device to this subscription.";
  const actions = document.createElement("div");
  actions.className = "flex flex-wrap items-center gap-3";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "text-token-text-secondary text-sm underline underline-offset-2";
  refresh.textContent = error ? "Retry" : "Refresh status";
  refresh.addEventListener("click", () => void refreshBrokerRemote(state, accountId));
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "text-token-text-secondary text-sm underline underline-offset-2";
  toggle.textContent = remote?.enabled ? "Turn off paired devices" : "Turn on paired devices";
  toggle.disabled = state.remoteActions.has(accountId);
  toggle.addEventListener("click", () => void updateBrokerRemoteEnabled(state, accountId, remote?.enabled !== true));
  const pair = document.createElement("button");
  pair.type = "button";
  pair.className = "text-token-text-link-foreground text-sm hover:underline";
  pair.textContent = pairing ? "Start a new pairing" : "Pair device";
  pair.disabled = state.remoteActions.has(accountId) || remote?.state === "mfa_required" || remote?.state === "unavailable";
  pair.addEventListener("click", () => void beginBrokerRemotePairing(state, accountId));
  actions.append(refresh, toggle, pair);
  box.append(heading, message, actions);
  if (pairing) {
    const code = document.createElement("div");
    code.className = "text-token-text-primary font-mono text-sm";
    code.textContent = pairing.code;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "text-token-text-link-foreground w-fit text-sm hover:underline";
    copy.textContent = "Copy pairing code";
    copy.addEventListener("click", async () => {
      copy.disabled = true;
      const copied = await writeBrokerClipboard(pairing.code);
      copy.disabled = false;
      setBrokerStatus(state, copied ? "Pairing code copied to the clipboard." : "The pairing code could not be copied. Try again.");
    });
    box.append(code, copy);
  }
  if (remote?.devices?.length) {
    const devices = document.createElement("div");
    devices.className = "flex flex-col gap-2";
    for (const device of remote.devices) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-3 text-sm";
      const label = document.createElement("span");
      label.className = "text-token-text-secondary truncate";
      label.textContent = device.label;
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "text-token-text-secondary text-sm underline underline-offset-2";
      revoke.textContent = "Remove";
      revoke.addEventListener("click", () => void revokeBrokerRemoteDevice(state, accountId, device.deviceId));
      row.append(label, revoke);
      devices.append(row);
    }
    box.append(devices);
  }
  return box;
}

function brokerEnrollmentCard(state, accounts) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Add a subscription";
  const note = document.createElement("div");
  note.className = "text-sm text-token-text-secondary";
  note.textContent = "Sign in with a device code. Provider tokens and homes never enter this page.";
  copy.append(title, note);
  const start = document.createElement("button");
  start.type = "button";
  start.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary";
  start.textContent = "Add subscription";
  start.addEventListener("click", () => void startBrokerEnrollment(state, "enrollment.start"));
  row.append(copy, start);
  card.append(row);
  if (state.activeEnrollment) card.append(brokerEnrollmentStatusCard(state));
  return card;
}

function brokerEnrollmentStatusCard(state) {
  const enrollment = state.activeEnrollment;
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = enrollment.state === "waiting" ? "Finish device-code sign-in" : enrollment.state === "complete" ? "Subscription added" : "Device-code sign-in";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  detail.textContent = enrollment.state === "waiting" && enrollment.userCode
    ? `Enter code ${enrollment.userCode}${enrollment.expiresAt ? ` before ${new Date(enrollment.expiresAt).toLocaleTimeString()}` : ""}.`
    : enrollment.state === "expired" ? "The code expired. Start again when you are ready."
      : enrollment.state === "failed" ? "The sign-in could not be completed. Nothing else was changed."
        : enrollment.state === "cancelled" ? "The sign-in was cancelled."
          : "Preparing secure device-code sign-in…";
  copy.append(title, detail);
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2";
  if (enrollment.state === "waiting" && enrollment.verificationUrl) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "text-token-text-link-foreground text-sm hover:underline";
    link.textContent = "Open sign-in in browser";
    link.addEventListener("click", async () => {
      link.disabled = true;
      const opened = await openDeviceSignInFromRenderer(state);
      link.disabled = false;
      if (!opened) setBrokerStatus(state, "The external browser could not be opened. Try again.");
    });
    actions.append(link);
  }
  if (["starting", "waiting"].includes(enrollment.state)) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "text-token-text-secondary text-sm underline underline-offset-2";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => void cancelBrokerEnrollment(state, enrollment));
    actions.append(cancel);
  }
  row.append(copy, actions);
  return row;
}

async function openDeviceSignInExternally(deps) {
  try {
    await deps.openExternal("https://auth.openai.com/codex/device");
    return { ok: true };
  } catch { return safeFailure("external-browser-unavailable"); }
}

async function openDeviceSignInFromRenderer(state) {
  try {
    const result = await state.api.ipc.invoke(IPC, { action: "open-device-sign-in" });
    return result?.ok === true;
  } catch { return false; }
}

function brokerConnectionsCard(state, accounts, surface, title) {
  const card = settingsCard();
  let selectionRevision = 0;
  const header = document.createElement("div");
  header.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const heading = document.createElement("div");
  heading.className = "text-sm text-token-text-primary";
  heading.textContent = title;
  const note = document.createElement("div");
  note.className = "text-sm text-token-text-secondary";
  note.textContent = "Shared Skills and installed plugin packages are read-only. Connection status is separate for each subscription. Only MCP can be authorized here; Apps and Plugins are status-only. Credentials are never copied.";
  const selector = brokerAccountSelector(state, accounts, `${title} subscription`, false, () => {
    selectionRevision += 1;
    void loadBrokerConnections();
  });
  copy.append(heading, note, selector);
  header.append(copy);
  const rows = document.createElement("div");
  rows.className = "flex flex-col divide-y-[0.5px] divide-token-border";
  card.append(header, rows);
  const selectionIsCurrent = (accountId, revision) => !state.disposed
    && selectionRevision === revision
    && safeBrokerAccountId(selector.value) === accountId;
  const loadBrokerConnections = async () => {
    const accountId = safeBrokerAccountId(selector.value || state.selectedAccountId);
    const requestRevision = selectionRevision;
    if (!accountId) { rows.replaceChildren(); return; }
    rows.textContent = "Checking connections…";
    const response = await invokeAccountBroker(state, "connection.list", { accountId, surface });
    if (!selectionIsCurrent(accountId, requestRevision)) return;
    if (!response.ok) {
      renderConnectionServiceFailure(rows, surface, response.error?.code, () => { void loadBrokerConnections(); });
      return;
    }
    if (!connectionResponseMatchesAccount(response, accountId)) { rows.textContent = "Connection status is unavailable right now."; return; }
    rows.replaceChildren();
    const connections = Array.isArray(response.result.connections) ? response.result.connections : [];
    if (connections.some((connection) => connection.surface !== surface)) {
      rows.textContent = "Connection status is unavailable right now.";
      return;
    }
    if (!connections.length) {
      const empty = document.createElement("div");
      empty.className = "p-3 text-sm text-token-text-secondary";
      empty.textContent = "No connections are available for this subscription.";
      rows.append(empty);
      return;
    }
    for (const connection of connections) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-3 p-3";
      const name = document.createElement("div");
      name.className = "text-sm text-token-text-primary";
      name.textContent = connection.label;
      const actions = document.createElement("div");
      actions.className = "flex items-center gap-2";
      const status = document.createElement("span");
      status.className = "text-sm text-token-text-secondary";
      status.textContent = connectionStatusLabel(connection.status);
      actions.append(status);
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "text-token-text-secondary text-sm underline underline-offset-2";
      refresh.textContent = "Refresh status";
      refresh.addEventListener("click", async () => {
        const requestConnectionId = safeBrokerConnectionId(connection.connectionId);
        if (!requestConnectionId || !selectionIsCurrent(accountId, requestRevision)) return;
        refresh.disabled = true;
        const result = await invokeAccountBroker(state, "connection.status", {
          accountId, surface, connectionId: requestConnectionId,
        });
        refresh.disabled = false;
        if (!selectionIsCurrent(accountId, requestRevision)) return;
        if (!result.ok) { status.textContent = accountConnectionDisplayMessage(surface, result.error?.code); return; }
        if (!connectionResponseMatchesAccount(result, accountId)) { status.textContent = "Connection status is unavailable right now."; return; }
        const updated = result.result.connections?.find((candidate) => candidate.connectionId === connection.connectionId);
        if (updated) status.textContent = connectionStatusLabel(updated.status);
      });
      actions.append(refresh);
      if (connection.authorizationAvailable && ["setup_required", "expired"].includes(connection.status)) {
        const authorize = document.createElement("button");
        authorize.type = "button";
        authorize.className = "text-token-text-link-foreground text-sm hover:underline";
        authorize.textContent = "Authorize";
        authorize.addEventListener("click", async () => {
          const requestConnectionId = safeBrokerConnectionId(connection.connectionId);
          if (!requestConnectionId || !selectionIsCurrent(accountId, requestRevision)) return;
          authorize.disabled = true;
          const result = await invokeAccountBroker(state, "connection.authorize", { accountId, surface, connectionId: requestConnectionId });
          authorize.disabled = false;
          if (!selectionIsCurrent(accountId, requestRevision)) return;
          if (!result.ok) status.textContent = accountConnectionDisplayMessage(surface, result.error?.code);
          else if (!connectionResponseMatchesAccount(result, accountId)) status.textContent = "Connection status is unavailable right now.";
          else void loadBrokerConnections();
        });
        actions.append(authorize);
      }
      row.append(name, actions);
      rows.append(row);
    }
  };
  void loadBrokerConnections();
  return card;
}

function eligibleContinuationDestinations(state, continuation) {
  if (continuation?.kind !== "subscription_switch") return [];
  const currentAccountId = safeBrokerAccountId(continuation.fromSubscription?.accountId);
  return (state?.profile?.accounts || []).filter((account) => safeBrokerAccountId(account?.accountId)
    && account.accountId !== currentAccountId
    && account.enabled === true
    && account.status === "ready"
    && freshBrokerQuotaRemainingPercent(account.quota) > 0);
}

function brokerContinuationCard(state) {
  const continuation = state.pendingContinuation;
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = continuation.kind === "subscription_switch"
    ? "Continue this conversation with another subscription"
    : "Continue account action";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  const switchDetail = continuation.kind === "subscription_switch"
    ? `This creates a linked continuation from ${continuation.fromSubscription.label} to ${continuation.toSubscription.label}. Existing history remains available without copying account-private data.`
    : "Confirmation is required before continuing.";
  detail.textContent = continuation.expiresAt
    ? `${switchDetail} Confirmation expires ${new Date(continuation.expiresAt).toLocaleTimeString()}.`
    : switchDetail;
  copy.append(title, detail);
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2";
  const destinations = eligibleContinuationDestinations(state, continuation);
  let destinationAccountId = destinations.some((account) => account.accountId === continuation.toSubscription?.accountId)
    ? continuation.toSubscription.accountId : destinations[0]?.accountId || null;
  let confirmButton = null;
  if (continuation.kind === "subscription_switch") {
    const selector = brokerAccountSelector(
      state,
      destinations,
      "Destination subscription",
      false,
      (accountId) => {
        destinationAccountId = destinations.some((account) => account.accountId === accountId) ? accountId : null;
        if (confirmButton) confirmButton.disabled = !destinationAccountId;
      },
      destinationAccountId,
    );
    selector.disabled = destinations.length === 0;
    actions.append(selector);
    if (!destinationAccountId) {
      detail.textContent = `${switchDetail} No eligible destination subscription is available right now.`;
    }
  }
  // This renderer intentionally receives only the opaque confirmation ID and
  // expiration. It never receives, stores, or displays the pending request.
  for (const [command, label] of [["handoff.confirm", "Continue"], ["handoff.cancel", "Cancel"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = command === "handoff.confirm"
      ? "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary"
      : "text-token-text-secondary text-sm underline underline-offset-2";
    button.textContent = label;
    if (command === "handoff.confirm") {
      confirmButton = button;
      if (continuation.kind === "subscription_switch" && !destinationAccountId) button.disabled = true;
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      const destination = continuation.kind === "subscription_switch"
        && destinations.some((account) => account.accountId === destinationAccountId)
        ? destinationAccountId : null;
      const response = await invokeAccountBroker(state, command, {
        confirmationId: continuation.confirmationId,
        ...(command === "handoff.confirm" && destination ? { accountId: destination } : {}),
      });
      button.disabled = false;
      if (!response.ok) { statusBrokerFailure(state, response.error?.code); return; }
      state.pendingContinuation = response.result.continuation;
      state.brokerStatus.textContent = response.result.continuation.state === "confirmed" ? "The account action was confirmed." : "The account action was cancelled.";
      refreshBrokerRoots(state);
    });
    actions.append(button);
  }
  row.append(copy, actions);
  card.append(row);
  return card;
}

function sharedHistoryAvailabilityText(history) {
  if (!history) return "Shared conversation status is unavailable right now.";
  const warning = history.historyWarning === undefined
    ? history.availability === "ambiguous" || history.segments?.some((segment) => segment.state === "ambiguous")
      ? "ambiguous" : history.segments?.some((segment) => segment.state === "incomplete") ? "content_gap" : null
    : history.historyWarning;
  if (warning === "content_gap") return "A linked continuation could not safely include every item. Available conversation history is still shown. To continue, start a separate linked continuation with the intended subscription and restate or reattach the missing item there.";
  if (warning === "ambiguous") return "This linked continuation is ambiguous. Available conversation history is still shown, but it will not be replayed.";
  if (history.activeClient) return "A response is in progress. Available conversation history is shown.";
  if (history.availability === "complete") return "All committed conversation history is available.";
  if (history.availability === "partial") return "Available conversation history is shown, but some earlier history is not available in this app.";
  return "Available conversation history is shown.";
}

function sharedHistorySegmentText(segment) {
  if (segment.state === "active") return `${segment.subscription.label} is working on this conversation.`;
  if (segment.state === "incomplete") return `${segment.subscription.label} has an incomplete linked continuation.`;
  if (segment.state === "ambiguous") return `${segment.subscription.label} has an ambiguous linked continuation.`;
  return `Completed with ${segment.subscription.label}.`;
}

function brokerSharedHistoryCard(state) {
  const card = settingsCard();
  const history = state.sharedHistory;
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Shared conversation history";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  detail.textContent = sharedHistoryAvailabilityText(history);
  copy.append(title, detail);
  if (history?.activeClient) {
    const active = document.createElement("div");
    active.className = "text-sm text-token-text-secondary";
    active.textContent = `${history.activeClient.label} is active with ${history.activeClient.subscription.label}.`;
    copy.append(active);
  }
  if (history?.peerBusy) {
    const busy = document.createElement("div");
    busy.className = "text-sm text-token-text-secondary";
    busy.textContent = "Another Codex app is working on this conversation.";
    copy.append(busy);
  }
  row.append(copy);
  card.append(row);
  if (history?.segments?.length) {
    const segments = document.createElement("div");
    segments.className = "flex flex-col divide-y-[0.5px] divide-token-border";
    for (const segment of history.segments) {
      const segmentRow = document.createElement("div");
      segmentRow.className = "p-3 text-sm text-token-text-secondary";
      segmentRow.textContent = sharedHistorySegmentText(segment);
      segments.append(segmentRow);
    }
    card.append(segments);
  }
  return card;
}

// The parent-owned host-surface bridge calls this seam only after it has
// proved the exact native conversation and composer roots. This tweak never
// searches for those roots or guesses a conversation from the DOM.
function renderSharedHistoryConversationAdapter(target, history, turns) {
  if (!isRecord(target) || target.kind !== "shared-history-conversation"
    || !history || target.conversationId !== history.conversationId
    || typeof target.statusRoot?.append !== "function"
    || typeof target.composerRoot?.append !== "function"
    || !Array.isArray(target.assistantTurns)) return null;
  const seenTurns = new Set();
  for (const candidate of target.assistantTurns) {
    if (!isRecord(candidate) || !safeBrokerTurnId(candidate.turnId)
      || seenTurns.has(candidate.turnId) || typeof candidate.root?.append !== "function") return null;
    seenTurns.add(candidate.turnId);
  }
  const inserted = [];
  const append = (root, node) => { root.append(node); inserted.push(node); };
  const status = document.createElement("div");
  status.className = "text-token-text-secondary mt-2 text-sm";
  status.dataset.tweakersSharedHistoryStatus = "true";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = sharedHistoryAvailabilityText(history);
  append(target.statusRoot, status);
  if (history.peerBusy) {
    const busy = document.createElement("div");
    busy.className = "text-token-text-secondary mt-2 text-sm";
    busy.dataset.tweakersSharedHistoryBusy = "true";
    busy.textContent = "Another Codex app is working on this conversation.";
    append(target.composerRoot, busy);
  }
  const byTurnId = new Map((Array.isArray(turns) ? turns : []).map((turn) => [turn.turnId, turn]));
  for (const candidate of target.assistantTurns) {
    const turn = byTurnId.get(candidate.turnId);
    if (!turn) continue;
    const label = document.createElement("span");
    label.className = "text-token-text-secondary mt-1 block text-xs";
    label.dataset.tweakersSharedHistoryTurn = "true";
    label.textContent = `Answered by ${turn.subscription.label}`;
    append(candidate.root, label);
  }
  return {
    cleanup() {
      for (const node of inserted) {
        try { node.remove?.(); } catch {}
      }
    },
  };
}

function brokerAccountSelector(state, accounts, label, includeAll, onChange, selectedId = state.selectedAccountId) {
  const selector = document.createElement("select");
  selector.className = "border-token-border bg-token-foreground/5 h-token-button-composer max-w-[280px] rounded-md border px-3 text-sm text-token-text-primary";
  selector.setAttribute("aria-label", label);
  if (includeAll) {
    const all = document.createElement("option");
    all.value = ""; all.textContent = "All subscriptions"; selector.append(all);
  }
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = account.label;
    selector.append(option);
  }
  selector.value = includeAll ? (selectedId || "") : (selectedId || accounts[0]?.accountId || "");
  selector.addEventListener("change", () => onChange(selector.value));
  return selector;
}

function brokerAccountAvatar(account, size = 32) {
  const fallback = accountAvatar(account?.label || "Account");
  Object.assign(fallback.style, { width: `${size}px`, height: `${size}px` });
  // Keep the DOM sink defensive even though broker projections sanitize this
  // field: a stale in-memory profile must not restore URL query credentials.
  const avatarUrl = safeBrokerAvatarUrl(account?.avatarUrl);
  if (!avatarUrl) return fallback;
  const image = document.createElement("img");
  image.src = avatarUrl;
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.className = "h-8 w-8 shrink-0 rounded-full object-cover";
  Object.assign(image.style, { width: `${size}px`, height: `${size}px` });
  image.addEventListener("error", () => image.replaceWith(fallback));
  return image;
}

function brokerPoolStats(accounts) {
  const enabled = accounts.filter((account) => account.enabled);
  const readable = enabled.map((account) => ({ account, remainingPercent: freshBrokerQuotaRemainingPercent(account.quota) }))
    .filter((entry) => entry.remainingPercent !== null);
  // Stale or unknown values are not capacity and cannot inflate a displayed
  // pool. Withhold the aggregate until every enabled account has a current
  // proof; individual fresh rows remain useful.
  const complete = enabled.length > 0 && readable.length === enabled.length;
  const remainingPercent = complete
    ? readable.reduce((total, entry) => total + entry.remainingPercent, 0) : null;
  const allDepleted = enabled.length > 0 && readable.length === enabled.length && readable.every((entry) => entry.remainingPercent === 0);
  const resets = readable.filter((entry) => entry.remainingPercent === 0).map((entry) => entry.account.quota?.resetAt).filter(Boolean).sort();
  return {
    enabled: enabled.length,
    assigned: accounts.reduce((total, account) => total + account.assignedTaskCount, 0),
    remainingPercent,
    complete,
    allDepleted,
    earliestResetAt: allDepleted ? resets[0] || null : null,
  };
}

function brokerQuotaText(quota) {
  const remainingPercent = freshBrokerQuotaRemainingPercent(quota);
  const refresh = quota?.refreshState === "loading" ? " · refreshing"
    : quota?.refreshState === "error" ? " · refresh failed" : "";
  if (remainingPercent === null) {
    if (quota?.refreshState === "loading") return "Refreshing usage…";
    if (quota?.errorCode === "authentication") return "Sign in again to refresh usage";
    if (quota?.errorCode === "connection") return "Usage refresh could not connect";
    return "Usage not available";
  }
  if (remainingPercent === 0) return `Usage depleted${quota.resetAt ? ` · resets ${formatResetAt(quota.resetAt)}` : ""}${refresh}`;
  return `${remainingPercent}% usage left${quota.resetAt ? ` · resets ${formatResetAt(quota.resetAt)}` : ""}${refresh}`;
}

function brokerUsageValueText(selected, pool) {
  if (selected) {
    const remainingPercent = freshBrokerQuotaRemainingPercent(selected.quota);
    return remainingPercent === null ? "Not available" : `${remainingPercent}% left`;
  }
  return pool.remainingPercent === null ? "Not available" : `${pool.remainingPercent}% pooled`;
}

/** Broker quota is numeric capacity only while the provider fact is fresh. */
function freshBrokerQuotaRemainingPercent(quota) {
  if (quota?.freshness !== "fresh" || !Number.isFinite(quota.remainingPercent)) return null;
  return Math.max(0, Math.min(100, Math.round(quota.remainingPercent)));
}

function brokerPoolQuotaText(stats) {
  return stats.remainingPercent === null ? "Pooled usage is incomplete" : `${stats.remainingPercent}% pooled usage left`;
}

function connectionStatusLabel(status) {
  return ({ connected: "Connected", setup_required: "Setup required", expired: "Expired", unavailable: "Unavailable" })[status] || "Unavailable";
}

function brokerAccountStatusLabel(account) {
  if (!account?.enabled || account.status === "disabled") return "Disabled";
  if (account.status === "depleted") return "Usage depleted";
  if (account.status === "reauth_required") return "Sign in again";
  if (account.continuityState === "deferred") return account.continuityReason === "recovery_required"
    ? "Settings recovery needed" : account.continuityReason === "account_in_use"
      ? "Settings waiting for idle" : "Settings migration pending";
  if (account.currentTaskOwner) return "Current task owner";
  if (account.status === "ready" || account.status === "active") return "Ready";
  return "Status unavailable";
}

function brokerContinuityDetail(account) {
  if (account.continuityReason === "recovery_required") return "A settings migration was interrupted or could not be verified. Recovery must finish before the next launch can apply shared settings. Your existing settings are still in use.";
  if (account.continuityReason === "account_in_use") return `${account.continuityBlocker ? `${account.continuityBlocker} is using` : "Another process is using"} this account’s settings folder. Tweakers will retry shared settings on a later idle launch. No app or helper will be closed automatically.`;
  if (account.continuityReason === "source_changed") return "The shared settings source changed during verification. Existing settings are still in use; Tweakers will retry on a later idle launch.";
  return "Existing settings are still in use. The shared settings source needs a one-time migration, which Tweakers will attempt on a later idle launch. No app or helper will be closed automatically.";
}

function enabledLifecycleMessage(account, lifecycle) {
  if (account.enabled) return lifecycle === "lazy" ? `${account.label} is enabled and will start only when new work needs it.` : `${account.label} is enabled.`;
  if (lifecycle === "active_runs_finishing") return `${account.label} will receive no new work; active work can finish.`;
  if (lifecycle === "idle_child_stopped") return `${account.label} is disabled and its idle child stopped.`;
  return `${account.label} is disabled and will receive no new work.`;
}

function statusBrokerFailure(state, code) {
  if (state?.brokerStatus) state.brokerStatus.textContent = accountBrokerDisplayMessage(code);
}

async function startBrokerEnrollment(state, command, accountId = null) {
  const response = await invokeAccountBroker(state, command, accountId ? { accountId } : undefined);
  if (state.disposed) return;
  if (!response.ok) { statusBrokerFailure(state, response.error?.code); return; }
  state.activeEnrollment = response.result.enrollment;
  scheduleBrokerEnrollmentStatus(state, command, state.activeEnrollment);
  refreshBrokerRoots(state);
}

async function cancelBrokerEnrollment(state, enrollment) {
  const command = enrollment.accountId ? "reconnect.cancel" : "enrollment.cancel";
  const response = await invokeAccountBroker(state, command, { enrollmentId: enrollment.enrollmentId });
  if (state.disposed) return;
  if (!response.ok) { statusBrokerFailure(state, response.error?.code); return; }
  clearBrokerEnrollmentTimer(state, enrollment.enrollmentId);
  state.activeEnrollment = response.result.enrollment;
  refreshBrokerRoots(state);
}

function scheduleBrokerEnrollmentStatus(state, startCommand, enrollment) {
  if (!enrollment?.enrollmentId || state.disposed) return;
  clearBrokerEnrollmentTimer(state, enrollment.enrollmentId);
  const expires = enrollment.expiresAt ? Date.parse(enrollment.expiresAt) : NaN;
  if (Number.isFinite(expires) && expires <= Date.now()) {
    state.activeEnrollment = { ...enrollment, state: "expired", userCode: null, verificationUrl: null };
    void cancelBrokerEnrollment(state, state.activeEnrollment);
    return;
  }
  if (["complete", "cancelled", "failed", "expired"].includes(enrollment.state)) return;
  const command = startCommand.startsWith("reconnect") ? "reconnect.status" : "enrollment.status";
  const timeout = Math.max(250, Math.min(2_000, Number.isFinite(expires) ? expires - Date.now() : 2_000));
  const timer = window.setTimeout(async () => {
    state.enrollmentTimers.delete(enrollment.enrollmentId);
    if (state.disposed || state.activeEnrollment?.enrollmentId !== enrollment.enrollmentId) return;
    const response = await invokeAccountBroker(state, command, { enrollmentId: enrollment.enrollmentId });
    if (!response.ok) { statusBrokerFailure(state, response.error?.code); return; }
    state.activeEnrollment = response.result.enrollment;
    scheduleBrokerEnrollmentStatus(state, startCommand, state.activeEnrollment);
    refreshBrokerRoots(state);
  }, timeout);
  state.enrollmentTimers.set(enrollment.enrollmentId, timer);
}

function clearBrokerEnrollmentTimer(state, enrollmentId) {
  const timer = state.enrollmentTimers.get(enrollmentId);
  if (timer) window.clearTimeout(timer);
  state.enrollmentTimers.delete(enrollmentId);
}

function publishAccountsContext(state) {
  syncAccountsNativeSelections(state);
  projectNativeUsageResetModal(state);
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function" || !state.profile) return;
  const accounts = state.profile.accounts.map((account) => ({
    accountId: account.accountId,
    label: account.label,
    enabled: account.enabled,
    quota: account.quota,
  }));
  const detail = { version: ACCOUNT_BROKER_VERSION, selectedAccountId: state.selectedAccountId, accounts };
  // Do not truncate a pool for Usage Tracker. If the complete bounded context
  // cannot fit the agreed envelope, retain ownership in Accounts rather than
  // misleading Usage with a partial account selector.
  if (!isSerializedValueWithinBound(detail)) return;
  try {
    window.dispatchEvent(new CustomEvent("tweakers:accounts-context", {
      detail,
    }));
  } catch {}
}

function syncAccountsNativeSelections(state) {
  const select = state?.api?.accountsNative?.select;
  if (typeof select !== "function") return;
  const accounts = state.profile?.accounts || [];
  const known = new Set(accounts.map((account) => account.accountId));
  const selected = known.has(state.selectedAccountId) ? state.selectedAccountId : accounts[0]?.accountId || null;
  const owner = accounts.find((account) => account.currentTaskOwner)?.accountId || selected;
  const profile = state.profileStatisticsSelection === "pooled" ? null
    : known.has(state.profileStatisticsSelection) ? state.profileStatisticsSelection : null;
  const usage = known.has(state.usageSelectionId) ? state.usageSelectionId : selected;
  try {
    select("account-menu", selected);
    select("profile", profile);
    select("usage", usage);
    select("thread-summary", owner);
    // Plugins and Skills keep their native page; no per-account selector is mounted.
    select("plugins", selected);
    for (const definition of ACCOUNT_NATIVE_CONNECTION_SURFACES) {
      const accountId = nativeConnectionSelectionForBridge(state, definition, accounts, selected);
      select(definition.surface, accountId);
    }
  } catch { /* an unavailable compatibility bridge keeps native fallbacks */ }
}

function nativeConnectionSelectionForBridge(state, definition, accounts, fallback) {
  const known = new Set(accounts.map((account) => account.accountId));
  const remembered = safeBrokerAccountId(state.nativeConnectionSelections?.get?.(definition.kind));
  return remembered && known.has(remembered) ? remembered : fallback;
}

async function requestAccountsNativeValue(state, surface, method, params, selection) {
  if (state?.disposed || !["profile", "apps", "plugins", "mcp", "usage"].includes(surface)
    || !isRecord(params) || !selection || !Number.isSafeInteger(selection.generation)) {
    throw new Error("invalid-native-request");
  }
  const accountId = safeBrokerAccountId(selection.accountId);
  if (surface === "profile" && method === "profile.statistics") {
    const requested = accountId || "pooled";
    const response = await invokeAccountBroker(state, "profile.statistics", { selection: requested });
    if (!response.ok) throw new Error(response.error?.code || "broker_unavailable");
    return nativeWhamProfile(state, response.result, accountId);
  }
  if (surface === "usage" && method === "usage.status") {
    if (Object.keys(params).join("\0") !== "native") throw new Error("invalid-native-request");
    return projectNativeUsageStatus(state, params.native);
  }
  if (!accountId || !state.profile?.accounts?.some((account) => account.accountId === accountId)) {
    throw new Error("account_unavailable");
  }
  const response = await invokeAccountBroker(state, "native.request", { accountId, surface, method, params });
  if (!response.ok || response.result?.accountId !== accountId || response.result?.surface !== surface) {
    throw new Error(response.error?.code || "broker_invalid_response");
  }
  return response.result.result;
}

function projectAccountsNativeValue(state, surface, kind, input) {
  if (surface !== "usage") return input;
  if (kind === "windows") return projectNativeUsageWindows(state, input);
  if (kind === "depleted-message") {
    const accounts = state?.profile?.accounts || [];
    const pool = brokerPoolStats(accounts);
    if (pool.allDepleted) {
      return `All enabled subscriptions are depleted${pool.earliestResetAt ? ` until ${formatResetAt(pool.earliestResetAt)}` : ""}.`;
    }
    const enabled = accounts.filter((account) => account.enabled);
    if (enabled.length < 2) return input;
    const remaining = enabled.map((account) => freshBrokerQuotaRemainingPercent(account.quota));
    if (remaining.some((value) => value !== null && value > 0)) {
      return "Usage is still available across your enabled subscriptions. This warning does not mean the subscription pool is exhausted.";
    }
    // Without fresh readings for every enabled subscription, the native
    // account warning cannot be promoted into a claim that the pool is empty.
    return "Pooled usage is incomplete because one or more enabled subscriptions have not reported fresh usage yet.";
  }
  return input;
}

function nativePoolHasIncompleteDepletion(state) {
  const enabled = (state?.profile?.accounts || []).filter((account) => account.enabled);
  if (enabled.length < 2) return false;
  const remaining = enabled.map((account) => freshBrokerQuotaRemainingPercent(account.quota));
  return remaining.some((value) => value === 0) && remaining.some((value) => value === null);
}

function nativeWhamProfile(state, result, accountId) {
  const stats = result?.stats;
  if (!stats) throw new Error("profile_statistics_unavailable");
  const account = accountId
    ? state.profile?.accounts?.find((candidate) => candidate.accountId === accountId)
    : state.profile?.accounts?.find((candidate) => candidate.currentTaskOwner) || state.profile?.accounts?.[0];
  const bucket = (value) => value.map((entry) => ({ start_date: entry.startDate, tokens: entry.tokens }));
  const invocations = stats.topInvocations.map((entry) => ({
    type: entry.type,
    plugin_id: null,
    plugin_name: entry.type === "plugin" ? entry.label : null,
    skill_id: null,
    skill_name: entry.type === "skill" ? entry.label : null,
    usage_count: entry.usageCount,
  }));
  const observedAt = new Date(result.observedAt).toISOString();
  return {
    profile: {
      name: accountId ? account?.label || "Subscription" : "Combined subscriptions",
      email: accountId ? account?.email || null : null,
      profile_picture_url: accountId ? account?.avatarUrl || null : null,
      plan: accountId ? account?.plan || null : null,
    },
    stats: {
      lifetime_tokens: stats.lifetimeTokens,
      peak_daily_tokens: stats.peakDailyTokens,
      current_streak_days: stats.currentStreakDays,
      longest_streak_days: stats.longestStreakDays,
      total_threads: stats.totalThreads,
      longest_running_turn_sec: stats.longestRunningTurnSec,
      fast_mode_usage_percentage: stats.fastModeUsagePercentage,
      total_skills_used: stats.totalSkillsUsed,
      unique_skills_used: stats.uniqueSkillsUsed,
      most_used_reasoning_effort: stats.mostUsedReasoningEffort || "",
      most_used_reasoning_effort_percentage: stats.mostUsedReasoningEffortPercentage,
      daily_usage_buckets: bucket(stats.dailyUsageBuckets),
      cumulative_daily_usage_buckets: bucket(stats.cumulativeDailyUsageBuckets),
      weekly_usage_buckets: bucket(stats.weeklyUsageBuckets),
      top_invocations: invocations,
      workspace_rank: null,
      workspace_total_user_count: null,
    },
    metadata: { stats_as_of: observedAt, generated_at: observedAt, stats_error: null },
  };
}

function nativePooledQuota(state) {
  const accounts = state?.profile?.accounts || [];
  const stats = brokerPoolStats(accounts);
  if (!stats.complete || stats.enabled < 1 || stats.remainingPercent === null) return null;
  const remainingPercent = Math.max(0, Math.min(100, stats.remainingPercent / stats.enabled));
  return { remainingPercent, resetAt: stats.earliestResetAt, allDepleted: stats.allDepleted };
}

function projectNativeUsageWindow(windowValue, quota) {
  if (!isRecord(windowValue) || !quota) return windowValue;
  const usedPercent = Math.max(0, Math.min(100, 100 - quota.remainingPercent));
  const resetSeconds = quota.resetAt ? Math.floor(Date.parse(quota.resetAt) / 1000) : null;
  return {
    ...windowValue,
    ...(Object.prototype.hasOwnProperty.call(windowValue, "used_percent") ? { used_percent: usedPercent } : { usedPercent }),
    ...(Object.prototype.hasOwnProperty.call(windowValue, "remaining_percent")
      ? { remaining_percent: quota.remainingPercent }
      : { remainingPercent: quota.remainingPercent }),
    ...(resetSeconds !== null
      ? Object.prototype.hasOwnProperty.call(windowValue, "reset_at") ? { reset_at: resetSeconds } : { resetsAt: resetSeconds }
      : {}),
  };
}

function projectNativeUsageWindows(state, input) {
  const quota = nativePooledQuota(state);
  return quota && Array.isArray(input) ? input.map((windowValue) => projectNativeUsageWindow(windowValue, quota)) : input;
}

function projectNativeUsageStatus(state, input) {
  if (!isRecord(input)) return input;
  const quota = nativePooledQuota(state);
  if (!quota) return nativePoolHasIncompleteDepletion(state) ? suppressNativeUsageWarnings(input) : input;
  const projectLimits = (limits) => {
    if (!isRecord(limits)) return limits;
    const next = { ...limits };
    for (const key of ["primary", "secondary", "primary_window", "secondary_window"]) {
      if (next[key] !== undefined) next[key] = projectNativeUsageWindow(next[key], quota);
    }
    if (!quota.allDepleted) {
      if (Object.prototype.hasOwnProperty.call(next, "allowed")) next.allowed = true;
      if (Object.prototype.hasOwnProperty.call(next, "limit_reached")) next.limit_reached = false;
      if (Object.prototype.hasOwnProperty.call(next, "rateLimitReached")) next.rateLimitReached = false;
    }
    return next;
  };
  const next = { ...input };
  if (next.rate_limit !== undefined) next.rate_limit = projectLimits(next.rate_limit);
  if (next.rateLimits !== undefined) next.rateLimits = projectLimits(next.rateLimits);
  if (isRecord(next.rateLimitsByLimitId)) {
    next.rateLimitsByLimitId = Object.fromEntries(Object.entries(next.rateLimitsByLimitId).map(([key, value]) => [key, projectLimits(value)]));
  }
  return quota.allDepleted ? next : suppressNativeUsageWarnings(next);
}

function suppressNativeUsageWarnings(input) {
  const next = { ...input };
  if (Object.prototype.hasOwnProperty.call(next, "rate_limit_upsell")) next.rate_limit_upsell = null;
  if (Object.prototype.hasOwnProperty.call(next, "rate_limit_reached_type")) next.rate_limit_reached_type = null;
  if (Object.prototype.hasOwnProperty.call(next, "rateLimitReachedType")) next.rateLimitReachedType = null;
  if (Object.prototype.hasOwnProperty.call(next, "sidebar_usage_warnings")) next.sidebar_usage_warnings = null;
  if (Object.prototype.hasOwnProperty.call(next, "model_picker_upsell")) next.model_picker_upsell = null;
  if (Object.prototype.hasOwnProperty.call(next, "rate_limit_warning")) next.rate_limit_warning = null;
  return next;
}

/**
 * The 9275 reset offer reads an app-primary rate-limit query that is separate
 * from the settings usage request. Keep its real subscription price and reset
 * actions, while preventing one depleted subscription from being presented as
 * exhaustion of a freshly positive pool.
 */
function projectNativeUsageResetModal(state, root = typeof document === "undefined" ? null : document) {
  const accounts = (state?.profile?.accounts || []).filter((account) => account.enabled);
  const positivePool = accounts.length >= 2 && accounts.some((account) => {
    const remaining = freshBrokerQuotaRemainingPercent(account.quota);
    return remaining !== null && remaining > 0;
  });
  if (!positivePool) {
    restoreNativeUsageResetProjections(state);
    return 0;
  }
  if (!root?.querySelectorAll) return 0;
  let projected = 0;
  for (const dialog of root.querySelectorAll('[role="dialog"]')) {
    if (dialog?.dataset?.tweakersPooledUsageReset === "true" || typeof dialog?.querySelectorAll !== "function") continue;
    const headings = [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')];
    const title = headings.find((element) => /^You['’]re out of usage$/i.test(element.textContent?.trim?.() || ""));
    const weekly = [...dialog.querySelectorAll("span,div,p")]
      .find((element) => element.children?.length === 0 && /^Weekly usage limit$/i.test(element.textContent?.trim?.() || ""));
    const text = dialog.textContent || "";
    const resetButton = [...dialog.querySelectorAll("button")]
      .some((element) => /^(?:Use available reset|Pay .+ to reset)$/i.test(element.textContent?.trim?.() || ""));
    if (!title || !weekly || !resetButton || !/\b0% left\b/i.test(text)) continue;
    const description = [...dialog.querySelectorAll("span,p")].find((element) => {
      const value = element.textContent?.trim?.() || "";
      return element.children?.length === 0 && (/reset your usage limits/i.test(value) || /banked reset/i.test(value));
    });
    const original = {
      title, titleText: title.textContent, weekly, weeklyText: weekly.textContent,
      description, descriptionText: description?.textContent ?? null, note: null,
    };
    title.textContent = "This subscription is out of usage";
    weekly.textContent = "This subscription’s weekly usage limit";
    const context = "Usage is still available across your enabled subscriptions. The reset options here apply only to this subscription.";
    if (description) description.textContent = `${context} ${description.textContent?.trim?.() || ""}`;
    else {
      const note = root.createElement?.("p");
      if (note) {
        note.textContent = context;
        note.setAttribute?.("role", "status");
        note.setAttribute?.("data-tweakers-pooled-usage-context", "true");
        Object.assign(note.style || {}, { margin: "0 24px 16px", textAlign: "center" });
        dialog.append?.(note);
        original.note = note;
      }
    }
    dialog.dataset.tweakersPooledUsageReset = "true";
    state?.nativeUsageResetProjections?.set?.(dialog, original);
    projected += 1;
  }
  return projected;
}

function restoreNativeUsageResetProjections(state) {
  for (const [dialog, original] of state?.nativeUsageResetProjections || []) {
    if (original.title?.textContent === "This subscription is out of usage") original.title.textContent = original.titleText;
    if (original.weekly?.textContent === "This subscription’s weekly usage limit") original.weekly.textContent = original.weeklyText;
    if (original.description && original.descriptionText !== null
      && original.description.textContent?.startsWith?.("Usage is still available across your enabled subscriptions.")) {
      original.description.textContent = original.descriptionText;
    }
    original.note?.remove?.();
    if (dialog?.dataset) delete dialog.dataset.tweakersPooledUsageReset;
  }
  state?.nativeUsageResetProjections?.clear?.();
}

function installNativeUsageResetModalProjection(state) {
  const Observer = typeof MutationObserver === "function" ? MutationObserver : null;
  if (!Observer || typeof document === "undefined" || !document.documentElement) return;
  const project = () => { if (!state.disposed) projectNativeUsageResetModal(state, document); };
  const observer = new Observer(project);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  state.cleanups.push(() => {
    observer.disconnect();
    restoreNativeUsageResetProjections(state);
  });
  project();
}

async function consumeResetCreditFromUsage(state, accountId, requestId) {
  const response = await invokeAccountBroker(state, "resetCredit.consume", { accountId });
  if (state.disposed) return;
  if (response.ok) {
    if (response.result.quota) updateBrokerAccountQuota(state.profile, accountId, response.result.quota);
    if (response.result.continuation) state.pendingContinuation = response.result.continuation;
    publishAccountsContext(state);
    refreshBrokerRoots(state);
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("tweakers:accounts-reset-credit-result", {
        detail: response.ok
          ? { version: ACCOUNT_BROKER_VERSION, requestId, ok: true, result: response.result }
          : { version: ACCOUNT_BROKER_VERSION, requestId, ok: false, error: { code: response.error?.code || "broker_unavailable" } },
      }));
    } catch {}
  }
}

function renderLegacyAccountsPage(state, root) {
  let disposed = false;
  root.textContent = "Loading accounts…";
  Promise.all([
    state.api.ipc.invoke(IPC, { action: "list" }),
    state.api.ipc.invoke(IPC, { action: "router-status" }).catch(() => null),
  ]).then(([response, routerStatus]) => {
    if (disposed) return;
    root.replaceChildren();
    if (!response?.ok) { root.textContent = "Accounts cannot be loaded right now. Nothing was changed. Reopen Accounts to try again."; return; }
    state.pluginProtectionMode = response.pluginProtection?.mode || "observation";
    const savedAccounts = Array.isArray(response.accounts) ? response.accounts : [];
    const accounts = savedAccounts;
    const liveStatus = routerStatus?.live?.state === "active" && isRecord(routerStatus.live.status)
      ? routerStatus.live.status : null;
    const status = document.createElement("div");
    status.className = "text-token-text-secondary text-sm";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    applyRouterPresentation(status, routerStatus?.router, routerStatus?.live, savedAccounts);
    state.statusElement = status;
    const page = document.createElement("div");
    page.className = "flex flex-col gap-6";
    page.append(combinedProfileCard(accounts, liveStatus));
    page.append(usageSummaryCard(accounts, liveStatus));
    page.append(accountCards(state, accounts, liveStatus, routerStatus?.live));
    page.append(routerControlCard(state, accounts, routerStatus));
    page.append(historyAdoptionCard(routerStatus?.router?.historyAdoption, accounts));
    page.append(accountRecoveryCard(state, accounts, savedAccounts.length, liveStatus, status));
    page.append(advancedAccountsCard(state, savedAccounts, response.pluginProtection, status, routerStatus?.live));
    page.append(accountConnectionsCard(accounts));
    page.append(status);
    root.append(page);
  }).catch(() => { if (!disposed) root.textContent = "Accounts cannot be loaded right now. Nothing was changed. Reopen Accounts to try again."; });
  return () => { disposed = true; root.replaceChildren(); };
}

function settingsCard() {
  const card = document.createElement("div");
  card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  if (card.style) card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  return card;
}

function quotaPoolRemainingPercent(accounts) {
  if (!Array.isArray(accounts) || accounts.length < 1) return null;
  const enabled = accounts.filter((account) => account?.eligibility !== "disabled");
  if (enabled.length < 1) return 0;
  const weekly = enabled.map((account) => account?.weekly);
  const remaining = weekly.map(freshWeeklyRemainingPercent);
  if (remaining.some((value) => value === null)) return null;
  return remaining.reduce((total, value) => total + value, 0);
}

/** Numeric capacity is meaningful only while its provider reading is fresh. */
function freshWeeklyRemainingPercent(value) {
  if (value?.freshness !== "fresh" || !Number.isFinite(value.remainingPercent)) return null;
  return Math.max(0, Math.min(100, Math.round(value.remainingPercent)));
}

function accountDetailsFor(account, liveStatus) {
  if (![ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(liveStatus?.schemaVersion) || !Array.isArray(liveStatus.accounts)) return null;
  // The main process privately associates opaque router identity with the
  // filename-derived renderer ref. Visible labels, emails, and usernames never
  // decide which quota or eligibility row belongs to an account.
  const candidates = liveStatus.accounts.filter((candidate) => candidate?.ref === account.ref);
  return candidates.length === 1 ? candidates[0] : null;
}

function accountDisplayLabel(account) {
  return safeAccountLabel(account?.displayLabel, safeAccountLabel(account?.label, "Saved account"));
}

function accountIdentitySummary(account) {
  const parts = [];
  const username = safeUsername(account?.username);
  const email = safeEmail(account?.email);
  if (username) parts.push(`@${username}`);
  if (email) parts.push(email);
  return parts.join(" · ");
}

function accountUsingNow(account, live) {
  return account?.active === true && live?.state === "not_running";
}

function accountRowStatus(account, detail, live) {
  if (live?.state === "not_running") {
    return accountUsingNow(account, live) ? "Using now" : "Saved — automatic routing is not running yet";
  }
  if (live?.state === "active") {
    if (!detail) return "Status unavailable";
    const mode = live?.status?.active?.mode ?? live?.status?.mode;
    if (mode === "manual") {
      return ["eligible", "reserved", "active"].includes(detail.eligibility)
        ? "Saved account"
        : routerEligibilityLabel(detail.eligibility);
    }
    if (mode === "quota_aware" || mode === "balanced") {
      return ["eligible", "reserved", "active"].includes(detail.eligibility)
        ? "Automatic routing is on"
        : routerEligibilityLabel(detail.eligibility);
    }
  }
  return "Status unavailable";
}

function accountChoiceLabel(account, usingNow = false) {
  const identity = accountIdentitySummary(account);
  const parts = [accountDisplayLabel(account)];
  if (identity) parts.push(identity);
  return `${parts.join(" — ")}${usingNow ? " (Current)" : ""}`;
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
  if (pool === null) return liveStatus ? "Cannot check right now" : "Not available yet";
  return `${pool}% total`;
}

function usageSummaryCard(accounts, liveStatus) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = "Weekly usage left";
  const detail = document.createElement("div");
  detail.className = "text-token-text-secondary min-w-0 text-sm";
  detail.textContent = accounts.length === 0 ? "No subscriptions saved" : `${accounts.length} saved ${accounts.length === 1 ? "subscription" : "subscriptions"}`;
  copy.append(title, detail);
  if (accounts.length > 0) {
    const selector = document.createElement("select");
    selector.className = "border-token-border bg-token-foreground/5 mt-2 max-w-[260px] rounded-md border px-2 py-1 text-sm text-token-text-primary";
    selector.setAttribute("aria-label", "Usage subscription");
    const pooled = document.createElement("option");
    pooled.value = ""; pooled.textContent = "All subscriptions"; selector.append(pooled);
    for (const account of accounts) {
      const option = document.createElement("option");
      option.value = account.ref; option.textContent = accountDisplayLabel(account); selector.append(option);
    }
    selector.addEventListener("change", () => {
      const selected = accounts.find((account) => account.ref === selector.value);
      const details = selected ? accountDetailsFor(selected, liveStatus) : null;
      const weeklyRemaining = freshWeeklyRemainingPercent(details?.weekly);
      value.textContent = selected
        ? (weeklyRemaining === null ? "Not available yet" : `${weeklyRemaining}%`)
        : quotaSummaryText(liveStatus);
    });
    copy.append(selector);
  }
  const value = document.createElement("div");
  value.className = "shrink-0 text-sm text-token-text-secondary";
  value.textContent = quotaSummaryText(liveStatus);
  row.append(copy, value);
  card.append(row);
  return card;
}

function combinedProfileCard(accounts, liveStatus) {
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Combined profile";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  const assigned = accounts.reduce((total, account) => total + (accountDetailsFor(account, liveStatus)?.assignedThreadCount || 0), 0);
  detail.textContent = `${accounts.length} ${accounts.length === 1 ? "subscription" : "subscriptions"} · ${assigned} assigned ${assigned === 1 ? "task" : "tasks"}`;
  copy.append(title, detail);
  const avatars = document.createElement("div");
  avatars.className = "flex -space-x-2";
  for (const account of accounts) {
    const avatar = accountAvatar(accountDisplayLabel(account));
    avatar.className += " border-2 border-token-bg-primary";
    avatars.append(avatar);
  }
  row.append(copy, avatars);
  card.append(row);
  return card;
}

function accountConnectionsCard(accounts) {
  const card = settingsCard();
  const header = document.createElement("div");
  header.className = "flex flex-col gap-2 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Apps, Plugins, and MCP connections";
  const note = document.createElement("div");
  note.className = "text-sm text-token-text-secondary";
  note.textContent = "Shared Skills and installed plugin packages are read-only. Connection status is separate for each subscription. Only MCP can be authorized here; Apps and Plugins are status-only. Credentials are never copied between account homes.";
  const selector = document.createElement("select");
  selector.className = "border-token-border bg-token-foreground/5 max-w-[280px] rounded-md border px-2 py-1 text-sm text-token-text-primary";
  selector.setAttribute("aria-label", "Connection subscription");
  for (const account of accounts) {
    const option = document.createElement("option"); option.value = account.ref; option.textContent = accountDisplayLabel(account); selector.append(option);
  }
  header.append(title, note, selector);
  const rows = document.createElement("div");
  rows.className = "flex flex-col divide-y-[0.5px] divide-token-border";
  const render = () => {
    rows.replaceChildren();
    const account = accounts.find((candidate) => candidate.ref === selector.value) || accounts[0];
    for (const [key, label] of [["apps", "Apps"], ["plugins", "Plugins"], ["mcp", "MCP"]]) {
      const row = document.createElement("div"); row.className = "flex items-center justify-between p-3 text-sm";
      const state = safeConnectionState(account?.connections?.[key]);
      const status = state === "connected" ? "Connected" : state === "expired" ? "Expired" : state === "unavailable" ? "Unavailable" : "Setup required";
      const name = document.createElement("span"); name.textContent = label;
      const value = document.createElement("span"); value.className = "text-token-text-secondary"; value.textContent = status;
      row.append(name, value); rows.append(row);
    }
  };
  selector.addEventListener("change", render); render();
  card.append(header, rows);
  return card;
}

function usernameEditorButton(state, account, identityText) {
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "text-token-text-secondary hover:text-token-text-primary text-xs underline underline-offset-2";
  edit.textContent = safeUsername(account?.username) ? "Edit username" : "Add username";
  edit.setAttribute("aria-label", `${edit.textContent} for ${accountDisplayLabel(account)}`);
  edit.addEventListener("click", async () => {
    const entered = window.prompt(
      `Username for ${accountDisplayLabel(account)} (without @). Leave blank to remove it.`,
      safeUsername(account?.username),
    );
    if (entered === null) return;
    const requested = entered.trim();
    if (requested && !safeUsername(requested)) {
      window.alert("Use only letters, numbers, dots, dashes, or underscores for the username.");
      return;
    }
    try {
      const result = await state.api.ipc.invoke(IPC, {
        action: "account-username-set",
        ref: account.ref,
        username: requested,
      });
      if (!result?.ok) {
        alertFailure(state, "The username could not be saved safely.", result);
        return;
      }
      account.username = result.username || null;
      identityText.textContent = accountIdentitySummary(account) || "Account email not available yet";
      edit.textContent = account.username ? "Edit username" : "Add username";
      edit.setAttribute("aria-label", `${edit.textContent} for ${accountDisplayLabel(account)}`);
      if (state.statusElement) {
        state.statusElement.textContent = account.username
          ? `Username @${account.username} was saved locally for ${accountDisplayLabel(account)}.`
          : `The local username was removed from ${accountDisplayLabel(account)}.`;
      }
    } catch {
      window.alert("The username could not be saved safely.");
    }
  });
  return edit;
}

function accountCards(state, accounts, liveStatus, live) {
  const card = settingsCard();
  if (accounts.length === 0) {
    const row = document.createElement("div");
    row.className = "p-3 text-sm text-token-text-secondary";
    row.textContent = "Add another subscription to create an account pool.";
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
    title.textContent = accountDisplayLabel(account);
    const identityRow = document.createElement("div");
    identityRow.className = "flex min-w-0 items-center gap-2";
    const identityText = document.createElement("span");
    identityText.className = "text-token-text-secondary truncate text-xs";
    identityText.textContent = accountIdentitySummary(account) || "Account email not available yet";
    identityRow.append(identityText, usernameEditorButton(state, account, identityText));
    const meta = document.createElement("div");
    meta.className = "text-token-text-secondary truncate text-sm";
    const plan = detail?.plan || "Plan not available yet";
    const weeklyRemaining = freshWeeklyRemainingPercent(detail?.weekly);
    const weekly = weeklyRemaining === null ? "Weekly usage not available yet" : `${weeklyRemaining}% weekly usage left`;
    meta.textContent = `${plan} · ${weekly}`;
    copy.append(title, identityRow, meta);
    identity.append(accountAvatar(accountDisplayLabel(account)), copy);
    const statusNode = document.createElement("div");
    statusNode.className = "text-token-text-secondary shrink-0 text-right text-sm";
    const freshness = detail?.weekly?.freshness === "fresh" ? "Usage is current" : "Usage not checked";
    const reset = detail?.weekly?.resetAt ? ` · resets ${formatResetAt(detail.weekly.resetAt)}` : "";
    const threads = Number.isInteger(detail?.assignedThreadCount) ? ` · ${detail.assignedThreadCount} assigned ${detail.assignedThreadCount === 1 ? "thread" : "threads"}` : "";
    const rowStatus = accountRowStatus(account, detail, live);
    statusNode.textContent = `${rowStatus} · ${freshness}${reset}${threads}`;
    statusNode.setAttribute("aria-label", `${accountDisplayLabel(account)}: ${rowStatus}`);
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 flex-col items-end gap-2";
    const buttons = document.createElement("div");
    buttons.className = "flex gap-2";
    const rename = document.createElement("button");
    rename.type = "button"; rename.className = "text-token-text-secondary text-xs underline"; rename.textContent = "Rename";
    rename.addEventListener("click", async () => {
      const entered = window.prompt(`Name for ${accountDisplayLabel(account)}`, accountDisplayLabel(account));
      if (entered === null) return;
      const result = await state.api.ipc.invoke(IPC, { action: "account-profile-set", ref: account.ref, label: entered.trim() });
      if (result?.ok) { account.displayLabel = result.profile.label; title.textContent = result.profile.label; }
      else alertFailure(state, "The subscription name could not be saved.", result);
    });
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "text-token-text-secondary text-xs underline";
    toggle.textContent = account.enabled === false ? "Enable" : "Disable";
    toggle.addEventListener("click", async () => {
      const enabled = account.enabled === false;
      const result = await state.api.ipc.invoke(IPC, { action: "account-profile-set", ref: account.ref, enabled });
      if (result?.ok) {
        account.enabled = enabled;
        toggle.textContent = enabled ? "Disable" : "Enable";
        if (state.statusElement) state.statusElement.textContent = `${accountDisplayLabel(account)} is ${enabled ? "enabled" : "disabled"} for the next saved routing setup.`;
      } else alertFailure(state, "The subscription setting could not be saved.", result);
    });
    buttons.append(rename, toggle);
    if (Number.isInteger(detail?.resetCredits) && detail.resetCredits > 0) {
      const consume = document.createElement("button");
      consume.type = "button";
      consume.className = "text-token-text-secondary text-xs underline";
      consume.textContent = `Use reset credit (${detail.resetCredits})`;
      consume.setAttribute("aria-label", `Use one usage reset credit for ${accountDisplayLabel(account)}`);
      consume.addEventListener("click", async () => {
        if (!window.confirm(`Use one banked usage reset credit for ${accountDisplayLabel(account)}? This cannot be undone and will never happen automatically.`)) return;
        try {
          const result = await state.api.ipc.invoke(IPC, { action: "account-reset-consume", ref: account.ref });
          if (!result?.ok) {
            alertFailure(state, "The reset credit was not used.", result);
            return;
          }
          consume.disabled = true;
          consume.textContent = "Reset credit used";
          if (state.statusElement) state.statusElement.textContent = `One reset credit was used for ${accountDisplayLabel(account)}. Reopen Accounts to refresh usage.`;
        } catch {
          window.alert("The reset credit was not used.");
        }
      });
      buttons.append(consume);
    }
    actions.append(statusNode, buttons);
    row.append(identity, actions);
    card.append(row);
  }
  return card;
}

function formatResetAt(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "later";
}

function routerEligibilityLabel(value) {
  if (value === "reauth_required") return "Sign in again";
  if (value === "quota_depleted") return "Weekly usage used up";
  if (value === "active") return "Ready for new conversations";
  if (value === "eligible") return "Ready for new conversations";
  if (value === "reserved") return "Ready for new conversations";
  if (value === "validating") return "Checking account";
  if (value === "cooldown") return "Waiting before next use";
  if (value === "plugin_blocked") return "Plugin check is blocking this account";
  if (value === "protocol_blocked") return "Routing update required";
  if (value === "disabled") return "Not enabled for routing";
  if (value === "unhealthy") return "This account needs attention";
  return "Status not available yet";
}

function routerControlCard(state, accounts, initialStatus = null) {
  const card = settingsCard();
  const summary = document.createElement("div");
  summary.className = "flex flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Automatic routing for new conversations";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  description.textContent = "New conversations use the best enabled subscription based on quota, freshness, short-window pressure, reset timing, and assigned load. Active work stays with its current owner.";
  summary.append(title, description);
  const body = document.createElement("div");
  body.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const status = document.createElement("div");
  status.className = "text-token-text-secondary min-w-0 text-sm";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  applyRouterPresentation(status, initialStatus?.router, initialStatus?.live, accounts);
  const controls = document.createElement("div");
  controls.className = "flex flex-wrap items-center gap-2";
  const historyOwner = document.createElement("select");
  historyOwner.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer max-w-[240px] rounded-md border px-3 text-sm text-token-text-primary";
  historyOwner.setAttribute("aria-label", "Which account should keep my existing conversations?");
  const historyPrompt = document.createElement("option");
  historyPrompt.value = "";
  historyPrompt.textContent = "Choose where current conversations stay";
  historyPrompt.disabled = true;
  historyPrompt.selected = true;
  historyOwner.append(historyPrompt);
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.ref;
    option.textContent = accountChoiceLabel(account, accountUsingNow(account, initialStatus?.live));
    historyOwner.append(option);
  }
  let legacyOwnerRef = null;
  const stage = document.createElement("button");
  stage.type = "button";
  stage.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary disabled:cursor-not-allowed disabled:opacity-60";
  stage.textContent = "Set up automatic routing";
  const updateStageAvailability = () => { stage.disabled = accounts.length < 2 || legacyOwnerRef === null; };
  updateStageAvailability();
  historyOwner.addEventListener("change", () => {
    legacyOwnerRef = accounts.some((account) => account.ref === historyOwner.value) ? historyOwner.value : null;
    updateStageAvailability();
  });
  stage.addEventListener("click", async () => {
    if (accounts.length < 2) { reportRouterControlFailure(state, status, "router-requires-at-least-two-accounts"); return; }
    if (!legacyOwnerRef) { reportRouterControlFailure(state, status, "router-history-owner-required"); return; }
    status.textContent = "Saving the account pool. Nothing changes until the conversation step is finished and Codex restarts.";
    try {
      const enabled = accounts.filter((account) => account.enabled !== false);
      const primary = enabled.find((account) => account.active) || enabled[0];
      const result = await state.api.ipc.invoke(IPC, { action: "router-configure", mode: "quota_aware", refs: accounts.map((account) => account.ref), enabledRefs: enabled.map((account) => account.ref), primaryRef: primary?.ref, legacyOwnerRef, weights: accounts.map(() => 1) });
      if (result?.ok) applyRouterPresentation(status, result.router, result.live, accounts);
      else reportRouterControlFailure(state, status, result?.error?.code);
    } catch { reportRouterControlFailure(state, status); }
  });
  controls.append(historyOwner, stage);
  body.append(status, controls);
  card.append(summary, body);
  return card;
}

function historyAdoptionCard(projection, accounts = []) {
  const history = projection && ["required", "pending_offline_adoption", "adopted", "invalid", "mismatch"].includes(projection.state)
    ? projection : { state: "required", ownerLabel: null, importedThreadCount: 0, databaseCount: 0, historyCount: 0 };
  const card = settingsCard();
  const row = document.createElement("div");
  row.className = "flex min-w-0 flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Your current conversations";
  const detail = document.createElement("div");
  detail.className = "text-token-text-secondary text-sm";
  const ownerAccount = accounts.find((account) => history.ownerRef && account.ref === history.ownerRef);
  // The saved router label may be an old generic filename such as account-2.
  // Only a main-projected, renderer-safe ref may select a visible identity.
  const ownerDisplayLabel = ownerAccount ? accountDisplayLabel(ownerAccount) : "";
  if (history.state === "pending_offline_adoption") {
    detail.textContent = `${ownerDisplayLabel || "The selected account"} will keep your current conversations. Next, quit Codex and finish the offline conversation setup. Nothing has moved yet.`;
  } else if (history.state === "adopted") {
    detail.textContent = `Current conversations are assigned to ${ownerDisplayLabel || "the selected account"}: ${history.importedThreadCount} conversations across ${history.databaseCount} data stores and ${history.historyCount} history groups.`;
  } else if (history.state === "invalid") {
    detail.textContent = "We could not verify the saved conversation setup. No new conversation change was made.";
  } else if (history.state === "mismatch") {
    detail.textContent = "The saved conversation setup belongs to different accounts. No new conversation change was made.";
  } else {
    detail.textContent = "Choose which account should keep the conversations you already have. Saving this choice does not move anything or restart Codex.";
  }
  row.append(title, detail);
  card.append(row);
  return card;
}

function routerPresentation(router, live, savedSnapshotCount) {
  const savedCount = Number.isInteger(savedSnapshotCount) && savedSnapshotCount >= 0 ? savedSnapshotCount : 0;
  const liveStatus = live?.state === "active" && isRecord(live.status) ? live.status : null;
  if (liveStatus?.degradedReason) return { label: "Automatic routing needs attention", message: "Codex reported a routing problem. New conversations will pause rather than use the wrong account.", accounts: [] };
  if ([ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(liveStatus?.schemaVersion)) {
    const active = liveStatus.active;
    const pending = liveStatus.pending;
    const savedSetupNotice = router?.degradedReason
      ? " The saved setup needs attention, but it does not replace the routing already running."
      : "";
    if (active?.mode === "quota_aware") return {
      label: "Automatic routing is on",
      message: pending
        ? `Automatic routing is running for new conversations. A saved routing change will apply after you restart Codex. Current conversations stay with their assigned account.${savedSetupNotice}`
        : `New conversations can use the best enabled subscription. Current conversations stay with the account that started them.${savedSetupNotice}`,
      accounts: Array.isArray(liveStatus.accounts) ? liveStatus.accounts : [],
    };
    if (pending) return {
      label: "Routing change saved — not active yet",
      message: "The saved change will apply after you restart Codex. The running app has not changed.",
      accounts: [],
    };
    if (active?.mode === "manual") return { label: "Manual routing is on", message: "You choose which account to use for new conversations.", accounts: [] };
    return { label: "Routing status cannot be checked", message: "No routing change is being claimed.", accounts: [] };
  }
  if (liveStatus?.mode === "balanced") {
    return {
      label: "Automatic routing is on",
      message: "New conversations can use either account. Current conversations stay with their assigned account.",
      accounts: Array.isArray(liveStatus.accounts) ? liveStatus.accounts : [],
    };
  }
  if (router?.degradedReason) return { label: "Automatic routing needs attention", message: "The saved setup could not be verified. The running routing has not changed.", accounts: [] };
  if ([ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(router?.schemaVersion) && router?.pending?.mode === "manual"
    && router?.historyAdoption?.state === "adopted") return {
    label: "Manual routing is saved — not active yet",
    message: "After the next restart, you will choose the account for new conversations. Current conversations will stay with their assigned account.",
    accounts: [],
  };
  if ([ACCOUNT_ROUTER_V2_SCHEMA_VERSION, ACCOUNT_ROUTER_SCHEMA_VERSION].includes(router?.schemaVersion) && router?.pending) return {
    label: "Automatic routing setup is saved — not active yet",
    message: "Finish the conversation setup, then restart Codex when you are ready. The running app has not changed.",
    accounts: [],
  };
  if (router?.mode === "direct_fallback") return { label: "Manual fallback is saved", message: "Restart Codex to apply it. Current routing could not be checked.", accounts: [] };
  if (router?.mode === "balanced" || router?.restartRequired) return { label: "Automatic routing setup is saved — not active yet", message: "Restart Codex later to apply it. The running app has not changed.", accounts: [] };
  if (savedCount === 0) return { label: "Save two accounts", message: "Save this account, switch to another subscription, then save that one too.", accounts: [] };
  if (savedCount === 1) return { label: "Save one more account", message: "Add another subscription to create an automatic-routing pool.", accounts: [] };
  return { label: "Ready to set up", message: `${savedCount} subscriptions are saved. Choose where current conversations stay, then set up automatic routing.`, accounts: [] };
}

function applyRouterPresentation(status, router, live, savedAccountsOrCount) {
  const savedAccounts = Array.isArray(savedAccountsOrCount) ? savedAccountsOrCount : [];
  const savedCount = Array.isArray(savedAccountsOrCount) ? savedAccountsOrCount.length : savedAccountsOrCount;
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
      const saved = savedAccounts.find((candidate) => account.ref && candidate.ref === account.ref);
      const displayLabel = accountDisplayLabel(saved || account);
      item.textContent = `${displayLabel}: ${account.assignedThreadCount} assigned ${account.assignedThreadCount === 1 ? "conversation" : "conversations"} · ${routerEligibilityLabel(account.eligibility)}.`;
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
  title.textContent = "Connect or repair accounts";
  const note = document.createElement("div");
  note.className = "text-token-text-secondary text-sm";
  const stale = accounts.find((account) => accountDetailsFor(account, liveStatus)?.eligibility === "reauth_required");
  const staleLabel = stale ? accountDisplayLabel(stale) : null;
  note.textContent = stale
    ? `${staleLabel} needs you to sign in again. Switch to it below, sign in, then return here and refresh it.`
    : savedSnapshotCount >= 2
      ? `${savedSnapshotCount} subscriptions are saved. Check their names before setting up automatic routing.`
      : savedSnapshotCount === 1
          ? "One account is saved. Switch to your other account and save it here too."
          : "Save this account, switch to your other account, then save that account too.";
  if (accounts.some((account) => /^account-\d+$/i.test(account?.label || ""))) {
    note.textContent += " Old saved-account numbers can skip, so a missing number does not mean an account is missing.";
  }
  copy.append(title, note);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer shrink-0 rounded-md border px-3 text-sm text-token-text-primary";
  save.textContent = stale ? `Refresh ${staleLabel}` : "Save this account";
  save.addEventListener("click", async () => {
    if (stale) {
      status.textContent = `Checking that routing is stopped before refreshing ${staleLabel}…`;
      try {
        const refreshed = await state.api.ipc.invoke(IPC, { action: "router-recover", ref: stale.ref });
        status.textContent = refreshed?.ok
          ? `${staleLabel} was refreshed. Restart Codex later to use the updated routing. Current routing has not changed.`
          : routerControlFailure(refreshed?.error?.code).message;
      } catch { status.textContent = "The reauthenticated account could not be refreshed safely."; }
      return;
    }
    status.textContent = "Saving this account…";
    const saved = await saveCurrentFromMenu(state);
    status.textContent = saved ? "Account saved. Reopen Accounts to refresh the list." : "No account was saved.";
  });
  const actions = document.createElement("div");
  actions.className = "flex shrink-0 gap-2";
  const add = document.createElement("button");
  add.type = "button";
  add.className = save.className;
  add.textContent = "Add another subscription";
  add.addEventListener("click", async () => {
    status.textContent = "Starting secure device-code sign-in…";
    try {
      const started = await state.api.ipc.invoke(IPC, { action: "account-enroll-start" });
      if (!started?.ok || !started.enrollment?.id) {
        status.textContent = "Device-code sign-in is unavailable right now. Nothing was changed.";
        return;
      }
      pollAccountEnrollment(state, started.enrollment.id, status);
    } catch { status.textContent = "Device-code sign-in is unavailable right now. Nothing was changed."; }
  });
  actions.append(add, save);
  row.append(copy, actions);
  card.append(row);
  return card;
}

function pollAccountEnrollment(state, id, status) {
  if (state.disposed) return;
  state.api.ipc.invoke(IPC, { action: "account-enroll-status", id }).then((result) => {
    const enrollment = result?.enrollment;
    if (!result?.ok || !enrollment) { status.textContent = "Device-code sign-in could not be checked."; return; }
    if (enrollment.state === "waiting") {
      status.textContent = `Enter code ${enrollment.userCode} in the opened OpenAI sign-in page. This code expires at ${new Date(enrollment.expiresAt).toLocaleTimeString()}.`;
      try { navigator.clipboard?.writeText?.(enrollment.userCode); } catch {}
      if (!state.openedEnrollmentIds) state.openedEnrollmentIds = new Set();
      if (!state.openedEnrollmentIds.has(id)) {
        state.openedEnrollmentIds.add(id);
        void openDeviceSignInFromRenderer(state).then((opened) => {
          if (!opened && !state.disposed) status.textContent = "The external browser could not be opened. Start sign-in again to retry.";
        });
      }
    } else if (enrollment.state === "complete") {
      status.textContent = "Subscription added. Reopen Accounts to see it in the pool.";
      return;
    } else if (["failed", "cancelled"].includes(enrollment.state)) {
      status.textContent = enrollment.state === "cancelled" ? "Sign-in was cancelled." : "The subscription could not be added. Nothing else was changed.";
      return;
    } else {
      status.textContent = "Preparing device-code sign-in…";
    }
    window.setTimeout(() => pollAccountEnrollment(state, id, status), 1_000);
  }).catch(() => { status.textContent = "Device-code sign-in could not be checked."; });
}

function advancedAccountsCard(state, accounts, protection, status, live = null) {
  const card = settingsCard();
  const header = document.createElement("div");
  header.className = "flex flex-col gap-1 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Choose an account yourself";
  const note = document.createElement("div");
  note.className = "text-token-text-secondary text-sm";
  note.textContent = "Manual switching is always available. Routing changes apply only after Codex restarts.";
  header.append(title, note);
  const manualRow = document.createElement("div");
  manualRow.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const manualCopy = document.createElement("div");
  manualCopy.className = "text-token-text-secondary text-sm";
  manualCopy.textContent = "Use one account at a time after your next restart. Both saved accounts and their conversation setup will be kept.";
  const manual = document.createElement("button");
  manual.type = "button";
  manual.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary";
  manual.textContent = "Use manual routing after restart";
  manual.disabled = false;
  manual.addEventListener("click", async () => {
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "router-configure", mode: "manual" });
      status.textContent = result?.ok
        ? "Manual routing is ready for the next restart. Current routing has not changed."
        : routerControlFailure(result?.error?.code).message;
    } catch { status.textContent = "Manual routing could not be saved."; }
  });
  manualRow.append(manualCopy, manual);
  const switches = document.createElement("div");
  switches.className = "flex flex-col divide-y-[0.5px] divide-token-border";
  for (const account of accounts) switches.append(accountButton(state, account, live));
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
  title.textContent = "Plugin check before switching";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  const names = (info.baseline || []).map((plugin) => plugin.name || plugin.id).join(", ");
  description.textContent = `Checks whether this account has the required plugins: ${names || "none"}. Last check: ${pluginStatusLabel(info.active)}.`;
  summary.append(title, description);
  const actions = document.createElement("div");
  actions.className = "flex flex-wrap items-center justify-between gap-3 p-3";
  const note = document.createElement("div");
  note.className = "max-w-xl text-sm text-token-text-secondary";
  note.textContent = info.mode === "enforcement"
    ? "Blocking is on. An account must pass the plugin check before switching, but you can approve one switch when needed."
    : "Warnings only are on. You will see a warning when an account has not passed the plugin check, but you can still switch.";
  const controls = document.createElement("div");
  controls.className = "flex items-center gap-2";
  const verify = document.createElement("button");
  verify.type = "button";
  verify.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
  verify.textContent = "Check plugins";
  verify.title = "Check and refresh local plugin copies for this account. This does not change plugins installed on the account or its connections.";
  verify.addEventListener("click", async () => {
    if (!window.confirm("Check plugins for the account in use now? Codex may add or remove local cached copies. It will not change plugins installed on the account or its connections.")) return;
    if (state.statusElement) state.statusElement.textContent = "Checking plugins for the account in use now…";
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "plugin-protection-verify-current" });
      if (state.statusElement) state.statusElement.textContent = result?.ok
        ? "Plugin check passed. Reopen Accounts to refresh the status."
        : "The check did not find every required plugin. This account was not marked as checked.";
    } catch { if (state.statusElement) state.statusElement.textContent = "Plugin checking is unavailable right now. Nothing was changed."; }
  });
  const mode = document.createElement("button");
  mode.type = "button";
  mode.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
  mode.textContent = info.mode === "enforcement" ? "Use warnings only" : "Block unchecked switches";
  mode.addEventListener("click", async () => {
    const enabling = info.mode !== "enforcement";
    if (enabling && !window.confirm("Block switches to accounts that have not passed the plugin check? You can still approve a one-time switch.")) return;
    try {
      const result = await state.api.ipc.invoke(IPC, { action: "plugin-protection-configure", enforcement: enabling });
      if (state.statusElement) state.statusElement.textContent = result?.ok ? "Plugin switch setting saved. Reopen Accounts to refresh the status." : "The plugin switch setting could not be saved.";
    } catch { if (state.statusElement) state.statusElement.textContent = "The plugin switch setting could not be saved."; }
  });
  controls.append(verify, mode);
  actions.append(note, controls);
  card.append(summary, actions);
  return card;
}

function pluginStatusLabel(status) {
  if (status?.valid) return "Up to date";
  const code = status?.code || "unavailable";
  if (["missing", "unavailable"].includes(code)) return "Not checked";
  if (code === "stale") return "Out of date";
  if (["wrong-account", "wrong-profile", "wrong-build"].includes(code)) return "Check again";
  return "Cannot check right now";
}

async function injectAccountMenus(state) {
  const targetMenu = accountMenuTargetFromCandidates(state.accountMenus || []);
  const ownedTarget = accountMenuOwnedTarget(targetMenu);
  // A previously projected profile is renderer memory only. Show it at once
  // while one bounded broker refresh replaces it; no profile data is written
  // to storage and a failed refresh never erases the useful cached menu.
  if (targetMenu && state.profile) {
    rerenderBrokerAccountMenu(state);
    if (!state.menuProfileRefreshPromise) {
      state.menuProfileRefreshPromise = (async () => {
        const broker = await invokeAccountBroker(state, "profile.read");
        if (!state.disposed && broker.ok) {
          state.profile = broker.result;
          if (!broker.result.accounts.some((account) => account.accountId === state.selectedAccountId)) {
            state.selectedAccountId = broker.result.selectedAccountId || broker.result.accounts[0]?.accountId || null;
          }
          publishAccountsContext(state);
          rerenderBrokerAccountMenu(state);
        }
      })();
      try { await state.menuProfileRefreshPromise; } finally { state.menuProfileRefreshPromise = null; }
    }
    return;
  }
  cleanupAccountSwitcherPanels(ownedTarget);
  if (!targetMenu || !ownedTarget || hasDirectAccountSwitcherPanel(ownedTarget)) return;
  // Only hit the main process when there is actually a menu to inject into —
  // dedupe BEFORE the IPC so re-scans of an already-injected menu don't trigger
  // a filesystem list on every DOM mutation.
  let response;
  let routerStatus;
  let brokerProfile;
  let brokerFailureCode = null;
  try {
    const broker = await invokeAccountBroker(state, "profile.read");
    if (broker.ok) brokerProfile = broker.result;
    else {
      brokerFailureCode = broker.error?.code;
      const authority = await accountAuthorityStatus(state);
      if (authority !== "legacy") {
        if (state.disposed) return;
        const currentTarget = accountMenuTargetFromCandidates(state.accountMenus || []);
        if (currentTarget !== targetMenu) {
          cleanupAccountSwitcherPanels(currentTarget);
          return;
        }
        cleanupAccountSwitcherPanels(ownedTarget);
        if (hasDirectAccountSwitcherPanel(ownedTarget)) return;
        const unavailable = accountAuthorityUnavailableMenuRows(state, brokerFailureCode);
        mountAccountSwitcherPanel(ownedTarget, unavailable);
        return;
      }
      [response, routerStatus] = await Promise.all([
        state.api.ipc.invoke(IPC, { action: "list" }),
        state.api.ipc.invoke(IPC, { action: "router-status" }).catch(() => null),
      ]);
    }
  } catch { return; }
  if ((!brokerProfile && !response?.ok) || state.disposed) return;
  if (brokerProfile) {
    state.profile = brokerProfile;
    if (!brokerProfile.accounts.some((account) => account.accountId === state.selectedAccountId)) {
      state.selectedAccountId = brokerProfile.selectedAccountId || brokerProfile.accounts[0]?.accountId || null;
    }
    publishAccountsContext(state);
  } else {
    state.pluginProtectionMode = response.pluginProtection?.mode || "observation";
  }
  const currentTarget = accountMenuTargetFromCandidates(state.accountMenus || []);
  if (currentTarget !== targetMenu) {
    cleanupAccountSwitcherPanels(currentTarget);
    return;
  }
  cleanupAccountSwitcherPanels(ownedTarget);
  if (hasDirectAccountSwitcherPanel(ownedTarget)) return;
  const panel = brokerProfile ? brokerAccountMenuRows(state, brokerProfile) : accountMenuRows(state, response.accounts, routerStatus);
  mountAccountSwitcherPanel(ownedTarget, panel);
}

async function accountAuthorityStatus(state) {
  try {
    const response = await state?.api?.ipc?.invoke?.(IPC, { action: ACCOUNT_AUTHORITY_STATUS_ACTION });
    return response?.ok === true ? normalizeAccountAuthorityMode(response.authorityMode) : "blocked";
  } catch {
    return "blocked";
  }
}

function accountAuthorityUnavailableMenuRows(state, brokerCode) {
  const panel = document.createElement("div");
  panel.className = "border-token-border my-1 flex flex-col gap-1 border-t px-2 py-2 text-sm text-token-text-secondary";
  const title = document.createElement("div");
  title.className = "text-token-text-primary";
  title.textContent = accountBrokerUnavailableTitle(brokerCode);
  const detail = document.createElement("div");
  detail.className = "text-xs";
  detail.textContent = accountBrokerDisplayMessage(brokerCode);
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = menuButtonClass();
  manage.textContent = brokerCode === "broker_setup_required" ? "View setup steps" : "Manage accounts";
  manage.setAttribute("aria-label", brokerCode === "broker_setup_required" ? "View account setup steps" : "Manage accounts settings");
  manage.addEventListener("click", async () => {
    const result = await state.api.settings?.openPage?.("accounts");
    if (!result?.ok) state.api.log?.warn?.("Accounts settings page could not be opened", "unavailable");
  });
  panel.append(title, detail, manage);
  return panel;
}

function brokerAccountMenuRows(state, profile) {
  const accounts = Array.isArray(profile?.accounts) ? profile.accounts : [];
  const stats = brokerPoolStats(accounts);
  const panel = document.createElement("div");
  panel.className = "border-token-border my-1 flex max-h-[min(65vh,520px)] flex-col overflow-y-auto overscroll-contain border-t px-2 py-1";
  const usage = document.createElement("div");
  usage.className = "flex items-center justify-between gap-3 px-2 py-1.5 text-sm text-token-text-primary";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col";
  const title = document.createElement("span");
  title.textContent = "Weekly usage left";
  const detail = document.createElement("span");
  detail.className = "text-token-text-secondary text-xs";
  detail.textContent = stats.allDepleted
    ? `All enabled subscriptions are depleted${stats.earliestResetAt ? ` · earliest reset ${formatResetAt(stats.earliestResetAt)}` : ""}`
    : `${stats.complete ? "" : "Incomplete usage data · "}${accounts.length} saved ${accounts.length === 1 ? "subscription" : "subscriptions"}`;
  copy.append(title, detail);
  const pooled = document.createElement("span");
  pooled.className = "text-token-text-secondary shrink-0";
  pooled.textContent = stats.remainingPercent === null ? "Not available" : `${stats.remainingPercent}% pooled`;
  usage.append(copy, pooled);
  panel.append(usage);
  for (const account of accounts) {
    const expanded = state.menuExpandedBrokerAccountId === account.accountId;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "hover:bg-token-foreground/5 flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm text-token-text-primary";
    row.setAttribute("aria-expanded", String(expanded));
    row.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} account details for ${account.label}`);
    row.dataset.tweakersFocusKey = `account-${account.accountId}`;
    const identity = document.createElement("span");
    identity.className = "flex min-w-0 flex-1 items-center gap-2";
    const lines = document.createElement("span");
    lines.className = "flex min-w-0 flex-1 flex-col";
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = [account.label, account.plan].filter(Boolean).join(" · ");
    const metadata = document.createElement("span");
    metadata.className = "text-token-text-secondary truncate text-xs";
    metadata.textContent = account.email || "Masked identity unavailable";
    lines.append(label, metadata);
    identity.append(brokerAccountAvatar(account), lines);
    const status = document.createElement("span");
    status.className = "text-token-text-secondary shrink-0 text-xs tabular-nums";
    const remainingPercent = freshBrokerQuotaRemainingPercent(account.quota);
    status.textContent = remainingPercent === null ? "–" : `${remainingPercent}%`;
    status.title = `${brokerQuotaText(account.quota)} · ${brokerAccountStatusLabel(account)} · ${expanded ? "Hide details" : "Show details"}`;
    row.append(identity, status);
    row.addEventListener("click", () => {
      const next = state.menuExpandedBrokerAccountId === account.accountId ? null : account.accountId;
      state.menuExpandedBrokerAccountId = next;
      if (!next) clearRemotePairing(state, account.accountId);
      rerenderBrokerAccountMenu(state);
      if (next) void refreshBrokerRemote(state, account.accountId);
    });
    panel.append(row);
    if (expanded) panel.append(brokerAccountDisclosure(state, account));
  }
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.className = menuButtonClass();
  signIn.textContent = "Sign in to another account";
  signIn.setAttribute("aria-label", "Sign in to another account");
  signIn.dataset.tweakersFocusKey = "sign-in";
  signIn.addEventListener("click", async () => {
    await state.api.settings?.openPage?.("accounts");
    if (!state.disposed) void startBrokerEnrollment(state, "enrollment.start");
  });
  panel.append(signIn);
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = menuButtonClass();
  manage.textContent = "Manage accounts";
  manage.setAttribute("aria-label", "Manage accounts settings");
  manage.dataset.tweakersFocusKey = "manage";
  manage.addEventListener("click", async () => {
    const result = await state.api.settings?.openPage?.("accounts");
    if (!result?.ok) state.api.log?.warn?.("Accounts settings page could not be opened", "unavailable");
  });
  panel.append(manage);
  return panel;
}

function accountMenuRows(state, suppliedAccounts, routerStatus) {
  const savedAccounts = Array.isArray(suppliedAccounts) ? suppliedAccounts : [];
  const accounts = savedAccounts;
  const liveStatus = routerStatus?.live?.state === "active" && isRecord(routerStatus.live.status)
    ? routerStatus.live.status : null;
  const panel = document.createElement("div");
  panel.className = "border-token-border my-1 flex flex-col border-t px-2 py-1";
  const usage = document.createElement("div");
  usage.className = "flex items-center justify-between gap-3 px-2 py-1.5 text-sm text-token-text-primary";
  const usageCopy = document.createElement("div");
  usageCopy.className = "flex min-w-0 flex-col";
  const usageTitle = document.createElement("span");
  usageTitle.textContent = "Weekly usage left";
  const subscriptions = document.createElement("span");
  subscriptions.className = "text-token-text-secondary text-xs";
  subscriptions.textContent = accounts.length === 0 ? "No saved subscriptions" : `${accounts.length} saved ${accounts.length === 1 ? "subscription" : "subscriptions"}`;
  usageCopy.append(usageTitle, subscriptions);
  const pool = document.createElement("span");
  pool.className = "text-token-text-secondary shrink-0";
  pool.textContent = quotaSummaryText(liveStatus);
  usage.append(usageCopy, pool);
  panel.append(usage);

  if (accounts.length > 0) {
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
      label.textContent = accountDisplayLabel(account);
      const identityText = document.createElement("span");
      identityText.className = "text-token-text-secondary truncate text-xs";
      identityText.textContent = accountIdentitySummary(account) || "Account email not available yet";
      const detailText = document.createElement("span");
      detailText.className = "text-token-text-secondary truncate text-xs";
      const plan = detail?.plan || "Plan not available yet";
      const weeklyRemaining = freshWeeklyRemainingPercent(detail?.weekly);
      const weekly = weeklyRemaining === null ? "Weekly usage not available yet" : `${weeklyRemaining}% weekly usage left`;
      detailText.textContent = `${plan} · ${weekly}`;
      copy.append(label, identityText, detailText);
      identity.append(accountAvatar(accountDisplayLabel(account)), copy);
      row.append(identity);
      const rowStatus = document.createElement("span");
      rowStatus.className = "text-token-text-secondary shrink-0 text-xs";
      rowStatus.textContent = accountRowStatus(account, detail, routerStatus?.live);
      rowStatus.setAttribute("aria-label", `${accountDisplayLabel(account)}: ${rowStatus.textContent}`);
      row.append(rowStatus);
      panel.append(row);
    }
    const choose = document.createElement("div");
    choose.className = "px-2 pt-2 text-xs text-token-text-secondary";
    choose.textContent = "Choose an account yourself";
    panel.append(choose);
    for (const account of accounts) panel.append(accountButton(state, account, routerStatus?.live));
  } else {
    const setup = document.createElement("div");
    setup.className = "px-2 py-1.5 text-sm text-token-text-secondary";
    setup.textContent = "Save at least two subscriptions to use automatic routing.";
    panel.append(setup);
    if (savedAccounts.length > 0) {
      const manualTitle = document.createElement("div");
      manualTitle.className = "px-2 pt-2 text-xs text-token-text-secondary";
      manualTitle.textContent = "Choose an account yourself";
      panel.append(manualTitle);
      for (const account of savedAccounts) panel.append(accountButton(state, account, routerStatus?.live));
    }
  }

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = menuButtonClass();
  manage.textContent = "Manage accounts";
  manage.setAttribute("aria-label", "Manage accounts settings");
  manage.addEventListener("click", async () => {
    const result = await state.api.settings?.openPage?.("accounts");
    if (!result?.ok) state.api.log?.warn?.("Accounts settings page could not be opened", result?.reason || "unavailable");
  });
  panel.append(manage);
  return panel;
}

function accountButton(state, account, live = null) {
  const button = document.createElement("button");
  button.type = "button"; button.className = menuButtonClass();
  const displayLabel = accountDisplayLabel(account);
  const usingNow = accountUsingNow(account, live);
  button.textContent = accountChoiceLabel(account, usingNow);
  button.disabled = usingNow;
  button.addEventListener("click", async () => {
    try {
      if (state.pluginProtectionMode === "observation" && account.pluginProtection && !account.pluginProtection.valid) {
        const proceed = window.confirm(`${displayLabel} has not passed the latest plugin check. Switch anyway?`);
        if (!proceed) return;
      }
      if (state.statusElement) state.statusElement.textContent = `Preparing to switch to ${displayLabel}…`;
      const prepared = await state.api.ipc.invoke(IPC, { action: "prepare-switch", ref: account.ref });
      if (!prepared?.ok) {
        if (prepared?.error?.code === "plugin-protection-receipt-required") {
          const bypass = window.confirm(`${displayLabel} has not passed the latest plugin check. Switch once anyway? This approval applies only to this switch.`);
          if (!bypass) return;
          const bypassPrepared = await state.api.ipc.invoke(IPC, { action: "prepare-switch-bypass", ref: account.ref });
          if (!bypassPrepared?.ok) { alertFailure(state, "The account could not be switched safely.", bypassPrepared); return; }
          if (!window.confirm(bypassPrepared.confirmation)) return;
          const bypassResult = await state.api.ipc.invoke(IPC, { action: "switch", intent: bypassPrepared.intent });
          if (!bypassResult?.ok) { alertFailure(state, "The account could not be switched safely.", bypassResult); return; }
          if (state.statusElement) state.statusElement.textContent = `Switching to ${displayLabel}; ChatGPT will restart to finish.`;
          if (!bypassResult.restartScheduled) window.alert("The account was changed. Restart ChatGPT to finish switching.");
          return;
        }
        alertFailure(state, "The account could not be switched safely.", prepared); return;
      }
      if (!window.confirm(prepared.confirmation)) return;
      const result = await state.api.ipc.invoke(IPC, { action: "switch", intent: prepared.intent });
      if (result?.ok) {
        if (state.statusElement) state.statusElement.textContent = `Switching to ${displayLabel}; ChatGPT will restart to finish.`;
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
  const name = window.prompt("Name this account (letters, numbers, dots, dashes, or underscores)");
  if (!name) return false;
  try {
    const prepared = await state.api.ipc.invoke(IPC, { action: "prepare-save", name });
    if (!prepared?.ok) { alertFailure(state, "The account could not be saved safely.", prepared); return false; }
    if (!window.confirm(prepared.confirmation)) return false;
    const result = await state.api.ipc.invoke(IPC, { action: "save", intent: prepared.intent });
    if (!result?.ok) { alertFailure(state, "The account could not be saved safely.", result); return false; }
    return true;
  } catch (error) {
    state.api?.log?.warn?.("account save failed", String(error));
    window.alert("The account could not be saved safely.");
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
  // Broker subscriptions and every renderer listener/timer are owned by this
  // instance. Hot reload may create a second instance in the same renderer,
  // so release them before removing injected nodes.
  if (state.brokerSubscribed) {
    state.brokerSubscribed = false;
    void invokeAccountBroker(state, "events.unsubscribe");
  }
  state.disposed = true; state.observer?.disconnect();
  if (state.timer) clearTimeout(state.timer);
  for (const enrollmentId of [...state.enrollmentTimers.keys()]) clearBrokerEnrollmentTimer(state, enrollmentId);
  for (const accountId of [...state.remoteTimers.keys()]) clearRemotePairing(state, accountId);
  state.remoteByAccountId.clear();
  state.remoteErrors.clear();
  for (const cleanup of state.cleanups.splice(0).reverse()) {
    try { cleanup(); } catch {}
  }
  state.brokerRoots.clear();
  state.sharedHistoryAdapterRevision += 1;
  state.visibleAccountMenuTarget = null;
  clearSharedHistoryConversationAdapter(state);
  removeNativeAccountConnectionSurfaces(state);
  state.nativeSettingsTargets.clear();
  state.nativeConnectionSelections.clear();
  state.page?.unregister?.();
  if (typeof document !== "undefined") {
    document.querySelectorAll?.("[data-tweakers-account-switcher]").forEach((node) => node.remove());
    document.querySelectorAll?.(`[${ACCOUNT_NATIVE_CONNECTION_SURFACE_ATTR}]`).forEach((node) => node.remove());
    document.querySelectorAll?.("[data-tweakers-account-native-slot-content]").forEach((node) => node.remove());
  }
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

function mountAccountSwitcherPanel(targetMenu, nextPanel) {
  if (!targetMenu || !nextPanel) return null;
  const existing = Array.from(targetMenu.children || [])
    .find((child) => child?.dataset?.tweakersAccountSwitcher === "true");
  if (!existing) {
    nextPanel.dataset.tweakersAccountSwitcher = "true";
    nextPanel.dataset.tweakersHostSurfaceOwned = "true";
    targetMenu.append(nextPanel);
    return nextPanel;
  }
  const scrollTop = Number.isFinite(existing.scrollTop) ? existing.scrollTop : 0;
  const active = typeof document !== "undefined" && existing.contains?.(document.activeElement)
    ? document.activeElement?.dataset?.tweakersFocusKey : null;
  existing.className = nextPanel.className;
  existing.replaceChildren(...Array.from(nextPanel.children || []));
  existing.dataset.tweakersAccountSwitcher = "true";
  existing.dataset.tweakersHostSurfaceOwned = "true";
  if ("scrollTop" in existing) existing.scrollTop = scrollTop;
  if (active && typeof existing.querySelector === "function") {
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(active) : active.replace(/[^A-Za-z0-9_-]/g, "");
    existing.querySelector(`[data-tweakers-focus-key="${escaped}"]`)?.focus?.({ preventScroll: true });
  }
  return existing;
}

function namedAccountsNativeSlot(surface, within = null) {
  if (typeof document === "undefined") return null;
  const scope = within && typeof within.querySelectorAll === "function" ? within : document;
  if (typeof scope.querySelectorAll !== "function") return null;
  const matches = Array.from(scope.querySelectorAll(`[data-tweakers-native-surface="${surface}"]`))
    .filter((element) => element?.isConnected !== false);
  return matches.length === 1 ? matches[0] : null;
}

function accountMenuOwnedTarget(targetMenu) {
  if (!targetMenu) return null;
  return namedAccountsNativeSlot("account-menu", targetMenu) || targetMenu;
}

function renderAccountsNativeSlots(state) {
  if (state?.disposed || !state.profile || typeof document === "undefined") return;
  const accounts = state.profile.accounts || [];
  const profileSlot = namedAccountsNativeSlot("profile");
  if (profileSlot) renderAccountsNativeProfileSlot(state, profileSlot, accounts);
  const threadSlot = namedAccountsNativeSlot("thread-summary");
  if (threadSlot) renderAccountsNativeThreadSlot(state, threadSlot, accounts);
}

function replaceAccountsNativeSlotContent(slot, next, revision) {
  if (!slot || !next) return null;
  slot.dataset.tweakersHostSurfaceOwned = "true";
  const existing = Array.from(slot.children || [])
    .find((child) => child?.dataset?.tweakersAccountNativeSlotContent === "true");
  if (existing?.dataset?.tweakersAccountNativeSlotRevision === revision) return existing;
  next.dataset.tweakersAccountNativeSlotContent = "true";
  next.dataset.tweakersAccountNativeSlotRevision = revision;
  if (existing) existing.replaceWith?.(next);
  else slot.append(next);
  return next;
}

function renderAccountsNativeProfileSlot(state, slot, accounts) {
  const selected = profileStatisticsSelection(state, accounts);
  const accountRevision = accounts
    .map((account) => [account.accountId, account.label, account.plan, account.enabled].join(":"))
    .join(",");
  // Keep the native select mounted across unrelated broker and connection
  // updates so an open menu is not replaced while the user is choosing.
  const revision = `${selected}:${accountRevision}`;
  const row = document.createElement("div");
  row.className = "mb-4";
  Object.assign(row.style, { display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", width: "100%" });
  const enabledAccounts = accounts.filter((account) => account.enabled);
  const visibleAccounts = selected === "pooled"
    ? enabledAccounts
    : accounts.filter((account) => account.accountId === selected);
  const avatarStack = document.createElement("div");
  Object.assign(avatarStack.style, { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "80px" });
  avatarStack.setAttribute("aria-label", selected === "pooled"
    ? `${enabledAccounts.length} enabled subscriptions`
    : "Selected subscription profile");
  visibleAccounts.forEach((account, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", selected === "pooled"
      ? `Show ${account.label} profile activity`
      : "Show combined profile activity");
    button.title = [account.label, account.plan].filter(Boolean).join(" · ");
    Object.assign(button.style, {
      width: "80px", height: "80px", flexShrink: "0", padding: "0",
      marginLeft: index === 0 ? "0" : "-20px", borderRadius: "9999px",
      border: "4px solid var(--token-bg-primary)", overflow: "hidden",
      position: "relative", zIndex: String(index + 1), cursor: "pointer",
    });
    const avatar = brokerAccountAvatar(account, 80);
    Object.assign(avatar.style, { width: "100%", height: "100%", borderRadius: "9999px", objectFit: "cover" });
    button.append(avatar);
    button.addEventListener("click", () => selectProfileStatistics(
      state,
      selected === "pooled" ? account.accountId : "pooled",
      accounts,
    ));
    avatarStack.append(button);
  });
  row.append(avatarStack);
  const selectedAccount = selected === "pooled" ? null : accounts.find((account) => account.accountId === selected);
  if (selectedAccount) {
    const identity = document.createElement("div");
    Object.assign(identity.style, { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" });
    const name = document.createElement("div");
    name.className = "text-token-text-primary";
    Object.assign(name.style, { fontSize: "20px", lineHeight: "28px", fontWeight: "500" });
    name.textContent = selectedAccount.label;
    const plan = document.createElement("div");
    plan.className = "text-token-text-secondary text-sm";
    plan.textContent = selectedAccount.plan || "ChatGPT subscription";
    identity.append(name, plan);
    row.append(identity);
  }
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  Object.assign(copy.style, { alignItems: "center", position: "relative", zIndex: "10", pointerEvents: "auto" });
  const label = document.createElement("div");
  label.className = "text-token-text-secondary text-xs";
  label.textContent = "Profile activity subscription";
  const selector = profileStatisticsPicker(state, accounts, selected);
  Object.assign(selector.style, { position: "relative", zIndex: "11", pointerEvents: "auto", cursor: "pointer" });
  copy.append(label, selector);
  row.append(copy);
  replaceAccountsNativeSlotContent(slot, row, revision);
}

function renderAccountsNativeThreadSlot(state, slot, accounts) {
  const owner = accounts.find((account) => account.currentTaskOwner) || null;
  const revision = `${state.nativeSurfaceRevision}:${owner?.accountId || "none"}:${owner ? brokerQuotaText(owner.quota) : ""}`;
  const summary = document.createElement("div");
  summary.className = "text-token-text-secondary flex items-center gap-2 text-xs";
  summary.setAttribute("role", "status");
  summary.textContent = owner
    ? `This task uses ${owner.label} · ${brokerQuotaText(owner.quota)}`
    : "This task’s subscription is not available yet.";
  replaceAccountsNativeSlotContent(slot, summary, revision);
}

function hasDirectAccountSwitcherPanel(menu) {
  return Array.from(menu?.children || []).some((child) => child?.dataset?.tweakersAccountSwitcher === "true");
}
function uniqueElements(elements) { return [...new Set(elements)].filter(Boolean); }
function safeEmail(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !validLabel(normalized)
    || /[\s<>/\\]/.test(normalized)
    || !/^[^@]{1,64}@[^@.]{1,63}(?:\.[^@.]{1,63})+$/.test(normalized)) return "";
  return normalized;
}

function safeUsername(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/^@/, "");
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
    || !validLabel(normalized)) return "";
  return normalized;
}

function boundedIdentityClaims(value) {
  const token = value?.tokens?.id_token;
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return null;
  const payload = segments[1];
  if (typeof payload !== "string" || payload.length === 0
    || payload.length > Math.ceil(MAX_IDENTITY_CLAIMS_BYTES * 4 / 3) + 4) return null;
  let bytes = null;
  try {
    bytes = Buffer.from(payload, "base64url");
    if (bytes.length === 0 || bytes.length > MAX_IDENTITY_CLAIMS_BYTES) return null;
    const claims = JSON.parse(bytes.toString("utf8"));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  } finally {
    try { bytes?.fill(0); } catch {}
  }
}

function accountIdentityFromAuth(value, fallback = "") {
  const claims = boundedIdentityClaims(value);
  const displayName = safeAccountLabel(
    typeof claims?.name === "string" ? claims.name : value?.user?.name,
    safeAccountLabel(typeof fallback === "string" ? fallback : "", ""),
  );
  const email = claims?.email_verified === false
    ? ""
    : safeEmail(claims?.email) || safeEmail(value?.user?.email);
  return {
    displayName,
    email: email || null,
    // Codex's current structured account schema has no username/handle. That
    // field is user-authored local presentation data only and is never inferred
    // from provider objects, JWT claims, or an email local-part.
    username: null,
  };
}

function displayLabelFromAuth(value, fallback) {
  return accountIdentityFromAuth(value, fallback).displayName;
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

function displaySnapshotIdentities(deps, paths, entries) {
  const records = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.isFile?.() && typeof entry.name === "string" && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry, index) => {
      try {
        validateReferenceName(entry.name.slice(0, -5));
        const filenameLabel = safeAccountLabel(entry.name.replace(/\.json$/i, ""), "");
        const identity = withSecureAuth(
          deps.fs,
          sourceFilePath(deps.path, paths.accountsDir, entry.name),
          (snapshot) => accountIdentityFromAuth(snapshot.value, ""),
        );
        const genericFilename = /^account-\d+$/i.test(filenameLabel);
        const base = identity.displayName || (!genericFilename && filenameLabel) || `Account ${index + 1}`;
        return [{ filename: entry.name, base, email: identity.email, username: identity.username }];
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
      ? safeAccountLabel(`${record.base.slice(0, 68)} · Account ${ordinal}`, `Account ${ordinal}`)
      : record.base;
    next.set(record.filename, {
      displayLabel: label,
      email: record.email || null,
      username: record.username || null,
    });
  }
  return next;
}

function displaySnapshotLabels(deps, paths, entries) {
  return new Map(
    [...displaySnapshotIdentities(deps, paths, entries)]
      .map(([filename, identity]) => [filename, identity.displayLabel]),
  );
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

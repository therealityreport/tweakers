"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountsBrokerRendererAdapterV1 = void 0;
const profile_statistics_1 = require("./profile-statistics");
const broker_1 = require("./broker");
const preferences_1 = require("./preferences");
const native_request_1 = require("./native-request");
const node_crypto_1 = require("node:crypto");
const redaction_1 = require("./redaction");
const types_1 = require("./types");
/**
 * Accounts consumer adapter. It implements the Account Switcher public
 * projection rather than exposing the private broker protocol verbatim.
 */
class AccountsBrokerRendererAdapterV1 {
    options;
    privateAccountByPublic = new Map();
    privateConnectionByPublic = new Map();
    /** Scope identities only, so a full authoritative snapshot can notify removal of its last row. */
    observedConnectionScopes = new Map();
    privateEnrollmentByPublic = new Map();
    privateHandoffByPublic = new Map();
    profiles = new Map();
    quotas = new Map();
    labels = new Map();
    /** Task lifecycle events are targeted by the broker, so this is renderer-local state. */
    activeTaskAccounts = new Map();
    handlers = new Set();
    unsubscribePrivate = null;
    eventSequence = 0;
    constructor(options) {
        this.options = options;
        if (options.secret.byteLength !== 32)
            throw new Error("invalid accounts broker adapter capability");
    }
    async invoke(envelope) {
        const translated = this.translateRequest(envelope);
        if (!translated)
            return invalidRequest(requestIdFrom(envelope));
        const response = await this.options.client.invoke(translated);
        if (!response.ok)
            return response;
        try {
            if (translated.command === "native.request" && (!(0, types_1.isPlainRecord)(response.result) || !(0, types_1.isPlainRecord)(translated.params)
                || response.result.opaqueAccountId !== translated.params.opaqueAccountId
                || response.result.surface !== translated.params.surface))
                throw new Error("native account or surface mismatch");
            if ((0, broker_1.isRemoteCommand)(translated.command) && (!(0, types_1.isPlainRecord)(response.result) || !(0, types_1.isPlainRecord)(translated.params) || response.result.accountId !== translated.params.opaqueAccountId))
                throw new Error("remote account mismatch");
            if (translated.command === "profile.email" && (!(0, types_1.isPlainRecord)(response.result) || !(0, types_1.isPlainRecord)(translated.params) || response.result.opaqueAccountId !== translated.params.opaqueAccountId))
                throw new Error("copy-email account mismatch");
            const result = this.translateResult(translated.command, envelope.params, response.result);
            if (result === null)
                return unavailable(response.requestId);
            if (translated.command === "profile.email") {
                if (!(0, types_1.isPlainRecord)(result) || !isAccountId(result.accountId) || !(0, broker_1.isActionEmail)(result.email) || !keys(result, ["accountId", "email"]))
                    throw new Error("invalid copy-email result");
            }
            else if (translated.command === "native.request") {
                // Native JSON follows the captured account/surface contract and size
                // bound checked above, as in assertBrokerCommandResult. It is not a
                // redacted control projection: plugin IDs, metadata and config keys
                // legitimately contain @ and credential-related words. Only the
                // broker envelope uses control redaction; native data stays intact.
                const native = result;
                assertRendererSafe({ accountId: native.accountId, surface: native.surface });
            }
            else
                assertRendererSafe(result);
            if (["connection.list", "connection.status"].includes(translated.command) && (0, types_1.isPlainRecord)(translated.params)
                && isOpaqueAccount(translated.params.opaqueAccountId) && isPrivateSurface(translated.params.kind) && Array.isArray(response.result)) {
                const scope = { account: translated.params.opaqueAccountId, kind: translated.params.kind };
                const key = `${scope.account}\u0000${scope.kind}`;
                if (response.result.length > 0)
                    this.observedConnectionScopes.set(key, scope);
                else if (translated.command === "connection.list")
                    this.observedConnectionScopes.delete(key);
            }
            this.emitCommandEvent(translated.command, result);
            return { version: 1, requestId: response.requestId, ok: true, result };
        }
        catch {
            return unavailable(response.requestId);
        }
    }
    subscribe(handler) {
        if (typeof handler !== "function")
            return () => { };
        this.handlers.add(handler);
        if (!this.unsubscribePrivate) {
            this.unsubscribePrivate = this.options.client.subscribe((event) => {
                for (const projected of this.translateEvent(event))
                    this.emit(projected.type, projected.payload);
            });
        }
        return () => {
            this.handlers.delete(handler);
            if (this.handlers.size === 0 && this.unsubscribePrivate) {
                this.unsubscribePrivate();
                this.unsubscribePrivate = null;
            }
        };
    }
    /**
     * Internal main/preload bridge for exact DOM-native targets. This adapter is
     * already bound to one authenticated renderer; it returns public handles
     * only, preserves request order, and never becomes a tweak command.
     */
    async mapBoundNativeTargets(request) {
        if (!isNativeTargetMapRequest(request) || !this.options.client.mapNativeTargets)
            return { version: 1, status: "unavailable" };
        try {
            const result = await this.options.client.mapNativeTargets(request);
            return isNativeTargetMapResult(result) ? result : { version: 1, status: "unavailable" };
        }
        catch {
            return { version: 1, status: "unavailable" };
        }
    }
    async resolveNativeBrowserContext(accountId) {
        if (!isAccountId(accountId))
            return null;
        const account = this.privateAccountByPublic.get(accountId);
        if (!account || !this.options.client.resolveNativeBrowserContext)
            return null;
        try {
            const result = await this.options.client.resolveNativeBrowserContext(account);
            return result.status === "ready" ? result : null;
        }
        catch {
            return null;
        }
    }
    translateNativeBrowserRequest(envelope) {
        if (!(0, types_1.isPlainRecord)(envelope) || Object.keys(envelope).sort().join("\0") !== "accountId\0method\0params"
            || !isAccountId(envelope.accountId) || typeof envelope.method !== "string" || !(0, types_1.isPlainRecord)(envelope.params))
            return null;
        const account = this.privateAccountByPublic.get(envelope.accountId);
        const request = (0, native_request_1.parseNativeRequestV1)({ surface: "plugins", method: envelope.method, params: envelope.params });
        return account && request && request.method.startsWith("browser.") ? { opaqueAccountId: account, method: request.method, params: request.params } : null;
    }
    async invokeNativeBrowserRequest(accountId, method, params) {
        if (!isAccountId(accountId))
            return null;
        const account = this.privateAccountByPublic.get(accountId);
        const request = (0, native_request_1.parseNativeBrowserChildRequestV1)(method, params);
        if (!account || !request || !this.options.client.invokeNativeBrowserRequest)
            return null;
        return this.options.client.invokeNativeBrowserRequest(account, request.method, request.params);
    }
    translateRequest(envelope) {
        if (!isPublicEnvelope(envelope))
            return null;
        const { command, requestId } = envelope;
        const params = envelope.params ?? {};
        if (["profile.read", "history.read", "preferences.read", "balance.read", "events.subscribe", "events.unsubscribe"].includes(command)) {
            return emptyParams(params) ? { version: 1, requestId, command } : null;
        }
        if (command === "preferences.update")
            return (0, preferences_1.isAccountsPreferencesPatch)(params) ? { version: 1, requestId, command, params: { ...params } } : null;
        if (command === "balance.set") {
            return (0, types_1.isPlainRecord)(params) && keys(params, ["enabled"]) && typeof params.enabled === "boolean"
                ? { version: 1, requestId, command, params: { enabled: params.enabled } } : null;
        }
        if ((0, broker_1.isRemoteCommand)(command)) {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, command === "remote.devices.revoke" ? ["accountId", "deviceId"] : ["accountId"]) || !isAccountId(params.accountId)
                || command === "remote.devices.revoke" && (typeof params.deviceId !== "string" || !/^device_[A-Za-z0-9_-]{43}$/.test(params.deviceId)))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account, ...(command === "remote.devices.revoke" ? { deviceId: params.deviceId } : {}) } } : null;
        }
        if (command === "profile.statistics") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["selection"]))
                return null;
            const selection = params.selection === "pooled" ? "pooled" : isAccountId(params.selection) ? this.privateAccountByPublic.get(params.selection) : null;
            return selection ? { version: 1, requestId, command, params: { selection } } : null;
        }
        if (command === "profile.email") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
        }
        if (command === "profile.update") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId", "label"]) || !isAccountId(params.accountId) || !safeLabel(params.label))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account, label: params.label } } : null;
        }
        if (command === "enabled.set") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId", "enabled"]) || !isAccountId(params.accountId) || typeof params.enabled !== "boolean")
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account, enabled: params.enabled } } : null;
        }
        if (command === "quota.read") {
            if (emptyParams(params))
                return { version: 1, requestId, command };
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
        }
        if (command === "native.request") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId", "surface", "method", "params"]) || !isAccountId(params.accountId))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            const request = (0, native_request_1.parseNativeRequestV1)({ surface: params.surface, method: params.method, params: params.params });
            return account && request && !request.method.startsWith("browser.") ? { version: 1, requestId, command, params: { opaqueAccountId: account, ...request } } : null;
        }
        if (command === "enrollment.start")
            return emptyParams(params) ? { version: 1, requestId, command } : null;
        if (command === "reconnect.start") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
        }
        if (["enrollment.status", "enrollment.cancel", "reconnect.status", "reconnect.cancel"].includes(command)) {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["enrollmentId"]) || !isEnrollmentId(params.enrollmentId))
                return null;
            const enrollment = this.privateEnrollmentByPublic.get(params.enrollmentId);
            return enrollment ? { version: 1, requestId, command, params: { enrollmentRef: enrollment } } : null;
        }
        if (command === "connection.list" || command === "connection.status") {
            const expected = command === "connection.list" ? ["accountId", "surface"] : ["accountId", "connectionId", "surface"];
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, expected) || !isAccountId(params.accountId) || !isSurface(params.surface))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            const kind = toPrivateSurface(params.surface);
            if (!account || !kind)
                return null;
            if (command === "connection.list")
                return { version: 1, requestId, command, params: { opaqueAccountId: account, kind } };
            if (!isConnectionId(params.connectionId))
                return null;
            const connection = this.privateConnectionByPublic.get(params.connectionId);
            if (!connection || connection.account !== account || connection.kind !== kind)
                return null;
            return { version: 1, requestId, command, params: { opaqueAccountId: account, kind, definitionRef: connection.definitionRef } };
        }
        if (command === "connection.authorize") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId", "connectionId", "surface"])
                || !isAccountId(params.accountId) || !isConnectionId(params.connectionId) || !isSurface(params.surface))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            const kind = toPrivateSurface(params.surface);
            const connection = this.privateConnectionByPublic.get(params.connectionId);
            // The public UI must not turn a display-only App/Plugin/Workspace row
            // into a provider OAuth request.  Repeat the broker's fail-closed MCP
            // boundary here so forged renderer traffic cannot wake an account child.
            if (!account || kind !== "mcp" || !connection || connection.account !== account || connection.kind !== kind)
                return null;
            return { version: 1, requestId, command, params: { opaqueAccountId: account, kind, definitionRef: connection.definitionRef } };
        }
        if (command === "resetCredit.consume") {
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId))
                return null;
            const account = this.privateAccountByPublic.get(params.accountId);
            return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
        }
        if (command === "handoff.confirm" || command === "handoff.cancel") {
            const confirmKeys = command === "handoff.confirm" && (0, types_1.isPlainRecord)(params) && Object.prototype.hasOwnProperty.call(params, "accountId")
                ? ["accountId", "confirmationId"]
                : ["confirmationId"];
            if (!(0, types_1.isPlainRecord)(params) || !keys(params, confirmKeys) || !isConfirmationId(params.confirmationId)
                || ("accountId" in params && !isAccountId(params.accountId)))
                return null;
            const handoff = this.privateHandoffByPublic.get(params.confirmationId);
            if (!handoff)
                return null;
            if (command === "handoff.confirm" && "accountId" in params) {
                const accountId = params.accountId;
                if (!isAccountId(accountId))
                    return null;
                const toOpaqueAccountId = this.privateAccountByPublic.get(accountId);
                return toOpaqueAccountId ? { version: 1, requestId, command, params: { handoffRef: handoff.handoffRef, toOpaqueAccountId } } : null;
            }
            return { version: 1, requestId, command, params: { handoffRef: handoff.handoffRef } };
        }
        return null;
    }
    translateResult(command, supplied, value) {
        if (command === "profile.statistics") {
            if (!(0, profile_statistics_1.isNativeProfileStatisticsResultV1)(value) || !(0, types_1.isPlainRecord)(supplied))
                throw new Error("invalid profile statistics");
            const selection = value.selection === "pooled" ? "pooled" : this.accountId(value.selection);
            if (selection !== supplied.selection)
                throw new Error("statistics selection mismatch");
            return { ...value, selection, accounts: value.accounts.map((account) => ({ ...account, accountId: this.accountId(account.accountId) })) };
        }
        if (command === "profile.email") {
            (0, broker_1.assertBrokerCommandResult)(command, value);
            const result = value;
            return { accountId: this.accountId(result.opaqueAccountId), email: result.email };
        }
        if ((0, broker_1.isRemoteCommand)(command)) {
            if (!(0, broker_1.isBrokerRemoteProjection)(value))
                throw new Error("invalid remote response");
            return { ...value, accountId: this.accountId(value.accountId) };
        }
        if (command === "preferences.read" || command === "preferences.update") {
            if (!(0, preferences_1.isAccountsPreferences)(value))
                throw new Error("invalid Accounts preferences response");
            return { ...value };
        }
        if (command === "balance.read" || command === "balance.set")
            return balance(value, this);
        if (command === "profile.read")
            return profile(value, this);
        if (command === "history.read")
            return historyRead(value, this);
        if (command === "profile.update" || command === "enabled.set")
            return accountMutation(value, supplied, this);
        if (command === "quota.read")
            return quota(value, supplied, this);
        if (command === "native.request") {
            if (!(0, types_1.isPlainRecord)(value) || !isOpaqueAccount(value.opaqueAccountId) || typeof value.surface !== "string"
                || !(0, native_request_1.isBoundedNativeResultV1)(value.result, value.surface))
                return null;
            const accountId = this.accountId(value.opaqueAccountId);
            if (!(0, types_1.isPlainRecord)(supplied) || supplied.accountId !== accountId || supplied.surface !== value.surface)
                return null;
            return { accountId, surface: value.surface, result: value.result };
        }
        if (command === "connection.list" || command === "connection.status")
            return connections(value, supplied, this);
        if (command === "connection.authorize")
            return authorize(value, this);
        if (["enrollment.start", "enrollment.status", "enrollment.cancel", "reconnect.start", "reconnect.status", "reconnect.cancel"].includes(command))
            return enrollment(value, this);
        if (command === "resetCredit.consume")
            return reset(value, this);
        if (command === "handoff.confirm" || command === "handoff.cancel")
            return continuationResult(value, this);
        if (command === "events.subscribe" || command === "events.unsubscribe")
            return {};
        return null;
    }
    translateEvent(event) {
        if (event.type === "profile") {
            const result = profile(event.payload, this);
            return result ? [{ type: "profile.updated", payload: result }] : [];
        }
        if (event.type === "quota") {
            const rows = Array.isArray(event.payload) ? event.payload : [event.payload];
            return rows.flatMap((item) => {
                if (!isQuota(item))
                    return [];
                const result = quota([item], { accountId: this.accountId(item.opaqueAccountId) }, this);
                return result ? [{ type: "quota.updated", payload: result }] : [];
            });
        }
        if (event.type === "connection" && Array.isArray(event.payload)) {
            if (!event.payload.every(isConnection))
                return [];
            const groups = new Map();
            const scopes = new Map(this.observedConnectionScopes);
            for (const item of event.payload) {
                const key = `${item.opaqueAccountId}\u0000${item.kind}`;
                const entries = groups.get(key) ?? [];
                entries.push(item);
                groups.set(key, entries);
                scopes.set(key, { account: item.opaqueAccountId, kind: item.kind });
            }
            this.observedConnectionScopes.clear();
            return [...scopes].flatMap(([key, scope]) => {
                const items = groups.get(key) ?? [];
                if (items.length > 0)
                    this.observedConnectionScopes.set(key, scope);
                const result = connections(items, { accountId: this.accountId(scope.account), surface: fromPrivateSurface(scope.kind) }, this);
                return result ? [{ type: "connection.updated", payload: result }] : [];
            });
        }
        if (event.type === "enrollment") {
            const result = enrollment(event.payload, this);
            if (!result || !isEnrollment(event.payload))
                return [];
            return [{ type: event.payload.kind === "reconnect" ? "reconnect.updated" : "enrollment.updated", payload: result }];
        }
        if (event.type === "continuation" && isTaskOwnership(event.payload)) {
            this.recordTaskOwnership(event.payload);
            // The broker follows this targeted private task event with a profile
            // projection.  No task identifier crosses the Accounts renderer seam.
            return [];
        }
        if (event.type === "continuation" && isHandoff(event.payload)) {
            const result = continuationResult(event.payload, this);
            if (!result)
                return [];
            return [{ type: event.payload.state === "pending" ? "continuation.pending" : "continuation.resolved", payload: result }];
        }
        if ((event.type === "history" || event.type === "conversation") && isLogicalConversation(event.payload)) {
            const result = logicalConversation(event.payload, this);
            return result ? [{ type: event.type === "history" ? "history.updated" : "conversation.updated", payload: result }] : [];
        }
        if (event.type === "turn" && isLogicalTurn(event.payload)) {
            const result = logicalTurn(event.payload, this);
            return result ? [{ type: "turn.committed", payload: result }] : [];
        }
        if (event.type === "continuation" && isLogicalContinuation(event.payload)) {
            const result = logicalContinuation(event.payload, this);
            return result ? [{ type: event.payload.state === "pending" ? "continuation.pending" : "continuation.resolved", payload: { continuation: result } }] : [];
        }
        return [];
    }
    emitCommandEvent(command, result) {
        if (command === "profile.update" && (0, types_1.isPlainRecord)(result))
            this.emit("profile.updated", result);
        else if (command === "enabled.set" && (0, types_1.isPlainRecord)(result))
            this.emit("enabled.changed", result);
        else if (command === "quota.read" && (0, types_1.isPlainRecord)(result))
            this.emit("quota.updated", result);
        // `connection.authorize` has one ephemeral OAuth handoff URL for the
        // bound main-process caller. It is never a renderer event; the private
        // broker separately emits a URL-free connection state update.
        else if (["enrollment.start", "enrollment.status", "enrollment.cancel"].includes(command) && (0, types_1.isPlainRecord)(result))
            this.emit("enrollment.updated", result);
        else if (["reconnect.start", "reconnect.status", "reconnect.cancel"].includes(command) && (0, types_1.isPlainRecord)(result))
            this.emit("reconnect.updated", result);
        else if (command === "resetCredit.consume" && (0, types_1.isPlainRecord)(result))
            this.emit("resetCredit.updated", result);
        else if ((command === "handoff.confirm" || command === "handoff.cancel") && (0, types_1.isPlainRecord)(result))
            this.emit("handoff.updated", result);
    }
    emit(type, payload) {
        const event = { version: 1, sequence: ++this.eventSequence, type, payload };
        try {
            assertRendererSafe(event);
        }
        catch {
            return;
        }
        for (const handler of this.handlers) {
            try {
                handler(event);
            }
            catch { /* isolated observer */ }
        }
    }
    accountId(account) {
        const id = `account_${hash(this.options.secret, `account:${account}`)}`;
        this.privateAccountByPublic.set(id, account);
        return id;
    }
    /** Kept private to the main-process adapter; never return this to a renderer. */
    opaqueAccountForPublic(accountId) {
        return this.privateAccountByPublic.get(accountId) ?? null;
    }
    connectionId(account, kind, definitionRef) {
        const id = `connection_${hash(this.options.secret, `connection:${account}:${kind}:${definitionRef}`)}`;
        this.privateConnectionByPublic.set(id, { account, kind, definitionRef });
        return id;
    }
    enrollmentId(ref) {
        const id = `enrollment_${hash(this.options.secret, `enrollment:${ref}`)}`;
        this.privateEnrollmentByPublic.set(id, ref);
        return id;
    }
    confirmationId(handoff) {
        const id = `confirmation_${hash(this.options.secret, `confirmation:${handoff.confirmationId}`)}`;
        this.privateHandoffByPublic.set(id, handoff);
        return id;
    }
    conversationId(value) { return `conversation_${hash(this.options.secret, `conversation:${value}`)}`; }
    segmentId(value) { return `segment_${hash(this.options.secret, `segment:${value}`)}`; }
    turnId(value) { return `turn_${hash(this.options.secret, `turn:${value}`)}`; }
    clientId(value) { return `client_${hash(this.options.secret, `client:${value}`)}`; }
    /** Private implementation detail for per-observer projection; never IPC. */
    rendererRef() { return this.options.rendererRef ?? null; }
    /** Internal HMAC capability, used only to derive a public confirmation handle. */
    secret() { return this.options.secret; }
    cache(rows) {
        for (const row of rows)
            this.profiles.set(row.opaqueAccountId, { ...row });
    }
    cacheQuota(rows) {
        for (const row of rows)
            this.quotas.set(row.opaqueAccountId, { ...row });
    }
    quotaFor(account) {
        const quota = this.quotas.get(account);
        return quota ? publicQuota(quota) : emptyQuota();
    }
    label(account) {
        return this.labelsFor(account, `Account ${[...this.profiles.keys()].indexOf(account) + 1}`);
    }
    labelsFor(account, fallback) {
        return this.profiles.get(account)?.safeProfile.identifierMasked ?? this.labels.get(account) ?? fallback;
    }
    rememberLabel(account, label) {
        if (safeLabel(label))
            this.labels.set(account, label);
    }
    currentTaskOwner(account) {
        for (const activeAccount of this.activeTaskAccounts.values())
            if (activeAccount === account)
                return true;
        return false;
    }
    recordTaskOwnership(task) {
        if (task.activeRunCount > 0)
            this.activeTaskAccounts.set(task.taskRef, task.opaqueAccountId);
        else
            this.activeTaskAccounts.delete(task.taskRef);
    }
}
exports.AccountsBrokerRendererAdapterV1 = AccountsBrokerRendererAdapterV1;
function profile(value, adapter) {
    if (!isPool(value))
        return null;
    adapter.cache(value.accounts);
    const accounts = value.accounts.map((row) => account(row, adapter.quotaFor(row.opaqueAccountId), adapter));
    return { accounts, selectedAccountId: accounts[0]?.accountId ?? null };
}
function historyRead(value, adapter) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== ["conversation", "turns"].join("\0")
        || (value.conversation !== null && !isLogicalConversation(value.conversation)) || !Array.isArray(value.turns) || !value.turns.every(isLogicalTurn))
        return null;
    return { conversation: value.conversation ? logicalConversation(value.conversation, adapter) : null, turns: value.turns.map((turn) => logicalTurn(turn, adapter)).filter((turn) => turn !== null) };
}
function accountMutation(value, supplied, adapter) {
    if (!isAccount(value))
        return null;
    if ((0, types_1.isPlainRecord)(supplied) && safeLabel(supplied.label))
        adapter.rememberLabel(value.opaqueAccountId, supplied.label);
    adapter.cache([value]);
    const disabling = (0, types_1.isPlainRecord)(supplied) && supplied.enabled === false;
    const lifecycle = disabling
        ? value.activeRunCount > 0
            ? "active_runs_finishing"
            : value.childState === "evicted"
                ? "idle_child_stopped"
                : "no_new_work"
        : "lazy";
    return { account: account(value, adapter.quotaFor(value.opaqueAccountId), adapter), lifecycle };
}
function quota(value, supplied, adapter) {
    if (!Array.isArray(value) || !value.every(isQuota))
        return null;
    adapter.cacheQuota(value);
    const requested = (0, types_1.isPlainRecord)(supplied) && isAccountId(supplied.accountId) ? supplied.accountId : null;
    if (requested) {
        const row = value.find((item) => adapter.accountId(item.opaqueAccountId) === requested) ?? null;
        return row ? { accountId: requested, quota: publicQuota(row) } : null;
    }
    const accounts = value.map((row) => ({ accountId: adapter.accountId(row.opaqueAccountId), quota: publicQuota(row) }));
    return { accounts, partial: accounts.some((entry) => entry.quota.refreshState === "error" || entry.quota.freshness !== "fresh") };
}
function connections(value, supplied, adapter) {
    if (!Array.isArray(value) || !value.every(isConnection) || value.length > 2048 || !(0, types_1.isPlainRecord)(supplied)
        || !isAccountId(supplied.accountId) || !isSurface(supplied.surface))
        return null;
    const accountId = supplied.accountId;
    const account = adapter.opaqueAccountForPublic(accountId);
    const kind = toPrivateSurface(supplied.surface);
    if (!account || !kind)
        return null;
    return { accountId, connections: value.filter((item) => item.opaqueAccountId === account && item.kind === kind).map((item) => connection(item, adapter)) };
}
function authorize(value, adapter) {
    if (!(0, types_1.isPlainRecord)(value) || !isOpaqueAccount(value.opaqueAccountId) || !isPrivateSurface(value.kind) || !isDefinition(value.definitionRef) || value.state !== "submitted" || !isSafeOAuthUrl(value.oauthUrl))
        return null;
    return {
        accountId: adapter.accountId(value.opaqueAccountId),
        connections: [connection({ opaqueAccountId: value.opaqueAccountId, kind: value.kind, definitionRef: value.definitionRef, status: "connecting", updatedAt: null }, adapter)],
        oauthUrl: value.oauthUrl,
    };
}
function enrollment(value, adapter) {
    if (!isEnrollment(value))
        return null;
    return { enrollment: {
            enrollmentId: adapter.enrollmentId(value.enrollmentRef), state: value.state,
            userCode: value.state === "waiting" ? value.userCode : null,
            verificationUrl: value.state === "waiting" ? value.verificationUrl : null,
            expiresAt: value.expiresAt,
            accountId: value.opaqueAccountId ? adapter.accountId(value.opaqueAccountId) : null,
        } };
}
function reset(value, adapter) {
    if (!(0, types_1.isPlainRecord)(value) || !isOpaqueAccount(value.opaqueAccountId) || typeof value.consumed !== "boolean" || !isQuota(value.quota))
        return null;
    return { accountId: adapter.accountId(value.opaqueAccountId), consumed: value.consumed, quota: publicQuota(value.quota) };
}
function continuationResult(value, adapter) {
    if ((0, types_1.isPlainRecord)(value) && value.status === "cancelled")
        return { continuation: null };
    if (!isHandoff(value))
        return null;
    return { continuation: {
            confirmationId: adapter.confirmationId(value),
            state: value.state === "pending" ? "pending" : value.state === "cancelled" ? "cancelled" : value.state === "expired" ? "expired" : "confirmed",
            expiresAt: value.expiresAt,
        } };
}
function logicalSubscription(value, adapter) {
    return { accountId: adapter.accountId(value.accountId), label: adapter.labelsFor(value.accountId, value.label) };
}
function logicalConversation(value, adapter) {
    if (!isLogicalConversation(value))
        return null;
    const active = value.activeClient;
    const activeClient = active ? {
        clientId: adapter.clientId(active.clientId),
        label: active.label,
        subscription: logicalSubscription(active.subscription, adapter),
    } : null;
    return {
        conversationId: adapter.conversationId(value.conversationId),
        availability: value.availability,
        ...(value.historyWarning !== undefined ? { historyWarning: value.historyWarning } : {}),
        segments: value.segments.map((segment) => ({ segmentId: adapter.segmentId(segment.segmentId), subscription: logicalSubscription(segment.subscription, adapter), state: segment.state, ...(segment.committedAt ? { committedAt: segment.committedAt } : {}) })),
        activeClient,
        // The active origin is not its own peer. An adapter without the private
        // binding fails closed to `false`, rather than implying a peer writer.
        peerBusy: Boolean(value.peerBusy && activeClient && thisRendererDiffers(active.clientId, adapter)),
        updatedAt: value.updatedAt,
    };
}
function thisRendererDiffers(active, adapter) {
    const current = adapter.rendererRef();
    return current !== null && current !== active;
}
function logicalTurn(value, adapter) {
    return isLogicalTurn(value) ? { turnId: adapter.turnId(value.turnId), subscription: logicalSubscription(value.subscription, adapter), state: "committed" } : null;
}
function logicalContinuation(value, adapter) {
    if (!isLogicalContinuation(value))
        return null;
    return {
        confirmationId: `confirmation_${hash(adapter.secret(), `confirmation:${value.confirmationId}`)}`,
        state: value.state === "pending" ? "pending" : value.state === "cancelled" ? "cancelled" : value.state === "expired" ? "expired" : "confirmed",
        expiresAt: value.expiresAt,
        kind: "subscription_switch",
        fromSubscription: logicalSubscription(value.fromSubscription, adapter),
        toSubscription: logicalSubscription(value.toSubscription, adapter),
        conversationId: adapter.conversationId(value.conversationId),
    };
}
function account(row, quota, adapter) {
    return {
        accountId: adapter.accountId(row.opaqueAccountId), label: adapter.labelsFor(row.opaqueAccountId, row.label),
        avatarUrl: row.safeProfile.avatarUrl, email: row.safeProfile.identifierMasked, plan: row.safeProfile.plan,
        enabled: row.enabled, quota, assignedTaskCount: row.assignedTaskCount, currentTaskOwner: adapter.currentTaskOwner(row.opaqueAccountId),
        ...(row.continuityState === "ready" || row.continuityState === "deferred" ? { continuityState: row.continuityState } : {}),
        ...(row.continuityReason ? { continuityReason: row.continuityReason } : {}),
        ...(row.continuityBlocker ? { continuityBlocker: row.continuityBlocker } : {}),
        status: !row.enabled || row.state === "disabled" ? "disabled" : row.state === "reauth_required" ? "reauth_required"
            : row.state === "unhealthy" ? "unavailable" : row.state === "active" ? "active" : quota.depleted ? "depleted" : "ready",
    };
}
function connection(row, adapter) {
    const surface = fromPrivateSurface(row.kind);
    return {
        connectionId: adapter.connectionId(row.opaqueAccountId, row.kind, row.definitionRef), surface,
        label: (0, broker_1.safeConnectionDisplayLabel)(row.displayLabel) ?? `${surface === "mcp" ? "MCP" : surface.slice(0, 1).toUpperCase() + surface.slice(1)} connection`,
        status: row.status === "connected" ? "connected"
            : row.status === "blocked" ? "expired"
                : row.status === "unavailable" ? "unavailable" : "setup_required",
        authorizationAvailable: surface === "mcp",
    };
}
function balance(value, adapter) {
    if (!(0, types_1.isPlainRecord)(value) || !keys(value, ["policy", "baselineAt", "accounts", "degradedReason", "nextAccountId"])
        || !["balanced_tokens_v1", "quota_aware_v2", "manual"].includes(String(value.policy))
        || !(value.baselineAt === null || typeof value.baselineAt === "string" && /^\d{4}-\d\d-\d\dT/.test(value.baselineAt) && Number.isFinite(Date.parse(value.baselineAt)))
        || !Array.isArray(value.accounts)
        || ![null, "account_unavailable", "usage_unknown", "requires_two_accounts"].includes(value.degradedReason))
        return null;
    const seen = new Set();
    const accounts = [];
    for (const row of value.accounts) {
        if (!(0, types_1.isPlainRecord)(row) || !keys(row, ["opaqueAccountId", "completedTokens", "reservedTokens", "unreportedTokens", "sharePercent", "precision"])
            || !isOpaqueAccount(row.opaqueAccountId) || seen.has(row.opaqueAccountId)
            || !Number.isSafeInteger(row.completedTokens) || row.completedTokens < 0
            || !Number.isSafeInteger(row.unreportedTokens) || row.unreportedTokens < 0
            || !Number.isSafeInteger(row.reservedTokens) || row.reservedTokens < 0
            || !(row.sharePercent === null || typeof row.sharePercent === "number" && Number.isFinite(row.sharePercent) && row.sharePercent >= 0 && row.sharePercent <= 100)
            || !["exact", "partial", "unknown"].includes(String(row.precision)))
            return null;
        seen.add(row.opaqueAccountId);
        accounts.push({ accountId: adapter.accountId(row.opaqueAccountId), completedTokens: row.completedTokens,
            reservedTokens: row.reservedTokens, unreportedTokens: row.unreportedTokens, sharePercent: row.sharePercent, precision: row.precision });
    }
    if (value.nextAccountId !== null && (!isOpaqueAccount(value.nextAccountId) || !seen.has(value.nextAccountId)))
        return null;
    return { policy: value.policy, baselineAt: value.baselineAt, accounts, degradedReason: value.degradedReason,
        nextAccountId: value.nextAccountId === null ? null : adapter.accountId(value.nextAccountId) };
}
function publicQuota(row) { return { remainingPercent: row.remainingPercent, freshness: row.freshness, resetAt: row.resetAt, depleted: row.remainingPercent === 0 || row.rateLimitReached === true || (row.shortWindowPressure === 100 && (row.shortWindowResetAt == null || row.shortWindowResetAt > Date.now())), resetCredits: row.resetCredits, shortWindowPressure: row.shortWindowPressure, refreshState: row.refreshState ?? "idle", errorCode: row.errorCode ?? null, lastAttemptAt: row.lastAttemptAt ?? null }; }
function emptyQuota() { return { remainingPercent: null, freshness: "unknown", resetAt: null, depleted: false, resetCredits: null, shortWindowPressure: null, refreshState: "idle", errorCode: null, lastAttemptAt: null }; }
function toPrivateSurface(surface) { return surface === "apps" ? "app" : surface === "plugins" ? "plugin" : surface === "mcp" ? "mcp" : surface === "usage" ? "workspace" : null; }
function fromPrivateSurface(surface) { return surface === "app" ? "apps" : surface === "plugin" ? "plugins" : surface === "mcp" ? "mcp" : "usage"; }
function isPublicEnvelope(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).every((key) => ["action", "command", "params", "requestId", "version"].includes(key))
        && value.version === 1 && value.action === "broker" && typeof value.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.requestId)
        && isCommand(value.command) && (value.params === undefined || (0, types_1.isPlainRecord)(value.params));
}
function isCommand(value) { return (0, broker_1.isRemoteCommand)(value) || typeof value === "string" && ["enrollment.start", "enrollment.status", "enrollment.cancel", "reconnect.start", "reconnect.status", "reconnect.cancel", "profile.read", "profile.email", "profile.statistics", "history.read", "profile.update", "enabled.set", "quota.read", "native.request", "preferences.read", "preferences.update", "balance.read", "balance.set", "connection.list", "connection.status", "connection.authorize", "resetCredit.consume", "handoff.confirm", "handoff.cancel", "events.subscribe", "events.unsubscribe"].includes(value); }
function keys(value, expected) { return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
function emptyParams(value) { return value === undefined || ((0, types_1.isPlainRecord)(value) && Object.keys(value).length === 0); }
function safeLabel(value) { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value); }
function isAccountId(value) { return typeof value === "string" && /^account_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isConnectionId(value) { return typeof value === "string" && /^connection_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isEnrollmentId(value) { return typeof value === "string" && /^enrollment_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isConfirmationId(value) { return typeof value === "string" && /^confirmation_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isNativeTargetMapRequest(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"].join("\0")
        && value.version === 1 && isNativeTargetId(value.conversationNativeId) && isNativeTargetId(value.composerNativeId)
        && Array.isArray(value.assistantTurnNativeIds) && value.assistantTurnNativeIds.length <= 128 && value.assistantTurnNativeIds.every(isNativeTargetId);
}
function isNativeTargetMapResult(value) {
    return (0, types_1.isPlainRecord)(value) && value.version === 1 && (value.status === "unavailable"
        ? Object.keys(value).sort().join("\0") === ["status", "version"].join("\0")
        : value.status === "mapped" && Object.keys(value).sort().join("\0") === ["conversationId", "status", "turnIds", "version"].join("\0")
            && typeof value.conversationId === "string" && /^conversation_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId)
            && Array.isArray(value.turnIds) && value.turnIds.length <= 128 && value.turnIds.every((turnId) => typeof turnId === "string" && /^turn_[A-Za-z0-9_-]{16,128}$/.test(turnId)));
}
function isNativeTargetId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function isSurface(value) { return value === "apps" || value === "plugins" || value === "mcp" || value === "usage"; }
function isOpaqueAccount(value) { return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value); }
function isDefinition(value) { return typeof value === "string" && /^bd_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isPrivateSurface(value) { return value === "app" || value === "plugin" || value === "mcp" || value === "workspace"; }
function isPool(value) { return (0, types_1.isPlainRecord)(value) && value.schemaVersion === 3 && Array.isArray(value.accounts) && value.accounts.every(isAccount); }
function isAccount(value) {
    return (0, types_1.isPlainRecord)(value) && isOpaqueAccount(value.opaqueAccountId) && safeLabel(value.label) && isSafeProfile(value.safeProfile) && typeof value.enabled === "boolean" && ["disabled", "ready", "active", "reauth_required", "unhealthy"].includes(String(value.state)) && ["absent", "resident", "active", "held", "evicted"].includes(String(value.childState)) && typeof value.assignedTaskCount === "number" && Number.isInteger(value.assignedTaskCount) && value.assignedTaskCount >= 0
        && (value.continuityState === undefined || ["ready", "deferred"].includes(String(value.continuityState)))
        && (value.continuityReason === undefined || ["migration_pending", "account_in_use", "source_changed", "recovery_required"].includes(String(value.continuityReason)))
        && (value.continuityBlocker === undefined || safeLabel(value.continuityBlocker));
}
function isQuota(value) { return (0, types_1.isPlainRecord)(value) && isOpaqueAccount(value.opaqueAccountId) && ["fresh", "stale", "unknown"].includes(String(value.freshness)) && (value.remainingPercent === null || typeof value.remainingPercent === "number") && (value.resetAt === null || typeof value.resetAt === "string") && (value.shortWindowPressure === null || typeof value.shortWindowPressure === "number") && (value.resetCredits === null || typeof value.resetCredits === "number") && (value.refreshState === undefined || ["idle", "loading", "error"].includes(String(value.refreshState))) && (value.errorCode === undefined || value.errorCode === null || ["authentication", "connection", "unavailable"].includes(String(value.errorCode))) && (value.lastAttemptAt === undefined || value.lastAttemptAt === null || typeof value.lastAttemptAt === "string"); }
function isConnection(value) { return (0, types_1.isPlainRecord)(value) && isOpaqueAccount(value.opaqueAccountId) && isPrivateSurface(value.kind) && isDefinition(value.definitionRef) && ["unknown", "connecting", "connected", "blocked", "unavailable"].includes(String(value.status)); }
function isEnrollment(value) { return (0, types_1.isPlainRecord)(value) && typeof value.enrollmentRef === "string" && /^be_[A-Za-z0-9_-]{16,128}$/.test(value.enrollmentRef) && (value.kind === "enrollment" || value.kind === "reconnect") && (value.opaqueAccountId === null || isOpaqueAccount(value.opaqueAccountId)) && ["starting", "waiting", "complete", "cancelled", "failed", "expired"].includes(String(value.state)); }
function isHandoff(value) { return (0, types_1.isPlainRecord)(value) && value.version === 1 && typeof value.handoffRef === "string" && /^bh_[A-Za-z0-9_-]{16,128}$/.test(value.handoffRef) && typeof value.confirmationId === "string" && /^bc_[A-Za-z0-9_-]{16,128}$/.test(value.confirmationId) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId) && typeof value.taskRef === "string" && /^bt_[A-Za-z0-9_-]{16,128}$/.test(value.taskRef) && typeof value.originRendererRef === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value.originRendererRef) && isOpaqueAccount(value.fromOpaqueAccountId) && isOpaqueAccount(value.toOpaqueAccountId) && ["pending", "forwarding", "ambiguous", "cancelled", "expired"].includes(String(value.state)) && typeof value.expiresAt === "string"; }
function isTaskOwnership(value) { return (0, types_1.isPlainRecord)(value) && typeof value.taskRef === "string" && /^bt_[A-Za-z0-9_-]{16,128}$/.test(value.taskRef) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId) && isOpaqueAccount(value.opaqueAccountId) && typeof value.ownerRendererRef === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value.ownerRendererRef) && typeof value.activeRunCount === "number" && Number.isInteger(value.activeRunCount) && value.activeRunCount >= 0 && ["none", "pending", "ambiguous"].includes(String(value.handoffState)); }
function isLogicalSubscription(value) { return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["accountId", "label"].join("\0") && isOpaqueAccount(value.accountId) && safeLabel(value.label); }
function isLogicalConversation(value) {
    return (0, types_1.isPlainRecord)(value) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId)
        && ["complete", "partial", "incomplete", "ambiguous"].includes(String(value.availability)) && Array.isArray(value.segments) && value.segments.length <= 64
        && value.segments.every((segment) => (0, types_1.isPlainRecord)(segment) && typeof segment.segmentId === "string" && /^ls_[A-Za-z0-9_-]{16,128}$/.test(segment.segmentId) && isLogicalSubscription(segment.subscription) && ["committed", "active", "incomplete", "ambiguous"].includes(String(segment.state)) && (segment.committedAt === undefined || typeof segment.committedAt === "string"))
        && (value.activeClient === null || ((0, types_1.isPlainRecord)(value.activeClient) && typeof value.activeClient.clientId === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value.activeClient.clientId) && safeLabel(value.activeClient.label) && isLogicalSubscription(value.activeClient.subscription)))
        && (value.historyWarning === undefined || value.historyWarning === null || ["content_gap", "ambiguous"].includes(String(value.historyWarning)))
        && typeof value.peerBusy === "boolean" && typeof value.updatedAt === "string";
}
function isLogicalTurn(value) { return (0, types_1.isPlainRecord)(value) && typeof value.turnId === "string" && /^lt_[A-Za-z0-9_-]{16,128}$/.test(value.turnId) && value.state === "committed" && isLogicalSubscription(value.subscription); }
function isLogicalContinuation(value) { return (0, types_1.isPlainRecord)(value) && typeof value.confirmationId === "string" && /^bc_[A-Za-z0-9_-]{16,128}$/.test(value.confirmationId) && ["pending", "confirmed", "cancelled", "expired"].includes(String(value.state)) && typeof value.expiresAt === "string" && value.kind === "subscription_switch" && isLogicalSubscription(value.fromSubscription) && isLogicalSubscription(value.toSubscription) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId); }
function isSafeProfile(value) { return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["avatarUrl", "identifierMasked", "plan"].join("\0") && (value.plan === null || (typeof value.plan === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(value.plan))) && (value.identifierMasked === null || (typeof value.identifierMasked === "string" && /^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(value.identifierMasked))) && (value.avatarUrl === null || isSafeAvatarUrl(value.avatarUrl)); }
function isSafeAvatarUrl(value) { if (typeof value !== "string" || value.length < 12 || value.length > 2_048)
    return false; try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password && !url.search && !url.hash && (url.port === "" || url.port === "443");
}
catch {
    return false;
} }
function isSafeOAuthUrl(value) { if (typeof value !== "string" || value.length < 12 || value.length > 2_048)
    return false; try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || (url.port && url.port !== "443"))
        return false;
    for (const [key, item] of url.searchParams) {
        if (/^(?:access_?token|refresh_?token|id_?token|token|code|client_?secret|credential|cookie)$/i.test(key) || /(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i.test(item))
            return false;
    }
    return true;
}
catch {
    return false;
} }
function hash(secret, value) { return (0, node_crypto_1.createHmac)("sha256", secret).update(value, "utf8").digest("base64url"); }
function requestIdFrom(value) { return (0, types_1.isPlainRecord)(value) && typeof value.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.requestId) ? value.requestId : "invalid"; }
function invalidRequest(requestId) { return { version: 1, requestId, ok: false, error: { code: "invalid_request", retryable: false } }; }
function unavailable(requestId) { return { version: 1, requestId, ok: false, error: { code: "broker_unavailable", retryable: true } }; }
function assertRendererSafe(value) {
    // The generic router redactor intentionally rejects every `email` key.
    // Accounts profiles are allowed to carry a *null or explicitly masked*
    // email field, so validate that narrow public exception before applying the
    // regular redactor to a copy with the display-only field removed.
    assertMaskedPublicProfileFields(value);
    (0, redaction_1.assertRedacted)(withoutDisplayOnlyProfileFields(value));
    if (/\b(?:ar|br|bat|bd|bt|bh|be|bc|lc|ls|lt)_[A-Za-z0-9_-]+/.test(JSON.stringify(value))) {
        throw new Error("private accounts broker handle escaped adapter");
    }
}
function assertMaskedPublicProfileFields(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            assertMaskedPublicProfileFields(item);
        return;
    }
    if (!(0, types_1.isPlainRecord)(value))
        return;
    for (const [key, item] of Object.entries(value)) {
        if (key === "email") {
            if (item !== null && (typeof item !== "string" || !/^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(item))) {
                throw new Error("unmasked email escaped accounts adapter");
            }
            continue;
        }
        if (key === "avatarUrl" && item !== null) {
            if (!isSafeAvatarUrl(item))
                throw new Error("unsafe avatar url");
            continue;
        }
        if (key === "oauthUrl") {
            if (!isSafeOAuthUrl(item))
                throw new Error("unsafe oauth handoff");
            continue;
        }
        if (key === "authorizationAvailable") {
            if (typeof item !== "boolean")
                throw new Error("invalid connection authorization projection");
            continue;
        }
        assertMaskedPublicProfileFields(item);
    }
}
function withoutDisplayOnlyProfileFields(value) {
    if (Array.isArray(value))
        return value.map(withoutDisplayOnlyProfileFields);
    if (!(0, types_1.isPlainRecord)(value))
        return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === "email" || key === "avatarUrl" || key === "oauthUrl" || key === "authorizationAvailable")
            continue;
        if (key === "label" && typeof item === "string" && /^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(item)) {
            output[key] = "[masked account identity]";
            continue;
        }
        output[key] = withoutDisplayOnlyProfileFields(item);
    }
    return output;
}
//# sourceMappingURL=broker-adapter.js.map
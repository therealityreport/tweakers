"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountRouterMux = exports.RouterPreDispatchError = void 0;
const node_crypto_1 = require("node:crypto");
const types_1 = require("./types");
const ledger_1 = require("./ledger");
const redaction_1 = require("./redaction");
const quota_1 = require("./quota");
const config_1 = require("./config");
const protocol_1 = require("./protocol");
const QUOTA_PROBE_TIMEOUT_MS = 5_000;
const FANOUT_TIMEOUT_MS = 5_000;
const DESKTOP_REQUEST_TIMEOUT_MS = 60_000;
const INTERACTIVE_SERVER_REQUEST_MIN_MS = 30 * 60_000;
const INTERACTIVE_SERVER_REQUEST_MAX_MS = 24 * 60 * 60_000;
const INTERACTIVE_SERVER_REQUEST_SAFETY_MARGIN_MS = 30_000;
const NETWORK_SERVER_REQUEST_MIN_MS = 2 * 60_000;
const NETWORK_SERVER_REQUEST_MAX_MS = 30 * 60_000;
const MAX_ACTIVE_SERVER_REQUESTS = 64;
const MAX_ACTIVE_DIRECT_REQUESTS = 128;
// Section ids remain usable after a short pagination session expires, but the
// router still bounds the in-memory map and clears it on mux shutdown.
const SECTION_BINDING_TTL_MS = 8 * 60 * 60_000;
const INTERACTIVE_SERVER_REQUEST_METHODS = new Set([
    "applyPatchApproval", "execCommandApproval", "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/call",
    "item/tool/requestUserInput", "mcpServer/elicitation/request",
]);
// These request families are account/process scoped. Every other admitted
// child-originated request is thread-scoped and must prove its durable owner.
const GLOBAL_SERVER_REQUEST_METHODS = new Set([
    "account/chatgptAuthTokens/refresh", "attestation/generate",
]);
// These operations can legitimately remain active while a command, MCP tool,
// or turn runs. Their count is bounded, but no wall-clock timeout fabricates a
// failure while the child is still doing the requested work.
const LONG_LIVED_DIRECT_METHODS = new Set([
    "command/exec", "mcpServer/tool/call", "process/spawn", "fs/watch",
    "thread/start", "turn/start", "turn/steer", "thread/compact/start", "thread/realtime/start",
]);
class RouterPreDispatchError extends Error {
    constructor(message = "child stdin was not written") {
        super(message);
        this.name = "RouterPreDispatchError";
    }
}
exports.RouterPreDispatchError = RouterPreDispatchError;
/**
 * The JSONL-only app-server multiplexer. Its public output is restricted to
 * normal JSON-RPC frames and redacted router errors; status/protocol details
 * stay in owner-private state.
 */
class AccountRouterMux {
    options;
    children = new Map();
    correlations;
    ledger;
    issued = new Map();
    fanouts = new Map();
    aggregateSessions = new Map();
    sectionSessions = new Map();
    sectionBindings = new Map();
    sectionBindingKeys = new Map();
    pendingReservationsByThread = new Map();
    bufferedStartedThreads = new Map();
    serverRequestsByChild = new Map();
    serverRequestsByDesktop = new Map();
    serverRequestTombstonesByChild = new Map();
    serverRequestTombstonesByDesktop = new Map();
    tokenUsage = new Map();
    refreshInFlight = new Map();
    quota = new Map();
    quotaProbesInFlight = new Map();
    quotaProbeTimers = new Map();
    desktopRequestTimers = new Map();
    expiredQuotaProbeIds = new Set();
    expiredFanoutReplyIds = new Set();
    expiredDesktopRequestIds = new Set();
    consumedRouterCursors = new Set();
    controlSecret;
    accepting = true;
    started = false;
    initialized = false;
    precisionEstimated = false;
    fatalSignalled = false;
    shutdownSignalled = false;
    quotaProbeNonce = 0;
    queuedNewThread = null;
    queuedNewThreadTimer = null;
    constructor(options) {
        this.options = options;
        this.controlSecret = options.controlSecret ?? (0, node_crypto_1.randomBytes)(32);
        this.ledger = new ledger_1.AccountLedger(options.store, options.config, options.now);
        this.correlations = new protocol_1.CorrelationTable(options.store.snapshot().correlations, (records) => {
            options.store.update((state) => { state.correlations = records; });
        });
        if ((0, config_1.isQuotaAwareRouterConfig)(options.config)) {
            for (const account of options.config.accounts)
                this.quota.set(account.opaqueAccountId, (0, quota_1.emptyQuotaObservation)());
        }
    }
    start() {
        if (this.started)
            return this.children.size > 0;
        this.started = true;
        for (const account of this.options.config.accounts) {
            if (!account.included)
                continue;
            try {
                const child = this.options.childFactory.create(account.opaqueAccountId, {
                    onMessage: (message) => this.handleChildMessage(account.opaqueAccountId, message),
                    onFailure: () => this.postStartFailure("post_start_failure"),
                });
                this.children.set(account.opaqueAccountId, child);
                this.ledger.setEligibility(account.opaqueAccountId, "validating");
            }
            catch {
                this.postStartFailure("isolation_failure");
                return false;
            }
        }
        if (this.children.size === 0) {
            this.postStartFailure("startup_selfcheck_failed");
            return false;
        }
        return true;
    }
    receiveDesktopLine(line) {
        const message = (0, protocol_1.parseJsonRpcLine)(line);
        if (!message) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(null, "invalid_request"));
            return;
        }
        this.receiveDesktop(message);
    }
    receiveDesktop(message) {
        if (!this.accepting) {
            if ((0, protocol_1.isRequest)(message))
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(message.id, "router_stopping"));
            return;
        }
        if ((0, protocol_1.isResponse)(message)) {
            this.routeDesktopResponse(message);
            return;
        }
        if ((0, protocol_1.isNotification)(message)) {
            if (message.method !== "initialized" || !this.initialized) {
                this.protocolDrift();
                return;
            }
            for (const child of this.children.values()) {
                try {
                    child.send(message);
                }
                catch {
                    this.postStartFailure("post_start_failure");
                }
            }
            return;
        }
        this.routeDesktopRequest(message);
    }
    status() {
        if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config))
            return this.quotaAwareStatus();
        const state = this.options.store.snapshot();
        const protocolState = state.stagedDisable?.reasonCode === "protocol_drift" ? "drifted" : "supported";
        return {
            schemaVersion: 1,
            mode: state.stagedDisable ? "direct_fallback" : "balanced",
            protocolState,
            fairnessPrecision: this.precisionEstimated ? "estimated" : this.ledger.precision,
            accounts: this.options.config.accounts.map((account, index) => ({
                opaqueAccountId: account.opaqueAccountId,
                label: index === 0 ? "Account A" : "Account B",
                eligibility: state.accountEligibility[account.opaqueAccountId] ?? "unhealthy",
                normalizedSpend: (0, ledger_1.normalizedSpend)(state, account.opaqueAccountId),
                assignedThreadCount: state.ledger[account.opaqueAccountId]?.assignedThreadCount ?? 0,
            })),
            restartRequired: state.stagedDisable !== null,
            degradedReason: state.stagedDisable?.reasonCode === "protocol_drift" ? "unsupported_protocol"
                : state.stagedDisable?.reasonCode === "post_start_failure" ? "post_start_failure"
                    : state.stagedDisable?.reasonCode === "isolation_failure" ? "capability_mismatch" : null,
        };
    }
    shutdown() {
        if (this.shutdownSignalled)
            return;
        this.shutdownSignalled = true;
        for (const timer of this.quotaProbeTimers.values())
            this.clearTimer(timer);
        this.quotaProbeTimers.clear();
        for (const timer of this.desktopRequestTimers.values())
            this.clearTimer(timer);
        this.desktopRequestTimers.clear();
        for (const fanout of this.fanouts.values())
            if (fanout.timeout)
                this.clearTimer(fanout.timeout);
        this.fanouts.clear();
        this.aggregateSessions.clear();
        this.sectionSessions.clear();
        this.sectionBindings.clear();
        this.sectionBindingKeys.clear();
        for (const pending of this.bufferedStartedThreads.values())
            this.clearTimer(pending.timer);
        this.bufferedStartedThreads.clear();
        for (const request of this.serverRequestsByChild.values()) {
            this.clearTimer(request.timer);
            this.correlations.consume(request.correlationId, "child_to_client", request.childId);
        }
        this.serverRequestsByChild.clear();
        this.serverRequestsByDesktop.clear();
        this.serverRequestTombstonesByChild.clear();
        this.serverRequestTombstonesByDesktop.clear();
        this.tokenUsage.clear();
        this.refreshInFlight.clear();
        for (const [internalId, issued] of this.issued) {
            this.issued.delete(internalId);
            this.correlations.consume(internalId, "client_to_child", issued.child.opaqueAccountId);
            if (issued.reservationId && ![...this.pendingReservationsByThread.values()].includes(issued.reservationId)) {
                this.ledger.strandAmbiguous(issued.reservationId);
                if (issued.pendingOwnerKey)
                    this.ledger.clearPendingOwner(issued.pendingOwnerKey, issued.child.opaqueAccountId);
            }
        }
        this.clearQueuedNewThread();
        this.options.onShutdown?.();
        if (!this.accepting && this.children.size === 0)
            return;
        this.accepting = false;
        for (const child of this.children.values()) {
            try {
                child.terminate("SIGTERM");
            }
            catch { /* bounded owned-child cleanup */ }
        }
    }
    routeDesktopRequest(request) {
        const route = (0, protocol_1.classifyClientMethod)(request.method, request.params);
        if (route === "unknown") {
            this.protocolDrift();
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "unknown_method"));
            return;
        }
        if (route === "reject_in_balanced_mode_use_manual_enrollment") {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "balanced_mode_auth_mutation"));
            return;
        }
        if (route === "reject_capability_mutation_restart_required") {
            this.stageCapabilityRestartRequired();
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "capability_mismatch"));
            return;
        }
        if (route === "reject_sections_read_only") {
            this.options.writeDesktop(sectionRouterError(request.id, "sections_read_only"));
            return;
        }
        if (route === "fanout_initialize_intersection") {
            this.initialize(request);
            return;
        }
        if (!this.initialized) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "post_start_failure"));
            return;
        }
        if (route === "balance_new_thread") {
            this.dispatchNewThread(request);
            return;
        }
        if (route === "fanout_feature_enablement") {
            this.dispatchFeatureEnablement(request);
            return;
        }
        if (route === "fanout_sections_read") {
            this.dispatchSectionRead(request);
            return;
        }
        if (route === "fanout_aggregate_read_with_router_cursor" || route === "fanout_aggregate_namespaced_sections") {
            if (request.method === "thread/list" && (0, types_1.isPlainRecord)(request.params) && request.params.sectionId !== undefined && request.params.sectionId !== null) {
                this.dispatchSectionFilteredList(request);
                return;
            }
            if (request.method === "thread/list" && hasSectionPositionSort(request.params)) {
                this.options.writeDesktop(sectionRouterError(request.id, "section_unsupported"));
                return;
            }
            this.dispatchFanout(request, route);
            return;
        }
        // App-server gives a non-empty path precedence over threadId for fork.
        // That path belongs to one private home and is not safely namespaceable.
        if (request.method === "thread/fork" && hasNonEmptyPath(request.params)) {
            this.stageCapabilityRestartRequired();
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "capability_mismatch"));
            return;
        }
        const child = this.childForRoute(route, request.params);
        if (!child) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, (0, protocol_1.hasThreadId)(request.params) ? "unknown_thread_owner" : "pool_depleted"));
            return;
        }
        this.dispatchToChild(request, child);
    }
    initialize(request) {
        if (this.initialized) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_request"));
            return;
        }
        const key = fanoutKey(request.id);
        const fanout = { desktopId: request.id, expected: this.children.size, responses: [], failed: false, route: "fanout_initialize_intersection" };
        this.fanouts.set(key, fanout);
        this.startFanoutTimeout(key, fanout);
        let scope = 0;
        for (const child of this.children.values()) {
            const issued = this.dispatchToChild(request, child, { fanoutKey: key, initialization: true, scope: `init-${scope++}` });
            if (!issued) {
                this.failFanout(fanout, key);
                return;
            }
        }
    }
    dispatchFeatureEnablement(request) {
        const key = fanoutKey(request.id);
        const fanout = { desktopId: request.id, expected: this.children.size, responses: [], failed: false, route: "fanout_feature_enablement" };
        this.fanouts.set(key, fanout);
        this.startFanoutTimeout(key, fanout);
        let scope = 0;
        for (const child of this.children.values()) {
            if (!this.dispatchToChild(request, child, { fanoutKey: key, scope: `feature-${scope++}` }))
                this.failFanout(fanout, key);
        }
    }
    dispatchNewThread(request) {
        if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config) && this.options.config.mode === "manual") {
            // Manual v2 remains mux-backed for durable aggregate history, but new
            // work is an explicit primary-only route. Quota observations stay
            // visible truth and never select or fail over to the other account.
            const primary = this.options.config.primaryOpaqueAccountId;
            const state = this.options.store.snapshot();
            if (!this.children.has(primary) || state.accountEligibility[primary] !== "eligible") {
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "pool_depleted"));
                return;
            }
            this.dispatchSelectedNewThread(request, primary);
            return;
        }
        const first = (0, config_1.isQuotaAwareRouterConfig)(this.options.config)
            ? this.ledger.selectQuotaAware(this.quota)
            : this.ledger.select();
        if (!first) {
            if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config) && this.quotaNeedsRefresh()) {
                this.queueNewThreadForQuotaRefresh(request);
                return;
            }
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "pool_depleted"));
            return;
        }
        this.dispatchSelectedNewThread(request, first.opaqueAccountId);
    }
    /** A request is delivered once, only after fresh two-account capacity exists. */
    dispatchSelectedNewThread(request, account) {
        const estimatedCost = this.ledger.estimateRequestCost(request.params, modelFrom(request.params));
        const child = this.children.get(account);
        if (!child) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "pool_depleted"));
            return;
        }
        const reservation = this.ledger.reserve(account, estimatedCost);
        const pendingOwnerKey = `pending:${reservation.reservationId}`;
        this.ledger.reservePendingOwner(pendingOwnerKey, account);
        try {
            const issued = this.dispatchToChild(request, child, {
                reservationId: reservation.reservationId, pendingOwnerKey, scope: "new", suppressDesktopError: true,
            });
            if (issued)
                return;
            this.ledger.releasePreDispatch(reservation.reservationId);
            this.ledger.clearPendingOwner(pendingOwnerKey, account);
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
        }
        catch (error) {
            if (error instanceof RouterPreDispatchError) {
                this.ledger.releasePreDispatch(reservation.reservationId);
                this.ledger.clearPendingOwner(pendingOwnerKey, account);
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "post_start_failure"));
                return;
            }
            this.ledger.strandAmbiguous(reservation.reservationId);
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "ambiguous_dispatch"));
        }
    }
    dispatchFanout(request, route) {
        const aggregate = route === "fanout_aggregate_read_with_router_cursor"
            ? this.aggregateRequest(request)
            : null;
        if (route === "fanout_aggregate_read_with_router_cursor" && !aggregate) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        const key = fanoutKey(request.id);
        const selectable = [...this.children.values()].filter((child) => this.options.store.snapshot().accountEligibility[child.opaqueAccountId] !== "protocol_blocked");
        if (selectable.length === 0) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "pool_depleted"));
            return;
        }
        const targets = aggregate
            ? selectable.filter((child) => aggregate.initial
                || ((aggregate.session.buffers.get(child.opaqueAccountId)?.length ?? 0) === 0
                    && (aggregate.cursors.get(child.opaqueAccountId) ?? null) !== null))
            : selectable;
        const fanout = { desktopId: request.id, expected: targets.length, responses: [], failed: false, route, aggregate: aggregate ?? undefined };
        this.fanouts.set(key, fanout);
        this.startFanoutTimeout(key, fanout);
        if (targets.length === 0) {
            this.completeFanout(key, fanout);
            return;
        }
        for (const [index, child] of targets.entries()) {
            const childRequest = aggregate ? rewriteAggregateCursor(request, aggregate.cursors.get(child.opaqueAccountId) ?? null, aggregate) : request;
            const issued = this.dispatchToChild(childRequest, child, { fanoutKey: key, scope: `read-${index}` });
            if (!issued) {
                this.failFanout(fanout, key);
                return;
            }
        }
    }
    /** Read-only section namespace. Local section ids never cross the mux. */
    dispatchSectionRead(request) {
        const section = this.sectionRequest(request);
        if (!section) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        const targets = [...this.children.values()].filter((child) => section.initial
            || ((section.session.buffers.get(child.opaqueAccountId)?.length ?? 0) === 0
                && (section.cursors.get(child.opaqueAccountId) ?? null) !== null));
        const key = fanoutKey(request.id);
        const fanout = {
            desktopId: request.id, expected: targets.length, responses: [], failed: false,
            route: "fanout_sections_read", sections: section,
        };
        this.fanouts.set(key, fanout);
        this.startFanoutTimeout(key, fanout);
        if (targets.length === 0) {
            this.completeFanout(key, fanout);
            return;
        }
        for (const [index, child] of targets.entries()) {
            const cursor = section.cursors.get(child.opaqueAccountId) ?? null;
            const params = (0, types_1.isPlainRecord)(request.params) ? { ...request.params } : {};
            if (section.childLimit === undefined)
                delete params.limit;
            else
                params.limit = section.childLimit;
            if (cursor === null)
                delete params.cursor;
            else
                params.cursor = cursor;
            const issued = this.dispatchToChild({ ...request, params }, child, { fanoutKey: key, scope: `sections-${index}` });
            if (!issued) {
                this.failFanout(fanout, key);
                return;
            }
        }
    }
    /** A resolved router section confines the read to its single owning home. */
    dispatchSectionFilteredList(request) {
        if (!(0, types_1.isPlainRecord)(request.params) || typeof request.params.sectionId !== "string") {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        const binding = this.resolveSectionBinding(request.params.sectionId);
        if (!binding) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        const child = this.children.get(binding.childId);
        const aggregate = this.aggregateRequest(request);
        if (!child || !aggregate) {
            this.options.writeDesktop(sectionRouterError(request.id, "section_unsupported"));
            return;
        }
        const key = fanoutKey(request.id);
        const fanout = {
            desktopId: request.id, expected: 1, responses: [], failed: false,
            route: "fanout_aggregate_read_with_router_cursor", aggregate,
        };
        this.fanouts.set(key, fanout);
        this.startFanoutTimeout(key, fanout);
        const cursor = aggregate.cursors.get(binding.childId) ?? null;
        const childRequest = rewriteAggregateCursor({
            ...request,
            params: { ...request.params, sectionId: binding.localId },
        }, cursor, aggregate);
        const issued = this.dispatchToChild(childRequest, child, { fanoutKey: key, scope: "section-filter" });
        if (!issued)
            this.failFanout(fanout, key);
    }
    sectionRequest(request) {
        if (request.method !== "threadSection/list" || !(0, types_1.isPlainRecord)(request.params ?? {}))
            return null;
        const params = request.params ?? {};
        if (!(0, types_1.isPlainRecord)(params) || Object.keys(params).some((key) => key !== "cursor" && key !== "limit"))
            return null;
        const requestedLimit = params.limit;
        if (requestedLimit !== undefined && requestedLimit !== null
            && (typeof requestedLimit !== "number" || !Number.isInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > MAX_AGGREGATE_PAGE_ROWS))
            return null;
        // Official section/list accepts omitted, null, and zero limits. The mux
        // retains that child request shape but collects at most one safe page.
        const limit = typeof requestedLimit === "number" && requestedLimit > 0 ? requestedLimit : MAX_AGGREGATE_PAGE_ROWS;
        const filterBinding = sectionFilterBinding(requestedLimit);
        this.evictExpiredSectionSessions();
        if (params.cursor === undefined || params.cursor === null) {
            const session = this.createSectionSession(filterBinding);
            return {
                session, limit, childLimit: requestedLimit, initial: true,
                cursors: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, null])),
            };
        }
        if (typeof params.cursor !== "string" || this.consumedRouterCursors.has(params.cursor))
            return null;
        const payload = parseSectionCursor(params.cursor, this.controlSecret);
        const session = payload ? this.sectionSessions.get(payload.sessionId) ?? null : null;
        if (!payload || !session || session.expiresAt <= this.now() || payload.filterBinding !== filterBinding
            || payload.sequence !== session.sequence)
            return null;
        this.consumedRouterCursors.add(params.cursor);
        while (this.consumedRouterCursors.size > 128)
            this.consumedRouterCursors.delete(this.consumedRouterCursors.values().next().value);
        session.sequence += 1;
        session.expiresAt = this.now() + this.aggregateSessionTtl();
        return {
            session, limit, childLimit: requestedLimit, initial: false,
            cursors: new Map(session.nextCursors),
        };
    }
    createSectionSession(filterBinding) {
        this.evictExpiredSectionSessions();
        while (this.sectionSessions.size >= MAX_AGGREGATE_SESSIONS)
            this.sectionSessions.delete(this.sectionSessions.keys().next().value);
        const session = {
            id: (0, node_crypto_1.randomBytes)(16).toString("base64url"), sequence: 1, expiresAt: this.now() + this.aggregateSessionTtl(), filterBinding,
            seenRouterIds: new Set(),
            buffers: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, []])),
            nextCursors: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, null])),
        };
        this.sectionSessions.set(session.id, session);
        return session;
    }
    evictExpiredSectionSessions() {
        const now = this.now();
        for (const [id, session] of this.sectionSessions)
            if (session.expiresAt <= now)
                this.sectionSessions.delete(id);
        for (const [id, binding] of this.sectionBindings) {
            if (binding.expiresAt > now)
                continue;
            this.sectionBindings.delete(id);
            this.sectionBindingKeys.delete(sectionBindingKey(binding.childId, binding.localId));
        }
    }
    sectionRouterId(childId, localId) {
        this.evictExpiredSectionSessions();
        const key = sectionBindingKey(childId, localId);
        const existing = this.sectionBindingKeys.get(key);
        if (existing && this.sectionBindings.has(existing))
            return existing;
        const nonce = (0, node_crypto_1.randomBytes)(16).toString("base64url");
        const signature = (0, node_crypto_1.createHmac)("sha256", this.controlSecret).update(`section:v1:${nonce}`, "utf8").digest("base64url");
        const id = `ars1.${nonce}.${signature}`;
        this.sectionBindings.set(id, { childId, localId, expiresAt: this.now() + SECTION_BINDING_TTL_MS });
        this.sectionBindingKeys.set(key, id);
        while (this.sectionBindings.size > MAX_AGGREGATE_SESSION_ROWS) {
            const [expiredId, binding] = this.sectionBindings.entries().next().value;
            this.sectionBindings.delete(expiredId);
            this.sectionBindingKeys.delete(sectionBindingKey(binding.childId, binding.localId));
        }
        return id;
    }
    resolveSectionBinding(id) {
        if (!validSectionRouterId(id, this.controlSecret))
            return null;
        this.evictExpiredSectionSessions();
        return this.sectionBindings.get(id) ?? null;
    }
    /**
     * A router cursor is the only accepted continuation token for a fanout read.
     * It binds method and all non-cursor filter fields so a child cursor cannot be
     * replayed against another request shape or method.
     */
    aggregateRequest(request) {
        if (request.method !== "thread/list" && request.method !== "thread/search" && request.method !== "thread/loaded/list")
            return null;
        const params = request.params ?? {};
        if (!(0, types_1.isPlainRecord)(params))
            return null;
        const options = aggregatePageOptions(request.method, params);
        if (!options)
            return null;
        const filterBinding = aggregateFilterBinding(request.method, params, options);
        this.evictExpiredAggregateSessions();
        const submittedCursor = params.cursor;
        if (submittedCursor === undefined || submittedCursor === null) {
            const session = this.createAggregateSession(request.method, filterBinding, options);
            return {
                method: request.method,
                filterBinding,
                ...options,
                direction: "next",
                initial: true,
                session,
                cursors: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, null])),
            };
        }
        if (typeof submittedCursor !== "string")
            return null;
        const payload = parseRouterCursor(submittedCursor, this.controlSecret);
        const session = payload ? this.aggregateSessions.get(payload.sessionId) ?? null : null;
        if (!payload || !session || session.expiresAt <= this.now() || payload.method !== request.method
            || payload.sequence !== session.sequence || !cursorMatchesAggregateRequest(payload, filterBinding, request.method, params))
            return null;
        if (this.consumedRouterCursors.has(submittedCursor))
            return null;
        this.consumedRouterCursors.add(submittedCursor);
        while (this.consumedRouterCursors.size > 128)
            this.consumedRouterCursors.delete(this.consumedRouterCursors.values().next().value);
        if (payload.direction === "backwards" && session.filterBinding !== filterBinding)
            this.resetAggregateSession(session);
        session.filterBinding = filterBinding;
        session.sortKey = options.sortKey;
        session.sortDirection = options.sortDirection;
        session.sequence += 1;
        session.expiresAt = this.now() + this.aggregateSessionTtl();
        return {
            method: request.method,
            filterBinding,
            ...options,
            direction: payload.direction,
            initial: false,
            session,
            cursors: new Map(payload.direction === "next" ? session.nextCursors : session.backwardsCursors),
        };
    }
    createAggregateSession(method, filterBinding, options) {
        this.evictExpiredAggregateSessions();
        while (this.aggregateSessions.size >= MAX_AGGREGATE_SESSIONS)
            this.aggregateSessions.delete(this.aggregateSessions.keys().next().value);
        const session = {
            id: (0, node_crypto_1.randomBytes)(16).toString("base64url"), method, filterBinding,
            sortKey: options.sortKey, sortDirection: options.sortDirection, sequence: 1,
            expiresAt: this.now() + this.aggregateSessionTtl(),
            buffers: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, []])),
            nextCursors: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, null])),
            backwardsCursors: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, null])),
            seenThreadIds: new Set(), rows: 0, bytes: 0,
        };
        this.aggregateSessions.set(session.id, session);
        return session;
    }
    resetAggregateSession(session) {
        for (const buffer of session.buffers.values())
            buffer.length = 0;
        session.seenThreadIds.clear();
        session.rows = 0;
        session.bytes = 0;
    }
    aggregateSessionTtl() {
        const ttl = this.options.aggregateSessionTtlMs ?? AGGREGATE_SESSION_TTL_MS;
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 5 * 60_000)
            throw new Error("invalid account-router aggregate session TTL");
        return ttl;
    }
    evictExpiredAggregateSessions() {
        const now = this.now();
        for (const [id, session] of this.aggregateSessions)
            if (session.expiresAt <= now)
                this.aggregateSessions.delete(id);
    }
    bindAggregateThreads(method, entries, owner) {
        try {
            for (const entry of entries) {
                const threadId = aggregateThreadId(method, entry);
                // The listed item must name a thread. Exposing an entry that cannot be
                // durably routed later would turn a list response into an affinity bug.
                if (!threadId)
                    return false;
                this.ledger.bindKnownThread(threadId, owner);
            }
            return true;
        }
        catch {
            // A duplicate id from different per-account results makes all later
            // thread-affine traffic ambiguous. Do not expose a partial fanout page.
            return false;
        }
    }
    appendAggregatePage(aggregate, page, owner) {
        const session = aggregate.session;
        if (!this.bindAggregateThreads(aggregate.method, page.data, owner))
            return false;
        const ids = page.data.map((entry) => aggregateThreadId(aggregate.method, entry));
        if (ids.some((id) => id === null || session.seenThreadIds.has(id)))
            return false;
        let bytes;
        try {
            bytes = Buffer.byteLength(JSON.stringify(page.data), "utf8");
        }
        catch {
            return false;
        }
        if (page.data.length > MAX_AGGREGATE_PAGE_ROWS || session.rows + page.data.length > MAX_AGGREGATE_SESSION_ROWS
            || session.bytes + bytes > MAX_AGGREGATE_SESSION_BYTES)
            return false;
        const buffer = session.buffers.get(owner);
        if (!buffer)
            return false;
        buffer.push(...page.data);
        for (const id of ids)
            session.seenThreadIds.add(id);
        session.rows += page.data.length;
        session.bytes += bytes;
        session.nextCursors.set(owner, page.nextCursor);
        session.backwardsCursors.set(owner, page.backwardsCursor);
        session.expiresAt = this.now() + this.aggregateSessionTtl();
        return true;
    }
    /**
     * Parse every child response first, then atomically bind the complete batch
     * before changing in-memory pagination buffers. This keeps durable affinity
     * and assigned counts unchanged if the second child is malformed/collides.
     */
    appendAggregatePages(aggregate, pages) {
        if (this.aggregatePagesHaveOwnerCollision(aggregate, pages))
            return "owner_collision";
        const session = aggregate.session;
        const batch = [];
        const prepared = [];
        const observed = new Set(session.seenThreadIds);
        let totalRows = session.rows;
        let totalBytes = session.bytes;
        for (const source of pages) {
            const page = this.rewriteAggregatePage(source.page, aggregate.method, source.owner);
            const owner = source.owner;
            if (!page)
                return "invalid_page";
            if (!session.buffers.has(owner) || page.data.length > MAX_AGGREGATE_PAGE_ROWS)
                return "invalid_page";
            const ids = page.data.map((entry) => aggregateThreadId(aggregate.method, entry));
            if (ids.some((id) => id === null))
                return "invalid_page";
            const safeIds = ids;
            if (safeIds.some((id) => observed.has(id)))
                return "invalid_page";
            let bytes;
            try {
                bytes = aggregateEntriesBytes(page.data);
            }
            catch {
                return "invalid_page";
            }
            totalRows += page.data.length;
            totalBytes += bytes;
            if (totalRows > MAX_AGGREGATE_SESSION_ROWS || totalBytes > MAX_AGGREGATE_SESSION_BYTES)
                return "invalid_page";
            for (const id of safeIds) {
                observed.add(id);
                batch.push({ threadId: id, owner });
            }
            prepared.push({ page, owner, ids: safeIds, bytes });
        }
        try {
            this.ledger.bindKnownThreads(batch);
        }
        catch {
            return "owner_collision";
        }
        for (const { page, owner, ids, bytes } of prepared) {
            const buffer = session.buffers.get(owner);
            if (!buffer)
                return "invalid_page"; // guarded above; retain fail-closed invariant
            buffer.push(...page.data);
            for (const id of ids)
                session.seenThreadIds.add(id);
            session.rows += page.data.length;
            session.bytes += bytes;
            session.nextCursors.set(owner, page.nextCursor);
            session.backwardsCursors.set(owner, page.backwardsCursor);
        }
        session.expiresAt = this.now() + this.aggregateSessionTtl();
        return "ok";
    }
    aggregatePagesHaveOwnerCollision(aggregate, pages) {
        const owners = new Map();
        for (const { page, owner } of pages) {
            for (const entry of page.data) {
                const id = aggregateThreadId(aggregate.method, entry);
                if (!id)
                    return false;
                const prior = owners.get(id);
                if ((prior && prior !== owner) || (this.ledger.ownerFor(id) !== null && this.ledger.ownerFor(id) !== owner))
                    return true;
                owners.set(id, owner);
            }
        }
        return false;
    }
    /** Rewrite only known nested section ids; a local id is never exposed. */
    rewriteAggregatePage(page, method, owner) {
        const data = [];
        for (const entry of page.data) {
            const rewritten = this.rewriteAggregateSectionEntry(entry, method, owner);
            if (rewritten === null)
                return null;
            data.push(rewritten);
        }
        return { ...page, data };
    }
    rewriteAggregateSectionEntry(entry, method, owner) {
        if (method === "thread/loaded/list")
            return entry;
        if (!(0, types_1.isPlainRecord)(entry))
            return null;
        if (method === "thread/search") {
            if (!(0, types_1.isPlainRecord)(entry.thread))
                return null;
            const thread = this.rewriteThreadSection(entry.thread, owner);
            return thread ? { ...entry, thread } : null;
        }
        return this.rewriteThreadSection(entry, owner);
    }
    rewriteThreadSection(thread, owner) {
        const section = thread.section;
        if (section === undefined || section === null)
            return { ...thread };
        if (!(0, types_1.isPlainRecord)(section) || !safeThreadId(section.id))
            return null;
        return { ...thread, section: { ...section, id: this.sectionRouterId(owner, section.id) } };
    }
    /** Rewrite section references in direct responses and notifications too. */
    rewriteChildSections(message, owner) {
        let visited = 0;
        const rewrite = (value, depth) => {
            if (depth > 8 || ++visited > 2_048)
                return null;
            if (Array.isArray(value)) {
                const items = [];
                for (const item of value) {
                    const next = rewrite(item, depth + 1);
                    if (next === null)
                        return null;
                    items.push(next);
                }
                return items;
            }
            if (!(0, types_1.isPlainRecord)(value))
                return value;
            const output = {};
            for (const [key, item] of Object.entries(value)) {
                if (key === "section" && (0, types_1.isPlainRecord)(item) && typeof item.id === "string") {
                    output[key] = { ...item, id: this.sectionRouterId(owner, item.id) };
                    continue;
                }
                const next = rewrite(item, depth + 1);
                if (next === null)
                    return null;
                output[key] = next;
            }
            return output;
        };
        const rewritten = rewrite(message, 0);
        return rewritten && (0, types_1.isPlainRecord)(rewritten) ? rewritten : null;
    }
    appendSectionPages(section, pages) {
        const prepared = [];
        const observed = new Set(section.session.seenRouterIds);
        for (const { page, owner } of pages) {
            if (page.data.length > MAX_AGGREGATE_PAGE_ROWS || !section.session.buffers.has(owner))
                return false;
            const rewritten = [];
            for (const entry of page.data) {
                const localId = safeThreadId(entry.id);
                if (!localId)
                    return false;
                const routerId = this.sectionRouterId(owner, localId);
                if (observed.has(routerId))
                    return false;
                observed.add(routerId);
                rewritten.push({ ...entry, id: routerId });
            }
            prepared.push({ owner, data: rewritten, next: page.nextCursor });
        }
        for (const item of prepared) {
            const buffer = section.session.buffers.get(item.owner);
            if (!buffer)
                return false;
            buffer.push(...item.data);
            for (const entry of item.data)
                section.session.seenRouterIds.add(entry.id);
            section.session.nextCursors.set(item.owner, item.next);
        }
        section.session.expiresAt = this.now() + this.aggregateSessionTtl();
        return true;
    }
    sectionPageResult(section) {
        const data = [];
        for (const account of this.options.config.accounts) {
            const buffer = section.session.buffers.get(account.opaqueAccountId);
            while (buffer && buffer.length > 0 && data.length < section.limit)
                data.push(buffer.shift());
            if (data.length === section.limit)
                break;
        }
        section.session.expiresAt = this.now() + this.aggregateSessionTtl();
        return {
            data,
            nextCursor: sectionSessionCursor(section.session, this.controlSecret),
        };
    }
    aggregatePageResult(aggregate) {
        const session = aggregate.session;
        const selected = selectAggregateEntries(session, aggregate, this.options.config);
        if (!selected)
            return null;
        for (const item of selected) {
            const buffer = session.buffers.get(item.owner);
            if (!buffer || buffer.shift() !== item.entry)
                return null;
            session.rows = Math.max(0, session.rows - 1);
            try {
                session.bytes = Math.max(0, session.bytes - aggregateEntriesBytes([item.entry]));
            }
            catch {
                return null;
            }
        }
        session.expiresAt = this.now() + this.aggregateSessionTtl();
        return {
            data: selected.map((item) => item.entry),
            nextCursor: aggregateSessionCursor(session, "next", this.controlSecret),
            backwardsCursor: aggregateSessionCursor(session, "backwards", this.controlSecret),
        };
    }
    /** A read failure is request-local; only init or proven owner collision stops routing. */
    failFanout(fanout, key, unsafe = fanout.route === "fanout_initialize_intersection") {
        if (fanout.timeout)
            clearTimeout(fanout.timeout);
        fanout.timeout = undefined;
        if (key) {
            this.fanouts.delete(key);
            this.discardFanoutIssued(key);
        }
        if (fanout.aggregate)
            this.aggregateSessions.delete(fanout.aggregate.session.id);
        if (fanout.sections)
            this.sectionSessions.delete(fanout.sections.session.id);
        fanout.failed = true;
        this.options.writeDesktop((0, redaction_1.redactedRouterError)(fanout.desktopId, "post_start_failure"));
        if (unsafe)
            this.postStartFailure("post_start_failure");
    }
    discardFanoutIssued(key) {
        for (const [internalId, issued] of this.issued) {
            if (issued.fanoutKey !== key)
                continue;
            this.issued.delete(internalId);
            this.correlations.consume(internalId, "client_to_child", issued.child.opaqueAccountId);
            this.rememberExpiredFanoutReply(internalId);
        }
    }
    startFanoutTimeout(key, fanout) {
        const timeout = this.options.fanoutTimeoutMs ?? FANOUT_TIMEOUT_MS;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
            throw new Error("invalid account-router fanout timeout");
        fanout.timeout = setTimeout(() => {
            if (this.fanouts.get(key) !== fanout)
                return;
            this.fanouts.delete(key);
            fanout.timeout = undefined;
            for (const [internalId, issued] of this.issued) {
                if (issued.fanoutKey !== key)
                    continue;
                this.issued.delete(internalId);
                this.correlations.consume(internalId, "client_to_child", issued.child.opaqueAccountId);
                this.rememberExpiredFanoutReply(internalId);
            }
            this.failFanout(fanout, undefined);
        }, timeout);
        fanout.timeout.unref();
    }
    rememberExpiredFanoutReply(internalId) {
        this.expiredFanoutReplyIds.add(internalId);
        while (this.expiredFanoutReplyIds.size > 64)
            this.expiredFanoutReplyIds.delete(this.expiredFanoutReplyIds.values().next().value);
    }
    childForRoute(route, params) {
        const threadId = (0, protocol_1.threadIdFrom)(params);
        if (route === "persisted_thread_owner" && !threadId)
            return null;
        if (threadId && (route === "persisted_thread_owner" || route === "thread_owner_if_present_else_primary" || route === "primary_if_no_thread_then_revalidate_capabilities")) {
            const owner = this.ledger.ownerFor(threadId);
            return owner ? this.children.get(owner) ?? null : null;
        }
        return this.children.get(this.options.config.primaryOpaqueAccountId) ?? null;
    }
    dispatchToChild(request, child, extra = {}) {
        if (!extra.quotaProbe && !extra.fanoutKey && this.activeDirectRequestCount() >= MAX_ACTIVE_DIRECT_REQUESTS) {
            if (!extra.suppressDesktopError)
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return null;
        }
        let correlation;
        try {
            correlation = this.correlations.create("client_to_child", child.opaqueAccountId, request.id, request.method, extra.scope);
        }
        catch {
            if (!extra.quotaProbe && !extra.suppressDesktopError)
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return null;
        }
        const issued = {
            internalId: correlation.internalId,
            desktopId: request.id,
            child,
            method: request.method,
            reservationId: extra.reservationId,
            pendingOwnerKey: extra.pendingOwnerKey,
            fanoutKey: extra.fanoutKey,
            initialization: extra.initialization,
            quotaProbe: extra.quotaProbe,
            sourceThreadId: request.method === "review/start" || request.method === "thread/fork" ? (0, protocol_1.threadIdFrom)(request.params) ?? undefined : undefined,
        };
        this.issued.set(correlation.internalId, issued);
        try {
            child.send({ ...request, id: correlation.internalId });
            this.correlations.mark(correlation.internalId, "written");
            if (!extra.quotaProbe && !extra.fanoutKey && this.issued.has(correlation.internalId))
                this.startDesktopRequestTimeout(issued);
            return issued;
        }
        catch (error) {
            this.issued.delete(correlation.internalId);
            if (error instanceof RouterPreDispatchError) {
                this.correlations.consume(correlation.internalId, "client_to_child", child.opaqueAccountId);
                throw error;
            }
            if (extra.quotaProbe)
                this.correlations.consume(correlation.internalId, "client_to_child", child.opaqueAccountId);
            else
                this.correlations.mark(correlation.internalId, "acknowledged");
            if (issued.reservationId)
                this.ledger.strandAmbiguous(issued.reservationId);
            throw error;
        }
    }
    handleChildMessage(childId, message) {
        this.correlations.acknowledgeChild(childId);
        if ((0, protocol_1.isResponse)(message)) {
            this.handleChildResponse(childId, message);
            return;
        }
        if ((0, protocol_1.isRequest)(message)) {
            this.handleChildRequest(childId, message);
            return;
        }
        this.handleChildNotification(childId, message);
    }
    handleChildResponse(childId, response) {
        const correlation = this.correlations.consume(response.id, "client_to_child", childId);
        const issued = typeof response.id === "string" ? this.issued.get(response.id) : undefined;
        if (typeof response.id === "string") {
            this.issued.delete(response.id);
            this.clearDesktopRequestTimeout(response.id);
        }
        if (!correlation || !issued) {
            if (typeof response.id === "string" && this.expiredQuotaProbeIds.delete(response.id))
                return;
            if (typeof response.id === "string" && this.expiredFanoutReplyIds.delete(response.id))
                return;
            if (typeof response.id === "string" && this.expiredDesktopRequestIds.delete(response.id))
                return;
            this.protocolDrift();
            return;
        }
        if (issued.quotaProbe) {
            this.clearQuotaProbeTimeout(issued.internalId);
            this.recordQuotaProbe(childId, issued.quotaProbe, response);
            return;
        }
        if (issued.pendingOwnerKey && response.error) {
            this.resolveTerminalNewThreadError(issued);
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
            return;
        }
        const threadId = (0, protocol_1.threadIdFrom)(response.result);
        if (issued.pendingOwnerKey && !threadId) {
            this.resolveTerminalNewThreadError(issued);
            this.postStartFailure("post_start_failure");
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
            return;
        }
        if (issued.method === "thread/fork" && (!threadId || !issued.sourceThreadId)) {
            this.postStartFailure("post_start_failure");
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
            return;
        }
        if (issued.method === "review/start" && !this.validateReviewDelivery(issued, response.result)) {
            this.postStartFailure("post_start_failure");
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
            return;
        }
        let bufferedStarted = null;
        if (issued.pendingOwnerKey && threadId) {
            try {
                const existingOwner = this.ledger.ownerFor(threadId);
                if (existingOwner === null)
                    this.ledger.bindThread(threadId, childId, issued.pendingOwnerKey);
                else if (existingOwner !== childId)
                    throw new Error("thread owner collision");
                if (issued.reservationId)
                    this.pendingReservationsByThread.set(threadId, issued.reservationId);
                bufferedStarted = this.takeBufferedStartedThread(threadId, childId);
            }
            catch {
                this.postStartFailure("post_start_failure");
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
                return;
            }
        }
        if (issued.method === "review/start") {
            const reviewThreadId = reviewThreadIdFrom(response.result);
            if (reviewThreadId && reviewThreadId !== issued.sourceThreadId) {
                try {
                    this.ledger.bindKnownThread(reviewThreadId, childId);
                    bufferedStarted = this.takeBufferedStartedThread(reviewThreadId, childId) ?? bufferedStarted;
                }
                catch {
                    this.postStartFailure("post_start_failure");
                    this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
                    return;
                }
            }
        }
        if (["thread/fork", "thread/resume", "thread/unarchive"].includes(issued.method) && threadId) {
            try {
                this.ledger.bindKnownThread(threadId, childId);
            }
            catch {
                this.postStartFailure("post_start_failure");
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(issued.desktopId, "post_start_failure"));
                return;
            }
        }
        if (issued.fanoutKey) {
            this.recordFanoutResponse(issued, response);
            return;
        }
        const desktopResponse = this.rewriteChildSections({ ...response, id: issued.desktopId }, childId);
        if (!desktopResponse) {
            this.protocolDrift();
            return;
        }
        this.options.writeDesktop(desktopResponse);
        if (bufferedStarted) {
            const desktopNotification = this.rewriteChildSections(bufferedStarted, childId);
            if (!desktopNotification) {
                this.protocolDrift();
                return;
            }
            this.options.writeDesktop(desktopNotification);
        }
    }
    resolveTerminalNewThreadError(issued) {
        if (!issued.pendingOwnerKey || !issued.reservationId)
            return;
        const state = this.options.store.snapshot();
        // If a thread/started notification already bound this reservation, delivery
        // is no longer a no-thread error and ownership must remain durable.
        if ([...this.pendingReservationsByThread.values()].includes(issued.reservationId))
            return;
        if (state.pendingThreadOwners[issued.pendingOwnerKey] === issued.child.opaqueAccountId) {
            this.ledger.releasePreDispatch(issued.reservationId);
            this.ledger.clearPendingOwner(issued.pendingOwnerKey, issued.child.opaqueAccountId);
        }
    }
    bufferOrBindStartedThread(threadId, childId, notification) {
        const existing = this.ledger.ownerFor(threadId);
        if (existing)
            return existing === childId ? "bound" : "rejected";
        const anchors = causalThreadAnchors(notification);
        if (anchors === null)
            return "rejected";
        if (anchors.length > 0) {
            if (anchors.some((anchor) => this.ledger.ownerFor(anchor) !== childId))
                return "rejected";
            try {
                this.ledger.bindKnownThread(threadId, childId);
                return "bound";
            }
            catch {
                return "rejected";
            }
        }
        const canResolveFromResponse = [...this.issued.values()].some((issued) => issued.child.opaqueAccountId === childId
            && (issued.pendingOwnerKey !== undefined || issued.method === "review/start" || issued.method === "thread/fork"));
        if (!canResolveFromResponse || this.bufferedStartedThreads.has(threadId))
            return "rejected";
        const timer = setTimeout(() => {
            const pending = this.bufferedStartedThreads.get(threadId);
            if (!pending || pending.childId !== childId)
                return;
            this.bufferedStartedThreads.delete(threadId);
            this.postStartFailure("post_start_failure");
        }, FANOUT_TIMEOUT_MS);
        timer.unref();
        this.bufferedStartedThreads.set(threadId, { childId, notification, timer });
        return "buffered";
    }
    takeBufferedStartedThread(threadId, childId) {
        const pending = this.bufferedStartedThreads.get(threadId);
        if (!pending || pending.childId !== childId)
            return null;
        clearTimeout(pending.timer);
        this.bufferedStartedThreads.delete(threadId);
        return pending.notification;
    }
    /** A review may remain on its source thread or return one new detached id. */
    validateReviewDelivery(issued, result) {
        if (!issued.sourceThreadId || !(0, types_1.isPlainRecord)(result))
            return false;
        if (!Object.prototype.hasOwnProperty.call(result, "reviewThreadId"))
            return true;
        const reviewThreadId = reviewThreadIdFrom(result);
        return reviewThreadId !== null;
    }
    recordFanoutResponse(issued, response) {
        const fanout = issued.fanoutKey ? this.fanouts.get(issued.fanoutKey) : undefined;
        if (!fanout) {
            this.protocolDrift();
            return;
        }
        fanout.responses.push({ childId: issued.child.opaqueAccountId, response });
        if (response.error)
            fanout.failed = true;
        if (fanout.responses.length < fanout.expected)
            return;
        this.completeFanout(issued.fanoutKey, fanout);
    }
    completeFanout(key, fanout) {
        if (this.fanouts.get(key) !== fanout)
            return;
        this.fanouts.delete(key);
        if (fanout.timeout)
            clearTimeout(fanout.timeout);
        fanout.timeout = undefined;
        if (fanout.failed) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(fanout.desktopId, "post_start_failure"));
            return;
        }
        if (fanout.route === "fanout_initialize_intersection") {
            const initialized = this.options.config.accounts.filter((account) => account.included).map((account) => {
                const response = fanout.responses.find((item) => item.childId === account.opaqueAccountId)?.response;
                return response ? parseInitializeResult(response.result, account.opaqueAccountId) : null;
            });
            if (initialized.some((result) => result === null) || !initializeResultsCompatible(initialized)) {
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(fanout.desktopId, "capability_mismatch"));
                this.postStartFailure("post_start_failure");
                return;
            }
            for (const child of this.children.values()) {
                child.markInitialized?.();
                if (!(0, config_1.isQuotaAwareRouterConfig)(this.options.config))
                    this.ledger.setEligibility(child.opaqueAccountId, "eligible");
            }
            this.initialized = true;
            if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config))
                this.refreshAllQuota();
            // Child responses may arrive in either order. The configured primary is
            // the only isolated-home response the desktop is allowed to observe.
            const primary = fanout.responses.find((item) => item.childId === this.options.config.primaryOpaqueAccountId)?.response;
            if (!primary) {
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(fanout.desktopId, "post_start_failure"));
                this.postStartFailure("post_start_failure");
                return;
            }
            this.options.writeDesktop({ ...primary, id: fanout.desktopId });
            return;
        }
        if (fanout.route === "fanout_feature_enablement") {
            const primary = fanout.responses.find((item) => item.childId === this.options.config.primaryOpaqueAccountId)?.response;
            if (!primary) {
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(fanout.desktopId, "post_start_failure"));
                return;
            }
            this.options.writeDesktop({ ...primary, id: fanout.desktopId });
            return;
        }
        if (fanout.sections) {
            const pages = [];
            for (const item of fanout.responses) {
                const page = parseSectionPage(item.response.result);
                if (!page) {
                    this.failFanout(fanout);
                    return;
                }
                pages.push({ page, owner: item.childId });
            }
            if (!this.appendSectionPages(fanout.sections, pages)) {
                this.failFanout(fanout);
                return;
            }
            this.options.writeDesktop({ jsonrpc: "2.0", id: fanout.desktopId, result: this.sectionPageResult(fanout.sections) });
            return;
        }
        if (fanout.aggregate) {
            const pages = [];
            for (const item of fanout.responses) {
                const page = parseAggregatePage(fanout.aggregate.method, item.response.result);
                if (!page) {
                    this.failFanout(fanout);
                    return;
                }
                pages.push({ page, owner: item.childId });
            }
            const appendResult = this.appendAggregatePages(fanout.aggregate, pages);
            if (appendResult !== "ok") {
                this.failFanout(fanout, undefined, appendResult === "owner_collision");
                return;
            }
            const result = this.aggregatePageResult(fanout.aggregate);
            if (!result) {
                this.failFanout(fanout);
                return;
            }
            this.options.writeDesktop({ jsonrpc: "2.0", id: fanout.desktopId, result });
            return;
        }
        this.options.writeDesktop({ jsonrpc: "2.0", id: fanout.desktopId, result: mergeFanoutResults(fanout.responses.map(({ response: item }) => item), this.controlSecret) });
    }
    handleChildRequest(childId, request) {
        if (!(0, protocol_1.isKnownServerRequest)(request.method)) {
            this.protocolDrift();
            return;
        }
        // Child-originated interactive work is thread-affine too. A local child
        // may never ask the desktop to approve or provide input for an unknown or
        // cross-account thread. Auth refresh is account-scoped and deliberately
        // has no thread identifier.
        if (!GLOBAL_SERVER_REQUEST_METHODS.has(request.method)) {
            const threadId = serverRequestThreadId(request.params);
            if (!threadId || this.ledger.ownerFor(threadId) !== childId) {
                try {
                    this.children.get(childId)?.send((0, redaction_1.redactedRouterError)(request.id, "unknown_thread_owner"));
                }
                catch { /* shutting down */ }
                this.protocolDrift();
                return;
            }
        }
        if (request.method === "account/chatgptAuthTokens/refresh") {
            if (this.refreshInFlight.has(childId)) {
                this.ledger.setEligibility(childId, "reauth_required");
                this.children.get(childId)?.send((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
                return;
            }
        }
        const childKey = serverRequestChildKey(childId, request.id);
        if (this.serverRequestsByChild.has(childKey) || this.serverRequestTombstonesByChild.has(childKey)) {
            this.children.get(childId)?.send((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        let correlation;
        try {
            // Child-local request ids are not globally unique: scope their durable
            // correlation by emitting child before constructing the desktop id.
            correlation = this.correlations.create("child_to_client", childId, request.id, request.method, `server:${childId}`);
        }
        catch {
            this.ledger.setEligibility(childId, "reauth_required");
            this.children.get(childId)?.send((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        if (this.serverRequestsByChild.size >= MAX_ACTIVE_SERVER_REQUESTS) {
            this.correlations.consume(correlation.internalId, "child_to_client", childId);
            this.children.get(childId)?.send((0, redaction_1.redactedRouterError)(request.id, "invalid_correlation"));
            return;
        }
        const timeout = this.serverRequestTimeout(request);
        const lifecycle = {
            childId,
            childRequestId: request.id,
            desktopRequestId: correlation.internalId,
            correlationId: correlation.internalId,
            method: request.method,
            responseForwarded: false,
            timer: this.setTimer(() => this.expireServerRequest(childKey, correlation.internalId), timeout),
        };
        this.serverRequestsByChild.set(childKey, lifecycle);
        this.serverRequestsByDesktop.set(correlation.internalId, lifecycle);
        if (request.method === "account/chatgptAuthTokens/refresh")
            this.refreshInFlight.set(childId, correlation.internalId);
        this.options.writeDesktop({ ...request, id: correlation.internalId });
    }
    routeDesktopResponse(response) {
        const correlation = this.correlations.get(response.id);
        if (!correlation || correlation.direction !== "child_to_client") {
            if (typeof response.id === "string" && this.serverRequestTombstonesByDesktop.has(response.id))
                return;
            this.protocolDrift();
            return;
        }
        const child = this.children.get(correlation.childOpaqueAccountId);
        if (!child) {
            this.postStartFailure("post_start_failure");
            return;
        }
        if (typeof response.id !== "string") {
            this.protocolDrift();
            return;
        }
        const lifecycle = this.serverRequestsByDesktop.get(response.id);
        if (!lifecycle || lifecycle.childId !== child.opaqueAccountId || lifecycle.responseForwarded) {
            this.protocolDrift();
            return;
        }
        if (lifecycle.method === "account/chatgptAuthTokens/refresh" && !refreshResponseMatches(response.result, child.opaqueAccountId, this.controlSecret)) {
            lifecycle.responseForwarded = true;
            this.correlations.mark(lifecycle.correlationId, "acknowledged");
            try {
                this.ledger.setEligibility(child.opaqueAccountId, "reauth_required");
                child.send((0, redaction_1.redactedRouterError)(lifecycle.childRequestId, "invalid_correlation"));
            }
            catch {
                this.postStartFailure("post_start_failure");
            }
            return;
        }
        lifecycle.responseForwarded = true;
        this.correlations.mark(lifecycle.correlationId, "acknowledged");
        try {
            child.send({ ...response, id: lifecycle.childRequestId });
        }
        catch {
            this.postStartFailure("post_start_failure");
        }
    }
    /**
     * The child resolves with its local request id after the desktop has only
     * ever seen the mux id. Preserve the mapping until this terminal notice,
     * rewrite only that id, then retain a bounded tombstone for late replies.
     */
    resolveServerRequestNotification(childId, notification) {
        if (!(0, protocol_1.isNotification)(notification) || !(0, types_1.isPlainRecord)(notification.params) || !(0, types_1.isJsonRpcId)(notification.params.requestId))
            return false;
        const childRequestId = notification.params.requestId;
        const childKey = serverRequestChildKey(childId, childRequestId);
        const lifecycle = this.serverRequestsByChild.get(childKey);
        const tombstone = lifecycle ? null : this.serverRequestTombstonesByChild.get(childKey) ?? null;
        if (!lifecycle && !tombstone)
            return false;
        if (tombstone?.resolved)
            return true;
        const desktopRequestId = lifecycle?.desktopRequestId ?? tombstone.desktopRequestId;
        if (lifecycle) {
            this.clearTimer(lifecycle.timer);
            this.serverRequestsByChild.delete(childKey);
            this.serverRequestsByDesktop.delete(lifecycle.desktopRequestId);
            this.correlations.consume(lifecycle.correlationId, "child_to_client", childId);
            if (lifecycle.method === "account/chatgptAuthTokens/refresh" && this.refreshInFlight.get(childId) === lifecycle.desktopRequestId) {
                this.refreshInFlight.delete(childId);
            }
        }
        const nextTombstone = {
            childId, childRequestId, desktopRequestId, method: lifecycle?.method ?? tombstone.method, resolved: true,
        };
        this.rememberServerRequestTombstone(nextTombstone);
        this.options.writeDesktop({ ...notification, params: { ...notification.params, requestId: desktopRequestId } });
        return true;
    }
    expireServerRequest(childKey, desktopRequestId) {
        const lifecycle = this.serverRequestsByChild.get(childKey);
        if (!lifecycle || lifecycle.desktopRequestId !== desktopRequestId)
            return;
        this.serverRequestsByChild.delete(childKey);
        this.serverRequestsByDesktop.delete(desktopRequestId);
        this.correlations.consume(lifecycle.correlationId, "child_to_client", lifecycle.childId);
        if (lifecycle.method === "account/chatgptAuthTokens/refresh" && this.refreshInFlight.get(lifecycle.childId) === desktopRequestId) {
            this.refreshInFlight.delete(lifecycle.childId);
        }
        this.rememberServerRequestTombstone({
            childId: lifecycle.childId,
            childRequestId: lifecycle.childRequestId,
            desktopRequestId,
            method: lifecycle.method,
            resolved: false,
        });
        try {
            this.children.get(lifecycle.childId)?.send((0, redaction_1.redactedRouterError)(lifecycle.childRequestId, "post_start_failure"));
        }
        catch {
            this.postStartFailure("post_start_failure");
        }
    }
    rememberServerRequestTombstone(tombstone) {
        const childKey = serverRequestChildKey(tombstone.childId, tombstone.childRequestId);
        this.serverRequestTombstonesByChild.set(childKey, tombstone);
        this.serverRequestTombstonesByDesktop.set(tombstone.desktopRequestId, tombstone);
        while (this.serverRequestTombstonesByChild.size > 64) {
            const [expiredKey, expired] = this.serverRequestTombstonesByChild.entries().next().value;
            this.serverRequestTombstonesByChild.delete(expiredKey);
            this.serverRequestTombstonesByDesktop.delete(expired.desktopRequestId);
        }
    }
    serverRequestTimeout(request) {
        if (request.method === "account/chatgptAuthTokens/refresh") {
            const configured = this.options.serverRequestTimeoutMs ?? 0;
            return Math.min(Math.max(NETWORK_SERVER_REQUEST_MIN_MS, configured), NETWORK_SERVER_REQUEST_MAX_MS);
        }
        if (INTERACTIVE_SERVER_REQUEST_METHODS.has(request.method)) {
            const requestedAutoResolution = autoResolutionMs(request.params);
            const configured = this.options.serverRequestTimeoutMs ?? 0;
            const candidate = Math.max(INTERACTIVE_SERVER_REQUEST_MIN_MS, configured, requestedAutoResolution === null ? 0 : requestedAutoResolution + INTERACTIVE_SERVER_REQUEST_SAFETY_MARGIN_MS);
            return Math.min(candidate, INTERACTIVE_SERVER_REQUEST_MAX_MS);
        }
        const timeout = this.options.serverRequestTimeoutMs ?? FANOUT_TIMEOUT_MS;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
            throw new Error("invalid account-router immediate server-request timeout");
        return timeout;
    }
    handleChildNotification(childId, notification) {
        if (!(0, protocol_1.isNotification)(notification))
            return;
        if (notification.method === "serverRequest/resolved") {
            if (!this.resolveServerRequestNotification(childId, notification))
                this.protocolDrift();
            return;
        }
        const route = (0, protocol_1.classifyServerNotification)(notification.method, notification.params);
        if (route === "unknown") {
            this.protocolDrift();
            return;
        }
        if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config) && notification.method === "account/rateLimits/updated")
            this.refreshQuotaFor(childId);
        const threadId = (0, protocol_1.threadIdFrom)(notification.params);
        if (route === "verify_persisted_owner_then_forward") {
            const knownOwner = threadId ? this.ledger.ownerFor(threadId) : null;
            const observedStart = notification.method === "thread/started" && threadId && knownOwner === null
                ? this.bufferOrBindStartedThread(threadId, childId, notification) : null;
            if (observedStart === "buffered")
                return;
            if (!threadId || observedStart === "rejected" || (observedStart !== "bound" && this.ledger.ownerFor(threadId) !== childId)) {
                this.protocolDrift();
                return;
            }
            this.recordTokenUsage(threadId, notification);
            this.reconcileTerminal(threadId, notification, childId);
            if (notification.method === "thread/closed" || notification.method === "thread/deleted")
                this.clearTokenUsageForThread(threadId);
            const desktopNotification = this.rewriteChildSections(notification, childId);
            if (!desktopNotification) {
                this.protocolDrift();
                return;
            }
            this.options.writeDesktop(desktopNotification);
            return;
        }
        if (route === "ingest_per_home_primary_forward_only_redacted_control_projection") {
            if (childId === this.options.config.primaryOpaqueAccountId)
                this.options.writeDesktop(notification);
            return;
        }
        if (childId === this.options.config.primaryOpaqueAccountId)
            this.options.writeDesktop(notification);
    }
    recordTokenUsage(threadId, notification) {
        if (!(0, protocol_1.isNotification)(notification) || notification.method !== "thread/tokenUsage/updated" || !(0, types_1.isPlainRecord)(notification.params))
            return;
        const usage = usageFrom(notification.params.tokenUsage);
        const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : "";
        if (!usage || !turnId)
            return;
        this.tokenUsage.set(`${threadId}:${turnId}`, usage);
        while (this.tokenUsage.size > 128)
            this.tokenUsage.delete(this.tokenUsage.keys().next().value);
    }
    reconcileTerminal(threadId, notification, childId) {
        if (!(0, protocol_1.isNotification)(notification) || notification.method !== "turn/completed" || !(0, types_1.isPlainRecord)(notification.params))
            return;
        if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config))
            this.refreshQuotaFor(childId);
        const turnId = (0, types_1.isPlainRecord)(notification.params.turn) && typeof notification.params.turn.id === "string" ? notification.params.turn.id : "";
        const recordedUsage = turnId ? this.tokenUsage.get(`${threadId}:${turnId}`) ?? null : null;
        // Usage is diagnostic input for exactly one terminal turn. Delete it
        // before checking for the original reservation so ordinary follow-ups
        // cannot grow an owner-private map indefinitely.
        if (turnId)
            this.tokenUsage.delete(`${threadId}:${turnId}`);
        const reservationId = this.pendingReservationsByThread.get(threadId);
        if (!reservationId)
            return;
        const usage = recordedUsage ?? ((0, types_1.isPlainRecord)(notification.params.turn) ? usageFrom(notification.params.turn.tokenUsage) : null);
        this.ledger.reconcile(reservationId, usage, modelFrom(notification.params));
        this.pendingReservationsByThread.delete(threadId);
        if (!usage)
            this.precisionEstimated = true;
    }
    clearTokenUsageForThread(threadId) {
        const prefix = `${threadId}:`;
        for (const key of this.tokenUsage.keys())
            if (key.startsWith(prefix))
                this.tokenUsage.delete(key);
    }
    /** Issue one bounded pair of official app-server reads per enrolled child. */
    refreshAllQuota() {
        if (!(0, config_1.isQuotaAwareRouterConfig)(this.options.config))
            return;
        for (const account of this.options.config.accounts)
            this.refreshQuotaFor(account.opaqueAccountId);
    }
    refreshQuotaFor(account) {
        if (!(0, config_1.isQuotaAwareRouterConfig)(this.options.config) || !this.initialized || !this.accepting)
            return;
        const child = this.children.get(account);
        if (!child) {
            this.ledger.setEligibility(account, "unhealthy");
            return;
        }
        const inFlight = this.quotaProbesInFlight.get(account) ?? new Set();
        this.quotaProbesInFlight.set(account, inFlight);
        this.ledger.setEligibility(account, "validating");
        this.issueQuotaProbe(child, "account", inFlight);
        this.issueQuotaProbe(child, "rate_limits", inFlight);
    }
    issueQuotaProbe(child, kind, inFlight) {
        if (inFlight.has(kind))
            return;
        // Set this before child.send. A test double and a future in-process child
        // may synchronously answer while dispatchToChild is still on its stack.
        inFlight.add(kind);
        const request = {
            jsonrpc: "2.0",
            id: `quota:${child.opaqueAccountId}:${++this.quotaProbeNonce}`,
            method: kind === "account" ? "account/read" : "account/rateLimits/read",
            params: {},
        };
        try {
            const issued = this.dispatchToChild(request, child, { quotaProbe: kind, scope: `quota-${kind}` });
            if (issued) {
                if (this.issued.has(issued.internalId))
                    this.startQuotaProbeTimeout(issued);
                return;
            }
        }
        catch {
            // The provider error stays private. The resulting missing reading makes
            // the fixed pool ineligible; no alternate account is tried.
        }
        this.recordQuotaProbeFailure(child.opaqueAccountId, kind);
    }
    recordQuotaProbe(childId, kind, response) {
        const observation = this.quota.get(childId) ?? (0, quota_1.emptyQuotaObservation)();
        const now = this.now();
        if (kind === "account") {
            const parsed = response.error ? null : (0, quota_1.parseAccountRead)(response.result, now);
            if (parsed) {
                observation.health = parsed.health;
                observation.plan = parsed.plan;
                observation.observedAt = parsed.observedAt;
            }
            else {
                observation.health = "reauth_required";
                observation.plan = null;
                observation.observedAt = null;
            }
        }
        else {
            const parsed = response.error ? null : (0, quota_1.parseRateLimitsRead)(response.result, now);
            if (parsed) {
                observation.weeklyRemainingPercent = parsed.weeklyRemainingPercent;
                observation.weeklyResetAt = parsed.weeklyResetAt;
                observation.shortWindowPressure = parsed.shortWindowPressure;
                observation.shortWindowResetAt = parsed.shortWindowResetAt ?? null;
                observation.rateLimitReached = parsed.rateLimitReached ?? false;
                observation.resetCredits = parsed.resetCredits ?? null;
                observation.observedAt = observation.observedAt === null ? null : Math.min(observation.observedAt, parsed.observedAt ?? now);
            }
            else {
                observation.weeklyRemainingPercent = null;
                observation.weeklyResetAt = null;
                observation.shortWindowPressure = null;
                observation.shortWindowResetAt = null;
                observation.rateLimitReached = false;
                observation.resetCredits = null;
            }
        }
        this.quota.set(childId, observation);
        const inFlight = this.quotaProbesInFlight.get(childId);
        inFlight?.delete(kind);
        if (inFlight?.size === 0)
            this.quotaProbesInFlight.delete(childId);
        this.updateQuotaEligibility(childId);
        this.drainQueuedNewThread();
    }
    recordQuotaProbeFailure(childId, kind) {
        const observation = this.quota.get(childId) ?? (0, quota_1.emptyQuotaObservation)();
        if (kind === "account") {
            observation.health = "unhealthy";
            observation.plan = null;
            observation.observedAt = null;
        }
        else {
            observation.weeklyRemainingPercent = null;
            observation.weeklyResetAt = null;
            observation.shortWindowPressure = null;
            observation.shortWindowResetAt = null;
            observation.rateLimitReached = false;
            observation.resetCredits = null;
        }
        this.quota.set(childId, observation);
        const inFlight = this.quotaProbesInFlight.get(childId);
        inFlight?.delete(kind);
        if (inFlight?.size === 0)
            this.quotaProbesInFlight.delete(childId);
        this.updateQuotaEligibility(childId);
        this.drainQueuedNewThread();
    }
    startQuotaProbeTimeout(issued) {
        const timeout = this.options.quotaProbeTimeoutMs ?? QUOTA_PROBE_TIMEOUT_MS;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
            throw new Error("invalid account-router quota probe timeout");
        const timer = setTimeout(() => {
            this.quotaProbeTimers.delete(issued.internalId);
            const live = this.issued.get(issued.internalId);
            if (!live || !live.quotaProbe)
                return;
            this.issued.delete(issued.internalId);
            this.correlations.consume(issued.internalId, "client_to_child", live.child.opaqueAccountId);
            this.rememberExpiredQuotaProbe(issued.internalId);
            this.recordQuotaProbeFailure(live.child.opaqueAccountId, live.quotaProbe);
        }, timeout);
        timer.unref();
        this.quotaProbeTimers.set(issued.internalId, timer);
    }
    clearQuotaProbeTimeout(internalId) {
        const timer = this.quotaProbeTimers.get(internalId);
        if (timer)
            clearTimeout(timer);
        this.quotaProbeTimers.delete(internalId);
    }
    /**
     * A written desktop request may be a long history read, tool call, or
     * provider-backed operation. The mux has no authoritative per-method time
     * budget, so its bounded direct-correlation pool—not a fabricated deadline—
     * is the liveness guard. Terminal reply, child failure, or shutdown cleans it.
     */
    startDesktopRequestTimeout(_issued) { }
    clearDesktopRequestTimeout(internalId) {
        const timer = this.desktopRequestTimers.get(internalId);
        if (timer)
            this.clearTimer(timer);
        this.desktopRequestTimers.delete(internalId);
    }
    rememberExpiredDesktopRequest(internalId) {
        this.expiredDesktopRequestIds.add(internalId);
        while (this.expiredDesktopRequestIds.size > 64)
            this.expiredDesktopRequestIds.delete(this.expiredDesktopRequestIds.values().next().value);
    }
    rememberExpiredQuotaProbe(internalId) {
        this.expiredQuotaProbeIds.add(internalId);
        while (this.expiredQuotaProbeIds.size > 64)
            this.expiredQuotaProbeIds.delete(this.expiredQuotaProbeIds.values().next().value);
    }
    updateQuotaEligibility(account) {
        const observation = this.quota.get(account) ?? (0, quota_1.emptyQuotaObservation)();
        if ((this.quotaProbesInFlight.get(account)?.size ?? 0) > 0) {
            this.ledger.setEligibility(account, "validating");
            return;
        }
        if (observation.health === "reauth_required") {
            this.ledger.setEligibility(account, "reauth_required");
            return;
        }
        if (observation.health === "disabled") {
            this.ledger.setEligibility(account, "disabled");
            return;
        }
        if (observation.health !== "authenticated" || (0, quota_1.quotaFreshness)(observation, this.now()) !== "fresh") {
            // Manual's primary-only routing needs account health, not a quota
            // score. A missing/old rate-limit reply therefore remains honestly
            // nullable in status without silently selecting the secondary account.
            if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config) && this.options.config.mode === "manual" && observation.health === "authenticated") {
                this.ledger.setEligibility(account, "eligible");
            }
            else {
                this.ledger.setEligibility(account, "unhealthy");
            }
            return;
        }
        if ((0, config_1.isQuotaAwareRouterConfig)(this.options.config) && this.options.config.mode === "manual") {
            this.ledger.setEligibility(account, "eligible");
            return;
        }
        if (!(0, quota_1.accountObservationEligible)(observation, this.now())) {
            this.ledger.setEligibility(account, "quota_depleted");
            return;
        }
        this.ledger.setEligibility(account, "eligible");
    }
    /** Queue only one never-yet-delivered start while stale capacity is refreshed. */
    queueNewThreadForQuotaRefresh(request) {
        if (this.queuedNewThread) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(request.id, "pool_depleted"));
            return;
        }
        this.queuedNewThread = { request };
        const probeTimeout = this.options.quotaProbeTimeoutMs ?? QUOTA_PROBE_TIMEOUT_MS;
        const timeout = this.options.queuedStartTimeoutMs ?? Math.min(30_000, probeTimeout + 100);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
            throw new Error("invalid account-router queued start timeout");
        this.queuedNewThreadTimer = setTimeout(() => {
            const queued = this.queuedNewThread;
            this.clearQueuedNewThread();
            if (queued && this.accepting)
                this.options.writeDesktop((0, redaction_1.redactedRouterError)(queued.request.id, "pool_depleted"));
        }, timeout);
        this.queuedNewThreadTimer.unref();
        this.refreshAllQuota();
    }
    drainQueuedNewThread() {
        if (!this.queuedNewThread || this.quotaProbesInFlight.size > 0)
            return;
        const queued = this.queuedNewThread;
        this.clearQueuedNewThread();
        if (!this.accepting)
            return;
        const selected = this.ledger.selectQuotaAware(this.quota);
        if (!selected) {
            this.options.writeDesktop((0, redaction_1.redactedRouterError)(queued.request.id, "pool_depleted"));
            return;
        }
        this.dispatchSelectedNewThread(queued.request, selected.opaqueAccountId);
    }
    clearQueuedNewThread() {
        if (this.queuedNewThreadTimer)
            clearTimeout(this.queuedNewThreadTimer);
        this.queuedNewThreadTimer = null;
        this.queuedNewThread = null;
    }
    quotaNeedsRefresh() {
        if (!(0, config_1.isQuotaAwareRouterConfig)(this.options.config))
            return false;
        return this.options.config.accounts.some((account) => account.included && (0, quota_1.quotaFreshness)(this.quota.get(account.opaqueAccountId) ?? (0, quota_1.emptyQuotaObservation)(), this.now()) !== "fresh");
    }
    quotaAwareStatus() {
        const config = this.options.config;
        if (!(0, config_1.isQuotaAwareRouterConfig)(config))
            throw new Error("quota status requires a quota-aware router config");
        const now = this.now();
        if (this.initialized && this.accepting) {
            for (const account of config.accounts) {
                if (!account.included)
                    continue;
                const observation = this.quota.get(account.opaqueAccountId) ?? (0, quota_1.emptyQuotaObservation)();
                if ((0, quota_1.quotaFreshness)(observation, now) !== "fresh")
                    this.refreshQuotaFor(account.opaqueAccountId);
            }
        }
        const state = this.options.store.snapshot();
        const accounts = config.accounts.map((account) => this.quotaStatusAccount(account, state, now));
        const pending = this.pendingQuotaIntent(config);
        const enabledAccounts = accounts.filter((account) => account.eligibility !== "disabled");
        const allFresh = enabledAccounts.length > 0
            && enabledAccounts.every((account) => account.weekly.freshness === "fresh" && account.weekly.remainingPercent !== null);
        const protocolState = state.stagedDisable?.reasonCode === "protocol_drift" ? "drifted" : "supported";
        const common = {
            active: quotaIntent(config),
            pending,
            protocolState,
            poolRemainingPercent: allFresh
                ? enabledAccounts.reduce((total, account) => total + account.weekly.remainingPercent, 0)
                : null,
            restartRequired: state.stagedDisable !== null || pending !== null,
            degradedReason: quotaDegradedReason(state.stagedDisable?.reasonCode, accounts),
        };
        if (config.schemaVersion === 2) {
            return { ...common, schemaVersion: 2, accounts: [accounts[0], accounts[1]] };
        }
        return { ...common, schemaVersion: 3, accounts };
    }
    quotaStatusAccount(account, state, now) {
        const observation = this.quota.get(account.opaqueAccountId) ?? (0, quota_1.emptyQuotaObservation)();
        const freshness = (0, quota_1.quotaFreshness)(observation, now);
        return {
            opaqueAccountId: account.opaqueAccountId,
            label: account.label,
            eligibility: state.accountEligibility[account.opaqueAccountId] ?? "unhealthy",
            plan: observation.plan,
            identifierMasked: "••••••••",
            weekly: {
                remainingPercent: observation.weeklyRemainingPercent,
                resetAt: observation.weeklyResetAt === null ? null : new Date(observation.weeklyResetAt).toISOString(),
                freshness,
            },
            shortWindowPressure: observation.shortWindowPressure,
            assignedThreadCount: state.ledger[account.opaqueAccountId]?.assignedThreadCount ?? 0,
            resetCredits: observation.resetCredits,
        };
    }
    pendingQuotaIntent(active) {
        try {
            const candidate = this.options.readPendingConfig?.() ?? null;
            if (!candidate || !(0, config_1.isQuotaAwareRouterConfig)(candidate) || candidate.schemaVersion !== active.schemaVersion)
                return null;
            if (candidate.fingerprint === active.fingerprint && candidate.generation === active.generation
                && candidate.mode === active.mode && candidate.policy === active.policy)
                return null;
            return quotaIntent(candidate);
        }
        catch {
            // A bad later disk config is not allowed to replace the active mux truth.
            return null;
        }
    }
    now() {
        return this.options.now?.() ?? Date.now();
    }
    setTimer(callback, delay) {
        const timer = (this.options.setTimeout ?? setTimeout)(callback, delay);
        timer.unref?.();
        return timer;
    }
    clearTimer(timer) {
        (this.options.clearTimeout ?? clearTimeout)(timer);
    }
    /** Long-lived direct work is bounded by correlation capacity, not time. */
    activeDirectRequestCount() {
        let count = 0;
        for (const issued of this.issued.values()) {
            if (!issued.quotaProbe && !issued.fanoutKey)
                count += 1;
        }
        return count;
    }
    /**
     * There is no live atomic effective-capability oracle across two private
     * homes. A capability-changing write is therefore never dispatched under
     * balanced routing: make the restart requirement durable and stop safely.
     */
    stageCapabilityRestartRequired() {
        this.options.store.update((state) => {
            state.stagedDisable = { reasonCode: "policy_stop", stagedAt: new Date().toISOString() };
            for (const account of this.options.config.accounts)
                state.accountEligibility[account.opaqueAccountId] = "protocol_blocked";
        });
        this.accepting = false;
        this.shutdown();
        this.signalFatal();
    }
    protocolDrift() {
        this.options.store.update((state) => {
            state.stagedDisable = { reasonCode: "protocol_drift", stagedAt: new Date().toISOString() };
            for (const account of this.options.config.accounts)
                state.accountEligibility[account.opaqueAccountId] = "protocol_blocked";
        });
        this.accepting = false;
        this.shutdown();
        this.signalFatal();
    }
    postStartFailure(reason) {
        this.options.store.update((state) => {
            state.stagedDisable = { reasonCode: reason === "isolation_failure" ? "isolation_failure" : "post_start_failure", stagedAt: new Date().toISOString() };
            for (const account of this.options.config.accounts)
                state.accountEligibility[account.opaqueAccountId] = "unhealthy";
        });
        this.accepting = false;
        this.shutdown();
        this.signalFatal();
    }
    signalFatal() {
        if (this.fatalSignalled)
            return;
        this.fatalSignalled = true;
        this.options.onFatal?.();
    }
}
exports.AccountRouterMux = AccountRouterMux;
function quotaIntent(config) {
    return {
        mode: config.mode,
        policy: config.policy,
        generation: config.generation,
        fingerprint: config.fingerprint,
    };
}
function parseInitializeResult(value, account) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    const userAgent = value.userAgent;
    const codexHome = value.codexHome;
    const platformFamily = value.platformFamily;
    const platformOs = value.platformOs;
    if (typeof userAgent !== "string" || userAgent.length === 0 || userAgent.length > 1_024
        || typeof codexHome !== "string" || codexHome.length === 0 || codexHome.length > 1_024
        || typeof platformFamily !== "string" || platformFamily.length === 0 || platformFamily.length > 1_024
        || typeof platformOs !== "string" || platformOs.length === 0 || platformOs.length > 1_024)
        return null;
    // Each child must report the isolated home staged for exactly its opaque
    // account. This is checked privately and never added to control status.
    if (!codexHome.endsWith(`/accounts/${account}/codex-home`) || /[\u0000-\u001f\u007f]/.test(codexHome))
        return null;
    return { userAgent, codexHome, platformFamily, platformOs };
}
function initializeResultsCompatible(results) {
    if (results.length < 1)
        return false;
    const first = results[0];
    return results.every((result) => result.userAgent === first.userAgent
        && result.platformFamily === first.platformFamily
        && result.platformOs === first.platformOs)
        && new Set(results.map((result) => result.codexHome)).size === results.length;
}
function quotaDegradedReason(stagedReason, accounts) {
    if (stagedReason === "protocol_drift")
        return "unsupported_protocol";
    if (stagedReason === "isolation_failure")
        return "capability_mismatch";
    if (stagedReason === "policy_stop")
        return "policy_stop";
    if (stagedReason === "post_start_failure")
        return "post_start_failure";
    if (accounts.some((account) => account.eligibility === "reauth_required"))
        return "account_unauthenticated";
    if (accounts.some((account) => account.eligibility === "disabled"))
        return "account_disabled";
    if (accounts.some((account) => account.weekly.freshness === "stale"))
        return "quota_stale";
    if (accounts.some((account) => account.weekly.freshness === "unknown"))
        return "quota_unknown";
    if (accounts.some((account) => account.eligibility === "quota_depleted"))
        return "quota_depleted";
    if (accounts.some((account) => account.eligibility === "unhealthy" || account.eligibility === "protocol_blocked"))
        return "account_unhealthy";
    return null;
}
function fanoutKey(id) {
    return `${typeof id}:${String(id)}`;
}
function mergeFanoutResults(responses, secret) {
    const values = responses.map((response) => response.result);
    if (values.every(Array.isArray))
        return values.flat();
    const items = values.flatMap((value) => (0, types_1.isPlainRecord)(value) && Array.isArray(value.items) ? value.items : []);
    if (items.length > 0) {
        return { items, nextCursor: signedCursor({ count: items.length }, secret) };
    }
    return { results: values, nextCursor: signedCursor({ count: values.length }, secret) };
}
const MAX_ROUTER_CURSOR_BYTES = 8 * 1024;
const MAX_CHILD_CURSOR_LENGTH = 1_024;
const AGGREGATE_SESSION_TTL_MS = 2 * 60_000;
const MAX_AGGREGATE_SESSIONS = 16;
const MAX_AGGREGATE_PAGE_ROWS = 100;
const MAX_AGGREGATE_SESSION_ROWS = 512;
const MAX_AGGREGATE_SESSION_BYTES = 256 * 1024;
const DEFAULT_AGGREGATE_LIMIT = 20;
/** List and loaded/list have documented, but different, data envelopes. */
function parseAggregatePage(method, value) {
    if (!(0, types_1.isPlainRecord)(value) || !Array.isArray(value.data))
        return null;
    const nextCursor = safeChildCursor(value.nextCursor);
    const backwardsCursor = safeChildCursor(value.backwardsCursor);
    if (nextCursor === undefined || backwardsCursor === undefined || !aggregateEntriesValid(method, value.data))
        return null;
    return { data: value.data, nextCursor, backwardsCursor };
}
function parseSectionPage(value) {
    if (!(0, types_1.isPlainRecord)(value) || !Array.isArray(value.data))
        return null;
    const nextCursor = safeChildCursor(value.nextCursor);
    if (nextCursor === undefined)
        return null;
    const data = [];
    for (const entry of value.data) {
        if (!(0, types_1.isPlainRecord)(entry) || !safeThreadId(entry.id))
            return null;
        data.push(entry);
    }
    return { data, nextCursor };
}
function sectionFilterBinding(limit) {
    return `sha256:${(0, node_crypto_1.createHash)("sha256").update(stableJson({ limit: limit ?? null }), "utf8").digest("hex")}`;
}
function sectionBindingKey(childId, localId) {
    return `${childId}\u0000${localId}`;
}
function validSectionRouterId(id, secret) {
    const match = /^ars1\.([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{32,})$/.exec(id);
    if (!match)
        return false;
    const expected = (0, node_crypto_1.createHmac)("sha256", secret).update(`section:v1:${match[1]}`, "utf8").digest("base64url");
    const actual = match[2];
    return expected.length === actual.length && (0, node_crypto_1.timingSafeEqual)(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}
function sectionRouterError(id, code) {
    return {
        jsonrpc: "2.0", id,
        error: { code: -32080, message: "Account router request could not be completed", data: { code } },
    };
}
function safeChildCursor(value) {
    if (value === undefined || value === null)
        return null;
    return typeof value === "string" && value.length <= MAX_CHILD_CURSOR_LENGTH ? value : undefined;
}
function aggregateEntriesValid(method, entries) {
    return entries.every((entry) => aggregateThreadId(method, entry) !== null);
}
function aggregateEntriesBytes(entries) {
    return entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
}
function aggregateThreadId(method, value) {
    // `thread/loaded/list` is an id list, not a Thread object list. Treating
    // strings as unstructured entries previously exposed unbound thread ids.
    if (method === "thread/loaded/list")
        return safeThreadId(value);
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    if (method === "thread/search") {
        return (0, types_1.isPlainRecord)(value.thread) ? safeThreadId(value.thread.id) : null;
    }
    const direct = safeThreadId(value.id);
    if (direct)
        return direct;
    const nested = (0, protocol_1.threadIdFrom)(value);
    return safeThreadId(nested);
}
function safeThreadId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}
function serverRequestThreadId(params) {
    if (!(0, types_1.isPlainRecord)(params))
        return null;
    return safeThreadId(params.threadId) ?? safeThreadId(params.conversationId)
        ?? ((0, types_1.isPlainRecord)(params.thread) ? safeThreadId(params.thread.id) : null);
}
/** Interactive requests may declare a desktop-side automatic resolution. */
function autoResolutionMs(params) {
    const candidate = (0, types_1.isPlainRecord)(params) ? params.autoResolutionMs : undefined;
    if (typeof candidate !== "number" || !Number.isInteger(candidate))
        return null;
    return candidate >= 0 && candidate <= INTERACTIVE_SERVER_REQUEST_MAX_MS
        ? candidate
        : null;
}
function reviewThreadIdFrom(value) {
    return (0, types_1.isPlainRecord)(value) ? safeThreadId(value.reviewThreadId) : null;
}
function causalThreadAnchors(notification) {
    if (!(0, protocol_1.isNotification)(notification) || !(0, types_1.isPlainRecord)(notification.params))
        return null;
    const candidates = [notification.params.parentThreadId, notification.params.forkedFromId];
    const thread = notification.params.thread;
    if ((0, types_1.isPlainRecord)(thread))
        candidates.push(thread.parentThreadId, thread.forkedFromId);
    const session = notification.params.session;
    if ((0, types_1.isPlainRecord)(session))
        candidates.push(session.parentThreadId, session.threadId);
    const anchors = [];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null)
            continue;
        const id = safeThreadId(candidate);
        if (!id)
            return null;
        anchors.push(id);
    }
    return [...new Set(anchors)];
}
function hasNonEmptyPath(params) {
    return (0, types_1.isPlainRecord)(params) && typeof params.path === "string" && params.path.length > 0;
}
function hasSectionPositionSort(params) {
    return (0, types_1.isPlainRecord)(params) && params.sortKey === "section_position";
}
function serverRequestChildKey(childId, requestId) {
    return `${childId}\u0000${typeof requestId}\u0000${String(requestId)}`;
}
function rewriteAggregateCursor(request, cursor, aggregate) {
    const params = (0, types_1.isPlainRecord)(request.params) ? { ...request.params } : {};
    if (aggregate.childLimit === null) {
        // The documented loaded-list null/omitted limit means no client limit. We
        // retain that shape, while the mux independently caps collected rows.
        if (params.limit === undefined)
            delete params.limit;
        else
            params.limit = null;
        delete params.sortKey;
        delete params.sortDirection;
    }
    else {
        params.limit = aggregate.childLimit;
        params.sortKey = aggregate.sortKey;
        params.sortDirection = aggregate.sortDirection;
    }
    if (cursor === null)
        delete params.cursor;
    else
        params.cursor = cursor;
    return { ...request, params };
}
function aggregateFilterBinding(method, params, options = aggregatePageOptions(method, params)) {
    if (!options)
        return "invalid";
    const filtered = { ...params };
    if (options.childLimit === null) {
        delete filtered.limit;
        delete filtered.sortKey;
        delete filtered.sortDirection;
    }
    else {
        filtered.limit = options.childLimit;
        filtered.sortKey = options.sortKey;
        filtered.sortDirection = options.sortDirection;
    }
    delete filtered.cursor;
    return `sha256:${(0, node_crypto_1.createHash)("sha256").update(stableJson(filtered), "utf8").digest("hex")}`;
}
/**
 * A backwards cursor is valid only for the same filters with a literal asc/desc
 * inversion. All other fields (and forward cursors) remain exact-bound.
 */
function cursorMatchesAggregateRequest(payload, filterBinding, method, params) {
    if (payload.direction === "next")
        return payload.filterBinding === filterBinding;
    if (!isSortDirection(params.sortDirection))
        return false;
    const reverse = { ...params, sortDirection: params.sortDirection === "asc" ? "desc" : "asc" };
    return payload.filterBinding === aggregateFilterBinding(method, reverse);
}
function isSortDirection(value) {
    return value === "asc" || value === "desc";
}
function aggregatePageOptions(method, params) {
    if (method === "thread/loaded/list") {
        // This endpoint accepts only cursor and limit. No limit is a valid
        // official request, represented internally by a bounded 100-row page.
        if (Object.keys(params).some((key) => key !== "cursor" && key !== "limit"))
            return null;
        const requested = params.limit;
        if (requested !== undefined && requested !== null
            && (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1 || requested > MAX_AGGREGATE_PAGE_ROWS))
            return null;
        return {
            limit: typeof requested === "number" ? requested : MAX_AGGREGATE_PAGE_ROWS,
            childLimit: typeof requested === "number" ? requested : null,
            sortKey: null,
            sortDirection: null,
        };
    }
    const limit = params.limit === undefined ? DEFAULT_AGGREGATE_LIMIT : params.limit;
    const sortKey = params.sortKey === undefined || params.sortKey === null ? "created_at" : params.sortKey;
    const sortDirection = params.sortDirection === undefined || params.sortDirection === null ? "desc" : params.sortDirection;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_AGGREGATE_PAGE_ROWS
        || (sortKey !== "created_at" && sortKey !== "updated_at" && sortKey !== "recency_at" && sortKey !== "section_position")
        || (sortKey === "section_position" && method !== "thread/list") || !isSortDirection(sortDirection))
        return null;
    return { limit, childLimit: limit, sortKey, sortDirection };
}
function selectAggregateEntries(session, aggregate, config) {
    const offsets = new Map();
    const selected = [];
    try {
        for (let count = 0; count < aggregate.limit; count += 1) {
            const candidates = [];
            for (const [configuredIndex, account] of config.accounts.entries()) {
                const offset = offsets.get(account.opaqueAccountId) ?? 0;
                const entry = session.buffers.get(account.opaqueAccountId)?.[offset];
                if (entry !== undefined)
                    candidates.push({ owner: account.opaqueAccountId, entry, configuredIndex });
            }
            if (candidates.length === 0)
                break;
            candidates.sort((left, right) => compareAggregateEntries(left, right, aggregate));
            const next = candidates[0];
            selected.push(next);
            offsets.set(next.owner, (offsets.get(next.owner) ?? 0) + 1);
        }
    }
    catch {
        return null;
    }
    return selected;
}
function compareAggregateEntries(left, right, aggregate) {
    const leftValue = aggregateSortValue(left.entry, aggregate);
    const rightValue = aggregateSortValue(right.entry, aggregate);
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
        const comparison = leftValue < rightValue ? -1 : 1;
        return aggregate.sortDirection === "asc" ? comparison : -comparison;
    }
    // Loaded-list is a string[] without a timestamp. Configured account order,
    // then stable child-page order, makes the bounded merge deterministic.
    const leftId = aggregateThreadId(aggregate.method, left.entry);
    const rightId = aggregateThreadId(aggregate.method, right.entry);
    if (leftId !== rightId)
        return leftId.localeCompare(rightId);
    return left.configuredIndex - right.configuredIndex;
}
function aggregateSortValue(entry, aggregate) {
    if (aggregate.method === "thread/loaded/list" || aggregate.sortKey === null || !(0, types_1.isPlainRecord)(entry))
        return null;
    const sortable = aggregate.method === "thread/search" ? entry.thread : entry;
    if (!(0, types_1.isPlainRecord)(sortable))
        return null;
    const responseKey = {
        created_at: "createdAt", updated_at: "updatedAt", recency_at: "recencyAt", section_position: "sectionPosition",
    };
    const raw = sortable[responseKey[aggregate.sortKey]];
    if (typeof raw === "number" && Number.isFinite(raw))
        return raw;
    if (typeof raw === "string") {
        const date = Date.parse(raw);
        return Number.isFinite(date) ? date : raw;
    }
    return null;
}
function aggregateSessionCursor(session, direction, secret) {
    const cursors = direction === "next" ? session.nextCursors : session.backwardsCursors;
    const hasBufferedRows = [...session.buffers.values()].some((buffer) => buffer.length > 0);
    if ((direction === "next" && !hasBufferedRows && ![...cursors.values()].some((cursor) => cursor !== null))
        || (direction === "backwards" && ![...cursors.values()].some((cursor) => cursor !== null)))
        return null;
    const payload = {
        version: 2,
        method: session.method,
        filterBinding: session.filterBinding,
        direction,
        sessionId: session.id,
        sequence: session.sequence,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    if (encoded.length > MAX_ROUTER_CURSOR_BYTES)
        throw new Error("account-router cursor exceeds its bounded size");
    const signature = (0, node_crypto_1.createHmac)("sha256", secret).update(encoded).digest("base64url");
    return `ar1.${encoded}.${signature}`;
}
function sectionSessionCursor(session, secret) {
    const cursors = session.nextCursors;
    const hasBufferedRows = [...session.buffers.values()].some((buffer) => buffer.length > 0);
    if (!hasBufferedRows && ![...cursors.values()].some((cursor) => cursor !== null))
        return null;
    const payload = {
        version: 1, kind: "sections", sessionId: session.id, filterBinding: session.filterBinding, sequence: session.sequence,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = (0, node_crypto_1.createHmac)("sha256", secret).update(encoded).digest("base64url");
    return `arsc1.${encoded}.${signature}`;
}
function parseSectionCursor(value, secret) {
    if (typeof value !== "string" || value.length > MAX_ROUTER_CURSOR_BYTES || !value.startsWith("arsc1."))
        return null;
    const parts = value.split(".");
    if (parts.length !== 3 || !parts[1] || !parts[2])
        return null;
    let payload;
    let actual;
    const expected = (0, node_crypto_1.createHmac)("sha256", secret).update(parts[1]).digest();
    try {
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        actual = Buffer.from(parts[2], "base64url");
    }
    catch {
        return null;
    }
    if (actual.byteLength !== expected.byteLength || !(0, node_crypto_1.timingSafeEqual)(actual, expected) || !(0, types_1.isPlainRecord)(payload)
        || payload.version !== 1 || payload.kind !== "sections" || typeof payload.sessionId !== "string"
        || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.sessionId) || typeof payload.filterBinding !== "string"
        || !/^[a-z0-9:]{8,80}$/.test(payload.filterBinding)
        || typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1)
        return null;
    return payload;
}
function parseRouterCursor(value, secret) {
    if (typeof value !== "string" || value.length > MAX_ROUTER_CURSOR_BYTES || !value.startsWith("ar1."))
        return null;
    const parts = value.split(".");
    if (parts.length !== 3 || !parts[1] || !parts[2])
        return null;
    const expected = (0, node_crypto_1.createHmac)("sha256", secret).update(parts[1]).digest();
    let actual;
    let payload;
    try {
        actual = Buffer.from(parts[2], "base64url");
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    }
    catch {
        return null;
    }
    if (actual.byteLength !== expected.byteLength || !(0, node_crypto_1.timingSafeEqual)(actual, expected) || !(0, types_1.isPlainRecord)(payload))
        return null;
    if (payload.version !== 2 || (payload.method !== "thread/list" && payload.method !== "thread/search" && payload.method !== "thread/loaded/list")
        || typeof payload.filterBinding !== "string" || !/^[a-z0-9:]{8,80}$/.test(payload.filterBinding)
        || (payload.direction !== "next" && payload.direction !== "backwards")
        || typeof payload.sessionId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.sessionId)
        || typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1)
        return null;
    return {
        version: 2,
        method: payload.method,
        filterBinding: payload.filterBinding,
        direction: payload.direction,
        sessionId: payload.sessionId,
        sequence: payload.sequence,
    };
}
function signedCursor(payload, secret) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = (0, node_crypto_1.createHmac)("sha256", secret).update(encoded).digest("base64url");
    return `ar1.${encoded}.${signature}`;
}
function refreshResponseMatches(result, account, secret) {
    if (!(0, types_1.isPlainRecord)(result) || typeof result.chatgptAccountId !== "string" || result.chatgptAccountId.length === 0)
        return false;
    const opaque = `ar_${(0, node_crypto_1.createHmac)("sha256", secret).update(`account-router:v1:${result.chatgptAccountId}`, "utf8").digest("base64url")}`;
    return opaque === account;
}
function usageFrom(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    const inputTokens = value.inputTokens;
    const outputTokens = value.outputTokens;
    if (typeof inputTokens !== "number" || typeof outputTokens !== "number"
        || !Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 0 || outputTokens < 0)
        return null;
    return { inputTokens, outputTokens };
}
function modelFrom(params) {
    return (0, types_1.isPlainRecord)(params) && typeof params.model === "string" ? params.model : "default";
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if ((0, types_1.isPlainRecord)(value))
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}
//# sourceMappingURL=mux.js.map
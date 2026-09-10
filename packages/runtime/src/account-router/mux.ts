import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  RouterConfig,
  RouterConfigV2,
  RouterConfigV3,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  OpaqueAccountId,
  RedactedControlAccountV2,
  RedactedControlIntentV2,
  RedactedControlStatus,
  RedactedControlStatusV2,
  RedactedControlStatusV3,
} from "./types";
import { isJsonRpcId, isPlainRecord } from "./types";
import { AccountLedger, normalizedSpend } from "./ledger";
import { redactedRouterError } from "./redaction";
import {
  accountObservationEligible,
  emptyQuotaObservation,
  parseAccountRead,
  parseRateLimitsRead,
  quotaFreshness,
  type AccountQuotaObservation,
} from "./quota";
import { isQuotaAwareRouterConfig } from "./config";
import {
  CorrelationTable,
  classifyClientMethod,
  classifyServerNotification,
  hasThreadId,
  isKnownServerRequest,
  isNotification,
  isRequest,
  isResponse,
  parseJsonRpcLine,
  threadIdFrom,
  type ClientRoute,
} from "./protocol";
import type { RouterStateStore } from "./state-store";

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

const INTERACTIVE_SERVER_REQUEST_METHODS = new Set<string>([
  "applyPatchApproval", "execCommandApproval", "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/call",
  "item/tool/requestUserInput", "mcpServer/elicitation/request",
]);

// These request families are account/process scoped. Every other admitted
// child-originated request is thread-scoped and must prove its durable owner.
const GLOBAL_SERVER_REQUEST_METHODS = new Set<string>([
  "account/chatgptAuthTokens/refresh", "attestation/generate",
]);

// These operations can legitimately remain active while a command, MCP tool,
// or turn runs. Their count is bounded, but no wall-clock timeout fabricates a
// failure while the child is still doing the requested work.
const LONG_LIVED_DIRECT_METHODS = new Set<string>([
  "command/exec", "mcpServer/tool/call", "process/spawn", "fs/watch",
  "thread/start", "turn/start", "turn/steer", "thread/compact/start", "thread/realtime/start",
]);

export interface RouterChild {
  readonly opaqueAccountId: OpaqueAccountId;
  send(message: JsonRpcMessage): void;
  terminate(signal: NodeJS.Signals): void;
  markInitialized?(): void;
}

export interface RouterChildFactory {
  create(
    account: OpaqueAccountId,
    handlers: { onMessage(message: JsonRpcMessage): void; onFailure(): void },
  ): RouterChild;
}

export class RouterPreDispatchError extends Error {
  constructor(message = "child stdin was not written") {
    super(message);
    this.name = "RouterPreDispatchError";
  }
}

interface IssuedRequest {
  internalId: string;
  desktopId: JsonRpcId;
  child: RouterChild;
  method: string;
  reservationId?: string;
  pendingOwnerKey?: string;
  fanoutKey?: string;
  initialization?: boolean;
  quotaProbe?: "account" | "rate_limits";
  /** The already-owned source thread for review/fork delivery semantics. */
  sourceThreadId?: string;
  /** A single-home section-filtered list whose response needs local-id rewrite. */
  sectionOwner?: OpaqueAccountId;
}

interface Fanout {
  desktopId: JsonRpcId;
  expected: number;
  responses: FanoutResponse[];
  failed: boolean;
  route: ClientRoute;
  aggregate?: AggregateRequest;
  sections?: SectionRequest;
  timeout?: ReturnType<typeof setTimeout>;
}

interface SectionBinding {
  readonly childId: OpaqueAccountId;
  readonly localId: string;
  readonly expiresAt: number;
}

interface SectionSession {
  readonly id: string;
  sequence: number;
  expiresAt: number;
  readonly filterBinding: string;
  readonly seenRouterIds: Set<string>;
  readonly buffers: Map<OpaqueAccountId, Record<string, unknown>[]>;
  readonly nextCursors: Map<OpaqueAccountId, string | null>;
}

interface SectionRequest {
  readonly session: SectionSession;
  readonly limit: number;
  readonly initial: boolean;
  readonly cursors: Map<OpaqueAccountId, string | null>;
  readonly childLimit: number | null | undefined;
}

interface SectionPage {
  readonly data: Record<string, unknown>[];
  readonly nextCursor: string | null;
}

interface FanoutResponse {
  childId: OpaqueAccountId;
  response: JsonRpcResponse;
}

interface AggregateRequest {
  method: "thread/list" | "thread/search" | "thread/loaded/list";
  filterBinding: string;
  limit: number;
  childLimit: number | null;
  /** Null means the official loaded-list no-sort envelope. */
  sortKey: AggregateSortKey | null;
  sortDirection: "asc" | "desc" | null;
  direction: "next" | "backwards";
  initial: boolean;
  session: AggregateSession;
  cursors: Map<OpaqueAccountId, string | null>;
}

interface AggregateSession {
  id: string;
  method: AggregateRequest["method"];
  filterBinding: string;
  sortKey: AggregateSortKey | null;
  sortDirection: "asc" | "desc" | null;
  sequence: number;
  expiresAt: number;
  buffers: Map<OpaqueAccountId, unknown[]>;
  nextCursors: Map<OpaqueAccountId, string | null>;
  backwardsCursors: Map<OpaqueAccountId, string | null>;
  seenThreadIds: Set<string>;
  rows: number;
  bytes: number;
}

interface AggregatePage {
  data: unknown[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

type AggregateAppendResult = "ok" | "invalid_page" | "owner_collision";

interface AggregatePageOptions {
  /** Bounded mux output cap; loaded-list's omitted/null limit uses 100. */
  limit: number;
  /** Null preserves the official loaded-list no-limit request shape. */
  childLimit: number | null;
  sortKey: AggregateSortKey | null;
  sortDirection: "asc" | "desc" | null;
}

interface RouterCursorPayload {
  version: 2;
  method: AggregateRequest["method"];
  filterBinding: string;
  direction: "next" | "backwards";
  sessionId: string;
  sequence: number;
}

interface SectionCursorPayload {
  version: 1;
  kind: "sections";
  sessionId: string;
  filterBinding: string;
  sequence: number;
}

interface QueuedNewThread {
  request: JsonRpcRequest;
}

interface BufferedStartedThread {
  childId: OpaqueAccountId;
  notification: JsonRpcMessage;
  timer: ReturnType<typeof setTimeout>;
}

interface ServerRequestLifecycle {
  readonly childId: OpaqueAccountId;
  readonly childRequestId: JsonRpcId;
  readonly desktopRequestId: string;
  readonly correlationId: string;
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  responseForwarded: boolean;
}

interface ServerRequestTombstone {
  readonly childId: OpaqueAccountId;
  readonly childRequestId: JsonRpcId;
  readonly desktopRequestId: string;
  readonly method: string;
  resolved: boolean;
}

type RouterTimer = ReturnType<typeof setTimeout>;

export interface AccountRouterMuxOptions {
  config: RouterConfig;
  store: RouterStateStore;
  childFactory: RouterChildFactory;
  writeDesktop: (message: JsonRpcMessage) => void;
  controlSecret?: Buffer;
  now?: () => number;
  quotaProbeTimeoutMs?: number;
  queuedStartTimeoutMs?: number;
  aggregateSessionTtlMs?: number;
  fanoutTimeoutMs?: number;
  serverRequestTimeoutMs?: number;
  desktopRequestTimeoutMs?: number;
  /** Test-only clock seam; production uses Node's timer functions. */
  setTimeout?: (callback: () => void, delay: number) => RouterTimer;
  clearTimeout?: (timer: RouterTimer) => void;
  /** Owner-private config read used only to distinguish a live v2 intent from a later pending one. */
  readPendingConfig?: () => RouterConfig | null;
  onFatal?: () => void;
  onShutdown?: () => void;
}

/**
 * The JSONL-only app-server multiplexer. Its public output is restricted to
 * normal JSON-RPC frames and redacted router errors; status/protocol details
 * stay in owner-private state.
 */
export class AccountRouterMux {
  private readonly children = new Map<OpaqueAccountId, RouterChild>();
  private readonly correlations: CorrelationTable;
  private readonly ledger: AccountLedger;
  private readonly issued = new Map<string, IssuedRequest>();
  private readonly fanouts = new Map<string, Fanout>();
  private readonly aggregateSessions = new Map<string, AggregateSession>();
  private readonly sectionSessions = new Map<string, SectionSession>();
  private readonly sectionBindings = new Map<string, SectionBinding>();
  private readonly sectionBindingKeys = new Map<string, string>();
  private readonly pendingReservationsByThread = new Map<string, string>();
  private readonly bufferedStartedThreads = new Map<string, BufferedStartedThread>();
  private readonly serverRequestsByChild = new Map<string, ServerRequestLifecycle>();
  private readonly serverRequestsByDesktop = new Map<string, ServerRequestLifecycle>();
  private readonly serverRequestTombstonesByChild = new Map<string, ServerRequestTombstone>();
  private readonly serverRequestTombstonesByDesktop = new Map<string, ServerRequestTombstone>();
  private readonly tokenUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
  private readonly refreshInFlight = new Map<OpaqueAccountId, string>();
  private readonly quota = new Map<OpaqueAccountId, AccountQuotaObservation>();
  private readonly quotaProbesInFlight = new Map<OpaqueAccountId, Set<"account" | "rate_limits">>();
  private readonly quotaProbeTimers = new Map<string, RouterTimer>();
  private readonly desktopRequestTimers = new Map<string, RouterTimer>();
  private readonly expiredQuotaProbeIds = new Set<string>();
  private readonly expiredFanoutReplyIds = new Set<string>();
  private readonly expiredDesktopRequestIds = new Set<string>();
  private readonly consumedRouterCursors = new Set<string>();
  private readonly controlSecret: Buffer;
  private accepting = true;
  private started = false;
  private initialized = false;
  private precisionEstimated = false;
  private fatalSignalled = false;
  private shutdownSignalled = false;
  private quotaProbeNonce = 0;
  private queuedNewThread: QueuedNewThread | null = null;
  private queuedNewThreadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AccountRouterMuxOptions) {
    this.controlSecret = options.controlSecret ?? randomBytes(32);
    this.ledger = new AccountLedger(options.store, options.config, options.now);
    this.correlations = new CorrelationTable(options.store.snapshot().correlations, (records) => {
      options.store.update((state) => { state.correlations = records; });
    });
    if (isQuotaAwareRouterConfig(options.config)) {
      for (const account of options.config.accounts) this.quota.set(account.opaqueAccountId, emptyQuotaObservation());
    }
  }

  start(): boolean {
    if (this.started) return this.children.size > 0;
    this.started = true;
    for (const account of this.options.config.accounts) {
      if (!account.included) continue;
      try {
        const child = this.options.childFactory.create(account.opaqueAccountId, {
          onMessage: (message) => this.handleChildMessage(account.opaqueAccountId, message),
          onFailure: () => this.postStartFailure("post_start_failure"),
        });
        this.children.set(account.opaqueAccountId, child);
        this.ledger.setEligibility(account.opaqueAccountId, "validating");
      } catch {
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

  receiveDesktopLine(line: string): void {
    const message = parseJsonRpcLine(line);
    if (!message) {
      this.options.writeDesktop(redactedRouterError(null, "invalid_request"));
      return;
    }
    this.receiveDesktop(message);
  }

  receiveDesktop(message: JsonRpcMessage): void {
    if (!this.accepting) {
      if (isRequest(message)) this.options.writeDesktop(redactedRouterError(message.id, "router_stopping"));
      return;
    }
    if (isResponse(message)) {
      this.routeDesktopResponse(message);
      return;
    }
    if (isNotification(message)) {
      if (message.method !== "initialized" || !this.initialized) {
        this.protocolDrift();
        return;
      }
      for (const child of this.children.values()) {
        try { child.send(message); } catch { this.postStartFailure("post_start_failure"); }
      }
      return;
    }
    this.routeDesktopRequest(message);
  }

  status(): RedactedControlStatus {
    if (isQuotaAwareRouterConfig(this.options.config)) return this.quotaAwareStatus();
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
        normalizedSpend: normalizedSpend(state, account.opaqueAccountId),
        assignedThreadCount: state.ledger[account.opaqueAccountId]?.assignedThreadCount ?? 0,
      })),
      restartRequired: state.stagedDisable !== null,
      degradedReason: state.stagedDisable?.reasonCode === "protocol_drift" ? "unsupported_protocol"
        : state.stagedDisable?.reasonCode === "post_start_failure" ? "post_start_failure"
          : state.stagedDisable?.reasonCode === "isolation_failure" ? "capability_mismatch" : null,
    };
  }

  shutdown(): void {
    if (this.shutdownSignalled) return;
    this.shutdownSignalled = true;
    for (const timer of this.quotaProbeTimers.values()) this.clearTimer(timer);
    this.quotaProbeTimers.clear();
    for (const timer of this.desktopRequestTimers.values()) this.clearTimer(timer);
    this.desktopRequestTimers.clear();
    for (const fanout of this.fanouts.values()) if (fanout.timeout) this.clearTimer(fanout.timeout);
    this.fanouts.clear();
    this.aggregateSessions.clear();
    this.sectionSessions.clear();
    this.sectionBindings.clear();
    this.sectionBindingKeys.clear();
    for (const pending of this.bufferedStartedThreads.values()) this.clearTimer(pending.timer);
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
        if (issued.pendingOwnerKey) this.ledger.clearPendingOwner(issued.pendingOwnerKey, issued.child.opaqueAccountId);
      }
    }
    this.clearQueuedNewThread();
    this.options.onShutdown?.();
    if (!this.accepting && this.children.size === 0) return;
    this.accepting = false;
    for (const child of this.children.values()) {
      try { child.terminate("SIGTERM"); } catch { /* bounded owned-child cleanup */ }
    }
  }

  private routeDesktopRequest(request: JsonRpcRequest): void {
    const route = classifyClientMethod(request.method, request.params);
    if (route === "unknown") {
      this.protocolDrift();
      this.options.writeDesktop(redactedRouterError(request.id, "unknown_method"));
      return;
    }
    if (route === "reject_in_balanced_mode_use_manual_enrollment") {
      this.options.writeDesktop(redactedRouterError(request.id, "balanced_mode_auth_mutation"));
      return;
    }
    if (route === "reject_capability_mutation_restart_required") {
      this.stageCapabilityRestartRequired();
      this.options.writeDesktop(redactedRouterError(request.id, "capability_mismatch"));
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
      this.options.writeDesktop(redactedRouterError(request.id, "post_start_failure"));
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
      if (request.method === "thread/list" && isPlainRecord(request.params) && request.params.sectionId !== undefined && request.params.sectionId !== null) {
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
      this.options.writeDesktop(redactedRouterError(request.id, "capability_mismatch"));
      return;
    }
    const child = this.childForRoute(route, request.params);
    if (!child) {
      this.options.writeDesktop(redactedRouterError(request.id, hasThreadId(request.params) ? "unknown_thread_owner" : "pool_depleted"));
      return;
    }
    this.dispatchToChild(request, child);
  }

  private initialize(request: JsonRpcRequest): void {
    if (this.initialized) {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_request"));
      return;
    }
    const key = fanoutKey(request.id);
    const fanout: Fanout = { desktopId: request.id, expected: this.children.size, responses: [], failed: false, route: "fanout_initialize_intersection" };
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

  private dispatchFeatureEnablement(request: JsonRpcRequest): void {
    const key = fanoutKey(request.id);
    const fanout: Fanout = { desktopId: request.id, expected: this.children.size, responses: [], failed: false, route: "fanout_feature_enablement" };
    this.fanouts.set(key, fanout);
    this.startFanoutTimeout(key, fanout);
    let scope = 0;
    for (const child of this.children.values()) {
      if (!this.dispatchToChild(request, child, { fanoutKey: key, scope: `feature-${scope++}` })) this.failFanout(fanout, key);
    }
  }

  private dispatchNewThread(request: JsonRpcRequest): void {
    if (isQuotaAwareRouterConfig(this.options.config) && this.options.config.mode === "manual") {
      // Manual v2 remains mux-backed for durable aggregate history, but new
      // work is an explicit primary-only route. Quota observations stay
      // visible truth and never select or fail over to the other account.
      const primary = this.options.config.primaryOpaqueAccountId;
      const state = this.options.store.snapshot();
      if (!this.children.has(primary) || state.accountEligibility[primary] !== "eligible") {
        this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
        return;
      }
      this.dispatchSelectedNewThread(request, primary);
      return;
    }
    const first = isQuotaAwareRouterConfig(this.options.config)
      ? this.ledger.selectQuotaAware(this.quota)
      : this.ledger.select();
    if (!first) {
      if (isQuotaAwareRouterConfig(this.options.config) && this.quotaNeedsRefresh()) {
        this.queueNewThreadForQuotaRefresh(request);
        return;
      }
      this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    this.dispatchSelectedNewThread(request, first.opaqueAccountId);
  }

  /** A request is delivered once, only after fresh two-account capacity exists. */
  private dispatchSelectedNewThread(request: JsonRpcRequest, account: OpaqueAccountId): void {
    const estimatedCost = this.ledger.estimateRequestCost(request.params, modelFrom(request.params));
    const child = this.children.get(account);
    if (!child) {
      this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    const reservation = this.ledger.reserve(account, estimatedCost);
    const pendingOwnerKey = `pending:${reservation.reservationId}`;
    this.ledger.reservePendingOwner(pendingOwnerKey, account);
    try {
      const issued = this.dispatchToChild(request, child, {
        reservationId: reservation.reservationId, pendingOwnerKey, scope: "new", suppressDesktopError: true,
      });
      if (issued) return;
      this.ledger.releasePreDispatch(reservation.reservationId);
      this.ledger.clearPendingOwner(pendingOwnerKey, account);
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
    } catch (error) {
      if (error instanceof RouterPreDispatchError) {
        this.ledger.releasePreDispatch(reservation.reservationId);
        this.ledger.clearPendingOwner(pendingOwnerKey, account);
        this.options.writeDesktop(redactedRouterError(request.id, "post_start_failure"));
        return;
      }
      this.ledger.strandAmbiguous(reservation.reservationId);
      this.options.writeDesktop(redactedRouterError(request.id, "ambiguous_dispatch"));
    }
  }

  private dispatchFanout(request: JsonRpcRequest, route: ClientRoute): void {
    const aggregate = route === "fanout_aggregate_read_with_router_cursor"
      ? this.aggregateRequest(request)
      : null;
    if (route === "fanout_aggregate_read_with_router_cursor" && !aggregate) {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    const key = fanoutKey(request.id);
    const selectable = [...this.children.values()].filter((child) => this.options.store.snapshot().accountEligibility[child.opaqueAccountId] !== "protocol_blocked");
    if (selectable.length === 0) {
      this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    const targets = aggregate
      ? selectable.filter((child) => aggregate.initial
        || ((aggregate.session.buffers.get(child.opaqueAccountId)?.length ?? 0) === 0
          && (aggregate.cursors.get(child.opaqueAccountId) ?? null) !== null))
      : selectable;
    const fanout: Fanout = { desktopId: request.id, expected: targets.length, responses: [], failed: false, route, aggregate: aggregate ?? undefined };
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
  private dispatchSectionRead(request: JsonRpcRequest): void {
    const section = this.sectionRequest(request);
    if (!section) {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    const targets = [...this.children.values()].filter((child) => section.initial
      || ((section.session.buffers.get(child.opaqueAccountId)?.length ?? 0) === 0
        && (section.cursors.get(child.opaqueAccountId) ?? null) !== null));
    const key = fanoutKey(request.id);
    const fanout: Fanout = {
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
      const params = isPlainRecord(request.params) ? { ...request.params } : {};
      if (section.childLimit === undefined) delete params.limit;
      else params.limit = section.childLimit;
      if (cursor === null) delete params.cursor;
      else params.cursor = cursor;
      const issued = this.dispatchToChild({ ...request, params }, child, { fanoutKey: key, scope: `sections-${index}` });
      if (!issued) {
        this.failFanout(fanout, key);
        return;
      }
    }
  }

  /** A resolved router section confines the read to its single owning home. */
  private dispatchSectionFilteredList(request: JsonRpcRequest): void {
    if (!isPlainRecord(request.params) || typeof request.params.sectionId !== "string") {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    const binding = this.resolveSectionBinding(request.params.sectionId);
    if (!binding) {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    const child = this.children.get(binding.childId);
    const aggregate = this.aggregateRequest(request);
    if (!child || !aggregate) {
      this.options.writeDesktop(sectionRouterError(request.id, "section_unsupported"));
      return;
    }
    const key = fanoutKey(request.id);
    const fanout: Fanout = {
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
    if (!issued) this.failFanout(fanout, key);
  }

  private sectionRequest(request: JsonRpcRequest): SectionRequest | null {
    if (request.method !== "threadSection/list" || !isPlainRecord(request.params ?? {})) return null;
    const params = request.params ?? {};
    if (!isPlainRecord(params) || Object.keys(params).some((key) => key !== "cursor" && key !== "limit")) return null;
    const requestedLimit = params.limit;
    if (requestedLimit !== undefined && requestedLimit !== null
      && (typeof requestedLimit !== "number" || !Number.isInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > MAX_AGGREGATE_PAGE_ROWS)) return null;
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
    if (typeof params.cursor !== "string" || this.consumedRouterCursors.has(params.cursor)) return null;
    const payload = parseSectionCursor(params.cursor, this.controlSecret);
    const session = payload ? this.sectionSessions.get(payload.sessionId) ?? null : null;
    if (!payload || !session || session.expiresAt <= this.now() || payload.filterBinding !== filterBinding
      || payload.sequence !== session.sequence) return null;
    this.consumedRouterCursors.add(params.cursor);
    while (this.consumedRouterCursors.size > 128) this.consumedRouterCursors.delete(this.consumedRouterCursors.values().next().value!);
    session.sequence += 1;
    session.expiresAt = this.now() + this.aggregateSessionTtl();
    return {
      session, limit, childLimit: requestedLimit, initial: false,
      cursors: new Map(session.nextCursors),
    };
  }

  private createSectionSession(filterBinding: string): SectionSession {
    this.evictExpiredSectionSessions();
    while (this.sectionSessions.size >= MAX_AGGREGATE_SESSIONS) this.sectionSessions.delete(this.sectionSessions.keys().next().value!);
    const session: SectionSession = {
      id: randomBytes(16).toString("base64url"), sequence: 1, expiresAt: this.now() + this.aggregateSessionTtl(), filterBinding,
      seenRouterIds: new Set(),
      buffers: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, []])),
      nextCursors: new Map(this.options.config.accounts.map((account) => [account.opaqueAccountId, null])),
    };
    this.sectionSessions.set(session.id, session);
    return session;
  }

  private evictExpiredSectionSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sectionSessions) if (session.expiresAt <= now) this.sectionSessions.delete(id);
    for (const [id, binding] of this.sectionBindings) {
      if (binding.expiresAt > now) continue;
      this.sectionBindings.delete(id);
      this.sectionBindingKeys.delete(sectionBindingKey(binding.childId, binding.localId));
    }
  }

  private sectionRouterId(childId: OpaqueAccountId, localId: string): string {
    this.evictExpiredSectionSessions();
    const key = sectionBindingKey(childId, localId);
    const existing = this.sectionBindingKeys.get(key);
    if (existing && this.sectionBindings.has(existing)) return existing;
    const nonce = randomBytes(16).toString("base64url");
    const signature = createHmac("sha256", this.controlSecret).update(`section:v1:${nonce}`, "utf8").digest("base64url");
    const id = `ars1.${nonce}.${signature}`;
    this.sectionBindings.set(id, { childId, localId, expiresAt: this.now() + SECTION_BINDING_TTL_MS });
    this.sectionBindingKeys.set(key, id);
    while (this.sectionBindings.size > MAX_AGGREGATE_SESSION_ROWS) {
      const [expiredId, binding] = this.sectionBindings.entries().next().value! as [string, SectionBinding];
      this.sectionBindings.delete(expiredId);
      this.sectionBindingKeys.delete(sectionBindingKey(binding.childId, binding.localId));
    }
    return id;
  }

  private resolveSectionBinding(id: string): SectionBinding | null {
    if (!validSectionRouterId(id, this.controlSecret)) return null;
    this.evictExpiredSectionSessions();
    return this.sectionBindings.get(id) ?? null;
  }

  /**
   * A router cursor is the only accepted continuation token for a fanout read.
   * It binds method and all non-cursor filter fields so a child cursor cannot be
   * replayed against another request shape or method.
   */
  private aggregateRequest(request: JsonRpcRequest): AggregateRequest | null {
    if (request.method !== "thread/list" && request.method !== "thread/search" && request.method !== "thread/loaded/list") return null;
    const params = request.params ?? {};
    if (!isPlainRecord(params)) return null;
    const options = aggregatePageOptions(request.method, params);
    if (!options) return null;
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
    if (typeof submittedCursor !== "string") return null;
    const payload = parseRouterCursor(submittedCursor, this.controlSecret);
    const session = payload ? this.aggregateSessions.get(payload.sessionId) ?? null : null;
    if (!payload || !session || session.expiresAt <= this.now() || payload.method !== request.method
      || payload.sequence !== session.sequence || !cursorMatchesAggregateRequest(payload, filterBinding, request.method, params)) return null;
    if (this.consumedRouterCursors.has(submittedCursor)) return null;
    this.consumedRouterCursors.add(submittedCursor);
    while (this.consumedRouterCursors.size > 128) this.consumedRouterCursors.delete(this.consumedRouterCursors.values().next().value!);
    if (payload.direction === "backwards" && session.filterBinding !== filterBinding) this.resetAggregateSession(session);
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

  private createAggregateSession(
    method: AggregateRequest["method"],
    filterBinding: string,
    options: AggregatePageOptions,
  ): AggregateSession {
    this.evictExpiredAggregateSessions();
    while (this.aggregateSessions.size >= MAX_AGGREGATE_SESSIONS) this.aggregateSessions.delete(this.aggregateSessions.keys().next().value!);
    const session: AggregateSession = {
      id: randomBytes(16).toString("base64url"), method, filterBinding,
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

  private resetAggregateSession(session: AggregateSession): void {
    for (const buffer of session.buffers.values()) buffer.length = 0;
    session.seenThreadIds.clear();
    session.rows = 0;
    session.bytes = 0;
  }

  private aggregateSessionTtl(): number {
    const ttl = this.options.aggregateSessionTtlMs ?? AGGREGATE_SESSION_TTL_MS;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 5 * 60_000) throw new Error("invalid account-router aggregate session TTL");
    return ttl;
  }

  private evictExpiredAggregateSessions(): void {
    const now = this.now();
    for (const [id, session] of this.aggregateSessions) if (session.expiresAt <= now) this.aggregateSessions.delete(id);
  }

  private bindAggregateThreads(method: AggregateRequest["method"], entries: readonly unknown[], owner: OpaqueAccountId): boolean {
    try {
      for (const entry of entries) {
        const threadId = aggregateThreadId(method, entry);
        // The listed item must name a thread. Exposing an entry that cannot be
        // durably routed later would turn a list response into an affinity bug.
        if (!threadId) return false;
        this.ledger.bindKnownThread(threadId, owner);
      }
      return true;
    } catch {
      // A duplicate id from different per-account results makes all later
      // thread-affine traffic ambiguous. Do not expose a partial fanout page.
      return false;
    }
  }

  private appendAggregatePage(aggregate: AggregateRequest, page: AggregatePage, owner: OpaqueAccountId): boolean {
    const session = aggregate.session;
    if (!this.bindAggregateThreads(aggregate.method, page.data, owner)) return false;
    const ids = page.data.map((entry) => aggregateThreadId(aggregate.method, entry));
    if (ids.some((id) => id === null || session.seenThreadIds.has(id))) return false;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(page.data), "utf8"); } catch { return false; }
    if (page.data.length > MAX_AGGREGATE_PAGE_ROWS || session.rows + page.data.length > MAX_AGGREGATE_SESSION_ROWS
      || session.bytes + bytes > MAX_AGGREGATE_SESSION_BYTES) return false;
    const buffer = session.buffers.get(owner);
    if (!buffer) return false;
    buffer.push(...page.data);
    for (const id of ids) session.seenThreadIds.add(id!);
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
  private appendAggregatePages(aggregate: AggregateRequest, pages: readonly { page: AggregatePage; owner: OpaqueAccountId }[]): AggregateAppendResult {
    if (this.aggregatePagesHaveOwnerCollision(aggregate, pages)) return "owner_collision";
    const session = aggregate.session;
    const batch: Array<{ threadId: string; owner: OpaqueAccountId }> = [];
    const prepared: Array<{ page: AggregatePage; owner: OpaqueAccountId; ids: string[]; bytes: number }> = [];
    const observed = new Set(session.seenThreadIds);
    let totalRows = session.rows;
    let totalBytes = session.bytes;
    for (const source of pages) {
      const page = this.rewriteAggregatePage(source.page, aggregate.method, source.owner);
      const owner = source.owner;
      if (!page) return "invalid_page";
      if (!session.buffers.has(owner) || page.data.length > MAX_AGGREGATE_PAGE_ROWS) return "invalid_page";
      const ids = page.data.map((entry) => aggregateThreadId(aggregate.method, entry));
      if (ids.some((id) => id === null)) return "invalid_page";
      const safeIds = ids as string[];
      if (safeIds.some((id) => observed.has(id))) return "invalid_page";
      let bytes: number;
      try { bytes = aggregateEntriesBytes(page.data); } catch { return "invalid_page"; }
      totalRows += page.data.length;
      totalBytes += bytes;
      if (totalRows > MAX_AGGREGATE_SESSION_ROWS || totalBytes > MAX_AGGREGATE_SESSION_BYTES) return "invalid_page";
      for (const id of safeIds) {
        observed.add(id);
        batch.push({ threadId: id, owner });
      }
      prepared.push({ page, owner, ids: safeIds, bytes });
    }
    try {
      this.ledger.bindKnownThreads(batch);
    } catch {
      return "owner_collision";
    }
    for (const { page, owner, ids, bytes } of prepared) {
      const buffer = session.buffers.get(owner);
      if (!buffer) return "invalid_page"; // guarded above; retain fail-closed invariant
      buffer.push(...page.data);
      for (const id of ids) session.seenThreadIds.add(id);
      session.rows += page.data.length;
      session.bytes += bytes;
      session.nextCursors.set(owner, page.nextCursor);
      session.backwardsCursors.set(owner, page.backwardsCursor);
    }
    session.expiresAt = this.now() + this.aggregateSessionTtl();
    return "ok";
  }

  private aggregatePagesHaveOwnerCollision(aggregate: AggregateRequest, pages: readonly { page: AggregatePage; owner: OpaqueAccountId }[]): boolean {
    const owners = new Map<string, OpaqueAccountId>();
    for (const { page, owner } of pages) {
      for (const entry of page.data) {
        const id = aggregateThreadId(aggregate.method, entry);
        if (!id) return false;
        const prior = owners.get(id);
        if ((prior && prior !== owner) || (this.ledger.ownerFor(id) !== null && this.ledger.ownerFor(id) !== owner)) return true;
        owners.set(id, owner);
      }
    }
    return false;
  }

  /** Rewrite only known nested section ids; a local id is never exposed. */
  private rewriteAggregatePage(page: AggregatePage, method: AggregateRequest["method"], owner: OpaqueAccountId): AggregatePage | null {
    const data: unknown[] = [];
    for (const entry of page.data) {
      const rewritten = this.rewriteAggregateSectionEntry(entry, method, owner);
      if (rewritten === null) return null;
      data.push(rewritten);
    }
    return { ...page, data };
  }

  private rewriteAggregateSectionEntry(entry: unknown, method: AggregateRequest["method"], owner: OpaqueAccountId): unknown | null {
    if (method === "thread/loaded/list") return entry;
    if (!isPlainRecord(entry)) return null;
    if (method === "thread/search") {
      if (!isPlainRecord(entry.thread)) return null;
      const thread = this.rewriteThreadSection(entry.thread, owner);
      return thread ? { ...entry, thread } : null;
    }
    return this.rewriteThreadSection(entry, owner);
  }

  private rewriteThreadSection(thread: Record<string, unknown>, owner: OpaqueAccountId): Record<string, unknown> | null {
    const section = thread.section;
    if (section === undefined || section === null) return { ...thread };
    if (!isPlainRecord(section) || !safeThreadId(section.id)) return null;
    return { ...thread, section: { ...section, id: this.sectionRouterId(owner, section.id as string) } };
  }

  /** Rewrite section references in direct responses and notifications too. */
  private rewriteChildSections(message: JsonRpcMessage, owner: OpaqueAccountId): JsonRpcMessage | null {
    let visited = 0;
    const rewrite = (value: unknown, depth: number): unknown | null => {
      if (depth > 8 || ++visited > 2_048) return null;
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (const item of value) {
          const next = rewrite(item, depth + 1);
          if (next === null) return null;
          items.push(next);
        }
        return items;
      }
      if (!isPlainRecord(value)) return value;
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "section" && isPlainRecord(item) && typeof item.id === "string") {
          output[key] = { ...item, id: this.sectionRouterId(owner, item.id) };
          continue;
        }
        const next = rewrite(item, depth + 1);
        if (next === null) return null;
        output[key] = next;
      }
      return output;
    };
    const rewritten = rewrite(message, 0);
    return rewritten && isPlainRecord(rewritten) ? rewritten as unknown as JsonRpcMessage : null;
  }

  private appendSectionPages(section: SectionRequest, pages: readonly { page: SectionPage; owner: OpaqueAccountId }[]): boolean {
    const prepared: Array<{ owner: OpaqueAccountId; data: Record<string, unknown>[]; next: string | null }> = [];
    const observed = new Set(section.session.seenRouterIds);
    for (const { page, owner } of pages) {
      if (page.data.length > MAX_AGGREGATE_PAGE_ROWS || !section.session.buffers.has(owner)) return false;
      const rewritten: Record<string, unknown>[] = [];
      for (const entry of page.data) {
        const localId = safeThreadId(entry.id);
        if (!localId) return false;
        const routerId = this.sectionRouterId(owner, localId);
        if (observed.has(routerId)) return false;
        observed.add(routerId);
        rewritten.push({ ...entry, id: routerId });
      }
      prepared.push({ owner, data: rewritten, next: page.nextCursor });
    }
    for (const item of prepared) {
      const buffer = section.session.buffers.get(item.owner);
      if (!buffer) return false;
      buffer.push(...item.data);
      for (const entry of item.data) section.session.seenRouterIds.add(entry.id as string);
      section.session.nextCursors.set(item.owner, item.next);
    }
    section.session.expiresAt = this.now() + this.aggregateSessionTtl();
    return true;
  }

  private sectionPageResult(section: SectionRequest): { data: Record<string, unknown>[]; nextCursor: string | null } {
    const data: Record<string, unknown>[] = [];
    for (const account of this.options.config.accounts) {
      const buffer = section.session.buffers.get(account.opaqueAccountId);
      while (buffer && buffer.length > 0 && data.length < section.limit) data.push(buffer.shift()!);
      if (data.length === section.limit) break;
    }
    section.session.expiresAt = this.now() + this.aggregateSessionTtl();
    return {
      data,
      nextCursor: sectionSessionCursor(section.session, this.controlSecret),
    };
  }

  private aggregatePageResult(aggregate: AggregateRequest): { data: unknown[]; nextCursor: string | null; backwardsCursor: string | null } | null {
    const session = aggregate.session;
    const selected = selectAggregateEntries(session, aggregate, this.options.config);
    if (!selected) return null;
    for (const item of selected) {
      const buffer = session.buffers.get(item.owner);
      if (!buffer || buffer.shift() !== item.entry) return null;
      session.rows = Math.max(0, session.rows - 1);
      try { session.bytes = Math.max(0, session.bytes - aggregateEntriesBytes([item.entry])); } catch { return null; }
    }
    session.expiresAt = this.now() + this.aggregateSessionTtl();
    return {
      data: selected.map((item) => item.entry),
      nextCursor: aggregateSessionCursor(session, "next", this.controlSecret),
      backwardsCursor: aggregateSessionCursor(session, "backwards", this.controlSecret),
    };
  }

  /** A read failure is request-local; only init or proven owner collision stops routing. */
  private failFanout(fanout: Fanout, key?: string, unsafe = fanout.route === "fanout_initialize_intersection"): void {
    if (fanout.timeout) clearTimeout(fanout.timeout);
    fanout.timeout = undefined;
    if (key) {
      this.fanouts.delete(key);
      this.discardFanoutIssued(key);
    }
    if (fanout.aggregate) this.aggregateSessions.delete(fanout.aggregate.session.id);
    if (fanout.sections) this.sectionSessions.delete(fanout.sections.session.id);
    fanout.failed = true;
    this.options.writeDesktop(redactedRouterError(fanout.desktopId, "post_start_failure"));
    if (unsafe) this.postStartFailure("post_start_failure");
  }

  private discardFanoutIssued(key: string): void {
    for (const [internalId, issued] of this.issued) {
      if (issued.fanoutKey !== key) continue;
      this.issued.delete(internalId);
      this.correlations.consume(internalId, "client_to_child", issued.child.opaqueAccountId);
      this.rememberExpiredFanoutReply(internalId);
    }
  }

  private startFanoutTimeout(key: string, fanout: Fanout): void {
    const timeout = this.options.fanoutTimeoutMs ?? FANOUT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("invalid account-router fanout timeout");
    fanout.timeout = setTimeout(() => {
      if (this.fanouts.get(key) !== fanout) return;
      this.fanouts.delete(key);
      fanout.timeout = undefined;
      for (const [internalId, issued] of this.issued) {
        if (issued.fanoutKey !== key) continue;
        this.issued.delete(internalId);
        this.correlations.consume(internalId, "client_to_child", issued.child.opaqueAccountId);
        this.rememberExpiredFanoutReply(internalId);
      }
      this.failFanout(fanout, undefined);
    }, timeout);
    fanout.timeout.unref();
  }

  private rememberExpiredFanoutReply(internalId: string): void {
    this.expiredFanoutReplyIds.add(internalId);
    while (this.expiredFanoutReplyIds.size > 64) this.expiredFanoutReplyIds.delete(this.expiredFanoutReplyIds.values().next().value!);
  }

  private childForRoute(route: ClientRoute, params: unknown): RouterChild | null {
    const threadId = threadIdFrom(params);
    if (route === "persisted_thread_owner" && !threadId) return null;
    if (threadId && (route === "persisted_thread_owner" || route === "thread_owner_if_present_else_primary" || route === "primary_if_no_thread_then_revalidate_capabilities")) {
      const owner = this.ledger.ownerFor(threadId);
      return owner ? this.children.get(owner) ?? null : null;
    }
    return this.children.get(this.options.config.primaryOpaqueAccountId) ?? null;
  }

  private dispatchToChild(
    request: JsonRpcRequest,
    child: RouterChild,
    extra: Omit<Partial<IssuedRequest>, "internalId" | "desktopId" | "child" | "method"> & { scope?: string; suppressDesktopError?: boolean } = {},
  ): IssuedRequest | null {
    if (!extra.quotaProbe && !extra.fanoutKey && this.activeDirectRequestCount() >= MAX_ACTIVE_DIRECT_REQUESTS) {
      if (!extra.suppressDesktopError) this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
      return null;
    }
    let correlation;
    try {
      correlation = this.correlations.create("client_to_child", child.opaqueAccountId, request.id, request.method, extra.scope);
    } catch {
      if (!extra.quotaProbe && !extra.suppressDesktopError) this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
      return null;
    }
    const issued: IssuedRequest = {
      internalId: correlation.internalId,
      desktopId: request.id,
      child,
      method: request.method,
      reservationId: extra.reservationId,
      pendingOwnerKey: extra.pendingOwnerKey,
      fanoutKey: extra.fanoutKey,
      initialization: extra.initialization,
      quotaProbe: extra.quotaProbe,
      sourceThreadId: request.method === "review/start" || request.method === "thread/fork" ? threadIdFrom(request.params) ?? undefined : undefined,
    };
    this.issued.set(correlation.internalId, issued);
    try {
      child.send({ ...request, id: correlation.internalId });
      this.correlations.mark(correlation.internalId, "written");
      if (!extra.quotaProbe && !extra.fanoutKey && this.issued.has(correlation.internalId)) this.startDesktopRequestTimeout(issued);
      return issued;
    } catch (error) {
      this.issued.delete(correlation.internalId);
      if (error instanceof RouterPreDispatchError) {
        this.correlations.consume(correlation.internalId, "client_to_child", child.opaqueAccountId);
        throw error;
      }
      if (extra.quotaProbe) this.correlations.consume(correlation.internalId, "client_to_child", child.opaqueAccountId);
      else this.correlations.mark(correlation.internalId, "acknowledged");
      if (issued.reservationId) this.ledger.strandAmbiguous(issued.reservationId);
      throw error;
    }
  }

  private handleChildMessage(childId: OpaqueAccountId, message: JsonRpcMessage): void {
    this.correlations.acknowledgeChild(childId);
    if (isResponse(message)) {
      this.handleChildResponse(childId, message);
      return;
    }
    if (isRequest(message)) {
      this.handleChildRequest(childId, message);
      return;
    }
    this.handleChildNotification(childId, message);
  }

  private handleChildResponse(childId: OpaqueAccountId, response: JsonRpcResponse): void {
    const correlation = this.correlations.consume(response.id, "client_to_child", childId);
    const issued = typeof response.id === "string" ? this.issued.get(response.id) : undefined;
    if (typeof response.id === "string") {
      this.issued.delete(response.id);
      this.clearDesktopRequestTimeout(response.id);
    }
    if (!correlation || !issued) {
      if (typeof response.id === "string" && this.expiredQuotaProbeIds.delete(response.id)) return;
      if (typeof response.id === "string" && this.expiredFanoutReplyIds.delete(response.id)) return;
      if (typeof response.id === "string" && this.expiredDesktopRequestIds.delete(response.id)) return;
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
      this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
      return;
    }
    const threadId = threadIdFrom(response.result);
    if (issued.pendingOwnerKey && !threadId) {
      this.resolveTerminalNewThreadError(issued);
      this.postStartFailure("post_start_failure");
      this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
      return;
    }
    if (issued.method === "thread/fork" && (!threadId || !issued.sourceThreadId)) {
      this.postStartFailure("post_start_failure");
      this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
      return;
    }
    if (issued.method === "review/start" && !this.validateReviewDelivery(issued, response.result)) {
      this.postStartFailure("post_start_failure");
      this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
      return;
    }
    let bufferedStarted: JsonRpcMessage | null = null;
    if (issued.pendingOwnerKey && threadId) {
      try {
        const existingOwner = this.ledger.ownerFor(threadId);
        if (existingOwner === null) this.ledger.bindThread(threadId, childId, issued.pendingOwnerKey);
        else if (existingOwner !== childId) throw new Error("thread owner collision");
        if (issued.reservationId) this.pendingReservationsByThread.set(threadId, issued.reservationId);
        bufferedStarted = this.takeBufferedStartedThread(threadId, childId);
      } catch {
        this.postStartFailure("post_start_failure");
        this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
        return;
      }
    }
    if (issued.method === "review/start") {
      const reviewThreadId = reviewThreadIdFrom(response.result);
      if (reviewThreadId && reviewThreadId !== issued.sourceThreadId) {
        try {
          this.ledger.bindKnownThread(reviewThreadId, childId);
          bufferedStarted = this.takeBufferedStartedThread(reviewThreadId, childId) ?? bufferedStarted;
        } catch {
          this.postStartFailure("post_start_failure");
          this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
          return;
        }
      }
    }
    if (["thread/fork", "thread/resume", "thread/unarchive"].includes(issued.method) && threadId) {
      try { this.ledger.bindKnownThread(threadId, childId); } catch {
        this.postStartFailure("post_start_failure");
        this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
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

  private resolveTerminalNewThreadError(issued: IssuedRequest): void {
    if (!issued.pendingOwnerKey || !issued.reservationId) return;
    const state = this.options.store.snapshot();
    // If a thread/started notification already bound this reservation, delivery
    // is no longer a no-thread error and ownership must remain durable.
    if ([...this.pendingReservationsByThread.values()].includes(issued.reservationId)) return;
    if (state.pendingThreadOwners[issued.pendingOwnerKey] === issued.child.opaqueAccountId) {
      this.ledger.releasePreDispatch(issued.reservationId);
      this.ledger.clearPendingOwner(issued.pendingOwnerKey, issued.child.opaqueAccountId);
    }
  }

  private bufferOrBindStartedThread(threadId: string, childId: OpaqueAccountId, notification: JsonRpcMessage): "bound" | "buffered" | "rejected" {
    const existing = this.ledger.ownerFor(threadId);
    if (existing) return existing === childId ? "bound" : "rejected";
    const anchors = causalThreadAnchors(notification);
    if (anchors === null) return "rejected";
    if (anchors.length > 0) {
      if (anchors.some((anchor) => this.ledger.ownerFor(anchor) !== childId)) return "rejected";
      try {
        this.ledger.bindKnownThread(threadId, childId);
        return "bound";
      } catch {
        return "rejected";
      }
    }
    const canResolveFromResponse = [...this.issued.values()].some((issued) => issued.child.opaqueAccountId === childId
      && (issued.pendingOwnerKey !== undefined || issued.method === "review/start" || issued.method === "thread/fork"));
    if (!canResolveFromResponse || this.bufferedStartedThreads.has(threadId)) return "rejected";
    const timer = setTimeout(() => {
      const pending = this.bufferedStartedThreads.get(threadId);
      if (!pending || pending.childId !== childId) return;
      this.bufferedStartedThreads.delete(threadId);
      this.postStartFailure("post_start_failure");
    }, FANOUT_TIMEOUT_MS);
    timer.unref();
    this.bufferedStartedThreads.set(threadId, { childId, notification, timer });
    return "buffered";
  }

  private takeBufferedStartedThread(threadId: string, childId: OpaqueAccountId): JsonRpcMessage | null {
    const pending = this.bufferedStartedThreads.get(threadId);
    if (!pending || pending.childId !== childId) return null;
    clearTimeout(pending.timer);
    this.bufferedStartedThreads.delete(threadId);
    return pending.notification;
  }

  /** A review may remain on its source thread or return one new detached id. */
  private validateReviewDelivery(issued: IssuedRequest, result: unknown): boolean {
    if (!issued.sourceThreadId || !isPlainRecord(result)) return false;
    if (!Object.prototype.hasOwnProperty.call(result, "reviewThreadId")) return true;
    const reviewThreadId = reviewThreadIdFrom(result);
    return reviewThreadId !== null;
  }

  private recordFanoutResponse(issued: IssuedRequest, response: JsonRpcResponse): void {
    const fanout = issued.fanoutKey ? this.fanouts.get(issued.fanoutKey) : undefined;
    if (!fanout) {
      this.protocolDrift();
      return;
    }
    fanout.responses.push({ childId: issued.child.opaqueAccountId, response });
    if (response.error) fanout.failed = true;
    if (fanout.responses.length < fanout.expected) return;
    this.completeFanout(issued.fanoutKey!, fanout);
  }

  private completeFanout(key: string, fanout: Fanout): void {
    if (this.fanouts.get(key) !== fanout) return;
    this.fanouts.delete(key);
    if (fanout.timeout) clearTimeout(fanout.timeout);
    fanout.timeout = undefined;
    if (fanout.failed) {
      this.options.writeDesktop(redactedRouterError(fanout.desktopId, "post_start_failure"));
      return;
    }
    if (fanout.route === "fanout_initialize_intersection") {
      const initialized = this.options.config.accounts.filter((account) => account.included).map((account) => {
        const response = fanout.responses.find((item) => item.childId === account.opaqueAccountId)?.response;
        return response ? parseInitializeResult(response.result, account.opaqueAccountId) : null;
      });
      if (initialized.some((result) => result === null) || !initializeResultsCompatible(initialized as InitializeResult[])) {
        this.options.writeDesktop(redactedRouterError(fanout.desktopId, "capability_mismatch"));
        this.postStartFailure("post_start_failure");
        return;
      }
      for (const child of this.children.values()) {
        child.markInitialized?.();
        if (!isQuotaAwareRouterConfig(this.options.config)) this.ledger.setEligibility(child.opaqueAccountId, "eligible");
      }
      this.initialized = true;
      if (isQuotaAwareRouterConfig(this.options.config)) this.refreshAllQuota();
      // Child responses may arrive in either order. The configured primary is
      // the only isolated-home response the desktop is allowed to observe.
      const primary = fanout.responses.find((item) => item.childId === this.options.config.primaryOpaqueAccountId)?.response;
      if (!primary) {
        this.options.writeDesktop(redactedRouterError(fanout.desktopId, "post_start_failure"));
        this.postStartFailure("post_start_failure");
        return;
      }
      this.options.writeDesktop({ ...primary, id: fanout.desktopId });
      return;
    }
    if (fanout.route === "fanout_feature_enablement") {
      const primary = fanout.responses.find((item) => item.childId === this.options.config.primaryOpaqueAccountId)?.response;
      if (!primary) {
        this.options.writeDesktop(redactedRouterError(fanout.desktopId, "post_start_failure"));
        return;
      }
      this.options.writeDesktop({ ...primary, id: fanout.desktopId });
      return;
    }
    if (fanout.sections) {
      const pages: Array<{ page: SectionPage; owner: OpaqueAccountId }> = [];
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
      const pages: Array<{ page: AggregatePage; owner: OpaqueAccountId }> = [];
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

  private handleChildRequest(childId: OpaqueAccountId, request: JsonRpcRequest): void {
    if (!isKnownServerRequest(request.method)) {
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
        try { this.children.get(childId)?.send(redactedRouterError(request.id, "unknown_thread_owner")); } catch { /* shutting down */ }
        this.protocolDrift();
        return;
      }
    }
    if (request.method === "account/chatgptAuthTokens/refresh") {
      if (this.refreshInFlight.has(childId)) {
        this.ledger.setEligibility(childId, "reauth_required");
        this.children.get(childId)?.send(redactedRouterError(request.id, "invalid_correlation"));
        return;
      }
    }
    const childKey = serverRequestChildKey(childId, request.id);
    if (this.serverRequestsByChild.has(childKey) || this.serverRequestTombstonesByChild.has(childKey)) {
      this.children.get(childId)?.send(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    let correlation;
    try {
      // Child-local request ids are not globally unique: scope their durable
      // correlation by emitting child before constructing the desktop id.
      correlation = this.correlations.create("child_to_client", childId, request.id, request.method, `server:${childId}`);
    } catch {
      this.ledger.setEligibility(childId, "reauth_required");
      this.children.get(childId)?.send(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    if (this.serverRequestsByChild.size >= MAX_ACTIVE_SERVER_REQUESTS) {
      this.correlations.consume(correlation.internalId, "child_to_client", childId);
      this.children.get(childId)?.send(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    const timeout = this.serverRequestTimeout(request);
    const lifecycle: ServerRequestLifecycle = {
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
    if (request.method === "account/chatgptAuthTokens/refresh") this.refreshInFlight.set(childId, correlation.internalId);
    this.options.writeDesktop({ ...request, id: correlation.internalId });
  }

  private routeDesktopResponse(response: JsonRpcResponse): void {
    const correlation = this.correlations.get(response.id);
    if (!correlation || correlation.direction !== "child_to_client") {
      if (typeof response.id === "string" && this.serverRequestTombstonesByDesktop.has(response.id)) return;
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
        child.send(redactedRouterError(lifecycle.childRequestId, "invalid_correlation"));
      } catch {
        this.postStartFailure("post_start_failure");
      }
      return;
    }
    lifecycle.responseForwarded = true;
    this.correlations.mark(lifecycle.correlationId, "acknowledged");
    try {
      child.send({ ...response, id: lifecycle.childRequestId });
    } catch {
      this.postStartFailure("post_start_failure");
    }
  }

  /**
   * The child resolves with its local request id after the desktop has only
   * ever seen the mux id. Preserve the mapping until this terminal notice,
   * rewrite only that id, then retain a bounded tombstone for late replies.
   */
  private resolveServerRequestNotification(childId: OpaqueAccountId, notification: JsonRpcMessage): boolean {
    if (!isNotification(notification) || !isPlainRecord(notification.params) || !isJsonRpcId(notification.params.requestId)) return false;
    const childRequestId = notification.params.requestId;
    const childKey = serverRequestChildKey(childId, childRequestId);
    const lifecycle = this.serverRequestsByChild.get(childKey);
    const tombstone = lifecycle ? null : this.serverRequestTombstonesByChild.get(childKey) ?? null;
    if (!lifecycle && !tombstone) return false;
    if (tombstone?.resolved) return true;
    const desktopRequestId = lifecycle?.desktopRequestId ?? tombstone!.desktopRequestId;
    if (lifecycle) {
      this.clearTimer(lifecycle.timer);
      this.serverRequestsByChild.delete(childKey);
      this.serverRequestsByDesktop.delete(lifecycle.desktopRequestId);
      this.correlations.consume(lifecycle.correlationId, "child_to_client", childId);
      if (lifecycle.method === "account/chatgptAuthTokens/refresh" && this.refreshInFlight.get(childId) === lifecycle.desktopRequestId) {
        this.refreshInFlight.delete(childId);
      }
    }
    const nextTombstone: ServerRequestTombstone = {
      childId, childRequestId, desktopRequestId, method: lifecycle?.method ?? tombstone!.method, resolved: true,
    };
    this.rememberServerRequestTombstone(nextTombstone);
    this.options.writeDesktop({ ...notification, params: { ...notification.params, requestId: desktopRequestId } });
    return true;
  }

  private expireServerRequest(childKey: string, desktopRequestId: string): void {
    const lifecycle = this.serverRequestsByChild.get(childKey);
    if (!lifecycle || lifecycle.desktopRequestId !== desktopRequestId) return;
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
    try { this.children.get(lifecycle.childId)?.send(redactedRouterError(lifecycle.childRequestId, "post_start_failure")); } catch { this.postStartFailure("post_start_failure"); }
  }

  private rememberServerRequestTombstone(tombstone: ServerRequestTombstone): void {
    const childKey = serverRequestChildKey(tombstone.childId, tombstone.childRequestId);
    this.serverRequestTombstonesByChild.set(childKey, tombstone);
    this.serverRequestTombstonesByDesktop.set(tombstone.desktopRequestId, tombstone);
    while (this.serverRequestTombstonesByChild.size > 64) {
      const [expiredKey, expired] = this.serverRequestTombstonesByChild.entries().next().value! as [string, ServerRequestTombstone];
      this.serverRequestTombstonesByChild.delete(expiredKey);
      this.serverRequestTombstonesByDesktop.delete(expired.desktopRequestId);
    }
  }

  private serverRequestTimeout(request: JsonRpcRequest): number {
    if (request.method === "account/chatgptAuthTokens/refresh") {
      const configured = this.options.serverRequestTimeoutMs ?? 0;
      return Math.min(Math.max(NETWORK_SERVER_REQUEST_MIN_MS, configured), NETWORK_SERVER_REQUEST_MAX_MS);
    }
    if (INTERACTIVE_SERVER_REQUEST_METHODS.has(request.method)) {
      const requestedAutoResolution = autoResolutionMs(request.params);
      const configured = this.options.serverRequestTimeoutMs ?? 0;
      const candidate = Math.max(
        INTERACTIVE_SERVER_REQUEST_MIN_MS,
        configured,
        requestedAutoResolution === null ? 0 : requestedAutoResolution + INTERACTIVE_SERVER_REQUEST_SAFETY_MARGIN_MS,
      );
      return Math.min(candidate, INTERACTIVE_SERVER_REQUEST_MAX_MS);
    }
    const timeout = this.options.serverRequestTimeoutMs ?? FANOUT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("invalid account-router immediate server-request timeout");
    return timeout;
  }

  private handleChildNotification(childId: OpaqueAccountId, notification: JsonRpcMessage): void {
    if (!isNotification(notification)) return;
    if (notification.method === "serverRequest/resolved") {
      if (!this.resolveServerRequestNotification(childId, notification)) this.protocolDrift();
      return;
    }
    const route = classifyServerNotification(notification.method, notification.params);
    if (route === "unknown") {
      this.protocolDrift();
      return;
    }
    if (isQuotaAwareRouterConfig(this.options.config) && notification.method === "account/rateLimits/updated") this.refreshQuotaFor(childId);
    const threadId = threadIdFrom(notification.params);
    if (route === "verify_persisted_owner_then_forward") {
      const knownOwner = threadId ? this.ledger.ownerFor(threadId) : null;
      const observedStart = notification.method === "thread/started" && threadId && knownOwner === null
        ? this.bufferOrBindStartedThread(threadId, childId, notification) : null;
      if (observedStart === "buffered") return;
      if (!threadId || observedStart === "rejected" || (observedStart !== "bound" && this.ledger.ownerFor(threadId) !== childId)) {
        this.protocolDrift();
        return;
      }
      this.recordTokenUsage(threadId, notification);
      this.reconcileTerminal(threadId, notification, childId);
      if (notification.method === "thread/closed" || notification.method === "thread/deleted") this.clearTokenUsageForThread(threadId);
      const desktopNotification = this.rewriteChildSections(notification, childId);
      if (!desktopNotification) {
        this.protocolDrift();
        return;
      }
      this.options.writeDesktop(desktopNotification);
      return;
    }
    if (route === "ingest_per_home_primary_forward_only_redacted_control_projection") {
      if (childId === this.options.config.primaryOpaqueAccountId) this.options.writeDesktop(notification);
      return;
    }
    if (childId === this.options.config.primaryOpaqueAccountId) this.options.writeDesktop(notification);
  }

  private recordTokenUsage(threadId: string, notification: JsonRpcMessage): void {
    if (!isNotification(notification) || notification.method !== "thread/tokenUsage/updated" || !isPlainRecord(notification.params)) return;
    const usage = usageFrom(notification.params.tokenUsage);
    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : "";
    if (!usage || !turnId) return;
    this.tokenUsage.set(`${threadId}:${turnId}`, usage);
    while (this.tokenUsage.size > 128) this.tokenUsage.delete(this.tokenUsage.keys().next().value!);
  }

  private reconcileTerminal(threadId: string, notification: JsonRpcMessage, childId: OpaqueAccountId): void {
    if (!isNotification(notification) || notification.method !== "turn/completed" || !isPlainRecord(notification.params)) return;
    if (isQuotaAwareRouterConfig(this.options.config)) this.refreshQuotaFor(childId);
    const turnId = isPlainRecord(notification.params.turn) && typeof notification.params.turn.id === "string" ? notification.params.turn.id : "";
    const recordedUsage = turnId ? this.tokenUsage.get(`${threadId}:${turnId}`) ?? null : null;
    // Usage is diagnostic input for exactly one terminal turn. Delete it
    // before checking for the original reservation so ordinary follow-ups
    // cannot grow an owner-private map indefinitely.
    if (turnId) this.tokenUsage.delete(`${threadId}:${turnId}`);
    const reservationId = this.pendingReservationsByThread.get(threadId);
    if (!reservationId) return;
    const usage = recordedUsage ?? (isPlainRecord(notification.params.turn) ? usageFrom(notification.params.turn.tokenUsage) : null);
    this.ledger.reconcile(reservationId, usage, modelFrom(notification.params));
    this.pendingReservationsByThread.delete(threadId);
    if (!usage) this.precisionEstimated = true;
  }

  private clearTokenUsageForThread(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.tokenUsage.keys()) if (key.startsWith(prefix)) this.tokenUsage.delete(key);
  }

  /** Issue one bounded pair of official app-server reads per enrolled child. */
  private refreshAllQuota(): void {
    if (!isQuotaAwareRouterConfig(this.options.config)) return;
    for (const account of this.options.config.accounts) this.refreshQuotaFor(account.opaqueAccountId);
  }

  private refreshQuotaFor(account: OpaqueAccountId): void {
    if (!isQuotaAwareRouterConfig(this.options.config) || !this.initialized || !this.accepting) return;
    const child = this.children.get(account);
    if (!child) {
      this.ledger.setEligibility(account, "unhealthy");
      return;
    }
    const inFlight = this.quotaProbesInFlight.get(account) ?? new Set<"account" | "rate_limits">();
    this.quotaProbesInFlight.set(account, inFlight);
    this.ledger.setEligibility(account, "validating");
    this.issueQuotaProbe(child, "account", inFlight);
    this.issueQuotaProbe(child, "rate_limits", inFlight);
  }

  private issueQuotaProbe(child: RouterChild, kind: "account" | "rate_limits", inFlight: Set<"account" | "rate_limits">): void {
    if (inFlight.has(kind)) return;
    // Set this before child.send. A test double and a future in-process child
    // may synchronously answer while dispatchToChild is still on its stack.
    inFlight.add(kind);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `quota:${child.opaqueAccountId}:${++this.quotaProbeNonce}`,
      method: kind === "account" ? "account/read" : "account/rateLimits/read",
      params: {},
    };
    try {
      const issued = this.dispatchToChild(request, child, { quotaProbe: kind, scope: `quota-${kind}` });
      if (issued) {
        if (this.issued.has(issued.internalId)) this.startQuotaProbeTimeout(issued);
        return;
      }
    } catch {
      // The provider error stays private. The resulting missing reading makes
      // the fixed pool ineligible; no alternate account is tried.
    }
    this.recordQuotaProbeFailure(child.opaqueAccountId, kind);
  }

  private recordQuotaProbe(childId: OpaqueAccountId, kind: "account" | "rate_limits", response: JsonRpcResponse): void {
    const observation = this.quota.get(childId) ?? emptyQuotaObservation();
    const now = this.now();
    if (kind === "account") {
      const parsed = response.error ? null : parseAccountRead(response.result, now);
      if (parsed) {
        observation.health = parsed.health;
        observation.plan = parsed.plan;
        observation.observedAt = parsed.observedAt;
      } else {
        observation.health = "reauth_required";
        observation.plan = null;
        observation.observedAt = null;
      }
    } else {
      const parsed = response.error ? null : parseRateLimitsRead(response.result, now);
      if (parsed) {
        observation.weeklyRemainingPercent = parsed.weeklyRemainingPercent;
        observation.weeklyResetAt = parsed.weeklyResetAt;
        observation.shortWindowPressure = parsed.shortWindowPressure;
        observation.shortWindowResetAt = parsed.shortWindowResetAt ?? null;
        observation.rateLimitReached = parsed.rateLimitReached ?? false;
        observation.resetCredits = parsed.resetCredits ?? null;
        observation.observedAt = observation.observedAt === null ? null : Math.min(observation.observedAt, parsed.observedAt ?? now);
      } else {
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
    if (inFlight?.size === 0) this.quotaProbesInFlight.delete(childId);
    this.updateQuotaEligibility(childId);
    this.drainQueuedNewThread();
  }

  private recordQuotaProbeFailure(childId: OpaqueAccountId, kind: "account" | "rate_limits"): void {
    const observation = this.quota.get(childId) ?? emptyQuotaObservation();
    if (kind === "account") {
      observation.health = "unhealthy";
      observation.plan = null;
      observation.observedAt = null;
    } else {
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
    if (inFlight?.size === 0) this.quotaProbesInFlight.delete(childId);
    this.updateQuotaEligibility(childId);
    this.drainQueuedNewThread();
  }

  private startQuotaProbeTimeout(issued: IssuedRequest): void {
    const timeout = this.options.quotaProbeTimeoutMs ?? QUOTA_PROBE_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("invalid account-router quota probe timeout");
    const timer = setTimeout(() => {
      this.quotaProbeTimers.delete(issued.internalId);
      const live = this.issued.get(issued.internalId);
      if (!live || !live.quotaProbe) return;
      this.issued.delete(issued.internalId);
      this.correlations.consume(issued.internalId, "client_to_child", live.child.opaqueAccountId);
      this.rememberExpiredQuotaProbe(issued.internalId);
      this.recordQuotaProbeFailure(live.child.opaqueAccountId, live.quotaProbe);
    }, timeout);
    timer.unref();
    this.quotaProbeTimers.set(issued.internalId, timer);
  }

  private clearQuotaProbeTimeout(internalId: string): void {
    const timer = this.quotaProbeTimers.get(internalId);
    if (timer) clearTimeout(timer);
    this.quotaProbeTimers.delete(internalId);
  }

  /**
   * A written desktop request may be a long history read, tool call, or
   * provider-backed operation. The mux has no authoritative per-method time
   * budget, so its bounded direct-correlation pool—not a fabricated deadline—
   * is the liveness guard. Terminal reply, child failure, or shutdown cleans it.
   */
  private startDesktopRequestTimeout(_issued: IssuedRequest): void {}

  private clearDesktopRequestTimeout(internalId: string): void {
    const timer = this.desktopRequestTimers.get(internalId);
    if (timer) this.clearTimer(timer);
    this.desktopRequestTimers.delete(internalId);
  }

  private rememberExpiredDesktopRequest(internalId: string): void {
    this.expiredDesktopRequestIds.add(internalId);
    while (this.expiredDesktopRequestIds.size > 64) this.expiredDesktopRequestIds.delete(this.expiredDesktopRequestIds.values().next().value!);
  }

  private rememberExpiredQuotaProbe(internalId: string): void {
    this.expiredQuotaProbeIds.add(internalId);
    while (this.expiredQuotaProbeIds.size > 64) this.expiredQuotaProbeIds.delete(this.expiredQuotaProbeIds.values().next().value!);
  }

  private updateQuotaEligibility(account: OpaqueAccountId): void {
    const observation = this.quota.get(account) ?? emptyQuotaObservation();
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
    if (observation.health !== "authenticated" || quotaFreshness(observation, this.now()) !== "fresh") {
      // Manual's primary-only routing needs account health, not a quota
      // score. A missing/old rate-limit reply therefore remains honestly
      // nullable in status without silently selecting the secondary account.
      if (isQuotaAwareRouterConfig(this.options.config) && this.options.config.mode === "manual" && observation.health === "authenticated") {
        this.ledger.setEligibility(account, "eligible");
      } else {
        this.ledger.setEligibility(account, "unhealthy");
      }
      return;
    }
    if (isQuotaAwareRouterConfig(this.options.config) && this.options.config.mode === "manual") {
      this.ledger.setEligibility(account, "eligible");
      return;
    }
    if (!accountObservationEligible(observation, this.now())) {
      this.ledger.setEligibility(account, "quota_depleted");
      return;
    }
    this.ledger.setEligibility(account, "eligible");
  }

  /** Queue only one never-yet-delivered start while stale capacity is refreshed. */
  private queueNewThreadForQuotaRefresh(request: JsonRpcRequest): void {
    if (this.queuedNewThread) {
      this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    this.queuedNewThread = { request };
    const probeTimeout = this.options.quotaProbeTimeoutMs ?? QUOTA_PROBE_TIMEOUT_MS;
    const timeout = this.options.queuedStartTimeoutMs ?? Math.min(30_000, probeTimeout + 100);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("invalid account-router queued start timeout");
    this.queuedNewThreadTimer = setTimeout(() => {
      const queued = this.queuedNewThread;
      this.clearQueuedNewThread();
      if (queued && this.accepting) this.options.writeDesktop(redactedRouterError(queued.request.id, "pool_depleted"));
    }, timeout);
    this.queuedNewThreadTimer.unref();
    this.refreshAllQuota();
  }

  private drainQueuedNewThread(): void {
    if (!this.queuedNewThread || this.quotaProbesInFlight.size > 0) return;
    const queued = this.queuedNewThread;
    this.clearQueuedNewThread();
    if (!this.accepting) return;
    const selected = this.ledger.selectQuotaAware(this.quota);
    if (!selected) {
      this.options.writeDesktop(redactedRouterError(queued.request.id, "pool_depleted"));
      return;
    }
    this.dispatchSelectedNewThread(queued.request, selected.opaqueAccountId);
  }

  private clearQueuedNewThread(): void {
    if (this.queuedNewThreadTimer) clearTimeout(this.queuedNewThreadTimer);
    this.queuedNewThreadTimer = null;
    this.queuedNewThread = null;
  }

  private quotaNeedsRefresh(): boolean {
    if (!isQuotaAwareRouterConfig(this.options.config)) return false;
    return this.options.config.accounts.some((account) => account.included && quotaFreshness(
      this.quota.get(account.opaqueAccountId) ?? emptyQuotaObservation(), this.now(),
    ) !== "fresh");
  }

  private quotaAwareStatus(): RedactedControlStatusV2 | RedactedControlStatusV3 {
    const config = this.options.config;
    if (!isQuotaAwareRouterConfig(config)) throw new Error("quota status requires a quota-aware router config");
    const now = this.now();
    if (this.initialized && this.accepting) {
      for (const account of config.accounts) {
        if (!account.included) continue;
        const observation = this.quota.get(account.opaqueAccountId) ?? emptyQuotaObservation();
        if (quotaFreshness(observation, now) !== "fresh") this.refreshQuotaFor(account.opaqueAccountId);
      }
    }
    const state = this.options.store.snapshot();
    const accounts = config.accounts.map((account) => this.quotaStatusAccount(account, state, now));
    const pending = this.pendingQuotaIntent(config);
    const enabledAccounts = accounts.filter((account) => account.eligibility !== "disabled");
    const allFresh = enabledAccounts.length > 0
      && enabledAccounts.every((account) => account.weekly.freshness === "fresh" && account.weekly.remainingPercent !== null);
    const protocolState: RedactedControlStatusV2["protocolState"] =
      state.stagedDisable?.reasonCode === "protocol_drift" ? "drifted" : "supported";
    const common = {
      active: quotaIntent(config),
      pending,
      protocolState,
      poolRemainingPercent: allFresh
        ? enabledAccounts.reduce((total, account) => total + account.weekly.remainingPercent!, 0)
        : null,
      restartRequired: state.stagedDisable !== null || pending !== null,
      degradedReason: quotaDegradedReason(state.stagedDisable?.reasonCode, accounts),
    };
    if (config.schemaVersion === 2) {
      return { ...common, schemaVersion: 2, accounts: [accounts[0], accounts[1]] };
    }
    return { ...common, schemaVersion: 3, accounts };
  }

  private quotaStatusAccount(
    account: (RouterConfigV2 | RouterConfigV3)["accounts"][number],
    state: ReturnType<RouterStateStore["snapshot"]>,
    now: number,
  ): RedactedControlAccountV2 {
    const observation = this.quota.get(account.opaqueAccountId) ?? emptyQuotaObservation();
    const freshness = quotaFreshness(observation, now);
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

  private pendingQuotaIntent(active: RouterConfigV2 | RouterConfigV3): RedactedControlIntentV2 | null {
    try {
      const candidate = this.options.readPendingConfig?.() ?? null;
      if (!candidate || !isQuotaAwareRouterConfig(candidate) || candidate.schemaVersion !== active.schemaVersion) return null;
      if (candidate.fingerprint === active.fingerprint && candidate.generation === active.generation
        && candidate.mode === active.mode && candidate.policy === active.policy) return null;
      return quotaIntent(candidate);
    } catch {
      // A bad later disk config is not allowed to replace the active mux truth.
      return null;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private setTimer(callback: () => void, delay: number): RouterTimer {
    const timer = (this.options.setTimeout ?? setTimeout)(callback, delay);
    timer.unref?.();
    return timer;
  }

  private clearTimer(timer: RouterTimer): void {
    (this.options.clearTimeout ?? clearTimeout)(timer);
  }

  /** Long-lived direct work is bounded by correlation capacity, not time. */
  private activeDirectRequestCount(): number {
    let count = 0;
    for (const issued of this.issued.values()) {
      if (!issued.quotaProbe && !issued.fanoutKey) count += 1;
    }
    return count;
  }

  /**
   * There is no live atomic effective-capability oracle across two private
   * homes. A capability-changing write is therefore never dispatched under
   * balanced routing: make the restart requirement durable and stop safely.
   */
  private stageCapabilityRestartRequired(): void {
    this.options.store.update((state) => {
      state.stagedDisable = { reasonCode: "policy_stop", stagedAt: new Date().toISOString() };
      for (const account of this.options.config.accounts) state.accountEligibility[account.opaqueAccountId] = "protocol_blocked";
    });
    this.accepting = false;
    this.shutdown();
    this.signalFatal();
  }

  private protocolDrift(): void {
    this.options.store.update((state) => {
      state.stagedDisable = { reasonCode: "protocol_drift", stagedAt: new Date().toISOString() };
      for (const account of this.options.config.accounts) state.accountEligibility[account.opaqueAccountId] = "protocol_blocked";
    });
    this.accepting = false;
    this.shutdown();
    this.signalFatal();
  }

  private postStartFailure(reason: "post_start_failure" | "isolation_failure" | "startup_selfcheck_failed"): void {
    this.options.store.update((state) => {
      state.stagedDisable = { reasonCode: reason === "isolation_failure" ? "isolation_failure" : "post_start_failure", stagedAt: new Date().toISOString() };
      for (const account of this.options.config.accounts) state.accountEligibility[account.opaqueAccountId] = "unhealthy";
    });
    this.accepting = false;
    this.shutdown();
    this.signalFatal();
  }

  private signalFatal(): void {
    if (this.fatalSignalled) return;
    this.fatalSignalled = true;
    this.options.onFatal?.();
  }
}

function quotaIntent(config: RouterConfigV2 | RouterConfigV3): RedactedControlIntentV2 {
  return {
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    fingerprint: config.fingerprint,
  };
}

interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

function parseInitializeResult(value: unknown, account: OpaqueAccountId): InitializeResult | null {
  if (!isPlainRecord(value)) return null;
  const userAgent = value.userAgent;
  const codexHome = value.codexHome;
  const platformFamily = value.platformFamily;
  const platformOs = value.platformOs;
  if (typeof userAgent !== "string" || userAgent.length === 0 || userAgent.length > 1_024
    || typeof codexHome !== "string" || codexHome.length === 0 || codexHome.length > 1_024
    || typeof platformFamily !== "string" || platformFamily.length === 0 || platformFamily.length > 1_024
    || typeof platformOs !== "string" || platformOs.length === 0 || platformOs.length > 1_024) return null;
  // Each child must report the isolated home staged for exactly its opaque
  // account. This is checked privately and never added to control status.
  if (!codexHome.endsWith(`/accounts/${account}/codex-home`) || /[\u0000-\u001f\u007f]/.test(codexHome)) return null;
  return { userAgent, codexHome, platformFamily, platformOs };
}

function initializeResultsCompatible(results: readonly InitializeResult[]): boolean {
  if (results.length < 1) return false;
  const first = results[0];
  return results.every((result) => result.userAgent === first.userAgent
    && result.platformFamily === first.platformFamily
    && result.platformOs === first.platformOs)
    && new Set(results.map((result) => result.codexHome)).size === results.length;
}

function quotaDegradedReason(
  stagedReason: string | undefined,
  accounts: readonly RedactedControlAccountV2[],
): RedactedControlStatusV2["degradedReason"] {
  if (stagedReason === "protocol_drift") return "unsupported_protocol";
  if (stagedReason === "isolation_failure") return "capability_mismatch";
  if (stagedReason === "policy_stop") return "policy_stop";
  if (stagedReason === "post_start_failure") return "post_start_failure";
  if (accounts.some((account) => account.eligibility === "reauth_required")) return "account_unauthenticated";
  if (accounts.some((account) => account.eligibility === "disabled")) return "account_disabled";
  if (accounts.some((account) => account.weekly.freshness === "stale")) return "quota_stale";
  if (accounts.some((account) => account.weekly.freshness === "unknown")) return "quota_unknown";
  if (accounts.some((account) => account.eligibility === "quota_depleted")) return "quota_depleted";
  if (accounts.some((account) => account.eligibility === "unhealthy" || account.eligibility === "protocol_blocked")) return "account_unhealthy";
  return null;
}

function fanoutKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function mergeFanoutResults(responses: JsonRpcResponse[], secret: Buffer): unknown {
  const values = responses.map((response) => response.result);
  if (values.every(Array.isArray)) return values.flat() as unknown[];
  const items = values.flatMap((value) => isPlainRecord(value) && Array.isArray(value.items) ? value.items : []);
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
type AggregateSortKey = "created_at" | "updated_at" | "recency_at" | "section_position";

/** List and loaded/list have documented, but different, data envelopes. */
function parseAggregatePage(method: AggregateRequest["method"], value: unknown): AggregatePage | null {
  if (!isPlainRecord(value) || !Array.isArray(value.data)) return null;
  const nextCursor = safeChildCursor(value.nextCursor);
  const backwardsCursor = safeChildCursor(value.backwardsCursor);
  if (nextCursor === undefined || backwardsCursor === undefined || !aggregateEntriesValid(method, value.data)) return null;
  return { data: value.data, nextCursor, backwardsCursor };
}

function parseSectionPage(value: unknown): SectionPage | null {
  if (!isPlainRecord(value) || !Array.isArray(value.data)) return null;
  const nextCursor = safeChildCursor(value.nextCursor);
  if (nextCursor === undefined) return null;
  const data: Record<string, unknown>[] = [];
  for (const entry of value.data) {
    if (!isPlainRecord(entry) || !safeThreadId(entry.id)) return null;
    data.push(entry);
  }
  return { data, nextCursor };
}

function sectionFilterBinding(limit: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson({ limit: limit ?? null }), "utf8").digest("hex")}`;
}

function sectionBindingKey(childId: OpaqueAccountId, localId: string): string {
  return `${childId}\u0000${localId}`;
}

function validSectionRouterId(id: string, secret: Buffer): boolean {
  const match = /^ars1\.([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{32,})$/.exec(id);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(`section:v1:${match[1]}`, "utf8").digest("base64url");
  const actual = match[2];
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

function sectionRouterError(id: JsonRpcId, code: "sections_read_only" | "section_unsupported"): JsonRpcMessage {
  return {
    jsonrpc: "2.0", id,
    error: { code: -32080, message: "Account router request could not be completed", data: { code } },
  } as JsonRpcMessage;
}

function safeChildCursor(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length <= MAX_CHILD_CURSOR_LENGTH ? value : undefined;
}

function aggregateEntriesValid(method: AggregateRequest["method"], entries: readonly unknown[]): boolean {
  return entries.every((entry) => aggregateThreadId(method, entry) !== null);
}

function aggregateEntriesBytes(entries: readonly unknown[]): number {
  return entries.reduce<number>((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
}

function aggregateThreadId(method: AggregateRequest["method"], value: unknown): string | null {
  // `thread/loaded/list` is an id list, not a Thread object list. Treating
  // strings as unstructured entries previously exposed unbound thread ids.
  if (method === "thread/loaded/list") return safeThreadId(value);
  if (!isPlainRecord(value)) return null;
  if (method === "thread/search") {
    return isPlainRecord(value.thread) ? safeThreadId(value.thread.id) : null;
  }
  const direct = safeThreadId(value.id);
  if (direct) return direct;
  const nested = threadIdFrom(value);
  return safeThreadId(nested);
}

function safeThreadId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function serverRequestThreadId(params: unknown): string | null {
  if (!isPlainRecord(params)) return null;
  return safeThreadId(params.threadId) ?? safeThreadId(params.conversationId)
    ?? (isPlainRecord(params.thread) ? safeThreadId(params.thread.id) : null);
}

/** Interactive requests may declare a desktop-side automatic resolution. */
function autoResolutionMs(params: unknown): number | null {
  const candidate = isPlainRecord(params) ? params.autoResolutionMs : undefined;
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) return null;
  return candidate >= 0 && candidate <= INTERACTIVE_SERVER_REQUEST_MAX_MS
    ? candidate
    : null;
}

function reviewThreadIdFrom(value: unknown): string | null {
  return isPlainRecord(value) ? safeThreadId(value.reviewThreadId) : null;
}

function causalThreadAnchors(notification: JsonRpcMessage): string[] | null {
  if (!isNotification(notification) || !isPlainRecord(notification.params)) return null;
  const candidates: unknown[] = [notification.params.parentThreadId, notification.params.forkedFromId];
  const thread = notification.params.thread;
  if (isPlainRecord(thread)) candidates.push(thread.parentThreadId, thread.forkedFromId);
  const session = notification.params.session;
  if (isPlainRecord(session)) candidates.push(session.parentThreadId, session.threadId);
  const anchors: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const id = safeThreadId(candidate);
    if (!id) return null;
    anchors.push(id);
  }
  return [...new Set(anchors)];
}

function hasNonEmptyPath(params: unknown): boolean {
  return isPlainRecord(params) && typeof params.path === "string" && params.path.length > 0;
}

function hasSectionPositionSort(params: unknown): boolean {
  return isPlainRecord(params) && params.sortKey === "section_position";
}

function serverRequestChildKey(childId: OpaqueAccountId, requestId: JsonRpcId): string {
  return `${childId}\u0000${typeof requestId}\u0000${String(requestId)}`;
}

function rewriteAggregateCursor(request: JsonRpcRequest, cursor: string | null, aggregate: AggregatePageOptions): JsonRpcRequest {
  const params = isPlainRecord(request.params) ? { ...request.params } : {};
  if (aggregate.childLimit === null) {
    // The documented loaded-list null/omitted limit means no client limit. We
    // retain that shape, while the mux independently caps collected rows.
    if (params.limit === undefined) delete params.limit;
    else params.limit = null;
    delete params.sortKey;
    delete params.sortDirection;
  } else {
    params.limit = aggregate.childLimit;
    params.sortKey = aggregate.sortKey;
    params.sortDirection = aggregate.sortDirection;
  }
  if (cursor === null) delete params.cursor;
  else params.cursor = cursor;
  return { ...request, params };
}

function aggregateFilterBinding(
  method: AggregateRequest["method"],
  params: Record<string, unknown>,
  options = aggregatePageOptions(method, params),
): string {
  if (!options) return "invalid";
  const filtered: Record<string, unknown> = { ...params };
  if (options.childLimit === null) {
    delete filtered.limit;
    delete filtered.sortKey;
    delete filtered.sortDirection;
  } else {
    filtered.limit = options.childLimit;
    filtered.sortKey = options.sortKey;
    filtered.sortDirection = options.sortDirection;
  }
  delete filtered.cursor;
  return `sha256:${createHash("sha256").update(stableJson(filtered), "utf8").digest("hex")}`;
}

/**
 * A backwards cursor is valid only for the same filters with a literal asc/desc
 * inversion. All other fields (and forward cursors) remain exact-bound.
 */
function cursorMatchesAggregateRequest(
  payload: RouterCursorPayload,
  filterBinding: string,
  method: AggregateRequest["method"],
  params: Record<string, unknown>,
): boolean {
  if (payload.direction === "next") return payload.filterBinding === filterBinding;
  if (!isSortDirection(params.sortDirection)) return false;
  const reverse = { ...params, sortDirection: params.sortDirection === "asc" ? "desc" : "asc" };
  return payload.filterBinding === aggregateFilterBinding(method, reverse);
}

function isSortDirection(value: unknown): value is "asc" | "desc" {
  return value === "asc" || value === "desc";
}

function aggregatePageOptions(method: AggregateRequest["method"], params: Record<string, unknown>): AggregatePageOptions | null {
  if (method === "thread/loaded/list") {
    // This endpoint accepts only cursor and limit. No limit is a valid
    // official request, represented internally by a bounded 100-row page.
    if (Object.keys(params).some((key) => key !== "cursor" && key !== "limit")) return null;
    const requested = params.limit;
    if (requested !== undefined && requested !== null
      && (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1 || requested > MAX_AGGREGATE_PAGE_ROWS)) return null;
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
    || (sortKey === "section_position" && method !== "thread/list") || !isSortDirection(sortDirection)) return null;
  return { limit, childLimit: limit, sortKey, sortDirection };
}

interface AggregateSelectedEntry {
  owner: OpaqueAccountId;
  entry: unknown;
  configuredIndex: number;
}

function selectAggregateEntries(
  session: AggregateSession,
  aggregate: AggregateRequest,
  config: RouterConfig,
): AggregateSelectedEntry[] | null {
  const offsets = new Map<OpaqueAccountId, number>();
  const selected: AggregateSelectedEntry[] = [];
  try {
    for (let count = 0; count < aggregate.limit; count += 1) {
      const candidates: AggregateSelectedEntry[] = [];
      for (const [configuredIndex, account] of config.accounts.entries()) {
        const offset = offsets.get(account.opaqueAccountId) ?? 0;
        const entry = session.buffers.get(account.opaqueAccountId)?.[offset];
        if (entry !== undefined) candidates.push({ owner: account.opaqueAccountId, entry, configuredIndex });
      }
      if (candidates.length === 0) break;
      candidates.sort((left, right) => compareAggregateEntries(left, right, aggregate));
      const next = candidates[0];
      selected.push(next);
      offsets.set(next.owner, (offsets.get(next.owner) ?? 0) + 1);
    }
  } catch {
    return null;
  }
  return selected;
}

function compareAggregateEntries(left: AggregateSelectedEntry, right: AggregateSelectedEntry, aggregate: AggregateRequest): number {
  const leftValue = aggregateSortValue(left.entry, aggregate);
  const rightValue = aggregateSortValue(right.entry, aggregate);
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    const comparison = leftValue < rightValue ? -1 : 1;
    return aggregate.sortDirection === "asc" ? comparison : -comparison;
  }
  // Loaded-list is a string[] without a timestamp. Configured account order,
  // then stable child-page order, makes the bounded merge deterministic.
  const leftId = aggregateThreadId(aggregate.method, left.entry)!;
  const rightId = aggregateThreadId(aggregate.method, right.entry)!;
  if (leftId !== rightId) return leftId.localeCompare(rightId);
  return left.configuredIndex - right.configuredIndex;
}

function aggregateSortValue(entry: unknown, aggregate: AggregateRequest): number | string | null {
  if (aggregate.method === "thread/loaded/list" || aggregate.sortKey === null || !isPlainRecord(entry)) return null;
  const sortable = aggregate.method === "thread/search" ? entry.thread : entry;
  if (!isPlainRecord(sortable)) return null;
  const responseKey: Record<AggregateSortKey, "createdAt" | "updatedAt" | "recencyAt" | "sectionPosition"> = {
    created_at: "createdAt", updated_at: "updatedAt", recency_at: "recencyAt", section_position: "sectionPosition",
  };
  const raw = sortable[responseKey[aggregate.sortKey]];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const date = Date.parse(raw);
    return Number.isFinite(date) ? date : raw;
  }
  return null;
}

function aggregateSessionCursor(session: AggregateSession, direction: RouterCursorPayload["direction"], secret: Buffer): string | null {
  const cursors = direction === "next" ? session.nextCursors : session.backwardsCursors;
  const hasBufferedRows = [...session.buffers.values()].some((buffer) => buffer.length > 0);
  if ((direction === "next" && !hasBufferedRows && ![...cursors.values()].some((cursor) => cursor !== null))
    || (direction === "backwards" && ![...cursors.values()].some((cursor) => cursor !== null))) return null;
  const payload: RouterCursorPayload = {
    version: 2,
    method: session.method,
    filterBinding: session.filterBinding,
    direction,
    sessionId: session.id,
    sequence: session.sequence,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > MAX_ROUTER_CURSOR_BYTES) throw new Error("account-router cursor exceeds its bounded size");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `ar1.${encoded}.${signature}`;
}

function sectionSessionCursor(session: SectionSession, secret: Buffer): string | null {
  const cursors = session.nextCursors;
  const hasBufferedRows = [...session.buffers.values()].some((buffer) => buffer.length > 0);
  if (!hasBufferedRows && ![...cursors.values()].some((cursor) => cursor !== null)) return null;
  const payload: SectionCursorPayload = {
    version: 1, kind: "sections", sessionId: session.id, filterBinding: session.filterBinding, sequence: session.sequence,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `arsc1.${encoded}.${signature}`;
}

function parseSectionCursor(value: unknown, secret: Buffer): SectionCursorPayload | null {
  if (typeof value !== "string" || value.length > MAX_ROUTER_CURSOR_BYTES || !value.startsWith("arsc1.")) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  let payload: unknown;
  let actual: Buffer;
  const expected = createHmac("sha256", secret).update(parts[1]).digest();
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected) || !isPlainRecord(payload)
    || payload.version !== 1 || payload.kind !== "sections" || typeof payload.sessionId !== "string"
    || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.sessionId) || typeof payload.filterBinding !== "string"
    || !/^[a-z0-9:]{8,80}$/.test(payload.filterBinding)
    || typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return null;
  return payload as unknown as SectionCursorPayload;
}

function parseRouterCursor(value: unknown, secret: Buffer): RouterCursorPayload | null {
  if (typeof value !== "string" || value.length > MAX_ROUTER_CURSOR_BYTES || !value.startsWith("ar1.")) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  const expected = createHmac("sha256", secret).update(parts[1]).digest();
  let actual: Buffer;
  let payload: unknown;
  try {
    actual = Buffer.from(parts[2], "base64url");
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected) || !isPlainRecord(payload)) return null;
  if (payload.version !== 2 || (payload.method !== "thread/list" && payload.method !== "thread/search" && payload.method !== "thread/loaded/list")
    || typeof payload.filterBinding !== "string" || !/^[a-z0-9:]{8,80}$/.test(payload.filterBinding)
    || (payload.direction !== "next" && payload.direction !== "backwards")
    || typeof payload.sessionId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.sessionId)
    || typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) return null;
  return {
    version: 2,
    method: payload.method,
    filterBinding: payload.filterBinding,
    direction: payload.direction,
    sessionId: payload.sessionId,
    sequence: payload.sequence,
  };
}

function signedCursor(payload: Record<string, unknown>, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `ar1.${encoded}.${signature}`;
}

function refreshResponseMatches(result: unknown, account: OpaqueAccountId, secret: Buffer): boolean {
  if (!isPlainRecord(result) || typeof result.chatgptAccountId !== "string" || result.chatgptAccountId.length === 0) return false;
  const opaque = `ar_${createHmac("sha256", secret).update(`account-router:v1:${result.chatgptAccountId}`, "utf8").digest("base64url")}`;
  return opaque === account;
}

function usageFrom(value: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!isPlainRecord(value)) return null;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number"
    || !Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) return null;
  return { inputTokens, outputTokens };
}

function modelFrom(params: unknown): string {
  return isPlainRecord(params) && typeof params.model === "string" ? params.model : "default";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

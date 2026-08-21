import { createHmac, randomBytes } from "node:crypto";
import type { RouterConfig, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, OpaqueAccountId, RedactedControlStatus } from "./types";
import { isPlainRecord } from "./types";
import { AccountLedger, normalizedSpend } from "./ledger";
import { redactedRouterError } from "./redaction";
import {
  CorrelationTable,
  classifyClientMethod,
  classifyServerNotification,
  hasThreadId,
  intersectCapabilities,
  isKnownServerRequest,
  isNotification,
  isRequest,
  isResponse,
  parseJsonRpcLine,
  threadIdFrom,
  type ClientRoute,
} from "./protocol";
import type { RouterStateStore } from "./state-store";

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
}

interface Fanout {
  desktopId: JsonRpcId;
  expected: number;
  responses: JsonRpcResponse[];
  failed: boolean;
  route: ClientRoute;
}

export interface AccountRouterMuxOptions {
  config: RouterConfig;
  store: RouterStateStore;
  childFactory: RouterChildFactory;
  writeDesktop: (message: JsonRpcMessage) => void;
  controlSecret?: Buffer;
  now?: () => number;
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
  private readonly pendingReservationsByThread = new Map<string, string>();
  private readonly tokenUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
  private readonly refreshInFlight = new Set<OpaqueAccountId>();
  private readonly controlSecret: Buffer;
  private accepting = true;
  private started = false;
  private initialized = false;
  private precisionEstimated = false;
  private fatalSignalled = false;
  private shutdownSignalled = false;

  constructor(private readonly options: AccountRouterMuxOptions) {
    this.controlSecret = options.controlSecret ?? randomBytes(32);
    this.ledger = new AccountLedger(options.store, options.config, options.now);
    this.correlations = new CorrelationTable(options.store.snapshot().correlations, (records) => {
      options.store.update((state) => { state.correlations = records; });
    });
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
    if (route === "fanout_aggregate_read_with_router_cursor" || route === "fanout_aggregate_namespaced_sections") {
      this.dispatchFanout(request, route);
      return;
    }
    const child = this.childForRoute(route, request.params);
    if (!child) {
      this.options.writeDesktop(redactedRouterError(request.id, hasThreadId(request.params) ? "unknown_thread_owner" : "pool_depleted"));
      return;
    }
    if (route === "primary_only_then_invalidate_capability_fingerprints" || route === "primary_if_no_thread_then_revalidate_capabilities") {
      this.invalidateCapabilities();
    }
    this.dispatchToChild(request, child);
  }

  private initialize(request: JsonRpcRequest): void {
    if (this.initialized) {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_request"));
      return;
    }
    const key = fanoutKey(request.id);
    this.fanouts.set(key, { desktopId: request.id, expected: this.children.size, responses: [], failed: false, route: "fanout_initialize_intersection" });
    let scope = 0;
    for (const child of this.children.values()) {
      const issued = this.dispatchToChild(request, child, { fanoutKey: key, initialization: true, scope: `init-${scope++}` });
      if (!issued) return;
    }
  }

  private dispatchNewThread(request: JsonRpcRequest): void {
    const estimatedCost = this.ledger.estimateRequestCost(request.params, modelFrom(request.params));
    const first = this.ledger.select();
    if (!first) {
      this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    const attempts = [first.opaqueAccountId];
    for (const account of this.options.config.accounts) {
      if (account.opaqueAccountId !== first.opaqueAccountId && this.options.store.snapshot().accountEligibility[account.opaqueAccountId] === "eligible") attempts.push(account.opaqueAccountId);
    }
    for (const owner of attempts.slice(0, 2)) {
      const child = this.children.get(owner);
      if (!child) continue;
      const reservation = this.ledger.reserve(owner, estimatedCost);
      const pendingOwnerKey = `pending:${reservation.reservationId}`;
      this.ledger.reservePendingOwner(pendingOwnerKey, owner);
      try {
        const issued = this.dispatchToChild(request, child, { reservationId: reservation.reservationId, pendingOwnerKey, scope: `new-${attempts.indexOf(owner)}` });
        if (issued) return;
      } catch (error) {
        if (error instanceof RouterPreDispatchError) {
          this.ledger.releasePreDispatch(reservation.reservationId);
          this.ledger.clearPendingOwner(pendingOwnerKey, owner);
          continue;
        }
        this.ledger.strandAmbiguous(reservation.reservationId);
        this.options.writeDesktop(redactedRouterError(request.id, "ambiguous_dispatch"));
        return;
      }
    }
    this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
  }

  private dispatchFanout(request: JsonRpcRequest, route: ClientRoute): void {
    const key = fanoutKey(request.id);
    const selectable = [...this.children.values()].filter((child) => this.options.store.snapshot().accountEligibility[child.opaqueAccountId] !== "protocol_blocked");
    if (selectable.length === 0) {
      this.options.writeDesktop(redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    this.fanouts.set(key, { desktopId: request.id, expected: selectable.length, responses: [], failed: false, route });
    for (const [index, child] of selectable.entries()) {
      const issued = this.dispatchToChild(request, child, { fanoutKey: key, scope: `read-${index}` });
      if (!issued) return;
    }
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
    extra: Omit<Partial<IssuedRequest>, "internalId" | "desktopId" | "child" | "method"> & { scope?: string } = {},
  ): IssuedRequest | null {
    let correlation;
    try {
      correlation = this.correlations.create("client_to_child", child.opaqueAccountId, request.id, request.method, extra.scope);
    } catch {
      this.options.writeDesktop(redactedRouterError(request.id, "invalid_correlation"));
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
    };
    this.issued.set(correlation.internalId, issued);
    try {
      child.send({ ...request, id: correlation.internalId });
      this.correlations.mark(correlation.internalId, "written");
      return issued;
    } catch (error) {
      this.issued.delete(correlation.internalId);
      if (error instanceof RouterPreDispatchError) {
        this.correlations.consume(correlation.internalId, "client_to_child", child.opaqueAccountId);
        throw error;
      }
      this.correlations.mark(correlation.internalId, "acknowledged");
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
    if (typeof response.id === "string") this.issued.delete(response.id);
    if (!correlation || !issued) {
      this.protocolDrift();
      return;
    }
    const threadId = threadIdFrom(response.result);
    if (issued.pendingOwnerKey && threadId) {
      try {
        const existingOwner = this.ledger.ownerFor(threadId);
        if (existingOwner === null) this.ledger.bindThread(threadId, childId, issued.pendingOwnerKey);
        else if (existingOwner !== childId) throw new Error("thread owner collision");
        if (issued.reservationId) this.pendingReservationsByThread.set(threadId, issued.reservationId);
      } catch {
        this.postStartFailure("post_start_failure");
        this.options.writeDesktop(redactedRouterError(issued.desktopId, "post_start_failure"));
        return;
      }
    }
    if (issued.method === "thread/fork" && threadId) {
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
    this.options.writeDesktop({ ...response, id: issued.desktopId });
  }

  private recordFanoutResponse(issued: IssuedRequest, response: JsonRpcResponse): void {
    const fanout = issued.fanoutKey ? this.fanouts.get(issued.fanoutKey) : undefined;
    if (!fanout) {
      this.protocolDrift();
      return;
    }
    fanout.responses.push(response);
    if (response.error) fanout.failed = true;
    if (fanout.responses.length < fanout.expected) return;
    this.fanouts.delete(issued.fanoutKey!);
    if (fanout.failed) {
      this.options.writeDesktop(redactedRouterError(fanout.desktopId, "post_start_failure"));
      return;
    }
    if (fanout.route === "fanout_initialize_intersection") {
      const results = fanout.responses.map((item) => item.result);
      const capabilities = intersectCapabilities(results.map((result) => isPlainRecord(result) ? result.capabilities : null));
      const schema = results.map((result) => isPlainRecord(result) ? stableJson(result.serverInfo ?? null) : "");
      if (capabilities === null || new Set(schema).size !== 1) {
        this.options.writeDesktop(redactedRouterError(fanout.desktopId, "capability_mismatch"));
        this.postStartFailure("post_start_failure");
        return;
      }
      for (const child of this.children.values()) {
        child.markInitialized?.();
        this.ledger.setEligibility(child.opaqueAccountId, "eligible");
      }
      this.initialized = true;
      const primary = fanout.responses.find((response) => response.id && true) ?? fanout.responses[0];
      const result = isPlainRecord(primary.result) ? { ...primary.result, capabilities } : { capabilities };
      this.options.writeDesktop({ ...primary, id: fanout.desktopId, result });
      return;
    }
    this.options.writeDesktop({ jsonrpc: "2.0", id: fanout.desktopId, result: mergeFanoutResults(fanout.responses, this.controlSecret) });
  }

  private handleChildRequest(childId: OpaqueAccountId, request: JsonRpcRequest): void {
    if (!isKnownServerRequest(request.method)) {
      this.protocolDrift();
      return;
    }
    if (request.method === "account/chatgptAuthTokens/refresh") {
      if (this.refreshInFlight.has(childId)) {
        this.ledger.setEligibility(childId, "reauth_required");
        this.children.get(childId)?.send(redactedRouterError(request.id, "invalid_correlation"));
        return;
      }
      this.refreshInFlight.add(childId);
    }
    let correlation;
    try {
      correlation = this.correlations.create("child_to_client", childId, request.id, request.method);
    } catch {
      this.ledger.setEligibility(childId, "reauth_required");
      this.children.get(childId)?.send(redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    this.options.writeDesktop({ ...request, id: correlation.internalId });
  }

  private routeDesktopResponse(response: JsonRpcResponse): void {
    const correlation = this.correlations.get(response.id);
    if (!correlation || correlation.direction !== "child_to_client") {
      this.protocolDrift();
      return;
    }
    const child = this.children.get(correlation.childOpaqueAccountId);
    if (!child) {
      this.postStartFailure("post_start_failure");
      return;
    }
    const terminal = this.correlations.consume(response.id, "child_to_client", child.opaqueAccountId);
    if (!terminal) {
      this.protocolDrift();
      return;
    }
    if (terminal.method === "account/chatgptAuthTokens/refresh") {
      this.refreshInFlight.delete(child.opaqueAccountId);
      if (!refreshResponseMatches(response.result, child.opaqueAccountId, this.controlSecret)) {
        this.ledger.setEligibility(child.opaqueAccountId, "reauth_required");
        child.send(redactedRouterError(terminal.originalId, "invalid_correlation"));
        return;
      }
    }
    try {
      child.send({ ...response, id: terminal.originalId });
    } catch {
      this.postStartFailure("post_start_failure");
    }
  }

  private handleChildNotification(childId: OpaqueAccountId, notification: JsonRpcMessage): void {
    if (!isNotification(notification)) return;
    const route = classifyServerNotification(notification.method, notification.params);
    if (route === "unknown") {
      this.protocolDrift();
      return;
    }
    const threadId = threadIdFrom(notification.params);
    if (route === "verify_persisted_owner_then_forward") {
      const knownOwner = threadId ? this.ledger.ownerFor(threadId) : null;
      const observedStart = notification.method === "thread/started" && threadId && knownOwner === null
        ? this.ledger.bindObservedThread(threadId, childId) : false;
      if (!threadId || (!observedStart && this.ledger.ownerFor(threadId) !== childId)) {
        this.protocolDrift();
        return;
      }
      this.recordTokenUsage(threadId, notification);
      this.reconcileTerminal(threadId, notification);
      this.options.writeDesktop(notification);
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
  }

  private reconcileTerminal(threadId: string, notification: JsonRpcMessage): void {
    if (!isNotification(notification) || notification.method !== "turn/completed" || !isPlainRecord(notification.params)) return;
    const reservationId = this.pendingReservationsByThread.get(threadId);
    if (!reservationId) return;
    const turnId = isPlainRecord(notification.params.turn) && typeof notification.params.turn.id === "string" ? notification.params.turn.id : "";
    const recordedUsage = turnId ? this.tokenUsage.get(`${threadId}:${turnId}`) ?? null : null;
    const usage = recordedUsage ?? (isPlainRecord(notification.params.turn) ? usageFrom(notification.params.turn.tokenUsage) : null);
    this.ledger.reconcile(reservationId, usage, modelFrom(notification.params));
    this.pendingReservationsByThread.delete(threadId);
    if (!usage) this.precisionEstimated = true;
  }

  private invalidateCapabilities(): void {
    for (const account of this.options.config.accounts) {
      if (account.opaqueAccountId !== this.options.config.primaryOpaqueAccountId && this.options.store.snapshot().accountEligibility[account.opaqueAccountId] === "eligible") {
        this.ledger.setEligibility(account.opaqueAccountId, "validating");
      }
    }
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

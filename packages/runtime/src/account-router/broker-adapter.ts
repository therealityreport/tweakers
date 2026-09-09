import { isNativeProfileStatisticsResultV1 } from "./profile-statistics";
import { isActionEmail, assertBrokerCommandResult, isRemoteCommand, isBrokerRemoteProjection, safeConnectionDisplayLabel } from "./broker";
import { isAccountsPreferences, isAccountsPreferencesPatch } from "./preferences";
import { isBoundedNativeResultV1, parseNativeBrowserChildRequestV1, parseNativeRequestV1 } from "./native-request";
import type { NativeBrowserContextV1 } from "./broker-socket";
import { createHmac } from "node:crypto";
import { assertRedacted } from "./redaction";
import type {
  AccountPoolAccountV3,
  AccountPoolV3,
  AccountsBrokerIpcEnvelopeV1,
  BrokerCommandV1,
  BrokerEnrollmentV1,
  BrokerEventV1,
  BrokerRequestEnvelopeV1,
  BrokerResponseV1,
  BrokerSafeProfileV1,
  ConnectionStateV3,
  OpaqueAccountId,
  OpaqueConnectionDefinitionRef,
  OpaqueEnrollmentRef,
  PendingHandoffV1,
  QuotaProjectionV3,
  TaskOwnershipV3,
  LogicalConversationProjectionV1,
  LogicalContinuationProjectionV1,
  LogicalHistorySubscriptionV1,
  LogicalTurnProjectionV1,
  OpaqueConversationId,
  OpaqueSegmentId,
  OpaqueTurnId,
  OpaqueRendererRef,
} from "./types";
import { isPlainRecord } from "./types";
import type { NativeSharedHistoryMapRequestV1, NativeSharedHistoryMapResultV1 } from "./broker-host";

/** Public IDs cannot be correlated with internal broker or provider handles. */
export type RendererAccountIdV1 = `account_${string}`;
export type RendererConnectionIdV1 = `connection_${string}`;
export type RendererEnrollmentIdV1 = `enrollment_${string}`;
export type RendererConfirmationIdV1 = `confirmation_${string}`;
export type RendererConversationIdV1 = `conversation_${string}`;
export type RendererSegmentIdV1 = `segment_${string}`;
export type RendererTurnIdV1 = `turn_${string}`;
export type RendererClientIdV1 = `client_${string}`;
export type RendererConnectionSurfaceV1 = "apps" | "plugins" | "mcp" | "usage";
export type RendererConnectionStatusV1 = "connected" | "setup_required" | "expired" | "unavailable";
export type RendererAccountStatusV1 = "ready" | "depleted" | "disabled" | "reauth_required" | "unavailable" | "active";

export interface RendererQuotaV1 {
  remainingPercent: number | null;
  freshness: "fresh" | "stale" | "unknown";
  resetAt: string | null;
  depleted: boolean;
  resetCredits: number | null;
  shortWindowPressure: number | null;
  refreshState: "idle" | "loading" | "error";
  errorCode: "authentication" | "connection" | "unavailable" | null;
  lastAttemptAt: string | null;
}

export interface RendererAccountProfileV1 {
  accountId: RendererAccountIdV1;
  label: string;
  avatarUrl: string | null;
  email: string | null;
  plan: string | null;
  enabled: boolean;
  quota: RendererQuotaV1;
  assignedTaskCount: number;
  currentTaskOwner: boolean;
  status: RendererAccountStatusV1;
  continuityState?: "ready" | "deferred";
  continuityReason?: "migration_pending" | "account_in_use" | "source_changed" | "recovery_required";
  continuityBlocker?: string;
}

export interface RendererConnectionV1 {
  connectionId: RendererConnectionIdV1;
  surface: RendererConnectionSurfaceV1;
  label: string;
  status: RendererConnectionStatusV1;
  authorizationAvailable: boolean;
}

/** Response-only OAuth handoff for a user-initiated MCP authorization. */
export interface RendererConnectionAuthorizationV1 {
  accountId: RendererAccountIdV1;
  connections: RendererConnectionV1[];
  oauthUrl: string;
}

export interface RendererEnrollmentV1 {
  enrollmentId: RendererEnrollmentIdV1;
  state: "starting" | "waiting" | "complete" | "cancelled" | "failed" | "expired";
  userCode: string | null;
  verificationUrl: string | null;
  expiresAt: string | null;
  accountId: RendererAccountIdV1 | null;
}

export interface RendererContinuationV1 {
  confirmationId: RendererConfirmationIdV1;
  state: "pending" | "confirmed" | "cancelled" | "expired";
  expiresAt: string | null;
}

export interface RendererLogicalSubscriptionV1 { accountId: RendererAccountIdV1; label: string; }
export interface RendererLogicalConversationV1 {
  conversationId: RendererConversationIdV1;
  availability: "complete" | "partial" | "incomplete" | "ambiguous";
  historyWarning?: "content_gap" | "ambiguous" | null;
  segments: Array<{ segmentId: RendererSegmentIdV1; subscription: RendererLogicalSubscriptionV1; state: "committed" | "active" | "incomplete" | "ambiguous"; committedAt?: string }>;
  activeClient: { clientId: RendererClientIdV1; label: string; subscription: RendererLogicalSubscriptionV1 } | null;
  peerBusy: boolean;
  updatedAt: string;
}
export interface RendererLogicalTurnV1 { turnId: RendererTurnIdV1; subscription: RendererLogicalSubscriptionV1; state: "committed"; }
export interface RendererLogicalContinuationV1 {
  confirmationId: RendererConfirmationIdV1;
  state: "pending" | "confirmed" | "cancelled" | "expired";
  expiresAt: string | null;
  kind: "subscription_switch";
  fromSubscription: RendererLogicalSubscriptionV1;
  toSubscription: RendererLogicalSubscriptionV1;
  conversationId: RendererConversationIdV1;
}

export type RendererBrokerEventTypeV1 =
  | "profile.updated" | "quota.updated" | "enabled.changed" | "connection.updated"
  | "enrollment.updated" | "reconnect.updated" | "resetCredit.updated"
  | "continuation.pending" | "continuation.resolved" | "handoff.updated"
  | "history.updated" | "conversation.updated" | "turn.committed";

export interface RendererBrokerEventV1 {
  version: 1;
  sequence: number;
  type: RendererBrokerEventTypeV1;
  payload: unknown;
}

export interface AccountsBrokerPrivateClientV1 {
  invoke(envelope: BrokerRequestEnvelopeV1): Promise<BrokerResponseV1>;
  subscribe(handler: (event: BrokerEventV1) => void): () => void;
  /** Reserved main-only path. It is intentionally absent from BrokerCommandV1. */
  mapNativeTargets?(request: NativeSharedHistoryMapRequestV1): Promise<NativeSharedHistoryMapResultV1>;
  resolveNativeBrowserContext?(opaqueAccountId: string): Promise<NativeBrowserContextV1>;
  invokeNativeBrowserRequest?(opaqueAccountId: string, method: string, params: Record<string, unknown>): Promise<unknown | null>;
}

export interface NativeBrowserRequestEnvelopeV1 { accountId: RendererAccountIdV1; method: string; params: Record<string, unknown> }
export interface NativeBrowserPrivateRequestV1 { opaqueAccountId: OpaqueAccountId; method: string; params: Record<string, unknown> }

export interface AccountsBrokerRendererAdapterOptionsV1 {
  secret: Buffer;
  client: AccountsBrokerPrivateClientV1;
  /** Private renderer binding for per-observer peerBusy projection. */
  rendererRef?: OpaqueRendererRef;
}

type PrivateSurface = "app" | "plugin" | "mcp" | "workspace";

/**
 * Accounts consumer adapter. It implements the Account Switcher public
 * projection rather than exposing the private broker protocol verbatim.
 */
export class AccountsBrokerRendererAdapterV1 {
  private readonly privateAccountByPublic = new Map<RendererAccountIdV1, OpaqueAccountId>();
  private readonly privateConnectionByPublic = new Map<RendererConnectionIdV1, { account: OpaqueAccountId; kind: PrivateSurface; definitionRef: OpaqueConnectionDefinitionRef }>();
  /** Scope identities only, so a full authoritative snapshot can notify removal of its last row. */
  private readonly observedConnectionScopes = new Map<string, { account: OpaqueAccountId; kind: PrivateSurface }>();
  private readonly privateEnrollmentByPublic = new Map<RendererEnrollmentIdV1, OpaqueEnrollmentRef>();
  private readonly privateHandoffByPublic = new Map<RendererConfirmationIdV1, PendingHandoffV1>();
  private readonly profiles = new Map<OpaqueAccountId, AccountPoolAccountV3>();
  private readonly quotas = new Map<OpaqueAccountId, QuotaProjectionV3>();
  private readonly labels = new Map<OpaqueAccountId, string>();
  /** Task lifecycle events are targeted by the broker, so this is renderer-local state. */
  private readonly activeTaskAccounts = new Map<string, OpaqueAccountId>();
  private readonly handlers = new Set<(event: RendererBrokerEventV1) => void>();
  private unsubscribePrivate: (() => void) | null = null;
  private eventSequence = 0;

  constructor(private readonly options: AccountsBrokerRendererAdapterOptionsV1) {
    if (options.secret.byteLength !== 32) throw new Error("invalid accounts broker adapter capability");
  }

  async invoke(envelope: AccountsBrokerIpcEnvelopeV1): Promise<BrokerResponseV1> {
    const translated = this.translateRequest(envelope);
    if (!translated) return invalidRequest(requestIdFrom(envelope));
    const response = await this.options.client.invoke(translated);
    if (!response.ok) return response;
    try {
      if (translated.command === "native.request" && (!isPlainRecord(response.result) || !isPlainRecord(translated.params)
        || response.result.opaqueAccountId !== translated.params.opaqueAccountId
        || response.result.surface !== translated.params.surface)) throw new Error("native account or surface mismatch");
      if (isRemoteCommand(translated.command) && (!isPlainRecord(response.result) || !isPlainRecord(translated.params) || response.result.accountId !== translated.params.opaqueAccountId)) throw new Error("remote account mismatch");
      if (translated.command === "profile.email" && (!isPlainRecord(response.result) || !isPlainRecord(translated.params) || response.result.opaqueAccountId !== translated.params.opaqueAccountId)) throw new Error("copy-email account mismatch");
      const result = this.translateResult(translated.command, envelope.params, response.result);
      if (result === null) return unavailable(response.requestId);
      if (translated.command === "profile.email") {
        if (!isPlainRecord(result) || !isAccountId(result.accountId) || !isActionEmail(result.email) || !keys(result, ["accountId", "email"])) throw new Error("invalid copy-email result");
      } else if (translated.command === "native.request") {
        // Native JSON follows the captured account/surface contract and size
        // bound checked above, as in assertBrokerCommandResult. It is not a
        // redacted control projection: plugin IDs, metadata and config keys
        // legitimately contain @ and credential-related words. Only the
        // broker envelope uses control redaction; native data stays intact.
        const native = result as { accountId: string; surface: string };
        assertRendererSafe({ accountId: native.accountId, surface: native.surface });
      } else assertRendererSafe(result);
      if (["connection.list", "connection.status"].includes(translated.command) && isPlainRecord(translated.params)
        && isOpaqueAccount(translated.params.opaqueAccountId) && isPrivateSurface(translated.params.kind) && Array.isArray(response.result)) {
        const scope = { account: translated.params.opaqueAccountId, kind: translated.params.kind };
        const key = `${scope.account}\u0000${scope.kind}`;
        if (response.result.length > 0) this.observedConnectionScopes.set(key, scope);
        else if (translated.command === "connection.list") this.observedConnectionScopes.delete(key);
      }
      this.emitCommandEvent(translated.command, result);
      return { version: 1, requestId: response.requestId, ok: true, result };
    } catch {
      return unavailable(response.requestId);
    }
  }

  subscribe(handler: (event: RendererBrokerEventV1) => void): () => void {
    if (typeof handler !== "function") return () => {};
    this.handlers.add(handler);
    if (!this.unsubscribePrivate) {
      this.unsubscribePrivate = this.options.client.subscribe((event) => {
        for (const projected of this.translateEvent(event)) this.emit(projected.type, projected.payload);
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
  async mapBoundNativeTargets(request: NativeSharedHistoryMapRequestV1): Promise<NativeSharedHistoryMapResultV1> {
    if (!isNativeTargetMapRequest(request) || !this.options.client.mapNativeTargets) return { version: 1, status: "unavailable" };
    try {
      const result = await this.options.client.mapNativeTargets(request);
      return isNativeTargetMapResult(result) ? result : { version: 1, status: "unavailable" };
    } catch {
      return { version: 1, status: "unavailable" };
    }
  }

  async resolveNativeBrowserContext(accountId: string): Promise<Extract<NativeBrowserContextV1, { status: "ready" }> | null> {
    if (!isAccountId(accountId)) return null;
    const account = this.privateAccountByPublic.get(accountId);
    if (!account || !this.options.client.resolveNativeBrowserContext) return null;
    try {
      const result = await this.options.client.resolveNativeBrowserContext(account);
      return result.status === "ready" ? result : null;
    } catch { return null; }
  }

  translateNativeBrowserRequest(envelope: unknown): NativeBrowserPrivateRequestV1 | null {
    if (!isPlainRecord(envelope) || Object.keys(envelope).sort().join("\0") !== "accountId\0method\0params"
      || !isAccountId(envelope.accountId) || typeof envelope.method !== "string" || !isPlainRecord(envelope.params)) return null;
    const account = this.privateAccountByPublic.get(envelope.accountId);
    const request = parseNativeRequestV1({ surface: "plugins", method: envelope.method, params: envelope.params });
    return account && request && request.method.startsWith("browser.") ? { opaqueAccountId: account, method: request.method, params: request.params } : null;
  }

  async invokeNativeBrowserRequest(accountId: string, method: string, params: unknown): Promise<unknown | null> {
    if (!isAccountId(accountId)) return null;
    const account = this.privateAccountByPublic.get(accountId);
    const request = parseNativeBrowserChildRequestV1(method, params);
    if (!account || !request || !this.options.client.invokeNativeBrowserRequest) return null;
    return this.options.client.invokeNativeBrowserRequest(account, request.method, request.params);
  }

  private translateRequest(envelope: unknown): BrokerRequestEnvelopeV1 | null {
    if (!isPublicEnvelope(envelope)) return null;
    const { command, requestId } = envelope;
    const params = envelope.params ?? {};
    if (["profile.read", "history.read", "preferences.read", "balance.read", "events.subscribe", "events.unsubscribe"].includes(command)) {
      return emptyParams(params) ? { version: 1, requestId, command } : null;
    }
    if (command === "preferences.update") return isAccountsPreferencesPatch(params) ? { version: 1, requestId, command, params: { ...params } } : null;
    if (command === "balance.set") {
      return isPlainRecord(params) && keys(params, ["enabled"]) && typeof params.enabled === "boolean"
        ? { version: 1, requestId, command, params: { enabled: params.enabled } } : null;
    }
    if (isRemoteCommand(command)) {
      if (!isPlainRecord(params) || !keys(params, command === "remote.devices.revoke" ? ["accountId", "deviceId"] : ["accountId"]) || !isAccountId(params.accountId)
        || command === "remote.devices.revoke" && (typeof params.deviceId !== "string" || !/^device_[A-Za-z0-9_-]{43}$/.test(params.deviceId))) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account, ...(command === "remote.devices.revoke" ? { deviceId: params.deviceId } : {}) } } : null;
    }
    if (command === "profile.statistics") {
      if (!isPlainRecord(params) || !keys(params, ["selection"])) return null;
      const selection = params.selection === "pooled" ? "pooled" : isAccountId(params.selection) ? this.privateAccountByPublic.get(params.selection) : null;
      return selection ? { version: 1, requestId, command, params: { selection } } : null;
    }
    if (command === "profile.email") {
      if (!isPlainRecord(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
    }
    if (command === "profile.update") {
      if (!isPlainRecord(params) || !keys(params, ["accountId", "label"]) || !isAccountId(params.accountId) || !safeLabel(params.label)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account, label: params.label } } : null;
    }
    if (command === "enabled.set") {
      if (!isPlainRecord(params) || !keys(params, ["accountId", "enabled"]) || !isAccountId(params.accountId) || typeof params.enabled !== "boolean") return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account, enabled: params.enabled } } : null;
    }
    if (command === "quota.read") {
      if (emptyParams(params)) return { version: 1, requestId, command };
      if (!isPlainRecord(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
    }
    if (command === "native.request") {
      if (!isPlainRecord(params) || !keys(params, ["accountId", "surface", "method", "params"]) || !isAccountId(params.accountId)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      const request = parseNativeRequestV1({ surface: params.surface, method: params.method, params: params.params });
      return account && request && !request.method.startsWith("browser.") ? { version: 1, requestId, command, params: { opaqueAccountId: account, ...request } } : null;
    }
    if (command === "enrollment.start") return emptyParams(params) ? { version: 1, requestId, command } : null;
    if (command === "reconnect.start") {
      if (!isPlainRecord(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
    }
    if (["enrollment.status", "enrollment.cancel", "reconnect.status", "reconnect.cancel"].includes(command)) {
      if (!isPlainRecord(params) || !keys(params, ["enrollmentId"]) || !isEnrollmentId(params.enrollmentId)) return null;
      const enrollment = this.privateEnrollmentByPublic.get(params.enrollmentId);
      return enrollment ? { version: 1, requestId, command, params: { enrollmentRef: enrollment } } : null;
    }
    if (command === "connection.list" || command === "connection.status") {
      const expected = command === "connection.list" ? ["accountId", "surface"] : ["accountId", "connectionId", "surface"];
      if (!isPlainRecord(params) || !keys(params, expected) || !isAccountId(params.accountId) || !isSurface(params.surface)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      const kind = toPrivateSurface(params.surface);
      if (!account || !kind) return null;
      if (command === "connection.list") return { version: 1, requestId, command, params: { opaqueAccountId: account, kind } };
      if (!isConnectionId(params.connectionId)) return null;
      const connection = this.privateConnectionByPublic.get(params.connectionId);
      if (!connection || connection.account !== account || connection.kind !== kind) return null;
      return { version: 1, requestId, command, params: { opaqueAccountId: account, kind, definitionRef: connection.definitionRef } };
    }
    if (command === "connection.authorize") {
      if (!isPlainRecord(params) || !keys(params, ["accountId", "connectionId", "surface"])
        || !isAccountId(params.accountId) || !isConnectionId(params.connectionId) || !isSurface(params.surface)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      const kind = toPrivateSurface(params.surface);
      const connection = this.privateConnectionByPublic.get(params.connectionId);
      // The public UI must not turn a display-only App/Plugin/Workspace row
      // into a provider OAuth request.  Repeat the broker's fail-closed MCP
      // boundary here so forged renderer traffic cannot wake an account child.
      if (!account || kind !== "mcp" || !connection || connection.account !== account || connection.kind !== kind) return null;
      return { version: 1, requestId, command, params: { opaqueAccountId: account, kind, definitionRef: connection.definitionRef } };
    }
    if (command === "resetCredit.consume") {
      if (!isPlainRecord(params) || !keys(params, ["accountId"]) || !isAccountId(params.accountId)) return null;
      const account = this.privateAccountByPublic.get(params.accountId);
      return account ? { version: 1, requestId, command, params: { opaqueAccountId: account } } : null;
    }
    if (command === "handoff.confirm" || command === "handoff.cancel") {
      const confirmKeys = command === "handoff.confirm" && isPlainRecord(params) && Object.prototype.hasOwnProperty.call(params, "accountId")
        ? ["accountId", "confirmationId"]
        : ["confirmationId"];
      if (!isPlainRecord(params) || !keys(params, confirmKeys) || !isConfirmationId(params.confirmationId)
        || ("accountId" in params && !isAccountId(params.accountId))) return null;
      const handoff = this.privateHandoffByPublic.get(params.confirmationId);
      if (!handoff) return null;
      if (command === "handoff.confirm" && "accountId" in params) {
        const accountId = params.accountId;
        if (!isAccountId(accountId)) return null;
        const toOpaqueAccountId = this.privateAccountByPublic.get(accountId);
        return toOpaqueAccountId ? { version: 1, requestId, command, params: { handoffRef: handoff.handoffRef, toOpaqueAccountId } } : null;
      }
      return { version: 1, requestId, command, params: { handoffRef: handoff.handoffRef } };
    }
    return null;
  }

  private translateResult(command: BrokerCommandV1, supplied: unknown, value: unknown): unknown | null {
    if (command === "profile.statistics") {
      if (!isNativeProfileStatisticsResultV1(value) || !isPlainRecord(supplied)) throw new Error("invalid profile statistics");
      const selection = value.selection === "pooled" ? "pooled" : this.accountId(value.selection);
      if (selection !== supplied.selection) throw new Error("statistics selection mismatch");
      return { ...value, selection, accounts: value.accounts.map((account) => ({ ...account, accountId: this.accountId(account.accountId) })) };
    }
    if (command === "profile.email") {
      assertBrokerCommandResult(command, value);
      const result = value as { opaqueAccountId: OpaqueAccountId; email: string };
      return { accountId: this.accountId(result.opaqueAccountId), email: result.email };
    }
    if (isRemoteCommand(command)) {
      if (!isBrokerRemoteProjection(value)) throw new Error("invalid remote response");
      return { ...value, accountId: this.accountId(value.accountId) };
    }
    if (command === "preferences.read" || command === "preferences.update") {
      if (!isAccountsPreferences(value)) throw new Error("invalid Accounts preferences response");
      return { ...value };
    }
    if (command === "balance.read" || command === "balance.set") return balance(value, this);
    if (command === "profile.read") return profile(value, this);
    if (command === "history.read") return historyRead(value, this);
    if (command === "profile.update" || command === "enabled.set") return accountMutation(value, supplied, this);
    if (command === "quota.read") return quota(value, supplied, this);
    if (command === "native.request") {
      if (!isPlainRecord(value) || !isOpaqueAccount(value.opaqueAccountId) || typeof value.surface !== "string"
        || !isBoundedNativeResultV1(value.result, value.surface as never)) return null;
      const accountId = this.accountId(value.opaqueAccountId);
      if (!isPlainRecord(supplied) || supplied.accountId !== accountId || supplied.surface !== value.surface) return null;
      return { accountId, surface: value.surface, result: value.result };
    }
    if (command === "connection.list" || command === "connection.status") return connections(value, supplied, this);
    if (command === "connection.authorize") return authorize(value, this);
    if (["enrollment.start", "enrollment.status", "enrollment.cancel", "reconnect.start", "reconnect.status", "reconnect.cancel"].includes(command)) return enrollment(value, this);
    if (command === "resetCredit.consume") return reset(value, this);
    if (command === "handoff.confirm" || command === "handoff.cancel") return continuationResult(value, this);
    if (command === "events.subscribe" || command === "events.unsubscribe") return {};
    return null;
  }

  private translateEvent(event: BrokerEventV1): Array<{ type: RendererBrokerEventTypeV1; payload: unknown }> {
    if (event.type === "profile") {
      const result = profile(event.payload, this);
      return result ? [{ type: "profile.updated", payload: result }] : [];
    }
    if (event.type === "quota") {
      const rows = Array.isArray(event.payload) ? event.payload : [event.payload];
      return rows.flatMap((item) => {
        if (!isQuota(item)) return [];
        const result = quota([item], { accountId: this.accountId(item.opaqueAccountId) }, this);
        return result ? [{ type: "quota.updated" as const, payload: result }] : [];
      });
    }
    if (event.type === "connection" && Array.isArray(event.payload)) {
      if (!event.payload.every(isConnection)) return [];
      const groups = new Map<string, ConnectionStateV3[]>();
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
        if (items.length > 0) this.observedConnectionScopes.set(key, scope);
        const result = connections(items, { accountId: this.accountId(scope.account), surface: fromPrivateSurface(scope.kind) }, this);
        return result ? [{ type: "connection.updated" as const, payload: result }] : [];
      });
    }
    if (event.type === "enrollment") {
      const result = enrollment(event.payload, this);
      if (!result || !isEnrollment(event.payload)) return [];
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
      if (!result) return [];
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

  private emitCommandEvent(command: BrokerCommandV1, result: unknown): void {
    if (command === "profile.update" && isPlainRecord(result)) this.emit("profile.updated", result);
    else if (command === "enabled.set" && isPlainRecord(result)) this.emit("enabled.changed", result);
    else if (command === "quota.read" && isPlainRecord(result)) this.emit("quota.updated", result);
    // `connection.authorize` has one ephemeral OAuth handoff URL for the
    // bound main-process caller. It is never a renderer event; the private
    // broker separately emits a URL-free connection state update.
    else if (["enrollment.start", "enrollment.status", "enrollment.cancel"].includes(command) && isPlainRecord(result)) this.emit("enrollment.updated", result);
    else if (["reconnect.start", "reconnect.status", "reconnect.cancel"].includes(command) && isPlainRecord(result)) this.emit("reconnect.updated", result);
    else if (command === "resetCredit.consume" && isPlainRecord(result)) this.emit("resetCredit.updated", result);
    else if ((command === "handoff.confirm" || command === "handoff.cancel") && isPlainRecord(result)) this.emit("handoff.updated", result);
  }

  private emit(type: RendererBrokerEventTypeV1, payload: unknown): void {
    const event: RendererBrokerEventV1 = { version: 1, sequence: ++this.eventSequence, type, payload };
    try { assertRendererSafe(event); } catch { return; }
    for (const handler of this.handlers) { try { handler(event); } catch { /* isolated observer */ } }
  }

  accountId(account: OpaqueAccountId): RendererAccountIdV1 {
    const id = `account_${hash(this.options.secret, `account:${account}`)}` as RendererAccountIdV1;
    this.privateAccountByPublic.set(id, account);
    return id;
  }

  /** Kept private to the main-process adapter; never return this to a renderer. */
  opaqueAccountForPublic(accountId: RendererAccountIdV1): OpaqueAccountId | null {
    return this.privateAccountByPublic.get(accountId) ?? null;
  }

  connectionId(account: OpaqueAccountId, kind: PrivateSurface, definitionRef: OpaqueConnectionDefinitionRef): RendererConnectionIdV1 {
    const id = `connection_${hash(this.options.secret, `connection:${account}:${kind}:${definitionRef}`)}` as RendererConnectionIdV1;
    this.privateConnectionByPublic.set(id, { account, kind, definitionRef });
    return id;
  }

  enrollmentId(ref: OpaqueEnrollmentRef): RendererEnrollmentIdV1 {
    const id = `enrollment_${hash(this.options.secret, `enrollment:${ref}`)}` as RendererEnrollmentIdV1;
    this.privateEnrollmentByPublic.set(id, ref);
    return id;
  }

  confirmationId(handoff: PendingHandoffV1): RendererConfirmationIdV1 {
    const id = `confirmation_${hash(this.options.secret, `confirmation:${handoff.confirmationId}`)}` as RendererConfirmationIdV1;
    this.privateHandoffByPublic.set(id, handoff);
    return id;
  }

  conversationId(value: OpaqueConversationId): RendererConversationIdV1 { return `conversation_${hash(this.options.secret, `conversation:${value}`)}` as RendererConversationIdV1; }
  segmentId(value: OpaqueSegmentId): RendererSegmentIdV1 { return `segment_${hash(this.options.secret, `segment:${value}`)}` as RendererSegmentIdV1; }
  turnId(value: OpaqueTurnId): RendererTurnIdV1 { return `turn_${hash(this.options.secret, `turn:${value}`)}` as RendererTurnIdV1; }
  clientId(value: OpaqueRendererRef): RendererClientIdV1 { return `client_${hash(this.options.secret, `client:${value}`)}` as RendererClientIdV1; }
  /** Private implementation detail for per-observer projection; never IPC. */
  rendererRef(): OpaqueRendererRef | null { return this.options.rendererRef ?? null; }
  /** Internal HMAC capability, used only to derive a public confirmation handle. */
  secret(): Buffer { return this.options.secret; }

  cache(rows: readonly AccountPoolAccountV3[]): void {
    for (const row of rows) this.profiles.set(row.opaqueAccountId, { ...row });
  }

  cacheQuota(rows: readonly QuotaProjectionV3[]): void {
    for (const row of rows) this.quotas.set(row.opaqueAccountId, { ...row });
  }

  quotaFor(account: OpaqueAccountId): RendererQuotaV1 {
    const quota = this.quotas.get(account);
    return quota ? publicQuota(quota) : emptyQuota();
  }

  label(account: OpaqueAccountId): string {
    return this.labelsFor(account, `Account ${[...this.profiles.keys()].indexOf(account) + 1}`);
  }

  labelsFor(account: OpaqueAccountId, fallback: string): string {
    return this.profiles.get(account)?.safeProfile.identifierMasked ?? this.labels.get(account) ?? fallback;
  }

  rememberLabel(account: OpaqueAccountId, label: string): void {
    if (safeLabel(label)) this.labels.set(account, label);
  }

  currentTaskOwner(account: OpaqueAccountId): boolean {
    for (const activeAccount of this.activeTaskAccounts.values()) if (activeAccount === account) return true;
    return false;
  }

  private recordTaskOwnership(task: TaskOwnershipV3): void {
    if (task.activeRunCount > 0) this.activeTaskAccounts.set(task.taskRef, task.opaqueAccountId);
    else this.activeTaskAccounts.delete(task.taskRef);
  }
}

function profile(value: unknown, adapter: AccountsBrokerRendererAdapterV1): { accounts: RendererAccountProfileV1[]; selectedAccountId: RendererAccountIdV1 | null } | null {
  if (!isPool(value)) return null;
  adapter.cache(value.accounts);
  const accounts = value.accounts.map((row) => account(row, adapter.quotaFor(row.opaqueAccountId), adapter));
  return { accounts, selectedAccountId: accounts[0]?.accountId ?? null };
}

function historyRead(value: unknown, adapter: AccountsBrokerRendererAdapterV1): { conversation: RendererLogicalConversationV1 | null; turns: RendererLogicalTurnV1[] } | null {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["conversation", "turns"].join("\0")
    || (value.conversation !== null && !isLogicalConversation(value.conversation)) || !Array.isArray(value.turns) || !value.turns.every(isLogicalTurn)) return null;
  return { conversation: value.conversation ? logicalConversation(value.conversation, adapter) : null, turns: value.turns.map((turn) => logicalTurn(turn, adapter)).filter((turn): turn is RendererLogicalTurnV1 => turn !== null) };
}

function accountMutation(value: unknown, supplied: unknown, adapter: AccountsBrokerRendererAdapterV1): {
  account: RendererAccountProfileV1;
  lifecycle: "no_new_work" | "active_runs_finishing" | "idle_child_stopped" | "lazy";
} | null {
  if (!isAccount(value)) return null;
  if (isPlainRecord(supplied) && safeLabel(supplied.label)) adapter.rememberLabel(value.opaqueAccountId, supplied.label);
  adapter.cache([value]);
  const disabling = isPlainRecord(supplied) && supplied.enabled === false;
  const lifecycle = disabling
    ? value.activeRunCount > 0
      ? "active_runs_finishing"
      : value.childState === "evicted"
        ? "idle_child_stopped"
        : "no_new_work"
    : "lazy";
  return { account: account(value, adapter.quotaFor(value.opaqueAccountId), adapter), lifecycle };
}

function quota(value: unknown, supplied: unknown, adapter: AccountsBrokerRendererAdapterV1): { accountId: RendererAccountIdV1; quota: RendererQuotaV1 } | { accounts: Array<{ accountId: RendererAccountIdV1; quota: RendererQuotaV1 }>; partial: boolean } | null {
  if (!Array.isArray(value) || !value.every(isQuota)) return null;
  adapter.cacheQuota(value);
  const requested = isPlainRecord(supplied) && isAccountId(supplied.accountId) ? supplied.accountId : null;
  if (requested) {
    const row = value.find((item) => adapter.accountId(item.opaqueAccountId) === requested) ?? null;
    return row ? { accountId: requested, quota: publicQuota(row) } : null;
  }
  const accounts = value.map((row) => ({ accountId: adapter.accountId(row.opaqueAccountId), quota: publicQuota(row) }));
  return { accounts, partial: accounts.some((entry) => entry.quota.refreshState === "error" || entry.quota.freshness !== "fresh") };
}

function connections(value: unknown, supplied: unknown, adapter: AccountsBrokerRendererAdapterV1): { accountId: RendererAccountIdV1; connections: RendererConnectionV1[] } | null {
  if (!Array.isArray(value) || !value.every(isConnection) || value.length > 2048 || !isPlainRecord(supplied)
    || !isAccountId(supplied.accountId) || !isSurface(supplied.surface)) return null;
  const accountId = supplied.accountId;
  const account = adapter.opaqueAccountForPublic(accountId);
  const kind = toPrivateSurface(supplied.surface);
  if (!account || !kind) return null;
  return { accountId, connections: value.filter((item) => item.opaqueAccountId === account && item.kind === kind).map((item) => connection(item, adapter)) };
}

function authorize(value: unknown, adapter: AccountsBrokerRendererAdapterV1): RendererConnectionAuthorizationV1 | null {
  if (!isPlainRecord(value) || !isOpaqueAccount(value.opaqueAccountId) || !isPrivateSurface(value.kind) || !isDefinition(value.definitionRef) || value.state !== "submitted" || !isSafeOAuthUrl(value.oauthUrl)) return null;
  return {
    accountId: adapter.accountId(value.opaqueAccountId),
    connections: [connection({ opaqueAccountId: value.opaqueAccountId, kind: value.kind, definitionRef: value.definitionRef, status: "connecting", updatedAt: null }, adapter)],
    oauthUrl: value.oauthUrl,
  };
}

function enrollment(value: unknown, adapter: AccountsBrokerRendererAdapterV1): { enrollment: RendererEnrollmentV1 } | null {
  if (!isEnrollment(value)) return null;
  return { enrollment: {
    enrollmentId: adapter.enrollmentId(value.enrollmentRef), state: value.state,
    userCode: value.state === "waiting" ? value.userCode : null,
    verificationUrl: value.state === "waiting" ? value.verificationUrl : null,
    expiresAt: value.expiresAt,
    accountId: value.opaqueAccountId ? adapter.accountId(value.opaqueAccountId) : null,
  } };
}

function reset(value: unknown, adapter: AccountsBrokerRendererAdapterV1): { accountId: RendererAccountIdV1; consumed: boolean; quota: RendererQuotaV1 } | null {
  if (!isPlainRecord(value) || !isOpaqueAccount(value.opaqueAccountId) || typeof value.consumed !== "boolean" || !isQuota(value.quota)) return null;
  return { accountId: adapter.accountId(value.opaqueAccountId), consumed: value.consumed, quota: publicQuota(value.quota) };
}

function continuationResult(value: unknown, adapter: AccountsBrokerRendererAdapterV1): { continuation: RendererContinuationV1 | null } | null {
  if (isPlainRecord(value) && value.status === "cancelled") return { continuation: null };
  if (!isHandoff(value)) return null;
  return { continuation: {
    confirmationId: adapter.confirmationId(value),
    state: value.state === "pending" ? "pending" : value.state === "cancelled" ? "cancelled" : value.state === "expired" ? "expired" : "confirmed",
    expiresAt: value.expiresAt,
  } };
}

function logicalSubscription(value: LogicalHistorySubscriptionV1, adapter: AccountsBrokerRendererAdapterV1): RendererLogicalSubscriptionV1 {
  return { accountId: adapter.accountId(value.accountId), label: adapter.labelsFor(value.accountId, value.label) };
}

function logicalConversation(value: LogicalConversationProjectionV1, adapter: AccountsBrokerRendererAdapterV1): RendererLogicalConversationV1 | null {
  if (!isLogicalConversation(value)) return null;
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
    peerBusy: Boolean(value.peerBusy && activeClient && thisRendererDiffers(active!.clientId, adapter)),
    updatedAt: value.updatedAt,
  };
}

function thisRendererDiffers(active: OpaqueRendererRef, adapter: AccountsBrokerRendererAdapterV1): boolean {
  const current = adapter.rendererRef();
  return current !== null && current !== active;
}

function logicalTurn(value: LogicalTurnProjectionV1, adapter: AccountsBrokerRendererAdapterV1): RendererLogicalTurnV1 | null {
  return isLogicalTurn(value) ? { turnId: adapter.turnId(value.turnId), subscription: logicalSubscription(value.subscription, adapter), state: "committed" } : null;
}

function logicalContinuation(value: LogicalContinuationProjectionV1, adapter: AccountsBrokerRendererAdapterV1): RendererLogicalContinuationV1 | null {
  if (!isLogicalContinuation(value)) return null;
  return {
    confirmationId: `confirmation_${hash(adapter.secret(), `confirmation:${value.confirmationId}`)}` as RendererConfirmationIdV1,
    state: value.state === "pending" ? "pending" : value.state === "cancelled" ? "cancelled" : value.state === "expired" ? "expired" : "confirmed",
    expiresAt: value.expiresAt,
    kind: "subscription_switch",
    fromSubscription: logicalSubscription(value.fromSubscription, adapter),
    toSubscription: logicalSubscription(value.toSubscription, adapter),
    conversationId: adapter.conversationId(value.conversationId),
  };
}

function account(row: AccountPoolAccountV3, quota: RendererQuotaV1, adapter: AccountsBrokerRendererAdapterV1): RendererAccountProfileV1 {
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

function connection(row: ConnectionStateV3, adapter: AccountsBrokerRendererAdapterV1): RendererConnectionV1 {
  const surface = fromPrivateSurface(row.kind);
  return {
    connectionId: adapter.connectionId(row.opaqueAccountId, row.kind, row.definitionRef), surface,
    label: safeConnectionDisplayLabel(row.displayLabel) ?? `${surface === "mcp" ? "MCP" : surface.slice(0, 1).toUpperCase() + surface.slice(1)} connection`,
    status: row.status === "connected" ? "connected"
      : row.status === "blocked" ? "expired"
        : row.status === "unavailable" ? "unavailable" : "setup_required",
    authorizationAvailable: surface === "mcp",
  };
}

function balance(value: unknown, adapter: AccountsBrokerRendererAdapterV1): unknown | null {
  if (!isPlainRecord(value) || !keys(value, ["policy", "baselineAt", "accounts", "degradedReason", "nextAccountId"])
    || !["balanced_tokens_v1", "quota_aware_v2", "manual"].includes(String(value.policy))
    || !(value.baselineAt === null || typeof value.baselineAt === "string" && /^\d{4}-\d\d-\d\dT/.test(value.baselineAt) && Number.isFinite(Date.parse(value.baselineAt)))
    || !Array.isArray(value.accounts)
    || ![null, "account_unavailable", "usage_unknown", "requires_two_accounts"].includes(value.degradedReason as null)
  ) return null;
  const seen = new Set<string>();
  const accounts = [];
  for (const row of value.accounts) {
    if (!isPlainRecord(row) || !keys(row, ["opaqueAccountId", "completedTokens", "reservedTokens", "unreportedTokens", "sharePercent", "precision"])
      || !isOpaqueAccount(row.opaqueAccountId) || seen.has(row.opaqueAccountId)
      || !Number.isSafeInteger(row.completedTokens) || (row.completedTokens as number) < 0
      || !Number.isSafeInteger(row.unreportedTokens) || (row.unreportedTokens as number) < 0
      || !Number.isSafeInteger(row.reservedTokens) || (row.reservedTokens as number) < 0
      || !(row.sharePercent === null || typeof row.sharePercent === "number" && Number.isFinite(row.sharePercent) && row.sharePercent >= 0 && row.sharePercent <= 100)
      || !["exact", "partial", "unknown"].includes(String(row.precision))) return null;
    seen.add(row.opaqueAccountId);
    accounts.push({ accountId: adapter.accountId(row.opaqueAccountId), completedTokens: row.completedTokens,
      reservedTokens: row.reservedTokens, unreportedTokens: row.unreportedTokens, sharePercent: row.sharePercent, precision: row.precision });
  }
  if (value.nextAccountId !== null && (!isOpaqueAccount(value.nextAccountId) || !seen.has(value.nextAccountId))) return null;
  return { policy: value.policy, baselineAt: value.baselineAt, accounts, degradedReason: value.degradedReason,
    nextAccountId: value.nextAccountId === null ? null : adapter.accountId(value.nextAccountId as OpaqueAccountId) };
}

function publicQuota(row: QuotaProjectionV3): RendererQuotaV1 { return { remainingPercent: row.remainingPercent, freshness: row.freshness, resetAt: row.resetAt, depleted: row.remainingPercent === 0 || row.rateLimitReached === true || (row.shortWindowPressure === 100 && (row.shortWindowResetAt == null || row.shortWindowResetAt > Date.now())), resetCredits: row.resetCredits, shortWindowPressure: row.shortWindowPressure, refreshState: row.refreshState ?? "idle", errorCode: row.errorCode ?? null, lastAttemptAt: row.lastAttemptAt ?? null }; }
function emptyQuota(): RendererQuotaV1 { return { remainingPercent: null, freshness: "unknown", resetAt: null, depleted: false, resetCredits: null, shortWindowPressure: null, refreshState: "idle", errorCode: null, lastAttemptAt: null }; }
function toPrivateSurface(surface: RendererConnectionSurfaceV1): PrivateSurface | null { return surface === "apps" ? "app" : surface === "plugins" ? "plugin" : surface === "mcp" ? "mcp" : surface === "usage" ? "workspace" : null; }
function fromPrivateSurface(surface: PrivateSurface): RendererConnectionSurfaceV1 { return surface === "app" ? "apps" : surface === "plugin" ? "plugins" : surface === "mcp" ? "mcp" : "usage"; }

function isPublicEnvelope(value: unknown): value is AccountsBrokerIpcEnvelopeV1 {
  return isPlainRecord(value) && Object.keys(value).every((key) => ["action", "command", "params", "requestId", "version"].includes(key))
    && value.version === 1 && value.action === "broker" && typeof value.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.requestId)
    && isCommand(value.command) && (value.params === undefined || isPlainRecord(value.params));
}
function isCommand(value: unknown): value is BrokerCommandV1 { return isRemoteCommand(value) || typeof value === "string" && ["enrollment.start", "enrollment.status", "enrollment.cancel", "reconnect.start", "reconnect.status", "reconnect.cancel", "profile.read", "profile.email", "profile.statistics", "history.read", "profile.update", "enabled.set", "quota.read", "native.request", "preferences.read", "preferences.update", "balance.read", "balance.set", "connection.list", "connection.status", "connection.authorize", "resetCredit.consume", "handoff.confirm", "handoff.cancel", "events.subscribe", "events.unsubscribe"].includes(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
function emptyParams(value: unknown): boolean { return value === undefined || (isPlainRecord(value) && Object.keys(value).length === 0); }
function safeLabel(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value); }
function isAccountId(value: unknown): value is RendererAccountIdV1 { return typeof value === "string" && /^account_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isConnectionId(value: unknown): value is RendererConnectionIdV1 { return typeof value === "string" && /^connection_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isEnrollmentId(value: unknown): value is RendererEnrollmentIdV1 { return typeof value === "string" && /^enrollment_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isConfirmationId(value: unknown): value is RendererConfirmationIdV1 { return typeof value === "string" && /^confirmation_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isNativeTargetMapRequest(value: unknown): value is NativeSharedHistoryMapRequestV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"].join("\0")
    && value.version === 1 && isNativeTargetId(value.conversationNativeId) && isNativeTargetId(value.composerNativeId)
    && Array.isArray(value.assistantTurnNativeIds) && value.assistantTurnNativeIds.length <= 128 && value.assistantTurnNativeIds.every(isNativeTargetId);
}
function isNativeTargetMapResult(value: unknown): value is NativeSharedHistoryMapResultV1 {
  return isPlainRecord(value) && value.version === 1 && (value.status === "unavailable"
    ? Object.keys(value).sort().join("\0") === ["status", "version"].join("\0")
    : value.status === "mapped" && Object.keys(value).sort().join("\0") === ["conversationId", "status", "turnIds", "version"].join("\0")
      && typeof value.conversationId === "string" && /^conversation_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId)
      && Array.isArray(value.turnIds) && value.turnIds.length <= 128 && value.turnIds.every((turnId) => typeof turnId === "string" && /^turn_[A-Za-z0-9_-]{16,128}$/.test(turnId)));
}
function isNativeTargetId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function isSurface(value: unknown): value is RendererConnectionSurfaceV1 { return value === "apps" || value === "plugins" || value === "mcp" || value === "usage"; }
function isOpaqueAccount(value: unknown): value is OpaqueAccountId { return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value); }
function isDefinition(value: unknown): value is OpaqueConnectionDefinitionRef { return typeof value === "string" && /^bd_[A-Za-z0-9_-]{16,128}$/.test(value); }
function isPrivateSurface(value: unknown): value is PrivateSurface { return value === "app" || value === "plugin" || value === "mcp" || value === "workspace"; }
function isPool(value: unknown): value is AccountPoolV3 { return isPlainRecord(value) && value.schemaVersion === 3 && Array.isArray(value.accounts) && value.accounts.every(isAccount); }
function isAccount(value: unknown): value is AccountPoolAccountV3 { return isPlainRecord(value) && isOpaqueAccount(value.opaqueAccountId) && safeLabel(value.label) && isSafeProfile(value.safeProfile) && typeof value.enabled === "boolean" && ["disabled", "ready", "active", "reauth_required", "unhealthy"].includes(String(value.state)) && ["absent", "resident", "active", "held", "evicted"].includes(String(value.childState)) && typeof value.assignedTaskCount === "number" && Number.isInteger(value.assignedTaskCount) && value.assignedTaskCount >= 0
  && (value.continuityState === undefined || ["ready", "deferred"].includes(String(value.continuityState)))
  && (value.continuityReason === undefined || ["migration_pending", "account_in_use", "source_changed", "recovery_required"].includes(String(value.continuityReason)))
  && (value.continuityBlocker === undefined || safeLabel(value.continuityBlocker)); }
function isQuota(value: unknown): value is QuotaProjectionV3 { return isPlainRecord(value) && isOpaqueAccount(value.opaqueAccountId) && ["fresh", "stale", "unknown"].includes(String(value.freshness)) && (value.remainingPercent === null || typeof value.remainingPercent === "number") && (value.resetAt === null || typeof value.resetAt === "string") && (value.shortWindowPressure === null || typeof value.shortWindowPressure === "number") && (value.resetCredits === null || typeof value.resetCredits === "number") && (value.refreshState === undefined || ["idle", "loading", "error"].includes(String(value.refreshState))) && (value.errorCode === undefined || value.errorCode === null || ["authentication", "connection", "unavailable"].includes(String(value.errorCode))) && (value.lastAttemptAt === undefined || value.lastAttemptAt === null || typeof value.lastAttemptAt === "string"); }
function isConnection(value: unknown): value is ConnectionStateV3 { return isPlainRecord(value) && isOpaqueAccount(value.opaqueAccountId) && isPrivateSurface(value.kind) && isDefinition(value.definitionRef) && ["unknown", "connecting", "connected", "blocked", "unavailable"].includes(String(value.status)); }
function isEnrollment(value: unknown): value is BrokerEnrollmentV1 { return isPlainRecord(value) && typeof value.enrollmentRef === "string" && /^be_[A-Za-z0-9_-]{16,128}$/.test(value.enrollmentRef) && (value.kind === "enrollment" || value.kind === "reconnect") && (value.opaqueAccountId === null || isOpaqueAccount(value.opaqueAccountId)) && ["starting", "waiting", "complete", "cancelled", "failed", "expired"].includes(String(value.state)); }
function isHandoff(value: unknown): value is PendingHandoffV1 { return isPlainRecord(value) && value.version === 1 && typeof value.handoffRef === "string" && /^bh_[A-Za-z0-9_-]{16,128}$/.test(value.handoffRef) && typeof value.confirmationId === "string" && /^bc_[A-Za-z0-9_-]{16,128}$/.test(value.confirmationId) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId) && typeof value.taskRef === "string" && /^bt_[A-Za-z0-9_-]{16,128}$/.test(value.taskRef) && typeof value.originRendererRef === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value.originRendererRef) && isOpaqueAccount(value.fromOpaqueAccountId) && isOpaqueAccount(value.toOpaqueAccountId) && ["pending", "forwarding", "ambiguous", "cancelled", "expired"].includes(String(value.state)) && typeof value.expiresAt === "string"; }
function isTaskOwnership(value: unknown): value is TaskOwnershipV3 { return isPlainRecord(value) && typeof value.taskRef === "string" && /^bt_[A-Za-z0-9_-]{16,128}$/.test(value.taskRef) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId) && isOpaqueAccount(value.opaqueAccountId) && typeof value.ownerRendererRef === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value.ownerRendererRef) && typeof value.activeRunCount === "number" && Number.isInteger(value.activeRunCount) && value.activeRunCount >= 0 && ["none", "pending", "ambiguous"].includes(String(value.handoffState)); }
function isLogicalSubscription(value: unknown): value is LogicalHistorySubscriptionV1 { return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["accountId", "label"].join("\0") && isOpaqueAccount(value.accountId) && safeLabel(value.label); }
function isLogicalConversation(value: unknown): value is LogicalConversationProjectionV1 {
  return isPlainRecord(value) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId)
    && ["complete", "partial", "incomplete", "ambiguous"].includes(String(value.availability)) && Array.isArray(value.segments) && value.segments.length <= 64
    && value.segments.every((segment) => isPlainRecord(segment) && typeof segment.segmentId === "string" && /^ls_[A-Za-z0-9_-]{16,128}$/.test(segment.segmentId) && isLogicalSubscription(segment.subscription) && ["committed", "active", "incomplete", "ambiguous"].includes(String(segment.state)) && (segment.committedAt === undefined || typeof segment.committedAt === "string"))
    && (value.activeClient === null || (isPlainRecord(value.activeClient) && typeof value.activeClient.clientId === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value.activeClient.clientId) && safeLabel(value.activeClient.label) && isLogicalSubscription(value.activeClient.subscription)))
    && (value.historyWarning === undefined || value.historyWarning === null || ["content_gap", "ambiguous"].includes(String(value.historyWarning)))
    && typeof value.peerBusy === "boolean" && typeof value.updatedAt === "string";
}
function isLogicalTurn(value: unknown): value is LogicalTurnProjectionV1 { return isPlainRecord(value) && typeof value.turnId === "string" && /^lt_[A-Za-z0-9_-]{16,128}$/.test(value.turnId) && value.state === "committed" && isLogicalSubscription(value.subscription); }
function isLogicalContinuation(value: unknown): value is LogicalContinuationProjectionV1 { return isPlainRecord(value) && typeof value.confirmationId === "string" && /^bc_[A-Za-z0-9_-]{16,128}$/.test(value.confirmationId) && ["pending", "confirmed", "cancelled", "expired"].includes(String(value.state)) && typeof value.expiresAt === "string" && value.kind === "subscription_switch" && isLogicalSubscription(value.fromSubscription) && isLogicalSubscription(value.toSubscription) && typeof value.conversationId === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value.conversationId); }
function isSafeProfile(value: unknown): value is BrokerSafeProfileV1 { return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["avatarUrl", "identifierMasked", "plan"].join("\0") && (value.plan === null || (typeof value.plan === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(value.plan))) && (value.identifierMasked === null || (typeof value.identifierMasked === "string" && /^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(value.identifierMasked))) && (value.avatarUrl === null || isSafeAvatarUrl(value.avatarUrl)); }
function isSafeAvatarUrl(value: unknown): value is string { if (typeof value !== "string" || value.length < 12 || value.length > 2_048) return false; try { const url = new URL(value); return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password && !url.search && !url.hash && (url.port === "" || url.port === "443"); } catch { return false; } }
function isSafeOAuthUrl(value: unknown): value is string { if (typeof value !== "string" || value.length < 12 || value.length > 2_048) return false; try { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false; for (const [key, item] of url.searchParams) { if (/^(?:access_?token|refresh_?token|id_?token|token|code|client_?secret|credential|cookie)$/i.test(key) || /(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i.test(item)) return false; } return true; } catch { return false; } }
function hash(secret: Buffer, value: string): string { return createHmac("sha256", secret).update(value, "utf8").digest("base64url"); }
function requestIdFrom(value: unknown): string { return isPlainRecord(value) && typeof value.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.requestId) ? value.requestId : "invalid"; }
function invalidRequest(requestId: string): BrokerResponseV1 { return { version: 1, requestId, ok: false, error: { code: "invalid_request", retryable: false } }; }
function unavailable(requestId: string): BrokerResponseV1 { return { version: 1, requestId, ok: false, error: { code: "broker_unavailable", retryable: true } }; }
function assertRendererSafe(value: unknown): void {
  // The generic router redactor intentionally rejects every `email` key.
  // Accounts profiles are allowed to carry a *null or explicitly masked*
  // email field, so validate that narrow public exception before applying the
  // regular redactor to a copy with the display-only field removed.
  assertMaskedPublicProfileFields(value);
  assertRedacted(withoutDisplayOnlyProfileFields(value));
  if (/\b(?:ar|br|bat|bd|bt|bh|be|bc|lc|ls|lt)_[A-Za-z0-9_-]+/.test(JSON.stringify(value))) {
    throw new Error("private accounts broker handle escaped adapter");
  }
}

function assertMaskedPublicProfileFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertMaskedPublicProfileFields(item);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "email") {
      if (item !== null && (typeof item !== "string" || !/^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(item))) {
        throw new Error("unmasked email escaped accounts adapter");
      }
      continue;
    }
    if (key === "avatarUrl" && item !== null) {
      if (!isSafeAvatarUrl(item)) throw new Error("unsafe avatar url");
      continue;
    }
    if (key === "oauthUrl") {
      if (!isSafeOAuthUrl(item)) throw new Error("unsafe oauth handoff");
      continue;
    }
    if (key === "authorizationAvailable") {
      if (typeof item !== "boolean") throw new Error("invalid connection authorization projection");
      continue;
    }
    assertMaskedPublicProfileFields(item);
  }
}

function withoutDisplayOnlyProfileFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDisplayOnlyProfileFields);
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "email" || key === "avatarUrl" || key === "oauthUrl" || key === "authorizationAvailable") continue;
    if (key === "label" && typeof item === "string" && /^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(item)) {
      output[key] = "[masked account identity]";
      continue;
    }
    output[key] = withoutDisplayOnlyProfileFields(item);
  }
  return output;
}

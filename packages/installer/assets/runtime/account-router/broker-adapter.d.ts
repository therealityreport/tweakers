import type { NativeBrowserContextV1 } from "./broker-socket";
import type { AccountPoolAccountV3, AccountsBrokerIpcEnvelopeV1, BrokerEventV1, BrokerRequestEnvelopeV1, BrokerResponseV1, OpaqueAccountId, OpaqueConnectionDefinitionRef, OpaqueEnrollmentRef, PendingHandoffV1, QuotaProjectionV3, OpaqueConversationId, OpaqueSegmentId, OpaqueTurnId, OpaqueRendererRef } from "./types";
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
export interface RendererLogicalSubscriptionV1 {
    accountId: RendererAccountIdV1;
    label: string;
}
export interface RendererLogicalConversationV1 {
    conversationId: RendererConversationIdV1;
    availability: "complete" | "partial" | "incomplete" | "ambiguous";
    historyWarning?: "content_gap" | "ambiguous" | null;
    segments: Array<{
        segmentId: RendererSegmentIdV1;
        subscription: RendererLogicalSubscriptionV1;
        state: "committed" | "active" | "incomplete" | "ambiguous";
        committedAt?: string;
    }>;
    activeClient: {
        clientId: RendererClientIdV1;
        label: string;
        subscription: RendererLogicalSubscriptionV1;
    } | null;
    peerBusy: boolean;
    updatedAt: string;
}
export interface RendererLogicalTurnV1 {
    turnId: RendererTurnIdV1;
    subscription: RendererLogicalSubscriptionV1;
    state: "committed";
}
export interface RendererLogicalContinuationV1 {
    confirmationId: RendererConfirmationIdV1;
    state: "pending" | "confirmed" | "cancelled" | "expired";
    expiresAt: string | null;
    kind: "subscription_switch";
    fromSubscription: RendererLogicalSubscriptionV1;
    toSubscription: RendererLogicalSubscriptionV1;
    conversationId: RendererConversationIdV1;
}
export type RendererBrokerEventTypeV1 = "profile.updated" | "quota.updated" | "enabled.changed" | "connection.updated" | "enrollment.updated" | "reconnect.updated" | "resetCredit.updated" | "continuation.pending" | "continuation.resolved" | "handoff.updated" | "history.updated" | "conversation.updated" | "turn.committed";
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
export interface NativeBrowserRequestEnvelopeV1 {
    accountId: RendererAccountIdV1;
    method: string;
    params: Record<string, unknown>;
}
export interface NativeBrowserPrivateRequestV1 {
    opaqueAccountId: OpaqueAccountId;
    method: string;
    params: Record<string, unknown>;
}
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
export declare class AccountsBrokerRendererAdapterV1 {
    private readonly options;
    private readonly privateAccountByPublic;
    private readonly privateConnectionByPublic;
    /** Scope identities only, so a full authoritative snapshot can notify removal of its last row. */
    private readonly observedConnectionScopes;
    private readonly privateEnrollmentByPublic;
    private readonly privateHandoffByPublic;
    private readonly profiles;
    private readonly quotas;
    private readonly labels;
    /** Task lifecycle events are targeted by the broker, so this is renderer-local state. */
    private readonly activeTaskAccounts;
    private readonly handlers;
    private unsubscribePrivate;
    private eventSequence;
    constructor(options: AccountsBrokerRendererAdapterOptionsV1);
    invoke(envelope: AccountsBrokerIpcEnvelopeV1): Promise<BrokerResponseV1>;
    subscribe(handler: (event: RendererBrokerEventV1) => void): () => void;
    /**
     * Internal main/preload bridge for exact DOM-native targets. This adapter is
     * already bound to one authenticated renderer; it returns public handles
     * only, preserves request order, and never becomes a tweak command.
     */
    mapBoundNativeTargets(request: NativeSharedHistoryMapRequestV1): Promise<NativeSharedHistoryMapResultV1>;
    resolveNativeBrowserContext(accountId: string): Promise<Extract<NativeBrowserContextV1, {
        status: "ready";
    }> | null>;
    translateNativeBrowserRequest(envelope: unknown): NativeBrowserPrivateRequestV1 | null;
    invokeNativeBrowserRequest(accountId: string, method: string, params: unknown): Promise<unknown | null>;
    private translateRequest;
    private translateResult;
    private translateEvent;
    private emitCommandEvent;
    private emit;
    accountId(account: OpaqueAccountId): RendererAccountIdV1;
    /** Kept private to the main-process adapter; never return this to a renderer. */
    opaqueAccountForPublic(accountId: RendererAccountIdV1): OpaqueAccountId | null;
    connectionId(account: OpaqueAccountId, kind: PrivateSurface, definitionRef: OpaqueConnectionDefinitionRef): RendererConnectionIdV1;
    enrollmentId(ref: OpaqueEnrollmentRef): RendererEnrollmentIdV1;
    confirmationId(handoff: PendingHandoffV1): RendererConfirmationIdV1;
    conversationId(value: OpaqueConversationId): RendererConversationIdV1;
    segmentId(value: OpaqueSegmentId): RendererSegmentIdV1;
    turnId(value: OpaqueTurnId): RendererTurnIdV1;
    clientId(value: OpaqueRendererRef): RendererClientIdV1;
    /** Private implementation detail for per-observer projection; never IPC. */
    rendererRef(): OpaqueRendererRef | null;
    /** Internal HMAC capability, used only to derive a public confirmation handle. */
    secret(): Buffer;
    cache(rows: readonly AccountPoolAccountV3[]): void;
    cacheQuota(rows: readonly QuotaProjectionV3[]): void;
    quotaFor(account: OpaqueAccountId): RendererQuotaV1;
    label(account: OpaqueAccountId): string;
    labelsFor(account: OpaqueAccountId, fallback: string): string;
    rememberLabel(account: OpaqueAccountId, label: string): void;
    currentTaskOwner(account: OpaqueAccountId): boolean;
    private recordTaskOwnership;
}
export {};

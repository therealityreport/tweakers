import { type NativeProfileStatisticsResultV1 } from "./profile-statistics";
import { type AccountsPreferencesV1 } from "./preferences";
import type { AccountPoolV3, BrokerBalanceProjectionV1, BrokerRemoteCommandV1, BrokerRemoteProjectionV1, AccountPoolAccountV3, BrokerAccountState, BrokerClientKind, BrokerConnectionKind, BrokerControlStatusV1, BrokerEnrollmentV1, BrokerErrorCode, BrokerEventV1, BrokerHandshakeV1, BrokerHistoryReadProjectionV1, LogicalContinuationProjectionV1, LogicalConversationProjectionV1, LogicalHistorySubscriptionV1, LogicalTurnProjectionV1, BrokerRequestEnvelopeV1, BrokerResponseV1, BrokerSafeProfileV1, ConnectionStateV3, OpaqueAccountId, OpaqueAppToolsRef, OpaqueConnectionDefinitionRef, OpaqueConfirmationId, OpaqueConversationId, OpaqueEnrollmentRef, OpaqueHandoffRef, OpaqueRendererRef, OpaqueTaskRef, PendingHandoffV1, QuotaProjectionV3, RouterConfigV3, TaskOwnershipV3 } from "./types";
export interface BrokerAccountSeedV3 {
    opaqueAccountId: OpaqueAccountId;
    enabled: boolean;
    /** Validated local label, never a provider profile field. */
    label?: string;
    state?: Exclude<BrokerAccountState, "active">;
    /** Durable ledger count, restored without replaying task registrations. */
    assignedTaskCount?: number;
    /** Previously reduced display facts; this is never a raw provider profile. */
    safeProfile?: BrokerSafeProfileV1;
}
export interface BrokerAccountSettingsChangeV1 {
    opaqueAccountId: OpaqueAccountId;
    label?: string;
    enabled?: boolean;
}
/**
 * Main creates this private binding once per desktop process/app session. It
 * prevents a ChatGPT and Tweakers renderer that both happen to be webContents
 * `1` from deriving the same owner endpoint. Neither field crosses a renderer
 * or app-server protocol boundary; only the HMAC opaque refs do.
 */
export interface BrokerDesktopIdentityBindingV1 {
    clientKind: BrokerClientKind;
    bundleIdentity: string;
    sessionNonce: string;
}
export interface BrokerChildV1 {
    readonly opaqueAccountId: OpaqueAccountId;
    /** Child factories must set this after stripping remote-control options. */
    readonly remoteControlDisabled: true;
    terminate(reason: "idle" | "shutdown" | "capacity" | "disabled"): void;
}
export interface BrokerChildFactoryV1 {
    create(input: Readonly<{
        opaqueAccountId: OpaqueAccountId;
        remoteControlDisabled: true;
        storageScope: "account_local";
    }>): BrokerChildV1;
}
export interface BrokerHandoffDeliveryV1 {
    readonly handoffRef: OpaqueHandoffRef;
    readonly confirmationId: OpaqueConfirmationId;
    readonly conversationId: OpaqueConversationId;
    readonly taskRef: OpaqueTaskRef;
    /** The originating desktop remains the app-tools endpoint after a move. */
    readonly originRendererRef: OpaqueRendererRef;
    readonly fromOpaqueAccountId: OpaqueAccountId;
    readonly toOpaqueAccountId: OpaqueAccountId;
    /** Intentionally opaque to callbacks which emit public events. */
    readonly continuation: unknown;
}
/** A pre-dispatch result; only the host may classify a held continuation. */
export type BrokerHandoffDeliveryResultV1 = "delivered" | "ambiguous" | "rejected" | "linked_continuation_required";
export type BrokerHandoffSettlementV1 = "cancelled" | "rejected" | "expired" | "ambiguous" | "linked_continuation_required";
/**
 * Owner-only provider dispatch.  `loginId` and raw provider results never
 * enter broker events or renderer responses; the core reduces them to a
 * bounded device/enrollment projection first.
 */
export type BrokerDeviceActionV1 = {
    kind: "device.start";
    enrollmentRef: OpaqueEnrollmentRef;
    opaqueAccountId: OpaqueAccountId | null;
} | {
    kind: "device.status";
    enrollmentRef: OpaqueEnrollmentRef;
    opaqueAccountId: OpaqueAccountId | null;
    loginId: string;
} | {
    kind: "device.cancel";
    enrollmentRef: OpaqueEnrollmentRef;
    opaqueAccountId: OpaqueAccountId | null;
    loginId: string;
} | {
    kind: "profile.email";
    opaqueAccountId: OpaqueAccountId;
} | {
    kind: "profile.read";
    opaqueAccountId: OpaqueAccountId;
} | {
    kind: "quota.read";
    opaqueAccountId: OpaqueAccountId;
} | {
    kind: "native.request";
    opaqueAccountId: OpaqueAccountId;
    surface: import("./types").NativeRequestSurfaceV1;
    method: string;
    params: Record<string, unknown>;
} | {
    kind: "connection.list";
    opaqueAccountId: OpaqueAccountId;
    connectionKind: BrokerConnectionKind;
} | {
    kind: "connection.status";
    opaqueAccountId: OpaqueAccountId;
    connectionKind: BrokerConnectionKind;
    definitionRef: OpaqueConnectionDefinitionRef;
} | {
    kind: "connection.authorize";
    opaqueAccountId: OpaqueAccountId;
    connectionKind: BrokerConnectionKind;
    definitionRef: OpaqueConnectionDefinitionRef;
} | {
    kind: "resetCredit.consume";
    opaqueAccountId: OpaqueAccountId;
    idempotencyKey: string;
};
export interface BrokerDeviceActionResultV1 {
    outcome: "accepted" | "rejected" | "ambiguous";
    /** Owner-private, bounded provider result; it is validated before use. */
    value?: unknown;
}
/** Returned only by the owner after a private enrollment home is committed. */
export interface BrokerMaterializedAccountV1 {
    opaqueAccountId: OpaqueAccountId;
    safeProfile: BrokerSafeProfileV1;
}
export interface AccountsBrokerOptionsV1 {
    accounts: readonly BrokerAccountSeedV3[];
    /** Owner-private 256-bit capability; it is never emitted or retained in an event. */
    secret: Buffer;
    childFactory?: BrokerChildFactoryV1;
    now?: () => number;
    idleEvictionMs?: number;
    handoffTtlMs?: number;
    /** Persists bounded metadata only; the continuation never enters durable state. */
    onHandoffCreated?: (handoff: PendingHandoffV1) => void;
    /** Persist a user-selected target before the one permitted provider write. */
    onHandoffRetargeted?: (handoff: PendingHandoffV1) => void;
    onHandoffSettled?: (handoff: PendingHandoffV1, state: BrokerHandoffSettlementV1) => void;
    onForwardContinuation?: (delivery: BrokerHandoffDeliveryV1) => BrokerHandoffDeliveryResultV1 | Promise<BrokerHandoffDeliveryResultV1>;
    onDeviceAction?: (action: BrokerDeviceActionV1) => BrokerDeviceActionResultV1 | Promise<BrokerDeviceActionResultV1>;
    /** Materializes an empty enrollment home without copying credentials. */
    onEnrollmentMaterialized?: (enrollment: BrokerEnrollmentV1) => BrokerMaterializedAccountV1 | OpaqueAccountId | null | Promise<BrokerMaterializedAccountV1 | OpaqueAccountId | null>;
    onEnrollmentSettled?: (enrollment: BrokerEnrollmentV1) => void;
    /** Commit config-owned fields before the scheduler changes its mirror. */
    onAccountSettingsChanged?: (change: BrokerAccountSettingsChangeV1) => boolean;
    /** Current authenticated renderer's content-free canonical attribution. */
    onProfileStatistics?: (selection: "pooled" | OpaqueAccountId) => Promise<NativeProfileStatisticsResultV1>;
    onRemoteAction?: (command: BrokerRemoteCommandV1, accountId: OpaqueAccountId, deviceId?: string) => Promise<BrokerRemoteProjectionV1>;
    onPreferencesRead?: () => AccountsPreferencesV1;
    onPreferencesUpdate?: (patch: Partial<AccountsPreferencesV1>) => AccountsPreferencesV1;
    onAccountContinuityRead?: (accountId: OpaqueAccountId) => Pick<AccountPoolAccountV3, "continuityState" | "continuityReason" | "continuityBlocker">;
    onBalanceRead?: () => BrokerBalanceProjectionV1;
    onBalanceSet?: (enabled: boolean) => boolean;
    onHistoryRead?: (rendererRef: OpaqueRendererRef) => BrokerHistoryReadProjectionV1;
}
export interface BrokerHandshakeResultV1 {
    ok: boolean;
    code?: Extract<BrokerErrorCode, "incompatible_client" | "unauthenticated">;
    pool?: AccountPoolV3;
}
export interface BrokerAppToolsRouteV1 {
    taskRef: OpaqueTaskRef;
    appToolsRef: OpaqueAppToolsRef;
    ownerRendererRef: OpaqueRendererRef;
}
/**
 * Single-owner account scheduler and renderer-safe control surface.
 *
 * The broker contains no credential or SQLite API. The only process that may
 * provide a child factory owns those private resources, and the factory is
 * required to create account-local, remote-control-disabled children. This
 * makes the pool ledger independent from child residency and lets a socket
 * owner serve two desktop clients without two raw SQLite writers.
 */
export declare class AccountsBrokerV1 {
    private readonly options;
    private readonly accounts;
    private readonly children;
    private readonly sessions;
    private readonly tasks;
    private readonly handoffs;
    private readonly enrollments;
    private readonly quotas;
    private readonly connections;
    private readonly subscribers;
    private readonly eventBuffers;
    private readonly usedHandshakeNonces;
    private sequence;
    private heldWorkCount;
    private closed;
    private profileRefresh;
    private readonly quotaRefreshes;
    private readonly now;
    private readonly pinnedChildren;
    private readonly idleEvictionMs;
    private readonly handoffTtlMs;
    private browserEvidenceObservedAt;
    /** Restart-recovered forwarding ambiguity has no payload to replay. */
    private recoveredAmbiguousHandoffCount;
    constructor(options: AccountsBrokerOptionsV1);
    /** The proof covers the opaque client identity and one-use nonce, not a request body. */
    handshake(handshake: BrokerHandshakeV1): BrokerHandshakeResultV1;
    /**
     * Runs one authenticated UI/control command. A request id is consumed before
     * action execution, so ambiguous client delivery cannot replay an action.
     */
    invoke(rendererRef: OpaqueRendererRef, envelope: BrokerRequestEnvelopeV1): Promise<BrokerResponseV1>;
    /** Direct main-process subscription; renderers never receive the socket capability. */
    subscribe(rendererRef: OpaqueRendererRef, handler: (event: BrokerEventV1) => void): () => void;
    /** Owner-private helpers may verify the socket's authenticated renderer without exposing session data. */
    hasAuthenticatedRenderer(rendererRef: OpaqueRendererRef): boolean;
    /** Bounded replay buffer used after a main-process reconnect, never by renderers directly. */
    events(rendererRef: OpaqueRendererRef): BrokerEventV1[];
    pool(): AccountPoolV3;
    /** Strict redacted owner-private control projection; no private broker data. */
    status(): BrokerControlStatusV1;
    /** Owner startup records terminal metadata without reconstructing payloads. */
    setRecoveredAmbiguousHandoffCount(count: number): void;
    /** Bridge-only marker; it intentionally records no browser identifier. */
    observeBrowserDelivery(): void;
    quota(): QuotaProjectionV3[];
    connectionStates(): ConnectionStateV3[];
    taskOwnership(taskRef: OpaqueTaskRef): TaskOwnershipV3 | null;
    pendingHandoff(handoffRef: OpaqueHandoffRef): PendingHandoffV1 | null;
    /** Renderer-safe subscription attribution for canonical history projections. */
    logicalSubscription(opaqueAccountId: OpaqueAccountId): LogicalHistorySubscriptionV1 | null;
    /** Host calls these only with canonical-store projections, never raw frames. */
    publishLogicalConversation(conversation: LogicalConversationProjectionV1): void;
    publishLogicalTurn(turn: LogicalTurnProjectionV1): void;
    publishLogicalContinuation(continuation: LogicalContinuationProjectionV1): void;
    /** Owner-only dynamic account admission after its temporary home is committed. */
    addMaterializedAccount(opaqueAccountId: OpaqueAccountId, label?: string, safeProfile?: BrokerSafeProfileV1): boolean;
    /**
     * Called only by the app-server bridge after it has a broker-generated task
     * handle. The private app-server/thread id can be retained internally but is
     * never copied into a control response or event.
     */
    registerTask(input: Readonly<{
        taskRef: OpaqueTaskRef;
        conversationId: OpaqueConversationId;
        opaqueAccountId: OpaqueAccountId;
        ownerRendererRef: OpaqueRendererRef;
        privateThreadKey?: string | null;
        /** True when the owner already exists in the durable ledger. */
        alreadyAssigned?: boolean;
    }>): TaskOwnershipV3 | null;
    /** Acquires a lazy account-local worker. No idle worker is killed while active. */
    acquireChild(opaqueAccountId: OpaqueAccountId): BrokerChildV1 | null;
    /** Host calls only after a proved native resume and durable owner commit. */
    transferNativeTask(taskRef: OpaqueTaskRef, from: OpaqueAccountId, to: OpaqueAccountId): boolean;
    setChildPinned(accountId: OpaqueAccountId, pinned: boolean): void;
    releaseIdleChild(accountId: OpaqueAccountId): BrokerChildV1 | null;
    beginRun(taskRef: OpaqueTaskRef): boolean;
    finishRun(taskRef: OpaqueTaskRef): boolean;
    /** Owner bridge reports an exited child without exposing its process details. */
    markChildUnavailable(opaqueAccountId: OpaqueAccountId): void;
    /** App-tools routing returns only the origin endpoint handle, never request content. */
    routeAppTools(taskRef: OpaqueTaskRef): BrokerAppToolsRouteV1 | null;
    /** The bridge provides current official quota facts after reducing them locally. */
    updateQuota(projection: QuotaProjectionV3): boolean;
    /** Reconcile volatile pool counters with the validated durable ledger. */
    syncAssignedTaskCounts(counts: Readonly<Record<string, number>>): void;
    close(): void;
    /**
     * The app-server connection is the authoritative renderer lease. Control
     * socket churn does not call this method, so a second authenticated channel
     * cannot accidentally evict a live desktop. Pending unsent work is
     * cancelled; a forwarding receipt remains terminally ambiguous.
     */
    disconnectRenderer(rendererRef: OpaqueRendererRef): void;
    /** Public for deterministic owner lifecycle tests and timer-free process hosts. */
    sweep(): void;
    private sweepExpiredOnly;
    private execute;
    private startLifecycle;
    private lifecycleStatus;
    private cancelLifecycle;
    private enrollmentFor;
    private dispatchDevice;
    private updateProfile;
    /**
     * Explicit profile reads refresh only bounded display facts for enabled
     * accounts.  A temporarily unavailable child leaves its prior safe facts in
     * place rather than turning a profile read into an account-login oracle.
     */
    private readProfiles;
    private readQuota;
    private refreshQuota;
    private nativeRequest;
    private setEnabled;
    private listConnections;
    private connectionStatus;
    private authorizeConnection;
    private resetCredit;
    private applyQuota;
    private applyConnectionStates;
    private cachedUnavailableConnections;
    private confirmHandoffFromParams;
    private cancelHandoffFromParams;
    /** Bridge-only helper retains continuation in memory for one bounded handoff window. */
    holdContinuation(input: Readonly<{
        fromRendererRef: OpaqueRendererRef;
        taskRef: OpaqueTaskRef;
        toOpaqueAccountId: OpaqueAccountId;
        continuation: unknown;
    }>): PendingHandoffV1 | null;
    /** Host-only automatic settlement; provider depletion must still be current. */
    continueAutomatically(rendererRef: OpaqueRendererRef, handoffRef: OpaqueHandoffRef): Promise<boolean>;
    private createHandoff;
    private confirmHandoff;
    private cancelHandoff;
    private hasActiveRun;
    private accountProjection;
    private evictChild;
    private emitAll;
    private emit;
}
/** Build the redacted, lazy-pool seed directly from a validated v3 router config. */
export declare function accountPoolSeedsFromRouterConfigV3(config: RouterConfigV3, ledger?: Readonly<Record<string, {
    assignedThreadCount: number;
}>>): BrokerAccountSeedV3[];
export declare function createBrokerHandshakeProof(secret: Buffer, input: Omit<BrokerHandshakeV1, "proof">): string;
export declare function verifyBrokerHandshake(secret: Buffer, handshake: BrokerHandshakeV1): boolean;
export declare function createOpaqueRendererRef(secret: Buffer, webContentsId: number, binding: BrokerDesktopIdentityBindingV1): OpaqueRendererRef;
export declare function createOpaqueAppToolsRef(secret: Buffer, webContentsId: number, binding: BrokerDesktopIdentityBindingV1): OpaqueAppToolsRef;
export declare class BrokerCommandError extends Error {
    readonly code: BrokerErrorCode;
    readonly retryable: boolean;
    constructor(code: BrokerErrorCode, retryable?: boolean);
}
/**
 * Generic redaction correctly rejects all email-like fields.  A broker pool
 * carries one deliberately reduced display mask, so strip only validated
 * `safeProfile` objects before applying the generic recursive policy.
 */
export declare function assertBrokerRedacted(value: unknown): void;
/** Provider names are display text, not URLs, filesystem paths, or account handles. */
export declare function safeConnectionDisplayLabel(value: unknown): string | undefined;
/** Identity is returned only to the caller of the explicit copy-email action. */
export declare function isActionEmail(value: unknown): value is string;
export declare function assertBrokerCommandResult(command: string, value: unknown): void;
export declare function isRemoteCommand(value: unknown): value is BrokerRemoteCommandV1;
export declare function isBrokerRemoteProjection(value: unknown): value is BrokerRemoteProjectionV1;

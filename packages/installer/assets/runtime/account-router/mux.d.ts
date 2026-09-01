import type { RouterConfig, JsonRpcMessage, OpaqueAccountId, RedactedControlStatus } from "./types";
import type { RouterStateStore } from "./state-store";
export interface RouterChild {
    readonly opaqueAccountId: OpaqueAccountId;
    send(message: JsonRpcMessage): void;
    terminate(signal: NodeJS.Signals): void;
    markInitialized?(): void;
}
export interface RouterChildFactory {
    create(account: OpaqueAccountId, handlers: {
        onMessage(message: JsonRpcMessage): void;
        onFailure(): void;
    }): RouterChild;
}
export declare class RouterPreDispatchError extends Error {
    constructor(message?: string);
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
export declare class AccountRouterMux {
    private readonly options;
    private readonly children;
    private readonly correlations;
    private readonly ledger;
    private readonly issued;
    private readonly fanouts;
    private readonly aggregateSessions;
    private readonly sectionSessions;
    private readonly sectionBindings;
    private readonly sectionBindingKeys;
    private readonly pendingReservationsByThread;
    private readonly bufferedStartedThreads;
    private readonly serverRequestsByChild;
    private readonly serverRequestsByDesktop;
    private readonly serverRequestTombstonesByChild;
    private readonly serverRequestTombstonesByDesktop;
    private readonly tokenUsage;
    private readonly refreshInFlight;
    private readonly quota;
    private readonly quotaProbesInFlight;
    private readonly quotaProbeTimers;
    private readonly desktopRequestTimers;
    private readonly expiredQuotaProbeIds;
    private readonly expiredFanoutReplyIds;
    private readonly expiredDesktopRequestIds;
    private readonly consumedRouterCursors;
    private readonly controlSecret;
    private accepting;
    private started;
    private initialized;
    private precisionEstimated;
    private fatalSignalled;
    private shutdownSignalled;
    private quotaProbeNonce;
    private queuedNewThread;
    private queuedNewThreadTimer;
    constructor(options: AccountRouterMuxOptions);
    start(): boolean;
    receiveDesktopLine(line: string): void;
    receiveDesktop(message: JsonRpcMessage): void;
    status(): RedactedControlStatus;
    shutdown(): void;
    private routeDesktopRequest;
    private initialize;
    private dispatchNewThread;
    /** A request is delivered once, only after fresh two-account capacity exists. */
    private dispatchSelectedNewThread;
    private dispatchFanout;
    /** Read-only section namespace. Local section ids never cross the mux. */
    private dispatchSectionRead;
    /** A resolved router section confines the read to its single owning home. */
    private dispatchSectionFilteredList;
    private sectionRequest;
    private createSectionSession;
    private evictExpiredSectionSessions;
    private sectionRouterId;
    private resolveSectionBinding;
    /**
     * A router cursor is the only accepted continuation token for a fanout read.
     * It binds method and all non-cursor filter fields so a child cursor cannot be
     * replayed against another request shape or method.
     */
    private aggregateRequest;
    private createAggregateSession;
    private resetAggregateSession;
    private aggregateSessionTtl;
    private evictExpiredAggregateSessions;
    private bindAggregateThreads;
    private appendAggregatePage;
    /**
     * Parse every child response first, then atomically bind the complete batch
     * before changing in-memory pagination buffers. This keeps durable affinity
     * and assigned counts unchanged if the second child is malformed/collides.
     */
    private appendAggregatePages;
    private aggregatePagesHaveOwnerCollision;
    /** Rewrite only known nested section ids; a local id is never exposed. */
    private rewriteAggregatePage;
    private rewriteAggregateSectionEntry;
    private rewriteThreadSection;
    /** Rewrite section references in direct responses and notifications too. */
    private rewriteChildSections;
    private appendSectionPages;
    private sectionPageResult;
    private aggregatePageResult;
    /** A read failure is request-local; only init or proven owner collision stops routing. */
    private failFanout;
    private discardFanoutIssued;
    private startFanoutTimeout;
    private rememberExpiredFanoutReply;
    private childForRoute;
    private dispatchToChild;
    private handleChildMessage;
    private handleChildResponse;
    private resolveTerminalNewThreadError;
    private bufferOrBindStartedThread;
    private takeBufferedStartedThread;
    /** A review may remain on its source thread or return one new detached id. */
    private validateReviewDelivery;
    private recordFanoutResponse;
    private completeFanout;
    private handleChildRequest;
    private routeDesktopResponse;
    /**
     * The child resolves with its local request id after the desktop has only
     * ever seen the mux id. Preserve the mapping until this terminal notice,
     * rewrite only that id, then retain a bounded tombstone for late replies.
     */
    private resolveServerRequestNotification;
    private expireServerRequest;
    private rememberServerRequestTombstone;
    private serverRequestTimeout;
    private handleChildNotification;
    private recordTokenUsage;
    private reconcileTerminal;
    private clearTokenUsageForThread;
    /** Issue one bounded pair of official app-server reads per enrolled child. */
    private refreshAllQuota;
    private refreshQuotaFor;
    private issueQuotaProbe;
    private recordQuotaProbe;
    private recordQuotaProbeFailure;
    private startQuotaProbeTimeout;
    private clearQuotaProbeTimeout;
    /**
     * A written desktop request may be a long history read, tool call, or
     * provider-backed operation. The mux has no authoritative per-method time
     * budget, so its bounded direct-correlation pool—not a fabricated deadline—
     * is the liveness guard. Terminal reply, child failure, or shutdown cleans it.
     */
    private startDesktopRequestTimeout;
    private clearDesktopRequestTimeout;
    private rememberExpiredDesktopRequest;
    private rememberExpiredQuotaProbe;
    private updateQuotaEligibility;
    /** Queue only one never-yet-delivered start while stale capacity is refreshed. */
    private queueNewThreadForQuotaRefresh;
    private drainQueuedNewThread;
    private clearQueuedNewThread;
    private quotaNeedsRefresh;
    private quotaAwareStatus;
    private quotaStatusAccount;
    private pendingQuotaIntent;
    private now;
    private setTimer;
    private clearTimer;
    /** Long-lived direct work is bounded by correlation capacity, not time. */
    private activeDirectRequestCount;
    /**
     * There is no live atomic effective-capability oracle across two private
     * homes. A capability-changing write is therefore never dispatched under
     * balanced routing: make the restart requirement durable and stop safely.
     */
    private stageCapabilityRestartRequired;
    private protocolDrift;
    private postStartFailure;
    private signalFatal;
}
export {};

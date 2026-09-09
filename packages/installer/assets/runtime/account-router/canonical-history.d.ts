import type { LogicalConversationProjectionV1, LogicalHistorySubscriptionV1, LogicalTurnProjectionV1, OpaqueAccountId, OpaqueConversationId, OpaqueRendererRef, OpaqueSegmentId, OpaqueTurnId } from "./types";
/** Broker-owned, private logical transcript. It is not an account-home store. */
export declare const CANONICAL_HISTORY_FILE_V1 = "canonical-history.v1.json";
export declare const CANONICAL_HISTORY_JOURNAL_FILE_V1 = "canonical-history.v1.journal.jsonl";
export declare const CANONICAL_HISTORY_VERSION_V1: 1;
export declare const CANONICAL_HISTORY_MAX_BYTES_V1: number;
export declare const CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1: number;
export declare const CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 = 16384;
type LogicalAvailability = "complete" | "partial" | "incomplete" | "ambiguous";
export type CanonicalTurnPhaseV1 = "prepared" | "dispatching" | "active" | "committed" | "aborted" | "ambiguous";
/** A deliberately portable, credential-free subset of a completed Turn.items. */
export interface PortableTranscriptItemV1 {
    kind: "user" | "assistant" | "plan" | "tool";
    text?: string;
    name?: string;
    result?: string;
}
export interface CanonicalHistoryPreflightV1 {
    version: 1;
    fileName: typeof CANONICAL_HISTORY_FILE_V1;
    state: "ready" | "missing" | "invalid";
    conversationCount: number;
    segmentCount: number;
}
export interface CanonicalHistorySubscriptionResolverV1 {
    (accountId: OpaqueAccountId): LogicalHistorySubscriptionV1 | null;
}
export interface CanonicalHistoryCreateInputV1 {
    opaqueAccountId: OpaqueAccountId;
    nativeThreadId: string;
    ownerRendererRef: OpaqueRendererRef;
    ownerLabel: string;
    title?: string | null;
}
export interface CanonicalHistorySegmentInputV1 extends CanonicalHistoryCreateInputV1 {
    conversationId: OpaqueConversationId;
}
export interface CanonicalContinuationContextV1 {
    digest: `sha256:${string}`;
    /** Owner-private, bounded context inserted into a supported turn/start additionalContext field. */
    text: string;
}
/**
 * Strict preflight for offline migration and startup guards. It is intentionally
 * read-only and does not create, repair, or migrate a history file.
 */
export declare function preflightCanonicalHistoryStore(root: string): CanonicalHistoryPreflightV1;
/**
 * The only explicit empty-history bootstrap. Runtime loading deliberately
 * does not call this: V3 startup must distinguish a deliberately initialized
 * empty transcript from a missing migration artifact and fail closed for the
 * latter.
 */
export declare function bootstrapCanonicalHistoryStoreV1(root: string): void;
/**
 * Canonical logical conversation storage. Provider native ids and serialized
 * input remain private to the broker root and never appear in projections.
 */
export declare class CanonicalHistoryStoreV1 {
    readonly root: string;
    private readonly now;
    private readonly random;
    private readonly publicThreadIdForNative;
    private state;
    constructor(root: string, now: (() => number) | undefined, random: ((size: number) => Buffer) | undefined, publicThreadIdForNative: (nativeThreadId: string) => string);
    get path(): string;
    get journalPath(): string;
    conversationForNative(opaqueAccountId: OpaqueAccountId, nativeThreadId: string): OpaqueConversationId | null;
    conversationForPublicThreadId(publicThreadId: string): OpaqueConversationId | null;
    hasConversations(): boolean;
    publicThreadId(conversationId: OpaqueConversationId): string | null;
    /** One canonical conversation has one writer lease at a time. */
    hasActiveTurn(conversationId: OpaqueConversationId): boolean;
    /** Bootstrap bindings have no canonical turn evidence and stay out of history UI. */
    hasRecordedTurns(conversationId: OpaqueConversationId): boolean;
    /** Owner-private routing alias; callers must never send it through renderer IPC. */
    rootNativeThreadId(conversationId: OpaqueConversationId): string | null;
    /** Owner-private, immutable physical read routes in conversation order; never renderer IPC. */
    orderedNativeSegments(conversationId: OpaqueConversationId): readonly Readonly<{
        opaqueAccountId: OpaqueAccountId;
        nativeThreadId: string;
    }>[] | null;
    /** Bounded physical binding used only by the runtime-owned native target bridge. */
    publicTurnIdsForNative(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string, nativeTurnIds: readonly string[]): ReadonlyMap<string, OpaqueTurnId> | null;
    /** Exact native turn/item identity lookup for the runtime-owned DOM bridge. */
    publicTurnIdsForConversation(conversationId: OpaqueConversationId, nativeTurnIds: readonly string[]): ReadonlyMap<string, OpaqueTurnId> | null;
    /** The active segment routes a desktop's stable public thread alias. */
    activeNativeThread(conversationId: OpaqueConversationId): {
        opaqueAccountId: OpaqueAccountId;
        nativeThreadId: string;
    } | null;
    createConversation(input: CanonicalHistoryCreateInputV1): OpaqueConversationId;
    addSegment(input: CanonicalHistorySegmentInputV1): OpaqueSegmentId;
    /** Reconcile an already-proved native writer without inventing a live desktop owner. */
    reconcileNativeWriter(conversationId: OpaqueConversationId, account: OpaqueAccountId, nativeThreadId: string): void;
    /** Native same-ID transfer preserves every prior turn and the visible conversation. */
    activateNativeWriter(input: CanonicalHistorySegmentInputV1): void;
    beginTurn(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string, ownerRendererRef: OpaqueRendererRef, ownerLabel: string, input: unknown): OpaqueTurnId;
    commitTurn(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string, nativeTurnId: string | null, completedItems: unknown): OpaqueTurnId | null;
    markIncomplete(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void;
    /**
     * Preserve a known cross-subscription continuity gap without retaining the
     * rejected request, attachment, path, or provider-side target.  The record
     * belongs to the already-bound source segment and is terminal before any
     * destination child is acquired.
     */
    recordLinkedContinuationRequired(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): OpaqueTurnId;
    markTurnDispatching(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void;
    markTurnActive(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void;
    markAmbiguous(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void;
    /**
     * A broker restart has no reliable child-write acknowledgement. A prepared
     * turn is proven not to have left the broker, while dispatching/active turns
     * may have reached a child. Settle those two classes differently and never
     * replay either one automatically.
     */
    recoverInFlightTurns(): {
        aborted: number;
        ambiguous: number;
    };
    continuityContext(conversationId: OpaqueConversationId): CanonicalContinuationContextV1 | null;
    project(conversationId: OpaqueConversationId, subscriptionFor: CanonicalHistorySubscriptionResolverV1): LogicalConversationProjectionV1 | null;
    projectCommittedTurn(conversationId: OpaqueConversationId, turnId: OpaqueTurnId, subscriptionFor: CanonicalHistorySubscriptionResolverV1): LogicalTurnProjectionV1 | null;
    /** Private, completed-only canonical data for the reserved host history bridge. */
    portableTranscript(conversationId: OpaqueConversationId): ReadonlyArray<Readonly<{
        turnId: OpaqueTurnId;
        items: readonly PortableTranscriptItemV1[];
    }>> | null;
    logicalList(): ReadonlyArray<Readonly<{
        conversationId: OpaqueConversationId;
        publicThreadId: string;
        title: string;
        availability: LogicalAvailability;
        updatedAt: string;
    }>>;
    logicalRead(publicThreadId: string): Readonly<{
        conversationId: OpaqueConversationId;
        publicThreadId: string;
        title: string;
        availability: LogicalAvailability;
        createdAt: string;
        updatedAt: string;
        turns: ReadonlyArray<Readonly<{
            turnId: OpaqueTurnId;
            items: readonly PortableTranscriptItemV1[];
        }>>;
    }> | null;
    private markTerminal;
    private markTurnPhase;
    private newSegment;
    private findConversation;
    private findSegment;
    private hasTurn;
    private mutate;
    private load;
    private recoverJournal;
    private timestamp;
    /** Reject size-invalid writes before a journal byte can affect recovery. */
    private assertWritableSizes;
}
export {};

import type { EligibilityState, OpaqueAccountId, Reservation, RouterConfig, RouterState } from "./types";
import type { RouterStateStore } from "./state-store";
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}
export type FairnessPrecision = "projected" | "exact_completed_spend" | "estimated";
export interface AccountSelection {
    opaqueAccountId: OpaqueAccountId;
    normalizedSpend: number;
}
/**
 * The ledger is deliberately local: it allocates request work fairly without
 * claiming to know provider-side quota consumption. Every debit is durable
 * before a byte can be written to a selected child.
 */
export declare class AccountLedger {
    private readonly store;
    private readonly config;
    private readonly now;
    private readonly random;
    private readonly lastSelection;
    private readonly outputHistory;
    private estimated;
    constructor(store: RouterStateStore, config: RouterConfig, now?: () => number, random?: (length: number) => Buffer);
    get precision(): FairnessPrecision;
    estimateRequestCost(params: unknown, model?: string): number;
    select(requirement?: (account: OpaqueAccountId) => boolean): AccountSelection | null;
    reserve(opaqueAccountId: OpaqueAccountId, estimatedCost: number): Reservation;
    releasePreDispatch(reservationId: string): void;
    strandAmbiguous(reservationId: string): void;
    reconcile(reservationId: string, usage: TokenUsage | null, model?: string): void;
    bindThread(threadId: string, owner: OpaqueAccountId, pendingKey: string): void;
    /** Bind a child-observed thread event before forwarding it to the desktop. */
    bindObservedThread(threadId: string, owner: OpaqueAccountId): boolean;
    bindKnownThread(threadId: string, owner: OpaqueAccountId): void;
    reservePendingOwner(pendingKey: string, owner: OpaqueAccountId): void;
    clearPendingOwner(pendingKey: string, owner: OpaqueAccountId): void;
    ownerFor(threadId: string): OpaqueAccountId | null;
    setEligibility(opaqueAccountId: OpaqueAccountId, eligibility: EligibilityState): void;
    resetEpoch(): void;
    private transitionReservation;
    private rollingOutputMedian;
}
export declare function normalizedSpend(state: RouterState, opaqueAccountId: OpaqueAccountId): number;

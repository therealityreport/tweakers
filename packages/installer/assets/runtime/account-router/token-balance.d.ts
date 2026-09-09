import { type OpaqueAccountId } from "./types";
/** Owner-private v1 token accounting. This is intentionally separate from router-state. */
export declare const TOKEN_BALANCE_FILE_V1 = "token-balance-v1.json";
declare const TOKEN_BALANCE_VERSION: 1;
export interface TokenBalanceAccountInput {
    opaqueAccountId: OpaqueAccountId;
    included: boolean;
}
export interface TokenBalanceLedgerOptions {
    root: string;
    accounts: readonly TokenBalanceAccountInput[];
    /** Injected by tests; production uses the local wall clock. */
    now?: () => number;
    /** Injected by tests; production uses cryptographic random bytes. */
    random?: (size: number) => Buffer;
    fileName?: string;
}
export type TokenBalancePrecision = "exact" | "partial" | "unknown";
export type TokenBalanceReservationState = "reserved" | "dispatched" | "observed" | "settled" | "released_pre_dispatch" | "uncertain_after_restart";
/** Owner-private return value. `threadId` and `turnId` never belong in a UI projection. */
export interface TokenBalanceReservation {
    reservationId: string;
    opaqueAccountId: OpaqueAccountId;
    estimatedTokens: number;
    state: TokenBalanceReservationState;
    threadId: string | null;
    turnId: string | null;
    createdAt: string;
    observedTokens: number;
    missingUsage: boolean;
}
export interface TokenBalanceChoice {
    opaqueAccountId: OpaqueAccountId;
    /** Measured completed tokens plus outstanding reservation estimates. */
    projectedTokens: number;
    precision: TokenBalancePrecision;
}
export interface TokenBalanceObservation {
    addedTokens: number;
    precision: TokenBalancePrecision;
    /** A private correlation only; `null` means usage was still charged to its account. */
    reservationId: string | null;
}
/** Deliberately small, account-level projection suitable for a broker status reducer. */
export interface TokenBalanceAccountSummary {
    opaqueAccountId: OpaqueAccountId;
    included: boolean;
    completedTokens: number;
    /** Null when any aggregate-only token observations prevent an honest split. */
    completedInputTokens: number | null;
    /** Null when any aggregate-only token observations prevent an honest split. */
    completedOutputTokens: number | null;
    /** Outstanding estimates only. It is never an exact provider usage value. */
    reservedTokens: number;
    /** Settled but not yet reported provider usage retained as a conservative debit. */
    unreportedTokens: number;
    /** `completedTokens + unreportedTokens + reservedTokens`; this is explicitly a projection, never exact usage. */
    estimatedTokens: number;
    precision: TokenBalancePrecision;
    /** Completed, measured-token share since this ledger's persisted baseline. */
    sharePercent: number | null;
}
export interface TokenBalanceSnapshot {
    version: typeof TOKEN_BALANCE_VERSION;
    baseline: {
        startedAt: string;
    };
    accounts: TokenBalanceAccountSummary[];
    uncertainReservationCount: number;
    /** Counts only; provider IDs and private reservation records remain private. */
    reservations: {
        active: number;
        uncertain: number;
        missingUsage: number;
    };
    observations: {
        threadCount: number;
        lastOnlyCount: number;
        outOfOrderTotalCount: number;
    };
}
/**
 * A durable, single-owner ledger for the broker. Provider quota decides which
 * accounts are eligible; this class only compares token spend among that set.
 *
 * It deliberately charges only positive deltas from `tokenUsage.total`.
 * `tokenUsage.last` is retained as bounded evidence for missing totals, but
 * cannot safely be counted because the protocol supplies no completion ID.
 */
export declare class TokenBalanceLedger {
    private readonly options;
    private state;
    private readonly configured;
    private orderedConfigured;
    private readonly now;
    private readonly random;
    readonly fileName: string;
    constructor(options: TokenBalanceLedgerOptions);
    /** Select only from the caller's quota-eligible subset. No provider quota enters the ledger. */
    choose(eligibleAccountIds: readonly OpaqueAccountId[]): TokenBalanceChoice | null;
    projectedTokens(opaqueAccountId: OpaqueAccountId): Omit<TokenBalanceChoice, "opaqueAccountId"> | null;
    /**
     * Update the ledger's in-memory view of broker configuration without
     * dropping historical accounts or in-flight reservations. The broker owns
     * config persistence and calls this after its own config commit.
     */
    setAccounts(accounts: readonly TokenBalanceAccountInput[]): void;
    /**
     * Native in-place history has no trustworthy cumulative token baseline.
     * Keep that fact durable and idempotent instead of presenting historical
     * spend as an exact zero.  It does not create a reservation or charge a
     * provider total; broker-controlled work still begins at this ledger's
     * own baseline.
     */
    markImportedHistoryUnmeasured(accounts: readonly OpaqueAccountId[]): void;
    /** Atomically reserve an account before the caller is permitted to write to its provider child. */
    begin(input: Readonly<{
        opaqueAccountId: OpaqueAccountId;
        reservationId?: string;
        estimatedTokens: number;
    }>): TokenBalanceReservation;
    /** Idempotently records the point after the one provider write may have happened. */
    markDispatched(reservationId: string): void;
    /** Attach private provider IDs once a start reply or notification supplies them. */
    bind(reservationId: string, binding: Readonly<{
        threadId: string;
        turnId?: string | null;
    }>): void;
    /**
     * Owner-private restart correlation. This intentionally returns only a
     * local reservation ID and is not included in `snapshot()`: host recovery
     * can feed a delayed official total back into the exact pending/debt record
     * without exposing a provider thread ID through broker status or UI data.
     */
    reservationForThread(input: Readonly<{
        opaqueAccountId: OpaqueAccountId;
        threadId: string;
        turnId?: string | null;
    }>): string | null;
    /** This is the sole release path, and proves no provider dispatch occurred. */
    releasePreDispatch(reservationId: string): void;
    /**
     * Capture an existing thread's known cumulative total before dispatch. This
     * prevents its imported/history usage from being charged to the next turn.
     */
    seedThreadBaseline(input: Readonly<{
        opaqueAccountId: OpaqueAccountId;
        threadId: string;
        tokenUsage: unknown;
    }>): void;
    /**
     * Reconcile an official `thread/tokenUsage/updated` payload. Only positive
     * deltas from nested `tokenUsage.total` are charged. A last-only payload is
     * deliberately visible as partial evidence but never counted as exact usage.
     */
    observe(input: Readonly<{
        opaqueAccountId: OpaqueAccountId;
        threadId: string;
        turnId?: string | null;
        reservationId?: string | null;
        tokenUsage: unknown | null;
    }>): TokenBalanceObservation;
    /**
     * Remove a known terminal dispatch from projected spend. If no valid total
     * was observed, retain a missing-usage marker; a later total still accrues.
     */
    settle(reservationId: string): void;
    /** Persist restart ambiguity without replaying or releasing a possible provider write. */
    recover(): {
        uncertainReservations: number;
    };
    /**
     * Finish owner-election recovery without replaying a possible provider
     * write. Each uncertain record becomes terminal missing usage and retains a
     * conservative debit that a later official cumulative delta can replace.
     * The existing recovery uncertainty remains in account precision.
     */
    terminalizeUncertainAfterRecovery(): {
        terminalized: number;
    };
    accountSummary(opaqueAccountId: OpaqueAccountId): TokenBalanceAccountSummary | null;
    /** Public-safe snapshot: no thread, turn, reservation, or provider identifiers. */
    snapshot(): TokenBalanceSnapshot;
    private get path();
    private load;
    private update;
    private persist;
    private timestamp;
}
export {};

import type { OpaqueAccountId } from "./types";
/** Provider readings older than two minutes are never capacity evidence. */
export declare const QUOTA_STALE_AFTER_MS: number;
export type AccountHealth = "authenticated" | "reauth_required" | "disabled" | "unhealthy";
export interface AccountReadObservation {
    health: AccountHealth;
    plan: string | null;
    observedAt: number | null;
}
export interface RateLimitObservation {
    weeklyRemainingPercent: number | null;
    weeklyResetAt: number | null;
    shortWindowPressure: number | null;
    /** Present only when the provider supplied the exact five-hour reset. */
    shortWindowResetAt?: number | null;
    /** A non-null server-classified reached type makes the bucket ineligible. */
    rateLimitReached?: boolean;
    observedAt: number | null;
    resetCredits?: number | null;
}
export interface AccountQuotaObservation extends AccountReadObservation, RateLimitObservation {
}
export interface QuotaSelectionCandidate {
    opaqueAccountId: OpaqueAccountId;
    weeklyRemainingPercent: number;
    weeklyResetAt: number;
    shortWindowPressure: number | null;
    assignedThreadCount: number;
    resetCredits?: number | null;
    configuredIndex: number;
}
export declare function emptyQuotaObservation(): AccountQuotaObservation;
/**
 * `account/read` is only trusted after a successful reply from that child. We
 * retain no provider identifier: the caller keeps only health and a safe plan
 * name for the redacted local status projection.
 */
export declare function parseAccountRead(result: unknown, now: number): AccountReadObservation | null;
/**
 * Read only documented app-server rate-limit shapes. The walker supports the
 * known keyed and list forms without retaining any unrecognized provider data.
 */
export declare function parseRateLimitsRead(result: unknown, now: number): RateLimitObservation | null;
export declare function quotaFreshness(observation: AccountQuotaObservation, now: number): "fresh" | "stale" | "unknown";
export declare function accountObservationEligible(observation: AccountQuotaObservation, now: number): boolean;
export declare const ROUTING_MINIMUM_WINDOW_MS = 60000;
export declare const ROUTING_FALLBACK_WINDOW_MS: number;
export declare const ROUTING_RESET_BONUS_PER_CREDIT = 0.15;
export declare const ROUTING_RESET_BONUS_CREDIT_CAP = 3;
export declare function quotaUrgencyScore(candidate: QuotaSelectionCandidate, now: number): number;
/** Upstream urgency and stable tie-breaks, after fresh capacity eligibility. */
export declare function compareQuotaCandidates(left: QuotaSelectionCandidate, right: QuotaSelectionCandidate, now: number): number;
/** Missing/stale capacity is not evidence that an existing subscription is depleted. */
export declare function hasConfirmedQuotaDepletion(quota: {
    freshness: string;
    observedAt?: number | null;
    remainingPercent: number | null;
    resetAt: string | null;
    shortWindowPressure: number | null;
    shortWindowResetAt?: number | null;
    rateLimitReached?: boolean;
} | undefined, now?: number): boolean;

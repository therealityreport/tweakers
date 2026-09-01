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
    observedAt: number | null;
}
export interface AccountQuotaObservation extends AccountReadObservation, RateLimitObservation {
}
export interface QuotaSelectionCandidate {
    opaqueAccountId: OpaqueAccountId;
    weeklyRemainingPercent: number;
    weeklyResetAt: number;
    shortWindowPressure: number | null;
    assignedThreadCount: number;
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
/** Higher weekly remaining percentage per remaining reset time wins. */
export declare function compareQuotaCandidates(left: QuotaSelectionCandidate, right: QuotaSelectionCandidate, now: number): number;

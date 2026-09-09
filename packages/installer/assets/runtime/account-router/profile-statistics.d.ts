import { type OpaqueAccountId } from "./types";
type SafeReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type SafeInvocationType = "plugin" | "skill" | "other";
interface SafeUsageBucket {
    startDate: string;
    tokens: number;
}
interface SafeInvocation {
    type: SafeInvocationType;
    label: string;
    usageCount: number;
}
interface SafeStats {
    lifetimeTokens: number;
    peakDailyTokens: number;
    currentStreakDays: number;
    longestStreakDays: number;
    totalThreads: number;
    longestRunningTurnSec: number;
    fastModeUsagePercentage: number;
    totalSkillsUsed: number;
    uniqueSkillsUsed: number;
    mostUsedReasoningEffort: SafeReasoningEffort | null;
    mostUsedReasoningEffortPercentage: number;
    dailyUsageBuckets: SafeUsageBucket[];
    cumulativeDailyUsageBuckets: SafeUsageBucket[];
    weeklyUsageBuckets: SafeUsageBucket[];
    topInvocations: SafeInvocation[];
}
interface StatisticsAccount {
    accountId: OpaqueAccountId;
    codexHome: string;
    enabled: boolean;
}
interface ProfileFetchResponse {
    status: number;
    redirected?: boolean;
    url?: string;
    body: ReadableStream<Uint8Array> | null;
}
type ProfileStatisticsFetch = (url: string, init: Readonly<{
    method: "GET";
    headers: Readonly<Record<"Authorization" | "ChatGPT-Account-ID", string>>;
    signal: AbortSignal;
    redirect: "error";
}>) => Promise<ProfileFetchResponse>;
interface NativeProfileStatisticsOptions {
    secret: Buffer;
    accounts: () => readonly StatisticsAccount[];
    fetch?: ProfileStatisticsFetch;
}
/**
 * The only profile-statistics value permitted across the owner/broker seam.
 * It intentionally carries no provider profile, account identifier, endpoint,
 * credential, local path, or raw invocation identifier.
 */
export type NativeProfileStatisticsResultV1 = {
    selection: "pooled" | OpaqueAccountId;
    partial: boolean;
    accounts: Array<{
        accountId: OpaqueAccountId;
        state: "ready" | "unavailable";
        stats: SafeStats | null;
    }>;
    stats: SafeStats | null;
    observedAt: number;
};
/**
 * Reads the fixed native profile statistics endpoint from verified account
 * homes. Only already-sanitized statistics are retained, and only in memory.
 */
export declare class NativeProfileStatisticsV1 {
    private readonly secret;
    private readonly accounts;
    private readonly fetcher;
    private readonly cache;
    constructor(options: NativeProfileStatisticsOptions);
    read(selection: "pooled" | OpaqueAccountId): Promise<NativeProfileStatisticsResultV1>;
    private snapshotAccounts;
    private readAccount;
    private cachedStats;
    private fetchAccountStats;
    private fetchAndSanitize;
}
/** Strictly validates the public, sanitized statistics result before it crosses a broker seam. */
export declare function isNativeProfileStatisticsResultV1(value: unknown): value is NativeProfileStatisticsResultV1;
export {};

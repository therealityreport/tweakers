export declare const NATIVE_REQUEST_MAX_RESULT_BYTES: number;
export declare const NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES: number;
export declare const NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES: number;
export type NativeRequestSurfaceV1 = "profile" | "apps" | "plugins" | "mcp" | "usage";
export interface NativeRequestV1 {
    surface: NativeRequestSurfaceV1;
    method: string;
    params: Record<string, unknown>;
}
export declare function parseNativeRequestV1(value: unknown): NativeRequestV1 | null;
/** Exact main-owned child RPCs used after a selected-account browser action. */
export declare function parseNativeBrowserChildRequestV1(method: unknown, params: unknown): {
    method: string;
    params: Record<string, unknown>;
} | null;
export declare function isNativeRequestSurfaceV1(value: unknown): value is NativeRequestSurfaceV1;
export declare function isBoundedNativeResultV1(value: unknown, surface?: NativeRequestSurfaceV1): boolean;
export declare function requestNativeUsageCreditsV1(codexHome: string, method: "usage.credits.read" | "usage.credits.consume", params: Record<string, unknown>): Promise<unknown>;
export type UsageAnalyticsParamsV1 = {
    kind: "thread-usage";
    preferred_source?: "query_v1";
    threads: Array<{
        thread_id: string;
        created_at: string | null;
        descendant_thread_ids: string[];
    }>;
} | {
    kind: "plan-history";
    days: 7;
} | {
    kind: "daily-history";
    start_date: string;
    end_date: string;
} | {
    kind: "credit-events";
};
type UsageAnalyticsResultV1 = {
    status: "full" | "partial" | "unsupported" | "authentication-error" | "transient-error";
    source: "query_v2" | "query_v1" | "plan_limit_history" | "daily_token_usage_breakdown" | "credit_usage_events" | null;
    value: unknown | null;
};
/**
 * Read-only, account-bound Analytics transport. HTTP status is data here:
 * renderer compatibility code must distinguish an unshipped endpoint from a
 * stale login or a retryable provider failure without ever receiving tokens.
 */
export declare function requestNativeUsageAnalyticsV1(codexHome: string, params: UsageAnalyticsParamsV1): Promise<UsageAnalyticsResultV1>;
export declare function requestNativeHttpV1(codexHome: string, surface: "apps" | "plugins", params: Record<string, unknown>): Promise<unknown>;
interface NativeHttpTargetV1 {
    verb: "GET" | "POST";
    path: string;
    query: Readonly<Record<string, string | boolean>>;
    body?: Record<string, unknown>;
}
/** The broker must route plugin control reads through its installed authority. */
export declare function parseNativePluginHttpTargetV1(value: Record<string, unknown>): NativeHttpTargetV1 | null;
export {};

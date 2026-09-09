import type { AccountPoolAccountV3, QuotaProjectionV3 } from "./types";
/** One conservative native snapshot feeds the usage sheet and native limit indicators. */
export declare function pooledNativeQuotaV1(accounts: readonly AccountPoolAccountV3[], quotas: readonly QuotaProjectionV3[], now?: number): Record<string, unknown>;

/** The legacy on-disk/state contract. Keep this export for v1 consumers. */
export declare const ACCOUNT_ROUTER_SCHEMA_VERSION: 1;
export declare const ACCOUNT_ROUTER_SCHEMA_VERSION_V2: 2;
export declare const ACCOUNT_ROUTER_CONTRACT_FINGERPRINT: "sha256:6f9d6889bd23ff1122a89b417348b7346cdaa76ced1173eae8c7f8d0608113c2";
export declare const ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
export type OpaqueAccountId = `ar_${string}`;
export type JsonRpcId = string | number;
export type RouterModeV1 = "manual" | "balanced";
export type RouterModeV2 = "manual" | "quota_aware";
export type RouterMode = RouterModeV1 | RouterModeV2;
export type EligibilityState = "validating" | "eligible" | "reserved" | "active" | "cooldown" | "quota_depleted" | "reauth_required" | "plugin_blocked" | "protocol_blocked" | "disabled" | "unhealthy";
export interface RouterAccountConfigV1 {
    opaqueAccountId: OpaqueAccountId;
    included: boolean;
    weight: number;
    capabilityFingerprint: `sha256:${string}`;
}
export interface RouterAccountConfigV2 extends RouterAccountConfigV1 {
    /** User-authored local label. It is deliberately not a provider identity. */
    label: string;
}
export interface RouterConfigV1 {
    schemaVersion: 1;
    mode: RouterModeV1;
    protocolFingerprint: `sha256:${string}`;
    primaryOpaqueAccountId: OpaqueAccountId;
    accounts: [RouterAccountConfigV1, RouterAccountConfigV1];
    updatedAt: string;
}
/**
 * A v2 file is an immutable pending intent. `generation` is supplied by the
 * owner/UI and the fingerprint binds every routing-relevant field except its
 * own digest and the write timestamp.
 */
export interface RouterConfigV2 {
    schemaVersion: 2;
    mode: RouterModeV2;
    policy: "quota_aware_v1" | null;
    generation: number;
    fingerprint: `sha256:${string}`;
    protocolFingerprint: `sha256:${string}`;
    primaryOpaqueAccountId: OpaqueAccountId;
    accounts: [RouterAccountConfigV2, RouterAccountConfigV2];
    updatedAt: string;
}
export type RouterConfig = RouterConfigV1 | RouterConfigV2;
export type CorrelationDirection = "client_to_child" | "child_to_client";
export type DispatchState = "prepared" | "written" | "acknowledged" | "terminal";
export interface CorrelationRecord {
    schemaVersion: 1;
    direction: CorrelationDirection;
    childOpaqueAccountId: OpaqueAccountId;
    muxNonce: string;
    originalId: JsonRpcId;
    method: string;
    dispatchState: DispatchState;
}
export type ReservationState = "reserved" | "released_pre_dispatch" | "stranded_ambiguous" | "reconciled";
export interface Reservation {
    reservationId: string;
    opaqueAccountId: OpaqueAccountId;
    estimatedCost: number;
    state: ReservationState;
    epoch: number;
}
export interface LedgerEntry {
    completedInputTokens: number;
    completedOutputTokens: number;
    reservedRequestCost: number;
    weight: number;
    assignedThreadCount: number;
}
export interface StagedDisable {
    reasonCode: "post_start_failure" | "protocol_drift" | "isolation_failure" | "policy_stop" | "operator_disable";
    stagedAt: string;
}
export interface RouterState {
    schemaVersion: 1;
    protocolFingerprint: `sha256:${string}`;
    epoch: number;
    threadOwners: Record<string, OpaqueAccountId>;
    pendingThreadOwners: Record<string, OpaqueAccountId>;
    ledger: Record<string, LedgerEntry>;
    reservations: Reservation[];
    accountEligibility: Record<string, EligibilityState>;
    correlations: CorrelationRecord[];
    stagedDisable: StagedDisable | null;
}
export interface RedactedControlAccountV1 {
    opaqueAccountId: OpaqueAccountId;
    label: "Account A" | "Account B";
    eligibility: EligibilityState;
    normalizedSpend: number;
    assignedThreadCount: number;
}
export interface RedactedControlStatusV1 {
    schemaVersion: 1;
    mode: "manual" | "balanced" | "direct_fallback";
    protocolState: "supported" | "unsupported" | "drifted" | "unknown";
    fairnessPrecision: "projected" | "exact_completed_spend" | "estimated";
    accounts: RedactedControlAccountV1[];
    restartRequired: boolean;
    degradedReason: null | "invalid_config" | "unsupported_protocol" | "startup_selfcheck_failed" | "pool_depleted" | "capability_mismatch" | "policy_stop" | "post_start_failure";
}
export type QuotaFreshness = "fresh" | "stale" | "unknown";
export interface RedactedQuotaWindow {
    remainingPercent: number | null;
    resetAt: string | null;
    freshness: QuotaFreshness;
}
export interface RedactedControlAccountV2 {
    opaqueAccountId: OpaqueAccountId;
    /** Configured label only; no provider identity is allowed here. */
    label: string;
    eligibility: EligibilityState;
    plan: string | null;
    /** A stable mask derived only from the opaque local account handle. */
    identifierMasked: string;
    weekly: RedactedQuotaWindow;
    /** 0–100, where lower short-window pressure wins a weekly-score tie. */
    shortWindowPressure: number | null;
    assignedThreadCount: number;
}
export interface RedactedControlIntentV2 {
    mode: RouterModeV2;
    policy: "quota_aware_v1" | null;
    generation: number;
    fingerprint: `sha256:${string}`;
}
export type QuotaDegradedReason = "invalid_config" | "unsupported_protocol" | "startup_selfcheck_failed" | "capability_mismatch" | "policy_stop" | "post_start_failure" | "account_unauthenticated" | "account_disabled" | "account_unhealthy" | "quota_depleted" | "quota_stale" | "quota_unknown";
export interface RedactedControlStatusV2 {
    schemaVersion: 2;
    active: RedactedControlIntentV2;
    pending: RedactedControlIntentV2 | null;
    protocolState: "supported" | "unsupported" | "drifted" | "unknown";
    accounts: [RedactedControlAccountV2, RedactedControlAccountV2];
    /** Sum across the fixed two-account pool (0–200), or null unless both are fresh. */
    poolRemainingPercent: number | null;
    restartRequired: boolean;
    degradedReason: QuotaDegradedReason | null;
}
export type RedactedControlStatus = RedactedControlStatusV1 | RedactedControlStatusV2;
export interface JsonRpcRequest {
    jsonrpc?: "2.0";
    id: JsonRpcId;
    method: string;
    params?: unknown;
}
export interface JsonRpcResponse {
    jsonrpc?: "2.0";
    id: JsonRpcId | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface JsonRpcNotification {
    jsonrpc?: "2.0";
    method: string;
    params?: unknown;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
export declare const ELIGIBILITY_STATES: Set<EligibilityState>;
export declare function isOpaqueAccountId(value: unknown): value is OpaqueAccountId;
export declare function isFingerprint(value: unknown): value is `sha256:${string}`;
export declare function isJsonRpcId(value: unknown): value is JsonRpcId;
export declare function isPlainRecord(value: unknown): value is Record<string, unknown>;

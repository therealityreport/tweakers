export declare const ACCOUNT_ROUTER_SCHEMA_VERSION: 1;
export declare const ACCOUNT_ROUTER_CONTRACT_FINGERPRINT: "sha256:6f9d6889bd23ff1122a89b417348b7346cdaa76ced1173eae8c7f8d0608113c2";
export declare const ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
export type OpaqueAccountId = `ar_${string}`;
export type JsonRpcId = string | number;
export type RouterMode = "manual" | "balanced";
export type EligibilityState = "validating" | "eligible" | "reserved" | "active" | "cooldown" | "quota_depleted" | "reauth_required" | "plugin_blocked" | "protocol_blocked" | "disabled" | "unhealthy";
export interface RouterAccountConfig {
    opaqueAccountId: OpaqueAccountId;
    included: boolean;
    weight: number;
    capabilityFingerprint: `sha256:${string}`;
}
export interface RouterConfig {
    schemaVersion: 1;
    mode: RouterMode;
    protocolFingerprint: `sha256:${string}`;
    primaryOpaqueAccountId: OpaqueAccountId;
    accounts: [RouterAccountConfig, RouterAccountConfig];
    updatedAt: string;
}
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
export interface RedactedControlAccount {
    opaqueAccountId: OpaqueAccountId;
    label: "Account A" | "Account B";
    eligibility: EligibilityState;
    normalizedSpend: number;
    assignedThreadCount: number;
}
export interface RedactedControlStatus {
    schemaVersion: 1;
    mode: "manual" | "balanced" | "direct_fallback";
    protocolState: "supported" | "unsupported" | "drifted" | "unknown";
    fairnessPrecision: "projected" | "exact_completed_spend" | "estimated";
    accounts: RedactedControlAccount[];
    restartRequired: boolean;
    degradedReason: null | "invalid_config" | "unsupported_protocol" | "startup_selfcheck_failed" | "pool_depleted" | "capability_mismatch" | "policy_stop" | "post_start_failure";
}
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

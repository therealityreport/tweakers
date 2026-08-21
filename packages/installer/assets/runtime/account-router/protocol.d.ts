import { type CorrelationDirection, type CorrelationRecord, type DispatchState, type JsonRpcId, type JsonRpcMessage, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type OpaqueAccountId } from "./types";
export type ClientRoute = "fanout_initialize_intersection" | "balance_new_thread" | "fanout_aggregate_read_with_router_cursor" | "fanout_aggregate_namespaced_sections" | "persisted_thread_owner" | "thread_owner_if_present_else_primary" | "reject_in_balanced_mode_use_manual_enrollment" | "primary_to_desktop_internal_per_home_probe" | "primary_only_explicit_account_action" | "primary_only_then_invalidate_capability_fingerprints" | "host_primary_only_collision_scoped" | "primary_if_no_thread_then_revalidate_capabilities" | "primary_only_section_mutation" | "primary_only_fail_if_semantics_require_account_or_thread_inference" | "unknown";
export type ServerNotificationRoute = "verify_persisted_owner_then_forward" | "ingest_per_home_primary_forward_only_redacted_control_projection" | "primary_forward_or_origin_correlation_only" | "unknown";
export declare function classifyClientMethod(method: unknown, params?: unknown): ClientRoute;
export declare function classifyServerNotification(method: unknown, params?: unknown): ServerNotificationRoute;
export declare function isKnownServerRequest(method: unknown): boolean;
export declare function hasThreadId(params: unknown): boolean;
export declare function threadIdFrom(params: unknown): string | null;
export declare function parseJsonRpcLine(line: string): JsonRpcMessage | null;
export declare function isRequest(message: JsonRpcMessage): message is JsonRpcRequest;
export declare function isNotification(message: JsonRpcMessage): message is JsonRpcNotification;
export declare function isResponse(message: JsonRpcMessage): message is JsonRpcResponse;
export interface LiveCorrelation extends CorrelationRecord {
    internalId: string;
}
/**
 * Maps every cross-process JSON-RPC id through a monotonic mux-owned nonce.
 * The desktop id and child id are never used in the opposite direction and a
 * terminal response consumes the record exactly once.
 */
export declare class CorrelationTable {
    private readonly persist?;
    private nonce;
    private readonly records;
    private readonly externalIds;
    private readonly recordExternalKeys;
    constructor(records?: CorrelationRecord[], persist?: ((records: CorrelationRecord[]) => void) | undefined);
    create(direction: CorrelationDirection, childOpaqueAccountId: OpaqueAccountId, originalId: JsonRpcId, method: string, scope?: string): LiveCorrelation;
    get(internalId: unknown): LiveCorrelation | null;
    mark(internalId: string, state: DispatchState): LiveCorrelation | null;
    consume(internalId: unknown, direction: CorrelationDirection, childOpaqueAccountId: OpaqueAccountId): LiveCorrelation | null;
    acknowledgeChild(childOpaqueAccountId: OpaqueAccountId): void;
    remaining(): LiveCorrelation[];
    private save;
}
/** The only advertised capability set is the value safely shared by every child. */
export declare function intersectCapabilities(values: unknown[]): unknown | null;

import type { RedactedControlStatus } from "./types";
export type RedactedErrorCode = "invalid_request" | "unknown_method" | "unknown_thread_owner" | "pool_depleted" | "balanced_mode_auth_mutation" | "protocol_drift" | "post_start_failure" | "ambiguous_dispatch" | "invalid_correlation" | "capability_mismatch" | "router_stopping";
export declare function redactedRouterError(id: string | number | null, code: RedactedErrorCode): {
    jsonrpc: "2.0";
    id: string | number | null;
    error: {
        code: number;
        message: string;
        data: {
            code: RedactedErrorCode;
        };
    };
};
/** Reject output that could expose auth, provider identity, configuration paths, or request content. */
export declare function assertRedacted(value: unknown): void;
export declare function redactionFindings(value: unknown, location?: string): string[];
export declare function serializeRedactedStatus(status: RedactedControlStatus): string;

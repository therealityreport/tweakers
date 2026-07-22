export interface PromotionPolicyReadDependencies {
    /** Test seam for proving opened-file metadata drift fails closed. */
    duringRead?: () => void;
    /** Test seam for proving an atomic path replacement cannot pass observation. */
    afterRead?: () => void;
}
export type PromotionPolicyFingerprintFailureReason = "open_failed" | "unsafe_metadata" | "changed_during_read" | "path_changed" | "invalid_utf8" | "invalid_json" | "duplicate_json_key" | "invalid_schema" | "unexpected_error";
export declare class PromotionPolicyFingerprintError extends Error {
    readonly reason: PromotionPolicyFingerprintFailureReason;
    readonly code = "PROMOTION_POLICY_FINGERPRINT_FAILED";
    constructor(reason: PromotionPolicyFingerprintFailureReason, message: string);
}
export declare function promotionPolicyFingerprintFailureReason(error: unknown): PromotionPolicyFingerprintFailureReason;
/** Final forensic allowlist: exact trusted modes, with no special bits. */
export declare function trustedPromotionPolicyMode(mode: number): boolean;
/** Semantic, bounded and no-follow policy proof used by runtime observation. */
export declare function fingerprintPromotionPolicyPath(path: string, deps?: PromotionPolicyReadDependencies): string;

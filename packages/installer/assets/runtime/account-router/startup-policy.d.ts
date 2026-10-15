export declare const STARTUP_POLICY_BUNDLE_ID: "com.therealityreport.tweakers";
export interface StartupPolicyAuthorizationV1 {
    /** V2 retains the same four read-only messages during bounded preparation. */
    version: 1 | 2;
    scope: "startup-policy";
    clientKind: "tweakers";
    bundleIdentity: typeof STARTUP_POLICY_BUNDLE_ID;
    sessionNonce: string;
    nonce: string;
    expiresAt: number;
}
export interface StartupPolicyHandshakeV1 {
    version: 1;
    kind: "startup-policy-handshake";
    authorization: StartupPolicyAuthorizationV1;
    proof: string;
}
export declare function isStartupPolicyAuthorization(value: unknown, now?: number): value is StartupPolicyAuthorizationV1;
export declare function createStartupPolicyAuthorization(sessionNonce: string, now?: number, preparationMs?: number): StartupPolicyAuthorizationV1;
export declare function createStartupPolicyHandshakeProof(secret: Buffer, authorization: StartupPolicyAuthorizationV1): string;
export declare function createStartupPolicyHandshake(secret: Buffer, authorization: StartupPolicyAuthorizationV1): StartupPolicyHandshakeV1;
/** Replay ownership belongs to the connection owner, separately from proof verification. */
export declare function verifyStartupPolicyHandshake(secret: Buffer, value: unknown, now?: number): value is StartupPolicyHandshakeV1;
export type StartupPolicySessionStateV1 = "initialize" | "initialized" | "configRequirements/read" | "config/read" | "complete" | "failed";
/** A capability for these four startup messages only; it grants no renderer identity. */
export declare class StartupPolicySessionV1 {
    private index;
    private pending;
    private failed;
    get state(): StartupPolicySessionStateV1;
    get completed(): boolean;
    prepare(frame: unknown): boolean;
    /** Call only after the parent has delivered a successful response (or accepted notification). */
    complete(success: boolean): boolean;
    fail(): void;
}

import { type OpaqueAccountId, type RouterConfig } from "./types";
import { type NativeHistoryDirectoryIdentityV1, type NativeHistorySourceV1 } from "./native-history";
export declare const NATIVE_AUTH_BINDING_FILE_V1 = "native-auth-binding.v1.json";
type Entry = {
    opaqueAccountId: OpaqueAccountId;
    authHome: string;
    authHomeIdentity: NativeHistoryDirectoryIdentityV1;
    authIdentityHmac: string;
};
export interface NativeAuthBindingV1 {
    version: 1;
    kind: "account-router-native-auth-binding";
    sourceFingerprint: string;
    accounts: Entry[];
    signature: string;
}
export interface NativeExternalTokensV1 {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string | null;
}
/** Owner-only no-follow stable reads. Buffers returned here must never cross IPC to a renderer. */
export declare function readNativeAuthPrivateFileV1(path: string, maximum?: number): Buffer;
export declare function readNativeExternalTokensV1(home: string, entry: Pick<Entry, "opaqueAccountId" | "authIdentityHmac">, secret: Buffer): NativeExternalTokensV1;
/** Absence preserves legacy auth. Malformed or changed companions fail closed. */
export declare function readNativeAuthBindingV1(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): {
    document: NativeAuthBindingV1;
    fingerprint: string;
} | null;
/** Recovery-only authority. Verifies signatures and paths, never claims credentials are valid. */
export declare function readNativeAuthBindingAuthorityV1(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): {
    document: NativeAuthBindingV1;
    fingerprint: string;
} | null;
export interface PreparedNativeAuthBindingV1 {
    readonly sourceFingerprint: string;
    readonly accounts: readonly {
        opaqueAccountId: OpaqueAccountId;
        authHome: string;
    }[];
}
/** Offline-only preparation. No original credentials are read and no source document is rewritten. */
export declare function prepareNativeAuthBindingV1(input: {
    stateRoot: string;
    config: RouterConfig;
    secret: Buffer;
    expectedSourceFingerprint: string;
    accounts: readonly {
        opaqueAccountId: OpaqueAccountId;
        authHome: string;
    }[];
}): PreparedNativeAuthBindingV1;
/** One exclusive atomic publication. Existing evidence is never overwritten. Parent owns the offline writer census. */
export declare function publishPreparedNativeAuthBindingV1(value: PreparedNativeAuthBindingV1): void;
export {};

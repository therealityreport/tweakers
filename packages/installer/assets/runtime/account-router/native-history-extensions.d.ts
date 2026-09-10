import { type OpaqueAccountId, type RouterConfig } from "./types";
import type { NativeHistoryAccountSourceV1, NativeHistoryDirectoryIdentityV1, NativeHistorySourceV1 } from "./native-history";
/** A separately signed companion for manager-local accounts added after native setup. */
export declare const NATIVE_HISTORY_EXTENSIONS_FILE_V1 = "native-history-extensions.v1.json";
export declare const NATIVE_HISTORY_EXTENSIONS_KIND_V1: "account-router-native-history-extensions";
export declare const NATIVE_HISTORY_EXTENSIONS_MAX_BYTES_V1: number;
/** A signed proof that a particular manager-local enrollment home was materialized. */
export declare const NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_FILE_V1 = "native-history-enrollment-receipt.v1.json";
export declare const NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1: "account-router-native-history-managed-enrollment-receipt";
export declare const NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_MAX_BYTES_V1: number;
type Sha256 = `sha256:${string}`;
type HmacSha256 = `hmac-sha256:${string}`;
/** Only credential-free, manager-local facts belong in an extension entry. */
export interface NativeHistoryManagedAccountV1 {
    opaqueAccountId: OpaqueAccountId;
    accountRootRelativePath: `accounts/${string}`;
    codexHomeIdentity: NativeHistoryDirectoryIdentityV1;
    sqliteHomeIdentity: NativeHistoryDirectoryIdentityV1;
    authIdentityHmac: HmacSha256;
    enrollmentReceiptFingerprint: Sha256;
}
export type NativeHistoryManagedAccountDraftV1 = Omit<NativeHistoryManagedAccountV1, "enrollmentReceiptFingerprint">;
export interface NativeHistoryExtensionsUnsignedV1 {
    version: 1;
    kind: typeof NATIVE_HISTORY_EXTENSIONS_KIND_V1;
    /** Exact digest of the original signed source bytes, including formatting. */
    baseSourceFingerprint: Sha256;
    generation: number;
    managedAccounts: readonly NativeHistoryManagedAccountV1[];
    /** The exact external-source plus manager-local opaque account-id union. */
    effectiveAccountSetFingerprint: Sha256;
    issuedAt: string;
}
export interface NativeHistoryExtensionsV1 extends NativeHistoryExtensionsUnsignedV1 {
    signature: HmacSha256;
}
/** Stored inside the account root. It deliberately has no self-fingerprint. */
export interface NativeHistoryManagedEnrollmentReceiptUnsignedV1 extends NativeHistoryManagedAccountDraftV1 {
    version: 1;
    kind: typeof NATIVE_HISTORY_MANAGED_ENROLLMENT_RECEIPT_KIND_V1;
    issuedAt: string;
}
export interface NativeHistoryManagedEnrollmentReceiptV1 extends NativeHistoryManagedEnrollmentReceiptUnsignedV1 {
    signature: HmacSha256;
}
/** A manager-local account after its signed receipt and physical layout are revalidated. */
export interface NativeHistoryManagedAccountBindingV2 extends NativeHistoryManagedAccountV1 {
    readonly kind: "managed_adopted";
    readonly accountRoot: string;
    readonly codexHome: string;
    readonly sqliteHome: string;
}
/** A fixed external account after source parsing has proved its original identity. */
export interface NativeHistoryExternalAccountBindingV2 extends NativeHistoryAccountSourceV1 {
    readonly kind: "native_external";
}
export type NativeHistoryEffectiveAccountV2 = NativeHistoryExternalAccountBindingV2 | NativeHistoryManagedAccountBindingV2;
/** Runtime-only union used by native fanout. `source` always remains the original document. */
export interface NativeHistoryUnionBindingV2 {
    readonly version: 2;
    readonly stateRoot: string;
    readonly source: NativeHistorySourceV1;
    readonly sourceDocumentFingerprint: Sha256;
    readonly extensions: NativeHistoryExtensionsV1 | null;
    readonly extensionDocumentFingerprint: Sha256 | null;
    readonly externalAccounts: readonly NativeHistoryExternalAccountBindingV2[];
    readonly managedAccounts: readonly NativeHistoryManagedAccountBindingV2[];
    /** Validated external + manager-local union, sorted by opaque account id. */
    readonly accounts: readonly NativeHistoryEffectiveAccountV2[];
}
export type AccountStorageBindingV2 = {
    kind: "native_external";
    source: NativeHistoryAccountSourceV1;
} | {
    kind: "managed_adopted";
    accountRoot: string;
    enrollmentReceiptFingerprint: Sha256;
};
export type NativeHistoryExtensionsFailureV1 = "unsafe_state_root" | "unsafe_extensions_file" | "invalid_extensions" | "missing_extensions" | "base_source_mismatch" | "effective_account_set_mismatch" | "managed_account_drift" | "managed_receipt_invalid";
export type NativeHistoryExtensionsPreflightV1 = {
    state: "ready";
    extensions: NativeHistoryExtensionsV1 | null;
    extensionDocumentFingerprint: Sha256 | null;
    managedAccounts: readonly NativeHistoryManagedAccountBindingV2[];
} | {
    state: "invalid";
    reason: NativeHistoryExtensionsFailureV1;
};
export interface NativeHistoryExtensionsPreflightInputV1 {
    stateRoot: string;
    config: RouterConfig;
    secret: Buffer;
    baseSource: NativeHistorySourceV1;
    baseSourceDocumentFingerprint: Sha256;
}
export interface NativeHistoryExtensionDocumentProofV1 {
    readonly document: NativeHistoryExtensionsV1 | null;
    /** Null represents the durable absence of an extension document. */
    readonly documentFingerprint: Sha256 | null;
}
export interface PreparedNativeHistoryExtensionUpdateV1 {
    readonly prior: NativeHistoryExtensionDocumentProofV1;
    readonly next: NativeHistoryExtensionDocumentProofV1 & {
        readonly document: NativeHistoryExtensionsV1;
        readonly documentFingerprint: Sha256;
    };
    /** Binds exactly the source, prior/next extension docs, and prior/next account sets. */
    readonly intentFingerprint: Sha256;
}
export interface PrepareNativeHistoryExtensionUpdateInputV1 {
    stateRoot: string;
    secret: Buffer;
    baseSource: NativeHistorySourceV1;
    baseSourceDocumentFingerprint: Sha256;
    priorConfig: RouterConfig;
    nextConfig: RouterConfig;
    managedAccount: NativeHistoryManagedAccountV1;
    issuedAt: string;
}
export type NativeHistoryExtensionRecoveryV1 = {
    state: "prior";
    preflight: Extract<NativeHistoryExtensionsPreflightV1, {
        state: "ready";
    }>;
} | {
    state: "next";
    preflight: Extract<NativeHistoryExtensionsPreflightV1, {
        state: "ready";
    }>;
} | {
    state: "invalid";
    reason: "invalid_proof" | NativeHistoryExtensionsFailureV1;
};
export interface RecoverNativeHistoryExtensionUpdateInputV1 {
    stateRoot: string;
    secret: Buffer;
    baseSource: NativeHistorySourceV1;
    baseSourceDocumentFingerprint: Sha256;
    priorConfig: RouterConfig;
    nextConfig: RouterConfig;
    prior: NativeHistoryExtensionDocumentProofV1;
    next: NativeHistoryExtensionDocumentProofV1;
}
/** The receipt path is fixed below the validated manager-local account root. */
export declare function nativeHistoryManagedEnrollmentReceiptPathV1(stateRoot: string, opaqueAccountId: OpaqueAccountId): string;
/** Exact raw-document digest; extensions bind the source's bytes, not a reserialization. */
export declare function nativeHistoryDocumentFingerprintV1(value: Buffer | Uint8Array): Sha256;
/** Deterministic effective-id binding shared by extension preparation and preflight. */
export declare function nativeHistoryEffectiveAccountSetFingerprintV1(accounts: readonly OpaqueAccountId[]): Sha256;
export declare function signNativeHistoryExtensionsV1(unsigned: NativeHistoryExtensionsUnsignedV1, secret: Buffer): NativeHistoryExtensionsV1;
/** Strict schema and signature check. Union/config/home proof belongs to preflight. */
export declare function parseNativeHistoryExtensionsV1(value: unknown, secret: Buffer): NativeHistoryExtensionsV1 | null;
export declare function signNativeHistoryManagedEnrollmentReceiptV1(unsigned: NativeHistoryManagedEnrollmentReceiptUnsignedV1, secret: Buffer): NativeHistoryManagedEnrollmentReceiptV1;
export declare function parseNativeHistoryManagedEnrollmentReceiptV1(value: unknown, secret: Buffer): NativeHistoryManagedEnrollmentReceiptV1 | null;
/**
 * Writes the one receipt needed by a newly materialized manager-local home.
 * Existing bytes are never overwritten unless they already prove the exact
 * same account facts, making repeated recovery calls idempotent but drift-safe.
 */
export declare function writeNativeHistoryManagedEnrollmentReceiptV1(input: {
    stateRoot: string;
    secret: Buffer;
    account: NativeHistoryManagedAccountDraftV1;
    issuedAt: string;
}): {
    receipt: NativeHistoryManagedEnrollmentReceiptV1;
    enrollmentReceiptFingerprint: Sha256;
};
/** Reopens and validates receipt bytes, signed fields, physical homes, and auth binding. */
export declare function validateNativeHistoryManagedEnrollmentReceiptV1(input: {
    stateRoot: string;
    secret: Buffer;
    account: NativeHistoryManagedAccountV1;
}): NativeHistoryManagedAccountBindingV2 | null;
/**
 * Validates the signed extension and every extension account against the
 * manager-local receipt/home proof. This function performs no writes.
 */
export declare function preflightNativeHistoryExtensionsV1(input: NativeHistoryExtensionsPreflightInputV1): NativeHistoryExtensionsPreflightV1;
export declare function createNativeHistoryUnionBindingV2(input: {
    stateRoot: string;
    source: NativeHistorySourceV1;
    sourceDocumentFingerprint: Sha256;
    extensionsPreflight: Extract<NativeHistoryExtensionsPreflightV1, {
        state: "ready";
    }>;
}): NativeHistoryUnionBindingV2;
/** Discriminated account lookup for code that needs to distinguish external writer fences. */
export declare function accountStorageBindingV2(binding: NativeHistoryUnionBindingV2, account: OpaqueAccountId): AccountStorageBindingV2 | null;
/** Rechecks an already-created union binding without accepting a rewritten source or extension. */
export declare function nativeHistoryExtensionsBindingSafeV1(binding: NativeHistoryUnionBindingV2, secret: Buffer): boolean;
/**
 * Creates a signed next document without publishing it. Both configs are
 * required, so the old and next union are separately proved before a journal
 * can describe the transaction.
 */
export declare function prepareNativeHistoryExtensionUpdateV1(input: PrepareNativeHistoryExtensionUpdateInputV1): PreparedNativeHistoryExtensionUpdateV1;
/**
 * Publishes only the prepared signed next extension after the owner has
 * journaled its expected prior raw fingerprint. It never rewrites the source
 * document and refuses drift between preparation and publication.
 */
export declare function publishPreparedNativeHistoryExtensionUpdateV1(input: {
    stateRoot: string;
    secret: Buffer;
    prior: NativeHistoryExtensionDocumentProofV1;
    next: PreparedNativeHistoryExtensionUpdateV1["next"];
}): Sha256;
/**
 * Read-only deterministic recovery classifier. The caller decides whether it
 * must finish the matching prior or next router state/config generation.
 */
export declare function recoverNativeHistoryExtensionUpdateV1(input: RecoverNativeHistoryExtensionUpdateInputV1): NativeHistoryExtensionRecoveryV1;
/** Exact bytes used by the private atomic writer and journaled digest. */
export declare function nativeHistoryExtensionsDocumentBytes(next: NativeHistoryExtensionsV1): Buffer;
export {};

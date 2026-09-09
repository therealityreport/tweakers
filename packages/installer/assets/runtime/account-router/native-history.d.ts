import { spawnSync } from "node:child_process";
import type { RouterConfig } from "./types";
import { type OpaqueAccountId } from "./types";
import { type NativeHistoryUnionBindingV2 } from "./native-history-extensions";
export { accountStorageBindingV2, nativeHistoryDocumentFingerprintV1, nativeHistoryEffectiveAccountSetFingerprintV1, nativeHistoryExtensionsDocumentBytes, nativeHistoryManagedEnrollmentReceiptPathV1, parseNativeHistoryExtensionsV1, publishPreparedNativeHistoryExtensionUpdateV1, recoverNativeHistoryExtensionUpdateV1, signNativeHistoryExtensionsV1, validateNativeHistoryManagedEnrollmentReceiptV1, writeNativeHistoryManagedEnrollmentReceiptV1, prepareNativeHistoryExtensionUpdateV1, } from "./native-history-extensions";
export type { AccountStorageBindingV2, NativeHistoryEffectiveAccountV2, NativeHistoryExtensionsV1, NativeHistoryManagedAccountV1, NativeHistoryManagedAccountBindingV2, NativeHistoryManagedAccountDraftV1, NativeHistoryManagedEnrollmentReceiptV1, NativeHistoryUnionBindingV2, PreparedNativeHistoryExtensionUpdateV1, } from "./native-history-extensions";
/** Signed companion that opts a v3 broker into existing account-home history. */
export declare const NATIVE_HISTORY_SOURCE_FILE_V1 = "native-history-source.v1.json";
export declare const NATIVE_HISTORY_SOURCE_KIND_V1: "account-router-native-history-source";
export declare const NATIVE_HISTORY_SOURCE_MODE_V1: "in_place";
export declare const NATIVE_HISTORY_SOURCE_MAX_BYTES_V1: number;
export declare const NATIVE_HISTORY_AUTH_MAX_BYTES_V1: number;
export interface NativeHistoryDirectoryIdentityV1 {
    device: number;
    inode: number;
    uid: number;
    /** POSIX mode bits, including sticky/set-id bits when present. */
    mode: number;
}
export interface NativeHistoryAccountSourceV1 {
    opaqueAccountId: OpaqueAccountId;
    codexHome: string;
    sqliteHome: string;
    codexHomeIdentity: NativeHistoryDirectoryIdentityV1;
    sqliteHomeIdentity: NativeHistoryDirectoryIdentityV1;
    /** HMAC of the account identity in the account-local auth file. */
    authIdentityHmac: string;
}
export interface NativeHistorySourceUnsignedV1 {
    version: 1;
    kind: typeof NATIVE_HISTORY_SOURCE_KIND_V1;
    mode: typeof NATIVE_HISTORY_SOURCE_MODE_V1;
    protocolFingerprint: `sha256:${string}`;
    accountSetFingerprint: `sha256:${string}`;
    /** The one bound native account that owns projects/sections metadata. */
    metadataAccountId: OpaqueAccountId;
    accounts: readonly NativeHistoryAccountSourceV1[];
    issuedAt: string;
}
export interface NativeHistorySourceV1 extends NativeHistorySourceUnsignedV1 {
    signature: string;
}
/**
 * The source document remains v1, while its runtime binding is the validated
 * v2 effective account union. Keep the old export name for existing callers.
 */
export interface NativeHistorySourceBindingV1 extends NativeHistoryUnionBindingV2 {
}
export type NativeHistorySourcePreflightV1 = {
    state: "absent";
} | {
    state: "invalid";
    reason: NativeHistorySourceFailureV1;
} | {
    state: "ready";
    binding: NativeHistorySourceBindingV1;
};
/** Source-only proof for recovery before an extension/config union is coherent. */
export type NativeHistoryBaseSourcePreflightV1 = {
    state: "absent";
} | {
    state: "invalid";
    reason: Exclude<NativeHistorySourceFailureV1, "invalid_extensions">;
} | {
    state: "ready";
    stateRoot: string;
    source: NativeHistorySourceV1;
    sourceDocumentFingerprint: `sha256:${string}`;
};
export type NativeHistorySourceFailureV1 = "unsafe_state_root" | "unsafe_source_file" | "invalid_source" | "invalid_extensions" | "source_drift" | "writer_census_failed" | "foreign_writer";
export interface NativeHistoryWriterObservationV1 {
    ok: boolean;
    reason: "ready" | "source_drift" | "writer_census_failed" | "foreign_writer";
    /** PIDs are owner-private diagnostics; callers must not emit them to a renderer. */
    foreignPids: readonly number[];
}
/** Test seam for the host-only writer census; production always reads ps/lsof. */
export interface NativeHistoryWriterCensusDependenciesV1 {
    spawn?: typeof spawnSync;
    uid?: () => number | undefined;
}
export interface NativeHistoryAsyncWriterCensusDependenciesV1 {
    run?: (command: string, args: readonly string[]) => Promise<{
        stdout: string;
        stderr: string;
    }>;
    uid?: () => number | undefined;
}
/** Authentication-only override; history and settings keep their signed original paths. */
export declare function nativeHistoryEffectiveAuthHomeV1(binding: NativeHistorySourceBindingV1, account: OpaqueAccountId): string | null;
export interface NativeHistoryPortableItemV1 {
    nativeItemId: string;
    kind: "user" | "assistant" | "plan" | "tool";
    text?: string;
    name?: string;
    result?: string;
}
export interface NativeHistoryPortableTurnV1 {
    nativeTurnId: string;
    items: readonly NativeHistoryPortableItemV1[];
}
export type NativeHistoryThreadReadContextV1 = {
    state: "ready";
    turns: readonly NativeHistoryPortableTurnV1[];
    nativeIds: ReadonlySet<string>;
} | {
    state: "unsafe";
};
/** The account-id proof deliberately stays separate from routing configuration. */
export declare function nativeHistoryAuthIdentityHmacV1(rawAccountId: string, secret: Buffer): string;
/** Stable companion binding: balance, labels, primary, and generation do not alter account storage. */
export declare function nativeHistoryAccountSetFingerprintV1(accounts: readonly OpaqueAccountId[]): `sha256:${string}`;
export declare function signNativeHistorySourceV1(unsigned: NativeHistorySourceUnsignedV1, secret: Buffer): NativeHistorySourceV1;
/** Pure companion/schema/signature/config check. Filesystem identity is checked by preflight. */
export declare function parseNativeHistorySourceV1(value: unknown, config: RouterConfig, secret: Buffer): NativeHistorySourceV1 | null;
/**
 * Static-only preflight for parent bridge selection. It intentionally does
 * not perform lsof/ps, because an already-running broker child is expected
 * while a second desktop bridge is deciding whether it may connect.
 */
export declare function readAndPreflightNativeHistorySourceStaticV1(stateRoot: string, config: RouterConfig, secret: Buffer): NativeHistorySourcePreflightV1;
/**
 * Validates only the immutable signed source and its external homes. Recovery
 * calls this before deciding whether the extension/config journal is prior or
 * next, so a temporary mixed union cannot weaken the source proof.
 */
export declare function readAndPreflightNativeHistoryBaseSourceStaticV1(stateRoot: string, protocolFingerprint: `sha256:${string}`, secret: Buffer): NativeHistoryBaseSourcePreflightV1;
/** Full broker-owner preflight: static binding plus an exclusive writer census. */
export declare function readAndPreflightNativeHistorySourceV1(stateRoot: string, config: RouterConfig, secret: Buffer, ownedPids?: readonly number[]): NativeHistorySourcePreflightV1;
/** Revalidate the sealed paths/auth identity and reject every foreign open writer. */
export declare function observeNativeHistoryWritersV1(binding: NativeHistorySourceBindingV1, ownedPids?: readonly number[], dependencies?: NativeHistoryWriterCensusDependenciesV1): NativeHistoryWriterObservationV1;
/**
 * Fences one account without treating an app that has another account open as
 * a writer for this one. `ownedPids` must name only the selected account's
 * direct broker child roots. Manager-local homes require an absent child: they
 * have no native-source writer exception while their inherited config changes.
 */
export declare function observeNativeAccountWritersV1(binding: NativeHistorySourceBindingV1, opaqueAccountId: OpaqueAccountId, ownedPids?: readonly number[], dependencies?: NativeHistoryWriterCensusDependenciesV1): NativeHistoryWriterObservationV1;
/** Native operations run in the selected broker child, without an external materialization write. */
export declare function observeNativeAccountOperationWritersV1(binding: NativeHistorySourceBindingV1, opaqueAccountId: OpaqueAccountId, nativeChildPid: number, dependencies?: NativeHistoryWriterCensusDependenciesV1): NativeHistoryWriterObservationV1;
export declare function nativeHistoryAccountSourceForV1(binding: NativeHistorySourceBindingV1, opaqueAccountId: OpaqueAccountId): NativeHistoryAccountSourceV1 | null;
/**
 * Converts one native `thread/read {includeTurns:true}` result into bounded,
 * credential-free portable records. It accepts only completed, full item
 * snapshots and deliberately refuses attachments, images, active tools, and
 * unknown item kinds.
 */
export declare function nativeHistoryThreadReadContextV1(value: unknown, expectedThreadId: string): NativeHistoryThreadReadContextV1;
/** A deterministic bounded context for one immediately-forwarded handoff. */
export declare function renderNativeHistoryContextV1(turns: readonly NativeHistoryPortableTurnV1[]): {
    text: string;
    digest: `sha256:${string}`;
} | null;
/** Static native identity remains valid while unrelated apps read or write other threads. */
export declare function nativeHistoryBindingSafeV1(binding: NativeHistorySourceBindingV1): boolean;
/** Only a competing writer to this exact conversation can block its dispatch. */
export declare function observeNativeThreadWriterV1(binding: NativeHistorySourceBindingV1, threadId: string, ownedPids?: readonly number[], dependencies?: NativeHistoryWriterCensusDependenciesV1): {
    state: "clear" | "conflict" | "unknown";
    foreignPids: readonly number[];
};
/** Observation-only catalog scans share one asynchronous census, never a write authorization. */
export declare function observeNativeThreadWritersV1(binding: NativeHistorySourceBindingV1, threadIds: readonly string[], ownedPids?: readonly number[], dependencies?: NativeHistoryAsyncWriterCensusDependenciesV1): Promise<ReadonlyMap<string, {
    state: "clear" | "conflict" | "unknown";
    foreignPids: readonly number[];
}>>;

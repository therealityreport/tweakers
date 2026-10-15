import { type AccountContinuityWriteEvidenceV1 } from "./account-continuity";
import { type NativeHistoryDirectoryIdentityV1, type NativeHistorySourceBindingV1 } from "./native-history";
import { type OpaqueAccountId } from "./types";
export declare const SHARED_NATIVE_MODE_FILE_V1 = "shared-native-mode.v1.json";
export declare const SHARED_NATIVE_MODE_TRANSITION_FILE_V1 = "shared-native-mode-transition.v1.json";
export declare const OFFICIAL_SHARED_PLUGIN_PREPARATION_TIMEOUT_MS_V1 = 600000;
type Sha256 = `sha256:${string}`;
export type SharedNativeResolverProtocolV1 = "shared-native-overlay-v1" | "official-bundled-v1";
type Root = {
    path: string;
    identity: NativeHistoryDirectoryIdentityV1;
};
export interface SharedNativeModeV1 {
    version: 1;
    kind: "account-router-shared-native-mode";
    sourceFingerprint: Sha256;
    sourceAccountId: OpaqueAccountId;
    nativeBase: Root;
    overlay: Root;
    resolverProtocol: SharedNativeResolverProtocolV1;
    resolverBinarySha256: string;
    retiredCopyState: {
        priorSharedFingerprint: Sha256;
        priorPluginsFingerprint: Sha256;
        abortedRebaseFingerprint: Sha256 | null;
    };
    signature: string;
}
export interface SharedNativeModeContextV1 {
    stateRoot: string;
    binding: NativeHistorySourceBindingV1;
    secret: Buffer;
}
export interface SharedNativeModePlanV1 {
    version: 1;
    kind: "account-router-shared-native-mode-transition";
    document: SharedNativeModeV1;
    rebaseDocumentFingerprint: Sha256 | null;
    signature: string;
}
type Blocked = {
    state: "blocked";
    reason: string;
};
export type SharedNativeModeReadResultV1 = {
    state: "absent";
} | Blocked | {
    state: "ready";
    document: SharedNativeModeV1;
    fingerprint: Sha256;
    environment: {
        TWEAKERS_NATIVE_BASE_ROOT?: string;
        TWEAKERS_OVERLAY_ROOT?: string;
    };
};
export type SharedNativeModePublishResultV1 = Blocked | {
    state: "published";
    document: SharedNativeModeV1;
    fingerprint: Sha256;
    binding: NativeHistorySourceBindingV1;
};
export interface PrepareSharedNativeModeInputV1 extends SharedNativeModeContextV1 {
    overlayPath: string;
    expectedSourceFingerprint: Sha256;
    expectedRebaseIntentFingerprint: Sha256 | null;
    resolverBinarySha256: string;
}
interface WriteInput extends SharedNativeModeContextV1 {
    accountWriteEvidence?: Readonly<Record<string, AccountContinuityWriteEvidenceV1>>;
    /** Existing-test interruption seam, never supplied by production callers. */
    faultAt?: "after_intent" | "after_abort" | "after_publication";
}
/** A signed latency hint only. Full mode/root authority is still checked by the
 * broker; this never authorizes a process, file mutation or account operation. */
export declare function sharedNativePluginPreparationTimeoutV1(stateRoot: string, secret: Buffer, fallbackMs: number): number;
export interface OwnedPluginPreparationV1 {
    account: OpaqueAccountId;
    permitsPendingIntent: () => boolean;
}
export declare function readSharedNativeModeV1(context: SharedNativeModeContextV1, preparation?: OwnedPluginPreparationV1): SharedNativeModeReadResultV1;
export declare function prepareSharedNativeModeV1(input: PrepareSharedNativeModeInputV1): {
    state: "prepared";
    plan: SharedNativeModePlanV1;
    fingerprint: Sha256;
} | Blocked;
export declare function publishSharedNativeModeV1(input: WriteInput & {
    plan: SharedNativeModePlanV1;
    expectedPlanFingerprint: Sha256;
}): SharedNativeModePublishResultV1;
export declare function recoverSharedNativeModeV1(input: WriteInput & {
    expectedTransitionFingerprint: Sha256;
}): SharedNativeModePublishResultV1;
export interface SharedNativeResolverRepairBindingV1 {
    operationId: string;
    promotionId: string;
    journalSha256: string;
    priorRepairFingerprint: string | null;
    appFingerprintSha256: string;
    runtimeFingerprintSha256: string;
}
export interface SharedNativeResolverTransitionV1 {
    version: 1;
    kind: "account-router-shared-native-resolver-transition";
    binding: SharedNativeResolverRepairBindingV1;
    priorDocumentBytes: string;
    priorFingerprint: Sha256;
    document: SharedNativeModeV1;
    signature: string;
}
/** Prepare a signed resolver/protocol CAS without changing the installed registration. */
export declare function prepareSharedNativeResolverTransitionV1(input: SharedNativeModeContextV1 & {
    expectedRegistrationFingerprint: Sha256;
    resolverBinarySha256: string;
    resolverProtocol?: SharedNativeResolverProtocolV1;
    repairBinding: SharedNativeResolverRepairBindingV1;
}): {
    state: "prepared";
    plan: SharedNativeResolverTransitionV1;
    fingerprint: Sha256;
} | Blocked;
/**
 * Explicit phases let the installer keep launch blocked until app, runtime,
 * journal and readiness challenge have all reached the same generation.
 */
export declare function executeSharedNativeResolverTransitionV1(input: SharedNativeModeContextV1 & {
    plan: unknown;
    expectedPlanFingerprint: Sha256;
    action: "validate" | "begin" | "publish" | "finish";
}): {
    state: "validated" | "begun" | "published" | "finished";
    binding: SharedNativeResolverRepairBindingV1;
    priorFingerprint: Sha256;
    fingerprint: Sha256;
    priorResolverBinarySha256: string;
    resolverBinarySha256: string;
} | Blocked;
export declare function readSharedNativeModeAtRootV1(input: {
    stateRoot: string;
}): SharedNativeModeReadResultV1;
export declare function prepareSharedNativeResolverTransitionAtRootV1(input: {
    stateRoot: string;
    expectedRegistrationFingerprint: string;
    resolverBinarySha256: string;
    resolverProtocol?: SharedNativeResolverProtocolV1;
    repairBinding: SharedNativeResolverRepairBindingV1;
}): ReturnType<typeof prepareSharedNativeResolverTransitionV1>;
/** Installer execution port: load only the exact signed native binding and wipe the key after each phase. */
export declare function executeSharedNativeResolverTransitionAtRootV1(input: {
    stateRoot: string;
    plan: unknown;
    expectedPlanFingerprint: Sha256;
    action: "validate" | "begin" | "publish" | "finish";
}): ReturnType<typeof executeSharedNativeResolverTransitionV1>;
export {};

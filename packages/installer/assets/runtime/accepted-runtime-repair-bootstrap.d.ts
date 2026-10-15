import { type AcceptedRuntimeRepairGenerationV1, type AcceptedRuntimeRepairHead, type AcceptedRuntimeRepairIntent, type AcceptedRuntimeRepairReadyBindingV1 } from "@therealityreport/tweakers-sdk";
export interface AcceptedRuntimeRepairBootstrapProjection {
    head: AcceptedRuntimeRepairHead;
    intent: AcceptedRuntimeRepairIntent;
    phase: "challenge:published" | "committed";
    runtimeRepair: AcceptedRuntimeRepairReadyBindingV1;
    originalJournal: unknown;
    effectiveJournal: unknown;
    effectiveActiveReceipt: unknown;
    childRoot: string;
    managerRoot: string;
    /** Full immutable acceptance is historical; this flag records observed original settlement. */
    originalOperationCompleted: boolean;
    /** Exact challenge authenticated at initialization; committed proof is historical. */
    provisionalExpectation: unknown | null;
}
export interface AcceptedRuntimeRepairBootstrapDependencies {
    fingerprint(path: string): AcceptedRuntimeRepairGenerationV1;
    /** Test seam. Production always uses actual strict codesign verification. */
    verifySignature?(path: string, identifier: string | null, trustedLeaf: string | null): void;
}
/** The system app parent has different ownership from private Manager evidence. */
export declare function assertAcceptedRuntimeRepairFilesystemOwner(input: {
    root: string;
    path: string;
    uid: number;
    mode: number;
    currentUid: number | undefined;
    privateLeaf: boolean;
    symlink: boolean;
}): void;
/** Config has open tweak namespaces; normal startup retains mutable user preferences. */
export declare function assertAcceptedRuntimeRepairMutableConfig(value: unknown): void;
/** Fixed raw-binary allowance does not raise durable JSON/proof limits. */
export declare function assertAcceptedRuntimeRepairReadSize(size: number, kind: "json-proof" | "generated-payload"): void;
/** Closed compatibility with the durable immutable publisher's retained temporary links. */
export declare function readAcceptedRuntimeRepairImmutableAttestation(root: string, path: string, expectedSha256: string): Buffer;
/** Read fixed data from a fully verified worker; this never executes installer code or claims compiler authenticity. */
export declare function readAcceptedRuntimeRepairSealedSourceCustody(root: string, moduleRoot: string, baseline: {
    fingerprint: string;
    fileCount: number;
    documentSha256: string;
}): Record<string, any>;
/** A bundle containing an approved file does not grant permission to change its other embedded inputs. */
export declare function assertAcceptedRuntimeRepairBundledSourceDelta(beforeBytes: Buffer, afterBytes: Buffer, path: string, beforeExternalMap?: Buffer, afterExternalMap?: Buffer): void;
/** Resolve only the fixed operation head; absence preserves ordinary schema5 startup. */
export declare function readAcceptedRuntimeRepairBootstrap(input: {
    managerRoot: string;
    userRoot: string;
    target: string;
    operationId: string;
    promotionId: string;
}, deps: AcceptedRuntimeRepairBootstrapDependencies): AcceptedRuntimeRepairBootstrapProjection | null;
/** Retained history only. The caller must first verify a different ordinary current promotion. */
export declare function readAcceptedRuntimeRepairHistoricalBootstrap(input: {
    managerRoot: string;
    userRoot: string;
    target: string;
    operationId: string;
    promotionId: string;
}, deps: AcceptedRuntimeRepairBootstrapDependencies): AcceptedRuntimeRepairBootstrapProjection | null;
/** Authenticate only a failed, superseded promotion. Its signed handoff grants
 * no readiness, fallback, acceptance, or permission to change a live generation. */
export declare function readSupersededNativeReplacementHistoricalBootstrap(input: {
    managerRoot: string;
    userRoot: string;
    target: string;
    operationId: string;
    promotionId: string;
}, deps: AcceptedRuntimeRepairBootstrapDependencies): {
    originalJournal: unknown;
    priorActiveReceipt: AcceptedRuntimeRepairGenerationV1;
} | null;
/** Recheck mutable admission bindings after the full initialization gate, without repeating sealed tree walks. */
export declare function assertAcceptedRuntimeRepairChallengeCurrent(projection: AcceptedRuntimeRepairBootstrapProjection): void;
/** Repair preserves the original identity/policy challenge while replacing only its runtime authority. */
export declare function assertAcceptedRuntimeRepairExpectationProjection(original: unknown, current: unknown, binding: {
    intent: AcceptedRuntimeRepairIntent;
    runtimeRepair: AcceptedRuntimeRepairReadyBindingV1;
    activePromotionReceiptSha256: string;
}): void;

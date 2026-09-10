import type { NativeCatalogDbV1, NativeFileIdentityV1, NativeHistorySnapshotV2, NativeSqlValueV1, NativeTransferAccountV1 } from "./native-transfer";
import { type OpaqueAccountId } from "./types";
export declare const ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION: 2;
/** Explicit capability surfaced by the fingerprint-bound installed reader. */
export declare function inspectNativeSourceRetirementCompatibilityV2(candidateVersion: number): {
    state: "compatible" | "incompatible";
    minimumVersion: 2;
};
export interface NativeRetirementRowsV2 {
    /** Complete schema and row, including fields deliberately omitted from projection copying. */
    stateSchema: string;
    row: Readonly<Record<string, NativeSqlValueV1>> | null;
    history: NativeHistorySnapshotV2;
}
export interface NativeRetirementContextV2 {
    operationId: string;
    threadId: string;
    source: NativeTransferAccountV1;
    target: NativeTransferAccountV1;
    generationDigest: string;
    expectedRow: Readonly<Record<string, NativeSqlValueV1>>;
    expectedHistory: NativeHistorySnapshotV2;
    expectedStreams: readonly {
        path: string;
        streamId: string;
        identity: NativeFileIdentityV1;
        size: number;
        digest: string;
    }[];
    /** Binding, sole broker authority, current owner, and source-offline evidence. */
    mutationGuard(): boolean;
    /** Binding and writer census; also usable with a known resident remote child. */
    observationGuard(): boolean;
    targetStillPrepared(): Promise<boolean>;
}
/**
 * Source retirement never changes owner or restores a saved generation. Its
 * independent snapshots survive successful return transfers and ambiguous
 * interruptions. Native homes contain neither receipts nor recovery copies.
 */
export declare class NativeSourceRetirementStoreV2 {
    private readonly stateRoot;
    private readonly accounts;
    private readonly db;
    constructor(stateRoot: string, accounts: () => readonly NativeTransferAccountV1[], db: NativeCatalogDbV1);
    noteCommittedTransfer(threadId: string, operationId: string, sourceAccountId: OpaqueAccountId): void;
    invalidateProjection(threadId: string, accountId: OpaqueAccountId): void;
    latestOperation(threadId: string): string | null;
    activeOperation(threadId: string, accountId: OpaqueAccountId): string | null;
    latestOutgoingOperation(threadId: string, accountId: OpaqueAccountId): string | null;
    isRetired(threadId: string, accountId: OpaqueAccountId): boolean;
    localProjectionValues(threadId: string, accountId: OpaqueAccountId, columns: readonly string[]): {
        state: "none" | "held";
    } | {
        state: "ready";
        values: Readonly<Record<string, NativeSqlValueV1>>;
    };
    retire(context: NativeRetirementContextV2): Promise<{
        state: "retired" | "held";
    }>;
    verify(context: NativeRetirementContextV2): Promise<boolean>;
    private absent;
    private rowsMatchPrepared;
    private filesMatchPrepared;
    private scanSourceFiles;
    private sourceFile;
    private assertIndependentCopy;
    private publishIndependentCopy;
    private verifyCopies;
    private assertContext;
    private assertReceiptContext;
    private root;
    private operationRoot;
    private retainedPath;
    private readReceipt;
    private writeReceipt;
    private readIndex;
    private writeIndex;
}

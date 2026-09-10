import { type NativeThreadWriterLeaseResult } from "./native-thread-writer-lease";
import { type NativeRetirementRowsV2 } from "./native-source-retirement";
import { spawn } from "node:child_process";
import { type OpaqueAccountId } from "./types";
/**
 * This module owns only owner-private native catalog/projection state. It
 * deliberately contains no provider requests, renderer data, profile details,
 * renderer-facing payloads or durable RouterStateStore ownership mutations.
 * V2 journals hold bounded owner-private generation snapshots for recovery.
 */
export declare const ACCOUNTS_TRANSFER_READER_VERSION = 2;
export declare const NATIVE_CATALOG_FILE_V1 = "native-catalog.v1.json";
export declare const NATIVE_CATALOG_JOURNAL_FILE_V1 = "native-catalog.v1.journal.jsonl";
export declare const NATIVE_CATALOG_VERSION_V1: 1;
export declare const NATIVE_CATALOG_FILE_V2 = "native-catalog.v2.json";
export declare const NATIVE_CATALOG_JOURNAL_FILE_V2 = "native-catalog.v2.journal.jsonl";
export declare const NATIVE_TRANSFER_MINIMUM_RUNTIME_FILE_V2 = "native-transfer.minimum-runtime.json";
export declare function inspectNativeTransferCompatibilityV2(marker: unknown, candidateVersion: number): {
    state: "compatible" | "incompatible";
    minimumVersion: number;
};
export declare const NATIVE_HISTORY_SCHEMA_FINGERPRINT_V2 = "sha256:d4b0347896267dd6c40b51edef0ca43f51a9a4770a77cf1ac083bfc0951a7bc9";
export interface NativeHistorySnapshotV2 {
    schema: string;
    rows: Record<string, readonly Record<string, NativeSqlValueV1>[]>;
}
interface NativeGenerationV2 {
    row: NativeThreadRowV1;
    streams: Array<{
        path: string;
        streamId: string;
        identity: NativeFileIdentityV1;
        size: number;
        digest: string;
    }>;
    history: NativeHistorySnapshotV2 | null;
    digest: string;
}
export declare const NATIVE_CATALOG_MAX_THREADS_V1 = 16384;
export declare const NATIVE_CATALOG_MAX_BYTES_V1: number;
export declare const NATIVE_TRANSFER_MAX_ROLLOUT_BYTES_V1: number;
export interface NativeTransferAccountV1 {
    accountId: OpaqueAccountId;
    codexHome: string;
    sqliteHome: string;
}
export interface NativeFileIdentityV1 {
    dev: number;
    ino: number;
}
export type NativeSqlValueV1 = string | number | boolean | null;
export type NativeSqlAffinityV1 = "integer" | "text" | "real" | "blob" | "numeric";
export interface NativeThreadsColumnV1 {
    name: string;
    affinity: NativeSqlAffinityV1;
    notNull: boolean;
    hasDefault: boolean;
    primaryKey: boolean;
}
export interface NativeThreadsSchemaV1 {
    columns: readonly NativeThreadsColumnV1[];
}
export interface NativeCatalogCursorV1 {
    updatedAtMs: number;
    threadId: string;
}
export interface NativeThreadRowV1 {
    threadId: string;
    rolloutPath: string;
    historyMode: string;
    archived: number;
    updatedAt: NativeSqlValueV1;
    updatedAtMs: number | null;
    values: Readonly<Record<string, NativeSqlValueV1>>;
}
export interface NativeThreadRowPageV1 {
    rows: readonly NativeThreadRowV1[];
    nextCursor: NativeCatalogCursorV1 | null;
}
export interface NativeProjectionInsertV1 {
    sourceDbPath: string;
    targetDbPath: string;
    source: NativeThreadRowV1;
    targetPath: string;
    /** Only this target account's own frozen local fields, never foreign owner fields. */
    targetLocalValues?: Readonly<Record<string, NativeSqlValueV1>>;
}
export interface NativeCatalogDbV1 {
    inspectSchema(dbPath: string): Promise<NativeThreadsSchemaV1>;
    readHistorySnapshot?(dbPath: string, streamIds: readonly string[]): Promise<NativeHistorySnapshotV2>;
    replaceHistorySnapshot?(dbPath: string, snapshot: NativeHistorySnapshotV2, streamIds: readonly string[]): Promise<void>;
    refreshProjection?(input: NativeProjectionInsertV1): Promise<void>;
    scanEligibleRows(dbPath: string, after?: NativeCatalogCursorV1): Promise<NativeThreadRowPageV1>;
    insertProjection(input: NativeProjectionInsertV1): Promise<"inserted" | "already_exact" | "conflict">;
    readExact(dbPath: string, threadId: string): Promise<NativeThreadRowV1 | null>;
    readRetirementRows?(stateDb: string, historyDb: string, threadId: string, streamIds: readonly string[]): Promise<NativeRetirementRowsV2>;
    compareAndDeleteRetirementRows?(stateDb: string, historyDb: string, threadId: string, streamIds: readonly string[], expected: NativeRetirementRowsV2): Promise<void>;
}
export type NativeTransferCapabilityV1 = {
    state: "ready";
    writerLockProtocol: "shared_thread_writer_locks_v1";
    paginatedHistory: true;
} | {
    state: "unsupported";
    reason: NativeTransferCapabilityFailureV1;
};
export type NativeTransferCapabilityFailureV1 = "invalid_probe_input" | "spawn_failed" | "initialize_failed" | "paginated_history_missing" | "writer_lock_missing" | "probe_timeout" | "probe_failed";
export type NativeTransferPreflightV1 = {
    state: "ready";
    sharedWriterLockPath: string;
    identity: NativeFileIdentityV1;
} | {
    state: "busy" | "unsupported" | "collision" | "unavailable";
    reason: string;
};
export type NativeCatalogReconcileResultV1 = {
    state: "ready";
    scanned: number;
    projected: number;
    collisions: number;
} | {
    state: "collision";
    scanned: number;
    projected: number;
    collisions: number;
} | {
    state: "busy" | "unsupported" | "collision" | "unavailable";
    reason: string;
};
export interface NativeTransferInputV1 {
    operationId: string;
    threadId: string;
    sourceAccountId: OpaqueAccountId;
    targetAccountId: OpaqueAccountId;
}
export type NativeTransferPrepareResultV1 = {
    state: "ready";
    operationId: string;
    threadId: string;
    targetPath: string;
    sourceAccountId: OpaqueAccountId;
    targetAccountId: OpaqueAccountId;
} | {
    state: "busy" | "collision" | "unsupported" | "unavailable";
};
export type NativeResumeSettlementV1 = {
    state: "proved";
    operationId: string;
    accountId: OpaqueAccountId;
    threadId: string;
    path: string;
} | {
    state: "source_owned" | "ambiguous" | "collision";
};
export interface NativeLoadedThreadV1 {
    threadId: string;
    path?: string | null;
}
export interface NativeRemoteWriterReconcileResultV1 {
    state: "ready" | "busy" | "unsupported" | "collision" | "unavailable";
    updatedThreadIds: readonly string[];
    collisionThreadIds: readonly string[];
}
export interface NativePendingWriterCommitV1 {
    operationId: string;
    threadId: string;
    sourceAccountId: OpaqueAccountId;
    targetAccountId: OpaqueAccountId;
    phase: "target_resumed";
}
/**
 * Narrow offline continuity proof. It intentionally contains no account ids,
 * rollout paths, SQLite values, or operation details.
 */
export type NativeCommittedThreadInventoryV1 = {
    state: "ready";
    fingerprint: `sha256:${string}`;
    threadIds: readonly string[];
} | {
    state: "unavailable";
    reason: "invalid_input" | "state_root_invalid" | "snapshot_missing" | "snapshot_invalid" | "journal_ambiguous" | "catalog_collision" | "catalog_transition_pending";
};
export interface NativeCommittedThreadInventoryOptionsV1 {
    stateRoot: string;
}
export type NativeTransferAccountsUpdateResultV1 = {
    state: "ready";
    addedAccountIds: readonly OpaqueAccountId[];
} | {
    state: "collision" | "unavailable";
    reason: string;
};
export interface NativeTransferCoordinatorOptionsV1 {
    stateRoot: string;
    recoveryCompatibilityPreflight?: () => boolean;
    /** Fresh proof that the source has no resident child or work, including external writers. */
    accountOfflinePreflight?: (accountId: OpaqueAccountId) => boolean;
    /** Test injection only; production uses the packaged native lease implementation. */
    acquirePreparationLease?: (lockDirectory: string, threadId: string) => NativeThreadWriterLeaseResult;
    /** Proves the target native process holds this exact inode after resume. */
    resumedWriterLockProof?: (threadId: string, targetAccountId: OpaqueAccountId, identity: {
        dev: string;
        ino: string;
    }) => boolean;
    accounts: readonly NativeTransferAccountV1[];
    primaryAccountId: OpaqueAccountId;
    db: NativeCatalogDbV1;
    capabilityProbe: () => Promise<NativeTransferCapabilityV1>;
    /** Revalidates the signed native-history binding and sealed account homes. */
    bindingPreflight: () => boolean;
    /** Requires a clean census apart from explicitly registered broker children. */
    writerCensus: () => boolean;
    /**
     * Per-thread evidence used immediately before a rollout link or same-ID
     * handoff. It deliberately does not make unrelated live threads or ordinary
     * SQLite handles block catalog reads.
     */
    exactThreadCensus?: (threadId: string, accountId: OpaqueAccountId) => NativeThreadCensusResultV1 | boolean;
    /** One observation-only batch for unverifiable catalog rows; never used to authorize writes. */
    catalogThreadCensus?: (threadIds: readonly string[]) => Promise<ReadonlyMap<string, NativeThreadCensusResultV1>>;
    now?: () => Date;
}
export type NativeThreadCensusResultV1 = "clear" | "conflict" | "unknown";
export interface NativeOfflineWriterLockConversionOptionsV1 {
    /**
     * Supplied only by the activation path after it has independently proved
     * that no child or app-server writer remains. Runtime provisioning never
     * supplies an implicit equivalent.
     */
    offlinePreflight: () => boolean;
}
interface NativeTransferOperationV1 {
    writerLock?: {
        dev: string;
        ino: string;
    };
    transferVersion?: 2;
    generation?: NativeGenerationV2;
    operationId: string;
    threadId: string;
    sourceAccountId: OpaqueAccountId;
    targetAccountId: OpaqueAccountId;
    targetPath: string | null;
    targetIdentity: NativeFileIdentityV1 | null;
    phase: "preparing" | "target_prepared" | "resume_dispatching" | "target_resumed" | "owner_committed" | "source_owned" | "ambiguous" | "collision";
    updatedAt: string;
}
/**
 * Production asynchronous adapter. It intentionally invokes the macOS system
 * sqlite client without a shell and never blocks the broker event loop.
 */
export declare class Sqlite3NativeCatalogDbV1 implements NativeCatalogDbV1 {
    private readonly sqlite3Path;
    private readonly timeoutMs;
    private readonly spawnProcess;
    constructor(options?: Readonly<{
        sqlite3Path?: string;
        timeoutMs?: number;
        spawn?: typeof spawn;
    }>);
    inspectSchema(dbPath: string): Promise<NativeThreadsSchemaV1>;
    scanEligibleRows(dbPath: string, after?: NativeCatalogCursorV1): Promise<NativeThreadRowPageV1>;
    readExact(dbPath: string, threadId: string): Promise<NativeThreadRowV1 | null>;
    readRetirementRows(stateDb: string, historyDb: string, threadId: string, streamIds: readonly string[]): Promise<NativeRetirementRowsV2>;
    compareAndDeleteRetirementRows(stateDb: string, historyDb: string, threadId: string, streamIds: readonly string[], expected: NativeRetirementRowsV2): Promise<void>;
    insertProjection(input: NativeProjectionInsertV1): Promise<"inserted" | "already_exact" | "conflict">;
    readHistorySnapshot(dbPath: string, streamIds: readonly string[]): Promise<NativeHistorySnapshotV2>;
    replaceHistorySnapshot(dbPath: string, snapshot: NativeHistorySnapshotV2, streamIds: readonly string[]): Promise<void>;
    refreshProjection(input: NativeProjectionInsertV1): Promise<void>;
    private execute;
}
export declare class NativeTransferCoordinatorV1 {
    private readonly options;
    private readonly retirements;
    private readonly retirementInFlight;
    private readonly preparationLeases;
    private readonly resumedGenerationProofs;
    private capability;
    private capabilityInFlight;
    private document;
    private readonly accounts;
    private readonly accountHomeIdentities;
    private accountIds;
    private readonly now;
    constructor(options: NativeTransferCoordinatorOptionsV1);
    /**
     * The runtime must call this before it enables native transfer. A missing or
     * failed real probe is a closed unsupported state, never a version guess.
     */
    probeCapability(): Promise<NativeTransferCapabilityV1>;
    /**
     * Adds enrolled account homes without discarding durable catalog state or
     * remote-controller ownership. Existing members, paths, and pinned home
     * inodes must remain exact; removal and replacement are deliberately not a
     * supported runtime operation.
     */
    updateAccounts(accounts: readonly NativeTransferAccountV1[]): NativeTransferAccountsUpdateResultV1;
    /**
     * Exact read-only validation. It never creates or converts a lock directory.
     */
    preflightSharedWriterLocks(): NativeTransferPreflightV1;
    /**
     * Runtime-safe provisioning. Existing secondary directories are never
     * converted here; activation must use the explicit offline method below.
     */
    provisionSharedWriterLocks(): NativeTransferPreflightV1;
    /**
     * Activation-only conversion. The caller must supply an independent offline
     * proof in addition to the signed-binding and process-census checks.
     */
    convertOfflineWriterLockDirectory(accountId: OpaqueAccountId, options: NativeOfflineWriterLockConversionOptionsV1): NativeTransferPreflightV1;
    /**
     * Only the selected idle secondary is changed. The primary namespace must
     * already exist and remain the same directory while its native app runs.
     * The caller independently proves the secondary app and writers are absent.
     */
    convertIdleSecondaryWriterLockDirectory(accountId: OpaqueAccountId, options: NativeOfflineWriterLockConversionOptionsV1): NativeTransferPreflightV1;
    private convertWriterLockDirectory;
    reconcileCatalog(options?: Readonly<{
        project?: boolean;
    }>): Promise<NativeCatalogReconcileResultV1>;
    pendingTransfersForRecovery(): readonly Pick<NativeTransferOperationV1, "operationId" | "threadId" | "sourceAccountId" | "targetAccountId" | "phase">[];
    recoverInterruptedTransfers(loadedByAccount: ReadonlyMap<OpaqueAccountId, readonly NativeLoadedThreadV1[]>): Promise<{
        settledOperationIds: string[];
        heldOperationIds: string[];
        heldThreadIds: string[];
    }>;
    sourceProjectionReady(threadId: string, accountId: OpaqueAccountId): Promise<boolean>;
    private writerLockMatches;
    private preparationLeaseHeld;
    releasePreparationLease(operationId: string): void;
    releasePreparationLeaseForResume(operationId: string): boolean;
    revalidatePrepared(operationId: string): Promise<boolean>;
    revalidateResumedGeneration(operationId: string): Promise<boolean>;
    private preparedGenerationMatches;
    private targetGenerationMatches;
    private captureGeneration;
    private prepareGeneration;
    prepareSameThreadTransfer(input: NativeTransferInputV1): Promise<NativeTransferPrepareResultV1>;
    private prepareSameThreadTransferUnderLease;
    markResumeDispatching(operationId: string): void;
    confirmPreparationProbeBlocked(operationId: string, response: unknown): Promise<boolean>;
    settleResume(operationId: string, nativeResponse: unknown): NativeResumeSettlementV1;
    recoverResume(operationId: string, loadedByAccount: ReadonlyMap<OpaqueAccountId, readonly NativeLoadedThreadV1[]>): NativeResumeSettlementV1;
    /**
     * Called only after the host has committed both RouterStateStore and
     * canonical-history owner changes. This writes the terminal native receipt.
     */
    commitWriter(operationId: string): void;
    canEnableRemote(accountId: OpaqueAccountId): boolean;
    verifyRemoteEligibility(accountId: OpaqueAccountId): Promise<boolean>;
    retireSourceProjection(operationId: string): Promise<{
        state: "retired" | "held";
    }>;
    pendingSourceRetirements(): readonly Pick<NativeTransferOperationV1, "operationId" | "threadId" | "sourceAccountId" | "targetAccountId">[];
    hasPendingSourceRetirement(threadId: string): boolean;
    recoverSourceRetirements(): Promise<{
        retiredOperationIds: string[];
        heldOperationIds: string[];
    }>;
    private retirementContext;
    ownerForThread(threadId: string): OpaqueAccountId | null;
    isCommittedProjection(threadId: string, accountId: OpaqueAccountId): boolean;
    pendingWriterCommits(): readonly NativePendingWriterCommitV1[];
    /**
     * Reconciles a remote-owned writer only when the loaded-list gives exactly
     * one account, durable provenance still names the same hard-link inode, and
     * the shared lock projection has freshly passed.
     */
    reconcileRemoteWriter(loadedByAccount: ReadonlyMap<OpaqueAccountId, readonly NativeLoadedThreadV1[]>): NativeRemoteWriterReconcileResultV1;
    private basePreflight;
    private preflightSharedWriterLocksReady;
    private primaryAccount;
    private secondaryAccounts;
    private ensurePrimaryWriterLock;
    private lockBackupPath;
    private resumeOfflineConversion;
    private rollbackOfflineConversion;
    private recordLockConversion;
    private validateKnownSightings;
    private ensureProjection;
    private projectionDatabaseExact;
    private projectionCollision;
    private markThreadCollision;
    private hasThreadCollision;
    private hasUnsettledOperation;
    private updateOperation;
    private timestamp;
    private mutate;
    private ensureMinimumReaderMarker;
    private persist;
    private loadDocument;
    private exactThreadCensus;
}
export interface NativeTransferCapabilityProbeOptionsV1 {
    command: string;
    /** Desktop argv is discarded for codex; non-codex executables retain fixture argv. */
    args: readonly string[];
    cwd?: string;
    timeoutMs?: number;
    spawn?: typeof spawn;
}
/**
 * Executes a disposable, isolated app-server probe. It establishes that this
 * exact binary accepts paginated start and creates the documented per-thread
 * writer-lock object; version strings are deliberately not consulted.
 */
export declare function probeNativeTransferCapabilityV1(options: NativeTransferCapabilityProbeOptionsV1): Promise<NativeTransferCapabilityV1>;
/**
 * Read-only cold-start inventory for continuity restoration. A nonempty
 * journal is intentionally ambiguous here: this function must never repair
 * or promote an interrupted owner transition while the broker is closed.
 */
export declare function readCommittedNativeThreadInventoryV1(options: NativeCommittedThreadInventoryOptionsV1): NativeCommittedThreadInventoryV1;
export {};

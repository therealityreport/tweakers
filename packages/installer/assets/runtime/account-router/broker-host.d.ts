import { type ChildProcess } from "node:child_process";
import { type Socket } from "node:net";
import { type BrokerChildV1 } from "./broker";
import { type NativeBrowserContextV1 } from "./broker-socket";
import type { BrokerClientKind, JsonRpcMessage, JsonRpcResponse, OpaqueAccountId, OpaqueAppToolsRef, OpaqueRendererRef, RouterConfigV3 } from "./types";
export declare const ACCOUNTS_BROKER_APP_SERVER_SOCKET_FILE = "accounts-broker-app.v1.sock";
export declare const ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES: number;
export declare const ENROLLMENT_MATERIALIZATION_JOURNAL_FILE = "enrollment-materialization.v1.json";
export type EnrollmentMaterializationFaultPointV1 = "after_home_move" | "after_state_publish" | "after_config_publish" | "after_final_commit";
/** Reserved main/preload-only native target bridge. It is not broker command IPC. */
export interface NativeSharedHistoryMapRequestV1 {
    version: 1;
    conversationNativeId: string;
    /** DOM zipper slot only; it carries no authority or conversation proof. */
    composerNativeId: string;
    assistantTurnNativeIds: readonly string[];
}
export type NativeSharedHistoryMapResultV1 = {
    version: 1;
    status: "mapped";
    conversationId: `conversation_${string}`;
    turnIds: Array<`turn_${string}`>;
} | {
    version: 1;
    status: "unavailable";
};
/** Test-only fault injection for deterministic crash-recovery coverage. */
export interface AccountsBrokerOwnerOptionsV1 {
    enrollmentMaterializationFaultAt?: EnrollmentMaterializationFaultPointV1;
    /** Test-only barrier after exclusive election and before every root recovery/write. */
    onReservationAcquired?: () => void | Promise<void>;
    /** Test-only override for the installed recovery-runtime compatibility proof. */
    recoveryCompatibilityPreflight?: () => boolean;
    onStartupStage?: (event: AccountsBrokerStartupEvent) => void;
}
export interface AccountsBrokerStartupEvent {
    stage: "election" | "probe" | "recovery" | "connect";
    code: "started" | "ready" | "unavailable" | "failed" | "invalid_probe_input" | "spawn_failed" | "initialize_failed" | "paginated_history_missing" | "writer_lock_missing" | "probe_timeout" | "probe_failed";
    elapsedMs: number;
}
interface AppClient {
    rendererRef: OpaqueRendererRef;
    appToolsRef: OpaqueAppToolsRef;
    clientKind: BrokerClientKind;
    socket: Socket;
    outstanding: number;
}
/**
 * Long-lived owner for the one global V3 broker. It owns the only private
 * router state store and the only account-local child pool. App-server raw
 * frames remain inside this owner-private socket and are routed only back to
 * their originating desktop endpoint; the public Accounts socket never sees
 * them.
 */
export declare class AccountsBrokerOwnerV1 {
    private config;
    private readonly stateRoot;
    private readonly secret;
    private readonly command;
    private readonly args;
    private broker;
    private readonly children;
    private readonly clients;
    private readonly pendingDesktop;
    private readonly pendingChild;
    private readonly pendingBrokerChild;
    private readonly pendingHistory;
    private readonly pendingHistoryByChild;
    private readonly historyCache;
    private readonly historyCursors;
    private readonly nativeMergedCursors;
    private readonly nativeLegacyProjectListCursors;
    private readonly historySections;
    /** Last successful native listing home per thread; bounded and never persisted as a private row mirror. */
    private readonly nativeSectionHomes;
    /** Account-local section availability is independent of the last merged public section row. */
    private readonly nativeSectionsByAccount;
    private readonly heldDesktopContinuations;
    private readonly taskRefsByThread;
    private readonly threadByTaskRef;
    private readonly enrollmentHelpers;
    private readonly connectionTargets;
    private readonly currentConversationByRenderer;
    /** One active balanced turn per native thread follows the canonical lease. */
    private readonly balanceReservationByThread;
    /** Bounded terminal correlation lets late official cumulative totals repay terminal debt. */
    private readonly settledBalanceReservationByThread;
    /** Latest cumulative provider totals establish a baseline for a known native thread. */
    private readonly tokenUsageByThread;
    /** A typed false from account/read excludes that account from automatic work. */
    private readonly automaticAccountAuthenticated;
    /** Per-account single-flight capacity probes prevent concurrent provider reads. */
    private readonly automaticCapacityRefreshes;
    /** A deferred request gets exactly one bounded refresh pass, never a replay loop. */
    private readonly automaticCapacityRefreshRequests;
    /** Child correlation retains the external request key until its true terminal outcome. */
    private readonly automaticCapacityRefreshByChild;
    /** Exact-root proof is shared across concurrent open/resume requests. */
    private readonly nativeOwnerProofs;
    /** Short-lived read-only provenance from a partial list/search fanout. */
    private readonly nativeReadHints;
    /** One in-memory translation survives the async project import before a new turn starts. */
    private readonly nativeProjectStartTranslations;
    private canonicalHistory;
    private tokenBalance;
    /** Null preserves the existing canonical-history route when no companion exists. */
    private nativeHistory;
    private nativeProjects;
    private nativeLegacyProjects;
    private nativeLegacyProjectsReady;
    private nativeLegacyProjectRefresh;
    private nativeHistoryDegraded;
    private nonce;
    private closed;
    private appServer;
    private appConnections;
    private controlClose;
    private brokerClose;
    private sweepTimer;
    private readonly enrollmentMaterializationFaultAt;
    private readonly onReservationAcquired;
    private readonly recoveryCompatibilityPreflight;
    private initialized;
    private desktopInitialization;
    private readonly initializingDesktopRequests;
    private readonly initializedDesktopClients;
    private readonly featureEnablements;
    private featureRevision;
    private featureBroadcastTail;
    private readonly childFeatureRevision;
    private readonly childFeatureReplay;
    private readonly modelCheckedRequests;
    private readonly inventoryCheckedRequests;
    private inventoryRefresh;
    private inventoryFreshUntil;
    private inventoryFreshKey;
    private readonly modelEligibleRequests;
    private readonly modelCatalogs;
    private remoteRestoreStarted;
    private readonly startupStarted;
    private readonly onStartupStage;
    constructor(config: RouterConfigV3, stateRoot: string, secret: Buffer, command: string, args: readonly string[], options?: AccountsBrokerOwnerOptionsV1);
    private initializeNativeRemote;
    private restoreNativeRemote;
    private recoverNativeWriterCommits;
    private recoverInterruptedNativeTransfers;
    private nativeRetirementRecovery;
    private recoverNativeSourceRetirements;
    private performNativeSourceRetirementRecovery;
    private holdInterruptedNativeTransfers;
    private readRemoteModes;
    private setRemoteMode;
    private remoteBlocksDesktop;
    private accountIsIdle;
    private quiesceIdleAccount;
    private loadedNativeThreads;
    private dispatchRemoteAction;
    private reconcileRemoteActivity;
    /**
     * Recovery and all construction that can write broker-owned state occur
    * only while the lifetime owner-election reservation is held.
    */
    private initializeAfterElection;
    private store;
    private preferences;
    private profileStatistics;
    private nativeTransfer;
    private remoteController;
    private readonly remoteModes;
    private remoteReconciliationPending;
    private readonly nativeTransferHeldAccounts;
    private readonly nativeRetirementHandoffs;
    private readonly nativeContinuityDeferred;
    private readonly nativeContinuityReasons;
    start(): Promise<void>;
    private reportStartup;
    close(): Promise<void>;
    /** Exact-ID resolver used only by the authenticated owner-private socket. */
    mapNativeTargets(rendererRef: OpaqueRendererRef, request: NativeSharedHistoryMapRequestV1): NativeSharedHistoryMapResultV1;
    /** Main-only selected-home context; no credential or account identity leaves the owner. */
    resolveNativeBrowserContext(rendererRef: OpaqueRendererRef, opaqueAccountId: string): Promise<NativeBrowserContextV1>;
    invokeNativeBrowserRequest(rendererRef: OpaqueRendererRef, opaqueAccountId: string, method: string, params: Record<string, unknown>): Promise<unknown | null>;
    /**
     * A continuation payload is intentionally not recoverable.  Pending work
     * that never left memory is cancelled on restart; a persisted forwarding
     * receipt is terminally marked ambiguous, while the durable account owner
     * remains exactly as it was before the attempted move.
     */
    private reconcilePersistedHandoffs;
    private persistPendingHandoff;
    /** A selection changes only the bounded pending receipt, before dispatch. */
    private persistRetargetedHandoff;
    private persistHandoffSettlement;
    private settleHandoff;
    /**
     * The scheduler never owns mutable configuration.  Commit an exact local
     * label/enabled change first, then let the core update its in-memory mirror.
     * A failed durable write is therefore fail-closed and cannot become a
     * misleading renderer success response.
     */
    private persistAccountSettings;
    /**
     * `balance.set` is an explicit policy choice. It never turns a manually
     * routed broker into an automatic one unless the caller asked to enable
     * balancing, and it signs the same config generation as every other router
     * setting change.
     */
    private persistBalanceSetting;
    private isTokenBalancingEnabled;
    private syncTokenBalanceAccounts;
    private balanceConfiguredAccounts;
    /** Current automatic capacity, bounded by dynamic freshness rather than a cached status label. */
    private eligibleAutomaticAccounts;
    /**
     * A stale peer must be refreshed before a new automatic decision. The
     * original desktop frame stays owner-private and is reconsidered exactly
     * once after single-flight account/read + rate-limit probes complete.
     */
    private deferForAutomaticCapacityRefresh;
    private refreshAutomaticCapacity;
    /** Renderer-safe read projection; no provider ids, requests, or contents enter it. */
    private readBalance;
    /** Dispatch only proven account-local provider methods; unknown surfaces fail closed. */
    private dispatchDeviceAction;
    private createEnrollmentHelper;
    private reconnectHelper;
    /** The native base's current credentials select the inventory actor, independently of history/routing ownership. */
    private nativeInventoryBinding;
    /** Cache reuse requires both the exact actor provenance and complete native-consumer schema. */
    private cachedNativeInventory;
    /** Raw bootstrap RPC deliberately bypasses consumer gating and never copies authentication. */
    private ensureNativePluginInventory;
    private deferForNativePluginInventory;
    private reloadSharedNativeChildren;
    /** Reload resident account runtimes after an overlay mutation, without starting idle accounts. */
    private refreshSharedNativeRuntimes;
    private requestBrokerChild;
    /** Feature replay is itself part of readiness, so it uses this protocol-ready seam without recursively awaiting readiness. */
    private requestInitializedBrokerChild;
    /**
     * NativeProjectLinks has no direct child access.  Its reads and tiny
     * idempotent imports/updates pass through the same source fence as every
     * native turn, and the raw provider result never leaves this owner.
     */
    private requestNativeProject;
    /**
     * Read only the metadata account's complete native project id page before
     * consuming its bounded legacy assignment map.  No global-state content is
     * copied into broker history and no native write occurs here.
     */
    private refreshNativeLegacyProjects;
    private readProviderConnections;
    private materializeEnrollment;
    private injectEnrollmentMaterializationFault;
    private retireEnrollmentHelper;
    private startAppServerSocket;
    private serveAppClient;
    private receiveDesktop;
    /** Main/preload-only aggregate read; account and source home come from the signed owner binding. */
    private readDesktopProjects;
    /** Convert only a known logical alias back to its sealed native root. */
    private nativeRootThreadId;
    /**
     * Serializes one exact native owner probe across concurrent desktop frames.
     * A probe only reads `thread/read includeTurns:false`; its result is never
     * retained as history content and is followed by a fresh writer census
     * before the owner mapping/lease shell becomes durable.
     */
    private proveNativeOwnerAndRetry;
    private proveNativeOwner;
    private probeNativeOwner;
    /** Idempotent authoritative app-server lease cleanup; stale close events are ignored. */
    private disconnectAppClient;
    private settleUncertainPending;
    /** Reserve a bounded estimated cost before a balanced provider write. */
    private reserveBalancedTurn;
    private releasePreDispatchBalance;
    /** A successful `thread/start` is the sole proof that this native thread had no prior usage. */
    private seedProvenNewThreadBalance;
    private bindBalanceTurn;
    /** Observe cumulative totals only for a broker-originated reserved turn. */
    private observeBalancedTokenUsage;
    private settleBalancedTurn;
    /** Retain only a bounded private correlation for late official cumulative totals. */
    private rememberSettledBalanceReservation;
    private settledBalanceReservationFor;
    private addPendingDesktop;
    private removePendingDesktop;
    private expirePendingDesktop;
    /**
     * A native companion makes the account homes the history authority while
     * retaining canonical state only for leases, ownership, and broker-era
     * metadata. Without that explicit companion, v3 keeps its empty canonical
     * store behavior exactly as before.
     */
    private routeHistoryRead;
    /** Route exact native history reads to their proven source owner. */
    private routeNativePointHistoryRead;
    /**
     * A partial fanout can still expose a read from its one responding home.
     * It deliberately has no task lease, owner binding, ledger change, or
     * canonical shell, so a later resume must prove all homes again.
     */
    private routeTransientNativePointHistoryRead;
    /** Merge immutable native segments for one logical root without persisting their turns. */
    private routeMergedNativePointHistoryRead;
    private readNativeThreadSnapshots;
    /** Native projects have one explicit source authority, never config-primary. */
    private routeNativeProjectRequest;
    /** Lazily import only allowlisted project metadata before a cross-home start. */
    private ensureNativeProjectAndRetry;
    /** Fetch every physical native segment only for one confirmed handoff. */
    private nativeContinuationContext;
    /** Exact secret-derived marker identifies only broker-written handoff context. */
    private nativeHandoffContextMarker;
    private routeCanonicalHistoryRead;
    private dispatchNextHistoryFanout;
    /**
     * Source native SQLite lacks project_id for legacy members. Page those
     * signed assignments by exact read rather than pretending the native
     * project filter can find them. Once the legacy page is exhausted, continue
     * with ordinary non-null native project rows under the same public cursor.
     */
    private dispatchNativeLegacyProjectRows;
    private resolveHistoryFanout;
    private completeHistoryFanout;
    private failHistoryFanout;
    private historySectionId;
    /** Native section ids remain stable; availability is retained for each contributing account. */
    private nativeHistorySectionId;
    /** A canonical continuation segment is one logical native root, not a second task row. */
    private nativeHistoryRowVisible;
    private bindNativeReadHint;
    private nativeReadHint;
    private cacheHistoryResponse;
    /** Convert a target-local project reference back to the source sidebar id. */
    private withNativePublicProjectIds;
    /** Apply native compatibility-project links plus the signed legacy overlay. */
    private withNativeHistoryProjectIds;
    private refreshNativeLegacyProjectsFromResult;
    private withNativePublicProjectIdsNotification;
    /** Resolve only an owner-private map of provider cursors; request content is
     * represented by an HMAC fingerprint and is never retained with the cursor. */
    private resolveHistoryCursorInput;
    private createHistoryCursor;
    /** Resolve a cursor that is meaningful only while this owner lives. */
    private resolveNativeMergedCursorInput;
    private createNativeMergedCursor;
    private resolveNativeLegacyProjectListCursor;
    private createNativeLegacyProjectListCursor;
    private accountForRequest;
    private accountNeedsContinuationHandoff;
    private selectContinuationTarget;
    /**
     * Existing provider segments remain sticky. A move is only proposed for a
     * new `turn/start` after the prior turn committed, and only when the current
     * segment is materially ahead of its one available peer. Steering,
     * compaction, realtime, and a small difference never churn ownership.
     */
    private shouldProposeBalanceHandoff;
    /** Persist sticky ownership discovered during a merged read without making
     * the reading desktop the reverse app-tools owner of somebody else's task. */
    private bindHistoryOwnership;
    private ensureTask;
    /** Map a stable origin native thread to the currently active immutable segment. */
    private logicalRoute;
    /** Native wire ids stay provider-native while canonical aliases remain internal. */
    private nativeOutboundThreadId;
    private conversationForTask;
    private clientLabel;
    private publishConversation;
    private publishCommittedTurn;
    private readCurrentLogicalHistory;
    /**
     * Sends peer app-server clients one canonical, completed turn snapshot after
     * a durable commit. It deliberately excludes streaming deltas, tool calls,
     * and provider/native identifiers; those remain origin-only.
     */
    private publishPeerCommittedTranscript;
    /**
     * Account availability is a runtime overlay, never a mutation of the
     * immutable committed transcript.  A healthy canonical record is still
     * readable while its owning account home is offline, but callers learn that
     * it cannot currently be resumed from that segment.
     */
    private projectConversation;
    private withCurrentAvailability;
    private syncBrokerAssignedTaskCounts;
    private taskRef;
    /** The only PIDs allowed to retain bound native-home files are this owner and its children. */
    private nativeOwnedPids;
    /** Binding drift blocks new dispatch; a foreign thread never terminates unrelated work. */
    private nativeAccountBinding;
    private nativeHistoryWritersSafe;
    private sharedNativeMode;
    private nativeAccountOperationSafe;
    private nativeThreadConflict;
    /** Synchronous account lease: no callback can interleave capture, preparation and spawn. */
    private prepareAccountContinuity;
    private initializeChild;
    private initializeAndReplayChild;
    private nativeSectionMoveRequest;
    private captureNativeSectionHomes;
    private nativeSectionAvailabilityKey;
    private nativeSectionAvailable;
    private nativeSectionOrderKey;
    private nativeSectionMoveMetadata;
    private commitNativeSectionMove;
    private warmEnabledChildren;
    private broadcastFeatureEnablement;
    private deferForModelCatalog;
    private readAccountModels;
    private deferUntilChildReady;
    private isolatedAuthHome;
    private readonly pendingAuthRefreshRequests;
    private readonly authHelperTails;
    private readonly authHelperQueued;
    private readonly activeAuthHelpers;
    private readonly authRefreshes;
    private withAuthHelper;
    private refreshIsolatedAuth;
    private createChild;
    /**
     * Child-process failure is an uncertain transport outcome for anything
     * already handed to that child.  This path intentionally never retries a
     * request: a duplicate provider write would be worse than a visible
     * ambiguous turn.  Broker-internal probes are safely resolved as unavailable
     * because they do not carry a desktop/canonical writer lease.
     */
    private failPendingForChild;
    private receiveChild;
    private captureEnrollmentNotification;
    private completeIsolatedReconnect;
    private resolveDesktopResponse;
    /** Removes the one terminal watchdog retained after a turn/start acknowledgement. */
    private settleTerminalTurn;
    private routeChildRequest;
    private resolveChildRequest;
    private routeChildNotification;
    private forwardNativeContinuation;
    private forwardContinuation;
    private sendDesktop;
}
export declare class BrokerProcessChild implements BrokerChildV1 {
    readonly opaqueAccountId: OpaqueAccountId;
    private readonly child;
    private readonly onMessage;
    private readonly onClose;
    private readonly authenticate?;
    readonly remoteControlDisabled: true;
    private lines;
    private expectedTermination;
    private transportFailed;
    private closed;
    private readonly closedPromise;
    private resolveClosed;
    private initialization;
    private settleInitialization;
    private initializationTimer;
    private initializationFingerprint;
    private initializedResult;
    private initializedReady;
    initializationClient: AppClient | null;
    private protocolReady;
    private readonly privateRequests;
    private readonly initializeId;
    constructor(opaqueAccountId: OpaqueAccountId, child: ChildProcess, onMessage: (message: JsonRpcMessage) => void, onClose: (expectedTermination: boolean) => void, authenticate?: ((child: BrokerProcessChild) => Promise<boolean>) | undefined);
    /** The owner records only direct source children; census expands this tree itself. */
    get pid(): number | undefined;
    get ready(): boolean;
    get initializeResult(): unknown;
    initialize(params: Record<string, unknown>, client: AppClient): Promise<boolean>;
    /** Owner-private bootstrap RPCs; never routed through renderer correlation. */
    requestPrivate(method: string, params: unknown, timeoutMs?: number): Promise<JsonRpcResponse | null>;
    private finishInitialization;
    send(message: JsonRpcMessage): void;
    terminate(_reason: "idle" | "shutdown" | "capacity" | "disabled"): void;
    terminateAndWait(): Promise<boolean>;
    whenClosed(): Promise<void>;
}
/** Owner command environment: account-local homes plus a forced disable bit. */
export declare function brokerChildEnvironment(codexHome: string, sqliteHome: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Daemon entrypoint. A live socket means another owner won election; exit cleanly. */
export declare function runAccountsBrokerOwnerCli(argv?: string[]): Promise<void>;
/** One bounded owner-private startup record; only enumerated codes and timing. */
export declare function createBrokerStartupDiagnostics(root: string): (event: AccountsBrokerStartupEvent) => void;
/** Observe fatal exits without changing Node's termination or replay behavior. */
export declare function installBrokerTerminationDiagnostics(root: string): void;
export interface AccountsBrokerAppServerClientOptions {
    root: string;
    secret: Buffer;
    clientKind: BrokerClientKind;
    rendererRef: OpaqueRendererRef;
    appToolsRef: OpaqueAppToolsRef;
    /** Startup callers cap each handshake by their remaining monotonic budget. */
    timeoutMs?: number;
}
export interface AccountsBrokerAppServerConnection {
    send(message: JsonRpcMessage): boolean;
    close(): void;
    readonly whenClosed: Promise<void>;
}
/** Connect a per-desktop stdio adapter to the global app-server bridge. */
export declare function connectAccountsBrokerAppServerClient(options: AccountsBrokerAppServerClientOptions, onMessage: (message: JsonRpcMessage) => void): Promise<AccountsBrokerAppServerConnection>;
export declare function createBrokerAppRendererRef(secret: Buffer): OpaqueRendererRef;
export declare function createBrokerAppToolsRef(secret: Buffer): OpaqueAppToolsRef;
/** Last CLI override wins; strip earlier credential-store overrides defensively. */
export declare function credentialStoreArgs(args: readonly string[], store: "ephemeral" | "file"): string[];
export {};

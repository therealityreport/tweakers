import { readNativeExternalTokensV1, readNativeAuthPrivateFileV1, type NativeExternalTokensV1 } from "./native-auth-binding";
import { readSharedNativeModeV1 } from "./shared-native-mode";
import { DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, loadSharedAccountBase, loadSharedPluginsManifestV1, loadAccountContinuitySharedSourceProvenanceV1, ensureAccountContinuityEnrollment, observeExistingNativeAccountContinuity, captureUnmaterializedNativeChangesBeforeSpawn, prepareAccountConfigBeforeSpawn, captureIdleAccountChangesBeforeSpawn, publishPrimarySharedBaseAfterExit, publishPrimaryPluginInventoryAfterExit, isAccountScopedCapabilityMutationV1 } from "./account-continuity";
import { prepareNativeHistoryExtensionUpdateV1, publishPreparedNativeHistoryExtensionUpdateV1, recoverNativeHistoryExtensionUpdateV1, writeNativeHistoryManagedEnrollmentReceiptV1, type PreparedNativeHistoryExtensionUpdateV1, type NativeHistoryManagedAccountDraftV1 } from "./native-history-extensions";
import { NativeProfileStatisticsV1 } from "./profile-statistics";
import { pooledNativeQuotaV1 } from "./pooled-quota";
import { NativeRemoteControllerV1 } from "./remote-controller";
import { NativeTransferCoordinatorV1, Sqlite3NativeCatalogDbV1, probeNativeTransferCapabilityV1 } from "./native-transfer";
import { verifyAccountsTransferRecovery } from "./transfer-recovery";
import { hasConfirmedQuotaDepletion } from "./quota";
import { AccountsPreferencesStore } from "./preferences";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  AccountsBrokerV1,
  safeConnectionDisplayLabel,
  BrokerCommandError,
  accountPoolSeedsFromRouterConfigV3,
  createBrokerHandshakeProof,
  type BrokerChildV1,
  type BrokerDeviceActionV1,
  type BrokerDeviceActionResultV1,
  type BrokerHandoffDeliveryResultV1,
  type BrokerHandoffSettlementV1,
  type BrokerHandoffDeliveryV1,
  type BrokerAccountSettingsChangeV1,
  type BrokerMaterializedAccountV1,
} from "./broker";
import { CanonicalHistoryStoreV1, preflightCanonicalHistoryStore, type PortableTranscriptItemV1 } from "./canonical-history";
import {
  ACCOUNTS_BROKER_SOCKET_FILE,
  ACCOUNTS_BROKER_MAX_FRAME_BYTES,
  accountsBrokerSocketPath,
  readAccountsBrokerSecret,
  reserveAccountsBrokerSocket,
  startBrokerControlSocket,
  type NativeBrowserContextV1,
} from "./broker-socket";
import { ACCOUNT_ROUTER_CONFIG_FILE, readRouterLaunchSelection, routerConfigFingerprint, validateRouterConfig } from "./config";
import { parseJsonRpcLine, threadIdFrom, isNotification, isRequest, isResponse } from "./protocol";
import { redactedRouterError } from "./redaction";
import { RouterStateStore, assertPrivateRegularFile, ensurePrivateDirectory, migrateIdleRouterStateV3, validateRouterState, writePrivateJsonAtomic, writePrivateJsonAtomicBounded } from "./state-store";
import type {
  BrokerClientKind,
  BrokerEnrollmentV1,
  BrokerHandshakeV1,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  OpaqueAccountId,
  OpaqueAppToolsRef,
  OpaqueConnectionDefinitionRef,
  OpaqueConversationId,
  OpaqueRendererRef,
  OpaqueTaskRef,
  OpaqueTurnId,
  LogicalConversationProjectionV1,
  BrokerHistoryReadProjectionV1,
  PendingHandoffV1,
  PersistentHandoffMetadataV1,
  BrokerSafeProfileV1,
  BrokerBalanceProjectionV1,
  BrokerRemoteCommandV1,
  BrokerRemoteProjectionV1,
  RouterConfigV3,
  RouterState,
} from "./types";
import { isOpaqueAccountId, isPlainRecord } from "./types";
import { materializeSharedPluginsIntoAccount, materializeSharedSkillsIntoAccount, preflightRouterHomes, readOwnerPrivateAuthAccountId, sharedPluginChildArgs, sharedPluginsHomeMatches, sharedSkillsHomeMatches } from "./app-server-mux";
import { compareQuotaCandidates, parseAccountRead, parseRateLimitsRead, QUOTA_STALE_AFTER_MS } from "./quota";
import { TokenBalanceLedger, type TokenBalanceReservation } from "./token-balance";
import { isBoundedNativeResultV1, parseNativeBrowserChildRequestV1, requestNativeHttpV1, requestNativeUsageCreditsV1 } from "./native-request";
import { AccountModelCatalogsV1, requestedModelFromParamsV1 } from "./models";
import { NativeProjectLinksV1 } from "./native-projects";
import { proveNativeThreadWriterLease } from "./native-thread-writer-lease";
import { NativeLegacyProjectsV1 } from "./native-legacy-projects";
import {
  nativeHistoryAuthIdentityHmacV1,
  nativeHistoryEffectiveAuthHomeV1,
  readAndPreflightNativeHistoryBaseSourceStaticV1,
  type NativeHistorySourceV1,
  nativeHistoryThreadReadContextV1,
  observeNativeHistoryWritersV1,
  observeNativeAccountWritersV1,
  observeNativeAccountOperationWritersV1,
  renderNativeHistoryContextV1,
  readAndPreflightNativeHistorySourceStaticV1,
  nativeHistoryBindingSafeV1,
  observeNativeThreadWriterV1,
  observeNativeThreadWritersV1,
  type NativeHistoryPortableTurnV1,
  type NativeHistorySourceBindingV1,
} from "./native-history";

export const ACCOUNTS_BROKER_APP_SERVER_SOCKET_FILE = "accounts-broker-app.v1.sock";
// The pinned native backend accepts 64 MiB JSONL messages (internal/backend/child.go).
// Catalogs, tool schemas and native task responses exceed the separate small control plane.
export const ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const OWNER_IDLE_SWEEP_MS = 30_000;
const NATIVE_INVENTORY_FILE = "tweakers-native-inventory.json";
const NATIVE_INVENTORY_PROVENANCE_FILE = "shared-native-plugin-inventory.v1.json";
const NATIVE_INVENTORY_MAX_BYTES = 2 * 1024 * 1024;
type NativePluginInventory = { schema_version: 1; native_base_root: string; plugins: Array<{ id: string; enabled: boolean; version: string | null }> };
const CLIENT_MAX_OUTSTANDING = 256;
const PENDING_DESKTOP_TIMEOUT_MS = 30_000;
const HISTORY_FANOUT_TIMEOUT_MS = 60_000;
const HISTORY_SECTION_BINDING_TTL_MS = 8 * 60 * 60_000;
const HISTORY_CACHE_TTL_MS = 15_000;
const HISTORY_CACHE_MAX_ENTRIES = 32;
const HISTORY_CURSOR_TTL_MS = 5 * 60_000;
const HISTORY_CURSOR_MAX_ENTRIES = 128;
const NATIVE_READ_HINT_TTL_MS = 15_000;
const NATIVE_READ_HINT_MAX_ENTRIES = 512;
const PLUGIN_CONNECTION_RETRY_MS = 200;
const HISTORY_READ_METHODS = new Set(["thread/list", "thread/read", "thread/search", "thread/loaded/list", "thread/turns/list", "thread/items/list", "threadSection/list"]);
/** Exact thread-namespaced reads that are account-scoped and carry no thread owner. */
const OWNERLESS_NATIVE_THREAD_READ_METHODS = new Set(["thread/realtime/listVoices"]);
export const ENROLLMENT_MATERIALIZATION_JOURNAL_FILE = "enrollment-materialization.v1.json";
const MAX_ENROLLMENT_MATERIALIZATION_JOURNAL_BYTES = 256 * 1024;

function isNativePointHistoryRead(method: string): boolean {
  return method === "thread/read" || method === "thread/turns/list" || method === "thread/items/list";
}

function isPartialNativeHistoryRead(method: string): boolean {
  return method === "thread/list" || method === "thread/search" || method === "thread/loaded/list" || method === "threadSection/list";
}

export type EnrollmentMaterializationFaultPointV1 = "after_home_move" | "after_state_publish" | "after_config_publish" | "after_final_commit";

/** Reserved main/preload-only native target bridge. It is not broker command IPC. */
export interface NativeSharedHistoryMapRequestV1 {
  version: 1;
  conversationNativeId: string;
  /** DOM zipper slot only; it carries no authority or conversation proof. */
  composerNativeId: string;
  assistantTurnNativeIds: readonly string[];
}

export type NativeSharedHistoryMapResultV1 =
  | { version: 1; status: "mapped"; conversationId: `conversation_${string}`; turnIds: Array<`turn_${string}`> }
  | { version: 1; status: "unavailable" };

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
  code: "started" | "ready" | "unavailable" | "failed" | "invalid_probe_input" | "spawn_failed"
    | "initialize_failed" | "paginated_history_missing" | "writer_lock_missing" | "probe_timeout" | "probe_failed";
  elapsedMs: number;
}

interface OwnerCliArguments {
  configPath: string;
  stateRoot: string;
  command: string;
  args: string[];
}

interface AppClient {
  rendererRef: OpaqueRendererRef;
  appToolsRef: OpaqueAppToolsRef;
  clientKind: BrokerClientKind;
  socket: Socket;
  outstanding: number;
}

interface PendingDesktopRequest {
  client: AppClient;
  desktopId: JsonRpcId;
  account: OpaqueAccountId;
  taskRef: OpaqueTaskRef | null;
  method: string;
  conversationId: OpaqueConversationId | null;
  logicalTurnId: OpaqueTurnId | null;
  /** Durable reservation created before the provider receives a balanced turn. */
  balanceReservationId: string | null;
  nativeSectionMove?: { threadId: string; sectionKey: string | null; beforeThreadId: string | null };
  /** A turn/start response acknowledges dispatch; terminal settlement waits for turn/completed or failure. */
  acknowledged: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingChildRequest {
  client: AppClient;
  child: BrokerProcessChild;
  childRequestId: JsonRpcId;
}

interface PendingBrokerChildRequest {
  account: OpaqueAccountId;
  resolve: (response: JsonRpcResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingHistoryFanout {
  key: string;
  client: AppClient;
  desktopId: JsonRpcId;
  request: JsonRpcRequest;
  accounts: OpaqueAccountId[];
  nextAccount: number;
  responses: Array<{ account: OpaqueAccountId; response: JsonRpcResponse }>;
  partial: boolean;
  currentChildId: string | null;
  timer: ReturnType<typeof setTimeout>;
  /** Private child cursors; only their HMAC public wrapper reaches desktop. */
  providerCursors: ReadonlyMap<OpaqueAccountId, string> | null;
  queryFingerprint: string;
}

interface CachedHistoryResponse {
  expiresAt: number;
  result: unknown;
}

interface HistoryCursorState {
  expiresAt: number;
  method: string;
  queryFingerprint: string;
  providerCursors: ReadonlyMap<OpaqueAccountId, string>;
}

/** Owner-private offset for a page assembled from immutable native segments. */
interface NativeMergedCursorState {
  expiresAt: number;
  method: string;
  rootThreadId: string;
  queryFingerprint: string;
  offset: number;
}

/** Provider-private cursor for paged exact reads of legacy project members. */
interface NativeLegacyProjectListCursorState {
  expiresAt: number;
  projectId: string;
  legacyOffset: number;
  nativeStarted: boolean;
  nativeCursor: string | null;
}

interface PendingHistoryChildRequest {
  fanout: PendingHistoryFanout;
  account: OpaqueAccountId;
}

type NativeOwnerProof =
  | { state: "owned"; opaqueAccountId: OpaqueAccountId }
  | { state: "transient"; opaqueAccountId: OpaqueAccountId }
  | { state: "unknown" | "collision" | "unavailable" };

interface NativeThreadSnapshot {
  thread: Record<string, unknown>;
  turns: readonly Record<string, unknown>[];
  handoffContextMarker?: string;
}

interface PendingHeldDesktopContinuation {
  rejectionCode?: "account_history_busy";
  client: AppClient;
  desktopId: JsonRpcId;
  forwardChildId: string | null;
  /** Retains the external automatic-routing id through confirmation settlement. */
  automaticCapacityRefreshKey: string | null;
}

interface HistorySectionBinding {
  account: OpaqueAccountId;
  localId: string;
  expiresAt: number;
}

interface NativeSectionHomeBinding {
  account: OpaqueAccountId;
  currentLocalId: string | null;
  expiresAt: number;
}

interface EnrollmentHelper {
  enrollmentRef: string;
  child: BrokerProcessChild;
  /** Private transport identity for a temporary enrollment child. */
  transportAccountId: OpaqueAccountId;
  root: string | null;
  opaqueAccountId: OpaqueAccountId | null;
  loginId: string | null;
  completion: { success: boolean } | null;
  isolatedReconnect?: { authHome: string; preimage: Buffer; timer: ReturnType<typeof setTimeout> };
}

interface EnrollmentMaterializationJournalV1 {
  version: 1;
  nativeExtension?: { source: NativeHistorySourceV1; sourceDocumentFingerprint: `sha256:${string}`; prepared: PreparedNativeHistoryExtensionUpdateV1 | null };
  enrollmentRef: string;
  opaqueAccountId: OpaqueAccountId;
  phase: "prepared" | "home_moved" | "state_published" | "config_published";
  priorConfig: RouterConfigV3;
  nextConfig: RouterConfigV3;
  priorConfigDigest: `sha256:${string}`;
  nextConfigDigest: `sha256:${string}`;
  priorStateDigest: `sha256:${string}`;
  nextStateDigest: `sha256:${string}`;
}

class EnrollmentMaterializationFault extends Error {}

interface ProviderConnectionTarget {
  opaqueAccountId: OpaqueAccountId;
  kind: BrokerClientConnectionKind;
  name: string;
}

type BrokerClientConnectionKind = "app" | "plugin" | "mcp" | "workspace";

/**
 * Long-lived owner for the one global V3 broker. It owns the only private
 * router state store and the only account-local child pool. App-server raw
 * frames remain inside this owner-private socket and are routed only back to
 * their originating desktop endpoint; the public Accounts socket never sees
 * them.
 */
export class AccountsBrokerOwnerV1 {
  private broker!: AccountsBrokerV1;
  private readonly children = new Map<OpaqueAccountId, BrokerProcessChild>();
  private readonly clients = new Map<OpaqueRendererRef, AppClient>();
  private readonly pendingDesktop = new Map<string, PendingDesktopRequest>();
  private readonly pendingChild = new Map<string, PendingChildRequest>();
  private readonly pendingBrokerChild = new Map<string, PendingBrokerChildRequest>();
  private readonly pendingHistory = new Map<string, PendingHistoryFanout>();
  private readonly pendingHistoryByChild = new Map<string, PendingHistoryChildRequest>();
  private readonly historyCache = new Map<string, CachedHistoryResponse>();
  private readonly historyCursors = new Map<string, HistoryCursorState>();
  private readonly nativeMergedCursors = new Map<string, NativeMergedCursorState>();
  private readonly nativeLegacyProjectListCursors = new Map<string, NativeLegacyProjectListCursorState>();
  private readonly historySections = new Map<string, HistorySectionBinding>();
  /** Last successful native listing home per thread; bounded and never persisted as a private row mirror. */
  private readonly nativeSectionHomes = new Map<string, NativeSectionHomeBinding>();
  /** Account-local section availability is independent of the last merged public section row. */
  private readonly nativeSectionsByAccount = new Map<string, number>();
  private readonly heldDesktopContinuations = new Map<string, PendingHeldDesktopContinuation>();
  private readonly taskRefsByThread = new Map<string, OpaqueTaskRef>();
  private readonly threadByTaskRef = new Map<OpaqueTaskRef, string>();
  private readonly enrollmentHelpers = new Map<string, EnrollmentHelper>();
  private readonly connectionTargets = new Map<string, ProviderConnectionTarget>();
  private readonly currentConversationByRenderer = new Map<OpaqueRendererRef, OpaqueConversationId>();
  /** One active balanced turn per native thread follows the canonical lease. */
  private readonly balanceReservationByThread = new Map<string, string>();
  /** Bounded terminal correlation lets late official cumulative totals repay terminal debt. */
  private readonly settledBalanceReservationByThread = new Map<string, Array<{ account: OpaqueAccountId; reservationId: string; turnId: string | null }>>();
  /** Latest cumulative provider totals establish a baseline for a known native thread. */
  private readonly tokenUsageByThread = new Map<string, unknown>();
  /** A typed false from account/read excludes that account from automatic work. */
  private readonly automaticAccountAuthenticated = new Map<OpaqueAccountId, boolean>();
  /** Per-account single-flight capacity probes prevent concurrent provider reads. */
  private readonly automaticCapacityRefreshes = new Map<OpaqueAccountId, Promise<void>>();
  /** A deferred request gets exactly one bounded refresh pass, never a replay loop. */
  private readonly automaticCapacityRefreshRequests = new Set<string>();
  /** Child correlation retains the external request key until its true terminal outcome. */
  private readonly automaticCapacityRefreshByChild = new Map<string, string>();
  /** Exact-root proof is shared across concurrent open/resume requests. */
  private readonly nativeOwnerProofs = new Map<string, Promise<NativeOwnerProof>>();
  /** Short-lived read-only provenance from a partial list/search fanout. */
  private readonly nativeReadHints = new Map<string, { opaqueAccountId: OpaqueAccountId; expiresAt: number }>();
  /** One in-memory translation survives the async project import before a new turn starts. */
  private readonly nativeProjectStartTranslations = new WeakMap<JsonRpcRequest, { account: OpaqueAccountId; projectId: string }>();
  private canonicalHistory!: CanonicalHistoryStoreV1;
  private tokenBalance!: TokenBalanceLedger;
  /** Null preserves the existing canonical-history route when no companion exists. */
  private nativeHistory: NativeHistorySourceBindingV1 | null = null;
  private nativeProjects: NativeProjectLinksV1 | null = null;
  private nativeLegacyProjects: NativeLegacyProjectsV1 | null = null;
  private nativeLegacyProjectsReady = false;
  private nativeLegacyProjectRefresh: Promise<boolean> | null = null;
  private nativeHistoryDegraded = false;
  private nonce = 0;
  private closed = false;
  private appServer: Server | null = null;
  private appConnections = new Set<Socket>();
  private controlClose: (() => Promise<void>) | null = null;
  private brokerClose: (() => Promise<void>) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly enrollmentMaterializationFaultAt: EnrollmentMaterializationFaultPointV1 | null;
  private readonly onReservationAcquired: (() => void | Promise<void>) | null;
  private readonly recoveryCompatibilityPreflight: () => boolean;
  private initialized = false;
  private desktopInitialization: { params: Record<string, unknown>; fingerprint: string; client: AppClient } | null = null;
  private readonly initializingDesktopRequests = new Set<string>();
  private readonly initializedDesktopClients = new Map<AppClient, Record<string, unknown>>();
  private readonly featureEnablements = new Map<string, Record<string, unknown>>();
  private featureRevision = 0;
  private featureBroadcastTail: Promise<void> = Promise.resolve();
  private readonly childFeatureRevision = new WeakMap<BrokerProcessChild, number>();
  private readonly childFeatureReplay = new WeakMap<BrokerProcessChild, Promise<boolean>>();
  private readonly modelCheckedRequests = new WeakSet<JsonRpcRequest>();
  private readonly inventoryCheckedRequests = new WeakSet<JsonRpcRequest>();
  private inventoryRefresh: { key: string; promise: Promise<boolean> } | null = null;
  private inventoryFreshUntil = 0;
  private inventoryFreshKey = "";
  private readonly modelEligibleRequests = new WeakMap<JsonRpcRequest, Set<OpaqueAccountId>>();
  private readonly modelCatalogs = new AccountModelCatalogsV1((account) => this.readAccountModels(account));
  private remoteRestoreStarted = false;
  private readonly startupStarted = performance.now();
  private readonly onStartupStage: AccountsBrokerOwnerOptionsV1["onStartupStage"];

  constructor(
    private config: RouterConfigV3,
    private readonly stateRoot: string,
    private readonly secret: Buffer,
    private readonly command: string,
    private readonly args: readonly string[],
    options: AccountsBrokerOwnerOptionsV1 = {},
  ) {
    this.onStartupStage = options.onStartupStage;
    this.enrollmentMaterializationFaultAt = options.enrollmentMaterializationFaultAt ?? null;
    this.onReservationAcquired = options.onReservationAcquired ?? null;
    this.recoveryCompatibilityPreflight = options.recoveryCompatibilityPreflight
      ?? (() => verifyAccountsTransferRecovery(resolve(__dirname, "..")));
  }

  private async initializeNativeRemote(): Promise<void> {
    if (!this.nativeHistory) return;
    const binding = this.nativeHistory;
    this.nativeTransfer = new NativeTransferCoordinatorV1({
      stateRoot: this.stateRoot,
      recoveryCompatibilityPreflight: this.recoveryCompatibilityPreflight,
      accounts: binding.accounts.map((account) => ({ accountId: account.opaqueAccountId, codexHome: account.codexHome, sqliteHome: account.sqliteHome })),
      primaryAccountId: binding.source.metadataAccountId,
      db: new Sqlite3NativeCatalogDbV1(),
      capabilityProbe: () => probeNativeTransferCapabilityV1({ command: this.command, args: this.args, cwd: process.cwd() }),
      bindingPreflight: () => !this.closed && this.nativeHistory !== null && nativeHistoryBindingSafeV1(this.nativeHistory),
      writerCensus: () => this.nativeHistory !== null && observeNativeHistoryWritersV1(this.nativeHistory, this.nativeOwnedPids()).ok,
      accountOfflinePreflight: (account) => !this.closed && this.nativeHistory !== null
        && this.nativeTransferHeldAccounts.has(account) && !this.children.has(account)
        && this.accountIsIdle(account, this.nativeRetirementHandoffs.get(account))
        && observeNativeHistoryWritersV1(this.nativeHistory, this.nativeOwnedPids()).ok,
      exactThreadCensus: (threadId) => this.nativeThreadConflict(threadId),
      resumedWriterLockProof: (threadId, targetAccountId, identity) => {
        const target = this.nativeAccountBinding(targetAccountId);
        const pid = this.children.get(targetAccountId)?.pid;
        return Boolean(target && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
          && proveNativeThreadWriterLease(join(target.codexHome, "thread-writer-locks"), threadId, identity, pid));
      },
      catalogThreadCensus: async (threadIds) => new Map(
        [...await observeNativeThreadWritersV1(binding, threadIds, this.nativeOwnedPids())]
          .map(([threadId, observation]) => [threadId, observation.state]),
      ),
    });
    this.reportStartup("probe", "started");
    const capability = await this.nativeTransfer.probeCapability();
    this.reportStartup("probe", capability.state === "ready" ? "ready" : capability.reason);
    this.nativeTransfer.provisionSharedWriterLocks();
    this.recoverNativeWriterCommits();
    await this.recoverInterruptedNativeTransfers();
    await this.recoverNativeSourceRetirements();
    this.readRemoteModes();
    this.remoteController = new NativeRemoteControllerV1({
      secret: this.secret,
      request: async (account, method, params) => {
        const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
        if (!child) throw new Error("native request outcome unavailable");
        const response = await this.requestBrokerChild(account, child, method, params ?? {});
        if (!response) throw new Error("native request outcome unavailable");
        if (response.error) throw response.error;
        return response.result;
      },
      gate: {
        beginEnable: async (account) => {
          if (this.nativeTransfer?.preflightSharedWriterLocks().state !== "ready") return "unavailable";
          if (this.remoteModes.get(account) === "enabled") {
            if (!await this.nativeTransfer.verifyRemoteEligibility(account)) return "unavailable";
            this.broker.setChildPinned(account, true);
            return "ready";
          }
          if (this.nativeTransferHeldAccounts.has(account) || this.remoteModes.get(account) === "draining" || !this.accountIsIdle(account)) return "busy";
          this.setRemoteMode(account, "draining");
          this.broker.setChildPinned(account, false);
          this.nativeTransferHeldAccounts.add(account);
          try {
            if (!await this.quiesceIdleAccount(account)) {
              this.setRemoteMode(account, "disabled");
              return "busy";
            }
            if (!await this.nativeTransfer.verifyRemoteEligibility(account)) {
              this.setRemoteMode(account, "disabled");
              return "unavailable";
            }
            this.broker.setChildPinned(account, true);
            return "ready";
          } catch {
            this.setRemoteMode(account, "disabled");
            return "unavailable";
          } finally {
            this.nativeTransferHeldAccounts.delete(account);
          }
        },
        commitEnabled: (account) => this.setRemoteMode(account, "enabled"),
        abortEnable: (account) => { this.setRemoteMode(account, "disabled"); this.broker.setChildPinned(account, false); },
        beginDisable: (account) => this.setRemoteMode(account, "draining"),
        loadedThreads: (account) => this.loadedNativeThreads(account),
        commitDisabled: (account) => { this.setRemoteMode(account, "disabled"); this.broker.setChildPinned(account, false); },
      },
    });
  }

  private async restoreNativeRemote(): Promise<void> {
    if (this.remoteRestoreStarted || !this.desktopInitialization || !this.remoteController) return;
    this.remoteRestoreStarted = true;
    // Previous processes start remote-disabled; restore each saved intent only through the gate.
    for (const [account, mode] of [...this.remoteModes]) {
      if (mode === "enabled") await this.remoteController.enable(account);
      else if (mode === "draining") this.setRemoteMode(account, "disabled");
    }
  }

  private recoverNativeWriterCommits(): void {
    if (!this.nativeTransfer) return;
    for (const operation of this.nativeTransfer.pendingWriterCommits()) {
      const conversationId = this.canonicalHistory.conversationForNative(operation.sourceAccountId, operation.threadId)
        ?? this.canonicalHistory.conversationForNative(operation.targetAccountId, operation.threadId);
      if (!conversationId) throw new Error("native transfer recovery conversation unavailable");
      this.store.update((state) => {
        const owner = state.threadOwners[operation.threadId];
        if (owner !== operation.sourceAccountId && owner !== operation.targetAccountId) throw new Error("native transfer recovery owner mismatch");
        if (owner !== operation.targetAccountId) {
          state.threadOwners[operation.threadId] = operation.targetAccountId;
          state.ledger[operation.sourceAccountId]!.assignedThreadCount = Math.max(0, state.ledger[operation.sourceAccountId]!.assignedThreadCount - 1);
          state.ledger[operation.targetAccountId]!.assignedThreadCount += 1;
        }
      });
      this.canonicalHistory.reconcileNativeWriter(conversationId, operation.targetAccountId, operation.threadId);
      this.nativeTransfer.commitWriter(operation.operationId);
    }
    this.syncBrokerAssignedTaskCounts();
  }

  private async recoverInterruptedNativeTransfers(): Promise<void> {
    if (!this.nativeTransfer) return;
    const pending = this.nativeTransfer.pendingTransfersForRecovery();
    if (pending.length === 0) return;
    const loaded = new Map<OpaqueAccountId, readonly { threadId: string }[]>();
    for (const account of this.config.accounts) {
      const child = this.broker.acquireChild(account.opaqueAccountId) as BrokerProcessChild | null;
      if (!child) return this.holdInterruptedNativeTransfers(pending);
      const threadIds = await this.loadedNativeThreads(account.opaqueAccountId);
      if (threadIds === null) return this.holdInterruptedNativeTransfers(pending);
      loaded.set(account.opaqueAccountId, threadIds.map((threadId) => ({ threadId })));
    }
    const recovered = await this.nativeTransfer.recoverInterruptedTransfers(loaded);
    const held = new Set(recovered.heldOperationIds);
    this.holdInterruptedNativeTransfers(pending.filter((operation) => held.has(operation.operationId)));
  }

  private nativeRetirementRecovery: Promise<void> | null = null;

  private async recoverNativeSourceRetirements(): Promise<void> {
    if (this.nativeRetirementRecovery) return this.nativeRetirementRecovery;
    const pending = this.performNativeSourceRetirementRecovery();
    this.nativeRetirementRecovery = pending;
    try { await pending; } finally { if (this.nativeRetirementRecovery === pending) this.nativeRetirementRecovery = null; }
  }

  private async performNativeSourceRetirementRecovery(): Promise<void> {
    const transfer = this.nativeTransfer;
    if (!transfer) return;
    const heldHere = new Set<OpaqueAccountId>();
    for (const operation of transfer.pendingSourceRetirements()) {
      const account = operation.sourceAccountId;
      if (!this.nativeTransferHeldAccounts.has(account) && this.accountIsIdle(account)) {
        this.nativeTransferHeldAccounts.add(account);
        heldHere.add(account);
      }
    }
    if (!heldHere.size) return;
    try {
      for (const account of heldHere) await this.quiesceIdleAccount(account);
      await transfer.recoverSourceRetirements();
    } finally {
      for (const account of heldHere) this.nativeTransferHeldAccounts.delete(account);
    }
  }

  private holdInterruptedNativeTransfers(
    operations: readonly { sourceAccountId: OpaqueAccountId; targetAccountId: OpaqueAccountId }[],
  ): void {
    for (const operation of operations) {
      this.nativeTransferHeldAccounts.add(operation.sourceAccountId);
      this.nativeTransferHeldAccounts.add(operation.targetAccountId);
    }
  }

  private readRemoteModes(): void {
    const path = join(this.stateRoot, "accounts-remote-modes.v1.json");
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    assertPrivateRegularFile(path, 16_384);
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainRecord(value) || value.version !== 1 || Object.keys(value).sort().join("\0") !== "accounts\0version" || !Array.isArray(value.accounts)) throw new Error("invalid remote mode state");
    for (const row of value.accounts) {
      if (!isPlainRecord(row) || Object.keys(row).sort().join("\0") !== "accountId\0mode" || !isOpaqueAccountId(row.accountId)
        || !this.config.accounts.some((account) => account.opaqueAccountId === row.accountId) || this.remoteModes.has(row.accountId)
        || (row.mode !== "disabled" && row.mode !== "draining" && row.mode !== "enabled")) throw new Error("invalid remote account mode");
      this.remoteModes.set(row.accountId, row.mode);
    }
  }

  private setRemoteMode(account: OpaqueAccountId, mode: "disabled" | "draining" | "enabled"): void {
    const next = new Map(this.remoteModes); next.set(account, mode);
    writePrivateJsonAtomic(this.stateRoot, "accounts-remote-modes.v1.json", { version: 1, accounts: [...next].map(([accountId, mode]) => ({ accountId, mode })) });
    this.remoteModes.clear(); for (const [id, state] of next) this.remoteModes.set(id, state);
  }

  private remoteBlocksDesktop(account: OpaqueAccountId): boolean {
    if (this.nativeTransferHeldAccounts.has(account)) return true;
    const mode = this.remoteModes.get(account);
    return mode === "draining" || mode === "enabled";
  }

  private accountIsIdle(account: OpaqueAccountId, ignoredHandoff?: string): boolean {
    return ![...this.heldDesktopContinuations.keys()].some((key) => key !== ignoredHandoff && this.broker.pendingHandoff(key as any)?.fromOpaqueAccountId === account)
      && ![...this.pendingDesktop.values()].some((pending) => pending.account === account)
      && ![...this.pendingChild.values()].some((pending) => pending.child.opaqueAccountId === account)
      && ![...this.pendingBrokerChild.values()].some((pending) => pending.account === account)
      && ![...this.pendingHistoryByChild.values()].some((pending) => pending.account === account)
      && !this.broker.pool().accounts.some((candidate) => candidate.opaqueAccountId === account && candidate.state === "active");
  }

  private async quiesceIdleAccount(account: OpaqueAccountId, ignoredHandoff?: string): Promise<boolean> {
    if (!this.accountIsIdle(account, ignoredHandoff)) return false;
    const existing = this.children.get(account);
    if (!existing) return true;
    const released = this.broker.releaseIdleChild(account) as BrokerProcessChild | null;
    if (!released || released !== existing) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([released.whenClosed().then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async loadedNativeThreads(account: OpaqueAccountId): Promise<readonly string[] | null> {
    const child = this.children.get(account);
    if (!child) return [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.requestBrokerChild(account, child, "thread/loaded/list", { limit: 512, ...(cursor ? { cursor } : {}) });
      if (!response || response.error || !isPlainRecord(response.result) || !Array.isArray(response.result.data)
        || response.result.data.length > 16_384 || !response.result.data.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) return null;
      for (const id of response.result.data as string[]) {
        if (ids.has(id)) return null;
        ids.add(id);
      }
      if (ids.size > 16_384) return null;
      const next = response.result.nextCursor;
      if (next === null || next === undefined) return [...ids];
      if (typeof next !== "string" || next.length < 1 || next.length > 4096 || cursors.has(next)) return null;
      cursors.add(next); cursor = next;
    } while (cursors.size <= 128);
    return null;
  }

  private async dispatchRemoteAction(command: BrokerRemoteCommandV1, accountId: OpaqueAccountId, deviceId?: string): Promise<BrokerRemoteProjectionV1> {
    if (!this.remoteController) throw new BrokerCommandError("broker_unavailable", true);
    if (command === "remote.enable" && this.remoteModes.get(accountId) !== "enabled" && !this.accountIsIdle(accountId)) throw new BrokerCommandError("account_history_busy", true);
    switch (command) {
      case "remote.status": return this.remoteController.status(accountId);
      case "remote.enable": return this.remoteController.enable(accountId);
      case "remote.disable": return this.remoteController.disable(accountId);
      case "remote.pairing.start": {
        if (this.remoteModes.get(accountId) !== "enabled") {
          const enabled = await this.remoteController.enable(accountId);
          if (!enabled.enabled || enabled.state === "unavailable") return enabled;
        }
        return this.remoteController.pairingStart(accountId);
      }
      case "remote.pairing.status": return this.remoteController.pairingStatus(accountId);
      case "remote.pairing.close": this.remoteController.closePairing(accountId); return this.remoteController.status(accountId);
      case "remote.devices.list": return this.remoteController.devicesList(accountId);
      case "remote.devices.revoke": return this.remoteController.deviceRevoke(accountId, deviceId!);
    }
  }

  private async reconcileRemoteActivity(): Promise<void> {
    if (this.closed || !this.nativeTransfer || this.remoteReconciliationPending) return;
    this.remoteReconciliationPending = true;
    try {
      if (this.nativeTransfer.preflightSharedWriterLocks().state !== "ready") {
        for (const [account, mode] of this.remoteModes) if (mode === "enabled") await this.remoteController?.disable(account);
        return;
      }
      const catalog = await this.nativeTransfer.reconcileCatalog({ project: false });
      if (catalog.state !== "ready") return;
      const loaded = new Map<OpaqueAccountId, readonly { threadId: string }[]>();
      for (const account of this.config.accounts) {
        const ids = await this.loadedNativeThreads(account.opaqueAccountId);
        if (ids === null) return;
        loaded.set(account.opaqueAccountId, ids.map((threadId) => ({ threadId })));
      }
      const reconciled = this.nativeTransfer.reconcileRemoteWriter(loaded);
      for (const threadId of reconciled.updatedThreadIds) {
        const owner = this.nativeTransfer.ownerForThread(threadId);
        if (!owner) continue;
        const previous = this.store.snapshot().threadOwners[threadId];
        if (previous === owner) continue;
        const conversation = previous ? this.canonicalHistory.conversationForNative(previous, threadId) : null;
        if (conversation && this.canonicalHistory.hasActiveTurn(conversation)) continue;
        if (conversation) this.canonicalHistory.reconcileNativeWriter(conversation, owner, threadId);
        this.store.update((state) => {
          if (previous) state.ledger[previous]!.assignedThreadCount = Math.max(0, state.ledger[previous]!.assignedThreadCount - 1);
          state.threadOwners[threadId] = owner;
          state.ledger[owner]!.assignedThreadCount += 1;
        });
        const task = this.taskRefsByThread.get(threadId);
        if (task && previous) this.broker.transferNativeTask(task, previous, owner);
        this.nativeReadHints.delete(threadId);
      }
      this.syncBrokerAssignedTaskCounts();
    } catch {
      // A failed poll cannot relax a remote writer gate or invent ownership.
    } finally { this.remoteReconciliationPending = false; }
  }

  /**
   * Recovery and all construction that can write broker-owned state occur
  * only while the lifetime owner-election reservation is held.
  */
  private initializeAfterElection(): void {
    this.config = recoverEnrollmentMaterialization(this.stateRoot, this.config, this.secret);
    const native = readAndPreflightNativeHistorySourceStaticV1(this.stateRoot, this.config, this.secret);
    if (native.state === "invalid") {
      throw new Error("accounts broker native history source preflight failed");
    }
    this.nativeHistory = native.state === "ready" ? native.binding : null;
    if (!preflightRouterHomes(this.config, this.stateRoot)) {
      throw new Error("accounts broker shared Skills/account-home preflight failed (including plugins)");
    }
    // This owner is now the elected global writer. Recover the independent
    // token ledger before any child can be acquired or a provider request can
    // be sent; an in-flight reservation remains an honest uncertainty after a
    // restart and is never replayed or silently released.
    this.tokenBalance = new TokenBalanceLedger({
      root: this.stateRoot,
      accounts: this.config.accounts.map((account) => ({
        opaqueAccountId: account.opaqueAccountId,
        included: account.included,
      })),
    });
    // In-place native homes predate broker accounting. Their historical
    // cumulative spend is deliberately unmeasured, never an apparent exact
    // zero; only subsequent broker-owned provider work enters the ledger.
    if (this.nativeHistory) {
      this.tokenBalance.markImportedHistoryUnmeasured(this.nativeHistory.accounts.map((account) => account.opaqueAccountId));
    }
    this.tokenBalance.recover();
    // No provider write is replayed after takeover. Fold any possibly-written
    // recovery record into conservative terminal debt so a crash loop cannot
    // exhaust the bounded active reservation capacity; later official totals
    // can still reconcile that owner-private debt.
    this.tokenBalance.terminalizeUncertainAfterRecovery();
    const store = new RouterStateStore(this.stateRoot, this.config);
    this.store = store;
    // Adopt the quota policy once, retaining the historical token ledger for recovery.
    if (this.config.policy === "balanced_tokens_v1" && !this.persistBalanceSetting(false)) throw new Error("quota policy migration failed");
    const canonicalPreflight = preflightCanonicalHistoryStore(this.stateRoot);
    if (canonicalPreflight.state !== "ready") {
      throw new Error(`canonical history store is ${canonicalPreflight.state}; migration/bootstrap is required before v3 broker startup`);
    }
    this.canonicalHistory = new CanonicalHistoryStoreV1(
      this.stateRoot,
      Date.now,
      randomBytes,
      (nativeThreadId) => `lh_${createHmac("sha256", this.secret).update(`canonical-history:v1:${nativeThreadId}`, "utf8").digest("base64url")}`,
    );
    // No child request survives an owner restart. Reconcile persisted leases
    // before accepting a client: prepared is safely aborted; any potentially
    // written dispatch is visibly ambiguous and deliberately never replayed.
    this.canonicalHistory.recoverInFlightTurns();
    this.preferences = new AccountsPreferencesStore(this.stateRoot);
    this.profileStatistics = new NativeProfileStatisticsV1({ secret: this.secret, accounts: () => this.config.accounts.map((account) => ({
      accountId: account.opaqueAccountId, enabled: account.included,
      codexHome: this.nativeHistory ? this.isolatedAuthHome(account.opaqueAccountId) ?? this.nativeAccountBinding(account.opaqueAccountId)!.codexHome : join(this.stateRoot, "accounts", account.opaqueAccountId, "codex-home"),
    })) });
    this.broker = new AccountsBrokerV1({
      accounts: accountPoolSeedsFromRouterConfigV3(this.config, store.snapshot().ledger),
      secret: this.secret,
      childFactory: {
        create: (input) => this.createChild(input.opaqueAccountId),
      },
      onHandoffCreated: (handoff) => this.persistPendingHandoff(handoff),
      onHandoffRetargeted: (handoff) => this.persistRetargetedHandoff(handoff),
      onHandoffSettled: (handoff, state) => this.settleHandoff(handoff, state),
      onForwardContinuation: (delivery) => this.forwardContinuation(delivery),
      onDeviceAction: (action) => this.dispatchDeviceAction(action),
      onEnrollmentMaterialized: (enrollment) => this.materializeEnrollment(enrollment),
      onEnrollmentSettled: (enrollment) => {
        if ((enrollment.kind === "enrollment" && enrollment.opaqueAccountId === null) || this.enrollmentHelpers.get(enrollment.enrollmentRef)?.isolatedReconnect) this.retireEnrollmentHelper(enrollment.enrollmentRef);
      },
      onAccountSettingsChanged: (change) => {
        const saved = this.persistAccountSettings(change);
        if (saved && change.enabled === true) queueMicrotask(() => { void this.warmEnabledChildren(); });
        return saved;
      },
      onProfileStatistics: (selection) => this.profileStatistics.read(selection),
      onRemoteAction: (command, accountId, deviceId) => this.dispatchRemoteAction(command, accountId, deviceId),
      onPreferencesRead: () => this.preferences.snapshot(),
      onAccountContinuityRead: (account) => {
        const deferred = this.nativeContinuityDeferred.has(account);
        const reason = deferred ? this.nativeContinuityReasons.get(account) : undefined;
        return { continuityState: deferred ? "deferred" : "ready", ...(reason ? { continuityReason: reason } : {}) };
      },
      onPreferencesUpdate: (patch) => {
        if (patch.unifiedCatalogEnabled === true && this.nativeTransfer?.preflightSharedWriterLocks().state !== "ready") throw new BrokerCommandError("broker_unavailable", true);
        const preferences = this.preferences.update(patch);
        if (preferences.unifiedCatalogEnabled) void this.reconcileRemoteActivity();
        return preferences;
      },
      onBalanceRead: () => this.readBalance(),
      onBalanceSet: (enabled) => this.persistBalanceSetting(enabled),
      onHistoryRead: (rendererRef) => this.readCurrentLogicalHistory(rendererRef),
    });
    if (this.nativeHistory) {
      // The signed source names the sole native project authority.  The
      // registry persists only bounded project ids/name/roots mappings and
      // calls back through this owner for every source read/import/update.
      this.nativeProjects = new NativeProjectLinksV1(
        this.stateRoot,
        this.nativeHistory.source.metadataAccountId,
        this.secret,
        (account, method, params) => this.requestNativeProject(account, method, params),
      );
      const metadataSource = this.nativeAccountBinding(this.nativeHistory.source.metadataAccountId);
      if (!metadataSource) throw new Error("native history metadata source is unavailable");
      this.nativeLegacyProjects = new NativeLegacyProjectsV1(
        this.stateRoot,
        metadataSource.codexHome,
        this.nativeHistory.source.metadataAccountId,
      );
    }
    this.initialized = true;
  }

  private store!: RouterStateStore;
  private preferences!: AccountsPreferencesStore;
  private profileStatistics!: NativeProfileStatisticsV1;
  private nativeTransfer: NativeTransferCoordinatorV1 | null = null;
  private remoteController: NativeRemoteControllerV1 | null = null;
  private readonly remoteModes = new Map<OpaqueAccountId, "disabled" | "draining" | "enabled">();
  private remoteReconciliationPending = false;
  private readonly nativeTransferHeldAccounts = new Set<OpaqueAccountId>();
  private readonly nativeRetirementHandoffs = new Map<OpaqueAccountId, string>();
  private readonly nativeContinuityDeferred = new Set<OpaqueAccountId>();
  private readonly nativeContinuityReasons = new Map<OpaqueAccountId, "migration_pending" | "account_in_use" | "source_changed" | "recovery_required">();

  async start(): Promise<void> {
    if (this.closed) throw new Error("accounts broker owner is closed");
    // The reservation is the global election. No shared-root recovery is
    // allowed until it is exclusively held, and it remains held through the
    // owner's final cleanup.
    this.reportStartup("election", "started");
    const reservation = await reserveAccountsBrokerSocket({ root: this.stateRoot, secret: this.secret }).catch((error) => {
      this.reportStartup("election", "unavailable");
      throw error;
    });
    this.reportStartup("election", "ready");
    this.brokerClose = () => reservation.close();
    let startupPhase: "recovery" | "connect" = "recovery";
    try {
      await this.onReservationAcquired?.();
      this.reportStartup("recovery", "started");
      this.initializeAfterElection();
      await this.initializeNativeRemote();
      this.reconcilePersistedHandoffs();
      this.reportStartup("recovery", "ready");
      startupPhase = "connect";
      this.reportStartup("connect", "started");
      const brokerSocket = reservation.activate({ broker: this.broker,
        mapNativeTargets: (rendererRef, request) => this.mapNativeTargets(rendererRef, request),
        resolveNativeBrowserContext: (rendererRef, account) => this.resolveNativeBrowserContext(rendererRef, account),
        invokeNativeBrowserRequest: (rendererRef, account, method, params) => this.invokeNativeBrowserRequest(rendererRef, account, method, params) });
      this.brokerClose = () => brokerSocket.close();
      const controlSocket = await startBrokerControlSocket({ root: this.stateRoot, secret: this.secret, status: () => this.broker.status() });
      this.controlClose = () => controlSocket.close();
      await this.startAppServerSocket();
      this.reportStartup("connect", "ready");
      this.sweepTimer = setInterval(() => {
        this.broker.sweep();
        if (this.nativeHistory && this.children.size > 0) this.nativeHistoryWritersSafe();
        if (this.nativeHistory && this.children.size > 0 && this.desktopInitialization) void this.ensureNativePluginInventory();
        void this.reconcileRemoteActivity();
      }, OWNER_IDLE_SWEEP_MS);
      this.sweepTimer.unref();
    } catch (error) {
      this.reportStartup(startupPhase, "failed");
      await this.close();
      throw error;
    }
  }

  private reportStartup(stage: AccountsBrokerStartupEvent["stage"], code: AccountsBrokerStartupEvent["code"]): void {
    try { this.onStartupStage?.({ stage, code, elapsedMs: Math.max(0, Math.min(600_000, Math.round(performance.now() - this.startupStarted))) }); }
    catch { /* Startup diagnostics cannot alter election or recovery. */ }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.remoteController?.dispose();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    for (const socket of this.appConnections) socket.destroy();
    this.appConnections.clear();
    for (const pending of this.pendingBrokerChild.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingBrokerChild.clear();
    for (const fanout of this.pendingHistory.values()) {
      clearTimeout(fanout.timer);
      fanout.client.outstanding = Math.max(0, fanout.client.outstanding - 1);
    }
    this.pendingHistory.clear();
    this.pendingHistoryByChild.clear();
    this.historyCache.clear();
    this.historyCursors.clear();
    this.nativeMergedCursors.clear();
    this.nativeLegacyProjectListCursors.clear();
    this.historySections.clear();
    this.nativeSectionHomes.clear();
    this.nativeSectionsByAccount.clear();
    this.heldDesktopContinuations.clear();
    for (const pending of this.pendingDesktop.values()) clearTimeout(pending.timer);
    this.pendingDesktop.clear();
    for (const helper of this.enrollmentHelpers.values()) {
      if (helper.isolatedReconnect) { clearTimeout(helper.isolatedReconnect.timer); helper.isolatedReconnect.preimage.fill(0); await helper.child.terminateAndWait(); }
      else try { helper.child.terminate("shutdown"); } catch {}
    }
    await Promise.all([...this.activeAuthHelpers.values()].map((helper) => helper.terminateAndWait()));
    this.enrollmentHelpers.clear();
    if (this.appServer?.listening) {
      // `close()` waits for every accepted socket. Test and reconnect paths
      // may have just destroyed those sockets, so force the server's own
      // connection sets closed as well before awaiting its terminal callback.
      const server = this.appServer as Server & {
        closeAllConnections?: () => void;
        closeIdleConnections?: () => void;
      };
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise<void>((resolvePromise) => this.appServer!.close(() => resolvePromise()));
    }
    this.appServer = null;
    const ownedChildren = [...this.children.values()];
    for (const child of ownedChildren) child.terminate("shutdown");
    if (this.initialized) this.broker.close();
    await Promise.all(ownedChildren.map((child) => child.whenClosed()));
    await this.controlClose?.();
    await this.brokerClose?.();
    this.controlClose = null;
    this.brokerClose = null;
  }

  /** Exact-ID resolver used only by the authenticated owner-private socket. */
  mapNativeTargets(rendererRef: OpaqueRendererRef, request: NativeSharedHistoryMapRequestV1): NativeSharedHistoryMapResultV1 {
    if (!this.clients.has(rendererRef) || !isNativeTargetMapRequest(request)) return { version: 1, status: "unavailable" };
    const conversationId = this.canonicalHistory.conversationForPublicThreadId(request.conversationNativeId)
      ?? (() => {
        const account = this.store.snapshot().threadOwners[request.conversationNativeId];
        return account ? this.canonicalHistory.conversationForNative(account, request.conversationNativeId) : null;
      })();
    if (!conversationId) return { version: 1, status: "unavailable" };
    // The DOM composer identity is not merely shape-validated. It must be an
    // exact alias of the same canonical conversation (or the same stable
    // public handle) before it can be used as a preload zipper proof.
    const composerConversation = request.composerNativeId === request.conversationNativeId
      ? conversationId
      : this.canonicalHistory.conversationForPublicThreadId(request.composerNativeId)
        ?? (() => {
          const account = this.store.snapshot().threadOwners[request.composerNativeId];
          return account ? this.canonicalHistory.conversationForNative(account, request.composerNativeId) : null;
        })();
    if (composerConversation !== conversationId) return { version: 1, status: "unavailable" };
    const turns = this.canonicalHistory.publicTurnIdsForConversation(conversationId, request.assistantTurnNativeIds);
    if (!turns || turns.size !== request.assistantTurnNativeIds.length) return { version: 1, status: "unavailable" };
    return {
      version: 1,
      status: "mapped",
      conversationId: `conversation_${createHmac("sha256", this.secret).update(`renderer-conversation:v1:${conversationId}`, "utf8").digest("base64url")}`,
      turnIds: request.assistantTurnNativeIds.map((nativeTurnId) => `turn_${createHmac("sha256", this.secret).update(`renderer-turn:v1:${turns.get(nativeTurnId)!}`, "utf8").digest("base64url")}` as `turn_${string}`),
    };
  }

  /** Main-only selected-home context; no credential or account identity leaves the owner. */
  async resolveNativeBrowserContext(rendererRef: OpaqueRendererRef, opaqueAccountId: string): Promise<NativeBrowserContextV1> {
    if (!isOpaqueAccountId(opaqueAccountId) || !this.clients.has(rendererRef) || !this.broker.hasAuthenticatedRenderer(rendererRef)) {
      return { version: 1, status: "unavailable" };
    }
    const pool = this.broker.pool().accounts.find((account) => account.opaqueAccountId === opaqueAccountId);
    const binding = this.nativeAccountBinding(opaqueAccountId);
    if (!pool || !pool.enabled || pool.state === "disabled" || pool.state === "reauth_required" || pool.state === "unhealthy" || !binding) {
      return { version: 1, status: "unavailable" };
    }
    const child = this.broker.acquireChild(opaqueAccountId) as BrokerProcessChild | null;
    if (!child || !await this.initializeChild(child) || !isPlainRecord(child.initializeResult)
      || typeof child.initializeResult.userAgent !== "string") return { version: 1, status: "unavailable" };
    const version = /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(child.initializeResult.userAgent)?.[1];
    if (!version) return { version: 1, status: "unavailable" };
    return { version: 1, status: "ready", opaqueAccountId, codexHome: binding.codexHome,
      configFile: join(binding.codexHome, "config.toml"), appServerVersion: version };
  }

  async invokeNativeBrowserRequest(rendererRef: OpaqueRendererRef, opaqueAccountId: string, method: string,
    params: Record<string, unknown>): Promise<unknown | null> {
    const request = parseNativeBrowserChildRequestV1(method, params);
    if (!request || !isOpaqueAccountId(opaqueAccountId) || !this.clients.has(rendererRef)
      || !this.broker.hasAuthenticatedRenderer(rendererRef) || !this.nativeAccountBinding(opaqueAccountId)) return null;
    const pool = this.broker.pool().accounts.find((account) => account.opaqueAccountId === opaqueAccountId);
    if (!pool || !pool.enabled || pool.state === "disabled" || pool.state === "reauth_required" || pool.state === "unhealthy") return null;
    const child = this.broker.acquireChild(opaqueAccountId) as BrokerProcessChild | null;
    if (!child || !await this.initializeChild(child)) return null;
    const response = await this.requestBrokerChild(opaqueAccountId, child, request.method, request.params);
    return response && !response.error && isBoundedNativeResultV1(response.result, "plugins") ? response.result : null;
  }

  /**
   * A continuation payload is intentionally not recoverable.  Pending work
   * that never left memory is cancelled on restart; a persisted forwarding
   * receipt is terminally marked ambiguous, while the durable account owner
   * remains exactly as it was before the attempted move.
   */
  private reconcilePersistedHandoffs(): void {
    let ambiguous = 0;
    this.store.update((state) => {
      const handoffs = state.pendingHandoffs ?? {};
      state.pendingHandoffs = handoffs;
      for (const [handoffRef, handoff] of Object.entries(handoffs)) {
        if (handoff.state === "pending") {
          delete handoffs[handoffRef];
          continue;
        }
        if (handoff.state === "forwarding") handoff.state = "ambiguous";
        if (handoff.state === "ambiguous") ambiguous += 1;
      }
    });
    this.broker.setRecoveredAmbiguousHandoffCount(ambiguous);
  }

  private persistPendingHandoff(handoff: PendingHandoffV1): void {
    this.store.update((state) => {
      const handoffs = state.pendingHandoffs ?? (state.pendingHandoffs = {});
      if (Object.keys(handoffs).length >= 64) throw new Error("accounts broker handoff metadata capacity reached");
      if (handoffs[handoff.handoffRef]) throw new Error("duplicate accounts broker handoff receipt");
      handoffs[handoff.handoffRef] = persistentHandoff(handoff, "pending");
    });
  }

  /** A selection changes only the bounded pending receipt, before dispatch. */
  private persistRetargetedHandoff(handoff: PendingHandoffV1): void {
    this.store.update((state) => {
      const receipt = state.pendingHandoffs?.[handoff.handoffRef];
      if (!receipt || receipt.state !== "pending" || receipt.fromOpaqueAccountId !== handoff.fromOpaqueAccountId
        || receipt.conversationId !== handoff.conversationId) throw new Error("pending handoff receipt unavailable");
      receipt.toOpaqueAccountId = handoff.toOpaqueAccountId;
    });
  }

  private persistHandoffSettlement(handoff: PendingHandoffV1, state: BrokerHandoffSettlementV1): void {
    this.store.update((record) => {
      const handoffs = record.pendingHandoffs ?? (record.pendingHandoffs = {});
      if (state === "cancelled" || state === "rejected" || state === "expired" || state === "linked_continuation_required") {
        delete handoffs[handoff.handoffRef];
        return;
      }
      const existing = handoffs[handoff.handoffRef];
      if (existing) existing.state = "ambiguous";
      else handoffs[handoff.handoffRef] = persistentHandoff(handoff, "ambiguous");
    });
  }

  private settleHandoff(handoff: PendingHandoffV1, state: BrokerHandoffSettlementV1): void {
    this.persistHandoffSettlement(handoff, state);
    const held = this.heldDesktopContinuations.get(handoff.handoffRef);
    if (!held) return;
    this.heldDesktopContinuations.delete(handoff.handoffRef);
    if (held.automaticCapacityRefreshKey) this.automaticCapacityRefreshRequests.delete(held.automaticCapacityRefreshKey);
    if (held.forwardChildId) this.removePendingDesktop(held.forwardChildId);
    held.client.outstanding = Math.max(0, held.client.outstanding - 1);
    this.sendDesktop(held.client, redactedRouterError(
      held.desktopId,
      state === "ambiguous" ? "ambiguous_dispatch"
        : state === "linked_continuation_required" ? "linked_continuation_required"
          : state === "rejected" ? held.rejectionCode ?? "handoff_unavailable"
            : "provider_confirmation_required",
    ));
  }

  /**
   * The scheduler never owns mutable configuration.  Commit an exact local
   * label/enabled change first, then let the core update its in-memory mirror.
   * A failed durable write is therefore fail-closed and cannot become a
   * misleading renderer success response.
   */
  private persistAccountSettings(change: BrokerAccountSettingsChangeV1): boolean {
    const previousConfig = this.config;
    if (change.enabled === false && this.remoteBlocksDesktop(change.opaqueAccountId)) throw new BrokerCommandError("account_history_busy", true);
    const current = this.config.accounts.find((account) => account.opaqueAccountId === change.opaqueAccountId);
    if (!current || (change.label === undefined && change.enabled === undefined)) return false;
    const accounts = this.config.accounts.map((account) => account.opaqueAccountId === change.opaqueAccountId
      ? {
        ...account,
        ...(change.label !== undefined ? { label: change.label } : {}),
        ...(change.enabled !== undefined ? { included: change.enabled } : {}),
      }
      : account);
    const draft = {
      ...previousConfig,
      generation: previousConfig.generation + 1,
      accounts,
      updatedAt: new Date().toISOString(),
    } satisfies Omit<RouterConfigV3, "fingerprint">;
    const next: RouterConfigV3 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
    const existingState = this.store.snapshot();
    if (!validateRouterState(existingState, next)) return false;
    try {
      writePrivateJsonAtomic(this.stateRoot, ACCOUNT_ROUTER_CONFIG_FILE, next);
      this.config = next;
      this.store = new RouterStateStore(this.stateRoot, next);
      this.syncTokenBalanceAccounts();
      return true;
    } catch {
      this.config = previousConfig;
      try { writePrivateJsonAtomic(this.stateRoot, ACCOUNT_ROUTER_CONFIG_FILE, previousConfig); } catch {}
      return false;
    }
  }

  /**
   * `balance.set` is an explicit policy choice. It never turns a manually
   * routed broker into an automatic one unless the caller asked to enable
   * balancing, and it signs the same config generation as every other router
   * setting change.
   */
  private persistBalanceSetting(enabled: boolean): boolean {
    const previousConfig = this.config;
    if (!enabled && previousConfig.mode === "manual") return true;
    const draft = enabled
      ? {
        ...previousConfig,
        mode: "quota_aware" as const,
        policy: "quota_aware_v2" as const,
        generation: previousConfig.generation + 1,
        updatedAt: new Date().toISOString(),
      }
      : {
        ...previousConfig,
        policy: "quota_aware_v2" as const,
        generation: previousConfig.generation + 1,
        updatedAt: new Date().toISOString(),
      };
    const next: RouterConfigV3 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
    if (!validateRouterState(this.store.snapshot(), next)) return false;
    try {
      writePrivateJsonAtomic(this.stateRoot, ACCOUNT_ROUTER_CONFIG_FILE, next);
      this.config = next;
      this.store = new RouterStateStore(this.stateRoot, next);
      this.syncTokenBalanceAccounts();
      return true;
    } catch {
      this.config = previousConfig;
      try { writePrivateJsonAtomic(this.stateRoot, ACCOUNT_ROUTER_CONFIG_FILE, previousConfig); } catch {}
      return false;
    }
  }

  private isTokenBalancingEnabled(): boolean {
    return this.config.mode === "quota_aware" && this.config.policy === "balanced_tokens_v1";
  }

  private syncTokenBalanceAccounts(): void {
    this.tokenBalance.setAccounts(this.config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      included: account.included,
    })));
  }

  private balanceConfiguredAccounts(): OpaqueAccountId[] {
    return this.config.accounts.filter((account) => account.included).map((account) => account.opaqueAccountId);
  }

  /** Current automatic capacity, bounded by dynamic freshness rather than a cached status label. */
  private eligibleAutomaticAccounts(exclude: OpaqueAccountId | null = null): OpaqueAccountId[] {
    const quotas = new Map(this.broker.quota().map((quota) => [quota.opaqueAccountId, quota]));
    return this.broker.pool().accounts
      .filter((account) => account.opaqueAccountId !== exclude
        && account.enabled && account.state !== "disabled" && account.state !== "reauth_required" && account.state !== "unhealthy"
        && (this.isTokenBalancingEnabled()
          ? this.automaticAccountAuthenticated.get(account.opaqueAccountId) === true
          : this.automaticAccountAuthenticated.get(account.opaqueAccountId) !== false)
        && hasFreshPositiveQuota(quotas.get(account.opaqueAccountId)))
      .map((account) => account.opaqueAccountId);
  }

  /**
   * A stale peer must be refreshed before a new automatic decision. The
   * original desktop frame stays owner-private and is reconsidered exactly
   * once after single-flight account/read + rate-limit probes complete.
   */
  private deferForAutomaticCapacityRefresh(client: AppClient, request: JsonRpcRequest): boolean {
    if (this.config.mode !== "quota_aware" || (request.method !== "thread/start" && request.method !== "turn/start")) return false;
    const key = automaticCapacityRequestKey(client, request);
    if (this.automaticCapacityRefreshRequests.has(key)) {
      // This is a second external frame, never the owner's one internal
      // reconsideration. Keep the original hold and reject the duplicate so
      // one JSON-RPC id cannot produce two provider writes.
      this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation"));
      return true;
    }
    const quotas = new Map(this.broker.quota().map((quota) => [quota.opaqueAccountId, quota]));
    const refresh = this.broker.pool().accounts
      .filter((account) => account.enabled && account.state !== "disabled" && account.state !== "reauth_required" && account.state !== "unhealthy")
      .filter((account) => quotaNeedsRefresh(quotas.get(account.opaqueAccountId)))
      .map((account) => account.opaqueAccountId);
    if (refresh.length === 0) return false;
    this.automaticCapacityRefreshRequests.add(key);
    client.outstanding += 1;
    void Promise.allSettled(refresh.map((account) => this.refreshAutomaticCapacity(account))).finally(() => {
      client.outstanding = Math.max(0, client.outstanding - 1);
      if (this.closed || this.clients.get(client.rendererRef) !== client) {
        this.automaticCapacityRefreshRequests.delete(key);
        return;
      }
      this.receiveDesktop(client, request, key);
    });
    return true;
  }

  private refreshAutomaticCapacity(account: OpaqueAccountId): Promise<void> {
    const existing = this.automaticCapacityRefreshes.get(account);
    if (existing) return existing;
    const refresh = (async () => {
      try {
        const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
        if (!child) return;
        const [profile, quota] = await Promise.all([
          this.requestBrokerChild(account, child, "account/read", {}),
          this.requestBrokerChild(account, child, "account/rateLimits/read", {}),
        ]);
        this.automaticAccountAuthenticated.set(account, profile !== null && !profile.error ? providerAuthenticated(profile.result) : false);
        const projection = quota && !quota.error ? providerQuotaProjection(quota.result) : null;
        if (projection && this.automaticAccountAuthenticated.get(account) === true) this.broker.updateQuota({ opaqueAccountId: account, ...projection });
        else {
          const previous = this.broker.quota().find((quota) => quota.opaqueAccountId === account);
          if (previous) this.broker.updateQuota({ ...previous, freshness: "stale" });
        }
      } catch { /* failed probes leave capacity unavailable; no request is replayed */ }
    })().finally(() => this.automaticCapacityRefreshes.delete(account));
    this.automaticCapacityRefreshes.set(account, refresh);
    return refresh;
  }

  /** Renderer-safe read projection; no provider ids, requests, or contents enter it. */
  private readBalance(): BrokerBalanceProjectionV1 {
    const snapshot = this.tokenBalance.snapshot();
    const policy: BrokerBalanceProjectionV1["policy"] = this.config.mode === "manual"
      ? "manual"
      : this.config.policy === "balanced_tokens_v1" ? "balanced_tokens_v1" : "quota_aware_v2";
    const configured = this.balanceConfiguredAccounts();
    const eligible = policy === "balanced_tokens_v1" && configured.length === 2
      ? this.eligibleAutomaticAccounts()
      : [];
    const chosen = policy === "balanced_tokens_v1" && configured.length === 2
      ? this.tokenBalance.choose(eligible)
      : null;
    const precisionUnknown = snapshot.accounts.some((account) => account.included && account.precision !== "exact");
    const degradedReason: BrokerBalanceProjectionV1["degradedReason"] = policy !== "balanced_tokens_v1"
      ? null
      : configured.length !== 2 ? "requires_two_accounts"
        : eligible.length < 2 ? "account_unavailable"
          : precisionUnknown ? "usage_unknown"
            : null;
    return {
      policy,
      baselineAt: snapshot.baseline.startedAt,
      accounts: snapshot.accounts.map((account) => ({
        opaqueAccountId: account.opaqueAccountId,
        completedTokens: account.completedTokens,
        reservedTokens: account.reservedTokens,
        unreportedTokens: account.unreportedTokens,
        sharePercent: account.sharePercent,
        precision: account.precision,
      })),
      degradedReason,
      nextAccountId: chosen?.opaqueAccountId ?? null,
    };
  }

  /** Dispatch only proven account-local provider methods; unknown surfaces fail closed. */
  private async dispatchDeviceAction(action: BrokerDeviceActionV1): Promise<BrokerDeviceActionResultV1> {
    if (action.kind === "device.start") {
      if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return { outcome: "rejected" };
      const helper = action.opaqueAccountId === null
        ? this.createEnrollmentHelper(action.enrollmentRef)
        : this.reconnectHelper(action.enrollmentRef, action.opaqueAccountId);
      if (!helper) return { outcome: "rejected" };
      if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return { outcome: "rejected" };
      const response = await this.requestBrokerChild(helper.transportAccountId, helper.child, "account/login/start", { type: "chatgptDeviceCode" });
      if (!response || response.error || !isPlainRecord(response.result) || !isDeviceStartResult(response.result)) {
        if (helper.isolatedReconnect) this.retireEnrollmentHelper(action.enrollmentRef);
        return { outcome: "rejected" };
      }
      helper.loginId = response.result.loginId;
      return { outcome: "accepted", value: {
        loginId: response.result.loginId,
        verificationUrl: response.result.verificationUrl,
        userCode: response.result.userCode,
        expiresAt: null,
      } };
    }
    if (action.kind === "device.status") {
      const helper = this.enrollmentHelpers.get(action.enrollmentRef);
      if (!helper || helper.loginId !== action.loginId) return { outcome: "rejected" };
      return { outcome: "accepted", value: { success: helper.completion?.success === true } };
    }
    if (action.kind === "device.cancel") {
      const helper = this.enrollmentHelpers.get(action.enrollmentRef);
      if (!helper || helper.loginId !== action.loginId) return { outcome: "rejected" };
      if (helper.isolatedReconnect) {
        this.retireEnrollmentHelper(action.enrollmentRef);
        return { outcome: await helper.child.terminateAndWait() ? "accepted" : "ambiguous", value: {} };
      }
      if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return { outcome: "rejected" };
      const response = await this.requestBrokerChild(helper.transportAccountId, helper.child, "account/login/cancel", { loginId: action.loginId });
      if (!response || response.error) return { outcome: "ambiguous" };
      this.retireEnrollmentHelper(action.enrollmentRef);
      return { outcome: "accepted", value: {} };
    }
    if (action.kind === "native.request" && this.isolatedAuthHome(action.opaqueAccountId) && isolatedAuthMutation(action.method, action.params)) return { outcome: "rejected" };
    if (action.kind === "native.request" && action.surface === "plugins" && !await this.ensureNativePluginInventory()) return { outcome: "rejected" };
    const child = this.broker.acquireChild(action.opaqueAccountId) as BrokerProcessChild | null;
    if (!child) return { outcome: "rejected" };
    if (action.kind === "profile.email") {
      const response = await this.requestBrokerChild(action.opaqueAccountId, child, "account/read", {});
      const result = response && !response.error && isPlainRecord(response.result) ? response.result : null;
      const email = result && isPlainRecord(result.account) ? result.account.email : null;
      return typeof email === "string" ? { outcome: "accepted", value: email } : { outcome: "rejected" };
    }
    if (action.kind === "profile.read") {
      const response = await this.requestBrokerChild(action.opaqueAccountId, child, "account/read", {});
      const profile = response && !response.error ? providerSafeProfileProjection(response.result) : null;
      return profile ? { outcome: "accepted", value: profile } : { outcome: "rejected" };
    }
    if (action.kind === "quota.read") {
      const response = await this.requestBrokerChild(action.opaqueAccountId, child, "account/rateLimits/read", {});
      const quota = response && !response.error ? providerQuotaProjection(response.result) : null;
      return quota ? { outcome: "accepted", value: quota } : { outcome: "rejected" };
    }
    if (action.kind === "native.request") {
      if (this.remoteBlocksDesktop(action.opaqueAccountId)) throw new BrokerCommandError("account_history_busy", true);
      const scopedThreadId = isPlainRecord(action.params) && typeof action.params.threadId === "string" ? action.params.threadId : null;
      if (scopedThreadId && this.store.snapshot().threadOwners[scopedThreadId] !== action.opaqueAccountId) return { outcome: "rejected" };
      if ((action.method === "config/value/write" || action.method === "config/batchWrite") && isPlainRecord(action.params)
        && action.params.filePath !== null) {
        const binding = this.nativeAccountBinding(action.opaqueAccountId);
        const mode = this.sharedNativeMode();
        const activeConfig = mode?.state === "ready" ? join(mode.document.overlay.path, "config.toml") : binding ? join(binding.codexHome, "config.toml") : null;
        if (!binding || typeof action.params.filePath !== "string"
          || mode?.state === "blocked" || resolve(action.params.filePath) !== activeConfig) return { outcome: "rejected" };
      }
      try {
        let value: unknown;
        if (action.method === "http.request" && (action.surface === "apps" || action.surface === "plugins")) {
          // Shared definitions use the native plugin RPCs, which resolve the exact
          // marketplace and mutate the overlay. Legacy HTTP mutations change provider state.
          if (action.surface === "plugins" && this.sharedNativeMode()?.state === "ready"
            && isPlainRecord(action.params) && action.params.verb === "POST"
            && typeof action.params.path === "string" && /^\/ps\/plugins\/\{plugin_id\}\/(install|uninstall|enable|disable)$/.test(action.params.path)) return { outcome: "rejected" };
          const binding = this.nativeAccountBinding(action.opaqueAccountId);
          if (!binding) return { outcome: "rejected" };
          if (this.isolatedAuthHome(action.opaqueAccountId) && !await this.refreshIsolatedAuth(action.opaqueAccountId)) return { outcome: "rejected" };
          value = await requestNativeHttpV1(this.isolatedAuthHome(action.opaqueAccountId) ?? binding.codexHome, action.surface, action.params);
        } else if (action.method === "usage.credits.read" || action.method === "usage.credits.consume") {
          const binding = this.nativeAccountBinding(action.opaqueAccountId);
          if (!binding) return { outcome: "rejected" };
          if (this.isolatedAuthHome(action.opaqueAccountId) && !await this.refreshIsolatedAuth(action.opaqueAccountId)) return { outcome: "rejected" };
          value = await requestNativeUsageCreditsV1(this.isolatedAuthHome(action.opaqueAccountId) ?? binding.codexHome, action.method, action.params);
        } else {
          if (!await this.initializeChild(child)) return { outcome: "rejected" };
          const response = await this.requestBrokerChild(action.opaqueAccountId, child, action.method, action.params);
          if (!response || response.error) return { outcome: response ? "rejected" : "ambiguous" };
          value = response.result;
          await this.refreshSharedNativeRuntimes(action.method);
        }
        return isBoundedNativeResultV1(value, action.surface) ? { outcome: "accepted", value } : { outcome: "rejected" };
      } catch {
        return { outcome: "ambiguous" };
      }
    }
    if ((action.kind === "resetCredit.consume" || action.kind === "connection.authorize") && this.remoteBlocksDesktop(action.opaqueAccountId)) throw new BrokerCommandError("account_history_busy", true);
    if (action.kind === "resetCredit.consume") {
      if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return { outcome: "rejected" };
      const response = await this.requestBrokerChild(action.opaqueAccountId, child, "account/rateLimitResetCredit/consume", { idempotencyKey: action.idempotencyKey });
      return response && !response.error && isPlainRecord(response.result) && typeof response.result.outcome === "string"
        ? { outcome: "accepted", value: { outcome: response.result.outcome } }
        : { outcome: "rejected" };
    }
    if (action.kind === "connection.list" || action.kind === "connection.status") {
      const connections = await this.readProviderConnections(action.opaqueAccountId, action.connectionKind, child);
      if (connections === null) return { outcome: "rejected" };
      const filtered = action.kind === "connection.status"
        ? connections.filter((connection) => connection.definitionRef === action.definitionRef)
        : connections;
      return { outcome: "accepted", value: filtered };
    }
    if (action.kind === "connection.authorize") {
      if (action.connectionKind !== "mcp") return { outcome: "rejected" };
      const target = this.connectionTargets.get(providerConnectionKey(action.opaqueAccountId, action.connectionKind, action.definitionRef));
      if (!target) return { outcome: "rejected" };
      if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return { outcome: "rejected" };
      if (this.nativeHistory && !this.nativeAccountOperationSafe(action.opaqueAccountId, child)) {
        throw new BrokerCommandError("account_history_busy", true);
      }
      const response = await this.requestBrokerChild(action.opaqueAccountId, child, "mcpServer/oauth/login", { name: target.name });
      const oauthUrl = response && !response.error ? providerOAuthHandoffUrl(response.result) : null;
      // This is response-only to the initiating authenticated desktop. It is
      // never cached, emitted as a connection event, or persisted; completion
      // remains proven only by a later `mcpServerStatus/list` read.
      return oauthUrl ? { outcome: "accepted", value: { oauthUrl } } : { outcome: "rejected" };
    }
    return { outcome: "rejected" };
  }

  private createEnrollmentHelper(enrollmentRef: string): EnrollmentHelper | null {
    const existing = this.enrollmentHelpers.get(enrollmentRef);
    if (existing) return existing;
    const synthetic = `ar_${createHmac("sha256", this.secret).update(`enrollment-helper:${enrollmentRef}`, "utf8").digest("base64url")}` as OpaqueAccountId;
    const root = join(this.stateRoot, "enrollments", enrollmentRef);
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      // Create both isolated homes before the provider child starts. The
      // completed temporary root is renamed atomically into `accounts/`; no
      // credential file is copied and restart preflight sees the same layout
      // as a pre-existing account.
      mkdirSync(join(root, "codex-home"), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, "sqlite-home"), { recursive: true, mode: 0o700 });
      const codexHome = join(root, "codex-home");
      if (this.nativeHistory) writeFileSync(join(codexHome, "config.toml"), "", { flag: "wx", mode: 0o600 });
      else if (!materializeSharedSkillsIntoAccount(this.stateRoot, codexHome) || !materializeSharedPluginsIntoAccount(this.stateRoot, codexHome)) return null;
      const childArgs = this.nativeHistory ? this.args : sharedPluginChildArgs(this.stateRoot, this.args);
      if (!childArgs) return null;
      const childProcess = spawn(this.command, childArgs, {
        cwd: process.cwd(),
        env: brokerChildEnvironment(join(root, "codex-home"), join(root, "sqlite-home")),
        stdio: ["pipe", "pipe", "ignore"],
      });
      const helper: EnrollmentHelper = {
        enrollmentRef,
        child: undefined as unknown as BrokerProcessChild,
        transportAccountId: synthetic,
        root,
        opaqueAccountId: null,
        loginId: null,
        completion: null,
      };
      helper.child = new BrokerProcessChild(
        synthetic,
        childProcess,
        (message) => this.receiveChild(synthetic, helper.child, message),
        () => { if (this.enrollmentHelpers.get(enrollmentRef) === helper) this.enrollmentHelpers.delete(enrollmentRef); },
      );
      this.enrollmentHelpers.set(enrollmentRef, helper);
      return helper;
    } catch {
      return null;
    }
  }

  private reconnectHelper(enrollmentRef: string, opaqueAccountId: OpaqueAccountId): EnrollmentHelper | null {
    const existing = this.enrollmentHelpers.get(enrollmentRef);
    if (existing) return existing;
    const authHome = this.isolatedAuthHome(opaqueAccountId);
    if (authHome) {
      if ((this.authHelperQueued.get(opaqueAccountId) ?? 0) > 0 || this.activeAuthHelpers.has(opaqueAccountId) || [...this.enrollmentHelpers.values()].some((helper) => helper.opaqueAccountId === opaqueAccountId && helper.isolatedReconnect)) return null;
      const root = mkdtempSync(join(authHome, ".reconnect-")); chmodSync(root, 0o700);
      writeFileSync(join(root, "config.toml"), "", { flag: "wx", mode: 0o600 });
      const preimage = readNativeAuthPrivateFileV1(join(authHome, "auth.json"));
      const synthetic = `ar_${createHmac("sha256", this.secret).update(`reconnect-helper:${enrollmentRef}`).digest("base64url")}` as OpaqueAccountId;
      const child = new BrokerProcessChild(synthetic, spawn(this.command, credentialStoreArgs(this.args, "file"), {
        cwd: root, env: brokerChildEnvironment(root, root), stdio: ["pipe", "pipe", "ignore"],
      }), (message) => this.receiveChild(synthetic, child, message), () => {});
      const timer = setTimeout(() => this.retireEnrollmentHelper(enrollmentRef), 15 * 60_000); timer.unref();
      const helper: EnrollmentHelper = { enrollmentRef, child, transportAccountId: synthetic, root, opaqueAccountId, loginId: null, completion: null,
        isolatedReconnect: { authHome, preimage, timer } };
      this.enrollmentHelpers.set(enrollmentRef, helper); return helper;
    }
    const child = this.broker.acquireChild(opaqueAccountId) as BrokerProcessChild | null;
    if (!child) return null;
    const helper: EnrollmentHelper = { enrollmentRef, child, transportAccountId: opaqueAccountId, root: null, opaqueAccountId, loginId: null, completion: null };
    this.enrollmentHelpers.set(enrollmentRef, helper);
    return helper;
  }

  /** The native base's current credentials select the inventory actor, independently of history/routing ownership. */
  private nativeInventoryBinding() {
    try {
      const mode = this.sharedNativeMode();
      if (mode?.state !== "ready") return null;
      const raw = readOwnerPrivateAuthAccountId(mode.document.nativeBase.path);
      if (!raw) return null;
      const actor = `ar_${createHmac("sha256", this.secret).update(`account-router:v1:${raw}`).digest("base64url")}` as OpaqueAccountId;
      const matches = this.config.accounts.filter((account) => account.opaqueAccountId === actor && account.included);
      const entry = this.nativeAccountBinding(actor);
      if (matches.length !== 1 || !entry || entry.authIdentityHmac !== nativeHistoryAuthIdentityHmacV1(raw, this.secret)) return null;
      return { actor, mode, key: `${mode.fingerprint}:${actor}`, directory: join(mode.document.overlay.path, "plugins") };
    } catch { return null; }
  }

  /** Cache reuse requires both the exact actor provenance and complete native-consumer schema. */
  private cachedNativeInventory(binding: NonNullable<ReturnType<AccountsBrokerOwnerV1["nativeInventoryBinding"]>>): NativePluginInventory | null {
    try {
      const directory = lstatSync(binding.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) return null;
      const inventory = JSON.parse(readNativeAuthPrivateFileV1(join(binding.directory, NATIVE_INVENTORY_FILE), NATIVE_INVENTORY_MAX_BYTES).toString("utf8"));
      const provenance = JSON.parse(readNativeAuthPrivateFileV1(join(this.stateRoot, NATIVE_INVENTORY_PROVENANCE_FILE), 4096).toString("utf8"));
      if (!isNativePluginInventory(inventory, binding.mode.document.nativeBase.path) || !isPlainRecord(provenance)
        || Object.keys(provenance).sort().join() !== "actor,inventoryDigest,modeFingerprint,version"
        || provenance.version !== 1 || provenance.actor !== binding.actor || provenance.modeFingerprint !== binding.mode.fingerprint
        || provenance.inventoryDigest !== durableDigest(inventory)) return null;
      return inventory;
    } catch { return null; }
  }

  /** Raw bootstrap RPC deliberately bypasses consumer gating and never copies authentication. */
  private async ensureNativePluginInventory(force = false, reloadChanged = true): Promise<boolean> {
    const mode = this.sharedNativeMode();
    if (!mode || mode.state === "absent") return true;
    if (mode.state !== "ready" || this.closed) return false;
    const binding = this.nativeInventoryBinding();
    if (!binding) return false;
    const cached = this.cachedNativeInventory(binding);
    if (!force && cached && this.inventoryFreshKey === binding.key && Date.now() < this.inventoryFreshUntil) return true;
    const pending = this.inventoryRefresh;
    if (pending) {
      const ready = await pending.promise;
      return pending.key === binding.key ? ready : this.ensureNativePluginInventory(force, reloadChanged);
    }
    const work = (async () => {
      try {
        const child = this.broker.acquireChild(binding.actor) as BrokerProcessChild | null;
        if (!child || !await this.initializeChild(child)) throw new Error("native inventory actor unavailable");
        const response = await this.requestInitializedBrokerChild(binding.actor, child, "plugin/installed", { nativeBaseInventoryOnly: true });
        const inventory = response && !response.error ? nativePluginInventoryFromResponse(response.result, binding.mode.document.nativeBase.path) : null;
        if (this.closed || this.nativeInventoryBinding()?.key !== binding.key) return false;
        if (!inventory) return this.cachedNativeInventory(binding) !== null;
        const digest = durableDigest(inventory);
        const changed = !cached || durableDigest(cached) !== digest;
        if (changed) {
          // Native create_dir_all uses the process umask. Tighten this one
          // existing direct child of the sealed private overlay, never a link.
          if (!existsSync(binding.directory)) mkdirSync(binding.directory, { mode: 0o700 });
          const fd = openSync(binding.directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            const stat = fstatSync(fd);
            if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error("unsafe native inventory directory");
            fchmodSync(fd, 0o700);
            const current = lstatSync(binding.directory);
            if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("native inventory directory changed");
          } finally { closeSync(fd); }
          writePrivateJsonAtomicBounded(binding.directory, NATIVE_INVENTORY_FILE, inventory, NATIVE_INVENTORY_MAX_BYTES);
        }
        if (changed || !cached) writePrivateJsonAtomicBounded(this.stateRoot, NATIVE_INVENTORY_PROVENANCE_FILE,
          { version: 1, actor: binding.actor, modeFingerprint: binding.mode.fingerprint, inventoryDigest: digest }, 4096);
        if (changed && reloadChanged) await this.reloadSharedNativeChildren();
        return this.nativeInventoryBinding()?.key === binding.key && this.cachedNativeInventory(binding) !== null;
      } catch {
        return !this.closed && this.nativeInventoryBinding()?.key === binding.key && this.cachedNativeInventory(binding) !== null;
      } finally {
        this.inventoryFreshKey = binding.key;
        this.inventoryFreshUntil = Date.now() + OWNER_IDLE_SWEEP_MS;
      }
    })();
    this.inventoryRefresh = { key: binding.key, promise: work };
    try { return await work; }
    finally { if (this.inventoryRefresh?.promise === work) this.inventoryRefresh = null; }
  }

  private deferForNativePluginInventory(client: AppClient, request: JsonRpcRequest): boolean {
    if (!nativeInventoryConsumer(request.method) || this.inventoryCheckedRequests.has(request) || !this.nativeHistory) return false;
    const mode = this.sharedNativeMode();
    if (!mode || mode.state === "absent") return false;
    const key = automaticCapacityRequestKey(client, request);
    this.initializingDesktopRequests.add(key);
    client.outstanding += 1;
    void this.ensureNativePluginInventory().then((ready) => {
      this.initializingDesktopRequests.delete(key);
      client.outstanding = Math.max(0, client.outstanding - 1);
      if (this.closed || this.clients.get(client.rendererRef) !== client) return;
      if (!ready) { this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure")); return; }
      this.inventoryCheckedRequests.add(request);
      this.receiveDesktop(client, request);
    });
    return true;
  }

  private async reloadSharedNativeChildren(): Promise<void> {
    await Promise.all([...this.children].filter(([, child]) => child.ready).map(async ([account, child]) => {
      // Direct protocol-ready seam: reload must not recursively await its own inventory publication.
      await this.requestInitializedBrokerChild(account, child, "config/batchWrite", {
        edits: [], filePath: null, expectedVersion: null, reloadUserConfig: true,
      });
    }));
  }

  /** Reload resident account runtimes after an overlay mutation, without starting idle accounts. */
  private async refreshSharedNativeRuntimes(method: string): Promise<void> {
    if (!["config/value/write", "config/batchWrite", "plugin/install", "plugin/uninstall", "marketplace/add", "marketplace/remove", "marketplace/upgrade", "skills/config/write"].includes(method)
      || this.sharedNativeMode()?.state !== "ready") return;
    if (await this.ensureNativePluginInventory(true, false)) await this.reloadSharedNativeChildren();
  }

  private async requestBrokerChild(account: OpaqueAccountId, child: BrokerProcessChild, method: string, params: unknown, deadlineAt?: number): Promise<JsonRpcResponse | null> {
    if (nativeInventoryConsumer(method) && !await this.ensureNativePluginInventory()) return null;
    if (method === "account/read" && this.children.get(account) === child && this.isolatedAuthHome(account)) {
      return this.withAuthHelper(account, async (helper, home) => {
        const entry = this.nativeAccountBinding(account); if (!entry) return null;
        readNativeExternalTokensV1(home, entry, this.secret);
        const response = await helper.requestPrivate("account/read", { refreshToken: false });
        if (!response || response.error || !providerAuthenticated(response.result) || this.isolatedAuthHome(account) !== home) return null;
        readNativeExternalTokensV1(home, entry, this.secret); return response;
      });
    }
    if (!await this.initializeChild(child)) return null;
    return this.requestInitializedBrokerChild(account, child, method, params, deadlineAt);
  }

  /** Feature replay is itself part of readiness, so it uses this protocol-ready seam without recursively awaiting readiness. */
  private async requestInitializedBrokerChild(account: OpaqueAccountId, child: BrokerProcessChild, method: string, params: unknown, deadlineAt?: number): Promise<JsonRpcResponse | null> {
    if (!child.ready || this.closed || !this.nativeHistoryWritersSafe()) return null;
    const desktopWrite = (method.startsWith("project/") && nativeProjectWriteMethod(method)) || method === "account/rateLimitResetCredit/consume" || method === "mcpServer/oauth/login";
    if (desktopWrite && this.remoteBlocksDesktop(account)) return null;
    if (this.nativeHistory && method === "mcpServer/oauth/login" && !this.nativeAccountOperationSafe(account, child)) return null;
    const threadId = threadIdFrom(params);
    if (this.nativeHistory && threadId && !isReadOnlyNativeAccountMethod(method) && this.nativeThreadConflict(threadId) !== "clear") return null;
    const timeoutMs = Math.min(10_000, deadlineAt === undefined ? 10_000 : deadlineAt - Date.now());
    if (timeoutMs <= 0) return null;
    return new Promise((resolvePromise) => {
      const id = `abp:${++this.nonce}`;
      const timer = setTimeout(() => {
        const pending = this.pendingBrokerChild.get(id);
        if (!pending) return;
        this.pendingBrokerChild.delete(id);
        pending.resolve(null);
      }, timeoutMs);
      timer.unref();
      this.pendingBrokerChild.set(id, { account, resolve: resolvePromise, timer });
      try {
        child.send({ jsonrpc: "2.0", id, method, params });
      } catch {
        clearTimeout(timer);
        this.pendingBrokerChild.delete(id);
        resolvePromise(null);
      }
    });
  }

  /**
   * NativeProjectLinks has no direct child access.  Its reads and tiny
   * idempotent imports/updates pass through the same source fence as every
   * native turn, and the raw provider result never leaves this owner.
   */
  private async requestNativeProject(
    account: OpaqueAccountId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown | null> {
    if (!this.nativeHistory || !this.nativeAccountBinding(account) || !this.nativeHistoryWritersSafe()) return null;
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child) return null;
    if (nativeProjectWriteMethod(method) && (this.remoteBlocksDesktop(account) || !this.nativeHistoryWritersSafe())) return null;
    const response = await this.requestBrokerChild(account, child, method, params);
    return response && !response.error ? response.result : null;
  }

  /**
   * Read only the metadata account's complete native project id page before
   * consuming its bounded legacy assignment map.  No global-state content is
   * copied into broker history and no native write occurs here.
   */
  private refreshNativeLegacyProjects(): Promise<boolean> {
    if (this.nativeLegacyProjectsReady) return Promise.resolve(true);
    const active = this.nativeLegacyProjectRefresh;
    if (active) return active;
    const work = (async (): Promise<boolean> => {
      if (!this.nativeHistory || !this.nativeLegacyProjects || !this.nativeHistoryWritersSafe()) return false;
      const account = this.nativeHistory.source.metadataAccountId;
      const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
      if (!child || !this.nativeHistoryWritersSafe()) return false;
      const response = await this.requestBrokerChild(account, child, "project/list", { cursor: null, limit: 512 });
      if (!response || response.error || !isPlainRecord(response.result)
        || (response.result.nextCursor !== undefined && response.result.nextCursor !== null)
        || !Array.isArray(response.result.data)) return false;
      return this.refreshNativeLegacyProjectsFromResult(response.result);
    })().catch(() => false).finally(() => { this.nativeLegacyProjectRefresh = null; });
    this.nativeLegacyProjectRefresh = work;
    return work;
  }

  private async readProviderConnections(
    opaqueAccountId: OpaqueAccountId,
    kind: BrokerClientConnectionKind,
    child: BrokerProcessChild,
  ): Promise<Array<{ definitionRef: OpaqueConnectionDefinitionRef; displayLabel?: string; status: "unknown" | "connecting" | "connected" | "blocked" | "unavailable" }> | null> {
    let method = kind === "app" ? "app/installed" : kind === "plugin" ? "plugin/installed" : kind === "mcp" ? "mcpServerStatus/list" : null;
    if (!method) return [];
    const rows: Array<{ name: string; displayLabel?: string; status: "unknown" | "connecting" | "connected" | "blocked" | "unavailable" }> = [];
    const seenRows = new Set<string>();
    const seenCursors = new Set<string>();
    const deadlineAt = Date.now() + 12_000;
    let cursor: string | null = null;
    for (let page = 0; page < 32; page += 1) {
      const params = method === "app/installed" ? { forceRefresh: false } : kind === "app" ? { cursor, limit: 100 } : kind === "plugin" ? {} : { cursor, limit: 100, detail: "toolsAndAuthOnly" };
      let response: JsonRpcResponse | null = null;
      const attempts = kind === "plugin" ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        response = await this.requestBrokerChild(opaqueAccountId, child, method, params, deadlineAt);
        // Older native backends expose only catalog reads. Fall back solely
        // for an unsupported method, never for authentication/provider errors.
        if (response?.error?.code === -32601 && (method === "app/installed" || method === "plugin/installed")) {
          method = kind === "app" ? "app/list" : "plugin/list";
          response = await this.requestBrokerChild(opaqueAccountId, child, method, kind === "app" ? { cursor, limit: 100 } : {}, deadlineAt);
        }
        if (response && !response.error) break;
        if (attempt + 1 < attempts) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, PLUGIN_CONNECTION_RETRY_MS));
      }
      if (!response || response.error) return null;
      const entries = providerConnectionRows(response.result, kind);
      if (!entries || rows.length + entries.length > 2048) return null;
      for (const row of entries) {
        if (seenRows.has(row.name)) return null;
        seenRows.add(row.name); rows.push(row);
      }
      const next = isPlainRecord(response.result) ? response.result.nextCursor : undefined;
      if (kind === "plugin" || next === undefined || next === null) break;
      if (typeof next !== "string" || next.length === 0 || next.length > 4096 || seenCursors.has(next) || page === 31) return null;
      seenCursors.add(next); cursor = next;
    }
    const projected = rows.map((row) => {
      const definitionRef = `bd_${createHmac("sha256", this.secret).update(`provider-connection:${opaqueAccountId}:${kind}:${row.name}`, "utf8").digest("base64url")}` as OpaqueConnectionDefinitionRef;
      this.connectionTargets.set(providerConnectionKey(opaqueAccountId, kind, definitionRef), { opaqueAccountId, kind, name: row.name });
      return { definitionRef, ...(row.displayLabel ? { displayLabel: row.displayLabel } : {}), status: row.status };
    });
    return projected;
  }

  private async materializeEnrollment(enrollment: BrokerEnrollmentV1): Promise<BrokerMaterializedAccountV1 | null> {
    if (enrollment.kind !== "enrollment" || enrollment.opaqueAccountId !== null) return null;
    const helper = this.enrollmentHelpers.get(enrollment.enrollmentRef);
    if (!helper?.root || !helper.completion?.success) return null;
    const source = helper.root;
    // Admission uses the exact same strict, no-follow auth parser as startup
    // preflight. The provider id is held only in this stack frame long enough
    // to derive the canonical HMAC account home; it never enters a result,
    // event, state record, or log.
    const rawAccountId = readOwnerPrivateAuthAccountId(join(source, "codex-home"));
    if (!rawAccountId) return null;
    const opaqueAccountId = `ar_${createHmac("sha256", this.secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}` as OpaqueAccountId;
    if (this.config.accounts.some((account) => account.opaqueAccountId === opaqueAccountId)) return null;
    const target = join(this.stateRoot, "accounts", opaqueAccountId);
    if (existsSync(target)) return null;
    // Verify that the completion home can answer the two safe facts that are
    // required for an admitted account. Provider-shaped responses stay inside
    // this helper; only the later bounded quota projection is ever public.
    const profile = await this.requestBrokerChild(helper.transportAccountId, helper.child, "account/read", {});
    const quota = await this.requestBrokerChild(helper.transportAccountId, helper.child, "account/rateLimits/read", {});
    const safeProfile = profile && !profile.error ? providerSafeProfileProjection(profile.result) : null;
    if (!safeProfile || !quota || quota.error || !providerQuotaProjection(quota.result)) return null;
    helper.child.terminate("capacity");
    await helper.child.whenClosed();
    if (this.config.accounts.some((account) => account.opaqueAccountId === opaqueAccountId) || existsSync(target)) return null;
    const primary = this.config.accounts.find((account) => account.opaqueAccountId === this.config.primaryOpaqueAccountId);
    if (!primary) return null;
    const nextWithoutFingerprint = {
      ...this.config,
      generation: this.config.generation + 1,
      accounts: [...this.config.accounts, {
        opaqueAccountId,
        included: true,
        weight: 1,
        capabilityFingerprint: primary.capabilityFingerprint,
        label: `Account ${this.config.accounts.length + 1}`,
      }],
      updatedAt: new Date().toISOString(),
    } satisfies Omit<RouterConfigV3, "fingerprint">;
    const next: RouterConfigV3 = { ...nextWithoutFingerprint, fingerprint: routerConfigFingerprint(nextWithoutFingerprint) };
    // State expansion is permitted only while idle. Persist the precise
    // returned migration before adopting the new config so restart cannot
    // observe a config whose pool has no corresponding ledger entry.
    const priorState = this.store.snapshot();
    const migratedState = migrateIdleRouterStateV3(priorState, next);
    if (!migratedState) return null;
    const priorConfig = this.config;
    const journal: EnrollmentMaterializationJournalV1 = {
      version: 1,
      enrollmentRef: enrollment.enrollmentRef,
      opaqueAccountId,
      phase: "prepared",
      priorConfig,
      nextConfig: next,
      priorConfigDigest: durableDigest(priorConfig),
      nextConfigDigest: durableDigest(next),
      priorStateDigest: durableDigest(priorState),
      nextStateDigest: durableDigest(migratedState),
      ...(this.nativeHistory ? { nativeExtension: { source: this.nativeHistory.source, sourceDocumentFingerprint: this.nativeHistory.sourceDocumentFingerprint, prepared: null } } : {}),
    };
    try {
      // Publish a bounded, credential-free intent before the exclusive home
      // rename. Recovery can then deterministically finish the exact state /
      // config generation after a process death without copying any secrets.
      writeEnrollmentMaterializationJournal(this.stateRoot, journal);
      ensurePrivateDirectory(join(this.stateRoot, "accounts"));
      assertPrivateEnrollmentDirectory(source);
      if (existsSync(target)) throw new Error("enrollment target already exists");
      renameSync(source, target);
      journal.phase = "home_moved";
      writeEnrollmentMaterializationJournal(this.stateRoot, journal);
      this.injectEnrollmentMaterializationFault("after_home_move");
      prepareEnrollmentNativeExtension(this.stateRoot, journal, this.secret);
      writePrivateJsonAtomic(this.stateRoot, "router-state.json", migratedState);
      journal.phase = "state_published";
      writeEnrollmentMaterializationJournal(this.stateRoot, journal);
      this.injectEnrollmentMaterializationFault("after_state_publish");
      writePrivateJsonAtomic(this.stateRoot, ACCOUNT_ROUTER_CONFIG_FILE, next);
      journal.phase = "config_published";
      writeEnrollmentMaterializationJournal(this.stateRoot, journal);
      publishEnrollmentNativeExtension(this.stateRoot, journal, this.secret);
      this.store = new RouterStateStore(this.stateRoot, next);
      this.config = next;
      if (journal.nativeExtension) {
        const native = readAndPreflightNativeHistorySourceStaticV1(this.stateRoot, next, this.secret);
        if (native.state !== "ready") throw new Error("new native account union unavailable");
        this.nativeHistory = native.binding;
        if (this.nativeTransfer?.updateAccounts(native.binding.accounts.map((account) => ({ accountId: account.opaqueAccountId, codexHome: account.codexHome, sqliteHome: account.sqliteHome }))).state !== "ready") throw new Error("native account coordinator admission failed");
        this.nativeTransfer.provisionSharedWriterLocks();
      }
      this.syncTokenBalanceAccounts();
      this.injectEnrollmentMaterializationFault("after_config_publish");
      clearEnrollmentMaterializationJournal(this.stateRoot);
      helper.root = null;
      helper.opaqueAccountId = opaqueAccountId;
      helper.child.terminate("capacity");
      this.enrollmentHelpers.delete(enrollment.enrollmentRef);
      this.injectEnrollmentMaterializationFault("after_final_commit");
      return { opaqueAccountId, safeProfile };
    } catch (error) {
      // The journal is the source of truth after the first publication step.
      // Keep it intact for a fresh owner to reconcile; closing this core makes
      // the current owner fail closed instead of serving mixed generations.
      this.broker.close();
      if (!(error instanceof EnrollmentMaterializationFault)) {
        try { recoverEnrollmentMaterialization(this.stateRoot, priorConfig, this.secret); } catch { /* restart remains the recovery boundary */ }
      }
      return null;
    }
  }

  private injectEnrollmentMaterializationFault(point: EnrollmentMaterializationFaultPointV1): void {
    if (this.enrollmentMaterializationFaultAt === point) throw new EnrollmentMaterializationFault(point);
  }

  private retireEnrollmentHelper(enrollmentRef: string): void {
    const helper = this.enrollmentHelpers.get(enrollmentRef);
    if (!helper) return;
    this.enrollmentHelpers.delete(enrollmentRef);
    if (helper.isolatedReconnect) {
      clearTimeout(helper.isolatedReconnect.timer); helper.isolatedReconnect.preimage.fill(0);
      void helper.child.terminateAndWait(); return;
    }
    try { helper.child.terminate("capacity"); } catch {}
    if (!helper.root || !existsSync(helper.root)) return;
    // Preserve recoverability while removing the temporary login home from the
    // active enrollment namespace; no credential data is copied.
    const retiredRoot = join(this.stateRoot, "enrollment-retired");
    try {
      mkdirSync(retiredRoot, { recursive: true, mode: 0o700 });
      renameSync(helper.root, join(retiredRoot, `${enrollmentRef}.${Date.now()}`));
    } catch { /* a private orphan is safer than broad deletion */ }
  }

  private async startAppServerSocket(): Promise<void> {
    const path = accountsBrokerSocketPath(this.stateRoot, ACCOUNTS_BROKER_APP_SERVER_SOCKET_FILE);
    await removeStaleAppSocket(path);
    const server = createServer((socket) => {
      this.appConnections.add(socket);
      socket.once("close", () => this.appConnections.delete(socket));
      socket.setNoDelay(true);
      this.serveAppClient(socket);
    });
    try {
      await listen(server, path);
      chmodSync(path, 0o600);
      assertPrivateSocket(path);
      this.appServer = server;
    } catch (error) {
      for (const socket of this.appConnections) socket.destroy();
      if (server.listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await removeStaleAppSocket(path);
      throw error;
    }
  }

  private serveAppClient(socket: Socket): void {
    // A renderer reset is confined to its connection. Its close handler owns
    // lease cleanup, including ambiguous work that must never be replayed.
    socket.on("error", () => socket.destroy());
    let buffered = "";
    let byteLength = 0;
    let client: AppClient | null = null;
    const handshakeTimer = setTimeout(() => socket.destroy(), 5_000);
    handshakeTimer.unref();
    socket.once("close", () => {
      clearTimeout(handshakeTimer);
      if (client && this.clients.get(client.rendererRef) === client) this.disconnectAppClient(client);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      byteLength += Buffer.byteLength(chunk, "utf8");
      if (byteLength > ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES * 2) {
        socket.destroy();
        return;
      }
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        byteLength = Buffer.byteLength(buffered, "utf8");
        if (Buffer.byteLength(line, "utf8") > ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        let frame: unknown;
        try { frame = JSON.parse(line) as unknown; } catch { socket.destroy(); return; }
        if (!client) {
          if (!isAppHandshake(frame)) { socket.destroy(); return; }
          const result = this.broker.handshake(frame.handshake);
          if (!result.ok) {
            writeAppFrame(socket, { version: 1, kind: "handshake", ok: false }, ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES);
            socket.end();
            return;
          }
          clearTimeout(handshakeTimer);
          client = {
            rendererRef: frame.handshake.rendererRef,
            appToolsRef: frame.handshake.appToolsRef,
            clientKind: frame.handshake.clientKind,
            socket,
            outstanding: 0,
          };
          // A same-ref reconnect replaces the old app socket atomically. The
          // stale closure remains incapable of dispatching after this point.
          const prior = this.clients.get(client.rendererRef);
          if (prior && prior !== client) prior.socket.destroy();
          this.clients.set(client.rendererRef, client);
          if (!writeAppFrame(socket, { version: 1, kind: "handshake", ok: true }, ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES)) socket.destroy();
          continue;
        }
        if (!isAppMessage(frame)) { socket.destroy(); return; }
        this.receiveDesktop(client, frame.message);
      }
    });
  }

  private receiveDesktop(
    client: AppClient,
    message: JsonRpcMessage,
    resumedAutomaticCapacityKey: string | null = null,
    nativeProvenOwner: OpaqueAccountId | null = null,
  ): void {
    if (this.closed || this.clients.get(client.rendererRef) !== client) return;
    if (isResponse(message)) {
      this.resolveChildRequest(client, message);
      return;
    }
    if (isNotification(message)) {
      // Each child completes its own handshake exactly once.
      return;
    }
    if (!isRequest(message)) return;
    const request = message as JsonRpcRequest;
    if (request.method === "initialize") {
      if (!isPlainRecord(request.params) || !isPlainRecord(request.params.clientInfo)
        || typeof request.params.clientInfo.name !== "string" || typeof request.params.clientInfo.version !== "string"
        || Buffer.byteLength(JSON.stringify(request.params)) > 65_536) {
        this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation")); return;
      }
      const fingerprint = JSON.stringify(request.params);
      if (this.desktopInitialization && this.desktopInitialization.fingerprint !== fingerprint) {
        this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation")); return;
      }
      this.desktopInitialization = { params: JSON.parse(fingerprint), fingerprint, client };
      this.initializedDesktopClients.set(client, this.desktopInitialization.params);
      for (const existing of [...this.children.values(), ...[...this.enrollmentHelpers.values()].map((helper) => helper.child)]) {
        if (existing.ready && existing.initializationClient && this.clients.get(existing.initializationClient.rendererRef) !== existing.initializationClient) existing.initializationClient = client;
      }
      const child = this.broker.acquireChild(this.config.primaryOpaqueAccountId) as BrokerProcessChild | null;
      if (!child) { this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted")); return; }
      this.deferUntilChildReady(client, request, child, () => {
        this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: child.initializeResult });
        void this.warmEnabledChildren();
        void this.restoreNativeRemote().catch(() => { this.remoteRestoreStarted = false; });
      }, true);
      return;
    }
    if (this.initializingDesktopRequests.has(automaticCapacityRequestKey(client, request))) {
      this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation")); return;
    }
    if (client.outstanding >= CLIENT_MAX_OUTSTANDING) {
      this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    if (this.deferForNativePluginInventory(client, request)) return;
    if (request.method === "tweakers/desktopProjects/read") {
      this.readDesktopProjects(client, request);
      return;
    }
    if (request.method === "experimentalFeature/enablement/set") {
      this.broadcastFeatureEnablement(client, request);
      return;
    }
    if (this.deferForModelCatalog(client, request)) return;
    if (request.method === "account/rateLimits/read") {
      client.outstanding += 1;
      void Promise.allSettled(this.config.accounts.filter((account) => account.included).map((account) => this.refreshAutomaticCapacity(account.opaqueAccountId))).then(() => {
        if (!this.closed && this.clients.get(client.rendererRef) === client) this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: pooledNativeQuotaV1(this.broker.pool().accounts, this.broker.quota()) });
      }).finally(() => { client.outstanding = Math.max(0, client.outstanding - 1); });
      return;
    }
    if (this.nativeHistory && this.routeNativeProjectRequest(client, request)) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      return;
    }
    // Native thread ids are not router aliases. Before any existing task is
    // read, resumed, or otherwise mutated, prove its exact root against the
    // bound homes. This prevents an unknown id from inheriting config-primary
    // and makes a cross-home collision terminal rather than arbitrary.
    if (this.nativeHistory && !nativeProvenOwner) {
      const root = this.nativeRootThreadId(request);
      if (root) {
        const durableOwner = this.store.snapshot().threadOwners[root] ?? null;
        if (durableOwner) {
          if (!this.nativeHistoryWritersSafe()) {
            if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
            this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
            return;
          }
          nativeProvenOwner = durableOwner;
        } else if (isNativePointHistoryRead(request.method)) {
          const hintedOwner = this.nativeReadHint(root);
          if (hintedOwner) {
            this.routeTransientNativePointHistoryRead(client, request, root, hintedOwner);
            return;
          }
          this.proveNativeOwnerAndRetry(client, request, root, resumedAutomaticCapacityKey);
          return;
        } else {
          this.proveNativeOwnerAndRetry(client, request, root, resumedAutomaticCapacityKey);
          return;
        }
      }
    }
    if (this.routeHistoryRead(client, request, nativeProvenOwner)) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      return;
    }
    if (!resumedAutomaticCapacityKey && this.deferForAutomaticCapacityRefresh(client, request)) return;
    const requestedThreadId = threadIdFrom(request.params);
    const nativeRootThreadId = this.nativeHistory && requestedThreadId ? this.nativeRootThreadId(request) : null;
    const canonicalPublicConversation = requestedThreadId ? this.canonicalHistory.conversationForPublicThreadId(requestedThreadId) : null;
    const canonicalPublicRoute = canonicalPublicConversation ? this.canonicalHistory.activeNativeThread(canonicalPublicConversation) : null;
    const nativeProjectTranslation = this.nativeProjectStartTranslations.get(request) ?? null;
    const ownerAccount = nativeProjectTranslation?.account ?? nativeProvenOwner ?? canonicalPublicRoute?.opaqueAccountId ?? this.accountForRequest(request);
    if (!ownerAccount) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return;
    }
    const modelEligible = this.modelEligibleRequests.get(request);
    if (modelEligible && !modelEligible.has(ownerAccount)) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "capability_mismatch"));
      return;
    }
    if (this.nativeHistory && request.method === "thread/start" && !nativeProjectTranslation) {
      const project = nativeThreadStartProjectId(request.params);
      if (project.state === "invalid") {
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      if (project.state === "value") {
        this.ensureNativeProjectAndRetry(client, request, project.projectId, ownerAccount, resumedAutomaticCapacityKey);
        return;
      }
    }
    const logicalRoute = this.nativeHistory && nativeRootThreadId
      ? this.logicalRoute(ownerAccount, nativeRootThreadId)
      : canonicalPublicConversation && canonicalPublicRoute
        ? { conversationId: canonicalPublicConversation, ...canonicalPublicRoute }
        : requestedThreadId ? this.logicalRoute(ownerAccount, requestedThreadId) : null;
    let account = logicalRoute?.opaqueAccountId ?? ownerAccount;
    if (this.nativeHistory && request.method === "thread/section/move" && isPlainRecord(request.params)
      && typeof request.params.threadId === "string") {
      const section = this.nativeSectionHomes.get(request.params.threadId);
      if (!section || section.expiresAt <= Date.now()) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      account = section.account;
    }
    if (this.remoteBlocksDesktop(account) && !isReadOnlyNativeAccountMethod(request.method)) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "account_history_busy"));
      return;
    }
    const threadId = logicalRoute?.nativeThreadId ?? nativeRootThreadId ?? requestedThreadId;
    let routedRequest = threadId && threadId !== requestedThreadId ? withThreadId(request, threadId) : request;
    if (this.nativeHistory && request.method === "thread/section/move") {
      const translated = this.nativeSectionMoveRequest(routedRequest, account);
      if (!translated) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      routedRequest = translated;
    }
    if (this.nativeHistory && request.method === "thread/start") routedRequest = { ...routedRequest, params: { ...(isPlainRecord(routedRequest.params) ? routedRequest.params : {}), historyMode: "paginated" } };
    if (nativeProjectTranslation) {
      routedRequest = withProjectId(routedRequest, nativeProjectTranslation.projectId);
      this.nativeProjectStartTranslations.delete(request);
    }
    if (this.nativeHistory && threadId && !isReadOnlyNativeAccountMethod(request.method)) {
      const conflict = this.nativeThreadConflict(threadId);
      if (conflict !== "clear") {
        // Retry only source retirement at an idle boundary. This incoming
        // mutation is refused; recovery never retains or replays its payload.
        if (this.nativeTransfer?.hasPendingSourceRetirement(threadId)) void this.recoverNativeSourceRetirements().catch(() => {});
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, conflict === "conflict" ? "account_history_busy" : "post_start_failure"));
        return;
      }
    }
    const taskAccount = request.method === "thread/section/move" ? ownerAccount : account;
    const taskRef = threadId ? this.ensureTask(client, taskAccount, threadId) : null;
    const conversationId = logicalRoute?.conversationId ?? (taskRef ? this.conversationForTask(taskRef) : null);
    // A public logical thread can be rebound to another renderer only after
    // its lease is idle. Never fall through to a raw child request when that
    // bind fails: doing so would bypass the origin streaming/tool owner.
    if (threadId && !taskRef) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, conversationId && this.canonicalHistory.hasActiveTurn(conversationId) ? "conversation_busy" : "unknown_thread_owner"));
      return;
    }
    const unavailableContinuation = taskRef && isContinuationRequestMethod(request.method) && this.accountNeedsContinuationHandoff(account);
    // A native source can be larger than the portable handoff bound. Keep a
    // healthy existing task on its proven source rather than proposing a
    // balance-only move that may later have to refuse its full context.
    const balanceContinuation = false;
    if (taskRef && (unavailableContinuation || balanceContinuation)) {
      const target = this.selectContinuationTarget(account);
      // An automatic continuation may move only with current, positive quota
      // evidence. Reset credits are an explicit user-confirmed action, never
      // latent routing capacity; without an eligible target, retain neither a
      // pending handoff nor a provider write.
      if (!target) {
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
        return;
      }
      const handoff = this.broker.holdContinuation({
        fromRendererRef: client.rendererRef,
        taskRef,
        toOpaqueAccountId: target,
        continuation: routedRequest,
      });
      if (handoff) {
        // The original desktop request remains in memory only. It is written
        // exactly once by forwardContinuation after an authenticated UI
        // confirmation, or receives a redacted terminal failure on settle.
        this.heldDesktopContinuations.set(handoff.handoffRef, {
          client,
          desktopId: request.id,
          forwardChildId: null,
          automaticCapacityRefreshKey: resumedAutomaticCapacityKey,
        });
        // Keep the external key through confirmation settlement. A duplicate
        // frame with the same id must not fall through to a source write.
        client.outstanding += 1;
        if (request.method === "turn/start" && this.preferences.snapshot().failoverMode === "automatic"
          && hasConfirmedQuotaDepletion(this.broker.quota().find((quota) => quota.opaqueAccountId === account))
          && conversationId && !this.canonicalHistory.hasActiveTurn(conversationId)) {
          void this.broker.continueAutomatically(client.rendererRef, handoff.handoffRef);
        }
        return;
      }
    }
    if (this.isolatedAuthHome(account) && isolatedAuthMutation(request.method, request.params)) {
      this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure")); return;
    }
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    if (this.deferUntilChildReady(client, request, child, () => this.receiveDesktop(client, request, resumedAutomaticCapacityKey))) return;
    let logicalTurnId: OpaqueTurnId | null = null;
    let balanceReservation: TokenBalanceReservation | null = null;
    if (taskRef && request.method === "turn/start" && conversationId && threadId) {
      if (this.canonicalHistory.hasActiveTurn(conversationId)) {
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "conversation_busy"));
        return;
      }
      try {
        balanceReservation = this.reserveBalancedTurn(account, threadId, routedRequest.params);
        logicalTurnId = this.canonicalHistory.beginTurn(conversationId, account, threadId, client.rendererRef, this.clientLabel(client), routedRequest.params);
        this.canonicalHistory.markTurnDispatching(conversationId, account, threadId);
        this.publishConversation(conversationId);
      } catch {
        this.releasePreDispatchBalance(balanceReservation, threadId);
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
        return;
      }
    }
    if (taskRef && conversationId && request.method !== "turn/steer" && request.method !== "turn/start"
      && isContinuationRequestMethod(request.method) && this.canonicalHistory.hasActiveTurn(conversationId)) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "conversation_busy"));
      return;
    }
    if (taskRef && isContinuationRequestMethod(request.method)) {
      if (!this.broker.beginRun(taskRef)) {
        this.releasePreDispatchBalance(balanceReservation, threadId);
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
        return;
      }
    }
    const childId = `ab1:${++this.nonce}`;
    this.addPendingDesktop(childId, {
      client,
      desktopId: request.id,
      account,
      taskRef,
      method: request.method,
      conversationId,
      logicalTurnId,
      balanceReservationId: balanceReservation?.reservationId ?? null,
      ...(this.nativeHistory && request.method === "thread/section/move" && isPlainRecord(request.params)
        ? { nativeSectionMove: this.nativeSectionMoveMetadata(request.params) } : {}),
    });
    if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshByChild.set(childId, resumedAutomaticCapacityKey);
    client.outstanding += 1;
    let balanceDispatched = false;
    let dispatchAttempted = false;
    let preDispatchConflict: "clear" | "conflict" | "unknown" = "clear";
    try {
      // Recheck after every durable lease/reservation and immediately before
      // a native provider write. The census cannot lock a same-UID race, but
      // it never knowingly dispatches after one is observed.
      if (this.nativeHistory && threadId && !isReadOnlyNativeAccountMethod(request.method)) preDispatchConflict = this.nativeThreadConflict(threadId);
      if (this.nativeHistory && (isAccountScopedCapabilityMutationV1(request.method) || request.method === "mcpServer/oauth/login")) {
        if (!this.nativeAccountOperationSafe(account, child)) preDispatchConflict = "conflict";
      }
      if (!this.nativeHistoryWritersSafe() || preDispatchConflict !== "clear") throw new Error("native history writer conflict");
      if (balanceReservation) {
        this.tokenBalance.markDispatched(balanceReservation.reservationId);
        balanceDispatched = true;
      }
      dispatchAttempted = true;
      child.send({ ...routedRequest, id: childId });
    } catch {
      this.removePendingDesktop(childId);
      client.outstanding = Math.max(0, client.outstanding - 1);
      if (!balanceDispatched) this.releasePreDispatchBalance(balanceReservation, threadId);
      if (conversationId && threadId) {
        if (dispatchAttempted) this.canonicalHistory.markAmbiguous(conversationId, account, threadId);
        else this.canonicalHistory.markIncomplete(conversationId, account, threadId);
        this.publishConversation(conversationId);
      }
      if (taskRef && isContinuationRequestMethod(request.method)) this.broker.finishRun(taskRef);
      this.sendDesktop(client, redactedRouterError(request.id, preDispatchConflict === "conflict" ? "account_history_busy" : dispatchAttempted ? "ambiguous_dispatch" : "post_start_failure"));
    }
  }

  /** Main/preload-only aggregate read; account and source home come from the signed owner binding. */
  private readDesktopProjects(client: AppClient, request: JsonRpcRequest): void {
    if (!isPlainRecord(request.params) || Object.keys(request.params).length !== 0) {
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Desktop project read takes no parameters." } });
      return;
    }
    if (!this.nativeHistory || !this.nativeLegacyProjects || !nativeHistoryBindingSafeV1(this.nativeHistory)) {
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Desktop project projection is unavailable." } });
      return;
    }
    client.outstanding += 1;
    void (async () => {
      this.nativeLegacyProjectsReady = false;
      const binding = this.nativeHistory;
      const helper = this.nativeLegacyProjects;
      if (!binding || !helper || !nativeHistoryBindingSafeV1(binding)) return null;
      const account = binding.source.metadataAccountId;
      const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
      if (!child?.ready || !nativeHistoryBindingSafeV1(binding)) return null;
      const response = await this.requestBrokerChild(account, child, "project/list", { cursor: null, limit: 512 });
      if (this.closed || this.clients.get(client.rendererRef) !== client || this.nativeHistory !== binding
        || this.nativeLegacyProjects !== helper || this.children.get(account) !== child) return null;
      if (!response || response.error || !isPlainRecord(response.result)
        || (response.result.nextCursor !== undefined && response.result.nextCursor !== null)
        || !Array.isArray(response.result.data)) return null;
      const ids: string[] = [];
      for (const project of response.result.data) {
        if (!isPlainRecord(project) || !validNativeProjectId(project.id)) return null;
        ids.push(project.id);
      }
      if (new Set(ids).size !== ids.length || !nativeHistoryBindingSafeV1(binding)) return null;
      const result = helper.desktopProjection(response.result.data);
      this.nativeLegacyProjectsReady = result !== null;
      return result;
    })().then((result) => {
      if (!result) this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Desktop project projection is unavailable." } });
      else this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result });
    }).catch(() => {
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Desktop project projection is unavailable." } });
    }).finally(() => { client.outstanding = Math.max(0, client.outstanding - 1); });
  }

  /** Convert only a known logical alias back to its sealed native root. */
  private nativeRootThreadId(request: JsonRpcRequest): string | null {
    const requested = threadIdFrom(request.params);
    if (!requested) return null;
    const conversationId = this.canonicalHistory.conversationForPublicThreadId(requested);
    if (conversationId) return this.canonicalHistory.rootNativeThreadId(conversationId);
    const owner = this.store.snapshot().threadOwners[requested] ?? null;
    const nativeConversation = owner ? this.canonicalHistory.conversationForNative(owner, requested) : null;
    return nativeConversation ? this.canonicalHistory.rootNativeThreadId(nativeConversation) : requested;
  }

  /**
   * Serializes one exact native owner probe across concurrent desktop frames.
   * A probe only reads `thread/read includeTurns:false`; its result is never
   * retained as history content and is followed by a fresh writer census
   * before the owner mapping/lease shell becomes durable.
   */
  private proveNativeOwnerAndRetry(
    client: AppClient,
    request: JsonRpcRequest,
    rootThreadId: string,
    resumedAutomaticCapacityKey: string | null,
  ): void {
    client.outstanding += 1;
    void this.proveNativeOwner(rootThreadId).then((proof) => {
      if (this.closed || this.clients.get(client.rendererRef) !== client) return;
      if (proof.state === "transient" && isNativePointHistoryRead(request.method)) {
        this.routeTransientNativePointHistoryRead(client, request, rootThreadId, proof.opaqueAccountId);
        return;
      }
      if (proof.state !== "owned" || !this.nativeHistoryWritersSafe()
        || !this.bindHistoryOwnership(proof.opaqueAccountId, rootThreadId)) {
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      this.receiveDesktop(client, request, resumedAutomaticCapacityKey, proof.opaqueAccountId);
    }).catch(() => {
      if (this.closed || this.clients.get(client.rendererRef) !== client) return;
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
    }).finally(() => {
      client.outstanding = Math.max(0, client.outstanding - 1);
    });
  }

  private proveNativeOwner(rootThreadId: string): Promise<NativeOwnerProof> {
    const current = this.nativeOwnerProofs.get(rootThreadId);
    if (current) return current;
    const proof = this.probeNativeOwner(rootThreadId).finally(() => {
      if (this.nativeOwnerProofs.get(rootThreadId) === proof) this.nativeOwnerProofs.delete(rootThreadId);
    });
    this.nativeOwnerProofs.set(rootThreadId, proof);
    return proof;
  }

  private async probeNativeOwner(rootThreadId: string): Promise<NativeOwnerProof> {
    if (!this.nativeHistory || !this.nativeHistoryWritersSafe()) return { state: "unavailable" };
    const outcomes = await Promise.all(this.nativeHistory.accounts.map(async (source) => {
      let child: BrokerProcessChild | null = null;
      try { child = this.broker.acquireChild(source.opaqueAccountId) as BrokerProcessChild | null; } catch { return { account: source.opaqueAccountId, state: "unavailable" as const }; }
      if (!child) return { account: source.opaqueAccountId, state: "unavailable" as const };
      const response = await this.requestBrokerChild(source.opaqueAccountId, child, "thread/read", { threadId: rootThreadId, includeTurns: false });
      if (!response) return { account: source.opaqueAccountId, state: "unavailable" as const };
      if (response.error) return { account: source.opaqueAccountId, state: nativeThreadNotFound(response, rootThreadId) ? "absent" as const : "unavailable" as const };
      return { account: source.opaqueAccountId, state: nativeThreadReadMatches(response.result, rootThreadId) ? "matched" as const : "unavailable" as const };
    }));
    const matches = outcomes.filter((outcome) => outcome.state === "matched");
    if (matches.length > 1) {
      const owner = this.nativeTransfer?.ownerForThread(rootThreadId);
      return owner && matches.some((match) => match.account === owner)
        && matches.every((match) => this.nativeTransfer!.isCommittedProjection(rootThreadId, match.account))
        ? { state: "owned", opaqueAccountId: owner } : { state: "collision" };
    }
    if (outcomes.some((outcome) => outcome.state === "unavailable")) {
      return matches.length === 1
        ? { state: "transient", opaqueAccountId: matches[0]!.account }
        : { state: "unavailable" };
    }
    return matches.length === 1
      ? { state: "owned", opaqueAccountId: matches[0]!.account }
      : { state: "unknown" };
  }

  /** Idempotent authoritative app-server lease cleanup; stale close events are ignored. */
  private disconnectAppClient(client: AppClient): void {
    if (this.clients.get(client.rendererRef) !== client) return;
    this.clients.delete(client.rendererRef);
    this.initializedDesktopClients.delete(client);
    this.currentConversationByRenderer.delete(client.rendererRef);
    for (const [childId, pending] of [...this.pendingDesktop]) {
      if (pending.client !== client) continue;
      this.removePendingDesktop(childId);
      client.outstanding = Math.max(0, client.outstanding - 1);
      this.settleUncertainPending(pending);
    }
    for (const [desktopId, pending] of [...this.pendingChild]) {
      if (pending.client !== client) continue;
      this.pendingChild.delete(desktopId);
      // A pending app-tools approval means the related provider turn can no
      // longer be settled by this desktop. Its run is marked ambiguous via
      // the matching pending desktop request above when present.
      try { pending.child.send(redactedRouterError(pending.childRequestId, "post_start_failure")); } catch {}
    }
    this.broker.disconnectRenderer(client.rendererRef);
  }

  private settleUncertainPending(pending: PendingDesktopRequest): void {
    if (!pending.conversationId || !pending.taskRef) return;
    const nativeThreadId = this.threadByTaskRef.get(pending.taskRef);
    if (nativeThreadId) {
      try {
        this.canonicalHistory.markAmbiguous(pending.conversationId, pending.account, nativeThreadId);
        this.publishConversation(pending.conversationId);
      } catch { /* durable ambiguity is best effort during teardown */ }
    }
    // The child may later emit a terminal notification; finishRun is
    // idempotent, so release exactly once on the disconnect path.
    this.broker.finishRun(pending.taskRef);
  }

  /** Reserve a bounded estimated cost before a balanced provider write. */
  private reserveBalancedTurn(
    account: OpaqueAccountId,
    nativeThreadId: string,
    params: unknown,
  ): TokenBalanceReservation | null {
    if (!this.isTokenBalancingEnabled()) return null;
    if (this.balanceReservationByThread.has(nativeThreadId)) throw new Error("balanced turn already has a reservation");
    const knownBaseline = this.tokenUsageByThread.get(nativeThreadId);
    if (knownBaseline !== undefined) this.tokenBalance.seedThreadBaseline({
      opaqueAccountId: account,
      threadId: nativeThreadId,
      tokenUsage: knownBaseline,
    });
    const reservation = this.tokenBalance.begin({
      opaqueAccountId: account,
      estimatedTokens: estimatedTurnTokens(params),
    });
    this.tokenBalance.bind(reservation.reservationId, { threadId: nativeThreadId });
    this.balanceReservationByThread.set(nativeThreadId, reservation.reservationId);
    return reservation;
  }

  private releasePreDispatchBalance(reservation: TokenBalanceReservation | null, nativeThreadId: string | null): void {
    if (!reservation) return;
    try { this.tokenBalance.releasePreDispatch(reservation.reservationId); } catch { return; }
    if (nativeThreadId && this.balanceReservationByThread.get(nativeThreadId) === reservation.reservationId) {
      this.balanceReservationByThread.delete(nativeThreadId);
    }
  }

  /** A successful `thread/start` is the sole proof that this native thread had no prior usage. */
  private seedProvenNewThreadBalance(account: OpaqueAccountId, nativeThreadId: string): void {
    if (!this.isTokenBalancingEnabled()) return;
    try {
      this.tokenBalance.seedThreadBaseline({
        opaqueAccountId: account,
        threadId: nativeThreadId,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      });
      this.tokenUsageByThread.set(nativeThreadId, { inputTokens: 0, outputTokens: 0 });
    } catch { /* a balance receipt cannot disrupt a proven new thread */ }
  }

  private bindBalanceTurn(
    reservationId: string | null,
    nativeThreadId: string | null,
    nativeTurnId: string | null,
  ): void {
    if (!reservationId || !nativeThreadId) return;
    try {
      this.tokenBalance.bind(reservationId, {
        threadId: nativeThreadId,
        ...(nativeTurnId ? { turnId: nativeTurnId } : {}),
      });
    } catch { /* later terminal recovery preserves the unmodified reservation */ }
  }

  /** Observe cumulative totals only for a broker-originated reserved turn. */
  private observeBalancedTokenUsage(
    account: OpaqueAccountId,
    nativeThreadId: string,
    nativeTurnId: string | null,
    tokenUsage: unknown | null,
  ): void {
    const total = totalTokenUsage(tokenUsage);
    if (total !== null) {
      this.tokenUsageByThread.set(nativeThreadId, total);
      while (this.tokenUsageByThread.size > 256) this.tokenUsageByThread.delete(this.tokenUsageByThread.keys().next().value!);
    }
    // Turn identity wins over the active-thread shortcut. A late update for a
    // completed prior turn may arrive after the next turn reserved this same
    // native thread; accounting it to that new reservation would strand debt.
    const exactReservationId = nativeTurnId
      ? this.tokenBalance.reservationForThread({ opaqueAccountId: account, threadId: nativeThreadId, turnId: nativeTurnId })
      : null;
    const activeReservationId = this.balanceReservationByThread.get(nativeThreadId) ?? null;
    const settledReservationId = this.settledBalanceReservationFor(account, nativeThreadId, nativeTurnId);
    const reservationId = exactReservationId
      ?? (nativeTurnId ? settledReservationId : activeReservationId ?? settledReservationId)
      ?? (!nativeTurnId ? this.tokenBalance.reservationForThread({ opaqueAccountId: account, threadId: nativeThreadId }) : null);
    if (!reservationId) return;
    if (activeReservationId === reservationId) this.bindBalanceTurn(reservationId, nativeThreadId, nativeTurnId);
    try {
      const observed = this.tokenBalance.observe({
        opaqueAccountId: account,
        threadId: nativeThreadId,
        ...(nativeTurnId ? { turnId: nativeTurnId } : {}),
        reservationId,
        tokenUsage,
      });
      if (observed.reservationId && activeReservationId !== observed.reservationId) {
        this.rememberSettledBalanceReservation(account, nativeThreadId, observed.reservationId, nativeTurnId);
      }
    } catch { /* retain the durable reservation for terminal/restart recovery */ }
  }

  private settleBalancedTurn(
    account: OpaqueAccountId,
    nativeThreadId: string | null,
    nativeTurnId: string | null,
    tokenUsage: unknown | null,
  ): void {
    if (!nativeThreadId) return;
    const activeReservationId = this.balanceReservationByThread.get(nativeThreadId) ?? null;
    const knownReservationId = (nativeTurnId
      ? this.tokenBalance.reservationForThread({ opaqueAccountId: account, threadId: nativeThreadId, turnId: nativeTurnId })
      : null)
      ?? activeReservationId
      ?? this.settledBalanceReservationFor(account, nativeThreadId, nativeTurnId)
      ?? this.tokenBalance.reservationForThread({ opaqueAccountId: account, threadId: nativeThreadId });
    if (!knownReservationId) return;
    this.observeBalancedTokenUsage(account, nativeThreadId, nativeTurnId, tokenUsage);
    try {
      this.tokenBalance.settle(knownReservationId);
      if (this.balanceReservationByThread.get(nativeThreadId) === knownReservationId) this.balanceReservationByThread.delete(nativeThreadId);
      this.rememberSettledBalanceReservation(account, nativeThreadId, knownReservationId, nativeTurnId);
    } catch { /* an unsettled durable reservation is intentionally recovered as uncertain */ }
  }

  /** Retain only a bounded private correlation for late official cumulative totals. */
  private rememberSettledBalanceReservation(account: OpaqueAccountId, nativeThreadId: string, reservationId: string, turnId: string | null): void {
    const key = balanceThreadKey(account, nativeThreadId);
    const prior = this.settledBalanceReservationByThread.get(key) ?? [];
    const retained = [...prior.filter((entry) => entry.reservationId !== reservationId), { account, reservationId, turnId }].slice(-8);
    this.settledBalanceReservationByThread.set(key, retained);
    while (this.settledBalanceReservationByThread.size > 256) {
      const oldest = this.settledBalanceReservationByThread.keys().next().value;
      if (typeof oldest !== "string") break;
      this.settledBalanceReservationByThread.delete(oldest);
    }
  }

  private settledBalanceReservationFor(account: OpaqueAccountId, nativeThreadId: string, turnId: string | null): string | null {
    const entries = this.settledBalanceReservationByThread.get(balanceThreadKey(account, nativeThreadId)) ?? [];
    if (turnId) return entries.find((entry) => entry.turnId === turnId)?.reservationId ?? null;
    return entries.length === 1 ? entries[0]!.reservationId : null;
  }

  private addPendingDesktop(id: string, pending: Omit<PendingDesktopRequest, "timer" | "acknowledged">): void {
    const timer = setTimeout(() => this.expirePendingDesktop(id), PENDING_DESKTOP_TIMEOUT_MS);
    timer.unref();
    this.pendingDesktop.set(id, { ...pending, acknowledged: false, timer });
  }

  private removePendingDesktop(id: string): PendingDesktopRequest | null {
    const pending = this.pendingDesktop.get(id) ?? null;
    if (!pending) return null;
    this.pendingDesktop.delete(id);
    clearTimeout(pending.timer);
    const automaticKey = this.automaticCapacityRefreshByChild.get(id);
    this.automaticCapacityRefreshByChild.delete(id);
    if (automaticKey) this.automaticCapacityRefreshRequests.delete(automaticKey);
    return pending;
  }

  private expirePendingDesktop(id: string): void {
    const pending = this.removePendingDesktop(id);
    if (!pending) return;
    pending.client.outstanding = Math.max(0, pending.client.outstanding - 1);
    this.settleUncertainPending(pending);
    if (this.clients.get(pending.client.rendererRef) === pending.client) {
      this.sendDesktop(pending.client, redactedRouterError(pending.desktopId, "post_start_failure"));
    }
  }

  /**
   * A native companion makes the account homes the history authority while
   * retaining canonical state only for leases, ownership, and broker-era
   * metadata. Without that explicit companion, v3 keeps its empty canonical
   * store behavior exactly as before.
   */
  private routeHistoryRead(client: AppClient, request: JsonRpcRequest, nativeProvenOwner: OpaqueAccountId | null = null): boolean {
    if (!HISTORY_READ_METHODS.has(request.method)) return false;
    if (this.nativeHistory && this.routeNativePointHistoryRead(client, request, nativeProvenOwner)) return true;
    if (!this.nativeHistory && this.config.schemaVersion === 3) return this.routeCanonicalHistoryRead(client, request);
    // Native SQLite thread.project_id can be empty for older project members.
    // Refresh the bounded, signed source-side membership overlay before any
    // list is exposed, so a sidebar does not silently lose those tasks.
    if (this.nativeHistory && request.method === "thread/list" && !this.nativeLegacyProjectsReady) {
      client.outstanding += 1;
      void this.refreshNativeLegacyProjects().then((ready) => {
        client.outstanding = Math.max(0, client.outstanding - 1);
        if (this.closed || this.clients.get(client.rendererRef) !== client) return;
        if (!ready) {
          this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
          return;
        }
        this.routeHistoryRead(client, request, nativeProvenOwner);
      }).catch(() => {
        client.outstanding = Math.max(0, client.outstanding - 1);
        if (!this.closed && this.clients.get(client.rendererRef) === client) this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      });
      return true;
    }
    if (request.method === "thread/list" && isPlainRecord(request.params) && typeof request.params.sectionId === "string") {
      const binding = this.historySections.get(request.params.sectionId);
      if (!binding || binding.expiresAt <= Date.now()) {
        this.historySections.delete(request.params.sectionId);
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return true;
      }
    }
    const cursorInput = this.resolveHistoryCursorInput(request);
    if (!cursorInput) {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return true;
    }
    // Disabled and presently unavailable homes are not eligible contributors.
    // A list remains useful from the ready homes, while a zero-contributor
    // request stays fail-closed. This avoids waking disabled account children.
    const states = new Map(this.broker.pool().accounts.map((account) => [account.opaqueAccountId, account]));
    const eligibleAccounts = this.config.accounts
      .filter((account) => {
        const state = states.get(account.opaqueAccountId);
        if (!state) return false;
        return account.included && state.enabled
          && state.state !== "disabled" && state.state !== "reauth_required" && state.state !== "unhealthy";
      })
      .map((account) => account.opaqueAccountId);
    const accounts = cursorInput.providerCursors
      ? eligibleAccounts.filter((account) => cursorInput.providerCursors!.has(account))
      : eligibleAccounts;
    if (accounts.length === 0) {
      this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
      return true;
    }
    const key = `history:${client.rendererRef}:${++this.nonce}`;
    const timer = setTimeout(() => this.failHistoryFanout(key, "pool_depleted"), HISTORY_FANOUT_TIMEOUT_MS);
    timer.unref();
    const fanout: PendingHistoryFanout = {
      key,
      client,
      desktopId: request.id,
      request,
      accounts,
      nextAccount: 0,
      responses: [],
      // A native list may still be shown from a ready home, but an omitted
      // bound home cannot prove uniqueness. Keep that fact through merge so
      // rows only become transient read hints, never durable owners.
      partial: this.nativeHistory !== null && accounts.length !== this.nativeHistory.accounts.length,
      currentChildId: null,
      timer,
      providerCursors: cursorInput.providerCursors,
      queryFingerprint: cursorInput.queryFingerprint,
    };
    this.pendingHistory.set(key, fanout);
    client.outstanding += 1;
    this.dispatchNextHistoryFanout(fanout);
    return true;
  }

  /** Route exact native history reads to their proven source owner. */
  private routeNativePointHistoryRead(client: AppClient, request: JsonRpcRequest, nativeProvenOwner: OpaqueAccountId | null): boolean {
    if (!this.nativeHistory || !["thread/read", "thread/turns/list", "thread/items/list"].includes(request.method)) return false;
    const rootThreadId = this.nativeRootThreadId(request);
    if (!rootThreadId || !nativeProvenOwner || this.store.snapshot().threadOwners[rootThreadId] !== nativeProvenOwner
      || !this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return true;
    }
    const rootConversation = this.canonicalHistory.conversationForNative(nativeProvenOwner, rootThreadId);
    const segments = rootConversation ? this.canonicalHistory.orderedNativeSegments(rootConversation) : null;
    // A metadata-only root read is already complete at the root segment.  It
    // must not load every historical turn merely because the conversation was
    // continued on another account.
    if (rootConversation && segments && new Set(segments.map((segment) => segment.nativeThreadId)).size > 1 && !(request.method === "thread/read" && nativeThreadReadOmitsTurns(request.params))) {
      this.routeMergedNativePointHistoryRead(client, request, rootThreadId, rootConversation, segments);
      return true;
    }
    const taskRef = this.ensureTask(client, nativeProvenOwner, rootThreadId);
    const conversationId = taskRef ? this.conversationForTask(taskRef) : null;
    if (!taskRef) {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return true;
    }
    const child = this.broker.acquireChild(nativeProvenOwner) as BrokerProcessChild | null;
    if (!child || !this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
      return true;
    }
    if (this.deferUntilChildReady(client, request, child, () => this.receiveDesktop(client, request))) return true;
    const childId = `abh:${++this.nonce}`;
    this.addPendingDesktop(childId, {
      client,
      desktopId: request.id,
      account: nativeProvenOwner,
      taskRef,
      method: request.method,
      conversationId,
      logicalTurnId: null,
      balanceReservationId: null,
    });
    client.outstanding += 1;
    try { child.send({ ...withThreadId(request, rootThreadId), id: childId }); }
    catch {
      this.removePendingDesktop(childId);
      client.outstanding = Math.max(0, client.outstanding - 1);
      this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
    }
    return true;
  }

  /**
   * A partial fanout can still expose a read from its one responding home.
   * It deliberately has no task lease, owner binding, ledger change, or
   * canonical shell, so a later resume must prove all homes again.
   */
  private routeTransientNativePointHistoryRead(
    client: AppClient,
    request: JsonRpcRequest,
    rootThreadId: string,
    account: OpaqueAccountId,
  ): void {
    if (!this.nativeHistory || !this.nativeAccountBinding(account) || !this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return;
    }
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child || !this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
      return;
    }
    if (this.deferUntilChildReady(client, request, child, () => this.receiveDesktop(client, request))) return;
    const childId = `abh:${++this.nonce}`;
    this.addPendingDesktop(childId, {
      client,
      desktopId: request.id,
      account,
      taskRef: null,
      method: request.method,
      conversationId: null,
      logicalTurnId: null,
      balanceReservationId: null,
    });
    client.outstanding += 1;
    try { child.send({ ...withThreadId(request, rootThreadId), id: childId }); }
    catch {
      this.removePendingDesktop(childId);
      client.outstanding = Math.max(0, client.outstanding - 1);
      this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
    }
  }

  /** Merge immutable native segments for one logical root without persisting their turns. */
  private routeMergedNativePointHistoryRead(
    client: AppClient,
    request: JsonRpcRequest,
    rootThreadId: string,
    _conversationId: OpaqueConversationId,
    segments: readonly Readonly<{ opaqueAccountId: OpaqueAccountId; nativeThreadId: string }>[],
  ): void {
    if (!this.nativeHistory || !this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return;
    }
    client.outstanding += 1;
    const cursor = this.resolveNativeMergedCursorInput(request, rootThreadId);
    if (!cursor) {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      client.outstanding = Math.max(0, client.outstanding - 1);
      return;
    }
    void this.readNativeThreadSnapshots(segments).then((parts) => {
      if (this.closed || this.clients.get(client.rendererRef) !== client || !parts) {
        if (!this.closed && this.clients.get(client.rendererRef) === client) this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      const complete = parts;
      const page = combinedNativeHistoryResult(
        request.method,
        cursor.params,
        rootThreadId,
        complete.map((part) => ({
          ...part.snapshot,
          handoffContextMarker: this.nativeHandoffContextMarker(part.opaqueAccountId, part.nativeThreadId),
        })),
        cursor.offset,
        ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES - 4 * 1024,
      );
      if (!page) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      if (page.nextOffset !== null) page.result.nextCursor = this.createNativeMergedCursor(request.method, rootThreadId, cursor.queryFingerprint, page.nextOffset);
      const response = this.withNativeHistoryProjectIds(complete[0]!.opaqueAccountId, { jsonrpc: "2.0", id: request.id, result: page.result });
      // The per-page assembler reserves frame headroom, but this final check
      // includes an arbitrary JSON-RPC id and the outer app bridge envelope.
      // A read is refused only when that exact frame cannot be represented.
      if (!appDesktopMessageFits(response)) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      this.sendDesktop(client, response);
    }).catch(() => {
      if (!this.closed && this.clients.get(client.rendererRef) === client) this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
    }).finally(() => {
      client.outstanding = Math.max(0, client.outstanding - 1);
    });
  }

  private async readNativeThreadSnapshots(
    segments: readonly Readonly<{ opaqueAccountId: OpaqueAccountId; nativeThreadId: string }>[],
  ): Promise<Array<{ opaqueAccountId: OpaqueAccountId; nativeThreadId: string; snapshot: NativeThreadSnapshot }> | null> {
    if (!this.nativeHistory || segments.length < 1 || segments.length > 64 || !this.nativeHistoryWritersSafe()) return null;
    const parts = await Promise.all(segments.map(async (segment) => {
      // One complete census above protects this bounded read-only batch. Do
      // not spend a global lsof pass per immutable segment; provider writes
      // retain their immediate per-dispatch fence elsewhere.
      if (!this.nativeHistory || !this.nativeAccountBinding(segment.opaqueAccountId)) return null;
      const child = this.broker.acquireChild(segment.opaqueAccountId) as BrokerProcessChild | null;
      if (!child) return null;
      const response = await this.requestBrokerChild(segment.opaqueAccountId, child, "thread/read", { threadId: segment.nativeThreadId, includeTurns: true });
      if (!response || response.error) return null;
      const snapshot = nativeThreadSnapshot(response.result, segment.nativeThreadId);
      return snapshot ? { ...segment, snapshot } : null;
    }));
    return parts.some((part) => part === null)
      ? null
      : parts as Array<{ opaqueAccountId: OpaqueAccountId; nativeThreadId: string; snapshot: NativeThreadSnapshot }>;
  }

  /** Native projects have one explicit source authority, never config-primary. */
  private routeNativeProjectRequest(client: AppClient, request: JsonRpcRequest): boolean {
    if (!this.nativeHistory || !request.method.startsWith("project/")) return false;
    const account = this.nativeHistory.source.metadataAccountId;
    if (!this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
      return true;
    }
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child) {
      this.sendDesktop(client, redactedRouterError(request.id, "pool_depleted"));
      return true;
    }
    if (this.deferUntilChildReady(client, request, child, () => this.receiveDesktop(client, request))) return true;
    if (nativeProjectWriteMethod(request.method) && !this.nativeHistoryWritersSafe()) {
      this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
      return true;
    }
    const childId = `abp:${++this.nonce}`;
    this.addPendingDesktop(childId, {
      client,
      desktopId: request.id,
      account,
      taskRef: null,
      method: request.method,
      conversationId: null,
      logicalTurnId: null,
      balanceReservationId: null,
    });
    client.outstanding += 1;
    try { child.send({ ...request, id: childId }); }
    catch {
      this.removePendingDesktop(childId);
      client.outstanding = Math.max(0, client.outstanding - 1);
      this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
    }
    return true;
  }

  /** Lazily import only allowlisted project metadata before a cross-home start. */
  private ensureNativeProjectAndRetry(
    client: AppClient,
    request: JsonRpcRequest,
    sourceProjectId: string,
    targetAccount: OpaqueAccountId,
    resumedAutomaticCapacityKey: string | null,
  ): void {
    const projects = this.nativeProjects;
    if (!projects || !this.nativeHistoryWritersSafe()) {
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return;
    }
    client.outstanding += 1;
    void projects.ensureProjectForAccount(sourceProjectId, targetAccount).then((targetProjectId) => {
      if (this.closed || this.clients.get(client.rendererRef) !== client) return;
      if (!targetProjectId || !this.nativeHistoryWritersSafe()) {
        if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return;
      }
      this.nativeProjectStartTranslations.set(request, { account: targetAccount, projectId: targetProjectId });
      this.receiveDesktop(client, request, resumedAutomaticCapacityKey);
    }).catch(() => {
      if (this.closed || this.clients.get(client.rendererRef) !== client) return;
      if (resumedAutomaticCapacityKey) this.automaticCapacityRefreshRequests.delete(resumedAutomaticCapacityKey);
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
    }).finally(() => {
      client.outstanding = Math.max(0, client.outstanding - 1);
    });
  }

  /** Fetch every physical native segment only for one confirmed handoff. */
  private async nativeContinuationContext(
    sourceAccount: OpaqueAccountId,
    sourceThreadId: string,
    conversationId: OpaqueConversationId,
  ): Promise<{ text: string; digest: `sha256:${string}` } | null> {
    if (!this.nativeHistory || !this.nativeAccountBinding(sourceAccount) || !this.nativeHistoryWritersSafe()) return null;
    const segments = this.canonicalHistory.orderedNativeSegments(conversationId);
    if (!segments || !segments.some((segment) => segment.opaqueAccountId === sourceAccount && segment.nativeThreadId === sourceThreadId)) return null;
    const snapshots = await this.readNativeThreadSnapshots(segments);
    if (!snapshots) return null;
    const nativeIds = new Set<string>();
    const turns: NativeHistoryPortableTurnV1[] = [];
    let itemCount = 0;
    let inputBytes = 0;
    for (const part of snapshots) {
      const visibleTurns = part.snapshot.turns.map((turn) => nativeVisibleHistoryTurn(
        turn,
        this.nativeHandoffContextMarker(part.opaqueAccountId, part.nativeThreadId),
      ));
      const parsed = nativeHistoryThreadReadContextV1({ thread: { ...part.snapshot.thread, turns: visibleTurns } }, part.nativeThreadId);
      if (parsed.state !== "ready") return null;
      for (const id of parsed.nativeIds) {
        if (nativeIds.has(id)) return null;
        nativeIds.add(id);
      }
      for (const turn of parsed.turns) {
        itemCount += turn.items.length;
        inputBytes += Buffer.byteLength(JSON.stringify(turn), "utf8");
        // These are continuation-only bounds.  They deliberately do not
        // constrain ordinary native history display reads.
        if (itemCount > 256 || inputBytes > 96 * 1024) return null;
      }
      turns.push(...parsed.turns);
    }
    // `turns` remains stack-local through `render...` and is never stored in
    // canonical history. It already contains source then broker-era segments
    // in canonical order, with exact native identity deduplication.
    return renderNativeHistoryContextV1(turns);
  }

  /** Exact secret-derived marker identifies only broker-written handoff context. */
  private nativeHandoffContextMarker(account: OpaqueAccountId, nativeThreadId: string): string {
    return `account-router-handoff-context-v1:${createHmac("sha256", this.secret)
      .update(`native-handoff-context:v1\0${account}\0${nativeThreadId}`, "utf8")
      .digest("base64url")}`;
  }

  private routeCanonicalHistoryRead(client: AppClient, request: JsonRpcRequest): boolean {
    if (request.method === "thread/list") {
      const options = canonicalListOptions(request.params);
      if (!options) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return true;
      }
      // `thread/list` is a real app-server ThreadListResponse.  It contains
      // safe logical Thread rows (with no turns) rather than a private
      // account-list shaped summary which the desktop could not render.
      const data = canonicalListRows(this.canonicalHistory.logicalList(), options).flatMap((row) => {
        const conversation = this.canonicalHistory.logicalRead(row.publicThreadId);
        return conversation ? [canonicalThreadProjection(this.withCurrentAvailability(conversation), this.secret, false)] : [];
      });
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { data, nextCursor: null } });
      return true;
    }
    if (request.method === "thread/search") {
      const options = canonicalSearchOptions(request.params);
      if (!options) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return true;
      }
      const data = canonicalListRows(this.canonicalHistory.logicalList(), options).flatMap((row) => {
        const conversation = this.canonicalHistory.logicalRead(row.publicThreadId);
        return conversation ? [{
          snippet: canonicalThreadPreview(conversation),
          thread: canonicalThreadProjection(this.withCurrentAvailability(conversation), this.secret, false),
        }] : [];
      });
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { data, nextCursor: null } });
      return true;
    }
    if (request.method === "thread/loaded/list") {
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { data: this.canonicalHistory.logicalList().map((conversation) => conversation.publicThreadId), nextCursor: null } });
      return true;
    }
    if (request.method === "thread/turns/list") {
      const input = canonicalTurnsListParams(request.params);
      const conversation = input ? this.canonicalHistory.logicalRead(input.threadId) : null;
      if (!input || !conversation) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return true;
      }
      const turns = orderedLimited(conversation.turns, input.sortDirection, input.limit)
        .map((turn) => canonicalTurnProjection(turn, this.secret, input.itemsView));
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { data: turns, nextCursor: null } });
      return true;
    }
    if (request.method === "thread/items/list") {
      const input = canonicalItemsListParams(request.params);
      const conversation = input ? this.canonicalHistory.logicalRead(input.threadId) : null;
      if (!input || !conversation) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return true;
      }
      const selected = input.turnId === null
        ? conversation.turns
        : conversation.turns.filter((turn) => canonicalPublicTurnId(turn.turnId, this.secret) === input.turnId);
      if (input.turnId !== null && selected.length !== 1) {
        this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
        return true;
      }
      const data = orderedLimited(selected.flatMap((turn) => turn.items.map((item, index) => ({
        turnId: canonicalPublicTurnId(turn.turnId, this.secret),
        item: canonicalThreadItem(item, canonicalPublicItemId(turn.turnId, index, this.secret)),
      }))), input.sortDirection, input.limit);
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { data, nextCursor: null } });
      return true;
    }
    if (request.method === "threadSection/list") {
      this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { data: [], nextCursor: null } });
      return true;
    }
    if (request.method !== "thread/read" || !isPlainRecord(request.params) || Object.keys(request.params).some((key) => !["includeTurns", "threadId"].includes(key))
      || typeof request.params.threadId !== "string") {
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return true;
    }
    const conversation = this.canonicalHistory.logicalRead(request.params.threadId);
    if (!conversation) {
      this.currentConversationByRenderer.delete(client.rendererRef);
      this.sendDesktop(client, redactedRouterError(request.id, "unknown_thread_owner"));
      return true;
    }
    this.currentConversationByRenderer.set(client.rendererRef, conversation.conversationId);
    this.sendDesktop(client, { jsonrpc: "2.0", id: request.id, result: { thread: canonicalThreadProjection(this.withCurrentAvailability(conversation), this.secret, request.params.includeTurns === true) } });
    return true;
  }

  private dispatchNextHistoryFanout(fanout: PendingHistoryFanout): void {
    if (this.closed || this.pendingHistory.get(fanout.key) !== fanout) return;
    const account = fanout.accounts[fanout.nextAccount];
    if (!account) {
      this.completeHistoryFanout(fanout);
      return;
    }
    const cacheKey = historyCacheKey(fanout.request, account);
    const cached = cacheKey ? this.historyCache.get(cacheKey) : null;
    if (cached && cached.expiresAt > Date.now()) {
      fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-cache:${++this.nonce}`, result: structuredClone(cached.result) } });
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
      return;
    }
    if (cacheKey) this.historyCache.delete(cacheKey);
    let request = historyRequestForAccount(fanout.request, fanout.providerCursors?.get(account) ?? null);
    if (!request) {
      fanout.partial = true;
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
      return;
    }
    if (this.nativeHistory && request.method === "thread/list" && isPlainRecord(request.params)
      && typeof request.params.sectionId === "string") {
      const binding = this.historySections.get(request.params.sectionId);
      if (!binding || binding.expiresAt <= Date.now()) {
        this.failHistoryFanout(fanout.key, "post_start_failure");
        return;
      }
      request = { ...request, params: { ...request.params, sectionId: binding.localId } };
    }
    if (this.nativeHistory && request.method === "thread/list") {
      const project = nativeThreadListProjectId(request.params);
      if (project.state === "invalid") {
        this.failHistoryFanout(fanout.key, "post_start_failure");
        return;
      }
      if (project.state === "value") {
        if (account === this.nativeHistory.source.metadataAccountId) {
          this.dispatchNativeLegacyProjectRows(fanout, account, request, project.projectId);
          return;
        }
        const targetProjectId = this.nativeProjects?.projectForAccount(project.projectId, account) ?? null;
        if (!targetProjectId) {
          // A target account without a previously imported copy cannot own a
          // thread for this source project. Do not manufacture/import one for
          // a read; its empty native page is a truthful contributor.
          fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-empty:${++this.nonce}`, result: { data: [], nextCursor: null } } });
          fanout.nextAccount += 1;
          this.dispatchNextHistoryFanout(fanout);
          return;
        }
        request = withProjectId(request, targetProjectId);
      }
    }
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child) {
      // A pinned two-child pool or transient child failure must not make all
      // other account histories disappear. Complete with bounded partial data
      // when another contributor is available; a zero-response merge remains
      // an explicit redacted failure below.
      fanout.partial = true;
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
      return;
    }
    if (!child.ready || this.childFeatureRevision.get(child) !== this.featureRevision) {
      void this.initializeChild(child).then((ready) => {
        if (this.pendingHistory.get(fanout.key) !== fanout) return;
        if (!ready) { this.failHistoryFanout(fanout.key, "post_start_failure"); return; }
        this.dispatchNextHistoryFanout(fanout);
      }).catch(() => this.failHistoryFanout(fanout.key, "post_start_failure"));
      return;
    }
    const childId = `abh:${++this.nonce}`;
    fanout.currentChildId = childId;
    this.pendingHistoryByChild.set(childId, { fanout, account });
    try {
      child.send({ ...request, id: childId });
    } catch {
      this.pendingHistoryByChild.delete(childId);
      this.failHistoryFanout(fanout.key, "post_start_failure");
    }
  }

  /**
   * Source native SQLite lacks project_id for legacy members. Page those
   * signed assignments by exact read rather than pretending the native
   * project filter can find them. Once the legacy page is exhausted, continue
   * with ordinary non-null native project rows under the same public cursor.
   */
  private dispatchNativeLegacyProjectRows(
    fanout: PendingHistoryFanout,
    account: OpaqueAccountId,
    request: JsonRpcRequest,
    projectId: string,
  ): void {
    const helper = this.nativeLegacyProjects;
    const input = nativeLegacyProjectListInput(request.params, projectId);
    const ids = helper?.legacyNativeThreadIdsForProject(projectId) ?? null;
    const state = input ? this.resolveNativeLegacyProjectListCursor(input.cursor, projectId) : null;
    if (!this.nativeHistory || !helper || !this.nativeLegacyProjectsReady || !input || !ids || !state || !this.nativeHistoryWritersSafe()) {
      this.failHistoryFanout(fanout.key, "post_start_failure");
      return;
    }
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child) {
      fanout.partial = true;
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
      return;
    }
    if (state.legacyOffset < ids.length) {
      const selected = ids.slice(state.legacyOffset, Math.min(ids.length, state.legacyOffset + input.limit));
      void Promise.all(selected.map(async (threadId) => {
        const response = await this.requestBrokerChild(account, child, "thread/read", { threadId, includeTurns: false });
        return nativeLegacyThreadListRow(response?.error ? null : response?.result, threadId, projectId, (id) => this.nativeHistoryRowVisible(account, id));
      })).then((rows) => {
        if (this.pendingHistory.get(fanout.key) !== fanout) return;
        const accepted = rows.filter((row): row is Record<string, unknown> => row !== null);
        if (accepted.length !== selected.length) fanout.partial = true;
        const nextOffset = state.legacyOffset + selected.length;
        const nextCursor = nextOffset < ids.length
          ? this.createNativeLegacyProjectListCursor({ projectId, legacyOffset: nextOffset, nativeStarted: false, nativeCursor: null })
          : this.createNativeLegacyProjectListCursor({ projectId, legacyOffset: nextOffset, nativeStarted: false, nativeCursor: null });
        // The final exact legacy page still needs one synthetic page to query
        // native non-null project rows.  Its cursor is owner-private and will
        // disappear after that native page if the provider has no next page.
        fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-legacy:${++this.nonce}`, result: { data: accepted, nextCursor } } });
        fanout.nextAccount += 1;
        this.dispatchNextHistoryFanout(fanout);
      }).catch(() => {
        if (this.pendingHistory.get(fanout.key) !== fanout) return;
        fanout.partial = true;
        fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-legacy:${++this.nonce}`, result: { data: [], nextCursor: null } } });
        fanout.nextAccount += 1;
        this.dispatchNextHistoryFanout(fanout);
      });
      return;
    }
    if (state.nativeStarted && state.nativeCursor === null) {
      fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-legacy:${++this.nonce}`, result: { data: [], nextCursor: null } } });
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
      return;
    }
    const providerParams = { ...input.params, cursor: state.nativeStarted ? state.nativeCursor : null };
    void this.requestBrokerChild(account, child, "thread/list", providerParams).then((response) => {
      if (this.pendingHistory.get(fanout.key) !== fanout) return;
      if (!response || response.error || !isPlainRecord(response.result) || !Array.isArray(response.result.data)) {
        fanout.partial = true;
        fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-legacy:${++this.nonce}`, result: { data: [], nextCursor: null } } });
      } else {
        const rows = response.result.data.flatMap((entry) => nativeNonNullProjectListRow(entry, projectId, (id) => this.nativeHistoryRowVisible(account, id)) ? [entry] : []);
        const providerCursor = providerHistoryCursor(response.result);
        const nextCursor = providerCursor
          ? this.createNativeLegacyProjectListCursor({ projectId, legacyOffset: state.legacyOffset, nativeStarted: true, nativeCursor: providerCursor })
          : null;
        fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-legacy:${++this.nonce}`, result: { data: rows, nextCursor } } });
      }
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
    }).catch(() => {
      if (this.pendingHistory.get(fanout.key) !== fanout) return;
      fanout.partial = true;
      fanout.responses.push({ account, response: { jsonrpc: "2.0", id: `abh-legacy:${++this.nonce}`, result: { data: [], nextCursor: null } } });
      fanout.nextAccount += 1;
      this.dispatchNextHistoryFanout(fanout);
    });
  }

  private resolveHistoryFanout(account: OpaqueAccountId, response: JsonRpcResponse): boolean {
    if (typeof response.id !== "string") return false;
    const pending = this.pendingHistoryByChild.get(response.id);
    if (!pending || pending.account !== account) return false;
    this.pendingHistoryByChild.delete(response.id);
    const fanout = pending.fanout;
    if (this.pendingHistory.get(fanout.key) !== fanout) return true;
    if (response.error) fanout.partial = true;
    else {
      this.captureNativeSectionHomes(account, response.result);
      const publicResponse = this.nativeHistory ? this.withNativeHistoryProjectIds(account, response) : response;
      fanout.responses.push({ account, response: publicResponse });
      const cacheKey = historyCacheKey(fanout.request, account);
      if (cacheKey) this.cacheHistoryResponse(cacheKey, publicResponse.result);
    }
    fanout.currentChildId = null;
    fanout.nextAccount += 1;
    this.dispatchNextHistoryFanout(fanout);
    return true;
  }

  private completeHistoryFanout(fanout: PendingHistoryFanout): void {
    if (this.pendingHistory.get(fanout.key) !== fanout) return;
    this.pendingHistory.delete(fanout.key);
    clearTimeout(fanout.timer);
    fanout.client.outstanding = Math.max(0, fanout.client.outstanding - 1);
    // A partial list/search remains readable from its responding homes, but
    // it cannot create durable ownership. Other history surfaces retain the
    // strict failure because their shape cannot safely carry a partial view.
    const partialNativeRead = this.nativeHistory && fanout.partial && isPartialNativeHistoryRead(fanout.request.method);
    if (this.nativeHistory && fanout.partial && !partialNativeRead) {
      this.sendDesktop(fanout.client, redactedRouterError(fanout.desktopId, "unknown_thread_owner"));
      return;
    }
    const result = mergeHistoryResponses(
      fanout.request.method,
      fanout.responses,
      (threadId, account) => partialNativeRead ? this.bindNativeReadHint(account, threadId) : this.bindHistoryOwnership(account, threadId),
      (threadId) => this.store.snapshot().threadOwners[threadId] ?? null,
      (account, localId) => this.nativeHistory ? this.nativeHistorySectionId(account, localId) : this.historySectionId(account, localId),
      this.nativeHistory !== null,
      this.nativeHistory ? (account, threadId) => this.nativeHistoryRowVisible(account, threadId) : undefined,
    );
    if (result === null) {
      this.sendDesktop(fanout.client, redactedRouterError(fanout.desktopId, "unknown_thread_owner"));
      return;
    }
    if (fanout.request.method === "thread/list" && isPlainRecord(fanout.request.params)
      && typeof fanout.request.params.sectionId === "string" && fanout.request.params.sortKey === "section_position"
      && Array.isArray(result.data)) {
      const binding = this.historySections.get(fanout.request.params.sectionId);
      const order = binding ? this.store.snapshot().nativeSectionOrders?.[this.nativeSectionOrderKey(binding.localId)] ?? [] : [];
      const position = new Map(order.map((threadId, index) => [threadId, index]));
      result.data = result.data.map((row, index) => ({ row, index, position: isPlainRecord(row) && typeof row.id === "string" ? position.get(row.id) : undefined }))
        .sort((left, right) => left.position === undefined && right.position === undefined ? left.index - right.index
          : left.position === undefined ? 1 : right.position === undefined ? -1 : left.position - right.position)
        .map(({ row }) => row);
    }
    const nextCursors = new Map<OpaqueAccountId, string>();
    for (const { account, response } of fanout.responses) {
      const cursor = providerHistoryCursor(response.result);
      if (cursor) nextCursors.set(account, cursor);
    }
    if (nextCursors.size > 0) {
      result.nextCursor = this.createHistoryCursor(fanout.request.method, fanout.queryFingerprint, nextCursors);
    }
    this.sendDesktop(fanout.client, { jsonrpc: "2.0", id: fanout.desktopId, result });
  }

  private failHistoryFanout(key: string, code: "pool_depleted" | "post_start_failure"): void {
    const fanout = this.pendingHistory.get(key);
    if (!fanout) return;
    this.pendingHistory.delete(key);
    clearTimeout(fanout.timer);
    if (fanout.currentChildId) this.pendingHistoryByChild.delete(fanout.currentChildId);
    fanout.client.outstanding = Math.max(0, fanout.client.outstanding - 1);
    this.sendDesktop(fanout.client, redactedRouterError(fanout.desktopId, code));
  }

  private historySectionId(account: OpaqueAccountId, localId: string): string {
    const id = `section_${createHmac("sha256", this.secret).update(`history-section:v1:${account}:${localId}`, "utf8").digest("base64url")}`;
    this.historySections.set(id, { account, localId, expiresAt: Date.now() + HISTORY_SECTION_BINDING_TTL_MS });
    while (this.historySections.size > 512) this.historySections.delete(this.historySections.keys().next().value!);
    return id;
  }

  /** Native section ids remain stable; availability is retained for each contributing account. */
  private nativeHistorySectionId(account: OpaqueAccountId, localId: string): string | null {
    // Provider section ids are the stable cross-account identity. The merged
    // row remains public while moves validate the thread and target account.
    this.historySections.set(localId, { account, localId, expiresAt: Date.now() + HISTORY_SECTION_BINDING_TTL_MS });
    while (this.historySections.size > 512) this.historySections.delete(this.historySections.keys().next().value!);
    this.nativeSectionsByAccount.set(this.nativeSectionAvailabilityKey(account, localId), Date.now() + HISTORY_SECTION_BINDING_TTL_MS);
    while (this.nativeSectionsByAccount.size > 4_096) this.nativeSectionsByAccount.delete(this.nativeSectionsByAccount.keys().next().value!);
    return localId;
  }

  /** A canonical continuation segment is one logical native root, not a second task row. */
  private nativeHistoryRowVisible(account: OpaqueAccountId, nativeThreadId: string): boolean {
    const nativeOwner = this.nativeTransfer?.ownerForThread(nativeThreadId);
    if (nativeOwner && this.nativeTransfer!.isCommittedProjection(nativeThreadId, account) && nativeOwner !== account) return false;
    const conversationId = this.canonicalHistory.conversationForNative(account, nativeThreadId);
    if (!conversationId) return true;
    return this.canonicalHistory.rootNativeThreadId(conversationId) === nativeThreadId;
  }

  private bindNativeReadHint(account: OpaqueAccountId, threadId: string): boolean {
    const existing = this.nativeReadHints.get(threadId);
    if (existing && existing.expiresAt > Date.now() && existing.opaqueAccountId !== account) return false;
    this.nativeReadHints.set(threadId, { opaqueAccountId: account, expiresAt: Date.now() + NATIVE_READ_HINT_TTL_MS });
    while (this.nativeReadHints.size > NATIVE_READ_HINT_MAX_ENTRIES) this.nativeReadHints.delete(this.nativeReadHints.keys().next().value!);
    return true;
  }

  private nativeReadHint(threadId: string): OpaqueAccountId | null {
    const hint = this.nativeReadHints.get(threadId);
    if (!hint) return null;
    if (hint.expiresAt <= Date.now()) {
      this.nativeReadHints.delete(threadId);
      return null;
    }
    return hint.opaqueAccountId;
  }

  private cacheHistoryResponse(key: string, result: unknown): void {
    this.historyCache.set(key, { expiresAt: Date.now() + HISTORY_CACHE_TTL_MS, result: structuredClone(result) });
    while (this.historyCache.size > HISTORY_CACHE_MAX_ENTRIES) this.historyCache.delete(this.historyCache.keys().next().value!);
  }

  /** Convert a target-local project reference back to the source sidebar id. */
  private withNativePublicProjectIds(account: OpaqueAccountId, response: JsonRpcResponse): JsonRpcResponse {
    if (!this.nativeProjects || !isPlainRecord(response.result)) return response;
    const result = rewriteResponseProjectIds(response.result, (nativeProjectId) => this.nativeProjects?.publicProjectId(account, nativeProjectId) ?? null);
    return result === response.result ? response : { ...response, result };
  }

  /** Apply native compatibility-project links plus the signed legacy overlay. */
  private withNativeHistoryProjectIds(account: OpaqueAccountId, response: JsonRpcResponse): JsonRpcResponse {
    const linked = this.withNativePublicProjectIds(account, response);
    const legacy = this.nativeLegacyProjects;
    if (!this.nativeHistory || !legacy || !this.nativeLegacyProjectsReady || account !== this.nativeHistory.source.metadataAccountId || !isPlainRecord(linked.result)) return linked;
    const result = rewriteLegacyProjectEnvelope(linked.result, (threadId) => legacy.legacyPublicProjectIdForThread(threadId));
    return result === linked.result ? linked : { ...linked, result };
  }

  private refreshNativeLegacyProjectsFromResult(result: unknown): boolean {
    if (!this.nativeLegacyProjects || !isPlainRecord(result) || (result.nextCursor !== undefined && result.nextCursor !== null) || !Array.isArray(result.data)) return false;
    const ids: string[] = [];
    for (const project of result.data) {
      if (!isPlainRecord(project) || !validNativeProjectId(project.id)) return false;
      ids.push(project.id);
    }
    if (new Set(ids).size !== ids.length || !this.nativeHistoryWritersSafe()) return false;
    const ready = this.nativeLegacyProjects.refresh(ids);
    this.nativeLegacyProjectsReady = ready;
    return ready;
  }

  private withNativePublicProjectIdsNotification(account: OpaqueAccountId, notification: JsonRpcMessage): JsonRpcMessage {
    if (!this.nativeProjects || !isNotification(notification) || !isPlainRecord(notification.params)) return notification;
    const params = rewriteResponseProjectIds(notification.params, (nativeProjectId) => this.nativeProjects?.publicProjectId(account, nativeProjectId) ?? null);
    return params === notification.params ? notification : { ...notification, params };
  }

  /** Resolve only an owner-private map of provider cursors; request content is
   * represented by an HMAC fingerprint and is never retained with the cursor. */
  private resolveHistoryCursorInput(request: JsonRpcRequest): { providerCursors: ReadonlyMap<OpaqueAccountId, string> | null; queryFingerprint: string } | null {
    const base = historyBaseParams(request.params);
    if (!base) return null;
    const queryFingerprint = historyQueryFingerprint(this.secret, request.method, base.params);
    if (base.publicCursor === null) return { providerCursors: null, queryFingerprint };
    const state = this.historyCursors.get(base.publicCursor);
    if (!state || state.expiresAt <= Date.now()) {
      this.historyCursors.delete(base.publicCursor);
      return null;
    }
    if (state.method !== request.method || state.queryFingerprint !== queryFingerprint) return null;
    return { providerCursors: state.providerCursors, queryFingerprint };
  }

  private createHistoryCursor(method: string, queryFingerprint: string, providerCursors: ReadonlyMap<OpaqueAccountId, string>): string {
    const id = `hc_${createHmac("sha256", this.secret).update(`history-cursor:v1:${++this.nonce}:${Date.now()}:${method}:${queryFingerprint}`, "utf8").digest("base64url")}`;
    this.historyCursors.set(id, {
      expiresAt: Date.now() + HISTORY_CURSOR_TTL_MS,
      method,
      queryFingerprint,
      providerCursors: new Map(providerCursors),
    });
    while (this.historyCursors.size > HISTORY_CURSOR_MAX_ENTRIES) this.historyCursors.delete(this.historyCursors.keys().next().value!);
    return id;
  }

  /** Resolve a cursor that is meaningful only while this owner lives. */
  private resolveNativeMergedCursorInput(request: JsonRpcRequest, rootThreadId: string): { params: Record<string, unknown>; queryFingerprint: string; offset: number } | null {
    const base = nativeMergedBaseParams(request.params);
    if (!base) return null;
    const queryFingerprint = historyQueryFingerprint(this.secret, request.method, base.params);
    if (base.publicCursor === null) return { params: base.params, queryFingerprint, offset: 0 };
    const cursor = this.nativeMergedCursors.get(base.publicCursor);
    if (!cursor || cursor.expiresAt <= Date.now()) {
      this.nativeMergedCursors.delete(base.publicCursor);
      return null;
    }
    if (cursor.method !== request.method || cursor.rootThreadId !== rootThreadId || cursor.queryFingerprint !== queryFingerprint) return null;
    return { params: base.params, queryFingerprint, offset: cursor.offset };
  }

  private createNativeMergedCursor(method: string, rootThreadId: string, queryFingerprint: string, offset: number): string {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid native merged cursor offset");
    const id = `nmc_${createHmac("sha256", this.secret).update(`native-merged-cursor:v1:${++this.nonce}:${Date.now()}:${method}:${rootThreadId}:${queryFingerprint}:${offset}`, "utf8").digest("base64url")}`;
    this.nativeMergedCursors.set(id, {
      expiresAt: Date.now() + HISTORY_CURSOR_TTL_MS,
      method,
      rootThreadId,
      queryFingerprint,
      offset,
    });
    while (this.nativeMergedCursors.size > HISTORY_CURSOR_MAX_ENTRIES) this.nativeMergedCursors.delete(this.nativeMergedCursors.keys().next().value!);
    return id;
  }

  private resolveNativeLegacyProjectListCursor(cursor: string | null, projectId: string): NativeLegacyProjectListCursorState | null {
    if (cursor === null) return { expiresAt: Date.now() + HISTORY_CURSOR_TTL_MS, projectId, legacyOffset: 0, nativeStarted: false, nativeCursor: null };
    const state = this.nativeLegacyProjectListCursors.get(cursor);
    if (!state || state.expiresAt <= Date.now()) {
      this.nativeLegacyProjectListCursors.delete(cursor);
      return null;
    }
    if (state.projectId !== projectId) return null;
    return { ...state };
  }

  private createNativeLegacyProjectListCursor(state: Omit<NativeLegacyProjectListCursorState, "expiresAt">): string {
    if (!Number.isSafeInteger(state.legacyOffset) || state.legacyOffset < 0 || !validNativeProjectId(state.projectId)
      || (state.nativeCursor !== null && (state.nativeCursor.length < 1 || state.nativeCursor.length > 512 || /[\u0000-\u001f\u007f]/.test(state.nativeCursor)))) {
      throw new Error("invalid native legacy project cursor");
    }
    const id = `nlp_${createHmac("sha256", this.secret).update(`native-legacy-project-list:v1:${++this.nonce}:${Date.now()}:${state.projectId}:${state.legacyOffset}:${state.nativeStarted}:${state.nativeCursor ?? ""}`, "utf8").digest("base64url")}`;
    this.nativeLegacyProjectListCursors.set(id, { ...state, expiresAt: Date.now() + HISTORY_CURSOR_TTL_MS });
    while (this.nativeLegacyProjectListCursors.size > HISTORY_CURSOR_MAX_ENTRIES) this.nativeLegacyProjectListCursors.delete(this.nativeLegacyProjectListCursors.keys().next().value!);
    return id;
  }

  private accountForRequest(message: JsonRpcRequest): OpaqueAccountId | null {
    const threadId = threadIdFrom(message.params);
    if (threadId) return this.store.snapshot().threadOwners[threadId] ?? null;
    if (this.nativeHistory && OWNERLESS_NATIVE_THREAD_READ_METHODS.has(message.method)) return this.config.primaryOpaqueAccountId;
    // Native mode has no implicit source-owner fallback for task mutations.
    // A missing thread id is not authority to send an arbitrary request to
    // config-primary; only a fresh `thread/start` may enter the pool.
    if (this.nativeHistory && /^(?:thread\/|turn\/)/.test(message.method) && message.method !== "thread/start") return null;
    if (message.method === "thread/start") {
      // Manual keeps an exact primary route. Quota readings remain visible but
      // never become an implicit substitute selection.
      if (this.config.mode === "manual") return this.config.primaryOpaqueAccountId;
      if (this.isTokenBalancingEnabled()) {
        if (this.balanceConfiguredAccounts().length !== 2) return null;
        const modelEligible = this.modelEligibleRequests.get(message);
        const eligible = this.eligibleAutomaticAccounts().filter((account) => !modelEligible || modelEligible.has(account));
        const choice = this.tokenBalance.choose(eligible);
        if (!choice) return null;
        // A thread/start itself has no provider token charge, so it never
        // becomes a ledger reservation. While equal token projections leave a
        // tie, distribute concurrent unstarted threads across the pair. This
        // avoids binding every new logical conversation to config-primary
        // before either first turn can reserve actual estimated usage.
        const projected = this.tokenBalance.projectedTokens(choice.opaqueAccountId)?.projectedTokens;
        if (projected === null || projected === undefined) return choice.opaqueAccountId;
        const equal = eligible.filter((candidate) => this.tokenBalance.projectedTokens(candidate)?.projectedTokens === projected);
        if (equal.length < 2) return choice.opaqueAccountId;
        const pendingStarts = (candidate: OpaqueAccountId) => [...this.pendingDesktop.values()]
          .filter((pending) => pending.account === candidate && pending.method === "thread/start").length;
        equal.sort((left, right) => pendingStarts(left) - pendingStarts(right) || left.localeCompare(right));
        return equal[0] ?? choice.opaqueAccountId;
      }
      const pool = this.broker.pool();
      const quotas = new Map(this.broker.quota().map((quota) => [quota.opaqueAccountId, quota]));
      const candidates = pool.accounts.filter((account) => {
        const quota = quotas.get(account.opaqueAccountId);
        return (!this.modelEligibleRequests.get(message) || this.modelEligibleRequests.get(message)!.has(account.opaqueAccountId))
          && !this.remoteBlocksDesktop(account.opaqueAccountId) && account.enabled && account.state !== "reauth_required" && account.state !== "unhealthy" && account.state !== "disabled"
          && hasFreshPositiveQuota(quota);
      });
      candidates.sort((left, right) => compareNewWorkCapacity(
        quotas.get(left.opaqueAccountId), left.assignedTaskCount, left.opaqueAccountId,
        quotas.get(right.opaqueAccountId), right.assignedTaskCount, right.opaqueAccountId,
        this.config.accounts.findIndex((account) => account.opaqueAccountId === left.opaqueAccountId),
        this.config.accounts.findIndex((account) => account.opaqueAccountId === right.opaqueAccountId),
      ));
      return candidates[0]?.opaqueAccountId ?? null;
    }
    return this.config.primaryOpaqueAccountId;
  }

  private accountNeedsContinuationHandoff(account: OpaqueAccountId): boolean {
    const pool = this.broker.pool().accounts.find((candidate) => candidate.opaqueAccountId === account);
    const quota = this.broker.quota().find((candidate) => candidate.opaqueAccountId === account);
    return !pool || !pool.enabled || pool.state === "disabled" || pool.state === "reauth_required" || pool.state === "unhealthy"
      || !hasFreshPositiveQuota(quota);
  }

  private selectContinuationTarget(exclude: OpaqueAccountId): OpaqueAccountId | null {
    if (this.isTokenBalancingEnabled()) {
      const eligible = this.eligibleAutomaticAccounts(exclude);
      return this.tokenBalance.choose(eligible)?.opaqueAccountId ?? null;
    }
    const quotas = new Map(this.broker.quota().map((quota) => [quota.opaqueAccountId, quota]));
    const candidates = this.broker.pool().accounts.filter((account) => account.opaqueAccountId !== exclude
      && !this.remoteBlocksDesktop(account.opaqueAccountId) && account.enabled && account.state !== "disabled" && account.state !== "reauth_required" && account.state !== "unhealthy"
      && hasFreshPositiveQuota(quotas.get(account.opaqueAccountId)));
    candidates.sort((left, right) => compareNewWorkCapacity(
      quotas.get(left.opaqueAccountId), left.assignedTaskCount, left.opaqueAccountId,
      quotas.get(right.opaqueAccountId), right.assignedTaskCount, right.opaqueAccountId,
      this.config.accounts.findIndex((account) => account.opaqueAccountId === left.opaqueAccountId),
      this.config.accounts.findIndex((account) => account.opaqueAccountId === right.opaqueAccountId),
    ));
    return candidates[0]?.opaqueAccountId ?? null;
  }

  /**
   * Existing provider segments remain sticky. A move is only proposed for a
   * new `turn/start` after the prior turn committed, and only when the current
   * segment is materially ahead of its one available peer. Steering,
   * compaction, realtime, and a small difference never churn ownership.
   */
  private shouldProposeBalanceHandoff(
    account: OpaqueAccountId,
    request: JsonRpcRequest,
    conversationId: OpaqueConversationId | null,
  ): boolean {
    if (!this.isTokenBalancingEnabled() || request.method !== "turn/start" || !conversationId
      || this.canonicalHistory.hasActiveTurn(conversationId)) return false;
    const configured = this.balanceConfiguredAccounts();
    if (configured.length !== 2 || !configured.includes(account)) return false;
    const other = configured.find((candidate) => candidate !== account) ?? null;
    if (!other || !this.eligibleAutomaticAccounts(account).includes(other)) return false;
    const current = this.tokenBalance.accountSummary(account);
    const peer = this.tokenBalance.accountSummary(other);
    if (!current || !peer) return false;
    const currentProjected = current.estimatedTokens;
    const peerProjected = peer.estimatedTokens;
    const total = currentProjected + peerProjected;
    const currentShare = total > 0 ? currentProjected / total * 100 : 0;
    return currentProjected - peerProjected >= 8_192 && currentShare > 55;
  }

  /** Persist sticky ownership discovered during a merged read without making
   * the reading desktop the reverse app-tools owner of somebody else's task. */
  private bindHistoryOwnership(account: OpaqueAccountId, threadId: string): boolean {
    const current = this.store.snapshot().threadOwners[threadId];
    if (current) return current === account;
    try {
      this.store.update((state) => {
        if (state.threadOwners[threadId] && state.threadOwners[threadId] !== account) throw new Error("history owner collision");
        if (!state.threadOwners[threadId]) {
          state.threadOwners[threadId] = account;
          const ledger = state.ledger[account];
          if (!ledger) throw new Error("history ledger account unavailable");
          ledger.assignedThreadCount += 1;
        }
      });
      this.syncBrokerAssignedTaskCounts();
      return true;
    } catch {
      return false;
    }
  }

  private ensureTask(client: AppClient, account: OpaqueAccountId, threadId: string): OpaqueTaskRef | null {
    const current = this.store.snapshot().threadOwners[threadId];
    if (current && current !== account) return null;
    if (!current) {
      try {
        this.store.update((state) => {
          if (state.threadOwners[threadId] && state.threadOwners[threadId] !== account) throw new Error("thread owner collision");
          if (!state.threadOwners[threadId]) {
            state.threadOwners[threadId] = account;
            state.ledger[account].assignedThreadCount += 1;
          }
        });
      } catch {
        return null;
      }
    }
    this.syncBrokerAssignedTaskCounts();
    let conversationId = this.canonicalHistory.conversationForNative(account, threadId);
    if (!conversationId) {
      try {
        conversationId = this.canonicalHistory.createConversation({
          opaqueAccountId: account,
          nativeThreadId: threadId,
          ownerRendererRef: client.rendererRef,
          ownerLabel: this.clientLabel(client),
        });
        this.publishConversation(conversationId);
      } catch {
        return null;
      }
    }
    const taskRef = this.taskRef(threadId);
    const registered = this.broker.registerTask({
      taskRef,
      conversationId,
      opaqueAccountId: account,
      ownerRendererRef: client.rendererRef,
      privateThreadKey: threadId,
      alreadyAssigned: true,
    });
    if (registered) this.currentConversationByRenderer.set(client.rendererRef, conversationId);
    return registered ? taskRef : null;
  }

  /** Map a stable origin native thread to the currently active immutable segment. */
  private logicalRoute(account: OpaqueAccountId, requestedThreadId: string): { conversationId: OpaqueConversationId; opaqueAccountId: OpaqueAccountId; nativeThreadId: string } | null {
    const conversationId = this.canonicalHistory.conversationForNative(account, requestedThreadId);
    if (!conversationId) return null;
    const active = this.canonicalHistory.activeNativeThread(conversationId);
    return active ? { conversationId, ...active } : null;
  }

  /** Native wire ids stay provider-native while canonical aliases remain internal. */
  private nativeOutboundThreadId(conversationId: OpaqueConversationId): string | null {
    const root = this.canonicalHistory.rootNativeThreadId(conversationId);
    if (!root) return null;
    const owner = this.store.snapshot().threadOwners[root];
    return owner && this.canonicalHistory.conversationForNative(owner, root) === conversationId ? root : null;
  }

  private conversationForTask(taskRef: OpaqueTaskRef): OpaqueConversationId | null {
    return this.broker.taskOwnership(taskRef)?.conversationId ?? null;
  }

  private clientLabel(client: AppClient): string {
    return client.clientKind === "chatgpt" ? "ChatGPT" : "Tweakers";
  }

  private publishConversation(conversationId: OpaqueConversationId): void {
    const projection = this.projectConversation(conversationId);
    if (projection) this.broker.publishLogicalConversation(projection);
  }

  private publishCommittedTurn(conversationId: OpaqueConversationId, turnId: OpaqueTurnId): void {
    const projection = this.canonicalHistory.projectCommittedTurn(conversationId, turnId, (account) => this.broker.logicalSubscription(account));
    if (projection) this.broker.publishLogicalTurn(projection);
  }

  private readCurrentLogicalHistory(rendererRef: OpaqueRendererRef): BrokerHistoryReadProjectionV1 {
    const conversationId = this.currentConversationByRenderer.get(rendererRef);
    if (!conversationId) return { conversation: null, turns: [] };
    const projected = this.projectConversation(conversationId);
    if (!projected) return { conversation: null, turns: [] };
    const conversation = projected.peerBusy === (projected.activeClient !== null && projected.activeClient.clientId !== rendererRef)
      ? projected
      : { ...projected, peerBusy: projected.activeClient !== null && projected.activeClient.clientId !== rendererRef };
    const turns = this.canonicalHistory.portableTranscript(conversationId)?.flatMap((turn) => {
      const projection = this.canonicalHistory.projectCommittedTurn(conversationId, turn.turnId, (account) => this.broker.logicalSubscription(account));
      return projection ? [projection] : [];
    }) ?? [];
    return { conversation, turns };
  }

  /**
   * Sends peer app-server clients one canonical, completed turn snapshot after
   * a durable commit. It deliberately excludes streaming deltas, tool calls,
   * and provider/native identifiers; those remain origin-only.
   */
  private publishPeerCommittedTranscript(
    conversationId: OpaqueConversationId,
    turnId: OpaqueTurnId,
    originRendererRef: OpaqueRendererRef,
  ): void {
    const publicThreadId = this.canonicalHistory.publicThreadId(conversationId);
    const conversation = publicThreadId ? this.canonicalHistory.logicalRead(publicThreadId) : null;
    const turn = conversation?.turns.find((candidate) => candidate.turnId === turnId) ?? null;
    if (!conversation || !turn) return;
    const canonicalTurn = canonicalTurnProjection(turn, this.secret);
    for (const [rendererRef, boundConversationId] of this.currentConversationByRenderer) {
      if (rendererRef === originRendererRef || boundConversationId !== conversationId) continue;
      const peer = this.clients.get(rendererRef);
      if (!peer) continue;
      this.sendDesktop(peer, {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: conversation.publicThreadId, turn: canonicalTurn },
      });
    }
  }

  /**
   * Account availability is a runtime overlay, never a mutation of the
   * immutable committed transcript.  A healthy canonical record is still
   * readable while its owning account home is offline, but callers learn that
   * it cannot currently be resumed from that segment.
   */
  private projectConversation(conversationId: OpaqueConversationId): LogicalConversationProjectionV1 | null {
    const projection = this.canonicalHistory.project(conversationId, (account) => this.broker.logicalSubscription(account));
    if (!projection) return null;
    const activeClient = projection.activeClient
      && this.canonicalHistory.hasActiveTurn(conversationId)
      && this.broker.hasAuthenticatedRenderer(projection.activeClient.clientId)
      ? projection.activeClient
      : null;
    const currentProjection = activeClient === projection.activeClient && projection.peerBusy === (activeClient !== null)
      ? projection
      : { ...projection, activeClient, peerBusy: activeClient !== null };
    if (currentProjection.availability !== "complete") return currentProjection;
    const unavailable = currentProjection.segments.some((segment) => {
      const account = this.broker.pool().accounts.find((candidate) => candidate.opaqueAccountId === segment.subscription.accountId);
      return !account || !account.enabled || account.state === "disabled" || account.state === "reauth_required" || account.state === "unhealthy";
    });
    return unavailable ? { ...currentProjection, availability: "partial" } : currentProjection;
  }

  private withCurrentAvailability<T extends { conversationId: OpaqueConversationId; availability: string }>(conversation: T): T {
    const projection = this.projectConversation(conversation.conversationId);
    return projection && projection.availability !== conversation.availability
      ? { ...conversation, availability: projection.availability }
      : conversation;
  }

  private syncBrokerAssignedTaskCounts(): void {
    this.broker.syncAssignedTaskCounts(Object.fromEntries(Object.entries(this.store.snapshot().ledger)
      .map(([opaqueAccountId, entry]) => [opaqueAccountId, entry.assignedThreadCount])));
  }

  private taskRef(threadId: string): OpaqueTaskRef {
    const cached = this.taskRefsByThread.get(threadId);
    if (cached) return cached;
    const taskRef = `bt_${createHmac("sha256", this.secret).update(`broker-task:v1:${threadId}`, "utf8").digest("base64url")}` as OpaqueTaskRef;
    this.taskRefsByThread.set(threadId, taskRef);
    this.threadByTaskRef.set(taskRef, threadId);
    return taskRef;
  }

  /** The only PIDs allowed to retain bound native-home files are this owner and its children. */
  private nativeOwnedPids(): number[] {
    return [...this.children.values()].flatMap((child) => {
      const pid = child.pid;
      return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  }

  /** Binding drift blocks new dispatch; a foreign thread never terminates unrelated work. */
  private nativeAccountBinding(account: OpaqueAccountId) {
    return this.nativeHistory?.accounts.find((entry) => entry.opaqueAccountId === account) ?? null;
  }

  private nativeHistoryWritersSafe(): boolean {
    return !this.nativeHistory || nativeHistoryBindingSafeV1(this.nativeHistory);
  }

  private sharedNativeMode() {
    return this.nativeHistory
      ? readSharedNativeModeV1({ stateRoot: this.stateRoot, binding: this.nativeHistory, secret: this.secret })
      : null;
  }

  private nativeAccountOperationSafe(account: OpaqueAccountId, child: BrokerProcessChild): boolean {
    if (!this.nativeHistory) return true;
    if (this.children.get(account) !== child || typeof child.pid !== "number") return false;
    return observeNativeAccountOperationWritersV1(this.nativeHistory, account, child.pid).ok;
  }

  private nativeThreadConflict(threadId: string): "clear" | "conflict" | "unknown" {
    if (!this.nativeHistory) return "clear";
    if (this.nativeTransfer?.hasPendingSourceRetirement(threadId)) return "conflict";
    return observeNativeThreadWriterV1(this.nativeHistory, threadId, this.nativeOwnedPids()).state;
  }

  /** Synchronous account lease: no callback can interleave capture, preparation and spawn. */
  private prepareAccountContinuity(account: OpaqueAccountId, codexHome: string, captureOnly = false): boolean {
    const mode = this.sharedNativeMode();
    if (mode?.state === "blocked") return false;
    if (mode?.state === "ready") {
      if (this.nativeAccountBinding(account)?.codexHome !== codexHome) return false;
      this.nativeContinuityDeferred.delete(account);
      this.nativeContinuityReasons.delete(account);
      return true;
    }
    const sharedPath = join(this.stateRoot, "shared-account-config", "base.v1.json");
    if (!existsSync(sharedPath)) return true;
    try {
      let shared = loadSharedAccountBase(this.stateRoot);
      let plugins = loadSharedPluginsManifestV1(this.stateRoot);
      if (!shared || !plugins || this.children.has(account)) return false;
      const continuityAccount = { opaqueAccountId: account, codexHome };
      const sharedSourceAccount = this.nativeHistory?.source.metadataAccountId ?? this.config.primaryOpaqueAccountId;
      if (this.nativeHistory) {
        const source = this.nativeAccountBinding(account);
        const provenance = loadAccountContinuitySharedSourceProvenanceV1(this.stateRoot);
        if (!source || source.codexHome !== codexHome || !nativeHistoryBindingSafeV1(this.nativeHistory)
          || provenance.state !== "ready") return false;
        if (provenance.sharedSourceOpaqueAccountId !== sharedSourceAccount) {
          // A legacy generation is still usable in place. Only the bounded
          // idle migration may change its donor; do not publish native data
          // under the old generation's provenance or overwrite local edits.
          this.nativeContinuityDeferred.add(account);
          this.nativeContinuityReasons.set(account, "migration_pending");
          return !captureOnly;
        }
      }
      const writeEvidence = {
        accountChildAbsent: true,
        ...(this.nativeHistory ? { nativeWriterCensus: (): "zero" | "running" | "unknown" => {
          const observation = observeNativeAccountWritersV1(this.nativeHistory!, account, []);
          return observation.ok ? "zero" : observation.foreignPids.length ? "running" : "unknown";
        } } : {}),
      };
      const input = () => ({ stateRoot: this.stateRoot, account: continuityAccount, shared: shared!,
        schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, plugins: plugins!, writeEvidence });
      if (!captureOnly && ensureAccountContinuityEnrollment({ ...input(), apply: true }).state === "blocked") return false;
      let capturedUnmaterialized = false;
      if (this.nativeHistory) {
        const source = this.nativeAccountBinding(account);
        if (!source || source.codexHome !== codexHome) return false;
        const observed = observeExistingNativeAccountContinuity({ ...input(), apply: true,
          nativeHomeIdentity: source.codexHomeIdentity,
          nativeBindingPreflight: () => this.nativeHistory !== null && nativeHistoryBindingSafeV1(this.nativeHistory) });
        const writers = observeNativeAccountWritersV1(this.nativeHistory, account, []);
        if (!writers.ok) {
          // A known foreign native writer may continue with its existing
          // settings. This is explicitly deferred inheritance, never a false
          // materialization receipt or permission to recover/write its home.
          if (captureOnly || writers.foreignPids.length === 0 || observed.state === "blocked") return false;
          if (observed.state === "ready") {
            // A stable, already-effective home needs no inheritance write.
            // Another app being open is not itself a pending migration.
            this.nativeContinuityDeferred.delete(account);
            this.nativeContinuityReasons.delete(account);
            return true;
          }
          this.nativeContinuityDeferred.add(account);
          this.nativeContinuityReasons.set(account, "account_in_use");
          return true;
        }
        if (!existsSync(join(this.stateRoot, "accounts", account, "config-materialization.v1.json"))) {
          const captured = captureUnmaterializedNativeChangesBeforeSpawn({ ...input(), apply: true,
            nativeHomeIdentity: source.codexHomeIdentity,
            nativeBindingPreflight: () => this.nativeHistory !== null && nativeHistoryBindingSafeV1(this.nativeHistory) });
          if (captured.state === "blocked") return false;
          capturedUnmaterialized = true;
        }
      }
      const preview = captureOnly ? null : prepareAccountConfigBeforeSpawn(input());
      if (!capturedUnmaterialized && (captureOnly || preview?.state === "blocked" || account === sharedSourceAccount)) {
        const captured = captureIdleAccountChangesBeforeSpawn({ ...input(), primary: account === sharedSourceAccount, apply: true });
        if (captured.state === "blocked") return false;
        if (captured.proposedSharedConfig && captured.proposedSharedCapabilities) {
          const published = publishPrimarySharedBaseAfterExit({ stateRoot: this.stateRoot, prior: shared,
            proposedConfig: captured.proposedSharedConfig, proposedCapabilities: captured.proposedSharedCapabilities,
            schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
          if (published.state !== "published" || !published.shared) return false;
          shared = published.shared;
        }
      }
      if (!capturedUnmaterialized && account === sharedSourceAccount) {
        plugins = publishPrimaryPluginInventoryAfterExit({ stateRoot: this.stateRoot, account: continuityAccount, prior: plugins, writeEvidence });
        if (!plugins) return false;
      }
      if (captureOnly) return true;
      const prepared = prepareAccountConfigBeforeSpawn({ ...input(), apply: true }).state === "ready";
      if (prepared) {
        this.nativeContinuityDeferred.delete(account);
        this.nativeContinuityReasons.delete(account);
      }
      return prepared;
    } catch { return false; }
  }

  private async initializeChild(child: BrokerProcessChild): Promise<boolean> {
    if (this.closed) return false;
    if (child.ready && this.childFeatureRevision.get(child) === this.featureRevision) return true;
    const existingReplay = this.childFeatureReplay.get(child);
    if (existingReplay) return existingReplay;
    const replay = this.initializeAndReplayChild(child);
    this.childFeatureReplay.set(child, replay);
    try { return await replay; }
    finally { if (this.childFeatureReplay.get(child) === replay) this.childFeatureReplay.delete(child); }
  }

  private async initializeAndReplayChild(child: BrokerProcessChild): Promise<boolean> {
    if (this.closed) return false;
    for (const [client, params] of this.initializedDesktopClients) {
      if (this.clients.get(client.rendererRef) !== client) { this.initializedDesktopClients.delete(client); continue; }
      if (!child.ready && (!await child.initialize(params, client) || !child.ready || this.closed)) return false;
      const targetRevision = this.featureRevision;
      for (const featureParams of this.featureEnablements.values()) {
        const response = await this.requestInitializedBrokerChild(child.opaqueAccountId, child, "experimentalFeature/enablement/set", featureParams);
        if (!response || response.error) return false;
      }
      if (targetRevision !== this.featureRevision) return this.initializeAndReplayChild(child);
      this.childFeatureRevision.set(child, targetRevision);
      return true;
    }
    return false;
  }

  private nativeSectionMoveRequest(request: JsonRpcRequest, account: OpaqueAccountId): JsonRpcRequest | null {
    if (!isPlainRecord(request.params) || typeof request.params.threadId !== "string") return null;
    const params: Record<string, unknown> = { ...request.params };
    const home = this.nativeSectionHomes.get(request.params.threadId);
    if (!home || home.expiresAt <= Date.now() || home.account !== account) return null;
    if (typeof params.sectionId === "string") {
      if (!this.nativeSectionAvailable(account, params.sectionId)) return null;
    } else if (params.sectionId !== null) return null;
    if (typeof params.beforeThreadId === "string") {
      const beforeOwner = this.store.snapshot().threadOwners[params.beforeThreadId] ?? this.nativeReadHint(params.beforeThreadId);
      if (beforeOwner !== account) {
        const localSection = typeof params.sectionId === "string" ? params.sectionId : null;
        const order = localSection ? this.store.snapshot().nativeSectionOrders?.[this.nativeSectionOrderKey(localSection)] ?? [] : [];
        const start = order.indexOf(params.beforeThreadId);
        params.beforeThreadId = start < 0 ? null : order.slice(start + 1).find((threadId) =>
          (this.store.snapshot().threadOwners[threadId] ?? this.nativeReadHint(threadId)) === account) ?? null;
      }
    } else if (params.beforeThreadId !== undefined && params.beforeThreadId !== null) return null;
    return { ...request, params };
  }

  private captureNativeSectionHomes(account: OpaqueAccountId, result: unknown): void {
    if (!this.nativeHistory || !isPlainRecord(result) || !Array.isArray(result.data)) return;
    for (const row of result.data) {
      const thread = isPlainRecord(row) && isPlainRecord(row.thread) ? row.thread : row;
      if (!isPlainRecord(thread) || typeof thread.id !== "string") continue;
      const currentLocalId = isPlainRecord(thread.section) && typeof thread.section.id === "string" ? thread.section.id : null;
      this.nativeSectionHomes.set(thread.id, { account, currentLocalId, expiresAt: Date.now() + HISTORY_SECTION_BINDING_TTL_MS });
      while (this.nativeSectionHomes.size > 10_000) this.nativeSectionHomes.delete(this.nativeSectionHomes.keys().next().value!);
    }
  }

  private nativeSectionAvailabilityKey(account: OpaqueAccountId, localId: string): string {
    return `${account}\0${localId}`;
  }

  private nativeSectionAvailable(account: OpaqueAccountId, localId: string): boolean {
    const key = this.nativeSectionAvailabilityKey(account, localId);
    const expiresAt = this.nativeSectionsByAccount.get(key);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      this.nativeSectionsByAccount.delete(key);
      return false;
    }
    return true;
  }

  private nativeSectionOrderKey(localId: string): string {
    return `nso_${createHmac("sha256", this.secret).update(`native-section-order:v1\0${localId}`, "utf8").digest("base64url")}`;
  }

  private nativeSectionMoveMetadata(params: Record<string, unknown>): { threadId: string; sectionKey: string | null; beforeThreadId: string | null } | undefined {
    if (typeof params.threadId !== "string") return undefined;
    const home = this.nativeSectionHomes.get(params.threadId);
    if (!home || home.expiresAt <= Date.now()) {
      this.nativeSectionHomes.delete(params.threadId);
      return undefined;
    }
    if (params.sectionId !== null && (typeof params.sectionId !== "string" || !this.nativeSectionAvailable(home.account, params.sectionId))) return undefined;
    return { threadId: params.threadId, sectionKey: params.sectionId === null ? null : this.nativeSectionOrderKey(params.sectionId),
      beforeThreadId: typeof params.beforeThreadId === "string" ? params.beforeThreadId : null };
  }

  private commitNativeSectionMove(move: NonNullable<PendingDesktopRequest["nativeSectionMove"]>): void {
    this.store.update((state) => {
      const orders = state.nativeSectionOrders ??= {};
      for (const [key, order] of Object.entries(orders)) {
        orders[key] = order.filter((threadId) => threadId !== move.threadId);
        if (orders[key]!.length === 0) delete orders[key];
      }
      if (!move.sectionKey) return;
      const order = orders[move.sectionKey] ?? [];
      const before = move.beforeThreadId ? order.indexOf(move.beforeThreadId) : -1;
      if (before < 0) order.push(move.threadId); else order.splice(before, 0, move.threadId);
      orders[move.sectionKey] = order;
    });
  }

  private async warmEnabledChildren(): Promise<void> {
    const accounts = this.config.accounts.filter((account) => account.included).map((account) => account.opaqueAccountId);
    for (let offset = 0; offset < accounts.length; offset += 4) {
      await Promise.allSettled(accounts.slice(offset, offset + 4).map(async (account) => {
        const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
        if (child) await this.initializeChild(child);
      }));
    }
  }

  private broadcastFeatureEnablement(client: AppClient, request: JsonRpcRequest): void {
    if (!isPlainRecord(request.params) || typeof request.params.feature !== "string" || request.params.feature.length === 0
      || Buffer.byteLength(JSON.stringify(request.params), "utf8") > 65_536) {
      this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation"));
      return;
    }
    const feature = request.params.feature;
    const params = JSON.parse(JSON.stringify(request.params)) as Record<string, unknown>;
    client.outstanding += 1;
    const operation = this.featureBroadcastTail.then(async () => {
      const responses: Array<{ account: OpaqueAccountId; child: BrokerProcessChild; response: JsonRpcResponse }> = [];
      let failures = 0;
      const accounts = this.config.accounts.filter((account) => account.included).map((account) => account.opaqueAccountId);
      for (let offset = 0; offset < accounts.length; offset += 4) {
        const batch = await Promise.all(accounts.slice(offset, offset + 4).map(async (account) => {
          const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
          if (!child || !await this.initializeChild(child)) return null;
          const response = await this.requestBrokerChild(account, child, request.method, params);
          return response ? { account, child, response } : null;
        }));
        for (const response of batch) {
          if (!response || response.response.error) failures += 1; else responses.push(response);
        }
      }
      // Retain the requested state even when a peer fails. Its next readiness
      // check must retry this state, and newly started children must receive it.
      this.featureEnablements.set(feature, params);
      this.featureRevision += 1;
      for (const { account, child } of responses) {
        if (this.children.get(account) === child) this.childFeatureRevision.set(child, this.featureRevision);
      }
      if (failures > 0 || responses.length !== accounts.length || responses.length === 0) {
        this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
        return;
      }
      const controller = responses.find(({ account }) => account === this.config.primaryOpaqueAccountId) ?? responses[0]!;
      this.sendDesktop(client, { ...controller.response, id: request.id });
    });
    this.featureBroadcastTail = operation.then(() => undefined, () => undefined);
    void operation.catch(() => {
      if (!this.closed && this.clients.get(client.rendererRef) === client) this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
    }).finally(() => { client.outstanding = Math.max(0, client.outstanding - 1); });
  }

  private deferForModelCatalog(client: AppClient, request: JsonRpcRequest): boolean {
    if (this.modelCheckedRequests.has(request) || !["thread/start", "turn/start", "thread/settings/update"].includes(request.method)) return false;
    const model = requestedModelFromParamsV1(request.params);
    if (!model) { this.modelCheckedRequests.add(request); return false; }
    this.modelCheckedRequests.add(request);
    client.outstanding += 1;
    const accounts = this.config.accounts.filter((account) => account.included).map((account) => account.opaqueAccountId);
    void this.modelCatalogs.support(model, accounts).then((support) => {
      this.modelEligibleRequests.set(request, support.eligible);
      if (!this.closed && this.clients.get(client.rendererRef) === client) this.receiveDesktop(client, request);
    }).catch(() => {
      this.modelEligibleRequests.set(request, new Set(accounts));
      if (!this.closed && this.clients.get(client.rendererRef) === client) this.receiveDesktop(client, request);
    }).finally(() => { client.outstanding = Math.max(0, client.outstanding - 1); });
    return true;
  }

  private async readAccountModels(account: OpaqueAccountId): Promise<unknown> {
    const child = this.broker.acquireChild(account) as BrokerProcessChild | null;
    if (!child || !await this.initializeChild(child)) throw new Error("model catalog unavailable");
    const data: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let bytes = 0;
    for (let page = 0; page < 64; page += 1) {
      const response = await this.requestBrokerChild(account, child, "model/list", cursor === null ? {} : { cursor });
      if (!response || response.error || !isPlainRecord(response.result) || !Array.isArray(response.result.data)) throw new Error("model catalog unavailable");
      bytes += Buffer.byteLength(JSON.stringify(response.result), "utf8");
      if (bytes > 2 * 1024 * 1024 || data.length + response.result.data.length > 10_000) throw new Error("model catalog unavailable");
      data.push(...response.result.data);
      const next = response.result.nextCursor;
      if (next === null || next === undefined) return { data, nextCursor: null };
      if (typeof next !== "string" || next.length === 0 || next.length > 4_096 || seen.has(next)) throw new Error("model catalog unavailable");
      seen.add(next);
      cursor = next;
    }
    throw new Error("model catalog unavailable");
  }

  private deferUntilChildReady(client: AppClient, request: JsonRpcRequest, child: BrokerProcessChild, resume: () => void, always = false): boolean {
    if (child.ready && this.childFeatureRevision.get(child) === this.featureRevision && !always) return false;
    const key = automaticCapacityRequestKey(client, request);
    if (this.initializingDesktopRequests.has(key) || client.outstanding >= CLIENT_MAX_OUTSTANDING) {
      this.sendDesktop(client, redactedRouterError(request.id, "invalid_correlation")); return true;
    }
    this.initializingDesktopRequests.add(key);
    client.outstanding += 1;
    void this.initializeChild(child).then((ready) => {
      this.initializingDesktopRequests.delete(key);
      client.outstanding = Math.max(0, client.outstanding - 1);
      if (this.closed || this.clients.get(client.rendererRef) !== client) return;
      if (!ready) { this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure")); return; }
      resume();
    }).catch(() => {
      this.initializingDesktopRequests.delete(key);
      client.outstanding = Math.max(0, client.outstanding - 1);
      if (!this.closed && this.clients.get(client.rendererRef) === client) this.sendDesktop(client, redactedRouterError(request.id, "post_start_failure"));
    });
    return true;
  }

  private isolatedAuthHome(account: OpaqueAccountId): string | null {
    if (!this.nativeHistory) return null;
    const home = nativeHistoryEffectiveAuthHomeV1(this.nativeHistory, account);
    if (!home) throw new Error("native authentication binding unavailable");
    return home === this.nativeAccountBinding(account)?.codexHome ? null : home;
  }

  private readonly pendingAuthRefreshRequests = new Map<BrokerProcessChild, Set<JsonRpcId>>();
  private readonly authHelperTails = new Map<OpaqueAccountId, Promise<void>>();
  private readonly authHelperQueued = new Map<OpaqueAccountId, number>();
  private readonly activeAuthHelpers = new Map<OpaqueAccountId, BrokerProcessChild>();
  private readonly authRefreshes = new Map<OpaqueAccountId, Promise<NativeExternalTokensV1 | null>>();

  private async withAuthHelper<T>(account: OpaqueAccountId, operation: (helper: BrokerProcessChild, home: string) => Promise<T>): Promise<T | null> {
    const home = this.isolatedAuthHome(account); const initialization = this.desktopInitialization;
    if (!home || !initialization || this.closed) return null;
    const queued = this.authHelperQueued.get(account) ?? 0;
    if (queued >= 8 || [...this.enrollmentHelpers.values()].some((helper) => helper.opaqueAccountId === account && helper.isolatedReconnect)) throw new NativeAuthHelperBusyError();
    const previous = this.authHelperTails.get(account) ?? Promise.resolve();
    let release!: () => void;
    const complete = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    // Even an expired waiter keeps the predecessor chain intact until the
    // active operation releases it, so no later request can overtake a writer.
    const tail = previous.then(() => complete);
    this.authHelperTails.set(account, tail); this.authHelperQueued.set(account, queued + 1);
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const admitted = await Promise.race([previous.then(() => true), new Promise<boolean>((resolvePromise) => {
        queueTimer = setTimeout(() => resolvePromise(false), 30_000); queueTimer.unref();
      })]);
      if (queueTimer) clearTimeout(queueTimer);
      if (!admitted) throw new NativeAuthHelperBusyError();
      if (this.closed || this.isolatedAuthHome(account) !== home) return null;
      const helper = new BrokerProcessChild(account, spawn(this.command, credentialStoreArgs(this.args, "file"), {
        cwd: home, env: brokerChildEnvironment(home, home), stdio: ["pipe", "pipe", "ignore"],
      }), () => {}, () => {});
      this.activeAuthHelpers.set(account, helper);
      const timer = setTimeout(() => { void helper.terminateAndWait(); }, 25_000); timer.unref();
      try {
        if (!await helper.initialize(initialization.params, initialization.client) || this.isolatedAuthHome(account) !== home || this.closed) return null;
        return await operation(helper, home);
      } catch { return null; } finally { clearTimeout(timer); await helper.terminateAndWait(); if (this.activeAuthHelpers.get(account) === helper) this.activeAuthHelpers.delete(account); }
    } finally {
      if (queueTimer) clearTimeout(queueTimer);
      release(); const remaining = (this.authHelperQueued.get(account) ?? 1) - 1;
      if (remaining) this.authHelperQueued.set(account, remaining); else this.authHelperQueued.delete(account);
      void tail.then(() => { if (this.authHelperTails.get(account) === tail) this.authHelperTails.delete(account); });
    }
  }

  private refreshIsolatedAuth(account: OpaqueAccountId): Promise<NativeExternalTokensV1 | null> {
    const existing = this.authRefreshes.get(account); if (existing) return existing;
    const pending = this.withAuthHelper(account, async (helper, home) => {
      const entry = this.nativeAccountBinding(account); if (!entry) return null;
      readNativeExternalTokensV1(home, entry, this.secret);
      const response = await helper.requestPrivate("account/read", { refreshToken: true });
      if (!response || response.error || !providerAuthenticated(response.result) || this.isolatedAuthHome(account) !== home) return null;
      return readNativeExternalTokensV1(home, entry, this.secret);
    }).catch((error) => { if (error instanceof NativeAuthHelperBusyError) throw error; return null; });
    this.authRefreshes.set(account, pending);
    const cleanup = (): void => { if (this.authRefreshes.get(account) === pending) this.authRefreshes.delete(account); };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  private createChild(account: OpaqueAccountId): BrokerProcessChild {
    if (this.nativeTransferHeldAccounts.has(account)) throw new Error("native account writer handoff in progress");
    const existing = this.children.get(account);
    if (existing) return existing;
    const nativeSource = this.nativeHistory ? this.nativeAccountBinding(account) : null;
    if (this.nativeHistory && (!nativeSource || !this.nativeHistoryWritersSafe())) {
      throw new Error("accounts broker refused child with native history writer conflict");
    }
    // Recheck the sealed shared source and every included account copy at the
    // final child-spawn boundary. A mismatch is never repaired in place: that
    // would silently overwrite account-local evidence.
    if (!nativeSource && !preflightRouterHomes(this.config, this.stateRoot)) {
      throw new Error("accounts broker refused child with invalid shared Skills/plugins materialization");
    }
    const accountRoot = join(this.stateRoot, "accounts", account);
    const codexHome = nativeSource?.codexHome ?? join(accountRoot, "codex-home");
    const sqliteHome = nativeSource?.sqliteHome ?? join(accountRoot, "sqlite-home");
    if (!this.prepareAccountContinuity(account, codexHome)) {
      throw new Error("accounts broker refused child with unresolved account continuity");
    }
    // In-place native homes retain their own existing plugin/Skill state. The
    // old generated shared-plugin override belongs only to adopted homes.
    const authHome = this.isolatedAuthHome(account);
    const childArgs = nativeSource ? authHome ? credentialStoreArgs(this.args, "ephemeral") : this.args : sharedPluginChildArgs(this.stateRoot, this.args);
    if (!childArgs) throw new Error("accounts broker refused child with invalid shared plugin enablement");
    const mode = this.sharedNativeMode();
    if (mode?.state === "blocked") throw new Error("accounts broker refused unresolved shared native mode");
    if (mode?.state === "ready") {
      const binary = lstatSync(this.command);
      if (!binary.isFile() || binary.isSymbolicLink()
        || createHash("sha256").update(readFileSync(this.command)).digest("hex") !== mode.document.resolverBinarySha256) {
        throw new Error("accounts broker refused unverified shared native resolver binary");
      }
    }
    const childProcess = spawn(this.command, childArgs, {
      cwd: process.cwd(),
      env: { ...brokerChildEnvironment(codexHome, sqliteHome), ...(mode?.state === "ready" ? mode.environment : {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const child = new BrokerProcessChild(
      account,
      childProcess,
      (message) => this.receiveChild(account, child, message),
      (expectedTermination) => {
        this.children.delete(account);
        // Capture closed-child edits without rewriting the home. If a foreign
        // native writer has appeared, the next idle spawn boundary retries.
        this.prepareAccountContinuity(account, codexHome, true);
        // A child can disappear after a request has crossed the write
        // boundary but before its response or terminal notification.  Do not
        // leave either the desktop request or the canonical writer lease
        // hanging: settle that uncertain work exactly once and make it
        // visibly ambiguous.  `expectedTermination` is used for ordinary
        // idle/shutdown rotation too; in that case there should be no pending
        // request, and this idempotent cleanup is a no-op.
        this.failPendingForChild(account, child);
        // Capacity/idle/shutdown eviction is normal pool rotation, not an
        // account-health failure. Only an unsolicited child exit makes that
        // account unavailable for future work.
        if (!expectedTermination) this.broker.markChildUnavailable(account);
      },
      authHome ? async (candidate) => {
        if (this.isolatedAuthHome(account) !== authHome || !nativeSource) return false;
        // Quota reads do not trigger external-auth refresh on 401. Renew in
        // the isolated file store before startup, otherwise an expired access
        // token can make this account unavailable before its first turn.
        const tokens = await this.refreshIsolatedAuth(account);
        if (!tokens || this.isolatedAuthHome(account) !== authHome) return false;
        const login = await candidate.requestPrivate("account/login/start", { type: "chatgptAuthTokens", ...tokens });
        if (!login || login.error) return false;
        const read = await candidate.requestPrivate("account/read", { refreshToken: false });
        return !!read && !read.error && providerAuthenticated(read.result) && this.isolatedAuthHome(account) === authHome;
      } : undefined,
    );
    this.children.set(account, child);
    return child;
  }

  /**
   * Child-process failure is an uncertain transport outcome for anything
   * already handed to that child.  This path intentionally never retries a
   * request: a duplicate provider write would be worse than a visible
   * ambiguous turn.  Broker-internal probes are safely resolved as unavailable
   * because they do not carry a desktop/canonical writer lease.
   */
  private failPendingForChild(account: OpaqueAccountId, child: BrokerProcessChild): void {
    for (const [id, pending] of [...this.pendingBrokerChild]) {
      if (pending.account !== account) continue;
      this.pendingBrokerChild.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    for (const [id, pending] of [...this.pendingDesktop]) {
      if (pending.account !== account) continue;
      this.removePendingDesktop(id);
      pending.client.outstanding = Math.max(0, pending.client.outstanding - 1);
      this.settleUncertainPending(pending);
      if (this.clients.get(pending.client.rendererRef) === pending.client) {
        this.sendDesktop(pending.client, redactedRouterError(pending.desktopId, "post_start_failure"));
      }
    }
    for (const [id, pending] of [...this.pendingChild]) {
      if (pending.child !== child) continue;
      this.pendingChild.delete(id);
      try { pending.child.send(redactedRouterError(pending.childRequestId, "post_start_failure")); } catch {}
    }
  }

  private receiveChild(account: OpaqueAccountId, child: BrokerProcessChild, message: JsonRpcMessage): void {
    if (isResponse(message)) {
      if (this.resolveHistoryFanout(account, message)) return;
      if (typeof message.id === "string") {
        const pending = this.pendingBrokerChild.get(message.id);
        if (pending && pending.account === account) {
          this.pendingBrokerChild.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve(message);
          return;
        }
      }
      this.resolveDesktopResponse(account, child, message);
      return;
    }
    if (isRequest(message)) {
      this.routeChildRequest(account, child, message);
      return;
    }
    if (this.captureEnrollmentNotification(account, message)) return;
    this.routeChildNotification(account, message);
  }

  private captureEnrollmentNotification(account: OpaqueAccountId, message: JsonRpcMessage): boolean {
    if (!isNotification(message) || message.method !== "account/login/completed" || !isPlainRecord(message.params)
      || typeof message.params.loginId !== "string" || typeof message.params.success !== "boolean") return false;
    for (const helper of this.enrollmentHelpers.values()) {
      const helperAccount = helper.transportAccountId;
      if (helperAccount !== account || helper.loginId !== message.params.loginId) continue;
      if (helper.isolatedReconnect) {
        if (message.params.success) void this.completeIsolatedReconnect(helper);
        else { helper.completion = { success: false }; clearTimeout(helper.isolatedReconnect.timer); helper.isolatedReconnect.preimage.fill(0); void helper.child.terminateAndWait(); }
      } else helper.completion = { success: message.params.success };
      return true;
    }
    return false;
  }

  private async completeIsolatedReconnect(helper: EnrollmentHelper): Promise<void> {
    const repair = helper.isolatedReconnect; const account = helper.opaqueAccountId;
    if (!repair || !account || !helper.root) return;
    try {
      const entry = this.nativeAccountBinding(account); if (!entry || this.isolatedAuthHome(account) !== repair.authHome) throw new Error("unavailable");
      readNativeExternalTokensV1(helper.root, entry, this.secret);
      const profile = await helper.child.requestPrivate("account/read", { refreshToken: false });
      if (!profile || profile.error || !providerAuthenticated(profile.result) || !await helper.child.terminateAndWait()) throw new Error("unavailable");
      if (this.enrollmentHelpers.get(helper.enrollmentRef) !== helper || this.isolatedAuthHome(account) !== repair.authHome) throw new Error("unavailable");
      readNativeExternalTokensV1(helper.root, entry, this.secret);
      const fresh = readNativeAuthPrivateFileV1(join(helper.root, "auth.json"));
      const current = readNativeAuthPrivateFileV1(join(repair.authHome, "auth.json"));
      try {
        if (!current.equals(repair.preimage)) throw new Error("unavailable");
        const target = join(repair.authHome, "auth.json"); const before = lstatSync(target);
        const staged = join(repair.authHome, `.auth-reconnect-${randomBytes(16).toString("hex")}`);
        writeFileSync(staged, fresh, { flag: "wx", mode: 0o600 });
        const priorEvidence = join(repair.authHome, `.auth-before-reconnect-${randomBytes(16).toString("hex")}`);
        writeFileSync(priorEvidence, current, { flag: "wx", mode: 0o600 });
        for (const path of [staged, priorEvidence]) { const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
        const check = readNativeAuthPrivateFileV1(target);
        try { if (!check.equals(current) || lstatSync(target).ino !== before.ino || this.isolatedAuthHome(account) !== repair.authHome) throw new Error("unavailable"); }
        finally { check.fill(0); }
        renameSync(staged, target);
        const fd = openSync(repair.authHome, fsConstants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
        helper.completion = { success: true };
        // Existing external-auth child may hold old in-memory access tokens.
        // It refreshes through the same isolated helper on the next 401.
      } finally { fresh.fill(0); current.fill(0); }
    } catch { helper.completion = { success: false }; }
    finally { clearTimeout(repair.timer); repair.preimage.fill(0); await helper.child.terminateAndWait(); }
  }

  private resolveDesktopResponse(account: OpaqueAccountId, _child: BrokerProcessChild, response: JsonRpcResponse): void {
    if (typeof response.id !== "string") return;
    const pending = this.pendingDesktop.get(response.id);
    if (!pending || pending.account !== account || pending.acknowledged) return;
    if (this.nativeHistory && pending.method === "project/list" && account === this.nativeHistory.source.metadataAccountId && !response.error) {
      this.refreshNativeLegacyProjectsFromResult(response.result);
    }
    if (!response.error) void this.refreshSharedNativeRuntimes(pending.method);
    // `turn/start` acknowledgement is not a terminal provider outcome. Keep
    // its exact pending record and watchdog through `turn/completed`, a
    // terminal error, child failure, timeout, or renderer disconnect so the
    // canonical writer lease cannot be stranded after an acknowledged write.
    const awaitsTerminalTurn = pending.method === "turn/start" && pending.conversationId !== null && pending.taskRef !== null;
    if (awaitsTerminalTurn && !response.error) {
      pending.acknowledged = true;
      const nativeThreadId = this.threadByTaskRef.get(pending.taskRef!);
      this.bindBalanceTurn(pending.balanceReservationId, nativeThreadId ?? null, nativeTurnIdFrom(response.result));
      if (nativeThreadId) {
        this.canonicalHistory.markTurnActive(pending.conversationId!, account, nativeThreadId);
        this.publishConversation(pending.conversationId!);
      }
      const wireThreadId = this.nativeHistory
        ? this.nativeOutboundThreadId(pending.conversationId!)
        : this.canonicalHistory.publicThreadId(pending.conversationId!);
      const logicalResponse = wireThreadId
        ? this.nativeHistory ? withNativeResponseThreadId(response, wireThreadId) : withResponseThreadId(response, wireThreadId)
        : response;
      const projectedResponse = this.nativeHistory ? this.withNativeHistoryProjectIds(account, logicalResponse) : logicalResponse;
      this.sendDesktop(pending.client, { ...projectedResponse, id: pending.desktopId });
      return;
    }
    this.removePendingDesktop(response.id);
    pending.client.outstanding = Math.max(0, pending.client.outstanding - 1);
    if (response.error && pending.conversationId) {
      const nativeThreadId = pending.taskRef ? this.threadByTaskRef.get(pending.taskRef) : null;
      this.settleBalancedTurn(account, nativeThreadId ?? null, nativeTurnIdFrom(response.result), null);
      if (nativeThreadId) {
        this.canonicalHistory.markIncomplete(pending.conversationId, account, nativeThreadId);
        this.publishConversation(pending.conversationId);
      }
    }
    if (!response.error && pending.nativeSectionMove) {
      try { this.commitNativeSectionMove(pending.nativeSectionMove); }
      catch {
        this.sendDesktop(pending.client, redactedRouterError(pending.desktopId, "post_start_failure"));
        return;
      }
    }
    const threadId = threadIdFrom(response.result);
    if (["thread/start", "thread/fork", "thread/resume", "thread/unarchive"].includes(pending.method) && threadId) {
      if (pending.method === "thread/start") this.seedProvenNewThreadBalance(account, threadId);
      this.ensureTask(pending.client, account, threadId);
    }
    // Every desktop-visible thread identity is the stable logical alias.  The
    // provider id stays solely in the canonical physical-segment binding.
    const responseConversation = pending.method === "thread/fork" && threadId
      ? this.canonicalHistory.conversationForNative(account, threadId)
      : pending.conversationId ?? (threadId ? this.canonicalHistory.conversationForNative(account, threadId) : null);
    const wireThreadId = responseConversation
      ? this.nativeHistory ? this.nativeOutboundThreadId(responseConversation) : this.canonicalHistory.publicThreadId(responseConversation)
      : null;
    const logicalResponse = wireThreadId
      ? this.nativeHistory ? withNativeResponseThreadId(response, wireThreadId) : withResponseThreadId(response, wireThreadId)
      : response;
    const projectedResponse = this.nativeHistory ? this.withNativeHistoryProjectIds(account, logicalResponse) : logicalResponse;
    this.sendDesktop(pending.client, { ...projectedResponse, id: pending.desktopId });
  }

  /** Removes the one terminal watchdog retained after a turn/start acknowledgement. */
  private settleTerminalTurn(account: OpaqueAccountId, taskRef: OpaqueTaskRef | null): boolean {
    if (!taskRef) return false;
    for (const [id, pending] of this.pendingDesktop) {
      if (pending.account !== account || pending.taskRef !== taskRef || pending.method !== "turn/start") continue;
      this.removePendingDesktop(id);
      pending.client.outstanding = Math.max(0, pending.client.outstanding - 1);
      return true;
    }
    return false;
  }

  private routeChildRequest(account: OpaqueAccountId, child: BrokerProcessChild, request: JsonRpcRequest): void {
    if (request.method === "account/chatgptAuthTokens/refresh") {
      const requests = this.pendingAuthRefreshRequests.get(child) ?? new Set<JsonRpcId>();
      if (requests.has(request.id) || requests.size >= 8) {
        this.broker.markChildUnavailable(account); child.terminate("capacity"); return;
      }
      requests.add(request.id); this.pendingAuthRefreshRequests.set(child, requests);
      void (async () => {
        try {
          if (this.children.get(account) !== child || !this.isolatedAuthHome(account)) throw new Error("unavailable");
          if (!isPlainRecord(request.params) || request.params.reason !== "unauthorized"
            || Object.keys(request.params).some((key) => key !== "reason" && key !== "previousAccountId")) throw new Error("unavailable");
          const previous = request.params.previousAccountId;
          if (previous !== null && previous !== undefined) {
            const entry = this.nativeAccountBinding(account);
            if (typeof previous !== "string" || !entry || nativeHistoryAuthIdentityHmacV1(previous, this.secret) !== entry.authIdentityHmac) throw new Error("unavailable");
          }
          const tokens = await this.refreshIsolatedAuth(account);
          if (!tokens || this.children.get(account) !== child) throw new Error("unavailable");
          child.send({ jsonrpc: "2.0", id: request.id, result: tokens });
        } catch (error) {
          if (!(error instanceof NativeAuthHelperBusyError)) this.broker.markChildUnavailable(account);
          try { child.send(redactedRouterError(request.id, "post_start_failure")); } catch {}
        } finally {
          requests.delete(request.id); if (!requests.size) this.pendingAuthRefreshRequests.delete(child);
        }
      })();
      return;
    }
    const threadId = threadIdFrom(request.params);
    if (!threadId) {
      const client = child.initializationClient;
      if (request.method === "attestation/generate" && client && this.clients.get(client.rendererRef) === client) {
        const desktopId = `ab1s:${++this.nonce}`;
        this.pendingChild.set(desktopId, { client, child, childRequestId: request.id });
        this.sendDesktop(client, { ...request, id: desktopId });
        return;
      }
      try { child.send(redactedRouterError(request.id, "unknown_thread_owner")); } catch {}
      return;
    }
    const taskRef = this.taskRefsByThread.get(threadId);
    const route = taskRef ? this.broker.routeAppTools(taskRef) : null;
    const client = route ? this.clients.get(route.ownerRendererRef) ?? null : null;
    if (!client || route?.appToolsRef !== client.appToolsRef) {
      try { child.send(redactedRouterError(request.id, "unknown_thread_owner")); } catch {}
      return;
    }
    const desktopId = `ab1s:${++this.nonce}`;
    this.pendingChild.set(desktopId, { client, child, childRequestId: request.id });
    const conversationId = this.canonicalHistory.conversationForNative(account, threadId);
    const wireThreadId = conversationId
      ? this.nativeHistory ? this.nativeOutboundThreadId(conversationId) : this.canonicalHistory.publicThreadId(conversationId)
      : null;
    this.sendDesktop(client, { ...(wireThreadId ? withThreadId(request, wireThreadId) : request), id: desktopId });
  }

  private resolveChildRequest(client: AppClient, response: JsonRpcResponse): void {
    if (typeof response.id !== "string") return;
    const pending = this.pendingChild.get(response.id);
    if (!pending || pending.client !== client) return;
    this.pendingChild.delete(response.id);
    try { pending.child.send({ ...response, id: pending.childRequestId }); } catch {}
  }

  private routeChildNotification(account: OpaqueAccountId, notification: JsonRpcMessage): void {
    if (isNotification(notification) && notification.method === "account/rateLimits/updated") {
      const quota = providerQuotaProjection(notification.params);
      if (quota) this.broker.updateQuota({ opaqueAccountId: account, ...quota });
      const params = pooledNativeQuotaV1(this.broker.pool().accounts, this.broker.quota());
      for (const client of this.clients.values()) this.sendDesktop(client, { jsonrpc: "2.0", method: notification.method, params });
      return;
    }
    if (this.nativeHistory && isNotification(notification) && notification.method === "project/changed") {
      // Only the signed metadata authority may announce a source sidebar
      // project. Target-local compatibility imports are internal plumbing and
      // must never expose their local ids to either desktop.
      if (account !== this.nativeHistory.source.metadataAccountId) return;
      const projectId = nativeProjectChangedId(notification.params);
      if (!projectId) return;
      const publicNotification = this.withNativePublicProjectIdsNotification(account, notification);
      for (const client of this.clients.values()) this.sendDesktop(client, publicNotification);
      return;
    }
    if (this.nativeHistory && this.nativeLegacyProjects && isNotification(notification) && notification.method === "thread/project/updated"
      && account === this.nativeHistory.source.metadataAccountId) {
      // A provider-confirmed reassignment/removal must permanently suppress
      // the stale legacy fallback.  We never tombstone from a request,
      // error, timeout, or guessed response shape.
      const update = nativeThreadProjectUpdate(notification.params);
      const legacyProjectId = update ? this.nativeLegacyProjects.legacyPublicProjectIdForThread(update.threadId) : null;
      if (update && legacyProjectId && update.projectId !== legacyProjectId && this.nativeHistoryWritersSafe()) {
        this.nativeLegacyProjects.removeThreadFromProject(legacyProjectId, update.threadId);
      }
    }
    const threadId = threadIdFrom(isNotification(notification) ? notification.params : undefined);
    if (!threadId || this.store.snapshot().threadOwners[threadId] !== account) return;
    const taskRef = this.taskRefsByThread.get(threadId);
    const route = taskRef ? this.broker.routeAppTools(taskRef) : null;
    const client = route ? this.clients.get(route.ownerRendererRef) ?? null : null;
    const conversationId = this.canonicalHistory.conversationForNative(account, threadId);

    // Provider accounting and run cleanup belong to the broker owner, never to
    // an optional renderer socket. A disconnected origin cannot receive a
    // transcript, but its terminal notification still settles the durable
    // reservation and canonical lease without replaying anything.
    if (isNotification(notification) && notification.method === "thread/tokenUsage/updated" && isPlainRecord(notification.params)) {
      const nativeTurnId = typeof notification.params.turnId === "string" ? notification.params.turnId : null;
      this.observeBalancedTokenUsage(account, threadId, nativeTurnId, notification.params.tokenUsage ?? null);
    }
    let canonicalCompletedTurn: Record<string, unknown> | null = null;
    if (isNotification(notification) && notification.method === "turn/completed" && isPlainRecord(notification.params)) {
      const turn = isPlainRecord(notification.params.turn) ? notification.params.turn : null;
      const nativeTurnId = turn && typeof turn.id === "string" ? turn.id : null;
      if (conversationId && client) {
        const itemsView = turn?.itemsView === undefined || turn.itemsView === "full";
        const committed = itemsView && Array.isArray(turn?.items)
          ? this.canonicalHistory.commitTurn(conversationId, account, threadId, nativeTurnId, turn.items)
          : null;
        if (committed) {
          this.publishCommittedTurn(conversationId, committed);
          if (!this.nativeHistory) this.publishPeerCommittedTranscript(conversationId, committed, client.rendererRef);
          const publicThreadId = this.canonicalHistory.publicThreadId(conversationId);
          const logical = publicThreadId ? this.canonicalHistory.logicalRead(publicThreadId) : null;
          const canonicalTurn = logical?.turns.find((candidate) => candidate.turnId === committed) ?? null;
          if (canonicalTurn) canonicalCompletedTurn = canonicalTurnProjection(canonicalTurn, this.secret);
        } else this.canonicalHistory.markIncomplete(conversationId, account, threadId);
        this.publishConversation(conversationId);
      } else if (conversationId) {
        // The disconnected desktop was already marked ambiguous; a later
        // provider completion is not safe to expose or silently recommit.
        this.canonicalHistory.markAmbiguous(conversationId, account, threadId);
        this.publishConversation(conversationId);
      }
      this.settleBalancedTurn(account, threadId, nativeTurnId, turn?.tokenUsage ?? null);
    }
    if (isNotification(notification) && (notification.method === "turn/completed" || notification.method === "thread/closed")) {
      const settled = this.settleTerminalTurn(account, taskRef ?? null);
      if (notification.method === "thread/closed") this.settleBalancedTurn(account, threadId, null, null);
      if (notification.method === "thread/closed" && conversationId && settled) {
        // A closed thread without a complete turn snapshot is a proven
        // terminal failure, distinct from an uncertain transport loss.
        this.canonicalHistory.markIncomplete(conversationId, account, threadId);
        this.publishConversation(conversationId);
      }
      if (taskRef) this.broker.finishRun(taskRef);
    }
    if (!client) return;
    const wireThreadId = conversationId
      ? this.nativeHistory ? this.nativeOutboundThreadId(conversationId) : this.canonicalHistory.publicThreadId(conversationId)
      : null;
    let desktopNotification: JsonRpcMessage = this.nativeHistory
      ? wireThreadId ? withNativeNotificationThreadId(notification, wireThreadId) : notification
      : canonicalCompletedTurn && wireThreadId
        ? { jsonrpc: "2.0" as const, method: "turn/completed", params: { threadId: wireThreadId, turn: canonicalCompletedTurn } }
        : wireThreadId ? withNotificationThreadId(notification, wireThreadId) : notification;
    if (this.nativeHistory) desktopNotification = this.withNativePublicProjectIdsNotification(account, desktopNotification);
    this.sendDesktop(client, desktopNotification);
  }

  private async forwardNativeContinuation(delivery: BrokerHandoffDeliveryV1): Promise<BrokerHandoffDeliveryResultV1> {
    const transfer = this.nativeTransfer;
    const threadId = this.threadByTaskRef.get(delivery.taskRef);
    const held = this.heldDesktopContinuations.get(delivery.handoffRef);
    if (!transfer || !threadId || !held || !isJsonRpcMessage(delivery.continuation) || !isRequest(delivery.continuation)
      || delivery.continuation.method !== "turn/start" || this.remoteBlocksDesktop(delivery.toOpaqueAccountId)
      || this.remoteBlocksDesktop(delivery.fromOpaqueAccountId) || this.canonicalHistory.hasActiveTurn(delivery.conversationId)
      || this.store.snapshot().threadOwners[threadId] !== delivery.fromOpaqueAccountId) return "rejected";
    const input = portableTurnStartInput(delivery.continuation.params);
    if (input.kind !== "portable") return "linked_continuation_required";
    if (!hasFreshPositiveQuota(this.broker.quota().find((quota) => quota.opaqueAccountId === delivery.toOpaqueAccountId))) return "rejected";
    const targetSchemaChild = this.broker.acquireChild(delivery.toOpaqueAccountId) as BrokerProcessChild | null;
    if (!targetSchemaChild || !await this.initializeChild(targetSchemaChild)) return "rejected";
    this.nativeTransferHeldAccounts.add(delivery.fromOpaqueAccountId);
    this.nativeTransferHeldAccounts.add(delivery.toOpaqueAccountId);
    let preparedOperationId: string | null = null;
    try {
    const targetBeforePrepare = await this.loadedNativeThreads(delivery.toOpaqueAccountId);
    if (targetBeforePrepare === null || targetBeforePrepare.length !== 0) return "rejected";
    if (!await this.quiesceIdleAccount(delivery.toOpaqueAccountId, delivery.handoffRef)) return "rejected";
    if (!await transfer.sourceProjectionReady(threadId, delivery.fromOpaqueAccountId)) return "rejected";
    const sourceBeforePrepare = await this.loadedNativeThreads(delivery.fromOpaqueAccountId);
    if (sourceBeforePrepare === null || sourceBeforePrepare.some((loadedThreadId) => loadedThreadId !== threadId)) return "rejected";
    if (!await this.quiesceIdleAccount(delivery.fromOpaqueAccountId, delivery.handoffRef)) return "rejected";
    const prepared = await transfer.prepareSameThreadTransfer({ operationId: delivery.handoffRef, threadId,
      sourceAccountId: delivery.fromOpaqueAccountId, targetAccountId: delivery.toOpaqueAccountId });
    if (prepared.state !== "ready") { if (prepared.state === "busy") held.rejectionCode = "account_history_busy"; return "rejected"; }
    preparedOperationId = prepared.operationId;
    // JS ownership is synchronous across this exact remove/acquire pair. The
    // new child is the only writer admitted after preparation.
    this.nativeTransferHeldAccounts.delete(delivery.toOpaqueAccountId);
    const target = this.broker.acquireChild(delivery.toOpaqueAccountId) as BrokerProcessChild | null;
    this.nativeTransferHeldAccounts.add(delivery.toOpaqueAccountId);
    if (!target || !await this.initializeChild(target)) return "rejected";
    const targetBeforeResume = await this.loadedNativeThreads(delivery.toOpaqueAccountId);
    if (targetBeforeResume === null || targetBeforeResume.length !== 0) return "rejected";
    if (!await transfer.revalidatePrepared(prepared.operationId)) return "rejected";
    const resumeParams = { threadId, path: prepared.targetPath, excludeTurns: true };
    // The prepared projection must be consumable by this exact initialized
    // target before the lease is released. While the coordinator lock is
    // still held, the provider's precise active-writer error is a side-effect
    // free capability proof. Every other outcome may already have loaded the
    // target, so retain the unresolved journal and never send another resume.
    transfer.markResumeDispatching(prepared.operationId);
    const warmup = await this.requestBrokerChild(delivery.toOpaqueAccountId, target, "thread/resume", resumeParams);
    if (!warmup || warmup.error?.code !== -32600 || warmup.error.message !== `thread ${threadId} already has an active writer`) return "ambiguous";
    if (this.children.get(delivery.toOpaqueAccountId) !== target || !target.ready) return "ambiguous";
    const targetAfterWarmup = await this.loadedNativeThreads(delivery.toOpaqueAccountId);
    if (this.children.get(delivery.toOpaqueAccountId) !== target || !target.ready
      || targetAfterWarmup === null || targetAfterWarmup.length !== 0) return "ambiguous";
    if (!await transfer.confirmPreparationProbeBlocked(prepared.operationId, warmup)) return "ambiguous";
    if (!await transfer.revalidatePrepared(prepared.operationId)) return "ambiguous";
    transfer.markResumeDispatching(prepared.operationId);
    if (!transfer.releasePreparationLeaseForResume(prepared.operationId)) {
      transfer.settleResume(prepared.operationId, null);
      return "ambiguous";
    }
    const resumed = await this.requestBrokerChild(delivery.toOpaqueAccountId, target, "thread/resume", resumeParams);
    let settlement;
    if (!resumed) {
      const loaded = new Map<OpaqueAccountId, readonly { threadId: string }[]>();
      for (const account of this.config.accounts) {
        const threads = await this.loadedNativeThreads(account.opaqueAccountId);
        if (threads === null) return "ambiguous";
        loaded.set(account.opaqueAccountId, threads.map((threadId) => ({ threadId })));
      }
      await transfer.revalidateResumedGeneration(prepared.operationId);
      settlement = transfer.recoverResume(prepared.operationId, loaded);
    } else {
      await transfer.revalidateResumedGeneration(prepared.operationId);
      settlement = transfer.settleResume(prepared.operationId, resumed);
    }
    if (settlement.state !== "proved") {
      if (resumed?.error?.code === -32600 && resumed.error.message === `thread ${threadId} already has an active writer`) held.rejectionCode = "account_history_busy";
      return settlement.state === "source_owned" ? "rejected" : "ambiguous";
    }
    let dispatched = false;
    try {
      this.store.update((state) => {
        if (state.threadOwners[threadId] !== delivery.fromOpaqueAccountId) throw new Error("native owner changed");
        state.threadOwners[threadId] = delivery.toOpaqueAccountId;
        state.ledger[delivery.fromOpaqueAccountId]!.assignedThreadCount = Math.max(0, state.ledger[delivery.fromOpaqueAccountId]!.assignedThreadCount - 1);
        state.ledger[delivery.toOpaqueAccountId]!.assignedThreadCount += 1;
        const receipt = state.pendingHandoffs?.[delivery.handoffRef];
        if (!receipt || receipt.state !== "pending") throw new Error("native handoff receipt changed");
        receipt.state = "forwarding";
      });
      this.canonicalHistory.activateNativeWriter({ conversationId: delivery.conversationId, nativeThreadId: threadId,
        opaqueAccountId: delivery.toOpaqueAccountId, ownerRendererRef: held.client.rendererRef, ownerLabel: this.clientLabel(held.client) });
      if (!this.broker.transferNativeTask(delivery.taskRef, delivery.fromOpaqueAccountId, delivery.toOpaqueAccountId)) throw new Error("native task binding changed");
      transfer.commitWriter(prepared.operationId);
      this.nativeRetirementHandoffs.set(delivery.fromOpaqueAccountId, delivery.handoffRef);
      try {
        // The source child is still stopped and blocked from restarting. Keep
        // recoverable source retirement ahead of the target's first new turn.
        const retirement = await transfer.retireSourceProjection(prepared.operationId);
        if (retirement.state !== "retired") throw new Error("native source retirement remains held");
      } finally {
        this.nativeRetirementHandoffs.delete(delivery.fromOpaqueAccountId);
      }
      this.syncBrokerAssignedTaskCounts();
      const logicalTurnId = this.canonicalHistory.beginTurn(delivery.conversationId, delivery.toOpaqueAccountId, threadId,
        held.client.rendererRef, this.clientLabel(held.client), delivery.continuation.params);
      this.canonicalHistory.markTurnDispatching(delivery.conversationId, delivery.toOpaqueAccountId, threadId);
      if (!this.broker.beginRun(delivery.taskRef)) throw new Error("native target unavailable");
      const childId = `ab1:${++this.nonce}`;
      this.addPendingDesktop(childId, { client: held.client, desktopId: held.desktopId, account: delivery.toOpaqueAccountId,
        taskRef: delivery.taskRef, method: "turn/start", conversationId: delivery.conversationId, logicalTurnId, balanceReservationId: null });
      held.forwardChildId = childId;
      if (held.automaticCapacityRefreshKey) this.automaticCapacityRefreshByChild.set(childId, held.automaticCapacityRefreshKey);
      if (!this.nativeHistoryWritersSafe() || transfer.preflightSharedWriterLocks().state !== "ready") throw new Error("native transfer binding changed");
      if (!hasFreshPositiveQuota(this.broker.quota().find((quota) => quota.opaqueAccountId === delivery.toOpaqueAccountId))) throw new Error("native target quota changed");
      dispatched = true;
      target.send({ ...delivery.continuation, id: childId, params: { ...(isPlainRecord(delivery.continuation.params) ? delivery.continuation.params : {}), threadId } });
      this.store.update((state) => { if (state.pendingHandoffs) delete state.pendingHandoffs[delivery.handoffRef]; });
      this.heldDesktopContinuations.delete(delivery.handoffRef);
      this.publishConversation(delivery.conversationId);
      return "delivered";
    } catch {
      // The native resume crossed a writer boundary even if the turn did not.
      // Retain its durable proof for recovery; never retry the user's turn.
      try {
        if (dispatched) this.canonicalHistory.markAmbiguous(delivery.conversationId, delivery.toOpaqueAccountId, threadId);
        else this.canonicalHistory.markIncomplete(delivery.conversationId, delivery.toOpaqueAccountId, threadId);
      } catch {}
      if (held.forwardChildId) { this.removePendingDesktop(held.forwardChildId); this.automaticCapacityRefreshByChild.delete(held.forwardChildId); }
      this.broker.finishRun(delivery.taskRef);
      return "ambiguous";
    }
    } finally {
      if (preparedOperationId) transfer.releasePreparationLease(preparedOperationId);
      this.nativeTransferHeldAccounts.delete(delivery.fromOpaqueAccountId);
      this.nativeTransferHeldAccounts.delete(delivery.toOpaqueAccountId);
    }
  }

  private async forwardContinuation(delivery: BrokerHandoffDeliveryV1): Promise<BrokerHandoffDeliveryResultV1> {
    if (this.nativeHistory) return this.forwardNativeContinuation(delivery);
    const threadId = this.threadByTaskRef.get(delivery.taskRef);
    const held = this.heldDesktopContinuations.get(delivery.handoffRef);
    if (!threadId || !held || !isJsonRpcMessage(delivery.continuation) || !isRequest(delivery.continuation)
      || delivery.continuation.method !== "turn/start") return "rejected";
    const input = portableTurnStartInput(delivery.continuation.params);
    const context = this.nativeHistory
      ? await this.nativeContinuationContext(delivery.fromOpaqueAccountId, threadId, delivery.conversationId)
      : this.canonicalHistory.continuityContext(delivery.conversationId);
    if (input.kind === "nonportable" || !context || context.digest !== `sha256:${createHash("sha256").update(context.text, "utf8").digest("hex")}`) {
      // The source canonical receipt is intentionally content-free. It is
      // recorded before a destination child is acquired, so no unsafe input,
      // path, attachment, or provider identifier can cross subscriptions.
      try {
        this.canonicalHistory.recordLinkedContinuationRequired(delivery.conversationId, delivery.fromOpaqueAccountId, threadId);
        this.publishConversation(delivery.conversationId);
      } catch {
        return "rejected";
      }
      return "linked_continuation_required";
    }
    if (input.kind !== "portable") return "rejected";
    // Core checked this at confirmation time. Repeat it directly before the
    // one permitted child write so a quota event racing user confirmation
    // cannot dispatch to a stale or depleted target.
    const targetQuota = this.broker.quota().find((quota) => quota.opaqueAccountId === delivery.toOpaqueAccountId);
    if (!hasFreshPositiveQuota(targetQuota)) return "rejected";
    if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return "rejected";
    const child = this.broker.acquireChild(delivery.toOpaqueAccountId) as BrokerProcessChild | null;
    if (!child || !await this.initializeChild(child)) return "rejected";

    // Before the single child write, make the durable record explicit.  This
    // lets restart recovery distinguish a cancelled in-memory hold from a
    // possibly-delivered continuation without storing that continuation.
    try {
      this.store.update((state) => {
        if (state.threadOwners[threadId] !== delivery.fromOpaqueAccountId) throw new Error("handoff owner changed");
        const handoffs = state.pendingHandoffs ?? (state.pendingHandoffs = {});
        const existing = handoffs[delivery.handoffRef];
        if (!existing || existing.state !== "pending") throw new Error("handoff receipt unavailable");
        existing.state = "forwarding";
      });
    } catch {
      return "rejected";
    }

    // A target native thread is always created fresh. The source thread's
    // durable owner mapping is immutable and is never sent to another account.
    if (this.nativeHistory && !this.nativeHistoryWritersSafe()) return "rejected";
    const started = await this.requestBrokerChild(delivery.toOpaqueAccountId, child, "thread/start", {});
    if (!started) return "ambiguous";
    if (started.error) return "rejected";
    const targetThreadId = threadIdFrom(started.result);
    if (!targetThreadId) return "ambiguous";
    if (this.nativeHistory && !this.nativeHistoryWritersSafe()) {
      // `thread/start` crossed a provider write boundary. Preserve that
      // unknown target as ambiguous; never retry it on a different account.
      try {
        this.canonicalHistory.addSegment({
          conversationId: delivery.conversationId,
          opaqueAccountId: delivery.toOpaqueAccountId,
          nativeThreadId: targetThreadId,
          ownerRendererRef: held.client.rendererRef,
          ownerLabel: this.clientLabel(held.client),
        });
        this.canonicalHistory.markAmbiguous(delivery.conversationId, delivery.toOpaqueAccountId, targetThreadId);
        this.publishConversation(delivery.conversationId);
      } catch { /* the provider outcome remains ambiguous either way */ }
      return "ambiguous";
    }
    this.seedProvenNewThreadBalance(delivery.toOpaqueAccountId, targetThreadId);
    let targetTaskRef: OpaqueTaskRef | null = null;
    let targetBalanceReservation: TokenBalanceReservation | null = null;
    let targetBalanceDispatched = false;
    try {
      const childId = `ab1:${++this.nonce}`;
      const handoffContextMarker = this.nativeHistory
        ? this.nativeHandoffContextMarker(delivery.toOpaqueAccountId, targetThreadId)
        : null;
      // The reservation estimates the exact provider payload, including the
      // bounded canonical continuation context that will be written below.
      const turnRequest: JsonRpcRequest = { jsonrpc: "2.0", id: childId, method: "turn/start", params: {
        threadId: targetThreadId,
        input: input.input,
        additionalContext: {
          broker_logical_history_v1: {
            kind: "application",
            // This exact opaque prefix lets a later root read suppress only
            // the broker-injected context item. The real user input remains
            // in its independent `input` item and is never text-matched.
            value: handoffContextMarker ? `${handoffContextMarker}\n${context.text}` : context.text,
          },
        },
      } };
      this.canonicalHistory.addSegment({
        conversationId: delivery.conversationId,
        opaqueAccountId: delivery.toOpaqueAccountId,
        nativeThreadId: targetThreadId,
        ownerRendererRef: held.client.rendererRef,
        ownerLabel: this.clientLabel(held.client),
      });
      targetTaskRef = this.ensureTask(held.client, delivery.toOpaqueAccountId, targetThreadId);
      if (!targetTaskRef) throw new Error("target task binding rejected");
      targetBalanceReservation = this.reserveBalancedTurn(delivery.toOpaqueAccountId, targetThreadId, turnRequest.params);
      const logicalTurnId = this.canonicalHistory.beginTurn(
        delivery.conversationId,
        delivery.toOpaqueAccountId,
        targetThreadId,
        held.client.rendererRef,
        this.clientLabel(held.client),
        { input: input.input },
      );
      this.canonicalHistory.markTurnDispatching(delivery.conversationId, delivery.toOpaqueAccountId, targetThreadId);
      this.publishConversation(delivery.conversationId);
      if (!this.broker.beginRun(targetTaskRef)) throw new Error("target run rejected");
      this.addPendingDesktop(childId, {
        client: held.client,
        desktopId: held.desktopId,
        account: delivery.toOpaqueAccountId,
        taskRef: targetTaskRef,
        method: "turn/start",
        conversationId: delivery.conversationId,
        logicalTurnId,
        balanceReservationId: targetBalanceReservation?.reservationId ?? null,
      });
      held.forwardChildId = childId;
      if (held.automaticCapacityRefreshKey) this.automaticCapacityRefreshByChild.set(childId, held.automaticCapacityRefreshKey);
      try {
        if (this.nativeHistory && !this.nativeHistoryWritersSafe()) throw new Error("native history writer conflict");
        if (targetBalanceReservation) {
          this.tokenBalance.markDispatched(targetBalanceReservation.reservationId);
          targetBalanceDispatched = true;
        }
        child.send(turnRequest);
      } catch {
        this.removePendingDesktop(childId);
        if (!targetBalanceDispatched) this.releasePreDispatchBalance(targetBalanceReservation, targetThreadId);
        return "ambiguous";
      }
      this.store.update((state) => {
        const handoffs = state.pendingHandoffs ?? {};
        const receipt = handoffs[delivery.handoffRef];
        if (!receipt || receipt.state !== "forwarding") throw new Error("handoff forwarding receipt changed");
        delete handoffs[delivery.handoffRef];
      });
      this.heldDesktopContinuations.delete(delivery.handoffRef);
      // The completion response and streaming/tools remain origin-targeted by
      // `pendingDesktop`; confirmation itself never waits for a tool approval.
      return "delivered";
    } catch {
      if (targetTaskRef) this.broker.finishRun(targetTaskRef);
      if (!targetBalanceDispatched) this.releasePreDispatchBalance(targetBalanceReservation, targetThreadId);
      try {
        this.canonicalHistory.markAmbiguous(delivery.conversationId, delivery.toOpaqueAccountId, targetThreadId);
        this.publishConversation(delivery.conversationId);
      } catch { /* preserving ambiguous state is best effort after a failed write */ }
      return "ambiguous";
    }
  }

  private sendDesktop(client: AppClient, message: JsonRpcMessage): void {
    if (!client.socket.writable) return;
    if (!writeAppFrame(client.socket, { version: 1, kind: "message", message }, ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES)) client.socket.destroy();
  }
}

export class BrokerProcessChild implements BrokerChildV1 {
  readonly remoteControlDisabled = true as const;
  private lines: ReturnType<typeof createInterface> | null = null;
  private expectedTermination = false;
  private transportFailed = false;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private initialization: Promise<boolean> | null = null;
  private settleInitialization: ((ready: boolean) => void) | null = null;
  private initializationTimer: ReturnType<typeof setTimeout> | null = null;
  private initializationFingerprint: string | null = null;
  private initializedResult: unknown;
  private initializedReady = false;
  initializationClient: AppClient | null = null;
  private protocolReady = false;
  private readonly privateRequests = new Map<string, { resolve: (value: JsonRpcResponse | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly initializeId = `abi:${randomBytes(16).toString("hex")}`;

  constructor(
    readonly opaqueAccountId: OpaqueAccountId,
    private readonly child: ChildProcess,
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onClose: (expectedTermination: boolean) => void,
    private readonly authenticate?: (child: BrokerProcessChild) => Promise<boolean>,
  ) {
    if (!child.stdin || !child.stdout) throw new Error("accounts broker child lacks JSONL stdio");
    this.closedPromise = new Promise<void>((resolvePromise) => { this.resolveClosed = resolvePromise; });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const transportFailed = (): void => {
      if (this.transportFailed || this.closed) return;
      this.transportFailed = true;
      this.finishInitialization(false);
      this.lines?.close();
      this.lines = null;
      // Keep ownership until the process exits; a broken pipe is not proof
      // that the native history writer has stopped.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    child.stdin.on("error", transportFailed);
    child.stdout.on("error", transportFailed);
    this.lines.on("error", transportFailed);
    this.lines.on("line", (line) => {
      const message = parseJsonRpcLine(line);
      if (message && isResponse(message) && typeof message.id === "string" && this.privateRequests.has(message.id)) {
        const pending = this.privateRequests.get(message.id)!; this.privateRequests.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); return;
      }
      if (message && isResponse(message) && message.id === this.initializeId) {
        if (!this.settleInitialization) return;
        if (message.error) { this.finishInitialization(false); this.terminate("capacity"); return; }
        this.initializedResult = message.result;
        this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
        this.protocolReady = true;
        if (this.authenticate) void this.authenticate(this).then((ready) => {
          if (!ready || this.closed || this.transportFailed || this.expectedTermination) { this.finishInitialization(false); this.terminate("capacity"); }
          else this.finishInitialization(true);
        }).catch(() => { this.finishInitialization(false); this.terminate("capacity"); });
        else this.finishInitialization(true);
      } else if (message) { if (!this.authenticate || this.ready || isRequest(message)) this.onMessage(message); }
      else this.terminate("capacity");
    });
    const closed = (): void => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.privateRequests.values()) { clearTimeout(pending.timer); pending.resolve(null); }
      this.privateRequests.clear();
      this.finishInitialization(false);
      this.resolveClosed();
      this.onClose(this.expectedTermination && !this.transportFailed);
    };
    child.on("error", () => {
      // Failed spawn has no writer. Failed signalling of an existing child
      // must not release its history ownership before the exit event.
      if (child.pid === undefined) closed();
      else transportFailed();
    });
    child.once("exit", closed);
  }

  /** The owner records only direct source children; census expands this tree itself. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  get ready(): boolean { return this.initializedReady && !this.closed && !this.transportFailed && !this.expectedTermination; }
  get initializeResult(): unknown { return this.initializedResult; }

  initialize(params: Record<string, unknown>, client: AppClient): Promise<boolean> {
    if (this.closed || this.transportFailed || this.expectedTermination) return Promise.resolve(false);
    const fingerprint = JSON.stringify(params);
    if (this.initializationFingerprint !== null && this.initializationFingerprint !== fingerprint) return Promise.resolve(false);
    // Readiness is current transport state, not the historical handshake result.
    if (this.initialization) return this.initialization.then((ready) => ready && this.ready);
    this.initializationFingerprint = fingerprint;
    this.initializationClient = client;
    this.initialization = new Promise<boolean>((resolvePromise) => { this.settleInitialization = resolvePromise; });
    this.initializationTimer = setTimeout(() => { this.finishInitialization(false); this.terminate("capacity"); }, this.authenticate ? 30_000 : 5_000);
    this.initializationTimer.unref();
    try { this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: this.initializeId, method: "initialize", params })}\n`); }
    catch { this.finishInitialization(false); this.terminate("capacity"); }
    return this.initialization;
  }

  /** Owner-private bootstrap RPCs; never routed through renderer correlation. */
  requestPrivate(method: string, params: unknown, timeoutMs = 10_000): Promise<JsonRpcResponse | null> {
    if (!this.protocolReady || this.closed || this.transportFailed || this.expectedTermination || this.privateRequests.size >= 8) return Promise.resolve(null);
    const id = `auth:${randomBytes(16).toString("hex")}`;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => { this.privateRequests.delete(id); resolvePromise(null); }, timeoutMs);
      timer.unref(); this.privateRequests.set(id, { resolve: resolvePromise, timer });
      try { this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch { clearTimeout(timer); this.privateRequests.delete(id); resolvePromise(null); }
    });
  }

  private finishInitialization(ready: boolean): void {
    if (this.initializationTimer) clearTimeout(this.initializationTimer);
    this.initializationTimer = null;
    const settle = this.settleInitialization;
    this.settleInitialization = null;
    if (settle) { this.initializedReady = ready; settle(ready); }
  }

  send(message: JsonRpcMessage): void {
    if (this.closed || this.transportFailed || this.expectedTermination || !this.child.stdin || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("accounts broker child is unavailable");
    if (!isResponse(message) && !this.ready) throw new Error("accounts broker child is not initialized");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  terminate(_reason: "idle" | "shutdown" | "capacity" | "disabled"): void {
    this.expectedTermination = true;
    this.finishInitialization(false);
    this.lines?.close();
    this.lines = null;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  async terminateAndWait(): Promise<boolean> {
    this.terminate("capacity");
    if (this.closed) return true;
    const force = setTimeout(() => { if (!this.closed) this.child.kill("SIGKILL"); }, 1_000);
    const result = await Promise.race([this.closedPromise.then(() => true), new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 3_000); this.closedPromise.then(() => clearTimeout(timer));
    })]);
    clearTimeout(force); return result;
  }

  whenClosed(): Promise<void> {
    return this.closedPromise;
  }
}

/** Owner command environment: account-local homes plus a forced disable bit. */
export function brokerChildEnvironment(codexHome: string, sqliteHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (typeof source[key] === "string") environment[key] = source[key];
  return {
    ...environment,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: sqliteHome,
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
  };
}

/** Daemon entrypoint. A live socket means another owner won election; exit cleanly. */
export async function runAccountsBrokerOwnerCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseOwnerArguments(argv);
  if (!parsed) {
    process.exitCode = 1;
    return;
  }
  const selection = readRouterLaunchSelection(parsed.configPath);
  if (selection.mode !== "mux" || !selection.config || selection.config.schemaVersion !== 3 || !preflightRouterHomes(selection.config, parsed.stateRoot)) {
    process.exitCode = 1;
    return;
  }
  const secret = readAccountsBrokerSecret(parsed.stateRoot);
  if (!secret) {
    process.exitCode = 1;
    return;
  }
  installBrokerTerminationDiagnostics(parsed.stateRoot);
  const owner = new AccountsBrokerOwnerV1(selection.config, parsed.stateRoot, secret, parsed.command, parsed.args,
    { onStartupStage: createBrokerStartupDiagnostics(parsed.stateRoot) });
  try {
    await owner.start();
  } catch {
    secret.fill(0);
    // An already-live owner is expected during a cross-app race. The client
    // performs a bounded reconnect; this process must not remove its socket.
    return;
  }
  const shutdown = (): void => { void owner.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** One bounded owner-private startup record; only enumerated codes and timing. */
export function createBrokerStartupDiagnostics(root: string): (event: AccountsBrokerStartupEvent) => void {
  const identity = lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid?.()
    || (identity.mode & 0o077) !== 0) throw new Error("invalid broker diagnostics root");
  const file = `broker-startup-${process.pid}-${randomBytes(8).toString("hex")}.json`;
  const events: AccountsBrokerStartupEvent[] = [];
  return (event) => {
    try {
      if (events.length >= 16 || !["election", "probe", "recovery", "connect"].includes(event.stage)
        || !["started", "ready", "unavailable", "failed", "invalid_probe_input", "spawn_failed", "initialize_failed",
          "paginated_history_missing", "writer_lock_missing", "probe_timeout", "probe_failed"].includes(event.code)
        || !Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0 || event.elapsedMs > 600_000) return;
      const current = lstatSync(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
        || current.uid !== identity.uid || (current.mode & 0o077) !== 0) return;
      events.push({ stage: event.stage, code: event.code, elapsedMs: event.elapsedMs });
      writePrivateJsonAtomic(root, file, { version: 1, pid: process.pid, events });
    } catch { /* Diagnostics must not mask or replace a startup failure. */ }
  };
}

/** Observe fatal exits without changing Node's termination or replay behavior. */
export function installBrokerTerminationDiagnostics(root: string): void {
  const identity = lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid?.()
    || (identity.mode & 0o077) !== 0) throw new Error("invalid broker diagnostics root");
  const path = join(root, `broker-termination-${process.pid}-${randomBytes(8).toString("hex")}.json`);
  const record = (kind: "uncaught_exception" | "exit", exitCode: number, error?: Error): void => {
    try {
      const current = lstatSync(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev
        || current.ino !== identity.ino || current.uid !== identity.uid || (current.mode & 0o077) !== 0) return;
      // Error messages and arbitrary stack content can contain account data.
      // Retain only bounded source locations in our account-router modules.
      const modules = new Set(["broker-host", "broker", "broker-socket", "state-store", "native-history", "native-transfer",
        "account-continuity", "canonical-history", "native-projects", "native-legacy-projects", "remote-controller",
        "preferences", "quota", "pooled-quota", "profile-statistics", "token-balance", "ledger", "config",
        "app-server-mux", "history-adoption", "native-history-extensions"]);
      const locations: { module: string; line: number; column: number }[] = [];
      for (const frame of (error?.stack ?? "").slice(0, 32_768).split("\n").slice(1, 65)) {
        if (!/^\s+at /.test(frame)) continue;
        const match = /\/account-router\/([a-z-]{1,64})\.(?:js|ts):(\d{1,7}):(\d{1,7})\)?$/.exec(frame);
        if (match && modules.has(match[1]!)) locations.push({ module: match[1]!, line: Number(match[2]), column: Number(match[3]) });
        if (locations.length === 16) break;
      }
      const errorName = error && ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"].includes(error.name) ? error.name : null;
      writeFileSync(path, JSON.stringify({ version: 1, observedAt: new Date().toISOString(), pid: process.pid,
        kind, exitCode, errorName, locations }) + "\n", { mode: 0o600, flag: "wx" });
    } catch { /* Diagnostics must never mask or replace the original failure. */ }
  };
  process.once("uncaughtExceptionMonitor", (error) => record("uncaught_exception", 1, error));
  process.once("exit", (code) => record("exit", code));
}

interface AppHandshakeFrame {
  version: 1;
  kind: "handshake";
  handshake: BrokerHandshakeV1;
}

interface AppMessageFrame {
  version: 1;
  kind: "message";
  message: JsonRpcMessage;
}

type AppServerWireFrame =
  | AppHandshakeFrame
  | AppMessageFrame
  | { version: 1; kind: "handshake"; ok: boolean };

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
export async function connectAccountsBrokerAppServerClient(
  options: AccountsBrokerAppServerClientOptions,
  onMessage: (message: JsonRpcMessage) => void,
): Promise<AccountsBrokerAppServerConnection> {
  const path = accountsBrokerSocketPath(options.root, ACCOUNTS_BROKER_APP_SERVER_SOCKET_FILE);
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    let buffered = "";
    let bytes = 0;
    let settled = false;
    let resolveClosed!: () => void;
    const whenClosed = new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise; });
    const settle = (value?: AccountsBrokerAppServerConnection, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolvePromise(value!);
    };
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
      ? Math.min(5_000, options.timeoutMs!) : 5_000;
    const timeout = setTimeout(() => socket.destroy(), timeoutMs);
    timeout.unref();
    socket.once("error", () => settle(undefined, new Error("accounts broker app server unavailable")));
    socket.once("close", () => {
      resolveClosed();
      clearTimeout(timeout);
      if (!settled) settle(undefined, new Error("accounts broker app server unavailable"));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES * 2) { socket.destroy(); return; }
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        bytes = Buffer.byteLength(buffered, "utf8");
        if (Buffer.byteLength(line, "utf8") > ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES) { socket.destroy(); return; }
        let frame: unknown;
        try { frame = JSON.parse(line) as unknown; } catch { socket.destroy(); return; }
        if (isAppHandshakeResult(frame)) {
          if (!frame.ok) { socket.destroy(); return; }
          clearTimeout(timeout);
          settle({
            send: (message) => writeAppFrame(socket, { version: 1, kind: "message", message }, ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES),
            close: () => socket.destroy(),
            whenClosed,
          });
          continue;
        }
        if (isAppMessage(frame)) onMessage(frame.message);
        else { socket.destroy(); return; }
      }
    });
    socket.once("connect", () => {
      const unsigned = {
        version: 1 as const,
        clientKind: options.clientKind,
        rendererRef: options.rendererRef,
        appToolsRef: options.appToolsRef,
        nonce: randomBytes(24).toString("base64url"),
      };
      const handshake: BrokerHandshakeV1 = { ...unsigned, proof: createBrokerHandshakeProof(options.secret, unsigned) };
      if (!writeAppFrame(socket, { version: 1, kind: "handshake", handshake }, ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES)) socket.destroy();
    });
  });
}

export function createBrokerAppRendererRef(secret: Buffer): OpaqueRendererRef {
  return `br_${createHmac("sha256", secret).update(`app-server-renderer:v1:${randomBytes(24).toString("base64url")}`, "utf8").digest("base64url")}` as OpaqueRendererRef;
}

export function createBrokerAppToolsRef(secret: Buffer): OpaqueAppToolsRef {
  return `bat_${createHmac("sha256", secret).update(`app-server-tools:v1:${randomBytes(24).toString("base64url")}`, "utf8").digest("base64url")}` as OpaqueAppToolsRef;
}

function persistentHandoff(
  handoff: PendingHandoffV1,
  state: PersistentHandoffMetadataV1["state"],
): PersistentHandoffMetadataV1 {
  return {
    version: 1,
    handoffRef: handoff.handoffRef,
    confirmationId: handoff.confirmationId,
    conversationId: handoff.conversationId,
    taskRef: handoff.taskRef,
    originRendererRef: handoff.originRendererRef,
    fromOpaqueAccountId: handoff.fromOpaqueAccountId,
    toOpaqueAccountId: handoff.toOpaqueAccountId,
    state,
    expiresAt: handoff.expiresAt,
  };
}

/**
 * Minimal broker-host adaptation of the mux aggregate reader. Provider cursors
 * never cross account homes; this first-page merge deliberately terminates
 * cursors rather than leaking a child cursor through the shared surface.
 */
function mergeHistoryResponses(
  method: string,
  responses: ReadonlyArray<{ account: OpaqueAccountId; response: JsonRpcResponse }>,
  bindOwner: (threadId: string, account: OpaqueAccountId) => boolean,
  ownerForThread: (threadId: string) => OpaqueAccountId | null,
  bindSection: (account: OpaqueAccountId, localId: string) => string | null,
  rejectAmbiguousOwners = false,
  includeThread: ((account: OpaqueAccountId, threadId: string) => boolean) | undefined = undefined,
): Record<string, unknown> | null {
  if (!HISTORY_READ_METHODS.has(method) || responses.length === 0) return null;
  const first = responses[0].response.result;
  if (!isPlainRecord(first)) return null;
  const sectionRows: unknown[] = [];
  const candidates = new Map<string, Array<{ account: OpaqueAccountId; entry: unknown }>>();
  for (const { account, response } of responses) {
    if (response.error || !isPlainRecord(response.result) || !Array.isArray(response.result.data)) return null;
    if (response.result.data.length > 512) return null;
    for (const entry of response.result.data) {
      if (method === "threadSection/list") {
        if (!isPlainRecord(entry) || typeof entry.id !== "string" || entry.id.length < 1 || entry.id.length > 512) return null;
        const id = bindSection(account, entry.id);
        if (!id) return null;
        sectionRows.push({ ...entry, id });
        continue;
      }
      const threadId = historyThreadId(method, entry);
      if (!threadId) return null;
      if (includeThread && !includeThread(account, threadId)) continue;
      const values = candidates.get(threadId) ?? [];
      values.push({ account, entry });
      candidates.set(threadId, values);
    }
  }
  if (method === "threadSection/list") {
    if (sectionRows.length > 512) return null;
    sectionRows.sort((left, right) => historyEntrySort(method, left, "", right, ""));
    const result: Record<string, unknown> = { ...first, data: sectionRows, nextCursor: null };
    if (Object.prototype.hasOwnProperty.call(first, "backwardsCursor")) result.backwardsCursor = null;
    return result;
  }
  const rows: Array<{ threadId: string; entry: unknown }> = [];
  for (const [threadId, values] of candidates) {
    const durableOwner = ownerForThread(threadId);
    if (rejectAmbiguousOwners && values.length !== 1) return null;
    const selected = durableOwner
      ? values.find((candidate) => candidate.account === durableOwner) ?? null
      : [...values].sort((left, right) => left.account.localeCompare(right.account))[0] ?? null;
    // A durable owner with no row in its own home is a malformed cross-home
    // collision. Do not substitute another home and risk changing ownership.
    if (!selected || !bindOwner(threadId, selected.account)) {
      if (rejectAmbiguousOwners) return null;
      continue;
    }
    rows.push({ threadId, entry: selected.entry });
    if (rows.length > 512) return null;
  }
  rows.sort((left, right) => historyEntrySort(method, left.entry, left.threadId, right.entry, right.threadId));
  const result: Record<string, unknown> = { ...first, data: rows.map((row) => row.entry), nextCursor: null };
  if (Object.prototype.hasOwnProperty.call(first, "backwardsCursor")) result.backwardsCursor = null;
  return result;
}

/** Native lists are newest-first; search additionally honors a validated
 * relevance score. The final opaque thread-id tie-breaker is deterministic
 * across account configuration order and desktop clients. */
function historyEntrySort(method: string, left: unknown, leftId: string, right: unknown, rightId: string): number {
  if (method === "thread/search") {
    const score = (value: unknown): number | null => isPlainRecord(value) && typeof value.score === "number" && Number.isFinite(value.score) ? value.score : null;
    const leftScore = score(left);
    const rightScore = score(right);
    if (leftScore !== null && rightScore !== null && leftScore !== rightScore) return rightScore - leftScore;
  }
  const timestamp = (value: unknown): number => {
    const record = isPlainRecord(value) && method === "thread/search" && isPlainRecord(value.thread) ? value.thread : value;
    if (!isPlainRecord(record)) return 0;
    const raw = typeof record.updatedAt === "string" ? record.updatedAt : typeof record.createdAt === "string" ? record.createdAt : null;
    const parsed = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const leftTime = timestamp(left);
  const rightTime = timestamp(right);
  return rightTime - leftTime || leftId.localeCompare(rightId);
}

/** Remove a broker-owned public cursor before a child sees the request. */
function historyBaseParams(value: unknown): { params: unknown; publicCursor: string | null } | null {
  // Normalize omitted and empty-object parameters so a next-page request
  // containing only the broker cursor fingerprints the same logical query.
  if (value === undefined) return { params: {}, publicCursor: null };
  if (!isPlainRecord(value)) return { params: value, publicCursor: null };
  if (!Object.prototype.hasOwnProperty.call(value, "cursor")) return { params: value, publicCursor: null };
  const cursor = value.cursor;
  if (cursor === null) {
    const { cursor: _cursor, ...params } = value;
    return { params, publicCursor: null };
  }
  if (typeof cursor !== "string" || !/^hc_[A-Za-z0-9_-]{16,128}$/.test(cursor)) return null;
  const { cursor: _cursor, ...params } = value;
  return { params, publicCursor: cursor };
}

/** Native merged history has an owner-private cursor namespace of its own. */
function nativeMergedBaseParams(value: unknown): { params: Record<string, unknown>; publicCursor: string | null } | null {
  if (!isPlainRecord(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "cursor")) return { params: { ...value }, publicCursor: null };
  const cursor = value.cursor;
  if (cursor === null) {
    const { cursor: _cursor, ...params } = value;
    return { params, publicCursor: null };
  }
  if (typeof cursor !== "string" || !/^nmc_[A-Za-z0-9_-]{16,128}$/.test(cursor)) return null;
  const { cursor: _cursor, ...params } = value;
  return { params, publicCursor: cursor };
}

function nativeThreadReadOmitsTurns(value: unknown): boolean {
  return isPlainRecord(value) && value.includeTurns === false;
}

function historyRequestForAccount(request: JsonRpcRequest, providerCursor: string | null): JsonRpcRequest | null {
  const base = historyBaseParams(request.params);
  if (!base) return null;
  if (providerCursor === null) return base.publicCursor === null ? { ...request, params: base.params } : null;
  if (providerCursor.length < 1 || providerCursor.length > 512 || /[\u0000-\u001f\u007f]/.test(providerCursor)) return null;
  const params = isPlainRecord(base.params) ? { ...base.params, cursor: providerCursor } : { cursor: providerCursor };
  return { ...request, params };
}

function historyQueryFingerprint(secret: Buffer, method: string, params: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(params) ?? "null"; } catch { serialized = "invalid"; }
  if (serialized.length > 32 * 1024) serialized = serialized.slice(0, 32 * 1024);
  return createHmac("sha256", secret).update(`history-query:v1:${method}:`, "utf8").update(serialized, "utf8").digest("base64url");
}

function providerHistoryCursor(result: unknown): string | null {
  if (!isPlainRecord(result) || typeof result.nextCursor !== "string") return null;
  return result.nextCursor.length > 0 && result.nextCursor.length <= 512 && !/[\u0000-\u001f\u007f]/.test(result.nextCursor)
    ? result.nextCursor : null;
}

function historyThreadId(method: string, value: unknown): string | null {
  if (method === "thread/loaded/list") return safeHistoryIdentifier(value);
  if (!isPlainRecord(value)) return null;
  if (method === "thread/search") return isPlainRecord(value.thread) ? safeHistoryIdentifier(value.thread.id) : null;
  return safeHistoryIdentifier(value.id) ?? safeHistoryIdentifier(threadIdFrom(value));
}

function safeHistoryIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/**
 * Only cache a content-free root history read. Search terms and provider
 * cursors never become cache keys, so ordinary refreshes avoid repeated
 * >2-account child churn without retaining renderer request content.
 */
function historyCacheKey(request: JsonRpcRequest, account: OpaqueAccountId): string | null {
  if (request.method !== "thread/list" || !emptyHistoryParams(request.params)) return null;
  return `${account}\u0000thread/list`;
}

function emptyHistoryParams(value: unknown): boolean {
  return value === undefined || (isPlainRecord(value) && Object.keys(value).length === 0);
}

function withThreadId(request: JsonRpcRequest, nativeThreadId: string): JsonRpcRequest {
  if (!isPlainRecord(request.params)) return request;
  if (typeof request.params.threadId === "string") return { ...request, params: { ...request.params, threadId: nativeThreadId } };
  if (typeof request.params.thread_id === "string") return { ...request, params: { ...request.params, thread_id: nativeThreadId } };
  return request;
}

function withProjectId(request: JsonRpcRequest, nativeProjectId: string): JsonRpcRequest {
  if (!isPlainRecord(request.params)) return request;
  return { ...request, params: { ...request.params, projectId: nativeProjectId } };
}

type NativeProjectReference = { state: "absent" } | { state: "invalid" } | { state: "value"; projectId: string };

function nativeThreadStartProjectId(params: unknown): NativeProjectReference {
  return nativeProjectReference(params);
}

function nativeThreadListProjectId(params: unknown): NativeProjectReference {
  return nativeProjectReference(params);
}

function nativeLegacyProjectListInput(
  params: unknown,
  expectedProjectId: string,
): { params: Record<string, unknown>; cursor: string | null; limit: number } | null {
  if (!isPlainRecord(params) || params.projectId !== expectedProjectId) return null;
  const cursor = params.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !/^nlp_[A-Za-z0-9_-]{16,128}$/.test(cursor))) return null;
  const rawLimit = params.limit;
  if (rawLimit !== undefined && rawLimit !== null && (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 256)) return null;
  const { cursor: _cursor, ...withoutCursor } = params;
  return { params: withoutCursor, cursor: typeof cursor === "string" ? cursor : null, limit: typeof rawLimit === "number" ? rawLimit : 100 };
}

function nativeProjectReference(params: unknown): NativeProjectReference {
  if (!isPlainRecord(params) || !Object.prototype.hasOwnProperty.call(params, "projectId") || params.projectId === null || params.projectId === undefined) {
    return { state: "absent" };
  }
  return validNativeProjectId(params.projectId) ? { state: "value", projectId: params.projectId } : { state: "invalid" };
}

function validNativeProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function nativeProjectWriteMethod(method: string): boolean {
  return method !== "project/list" && method !== "project/read";
}

function nativeThreadReadMatches(value: unknown, expectedThreadId: string): boolean {
  return isPlainRecord(value) && isPlainRecord(value.thread) && value.thread.id === expectedThreadId;
}

/** Exact metadata read for an old assignment; native non-null project wins. */
function nativeLegacyThreadListRow(
  value: unknown,
  expectedThreadId: string,
  publicProjectId: string,
  visible: (threadId: string) => boolean,
): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.thread) || value.thread.id !== expectedThreadId || value.thread.projectId !== null || !visible(expectedThreadId)) return null;
  return { ...value.thread, projectId: publicProjectId };
}

function nativeNonNullProjectListRow(value: unknown, expectedProjectId: string, visible: (threadId: string) => boolean): value is Record<string, unknown> {
  return isPlainRecord(value) && typeof value.id === "string" && value.projectId === expectedProjectId && visible(value.id);
}

function nativeThreadNotFound(response: JsonRpcResponse, expectedThreadId: string): boolean {
  const error = response.error;
  if (!error) return false;
  if (error.code === 404) return true;
  // The inspected native app-server returns this exact invalid-request error
  // for an absent ID. Bind the message to the ID we actually probed; busy,
  // unloaded, malformed, and unrelated failures remain unavailable.
  if (error.code === -32600 && error.message === `no rollout found for thread id ${expectedThreadId}`) return true;
  const dataCode = isPlainRecord(error.data) && typeof error.data.code === "string" ? error.data.code : null;
  return dataCode === "thread_not_found" || dataCode === "unknown_thread_owner" || dataCode === "not_found";
}

/** Rewrites only known thread/project response envelopes; tool/item payloads stay untouched. */
function rewriteResponseProjectIds(
  value: Record<string, unknown>,
  publicId: (nativeProjectId: string) => string | null,
): Record<string, unknown> {
  return rewriteProjectEnvelope(value, publicId, 0);
}

function rewriteProjectEnvelope(
  value: Record<string, unknown>,
  publicId: (nativeProjectId: string) => string | null,
  depth: number,
): Record<string, unknown> {
  if (depth > 4) return value;
  let changed = false;
  const output: Record<string, unknown> = { ...value };
  if (typeof value.projectId === "string") {
    const mapped = publicId(value.projectId);
    if (mapped && mapped !== value.projectId) { output.projectId = mapped; changed = true; }
  }
  if (isPlainRecord(value.thread)) {
    const thread = rewriteProjectEnvelope(value.thread, publicId, depth + 1);
    if (thread !== value.thread) { output.thread = thread; changed = true; }
  }
  if (isPlainRecord(value.project)) {
    const project = { ...value.project };
    if (typeof project.id === "string") {
      const mapped = publicId(project.id);
      if (mapped && mapped !== project.id) { project.id = mapped; changed = true; }
    }
    if (changed) output.project = project;
  }
  if (Array.isArray(value.data) && value.data.length <= 512) {
    const sourceData = value.data;
    const data = sourceData.map((entry) => isPlainRecord(entry) ? rewriteProjectEnvelope(entry, publicId, depth + 1) : entry);
    if (data.some((entry, index) => entry !== sourceData[index])) { output.data = data; changed = true; }
  }
  return changed ? output : value;
}

/**
 * Older source threads can have a null SQLite project id while their signed
 * local metadata still establishes membership. Native non-null ids always
 * win; this is a read-only response projection.
 */
function rewriteLegacyProjectEnvelope(
  value: Record<string, unknown>,
  publicProjectForThread: (nativeThreadId: string) => string | null,
  depth = 0,
): Record<string, unknown> {
  if (depth > 4) return value;
  let changed = false;
  let output: Record<string, unknown> = value;
  if (typeof value.id === "string" && value.projectId === null) {
    const projectId = publicProjectForThread(value.id);
    if (projectId) { output = { ...output, projectId }; changed = true; }
  }
  if (isPlainRecord(value.thread)) {
    const thread = rewriteLegacyProjectEnvelope(value.thread, publicProjectForThread, depth + 1);
    if (thread !== value.thread) {
      if (!changed) output = { ...output };
      output.thread = thread;
      changed = true;
    }
  }
  if (Array.isArray(value.data) && value.data.length <= 16_384) {
    const sourceData = value.data;
    const data = sourceData.map((entry) => isPlainRecord(entry) ? rewriteLegacyProjectEnvelope(entry, publicProjectForThread, depth + 1) : entry);
    if (data.some((entry, index) => entry !== sourceData[index])) {
      if (!changed) output = { ...output };
      output.data = data;
      changed = true;
    }
  }
  return output;
}

function nativeProjectChangedId(params: unknown): string | null {
  if (!isPlainRecord(params)) return null;
  if (validNativeProjectId(params.projectId)) return params.projectId;
  return isPlainRecord(params.project) && validNativeProjectId(params.project.id) ? params.project.id : null;
}

function nativeThreadProjectUpdate(params: unknown): { threadId: string; projectId: string | null } | null {
  if (!isPlainRecord(params) || !validNativeTargetId(params.threadId) || !(params.projectId === null || validNativeProjectId(params.projectId))) return null;
  return { threadId: params.threadId, projectId: params.projectId };
}

/** Stable raw native thread shape used only for transient in-memory merging. */
function nativeThreadSnapshot(value: unknown, expectedThreadId: string): NativeThreadSnapshot | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.thread) || value.thread.id !== expectedThreadId || !Array.isArray(value.thread.turns)
  ) return null;
  const turns: Record<string, unknown>[] = [];
  for (const turn of value.thread.turns) {
    if (!isPlainRecord(turn) || !validNativeTargetId(turn.id) || !Array.isArray(turn.items)) return null;
    if (turn.items.some((item) => !isPlainRecord(item) || !validNativeTargetId(item.id))) return null;
    turns.push(turn);
  }
  return { thread: value.thread, turns };
}

/** Remove only the independently stored broker context item, never user text. */
function nativeVisibleHistoryTurn(turn: Record<string, unknown>, marker: string | undefined): Record<string, unknown> {
  if (!marker || !Array.isArray(turn.items)) return turn;
  const items = turn.items.filter((item) => !isExactNativeHandoffContextItem(item, marker));
  return items.length === turn.items.length ? turn : { ...turn, items };
}

function isExactNativeHandoffContextItem(item: unknown, marker: string): boolean {
  if (!isPlainRecord(item) || item.type !== "userMessage" || !Array.isArray(item.content) || item.content.length !== 1) return false;
  const content = item.content[0];
  // The broker writes context as one application fragment. A desktop user's
  // actual request is a separate input item; requiring this exact marker and
  // the fixed continuation header avoids content/title/time heuristics.
  return isPlainRecord(content) && content.type === "text" && typeof content.text === "string"
    && content.text.startsWith(`${marker}\nNative account history continuation.`);
}

function combinedNativeHistoryResult(
  method: string,
  params: unknown,
  rootThreadId: string,
  snapshots: readonly NativeThreadSnapshot[],
  offset: number,
  maxResultBytes: number,
): { result: Record<string, unknown>; nextOffset: number | null } | null {
  const root = snapshots[0];
  if (!root || snapshots.length > 64 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1024) return null;
  const turns = snapshots.flatMap((snapshot) => snapshot.turns.map((turn) => nativeVisibleHistoryTurn(turn, snapshot.handoffContextMarker)));
  const identities = new Set<string>();
  for (const turn of turns) {
    const turnId = turn.id;
    if (!validNativeTargetId(turnId) || identities.has(turnId)) return null;
    identities.add(turnId);
    const turnItems = turn.items;
    if (!Array.isArray(turnItems)) return null;
    for (const item of turnItems) {
      if (!isPlainRecord(item) || !validNativeTargetId(item.id) || identities.has(item.id)) return null;
      identities.add(item.id);
    }
  }
  if (method === "thread/read") {
    if (!isPlainRecord(params) || (params.includeTurns !== undefined && typeof params.includeTurns !== "boolean")) return null;
    // Native protocol defaults omitted itemsView/includeTurns to its complete
    // view.  Only an explicit false is the cheap root-metadata projection.
    const includeTurns = params.includeTurns !== false;
    const result = { thread: { ...root.thread, id: rootThreadId, turns: includeTurns ? turns : [] } };
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= maxResultBytes ? { result, nextOffset: null } : null;
  }
  const paging = nativeCombinedPaging(params);
  if (!paging) return null;
  const ordered = paging.sortDirection === "desc" ? [...turns].reverse() : turns;
  if (method === "thread/turns/list") return nativeMergedPage(ordered, paging.limit, offset, maxResultBytes);
  if (method === "thread/items/list") {
    const selected = paging.turnId === null ? ordered : ordered.filter((turn) => turn.id === paging.turnId);
    if (paging.turnId !== null && selected.length !== 1) return null;
    const data = selected.flatMap((turn) => Array.isArray(turn.items)
      ? turn.items.map((item) => ({ turnId: turn.id, item }))
      : []);
    return nativeMergedPage(data, paging.limit, offset, maxResultBytes);
  }
  return null;
}

/**
 * Fit an actual visible page into the app bridge frame.  The opaque cursor is
 * a fixed-size placeholder here; the owner replaces it with its signed
 * in-memory cursor after the page is assembled.
 */
function nativeMergedPage(data: readonly unknown[], limit: number, offset: number, maxResultBytes: number): { result: Record<string, unknown>; nextOffset: number | null } | null {
  if (offset > data.length) return null;
  const end = Math.min(data.length, offset + limit);
  const page: unknown[] = [];
  for (let index = offset; index < end; index += 1) {
    page.push(data[index]);
    const hasMore = index + 1 < data.length;
    const candidate = { data: page, nextCursor: hasMore ? `nmc_${"x".repeat(64)}` : null };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxResultBytes) {
      page.pop();
      break;
    }
  }
  if (page.length === 0 && offset < data.length) return null;
  const nextOffset = offset + page.length < data.length ? offset + page.length : null;
  return { result: { data: page, nextCursor: null }, nextOffset };
}

function nativeCombinedPaging(params: unknown): { limit: number; sortDirection: "asc" | "desc"; turnId: string | null } | null {
  if (!isPlainRecord(params) || (params.cursor !== undefined && params.cursor !== null)
    || (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 256))
    || (params.sortDirection !== undefined && params.sortDirection !== "asc" && params.sortDirection !== "desc")
    || (params.turnId !== undefined && params.turnId !== null && !validNativeTargetId(params.turnId))) return null;
  return {
    limit: typeof params.limit === "number" ? params.limit : 256,
    sortDirection: params.sortDirection === "asc" ? "asc" : "desc",
    turnId: typeof params.turnId === "string" ? params.turnId : null,
  };
}

/** Replace provider thread identities in child responses before desktop I/O. */
function withResponseThreadId(response: JsonRpcResponse, publicThreadId: string): JsonRpcResponse {
  if (!isPlainRecord(response.result)) return response;
  const result = { ...response.result };
  if (typeof result.threadId === "string") result.threadId = publicThreadId;
  if (typeof result.thread_id === "string") result.thread_id = publicThreadId;
  if (isPlainRecord(result.thread) && typeof result.thread.id === "string") {
    result.thread = { ...result.thread, id: publicThreadId };
  }
  return { ...response, result };
}

/** Native mode deliberately preserves provider ids on the desktop wire. */
function withNativeResponseThreadId(response: JsonRpcResponse, nativeThreadId: string): JsonRpcResponse {
  if (!isPlainRecord(response.result)) return response;
  const result = { ...response.result };
  if (typeof result.threadId === "string") result.threadId = nativeThreadId;
  if (typeof result.thread_id === "string") result.thread_id = nativeThreadId;
  if (isPlainRecord(result.thread) && typeof result.thread.id === "string") {
    const thread: Record<string, unknown> = { ...result.thread, id: nativeThreadId };
    result.thread = thread;
  }
  return { ...response, result };
}

function withNotificationThreadId(notification: JsonRpcMessage, nativeThreadId: string): JsonRpcMessage {
  if (!isNotification(notification) || !isPlainRecord(notification.params)) return notification;
  const params = { ...notification.params };
  let changed = false;
  if (typeof params.threadId === "string") {
    params.threadId = nativeThreadId;
    changed = true;
  }
  // Official `thread/started` and a few lifecycle notifications carry the
  // thread in a nested Thread object rather than `params.threadId`.
  if (isPlainRecord(params.thread) && typeof params.thread.id === "string") {
    params.thread = { ...params.thread, id: nativeThreadId };
    changed = true;
  }
  return changed ? { ...notification, params } : notification;
}

function withNativeNotificationThreadId(notification: JsonRpcMessage, nativeThreadId: string): JsonRpcMessage {
  if (!isNotification(notification) || !isPlainRecord(notification.params)) return notification;
  const params = { ...notification.params };
  let changed = false;
  if (typeof params.threadId === "string") { params.threadId = nativeThreadId; changed = true; }
  if (isPlainRecord(params.thread) && typeof params.thread.id === "string") {
    const thread: Record<string, unknown> = { ...params.thread, id: nativeThreadId };
    params.thread = thread;
    changed = true;
  }
  return changed ? { ...notification, params } : notification;
}

type PortableTurnStartInputV1 =
  | { kind: "portable"; input: Array<{ type: "text" | "input_text"; text: string }> }
  | { kind: "nonportable" }
  | { kind: "invalid" };

/**
 * Retain only exact text input for a cross-subscription continuation. Any
 * attachment, media, unknown input form, or omitted request field is a known
 * continuity gap, not a value we may silently discard before target dispatch.
 */
function portableTurnStartInput(params: unknown): PortableTurnStartInputV1 {
  if (!isPlainRecord(params) || !Array.isArray(params.input) || params.input.length < 1 || params.input.length > 16) return { kind: "invalid" };
  const keys = Object.keys(params).sort();
  if (!keys.every((key) => key === "input" || key === "threadId") || typeof params.threadId !== "string" || !validNativeTargetId(params.threadId)) {
    return { kind: "nonportable" };
  }
  const input: Array<{ type: "text" | "input_text"; text: string }> = [];
  for (const entry of params.input) {
    if (!isPlainRecord(entry) || typeof entry.type !== "string") return { kind: "invalid" };
    if (entry.type !== "text" && entry.type !== "input_text") return { kind: "nonportable" };
    if (Object.keys(entry).sort().join("\0") !== ["text", "type"].join("\0")) return { kind: "nonportable" };
    if (typeof entry.text !== "string" || entry.text.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.text)) return { kind: "invalid" };
    input.push({ type: entry.type, text: entry.text });
  }
  return Buffer.byteLength(JSON.stringify(input), "utf8") <= 24 * 1024 ? { kind: "portable", input } : { kind: "invalid" };
}

function isNativeTargetMapRequest(value: unknown): value is NativeSharedHistoryMapRequestV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"].join("\0")
    && value.version === 1 && validNativeTargetId(value.conversationNativeId) && validNativeTargetId(value.composerNativeId)
    && Array.isArray(value.assistantTurnNativeIds) && value.assistantTurnNativeIds.length <= 128
    && value.assistantTurnNativeIds.every(validNativeTargetId);
}

function validNativeTargetId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalThreadProjection(
  conversation: Readonly<{ conversationId: OpaqueConversationId; publicThreadId: string; title: string; availability: string; createdAt: string; updatedAt: string; turns: ReadonlyArray<Readonly<{ turnId: OpaqueTurnId; items: readonly PortableTranscriptItemV1[] }>> }>,
  secret: Buffer,
  includeTurns: boolean,
): Record<string, unknown> {
  const turns = conversation.turns.map((turn) => canonicalTurnProjection(turn, secret));
  const createdAt = Math.floor(Date.parse(conversation.createdAt) / 1_000);
  const updatedAt = Math.floor(Date.parse(conversation.updatedAt) / 1_000);
  const preview = conversation.turns.flatMap((turn) => turn.items).find((item) => item.kind === "user")?.text ?? "";
  return {
    cliVersion: "shared-history-v1",
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    cwd: "/private/var/empty",
    ephemeral: false,
    id: conversation.publicThreadId,
    modelProvider: "openai",
    name: conversation.title,
    preview,
    projectId: null,
    sessionId: `session_${createHmac("sha256", secret).update(`renderer-session:v1:${conversation.conversationId}`, "utf8").digest("base64url")}`,
    source: "appServer",
    status: conversation.availability === "incomplete" ? { type: "active", activeFlags: [] } : { type: "idle" },
    // The generated schema requires this property in both list and read
    // responses.  Lists deliberately omit the portable transcript payload.
    turns: includeTurns ? turns : [],
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

interface CanonicalListOptionsV1 {
  limit: number | null;
  sortDirection: "asc" | "desc";
  searchTerm: string | null;
  empty: boolean;
}

function canonicalListOptions(value: unknown): CanonicalListOptionsV1 | null {
  if (value !== undefined && !isPlainRecord(value)) return null;
  const params = (value ?? {}) as Record<string, unknown>;
  const allowed = new Set(["ancestorThreadId", "archived", "cursor", "cwd", "limit", "modelProviders", "parentThreadId", "projectId", "searchTerm", "sectionId", "sortDirection", "sortKey", "sourceKinds", "useStateDbOnly"]);
  if (Object.keys(params).some((key) => !allowed.has(key))) return null;
  const base = canonicalPagingOptions(params);
  if (!base || !optionalSearchTerm(params.searchTerm) || (params.sortKey !== undefined && params.sortKey !== null && !["created_at", "updated_at", "recency_at", "section_position"].includes(String(params.sortKey)))
    || (params.archived !== undefined && params.archived !== null && typeof params.archived !== "boolean")
    || (params.useStateDbOnly !== undefined && typeof params.useStateDbOnly !== "boolean")
    || !nullableString(params.ancestorThreadId) || !nullableString(params.parentThreadId) || !nullableString(params.projectId) || !nullableString(params.sectionId)
    || !validCwdFilter(params.cwd) || !validStringArray(params.modelProviders) || !validStringArray(params.sourceKinds)) return null;
  if (typeof params.ancestorThreadId === "string" && typeof params.parentThreadId === "string") return null;
  const empty = params.archived === true
    || typeof params.ancestorThreadId === "string" || typeof params.parentThreadId === "string"
    || typeof params.projectId === "string" || typeof params.sectionId === "string"
    || !canonicalCwdMatch(params.cwd)
    || (Array.isArray(params.modelProviders) && params.modelProviders.length > 0 && !params.modelProviders.includes("openai"))
    || (Array.isArray(params.sourceKinds) && params.sourceKinds.length > 0 && !params.sourceKinds.includes("appServer"));
  return { ...base, searchTerm: typeof params.searchTerm === "string" ? params.searchTerm : null, empty };
}

function canonicalSearchOptions(value: unknown): CanonicalListOptionsV1 | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set(["archived", "cursor", "limit", "searchTerm", "sortDirection", "sortKey", "sourceKinds"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || typeof value.searchTerm !== "string" || !optionalSearchTerm(value.searchTerm)) return null;
  const base = canonicalPagingOptions(value);
  if (!base || (value.sortKey !== undefined && value.sortKey !== null && !["created_at", "updated_at", "recency_at"].includes(String(value.sortKey)))
    || (value.archived !== undefined && value.archived !== null && typeof value.archived !== "boolean") || !validStringArray(value.sourceKinds)) return null;
  return {
    ...base,
    searchTerm: value.searchTerm,
    empty: value.archived === true || (Array.isArray(value.sourceKinds) && value.sourceKinds.length > 0 && !value.sourceKinds.includes("appServer")),
  };
}

function canonicalPagingOptions(params: Record<string, unknown>): Pick<CanonicalListOptionsV1, "limit" | "sortDirection"> | null {
  if ((params.cursor !== undefined && params.cursor !== null) || !nullableLimit(params.limit)
    || (params.sortDirection !== undefined && params.sortDirection !== null && params.sortDirection !== "asc" && params.sortDirection !== "desc")) return null;
  return { limit: typeof params.limit === "number" ? params.limit : null, sortDirection: params.sortDirection === "asc" ? "asc" : "desc" };
}

function canonicalTurnsListParams(value: unknown): { threadId: string; limit: number | null; sortDirection: "asc" | "desc"; itemsView: "notLoaded" | "summary" | "full" } | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["cursor", "itemsView", "limit", "sortDirection", "threadId"].includes(key))
    || typeof value.threadId !== "string" || !canonicalPagingOptions(value)
    || (value.itemsView !== undefined && value.itemsView !== null && !["notLoaded", "summary", "full"].includes(String(value.itemsView)))) return null;
  const paging = canonicalPagingOptions(value)!;
  return { threadId: value.threadId, ...paging, itemsView: value.itemsView === "full" ? "full" : value.itemsView === "notLoaded" ? "notLoaded" : "summary" };
}

function canonicalItemsListParams(value: unknown): { threadId: string; turnId: string | null; limit: number | null; sortDirection: "asc" | "desc" } | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["cursor", "limit", "sortDirection", "threadId", "turnId"].includes(key))
    || typeof value.threadId !== "string" || !nullableString(value.turnId) || !canonicalPagingOptions(value)) return null;
  return { threadId: value.threadId, turnId: typeof value.turnId === "string" ? value.turnId : null, ...canonicalPagingOptions(value)! };
}

function canonicalListRows<T extends { title: string }>(rows: readonly T[], options: CanonicalListOptionsV1): T[] {
  if (options.empty) return [];
  const filtered = options.searchTerm === null ? [...rows] : rows.filter((row) => row.title.toLocaleLowerCase().includes(options.searchTerm!.toLocaleLowerCase()));
  if (options.sortDirection === "asc") filtered.reverse();
  return options.limit === null ? filtered : filtered.slice(0, options.limit);
}

function orderedLimited<T>(rows: readonly T[], sortDirection: "asc" | "desc", limit: number | null): T[] {
  const ordered = sortDirection === "asc" ? [...rows] : [...rows].reverse();
  return limit === null ? ordered : ordered.slice(0, limit);
}

function nullableString(value: unknown): boolean { return value === undefined || value === null || (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)); }
function optionalSearchTerm(value: unknown): boolean { return value === undefined || value === null || (typeof value === "string" && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value)); }
function nullableLimit(value: unknown): boolean { return value === undefined || value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 512); }
function validStringArray(value: unknown): boolean { return value === undefined || value === null || (Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === "string" && item.length <= 160 && !/[\u0000-\u001f\u007f]/.test(item))); }
function validCwdFilter(value: unknown): boolean { return value === undefined || value === null || nullableString(value) || (Array.isArray(value) && value.length <= 16 && value.every((item) => nullableString(item) && typeof item === "string")); }
function canonicalCwdMatch(value: unknown): boolean { return value === undefined || value === null || value === "/private/var/empty" || (Array.isArray(value) && value.includes("/private/var/empty")); }

function canonicalThreadPreview(conversation: Readonly<{ turns: ReadonlyArray<Readonly<{ items: readonly PortableTranscriptItemV1[] }>> }>): string {
  return conversation.turns.flatMap((turn) => turn.items).find((item) => item.kind === "user")?.text ?? "";
}

function canonicalPublicTurnId(turnId: OpaqueTurnId, secret: Buffer): string {
  return `turn_${createHmac("sha256", secret).update(`renderer-turn:v1:${turnId}`, "utf8").digest("base64url")}`;
}

function canonicalPublicItemId(turnId: OpaqueTurnId, index: number, secret: Buffer): string {
  return `item_${createHmac("sha256", secret).update(`renderer-item:v1:${turnId}:${index}`, "utf8").digest("base64url")}`;
}

function canonicalTurnProjection(
  turn: Readonly<{ turnId: OpaqueTurnId; items: readonly PortableTranscriptItemV1[] }>,
  secret: Buffer,
  itemsView: "notLoaded" | "summary" | "full" = "full",
): Record<string, unknown> {
  const id = canonicalPublicTurnId(turn.turnId, secret);
  const itemId = (index: number): string => canonicalPublicItemId(turn.turnId, index, secret);
  return {
    id,
    status: "completed",
    itemsView,
    items: itemsView === "full" ? turn.items.map((item, index) => canonicalThreadItem(item, itemId(index))) : [],
  };
}

function canonicalThreadItem(item: PortableTranscriptItemV1, id: string): Record<string, unknown> {
  if (item.kind === "user") return { id, type: "userMessage", content: [{ type: "text", text: item.text! }] };
  if (item.kind === "assistant") return { id, type: "agentMessage", text: item.text! };
  if (item.kind === "plan") return { id, type: "plan", text: item.text! };
  return { id, type: "functionCallOutput", name: item.name!, output: item.result! };
}

function isContinuationRequestMethod(method: string): boolean {
  return /^(?:turn\/start|turn\/steer|thread\/compact\/start|thread\/realtime\/start)$/.test(method);
}

/** Only a provider cumulative total can become a baseline; `last` is diagnostic. */
function totalTokenUsage(value: unknown): Record<string, unknown> | null {
  const source = isPlainRecord(value) && isPlainRecord(value.total) ? value.total : isPlainRecord(value) ? value : null;
  if (!source) return null;
  const inputTokens = source.inputTokens;
  const outputTokens = source.outputTokens;
  const totalTokens = source.totalTokens;
  const paired = typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0
    && typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0;
  const aggregate = typeof totalTokens === "number" && Number.isSafeInteger(totalTokens) && totalTokens >= 0;
  return paired || aggregate ? source : null;
}

function nativeTurnIdFrom(value: unknown): string | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.turnId === "string") return value.turnId;
  return isPlainRecord(value.turn) && typeof value.turn.id === "string" ? value.turn.id : null;
}

/** Owner-private native ids are scoped by account for late balance correlation. */
function balanceThreadKey(account: OpaqueAccountId, nativeThreadId: string): string {
  return `${account}\u0000${nativeThreadId}`;
}

/** Renderer ref and request id identify one externally-originated automatic dispatch. */
function automaticCapacityRequestKey(client: AppClient, request: JsonRpcRequest): string {
  return `${client.rendererRef}\u0000${String(request.id)}`;
}

/** Keep the exposed reservation conservative and bounded without claiming it is measured usage. */
function estimatedTurnTokens(params: unknown): number {
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(params ?? null), "utf8"); } catch { bytes = 0; }
  return Math.max(1, Math.min(10_000_000, Math.ceil(bytes / 4) + 1_024));
}

/** Lower sort value means a safer, less-pressured new-work allocation. */
function compareNewWorkCapacity(
  left: { freshness: "fresh" | "stale" | "unknown"; remainingPercent: number | null; resetAt: string | null; shortWindowPressure: number | null; resetCredits: number | null } | undefined,
  leftAssigned: number,
  leftId: OpaqueAccountId,
  right: { freshness: "fresh" | "stale" | "unknown"; remainingPercent: number | null; resetAt: string | null; shortWindowPressure: number | null; resetCredits: number | null } | undefined,
  rightAssigned: number,
  rightId: OpaqueAccountId,
  leftIndex: number,
  rightIndex: number,
): number {
  const candidate = (value: typeof left, id: OpaqueAccountId, assigned: number, index: number) => ({
    opaqueAccountId: id,
    weeklyRemainingPercent: value?.remainingPercent ?? 0,
    weeklyResetAt: value?.resetAt ? Date.parse(value.resetAt) : 0,
    shortWindowPressure: value?.shortWindowPressure ?? null,
    resetCredits: value?.resetCredits ?? null,
    assignedThreadCount: assigned,
    configuredIndex: index,
  });
  return compareQuotaCandidates(candidate(left, leftId, leftAssigned, leftIndex), candidate(right, rightId, rightAssigned, rightIndex), Date.now());
}

/** Automatic routing consumes only current positive provider quota facts. */
function hasFreshPositiveQuota(
  quota: Readonly<{
    freshness: "fresh" | "stale" | "unknown";
    remainingPercent: number | null;
    resetAt?: string | null;
    observedAt?: number | null;
    shortWindowPressure?: number | null;
    shortWindowResetAt?: number | null;
    rateLimitReached?: boolean;
  }> | undefined,
): boolean {
  const now = Date.now();
  const observedAt = quota?.observedAt;
  const weeklyResetAt = quota?.resetAt ? Date.parse(quota.resetAt) : null;
  return quota?.freshness === "fresh"
    && typeof quota.remainingPercent === "number"
    && Number.isFinite(quota.remainingPercent)
    && quota.remainingPercent > 0
    // Current observations and a future weekly reset are mandatory capacity
    // evidence. Unknown legacy metadata is refreshed, never inferred.
    && typeof observedAt === "number"
    && Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= QUOTA_STALE_AFTER_MS
    && weeklyResetAt !== null && Number.isFinite(weeklyResetAt) && weeklyResetAt > now
    && quota.rateLimitReached !== true
    // A known exhausted five-hour window cannot be reopened until its exact
    // reset. A missing reset is deliberately treated as unavailable.
    && !(quota.shortWindowPressure === 100
      && (quota.shortWindowResetAt === null || quota.shortWindowResetAt === undefined || quota.shortWindowResetAt > now));
}

/** A missing/stale capacity record is refreshed once before automatic routing. */
function quotaNeedsRefresh(
  quota: Readonly<{ freshness: "fresh" | "stale" | "unknown"; observedAt?: number | null; resetAt?: string | null }> | undefined,
): boolean {
  if (!quota || quota.freshness !== "fresh") return true;
  const now = Date.now();
  if (typeof quota.observedAt !== "number" || !Number.isFinite(quota.observedAt) || quota.observedAt > now || now - quota.observedAt > QUOTA_STALE_AFTER_MS) return true;
  if (!quota.resetAt) return true;
  const resetAt = Date.parse(quota.resetAt);
  return !Number.isFinite(resetAt) || resetAt <= now;
}

function isDeviceStartResult(value: Record<string, unknown>): value is {
  loginId: string;
  verificationUrl: string;
  userCode: string;
} {
  return typeof value.loginId === "string" && value.loginId.length > 0 && value.loginId.length <= 512
    && typeof value.verificationUrl === "string" && safeProviderUrl(value.verificationUrl)
    && typeof value.userCode === "string" && /^[A-Za-z0-9-]{4,32}$/.test(value.userCode);
}

function safeProviderUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * Reduce a successful owner-private `account/read` response to its only
 * renderer-eligible display facts.  The raw response is intentionally not
 * retained, serialized, or placed in state/configuration.
 */
function providerSafeProfileProjection(value: unknown): BrokerSafeProfileV1 | null {
  if (!isPlainRecord(value)) return null;
  const account = isPlainRecord(value.account) ? value.account : value;
  const profile = isPlainRecord(account.profile) ? account.profile : null;
  const plan = firstSafePlan(account, profile, value);
  const identifierMasked = firstMaskedEmail(account, profile, value);
  const avatarUrl = firstSafeAvatarUrl(account, profile, value);
  return { plan, identifierMasked, avatarUrl };
}

/** Reuse the typed account/read reducer: no profile or signed-out account is capacity. */
function providerAuthenticated(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.account)) return false;
  return parseAccountRead(value, Date.now())?.health === "authenticated";
}

function firstSafePlan(...records: Array<Record<string, unknown> | null>): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of ["plan", "planType", "planName", "subscriptionPlan"]) {
      const value = record[key];
      if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(value)) return value;
    }
    if (isPlainRecord(record.subscription)) {
      const nested = firstSafePlan(record.subscription);
      if (nested) return nested;
    }
  }
  return null;
}

function firstMaskedEmail(...records: Array<Record<string, unknown> | null>): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of ["email", "emailAddress"]) {
      const masked = maskProviderEmail(record[key]);
      if (masked) return masked;
    }
  }
  return null;
}

function maskProviderEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 254 || /[\u0000-\u001f\u007f\s]/.test(value)) return null;
  const at = value.lastIndexOf("@");
  if (at < 1 || at !== value.indexOf("@")) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local)
    || !/^(?=.{1,80}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain)) return null;
  const visible = local.slice(0, Math.min(3, local.length));
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

function firstSafeAvatarUrl(...records: Array<Record<string, unknown> | null>): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of ["avatarUrl", "avatarURL", "imageUrl", "imageURL"]) {
      const sanitized = sanitizeAvatarUrl(record[key]);
      if (sanitized) return sanitized;
    }
  }
  return null;
}

function sanitizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 12 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (url.port && url.port !== "443")) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The sealed app-server supports MCP OAuth only through this response shape.
 * Keep its state query intact for the OAuth transaction, while rejecting any
 * credential-bearing or fragment-bearing URL before it reaches a desktop.
 */
function providerOAuthHandoffUrl(value: unknown): string | null {
  if (!isPlainRecord(value) || typeof value.authorizationUrl !== "string") return null;
  const raw = value.authorizationUrl;
  if (raw.length < 12 || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || (url.port && url.port !== "443")) return null;
    for (const [key, item] of url.searchParams) {
      if (/^(?:access_?token|refresh_?token|id_?token|token|code|client_?secret|credential|cookie)$/i.test(key)) return null;
      if (/(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i.test(item)) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function providerQuotaProjection(value: unknown): {
  remainingPercent: number | null;
  freshness: "fresh" | "unknown";
  resetAt: string | null;
  shortWindowPressure: number | null;
  shortWindowResetAt: number | null;
  rateLimitReached: boolean;
  observedAt: number | null;
  resetCredits: number | null;
} | null {
  const parsed = parseRateLimitsRead(value, Date.now());
  if (!parsed || parsed.weeklyRemainingPercent === null || parsed.weeklyResetAt === null) return null;
  // `parseRateLimitsRead` recognizes documented top-level reset-credit
  // shapes. The current app-server nests the same bounded count under
  // `rateLimits`, so reduce that private shape here before projection.
  const nested = isPlainRecord(value) && isPlainRecord(value.rateLimits) ? value.rateLimits.resetCredits : null;
  const resetCredits = parsed.resetCredits ?? (typeof nested === "number" && Number.isInteger(nested) && nested >= 0 && nested <= 10_000 ? nested : null);
  return {
    remainingPercent: parsed.weeklyRemainingPercent,
    freshness: "fresh",
    resetAt: new Date(parsed.weeklyResetAt).toISOString(),
    shortWindowPressure: parsed.shortWindowPressure,
    shortWindowResetAt: parsed.shortWindowResetAt ?? null,
    rateLimitReached: parsed.rateLimitReached === true,
    observedAt: parsed.observedAt,
    resetCredits,
  };
}

function providerConnectionRows(
  value: unknown,
  kind: BrokerClientConnectionKind,
): Array<{ name: string; displayLabel?: string; status: "unknown" | "connecting" | "connected" | "blocked" | "unavailable" }> | null {
  if (!isPlainRecord(value)) return null;
  let raw = kind === "app" ? (Array.isArray(value.data) ? value.data : Array.isArray(value.apps) ? value.apps : null)
    : kind === "plugin" ? (Array.isArray(value.data) ? value.data : Array.isArray(value.plugins) ? value.plugins : null)
      : Array.isArray(value.data) ? value.data : null;
  if (kind === "plugin" && value.marketplaceLoadErrors !== undefined
    && (!Array.isArray(value.marketplaceLoadErrors) || value.marketplaceLoadErrors.length > 0)) return null;
  if (kind === "plugin" && Array.isArray(value.marketplaces)) {
    if (value.marketplaces.length > 128) return null;
    const entries: unknown[] = [];
    for (const marketplace of value.marketplaces) {
      if (!isPlainRecord(marketplace) || !Array.isArray(marketplace.plugins) || marketplace.plugins.length > 65_536) return null;
      entries.push(...marketplace.plugins.filter((plugin: unknown) => isPlainRecord(plugin) && plugin.installed === true));
    }
    raw = entries;
  }
  if (!raw || raw.length > 2048) return null;
  const seen = new Set<string>();
  const output: Array<{ name: string; displayLabel?: string; status: "unknown" | "connecting" | "connected" | "blocked" | "unavailable" }> = [];
  for (const row of raw) {
    if (!isPlainRecord(row)) return null;
    const name = (kind === "plugin" || kind === "app") && typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : typeof row.id === "string" ? row.id : null;
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name) || seen.has(name)) return null;
    seen.add(name);
    const status = row.status === "connected" || row.status === "connecting" || row.status === "blocked" || row.status === "unavailable"
      ? row.status
      : kind === "app" && (row.enabled === false || row.callable === false || row.isEnabled === false || row.isAccessible === false) ? "blocked"
      : kind === "mcp" && row.authStatus === "notLoggedIn" ? "blocked"
      : row.enabled === true || row.callable === true || (kind === "app" && row.isAccessible === true)
        || (kind === "mcp" && (row.authStatus === "oAuth" || row.authStatus === "bearerToken")) ? "connected" : "unknown";
    const displayLabel = (kind === "plugin" && isPlainRecord(row.interface) ? safeConnectionDisplayLabel(row.interface.displayName) : undefined)
      ?? safeConnectionDisplayLabel(row.displayName) ?? safeConnectionDisplayLabel(row.name)
      ?? (kind === "app" ? safeConnectionDisplayLabel(row.runtimeName) : undefined);
    output.push({ name, ...(displayLabel ? { displayLabel } : {}), status });
  }
  return output;
}

function providerConnectionKey(account: OpaqueAccountId, kind: BrokerClientConnectionKind, definitionRef: OpaqueConnectionDefinitionRef): string {
  return `${account}\u0000${kind}\u0000${definitionRef}`;
}

/**
 * Finish or reject an interrupted enrollment publication before the owner
 * constructs its state store.  The journal contains only opaque ids,
 * generation snapshots, and content-free digests—never auth material or an
 * enrollment request body.
 */
function recoverEnrollmentMaterialization(root: string, fallbackConfig: RouterConfigV3, secret: Buffer): RouterConfigV3 {
  ensurePrivateDirectory(root);
  const journal = readEnrollmentMaterializationJournal(root);
  // A process death after the final journal cleanup has no recovery marker,
  // but its config/state pair is already committed. Reopen from that strict
  // private config rather than a caller's stale pre-enrollment snapshot.
  if (!journal) return readCommittedRouterConfig(root) ?? fallbackConfig;
  const priorConfig = validatedRouterConfigV3(journal.priorConfig);
  const nextConfig = validatedRouterConfigV3(journal.nextConfig);
  if (!priorConfig || !nextConfig
    || durableDigest(priorConfig) !== journal.priorConfigDigest
    || durableDigest(nextConfig) !== journal.nextConfigDigest
    || priorConfig.fingerprint !== journal.priorConfig.fingerprint
    || nextConfig.fingerprint !== journal.nextConfig.fingerprint) {
    throw new Error("accounts broker enrollment journal is invalid");
  }
  const diskConfig = readCommittedRouterConfig(root);
  const state = readCommittedRouterState(root);
  if (!diskConfig || !state) throw new Error("accounts broker enrollment recovery requires complete prior state");
  const configPhase = durableDigest(diskConfig) === journal.priorConfigDigest ? "prior"
    : durableDigest(diskConfig) === journal.nextConfigDigest ? "next" : null;
  const statePhase = durableDigest(state) === journal.priorStateDigest ? "prior"
    : durableDigest(state) === journal.nextStateDigest ? "next" : null;
  if (!configPhase || !statePhase
    || !validateRouterState(state, statePhase === "prior" ? priorConfig : nextConfig)) {
    throw new Error("accounts broker enrollment recovery refused mixed state");
  }
  const source = join(root, "enrollments", journal.enrollmentRef);
  const target = join(root, "accounts", journal.opaqueAccountId);
  const sourcePresent = isPrivateEnrollmentDirectory(source);
  const targetPresent = isPrivateEnrollmentDirectory(target);
  if (sourcePresent && targetPresent) throw new Error("accounts broker enrollment recovery found duplicate home");
  if (sourcePresent) {
    // No rename occurred. A state/config publication without its home is
    // unsafe, so only the untouched prior generation can be retained.
    if (configPhase !== "prior" || statePhase !== "prior") throw new Error("accounts broker enrollment home missing after publication");
    clearEnrollmentMaterializationJournal(root);
    return priorConfig;
  }
  if (!targetPresent || !validateCommittedEnrollmentHome(target, journal.opaqueAccountId, secret)) {
    throw new Error("accounts broker enrollment recovery refused unsafe home");
  }
  prepareEnrollmentNativeExtension(root, journal, secret);
  if (statePhase === "prior") {
    const migrated = migrateIdleRouterStateV3(state, nextConfig);
    if (!migrated || durableDigest(migrated) !== journal.nextStateDigest) {
      throw new Error("accounts broker enrollment migration does not match journal");
    }
    writePrivateJsonAtomic(root, "router-state.json", migrated);
  }
  if (configPhase === "prior") writePrivateJsonAtomic(root, ACCOUNT_ROUTER_CONFIG_FILE, nextConfig);
  publishEnrollmentNativeExtension(root, journal, secret);
  clearEnrollmentMaterializationJournal(root);
  return nextConfig;
}

/** Extend only the exact signed base and exact newly moved enrollment home. */
function prepareEnrollmentNativeExtension(root: string, journal: EnrollmentMaterializationJournalV1, secret: Buffer): void {
  const extension = journal.nativeExtension;
  if (!extension) return;
  const base = readAndPreflightNativeHistoryBaseSourceStaticV1(root, journal.priorConfig.protocolFingerprint, secret);
  if (base.state !== "ready" || base.sourceDocumentFingerprint !== extension.sourceDocumentFingerprint
    || durableDigest(base.source) !== durableDigest(extension.source)) throw new Error("native enrollment base source drifted");
  if (extension.prepared) {
    const recovery = recoverNativeHistoryExtensionUpdateV1({ stateRoot: root, secret, baseSource: base.source,
      baseSourceDocumentFingerprint: base.sourceDocumentFingerprint, priorConfig: journal.priorConfig, nextConfig: journal.nextConfig,
      prior: extension.prepared.prior, next: extension.prepared.next });
    if (recovery.state === "invalid") throw new Error("native enrollment extension proof invalid");
    return;
  }
  const codexHome = join(root, "accounts", journal.opaqueAccountId, "codex-home");
  const sqliteHome = join(root, "accounts", journal.opaqueAccountId, "sqlite-home");
  const raw = readOwnerPrivateAuthAccountId(codexHome);
  if (!raw) throw new Error("native enrollment auth identity unavailable");
  const identity = (path: string) => { const st = lstatSync(path); return { device: st.dev, inode: st.ino, uid: st.uid, mode: st.mode & 0o7777 }; };
  const account: NativeHistoryManagedAccountDraftV1 = { opaqueAccountId: journal.opaqueAccountId,
    accountRootRelativePath: `accounts/${journal.opaqueAccountId}`, codexHomeIdentity: identity(codexHome), sqliteHomeIdentity: identity(sqliteHome),
    authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw, secret) as `hmac-sha256:${string}` };
  const receipt = writeNativeHistoryManagedEnrollmentReceiptV1({ stateRoot: root, secret, account, issuedAt: journal.nextConfig.updatedAt });
  extension.prepared = prepareNativeHistoryExtensionUpdateV1({ stateRoot: root, secret, baseSource: base.source,
    baseSourceDocumentFingerprint: base.sourceDocumentFingerprint, priorConfig: journal.priorConfig, nextConfig: journal.nextConfig,
    managedAccount: { ...account, enrollmentReceiptFingerprint: receipt.enrollmentReceiptFingerprint }, issuedAt: journal.nextConfig.updatedAt });
  writeEnrollmentMaterializationJournal(root, journal);
}

function publishEnrollmentNativeExtension(root: string, journal: EnrollmentMaterializationJournalV1, secret: Buffer): void {
  const extension = journal.nativeExtension;
  if (!extension) return;
  if (!extension.prepared) throw new Error("native enrollment extension intent missing");
  const recovery = recoverNativeHistoryExtensionUpdateV1({ stateRoot: root, secret, baseSource: extension.source,
    baseSourceDocumentFingerprint: extension.sourceDocumentFingerprint, priorConfig: journal.priorConfig, nextConfig: journal.nextConfig,
    prior: extension.prepared.prior, next: extension.prepared.next });
  if (recovery.state === "invalid") throw new Error("native enrollment extension drifted");
  if (recovery.state === "prior") publishPreparedNativeHistoryExtensionUpdateV1({ stateRoot: root, secret, prior: extension.prepared.prior, next: extension.prepared.next });
}

function writeEnrollmentMaterializationJournal(root: string, journal: EnrollmentMaterializationJournalV1): void {
  if (!isEnrollmentMaterializationJournal(journal)) throw new Error("invalid accounts broker enrollment journal");
  const bytes = Buffer.byteLength(JSON.stringify(journal), "utf8");
  if (bytes > MAX_ENROLLMENT_MATERIALIZATION_JOURNAL_BYTES) throw new Error("accounts broker enrollment journal exceeds its bound");
  writePrivateJsonAtomic(root, ENROLLMENT_MATERIALIZATION_JOURNAL_FILE, journal);
}

function readEnrollmentMaterializationJournal(root: string): EnrollmentMaterializationJournalV1 | null {
  const path = join(root, ENROLLMENT_MATERIALIZATION_JOURNAL_FILE);
  if (!existsSync(path)) return null;
  assertPrivateRegularFile(path, MAX_ENROLLMENT_MATERIALIZATION_JOURNAL_BYTES);
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_ENROLLMENT_MATERIALIZATION_JOURNAL_BYTES) throw new Error("accounts broker enrollment journal exceeds its bound");
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("accounts broker enrollment journal is unreadable"); }
  if (!isEnrollmentMaterializationJournal(parsed)) throw new Error("accounts broker enrollment journal is invalid");
  return parsed;
}

function clearEnrollmentMaterializationJournal(root: string): void {
  const path = join(root, ENROLLMENT_MATERIALIZATION_JOURNAL_FILE);
  if (!existsSync(path)) return;
  assertPrivateRegularFile(path, MAX_ENROLLMENT_MATERIALIZATION_JOURNAL_BYTES);
  unlinkSync(path);
}

function readCommittedRouterConfig(root: string): RouterConfigV3 | null {
  const path = join(root, ACCOUNT_ROUTER_CONFIG_FILE);
  try {
    assertPrivateRegularFile(path, MAX_ENROLLMENT_MATERIALIZATION_JOURNAL_BYTES);
    return validatedRouterConfigV3(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function readCommittedRouterState(root: string): RouterState | null {
  const path = join(root, "router-state.json");
  try {
    assertPrivateRegularFile(path, 2 * 1024 * 1024);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isPlainRecord(parsed) ? parsed as unknown as RouterState : null;
  } catch {
    return null;
  }
}

function validatedRouterConfigV3(value: unknown): RouterConfigV3 | null {
  const parsed = validateRouterConfig(value);
  return parsed?.schemaVersion === 3 ? parsed : null;
}

function isEnrollmentMaterializationJournal(value: unknown): value is EnrollmentMaterializationJournalV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== [
    "enrollmentRef", "nextConfig", "nextConfigDigest", "nextStateDigest", "opaqueAccountId", "phase",
    "priorConfig", "priorConfigDigest", "priorStateDigest", "version",
    ...(Object.prototype.hasOwnProperty.call(value, "nativeExtension") ? ["nativeExtension"] : []),
  ].sort().join("\0")) return false;
  if (value.version !== 1 || typeof value.enrollmentRef !== "string" || !/^be_[A-Za-z0-9_-]{16,128}$/.test(value.enrollmentRef)
    || !isOpaqueAccountId(value.opaqueAccountId)
    || !["prepared", "home_moved", "state_published", "config_published"].includes(String(value.phase))) return false;
  if (value.nativeExtension !== undefined && (!isPlainRecord(value.nativeExtension)
    || Object.keys(value.nativeExtension).sort().join("\0") !== "prepared\0source\0sourceDocumentFingerprint"
    || !isPlainRecord(value.nativeExtension.source) || typeof value.nativeExtension.sourceDocumentFingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.nativeExtension.sourceDocumentFingerprint)
    || (value.nativeExtension.prepared !== null && !isPlainRecord(value.nativeExtension.prepared)))) return false;
  const priorConfig = validatedRouterConfigV3(value.priorConfig);
  const nextConfig = validatedRouterConfigV3(value.nextConfig);
  if (!priorConfig || !nextConfig || !nextConfig.accounts.some((account) => account.opaqueAccountId === value.opaqueAccountId)
    || priorConfig.accounts.some((account) => account.opaqueAccountId === value.opaqueAccountId)) return false;
  const digest = (candidate: unknown): candidate is `sha256:${string}` => typeof candidate === "string" && /^sha256:[a-f0-9]{64}$/.test(candidate);
  return digest(value.priorConfigDigest) && digest(value.nextConfigDigest) && digest(value.priorStateDigest) && digest(value.nextStateDigest)
    && durableDigest(priorConfig) === value.priorConfigDigest && durableDigest(nextConfig) === value.nextConfigDigest;
}

function nativeInventoryConsumer(method: string): boolean {
  return /^(?:plugin|skills|hooks|hook|marketplace)\//.test(method)
    || ["thread/start", "thread/resume", "thread/fork", "turn/start", "config/read", "config/value/write", "config/batchWrite", "mcpServerStatus/list"].includes(method);
}

function isNativePluginInventory(value: unknown, root: string): value is NativePluginInventory {
  if (!isPlainRecord(value) || Object.keys(value).sort().join() !== "native_base_root,plugins,schema_version"
    || value.schema_version !== 1 || value.native_base_root !== root || !Array.isArray(value.plugins) || value.plugins.length > 4096) return false;
  let previous = "";
  for (const plugin of value.plugins) {
    if (!isPlainRecord(plugin) || Object.keys(plugin).sort().join() !== "enabled,id,version"
      || typeof plugin.id !== "string" || Buffer.byteLength(plugin.id) > 512 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*@openai-curated-remote$/.test(plugin.id)
      || plugin.id <= previous || typeof plugin.enabled !== "boolean"
      || (plugin.version !== null && (typeof plugin.version !== "string" || !plugin.version || Buffer.byteLength(plugin.version) > 256))) return false;
    previous = plugin.id;
  }
  return Buffer.byteLength(JSON.stringify(value)) < NATIVE_INVENTORY_MAX_BYTES;
}

function nativePluginInventoryFromResponse(value: unknown, root: string): NativePluginInventory | null {
  if (!isPlainRecord(value) || !Array.isArray(value.marketplaces) || value.marketplaces.length > 128
    || !Array.isArray(value.marketplaceLoadErrors) || value.marketplaceLoadErrors.length !== 0) return null;
  const plugins: NativePluginInventory["plugins"] = [];
  for (const marketplace of value.marketplaces) {
    if (!isPlainRecord(marketplace) || !Array.isArray(marketplace.plugins)) return null;
    if (marketplace.name !== "openai-curated-remote") continue;
    if (marketplace.plugins.length > 4096) return null;
    for (const plugin of marketplace.plugins) {
      if (!isPlainRecord(plugin) || typeof plugin.installed !== "boolean") return null;
      if (!plugin.installed) continue;
      plugins.push({ id: plugin.id, enabled: plugin.enabled, version: plugin.version } as NativePluginInventory["plugins"][number]);
    }
  }
  if (plugins.some((plugin) => typeof plugin.id !== "string")) return null;
  plugins.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const inventory = { schema_version: 1 as const, native_base_root: root, plugins };
  return isNativePluginInventory(inventory, root) ? inventory : null;
}

function durableDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function isPrivateEnrollmentDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function assertPrivateEnrollmentDirectory(path: string): void {
  if (!isPrivateEnrollmentDirectory(path)) throw new Error("accounts broker enrollment directory is unsafe");
}

function validateCommittedEnrollmentHome(target: string, opaqueAccountId: OpaqueAccountId, secret: Buffer): boolean {
  try {
    const codexHome = join(target, "codex-home");
    const sqliteHome = join(target, "sqlite-home");
    if (!isPrivateEnrollmentDirectory(target) || !isPrivateEnrollmentDirectory(codexHome) || !isPrivateEnrollmentDirectory(sqliteHome)) return false;
    const configPath = join(codexHome, "config.toml");
    assertPrivateRegularFile(configPath, 4 * 1024);
    if (readFileSync(configPath, "utf8") !== "") return false;
    const rawAccountId = readOwnerPrivateAuthAccountId(codexHome);
    if (!rawAccountId) return false;
    const expected = `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`;
    return expected === opaqueAccountId
      && sharedSkillsHomeMatches(dirname(dirname(target)), codexHome)
      && sharedPluginsHomeMatches(dirname(dirname(target)), codexHome);
  } catch {
    return false;
  }
}

function parseOwnerArguments(argv: string[]): OwnerCliArguments | null {
  const separator = argv.indexOf("--");
  if (separator < 0) return null;
  const flags = argv.slice(0, separator);
  const configPath = flagValue(flags, "--config");
  const stateRoot = flagValue(flags, "--state-root");
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  if (!configPath || !stateRoot || !command || !isAbsolute(configPath) || !isAbsolute(stateRoot)
    || resolve(configPath) !== configPath || resolve(stateRoot) !== stateRoot) return null;
  return { configPath, stateRoot, command, args };
}

function flagValue(flags: readonly string[], name: string): string | null {
  const index = flags.indexOf(name);
  return index >= 0 && typeof flags[index + 1] === "string" ? flags[index + 1] : null;
}

function isAppHandshake(value: unknown): value is AppHandshakeFrame {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["handshake", "kind", "version"].join("\0")
    && value.version === 1 && value.kind === "handshake" && isPlainRecord(value.handshake);
}

function isAppHandshakeResult(value: unknown): value is { version: 1; kind: "handshake"; ok: boolean } {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "ok", "version"].join("\0")
    && value.version === 1 && value.kind === "handshake" && typeof value.ok === "boolean";
}

function isAppMessage(value: unknown): value is AppMessageFrame {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["kind", "message", "version"].join("\0")
    && value.version === 1 && value.kind === "message" && isJsonRpcMessage(value.message);
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isPlainRecord(value) && ((typeof value.method === "string" && (value.id === undefined || typeof value.id === "string" || typeof value.id === "number"))
    || (value.method === undefined && (typeof value.id === "string" || typeof value.id === "number" || value.id === null)));
}

function writeAppFrame(socket: Socket, frame: AppServerWireFrame, maxFrameBytes: number): boolean {
  try {
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (encoded.byteLength > maxFrameBytes || !socket.writable) return false;
    socket.write(encoded);
    return true;
  } catch {
    return false;
  }
}

/** Check a prospective desktop response before sendDesktop can close its socket. */
function appDesktopMessageFits(message: JsonRpcMessage): boolean {
  try {
    return Buffer.byteLength(JSON.stringify({ version: 1, kind: "message", message }), "utf8") + 1 <= ACCOUNTS_BROKER_APP_SERVER_MAX_FRAME_BYTES;
  } catch {
    return false;
  }
}

function assertPrivateSocket(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("accounts broker app socket is not owner-private");
  }
}

async function removeStaleAppSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  assertPrivateSocket(path);
  if (await socketLive(path)) throw new Error("accounts broker app socket is already active");
  unlinkSync(path);
}

function socketLive(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

if (require.main === module) {
  void runAccountsBrokerOwnerCli().catch(() => { process.exitCode = 1; });
}

/** Account-scoped reads never acquire a live conversation writer. Unknown methods are writes. */
function isReadOnlyNativeAccountMethod(method: string): boolean {
  return HISTORY_READ_METHODS.has(method) || /(?:\/read|\/list)$/.test(method)
    || ["initialize", "model/list", "configRequirements/read", "experimentalFeature/list"].includes(method);
}

/** Last CLI override wins; strip earlier credential-store overrides defensively. */
export function credentialStoreArgs(args: readonly string[], store: "ephemeral" | "file"): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "-c" || arg === "--config") && /^cli_auth_credentials_store\s*=/.test(args[i + 1] ?? "")) { i += 1; continue; }
    if (/^--config=cli_auth_credentials_store\s*=/.test(arg)) continue;
    result.push(arg);
  }
  return [...result, "-c", `cli_auth_credentials_store="${store}"`];
}

function isolatedAuthMutation(method: string, params: unknown): boolean {
  if (["account/login/start", "account/login/cancel", "account/logout"].includes(method)) return true;
  if (method !== "config/value/write" && method !== "config/batchWrite") return false;
  if (!isPlainRecord(params)) return true;
  const edits = method === "config/value/write" ? [params] : params.edits;
  return !Array.isArray(edits) || edits.some((edit) => !isPlainRecord(edit) || edit.keyPath === "cli_auth_credentials_store" || edit.keyPath === "forced_chatgpt_workspace_id");
}

class NativeAuthHelperBusyError extends Error {
  constructor() { super("native authentication helper busy"); }
}

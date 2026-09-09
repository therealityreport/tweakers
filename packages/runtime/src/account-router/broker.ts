import { isNativeProfileStatisticsResultV1, type NativeProfileStatisticsResultV1 } from "./profile-statistics";
import { hasConfirmedQuotaDepletion } from "./quota";
import { isAccountsPreferencesPatch, type AccountsPreferencesV1 } from "./preferences";
import { isBoundedNativeResultV1, parseNativeRequestV1 } from "./native-request";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { assertRedacted } from "./redaction";
import type {
  AccountPoolV3,
  BrokerBalanceProjectionV1,
  BrokerRemoteCommandV1,
  BrokerRemoteProjectionV1,
  AccountPoolAccountV3,
  BrokerAccountState,
  BrokerClientKind,
  BrokerConnectionKind,
  BrokerConnectionStatus,
  BrokerControlStatusV1,
  BrokerEnrollmentV1,
  BrokerErrorCode,
  BrokerEventType,
  BrokerEventV1,
  BrokerHandshakeV1,
  BrokerHistoryReadProjectionV1,
  LogicalContinuationProjectionV1,
  LogicalConversationProjectionV1,
  LogicalHistorySubscriptionV1,
  LogicalTurnProjectionV1,
  BrokerQuotaFreshness,
  BrokerRequestEnvelopeV1,
  BrokerResponseV1,
  BrokerSafeProfileV1,
  ConnectionStateV3,
  OpaqueAccountId,
  OpaqueAppToolsRef,
  OpaqueConnectionDefinitionRef,
  OpaqueConfirmationId,
  OpaqueConversationId,
  OpaqueEnrollmentRef,
  OpaqueHandoffRef,
  OpaqueRendererRef,
  OpaqueTaskRef,
  PendingHandoffV1,
  QuotaProjectionV3,
  RouterConfigV3,
  TaskOwnershipV3,
} from "./types";
import {
  ACCOUNTS_BROKER_HANDOFF_TTL_MS,
  ACCOUNTS_BROKER_IDLE_EVICTION_MS,
  ACCOUNTS_BROKER_MAX_CLIENTS,
  ACCOUNTS_BROKER_MAX_RESIDENT_CHILDREN,
  ACCOUNTS_BROKER_VERSION,
  isOpaqueAccountId,
  isOpaqueAppToolsRef,
  isOpaqueConnectionDefinitionRef,
  isOpaqueConfirmationId,
  isOpaqueConversationId,
  isOpaqueEnrollmentRef,
  isOpaqueHandoffRef,
  isOpaqueRendererRef,
  isOpaqueSegmentId,
  isOpaqueTaskRef,
  isOpaqueTurnId,
  isPlainRecord,
} from "./types";

const MAX_COMMAND_IDS_PER_CLIENT = 1_024;
const MAX_EVENTS_PER_CLIENT = 64;
const MAX_CONNECTIONS = 4096;
const MAX_PENDING_HANDOFFS = 64;
const HANDSHAKE_NONCE_TTL_MS = 2 * 60_000;
const COMMAND_REPLAY_TTL_MS = 5 * 60_000;

export interface BrokerAccountSeedV3 {
  opaqueAccountId: OpaqueAccountId;
  enabled: boolean;
  /** Validated local label, never a provider profile field. */
  label?: string;
  state?: Exclude<BrokerAccountState, "active">;
  /** Durable ledger count, restored without replaying task registrations. */
  assignedTaskCount?: number;
  /** Previously reduced display facts; this is never a raw provider profile. */
  safeProfile?: BrokerSafeProfileV1;
}

export interface BrokerAccountSettingsChangeV1 {
  opaqueAccountId: OpaqueAccountId;
  label?: string;
  enabled?: boolean;
}

/**
 * Main creates this private binding once per desktop process/app session. It
 * prevents a ChatGPT and Tweakers renderer that both happen to be webContents
 * `1` from deriving the same owner endpoint. Neither field crosses a renderer
 * or app-server protocol boundary; only the HMAC opaque refs do.
 */
export interface BrokerDesktopIdentityBindingV1 {
  clientKind: BrokerClientKind;
  bundleIdentity: string;
  sessionNonce: string;
}

export interface BrokerChildV1 {
  readonly opaqueAccountId: OpaqueAccountId;
  /** Child factories must set this after stripping remote-control options. */
  readonly remoteControlDisabled: true;
  terminate(reason: "idle" | "shutdown" | "capacity" | "disabled"): void;
}

export interface BrokerChildFactoryV1 {
  create(input: Readonly<{
    opaqueAccountId: OpaqueAccountId;
    remoteControlDisabled: true;
    storageScope: "account_local";
  }>): BrokerChildV1;
}

export interface BrokerHandoffDeliveryV1 {
  readonly handoffRef: OpaqueHandoffRef;
  readonly confirmationId: OpaqueConfirmationId;
  readonly conversationId: OpaqueConversationId;
  readonly taskRef: OpaqueTaskRef;
  /** The originating desktop remains the app-tools endpoint after a move. */
  readonly originRendererRef: OpaqueRendererRef;
  readonly fromOpaqueAccountId: OpaqueAccountId;
  readonly toOpaqueAccountId: OpaqueAccountId;
  /** Intentionally opaque to callbacks which emit public events. */
  readonly continuation: unknown;
}

/** A pre-dispatch result; only the host may classify a held continuation. */
export type BrokerHandoffDeliveryResultV1 = "delivered" | "ambiguous" | "rejected" | "linked_continuation_required";
export type BrokerHandoffSettlementV1 = "cancelled" | "rejected" | "expired" | "ambiguous" | "linked_continuation_required";

/**
 * Owner-only provider dispatch.  `loginId` and raw provider results never
 * enter broker events or renderer responses; the core reduces them to a
 * bounded device/enrollment projection first.
 */
export type BrokerDeviceActionV1 =
  | { kind: "device.start"; enrollmentRef: OpaqueEnrollmentRef; opaqueAccountId: OpaqueAccountId | null }
  | { kind: "device.status"; enrollmentRef: OpaqueEnrollmentRef; opaqueAccountId: OpaqueAccountId | null; loginId: string }
  | { kind: "device.cancel"; enrollmentRef: OpaqueEnrollmentRef; opaqueAccountId: OpaqueAccountId | null; loginId: string }
  | { kind: "profile.email"; opaqueAccountId: OpaqueAccountId }
  | { kind: "profile.read"; opaqueAccountId: OpaqueAccountId }
  | { kind: "quota.read"; opaqueAccountId: OpaqueAccountId }
  | { kind: "native.request"; opaqueAccountId: OpaqueAccountId; surface: import("./types").NativeRequestSurfaceV1; method: string; params: Record<string, unknown> }
  | { kind: "connection.list"; opaqueAccountId: OpaqueAccountId; connectionKind: BrokerConnectionKind }
  | { kind: "connection.status"; opaqueAccountId: OpaqueAccountId; connectionKind: BrokerConnectionKind; definitionRef: OpaqueConnectionDefinitionRef }
  | { kind: "connection.authorize"; opaqueAccountId: OpaqueAccountId; connectionKind: BrokerConnectionKind; definitionRef: OpaqueConnectionDefinitionRef }
  | { kind: "resetCredit.consume"; opaqueAccountId: OpaqueAccountId; idempotencyKey: string };

export interface BrokerDeviceActionResultV1 {
  outcome: "accepted" | "rejected" | "ambiguous";
  /** Owner-private, bounded provider result; it is validated before use. */
  value?: unknown;
}

/** Returned only by the owner after a private enrollment home is committed. */
export interface BrokerMaterializedAccountV1 {
  opaqueAccountId: OpaqueAccountId;
  safeProfile: BrokerSafeProfileV1;
}

export interface AccountsBrokerOptionsV1 {
  accounts: readonly BrokerAccountSeedV3[];
  /** Owner-private 256-bit capability; it is never emitted or retained in an event. */
  secret: Buffer;
  childFactory?: BrokerChildFactoryV1;
  now?: () => number;
  idleEvictionMs?: number;
  handoffTtlMs?: number;
  /** Persists bounded metadata only; the continuation never enters durable state. */
  onHandoffCreated?: (handoff: PendingHandoffV1) => void;
  /** Persist a user-selected target before the one permitted provider write. */
  onHandoffRetargeted?: (handoff: PendingHandoffV1) => void;
  onHandoffSettled?: (handoff: PendingHandoffV1, state: BrokerHandoffSettlementV1) => void;
  onForwardContinuation?: (delivery: BrokerHandoffDeliveryV1) => BrokerHandoffDeliveryResultV1 | Promise<BrokerHandoffDeliveryResultV1>;
  onDeviceAction?: (action: BrokerDeviceActionV1) => BrokerDeviceActionResultV1 | Promise<BrokerDeviceActionResultV1>;
  /** Materializes an empty enrollment home without copying credentials. */
  onEnrollmentMaterialized?: (enrollment: BrokerEnrollmentV1) => BrokerMaterializedAccountV1 | OpaqueAccountId | null | Promise<BrokerMaterializedAccountV1 | OpaqueAccountId | null>;
  onEnrollmentSettled?: (enrollment: BrokerEnrollmentV1) => void;
  /** Commit config-owned fields before the scheduler changes its mirror. */
  onAccountSettingsChanged?: (change: BrokerAccountSettingsChangeV1) => boolean;
  /** Current authenticated renderer's content-free canonical attribution. */
  onProfileStatistics?: (selection: "pooled" | OpaqueAccountId) => Promise<NativeProfileStatisticsResultV1>;
  onRemoteAction?: (command: BrokerRemoteCommandV1, accountId: OpaqueAccountId, deviceId?: string) => Promise<BrokerRemoteProjectionV1>;
  onPreferencesRead?: () => AccountsPreferencesV1;
  onPreferencesUpdate?: (patch: Partial<AccountsPreferencesV1>) => AccountsPreferencesV1;
  onAccountContinuityRead?: (accountId: OpaqueAccountId) => Pick<AccountPoolAccountV3, "continuityState" | "continuityReason" | "continuityBlocker">;
  onBalanceRead?: () => BrokerBalanceProjectionV1;
  onBalanceSet?: (enabled: boolean) => boolean;
  onHistoryRead?: (rendererRef: OpaqueRendererRef) => BrokerHistoryReadProjectionV1;
}

export interface BrokerHandshakeResultV1 {
  ok: boolean;
  code?: Extract<BrokerErrorCode, "incompatible_client" | "unauthenticated">;
  pool?: AccountPoolV3;
}

interface ResidentChild {
  child: BrokerChildV1;
  lastUsedAt: number;
  activeRunCount: number;
}

interface MutableAccount {
  opaqueAccountId: OpaqueAccountId;
  label: string;
  safeProfile: BrokerSafeProfileV1;
  enabled: boolean;
  state: BrokerAccountState;
  assignedTaskCount: number;
}

interface MutableTask extends TaskOwnershipV3 {
  privateThreadKey: string | null;
}

interface InternalEnrollment extends BrokerEnrollmentV1 {
  /** Never copy this provider-issued id into a public projection. */
  loginId: string | null;
}

interface InternalPendingHandoff extends PendingHandoffV1 {
  continuation: unknown;
  deliveryAttempted: boolean;
}

interface ClientSession {
  rendererRef: OpaqueRendererRef;
  clientKind: BrokerClientKind;
  appToolsRef: OpaqueAppToolsRef;
  usedRequestIds: Map<string, number>;
}

export interface BrokerAppToolsRouteV1 {
  taskRef: OpaqueTaskRef;
  appToolsRef: OpaqueAppToolsRef;
  ownerRendererRef: OpaqueRendererRef;
}

/**
 * Single-owner account scheduler and renderer-safe control surface.
 *
 * The broker contains no credential or SQLite API. The only process that may
 * provide a child factory owns those private resources, and the factory is
 * required to create account-local, remote-control-disabled children. This
 * makes the pool ledger independent from child residency and lets a socket
 * owner serve two desktop clients without two raw SQLite writers.
 */
export class AccountsBrokerV1 {
  private readonly accounts = new Map<OpaqueAccountId, MutableAccount>();
  private readonly children = new Map<OpaqueAccountId, ResidentChild>();
  private readonly sessions = new Map<OpaqueRendererRef, ClientSession>();
  private readonly tasks = new Map<OpaqueTaskRef, MutableTask>();
  private readonly handoffs = new Map<OpaqueHandoffRef, InternalPendingHandoff>();
  private readonly enrollments = new Map<OpaqueEnrollmentRef, InternalEnrollment>();
  private readonly quotas = new Map<OpaqueAccountId, QuotaProjectionV3>();
  private readonly connections = new Map<string, ConnectionStateV3>();
  private readonly subscribers = new Map<OpaqueRendererRef, Set<(event: BrokerEventV1) => void>>();
  private readonly eventBuffers = new Map<OpaqueRendererRef, BrokerEventV1[]>();
  private readonly usedHandshakeNonces = new Map<string, number>();
  private sequence = 0;
  private heldWorkCount = 0;
  private closed = false;
  private profileRefresh: Promise<void> | null = null;
  private readonly quotaRefreshes = new Map<OpaqueAccountId, Promise<void>>();
  private readonly now: () => number;
  private readonly pinnedChildren = new Set<OpaqueAccountId>();
  private readonly idleEvictionMs: number;
  private readonly handoffTtlMs: number;
  private browserEvidenceObservedAt: string | null = null;
  /** Restart-recovered forwarding ambiguity has no payload to replay. */
  private recoveredAmbiguousHandoffCount = 0;

  constructor(private readonly options: AccountsBrokerOptionsV1) {
    if (options.secret.byteLength !== 32) throw new Error("accounts broker requires a 256-bit owner-private capability");
    if (!Array.isArray(options.accounts) || options.accounts.length === 0) {
      throw new Error("accounts broker requires a non-empty account pool");
    }
    const seen = new Set<OpaqueAccountId>();
    for (const seed of options.accounts) {
      if (!isOpaqueAccountId(seed.opaqueAccountId) || seen.has(seed.opaqueAccountId) || typeof seed.enabled !== "boolean"
        || (seed.label !== undefined && !isSafeProfileLabel(seed.label))
        || (seed.safeProfile !== undefined && !isBrokerSafeProfile(seed.safeProfile))
        || (seed.assignedTaskCount !== undefined && (!Number.isSafeInteger(seed.assignedTaskCount) || seed.assignedTaskCount < 0))) {
        throw new Error("accounts broker refused an invalid account pool");
      }
      seen.add(seed.opaqueAccountId);
      const state = seed.enabled ? (seed.state === "reauth_required" || seed.state === "unhealthy" ? seed.state : "ready") : "disabled";
      this.accounts.set(seed.opaqueAccountId, {
        opaqueAccountId: seed.opaqueAccountId,
        label: seed.label ?? `Account ${seen.size}`,
        safeProfile: seed.safeProfile ? { ...seed.safeProfile } : emptySafeProfile(),
        enabled: seed.enabled,
        state,
        assignedTaskCount: seed.assignedTaskCount ?? 0,
      });
      this.quotas.set(seed.opaqueAccountId, {
        opaqueAccountId: seed.opaqueAccountId,
        freshness: "unknown",
        remainingPercent: null,
        resetAt: null,
        shortWindowPressure: null,
        resetCredits: null,
      });
    }
    this.now = options.now ?? Date.now;
    this.idleEvictionMs = boundedDuration(options.idleEvictionMs ?? ACCOUNTS_BROKER_IDLE_EVICTION_MS, 1_000, 30 * 60_000);
    this.handoffTtlMs = boundedDuration(options.handoffTtlMs ?? ACCOUNTS_BROKER_HANDOFF_TTL_MS, 1_000, 5 * 60_000);
  }

  /** The proof covers the opaque client identity and one-use nonce, not a request body. */
  handshake(handshake: BrokerHandshakeV1): BrokerHandshakeResultV1 {
    this.sweep();
    if (this.closed || !isValidBrokerHandshake(handshake) || !verifyBrokerHandshake(this.options.secret, handshake)) {
      return { ok: false, code: this.closed ? "incompatible_client" : "unauthenticated" };
    }
    if (!this.sessions.has(handshake.rendererRef) && this.sessions.size >= ACCOUNTS_BROKER_MAX_CLIENTS) {
      return { ok: false, code: "incompatible_client" };
    }
    const nonceExpiry = this.usedHandshakeNonces.get(handshake.nonce);
    if (nonceExpiry && nonceExpiry > this.now()) return { ok: false, code: "unauthenticated" };
    this.usedHandshakeNonces.set(handshake.nonce, this.now() + HANDSHAKE_NONCE_TTL_MS);
    const existing = this.sessions.get(handshake.rendererRef);
    // A reconnect must prove the identical app-tools endpoint. Ref reuse with
    // a different route would otherwise let a stale peer steal reverse tools.
    if (existing && (existing.clientKind !== handshake.clientKind || existing.appToolsRef !== handshake.appToolsRef)) {
      return { ok: false, code: "incompatible_client" };
    }
    this.sessions.set(handshake.rendererRef, {
      rendererRef: handshake.rendererRef,
      clientKind: handshake.clientKind,
      appToolsRef: handshake.appToolsRef,
      // Preserve consumed IDs across a dropped-response reconnect. The map is
      // bounded and swept, so this does not turn a renderer session into an
      // unbounded durable request ledger.
      usedRequestIds: existing?.usedRequestIds ?? new Map(),
    });
    this.emit([handshake.rendererRef], "availability", { state: "available" });
    this.emit([handshake.rendererRef], "profile", this.pool());
    return { ok: true, pool: this.pool() };
  }

  /**
   * Runs one authenticated UI/control command. A request id is consumed before
   * action execution, so ambiguous client delivery cannot replay an action.
   */
  async invoke(rendererRef: OpaqueRendererRef, envelope: BrokerRequestEnvelopeV1): Promise<BrokerResponseV1> {
    this.sweep();
    if (!isOpaqueRendererRef(rendererRef) || this.closed) return brokerFailure(requestIdFrom(envelope), "broker_unavailable", true);
    const session = this.sessions.get(rendererRef);
    if (!session) return brokerFailure(requestIdFrom(envelope), "unauthenticated", false);
    if (!isBrokerRequestEnvelope(envelope)) return brokerFailure(requestIdFrom(envelope), "invalid_request", false);
    if (session.usedRequestIds.has(envelope.requestId)) return brokerFailure(envelope.requestId, "request_replayed", false);
    session.usedRequestIds.set(envelope.requestId, this.now());
    trimOldest(session.usedRequestIds, MAX_COMMAND_IDS_PER_CLIENT);

    try {
      const result = await this.execute(session, envelope);
      assertBrokerCommandResult(envelope.command, result);
      return { version: ACCOUNTS_BROKER_VERSION, requestId: envelope.requestId, ok: true, result };
    } catch (error) {
      return brokerFailure(envelope.requestId, brokerErrorCode(error), isRetryableBrokerError(error));
    }
  }

  /** Direct main-process subscription; renderers never receive the socket capability. */
  subscribe(rendererRef: OpaqueRendererRef, handler: (event: BrokerEventV1) => void): () => void {
    if (!isOpaqueRendererRef(rendererRef) || !this.sessions.has(rendererRef) || this.closed) return () => {};
    const handlers = this.subscribers.get(rendererRef) ?? new Set<(event: BrokerEventV1) => void>();
    handlers.add(handler);
    this.subscribers.set(rendererRef, handlers);
    return () => {
      const current = this.subscribers.get(rendererRef);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.subscribers.delete(rendererRef);
    };
  }

  /** Owner-private helpers may verify the socket's authenticated renderer without exposing session data. */
  hasAuthenticatedRenderer(rendererRef: OpaqueRendererRef): boolean {
    return !this.closed && isOpaqueRendererRef(rendererRef) && this.sessions.has(rendererRef);
  }

  /** Bounded replay buffer used after a main-process reconnect, never by renderers directly. */
  events(rendererRef: OpaqueRendererRef): BrokerEventV1[] {
    this.sweep();
    return this.sessions.has(rendererRef) ? [...(this.eventBuffers.get(rendererRef) ?? [])] : [];
  }

  pool(): AccountPoolV3 {
    this.sweepExpiredOnly();
    return {
      schemaVersion: 3,
      maxResidentChildren: [...this.accounts.values()].filter((account) => account.enabled).length,
      residentChildren: this.children.size,
      heldWorkCount: this.heldWorkCount,
      accounts: [...this.accounts.values()].map((account) => this.accountProjection(account)),
    };
  }

  /** Strict redacted owner-private control projection; no private broker data. */
  status(): BrokerControlStatusV1 {
    this.sweep();
    let pendingCount = 0;
    let ambiguousCount = 0;
    for (const handoff of this.handoffs.values()) {
      if (handoff.state === "pending") pendingCount += 1;
      if (handoff.state === "ambiguous") ambiguousCount += 1;
    }
    return {
      version: ACCOUNTS_BROKER_VERSION,
      state: this.closed ? "unavailable" : "available",
      registeredClients: [...this.sessions.values()].map((session) => ({
        rendererRef: session.rendererRef,
        clientKind: session.clientKind,
      })),
      pool: (() => {
        const pool = this.pool();
        return {
          maxResidentChildren: pool.maxResidentChildren,
          residentChildren: pool.residentChildren,
          heldWorkCount: pool.heldWorkCount,
          accounts: pool.accounts.map(({
            opaqueAccountId: _opaqueAccountId,
            label: _label,
            safeProfile: _safeProfile,
            continuityState: _continuityState,
            continuityReason: _continuityReason,
            continuityBlocker: _continuityBlocker,
            ...account
          }) => account),
        };
      })(),
      pendingHandoffs: { pendingCount, ambiguousCount: ambiguousCount + this.recoveredAmbiguousHandoffCount },
      browserEvidence: {
        observed: this.browserEvidenceObservedAt !== null,
        observedAt: this.browserEvidenceObservedAt,
      },
    };
  }

  /** Owner startup records terminal metadata without reconstructing payloads. */
  setRecoveredAmbiguousHandoffCount(count: number): void {
    this.recoveredAmbiguousHandoffCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  /** Bridge-only marker; it intentionally records no browser identifier. */
  observeBrowserDelivery(): void {
    if (!this.closed) this.browserEvidenceObservedAt = new Date(this.now()).toISOString();
  }

  quota(): QuotaProjectionV3[] {
    return [...this.quotas.values()].map((projection) => ({ ...projection }));
  }

  connectionStates(): ConnectionStateV3[] {
    return [...this.connections.values()].map((connection) => ({ ...connection }));
  }

  taskOwnership(taskRef: OpaqueTaskRef): TaskOwnershipV3 | null {
    const task = this.tasks.get(taskRef);
    return task ? publicTask(task) : null;
  }

  pendingHandoff(handoffRef: OpaqueHandoffRef): PendingHandoffV1 | null {
    this.sweep();
    const handoff = this.handoffs.get(handoffRef);
    return handoff ? publicHandoff(handoff) : null;
  }

  /** Renderer-safe subscription attribution for canonical history projections. */
  logicalSubscription(opaqueAccountId: OpaqueAccountId): LogicalHistorySubscriptionV1 | null {
    const account = this.accounts.get(opaqueAccountId);
    return account ? { accountId: account.opaqueAccountId, label: account.label } : null;
  }

  /** Host calls these only with canonical-store projections, never raw frames. */
  publishLogicalConversation(conversation: LogicalConversationProjectionV1): void {
    if (!isLogicalConversationProjection(conversation)) return;
    this.emitAll("history", conversation);
    this.emitAll("conversation", conversation);
  }

  publishLogicalTurn(turn: LogicalTurnProjectionV1): void {
    if (isLogicalTurnProjection(turn)) this.emitAll("turn", turn);
  }

  publishLogicalContinuation(continuation: LogicalContinuationProjectionV1): void {
    if (isLogicalContinuationProjection(continuation)) this.emitAll("continuation", continuation);
  }

  /** Owner-only dynamic account admission after its temporary home is committed. */
  addMaterializedAccount(opaqueAccountId: OpaqueAccountId, label?: string, safeProfile: BrokerSafeProfileV1 = emptySafeProfile()): boolean {
    if (this.closed || !isOpaqueAccountId(opaqueAccountId) || this.accounts.has(opaqueAccountId)) return false;
    if (!isBrokerSafeProfile(safeProfile)) return false;
    this.accounts.set(opaqueAccountId, {
      opaqueAccountId,
      label: label && isSafeProfileLabel(label) ? label : `Account ${this.accounts.size + 1}`,
      safeProfile: { ...safeProfile },
      enabled: true,
      state: "ready",
      assignedTaskCount: 0,
    });
    this.quotas.set(opaqueAccountId, {
      opaqueAccountId, freshness: "unknown", remainingPercent: null, resetAt: null, shortWindowPressure: null, resetCredits: null,
    });
    this.emitAll("profile", this.pool());
    return true;
  }

  /**
   * Called only by the app-server bridge after it has a broker-generated task
   * handle. The private app-server/thread id can be retained internally but is
   * never copied into a control response or event.
   */
  registerTask(input: Readonly<{
    taskRef: OpaqueTaskRef;
    conversationId: OpaqueConversationId;
    opaqueAccountId: OpaqueAccountId;
    ownerRendererRef: OpaqueRendererRef;
    privateThreadKey?: string | null;
    /** True when the owner already exists in the durable ledger. */
    alreadyAssigned?: boolean;
  }>): TaskOwnershipV3 | null {
    if (this.closed || !isOpaqueTaskRef(input.taskRef) || !isOpaqueConversationId(input.conversationId) || !isOpaqueAccountId(input.opaqueAccountId)
      || !isOpaqueRendererRef(input.ownerRendererRef) || !this.sessions.has(input.ownerRendererRef)) return null;
    const existing = this.tasks.get(input.taskRef);
    if (existing) {
      if (existing.opaqueAccountId !== input.opaqueAccountId || existing.conversationId !== input.conversationId) return null;
      // Account ownership is durable, but the reverse app-tools endpoint is
      // an ephemeral per-run binding. A later sequential continuation may
      // bind to its authenticated origin; active or held work never moves.
      if (existing.ownerRendererRef !== input.ownerRendererRef) {
        if (existing.activeRunCount > 0 || existing.handoffState !== "none") return null;
        existing.ownerRendererRef = input.ownerRendererRef;
        this.emit([existing.ownerRendererRef], "continuation", publicTask(existing));
      }
      return publicTask(existing);
    }
    const account = this.accounts.get(input.opaqueAccountId);
    if (!account || !account.enabled || account.state === "disabled") return null;
    const task: MutableTask = {
      taskRef: input.taskRef,
      conversationId: input.conversationId,
      opaqueAccountId: input.opaqueAccountId,
      ownerRendererRef: input.ownerRendererRef,
      activeRunCount: 0,
      handoffState: "none",
      privateThreadKey: boundedPrivateThreadKey(input.privateThreadKey),
    };
    this.tasks.set(task.taskRef, task);
    if (!input.alreadyAssigned) account.assignedTaskCount += 1;
    this.emit([task.ownerRendererRef], "continuation", publicTask(task));
    this.emitAll("profile", this.pool());
    return publicTask(task);
  }

  /** Acquires a lazy account-local worker. No idle worker is killed while active. */
  acquireChild(opaqueAccountId: OpaqueAccountId): BrokerChildV1 | null {
    this.sweep();
    if (this.closed) return null;
    const account = this.accounts.get(opaqueAccountId);
    const resident = this.children.get(opaqueAccountId);
    if (resident) {
      resident.lastUsedAt = this.now();
      return resident.child;
    }
    if (!account || !account.enabled || account.state === "disabled" || account.state === "reauth_required" || account.state === "unhealthy") return null;
    if (!this.options.childFactory || this.children.size >= ACCOUNTS_BROKER_MAX_RESIDENT_CHILDREN) return null;
    try {
      const child = this.options.childFactory.create({ opaqueAccountId, remoteControlDisabled: true, storageScope: "account_local" });
      if (child.opaqueAccountId !== opaqueAccountId || child.remoteControlDisabled !== true) {
        try { child.terminate("capacity"); } catch { /* exact rejected child only */ }
        return null;
      }
      this.children.set(opaqueAccountId, { child, activeRunCount: 0, lastUsedAt: this.now() });
      this.emitAll("profile", this.pool());
      return child;
    } catch {
      return null;
    }
  }

  /** Host calls only after a proved native resume and durable owner commit. */
  transferNativeTask(taskRef: OpaqueTaskRef, from: OpaqueAccountId, to: OpaqueAccountId): boolean {
    const task = this.tasks.get(taskRef);
    if (!task || task.opaqueAccountId !== from || task.activeRunCount !== 0 || !this.accounts.has(to)) return false;
    task.opaqueAccountId = to;
    return true;
  }

  setChildPinned(accountId: OpaqueAccountId, pinned: boolean): void {
    if (pinned) this.pinnedChildren.add(accountId); else this.pinnedChildren.delete(accountId);
  }

  releaseIdleChild(accountId: OpaqueAccountId): BrokerChildV1 | null {
    const resident = this.children.get(accountId);
    if (!resident || resident.activeRunCount > 0 || this.pinnedChildren.has(accountId)) return null;
    this.evictChild(accountId, resident, "idle");
    return resident.child;
  }

  beginRun(taskRef: OpaqueTaskRef): boolean {
    this.sweep();
    const task = this.tasks.get(taskRef);
    if (!task) return false;
    const child = this.acquireChild(task.opaqueAccountId);
    const resident = this.children.get(task.opaqueAccountId);
    const account = this.accounts.get(task.opaqueAccountId);
    if (!child || !resident || !account) return false;
    task.activeRunCount += 1;
    resident.activeRunCount += 1;
    resident.lastUsedAt = this.now();
    account.state = "active";
    this.emit([task.ownerRendererRef], "continuation", publicTask(task));
    this.emitAll("profile", this.pool());
    return true;
  }

  finishRun(taskRef: OpaqueTaskRef): boolean {
    this.sweepExpiredOnly();
    const task = this.tasks.get(taskRef);
    if (!task || task.activeRunCount <= 0) return false;
    const resident = this.children.get(task.opaqueAccountId);
    const account = this.accounts.get(task.opaqueAccountId);
    task.activeRunCount -= 1;
    if (resident) {
      resident.activeRunCount = Math.max(0, resident.activeRunCount - 1);
      resident.lastUsedAt = this.now();
    }
    if (account && !(resident && resident.activeRunCount > 0)) {
      if (account.enabled && account.state === "active") account.state = "ready";
      if (!account.enabled) {
        account.state = "disabled";
        if (resident) this.evictChild(task.opaqueAccountId, resident, "disabled");
      }
    }
    this.emit([task.ownerRendererRef], "continuation", publicTask(task));
    this.emitAll("profile", this.pool());
    return true;
  }

  /** Owner bridge reports an exited child without exposing its process details. */
  markChildUnavailable(opaqueAccountId: OpaqueAccountId): void {
    const resident = this.children.get(opaqueAccountId);
    if (resident) this.children.delete(opaqueAccountId);
    const account = this.accounts.get(opaqueAccountId);
    if (account && account.enabled) account.state = "unhealthy";
    this.emitAll("profile", this.pool());
  }

  /** App-tools routing returns only the origin endpoint handle, never request content. */
  routeAppTools(taskRef: OpaqueTaskRef): BrokerAppToolsRouteV1 | null {
    this.sweep();
    const task = this.tasks.get(taskRef);
    if (!task || task.handoffState === "ambiguous") return null;
    const session = this.sessions.get(task.ownerRendererRef);
    if (!session) return null;
    return { taskRef, appToolsRef: session.appToolsRef, ownerRendererRef: task.ownerRendererRef };
  }

  /** The bridge provides current official quota facts after reducing them locally. */
  updateQuota(projection: QuotaProjectionV3): boolean {
    if (!isQuotaProjection(projection) || !this.accounts.has(projection.opaqueAccountId)) return false;
    const previous = this.quotas.get(projection.opaqueAccountId);
    if (previous && canonicalJson(previous) === canonicalJson(projection)) return true;
    this.quotas.set(projection.opaqueAccountId, { ...projection });
    this.emitAll("quota", { ...projection });
    return true;
  }

  /** Reconcile volatile pool counters with the validated durable ledger. */
  syncAssignedTaskCounts(counts: Readonly<Record<string, number>>): void {
    for (const account of this.accounts.values()) {
      const count = counts[account.opaqueAccountId];
      if (Number.isSafeInteger(count) && count >= 0) account.assignedTaskCount = count;
    }
    this.emitAll("profile", this.pool());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [opaqueAccountId, resident] of this.children) this.evictChild(opaqueAccountId, resident, "shutdown");
    this.children.clear();
    this.sessions.clear();
    this.subscribers.clear();
    this.eventBuffers.clear();
  }

  /**
   * The app-server connection is the authoritative renderer lease. Control
   * socket churn does not call this method, so a second authenticated channel
   * cannot accidentally evict a live desktop. Pending unsent work is
   * cancelled; a forwarding receipt remains terminally ambiguous.
   */
  disconnectRenderer(rendererRef: OpaqueRendererRef): void {
    if (!isOpaqueRendererRef(rendererRef)) return;
    this.sessions.delete(rendererRef);
    this.subscribers.delete(rendererRef);
    this.eventBuffers.delete(rendererRef);
    for (const [handoffRef, handoff] of [...this.handoffs]) {
      if (handoff.originRendererRef !== rendererRef) continue;
      const task = this.tasks.get(handoff.taskRef);
      if (handoff.state === "pending") {
        this.handoffs.delete(handoffRef);
        handoff.state = "cancelled";
        if (task?.handoffState === "pending") task.handoffState = "none";
        try { this.options.onHandoffSettled?.(publicHandoff(handoff), "cancelled"); } catch { /* disconnect cleanup is terminal */ }
        continue;
      }
      if (handoff.state === "forwarding") {
        handoff.state = "ambiguous";
        if (task) task.handoffState = "ambiguous";
        try { this.options.onHandoffSettled?.(publicHandoff(handoff), "ambiguous"); } catch { /* never replay a written uncertainty */ }
      }
    }
  }

  /** Public for deterministic owner lifecycle tests and timer-free process hosts. */
  sweep(): void {
    this.sweepExpiredOnly();
    const now = this.now();
    // Every enabled subscription remains resident. Explicit release is used
    // only by a coordinated writer transfer; disable performs safe drain.
    for (const [nonce, expiry] of this.usedHandshakeNonces) if (expiry <= now) this.usedHandshakeNonces.delete(nonce);
    for (const session of this.sessions.values()) {
      for (const [requestId, consumedAt] of session.usedRequestIds) {
        if (consumedAt + COMMAND_REPLAY_TTL_MS <= now) session.usedRequestIds.delete(requestId);
      }
    }
  }

  private sweepExpiredOnly(): void {
    const now = this.now();
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.state === "waiting" && enrollment.expiresAt !== null && Date.parse(enrollment.expiresAt) <= now) {
        enrollment.state = "expired";
        enrollment.userCode = null;
        enrollment.verificationUrl = null;
        this.emitAll("enrollment", publicEnrollment(enrollment));
        try { this.options.onEnrollmentSettled?.(publicEnrollment(enrollment)); } catch { /* cleanup cannot affect scheduler state */ }
      }
    }
    for (const [handoffRef, handoff] of this.handoffs) {
      if (handoff.state !== "pending" || Date.parse(handoff.expiresAt) > now) continue;
      this.handoffs.delete(handoffRef);
      const task = this.tasks.get(handoff.taskRef);
      if (task && task.handoffState === "pending") {
        task.handoffState = "none";
        this.emit([task.ownerRendererRef], "continuation", publicTask(task));
      }
      handoff.state = "expired";
      try { this.options.onHandoffSettled?.(publicHandoff(handoff), "expired"); } catch { /* expiration never changes account ownership */ }
      this.emit([handoff.originRendererRef], "continuation", publicHandoff(handoff));
    }
  }

  private async execute(session: ClientSession, envelope: BrokerRequestEnvelopeV1): Promise<unknown> {
    if (isRemoteCommand(envelope.command)) {
      const params = envelope.params;
      if (!isPlainRecord(params) || !isOpaqueAccountId(params.opaqueAccountId)
        || Object.keys(params).sort().join("\0") !== (envelope.command === "remote.devices.revoke" ? "deviceId\0opaqueAccountId" : "opaqueAccountId")
        || (envelope.command === "remote.devices.revoke" && (typeof params.deviceId !== "string" || !/^device_[A-Za-z0-9_-]{43}$/.test(params.deviceId)))) throw new BrokerCommandError("invalid_request");
      if (!this.accounts.has(params.opaqueAccountId)) throw new BrokerCommandError("account_unavailable");
      if (!this.options.onRemoteAction) throw new BrokerCommandError("broker_unavailable");
      const result = await this.options.onRemoteAction(envelope.command, params.opaqueAccountId, typeof params.deviceId === "string" ? params.deviceId : undefined);
      if (!isBrokerRemoteProjection(result) || result.accountId !== params.opaqueAccountId) throw new BrokerCommandError("broker_unavailable");
      return result;
    }
    switch (envelope.command) {
      case "profile.statistics": {
        const params = envelope.params;
        if (!isPlainRecord(params) || Object.keys(params).join() !== "selection"
          || (params.selection !== "pooled" && (!isOpaqueAccountId(params.selection) || !this.accounts.has(params.selection)))) throw new BrokerCommandError("invalid_request");
        if (!this.options.onProfileStatistics) throw new BrokerCommandError("broker_unavailable");
        const result = await this.options.onProfileStatistics(params.selection as "pooled" | OpaqueAccountId);
        if (!isNativeProfileStatisticsResultV1(result) || result.selection !== params.selection) throw new BrokerCommandError("broker_unavailable");
        return result;
      }
      case "profile.email": {
        const opaqueAccountId = exactAccountParams(envelope.params);
        if (!this.accounts.has(opaqueAccountId)) throw new BrokerCommandError("account_unavailable");
        const response = await this.dispatchDevice({ kind: "profile.email", opaqueAccountId });
        if (response.outcome !== "accepted" || !isActionEmail(response.value)) throw new BrokerCommandError("account_unavailable");
        return { opaqueAccountId, email: response.value };
      }
      case "profile.read":
        if (!emptyParams(envelope.params)) throw new BrokerCommandError("invalid_request");
        return this.readProfiles();
      case "preferences.read":
        if (!emptyParams(envelope.params)) throw new BrokerCommandError("invalid_request");
        if (!this.options.onPreferencesRead) throw new BrokerCommandError("broker_unavailable");
        return this.options.onPreferencesRead();
      case "preferences.update":
        if (!isAccountsPreferencesPatch(envelope.params)) throw new BrokerCommandError("invalid_request");
        if (!this.options.onPreferencesUpdate) throw new BrokerCommandError("broker_unavailable");
        return this.options.onPreferencesUpdate(envelope.params);
      case "balance.read":
        if (!emptyParams(envelope.params)) throw new BrokerCommandError("invalid_request");
        if (!this.options.onBalanceRead) throw new BrokerCommandError("broker_unavailable");
        return this.options.onBalanceRead();
      case "balance.set": {
        const params = envelope.params;
        if (!isPlainRecord(params) || Object.keys(params).length !== 1 || typeof params.enabled !== "boolean") throw new BrokerCommandError("invalid_request");
        if (!this.options.onBalanceRead || this.options.onBalanceSet?.(params.enabled) !== true) throw new BrokerCommandError("broker_unavailable");
        this.emitAll("profile", this.pool());
        return this.options.onBalanceRead();
      }
      case "history.read":
        if (!emptyParams(envelope.params)) throw new BrokerCommandError("invalid_request");
        return this.options.onHistoryRead?.(session.rendererRef) ?? { conversation: null, turns: [] } satisfies BrokerHistoryReadProjectionV1;
      case "profile.update":
        return this.updateProfile(envelope.params);
      case "quota.read":
        return this.readQuota(envelope.params);
      case "native.request":
        return this.nativeRequest(envelope.params);
      case "events.subscribe":
        if (!emptyParams(envelope.params)) throw new BrokerCommandError("invalid_request");
        return this.events(session.rendererRef);
      case "events.unsubscribe":
        if (!emptyParams(envelope.params)) throw new BrokerCommandError("invalid_request");
        return { subscribed: false };
      case "enrollment.start":
      case "reconnect.start":
        return this.startLifecycle(envelope.command, envelope.params);
      case "enrollment.status":
      case "reconnect.status":
        return this.lifecycleStatus(envelope.command, envelope.params);
      case "enrollment.cancel":
      case "reconnect.cancel":
        return this.cancelLifecycle(envelope.command, envelope.params);
      case "enabled.set":
        return this.setEnabled(envelope.params);
      case "connection.list":
        return this.listConnections(envelope.params);
      case "connection.status":
        return this.connectionStatus(envelope.params);
      case "connection.authorize":
        return this.authorizeConnection(envelope.params);
      case "resetCredit.consume":
        return this.resetCredit(envelope.requestId, envelope.params);
      case "handoff.confirm":
        return this.confirmHandoffFromParams(session.rendererRef, envelope.params);
      case "handoff.cancel":
        return this.cancelHandoffFromParams(session.rendererRef, envelope.params);
      default:
        throw new BrokerCommandError("invalid_request");
    }
  }

  private async startLifecycle(
    command: "enrollment.start" | "reconnect.start",
    params: unknown,
  ): Promise<BrokerEnrollmentV1> {
    const opaqueAccountId = command === "enrollment.start" ? exactEmptyParams(params) : exactAccountParams(params);
    if (opaqueAccountId !== null) {
      const account = this.accounts.get(opaqueAccountId);
      if (!account || !account.enabled || account.state === "disabled" || account.state === "unhealthy") throw new BrokerCommandError("account_unavailable");
    }
    const enrollment: InternalEnrollment = {
      enrollmentRef: opaqueHandle("be") as OpaqueEnrollmentRef,
      kind: command === "enrollment.start" ? "enrollment" : "reconnect",
      opaqueAccountId,
      state: "starting",
      userCode: null,
      verificationUrl: null,
      expiresAt: null,
      loginId: null,
    };
    this.enrollments.set(enrollment.enrollmentRef, enrollment);
    this.emitAll("enrollment", publicEnrollment(enrollment));
    const action = await this.dispatchDevice({ kind: "device.start", enrollmentRef: enrollment.enrollmentRef, opaqueAccountId });
    if (action.outcome !== "accepted" || !applyDeviceStart(enrollment, action.value)) {
      enrollment.state = "failed";
      this.emitAll("enrollment", publicEnrollment(enrollment));
      try { this.options.onEnrollmentSettled?.(publicEnrollment(enrollment)); } catch {}
      throw new BrokerCommandError("broker_unavailable", action.outcome !== "rejected");
    }
    this.emitAll("enrollment", publicEnrollment(enrollment));
    return publicEnrollment(enrollment);
  }

  private async lifecycleStatus(
    command: "enrollment.status" | "reconnect.status",
    params: unknown,
  ): Promise<BrokerEnrollmentV1> {
    const enrollment = this.enrollmentFor(command, params);
    if (enrollment.state === "waiting" && enrollment.loginId) {
      const action = await this.dispatchDevice({
        kind: "device.status",
        enrollmentRef: enrollment.enrollmentRef,
        opaqueAccountId: enrollment.opaqueAccountId,
        loginId: enrollment.loginId,
      });
      let completed = false;
      if (action.outcome === "accepted") completed = applyDeviceStatus(enrollment, action.value);
      else if (action.outcome === "ambiguous") throw new BrokerCommandError("broker_unavailable", true);
      else enrollment.state = "failed";
      if (completed && enrollment.opaqueAccountId === null) {
        let materialized: BrokerMaterializedAccountV1 | OpaqueAccountId | null = null;
        try { materialized = await this.options.onEnrollmentMaterialized?.(publicEnrollment(enrollment)) ?? null; } catch { materialized = null; }
        const opaqueAccountId = typeof materialized === "string" ? materialized : materialized?.opaqueAccountId ?? null;
        const safeProfile = typeof materialized === "string" ? emptySafeProfile() : materialized?.safeProfile ?? emptySafeProfile();
        if (!opaqueAccountId || !this.addMaterializedAccount(opaqueAccountId, undefined, safeProfile)) {
          enrollment.state = "failed";
          try { this.options.onEnrollmentSettled?.(publicEnrollment(enrollment)); } catch {}
        }
        else enrollment.opaqueAccountId = opaqueAccountId;
      }
      this.emitAll("enrollment", publicEnrollment(enrollment));
    }
    return publicEnrollment(enrollment);
  }

  private async cancelLifecycle(
    command: "enrollment.cancel" | "reconnect.cancel",
    params: unknown,
  ): Promise<BrokerEnrollmentV1> {
    const enrollment = this.enrollmentFor(command, params);
    if (enrollment.state === "waiting" && enrollment.loginId) {
      const action = await this.dispatchDevice({
        kind: "device.cancel",
        enrollmentRef: enrollment.enrollmentRef,
        opaqueAccountId: enrollment.opaqueAccountId,
        loginId: enrollment.loginId,
      });
      if (action.outcome !== "accepted") throw new BrokerCommandError("broker_unavailable", action.outcome === "ambiguous");
    }
    enrollment.state = "cancelled";
    enrollment.userCode = null;
    enrollment.verificationUrl = null;
    this.emitAll("enrollment", publicEnrollment(enrollment));
    try { this.options.onEnrollmentSettled?.(publicEnrollment(enrollment)); } catch {}
    return publicEnrollment(enrollment);
  }

  private enrollmentFor(
    command: "enrollment.status" | "reconnect.status" | "enrollment.cancel" | "reconnect.cancel",
    params: unknown,
  ): InternalEnrollment {
    const enrollmentRef = exactEnrollmentParams(params);
    const enrollment = this.enrollments.get(enrollmentRef);
    if (!enrollment || (command.startsWith("reconnect") ? enrollment.kind !== "reconnect" : enrollment.kind !== "enrollment")) {
      throw new BrokerCommandError("account_unavailable");
    }
    return enrollment;
  }

  private async dispatchDevice(action: BrokerDeviceActionV1): Promise<BrokerDeviceActionResultV1> {
    if (!this.options.onDeviceAction) throw new BrokerCommandError("broker_unavailable", true);
    let result: BrokerDeviceActionResultV1;
    try {
      result = await this.options.onDeviceAction(action);
    } catch {
      throw new BrokerCommandError("broker_unavailable", true);
    }
    if (!isDeviceActionResult(result)) throw new BrokerCommandError("broker_unavailable", true);
    return result;
  }

  private updateProfile(params: unknown): AccountPoolAccountV3 {
    if (!isPlainRecord(params) || Object.keys(params).sort().join("\0") !== ["label", "opaqueAccountId"].join("\0")
      || !isOpaqueAccountId(params.opaqueAccountId) || !isSafeProfileLabel(params.label)) {
      throw new BrokerCommandError("invalid_request");
    }
    const account = this.accounts.get(params.opaqueAccountId);
    if (!account) throw new BrokerCommandError("account_unavailable");
    if (this.options.onAccountSettingsChanged?.({ opaqueAccountId: account.opaqueAccountId, label: params.label }) === false) {
      throw new BrokerCommandError("broker_unavailable", true);
    }
    account.label = params.label;
    this.emitAll("profile", this.pool());
    return this.accountProjection(account);
  }

  /**
   * Explicit profile reads refresh only bounded display facts for enabled
   * accounts.  A temporarily unavailable child leaves its prior safe facts in
   * place rather than turning a profile read into an account-login oracle.
   */
  private readProfiles(): AccountPoolV3 {
    const cached = this.pool();
    if (!this.options.onDeviceAction || this.profileRefresh || this.closed) return cached;
    // Cached rows must never wait behind cold account startup or network reads.
    // Each successful account refresh updates subscribers independently.
    const accounts = [...this.accounts.values()].filter((account) => account.enabled && account.state !== "disabled");
    this.profileRefresh = Promise.allSettled(accounts.map(async (account) => {
      const action = await this.dispatchDevice({ kind: "profile.read", opaqueAccountId: account.opaqueAccountId });
      if (this.closed || this.accounts.get(account.opaqueAccountId) !== account || !account.enabled || account.state === "disabled"
        || action.outcome !== "accepted" || !isBrokerSafeProfile(action.value)
        || canonicalJson(account.safeProfile) === canonicalJson(action.value)) return;
      account.safeProfile = { ...action.value };
      this.emitAll("profile", this.pool());
    })).then(() => undefined).finally(() => { this.profileRefresh = null; });
    return cached;
  }

  private async readQuota(params: unknown): Promise<QuotaProjectionV3[]> {
    let targets: OpaqueAccountId[];
    if (emptyParams(params)) targets = [...this.accounts.values()].filter((account) => account.enabled).map((account) => account.opaqueAccountId);
    else if (isPlainRecord(params) && Object.keys(params).length === 1 && isOpaqueAccountId(params.opaqueAccountId) && this.accounts.has(params.opaqueAccountId)) targets = [params.opaqueAccountId];
    else throw new BrokerCommandError("invalid_request");
    for (let offset = 0; offset < targets.length; offset += 4) {
      await Promise.all(targets.slice(offset, offset + 4).map((account) => this.refreshQuota(account)));
    }
    return this.quota();
  }

  private refreshQuota(opaqueAccountId: OpaqueAccountId): Promise<void> {
    const active = this.quotaRefreshes.get(opaqueAccountId);
    if (active) return active;
    const attemptedAt = new Date(this.now()).toISOString();
    const previous = this.quotas.get(opaqueAccountId) ?? {
      opaqueAccountId, freshness: "unknown" as const, remainingPercent: null, resetAt: null,
      shortWindowPressure: null, resetCredits: null,
    };
    this.updateQuota({ ...previous, refreshState: "loading", errorCode: null, lastAttemptAt: attemptedAt });
    const refresh = this.dispatchDevice({ kind: "quota.read", opaqueAccountId }).then((action) => {
      if (action.outcome === "accepted") {
        const projection = quotaFromProviderValue(opaqueAccountId, action.value);
        if (projection) {
          this.updateQuota({ ...projection, refreshState: "idle", errorCode: null, lastAttemptAt: attemptedAt });
          return;
        }
      }
      const cached = this.quotas.get(opaqueAccountId) ?? previous;
      const errorCode = action.outcome === "ambiguous" ? "connection" : "unavailable";
      this.updateQuota({ ...cached, refreshState: "error", errorCode, lastAttemptAt: attemptedAt });
    }).catch(() => {
      const cached = this.quotas.get(opaqueAccountId) ?? previous;
      this.updateQuota({ ...cached, refreshState: "error", errorCode: "connection", lastAttemptAt: attemptedAt });
    }).finally(() => this.quotaRefreshes.delete(opaqueAccountId));
    this.quotaRefreshes.set(opaqueAccountId, refresh);
    return refresh;
  }

  private async nativeRequest(params: unknown): Promise<import("./types").NativeRequestResultV1> {
    if (!isPlainRecord(params) || !isOpaqueAccountId(params.opaqueAccountId) || !this.accounts.has(params.opaqueAccountId)) {
      throw new BrokerCommandError("invalid_request");
    }
    const request = parseNativeRequestV1({ surface: params.surface, method: params.method, params: params.params });
    if (!request || Object.keys(params).sort().join("\0") !== "method\0opaqueAccountId\0params\0surface") {
      throw new BrokerCommandError("invalid_request");
    }
    if (request.method.startsWith("browser.")) throw new BrokerCommandError("invalid_request");
    const account = this.accounts.get(params.opaqueAccountId)!;
    if (!account.enabled || account.state === "disabled" || account.state === "reauth_required" || account.state === "unhealthy") {
      throw new BrokerCommandError("account_unavailable");
    }
    const action = await this.dispatchDevice({ kind: "native.request", opaqueAccountId: params.opaqueAccountId, ...request });
    if (action.outcome !== "accepted" || !isBoundedNativeResultV1(action.value, request.surface)) {
      throw new BrokerCommandError("broker_unavailable", action.outcome === "ambiguous");
    }
    return { opaqueAccountId: params.opaqueAccountId, surface: request.surface, result: action.value };
  }

  private setEnabled(params: unknown): AccountPoolAccountV3 {
    if (!isPlainRecord(params) || Object.keys(params).sort().join("\0") !== ["enabled", "opaqueAccountId"].join("\0")
      || !isOpaqueAccountId(params.opaqueAccountId) || typeof params.enabled !== "boolean") {
      throw new BrokerCommandError("invalid_request");
    }
    const accountId = params.opaqueAccountId;
    const account = this.accounts.get(accountId);
    if (!account) throw new BrokerCommandError("account_unavailable");
    if (this.options.onAccountSettingsChanged?.({ opaqueAccountId: accountId, enabled: params.enabled }) === false) {
      throw new BrokerCommandError("broker_unavailable", true);
    }
    if (!params.enabled) {
      account.enabled = false;
      // Existing tasks remain pinned and account-local; only new allocation is stopped.
      if (!this.hasActiveRun(accountId)) {
        account.state = "disabled";
        const resident = this.children.get(accountId);
        if (resident) this.evictChild(accountId, resident, "disabled");
      }
    } else {
      account.enabled = true;
      if (account.state === "disabled") account.state = "ready";
    }
    this.emitAll("profile", this.pool());
    return this.accountProjection(account);
  }

  private async listConnections(params: unknown): Promise<ConnectionStateV3[]> {
    const input = exactConnectionScopeParams(params, false);
    const action = await this.dispatchDevice({ kind: "connection.list", opaqueAccountId: input.opaqueAccountId, connectionKind: input.kind });
    if (action.outcome !== "accepted") {
      const cached = this.cachedUnavailableConnections(input.opaqueAccountId, input.kind);
      if (input.kind === "plugin" && cached.length > 0) return cached;
      throw new BrokerCommandError("broker_unavailable", action.outcome === "ambiguous");
    }
    this.applyConnectionStates(input.opaqueAccountId, input.kind, action.value, true);
    return this.connectionStates().filter((connection) => connection.opaqueAccountId === input.opaqueAccountId && connection.kind === input.kind);
  }

  private async connectionStatus(params: unknown): Promise<ConnectionStateV3[]> {
    const input = exactConnectionScopeParams(params, true);
    const action = await this.dispatchDevice({
      kind: "connection.status", opaqueAccountId: input.opaqueAccountId, connectionKind: input.kind, definitionRef: input.definitionRef!,
    });
    if (action.outcome !== "accepted") {
      const cached = this.cachedUnavailableConnections(input.opaqueAccountId, input.kind, input.definitionRef);
      if (input.kind === "plugin" && cached.length > 0) return cached;
      throw new BrokerCommandError("broker_unavailable", action.outcome === "ambiguous");
    }
    this.applyConnectionStates(input.opaqueAccountId, input.kind, action.value);
    return this.connectionStates().filter((connection) => connection.opaqueAccountId === input.opaqueAccountId
      && connection.kind === input.kind && connection.definitionRef === input.definitionRef);
  }

  private async authorizeConnection(params: unknown): Promise<{
    opaqueAccountId: OpaqueAccountId;
    kind: BrokerConnectionKind;
    definitionRef: OpaqueConnectionDefinitionRef;
    state: "submitted";
    /** Ephemeral, initiating-renderer-only OAuth handoff; never emitted or persisted. */
    oauthUrl: string;
  }> {
    if (!isPlainRecord(params) || Object.keys(params).sort().join("\0") !== ["definitionRef", "kind", "opaqueAccountId"].join("\0")
      || !isOpaqueAccountId(params.opaqueAccountId) || !this.accounts.has(params.opaqueAccountId)
      || !isBrokerConnectionKind(params.kind) || !isOpaqueConnectionDefinitionRef(params.definitionRef)) {
      throw new BrokerCommandError("invalid_request");
    }
    // Only MCP OAuth is a supported Accounts authorization action. App,
    // plugin, and workspace rows remain display-only even if a forged
    // renderer envelope reaches this private broker seam.
    if (params.kind !== "mcp") throw new BrokerCommandError("account_unavailable");
    const action = await this.dispatchDevice({
      kind: "connection.authorize", opaqueAccountId: params.opaqueAccountId, connectionKind: params.kind, definitionRef: params.definitionRef,
    });
    if (action.outcome !== "accepted") throw new BrokerCommandError("broker_unavailable", action.outcome === "ambiguous");
    const oauthUrl = oauthUrlFromDeviceValue(action.value);
    if (!oauthUrl) throw new BrokerCommandError("provider_confirmation_required", false);
    const key = connectionKey(params.opaqueAccountId, params.kind, params.definitionRef);
    const prior = this.connections.get(key);
    // A concurrent catalog refresh may remove this row during OAuth. Do not
    // resurrect it or grow the cache after the native operation has succeeded.
    if (prior) this.connections.set(key, {
      opaqueAccountId: params.opaqueAccountId,
      kind: params.kind,
      definitionRef: params.definitionRef,
      ...(prior.displayLabel ? { displayLabel: prior.displayLabel } : {}),
      status: "connecting",
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (prior && prior.status !== "connecting") this.emitAll("connection", this.connectionStates());
    return {
      opaqueAccountId: params.opaqueAccountId,
      kind: params.kind,
      definitionRef: params.definitionRef,
      state: "submitted",
      oauthUrl,
    };
  }

  private async resetCredit(requestId: string, params: unknown): Promise<{ opaqueAccountId: OpaqueAccountId; consumed: boolean; quota: QuotaProjectionV3 }> {
    if (!isPlainRecord(params) || Object.keys(params).length !== 1
      || !isOpaqueAccountId(params.opaqueAccountId) || !this.accounts.has(params.opaqueAccountId)) {
      throw new BrokerCommandError("invalid_request");
    }
    const idempotencyKey = `broker-reset-${createHmac("sha256", this.options.secret).update(requestId, "utf8").digest("base64url")}`;
    const action = await this.dispatchDevice({ kind: "resetCredit.consume", opaqueAccountId: params.opaqueAccountId, idempotencyKey });
    if (action.outcome !== "accepted") throw new BrokerCommandError("broker_unavailable", action.outcome === "ambiguous");
    const consumed = isPlainRecord(action.value) && action.value.outcome === "reset";
    const quotaAction = await this.dispatchDevice({ kind: "quota.read", opaqueAccountId: params.opaqueAccountId });
    if (quotaAction.outcome === "accepted") this.applyQuota(params.opaqueAccountId, quotaAction.value);
    const quota = this.quotas.get(params.opaqueAccountId);
    if (!quota) throw new BrokerCommandError("broker_unavailable", true);
    this.emitAll("quota", this.quota());
    return { opaqueAccountId: params.opaqueAccountId, consumed, quota: { ...quota } };
  }

  private applyQuota(opaqueAccountId: OpaqueAccountId, value: unknown): void {
    const projection = quotaFromProviderValue(opaqueAccountId, value);
    if (!projection) return;
    this.quotas.set(opaqueAccountId, projection);
  }

  private applyConnectionStates(opaqueAccountId: OpaqueAccountId, kind: BrokerConnectionKind, value: unknown, replaceScope = false): void {
    const states = connectionStatesFromProviderValue(opaqueAccountId, kind, value, this.now);
    if (!states) throw new BrokerCommandError("broker_unavailable");
    const priorKeys = replaceScope ? [...this.connections.entries()]
      .filter(([, state]) => state.opaqueAccountId === opaqueAccountId && state.kind === kind).map(([key]) => key) : [];
    const nextKeys = new Set(states.map((state) => connectionKey(state.opaqueAccountId, state.kind, state.definitionRef)));
    // A fresh observation timestamp is not a provider state change. Emitting
    // on every read makes native connection surfaces immediately read again.
    const changed = priorKeys.some((key) => !nextKeys.has(key)) || states.some((state) => {
      const previous = this.connections.get(connectionKey(state.opaqueAccountId, state.kind, state.definitionRef));
      return !previous || previous.status !== state.status || previous.displayLabel !== state.displayLabel;
    });
    const prior = new Set(priorKeys);
    const additions = states.filter((state) => {
      const key = connectionKey(state.opaqueAccountId, state.kind, state.definitionRef);
      return prior.has(key) || !this.connections.has(key);
    }).length;
    if (this.connections.size - priorKeys.length + additions > MAX_CONNECTIONS) throw new BrokerCommandError("capacity_held");
    for (const key of priorKeys) this.connections.delete(key);
    for (const state of states) this.connections.set(connectionKey(state.opaqueAccountId, state.kind, state.definitionRef), state);
    if (changed) this.emitAll("connection", this.connectionStates());
  }

  private cachedUnavailableConnections(
    opaqueAccountId: OpaqueAccountId,
    kind: BrokerConnectionKind,
    definitionRef?: OpaqueConnectionDefinitionRef,
  ): ConnectionStateV3[] {
    const updatedAt = new Date(this.now()).toISOString();
    const cached = this.connectionStates().filter((connection) => connection.opaqueAccountId === opaqueAccountId
      && connection.kind === kind && (definitionRef === undefined || connection.definitionRef === definitionRef));
    if (kind !== "plugin" || cached.length === 0) return [];
    const changed = cached.some((connection) => connection.status !== "unavailable");
    for (const connection of cached) {
      this.connections.set(connectionKey(connection.opaqueAccountId, connection.kind, connection.definitionRef), {
        ...connection,
        status: "unavailable",
        updatedAt,
      });
    }
    const unavailable = this.connectionStates().filter((connection) => connection.opaqueAccountId === opaqueAccountId
      && connection.kind === kind && (definitionRef === undefined || connection.definitionRef === definitionRef));
    if (changed) this.emitAll("connection", this.connectionStates());
    return unavailable;
  }

  private async confirmHandoffFromParams(rendererRef: OpaqueRendererRef, params: unknown): Promise<PendingHandoffV1> {
    const { handoffRef, toOpaqueAccountId } = exactConfirmHandoffParams(params);
    return this.confirmHandoff(rendererRef, handoffRef, toOpaqueAccountId);
  }

  private cancelHandoffFromParams(rendererRef: OpaqueRendererRef, params: unknown): { status: "cancelled" } {
    const handoffRef = exactHandoffParams(params);
    return this.cancelHandoff(rendererRef, handoffRef);
  }

  /** Bridge-only helper retains continuation in memory for one bounded handoff window. */
  holdContinuation(input: Readonly<{
    fromRendererRef: OpaqueRendererRef;
    taskRef: OpaqueTaskRef;
    toOpaqueAccountId: OpaqueAccountId;
    continuation: unknown;
  }>): PendingHandoffV1 | null {
    try {
      return this.createHandoff(input.fromRendererRef, input.taskRef, input.toOpaqueAccountId, input.continuation);
    } catch {
      return null;
    }
  }

  /** Host-only automatic settlement; provider depletion must still be current. */
  async continueAutomatically(rendererRef: OpaqueRendererRef, handoffRef: OpaqueHandoffRef): Promise<boolean> {
    const handoff = this.handoffs.get(handoffRef);
    if (!handoff || !hasConfirmedQuotaDepletion(this.quotas.get(handoff.fromOpaqueAccountId), this.now())) return false;
    try { await this.confirmHandoff(rendererRef, handoffRef); return true; } catch { return false; }
  }

  private createHandoff(
    fromRendererRef: OpaqueRendererRef,
    taskRef: OpaqueTaskRef,
    toOpaqueAccountId: OpaqueAccountId,
    continuation: unknown,
  ): PendingHandoffV1 {
    this.sweep();
    const task = this.tasks.get(taskRef);
    const target = this.accounts.get(toOpaqueAccountId);
    if (!task || task.ownerRendererRef !== fromRendererRef || !target || !target.enabled
      || target.state === "disabled" || target.state === "reauth_required" || target.state === "unhealthy"
      || task.opaqueAccountId === toOpaqueAccountId
      || !hasFreshPositiveQuota(this.quotas.get(toOpaqueAccountId), this.now())) {
      throw new BrokerCommandError("handoff_unavailable");
    }
    if (task.activeRunCount > 0) throw new BrokerCommandError("handoff_active", true);
    if (task.handoffState !== "none") throw new BrokerCommandError("handoff_unavailable");
    if (this.handoffs.size >= MAX_PENDING_HANDOFFS) throw new BrokerCommandError("capacity_held", true);
    const handoff: InternalPendingHandoff = {
      version: 1,
      handoffRef: opaqueHandle("bh") as OpaqueHandoffRef,
      confirmationId: opaqueHandle("bc") as OpaqueConfirmationId,
      conversationId: task.conversationId,
      taskRef,
      originRendererRef: fromRendererRef,
      fromOpaqueAccountId: task.opaqueAccountId,
      toOpaqueAccountId,
      state: "pending",
      expiresAt: new Date(this.now() + this.handoffTtlMs).toISOString(),
      continuation,
      deliveryAttempted: false,
    };
    task.handoffState = "pending";
    this.handoffs.set(handoff.handoffRef, handoff);
    try {
      this.options.onHandoffCreated?.(publicHandoff(handoff));
    } catch {
      this.handoffs.delete(handoff.handoffRef);
      task.handoffState = "none";
      throw new BrokerCommandError("broker_unavailable", true);
    }
    this.emit([fromRendererRef], "continuation", publicHandoff(handoff));
    this.emit([fromRendererRef], "continuation", publicTask(task));
    return publicHandoff(handoff);
  }

  private async confirmHandoff(rendererRef: OpaqueRendererRef, handoffRef: OpaqueHandoffRef, requestedTarget?: OpaqueAccountId): Promise<PendingHandoffV1> {
    this.sweep();
    const handoff = this.handoffs.get(handoffRef);
    if (!handoff) throw new BrokerCommandError("handoff_expired");
    if (handoff.state === "ambiguous") throw new BrokerCommandError("handoff_ambiguous", false);
    if (handoff.state !== "pending" || handoff.originRendererRef !== rendererRef) throw new BrokerCommandError("handoff_unavailable");
    const task = this.tasks.get(handoff.taskRef);
    if (!task || task.ownerRendererRef !== handoff.originRendererRef || task.opaqueAccountId !== handoff.fromOpaqueAccountId) throw new BrokerCommandError("handoff_unavailable");
    if (task.activeRunCount > 0) throw new BrokerCommandError("handoff_active", true);
    if (requestedTarget && requestedTarget !== handoff.toOpaqueAccountId) {
      const target = this.accounts.get(requestedTarget);
      if (!target || !target.enabled || target.state === "disabled" || target.state === "reauth_required" || target.state === "unhealthy"
        || requestedTarget === handoff.fromOpaqueAccountId
        || !hasFreshPositiveQuota(this.quotas.get(requestedTarget), this.now())) throw new BrokerCommandError("handoff_unavailable");
      // A user may choose only an idle eligible subscription.  We retarget
      // before dispatching, never after a provider write has begun.
      if (this.hasActiveRun(requestedTarget)) throw new BrokerCommandError("handoff_active", true);
      handoff.toOpaqueAccountId = requestedTarget;
      try { this.options.onHandoffRetargeted?.(publicHandoff(handoff)); }
      catch { throw new BrokerCommandError("broker_unavailable", true); }
      this.emit([handoff.originRendererRef], "continuation", publicHandoff(handoff));
    }
    // The proposed target may have changed state while the user reviewed the
    // confirmation. Never treat reset credits, stale readings, or a 0% fresh
    // reading as delivery capacity; leave the held continuation pending for a
    // later explicitly chosen fresh destination.
    if (!hasFreshPositiveQuota(this.quotas.get(handoff.toOpaqueAccountId), this.now())) {
      throw new BrokerCommandError("handoff_unavailable", false);
    }

    // The host writes a bounded `forwarding` receipt before its one allowed
    // child write, and durably commits the account owner only after that write
    // is accepted.  Core changes its mirror only after the host reports the
    // atomic ledger update.  A failure can therefore never be retried.
    handoff.state = "forwarding";
    handoff.deliveryAttempted = true;
    let delivery: BrokerHandoffDeliveryResultV1 = "delivered";
    try {
      delivery = await this.options.onForwardContinuation?.({
        handoffRef: handoff.handoffRef,
        confirmationId: handoff.confirmationId,
        conversationId: handoff.conversationId,
        taskRef: handoff.taskRef,
        originRendererRef: handoff.originRendererRef,
        fromOpaqueAccountId: handoff.fromOpaqueAccountId,
        toOpaqueAccountId: handoff.toOpaqueAccountId,
        continuation: handoff.continuation,
      }) ?? "delivered";
    } catch {
      delivery = "ambiguous";
    }
    if (delivery === "linked_continuation_required") {
      // The host proved before destination acquisition that carrying this
      // continuation would lose unsafe/nonportable context.  It has written
      // only a content-free source receipt, so this handoff is safely
      // cancelled rather than ambiguous and must surface distinctly.
      task.handoffState = "none";
      handoff.state = "cancelled";
      this.handoffs.delete(handoff.handoffRef);
      try { this.options.onHandoffSettled?.(publicHandoff(handoff), "linked_continuation_required"); } catch { /* source receipt is already terminal */ }
      this.emit([handoff.originRendererRef], "continuation", publicHandoff(handoff));
      this.emit([task.ownerRendererRef], "continuation", publicTask(task));
      throw new BrokerCommandError("linked_continuation_required", false);
    }
    if (delivery === "rejected") {
      // `rejected` is reserved for host-proven pre-dispatch failures. It is
      // safe to cancel the held request and let the user select another
      // eligible subscription; it must never be recorded as ambiguity.
      task.handoffState = "none";
      handoff.state = "cancelled";
      this.handoffs.delete(handoff.handoffRef);
      try { this.options.onHandoffSettled?.(publicHandoff(handoff), "rejected"); } catch { /* no provider turn was written */ }
      this.emit([handoff.originRendererRef], "continuation", publicHandoff(handoff));
      this.emit([task.ownerRendererRef], "continuation", publicTask(task));
      throw new BrokerCommandError("handoff_unavailable", false);
    }
    if (delivery !== "delivered") {
      task.handoffState = "ambiguous";
      handoff.state = "ambiguous";
      this.handoffs.set(handoff.handoffRef, handoff);
      try { this.options.onHandoffSettled?.(publicHandoff(handoff), "ambiguous"); } catch { /* terminal ambiguity remains fail-closed */ }
      this.emit([handoff.originRendererRef], "continuation", publicHandoff(handoff));
      this.emit([task.ownerRendererRef], "continuation", publicTask(task));
      throw new BrokerCommandError("handoff_ambiguous", false);
    }
    // Native-thread ownership is immutable. The host has created a separate
    // target-account segment before reporting delivery; this source task stays
    // bound to its original private thread and account forever.
    task.handoffState = "none";
    this.handoffs.delete(handoff.handoffRef);
    this.emit([handoff.originRendererRef], "continuation", publicHandoff({ ...handoff, state: "forwarding" }));
    this.emit([task.ownerRendererRef], "continuation", publicTask(task));
    this.emitAll("profile", this.pool());
    return publicHandoff({ ...handoff, state: "forwarding" });
  }

  private cancelHandoff(rendererRef: OpaqueRendererRef, handoffRef: OpaqueHandoffRef): { status: "cancelled" } {
    this.sweep();
    const handoff = this.handoffs.get(handoffRef);
    if (!handoff || handoff.state !== "pending" || handoff.originRendererRef !== rendererRef) throw new BrokerCommandError("handoff_unavailable");
    this.handoffs.delete(handoffRef);
    const task = this.tasks.get(handoff.taskRef);
    if (task && task.ownerRendererRef === handoff.originRendererRef && task.opaqueAccountId === handoff.fromOpaqueAccountId) {
      task.handoffState = "none";
      this.emit([task.ownerRendererRef], "continuation", publicTask(task));
    }
    handoff.state = "cancelled";
    try { this.options.onHandoffSettled?.(publicHandoff(handoff), "cancelled"); } catch { /* durable cleanup is best effort after cancellation */ }
    this.emit([handoff.originRendererRef], "continuation", publicHandoff(handoff));
    return { status: "cancelled" };
  }

  private hasActiveRun(opaqueAccountId: OpaqueAccountId): boolean {
    return (this.children.get(opaqueAccountId)?.activeRunCount ?? 0) > 0;
  }

  private accountProjection(account: MutableAccount): AccountPoolAccountV3 {
    const resident = this.children.get(account.opaqueAccountId);
    const activeRunCount = resident?.activeRunCount ?? 0;
    return {
      opaqueAccountId: account.opaqueAccountId,
      label: account.label,
      safeProfile: { ...account.safeProfile },
      enabled: account.enabled,
      state: account.state,
      childState: resident ? (activeRunCount > 0 ? "active" : "resident") : (account.enabled ? "absent" : "evicted"),
      activeRunCount,
      assignedTaskCount: account.assignedTaskCount,
      ...(this.options.onAccountContinuityRead?.(account.opaqueAccountId) ?? {}),
    };
  }

  private evictChild(opaqueAccountId: OpaqueAccountId, resident: ResidentChild, reason: "idle" | "shutdown" | "capacity" | "disabled"): void {
    if (resident.activeRunCount > 0) return;
    this.children.delete(opaqueAccountId);
    try { resident.child.terminate(reason); } catch { /* exact owned child only */ }
  }

  private emitAll(type: BrokerEventType, payload: BrokerEventV1["payload"]): void {
    this.emit([...this.sessions.keys()], type, payload);
  }

  private emit(targets: readonly OpaqueRendererRef[], type: BrokerEventType, payload: BrokerEventV1["payload"]): void {
    const uniqueTargets = [...new Set(targets)].filter((target) => this.sessions.has(target));
    if (uniqueTargets.length === 0) return;
    if (!isBrokerEventPayload(type, payload)) return;
    const event: BrokerEventV1 = { version: 1, sequence: ++this.sequence, type, payload: cloneEventPayload(payload) };
    try { assertBrokerRedacted(event); } catch { return; }
    for (const rendererRef of uniqueTargets) {
      const buffer = this.eventBuffers.get(rendererRef) ?? [];
      buffer.push(event);
      if (buffer.length > MAX_EVENTS_PER_CLIENT) buffer.splice(0, buffer.length - MAX_EVENTS_PER_CLIENT);
      this.eventBuffers.set(rendererRef, buffer);
      for (const handler of this.subscribers.get(rendererRef) ?? []) {
        try { handler(event); } catch { /* an observer cannot affect broker routing */ }
      }
    }
  }
}

/** Build the redacted, lazy-pool seed directly from a validated v3 router config. */
export function accountPoolSeedsFromRouterConfigV3(
  config: RouterConfigV3,
  ledger?: Readonly<Record<string, { assignedThreadCount: number }>>,
): BrokerAccountSeedV3[] {
  return config.accounts.map((account) => ({
    opaqueAccountId: account.opaqueAccountId,
    enabled: account.included,
    label: account.label,
    state: account.included ? "ready" : "disabled",
    assignedTaskCount: ledger?.[account.opaqueAccountId]?.assignedThreadCount ?? 0,
  }));
}

export function createBrokerHandshakeProof(secret: Buffer, input: Omit<BrokerHandshakeV1, "proof">): string {
  if (secret.byteLength !== 32) throw new Error("accounts broker requires a 256-bit owner-private capability");
  return `hmac-sha256:${createHmac("sha256", secret).update(canonicalJson({
    version: input.version,
    clientKind: input.clientKind,
    rendererRef: input.rendererRef,
    appToolsRef: input.appToolsRef,
    nonce: input.nonce,
  }), "utf8").digest("base64url")}`;
}

export function verifyBrokerHandshake(secret: Buffer, handshake: BrokerHandshakeV1): boolean {
  try {
    if (secret.byteLength !== 32 || !isValidBrokerHandshake(handshake)) return false;
    const expected = Buffer.from(createBrokerHandshakeProof(secret, {
      version: handshake.version,
      clientKind: handshake.clientKind,
      rendererRef: handshake.rendererRef,
      appToolsRef: handshake.appToolsRef,
      nonce: handshake.nonce,
    }), "utf8");
    const actual = Buffer.from(handshake.proof, "utf8");
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createOpaqueRendererRef(
  secret: Buffer,
  webContentsId: number,
  binding: BrokerDesktopIdentityBindingV1,
): OpaqueRendererRef {
  if (secret.byteLength !== 32 || !Number.isSafeInteger(webContentsId) || webContentsId <= 0 || !isDesktopIdentityBinding(binding)) {
    throw new Error("invalid accounts renderer identity");
  }
  return `br_${createHmac("sha256", secret).update(`renderer:v2:${binding.clientKind}:${binding.bundleIdentity}:${binding.sessionNonce}:${webContentsId}`, "utf8").digest("base64url")}`;
}

export function createOpaqueAppToolsRef(
  secret: Buffer,
  webContentsId: number,
  binding: BrokerDesktopIdentityBindingV1,
): OpaqueAppToolsRef {
  if (secret.byteLength !== 32 || !Number.isSafeInteger(webContentsId) || webContentsId <= 0 || !isDesktopIdentityBinding(binding)) {
    throw new Error("invalid accounts app-tools identity");
  }
  return `bat_${createHmac("sha256", secret).update(`app-tools:v2:${binding.clientKind}:${binding.bundleIdentity}:${binding.sessionNonce}:${webContentsId}`, "utf8").digest("base64url")}`;
}

function isDesktopIdentityBinding(value: unknown): value is BrokerDesktopIdentityBindingV1 {
  return isPlainRecord(value) && (value.clientKind === "chatgpt" || value.clientKind === "tweakers")
    && typeof value.bundleIdentity === "string" && /^[A-Za-z0-9.-]{3,128}$/.test(value.bundleIdentity)
    && typeof value.sessionNonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.sessionNonce);
}

export class BrokerCommandError extends Error {
  constructor(readonly code: BrokerErrorCode, readonly retryable = false) {
    super(code);
  }
}

function brokerFailure(requestId: string, code: BrokerErrorCode, retryable: boolean): BrokerResponseV1 {
  return { version: ACCOUNTS_BROKER_VERSION, requestId, ok: false, error: { code, retryable } };
}

function brokerErrorCode(error: unknown): BrokerErrorCode {
  return error instanceof BrokerCommandError ? error.code : "broker_unavailable";
}

function isRetryableBrokerError(error: unknown): boolean {
  return error instanceof BrokerCommandError && error.retryable;
}

function requestIdFrom(value: unknown): string {
  return isPlainRecord(value) && typeof value.requestId === "string" && validRequestId(value.requestId) ? value.requestId : "invalid";
}

function isBrokerRequestEnvelope(value: unknown): value is BrokerRequestEnvelopeV1 {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["version", "requestId", "command", "params"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== ACCOUNTS_BROKER_VERSION || !validRequestId(value.requestId)) return false;
  return value.command === "enrollment.start" || value.command === "enrollment.status" || value.command === "enrollment.cancel"
    || value.command === "reconnect.start" || value.command === "reconnect.status" || value.command === "reconnect.cancel"
    || value.command === "profile.read" || value.command === "history.read" || value.command === "profile.update" || value.command === "enabled.set"
    || isRemoteCommand(value.command)
    || value.command === "profile.statistics"
    || value.command === "profile.email"
    || value.command === "preferences.read" || value.command === "preferences.update"
    || value.command === "balance.read" || value.command === "balance.set"
    || value.command === "quota.read" || value.command === "native.request" || value.command === "connection.list" || value.command === "connection.status"
    || value.command === "connection.authorize" || value.command === "resetCredit.consume"
    || value.command === "handoff.confirm" || value.command === "handoff.cancel"
    || value.command === "events.subscribe" || value.command === "events.unsubscribe";
}

function isValidBrokerHandshake(value: unknown): value is BrokerHandshakeV1 {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["version", "clientKind", "rendererRef", "appToolsRef", "nonce", "proof"].includes(key))) return false;
  return value.version === ACCOUNTS_BROKER_VERSION && (value.clientKind === "chatgpt" || value.clientKind === "tweakers")
    && isOpaqueRendererRef(value.rendererRef) && isOpaqueAppToolsRef(value.appToolsRef)
    && typeof value.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.nonce)
    && typeof value.proof === "string" && /^hmac-sha256:[A-Za-z0-9_-]{32,128}$/.test(value.proof);
}

function exactAccountParams(value: unknown): OpaqueAccountId {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !isOpaqueAccountId(value.opaqueAccountId)) throw new BrokerCommandError("invalid_request");
  return value.opaqueAccountId;
}

function exactEmptyParams(value: unknown): null {
  if (!emptyParams(value)) throw new BrokerCommandError("invalid_request");
  return null;
}

function exactEnrollmentParams(value: unknown): OpaqueEnrollmentRef {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !isOpaqueEnrollmentRef(value.enrollmentRef)) {
    throw new BrokerCommandError("invalid_request");
  }
  return value.enrollmentRef;
}

function exactConnectionScopeParams(value: unknown, requireDefinition: boolean): {
  opaqueAccountId: OpaqueAccountId;
  kind: BrokerConnectionKind;
  definitionRef?: OpaqueConnectionDefinitionRef;
} {
  if (!isPlainRecord(value)) throw new BrokerCommandError("invalid_request");
  const expected = requireDefinition ? ["definitionRef", "kind", "opaqueAccountId"] : ["kind", "opaqueAccountId"];
  if (Object.keys(value).sort().join("\0") !== expected.sort().join("\0")
    || !isOpaqueAccountId(value.opaqueAccountId) || !isBrokerConnectionKind(value.kind)
    || (requireDefinition && !isOpaqueConnectionDefinitionRef(value.definitionRef))) throw new BrokerCommandError("invalid_request");
  return {
    opaqueAccountId: value.opaqueAccountId,
    kind: value.kind,
    ...(requireDefinition ? { definitionRef: value.definitionRef as OpaqueConnectionDefinitionRef } : {}),
  };
}

function exactHandoffParams(value: unknown): OpaqueHandoffRef {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !isOpaqueHandoffRef(value.handoffRef)) {
    throw new BrokerCommandError("invalid_request");
  }
  return value.handoffRef;
}

function exactConfirmHandoffParams(value: unknown): { handoffRef: OpaqueHandoffRef; toOpaqueAccountId?: OpaqueAccountId } {
  if (!isPlainRecord(value) || ![1, 2].includes(Object.keys(value).length) || !isOpaqueHandoffRef(value.handoffRef)
    || (Object.keys(value).length === 2 && (!isOpaqueAccountId(value.toOpaqueAccountId)
      || Object.keys(value).sort().join("\0") !== ["handoffRef", "toOpaqueAccountId"].join("\0")))) {
    throw new BrokerCommandError("invalid_request");
  }
  const toOpaqueAccountId = isOpaqueAccountId(value.toOpaqueAccountId) ? value.toOpaqueAccountId : undefined;
  return { handoffRef: value.handoffRef, ...(toOpaqueAccountId ? { toOpaqueAccountId } : {}) };
}

function emptyParams(value: unknown): boolean {
  return value === undefined || (isPlainRecord(value) && Object.keys(value).length === 0);
}

function isBrokerConnectionKind(value: unknown): value is BrokerConnectionKind {
  return value === "app" || value === "mcp" || value === "plugin" || value === "workspace";
}

function isBrokerConnectionStatus(value: unknown): value is BrokerConnectionStatus {
  return value === "unknown" || value === "connecting" || value === "connected" || value === "blocked" || value === "unavailable";
}

function isProfileState(value: unknown): value is BrokerAccountState {
  return value === "disabled" || value === "ready" || value === "active" || value === "reauth_required" || value === "unhealthy";
}

function isSafeProfileLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80
    && value === value.trim().replace(/\s+/g, " ") && !/[@/\\]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:bearer\s+\S+|access_token|refresh_token|cookie|authorization)/i.test(value);
}

function emptySafeProfile(): BrokerSafeProfileV1 {
  return { plan: null, identifierMasked: null, avatarUrl: null };
}

/**
 * The owner has already reduced provider data before this point.  The sole
 * address-like value allowed through the broker is a visibly masked display
 * form; it can never be used as an identifier or credential.
 */
function isBrokerSafeProfile(value: unknown): value is BrokerSafeProfileV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["avatarUrl", "identifierMasked", "plan"].join("\0")) return false;
  const plan = value.plan;
  const identifierMasked = value.identifierMasked;
  const avatarUrl = value.avatarUrl;
  if (plan !== null && (typeof plan !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(plan))) return false;
  if (identifierMasked !== null && (typeof identifierMasked !== "string" || !/^[^@\s]{1,3}\*+@[^@\s]{1,80}$/.test(identifierMasked))) return false;
  if (avatarUrl !== null && !isSafeAvatarUrl(avatarUrl)) return false;
  return true;
}

function isSafeAvatarUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password
      && !url.search && !url.hash && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

/**
 * Generic redaction correctly rejects all email-like fields.  A broker pool
 * carries one deliberately reduced display mask, so strip only validated
 * `safeProfile` objects before applying the generic recursive policy.
 */
export function assertBrokerRedacted(value: unknown): void {
  assertBrokerDisplayFields(value);
  assertRedacted(withoutBrokerDisplayFields(value));
}

function assertBrokerDisplayFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertBrokerDisplayFields(item);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "safeProfile") {
      if (!isBrokerSafeProfile(item)) throw new Error("unsafe broker profile projection");
      continue;
    }
    if (key === "oauthUrl") {
      if (!isSafeOAuthUrl(item)) throw new Error("unsafe broker oauth handoff");
      continue;
    }
    assertBrokerDisplayFields(item);
  }
}

function withoutBrokerDisplayFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBrokerDisplayFields);
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "safeProfile" || key === "oauthUrl") continue;
    // Typed HMAC handles can randomly contain credential-like substrings.
    // Keep scanning malformed handles and every other field.
    if (key === "definitionRef" && isOpaqueConnectionDefinitionRef(item)) continue;
    output[key] = withoutBrokerDisplayFields(item);
  }
  return output;
}

function oauthUrlFromDeviceValue(value: unknown): string | null {
  return isPlainRecord(value) && Object.keys(value).length === 1 && isSafeOAuthUrl(value.oauthUrl) ? value.oauthUrl : null;
}

/**
 * OAuth handoff URLs are response-only and may retain the protocol's state
 * query.  Credentials, authorization codes, fragments, userinfo, and local
 * paths are rejected before a renderer can receive the URL.
 */
function isSafeOAuthUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
    for (const [key, item] of url.searchParams) {
      if (/^(?:access_?token|refresh_?token|id_?token|token|code|client_?secret|credential|cookie)$/i.test(key)) return false;
      if (/(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i.test(item)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isDeviceActionResult(value: unknown): value is BrokerDeviceActionResultV1 {
  return isPlainRecord(value) && Object.keys(value).every((key) => key === "outcome" || key === "value")
    && (value.outcome === "accepted" || value.outcome === "rejected" || value.outcome === "ambiguous");
}

function applyDeviceStart(enrollment: InternalEnrollment, value: unknown): boolean {
  if (!isPlainRecord(value)
    || typeof value.loginId !== "string" || value.loginId.length < 1 || value.loginId.length > 512
    || typeof value.verificationUrl !== "string" || !isSafeDeviceUrl(value.verificationUrl)
    || typeof value.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(value.userCode)) return false;
  const expiresAt = value.expiresAt === undefined || value.expiresAt === null ? null
    : typeof value.expiresAt === "string" && isIsoTimestamp(value.expiresAt) ? value.expiresAt : null;
  enrollment.loginId = value.loginId;
  enrollment.verificationUrl = value.verificationUrl;
  enrollment.userCode = value.userCode;
  enrollment.expiresAt = expiresAt;
  enrollment.state = "waiting";
  return true;
}

function applyDeviceStatus(enrollment: InternalEnrollment, value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.success !== "boolean") {
    enrollment.state = "failed";
    return false;
  }
  enrollment.state = value.success ? "complete" : "waiting";
  if (value.success) {
    enrollment.userCode = null;
    enrollment.verificationUrl = null;
  }
  return value.success;
}

function publicEnrollment(enrollment: InternalEnrollment): BrokerEnrollmentV1 {
  return {
    enrollmentRef: enrollment.enrollmentRef,
    kind: enrollment.kind,
    opaqueAccountId: enrollment.opaqueAccountId,
    state: enrollment.state,
    userCode: enrollment.userCode,
    verificationUrl: enrollment.verificationUrl,
    expiresAt: enrollment.expiresAt,
  };
}

function isSafeDeviceUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function quotaFromProviderValue(opaqueAccountId: OpaqueAccountId, value: unknown): QuotaProjectionV3 | null {
  if (!isPlainRecord(value)) return null;
  const source = isPlainRecord(value.quota) ? value.quota : value;
  const remainingPercent = typeof source.remainingPercent === "number" && Number.isFinite(source.remainingPercent)
    && source.remainingPercent >= 0 && source.remainingPercent <= 100 ? Math.round(source.remainingPercent) : null;
  const resetAt = typeof source.resetAt === "string" && isIsoTimestamp(source.resetAt) ? source.resetAt : null;
  const resetCredits = typeof source.resetCredits === "number" && Number.isInteger(source.resetCredits)
    && source.resetCredits >= 0 && source.resetCredits <= 10_000 ? source.resetCredits : null;
  const freshness: BrokerQuotaFreshness = source.freshness === "fresh" || source.freshness === "stale" || source.freshness === "unknown"
    ? source.freshness : "unknown";
  const shortWindowPressure = typeof source.shortWindowPressure === "number" && Number.isFinite(source.shortWindowPressure)
    && source.shortWindowPressure >= 0 && source.shortWindowPressure <= 100 ? Math.round(source.shortWindowPressure) : null;
  return { opaqueAccountId, freshness, remainingPercent, resetAt, shortWindowPressure, resetCredits,
    ...(typeof source.observedAt === "number" && Number.isFinite(source.observedAt) ? { observedAt: source.observedAt } : {}),
    ...(typeof source.shortWindowResetAt === "number" && Number.isFinite(source.shortWindowResetAt) ? { shortWindowResetAt: source.shortWindowResetAt } : {}),
    ...(typeof source.rateLimitReached === "boolean" ? { rateLimitReached: source.rateLimitReached } : {}),
  };
}

function connectionStatesFromProviderValue(
  opaqueAccountId: OpaqueAccountId,
  kind: BrokerConnectionKind,
  value: unknown,
  now: () => number,
): ConnectionStateV3[] | null {
  const candidates = Array.isArray(value) ? value : isPlainRecord(value) && Array.isArray(value.connections) ? value.connections : null;
  if (!candidates || candidates.length > MAX_CONNECTIONS) return null;
  const states: ConnectionStateV3[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isPlainRecord(candidate) || !isOpaqueConnectionDefinitionRef(candidate.definitionRef)
      || !isBrokerConnectionStatus(candidate.status) || seen.has(candidate.definitionRef)) return null;
    seen.add(candidate.definitionRef);
    states.push({
      opaqueAccountId,
      kind,
      definitionRef: candidate.definitionRef,
      ...(safeConnectionDisplayLabel(candidate.displayLabel) ? { displayLabel: safeConnectionDisplayLabel(candidate.displayLabel) } : {}),
      status: candidate.status,
      updatedAt: new Date(now()).toISOString(),
    });
  }
  return states;
}

function isQuotaProjection(value: unknown): value is QuotaProjectionV3 {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["freshness", "opaqueAccountId", "remainingPercent", "resetAt", "resetCredits", "shortWindowPressure", "observedAt", "shortWindowResetAt", "rateLimitReached", "refreshState", "errorCode", "lastAttemptAt"].includes(key))) return false;
  if (!(value.observedAt === undefined || value.observedAt === null || typeof value.observedAt === "number" && Number.isFinite(value.observedAt) && value.observedAt >= 0)
    || !(value.shortWindowResetAt === undefined || value.shortWindowResetAt === null || typeof value.shortWindowResetAt === "number" && Number.isFinite(value.shortWindowResetAt) && value.shortWindowResetAt > 0)
    || !(value.rateLimitReached === undefined || typeof value.rateLimitReached === "boolean")
    || !(value.refreshState === undefined || value.refreshState === "idle" || value.refreshState === "loading" || value.refreshState === "error")
    || !(value.errorCode === undefined || value.errorCode === null || value.errorCode === "authentication" || value.errorCode === "connection" || value.errorCode === "unavailable")
    || !(value.lastAttemptAt === undefined || value.lastAttemptAt === null || typeof value.lastAttemptAt === "string" && isIsoTimestamp(value.lastAttemptAt))) return false;
  return isOpaqueAccountId(value.opaqueAccountId) && isBrokerQuotaFreshness(value.freshness)
    && (value.remainingPercent === null || (typeof value.remainingPercent === "number" && Number.isInteger(value.remainingPercent) && value.remainingPercent >= 0 && value.remainingPercent <= 100))
    && (value.resetAt === null || (typeof value.resetAt === "string" && isIsoTimestamp(value.resetAt)))
    && (value.shortWindowPressure === null || (typeof value.shortWindowPressure === "number" && Number.isInteger(value.shortWindowPressure) && value.shortWindowPressure >= 0 && value.shortWindowPressure <= 100))
    && (value.resetCredits === null || (typeof value.resetCredits === "number" && Number.isInteger(value.resetCredits) && value.resetCredits >= 0 && value.resetCredits <= 10_000));
}

function isBrokerQuotaFreshness(value: unknown): value is BrokerQuotaFreshness {
  return value === "fresh" || value === "stale" || value === "unknown";
}

/** Handoff allocation shares the automatic scheduler's freshness boundary. */
function hasFreshPositiveQuota(quota: QuotaProjectionV3 | undefined, now: number): boolean {
  return quota?.freshness === "fresh"
    && typeof quota.remainingPercent === "number"
    && Number.isFinite(quota.remainingPercent)
    && quota.remainingPercent > 0
    && quota.resetAt !== null && Date.parse(quota.resetAt) > now
    && (quota.observedAt === undefined || typeof quota.observedAt === "number" && quota.observedAt <= now && now - quota.observedAt <= 120_000)
    && quota.rateLimitReached !== true
    && !(quota.shortWindowPressure === 100 && (quota.shortWindowResetAt == null || quota.shortWindowResetAt > now));
}

function connectionKey(account: OpaqueAccountId, kind: BrokerConnectionKind, definition: OpaqueConnectionDefinitionRef): string {
  return `${account}\u0000${kind}\u0000${definition}`;
}

function publicTask(task: TaskOwnershipV3): TaskOwnershipV3 {
  return {
    taskRef: task.taskRef,
    conversationId: task.conversationId,
    opaqueAccountId: task.opaqueAccountId,
    ownerRendererRef: task.ownerRendererRef,
    activeRunCount: task.activeRunCount,
    handoffState: task.handoffState,
  };
}

function publicHandoff(handoff: PendingHandoffV1): PendingHandoffV1 {
  return {
    version: 1,
    handoffRef: handoff.handoffRef,
    confirmationId: handoff.confirmationId,
    conversationId: handoff.conversationId,
    taskRef: handoff.taskRef,
    originRendererRef: handoff.originRendererRef,
    fromOpaqueAccountId: handoff.fromOpaqueAccountId,
    toOpaqueAccountId: handoff.toOpaqueAccountId,
    state: handoff.state,
    expiresAt: handoff.expiresAt,
  };
}

function cloneEventPayload(payload: BrokerEventV1["payload"]): BrokerEventV1["payload"] {
  // Every payload type is a shallow, scalar-only projection. JSON copy keeps a
  // subscriber from mutating the broker's accounting state.
  return JSON.parse(JSON.stringify(payload)) as BrokerEventV1["payload"];
}

/** Reject unknown live-event shapes before they can cross a subscriber seam. */
function isBrokerEventPayload(type: BrokerEventType, payload: BrokerEventV1["payload"]): boolean {
  switch (type) {
    case "profile":
      return isAccountPool(payload);
    case "quota":
      return isQuotaProjection(payload) || Array.isArray(payload) && payload.every(isQuotaProjection);
    case "enrollment":
      return isBrokerEnrollment(payload);
    case "connection":
      return Array.isArray(payload) && payload.length <= MAX_CONNECTIONS && payload.every(isConnectionState);
    case "continuation":
      return isTaskOwnership(payload) || isPendingHandoff(payload) || isLogicalContinuationProjection(payload);
    case "history":
    case "conversation":
      return isLogicalConversationProjection(payload);
    case "turn":
      return isLogicalTurnProjection(payload);
    case "availability":
      return isPlainRecord(payload) && Object.keys(payload).length === 1
        && (payload.state === "available" || payload.state === "unavailable" || payload.state === "incompatible");
    default:
      return false;
  }
}

function isAccountPool(value: unknown): value is AccountPoolV3 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["accounts", "heldWorkCount", "maxResidentChildren", "residentChildren", "schemaVersion"].join("\0")
    && value.schemaVersion === 3 && typeof value.maxResidentChildren === "number" && Number.isInteger(value.maxResidentChildren) && value.maxResidentChildren >= 0
    && Array.isArray(value.accounts) && value.maxResidentChildren <= value.accounts.length
    && typeof value.residentChildren === "number" && Number.isInteger(value.residentChildren) && value.residentChildren >= 0 && value.residentChildren <= value.maxResidentChildren
    && typeof value.heldWorkCount === "number" && Number.isInteger(value.heldWorkCount) && value.heldWorkCount >= 0
    && Array.isArray(value.accounts) && value.accounts.every(isAccountPoolAccount);
}

function isAccountPoolAccount(value: unknown): value is AccountPoolAccountV3 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["activeRunCount", "assignedTaskCount", "childState", "enabled", "label", "opaqueAccountId", "safeProfile", "state", ...(value.continuityState === undefined ? [] : ["continuityState"]), ...(value.continuityReason === undefined ? [] : ["continuityReason"]), ...(value.continuityBlocker === undefined ? [] : ["continuityBlocker"])].sort().join("\0")
    && (value.continuityState === undefined || value.continuityState === "ready" || value.continuityState === "deferred")
    && (value.continuityReason === undefined || ["migration_pending", "account_in_use", "source_changed", "recovery_required"].includes(String(value.continuityReason)))
    && (value.continuityBlocker === undefined || isSafeProfileLabel(value.continuityBlocker))
    && (value.continuityReason === undefined || value.continuityState === "deferred")
    && (value.continuityBlocker === undefined || value.continuityReason !== undefined)
    && isOpaqueAccountId(value.opaqueAccountId) && isSafeProfileLabel(value.label) && typeof value.enabled === "boolean" && isProfileState(value.state)
    && isBrokerSafeProfile(value.safeProfile)
    && (value.childState === "absent" || value.childState === "resident" || value.childState === "active" || value.childState === "held" || value.childState === "evicted")
    && typeof value.activeRunCount === "number" && Number.isInteger(value.activeRunCount) && value.activeRunCount >= 0
    && typeof value.assignedTaskCount === "number" && Number.isInteger(value.assignedTaskCount) && value.assignedTaskCount >= 0;
}

function isBrokerEnrollment(value: unknown): value is BrokerEnrollmentV1 {
  return isPlainRecord(value)
    && Object.keys(value).sort().join("\0") === ["enrollmentRef", "expiresAt", "kind", "opaqueAccountId", "state", "userCode", "verificationUrl"].join("\0")
    && isOpaqueEnrollmentRef(value.enrollmentRef)
    && (value.kind === "enrollment" || value.kind === "reconnect")
    && (value.opaqueAccountId === null || isOpaqueAccountId(value.opaqueAccountId))
    && (value.state === "starting" || value.state === "waiting" || value.state === "complete"
      || value.state === "cancelled" || value.state === "failed" || value.state === "expired")
    && (value.userCode === null || (typeof value.userCode === "string" && /^[A-Za-z0-9-]{4,32}$/.test(value.userCode)))
    && (value.verificationUrl === null || (typeof value.verificationUrl === "string" && isSafeDeviceUrl(value.verificationUrl)))
    && (value.expiresAt === null || (typeof value.expiresAt === "string" && isIsoTimestamp(value.expiresAt)));
}

/** Provider names are display text, not URLs, filesystem paths, or account handles. */
export function safeConnectionDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f\/\\]/.test(label)
    || /\b(?:ar|br|bat|bd|bt|bh|be|bc|lc|ls|lt)_[A-Za-z0-9_-]+/.test(label)) return undefined;
  try { assertRedacted(label); return label; } catch { return undefined; }
}

function isConnectionState(value: unknown): value is ConnectionStateV3 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["definitionRef", ...(value.displayLabel === undefined ? [] : ["displayLabel"]), "kind", "opaqueAccountId", "status", "updatedAt"].join("\0")
    && (value.displayLabel === undefined || safeConnectionDisplayLabel(value.displayLabel) === value.displayLabel)
    && isOpaqueAccountId(value.opaqueAccountId) && isBrokerConnectionKind(value.kind)
    && isOpaqueConnectionDefinitionRef(value.definitionRef) && isBrokerConnectionStatus(value.status)
    && (value.updatedAt === null || (typeof value.updatedAt === "string" && isIsoTimestamp(value.updatedAt)));
}

function isTaskOwnership(value: unknown): value is TaskOwnershipV3 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["activeRunCount", "conversationId", "handoffState", "opaqueAccountId", "ownerRendererRef", "taskRef"].join("\0")
    && isOpaqueTaskRef(value.taskRef) && isOpaqueConversationId(value.conversationId) && isOpaqueAccountId(value.opaqueAccountId) && isOpaqueRendererRef(value.ownerRendererRef)
    && typeof value.activeRunCount === "number" && Number.isInteger(value.activeRunCount) && value.activeRunCount >= 0
    && (value.handoffState === "none" || value.handoffState === "pending" || value.handoffState === "ambiguous");
}

function isPendingHandoff(value: unknown): value is PendingHandoffV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["confirmationId", "conversationId", "expiresAt", "fromOpaqueAccountId", "handoffRef", "originRendererRef", "state", "taskRef", "toOpaqueAccountId", "version"].join("\0")
    && value.version === 1 && isOpaqueHandoffRef(value.handoffRef) && isOpaqueConfirmationId(value.confirmationId) && isOpaqueConversationId(value.conversationId) && isOpaqueTaskRef(value.taskRef)
    && isOpaqueRendererRef(value.originRendererRef) && isOpaqueAccountId(value.fromOpaqueAccountId) && isOpaqueAccountId(value.toOpaqueAccountId)
    && value.fromOpaqueAccountId !== value.toOpaqueAccountId
    && (value.state === "pending" || value.state === "forwarding" || value.state === "ambiguous" || value.state === "cancelled" || value.state === "expired")
    && typeof value.expiresAt === "string" && isIsoTimestamp(value.expiresAt);
}

function isLogicalSubscription(value: unknown): value is LogicalHistorySubscriptionV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["accountId", "label"].join("\0")
    && isOpaqueAccountId(value.accountId) && isSafeProfileLabel(value.label);
}

function isLogicalConversationProjection(value: unknown): value is LogicalConversationProjectionV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["activeClient", "availability", "conversationId", ...(value.historyWarning === undefined ? [] : ["historyWarning"]), "peerBusy", "segments", "updatedAt"].sort().join("\0")
    || !isOpaqueConversationId(value.conversationId) || !["complete", "partial", "incomplete", "ambiguous"].includes(String(value.availability))
    || (value.historyWarning !== undefined && value.historyWarning !== null && value.historyWarning !== "content_gap" && value.historyWarning !== "ambiguous")
    || typeof value.peerBusy !== "boolean" || typeof value.updatedAt !== "string" || !isIsoTimestamp(value.updatedAt)
    || !Array.isArray(value.segments) || value.segments.length > 64) return false;
  if (!value.segments.every((segment) => isPlainRecord(segment)
    && Object.keys(segment).every((key) => ["segmentId", "subscription", "state", "committedAt"].includes(key))
    && isOpaqueSegmentId(segment.segmentId) && isLogicalSubscription(segment.subscription)
    && ["committed", "active", "incomplete", "ambiguous"].includes(String(segment.state))
    && (segment.committedAt === undefined || (typeof segment.committedAt === "string" && isIsoTimestamp(segment.committedAt))))) return false;
  return value.activeClient === null || (isPlainRecord(value.activeClient)
    && Object.keys(value.activeClient).sort().join("\0") === ["clientId", "label", "subscription"].join("\0")
    && isOpaqueRendererRef(value.activeClient.clientId) && isSafeProfileLabel(value.activeClient.label)
    && isLogicalSubscription(value.activeClient.subscription));
}

function isLogicalTurnProjection(value: unknown): value is LogicalTurnProjectionV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["state", "subscription", "turnId"].join("\0")
    && isOpaqueTurnId(value.turnId) && value.state === "committed" && isLogicalSubscription(value.subscription);
}

function isLogicalContinuationProjection(value: unknown): value is LogicalContinuationProjectionV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["confirmationId", "conversationId", "expiresAt", "fromSubscription", "kind", "state", "toSubscription"].join("\0")
    && isOpaqueConfirmationId(value.confirmationId) && isOpaqueConversationId(value.conversationId)
    && typeof value.expiresAt === "string" && isIsoTimestamp(value.expiresAt)
    && value.kind === "subscription_switch"
    && (value.state === "pending" || value.state === "forwarding" || value.state === "ambiguous" || value.state === "cancelled" || value.state === "expired")
    && isLogicalSubscription(value.fromSubscription) && isLogicalSubscription(value.toSubscription);
}

function opaqueHandle(prefix: "bh" | "bc" | "be"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function boundedDuration(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("invalid accounts broker duration");
  return value;
}

function boundedPrivateThreadKey(value: unknown): string | null {
  // This private key never leaves the process. Rejecting control characters
  // keeps it unsuitable for accidental log framing if a host later adds logs.
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function trimOldest(values: Map<string, number>, max: number): void {
  while (values.size > max) {
    const oldest = values.keys().next().value as string | undefined;
    if (!oldest) return;
    values.delete(oldest);
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Identity is returned only to the caller of the explicit copy-email action. */
export function isActionEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^@\s\u0000-\u001f\u007f]+@[^@\s\u0000-\u001f\u007f]+\.[^@\s\u0000-\u001f\u007f]+$/.test(value);
}
export function assertBrokerCommandResult(command: string, value: unknown): void {
  if (command === "native.request") {
    if (!isPlainRecord(value) || !isOpaqueAccountId(value.opaqueAccountId) || typeof value.surface !== "string"
      || !isBoundedNativeResultV1(value.result, value.surface as never)) throw new Error("invalid native request result");
    return;
  }
  if (command !== "profile.email") return assertBrokerRedacted(value);
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== "email\0opaqueAccountId"
    || !isOpaqueAccountId(value.opaqueAccountId) || !isActionEmail(value.email)) throw new Error("invalid copy-email result");
}

export function isRemoteCommand(value: unknown): value is BrokerRemoteCommandV1 {
  return typeof value === "string" && ["remote.status", "remote.enable", "remote.disable", "remote.pairing.start", "remote.pairing.status", "remote.pairing.close", "remote.devices.list", "remote.devices.revoke"].includes(value);
}
export function isBrokerRemoteProjection(value: unknown): value is BrokerRemoteProjectionV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === "accountId\0devices\0enabled\0pairing\0state"
    && isOpaqueAccountId(value.accountId) && typeof value.enabled === "boolean"
    && ["disabled", "ready", "pairing", "mfa_required", "unavailable"].includes(String(value.state))
    && (value.pairing === null || isPlainRecord(value.pairing) && Object.keys(value.pairing).sort().join("\0") === "code\0expiresAt"
      && typeof value.pairing.code === "string" && /^[A-Za-z0-9-]{4,64}$/.test(value.pairing.code)
      && (value.pairing.expiresAt === null || typeof value.pairing.expiresAt === "string" && Number.isFinite(Date.parse(value.pairing.expiresAt))))
    && Array.isArray(value.devices) && value.devices.length <= 256 && value.devices.every((device) => isPlainRecord(device)
      && Object.keys(device).sort().join("\0") === "deviceId\0label" && typeof device.deviceId === "string" && /^device_[A-Za-z0-9_-]{43}$/.test(device.deviceId)
      && typeof device.label === "string" && device.label.length > 0 && device.label.length <= 128 && !/[\u0000-\u001f\u007f]/.test(device.label));
}

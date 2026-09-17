/** The legacy on-disk/state contract. Keep this export for v1 consumers. */
export const ACCOUNT_ROUTER_SCHEMA_VERSION = 1 as const;
export const ACCOUNT_ROUTER_SCHEMA_VERSION_V2 = 2 as const;
export const ACCOUNT_ROUTER_SCHEMA_VERSION_V3 = 3 as const;
export const ACCOUNT_ROUTER_CONTRACT_FINGERPRINT =
  "sha256:6f9d6889bd23ff1122a89b417348b7346cdaa76ced1173eae8c7f8d0608113c2" as const;
export const ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT =
  "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10" as const;

export type OpaqueAccountId = `ar_${string}`;
export type JsonRpcId = string | number;
export type RouterModeV1 = "manual" | "balanced";
export type RouterModeV2 = "manual" | "quota_aware";
export type RouterMode = RouterModeV1 | RouterModeV2;
export type EligibilityState =
  | "validating"
  | "eligible"
  | "reserved"
  | "active"
  | "cooldown"
  | "quota_depleted"
  | "reauth_required"
  | "plugin_blocked"
  | "protocol_blocked"
  | "disabled"
  | "unhealthy";

export interface RouterAccountConfigV1 {
  opaqueAccountId: OpaqueAccountId;
  included: boolean;
  weight: number;
  capabilityFingerprint: `sha256:${string}`;
}

export interface RouterAccountConfigV2 extends RouterAccountConfigV1 {
  /** User-authored local label. It is deliberately not a provider identity. */
  label: string;
}

export interface RouterAccountConfigV3 extends RouterAccountConfigV2 {
  /** Disabled accounts remain enrolled but do not start children or receive work. */
  included: boolean;
}

export interface RouterConfigV1 {
  schemaVersion: 1;
  mode: RouterModeV1;
  protocolFingerprint: `sha256:${string}`;
  primaryOpaqueAccountId: OpaqueAccountId;
  accounts: [RouterAccountConfigV1, RouterAccountConfigV1];
  updatedAt: string;
}

/**
 * A v2 file is an immutable pending intent. `generation` is supplied by the
 * owner/UI and the fingerprint binds every routing-relevant field except its
 * own digest and the write timestamp.
 */
export interface RouterConfigV2 {
  schemaVersion: 2;
  mode: RouterModeV2;
  policy: "quota_aware_v1" | null;
  generation: number;
  fingerprint: `sha256:${string}`;
  protocolFingerprint: `sha256:${string}`;
  primaryOpaqueAccountId: OpaqueAccountId;
  accounts: [RouterAccountConfigV2, RouterAccountConfigV2];
  updatedAt: string;
}

export interface RouterConfigV3 {
  schemaVersion: 3;
  mode: RouterModeV2;
  policy: "quota_aware_v2" | "balanced_tokens_v1" | null;
  generation: number;
  fingerprint: `sha256:${string}`;
  protocolFingerprint: `sha256:${string}`;
  primaryOpaqueAccountId: OpaqueAccountId;
  accounts: RouterAccountConfigV3[];
  updatedAt: string;
}

export type RouterConfig = RouterConfigV1 | RouterConfigV2 | RouterConfigV3;

export type CorrelationDirection = "client_to_child" | "child_to_client";
export type DispatchState = "prepared" | "written" | "acknowledged" | "terminal";

export interface CorrelationRecord {
  schemaVersion: 1;
  direction: CorrelationDirection;
  childOpaqueAccountId: OpaqueAccountId;
  muxNonce: string;
  originalId: JsonRpcId;
  method: string;
  dispatchState: DispatchState;
}

export type ReservationState =
  | "reserved"
  | "dispatched"
  | "released_pre_dispatch"
  | "stranded_ambiguous"
  | "reconciled";

export interface Reservation {
  reservationId: string;
  opaqueAccountId: OpaqueAccountId;
  estimatedCost: number;
  state: ReservationState;
  epoch: number;
  /** Manager-only execution purpose; absent for ordinary broker requests. */
  purpose?: "doctor_review";
  /** HMAC of the acquire request id. Never contains provider or request content. */
  requestDigest?: `hmac-sha256:${string}`;
  /** Exact terminal usage supports idempotent recovery after a lost settle acknowledgement. */
  settledUsage?: { inputTokens: number; outputTokens: number };
}

export interface LedgerEntry {
  completedInputTokens: number;
  completedOutputTokens: number;
  reservedRequestCost: number;
  weight: number;
  assignedThreadCount: number;
}

export interface StagedDisable {
  reasonCode: "post_start_failure" | "protocol_drift" | "isolation_failure" | "policy_stop" | "operator_disable";
  stagedAt: string;
}

export interface RouterState {
  schemaVersion: 1;
  protocolFingerprint: `sha256:${string}`;
  epoch: number;
  threadOwners: Record<string, OpaqueAccountId>;
  pendingThreadOwners: Record<string, OpaqueAccountId>;
  ledger: Record<string, LedgerEntry>;
  reservations: Reservation[];
  accountEligibility: Record<string, EligibilityState>;
  correlations: CorrelationRecord[];
  /**
   * Bounded recovery metadata for a continuation whose payload stays only in
   * broker memory.  This deliberately contains no thread content, paths,
   * credentials, or provider identifiers.
   */
  pendingHandoffs?: Record<string, PersistentHandoffMetadataV1>;
  /** Stable section identities map to one cross-account native thread order. */
  nativeSectionOrders?: Record<string, string[]>;
  stagedDisable: StagedDisable | null;
}

export interface PersistentHandoffMetadataV1 {
  version: 1;
  handoffRef: OpaqueHandoffRef;
  confirmationId: OpaqueConfirmationId;
  conversationId: OpaqueConversationId;
  taskRef: OpaqueTaskRef;
  originRendererRef: OpaqueRendererRef;
  fromOpaqueAccountId: OpaqueAccountId;
  toOpaqueAccountId: OpaqueAccountId;
  state: "pending" | "forwarding" | "ambiguous";
  expiresAt: string;
}

export interface RedactedControlAccountV1 {
  opaqueAccountId: OpaqueAccountId;
  label: "Account A" | "Account B";
  eligibility: EligibilityState;
  normalizedSpend: number;
  assignedThreadCount: number;
}

export interface RedactedControlStatusV1 {
  schemaVersion: 1;
  mode: "manual" | "balanced" | "direct_fallback";
  protocolState: "supported" | "unsupported" | "drifted" | "unknown";
  fairnessPrecision: "projected" | "exact_completed_spend" | "estimated";
  accounts: RedactedControlAccountV1[];
  restartRequired: boolean;
  degradedReason: null | "invalid_config" | "unsupported_protocol" | "startup_selfcheck_failed" | "pool_depleted" | "capability_mismatch" | "policy_stop" | "post_start_failure";
}

export type QuotaFreshness = "fresh" | "stale" | "unknown";

export interface RedactedQuotaWindow {
  remainingPercent: number | null;
  resetAt: string | null;
  freshness: QuotaFreshness;
}

export interface RedactedControlAccountV2 {
  opaqueAccountId: OpaqueAccountId;
  /** Configured label only; no provider identity is allowed here. */
  label: string;
  eligibility: EligibilityState;
  plan: string | null;
  /** A stable mask derived only from the opaque local account handle. */
  identifierMasked: string;
  weekly: RedactedQuotaWindow;
  /** 0–100, where lower short-window pressure wins a weekly-score tie. */
  shortWindowPressure: number | null;
  assignedThreadCount: number;
  /** Banked reset credits are routing evidence only and are never consumed automatically. */
  resetCredits?: number | null;
}

export interface RedactedControlIntentV2 {
  mode: RouterModeV2;
  policy: "quota_aware_v1" | "quota_aware_v2" | "balanced_tokens_v1" | null;
  generation: number;
  fingerprint: `sha256:${string}`;
}

export type QuotaDegradedReason =
  | "invalid_config"
  | "unsupported_protocol"
  | "startup_selfcheck_failed"
  | "capability_mismatch"
  | "policy_stop"
  | "post_start_failure"
  | "account_unauthenticated"
  | "account_disabled"
  | "account_unhealthy"
  | "quota_depleted"
  | "quota_stale"
  | "quota_unknown";

export interface RedactedControlStatusV2 {
  schemaVersion: 2;
  active: RedactedControlIntentV2;
  pending: RedactedControlIntentV2 | null;
  protocolState: "supported" | "unsupported" | "drifted" | "unknown";
  accounts: [RedactedControlAccountV2, RedactedControlAccountV2];
  /** Sum across the fixed two-account pool (0–200), or null unless both are fresh. */
  poolRemainingPercent: number | null;
  restartRequired: boolean;
  degradedReason: QuotaDegradedReason | null;
}

export interface RedactedControlStatusV3 {
  schemaVersion: 3;
  active: RedactedControlIntentV2;
  pending: RedactedControlIntentV2 | null;
  protocolState: "supported" | "unsupported" | "drifted" | "unknown";
  accounts: RedactedControlAccountV2[];
  /** Sum across every enabled account, or null unless every enabled reading is fresh. */
  poolRemainingPercent: number | null;
  restartRequired: boolean;
  degradedReason: QuotaDegradedReason | null;
}

export type RedactedControlStatus = RedactedControlStatusV1 | RedactedControlStatusV2 | RedactedControlStatusV3;

/**
 * Accounts broker v1 is intentionally a separate, renderer-safe contract from
 * the router's private on-disk configuration.  In particular, no provider
 * account id, home path, credential, cookie, request body, or app-server id is
 * valid in any of the types below.
 */
export const ACCOUNTS_BROKER_VERSION = 1 as const;
/** Hard configuration bound; the resident target is every enabled subscription. */
export const ACCOUNTS_BROKER_MAX_RESIDENT_CHILDREN = 64 as const;
export const ACCOUNTS_BROKER_MAX_CHILD_START_CONCURRENCY = 4 as const;
/** Desktop renderer sessions are bounded independently from child residency. */
export const ACCOUNTS_BROKER_MAX_CLIENTS = 16 as const;
export const ACCOUNTS_BROKER_IDLE_EVICTION_MS = 300_000 as const;
export const ACCOUNTS_BROKER_HANDOFF_TTL_MS = 60_000 as const;

/** Opaque local handles are the only renderer-visible identity primitives. */
export type OpaqueRendererRef = `br_${string}`;
export type OpaqueAppToolsRef = `bat_${string}`;
export type OpaqueTaskRef = `bt_${string}`;
export type OpaqueHandoffRef = `bh_${string}`;
/** Broker-owned identities: these never contain a provider thread or turn id. */
export type OpaqueConversationId = `lc_${string}`;
export type OpaqueSegmentId = `ls_${string}`;
export type OpaqueTurnId = `lt_${string}`;
export type OpaqueConfirmationId = `bc_${string}`;
export type OpaqueConnectionDefinitionRef = `bd_${string}`;
/** Owner-private device enrollment handle; renderer adapters derive another id. */
export type OpaqueEnrollmentRef = `be_${string}`;

export type BrokerClientKind = "chatgpt" | "tweakers";
export type BrokerConnectionKind = "app" | "mcp" | "plugin" | "workspace";
export type BrokerConnectionStatus = "unknown" | "connecting" | "connected" | "blocked" | "unavailable";
export type BrokerAccountState = "disabled" | "ready" | "active" | "reauth_required" | "unhealthy";
export type BrokerChildState = "absent" | "resident" | "active" | "held" | "evicted";
export type BrokerQuotaFreshness = "fresh" | "stale" | "unknown";
export type BrokerQuotaRefreshState = "idle" | "loading" | "error";
export type BrokerQuotaErrorCode = "authentication" | "connection" | "unavailable";
export type PendingHandoffState = "pending" | "forwarding" | "ambiguous" | "cancelled" | "expired";

/**
 * Bounded provider-derived display facts.  These are reduced by the owner
 * before they enter the broker: no raw provider identifier, account payload,
 * cookie, credential, or local path belongs here.
 */
export interface BrokerSafeProfileV1 {
  /** A validated, display-only plan name, not a provider entitlement object. */
  plan: string | null;
  /** A one-way masked address suitable only for display. */
  identifierMasked: string | null;
  /** HTTPS-only avatar URL with credentials, query, and fragment removed. */
  avatarUrl: string | null;
}

export interface AccountPoolAccountV3 {
  opaqueAccountId: OpaqueAccountId;
  /** Local, user-authored label only; never a provider identity. */
  label: string;
  /** Sanitized provider display facts; raw provider data never reaches this pool. */
  safeProfile: BrokerSafeProfileV1;
  enabled: boolean;
  state: BrokerAccountState;
  childState: BrokerChildState;
  activeRunCount: number;
  assignedTaskCount: number;
  /** Authenticated profile only: existing native settings remain in use until idle. */
  continuityState?: "ready" | "deferred";
  /** A bounded reason for deferred account continuity; absence means no reason was proven. */
  continuityReason?: "migration_pending" | "account_in_use" | "source_changed" | "recovery_required";
  /** Optional renderer-safe detail supplied only after the owner verifies the blocker. */
  continuityBlocker?: string;
}

/** Redacted, pool-independent scheduler projection. */
export interface AccountPoolV3 {
  schemaVersion: 3;
  maxResidentChildren: number;
  residentChildren: number;
  heldWorkCount: number;
  accounts: AccountPoolAccountV3[];
}

/** A connection is scoped by the complete (account, kind, definition) key. */
export interface ConnectionStateV3 {
  /** Sanitized provider display text; never a private definition handle. */
  displayLabel?: string;
  opaqueAccountId: OpaqueAccountId;
  kind: BrokerConnectionKind;
  definitionRef: OpaqueConnectionDefinitionRef;
  status: BrokerConnectionStatus;
  updatedAt: string | null;
}

/** Bounded quota facts only; unknown is never projected as available capacity. */
export interface QuotaProjectionV3 {
  opaqueAccountId: OpaqueAccountId;
  freshness: BrokerQuotaFreshness;
  remainingPercent: number | null;
  resetAt: string | null;
  /** Five-hour pressure only; null means the provider did not supply it. */
  shortWindowPressure: number | null;
  resetCredits: number | null;
  observedAt?: number | null;
  shortWindowResetAt?: number | null;
  rateLimitReached?: boolean;
  refreshState?: BrokerQuotaRefreshState;
  errorCode?: BrokerQuotaErrorCode | null;
  lastAttemptAt?: string | null;
}

export type NativeRequestSurfaceV1 = "profile" | "apps" | "plugins" | "mcp" | "usage";

export interface NativeRequestResultV1 {
  opaqueAccountId: OpaqueAccountId;
  surface: NativeRequestSurfaceV1;
  result: unknown;
}

/** Content-free usage since the broker baseline; subscription quota is separate. */
export interface BrokerBalanceProjectionV1 {
  policy: "balanced_tokens_v1" | "quota_aware_v2" | "manual";
  baselineAt: string | null;
  accounts: Array<{
    opaqueAccountId: OpaqueAccountId;
    completedTokens: number;
    reservedTokens: number;
    unreportedTokens: number;
    sharePercent: number | null;
    precision: "exact" | "partial" | "unknown";
  }>;
  degradedReason: null | "account_unavailable" | "usage_unknown" | "requires_two_accounts";
  nextAccountId: OpaqueAccountId | null;
}

/** Login ids remain private; only user-facing device-code facts are projected. */
export interface BrokerEnrollmentV1 {
  enrollmentRef: OpaqueEnrollmentRef;
  kind: "enrollment" | "reconnect";
  opaqueAccountId: OpaqueAccountId | null;
  state: "starting" | "waiting" | "complete" | "cancelled" | "failed" | "expired";
  userCode: string | null;
  verificationUrl: string | null;
  expiresAt: string | null;
}

/** Logical task ownership is independent of the pool's child residency. */
export interface TaskOwnershipV3 {
  taskRef: OpaqueTaskRef;
  /** Broker-owned logical conversation; provider thread ids remain private. */
  conversationId: OpaqueConversationId;
  opaqueAccountId: OpaqueAccountId;
  ownerRendererRef: OpaqueRendererRef;
  activeRunCount: number;
  handoffState: "none" | "pending" | "ambiguous";
}

/** The continuation itself remains in broker memory and is never public. */
export interface PendingHandoffV1 {
  version: 1;
  handoffRef: OpaqueHandoffRef;
  /** Renderer-safe confirmation capability for this exact held continuation. */
  confirmationId: OpaqueConfirmationId;
  conversationId: OpaqueConversationId;
  taskRef: OpaqueTaskRef;
  /** The desktop that owns reverse app-tools delivery; it never moves. */
  originRendererRef: OpaqueRendererRef;
  /** Account ownership, rather than desktop ownership, is the handoff target. */
  fromOpaqueAccountId: OpaqueAccountId;
  toOpaqueAccountId: OpaqueAccountId;
  state: PendingHandoffState;
  expiresAt: string;
}

/** Stable, bounded renderer-safe account attribution. */
export interface LogicalHistorySubscriptionV1 {
  accountId: OpaqueAccountId;
  label: string;
}

export interface LogicalHistorySegmentProjectionV1 {
  segmentId: OpaqueSegmentId;
  subscription: LogicalHistorySubscriptionV1;
  state: "committed" | "active" | "incomplete" | "ambiguous";
  committedAt?: string;
}

export interface LogicalHistoryActiveClientV1 {
  clientId: OpaqueRendererRef;
  label: string;
  subscription: LogicalHistorySubscriptionV1;
}

/**
 * Content-free logical-conversation projection. Native thread ids, provider
 * turn ids, and transcript content are owner-private and invalid here.
 */
export interface LogicalConversationProjectionV1 {
  conversationId: OpaqueConversationId;
  availability: "complete" | "partial" | "incomplete" | "ambiguous";
  /** Durable terminal history evidence, independent of ordinary active work. */
  historyWarning?: "content_gap" | "ambiguous" | null;
  segments: LogicalHistorySegmentProjectionV1[];
  activeClient: LogicalHistoryActiveClientV1 | null;
  peerBusy: boolean;
  updatedAt: string;
}

export interface LogicalTurnProjectionV1 {
  turnId: OpaqueTurnId;
  subscription: LogicalHistorySubscriptionV1;
  state: "committed";
}

export interface LogicalContinuationProjectionV1 {
  confirmationId: OpaqueConfirmationId;
  state: PendingHandoffState;
  expiresAt: string;
  kind: "subscription_switch";
  fromSubscription: LogicalHistorySubscriptionV1;
  toSubscription: LogicalHistorySubscriptionV1;
  conversationId: OpaqueConversationId;
}

/** First frame on every broker connection. `proof` is an HMAC, never a secret. */
export interface BrokerHandshakeV1 {
  version: 1;
  clientKind: BrokerClientKind;
  rendererRef: OpaqueRendererRef;
  appToolsRef: OpaqueAppToolsRef;
  nonce: string;
  proof: string;
}

/**
 * The public lifecycle vocabulary is deliberately narrow.  A broker event is
 * an account/control projection, never an app-server notification or a
 * provider payload.  Unknown event types and payload shapes are dropped by
 * the owner before crossing a process boundary.
 */
export type BrokerEventType = "profile" | "quota" | "enrollment" | "connection" | "continuation" | "history" | "conversation" | "turn" | "availability";

export type BrokerEventPayloadV1 =
  | AccountPoolV3
  | QuotaProjectionV3[]
  | QuotaProjectionV3
  | AccountPoolAccountV3
  | BrokerEnrollmentV1
  | ConnectionStateV3[]
  | TaskOwnershipV3
  | PendingHandoffV1
  | LogicalConversationProjectionV1
  | LogicalTurnProjectionV1
  | LogicalContinuationProjectionV1
  | { state: "available" | "unavailable" | "incompatible" };

/** Events are targeted, sequenced, redacted, and intentionally content-free. */
export interface BrokerEventV1 {
  version: 1;
  sequence: number;
  type: BrokerEventType;
  payload: BrokerEventPayloadV1;
}

/** Content-free current-client logical-history read on the private broker seam. */
export interface BrokerHistoryReadProjectionV1 {
  conversation: LogicalConversationProjectionV1 | null;
  turns: LogicalTurnProjectionV1[];
}

export type BrokerRemoteCommandV1 = "remote.status" | "remote.enable" | "remote.disable" | "remote.pairing.start" | "remote.pairing.status" | "remote.pairing.close" | "remote.devices.list" | "remote.devices.revoke";
export interface BrokerRemoteProjectionV1 {
  accountId: OpaqueAccountId;
  enabled: boolean;
  state: "disabled" | "ready" | "pairing" | "mfa_required" | "unavailable";
  pairing: { code: string; expiresAt: string | null } | null;
  devices: readonly { deviceId: string; label: string }[];
}

/** Exact Accounts consumer command vocabulary. */
export type BrokerCommandV1 =
  | BrokerRemoteCommandV1
  | "enrollment.start"
  | "enrollment.status"
  | "enrollment.cancel"
  | "reconnect.start"
  | "reconnect.status"
  | "reconnect.cancel"
  | "profile.email"
  | "profile.statistics"
  | "profile.read"
  | "history.read"
  | "profile.update"
  | "enabled.set"
  | "quota.read"
  | "native.request"
  | "preferences.read"
  | "preferences.update"
  | "balance.read"
  | "balance.set"
  | "connection.list"
  | "connection.status"
  | "connection.authorize"
  | "resetCredit.consume"
  | "handoff.confirm"
  | "handoff.cancel"
  | "events.subscribe"
  | "events.unsubscribe";

/** Private broker invocation after the main IPC envelope was validated. */
export interface BrokerRequestEnvelopeV1 {
  version: 1;
  requestId: string;
  command: BrokerCommandV1;
  params?: unknown;
}

/** Locked renderer-to-main IPC envelope on the `accounts` channel. */
export interface AccountsBrokerIpcEnvelopeV1 extends BrokerRequestEnvelopeV1 {
  action: "broker";
}

/** Owner-private socket status has a separate, strictly redacted projection. */
export type BrokerStateV1 = "available" | "unavailable" | "incompatible";

export interface BrokerRegisteredClientV1 {
  rendererRef: OpaqueRendererRef;
  clientKind: BrokerClientKind;
}

export interface BrokerPendingHandoffSummaryV1 {
  pendingCount: number;
  ambiguousCount: number;
}

/**
 * Browser evidence is deliberately boolean/timestamp-only.  It cannot expose
 * a browser profile, URL, tab title, cookie, or renderer request content.
 */
export interface BrokerBrowserEvidenceV1 {
  observed: boolean;
  observedAt: string | null;
}

/** Status keeps child/account state but never publishes account handles. */
export interface BrokerControlAccountStateV1 {
  enabled: boolean;
  state: BrokerAccountState;
  childState: BrokerChildState;
  activeRunCount: number;
  assignedTaskCount: number;
}

export interface BrokerControlPoolV1 {
  maxResidentChildren: number;
  residentChildren: number;
  heldWorkCount: number;
  accounts: BrokerControlAccountStateV1[];
}

export interface BrokerControlStatusV1 {
  version: 1;
  state: BrokerStateV1;
  registeredClients: BrokerRegisteredClientV1[];
  pool: BrokerControlPoolV1;
  pendingHandoffs: BrokerPendingHandoffSummaryV1;
  browserEvidence: BrokerBrowserEvidenceV1;
}

export type BrokerErrorCode =
  | "invalid_request"
  | "incompatible_client"
  | "unauthenticated"
  | "request_replayed"
  | "account_history_busy"
  | "account_unavailable"
  | "capacity_held"
  | "task_unavailable"
  | "handoff_unavailable"
  | "handoff_active"
  | "handoff_expired"
  | "handoff_ambiguous"
  | "linked_continuation_required"
  | "provider_confirmation_required"
  | "broker_setup_required"
  | "broker_unavailable";

export type BrokerResponseV1 =
  | { version: 1; requestId: string; ok: true; result: unknown }
  | { version: 1; requestId: string; ok: false; error: { code: BrokerErrorCode; retryable: boolean } };

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export const ELIGIBILITY_STATES = new Set<EligibilityState>([
  "validating", "eligible", "reserved", "active", "cooldown", "quota_depleted",
  "reauth_required", "plugin_blocked", "protocol_blocked", "disabled", "unhealthy",
]);

export function isOpaqueAccountId(value: unknown): value is OpaqueAccountId {
  return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value);
}

export function isOpaqueRendererRef(value: unknown): value is OpaqueRendererRef {
  return typeof value === "string" && /^br_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueAppToolsRef(value: unknown): value is OpaqueAppToolsRef {
  return typeof value === "string" && /^bat_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueTaskRef(value: unknown): value is OpaqueTaskRef {
  return typeof value === "string" && /^bt_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueHandoffRef(value: unknown): value is OpaqueHandoffRef {
  return typeof value === "string" && /^bh_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueConversationId(value: unknown): value is OpaqueConversationId {
  return typeof value === "string" && /^lc_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueSegmentId(value: unknown): value is OpaqueSegmentId {
  return typeof value === "string" && /^ls_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueTurnId(value: unknown): value is OpaqueTurnId {
  return typeof value === "string" && /^lt_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueConfirmationId(value: unknown): value is OpaqueConfirmationId {
  return typeof value === "string" && /^bc_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueConnectionDefinitionRef(value: unknown): value is OpaqueConnectionDefinitionRef {
  return typeof value === "string" && /^bd_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isOpaqueEnrollmentRef(value: unknown): value is OpaqueEnrollmentRef {
  return typeof value === "string" && /^be_[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isFingerprint(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length <= 4_096)
    || (typeof value === "number" && Number.isSafeInteger(value));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

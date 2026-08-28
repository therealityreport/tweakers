import { createHash } from "node:crypto";

/** The versioned, read-only surface consumed by the universal manager host. */
export const MANAGER_PROTOCOL_VERSION = 1 as const;
export const MANAGER_STATUS_SCHEMA_VERSION = 1 as const;
export const TWEAKERS_MANAGER_ID = "com.thomashulihan.tweakers" as const;

export type ManagerDocumentStateV1 = "missing" | "valid" | "malformed" | "unreadable";
export type ManagerReceiptSourceV1 =
  | "environment"
  | "desktop-update"
  | "environment-mode-cache"
  | "codex-derived";

/**
 * The completed status-only milestone has no action executor. These IDs are
 * retained solely as a closed future vocabulary; they are neither advertised
 * nor executable until a separately authorized action migration lands.
 */
export type TweakersManagerActionIdV1 =
  | "environment.cancel"
  | "environment.recover"
  | "desktop-update.resume"
  | "desktop-update.cancel"
  | "environment.switch"
  | "desktop-update.start"
  | "repair.run"
  | "self-update.run"
  | "refresh.full"
  | "app.restart-runtime-proof";

/**
 * This is intentionally a closed future vocabulary. A descriptor or status
 * document can never introduce a manager operation, argv, working directory,
 * or environment. The shipped status-only manager advertises none of these
 * IDs; a separate approved migration must add any narrow executor.
 */
export const TWEAKERS_MANAGER_ACTION_IDS_V1 = [
  "environment.cancel",
  "environment.recover",
  "desktop-update.resume",
  "desktop-update.cancel",
  "environment.switch",
  "desktop-update.start",
  "repair.run",
  "self-update.run",
  "refresh.full",
  "app.restart-runtime-proof",
] as const satisfies readonly TweakersManagerActionIdV1[];

export type ManagerImpactV1 = "restart-app" | "update-runtime" | "repair-app";

export type ManagerOperationPhaseV1 =
  | "prepared"
  | "consumed"
  | "cancelled"
  | "completed"
  | "failed"
  | "recovery-required";

export interface ManagerResolvedExecutableIdentityV1 {
  state: "resolved";
  path: string;
  sha256: string;
}

export interface ManagerUnresolvedExecutableIdentityV1 {
  state: "unresolved";
  reason: string;
}

/**
 * Descriptor publication is intentionally later work. Until then a caller
 * must be explicit that a stable executable identity is not available.
 */
export type ManagerExecutableIdentityV1 =
  | ManagerResolvedExecutableIdentityV1
  | ManagerUnresolvedExecutableIdentityV1;

export interface ManagerReceiptChronologyEntryV1 {
  source: ManagerReceiptSourceV1;
  /** Null when the receipt could not be parsed enough to safely identify it. */
  receiptId: string | null;
  phase: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  terminalAt: string | null;
  error: string | null;
  state: ManagerDocumentStateV1;
  /** SHA-256 of the exact observed receipt bytes, or a stable absence marker. */
  revision: string;
  active: boolean;
  problem: string | null;
}

export interface ManagerActionAvailabilityV1 {
  actionId: TweakersManagerActionIdV1;
  available: boolean;
  /** A user-visible reason that remains stable for the captured snapshot. */
  reason: string;
}

/**
 * A reduced immutable receipt projection is persisted with every prepared
 * operation. It is both a recovery input and a proof that the confirmation
 * was tied to the exact durable chronology the host displayed.
 */
export interface ManagerPreparedReceiptBindingV1 {
  source: ManagerReceiptSourceV1;
  receiptId: string | null;
  phase: string | null;
  revision: string;
  active: boolean;
}

/**
 * Durable record stored under the manager-operation root. `consumed` is
 * deliberately one-way: a crash after consumption can only become a terminal
 * result or `recovery-required`, never a fresh approval.
 */
export interface TweakersManagerPreparedOperationV1 {
  schemaVersion: 1;
  kind: "tweakers-manager-operation";
  managerId: typeof TWEAKERS_MANAGER_ID;
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  operationId: string;
  preparedRequestId: string;
  actionId: TweakersManagerActionIdV1;
  moduleIdentity: ManagerResolvedExecutableIdentityV1;
  boundStateToken: `sha256:${string}`;
  parameters: Record<string, never>;
  parametersSha256: `sha256:${string}`;
  impact: ManagerImpactV1;
  createdAt: string;
  expiresAt: string;
  phase: ManagerOperationPhaseV1;
  consumedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  recoveryRequiredAt: string | null;
  /** Exact state-token preimage digest, not caller-authored UI state. */
  stateTokenInputsSha256: `sha256:${string}`;
  receiptChronologyRevision: `sha256:${string}`;
  receiptSnapshot: readonly ManagerPreparedReceiptBindingV1[];
  receiptRefs: readonly string[];
  outcome: string | null;
  error: string | null;
}

export interface ManagerDashboardOperationsV1 {
  state: ManagerDocumentStateV1;
  revision: string;
  activeOperationId: string | null;
  preparedCount: number;
  problem: string | null;
}

export interface ManagerDashboardInstallationV1 {
  state: "not-installed" | "installed" | "malformed" | "unreadable";
  version: string | null;
  installedAt: string | null;
  appRoot: string | null;
  runtimeUpdatedAt: string | null;
  revision: string;
}

export interface ManagerDashboardModeV1 {
  current: "chatgpt" | "tweakers" | "unknown";
  updatePause: {
    state: "inactive" | "active" | "stale" | "malformed" | "unreadable";
    enabledAt: string | null;
    codexVersion: string | null;
    revision: string;
  };
}

export interface ManagerDashboardEnvironmentV1 {
  selection: {
    state: ManagerDocumentStateV1;
    releaseProfile: "stable" | "alpha" | null;
    experience: "chatgpt" | "tweakers" | null;
    migrationState: string | null;
    revision: string;
    problem: string | null;
  };
  registry: {
    state: ManagerDocumentStateV1;
    revision: string;
    problem: string | null;
  };
  modeCache: {
    state: "ready" | "preparing" | "stale" | "unavailable" | "malformed" | "unreadable";
    generationId: string | null;
    pinState: string | null;
    revision: string;
    problem: string | null;
  };
}

export interface ManagerDashboardUpdaterV1 {
  state: "idle" | "active" | "terminal" | "malformed" | "unreadable";
  transactionId: string | null;
  phase: string | null;
  resumable: boolean | null;
  safeOfficialMode: boolean | null;
  error: string | null;
  revision: string;
  problem: string | null;
}

export interface ManagerDashboardRuntimeV1 {
  state: ManagerDocumentStateV1;
  provenanceKind: string | null;
  installedAt: string | null;
  sourceRuntimeHash: string | null;
  revision: string;
  problem: string | null;
}

export interface ManagerDashboardCoordinatorV1 {
  state: "idle" | "active" | "conflicted" | "unknown";
  activeOperationId: string | null;
  lifecycleLock: "absent" | "present" | "unreadable";
  problem: string | null;
}

export interface ManagerDashboardV1 {
  schemaVersion: typeof MANAGER_STATUS_SCHEMA_VERSION;
  installation: ManagerDashboardInstallationV1;
  mode: ManagerDashboardModeV1;
  environment: ManagerDashboardEnvironmentV1;
  updater: ManagerDashboardUpdaterV1;
  runtime: ManagerDashboardRuntimeV1;
  coordinator: ManagerDashboardCoordinatorV1;
  operations: ManagerDashboardOperationsV1;
  receipts: readonly ManagerReceiptChronologyEntryV1[];
}

/**
 * The complete canonical preimage for a v1 state token. It deliberately
 * excludes observation time so equivalent state always yields the same token.
 */
export interface ManagerStateTokenInputsV1 {
  schemaVersion: typeof MANAGER_STATUS_SCHEMA_VERSION;
  manager: {
    id: typeof TWEAKERS_MANAGER_ID;
    protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
    executable: ManagerExecutableIdentityV1;
  };
  configurationRevision: string;
  installation: Pick<
    ManagerDashboardInstallationV1,
    "state" | "version" | "appRoot" | "runtimeUpdatedAt" | "revision"
  >;
  mode: ManagerDashboardModeV1;
  environment: ManagerDashboardEnvironmentV1;
  updater: ManagerDashboardUpdaterV1;
  runtime: ManagerDashboardRuntimeV1;
  /** The transient lock is visible in status but not a token input: prepare
   * itself takes that lock before its re-read, and including it would make a
   * valid host snapshot stale solely because we serialized the request. */
  coordinator: Pick<ManagerDashboardCoordinatorV1, "state" | "activeOperationId">;
  operations: ManagerDashboardOperationsV1;
  receiptChronology: readonly Pick<
    ManagerReceiptChronologyEntryV1,
    "source" | "receiptId" | "phase" | "updatedAt" | "terminalAt" | "error" | "state" | "revision" | "active"
  >[];
  allowedActions: readonly TweakersManagerActionIdV1[];
}

export interface TweakersManagerStatusSnapshotV1 {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  generatedAt: string;
  stateToken: `sha256:${string}`;
  status: ManagerDashboardV1;
  actions: readonly ManagerActionAvailabilityV1[];
  /** Internal token input; status-only responses intentionally expose no actions. */
  stateTokenInputs: ManagerStateTokenInputsV1;
}

/** Deterministic JSON encoding used only for manager state-token preimages. */
export function canonicalManagerJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Manager state-token inputs must not contain non-finite numbers");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalManagerJson).join(",")}]`;
      return `{${Object.keys(value as Record<string, unknown>)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((key) => `${JSON.stringify(key)}:${canonicalManagerJson((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    default:
      throw new Error("Manager state-token inputs must be JSON values");
  }
}

export function createManagerStateToken(inputs: ManagerStateTokenInputsV1): `sha256:${string}` {
  const digest = createHash("sha256").update(canonicalManagerJson(inputs), "utf8").digest("hex");
  return `sha256:${digest}`;
}

import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalManagerJson, type ManagerActionAvailabilityV1, type ManagerExecutableIdentityV1, type ManagerImpactV1, type TweakersManagerActionIdV1, type TweakersManagerPreparedOperationV1, TWEAKERS_MANAGER_ID } from "./manager-contract.js";
import { EnvironmentTimingRecorder } from "./environment-timing.js";
import { lifecycleLockFile, withLifecycleLock } from "./lifecycle-lock-core.js";
import { cancelPreparedEnvironmentTransaction } from "./manager-environment-action.js";
import { ManagerOperationStore, managerOperationStorePaths, type ManagerOperationStorePaths } from "./manager-operation-store.js";
import { createTweakersManagerStatusSnapshot, managerStatusPaths, type CreateTweakersManagerStatusSnapshotInput, type ManagerStatusDependencies } from "./manager-status.js";
import { userPaths } from "./paths.js";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PREPARE_TTL_MS = 10 * 60 * 1000;

export type ManagerActionErrorCode =
  | "invalid_request"
  | "unsupported_action"
  | "stale_state"
  | "operation_expired"
  | "operation_consumed"
  | "operation_conflict"
  | "cancelled"
  | "internal_error";

export class ManagerActionAdapterError extends Error {
  constructor(
    readonly code: ManagerActionErrorCode,
    message: string,
    readonly currentStateToken?: `sha256:${string}`,
  ) {
    super(message);
    this.name = "ManagerActionAdapterError";
  }
}

export interface ManagerActionAdapterExecutionResult {
  outcome: string;
  receiptRefs: readonly string[];
}

export interface ManagerActionAdapterDependencies {
  /** Typed legacy coordinators are supplied only by the separate in-process
   * bridge, which is deliberately excluded from the manager bundle. */
  userRoot?: () => string;
  now?: () => string;
  status?: typeof createTweakersManagerStatusSnapshot;
  statusDependencies?: ManagerStatusDependencies;
  store?: (userRoot: string) => ManagerOperationStore;
  executeEnvironmentCancel?: (transactionId: string) => Promise<unknown>;
  executeEnvironmentRecover?: (transactionId: string) => Promise<unknown>;
  executeDesktopResume?: (transactionId: string) => Promise<unknown>;
  executeDesktopCancel?: (transactionId: string) => Promise<unknown>;
}

/** Dependencies allowed for the production sealed adapter.  Its capability
 * set is fixed in source; callers cannot inject another coordinator through
 * this factory. */
export type SealedManagerActionAdapterDependencies = Omit<
  ManagerActionAdapterDependencies,
  "executeEnvironmentCancel" | "executeEnvironmentRecover" | "executeDesktopResume" | "executeDesktopCancel"
>;

export interface PrepareManagerActionInput {
  requestId: string;
  operationId: string;
  actionId: TweakersManagerActionIdV1;
  stateToken: `sha256:${string}`;
  expiresAt: string;
  parameters: Record<string, never>;
  executable: ManagerExecutableIdentityV1;
}

export interface PrepareManagerActionResult {
  operationId: string;
  actionId: TweakersManagerActionIdV1;
  boundStateToken: `sha256:${string}`;
  expiresAt: string;
  impact: ManagerImpactV1;
  prepared: true;
}

export interface ExecuteManagerActionInput {
  operationId: string;
  executable: ManagerExecutableIdentityV1;
}

export interface ExecuteManagerActionResult {
  operationId: string;
  outcome: string;
  stateToken: `sha256:${string}`;
  receiptRefs: readonly string[];
}

export interface CancelManagerActionInput {
  operationId: string;
  executable: ManagerExecutableIdentityV1;
}

export interface CancelManagerActionResult {
  operationId: string;
  outcome: "cancelled";
  stateToken: `sha256:${string}`;
  receiptRefs: readonly string[];
}

/**
 * Prepared-operation core for the receipt-bearing migration candidates. It
 * never turns user/descriptor data into argv or subprocess commands. This
 * file intentionally contains no legacy coordinator import: the sealed
 * manager exposes an action only when a manager-safe executor is linked. The
 * production factory currently links only environment.cancel; the separate
 * in-process bridge may supply old typed coordinators without pulling their
 * Electron/asar/CLI graph into the trusted manager bundle.
 */
export class TweakersManagerActionAdapter {
  constructor(private readonly dependencies: ManagerActionAdapterDependencies = {}) {}

  async prepare(input: PrepareManagerActionInput): Promise<PrepareManagerActionResult> {
    const userRoot = this.userRoot();
    return withLifecycleLock(lifecycleLockFile(userRoot), `manager prepare ${input.actionId}`, async () => {
      const now = this.now();
      const executable = requireResolvedExecutable(input.executable);
      const snapshot = this.snapshot(userRoot, executable);
      if (input.stateToken !== snapshot.stateToken) {
        throw staleState("The manager state changed before this action was prepared", snapshot.stateToken);
      }
      if (snapshot.status.operations.activeOperationId !== null) {
        throw new ManagerActionAdapterError(
          "operation_conflict",
          `Manager operation ${snapshot.status.operations.activeOperationId} is already pending`,
          snapshot.stateToken,
        );
      }
      assertExpiry(input.expiresAt, now);
      const spec = requireActionSpec(input.actionId);
      assertExactEmptyParameters(input.parameters);
      const availability = actionAvailability(snapshot.actions, input.actionId);
      if (!availability?.available) {
        throw new ManagerActionAdapterError("unsupported_action", availability?.reason ?? `Action ${input.actionId} is unavailable`, snapshot.stateToken);
      }
      const target = receiptTarget(snapshot, input.actionId);
      if (target === null) {
        throw new ManagerActionAdapterError("unsupported_action", `Action ${input.actionId} has no exact durable receipt target`, snapshot.stateToken);
      }
      const record: TweakersManagerPreparedOperationV1 = {
        schemaVersion: 1,
        kind: "tweakers-manager-operation",
        managerId: TWEAKERS_MANAGER_ID,
        protocolVersion: 1,
        operationId: input.operationId,
        preparedRequestId: input.requestId,
        actionId: input.actionId,
        moduleIdentity: executable,
        boundStateToken: input.stateToken,
        parameters: {},
        parametersSha256: digestCanonical({}),
        impact: spec.impact,
        createdAt: now,
        expiresAt: input.expiresAt,
        phase: "prepared",
        consumedAt: null,
        cancelledAt: null,
        completedAt: null,
        failedAt: null,
        recoveryRequiredAt: null,
        stateTokenInputsSha256: digestCanonical(snapshot.stateTokenInputs),
        receiptChronologyRevision: digestCanonical(snapshot.stateTokenInputs.receiptChronology),
        receiptSnapshot: snapshot.status.receipts.map((receipt) => ({
          source: receipt.source,
          receiptId: receipt.receiptId,
          phase: receipt.phase,
          revision: receipt.revision,
          active: receipt.active,
        })),
        receiptRefs: [target],
        outcome: null,
        error: null,
      };
      this.store(userRoot).create(record);
      return {
        operationId: record.operationId,
        actionId: record.actionId,
        boundStateToken: record.boundStateToken,
        expiresAt: record.expiresAt,
        impact: record.impact,
        prepared: true,
      };
    });
  }

  async execute(input: ExecuteManagerActionInput): Promise<ExecuteManagerActionResult> {
    const userRoot = this.userRoot();
    return withLifecycleLock(lifecycleLockFile(userRoot), "manager execute", async () => {
      const now = this.now();
      const executable = requireResolvedExecutable(input.executable);
      const store = this.store(userRoot);
      const record = requireRecord(store.read(input.operationId), input.operationId);
      assertRecordIdentity(record, executable);
      if (record.phase === "cancelled") throw new ManagerActionAdapterError("cancelled", `Operation ${record.operationId} was cancelled`);
      if (record.phase !== "prepared") throw new ManagerActionAdapterError("operation_consumed", `Operation ${record.operationId} is already ${record.phase}`);
      if (Date.parse(record.expiresAt) <= Date.parse(now)) {
        const expired = terminalRecord(record, "cancelled", now, "expired", "The prepared operation expired before execution");
        store.replace(expired);
        throw new ManagerActionAdapterError("operation_expired", `Operation ${record.operationId} expired`);
      }

      // The record's own existence is the only excluded input. This preserves
      // the status token the user confirmed while still detecting every other
      // receipt/config/executable/chronology change (including ABA changes).
      const projection = this.snapshot(userRoot, executable, record.operationId);
      if (projection.stateToken !== record.boundStateToken) {
        const stale = terminalRecord(record, "cancelled", now, "stale-state", "State drifted after preparation; execution was refused");
        store.replace(stale);
        throw staleState("The manager state changed after preparation", projection.stateToken);
      }
      const availability = actionAvailability(projection.actions, record.actionId);
      if (!availability?.available || receiptTarget(projection, record.actionId) !== record.receiptRefs[0]) {
        const stale = terminalRecord(record, "cancelled", now, "stale-target", "The bound receipt target is no longer actionable");
        store.replace(stale);
        throw staleState("The bound receipt is no longer actionable", projection.stateToken);
      }

      // Consumption is persisted and fsynced before any legacy coordinator is
      // invoked. A process crash below can never reopen this approval.
      const consumed: TweakersManagerPreparedOperationV1 = {
        ...record,
        phase: "consumed",
        consumedAt: now,
      };
      store.replace(consumed);

      try {
        const result = await this.executeRecord(consumed);
        const completed = terminalRecord(consumed, "completed", this.now(), result.outcome, null, result.receiptRefs);
        store.replace(completed);
        const current = this.snapshot(userRoot, executable);
        return {
          operationId: completed.operationId,
          outcome: completed.outcome ?? "completed",
          stateToken: current.stateToken,
          receiptRefs: completed.receiptRefs,
        };
      } catch (error) {
        // A thrown typed coordinator call can have made a partial durable
        // change. Keep the consumed barrier and surface recovery-required;
        // callers must use the existing compatibility recovery path until its
        // receipt proves a terminal outcome.
        const recovery = terminalRecord(
          consumed,
          "recovery-required",
          this.now(),
          "recovery-required",
          errorMessage(error),
        );
        store.replace(recovery);
        const current = this.snapshot(userRoot, executable);
        return {
          operationId: recovery.operationId,
          outcome: "recovery-required",
          stateToken: current.stateToken,
          receiptRefs: recovery.receiptRefs,
        };
      }
    });
  }

  async cancel(input: CancelManagerActionInput): Promise<CancelManagerActionResult> {
    const userRoot = this.userRoot();
    return withLifecycleLock(lifecycleLockFile(userRoot), "manager cancel", async () => {
      const executable = requireResolvedExecutable(input.executable);
      const store = this.store(userRoot);
      const record = requireRecord(store.read(input.operationId), input.operationId);
      assertRecordIdentity(record, executable);
      if (record.phase !== "prepared") {
        throw new ManagerActionAdapterError("operation_consumed", `Operation ${record.operationId} is already ${record.phase}`);
      }
      const cancelled = terminalRecord(record, "cancelled", this.now(), "cancelled", null);
      store.replace(cancelled);
      const current = this.snapshot(userRoot, executable);
      return {
        operationId: cancelled.operationId,
        outcome: "cancelled",
        stateToken: current.stateToken,
        receiptRefs: cancelled.receiptRefs,
      };
    });
  }

  /** The status envelope binds only the capability set compiled into this
   * adapter instance. It never learns action IDs from a descriptor or host. */
  actionIds(): readonly TweakersManagerActionIdV1[] {
    return this.enabledActionIds();
  }

  private userRoot(): string {
    return (this.dependencies.userRoot ?? (() => userPaths().root))();
  }

  private now(): string {
    const value = (this.dependencies.now ?? (() => new Date().toISOString()))();
    if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new ManagerActionAdapterError("internal_error", "manager action clock must return RFC3339");
    }
    return value;
  }

  private store(userRoot: string): ManagerOperationStore {
    return (this.dependencies.store ?? ((root) => new ManagerOperationStore(root)))(userRoot);
  }

  private snapshot(
    userRoot: string,
    executable: ManagerExecutableIdentityV1,
    excludeOperationId?: string,
  ) {
    const input: CreateTweakersManagerStatusSnapshotInput = {
      executable,
      paths: managerStatusPaths(userRoot),
      enabledActionIds: this.enabledActionIds(),
      ...(excludeOperationId === undefined ? {} : { excludeOperationId }),
    };
    return (this.dependencies.status ?? createTweakersManagerStatusSnapshot)(input, this.dependencies.statusDependencies);
  }

  private async executeRecord(record: TweakersManagerPreparedOperationV1): Promise<ManagerActionAdapterExecutionResult> {
    const target = record.receiptRefs[0];
    if (!target) throw new ManagerActionAdapterError("internal_error", "prepared operation has no receipt target");
    const [, transactionId] = splitReceiptRef(target);
    switch (record.actionId) {
      case "environment.cancel": {
        const result = await this.requireExecutor(record.actionId, this.dependencies.executeEnvironmentCancel)(transactionId);
        assertEnvironmentTerminal(result, transactionId, ["cancelled", "rolled-back"]);
        return { outcome: "cancelled", receiptRefs: [target] };
      }
      case "environment.recover": {
        const result = await this.requireExecutor(record.actionId, this.dependencies.executeEnvironmentRecover)(transactionId);
        assertEnvironmentTerminal(result, transactionId, ["cancelled", "rolled-back", "committed", "ready"]);
        return { outcome: "recovered", receiptRefs: [target] };
      }
      case "desktop-update.resume": {
        const result = await this.requireExecutor(record.actionId, this.dependencies.executeDesktopResume)(transactionId);
        assertDesktopResult(result, transactionId);
        if (!isTerminalDesktopResult(result)) {
          throw new ManagerActionAdapterError("internal_error", "desktop-update resume did not reach a durable terminal receipt");
        }
        return { outcome: "resumed", receiptRefs: [target] };
      }
      case "desktop-update.cancel": {
        const result = await this.requireExecutor(record.actionId, this.dependencies.executeDesktopCancel)(transactionId);
        assertDesktopResult(result, transactionId);
        if (!isTerminalDesktopResult(result)) {
          throw new ManagerActionAdapterError("internal_error", "desktop-update cancellation did not reach a durable terminal receipt");
        }
        return { outcome: "cancelled", receiptRefs: [target] };
      }
      default:
        throw new ManagerActionAdapterError("unsupported_action", `Action ${record.actionId} is not enabled by the fixed adapter`);
    }
  }

  private enabledActionIds(): readonly TweakersManagerActionIdV1[] {
    const enabled: TweakersManagerActionIdV1[] = [];
    if (this.dependencies.executeEnvironmentCancel) enabled.push("environment.cancel");
    if (this.dependencies.executeEnvironmentRecover) enabled.push("environment.recover");
    if (this.dependencies.executeDesktopResume) enabled.push("desktop-update.resume");
    if (this.dependencies.executeDesktopCancel) enabled.push("desktop-update.cancel");
    return enabled;
  }

  private requireExecutor(
    actionId: TweakersManagerActionIdV1,
    executor: ((transactionId: string) => Promise<unknown>) | undefined,
  ): (transactionId: string) => Promise<unknown> {
    if (!executor) {
      throw new ManagerActionAdapterError(
        "unsupported_action",
        `${actionId} has no manager-safe executor in this sealed runtime`,
      );
    }
    return executor;
  }
}

/**
 * The deployable manager intentionally owns one narrow v1 action only:
 * cancelling an exact pre-cutover environment receipt.  The extracted writer
 * is shared with the legacy coordinator and contains only Node primitives;
 * recovery and desktop actions stay absent until their full proof graphs can
 * be made equally narrow.
 */
export function createSealedTweakersManagerActionAdapter(
  dependencies: SealedManagerActionAdapterDependencies = {},
): TweakersManagerActionAdapter {
  const userRoot = dependencies.userRoot ?? (() => userPaths().root);
  const now = dependencies.now ?? (() => new Date().toISOString());
  return new TweakersManagerActionAdapter({
    ...dependencies,
    userRoot,
    now,
    async executeEnvironmentCancel(transactionId: string) {
      // Prepare has already forced this exact root through the owner-only
      // operation store, but validate again before constructing write paths.
      const root = managerOperationStorePaths(userRoot()).userRoot;
      return cancelPreparedEnvironmentTransaction({
        transactionFile: join(root, "transactions", "environment.json"),
        receiptRoot: join(root, "transactions", "environment"),
        transactionId,
        ownerPid: process.pid,
        now,
        timing: new EnvironmentTimingRecorder(),
      });
    },
  });
}

const ACTION_SPECS: Readonly<Record<"environment.cancel" | "environment.recover" | "desktop-update.resume" | "desktop-update.cancel", { impact: ManagerImpactV1 }>> = {
  "environment.cancel": { impact: "restart-app" },
  "environment.recover": { impact: "restart-app" },
  "desktop-update.resume": { impact: "update-runtime" },
  "desktop-update.cancel": { impact: "update-runtime" },
};

function requireActionSpec(actionId: TweakersManagerActionIdV1): { impact: ManagerImpactV1 } {
  const spec = (ACTION_SPECS as Partial<Record<TweakersManagerActionIdV1, { impact: ManagerImpactV1 }>>)[actionId];
  if (!spec) throw new ManagerActionAdapterError("unsupported_action", `Action ${actionId} is not migrated to the fixed adapter`);
  return spec;
}

function receiptTarget(
  snapshot: ReturnType<typeof createTweakersManagerStatusSnapshot>,
  actionId: TweakersManagerActionIdV1,
): string | null {
  const source = actionId.startsWith("environment.") ? "environment"
    : actionId.startsWith("desktop-update.") ? "desktop-update"
      : null;
  if (source === null) return null;
  const receipt = snapshot.status.receipts.find((candidate) => candidate.source === source);
  return receipt?.state === "valid" && receipt.receiptId !== null ? `${source}:${receipt.receiptId}` : null;
}

function actionAvailability(
  actions: readonly ManagerActionAvailabilityV1[],
  actionId: TweakersManagerActionIdV1,
): ManagerActionAvailabilityV1 | undefined {
  return actions.find((action) => action.actionId === actionId);
}

function requireResolvedExecutable(executable: ManagerExecutableIdentityV1) {
  if (executable.state !== "resolved") {
    throw new ManagerActionAdapterError("operation_conflict", `Manager executable identity is unresolved: ${executable.reason}`);
  }
  return executable;
}

function assertExactEmptyParameters(parameters: Record<string, never>): void {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length !== 0) {
    throw new ManagerActionAdapterError("invalid_request", "This action requires an exact empty parameters object");
  }
}

function assertExpiry(expiresAt: string, now: string): void {
  if (!RFC3339.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new ManagerActionAdapterError("invalid_request", "expires-at must be RFC3339");
  }
  const delta = Date.parse(expiresAt) - Date.parse(now);
  if (delta <= 0) throw new ManagerActionAdapterError("operation_expired", "The requested operation expiry is already elapsed");
  if (delta > MAX_PREPARE_TTL_MS) throw new ManagerActionAdapterError("invalid_request", "Operation expiry exceeds the 10 minute manager limit");
}

function assertRecordIdentity(record: TweakersManagerPreparedOperationV1, executable: ReturnType<typeof requireResolvedExecutable>): void {
  if (record.managerId !== TWEAKERS_MANAGER_ID
    || record.moduleIdentity.path !== executable.path
    || record.moduleIdentity.sha256 !== executable.sha256) {
    throw new ManagerActionAdapterError("operation_conflict", "Prepared operation belongs to a different manager executable");
  }
}

function requireRecord(record: TweakersManagerPreparedOperationV1 | null, operationId: string): TweakersManagerPreparedOperationV1 {
  if (record === null) throw new ManagerActionAdapterError("operation_conflict", `Prepared operation ${operationId} was not found`);
  return record;
}

function terminalRecord(
  record: TweakersManagerPreparedOperationV1,
  phase: "cancelled" | "completed" | "failed" | "recovery-required",
  timestamp: string,
  outcome: string,
  error: string | null,
  receiptRefs: readonly string[] = record.receiptRefs,
): TweakersManagerPreparedOperationV1 {
  const base = {
    ...record,
    phase,
    cancelledAt: null,
    completedAt: null,
    failedAt: null,
    recoveryRequiredAt: null,
    receiptRefs: [...receiptRefs],
    outcome,
    error,
  } as TweakersManagerPreparedOperationV1;
  if (phase === "cancelled") return { ...base, cancelledAt: timestamp, consumedAt: record.consumedAt };
  if (phase === "completed") return { ...base, completedAt: timestamp };
  if (phase === "failed") return { ...base, failedAt: timestamp };
  return { ...base, recoveryRequiredAt: timestamp };
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalManagerJson(value), "utf8").digest("hex")}`;
}

function splitReceiptRef(value: string): ["environment" | "desktop-update", string] {
  const match = /^(environment|desktop-update):(.+)$/.exec(value);
  if (!match) throw new ManagerActionAdapterError("internal_error", "prepared operation has an invalid receipt target");
  return [match[1] as "environment" | "desktop-update", match[2]!];
}

function assertEnvironmentTerminal(value: unknown, expectedTransactionId: string, phases: readonly string[]): void {
  if (!isRecord(value)
    || value.transactionId !== expectedTransactionId
    || typeof value.phase !== "string"
    || !phases.includes(value.phase)) {
    throw new ManagerActionAdapterError("internal_error", "environment action did not produce the expected durable terminal receipt");
  }
}

function assertDesktopResult(value: unknown, expectedTransactionId: string): void {
  if (!isRecord(value) || value.transactionId !== expectedTransactionId || typeof value.phase !== "string") {
    throw new ManagerActionAdapterError("internal_error", "desktop-update action did not produce the expected durable receipt");
  }
}

function isTerminalDesktopResult(value: unknown): boolean {
  return isRecord(value) && typeof value.phase === "string" && ["completed", "rolled_back", "failed"].includes(value.phase)
    && value.resumable !== true && value.safeOfficialMode === true;
}

function staleState(message: string, currentStateToken: `sha256:${string}`): ManagerActionAdapterError {
  return new ManagerActionAdapterError("stale_state", message, currentStateToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Keep these imports used in the public type surface when the runtime is
// bundled; they also make the explicit owner-only root contract discoverable
// to tests without allowing callers to supply a path through the protocol.
export type { ManagerOperationStorePaths };

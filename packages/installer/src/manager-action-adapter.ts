import { assertHistoricalManagerAdmission } from "./manager-historical-continuations.js";
import { readManagerAcceptedBackendRecoveryEvidence, settleManagerAcceptedBackendRecovery, settleVerifiedManagerRecoveryOperations } from "./manager-recovery-evidence.js";
import { acquireProcessLock } from "./process-lock.js";
import { operationErrorMessage } from "./operation-error.js";
import { readLiveAccountRouterBrokerStatus } from "./account-router-status.js";
import { defaultTweakersAccountsBrokerRoot } from "./macos-variant.js";
import { canonicalTweakersManagerRoot } from "./manager-descriptor.js";
import { withLocalOperation } from "./local-operation.js";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { writeDoctorPrivateJson } from "./doctor-store.js";
import {
  observeCodexMainProcess,
  openAndActivateCodex,
  quitCodexMainProcess,
  type CodexMainProcessObservation,
} from "./alerts.js";
import {
  MANAGER_REFRESH_TIMING_PHASES_V1,
  canonicalManagerJson,
  type ManagerActionAvailabilityV1,
  type ManagerExecutableIdentityV1,
  type ManagerImpactV1,
  type ManagerRefreshTimingEvidenceV1,
  type ManagerRefreshTimingPhaseEvidenceV1,
  type ManagerRefreshTimingPhaseV1,
  type TweakersManagerActionIdV1,
  type TweakersManagerPreparedOperationV1,
  TWEAKERS_MANAGER_ACTION_IDS_V1,
  TWEAKERS_MANAGER_ID,
} from "./manager-contract.js";
import { EnvironmentTimingRecorder } from "./environment-timing.js";
import { lifecycleLockFile, withLifecycleLock } from "./lifecycle-lock-core.js";
import { cancelPreparedEnvironmentTransaction } from "./manager-environment-action.js";
import {
  InstallerEnvironmentCoordinator,
  type EnvironmentAppliedEvidence,
  type EnvironmentTransactionReceipt,
} from "./environment-transaction.js";
import {
  createRequestedEnvironmentSelection,
  readEnvironmentProfileRegistry,
  readEnvironmentSelection,
} from "./environment-profile.js";
import { ManagerOperationStore, managerOperationStorePaths, isManagerOperationId, type ManagerOperationStorePaths } from "./manager-operation-store.js";
import { createTweakersManagerStatusSnapshot, managerStatusPaths, type CreateTweakersManagerStatusSnapshotInput, type ManagerStatusDependencies } from "./manager-status.js";
import { resolveSealedTweakersManagerUserRoot } from "./manager-descriptor.js";
import {
  acquireRegisteredOfficialSourceLease,
  readRegisteredOfficialSourceStatusProjection,
  registerOfficialSourceEvidence,
} from "./official-source-registration.js";
import {
  resolveSealedManagerManagedRuntimeAssets,
  resolveSealedManagerRuntimeAssets,
  verifySealedManagerManagedRuntimeAssets,
  verifySealedManagerRuntimeAssets,
} from "./manager-runtime-assets.js";
import {
  prepareManagedAccountContinuityPrelaunch,
  type AccountContinuityPrelaunchResultV1,
} from "./account-continuity-prelaunch.js";
import { getOpenReport, listProcesses, type ProcessInfo } from "./commands/debug.js";
import { locateCodexAtExactPath } from "./platform.js";
import { userPaths } from "./paths.js";
import type { DeferredTweakersVariantRefresh } from "./commands/create-variant.js";
import { ForwardBackendTransitionRecoveryRequired } from "./shared-native-backend-transition.js";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PREPARE_TTL_MS = 10 * 60 * 1000;
const INDEPENDENT_TWEAKERS_APP = "/Applications/Tweakers.app";
const INDEPENDENT_REOPEN_PROCESS_TIMEOUT_MS = 30_000;
const INDEPENDENT_RUNTIME_READY_TIMEOUT_MS = 60_000;
const INDEPENDENT_REOPEN_PROOF_POLL_MS = 250;

export interface IndependentRefreshInput {
  app: string;
  /** Omit this so create-variant must use its sealed inactive-environment source. */
  source?: string;
  userRoot: string;
}

export interface IndependentRefreshExecutionInput {
  operationId: string;
  sourceGenerationId: string;
  sourceReceiptDigest: string;
}

/** Internal-only phase reporter. It is passed only between the sealed
 * adapter and its fixed local executors; it is not a manager protocol value. */
export interface ManagerRefreshTimingProgress {
  start(phase: ManagerRefreshTimingPhaseV1): Promise<void>;
  complete(phase: ManagerRefreshTimingPhaseV1): Promise<void>;
  unavailable(phases: readonly ManagerRefreshTimingPhaseV1[], reason: string): Promise<void>;
}

export interface OfficialSourceRegistrationExecutionInput {
  operationId: string;
  sourceDigest: string;
  managerExecutable: {
    state: "resolved";
    path: string;
    sha256: string;
  };
}

/**
 * Every value comes from the receipt reference persisted at manager prepare.
 * The renderer has no parameter surface for this action.
 */
export interface InjectedRefreshExecutionInput {
  operationId: string;
  consumedAt: string;
  sourceGenerationId: string;
  sourceReceiptDigest: string;
  sourceDigest: string;
  sourceRevision: string;
  managerRuntimeFingerprint: string;
  selectionRevision: string;
  registryRevision: string;
}

/** A static app copy can never satisfy this result shape. */
export interface InjectedRefreshExecutionResult {
  transactionId: string;
  phase: "committed";
  oldMainPid: number | null;
  newMainPid: number;
  applied: EnvironmentAppliedEvidence;
  runtimeVerified: true;
}

/** Test-only dependencies for the fixed independent-app lifecycle helper.
 * They are deliberately absent from the sealed adapter factory. */
export interface SealedIndependentRefreshLifecycleForTest {
  reserveCutover?(): Promise<{ release(): Promise<void> }>;
  observe(app: string): CodexMainProcessObservation | null;
  quit(app: string, expectedPid: number): void;
  relatedPids(app: string): number[];
  listProcesses(): ProcessInfo[];
  signal(pid: number, signal: NodeJS.Signals): void;
  reopen(app: string): void;
  refresh(
    input: IndependentRefreshInput,
    execution: IndependentRefreshExecutionInput,
    sourceAuthorityRoot: string,
    beforePromotion: () => Promise<void>,
    beforeRollback: () => void,
  ): Promise<DeferredTweakersVariantRefresh>;
  readRuntimeReady(userRoot: string): unknown | null;
  /** Main-owned signed preparation latency only; never a request/approval override. */
  runtimeReadyTimeoutMs?(accountsBrokerRoot: string): number;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  sealedAccountsRuntimeRoot(managerRoot: string): string | Promise<string>;
  verifyAccountsTransferRecovery(runtimeRoot: string): boolean;
  prepareAccountContinuity(stateRoot: string): AccountContinuityPrelaunchResultV1;
}

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
  /** Generic adapter test seam. The sealed factory replaces this with its
   * fixed executor and discards any caller-provided value. */
  executeRefreshInjected?: (
    input: InjectedRefreshExecutionInput,
    timing?: ManagerRefreshTimingProgress,
  ) => Promise<InjectedRefreshExecutionResult>;
  /** Test-only stand-in for the compiled sealed active-runtime fingerprint. */
  managerRuntimeFingerprint?: () => string | null;
  executeRefreshIndependent?: (
    input: IndependentRefreshExecutionInput,
    timing?: ManagerRefreshTimingProgress,
  ) => Promise<unknown>;
  executeOfficialSourceRegister?: (input: OfficialSourceRegistrationExecutionInput) => Promise<unknown>;
  /** Test seam for monotonic refresh phase measurements. */
  timingMonotonicMs?: () => number;
}

/** Dependencies allowed for the production sealed adapter.  Its capability
 * set is fixed in source; callers cannot inject another coordinator through
 * this factory. */
export type SealedManagerActionAdapterDependencies = Omit<
  ManagerActionAdapterDependencies,
  "executeEnvironmentCancel" | "executeEnvironmentRecover" | "executeRefreshInjected" | "executeRefreshIndependent" | "executeOfficialSourceRegister"
  | "managerRuntimeFingerprint"
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

type ExecutablePreparedOperation = TweakersManagerPreparedOperationV1 & {
  actionId: TweakersManagerActionIdV1;
};

/**
 * Prepared-operation core for the receipt-bearing migration candidates. It
 * never turns user/descriptor data into argv or subprocess commands. This
 * file intentionally contains no legacy coordinator import: the sealed
 * manager exposes an action only when a manager-safe executor is linked. The
 * production factory links only the fixed executors below; the separate
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
      let snapshot = this.snapshot(userRoot, executable, undefined, input.actionId);
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
      assertHistoricalManagerAdmission(userRoot);
      if (settleVerifiedManagerRecoveryOperations(userRoot, this.store(userRoot), now).length) {
        snapshot = this.snapshot(userRoot, executable, undefined, input.actionId);
      }
      const target = this.receiptTarget(snapshot, input.actionId);
      if (target === null) {
        throw new ManagerActionAdapterError("unsupported_action", `Action ${input.actionId} has no exact durable receipt target`, snapshot.stateToken);
      }
      const receiptRefs = receiptReferencesForPreparedAction(input.actionId, target, input.operationId);
      const record: TweakersManagerPreparedOperationV1 = {
        schemaVersion: 1,
        kind: "tweakers-manager-operation",
        managerId: TWEAKERS_MANAGER_ID,
        protocolVersion: 1,
        operationId: input.operationId,
        preparedRequestId: input.requestId,
        actionId: input.actionId,
        moduleIdentity: executable,
        boundStateToken: snapshot.stateToken,
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
        receiptRefs,
        ...(isRefreshAction(input.actionId) ? { timing: createRefreshTimingEvidence() } : {}),
        outcome: null,
        error: null,
      };
      this.store(userRoot).create(record);
      return {
        operationId: record.operationId,
        actionId: input.actionId,
        boundStateToken: record.boundStateToken,
        expiresAt: record.expiresAt,
        impact: record.impact,
        prepared: true,
      };
    });
  }

  async execute(input: ExecuteManagerActionInput): Promise<ExecuteManagerActionResult> {
    return withLocalOperation(`manager:${input.operationId}`, () => this.executeOwned(input));
  }

  private async executeOwned(input: ExecuteManagerActionInput): Promise<ExecuteManagerActionResult> {
    const userRoot = this.userRoot();
    const executable = requireResolvedExecutable(input.executable);
    const consumed = await withLifecycleLock(lifecycleLockFile(userRoot), "manager execute consume", async () => {
      const now = this.now();
      const store = this.store(userRoot);
      const record = requireRecord(store.read(input.operationId), input.operationId);
      assertRecordIdentity(record, executable);
      const actionableRecord = requireExecutablePreparedOperation(record);
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
      const projection = this.snapshot(userRoot, executable, record.operationId, actionableRecord.actionId);
      if (projection.stateToken !== record.boundStateToken) {
        const stale = terminalRecord(record, "cancelled", now, "stale-state", "State drifted after preparation; execution was refused");
        store.replace(stale);
        throw staleState("The manager state changed after preparation", projection.stateToken);
      }
      const availability = actionAvailability(projection.actions, actionableRecord.actionId);
      const expectedRefs = this.receiptReferences(projection, actionableRecord.actionId, record.operationId);
      if (!availability?.available || expectedRefs === null || !sameReceiptReferences(record.receiptRefs, expectedRefs)) {
        const stale = terminalRecord(record, "cancelled", now, "stale-target", "The bound receipt target is no longer actionable");
        store.replace(stale);
        throw staleState("The bound receipt is no longer actionable", projection.stateToken);
      }

      assertHistoricalManagerAdmission(userRoot);

      // Consumption is persisted and fsynced before any legacy coordinator is
      // invoked. A process crash below can never reopen this approval.
      const consumed: ExecutablePreparedOperation = {
        ...actionableRecord,
        phase: "consumed",
        consumedAt: now,
      };
      store.replace(consumed);
      return consumed;
    });

    // The coordinator acquires this same lifecycle authority while preparing
    // and committing. The manager's approval is already fsynced above, so no
    // mutation can occur before consumption even though execution runs outside
    // the outer manager lock.
    const timing = isRefreshAction(consumed.actionId)
      ? this.refreshTimingReporter(userRoot, executable, consumed)
      : null;
    try {
      const result = await this.executeRecord(consumed, timing);
      await timing?.finish("completed");
      return this.terminalizeConsumedOperation(
        userRoot,
        executable,
        consumed,
        "completed",
        result.outcome,
        null,
        result.receiptRefs,
      );
    } catch (error) {
      try {
        await timing?.finish("recovery-required");
      } catch (timingError) {
        error = new AggregateError([error, timingError], "The manager could not durably finalize refresh timing evidence.");
      }
      return this.terminalizeConsumedOperation(
        userRoot,
        executable,
        consumed,
        "recovery-required",
        "recovery-required",
        errorMessage(error),
      );
    }
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
    actionId?: TweakersManagerActionIdV1,
  ) {
    const input: CreateTweakersManagerStatusSnapshotInput = {
      executable,
      paths: managerStatusPaths(userRoot),
      enabledActionIds: this.enabledActionIds(),
      officialSourceVerification: actionId === "official-source.register" ? "strict" : "projected",
      ...(excludeOperationId === undefined ? {} : { excludeOperationId }),
    };
    return (this.dependencies.status ?? createTweakersManagerStatusSnapshot)(input, this.dependencies.statusDependencies);
  }

  private managerRuntimeFingerprint(): string | null {
    const supplied = this.dependencies.managerRuntimeFingerprint?.();
    if (supplied !== undefined) return supplied;
    return resolveSealedManagerRuntimeAssets()?.fingerprint ?? null;
  }

  private receiptTarget(
    snapshot: ReturnType<typeof createTweakersManagerStatusSnapshot>,
    actionId: TweakersManagerActionIdV1,
  ): string | null {
    return receiptTarget(snapshot, actionId, this.managerRuntimeFingerprint());
  }

  private receiptReferences(
    snapshot: ReturnType<typeof createTweakersManagerStatusSnapshot>,
    actionId: TweakersManagerActionIdV1,
    operationId: string,
  ): readonly string[] | null {
    const target = this.receiptTarget(snapshot, actionId);
    return target === null ? null : receiptReferencesForPreparedAction(actionId, target, operationId);
  }

  private refreshTimingReporter(
    userRoot: string,
    executable: ReturnType<typeof requireResolvedExecutable>,
    record: ExecutablePreparedOperation,
  ): ManagerRefreshTimingReporter {
    if (record.timing === undefined) {
      throw new ManagerActionAdapterError("internal_error", "Refresh operation has no timing evidence");
    }
    return new ManagerRefreshTimingReporter(
      record.timing,
      this.now.bind(this),
      this.dependencies.timingMonotonicMs ?? (() => performance.now()),
      async (timing) => withLifecycleLock(lifecycleLockFile(userRoot), "manager execute timing", async () => {
        const store = this.store(userRoot);
        const current = requireRecord(store.read(record.operationId), record.operationId);
        assertRecordIdentity(current, executable);
        if (current.phase !== "consumed" || !sameConsumedOperationIdentity(current, record)) {
          throw new ManagerActionAdapterError(
            "operation_conflict",
            `Operation ${record.operationId} changed while its timing was being recorded`,
          );
        }
        store.replace({ ...current, timing });
      }),
    );
  }

  private async terminalizeConsumedOperation(
    userRoot: string,
    executable: ReturnType<typeof requireResolvedExecutable>,
    consumed: TweakersManagerPreparedOperationV1,
    phase: "completed" | "recovery-required",
    outcome: string,
    error: string | null,
    receiptRefs: readonly string[] = consumed.receiptRefs,
  ): Promise<ExecuteManagerActionResult> {
    return withLifecycleLock(lifecycleLockFile(userRoot), "manager execute terminalize", async () => {
      const store = this.store(userRoot);
      const currentRecord = requireRecord(store.read(consumed.operationId), consumed.operationId);
      assertRecordIdentity(currentRecord, executable);
      if (!sameConsumedRecord(currentRecord, consumed)) {
        throw new ManagerActionAdapterError(
          "operation_conflict",
          `Operation ${consumed.operationId} changed while its consumed execution was running`,
        );
      }
      const terminal = terminalRecord(currentRecord, phase, this.now(), outcome, error, receiptRefs);
      store.replace(terminal);
      const current = this.snapshot(userRoot, executable);
      return {
        operationId: terminal.operationId,
        outcome: terminal.outcome ?? outcome,
        stateToken: current.stateToken,
        receiptRefs: terminal.receiptRefs,
      };
    });
  }

  private async executeRecord(
    record: ExecutablePreparedOperation,
    timing: ManagerRefreshTimingProgress | null,
  ): Promise<ManagerActionAdapterExecutionResult> {
    const target = record.receiptRefs[0];
    if (!target) throw new ManagerActionAdapterError("internal_error", "prepared operation has no receipt target");
    switch (record.actionId) {
      case "environment.cancel": {
        const [, transactionId] = splitReceiptRef(target);
        const result = await this.requireExecutor(record.actionId, this.dependencies.executeEnvironmentCancel)(transactionId);
        assertEnvironmentTerminal(result, transactionId, ["cancelled", "rolled-back"]);
        return { outcome: "cancelled", receiptRefs: [target] };
      }
      case "environment.recover": {
        const [, transactionId] = splitReceiptRef(target);
        const result = await this.requireExecutor(record.actionId, this.dependencies.executeEnvironmentRecover)(transactionId);
        assertEnvironmentTerminal(result, transactionId, ["cancelled", "rolled-back", "committed", "ready"]);
        return { outcome: "recovered", receiptRefs: [target] };
      }
      case "refresh.injected": {
        const binding = parseInjectedRefreshBinding(target);
        const environmentRef = record.receiptRefs[1];
        if (environmentRef !== `environment:${record.operationId}` || record.receiptRefs.length !== 2) {
          throw new ManagerActionAdapterError("internal_error", "Injected refresh has no exact operation-bound environment receipt reference");
        }
        if (record.consumedAt === null) {
          throw new ManagerActionAdapterError("internal_error", "Injected refresh execution requires a consumed manager record");
        }
        const result = await this.requireInjectedRefreshExecutor(record.actionId, this.dependencies.executeRefreshInjected)({
          operationId: record.operationId,
          consumedAt: record.consumedAt,
          sourceGenerationId: binding.sourceGenerationId,
          sourceReceiptDigest: binding.sourceReceiptDigest,
          sourceDigest: binding.sourceDigest,
          sourceRevision: binding.sourceRevision,
          managerRuntimeFingerprint: binding.managerRuntimeFingerprint,
          selectionRevision: binding.selectionRevision,
          registryRevision: binding.registryRevision,
        }, timing ?? undefined);
        await timing?.start("verify");
        try {
          assertInjectedRefreshExecutionResult(result, record.operationId, record);
          await timing?.complete("verify");
        } catch (error) {
          throw error;
        }
        return { outcome: "injected-tweakers-runtime-verified", receiptRefs: record.receiptRefs };
      }
      case "refresh.independent": {
        const source = parseIndependentRefreshSourceBinding(target);
        await this.requireIndependentRefreshExecutor(record.actionId, this.dependencies.executeRefreshIndependent)({
          operationId: record.operationId,
          sourceGenerationId: source.generationId,
          sourceReceiptDigest: source.receiptDigest,
        }, timing ?? undefined);
        return { outcome: "rebuilt-independent-tweakers", receiptRefs: [target] };
      }
      case "official-source.register": {
        const sourceDigest = parseOfficialSourceRegistrationBinding(target);
        const result = await this.requireOfficialSourceRegistrationExecutor(
          record.actionId,
          this.dependencies.executeOfficialSourceRegister,
        )({
          operationId: record.operationId,
          sourceDigest,
          managerExecutable: record.moduleIdentity,
        });
        const receiptRef = registrationReceiptRef(result);
        return { outcome: "registered-official-source", receiptRefs: [receiptRef] };
      }
      default:
        throw new ManagerActionAdapterError("unsupported_action", `Action ${record.actionId} is not enabled by the fixed adapter`);
    }
  }

  private enabledActionIds(): readonly TweakersManagerActionIdV1[] {
    const enabled: TweakersManagerActionIdV1[] = [];
    if (this.dependencies.executeEnvironmentCancel) enabled.push("environment.cancel");
    if (this.dependencies.executeEnvironmentRecover) enabled.push("environment.recover");
    if (this.dependencies.executeRefreshInjected) enabled.push("refresh.injected");
    if (this.dependencies.executeRefreshIndependent) enabled.push("refresh.independent");
    if (this.dependencies.executeOfficialSourceRegister) enabled.push("official-source.register");
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

  private requireIndependentRefreshExecutor(
    actionId: TweakersManagerActionIdV1,
    executor: ((input: IndependentRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<unknown>) | undefined,
  ): (input: IndependentRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<unknown> {
    if (!executor) {
      throw new ManagerActionAdapterError(
        "unsupported_action",
        `${actionId} has no manager-safe executor in this sealed runtime`,
      );
    }
    return executor;
  }

  private requireOfficialSourceRegistrationExecutor(
    actionId: TweakersManagerActionIdV1,
    executor: ((input: OfficialSourceRegistrationExecutionInput) => Promise<unknown>) | undefined,
  ): (input: OfficialSourceRegistrationExecutionInput) => Promise<unknown> {
    if (!executor) {
      throw new ManagerActionAdapterError(
        "unsupported_action",
        `${actionId} has no manager-safe executor in this sealed runtime`,
      );
    }
    return executor;
  }

  private requireInjectedRefreshExecutor(
    actionId: TweakersManagerActionIdV1,
    executor: ((input: InjectedRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<InjectedRefreshExecutionResult>) | undefined,
  ): (input: InjectedRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<InjectedRefreshExecutionResult> {
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
 * The deployable manager exposes only the fixed, source-linked executors
 * below. Callers cannot provide an arbitrary executor through this factory.
 */
export function createSealedTweakersManagerActionAdapter(
  dependencies: SealedManagerActionAdapterDependencies = {},
): TweakersManagerActionAdapter {
  // The native launcher starts the sealed manager with an empty environment.
  // Its ordinary root must therefore be canonical Tweakers data rather than
  // the legacy on-disk discovery fallback used by pre-publication callers.
  const userRoot = dependencies.userRoot ?? resolveSealedTweakersManagerUserRoot;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const executeIndependentRefresh = createSealedIndependentRefreshExecutor(userRoot);
  const executeInjectedRefresh = createSealedInjectedRefreshExecutor(userRoot, now);
  // The omitted executor keys remain present on a widened TypeScript object or
  // a JavaScript caller. Copy and remove them at the runtime boundary so the
  // sealed adapter's capability set cannot be widened by object spreading.
  const sealedDependencies: ManagerActionAdapterDependencies = { ...dependencies };
  delete sealedDependencies.executeEnvironmentCancel;
  delete sealedDependencies.executeEnvironmentRecover;
  delete sealedDependencies.executeRefreshInjected;
  delete sealedDependencies.executeRefreshIndependent;
  delete sealedDependencies.executeOfficialSourceRegister;
  delete sealedDependencies.managerRuntimeFingerprint;
  return new TweakersManagerActionAdapter({
    ...sealedDependencies,
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
    async executeRefreshInjected(input: InjectedRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) {
      return executeInjectedRefresh(input, timing);
    },
    async executeRefreshIndependent(input: IndependentRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) {
      await executeIndependentRefresh(input, timing);
      return { completed: true };
    },
    async executeOfficialSourceRegister(input: OfficialSourceRegistrationExecutionInput) {
      return registerOfficialSourceEvidence({
        root: managerOperationStorePaths(userRoot()).userRoot,
        operationId: input.operationId,
        expectedSourceDigest: input.sourceDigest,
        managerExecutable: input.managerExecutable,
      });
    },
  });
}

/**
 * The injected executor is intentionally fixed to the global stable ChatGPT
 * environment. It accepts only the manager record's already-parsed binding;
 * no renderer parameter, updater API, or live-app candidate source is in its
 * surface area.
 */
function createSealedInjectedRefreshExecutor(
  userRoot: () => string,
  now: () => string,
): (execution: InjectedRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<InjectedRefreshExecutionResult> {
  return async (execution, timing) => {
    const root = managerOperationStorePaths(userRoot()).userRoot;
    const paths = managerStatusPaths(root);
    await timing?.unavailable(
      ["apfs-clone", "sign", "runtime-ready-wait"],
      "The sealed environment transaction does not expose this boundary.",
    );
    await timing?.start("source-validation");
    const lease = acquireRegisteredOfficialSourceLease(root);
    let coordinator: InstallerEnvironmentCoordinator;
    try {
      assertLeasedSourceMatchesBinding(root, lease, execution);

      const sealedRuntime = resolveSealedManagerRuntimeAssets();
      if (sealedRuntime === null) {
        throw new ManagerActionAdapterError(
          "unsupported_action",
          "The sealed manager has no compiled active-runtime generation for injected refresh",
        );
      }
      const runtimeEvidence = verifySealedManagerRuntimeAssets(sealedRuntime);
      if (runtimeEvidence.fingerprint !== execution.managerRuntimeFingerprint) {
        throw new ManagerActionAdapterError("stale_state", "The sealed manager active-runtime generation changed after preparation");
      }

      const sealedManagedRuntime = resolveSealedManagerManagedRuntimeAssets();
      if (sealedManagedRuntime === null) {
        throw new ManagerActionAdapterError(
          "unsupported_action",
          "The sealed manager has no compiled managed-runtime generation for injected refresh",
        );
      }
      const managedRuntimeEvidence = verifySealedManagerManagedRuntimeAssets(sealedManagedRuntime);
      if (managedRuntimeEvidence.fingerprint !== sealedManagedRuntime.fingerprint) {
        throw new ManagerActionAdapterError("internal_error", "The sealed manager managed-runtime generation failed its binding");
      }

      const registry = readEnvironmentProfileRegistry(paths.environmentRegistryFile);
      const current = readEnvironmentSelection(paths.environmentSelectionFile);
      if (registry === null || current === null) {
        throw new ManagerActionAdapterError("stale_state", "The canonical environment registry or selection is unavailable");
      }
      if (fileRevision(paths.environmentRegistryFile) !== execution.registryRevision
        || fileRevision(paths.environmentSelectionFile) !== execution.selectionRevision) {
        throw new ManagerActionAdapterError("stale_state", "The canonical environment registry or selection changed after preparation");
      }
      assertFixedStableChatGptSelection(current);
      assertRegistryMatchesLeasedStableSource(registry, lease);
      const requested = createRequestedEnvironmentSelection(
        registry,
        { releaseProfile: "stable", appExperience: "tweakers" },
        execution.consumedAt,
      );
      if (requested.selectedDesktopPath !== "/Applications/ChatGPT.app"
        || requested.selectedDesktopBundleId !== "com.openai.codex"
        || requested.releaseProfile !== "stable"
        || requested.appExperience !== "tweakers") {
        throw new ManagerActionAdapterError("internal_error", "The environment registry produced an unexpected injected target");
      }

      const candidateSource = lease.receipt.artifact.appPath;
      if (candidateSource === "/Applications/ChatGPT.app") {
        throw new ManagerActionAdapterError("internal_error", "Injected refresh may not construct a candidate from live ChatGPT");
      }
      await timing?.complete("source-validation");
      await timing?.start("patch-stage");
      coordinator = new InstallerEnvironmentCoordinator({
        environmentRoot: root,
        transactionFile: paths.environmentTransactionFile,
        receiptRoot: join(root, "transactions", "environment"),
        registryFile: paths.environmentRegistryFile,
        selectionFile: paths.environmentSelectionFile,
        configFile: paths.configFile,
        stateFile: paths.stateFile,
        sealedCandidateSourceApp: candidateSource,
        sealedManagedRuntime: {
          sourceRoot: sealedManagedRuntime.root,
          generationId: sealedManagedRuntime.fingerprint,
          fingerprint: sealedManagedRuntime.fingerprint,
          sourceRuntimeHash: null,
        },
      }, {
        createId: () => execution.operationId,
        now,
      });
      const prepared = await coordinator.prepare({ current, requested });
      if (prepared.transactionId !== execution.operationId || prepared.phase !== "prepared") {
        throw new ManagerActionAdapterError("internal_error", "Injected refresh did not persist the exact prepared environment receipt");
      }
      await timing?.complete("patch-stage");
    } finally {
      // The lease remains held through all candidate/rollback staging and
      // receipt validation, then the coordinator owns only receipt bytes.
      lease.release();
    }

    await timing?.start("quiesce-promote");
    const committed = await coordinator.commit(execution.operationId, execution.consumedAt);
    await timing?.complete("quiesce-promote");
    return committedInjectedRefreshResult(committed, execution.operationId);
  };
}

function assertLeasedSourceMatchesBinding(
  root: string,
  lease: ReturnType<typeof acquireRegisteredOfficialSourceLease>,
  execution: InjectedRefreshExecutionInput,
): void {
  const projection = readRegisteredOfficialSourceStatusProjection(root);
  if (projection.state !== "ready"
    || projection.generationId !== execution.sourceGenerationId
    || projection.receiptDigest !== execution.sourceReceiptDigest
    || projection.sourceDigest !== execution.sourceDigest
    || projection.revision !== execution.sourceRevision
    || projection.version === null
    || projection.build === null
    || lease.receipt.generationId !== execution.sourceGenerationId
    || lease.receiptDigest !== execution.sourceReceiptDigest
    || lease.pointer.generationId !== execution.sourceGenerationId
    || lease.pointer.receiptDigest !== execution.sourceReceiptDigest
    || lease.pointer.sourceDigest !== execution.sourceDigest
    || lease.pointer.version !== projection.version
    || lease.pointer.build !== projection.build
    || lease.receipt.source.version !== projection.version
    || lease.receipt.source.build !== projection.build) {
    throw new ManagerActionAdapterError("stale_state", "The registered stable ChatGPT source changed after preparation");
  }
}

function assertFixedStableChatGptSelection(
  selection: ReturnType<typeof readEnvironmentSelection>,
): asserts selection is NonNullable<ReturnType<typeof readEnvironmentSelection>> {
  if (selection === null
    || selection.selectedDesktopPath !== "/Applications/ChatGPT.app"
    || selection.selectedDesktopBundleId !== "com.openai.codex"
    || selection.releaseProfile !== "stable"
    || selection.appExperience !== "chatgpt"
    || selection.migrationState !== "verified") {
    throw new ManagerActionAdapterError("stale_state", "Injected refresh requires the verified fixed stable ChatGPT selection");
  }
}

function assertRegistryMatchesLeasedStableSource(
  registry: NonNullable<ReturnType<typeof readEnvironmentProfileRegistry>>,
  lease: ReturnType<typeof acquireRegisteredOfficialSourceLease>,
): void {
  const profile = registry.profiles.stable;
  if (profile === undefined
    || profile.officialPath !== "/Applications/ChatGPT.app"
    || profile.officialBundleId !== "com.openai.codex"
    || profile.officialVersion !== lease.pointer.version
    || profile.officialBuild !== lease.pointer.build
    || profile.strictSignature !== true
    || profile.gatekeeper !== true
    || registry.selected === null
    || registry.selected.selectedDesktopPath !== "/Applications/ChatGPT.app"
    || registry.selected.selectedDesktopBundleId !== "com.openai.codex"
    || registry.selected.releaseProfile !== "stable"
    || registry.selected.appExperience !== "chatgpt"
    || registry.selected.migrationState !== "verified") {
    throw new ManagerActionAdapterError("stale_state", "The stable environment registry no longer matches the sealed official source");
  }
}

function fileRevision(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function committedInjectedRefreshResult(
  receipt: EnvironmentTransactionReceipt,
  operationId: string,
): InjectedRefreshExecutionResult {
  if (receipt.transactionId !== operationId
    || receipt.phase !== "committed"
    || receipt.applied === null
    || typeof receipt.newMainPid !== "number"
    || !Number.isInteger(receipt.newMainPid)
    || receipt.newMainPid <= 0
    || (receipt.oldMainPid !== null && receipt.newMainPid === receipt.oldMainPid)) {
    throw new ManagerActionAdapterError(
      "internal_error",
      "Injected refresh did not reach a committed environment receipt with a new main PID and runtime proof",
    );
  }
  return {
    transactionId: receipt.transactionId,
    phase: "committed",
    oldMainPid: receipt.oldMainPid,
    newMainPid: receipt.newMainPid,
    applied: receipt.applied,
    runtimeVerified: true,
  };
}

/** A legacy broker cannot prove comprehensive idleness. Require natural closure
 * and hold its existing admission endpoint across the final cutover instead. */
export async function reserveClosedIndependentTweakersCutover(): Promise<{ release(): Promise<void> }> {
  const assertClosed = (): void => {
    if (observeCodexMainProcess(INDEPENDENT_TWEAKERS_APP) !== null
      || getOpenReport(locateCodexAtExactPath(INDEPENDENT_TWEAKERS_APP)).relatedPids.length > 0) {
      throw new ManagerActionAdapterError("operation_conflict", "Finish active work and quit Tweakers before updating. No desktop or helper was interrupted.");
    }
  };
  assertClosed();
  const root = defaultTweakersAccountsBrokerRoot();
  const observed = await readLiveAccountRouterBrokerStatus(root);
  if (observed.state !== "not_running") throw new ManagerActionAdapterError("operation_conflict",
    "Tweakers broker must finish active work and stop before updating; active or unavailable activity evidence cannot prove idle.");
  const assets = resolveSealedManagerManagedRuntimeAssets();
  if (!assets) throw new Error("Cutover requires the sealed Manager runtime");
  verifySealedManagerManagedRuntimeAssets(assets);
  const broker = createRequire(import.meta.url)(join(assets.root, "packages", "installer", "assets", "runtime", "account-router", "broker-socket.js")) as {
    readAccountsBrokerSecret(root: string): Buffer | null;
    reserveAccountsBrokerSocket(options: {root: string; secret: Buffer}): Promise<{close(): Promise<void>}>;
  };
  const secret = broker.readAccountsBrokerSecret(root);
  if (!secret) throw new Error("Cutover broker capability is unavailable");
  let desktop: ReturnType<typeof acquireProcessLock> | undefined;
  let admission: {close(): Promise<void>} | undefined;
  try {
    desktop = acquireProcessLock(join(canonicalTweakersManagerRoot(), "desktop-instance.lock"));
    admission = await broker.reserveAccountsBrokerSocket({root, secret});
    assertClosed();
    let released = false;
    return {async release() {
      if (released) return;
      released = true;
      try { await admission!.close(); }
      finally { desktop!.release(); secret.fill(0); }
    }};
  } catch (error) {
    try { await admission?.close(); } finally {desktop?.release(); secret.fill(0);}
    throw error;
  }
}

/** Every guarded reopen retains its native entry error even if the app exits
 * before Tweakers' runtime logger can report it. These streams are diagnostics,
 * never readiness or acceptance. The exact promoted path is checked by caller. */
export function prepareIndependentStartupCapture(managerRoot: string): { stdout: string; stderr: string } {
  if (managerRoot !== resolve(managerRoot) || realpathSync(managerRoot) !== managerRoot) throw new Error("Startup diagnostic root is not canonical");
  const request = join(managerRoot, "doctor", "startup-diagnostics", "request.json"), status = lstatSync(request);
  if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o777) !== 0o600 || status.nlink !== 1 || status.size > 1024 || realpathSync(request) !== request) throw new Error("Startup capture request is not private");
  const requested = JSON.parse(readFileSync(request, "utf8"));
  if (!requested || Object.keys(requested).sort().join(",") !== "kind,requestId,target,version" || requested.version !== 1
    || requested.kind !== "tweakers-native-startup-capture-request" || !isManagerOperationId(requested.requestId) || requested.target !== INDEPENDENT_TWEAKERS_APP) throw new Error("Startup capture request changed");
  const directory = join(managerRoot, "doctor", "startup-diagnostics", randomUUID());
  for (let cursor = managerRoot;;) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || realpathSync(cursor) !== cursor) throw new Error("Startup diagnostic ancestry is unsafe");
    if (cursor === directory) break;
    const next = directory.slice(cursor.length + 1).split("/")[0]!;
    cursor = join(cursor, next);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
  }
  const streams = { stdout: join(directory, "stdout.log"), stderr: join(directory, "stderr.log") };
  for (const file of Object.values(streams)) closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600));
  const expectation = join(managerRoot, "variants", "tweakers", "runtime-ready-expectation.json");
  let operationId: string | null = null, promotionId: string | null = null;
  if (existsSync(expectation)) {
    const value = JSON.parse(readFileSync(expectation, "utf8"));
    if (isManagerOperationId(value.operationId)) operationId = value.operationId;
    if (isManagerOperationId(value.promotionId)) promotionId = value.promotionId;
  }
  writeDoctorPrivateJson(join(directory, "capture.json"), { version: 1, kind: "tweakers-native-startup-diagnostics", operationId, promotionId, target: INDEPENDENT_TWEAKERS_APP, createdAt: new Date().toISOString(), ...streams });
  const current = lstatSync(request);
  if (current.dev !== status.dev || current.ino !== status.ino || current.mtimeMs !== status.mtimeMs || current.size !== status.size) throw new Error("Startup capture request changed during preparation");
  // A private request changes only diagnostic routing. It grants no app launch,
  // journal, backend, readiness or acceptance authority and is used once.
  renameSync(request, join(directory, "request-consumed.json"));
  return streams;
}

function createSealedIndependentRefreshLifecycle(): SealedIndependentRefreshLifecycleForTest {
  return {
    reserveCutover: reserveClosedIndependentTweakersCutover,
    observe: observeCodexMainProcess,
    quit: quitCodexMainProcess,
    relatedPids(app: string): number[] {
      return getOpenReport(locateCodexAtExactPath(app)).relatedPids;
    },
    listProcesses,
    signal(pid: number, signal: NodeJS.Signals): void {
      process.kill(pid, signal);
    },
    reopen(app: string): void {
      if (app !== INDEPENDENT_TWEAKERS_APP) throw new Error("Independent reopen target changed");
      const root = canonicalTweakersManagerRoot(), request = join(root, "doctor", "startup-diagnostics", "request.json");
      openAndActivateCodex(app, existsSync(request) ? prepareIndependentStartupCapture(root) : undefined);
    },
    async refresh(
      input: IndependentRefreshInput,
      execution: IndependentRefreshExecutionInput,
      sourceAuthorityRoot: string,
      beforePromotion: () => Promise<void>,
      beforeRollback: () => void,
    ): Promise<DeferredTweakersVariantRefresh> {
      const { prepareDeferredTweakersVariantRefresh } = await import("./commands/create-variant.js");
      return prepareDeferredTweakersVariantRefresh({
        ...input,
        runtimeReadyOperationId: execution.operationId,
      }, {
        // The sealed manager's canonical root owns the immutable registered
        // official source. Do not let create-variant rediscover a legacy root,
        // mode-cache generation, or live app merely because the launcher has
        // an empty environment.
        environmentAuthoritySourceRoot: () => sourceAuthorityRoot,
        registeredOfficialSourceAuthorityRoot: () => sourceAuthorityRoot,
        registeredOfficialSourceBinding: () => ({
          generationId: execution.sourceGenerationId,
          receiptDigest: execution.sourceReceiptDigest,
        }),
        beforePromotion: async ({ target, userRoot }) => {
          if (target !== input.app || userRoot !== input.userRoot) {
            throw new ManagerActionAdapterError(
              "operation_conflict",
              "Independent Tweakers pre-promotion hook was not bound to the exact prepared target and state root.",
            );
          }
          await beforePromotion();
        },
        beforeRollback,
      });
    },
    readRuntimeReady(userRoot: string): unknown | null {
      const path = join(userRoot, "runtime-ready.json");
      if (!existsSync(path)) return null;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("Independent Tweakers runtime-ready receipt is not a private regular file.");
      }
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && stat.uid !== currentUid) {
        throw new Error("Independent Tweakers runtime-ready receipt is not owned by the current user.");
      }
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    },
    runtimeReadyTimeoutMs(accountsBrokerRoot: string): number {
      if (accountsBrokerRoot !== defaultTweakersAccountsBrokerRoot()) throw new Error("Independent startup broker root changed");
      const assets = resolveSealedManagerRuntimeAssets();
      if (assets === null) throw new Error("Sealed startup preparation runtime is unavailable");
      verifySealedManagerRuntimeAssets(assets);
      const load = createRequire(import.meta.url);
      const sockets = load(join(assets.root, "account-router", "broker-socket.js")) as {
        readAccountsBrokerSecret(root: string): Buffer | null;
      };
      const mode = load(join(assets.root, "account-router", "shared-native-mode.js")) as {
        sharedNativePluginPreparationTimeoutV1(root: string, secret: Buffer, fallbackMs: number): number;
      };
      const secret = sockets.readAccountsBrokerSecret(accountsBrokerRoot);
      if (!secret) return INDEPENDENT_RUNTIME_READY_TIMEOUT_MS;
      try {
        return INDEPENDENT_RUNTIME_READY_TIMEOUT_MS + mode.sharedNativePluginPreparationTimeoutV1(accountsBrokerRoot, secret, 0);
      } finally { secret.fill(0); }
    },
    now: () => Date.now(),
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    async sealedAccountsRuntimeRoot(managerRoot: string): Promise<string> {
      const { verifyDoctorCandidate } = await import("./doctor-approval.js");
      const { job } = verifyDoctorCandidate(managerRoot);
      return join(job.candidatePackage!, "runtime");
    },
    verifyAccountsTransferRecovery(runtimeRoot: string): boolean {
      const assets = resolveSealedManagerManagedRuntimeAssets();
      if (assets === null) return false;
      verifySealedManagerManagedRuntimeAssets(assets);
      const loaded = createRequire(import.meta.url)(join(
        assets.root,
        "packages", "installer", "assets", "runtime", "account-router", "transfer-recovery.js",
      )) as { verifyAccountsTransferRecovery?: unknown };
      return typeof loaded.verifyAccountsTransferRecovery === "function"
        && (loaded.verifyAccountsTransferRecovery as (root: string) => boolean)(runtimeRoot);
    },
    prepareAccountContinuity: prepareManagedAccountContinuityPrelaunch,
  };
}

function createSealedIndependentRefreshExecutor(
  userRoot: () => string,
  lifecycle: SealedIndependentRefreshLifecycleForTest = createSealedIndependentRefreshLifecycle(),
): (execution: IndependentRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<void> {
  return async (execution: IndependentRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => {
    const managerUserRoot = userRoot();
    // Omit source so create-variant resolves and leases only the manager's
    // registered immutable official-source generation. The manager remains
    // bound to its canonical root through the variant-specific state root
    // below; it may not fall back to an inactive mode-cache role or live app.
    const refreshInput: IndependentRefreshInput = {
      app: INDEPENDENT_TWEAKERS_APP,
      userRoot: join(managerUserRoot, "variants", "tweakers"),
    };
    const cutover = {
      quiesced: null as CodexMainProcessObservation | null,
      quiescenceProven: false,
      continuityAttemptFailed: false,
    };
    const sealedAccountsRuntimeRoot = await lifecycle.sealedAccountsRuntimeRoot(managerUserRoot);
    if (!lifecycle.verifyAccountsTransferRecovery(sealedAccountsRuntimeRoot)) {
      throw new ManagerActionAdapterError(
        "stale_state",
        "Independent Tweakers refresh requires a source-bound validated Accounts recovery receipt in the sealed runtime. Rebuild candidate compatibility evidence.",
      );
    }
    let cutoverLease: {release(): Promise<void>} | null = null;
    const releaseCutover = async (): Promise<void> => {
      const releasing = cutoverLease; cutoverLease = null;
      await releasing?.release();
    };
    const beforePromotion = async (): Promise<void> => {
      // This hook runs after sealed candidate staging and immediately before
      // the exact process gate and atomic promotion. It is the narrowest
      // independent-refresh cutover boundary the manager can observe.
      await timing?.start("quiesce-promote");
      cutoverLease = await lifecycle.reserveCutover?.() ?? null;
      const observed = lifecycle.observe(INDEPENDENT_TWEAKERS_APP);
      if (cutoverLease && (observed !== null || lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length > 0)) {
        throw new ManagerActionAdapterError("operation_conflict", "Tweakers appeared during closed-app cutover; no process was interrupted.");
      }
      // Record the pre-cutover identity before any lifecycle action. If
      // quiescence fails after the main process exits, the failure path still
      // knows which previously running app must be restored.
      cutover.quiesced = observed;
      if (!cutoverLease) await quiesceIndependentTweakers(lifecycle, observed);
      cutover.quiescenceProven = true;
      try {
        lifecycle.prepareAccountContinuity(join(
          managerUserRoot,
          "tweak-data",
          "co.tweakers.account-switcher",
        ));
      } catch (error) {
        // A thrown helper may follow capture or rebase writes. The surrounding
        // variant rollback proves only app assets, so retain the closed app
        // until continuity recovery itself is verified.
        cutover.continuityAttemptFailed = true;
        throw error;
      }
      // A returned defer proves that migration never began. Preserve the
      // existing settings and continue this authorized app refresh, just as
      // ordinary prelaunch does; a later idle launch retries the migration.
    };
    let deferred: DeferredTweakersVariantRefresh | null = null;
    const beforeRollback = (): void => {
      if (lifecycle.reserveCutover && cutoverLease === null) {
        throw new Error("Independent Tweakers rollback requires held closed desktop and broker admission.");
      }
      if (lifecycle.observe(INDEPENDENT_TWEAKERS_APP) !== null
        || lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length > 0) {
        throw new Error("Independent Tweakers rollback cannot compensate while the desktop or its helpers are running.");
      }
    };
    try {
      // create-variant deliberately owns source validation, clone, signing,
      // verification under one sealed
      // transaction. It does not publish individual timing boundaries, so do
      // not pretend that the manager can split that composite work further.
      await timing?.unavailable(
        ["source-validation", "apfs-clone", "sign", "verify"],
        "The sealed candidate builder exposes this only inside patch stage.",
      );
      await timing?.start("patch-stage");
      deferred = await lifecycle.refresh(refreshInput, execution, managerUserRoot, beforePromotion, beforeRollback);
      if (!lifecycle.verifyAccountsTransferRecovery(join(refreshInput.userRoot, "runtime"))) {
        throw new ManagerActionAdapterError(
          "internal_error",
          "Independent Tweakers candidate did not preserve its validated Accounts recovery binding.",
        );
      }
      await timing?.complete("patch-stage");
      await timing?.complete("quiesce-promote");
      await timing?.start("runtime-ready-wait");
      await releaseCutover();
      await reopenAndProveIndependentTweakers(lifecycle, cutover.quiesced, deferred);
      await timing?.complete("runtime-ready-wait");
      deferred.commit();
    } catch (error) {
      if (deferred?.recoveryMode === "forward-only" || error instanceof ForwardBackendTransitionRecoveryRequired) {
        // The registered resolver has crossed its CAS boundary. Retain the
        // exact app/runtime journal and leave live processes untouched; only
        // the bound forward-recovery path can complete this generation.
        deferred?.retain();
        throw error;
      }
      const rollbackErrors: unknown[] = [];
      if (deferred !== null) {
        try {
          // A broken newly-reopened process must not keep the target path busy
          // while its uncommitted generation is restored.
          const current = lifecycle.observe(INDEPENDENT_TWEAKERS_APP);
          if (lifecycle.reserveCutover && (current !== null || lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length > 0)) {
            throw new Error("Tweakers is running after failed acceptance; transaction and fallback retained without interrupting possibly active work.");
          }
          if (lifecycle.reserveCutover) {
            // A failed launch may leave its broker alive after the main exits.
            // Reacquire both admission boundaries before any compensation.
            cutoverLease ??= await lifecycle.reserveCutover();
            beforeRollback();
          } else await quiesceIndependentTweakers(lifecycle, current);
        } catch (rollbackError) {
          deferred.retain();
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length === 0) {
          try { deferred.rollback(); } catch (rollbackError) { deferred.retain(); rollbackErrors.push(rollbackError); }
        }
      }
      // refreshTweakersVariant rethrows the original ordinary failure after a
      // complete rollback. AggregateError means rollback itself was incomplete
      // and must stay closed for manual recovery.
      // A deferred transaction has just restored the prior on-disk generation.
      // Leave it closed rather than launching an app whose old generation was
      // not part of this operation's runtime-ready proof. The non-deferred
      // legacy error path retains its established best-effort reopen behavior.
      if (deferred === null && cutover.quiescenceProven && !cutover.continuityAttemptFailed
        && cutover.quiesced !== null
        && rollbackErrors.length === 0 && hasVerifiablyCompleteVariantRollback(error)) {
        const current = lifecycle.observe(INDEPENDENT_TWEAKERS_APP);
        const sameProcessStillRunning = current !== null
          && current.pid === cutover.quiesced.pid
          && current.startedAtRaw === cutover.quiesced.startedAtRaw;
        if (!sameProcessStillRunning) {
          try {
            if (current !== null) {
              throw new ManagerActionAdapterError(
                "operation_conflict",
                "An unexpected Tweakers process appeared while restoring a failed pre-promotion cutover.",
              );
            }
            await reopenAndObserveIndependentTweakers(lifecycle, cutover.quiesced);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Independent Tweakers refresh failed and the rollback/reopen path was incomplete.",
        );
      }
      throw error;
    } finally {
      await releaseCutover();
    }
  };
}

interface IndependentBackendRecoveryPort {
  readEvidence: typeof readManagerAcceptedBackendRecoveryEvidence;
  resume(input: { userRoot: string; target: string; promotionId: string; operationId: string; expectedJournalSha256: string },
    managerRoot: string, assertClosedAdmission: () => void): Promise<DeferredTweakersVariantRefresh>;
  settle(managerRoot: string, operationId: string): boolean;
}

/** Continue the original consumed operation; callers supply no roots or new authority. */
export async function resumeSealedIndependentBackendTransition(operationId: string): Promise<void> {
  const root = resolveSealedTweakersManagerUserRoot();
  const lifecycle = createSealedIndependentRefreshLifecycle();
  const executor = createSealedIndependentBackendRecoveryExecutor(() => root, lifecycle, {
    readEvidence: readManagerAcceptedBackendRecoveryEvidence,
    async resume(input, managerRoot, beforeRollback) {
      const { resumeDeferredAcceptedBackendTransition } = await import("./commands/create-variant.js");
      return resumeDeferredAcceptedBackendTransition(input, { managerRoot: () => managerRoot, beforeRollback });
    },
    settle: settleManagerAcceptedBackendRecovery,
  });
  await withLocalOperation(`manager-forward-recovery:${operationId}`, () => withLifecycleLock(lifecycleLockFile(root),
    `accepted backend recovery ${operationId}`, () => executor(operationId)));
}

/** One fixed child repairs the original operation; no new action/CAS/root is supplied. */
export async function resumeSealedAcceptedRuntimeRepair(operationId:string):Promise<void> {
  const root=resolveSealedTweakersManagerUserRoot(),lifecycle=createSealedIndependentRefreshLifecycle();
  const repair=await import("./accepted-runtime-repair.js");
  await withLocalOperation(`manager-runtime-repair:${operationId}`,()=>withLifecycleLock(lifecycleLockFile(root),`accepted runtime repair ${operationId}`,async()=>{
    await createSealedAcceptedRuntimeRepairExecutor(lifecycle,repair)(operationId);
  }));
}

type AcceptedRuntimeRepairExecutionPort=Pick<typeof import("./accepted-runtime-repair.js"),"readAcceptedRuntimeRepairRecord"|"readAuthenticatedAcceptedRuntimeRepair"|
  "settleAcceptedRuntimeRepair"|"finishAcceptedRuntimeRepairFromRetainedAcceptance"|"resumeAcceptedRuntimeRepair">;
function createSealedAcceptedRuntimeRepairExecutor(lifecycle:SealedIndependentRefreshLifecycleForTest,repair:AcceptedRuntimeRepairExecutionPort):(operationId:string)=>Promise<void> {
  return async(operationId)=>{
    if(!isManagerOperationId(operationId)||!lifecycle.reserveCutover)throw new Error("Runtime repair requires exact operation and closed admission");
    let admission:{release():Promise<void>}|null=null,deferred:DeferredTweakersVariantRefresh|null=null;
    const assertClosed=()=>{
      if(!admission||lifecycle.observe(INDEPENDENT_TWEAKERS_APP)!==null||lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length!==0)
        throw new Error("Accepted runtime repair lost held closed desktop and broker admission");
    };
    const release=async()=>{const held=admission;admission=null;await held?.release();};
    const assertAcceptedProcess=(pid:number,token:string)=>{
      const observed=lifecycle.observe(INDEPENDENT_TWEAKERS_APP);
      if(!observed||observed.pid!==pid||observed.startedAtRaw!==token)throw new Error("Accepted runtime repair canary process identity changed");
    };
    try {
      admission=await lifecycle.reserveCutover();assertClosed();
      const record=repair.readAcceptedRuntimeRepairRecord(operationId);
      if(record?.publication.phase==="committed") {
        repair.readAuthenticatedAcceptedRuntimeRepair(operationId);
        if(!repair.settleAcceptedRuntimeRepair(operationId))throw new Error("Committed runtime repair lacks authenticated original settlement");
        return;
      }
      if(record&&(["acceptance:verified","active:archive-planned","active:archived","active:promote-planned","active:promoted"].includes(record.publication.phase)
        ||record.publication.phase==="challenge:published"&&existsSync(join(record.root,"acceptance.json")))) {
        repair.finishAcceptedRuntimeRepairFromRetainedAcceptance(operationId,assertClosed);
        if(!repair.settleAcceptedRuntimeRepair(operationId))throw new Error("Retained genuine canary did not settle the original repair");
        return;
      }
      deferred=repair.resumeAcceptedRuntimeRepair(operationId,{assertClosedAdmission:assertClosed,assertAcceptedProcess});
      if(deferred.recoveryMode!=="forward-only"||deferred.runtimeReadyExpectation.operationId!==operationId)throw new Error("Runtime repair returned foreign authority");
      await release();
      await reopenAndProveIndependentTweakers(lifecycle,null,deferred);
      deferred.commit();deferred=null;
      if(!repair.settleAcceptedRuntimeRepair(operationId))throw new Error("Runtime repair acceptance did not settle its original operation");
    }catch(error){deferred?.retain();throw error;}finally{await release();}
  };
}

/** Explicit fixture ports; the sealed production entry always uses real APIs. */
export function createSealedAcceptedRuntimeRepairExecutorForTest(lifecycle:SealedIndependentRefreshLifecycleForTest,repair:AcceptedRuntimeRepairExecutionPort):(operationId:string)=>Promise<void> {
  return createSealedAcceptedRuntimeRepairExecutor(lifecycle,repair);
}

type AcceptedRuntimeRepairApprovalPort=Pick<typeof import("./accepted-runtime-repair.js"),"acceptedRuntimeRepairApprovalRequiresClosedAdmission"|"approveAcceptedRuntimeRepair">;
function createSealedAcceptedRuntimeRepairApprovalExecutor(lifecycle:SealedIndependentRefreshLifecycleForTest,repair:AcceptedRuntimeRepairApprovalPort) {
  return async(jobId:string,reportFingerprint:string)=>{
    if(!repair.acceptedRuntimeRepairApprovalRequiresClosedAdmission(jobId,reportFingerprint))return repair.approveAcceptedRuntimeRepair(jobId,reportFingerprint);
    if(!lifecycle.reserveCutover)throw new Error("Successor approval requires closed desktop and broker admission");
    let admission:Awaited<ReturnType<NonNullable<SealedIndependentRefreshLifecycleForTest["reserveCutover"]>>>|null=null;
    const assertClosed=()=>{
      if(!admission||lifecycle.observe(INDEPENDENT_TWEAKERS_APP)!==null||lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length!==0)
        throw new Error("Successor approval lost held closed admission");
    };
    try{admission=await lifecycle.reserveCutover();assertClosed();return repair.approveAcceptedRuntimeRepair(jobId,reportFingerprint,assertClosed);}
    finally{const lease=admission;admission=null;await lease?.release();}
  };
}
/** Explicit fixture ports; production calls the same executor with real APIs. */
export function createSealedAcceptedRuntimeRepairApprovalExecutorForTest(lifecycle:SealedIndependentRefreshLifecycleForTest,repair:AcceptedRuntimeRepairApprovalPort) {
  return createSealedAcceptedRuntimeRepairApprovalExecutor(lifecycle,repair);
}

export async function runSealedAcceptedRuntimeRepairDoctorAction(value:unknown):Promise<unknown> {
  const repair=await import("./accepted-runtime-repair.js"),request=repair.parseAcceptedRuntimeRepairAction(value);
  if(request.action==="recover") {
    await resumeSealedAcceptedRuntimeRepair(request.operationId);
    return{operationId:request.operationId,outcome:"verified-installation-accepted"};
  }
  const root=resolveSealedTweakersManagerUserRoot();
  return withLocalOperation(`manager-runtime-repair-doctor:${request.action}`,()=>withLifecycleLock(lifecycleLockFile(root),`runtime repair Doctor ${request.action}`,async()=>{
    if(request.action==="prepare-native-replacement") {
      const lifecycle=createSealedIndependentRefreshLifecycle();
      return createSealedNativeReplacementExecutor(lifecycle,repair)(request.operationId);
    }
    if(request.action==="scan-successor") {
      const lifecycle=createSealedIndependentRefreshLifecycle();
      if(!lifecycle.reserveCutover)throw new Error("Successor review requires closed desktop and broker admission");
      const admission=await lifecycle.reserveCutover();
      const assertClosed=()=>{if(lifecycle.observe(INDEPENDENT_TWEAKERS_APP)!==null||lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length!==0)
        throw new Error("Successor review lost held closed admission");};
      try{assertClosed();return{report:await repair.scanAcceptedRuntimeRepairSuccessor(request.operationId,assertClosed)};}
      finally{await admission.release();}
    }
    if(request.action==="scan")return{report:await repair.scanAcceptedRuntimeRepair(request.operationId)};
    return{approval:await createSealedAcceptedRuntimeRepairApprovalExecutor(createSealedIndependentRefreshLifecycle(),repair)(request.jobId,request.reportFingerprint)};
  }));
}

function createSealedNativeReplacementExecutor(lifecycle:SealedIndependentRefreshLifecycleForTest,
  repair:Pick<typeof import("./accepted-runtime-repair.js"),"prepareAcceptedRuntimeNativeReplacement">) {
  return async(operationId:string)=>{
    if(!lifecycle.reserveCutover)throw new Error("Native replacement requires closed desktop and broker admission");
    let admission:Awaited<ReturnType<NonNullable<SealedIndependentRefreshLifecycleForTest["reserveCutover"]>>>|null=null;
    const assertClosed=()=>{
      if(!admission||lifecycle.observe(INDEPENDENT_TWEAKERS_APP)!==null||lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length!==0)
        throw new Error("Native replacement lost held closed admission");
    };
    try{admission=await lifecycle.reserveCutover();assertClosed();return await repair.prepareAcceptedRuntimeNativeReplacement(operationId,assertClosed);}
    finally{const lease=admission;admission=null;await lease?.release();}
  };
}
export function createSealedNativeReplacementExecutorForTest(lifecycle:SealedIndependentRefreshLifecycleForTest,
  repair:Pick<typeof import("./accepted-runtime-repair.js"),"prepareAcceptedRuntimeNativeReplacement">) {
  return createSealedNativeReplacementExecutor(lifecycle,repair);
}

function createSealedIndependentBackendRecoveryExecutor(userRoot: () => string, lifecycle: SealedIndependentRefreshLifecycleForTest,
  port: IndependentBackendRecoveryPort): (operationId: string) => Promise<void> {
  return async operationId => {
    const managerRoot = userRoot();
    const evidence = port.readEvidence(managerRoot, operationId);
    if (evidence.committed) {
      if (!port.settle(managerRoot, operationId)) throw new Error("Committed backend recovery lacks its exact installed acceptance");
      return;
    }
    if (!lifecycle.reserveCutover) throw new Error("Backend recovery requires closed desktop and broker admission");
    let admission: {release(): Promise<void>} | null = null;
    let deferred: DeferredTweakersVariantRefresh | null = null;
    const assertClosedAdmission = () => {
      if (!admission || lifecycle.observe(INDEPENDENT_TWEAKERS_APP) !== null || lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).length > 0) {
        throw new Error("Backend recovery lost closed desktop and broker admission");
      }
    };
    const release = async () => { const lease = admission; admission = null; await lease?.release(); };
    try {
      admission = await lifecycle.reserveCutover();
      assertClosedAdmission();
      // Re-read under admission. A changed operation or journal is never
      // substituted for the original recovery request.
      const held = port.readEvidence(managerRoot, operationId);
      if (canonicalManagerJson(held) !== canonicalManagerJson(evidence)) throw new Error("Backend recovery evidence changed before replay");
      const { binding } = evidence;
      deferred = await port.resume({ userRoot: binding.userRoot, target: binding.target, promotionId: binding.promotionId,
        operationId, expectedJournalSha256: evidence.journalSha256 }, managerRoot, assertClosedAdmission);
      if (deferred.recoveryMode !== "forward-only" || deferred.target !== binding.target || deferred.userRoot !== binding.userRoot
        || deferred.runtimeReadyExpectation.operationId !== operationId) throw new Error("Backend recovery returned a different authority");
      if (!lifecycle.verifyAccountsTransferRecovery(join(binding.userRoot, "runtime"))) throw new Error("Backend recovery Accounts binding is not verified");
      await release();
      await reopenAndProveIndependentTweakers(lifecycle, null, deferred);
      deferred.commit();
      deferred = null;
      if (!port.settle(managerRoot, operationId)) throw new Error("Backend recovery commit lacks exact installation evidence");
    } catch (error) {
      deferred?.retain();
      throw error;
    } finally { await release(); }
  };
}

export function createSealedIndependentBackendRecoveryExecutorForTest(userRoot: () => string,
  lifecycle: SealedIndependentRefreshLifecycleForTest, port: IndependentBackendRecoveryPort): (operationId: string) => Promise<void> {
  return createSealedIndependentBackendRecoveryExecutor(userRoot, lifecycle, port);
}

async function quiesceIndependentTweakers(
  lifecycle: SealedIndependentRefreshLifecycleForTest,
  observed: CodexMainProcessObservation | null,
): Promise<void> {
  const mainPid = observed?.pid ?? null;
  const helperPids = new Set(
    lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP).filter((pid) => pid !== mainPid),
  );
  const capturedHelpers = lifecycle.listProcesses().filter((entry) => helperPids.has(entry.pid));

  if (observed !== null) {
    lifecycle.quit(INDEPENDENT_TWEAKERS_APP, observed.pid);
    if (lifecycle.observe(INDEPENDENT_TWEAKERS_APP) !== null) {
      throw new ManagerActionAdapterError(
        "operation_conflict",
        "The exact /Applications/Tweakers.app process did not quiesce before refresh.",
      );
    }
  }

  // A helper normally changes PPID to 1 when the main app exits. PPID is
  // therefore lifecycle state, not process identity. Keep the immutable
  // start token and exact command in the seal so PID reuse still fails closed
  // while an expected reparent remains the same captured helper.
  const processIdentity = (entry: ProcessInfo): string => (
    `${entry.pid}\0${entry.startedAtRaw ?? ""}\0${entry.command}`
  );
  const remainingCapturedHelpers = (): ProcessInfo[] => {
    const current = new Set(lifecycle.listProcesses().map(processIdentity));
    return capturedHelpers.filter((entry) => current.has(processIdentity(entry)));
  };
  const signalRemaining = (entries: readonly ProcessInfo[], signal: NodeJS.Signals): void => {
    for (const entry of entries) {
      try { lifecycle.signal(entry.pid, signal); } catch { /* exact helper already exited */ }
    }
  };
  const waitForExit = async (timeoutMs: number): Promise<ProcessInfo[]> => {
    const deadline = lifecycle.now() + timeoutMs;
    let remaining = remainingCapturedHelpers();
    while (remaining.length > 0 && lifecycle.now() < deadline) {
      await lifecycle.sleep(100);
      remaining = remainingCapturedHelpers();
    }
    return remaining;
  };

  signalRemaining(remainingCapturedHelpers(), "SIGTERM");
  let remaining = await waitForExit(2_000);
  signalRemaining(remaining, "SIGKILL");
  remaining = await waitForExit(1_000);
  if (remaining.length > 0) {
    throw new ManagerActionAdapterError(
      "operation_conflict",
      `Exact captured Tweakers helpers did not stop: ${remaining.map((entry) => entry.pid).join(", ")}`,
    );
  }
  const unexpected = lifecycle.relatedPids(INDEPENDENT_TWEAKERS_APP);
  if (unexpected.length > 0) {
    throw new ManagerActionAdapterError(
      "operation_conflict",
      `Exact Tweakers helper quiescence is not proven: ${unexpected.join(", ")}`,
    );
  }
}

async function reopenAndProveIndependentTweakers(
  lifecycle: SealedIndependentRefreshLifecycleForTest,
  previous: CodexMainProcessObservation | null,
  deferred: DeferredTweakersVariantRefresh,
): Promise<void> {
  const runtimeReadyTimeoutMs = lifecycle.runtimeReadyTimeoutMs?.(deferred.runtimeReadyExpectation.accountsBrokerRoot)
    ?? INDEPENDENT_RUNTIME_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(runtimeReadyTimeoutMs) || runtimeReadyTimeoutMs < INDEPENDENT_RUNTIME_READY_TIMEOUT_MS
    || runtimeReadyTimeoutMs > INDEPENDENT_RUNTIME_READY_TIMEOUT_MS + 600_000) {
    throw new ManagerActionAdapterError("operation_conflict", "Independent runtime preparation deadline is invalid");
  }
  lifecycle.reopen(INDEPENDENT_TWEAKERS_APP);
  const processDeadline = lifecycle.now() + INDEPENDENT_REOPEN_PROCESS_TIMEOUT_MS;
  let runtimeReadyDeadline: number | null = null;
  while (true) {
    const observed = lifecycle.observe(INDEPENDENT_TWEAKERS_APP);
    const processStartToken = observed?.startedAtRaw;
    const newProcessIdentity = observed !== null
      && (previous === null || observed.pid !== previous.pid || processStartToken !== previous.startedAtRaw);
    if (observed !== null && newProcessIdentity
      && typeof processStartToken === "string" && processStartToken.length > 0) {
      // System Events' `visible`/`frontmost` process projection can lag behind
      // WindowServer or remain false while the exact app is already frontmost
      // with ordered windows. Bind the readiness interval to the exact new
      // PID/start token instead. The receipt is the stronger renderer proof:
      // it can be published only after the owned preload initialized every
      // enabled renderer tweak and observed the Settings surface mounted.
      runtimeReadyDeadline ??= lifecycle.now() + runtimeReadyTimeoutMs;
      const receipt = lifecycle.readRuntimeReady(deferred.userRoot);
      if (receipt !== null) {
        deferred.verifyRuntimeReady(receipt, observed.pid, processStartToken);
        return;
      }
    }
    const now = lifecycle.now();
    if (runtimeReadyDeadline !== null) {
      if (now >= runtimeReadyDeadline) {
        throw new ManagerActionAdapterError(
          "operation_conflict",
          "The exact /Applications/Tweakers.app reopen produced a new visible main PID, but did not publish an operation-bound runtime-ready receipt before the readiness deadline.",
        );
      }
    } else if (now >= processDeadline) {
      throw new ManagerActionAdapterError(
        "operation_conflict",
        "The exact /Applications/Tweakers.app reopen did not produce a new main PID before the process deadline.",
      );
    }
    await lifecycle.sleep(INDEPENDENT_REOPEN_PROOF_POLL_MS);
  }
}

async function reopenAndObserveIndependentTweakers(
  lifecycle: SealedIndependentRefreshLifecycleForTest,
  previous: CodexMainProcessObservation,
): Promise<void> {
  lifecycle.reopen(INDEPENDENT_TWEAKERS_APP);
  const deadline = lifecycle.now() + INDEPENDENT_REOPEN_PROCESS_TIMEOUT_MS;
  while (true) {
    const observed = lifecycle.observe(INDEPENDENT_TWEAKERS_APP);
    if (observed !== null
      && (observed.pid !== previous.pid || observed.startedAtRaw !== previous.startedAtRaw)
      && typeof observed.startedAtRaw === "string"
      && observed.startedAtRaw.length > 0
      && observed.visibleWindow) return;
    if (lifecycle.now() >= deadline) break;
    await lifecycle.sleep(INDEPENDENT_REOPEN_PROOF_POLL_MS);
  }
  throw new ManagerActionAdapterError(
    "operation_conflict",
    "The restored /Applications/Tweakers.app did not reopen with a new visible main PID.",
  );
}

/** Test-only access to the fixed lifecycle helper. It does not alter the
 * sealed factory's dependency contract or add a manager-protocol action. */
export function createSealedIndependentRefreshExecutorForTest(
  userRoot: () => string,
  lifecycle: SealedIndependentRefreshLifecycleForTest,
): (execution: IndependentRefreshExecutionInput, timing?: ManagerRefreshTimingProgress) => Promise<void> {
  return createSealedIndependentRefreshExecutor(userRoot, lifecycle);
}

function hasVerifiablyCompleteVariantRollback(error: unknown): boolean {
  return error instanceof Error && !(error instanceof AggregateError);
}

function isRefreshAction(actionId: TweakersManagerActionIdV1): actionId is "refresh.injected" | "refresh.independent" {
  return actionId === "refresh.injected" || actionId === "refresh.independent";
}

function createRefreshTimingEvidence(): ManagerRefreshTimingEvidenceV1 {
  const phases = {} as Record<ManagerRefreshTimingPhaseV1, ManagerRefreshTimingPhaseEvidenceV1>;
  for (const phase of MANAGER_REFRESH_TIMING_PHASES_V1) {
    phases[phase] = {
      state: "pending",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      reason: null,
    };
  }
  return { schemaVersion: 1, phases };
}

class ManagerRefreshTimingReporter implements ManagerRefreshTimingProgress {
  private timing: ManagerRefreshTimingEvidenceV1;
  private readonly starts = new Map<ManagerRefreshTimingPhaseV1, number>();

  constructor(
    initial: ManagerRefreshTimingEvidenceV1,
    private readonly now: () => string,
    private readonly monotonicMs: () => number,
    private readonly persist: (timing: ManagerRefreshTimingEvidenceV1) => Promise<void>,
  ) {
    this.timing = cloneRefreshTiming(initial);
  }

  async start(phase: ManagerRefreshTimingPhaseV1): Promise<void> {
    const current = this.timing.phases[phase];
    if (current.state !== "pending") return;
    const startedAt = this.now();
    this.starts.set(phase, this.monotonicMs());
    await this.replacePhase(phase, {
      state: "running",
      startedAt,
      completedAt: null,
      durationMs: null,
      reason: null,
    });
  }

  async complete(phase: ManagerRefreshTimingPhaseV1): Promise<void> {
    const current = this.timing.phases[phase];
    if (current.state !== "running" || current.startedAt === null) return;
    const started = this.starts.get(phase);
    if (started === undefined) {
      throw new ManagerActionAdapterError("internal_error", `Refresh timing lost its monotonic start for ${phase}`);
    }
    await this.replacePhase(phase, {
      state: "completed",
      startedAt: current.startedAt,
      completedAt: this.now(),
      durationMs: elapsedMs(started, this.monotonicMs()),
      reason: null,
    });
  }

  async unavailable(phases: readonly ManagerRefreshTimingPhaseV1[], reason: string): Promise<void> {
    let next = this.timing;
    for (const phase of phases) {
      if (next.phases[phase].state !== "pending") continue;
      next = replaceRefreshTimingPhase(next, phase, {
        state: "unavailable",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        reason,
      });
    }
    if (next === this.timing) return;
    this.timing = next;
    await this.persist(this.timing);
  }

  async finish(outcome: "completed" | "recovery-required"): Promise<void> {
    let next = this.timing;
    for (const phase of MANAGER_REFRESH_TIMING_PHASES_V1) {
      const current = next.phases[phase];
      if (current.state === "pending") {
        next = replaceRefreshTimingPhase(next, phase, {
          state: outcome === "completed" ? "unavailable" : "skipped",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          reason: outcome === "completed"
            ? "The executor did not expose this phase."
            : "The operation ended before this phase was reached.",
        });
      } else if (current.state === "running") {
        const started = this.starts.get(phase);
        if (started === undefined || current.startedAt === null) {
          throw new ManagerActionAdapterError("internal_error", `Refresh timing lost its monotonic start for ${phase}`);
        }
        next = replaceRefreshTimingPhase(next, phase, {
          state: "failed",
          startedAt: current.startedAt,
          completedAt: this.now(),
          durationMs: elapsedMs(started, this.monotonicMs()),
          reason: null,
        });
      }
    }
    if (next === this.timing) return;
    this.timing = next;
    await this.persist(this.timing);
  }

  private async replacePhase(
    phase: ManagerRefreshTimingPhaseV1,
    value: ManagerRefreshTimingPhaseEvidenceV1,
  ): Promise<void> {
    this.timing = replaceRefreshTimingPhase(this.timing, phase, value);
    await this.persist(this.timing);
  }
}

function cloneRefreshTiming(value: ManagerRefreshTimingEvidenceV1): ManagerRefreshTimingEvidenceV1 {
  const phases = {} as Record<ManagerRefreshTimingPhaseV1, ManagerRefreshTimingPhaseEvidenceV1>;
  for (const phase of MANAGER_REFRESH_TIMING_PHASES_V1) phases[phase] = { ...value.phases[phase] };
  return { schemaVersion: 1, phases };
}

function replaceRefreshTimingPhase(
  timing: ManagerRefreshTimingEvidenceV1,
  phase: ManagerRefreshTimingPhaseV1,
  value: ManagerRefreshTimingPhaseEvidenceV1,
): ManagerRefreshTimingEvidenceV1 {
  return {
    schemaVersion: 1,
    phases: {
      ...timing.phases,
      [phase]: value,
    },
  };
}

function elapsedMs(started: number, completed: number): number {
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    throw new ManagerActionAdapterError("internal_error", "Refresh timing clock returned a non-finite value");
  }
  return Math.max(0, Math.round(completed - started));
}

const ACTION_SPECS: Readonly<Partial<Record<TweakersManagerActionIdV1, { impact: ManagerImpactV1 }>>> = {
  "environment.cancel": { impact: "restart-app" },
  "environment.recover": { impact: "restart-app" },
  "refresh.injected": { impact: "repair-app" },
  "refresh.independent": { impact: "repair-app" },
  "official-source.register": { impact: "repair-app" },
};

function requireActionSpec(actionId: TweakersManagerActionIdV1): { impact: ManagerImpactV1 } {
  const spec = (ACTION_SPECS as Partial<Record<TweakersManagerActionIdV1, { impact: ManagerImpactV1 }>>)[actionId];
  if (!spec) throw new ManagerActionAdapterError("unsupported_action", `Action ${actionId} is not migrated to the fixed adapter`);
  return spec;
}

function receiptTarget(
  snapshot: ReturnType<typeof createTweakersManagerStatusSnapshot>,
  actionId: TweakersManagerActionIdV1,
  managerRuntimeFingerprint: string | null,
): string | null {
  if (actionId === "refresh.injected") {
    const source = snapshot.status.environment.registeredStableSource;
    const selectionRevision = snapshot.status.environment.selection.revision;
    const registryRevision = snapshot.status.environment.registry.revision;
    if (source.generationId === null
      || source.receiptDigest === null
      || source.sourceDigest === null
      || !isLowerUuid(source.generationId)
      || !isLowerSha256(source.receiptDigest)
      || !isLowerSha256(source.sourceDigest)
      || !isSha256Revision(source.revision)
      || managerRuntimeFingerprint === null
      || !isLowerSha256(managerRuntimeFingerprint)
      || !isSha256Revision(selectionRevision)
      || !isSha256Revision(registryRevision)) return null;
    return serializeInjectedRefreshBinding({
      sourceGenerationId: source.generationId,
      sourceReceiptDigest: source.receiptDigest,
      sourceDigest: source.sourceDigest,
      sourceRevision: source.revision,
      managerRuntimeFingerprint,
      selectionRevision,
      registryRevision,
    });
  }
  if (actionId === "official-source.register") {
    const digest = snapshot.status.environment.registeredStableSource.candidateDigest;
    return digest === null ? null : `official-source-candidate:${digest}`;
  }
  if (actionId === "refresh.independent") {
    const source = snapshot.status.environment.registeredStableSource;
    if (source.generationId === null || source.receiptDigest === null) return null;
    return `independent-tweakers-patch:${snapshot.status.tweakersPatch.installedVersion ?? "missing"}:${source.generationId}:${source.receiptDigest}`;
  }
  const source = actionId.startsWith("environment.") ? "environment" : null;
  if (source === null) return null;
  const receipt = snapshot.status.receipts.find((candidate) => candidate.source === source);
  return receipt?.state === "valid" && receipt.receiptId !== null ? `${source}:${receipt.receiptId}` : null;
}

function receiptReferencesForPreparedAction(
  actionId: TweakersManagerActionIdV1,
  target: string,
  operationId: string,
): readonly string[] {
  return actionId === "refresh.injected"
    ? [target, `environment:${operationId}`]
    : [target];
}

interface InjectedRefreshBinding {
  sourceGenerationId: string;
  sourceReceiptDigest: string;
  sourceDigest: string;
  sourceRevision: string;
  managerRuntimeFingerprint: string;
  selectionRevision: string;
  registryRevision: string;
}

function serializeInjectedRefreshBinding(binding: InjectedRefreshBinding): string {
  return [
    "injected-chatgpt-patch",
    "v1",
    binding.sourceGenerationId,
    binding.sourceReceiptDigest,
    binding.sourceDigest,
    binding.sourceRevision,
    binding.managerRuntimeFingerprint,
    binding.selectionRevision,
    binding.registryRevision,
  ].join(":");
}

export function parseInjectedRefreshBinding(value: string): InjectedRefreshBinding {
  const match = /^injected-chatgpt-patch:v1:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([a-f0-9]{64}):([a-f0-9]{64}):(sha256:[a-f0-9]{64}):([a-f0-9]{64}):(sha256:[a-f0-9]{64}):(sha256:[a-f0-9]{64})$/.exec(value);
  if (match === null) {
    throw new ManagerActionAdapterError("internal_error", "Prepared injected refresh has no exact versioned source/runtime/environment binding");
  }
  return {
    sourceGenerationId: match[1]!,
    sourceReceiptDigest: match[2]!,
    sourceDigest: match[3]!,
    sourceRevision: match[4]!,
    managerRuntimeFingerprint: match[5]!,
    selectionRevision: match[6]!,
    registryRevision: match[7]!,
  };
}

function parseIndependentRefreshSourceBinding(value: string): { generationId: string; receiptDigest: string } {
  const match = /^independent-tweakers-patch:[^:]+:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-f0-9]{64})$/.exec(value);
  if (match === null) throw new ManagerActionAdapterError("internal_error", "Prepared independent refresh has no exact registered-source binding");
  return { generationId: match[1]!, receiptDigest: match[2]! };
}

function parseOfficialSourceRegistrationBinding(value: string): string {
  const match = /^official-source-candidate:([a-f0-9]{64})$/.exec(value);
  if (match === null) throw new ManagerActionAdapterError("internal_error", "Prepared official-source registration has no exact source binding");
  return match[1]!;
}

function registrationReceiptRef(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagerActionAdapterError("internal_error", "Official-source registration returned no durable receipt");
  }
  const receiptRef = (value as Record<string, unknown>).receiptRef;
  if (typeof receiptRef !== "string" || !/^official-source:[0-9a-f-]{36}:[a-f0-9]{64}$/.test(receiptRef)) {
    throw new ManagerActionAdapterError("internal_error", "Official-source registration returned an invalid durable receipt");
  }
  return receiptRef;
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

/**
 * A historic manager record remains readable for diagnostics, but its retired
 * action can never cross the execution boundary again.  This explicit gate is
 * intentionally before any state-token refresh, receipt lookup, or executor.
 */
function requireExecutablePreparedOperation(record: TweakersManagerPreparedOperationV1): ExecutablePreparedOperation {
  if (!(TWEAKERS_MANAGER_ACTION_IDS_V1 as readonly string[]).includes(record.actionId)) {
    throw new ManagerActionAdapterError(
      "unsupported_action",
      `Manager action ${record.actionId} is retired and can only be inspected as historical diagnostics`,
    );
  }
  return record as ExecutablePreparedOperation;
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

function splitReceiptRef(value: string): ["environment" | "injected-chatgpt-patch" | "independent-tweakers-patch", string] {
  const match = /^(environment|injected-chatgpt-patch|independent-tweakers-patch):(.+)$/.exec(value);
  if (!match) throw new ManagerActionAdapterError("internal_error", "prepared operation has an invalid receipt target");
  return [
    match[1] as "environment" | "injected-chatgpt-patch" | "independent-tweakers-patch",
    match[2]!,
  ];
}

function assertEnvironmentTerminal(value: unknown, expectedTransactionId: string, phases: readonly string[]): void {
  if (!isRecord(value)
    || value.transactionId !== expectedTransactionId
    || typeof value.phase !== "string"
    || !phases.includes(value.phase)) {
    throw new ManagerActionAdapterError("internal_error", "environment action did not produce the expected durable terminal receipt");
  }
}

function assertInjectedRefreshExecutionResult(
  value: unknown,
  expectedTransactionId: string,
  record: TweakersManagerPreparedOperationV1,
): asserts value is InjectedRefreshExecutionResult {
  if (!isRecord(value)
    || value.transactionId !== expectedTransactionId
    || value.phase !== "committed"
    || value.runtimeVerified !== true
    || typeof value.newMainPid !== "number"
    || !Number.isInteger(value.newMainPid)
    || value.newMainPid <= 0
    || (value.oldMainPid !== null
      && (typeof value.oldMainPid !== "number" || !Number.isInteger(value.oldMainPid) || value.oldMainPid <= 0))
    || (typeof value.oldMainPid === "number" && value.oldMainPid === value.newMainPid)
    || !isEnvironmentAppliedEvidence(value.applied)
    || value.applied.selection.appExperience !== "tweakers"
    || value.applied.selection.selectedDesktopPath !== "/Applications/ChatGPT.app"
    || value.applied.selection.selectedDesktopBundleId !== "com.openai.codex"
    || record.receiptRefs[1] !== `environment:${expectedTransactionId}`) {
    throw new ManagerActionAdapterError(
      "internal_error",
      "injected refresh did not return the exact committed new-PID runtime-verified environment receipt",
    );
  }
}

function isEnvironmentAppliedEvidence(value: unknown): value is EnvironmentAppliedEvidence {
  if (!isRecord(value)
    || !isRecord(value.selection)
    || typeof value.observedAt !== "string"
    || typeof value.desktopVersion !== "string"
    || typeof value.desktopBuild !== "string"
    || typeof value.backendVersion !== "string"
    || typeof value.desktopArtifactDigest !== "string"
    || typeof value.asarHeaderHash !== "string"
    || typeof value.backendArtifactDigest !== "string"
    || !isLowerSha256(value.desktopArtifactDigest)
    || !isLowerSha256(value.asarHeaderHash)
    || !isLowerSha256(value.backendArtifactDigest)) return false;
  const selection = value.selection;
  return selection.selectedDesktopPath === "/Applications/ChatGPT.app"
    && selection.selectedDesktopBundleId === "com.openai.codex"
    && selection.releaseProfile === "stable"
    && selection.appExperience === "tweakers"
    && typeof selection.backendLane === "string"
    && typeof selection.requestedAt === "string"
    && typeof selection.appliedAt === "string";
}

function sameReceiptReferences(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameConsumedRecord(
  current: TweakersManagerPreparedOperationV1,
  expected: TweakersManagerPreparedOperationV1,
): boolean {
  return current.phase === "consumed"
    && current.consumedAt !== null
    && sameConsumedOperationIdentity(current, expected);
}

/** Timing evidence is the only mutable portion of a consumed refresh record.
 * Every approval, receipt binding, and executable identity remains exact. */
function sameConsumedOperationIdentity(
  current: TweakersManagerPreparedOperationV1,
  expected: TweakersManagerPreparedOperationV1,
): boolean {
  const { timing: _currentTiming, ...currentWithoutTiming } = current;
  const { timing: _expectedTiming, ...expectedWithoutTiming } = expected;
  return canonicalManagerJson(currentWithoutTiming) === canonicalManagerJson(expectedWithoutTiming);
}

function isLowerSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isLowerUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}

function isSha256Revision(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function staleState(message: string, currentStateToken: `sha256:${string}`): ManagerActionAdapterError {
  return new ManagerActionAdapterError("stale_state", message, currentStateToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return operationErrorMessage(error);
}

// Keep these imports used in the public type surface when the runtime is
// bundled; they also make the explicit owner-only root contract discoverable
// to tests without allowing callers to supply a path through the protocol.
export type { ManagerOperationStorePaths };

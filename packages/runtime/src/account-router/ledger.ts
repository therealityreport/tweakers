import { randomBytes } from "node:crypto";
import type {
  EligibilityState,
  OpaqueAccountId,
  Reservation,
  RouterConfig,
  RouterState,
} from "./types";
import type { RouterStateStore } from "./state-store";
import { accountObservationEligible, compareQuotaCandidates, type AccountQuotaObservation } from "./quota";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FairnessPrecision = "projected" | "exact_completed_spend" | "estimated";

export interface AccountSelection {
  opaqueAccountId: OpaqueAccountId;
  normalizedSpend: number;
}

export interface KnownThreadBinding {
  threadId: string;
  owner: OpaqueAccountId;
}

export interface DoctorReviewLeaseReservation {
  reservationId: string;
  opaqueAccountId: OpaqueAccountId;
  estimatedCost: number;
  state: Reservation["state"];
  requestDigest: `hmac-sha256:${string}`;
}

/**
 * The ledger is deliberately local: it allocates request work fairly without
 * claiming to know provider-side quota consumption. Every debit is durable
 * before a byte can be written to a selected child.
 */
export class AccountLedger {
  private readonly lastSelection = new Map<OpaqueAccountId, number>();
  private readonly outputHistory = new Map<string, number[]>();
  private estimated = false;

  constructor(
    private readonly store: RouterStateStore,
    private readonly config: RouterConfig,
    private readonly now: () => number = Date.now,
    private readonly random: (length: number) => Buffer = randomBytes,
  ) {}

  get precision(): FairnessPrecision {
    const state = this.store.snapshot();
    if (this.estimated) return "estimated";
    if (state.reservations.some((reservation) => reservation.state === "reserved" || reservation.state === "stranded_ambiguous")) return "projected";
    return "exact_completed_spend";
  }

  estimateRequestCost(params: unknown, model = "default"): number {
    const inputBytes = Buffer.byteLength(JSON.stringify(params ?? null), "utf8");
    const median = this.rollingOutputMedian(model);
    return clamp(Math.ceil(inputBytes / 4) + median, 1, 32_768);
  }

  select(requirement?: (account: OpaqueAccountId) => boolean): AccountSelection | null {
    const state = this.store.snapshot();
    const candidates = this.config.accounts
      .filter((account) => account.included && state.accountEligibility[account.opaqueAccountId] === "eligible")
      .filter((account) => requirement?.(account.opaqueAccountId) ?? true)
      .map((account) => ({
        opaqueAccountId: account.opaqueAccountId,
        normalizedSpend: normalizedSpend(state, account.opaqueAccountId),
        lastSelected: this.lastSelection.get(account.opaqueAccountId) ?? Number.NEGATIVE_INFINITY,
      }));
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => left.normalizedSpend - right.normalizedSpend
      || left.lastSelected - right.lastSelected
      || left.opaqueAccountId.localeCompare(right.opaqueAccountId));
    const chosen = candidates[0];
    this.lastSelection.set(chosen.opaqueAccountId, this.now());
    return { opaqueAccountId: chosen.opaqueAccountId, normalizedSpend: chosen.normalizedSpend };
  }

  /**
   * The v2 policy is intentionally stricter than v1 fair balancing: either
   * enrolled account lacking fresh, authenticated weekly capacity pauses new
   * assignments. Existing owned threads do not use this selector.
   */
  selectQuotaAware(observations: ReadonlyMap<OpaqueAccountId, AccountQuotaObservation>): AccountSelection | null {
    const state = this.store.snapshot();
    const candidates = this.config.accounts.map((account, configuredIndex) => {
      const observation = observations.get(account.opaqueAccountId);
      const ledger = state.ledger[account.opaqueAccountId];
      if (!account.included || state.accountEligibility[account.opaqueAccountId] !== "eligible"
        || !ledger || !observation || !accountObservationEligible(observation, this.now())
        || observation.weeklyRemainingPercent === null || observation.weeklyResetAt === null) return null;
      return {
        opaqueAccountId: account.opaqueAccountId,
        weeklyRemainingPercent: observation.weeklyRemainingPercent,
        weeklyResetAt: observation.weeklyResetAt,
        shortWindowPressure: observation.shortWindowPressure,
        assignedThreadCount: ledger.assignedThreadCount,
        resetCredits: observation.resetCredits,
        configuredIndex,
      };
    });
    // Preserve v2's exact-pair fail-closed behavior. V3 intentionally selects
    // from the currently eligible subset of the enabled pool.
    if (this.config.schemaVersion === 2 && (candidates.length !== 2 || candidates.some((candidate) => candidate === null))) return null;
    const eligible = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    if (eligible.length === 0) return null;
    const sorted = eligible.sort((left, right) => compareQuotaCandidates(left, right, this.now()));
    const chosen = sorted[0];
    this.lastSelection.set(chosen.opaqueAccountId, this.now());
    return { opaqueAccountId: chosen.opaqueAccountId, normalizedSpend: normalizedSpend(state, chosen.opaqueAccountId) };
  }

  reserve(opaqueAccountId: OpaqueAccountId, estimatedCost: number): Reservation {
    if (!Number.isInteger(estimatedCost) || estimatedCost < 1 || estimatedCost > 32_768) throw new Error("invalid account-router reservation cost");
    const reservation: Reservation = {
      reservationId: `rs_${this.random(16).toString("base64url")}`,
      opaqueAccountId,
      estimatedCost,
      state: "reserved",
      epoch: this.store.snapshot().epoch,
    };
    this.store.update((state) => {
      const ledger = state.ledger[opaqueAccountId];
      if (!ledger || state.accountEligibility[opaqueAccountId] !== "eligible") throw new Error("account is not eligible for reservation");
      ledger.reservedRequestCost += estimatedCost;
      state.reservations.push(reservation);
    });
    return reservation;
  }

  /** Atomically create or recover the one reservation bound to a Doctor request. */
  reserveDoctorReview(
    opaqueAccountId: OpaqueAccountId,
    estimatedCost: number,
    requestDigest: `hmac-sha256:${string}`,
  ): DoctorReviewLeaseReservation {
    if (!Number.isSafeInteger(estimatedCost) || estimatedCost < 1 || estimatedCost > 1_000_000
      || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(requestDigest)) throw new Error("invalid Doctor review reservation");
    let result: Reservation | null = null;
    this.store.update((state) => {
      const existing = state.reservations.find((candidate) => candidate.requestDigest === requestDigest);
      if (existing) {
        if (existing.purpose !== "doctor_review" || existing.opaqueAccountId !== opaqueAccountId || existing.estimatedCost !== estimatedCost) {
          throw new Error("Doctor review reservation correlation collision");
        }
        result = existing;
        return;
      }
      const ledger = state.ledger[opaqueAccountId];
      const configured = this.config.accounts.find((account) => account.opaqueAccountId === opaqueAccountId);
      if (!ledger || !configured?.included) {
        throw new Error("Doctor review account is unavailable");
      }
      if (!Number.isSafeInteger(ledger.reservedRequestCost + estimatedCost)) throw new Error("Doctor review reservation capacity exceeded");
      const reservation: Reservation = {
        reservationId: `rs_${this.random(16).toString("base64url")}`,
        opaqueAccountId,
        estimatedCost,
        state: "reserved",
        epoch: state.epoch,
        purpose: "doctor_review",
        requestDigest,
      };
      ledger.reservedRequestCost += estimatedCost;
      state.reservations.push(reservation);
      result = reservation;
    });
    const reservation = result!;
    return { reservationId: reservation.reservationId, opaqueAccountId: reservation.opaqueAccountId,
      estimatedCost: reservation.estimatedCost, state: reservation.state, requestDigest };
  }

  doctorReviewReservation(requestDigest: `hmac-sha256:${string}`): DoctorReviewLeaseReservation | null {
    const reservation = this.store.snapshot().reservations.find((candidate) => candidate.purpose === "doctor_review"
      && candidate.requestDigest === requestDigest);
    return reservation ? { reservationId: reservation.reservationId, opaqueAccountId: reservation.opaqueAccountId,
      estimatedCost: reservation.estimatedCost, state: reservation.state, requestDigest } : null;
  }

  markDoctorReviewDispatched(reservationId: string): void {
    this.store.update((state) => {
      const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId && candidate.purpose === "doctor_review");
      if (!reservation) throw new Error("Doctor review reservation is unavailable");
      if (reservation.state === "dispatched") return;
      if (reservation.state !== "reserved") throw new Error("Doctor review reservation cannot be dispatched");
      reservation.state = "dispatched";
    });
  }

  settleDoctorReview(
    reservationId: string,
    outcome: "pre_dispatch" | "completed" | "ambiguous",
    usage?: TokenUsage,
  ): void {
    this.store.update((state) => {
      const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId && candidate.purpose === "doctor_review");
      if (!reservation) throw new Error("Doctor review reservation is unavailable");
      const ledger = state.ledger[reservation.opaqueAccountId];
      if (!ledger) throw new Error("Doctor review reservation owner is unavailable");
      const terminal = reservation.state === "released_pre_dispatch" || reservation.state === "reconciled";
      const target = outcome === "pre_dispatch" ? "released_pre_dispatch" : outcome === "completed" ? "reconciled" : "stranded_ambiguous";
      if (terminal) {
        if (reservation.state !== target || outcome === "completed"
          && (!usage || reservation.settledUsage?.inputTokens !== usage.inputTokens || reservation.settledUsage?.outputTokens !== usage.outputTokens)) {
          throw new Error("Doctor review reservation already has a different outcome");
        }
        return;
      }
      if (reservation.state === "stranded_ambiguous" && outcome === "ambiguous") return;
      if (outcome === "pre_dispatch") {
        // The authenticated manager durably proves that it never invoked the
        // CLI. This also resolves a lost mark acknowledgement recovered as a
        // stranded lease without manufacturing provider usage.
        if (reservation.state !== "reserved" && reservation.state !== "dispatched" && reservation.state !== "stranded_ambiguous") {
          throw new Error("Doctor review pre-dispatch release is unavailable");
        }
      } else if (reservation.state !== "dispatched" && !(outcome === "completed" && reservation.state === "stranded_ambiguous")) {
        throw new Error("Doctor review settlement requires a dispatch marker");
      }
      if (outcome === "completed") {
        if (!usage || !isUsage(usage)) throw new Error("Doctor review completion requires valid usage");
        ledger.completedInputTokens += usage.inputTokens;
        ledger.completedOutputTokens += usage.outputTokens;
        reservation.settledUsage = { ...usage };
      } else if (usage !== undefined) {
        throw new Error("Doctor review usage is valid only for completed work");
      }
      if (outcome !== "ambiguous") ledger.reservedRequestCost = Math.max(0, ledger.reservedRequestCost - reservation.estimatedCost);
      reservation.state = target;
    });
  }

  /** A restart releases proved-unwritten work and strands every marked dispatch. */
  recoverDoctorReviewReservations(): void {
    this.store.update((state) => {
      for (const reservation of state.reservations) {
        if (reservation.purpose !== "doctor_review") continue;
        const ledger = state.ledger[reservation.opaqueAccountId];
        if (!ledger) throw new Error("Doctor review reservation owner is unavailable");
        if (reservation.state === "reserved") {
          ledger.reservedRequestCost = Math.max(0, ledger.reservedRequestCost - reservation.estimatedCost);
          reservation.state = "released_pre_dispatch";
        } else if (reservation.state === "dispatched") {
          reservation.state = "stranded_ambiguous";
        }
      }
    });
  }

  releasePreDispatch(reservationId: string): void {
    this.transitionReservation(reservationId, "released_pre_dispatch", (ledger, reservation) => {
      ledger.reservedRequestCost = Math.max(0, ledger.reservedRequestCost - reservation.estimatedCost);
    });
  }

  strandAmbiguous(reservationId: string): void {
    this.transitionReservation(reservationId, "stranded_ambiguous");
  }

  reconcile(reservationId: string, usage: TokenUsage | null, model = "default"): void {
    if (!usage || !isUsage(usage)) {
      this.estimated = true;
      this.strandAmbiguous(reservationId);
      return;
    }
    this.transitionReservation(reservationId, "reconciled", (ledger, reservation) => {
      ledger.reservedRequestCost = Math.max(0, ledger.reservedRequestCost - reservation.estimatedCost);
      ledger.completedInputTokens += usage.inputTokens;
      ledger.completedOutputTokens += usage.outputTokens;
    });
    const history = this.outputHistory.get(model) ?? [];
    history.push(usage.outputTokens);
    this.outputHistory.set(model, history.slice(-20));
  }

  bindThread(threadId: string, owner: OpaqueAccountId, pendingKey: string): void {
    if (!threadId) throw new Error("empty thread id cannot be bound");
    this.store.update((state) => {
      if (state.pendingThreadOwners[pendingKey] !== owner) throw new Error("pending thread owner mismatch");
      if (state.threadOwners[threadId] && state.threadOwners[threadId] !== owner) throw new Error("thread owner collision");
      state.threadOwners[threadId] = owner;
      delete state.pendingThreadOwners[pendingKey];
      state.ledger[owner].assignedThreadCount += 1;
    });
  }

  /** Bind a child-observed thread event before forwarding it to the desktop. */
  bindObservedThread(threadId: string, owner: OpaqueAccountId): boolean {
    const state = this.store.snapshot();
    const pending = Object.keys(state.pendingThreadOwners).filter((key) => state.pendingThreadOwners[key] === owner);
    if (pending.length !== 1) return false;
    this.bindThread(threadId, owner, pending[0]);
    return true;
  }

  bindKnownThread(threadId: string, owner: OpaqueAccountId): void {
    if (!threadId) throw new Error("empty thread id cannot be bound");
    this.store.update((state) => {
      if (state.threadOwners[threadId] && state.threadOwners[threadId] !== owner) throw new Error("thread owner collision");
      if (!state.threadOwners[threadId]) {
        state.threadOwners[threadId] = owner;
        state.ledger[owner].assignedThreadCount += 1;
      }
    });
  }

  /**
   * Commit a fully validated fanout page in one state update. Any collision or
   * malformed duplicate throws before the cloned durable state is persisted,
   * so a later child page can never leave half of a list owner-bound.
   */
  bindKnownThreads(bindings: readonly KnownThreadBinding[]): void {
    this.store.update((state) => {
      const batch = new Map<string, OpaqueAccountId>();
      for (const binding of bindings) {
        if (!binding.threadId || !state.ledger[binding.owner]) throw new Error("invalid known thread binding");
        const prior = batch.get(binding.threadId);
        if (prior !== undefined) throw new Error("duplicate aggregate thread id");
        batch.set(binding.threadId, binding.owner);
      }
      for (const [threadId, owner] of batch) {
        const existing = state.threadOwners[threadId];
        if (existing && existing !== owner) throw new Error("thread owner collision");
      }
      for (const [threadId, owner] of batch) {
        if (!state.threadOwners[threadId]) {
          state.threadOwners[threadId] = owner;
          state.ledger[owner].assignedThreadCount += 1;
        }
      }
    });
  }

  reservePendingOwner(pendingKey: string, owner: OpaqueAccountId): void {
    this.store.update((state) => {
      if (state.pendingThreadOwners[pendingKey]) throw new Error("duplicate pending thread owner");
      state.pendingThreadOwners[pendingKey] = owner;
    });
  }

  clearPendingOwner(pendingKey: string, owner: OpaqueAccountId): void {
    this.store.update((state) => {
      if (state.pendingThreadOwners[pendingKey] === owner) delete state.pendingThreadOwners[pendingKey];
    });
  }

  ownerFor(threadId: string): OpaqueAccountId | null {
    return this.store.snapshot().threadOwners[threadId] ?? null;
  }

  setEligibility(opaqueAccountId: OpaqueAccountId, eligibility: EligibilityState): void {
    this.store.update((state) => {
      if (!state.ledger[opaqueAccountId]) throw new Error("unknown account");
      state.accountEligibility[opaqueAccountId] = eligibility;
    });
  }

  resetEpoch(): void {
    this.store.update((state) => {
      if (state.correlations.length > 0 || state.pendingThreadOwners && Object.keys(state.pendingThreadOwners).length > 0
        || state.reservations.some((reservation) => reservation.state === "reserved" || reservation.state === "stranded_ambiguous")
        || Object.values(state.accountEligibility).some((eligibility) => eligibility === "validating" || eligibility === "active" || eligibility === "reserved")) {
        throw new Error("account-router epoch reset requires an idle router");
      }
      state.epoch += 1;
      for (const entry of Object.values(state.ledger)) {
        entry.completedInputTokens = 0;
        entry.completedOutputTokens = 0;
        entry.reservedRequestCost = 0;
        entry.assignedThreadCount = 0;
      }
      state.reservations = [];
    });
    this.estimated = false;
    this.lastSelection.clear();
    this.outputHistory.clear();
  }

  private transitionReservation(
    reservationId: string,
    target: Reservation["state"],
    update?: (ledger: RouterState["ledger"][string], reservation: Reservation) => void,
  ): void {
    this.store.update((state) => {
      const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId);
      if (!reservation || reservation.state !== "reserved") return;
      const ledger = state.ledger[reservation.opaqueAccountId];
      if (!ledger) throw new Error("reservation owner is missing from ledger");
      update?.(ledger, reservation);
      reservation.state = target;
    });
  }

  private rollingOutputMedian(model: string): number {
    const values = this.outputHistory.get(model);
    if (!values || values.length === 0) return 1_024;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }
}

export function normalizedSpend(state: RouterState, opaqueAccountId: OpaqueAccountId): number {
  const entry = state.ledger[opaqueAccountId];
  if (!entry) return Number.POSITIVE_INFINITY;
  return (entry.completedInputTokens + entry.completedOutputTokens + entry.reservedRequestCost) / entry.weight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isUsage(value: TokenUsage): boolean {
  return Number.isInteger(value.inputTokens) && value.inputTokens >= 0
    && Number.isInteger(value.outputTokens) && value.outputTokens >= 0;
}

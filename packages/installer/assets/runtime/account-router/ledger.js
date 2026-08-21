"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountLedger = void 0;
exports.normalizedSpend = normalizedSpend;
const node_crypto_1 = require("node:crypto");
/**
 * The ledger is deliberately local: it allocates request work fairly without
 * claiming to know provider-side quota consumption. Every debit is durable
 * before a byte can be written to a selected child.
 */
class AccountLedger {
    store;
    config;
    now;
    random;
    lastSelection = new Map();
    outputHistory = new Map();
    estimated = false;
    constructor(store, config, now = Date.now, random = node_crypto_1.randomBytes) {
        this.store = store;
        this.config = config;
        this.now = now;
        this.random = random;
    }
    get precision() {
        const state = this.store.snapshot();
        if (this.estimated)
            return "estimated";
        if (state.reservations.some((reservation) => reservation.state === "reserved" || reservation.state === "stranded_ambiguous"))
            return "projected";
        return "exact_completed_spend";
    }
    estimateRequestCost(params, model = "default") {
        const inputBytes = Buffer.byteLength(JSON.stringify(params ?? null), "utf8");
        const median = this.rollingOutputMedian(model);
        return clamp(Math.ceil(inputBytes / 4) + median, 1, 32_768);
    }
    select(requirement) {
        const state = this.store.snapshot();
        const candidates = this.config.accounts
            .filter((account) => account.included && state.accountEligibility[account.opaqueAccountId] === "eligible")
            .filter((account) => requirement?.(account.opaqueAccountId) ?? true)
            .map((account) => ({
            opaqueAccountId: account.opaqueAccountId,
            normalizedSpend: normalizedSpend(state, account.opaqueAccountId),
            lastSelected: this.lastSelection.get(account.opaqueAccountId) ?? Number.NEGATIVE_INFINITY,
        }));
        if (candidates.length === 0)
            return null;
        candidates.sort((left, right) => left.normalizedSpend - right.normalizedSpend
            || left.lastSelected - right.lastSelected
            || left.opaqueAccountId.localeCompare(right.opaqueAccountId));
        const chosen = candidates[0];
        this.lastSelection.set(chosen.opaqueAccountId, this.now());
        return { opaqueAccountId: chosen.opaqueAccountId, normalizedSpend: chosen.normalizedSpend };
    }
    reserve(opaqueAccountId, estimatedCost) {
        if (!Number.isInteger(estimatedCost) || estimatedCost < 1 || estimatedCost > 32_768)
            throw new Error("invalid account-router reservation cost");
        const reservation = {
            reservationId: `rs_${this.random(16).toString("base64url")}`,
            opaqueAccountId,
            estimatedCost,
            state: "reserved",
            epoch: this.store.snapshot().epoch,
        };
        this.store.update((state) => {
            const ledger = state.ledger[opaqueAccountId];
            if (!ledger || state.accountEligibility[opaqueAccountId] !== "eligible")
                throw new Error("account is not eligible for reservation");
            ledger.reservedRequestCost += estimatedCost;
            state.reservations.push(reservation);
        });
        return reservation;
    }
    releasePreDispatch(reservationId) {
        this.transitionReservation(reservationId, "released_pre_dispatch", (ledger, reservation) => {
            ledger.reservedRequestCost = Math.max(0, ledger.reservedRequestCost - reservation.estimatedCost);
        });
    }
    strandAmbiguous(reservationId) {
        this.transitionReservation(reservationId, "stranded_ambiguous");
    }
    reconcile(reservationId, usage, model = "default") {
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
    bindThread(threadId, owner, pendingKey) {
        if (!threadId)
            throw new Error("empty thread id cannot be bound");
        this.store.update((state) => {
            if (state.pendingThreadOwners[pendingKey] !== owner)
                throw new Error("pending thread owner mismatch");
            if (state.threadOwners[threadId] && state.threadOwners[threadId] !== owner)
                throw new Error("thread owner collision");
            state.threadOwners[threadId] = owner;
            delete state.pendingThreadOwners[pendingKey];
            state.ledger[owner].assignedThreadCount += 1;
        });
    }
    /** Bind a child-observed thread event before forwarding it to the desktop. */
    bindObservedThread(threadId, owner) {
        const state = this.store.snapshot();
        const pending = Object.keys(state.pendingThreadOwners).filter((key) => state.pendingThreadOwners[key] === owner);
        if (pending.length !== 1)
            return false;
        this.bindThread(threadId, owner, pending[0]);
        return true;
    }
    bindKnownThread(threadId, owner) {
        if (!threadId)
            throw new Error("empty thread id cannot be bound");
        this.store.update((state) => {
            if (state.threadOwners[threadId] && state.threadOwners[threadId] !== owner)
                throw new Error("thread owner collision");
            if (!state.threadOwners[threadId]) {
                state.threadOwners[threadId] = owner;
                state.ledger[owner].assignedThreadCount += 1;
            }
        });
    }
    reservePendingOwner(pendingKey, owner) {
        this.store.update((state) => {
            if (state.pendingThreadOwners[pendingKey])
                throw new Error("duplicate pending thread owner");
            state.pendingThreadOwners[pendingKey] = owner;
        });
    }
    clearPendingOwner(pendingKey, owner) {
        this.store.update((state) => {
            if (state.pendingThreadOwners[pendingKey] === owner)
                delete state.pendingThreadOwners[pendingKey];
        });
    }
    ownerFor(threadId) {
        return this.store.snapshot().threadOwners[threadId] ?? null;
    }
    setEligibility(opaqueAccountId, eligibility) {
        this.store.update((state) => {
            if (!state.ledger[opaqueAccountId])
                throw new Error("unknown account");
            state.accountEligibility[opaqueAccountId] = eligibility;
        });
    }
    resetEpoch() {
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
    transitionReservation(reservationId, target, update) {
        this.store.update((state) => {
            const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId);
            if (!reservation || reservation.state !== "reserved")
                return;
            const ledger = state.ledger[reservation.opaqueAccountId];
            if (!ledger)
                throw new Error("reservation owner is missing from ledger");
            update?.(ledger, reservation);
            reservation.state = target;
        });
    }
    rollingOutputMedian(model) {
        const values = this.outputHistory.get(model);
        if (!values || values.length === 0)
            return 1_024;
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.floor((sorted.length - 1) / 2)];
    }
}
exports.AccountLedger = AccountLedger;
function normalizedSpend(state, opaqueAccountId) {
    const entry = state.ledger[opaqueAccountId];
    if (!entry)
        return Number.POSITIVE_INFINITY;
    return (entry.completedInputTokens + entry.completedOutputTokens + entry.reservedRequestCost) / entry.weight;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function isUsage(value) {
    return Number.isInteger(value.inputTokens) && value.inputTokens >= 0
        && Number.isInteger(value.outputTokens) && value.outputTokens >= 0;
}
//# sourceMappingURL=ledger.js.map
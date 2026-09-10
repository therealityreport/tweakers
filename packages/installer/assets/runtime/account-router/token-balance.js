"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBalanceLedger = exports.TOKEN_BALANCE_FILE_V1 = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
/** Owner-private v1 token accounting. This is intentionally separate from router-state. */
exports.TOKEN_BALANCE_FILE_V1 = "token-balance-v1.json";
const TOKEN_BALANCE_VERSION = 1;
const MAX_TOKEN_BALANCE_BYTES = 1_024 * 1_024;
const MAX_RESERVATIONS = 640;
const MAX_ACTIVE_RESERVATIONS = 128;
const MAX_RECONCILABLE_DEBT_RESERVATIONS = 128;
const MAX_THREAD_COUNTERS = 512;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ESTIMATED_TOKENS = 10_000_000;
/**
 * A durable, single-owner ledger for the broker. Provider quota decides which
 * accounts are eligible; this class only compares token spend among that set.
 *
 * It deliberately charges only positive deltas from `tokenUsage.total`.
 * `tokenUsage.last` is retained as bounded evidence for missing totals, but
 * cannot safely be counted because the protocol supplies no completion ID.
 */
class TokenBalanceLedger {
    options;
    state;
    configured = new Map();
    orderedConfigured;
    now;
    random;
    fileName;
    constructor(options) {
        this.options = options;
        if (!Array.isArray(options.accounts))
            throw new Error("invalid token-balance accounts");
        for (const account of options.accounts) {
            if (!(0, types_1.isOpaqueAccountId)(account.opaqueAccountId) || typeof account.included !== "boolean" || this.configured.has(account.opaqueAccountId)) {
                throw new Error("invalid or duplicate token-balance account");
            }
            this.configured.set(account.opaqueAccountId, { opaqueAccountId: account.opaqueAccountId, included: account.included });
        }
        this.orderedConfigured = [...this.configured.keys()];
        this.now = options.now ?? Date.now;
        this.random = options.random ?? node_crypto_1.randomBytes;
        this.fileName = options.fileName ?? exports.TOKEN_BALANCE_FILE_V1;
        if (!safeFileName(this.fileName))
            throw new Error("unsafe token-balance file name");
        (0, state_store_1.ensurePrivateDirectory)(options.root);
        this.state = this.load();
        let changed = false;
        for (const opaqueAccountId of this.orderedConfigured) {
            if (!this.state.accounts[opaqueAccountId]) {
                this.state.accounts[opaqueAccountId] = emptyAccount();
                changed = true;
            }
        }
        if (changed)
            this.persist(this.state);
    }
    /** Select only from the caller's quota-eligible subset. No provider quota enters the ledger. */
    choose(eligibleAccountIds) {
        const eligible = new Set(eligibleAccountIds);
        let chosen = null;
        for (const opaqueAccountId of this.orderedConfigured) {
            const configured = this.configured.get(opaqueAccountId);
            if (!configured.included || !eligible.has(opaqueAccountId))
                continue;
            const projection = this.projectedTokens(opaqueAccountId);
            if (!projection)
                continue;
            if (!chosen || projection.projectedTokens < chosen.projectedTokens)
                chosen = { opaqueAccountId, ...projection };
        }
        return chosen;
    }
    projectedTokens(opaqueAccountId) {
        const account = this.state.accounts[opaqueAccountId];
        if (!account)
            return null;
        return {
            projectedTokens: safeAdd(safeAdd(account.completedTokens, account.estimatedCompletedTokens), reservedTokensFor(this.state, opaqueAccountId)),
            precision: precisionFor(this.state, opaqueAccountId),
        };
    }
    /**
     * Update the ledger's in-memory view of broker configuration without
     * dropping historical accounts or in-flight reservations. The broker owns
     * config persistence and calls this after its own config commit.
     */
    setAccounts(accounts) {
        const next = validatedAccounts(accounts);
        this.update((state) => {
            for (const opaqueAccountId of next.keys()) {
                if (!state.accounts[opaqueAccountId])
                    state.accounts[opaqueAccountId] = emptyAccount();
            }
        });
        this.configured.clear();
        for (const [opaqueAccountId, account] of next)
            this.configured.set(opaqueAccountId, account);
        this.orderedConfigured = [...next.keys()];
    }
    /**
     * Native in-place history has no trustworthy cumulative token baseline.
     * Keep that fact durable and idempotent instead of presenting historical
     * spend as an exact zero.  It does not create a reservation or charge a
     * provider total; broker-controlled work still begins at this ledger's
     * own baseline.
     */
    markImportedHistoryUnmeasured(accounts) {
        const unique = [...new Set(accounts)].sort();
        if (unique.some((opaqueAccountId) => !(0, types_1.isOpaqueAccountId)(opaqueAccountId) || !this.state.accounts[opaqueAccountId])) {
            throw new Error("invalid token-balance imported history account");
        }
        const existing = new Set(this.state.baseline.importedHistoryUnmeasuredAccounts);
        if (unique.every((opaqueAccountId) => existing.has(opaqueAccountId)))
            return;
        this.update((state) => {
            const marked = new Set(state.baseline.importedHistoryUnmeasuredAccounts);
            for (const opaqueAccountId of unique)
                marked.add(opaqueAccountId);
            state.baseline.importedHistoryUnmeasuredAccounts = [...marked].sort();
        });
    }
    /** Atomically reserve an account before the caller is permitted to write to its provider child. */
    begin(input) {
        const configured = this.configured.get(input.opaqueAccountId);
        if (!configured?.included)
            throw new Error("token-balance account is not currently included");
        if (!validEstimate(input.estimatedTokens))
            throw new Error("invalid token-balance reservation estimate");
        const reservationId = input.reservationId ?? `tbl_${this.random(18).toString("base64url")}`;
        if (!safeIdentifier(reservationId, 128))
            throw new Error("invalid token-balance reservation id");
        let result = null;
        this.update((state) => {
            const existing = state.reservations.find((reservation) => reservation.reservationId === reservationId);
            if (existing) {
                if (existing.opaqueAccountId !== input.opaqueAccountId || existing.estimatedTokens !== input.estimatedTokens) {
                    throw new Error("token-balance reservation id collision");
                }
                result = existing;
                return;
            }
            if (activeReservationCount(state) >= MAX_ACTIVE_RESERVATIONS)
                throw new Error("token-balance active reservation bound reached");
            const createdAt = this.timestamp();
            result = {
                reservationId,
                opaqueAccountId: input.opaqueAccountId,
                estimatedTokens: input.estimatedTokens,
                state: "reserved",
                threadId: null,
                turnId: null,
                createdAt,
                dispatchedAt: null,
                settledAt: null,
                observedTokens: 0,
                observedUsage: false,
                exactUsageObserved: false,
                hasUnknownUsage: false,
                estimatedDebtTokens: 0,
                missingUsage: false,
            };
            state.reservations.push(result);
        });
        return publicReservation(result);
    }
    /** Idempotently records the point after the one provider write may have happened. */
    markDispatched(reservationId) {
        this.update((state) => {
            const reservation = reservationById(state, reservationId);
            if (reservation.state === "reserved") {
                reservation.state = "dispatched";
                reservation.dispatchedAt = this.timestamp();
                return;
            }
            if (["dispatched", "observed", "uncertain_after_restart"].includes(reservation.state))
                return;
            throw new Error("token-balance cannot dispatch a terminal reservation");
        });
    }
    /** Attach private provider IDs once a start reply or notification supplies them. */
    bind(reservationId, binding) {
        if (!safeIdentifier(binding.threadId, MAX_IDENTIFIER_LENGTH) || (binding.turnId !== undefined && binding.turnId !== null && !safeIdentifier(binding.turnId, MAX_IDENTIFIER_LENGTH))) {
            throw new Error("invalid token-balance provider binding");
        }
        this.update((state) => {
            const reservation = reservationById(state, reservationId);
            if (isTerminal(reservation.state))
                throw new Error("token-balance cannot bind a terminal reservation");
            if (reservation.threadId !== null && reservation.threadId !== binding.threadId)
                throw new Error("token-balance thread binding collision");
            const turnId = binding.turnId ?? null;
            if (reservation.turnId !== null && turnId !== null && reservation.turnId !== turnId)
                throw new Error("token-balance turn binding collision");
            reservation.threadId = binding.threadId;
            if (turnId !== null)
                reservation.turnId = turnId;
        });
    }
    /**
     * Owner-private restart correlation. This intentionally returns only a
     * local reservation ID and is not included in `snapshot()`: host recovery
     * can feed a delayed official total back into the exact pending/debt record
     * without exposing a provider thread ID through broker status or UI data.
     */
    reservationForThread(input) {
        if (!safeIdentifier(input.threadId, MAX_IDENTIFIER_LENGTH)
            || (input.turnId !== undefined && input.turnId !== null && !safeIdentifier(input.turnId, MAX_IDENTIFIER_LENGTH))) {
            throw new Error("invalid token-balance usage correlation");
        }
        if (!this.state.accounts[input.opaqueAccountId])
            return null;
        const matches = this.state.reservations.filter((reservation) => reservation.opaqueAccountId === input.opaqueAccountId
            && reservation.threadId === input.threadId
            && (reservation.turnId === null || !input.turnId || reservation.turnId === input.turnId)
            && reservation.state !== "released_pre_dispatch"
            && (!isTerminal(reservation.state) || reservation.estimatedDebtTokens > 0));
        return matches.length === 1 ? matches[0].reservationId : null;
    }
    /** This is the sole release path, and proves no provider dispatch occurred. */
    releasePreDispatch(reservationId) {
        this.update((state) => {
            const reservation = reservationById(state, reservationId);
            if (reservation.state === "released_pre_dispatch")
                return;
            if (reservation.state !== "reserved")
                throw new Error("token-balance refuses to release possibly dispatched work");
            reservation.state = "released_pre_dispatch";
            reservation.settledAt = this.timestamp();
        });
    }
    /**
     * Capture an existing thread's known cumulative total before dispatch. This
     * prevents its imported/history usage from being charged to the next turn.
     */
    seedThreadBaseline(input) {
        if (!safeIdentifier(input.threadId, MAX_IDENTIFIER_LENGTH))
            throw new Error("invalid token-balance thread id");
        if (!this.state.accounts[input.opaqueAccountId])
            throw new Error("unknown token-balance account");
        const total = parseTotal(unwrapTotal(input.tokenUsage));
        if (!total || total.basis === "partial")
            throw new Error("token-balance baseline requires a complete total");
        this.update((state) => {
            const key = threadKey(input.opaqueAccountId, input.threadId);
            const existing = state.threads[key];
            if (existing && !sameTotal(existing, total))
                throw new Error("token-balance baseline already differs");
            if (!existing) {
                makeThreadRoom(state);
                state.threads[key] = counterFromTotal(input.opaqueAccountId, input.threadId, total, false, this.timestamp());
            }
        });
    }
    /**
     * Reconcile an official `thread/tokenUsage/updated` payload. Only positive
     * deltas from nested `tokenUsage.total` are charged. A last-only payload is
     * deliberately visible as partial evidence but never counted as exact usage.
     */
    observe(input) {
        if (!safeIdentifier(input.threadId, MAX_IDENTIFIER_LENGTH)
            || (input.turnId !== undefined && input.turnId !== null && !safeIdentifier(input.turnId, MAX_IDENTIFIER_LENGTH))) {
            throw new Error("invalid token-balance usage correlation");
        }
        if (!this.state.accounts[input.opaqueAccountId])
            throw new Error("unknown token-balance account");
        let result = { addedTokens: 0, precision: precisionFor(this.state, input.opaqueAccountId), reservationId: null };
        this.update((state) => {
            const reservation = findAttribution(state, input);
            result.reservationId = reservation?.reservationId ?? null;
            if (reservation && input.reservationId && reservation.threadId === null && !isTerminal(reservation.state)) {
                reservation.threadId = input.threadId;
                if (input.turnId)
                    reservation.turnId = input.turnId;
            }
            const nested = (0, types_1.isPlainRecord)(input.tokenUsage) ? input.tokenUsage : null;
            const total = parseTotal(nested?.total);
            const hasLast = parseTotal(nested?.last) !== null;
            if (!total) {
                if (hasLast)
                    recordLastOnly(state, input.opaqueAccountId, input.threadId);
                else
                    state.accounts[input.opaqueAccountId].partialObservationCount += 1;
                if (reservation)
                    reservation.hasUnknownUsage = true;
                result.precision = precisionFor(state, input.opaqueAccountId);
                return;
            }
            const key = threadKey(input.opaqueAccountId, input.threadId);
            let counter = state.threads[key];
            if (!counter) {
                makeThreadRoom(state);
                // A first unseeded cumulative total may include history. Preserve it
                // as a baseline and make that uncertainty visible instead of charging
                // a possibly old full-thread total to this account.
                counter = counterFromTotal(input.opaqueAccountId, input.threadId, total, true, this.timestamp());
                state.threads[key] = counter;
                state.accounts[input.opaqueAccountId].unknownUsageCount += 1;
                if (reservation) {
                    reservation.observedUsage = true;
                    reservation.hasUnknownUsage = true;
                }
                result.precision = precisionFor(state, input.opaqueAccountId);
                return;
            }
            counter.lastObservedAt = this.timestamp();
            if (counter.basis === "uninitialized") {
                // A folded terminal debt has no prior cumulative counter. Its first
                // later total establishes a fresh baseline; it must not be mistaken
                // for the old missing completion or used to erase that debt.
                counter.basis = total.basis;
                counter.inputTokens = total.inputTokens;
                counter.outputTokens = total.outputTokens;
                counter.aggregateTokens = total.aggregateTokens;
                counter.priorTotalUnknown = true;
                if (reservation)
                    reservation.hasUnknownUsage = true;
                result.precision = precisionFor(state, input.opaqueAccountId);
                return;
            }
            if (counter.basis !== total.basis || total.basis === "partial") {
                state.accounts[input.opaqueAccountId].partialObservationCount += 1;
                if (reservation) {
                    reservation.observedUsage = true;
                    reservation.hasUnknownUsage = true;
                }
                result.precision = precisionFor(state, input.opaqueAccountId);
                return;
            }
            const delta = positiveDelta(counter, total);
            if (delta.outOfOrder) {
                counter.outOfOrderTotalCount += 1;
                state.counters.outOfOrderTotalCount += 1;
                state.accounts[input.opaqueAccountId].partialObservationCount += 1;
            }
            if (delta.tokens > 0) {
                charge(state.accounts[input.opaqueAccountId], total.basis, delta.inputTokens, delta.outputTokens, delta.aggregateTokens);
                let unrepaidTokens = delta.tokens;
                if (reservation) {
                    reservation.observedTokens = safeAdd(reservation.observedTokens, delta.tokens);
                    unrepaidTokens -= repayEstimatedDebt(state.accounts[input.opaqueAccountId], reservation, unrepaidTokens);
                    if (reservation.state === "dispatched")
                        reservation.state = "observed";
                }
                repayThreadDebt(state.accounts[input.opaqueAccountId], counter, unrepaidTokens);
            }
            if (reservation) {
                reservation.observedUsage = true;
                if (!counter.priorTotalUnknown)
                    reservation.exactUsageObserved = true;
            }
            result.addedTokens = delta.tokens;
            result.precision = precisionFor(state, input.opaqueAccountId);
        });
        return result;
    }
    /**
     * Remove a known terminal dispatch from projected spend. If no valid total
     * was observed, retain a missing-usage marker; a later total still accrues.
     */
    settle(reservationId) {
        this.update((state) => {
            const reservation = reservationById(state, reservationId);
            if (reservation.state === "settled")
                return;
            if (reservation.state === "released_pre_dispatch")
                throw new Error("token-balance cannot settle a released reservation");
            if (reservation.state === "reserved")
                throw new Error("token-balance requires a pre-dispatch release or dispatch mark");
            if (!reservation.exactUsageObserved || reservation.hasUnknownUsage) {
                reservation.missingUsage = true;
                const estimatedDebtTokens = Math.max(0, reservation.estimatedTokens - reservation.observedTokens);
                reservation.estimatedDebtTokens = estimatedDebtTokens;
                state.accounts[reservation.opaqueAccountId].estimatedCompletedTokens = safeAdd(state.accounts[reservation.opaqueAccountId].estimatedCompletedTokens, estimatedDebtTokens);
                state.accounts[reservation.opaqueAccountId].unknownUsageCount += 1;
            }
            reservation.state = "settled";
            reservation.settledAt = this.timestamp();
        });
    }
    /** Persist restart ambiguity without replaying or releasing a possible provider write. */
    recover() {
        let uncertainReservations = 0;
        this.update((state) => {
            for (const reservation of state.reservations) {
                // Broker code must durably mark dispatch before its one provider write.
                // A persisted `reserved` record therefore proves no write occurred.
                if (reservation.state === "reserved") {
                    reservation.state = "released_pre_dispatch";
                    reservation.settledAt = this.timestamp();
                }
                else if (["dispatched", "observed"].includes(reservation.state)) {
                    reservation.state = "uncertain_after_restart";
                    state.accounts[reservation.opaqueAccountId].unknownUsageCount += 1;
                    uncertainReservations += 1;
                }
            }
        });
        return { uncertainReservations };
    }
    /**
     * Finish owner-election recovery without replaying a possible provider
     * write. Each uncertain record becomes terminal missing usage and retains a
     * conservative debit that a later official cumulative delta can replace.
     * The existing recovery uncertainty remains in account precision.
     */
    terminalizeUncertainAfterRecovery() {
        let terminalized = 0;
        this.update((state) => {
            for (const reservation of state.reservations) {
                if (reservation.state !== "uncertain_after_restart")
                    continue;
                reservation.state = "settled";
                reservation.settledAt = this.timestamp();
                reservation.missingUsage = true;
                const estimatedDebtTokens = Math.max(0, reservation.estimatedTokens - reservation.observedTokens);
                reservation.estimatedDebtTokens = estimatedDebtTokens;
                state.accounts[reservation.opaqueAccountId].estimatedCompletedTokens = safeAdd(state.accounts[reservation.opaqueAccountId].estimatedCompletedTokens, estimatedDebtTokens);
                terminalized += 1;
            }
        });
        return { terminalized };
    }
    accountSummary(opaqueAccountId) {
        const account = this.state.accounts[opaqueAccountId];
        if (!account)
            return null;
        const configured = this.configured.get(opaqueAccountId);
        const reservedTokens = reservedTokensFor(this.state, opaqueAccountId);
        const currentMeasuredTotal = this.orderedConfigured
            .filter((candidate) => this.configured.get(candidate)?.included)
            .reduce((sum, candidate) => safeAdd(sum, this.state.accounts[candidate]?.completedTokens ?? 0), 0);
        return {
            opaqueAccountId,
            included: configured?.included ?? false,
            completedTokens: account.completedTokens,
            completedInputTokens: account.completedAggregateTokens > 0 ? null : account.completedInputTokens,
            completedOutputTokens: account.completedAggregateTokens > 0 ? null : account.completedOutputTokens,
            reservedTokens,
            unreportedTokens: account.estimatedCompletedTokens,
            estimatedTokens: safeAdd(safeAdd(account.completedTokens, account.estimatedCompletedTokens), reservedTokens),
            precision: precisionFor(this.state, opaqueAccountId),
            sharePercent: !configured?.included || currentMeasuredTotal === 0 ? null : (account.completedTokens / currentMeasuredTotal) * 100,
        };
    }
    /** Public-safe snapshot: no thread, turn, reservation, or provider identifiers. */
    snapshot() {
        const ordered = [
            ...this.orderedConfigured,
            ...Object.keys(this.state.accounts).filter((id) => !this.configured.has(id)).sort(),
        ];
        const reservations = this.state.reservations;
        return {
            version: TOKEN_BALANCE_VERSION,
            baseline: { ...this.state.baseline },
            accounts: ordered.map((opaqueAccountId) => this.accountSummary(opaqueAccountId)).filter(Boolean),
            uncertainReservationCount: reservations.filter((reservation) => reservation.state === "uncertain_after_restart").length,
            reservations: {
                active: activeReservationCount(this.state),
                uncertain: reservations.filter((reservation) => reservation.state === "uncertain_after_restart").length,
                missingUsage: reservations.filter((reservation) => reservation.missingUsage).length,
            },
            observations: {
                threadCount: Object.keys(this.state.threads).length,
                lastOnlyCount: this.state.counters.lastOnlyCount,
                outOfOrderTotalCount: this.state.counters.outOfOrderTotalCount,
            },
        };
    }
    get path() {
        return (0, node_path_1.join)(this.options.root, this.fileName);
    }
    load() {
        if (!(0, node_fs_1.existsSync)(this.path)) {
            const initial = {
                version: TOKEN_BALANCE_VERSION,
                baseline: { startedAt: this.timestamp(), importedHistoryUnmeasuredAccounts: [] },
                accounts: {},
                reservations: [],
                threads: {},
                counters: { lastOnlyCount: 0, outOfOrderTotalCount: 0, evictedThreadCount: 0 },
            };
            this.persist(initial);
            return initial;
        }
        (0, state_store_1.assertPrivateRegularFile)(this.path, MAX_TOKEN_BALANCE_BYTES);
        const raw = (0, node_fs_1.readFileSync)(this.path, "utf8");
        if (Buffer.byteLength(raw) > MAX_TOKEN_BALANCE_BYTES)
            throw new Error("token-balance state exceeds its bounded size");
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error("token-balance state is corrupt");
        }
        const normalized = normalizeLegacyBaseline(parsed);
        if (!normalized || !validateState(normalized))
            throw new Error("token-balance state failed strict validation");
        if (normalized !== parsed)
            this.persist(normalized);
        return normalized;
    }
    update(mutator) {
        const next = structuredClone(this.state);
        mutator(next);
        compactReservations(next);
        if (!validateState(next))
            throw new Error("token-balance refused an invalid durable state");
        this.persist(next);
        this.state = next;
    }
    persist(next) {
        (0, state_store_1.writePrivateJsonAtomicBounded)(this.options.root, this.fileName, next, MAX_TOKEN_BALANCE_BYTES);
    }
    timestamp() {
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < 0)
            throw new Error("invalid token-balance clock");
        return new Date(now).toISOString();
    }
}
exports.TokenBalanceLedger = TokenBalanceLedger;
function emptyAccount() {
    return {
        completedTokens: 0,
        completedInputTokens: 0,
        completedOutputTokens: 0,
        completedAggregateTokens: 0,
        estimatedCompletedTokens: 0,
        irreconcilableDebtTokens: 0,
        partialObservationCount: 0,
        unknownUsageCount: 0,
    };
}
function publicReservation(reservation) {
    const { dispatchedAt: _dispatchedAt, settledAt: _settledAt, observedUsage: _observedUsage, exactUsageObserved: _exactUsageObserved, hasUnknownUsage: _hasUnknownUsage, estimatedDebtTokens: _estimatedDebtTokens, ...result } = reservation;
    return structuredClone(result);
}
function reservationById(state, reservationId) {
    if (!safeIdentifier(reservationId, 128))
        throw new Error("invalid token-balance reservation id");
    const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId);
    if (!reservation)
        throw new Error("unknown token-balance reservation");
    return reservation;
}
function findAttribution(state, input) {
    if (input.reservationId) {
        const reservation = reservationById(state, input.reservationId);
        if (reservation.opaqueAccountId !== input.opaqueAccountId)
            throw new Error("token-balance reservation account mismatch");
        if (reservation.threadId !== null && reservation.threadId !== input.threadId)
            throw new Error("token-balance reservation thread mismatch");
        if (reservation.turnId !== null && input.turnId && reservation.turnId !== input.turnId)
            throw new Error("token-balance reservation turn mismatch");
        return reservation;
    }
    const matches = state.reservations.filter((reservation) => reservation.opaqueAccountId === input.opaqueAccountId
        && reservation.threadId === input.threadId
        && (reservation.turnId === null || !input.turnId || reservation.turnId === input.turnId)
        && reservation.state !== "released_pre_dispatch");
    return matches.length === 1 ? matches[0] : null;
}
function parseTotal(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return null;
    const inputTokens = tokenField(value.inputTokens);
    const outputTokens = tokenField(value.outputTokens);
    const aggregateTokens = tokenField(value.totalTokens);
    if (inputTokens !== null && outputTokens !== null)
        return { basis: "components", inputTokens, outputTokens, aggregateTokens: null };
    if (aggregateTokens !== null)
        return { basis: "aggregate", inputTokens: null, outputTokens: null, aggregateTokens };
    if (inputTokens !== null || outputTokens !== null)
        return { basis: "partial", inputTokens, outputTokens, aggregateTokens: null };
    return null;
}
function unwrapTotal(value) {
    return (0, types_1.isPlainRecord)(value) && "total" in value ? value.total : value;
}
function tokenField(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function counterFromTotal(opaqueAccountId, threadId, total, priorTotalUnknown, observedAt) {
    return {
        opaqueAccountId,
        threadId,
        basis: total.basis,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        aggregateTokens: total.aggregateTokens,
        priorTotalUnknown,
        lastOnlyCount: 0,
        outOfOrderTotalCount: 0,
        unreportedDebtTokens: 0,
        lastObservedAt: observedAt,
    };
}
function counterForUnreportedDebt(opaqueAccountId, threadId, observedAt) {
    return {
        opaqueAccountId,
        threadId,
        basis: "uninitialized",
        inputTokens: null,
        outputTokens: null,
        aggregateTokens: null,
        priorTotalUnknown: true,
        lastOnlyCount: 0,
        outOfOrderTotalCount: 0,
        unreportedDebtTokens: 0,
        lastObservedAt: observedAt,
    };
}
function sameTotal(counter, total) {
    return counter.basis === total.basis
        && counter.inputTokens === total.inputTokens
        && counter.outputTokens === total.outputTokens
        && counter.aggregateTokens === total.aggregateTokens;
}
function positiveDelta(counter, total) {
    let inputTokens = 0;
    let outputTokens = 0;
    let aggregateTokens = 0;
    let outOfOrder = false;
    if (total.basis === "components") {
        inputTokens = deltaAndAdvance(counter, "inputTokens", total.inputTokens);
        outputTokens = deltaAndAdvance(counter, "outputTokens", total.outputTokens);
        outOfOrder = total.inputTokens < (counter.inputTokens - inputTokens) || total.outputTokens < (counter.outputTokens - outputTokens);
    }
    else if (total.basis === "aggregate") {
        aggregateTokens = deltaAndAdvance(counter, "aggregateTokens", total.aggregateTokens);
        outOfOrder = total.aggregateTokens < (counter.aggregateTokens - aggregateTokens);
    }
    return { tokens: safeAdd(safeAdd(inputTokens, outputTokens), aggregateTokens), inputTokens, outputTokens, aggregateTokens, outOfOrder };
}
function deltaAndAdvance(counter, key, next) {
    const prior = counter[key];
    if (prior === null)
        return 0;
    if (next <= prior)
        return 0;
    counter[key] = next;
    return next - prior;
}
function charge(account, basis, inputTokens, outputTokens, aggregateTokens) {
    const amount = safeAdd(safeAdd(inputTokens, outputTokens), aggregateTokens);
    account.completedTokens = safeAdd(account.completedTokens, amount);
    if (basis === "components") {
        account.completedInputTokens = safeAdd(account.completedInputTokens, inputTokens);
        account.completedOutputTokens = safeAdd(account.completedOutputTokens, outputTokens);
    }
    else if (basis === "aggregate") {
        account.completedAggregateTokens = safeAdd(account.completedAggregateTokens, aggregateTokens);
    }
}
/** Replace the conservative terminal debit as late official totals arrive. */
function repayEstimatedDebt(account, reservation, observedTokens) {
    if (reservation.estimatedDebtTokens === 0 || observedTokens === 0)
        return 0;
    const repaid = Math.min(reservation.estimatedDebtTokens, observedTokens);
    reservation.estimatedDebtTokens -= repaid;
    account.estimatedCompletedTokens -= repaid;
    if (reservation.estimatedDebtTokens === 0 && reservation.missingUsage) {
        reservation.missingUsage = false;
        account.unknownUsageCount = Math.max(0, account.unknownUsageCount - 1);
    }
    return repaid;
}
/** A folded debt may be replaced only by a later positive delta from its own thread. */
function repayThreadDebt(account, counter, observedTokens) {
    if (counter.unreportedDebtTokens === 0 || observedTokens === 0)
        return 0;
    const repaid = Math.min(counter.unreportedDebtTokens, observedTokens);
    counter.unreportedDebtTokens -= repaid;
    account.estimatedCompletedTokens -= repaid;
    return repaid;
}
function recordLastOnly(state, opaqueAccountId, threadId) {
    const key = threadKey(opaqueAccountId, threadId);
    const existing = state.threads[key];
    state.accounts[opaqueAccountId].partialObservationCount += 1;
    state.counters.lastOnlyCount += 1;
    if (existing)
        existing.lastOnlyCount += 1;
}
function makeThreadRoom(state) {
    if (Object.keys(state.threads).length < MAX_THREAD_COUNTERS)
        return;
    const activeThreads = new Set(state.reservations.filter((reservation) => !isTerminal(reservation.state) && reservation.threadId !== null)
        .map((reservation) => threadKey(reservation.opaqueAccountId, reservation.threadId)));
    const candidate = Object.entries(state.threads)
        .filter(([key]) => !activeThreads.has(key))
        .sort(([, left], [, right]) => left.lastObservedAt.localeCompare(right.lastObservedAt))[0];
    if (!candidate)
        throw new Error("token-balance thread counter bound reached by active work");
    const [key, counter] = candidate;
    if (counter.unreportedDebtTokens > 0) {
        state.accounts[counter.opaqueAccountId].irreconcilableDebtTokens = safeAdd(state.accounts[counter.opaqueAccountId].irreconcilableDebtTokens, counter.unreportedDebtTokens);
    }
    delete state.threads[key];
    state.counters.evictedThreadCount += 1;
    state.accounts[counter.opaqueAccountId].partialObservationCount += 1;
}
function compactReservations(state) {
    const active = state.reservations.filter((reservation) => !isTerminal(reservation.state));
    // A terminal record with an unrepaid conservative debit is still needed to
    // replace that estimate when delayed cumulative usage arrives. Dropping it
    // would cause a late total to be charged on top of the estimate.
    const debt = state.reservations.filter((reservation) => isTerminal(reservation.state) && reservation.estimatedDebtTokens > 0);
    // `begin()` places a newly active record before retained terminal records;
    // after terminalization this array is newest-first. Retain the newest exact
    // correlations and fold the oldest into bounded per-thread debt.
    const retainedDebt = debt.slice(0, MAX_RECONCILABLE_DEBT_RESERVATIONS);
    const foldedDebt = debt.slice(MAX_RECONCILABLE_DEBT_RESERVATIONS);
    for (const reservation of foldedDebt)
        foldReservationDebtIntoThread(state, reservation);
    const protectedRecords = [...active, ...retainedDebt];
    const terminal = state.reservations.filter((reservation) => isTerminal(reservation.state) && reservation.estimatedDebtTokens === 0);
    state.reservations = [...protectedRecords, ...terminal.slice(-Math.max(0, MAX_RESERVATIONS - protectedRecords.length))];
}
function foldReservationDebtIntoThread(state, reservation) {
    const debt = reservation.estimatedDebtTokens;
    if (debt === 0)
        return;
    if (reservation.threadId === null) {
        state.accounts[reservation.opaqueAccountId].irreconcilableDebtTokens = safeAdd(state.accounts[reservation.opaqueAccountId].irreconcilableDebtTokens, debt);
        return;
    }
    const key = threadKey(reservation.opaqueAccountId, reservation.threadId);
    let counter = state.threads[key];
    if (!counter) {
        makeThreadRoom(state);
        counter = counterForUnreportedDebt(reservation.opaqueAccountId, reservation.threadId, reservation.settledAt ?? reservation.createdAt);
        state.threads[key] = counter;
    }
    counter.unreportedDebtTokens = safeAdd(counter.unreportedDebtTokens, debt);
}
function activeReservationCount(state) {
    return state.reservations.filter((reservation) => !isTerminal(reservation.state)).length;
}
function isTerminal(state) {
    return state === "settled" || state === "released_pre_dispatch";
}
function reservedTokensFor(state, opaqueAccountId) {
    return state.reservations
        .filter((reservation) => reservation.opaqueAccountId === opaqueAccountId && !isTerminal(reservation.state))
        .reduce((sum, reservation) => safeAdd(sum, reservation.estimatedTokens), 0);
}
function precisionFor(state, opaqueAccountId) {
    const account = state.accounts[opaqueAccountId];
    if (!account)
        return "unknown";
    if (state.baseline.importedHistoryUnmeasuredAccounts.includes(opaqueAccountId))
        return "unknown";
    if (account.unknownUsageCount > 0)
        return "unknown";
    if (account.partialObservationCount > 0)
        return "partial";
    return "exact";
}
function safeAdd(left, right) {
    const value = left + right;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("token-balance counter overflow");
    return value;
}
function validEstimate(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ESTIMATED_TOKENS;
}
function validatedAccounts(accounts) {
    const result = new Map();
    for (const account of accounts) {
        if (!(0, types_1.isOpaqueAccountId)(account.opaqueAccountId) || typeof account.included !== "boolean" || result.has(account.opaqueAccountId)) {
            throw new Error("invalid or duplicate token-balance account");
        }
        result.set(account.opaqueAccountId, { opaqueAccountId: account.opaqueAccountId, included: account.included });
    }
    return result;
}
function threadKey(opaqueAccountId, threadId) {
    return (0, node_crypto_1.createHash)("sha256").update(`${opaqueAccountId}\u0000${threadId}`, "utf8").digest("base64url");
}
function safeIdentifier(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeFileName(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
}
function validTimestamp(value) {
    return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function validCounter(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validateState(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).some((key) => !["version", "baseline", "accounts", "reservations", "threads", "counters"].includes(key)))
        return false;
    const baseline = value.baseline;
    const accounts = value.accounts;
    const reservations = value.reservations;
    const threads = value.threads;
    const counters = value.counters;
    if (value.version !== TOKEN_BALANCE_VERSION || !(0, types_1.isPlainRecord)(baseline)
        || Object.keys(baseline).sort().join("\0") !== ["importedHistoryUnmeasuredAccounts", "startedAt"].join("\0")
        || !validTimestamp(baseline.startedAt)
        || !Array.isArray(baseline.importedHistoryUnmeasuredAccounts)
        || baseline.importedHistoryUnmeasuredAccounts.length > 512
        || baseline.importedHistoryUnmeasuredAccounts.some((account) => !(0, types_1.isOpaqueAccountId)(account))
        || new Set(baseline.importedHistoryUnmeasuredAccounts).size !== baseline.importedHistoryUnmeasuredAccounts.length
        || baseline.importedHistoryUnmeasuredAccounts.join("\0") !== [...baseline.importedHistoryUnmeasuredAccounts].sort().join("\0")
        || !(0, types_1.isPlainRecord)(accounts) || !Array.isArray(reservations) || !(0, types_1.isPlainRecord)(threads) || !(0, types_1.isPlainRecord)(counters))
        return false;
    const accountIds = Object.keys(accounts);
    if (accountIds.some((id) => !(0, types_1.isOpaqueAccountId)(id) || !validateAccount(accounts[id])))
        return false;
    if (accountIds.length > 512 || reservations.length > MAX_RESERVATIONS || Object.keys(threads).length > MAX_THREAD_COUNTERS)
        return false;
    const accountSet = new Set(accountIds);
    if (!reservations.every((reservation) => validateReservation(reservation, accountSet)))
        return false;
    if (reservations.filter((reservation) => !isTerminal(reservation.state)).length > MAX_ACTIVE_RESERVATIONS)
        return false;
    if (!Object.values(threads).every((counter) => validateThread(counter, accountSet)))
        return false;
    const allowedCounters = new Set(["lastOnlyCount", "outOfOrderTotalCount", "evictedThreadCount"]);
    return Object.keys(counters).every((key) => allowedCounters.has(key))
        && validCounter(counters.lastOnlyCount) && validCounter(counters.outOfOrderTotalCount) && validCounter(counters.evictedThreadCount);
}
/** Upgrade the original v1 baseline shape without relaxing its other checks. */
function normalizeLegacyBaseline(value) {
    if (!(0, types_1.isPlainRecord)(value) || !(0, types_1.isPlainRecord)(value.baseline))
        return null;
    const baseline = value.baseline;
    if (Object.keys(baseline).length !== 1 || !Object.prototype.hasOwnProperty.call(baseline, "startedAt")) {
        return value;
    }
    return {
        ...value,
        baseline: {
            startedAt: baseline.startedAt,
            importedHistoryUnmeasuredAccounts: [],
        },
    };
}
function validateAccount(value) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    const keys = ["completedTokens", "completedInputTokens", "completedOutputTokens", "completedAggregateTokens", "estimatedCompletedTokens", "irreconcilableDebtTokens", "partialObservationCount", "unknownUsageCount"];
    if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value && validCounter(value[key])))
        return false;
    const { completedTokens, completedInputTokens, completedOutputTokens, completedAggregateTokens, estimatedCompletedTokens, irreconcilableDebtTokens } = value;
    return validCounter(completedTokens) && validCounter(completedInputTokens) && validCounter(completedOutputTokens) && validCounter(completedAggregateTokens)
        && validCounter(estimatedCompletedTokens) && validCounter(irreconcilableDebtTokens) && irreconcilableDebtTokens <= estimatedCompletedTokens
        && completedTokens === completedInputTokens + completedOutputTokens + completedAggregateTokens;
}
function validateReservation(value, accounts) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    const keys = ["reservationId", "opaqueAccountId", "estimatedTokens", "state", "threadId", "turnId", "createdAt", "dispatchedAt", "settledAt", "observedTokens", "observedUsage", "exactUsageObserved", "hasUnknownUsage", "estimatedDebtTokens", "missingUsage"];
    if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value))
        return false;
    return safeIdentifier(value.reservationId, 128) && (0, types_1.isOpaqueAccountId)(value.opaqueAccountId) && accounts.has(value.opaqueAccountId)
        && validEstimate(value.estimatedTokens) && ["reserved", "dispatched", "observed", "settled", "released_pre_dispatch", "uncertain_after_restart"].includes(String(value.state))
        && (value.threadId === null || safeIdentifier(value.threadId, MAX_IDENTIFIER_LENGTH))
        && (value.turnId === null || safeIdentifier(value.turnId, MAX_IDENTIFIER_LENGTH))
        && validTimestamp(value.createdAt) && (value.dispatchedAt === null || validTimestamp(value.dispatchedAt))
        && (value.settledAt === null || validTimestamp(value.settledAt)) && validCounter(value.observedTokens) && validCounter(value.estimatedDebtTokens)
        && typeof value.observedUsage === "boolean" && typeof value.exactUsageObserved === "boolean" && typeof value.hasUnknownUsage === "boolean" && typeof value.missingUsage === "boolean";
}
function validateThread(value, accounts) {
    if (!(0, types_1.isPlainRecord)(value))
        return false;
    const keys = ["opaqueAccountId", "threadId", "basis", "inputTokens", "outputTokens", "aggregateTokens", "priorTotalUnknown", "lastOnlyCount", "outOfOrderTotalCount", "unreportedDebtTokens", "lastObservedAt"];
    if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value))
        return false;
    const validOptionalCounter = (candidate) => candidate === null || validCounter(candidate);
    if (!(0, types_1.isOpaqueAccountId)(value.opaqueAccountId) || !accounts.has(value.opaqueAccountId) || !safeIdentifier(value.threadId, MAX_IDENTIFIER_LENGTH)
        || !["components", "aggregate", "partial", "uninitialized"].includes(String(value.basis))
        || !validOptionalCounter(value.inputTokens) || !validOptionalCounter(value.outputTokens) || !validOptionalCounter(value.aggregateTokens)
        || typeof value.priorTotalUnknown !== "boolean" || !validCounter(value.lastOnlyCount) || !validCounter(value.outOfOrderTotalCount) || !validCounter(value.unreportedDebtTokens) || !validTimestamp(value.lastObservedAt))
        return false;
    if (value.basis === "uninitialized")
        return value.inputTokens === null && value.outputTokens === null && value.aggregateTokens === null;
    if (value.basis === "components")
        return value.inputTokens !== null && value.outputTokens !== null && value.aggregateTokens === null;
    if (value.basis === "aggregate")
        return value.inputTokens === null && value.outputTokens === null && value.aggregateTokens !== null;
    return value.aggregateTokens === null && (value.inputTokens !== null || value.outputTokens !== null);
}
//# sourceMappingURL=token-balance.js.map
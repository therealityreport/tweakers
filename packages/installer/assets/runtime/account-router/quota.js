"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTING_RESET_BONUS_CREDIT_CAP = exports.ROUTING_RESET_BONUS_PER_CREDIT = exports.ROUTING_FALLBACK_WINDOW_MS = exports.ROUTING_MINIMUM_WINDOW_MS = exports.QUOTA_STALE_AFTER_MS = void 0;
exports.emptyQuotaObservation = emptyQuotaObservation;
exports.parseAccountRead = parseAccountRead;
exports.parseRateLimitsRead = parseRateLimitsRead;
exports.quotaFreshness = quotaFreshness;
exports.accountObservationEligible = accountObservationEligible;
exports.quotaUrgencyScore = quotaUrgencyScore;
exports.compareQuotaCandidates = compareQuotaCandidates;
exports.hasConfirmedQuotaDepletion = hasConfirmedQuotaDepletion;
const types_1 = require("./types");
/** Provider readings older than two minutes are never capacity evidence. */
exports.QUOTA_STALE_AFTER_MS = 2 * 60 * 1_000;
function emptyQuotaObservation() {
    return {
        health: "unhealthy",
        plan: null,
        observedAt: null,
        weeklyRemainingPercent: null,
        weeklyResetAt: null,
        shortWindowPressure: null,
        shortWindowResetAt: null,
        rateLimitReached: false,
        resetCredits: null,
    };
}
/**
 * `account/read` is only trusted after a successful reply from that child. We
 * retain no provider identifier: the caller keeps only health and a safe plan
 * name for the redacted local status projection.
 */
function parseAccountRead(result, now) {
    if (!(0, types_1.isPlainRecord)(result))
        return null;
    // A successful envelope without its explicit official account object is not
    // proof of authentication. In particular, never fall back from
    // `{ account: null }` to unrelated result metadata.
    if (!(0, types_1.isPlainRecord)(result.account))
        return { health: "reauth_required", plan: null, observedAt: now };
    const account = result.account;
    const disabled = account.disabled === true || account.enabled === false || result.disabled === true || result.enabled === false;
    const authenticated = account.authenticated ?? account.isAuthenticated ?? result.authenticated ?? result.isAuthenticated;
    const status = typeof account.status === "string" ? account.status.toLowerCase() : typeof result.status === "string" ? result.status.toLowerCase() : "";
    const health = disabled ? "disabled"
        : authenticated === false || status === "unauthenticated" || status === "signed_out" ? "reauth_required"
            : "authenticated";
    return { health, plan: safePlan(account, result), observedAt: now };
}
/**
 * Read only documented app-server rate-limit shapes. The walker supports the
 * known keyed and list forms without retaining any unrecognized provider data.
 */
function parseRateLimitsRead(result, now) {
    if (!(0, types_1.isPlainRecord)(result))
        return null;
    const bucket = codexRateLimitBucket(result);
    if (!bucket)
        return null;
    const windows = collectWindows(bucket.value);
    const weekly = windows
        .filter((window) => window.durationMinutes === 10_080 && window.remainingPercent !== null && window.resetAt !== null)
        .sort((left, right) => left.pathKey.localeCompare(right.pathKey))[0];
    if (!weekly)
        return null;
    // The five-hour (300-minute) window is the only supported short-pressure
    // tiebreaker. Monthly or arbitrary longer buckets must never affect it.
    const short = windows
        .filter((window) => window.durationMinutes === 300 && window.remainingPercent !== null)
        .sort((left, right) => (left.remainingPercent - right.remainingPercent) || left.pathKey.localeCompare(right.pathKey))[0];
    return {
        weeklyRemainingPercent: weekly.remainingPercent,
        weeklyResetAt: weekly.resetAt,
        shortWindowPressure: short ? 100 - short.remainingPercent : null,
        shortWindowResetAt: short?.resetAt ?? null,
        rateLimitReached: bucket.rateLimitReached,
        observedAt: now,
        resetCredits: resetCreditsFrom(result),
    };
}
function quotaFreshness(observation, now) {
    if (observation.observedAt === null || observation.weeklyRemainingPercent === null || observation.weeklyResetAt === null)
        return "unknown";
    if (observation.observedAt > now || now - observation.observedAt > exports.QUOTA_STALE_AFTER_MS)
        return "stale";
    return "fresh";
}
function accountObservationEligible(observation, now) {
    return observation.health === "authenticated"
        && quotaFreshness(observation, now) === "fresh"
        && observation.weeklyRemainingPercent !== null
        && observation.weeklyRemainingPercent > 0
        && observation.weeklyResetAt !== null
        && observation.weeklyResetAt > now
        && observation.rateLimitReached !== true
        // An exact zero in the currently-unreset five-hour window is not capacity.
        // A missing reset never becomes an invented zero; it remains an unknown
        // tiebreaker, preserving compatibility with older provider readings.
        && !(observation.shortWindowPressure === 100
            && (observation.shortWindowResetAt === null || observation.shortWindowResetAt === undefined || observation.shortWindowResetAt > now));
}
// Ported from braindead-dev/codex-subscription-router a1d3e02,
// internal/mux/accounts.go. See docs/accounts-upstream-LICENSE.txt.
exports.ROUTING_MINIMUM_WINDOW_MS = 60_000;
exports.ROUTING_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60_000;
exports.ROUTING_RESET_BONUS_PER_CREDIT = 0.15;
exports.ROUTING_RESET_BONUS_CREDIT_CAP = 3;
function quotaUrgencyScore(candidate, now) {
    const remaining = Math.max(0, Math.min(100, candidate.weeklyRemainingPercent));
    const untilReset = candidate.weeklyResetAt - now;
    const horizon = Math.max(exports.ROUTING_MINIMUM_WINDOW_MS, untilReset > 0 ? untilReset : exports.ROUTING_FALLBACK_WINDOW_MS);
    const credits = Math.min(exports.ROUTING_RESET_BONUS_CREDIT_CAP, Math.max(0, candidate.resetCredits ?? 0));
    return remaining / (horizon / 3_600_000) * (1 + credits * exports.ROUTING_RESET_BONUS_PER_CREDIT);
}
/** Upstream urgency and stable tie-breaks, after fresh capacity eligibility. */
function compareQuotaCandidates(left, right, now) {
    const leftScore = quotaUrgencyScore(left, now);
    const rightScore = quotaUrgencyScore(right, now);
    if (Math.abs(leftScore - rightScore) > 0.000001)
        return rightScore - leftScore;
    const leftPressure = left.shortWindowPressure ?? 1_000;
    const rightPressure = right.shortWindowPressure ?? 1_000;
    if (Math.abs(leftPressure - rightPressure) > 0.001)
        return leftPressure - rightPressure;
    if (Math.abs(left.weeklyRemainingPercent - right.weeklyRemainingPercent) > 0.001)
        return right.weeklyRemainingPercent - left.weeklyRemainingPercent;
    if (left.assignedThreadCount !== right.assignedThreadCount)
        return left.assignedThreadCount - right.assignedThreadCount;
    return left.configuredIndex - right.configuredIndex;
}
function resetCreditsFrom(value) {
    if ((0, types_1.isPlainRecord)(value.rateLimitResetCredits)) {
        const documented = value.rateLimitResetCredits.availableCount;
        // The documented aggregate is authoritative; detail rows may be capped.
        return isResetCreditCount(documented) ? documented : null;
    }
    const candidates = [
        value.rateLimitResetCredits,
        value.resetCredits,
        (0, types_1.isPlainRecord)(value.credits) ? value.credits.available : null,
        (0, types_1.isPlainRecord)(value.rateLimits) ? value.rateLimits.resetCredits : null,
    ];
    const found = candidates.find(isResetCreditCount);
    return typeof found === "number" ? found : null;
}
function isResetCreditCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}
/**
 * The multi-bucket response is keyed by the metered `limitId`. Select only the
 * documented Codex bucket; other model/product buckets must not be combined
 * with it. Older single-bucket fixtures without a limit identifier remain
 * supported only when no multi-bucket response was supplied.
 */
function codexRateLimitBucket(result) {
    const byLimitId = result.rateLimitsByLimitId;
    if ((0, types_1.isPlainRecord)(byLimitId)) {
        const codex = byLimitId.codex;
        if ((0, types_1.isPlainRecord)(codex) && (codex.limitId === undefined || codex.limitId === "codex"))
            return bucket(codex);
    }
    const legacy = result.rateLimits;
    if (!(0, types_1.isPlainRecord)(legacy))
        return null;
    if (legacy.limitId === "codex")
        return bucket(legacy);
    if (legacy.limitId !== undefined || (0, types_1.isPlainRecord)(byLimitId))
        return null;
    return bucket(legacy);
}
function bucket(value) {
    return {
        value,
        rateLimitReached: value.rateLimitReachedType !== null && value.rateLimitReachedType !== undefined,
    };
}
function collectWindows(value) {
    const result = [];
    if (!(0, types_1.isPlainRecord)(value))
        return result;
    const root = parseWindow(value, []);
    if (root)
        result.push(root);
    // App-server exposes primary and secondary directly on a selected bucket.
    // Supporting other direct legacy window names keeps old fixtures working
    // while intentionally refusing nested model/product bucket collections.
    for (const [key, child] of Object.entries(value)) {
        if (result.length >= 16 || !(0, types_1.isPlainRecord)(child))
            continue;
        const window = parseWindow(child, [key]);
        if (window)
            result.push(window);
    }
    return result;
}
function parseWindow(value, path) {
    const remainingPercent = percentFrom(value);
    const resetAt = resetAtFrom(value);
    if (remainingPercent === null && resetAt === null)
        return null;
    const minutes = value.windowDurationMins ?? value.windowDurationMinutes ?? value.durationMinutes;
    const numericMinutes = typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
    const durationMinutes = numericMinutes ?? (path.some((segment) => /(?:week|7d|seven.day)/i.test(segment)) ? 10_080 : 0);
    return { weekly: durationMinutes === 10_080, remainingPercent, resetAt, durationMinutes, pathKey: path.join("\u0000") };
}
function percentFrom(value) {
    const direct = [value.remainingPercent, value.remainingPercentage, value.percentRemaining]
        .find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    if (direct !== undefined)
        return percent(direct);
    if (typeof value.remaining === "number" && typeof value.limit === "number" && value.limit > 0)
        return percent(value.remaining / value.limit * 100);
    if (typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent))
        return percent(100 - value.usedPercent);
    return null;
}
function resetAtFrom(value) {
    const candidate = value.resetAt ?? value.resetsAt ?? value.resetTime ?? value.resetAtMs ?? value.resetAtUnix;
    if (typeof candidate === "string") {
        const parsed = Date.parse(candidate);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0)
        return null;
    return candidate < 10_000_000_000 ? candidate * 1_000 : candidate;
}
function percent(value) {
    return value >= 0 && value <= 100 ? value : null;
}
function safePlan(...records) {
    for (const record of records) {
        for (const key of ["plan", "planType", "planName", "subscriptionPlan"]) {
            const value = record[key];
            if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(value))
                return value;
        }
        if ((0, types_1.isPlainRecord)(record.subscription)) {
            const nested = safePlan(record.subscription);
            if (nested)
                return nested;
        }
    }
    return null;
}
/** Missing/stale capacity is not evidence that an existing subscription is depleted. */
function hasConfirmedQuotaDepletion(quota, now = Date.now()) {
    if (!quota || quota.freshness !== "fresh" || typeof quota.observedAt !== "number"
        || !Number.isFinite(quota.observedAt) || quota.observedAt > now || now - quota.observedAt > exports.QUOTA_STALE_AFTER_MS)
        return false;
    return (quota.remainingPercent === 0 && quota.resetAt !== null && Date.parse(quota.resetAt) > now)
        || (quota.shortWindowPressure === 100 && typeof quota.shortWindowResetAt === "number" && quota.shortWindowResetAt > now)
        || (quota.rateLimitReached === true && quota.resetAt !== null && Date.parse(quota.resetAt) > now);
}
//# sourceMappingURL=quota.js.map
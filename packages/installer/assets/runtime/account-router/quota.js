"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUOTA_STALE_AFTER_MS = void 0;
exports.emptyQuotaObservation = emptyQuotaObservation;
exports.parseAccountRead = parseAccountRead;
exports.parseRateLimitsRead = parseRateLimitsRead;
exports.quotaFreshness = quotaFreshness;
exports.accountObservationEligible = accountObservationEligible;
exports.compareQuotaCandidates = compareQuotaCandidates;
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
    const windows = collectWindows(result);
    const weekly = windows
        .filter((window) => window.weekly && window.durationMinutes === 10_080 && window.remainingPercent !== null && window.resetAt !== null)
        .sort((left, right) => left.pathKey.localeCompare(right.pathKey))[0];
    if (!weekly)
        return null;
    // The five-hour (300-minute) window is the only supported short-pressure
    // tiebreaker. Monthly or arbitrary longer buckets must never affect it.
    const shortPressures = windows
        .filter((window) => window.durationMinutes === 300 && window.remainingPercent !== null)
        .map((window) => 100 - window.remainingPercent);
    return {
        weeklyRemainingPercent: weekly.remainingPercent,
        weeklyResetAt: weekly.resetAt,
        shortWindowPressure: shortPressures.length ? Math.max(...shortPressures) : null,
        observedAt: now,
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
        && observation.weeklyResetAt > now;
}
/** Higher weekly remaining percentage per remaining reset time wins. */
function compareQuotaCandidates(left, right, now) {
    const leftScore = left.weeklyRemainingPercent / Math.max(1, left.weeklyResetAt - now);
    const rightScore = right.weeklyRemainingPercent / Math.max(1, right.weeklyResetAt - now);
    if (leftScore !== rightScore)
        return rightScore - leftScore;
    const leftPressure = left.shortWindowPressure ?? Number.POSITIVE_INFINITY;
    const rightPressure = right.shortWindowPressure ?? Number.POSITIVE_INFINITY;
    if (leftPressure !== rightPressure)
        return leftPressure - rightPressure;
    if (left.assignedThreadCount !== right.assignedThreadCount)
        return left.assignedThreadCount - right.assignedThreadCount;
    return left.configuredIndex - right.configuredIndex;
}
function collectWindows(value) {
    const result = [];
    const visit = (item, path, depth) => {
        if (depth > 6 || result.length >= 64)
            return;
        if (Array.isArray(item)) {
            for (const child of item)
                visit(child, path, depth + 1);
            return;
        }
        if (!(0, types_1.isPlainRecord)(item))
            return;
        const window = parseWindow(item, path);
        if (window)
            result.push(window);
        for (const [key, child] of Object.entries(item)) {
            if (typeof child === "object" && child !== null)
                visit(child, [...path, key], depth + 1);
        }
    };
    visit(value, [], 0);
    return result;
}
function parseWindow(value, path) {
    const remainingPercent = percentFrom(value);
    const resetAt = resetAtFrom(value);
    if (remainingPercent === null && resetAt === null)
        return null;
    const descriptive = [
        ...path,
        value.window, value.windowName, value.name, value.key, value.limitName, value.duration,
    ].filter((item) => typeof item === "string").join(" ").toLowerCase();
    const minutes = value.windowDurationMins ?? value.windowDurationMinutes ?? value.durationMinutes;
    const numericMinutes = typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
    const weekly = /(?:week|7d|seven.day)/.test(descriptive)
        || numericMinutes === 10_080;
    const durationMinutes = numericMinutes ?? (weekly ? 10_080 : 0);
    return { weekly, remainingPercent, resetAt, durationMinutes, pathKey: path.join("\u0000") };
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
//# sourceMappingURL=quota.js.map
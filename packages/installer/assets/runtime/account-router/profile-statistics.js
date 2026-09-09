"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeProfileStatisticsV1 = void 0;
exports.isNativeProfileStatisticsResultV1 = isNativeProfileStatisticsResultV1;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const types_1 = require("./types");
const PROFILE_STATISTICS_ENDPOINT = "https://chatgpt.com/backend-api/wham/profiles/me";
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_ACCOUNTS = 64;
const MAX_PARALLEL_FETCHES = 4;
const MAX_USAGE_BUCKETS = 4_096;
const MAX_PROVIDER_INVOCATIONS = 512;
const MAX_TOP_INVOCATIONS = 5;
const MAX_DISPLAY_LABEL_LENGTH = 80;
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1_000;
/**
 * Reads the fixed native profile statistics endpoint from verified account
 * homes. Only already-sanitized statistics are retained, and only in memory.
 */
class NativeProfileStatisticsV1 {
    secret;
    accounts;
    fetcher;
    cache = new Map();
    constructor(options) {
        if (!Buffer.isBuffer(options?.secret) || options.secret.byteLength !== 32 || typeof options.accounts !== "function") {
            throw new Error("invalid native profile statistics options");
        }
        this.secret = Buffer.from(options.secret);
        this.accounts = options.accounts;
        this.fetcher = options.fetch ?? defaultProfileStatisticsFetch;
    }
    async read(selection) {
        if (selection !== "pooled" && !(0, types_1.isOpaqueAccountId)(selection))
            throw new Error("invalid profile statistics selection");
        const observedAt = Date.now();
        const accounts = this.snapshotAccounts();
        if (accounts === null) {
            if (selection !== "pooled")
                throw new Error("profile statistics account configuration is unavailable");
            return { selection, partial: true, accounts: [], stats: null, observedAt };
        }
        if (selection !== "pooled" && !accounts.some((account) => account.accountId === selection)) {
            throw new Error("profile statistics account is unavailable");
        }
        const enabled = accounts.filter((account) => account.enabled);
        const targets = selection === "pooled" ? enabled : enabled.filter((account) => account.accountId === selection);
        const readings = await mapBounded(targets, MAX_PARALLEL_FETCHES, async (account) => ({
            accountId: account.accountId,
            stats: await this.readAccount(account, observedAt),
        }));
        const byAccount = new Map(readings.map((reading) => [reading.accountId, reading.stats]));
        const rows = accounts.map((account) => {
            const stats = account.enabled ? byAccount.get(account.accountId) ?? this.cachedStats(account.accountId, observedAt) : null;
            return { accountId: account.accountId, state: stats ? "ready" : "unavailable", stats };
        });
        const ready = rows.flatMap((row) => row.stats ? [row.stats] : []);
        const selected = selection === "pooled"
            ? combineSafeStats(ready, observedAt)
            : rows.find((row) => row.accountId === selection)?.stats ?? null;
        const partial = selection === "pooled"
            ? selected === null || ready.length !== enabled.length
            : selected === null;
        return {
            selection,
            partial,
            accounts: rows.map((row) => ({ ...row, stats: row.stats ? cloneSafeStats(row.stats) : null })),
            stats: selected ? cloneSafeStats(selected) : null,
            observedAt,
        };
    }
    snapshotAccounts() {
        let supplied;
        try {
            supplied = this.accounts();
        }
        catch {
            return null;
        }
        if (!Array.isArray(supplied) || supplied.length > MAX_ACCOUNTS)
            return null;
        const accountIds = new Set();
        const result = [];
        for (const account of supplied) {
            if (!(0, types_1.isPlainRecord)(account) || !(0, types_1.isOpaqueAccountId)(account.accountId) || accountIds.has(account.accountId)
                || typeof account.codexHome !== "string" || account.codexHome.length < 1 || account.codexHome.length > 4_096
                || account.codexHome.includes("\0") || !(0, node_path_1.isAbsolute)(account.codexHome) || typeof account.enabled !== "boolean")
                return null;
            accountIds.add(account.accountId);
            result.push({ accountId: account.accountId, codexHome: account.codexHome, enabled: account.enabled });
        }
        return result;
    }
    async readAccount(account, now) {
        const cached = this.cachedStats(account.accountId, now);
        if (cached)
            return cached;
        const stats = await this.fetchAccountStats(account);
        if (!stats)
            return null;
        this.cache.set(account.accountId, { stats: cloneSafeStats(stats), expiresAt: now + CACHE_TTL_MS });
        return stats;
    }
    cachedStats(accountId, now) {
        const cached = this.cache.get(accountId);
        return cached && cached.expiresAt > now ? cloneSafeStats(cached.stats) : null;
    }
    async fetchAccountStats(account) {
        const auth = readOwnerPrivateProfileAuth(account.codexHome);
        if (!auth || !matchesOpaqueAccountId(auth.accountId, account.accountId, this.secret))
            return null;
        const controller = new AbortController();
        let timer = null;
        const deadline = new Promise((_resolvePromise, rejectPromise) => {
            timer = setTimeout(() => {
                controller.abort();
                rejectPromise(new Error("profile statistics request timed out"));
            }, REQUEST_TIMEOUT_MS);
            timer.unref?.();
        });
        try {
            return await Promise.race([this.fetchAndSanitize(auth, controller.signal), deadline]);
        }
        catch {
            return null;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    async fetchAndSanitize(auth, signal) {
        const response = await this.fetcher(PROFILE_STATISTICS_ENDPOINT, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "ChatGPT-Account-ID": auth.accountId,
            },
            signal,
            redirect: "error",
        });
        if (response.status !== 200 || response.redirected === true
            || typeof response.url === "string" && response.url.length > 0 && response.url !== PROFILE_STATISTICS_ENDPOINT) {
            void response.body?.cancel().catch(() => undefined);
            return null;
        }
        const bytes = await readBoundedResponseBody(response.body, MAX_RESPONSE_BYTES);
        if (!bytes)
            return null;
        try {
            return sanitizeProfileStatisticsResponse(JSON.parse(bytes.toString("utf8")));
        }
        catch {
            return null;
        }
        finally {
            bytes.fill(0);
        }
    }
}
exports.NativeProfileStatisticsV1 = NativeProfileStatisticsV1;
/** Strictly validates the public, sanitized statistics result before it crosses a broker seam. */
function isNativeProfileStatisticsResultV1(value) {
    if (!(0, types_1.isPlainRecord)(value) || !hasExactKeys(value, ["accounts", "observedAt", "partial", "selection", "stats"])
        || (value.selection !== "pooled" && !(0, types_1.isOpaqueAccountId)(value.selection)) || typeof value.partial !== "boolean"
        || !isNonnegativeSafeInteger(value.observedAt) || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS
        || !isSafeStats(value.stats))
        return false;
    const accountIds = new Set();
    const rows = [];
    for (const account of value.accounts) {
        if (!(0, types_1.isPlainRecord)(account) || !hasExactKeys(account, ["accountId", "state", "stats"])
            || !(0, types_1.isOpaqueAccountId)(account.accountId) || accountIds.has(account.accountId)
            || (account.state !== "ready" && account.state !== "unavailable")
            || !isSafeStats(account.stats) || (account.state === "ready") !== (account.stats !== null))
            return false;
        accountIds.add(account.accountId);
        rows.push({ accountId: account.accountId, state: account.state, stats: account.stats });
    }
    if (value.selection === "pooled") {
        return sameSafeStats(combineSafeStats(rows.flatMap((row) => row.stats ? [row.stats] : []), value.observedAt), value.stats)
            && (value.stats !== null || value.partial);
    }
    const selected = rows.find((row) => row.accountId === value.selection);
    return selected !== undefined && sameSafeStats(selected.stats, value.stats) && (value.stats !== null || value.partial);
}
async function defaultProfileStatisticsFetch(url, init) {
    return globalThis.fetch(url, {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        redirect: init.redirect,
    });
}
/** Mirrors the established bounded, no-follow owner-private auth read pattern. */
function readOwnerPrivateProfileAuth(codexHome) {
    const bytes = readOwnerPrivateRegularFile((0, node_path_1.join)(codexHome, "auth.json"), MAX_AUTH_BYTES);
    try {
        if (!bytes)
            return null;
        const parsed = JSON.parse(bytes.toString("utf8"));
        if (!(0, types_1.isPlainRecord)(parsed) || !(0, types_1.isPlainRecord)(parsed.tokens))
            return null;
        const accountId = parsed.tokens.account_id;
        const accessToken = parsed.tokens.access_token;
        if (!isSafeHeaderValue(accountId, 1_024) || !isSafeBearerToken(accessToken))
            return null;
        return { accountId, accessToken };
    }
    catch {
        return null;
    }
    finally {
        bytes?.fill(0);
    }
}
function readOwnerPrivateRegularFile(path, maxBytes) {
    let descriptor;
    let bytes = null;
    let accepted = false;
    try {
        descriptor = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
        const before = (0, node_fs_1.fstatSync)(descriptor);
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
            || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > maxBytes)
            return null;
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const count = (0, node_fs_1.readSync)(descriptor, bytes, offset, bytes.byteLength - offset, offset);
            if (!count)
                return null;
            offset += count;
        }
        const after = (0, node_fs_1.fstatSync)(descriptor);
        const current = (0, node_fs_1.lstatSync)(path);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
            || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink())
            return null;
        accepted = true;
        return bytes;
    }
    catch {
        return null;
    }
    finally {
        if (descriptor !== undefined)
            (0, node_fs_1.closeSync)(descriptor);
        if (bytes && !accepted)
            bytes.fill(0);
    }
}
function matchesOpaqueAccountId(rawAccountId, opaqueAccountId, secret) {
    let expected = null;
    let actual = null;
    try {
        expected = Buffer.from(`ar_${(0, node_crypto_1.createHmac)("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}`, "utf8");
        actual = Buffer.from(opaqueAccountId, "utf8");
        return expected.byteLength === actual.byteLength && (0, node_crypto_1.timingSafeEqual)(expected, actual);
    }
    catch {
        return false;
    }
    finally {
        expected?.fill(0);
        actual?.fill(0);
    }
}
async function readBoundedResponseBody(body, maxBytes) {
    if (!body)
        return null;
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let accepted = false;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            const chunk = Buffer.from(next.value);
            if (chunk.byteLength > maxBytes - total) {
                chunk.fill(0);
                return null;
            }
            chunks.push(chunk);
            total += chunk.byteLength;
        }
        const combined = Buffer.concat(chunks, total);
        for (const chunk of chunks)
            chunk.fill(0);
        accepted = true;
        return combined;
    }
    catch {
        return null;
    }
    finally {
        if (!accepted) {
            for (const chunk of chunks)
                chunk.fill(0);
            void reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }
}
function sanitizeProfileStatisticsResponse(value) {
    if (!(0, types_1.isPlainRecord)(value) || !(0, types_1.isPlainRecord)(value.stats))
        return null;
    const stats = value.stats;
    const lifetimeTokens = nonnegativeCount(stats.lifetime_tokens);
    const peakDailyTokens = nonnegativeCount(stats.peak_daily_tokens);
    const currentStreakDays = nonnegativeCount(stats.current_streak_days);
    const longestStreakDays = nonnegativeCount(stats.longest_streak_days);
    const totalThreads = nonnegativeCount(stats.total_threads);
    const longestRunningTurnSec = nonnegativeCount(stats.longest_running_turn_sec);
    const fastModeUsagePercentage = percentage(stats.fast_mode_usage_percentage);
    const totalSkillsUsed = nonnegativeCount(stats.total_skills_used);
    const uniqueSkillsUsed = nonnegativeCount(stats.unique_skills_used);
    const mostUsedReasoningEffortPercentage = percentage(stats.most_used_reasoning_effort_percentage);
    const dailyUsageBuckets = sanitizeDailyUsageBuckets(stats.daily_usage_buckets);
    const topInvocations = sanitizeTopInvocations(stats.top_invocations);
    if (lifetimeTokens === null || peakDailyTokens === null || currentStreakDays === null || longestStreakDays === null
        || totalThreads === null || longestRunningTurnSec === null || fastModeUsagePercentage === null || totalSkillsUsed === null
        || uniqueSkillsUsed === null || mostUsedReasoningEffortPercentage === null || dailyUsageBuckets === null || topInvocations === null)
        return null;
    const activity = deriveActivityBuckets(dailyUsageBuckets);
    if (!activity)
        return null;
    const mostUsedReasoningEffort = safeReasoningEffort(stats.most_used_reasoning_effort);
    return {
        lifetimeTokens,
        peakDailyTokens,
        currentStreakDays,
        longestStreakDays,
        totalThreads,
        longestRunningTurnSec,
        fastModeUsagePercentage,
        totalSkillsUsed,
        uniqueSkillsUsed,
        mostUsedReasoningEffort,
        mostUsedReasoningEffortPercentage: mostUsedReasoningEffort ? mostUsedReasoningEffortPercentage : 0,
        dailyUsageBuckets,
        cumulativeDailyUsageBuckets: activity.cumulative,
        weeklyUsageBuckets: activity.weekly,
        topInvocations,
    };
}
function sanitizeDailyUsageBuckets(value) {
    if (!Array.isArray(value) || value.length > MAX_USAGE_BUCKETS)
        return null;
    const merged = new Map();
    for (const item of value) {
        if (!(0, types_1.isPlainRecord)(item) || !isSafeDate(item.start_date))
            return null;
        const tokens = nonnegativeCount(item.tokens);
        if (tokens === null)
            return null;
        const next = safeAdd(merged.get(item.start_date) ?? 0, tokens);
        if (next === null)
            return null;
        merged.set(item.start_date, next);
    }
    return [...merged.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([startDate, tokens]) => ({ startDate, tokens }));
}
function sanitizeTopInvocations(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value) || value.length > MAX_PROVIDER_INVOCATIONS)
        return null;
    const merged = new Map();
    for (const item of value) {
        if (!(0, types_1.isPlainRecord)(item))
            return null;
        const usageCount = nonnegativeCount(item.usage_count);
        if (usageCount === null)
            return null;
        const type = item.type === "plugin" ? "plugin" : item.type === "skill" ? "skill" : "other";
        const label = safeInvocationLabel(item, type);
        const key = `${type}\0${label}`;
        const existing = merged.get(key);
        const nextUsageCount = safeAdd(existing?.usageCount ?? 0, usageCount);
        if (nextUsageCount === null)
            return null;
        merged.set(key, { type, label, usageCount: nextUsageCount });
    }
    return [...merged.values()]
        .sort(compareInvocations)
        .slice(0, MAX_TOP_INVOCATIONS);
}
function safeInvocationLabel(value, type) {
    const candidate = type === "plugin" ? value.plugin_name : type === "skill" ? value.skill_name : null;
    return safeDisplayLabel(candidate) ?? (type === "plugin" ? "Plugin" : type === "skill" ? "Skill" : "Other");
}
function safeDisplayLabel(value) {
    if (typeof value !== "string")
        return null;
    const label = value.trim();
    if (label.length < 1 || label.length > MAX_DISPLAY_LABEL_LENGTH
        || !/^[A-Za-z0-9][A-Za-z0-9 .,'&()+_-]*$/.test(label)
        || /(?:bearer|access[ _-]?token|refresh[ _-]?token|secret|password|credential|authorization|cookie)/i.test(label)
        || /^(?:ar|account|device|plugin|skill)_[A-Za-z0-9_-]{16,}$/i.test(label)
        || /^[A-Za-z0-9_-]{32,}$/.test(label))
        return null;
    return label;
}
function deriveActivityBuckets(daily) {
    const cumulative = [];
    const weekly = new Map();
    let total = 0;
    for (const bucket of daily) {
        const nextTotal = safeAdd(total, bucket.tokens);
        if (nextTotal === null)
            return null;
        total = nextTotal;
        cumulative.push({ startDate: bucket.startDate, tokens: nextTotal });
        const week = mondayForDate(bucket.startDate);
        if (!week)
            return null;
        const weeklyTokens = safeAdd(weekly.get(week) ?? 0, bucket.tokens);
        if (weeklyTokens === null)
            return null;
        weekly.set(week, weeklyTokens);
    }
    return {
        cumulative,
        weekly: [...weekly.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([startDate, tokens]) => ({ startDate, tokens })),
    };
}
function combineSafeStats(stats, now) {
    if (stats.length === 0)
        return null;
    let lifetimeTokens = 0;
    let totalThreads = 0;
    let totalSkillsUsed = 0;
    let uniqueSkillsUsed = 0;
    let longestRunningTurnSec = 0;
    const daily = new Map();
    const invocations = new Map();
    for (const current of stats) {
        const nextLifetimeTokens = safeAdd(lifetimeTokens, current.lifetimeTokens);
        const nextTotalThreads = safeAdd(totalThreads, current.totalThreads);
        const nextTotalSkillsUsed = safeAdd(totalSkillsUsed, current.totalSkillsUsed);
        const nextUniqueSkillsUsed = safeAdd(uniqueSkillsUsed, current.uniqueSkillsUsed);
        if (nextLifetimeTokens === null || nextTotalThreads === null || nextTotalSkillsUsed === null || nextUniqueSkillsUsed === null)
            return null;
        lifetimeTokens = nextLifetimeTokens;
        totalThreads = nextTotalThreads;
        totalSkillsUsed = nextTotalSkillsUsed;
        uniqueSkillsUsed = nextUniqueSkillsUsed;
        longestRunningTurnSec = Math.max(longestRunningTurnSec, current.longestRunningTurnSec);
        for (const bucket of current.dailyUsageBuckets) {
            const next = safeAdd(daily.get(bucket.startDate) ?? 0, bucket.tokens);
            if (next === null)
                return null;
            daily.set(bucket.startDate, next);
            if (daily.size > MAX_USAGE_BUCKETS)
                return null;
        }
        for (const invocation of current.topInvocations) {
            const key = `${invocation.type}\0${invocation.label}`;
            const existing = invocations.get(key);
            const usageCount = safeAdd(existing?.usageCount ?? 0, invocation.usageCount);
            if (usageCount === null)
                return null;
            invocations.set(key, { ...invocation, usageCount });
        }
    }
    const dailyUsageBuckets = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([startDate, tokens]) => ({ startDate, tokens }));
    const activity = deriveActivityBuckets(dailyUsageBuckets);
    if (!activity)
        return null;
    const weights = stats.map((current) => current.totalThreads > 0 ? current.totalThreads : 1);
    const totalWeight = weights.reduce((sum, weight) => sum === null ? null : safeAdd(sum, weight), 0);
    if (totalWeight === null || totalWeight <= 0)
        return null;
    let fastModeUsagePercentage = 0;
    const reasoningPercentages = new Map();
    for (let index = 0; index < stats.length; index += 1) {
        const current = stats[index];
        const weight = weights[index] / totalWeight;
        fastModeUsagePercentage += current.fastModeUsagePercentage * weight;
        if (current.mostUsedReasoningEffort) {
            reasoningPercentages.set(current.mostUsedReasoningEffort, (reasoningPercentages.get(current.mostUsedReasoningEffort) ?? 0) + current.mostUsedReasoningEffortPercentage * weight);
        }
    }
    if (!Number.isFinite(fastModeUsagePercentage) || fastModeUsagePercentage < 0 || fastModeUsagePercentage > 100)
        return null;
    let mostUsedReasoningEffort = null;
    let mostUsedReasoningEffortPercentage = 0;
    for (const [effort, currentPercentage] of reasoningPercentages) {
        if (!Number.isFinite(currentPercentage) || currentPercentage < 0 || currentPercentage > 100)
            return null;
        if (currentPercentage > mostUsedReasoningEffortPercentage) {
            mostUsedReasoningEffort = effort;
            mostUsedReasoningEffortPercentage = currentPercentage;
        }
    }
    const { currentStreakDays, longestStreakDays } = activityStreaks(dailyUsageBuckets, now);
    const peakDailyTokens = dailyUsageBuckets.reduce((peak, bucket) => Math.max(peak, bucket.tokens), 0);
    const topInvocations = [...invocations.values()].sort(compareInvocations).slice(0, MAX_TOP_INVOCATIONS);
    return {
        lifetimeTokens,
        peakDailyTokens,
        currentStreakDays,
        longestStreakDays,
        totalThreads,
        longestRunningTurnSec,
        fastModeUsagePercentage,
        totalSkillsUsed,
        uniqueSkillsUsed,
        mostUsedReasoningEffort,
        mostUsedReasoningEffortPercentage,
        dailyUsageBuckets,
        cumulativeDailyUsageBuckets: activity.cumulative,
        weeklyUsageBuckets: activity.weekly,
        topInvocations,
    };
}
function activityStreaks(daily, now) {
    const active = new Set(daily.map((bucket) => bucket.startDate));
    let longestStreakDays = 0;
    let running = 0;
    let previousDay = null;
    for (const bucket of daily) {
        const day = dayNumber(bucket.startDate);
        if (day === null)
            continue;
        running = previousDay !== null && day === previousDay + 1 ? running + 1 : 1;
        longestStreakDays = Math.max(longestStreakDays, running);
        previousDay = day;
    }
    const current = new Date(now);
    const today = formatDateUtc(current);
    if (!today)
        return { currentStreakDays: 0, longestStreakDays };
    let anchor = dayNumber(today);
    if (!active.has(today))
        anchor -= 1;
    let currentStreakDays = 0;
    while (active.has(dateForDayNumber(anchor))) {
        currentStreakDays += 1;
        anchor -= 1;
    }
    return { currentStreakDays, longestStreakDays };
}
function cloneSafeStats(stats) {
    return {
        ...stats,
        dailyUsageBuckets: stats.dailyUsageBuckets.map((bucket) => ({ ...bucket })),
        cumulativeDailyUsageBuckets: stats.cumulativeDailyUsageBuckets.map((bucket) => ({ ...bucket })),
        weeklyUsageBuckets: stats.weeklyUsageBuckets.map((bucket) => ({ ...bucket })),
        topInvocations: stats.topInvocations.map((invocation) => ({ ...invocation })),
    };
}
function isSafeStats(value) {
    if (value === null)
        return true;
    if (!(0, types_1.isPlainRecord)(value) || !hasExactKeys(value, [
        "cumulativeDailyUsageBuckets", "currentStreakDays", "dailyUsageBuckets", "fastModeUsagePercentage", "lifetimeTokens",
        "longestRunningTurnSec", "longestStreakDays", "mostUsedReasoningEffort", "mostUsedReasoningEffortPercentage", "peakDailyTokens",
        "topInvocations", "totalSkillsUsed", "totalThreads", "uniqueSkillsUsed", "weeklyUsageBuckets",
    ]))
        return false;
    if ([value.lifetimeTokens, value.peakDailyTokens, value.currentStreakDays, value.longestStreakDays, value.totalThreads,
        value.longestRunningTurnSec, value.totalSkillsUsed, value.uniqueSkillsUsed].some((number) => !isNonnegativeSafeInteger(number))
        || !isPercentage(value.fastModeUsagePercentage) || !isPercentage(value.mostUsedReasoningEffortPercentage)
        || !isSafeReasoningEffort(value.mostUsedReasoningEffort)
        || value.mostUsedReasoningEffort === null && value.mostUsedReasoningEffortPercentage !== 0
        || !isUsageBuckets(value.dailyUsageBuckets) || !isUsageBuckets(value.cumulativeDailyUsageBuckets)
        || !isUsageBuckets(value.weeklyUsageBuckets) || !isSafeInvocations(value.topInvocations))
        return false;
    const derived = deriveActivityBuckets(value.dailyUsageBuckets);
    return derived !== null && sameBuckets(derived.cumulative, value.cumulativeDailyUsageBuckets)
        && sameBuckets(derived.weekly, value.weeklyUsageBuckets);
}
function isUsageBuckets(value) {
    if (!Array.isArray(value) || value.length > MAX_USAGE_BUCKETS)
        return false;
    let previous = "";
    for (const bucket of value) {
        if (!(0, types_1.isPlainRecord)(bucket) || !hasExactKeys(bucket, ["startDate", "tokens"])
            || !isSafeDate(bucket.startDate) || !isNonnegativeSafeInteger(bucket.tokens)
            || previous >= bucket.startDate)
            return false;
        previous = bucket.startDate;
    }
    return true;
}
function isSafeInvocations(value) {
    if (!Array.isArray(value) || value.length > MAX_TOP_INVOCATIONS)
        return false;
    let previous = null;
    for (const invocation of value) {
        if (!(0, types_1.isPlainRecord)(invocation) || !hasExactKeys(invocation, ["label", "type", "usageCount"])
            || (invocation.type !== "plugin" && invocation.type !== "skill" && invocation.type !== "other")
            || typeof invocation.label !== "string" || safeDisplayLabel(invocation.label) !== invocation.label || !isNonnegativeSafeInteger(invocation.usageCount))
            return false;
        const candidate = { type: invocation.type, label: invocation.label, usageCount: invocation.usageCount };
        if (previous !== null && compareInvocations(previous, candidate) > 0)
            return false;
        previous = candidate;
    }
    return true;
}
function sameBuckets(left, right) {
    return left.length === right.length && left.every((bucket, index) => bucket.startDate === right[index]?.startDate && bucket.tokens === right[index]?.tokens);
}
function sameSafeStats(left, right) {
    if (left === null || right === null)
        return left === right;
    return left.lifetimeTokens === right.lifetimeTokens && left.peakDailyTokens === right.peakDailyTokens
        && left.currentStreakDays === right.currentStreakDays && left.longestStreakDays === right.longestStreakDays
        && left.totalThreads === right.totalThreads && left.longestRunningTurnSec === right.longestRunningTurnSec
        && left.fastModeUsagePercentage === right.fastModeUsagePercentage && left.totalSkillsUsed === right.totalSkillsUsed
        && left.uniqueSkillsUsed === right.uniqueSkillsUsed && left.mostUsedReasoningEffort === right.mostUsedReasoningEffort
        && left.mostUsedReasoningEffortPercentage === right.mostUsedReasoningEffortPercentage
        && sameBuckets(left.dailyUsageBuckets, right.dailyUsageBuckets)
        && sameBuckets(left.cumulativeDailyUsageBuckets, right.cumulativeDailyUsageBuckets)
        && sameBuckets(left.weeklyUsageBuckets, right.weeklyUsageBuckets)
        && left.topInvocations.length === right.topInvocations.length
        && left.topInvocations.every((invocation, index) => invocation.type === right.topInvocations[index]?.type
            && invocation.label === right.topInvocations[index]?.label && invocation.usageCount === right.topInvocations[index]?.usageCount);
}
function compareInvocations(left, right) {
    return right.usageCount - left.usageCount || left.type.localeCompare(right.type) || left.label.localeCompare(right.label);
}
function hasExactKeys(value, expected) {
    return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function nonnegativeCount(value) {
    return isNonnegativeSafeInteger(value) ? value : null;
}
function safeAdd(left, right) {
    const result = left + right;
    return Number.isSafeInteger(result) && result >= 0 && result <= MAX_SAFE_COUNT ? result : null;
}
function percentage(value) {
    return isPercentage(value) ? value : null;
}
function isPercentage(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function isNonnegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_COUNT;
}
function safeReasoningEffort(value) {
    return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
        ? value
        : null;
}
function isSafeReasoningEffort(value) {
    return value === null || safeReasoningEffort(value) !== null;
}
function isSafeHeaderValue(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
function isSafeBearerToken(value) {
    return isSafeHeaderValue(value, 16 * 1024) && !/\s/.test(value);
}
function isSafeDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const year = Number(value.slice(0, 4));
    if (year < 1970 || year > 9999)
        return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function mondayForDate(value) {
    if (!isSafeDate(value))
        return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    return formatDateUtc(date);
}
function formatDateUtc(value) {
    return Number.isFinite(value.getTime()) && value.getUTCFullYear() >= 1970 && value.getUTCFullYear() <= 9999
        ? value.toISOString().slice(0, 10)
        : null;
}
function dayNumber(value) {
    if (!isSafeDate(value))
        return null;
    return Math.floor(new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MS);
}
function dateForDayNumber(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
async function mapBounded(values, concurrency, mapper) {
    const results = new Array(values.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= values.length)
                return;
            results[index] = await mapper(values[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, () => worker()));
    return results;
}
//# sourceMappingURL=profile-statistics.js.map
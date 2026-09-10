import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTA_STALE_AFTER_MS,
  accountObservationEligible,
  compareQuotaCandidates,
  emptyQuotaObservation,
  parseAccountRead,
  parseRateLimitsRead,
  quotaFreshness,
  quotaUrgencyScore,
} from "../../src/account-router/quota";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;

test("official account and rate-limit readings are reduced to bounded safe quota facts", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  assert.deepEqual(parseAccountRead({ account: { authenticated: true, planType: "Pro" } }, now), {
    health: "authenticated", plan: "Pro", observedAt: now,
  });
  assert.deepEqual(parseAccountRead({ account: { authenticated: false, email: "never-projected@example.test" } }, now), {
    health: "reauth_required", plan: null, observedAt: now,
  });
  assert.deepEqual(parseAccountRead({ account: null, planType: "Pro" }, now), {
    health: "reauth_required", plan: null, observedAt: now,
  });
  assert.deepEqual(parseAccountRead({ planType: "Pro" }, now), {
    health: "reauth_required", plan: null, observedAt: now,
  });
  assert.deepEqual(parseRateLimitsRead({
    rateLimits: {
      weekly: { remainingPercent: 64, resetAt: "2026-09-03T12:00:00.000Z" },
      fiveHour: { windowDurationMins: 300, remainingPercentage: 25, resetAt: "2026-08-31T17:00:00.000Z" },
    },
  }, now), {
    weeklyRemainingPercent: 64,
    weeklyResetAt: Date.parse("2026-09-03T12:00:00.000Z"),
    shortWindowPressure: 75,
    shortWindowResetAt: Date.parse("2026-08-31T17:00:00.000Z"),
    rateLimitReached: false,
    observedAt: now,
    resetCredits: null,
  });
  assert.equal(parseRateLimitsRead({
    rateLimitResetCredits: 3,
    rateLimits: { weekly: { windowDurationMins: 10_080, remainingPercent: 64, resetAt: "2026-09-03T12:00:00.000Z" } },
  }, now)?.resetCredits, 3);
  assert.equal(parseRateLimitsRead({
    rateLimits: {
      weeklyShort: { windowDurationMins: 10_080, remainingPercent: 10, resetAt: "2026-09-03T12:00:00.000Z" },
      monthly: { windowDurationMins: 43_200, remainingPercent: 80, resetAt: "2026-09-30T12:00:00.000Z" },
    },
  }, now)?.weeklyRemainingPercent, 10, "only the exact 10,080-minute weekly window is capacity evidence");
  assert.equal(parseRateLimitsRead({
    rateLimits: {
      monthly: { windowDurationMins: 43_200, remainingPercent: 80, resetAt: "2026-09-30T12:00:00.000Z" },
      twoWeeks: { windowDurationMins: 20_160, remainingPercent: 70, resetAt: "2026-09-14T12:00:00.000Z" },
    },
  }, now), null, "without an exact 10,080-minute weekly window capacity remains unknown");
  const withExactFiveHour = parseRateLimitsRead({
    rateLimits: {
      weekly: { windowDurationMins: 10_080, remainingPercent: 70, resetAt: "2026-09-03T12:00:00.000Z" },
      monthly: { windowDurationMins: 43_200, remainingPercent: 1, resetAt: "2026-09-30T12:00:00.000Z" },
      fiveHour: { windowDurationMins: 300, remainingPercent: 40, resetAt: "2026-08-31T17:00:00.000Z" },
    },
  }, now);
  assert.equal(withExactFiveHour?.shortWindowPressure, 60, "only the exact 300-minute window contributes pressure");
  assert.equal(parseRateLimitsRead({
    rateLimits: {
      weekly: { windowDurationMins: 10_080, remainingPercent: 70, resetAt: "2026-09-03T12:00:00.000Z" },
      monthly: { windowDurationMins: 43_200, remainingPercent: 1, resetAt: "2026-09-30T12:00:00.000Z" },
    },
  }, now)?.shortWindowPressure, null, "monthly capacity is not misclassified as five-hour pressure");
});

test("documented Codex bucket parsing rejects unrelated buckets and preserves authoritative reset-credit counts", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const parsed = parseRateLimitsRead({
    rateLimits: {
      limitId: "codex_other",
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_788_106_800 },
      secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_711_200 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_788_106_800 },
        secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_788_711_200 },
        rateLimitReachedType: null,
      },
      codex_other: {
        limitId: "codex_other",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_788_106_800 },
        secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_711_200 },
      },
    },
    rateLimitResetCredits: { availableCount: 0, credits: [{ status: "available" }] },
    resetCredits: 99,
  }, now);
  assert.deepEqual(parsed, {
    weeklyRemainingPercent: 75,
    weeklyResetAt: 1_788_711_200_000,
    shortWindowPressure: 50,
    shortWindowResetAt: 1_788_106_800_000,
    rateLimitReached: false,
    observedAt: now,
    resetCredits: 0,
  });
  assert.equal(parseRateLimitsRead({
    rateLimits: { limitId: "codex_other", secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_711_200 } },
    rateLimitsByLimitId: { codex_other: { limitId: "codex_other", secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_711_200 } } },
  }, now), null, "a non-Codex metered bucket is not routing capacity");
  assert.equal(parseRateLimitsRead({
    rateLimits: { limitId: "codex", secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_711_200 }, rateLimitReachedType: "secondary" },
    rateLimitResetCredits: null,
  }, now)?.rateLimitReached, true);
  assert.equal(parseRateLimitsRead({
    rateLimits: { limitId: "codex", secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_711_200 } },
    rateLimitResetCredits: null,
  }, now)?.resetCredits, null, "missing credit data is never treated as zero");
});

test("unknown or stale data is never quota capacity", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const unknown = emptyQuotaObservation();
  assert.equal(quotaFreshness(unknown, now), "unknown");
  assert.equal(accountObservationEligible(unknown, now), false);
  const stale = {
    health: "authenticated" as const,
    plan: "Pro",
    observedAt: now - QUOTA_STALE_AFTER_MS - 1,
    weeklyRemainingPercent: 50,
    weeklyResetAt: now + 60_000,
    shortWindowPressure: 10,
  };
  assert.equal(quotaFreshness(stale, now), "stale");
  assert.equal(accountObservationEligible(stale, now), false);
  const fresh = {
    health: "authenticated" as const,
    plan: "Pro",
    observedAt: now,
    weeklyRemainingPercent: 50,
    weeklyResetAt: now + 60_000,
    shortWindowPressure: 100,
    shortWindowResetAt: now + 30_000,
  };
  assert.equal(accountObservationEligible(fresh, now), false, "an exhausted unreset short window cannot receive work");
  assert.equal(accountObservationEligible({ ...fresh, shortWindowResetAt: now - 1 }, now), true,
    "short-window eligibility is re-evaluated against the current reset time");
  assert.equal(accountObservationEligible({ ...fresh, shortWindowPressure: 0, rateLimitReached: true }, now), false,
    "an explicit server-classified reached limit cannot receive work");
});

test("quota score, then short-window pressure, assigned threads, and configured order break ties", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const base = { weeklyRemainingPercent: 50, weeklyResetAt: now + 100_000, assignedThreadCount: 2 };
  assert.ok(compareQuotaCandidates({ opaqueAccountId: accountA, ...base, shortWindowPressure: 20, configuredIndex: 0 },
    { opaqueAccountId: accountB, ...base, shortWindowPressure: 30, configuredIndex: 1 }, now) < 0);
  assert.ok(compareQuotaCandidates({ opaqueAccountId: accountA, ...base, shortWindowPressure: 20, assignedThreadCount: 3, configuredIndex: 0 },
    { opaqueAccountId: accountB, ...base, shortWindowPressure: 20, assignedThreadCount: 2, configuredIndex: 1 }, now) > 0);
  assert.ok(compareQuotaCandidates({ opaqueAccountId: accountA, ...base, shortWindowPressure: 20, configuredIndex: 0 },
    { opaqueAccountId: accountB, ...base, shortWindowPressure: 20, configuredIndex: 1 }, now) < 0);
  assert.ok(compareQuotaCandidates({ opaqueAccountId: accountA, weeklyRemainingPercent: 49, weeklyResetAt: now + 100_000, shortWindowPressure: 0, assignedThreadCount: 0, configuredIndex: 0 },
    { opaqueAccountId: accountB, weeklyRemainingPercent: 50, weeklyResetAt: now + 100_000, shortWindowPressure: 100, assignedThreadCount: 9, configuredIndex: 1 }, now) > 0);
});

test("fork urgency uses hours, a one-minute floor and a capped fifteen-percent reset bonus", () => {
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  const base = { opaqueAccountId: accountA, weeklyRemainingPercent: 50, weeklyResetAt: now + 3_600_000, shortWindowPressure: 20, assignedThreadCount: 0, configuredIndex: 0 };
  assert.equal(quotaUrgencyScore(base, now), 50);
  assert.ok(Math.abs(quotaUrgencyScore({ ...base, resetCredits: 1 }, now) - 57.5) < 0.000001);
  assert.equal(quotaUrgencyScore({ ...base, resetCredits: 3 }, now), 72.5);
  assert.equal(quotaUrgencyScore({ ...base, resetCredits: 100 }, now), 72.5);
  assert.equal(quotaUrgencyScore({ ...base, weeklyResetAt: now + 1 }, now), 3_000);
  assert.equal(quotaUrgencyScore({ ...base, weeklyResetAt: now - 1 }, now), 50 / 168);
  assert.ok(compareQuotaCandidates({ ...base, weeklyRemainingPercent: 45, resetCredits: 1 }, base, now) < 0,
    "banked resets affect urgency rather than just the final tie-break");
  assert.ok(compareQuotaCandidates(base, { ...base, weeklyRemainingPercent: 25, weeklyResetAt: now + 1_800_000, assignedThreadCount: 0, configuredIndex: -1 }, now) < 0,
    "equal urgency and short-window pressure prefer more remaining weekly capacity before assigned load/order");
});

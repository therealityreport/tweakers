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
    observedAt: now,
  });
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

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NativeProfileStatisticsV1,
  isNativeProfileStatisticsResultV1,
} from "../../src/account-router/profile-statistics";
import type { OpaqueAccountId } from "../../src/account-router/types";

const secret = Buffer.alloc(32, 19);
const endpoint = "https://chatgpt.com/backend-api/wham/profiles/me";

interface FixtureAccount {
  accountId: OpaqueAccountId;
  codexHome: string;
  enabled: boolean;
  rawAccountId: string;
}

function opaque(rawAccountId: string): OpaqueAccountId {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccountId}`, "utf8").digest("base64url")}` as OpaqueAccountId;
}

function fixture(): FixtureAccount[] {
  const root = mkdtempSync(join(tmpdir(), "profile-statistics-"));
  return ["provider-account-a", "provider-account-b"].map((rawAccountId, index) => {
    const codexHome = join(root, `account-${index}`, "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const authPath = join(codexHome, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      tokens: { account_id: rawAccountId, access_token: `test-token-${index}` },
    }), { mode: 0o600 });
    chmodSync(authPath, 0o600);
    return { accountId: opaque(rawAccountId), codexHome, enabled: true, rawAccountId };
  });
}

function isoDay(offset: number): string {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

function profileStatistics(input: Readonly<{
  lifetimeTokens: number;
  peakDailyTokens: number;
  currentStreakDays: number;
  longestStreakDays: number;
  totalThreads: number;
  longestRunningTurnSec: number;
  fastModeUsagePercentage: number;
  totalSkillsUsed: number;
  uniqueSkillsUsed: number;
  mostUsedReasoningEffort: string;
  mostUsedReasoningEffortPercentage: number;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
  topInvocations: Array<Record<string, unknown>>;
}>): unknown {
  return {
    profile: {
      email: "private@example.test",
      source_path: "/private/account/auth.json",
      provider_id: "provider-private-id",
    },
    metadata: { stats_error: null, generated_at: "2026-09-05T00:00:00Z" },
    stats: {
      lifetime_tokens: input.lifetimeTokens,
      peak_daily_tokens: input.peakDailyTokens,
      current_streak_days: input.currentStreakDays,
      longest_streak_days: input.longestStreakDays,
      total_threads: input.totalThreads,
      longest_running_turn_sec: input.longestRunningTurnSec,
      fast_mode_usage_percentage: input.fastModeUsagePercentage,
      total_skills_used: input.totalSkillsUsed,
      unique_skills_used: input.uniqueSkillsUsed,
      most_used_reasoning_effort: input.mostUsedReasoningEffort,
      most_used_reasoning_effort_percentage: input.mostUsedReasoningEffortPercentage,
      daily_usage_buckets: input.dailyUsageBuckets.map((bucket) => ({ start_date: bucket.startDate, tokens: bucket.tokens })),
      cumulative_daily_usage_buckets: [{ start_date: isoDay(-100), tokens: 999_999 }],
      weekly_usage_buckets: [{ start_date: isoDay(-100), tokens: 999_999 }],
      top_invocations: input.topInvocations,
      workspace_rank: { member_email: "private@example.test" },
    },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("fetches only through the fixed endpoint and projects pooled safe statistics without raw provider fields", async () => {
  const accounts = fixture();
  const profileByAccount = new Map<string, unknown>([
    [accounts[0]!.rawAccountId, profileStatistics({
      lifetimeTokens: 100,
      peakDailyTokens: 20,
      currentStreakDays: 2,
      longestStreakDays: 2,
      totalThreads: 10,
      longestRunningTurnSec: 40,
      fastModeUsagePercentage: 20,
      totalSkillsUsed: 4,
      uniqueSkillsUsed: 3,
      mostUsedReasoningEffort: "high",
      mostUsedReasoningEffortPercentage: 60,
      dailyUsageBuckets: [{ startDate: isoDay(-2), tokens: 10 }, { startDate: isoDay(-1), tokens: 20 }],
      topInvocations: [{ type: "plugin", plugin_id: "plugin_private_a", plugin_name: "Browser Tools", usage_count: 2 }],
    })],
    [accounts[1]!.rawAccountId, profileStatistics({
      lifetimeTokens: 200,
      peakDailyTokens: 40,
      currentStreakDays: 2,
      longestStreakDays: 2,
      totalThreads: 30,
      longestRunningTurnSec: 80,
      fastModeUsagePercentage: 60,
      totalSkillsUsed: 6,
      uniqueSkillsUsed: 5,
      mostUsedReasoningEffort: "xhigh",
      mostUsedReasoningEffortPercentage: 70,
      dailyUsageBuckets: [{ startDate: isoDay(-1), tokens: 30 }, { startDate: isoDay(0), tokens: 40 }],
      topInvocations: [
        { type: "plugin", plugin_id: "plugin_private_b", plugin_name: "Browser Tools", usage_count: 5 },
        { type: "skill", skill_id: "skill_private_b", skill_name: "Safe Skill", usage_count: 1 },
      ],
    })],
  ]);
  const requests: Array<{ url: string; init: { method: string; redirect: string; headers: Record<string, string> } }> = [];
  const statistics = new NativeProfileStatisticsV1({
    secret,
    accounts: () => accounts,
    fetch: async (url, init) => {
      requests.push({ url, init: { method: init.method, redirect: init.redirect, headers: { ...init.headers } } });
      const rawAccountId = init.headers["ChatGPT-Account-ID"];
      const index = accounts.findIndex((account) => account.rawAccountId === rawAccountId);
      assert.notEqual(index, -1);
      assert.equal(init.headers.Authorization, `Bearer test-token-${index}`);
      return response(profileByAccount.get(rawAccountId));
    },
  });

  const result = await statistics.read("pooled");

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, endpoint);
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.redirect, "error");
    assert.deepEqual(Object.keys(request.init.headers).sort(), ["Authorization", "ChatGPT-Account-ID"]);
  }
  assert.equal(result.partial, false);
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts.map((account) => account.state), ["ready", "ready"]);
  const pooled = result.stats;
  assert.ok(pooled);
  assert.equal(pooled.lifetimeTokens, 300);
  assert.equal(pooled.totalThreads, 40);
  assert.equal(pooled.peakDailyTokens, 50);
  assert.equal(pooled.currentStreakDays, 3);
  assert.equal(pooled.longestStreakDays, 3);
  assert.equal(pooled.longestRunningTurnSec, 80);
  assert.equal(pooled.fastModeUsagePercentage, 50);
  assert.equal(pooled.totalSkillsUsed, 10);
  assert.equal(pooled.uniqueSkillsUsed, 8);
  assert.equal(pooled.mostUsedReasoningEffort, "xhigh");
  assert.equal(pooled.mostUsedReasoningEffortPercentage, 52.5);
  assert.deepEqual(pooled.dailyUsageBuckets, [
    { startDate: isoDay(-2), tokens: 10 },
    { startDate: isoDay(-1), tokens: 50 },
    { startDate: isoDay(0), tokens: 40 },
  ]);
  assert.deepEqual(pooled.topInvocations, [
    { type: "plugin", label: "Browser Tools", usageCount: 7 },
    { type: "skill", label: "Safe Skill", usageCount: 1 },
  ]);
  assert.equal(isNativeProfileStatisticsResultV1(result), true);
  const serialized = JSON.stringify(result);
  for (const privateValue of ["private@example.test", "provider-private-id", "plugin_private", "skill_private", "/private/account/auth.json", "test-token-"]) {
    assert.equal(serialized.includes(privateValue), false, `private value leaked: ${privateValue}`);
  }

  const individual = await statistics.read(accounts[0]!.accountId);
  assert.equal(requests.length, 2, "only sanitized cache entries serve the second selection");
  assert.equal(individual.partial, false);
  assert.equal(individual.stats?.lifetimeTokens, 100);
  assert.deepEqual(individual.accounts.map((account) => account.accountId), accounts.map((account) => account.accountId));
});

test("fails closed when owner-private auth does not bind to the opaque account and never calls fetch", async () => {
  const accounts = fixture();
  const authPath = join(accounts[0]!.codexHome, "auth.json");
  writeFileSync(authPath, JSON.stringify({ tokens: { account_id: "different-provider-account", access_token: "test-token-0" } }), { mode: 0o600 });
  chmodSync(authPath, 0o600);
  let calls = 0;
  const statistics = new NativeProfileStatisticsV1({
    secret,
    accounts: () => [accounts[0]!],
    fetch: async () => {
      calls += 1;
      return response({});
    },
  });

  const result = await statistics.read("pooled");

  assert.equal(calls, 0);
  assert.equal(result.partial, true);
  assert.equal(result.stats, null);
  assert.deepEqual(result.accounts.map((account) => ({ accountId: account.accountId, state: account.state, stats: account.stats })), [
    { accountId: accounts[0]!.accountId, state: "unavailable", stats: null },
  ]);
  assert.equal(isNativeProfileStatisticsResultV1(result), true);
});

test("an individual selection reads only its verified account while retaining every account row", async () => {
  const accounts = fixture();
  const requestedAccountIds: string[] = [];
  const statistics = new NativeProfileStatisticsV1({
    secret,
    accounts: () => accounts,
    fetch: async (_url, init) => {
      requestedAccountIds.push(init.headers["ChatGPT-Account-ID"]);
      return response(profileStatistics({
        lifetimeTokens: 9,
        peakDailyTokens: 4,
        currentStreakDays: 1,
        longestStreakDays: 1,
        totalThreads: 2,
        longestRunningTurnSec: 3,
        fastModeUsagePercentage: 25,
        totalSkillsUsed: 1,
        uniqueSkillsUsed: 1,
        mostUsedReasoningEffort: "ultra",
        mostUsedReasoningEffortPercentage: 100,
        dailyUsageBuckets: [{ startDate: isoDay(0), tokens: 4 }],
        topInvocations: [],
      }));
    },
  });

  const result = await statistics.read(accounts[0]!.accountId);

  assert.deepEqual(requestedAccountIds, [accounts[0]!.rawAccountId]);
  assert.equal(result.partial, false);
  assert.equal(result.stats?.lifetimeTokens, 9);
  assert.deepEqual(result.accounts.map((account) => account.state), ["ready", "unavailable"]);
  assert.equal(isNativeProfileStatisticsResultV1(result), true);
});

test("refuses a symlinked owner-private auth file", async () => {
  const accounts = fixture();
  const authPath = join(accounts[0]!.codexHome, "auth.json");
  const target = join(accounts[0]!.codexHome, "auth-target.json");
  writeFileSync(target, JSON.stringify({
    tokens: { account_id: accounts[0]!.rawAccountId, access_token: "test-token-0" },
  }), { mode: 0o600 });
  chmodSync(target, 0o600);
  unlinkSync(authPath);
  symlinkSync(target, authPath);
  let calls = 0;
  const statistics = new NativeProfileStatisticsV1({
    secret,
    accounts: () => [accounts[0]!],
    fetch: async () => {
      calls += 1;
      return response({});
    },
  });

  const result = await statistics.read("pooled");

  assert.equal(calls, 0);
  assert.equal(result.stats, null);
  assert.equal(result.accounts[0]?.state, "unavailable");
});

test("caps provider response bodies before parsing or projecting them", async () => {
  const accounts = fixture();
  const statistics = new NativeProfileStatisticsV1({
    secret,
    accounts: () => [accounts[0]!],
    fetch: async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
  });

  const result = await statistics.read("pooled");

  assert.equal(result.partial, true);
  assert.equal(result.stats, null);
  assert.equal(result.accounts[0]?.stats, null);
});

test("rejects redirects and malformed provider statistics without projecting an invented zero", async () => {
  const accounts = fixture();
  let calls = 0;
  const redirecting = new NativeProfileStatisticsV1({
    secret,
    accounts: () => [accounts[0]!],
    fetch: async () => {
      calls += 1;
      const redirected = response(profileStatistics({
        lifetimeTokens: 1,
        peakDailyTokens: 1,
        currentStreakDays: 1,
        longestStreakDays: 1,
        totalThreads: 1,
        longestRunningTurnSec: 1,
        fastModeUsagePercentage: 1,
        totalSkillsUsed: 1,
        uniqueSkillsUsed: 1,
        mostUsedReasoningEffort: "ultra",
        mostUsedReasoningEffortPercentage: 1,
        dailyUsageBuckets: [{ startDate: isoDay(0), tokens: 1 }],
        topInvocations: [],
      }));
      return { status: 200, redirected: true, url: endpoint, body: redirected.body };
    },
  });
  const redirected = await redirecting.read("pooled");
  assert.equal(calls, 1);
  assert.equal(redirected.stats, null);
  assert.equal(redirected.partial, true);

  const malformed = new NativeProfileStatisticsV1({
    secret,
    accounts: () => [accounts[0]!],
    fetch: async () => response(profileStatistics({
      lifetimeTokens: 1,
      peakDailyTokens: 1,
      currentStreakDays: 1,
      longestStreakDays: 1,
      totalThreads: 1,
      longestRunningTurnSec: 1,
      fastModeUsagePercentage: 1,
      totalSkillsUsed: 1,
      uniqueSkillsUsed: 1,
      mostUsedReasoningEffort: "high",
      mostUsedReasoningEffortPercentage: 1,
      dailyUsageBuckets: [{ startDate: "2026-02-30", tokens: 1 }],
      topInvocations: [{ type: "plugin", plugin_name: "private@example.test", usage_count: 1 }],
    })),
  });
  const invalid = await malformed.read("pooled");
  assert.equal(invalid.stats, null);
  assert.equal(invalid.accounts[0]?.state, "unavailable");
});

test("strict public validator rejects extra and unsafe fields", async () => {
  const accounts = fixture();
  const statistics = new NativeProfileStatisticsV1({
    secret,
    accounts: () => [accounts[0]!],
    fetch: async () => response(profileStatistics({
      lifetimeTokens: 1,
      peakDailyTokens: 1,
      currentStreakDays: 1,
      longestStreakDays: 1,
      totalThreads: 1,
      longestRunningTurnSec: 1,
      fastModeUsagePercentage: 1,
      totalSkillsUsed: 1,
      uniqueSkillsUsed: 1,
      mostUsedReasoningEffort: "ultra",
      mostUsedReasoningEffortPercentage: 1,
      dailyUsageBuckets: [{ startDate: isoDay(0), tokens: 1 }],
      topInvocations: [{ type: "plugin", plugin_name: "Browser Tools", usage_count: 1 }],
    })),
  });
  const result = await statistics.read("pooled");
  assert.equal(isNativeProfileStatisticsResultV1(result), true);

  const extra = { ...result, rawProviderPayload: { email: "private@example.test" } };
  assert.equal(isNativeProfileStatisticsResultV1(extra), false);
  const unsafeLabel = structuredClone(result);
  unsafeLabel.stats!.topInvocations[0]!.label = "private@example.test";
  assert.equal(isNativeProfileStatisticsResultV1(unsafeLabel), false);
  const mismatchedAggregate = structuredClone(result);
  mismatchedAggregate.stats!.lifetimeTokens = 2;
  assert.equal(isNativeProfileStatisticsResultV1(mismatchedAggregate), false);
  const mismatchedAccounts = structuredClone(result);
  mismatchedAccounts.accounts[0]!.state = "unavailable";
  assert.equal(isNativeProfileStatisticsResultV1(mismatchedAccounts), false);
});

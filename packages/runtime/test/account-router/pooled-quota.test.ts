import assert from "node:assert/strict";
import test from "node:test";
import { pooledNativeQuotaV1 } from "../../src/account-router/pooled-quota";
import type { AccountPoolAccountV3, OpaqueAccountId, QuotaProjectionV3 } from "../../src/account-router/types";
const now = 1_000_000;
const ids = [`ar_${"a".repeat(43)}`, `ar_${"b".repeat(43)}`] as OpaqueAccountId[];
const accounts = ids.map((opaqueAccountId) => ({ opaqueAccountId, enabled: true, state: "ready" })) as AccountPoolAccountV3[];
function observation(index: number, remainingPercent: number): QuotaProjectionV3 {
  return { opaqueAccountId: ids[index]!, freshness: "fresh", remainingPercent, resetAt: new Date(now + 100_000).toISOString(), observedAt: now, shortWindowPressure: 10, shortWindowResetAt: now + 20_000, resetCredits: 3 };
}
test("native pooled usage averages available subscriptions without exposing account reset-credit IDs", () => {
  const result = pooledNativeQuotaV1(accounts, [observation(0, 20), observation(1, 80)], now) as any;
  assert.equal(result.rateLimits.secondary.usedPercent, 50);
  assert.equal(result.rateLimits.primary.usedPercent, 10);
  assert.equal(result.rateLimits.rateLimitReachedType, null);
  assert.equal(result.rateLimits.resetCredits, null);
  assert.deepEqual(result.rateLimitsByLimitId.codex, result.rateLimits);
});
test("unknown readings cannot become a healthy native pool or a false depletion banner", () => {
  const result = pooledNativeQuotaV1(accounts, [observation(0, 80)], now) as any;
  assert.equal(result.rateLimits.secondary, null);
  assert.equal(result.rateLimits.rateLimitReachedType, null);
  const depleted = pooledNativeQuotaV1(accounts, [observation(0, 0), observation(1, 0)], now) as any;
  assert.equal(depleted.rateLimits.rateLimitReachedType, "rate_limit_reached");
  const disabled = pooledNativeQuotaV1([{ ...accounts[0]!, enabled: false }, accounts[1]!], [observation(0, 0), observation(1, 80)], now) as any;
  assert.equal(disabled.rateLimits.secondary.usedPercent, 20);
});

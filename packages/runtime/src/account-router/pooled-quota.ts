import type { AccountPoolAccountV3, QuotaProjectionV3 } from "./types";
import { hasConfirmedQuotaDepletion, QUOTA_STALE_AFTER_MS } from "./quota";

/** One conservative native snapshot feeds the usage sheet and native limit indicators. */
export function pooledNativeQuotaV1(accounts: readonly AccountPoolAccountV3[], quotas: readonly QuotaProjectionV3[], now = Date.now()): Record<string, unknown> {
  const included = accounts.filter((account) => account.enabled);
  const observations = included.map((account) => quotas.find((quota) => quota.opaqueAccountId === account.opaqueAccountId));
  const complete = included.length > 0 && included.every((account) => account.state !== "reauth_required" && account.state !== "unhealthy")
    && observations.every((quota) => quota?.freshness === "fresh" && typeof quota.observedAt === "number"
      && quota.observedAt <= now && now - quota.observedAt <= QUOTA_STALE_AFTER_MS
      && typeof quota.remainingPercent === "number" && quota.resetAt !== null && Date.parse(quota.resetAt) > now);
  const rows = complete ? observations as QuotaProjectionV3[] : [];
  const weekly = rows.length ? {
    usedPercent: Math.round(rows.reduce((total, quota) => total + 100 - quota.remainingPercent!, 0) / rows.length),
    windowDurationMins: 10_080,
    resetsAt: Math.floor(Math.min(...rows.map((quota) => Date.parse(quota.resetAt!))) / 1_000),
  } : null;
  const short = rows.length && rows.every((quota) => typeof quota.shortWindowPressure === "number" && typeof quota.shortWindowResetAt === "number" && quota.shortWindowResetAt > now) ? {
    usedPercent: Math.round(rows.reduce((total, quota) => total + quota.shortWindowPressure!, 0) / rows.length),
    windowDurationMins: 300,
    resetsAt: Math.floor(Math.min(...rows.map((quota) => quota.shortWindowResetAt!)) / 1_000),
  } : null;
  const snapshot = {
    limitId: "codex", limitName: "Codex", primary: short, secondary: weekly,
    credits: null, planType: null, resetCredits: null, spendControlReached: null,
    rateLimitReachedType: rows.length && rows.every((quota) => hasConfirmedQuotaDepletion(quota, now)) ? "rate_limit_reached" : null,
  };
  return {
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot },
    tweakersPooledQuota: {
      remainingPercent: complete ? rows.reduce((total, quota) => total + quota.remainingPercent!, 0) : null,
      nativeBarRemainingPercent: complete ? Math.max(0, Math.min(100, 100 - (weekly?.usedPercent ?? 100))) : null,
      incomplete: !complete,
      accountCount: included.length,
    },
  };
}

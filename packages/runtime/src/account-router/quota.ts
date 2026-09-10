import type { OpaqueAccountId } from "./types";
import { isPlainRecord } from "./types";

/** Provider readings older than two minutes are never capacity evidence. */
export const QUOTA_STALE_AFTER_MS = 2 * 60 * 1_000;

export type AccountHealth = "authenticated" | "reauth_required" | "disabled" | "unhealthy";

export interface AccountReadObservation {
  health: AccountHealth;
  plan: string | null;
  observedAt: number | null;
}

export interface RateLimitObservation {
  weeklyRemainingPercent: number | null;
  weeklyResetAt: number | null;
  shortWindowPressure: number | null;
  /** Present only when the provider supplied the exact five-hour reset. */
  shortWindowResetAt?: number | null;
  /** A non-null server-classified reached type makes the bucket ineligible. */
  rateLimitReached?: boolean;
  observedAt: number | null;
  resetCredits?: number | null;
}

export interface AccountQuotaObservation extends AccountReadObservation, RateLimitObservation {}

export interface QuotaSelectionCandidate {
  opaqueAccountId: OpaqueAccountId;
  weeklyRemainingPercent: number;
  weeklyResetAt: number;
  shortWindowPressure: number | null;
  assignedThreadCount: number;
  resetCredits?: number | null;
  configuredIndex: number;
}

export function emptyQuotaObservation(): AccountQuotaObservation {
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
export function parseAccountRead(result: unknown, now: number): AccountReadObservation | null {
  if (!isPlainRecord(result)) return null;
  // A successful envelope without its explicit official account object is not
  // proof of authentication. In particular, never fall back from
  // `{ account: null }` to unrelated result metadata.
  if (!isPlainRecord(result.account)) return { health: "reauth_required", plan: null, observedAt: now };
  const account = result.account;
  const disabled = account.disabled === true || account.enabled === false || result.disabled === true || result.enabled === false;
  const authenticated = account.authenticated ?? account.isAuthenticated ?? result.authenticated ?? result.isAuthenticated;
  const status = typeof account.status === "string" ? account.status.toLowerCase() : typeof result.status === "string" ? result.status.toLowerCase() : "";
  const health: AccountHealth = disabled ? "disabled"
    : authenticated === false || status === "unauthenticated" || status === "signed_out" ? "reauth_required"
      : "authenticated";
  return { health, plan: safePlan(account, result), observedAt: now };
}

/**
 * Read only documented app-server rate-limit shapes. The walker supports the
 * known keyed and list forms without retaining any unrecognized provider data.
 */
export function parseRateLimitsRead(result: unknown, now: number): RateLimitObservation | null {
  if (!isPlainRecord(result)) return null;
  const bucket = codexRateLimitBucket(result);
  if (!bucket) return null;
  const windows = collectWindows(bucket.value);
  const weekly = windows
    .filter((window) => window.durationMinutes === 10_080 && window.remainingPercent !== null && window.resetAt !== null)
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey))[0];
  if (!weekly) return null;
  // The five-hour (300-minute) window is the only supported short-pressure
  // tiebreaker. Monthly or arbitrary longer buckets must never affect it.
  const short = windows
    .filter((window) => window.durationMinutes === 300 && window.remainingPercent !== null)
    .sort((left, right) => (left.remainingPercent! - right.remainingPercent!) || left.pathKey.localeCompare(right.pathKey))[0];
  return {
    weeklyRemainingPercent: weekly.remainingPercent,
    weeklyResetAt: weekly.resetAt,
    shortWindowPressure: short ? 100 - short.remainingPercent! : null,
    shortWindowResetAt: short?.resetAt ?? null,
    rateLimitReached: bucket.rateLimitReached,
    observedAt: now,
    resetCredits: resetCreditsFrom(result),
  };
}

export function quotaFreshness(observation: AccountQuotaObservation, now: number): "fresh" | "stale" | "unknown" {
  if (observation.observedAt === null || observation.weeklyRemainingPercent === null || observation.weeklyResetAt === null) return "unknown";
  if (observation.observedAt > now || now - observation.observedAt > QUOTA_STALE_AFTER_MS) return "stale";
  return "fresh";
}

export function accountObservationEligible(observation: AccountQuotaObservation, now: number): boolean {
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
export const ROUTING_MINIMUM_WINDOW_MS = 60_000;
export const ROUTING_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const ROUTING_RESET_BONUS_PER_CREDIT = 0.15;
export const ROUTING_RESET_BONUS_CREDIT_CAP = 3;

export function quotaUrgencyScore(candidate: QuotaSelectionCandidate, now: number): number {
  const remaining = Math.max(0, Math.min(100, candidate.weeklyRemainingPercent));
  const untilReset = candidate.weeklyResetAt - now;
  const horizon = Math.max(ROUTING_MINIMUM_WINDOW_MS, untilReset > 0 ? untilReset : ROUTING_FALLBACK_WINDOW_MS);
  const credits = Math.min(ROUTING_RESET_BONUS_CREDIT_CAP, Math.max(0, candidate.resetCredits ?? 0));
  return remaining / (horizon / 3_600_000) * (1 + credits * ROUTING_RESET_BONUS_PER_CREDIT);
}

/** Upstream urgency and stable tie-breaks, after fresh capacity eligibility. */
export function compareQuotaCandidates(left: QuotaSelectionCandidate, right: QuotaSelectionCandidate, now: number): number {
  const leftScore = quotaUrgencyScore(left, now);
  const rightScore = quotaUrgencyScore(right, now);
  if (Math.abs(leftScore - rightScore) > 0.000001) return rightScore - leftScore;
  const leftPressure = left.shortWindowPressure ?? 1_000;
  const rightPressure = right.shortWindowPressure ?? 1_000;
  if (Math.abs(leftPressure - rightPressure) > 0.001) return leftPressure - rightPressure;
  if (Math.abs(left.weeklyRemainingPercent - right.weeklyRemainingPercent) > 0.001) return right.weeklyRemainingPercent - left.weeklyRemainingPercent;
  if (left.assignedThreadCount !== right.assignedThreadCount) return left.assignedThreadCount - right.assignedThreadCount;
  return left.configuredIndex - right.configuredIndex;
}

function resetCreditsFrom(value: Record<string, unknown>): number | null {
  if (isPlainRecord(value.rateLimitResetCredits)) {
    const documented = value.rateLimitResetCredits.availableCount;
    // The documented aggregate is authoritative; detail rows may be capped.
    return isResetCreditCount(documented) ? documented : null;
  }
  const candidates = [
    value.rateLimitResetCredits,
    value.resetCredits,
    isPlainRecord(value.credits) ? value.credits.available : null,
    isPlainRecord(value.rateLimits) ? value.rateLimits.resetCredits : null,
  ];
  const found = candidates.find(isResetCreditCount);
  return typeof found === "number" ? found : null;
}

function isResetCreditCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

interface RateLimitBucket {
  value: Record<string, unknown>;
  rateLimitReached: boolean;
}

/**
 * The multi-bucket response is keyed by the metered `limitId`. Select only the
 * documented Codex bucket; other model/product buckets must not be combined
 * with it. Older single-bucket fixtures without a limit identifier remain
 * supported only when no multi-bucket response was supplied.
 */
function codexRateLimitBucket(result: Record<string, unknown>): RateLimitBucket | null {
  const byLimitId = result.rateLimitsByLimitId;
  if (isPlainRecord(byLimitId)) {
    const codex = byLimitId.codex;
    if (isPlainRecord(codex) && (codex.limitId === undefined || codex.limitId === "codex")) return bucket(codex);
  }

  const legacy = result.rateLimits;
  if (!isPlainRecord(legacy)) return null;
  if (legacy.limitId === "codex") return bucket(legacy);
  if (legacy.limitId !== undefined || isPlainRecord(byLimitId)) return null;
  return bucket(legacy);
}

function bucket(value: Record<string, unknown>): RateLimitBucket {
  return {
    value,
    rateLimitReached: value.rateLimitReachedType !== null && value.rateLimitReachedType !== undefined,
  };
}

interface ParsedWindow {
  weekly: boolean;
  remainingPercent: number | null;
  resetAt: number | null;
  durationMinutes: number;
  pathKey: string;
}

function collectWindows(value: unknown): ParsedWindow[] {
  const result: ParsedWindow[] = [];
  if (!isPlainRecord(value)) return result;
  const root = parseWindow(value, []);
  if (root) result.push(root);
  // App-server exposes primary and secondary directly on a selected bucket.
  // Supporting other direct legacy window names keeps old fixtures working
  // while intentionally refusing nested model/product bucket collections.
  for (const [key, child] of Object.entries(value)) {
    if (result.length >= 16 || !isPlainRecord(child)) continue;
    const window = parseWindow(child, [key]);
    if (window) result.push(window);
  }
  return result;
}

function parseWindow(value: Record<string, unknown>, path: string[]): ParsedWindow | null {
  const remainingPercent = percentFrom(value);
  const resetAt = resetAtFrom(value);
  if (remainingPercent === null && resetAt === null) return null;
  const minutes = value.windowDurationMins ?? value.windowDurationMinutes ?? value.durationMinutes;
  const numericMinutes = typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
  const durationMinutes = numericMinutes ?? (path.some((segment) => /(?:week|7d|seven.day)/i.test(segment)) ? 10_080 : 0);
  return { weekly: durationMinutes === 10_080, remainingPercent, resetAt, durationMinutes, pathKey: path.join("\u0000") };
}

function percentFrom(value: Record<string, unknown>): number | null {
  const direct = [value.remainingPercent, value.remainingPercentage, value.percentRemaining]
    .find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate));
  if (direct !== undefined) return percent(direct);
  if (typeof value.remaining === "number" && typeof value.limit === "number" && value.limit > 0) return percent(value.remaining / value.limit * 100);
  if (typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent)) return percent(100 - value.usedPercent);
  return null;
}

function resetAtFrom(value: Record<string, unknown>): number | null {
  const candidate = value.resetAt ?? value.resetsAt ?? value.resetTime ?? value.resetAtMs ?? value.resetAtUnix;
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) return null;
  return candidate < 10_000_000_000 ? candidate * 1_000 : candidate;
}

function percent(value: number): number | null {
  return value >= 0 && value <= 100 ? value : null;
}

function safePlan(...records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    for (const key of ["plan", "planType", "planName", "subscriptionPlan"]) {
      const value = record[key];
      if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(value)) return value;
    }
    if (isPlainRecord(record.subscription)) {
      const nested = safePlan(record.subscription);
      if (nested) return nested;
    }
  }
  return null;
}

/** Missing/stale capacity is not evidence that an existing subscription is depleted. */
export function hasConfirmedQuotaDepletion(quota: {
  freshness: string; observedAt?: number | null; remainingPercent: number | null;
  resetAt: string | null; shortWindowPressure: number | null; shortWindowResetAt?: number | null;
  rateLimitReached?: boolean;
} | undefined, now = Date.now()): boolean {
  if (!quota || quota.freshness !== "fresh" || typeof quota.observedAt !== "number"
    || !Number.isFinite(quota.observedAt) || quota.observedAt > now || now - quota.observedAt > QUOTA_STALE_AFTER_MS) return false;
  return (quota.remainingPercent === 0 && quota.resetAt !== null && Date.parse(quota.resetAt) > now)
    || (quota.shortWindowPressure === 100 && typeof quota.shortWindowResetAt === "number" && quota.shortWindowResetAt > now)
    || (quota.rateLimitReached === true && quota.resetAt !== null && Date.parse(quota.resetAt) > now);
}

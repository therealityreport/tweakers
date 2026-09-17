/*
 * Usage Limit Resets Tracker — clean-room implementation.
 *
 * Only structured values extracted from a visible usage-limit component are
 * persisted. We do not retain account names, tokens, cookies, credentials, or
 * the component's raw text. Reset detection is transition based: elapsed time
 * by itself can never create a reset event. DOM changes are observed with one
 * MutationObserver and renderer storage is used for the bounded local history.
 */

const STORAGE_KEY = "usageHistory";
const SCHEMA_VERSION = 2;
const MAX_HISTORY = 24;
const MAX_TRACKED_LIMITS = 12;
const ACCOUNTS_CONTEXT_VERSION = 1;
const ACCOUNTS_CONTEXT_EVENT = "tweakers:accounts-context";
const ACCOUNTS_CONTEXT_REQUEST_EVENT = "tweakers:accounts-context-request";
const ACCOUNTS_SELECTION_EVENT = "tweakers:accounts-select";
const ACCOUNTS_RESET_REQUEST_EVENT = "tweakers:accounts-reset-credit-request";
const ACCOUNTS_RESET_RESULT_EVENT = "tweakers:accounts-reset-credit-result";
// Accounts context carries only broker-issued public HMAC handles. Provider
// IDs never belong in this cross-tweak event or in Usage Tracker state.
const ACCOUNT_PUBLIC_ID = /^account_[A-Za-z0-9_-]{43}$/;
// Account pools are not cardinality-limited. Context is accepted only when
// the complete, validated payload stays within this serialized-byte bound.
const ACCOUNTS_CONTEXT_MAX_SERIALIZED_BYTES = 512 * 1024;
const UNKNOWN = Object.freeze({ kind: "unknown", label: "Unknown" });

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, limits: {}, resetCredits: { available: null, items: [], observedAt: null, pendingUsedAt: null }, history: [] };
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeLabel(value) {
  if (typeof value !== "string") return "Usage limit";
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!compact || /(?:bearer|token|cookie|credential|password|secret|@)/i.test(compact)) {
    return "Usage limit";
  }
  return compact;
}

function safeKey(value, fallback = "usage-limit") {
  const compact = typeof value === "string" ? value.trim().slice(0, 100) : "";
  if (/(?:token|cookie|secret|credential|password|bearer|@)/i.test(compact)) return fallback;
  const key = compact.replace(/[^a-zA-Z0-9._:-]/g, "-").replace(/-+/g, "-");
  return key || fallback;
}

function safeAccountId(value) {
  return typeof value === "string" && ACCOUNT_PUBLIC_ID.test(value) ? value : null;
}

function accountsContextWithinByteBound(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return false;
    const bytes = typeof TextEncoder === "function"
      ? new TextEncoder().encode(serialized).byteLength
      : typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function"
        ? Buffer.byteLength(serialized, "utf8")
        : encodeURIComponent(serialized).replace(/%[0-9A-F]{2}|./gi, "x").length;
    return Number.isInteger(bytes) && bytes >= 0 && bytes <= ACCOUNTS_CONTEXT_MAX_SERIALIZED_BYTES;
  } catch {
    return false;
  }
}

function safeAccountContextLabel(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 80);
  // Accounts labels are presentation-only. Reject values that could contain
  // credentials or an email identity before Usage Tracker retains them.
  if (!compact || /(?:bearer|token|cookie|credential|password|secret|@)/i.test(compact)) return null;
  return compact;
}

function safeAccountContextQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const remainingPercent = finiteNumber(value.remainingPercent);
  return {
    remainingPercent: remainingPercent === null || remainingPercent < 0 || remainingPercent > 100 ? null : Math.round(remainingPercent),
    resetAt: isoOrNull(value.resetAt),
    depleted: value.depleted === true || remainingPercent === 0,
    resetCredits: Number.isInteger(value.resetCredits) && value.resetCredits >= 0 && value.resetCredits <= 10_000 ? value.resetCredits : null,
  };
}

function normalizeAccountsContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== ACCOUNTS_CONTEXT_VERSION
    || !Array.isArray(value.accounts) || !accountsContextWithinByteBound(value)) return null;
  const accounts = value.accounts.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) return null;
    const accountId = safeAccountId(account.accountId);
    const label = safeAccountContextLabel(account.label);
    const quota = safeAccountContextQuota(account.quota);
    if (!accountId || !label || !quota) return null;
    return { accountId, label, enabled: account.enabled !== false, quota };
  }).filter(Boolean);
  if (accounts.length !== value.accounts.length || new Set(accounts.map((account) => account.accountId)).size !== accounts.length) return null;
  const selectedAccountId = safeAccountId(value.selectedAccountId);
  const context = {
    accounts,
    selectedAccountId: selectedAccountId && accounts.some((account) => account.accountId === selectedAccountId) ? selectedAccountId : accounts[0]?.accountId || null,
  };
  return accountsContextWithinByteBound(context) ? context : null;
}

function usageContextRequestId(instance) {
  instance.contextRequestNonce = (instance.contextRequestNonce || 0) + 1;
  return `usage-reset-${Date.now().toString(36)}-${instance.contextRequestNonce.toString(36)}`.slice(0, 64);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeObservation(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) return null;
  const key = safeKey(raw.key, "usage-limit");
  const label = safeLabel(raw.label);
  const limit = finiteNumber(raw.limit);
  if (limit === null || limit <= 0) return null;
  let used = finiteNumber(raw.used);
  let remaining = finiteNumber(raw.remaining);
  if (used === null && remaining === null) return null;
  if (used === null) used = Math.max(0, limit - remaining);
  if (remaining === null) remaining = Math.max(0, limit - used);
  if (used < 0 || remaining < 0) return null;
  const observedAt = isoOrNull(raw.observedAt) || isoOrNull(now);
  if (!observedAt) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    key,
    label,
    used,
    limit,
    remaining,
    resetAt: isoOrNull(raw.resetAt),
    resetPrecision: raw.resetPrecision === "date" ? "date" : "instant",
    observedAt,
  };
}

function normalizeTransition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const observedAt = isoOrNull(raw.observedAt);
  if (!observedAt || typeof raw.key !== "string") return null;
  return {
    key: safeKey(raw.key),
    label: safeLabel(raw.label),
    observedAt,
    resetAt: isoOrNull(raw.resetAt),
    resetPrecision: raw.resetPrecision === "date" ? "date" : "instant",
    previousObservedAt: isoOrNull(raw.previousObservedAt),
    previousRemaining: finiteNumber(raw.previousRemaining),
    remaining: finiteNumber(raw.remaining),
    previousUsed: finiteNumber(raw.previousUsed),
    used: finiteNumber(raw.used),
    cause: ["period-reset", "openai-reset", "used-reset", "unknown"].includes(raw.cause) ? raw.cause : "unknown",
    reason: raw.reason === "remaining-increased" || raw.reason === "used-decreased"
      ? raw.reason
      : "counter-transition",
  };
}

function normalizeResetCredit(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const expiresAt = isoOrNull(raw.expiresAt);
  const observedAt = isoOrNull(raw.observedAt);
  if (!expiresAt || !observedAt) return null;
  const precision = raw.precision === "instant" ? "instant" : "date";
  return {
    id: safeKey(raw.id || `${expiresAt}-${raw.label || "full-reset"}`),
    label: safeLabel(raw.label || "Full reset"),
    expiresAt,
    precision,
    observedAt,
  };
}

function normalizeResetCredits(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { available: null, items: [], observedAt: null, pendingUsedAt: null };
  const available = finiteNumber(raw.available);
  return {
    available: available === null || available < 0 ? null : Math.floor(available),
    items: Array.isArray(raw.items) ? raw.items.map(normalizeResetCredit).filter(Boolean).slice(0, 24) : [],
    observedAt: isoOrNull(raw.observedAt),
    pendingUsedAt: isoOrNull(raw.pendingUsedAt),
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (![1, SCHEMA_VERSION].includes(raw.schemaVersion) || !raw.limits || typeof raw.limits !== "object") {
    return null;
  }
  const limits = {};
  for (const [key, value] of Object.entries(raw.limits)) {
    const entry = value && typeof value === "object" ? value : null;
    const last = normalizeObservation(entry?.last);
    if (!last || safeKey(key) !== last.key || safeLabel(entry.label) !== last.label) continue;
    limits[last.key] = { label: last.label, last };
  }
  const history = Array.isArray(raw.history)
    ? raw.history.map(normalizeTransition).filter(Boolean).slice(-MAX_HISTORY)
    : [];
  return { schemaVersion: SCHEMA_VERSION, limits, resetCredits: normalizeResetCredits(raw.resetCredits), history };
}

function cloneState(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    limits: Object.fromEntries(Object.entries(state.limits).map(([key, entry]) => [key, {
      label: entry.label,
      last: { ...entry.last },
    }])),
    resetCredits: {
      available: state.resetCredits.available,
      items: state.resetCredits.items.map((item) => ({ ...item })),
      observedAt: state.resetCredits.observedAt,
      pendingUsedAt: state.resetCredits.pendingUsedAt,
    },
    history: state.history.map((event) => ({ ...event })),
  };
}

function readState(storage) {
  const raw = storage?.get?.(STORAGE_KEY, null);
  return normalizeState(raw) || emptyState();
}

function readStoredState(storage) {
  const raw = storage?.get?.(STORAGE_KEY, null);
  const state = normalizeState(raw);
  return {
    state: state || emptyState(),
    unknownSchema: raw !== null && raw !== undefined && !state,
  };
}

function writeState(storage, state) {
  const normalized = normalizeState(state) || emptyState();
  storage?.set?.(STORAGE_KEY, normalized);
  return normalized;
}

function clearHistory(state) {
  const normalized = normalizeState(state) || emptyState();
  const next = cloneState(normalized);
  next.history = [];
  return next;
}

function isConfirmedReset(previous, current) {
  if (!previous || !current) return { confirmed: false, reason: null };
  if (previous.label !== current.label || previous.limit !== current.limit) {
    return { confirmed: false, reason: null };
  }
  // A reset is confirmed by a displayed counter transition. A changed reset
  // timestamp or the passage of time without this transition is insufficient.
  if (previous.remaining !== null && current.remaining > previous.remaining) {
    return { confirmed: true, reason: "remaining-increased" };
  }
  if (previous.used !== null && current.used < previous.used) {
    return { confirmed: true, reason: "used-decreased" };
  }
  return { confirmed: false, reason: null };
}

function parseVisibleDate(value, now = new Date()) {
  const text = String(value || "").trim().replace(/[.,]$/, "");
  if (!text) return null;
  const explicit = new Date(text);
  let date = Number.isFinite(explicit.getTime()) ? explicit : null;
  let precision = /\d:\d|T\d{2}:\d{2}|\b(?:am|pm)\b/i.test(text) ? "instant" : "date";
  if (!date) {
    const numeric = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text);
    if (!numeric) return null;
    let year = numeric[3] ? Number(numeric[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    date = new Date(year, Number(numeric[1]) - 1, Number(numeric[2]), 0, 0, 0, 0);
  } else if (!/\b\d{4}\b/.test(text)) {
    date.setFullYear(now.getFullYear());
  }
  if (precision === "date" && date.getTime() < now.getTime() - 31 * 24 * 60 * 60 * 1000) date.setFullYear(date.getFullYear() + 1);
  return { at: date.toISOString(), precision };
}

function parseResetInventoryText(text, now = new Date()) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!/usage limit resets/i.test(source)) return null;
  const availableMatch = /\b(\d+)\s+available\b/i.exec(source);
  const available = availableMatch ? Number(availableMatch[1]) : null;
  const items = [];
  const pattern = /full reset\s+expires\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)(?=\s+(?:use reset|full reset|add credits|$))/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const parsed = parseVisibleDate(match[1], now);
    if (!parsed) continue;
    items.push({
      id: safeKey(`full-reset-${parsed.at}-${items.length + 1}`),
      label: "Full reset",
      expiresAt: parsed.at,
      precision: parsed.precision,
      observedAt: now.toISOString(),
    });
  }
  if (available === null && items.length === 0) return null;
  return { available: available ?? items.length, items, observedAt: now.toISOString() };
}

function collectResetInventory(root, now = new Date()) {
  if (!root?.querySelectorAll) return null;
  const candidates = [...root.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="usage" i]')];
  for (const element of candidates) {
    const result = parseResetInventoryText(element.textContent, now);
    if (result) return result;
  }
  return null;
}

function recordResetInventory(inputState, rawInventory) {
  const state = normalizeState(inputState);
  if (!state) return { state: inputState, changed: false, usedCredit: false };
  const current = normalizeResetCredits(rawInventory);
  if (!current.observedAt) return { state, changed: false, usedCredit: false };
  const previous = state.resetCredits;
  const previousIds = new Set(previous.items.map((item) => item.id));
  const currentIds = new Set(current.items.map((item) => item.id));
  const removed = [...previousIds].filter((id) => !currentIds.has(id)).length;
  const usedCredit = previous.available !== null && current.available !== null
    ? current.available < previous.available
    : removed > 0;
  const changed = previous.available !== current.available
    || previous.items.length !== current.items.length
    || previous.items.some((item, index) => item.id !== current.items[index]?.id || item.expiresAt !== current.items[index]?.expiresAt);
  if (!changed) return { state, changed: false, usedCredit };
  const next = cloneState(state);
  next.resetCredits = current;
  next.resetCredits.pendingUsedAt = usedCredit ? current.observedAt : previous.pendingUsedAt;
  return { state: next, changed: true, usedCredit };
}

function classifyReset(previous, current, context = {}) {
  if (context.usedCredit) return "used-reset";
  if (previous?.resetAt) {
    const expected = Date.parse(previous.resetAt);
    const observed = Date.parse(current.observedAt);
    if (Number.isFinite(expected) && Number.isFinite(observed) && observed >= expected - 5 * 60 * 1000 && observed <= expected + 24 * 60 * 60 * 1000) {
      return "period-reset";
    }
  }
  return "openai-reset";
}

function pruneLimits(limits) {
  const entries = Object.entries(limits);
  if (entries.length <= MAX_TRACKED_LIMITS) return limits;
  entries.sort((a, b) => Date.parse(a[1].last.observedAt) - Date.parse(b[1].last.observedAt));
  return Object.fromEntries(entries.slice(-MAX_TRACKED_LIMITS));
}

function recordObservation(inputState, rawObservation, now = new Date(), context = {}) {
  const state = normalizeState(inputState);
  if (!state) return { state: inputState, status: "unknown", observation: null, transition: null };
  const observation = normalizeObservation(rawObservation, now);
  if (!observation) return { state, status: "unknown", observation: null, transition: null };

  const previousEntry = state.limits[observation.key];
  // A stable key whose displayed label changes is a schema/label change. Keep
  // the last-known-good record and surface Unknown rather than mixing epochs.
  if (previousEntry && (previousEntry.label !== observation.label || previousEntry.last.limit !== observation.limit)) {
    return { state, status: "unknown", observation, transition: null };
  }

  const next = cloneState(state);
  const previous = previousEntry?.last || null;
  const change = isConfirmedReset(previous, observation);
  const pendingUsedAt = Date.parse(state.resetCredits.pendingUsedAt || "");
  const observedAt = Date.parse(observation.observedAt);
  const usedCredit = context.usedCredit || (Number.isFinite(pendingUsedAt) && Number.isFinite(observedAt)
    && observedAt >= pendingUsedAt && observedAt - pendingUsedAt <= 5 * 60 * 1000);
  let transition = null;
  if (change.confirmed) {
    transition = {
      key: observation.key,
      label: observation.label,
      observedAt: observation.observedAt,
      resetAt: observation.resetAt,
      resetPrecision: observation.resetPrecision,
      previousObservedAt: previous.observedAt,
      previousRemaining: previous.remaining,
      remaining: observation.remaining,
      previousUsed: previous.used,
      used: observation.used,
      cause: classifyReset(previous, observation, { ...context, usedCredit }),
      reason: change.reason,
    };
    next.history = [...next.history, transition].slice(-MAX_HISTORY);
    if (transition.cause === "used-reset") next.resetCredits.pendingUsedAt = null;
  }
  next.limits[observation.key] = { label: observation.label, last: observation };
  next.limits = pruneLimits(next.limits);
  // Persist/re-render only on a *meaningful* change. A fresh observedAt on an
  // otherwise-identical counter is not one — treating it as a change is what
  // drove the write-and-re-render-on-every-scan loop.
  const changed = !!transition || !previous ||
    previous.remaining !== observation.remaining ||
    previous.used !== observation.used ||
    previous.limit !== observation.limit ||
    (previous.resetAt || null) !== (observation.resetAt || null);
  return {
    state: next,
    status: transition ? "reset" : "observed",
    observation,
    transition,
    changed,
    estimate: estimateNextReset(next, observation.key),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateNextReset(state, key) {
  const normalized = normalizeState(state);
  if (!normalized || !normalized.limits[key]) return UNKNOWN;
  const last = normalized.limits[key].last;
  if (last.resetAt) return { kind: "observed", label: "Observed", at: last.resetAt, precision: last.resetPrecision };
  const events = normalized.history
    .filter((event) => event.key === key)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (events.length < 2) return UNKNOWN;
  const intervals = [];
  for (let i = 1; i < events.length; i += 1) {
    const interval = Date.parse(events[i].observedAt) - Date.parse(events[i - 1].observedAt);
    if (interval > 0) intervals.push(interval);
  }
  const interval = median(intervals);
  if (!interval) return UNKNOWN;
  const at = new Date(Date.parse(events[events.length - 1].observedAt) + interval).toISOString();
  return { kind: "estimated", label: "Estimated", at };
}

function formatResetDisplay(value) {
  if (!value || value.kind === "unknown" || !value.at) return "Unknown";
  const date = new Date(value.at);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  const formatted = value.precision === "date"
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : date.toLocaleString();
  return `${value.label} · ${formatted}`;
}

function formatExpiration(item) {
  const date = new Date(item?.expiresAt);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return item.precision === "instant"
    ? date.toLocaleString()
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function resetCauseLabel(cause) {
  if (cause === "period-reset") return "Period reset";
  if (cause === "used-reset") return "Used reset";
  if (cause === "openai-reset") return "OpenAI reset";
  return "Unknown cause";
}

function parseDisplayedValues(text, element) {
  const source = String(text || "");
  const pair = /(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)/i.exec(source);
  let used = pair ? Number(pair[1].replace(/,/g, "")) : finiteNumber(element?.getAttribute?.("data-usage-used"));
  let limit = pair ? Number(pair[2].replace(/,/g, "")) : finiteNumber(element?.getAttribute?.("data-usage-limit"));
  const remainingMatch = /(\d[\d,]*)\s*(?:remaining|left)\b/i.exec(source)
    || /\b(?:remaining|left)\s*[:\-]?\s*(\d[\d,]*)/i.exec(source);
  let remaining = remainingMatch ? Number(remainingMatch[1].replace(/,/g, "")) : finiteNumber(element?.getAttribute?.("data-usage-remaining"));
  const percentLeft = /(\d+(?:\.\d+)?)%\s*left\b/i.exec(source);
  if (percentLeft) {
    limit = 100;
    remaining = Number(percentLeft[1]);
    used = Math.max(0, 100 - remaining);
  }
  if (limit === null && remaining !== null && used !== null) limit = used + remaining;
  return { used, limit, remaining };
}

function observationFromElement(element, now = new Date()) {
  if (!element || typeof element.getAttribute !== "function") return null;
  const dataset = element.dataset || {};
  const key = dataset.usageLimitKey || element.getAttribute("data-usage-limit-key")
    || dataset.testid || element.getAttribute("data-testid") || "usage-limit";
  const label = dataset.usageLimitLabel || element.getAttribute("aria-label") || "Usage limit";
  const values = parseDisplayedValues(element.textContent, element);
  if (values.limit === null) return null;
  const visibleReset = /\bresets\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i.exec(element.textContent || "");
  const parsedVisibleReset = visibleReset ? parseVisibleDate(visibleReset[1], now) : null;
  const explicitReset = dataset.resetAt || element.getAttribute("data-reset-at") || dataset.expiresAt || element.getAttribute("data-expires-at");
  return normalizeObservation({
    schemaVersion: SCHEMA_VERSION,
    key,
    label,
    used: values.used,
    limit: values.limit,
    remaining: values.remaining,
    // Only an explicit machine-readable timestamp is considered observed;
    // phrases such as "resets in an hour" are never converted from elapsed time.
    resetAt: explicitReset || parsedVisibleReset?.at,
    resetPrecision: explicitReset ? "instant" : (parsedVisibleReset?.precision || "instant"),
    observedAt: now,
  }, now);
}

function collectDisplayedObservations(root, now = new Date()) {
  if (!root?.querySelectorAll) return [];
  const selectors = [
    "[data-usage-limit-key]",
    "[data-usage-limit]",
    "[data-testid*='usage' i]",
    "[aria-label*='usage' i]",
    "[class*='usage' i]",
    '[role="dialog"]',
  ];
  const elements = new Set();
  if (typeof root.matches === "function" && selectors.some((selector) => root.matches(selector))) elements.add(root);
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) elements.add(element);
  }
  return [...elements].map((element) => observationFromElement(element, now)).filter(Boolean);
}

function annotateObservation(observation, estimate, instance) {
  if (typeof document === "undefined") return;
  // Keep the annotation conservative: the tracker adds a sibling badge and
  // never replaces the normal Codex usage text.
  const text = formatResetDisplay(estimate);
  for (const element of document.querySelectorAll("[data-usage-limit-key], [data-testid*='usage' i]")) {
    const candidate = observationFromElement(element);
    if (!candidate || candidate.key !== observation.key) continue;
    let badge = [...(element.parentElement?.querySelectorAll?.("[data-tweaker-usage-reset]") || [])]
      .find((item) => item.getAttribute("data-tweaker-usage-reset") === observation.key);
    if (!badge) {
      badge = document.createElement("span");
      badge.dataset.tweakerUsageReset = observation.key;
      badge.setAttribute("data-tweaker-usage-reset", observation.key);
      badge.className = "ml-2 text-token-text-secondary text-xs";
      element.insertAdjacentElement("afterend", badge);
      instance.badges.add(badge);
    }
    // Only touch the DOM when the text actually changes — an unchanged write
    // still mutates the text node and would re-arm the MutationObserver.
    const next = `Reset: ${text}`;
    if (badge.textContent !== next) badge.textContent = next;
  }
}

function pruneBadges(instance) {
  for (const badge of [...instance.badges]) {
    if (badge && badge.isConnected === false) instance.badges.delete(badge);
  }
}

function isSidebarUsageElement(element) {
  return Boolean(element?.closest?.('aside, nav, [role="navigation"], [data-sidebar], [class*="sidebar" i]'));
}

function hasConcreteNativeUsageContent(element) {
  return Boolean(element?.matches?.('[data-usage-limit-key], [data-usage-limit], [data-testid*="usage" i]')
    || element?.querySelector?.('[data-usage-limit-key], [data-usage-limit], [data-testid*="usage" i]'));
}

function nativeUsageSelectorTarget(matches) {
  if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
    const slots = Array.from(document.querySelectorAll('[data-tweakers-native-surface="usage"]'))
      .filter((element) => element?.isConnected !== false && typeof element.append === "function"
        && !isSidebarUsageElement(element) && hasConcreteNativeUsageContent(element));
    if (slots.length === 1) return slots[0];
  }
  const dialogs = [...new Set((Array.isArray(matches) ? matches : [])
    .filter((match) => match?.kind === "usage" && match.confidence === "high" && match.element?.isConnected !== false)
    .map((match) => match.element.closest?.('[role="dialog"], [aria-modal="true"]'))
    .filter((element) => element && typeof element.append === "function"
      && !isSidebarUsageElement(element) && hasConcreteNativeUsageContent(element)))];
  // Only a concrete Usage dialog is a safe native insertion target. Generic
  // sections and articles can be sidebar cards, so the owned Settings page is
  // the fallback when no dialog is unambiguous.
  return dialogs.length === 1 ? dialogs[0] : null;
}

function removeNativeUsageSelectors(instance) {
  const owned = typeof document !== "undefined"
    ? [...document.querySelectorAll?.('[data-tweakers-usage-account-selector="true"]') || []]
    : [];
  for (const node of [...(instance.nativeAccountSelectors || []), ...owned]) {
    try { node.remove?.(); } catch {}
  }
  instance.nativeAccountSelectors?.clear?.();
}

function pruneNativeUsageSelectors(instance) {
  for (const node of [...(instance.nativeAccountSelectors || [])]) {
    if (!node || node.isConnected === false) instance.nativeAccountSelectors.delete(node);
  }
}

function nativeUsageSelectorRevision(instance) {
  return String(Math.max(0, Number(instance.accountContextRevision) || 0));
}

function refreshNativeUsageAccountSelectors(instance, matches = null) {
  if (typeof document === "undefined" || instance?.stopped) return;
  pruneNativeUsageSelectors(instance);
  const context = instance.accountContext;
  const target = nativeUsageSelectorTarget(matches || instance.api?.react?.host?.query?.("usage") || []);
  if (!target || !context?.accounts?.length) {
    removeNativeUsageSelectors(instance);
    return;
  }
  // A route transition or earlier unsafe anchor can leave an owned card in a
  // sidebar. Remove every owned selector outside the concrete Usage target.
  const ownedSelectors = [...document.querySelectorAll?.('[data-tweakers-usage-account-selector="true"]') || []];
  for (const node of ownedSelectors) {
    if (!target.contains?.(node)) {
      try { node.remove?.(); } catch {}
      instance.nativeAccountSelectors.delete(node);
    }
  }
  const existing = [...(target.children || [])]
    .filter((child) => child?.dataset?.tweakersUsageAccountSelector === "true");
  const revision = nativeUsageSelectorRevision(instance);
  if (existing.length === 1 && existing[0].dataset.tweakersUsageAccountRevision === revision) {
    instance.nativeAccountSelectors.add(existing[0]);
    return;
  }
  for (const node of existing) {
    try { node.remove?.(); } catch {}
    instance.nativeAccountSelectors.delete(node);
  }
  const selector = renderNativeUsageAccountSelector(instance, context);
  if (!selector) return;
  target.dataset.tweakersHostSurfaceOwned = "true";
  selector.dataset.tweakersUsageAccountSelector = "true";
  selector.dataset.tweakersUsageAccountRevision = revision;
  selector.dataset.tweakersHostSurfaceOwned = "true";
  target.append(selector);
  instance.nativeAccountSelectors.add(selector);
}

function renderNativeUsageAccountSelector(instance, context) {
  if (!context?.accounts?.length) return null;
  const card = document.createElement("div");
  card.className = "border-token-border bg-token-foreground/5 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Subscription";
  const selector = document.createElement("select");
  selector.className = "border-token-border bg-token-bg-primary h-token-button-composer max-w-[280px] rounded-md border px-3 text-sm text-token-text-primary";
  selector.setAttribute("aria-label", "Usage subscription");
  for (const account of context.accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = account.label;
    selector.append(option);
  }
  selector.value = context.selectedAccountId || context.accounts[0].accountId;
  const selected = context.accounts.find((account) => account.accountId === selector.value) || context.accounts[0];
  const detail = document.createElement("div");
  detail.className = "text-token-text-secondary text-sm";
  detail.textContent = usageAccountContextText(selected);
  selector.addEventListener("change", () => {
    const accountId = safeAccountId(selector.value);
    if (!accountId) return;
    instance.accountContext = { ...context, selectedAccountId: accountId };
    instance.accountContextRevision += 1;
    dispatchAccountsEvent(ACCOUNTS_SELECTION_EVENT, { version: ACCOUNTS_CONTEXT_VERSION, accountId });
    if (instance.settingsRoot) renderSettings(instance.settingsRoot, instance);
    refreshNativeUsageAccountSelectors(instance);
  });
  copy.append(title, selector, detail);
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2";
  const credits = selected.quota?.resetCredits;
  if (Number.isInteger(credits) && credits > 0) {
    const useCredit = document.createElement("button");
    useCredit.type = "button";
    useCredit.className = "border-token-border bg-token-bg-primary hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary";
    useCredit.textContent = `Use reset credit (${credits})`;
    useCredit.addEventListener("click", () => requestUsageResetCredit(instance, selected.accountId));
    actions.append(useCredit);
  }
  card.append(copy, actions);
  return card;
}

function renderSettings(root, instance) {
  root.replaceChildren();
  root.className = "flex flex-col gap-4";
  root.appendChild(renderAccountsUsageContext(instance));
  const live = document.createElement("div");
  live.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
  const liveCount = instance.api?.react?.host?.snapshot?.("usage")?.count || 0;
  live.textContent = `Native Usage surfaces detected: ${liveCount}. Observations are recorded only from numeric displayed limits.`;
  root.appendChild(live);
  const title = document.createElement("div");
  title.className = "flex h-toolbar items-center justify-between gap-2 px-0 py-0";
  const inner = document.createElement("div");
  inner.className = "flex min-w-0 flex-1 flex-col gap-1";
  const heading = document.createElement("div");
  heading.className = "text-base font-medium text-token-text-primary";
  heading.textContent = "Usage limit resets";
  const subtitle = document.createElement("div");
  subtitle.className = "text-token-text-secondary text-sm";
  subtitle.textContent = "Only displayed transitions are recorded. Estimates are derived from local observations.";
  inner.append(heading, subtitle);
  title.appendChild(inner);
  root.appendChild(title);

  const card = document.createElement("div");
  card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  const entries = Object.values(instance.state.limits);
  if (instance.unknownSchema) {
    const unknown = document.createElement("div");
    unknown.className = "p-3 text-sm text-token-text-secondary";
    unknown.textContent = "Unknown usage history schema. Existing data was left unchanged.";
    card.appendChild(unknown);
  } else if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "p-3 text-sm text-token-text-secondary";
    empty.textContent = "No usage limits observed yet.";
    card.appendChild(empty);
  } else {
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-4 p-3";
      const label = document.createElement("div");
      label.className = "min-w-0 text-sm text-token-text-primary";
      label.textContent = entry.label;
      const value = document.createElement("div");
      value.className = "text-token-text-secondary text-sm";
      value.textContent = `${entry.last.remaining} remaining · ${formatResetDisplay(estimateNextReset(instance.state, entry.last.key))}`;
      row.append(label, value);
      card.appendChild(row);
    }
  }
  root.appendChild(card);

  const creditsTitle = document.createElement("div");
  creditsTitle.className = "text-sm font-medium text-token-text-primary";
  creditsTitle.textContent = `Available full resets${instance.state.resetCredits.available === null ? "" : ` · ${instance.state.resetCredits.available}`}`;
  root.appendChild(creditsTitle);
  const creditsCard = document.createElement("div");
  creditsCard.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  creditsCard.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  if (!instance.state.resetCredits.items.length) {
    const empty = document.createElement("div");
    empty.className = "p-3 text-sm text-token-text-secondary";
    empty.textContent = "Open the Usage dialog to observe reset expirations.";
    creditsCard.appendChild(empty);
  } else {
    for (const item of instance.state.resetCredits.items) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-4 p-3";
      const label = document.createElement("div");
      label.className = "text-sm text-token-text-primary";
      label.textContent = item.label;
      const expiry = document.createElement("div");
      expiry.className = "text-sm text-token-text-secondary";
      expiry.textContent = `Expires ${formatExpiration(item)}`;
      row.append(label, expiry);
      creditsCard.appendChild(row);
    }
  }
  root.appendChild(creditsCard);

  const historyTitle = document.createElement("div");
  historyTitle.className = "text-sm font-medium text-token-text-primary";
  historyTitle.textContent = "Reset history";
  root.appendChild(historyTitle);
  const historyCard = document.createElement("div");
  historyCard.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  historyCard.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  if (!instance.state.history.length) {
    const empty = document.createElement("div");
    empty.className = "p-3 text-sm text-token-text-secondary";
    empty.textContent = "No observed resets yet.";
    historyCard.appendChild(empty);
  } else {
    for (const event of [...instance.state.history].reverse()) {
      const row = document.createElement("div");
      row.className = "flex items-start justify-between gap-4 p-3";
      const copy = document.createElement("div");
      copy.className = "min-w-0";
      const label = document.createElement("div");
      label.className = "text-sm text-token-text-primary";
      label.textContent = event.label;
      const detail = document.createElement("div");
      detail.className = "text-sm text-token-text-secondary";
      detail.textContent = `${new Date(event.observedAt).toLocaleString()} · ${event.previousRemaining} → ${event.remaining} remaining`;
      copy.append(label, detail);
      const cause = document.createElement("span");
      cause.className = "shrink-0 rounded-full bg-token-foreground/5 px-2 py-0.5 text-sm text-token-text-secondary";
      cause.textContent = resetCauseLabel(event.cause);
      row.append(copy, cause);
      historyCard.appendChild(row);
    }
  }
  root.appendChild(historyCard);

  const actions = document.createElement("div");
  actions.className = "flex items-center justify-between gap-2";
  const history = document.createElement("div");
  history.className = "text-token-text-secondary text-sm";
  history.textContent = `${instance.state.history.length} observed reset${instance.state.history.length === 1 ? "" : "s"}`;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "rounded-full px-2 py-0.5 text-sm bg-token-charts-red/10 text-token-charts-red hover:bg-token-charts-red/20 cursor-interaction";
  clear.textContent = "Clear history";
  clear.addEventListener("click", () => {
    if (!window.confirm("Clear observed usage reset history?")) return;
    instance.state = clearHistory(instance.state);
    instance.unknownSchema = false;
    writeState(instance.storage, instance.state);
    renderSettings(root, instance);
  });
  actions.append(history, clear);
  root.appendChild(actions);
}

function renderAccountsUsageContext(instance) {
  const card = document.createElement("div");
  card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  const context = instance.accountContext;
  const row = document.createElement("div");
  row.className = "flex flex-wrap items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Selected subscription";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  if (!context?.accounts?.length) {
    detail.textContent = "Open Accounts to choose a subscription for reset-credit actions.";
    copy.append(title, detail);
    row.append(copy);
    card.append(row);
    return card;
  }
  const selector = document.createElement("select");
  selector.className = "border-token-border bg-token-foreground/5 h-token-button-composer max-w-[280px] rounded-md border px-3 text-sm text-token-text-primary";
  selector.setAttribute("aria-label", "Usage subscription");
  for (const account of context.accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = account.label;
    selector.append(option);
  }
  selector.value = context.selectedAccountId || context.accounts[0].accountId;
  const selected = context.accounts.find((account) => account.accountId === selector.value) || context.accounts[0];
  detail.textContent = usageAccountContextText(selected);
  selector.addEventListener("change", () => {
    const accountId = safeAccountId(selector.value);
    if (!accountId) return;
    instance.accountContext = { ...context, selectedAccountId: accountId };
    instance.accountContextRevision += 1;
    dispatchAccountsEvent(ACCOUNTS_SELECTION_EVENT, { version: ACCOUNTS_CONTEXT_VERSION, accountId });
    if (instance.settingsRoot) renderSettings(instance.settingsRoot, instance);
    refreshNativeUsageAccountSelectors(instance);
  });
  copy.append(title, selector, detail);
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2";
  const credits = selected.quota?.resetCredits;
  if (Number.isInteger(credits) && credits > 0) {
    const useCredit = document.createElement("button");
    useCredit.type = "button";
    useCredit.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary";
    useCredit.textContent = `Use reset credit (${credits})`;
    useCredit.addEventListener("click", () => requestUsageResetCredit(instance, selected.accountId));
    actions.append(useCredit);
  }
  row.append(copy, actions);
  card.append(row);
  if (instance.resetCreditStatus) {
    const status = document.createElement("div");
    status.className = "p-3 text-sm text-token-text-secondary";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = instance.resetCreditStatus;
    card.append(status);
  }
  return card;
}

function usageAccountContextText(account) {
  if (!account) return "Subscription context is unavailable.";
  const quota = account.quota || {};
  if (quota.depleted) return `Usage is depleted${quota.resetAt ? ` · resets ${formatExpiration({ expiresAt: quota.resetAt, precision: "instant" })}` : ""}`;
  return Number.isFinite(quota.remainingPercent)
    ? `${quota.remainingPercent}% usage left${quota.resetAt ? ` · resets ${formatExpiration({ expiresAt: quota.resetAt, precision: "instant" })}` : ""}`
    : "Usage is not available yet.";
}

function dispatchAccountsEvent(type, detail) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return false;
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
    return true;
  } catch { return false; }
}

function requestUsageResetCredit(instance, accountId) {
  if (!safeAccountId(accountId)) return;
  if (typeof window !== "undefined" && typeof window.confirm === "function"
    && !window.confirm("Use one reset credit for this subscription? This cannot be undone and never happens automatically.")) return;
  const requestId = usageContextRequestId(instance);
  instance.pendingResetCreditRequestId = requestId;
  instance.resetCreditStatus = "Requesting a reset credit…";
  const delivered = dispatchAccountsEvent(ACCOUNTS_RESET_REQUEST_EVENT, { version: ACCOUNTS_CONTEXT_VERSION, requestId, accountId });
  if (!delivered) {
    instance.pendingResetCreditRequestId = null;
    instance.resetCreditStatus = "Accounts is unavailable, so the reset credit was not used.";
  }
  if (instance.settingsRoot) renderSettings(instance.settingsRoot, instance);
  refreshNativeUsageAccountSelectors(instance);
}

function handleAccountsContext(instance, raw) {
  const context = normalizeAccountsContext(raw);
  if (!context) return;
  instance.accountContext = context;
  instance.accountContextRevision += 1;
  if (instance.settingsRoot) renderSettings(instance.settingsRoot, instance);
  refreshNativeUsageAccountSelectors(instance);
}

function handleAccountsResetResult(instance, raw) {
  if (!raw || typeof raw !== "object" || raw.version !== ACCOUNTS_CONTEXT_VERSION
    || raw.requestId !== instance.pendingResetCreditRequestId || typeof raw.ok !== "boolean") return;
  instance.pendingResetCreditRequestId = null;
  if (!raw.ok) {
    instance.resetCreditStatus = "The reset credit was not used. No usage history was changed.";
  } else {
    instance.resetCreditStatus = raw.result?.continuation?.confirmationId
      ? "Confirmation is required in Accounts before the reset credit can be used."
      : raw.result?.consumed === true ? "One reset credit was used. Observed history stays here in Usage Limit Resets Tracker."
        : "The reset-credit request was completed.";
    const accountId = safeAccountId(raw.result?.accountId);
    const quota = safeAccountContextQuota(raw.result?.quota);
    const account = instance.accountContext?.accounts?.find((candidate) => candidate.accountId === accountId);
    if (account && quota) account.quota = quota;
  }
  instance.accountContextRevision += 1;
  if (instance.settingsRoot) renderSettings(instance.settingsRoot, instance);
  refreshNativeUsageAccountSelectors(instance);
}

function startTracker(api, instance) {
  const stored = readStoredState(api.storage);
  instance.state = stored.state;
  instance.unknownSchema = stored.unknownSchema;
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const onAccountsContext = (event) => handleAccountsContext(instance, event?.detail);
    const onResetResult = (event) => handleAccountsResetResult(instance, event?.detail);
    window.addEventListener(ACCOUNTS_CONTEXT_EVENT, onAccountsContext);
    window.addEventListener(ACCOUNTS_RESET_RESULT_EVENT, onResetResult);
    instance.cleanups.push(() => window.removeEventListener(ACCOUNTS_CONTEXT_EVENT, onAccountsContext));
    instance.cleanups.push(() => window.removeEventListener(ACCOUNTS_RESET_RESULT_EVENT, onResetResult));
    // Accounts runs continuously in the renderer. Request its bounded context
    // when this page starts so Usage does not need to inspect account state or
    // retain any account credentials of its own.
    dispatchAccountsEvent(ACCOUNTS_CONTEXT_REQUEST_EVENT, { version: ACCOUNTS_CONTEXT_VERSION });
  }
  if (api.settings?.registerPage) {
    instance.settings = api.settings.registerPage({
      id: "usage-history",
      title: "Usage Limit Resets Tracker",
      description: "Observed usage-limit resets and bounded local estimates.",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4l2.5 1.5M5 3.5 3.5 5M15 3.5 16.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      render(root) {
        instance.settingsRoot = root;
        renderSettings(root, instance);
        return () => {
          if (instance.settingsRoot === root) instance.settingsRoot = null;
          root.replaceChildren();
        };
      },
    });
  }

  const scan = () => {
    if (instance.scanning) return;
    instance.scanning = true;
    try {
      pruneBadges(instance);
      let changed = false;
      let observed = 0;
      const semantic = api.react?.host?.query?.("usage") || [];
      refreshNativeUsageAccountSelectors(instance, semantic);
      const observations = semantic.length
        ? semantic.flatMap((match) => collectDisplayedObservations(match.element, new Date()))
        : collectDisplayedObservations(document, new Date());
      const inventory = semantic.length
        ? semantic.map((match) => collectResetInventory(match.element, new Date())).find(Boolean) || null
        : collectResetInventory(document, new Date());
      const inventoryResult = inventory
        ? recordResetInventory(instance.state, inventory)
        : { state: instance.state, changed: false, usedCredit: false };
      instance.state = inventoryResult.state;
      if (inventoryResult.changed) changed = true;
      for (const observation of observations) {
        observed += 1;
        const result = recordObservation(instance.state, observation, new Date(), { usedCredit: inventoryResult.usedCredit });
        if (result.status === "unknown" || instance.unknownSchema) continue;
        instance.state = result.state;
        // Persist and re-render only on a real change so this scan's own DOM
        // writes (badge + settings) don't feed the observer another scan.
        if (result.changed) changed = true;
        annotateObservation(observation, result.estimate || estimateNextReset(instance.state, observation.key), instance);
      }
      if (changed) writeState(api.storage, instance.state);
      if (changed && instance.settingsRoot) renderSettings(instance.settingsRoot, instance);
      // "Loaded but found nothing to annotate" must be distinguishable from
      // "broken": if the native usage DOM never appears (e.g. signed-out
      // session, native usage panel stuck loading), say so once.
      if (observed > 0) {
        instance.emptyScans = 0;
        instance.warnedNoUsageDom = false;
      } else if (!instance.warnedNoUsageDom && ++instance.emptyScans >= 50) {
        instance.warnedNoUsageDom = true;
        api.log?.warn?.("no native usage elements found after repeated scans; nothing to annotate (native usage UI absent or not loaded)");
      }
    } finally {
      instance.scanning = false;
    }
  };
  instance.emptyScans = 0;
  instance.scan = scan;
  const disposeHost = api.react?.host?.observe?.(["usage"], () => {
    if (instance.scanQueued) return;
    instance.scanQueued = true;
    queueMicrotask(() => {
      instance.scanQueued = false;
      scan();
    });
  });
  instance.observer = disposeHost ? { disconnect: disposeHost } : null;
  api.react?.waitForElement?.("[data-usage-limit-key], [data-testid*='usage' i]", 5000).then(scan).catch(() => {});
  scan();
}

const tweak = {
  start(api) {
    if (api.process !== "renderer") return;
    const instance = {
      api,
      state: emptyState(),
      storage: api.storage,
      observer: null,
      settings: null,
      settingsRoot: null,
      badges: new Set(),
      cleanups: [],
      scanning: false,
      scanQueued: false,
      unknownSchema: false,
      accountContext: null,
      accountContextRevision: 0,
      resetCreditStatus: "",
      pendingResetCreditRequestId: null,
      contextRequestNonce: 0,
      nativeAccountSelectors: new Set(),
      stopped: false,
    };
    this._instance = instance;
    startTracker(api, instance);
  },
  stop() {
    const instance = this._instance;
    if (!instance) return;
    instance.stopped = true;
    instance.observer?.disconnect?.();
    for (const badge of instance.badges) badge.remove?.();
    instance.badges.clear();
    removeNativeUsageSelectors(instance);
    if (typeof document !== "undefined") {
      for (const node of document.querySelectorAll?.("[data-tweakers-usage-account-selector]") || []) node.remove?.();
    }
    for (const cleanup of instance.cleanups.splice(0).reverse()) {
      try { cleanup(); } catch {}
    }
    instance.settings?.unregister?.();
    instance.settingsRoot?.replaceChildren?.();
    this._instance = null;
  },
};

module.exports = tweak;
module.exports.__test = {
  STORAGE_KEY,
  SCHEMA_VERSION,
  MAX_HISTORY,
  MAX_TRACKED_LIMITS,
  emptyState,
  normalizeObservation,
  normalizeState,
  readState,
  readStoredState,
  writeState,
  clearHistory,
  isConfirmedReset,
  parseVisibleDate,
  parseResetInventoryText,
  collectResetInventory,
  recordResetInventory,
  classifyReset,
  recordObservation,
  estimateNextReset,
  formatResetDisplay,
  parseDisplayedValues,
  observationFromElement,
  collectDisplayedObservations,
  formatExpiration,
  resetCauseLabel,
  pruneBadges,
  normalizeAccountsContext,
  safeAccountContextQuota,
  safeAccountId,
  nativeUsageSelectorTarget,
  usageDisplayState(instance) {
    return instance?.unknownSchema ? "Unknown" : Object.keys(instance?.state?.limits || {}).length ? "Observed" : "Empty";
  },
};

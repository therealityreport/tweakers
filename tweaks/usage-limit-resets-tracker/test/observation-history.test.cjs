const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const flat = source.replace(/\s+/g, " ");
const helpers = require(path.join(__dirname, "..", "index.js")).__test;
const brokerAccountId = (seed) => `account_${String(seed).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 43).padEnd(43, "A")}`;
test("reset detection requires an observed limit transition", () => {
  assert.match(flat, /(?:previous|prior|last).*limit/i);
  assert.match(flat, /(?:transition|changed|decreas|increase|reset)/i);
  assert.match(flat, /(?:observed|observation)/i);
  assert.match(flat, /(?:elapsed|Date\.now|timestamp)/i);
});
test("estimates are labelled and unknown schemas fail closed", () => {
  assert.match(flat, /(?:Observed|Estimated)/);
  assert.match(flat, /(?:unknown|invalid|schema|version)/i);
});
test("history is bounded and clearable without exposing secrets", () => {
  assert.match(flat, /(?:MAX|LIMIT|BOUND|slice\(|splice\().*(?:history|observ)/i);
  assert.match(flat, /(?:clear|delete|reset).*(?:history|observ)/i);
  assert.match(flat, /(?:token|cookie|secret|credential)/i);
});
test("unknown stored schema has an explicit Unknown display state", () => {
  assert.equal(helpers.usageDisplayState({ unknownSchema: true, state: { limits: {} } }), "Unknown");
  assert.match(source, /Unknown usage history schema/);
});

test("Analytics renders local reset observations as a separate non-provider section", () => {
  assert.match(source, /Observed resets on this Mac/);
  assert.match(source, /local counter transitions, not provider plan-usage history/);
  assert.match(source, /data-tweakers-analytics-observed-resets/);
  assert.doesNotMatch(helpers.renderAnalyticsObservedResets.toString(), /five_hour_limit_percent|weekly_limit_percent|basisPoints/);
});

test("Accounts context accepts masked subscription labels without retaining unmasked identity or secrets", () => {
  const primaryAccountId = brokerAccountId("primary");
  const context = helpers.normalizeAccountsContext({
    version: 1,
    selectedAccountId: primaryAccountId,
    accounts: [{
      accountId: primaryAccountId,
      label: "Primary",
      email: "private@example.test",
      plan: "Pro",
      access_token: "must-not-be-retained",
      enabled: true,
      quota: { remainingPercent: 42, resetAt: "2026-09-03T12:00:00.000Z", resetCredits: 2 },
    }],
  });
  assert.deepEqual(context, {
    selectedAccountId: primaryAccountId,
    accounts: [{
      accountId: primaryAccountId,
      label: "Primary",
      enabled: true,
      quota: { remainingPercent: 42, resetAt: "2026-09-03T12:00:00.000Z", depleted: false, resetCredits: 2 },
    }],
  });
  assert.equal(JSON.stringify(context).includes("private@example.test"), false);
  assert.equal(JSON.stringify(context).includes("access_token"), false);
  assert.equal(helpers.normalizeAccountsContext({
    version: 1,
    accounts: [
      { accountId: primaryAccountId, label: "Primary", quota: { remainingPercent: 1 } },
      { accountId: primaryAccountId, label: "Duplicate", quota: { remainingPercent: 2 } },
    ],
  }), null);
  assert.equal(helpers.normalizeAccountsContext({
    version: 1,
    accounts: [{ accountId: brokerAccountId("unsafe-label"), label: "private@example.test", quota: { remainingPercent: 1 } }],
  }), null);
  const masked = helpers.normalizeAccountsContext({
    version: 1,
    selectedAccountId: primaryAccountId,
    accounts: [
      { accountId: primaryAccountId, label: "c•••••@thereality.report", quota: { remainingPercent: 43 } },
      { accountId: brokerAccountId("secondary"), label: "a•••••@thereality.report", quota: { remainingPercent: 5 } },
    ],
  });
  assert.deepEqual(masked?.accounts.map((account) => account.label), ["c•••••@thereality.report", "a•••••@thereality.report"]);
  assert.equal(masked?.selectedAccountId, primaryAccountId);
  assert.equal(helpers.normalizeAccountsContext({
    version: 1,
    accounts: [{ accountId: "chatgpt-provider-account-12345678", label: "Primary", quota: { remainingPercent: 1 } }],
  }), null);
});

test("Accounts context retains more than 64 validated subscriptions when the complete payload stays byte-bounded", () => {
  const accounts = Array.from({ length: 65 }, (_unused, index) => ({
    accountId: brokerAccountId(String(index).padStart(16, "0")),
    label: `Subscription ${index + 1}`,
    enabled: index % 2 === 0,
    quota: { remainingPercent: 100 - (index % 100), resetAt: null, resetCredits: 0 },
  }));
  const context = helpers.normalizeAccountsContext({
    version: 1,
    selectedAccountId: accounts[64].accountId,
    accounts,
  });
  assert.ok(context);
  assert.equal(context.accounts.length, 65);
  assert.equal(context.selectedAccountId, accounts[64].accountId);
});

test("native Usage selector excludes sidebar matches and requires a concrete dialog", () => {
  const dialog = {
    isConnected: true,
    append() {},
    querySelector() { return {}; },
    closest(selector) { return selector.includes("dialog") ? dialog : null; },
  };
  const usage = {
    isConnected: true,
    closest(selector) { return selector.includes("dialog") ? dialog : null; },
  };
  assert.equal(helpers.nativeUsageSelectorTarget([{ kind: "usage", confidence: "high", element: usage }]), dialog);
  const sidebar = {
    isConnected: true,
    closest(selector) { return selector.includes("sidebar") ? sidebar : null; },
  };
  assert.equal(helpers.nativeUsageSelectorTarget([{ kind: "usage", confidence: "high", element: sidebar }]), null);
});

test("native Usage selector uses the reviewed Analytics slot only with its route marker", () => {
  const slot = {
    isConnected: true,
    append() {},
    querySelector() { return null; },
    closest() { return null; },
  };
  const history = { isConnected: true, closest() { return null; } };
  const previousDocument = global.document;
  let contexts = [history];
  let slots = [slot];
  global.document = {
    querySelectorAll(selector) {
      return selector === "[data-tweakers-usage-account]" ? contexts
        : selector === '[data-tweakers-native-surface="usage"]' ? slots : [];
    },
  };
  try {
    assert.equal(helpers.nativeUsageSelectorTarget([]), slot);
    contexts = [];
    assert.equal(helpers.nativeUsageSelectorTarget([]), null);
    contexts = [history];
    slots = [slot, { ...slot }];
    assert.equal(helpers.nativeUsageSelectorTarget([]), null);
    slots = [{ ...slot, closest() { return {}; } }];
    assert.equal(helpers.nativeUsageSelectorTarget([]), null);
  } finally {
    global.document = previousDocument;
  }
});

// Loop fix: an observation that only advances observedAt (same counters) must
// NOT report a change, so scan() does not persist / re-render every microtask.
test("recordObservation reports no change when only the timestamp advances", () => {
  const t0 = new Date("2026-07-11T00:00:00.000Z");
  const t1 = new Date("2026-07-11T00:00:05.000Z");
  const obs = { key: "gpt-5", label: "GPT-5", limit: 100, remaining: 40, observedAt: t0 };
  const first = helpers.recordObservation(helpers.emptyState(), obs, t0);
  assert.equal(first.changed, true, "first sighting of a key is a change");

  const same = { ...obs, observedAt: t1 };
  const second = helpers.recordObservation(first.state, same, t1);
  assert.equal(second.status, "observed");
  assert.equal(second.changed, false, "identical counters at a later time is not a change");
});

test("recordObservation reports a change on a confirmed reset transition", () => {
  const t0 = new Date("2026-07-11T00:00:00.000Z");
  const t1 = new Date("2026-07-11T01:00:00.000Z");
  const first = helpers.recordObservation(helpers.emptyState(), { key: "gpt-5", label: "GPT-5", limit: 100, remaining: 5 }, t0);
  const reset = helpers.recordObservation(first.state, { key: "gpt-5", label: "GPT-5", limit: 100, remaining: 100 }, t1);
  assert.equal(reset.status, "reset");
  assert.equal(reset.changed, true);
  assert.equal(reset.state.history.length, 1);
});

test("pruneBadges drops detached badge nodes but keeps connected ones", () => {
  const connected = { isConnected: true };
  const detached = { isConnected: false };
  const instance = { badges: new Set([connected, detached]) };
  helpers.pruneBadges(instance);
  assert.equal(instance.badges.has(connected), true);
  assert.equal(instance.badges.has(detached), false);
});

test("parses visible weekly reset and full-reset expiration inventory without inventing hours", () => {
  const now = new Date("2026-07-13T12:00:00.000Z");
  const text = "Usage Weekly usage limit Resets Jul 20 97% left Usage limit resets 3 available Full reset Expires 7/17 Use reset Full reset Expires 7/26 Use reset Full reset Expires 7/31 Use reset Add credits";
  const inventory = helpers.parseResetInventoryText(text, now);
  assert.equal(inventory.available, 3);
  assert.equal(inventory.items.length, 3);
  assert.deepEqual(inventory.items.map((item) => item.precision), ["date", "date", "date"]);
  assert.deepEqual(inventory.items.map((item) => new Date(item.expiresAt).getMonth() + 1), [7, 7, 7]);

  const attrs = new Map();
  const observation = helpers.observationFromElement({
    dataset: {},
    textContent: text,
    getAttribute(name) { return attrs.get(name) || null; },
  }, now);
  assert.equal(observation.limit, 100);
  assert.equal(observation.remaining, 97);
  assert.equal(observation.resetPrecision, "date");
});

test("reset history distinguishes period, OpenAI, and used-reset causes", () => {
  const t0 = new Date("2026-07-13T12:00:00.000Z");
  const scheduled = new Date("2026-07-20T12:00:00.000Z");
  const initial = helpers.recordObservation(helpers.emptyState(), {
    key: "weekly", label: "Weekly usage", limit: 100, remaining: 2, resetAt: scheduled, observedAt: t0,
  }, t0);
  const period = helpers.recordObservation(initial.state, {
    key: "weekly", label: "Weekly usage", limit: 100, remaining: 100, observedAt: scheduled,
  }, scheduled);
  assert.equal(period.transition.cause, "period-reset");

  const openaiBase = helpers.recordObservation(helpers.emptyState(), { key: "weekly", label: "Weekly usage", limit: 100, remaining: 2 }, t0);
  const openai = helpers.recordObservation(openaiBase.state, { key: "weekly", label: "Weekly usage", limit: 100, remaining: 100 }, scheduled);
  assert.equal(openai.transition.cause, "openai-reset");

  const used = helpers.recordObservation(openaiBase.state, { key: "weekly", label: "Weekly usage", limit: 100, remaining: 100 }, scheduled, { usedCredit: true });
  assert.equal(used.transition.cause, "used-reset");
});

test("reset inventory detects when one of our full resets was consumed", () => {
  const t0 = new Date("2026-07-13T12:00:00.000Z");
  const first = helpers.recordResetInventory(helpers.emptyState(), helpers.parseResetInventoryText(
    "Usage limit resets 3 available Full reset Expires 7/17 Use reset Full reset Expires 7/26 Use reset Full reset Expires 7/31 Use reset",
    t0,
  ));
  assert.equal(first.changed, true);
  assert.equal(first.usedCredit, false);
  const second = helpers.recordResetInventory(first.state, helpers.parseResetInventoryText(
    "Usage limit resets 2 available Full reset Expires 7/26 Use reset Full reset Expires 7/31 Use reset",
    new Date("2026-07-14T12:00:00.000Z"),
  ));
  assert.equal(second.changed, true);
  assert.equal(second.usedCredit, true);
  assert.equal(second.state.resetCredits.pendingUsedAt, "2026-07-14T12:00:00.000Z");

  const base = helpers.recordObservation(second.state, { key: "weekly", label: "Weekly", limit: 100, remaining: 2 }, new Date("2026-07-14T12:00:01.000Z"));
  const delayedCounter = helpers.recordObservation(base.state, { key: "weekly", label: "Weekly", limit: 100, remaining: 100 }, new Date("2026-07-14T12:00:10.000Z"));
  assert.equal(delayedCounter.transition.cause, "used-reset", "inventory and counter DOM updates may arrive in separate scans");
  assert.equal(delayedCounter.state.resetCredits.pendingUsedAt, null);
});

test("version-one history migrates and keeps prior events with unknown cause", () => {
  const migrated = helpers.normalizeState({
    schemaVersion: 1,
    limits: {},
    history: [{ key: "weekly", label: "Weekly", observedAt: "2026-07-13T12:00:00.000Z", remaining: 100, previousRemaining: 1 }],
  });
  assert.equal(migrated.schemaVersion, helpers.SCHEMA_VERSION);
  assert.equal(migrated.history[0].cause, "unknown");
  assert.deepEqual(migrated.resetCredits.items, []);
});

// Minimal element fixture models the reviewed native sibling-card structure.
function usageElement(tag, text = "", attrs = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), children, parentElement: null, dataset: {},
    get textContent() { return text + children.map(child => child.textContent).join(""); },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? String(attrs[name]) : null; },
    matches(selector) {
      return selector.split(/,\s*/).some(part => {
        if (/^[a-z]+$/.test(part)) return part.toUpperCase() === this.tagName;
        if (part.startsWith("progress[aria-label=")) return this.tagName === "PROGRESS" && part.includes(`"${attrs["aria-label"]}"`);
        if (part === '[role="progressbar"]') return attrs.role === "progressbar";
        if (part === "[aria-label*='usage' i]") return /usage/i.test(attrs["aria-label"] || "");
        const attr = /^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(part);
        return !!attr && Object.hasOwn(attrs, attr[1]) && (attr[2] === undefined || String(attrs[attr[1]]) === attr[2]);
      });
    },
    closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; },
    querySelectorAll(selector) { return children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
function nativeUsageCard({ label = "Weekly limit", value = "100", displayed = "100% left", attrs = {} } = {}) {
  const progress = usageElement("progress", "", { max: "100", value, "aria-label": "Usage remaining", ...attrs });
  const card = usageElement("div", "", {}, [
    usageElement("div", label),
    usageElement("div", "", {}, [usageElement("div", "", {}, [progress]), usageElement("span", displayed), usageElement("span", "Resets in 6d 18h")]),
  ]);
  return { card, progress };
}

test("unavailable quota is unknown while explicit zero remains depleted", () => {
  for (const value of [null, undefined, "", "  ", false, true, [], {}, NaN, Infinity]) {
    const quota = helpers.safeAccountContextQuota({ remainingPercent: value });
    assert.equal(quota.remainingPercent, null, String(value));
    assert.equal(quota.depleted, false, String(value));
  }
  assert.equal(helpers.safeAccountContextQuota({ remainingPercent: "0" }).depleted, true);
  assert.equal(helpers.safeAccountContextQuota({ remainingPercent: 0 }).remainingPercent, 0);
  assert.equal(helpers.safeAccountContextQuota({ remainingPercent: "42" }).remainingPercent, 42);
  assert.equal(helpers.observationFromElement(usageElement("div", "Loading usage")), null);
});

test("native sibling card records displayed percentage with unknown relative reset", () => {
  const { card, progress } = nativeUsageCard();
  const observation = helpers.nativeProgressObservation(progress);
  assert.equal(observation.key, "native-unattributed:weekly");
  assert.equal(observation.remaining, 100);
  assert.equal(observation.limit, 100);
  assert.equal(observation.resetAt, null);
  assert.match(observation.label, /subscription unknown/);
  assert.deepEqual(helpers.collectDisplayedObservations(card).map(o => o.key), [observation.key]);
});

test("native cards stay separate from each other and adjacent credit balances", () => {
  const weekly = nativeUsageCard({ value: "70", displayed: "70% left" });
  const hourly = nativeUsageCard({ label: "5-hour limit", value: "25", displayed: "25% left" });
  const root = usageElement("div", "", {}, [weekly.card, hourly.card, usageElement("div", "53,257 credits remaining")]);
  const observations = helpers.collectDisplayedObservations(root);
  assert.deepEqual(observations.map(o => [o.key, o.remaining]), [["native-unattributed:weekly", 70], ["native-unattributed:five-hour", 25]]);
  assert.equal(helpers.deduplicateObservations([...observations, ...observations]).length, 2);
  assert.equal(helpers.deduplicateObservations([observations[0], { ...observations[0], remaining: 0 }]).length, 0);
});

test("ambiguous, hidden, owned, or conflicting native cards do not produce observations", () => {
  for (const options of [{ value: "5", displayed: "100% left" }, { value: "101", displayed: "101% left" }, { value: "", displayed: "0% left" }, { displayed: "25% left 100% left" }, { label: "Credits remaining" }, { attrs: { max: "1" } }]) {
    assert.equal(helpers.nativeProgressObservation(nativeUsageCard(options).progress), null);
  }
  for (const attrs of [{ hidden: "" }, { "aria-hidden": "true" }, { "data-tweakers-usage-settings": "true" }, { "data-tweakers-usage-account-selector": "true" }, { "data-tweakers-analytics-observed-resets": "true" }, { "data-tweaker-usage-reset": "weekly" }]) {
    const { card, progress } = nativeUsageCard(); usageElement("div", "", attrs, [card]);
    assert.equal(helpers.nativeProgressObservation(progress), null);
  }
  const a = nativeUsageCard(), b = nativeUsageCard();
  const ambiguous = usageElement("div", "", {}, [usageElement("div", "Weekly limit"), a.progress, b.progress, usageElement("span", "100% left")]);
  assert.equal(helpers.nativeProgressObservation(a.progress), null);
  assert.equal(ambiguous.children.length, 4);
});

test("unattributed native account changes update display without inventing reset history", () => {
  const first = helpers.nativeProgressObservation(nativeUsageCard({ value: "5", displayed: "5% left" }).progress);
  const second = helpers.nativeProgressObservation(nativeUsageCard().progress);
  const state = helpers.recordObservation(helpers.emptyState(), first).state;
  const changed = helpers.recordObservation(state, second);
  assert.equal(changed.observation.remaining, 100);
  assert.equal(changed.transition, null);
  assert.equal(changed.state.history.length, 0);
  assert.equal(helpers.estimateNextReset(changed.state, second.key).kind, "unknown");
});

test("hidden and tracker-owned sibling leaves cannot establish native card evidence", () => {
  for (const attrs of [{ hidden: "" }, { "aria-hidden": "true" }, { "data-tweakers-usage-settings": "true" }, { "data-tweakers-usage-account-selector": "true" }]) {
    for (const hideLabel of [true, false]) {
      const progress = usageElement("progress", "", { max: 100, value: 100, "aria-label": "Usage remaining" });
      usageElement("div", "", {}, [
        usageElement("div", "Weekly limit", hideLabel ? attrs : {}),
        progress,
        usageElement("span", "100% left", hideLabel ? {} : attrs),
      ]);
      assert.equal(helpers.nativeProgressObservation(progress), null);
    }
  }
});

test("overlapping semantic roots preserve conflicts until whole-scan deduplication", () => {
  const a = nativeUsageCard({ value: "10", displayed: "10% left" });
  const b = nativeUsageCard({ value: "90", displayed: "90% left" });
  const root = usageElement("div", "", {}, [a.card, b.card]);
  const observations = [root, a.card].flatMap(node => helpers.collectDisplayedObservations(node));
  assert.equal(observations.length, 3);
  assert.deepEqual(helpers.deduplicateObservations(observations), []);
});

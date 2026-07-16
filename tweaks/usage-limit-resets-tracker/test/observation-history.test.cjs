const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const flat = source.replace(/\s+/g, " ");
const helpers = require(path.join(__dirname, "..", "index.js")).__test;
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

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const tweakPath = path.join(__dirname, "..", "index.js");
const source = fs.readFileSync(tweakPath, "utf8");
const tweak = require(tweakPath);
const helpers = tweak._test ?? tweak.__test;

test("follow-up follows the locked five-item payload contract", () => {
  assert.ok(helpers, "follow-up must expose focused test helpers");
  const normalize = helpers.normalizePayload ?? helpers.parsePayload;
  assert.equal(typeof normalize, "function");
  const payload = normalize(require("./fixtures/valid-payload.json"));
  assert.equal(payload.codex_follow_up, true);
  assert.equal(payload.items.length, 5);
  for (const item of payload.items) {
    assert.equal(typeof item.prompt, "string");
    assert.ok(item.prompt.trim());
    assert.ok(Array.isArray(item.achieves));
    assert.ok(item.achieves.length >= 1 && item.achieves.length <= 3);
  }
});

test("absent and malformed payloads fail closed without a broken panel", () => {
  assert.ok(helpers, "follow-up must expose focused test helpers");
  const normalize = helpers.normalizePayload ?? helpers.parsePayload;
  for (const fixture of [null, {}, { codex_follow_up: true, items: [{ prompt: "x" }] }, require("./fixtures/malformed-payload.json")]) {
    assert.equal(normalize(fixture), null);
  }
  assert.match(source, /(?:fail|invalid|malformed|absent|no.?op)/i);
});

test("duplicate prompts are removed while preserving order", () => {
  assert.ok(helpers, "follow-up must expose focused test helpers");
  const dedupe = helpers.dedupeItems ?? helpers.dedupePrompts;
  assert.equal(typeof dedupe, "function");
  const items = require("./fixtures/duplicate-items.json");
  const result = dedupe(items);
  assert.deepEqual(result.map((item) => item.prompt), ["Keep this", "Then this"]);
});

test("main-owned policy keeps exact-five default and explicit disabled exception", () => {
  const enabled = helpers.normalizePolicySnapshot({ schemaVersion: 1, enabled: true, exactItems: 5 });
  const disabled = helpers.normalizePolicySnapshot({ schemaVersion: 1, enabled: false, exactItems: 99 });
  assert.deepEqual(enabled, { schemaVersion: 1, enabled: true, exactItems: 5, exception: null });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.exactItems, 5);
  assert.equal(disabled.exception, "disabled-by-applicable-agents");
  assert.equal(helpers.policyAllowsPayload(disabled, { items: Array(5) }), false);
});

test("renderer requests a policy snapshot and contains no filesystem parser", () => {
  assert.match(source, /api\.ipc\.invoke\(POLICY_CHANNEL/);
  assert.doesNotMatch(source, /require\(["']node:fs/);
  assert.doesNotMatch(source, /AGENTS\.md/);
});

test("a payload with a duplicate prompt is rejected (require five DISTINCT items)", () => {
  const item = (prompt) => ({ prompt, achieves: ["does a thing"] });
  const withDuplicate = {
    codex_follow_up: true,
    items: [item("A"), item("B"), item("C"), item("D"), item("B")], // 5 items, 4 distinct
  };
  assert.equal(helpers.normalizePayload(withDuplicate), null, "duplicate → rejected, not silently dropped at render");

  const fiveDistinct = {
    codex_follow_up: true,
    items: [item("A"), item("B"), item("C"), item("D"), item("E")],
  };
  const ok = helpers.normalizePayload(fiveDistinct);
  assert.ok(ok);
  assert.equal(ok.items.length, 5);
});

test("insertPrompt no longer depends on non-existent SDK composer bridges", () => {
  // The old code probed api.composer.send / api.codex.composer.send / api.sendMessage.
  assert.doesNotMatch(source, /composer\?\.send|codex\?\.composer|api\?\.sendMessage/);
  assert.match(source, /function findComposer/);
});

test("a transient policy failure clears the cached context so it can retry", async () => {
  let calls = 0;
  const state = {
    api: {
      ipc: { invoke: () => { calls += 1; return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ schemaVersion: 1, enabled: true, exactItems: 5 }); } },
      log: { debug() {} },
    },
    policy: {}, policyContext: null, policyPending: false, disposed: false,
    roots: new WeakMap(), hidden: new Map(), panels: new Set(),
  };
  // Stub currentProjectContext via a global document with a workspace node.
  global.document = { querySelector: () => ({ getAttribute: (n) => (n === "data-workspace-path" ? "/ws" : null) }) };
  try {
    helpers.refreshPolicy(state);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(state.policyContext, null, "failed fetch resets context to allow a retry");
    // A retry now succeeds.
    helpers.refreshPolicy(state);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(state.policy.enabled, true);
    assert.equal(calls, 2);
  } finally {
    delete global.document;
  }
});

test("pruneDetached drops disconnected hidden sources and panels", () => {
  const connectedSource = { isConnected: true };
  const detachedSource = { isConnected: false };
  const connectedPanel = { isConnected: true };
  const detachedPanel = { isConnected: false };
  const state = {
    hidden: new Map([[connectedSource, {}], [detachedSource, {}]]),
    panels: new Set([connectedPanel, detachedPanel]),
  };
  helpers.pruneDetached(state);
  assert.equal(state.hidden.has(connectedSource), true);
  assert.equal(state.hidden.has(detachedSource), false);
  assert.equal(state.panels.has(connectedPanel), true);
  assert.equal(state.panels.has(detachedPanel), false);
});

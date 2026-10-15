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

test("navigation invalidates a pending Followup policy before it can enable another project", async () => {
  const previousDocument = global.document;
  let workspacePath = "/project-a";
  const pending = [];
  const state = {
    api: { ipc: { invoke(_channel, request) { return new Promise((resolve) => pending.push({ request, resolve })); } } },
    policy: { enabled: false }, policyContext: null, policyPending: false, disposed: false,
    roots: new WeakMap(), hidden: new Map(), panels: new Set(),
  };
  global.document = { querySelector: () => workspacePath ? { getAttribute: (name) => name === "data-workspace-path" ? workspacePath : null } : null };
  try {
    helpers.refreshPolicy(state);
    let removedPanels = 0;
    state.panels.add({ remove() { removedPanels += 1; } });
    workspacePath = "/project-b";
    helpers.refreshPolicy(state);
    assert.equal(pending.length, 2, "the new project gets its own policy while the old request is pending");
    assert.equal(removedPanels, 1, "navigation removes the previous project's follow-up controls immediately");
    pending[0].resolve({ schemaVersion: 1, enabled: true, exactItems: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.policy.enabled, false, "project A cannot enable Followup in project B");
    pending[1].resolve({ schemaVersion: 1, enabled: true, exactItems: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.policy.enabled, true);
    workspacePath = null;
    helpers.refreshPolicy(state);
    assert.equal(state.policy.enabled, false, "a projectless route does not retain the previous project's policy");
    assert.equal(state.policyContext, null);
  } finally { global.document = previousDocument; }
});

test("Followup rechecks the current route when policy delivery precedes the host notification", async () => {
  const previousDocument = global.document;
  let workspacePath = "/project-a";
  const pending = [];
  const state = {
    api: { ipc: { invoke(_channel, request) { return new Promise((resolve) => pending.push({ request, resolve })); } } },
    policy: { enabled: false }, policyContext: null, policyPending: false, disposed: false,
    roots: new WeakMap(), hidden: new Map(), panels: new Set(),
  };
  global.document = { querySelector: () => ({ getAttribute: (name) => name === "data-workspace-path" ? workspacePath : null }) };
  try {
    helpers.refreshPolicy(state);
    workspacePath = "/project-b";
    pending[0].resolve({ schemaVersion: 1, enabled: true, exactItems: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.policy.enabled, false);
    assert.equal(pending.length, 2, "delivery triggers a policy request for the new route");
    assert.equal(pending[1].request.project.workspacePath, "/project-b");
    pending[1].resolve({ schemaVersion: 1, enabled: false, exactItems: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.policy.enabled, false);
    assert.equal(state.policyPending, false);
  } finally { global.document = previousDocument; }
});

test("a stopped Followup ignores an already pending policy response", async () => {
  const previousDocument = global.document;
  let resolvePolicy;
  const state = {
    api: { ipc: { invoke() { return new Promise((resolve) => { resolvePolicy = resolve; }); } } },
    policy: { enabled: false }, policyContext: null, policyPending: false, disposed: false,
    roots: new WeakMap(), hidden: new Map(), panels: new Set(),
  };
  global.document = { querySelector: () => ({ getAttribute: (name) => name === "data-workspace-path" ? "/project-a" : null }) };
  try {
    helpers.refreshPolicy(state);
    state.disposed = true;
    resolvePolicy({ schemaVersion: 1, enabled: true, exactItems: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.policy.enabled, false);
  } finally { global.document = previousDocument; }
});

test("enabled Followup cannot render a new project with an old policy during a coalesced scan", async () => {
  const { createSemanticDom } = require("../../user-questions/test/semantic-dom");
  const { document } = createSemanticDom();
  const previous = { document: global.document, window: global.window };
  document.getElementById = () => null;
  const workspace = document.createElement("main");
  workspace.setAttribute("data-workspace-path", "/project-a");
  document.body.append(workspace);
  const message = (id) => {
    const root = document.createElement("article");
    root.setAttribute("data-message-author-role", "assistant");
    root.setAttribute("data-message-id", id);
    const code = document.createElement("code");
    code.textContent = JSON.stringify(require("./fixtures/valid-payload.json"));
    root.append(code);
    workspace.append(root);
    return root;
  };
  const oldMessage = message("project-a-message");
  let currentMessage = oldMessage;
  let notifyHost;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const api = {
    process: "renderer",
    ipc: { invoke(_channel, request) {
      requests.push(request);
      return Promise.resolve({ schemaVersion: 1, enabled: request.project.workspacePath === "/project-a", exactItems: 5 });
    } },
    react: { host: {
      observe(_topics, callback) { notifyHost = callback; return () => {}; },
      query() { return [{ element: currentMessage }]; },
    } },
  };
  global.document = document;
  global.window = {
    setTimeout(callback) { const timer = ++nextTimer; timers.set(timer, callback); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  };
  const instance = {};
  try {
    tweak.start.call(instance, api);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(oldMessage.querySelector("[data-tweaker-followup-panel]"), "project A starts with a confirmed enabled policy");
    notifyHost();
    assert.equal(timers.size, 1, "an enabled A scan is waiting for its debounce timer");
    workspace.setAttribute("data-workspace-path", "/project-b");
    currentMessage = message("project-b-message");
    notifyHost();
    assert.equal(Boolean(oldMessage.querySelector("[data-tweaker-followup-panel]")), false, "the B notification immediately removes A's controls even with a pending timer");
    const queued = [...timers.values()];
    timers.clear();
    for (const callback of queued) callback();
    assert.equal(Boolean(currentMessage.querySelector("[data-tweaker-followup-panel]")), false, "a coalesced B notification cannot render with A's enabled policy");
    assert.equal(Boolean(oldMessage.querySelector("[data-tweaker-followup-panel]")), false, "old policy controls remain removed after timer delivery");
    assert.equal(requests.length, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Boolean(currentMessage.querySelector("[data-tweaker-followup-panel]")), false, "B's disabled policy stays disabled after delivery");
  } finally {
    tweak.stop.call(instance);
    global.document = previous.document;
    global.window = previous.window;
  }
});

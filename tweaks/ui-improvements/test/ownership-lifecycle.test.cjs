const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const tweakPath = path.join(__dirname, "..", "index.js");
const source = fs.readFileSync(tweakPath, "utf8");
const tweak = require(tweakPath);
const helpers = tweak._test ?? tweak.__test;

const TOGGLES = [
  "sidebar layout",
  "chat multi select",
  "slash menu improvements",
  "message metrics",
];

test("UI Improvements exposes exactly four independently switchable improvements", () => {
  assert.ok(helpers, "UI Improvements must expose focused test helpers");
  const list = helpers.TOGGLE_IDS ?? helpers.toggleIds ?? helpers.toggles;
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 4);
  const normalized = list.map((value) => String(value).toLowerCase().replace(/[_-]+/g, " "));
  for (const name of TOGGLES) assert.ok(normalized.some((value) => value.includes(name)), `missing toggle: ${name}`);
});

test("Shadcn-owned selectors are not claimed by UI Improvements", () => {
  const ownership = helpers?.OWNERSHIP ?? helpers?.ownership ?? {};
  const owned = JSON.stringify(ownership).toLowerCase();
  assert.doesNotMatch(owned, /rich.?chat|chat.?block|shadcn.*layout|design.?token/);
  assert.match(source, /(?:ownership|owner|shadcn)/i);
});

test("stopping one toggle cleans only its own mount, listener, and style", () => {
  assert.ok(helpers);
  const cleanup = helpers.cleanupToggle ?? helpers.teardownToggle ?? helpers.cleanup;
  assert.equal(typeof cleanup, "function");
  const state = { mounts: ["sidebar", "metrics"], listeners: ["sidebar", "metrics"], styles: ["sidebar", "metrics"] };
  cleanup(state, "sidebar");
  assert.deepEqual(state, { mounts: ["metrics"], listeners: ["metrics"], styles: ["metrics"] });
});

test("persisted toggle state defaults safely and preserves independent disables", () => {
  const all = helpers.normalizeToggleState(null);
  assert.equal(all.size, 4);
  const configured = helpers.normalizeToggleState({ version: 1, enabled: { "settings-search": false, "message-metrics": false } });
  assert.equal(configured.has("settings-search"), false);
  assert.equal(configured.has("message-metrics"), false);
  assert.equal(configured.has("sidebar-layout"), true);
  const migrated = helpers.normalizeToggleState({ version: 2, enabled: { "project-labels": true, "sidebar-layout": false } });
  assert.equal(migrated.has("project-labels"), false);
  assert.equal(migrated.has("sidebar-layout"), false);
});

test("all four switches have concrete DOM behavior hooks", () => {
  for (const marker of ["data-codexpp-sidebar-layout", "data-codexpp-multiselect-ready", "data-codexpp-slash-navigation", "data-codexpp-message-metrics"]) {
    assert.match(source, new RegExp(marker));
  }
  assert.doesNotMatch(source, /data-codexpp-project-label/);
  assert.doesNotMatch(source, /data-codexpp-settings-search|data-codexpp-tweak-mentions/);
  assert.match(source, /storage.*set|set.*STORAGE_KEY/is);
});

test("pruneDetached drops entries whose node left the DOM, keeps live/attribute entries", () => {
  assert.equal(typeof helpers.pruneDetached, "function");
  let removedListener = false;
  const state = {
    mounts: [
      { id: "a", node: { isConnected: true } },
      { id: "b", node: { isConnected: false } },
      { id: "c" }, // no node reference — always kept
    ],
    listeners: [
      { id: "x", target: { isConnected: false, removeEventListener() { removedListener = true; } }, type: "click", listener() {} },
      { id: "y", target: { isConnected: true } },
    ],
  };
  helpers.pruneDetached(state);
  assert.deepEqual(state.mounts.map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(state.listeners.map((entry) => entry.id), ["y"]);
  assert.equal(removedListener, true, "detached listener is removed before dropping");
});

test("countMessageWords excludes text this tweak injected", () => {
  assert.equal(typeof helpers.countMessageWords, "function");
  const message = makeFakeMessage("the quick brown fox", "99 words");
  assert.equal(helpers.countMessageWords(message), 4);
});

test("countMessageWords falls back to textContent when cloneNode is unavailable", () => {
  assert.equal(helpers.countMessageWords({ textContent: "one two three" }), 3);
  assert.equal(helpers.countMessageWords({ textContent: "   " }), 0);
});

test("project path labels are fully retired from UI Improvements", () => {
  assert.equal(helpers.projectPathLabel, undefined);
  assert.doesNotMatch(source, /project-labels|applyProjectLabels|projectPathLabel/);
});

test("sidebar layout never adds blanket padding to every task and navigation control", () => {
  const css = String(source.match(/"sidebar-layout":\s*"([^"]+)"/)?.[1] || "");
  assert.match(css, /data-app-action-sidebar-project-id/);
  assert.doesNotMatch(css, /:is\(a,button,\[role='button'\]\)/);
  assert.doesNotMatch(css, /codexpp-sidebar-row-padding/);
});

test("a single shared observer dispatches to behaviors (no per-toggle observers)", () => {
  // activateToggle must not construct its own MutationObserver anymore.
  const activateBody = source.slice(source.indexOf("function activateToggle"), source.indexOf("function scanBehavior"));
  assert.doesNotMatch(activateBody, /new MutationObserver/);
  assert.match(source, /function startObserver/);
});

function makeFakeMessage(baseText, injectedText) {
  let removed = false;
  const injected = { remove() { removed = true; } };
  const clone = {
    querySelectorAll: () => (removed ? [] : [injected]),
    get textContent() { return removed ? baseText : `${baseText} ${injectedText}`; },
  };
  return { cloneNode: () => clone };
}

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const tweak = require(path.join(__dirname, "..", "index.js"));
const helpers = tweak._test ?? tweak.__test;

test("titlebar alignment uses measured layout and avoids overlap", () => {
  assert.ok(helpers);
  const detect = helpers.detectLayout ?? helpers.detectWindowLayout;
  const align = helpers.alignControls ?? helpers.computeAlignment;
  assert.equal(typeof detect, "function");
  assert.equal(typeof align, "function");
  const layout = detect(require("./fixtures/layout-standard.json"));
  const result = align(layout, require("./fixtures/controls.json"));
  assert.ok(Number.isFinite(result.left));
  assert.ok(result.right <= layout.contentLeft);
});

test("resize and disable cleanup remove observers and injected styles", () => {
  assert.ok(helpers);
  const cleanup = helpers.cleanup ?? helpers.teardown;
  assert.equal(typeof cleanup, "function");
  const state = { observers: [1, 2], styles: [1], listeners: [1] };
  cleanup(state);
  assert.deepEqual(state.observers, []);
  assert.deepEqual(state.styles, []);
  assert.deepEqual(state.listeners, []);
  assert.equal(state.disposed, true);
});

test("runtime transform aligns both horizontal and vertical axes", () => {
  const transform = helpers.computeControlTransform(
    { contentTop: 12, titlebarHeight: 48 },
    { top: 20, height: 20 },
    6,
  );
  assert.deepEqual(transform, { x: 6, y: 6 });
});

// Anti-loop invariant: writing the SAME transform value must be a no-op so our
// own writes never feed the MutationObserver a fresh mutation each frame.
test("setTransform does not rewrite an unchanged value (no observer feedback loop)", () => {
  assert.equal(typeof helpers.setTransform, "function");
  const control = makeFakeControl();
  assert.equal(helpers.setTransform(control, "translate(3px, 4px)", "important"), true);
  assert.equal(control.writes, 1);
  // Second identical write must not touch the DOM.
  assert.equal(helpers.setTransform(control, "translate(3px, 4px)", "important"), false);
  assert.equal(control.writes, 1);
  // A genuinely different value writes again.
  assert.equal(helpers.setTransform(control, "translate(5px, 4px)", "important"), true);
  assert.equal(control.writes, 2);
  // Clearing (empty value) also respects the change guard.
  assert.equal(helpers.setTransform(control, "", ""), true);
  assert.equal(helpers.setTransform(control, "", ""), false);
});

test("pruneDetachedSnapshots drops nodes no longer in the DOM, keeps connected ones", () => {
  assert.equal(typeof helpers.pruneDetachedSnapshots, "function");
  const connected = { isConnected: true };
  const detached = { isConnected: false };
  const state = { snapshots: new Map([[connected, {}], [detached, {}]]) };
  helpers.pruneDetachedSnapshots(state);
  assert.equal(state.snapshots.has(connected), true);
  assert.equal(state.snapshots.has(detached), false);
});

test("isMacPlatform is exposed and returns a boolean", () => {
  assert.equal(typeof helpers.isMacPlatform, "function");
  assert.equal(typeof helpers.isMacPlatform(), "boolean");
});

test("refresh control appears only for actionable development or stable updates", () => {
  assert.equal(helpers.shouldShowRefresh({ available: true, source: "development" }), true);
  assert.equal(helpers.shouldShowRefresh({ available: true, source: "stable" }), true);
  assert.equal(helpers.shouldShowRefresh({ available: false, source: "current" }), false);
  assert.match(helpers.refreshTooltip({ source: "development" }), /development checkout/);
  assert.match(helpers.refreshTooltip({ source: "stable" }), /stable Tweakers release/);
});

function makeFakeControl(initial = "") {
  let value = initial;
  let priority = "";
  const control = {
    writes: 0,
    style: {
      getPropertyValue: (prop) => (prop === "transform" ? value : ""),
      getPropertyPriority: (prop) => (prop === "transform" ? priority : ""),
      setProperty(prop, val, prio) {
        if (prop !== "transform") return;
        control.writes += 1;
        value = val;
        priority = prio || "";
      },
      removeProperty(prop) {
        if (prop !== "transform") return;
        control.writes += 1;
        value = "";
        priority = "";
      },
    },
  };
  return control;
}

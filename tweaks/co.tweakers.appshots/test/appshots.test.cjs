"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const tweak = require("../index.js");

test("AppShots registers only native settings and tears down its page", () => {
  let registration;
  let disposed = 0;
  const instance = Object.create(tweak);
  instance.start({ process: "main", codex: new Proxy({}, { get() { throw new Error("No competing capture or shortcut"); } }) });
  instance.start({ process: "renderer", settings: { registerPage(page) { registration = page; return { unregister() { disposed++; } }; } } });
  assert.equal(registration.title, "AppShots");
  instance.stop();
  instance.stop();
  assert.equal(disposed, 1);
});

test("native state read does not enable capture or create files", async () => {
  const calls = [];
  const nodes = [];
  const previous = global.document;
  global.document = { createElement(tag) { const node = { tag, children: [], append(...items) { this.children.push(...items); }, addEventListener() {}, textContent: "" }; nodes.push(node); return node; } };
  const instance = Object.create(tweak);
  let page;
  try {
    instance.start({ process: "renderer", nativeCapture: {
      appshots: { async getState() { calls.push("appshots"); return { supported: true, hotkey: "DoubleCommand" }; }, async setHotkey() { calls.push("mutation"); } },
      computerHistory: { async getState() { calls.push("history"); return { state: "running" }; } },
    }, settings: { registerPage(value) { page = value; return { unregister() {} }; } } });
    page.render({ replaceChildren() {}, append() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["appshots", "history"]);
    assert.ok(nodes.some(node => node.textContent === "Native AppShots shortcut: both Command keys."));
    assert.ok(nodes.some(node => node.textContent === "Native Computer History: running."));
  } finally { instance.stop(); global.document = previous; }
});

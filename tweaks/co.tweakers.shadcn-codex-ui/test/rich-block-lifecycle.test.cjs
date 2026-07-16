"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const tweak = require("../index.js").__test;

test("rich payload parsing fails closed and preserves native message content", () => {
  const native = [{ kind: "markdown", text: "ordinary response" }, { kind: "actions" }];
  const message = { id: "message-1", nativeChildren: native };

  const payload = tweak.parseRichPayload({ version: 1, blocks: [{ kind: "summary_card", text: "Summary" }] });
  assert.deepEqual(payload.blocks, [{ kind: "summary_card", text: "Summary" }]);

  const mount = tweak.reconcileRichBlock(message, payload);
  assert.equal(mount.owner, "co.tweakers.shadcn-codex-ui");
  assert.equal(mount.messageId, "message-1");
  assert.deepEqual(message.nativeChildren, native);

  assert.equal(tweak.parseRichPayload({ version: 2, blocks: [] }), null);
  assert.equal(tweak.reconcileRichBlock(message, { version: 2, blocks: [] }), null);
  assert.deepEqual(message.nativeChildren, native);
});

test("rich-block reconciliation is bounded to the message root", () => {
  const roots = [
    { id: "message-1", kind: "message", richPayload: { version: 1, blocks: [] } },
    { id: "composer", kind: "composer", richPayload: { version: 1, blocks: [] } },
    { id: "tool-1", kind: "tool", richPayload: { version: 1, blocks: [] } },
  ];
  const mounts = tweak.collectRichBlockRoots(roots);
  assert.deepEqual(mounts.map((root) => root.id), ["message-1"]);
});

test("rich-block mount disposal removes only owned state and is idempotent", () => {
  const message = { id: "message-2", nativeChildren: [{ kind: "markdown", text: "keep" }] };
  const mount = tweak.reconcileRichBlock(message, { version: 1, blocks: [{ kind: "card" }] });
  assert.ok(mount);

  tweak.disposeRichBlockMount(message, mount);
  assert.equal(message.ownedMount, null);
  assert.deepEqual(message.nativeChildren, [{ kind: "markdown", text: "keep" }]);
  assert.doesNotThrow(() => tweak.disposeRichBlockMount(message, mount));
});

test("observer contract uses the shared semantic host and remains coalesced and disconnectable", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /react\?\.host\?\.observe/);
  assert.match(source, /requestAnimationFrame|queueMicrotask|setTimeout/);
  assert.match(source, /disconnect\(\)/);
  assert.doesNotMatch(source, /new MutationObserver/);
});

test("rich block payloads are bounded", () => {
  const blocks = Array.from({ length: 101 }, () => ({ kind: "card" }));
  assert.equal(tweak.parseRichPayload({ version: 1, blocks }), null);
});

// A compact fake DOM so the real element-building paths (renderBlock, host
// mounting, re-anchoring) actually execute.
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.attributes = {};
    this.className = "";
    this._text = "";
    this.isConnected = true;
    this.parentElement = null;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }
  appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = this.isConnected; return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
    this.isConnected = false;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  replaceChildren() { this.children = []; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
}

function withFakeDom(fn) {
  const prevDoc = global.document;
  const prevNode = global.Node;
  global.Node = FakeNode;
  global.document = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    head: new FakeElement("head"),
    documentElement: new FakeElement("html"),
  };
  try { return fn(); } finally {
    global.document = prevDoc;
    global.Node = prevNode;
  }
}

test("renderBlock renders per-kind shadcn markup via textContent (no HTML injection)", () => {
  withFakeDom(() => {
    const heading = tweak.renderBlock({ kind: "heading", text: "Overview" });
    assert.equal(heading.getAttribute("data-rich-block-kind"), "heading");
    assert.equal(heading.textContent, "Overview");
    assert.match(heading.className, /font-semibold/);

    const code = tweak.renderBlock({ kind: "code", code: "const x = 1;" });
    assert.match(code.textContent, /const x = 1;/);

    const list = tweak.renderBlock({ kind: "list", items: ["one", "two", "three"] });
    assert.match(list.textContent, /onetwothree/);

    // Unknown kind still yields a labelled fallback, never nothing.
    const unknown = tweak.renderBlock({ kind: "mystery", text: "fallback text" });
    assert.equal(unknown.textContent, "fallback text");
  });
});

test("a detached host is re-anchored on the next reconcile even when the payload is unchanged", () => {
  withFakeDom(() => {
    const message = new FakeElement("div");
    message.id = "message-42";
    const payload = { version: 1, blocks: [{ kind: "text", text: "hi" }] };

    const first = tweak.reconcileRichBlock(message, payload);
    assert.ok(first.host, "first reconcile mounts a host");
    assert.equal(message.children.includes(first.host), true);

    // Simulate a React re-render dropping our injected <section>.
    first.host.remove();
    assert.equal(first.host.isConnected, false);

    // Same payload — old code returned the stale (detached) mount and never
    // re-appended. Now it must re-anchor.
    const second = tweak.reconcileRichBlock(message, payload);
    assert.ok(second.host, "second reconcile re-anchors a host");
    assert.notEqual(second.host, first.host);
    assert.equal(second.host.isConnected, true);
    assert.equal(message.children.includes(second.host), true);
  });
});

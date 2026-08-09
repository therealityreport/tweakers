"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const tweak = require("../index.js").__test;

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.attributes = {};
    this.className = "";
    this._text = "";
    this.isConnected = false;
    this.parentElement = null;
    this.listeners = new Map();
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }
  hasAttribute(key) { return key in this.attributes; }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = this.isConnected;
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
    this.isConnected = false;
  }
  replaceChildren(...children) {
    for (const child of this.children) { child.parentElement = null; child.isConnected = false; }
    this.children = [];
    this._text = "";
    this.append(...children);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { this.listeners.get(type)?.({ target: this }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const attr = selector.match(/^\[([^\]=]+)(?:=[^\]]+)?\]$/)?.[1];
    if (!attr) return [];
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.hasAttribute?.(attr)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}

function withFakeDom(run) {
  const previous = { document: global.document, Node: global.Node, window: global.window };
  const frames = new Map();
  let nextFrame = 0;
  const document = {
    head: new FakeElement("head"),
    documentElement: new FakeElement("html"),
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  document.head.isConnected = true;
  document.documentElement.isConnected = true;
  global.Node = FakeNode;
  global.document = document;
  global.window = {
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const flushFrames = () => {
    const pending = Array.from(frames.values());
    frames.clear();
    for (const callback of pending) callback();
  };
  try { return run({ document, flushFrames }); } finally {
    global.document = previous.document;
    global.Node = previous.Node;
    global.window = previous.window;
  }
}

test("Rich Blocks v1 normalizes key/value input to one canonical pair schema", () => {
  const payload = tweak.parseRichPayload({
    version: 1,
    blocks: [
      { kind: "keyValue", key: "Status", value: "Ready" },
      { kind: "keyValue", pairs: [{ key: "Branch", value: "main" }] },
    ],
  });
  assert.deepEqual(payload.blocks, [
    { kind: "keyValue", pairs: [{ key: "Status", value: "Ready" }] },
    { kind: "keyValue", pairs: [{ key: "Branch", value: "main" }] },
  ]);
  assert.equal(tweak.RICH_BLOCK_PROTOCOL.extensible, true);
});

test("Rich Blocks v1 is safely extensible and enforces serialized, field, and nesting bounds", () => {
  const extension = tweak.parseRichPayload({ version: 1, blocks: [{ kind: "summary_card", text: "Summary" }] });
  assert.deepEqual(extension.blocks, [{ kind: "summary_card", text: "Summary" }]);
  assert.equal(tweak.parseRichPayload(JSON.stringify({ version: 1, blocks: [], extra: "x".repeat(70 * 1024) })), null);
  assert.equal(tweak.parseRichPayload({ version: 1, blocks: Array.from({ length: 51 }, () => ({ kind: "text" })) }), null);
  assert.equal(tweak.parseRichPayload({ version: 1, blocks: [{ kind: "text", ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, i])) }] }), null);
  assert.equal(tweak.parseRichPayload({
    version: 1,
    blocks: [{ kind: "text", nested: { a: { b: { c: { d: true } } } } }],
  }), null);
});

test("newest bounded candidate window merges native turns after a capped host result", () => {
  const host = Array.from({ length: 100 }, (_, i) => ({ id: `host-${i + 1}` }));
  const native = [{ id: "host-100" }, { id: "native-101" }];
  const roots = tweak.mergeRichBlockRoots(host, native);
  assert.equal(roots.length, 100);
  assert.equal(roots[0].id, "host-2");
  assert.equal(roots.at(-1).id, "native-101");
});

test("settings preview renders canonical key/value rows visibly", () => {
  withFakeDom(({ document }) => {
    const root = new FakeElement("div");
    root.isConnected = true;
    tweak.renderSettings(root, { enabled: true, api: { react: { host: { snapshot: () => ({ count: 1 }) } } }, mounts: new Map() });
    const keyValue = root.querySelectorAll("[data-rich-block-kind]").find((block) => block.getAttribute("data-rich-block-kind") === "keyValue");
    assert.ok(keyValue, "the preview contains a key/value block");
    assert.equal(keyValue.children.length, 1, "the preview contains one visible row");
    assert.match(keyValue.textContent, /StatusReady/);
    assert.match(root.textContent, /Rich Blocks v1 accepts safe extension kinds/);
    assert.equal(document.head.children.length, 0);
  });
});

test("start/update/invalid/stop behavior mounts only owned DOM and cleans it up", () => {
  withFakeDom(({ document, flushFrames }) => {
    const message = new FakeElement("article");
    message.isConnected = true;
    message.id = "message-1";
    message.setAttribute("data-rich-payload", JSON.stringify({ version: 1, blocks: [{ kind: "text", text: "First" }] }));
    document.querySelectorAll = () => [message];
    let observed;
    let disconnects = 0;
    let unregisters = 0;
    const api = {
      storage: { get: () => true },
      react: { host: {
        observe(_topics, callback) { observed = callback; return () => { disconnects += 1; }; },
        query: () => [{ element: message }],
      } },
      settings: { registerPage: () => ({ unregister: () => { unregisters += 1; } }) },
    };
    const instance = {};
    require("../index.js").start.call(instance, api);
    flushFrames();
    const first = tweak.getRichBlockMount(message);
    assert.ok(first?.host, "start mounts the rich block after a semantic-host scan");
    assert.match(first.host.textContent, /First/);

    message.setAttribute("data-rich-payload", JSON.stringify({ version: 1, blocks: [{ kind: "text", text: "Second" }] }));
    observed();
    flushFrames();
    assert.notEqual(tweak.getRichBlockMount(message).host, first.host, "a payload update replaces the prior owned mount");
    assert.equal(first.host.isConnected, false);
    assert.match(tweak.getRichBlockMount(message).host.textContent, /Second/);

    message.setAttribute("data-rich-payload", JSON.stringify({ version: 2, blocks: [] }));
    observed();
    flushFrames();
    assert.equal(tweak.getRichBlockMount(message), null, "invalid payloads remove only this tweak's mount");
    assert.equal(tweak.getState(instance).mounts.size, 0);

    require("../index.js").stop.call(instance);
    assert.equal(disconnects, 1);
    assert.equal(unregisters, 1);
    assert.equal(tweak.getState(instance), undefined);
  });
});

test("rendering uses textContent for an unknown extension fallback", () => {
  withFakeDom(() => {
    const block = tweak.renderBlock({ kind: "new_kind", text: "<script>not HTML</script>" });
    assert.equal(block.textContent, "<script>not HTML</script>");
    assert.equal(block.children.length, 0);
  });
});

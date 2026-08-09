"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const tweakPath = path.join(__dirname, "..", "index.js");
const source = fs.readFileSync(tweakPath, "utf8");
const tweak = require(tweakPath);
const helpers = tweak._test ?? tweak.__test;
const manifest = require("../manifest.json");
const packageJson = require("../package.json");

test("UI Improvements exposes four independently switchable, patch-versioned improvements", () => {
  assert.ok(helpers, "UI Improvements must expose focused test helpers");
  assert.deepEqual(helpers.TOGGLE_IDS, [
    "sidebar-layout",
    "chat-multi-select",
    "slash-menu-improvements",
    "message-metrics",
  ]);
  assert.equal(manifest.version, "0.2.5");
  assert.equal(packageJson.version, manifest.version);
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

test("countMessageWords excludes the tweak's own metrics badge", () => {
  assert.equal(helpers.countMessageWords(makeFakeMessage("the quick brown fox", "99 words")), 4);
  assert.equal(helpers.countMessageWords({ textContent: "one two three" }), 3);
  assert.equal(helpers.countMessageWords({ textContent: "   " }), 0);
});

test("mounted lifecycle mutates only owned sidebar/chat/message targets and stop reverses every mutation", async () => {
  await withFakeDom(async (fixture) => {
    const instance = {};
    tweak.start.call(instance, fixture.api);

    assert.equal(fixture.sidebar.hasAttribute("data-tweaker-sidebar-layout"), true, "layout owns the sidebar shell");
    assert.equal(fixture.chatOne.row.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), true, "chat selection mounts on a native sidebar chat row");
    assert.equal(fixture.chatTwo.row.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), true);
    assert.equal(fixture.assistant.querySelector("[data-tweaker-message-metrics]").textContent, "2 words", "metrics mount on assistant turns");
    assert.equal(fixture.projectRow.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), false, "Projects remains outside chat-selection ownership");
    assert.equal(fixture.assistant.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), false, "assistant messages are not sidebar chats");
    assert.equal(fixture.shadcn.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), false, "Shadcn content remains untouched");
    assert.equal(fixture.observerStarts, 1, "one shared host observer starts for enabled improvements");
    assert.deepEqual(helpers.sidebarChatRows(), [fixture.chatOne.row, fixture.chatTwo.row]);
    assert.doesNotMatch(source, /data-tweaker-message-selected/);
    assert.doesNotMatch(source, /#3b82f6/);

    tweak.stop.call(instance);

    assert.equal(fixture.observerDisconnects, 1, "stop disconnects the shared observer");
    assert.equal(fixture.settingsUnregistered, true, "stop unregisters the settings page");
    assert.equal(fixture.sidebar.hasAttribute("data-tweaker-sidebar-layout"), false);
    assert.equal(fixture.chatOne.row.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), false);
    assert.equal(fixture.chatTwo.row.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready"), false);
    assert.equal(fixture.assistant.querySelector("[data-tweaker-message-metrics]"), null);
    assert.equal(fixture.document.head.children.length, 0, "owned styles are removed");
    assert.equal(fixture.chatOne.row.listenerCount("click"), 0, "owned listeners are removed");
    assert.equal(fixture.chatOne.row.listenerCount("contextmenu"), 0);
  });
});

test("sidebar multi-select confirms the safe batch copy, streaming metrics refresh, and disabled layout goes idle", async () => {
  await withFakeDom(async (fixture) => {
    const instance = {};
    tweak.start.call(instance, fixture.api);

    fixture.assistant.setOwnText("one two three four");
    fixture.notifyHostMutation();
    fixture.flushAnimationFrames();
    assert.equal(fixture.assistant.querySelector("[data-tweaker-message-metrics]").textContent, "4 words", "the final streaming count replaces the earlier badge text");

    const modifierClick = fixture.chatOne.row.dispatch("click", { metaKey: true, button: 0 });
    fixture.chatTwo.row.dispatch("click", { ctrlKey: true, button: 0 });
    assert.equal(modifierClick.defaultPrevented, true, "modifier-click prevents native navigation while selecting");
    assert.equal(fixture.chatOne.row.hasAttribute("data-tweaker-sidebar-chat-selected"), true);
    assert.equal(fixture.chatTwo.row.hasAttribute("data-tweaker-sidebar-chat-selected"), true);
    assert.equal(fixture.assistant.hasAttribute("data-tweaker-sidebar-chat-selected"), false);

    const contextMenu = fixture.chatOne.row.dispatch("contextmenu");
    assert.equal(contextMenu.defaultPrevented, true, "right-click opens the owned batch toolbar only for a selected chat");
    let toolbar = fixture.document.querySelector("[data-tweaker-sidebar-chat-selection-toolbar]");
    assert.ok(toolbar, "selected chats expose a batch toolbar");
    const copy = toolbar.children.find((child) => /^Copy 2 titles$/.test(child.textContent));
    assert.ok(copy, "the only batch operation is a bounded, non-destructive title copy");

    fixture.setConfirmResult(false);
    copy.dispatch("click");
    await flushMicrotasks();
    assert.deepEqual(fixture.clipboardWrites, [], "cancelled confirmation performs no clipboard write");

    fixture.setConfirmResult(true);
    copy.dispatch("click");
    await flushMicrotasks();
    assert.deepEqual(fixture.clipboardWrites, ["First chat\nSecond chat"], "confirmed batch copy includes only selected sidebar-chat titles");
    assert.match(fixture.confirmMessages.at(-1), /2 selected chats/);

    fixture.settingsPage.render(fixture.settingsRoot);
    let width = fixture.settingsRoot.querySelector("[aria-label='Minimum sidebar width']");
    assert.equal(width.disabled, false, "minimum-width control is enabled with its parent toggle");
    assert.match(fixture.settingsRoot.textContent, /Host snapshots:/, "diagnostic describes snapshots instead of claiming unproven DOM coverage");
    assert.match(fixture.settingsRoot.textContent, /native sidebar chat rows/);

    changeToggle(fixture.settingsRoot, "Sidebar Layout", false);
    width = fixture.settingsRoot.querySelector("[aria-label='Minimum sidebar width']");
    assert.equal(width.disabled, true, "layout controls disable with their parent toggle");
    assert.equal(fixture.sidebar.hasAttribute("data-tweaker-sidebar-layout"), false, "disabling the parent restores the sidebar immediately");

    fixture.sidebar.setAttribute("data-tweaker-sidebar-layout", "true");
    const disabledState = { api: fixture.api, enabled: new Set(), layout: { width: 288, density: "comfortable" } };
    assert.equal(helpers.updateSidebarLayout(disabledState, { width: 400 }), false, "programmatic layout changes also respect a disabled parent toggle");
    assert.equal(fixture.sidebar.style.getPropertyValue("--tweaker-sidebar-width"), "", "a disabled layout toggle writes no sidebar width");
    fixture.sidebar.removeAttribute("data-tweaker-sidebar-layout");

    changeToggle(fixture.settingsRoot, "Chat Multi Select", false);
    changeToggle(fixture.settingsRoot, "Slash Menu Improvements", false);
    changeToggle(fixture.settingsRoot, "Message Metrics", false);
    assert.equal(fixture.observerDisconnects, 1, "the observer is suspended when every feature toggle is off");
    assert.match(fixture.settingsRoot.textContent, /Host observation is idle/, "the diagnostic reports the idle state truthfully");

    changeToggle(fixture.settingsRoot, "Sidebar Layout", true);
    assert.equal(fixture.observerStarts, 2, "re-enabling a feature restarts the shared observer");
    assert.equal(fixture.sidebar.hasAttribute("data-tweaker-sidebar-layout"), true);
    tweak.stop.call(instance);
    assert.equal(fixture.observerDisconnects, 2, "stop disconnects a restarted observer");
    assert.equal(fixture.sidebar.hasAttribute("data-tweaker-sidebar-layout"), false);
  });
});

test("stopping one toggle cleans only its own mount, listener, and style", () => {
  const cleanup = helpers.cleanupToggle;
  const state = { mounts: ["sidebar", "metrics"], listeners: ["sidebar", "metrics"], styles: ["sidebar", "metrics"] };
  cleanup(state, "sidebar");
  assert.deepEqual(state, { mounts: ["metrics"], listeners: ["metrics"], styles: ["metrics"] });
});

function changeToggle(root, label, checked) {
  const input = root.querySelectorAll("input").find((candidate) => candidate.type === "checkbox" && candidate.parentElement?.textContent.includes(label));
  assert.ok(input, `missing switch for ${label}`);
  input.checked = checked;
  input.dispatch("change");
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeFakeMessage(baseText, injectedText) {
  let removed = false;
  const injected = { remove() { removed = true; } };
  const clone = {
    querySelectorAll: () => (removed ? [] : [injected]),
    get textContent() { return removed ? baseText : `${baseText} ${injectedText}`; },
  };
  return { cloneNode: () => clone };
}

class FakeStyle {
  #values = new Map();
  setProperty(name, value) { this.#values.set(name, String(value)); }
  removeProperty(name) { this.#values.delete(name); }
  getPropertyValue(name) { return this.#values.get(name) || ""; }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = new FakeStyle();
    this.className = "";
    this.isConnected = false;
    this.disabled = false;
    this._text = "";
  }

  appendChild(child) {
    if (child.parentElement) child.remove();
    this.children.push(child);
    child.parentElement = this;
    child.setConnected(this.isConnected);
    return child;
  }

  append(...children) { for (const child of children) this.appendChild(child); }

  replaceChildren(...children) {
    for (const child of this.children) child.setConnected(false);
    this.children = [];
    this._text = "";
    this.append(...children);
  }

  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
    this.setConnected(false);
  }

  setConnected(value) {
    this.isConnected = Boolean(value);
    for (const child of this.children) child.setConnected(this.isConnected);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    const next = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (next) this.setAttribute(name, ""); else this.removeAttribute(name);
    return next;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }

  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: 0,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...init,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (!value) return false;
      const tag = value.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attributes = [...value.matchAll(/\[([^\]=\s]+)(?:\s*=\s*['\"]?([^'\"\]]+)['\"]?)?\]/g)];
      return attributes.every((match) => {
        const actual = this.getAttribute(match[1]);
        return actual !== null && (match[2] === undefined || actual === match[2]);
      });
    });
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  cloneNode(deep = false) {
    const copy = new FakeElement(this.tagName);
    copy.className = this.className;
    copy._text = this._text;
    copy.disabled = this.disabled;
    for (const [name, value] of this.attributes) copy.setAttribute(name, value);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set textContent(value) {
    for (const child of this.children) child.setConnected(false);
    this.children = [];
    this._text = String(value);
  }
  setOwnText(value) { this._text = String(value); }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement("html");
    this.documentElement.setConnected(true);
    this.head = new FakeElement("head");
    this.body = new FakeElement("body");
    this.documentElement.append(this.head, this.body);
  }
  createElement(tagName) { return new FakeElement(tagName); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createFixture() {
  const document = new FakeDocument();
  const sidebar = document.createElement("aside");
  const projectRow = document.createElement("div");
  const projectControl = document.createElement("button");
  projectControl.setAttribute("data-app-action-sidebar-project-id", "project-1");
  projectControl.textContent = "Project One";
  projectRow.append(projectControl);
  const chatOne = makeSidebarChat(document, "thread-1", "First chat");
  const chatTwo = makeSidebarChat(document, "thread-2", "Second chat");
  sidebar.append(projectRow, chatOne.row, chatTwo.row);

  const main = document.createElement("main");
  const assistant = document.createElement("article");
  assistant.setOwnText("one two");
  const shadcn = document.createElement("section");
  shadcn.setAttribute("data-rich-block-kind", "card");
  shadcn.textContent = "Shadcn card";
  main.append(assistant, shadcn);
  document.body.append(sidebar, main);

  let observerCallback = null;
  let observerStarts = 0;
  let observerDisconnects = 0;
  let settingsPage = null;
  let settingsUnregistered = false;
  let confirmResult = true;
  const confirmMessages = [];
  const clipboardWrites = [];
  let nextFrame = 0;
  const frames = new Map();
  const window = {
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    clearTimeout(id) { frames.delete(id); },
    confirm(message) { confirmMessages.push(message); return confirmResult; },
  };
  const api = {
    storage: {
      get(_key, fallback) { return fallback; },
      set() {},
    },
    settings: {
      registerPage(page) {
        settingsPage = page;
        return { unregister() { settingsUnregistered = true; } };
      },
    },
    react: {
      host: {
        query(kind) {
          if (kind === "projects") return [{ element: projectControl }];
          if (kind === "assistant-turns") return [{ element: assistant }];
          return [];
        },
        snapshot(kind) {
          if (kind === "projects") return { count: 1 };
          if (kind === "assistant-turns") return { count: 1 };
          return { count: 0 };
        },
        observe(_surfaces, callback) {
          observerStarts += 1;
          observerCallback = callback;
          return () => { observerDisconnects += 1; };
        },
      },
    },
    log: { warn() {} },
  };
  const settingsRoot = document.createElement("section");
  document.body.append(settingsRoot);
  return {
    api,
    assistant,
    chatOne,
    chatTwo,
    clipboardWrites,
    confirmMessages,
    document,
    main,
    projectRow,
    settingsRoot,
    shadcn,
    sidebar,
    window,
    get observerStarts() { return observerStarts; },
    get observerDisconnects() { return observerDisconnects; },
    get settingsPage() { return settingsPage; },
    get settingsUnregistered() { return settingsUnregistered; },
    notifyHostMutation() { observerCallback?.(); },
    flushAnimationFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    setConfirmResult(value) { confirmResult = Boolean(value); },
    navigator: { clipboard: { writeText(value) { clipboardWrites.push(value); return Promise.resolve(); } } },
  };
}

function makeSidebarChat(document, id, title) {
  const row = document.createElement("div");
  row.setAttribute("data-app-action-sidebar-thread-row", "true");
  const action = document.createElement("button");
  action.setAttribute("data-app-action-sidebar-thread-id", id);
  action.textContent = title;
  row.append(action);
  return { row, action };
}

async function withFakeDom(run) {
  const beforeDocument = Object.getOwnPropertyDescriptor(global, "document");
  const beforeWindow = Object.getOwnPropertyDescriptor(global, "window");
  const beforeNavigator = Object.getOwnPropertyDescriptor(global, "navigator");
  const fixture = createFixture();
  Object.defineProperty(global, "document", { configurable: true, writable: true, value: fixture.document });
  Object.defineProperty(global, "window", { configurable: true, writable: true, value: fixture.window });
  Object.defineProperty(global, "navigator", { configurable: true, writable: true, value: fixture.navigator });
  try {
    return await run(fixture);
  } finally {
    restoreGlobal("document", beforeDocument);
    restoreGlobal("window", beforeWindow);
    restoreGlobal("navigator", beforeNavigator);
  }
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(global, name, descriptor);
  else delete global[name];
}

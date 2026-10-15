"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const moduleUnderTest = require("../index.js");
const tweak = moduleUnderTest.__test;

test("Profiles errors never render arbitrary private IPC error details", () => {
  const canonical = require("../../co.tweakers.projects/lib/thread-summary-profiles").__test;
  const rendered = canonical.renderProfilesState({ state: "error", error: "Account person@example.com failed at /Users/person/.codex: Bearer private-value" });
  assert.equal(rendered.state, "error");
  assert.equal(rendered.text, "Profiles unavailable.");
  assert.deepEqual(rendered.rows, []);
});

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
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }
  hasAttribute(key) { return key in this.attributes; }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = this.isConnected; return child; }
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
  contains(other) { return this.children.includes(other) || this.children.some((child) => child.contains?.(other)); }
  closest(selector) {
    const attrs = attributeNames(selector);
    let current = this;
    while (current) {
      if (attrs.some((attr) => current.hasAttribute?.(attr))) return current;
      current = current.parentElement;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const attrs = attributeNames(selector);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (attrs.some((attr) => child.hasAttribute?.(attr))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
}

function attributeNames(selector) {
  return Array.from(String(selector).matchAll(/\[([^\]=,\s]+)/g), (match) => match[1]);
}

async function withFakeDom(run) {
  const previous = { document: global.document, Node: global.Node, window: global.window, location: global.location };
  const frames = new Map();
  const listeners = new Map();
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
  global.location = { pathname: "/threads/current", search: "?tab=summary", hash: "" };
  global.window = {
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, listener) { const group = listeners.get(type) || new Set(); group.add(listener); listeners.set(type, group); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const flushFrames = async () => {
    const callbacks = Array.from(frames.values());
    frames.clear();
    for (const callback of callbacks) callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  const emit = (type) => { for (const listener of listeners.get(type) || []) listener(); };
  try { return await run({ document, flushFrames, emit, listeners }); } finally {
    global.document = previous.document;
    global.Node = previous.Node;
    global.window = previous.window;
    global.location = previous.location;
  }
}

function summaryPanel(document, context) {
  const workspace = new FakeElement("main");
  workspace.isConnected = true;
  workspace.setAttribute("data-project-id", context.projectId);
  workspace.setAttribute("data-workspace-path", context.workspacePath);
  const panel = new FakeElement("section");
  panel.setAttribute("data-thread-summary", "");
  panel._text = "Environment Sources Progress Subagents";
  workspace.appendChild(panel);
  document.querySelectorAll = (selector) => selector.includes("data-thread-summary") ? [panel] : [];
  return { workspace, panel };
}

function response(projectId, value, revision = 1) {
  return { ok: true, revision, project: { id: projectId }, profiles: [{ type: "github", label: "GitHub", value }] };
}

test("Profiles projection is read-only and redacts identity paths and secrets", () => {
  const projection = tweak.normalizeProfilesProjection({
    ok: true,
    revision: 7,
    project: {
      id: "project-revi",
      workspacePath: "/private/workspace/revi",
      connections: { github: { account: "work", token: "secret-token" }, modal: { profile: "admin" } },
    },
  });
  assert.equal(projection.revision, 7);
  assert.equal(projection.projectId, "project-revi");
  assert.deepEqual(projection.rows.map((row) => row.id), ["github", "modal"]);
  assert.doesNotMatch(JSON.stringify(projection), /workspace|private|token|secret/i);
  assert.equal("save" in projection, false);
  assert.equal("write" in projection, false);
});

test("validated identity rejects a name-only host context and falls back to the panel", async () => {
  await withFakeDom(async ({ document }) => {
    const { panel } = summaryPanel(document, { projectId: "panel-project", workspacePath: "/private/panel" });
    const api = { react: { host: { getActiveProject: () => ({ name: "Only a name" }) } } };
    const identity = tweak.resolveProjectIdentity(api, panel);
    assert.deepEqual(identity, { id: "panel-project", workspacePath: "/private/panel", route: "/threads/current?tab=summary" });
    assert.equal(tweak.resolveProjectIdentity(api, null), null);
  });
});

test("start reloads when the resolved fiber identity changes and never writes path or route into the mount", async () => {
  await withFakeDom(async ({ document, flushFrames }) => {
    const { panel } = summaryPanel(document, { projectId: "panel-project", workspacePath: "/private/panel" });
    let hostContext = { name: "Only a name" };
    let observed;
    const calls = [];
    const api = {
      react: { host: {
        getActiveProject: () => hostContext,
        observe(_topics, callback) { observed = callback; return () => {}; },
      } },
      ipc: { invoke(_channel, request) { calls.push(request); return Promise.resolve(response(request.project.id, request.project.id)); } },
      settings: { registerPage: () => ({ unregister() {} }) },
    };
    const instance = {};
    moduleUnderTest.start.call(instance, api);
    await flushFrames();
    assert.deepEqual(calls[0].project, { id: "panel-project", workspacePath: "/private/panel" });
    const mount = panel.querySelector("[data-co-tweakers-thread-summary-profiles]");
    assert.ok(mount);
    assert.match(mount.textContent, /panel-project/);
    assert.match(mount.getAttribute("data-profiles-generation"), /^\d+$/);
    assert.doesNotMatch(JSON.stringify(mount.attributes), /private|workspace|threads\/current/i);

    hostContext = { id: "fiber-project" };
    observed();
    await flushFrames();
    assert.deepEqual(calls[1].project, { id: "fiber-project", workspacePath: undefined });
    assert.match(mount.textContent, /fiber-project/);
    hostContext = { id: "next-fiber-project" };
    observed();
    await flushFrames();
    assert.deepEqual(calls[2].project, { id: "next-fiber-project", workspacePath: undefined });
    assert.match(mount.textContent, /next-fiber-project/);
    moduleUnderTest.stop.call(instance);
  });
});

test("Settings page drops a deferred A response after switching to B and cleans up without private route data", async () => {
  await withFakeDom(async ({ flushFrames }) => {
    let hostContext = { id: "project-a" };
    let observed;
    let pageDefinition;
    const deferred = [];
    const api = {
      react: { host: {
        getActiveProject: () => hostContext,
        observe(_topics, callback) { observed = callback; return () => {}; },
      } },
      ipc: { invoke(_channel, request) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        deferred.push({ request, resolve });
        return promise;
      } },
      settings: { registerPage(definition) {
        pageDefinition = definition;
        return { unregister() {} };
      } },
    };
    const instance = {};
    moduleUnderTest.start.call(instance, api);
    const pageRoot = new FakeElement("div");
    pageRoot.isConnected = true;
    const cleanup = pageDefinition.render(pageRoot);
    await Promise.resolve();
    assert.equal(deferred.length, 1);
    assert.deepEqual(deferred[0].request.project, { id: "project-a", workspacePath: undefined });

    hostContext = { id: "project-b" };
    observed();
    await Promise.resolve();
    assert.equal(deferred.length, 2);
    assert.deepEqual(deferred[1].request.project, { id: "project-b", workspacePath: undefined });

    deferred[1].resolve(response("project-b", "B account", 2));
    await Promise.resolve();
    await Promise.resolve();
    assert.match(pageRoot.textContent, /B account/);
    assert.doesNotMatch(pageRoot.textContent, /private|workspace|threads\/current/i);

    deferred[0].resolve(response("project-a", "A account", 1));
    await Promise.resolve();
    await Promise.resolve();
    assert.doesNotMatch(pageRoot.textContent, /A account/);
    assert.match(pageRoot.textContent, /B account/);

    cleanup();
    assert.equal(pageRoot.children.length, 0);
    moduleUnderTest.stop.call(instance);
  });
});

test("revision refreshes reuse the profile signature, while a stale IPC response cannot overwrite the newer generation", async () => {
  await withFakeDom(async ({ document, flushFrames, emit, listeners }) => {
    const { panel } = summaryPanel(document, { projectId: "panel-project", workspacePath: "/private/panel" });
    let hostContext = { id: "project-a" };
    let observed;
    let disconnects = 0;
    let unregisters = 0;
    const deferred = [];
    const api = {
      react: { host: {
        getActiveProject: () => hostContext,
        observe(_topics, callback) { observed = callback; return () => { disconnects += 1; }; },
      } },
      ipc: { invoke(_channel, request) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        deferred.push({ request, resolve });
        return promise;
      } },
      settings: { registerPage: () => ({ unregister: () => { unregisters += 1; } }) },
    };
    const instance = {};
    moduleUnderTest.start.call(instance, api);
    await flushFrames();
    const mount = panel.querySelector("[data-co-tweakers-thread-summary-profiles]");
    assert.equal(deferred.length, 1);

    hostContext = { id: "project-b" };
    observed();
    await flushFrames();
    assert.equal(deferred.length, 2);
    deferred[1].resolve(response("project-b", "B account", 2));
    await Promise.resolve();
    await Promise.resolve();
    assert.match(mount.textContent, /B account/);
    deferred[0].resolve(response("project-a", "A account", 1));
    await Promise.resolve();
    await Promise.resolve();
    assert.doesNotMatch(mount.textContent, /A account/);
    assert.match(mount.textContent, /B account/);

    // A revision event refetches without serializing the profile signature. An
    // identical response leaves the completed DOM in place through applyProjection.
    emit("tweaker:projects-revision");
    await flushFrames();
    assert.equal(deferred.length, 3);
    const before = mount.textContent;
    deferred[2].resolve(response("project-b", "B account", 2));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(mount.textContent, before);
    assert.equal(tweak.applyProjection({ profileSignature: "same" }, mount, { revision: "", projectId: "", rows: [] }), true);

    moduleUnderTest.stop.call(instance);
    assert.equal(disconnects, 1);
    assert.equal(unregisters, 1);
    assert.equal(listeners.get("popstate").size, 0);
    assert.equal(listeners.get("hashchange").size, 0);
    assert.equal(listeners.get("tweaker:projects-revision").size, 0);
    assert.equal(mount.isConnected, false);
    assert.equal(tweak.getState(instance), undefined);
  });
});

test("profile signatures include Projects revisions and malformed rows are dropped", () => {
  const base = { projectId: "project-revi", rows: [{ id: "github", value: "Work" }] };
  assert.notEqual(tweak.profileSignature({ ...base, revision: 10 }), tweak.profileSignature({ ...base, revision: 11 }));
  const projection = tweak.normalizeProfilesProjection({
    ok: true,
    profiles: [{ label: "Nameless", value: "x" }, { type: "github", value: "Work" }, { type: "", id: "  ", value: "y" }],
  });
  assert.deepEqual(projection.rows.map((row) => row.id), ["github"]);
});


test("Projects owns the profiles switch, routes reads through its own service, and disposes mounts independently", async (t) => {
  await withFakeDom(async ({ document, flushFrames }) => {
    const previous = { MutationObserver: global.MutationObserver, requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame };
    t.after(() => Object.assign(global, previous));
    global.MutationObserver = class { observe() {} disconnect() {} };
    global.requestAnimationFrame = window.requestAnimationFrame;
    global.cancelAnimationFrame = window.cancelAnimationFrame;
    document.addEventListener = () => {};
    document.removeEventListener = () => {};
    document.querySelector = () => null;
    window.dispatchEvent = () => {};
    const createElement = document.createElement;
    document.createElement = (tag) => {
      const element = createElement(tag);
      element.listeners = new Map();
      element.addEventListener = (type, listener) => element.listeners.set(type, listener);
      return element;
    };
    const { panel } = summaryPanel(document, { projectId: "owned-project", workspacePath: "/private/owned" });
    const calls = [];
    const writes = [];
    const pages = [];
    const observers = [];
    const api = {
      process: "renderer",
      storage: { get: (_key, fallback) => fallback, set: (key, value) => writes.push([key, value]) },
      react: { host: { query: () => [], observe(topics) { observers.push(topics); return () => {}; } } },
      ipc: { on: () => () => {}, invoke(channel, payload) {
        calls.push([channel, payload]);
        return Promise.resolve(payload.action === "profiles.read" ? response("owned-project", "Owned profile") : { ok: false });
      } },
      settings: { registerPage(page) { pages.push(page); return { unregister() {} }; } },
    };
    const projects = require("../../co.tweakers.projects/index.js");
    const instance = {};
    projects.start.call(instance, api);
    const root = document.createElement("div");
    root.isConnected = true;
    const cleanupPage = pages[0].render(root);
    const toggle = root.querySelector('[role="switch"]');
    assert.equal(toggle.checked, false);
    toggle.checked = true;
    toggle.listeners.get("change")();
    await flushFrames();
    assert.deepEqual(writes, [["threadSummaryProfiles", true]]);
    assert.equal(pages.length, 1, "Profiles shares the Projects settings page");
    assert.ok(observers.some((topics) => topics.includes("thread-context")));
    const profileRead = calls.find(([, payload]) => payload.action === "profiles.read");
    assert.equal(profileRead[0], "projects", "owner reads use the same IPC namespace as the Projects service");
    assert.deepEqual(profileRead[1].project, { id: "owned-project", workspacePath: "/private/owned" });
    assert.match(panel.querySelector('[data-co-tweakers-thread-summary-profiles]').textContent, /Owned profile/);
    toggle.checked = false;
    toggle.listeners.get("change")();
    assert.equal(panel.querySelector('[data-co-tweakers-thread-summary-profiles]'), null);
    assert.deepEqual(writes.at(-1), ["threadSummaryProfiles", false]);
    cleanupPage();
    projects.stop.call(instance);
  });
});

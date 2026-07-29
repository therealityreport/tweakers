"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../index.js");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("nested groups and emoji/Iconify icons validate", () => {
  const state = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "group", type: "group", parentId: null, name: "Work", icon: { kind: "emoji", value: "📁" }, connections: {} },
    { id: "project", type: "project", parentId: "group", name: "App", icon: { kind: "iconify", value: "lucide:rocket" }, connections: { environment: "environment:process" } },
  ] });
  assert.equal(state.nodes[1].parentId, "group");
  assert.deepEqual(state.nodes[1].icon, { kind: "iconify", value: "lucide:rocket" });
  assert.equal(state.nodes[0].color, "#6b7280");
});

test("project colors accept bounded hex values", () => {
  assert.equal(_test.normalizeColor("#AABBCC"), "#aabbcc");
  assert.throws(() => _test.normalizeColor("red"));
});

test("project colors choose the higher-contrast native foreground token", () => {
  assert.equal(_test.projectColorForeground("#ffffff"), "var(--gray-1000)");
  assert.equal(_test.projectColorForeground("#facc15"), "var(--gray-1000)");
  assert.equal(_test.projectColorForeground("#6d28d9"), "var(--gray-0)");
  assert.equal(_test.projectColorForeground("#000000"), "var(--gray-0)");
});

test("uncolored projects migrate to stable automatic palette colors", () => {
  const input = {
    schemaVersion: 1,
    nodes: [
      { id: "project-alpha", type: "project", parentId: null, name: "Alpha", icon: { kind: "emoji", value: "📁" }, projectPath: "/tmp/alpha", connections: {} },
      { id: "project-beta", type: "project", parentId: null, name: "Beta", icon: { kind: "emoji", value: "📁" }, projectPath: "/tmp/beta", connections: {} },
    ],
  };
  const first = _test.normalizeState(input);
  const second = _test.normalizeState(input);

  assert.equal(first.nodes[0].colorMode, "auto");
  assert.equal(first.nodes[0].overlayIntensity, "medium");
  assert.match(first.nodes[0].color, /^#[0-9a-f]{6}$/);
  assert.notEqual(first.nodes[0].color, first.nodes[1].color);
  assert.deepEqual(first, second);
});

test("manual and custom project colors remain manual", () => {
  const state = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "P", icon: { kind: "emoji", value: "📁" }, color: "#123456", connections: {} },
  ] });
  assert.equal(state.nodes[0].colorMode, "manual");
  assert.equal(state.nodes[0].color, "#123456");
  assert.equal(_test.normalizeOverlayIntensity("strong"), "strong");
  assert.throws(() => _test.normalizeOverlayIntensity("maximum"));
});

test("legacy UI Improvements color preferences import by normalized project name", () => {
  const state = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "THB-BBL", icon: { kind: "emoji", value: "📁" }, connections: {} },
  ] });
  const result = _test.mergeLegacyProjectColors(state, {
    "sidebar-project-backgrounds:colors": { "thb-bbl": "green" },
    "sidebar-project-backgrounds:overlays": { "thb-bbl": "strong" },
  });
  assert.equal(result.changed, true);
  assert.equal(result.state.nodes[0].colorMode, "manual");
  assert.equal(result.state.nodes[0].color, "#15803d");
  assert.equal(result.state.nodes[0].overlayIntensity, "strong");
});

test("native project menu receives one working Project color item before Remove", () => {
  const document = new FakeDocument();
  document.defaultView = { innerHeight: 800, innerWidth: 400 };
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const remove = document.createElement("div");
  remove.setAttribute("role", "menuitem");
  remove.textContent = "Remove";
  menu.appendChild(remove);
  const selections = [];
  const context = { project: { id: "p", name: "Alpha", color: "#1d4ed8", colorMode: "manual", overlayIntensity: "medium" } };

  _test.injectProjectColorMenu(document, menu, context, (choice) => selections.push(choice));
  _test.injectProjectColorMenu(document, menu, context, (choice) => selections.push(choice));

  assert.equal(menu.querySelectorAll('[data-tweaker-project-color-menu="trigger"]').length, 1);
  const trigger = menu.querySelector('[data-tweaker-project-color-menu="trigger"]');
  assert.equal(trigger.children.length, 1);
  const triggerContent = trigger.children[0];
  assert.match(triggerContent.className, /\bflex\b/);
  assert.match(triggerContent.className, /\bitems-center\b/);
  assert.match(triggerContent.className, /\bjustify-between\b/);
  assert.equal(triggerContent.children[0].textContent, "Project color");
  assert.equal(triggerContent.children[1].textContent, "›");
  assert.equal(triggerContent.children[1].getAttribute("aria-hidden"), "true");
  trigger.rect = { left: 260, top: 700, right: 300, bottom: 730, width: 40, height: 30 };
  assert.equal(menu.children.indexOf(trigger) < menu.children.indexOf(remove), true);
  trigger.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {}, stopPropagation() {} });
  assert.equal(document.listenerCount(), 2);
  trigger.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  assert.equal(document.body.querySelectorAll('[data-tweaker-project-color-menu="submenu"]').length, 1);
  const submenu = document.body.querySelector('[data-tweaker-project-color-menu="submenu"]');
  assert.equal(submenu.style.values.get("overflow-y"), "auto");
  assert.equal(submenu.style.values.get("overscroll-behavior"), "contain");
  assert.equal(submenu.style.values.get("scrollbar-gutter"), "stable");
  assert.equal(submenu.style.values.get("max-height"), "560px");
  assert.equal(submenu.style.values.get("top"), "232px");
  assert.equal(submenu.style.values.get("left"), "40px");
  assert.equal(document.listenerCount(), 2, "reopening disposes the prior submenu listeners");
  const blue = document.body.querySelector('[data-color-id="blue"]');
  assert.ok(blue);
  blue.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(selections, [{ colorMode: "manual", color: "#1d4ed8" }]);
  assert.equal(document.listenerCount(), 0);
});

test("project overflow resolves from the live project row when semantic hosts are temporarily empty", (t) => {
  const previousElement = global.Element;
  const previousHTMLElement = global.HTMLElement;
  global.Element = FakeElement;
  global.HTMLElement = FakeElement;
  t.after(() => { global.Element = previousElement; global.HTMLElement = previousHTMLElement; });
  const document = new FakeDocument();
  const row = document.createElement("div");
  row.setAttribute("role", "listitem");
  row.setAttribute("aria-label", "tweakers");
  row.classList.add("group/cwd");
  const projectAction = document.createElement("button");
  projectAction.setAttribute("role", "button");
  projectAction.setAttribute("aria-label", "tweakers");
  projectAction.setAttribute("data-app-action-sidebar-project-id", "/Users/example/Projects/tweakers");
  const overflow = document.createElement("button");
  overflow.setAttribute("role", "button");
  overflow.setAttribute("aria-haspopup", "menu");
  const icon = document.createElement("svg");
  overflow.appendChild(icon);
  row.append(projectAction, overflow);
  document.body.appendChild(row);
  const state = { nodes: [
    { id: "p-other", type: "project", name: "tweakers", projectPath: "/Users/example/Archives/tweakers", color: "#15803d", colorMode: "manual", overlayIntensity: "medium" },
    { id: "p", type: "project", name: "tweakers", projectPath: "/Users/example/Projects/tweakers", color: "#1d4ed8", colorMode: "manual", overlayIntensity: "medium" },
  ] };
  const api = { react: { host: { query: () => [] } } };

  const context = _test.resolveProjectContext(api, state, icon);
  assert.equal(context.project.id, "p");
  assert.equal(context.container, row);
  assert.equal(context.element, projectAction);
  assert.equal(context.source, "live-row");
});

test("renamed native projects retain their saved color and menu identity by workspace path", (t) => {
  const previousDocument = global.document;
  const previousElement = global.Element;
  const previousHTMLElement = global.HTMLElement;
  const document = new FakeDocument();
  global.document = document;
  global.Element = FakeElement;
  global.HTMLElement = FakeElement;
  t.after(() => {
    global.document = previousDocument;
    global.Element = previousElement;
    global.HTMLElement = previousHTMLElement;
  });

  const nativeProjects = _test.normalizeNativeLocalProjects({
    "local-projects": {
      "local-project-manager": {
        id: "local-project-manager",
        name: "PROJECT MANAGER",
        rootPaths: ["/Users/example/Projects/SKILLS MANAGER"],
      },
    },
  });
  const savedState = {
    schemaVersion: 1,
    nodes: [{
      id: "project-skills-manager",
      type: "project",
      parentId: null,
      name: "SKILLS MANAGER",
      icon: { kind: "emoji", value: "📁" },
      color: "#6d28d9",
      colorMode: "manual",
      overlayIntensity: "strong",
      projectPath: "/Users/example/Projects/SKILLS MANAGER",
      connections: {},
    }],
  };
  const runtimeState = _test.bindNativeProjectIdentities(savedState, nativeProjects);
  assert.deepEqual(runtimeState.nodes[0].nativeProjectIds, ["local-project-manager"]);
  assert.deepEqual(runtimeState.nodes[0].nativeProjectNames, ["PROJECT MANAGER"]);
  assert.equal(_test.normalizeState(runtimeState).nodes[0].name, "SKILLS MANAGER", "runtime aliases never replace saved project data");
  assert.equal(_test.normalizeState(runtimeState).nodes[0].nativeProjectIds, undefined);

  const container = document.createElement("div");
  container.setAttribute("role", "listitem");
  const row = document.createElement("button");
  row.setAttribute("data-app-action-sidebar-project-id", "local-project-manager");
  row.setAttribute("aria-label", "PROJECT MANAGER");
  const icon = document.createElement("svg");
  const title = document.createElement("span");
  title.textContent = "PROJECT MANAGER";
  row.append(icon, title);
  container.appendChild(row);
  document.body.appendChild(container);
  const api = { react: { host: { query: () => [{ element: row, label: "PROJECT MANAGER" }] } } };

  const context = _test.resolveProjectContext(api, runtimeState, icon);
  assert.equal(context.project.id, "project-skills-manager");
  assert.equal(context.project.color, "#6d28d9");

  _test.applyNativeProjectColors(api, runtimeState);
  assert.equal(row.getAttribute("data-tweaker-project-color-row"), "true");
  assert.equal(row.style.values.get("--tweaker-project-color"), "#6d28d9");
  assert.equal(title.getAttribute("data-tweaker-project-color-title"), "true");
});

test("moved native projects retain their saved appearance through Codex's workspace-root label alias", () => {
  const oldPath = "/Users/example/Projects/SKILLS MANAGER";
  const newPath = "/Users/example/Projects/PROJECT MANAGER";
  const nativeProjects = _test.normalizeNativeLocalProjects({
    "local-projects": {
      "local-project-manager": {
        id: "local-project-manager",
        name: "PROJECT MANAGER",
        rootPaths: [newPath],
      },
    },
    "electron-workspace-root-labels": {
      [oldPath]: "PROJECT MANAGER",
    },
  });
  const savedState = {
    schemaVersion: 1,
    nodes: [{
      id: "project-skills-manager",
      type: "project",
      parentId: null,
      name: "SKILLS MANAGER",
      icon: { kind: "emoji", value: "📁" },
      color: "#6d28d9",
      colorMode: "manual",
      overlayIntensity: "strong",
      projectPath: oldPath,
      connections: {},
    }],
  };

  assert.deepEqual(nativeProjects[0].rootPathAliases, [oldPath]);
  const runtimeState = _test.bindNativeProjectIdentities(savedState, nativeProjects);
  assert.deepEqual(runtimeState.nodes[0].nativeProjectIds, ["local-project-manager"]);
  assert.deepEqual(runtimeState.nodes[0].nativeProjectNames, ["PROJECT MANAGER"]);
  assert.deepEqual(runtimeState.nodes[0].nativeProjectPaths, [newPath]);
  assert.equal(
    _test.projectForNativeIdentity(runtimeState.nodes, "PROJECT MANAGER", newPath)?.id,
    "project-skills-manager",
  );
});

test("workspace-root label aliases fail closed when more than one native project has the same name", () => {
  const nativeProjects = _test.normalizeNativeLocalProjects({
    "local-projects": {
      "local-project-manager-a": {
        id: "local-project-manager-a",
        name: "PROJECT MANAGER",
        rootPaths: ["/Users/example/Projects/PROJECT MANAGER"],
      },
      "local-project-manager-b": {
        id: "local-project-manager-b",
        name: "PROJECT MANAGER",
        rootPaths: ["/Users/example/Archives/PROJECT MANAGER"],
      },
    },
    "electron-workspace-root-labels": {
      "/Users/example/Projects/SKILLS MANAGER": "PROJECT MANAGER",
    },
  });

  assert.equal(nativeProjects[0].rootPathAliases, undefined);
  assert.equal(nativeProjects[1].rootPathAliases, undefined);
});

test("native menu targeting chooses the nearest visible open project menu", () => {
  const document = new FakeDocument();
  const makeMenu = ({ state, left, top, width = 220, height = 320 }) => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", state);
    menu.rect = { left, top, right: left + width, bottom: top + height, width, height };
    const remove = document.createElement("div");
    remove.setAttribute("role", "menuitem");
    remove.textContent = "Remove";
    menu.appendChild(remove);
    document.body.appendChild(menu);
    return menu;
  };
  const stale = makeMenu({ state: "closed", left: 290, top: 190 });
  const unrelated = makeMenu({ state: "open", left: 20, top: 20 });
  const hidden = makeMenu({ state: "open", left: 300, top: 200, width: 0, height: 0 });
  const projectMenu = makeMenu({ state: "open", left: 310, top: 205 });

  assert.equal(_test.findNativeProjectMenu(document, { x: 300, y: 200 }), projectMenu);
  assert.notEqual(_test.findNativeProjectMenu(document, { x: 300, y: 200 }), stale);
  assert.notEqual(_test.findNativeProjectMenu(document, { x: 300, y: 200 }), unrelated);
  assert.notEqual(_test.findNativeProjectMenu(document, { x: 300, y: 200 }), hidden);
});

test("project tint rerenders immediately and teardown stays inside the semantic project row", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  const previousHTMLElement = global.HTMLElement;
  global.document = document;
  global.HTMLElement = FakeElement;
  t.after(() => { global.document = previousDocument; global.HTMLElement = previousHTMLElement; });
  const row = document.createElement("div");
  row.setAttribute("role", "listitem");
  row.setAttribute("aria-label", "Alpha");
  const icon = document.createElement("svg");
  const title = document.createElement("span");
  title.textContent = "Alpha";
  row.append(icon, title);
  const unrelated = document.createElement("div");
  unrelated.textContent = "Tasks";
  document.body.append(row, unrelated);
  const api = { react: { host: { query: () => [{ element: row }] } } };

  _test.applyNativeProjectColors(api, { nodes: [{ type: "project", name: "Alpha", color: "#1d4ed8", overlayIntensity: "medium" }] });
  assert.equal(row.getAttribute("data-tweaker-project-color-row"), "true");
  assert.equal(row.style.values.get("--tweaker-project-color"), "#1d4ed8");
  assert.equal(icon.getAttribute("data-tweaker-project-color-icon"), "true");
  assert.equal(title.getAttribute("data-tweaker-project-color-title"), "true");
  assert.equal(unrelated.getAttribute("data-tweaker-project-color-child"), null);

  _test.applyNativeProjectColors(api, { nodes: [{ type: "project", name: "Alpha", color: "#15803d", overlayIntensity: "strong" }] });
  assert.equal(row.style.values.get("--tweaker-project-color"), "#15803d");
  assert.equal(row.getAttribute("data-tweaker-project-overlay"), "strong");
  _test.removeProjectColorArtifacts();
  assert.equal(row.getAttribute("data-tweaker-project-color-row"), null);
  assert.equal(icon.getAttribute("data-tweaker-project-color-icon"), null);
  assert.equal(title.getAttribute("data-tweaker-project-color-title"), null);
  assert.equal(document.getElementById("tweaker-project-colors"), null);
});

test("live group/cwd project rows paint when the semantic host query is empty", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  const previousHTMLElement = global.HTMLElement;
  global.document = document;
  global.HTMLElement = FakeElement;
  t.after(() => { global.document = previousDocument; global.HTMLElement = previousHTMLElement; });

  const sidebar = document.createElement("nav");
  const heading = document.createElement("div");
  heading.textContent = "Projects";
  const group = document.createElement("div");
  group.classList.add("group/cwd");
  const header = document.createElement("button");
  header.setAttribute("data-app-action-sidebar-project-id", "/Users/example/tweakers");
  const icon = document.createElement("svg");
  const title = document.createElement("span");
  title.textContent = "tweakers";
  header.append(icon, title);
  const headerWrapper = document.createElement("div");
  headerWrapper.setAttribute("role", "listitem");
  headerWrapper.appendChild(header);
  const task = document.createElement("button");
  task.textContent = "Debug project folder colors";
  task.setAttribute("aria-current", "page");
  const showMore = document.createElement("button");
  showMore.textContent = "Show more";
  group.append(headerWrapper, task, showMore);
  sidebar.append(heading, group);
  const unrelated = document.createElement("button");
  unrelated.textContent = "Debug project folder colors";
  document.body.append(sidebar, unrelated);
  const api = { react: { host: { query: () => [] } } };

  _test.applyNativeProjectColors(api, { nodes: [{ id: "project-tweakers", type: "project", name: "tweakers", projectPath: "/Users/example/tweakers", color: "#334155", overlayIntensity: "medium" }] });

  assert.equal(group.getAttribute("data-tweaker-project-color-group"), "true");
  assert.equal(header.getAttribute("data-tweaker-project-color-row"), "true");
  assert.equal(icon.getAttribute("data-tweaker-project-color-icon"), "true");
  assert.equal(title.getAttribute("data-tweaker-project-color-title"), "true");
  assert.equal(task.getAttribute("data-tweaker-project-color-task"), "true");
  assert.equal(task.getAttribute("data-tweaker-project-selected"), "true");
  assert.equal(showMore.getAttribute("data-tweaker-project-show-more"), "true");
  assert.equal(unrelated.getAttribute("data-tweaker-project-color-task"), null);
});

test("project hierarchy uses bold full-color headers and contrast-safe selected rows", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  const previousHTMLElement = global.HTMLElement;
  global.document = document;
  global.HTMLElement = FakeElement;
  t.after(() => { global.document = previousDocument; global.HTMLElement = previousHTMLElement; });

  const project = document.createElement("div");
  project.setAttribute("role", "listitem");
  project.setAttribute("aria-label", "TRR");
  const header = document.createElement("button");
  header.setAttribute("role", "button");
  header.setAttribute("aria-label", "TRR");
  header.setAttribute("data-app-action-sidebar-project-id", "/Users/example/TRR");
  header.setAttribute("aria-current", "page");
  const projectIcon = document.createElement("svg");
  const title = document.createElement("span");
  title.textContent = "TRR";
  const overflow = document.createElement("button");
  const overflowIcon = document.createElement("svg");
  overflow.appendChild(overflowIcon);
  header.append(projectIcon, title, overflow);

  const taskList = document.createElement("div");
  taskList.setAttribute("role", "list");
  const task = document.createElement("div");
  task.setAttribute("role", "listitem");
  const taskAction = document.createElement("button");
  const taskLabel = document.createElement("span");
  taskLabel.textContent = "Write audit fix plan with a deliberately long nested label";
  taskAction.appendChild(taskLabel);
  task.appendChild(taskAction);
  const selectedTask = document.createElement("div");
  selectedTask.setAttribute("role", "listitem");
  const selectedTaskAction = document.createElement("button");
  selectedTaskAction.setAttribute("data-state", "active");
  selectedTaskAction.textContent = "Locate realtime Supabase";
  const selectedTaskIcon = document.createElement("svg");
  selectedTaskAction.appendChild(selectedTaskIcon);
  selectedTask.appendChild(selectedTaskAction);
  const showMore = document.createElement("button");
  showMore.textContent = "Show more";
  taskList.append(task, selectedTask, showMore);
  project.append(header, taskList);

  const unrelated = document.createElement("div");
  unrelated.setAttribute("role", "listitem");
  unrelated.textContent = "Chats";
  document.body.append(project, unrelated);
  const api = { react: { host: { query: () => [{ element: header }] } } };
  const state = { nodes: [{ id: "trr", type: "project", name: "TRR", projectPath: "/Users/example/TRR", color: "#6d28d9", overlayIntensity: "medium" }] };

  _test.applyNativeProjectColors(api, state);

  assert.equal(project.getAttribute("data-tweaker-project-color-group"), "true");
  assert.equal(header.getAttribute("data-tweaker-project-color-row"), "true");
  assert.equal(header.getAttribute("data-tweaker-project-selected"), "true");
  assert.equal(projectIcon.getAttribute("data-tweaker-project-color-icon"), "true");
  assert.equal(overflowIcon.getAttribute("data-tweaker-project-color-icon"), "true");
  assert.equal(title.getAttribute("data-tweaker-project-color-title"), "true");
  assert.equal(title.textContent, "TRR", "saved casing is preserved");
  assert.equal(task.getAttribute("data-tweaker-project-color-task"), "true");
  assert.equal(taskAction.getAttribute("data-tweaker-project-task-action"), "true");
  assert.equal(taskLabel.getAttribute("data-tweaker-project-task-label"), "true");
  assert.equal(task.getAttribute("data-tweaker-project-selected"), null);
  assert.equal(selectedTask.getAttribute("data-tweaker-project-color-task"), "true");
  assert.equal(selectedTaskAction.getAttribute("data-tweaker-project-task-action"), "true");
  assert.equal(selectedTaskAction.getAttribute("data-tweaker-project-task-label"), "true");
  assert.equal(selectedTask.getAttribute("data-tweaker-project-selected"), "true");
  assert.equal(showMore.getAttribute("data-tweaker-project-show-more"), "true");
  assert.equal(unrelated.getAttribute("data-tweaker-project-color-task"), null);
  assert.equal(header.style.values.get("--tweaker-project-foreground"), "var(--gray-0)");
  assert.equal(selectedTask.style.values.get("--tweaker-project-foreground"), "var(--gray-0)");

  const css = document.getElementById("tweaker-project-colors").textContent;
  assert.match(css, /\[data-tweaker-project-color-group\][^}]*inline-size:\s*100%\s*!important/s);
  assert.match(css, /\[data-tweaker-project-color-group\][^}]*min-inline-size:\s*0/s);
  assert.match(css, /\[data-tweaker-project-color-group\][^}]*max-inline-size:\s*100%/s);
  assert.doesNotMatch(css, /--tweaker-project-row-end-inset/);
  assert.match(css, /\[data-tweaker-project-color-group\][^}]*contain:\s*inline-size/s);
  assert.doesNotMatch(css, /\[data-tweaker-project-color-group\][^}]*margin-inline-end/s);
  assert.doesNotMatch(css, /\[data-tweaker-project-color-group\][^}]*padding-inline-end/s);
  assert.match(css, /\[data-tweaker-project-color-group\][^}]*overflow-x:\s*visible/s);
  assert.match(css, /data-tweaker-project-color-group[^}]*role="list"[^}]*data-tweaker-project-color-row[^}]*data-tweaker-project-color-task[^}]*data-tweaker-project-show-more[^}]*data-tweaker-project-task-action[^}]*box-sizing:\s*border-box/s);
  assert.match(css, /data-tweaker-project-color-group[^}]*role="list"[^}]*data-tweaker-project-color-row[^}]*data-tweaker-project-color-task[^}]*data-tweaker-project-show-more[^}]*data-tweaker-project-task-action[^}]*inline-size:\s*100%\s*!important/s);
  assert.match(css, /data-tweaker-project-color-group[^}]*role="list"[^}]*data-tweaker-project-color-row[^}]*data-tweaker-project-color-task[^}]*data-tweaker-project-show-more[^}]*data-tweaker-project-task-action[^}]*min-inline-size:\s*0/s);
  assert.match(css, /data-tweaker-project-color-group[^}]*role="list"[^}]*data-tweaker-project-color-row[^}]*data-tweaker-project-color-task[^}]*data-tweaker-project-show-more[^}]*data-tweaker-project-task-action[^}]*max-inline-size:\s*100%/s);
  assert.match(css, /\[data-tweaker-project-color-row\][^}]*overflow-x:\s*visible\s*!important/s);
  assert.match(css, /\[data-tweaker-project-task-action\][^}]*overflow:\s*hidden/s);
  assert.match(css, /\[data-tweaker-project-task-action\]\s*>\s*\[data-tweaker-project-task-label\][^}]*flex:\s*1 1 auto/s);
  assert.match(css, /data-tweaker-project-color-title[^}]*data-tweaker-project-task-label[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /data-tweaker-project-color-row[^}]*background-color:\s*var\(--tweaker-project-color\)/s);
  assert.match(css, /data-tweaker-project-color-title[^}]*font-weight:\s*700/s);
  assert.match(css, /data-tweaker-project-color-title[^}]*text-transform:\s*uppercase/s);
  assert.match(css, /data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\][^}]*background-color:\s*var\(--gray-1000\)/s);
  assert.match(css, /data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\][^}]*color:\s*var\(--gray-0\)/s);
  assert.match(css, /data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\]\s+\*[^}]*color:\s*var\(--gray-0\)/s);
  assert.match(css, /\[data-tweaker-project-color-group\][^}]*--tweaker-project-row-radius:\s*var\(--radius-lg,\s*0\.625rem\)/s);
  assert.match(css, /\[data-tweaker-project-color-row\][^}]*border-radius:\s*var\(--tweaker-project-row-radius\)\s*!important/s);
  assert.match(css, /\[data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\][^}]*border-radius:\s*var\(--tweaker-project-row-radius\)\s*!important/s);
  assert.match(css, /\[data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\][^}]*outline:\s*2px solid var\(--color-token-focus-border,\s*var\(--color-token-text-link-foreground\)\)\s*!important/s);
  assert.match(css, /\[data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\][^}]*outline-offset:\s*0\s*!important/s);
  assert.doesNotMatch(css, /\[data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\]::after/);
  assert.match(css, /data-tweaker-project-task-label[^}]*font-weight:\s*400/s);
  assert.match(css, /data-tweaker-project-color-task.*data-tweaker-project-selected[^}]*data-tweaker-project-task-label[^}]*color:\s*var\(--tweaker-project-foreground\)/s);
  assert.match(css, /data-tweaker-project-color-task.*data-tweaker-project-selected[^}]*svg[^}]*color:\s*var\(--tweaker-project-foreground\)/s);
  assert.match(css, /data-tweaker-project-color-row.*data-tweaker-project-selected[^}]*data-tweaker-project-color-icon[^}]*color:\s*var\(--gray-0\)/s);
  assert.doesNotMatch(css, /\[data-tweaker-project-color-row\]\[data-tweaker-project-selected="true"\][^}]*box-shadow/s);
  assert.doesNotMatch(css, /data-tweaker-project-color-task\]\s+:is/);
  assert.match(css, /electron-dark[^}]*--tweaker-project-task-foreground/s);

  document.getElementById("tweaker-project-colors").textContent = "/* stale hot-reload stylesheet */";
  _test.applyNativeProjectColors(api, state);
  assert.match(document.getElementById("tweaker-project-colors").textContent, /\[data-tweaker-project-color-group\][^}]*inline-size:\s*100%\s*!important/s);
  assert.equal(project.querySelectorAll("[data-tweaker-project-color-row]").length, 1);
  assert.equal(project.querySelectorAll("[data-tweaker-project-color-task]").length, 2);

  _test.removeProjectColorArtifacts();
  assert.equal(project.getAttribute("data-tweaker-project-color-group"), null);
  assert.equal(header.getAttribute("data-tweaker-project-color-row"), null);
  assert.equal(header.getAttribute("data-tweaker-project-selected"), null);
  assert.equal(projectIcon.getAttribute("data-tweaker-project-color-icon"), null);
  assert.equal(overflowIcon.getAttribute("data-tweaker-project-color-icon"), null);
  assert.equal(title.getAttribute("data-tweaker-project-color-title"), null);
  assert.equal(task.getAttribute("data-tweaker-project-color-task"), null);
  assert.equal(taskAction.getAttribute("data-tweaker-project-task-label"), null);
  assert.equal(taskAction.getAttribute("data-tweaker-project-task-action"), null);
  assert.equal(taskLabel.getAttribute("data-tweaker-project-task-label"), null);
  assert.equal(selectedTask.getAttribute("data-tweaker-project-color-task"), null);
  assert.equal(selectedTaskAction.getAttribute("data-tweaker-project-task-action"), null);
  assert.equal(selectedTaskAction.getAttribute("data-tweaker-project-task-label"), null);
  assert.equal(header.style.values.has("--tweaker-project-foreground"), false);
  assert.equal(selectedTask.style.values.has("--tweaker-project-foreground"), false);
  assert.equal(selectedTask.getAttribute("data-tweaker-project-selected"), null);
  assert.equal(showMore.getAttribute("data-tweaker-project-show-more"), null);
  assert.equal(document.getElementById("tweaker-project-colors"), null);
});

test("task selection promotes the parent project header to active black", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  const previousHTMLElement = global.HTMLElement;
  global.document = document;
  global.HTMLElement = FakeElement;
  t.after(() => { global.document = previousDocument; global.HTMLElement = previousHTMLElement; });

  const project = document.createElement("div");
  project.setAttribute("role", "listitem");
  project.setAttribute("aria-label", "Mixed Case");
  const header = document.createElement("button");
  header.setAttribute("aria-label", "Mixed Case");
  header.setAttribute("data-app-action-sidebar-project-id", "/Users/example/Mixed Case");
  const title = document.createElement("span");
  title.textContent = "Mixed Case";
  header.appendChild(title);
  const taskList = document.createElement("div");
  taskList.setAttribute("role", "list");
  const selectedAttributes = [["aria-current", "page"], ["aria-selected", "true"], ["data-state", "active"]];
  const tasks = selectedAttributes.map(([attribute, value], index) => {
    const task = document.createElement("div");
    task.setAttribute("role", "listitem");
    const action = document.createElement("button");
    action.setAttribute(attribute, value);
    action.textContent = `Selected task ${index + 1}`;
    task.appendChild(action);
    taskList.appendChild(task);
    return task;
  });
  project.append(header, taskList);
  document.body.appendChild(project);
  const api = { react: { host: { query: () => [{ element: header }] } } };

  _test.applyNativeProjectColors(api, { nodes: [{ id: "mixed", type: "project", name: "Mixed Case", projectPath: "/Users/example/Mixed Case", color: "#0369a1", overlayIntensity: "subtle" }] });

  assert.equal(header.getAttribute("data-tweaker-project-selected"), "true");
  assert.equal(title.textContent, "Mixed Case", "uppercase remains a visual treatment only");
  for (const task of tasks) assert.equal(task.getAttribute("data-tweaker-project-selected"), "true");
});

test("all task tint levels bind to semantic descendants in light and dark themes", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  const previousHTMLElement = global.HTMLElement;
  global.document = document;
  global.HTMLElement = FakeElement;
  t.after(() => { global.document = previousDocument; global.HTMLElement = previousHTMLElement; });

  const project = document.createElement("div");
  project.setAttribute("role", "listitem");
  project.setAttribute("aria-label", "Alpha");
  const header = document.createElement("button");
  header.setAttribute("aria-label", "Alpha");
  const title = document.createElement("span");
  title.textContent = "Alpha";
  header.appendChild(title);
  const list = document.createElement("div");
  list.setAttribute("role", "list");
  const task = document.createElement("div");
  task.setAttribute("role", "listitem");
  const taskLabel = document.createElement("span");
  taskLabel.textContent = "Fix";
  const taskStatus = document.createElement("span");
  taskStatus.setAttribute("role", "status");
  taskStatus.textContent = "Updated twelve minutes ago";
  const taskAction = document.createElement("button");
  taskAction.append(taskLabel, taskStatus);
  task.appendChild(taskAction);
  list.appendChild(task);
  project.append(header, list);
  document.body.appendChild(project);
  const api = { react: { host: { query: () => [{ element: header }] } } };
  const light = { off: 0, subtle: 6, medium: 10, strong: 15 };
  const dark = { off: 0, subtle: 11, medium: 18, strong: 24 };

  for (const [theme, levels] of Object.entries({ light, dark })) {
    if (theme === "dark") document.body.classList.add("electron-dark");
    else document.body.classList.remove("electron-dark");
    for (const [overlayIntensity, percentage] of Object.entries(levels)) {
      _test.applyNativeProjectColors(api, { nodes: [{ id: "alpha", type: "project", name: "Alpha", color: "#1d4ed8", overlayIntensity }] });
      assert.equal(project.getAttribute("data-tweaker-project-overlay"), overlayIntensity);
      assert.equal(header.getAttribute("data-tweaker-project-color-row"), "true");
      assert.equal(task.getAttribute("data-tweaker-project-color-task"), "true");
      assert.equal(taskLabel.getAttribute("data-tweaker-project-task-label"), "true");
      assert.equal(taskStatus.getAttribute("data-tweaker-project-task-label"), null);
      const css = document.getElementById("tweaker-project-colors").textContent;
      if (theme === "dark" && overlayIntensity !== "off") {
        assert.match(css, new RegExp(`electron-dark[^}]*project-overlay="${overlayIntensity}"[^}]*project-task-tint:\\s*${percentage}%`, "s"));
      } else {
        assert.match(css, new RegExp(`project-overlay="${overlayIntensity}"[^}]*project-task-tint:\\s*${percentage}%`, "s"));
      }
    }
  }
});

test("legacy Bennett color import runs once and cannot reassert after choosing Auto", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-legacy-color-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "tweak-data", "co.tweakers.projects");
  const storageDir = path.join(root, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "co.bennett.ui-improvements.json"), JSON.stringify({
    "sidebar-project-backgrounds:colors": { alpha: "green" },
  }));
  const initial = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "Alpha", icon: { kind: "emoji", value: "📁" }, connections: {} },
  ] });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, "projects-v1.json"), JSON.stringify(initial), { mode: 0o600 });
  const api = { fs: { dataDir }, ipc: { send() {} } };
  const first = _test.createService(api);
  const imported = await first.handle({ action: "get" });
  assert.equal(imported.state.nodes[0].colorMode, "manual");
  assert.equal(imported.state.nodes[0].color, "#15803d");
  const autoState = { ...imported.state, nodes: imported.state.nodes.map((node) => ({ ...node, colorMode: "auto" })) };
  assert.equal((await first.handle({ action: "save", state: autoState })).ok, true);
  first.dispose();
  const second = _test.createService(api);
  assert.equal((await second.handle({ action: "get" })).state.nodes[0].colorMode, "auto");
  second.dispose();
});

test("legacy color import waits for native project discovery before completing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-late-legacy-color-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "tweak-data", "co.tweakers.projects");
  const storageDir = path.join(root, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "co.bennett.ui-improvements.json"), JSON.stringify({
    "sidebar-project-backgrounds:colors": { alpha: "violet" },
  }));
  const api = { fs: { dataDir }, ipc: { send() {} } };
  const emptyService = _test.createService(api);
  assert.equal(fs.existsSync(path.join(dataDir, ".legacy-project-colors-imported-v1")), false);
  const projectState = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "Alpha", icon: { kind: "emoji", value: "📁" }, connections: {} },
  ] });
  assert.equal((await emptyService.handle({ action: "save", state: projectState })).ok, true);
  emptyService.dispose();
  const discoveredService = _test.createService(api);
  const imported = await discoveredService.handle({ action: "get" });
  assert.equal(imported.state.nodes[0].colorMode, "manual");
  assert.equal(imported.state.nodes[0].color, "#6d28d9");
  assert.equal(fs.existsSync(path.join(dataDir, ".legacy-project-colors-imported-v1")), true);
  discoveredService.dispose();
});

test("project storage rejects secrets and absolute paths", () => {
  for (const ref of [
    "environment:token=secret",
    "/Users/example/.env",
    "supabase:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
    "environment:sk-proj-exampleCredential123",
  ]) {
    assert.throws(() => _test.normalizeState({ schemaVersion: 1, nodes: [
      { id: "p", type: "project", parentId: null, name: "P", icon: { kind: "emoji", value: "📌" }, connections: { environment: ref } },
    ] }));
  }
});

test("profile projection fails closed if a stored reference becomes secret-shaped", () => {
  const state = { schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "P", icon: { kind: "emoji", value: "📌" }, connections: { environment: "environment:sk-proj-leaked" } },
  ] };
  const result = _test.readProfilesProjection(state, { action: "profiles.read", version: 1, project: { id: "p" } });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("sk-proj"), false);
});

test("GitHub command allowlist is read-only", () => {
  assert.deepEqual(_test.normalizeGitHubArgs(["pr", "view", "12"]), ["pr", "view", "12"]);
  for (const argv of [["auth", "switch"], ["api", "/user"], ["pr", "merge", "12"], ["repo", "view", "; rm -rf /"]]) {
    assert.throws(() => _test.normalizeGitHubArgs(argv));
  }
});

test("redaction removes nested credential fields and token strings", () => {
  const output = _test.redact({ token: "secret", nested: { message: "Bearer abc", envValue: "x" } });
  assert.equal(JSON.stringify(output).includes("secret"), false);
  assert.equal(JSON.stringify(output).includes("Bearer abc"), false);
  assert.equal(JSON.stringify(output).includes("envValue"), true);
});

test("legacy GitHub assignments merge without creating duplicate accounts", () => {
  const state = { schemaVersion: 1, nodes: [{ id: "p", type: "project", parentId: null, name: "P", icon: { kind: "emoji", value: "📌" }, connections: {} }] };
  const ref = "gh:0123456789abcdef01234567";
  const merged = _test.mergeLegacyAssignments(state, { assignments: { p: ref } });
  assert.equal(merged.nodes[0].connections.github, ref);
  assert.equal(Object.keys(merged.nodes[0].connections).length, 1);
});

test("all seven connection reference kinds are bounded and assignable", () => {
  const refs = {
    github: "gh:0123456789abcdef01234567", modal: "modal:default", google: "google:default",
    chrome: "chrome:default", "google-workspace": "google-workspace:default",
    supabase: "supabase:default", environment: "environment:default",
  };
  for (const [type, ref] of Object.entries(refs)) assert.equal(_test.safeReference(type, ref), ref);
});

test("friendly Chrome profile names normalize to safe stable references", () => {
  assert.equal(_test.normalizeChromeProfileReference("  TRR Admin  "), "chrome:TRR-Admin");
  assert.equal(_test.normalizeChromeProfileReference("Tweakers / Work"), "chrome:Tweakers-Work");
  assert.equal(_test.chromeProfileDisplayName("chrome:TRR-Admin"), "TRR Admin");
  assert.equal(_test.chromeProfileDisplayName("chrome:default"), "Default (legacy)");
  assert.throws(() => _test.normalizeChromeProfileReference("---"));
  assert.throws(() => _test.normalizeChromeProfileReference("x".repeat(81)));
});

test("Chrome profile assignments can be added, replaced, and removed", () => {
  const state = { schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "TRR", icon: { kind: "emoji", value: "📌" }, connections: { chrome: "chrome:default" } },
  ] };
  const replaced = _test.updateChromeProfileAssignment(state, "p", "TRR Admin");
  assert.equal(replaced.nodes[0].connections.chrome, "chrome:TRR-Admin");
  assert.equal(state.nodes[0].connections.chrome, "chrome:default", "the input state is not mutated");
  const removed = _test.updateChromeProfileAssignment(replaced, "p", "   ");
  assert.equal(Object.hasOwn(removed.nodes[0].connections, "chrome"), false);
  assert.throws(() => _test.updateChromeProfileAssignment(state, "missing", "TRR"));
});

test("profile projection keeps the safe Chrome reference and adds its friendly display value", () => {
  const state = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "TRR", icon: { kind: "emoji", value: "📌" }, connections: { chrome: "chrome:TRR-Admin" } },
  ] });
  const result = _test.readProfilesProjection(state, { action: "profiles.read", version: 1, project: { id: "p" } });
  assert.deepEqual(result.profiles, [{
    type: "chrome",
    label: "Chrome",
    status: "configured",
    value: "chrome:TRR-Admin",
    displayValue: "TRR Admin",
  }]);
});

test("Chrome detection does not manufacture a default profile assignment", () => {
  assert.doesNotMatch(source, /chrome:\s*existsSync\(probe\.chromeState\)/);
  assert.match(source, /result\.chrome\s*=\s*existsSync\(probe\.chromeState\)[\s\S]*status:\s*"available",\s*refs:\s*\[\]/);
  assert.match(source, /Set, replace, or remove this project's Chrome profile/);
  assert.match(source, /Leave blank to remove this assignment/);
});

test("GitHub IPC is read-only, project-bound, and uses per-command GH_TOKEN", () => {
  assert.match(source, /case "github\.run"/);
  assert.match(source, /GH_TOKEN:\s*token/);
  assert.match(source, /GH_REPO:\s*project\.githubRepo/);
  assert.doesNotMatch(source, /gh",\s*\["auth",\s*"switch"/);
});

test("explicit migration action uses the legacy merge helper", () => {
  assert.match(source, /case "migrate-legacy"[\s\S]*mergeLegacyAssignments\(state, message\.legacy\)/);
});

test("AGENTS hierarchy applies the nearest locked follow-up exception", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "projects-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "group", "project");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "<!-- codex-follow-up: exact-five -->\n");
  fs.writeFileSync(path.join(root, "group", "AGENTS.md"), "<!-- codex-follow-up: disabled -->\n");
  assert.deepEqual(_test.readFollowupPolicy(workspace, { maxFiles: 16 }), {
    schemaVersion: 1, enabled: false, exactItems: 5, exception: "disabled-by-applicable-agents",
  });
});

test("AGENTS policy reader rejects symlinks, oversized files, and deep hierarchies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-policy-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const outside = path.join(root, "outside.md"); fs.writeFileSync(outside, "<!-- codex-follow-up: disabled -->");
  fs.symlinkSync(outside, path.join(workspace, "AGENTS.md"));
  assert.equal(_test.readFollowupPolicy(workspace, { maxFiles: 16 }).ok, false);
  fs.unlinkSync(path.join(workspace, "AGENTS.md"));
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "x".repeat(65 * 1024));
  assert.equal(_test.readFollowupPolicy(workspace, { maxFiles: 16 }).ok, false);
  let deep = root; for (let i = 0; i < 9; i += 1) { deep = path.join(deep, `d${i}`); fs.mkdirSync(deep); }
  assert.equal(_test.readFollowupPolicy(deep, { maxFiles: 4 }).ok, false);
});

test("save and migration emit revision events", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-revision-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const events = [];
  const service = _test.createService({ fs: { dataDir }, ipc: { send: (...args) => events.push(args) } });
  const state = { schemaVersion: 1, nodes: [] };
  assert.equal((await service.handle({ action: "save", state })).ok, true);
  assert.equal((await service.handle({ action: "migrate-legacy", legacy: { assignments: {} } })).ok, true);
  assert.equal(events.length, 2);
  assert.ok(events.every(([channel, payload]) => channel === "revision" && /^[a-f0-9]{32}$/.test(payload.revision)));
});

test("save enforces optimistic concurrency via base revision", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-concurrency-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const service = _test.createService({ fs: { dataDir }, ipc: { send() {} } });

  const rev0 = _test.revisionForState(_test.normalizeState({ schemaVersion: 1, nodes: [] }));
  const node = { id: "g-1", type: "group", parentId: null, name: "Work", icon: { kind: "emoji", value: "📁" }, connections: {} };

  const first = await service.handle({ action: "save", state: { schemaVersion: 1, nodes: [node] }, baseRevision: rev0 });
  assert.equal(first.ok, true, "save on the current revision succeeds");

  // A second window still holding rev0 must be rejected, not silently clobber.
  const stale = await service.handle({ action: "save", state: { schemaVersion: 1, nodes: [] }, baseRevision: rev0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "stale-revision");

  // No baseRevision provided → backward-compatible last-write-wins.
  const loose = await service.handle({ action: "save", state: { schemaVersion: 1, nodes: [] } });
  assert.equal(loose.ok, true);
});

test("adapterProbePaths resolves per-platform config locations", () => {
  const mac = _test.adapterProbePaths("/home/u", path.join, "darwin");
  assert.match(mac.chromeState, /Library[\\/]Application Support[\\/]Google[\\/]Chrome/);
  assert.match(mac.gcloudDir, /\.config[\\/]gcloud/);

  const linux = _test.adapterProbePaths("/home/u", path.join, "linux");
  assert.match(linux.chromeState, /google-chrome/);

  const win = _test.adapterProbePaths("/home/u", path.join, "win32");
  assert.match(win.chromeState, /User Data/);
  assert.doesNotMatch(win.gcloudDir, /\.config/);
});

test("titleCase tolerates empty and multi-delimiter input", () => {
  assert.equal(_test.titleCase("google-workspace"), "Google Workspace");
  assert.equal(_test.titleCase(""), "");
  assert.equal(_test.titleCase("a__b c"), "A B C");
});

test("the Projects settings-page icon is self-constrained (fixes the giant-folder render)", () => {
  // The icon must carry its own width/height/xmlns so no host render path can
  // display it at intrinsic size.
  const iconLine = source.split("\n").find((line) => line.includes("iconSvg:"));
  assert.ok(iconLine, "iconSvg must exist");
  assert.match(iconLine, /width="20"/);
  assert.match(iconLine, /height="20"/);
  assert.match(iconLine, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("the Projects page exposes path editing, ordering, colors, and native preview application", () => {
  assert.match(source, /Local project path/);
  assert.match(source, /function moveNode/);
  assert.match(source, /color\.type = "color"/);
  assert.match(source, /applyNativeProjectColors/);
  assert.match(source, /react\?\.host\?\.observe/);
});

test("renderer owns bounded native project menu integration and reversible tint styling", () => {
  assert.match(source, /installProjectColorControls/);
  assert.match(source, /document\.addEventListener\("contextmenu"/);
  assert.match(source, /document\.addEventListener\("pointerdown"/);
  assert.match(source, /document\.addEventListener\("click"/);
  assert.match(source, /new MutationObserver\(\(\) => inject\(pending, id\)\)/);
  assert.match(source, /window\.setTimeout\(\(\) => \{[\s\S]*?\}, 1500\)/);
  assert.doesNotMatch(source, /for \(const delay of \[0, 50, 150, 350\]\)/);
  assert.match(source, /PROJECT_COLOR_STYLE_ID/);
  assert.match(source, /data-tweaker-project-color-group/);
  assert.match(source, /data-tweaker-project-color-task/);
  assert.match(source, /data-tweaker-project-show-more/);
  assert.match(source, /removeProjectColorArtifacts/);
});

test("Projects Settings exposes synchronized Auto, named palette, tint, and custom color controls", () => {
  assert.match(source, /Auto project color/);
  assert.match(source, /PROJECT_COLOR_OPTIONS/);
  assert.match(source, /Task tint for/);
  assert.doesNotMatch(source, /Project tint(?: for)?/);
  assert.match(source, /Custom color for/);
  assert.match(source, /colorMode: "manual"/);
  assert.match(source, /overlayIntensity/);
});

test("task tint variables remain available while headers use their full project color", () => {
  assert.match(source, /--tweaker-project-header-tint:\s*16%/);
  assert.match(source, /project-overlay="off"[^}]*project-task-tint:\s*0%/s);
  assert.match(source, /project-overlay="subtle"[^}]*project-task-tint:\s*6%/s);
  assert.match(source, /project-overlay="medium"[^}]*project-task-tint:\s*10%/s);
  assert.match(source, /project-overlay="strong"[^}]*project-task-tint:\s*15%/s);
  assert.match(source, /electron-dark[\s\S]*project-overlay="subtle"[^}]*project-task-tint:\s*11%/s);
  assert.match(source, /electron-dark[\s\S]*project-overlay="medium"[^}]*project-task-tint:\s*18%/s);
  assert.match(source, /electron-dark[\s\S]*project-overlay="strong"[^}]*project-task-tint:\s*24%/s);
  assert.match(source, /data-tweaker-project-color-row[^}]*background-color:\s*var\(--tweaker-project-color\)/s);
});

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body", this);
    this.head = new FakeElement("head", this);
    this.listeners = new Map();
  }
  createElement(tag) { return new FakeElement(tag, this); }
  querySelectorAll(selector) { return [...this.head.querySelectorAll(selector), ...this.body.querySelectorAll(selector)]; }
  getElementById(id) {
    let found = null;
    const visit = (node) => {
      if (node.id === id || node.getAttribute("id") === id) found = node;
      for (const child of node.children) visit(child);
    };
    visit(this.head); visit(this.body);
    return found;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  listenerCount() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, String(value)),
      removeProperty: (name) => this.style.values.delete(name),
    };
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
    this.className = "";
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  insertBefore(child, before) {
    child.parentElement = this;
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector === '[role="listitem"]' && node.getAttribute("role") === "listitem") return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    if (selector.includes(",")) {
      return [...new Set(selector.split(",").flatMap((part) => this.querySelectorAll(part.trim())))];
    }
    const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    const tag = /^[a-z][a-z0-9-]*$/i.test(selector) ? selector.toUpperCase() : null;
    const matches = [];
    const visit = (node) => {
      if (tag && node.tagName === tag) matches.push(node);
      else if (match) {
        const value = node.getAttribute(match[1]);
        if (value !== null && (match[2] === undefined || value === match[2])) matches.push(node);
      }
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }
}

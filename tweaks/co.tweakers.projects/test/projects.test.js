"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../index.js");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { checkRendererEntry } = require("../scripts/build-renderer-entry.cjs");
const tweakRoot = path.join(__dirname, "..");
const source = [
  fs.readFileSync(path.join(tweakRoot, "index.js"), "utf8"),
  ...fs.readdirSync(path.join(tweakRoot, "lib"))
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => fs.readFileSync(path.join(tweakRoot, "lib", file), "utf8")),
].join("\n");

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

test("current native project menu receives one working Project color item before Remove local project", () => {
  const document = new FakeDocument();
  document.defaultView = { innerHeight: 800, innerWidth: 400 };
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const remove = document.createElement("div");
  remove.setAttribute("role", "menuitem");
  remove.textContent = "Remove local project";
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
    remove.textContent = "Remove local project";
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
  const emptyService = _test.createService(api, { readNativeLocalProjects: () => [] });
  assert.equal(fs.existsSync(path.join(dataDir, ".legacy-project-colors-imported-v1")), false);
  const projectState = _test.normalizeState({ schemaVersion: 1, nodes: [
    { id: "p", type: "project", parentId: null, name: "Alpha", icon: { kind: "emoji", value: "📁" }, connections: {} },
  ] });
  assert.equal((await emptyService.handle({ action: "save", state: projectState })).ok, true);
  emptyService.dispose();
  const discoveredService = _test.createService(api, { readNativeLocalProjects: () => [] });
  const imported = await discoveredService.handle({ action: "get" });
  assert.equal(imported.state.nodes[0].colorMode, "manual");
  assert.equal(imported.state.nodes[0].color, "#6d28d9");
  assert.equal(fs.existsSync(path.join(dataDir, ".legacy-project-colors-imported-v1")), true);
  discoveredService.dispose();
});

test("an empty store seeds from the native registry and legacy colors land on it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-native-seed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "tweak-data", "co.tweakers.projects");
  const storageDir = path.join(root, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "co.bennett.ui-improvements.json"), JSON.stringify({
    "sidebar-project-backgrounds:colors": { alpha: "violet" },
  }));
  const api = { fs: { dataDir }, ipc: { send() {} } };
  const service = _test.createService(api, { readNativeLocalProjects: () => [
    { id: "native-a", name: "Alpha", rootPaths: ["/tmp/example/alpha"] },
    { id: "native-b", name: "Beta", rootPaths: ["/tmp/example/beta"] },
  ] });
  const seeded = await service.handle({ action: "get" });
  assert.equal(seeded.ok, true);
  const names = seeded.state.nodes.filter((node) => node.type === "project").map((node) => node.name).sort();
  assert.deepEqual(names, ["Alpha", "Beta"], "both native projects seed as nodes");
  const alpha = seeded.state.nodes.find((node) => node.name === "Alpha");
  assert.equal(alpha.colorMode, "manual", "legacy color import applies to the seeded node");
  assert.equal(alpha.color, "#6d28d9");
  assert.equal(alpha.projectPath, "/tmp/example/alpha");
  service.dispose();
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
  assert.doesNotMatch(source, /chrome:\s*(?:fs\.)?existsSync\(probe\.chromeState\)/);
  assert.match(source, /result\.chrome\s*=\s*fs\.existsSync\(probe\.chromeState\)[\s\S]*status:\s*"available",\s*refs:\s*\[\]/);
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
  const service = _test.createService({ fs: { dataDir }, ipc: { send() {} } }, { readNativeLocalProjects: () => [] });

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

test("inventory service returns live local branches and worktrees without a GitHub call", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "projects-live-inventory-"));
  const dataDir = path.join(fixture, "data");
  const repo = path.join(fixture, "repo");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const run = (...args) => require("node:child_process").execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.name", "Projects Test");
  run("config", "user.email", "projects@example.invalid");
  fs.writeFileSync(path.join(repo, "README.md"), "inventory\n");
  run("add", "README.md"); run("commit", "-m", "initial"); run("branch", "feature/local");
  const service = _test.createService({ fs: { dataDir }, ipc: { send() {} } });
  const state = { schemaVersion: 1, nodes: [{
    id: "project", type: "project", parentId: null, name: "Project", icon: { kind: "emoji", value: "📁" }, projectPath: repo, connections: {},
  }] };
  assert.equal((await service.handle({ action: "save", state })).ok, true);
  const inventory = await service.handle({ action: "inventory.get", projectId: "project" });
  assert.equal(inventory.ok, true);
  assert.equal(inventory.repositories.length, 1);
  assert.deepEqual(inventory.repositories[0].localBranches.map((branch) => branch.name).sort(), ["feature/local", "main"]);
  assert.equal(fs.realpathSync(inventory.repositories[0].worktrees[0].path), fs.realpathSync(repo));
  service.dispose();
});

test("first run persists only an exact native root and leaves ambiguous folders repairable", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-first-run-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const seeded = _test.seedProjectsFromNativeSurface([
    { id: "native-one", label: "One" },
    { id: "native-many", label: "Many" },
    { label: "Unmatched" },
  ], [
    { id: "native-one", name: "One", rootPaths: ["/tmp/projects-one"] },
    { id: "native-many", name: "Many", rootPaths: ["/tmp/projects-many-a", "/tmp/projects-many-b"] },
  ]);
  const one = seeded.nodes.find((node) => node.name === "One");
  const many = seeded.nodes.find((node) => node.name === "Many");
  const unmatched = seeded.nodes.find((node) => node.name === "Unmatched");
  assert.equal(one.projectPath, "/tmp/projects-one");
  assert.equal(Object.hasOwn(many, "projectPath"), false);
  assert.equal(Object.hasOwn(unmatched, "projectPath"), false);
  const unboundWithNativePaths = await _test.readProjectInventory(seeded, many.id, [
    { id: "native-many", name: "Many", rootPaths: ["/tmp/projects-many-a", "/tmp/projects-many-b"] },
  ]);
  assert.equal(unboundWithNativePaths.ok, false);
  assert.equal(unboundWithNativePaths.error.code, "project-unbound");

  const api = { fs: { dataDir }, ipc: { send() {} } };
  const dependencies = {
    detectConnections: async () => ({}),
    readNativeLocalProjects: () => [],
  };
  const first = _test.createService(api, dependencies);
  assert.equal((await first.handle({ action: "save", state: seeded })).ok, true);
  first.dispose();
  const restored = _test.createService(api, dependencies);
  const persisted = await restored.handle({ action: "get" });
  assert.equal(persisted.state.nodes.find((node) => node.name === "One").projectPath, "/tmp/projects-one");
  const unboundInventory = await restored.handle({ action: "inventory.get", projectId: many.id });
  assert.equal(unboundInventory.ok, false);
  assert.equal(unboundInventory.error.code, "project-unbound");
  assert.match(source, /Needs folder repair/);
  assert.match(source, /Repair folder/);
  restored.dispose();
});

test("GitHub branch refresh has deterministic success, failure, and recovery outcomes", async () => {
  const projectState = _test.normalizeState({ schemaVersion: 1, nodes: [{
    id: "project", type: "project", parentId: null, name: "Project", icon: { kind: "emoji", value: "📁" },
    githubRepo: "owner/repo", connections: { github: "gh:1234567890abcdef12345678" },
  }] });
  const githubRefs = new Map([["gh:1234567890abcdef12345678", { host: "github.com", login: "octocat" }]]);
  const cache = new Map();
  const now = () => 1_700_000_000_000;
  let mode = "success";
  let branchCalls = 0;
  const runCommand = async (_command, argv) => {
    if (argv[0] === "auth") return { status: 0, error: null, stdout: "test-token\n", stderr: "" };
    if (argv[0] !== "api") throw new Error(`unexpected provider command: ${argv.join(" ")}`);
    branchCalls += 1;
    if (mode === "failure") return { status: 1, error: null, stdout: "", stderr: "denied" };
    return {
      status: 0,
      error: null,
      stdout: JSON.stringify([[{ name: "main", protected: true, commit: { sha: "abcdef0123456789" } }]]),
      stderr: "",
    };
  };
  const options = { now, runCommand, totalTimeoutMs: 100, commandTimeoutMs: 50 };
  const success = await _test.refreshGitHubBranches(projectState, githubRefs, cache, "project", [], options);
  assert.equal(success.ok, true);
  assert.equal(success.status, "ready");
  assert.deepEqual(success.remotes[0].branches, [{ name: "main", sha: "abcdef0123456789", protected: true }]);
  assert.equal(branchCalls, 1);

  const cached = await _test.refreshGitHubBranches(projectState, githubRefs, cache, "project", [], options);
  assert.equal(cached.remotes[0].cached, true);
  assert.equal(branchCalls, 1, "a fresh branch request reuses the bounded cache");

  cache.clear();
  mode = "failure";
  const failed = await _test.refreshGitHubBranches(projectState, githubRefs, cache, "project", [], options);
  assert.equal(failed.ok, true);
  assert.equal(failed.status, "partial");
  assert.equal(failed.partial, true);
  assert.equal(failed.remotes[0].branches.length, 0);
  assert.ok(failed.remotes[0].error);

  mode = "success";
  const recovered = await _test.refreshGitHubBranches(projectState, githubRefs, cache, "project", [], options);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.partial, false);
  assert.equal(recovered.remotes[0].branches[0].name, "main");
});

test("inventory coordination bounds Git work, reports progress, caches, and cancels", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "projects-inventory-coordinator-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const roots = ["one", "two", "three", "four"].map((name) => path.join(fixture, name));
  for (const root of roots) fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const projectState = _test.normalizeState({ schemaVersion: 1, nodes: [{
    id: "project", type: "project", parentId: null, name: "Project", icon: { kind: "emoji", value: "📁" }, projectPath: fixture, connections: {},
  }] });
  const progress = [];
  const timeouts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let gitCalls = 0;
  const runCommand = async (_command, argv, options) => {
    gitCalls += 1;
    timeouts.push(options.timeout);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const root = argv[1];
    const command = argv.slice(2);
    if (command[0] === "rev-parse" && command[1] === "--show-toplevel") return { status: 0, error: null, stdout: `${root}\n`, stderr: "" };
    if (command[0] === "rev-parse") return { status: 0, error: null, stdout: "abcdef012345\n", stderr: "" };
    if (command[0] === "remote") return { status: 0, error: null, stdout: "origin https://github.com/owner/repo.git (fetch)\n", stderr: "" };
    if (command[0] === "for-each-ref") return { status: 0, error: null, stdout: "main\u0000abcdef012345\u0000origin/main\u0000*\n", stderr: "" };
    if (command[0] === "worktree") return { status: 0, error: null, stdout: `worktree ${root}\nHEAD abcdef012345\nbranch refs/heads/main\n\n`, stderr: "" };
    throw new Error(`unexpected Git command: ${command.join(" ")}`);
  };
  const coordinator = _test.createInventoryCoordinator({
    getState: () => projectState,
    getNativeProjects: () => [],
    notify: (event) => progress.push(event),
    inventoryOptions: { runCommand, concurrency: 3, commandTimeoutMs: 50, totalTimeoutMs: 500 },
  });
  const first = await coordinator.get("project", { requestId: "scan-one" });
  assert.equal(first.status, "ready");
  assert.equal(first.repositories.length, 4);
  assert.ok(maxInFlight <= 3, `expected at most three Git commands, received ${maxInFlight}`);
  assert.ok(timeouts.every((timeout) => timeout <= 50));
  assert.ok(progress.some((event) => event.requestId === "scan-one" && event.status === "scanning"));
  assert.ok(progress.some((event) => event.requestId === "scan-one" && event.status === "ready"));
  const callsBeforeCache = gitCalls;
  const cached = await coordinator.get("project", { requestId: "scan-two" });
  assert.equal(cached.cached, true);
  assert.equal(gitCalls, callsBeforeCache);
  coordinator.dispose();

  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const cancelCoordinator = _test.createInventoryCoordinator({
    getState: () => projectState,
    getNativeProjects: () => [],
    inventoryOptions: {
      totalTimeoutMs: 500,
      runCommand: (_command, _argv, options) => new Promise((resolve) => {
        started();
        options.signal?.addEventListener?.("abort", () => resolve({ status: null, error: { code: "ABORT_ERR" }, stdout: "", stderr: "" }), { once: true });
      }),
    },
  });
  const pending = cancelCoordinator.get("project", { requestId: "scan-cancel" });
  await running;
  assert.equal(cancelCoordinator.cancel("project", "scan-cancel").cancelled, true);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.partial, true);
  cancelCoordinator.dispose();
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

test("repository discovery is bounded, skips generated folders, and never follows symlinks", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "projects-inventory-"));
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "apps", "web", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored", ".git"), { recursive: true });
  fs.mkdirSync(path.join(outside, ".git"));
  fs.symlinkSync(outside, path.join(root, "linked"));
  const result = await _test.discoverRepositoryPaths([root]);
  assert.deepEqual(result.repositories.sort(), [root, path.join(root, "apps", "web")].sort());
  assert.equal(result.truncated, false);
});

test("Git worktree and GitHub remote parsing preserve detached and tracking identities", () => {
  assert.deepEqual(_test.parseGitRemoteUrl("git@github.com:therealityreport/tweakers.git"), {
    host: "github.com", slug: "therealityreport/tweakers",
  });
  assert.deepEqual(_test.parseGitRemoteUrl("https://github.com/openai/codex.git"), {
    host: "github.com", slug: "openai/codex",
  });
  assert.equal(_test.parseGitRemoteUrl("file:///tmp/repo"), null);
  assert.deepEqual(_test.parseGitWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD def\ndetached\nlocked busy\n\n"), [
    { path: "/repo", branch: "main", head: "abc", detached: false, locked: false, prunable: false },
    { path: "/repo-wt", branch: null, head: "def", detached: true, locked: "busy", prunable: false },
  ]);
});

test("project connection signals read only fixed non-secret metadata surfaces", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-signals-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "supabase"));
  fs.writeFileSync(path.join(root, "supabase", "config.toml"), 'project_id = "safe-project"\n');
  fs.mkdirSync(path.join(root, ".vercel"));
  fs.writeFileSync(path.join(root, ".vercel", "project.json"), JSON.stringify({ orgId: "org", projectId: "project" }));
  fs.writeFileSync(path.join(root, "modal_jobs.py"), 'import modal\napp = modal.App("jobs")\n');
  fs.writeFileSync(path.join(root, ".env"), "SECRET=must-not-appear\n");
  const signals = await _test.detectProjectConnectionSignals([root], [{ root, remotes: [{ name: "origin", fetchUrl: "git@github.com:owner/repo.git" }] }]);
  assert.deepEqual(signals.map((signal) => signal.type).sort(), ["github", "modal", "supabase", "vercel"]);
  assert.doesNotMatch(JSON.stringify(signals), /must-not-appear|SECRET/);
});

test("pinned project identity uses bounded fiber props and fails closed when ambiguous", () => {
  const projects = [
    { id: "one", nativeProjectIds: ["native-one"], nativeProjectNames: [], nativeProjectPaths: [] },
    { id: "two", nativeProjectIds: ["native-two"], nativeProjectNames: [], nativeProjectPaths: [] },
  ];
  const exactApi = { react: { getFiber: () => ({ memoizedProps: { hoverCardProjectId: "native-one" }, return: null }) } };
  assert.equal(_test.projectIdFromPinnedFiber(exactApi, {}, projects), "one");
  const ambiguousApi = { react: { getFiber: () => ({ memoizedProps: { projectId: "native-one", thread: { projectId: "native-two" } }, return: null }) } };
  assert.equal(_test.projectIdFromPinnedFiber(ambiguousApi, {}, projects), null);
});

test("pinned project rows are discovered between native Pinned and Projects headings without a pinned attribute", () => {
  const document = new FakeDocument();
  const pinnedHeading = document.createElement("div");
  pinnedHeading.textContent = "Pinned";
  pinnedHeading.rect = { top: 100, bottom: 120, height: 20 };
  const pinnedRow = document.createElement("div");
  pinnedRow.setAttribute("role", "listitem");
  pinnedRow.rect = { top: 130, bottom: 160, height: 30 };
  const thread = document.createElement("button");
  thread.setAttribute("data-app-action-sidebar-thread-id", "thread-one");
  pinnedRow.appendChild(thread);
  const projectsHeading = document.createElement("div");
  projectsHeading.textContent = "Projects";
  projectsHeading.rect = { top: 200, bottom: 220, height: 20 };
  document.body.append(pinnedHeading, pinnedRow, projectsHeading);

  assert.deepEqual(_test.pinnedProjectRows(document), [pinnedRow]);
});

test("Edit Project discovery tolerates the current dialog wrapper and compact appearance editor uses wrapping rows", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  global.document = document;
  t.after(() => { global.document = previousDocument; });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.textContent = "Edit project tweakers Save";
  const heading = document.createElement("h2");
  heading.textContent = "Edit project";
  const save = document.createElement("button");
  save.textContent = "Save";
  dialog.append(heading, save);
  document.body.appendChild(dialog);

  assert.deepEqual(_test.editProjectDialogCandidates(document), [dialog]);
  const editor = _test.projectAppearanceEditor({
    id: "p",
    name: "tweakers",
    projectPath: "/Projects/tweakers",
    color: "#be123c",
    colorMode: "manual",
    overlayIntensity: "medium",
  }, () => {});
  assert.match(editor.children[0].children[1].className, /\bflex-wrap\b/);
  assert.doesNotMatch(editor.children[0].children[1].className, /grid-cols/);
  assert.match(editor.children[1].children[1].className, /\bflex\b/);
});

test("Edit Project gets a Settings button even when project state arrives after the dialog", (t) => {
  const document = new FakeDocument();
  const previous = {
    document: global.document,
    window: global.window,
    MutationObserver: global.MutationObserver,
  };
  global.document = document;
  global.window = {
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); },
  };
  global.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  };
  t.after(() => {
    global.document = previous.document;
    global.window = previous.window;
    global.MutationObserver = previous.MutationObserver;
  });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.textContent = "Edit project tweakers Save";
  const header = document.createElement("div");
  const heading = document.createElement("h2"); heading.textContent = "Edit project";
  const close = document.createElement("button"); close.setAttribute("aria-label", "Close");
  header.append(heading, close);
  const save = document.createElement("button"); save.textContent = "Save";
  dialog.append(header, save);
  document.body.append(dialog);

  const dispose = _test.installEditProjectDialogControls({}, () => null, () => {}, () => {});
  const gear = header.children.find((node) => node.dataset?.tweakerProjectSettingsButton === "true");
  assert.ok(gear, "settings gear is injected before project identity is available");
  assert.equal(header.children.indexOf(gear), header.children.indexOf(close) - 1);
  dispose();
});

test("row spacing is measured from adjacent native project folders", () => {
  const parent = {};
  const rows = [
    { parentElement: parent, getBoundingClientRect: () => ({ top: 0, bottom: 30 }) },
    { parentElement: parent, getBoundingClientRect: () => ({ top: 34, bottom: 64 }) },
    { parentElement: parent, getBoundingClientRect: () => ({ top: 68, bottom: 98 }) },
  ];
  assert.equal(_test.measureNativeProjectRowGap(rows), 4);
  assert.equal(_test.measureNativeProjectRowGap([
    { parentElement: parent, getBoundingClientRect: () => ({ top: 0, bottom: 30 }) },
    { parentElement: parent, getBoundingClientRect: () => ({ top: 30, bottom: 60 }) },
  ]), null, "zero native gaps must use the visible token fallback");
});

test("session row geometry copies the native collapsed project row size and gap", () => {
  const parent = {};
  const makeGroup = (top, headerRect) => ({
    parentElement: parent,
    getBoundingClientRect: () => ({ top, bottom: top + 30, width: 440, height: 30 }),
    querySelector: (selector) => selector === "[data-tweaker-project-color-row]" ? { getBoundingClientRect: () => headerRect } : null,
    querySelectorAll: () => [],
  });
  const geometry = _test.measureNativeProjectRowGeometry([
    makeGroup(0, { left: 12, top: 0, width: 440, height: 30 }),
    makeGroup(32, { left: 12, top: 32, width: 440, height: 30 }),
    makeGroup(64, { left: 12, top: 64, width: 440, height: 30 }),
  ]);
  assert.deepEqual(geometry, { gap: 2, blockSize: 30, inlineSize: 440 });
});

test("active project session counts prefer explicit totals and deduplicate active session records", () => {
  const project = { id: "project-one", nativeProjectIds: ["native-one"] };
  assert.equal(_test.activeProjectSessionCount({ activeSessionCount: 4 }, project), 4);
  assert.equal(_test.activeProjectSessionCount({ projectId: "project-one", runningThreads: ["one", "two", "three"] }, project), 3);
  assert.equal(_test.activeProjectSessionCount({ runningThreads: ["one", "two", "three"] }, project), 0, "unbound global arrays do not leak totals across projects");
  assert.equal(_test.activeProjectSessionCount({ sessions: [
    { id: "one", projectId: "project-one", status: "working" },
    { id: "one", projectId: "project-one", isStreaming: true },
    { id: "two", workspaceId: "native-one", state: "running" },
    { id: "three", projectId: "another-project", status: "running" },
    { id: "four", projectId: "project-one", status: "idle" },
  ] }, project), 2);
});

test("branch inventory uses bounded disclosure rows instead of a newline wall", (t) => {
  const document = new FakeDocument();
  const previousDocument = global.document;
  global.document = document;
  t.after(() => { global.document = previousDocument; });
  const disclosure = _test.branchInventoryDisclosure("Local branches", [
    { name: "main", current: true, upstream: "origin/main", sha: "1234567890abcdef" },
    { name: "feature/readable-inventory", current: false, upstream: null, sha: "fedcba0987654321" },
  ], { open: true });
  assert.equal(disclosure.tagName, "DETAILS");
  assert.equal(disclosure.open, true);
  assert.equal(disclosure.getAttribute("data-tweaker-branch-inventory"), "true");
  assert.equal(disclosure.children[1].children.length, 2);
});

test("Projects UI includes dialog appearance, Settings deep-link, pinned colors, and bounded inventories", () => {
  assert.match(source, /installEditProjectDialogControls/);
  assert.match(source, /api\.settings\.openPage\("projects"\)/);
  assert.match(source, /data-tweaker-project-settings-button/);
  assert.match(source, /data-tweaker-project-color-pinned/);
  assert.match(source, /data-tweaker-project-color-pinned[^}]*color:\s*var\(--gray-0\) !important/s);
  assert.match(source, /data-tweaker-project-spacing-list[^}]*gap:\s*var\(--tweaker-project-native-row-gap/s);
  assert.match(source, /--tweaker-project-native-row-block-size/);
  assert.match(source, /--tweaker-project-native-row-inline-size/);
  assert.match(source, /geometry\.gap === null \? "var\(--spacing-px, 1px\)"/);
  assert.match(source, /data-tweaker-project-active-count[^}]*position:\s*relative/s);
  assert.match(source, /activeProjectSessionCountFromFiber/);
  assert.match(source, /data-tweaker-project-custom-color[^}]*appearance:\s*none/s);
  assert.match(source, /Yellow", value: "#EFBF06"/);
  assert.match(source, /branchInventoryDisclosure\("Remote-tracking branches"/);
  assert.match(source, /currentProject = projectForEditDialog/);
  assert.match(source, /bg-token-main-surface-primary/);
  assert.match(source, /inventory\.refresh-github/);
  assert.match(source, /MAX_INVENTORY_DEPTH = 4/);
  assert.match(source, /MAX_INVENTORY_REPOS = 32/);
  assert.doesNotMatch(source, /readFileSync\([^\n]*(?:\.env|\.npmrc|credentials)/);
});

test("the canonical entry evaluates under the renderer host contract and cleans up", async (t) => {
  assert.equal(checkRendererEntry(), true, "the checked-in renderer entry stays fresh with its source modules");
  const canonicalEntry = fs.readFileSync(path.join(tweakRoot, "index.js"), "utf8");
  const previousDocument = global.document;
  const previousWindow = global.window;
  const previousCustomEvent = global.CustomEvent;
  const previousMutationObserver = global.MutationObserver;
  const globalRequire = Object.getOwnPropertyDescriptor(globalThis, "require");
  const document = new FakeDocument();
  const windowListeners = new Map();
  let pageDefinition = null;
  let pageUnregistered = 0;
  let hostObserverRemoved = 0;

  global.document = document;
  global.window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type, listener) { windowListeners.delete(type); },
    dispatchEvent() {},
    alert() {},
  };
  global.CustomEvent = class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  global.MutationObserver = class FakeMutationObserver {
    constructor(listener) { this.listener = listener; }
    observe() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, "require", { value: undefined, configurable: true, writable: true });
  t.after(() => {
    global.document = previousDocument;
    global.window = previousWindow;
    global.CustomEvent = previousCustomEvent;
    global.MutationObserver = previousMutationObserver;
    if (globalRequire) Object.defineProperty(globalThis, "require", globalRequire);
    else delete globalThis.require;
  });

  const module = { exports: {} };
  // This is the exact production host evaluation shape: no ambient require is
  // supplied. Any renderer dependency on Node or relative require would throw.
  const evaluate = new Function("module", "exports", "console", canonicalEntry);
  evaluate(module, module.exports, console);
  const page = module.exports.start({
    process: "renderer",
    ipc: {
      on() { return () => {}; },
      invoke(_channel, message) {
        return Promise.resolve(message?.action === "get" ? { ok: false } : { ok: true });
      },
    },
    settings: {
      registerPage(definition) {
        pageDefinition = definition;
        return { unregister() { pageUnregistered += 1; } };
      },
      openPage: async () => ({ ok: true }),
    },
    react: {
      host: {
        observe() { return () => { hostObserverRemoved += 1; }; },
        query: () => [],
      },
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(pageDefinition?.id, "projects");
  assert.equal(typeof page?.unregister, "function");
  await Promise.resolve();
  module.exports.stop();
  assert.equal(pageUnregistered, 1);
  assert.equal(hostObserverRemoved, 1);
  assert.equal(windowListeners.size, 0, "renderer cleanup removes its window listeners");
});

test("provider refresh shares renderer request cancellation, scoped progress, stale-paint protection, and recovery", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-provider-lifecycle-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "projects-provider-workspace-"));
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const document = new FakeDocument();
  const previousDocument = global.document;
  global.document = document;
  t.after(() => { global.document = previousDocument; });

  const project = {
    id: "project",
    type: "project",
    parentId: null,
    name: "Project",
    icon: { kind: "emoji", value: "📁" },
    projectPath: workspace,
    githubRepo: "owner/repo",
    connections: { github: "gh:1234567890abcdef12345678" },
  };
  const state = { schemaVersion: 1, nodes: [project] };
  const progress = [];
  const progressListeners = new Set();
  const rendererMessages = [];
  const providerRuns = [];
  const providerWaiters = [];
  let providerMode = "delayed";
  const branchResponse = () => ({
    status: 0,
    error: null,
    stdout: JSON.stringify([[{ name: "main", protected: true, commit: { sha: "abcdef0123456789" } }]]),
    stderr: "",
  });
  const nextProviderRun = (label) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = providerWaiters.indexOf(accept);
      if (index >= 0) providerWaiters.splice(index, 1);
      reject(new Error(`timed out waiting for mocked provider command: ${label}`));
    }, 500);
    const accept = (run) => {
      clearTimeout(timeout);
      resolve(run);
    };
    const queued = providerRuns.shift();
    if (queued) accept(queued);
    else providerWaiters.push(accept);
  });
  const announceProviderRun = (run) => {
    const waiter = providerWaiters.shift();
    if (waiter) waiter(run);
    else providerRuns.push(run);
  };
  const runCommand = (command, argv, options = {}) => {
    if (command === "git") {
      const root = argv[1];
      const operation = argv.slice(2);
      if (operation[0] === "rev-parse" && operation[1] === "--show-toplevel") return { status: 0, error: null, stdout: `${root}\n`, stderr: "" };
      if (operation[0] === "rev-parse") return { status: 0, error: null, stdout: "abcdef012345\n", stderr: "" };
      if (operation[0] === "remote") return { status: 0, error: null, stdout: "origin https://github.com/owner/repo.git (fetch)\n", stderr: "" };
      if (operation[0] === "for-each-ref") return { status: 0, error: null, stdout: "main\u0000abcdef012345\u0000origin/main\u0000*\n", stderr: "" };
      if (operation[0] === "worktree") return { status: 0, error: null, stdout: `worktree ${root}\nHEAD abcdef012345\nbranch refs/heads/main\n\n`, stderr: "" };
      throw new Error(`unexpected Git command: ${operation.join(" ")}`);
    }
    if (command !== "gh") throw new Error(`unexpected command: ${command}`);
    if (argv[0] === "auth") return { status: 0, error: null, stdout: "test-token\n", stderr: "" };
    if (argv[0] !== "api") throw new Error(`unexpected provider command: ${argv.join(" ")}`);
    if (providerMode === "ready") return branchResponse();
    const run = { signal: options.signal, aborted: false, resolve: null };
    options.signal?.addEventListener?.("abort", () => { run.aborted = true; }, { once: true });
    announceProviderRun(run);
    return new Promise((resolve) => { run.resolve = resolve; });
  };
  const service = _test.createService({
    fs: { dataDir },
    ipc: {
      send(channel, payload) {
        if (channel !== "inventory.progress") return;
        progress.push(payload);
        for (const listener of progressListeners) listener(payload);
      },
    },
  }, {
    githubRefs: new Map([["gh:1234567890abcdef12345678", { host: "github.com", login: "octocat" }]]),
    detectConnections: async () => ({}),
    readNativeLocalProjects: () => [],
    runCommand,
    inventoryOptions: { runCommand, totalTimeoutMs: 500, commandTimeoutMs: 50 },
  });
  t.after(() => service.dispose());
  assert.equal((await service.handle({ action: "save", state })).ok, true);
  const localInventory = await service.handle({ action: "inventory.get", projectId: project.id, requestId: "local-seed" });
  assert.equal(localInventory.status, "ready");

  const rendererApi = {
    ipc: {
      on(channel, listener) {
        assert.equal(channel, "inventory.progress");
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
      invoke(channel, message) {
        assert.equal(channel, "projects");
        rendererMessages.push(message);
        return service.handle(message);
      },
    },
  };
  const root = document.createElement("div");
  const host = document.createElement("div");
  root.append(host);
  document.body.append(root);
  const loader = _test.createInventoryLoader(rendererApi, root);
  const githubPanelCount = () => {
    const count = (node) => (node?.dataset?.tweakerGithubBranches ? 1 : 0)
      + (node?.children || []).reduce((total, child) => total + count(child), 0);
    return count(host);
  };

  const staleStarted = nextProviderRun("first renderer refresh");
  const staleRefresh = loader.refreshGitHub(project, host, localInventory);
  const staleRun = await staleStarted;
  const staleRequest = rendererMessages.find((message) => message.action === "inventory.refresh-github")?.requestId;
  assert.ok(staleRequest, "renderer sends a request token with provider refresh");
  const cancellation = await loader.cancel();
  assert.deepEqual(cancellation, { ok: true, cancelled: true, requestId: staleRequest });
  assert.equal(staleRun.signal.aborted, true, "the delayed provider command receives the abort signal");
  staleRun.resolve(branchResponse());
  await staleRefresh;
  assert.equal(githubPanelCount(), 0, "a stale provider completion cannot paint the detached request");
  const scopedProgress = progress.filter((event) => event.provider === "github" && event.requestId === staleRequest);
  assert.ok(scopedProgress.some((event) => event.remote === "github.com/owner/repo"));
  assert.ok(scopedProgress.every((event) => event.projectId === project.id && event.requestId === staleRequest));
  assert.ok(scopedProgress.every((event) => !event.remote || event.remote.length <= 360));

  providerMode = "ready";
  const recovered = await loader.refreshGitHub(project, host, localInventory);
  assert.equal(recovered.status, "ready");
  assert.equal(githubPanelCount(), 1, "a later request recovers and paints its current result");

  assert.equal((await service.handle({ action: "save", state })).ok, true, "save invalidates the bounded provider cache before supersession coverage");
  providerMode = "delayed";
  const supersededStarted = nextProviderRun("superseded renderer refresh");
  const supersededRefresh = loader.refreshGitHub(project, host, localInventory);
  const supersededRun = await supersededStarted;
  const supersededRequest = rendererMessages.filter((message) => message.action === "inventory.refresh-github").at(-1)?.requestId;
  assert.ok(progress.some((event) => event.requestId === supersededRequest && event.provider === "github" && event.phase === "discovering"), "a provider-triggered local scan keeps its progress in the provider display channel");
  const rescan = await service.handle({ action: "inventory.get", projectId: project.id, requestId: "rescan" });
  assert.equal(rescan.ok, true);
  assert.equal(supersededRun.signal.aborted, true, "a rescan supersedes an active provider job");
  supersededRun.resolve(branchResponse());
  await supersededRefresh;
  assert.equal(githubPanelCount(), 1, "the superseded provider still cannot overwrite the current display");

  const disposedStarted = nextProviderRun("dispose renderer refresh");
  const disposedRefresh = loader.refreshGitHub(project, host, localInventory);
  const disposedRun = await disposedStarted;
  service.dispose();
  assert.equal(disposedRun.signal.aborted, true, "service disposal aborts an active provider job");
  disposedRun.resolve(branchResponse());
  await disposedRefresh;
  assert.equal(githubPanelCount(), 1);
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
    this.dataset = {};
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
  prepend(...children) {
    for (const child of children.reverse()) {
      child.parentElement = this;
      this.children.unshift(child);
    }
  }
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

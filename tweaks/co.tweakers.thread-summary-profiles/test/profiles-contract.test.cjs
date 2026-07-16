"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const tweak = require("../index.js").__test;

test("Profiles projection is read-only and redacts identity paths and secrets", () => {
  const response = {
    ok: true,
    revision: 7,
    project: {
      id: "project-revi",
      workspacePath: "/private/workspace/revi",
      connections: {
        github: { account: "work", token: "secret-token" },
        modal: { profile: "admin" },
      },
    },
  };
  const projection = tweak.normalizeProfilesProjection(response);
  assert.equal(projection.revision, 7);
  assert.equal(projection.projectId, "project-revi");
  assert.deepEqual(projection.rows.map((row) => row.id), ["github", "modal"]);
  assert.doesNotMatch(JSON.stringify(projection), /workspace|private|token|secret/i);
  assert.equal("save" in projection, false);
  assert.equal("write" in projection, false);
});

test("Profiles renderer keeps loading, empty, and error states distinct and visible", () => {
  assert.match(tweak.renderProfilesState({ state: "loading" }).text, /Loading/i);
  assert.match(tweak.renderProfilesState({ state: "empty" }).text, /No profiles/i);
  assert.match(tweak.renderProfilesState({ state: "error", error: "Projects unavailable" }).text, /Projects unavailable/i);
  assert.match(tweak.renderProfilesState({ state: "ready", rows: [{ id: "github", label: "GitHub", value: "Work" }] }).text, /GitHub/);
  assert.notEqual(tweak.renderProfilesState({ state: "empty" }).hidden, true);
});

test("Profiles render signature includes Projects revision so assignments invalidate cache", () => {
  const base = { projectId: "project-revi", rows: [{ id: "github", value: "Work" }] };
  const first = tweak.profileSignature({ ...base, revision: 10 });
  const same = tweak.profileSignature({ ...base, revision: 10 });
  const changed = tweak.profileSignature({ ...base, revision: 11 });
  assert.equal(first, same);
  assert.notEqual(first, changed);
});

test("Profiles source observes nested route changes and removes all owned resources on stop", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /react\?\.host\?\.observe/);
  assert.doesNotMatch(source, /new MutationObserver/);
  assert.match(source, /disconnect\(\)/);
  assert.match(source, /remove\(\)/);
  assert.match(source, /style/i);
  assert.match(source, /popstate|hashchange/);
  assert.match(source, /projects-revision/);
});

test("Profiles context signature changes across project routes", () => {
  const panel = { getAttribute(name) { return name === "data-project-id" ? this.project : ""; }, project: "one" };
  const first = tweak.panelContextSignature(panel);
  panel.project = "two";
  assert.notEqual(first, tweak.panelContextSignature(panel));
});

test("project context resolves from the workspace root, not the summary panel", () => {
  // The panel carries no project attributes; the workspace root (an ancestor
  // reachable via closest) does. Old code read the panel directly and got "".
  const workspaceRoot = {
    getAttribute(name) {
      if (name === "data-project-id") return "project-42";
      if (name === "data-workspace-path") return "/ws/42";
      return null;
    },
  };
  const panel = {
    getAttribute: () => null,
    closest(selector) {
      return /data-project-id|data-workspace-path/.test(selector) ? workspaceRoot : null;
    },
  };
  const context = tweak.resolveProjectContext(panel);
  assert.equal(context.projectId, "project-42");
  assert.equal(context.workspacePath, "/ws/42");
});

test("findSummaryPanels keeps only the innermost of nested matches (no duplicate mounts)", () => {
  const makePanel = (text, children = []) => ({
    hasAttribute: () => false,
    textContent: text,
    _children: children,
    contains(other) {
      return this._children.includes(other) || this._children.some((c) => c.contains && c.contains(other));
    },
  });
  const inner = makePanel("Environment Sources Progress Subagents");
  const outer = makePanel("Environment Sources Progress Subagents wrapper", [inner]);
  const root = { querySelectorAll: () => [outer, inner] };
  const panels = tweak.findSummaryPanels(root);
  assert.equal(panels.length, 1);
  assert.equal(panels[0], inner, "the parent that contains another match is dropped");
});

test("malformed profiles without a real type/id are dropped, not rendered as Unknown", () => {
  const projection = tweak.normalizeProfilesProjection({
    ok: true,
    profiles: [
      { label: "Nameless", value: "x" },       // no type/id -> dropped
      { type: "github", value: "Work" },        // valid
      { type: "", id: "  ", value: "y" },        // blank -> dropped
    ],
  });
  assert.deepEqual(projection.rows.map((row) => row.id), ["github"]);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_PINNED_TASK_IDS,
  normalizeState,
} = require("../lib/state");
const { revisionForState } = require("../lib/policy");
const { createProjectService } = require("../lib/service");

function project(overrides = {}) {
  return {
    id: "project-1",
    type: "project",
    parentId: null,
    name: "Project",
    icon: { kind: "emoji", value: "📁" },
    connections: {},
    ...overrides,
  };
}

test("project task ordering state accepts the frozen sort enum and deduplicates pins", () => {
  const state = normalizeState({ schemaVersion: 1, nodes: [project({
    taskSort: "updated-desc",
    pinnedTaskIds: ["task-a", "task-b", "task-a", "task-c", "task-b"],
  })] });

  assert.equal(state.nodes[0].taskSort, "updated-desc");
  assert.deepEqual(state.nodes[0].pinnedTaskIds, ["task-a", "task-b", "task-c"]);
});

test("legacy project state migrates without task ordering fields", () => {
  const state = normalizeState({ schemaVersion: 1, nodes: [project()] });

  assert.equal(Object.hasOwn(state.nodes[0], "taskSort"), false);
  assert.equal(Object.hasOwn(state.nodes[0], "pinnedTaskIds"), false);
});

test("project task ordering state rejects invalid, unsafe, and oversized inputs", () => {
  assert.throws(() => normalizeState({ schemaVersion: 1, nodes: [project({ taskSort: "native" })] }), /invalid-task-sort/);
  assert.throws(() => normalizeState({ schemaVersion: 1, nodes: [project({ pinnedTaskIds: "task-a" })] }), /invalid-pinned-task-ids/);
  assert.throws(() => normalizeState({ schemaVersion: 1, nodes: [project({ pinnedTaskIds: ["/private/task"] })] }), /invalid-id/);
  assert.throws(() => normalizeState({ schemaVersion: 1, nodes: [project({
    pinnedTaskIds: Array.from({ length: MAX_PINNED_TASK_IDS + 1 }, (_, index) => `task-${index}`),
  })] }), /too-many-pinned-task-ids/);
});

test("task ordering saves retain optimistic concurrency protection", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-task-ordering-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const service = createProjectService(
    { fs: { dataDir }, ipc: { send() {} } },
    { readNativeLocalProjects: () => [], detectConnections: async () => ({}) },
  );
  t.after(() => service.dispose());

  const initial = normalizeState({ schemaVersion: 1, nodes: [] });
  const initialRevision = revisionForState(initial);
  const next = { schemaVersion: 1, nodes: [project({
    taskSort: "created-asc",
    pinnedTaskIds: ["task-2", "task-2", "task-1"],
  })] };

  const saved = await service.handle({ action: "save", state: next, baseRevision: initialRevision });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.nodes[0].taskSort, "created-asc");
  assert.deepEqual(saved.state.nodes[0].pinnedTaskIds, ["task-2", "task-1"]);

  const stale = await service.handle({ action: "save", state: initial, baseRevision: initialRevision });
  assert.deepEqual(stale, {
    ok: false,
    error: { code: "stale-revision", message: "The request could not be completed safely." },
  });

  const reloaded = createProjectService(
    { fs: { dataDir }, ipc: { send() {} } },
    { readNativeLocalProjects: () => [], detectConnections: async () => ({}) },
  );
  t.after(() => reloaded.dispose());
  const persisted = await reloaded.handle({ action: "get" });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.state.nodes[0].taskSort, "created-asc");
  assert.deepEqual(persisted.state.nodes[0].pinnedTaskIds, ["task-2", "task-1"]);
});

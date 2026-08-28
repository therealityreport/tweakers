"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sidebar = require("../lib/sidebar.js");

function record(id, nativeIndex, values = {}) {
  return { id, nativeIndex, row: null, createdAt: null, updatedAt: null, ...values };
}

test("project task ordering puts local pins before created date order", () => {
  const ordered = sidebar.orderProjectTaskRecords([
    record("old", 0, { createdAt: 100 }),
    record("missing-first", 1),
    record("local-pin", 2, { createdAt: 90 }),
    record("new", 3, { createdAt: 300 }),
    record("missing-second", 4),
  ], "created-desc", ["local-pin"]);

  assert.deepEqual(ordered.map((item) => item.id), [
    "local-pin",
    "new",
    "old",
    "missing-first",
    "missing-second",
  ]);
});

test("missing task timestamps retain stable native order and Default is untouched", () => {
  const native = [
    record("missing-first", 0),
    record("updated-old", 1, { updatedAt: 100 }),
    record("missing-second", 2),
    record("updated-new", 3, { updatedAt: 300 }),
  ];

  assert.deepEqual(
    sidebar.orderProjectTaskRecords(native, "updated-desc", []).map((item) => item.id),
    ["updated-new", "updated-old", "missing-first", "missing-second"],
  );
  assert.deepEqual(
    sidebar.orderProjectTaskRecords(native, undefined, ["updated-new"]).map((item) => item.id),
    native.map((item) => item.id),
  );
});

test("task date extraction is bounded and rejects label-only matches", () => {
  const record = {
    title: "Same visible task title",
    nested: {
      threadId: "semantic-thread-2",
      createdAt: "2026-08-27T12:00:00.000Z",
    },
    unrelated: {
      threadId: "semantic-thread-1",
      createdAt: "not-a-date",
    },
  };

  assert.equal(sidebar.taskTimestampFromRecord(record, "semantic-thread-1", "created"), null);
  assert.equal(
    sidebar.taskTimestampFromRecord(record, "semantic-thread-2", "created"),
    Date.parse("2026-08-27T12:00:00.000Z"),
  );
  assert.equal(sidebar.taskTimestampFromRecord(record, "Same visible task title", "created"), null);
});

test("DOM ordering preserves trailing controls and restores native order", () => {
  const row = (id, createdAt) => {
    const attributes = new Map([
      ["role", "listitem"],
      ["data-app-action-sidebar-thread-id", id],
      ["data-created-at", String(createdAt)],
    ]);
    return {
      parentElement: null,
      getAttribute(name) { return attributes.get(name) ?? null; },
      querySelector() { return null; },
      closest() { return null; },
      remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
      },
    };
  };
  const old = row("old", 100);
  const recent = row("recent", 300);
  const showMore = { label: "Show more", parentElement: null };
  const list = {
    children: [old, recent, showMore],
    querySelectorAll(selector) { return selector === '[role="listitem"]' ? this.children.filter((child) => child !== showMore) : []; },
    contains(node) { return this === node || this.children.includes(node); },
    insertBefore(child, before) {
      child.parentElement = this;
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    },
  };
  for (const child of list.children) child.parentElement = list;

  assert.equal(sidebar.reorderProjectTaskRows(null, list, { taskSort: "created-desc" }), 1);
  assert.deepEqual(list.children, [recent, old, showMore]);
  sidebar.restoreProjectTaskOrder(list);
  assert.deepEqual(list.children, [old, recent, showMore]);

  assert.equal(sidebar.reorderProjectTaskRows(null, list, { taskSort: "created-desc" }), 1);
  list.isConnected = false;
  assert.equal(sidebar.pruneDetachedTaskPlacements(), 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRendererStorage, type StorageLike } from "../src/renderer-storage";

function fakeStorage(
  entries: Array<[string, string]>,
  options: { failWrites?: boolean } = {},
): { storage: StorageLike; values: Map<string, string> } {
  const values = new Map(entries);
  const storage: StorageLike = {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => {
      if (options.failWrites) throw new Error("write failed");
      values.set(key, value);
    },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values };
}

test("renderer storage migrates the legacy prefix and publisher id for the same canonical suffix", () => {
  const currentId = "co.tweakers.example";
  const legacyId = ["co", "legacy-publisher", "example"].join(".");
  const legacyKey = `${["codex", "pp"].join("")}:storage:${legacyId}`;
  const { storage, values } = fakeStorage([
    [legacyKey, JSON.stringify({ history: ["kept"], enabled: true })],
  ]);

  const migrated = createRendererStorage(currentId, storage);
  assert.deepEqual(migrated.all(), { history: ["kept"], enabled: true });
  assert.equal(values.has(legacyKey), false);
  assert.equal(values.has(`tweaker:storage:${currentId}`), true);
});

test("renderer storage merges one legacy publisher key with current values winning", () => {
  const currentId = "co.tweakers.example";
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const { storage, values } = fakeStorage([
    [legacyKey, JSON.stringify({ value: "legacy", history: ["kept"] })],
    [currentKey, JSON.stringify({ value: "current", currentOnly: true })],
  ]);

  assert.deepEqual(createRendererStorage(currentId, storage).all(), {
    value: "current",
    history: ["kept"],
    currentOnly: true,
  });
  assert.equal(values.has(legacyKey), false);
});

test("renderer storage does not guess between ambiguous legacy publishers", () => {
  const prefix = `${["codex", "pp"].join("")}:storage:`;
  const first = `${prefix}co.first.example`;
  const second = `${prefix}co.second.example`;
  const { storage, values } = fakeStorage([
    [first, JSON.stringify({ value: "first" })],
    [second, JSON.stringify({ value: "second" })],
  ]);

  assert.deepEqual(createRendererStorage("co.tweakers.example", storage).all(), {});
  assert.equal(values.has(first), true);
  assert.equal(values.has(second), true);
  assert.equal(values.has("tweaker:storage:co.tweakers.example"), false);
});

test("renderer storage retains the legacy key when the canonical write fails", () => {
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const { storage, values } = fakeStorage(
    [[legacyKey, JSON.stringify({ history: ["kept"] })]],
    { failWrites: true },
  );

  assert.deepEqual(createRendererStorage("co.tweakers.example", storage).all(), { history: ["kept"] });
  assert.equal(values.has(legacyKey), true);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { secureRendererUuid, sha256HexUtf8 } from "../src/renderer-crypto";
import {
  commitRendererStorageMigration,
  createRendererStorage,
  prepareRendererStorageMigration,
  rollbackRendererStorageMigration,
  type StorageLike,
} from "../src/renderer-storage";

test("renderer crypto matches Node SHA-256 for UTF-8 values and generates UUIDs", () => {
  for (const value of ["", "abc", "emoji: 🧪\r\naccents: café", "a".repeat(1_000)]) {
    const expected = createHash("sha256").update(value).digest("hex");
    assert.equal(sha256HexUtf8(value), expected);
  }
  assert.match(secureRendererUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("renderer storage and its browser helper do not import Node built-ins", () => {
  for (const file of ["renderer-storage.ts", "renderer-crypto.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from\s+|require\()["']node:/);
  }
});

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

test("renderer storage prepares a canonical copy and leaves legacy intact", () => {
  const currentId = "co.tweakers.example";
  const legacyId = ["co", "legacy-publisher", "example"].join(".");
  const legacyKey = `${["codex", "pp"].join("")}:storage:${legacyId}`;
  const raw = JSON.stringify({ history: ["kept"], enabled: true });
  const { storage, values } = fakeStorage([[legacyKey, raw]]);

  const migrated = createRendererStorage(currentId, storage);
  assert.deepEqual(migrated.all(), { history: ["kept"], enabled: true });
  assert.equal(migrated.migration.status, "prepared");
  assert.equal(migrated.migration.holdPromotion, false);
  assert.equal(values.get(legacyKey), raw);
  assert.equal(values.get(`tweaker:storage:${currentId}`), raw);
});

test("renderer storage keeps canonical values without merging mismatched legacy state", () => {
  const currentId = "co.tweakers.example";
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const { storage, values } = fakeStorage([
    [legacyKey, JSON.stringify({ value: "legacy", history: ["legacy-only"] })],
    [currentKey, JSON.stringify({ value: "current", currentOnly: true })],
  ]);

  const migrated = createRendererStorage(currentId, storage);
  assert.deepEqual(migrated.all(), { value: "current", currentOnly: true });
  assert.equal(migrated.migration.status, "conflict");
  assert.equal(migrated.migration.holdPromotion, true);
  assert.equal(values.has(legacyKey), true);
});

test("renderer storage does not guess between ambiguous legacy publishers", () => {
  const prefix = `${["codex", "pp"].join("")}:storage:`;
  const first = `${prefix}co.first.example`;
  const second = `${prefix}co.second.example`;
  const { storage, values } = fakeStorage([
    [first, JSON.stringify({ value: "first" })],
    [second, JSON.stringify({ value: "second" })],
  ]);

  const migrated = createRendererStorage("co.tweakers.example", storage);
  assert.deepEqual(migrated.all(), {});
  assert.equal(migrated.migration.status, "ambiguous");
  assert.equal(migrated.migration.holdPromotion, true);
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

  const migrated = createRendererStorage("co.tweakers.example", storage);
  assert.deepEqual(migrated.all(), {});
  assert.equal(migrated.migration.status, "write_failed");
  assert.equal(migrated.migration.holdPromotion, true);
  assert.equal(values.has(legacyKey), true);
});

test("renderer storage commit archives legacy and rollback restores the exact preimage", () => {
  const currentId = "co.tweakers.example";
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const raw = JSON.stringify({ history: ["kept"] });
  const { storage, values } = fakeStorage([[legacyKey, raw]]);

  const prepared = prepareRendererStorageMigration(currentId, storage, "renderer-tx");
  const committed = commitRendererStorageMigration(prepared, storage);
  assert.equal(values.has(legacyKey), false);
  assert.equal(values.get(committed.archiveKey!), raw);
  assert.equal(values.get(currentKey), raw);

  const rolledBack = rollbackRendererStorageMigration(committed, storage);
  assert.equal(rolledBack.phase, "rolled_back");
  assert.equal(values.get(legacyKey), raw);
  assert.equal(values.has(currentKey), false);
  assert.equal(values.has(committed.archiveKey!), false);
});

test("renderer storage rollback uses compare-and-swap and preserves a later edit", () => {
  const currentId = "co.tweakers.example";
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const { storage, values } = fakeStorage([[legacyKey, JSON.stringify({ value: "legacy" })]]);
  const prepared = prepareRendererStorageMigration(currentId, storage, "renderer-cas");
  values.set(currentKey, JSON.stringify({ value: "later-user-edit" }));

  assert.throws(() => rollbackRendererStorageMigration(prepared, storage), /canonical value changed/);
  assert.deepEqual(JSON.parse(values.get(currentKey)!), { value: "later-user-edit" });
  assert.equal(values.has(legacyKey), true);
});

test("renderer storage prepare is idempotent for byte-identical canonical state", () => {
  const currentId = "co.tweakers.example";
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const raw = JSON.stringify({ value: "same" });
  const { storage } = fakeStorage([[legacyKey, raw]]);
  const first = prepareRendererStorageMigration(currentId, storage, "first");
  const second = prepareRendererStorageMigration(currentId, storage, "second");

  assert.equal(first.status, "prepared");
  assert.equal(second.status, "canonical");
  assert.equal(second.holdPromotion, false);
  assert.equal(storage.getItem(currentKey), raw);
  assert.equal(storage.getItem(legacyKey), raw);
});

test("renderer storage facade carries the committed receipt into rollback", () => {
  const currentId = "co.tweakers.example";
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.previous.example`;
  const raw = JSON.stringify({ value: "legacy" });
  const { storage, values } = fakeStorage([[legacyKey, raw]]);
  const facade = createRendererStorage(currentId, storage);

  assert.equal(facade.commitMigration().phase, "committed");
  assert.equal(facade.migration.phase, "committed");
  assert.equal(values.has(legacyKey), false);
  assert.equal(facade.rollbackMigration().phase, "rolled_back");
  assert.equal(values.get(legacyKey), raw);
  assert.equal(values.has(currentKey), false);
});

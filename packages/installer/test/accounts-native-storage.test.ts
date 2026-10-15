import assert from "node:assert/strict";
import test from "node:test";
import { nativeAccountsDeviceStorage } from "../src/codex-accounts-native-main";

test("Storage uses the selected native home for read and refresh without changing execution home", async () => {
  let home: string | null = null;
  const created: string[] = [];
  const storage = nativeAccountsDeviceStorage((root) => {
    created.push(root);
    return { read: async () => root, refresh: async () => root };
  }, "/isolated", () => home);
  assert.equal(await storage.read(), "/isolated");
  home = "/native";
  assert.equal(await storage.read(), "/native");
  assert.equal(await storage.refresh(), "/native");
  assert.deepEqual(created, ["/isolated", "/native"]);
});

test("Storage rejects invalid scope and discards a result after scope changes", async () => {
  let home = "/native";
  const storage = nativeAccountsDeviceStorage(() => ({ read: async () => { home = "/other"; return "stale"; } }), "/isolated", () => home);
  await assert.rejects(storage.read(), /changed/);
  const invalid = nativeAccountsDeviceStorage(() => { throw new Error("must not construct"); }, "/isolated", () => { throw new Error("invalid binding"); });
  await assert.rejects(invalid.read(), /invalid binding/);
});

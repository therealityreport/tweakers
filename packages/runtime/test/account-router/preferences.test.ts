import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACCOUNTS_PREFERENCES_FILE, AccountsPreferencesStore, isAccountsPreferencesPatch } from "../../src/account-router/preferences";

test("preferences default without writing and persist explicit choices across owner restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "accounts-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new AccountsPreferencesStore(root);
  assert.deepEqual(store.snapshot(), { failoverMode: "automatic", unifiedCatalogEnabled: false });
  assert.equal(existsSync(join(root, ACCOUNTS_PREFERENCES_FILE)), false);
  assert.deepEqual(store.update({ failoverMode: "ask" }), { failoverMode: "ask", unifiedCatalogEnabled: false });
  store.update({ unifiedCatalogEnabled: true });
  assert.deepEqual(new AccountsPreferencesStore(root).snapshot(), { failoverMode: "ask", unifiedCatalogEnabled: true });
  assert.equal(isAccountsPreferencesPatch({}), false);
  assert.equal(isAccountsPreferencesPatch({ failoverMode: "always-replay" }), false);
  assert.equal(isAccountsPreferencesPatch({ unifiedCatalogEnabled: true, accountId: "injected" }), false);
});

test("preferences reject unsafe state and external drift without replacing it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "accounts-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, ACCOUNTS_PREFERENCES_FILE);
  const store = new AccountsPreferencesStore(root);
  store.update({ failoverMode: "ask" });
  writeFileSync(path, JSON.stringify({ version: 1, failoverMode: "automatic", unifiedCatalogEnabled: true }));
  const before = readFileSync(path, "utf8");
  assert.throws(() => store.update({ failoverMode: "ask" }), /outside their owner/);
  assert.equal(readFileSync(path, "utf8"), before);
  chmodSync(path, 0o644);
  assert.throws(() => new AccountsPreferencesStore(root), /unsafe private file/);
  rmSync(path);
  symlinkSync(join(root, "missing"), path);
  assert.throws(() => new AccountsPreferencesStore(root), /unsafe private file/);
});

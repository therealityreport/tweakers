"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { _test } = require("../index.js");

function auth(value) {
  return JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: value, refresh_token: `refresh-${value}`, id_token: `id-${value}` } });
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-"));
  const codexDir = path.join(root, ".codex");
  const accountsDir = path.join(codexDir, "auth_accounts");
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const paths = { codexDir, accountsDir, authFile: path.join(codexDir, "auth.json"), currentMarker: path.join(codexDir, "current_account"), lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json") };
  fs.writeFileSync(paths.authFile, auth("current"), { mode: 0o600 });
  fs.writeFileSync(path.join(accountsDir, "work.json"), auth("work"), { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "missing.json\n", { mode: 0o600 });
  const deps = { fs: options.fs || fs, path, homedir: () => root, randomUUID: crypto.randomUUID, now: Date.now };
  const service = _test.createAccountService({ log: { info() {} } }, { deps, paths });
  return { root, paths, service };
}

test("list is redacted, side-effect-free, and reports dangling marker", async (t) => {
  const { root, paths, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(paths.authFile);
  const result = await service.handle({ action: "list" });
  assert.equal(result.markerStatus, "dangling-reference");
  assert.equal(JSON.stringify(result).includes("access_token"), false);
  assert.deepEqual(fs.readFileSync(paths.authFile), before);
  assert.equal(fs.existsSync(paths.lkgFile), false);
});

test("switch uses opaque intent, 0600 writes, and preserves LKG", async (t) => {
  const { root, paths, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(paths.currentMarker, "work.json\n", { mode: 0o600 });
  const list = await service.handle({ action: "list" });
  assert.equal(list.accounts[0].active, true);
  const prepared = await service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const result = await service.handle({ action: "switch", intent: prepared.intent });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(paths.authFile)).tokens.access_token, "work");
  assert.equal(JSON.parse(fs.readFileSync(paths.lkgFile)).tokens.access_token, "current");
  assert.equal(fs.statSync(paths.authFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.lkgFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.currentMarker).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(paths.currentMarker, "utf8"), "work.json\n");
});

test("a successful switch schedules a full host restart", async (t) => {
  let restarts = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexDir = path.join(root, ".codex");
  const accountsDir = path.join(codexDir, "auth_accounts");
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const paths = { codexDir, accountsDir, authFile: path.join(codexDir, "auth.json"), currentMarker: path.join(codexDir, "current_account"), lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json") };
  fs.writeFileSync(paths.authFile, auth("current"), { mode: 0o600 });
  fs.writeFileSync(path.join(accountsDir, "work.json"), auth("work"), { mode: 0o600 });
  const deps = { fs, path, homedir: () => root, randomUUID: crypto.randomUUID, now: Date.now };
  const service = _test.createAccountService({ log: { info() {} } }, { deps, paths, onSwitched: () => { restarts += 1; return true; } });
  const list = await service.handle({ action: "list" });
  const prepared = await service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const result = await service.handle({ action: "switch", intent: prepared.intent });
  assert.equal(result.ok, true);
  assert.equal(result.restartScheduled, true);
  assert.equal(restarts, 1);
});

test("switch saves the login being left so switching back uses its latest tokens", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-roundtrip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexDir = path.join(root, ".codex");
  const accountsDir = path.join(codexDir, "auth_accounts");
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const paths = { codexDir, accountsDir, authFile: path.join(codexDir, "auth.json"), currentMarker: path.join(codexDir, "current_account"), lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json") };
  const session = (token, accountId) => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: token, refresh_token: `refresh-${token}`, id_token: `id-${token}`, account_id: accountId } });
  fs.writeFileSync(paths.authFile, session("account-2-refreshed", "acct-2"), { mode: 0o600 });
  fs.writeFileSync(path.join(accountsDir, "account-2.json"), session("account-2-stale", "acct-2"), { mode: 0o600 });
  fs.writeFileSync(path.join(accountsDir, "account-3.json"), session("account-3", "acct-3"), { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "account-2.json\n", { mode: 0o600 });
  const deps = { fs, path, homedir: () => root, randomUUID: crypto.randomUUID, now: Date.now };
  let restarts = 0;
  const service = _test.createAccountService({ log: { info() {}, warn() {} } }, { deps, paths, onSwitched: () => { restarts += 1; return true; } });
  t.after(() => service.dispose());
  const list = await service.handle({ action: "list" });
  const target = list.accounts.find((account) => !account.active);
  const prepared = await service.handle({ action: "prepare-switch", ref: target.ref });
  const result = await service.handle({ action: "switch", intent: prepared.intent });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accountsDir, "account-2.json"))).tokens.access_token, "account-2-refreshed");
  assert.equal(JSON.parse(fs.readFileSync(paths.authFile)).tokens.access_token, "account-3");
  assert.equal(fs.readFileSync(paths.currentMarker, "utf8"), "account-3.json\n");
  assert.equal(restarts, 1);
});

test("corrupt, permissive, symlink, and traversal sources do not mutate auth or LKG", async (t) => {
  for (const kind of ["corrupt", "mode", "symlink"]) {
    const { root, paths, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(paths.accountsDir, "work.json");
    if (kind === "corrupt") fs.writeFileSync(target, "{", { mode: 0o600 });
    if (kind === "mode") fs.chmodSync(target, 0o644);
    if (kind === "symlink") { fs.unlinkSync(target); fs.symlinkSync(paths.authFile, target); }
    const before = fs.readFileSync(paths.authFile);
    const list = await service.handle({ action: "list" });
    const prepared = await service.handle({ action: "prepare-switch", ref: list.accounts[0]?.ref });
    assert.equal(prepared.ok, false, kind);
    assert.deepEqual(fs.readFileSync(paths.authFile), before, kind);
    assert.equal(fs.existsSync(paths.lkgFile), false, kind);
  }
  assert.throws(() => _test.validateReferenceName("../auth"));
});

test("single-use intents serialize concurrent switch attempts", async (t) => {
  const { root, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const list = await service.handle({ action: "list" });
  const prepared = await service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const [first, second] = await Promise.all([
    service.handle({ action: "switch", intent: prepared.intent }),
    service.handle({ action: "switch", intent: prepared.intent }),
  ]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
});

test("save rejects untrusted Codex and account directories before copying auth", async (t) => {
  for (const target of ["codex", "accounts"]) {
    const { root, paths, service } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await service.handle({ action: "prepare-save", name: `saved-${target}` });
    assert.equal(prepared.ok, true);
    fs.chmodSync(target === "codex" ? paths.codexDir : paths.accountsDir, 0o777);
    const result = await service.handle({ action: "save", intent: prepared.intent });
    assert.equal(result.ok, false, target);
    assert.equal(result.error.code, "untrusted-auth-directory", target);
    assert.equal(fs.existsSync(path.join(paths.accountsDir, `saved-${target}.json`)), false, target);
  }
});

test("save rejects a symlinked auth_accounts directory before copying auth", async (t) => {
  const { root, paths, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await service.handle({ action: "prepare-save", name: "saved" });
  const moved = `${paths.accountsDir}-real`;
  fs.renameSync(paths.accountsDir, moved);
  fs.symlinkSync(moved, paths.accountsDir);
  const result = await service.handle({ action: "save", intent: prepared.intent });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-accounts-directory");
  assert.equal(fs.existsSync(path.join(moved, "saved.json")), false);
});

test("save rejects an auth_accounts directory owned by another user", async (t) => {
  let accountsDir;
  const guardedFs = Object.create(fs);
  guardedFs.lstatSync = (file) => {
    const stat = fs.lstatSync(file);
    if (file === accountsDir) Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
    return stat;
  };
  const setup = fixture({ fs: guardedFs });
  const { root, paths, service } = setup;
  accountsDir = paths.accountsDir;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await service.handle({ action: "prepare-save", name: "saved" });
  const result = await service.handle({ action: "save", intent: prepared.intent });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "untrusted-auth-directory");
  assert.equal(fs.existsSync(path.join(paths.accountsDir, "saved.json")), false);
});

test("recursive redaction removes credentials and paths", () => {
  const output = _test.redact({ token: "secret", nested: { message: "Bearer abc", path: "/private/file" } });
  assert.equal(JSON.stringify(output).includes("secret"), false);
  assert.equal(JSON.stringify(output).includes("/private"), false);
  assert.equal(JSON.stringify(output).includes("Bearer abc"), false);
});

test("account refs are stable across re-lists so a rendered Switch button stays valid", async (t) => {
  const { root, service } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = await service.handle({ action: "list" });
  const second = await service.handle({ action: "list" });
  assert.equal(first.accounts[0].ref, second.accounts[0].ref, "same file yields the same ref");
  // A ref from the FIRST list still resolves after a second list cleared refs
  // (the old random-UUID scheme broke exactly here).
  const prepared = await service.handle({ action: "prepare-switch", ref: first.accounts[0].ref });
  assert.equal(prepared.ok, true);
});

test("stableRef is deterministic per filename and distinct across filenames", () => {
  assert.equal(_test.stableRef("work.json"), _test.stableRef("work.json"));
  assert.notEqual(_test.stableRef("work.json"), _test.stableRef("personal.json"));
  assert.match(_test.stableRef("work.json"), /^[0-9a-f]{32}$/);
});

test("authPaths honors CODEX_HOME and otherwise falls back to ~/.codex", () => {
  const withHome = _test.authPaths({ path, homedir: () => "/home/whoever", codexHome: "/tmp/custom-codex-home" });
  assert.equal(withHome.codexDir, "/tmp/custom-codex-home");
  assert.equal(withHome.authFile, path.join("/tmp/custom-codex-home", "auth.json"));
  assert.equal(withHome.accountsDir, path.join("/tmp/custom-codex-home", "auth_accounts"));

  const fallback = _test.authPaths({ path, homedir: () => "/home/whoever", codexHome: null });
  assert.equal(fallback.codexDir, path.join("/home/whoever", ".codex"));
});

test("account labels use the saved ChatGPT identity without exposing tokens", () => {
  const token = `x.${Buffer.from(JSON.stringify({ name: "Tweakers", email: "tweakers@example.com" })).toString("base64url")}.x`;
  assert.equal(_test.displayLabelFromAuth({ auth_mode: "chatgpt", tokens: { id_token: token } }, "fallback"), "Tweakers");
  assert.equal(_test.displayLabelFromAuth({}, "Work Account"), "Work Account");
});

test("active snapshot sync propagates rotated tokens only for the same account", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexDir = path.join(root, ".codex");
  const accountsDir = path.join(codexDir, "auth_accounts");
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const paths = { codexDir, accountsDir, authFile: path.join(codexDir, "auth.json"), currentMarker: path.join(codexDir, "current_account"), lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json") };
  const deps = { fs, path, homedir: () => root, randomUUID: crypto.randomUUID, now: Date.now };
  const withAccount = (value, accountId) => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: value, refresh_token: `refresh-${value}`, id_token: `id-${value}`, account_id: accountId } });

  // Stale snapshot for the ACTIVE account: sync must refresh it in place.
  fs.writeFileSync(path.join(accountsDir, "work.json"), withAccount("stale", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(paths.authFile, withAccount("rotated", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "work.json\n", { mode: 0o600 });
  _test.syncActiveSnapshot(deps, paths);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accountsDir, "work.json"))).tokens.access_token, "rotated");
  assert.equal(fs.statSync(path.join(accountsDir, "work.json")).mode & 0o777, 0o600);

  // Live auth belongs to a DIFFERENT account: never overwrite the snapshot.
  fs.writeFileSync(paths.authFile, withAccount("other-login", "acct-2"), { mode: 0o600 });
  _test.syncActiveSnapshot(deps, paths);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accountsDir, "work.json"))).tokens.access_token, "rotated");

  // Missing account_id anywhere: fail safe, no write.
  fs.writeFileSync(paths.authFile, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "anon", refresh_token: "refresh-anon", id_token: "id-anon" } }), { mode: 0o600 });
  _test.syncActiveSnapshot(deps, paths);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accountsDir, "work.json"))).tokens.access_token, "rotated");

  // Dangling marker: no-op.
  fs.writeFileSync(paths.currentMarker, "missing.json\n", { mode: 0o600 });
  fs.writeFileSync(paths.authFile, withAccount("rotated-2", "acct-1"), { mode: 0o600 });
  _test.syncActiveSnapshot(deps, paths);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accountsDir, "work.json"))).tokens.access_token, "rotated");
});

test("renderer account-menu fallback chooses one nested menu instead of broad side containers", (t) => {
  const previousWindow = global.window;
  global.window = { innerWidth: 1000, innerHeight: 1000 };
  t.after(() => { global.window = previousWindow; });

  function element(name, options = {}) {
    const children = options.children || [];
    const attrs = options.attrs || {};
    const node = {
      name,
      textContent: options.text || "Usage remaining Settings Log out",
      children,
      getBoundingClientRect: () => options.rect || { width: 420, height: 420, top: 80, left: 20, right: 440, bottom: 500 },
      getAttribute: (key) => attrs[key] || null,
      matches: (selector) => selector.includes("[data-state='open']") && attrs["data-state"] === "open",
      querySelector: () => null,
      contains(other) { return other === node || children.some((child) => child.contains(other)); },
    };
    return node;
  }

  const menu = element("account-menu", { attrs: { role: "dialog" }, rect: { width: 430, height: 560, top: 120, left: 24, right: 454, bottom: 680 } });
  const sidePane = element("side-pane", { children: [menu], rect: { width: 480, height: 860, top: 0, left: 0, right: 480, bottom: 860 } });
  const target = _test.accountMenuTargetFromCandidates([sidePane, menu]);

  assert.equal(target, menu);
});

test("renderer fallback is bounded and removes stale panels before injecting", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.equal(source.includes('[role="menu"], [role="dialog"], [popover], div'), false);
  assert.equal(source.includes(".slice(0, 4)"), false);
  assert.match(source, /cleanupAccountSwitcherPanels\(targetMenu\)/);
  assert.match(source, /accountMenuTargetFromCandidates/);
});

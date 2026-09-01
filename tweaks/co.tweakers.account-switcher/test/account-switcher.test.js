"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const tweak = require("../index.js");
const { _test } = tweak;

function auth(value, accountId = "account-" + value) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: value,
      refresh_token: "refresh-" + value,
      id_token: "id-" + value,
      account_id: accountId,
    },
  });
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-"));
  const codexDir = path.join(root, ".codex");
  const accountsDir = path.join(codexDir, "auth_accounts");
  const tweakDataParent = path.join(root, "tweak-data");
  const resourcesPath = path.join(root, "runtime-resources");
  fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  // This is the runtime-owned shared parent. Account Router may validate it,
  // but must never change its 0755 mode while hardening its own descendants.
  fs.mkdirSync(tweakDataParent, { recursive: true, mode: 0o755 });
  fs.chmodSync(tweakDataParent, 0o755);
  fs.mkdirSync(resourcesPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(resourcesPath, "codex"), "test executable", { mode: 0o700 });
  if (!options.withoutAccountsDirectory) fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const paths = {
    codexDir,
    accountsDir,
    authFile: path.join(codexDir, "auth.json"),
    currentMarker: path.join(codexDir, "current_account"),
    lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json"),
    routerDataDir: path.join(tweakDataParent, "co.tweakers.account-switcher"),
  };
  fs.writeFileSync(paths.authFile, auth("current"), { mode: 0o600 });
  if (!options.withoutAccountsDirectory) {
    fs.writeFileSync(path.join(accountsDir, "work.json"), auth("work"), { mode: 0o600 });
  }
  fs.writeFileSync(paths.currentMarker, "missing.json\n", { mode: 0o600 });
  const deps = {
    fs: options.fs || fs,
    path,
    homedir: () => root,
    getuid: typeof process.getuid === "function" ? () => process.getuid() : null,
    spawnSync: options.spawnSync || spawnSync,
    randomUUID: crypto.randomUUID,
    now: options.now || Date.now,
    probeBundledCliVersion: options.probeBundledCliVersion || (() => "0.148.0-alpha.9"),
  };
  const log = options.log || { info() {}, warn() {} };
  const store = options.store || new Map();
  const storage = {
    async get(key) { return store.get(key); },
    async set(key, value) { store.set(key, value); },
    async flush() {},
  };
  const runtimeInfo = options.runtimeInfo || { codexVersion: "26.810.52044", buildFlavor: "prod", resourcesPath };
  const api = { log, storage, codex: { runtime: { async getInfo() { return runtimeInfo; } } } };
  const service = _test.createAccountService(api, { deps, paths, onSwitched: options.onSwitched, inventory: options.inventory });
  return { root, paths, service, deps, log, store, storage, api };
}

function disposeFixture(t, setup) {
  t.after(() => {
    setup.service?.dispose?.();
    fs.rmSync(setup.root, { recursive: true, force: true });
  });
}

function requiredInventory(overrides = {}) {
  return {
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: "openai-curated-remote",
      plugins: [
        {
          id: "app-693b20fccbac8191bdc178bb493de3e5@openai-curated-remote",
          remotePluginId: "plugin_mailchimp_different_internal_id",
          source: { type: "remote" }, installed: true, enabled: true, version: "6.0.0",
        },
        {
          id: "app-6a3c407853888191beddc2151c2b6f8b@openai-curated-remote",
          remotePluginId: "plugin_resend_different_internal_id",
          source: { type: "remote" }, installed: true, enabled: true, version: "2.0.0",
        },
      ],
    }],
    ...overrides,
  };
}

function testRuntimeBinding(overrides = {}) {
  return { desktopVersion: "26.810.52044", buildFlavor: "prod", bundledCliVersion: "0.148.0-alpha.9", executable: "/runtime/codex", ...overrides };
}

test("list is redacted, side-effect-free, and reports a dangling marker", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const before = fs.readFileSync(setup.paths.authFile);
  const result = await setup.service.handle({ action: "list" });

  assert.equal(result.markerStatus, "dangling-reference");
  assert.equal(JSON.stringify(result).includes("access_token"), false);
  assert.deepEqual(fs.readFileSync(setup.paths.authFile), before);
  assert.equal(fs.existsSync(setup.paths.lkgFile), false);
  assert.equal(fs.readFileSync(setup.paths.currentMarker, "utf8"), "missing.json\n", "listing must not reconcile a marker");
});

test("list projection exposes an account email but never provider ids or auth secrets", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const snapshot = JSON.parse(auth("work", "provider-account-id-should-not-render"));
  snapshot.user = { email: "private@example.test" };
  fs.writeFileSync(path.join(setup.paths.accountsDir, "work.json"), JSON.stringify(snapshot), { mode: 0o600 });

  const listed = await setup.service.handle({ action: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.accounts[0].email, "private@example.test");
  assert.equal(JSON.stringify(listed).includes("provider-account-id-should-not-render"), false);
  assert.equal(JSON.stringify(listed).includes("access_token"), false);
  assert.equal(listed.accounts[0].identifierMasked, "••••••••");
  assert.equal(listed.accounts[0].label, "work");
});

test("duplicate safe profile names use distinct stable snapshot labels shared by staged config", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  fs.renameSync(path.join(setup.paths.accountsDir, "work.json"), path.join(setup.paths.accountsDir, "alpha.json"));
  const alpha = JSON.parse(auth("alpha", "provider-alpha"));
  alpha.user = { name: "Taylor", email: "alpha@example.test" };
  const beta = JSON.parse(auth("beta", "provider-beta"));
  beta.user = { name: "Taylor", email: "beta@example.test" };
  fs.writeFileSync(path.join(setup.paths.accountsDir, "alpha.json"), JSON.stringify(alpha), { mode: 0o600 });
  fs.writeFileSync(path.join(setup.paths.accountsDir, "beta.json"), JSON.stringify(beta), { mode: 0o600 });

  const listed = await setup.service.handle({ action: "list" });
  assert.deepEqual(listed.accounts.map((account) => account.label), ["alpha", "beta"]);
  assert.deepEqual(listed.accounts.map((account) => account.displayLabel), ["Taylor · Account 1", "Taylor · Account 2"]);
  assert.deepEqual(listed.accounts.map((account) => account.email), ["alpha@example.test", "beta@example.test"]);
  const staged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(staged.ok, true);
  const config = JSON.parse(fs.readFileSync(_test.accountRouterPaths(setup.deps, setup.paths).configFile, "utf8"));
  assert.deepEqual(config.accounts.map((account) => account.label), ["alpha", "beta"]);
  assert.equal(JSON.stringify(config).includes("@example.test"), false, "emails stay out of routing configuration");
});

test("generic saved filenames use safe profile names for display without changing routing labels", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  fs.renameSync(path.join(setup.paths.accountsDir, "work.json"), path.join(setup.paths.accountsDir, "account-2.json"));
  const profileAuth = (token, accountId, name, email) => {
    const value = JSON.parse(auth(token, accountId));
    value.tokens.id_token = `x.${Buffer.from(JSON.stringify({ name, email })).toString("base64url")}.x`;
    return JSON.stringify(value);
  };
  fs.writeFileSync(path.join(setup.paths.accountsDir, "account-2.json"), profileAuth("two", "acct-2", "Thomas Hulihan", "two@example.test"), { mode: 0o600 });
  fs.writeFileSync(path.join(setup.paths.accountsDir, "account-3.json"), profileAuth("three", "acct-3", "The Reality Report", "three@example.test"), { mode: 0o600 });

  const listed = await setup.service.handle({ action: "list" });
  assert.deepEqual(listed.accounts.map((account) => account.label), ["account-2", "account-3"]);
  assert.deepEqual(listed.accounts.map((account) => account.displayLabel), ["Thomas Hulihan", "The Reality Report"]);
  assert.deepEqual(listed.accounts.map((account) => account.email), ["two@example.test", "three@example.test"]);
  const staged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(staged.ok, true);
  const config = JSON.parse(fs.readFileSync(_test.accountRouterPaths(setup.deps, setup.paths).configFile, "utf8"));
  assert.deepEqual(config.accounts.map((account) => account.label), ["account-2", "account-3"], "display names never replace stable routing labels");
  assert.equal(JSON.stringify(config).includes("@example.test"), false, "display identity never becomes a routing join");
});

test("the current account marker requires one unique saved identity match", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  fs.writeFileSync(setup.paths.authFile, auth("live", "account-work"), { mode: 0o600 });
  fs.writeFileSync(setup.paths.currentMarker, "work.json\n", { mode: 0o600 });

  const unique = await setup.service.handle({ action: "list" });
  assert.deepEqual(unique.accounts.map((account) => account.active), [true]);

  fs.writeFileSync(path.join(setup.paths.accountsDir, "duplicate.json"), auth("duplicate", "account-work"), { mode: 0o600 });
  const duplicate = await setup.service.handle({ action: "list" });
  assert.equal(duplicate.accounts.some((account) => account.active), false, "duplicate saved identities must not claim a current account");
  assert.equal(duplicate.markerStatus, "identity-mismatch");
});

test("a local username can be added, changed, and removed without entering auth or routing files", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const saved = JSON.parse(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"), "utf8"));
  saved.tokens.id_token = `x.${Buffer.from(JSON.stringify({ preferred_username: "provider-account-id-should-not-render" })).toString("base64url")}.x`;
  fs.writeFileSync(path.join(setup.paths.accountsDir, "work.json"), JSON.stringify(saved), { mode: 0o600 });
  const initial = await setup.service.handle({ action: "list" });
  const ref = initial.accounts[0].ref;
  assert.equal(initial.accounts[0].username, null, "provider claims never become a local username");

  const added = await setup.service.handle({ action: "account-username-set", ref, username: "@thommyhuli" });
  assert.deepEqual(added, { ok: true, username: "thommyhuli" });
  assert.equal((await setup.service.handle({ action: "list" })).accounts[0].username, "thommyhuli");
  assert.equal(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"), "utf8").includes("thommyhuli"), false);

  const originalSnapshot = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
  fs.writeFileSync(path.join(setup.paths.accountsDir, "work.json"), auth("replacement", "different-account"), { mode: 0o600 });
  assert.equal((await setup.service.handle({ action: "list" })).accounts[0].username, null,
    "a username must not follow a different account that reuses the filename");
  fs.writeFileSync(path.join(setup.paths.accountsDir, "work.json"), originalSnapshot, { mode: 0o600 });
  assert.equal((await setup.service.handle({ action: "list" })).accounts[0].username, "thommyhuli");

  const rejected = await setup.service.handle({ action: "account-username-set", ref, username: "private@example.test" });
  assert.equal(rejected.ok, false);
  assert.equal((await setup.service.handle({ action: "list" })).accounts[0].username, "thommyhuli");

  const removed = await setup.service.handle({ action: "account-username-set", ref, username: "" });
  assert.deepEqual(removed, { ok: true, username: null });
  assert.equal((await setup.service.handle({ action: "list" })).accounts[0].username, null);
});

test("first use lists an absent snapshot directory as empty and saves safely", async (t) => {
  const setup = fixture({ withoutAccountsDirectory: true });
  disposeFixture(t, setup);

  const listed = await setup.service.handle({ action: "list" });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.accounts, []);
  assert.equal(listed.markerStatus, "dangling-reference");
  assert.equal(listed.pluginProtection.mode, "observation");
  assert.equal(fs.existsSync(setup.paths.accountsDir), false, "listing must not create state");

  const prepared = await setup.service.handle({ action: "prepare-save", name: "first-use" });
  assert.equal(prepared.ok, true);
  const saved = await setup.service.handle({ action: "save", intent: prepared.intent });
  assert.equal(saved.ok, true);
  const target = path.join(setup.paths.accountsDir, "first-use.json");
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /page\.append\(usageSummaryCard/);
});

test("switch uses opaque intent, 0600 writes, and preserves LKG", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  fs.writeFileSync(setup.paths.currentMarker, "work.json\n", { mode: 0o600 });
  const live = JSON.parse(auth("current"));
  live.tokens.account_id = "account-work";
  fs.writeFileSync(setup.paths.authFile, JSON.stringify(live), { mode: 0o600 });

  const list = await setup.service.handle({ action: "list" });
  assert.equal(list.accounts[0].active, true);
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const result = await setup.service.handle({ action: "switch", intent: prepared.intent });

  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.authFile)).tokens.access_token, "work");
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.lkgFile)).tokens.access_token, "current");
  assert.equal(fs.statSync(setup.paths.authFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(setup.paths.lkgFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(setup.paths.currentMarker).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(setup.paths.currentMarker, "utf8"), "work.json\n");
});

test("a successful switch schedules a full host restart", async (t) => {
  let restarts = 0;
  const setup = fixture({ onSwitched: () => { restarts += 1; return true; } });
  disposeFixture(t, setup);

  const list = await setup.service.handle({ action: "list" });
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const result = await setup.service.handle({ action: "switch", intent: prepared.intent });

  assert.equal(result.ok, true);
  assert.equal(result.restartScheduled, true);
  assert.equal(restarts, 1);
});

test("switch saves the login being left so switching back uses its latest tokens", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  fs.renameSync(path.join(setup.paths.accountsDir, "work.json"), path.join(setup.paths.accountsDir, "account-2.json"));
  fs.writeFileSync(setup.paths.authFile, auth("account-2-refreshed", "acct-2"), { mode: 0o600 });
  fs.writeFileSync(path.join(setup.paths.accountsDir, "account-2.json"), auth("account-2-stale", "acct-2"), { mode: 0o600 });
  fs.writeFileSync(path.join(setup.paths.accountsDir, "account-3.json"), auth("account-3", "acct-3"), { mode: 0o600 });
  fs.writeFileSync(setup.paths.currentMarker, "account-2.json\n", { mode: 0o600 });

  const list = await setup.service.handle({ action: "list" });
  const target = list.accounts.find((account) => !account.active);
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: target.ref });
  const result = await setup.service.handle({ action: "switch", intent: prepared.intent });

  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(setup.paths.accountsDir, "account-2.json"))).tokens.access_token, "account-2-refreshed");
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.authFile)).tokens.access_token, "account-3");
  assert.equal(fs.readFileSync(setup.paths.currentMarker, "utf8"), "account-3.json\n");
});

test("corrupt, permissive, symlink, and traversal sources do not mutate auth or LKG", async (t) => {
  for (const kind of ["corrupt", "mode", "symlink"]) {
    const setup = fixture();
    disposeFixture(t, setup);
    const target = path.join(setup.paths.accountsDir, "work.json");
    if (kind === "corrupt") fs.writeFileSync(target, "{", { mode: 0o600 });
    if (kind === "mode") fs.chmodSync(target, 0o644);
    if (kind === "symlink") {
      fs.unlinkSync(target);
      fs.symlinkSync(setup.paths.authFile, target);
    }
    const before = fs.readFileSync(setup.paths.authFile);
    const list = await setup.service.handle({ action: "list" });
    const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0]?.ref });
    assert.equal(prepared.ok, false, kind);
    assert.deepEqual(fs.readFileSync(setup.paths.authFile), before, kind);
    assert.equal(fs.existsSync(setup.paths.lkgFile), false, kind);
  }
  assert.throws(() => _test.validateReferenceName("../auth"));
});

test("single-use intents serialize concurrent switch attempts", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const list = await setup.service.handle({ action: "list" });
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const results = await Promise.all([
    setup.service.handle({ action: "switch", intent: prepared.intent }),
    setup.service.handle({ action: "switch", intent: prepared.intent }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test("save rejects untrusted Codex and account directories before copying auth", async (t) => {
  for (const target of ["codex", "accounts"]) {
    const setup = fixture();
    disposeFixture(t, setup);
    const prepared = await setup.service.handle({ action: "prepare-save", name: "saved-" + target });
    assert.equal(prepared.ok, true);
    fs.chmodSync(target === "codex" ? setup.paths.codexDir : setup.paths.accountsDir, 0o777);
    const result = await setup.service.handle({ action: "save", intent: prepared.intent });
    assert.equal(result.ok, false, target);
    assert.equal(result.error.code, "untrusted-auth-directory", target);
    assert.equal(fs.existsSync(path.join(setup.paths.accountsDir, "saved-" + target + ".json")), false, target);
  }
});

test("save rejects a symlinked auth_accounts directory before copying auth", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const prepared = await setup.service.handle({ action: "prepare-save", name: "saved" });
  const moved = setup.paths.accountsDir + "-real";
  fs.renameSync(setup.paths.accountsDir, moved);
  fs.symlinkSync(moved, setup.paths.accountsDir);
  const result = await setup.service.handle({ action: "save", intent: prepared.intent });

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
  accountsDir = setup.paths.accountsDir;
  disposeFixture(t, setup);

  const prepared = await setup.service.handle({ action: "prepare-save", name: "saved" });
  const result = await setup.service.handle({ action: "save", intent: prepared.intent });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "untrusted-auth-directory");
  assert.equal(fs.existsSync(path.join(setup.paths.accountsDir, "saved.json")), false);
});

test("recursive redaction removes credentials and paths", () => {
  const output = _test.redact({ token: "secret", nested: { message: "Bearer abc", path: "/private/file" } });
  assert.equal(JSON.stringify(output).includes("secret"), false);
  assert.equal(JSON.stringify(output).includes("/private"), false);
  assert.equal(JSON.stringify(output).includes("Bearer abc"), false);
});

test("account refs are stable across re-lists so a rendered Switch button stays valid", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const first = await setup.service.handle({ action: "list" });
  const second = await setup.service.handle({ action: "list" });
  assert.equal(first.accounts[0].ref, second.accounts[0].ref);
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: first.accounts[0].ref });
  assert.equal(prepared.ok, true);
});

test("stableRef is deterministic per filename and distinct across filenames", () => {
  assert.equal(_test.stableRef("work.json"), _test.stableRef("work.json"));
  assert.notEqual(_test.stableRef("work.json"), _test.stableRef("personal.json"));
  assert.match(_test.stableRef("work.json"), /^[0-9a-f]{32}$/);
});

test("authPaths honors CODEX_HOME and does not expose analytics paths", () => {
  const withHome = _test.authPaths({ path, homedir: () => "/home/whoever", codexHome: "/tmp/custom-codex-home" });
  assert.equal(withHome.codexDir, "/tmp/custom-codex-home");
  assert.equal(withHome.authFile, path.join("/tmp/custom-codex-home", "auth.json"));
  assert.equal(withHome.accountsDir, path.join("/tmp/custom-codex-home", "auth_accounts"));
  assert.equal(Object.hasOwn(withHome, "projectionFile"), false);

  const fallback = _test.authPaths({ path, homedir: () => "/home/whoever", codexHome: null });
  assert.equal(fallback.codexDir, path.join("/home/whoever", ".codex"));
});

test("account labels use a safe saved name and never use an email identity", () => {
  const token = "x." + Buffer.from(JSON.stringify({ name: "Tweakers", email: "tweakers@example.com" })).toString("base64url") + ".x";
  assert.equal(_test.displayLabelFromAuth({ auth_mode: "chatgpt", tokens: { id_token: token } }, "fallback"), "Tweakers");
  assert.equal(_test.displayLabelFromAuth({
    user: { name: "Codex", email: "codex@thereality.report" },
  }, "fallback"), "Codex");
  assert.equal(_test.displayLabelFromAuth({
    user: { name: "Safe Account", email: "sk-proj-SECRET_CANARY" },
  }, "fallback"), "Safe Account");
  assert.equal(_test.displayLabelFromAuth({
    user: { email: "Bearer SECRET_CANARY" },
  }, "sk-proj-SECRET_CANARY"), "");
  assert.equal(_test.displayLabelFromAuth({}, "Work Account"), "Work Account");
});

test("account identity accepts a bounded account email but never infers a username from provider claims", () => {
  const token = "x." + Buffer.from(JSON.stringify({
    preferred_username: "thommyhuli",
    email: "private@example.test",
    email_verified: true,
  })).toString("base64url") + ".x";
  const value = {
    account: { name: "provider-account-id-should-not-render" },
    name: "top-level-provider-id-should-not-render",
    tokens: { id_token: token },
  };

  assert.equal(_test.displayLabelFromAuth(value, "Account 1"), "Account 1");
  assert.equal(_test.displayLabelFromAuth(value, ""), "");
  assert.deepEqual(_test.accountIdentityFromAuth(value, "Account 1"), {
    displayName: "Account 1",
    email: "private@example.test",
    username: null,
  });
  assert.equal(_test.safeUsername("@thommyhuli"), "thommyhuli");
  assert.equal(_test.safeUsername("private@example.test"), "");
  assert.equal(_test.safeEmail("Private@Example.Test"), "private@example.test");
  assert.equal(_test.safeEmail("Bearer SECRET_CANARY"), "");
  const unverified = "x." + Buffer.from(JSON.stringify({
    email: "claim@example.test",
    email_verified: false,
  })).toString("base64url") + ".x";
  assert.equal(_test.accountIdentityFromAuth({
    user: { email: "direct@example.test", username: "provider-account-id-should-not-render" },
    tokens: { id_token: unverified },
  }, "Account 1").email, null, "an explicit negative verification claim fails closed");
  const incomplete = "x." + Buffer.from(JSON.stringify({ email: "two-segment@example.test" })).toString("base64url");
  assert.equal(_test.accountIdentityFromAuth({ tokens: { id_token: incomplete } }, "Account 1").email, null);
});

test("active snapshot sync propagates rotated tokens only for the same account", (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const target = path.join(setup.paths.accountsDir, "work.json");
  const untouched = path.join(setup.paths.accountsDir, "untouched.json");
  fs.writeFileSync(untouched, auth("untouched", "acct-2"), { mode: 0o600 });

  fs.writeFileSync(target, auth("stale", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(setup.paths.authFile, auth("rotated", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(setup.paths.currentMarker, "work.json\n", { mode: 0o600 });
  _test.syncActiveSnapshot(setup.deps, setup.paths);
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated");

  fs.writeFileSync(setup.paths.authFile, auth("other-login", "acct-2"), { mode: 0o600 });
  _test.syncActiveSnapshot(setup.deps, setup.paths);
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated");
  assert.equal(JSON.parse(fs.readFileSync(untouched)).tokens.access_token, "other-login");
  assert.equal(fs.readFileSync(setup.paths.currentMarker, "utf8"), "untouched.json\n");
  const untouchedAfterReconcile = fs.readFileSync(untouched);

  fs.writeFileSync(setup.paths.authFile, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: "anon", refresh_token: "refresh-anon", id_token: "id-anon" },
  }), { mode: 0o600 });
  _test.syncActiveSnapshot(setup.deps, setup.paths);
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated");

  fs.writeFileSync(setup.paths.currentMarker, "missing.json\n", { mode: 0o600 });
  fs.writeFileSync(setup.paths.authFile, auth("rotated-2", "acct-1"), { mode: 0o600 });
  _test.syncActiveSnapshot(setup.deps, setup.paths);
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated-2");
  assert.equal(fs.readFileSync(setup.paths.currentMarker, "utf8"), "work.json\n");
  assert.deepEqual(fs.readFileSync(untouched), untouchedAfterReconcile, "reconciliation changes only the unique matching snapshot");
});

test("marker reconciliation refuses zero, duplicate, missing-id, insecure, and raced candidates without changing the marker", (t) => {
  for (const kind of ["zero", "duplicate", "missing-id", "insecure", "race"]) {
    const setup = fixture();
    disposeFixture(t, setup);
    const target = path.join(setup.paths.accountsDir, "work.json");
    fs.writeFileSync(setup.paths.currentMarker, "missing.json\n", { mode: 0o600 });
    fs.writeFileSync(setup.paths.authFile, auth(kind === "zero" ? "live-no-match" : "stale", kind === "zero" ? "acct-none" : "acct-1"), { mode: 0o600 });
    fs.writeFileSync(target, auth("stale", "acct-1"), { mode: 0o600 });
    if (kind === "duplicate") addSavedAccount(setup, "second", "other", "acct-1");
    if (kind === "missing-id") {
      const missing = JSON.parse(auth("stale", "acct-1"));
      delete missing.tokens.account_id;
      fs.writeFileSync(target, JSON.stringify(missing), { mode: 0o600 });
    }
    if (kind === "insecure") fs.chmodSync(target, 0o644);
    if (kind === "race") {
      const wrapped = Object.create(fs);
      let scans = 0;
      wrapped.readdirSync = (directory, options) => {
        const entries = fs.readdirSync(directory, options);
        if (directory === setup.paths.accountsDir && ++scans === 2) addSavedAccount(setup, "second", "other", "acct-1");
        return entries;
      };
      setup.deps.fs = wrapped;
    }
    const markerBefore = fs.readFileSync(setup.paths.currentMarker);
    const targetBefore = fs.readFileSync(target);
    if (kind === "missing-id" || kind === "insecure") {
      const expectedError = kind === "missing-id" ? /router-operation-failed/ : /invalid-auth-source/;
      assert.throws(() => _test.syncActiveSnapshot(setup.deps, setup.paths), expectedError, kind);
    } else {
      _test.syncActiveSnapshot(setup.deps, setup.paths);
    }
    assert.deepEqual(fs.readFileSync(setup.paths.currentMarker), markerBefore, kind);
    assert.deepEqual(fs.readFileSync(target), targetBefore, kind);
  }
});

test("marker reconciliation restores the previous marker when post-write verification fails", (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const target = path.join(setup.paths.accountsDir, "work.json");
  const invalidMarker = path.join(setup.paths.codexDir, "invalid-marker-fixture");
  fs.writeFileSync(setup.paths.currentMarker, "missing.json\n", { mode: 0o600 });
  fs.writeFileSync(setup.paths.authFile, auth("rotated", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(target, auth("stale", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(invalidMarker, "not a marker\n", { mode: 0o600 });

  const wrapped = Object.create(fs);
  let sabotageNextMarkerRead = false;
  wrapped.renameSync = (source, destination) => {
    fs.renameSync(source, destination);
    if (destination === setup.paths.currentMarker) sabotageNextMarkerRead = true;
  };
  wrapped.openSync = (file, ...args) => {
    if (file === setup.paths.currentMarker && sabotageNextMarkerRead) {
      sabotageNextMarkerRead = false;
      return fs.openSync(invalidMarker, ...args);
    }
    return fs.openSync(file, ...args);
  };
  setup.deps.fs = wrapped;

  assert.throws(() => _test.syncActiveSnapshot(setup.deps, setup.paths), /router-operation-failed/);
  assert.equal(fs.readFileSync(setup.paths.currentMarker, "utf8"), "missing.json\n");
});

test("secure snapshot buffers are cleared after thrown reads and writes", async (t) => {
  let thrownReadBuffer;
  const readFs = Object.create(fs);
  readFs.readSync = (_fd, buffer) => {
    thrownReadBuffer = buffer;
    buffer.fill(0x61);
    throw Object.assign(new Error("read failed"), { code: "EIO" });
  };
  const readSetup = fixture({ fs: readFs });
  disposeFixture(t, readSetup);

  const unreadable = await readSetup.service.handle({ action: "prepare-save", name: "read-failure" });
  assert.equal(unreadable.ok, false);
  assert.ok(Buffer.isBuffer(thrownReadBuffer));
  assert.equal(thrownReadBuffer.every((byte) => byte === 0), true);

  let thrownWriteBuffer;
  const writeFs = Object.create(fs);
  writeFs.writeFileSync = (target, bytes, ...rest) => {
    if (typeof target === "number") {
      thrownWriteBuffer = bytes;
      throw Object.assign(new Error("write failed"), { code: "EIO" });
    }
    return fs.writeFileSync(target, bytes, ...rest);
  };
  const writeSetup = fixture({ fs: writeFs });
  disposeFixture(t, writeSetup);

  const prepared = await writeSetup.service.handle({ action: "prepare-save", name: "write-failure" });
  assert.equal(prepared.ok, true);
  const unwritten = await writeSetup.service.handle({ action: "save", intent: prepared.intent });
  assert.equal(unwritten.ok, false);
  assert.ok(Buffer.isBuffer(thrownWriteBuffer));
  assert.equal(thrownWriteBuffer.every((byte) => byte === 0), true);
});

test("account metadata declares the settings surface and has a synchronized minor version", () => {
  const tweakRoot = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(tweakRoot, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(tweakRoot, "package.json"), "utf8"));

  assert.equal(manifest.name, "Accounts");
  assert.equal(manifest.version, "0.4.4");
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.permissions.includes("settings"), true);
  assert.match(fs.readFileSync(path.join(tweakRoot, "index.js"), "utf8"), /api\.settings\?\.registerPage/);
});

test("visible Accounts controls use plain language instead of router and receipt jargon", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  for (const phrase of [
    "Automatic routing for new conversations",
    "Which account should keep my existing conversations?",
    "Set up automatic routing",
    "Connect or repair accounts",
    "Use manual routing after restart",
    "Plugin check before switching",
    "Check plugins",
    "Block unchecked switches",
    "Old saved-account numbers can skip, so a missing number does not mean an account is missing.",
  ]) assert.equal(source.includes(phrase), true, phrase);
  for (const oldPhrase of [
    "Reconcile & Verify",
    "Enable Enforcement",
    "Use Observation",
    "Stage quota-aware routing",
    "Keep my existing history with",
    "2 connected subscriptions",
  ]) assert.equal(source.includes(oldPhrase), false, oldPhrase);
});

test("router presentation separates active v2 truth from a pending generation", () => {
  const manual = { mode: "manual", restartRequired: false, degradedReason: null };
  assert.equal(_test.routerPresentation(manual, { state: "not_applicable", status: null }, 0).label, "Save two accounts");
  assert.equal(_test.routerPresentation(manual, { state: "not_applicable", status: null }, 1).label, "Save one more account");
  assert.equal(_test.routerPresentation(manual, { state: "not_applicable", status: null }, 2).label, "Ready to set up");
  assert.equal(_test.routerPresentation(manual, { state: "not_applicable", status: null }, 3).label, "Automatic routing unavailable");
  const active = { mode: "quota_aware", policy: "quota_aware_v1", generation: 4, fingerprint: "sha256:" + "a".repeat(64) };
  const pending = { mode: "manual", policy: null, generation: 5, fingerprint: "sha256:" + "b".repeat(64) };
  const running = _test.routerPresentation(
    { schemaVersion: 2, pending, degradedReason: null },
    { state: "active", status: { schemaVersion: 2, active, pending, degradedReason: null, accounts: [{ label: "Taylor", eligibility: "active", assignedThreadCount: 2 }] } },
    2,
  );
  assert.equal(running.label, "Automatic routing is on");
  assert.match(running.message, /saved routing change will apply after you restart Codex/);
  assert.deepEqual(running.accounts, [{ label: "Taylor", eligibility: "active", assignedThreadCount: 2 }]);
  assert.equal(_test.routerPresentation({ schemaVersion: 2, pending, degradedReason: null }, { state: "not_running", status: null }, 2).label, "Automatic routing setup is saved — not active yet");
  assert.equal(_test.routerPresentation({ mode: "direct_fallback", restartRequired: true, degradedReason: null }, { state: "not_running", status: null }, 2).label, "Manual fallback is saved");
  assert.equal(_test.routerPresentation({ mode: "direct_fallback", restartRequired: true, degradedReason: "post_start_failure" }, { state: "not_running", status: null }, 2).label, "Automatic routing needs attention");
});

test("authenticated router status accepts only the redacted mux projection", () => {
  const requestId = "router-test";
  const opaque = "ar_" + "a".repeat(43);
  const parsed = _test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify({
    version: 1,
    requestId,
    status: {
      schemaVersion: 1,
      mode: "balanced",
      protocolState: "supported",
      fairnessPrecision: "exact_completed_spend",
      accounts: [{ opaqueAccountId: opaque, label: "Account A", eligibility: "active", normalizedSpend: 1, assignedThreadCount: 2 }],
      restartRequired: false,
      degradedReason: null,
    },
  })), requestId);
  assert.deepEqual(parsed.accounts, [{ label: "Account A", eligibility: "active", normalizedSpend: 1, assignedThreadCount: 2 }]);
  assert.equal(JSON.stringify(parsed).includes(opaque), false);
  assert.equal(_test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify({ version: 1, requestId, status: { secret: "no" } })), requestId), null);
});

test("quota-aware v2 status accepts nullable quota fields but never exposes opaque ids", () => {
  const requestId = "quota-router-test";
  const active = { mode: "quota_aware", policy: "quota_aware_v1", generation: 3, fingerprint: "sha256:" + "a".repeat(64) };
  const status = {
    schemaVersion: 2,
    active,
    pending: { mode: "manual", policy: null, generation: 4, fingerprint: "sha256:" + "b".repeat(64) },
    protocolState: "supported",
    accounts: [
      { opaqueAccountId: "ar_" + "c".repeat(43), label: "Taylor", eligibility: "active", plan: "Pro", identifierMasked: "••••••••", weekly: { remainingPercent: 90, resetAt: "2026-09-07T00:00:00.000Z", freshness: "fresh" }, shortWindowPressure: 18, assignedThreadCount: 2 },
      { opaqueAccountId: "ar_" + "d".repeat(43), label: "Taylor", eligibility: "reauth_required", plan: null, identifierMasked: "••••••••", weekly: { remainingPercent: null, resetAt: null, freshness: "unknown" }, shortWindowPressure: null, assignedThreadCount: 0 },
    ],
    poolRemainingPercent: null,
    restartRequired: true,
    degradedReason: "quota_unknown",
  };
  const parsed = _test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify({ version: 1, requestId, status })), requestId);
  assert.equal(parsed.active.generation, 3);
  assert.equal(parsed.pending.generation, 4);
  assert.equal(parsed.accounts[1].weekly.remainingPercent, null);
  assert.equal(parsed.poolRemainingPercent, null);
  assert.equal(JSON.stringify(parsed).includes("ar_"), false);
  const unsafe = structuredClone(status);
  unsafe.accounts[0].plan = "private@example.test";
  assert.equal(_test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify({ version: 1, requestId, status: unsafe })), requestId), null);
  const missingActive = structuredClone(status);
  missingActive.active = null;
  assert.equal(_test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify({ version: 1, requestId, status: missingActive })), requestId), null);
  const invalidPressure = structuredClone(status);
  invalidPressure.accounts[0].shortWindowPressure = "unknown";
  assert.equal(_test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify({ version: 1, requestId, status: invalidPressure })), requestId), null);
});

test("quota pool has a bounded 0–200 calculation and unknown never becomes capacity", () => {
  assert.equal(_test.quotaPoolRemainingPercent([{ weekly: { remainingPercent: 95, freshness: "fresh" } }, { weekly: { remainingPercent: 85, freshness: "fresh" } }]), 180);
  assert.equal(_test.quotaPoolRemainingPercent([{ weekly: { remainingPercent: 120, freshness: "fresh" } }, { weekly: { remainingPercent: -10, freshness: "fresh" } }]), 100);
  assert.equal(_test.quotaPoolRemainingPercent([{ weekly: { remainingPercent: 100, freshness: "fresh" } }, { weekly: { remainingPercent: 100, freshness: "fresh" } }]), 200);
  assert.equal(_test.quotaPoolRemainingPercent([{ weekly: { remainingPercent: 100, freshness: "fresh" } }, { weekly: { remainingPercent: 50, freshness: "stale" } }]), null);
  assert.equal(_test.quotaPoolRemainingPercent([{ weekly: { remainingPercent: 100, freshness: "fresh" } }, { weekly: { remainingPercent: null, freshness: "unknown" } }]), null);
});

test("v2 config fingerprint uses a stable fixed canonical vector", () => {
  const value = {
    schemaVersion: 2,
    mode: "quota_aware",
    policy: "quota_aware_v1",
    generation: 7,
    protocolFingerprint: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10",
    primaryOpaqueAccountId: "ar_" + "a".repeat(43),
    accounts: [
      { opaqueAccountId: "ar_" + "a".repeat(43), included: true, weight: 1, capabilityFingerprint: "sha256:" + "b".repeat(64), label: "Alpha" },
      { opaqueAccountId: "ar_" + "c".repeat(43), included: true, weight: 1, capabilityFingerprint: "sha256:" + "d".repeat(64), label: "Beta" },
    ],
    updatedAt: "2026-08-31T18:00:00.000Z",
  };
  assert.equal(_test.routerConfigFingerprint(value), "sha256:b26118045c98f42a6dcd1e53ba871d63b1a4b23b4aaf8f35969645bf719826b7");
  assert.equal(_test.routerConfigFingerprint({ ...value, updatedAt: "2026-09-01T18:00:00.000Z" }), _test.routerConfigFingerprint(value));
});

test("legacy v1 config remains readable and manual rollback writes a v2 pending intent", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const v2 = JSON.parse(fs.readFileSync(routerPaths.configFile, "utf8"));
  const v1 = {
    schemaVersion: 1,
    mode: "balanced",
    protocolFingerprint: v2.protocolFingerprint,
    primaryOpaqueAccountId: v2.primaryOpaqueAccountId,
    accounts: v2.accounts.map(({ opaqueAccountId, included, weight, capabilityFingerprint }) => ({ opaqueAccountId, included, weight, capabilityFingerprint })),
    updatedAt: v2.updatedAt,
  };
  fs.writeFileSync(routerPaths.configFile, JSON.stringify(v1), { mode: 0o600 });
  assert.equal(_test.readRouterConfig(setup.deps, routerPaths).schemaVersion, 1);
  const legacyProjection = _test.routerPublicStatus(setup.deps, v1, null);
  assert.equal(legacyProjection.schemaVersion, 1);
  assert.equal(legacyProjection.mode, "balanced");
  assert.equal(JSON.stringify(legacyProjection.accounts).includes("opaqueAccountId"), false);
  const rollback = await setup.service.handle({ action: "router-configure", mode: "manual" });
  assert.equal(rollback.ok, true);
  const manual = JSON.parse(fs.readFileSync(routerPaths.configFile, "utf8"));
  assert.equal(manual.schemaVersion, 2);
  assert.equal(manual.mode, "manual");
  assert.equal(manual.policy, null);
  assert.equal(manual.accounts.length, 2);
  assert.equal(manual.fingerprint, _test.routerConfigFingerprint(manual));
});

test("profile menu shows account identity but no global current account while automatic routing is active", (t) => {
  const previousDocument = global.document;
  const nodes = [];
  const element = (tagName) => {
    const node = {
      tagName, children: [], attrs: {}, dataset: {}, className: "", textContent: "", type: "",
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(name, listener) { this[`on_${name}`] = listener; },
    };
    nodes.push(node);
    return node;
  };
  global.document = { createElement: element };
  t.after(() => { global.document = previousDocument; });
  const status = {
    schemaVersion: 2,
    active: { mode: "quota_aware", policy: "quota_aware_v1", generation: 1, fingerprint: "sha256:" + "a".repeat(64) },
    pending: null,
    accounts: [
      { ref: "taylor", label: "Taylor", plan: "Pro", identifierMasked: "••••••••", eligibility: "active", weekly: { remainingPercent: 75, resetAt: null, freshness: "fresh" }, shortWindowPressure: 0, assignedThreadCount: 1 },
      { ref: "morgan", label: "Morgan", plan: "Plus", identifierMasked: "••••••••", eligibility: "reauth_required", weekly: { remainingPercent: 65, resetAt: null, freshness: "stale" }, shortWindowPressure: null, assignedThreadCount: 0 },
    ],
  };
  const accounts = [
    { ref: "taylor", label: "Taylor", displayLabel: "Taylor", email: "taylor@example.test", username: "taylorh", active: true },
    { ref: "morgan", label: "Morgan", displayLabel: "Morgan", email: "morgan@example.test", username: null, active: false },
  ];
  const panel = _test.accountMenuRows({ api: { settings: { async openPage() { return { ok: true }; } }, log: { warn() {} } } }, accounts, { live: { state: "active", status } });
  const flatten = (node) => `${node.textContent || ""} ${node.children.map(flatten).join(" ")}`;
  const text = flatten(panel);
  assert.match(text, /Weekly usage left/);
  assert.match(text, /2 saved accounts/);
  assert.match(text, /Cannot check right now/);
  assert.match(text, /Manage accounts/);
  assert.match(text, /@taylorh/);
  assert.match(text, /taylor@example\.test/);
  assert.match(text, /morgan@example\.test/);
  assert.equal(text.includes("Using now"), false, "automatic routing has no single global current account");
  assert.equal((text.match(/Automatic routing is on/g) || []).length, 1);
  assert.match(text, /Sign in again/);
  assert.equal(text.includes("Switch ChatGPT account"), false);
  assert.equal(text.includes("Saved snapshot"), false);
  assert.equal(text.includes("provider-account-id-should-not-render"), false);
  assert.equal(nodes.filter((node) => node.className.includes("hover:bg-token-foreground\/5") && node.children.length > 0).length, 2);
});

test("profile menu marks exactly one directly signed-in saved account as Using now", (t) => {
  const previousDocument = global.document;
  const element = (tagName) => ({
    tagName, children: [], attrs: {}, dataset: {}, className: "", textContent: "", type: "",
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(name, listener) { this[`on_${name}`] = listener; },
  });
  global.document = { createElement: element };
  t.after(() => { global.document = previousDocument; });
  const panel = _test.accountMenuRows(
    { api: { settings: { async openPage() { return { ok: true }; } }, log: { warn() {} } } },
    [
      { label: "Thomas", displayLabel: "Thomas Hulihan", email: "thomas@example.test", username: "thommyhuli", active: true },
      { label: "TRR", displayLabel: "The Reality Report", email: "trr@example.test", username: null, active: false },
    ],
    { live: { state: "not_running", status: null } },
  );
  const flatten = (node) => `${node.textContent || ""} ${node.children.map(flatten).join(" ")}`;
  const text = flatten(panel);
  assert.equal((text.match(/Using now/g) || []).length, 1);
  assert.match(text, /Saved — automatic routing is not running yet/);
  assert.match(text, /Thomas Hulihan/);
  assert.match(text, /@thommyhuli/);
  assert.equal(_test.accountUsingNow({ active: true }, { state: "active" }), false);
  assert.equal(_test.accountUsingNow({ active: true }, { state: "not_running" }), true);
  assert.equal(_test.accountRowStatus({ active: true }, null, { state: "not_running" }), "Using now");
  assert.equal(_test.accountRowStatus({ active: false }, null, { state: "not_running" }), "Saved — automatic routing is not running yet");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "active" }, { state: "active", status: { active: { mode: "quota_aware" } } }), "Automatic routing is on");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "reauth_required" }, { state: "active", status: { active: { mode: "quota_aware" } } }), "Sign in again");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "active" }, { state: "active", status: { active: { mode: "manual" } } }), "Saved account");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "reauth_required" }, { state: "active", status: { active: { mode: "manual" } } }), "Sign in again");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "quota_depleted" }, { state: "active", status: { active: { mode: "manual" } } }), "Weekly usage used up");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "cooldown" }, { state: "active", status: { active: { mode: "quota_aware" } } }), "Waiting before next use");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "protocol_blocked" }, { state: "active", status: { active: { mode: "quota_aware" } } }), "Routing update required");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "disabled" }, { state: "active", status: { active: { mode: "quota_aware" } } }), "Not enabled for routing");
  assert.equal(_test.accountRowStatus({ ref: "one" }, { ref: "one", eligibility: "unhealthy" }, { state: "active", status: { active: { mode: "quota_aware" } } }), "This account needs attention");
  assert.equal(_test.accountRowStatus({ ref: "one" }, null, { state: "active", status: { active: { mode: "quota_aware" } } }), "Status unavailable");
  assert.equal(_test.accountRowStatus({ ref: "one" }, null, { state: "unavailable" }), "Status unavailable");
});

test("conversation ownership never falls back to an internal generic snapshot label", (t) => {
  const previousDocument = global.document;
  const element = (tagName) => ({
    tagName, children: [], className: "", textContent: "",
    append(...children) { this.children.push(...children); },
  });
  global.document = { createElement: element };
  t.after(() => { global.document = previousDocument; });
  const card = _test.historyAdoptionCard({
    state: "pending_offline_adoption",
    ownerRef: null,
    ownerLabel: "account-2",
    importedThreadCount: 0,
    databaseCount: 0,
    historyCount: 0,
  }, [{ ref: "known", displayLabel: "Thomas Hulihan", email: "thomas@example.test" }]);
  const flatten = (node) => `${node.textContent || ""} ${node.children.map(flatten).join(" ")}`;
  const text = flatten(card);
  assert.match(text, /The selected account will keep your current conversations/);
  assert.equal(text.includes("account-2"), false);
});

test("profile menu associates quota details by safe ref instead of visible labels", (t) => {
  const previousDocument = global.document;
  const element = (tagName) => ({
    tagName, children: [], attrs: {}, dataset: {}, className: "", textContent: "", type: "",
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(name, listener) { this[`on_${name}`] = listener; },
  });
  global.document = { createElement: element };
  t.after(() => { global.document = previousDocument; });
  const status = {
    schemaVersion: 2,
    accounts: [
      { ref: "one", label: "Same visible label", plan: "Pro", identifierMasked: "••••••••", eligibility: "active", weekly: { remainingPercent: 99, resetAt: null, freshness: "fresh" }, shortWindowPressure: 0, assignedThreadCount: 1 },
      { ref: "two", label: "Same visible label", plan: "Enterprise", identifierMasked: "••••••••", eligibility: "active", weekly: { remainingPercent: 20, resetAt: null, freshness: "fresh" }, shortWindowPressure: 0, assignedThreadCount: 1 },
    ],
  };
  assert.equal(_test.accountDetailsFor({ ref: "one", label: "Renamed locally" }, status).plan, "Pro");
  assert.equal(_test.accountDetailsFor({ ref: "two", label: "Taylor" }, status).plan, "Enterprise");
  assert.equal(_test.accountDetailsFor({ ref: "missing", label: "Same visible label" }, status), null);
  assert.equal(_test.accountDetailsFor({ ref: "one" }, { ...status, accounts: status.accounts.map((account) => ({ ...account, ref: "one" })) }), null,
    "duplicate refs fail closed");
  const panel = _test.accountMenuRows(
    { api: { settings: { async openPage() { return { ok: true }; } }, log: { warn() {} } } },
    [{ ref: "one", label: "Taylor" }, { ref: "two", label: "Renamed locally" }],
    { live: { state: "active", status } },
  );
  const flatten = (node) => `${node.textContent || ""} ${node.children.map(flatten).join(" ")}`;
  const text = flatten(panel);
  assert.match(text, /Pro/);
  assert.match(text, /Enterprise/);
  assert.match(text, /99% weekly/);
  assert.match(text, /20% weekly/);
});

test("profile menu keeps every manual switch visible outside the exact two-account routing pool", (t) => {
  const previousDocument = global.document;
  const element = (tagName) => ({
    tagName, children: [], attrs: {}, dataset: {}, className: "", textContent: "", type: "", disabled: false,
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(name, listener) { this[`on_${name}`] = listener; },
  });
  global.document = { createElement: element };
  t.after(() => { global.document = previousDocument; });
  const state = { api: { settings: { async openPage() { return { ok: true }; } }, log: { warn() {} } }, pluginProtectionMode: "observation" };
  const labels = (panel) => panel.children.filter((node) => node.type === "button").map((node) => node.textContent);
  const one = _test.accountMenuRows(state, [{ label: "One", ref: "one" }], null);
  const three = _test.accountMenuRows(state, [
    { label: "One", ref: "one" }, { label: "Two", ref: "two" }, { label: "Three", ref: "three" },
  ], null);
  assert.deepEqual(labels(one), ["One", "Manage accounts"]);
  assert.deepEqual(labels(three), ["One", "Two", "Three", "Manage accounts"]);
  const buttons = (node) => [
    ...(node.type === "button" ? [node.textContent] : []),
    ...node.children.flatMap(buttons),
  ];
  const status = { textContent: "" };
  assert.deepEqual(buttons(_test.advancedAccountsCard(state, [{ label: "One", ref: "one" }], null, status)).filter((label) => label === "One"), ["One"]);
  assert.deepEqual(buttons(_test.advancedAccountsCard(state, [
    { label: "One", ref: "one" }, { label: "Two", ref: "two" }, { label: "Three", ref: "three" },
  ], null, status)).filter((label) => ["One", "Two", "Three"].includes(label)), ["One", "Two", "Three"]);
});

test("authenticated router status rejects unsafe and unknown public enum strings before presentation", () => {
  const requestId = "router-enum-test";
  const base = {
    version: 1,
    requestId,
    status: {
      schemaVersion: 1,
      mode: "balanced",
      protocolState: "supported",
      fairnessPrecision: "exact_completed_spend",
      accounts: [{ opaqueAccountId: "ar_" + "b".repeat(43), label: "Account A", eligibility: "active", normalizedSpend: 1, assignedThreadCount: 0 }],
      restartRequired: false,
      degradedReason: null,
    },
  };
  for (const [field, value] of [
    ["eligibility", "/private/router-secret-canary"],
    ["eligibility", "Bearer enum-secret-canary"],
    ["eligibility", "unknown_eligibility"],
    ["degradedReason", "/private/router-secret-canary"],
    ["degradedReason", "Bearer enum-secret-canary"],
    ["degradedReason", "unknown_degraded_reason"],
  ]) {
    const candidate = structuredClone(base);
    if (field === "eligibility") candidate.status.accounts[0].eligibility = value;
    else candidate.status.degradedReason = value;
    const parsed = _test.parseAuthenticatedRouterStatus(Buffer.from(JSON.stringify(candidate)), requestId);
    assert.equal(parsed, null, `${field}: ${value}`);
    assert.notEqual(
      _test.routerPresentation(candidate.status, { state: "active", status: parsed }, 2).label,
      "Running Balanced",
      `${field}: ${value} cannot reach the running projection`,
    );
  }
});

test("router controls require an explicit history owner before staging quota-aware routing", async (t) => {
  const previousDocument = global.document;
  const nodes = [];
  const element = (tagName) => {
    const node = {
      tagName,
      children: [],
      attrs: {},
      className: "",
      textContent: "",
      type: "",
      disabled: false,
      value: "",
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      setAttribute(key, value) { this.attrs[key] = value; },
      getAttribute(key) { return this.attrs[key] || null; },
      addEventListener(name, listener) { this[`on_${name}`] = listener; },
    };
    nodes.push(node);
    return node;
  };
  global.document = { createElement: element };
  t.after(() => { global.document = previousDocument; });
  const calls = [];
  _test.routerControlCard({
    api: {
      ipc: {
        async invoke(_channel, request) {
          calls.push(request);
          return { ok: true, router: { schemaVersion: 2, mode: "quota_aware", policy: "quota_aware_v1", pending: { mode: "quota_aware", policy: "quota_aware_v1", generation: 1, fingerprint: "sha256:" + "a".repeat(64) }, restartRequired: true, degradedReason: null }, live: { state: "not_running", status: null } };
        },
      },
      log: { warn() {} },
    },
  }, [{ ref: "one", label: "Account One" }, { ref: "two", label: "Account Two" }]);
  const status = nodes.find((node) => node.attrs.role === "status");
  const historyOwner = nodes.find((node) => node.attrs["aria-label"] === "Which account should keep my existing conversations?");
  const stage = nodes.find((node) => node.textContent === "Set up automatic routing");
  assert.equal(status.attrs["aria-live"], "polite");
  assert.equal(historyOwner.value, "");
  assert.equal(stage.disabled, true, "there is no default history owner");
  historyOwner.value = "two";
  historyOwner.on_change();
  assert.equal(stage.disabled, false);
  await stage.on_click();
  assert.deepEqual(calls, [{ action: "router-configure", mode: "quota_aware", refs: ["one", "two"], primaryRef: "one", legacyOwnerRef: "two", weights: [1, 1] }]);
});

function addSavedAccount(setup, name, token, accountId) {
  fs.writeFileSync(path.join(setup.paths.accountsDir, `${name}.json`), auth(token, accountId), { mode: 0o600 });
}

function validRouterState(config, overrides = {}) {
  const ledger = Object.fromEntries(config.accounts.map((account) => [account.opaqueAccountId, {
    completedInputTokens: 100,
    completedOutputTokens: 20,
    reservedRequestCost: 0,
    weight: account.weight,
    assignedThreadCount: 1,
  }]));
  return {
    schemaVersion: 1,
    protocolFingerprint: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10",
    epoch: 1,
    threadOwners: {},
    pendingThreadOwners: {},
    ledger,
    reservations: [],
    accountEligibility: Object.fromEntries(config.accounts.map((account) => [account.opaqueAccountId, "eligible"])),
    correlations: [],
    stagedDisable: null,
    ...overrides,
  };
}

function installActiveRouterSocket(t, setup, routerPaths, status) {
  const socketPath = _test.routerControlSocketPath(setup.deps, routerPaths);
  const originalFs = setup.deps.fs;
  const originalNet = setup.deps.net;
  const wrapped = Object.create(fs);
  wrapped.lstatSync = (target) => {
    if (target === socketPath) return { isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o600 };
    if (target === path.dirname(socketPath)) return { isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o700 };
    return originalFs.lstatSync(target);
  };
  setup.deps.fs = wrapped;
  setup.deps.net = {
    createConnection() {
      const { EventEmitter } = require("node:events");
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.end = (request) => {
        const requestId = JSON.parse(request.toString("utf8")).requestId;
        queueMicrotask(() => {
          socket.emit("data", Buffer.from(JSON.stringify({ version: 1, requestId, status })));
          socket.emit("end");
        });
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
  t.after(() => { setup.deps.fs = originalFs; setup.deps.net = originalNet; });
}

function activeQuotaStatus(config) {
  return {
    schemaVersion: 2,
    active: { mode: "quota_aware", policy: "quota_aware_v1", generation: config.generation, fingerprint: config.fingerprint },
    pending: null,
    protocolState: "supported",
    restartRequired: false,
    accounts: config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      label: account.label,
      eligibility: "active",
      plan: "Pro",
      identifierMasked: "••••••••",
      weekly: { remainingPercent: 80, resetAt: null, freshness: "fresh" },
      shortWindowPressure: 0,
      assignedThreadCount: 1,
    })),
    poolRemainingPercent: 160,
    degradedReason: null,
  };
}

const HISTORY_DATABASE_NAMES = ["goals_1.sqlite", "logs_2.sqlite", "memories_1.sqlite", "queue_1.sqlite", "state_5.sqlite", "thread_history_1.sqlite"];
const HISTORY_ENTRY_NAMES = ["archived_sessions", "session_index.jsonl", "sessions"];
const fingerprint = (hex) => `sha256:${hex.repeat(64).slice(0, 64)}`;

function historyOwnersFor(config, intent, secret, threadIds = [], overrides = {}) {
  const owner = overrides.legacyOwnerOpaqueAccountId || intent.legacyOwnerOpaqueAccountId;
  const sortedThreadIds = [...threadIds].sort();
  const base = {
    schemaVersion: 1,
    kind: "account-router-history-adoption-owners",
    protocolFingerprint: config.protocolFingerprint,
    poolFingerprint: _test.historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId)),
    legacyOwnerOpaqueAccountId: owner,
    threadIds: sortedThreadIds,
    threadOwnersFingerprint: _test.historyAdoptionThreadOwnersFingerprint(sortedThreadIds, owner),
    adoptedAt: "2026-08-31T18:00:00.000Z",
    ...overrides,
  };
  return _test.signHistoryAdoptionOwners(secret, base);
}

function historyReceiptFor(config, intent, secret, overrides = {}) {
  const owner = overrides.legacyOwnerOpaqueAccountId || intent.legacyOwnerOpaqueAccountId;
  const base = {
    schemaVersion: 1,
    kind: "account-router-history-adoption-receipt",
    protocolFingerprint: config.protocolFingerprint,
    poolFingerprint: _test.historyPoolFingerprint(config.protocolFingerprint, config.accounts.map((account) => account.opaqueAccountId)),
    intentFingerprint: _test.historyAdoptionIntentFingerprint(intent),
    legacyOwnerOpaqueAccountId: owner,
    sourceFingerprint: fingerprint("a"),
    destinationFingerprint: fingerprint("b"),
    databases: HISTORY_DATABASE_NAMES.map((name) => ({ name, present: false, sha256: null, bytes: 0, integrity: null })),
    histories: HISTORY_ENTRY_NAMES.map((name) => ({ name, present: false, sha256: null, bytes: 0, fileCount: 0 })),
    importedThreadCount: 0,
    threadOwnersFingerprint: _test.historyAdoptionThreadOwnersFingerprint([], owner),
    backupFingerprint: fingerprint("d"),
    adoptedAt: "2026-08-31T18:00:00.000Z",
    ...overrides,
  };
  return _test.signHistoryAdoptionReceipt(secret, base);
}

test("history-adoption intent uses sorted canonical pool and a fixed HMAC vector", () => {
  const secret = Buffer.from("01".repeat(32), "hex");
  const first = `ar_${"a".repeat(43)}`;
  const second = `ar_${"b".repeat(43)}`;
  const protocolFingerprint = "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10";
  const unsigned = {
    schemaVersion: 1,
    kind: "account-router-history-adoption-intent",
    protocolFingerprint,
    poolFingerprint: _test.historyPoolFingerprint(protocolFingerprint, [second, first]),
    configGeneration: 7,
    configFingerprint: fingerprint("c"),
    legacyOwnerOpaqueAccountId: first,
    createdAt: "2026-08-31T18:00:00.000Z",
  };
  const signed = _test.signHistoryAdoptionIntent(secret, unsigned);
  assert.equal(unsigned.poolFingerprint, "sha256:ad24190f3fab23eff12e4111699334bb510d2450a7d1d5cc033803bf6527b9b8");
  assert.equal(_test.historyAdoptionIntentFingerprint(signed), "sha256:944c8d0828251af540c85441f2e3bff5b60aef96efe6cb61547cdbed54d80fe9");
  assert.equal(signed.hmac, "hmac-sha256:b4a9a63e06a34938183f57e0b38807be7b54b849f4dbd91ad96b12937729c693");
  assert.equal(_test.historyPoolFingerprint(protocolFingerprint, [first, second]), unsigned.poolFingerprint);
  assert.doesNotThrow(() => _test.validateHistoryAdoptionIntent(signed, secret));
  assert.throws(() => _test.validateHistoryAdoptionIntent({ ...signed, configGeneration: 8 }, secret), /invalid-history-adoption-intent/);
  assert.throws(() => _test.validateHistoryAdoptionIntent({ ...signed, extra: true }, secret), /invalid-history-adoption-intent/);
  secret.fill(0);
});

test("history adoption requires a selected owner before any isolated home or config publication", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const base = { action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), weights: [1, 1] };

  const missing = await setup.service.handle(base);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "router-history-owner-required");
  const foreign = await setup.service.handle({ ...base, legacyOwnerRef: "foreign-ref" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, "router-history-owner-not-selected");
  assert.equal(fs.existsSync(routerPaths.configFile), false);
  assert.equal(fs.existsSync(routerPaths.historyAdoptionIntentFile), false);
  assert.equal(fs.existsSync(routerPaths.controlSecretFile), false);
  assert.equal(fs.readdirSync(routerPaths.accountsDir).length, 0, "no isolated home is published without an explicit selected owner");
});

test("history-adoption receipts are strict, signed, and bind future staging to the stable pool and owner", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  addSavedAccount(setup, "third", "third", "account-third");
  const listed = await setup.service.handle({ action: "list" });
  const selected = listed.accounts.slice(0, 2);
  const initial = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: selected.map((account) => account.ref), legacyOwnerRef: selected[0].ref, weights: [1, 1] });
  assert.equal(initial.ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  const intent = JSON.parse(fs.readFileSync(routerPaths.historyAdoptionIntentFile, "utf8"));
  const originalIntentBytes = fs.readFileSync(routerPaths.historyAdoptionIntentFile);
  const secret = fs.readFileSync(routerPaths.controlSecretFile);
  const receipt = historyReceiptFor(config, intent, secret);
  const owners = historyOwnersFor(config, intent, secret);
  assert.doesNotThrow(() => _test.validateHistoryAdoptionReceipt(receipt, secret));
  assert.doesNotThrow(() => _test.validateHistoryAdoptionOwners(owners, secret));
  assert.throws(() => _test.validateHistoryAdoptionReceipt(_test.signHistoryAdoptionReceipt(secret, { ...receipt, databases: receipt.databases.slice().reverse() }), secret), /invalid-history-adoption-receipt/);
  assert.throws(() => _test.validateHistoryAdoptionReceipt({ ...receipt, hmac: "hmac-sha256:" + "0".repeat(64) }, secret), /invalid-history-adoption-receipt/);
  assert.throws(() => _test.validateHistoryAdoptionOwners({ ...owners, hmac: "hmac-sha256:" + "0".repeat(64) }, secret), /invalid-history-adoption-owners/);
  fs.writeFileSync(routerPaths.historyAdoptionReceiptFile, JSON.stringify(receipt), { mode: 0o600 });

  const missingOwners = await setup.service.handle({ action: "router-configure", mode: "manual" });
  assert.equal(missingOwners.ok, false);
  assert.equal(missingOwners.error.code, "router-history-adoption-invalid");
  fs.writeFileSync(routerPaths.historyAdoptionOwnersFile, JSON.stringify(owners), { mode: 0o600 });
  fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(config)), { mode: 0o600 });

  const manual = await setup.service.handle({ action: "router-configure", mode: "manual" });
  assert.equal(manual.ok, true);
  const sameOwner = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: selected.map((account) => account.ref), legacyOwnerRef: selected[0].ref, weights: [1, 1] });
  assert.equal(sameOwner.ok, true, "a valid receipt remains usable across same-pool generations");
  assert.deepEqual(fs.readFileSync(routerPaths.historyAdoptionIntentFile), originalIntentBytes,
    "post-adoption staging preserves the original signed intent named by the receipt");
  const restaged = _test.readRouterConfig(setup.deps, routerPaths);
  assert.notEqual(restaged.generation, config.generation);
  assert.notEqual(restaged.fingerprint, config.fingerprint);
  const configBeforeMismatch = fs.readFileSync(routerPaths.configFile);
  const ownerMismatch = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: selected.map((account) => account.ref), legacyOwnerRef: selected[1].ref, weights: [1, 1] });
  assert.equal(ownerMismatch.ok, false);
  assert.equal(ownerMismatch.error.code, "router-history-adoption-mismatch");
  const poolMismatch = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: [selected[0].ref, listed.accounts[2].ref], legacyOwnerRef: selected[0].ref, weights: [1, 1] });
  assert.equal(poolMismatch.ok, false);
  assert.equal(poolMismatch.error.code, "router-history-adoption-mismatch");
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBeforeMismatch);
  const status = await setup.service.handle({ action: "router-status" });
  assert.equal(status.router.historyAdoption.state, "adopted");
  assert.equal(status.router.historyAdoption.ownerLabel, selected[0].label);
  assert.equal(JSON.stringify(status).includes(intent.legacyOwnerOpaqueAccountId), false);
  assert.equal(JSON.stringify(status).includes(secret.toString("hex")), false);
  const importedThreadId = "019d0000-0000-7000-8000-000000000001";
  const threadedOwners = historyOwnersFor(restaged, intent, secret, [importedThreadId]);
  const threadedReceipt = historyReceiptFor(restaged, intent, secret, {
    importedThreadCount: 1,
    threadOwnersFingerprint: threadedOwners.threadOwnersFingerprint,
    adoptedAt: threadedOwners.adoptedAt,
  });
  const threadedRecords = {
    intent,
    receipt: threadedReceipt,
    owners: threadedOwners,
    intentInvalid: false,
    receiptInvalid: false,
    ownersInvalid: false,
  };
  assert.equal(_test.historyAdoptionProjection(restaged, threadedRecords, validRouterState(restaged)).state, "invalid",
    "a signed owners manifest cannot claim adopted until durable owner state contains its imported threads");
  assert.equal(_test.historyAdoptionProjection(restaged, threadedRecords, validRouterState(restaged, {
    threadOwners: { [importedThreadId]: intent.legacyOwnerOpaqueAccountId },
  })).state, "adopted");
  assert.equal(_test.historyAdoptionProjection(_test.readRouterConfig(setup.deps, routerPaths), {
    intent: null, receipt: null, owners: null, intentInvalid: false, receiptInvalid: false, ownersInvalid: false,
  }).state, "required");
  assert.equal(_test.historyAdoptionProjection(_test.readRouterConfig(setup.deps, routerPaths), {
    intent: null, receipt: null, owners: null, intentInvalid: false, receiptInvalid: true, ownersInvalid: false,
  }).state, "invalid");
  assert.equal(_test.historyAdoptionProjection(_test.readRouterConfig(setup.deps, routerPaths), {
    intent: null, receipt: { ...receipt, poolFingerprint: fingerprint("e") }, owners: null,
    intentInvalid: false, receiptInvalid: false, ownersInvalid: false,
  }).state, "invalid");
  secret.fill(0);
});

test("a deliberate pre-adoption restage replaces stale intent and projects only safe offline history state", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const first = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(first.ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const before = JSON.parse(fs.readFileSync(routerPaths.historyAdoptionIntentFile, "utf8"));
  assert.equal((await setup.service.handle({ action: "router-configure", mode: "manual" })).ok, true);
  const restaged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[1].ref, weights: [1, 1] });
  assert.equal(restaged.ok, true);
  const after = JSON.parse(fs.readFileSync(routerPaths.historyAdoptionIntentFile, "utf8"));
  assert.notEqual(after.legacyOwnerOpaqueAccountId, before.legacyOwnerOpaqueAccountId);
  const status = await setup.service.handle({ action: "router-status" });
  assert.equal(status.router.historyAdoption.state, "pending_offline_adoption");
  assert.equal(status.router.historyAdoption.ownerLabel, listed.accounts[1].label);
  assert.equal(JSON.stringify(status.router.historyAdoption).includes(after.legacyOwnerOpaqueAccountId), false);
  assert.equal(JSON.stringify(status.router.historyAdoption).includes("access_token"), false);
  const manualPresentation = _test.routerPresentation({ schemaVersion: 2, pending: { mode: "manual", policy: null }, historyAdoption: { state: "adopted" } }, { state: "not_running", status: null }, 2);
  assert.equal(manualPresentation.label, "Manual routing is saved — not active yet");
  assert.match(manualPresentation.message, /Current conversations will stay with their assigned account/);
});

test("quota-aware v2 stages exactly two isolated snapshot homes and immutable pending intent", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
  const result = await setup.service.handle({
    action: "router-configure", mode: "balanced",
    refs: listed.accounts.map((account) => account.ref),
    primaryRef: listed.accounts[0].ref,
    legacyOwnerRef: listed.accounts[0].ref,
    weights: [1, 3],
  });

  assert.equal(result.ok, true);
  assert.equal(result.router.mode, "quota_aware");
  assert.equal(result.router.accounts.length, 2);
  assert.equal(JSON.stringify(result).includes("account-work"), false);
  assert.equal(JSON.stringify(result).includes("access_token"), false);
  assert.equal(JSON.stringify(result).includes(setup.paths.codexDir), false);
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore, "manual source snapshot remains canonical and unchanged");

  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = JSON.parse(fs.readFileSync(routerPaths.configFile, "utf8"));
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.mode, "quota_aware");
  assert.equal(config.policy, "quota_aware_v1");
  assert.equal(config.generation, 1);
  assert.equal(config.fingerprint, _test.routerConfigFingerprint(config));
  assert.equal(config.accounts.length, 2);
  assert.equal(config.accounts.every((account) => /^ar_[A-Za-z0-9_-]{43}$/.test(account.opaqueAccountId)), true);
  assert.equal(JSON.stringify(config).includes("account-work"), false);
  assert.equal(JSON.stringify(config).includes("access_token"), false);
  assert.equal(fs.statSync(routerPaths.routerDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(routerPaths.configFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(routerPaths.controlSecretFile).mode & 0o777, 0o600);
  for (const account of config.accounts) {
    const home = path.join(routerPaths.accountsDir, account.opaqueAccountId, "codex-home");
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, "auth.json")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), "", "v1 does not copy existing config or environment");
  }
});

test("quota-aware restaging preserves same-account rotated isolated auth and receipts its home hash", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  assert.equal((await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] })).ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const initial = _test.readRouterConfig(setup.deps, routerPaths);
  const work = initial.accounts.find((account) => account.label === "work");
  const homeAuth = path.join(routerPaths.accountsDir, work.opaqueAccountId, "codex-home", "auth.json");
  const rotatedHome = Buffer.from(auth("work-home-rotated", "account-work"));
  fs.writeFileSync(homeAuth, rotatedHome, { mode: 0o600 });

  const manual = await setup.service.handle({ action: "router-configure", mode: "manual" });
  assert.equal(manual.ok, true);
  const pendingManual = _test.readRouterConfig(setup.deps, routerPaths);
  assert.equal(pendingManual.mode, "manual");
  const restaged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(restaged.ok, true);
  const next = _test.readRouterConfig(setup.deps, routerPaths);
  assert.equal(next.mode, "quota_aware");
  assert.equal(next.generation, pendingManual.generation + 1);
  assert.deepEqual(fs.readFileSync(homeAuth), rotatedHome, "ordinary restaging must not overwrite a rotated isolated token");
  const rotatedHash = crypto.createHash("sha256").update(rotatedHome).digest("hex");
  const receipt = JSON.parse(fs.readFileSync(routerPaths.receiptsFile, "utf8"))
    .find((entry) => entry.generation === next.generation && entry.opaqueAccountId === work.opaqueAccountId);
  assert.equal(receipt.snapshotHash, `sha256:${rotatedHash}`);
});

test("quota-aware restaging rejects an existing isolated home for a different account", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  assert.equal((await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] })).ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  const work = config.accounts.find((account) => account.label === "work");
  const homeAuth = path.join(routerPaths.accountsDir, work.opaqueAccountId, "codex-home", "auth.json");
  fs.writeFileSync(homeAuth, auth("wrong-home", "account-second"), { mode: 0o600 });
  const configBefore = fs.readFileSync(routerPaths.configFile);
  const receiptsBefore = fs.readFileSync(routerPaths.receiptsFile);
  const wrongHome = fs.readFileSync(homeAuth);

  const result = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.receiptsFile), receiptsBefore);
  assert.deepEqual(fs.readFileSync(homeAuth), wrongHome);
});

test("quota-aware restaging rejects a changed isolated-home config before publication", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  assert.equal((await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] })).ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  const work = config.accounts.find((account) => account.label === "work");
  const homeConfig = path.join(routerPaths.accountsDir, work.opaqueAccountId, "codex-home", "config.toml");
  fs.writeFileSync(homeConfig, "[unsafe]\n", { mode: 0o600 });
  const configBefore = fs.readFileSync(routerPaths.configFile);
  const receiptsBefore = fs.readFileSync(routerPaths.receiptsFile);

  const result = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.receiptsFile), receiptsBefore);
  assert.equal(fs.readFileSync(homeConfig, "utf8"), "[unsafe]\n");
});

test("v2 staging rejects incompatible private pair or per-account weights before publication", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  addSavedAccount(setup, "third", "third", "account-third");
  const listed = await setup.service.handle({ action: "list" });
  const selected = listed.accounts.slice(0, 2);
  const staged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: selected.map((account) => account.ref), legacyOwnerRef: selected[0].ref, weights: [2, 3] });
  assert.equal(staged.ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const initial = _test.readRouterConfig(setup.deps, routerPaths);
  fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(initial)), { mode: 0o600 });
  const configBefore = fs.readFileSync(routerPaths.configFile);
  const receiptsBefore = fs.readFileSync(routerPaths.receiptsFile);
  const stateBefore = fs.readFileSync(routerPaths.stateFile);
  const homesBefore = fs.readdirSync(routerPaths.accountsDir).sort();

  const mismatchedWeights = await setup.service.handle({
    action: "router-configure", mode: "quota_aware", refs: selected.map((account) => account.ref), legacyOwnerRef: selected[0].ref, weights: [3, 2],
  });
  assert.equal(mismatchedWeights.ok, false);
  assert.equal(mismatchedWeights.error.code, "router-state-mismatch-requires-reset");
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.receiptsFile), receiptsBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.stateFile), stateBefore);
  assert.deepEqual(fs.readdirSync(routerPaths.accountsDir).sort(), homesBefore);

  const reversed = await setup.service.handle({
    action: "router-configure", mode: "quota_aware", refs: selected.slice().reverse().map((account) => account.ref), legacyOwnerRef: selected[0].ref, weights: [3, 2],
  });
  assert.equal(reversed.ok, true, "state keys are a set; only each account's own weight must match");
  const reversedConfig = _test.readRouterConfig(setup.deps, routerPaths);
  assert.deepEqual(reversedConfig.accounts.map((account) => account.opaqueAccountId), initial.accounts.map((account) => account.opaqueAccountId).reverse());
  assert.deepEqual(fs.readFileSync(routerPaths.stateFile), stateBefore);

  const configAfterReverse = fs.readFileSync(routerPaths.configFile);
  const receiptsAfterReverse = fs.readFileSync(routerPaths.receiptsFile);
  const mismatchedPair = await setup.service.handle({
    action: "router-configure", mode: "quota_aware", refs: [selected[0].ref, listed.accounts[2].ref], legacyOwnerRef: selected[0].ref, weights: [2, 3],
  });
  assert.equal(mismatchedPair.ok, false);
  assert.equal(mismatchedPair.error.code, "router-state-mismatch-requires-reset");
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configAfterReverse);
  assert.deepEqual(fs.readFileSync(routerPaths.receiptsFile), receiptsAfterReverse);
  assert.deepEqual(fs.readFileSync(routerPaths.stateFile), stateBefore);
  assert.deepEqual(fs.readdirSync(routerPaths.accountsDir).sort(), homesBefore);
});

test("v2 staging permits an exact idle private state without mutating it", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const first = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [2, 3] });
  assert.equal(first.ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const initial = _test.readRouterConfig(setup.deps, routerPaths);
  fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(initial)), { mode: 0o600 });
  const stateBefore = fs.readFileSync(routerPaths.stateFile);

  const repeated = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [2, 3] });
  assert.equal(repeated.ok, true);
  const next = _test.readRouterConfig(setup.deps, routerPaths);
  assert.equal(next.generation, initial.generation + 1);
  assert.deepEqual(fs.readFileSync(routerPaths.stateFile), stateBefore);
});

test("receipt publication failure never publishes a runnable pending config", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const originalRename = fs.renameSync;
  const wrapped = Object.create(fs);
  wrapped.renameSync = (from, to) => {
    if (to === routerPaths.receiptsFile) throw Object.assign(new Error("receipt write injected"), { code: "EIO" });
    return originalRename(from, to);
  };
  setup.deps.fs = wrapped;
  t.after(() => { setup.deps.fs = fs; });

  const failed = await setup.service.handle({
    action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1],
  });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(routerPaths.configFile), false, "receipt failure must happen before config publication");
});

test("v2 config timestamps use the runtime's strict UTC ISO form", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  const config = _test.readRouterConfig(setup.deps, _test.accountRouterPaths(setup.deps, setup.paths));
  assert.doesNotThrow(() => _test.validateRouterConfig({ ...config, updatedAt: "2026-08-31T18:00:00.123Z" }));
  assert.throws(() => _test.validateRouterConfig({ ...config, updatedAt: "2026-08-31T18:00:00.123456Z" }), /invalid-router-config/);
  assert.throws(() => _test.validateRouterConfig({ ...config, updatedAt: "2026-02-30T18:00:00.123Z" }), /invalid-router-config/);
  assert.throws(() => _test.validateRouterConfig({ ...config, updatedAt: "2026-08-31T18:00:00+00:00" }), /invalid-router-config/);
});

test("targeted reauthentication refreshes the same saved source and stopped isolated home before staging", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const staged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(staged.ok, true);
  const work = listed.accounts.find((account) => account.label === "work");
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const before = _test.readRouterConfig(setup.deps, routerPaths);
  const workConfig = before.accounts.find((account) => account.label === "work");
  const homeAuth = path.join(routerPaths.accountsDir, workConfig.opaqueAccountId, "codex-home", "auth.json");
  const secondBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "second.json"));
  fs.writeFileSync(setup.paths.authFile, auth("work-reauthenticated", "account-work"), { mode: 0o600 });
  // A present net implementation plus an absent private control socket is the
  // bounded proof that this local router generation is not running.
  setup.deps.net = { createConnection() { throw new Error("must not connect without a socket"); } };

  const refreshed = await setup.service.handle({ action: "router-recover", ref: work.ref });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.router.restartRequired, true);
  assert.equal(refreshed.live.state, "not_running");
  assert.equal(JSON.parse(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"))).tokens.access_token, "work-reauthenticated");
  assert.equal(JSON.parse(fs.readFileSync(homeAuth)).tokens.access_token, "work-reauthenticated");
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "second.json")), secondBefore);
  assert.deepEqual(fs.readdirSync(setup.paths.accountsDir).filter((name) => name.endsWith(".json")).sort(), ["second.json", "work.json"]);
  const after = _test.readRouterConfig(setup.deps, routerPaths);
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.fingerprint, _test.routerConfigFingerprint(after));
});

test("targeted reauthentication refuses an unverified or running router without changing saved or isolated auth", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  const work = listed.accounts.find((account) => account.label === "work");
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  const workConfig = config.accounts.find((account) => account.label === "work");
  const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
  const homeAuth = path.join(routerPaths.accountsDir, workConfig.opaqueAccountId, "codex-home", "auth.json");
  const homeBefore = fs.readFileSync(homeAuth);
  const configBefore = fs.readFileSync(routerPaths.configFile);
  fs.writeFileSync(setup.paths.authFile, auth("work-reauthenticated", "account-work"), { mode: 0o600 });

  const unverified = await setup.service.handle({ action: "router-recover", ref: work.ref });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.error.code, "router-recovery-router-status-unavailable");
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore);
  assert.deepEqual(fs.readFileSync(homeAuth), homeBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBefore);

  const socketPath = _test.routerControlSocketPath(setup.deps, routerPaths);
  const originalFs = setup.deps.fs;
  const wrapped = Object.create(fs);
  wrapped.lstatSync = (target) => {
    if (target === socketPath) return { isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o600 };
    if (target === path.dirname(socketPath)) return { isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o700 };
    return originalFs.lstatSync(target);
  };
  setup.deps.fs = wrapped;
  const activeStatus = {
    schemaVersion: 2,
    active: { mode: "quota_aware", policy: "quota_aware_v1", generation: config.generation, fingerprint: config.fingerprint },
    pending: null,
    protocolState: "supported",
    restartRequired: false,
    accounts: config.accounts.map((account) => ({
      opaqueAccountId: account.opaqueAccountId,
      label: account.label,
      eligibility: "active",
      plan: null,
      identifierMasked: "••••••••",
      weekly: { remainingPercent: null, resetAt: null, freshness: "unknown" },
      shortWindowPressure: null,
      assignedThreadCount: 0,
    })),
    poolRemainingPercent: null,
    degradedReason: null,
  };
  setup.deps.net = {
    createConnection() {
      const { EventEmitter } = require("node:events");
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.end = (request) => {
        const requestId = JSON.parse(request.toString("utf8")).requestId;
        queueMicrotask(() => {
          socket.emit("data", Buffer.from(JSON.stringify({ version: 1, requestId, status: activeStatus })));
          socket.emit("end");
        });
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
  t.after(() => { setup.deps.fs = originalFs; });

  const running = await setup.service.handle({ action: "router-recover", ref: work.ref });
  assert.equal(running.ok, false);
  assert.equal(running.error.code, "router-recovery-router-running");
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore);
  assert.deepEqual(fs.readFileSync(homeAuth), homeBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBefore);
});

test("targeted reauthentication rolls back source and isolated auth when receipt publication fails", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  const work = listed.accounts.find((account) => account.label === "work");
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  const workConfig = config.accounts.find((account) => account.label === "work");
  const homeAuth = path.join(routerPaths.accountsDir, workConfig.opaqueAccountId, "codex-home", "auth.json");
  const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
  const homeBefore = fs.readFileSync(homeAuth);
  const configBefore = fs.readFileSync(routerPaths.configFile);
  fs.writeFileSync(setup.paths.authFile, auth("work-reauthenticated", "account-work"), { mode: 0o600 });
  setup.deps.net = { createConnection() { throw new Error("must not connect without a socket"); } };
  const originalFs = setup.deps.fs;
  const wrapped = Object.create(fs);
  wrapped.renameSync = (from, to) => {
    if (to === routerPaths.receiptsFile) throw Object.assign(new Error("receipt write injected"), { code: "EIO" });
    return originalFs.renameSync(from, to);
  };
  setup.deps.fs = wrapped;
  t.after(() => { setup.deps.fs = originalFs; });

  const failed = await setup.service.handle({ action: "router-recover", ref: work.ref });
  assert.equal(failed.ok, false);
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore);
  assert.deepEqual(fs.readFileSync(homeAuth), homeBefore);
  assert.deepEqual(fs.readFileSync(routerPaths.configFile), configBefore);
});

test("balanced configuration rejects a third account, invalid weights, and duplicate identity before mutating config", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  addSavedAccount(setup, "third", "third", "account-third");
  const listed = await setup.service.handle({ action: "list" });
  const before = fs.readFileSync(setup.paths.authFile);
  const third = await setup.service.handle({ action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), weights: [1, 1, 1] });
  assert.equal(third.ok, false);
  const badWeight = await setup.service.handle({ action: "router-configure", mode: "balanced", refs: listed.accounts.slice(0, 2).map((account) => account.ref), weights: [0, 1] });
  assert.equal(badWeight.ok, false);
  assert.deepEqual(fs.readFileSync(setup.paths.authFile), before);
  assert.equal(fs.existsSync(path.join(setup.root, "tweak-data", "co.tweakers.account-switcher", "account-router-config.json")), false);
});

test("router hardens only owner-owned 0755 children and leaves its shared parent unchanged", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  fs.mkdirSync(routerPaths.routerDir, { mode: 0o755 });
  fs.mkdirSync(routerPaths.accountsDir, { mode: 0o755 });
  fs.chmodSync(routerPaths.routerDir, 0o755);
  fs.chmodSync(routerPaths.accountsDir, 0o755);
  const sharedParent = path.dirname(routerPaths.routerDir);
  const parentMode = fs.statSync(sharedParent).mode & 0o777;
  const listed = await setup.service.handle({ action: "list" });
  const result = await setup.service.handle({
    action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1],
  });

  assert.equal(result.ok, true);
  assert.equal(fs.statSync(sharedParent).mode & 0o777, parentMode, "the shared runtime parent is never chmodded");
  assert.equal(fs.statSync(routerPaths.routerDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(routerPaths.accountsDir).mode & 0o777, 0o700);
});

test("router directory hardening rejects writable, symlinked, and non-directory children before config mutation", async (t) => {
  for (const kind of ["0775", "0777", "symlink", "file"]) {
    const setup = fixture();
    disposeFixture(t, setup);
    addSavedAccount(setup, "second", "second", "account-second");
    const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
    const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
    if (kind === "0775" || kind === "0777") {
      fs.mkdirSync(routerPaths.routerDir, { mode: 0o700 });
      fs.chmodSync(routerPaths.routerDir, kind === "0775" ? 0o775 : 0o777);
    } else if (kind === "symlink") {
      const outside = path.join(setup.root, "outside-router");
      fs.mkdirSync(outside, { mode: 0o700 });
      fs.symlinkSync(outside, routerPaths.routerDir);
    } else {
      fs.writeFileSync(routerPaths.routerDir, "not a directory", { mode: 0o600 });
    }
    const listed = await setup.service.handle({ action: "list" });
    const result = await setup.service.handle({
      action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), weights: [1, 1],
    });
    assert.equal(result.ok, false, kind);
    assert.equal(result.error.code, "untrusted-router-directory", kind);
    assert.equal(fs.existsSync(routerPaths.configFile), false, kind);
    assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore, kind);
  }
});

test("router directory hardening rejects wrong-owner and post-open replacement observations before config mutation", async (t) => {
  for (const kind of ["wrong-owner", "post-open-replacement"]) {
    const setup = fixture();
    disposeFixture(t, setup);
    addSavedAccount(setup, "second", "second", "account-second");
    const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
    const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
    const wrapped = Object.create(fs);
    let routerFd = null;
    let hardened = false;
    wrapped.openSync = (target, ...args) => {
      const fd = fs.openSync(target, ...args);
      if (target === routerPaths.routerDir) routerFd = fd;
      return fd;
    };
    wrapped.fchmodSync = (fd, mode) => {
      fs.fchmodSync(fd, mode);
      if (fd === routerFd) hardened = true;
    };
    wrapped.fstatSync = (fd) => {
      const stat = fs.fstatSync(fd);
      if (kind === "wrong-owner" && fd === routerFd) return Object.assign(Object.create(stat), { uid: stat.uid + 1 });
      return stat;
    };
    wrapped.lstatSync = (target) => {
      const stat = fs.lstatSync(target);
      if (kind === "post-open-replacement" && target === routerPaths.routerDir && hardened) {
        return Object.assign(Object.create(stat), { ino: stat.ino + 1 });
      }
      return stat;
    };
    setup.deps.fs = wrapped;
    const listed = await setup.service.handle({ action: "list" });
    const result = await setup.service.handle({
      action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), weights: [1, 1],
    });
    assert.equal(result.ok, false, kind);
    assert.equal(result.error.code, "untrusted-router-directory", kind);
    assert.equal(fs.existsSync(routerPaths.configFile), false, kind);
    assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore, kind);
  }
});

test("manual router mode leaves an absent configuration and router children untouched", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const sharedParent = path.dirname(routerPaths.routerDir);
  const parentMode = fs.statSync(sharedParent).mode & 0o777;
  const manual = await setup.service.handle({ action: "router-configure", mode: "manual" });

  assert.equal(manual.ok, true);
  assert.equal(manual.router.mode, "manual");
  assert.equal(fs.existsSync(routerPaths.routerDir), false);
  assert.equal(fs.existsSync(routerPaths.configFile), false);
  assert.equal(fs.statSync(sharedParent).mode & 0o777, parentMode);
});

test("router IPC maps injected details to a finite safe error code", async (t) => {
  const logs = [];
  const setup = fixture({ log: { info(...args) { logs.push(args); }, warn(...args) { logs.push(args); } } });
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const wrapped = Object.create(fs);
  wrapped.fchmodSync = () => {
    throw Object.assign(new Error("/private/router-secret-canary"), { code: "arbitrary-lowercase-secret-canary" });
  };
  setup.deps.fs = wrapped;
  const result = await setup.service.handle({
    action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "router-operation-failed");
  const publicText = JSON.stringify(result);
  assert.equal(publicText.includes("arbitrary-lowercase-secret-canary"), false);
  assert.equal(publicText.includes("/private/router-secret-canary"), false);
  assert.equal(JSON.stringify(logs).includes("router-secret-canary"), false);
});

test("failed isolated-home promotion removes only its staging home and never alters a manual snapshot", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
  const originalRename = setup.deps.fs.renameSync;
  setup.deps.fs.renameSync = (from, to) => {
    if (String(to).includes(`${path.sep}accounts${path.sep}ar_`)) throw Object.assign(new Error("injected"), { code: "EIO" });
    return originalRename(from, to);
  };
  t.after(() => { setup.deps.fs.renameSync = originalRename; });
  const failed = await setup.service.handle({ action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  assert.equal(failed.ok, false);
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore);
  const routerAccounts = path.join(setup.root, "tweak-data", "co.tweakers.account-switcher", "accounts");
  assert.equal(fs.readdirSync(routerAccounts).some((name) => name.startsWith(".staging-")), false);
});

test("manual rollback stages a new pending generation while preserving isolated homes", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  assert.equal((await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] })).ok, true);
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const homesBefore = fs.readdirSync(routerPaths.accountsDir).sort();
  const sourceBefore = fs.readFileSync(path.join(setup.paths.accountsDir, "work.json"));
  const authBefore = fs.readFileSync(setup.paths.authFile);
  const markerBefore = fs.readFileSync(setup.paths.currentMarker);
  const manual = await setup.service.handle({ action: "router-configure", mode: "manual" });
  assert.equal(manual.ok, true);
  assert.equal(manual.router.mode, "manual");
  assert.deepEqual(fs.readdirSync(routerPaths.accountsDir).sort(), homesBefore);
  assert.equal(JSON.parse(fs.readFileSync(routerPaths.configFile, "utf8")).mode, "manual");
  assert.deepEqual(fs.readFileSync(path.join(setup.paths.accountsDir, "work.json")), sourceBefore);
  assert.deepEqual(fs.readFileSync(setup.paths.authFile), authBefore);
  assert.deepEqual(fs.readFileSync(setup.paths.currentMarker), markerBefore);
  const firstManual = JSON.parse(fs.readFileSync(routerPaths.configFile, "utf8"));
  const repeated = await setup.service.handle({ action: "router-configure", mode: "manual" });
  assert.equal(repeated.ok, true);
  const secondManual = JSON.parse(fs.readFileSync(routerPaths.configFile, "utf8"));
  assert.equal(secondManual.mode, "manual");
  assert.equal(secondManual.generation, firstManual.generation + 1);
  assert.equal(secondManual.fingerprint, _test.routerConfigFingerprint(secondManual));
});

test("main lifecycle stop disposes resources without changing routing", () => {
  const serviceKey = "__tweakersAccountServiceV1";
  const handlerKey = "__tweakersAccountHandlerV1";
  const previousService = globalThis[serviceKey];
  const previousHandler = globalThis[handlerKey];
  let manualStages = 0;
  let disposals = 0;
  let unregisters = 0;
  globalThis[serviceKey] = {
    disableRouter() { manualStages += 1; },
    dispose() { disposals += 1; },
  };
  globalThis[handlerKey] = () => { unregisters += 1; };
  try {
    tweak.stop();
    assert.equal(manualStages, 0, "routine teardown must not stage manual routing");
    assert.equal(disposals, 1);
    assert.equal(unregisters, 1);
    assert.equal(globalThis[serviceKey], null);
    assert.equal(globalThis[handlerKey], null);
  } finally {
    if (previousService === undefined) delete globalThis[serviceKey];
    else globalThis[serviceKey] = previousService;
    if (previousHandler === undefined) delete globalThis[handlerKey];
    else globalThis[handlerKey] = previousHandler;
  }
});

test("balance epoch reset is durably allowed only while the router is idle", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  await setup.service.handle({ action: "router-configure", mode: "balanced", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [2, 3] });
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(config)), { mode: 0o600 });
  const reset = await setup.service.handle({ action: "router-reset-balance-epoch" });
  assert.deepEqual(reset, { ok: true, epoch: 2 });
  const after = _test.readRouterState(setup.deps, routerPaths);
  assert.equal(after.epoch, 2);
  assert.equal(Object.values(after.ledger).every((ledger) => ledger.completedInputTokens === 0 && ledger.assignedThreadCount === 0), true);

  const reservation = (state) => ({
    reservationId: "rs_1234567890abcdef",
    opaqueAccountId: config.accounts[0].opaqueAccountId,
    estimatedCost: 1,
    state,
    epoch: 1,
  });
  for (const state of ["released_pre_dispatch", "reconciled"]) {
    fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(config, { reservations: [reservation(state)] })), { mode: 0o600 });
    const terminalReset = await setup.service.handle({ action: "router-reset-balance-epoch" });
    assert.deepEqual(terminalReset, { ok: true, epoch: 2 }, state);
  }
  for (const state of ["reserved", "stranded_ambiguous"]) {
    fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(config, { reservations: [reservation(state)] })), { mode: 0o600 });
    const blocked = await setup.service.handle({ action: "router-reset-balance-epoch" });
    assert.equal(blocked.ok, false, state);
    assert.equal(blocked.error.code, "router-not-idle", state);
  }
});

test("router status keeps a v2 disk intent pending and projects only redacted state", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  addSavedAccount(setup, "second", "second", "account-second");
  const listed = await setup.service.handle({ action: "list" });
  await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  const config = _test.readRouterConfig(setup.deps, routerPaths);
  fs.writeFileSync(routerPaths.stateFile, JSON.stringify(validRouterState(config, { stagedDisable: { reasonCode: "post_start_failure", stagedAt: new Date().toISOString() } })), { mode: 0o600 });
  const status = await setup.service.handle({ action: "router-status" });
  assert.equal(status.ok, true);
  assert.equal(status.router.mode, "quota_aware");
  assert.equal(status.router.pending.mode, "quota_aware");
  assert.equal(status.router.active, null);
  assert.equal(status.router.degradedReason, "post_start_failure");
  assert.equal(status.router.accounts.length, 2);
  assert.deepEqual(status.router.accounts.map((account) => account.ref).sort(), listed.accounts.map((account) => account.ref).sort());
  assert.equal(status.router.historyAdoption.ownerRef, listed.accounts[0].ref);
  assert.equal(JSON.stringify(status.router.accounts).includes("opaqueAccountId"), false);
  assert.equal(JSON.stringify(status).includes("account-work"), false);
  assert.equal(JSON.stringify(status).includes("access_token"), false);
  assert.equal(JSON.stringify(status).includes(setup.paths.codexDir), false);
});

test("router status defaults to manual and fails closed to a redacted invalid-config state", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const defaultStatus = await setup.service.handle({ action: "router-status" });
  assert.equal(defaultStatus.ok, true);
  assert.equal(defaultStatus.router.mode, "manual");
  assert.equal(defaultStatus.router.restartRequired, false);

  const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
  fs.mkdirSync(routerPaths.routerDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(routerPaths.configFile, "{", { mode: 0o600 });
  const corrupt = await setup.service.handle({ action: "router-status" });
  assert.equal(corrupt.ok, true);
  assert.equal(corrupt.router.mode, "manual");
  assert.equal(corrupt.router.degradedReason, "invalid_config");
  assert.equal(corrupt.router.historyAdoption.state, "invalid");
  assert.equal(JSON.stringify(corrupt).includes(setup.paths.codexDir), false);
});

test("router status preserves authenticated v2 active truth when later pending disk records are corrupt", async (t) => {
  for (const corruptTarget of ["config", "state"]) {
    const setup = fixture();
    disposeFixture(t, setup);
    addSavedAccount(setup, "second", "second", "account-second");
    const listed = await setup.service.handle({ action: "list" });
    const staged = await setup.service.handle({ action: "router-configure", mode: "quota_aware", refs: listed.accounts.map((account) => account.ref), legacyOwnerRef: listed.accounts[0].ref, weights: [1, 1] });
    assert.equal(staged.ok, true, corruptTarget);
    const routerPaths = _test.accountRouterPaths(setup.deps, setup.paths);
    const config = _test.readRouterConfig(setup.deps, routerPaths);
    installActiveRouterSocket(t, setup, routerPaths, activeQuotaStatus(config));
    const target = corruptTarget === "config" ? routerPaths.configFile : routerPaths.stateFile;
    fs.writeFileSync(target, "{", { mode: 0o600 });

    const result = await setup.service.handle({ action: "router-status" });
    assert.equal(result.ok, true, corruptTarget);
    assert.equal(result.router.pending, null, corruptTarget);
    assert.equal(result.router.degradedReason, "invalid_config", corruptTarget);
    assert.equal(result.live.state, "active", corruptTarget);
    assert.equal(result.live.status.schemaVersion, 2, corruptTarget);
    assert.equal(result.live.status.active.generation, config.generation, corruptTarget);
    assert.deepEqual(result.live.status.accounts.map((account) => account.ref).sort(), listed.accounts.map((account) => account.ref).sort(), corruptTarget);
    assert.equal(JSON.stringify(result.live).includes("opaqueAccountId"), false, corruptTarget);
    assert.equal(_test.routerPresentation(result.router, result.live, 2).label, "Automatic routing is on", corruptTarget);
    assert.match(_test.routerPresentation(result.router, result.live, 2).message, /saved setup needs attention/, corruptTarget);
  }
});

test("experimental inventory maps package IDs and excludes created-by-me plugins", () => {
  const response = requiredInventory({
    marketplaces: [
      ...requiredInventory().marketplaces,
      { name: "created-by-me-remote", plugins: [{ id: "app-private@created-by-me-remote", source: { type: "remote" }, installed: true, enabled: true }] },
    ],
  });
  const plugins = _test.inventoryPlugins(response);
  assert.deepEqual(plugins.map((plugin) => plugin.id).sort(), [
    "app-693b20fccbac8191bdc178bb493de3e5@openai-curated-remote",
    "app-6a3c407853888191beddc2151c2b6f8b@openai-curated-remote",
  ]);
});

test("plugin receipt validity rejects missing, stale, wrong-account, wrong-profile, and wrong-build records", () => {
  const profile = _test.defaultPluginProfile();
  const binding = testRuntimeBinding();
  const receipt = _test.makePluginReceipt(profile, "account-work", binding, requiredInventory(), 10_000);
  assert.equal(_test.evaluatePluginReceipt(receipt, profile, "account-work", binding, 10_001).valid, true);
  assert.equal(_test.evaluatePluginReceipt(null, profile, "account-work", binding, 10_001).code, "missing");
  assert.equal(_test.evaluatePluginReceipt(receipt, profile, "other-account", binding, 10_001).code, "wrong-account");
  assert.equal(_test.evaluatePluginReceipt(receipt, { ...profile, accountAdditions: { "account-work": ["app-extra@openai-curated-remote"] } }, "account-work", binding, 10_001).code, "wrong-profile");
  assert.equal(_test.evaluatePluginReceipt(receipt, profile, "account-work", testRuntimeBinding({ desktopVersion: "26.810.52045" }), 10_001).code, "wrong-build");
  assert.equal(_test.evaluatePluginReceipt(receipt, profile, "account-work", testRuntimeBinding({ bundledCliVersion: "0.149.0" }), 10_001).code, "wrong-build");
  assert.equal(_test.evaluatePluginReceipt(receipt, profile, "account-work", binding, 10_000 + 31 * 24 * 60 * 60 * 1_000).code, "stale");
  assert.equal(_test.evaluatePluginReceipt(receipt, profile, "account-work", null, 10_001).code, "build-unavailable");
});

test("profile retains both mandatory baseline plugins and rejects email-like account keys", () => {
  const profile = _test.normalizePluginProfile({
    schemaVersion: 1,
    requiredBaseline: [{ id: "app-693b20fccbac8191bdc178bb493de3e5@openai-curated-remote", name: "Mailchimp" }],
    accountAdditions: { "person@example.com": ["app-extra@openai-curated-remote"], "account-ok": ["app-extra@openai-curated-remote"] },
    enforcement: true,
  });
  assert.deepEqual(profile.requiredBaseline.map((plugin) => plugin.name), ["Mailchimp", "Resend"]);
  assert.equal(Object.hasOwn(profile.accountAdditions, "person@example.com"), false);
  assert.deepEqual(profile.accountAdditions["account-ok"], ["app-extra@openai-curated-remote"]);
});

test("runtime binding combines the desktop build with the exact bundled CLI version", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const binding = await _test.runtimeCodexBinding(setup.api, setup.deps);
  assert.equal(binding.desktopVersion, "26.810.52044");
  assert.equal(binding.buildFlavor, "prod");
  assert.equal(binding.bundledCliVersion, "0.148.0-alpha.9");
  assert.match(binding.executable, /runtime-resources\/codex$/);
});

test("verification writes only non-secret positive proof for the current active account", async (t) => {
  const setup = fixture({ inventory: async () => requiredInventory() });
  disposeFixture(t, setup);
  const result = await setup.service.handle({ action: "plugin-protection-verify-current" });
  assert.equal(result.ok, true);
  const saved = setup.store.get("remote-plugin-receipts-v1");
  const receipt = saved.receipts["account-current"];
  assert.equal(receipt.accountId, "account-current");
  assert.equal(receipt.plugins.length, 2);
  assert.equal(JSON.stringify(saved).includes("access_token"), false);
  assert.equal(JSON.stringify(saved).includes("refresh-current"), false);
  assert.equal(JSON.stringify(saved).includes("id-current"), false);
});

test("plugin protection status never exposes raw account IDs or stored receipts to renderer IPC", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const profile = _test.defaultPluginProfile();
  setup.store.set("remote-plugin-receipts-v1", {
    schemaVersion: 1,
    receipts: {
      "account-current": _test.makePluginReceipt(profile, "account-current", testRuntimeBinding(), requiredInventory(), Date.now()),
    },
  });

  const result = await setup.service.handle({ action: "plugin-protection-status" });
  assert.equal(result.ok, true);
  assert.equal(result.pluginProtection.active.valid, true);
  assert.equal(Object.hasOwn(result.pluginProtection, "receipts"), false);
  assert.equal(Object.hasOwn(result.pluginProtection, "accountId"), false);
  assert.equal(JSON.stringify(result).includes("account-current"), false);
});

test("incomplete inventory never refreshes a receipt and observation mode keeps switching available", async (t) => {
  const setup = fixture({ inventory: async () => requiredInventory({ marketplaces: [{ name: "openai-curated-remote", plugins: [] }] }) });
  disposeFixture(t, setup);
  const verified = await setup.service.handle({ action: "plugin-protection-verify-current" });
  assert.equal(verified.ok, false);
  assert.equal(verified.error.code, "plugin-protection-verification-incomplete");
  assert.equal(setup.store.has("remote-plugin-receipts-v1"), false);
  const list = await setup.service.handle({ action: "list" });
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  assert.equal(prepared.ok, true);
});

test("marketplace errors and duplicate required rows never mint a receipt", async (t) => {
  const base = requiredInventory();
  for (const response of [
    requiredInventory({ marketplaceLoadErrors: [{ marketplace: "openai-curated-remote", message: "unavailable" }] }),
    requiredInventory({ marketplaces: [{ ...base.marketplaces[0], plugins: [...base.marketplaces[0].plugins, base.marketplaces[0].plugins[0]] }] }),
  ]) {
    const setup = fixture({ inventory: async () => response });
    disposeFixture(t, setup);
    const result = await setup.service.handle({ action: "plugin-protection-verify-current" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "plugin-protection-verification-incomplete");
    assert.equal(setup.store.has("remote-plugin-receipts-v1"), false);
  }
});

test("a malformed package ID cannot fall back to remotePluginId and mint a receipt", async (t) => {
  const malformed = requiredInventory();
  malformed.marketplaces[0].plugins[0] = {
    ...malformed.marketplaces[0].plugins[0],
    id: "app-malformed@openai-curated-remote",
    remotePluginId: "app-693b20fccbac8191bdc178bb493de3e5",
  };
  const setup = fixture({ inventory: async () => malformed });
  disposeFixture(t, setup);
  const result = await setup.service.handle({ action: "plugin-protection-verify-current" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "plugin-protection-verification-incomplete");
  assert.equal(setup.store.has("remote-plugin-receipts-v1"), false);
});

test("enforcement blocks before auth mutation, while fresh single-use bypass allows exactly one switch", async (t) => {
  let restarts = 0;
  const setup = fixture({ onSwitched: () => { restarts += 1; return true; } });
  disposeFixture(t, setup);
  assert.equal((await setup.service.handle({ action: "plugin-protection-configure", enforcement: true })).ok, true);
  const list = await setup.service.handle({ action: "list" });
  const before = fs.readFileSync(setup.paths.authFile);
  const blocked = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "plugin-protection-receipt-required");
  assert.deepEqual(fs.readFileSync(setup.paths.authFile), before);
  assert.equal(restarts, 0);

  const bypass = await setup.service.handle({ action: "prepare-switch-bypass", ref: list.accounts[0].ref });
  assert.equal(bypass.ok, true);
  const switched = await setup.service.handle({ action: "switch", intent: bypass.intent });
  assert.equal(switched.ok, true);
  assert.equal(restarts, 1);
  const reused = await setup.service.handle({ action: "switch", intent: bypass.intent });
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, "invalid-or-expired-intent");
});

test("a valid target receipt preserves enforcement switching without a bypass", async (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const profile = _test.defaultPluginProfile();
  setup.store.set("remote-plugin-receipts-v1", {
    schemaVersion: 1,
    receipts: { "account-work": _test.makePluginReceipt(profile, "account-work", testRuntimeBinding(), requiredInventory(), Date.now()) },
  });
  assert.equal((await setup.service.handle({ action: "plugin-protection-configure", enforcement: true })).ok, true);
  const list = await setup.service.handle({ action: "list" });
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  assert.equal(prepared.ok, true);
  const result = await setup.service.handle({ action: "switch", intent: prepared.intent });
  assert.equal(result.ok, true);
});

test("startup observation uses stored receipt status and never invokes inventory or schedules restart", async (t) => {
  let inventoryCalls = 0;
  let restarts = 0;
  const setup = fixture({ inventory: async () => { inventoryCalls += 1; return requiredInventory(); }, onSwitched: () => { restarts += 1; return true; } });
  disposeFixture(t, setup);
  const result = await setup.service.observeStartup();
  assert.equal(result.ok, true);
  assert.equal(inventoryCalls, 0);
  assert.equal(restarts, 0);
});

test("verification rechecks the exact active auth snapshot before storing a receipt", async (t) => {
  let setup;
  setup = fixture({
    inventory: async () => {
      fs.writeFileSync(setup.paths.authFile, auth("rotated", "account-current"), { mode: 0o600 });
      return requiredInventory();
    },
  });
  disposeFixture(t, setup);
  const result = await setup.service.handle({ action: "plugin-protection-verify-current" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "plugin-protection-account-changed");
  assert.equal(setup.store.has("remote-plugin-receipts-v1"), false);
});

test("verification is serialized ahead of a queued switch, so its receipt binds the account it reconciled", async (t) => {
  let releaseInventory;
  const setup = fixture({ inventory: () => new Promise((resolve) => { releaseInventory = resolve; }) });
  disposeFixture(t, setup);
  const list = await setup.service.handle({ action: "list" });
  const prepared = await setup.service.handle({ action: "prepare-switch", ref: list.accounts[0].ref });
  const verifying = setup.service.handle({ action: "plugin-protection-verify-current" });
  const switching = setup.service.handle({ action: "switch", intent: prepared.intent });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseInventory, "function");
  releaseInventory(requiredInventory());
  assert.equal((await verifying).ok, true);
  assert.equal((await switching).ok, true);
  assert.equal(setup.store.get("remote-plugin-receipts-v1").receipts["account-current"].accountId, "account-current");
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.authFile)).tokens.account_id, "account-work");
});

test("inventory probe enables the experimental API and rejects PATH binary discovery", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /experimentalApi: true/);
  assert.doesNotMatch(source, /\["codex"\]/);
  assert.doesNotMatch(source, /CODEX_BIN|\/Applications\/ChatGPT/);
  assert.match(source, /info\?\.resourcesPath/);
  assert.doesNotMatch(source, /remotePluginId.*\$\{/);
});

test("legacy analytics cleanup neutralizes only the exact trusted fixture through stable descriptors", (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const legacyDir = path.join(setup.root, "Library", "Application Support", "codex-plusplus");
  const legacyFile = path.join(legacyDir, "account-analytics.v1.json");
  const unrelatedFile = path.join(legacyDir, "unrelated-state.json");
  const codexHomeLookalike = path.join(setup.paths.codexDir, "account-analytics.v1.json");
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  // Owner-write only proves the helper does not need to read the legacy bytes.
  fs.writeFileSync(legacyFile, "opaque legacy bytes", { mode: 0o200 });
  fs.writeFileSync(unrelatedFile, "keep", { mode: 0o600 });
  fs.writeFileSync(codexHomeLookalike, "keep", { mode: 0o600 });
  const before = fs.lstatSync(legacyFile);

  _test.cleanupLegacyAnalytics(setup.deps);

  const after = fs.lstatSync(legacyFile);
  assert.equal(after.ino, before.ino, "the exact opened inode remains in place");
  assert.equal(after.size, 0, "only its retained analytics bytes are neutralized");
  assert.equal(fs.readFileSync(unrelatedFile, "utf8"), "keep");
  assert.equal(fs.readFileSync(codexHomeLookalike, "utf8"), "keep");
});

test("legacy analytics cleanup is nonfatal and leaves its fixture unchanged when the helper is unavailable", (t) => {
  const setup = fixture({ spawnSync() { throw new Error("helper unavailable"); } });
  disposeFixture(t, setup);
  const legacyDir = path.join(setup.root, "Library", "Application Support", "codex-plusplus");
  const legacyFile = path.join(legacyDir, "account-analytics.v1.json");
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyFile, "opaque legacy bytes", { mode: 0o600 });
  const before = fs.lstatSync(legacyFile);

  assert.doesNotThrow(() => _test.cleanupLegacyAnalytics(setup.deps));

  const after = fs.lstatSync(legacyFile);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
});

test("legacy analytics cleanup refuses unsafe temporary-fixture ancestors and targets", (t) => {
  for (const kind of [
    "missing",
    "symlinked-ancestor",
    "permissive-home-root",
    "permissive-ancestor",
    "symlink",
    "hardlink",
    "directory",
    "permissive-target",
  ]) {
    const setup = fixture();
    disposeFixture(t, setup);
    const libraryDir = path.join(setup.root, "Library");
    const applicationSupportDir = path.join(libraryDir, "Application Support");
    const legacyDir = path.join(applicationSupportDir, "codex-plusplus");
    const legacyFile = path.join(legacyDir, "account-analytics.v1.json");
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-outside-"));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const outsideFile = path.join(outsideRoot, "account-analytics.v1.json");
    const originalSize = Buffer.byteLength("opaque legacy bytes");

    if (kind === "symlinked-ancestor") {
      fs.mkdirSync(path.join(outsideRoot, "Application Support", "codex-plusplus"), { recursive: true, mode: 0o700 });
      const redirectedFile = path.join(outsideRoot, "Application Support", "codex-plusplus", "account-analytics.v1.json");
      fs.writeFileSync(redirectedFile, "opaque legacy bytes", { mode: 0o600 });
      fs.symlinkSync(outsideRoot, libraryDir);
      assert.equal(fs.lstatSync(libraryDir).isSymbolicLink(), true, kind);
      assert.doesNotThrow(() => _test.cleanupLegacyAnalytics(setup.deps), kind);
      assert.equal(fs.statSync(redirectedFile).size, originalSize, kind);
      continue;
    }

    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    if (kind === "permissive-home-root") fs.chmodSync(setup.root, 0o777);
    if (kind === "permissive-ancestor") fs.chmodSync(applicationSupportDir, 0o777);
    if (kind === "symlink") {
      fs.writeFileSync(outsideFile, "opaque legacy bytes", { mode: 0o600 });
      fs.symlinkSync(outsideFile, legacyFile);
    } else if (kind === "hardlink") {
      fs.writeFileSync(outsideFile, "opaque legacy bytes", { mode: 0o600 });
      fs.linkSync(outsideFile, legacyFile);
    } else if (kind === "directory") {
      fs.mkdirSync(legacyFile, { mode: 0o700 });
    } else if (kind !== "missing") {
      fs.writeFileSync(legacyFile, "opaque legacy bytes", { mode: 0o600 });
    }
    if (kind === "permissive-target") fs.chmodSync(legacyFile, 0o666);

    assert.doesNotThrow(() => _test.cleanupLegacyAnalytics(setup.deps), kind);
    if (kind === "missing" || kind === "directory") {
      assert.equal(fs.existsSync(legacyFile), kind === "directory", kind);
    } else if (kind === "symlink" || kind === "hardlink") {
      assert.equal(fs.statSync(outsideFile).size, originalSize, kind);
    } else {
      assert.equal(fs.statSync(legacyFile).size, originalSize, kind);
    }
  }
});

test("legacy analytics cleanup source structurally binds ancestor and target races to opened descriptors", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const helper = source.match(/const LEGACY_ANALYTICS_NEUTRALIZER = String\.raw`([\s\S]*?)`;/)?.[1];
  const cleanupStart = source.indexOf("function cleanupLegacyAnalytics(deps)");
  const cleanupEnd = source.indexOf("\nfunction stableRef", cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);

  assert.ok(helper, "the fixed helper must be embedded in source");
  assert.match(cleanup, /fs\.openSync\(homeDir, constants\.O_RDONLY \| constants\.O_DIRECTORY \| constants\.O_NOFOLLOW\)/);
  assert.match(cleanup, /spawnSync\("\/usr\/bin\/python3", \["-I", "-S", "-c", LEGACY_ANALYTICS_NEUTRALIZER\]/);
  assert.match(cleanup, /stdio: \["ignore", "ignore", "ignore", homeFd\]/);
  assert.match(cleanup, /timeout: 2_000/);
  assert.match(cleanup, /shell: false/);
  assert.doesNotMatch(cleanup, /\b(?:unlink|rename)(?:Sync)?\b/);
  assert.match(helper, /_home_fd = os\.open\("\.", _directory_flags, dir_fd=_root_fd\)/);
  assert.match(helper, /os\.open\(_component, _directory_flags, dir_fd=_current_fd\)/);
  assert.match(helper, /os\.open\("account-analytics\.v1\.json", _file_flags, dir_fd=_current_fd\)/);
  assert.match(helper, /_stat\.st_uid == uid/);
  assert.match(helper, /\(_stat\.st_mode & 0o022\) == 0/);
  assert.match(helper, /_target_stat = os\.fstat\(_target_fd\)/);
  assert.match(helper, /_target_stat\.st_uid != _uid/);
  assert.match(helper, /_target_stat\.st_nlink != 1/);
  assert.match(helper, /\(_target_stat\.st_mode & 0o077\) != 0/);
  assert.match(helper, /os\.ftruncate\(_target_fd, 0\)\n    os\.fsync\(_target_fd\)/);
  assert.equal((helper.match(/account-analytics\.v1\.json/g) || []).length, 1, "the target path is used only for its fd-relative open");
  assert.doesNotMatch(helper, /\bos\.(?:read|unlink|rename|remove|replace)\b/);
});

function fakeAccountMenu(name, options = {}) {
  const attrs = { role: options.role || "menu" };
  const children = options.children || [];
  const node = {
    name,
    dataset: {},
    children,
    parentElement: null,
    textContent: options.text || "Usage remaining Settings Log out",
    getBoundingClientRect: () => options.rect || { width: 420, height: 420, top: 80, left: 20, right: 440, bottom: 500 },
    getAttribute: (key) => attrs[key] || null,
    contains(other) { return other === node || children.some((child) => child.contains(other)); },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test("account-menu targeting selects one nested host menu and fails closed on ambiguity", (t) => {
  const previousWindow = global.window;
  global.window = { innerWidth: 1000, innerHeight: 1000 };
  t.after(() => { global.window = previousWindow; });

  const menu = fakeAccountMenu("account-menu", {
    role: "dialog",
    rect: { width: 430, height: 560, top: 120, left: 24, right: 454, bottom: 680 },
  });
  const sidePane = fakeAccountMenu("side-pane", {
    role: "menu",
    children: [menu],
    rect: { width: 480, height: 860, top: 0, left: 0, right: 480, bottom: 860 },
  });
  const otherMenu = fakeAccountMenu("other-menu", { role: "dialog" });

  assert.equal(_test.accountMenuTargetFromCandidates([sidePane, menu]), menu);
  assert.equal(_test.accountMenuTargetFromCandidates([menu, otherMenu]), null);
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.equal(source.includes("directAccountMenuCandidates"), false);
});

test("renderer uses one high-confidence host account menu, cleans up on ambiguity, and rejects stale deferred responses", async (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousClearTimeout = global.clearTimeout;
  const rendererKey = "__tweakersAccountRendererV1";
  const hadRenderer = Object.hasOwn(globalThis, rendererKey);
  const previousRenderer = globalThis[rendererKey];
  const timers = new Map();
  let timerId = 0;
  let hostListener;
  let hostDisconnects = 0;
  let unregisters = 0;
  let registeredPage;
  let openPageCalls = 0;
  let listCalls = 0;
  let deferNextList = false;
  let resolveDeferredList;
  const nodes = new Set();

  function element(tagName, options = {}) {
    const node = {
      tagName,
      dataset: {},
      children: [],
      parentElement: null,
      textContent: options.text || "",
      className: "",
      type: "",
      disabled: false,
      attrs: options.attrs || {},
      listeners: new Map(),
      getAttribute(key) { return this.attrs[key] || null; },
      setAttribute(key, value) { this.attrs[key] = value; },
      getBoundingClientRect() {
        return options.rect || { width: 420, height: 420, top: 80, left: 20, right: 440, bottom: 500 };
      },
      contains(other) { return other === this || this.children.some((child) => child.contains(other)); },
      append(...children) {
        for (const child of children) {
          child.remove?.();
          child.parentElement = this;
          this.children.push(child);
        }
      },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
          this.parentElement = null;
        }
      },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        this.append(...children);
      },
    };
    nodes.add(node);
    return node;
  }

  const menu = element("div", {
    text: "Usage remaining Settings Log out",
    attrs: { role: "menu" },
    rect: { width: 430, height: 560, top: 120, left: 24, right: 454, bottom: 680 },
  });
  const otherMenu = element("div", {
    text: "Usage remaining Settings Log out",
    attrs: { role: "dialog" },
    rect: { width: 430, height: 560, top: 120, left: 500, right: 930, bottom: 680 },
  });
  const fakeDocument = {
    documentElement: element("html"),
    createElement: (tagName) => element(tagName),
    querySelectorAll(selector) {
      if (selector === "[data-tweakers-account-switcher]") {
        return [...nodes].filter((node) => node.dataset.tweakersAccountSwitcher === "true" && node.parentElement);
      }
      return [];
    },
  };
  const fakeWindow = {
    innerWidth: 1000,
    innerHeight: 1000,
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    alert() {},
    confirm() { return false; },
    prompt() { return null; },
  };
  const flushTimers = async () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
    await Promise.resolve();
    await Promise.resolve();
  };

  global.window = fakeWindow;
  global.document = fakeDocument;
  global.clearTimeout = fakeWindow.clearTimeout;
  t.after(() => {
    if (hadRenderer) globalThis[rendererKey] = previousRenderer;
    else delete globalThis[rendererKey];
    global.window = previousWindow;
    global.document = previousDocument;
    global.clearTimeout = previousClearTimeout;
  });

  _test.startRenderer({
    ipc: {
      async invoke(channel, request) {
        assert.equal(channel, "accounts");
        if (request.action === "router-status") return { ok: true, router: { schemaVersion: 2, mode: "manual", policy: null, pending: null, restartRequired: false, degradedReason: null }, live: { state: "not_applicable", status: null } };
        assert.deepEqual(request, { action: "list" });
        listCalls += 1;
        if (deferNextList) {
          deferNextList = false;
          return new Promise((resolve) => { resolveDeferredList = resolve; });
        }
        return { ok: true, accounts: [] };
      },
    },
    react: {
      host: {
        observe(kinds, listener) {
          assert.deepEqual(kinds, ["account-menu"]);
          hostListener = listener;
          return () => { hostDisconnects += 1; };
        },
      },
    },
    settings: {
      registerPage(page) {
        registeredPage = page;
        return { unregister() { unregisters += 1; } };
      },
      async openPage(pageId) {
        assert.equal(pageId, "accounts");
        openPageCalls += 1;
        return { ok: true };
      },
    },
  });

  assert.equal(registeredPage.id, "accounts");
  assert.equal(registeredPage.title, "Accounts");
  assert.equal(typeof registeredPage.render, "function");

  hostListener([{ kind: "account-menu", count: 1, matches: [{ kind: "account-menu", confidence: "high", element: menu }] }]);
  await flushTimers();
  assert.equal(menu.children.filter((child) => child.dataset.tweakersAccountSwitcher === "true").length, 1);
  assert.equal(listCalls, 1);
  const panel = menu.children.find((child) => child.dataset.tweakersAccountSwitcher === "true");
  const manageAccounts = panel.children.find((child) => child.textContent === "Manage accounts");
  assert.equal(manageAccounts.attrs["aria-label"], "Manage accounts settings");
  await manageAccounts.listeners.get("click")();
  assert.equal(openPageCalls, 1);

  hostListener([{
    kind: "account-menu",
    count: 2,
    matches: [
      { kind: "account-menu", confidence: "high", element: menu },
      { kind: "account-menu", confidence: "high", element: otherMenu },
    ],
  }]);
  await flushTimers();
  assert.equal(menu.children.filter((child) => child.dataset.tweakersAccountSwitcher === "true").length, 0);
  assert.equal(listCalls, 1);

  deferNextList = true;
  hostListener([{ kind: "account-menu", count: 1, matches: [{ kind: "account-menu", confidence: "high", element: menu }] }]);
  await flushTimers();
  assert.equal(listCalls, 2);
  assert.equal(menu.children.filter((child) => child.dataset.tweakersAccountSwitcher === "true").length, 0);

  hostListener([{
    kind: "account-menu",
    count: 2,
    matches: [
      { kind: "account-menu", confidence: "high", element: menu },
      { kind: "account-menu", confidence: "high", element: otherMenu },
    ],
  }]);
  await flushTimers();
  assert.equal(typeof resolveDeferredList, "function");
  resolveDeferredList({ ok: true, accounts: [] });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(menu.children.filter((child) => child.dataset.tweakersAccountSwitcher === "true").length, 0);

  tweak.stop();
  assert.equal(hostDisconnects, 1);
  assert.equal(unregisters, 1);
});

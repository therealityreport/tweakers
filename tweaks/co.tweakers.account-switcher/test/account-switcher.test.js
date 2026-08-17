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
  const resourcesPath = path.join(root, "runtime-resources");
  fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(resourcesPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(resourcesPath, "codex"), "test executable", { mode: 0o700 });
  if (!options.withoutAccountsDirectory) fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const paths = {
    codexDir,
    accountsDir,
    authFile: path.join(codexDir, "auth.json"),
    currentMarker: path.join(codexDir, "current_account"),
    lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json"),
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
  assert.match(source, /root\.append\(status, save, card\)/);
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

test("account labels use the saved ChatGPT identity without exposing tokens", () => {
  const token = "x." + Buffer.from(JSON.stringify({ name: "Tweakers", email: "tweakers@example.com" })).toString("base64url") + ".x";
  assert.equal(_test.displayLabelFromAuth({ auth_mode: "chatgpt", tokens: { id_token: token } }, "fallback"), "tweakers@example.com");
  assert.equal(_test.displayLabelFromAuth({
    user: { name: "Codex", email: "codex@thereality.report" },
  }, "fallback"), "codex@thereality.report");
  assert.equal(_test.displayLabelFromAuth({
    user: { name: "Safe Account", email: "sk-proj-SECRET_CANARY" },
  }, "fallback"), "Safe Account");
  assert.equal(_test.displayLabelFromAuth({
    user: { email: "Bearer SECRET_CANARY" },
  }, "sk-proj-SECRET_CANARY"), "Saved account");
  assert.equal(_test.displayLabelFromAuth({}, "Work Account"), "Work Account");
});

test("active snapshot sync propagates rotated tokens only for the same account", (t) => {
  const setup = fixture();
  disposeFixture(t, setup);
  const target = path.join(setup.paths.accountsDir, "work.json");

  fs.writeFileSync(target, auth("stale", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(setup.paths.authFile, auth("rotated", "acct-1"), { mode: 0o600 });
  fs.writeFileSync(setup.paths.currentMarker, "work.json\n", { mode: 0o600 });
  _test.syncActiveSnapshot(setup.deps, setup.paths);
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated");

  fs.writeFileSync(setup.paths.authFile, auth("other-login", "acct-2"), { mode: 0o600 });
  _test.syncActiveSnapshot(setup.deps, setup.paths);
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated");

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
  assert.equal(JSON.parse(fs.readFileSync(target)).tokens.access_token, "rotated");
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

test("account metadata declares the settings surface and has a synchronized patch version", () => {
  const tweakRoot = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(tweakRoot, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(tweakRoot, "package.json"), "utf8"));

  assert.equal(manifest.version, "0.1.10");
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.permissions.includes("settings"), true);
  assert.match(fs.readFileSync(path.join(tweakRoot, "index.js"), "utf8"), /api\.settings\?\.registerPage/);
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
      registerPage() {
        return { unregister() { unregisters += 1; } };
      },
    },
  });

  hostListener([{ kind: "account-menu", count: 1, matches: [{ kind: "account-menu", confidence: "high", element: menu }] }]);
  await flushTimers();
  assert.equal(menu.children.filter((child) => child.dataset.tweakersAccountSwitcher === "true").length, 1);
  assert.equal(listCalls, 1);

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

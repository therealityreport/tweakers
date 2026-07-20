"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { _test } = require("../index.js");

function auth(value) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: value,
      refresh_token: `refresh-${value}`,
      id_token: `id-${value}`,
      account_id: `account-${value}`,
    },
  });
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweakers-account-"));
  const codexDir = path.join(root, ".codex");
  const accountsDir = path.join(codexDir, "auth_accounts");
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const projectionDir = path.join(root, "Library", "Application Support", "codex-plusplus");
  const paths = {
    codexDir,
    accountsDir,
    authFile: path.join(codexDir, "auth.json"),
    currentMarker: path.join(codexDir, "current_account"),
    lkgFile: path.join(codexDir, "auth.account-switcher-lkg.json"),
    projectionDir,
    projectionFile: path.join(projectionDir, "account-analytics.v1.json"),
  };
  fs.writeFileSync(paths.authFile, auth("current"), { mode: 0o600 });
  fs.writeFileSync(path.join(accountsDir, "work.json"), auth("work"), { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "missing.json\n", { mode: 0o600 });
  const deps = { fs: options.fs || fs, path, homedir: () => root, randomUUID: crypto.randomUUID, now: options.now || Date.now };
  const log = options.log || { info() {}, warn() {} };
  const service = _test.createAccountService({ log }, { deps, paths, onSwitched: options.onSwitched });
  return { root, paths, service, deps, log };
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
  const live = JSON.parse(auth("current"));
  live.tokens.account_id = "account-work";
  fs.writeFileSync(paths.authFile, JSON.stringify(live), { mode: 0o600 });
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
  const projectionPath = path.join(root, "Library", "Application Support", "codex-plusplus", "account-analytics.v1.json");
  const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  const priorKey = _test.accountKeyFromAuth(JSON.parse(session("account-2-refreshed", "acct-2")));
  const nextKey = _test.accountKeyFromAuth(JSON.parse(session("account-3", "acct-3")));
  assert.equal(projection.epochs.find((epoch) => epoch.accountKey === priorKey).endedAt !== null, true);
  assert.equal(projection.epochs.at(-1).accountKey, nextKey);
  assert.equal(projection.epochs.at(-1).source, "confirmed-switch");
  assert.equal(projection.epochs.at(-1).endedAt, null);
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
  assert.equal(withHome.projectionFile, path.join("/home/whoever", "Library", "Application Support", "codex-plusplus", "account-analytics.v1.json"));

  const fallback = _test.authPaths({ path, homedir: () => "/home/whoever", codexHome: null });
  assert.equal(fallback.codexDir, path.join("/home/whoever", ".codex"));
});

test("account labels use the saved ChatGPT identity without exposing tokens", () => {
  const token = `x.${Buffer.from(JSON.stringify({ name: "Tweakers", email: "tweakers@example.com" })).toString("base64url")}.x`;
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

test("startup publishes only safe labels and a forward observation boundary", (t) => {
  const observedAt = Date.parse("2026-07-19T14:00:00.000Z");
  const { root, paths, service } = fixture({ now: () => observedAt });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const namedAuth = (label, accountId, canary) => JSON.stringify({
    auth_mode: "chatgpt",
    user: { name: label },
    tokens: {
      access_token: `access-${canary}`,
      refresh_token: `refresh-${canary}`,
      id_token: `id-${canary}`,
      account_id: accountId,
      unexpected_secret: canary,
    },
  });
  fs.writeFileSync(path.join(paths.accountsDir, "work.json"), namedAuth("Work", "raw-account-work", "SECRET_CANARY_WORK"), { mode: 0o600 });
  fs.writeFileSync(path.join(paths.accountsDir, "personal.json"), namedAuth("Personal", "raw-account-personal", "SECRET_CANARY_PERSONAL"), { mode: 0o600 });
  fs.writeFileSync(paths.authFile, namedAuth("Work", "raw-account-work", "SECRET_CANARY_LIVE"), { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "work.json\n", { mode: 0o600 });

  const result = service.observeStartup();
  assert.equal(result.ok, true);
  const projection = JSON.parse(fs.readFileSync(paths.projectionFile, "utf8"));
  assert.equal(projection.version, 1);
  assert.deepEqual(
    projection.accounts
      .filter((account) => ["Personal", "Work"].includes(account.label))
      .map((account) => account.label)
      .sort(),
    ["Personal", "Work"],
  );
  assert.equal(projection.accounts.filter((account) => account.active).length, 1);
  assert.deepEqual(projection.epochs, [{
    accountKey: projection.accounts.find((account) => account.label === "Work").accountKey,
    startedAt: "2026-07-19T14:00:00.000Z",
    endedAt: null,
    source: "startup-observation",
  }]);
  assert.equal(fs.statSync(paths.projectionFile).mode & 0o777, 0o600);
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["raw-account", "SECRET_CANARY", "access_token", "refresh_token", "id_token", "cookie", paths.authFile]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("startup refuses a stale marker whose saved account does not match live auth", async (t) => {
  const observedAt = Date.parse("2026-07-19T14:30:00.000Z");
  const { root, paths, service } = fixture({ now: () => observedAt });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const withAccount = (email, accountId) => JSON.stringify({
    auth_mode: "chatgpt",
    user: { email },
    tokens: {
      access_token: `access-${accountId}`,
      refresh_token: `refresh-${accountId}`,
      id_token: `id-${accountId}`,
      account_id: accountId,
    },
  });
  fs.writeFileSync(path.join(paths.accountsDir, "work.json"), withAccount("codex@thereality.report", "account-codex"), { mode: 0o600 });
  fs.writeFileSync(paths.authFile, withAccount("admin@thereality.report", "account-admin"), { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "work.json\n", { mode: 0o600 });

  const list = await service.list();
  assert.equal(list.accounts.some((account) => account.active), false);
  assert.equal(list.markerStatus, "identity-mismatch");
  assert.equal(service.observeStartup().ok, true);
  const projection = JSON.parse(fs.readFileSync(paths.projectionFile, "utf8"));
  assert.equal(projection.accounts.some((account) => account.active), false);
  assert.equal(projection.epochs.some((epoch) => epoch.endedAt === null), false);
});

test("projection identity follows the OpenAI account, not the saved filename", (t) => {
  let observedAt = Date.parse("2026-07-19T15:00:00.000Z");
  const { root, paths, service, deps } = fixture({ now: () => observedAt });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const withAccount = (email, accountId) => JSON.stringify({
    auth_mode: "chatgpt",
    user: { email },
    tokens: {
      access_token: `access-${accountId}`,
      refresh_token: `refresh-${accountId}`,
      id_token: `id-${accountId}`,
      account_id: accountId,
    },
  });
  const shared = withAccount("codex@thereality.report", "account-codex");
  fs.writeFileSync(path.join(paths.accountsDir, "alpha.json"), shared, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.accountsDir, "beta.json"), shared, { mode: 0o600 });
  fs.writeFileSync(paths.authFile, shared, { mode: 0o600 });
  fs.writeFileSync(paths.currentMarker, "alpha.json\n", { mode: 0o600 });
  assert.equal(service.observeStartup().ok, true);

  let projection = JSON.parse(fs.readFileSync(paths.projectionFile, "utf8"));
  const originalKey = _test.accountKeyFromAuth(JSON.parse(shared));
  assert.equal(projection.accounts.filter((account) => account.accountKey === originalKey).length, 1);
  assert.equal(projection.accounts.find((account) => account.accountKey === originalKey).active, true);

  projection.epochs = projection.epochs.map((epoch) => (
    epoch.accountKey === originalKey ? { ...epoch, endedAt: "2026-07-19T15:05:00.000Z" } : epoch
  ));
  projection.revision += 1;
  projection.updatedAt = "2026-07-19T15:05:00.000Z";
  _test.writeAccountProjection(deps, paths, projection);

  observedAt = Date.parse("2026-07-19T15:10:00.000Z");
  const replacement = withAccount("admin@thereality.report", "account-admin");
  fs.writeFileSync(path.join(paths.accountsDir, "alpha.json"), replacement, { mode: 0o600 });
  fs.writeFileSync(paths.authFile, replacement, { mode: 0o600 });
  assert.equal(service.observeStartup().ok, true);
  projection = JSON.parse(fs.readFileSync(paths.projectionFile, "utf8"));
  const replacementKey = _test.accountKeyFromAuth(JSON.parse(replacement));
  assert.notEqual(replacementKey, originalKey);
  assert.equal(projection.accounts.find((account) => account.accountKey === originalKey).label, "codex@thereality.report");
  assert.equal(projection.accounts.find((account) => account.accountKey === replacementKey).active, true);
  assert.equal(projection.epochs.some((epoch) => epoch.accountKey === originalKey && epoch.endedAt !== null), true);
});

test("successful switch publishes the confirmed boundary before restart scheduling", async (t) => {
  let setup;
  let restartObservation;
  setup = fixture({
    now: () => Date.parse("2026-07-19T15:00:00.000Z"),
    onSwitched: () => {
      restartObservation = {
        marker: fs.readFileSync(setup.paths.currentMarker, "utf8"),
        projection: JSON.parse(fs.readFileSync(setup.paths.projectionFile, "utf8")),
      };
      return true;
    },
  });
  const { root, service } = setup;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const list = await service.list();
  const prepared = await service.prepareSwitch(list.accounts[0].ref);
  const result = await service.switch(prepared.intent);

  assert.equal(result.ok, true);
  assert.equal(result.restartScheduled, true);
  assert.equal(restartObservation.marker, "work.json\n");
  assert.equal(restartObservation.projection.epochs.at(-1).source, "confirmed-switch");
  assert.equal(restartObservation.projection.epochs.at(-1).endedAt, null);
  assert.equal(restartObservation.projection.accounts.find((account) => account.active).label, "work");
});

test("projection failure never rolls back a safe switch and invalidates stale epochs", async (t) => {
  let failProjectionRename = false;
  const warnings = [];
  const guardedFs = Object.create(fs);
  guardedFs.renameSync = (from, to) => {
    if (failProjectionRename && to.endsWith("account-analytics.v1.json")) throw Object.assign(new Error("SECRET_CANARY_PATH /private/auth.json"), { code: "EIO" });
    return fs.renameSync(from, to);
  };
  const setup = fixture({ fs: guardedFs, log: { info() {}, warn(...args) { warnings.push(args); } } });
  const { root, paths, service } = setup;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = _test.readAccountProjection(setup.deps, paths);
  before.epochs.push({ accountKey: before.accounts[0].accountKey, startedAt: "2026-07-19T10:00:00.000Z", endedAt: null, source: "startup-observation" });
  _test.writeAccountProjection(setup.deps, paths, before);
  failProjectionRename = true;

  const list = await service.list();
  const prepared = await service.prepareSwitch(list.accounts[0].ref);
  const result = await service.switch(prepared.intent);

  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(paths.authFile)).tokens.access_token, "work");
  assert.equal(fs.readFileSync(paths.currentMarker, "utf8"), "work.json\n");
  assert.equal(fs.existsSync(paths.projectionFile), false, "stale open epoch is removed after failed replacement");
  const warningText = JSON.stringify(warnings);
  assert.equal(warningText.includes("SECRET_CANARY"), false);
  assert.equal(warningText.includes("/private"), false);
  assert.match(warningText, /projection-update-failed/);
});

test("malformed projection is not trusted and cannot block switching", async (t) => {
  const warnings = [];
  const { root, paths, service } = fixture({ log: { info() {}, warn(...args) { warnings.push(args); } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(paths.projectionFile, JSON.stringify({ version: 1, access_token: "SECRET_CANARY" }), { mode: 0o600 });
  const list = await service.list();
  const prepared = await service.prepareSwitch(list.accounts[0].ref);
  const result = await service.switch(prepared.intent);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(paths.projectionFile), false);
  assert.equal(JSON.stringify(warnings).includes("SECRET_CANARY"), false);
});

test("auth rollback completes before projection work begins", async (t) => {
  let failMarkerOnce = false;
  const guardedFs = Object.create(fs);
  guardedFs.renameSync = (from, to) => {
    if (failMarkerOnce && to.endsWith("current_account")) {
      failMarkerOnce = false;
      throw Object.assign(new Error("marker write failed"), { code: "EIO" });
    }
    return fs.renameSync(from, to);
  };
  const setup = fixture({ fs: guardedFs });
  const { root, paths, service } = setup;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = {
    auth: fs.readFileSync(paths.authFile),
    marker: fs.readFileSync(paths.currentMarker),
    projection: fs.readFileSync(paths.projectionFile),
  };
  const list = await service.list();
  const prepared = await service.prepareSwitch(list.accounts[0].ref);
  failMarkerOnce = true;
  const result = await service.switch(prepared.intent);
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(paths.authFile), before.auth);
  assert.deepEqual(fs.readFileSync(paths.currentMarker), before.marker);
  assert.deepEqual(fs.readFileSync(paths.projectionFile), before.projection);
});

test("projection helpers reject permissive files, symlinks, unknown fields, and excessive history", (t) => {
  const { root, paths, deps } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const valid = _test.readAccountProjection(deps, paths);

  fs.chmodSync(paths.projectionFile, 0o644);
  assert.throws(() => _test.readAccountProjection(deps, paths), /projection-invalid/);
  fs.chmodSync(paths.projectionFile, 0o600);
  const target = `${paths.projectionFile}.target`;
  fs.renameSync(paths.projectionFile, target);
  fs.symlinkSync(target, paths.projectionFile);
  assert.throws(() => _test.readAccountProjection(deps, paths), /projection-invalid/);
  fs.unlinkSync(paths.projectionFile);

  assert.throws(() => _test.writeAccountProjection(deps, paths, { ...valid, access_token: "SECRET_CANARY" }), /projection-invalid/);
  assert.throws(() => _test.writeAccountProjection(deps, paths, {
    ...valid,
    accounts: [{ ...valid.accounts[0], label: "sk-proj-SECRET_CANARY" }],
  }), /projection-invalid/);
  assert.throws(() => _test.writeAccountProjection(deps, paths, {
    ...valid,
    epochs: [{ accountKey: "acct_00000000000000000000000000000000", startedAt: "2026-07-19T10:00:00.000Z", endedAt: null, source: "startup-observation" }],
  }), /projection-invalid/);
  assert.throws(() => _test.writeAccountProjection(deps, paths, {
    ...valid,
    quotaSnapshots: [{
      accountKey: "acct_00000000000000000000000000000000",
      capturedAt: "2026-07-19T10:00:00.000Z",
      planType: "pro",
      primary: {},
      secondary: {},
    }],
  }), /projection-invalid/);
  assert.throws(() => _test.writeAccountProjection(deps, paths, {
    ...valid,
    epochs: Array.from({ length: _test.PROJECTION_LIMITS.maxEpochs + 1 }, () => ({
      accountKey: valid.accounts[0].accountKey,
      startedAt: "2026-07-19T10:00:00.000Z",
      endedAt: null,
      source: "startup-observation",
    })),
  }), /projection-invalid/);
});

test("projection replacement is atomic and rejects a symlinked parent", (t) => {
  let failRename = false;
  const guardedFs = Object.create(fs);
  guardedFs.renameSync = (from, to) => {
    if (failRename && to.endsWith("account-analytics.v1.json")) throw Object.assign(new Error("replace failed"), { code: "EIO" });
    return fs.renameSync(from, to);
  };
  const setup = fixture({ fs: guardedFs });
  const { root, paths, deps } = setup;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(paths.projectionFile);
  const next = _test.readAccountProjection(deps, paths);
  next.revision += 1;
  next.updatedAt = "2026-07-19T16:00:00.000Z";
  failRename = true;
  assert.throws(() => _test.writeAccountProjection(deps, paths, next), /projection-write-failed/);
  assert.deepEqual(fs.readFileSync(paths.projectionFile), before);

  failRename = false;
  const realDir = `${paths.projectionDir}-real`;
  fs.renameSync(paths.projectionDir, realDir);
  fs.symlinkSync(realDir, paths.projectionDir);
  assert.throws(() => _test.writeAccountProjection(deps, paths, next), /projection-untrusted/);
});

test("quota ingestion is not exposed without a trustworthy quota producer", async (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await service.handle({ action: "record-quota-snapshot", access_token: "SECRET_CANARY" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-request");
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

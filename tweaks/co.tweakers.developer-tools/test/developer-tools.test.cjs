const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tweak = require("../index.js");
const {
  parseConfig,
  scanConfig,
  scanSourceBounded,
  mergeCapabilities,
  setTomlValue,
  redact,
  createService,
  startMain,
} = tweak._test;

async function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-tools-"));
  try { return await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function serviceFixture(root, config = "[tools]\nenabled = true\n") {
  const home = path.join(root, "home");
  const configPath = path.join(home, ".codex", "config.toml");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  let clock = 1_700_000_000_000;
  const service = createService({
    fs: { dataDir },
    codex: {
      runtime: { getCapabilities() { return {}; } },
      settings: { async open() { return true; } },
    },
  }, {
    fs,
    fsPromises: fs.promises,
    path,
    os: { homedir: () => home },
    dataDir,
    configPath,
    modelPath: path.join(home, ".codex", "models.json"),
    checkout: path.join(dataDir, "source"),
    now: () => clock++,
  });
  return { service, configPath, dataDir, backupDir: path.join(dataDir, "backups") };
}

async function setEnabled(service, enabled) {
  const snapshot = await service.handle({ action: "getSnapshot" });
  assert.equal(snapshot.ok, true);
  const result = await service.handle({
    action: "setCapability",
    id: "tools.enabled",
    enabled,
    expectedRevision: snapshot.snapshot.revision,
    confirmed: false,
  });
  assert.equal(result.ok, true);
  return result;
}

test("routes CLI features out of Developer Tools and preserves non-CLI tool controls", () => {
  const text = `[features]\ndefault_mode_request_user_input = true\njs_repl = false\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 8\n[tools.request_user_input]\nenabled = true\n`;
  const caps = scanConfig(text, "/tmp/config.toml");
  assert.equal(caps.some((item) => item.id.startsWith("features.")), false);
  assert.equal(caps.find((item) => item.category === "Tools").name, "Enabled");
  assert.equal(caps.find((item) => item.category === "Tools").control.method, "config");
});

test("structured edits preserve unrelated comments and sections", () => {
  const text = `# keep me\nmodel = "gpt"\n\n[features]\n# feature note\nhooks = true\n\n[mcp_servers.example]\nenabled = true\n`;
  const next = setTomlValue(text, "features", "hooks", false);
  assert.match(next, /# keep me/); assert.match(next, /# feature note/); assert.match(next, /\[mcp_servers\.example\]\nenabled = true/);
  assert.equal(parseConfig(next).features.hooks, false);
});

test("feature values remain parseable but are excluded from the Developer Tools snapshot", () => {
  assert.equal(parseConfig("[features]\nhooks = true\n").features.hooks, true);
  assert.deepEqual(scanConfig("[features]\nhooks = true\n", "/tmp/config.toml"), []);
});

test("bounded source discovery yields partial results and honors cancellation", async () => {
  await withTempDir(async (root) => {
    fs.writeFileSync(path.join(root, "one.rs"), "Feature::Alpha\n");
    fs.writeFileSync(path.join(root, "two.rs"), "Feature::Beta\n");
    fs.writeFileSync(path.join(root, "three.rs"), "Feature::Gamma\n");
    const updates = [];
    const result = await scanSourceBounded(fs.promises, path, root, {
      fileLimit: 2,
      directoryLimit: 4,
      deadlineMs: 1_000,
      onProgress: (progress) => updates.push(progress),
    });
    assert.equal(result.status, "budget-exhausted");
    assert.equal(result.progress.filesScanned, 2);
    assert.ok(result.capabilities.length > 0);
    assert.ok(updates.some((progress) => progress.capabilityCount > 0));

    const controller = new AbortController();
    controller.abort();
    const cancelled = await scanSourceBounded(fs.promises, path, root, { signal: controller.signal });
    assert.equal(cancelled.status, "cancelled");
  });
});

test("private backup history is bounded, previews redact secrets, and destructive recovery is confirmed", async () => {
  await withTempDir(async (root) => {
    const { service, configPath, backupDir } = serviceFixture(root, "[tools]\nenabled = true\napi_key = \"do-not-show\"\n");
    const first = await setEnabled(service, false);
    const history = await service.handle({ action: "listBackups" });
    assert.equal(history.ok, true);
    assert.equal(history.backups.length, 1);
    assert.equal(Object.hasOwn(history.backups[0], "contents"), false);
    assert.equal(Object.hasOwn(history.backups[0], "file"), false);
    assert.equal(history.backups[0].label, "Configuration backup");
    assert.doesNotMatch(JSON.stringify(history), /config\.toml|developer-tools-/);

    const preview = await service.handle({ action: "getBackupPreview", backupId: first.backupId });
    assert.equal(preview.ok, true);
    assert.equal(Object.hasOwn(preview.backup, "file"), false);
    assert.doesNotMatch(JSON.stringify(preview), /config\.toml|developer-tools-/);
    assert.match(preview.backup.preview, /api_key = "\[redacted\]"/);
    assert.doesNotMatch(preview.backup.preview, /do-not-show/);

    for (const backupId of ["../escape", "/tmp/absolute", "..", "config.toml"]) {
      const rejected = await service.handle({ action: "getBackupPreview", backupId });
      assert.equal(rejected.error.code, "invalid-request");
    }

    const rejectedRestore = await service.handle({ action: "rollback", backupId: first.backupId, confirmed: false });
    const rejectedDelete = await service.handle({ action: "deleteBackup", backupId: first.backupId, confirmed: false });
    assert.equal(rejectedRestore.error.code, "confirmation-required");
    assert.equal(rejectedDelete.error.code, "confirmation-required");

    const restored = await service.handle({ action: "rollback", backupId: first.backupId, confirmed: true });
    assert.equal(restored.ok, true);
    assert.match(fs.readFileSync(configPath, "utf8"), /enabled = true/);
    const deleted = await service.handle({ action: "deleteBackup", backupId: first.backupId, confirmed: true });
    assert.equal(deleted.ok, true);

    for (let index = 0; index < 12; index += 1) await setEnabled(service, index % 2 === 0);
    const bounded = await service.handle({ action: "listBackups" });
    assert.equal(bounded.backups.length, 10);
    assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
    for (const entry of fs.readdirSync(backupDir)) assert.equal(fs.statSync(path.join(backupDir, entry)).mode & 0o777, 0o600);
  });
});

test("oversized directories obey the entry budget and yield while remaining cancellable", async () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({
    name: `ignored-${index}.txt`,
    isDirectory: () => false,
    isFile: () => false,
  }));
  const controller = new AbortController();
  let yields = 0;
  const result = await scanSourceBounded({
    async readdir() { return entries; },
  }, path, "/source", {
    signal: controller.signal,
    entryLimit: 96,
    onProgress(progress) {
      if (progress.entriesVisited > 0 && progress.entriesVisited % 32 === 0) {
        yields += 1;
        if (yields === 3) controller.abort();
      }
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.progress.entriesVisited, 96);
  assert.equal(yields, 3);
  assert.equal(result.capabilities.length, 0);
});

test("privileged service fails closed without a sender-validated context", async () => {
  await withTempDir(async (root) => {
    const dataDir = path.join(root, "data");
    const home = path.join(root, "home");
    const configPath = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, "[tools]\nenabled = true\n", { mode: 0o600 });
    let handler = null;
    const openedFor = [];
    startMain({
      process: "main",
      fs: { dataDir },
      ipc: { handleWithContext(_channel, registered) { handler = registered; return () => {}; } },
      log: { info() {}, error() {} },
      codex: { settings: { async open(webContentsId) { openedFor.push(webContentsId); return true; } } },
    }, {
      fs,
      fsPromises: fs.promises,
      path,
      os: { homedir: () => home },
      dataDir,
      configPath,
      modelPath: path.join(home, ".codex", "models.json"),
      checkout: path.join(dataDir, "source"),
    });
    assert.equal(typeof handler, "function");
    const denied = await handler(null, { action: "listBackups" });
    assert.equal(denied.error.code, "unauthorized-sender");
    const accepted = await handler({ sender: { webContentsId: 77 } }, { action: "listBackups" });
    assert.equal(accepted.ok, true);
    const opened = await handler({ sender: { webContentsId: 77 } }, { action: "openSettings" });
    assert.equal(opened.ok, true);
    assert.deepEqual(openedFor, [77]);
    tweak.stop();
  });
});

test("renderer truthfully omits the unsupported defaults filter and uses owned actions", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.doesNotMatch(source, /Changed from default/);
  assert.match(source, /handleWithContext\(IPC/);
  assert.match(source, /getBackupPreview/);
  assert.match(source, /cancelSourceDiscovery/);
  assert.match(source, /SOURCE_DISCOVERY_TOTAL_TIMEOUT_MS/);
  assert.match(source, /sourceJobTimeout/);
  assert.match(source, /action: "openSettings"/);
  assert.doesNotMatch(source, /querySelectorAll\("button"\).*Config/);
});

test("duplicates retain evidence and secrets are redacted", () => {
  const base = scanConfig("[tools]\nrequest_user_input = true\n", "/a")[0];
  const other = { ...base, sources: [{ kind: "source", path: "b.rs", detail: "hooks" }] };
  assert.equal(mergeCapabilities([base, other])[0].sources.length, 2);
  assert.equal(redact({ token: "abc", nested: { api_key: "def" } }).token, "[redacted]");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadCommonJs } = require("./load-commonjs.cjs");
const {
  PRIVATE_SENTINELS,
  REVIEWED_BROWSER_CLIENT_SHA256S,
  browserConfig,
  codexConfig,
  makePolicyFixture,
  replaceLine,
  snapshotTree,
} = require("./policy-fixture.cjs");

const POLICY_PATH = path.resolve(__dirname, "../policy-state.js");
const REGISTRY_PATH = path.resolve(__dirname, "../trust-registry.js");

test("Preview is byte-read-only and its token binds both sources, modes, and registry", async (t) => {
  await t.test("no writes", async (t) => {
    const fixture = makePolicyFixture(t);
    const before = snapshotTree(fixture.root);
    const preview = await commandsFor(fixture).preview();

    assert.equal(preview.changed, true);
    assert.ok(preview.affectedFieldCount > 0);
    assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
    assert.match(preview.registryFingerprint, /^[a-f0-9]{64}$/);
    assert.match(preview.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(snapshotTree(fixture.root), before);
    assert.equal(fs.existsSync(fixture.dataDir), false);
  });

  await t.test("missing optional browser source stays missing", async (t) => {
    const fixture = makePolicyFixture(t);
    fs.unlinkSync(fixture.browserConfigPath);
    fs.rmdirSync(path.dirname(fixture.browserConfigPath));
    const before = snapshotTree(fixture.root);
    const preview = await commandsFor(fixture).preview();

    assert.equal(preview.changed, true);
    assert.equal(fs.existsSync(path.dirname(fixture.browserConfigPath)), false);
    assert.equal(fs.existsSync(fixture.browserConfigPath), false);
    assert.equal(fs.existsSync(fixture.dataDir), false);
    assert.deepEqual(snapshotTree(fixture.root), before);
  });

  for (const scenario of [
    {
      name: "Codex config bytes",
      mutate(fixture) { fs.appendFileSync(fixture.configPath, "# concurrent config edit\n"); },
    },
    {
      name: "browser config bytes",
      mutate(fixture) { fs.appendFileSync(fixture.browserConfigPath, "# concurrent browser edit\n"); },
    },
    {
      name: "Codex config mode",
      mutate(fixture) { fs.chmodSync(fixture.configPath, 0o600); },
    },
    {
      name: "browser config mode",
      mutate(fixture) { fs.chmodSync(fixture.browserConfigPath, 0o640); },
    },
  ]) {
    await t.test(`stale ${scenario.name}`, async (t) => {
      const fixture = makePolicyFixture(t);
      const commands = commandsFor(fixture);
      const preview = await commands.preview();
      scenario.mutate(fixture);
      const changed = snapshotTree(fixture.root);

      await assertPolicyError(() => commands.apply(preview.previewToken), /(?:PREVIEW|SOURCE|MODE).*(?:STALE|DRIFT)|STALE/i);
      assert.deepEqual(snapshotTree(fixture.root), changed);
      assert.equal(fs.existsSync(fixture.dataDir), false);
    });
  }

  await t.test("registry digest", async (t) => {
    const fixture = makePolicyFixture(t);
    const normal = loadPolicy();
    const preview = await commandsFor(fixture, {}, normal).preview();
    const registry = loadCommonJs(REGISTRY_PATH);
    const mutatedRegistry = {
      ...registry,
      registryDigest: () => "0".repeat(64),
    };
    const changedPolicy = loadPolicy({
      "./trust-registry": mutatedRegistry,
      "./trust-registry.js": mutatedRegistry,
    });

    await assertPolicyError(
      () => commandsFor(fixture, {}, changedPolicy).apply(preview.previewToken),
      /(?:PREVIEW|REGISTRY).*(?:STALE|DRIFT)|STALE/i,
    );
    assert.equal(fs.existsSync(fixture.dataDir), false);
  });
});

test("User Questions compatibility is mandatory and byte-preserved through Apply and Restore", async (t) => {
  await t.test("mcp_elicitations true", async (t) => {
    const fixture = makePolicyFixture(t);
    const expectedLine = codexConfig().split("\n").find((line) => line.startsWith("approval_policy = "));
    const commands = commandsFor(fixture);
    const preview = await commands.preview();
    const applied = await commands.apply(preview.previewToken);

    assert.equal(findLine(fs.readFileSync(fixture.configPath, "utf8"), "approval_policy = "), expectedLine);
    assert.equal(applied.restarted, false);
    const restored = await commands.restore(applied.transactionId);
    assert.equal(findLine(fs.readFileSync(fixture.configPath, "utf8"), "approval_policy = "), expectedLine);
    assert.equal(restored.restarted, false);
    assert.match(fs.readFileSync(fixture.configPath, "utf8"), /\[unrelated\.keep_me\]\nvalue = "unchanged"/);
    assert.match(fs.readFileSync(fixture.browserConfigPath, "utf8"), /\[unrelated\.keep_me\]\nvalue = "unchanged"/);
  });

  for (const value of ["false", "missing"]) {
    await t.test(`mcp_elicitations ${value}`, async (t) => {
      const fixture = makePolicyFixture(t, { userQuestionsPolicy: value });
      const before = snapshotTree(fixture.root);
      await assertPolicyError(() => commandsFor(fixture).preview(), /POLICY_BLOCKED|MCP_ELICITATIONS/i);
      assert.deepEqual(snapshotTree(fixture.root), before);
      assert.equal(fs.existsSync(fixture.dataDir), false);
    });
  }
});

test("Preview rejects duplicate target tables and duplicate owned keys without writing", async (t) => {
  const cases = [
    {
      name: "duplicate Chrome table",
      configText: `${codexConfig()}\n[mcp_servers.chrome-devtools]\ndefault_tools_approval_mode = "approve"\n`,
    },
    {
      name: "duplicate Chrome key",
      configText: codexConfig().replace(
        'default_tools_approval_mode = "approve"\nstartup_timeout_sec',
        'default_tools_approval_mode = "approve"\ndefault_tools_approval_mode = "prompt"\nstartup_timeout_sec',
      ),
    },
    {
      name: "duplicate browser key",
      browserText: browserConfig().replace(
        'approval_mode = "never_ask"\n',
        'approval_mode = "never_ask"\napproval_mode = "always_ask"\n',
      ),
    },
    {
      name: "unknown field in owned tool table",
      configText: codexConfig().replace(
        '[mcp_servers.chrome-devtools.tools.navigate_page]\napproval_mode = "approve"',
        '[mcp_servers.chrome-devtools.tools.navigate_page]\napproval_mode = "approve"\nunknown_future_field = "unsafe"',
      ),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = makePolicyFixture(t, scenario);
      const before = snapshotTree(fixture.root);
      await assertPolicyError(() => commandsFor(fixture).preview(), /DUPLICATE|SCHEMA_DRIFT|UNSUPPORTED_PROJECTION/i);
      assert.deepEqual(snapshotTree(fixture.root), before);
      assert.equal(fs.existsSync(fixture.dataDir), false);
    });
  }
});

test("Apply writes only the frozen projections, private transaction artifacts, and no restart", async (t) => {
  const fixture = makePolicyFixture(t);
  let restartCalls = 0;
  const commands = commandsFor(fixture, {
    restart() { restartCalls += 1; },
    restartApp() { restartCalls += 1; },
  });
  const preview = await commands.preview();
  const applied = await commands.apply(preview.previewToken);
  const config = fs.readFileSync(fixture.configPath, "utf8");
  const browser = fs.readFileSync(fixture.browserConfigPath, "utf8");

  assert.equal(applied.changed, true);
  assert.equal(applied.restartRequired, true);
  assert.equal(applied.restarted, false);
  assert.equal(restartCalls, 0);
  assert.match(config, /\[mcp_servers\.chrome-devtools\][\s\S]*?default_tools_approval_mode = "prompt"/);
  assert.equal(extractApprovedTools(config, "mcp_servers.chrome-devtools").size, 6);
  for (const name of [
    "navigate_page",
    "new_page",
    "get_network_request",
    "take_snapshot",
    "take_screenshot",
    "evaluate_script",
    "click",
    "upload_file",
    "select_page",
  ]) {
    assert.equal(extractApprovedTools(config, "mcp_servers.chrome-devtools").has(name), false);
  }
  assert.match(
    config,
    /\[plugins\."infographic-docs@local-plugins"\.mcp_servers\.infographic-preview-playwright\][\s\S]*?default_tools_approval_mode = "prompt"/,
  );
  assert.equal(
    extractApprovedTools(
      config,
      'plugins."infographic-docs@local-plugins".mcp_servers.infographic-preview-playwright',
    ).size,
    0,
  );
  assert.equal(config.includes(REVIEWED_BROWSER_CLIENT_SHA256S.join(",")), true);
  assert.match(config, /# Browser Trust test fixture\. Preserve this comment exactly\./);
  assert.match(config, /\[unrelated\.keep_me\]\nvalue = "unchanged"/);

  assert.match(browser, /^approval_mode = "never_ask"$/m);
  assert.match(browser, /^history_approval_mode = "never_ask"$/m);
  assert.match(browser, /^download_approval_mode = "always_ask"$/m);
  assert.match(browser, /^upload_approval_mode = "always_ask"$/m);
  assert.match(browser, /^full_cdp_access_enabled = false$/m);
  assert.match(browser, /https:\/\/github\.com/);
  assert.match(browser, /https:\/\/thb\.localhost/);
  assert.match(browser, /https:\/\/admin\.thb\.localhost/);
  assert.match(browser, /# Browser plugin test fixture\. Preserve this comment exactly\./);
  assert.match(browser, /unrelated_browser_setting = "unchanged"/);
  assertPrivateTransactionTree(fixture.dataDir);

  const firstTree = snapshotTree(fixture.dataDir);
  const repeated = await commands.apply(preview.previewToken);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.transactionId, applied.transactionId);
  assert.equal(repeated.restarted, false);
  assert.deepEqual(snapshotTree(fixture.dataDir), firstTree);
});

test("Apply rolls the first source back atomically when the second source write fails", async (t) => {
  const fixture = makePolicyFixture(t);
  const originalConfig = fs.readFileSync(fixture.configPath);
  const originalBrowser = fs.readFileSync(fixture.browserConfigPath);
  const originalConfigMode = fs.statSync(fixture.configPath).mode & 0o777;
  const originalBrowserMode = fs.statSync(fixture.browserConfigPath).mode & 0o777;
  let injected = false;
  const commands = commandsFor(fixture, {
    hook(stage) {
      if (stage !== "apply.browser.before-rename" || injected) return;
      injected = true;
      const error = new Error(`injected ${PRIVATE_SENTINELS.toolArguments}`);
      error.code = "EIO";
      throw error;
    },
  });
  const preview = await commands.preview();
  const failure = await commands.apply(preview.previewToken);

  assert.equal(injected, true);
  assert.equal(failure.changed, false);
  assert.equal(failure.errorCode, "apply_failed");
  assert.equal(failure.restarted, false);
  assertPublicRedacted(failure, fixture);
  assert.deepEqual(fs.readFileSync(fixture.configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(fixture.browserConfigPath), originalBrowser);
  assert.equal(fs.statSync(fixture.configPath).mode & 0o777, originalConfigMode);
  assert.equal(fs.statSync(fixture.browserConfigPath).mode & 0o777, originalBrowserMode);
  assertPrivateTransactionTree(fixture.dataDir);
});

test("Restore rolls both published sources back when receipt commit fails, then remains retryable", async (t) => {
  const fixture = makePolicyFixture(t);
  const initial = commandsFor(fixture);
  const preview = await initial.preview();
  const applied = await initial.apply(preview.previewToken);
  const appliedSnapshot = snapshotTree(fixture.root);
  let injected = false;
  const failingRestore = commandsFor(fixture, {
    hook(stage) {
      if (stage !== "restore.receipt-commit.before-rename" || injected) return;
      injected = true;
      const error = new Error(`injected ${PRIVATE_SENTINELS.credential}`);
      error.code = "EIO";
      throw error;
    },
  });

  const failure = await failingRestore.restore(applied.transactionId);
  assert.equal(injected, true);
  assert.equal(failure.errorCode, "restore_failed");
  assert.equal(failure.changed, false);
  assert.equal(failure.restarted, false);
  assertPublicRedacted(failure, fixture);
  assert.deepEqual(snapshotTree(fixture.root), appliedSnapshot);
  assertPrivateTransactionTree(fixture.dataDir);

  const restored = await commandsFor(fixture).restore(applied.transactionId);
  assert.equal(restored.changed, true);
  assert.equal(restored.restarted, false);
  assertPrivateTransactionTree(fixture.dataDir);
});

test("Restore is targeted, preserves unrelated later edits, rejects owned drift, and is idempotent", async (t) => {
  await t.test("three-way preservation and idempotence", async (t) => {
    const fixture = makePolicyFixture(t);
    const commands = commandsFor(fixture);
    const preview = await commands.preview();
    const applied = await commands.apply(preview.previewToken);
    fs.appendFileSync(fixture.configPath, '\n[post_apply_user_edit]\nvalue = "keep config edit"\n');
    fs.appendFileSync(fixture.browserConfigPath, '\n[post_apply_user_edit]\nvalue = "keep browser edit"\n');

    const restored = await commands.restore(applied.transactionId);
    const config = fs.readFileSync(fixture.configPath, "utf8");
    const browser = fs.readFileSync(fixture.browserConfigPath, "utf8");
    assert.equal(restored.changed, true);
    assert.equal(restored.restarted, false);
    assert.match(config, /\[post_apply_user_edit\]\nvalue = "keep config edit"/);
    assert.match(browser, /\[post_apply_user_edit\]\nvalue = "keep browser edit"/);
    assert.match(config, /\[mcp_servers\.chrome-devtools\][\s\S]*?default_tools_approval_mode = "approve"/);
    assert.match(browser, /^download_approval_mode = "never_ask"$/m);
    assert.match(browser, /^upload_approval_mode = "never_ask"$/m);
    assert.match(browser, /^full_cdp_access_enabled = true$/m);
    assertPrivateTransactionTree(fixture.dataDir);

    const beforeRepeat = snapshotTree(fixture.root);
    const repeated = await commands.restore(applied.transactionId);
    assert.equal(repeated.changed, false);
    assert.deepEqual(snapshotTree(fixture.root), beforeRepeat);
  });

  await t.test("owned-field drift", async (t) => {
    const fixture = makePolicyFixture(t);
    const commands = commandsFor(fixture);
    const preview = await commands.preview();
    const applied = await commands.apply(preview.previewToken);
    const drifted = replaceLine(
      fs.readFileSync(fixture.browserConfigPath, "utf8"),
      /^upload_approval_mode = "always_ask"$/m,
      'upload_approval_mode = "prompt"',
    );
    fs.writeFileSync(fixture.browserConfigPath, drifted);
    const beforeRestore = snapshotTree(fixture.root);

    await assertPolicyError(() => commands.restore(applied.transactionId), /TARGET_DRIFT/i);
    assert.deepEqual(snapshotTree(fixture.root), beforeRestore);
  });
});

test("public results and private receipts redact user, browser, URL, credential, and tool content", async (t) => {
  const fixture = makePolicyFixture(t);
  const commands = commandsFor(fixture);
  const preview = await commands.preview();
  assertPublicRedacted(preview, fixture);
  const applied = await commands.apply(preview.previewToken);
  assertPublicRedacted(applied, fixture);
  assertPublicRedacted(await commands.status(), fixture);

  const receiptFile = findFiles(fixture.dataDir).find((file) => /\.receipt\.json$/.test(file));
  assert.ok(receiptFile, "private receipt exists");
  const receipt = fs.readFileSync(receiptFile, "utf8");
  for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
    assert.equal(receipt.includes(sentinel), false, `private receipt leaked ${sentinel}`);
  }

  const restored = await commands.restore(applied.transactionId);
  assertPublicRedacted(restored, fixture);
});

function loadPolicy(overrides = {}) {
  return loadCommonJs(POLICY_PATH, overrides);
}

function commandsFor(fixture, deps = {}, policy = loadPolicy()) {
  return policy.createPolicyCommandInterface({
    dataDir: fixture.dataDir,
    configPath: fixture.configPath,
    browserConfigPath: fixture.browserConfigPath,
    deps: {
      identityEvidence: fixture.identityEvidence,
      chromeIdentityEvidence: fixture.identityEvidence.chromeDevtools,
      browserIdentityEvidence: fixture.identityEvidence.browser,
      getIdentityEvidence() { return fixture.identityEvidence; },
      ...deps,
    },
  });
}

async function assertPolicyError(fn, codePattern) {
  let caught = null;
  try {
    const result = await fn();
    if (result && typeof result === "object" && result.errorCode) {
      caught = { code: result.errorCode, result };
    }
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected policy operation to fail");
  assert.match(String(caught.code || caught.message), codePattern);
  return caught;
}

function findLine(source, prefix) {
  return source.split("\n").find((line) => line.startsWith(prefix));
}

function extractApprovedTools(source, routePrefix) {
  const approved = new Set();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\[([^\]]+)\]$/.exec(lines[index]);
    if (!match || !match[1].startsWith(`${routePrefix}.tools.`)) continue;
    const tool = match[1].slice(`${routePrefix}.tools.`.length).replace(/^"|"$/g, "");
    let body = "";
    for (let cursor = index + 1; cursor < lines.length && !/^\[[^\]]+\]$/.test(lines[cursor]); cursor += 1) {
      body += `${lines[cursor]}\n`;
    }
    if (/^approval_mode = "approve"$/m.test(body)) approved.add(tool);
  }
  return approved;
}

function assertPrivateTransactionTree(dataDir) {
  assert.equal(fs.existsSync(dataDir), true);
  const files = findFiles(dataDir);
  assert.ok(files.some((file) => /\.receipt\.json$/.test(file)), "receipt created");
  assert.ok(files.filter((file) => /\.before\./.test(file)).length >= 2, "both source backups created");
  for (const entry of walk(dataDir)) {
    const mode = fs.statSync(entry).mode & 0o777;
    assert.equal(mode, fs.statSync(entry).isDirectory() ? 0o700 : 0o600, `private mode for ${entry}`);
  }
}

function findFiles(root) {
  return walk(root).filter((entry) => fs.statSync(entry).isFile());
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const result = [root];
  if (fs.statSync(root).isDirectory()) {
    for (const name of fs.readdirSync(root).sort()) result.push(...walk(path.join(root, name)));
  }
  return result;
}

function assertPublicRedacted(value, fixture) {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `public result leaked ${sentinel}`);
  }
  assert.equal(serialized.includes(fixture.configPath), false);
  assert.equal(serialized.includes(fixture.browserConfigPath), false);
  assert.doesNotMatch(serialized, /receiptFile|backupFile|password|credential|toolArguments|questionText|browserContent|taskIds/i);
}

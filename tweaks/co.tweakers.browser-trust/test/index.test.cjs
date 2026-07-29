"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  createSemanticDom,
  findByText,
  flushDom,
} = require("./semantic-dom.cjs");

const INDEX_PATH = require.resolve("../index");
const SOURCE = fs.readFileSync(INDEX_PATH, "utf8");
const CHANNELS = [
  "browser-trust.status",
  "browser-trust.preview",
  "browser-trust.apply",
  "browser-trust.restore",
];
const PRIVATE_SENTINELS = [
  "task-private-019fa8",
  "Which private browser page should I open?",
  "Secret account dashboard text",
  "https://private.example.test/account?token=credential",
  "Bearer credential-private-123",
  "{\"url\":\"https://private.example.test\",\"password\":\"secret\"}",
];

test("main lifecycle is config-read-only, owns four handlers, and removes every handler on stop", async (t) => {
  const fixture = makeUntouchedFixture(t);
  const handlers = new Map();
  const removed = [];
  const policyCalls = [];
  const tweak = loadIndex({
    createPolicyCommandInterface(options) {
      policyCalls.push({ operation: "create", options });
      return {
        status() {
          policyCalls.push({ operation: "status" });
          return { status: "trusted", changed: false, restarted: false };
        },
        preview() {
          policyCalls.push({ operation: "preview" });
          return { status: "trusted", changed: false };
        },
        apply() {
          policyCalls.push({ operation: "apply" });
          return { status: "trusted", changed: false };
        },
        restore() {
          policyCalls.push({ operation: "restore" });
          return { status: "trusted", changed: false };
        },
      };
    },
  });

  await tweak.start({
    process: "main",
    fs: { dataDir: fixture.dataDir },
    ipc: {
      handleWithContext(channel, handler) {
        assert.equal(handlers.has(channel), false, `duplicate handler for ${channel}`);
        handlers.set(channel, handler);
        return () => {
          removed.push(channel);
          handlers.delete(channel);
        };
      },
    },
  });

  assert.deepEqual([...handlers.keys()].sort(), [...CHANNELS].sort());
  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].operation, "create");
  assert.equal(policyCalls[0].options.dataDir, fixture.dataDir);
  assert.deepEqual(Object.keys(policyCalls[0].options), ["dataDir"]);
  assert.deepEqual(snapshotFixture(fixture), fixture.before);

  await tweak.stop();
  assert.deepEqual(removed.sort(), [...CHANNELS].sort());
  assert.equal(handlers.size, 0);
  assert.deepEqual(snapshotFixture(fixture), fixture.before);
});

test("main IPC projection redacts private policy, browser, credential, and recovery details", async (t) => {
  const fixture = makeUntouchedFixture(t);
  const handlers = new Map();
  const privateFields = {
    taskIds: [PRIVATE_SENTINELS[0]],
    questionText: PRIVATE_SENTINELS[1],
    browserContent: PRIVATE_SENTINELS[2],
    url: PRIVATE_SENTINELS[3],
    credentials: PRIVATE_SENTINELS[4],
    toolArguments: PRIVATE_SENTINELS[5],
    receiptFile: path.join(fixture.dataDir, "private.receipt.json"),
    backupFile: path.join(fixture.dataDir, "private.before.toml"),
  };
  const tweak = loadIndex({
    createPolicyCommandInterface() {
      return {
        status: () => ({
          status: "trusted",
          changed: false,
          transactionId: "transaction-public-1234",
          restartRequired: false,
          routeStates: [{ routeId: "chrome-devtools", state: "trusted", ...privateFields }],
          ...privateFields,
        }),
        preview: () => ({
          status: "trusted",
          changed: true,
          affectedFieldCount: 12,
          affectedRoutes: [{ routeId: "chrome-devtools", fieldCount: 7, state: "trusted", ...privateFields }],
          registryFingerprint: "a".repeat(64),
          sourceFingerprint: "b".repeat(64),
          previewToken: "preview-token-public-1234",
          restartRequired: true,
          ...privateFields,
        }),
        apply: () => ({ status: "applied", changed: true, transactionId: "transaction-public-1234", ...privateFields }),
        restore: () => ({ status: "restored", changed: true, transactionId: "transaction-public-1234", ...privateFields }),
      };
    },
  });

  await tweak.start({
    process: "main",
    fs: { dataDir: fixture.dataDir },
    ipc: {
      handleWithContext(channel, handler) {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      },
    },
  });

  const preview = await handlers.get("browser-trust.preview")({});
  assert.deepEqual(Object.keys(preview).sort(), [
    "affectedFieldCount",
    "affectedRoutes",
    "changed",
    "previewToken",
    "registryFingerprint",
    "restartRequired",
    "sourceFingerprint",
    "status",
  ]);
  assert.deepEqual(plain(preview.affectedRoutes), [{
    routeId: "chrome-devtools",
    fieldCount: 7,
    state: "trusted",
  }]);

  const status = await handlers.get("browser-trust.status")({});
  assert.deepEqual(Object.keys(status).sort(), [
    "changed",
    "registryFingerprint",
    "restartRequired",
    "restarted",
    "routeStates",
    "status",
    "transactionId",
  ]);
  assert.deepEqual(plain(status.routeStates), [{
    routeId: "chrome-devtools",
    state: "trusted",
  }]);
  assertPublicRedacted({ preview, status });

  await tweak.stop();
  assert.deepEqual(snapshotFixture(fixture), fixture.before);
});

test("renderer lifecycle exposes explicit Preview, Apply, and Restore copy without mutating config", async (t) => {
  const fixture = makeUntouchedFixture(t);
  const dom = createSemanticDom();
  const invokes = [];
  let page = null;
  let unregisterCount = 0;
  const tweak = loadIndex(null, {
    document: dom.document,
    setImmediate,
  });

  await tweak.start({
    process: "renderer",
    ipc: {
      async invoke(channel, ...args) {
        invokes.push([channel, ...args]);
        return {
          status: "trusted",
          changed: false,
          transactionId: null,
          restartRequired: false,
          routeStates: [],
        };
      },
    },
    settings: {
      registerPage(definition) {
        page = definition;
        return { unregister() { unregisterCount += 1; } };
      },
    },
  });

  assert.equal(page.id, "browser-trust");
  assert.equal(page.title, "Browser Trust");
  const root = dom.document.createElement("section");
  dom.document.body.append(root);
  const dispose = page.render(root);
  await flushDom();

  const copy = root.textContent;
  assert.match(copy, /User Questions stays available and is not changed by Browser Trust\./);
  assert.match(copy, /Chrome DevTools and plugin navigation tools, mixed requests, writes, scripts, typing or input, downloads, uploads, and raw Full CDP\./);
  assert.match(copy, /Unknown and future routes default to prompted\./);
  assert.match(copy, /Preview is read-only\. Apply and Restore are explicit, reversible actions\./);
  assert.match(copy, /Browser Trust never restarts it automatically\./);
  assert.deepEqual(invokes, [["browser-trust.status"]]);
  assert.deepEqual(snapshotFixture(fixture), fixture.before);

  dispose();
  assert.equal(root.textContent, "");
  await tweak.stop();
  assert.equal(unregisterCount, 1);
  assert.deepEqual(snapshotFixture(fixture), fixture.before);
});

test("renderer keeps drift and profile mismatch states blocked without exposing raw profile paths", async (t) => {
  for (const scenario of [
    {
      state: "target_drift",
      expected: /Nothing was overwritten; review the current state before trying again\./,
    },
    {
      state: "profile_mismatch",
      expected: /active browser profile does not match the reviewed route identity/i,
    },
  ]) {
    await t.test(scenario.state, async () => {
      const dom = createSemanticDom();
      let page = null;
      const tweak = loadIndex(null, { document: dom.document, setImmediate });
      await tweak.start({
        process: "renderer",
        ipc: {
          async invoke(channel) {
            if (channel === "browser-trust.status") {
              return { status: "trusted", changed: false, transactionId: null, routeStates: [] };
            }
            if (channel === "browser-trust.preview") {
              return {
                status: scenario.state,
                changed: true,
                affectedFieldCount: 1,
                previewToken: "must-not-be-applicable",
                affectedRoutes: [{ routeId: "browser", fieldCount: 1, state: scenario.state }],
              };
            }
            throw new Error(`unexpected channel ${channel}`);
          },
        },
        settings: {
          registerPage(definition) {
            page = definition;
            return { unregister() {} };
          },
        },
      });
      const root = dom.document.createElement("section");
      dom.document.body.append(root);
      page.render(root);
      await flushDom();
      findByText(root, "button", "Preview").click();
      await flushDom();

      assert.equal(findByText(root, "button", "Apply").disabled, true);
      assert.match(root.textContent, scenario.expected);
      assert.doesNotMatch(root.textContent, /\.chrome-profiles|openai-agent-devtools|\/Users\//);
      await tweak.stop();
    });
  }
});

test("the tweak owns no User Questions import or policy-mutation lifecycle", async (t) => {
  const fixture = makeUntouchedFixture(t);
  const required = [];
  const handlers = new Map();
  const tweak = loadIndex({
    createPolicyCommandInterface({ dataDir }) {
      assert.equal(dataDir, fixture.dataDir);
      return {
        status: () => ({ status: "trusted" }),
        preview: () => ({ status: "trusted", changed: false }),
        apply: () => ({ status: "trusted", changed: false }),
        restore: () => ({ status: "trusted", changed: false }),
      };
    },
  }, {}, required);

  await tweak.start({
    process: "main",
    fs: { dataDir: fixture.dataDir },
    ipc: {
      handleWithContext(channel, handler) {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      },
    },
  });
  await tweak.stop();

  assert.deepEqual(required, ["./policy-state"]);
  assert.equal(required.some((specifier) => /user-questions/i.test(specifier)), false);
  assert.equal(SOURCE.includes("repairGlobalStateFile"), false);
  assert.equal(SOURCE.includes("cancelNormally"), false);
  assert.equal(SOURCE.includes("display failure"), false);
  assert.equal(SOURCE.includes("timeout"), false);
  assert.deepEqual(snapshotFixture(fixture), fixture.before);
});

function loadIndex(policyState, globals = {}, required = []) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    ...globals,
    require(specifier) {
      required.push(specifier);
      if (specifier === "./policy-state" && policyState) return policyState;
      throw new Error(`unexpected import: ${specifier}`);
    },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: INDEX_PATH });
  return sandbox.module.exports;
}

function makeUntouchedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-trust-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.toml");
  const browserConfigPath = path.join(root, "browser", "config.toml");
  const dataDir = path.join(root, "tweak-data");
  fs.mkdirSync(path.dirname(browserConfigPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `# ${PRIVATE_SENTINELS[1]}\nmodel = "test-only"\n`, { mode: 0o640 });
  fs.writeFileSync(browserConfigPath, `# ${PRIVATE_SENTINELS[2]}\napproval_mode = "never_ask"\n`, { mode: 0o600 });
  const fixture = { root, configPath, browserConfigPath, dataDir };
  fixture.before = snapshotFixture(fixture);
  return fixture;
}

function snapshotFixture(fixture) {
  const snapshot = {};
  for (const file of [fixture.configPath, fixture.browserConfigPath]) {
    snapshot[file] = {
      bytes: fs.readFileSync(file).toString("base64"),
      mode: fs.statSync(file).mode & 0o777,
    };
  }
  snapshot[fixture.dataDir] = fs.existsSync(fixture.dataDir);
  return snapshot;
}

function assertPublicRedacted(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `public result leaked ${sentinel}`);
  }
  assert.doesNotMatch(serialized, /receipt|backup|credential|password|toolArguments|questionText|browserContent|taskIds/i);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

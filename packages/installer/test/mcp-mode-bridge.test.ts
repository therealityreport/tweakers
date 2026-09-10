import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint";
import {
  createMcpModeBridge,
  parseMcpModeHelperResponse,
  type McpModeHelperRequest,
} from "../src/mcp-mode-bridge";

const fingerprint = "a".repeat(64);

test("sealed manager executes its pinned MCP helper and rejects changed runtime bytes", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweaker-sealed-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownerRoot = join(root, "manager");
  const generationRoot = join(ownerRoot, "generations", "b".repeat(64));
  const runtimeParent = join(ownerRoot, "runtime-generations");
  const staged = join(runtimeParent, "staged");
  mkdirSync(generationRoot, { recursive: true, mode: 0o700 });
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  writeFileSync(join(staged, "mcp-mode-headless.js"), helperSource({
    ok: true, changed: false, conflicts: [], error: null, exitCode: 0,
  }), { mode: 0o400 });
  const evidence = computeRuntimeFingerprint(staged);
  writeFileSync(join(staged, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...evidence }), { mode: 0o400 });
  const runtime = join(runtimeParent, evidence.fingerprint);
  renameSync(staged, runtime);
  const bundle = join(generationRoot, "manager.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/mcp-mode-bridge.ts", import.meta.url))],
    outfile: bundle, bundle: true, format: "esm", platform: "node", logLevel: "silent",
    define: { __TWEAKERS_MANAGER_RUNTIME_FINGERPRINT__: JSON.stringify(evidence.fingerprint) },
  });
  const imported = await import(pathToFileURL(bundle).href);
  const helper = join(runtime, "mcp-mode-headless.js");
  assert.equal(imported.defaultMcpModeHelperFile(), helper);
  const bridge = imported.createMcpModeBridge({
    configPath: join(root, "config.toml"), statePath: join(root, "state.json"),
    tweaksRoot: join(root, "tweaks"), tweakersConfigPath: join(root, "config.json"),
  });
  assert.equal(bridge.prove("chatgpt"), true);
  chmodSync(helper, 0o600);
  writeFileSync(helper, "throw new Error('changed runtime must never execute');\n");
  chmodSync(helper, 0o400);
  assert.throws(() => bridge.prove("chatgpt"), /runtime failed its compiled fingerprint/);
});

test("headless MCP bridge sends the exact request and accepts verified reconcile/proof evidence", () => {
  withHelper(`
const fs = require("node:fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const expected = ["schemaVersion", "operation", "appExperience", "configPath", "statePath", "tweaksRoot", "tweakersConfigPath"].sort();
if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(expected)) process.exit(91);
const names = request.appExperience === "tweakers" ? ["co-tweakers-user-questions"] : [];
const changed = request.operation === "reconcile";
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  operation: request.operation,
  appExperience: request.appExperience,
  ok: true,
  changed,
  desiredNames: names,
  appliedNames: names,
  conflicts: [],
  beforeFingerprint: "${fingerprint}",
  afterFingerprint: "${fingerprint}",
  preservedOptions: { "co-tweakers-user-questions": { defaultToolsApprovalMode: "approve" } },
  restartRequired: changed,
  error: null,
}));
`, (helperFile, root) => {
    const bridge = createMcpModeBridge({
      helperFile,
      configPath: join(root, ".codex", "config.toml"),
      statePath: join(root, "mcp-sync-state.json"),
      tweaksRoot: join(root, "tweaks"),
      tweakersConfigPath: join(root, "config.json"),
    });

    const reconcile = bridge.reconcile("tweakers");
    assert.equal(reconcile.changed, true);
    assert.deepEqual(reconcile.appliedNames, ["co-tweakers-user-questions"]);
    assert.equal(bridge.prove("chatgpt"), true);
  });
});

test("compiled headless helper suspends legacy ownership in ChatGPT and restores canonical ownership in Tweakers", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mcp-mode-roundtrip-"));
  try {
    const tweakDir = join(root, "tweaks", "user-questions");
    const configPath = join(root, ".codex", "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const tweakersConfigPath = join(root, "config.json");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(tweakDir, { recursive: true });
    writeFileSync(join(tweakDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(tweakDir, "mcp-server.js"), "process.exit(0);\n");
    writeFileSync(join(tweakDir, "manifest.json"), `${JSON.stringify({
      id: "co.tweakers.user-questions",
      name: "User Questions",
      version: "1.0.0",
      githubRepo: "therealityreport/tweakers",
      main: "index.js",
      mcp: { command: "node", args: ["mcp-server.js"] },
    }, null, 2)}\n`);
    writeFileSync(tweakersConfigPath, `${JSON.stringify({
      tweaks: { "co.tweakers.user-questions": { enabled: true } },
    }, null, 2)}\n`);
    writeFileSync(configPath, [
      "[mcp_servers.manual-server]",
      'command = "manual-command"',
      "",
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(join(tweakDir, "mcp-server.js"))}]`,
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n"));

    const bridge = createMcpModeBridge({
      configPath,
      statePath,
      tweaksRoot: join(root, "tweaks"),
      tweakersConfigPath,
    });
    const suspended = bridge.reconcile("chatgpt");
    assert.equal(suspended.ok, true);
    assert.deepEqual(suspended.appliedNames, []);
    assert.equal(
      suspended.preservedOptions["co-tweakers-user-questions"]?.defaultToolsApprovalMode,
      "approve",
    );
    const chatgptToml = readFileSync(configPath, "utf8");
    assert.match(chatgptToml, /\[mcp_servers\.manual-server\]/);
    assert.doesNotMatch(chatgptToml, /thomashulihan|co-tweakers-user-questions/);
    assert.equal(bridge.prove("chatgpt"), true);

    const restored = bridge.reconcile("tweakers");
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.appliedNames, ["co-tweakers-user-questions"]);
    const tweakersToml = readFileSync(configPath, "utf8");
    assert.match(tweakersToml, /\[mcp_servers\.co-tweakers-user-questions\]/);
    assert.match(tweakersToml, /default_tools_approval_mode = "approve"/);
    assert.doesNotMatch(tweakersToml, /thomashulihan/);
    assert.equal(bridge.prove("tweakers"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("headless MCP bridge fails closed on missing helper, conflicts, and unapplied proof", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mcp-mode-bridge-"));
  try {
    const options = {
      helperFile: join(root, "missing.js"),
      configPath: join(root, "codex.toml"),
      statePath: join(root, "state.json"),
      tweaksRoot: join(root, "tweaks"),
      tweakersConfigPath: join(root, "config.json"),
    };
    assert.throws(
      () => createMcpModeBridge(options).assertReady(),
      /MCP mode helper is missing/,
    );

    const conflictHelper = join(root, "conflict.cjs");
    writeFileSync(conflictHelper, helperSource({
      ok: false,
      changed: false,
      conflicts: [{
        observedName: "manual-name",
        canonicalName: "co-tweakers-user-questions",
        reason: "legacy-shape-mismatch",
      }],
      error: "owned table does not match",
      exitCode: 2,
    }));
    assert.throws(
      () => createMcpModeBridge({ ...options, helperFile: conflictHelper }).reconcile("chatgpt"),
      /owned table does not match/,
    );

    const mismatchHelper = join(root, "mismatch.cjs");
    writeFileSync(mismatchHelper, helperSource({
      ok: true,
      changed: true,
      conflicts: [],
      error: null,
      exitCode: 0,
    }));
    assert.throws(
      () => createMcpModeBridge({ ...options, helperFile: mismatchHelper }).prove("tweakers"),
      /unapplied configuration changes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP helper response parser rejects extra fields and mismatched operation evidence", () => {
  const expected: Pick<McpModeHelperRequest, "operation" | "appExperience"> = {
    operation: "prove",
    appExperience: "chatgpt",
  };
  const response = JSON.parse(helperResponse({
    operationExpression: '"reconcile"',
    appExperienceExpression: '"chatgpt"',
    ok: true,
    changed: false,
    conflicts: [],
    error: null,
  })) as Record<string, unknown>;
  assert.throws(
    () => parseMcpModeHelperResponse(JSON.stringify(response), expected),
    /invalid response evidence/,
  );
  response.operation = "prove";
  response.untrusted = true;
  assert.throws(
    () => parseMcpModeHelperResponse(JSON.stringify(response), expected),
    /invalid response shape/,
  );
});

function helperSource(input: {
  ok: boolean;
  changed: boolean;
  conflicts: Array<{ observedName: string; canonicalName: string; reason: string }>;
  error: string | null;
  exitCode: number;
}): string {
  return `
const fs = require("node:fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(${JSON.stringify(helperResponse({
    operationExpression: "request.operation",
    appExperienceExpression: "request.appExperience",
    ok: input.ok,
    changed: input.changed,
    conflicts: input.conflicts,
    error: input.error,
  }))}.replace(JSON.stringify("__OPERATION__"), JSON.stringify(request.operation)).replace(JSON.stringify("__EXPERIENCE__"), JSON.stringify(request.appExperience)));
process.exitCode = ${input.exitCode};
`;
}

function helperResponse(input: {
  operationExpression: string;
  appExperienceExpression: string;
  ok: boolean;
  changed: boolean;
  conflicts: Array<{ observedName: string; canonicalName: string; reason: string }>;
  error: string | null;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    operation: input.operationExpression === "request.operation" ? "__OPERATION__" : JSON.parse(input.operationExpression),
    appExperience: input.appExperienceExpression === "request.appExperience" ? "__EXPERIENCE__" : JSON.parse(input.appExperienceExpression),
    ok: input.ok,
    changed: input.changed,
    desiredNames: [],
    appliedNames: [],
    conflicts: input.conflicts,
    beforeFingerprint: fingerprint,
    afterFingerprint: fingerprint,
    preservedOptions: {},
    restartRequired: input.changed,
    error: input.error,
  });
}

function withHelper(source: string, run: (helperFile: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mcp-mode-bridge-"));
  try {
    const helperFile = join(root, "helper.cjs");
    writeFileSync(helperFile, source);
    run(helperFile, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

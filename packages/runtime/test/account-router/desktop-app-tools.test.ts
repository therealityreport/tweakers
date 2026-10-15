import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  captureDesktopAppToolsContext,
  desktopAppToolsFingerprint,
  injectDesktopAppToolsRequestConfig,
  isDesktopAppToolsContext,
  MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES,
  parseDesktopAppToolsContext,
  stripDesktopAppToolsCliOverrides,
} from "../../src/account-router/desktop-app-tools";

const resources = "/Applications/Tweakers.app/Contents/Resources";
const pluginRoot = join(resources, "plugins/openai-bundled/plugins/codex-app-tools");
const native = {
  command: "./scripts/launch_codex_app_tools_mcp", args: ["./server.mjs"], cwd: ".", enabled: false,
  omit_tools_from: ["deferred"], default_tools_approval_mode: "approve",
  tools: { create_thread: { approval_mode: "prompt" }, automation_update: { approval_mode: "prompt" } },
  env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_BROWSER_USE_NODE_PATH", "CODEX_ELECTRON_RESOURCES_PATH", "CODEX_CLI_PATH", "HOME", "PATH"],
  startup_timeout_sec: 10, tool_timeout_sec: 3600,
};
const reader = () => JSON.stringify({ mcpServers: { codex_app: native } });
const environment = { CODEX_APP_TOOLS_PIPE_PATH: "/private/tmp/tweakers-own-pipe.sock", HOME: "/Users/test", PATH: "/usr/bin",
  CODEX_MCP_NODE_PATH: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node", UNRELATED_SECRET: "excluded" };

test("capture resolves the desktop's complete native MCP and preserves approval policies", () => {
  let readPath = "";
  const context = captureDesktopAppToolsContext(resources, environment, path => { readPath = path; return reader(); })!;
  assert.equal(readPath, join(pluginRoot, ".mcp.json"));
  assert.equal(context.definition.command, join(pluginRoot, native.command));
  assert.deepEqual(context.definition.args, [join(pluginRoot, "server.mjs")]);
  assert.equal(context.definition.cwd, pluginRoot);
  assert.equal(context.definition.enabled, true);
  assert.deepEqual(context.definition.tools, native.tools);
  assert.deepEqual(context.definition.env_vars, native.env_vars);
  assert.deepEqual(context.definition.omit_tools_from, native.omit_tools_from);
  assert.equal(context.definition.default_tools_approval_mode, "approve");
  assert.equal(context.definition.tool_timeout_sec, 3600);
  assert.equal(context.definition.env.CODEX_APP_TOOLS_PIPE_PATH, environment.CODEX_APP_TOOLS_PIPE_PATH);
  assert.equal(context.definition.env.CODEX_MCP_NODE_PATH, join(resources, "cua_node/bin/node"));
  assert.equal(context.definition.env.CODEX_ELECTRON_RESOURCES_PATH, resources);
  assert.equal(context.definition.env.UNRELATED_SECRET, undefined);
  assert.deepEqual(parseDesktopAppToolsContext(JSON.stringify(context)), context);
});

test("capture waits for the native pipe and fails closed on malformed present context", () => {
  assert.equal(captureDesktopAppToolsContext(resources, {}, () => { throw new Error("must not read early"); }), null);
  assert.throws(() => captureDesktopAppToolsContext(resources, { CODEX_APP_TOOLS_PIPE_PATH: "relative.sock" }, reader), /unavailable/);
  assert.throws(() => captureDesktopAppToolsContext(resources, environment, () => "{}"), /unavailable/);
  assert.throws(() => captureDesktopAppToolsContext(resources, environment, () => JSON.stringify({ mcpServers: { codex_app: { ...native, command: "../../outside" } } })), /unavailable/);
  assert.throws(() => parseDesktopAppToolsContext("{"), /unavailable/);
  assert.throws(() => parseDesktopAppToolsContext("x".repeat(MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES + 1)), /unavailable/);
  const context = captureDesktopAppToolsContext(resources, environment, reader)!;
  assert.equal(isDesktopAppToolsContext({ ...context, definition: { ...context.definition, enabled: false } }), false);
  assert.equal(isDesktopAppToolsContext({ ...context, definition: { ...context.definition, env: { ...context.definition.env, CODEX_MCP_NODE_PATH: "/wrong/node" } } }), false);
  assert.equal(isDesktopAppToolsContext({ ...context, definition: { ...context.definition, env_vars: [...native.env_vars, "NODE_OPTIONS"] } }), false);
});

test("desktop tools receive the supplied nested backend while legacy flat packages remain compatible", () => {
  const nested = join(resources, "codex-cli/CodexCLI.app/Contents/MacOS/codex");
  for (const command of [nested, join(resources, "codex-cli/bin/codex")]) {
    const context = captureDesktopAppToolsContext(resources, environment, reader, command)!;
    assert.equal(context.definition.env.CODEX_CLI_PATH, nested);
    assert.deepEqual(parseDesktopAppToolsContext(JSON.stringify(context)), context);
  }
  assert.equal(captureDesktopAppToolsContext(resources, environment, reader)!.definition.env.CODEX_CLI_PATH, join(resources, "codex"));
  assert.throws(() => captureDesktopAppToolsContext(resources, environment, reader, "/foreign/codex"), /unavailable/);
  const context = captureDesktopAppToolsContext(resources, environment, reader, nested)!;
  assert.equal(isDesktopAppToolsContext({...context, definition: {...context.definition,
    env: {...context.definition.env, CODEX_CLI_PATH: join(resources, "codex-cli/bin/codex")}}}), false);
});

test("fingerprint binds own pipe and full native policies independently of key order", () => {
  const context = captureDesktopAppToolsContext(resources, environment, reader)!;
  const reordered = { definition: context.definition, resourcesPath: resources, schemaVersion: 1 as const };
  assert.equal(desktopAppToolsFingerprint(context), desktopAppToolsFingerprint(reordered));
  const other = captureDesktopAppToolsContext(resources, { ...environment, CODEX_APP_TOOLS_PIPE_PATH: "/private/tmp/another-desktop.sock" }, reader)!;
  assert.notEqual(desktopAppToolsFingerprint(context), desktopAppToolsFingerprint(other));
  const policy = captureDesktopAppToolsContext(resources, environment, () => JSON.stringify({ mcpServers: { codex_app: { ...native, tools: { create_thread: { approval_mode: "approve" } } } } }))!;
  assert.notEqual(desktopAppToolsFingerprint(context), desktopAppToolsFingerprint(policy));
});

test("thread request injection replaces all renderer native MCP overrides without changing caller state", () => {
  const context = captureDesktopAppToolsContext(resources, environment, reader)!;
  const config = { model: "selected", 'mcp_servers . "codex_app" . enabled': false, "mcp_servers.codex_app.env.CODEX_APP_TOOLS_PIPE_PATH": "/forged", "mcp_servers.codex_app": { command: "forged" },
    mcp_servers: { codex_app: { command: "forged" }, "codex_app.enabled": false, other: { command: "kept" } } };
  const snapshot = JSON.stringify(config);
  const result = injectDesktopAppToolsRequestConfig(config, context);
  assert.equal(result.model, "selected");
  assert.deepEqual(result.mcp_servers, { other: { command: "kept" } });
  assert.equal(result["mcp_servers.codex_app.env.CODEX_APP_TOOLS_PIPE_PATH"], undefined);
  assert.equal(result['mcp_servers . "codex_app" . enabled'], undefined);
  assert.deepEqual(result["mcp_servers.codex_app"], context.definition);
  assert.equal(JSON.stringify(config), snapshot);
  assert.notEqual(result["mcp_servers.codex_app"], context.definition);
  const legacy = injectDesktopAppToolsRequestConfig(config, null);
  assert.equal(legacy["mcp_servers.codex_app"], undefined);
  assert.deepEqual(legacy.mcp_servers, { other: { command: "kept" } });
  assert.throws(() => injectDesktopAppToolsRequestConfig("forged", context), /unavailable/);
  assert.throws(() => injectDesktopAppToolsRequestConfig(JSON.parse('{"__proto__":{"forged":true}}'), context), /unavailable/);
  const plugins = injectDesktopAppToolsRequestConfig({ 'plugins."codex-app-tools@openai-bundled".enabled': true,
    plugins: { "codex-app-tools@openai-bundled": { enabled: true }, "other@catalog": { enabled: true } } }, context);
  assert.equal(plugins['plugins."codex-app-tools@openai-bundled".enabled'], undefined);
  assert.deepEqual(plugins.plugins, { "other@catalog": { enabled: true } });
});

test("broker args strip direct, quoted and attached desktop overrides and preserve unrelated args", () => {
  const kept = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled",
    "-c", 'mcp_servers.context7={command="context7"}', "-c", 'mcp_servers."codex_app.other".enabled=true',
    "-c", 'plugins."other@catalog".enabled=true', "--config=model=\"selected\""];
  const args = [...kept,
    "-c", 'mcp_servers.codex_app={command="first-desktop"}',
    "--config", '"mcp_servers" . "codex_app" . env . CODEX_APP_TOOLS_PIPE_PATH="/first-desktop.sock"',
    '--config=mcp_servers.\'codex_app\'.enabled=true', '-c=mcp_servers."codex_app".cwd="/desktop"',
    '-cmcp_servers."codex_app".args=["server.mjs"]',
    "-c", 'mcp_servers."codex_\\u0061pp".enabled=true',
    "-c", 'plugins."codex-app-tools@openai-bundled".enabled=true'];
  assert.deepEqual(stripDesktopAppToolsCliOverrides(args), kept);
  assert.equal(args.length > kept.length, true, "caller array remains unchanged");
});

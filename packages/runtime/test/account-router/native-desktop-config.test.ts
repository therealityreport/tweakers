import assert from "node:assert/strict";
import test from "node:test";
import { captureDesktopAppToolsContext } from "../../src/account-router/desktop-app-tools";
import { attestNativeDesktopConfigV1, detachNativeDesktopConfigV1, NATIVE_DESKTOP_CONFIG_PROOF_V1 } from "../../src/account-router/native-desktop-config";
import { officialThreadPluginConfigAllowedV1 } from "../../src/account-router/official-bundled-adapter";

const secret = Buffer.alloc(32, 7);
const context = (pipe = "/private/tmp/native-fixture.sock") => captureDesktopAppToolsContext("/Applications/Tweakers.app/Contents/Resources", { CODEX_APP_TOOLS_PIPE_PATH: pipe }, () => JSON.stringify({ mcpServers: { codex_app: {
  command: "./launch", args: ["./server.mjs"], cwd: ".", env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_BROWSER_USE_NODE_PATH", "CODEX_ELECTRON_RESOURCES_PATH", "CODEX_CLI_PATH"],
} } }))!;
const native = Object.fromEntries(["codex_app", "node_repl", "cua_repl", "artifact_session", "openai_artifact_template_picker"].map(name => [`mcp_servers.${name}`, { command: `/native/${name}`, args: [], env: { NATIVE_PIPE: "/private/tmp/owned" }, enabled: name !== "cua_repl" }]));

test("completed native tools retain all signed definitions and unsigned policy stays separate", () => {
  const signed = attestNativeDesktopConfigV1(secret, context(), native);
  const input = { ...signed, "mcp_servers.node_repl.enabled_tools": ["js"], model: "selected" };
  const detached = detachNativeDesktopConfigV1(secret, context(), input);
  assert.deepEqual(detached.native, native);
  assert.deepEqual(detached.config, { "mcp_servers.node_repl.enabled_tools": ["js"], model: "selected" });
  assert.equal(officialThreadPluginConfigAllowedV1({ config: input }), false, "unconsumed metadata cannot reach a child");
  assert.equal(officialThreadPluginConfigAllowedV1({ config: detached.config }), true);
  assert.equal(Object.hasOwn(detached.native, NATIVE_DESKTOP_CONFIG_PROOF_V1), false);
  const untrusted = detachNativeDesktopConfigV1(secret, context(), { ...signed, "mcp_servers.other": { command: "forged" } });
  assert.equal(officialThreadPluginConfigAllowedV1({ config: untrusted.config }), false);
  const alias = detachNativeDesktopConfigV1(secret, context(), { ...signed, '"mcp_servers"."node_repl".command': "forged" });
  assert.equal(officialThreadPluginConfigAllowedV1({ config: alias.config }), false);
});

test("native attestation rejects altered executable, env, proof, context and missing entries", () => {
  const signed = attestNativeDesktopConfigV1(secret, context(), native);
  for (const field of ["command", "env"]) {
    const changed = structuredClone(signed) as any;
    changed["mcp_servers.node_repl"][field] = field === "command" ? "/forged" : { NATIVE_PIPE: "/forged" };
    assert.throws(() => detachNativeDesktopConfigV1(secret, context(), changed), /unavailable/);
  }
  const missing = { ...signed }; delete missing["mcp_servers.node_repl"];
  assert.throws(() => detachNativeDesktopConfigV1(secret, context(), missing), /unavailable/);
  assert.throws(() => detachNativeDesktopConfigV1(secret, context("/private/tmp/reconnected.sock"), signed), /unavailable/);
  assert.throws(() => detachNativeDesktopConfigV1(Buffer.alloc(32, 8), context(), signed), /unavailable/);
  assert.throws(() => detachNativeDesktopConfigV1(secret, null, signed), /unavailable/);
  assert.throws(() => detachNativeDesktopConfigV1(secret, context(), { ...signed, [NATIVE_DESKTOP_CONFIG_PROOF_V1]: {} }), /unavailable/);
  assert.equal(officialThreadPluginConfigAllowedV1({ config: native }), false, "unsigned executable definitions remain blocked");
});

test("nested signed definitions are snapshotted and unrelated nested policy remains separate", () => {
  const signed = attestNativeDesktopConfigV1(secret, context(), { mcp_servers: { node_repl: { command: "/native/repl", optional: undefined } } });
  const detached = detachNativeDesktopConfigV1(secret, context(), { ...signed, 'mcp_servers.node_repl.enabled_tools': ["js"] });
  (signed.mcp_servers as any).node_repl.command = "/changed-after-verification";
  assert.equal((detached.native.mcp_servers as any).node_repl.command, "/native/repl");
  assert.equal(officialThreadPluginConfigAllowedV1({ config: detached.config }), true);
});

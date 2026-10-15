import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { captureDesktopAppToolsContext } from "../../src/account-router/desktop-app-tools";
import { createDesktopAppToolsProof, verifyDesktopAppToolsProof } from "../../src/account-router/broker-host";
import { createBrokerHandshakeProof, createOpaqueAppToolsRef, createOpaqueRendererRef } from "../../src/account-router/broker";

function fixture() {
  const secret = randomBytes(32);
  const binding = { clientKind: "tweakers" as const, bundleIdentity: "co.tweakers.desktop", sessionNonce: randomBytes(24).toString("base64url") };
  const unsigned = { version: 1 as const, clientKind: "tweakers" as const, rendererRef: createOpaqueRendererRef(secret, 1, binding),
    appToolsRef: createOpaqueAppToolsRef(secret, 1, binding), nonce: randomBytes(24).toString("base64url") };
  const handshake = { ...unsigned, proof: createBrokerHandshakeProof(secret, unsigned) };
  const context = captureDesktopAppToolsContext("/Applications/Tweakers.app/Contents/Resources", {
    CODEX_APP_TOOLS_PIPE_PATH: "/private/tmp/own-desktop.sock",
  }, () => JSON.stringify({ mcpServers: { codex_app: {
    command: "./scripts/launch_codex_app_tools_mcp", args: ["./server.mjs"], cwd: ".", enabled: false,
    env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_BROWSER_USE_NODE_PATH", "CODEX_ELECTRON_RESOURCES_PATH", "CODEX_CLI_PATH"],
    default_tools_approval_mode: "approve", tools: { create_thread: { approval_mode: "prompt" } },
  } } }))!;
  return { secret, frame: { version: 1 as const, kind: "handshake" as const, handshake, desktopAppTools: context,
    desktopAppToolsProof: createDesktopAppToolsProof(secret, handshake, context) } };
}

test("desktop app tools proof binds full context to the exact desktop handshake", () => {
  const { secret, frame } = fixture();
  assert.equal(verifyDesktopAppToolsProof(secret, frame), true);
  for (const field of ["rendererRef", "appToolsRef", "nonce"] as const) {
    assert.equal(verifyDesktopAppToolsProof(secret, { ...frame, handshake: { ...frame.handshake, [field]: "changed" } } as any), false);
  }
  for (const mutate of [
    (context: any) => { context.definition.env.CODEX_APP_TOOLS_PIPE_PATH = "/private/tmp/other.sock"; },
    (context: any) => { context.definition.tools.create_thread.approval_mode = "approve"; },
  ]) {
    const context = structuredClone(frame.desktopAppTools); mutate(context);
    assert.equal(verifyDesktopAppToolsProof(secret, { ...frame, desktopAppTools: context }), false);
  }
  assert.equal(verifyDesktopAppToolsProof(randomBytes(32), frame), false);
  assert.equal(verifyDesktopAppToolsProof(secret, { ...frame, desktopAppToolsProof: "invalid" }), false);
  assert.equal(verifyDesktopAppToolsProof(secret, { ...frame, desktopAppToolsProof: undefined }), false);
});

test("legacy handshake accepts absent context but cannot carry an unbound context or proof", () => {
  const { secret, frame } = fixture();
  const legacy = { version: frame.version, kind: frame.kind, handshake: frame.handshake };
  assert.equal(verifyDesktopAppToolsProof(secret, legacy), true);
  assert.equal(verifyDesktopAppToolsProof(secret, { ...legacy, desktopAppToolsProof: frame.desktopAppToolsProof }), false);
  assert.equal(verifyDesktopAppToolsProof(secret, { ...legacy, desktopAppTools: frame.desktopAppTools }), false);
});

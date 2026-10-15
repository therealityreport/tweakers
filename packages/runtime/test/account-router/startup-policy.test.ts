import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedNativePluginPreparationTimeoutV1 } from "../../src/account-router/shared-native-mode";
import {
  createStartupPolicyAuthorization, createStartupPolicyHandshake, createStartupPolicyHandshakeProof,
  isStartupPolicyAuthorization, verifyStartupPolicyHandshake, StartupPolicySessionV1,
} from "../../src/account-router/startup-policy";

const secret = Buffer.alloc(32, 19);
const now = 1_800_000_000_000;
const initialize = { id: 1, method: "initialize", params: {
  clientInfo: { name: "codex_desktop", title: "Codex Desktop", version: "1.0" },
  capabilities: { experimentalApi: true },
} };
const messages = [initialize, { method: "initialized" },
  { id: 2, method: "configRequirements/read", params: {} },
  { id: 3, method: "config/read", params: { includeLayers: false } }];

test("signed official preparation budget preserves the four-message scope and legacy lifetime", t => {
  const root = mkdtempSync(join(tmpdir(), "startup-preparation-budget-")); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(sharedNativePluginPreparationTimeoutV1(root, secret, 20_000), 20_000);
  const value = { version: 1, kind: "account-router-shared-native-mode", resolverProtocol: "official-bundled-v1" };
  const canonical = '{"kind":"account-router-shared-native-mode","resolverProtocol":"official-bundled-v1","version":1}';
  const signature = `hmac-sha256:${createHmac("sha256", secret).update("shared-native-mode:v1\0" + canonical).digest("hex")}`;
  const path = join(root, "shared-native-mode.v1.json");
  writeFileSync(path, JSON.stringify({ ...value, signature }), { mode: 0o600 });
  assert.equal(sharedNativePluginPreparationTimeoutV1(root, secret, 20_000), 600_000);
  assert.equal(sharedNativePluginPreparationTimeoutV1(root, Buffer.alloc(32, 20), 20_000), 20_000);
  const authorization = createStartupPolicyAuthorization("s".repeat(32), now, 600_000), frame = createStartupPolicyHandshake(secret, authorization);
  assert.equal(authorization.version, 2); assert.equal(verifyStartupPolicyHandshake(secret, frame, now + 69_840), true);
  assert.equal(verifyStartupPolicyHandshake(secret, frame, now + 600_000), false);
  assert.throws(() => createStartupPolicyAuthorization("s".repeat(32), now, 600_001));
  assert.equal(createStartupPolicyAuthorization("s".repeat(32), now).version, 1);
  const session = new StartupPolicySessionV1();
  assert.equal(session.prepare({ id: 1, method: "thread/start", params: {} }), false);
});

test("startup authorization has an independent authenticated short-lived capability", () => {
  const authorization = createStartupPolicyAuthorization("s".repeat(32), now);
  assert.match(authorization.nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(authorization.expiresAt, now + 30_000);
  assert.notEqual(createStartupPolicyAuthorization("s".repeat(32), now).nonce, authorization.nonce);
  const frame = createStartupPolicyHandshake(secret, authorization);
  assert.equal(verifyStartupPolicyHandshake(secret, frame, now), true);
  assert.equal(verifyStartupPolicyHandshake(Buffer.alloc(32, 20), frame, now), false);
  for (const length of [0, 31, 33, 64]) {
    assert.equal(verifyStartupPolicyHandshake(Buffer.alloc(length, 19), frame, now), false);
    assert.throws(() => createStartupPolicyHandshakeProof(Buffer.alloc(length, 19), authorization));
  }
  assert.equal(verifyStartupPolicyHandshake(secret, frame, authorization.expiresAt), false);
  assert.equal(verifyStartupPolicyHandshake(secret, frame, now - 30_001), false);
  assert.equal(verifyStartupPolicyHandshake(secret, { ...frame, rendererRef: "forbidden" }, now), false);
  assert.equal(verifyStartupPolicyHandshake(secret, { ...frame, proof: "0".repeat(64) }, now), false);
  assert.equal(verifyStartupPolicyHandshake(secret, { ...frame, proof: "bad" }, now), false);
  const canonical = JSON.stringify(authorization);
  assert.equal(frame.proof, createHmac("sha256", secret).update("startup-policy-v1\0").update(canonical).digest("hex"));
  assert.notEqual(frame.proof, createHmac("sha256", secret).update("renderer-v1\0").update(canonical).digest("hex"));
});

test("startup authorization refuses schema drift and binds every authorization field", () => {
  const authorization = createStartupPolicyAuthorization("s".repeat(32), now);
  const frame = createStartupPolicyHandshake(secret, authorization);
  for (const [key, value] of Object.entries({ version: 2, scope: "renderer", clientKind: "chatgpt",
    bundleIdentity: "com.openai.codex", sessionNonce: "t".repeat(32), nonce: "n".repeat(32), expiresAt: now + 29_000 })) {
    assert.equal(verifyStartupPolicyHandshake(secret, { ...frame, authorization: { ...authorization, [key]: value } }, now), false, key);
  }
  for (const invalid of [{ ...authorization, extra: true }, { ...authorization, sessionNonce: "short" },
    { ...authorization, nonce: "!".repeat(32) }, { ...authorization, expiresAt: Infinity }, null, []]) {
    assert.equal(isStartupPolicyAuthorization(invalid, now), false);
  }
  for (const key of Object.keys(authorization)) {
    const missing: Record<string, unknown> = { ...authorization }; delete missing[key];
    assert.equal(isStartupPolicyAuthorization(missing, now), false, key);
  }
  assert.throws(() => createStartupPolicyAuthorization("unsafe session nonce", now));
  assert.throws(() => createStartupPolicyHandshakeProof(Buffer.alloc(3), authorization));
  const reordered = Object.fromEntries(Object.entries(authorization).reverse());
  assert.equal(verifyStartupPolicyHandshake(secret, { ...frame, authorization: reordered }, now), true);
});

test("startup session advances only on successful parent completion", () => {
  for (const includeJsonrpc of [false, true]) {
    const session = new StartupPolicySessionV1();
    for (const message of messages) {
      const before = session.state;
      assert.equal(session.prepare(includeJsonrpc ? { ...message, jsonrpc: "2.0" } : message), true);
      assert.equal(session.state, before);
      assert.equal(session.complete(true), true);
    }
    assert.equal(session.completed, true);
    assert.equal(session.prepare({ id: 4, method: "config/read", params: { includeLayers: false } }), false);
    assert.equal(session.state, "failed");
  }
  const session = new StartupPolicySessionV1();
  assert.equal(session.prepare(initialize), true);
  assert.equal(session.complete(false), false);
  assert.equal(session.prepare(initialize), false);
  assert.equal(new StartupPolicySessionV1().complete(true), false);
});

test("startup session rejects responses, routing fields, account methods, writes and altered parameters", () => {
  const invalid = [
    { ...initialize, jsonrpc: "1.0" }, { ...initialize, rendererRef: "bad" },
    { id: 1, result: {} }, { method: "initialize", params: initialize.params },
    { ...initialize, id: Infinity }, { ...initialize, id: 1.5 },
    { ...initialize, id: Number.MAX_SAFE_INTEGER + 1 }, { ...initialize, id: "i".repeat(257) },
    { ...initialize, params: { ...initialize.params, extra: true } },
    { ...initialize, params: { ...initialize.params, clientInfo: { ...initialize.params.clientInfo, name: "other" } } },
    { ...initialize, params: { ...initialize.params, clientInfo: { ...initialize.params.clientInfo, version: " " } } },
    { ...initialize, params: { ...initialize.params, clientInfo: { ...initialize.params.clientInfo, version: "v".repeat(129) } } },
    { ...initialize, params: { ...initialize.params, capabilities: { experimentalApi: false } } },
    ...["account/logout", "account/read", "config/write", "thread/start", "config/read"].map(method => ({ id: 1, method, params: {} })),
  ];
  for (const frame of invalid) {
    const session = new StartupPolicySessionV1();
    assert.equal(session.prepare(frame), false);
    assert.equal(session.state, "failed");
  }
  for (const params of [null, undefined, { extra: true }]) {
    const session = new StartupPolicySessionV1(); session.prepare(initialize); session.complete(true);
    assert.equal(session.prepare({ method: "initialized", params }), false);
  }
  const session = new StartupPolicySessionV1();
  assert.equal(session.prepare(initialize), true);
  assert.equal(session.prepare(initialize), false, "concurrent or repeated request terminates the session");
  for (const id of ["i".repeat(256), Number.MAX_SAFE_INTEGER]) {
    assert.equal(new StartupPolicySessionV1().prepare({ ...initialize, id }), true);
  }
});

test("startup config reads enforce their exact sequence and shapes", () => {
  for (const frame of [{ id: 2, method: "config/read", params: { includeLayers: false } },
    { id: 2, method: "configRequirements/read", params: { extra: true } }]) {
    const session = new StartupPolicySessionV1();
    for (const message of messages.slice(0, 2)) { assert.equal(session.prepare(message), true); session.complete(true); }
    assert.equal(session.prepare(frame), false);
  }
  for (const params of [{}, { includeLayers: true }, { includeLayers: false, accountId: "other" }]) {
    const session = new StartupPolicySessionV1();
    for (const message of messages.slice(0, 3)) { session.prepare(message); session.complete(true); }
    assert.equal(session.prepare({ id: 3, method: "config/read", params }), false);
  }
  const session = new StartupPolicySessionV1(); session.prepare(initialize); session.complete(true);
  assert.equal(session.prepare({ method: "initialized", params: {} }), true);
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AccountsBrokerV1 } from "../../src/account-router/broker";
import { AccountsBrokerRendererAdapterV1 } from "../../src/account-router/broker-adapter";
import {
  AccountsBrokerSocketClientV1,
  resolveAccountsBrokerRoot,
  resolveAccountsBrokerRootResolution,
  startAccountsBrokerSocket,
  startBrokerControlSocket,
} from "../../src/account-router/broker-socket";
import type { OpaqueAccountId, OpaqueAppToolsRef, OpaqueRendererRef } from "../../src/account-router/types";

const secret = Buffer.alloc(32, 27);
const account = `ar_${"s".repeat(43)}` as OpaqueAccountId;
const renderer = `br_${"r".repeat(43)}` as OpaqueRendererRef;
const appTools = `bat_${"p".repeat(43)}` as OpaqueAppToolsRef;

function privateRoot(): string {
  const root = resolve(mkdtempSync(join(tmpdir(), "accounts-broker-socket-")));
  chmodSync(root, 0o700);
  writeFileSync(join(root, "control-secret.v1"), secret, { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  return root;
}

test("owner-private broker socket authenticates a renderer session and does not replay a command", async () => {
  const root = privateRoot();
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  const socket = await startAccountsBrokerSocket({ root, broker, secret });
  const client = new AccountsBrokerSocketClientV1({
    root,
    secret,
    clientKind: "chatgpt",
    rendererRef: renderer,
    appToolsRef: appTools,
  });
  const response = await client.invoke({ version: 1, requestId: "profile", command: "profile.read" });
  assert.equal(response.ok, true);
  const replay = await client.invoke({ version: 1, requestId: "profile", command: "profile.read" });
  assert.deepEqual(replay, { version: 1, requestId: "profile", ok: false, error: { code: "request_replayed", retryable: false } });
  await client.close();
  await socket.close();
});

test("owner-private browser context and child RPC stay bound to the authenticated opaque account", async () => {
  const root = privateRoot();
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  const calls: unknown[] = [];
  const socket = await startAccountsBrokerSocket({ root, broker, secret,
    resolveNativeBrowserContext: async (rendererRef, opaqueAccountId) => {
      calls.push({ rendererRef, opaqueAccountId, kind: "context" });
      return { version: 1, status: "ready", opaqueAccountId, codexHome: root, configFile: join(root, "config.toml"), appServerVersion: "0.153.4" };
    },
    invokeNativeBrowserRequest: async (rendererRef, opaqueAccountId, method, params) => {
      calls.push({ rendererRef, opaqueAccountId, method, params });
      return { data: [{ id: "fixture-local" }] };
    },
  });
  const client = new AccountsBrokerSocketClientV1({ root, secret, clientKind: "chatgpt", rendererRef: renderer, appToolsRef: appTools });
  try {
    assert.deepEqual(await client.resolveNativeBrowserContext(account), {
      version: 1, status: "ready", opaqueAccountId: account, codexHome: root, configFile: join(root, "config.toml"), appServerVersion: "0.153.4",
    });
    assert.deepEqual(await client.invokeNativeBrowserRequest(account, "plugin/list", { marketplaceKinds: ["local"] }), { data: [{ id: "fixture-local" }] });
    assert.equal(await client.invokeNativeBrowserRequest(account, "plugin/list", { marketplaceKinds: ["remote"] }), null);
    assert.deepEqual(calls, [
      { rendererRef: renderer, opaqueAccountId: account, kind: "context" },
      { rendererRef: renderer, opaqueAccountId: account, method: "plugin/list", params: { marketplaceKinds: ["local"] } },
    ]);
  } finally { await client.close(); await socket.close(); }
});

test("broker socket preserves a strictly masked profile identifier without destroying the authenticated peer", async () => {
  const root = privateRoot();
  const broker = new AccountsBrokerV1({
    accounts: [{
      opaqueAccountId: account,
      enabled: true,
      safeProfile: { plan: "Fixture", identifierMasked: "fix***@example.test", avatarUrl: null },
    }],
    secret,
  });
  const socket = await startAccountsBrokerSocket({ root, broker, secret });
  const client = new AccountsBrokerSocketClientV1({ root, secret, clientKind: "chatgpt", rendererRef: renderer, appToolsRef: appTools });
  const events: unknown[] = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  try {
    const profile = await client.invoke({ version: 1, requestId: "masked-profile", command: "profile.read" });
    assert.equal(profile.ok, true);
    assert.match(JSON.stringify(profile), /fix\*\*\*@example\.test/);
    const second = `ar_${"t".repeat(43)}` as OpaqueAccountId;
    assert.equal(broker.addMaterializedAccount(second, "Second", { plan: null, identifierMasked: "sec***@example.test", avatarUrl: null }), true);
    await waitFor(() => events.some((event) => JSON.stringify(event).includes("sec***@example.test")), "masked profile event missing");
    const afterEvent = await client.invoke({ version: 1, requestId: "still-connected", command: "profile.read" });
    assert.equal(afterEvent.ok, true, "valid masked profile events must not tear down the socket");
  } finally {
    unsubscribe();
    await client.close();
    await socket.close();
  }
});

test("broker control socket returns only its strict status projection", async () => {
  const root = privateRoot();
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  const control = await startBrokerControlSocket({ root, secret, status: () => broker.status() });
  const response = await oneShot(control.path, {
    version: 1,
    requestId: "status",
    method: "status",
    secret: secret.toString("base64url"),
  });
  assert.deepEqual(Object.keys(response).sort(), ["requestId", "status", "version"]);
  assert.deepEqual(Object.keys((response as { status: object }).status).sort(), ["browserEvidence", "pendingHandoffs", "pool", "registeredClients", "state", "version"]);
  assert.doesNotMatch(JSON.stringify(response), /auth\.json|secret|cookie|token|\b(?:ar|br|bat|bd|bt|bh)_/);
  await control.close();
});

test("large plugin catalogs cross the authenticated socket and renderer adapter without widening other surfaces", async () => {
  const root = privateRoot();
  let description = "p".repeat(9 * 1024 * 1024);
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: account, enabled: true }], secret,
    onDeviceAction: (action) => action.kind === "native.request"
      ? { outcome: "accepted", value: { marketplaces: [{ name: "fixture", plugins: [{ name: "large", description }] }] } }
      : { outcome: "rejected" },
  });
  const socket = await startAccountsBrokerSocket({ root, broker, secret });
  const client = new AccountsBrokerSocketClientV1({ root, secret, clientKind: "tweakers", rendererRef: renderer, appToolsRef: appTools });
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client });
  try {
    const profile = await adapter.invoke({ version: 1, action: "broker", requestId: "catalog-profile", command: "profile.read" });
    assert.equal(profile.ok, true);
    const accountId = profile.ok ? (profile.result as { selectedAccountId: string }).selectedAccountId : "";
    const catalog = await adapter.invoke({ version: 1, action: "broker", requestId: "large-catalog", command: "native.request",
      params: { accountId, surface: "plugins", method: "plugin/list", params: {} } });
    assert.equal(catalog.ok, true);
    assert.equal(catalog.ok && (catalog.result as { result: { marketplaces: Array<{ plugins: Array<{ description: string }> }> } }).result.marketplaces[0]!.plugins[0]!.description.length, description.length);
    const apps = await adapter.invoke({ version: 1, action: "broker", requestId: "large-apps", command: "native.request",
      params: { accountId, surface: "apps", method: "app/list", params: {} } });
    assert.equal(apps.ok, false, "the Plugins allowance must not widen Apps responses");
    description = "p".repeat(17 * 1024 * 1024);
    const oversized = await adapter.invoke({ version: 1, action: "broker", requestId: "oversized-catalog", command: "native.request",
      params: { accountId, surface: "plugins", method: "plugin/list", params: {} } });
    assert.equal(oversized.ok, false, "Plugins responses must retain a finite bound");
    const after = await adapter.invoke({ version: 1, action: "broker", requestId: "after-catalog-rejection", command: "profile.read" });
    assert.equal(after.ok, true, "rejecting one oversized result must leave the broker connection usable");
  } finally {
    await client.close();
    await socket.close();
  }
});

test("broken command and status peers leave the shared broker available", async (t) => {
  const root = privateRoot();
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: account, enabled: true }], secret });
  const server = await startAccountsBrokerSocket({ root, broker, secret });
  const control = await startBrokerControlSocket({ root, secret, status: () => broker.status() });
  const client = new AccountsBrokerSocketClientV1({ root, secret, clientKind: "tweakers", rendererRef: renderer, appToolsRef: appTools });
  const originalWrite = Socket.prototype.write;
  let commandBroken = false;
  const writeMock = t.mock.method(Socket.prototype, "write", function(this: Socket, ...args: Parameters<Socket["write"]>) {
    if (!commandBroken && String(args[0]).includes('"kind":"handshake-result"')) {
      commandBroken = true;
      this.destroy(Object.assign(new Error("simulated broken handshake write"), { code: "EPIPE" }));
      return false;
    }
    return Reflect.apply(originalWrite, this, args);
  });
  try {
    const failed = await client.invoke({ version: 1, requestId: "broken-handshake", command: "profile.read" });
    assert.equal(commandBroken, true);
    assert.equal(failed.ok, false);
    writeMock.mock.restore();
    const recovered = await client.invoke({ version: 1, requestId: "after-broken-handshake", command: "profile.read" });
    assert.equal(recovered.ok, true);

    const originalEnd = Socket.prototype.end;
    let statusBroken = false;
    const endMock = t.mock.method(Socket.prototype, "end", function(this: Socket, ...args: Parameters<Socket["end"]>) {
      if (!statusBroken && String(args[0]).includes('"requestId":"broken-status","status"')) {
        statusBroken = true;
        this.destroy(Object.assign(new Error("simulated broken status write"), { code: "ECONNRESET" }));
        return this;
      }
      return Reflect.apply(originalEnd, this, args);
    });
    await assert.rejects(oneShot(control.path, { version: 1, requestId: "broken-status", method: "status", secret: secret.toString("base64url") }));
    assert.equal(statusBroken, true);
    endMock.mock.restore();
    const status = await oneShot(control.path, { version: 1, requestId: "healthy-status", method: "status", secret: secret.toString("base64url") });
    assert.equal(status.requestId, "healthy-status");
  } finally {
    t.mock.restoreAll();
    await client.close();
    await control.close();
    await server.close();
  }
});

test("both variants require one explicit manager-global broker root and never derive one from local user data", () => {
  const root = privateRoot();
  const absent = resolveAccountsBrokerRootResolution({ userRoot: "/private/variant", derivedVariant: true, environment: {} });
  assert.deepEqual(absent, { root: null, configured: false });
  assert.equal(resolveAccountsBrokerRoot({ userRoot: "/private/variant", derivedVariant: true, environment: {} }), null);

  const variant = resolveAccountsBrokerRootResolution({
    userRoot: "/private/variant",
    derivedVariant: true,
    environment: { TWEAKERS_ACCOUNTS_BROKER_ROOT: root },
  });
  assert.deepEqual(variant, { root, configured: true });
  assert.equal(resolveAccountsBrokerRoot({
    userRoot: "/private/variant",
    derivedVariant: true,
    environment: { TWEAKERS_ACCOUNTS_BROKER_ROOT: root },
  }), root);

  assert.equal(resolveAccountsBrokerRoot({ userRoot: "/private/manager", derivedVariant: false, environment: {} }), null);
  assert.equal(resolveAccountsBrokerRoot({
    userRoot: "/private/manager",
    derivedVariant: false,
    environment: { TWEAKERS_ACCOUNTS_BROKER_ROOT: root },
  }), root);
});

test("configured broker-root aliases fail closed unless they are one exact canonical root", () => {
  const root = privateRoot();
  const equalAliases = resolveAccountsBrokerRootResolution({
    userRoot: "/private/manager",
    derivedVariant: false,
    environment: {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: root,
      TWEAKER_ACCOUNTS_BROKER_ROOT: root,
    },
  });
  assert.deepEqual(equalAliases, { root, configured: true });

  for (const [name, environment] of [
    ["empty", { TWEAKERS_ACCOUNTS_BROKER_ROOT: "" }],
    ["compatibility-empty", { TWEAKER_ACCOUNTS_BROKER_ROOT: "" }],
    ["relative", { TWEAKERS_ACCOUNTS_BROKER_ROOT: "global-broker" }],
    ["noncanonical", { TWEAKERS_ACCOUNTS_BROKER_ROOT: `${root}/.` }],
    ["conflicting", {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: root,
      TWEAKER_ACCOUNTS_BROKER_ROOT: `${root}-other`,
    }],
    ["invalid-primary-valid-compatibility", {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: "global-broker",
      TWEAKER_ACCOUNTS_BROKER_ROOT: root,
    }],
    ["valid-primary-invalid-compatibility", {
      TWEAKERS_ACCOUNTS_BROKER_ROOT: root,
      TWEAKER_ACCOUNTS_BROKER_ROOT: "global-broker",
    }],
  ] as const) {
    const resolution = resolveAccountsBrokerRootResolution({
      userRoot: "/private/manager",
      derivedVariant: false,
      environment,
    });
    assert.deepEqual(resolution, { root: null, configured: true }, name);
    assert.equal(resolveAccountsBrokerRoot({
      userRoot: "/private/manager",
      derivedVariant: false,
      environment,
    }), null, name);
  }
});

function oneShot(path: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    let output = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    socket.once("connect", () => socket.end(`${JSON.stringify(value)}\n`));
    socket.once("close", () => {
      try { resolvePromise(JSON.parse(output) as Record<string, unknown>); } catch (error) { reject(error); }
    });
  });
}

async function waitFor(predicate: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(failure);
}

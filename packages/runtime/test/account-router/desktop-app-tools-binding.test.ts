import assert from "node:assert/strict";
import test from "node:test";
import { AccountsBrokerOwnerV1 } from "../../src/account-router/broker-host";
import { captureDesktopAppToolsContext, desktopAppToolsFingerprint } from "../../src/account-router/desktop-app-tools";

function context(pipe = "/private/tmp/own.sock") {
  return captureDesktopAppToolsContext("/Applications/Tweakers.app/Contents/Resources", {
    CODEX_APP_TOOLS_PIPE_PATH: pipe,
  }, () => JSON.stringify({ mcpServers: { codex_app: {
    command: "./launch", args: ["./server.mjs"], cwd: ".", enabled: false,
    env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_BROWSER_USE_NODE_PATH", "CODEX_ELECTRON_RESOURCES_PATH", "CODEX_CLI_PATH"],
    default_tools_approval_mode: "approve", tools: { create_thread: { approval_mode: "prompt" } },
  } } }))!;
}

function bindingFixture() {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  const account = "ar_binding", threadId = "native-thread", taskRef = "task-binding";
  const client = { rendererRef: "renderer-own", appToolsRef: "tools-own", desktopAppTools: context() };
  const calls: Array<{ method: string; params: any }> = [], sent: any[] = [], errors: any[] = [];
  let teardown = true, idle = true, finishCount = 0;
  const child = { opaqueAccountId: account, ready: true, send: (value: unknown) => errors.push(value),
    requestPrivate: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const observation = host.appToolsRebindObservations.get(child)?.get(threadId);
      if (observation && teardown) { observation.unloaded = true; observation.idle = true; }
      return { result: { thread: { id: threadId } } };
    } };
  Object.assign(host, {
    closed: false, nativeHistory: null, children: new Map([[account, child]]), clients: new Map([[client.rendererRef, client]]),
    threadAppToolsBindings: new WeakMap(), appToolsRebindingTasks: new Set(), appToolsRebindObservations: new WeakMap(),
    officialDesktopConfigs: new WeakMap(), desktopThreadConfigs: new WeakMap(),
    taskRefsByThread: new Map([[threadId, taskRef]]), pendingChild: new Map(), nonce: 0,
    store: { ownerOf: () => account },
    canonicalHistory: { hasActiveTurn: () => false, conversationForNative: () => null },
    broker: { routeAppTools: () => ({ ownerRendererRef: client.rendererRef, appToolsRef: client.appToolsRef }),
      beginRun: () => true, finishRun: () => { finishCount++; } },
    loadedNativeThreads: async () => [threadId],
    requestBrokerChild: async (_account: string, _child: unknown, method: string, params: unknown) => {
      calls.push({ method, params });
      return { result: method === "thread/read" ? { thread: { status: { type: idle ? "idle" : "active" } } } : { status: "unsubscribed" } };
    },
    sendDesktop: (_client: unknown, message: unknown) => sent.push(message),
  });
  return { host, account, client, child, threadId, taskRef, calls, sent, errors,
    setTeardown: (value: boolean) => { teardown = value; }, setIdle: (value: boolean) => { idle = value; }, finished: () => finishCount };
}

test("loaded desktop binding requires idle teardown and resumes with native approval policy", async () => {
  const f = bindingFixture();
  const request = { method: "turn/start", params: { threadId: f.threadId } };
  assert.equal(await f.host.ensureDesktopAppToolsBinding(f.client, f.child, f.threadId, f.taskRef, null, request), true);
  assert.deepEqual(f.calls.map(call => call.method), ["thread/read", "thread/unsubscribe", "thread/resume"]);
  assert.deepEqual(f.calls[2]!.params.config["mcp_servers.codex_app"], f.client.desktopAppTools.definition);
  assert.equal(f.host.threadAppToolsBindings.get(f.child).get(f.threadId), desktopAppToolsFingerprint(f.client.desktopAppTools));
  assert.equal(f.finished(), 1);
  f.calls.length = 0;
  assert.equal(await f.host.ensureDesktopAppToolsBinding(f.client, f.child, f.threadId, f.taskRef, null, request), true);
  assert.equal(f.calls.length, 0, "same-desktop reconnect preserves the established native session");
});

test("active sessions and missing teardown evidence cannot establish a desktop binding", async () => {
  for (const active of [true, false]) {
    const f = bindingFixture(); f.setIdle(!active); f.setTeardown(false);
    assert.equal(await f.host.ensureDesktopAppToolsBinding(f.client, f.child, f.threadId, f.taskRef, null,
      { method: "thread/resume", params: { threadId: f.threadId } }), false);
    assert.equal(f.host.threadAppToolsBindings.get(f.child), undefined);
    assert.equal(f.host.appToolsRebindingTasks.size, 0);
    assert.equal(f.finished(), 1);
    if (active) assert.deepEqual(f.calls.map(call => call.method), ["thread/read"]);
  }
});

test("renderer replacement during native teardown cannot bind its stale desktop context", async () => {
  const f = bindingFixture();
  const original = f.child.requestPrivate;
  f.child.requestPrivate = async (method, params) => {
    const response = await original(method, params);
    f.host.clients.set(f.client.rendererRef, { ...f.client });
    return response;
  };
  assert.equal(await f.host.ensureDesktopAppToolsBinding(f.client, f.child, f.threadId, f.taskRef, null,
    { method: "thread/resume", params: { threadId: f.threadId } }), false);
  assert.equal(f.host.threadAppToolsBindings.get(f.child), undefined);
  assert.equal(f.finished(), 1);
});

test("reverse tools reject stale children, foreign account ownership and another desktop context", () => {
  const f = bindingFixture();
  f.host.recordThreadAppToolsBinding(f.child, f.threadId, f.client);
  const request = { jsonrpc: "2.0", id: "tool-request", method: "app-tools/request", params: { threadId: f.threadId } };
  f.host.routeChildRequest(f.account, f.child, request);
  assert.equal(f.sent.length, 1);
  f.host.routeChildRequest(f.account, { ...f.child }, request);
  f.host.store.ownerOf = () => "ar_other";
  f.host.routeChildRequest(f.account, f.child, request);
  f.host.store.ownerOf = () => f.account;
  f.client.desktopAppTools = context("/private/tmp/another.sock");
  f.host.routeChildRequest(f.account, f.child, request);
  assert.equal(f.sent.length, 1, "no rejected request reaches the desktop");
  assert.equal(f.errors.length, 3);
});

test("start, resume and fork params use only main-owned context and preserve native policies", () => {
  const f = bindingFixture();
  for (const params of [{}, { threadId: f.threadId }, { threadId: "fork-source", config: { "mcp_servers.codex_app": { command: "forged" } } }]) {
    const routed = f.host.desktopAppToolsParams(f.client, params);
    assert.deepEqual(routed.config["mcp_servers.codex_app"], f.client.desktopAppTools.definition);
    assert.equal(routed.threadId, (params as any).threadId);
  }
});

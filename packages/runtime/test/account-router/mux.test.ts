import assert from "node:assert/strict";
import test from "node:test";
import { AccountRouterMux, type RouterChild, type RouterChildFactory } from "../../src/account-router/mux";
import { createInitialRouterState } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type JsonRpcMessage, type OpaqueAccountId, type RouterConfig, type RouterState } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;
const config: RouterConfig = {
  schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
  accounts: [
    { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
    { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
  ], updatedAt: "2026-08-19T12:00:00Z",
};

function fakeStore(initial: RouterState) {
  let state = structuredClone(initial);
  return {
    snapshot: () => structuredClone(state),
    update(mutator: (next: RouterState) => void) { const next = structuredClone(state); mutator(next); state = next; return structuredClone(state); },
  };
}

class FakeChild implements RouterChild {
  readonly sent: JsonRpcMessage[] = [];
  readonly signals: NodeJS.Signals[] = [];
  constructor(readonly opaqueAccountId: OpaqueAccountId, private readonly handlers: { onMessage(message: JsonRpcMessage): void; onFailure(): void }) {}
  send(message: JsonRpcMessage): void { this.sent.push(message); }
  terminate(signal: NodeJS.Signals): void { this.signals.push(signal); }
  emit(message: JsonRpcMessage): void { this.handlers.onMessage(message); }
}

class FakeFactory implements RouterChildFactory {
  readonly children = new Map<OpaqueAccountId, FakeChild>();
  create(account: OpaqueAccountId, handlers: { onMessage(message: JsonRpcMessage): void; onFailure(): void }): RouterChild {
    const child = new FakeChild(account, handlers);
    this.children.set(account, child);
    return child;
  }
}

function responseFor(message: JsonRpcMessage, result: unknown): JsonRpcMessage {
  if (!("id" in message)) throw new Error("expected a request");
  return { jsonrpc: "2.0", id: message.id, result };
}

test("mux fans out initialize, reserves/binds new threads, keeps affinity, and restores ids", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 8) });
  assert.equal(mux.start(), true);
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], { capabilities: { chat: true }, serverInfo: { name: "codex" } }));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: 1, result: { capabilities: { chat: true }, serverInfo: { name: "codex" } } });
  mux.receiveDesktop({ jsonrpc: "2.0", method: "initialized", params: {} });
  assert.equal([...factory.children.values()].every((child) => child.sent.at(-1)?.method === "initialized"), true);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "start", method: "thread/start", params: { input: "hello" } });
  const selected = factory.children.get(accountA)!;
  assert.equal(selected.sent.at(-1)?.id, "ar1:c:3");
  selected.emit(responseFor(selected.sent.at(-1)!, { thread: { id: "thread-a" } }));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: "start", result: { thread: { id: "thread-a" } } });
  assert.equal(store.snapshot().threadOwners["thread-a"], accountA);
  mux.receiveDesktop({ jsonrpc: "2.0", id: 4, method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } });
  assert.equal(selected.sent.at(-1)?.method, "turn/interrupt");
  selected.emit(responseFor(selected.sent.at(-1)!, { interrupted: true }));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: 4, result: { interrupted: true } });
});

test("mux correlates child-originated requests without exposing a child id and fails closed on drift", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 9) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], { capabilities: { chat: true } }));
  desktop.length = 0;
  const child = factory.children.get(accountA)!;
  child.emit({ jsonrpc: "2.0", id: "child-approval", method: "item/tool/call", params: { threadId: "not-persisted" } });
  const request = desktop.pop()!;
  assert.match(String("id" in request ? request.id : ""), /^ar1:s:/);
  mux.receiveDesktop({ jsonrpc: "2.0", id: (request as { id: string }).id, result: { decision: "approve" } });
  assert.equal(child.sent.at(-1)?.id, "child-approval");
  mux.receiveDesktop({ jsonrpc: "2.0", id: 2, method: "future/new-method", params: {} });
  assert.equal(store.snapshot().stagedDisable?.reasonCode, "protocol_drift");
  const error = desktop.pop() as { error?: { data?: { code?: string } } };
  assert.equal(error.error?.data?.code, "unknown_method");
  assert.deepEqual(mux.status().accounts.map((account) => account.eligibility), ["protocol_blocked", "protocol_blocked"]);
  assert.deepEqual([...factory.children.values()].map((candidate) => candidate.signals), [["SIGTERM"], ["SIGTERM"]]);
});

test("mux invokes its owner-private cleanup hook once on normal shutdown and startup failure", () => {
  const normalStore = fakeStore(createInitialRouterState(config));
  const normalFactory = new FakeFactory();
  let normalCleanup = 0;
  const normal = new AccountRouterMux({
    config, store: normalStore as never, childFactory: normalFactory, writeDesktop: () => {}, controlSecret: Buffer.alloc(32, 2),
    onShutdown: () => { normalCleanup += 1; },
  });
  normal.start();
  normal.shutdown();
  normal.shutdown();
  assert.equal(normalCleanup, 1);
  assert.deepEqual([...normalFactory.children.values()].map((child) => child.signals), [["SIGTERM"], ["SIGTERM"]]);

  let failedCleanup = 0;
  const failingFactory: RouterChildFactory = { create() { throw new Error("synthetic start failure"); } };
  const failed = new AccountRouterMux({
    config, store: fakeStore(createInitialRouterState(config)) as never, childFactory: failingFactory, writeDesktop: () => {}, controlSecret: Buffer.alloc(32, 3),
    onShutdown: () => { failedCleanup += 1; },
  });
  assert.equal(failed.start(), false);
  assert.equal(failedCleanup, 1);
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AccountRouterMux, RouterPreDispatchError, type RouterChild, type RouterChildFactory } from "../../src/account-router/mux";
import { routerConfigFingerprint } from "../../src/account-router/config";
import type { AccountQuotaObservation } from "../../src/account-router/quota";
import { createInitialRouterState } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type JsonRpcMessage, type OpaqueAccountId, type RouterConfig, type RouterConfigV2, type RouterConfigV3, type RouterState } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;
const config: RouterConfig = {
  schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
  accounts: [
    { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
    { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
  ], updatedAt: "2026-08-19T12:00:00Z",
};

function quotaConfig(): RouterConfigV2 {
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2,
    mode: "quota_aware",
    policy: "quota_aware_v1",
    generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}`, label: "Account 1" },
      { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Account 2" },
    ],
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

function manualConfig(): RouterConfigV2 {
  const active = quotaConfig();
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    ...active,
    mode: "manual",
    policy: null,
    generation: active.generation + 1,
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

function balancedTokensConfig(): RouterConfigV3 {
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "balanced_tokens_v1",
    generation: 3,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}`, label: "Account 1" },
      { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Account 2" },
    ],
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

function refreshIdentityConfig(secret: Buffer): { config: RouterConfig; first: OpaqueAccountId } {
  const first = `ar_${createHmac("sha256", secret).update("account-router:v1:refresh-account-a", "utf8").digest("base64url")}` as OpaqueAccountId;
  const second = `ar_${createHmac("sha256", secret).update("account-router:v1:refresh-account-b", "utf8").digest("base64url")}` as OpaqueAccountId;
  return {
    first,
    config: {
      schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: first,
      accounts: [
        { opaqueAccountId: first, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
        { opaqueAccountId: second, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
      ], updatedAt: "2026-08-31T12:00:00Z",
    },
  };
}

function fakeStore(initial: RouterState) {
  let state = structuredClone(initial);
  return {
    snapshot: () => structuredClone(state),
    update(mutator: (next: RouterState) => void) { const next = structuredClone(state); mutator(next); state = next; return structuredClone(state); },
  };
}

function bindExistingThread(store: ReturnType<typeof fakeStore>, threadId: string, owner: OpaqueAccountId): void {
  store.update((state) => {
    state.threadOwners[threadId] = owner;
    state.ledger[owner].assignedThreadCount += 1;
  });
}

class FakeTimers {
  private now = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();
  readonly setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.tasks.set(id, { due: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.tasks.delete(timer as unknown as number);
  };
  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.due <= this.now).sort(([left], [right]) => left - right)[0];
      if (!due) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
  get activeCount(): number { return this.tasks.size; }
}

class FakeChild implements RouterChild {
  readonly sent: JsonRpcMessage[] = [];
  readonly signals: NodeJS.Signals[] = [];
  failNextPreDispatch = false;
  failNextAmbiguous = false;
  constructor(readonly opaqueAccountId: OpaqueAccountId, private readonly handlers: { onMessage(message: JsonRpcMessage): void; onFailure(): void }) {}
  send(message: JsonRpcMessage): void {
    if (this.failNextPreDispatch) {
      this.failNextPreDispatch = false;
      throw new RouterPreDispatchError();
    }
    this.sent.push(message);
    if (this.failNextAmbiguous) {
      this.failNextAmbiguous = false;
      throw new Error("synthetic ambiguous delivery");
    }
  }
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

function initializeResult(child: FakeChild): { userAgent: string; codexHome: string; platformFamily: string; platformOs: string } {
  return {
    userAgent: "codex-test",
    codexHome: `/private/accounts/${child.opaqueAccountId}/codex-home`,
    platformFamily: "darwin",
    platformOs: "macos",
  };
}

test("mux fans out initialize, reserves/binds new threads, keeps affinity, and restores ids", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 8) });
  assert.equal(mux.start(), true);
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: 1, result: initializeResult(factory.children.get(accountA)!) });
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

test("initialize always projects the configured primary response, not arrival order", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 30) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  const primary = factory.children.get(accountA)!;
  const secondary = factory.children.get(accountB)!;
  secondary.emit(responseFor(secondary.sent[0], initializeResult(secondary)));
  assert.equal(desktop.length, 0);
  primary.emit(responseFor(primary.sent[0], initializeResult(primary)));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: "init", result: initializeResult(primary) });
  mux.shutdown();
});

test("feature enablement broadcasts to every account and returns the configured primary response", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 31) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "feature", method: "experimentalFeature/enablement/set", params: { feature: "fixture", enabled: true } });
  const primary = factory.children.get(accountA)!;
  const secondary = factory.children.get(accountB)!;
  const primaryRequest = primary.sent.at(-1)!;
  const secondaryRequest = secondary.sent.at(-1)!;
  assert.equal(primaryRequest.method, "experimentalFeature/enablement/set");
  assert.equal(secondaryRequest.method, "experimentalFeature/enablement/set");
  secondary.emit(responseFor(secondaryRequest, { account: "secondary" }));
  assert.equal(desktop.length, 0);
  primary.emit(responseFor(primaryRequest, { account: "primary" }));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: "feature", result: { account: "primary" } });
  mux.shutdown();
});

test("mux rejects child-originated requests for unknown threads without desktop forwarding", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 9) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  const child = factory.children.get(accountA)!;
  child.emit({ jsonrpc: "2.0", id: "child-approval", method: "item/tool/call", params: { threadId: "not-persisted" } });
  assert.equal(desktop.length, 0, "an unowned child request is never forwarded to the desktop");
  assert.equal(child.sent.at(-1)?.id, "child-approval");
  assert.equal(store.snapshot().stagedDisable?.reasonCode, "protocol_drift");
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

function completeQuotaRefresh(factory: FakeFactory, remaining: Record<OpaqueAccountId, number>, resetAt: string): void {
  for (const [account, child] of factory.children) {
    const accountRead = child.sent.findLast((message) => "method" in message && message.method === "account/read");
    const rateRead = child.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read");
    if (!accountRead || !rateRead) throw new Error(`missing official reads for ${account}`);
    child.emit(responseFor(accountRead, { account: { authenticated: true, planType: "Pro" } }));
    child.emit(responseFor(rateRead, { rateLimits: { weekly: { remainingPercent: remaining[account], resetAt }, fiveHour: { remainingPercent: 50, resetAt } } }));
  }
}

test("v2 uses only fresh two-account official quota readings, exposes active truth, and keeps new-thread routing sticky", () => {
  let now = Date.parse("2026-08-31T12:00:00.000Z");
  const v2 = quotaConfig();
  const store = fakeStore(createInitialRouterState(v2));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config: v2, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 6), now: () => now });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  assert.deepEqual(desktop.pop(), { jsonrpc: "2.0", id: 1, result: initializeResult(factory.children.get(accountA)!) });
  assert.equal([...factory.children.values()].every((child) => child.sent.some((message) => "method" in message && message.method === "account/read")
    && child.sent.some((message) => "method" in message && message.method === "account/rateLimits/read")), true);

  completeQuotaRefresh(factory, { [accountA]: 60, [accountB]: 80 }, "2026-08-31T16:00:00.000Z");
  const status = mux.status();
  assert.equal(status.schemaVersion, 2);
  if (status.schemaVersion !== 2) throw new Error("expected v2 status");
  assert.deepEqual(status.active, { mode: "quota_aware", policy: "quota_aware_v1", generation: 1, fingerprint: v2.fingerprint });
  assert.equal(status.pending, null);
  assert.equal(status.poolRemainingPercent, 140);
  assert.deepEqual(status.accounts.map((account) => account.weekly.freshness), ["fresh", "fresh"]);
  assert.equal(status.degradedReason, null);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "start", method: "thread/start", params: { input: "fresh" } });
  const selected = factory.children.get(accountB)!;
  assert.equal(selected.sent.at(-1)?.method, "thread/start", "the higher 80%/4h score wins this fresh selection");
  selected.emit(responseFor(selected.sent.at(-1)!, { thread: { id: "thread-a" } }));
  mux.receiveDesktop({ jsonrpc: "2.0", id: "follow", method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } });
  assert.equal(selected.sent.at(-1)?.method, "turn/interrupt");

  const beforeFirstCompletion = selected.sent.length;
  selected.emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a" } } });
  assert.equal(selected.sent.length, beforeFirstCompletion + 2, "turn completion refreshes the owning account");
  const refreshedAccount = selected.sent.findLast((message) => "method" in message && message.method === "account/read")!;
  const refreshedRate = selected.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read")!;
  selected.emit(responseFor(refreshedAccount, { account: { authenticated: true, planType: "Pro" } }));
  selected.emit(responseFor(refreshedRate, { rateLimits: { weekly: { remainingPercent: 80, resetAt: "2026-08-31T16:00:00.000Z" } } }));
  const beforeFollowupCompletion = selected.sent.length;
  selected.emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-b" } } });
  assert.equal(selected.sent.length, beforeFollowupCompletion + 2, "sticky follow-up completion refreshes even without a first-turn reservation");
  const followupAccount = selected.sent.findLast((message) => "method" in message && message.method === "account/read")!;
  const followupRate = selected.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read")!;
  selected.emit(responseFor(followupAccount, { account: { authenticated: true, planType: "Pro" } }));
  selected.emit(responseFor(followupRate, { rateLimits: { weekly: { remainingPercent: 80, resetAt: "2026-08-31T16:00:00.000Z" } } }));
  const beforeRateNotification = selected.sent.length;
  selected.emit({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: {} });
  assert.equal(selected.sent.length, beforeRateNotification + 2, "relevant rate-limit notification refreshes only its child");
  const notificationAccount = selected.sent.findLast((message) => "method" in message && message.method === "account/read")!;
  const notificationRate = selected.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read")!;
  selected.emit(responseFor(notificationAccount, { account: { authenticated: true, planType: "Pro" } }));
  selected.emit(responseFor(notificationRate, { rateLimits: { weekly: { remainingPercent: 80, resetAt: "2026-08-31T16:00:00.000Z" } } }));

  const sendsBeforeStaleRead = [...factory.children.values()].map((child) => child.sent.length);
  now += 120_001;
  const staleStatus = mux.status();
  assert.equal(staleStatus.schemaVersion, 2);
  if (staleStatus.schemaVersion !== 2) throw new Error("expected v2 status");
  assert.equal(staleStatus.poolRemainingPercent, null);
  assert.equal(staleStatus.accounts.every((account) => account.weekly.freshness === "stale"), true);
  assert.equal([...factory.children.values()].every((child, index) => child.sent.length === sendsBeforeStaleRead[index] + 2), true, "status starts only a bounded official refresh pair per child");
  mux.shutdown();
});

test("v2 preserves bounded Codex quota metadata and clears it after a failed rate-limit probe", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const v2 = quotaConfig();
  const store = fakeStore(createInitialRouterState(v2));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config: v2, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 38), now: () => now,
  });
  assert.equal(mux.start(), true);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));

  for (const [account, child] of factory.children) {
    const accountRead = child.sent.findLast((message) => "method" in message && message.method === "account/read")!;
    const rateRead = child.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read")!;
    child.emit(responseFor(accountRead, { account: { authenticated: true, planType: "Pro" } }));
    const exhausted = account === accountA;
    child.emit(responseFor(rateRead, {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: exhausted ? 100 : 10, windowDurationMins: 300, resetsAt: Math.floor((now + 30_000) / 1_000) },
        secondary: { usedPercent: exhausted ? 10 : 30, windowDurationMins: 10_080, resetsAt: Math.floor((now + 3_600_000) / 1_000) },
        rateLimitReachedType: exhausted ? "primary" : null,
      },
      rateLimitResetCredits: { availableCount: exhausted ? 3 : 1 },
    }));
  }

  const observations = (mux as unknown as { quota: Map<OpaqueAccountId, AccountQuotaObservation> }).quota;
  assert.deepEqual(observations.get(accountA), {
    health: "authenticated",
    plan: "Pro",
    observedAt: now,
    weeklyRemainingPercent: 90,
    weeklyResetAt: now + 3_600_000,
    shortWindowPressure: 100,
    shortWindowResetAt: now + 30_000,
    rateLimitReached: true,
    resetCredits: 3,
  });
  mux.receiveDesktop({ jsonrpc: "2.0", id: "start", method: "thread/start", params: { input: "route around reached quota" } });
  assert.equal([...factory.children.values()].some((child) => child.sent.at(-1)?.method === "thread/start"), false,
    "the fixed v2 pool fails closed when reached or exhausted Codex quota is present");
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "pool_depleted");

  const first = factory.children.get(accountA)!;
  first.emit({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: {} });
  const refreshedAccount = first.sent.findLast((message) => "method" in message && message.method === "account/read")!;
  const refreshedRates = first.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read")!;
  first.emit(responseFor(refreshedAccount, { account: { authenticated: true, planType: "Pro" } }));
  if (!("id" in refreshedRates)) throw new Error("expected rate-limit request");
  first.emit({ jsonrpc: "2.0", id: refreshedRates.id, error: { code: -32000, message: "private provider failure" } });
  assert.deepEqual(observations.get(accountA), {
    health: "authenticated",
    plan: "Pro",
    observedAt: now,
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    shortWindowPressure: null,
    shortWindowResetAt: null,
    rateLimitReached: false,
    resetCredits: null,
  });
  mux.shutdown();
});

test("v2 never retries or migrates a new thread to the other account after pre-dispatch or ambiguous delivery", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const v2 = quotaConfig();
  const store = fakeStore(createInitialRouterState(v2));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config: v2, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 1), now: () => now });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  completeQuotaRefresh(factory, { [accountA]: 90, [accountB]: 10 }, "2026-08-31T16:00:00.000Z");
  const first = factory.children.get(accountA)!;
  const second = factory.children.get(accountB)!;
  const secondBefore = second.sent.length;
  first.failNextPreDispatch = true;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "pre", method: "thread/start", params: { input: "one route" } });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "post_start_failure");
  assert.equal(second.sent.length, secondBefore);

  first.failNextAmbiguous = true;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "ambiguous", method: "thread/start", params: { input: "one route" } });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "ambiguous_dispatch");
  assert.equal(second.sent.length, secondBefore);
  assert.equal(store.snapshot().reservations.some((reservation) => reservation.state === "stranded_ambiguous"), true);
  mux.shutdown();
});

test("adopted v2 manual stays mux-backed for sticky aggregate history but starts only on its configured primary", () => {
  const v2 = manualConfig();
  const store = fakeStore(createInitialRouterState(v2));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config: v2, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message),
    controlSecret: Buffer.alloc(32, 21), now: () => Date.parse("2026-08-31T12:00:00.000Z"),
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  completeQuotaRefresh(factory, { [accountA]: 1, [accountB]: 99 }, "2026-08-31T16:00:00.000Z");
  const status = mux.status();
  assert.equal(status.schemaVersion, 2);
  if (status.schemaVersion !== 2) throw new Error("expected v2 status");
  assert.deepEqual(status.active, { mode: "manual", policy: null, generation: v2.generation, fingerprint: v2.fingerprint });

  mux.receiveDesktop({ jsonrpc: "2.0", id: "manual-start", method: "thread/start", params: { input: "primary only" } });
  const primary = factory.children.get(accountA)!;
  const secondary = factory.children.get(accountB)!;
  assert.equal(primary.sent.at(-1)?.method, "thread/start", "manual ignores the secondary's larger quota reading");
  assert.notEqual(secondary.sent.at(-1)?.method, "thread/start");
  primary.emit(responseFor(primary.sent.at(-1)!, { thread: { id: "manual-primary" } }));
  desktop.pop();

  bindExistingThread(store, "adopted-legacy", accountB);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "legacy-read", method: "thread/read", params: { threadId: "adopted-legacy" } });
  assert.equal(secondary.sent.at(-1)?.method, "thread/read", "adopted legacy affinity remains durable under manual mode");
  secondary.emit(responseFor(secondary.sent.at(-1)!, { thread: { id: "adopted-legacy" } }));
  desktop.pop();

  mux.receiveDesktop({ jsonrpc: "2.0", id: "manual-list", method: "thread/list", params: { limit: 2 } });
  const firstList = primary.sent.at(-1)!;
  const secondList = secondary.sent.at(-1)!;
  primary.emit(responseFor(firstList, { data: [{ id: "manual-primary" }], nextCursor: null, backwardsCursor: null }));
  secondary.emit(responseFor(secondList, { data: [{ id: "adopted-legacy" }], nextCursor: null, backwardsCursor: null }));
  assert.deepEqual((desktop.pop() as { result: { data: Array<{ id: string }> } }).result.data.map((thread) => thread.id).sort(), ["adopted-legacy", "manual-primary"]);

  primary.emit({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: {} });
  const disabledAccount = primary.sent.findLast((message) => "method" in message && message.method === "account/read")!;
  const disabledLimits = primary.sent.findLast((message) => "method" in message && message.method === "account/rateLimits/read")!;
  primary.emit(responseFor(disabledAccount, { account: { enabled: false } }));
  primary.emit(responseFor(disabledLimits, { rateLimits: { weekly: { remainingPercent: 1, resetAt: "2026-08-31T16:00:00.000Z" } } }));
  const secondaryBefore = secondary.sent.length;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "manual-primary-down", method: "thread/start", params: { input: "must not fail over" } });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "pool_depleted");
  assert.equal(secondary.sent.length, secondaryBefore, "manual never retries or routes new work to the secondary account");
  mux.shutdown();
});

test("v2 control status keeps the running active intent when a later manual config is only pending", () => {
  const active = quotaConfig();
  const pendingDraft = { ...active, mode: "manual" as const, policy: null, generation: 2 };
  const pending = { ...pendingDraft, fingerprint: routerConfigFingerprint(pendingDraft) };
  const mux = new AccountRouterMux({
    config: active,
    store: fakeStore(createInitialRouterState(active)) as never,
    childFactory: new FakeFactory(),
    writeDesktop: () => {},
    controlSecret: Buffer.alloc(32, 1),
    readPendingConfig: () => pending,
  });
  assert.equal(mux.start(), true);
  const status = mux.status();
  assert.equal(status.schemaVersion, 2);
  if (status.schemaVersion !== 2) throw new Error("expected v2 status");
  assert.deepEqual(status.active, { mode: "quota_aware", policy: "quota_aware_v1", generation: 1, fingerprint: active.fingerprint });
  assert.deepEqual(status.pending, { mode: "manual", policy: null, generation: 2, fingerprint: pending.fingerprint });
  assert.equal(status.restartRequired, true);
  mux.shutdown();
});

test("v3 status preserves the active balanced-tokens policy", () => {
  const v3 = balancedTokensConfig();
  const mux = new AccountRouterMux({
    config: v3,
    store: fakeStore(createInitialRouterState(v3)) as never,
    childFactory: new FakeFactory(),
    writeDesktop: () => {},
    controlSecret: Buffer.alloc(32, 39),
  });
  assert.equal(mux.start(), true);
  const status = mux.status();
  assert.equal(status.schemaVersion, 3);
  if (status.schemaVersion !== 3) throw new Error("expected v3 status");
  assert.equal(status.active.policy, "balanced_tokens_v1");
  mux.shutdown();
});

test("aggregate list, loaded-list, and search pages bind every returned thread before sticky resume", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 4) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;

  mux.receiveDesktop({ jsonrpc: "2.0", id: "list-1", method: "thread/list", params: { limit: 2, archived: false } });
  const firstA = factory.children.get(accountA)!.sent.at(-1)!;
  const firstB = factory.children.get(accountB)!.sent.at(-1)!;
  factory.children.get(accountA)!.emit(responseFor(firstA, { data: [{ id: "list-a" }], nextCursor: "a-next", backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(firstB, { data: [{ id: "list-b" }], nextCursor: "b-next", backwardsCursor: null }));
  const firstPage = desktop.pop() as { result: { data: Array<{ id: string }>; nextCursor: string; backwardsCursor: string | null } };
  assert.deepEqual(firstPage.result.data.map((thread) => thread.id), ["list-a", "list-b"]);
  assert.match(firstPage.result.nextCursor, /^ar1\./);
  assert.equal(firstPage.result.backwardsCursor, null);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "list-2", method: "thread/list", params: { limit: 2, archived: false, cursor: firstPage.result.nextCursor } });
  const secondA = factory.children.get(accountA)!.sent.at(-1)!;
  const secondB = factory.children.get(accountB)!.sent.at(-1)!;
  assert.equal((secondA as { params?: { cursor?: string } }).params?.cursor, "a-next");
  assert.equal((secondB as { params?: { cursor?: string } }).params?.cursor, "b-next");
  factory.children.get(accountA)!.emit(responseFor(secondA, { data: [{ id: "list-a-2" }], nextCursor: null, backwardsCursor: "a-back" }));
  factory.children.get(accountB)!.emit(responseFor(secondB, { data: [{ id: "list-b-2" }], nextCursor: null, backwardsCursor: "b-back" }));
  assert.deepEqual((desktop.pop() as { result: { data: Array<{ id: string }> } }).result.data.map((thread) => thread.id), ["list-a-2", "list-b-2"]);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "loaded", method: "thread/loaded/list", params: { limit: 2 } });
  const loadedA = factory.children.get(accountA)!.sent.at(-1)!;
  const loadedB = factory.children.get(accountB)!.sent.at(-1)!;
  factory.children.get(accountA)!.emit(responseFor(loadedA, { data: ["loaded-a"], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(loadedB, { data: ["loaded-b"], nextCursor: null, backwardsCursor: null }));
  assert.deepEqual((desktop.pop() as { result: { data: string[] } }).result.data, ["loaded-a", "loaded-b"], "official loaded/list data is a string[] of thread ids");

  mux.receiveDesktop({ jsonrpc: "2.0", id: "search", method: "thread/search", params: { query: "router" } });
  const searchA = factory.children.get(accountA)!.sent.at(-1)!;
  const searchB = factory.children.get(accountB)!.sent.at(-1)!;
  factory.children.get(accountA)!.emit(responseFor(searchA, { data: [{ thread: { id: "search-a" }, snippet: "safe" }], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(searchB, { data: [{ thread: { id: "search-b" }, snippet: "safe" }], nextCursor: null, backwardsCursor: null }));
  desktop.pop();

  mux.receiveDesktop({ jsonrpc: "2.0", id: "resume", method: "thread/resume", params: { threadId: "loaded-b" } });
  assert.equal(factory.children.get(accountB)!.sent.at(-1)?.method, "thread/resume");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "search-resume", method: "thread/resume", params: { threadId: "search-a" } });
  assert.equal(factory.children.get(accountA)!.sent.at(-1)?.method, "thread/resume");
  assert.deepEqual(store.snapshot().threadOwners, {
    "list-a": accountA,
    "list-b": accountB,
    "list-a-2": accountA,
    "list-b-2": accountB,
    "loaded-a": accountA,
    "loaded-b": accountB,
    "search-a": accountA,
    "search-b": accountB,
  });
  mux.shutdown();
});

test("aggregate cursors are authenticated, one-use, and bound to their list method and filters", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 5) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "first", method: "thread/list", params: { limit: 1 } });
  for (const child of factory.children.values()) {
    const sent = child.sent.at(-1)!;
    child.emit(responseFor(sent, { data: [], nextCursor: `${child.opaqueAccountId}-next`, backwardsCursor: null }));
  }
  const cursor = (desktop.pop() as { result: { nextCursor: string } }).result.nextCursor;
  const sendsBeforeInvalid = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "tampered", method: "thread/list", params: { limit: 1, cursor: `${cursor}x` } });
  mux.receiveDesktop({ jsonrpc: "2.0", id: "wrong-method", method: "thread/loaded/list", params: { limit: 1, cursor } });
  mux.receiveDesktop({ jsonrpc: "2.0", id: "wrong-filter", method: "thread/list", params: { limit: 2, cursor } });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), sendsBeforeInvalid);
  assert.equal(desktop.filter((message) => "error" in message).length, 3);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "valid", method: "thread/list", params: { limit: 1, cursor } });
  for (const child of factory.children.values()) {
    const sent = child.sent.at(-1)!;
    child.emit(responseFor(sent, { data: [], nextCursor: null, backwardsCursor: null }));
  }
  desktop.pop();
  const sendsBeforeReplay = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "replay", method: "thread/list", params: { limit: 1, cursor } });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), sendsBeforeReplay);
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  mux.shutdown();
});

test("thread/list normalizes documented defaults and accepts only documented sortable fields", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 12) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;

  const variants: Array<{ sortKey?: "created_at" | "updated_at" | "recency_at"; sortDirection?: "asc" | "desc"; expectedKey: string; expectedDirection: string }> = [
    { expectedKey: "created_at", expectedDirection: "desc" },
    ...(["created_at", "updated_at", "recency_at"] as const).flatMap((sortKey) => ([
      { sortKey, sortDirection: "asc" as const, expectedKey: sortKey, expectedDirection: "asc" },
      { sortKey, sortDirection: "desc" as const, expectedKey: sortKey, expectedDirection: "desc" },
    ])),
  ];
  for (const [index, variant] of variants.entries()) {
    mux.receiveDesktop({ jsonrpc: "2.0", id: `sorted-${index}`, method: "thread/list", params: { limit: 1, ...(variant.sortKey ? { sortKey: variant.sortKey } : {}), ...(variant.sortDirection ? { sortDirection: variant.sortDirection } : {}) } });
    for (const child of factory.children.values()) {
      const sent = child.sent.at(-1) as { params?: Record<string, unknown> };
      assert.equal(sent.params?.sortKey, variant.expectedKey);
      assert.equal(sent.params?.sortDirection, variant.expectedDirection);
      child.emit(responseFor(sent as JsonRpcMessage, { data: [], nextCursor: null, backwardsCursor: null }));
    }
    assert.equal((desktop.pop() as { result?: { data?: unknown[] } }).result?.data?.length, 0);
  }
  const sendsBeforeInvalid = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "section-position", method: "thread/list", params: { limit: 1, sortKey: "section_position" } });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), sendsBeforeInvalid);
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "section_unsupported");
  mux.shutdown();
});

test("aggregate sessions globally sort, honor the requested limit, and paginate without rows in the wire cursor", () => {
  let now = 1_000;
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 6), now: () => now,
    aggregateSessionTtlMs: 5,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  const request = { limit: 2, sortKey: "updated_at", sortDirection: "desc" as const };
  mux.receiveDesktop({ jsonrpc: "2.0", id: "first", method: "thread/list", params: request });
  const firstA = factory.children.get(accountA)!.sent.at(-1)!;
  const firstB = factory.children.get(accountB)!.sent.at(-1)!;
  factory.children.get(accountA)!.emit(responseFor(firstA, { data: [{ id: "a100", updatedAt: 100 }, { id: "a70", updatedAt: 70 }], nextCursor: "a-next", backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(firstB, { data: [{ id: "b90", updatedAt: 90 }, { id: "b80", updatedAt: 80 }], nextCursor: "b-next", backwardsCursor: null }));
  const firstPage = desktop.pop() as { result: { data: Array<{ id: string }>; nextCursor: string } };
  assert.deepEqual(firstPage.result.data.map((thread) => thread.id), ["a100", "b90"]);
  assert.equal(firstPage.result.data.length, 2);
  assert.equal(Buffer.from(firstPage.result.nextCursor.split(".")[1]!, "base64url").toString("utf8").includes("a100"), false, "the session cursor contains no thread rows");

  mux.receiveDesktop({ jsonrpc: "2.0", id: "second", method: "thread/list", params: { ...request, cursor: firstPage.result.nextCursor } });
  assert.equal(factory.children.get(accountA)!.sent.length, 2, "buffered rows avoid an unnecessary child refetch");
  assert.equal(factory.children.get(accountB)!.sent.length, 2, "buffered rows avoid an unnecessary child refetch");
  const secondPage = desktop.pop() as { result: { data: Array<{ id: string }>; nextCursor: string } };
  assert.deepEqual(secondPage.result.data.map((thread) => thread.id), ["b80", "a70"]);
  assert.equal(secondPage.result.data.length, 2);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "third", method: "thread/list", params: { ...request, cursor: secondPage.result.nextCursor } });
  const thirdA = factory.children.get(accountA)!.sent.at(-1)!;
  const thirdB = factory.children.get(accountB)!.sent.at(-1)!;
  assert.equal((thirdA as { params?: { cursor?: string } }).params?.cursor, "a-next");
  assert.equal((thirdB as { params?: { cursor?: string } }).params?.cursor, "b-next");
  factory.children.get(accountA)!.emit(responseFor(thirdA, { data: [{ id: "a50", updatedAt: 50 }], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(thirdB, { data: [{ id: "b40", updatedAt: 40 }], nextCursor: null, backwardsCursor: null }));
  const thirdPage = desktop.pop() as { result: { data: Array<{ id: string }>; nextCursor: null } };
  assert.deepEqual(thirdPage.result.data.map((thread) => thread.id), ["a50", "b40"]);
  assert.equal(thirdPage.result.nextCursor, null);

  const sentBeforeExpiry = [...factory.children.values()].map((child) => child.sent.length);
  now += 6;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "expired", method: "thread/list", params: { ...request, cursor: firstPage.result.nextCursor } });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), sentBeforeExpiry);
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  mux.shutdown();
});

test("aggregate pagination bounds live buffers and remains healthy beyond 512 historical rows", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 35) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  const seen = new Set<string>();
  let cursor: string | null = null;
  let fetch = 0;
  let priorA = factory.children.get(accountA)!.sent.length;
  let priorB = factory.children.get(accountB)!.sent.length;
  for (let page = 0; page < 6; page += 1) {
    mux.receiveDesktop({ jsonrpc: "2.0", id: `page-${page}`, method: "thread/list", params: { limit: 100, sortKey: "updated_at", sortDirection: "desc", ...(cursor ? { cursor } : {}) } });
    const childA = factory.children.get(accountA)!;
    const childB = factory.children.get(accountB)!;
    if (childA.sent.length > priorA) {
      const base = 600 - fetch * 200;
      const a = Array.from({ length: 100 }, (_, index) => ({ id: `a-${fetch}-${index}`, updatedAt: base - index * 2 }));
      const b = Array.from({ length: 100 }, (_, index) => ({ id: `b-${fetch}-${index}`, updatedAt: base - index * 2 - 1 }));
      childA.emit(responseFor(childA.sent.at(-1)!, { data: a, nextCursor: fetch < 2 ? `a-${fetch}` : null, backwardsCursor: null }));
      childB.emit(responseFor(childB.sent.at(-1)!, { data: b, nextCursor: fetch < 2 ? `b-${fetch}` : null, backwardsCursor: null }));
      fetch += 1;
    }
    priorA = childA.sent.length;
    priorB = childB.sent.length;
    const result = (desktop.pop() as { result: { data: Array<{ id: string; updatedAt: number }>; nextCursor: string | null } }).result;
    assert.equal(result.data.length, 100);
    assert.equal(result.data.every((entry, index) => index === 0 || result.data[index - 1].updatedAt >= entry.updatedAt), true);
    for (const entry of result.data) {
      assert.equal(seen.has(entry.id), false, `no duplicate ${entry.id}`);
      seen.add(entry.id);
    }
    cursor = result.nextCursor;
  }
  assert.equal(seen.size, 600);
  assert.equal(cursor, null);
  assert.equal(store.snapshot().stagedDisable, null, "bounded current buffers never turn normal browsing into a stop");
  mux.shutdown();
});

test("a backwards cursor requires exactly the official sort-direction reversal and rewrites each child cursor", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 10) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  const desc = { limit: 1, sortKey: "updated_at", sortDirection: "desc" as const, archived: false };
  mux.receiveDesktop({ jsonrpc: "2.0", id: "desc", method: "thread/list", params: desc });
  for (const child of factory.children.values()) {
    const sent = child.sent.at(-1)!;
    const id = child.opaqueAccountId === accountA ? "a20" : "b10";
    child.emit(responseFor(sent, { data: [{ id, updatedAt: child.opaqueAccountId === accountA ? 20 : 10 }], nextCursor: null, backwardsCursor: `${child.opaqueAccountId}-back` }));
  }
  const backward = (desktop.pop() as { result: { backwardsCursor: string } }).result.backwardsCursor;
  const beforeRejected = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "same-direction", method: "thread/list", params: { ...desc, cursor: backward } });
  mux.receiveDesktop({ jsonrpc: "2.0", id: "changed-filter", method: "thread/list", params: { ...desc, sortDirection: "asc", archived: true, cursor: backward } });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), beforeRejected);
  assert.equal(desktop.filter((message) => "error" in message).length, 2);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "asc", method: "thread/list", params: { ...desc, sortDirection: "asc", cursor: backward } });
  const ascA = factory.children.get(accountA)!.sent.at(-1)!;
  const ascB = factory.children.get(accountB)!.sent.at(-1)!;
  assert.equal((ascA as { params?: { cursor?: string; sortDirection?: string } }).params?.cursor, `${accountA}-back`);
  assert.equal((ascB as { params?: { cursor?: string; sortDirection?: string } }).params?.cursor, `${accountB}-back`);
  assert.equal((ascA as { params?: { sortDirection?: string } }).params?.sortDirection, "asc");
  factory.children.get(accountA)!.emit(responseFor(ascA, { data: [{ id: "a5", updatedAt: 5 }], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(ascB, { data: [{ id: "b6", updatedAt: 6 }], nextCursor: null, backwardsCursor: null }));
  assert.deepEqual((desktop.pop() as { result: { data: Array<{ id: string }> } }).result.data.map((thread) => thread.id), ["a5"]);
  mux.shutdown();
});

test("invalid loaded-list entries fail closed rather than exposing an unbound string", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 11) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "loaded", method: "thread/loaded/list", params: { limit: 1 } });
  const child = factory.children.get(accountA)!;
  const other = factory.children.get(accountB)!;
  const before = store.snapshot();
  child.emit(responseFor(child.sent.at(-1)!, { data: [{ id: "not-an-official-loaded-id" }], nextCursor: null, backwardsCursor: null }));
  other.emit(responseFor(other.sent.at(-1)!, { data: ["valid-other-child"], nextCursor: null, backwardsCursor: null }));
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "post_start_failure");
  assert.equal(store.snapshot().threadOwners["not-an-official-loaded-id"], undefined);
  assert.deepEqual(store.snapshot().threadOwners, before.threadOwners, "the invalid second fanout page leaves durable owners unchanged");
  assert.deepEqual(store.snapshot().ledger, before.ledger, "the invalid second fanout page leaves assigned counts unchanged");
});

test("official search envelopes sort by nested thread fields and loaded-list preserves its no-limit wire shape", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 19) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "search", method: "thread/search", params: { query: "find", limit: 2, sortKey: "updated_at", sortDirection: "desc" } });
  const searchA = factory.children.get(accountA)!.sent.at(-1)!;
  const searchB = factory.children.get(accountB)!.sent.at(-1)!;
  factory.children.get(accountA)!.emit(responseFor(searchA, { data: [{ thread: { id: "search-a", updatedAt: 10 }, snippet: "a" }], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(searchB, { data: [{ thread: { id: "search-b", updatedAt: 20 }, snippet: "b" }], nextCursor: null, backwardsCursor: null }));
  assert.deepEqual((desktop.pop() as { result: { data: Array<{ thread: { id: string } }> } }).result.data.map((entry) => entry.thread.id), ["search-b", "search-a"]);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "read", method: "thread/read", params: { threadId: "search-b" } });
  assert.equal(factory.children.get(accountB)!.sent.at(-1)?.method, "thread/read");

  mux.receiveDesktop({ jsonrpc: "2.0", id: "loaded", method: "thread/loaded/list", params: { limit: null } });
  const loadedA = factory.children.get(accountA)!.sent.at(-1) as { params?: Record<string, unknown> };
  const loadedB = factory.children.get(accountB)!.sent.at(-1) as { params?: Record<string, unknown> };
  for (const sent of [loadedA, loadedB]) {
    assert.deepEqual(Object.keys(sent.params ?? {}).sort(), ["limit"]);
    assert.equal(sent.params?.limit, null);
  }
  factory.children.get(accountA)!.emit(responseFor(loadedA as JsonRpcMessage, { data: ["loaded-no-limit-a"], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(loadedB as JsonRpcMessage, { data: ["loaded-no-limit-b"], nextCursor: null, backwardsCursor: null }));
  assert.deepEqual((desktop.pop() as { result: { data: string[] } }).result.data, ["loaded-no-limit-a", "loaded-no-limit-b"]);
  mux.shutdown();
});

test("child server-request resolution preserves desktop ids through response, cancel, timeout, and same local ids", async () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 20), serverRequestTimeoutMs: 5,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  const a = factory.children.get(accountA)!;
  const b = factory.children.get(accountB)!;
  bindExistingThread(store, "server-thread-a", accountA);
  bindExistingThread(store, "server-thread-b", accountB);
  a.emit({ jsonrpc: "2.0", id: "same-local", method: "item/tool/call", params: { threadId: "server-thread-a" } });
  b.emit({ jsonrpc: "2.0", id: "same-local", method: "item/tool/call", params: { threadId: "server-thread-b" } });
  const [fromA, fromB] = desktop.splice(0) as Array<{ id: string }>;
  assert.notEqual(fromA.id, fromB.id, "the same child-local id remains disambiguated by child");
  mux.receiveDesktop({ jsonrpc: "2.0", id: fromA.id, result: { decision: "approve" } });
  assert.equal(a.sent.at(-1)?.id, "same-local");
  a.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: "same-local" } });
  assert.equal((desktop.pop() as { params: { requestId: string } }).params.requestId, fromA.id);
  b.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: "same-local" } });
  assert.equal((desktop.pop() as { params: { requestId: string } }).params.requestId, fromB.id);
  const beforeLate = desktop.length;
  mux.receiveDesktop({ jsonrpc: "2.0", id: fromB.id, result: { decision: "late" } });
  assert.equal(desktop.length, beforeLate, "an exact desktop late response is ignored after child cancellation");

  a.emit({ jsonrpc: "2.0", id: "refresh-timeout", method: "account/chatgptAuthTokens/refresh", params: {} });
  const refresh = desktop.pop() as { id: string };
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(a.sent.at(-1)?.id, "same-local", "the network refresh survives the old immediate deadline");
  a.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: "refresh-timeout" } });
  assert.equal((desktop.pop() as { params: { requestId: string } }).params.requestId, refresh.id);
  a.emit({ jsonrpc: "2.0", id: "refresh-next", method: "account/chatgptAuthTokens/refresh", params: {} });
  assert.equal((desktop.pop() as { id: string }).id.startsWith("ar1:s:"), true, "a later refresh is no longer stranded");
  mux.receiveDesktop({ jsonrpc: "2.0", id: refresh.id, result: { decision: "late" } });
  assert.equal(store.snapshot().stagedDisable, null);
  mux.shutdown();
});

test("authenticated server refresh validates its child identity before forwarding and resolves on the desktop-visible id", () => {
  const secret = Buffer.alloc(32, 24);
  const timers = new FakeTimers();
  const identity = refreshIdentityConfig(secret);
  const store = fakeStore(createInitialRouterState(identity.config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config: identity.config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: secret,
    serverRequestTimeoutMs: 5, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  const child = factory.children.get(identity.first)!;
  child.emit({ jsonrpc: "2.0", id: "refresh", method: "account/chatgptAuthTokens/refresh", params: {} });
  const desktopRequest = desktop.pop() as { id: string };
  timers.advance(6_000);
  assert.equal(timers.activeCount, 1, "auth refresh uses its bounded network lifetime rather than the immediate 5-second default");
  mux.receiveDesktop({ jsonrpc: "2.0", id: desktopRequest.id, result: { chatgptAccountId: "refresh-account-a" } });
  assert.equal(child.sent.at(-1)?.id, "refresh");
  child.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: "refresh" } });
  assert.equal((desktop.pop() as { params: { requestId: string } }).params.requestId, desktopRequest.id);
  assert.equal(store.snapshot().correlations.length, 0);
  mux.shutdown();
  assert.equal(timers.activeCount, 0);
});

test("interactive server requests outlive the old ceiling but remain bounded and clean on resolve, expiry, and stop", () => {
  const timers = new FakeTimers();
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 31),
    serverRequestTimeoutMs: 5, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  bindExistingThread(store, "interactive-thread", accountA);
  const child = factory.children.get(accountA)!;
  child.emit({ jsonrpc: "2.0", id: "approve", method: "item/tool/call", params: { threadId: "interactive-thread", autoResolutionMs: 31 * 60_000 } });
  const approval = desktop.pop() as { id: string };
  timers.advance(30_001);
  assert.equal(timers.activeCount, 1, "an approval survives the former 30-second ceiling");
  mux.receiveDesktop({ jsonrpc: "2.0", id: approval.id, result: { decision: "approve" } });
  child.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: "approve" } });
  assert.equal(timers.activeCount, 0, "terminal resolution clears the interactive timer");

  child.emit({ jsonrpc: "2.0", id: "expire", method: "item/tool/requestUserInput", params: { threadId: "interactive-thread" } });
  desktop.pop();
  timers.advance(30 * 60_000);
  assert.equal(child.sent.at(-1)?.id, "expire", "bounded expiry returns a local child error");
  child.emit({ jsonrpc: "2.0", id: "stop", method: "mcpServer/elicitation/request", params: { threadId: "interactive-thread" } });
  desktop.pop();
  assert.equal(timers.activeCount, 1);
  mux.shutdown();
  assert.equal(timers.activeCount, 0, "shutdown clears a live interactive request timer");
});

test("long-lived direct work is capacity-bounded rather than wall-clock-bounded", () => {
  const timers = new FakeTimers();
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 32),
    desktopRequestTimeoutMs: 5, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  for (let index = 0; index < 128; index += 1) {
    mux.receiveDesktop({ jsonrpc: "2.0", id: `command-${index}`, method: "command/exec", params: { command: "long" } });
  }
  timers.advance(10 * 60_000);
  assert.equal(store.snapshot().correlations.length, 128, "long work survives the old direct-request deadline");
  assert.equal(timers.activeCount, 0, "long work deliberately has no wall-clock timer");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "overflow", method: "mcpServer/tool/call", params: {} });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "start-overflow", method: "thread/start", params: { input: "bounded" } });
  const startErrors = desktop.splice(0).filter((message) => "error" in message) as unknown as Array<{
    id: string | number | null;
    error: { data?: { code?: string } };
  }>;
  assert.deepEqual(startErrors.map((message) => [message.id, message.error.data?.code]), [["start-overflow", "invalid_correlation"]], "the capped start has one terminal response");
  assert.equal(store.snapshot().reservations.at(-1)?.state, "released_pre_dispatch");
  const primary = factory.children.get(accountA)!;
  const first = primary.sent.find((message) => "id" in message && message.id !== "ar1:c:1" && "method" in message && message.method === "command/exec")!;
  primary.emit(responseFor(first, { completed: true }));
  mux.receiveDesktop({ jsonrpc: "2.0", id: "recovered", method: "command/exec", params: { command: "next" } });
  assert.equal(primary.sent.at(-1)?.method, "command/exec");
  mux.shutdown();
  assert.equal(store.snapshot().correlations.length, 0, "stop consumes all bounded long-lived correlations");
});

test("ordinary direct requests have no fabricated deadline; init failure still remains bounded", async () => {
  const directStore = fakeStore(createInitialRouterState(config));
  const directFactory = new FakeFactory();
  const directDesktop: JsonRpcMessage[] = [];
  const direct = new AccountRouterMux({
    config, store: directStore as never, childFactory: directFactory, writeDesktop: (message) => directDesktop.push(message), controlSecret: Buffer.alloc(32, 21), desktopRequestTimeoutMs: 5,
  });
  direct.start();
  direct.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of directFactory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  directDesktop.length = 0;
  direct.receiveDesktop({ jsonrpc: "2.0", id: "app", method: "app/read", params: {} });
  const lateDirect = directFactory.children.get(accountA)!.sent.at(-1)!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(directStore.snapshot().correlations.length, 1, "a routine RPC can outlive the legacy wall-clock deadline");
  directFactory.children.get(accountA)!.emit(responseFor(lateDirect, { completed: true }));
  assert.deepEqual(directDesktop.pop(), { jsonrpc: "2.0", id: "app", result: { completed: true } });
  assert.equal(directStore.snapshot().correlations.length, 0);

  const fanoutStore = fakeStore(createInitialRouterState(config));
  const fanoutFactory = new FakeFactory();
  const fanoutDesktop: JsonRpcMessage[] = [];
  const fanout = new AccountRouterMux({
    config, store: fanoutStore as never, childFactory: fanoutFactory, writeDesktop: (message) => fanoutDesktop.push(message), controlSecret: Buffer.alloc(32, 22), fanoutTimeoutMs: 5,
  });
  fanout.start();
  fanout.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  const initialA = fanoutFactory.children.get(accountA)!.sent.at(-1)!;
  const initialB = fanoutFactory.children.get(accountB)!.sent.at(-1)!;
  fanoutFactory.children.get(accountA)!.emit(responseFor(initialA, initializeResult(fanoutFactory.children.get(accountA)!)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fanoutStore.snapshot().correlations.length, 0);
  assert.equal(fanoutDesktop.filter((message) => "error" in message).length, 1);
  fanoutFactory.children.get(accountB)!.emit(responseFor(initialB, initializeResult(fanoutFactory.children.get(accountB)!)));
  assert.equal(fanoutDesktop.filter((message) => "error" in message).length, 1);
});

test("slow read-only fanouts fail only that RPC and leave the router healthy", async () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 34), fanoutTimeoutMs: 5,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "slow", method: "thread/list", params: { limit: 1 } });
  const late = factory.children.get(accountA)!.sent.at(-1)!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "post_start_failure");
  assert.equal(store.snapshot().stagedDisable, null);
  assert.deepEqual([...factory.children.values()].map((child) => child.signals), [[], []]);
  factory.children.get(accountA)!.emit(responseFor(late, { data: [], nextCursor: null, backwardsCursor: null }));
  assert.equal(store.snapshot().stagedDisable, null, "a late failed-read response is quarantined rather than protocol drift");
  mux.shutdown();
});

test("new-thread terminal errors and notification-first success clean or bind the exact reservation once", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 13) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;

  mux.receiveDesktop({ jsonrpc: "2.0", id: "failed", method: "thread/start", params: { input: "no thread" } });
  const owner = factory.children.get(accountA)!;
  owner.emit({ jsonrpc: "2.0", id: (owner.sent.at(-1) as { id: string }).id, error: { code: -32000, message: "private" } });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "post_start_failure");
  assert.equal(Object.keys(store.snapshot().pendingThreadOwners).length, 0);
  assert.equal(store.snapshot().reservations.at(-1)?.state, "released_pre_dispatch");

  // Use a fresh mux because the terminal child error intentionally makes the
  // running balanced projection restart-required.
  const secondStore = fakeStore(createInitialRouterState(config));
  const secondFactory = new FakeFactory();
  const secondDesktop: JsonRpcMessage[] = [];
  const second = new AccountRouterMux({ config, store: secondStore as never, childFactory: secondFactory, writeDesktop: (message) => secondDesktop.push(message), controlSecret: Buffer.alloc(32, 14) });
  second.start();
  second.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of secondFactory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  secondDesktop.length = 0;
  second.receiveDesktop({ jsonrpc: "2.0", id: "notification-first", method: "thread/start", params: { input: "yes" } });
  const selected = secondFactory.children.get(accountA)!;
  const issued = selected.sent.at(-1)!;
  selected.emit({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "notice-first" } });
  assert.equal(secondDesktop.length, 0, "a root start notification waits for its matching issued response");
  selected.emit(responseFor(issued, { thread: { id: "notice-first" } }));
  assert.equal(secondStore.snapshot().threadOwners["notice-first"], accountA);
  assert.equal(Object.keys(secondStore.snapshot().pendingThreadOwners).length, 0);
  assert.equal(secondDesktop.filter((message) => "method" in message && message.method === "thread/started").length, 1);
  second.shutdown();
});

test("ordinary follow-up token usage is removed at completion, close, and shutdown", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: () => {}, controlSecret: Buffer.alloc(32, 37) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  bindExistingThread(store, "follow-up-thread", accountA);
  const child = factory.children.get(accountA)!;
  for (let index = 0; index < 20; index += 1) {
    child.emit({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "follow-up-thread", turnId: `turn-${index}`, tokenUsage: { inputTokens: 1, outputTokens: 2 } } });
    child.emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "follow-up-thread", turn: { id: `turn-${index}` } } });
  }
  const privateMux = mux as unknown as { tokenUsage: Map<string, unknown> };
  assert.equal(privateMux.tokenUsage.size, 0, "unreserved follow-ups do not retain usage after completion");
  child.emit({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "follow-up-thread", turnId: "unfinished", tokenUsage: { inputTokens: 1, outputTokens: 2 } } });
  child.emit({ jsonrpc: "2.0", method: "thread/closed", params: { threadId: "follow-up-thread" } });
  assert.equal(privateMux.tokenUsage.size, 0, "thread close clears its pending usage entries");
  mux.shutdown();
  assert.equal(privateMux.tokenUsage.size, 0);
});

test("child-created and detached review threads require same-child causal ownership", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 15) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "known", method: "thread/list", params: { limit: 1 } });
  for (const child of factory.children.values()) {
    const sent = child.sent.at(-1)!;
    child.emit(responseFor(sent, { data: child.opaqueAccountId === accountA ? [{ id: "root-a" }] : [], nextCursor: null, backwardsCursor: null }));
  }
  desktop.length = 0;
  const a = factory.children.get(accountA)!;
  a.emit({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "sub-a", parentThreadId: "root-a" } });
  assert.equal(store.snapshot().threadOwners["sub-a"], accountA);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "review", method: "review/start", params: { threadId: "root-a" } });
  const review = a.sent.at(-1)!;
  a.emit({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "detached-a" } });
  a.emit(responseFor(review, { reviewThreadId: "detached-a" }));
  assert.equal(store.snapshot().threadOwners["detached-a"], accountA);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "read-detached", method: "thread/read", params: { threadId: "detached-a" } });
  assert.equal(a.sent.at(-1)?.method, "thread/read");
  mux.shutdown();
});

test("capability writes and path-overriding forks stage manual recovery while namespace reads remain routable", () => {
  const readStore = fakeStore(createInitialRouterState(config));
  const readFactory = new FakeFactory();
  const readMux = new AccountRouterMux({ config, store: readStore as never, childFactory: readFactory, writeDesktop: () => {}, controlSecret: Buffer.alloc(32, 16) });
  readMux.start();
  readMux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of readFactory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  readMux.receiveDesktop({ jsonrpc: "2.0", id: "read", method: "skills/list", params: {} });
  assert.equal(readFactory.children.get(accountA)!.sent.at(-1)?.method, "skills/list");
  assert.equal(readStore.snapshot().stagedDisable, null);
  readMux.shutdown();

  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 17) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  const sends = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "write", method: "config/value/write", params: {} });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), sends);
  assert.equal(store.snapshot().stagedDisable?.reasonCode, "policy_stop");
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "capability_mismatch");

  const forkStore = fakeStore(createInitialRouterState(config));
  const forkFactory = new FakeFactory();
  const forkDesktop: JsonRpcMessage[] = [];
  const forkMux = new AccountRouterMux({ config, store: forkStore as never, childFactory: forkFactory, writeDesktop: (message) => forkDesktop.push(message), controlSecret: Buffer.alloc(32, 18) });
  forkMux.start();
  forkMux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of forkFactory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  forkMux.receiveDesktop({ jsonrpc: "2.0", id: "fork", method: "thread/fork", params: { threadId: "unknown", path: "unsafe" } });
  assert.equal(forkStore.snapshot().stagedDisable?.reasonCode, "policy_stop");
  assert.equal((forkDesktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "capability_mismatch");
});

test("section reads use opaque router ids while section writes remain nonfatal read-only", () => {
  let now = 1_000;
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 23),
    now: () => now, aggregateSessionTtlMs: 5,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "sections", method: "threadSection/list", params: { limit: 2 } });
  const aSections = factory.children.get(accountA)!.sent.at(-1)!;
  const bSections = factory.children.get(accountB)!.sent.at(-1)!;
  // Reverse arrival proves configured account order, not race order.
  factory.children.get(accountB)!.emit(responseFor(bSections, { data: [{ id: "same-local", name: "Inbox" }], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountA)!.emit(responseFor(aSections, { data: [{ id: "same-local", name: "Inbox" }], nextCursor: null, backwardsCursor: null }));
  const sections = (desktop.pop() as { result: { data: Array<{ id: string; name: string }> } }).result.data;
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, "Inbox");
  assert.notEqual(sections[0].id, sections[1].id, "duplicate child-local ids receive separate opaque router ids");
  assert.equal(sections.every((section) => section.id.startsWith("ars1.") && !section.id.includes(accountA) && !section.id.includes(accountB)), true);

  now += 6;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "filtered", method: "thread/list", params: { sectionId: sections[1].id, limit: 1, sortKey: "section_position" } });
  const onlyA = factory.children.get(accountA)!;
  const onlyB = factory.children.get(accountB)!;
  assert.notEqual(onlyA.sent.at(-1)?.method, "thread/list", "the resolved section routes to one home only");
  assert.equal(onlyB.sent.at(-1)?.method, "thread/list");
  const filtered = onlyB.sent.at(-1) as { params?: { sectionId?: string } };
  assert.equal(filtered.params?.sectionId, "same-local");
  onlyB.emit(responseFor(filtered as JsonRpcMessage, { data: [{ id: "section-thread", sectionPosition: 1, section: { id: "same-local" } }], nextCursor: null, backwardsCursor: null }));
  const listed = (desktop.pop() as { result: { data: Array<{ section: { id: string } }> } }).result.data;
  assert.equal(listed[0].section.id, sections[1].id, "nested local section ids are rewritten on the way out");
  assert.equal(store.snapshot().threadOwners["section-thread"], accountB);

  mux.receiveDesktop({ jsonrpc: "2.0", id: "search", method: "thread/search", params: { query: "x", limit: 1 } });
  const searchA = onlyA.sent.at(-1)!;
  const searchB = onlyB.sent.at(-1)!;
  onlyA.emit(responseFor(searchA, { data: [], nextCursor: null, backwardsCursor: null }));
  onlyB.emit(responseFor(searchB, { data: [{ thread: { id: "section-search", createdAt: 1, section: { id: "same-local" } }, snippet: "safe" }], nextCursor: null, backwardsCursor: null }));
  const search = (desktop.pop() as { result: { data: Array<{ thread: { section: { id: string } } }> } }).result.data;
  assert.equal(search[0].thread.section.id, sections[1].id, "search rows never leak a child-local section id");
  onlyB.emit({ jsonrpc: "2.0", method: "thread/name/updated", params: { threadId: "section-thread", thread: { id: "section-thread", section: { id: "same-local" } } } });
  const notification = desktop.pop() as { params: { thread: { section: { id: string } } } };
  assert.equal(notification.params.thread.section.id, sections[1].id, "thread notifications rewrite child-local section ids too");

  const sendsBeforeWrite = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "move", method: "thread/section/move", params: { threadId: "section-thread", sectionId: sections[1].id } });
  assert.deepEqual([...factory.children.values()].map((child) => child.sent.length), sendsBeforeWrite, "read-only mutation sends no child write");
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "sections_read_only");
  assert.equal(store.snapshot().stagedDisable, null, "a rejected section mutation leaves the mux healthy");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "ordinary", method: "app/read", params: {} });
  assert.equal(factory.children.get(accountA)!.sent.at(-1)?.method, "app/read");
  mux.shutdown();
});

test("section-list cursors are opaque, one-use, filter-bound, expiry-bounded, and preserve official zero/null limits", () => {
  let now = 1_000;
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 36),
    now: () => now, aggregateSessionTtlMs: 5,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "first", method: "threadSection/list", params: { limit: 0 } });
  const a = factory.children.get(accountA)!;
  const b = factory.children.get(accountB)!;
  const firstA = a.sent.at(-1) as { params?: { limit?: unknown } };
  const firstB = b.sent.at(-1) as { params?: { limit?: unknown } };
  assert.equal(firstA.params?.limit, 0);
  assert.equal(firstB.params?.limit, 0);
  a.emit(responseFor(firstA as JsonRpcMessage, { data: [{ id: "a-one" }], nextCursor: "a-next" }));
  b.emit(responseFor(firstB as JsonRpcMessage, { data: [{ id: "b-one" }], nextCursor: "b-next" }));
  const first = (desktop.pop() as { result: { data: Array<{ id: string }>; nextCursor: string } }).result;
  assert.deepEqual(Object.keys(first).sort(), ["data", "nextCursor"]);
  assert.equal(first.nextCursor.startsWith("arsc1."), true);
  const sendsBeforeInvalid = [a.sent.length, b.sent.length];
  mux.receiveDesktop({ jsonrpc: "2.0", id: "tamper", method: "threadSection/list", params: { limit: 0, cursor: `${first.nextCursor}x` } });
  mux.receiveDesktop({ jsonrpc: "2.0", id: "filter", method: "threadSection/list", params: { limit: null, cursor: first.nextCursor } });
  assert.deepEqual([a.sent.length, b.sent.length], sendsBeforeInvalid);
  assert.equal((desktop.shift() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  assert.equal((desktop.shift() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "second", method: "threadSection/list", params: { limit: 0, cursor: first.nextCursor } });
  const secondA = a.sent.at(-1) as { params?: { cursor?: string; limit?: unknown } };
  const secondB = b.sent.at(-1) as { params?: { cursor?: string; limit?: unknown } };
  assert.equal(secondA.params?.cursor, "a-next");
  assert.equal(secondB.params?.cursor, "b-next");
  a.emit(responseFor(secondA as JsonRpcMessage, { data: [], nextCursor: "a-last" }));
  b.emit(responseFor(secondB as JsonRpcMessage, { data: [], nextCursor: "b-last" }));
  const second = (desktop.pop() as { result: { nextCursor: string } }).result;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "replay", method: "threadSection/list", params: { limit: 0, cursor: first.nextCursor } });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  now += 6;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "expired", method: "threadSection/list", params: { limit: 0, cursor: second.nextCursor } });
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "invalid_correlation");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "null-limit", method: "threadSection/list", params: { limit: null } });
  const nullA = a.sent.at(-1) as { params?: { limit?: unknown } };
  const nullB = b.sent.at(-1) as { params?: { limit?: unknown } };
  assert.equal(nullA.params?.limit, null);
  assert.equal(nullB.params?.limit, null);
  a.emit(responseFor(nullA as JsonRpcMessage, { data: [], nextCursor: null }));
  b.emit(responseFor(nullB as JsonRpcMessage, { data: [], nextCursor: null }));
  assert.deepEqual((desktop.pop() as { result: unknown }).result, { data: [], nextCursor: null });
  mux.shutdown();
});

test("aggregate thread-owner collisions fail closed before a partial list reaches the desktop", () => {
  const store = fakeStore(createInitialRouterState(config));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({ config, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 7) });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  desktop.length = 0;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "collision", method: "thread/list", params: {} });
  const first = factory.children.get(accountA)!.sent.at(-1)!;
  const second = factory.children.get(accountB)!.sent.at(-1)!;
  const before = store.snapshot();
  factory.children.get(accountA)!.emit(responseFor(first, { data: [{ id: "same-thread" }], nextCursor: null, backwardsCursor: null }));
  factory.children.get(accountB)!.emit(responseFor(second, { data: [{ id: "same-thread" }], nextCursor: null, backwardsCursor: null }));
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "post_start_failure");
  assert.equal(store.snapshot().stagedDisable?.reasonCode, "post_start_failure");
  assert.deepEqual(store.snapshot().threadOwners, before.threadOwners, "collision leaves all durable owners byte-equivalent");
  assert.deepEqual(store.snapshot().ledger, before.ledger, "collision leaves assigned counts byte-equivalent");
});

test("a stale idle v2 pool refreshes one queued start, clears failures, and later recovers without delivering twice", async () => {
  let now = Date.parse("2026-08-31T12:00:00.000Z");
  const v2 = quotaConfig();
  const store = fakeStore(createInitialRouterState(v2));
  const factory = new FakeFactory();
  const desktop: JsonRpcMessage[] = [];
  const mux = new AccountRouterMux({
    config: v2, store: store as never, childFactory: factory, writeDesktop: (message) => desktop.push(message), controlSecret: Buffer.alloc(32, 3), now: () => now,
    quotaProbeTimeoutMs: 5, queuedStartTimeoutMs: 30,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  completeQuotaRefresh(factory, { [accountA]: 60, [accountB]: 80 }, "2026-08-31T16:00:00.000Z");
  desktop.length = 0;
  now += 120_001;
  const beforeRefresh = [...factory.children.values()].map((child) => child.sent.length);
  mux.receiveDesktop({ jsonrpc: "2.0", id: "queued", method: "thread/start", params: { input: "after idle" } });
  assert.equal(desktop.length, 0, "the undelivered start waits for fresh all-account capacity");
  assert.equal([...factory.children.values()].every((child, index) => child.sent.length === beforeRefresh[index] + 2), true);
  completeQuotaRefresh(factory, { [accountA]: 60, [accountB]: 80 }, "2026-08-31T20:00:00.000Z");
  const selected = factory.children.get(accountB)!;
  assert.equal(selected.sent.at(-1)?.method, "thread/start");
  assert.equal([...factory.children.values()].filter((child) => child.sent.at(-1)?.method === "thread/start").length, 1);

  selected.emit(responseFor(selected.sent.at(-1)!, { thread: { id: "queued-thread" } }));
  desktop.pop();
  now += 120_001;
  mux.receiveDesktop({ jsonrpc: "2.0", id: "timeout", method: "thread/start", params: { input: "timeout" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((desktop.pop() as { error?: { data?: { code?: string } } }).error?.data?.code, "pool_depleted");
  mux.receiveDesktop({ jsonrpc: "2.0", id: "recover", method: "thread/start", params: { input: "recover" } });
  completeQuotaRefresh(factory, { [accountA]: 70, [accountB]: 80 }, "2026-08-31T23:00:00.000Z");
  assert.equal(selected.sent.at(-1)?.method, "thread/start", "timeout clears the bounded queue so a later fresh refresh can deliver once");
  mux.shutdown();
});

test("v2 quota probe timeout cleans its owned correlation, fails closed, ignores a late probe reply, and shutdown clears timers", async () => {
  const v2 = quotaConfig();
  const store = fakeStore(createInitialRouterState(v2));
  const factory = new FakeFactory();
  const mux = new AccountRouterMux({
    config: v2,
    store: store as never,
    childFactory: factory,
    writeDesktop: () => {},
    controlSecret: Buffer.alloc(32, 1),
    quotaProbeTimeoutMs: 5,
  });
  mux.start();
  mux.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of factory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  const late = factory.children.get(accountA)!.sent.find((message) => "method" in message && message.method === "account/read")!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.snapshot().correlations.length, 0);
  assert.deepEqual(Object.values(store.snapshot().accountEligibility), ["unhealthy", "unhealthy"]);
  factory.children.get(accountA)!.emit(responseFor(late, { account: { authenticated: true, planType: "Pro" } }));
  assert.equal(store.snapshot().stagedDisable, null, "a known expired internal probe reply is ignored, not replayed or rerouted");

  const secondStore = fakeStore(createInitialRouterState(v2));
  const secondFactory = new FakeFactory();
  const second = new AccountRouterMux({
    config: v2,
    store: secondStore as never,
    childFactory: secondFactory,
    writeDesktop: () => {},
    controlSecret: Buffer.alloc(32, 1),
    quotaProbeTimeoutMs: 5,
  });
  second.start();
  second.receiveDesktop({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  for (const child of secondFactory.children.values()) child.emit(responseFor(child.sent[0], initializeResult(child)));
  second.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(Object.values(secondStore.snapshot().accountEligibility), ["validating", "validating"], "shutdown cleared owned quota timers");
});

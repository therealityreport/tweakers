import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountsBrokerV1,
  createBrokerHandshakeProof,
  type BrokerChildFactoryV1,
} from "../../src/account-router/broker";
import type { BrokerCommandV1, BrokerEventV1, BrokerHandshakeV1, OpaqueAccountId, OpaqueAppToolsRef, OpaqueConnectionDefinitionRef, OpaqueConversationId, OpaqueRendererRef, OpaqueTaskRef } from "../../src/account-router/types";

const secret = Buffer.alloc(32, 9);
const accountA = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const accountB = `ar_${"b".repeat(43)}` as OpaqueAccountId;
const accountC = `ar_${"c".repeat(43)}` as OpaqueAccountId;
const rendererA = `br_${"a".repeat(43)}` as OpaqueRendererRef;
const rendererB = `br_${"b".repeat(43)}` as OpaqueRendererRef;
const appToolsA = `bat_${"a".repeat(43)}` as OpaqueAppToolsRef;
const appToolsB = `bat_${"b".repeat(43)}` as OpaqueAppToolsRef;
const conversationA = `lc_${"a".repeat(43)}` as OpaqueConversationId;
const conversationB = `lc_${"b".repeat(43)}` as OpaqueConversationId;
const conversationC = `lc_${"c".repeat(43)}` as OpaqueConversationId;

function handshake(rendererRef: OpaqueRendererRef, appToolsRef: OpaqueAppToolsRef, nonce: string, clientKind: "chatgpt" | "tweakers" = "chatgpt"): BrokerHandshakeV1 {
  const unsigned = { version: 1 as const, clientKind, rendererRef, appToolsRef, nonce };
  return { ...unsigned, proof: createBrokerHandshakeProof(secret, unsigned) };
}

function invoke(broker: AccountsBrokerV1, rendererRef: OpaqueRendererRef, requestId: string, command: BrokerCommandV1, params?: unknown) {
  return broker.invoke(rendererRef, { version: 1, requestId, command, ...(params === undefined ? {} : { params }) });
}

function setQuota(
  broker: AccountsBrokerV1,
  opaqueAccountId: OpaqueAccountId,
  freshness: "fresh" | "stale" | "unknown" = "fresh",
  remainingPercent: number | null = 80,
): void {
  assert.equal(broker.updateQuota({
    opaqueAccountId,
    freshness,
    remainingPercent,
    resetAt: "2099-01-01T00:00:00.000Z",
    shortWindowPressure: remainingPercent === 0 ? 100 : 0,
    resetCredits: 99,
  }), true);
}

test("broker accepts only authenticated compatible clients and emits targeted redacted events", async () => {
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret,
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "a".repeat(32))).ok, true);
  assert.equal(broker.handshake(handshake(rendererB, appToolsB, "b".repeat(32), "tweakers")).ok, true);
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "a".repeat(32))).ok, false, "a handshake nonce is one-use");

  const events: unknown[] = [];
  const unsubscribe = broker.subscribe(rendererA, (event) => events.push(event));
  const profile = await invoke(broker, rendererA, "profile_1", "profile.read");
  assert.equal(profile.ok, true);
  assert.equal(broker.updateQuota({
    opaqueAccountId: accountA,
    freshness: "fresh",
    remainingPercent: 80,
    resetAt: "2026-09-03T00:00:00.000Z",
    shortWindowPressure: null,
    resetCredits: null,
  }), true);
  const replay = await invoke(broker, rendererA, "profile_1", "profile.read");
  assert.deepEqual(replay, { version: 1, requestId: "profile_1", ok: false, error: { code: "request_replayed", retryable: false } });
  assert.equal(events.length >= 1, true);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(JSON.stringify(events).includes("auth.json"), false);
  unsubscribe();
});

test("main-only browser methods never execute through the public broker command path", async () => {
  let dispatched = false;
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: accountA, enabled: true }], secret,
    onDeviceAction: () => { dispatched = true; return { outcome: "accepted", value: {} }; } });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "browser-private".padEnd(32, "x"))).ok, true);
  const response = await invoke(broker, rendererA, "browser-direct", "native.request", {
    opaqueAccountId: accountA, surface: "plugins", method: "browser.sync", params: {},
  });
  assert.equal(response.ok, false);
  assert.equal(dispatched, false);
});

test("connection reads broadcast only semantic provider changes, including removals and the first outage", async () => {
  const definition = `bd_${"p".repeat(43)}` as OpaqueConnectionDefinitionRef;
  const second = `bd_${"q".repeat(43)}` as OpaqueConnectionDefinitionRef;
  let now = 1_000;
  let unavailable = false;
  let rows = [{ definitionRef: definition, status: "connected", displayLabel: "Plugin" }];
  const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId: accountA, enabled: true }], secret, now: () => now,
    onDeviceAction: () => unavailable ? { outcome: "rejected" } : { outcome: "accepted", value: rows },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "connection-semantics".padEnd(32, "a"))).ok, true);
  const events: BrokerEventV1[] = [];
  const stop = broker.subscribe(rendererA, (event) => { if (event.type === "connection") events.push(event); });
  let nonce = 0;
  const read = (status = false) => invoke(broker, rendererA, `connection-${++nonce}`, status ? "connection.status" : "connection.list",
    { opaqueAccountId: accountA, kind: "plugin", ...(status ? { definitionRef: definition } : {}) });
  assert.equal((await read()).ok, true);
  assert.equal(events.length, 1);
  now = 2_000;
  const repeated = await read();
  assert.equal(repeated.ok, true);
  assert.equal(repeated.ok ? (repeated.result as Array<{ updatedAt: string }>)[0]?.updatedAt : null, "1970-01-01T00:00:02.000Z");
  assert.equal((await read(true)).ok, true);
  assert.equal(events.length, 1, "fresh timestamps and identical status reads must not retrigger consumers");
  rows = [{ ...rows[0]!, displayLabel: "Renamed" }]; await read();
  assert.equal(events.length, 2);
  rows = [{ ...rows[0]!, status: "blocked" }]; await read(true);
  assert.equal(events.length, 3);
  rows.push({ definitionRef: second, status: "connected", displayLabel: "Second" }); await read();
  assert.equal(events.length, 4);
  rows.reverse(); await read();
  assert.equal(events.length, 4, "provider row order is not a semantic change");
  unavailable = true; await read();
  assert.equal(events.length, 5);
  now = 3_000; await read(); await read(true);
  assert.equal(events.length, 5, "repeated failed plugin reads must not create an unavailable feedback loop");
  unavailable = false; rows = [{ definitionRef: definition, status: "connected", displayLabel: "Plugin" }]; await read();
  assert.equal(events.length, 6, "recovery and membership removal remain observable");
  rows = []; await read();
  assert.equal(events.length, 7);
  assert.deepEqual(events.at(-1)?.payload, [], "removal of the final connection publishes an authoritative empty snapshot");
  await read();
  assert.equal(events.length, 7);
  stop();
});

test("a plugin outage preserves only that account's cached definitions and marks them unavailable", async () => {
  const definition = `bd_${"p".repeat(43)}` as OpaqueConnectionDefinitionRef;
  let attempts = 0;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret,
    now: () => 1_000,
    onDeviceAction(action) {
      if (action.kind !== "connection.list") return { outcome: "rejected" };
      attempts += 1;
      return attempts === 1
        ? { outcome: "accepted", value: [{ definitionRef: definition, status: "connected" }] }
        : { outcome: "rejected" };
    },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "plugin-cache-a".padEnd(32, "a"))).ok, true);

  const first = await invoke(broker, rendererA, "plugin_list_1", "connection.list", { opaqueAccountId: accountA, kind: "plugin" });
  assert.equal(first.ok, true);
  assert.equal(first.ok ? (first.result as Array<{ status: string }>)[0]?.status : null, "connected");

  const unavailable = await invoke(broker, rendererA, "plugin_list_2", "connection.list", { opaqueAccountId: accountA, kind: "plugin" });
  assert.equal(unavailable.ok, true);
  const rows = unavailable.ok ? unavailable.result as Array<{
    opaqueAccountId: OpaqueAccountId;
    kind: string;
    definitionRef: OpaqueConnectionDefinitionRef;
    status: string;
    updatedAt: string;
  }> : [];
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0] && {
    opaqueAccountId: rows[0].opaqueAccountId,
    kind: rows[0].kind,
    definitionRef: rows[0].definitionRef,
    status: rows[0].status,
  }, { opaqueAccountId: accountA, kind: "plugin", definitionRef: definition, status: "unavailable" });
  assert.equal(rows[0]?.updatedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(broker.connectionStates().some((row) => row.opaqueAccountId === accountB), false, "another login is never used as a cache fallback");
});

test("broker keeps one account-local remote-control-disabled child per enabled subscription", () => {
  let now = 1_000;
  const creates: Array<{ opaqueAccountId: OpaqueAccountId; remoteControlDisabled: true; storageScope: "account_local" }> = [];
  const terminated: Array<{ opaqueAccountId: OpaqueAccountId; reason: string }> = [];
  const childFactory: BrokerChildFactoryV1 = {
    create(input) {
      creates.push(input);
      return {
        opaqueAccountId: input.opaqueAccountId,
        remoteControlDisabled: true,
        terminate(reason) { terminated.push({ opaqueAccountId: input.opaqueAccountId, reason }); },
      };
    },
  };
  const broker = new AccountsBrokerV1({
    accounts: [
      { opaqueAccountId: accountA, enabled: true },
      { opaqueAccountId: accountB, enabled: true },
      { opaqueAccountId: accountC, enabled: true },
    ],
    secret,
    childFactory,
    now: () => now,
    idleEvictionMs: 1_000,
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "c".repeat(32))).ok, true);
  assert.ok(broker.registerTask({ taskRef: `bt_${"1".repeat(43)}` as OpaqueTaskRef, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  assert.ok(broker.registerTask({ taskRef: `bt_${"2".repeat(43)}` as OpaqueTaskRef, conversationId: conversationB, opaqueAccountId: accountB, ownerRendererRef: rendererA }));
  assert.ok(broker.registerTask({ taskRef: `bt_${"3".repeat(43)}` as OpaqueTaskRef, conversationId: conversationC, opaqueAccountId: accountC, ownerRendererRef: rendererA }));
  const taskA = `bt_${"1".repeat(43)}` as OpaqueTaskRef;
  const taskB = `bt_${"2".repeat(43)}` as OpaqueTaskRef;
  const taskC = `bt_${"3".repeat(43)}` as OpaqueTaskRef;
  assert.equal(broker.beginRun(taskA), true);
  assert.equal(broker.beginRun(taskB), true);
  assert.equal(broker.beginRun(taskC), true, "three enabled subscriptions may run concurrently");
  assert.equal(broker.pool().residentChildren, 3);
  assert.equal(broker.finishRun(taskA), true);
  assert.deepEqual(creates.map((entry) => entry.remoteControlDisabled), [true, true, true]);
  assert.deepEqual(terminated, []);
  assert.equal(broker.finishRun(taskB), true);
  assert.equal(broker.finishRun(taskC), true);
  now += 1_001;
  broker.sweep();
  assert.deepEqual(terminated, [], "enabled resident subscriptions are not evicted by the idle sweep");
});

test("disabling an account evicts an idle child immediately but lets an active run finish first", async () => {
  const terminated: string[] = [];
  const task = `bt_${"d".repeat(43)}` as OpaqueTaskRef;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }],
    secret,
    childFactory: {
      create(input) {
        return {
          opaqueAccountId: input.opaqueAccountId,
          remoteControlDisabled: true,
          terminate(reason) { terminated.push(reason); },
        };
      },
    },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "disable-active".padEnd(32, "a"))).ok, true);
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  assert.ok(broker.acquireChild(accountA));

  const idleDisable = await invoke(broker, rendererA, "disable_idle", "enabled.set", { opaqueAccountId: accountA, enabled: false });
  assert.equal(idleDisable.ok, true);
  assert.deepEqual(terminated, ["disabled"]);
  assert.equal(broker.pool().accounts[0]?.childState, "evicted");

  const reenable = await invoke(broker, rendererA, "reenable", "enabled.set", { opaqueAccountId: accountA, enabled: true });
  assert.equal(reenable.ok, true);
  assert.equal(broker.beginRun(task), true);
  const activeDisable = await invoke(broker, rendererA, "disable_active", "enabled.set", { opaqueAccountId: accountA, enabled: false });
  assert.equal(activeDisable.ok, true);
  assert.deepEqual(terminated, ["disabled"], "the active child remains pinned");
  assert.ok(broker.acquireChild(accountA), "owner control retains the existing resident while disabled");
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }), "the existing owner binding remains usable");
  assert.equal(broker.registerTask({ taskRef: `bt_${"e".repeat(43)}` as OpaqueTaskRef, conversationId: conversationB, opaqueAccountId: accountA, ownerRendererRef: rendererA }), null, "disable still prohibits new task allocation");
  assert.equal(broker.taskOwnership(task)?.activeRunCount, 1);
  assert.equal(broker.finishRun(task), true);
  assert.deepEqual(terminated, ["disabled", "disabled"]);
  assert.equal(broker.pool().accounts[0]?.state, "disabled");
  assert.equal(broker.pool().accounts[0]?.childState, "evicted");
});

test("handoff holds continuation only in memory, keeps native ownership immutable, and never retries ambiguity", async () => {
  let now = 10_000;
  let deliveries = 0;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret,
    now: () => now,
    handoffTtlMs: 60_000,
    onForwardContinuation: () => {
      deliveries += 1;
      return "delivered";
    },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "d".repeat(32))).ok, true);
  setQuota(broker, accountB);
  const task = `bt_${"t".repeat(43)}` as OpaqueTaskRef;
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA, privateThreadKey: "internal-thread-only" }));
  const held = broker.holdContinuation({ fromRendererRef: rendererA, taskRef: task, toOpaqueAccountId: accountB, continuation: { never: "rendered" } });
  assert.ok(held);
  assert.equal(JSON.stringify(held).includes("never"), false, "continuation data has no public projection");
  const confirmed = await invoke(broker, rendererA, "handoff_1", "handoff.confirm", { handoffRef: held?.handoffRef });
  assert.equal(confirmed.ok, true);
  assert.equal(deliveries, 1);
  assert.equal(broker.taskOwnership(task)?.opaqueAccountId, accountA, "a handoff creates a later physical segment; it never reassigns the source task");
  assert.equal(broker.taskOwnership(task)?.ownerRendererRef, rendererA, "the originating desktop remains the app-tools owner");
  const duplicate = await invoke(broker, rendererA, "handoff_2", "handoff.confirm", { handoffRef: held?.handoffRef });
  assert.equal(duplicate.ok, false);
  assert.equal(deliveries, 1, "a resolved handoff cannot send a continuation twice");

  const expiryTask = `bt_${"x".repeat(43)}` as OpaqueTaskRef;
  assert.ok(broker.registerTask({ taskRef: expiryTask, conversationId: conversationB, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  const expiring = broker.holdContinuation({ fromRendererRef: rendererA, taskRef: expiryTask, toOpaqueAccountId: accountB, continuation: { private: true } });
  now += 60_001;
  broker.sweep();
  assert.equal(broker.taskOwnership(expiryTask)?.opaqueAccountId, accountA, "timeout leaves the old account owner intact");
  assert.equal(broker.pendingHandoff(expiring!.handoffRef), null);

  let ambiguousDeliveries = 0;
  const ambiguous = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret,
    onForwardContinuation: () => {
      ambiguousDeliveries += 1;
      return "ambiguous";
    },
  });
  assert.equal(ambiguous.handshake(handshake(rendererA, appToolsA, "f".repeat(32))).ok, true);
  setQuota(ambiguous, accountB);
  const ambiguousTask = `bt_${"y".repeat(43)}` as OpaqueTaskRef;
  assert.ok(ambiguous.registerTask({ taskRef: ambiguousTask, conversationId: conversationC, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  const ambiguousHeld = ambiguous.holdContinuation({ fromRendererRef: rendererA, taskRef: ambiguousTask, toOpaqueAccountId: accountB, continuation: { private: true } });
  const result = await invoke(ambiguous, rendererA, "handoff_3", "handoff.confirm", { handoffRef: ambiguousHeld!.handoffRef });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, "handoff_ambiguous");
  assert.equal(ambiguous.taskOwnership(ambiguousTask)?.opaqueAccountId, accountA, "ambiguous delivery retains the old durable account owner");
  assert.equal(ambiguousDeliveries, 1);
  const retry = await invoke(ambiguous, rendererA, "handoff_4", "handoff.confirm", { handoffRef: ambiguousHeld!.handoffRef });
  assert.equal(retry.ok, false);
  assert.equal(ambiguousDeliveries, 1, "ambiguous forwarding is terminal and unreplayed");
});

test("handoff retargets only before dispatch and reports a proven nonportable rejection without false ambiguity", async () => {
  let selected: OpaqueAccountId | null = null;
  let settlement: string | null = null;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }, { opaqueAccountId: accountC, enabled: true }],
    secret,
    onForwardContinuation: (delivery) => {
      selected = delivery.toOpaqueAccountId;
      return "rejected";
    },
    onHandoffSettled: (_handoff, state) => { settlement = state; },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "g".repeat(32))).ok, true);
  setQuota(broker, accountB);
  setQuota(broker, accountC);
  const task = `bt_${"z".repeat(43)}` as OpaqueTaskRef;
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  const held = broker.holdContinuation({ fromRendererRef: rendererA, taskRef: task, toOpaqueAccountId: accountB, continuation: { private: true } });
  assert.ok(held);
  const result = await invoke(broker, rendererA, "handoff_retarget", "handoff.confirm", { handoffRef: held!.handoffRef, toOpaqueAccountId: accountC });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, "handoff_unavailable");
  assert.equal(selected, accountC);
  assert.equal(settlement, "rejected");
  assert.equal(broker.pendingHandoff(held!.handoffRef), null);
  assert.equal(broker.taskOwnership(task)?.handoffState, "none");
});

test("handoff confirmation and manual retarget require fresh positive target quota at dispatch", async () => {
  const delivered: OpaqueAccountId[] = [];
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }, { opaqueAccountId: accountC, enabled: true }],
    secret,
    onForwardContinuation: (delivery) => {
      delivered.push(delivery.toOpaqueAccountId);
      return "delivered";
    },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "quota-recheck".padEnd(32, "q"))).ok, true);
  setQuota(broker, accountB, "fresh", 80);
  setQuota(broker, accountC, "stale", 80);
  const task = `bt_${"v".repeat(43)}` as OpaqueTaskRef;
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  const held = broker.holdContinuation({ fromRendererRef: rendererA, taskRef: task, toOpaqueAccountId: accountB, continuation: { private: true } });
  assert.ok(held);

  // The proposed default becomes zero before the user confirms: no provider
  // delivery and no implicit credit-based bypass are permitted.
  setQuota(broker, accountB, "fresh", 0);
  const depleted = await invoke(broker, rendererA, "handoff-quota-zero", "handoff.confirm", { handoffRef: held.handoffRef });
  assert.equal(depleted.ok, false);
  assert.equal(depleted.ok ? null : depleted.error.code, "handoff_unavailable");
  assert.deepEqual(delivered, []);
  assert.equal(broker.pendingHandoff(held.handoffRef)?.toOpaqueAccountId, accountB);

  // A manually selected stale destination is rejected before it can replace
  // the original target or reach the forwarding callback.
  setQuota(broker, accountB, "fresh", 80);
  const staleRetarget = await invoke(broker, rendererA, "handoff-stale-retarget", "handoff.confirm", {
    handoffRef: held.handoffRef,
    toOpaqueAccountId: accountC,
  });
  assert.equal(staleRetarget.ok, false);
  assert.equal(staleRetarget.ok ? null : staleRetarget.error.code, "handoff_unavailable");
  assert.deepEqual(delivered, []);
  assert.equal(broker.pendingHandoff(held.handoffRef)?.toOpaqueAccountId, accountB);

  setQuota(broker, accountC, "fresh", 40);
  const confirmed = await invoke(broker, rendererA, "handoff-fresh-retarget", "handoff.confirm", {
    handoffRef: held.handoffRef,
    toOpaqueAccountId: accountC,
  });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(delivered, [accountC]);
});

test("a host-proven linked continuation requirement is distinct from an ordinary rejected handoff", async () => {
  let settlement: string | null = null;
  let forwards = 0;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret,
    onForwardContinuation: () => {
      forwards += 1;
      return "linked_continuation_required";
    },
    onHandoffSettled: (_handoff, state) => { settlement = state; },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "h".repeat(32))).ok, true);
  setQuota(broker, accountB);
  const task = `bt_${"q".repeat(43)}` as OpaqueTaskRef;
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  const held = broker.holdContinuation({ fromRendererRef: rendererA, taskRef: task, toOpaqueAccountId: accountB, continuation: { private: "never projected" } });
  assert.ok(held);
  const result = await invoke(broker, rendererA, "handoff_linked", "handoff.confirm", { handoffRef: held.handoffRef });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, "linked_continuation_required");
  assert.equal(result.ok ? null : result.error.retryable, false);
  assert.equal(forwards, 1);
  assert.equal(settlement, "linked_continuation_required");
  assert.equal(broker.pendingHandoff(held.handoffRef), null);
  assert.equal(broker.taskOwnership(task)?.handoffState, "none");
});

test("automatic failover requires confirmed depletion and never retries an uncertain continuation", async () => {
  const now = 10_000;
  let deliveries = 0;
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret, now: () => now, onForwardContinuation: () => { deliveries++; return "ambiguous"; },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "automatic".padEnd(32, "a"))).ok, true);
  setQuota(broker, accountB);
  const task = `bt_${"m".repeat(43)}` as OpaqueTaskRef;
  assert.ok(broker.registerTask({ taskRef: task, conversationId: conversationA, opaqueAccountId: accountA, ownerRendererRef: rendererA }));
  const held = broker.holdContinuation({ fromRendererRef: rendererA, taskRef: task, toOpaqueAccountId: accountB, continuation: { input: [] } });
  assert.ok(held);
  assert.equal(await broker.continueAutomatically(rendererA, held.handoffRef), false);
  assert.equal(deliveries, 0, "unknown quota cannot trigger automatic movement");
  broker.updateQuota({ opaqueAccountId: accountA, freshness: "fresh", remainingPercent: 0, resetAt: new Date(now + 60_000).toISOString(), shortWindowPressure: 0, resetCredits: 0, observedAt: now });
  assert.equal(await broker.continueAutomatically(rendererA, held.handoffRef), false);
  assert.equal(deliveries, 1);
  assert.equal(await broker.continueAutomatically(rendererA, held.handoffRef), false);
  assert.equal(deliveries, 1);
  assert.equal(broker.taskOwnership(task)?.handoffState, "ambiguous");
});


test("cached profiles return immediately while one shared refresh updates each account in place", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolvePromise) => { finish = resolvePromise; });
  let calls = 0;
  const cached = { plan: "plus", identifierMasked: null, avatarUrl: null };
  const fresh = { plan: "pro", identifierMasked: null, avatarUrl: null };
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true, safeProfile: cached }, { opaqueAccountId: accountB, enabled: true, safeProfile: cached }],
    secret,
    onDeviceAction: async (action) => {
      if (action.kind !== "profile.read") return { outcome: "rejected" };
      calls += 1;
      await gate;
      return { outcome: "accepted", value: fresh };
    },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "p".repeat(32))).ok, true);
  const events: any[] = [];
  const unsubscribe = broker.subscribe(rendererA, (event) => events.push(event));
  try {
    const first = await Promise.race([invoke(broker, rendererA, "cached-first", "profile.read"), new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 100))]);
    assert.ok(first, "cold provider reads must not delay cached profile response");
    assert.equal(first.ok, true);
    if (first.ok) assert.equal((first.result as any).accounts[0].safeProfile.plan, "plus");
    await invoke(broker, rendererA, "cached-second", "profile.read");
    assert.equal(calls, 2, "concurrent profile reads share one refresh per account");
    await invoke(broker, rendererA, "disable-during-refresh", "enabled.set", { opaqueAccountId: accountB, enabled: false });
    finish();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(broker.pool().accounts.find((account) => account.opaqueAccountId === accountA)?.safeProfile.plan, "pro");
    assert.equal(broker.pool().accounts.find((account) => account.opaqueAccountId === accountB)?.safeProfile.plan, "plus", "disabled account ignores an in-flight refresh");
    assert.ok(events.some((event) => event.type === "profile" || event.kind === "profile"));
  } finally { finish(); unsubscribe(); broker.close(); }
});

test("all-account quota refreshes coalesce per account and preserve successful cached rows on partial failure", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const broker = new AccountsBrokerV1({
    accounts: [{ opaqueAccountId: accountA, enabled: true }, { opaqueAccountId: accountB, enabled: true }],
    secret,
    onDeviceAction: async (action) => {
      if (action.kind !== "quota.read") return { outcome: "rejected" };
      calls += 1;
      await gate;
      return action.opaqueAccountId === accountA
        ? { outcome: "accepted", value: { freshness: "fresh", remainingPercent: 90, resetAt: "2099-01-01T00:00:00.000Z", shortWindowPressure: 5, resetCredits: 1 } }
        : { outcome: "rejected" };
    },
  });
  assert.equal(broker.handshake(handshake(rendererA, appToolsA, "quota-refresh".padEnd(32, "q"))).ok, true);
  const first = invoke(broker, rendererA, "quota-all-1", "quota.read");
  const second = invoke(broker, rendererA, "quota-all-2", "quota.read");
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(calls, 2, "concurrent callers share one refresh for each account");
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  const rows = broker.quota();
  assert.equal(rows.find((row) => row.opaqueAccountId === accountA)?.remainingPercent, 90);
  assert.equal(rows.find((row) => row.opaqueAccountId === accountA)?.refreshState, "idle");
  assert.equal(rows.find((row) => row.opaqueAccountId === accountB)?.refreshState, "error");
});

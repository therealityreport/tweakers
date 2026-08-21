import assert from "node:assert/strict";
import test from "node:test";
import { readRouterLaunchSelection, validateRouterConfig } from "../../src/account-router/config";
import { CorrelationTable, classifyClientMethod, classifyServerNotification, parseJsonRpcLine } from "../../src/account-router/protocol";
import { assertRedacted, redactedRouterError, serializeRedactedStatus } from "../../src/account-router/redaction";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;

function config(): RouterConfig {
  return {
    schemaVersion: 1,
    mode: "balanced",
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
      { opaqueAccountId: accountB, included: true, weight: 2, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
    ],
    updatedAt: "2026-08-19T12:00:00Z",
  };
}

test("router config is strict, balanced-only, and never accepts secret fields", () => {
  assert.deepEqual(validateRouterConfig(config()), config());
  assert.equal(validateRouterConfig({ ...config(), accessToken: "synthetic" }), null);
  assert.equal(validateRouterConfig({ ...config(), protocolFingerprint: `sha256:${"0".repeat(64)}` }), null);
  assert.equal(validateRouterConfig({ ...config(), accounts: [config().accounts[0], config().accounts[0]] }), null);
  assert.equal(validateRouterConfig({ ...config(), primaryOpaqueAccountId: accountB, accounts: [config().accounts[0], { ...config().accounts[1], included: false }] }), null);
  const selected = readRouterLaunchSelection("/private/router.json", () => JSON.stringify(config()), () => true);
  assert.equal(selected.mode, "mux");
  assert.equal(selected.reason, "balanced");
  const manual = readRouterLaunchSelection("/private/router.json", () => JSON.stringify({ ...config(), mode: "manual" }), () => true);
  assert.deepEqual({ mode: manual.mode, reason: manual.reason }, { mode: "direct", reason: "manual" });
});

test("correlation ids preserve JSON id type, are single-use, and reject the wrong child", () => {
  const persisted: unknown[][] = [];
  const table = new CorrelationTable([], (records) => persisted.push(records));
  const client = table.create("client_to_child", accountA, 7, "thread/start");
  assert.equal(client.internalId, "ar1:c:1");
  assert.equal(table.mark(client.internalId, "written")?.dispatchState, "written");
  assert.equal(table.consume(client.internalId, "client_to_child", accountB), null);
  assert.equal(table.consume(client.internalId, "client_to_child", accountA)?.originalId, 7);
  const server = table.create("child_to_client", accountB, "child-request", "item/tool/call");
  assert.equal(server.internalId, "ar1:s:2");
  assert.equal(table.consume(server.internalId, "child_to_client", accountB)?.originalId, "child-request");
  assert.throws(() => table.create("client_to_child", accountA, Number.MAX_SAFE_INTEGER + 1, "thread/start"));
  assert.ok(persisted.length >= 4);
});

test("only the frozen generated method inventory can route", () => {
  assert.equal(classifyClientMethod("thread/start"), "balance_new_thread");
  assert.equal(classifyClientMethod("turn/interrupt", { threadId: "thread-1" }), "persisted_thread_owner");
  assert.equal(classifyClientMethod("future/unknown"), "unknown");
  assert.equal(classifyServerNotification("turn/completed", { threadId: "thread-1" }), "verify_persisted_owner_then_forward");
  assert.equal(classifyServerNotification("future/unknown"), "unknown");
  assert.equal(parseJsonRpcLine('{"id":1.25,"method":"thread/start"}'), null);
  assert.equal(parseJsonRpcLine('{"id":"a","method":"thread/start"}')?.id, "a");
});

test("control output rejects secret-shaped keys and values while retaining opaque status", () => {
  assert.throws(() => assertRedacted({ accessToken: "synthetic" }), /redaction/);
  assert.throws(() => assertRedacted({ message: "Bearer synthetic" }), /redaction/);
  const status = serializeRedactedStatus({
    schemaVersion: 1, mode: "balanced", protocolState: "supported", fairnessPrecision: "exact_completed_spend",
    accounts: [{ opaqueAccountId: accountA, label: "Account A", eligibility: "eligible", normalizedSpend: 0, assignedThreadCount: 0 }],
    restartRequired: false, degradedReason: null,
  });
  assert.equal(status.includes("accessToken"), false);
  assert.deepEqual(redactedRouterError(1, "pool_depleted").error.data, { code: "pool_depleted" });
});

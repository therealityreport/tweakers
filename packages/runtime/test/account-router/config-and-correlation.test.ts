import assert from "node:assert/strict";
import test from "node:test";
import { readRouterLaunchSelection, routerConfigFingerprint, validateRouterConfig } from "../../src/account-router/config";
import { CorrelationTable, classifyClientMethod, classifyServerNotification, parseJsonRpcLine } from "../../src/account-router/protocol";
import { assertRedacted, redactedRouterError, serializeRedactedStatus } from "../../src/account-router/redaction";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig, type RouterConfigV2, type RouterConfigV3 } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;
const sharedV2AccountA = `ar_${"a".repeat(43)}` as const;
const sharedV2AccountB = `ar_${"c".repeat(43)}` as const;
const sharedV3AccountC = `ar_${"e".repeat(43)}` as const;

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

function poolConfig(): RouterConfigV3 {
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation: 8,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: sharedV2AccountA,
    accounts: [
      { opaqueAccountId: sharedV2AccountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Alpha" },
      { opaqueAccountId: sharedV2AccountB, included: false, weight: 1, capabilityFingerprint: `sha256:${"d".repeat(64)}`, label: "Beta" },
      { opaqueAccountId: sharedV3AccountC, included: true, weight: 1, capabilityFingerprint: `sha256:${"e".repeat(64)}`, label: "Gamma" },
    ],
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

function quotaConfig(): RouterConfigV2 {
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2,
    mode: "quota_aware",
    policy: "quota_aware_v1",
    generation: 7,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: sharedV2AccountA,
    accounts: [
      { opaqueAccountId: sharedV2AccountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Alpha" },
      { opaqueAccountId: sharedV2AccountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"d".repeat(64)}`, label: "Beta" },
    ],
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

test("router config keeps v1 readable but requires v2 signed-adoption startup", () => {
  assert.deepEqual(validateRouterConfig(config()), config());
  assert.equal(validateRouterConfig({ ...config(), accessToken: "synthetic" }), null);
  assert.equal(validateRouterConfig({ ...config(), protocolFingerprint: `sha256:${"0".repeat(64)}` }), null);
  assert.equal(validateRouterConfig({ ...config(), accounts: [config().accounts[0], config().accounts[0]] }), null);
  assert.equal(validateRouterConfig({ ...config(), primaryOpaqueAccountId: accountB, accounts: [config().accounts[0], { ...config().accounts[1], included: false }] }), null);
  const selected = readRouterLaunchSelection("/private/router.json", () => JSON.stringify(config()), () => true);
  assert.equal(selected.mode, "direct");
  assert.equal(selected.reason, "history-adoption-required");
  const manual = readRouterLaunchSelection("/private/router.json", () => JSON.stringify({ ...config(), mode: "manual" }), () => true);
  assert.deepEqual({ mode: manual.mode, reason: manual.reason }, { mode: "direct", reason: "history-adoption-required" });
});

test("v2 config fixes exactly two labelled accounts and has a stable cross-writer fingerprint", () => {
  const quota = quotaConfig();
  // This literal is the canonical recursive-key-sort vector shared with the
  // tweak writer. A plain insertion-ordered JSON.stringify would differ.
  assert.equal(quota.fingerprint, "sha256:b26118045c98f42a6dcd1e53ba871d63b1a4b23b4aaf8f35969645bf719826b7");
  assert.deepEqual(validateRouterConfig(quota), quota);
  assert.equal(validateRouterConfig({ ...quota, fingerprint: `sha256:${"0".repeat(64)}` }), null);
  assert.equal(validateRouterConfig({ ...quota, generation: 0 }), null);
  assert.equal(validateRouterConfig({ ...quota, updatedAt: "2026-02-30T12:00:00.000Z" }), null, "impossible UTC calendar dates are rejected");
  assert.equal(validateRouterConfig({ ...quota, updatedAt: "2026-08-31T12:00:00.0Z" }), null, "v2 timestamps use exact millisecond UTC form");
  assert.equal(validateRouterConfig({ ...quota, accounts: [{ ...quota.accounts[0], label: "Alpha" }, { ...quota.accounts[1], included: false }] }), null);
  assert.equal(validateRouterConfig({ ...quota, accounts: quota.accounts.map(({ label: _label, ...account }) => account) }), null);
  const selected = readRouterLaunchSelection("/private/router.json", () => JSON.stringify(quota), () => true);
  assert.deepEqual({ mode: selected.mode, reason: selected.reason }, { mode: "mux", reason: "quota_aware" });
  const manualDraft = { ...quota, mode: "manual" as const, policy: null, generation: 8 };
  const manual = { ...manualDraft, fingerprint: routerConfigFingerprint(manualDraft) };
  assert.deepEqual({ mode: readRouterLaunchSelection("/private/router.json", () => JSON.stringify(manual), () => true).mode,
    reason: readRouterLaunchSelection("/private/router.json", () => JSON.stringify(manual), () => true).reason }, { mode: "mux", reason: "manual" });
});

test("v3 config supports three or more accounts and preserves disabled enrollment", () => {
  const pool = poolConfig();
  assert.deepEqual(validateRouterConfig(pool), pool);
  assert.deepEqual(
    { mode: readRouterLaunchSelection("/private/router.json", () => JSON.stringify(pool), () => true).mode,
      reason: readRouterLaunchSelection("/private/router.json", () => JSON.stringify(pool), () => true).reason },
    { mode: "mux", reason: "quota_aware" },
  );
  const noneEnabledDraft = { ...pool, accounts: pool.accounts.map((account) => ({ ...account, included: false })) };
  assert.equal(validateRouterConfig({ ...noneEnabledDraft, fingerprint: routerConfigFingerprint(noneEnabledDraft) }), null);
  const disabledPrimaryDraft = { ...pool, accounts: pool.accounts.map((account, index) => ({ ...account, included: index !== 0 })) };
  assert.equal(validateRouterConfig({ ...disabledPrimaryDraft, fingerprint: routerConfigFingerprint(disabledPrimaryDraft) }), null);
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
  assert.equal(classifyClientMethod("threadSection/list"), "fanout_sections_read");
  assert.equal(classifyClientMethod("thread/section/move", { threadId: "thread-1", sectionId: "section-1" }), "reject_sections_read_only");
  assert.equal(classifyClientMethod("thread/list", { sectionId: "section-1" }), "fanout_aggregate_read_with_router_cursor");
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

import assert from "node:assert/strict";
import test from "node:test";
import { AccountsBrokerV1, createBrokerHandshakeProof } from "../../src/account-router/broker";
import { AccountsBrokerRendererAdapterV1 } from "../../src/account-router/broker-adapter";
import { routerConfigFingerprint, validateRouterConfig } from "../../src/account-router/config";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type BrokerBalanceProjectionV1, type OpaqueAccountId, type OpaqueRendererRef, type OpaqueAppToolsRef } from "../../src/account-router/types";

const account = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const second = `ar_${"b".repeat(43)}` as OpaqueAccountId;
const renderer = `br_${"r".repeat(43)}` as OpaqueRendererRef;
const appTools = `bat_${"t".repeat(43)}` as OpaqueAppToolsRef;

test("balance policy is explicit, fingerprint-bound, and v3 only", () => {
  const draft = { schemaVersion: 3 as const, mode: "quota_aware" as const, policy: "balanced_tokens_v1" as const,
    generation: 1, protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: account,
    accounts: [account, second].map((opaqueAccountId, i) => ({ opaqueAccountId, included: true, weight: 1,
      label: `Account ${i + 1}`, capabilityFingerprint: `sha256:${"c".repeat(64)}` as const })), updatedAt: "2026-09-05T00:00:00.000Z" };
  const config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  assert.deepEqual(validateRouterConfig(config), config);
  assert.equal(validateRouterConfig({ ...config, policy: "quota_aware_v2" }), null);
  assert.equal(validateRouterConfig({ ...config, schemaVersion: 2 }), null);
  const manual = { ...draft, mode: "manual" as const };
  assert.equal(validateRouterConfig({ ...manual, fingerprint: routerConfigFingerprint(manual) }), null);
});

test("balance controls require an exact command and expose only public account handles", async () => {
  const secret = Buffer.alloc(32, 73);
  let enabled = false;
  let mutations = 0;
  const projection = (): BrokerBalanceProjectionV1 => ({ policy: enabled ? "balanced_tokens_v1" : "quota_aware_v2",
    baselineAt: "2026-09-05T00:00:00.000Z", accounts: [
      { opaqueAccountId: account, completedTokens: 600, reservedTokens: 50, unreportedTokens: 0, sharePercent: 60, precision: "exact" },
      { opaqueAccountId: second, completedTokens: 400, reservedTokens: 0, unreportedTokens: 0, sharePercent: 40, precision: "partial" },
    ], degradedReason: "usage_unknown", nextAccountId: second });
  const broker = new AccountsBrokerV1({ secret, accounts: [account, second].map((opaqueAccountId) => ({ opaqueAccountId, enabled: true })),
    onBalanceRead: projection, onBalanceSet: (value) => { enabled = value; mutations += 1; return true; } });
  const unsigned = { version: 1 as const, clientKind: "tweakers" as const, rendererRef: renderer, appToolsRef: appTools, nonce: "n".repeat(32) };
  assert.equal(broker.handshake({ ...unsigned, proof: createBrokerHandshakeProof(secret, unsigned) }).ok, true);
  const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
    invoke: (envelope) => broker.invoke(renderer, envelope), subscribe: (handler) => broker.subscribe(renderer, handler),
  } });
  const read = await adapter.invoke({ version: 1, action: "broker", requestId: "read", command: "balance.read" });
  assert.equal(read.ok, true);
  assert.doesNotMatch(JSON.stringify(read), /ar_|threadId|auth|credential/);
  assert.match(JSON.stringify(read), /account_/);
  const invalid = await adapter.invoke({ version: 1, action: "broker", requestId: "invalid", command: "balance.set", params: { enabled: true, accountId: account } });
  assert.equal(invalid.ok, false);
  assert.equal(mutations, 0);
  const changed = await adapter.invoke({ version: 1, action: "broker", requestId: "set", command: "balance.set", params: { enabled: true } });
  assert.equal(changed.ok, true);
  assert.equal(mutations, 1);
  assert.match(JSON.stringify(changed), /balanced_tokens_v1/);
  await broker.close();
});

test("balance adapter rejects invalid counters and private extra fields", async () => {
  const secret = Buffer.alloc(32, 74);
  for (const row of [
    { opaqueAccountId: account, completedTokens: -1, reservedTokens: 0, unreportedTokens: 0, sharePercent: 100, precision: "exact" },
    { opaqueAccountId: account, completedTokens: 1, reservedTokens: 0, unreportedTokens: 0, sharePercent: 100, precision: "exact", threadId: "private" },
  ]) {
    const adapter = new AccountsBrokerRendererAdapterV1({ secret, client: {
      invoke: async (envelope) => ({ version: 1, requestId: envelope.requestId, ok: true, result: {
        policy: "balanced_tokens_v1", baselineAt: null, accounts: [row], degradedReason: null, nextAccountId: account,
      } }), subscribe: () => () => {},
    } });
    assert.equal((await adapter.invoke({ version: 1, action: "broker", requestId: "read", command: "balance.read" })).ok, false);
  }
});

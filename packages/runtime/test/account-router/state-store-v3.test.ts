import assert from "node:assert/strict";
import test from "node:test";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { createInitialRouterState, migrateIdleRouterStateV3 } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfigV2, type RouterConfigV3 } from "../../src/account-router/types";

const accountA = `ar_${"a".repeat(43)}` as const;
const accountB = `ar_${"b".repeat(43)}` as const;
const accountC = `ar_${"c".repeat(43)}` as const;
const capability = (value: string) => `sha256:${value.repeat(64)}` as const;

function v2(): RouterConfigV2 {
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2, mode: "quota_aware", policy: "quota_aware_v1", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: capability("a"), label: "Alpha" },
      { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: capability("b"), label: "Beta" },
    ],
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

function v3(): RouterConfigV3 {
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    schemaVersion: 3, mode: "quota_aware", policy: "quota_aware_v2", generation: 2,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: capability("a"), label: "Alpha" },
      { opaqueAccountId: accountB, included: false, weight: 1, capabilityFingerprint: capability("b"), label: "Beta" },
      { opaqueAccountId: accountC, included: true, weight: 1, capabilityFingerprint: capability("c"), label: "Gamma" },
    ],
    updatedAt: "2026-09-01T12:01:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

test("v3 idle migration preserves ledger and sticky owners while adding and disabling accounts", () => {
  const state = createInitialRouterState(v2());
  state.accountEligibility[accountA] = "eligible";
  state.accountEligibility[accountB] = "eligible";
  state.threadOwners["thread-1"] = accountA;
  state.ledger[accountA].assignedThreadCount = 1;
  state.ledger[accountA].completedInputTokens = 42;
  const migrated = migrateIdleRouterStateV3(state, v3());
  assert.ok(migrated);
  assert.equal(migrated.threadOwners["thread-1"], accountA);
  assert.equal(migrated.ledger[accountA].completedInputTokens, 42);
  assert.equal(migrated.ledger[accountC].completedInputTokens, 0);
  assert.equal(migrated.accountEligibility[accountB], "disabled");
  assert.equal(migrated.accountEligibility[accountC], "validating");
});

test("v3 migration refuses active or ambiguous work", () => {
  const active = createInitialRouterState(v2());
  active.accountEligibility[accountA] = "active";
  assert.equal(migrateIdleRouterStateV3(active, v3()), null);
  const pending = createInitialRouterState(v2());
  pending.accountEligibility[accountA] = "eligible";
  pending.accountEligibility[accountB] = "eligible";
  pending.pendingThreadOwners.pending = accountA;
  assert.equal(migrateIdleRouterStateV3(pending, v3()), null);
  const handoff = createInitialRouterState(v2());
  handoff.accountEligibility[accountA] = "eligible";
  handoff.accountEligibility[accountB] = "eligible";
  handoff.pendingHandoffs = {
    [`bh_${"h".repeat(43)}`]: {
      version: 1,
      handoffRef: `bh_${"h".repeat(43)}`,
      taskRef: `bt_${"t".repeat(43)}`,
      originRendererRef: `br_${"r".repeat(43)}`,
      fromOpaqueAccountId: accountA,
      toOpaqueAccountId: accountB,
      state: "pending",
      expiresAt: "2026-09-03T00:00:00.000Z",
    },
  };
  assert.equal(migrateIdleRouterStateV3(handoff, v3()), null, "a payload-free pending handoff still forbids an idle migration");
});

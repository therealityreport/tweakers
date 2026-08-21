import assert from "node:assert/strict";
import test from "node:test";
import { AccountLedger } from "../../src/account-router/ledger";
import { createInitialRouterState } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig, type RouterState } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;
const config: RouterConfig = {
  schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
  accounts: [
    { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
    { opaqueAccountId: accountB, included: true, weight: 2, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
  ], updatedAt: "2026-08-19T12:00:00Z",
};

function fakeStore(initial: RouterState) {
  let state = structuredClone(initial);
  return {
    snapshot: () => structuredClone(state),
    update(mutator: (next: RouterState) => void) { const next = structuredClone(state); mutator(next); state = next; return structuredClone(state); },
  };
}

test("reservations are persisted before selection debit and reconcile exactly once", () => {
  const store = fakeStore(createInitialRouterState(config));
  store.update((state) => { state.accountEligibility[accountA] = "eligible"; state.accountEligibility[accountB] = "eligible"; });
  let randomNonce = 0;
  const ledger = new AccountLedger(store as never, config, () => ++randomNonce, () => Buffer.alloc(16, ++randomNonce));
  assert.equal(ledger.select()?.opaqueAccountId, accountA);
  const reservation = ledger.reserve(accountA, 123);
  assert.equal(store.snapshot().ledger[accountA].reservedRequestCost, 123);
  ledger.reconcile(reservation.reservationId, { inputTokens: 4, outputTokens: 9 });
  ledger.reconcile(reservation.reservationId, { inputTokens: 400, outputTokens: 900 });
  assert.deepEqual(store.snapshot().ledger[accountA], {
    completedInputTokens: 4, completedOutputTokens: 9, reservedRequestCost: 0, weight: 1, assignedThreadCount: 0,
  });
  assert.equal(ledger.estimateRequestCost({ input: "x".repeat(80) }), 32);
});

test("epoch reset refuses active durable work and keeps sticky ownership local", () => {
  const store = fakeStore(createInitialRouterState(config));
  store.update((state) => { state.accountEligibility[accountA] = "eligible"; state.accountEligibility[accountB] = "eligible"; });
  const ledger = new AccountLedger(store as never, config, () => 1, () => Buffer.alloc(16, 1));
  const reservation = ledger.reserve(accountA, 1);
  assert.throws(() => ledger.resetEpoch(), /idle/);
  ledger.releasePreDispatch(reservation.reservationId);
  ledger.reservePendingOwner("pending", accountA);
  ledger.bindThread("thread-a", accountA, "pending");
  assert.equal(ledger.ownerFor("thread-a"), accountA);
  ledger.resetEpoch();
  assert.equal(store.snapshot().epoch, 2);
});

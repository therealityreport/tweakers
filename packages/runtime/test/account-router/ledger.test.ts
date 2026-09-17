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

test("Doctor review leases are correlation-idempotent and reconcile ambiguous usage exactly once", () => {
  const store = fakeStore(createInitialRouterState(config));
  const ledger = new AccountLedger(store as never, config, () => 1, () => Buffer.alloc(16, 7));
  const digest = `hmac-sha256:${"d".repeat(43)}` as const;
  const lease = ledger.reserveDoctorReview(accountA, 90_000, digest);
  assert.deepEqual(ledger.reserveDoctorReview(accountA, 90_000, digest), lease);
  assert.equal(store.snapshot().reservations.length, 1);
  assert.equal(store.snapshot().ledger[accountA].reservedRequestCost, 90_000);
  ledger.markDoctorReviewDispatched(lease.reservationId);
  ledger.settleDoctorReview(lease.reservationId, "ambiguous");
  assert.equal(store.snapshot().reservations[0]?.state, "stranded_ambiguous");
  assert.equal(store.snapshot().ledger[accountA].reservedRequestCost, 90_000);

  ledger.settleDoctorReview(lease.reservationId, "completed", { inputTokens: 123, outputTokens: 456 });
  ledger.settleDoctorReview(lease.reservationId, "completed", { inputTokens: 123, outputTokens: 456 });
  assert.deepEqual(store.snapshot().ledger[accountA], {
    completedInputTokens: 123, completedOutputTokens: 456, reservedRequestCost: 0, weight: 1, assignedThreadCount: 0,
  });
  assert.throws(() => ledger.settleDoctorReview(lease.reservationId, "completed", { inputTokens: 123, outputTokens: 457 }), /different outcome/);
  assert.throws(() => ledger.settleDoctorReview(lease.reservationId, "ambiguous"), /different outcome/);
});

test("Doctor review recovery releases unmarked work and strands marked work", () => {
  const store = fakeStore(createInitialRouterState(config));
  let nonce = 0;
  const ledger = new AccountLedger(store as never, config, () => 1, () => Buffer.alloc(16, ++nonce));
  const unmarked = ledger.reserveDoctorReview(accountA, 10, `hmac-sha256:${"a".repeat(43)}`);
  const marked = ledger.reserveDoctorReview(accountB, 20, `hmac-sha256:${"b".repeat(43)}`);
  ledger.markDoctorReviewDispatched(marked.reservationId);
  ledger.recoverDoctorReviewReservations();
  const state = store.snapshot();
  assert.equal(state.reservations.find((entry) => entry.reservationId === unmarked.reservationId)?.state, "released_pre_dispatch");
  assert.equal(state.reservations.find((entry) => entry.reservationId === marked.reservationId)?.state, "stranded_ambiguous");
  assert.equal(state.ledger[accountA].reservedRequestCost, 0);
  assert.equal(state.ledger[accountB].reservedRequestCost, 20);
  ledger.settleDoctorReview(marked.reservationId, "pre_dispatch");
  assert.equal(store.snapshot().ledger[accountB].reservedRequestCost, 0, "durable no-CLI proof resolves a lost mark acknowledgement");
  assert.equal(store.snapshot().reservations.find((entry) => entry.reservationId === marked.reservationId)?.state, "released_pre_dispatch");
});

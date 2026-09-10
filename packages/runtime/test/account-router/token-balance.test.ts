import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  TOKEN_BALANCE_FILE_V1,
  TokenBalanceLedger,
  type TokenBalanceAccountInput,
} from "../../src/account-router/token-balance";
import type { OpaqueAccountId } from "../../src/account-router/types";

const accountA = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const accountB = `ar_${"b".repeat(43)}` as OpaqueAccountId;
const accountC = `ar_${"c".repeat(43)}` as OpaqueAccountId;

function root(): string {
  return mkdtempSync(join(tmpdir(), "token-balance-"));
}

function ledger(stateRoot: string, accounts: readonly TokenBalanceAccountInput[] = [
  { opaqueAccountId: accountA, included: true },
  { opaqueAccountId: accountB, included: true },
]): TokenBalanceLedger {
  return new TokenBalanceLedger({ root: stateRoot, accounts, now: () => 1_725_000_000_000, random: () => Buffer.alloc(18, 7) });
}

function usage(inputTokens: number, outputTokens: number): unknown {
  return { total: { inputTokens, outputTokens }, last: { inputTokens, outputTokens } };
}

test("chooses the lower projected included account and records only an explicit reservation estimate", () => {
  const balances = ledger(root());
  assert.deepEqual(balances.choose([accountA, accountB]), { opaqueAccountId: accountA, projectedTokens: 0, precision: "exact" });
  const first = balances.begin({ opaqueAccountId: accountA, reservationId: "reservation-a", estimatedTokens: 90 });
  assert.equal(first.state, "reserved");
  assert.equal(first.estimatedTokens, 90);
  assert.deepEqual(balances.choose([accountA, accountB]), { opaqueAccountId: accountB, projectedTokens: 0, precision: "exact" });
  assert.equal(balances.accountSummary(accountA)?.reservedTokens, 90);
  assert.equal(balances.accountSummary(accountA)?.estimatedTokens, 90, "the projected value is named and exposed as an estimate");
  balances.releasePreDispatch("reservation-a");
  assert.equal(balances.accountSummary(accountA)?.reservedTokens, 0);
  assert.throws(() => balances.markDispatched("reservation-a"), /terminal reservation/);
});

test("imported native history stays explicitly unmeasured while later broker work is counted from its own baseline", () => {
  const stateRoot = root();
  const balances = ledger(stateRoot);
  balances.markImportedHistoryUnmeasured([accountA]);
  balances.markImportedHistoryUnmeasured([accountA]);
  assert.equal(balances.accountSummary(accountA)?.completedTokens, 0);
  assert.equal(balances.accountSummary(accountA)?.precision, "unknown", "a pre-broker native home is never presented as exact zero-cost history");
  assert.equal(balances.accountSummary(accountB)?.precision, "exact", "only the marked native home carries the unknown historical baseline");

  balances.seedThreadBaseline({ opaqueAccountId: accountA, threadId: "new-broker-thread", tokenUsage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "new-broker-thread", tokenUsage: usage(7, 5) }).addedTokens, 12);
  assert.equal(balances.accountSummary(accountA)?.completedTokens, 12, "post-baseline broker work remains measured without importing historical usage");
  assert.equal(ledger(stateRoot).accountSummary(accountA)?.precision, "unknown", "the durable unmeasured-history marker survives owner restart");
});

test("trusted thread baselines exclude prior cumulative totals and equal updates never double count", () => {
  const balances = ledger(root());
  balances.seedThreadBaseline({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: { inputTokens: 100, outputTokens: 20 } });
  balances.begin({ opaqueAccountId: accountA, reservationId: "reservation-a", estimatedTokens: 100 });
  balances.markDispatched("reservation-a");
  balances.bind("reservation-a", { threadId: "thread-a", turnId: "turn-a" });
  assert.deepEqual(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "turn-a", tokenUsage: usage(112, 27) }), {
    addedTokens: 19, precision: "exact", reservationId: "reservation-a",
  });
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "turn-a", tokenUsage: usage(112, 27) }).addedTokens, 0);
  assert.equal(balances.accountSummary(accountA)?.completedTokens, 19);
  assert.equal(balances.accountSummary(accountA)?.completedInputTokens, 12);
  assert.equal(balances.accountSummary(accountA)?.completedOutputTokens, 7);
  balances.settle("reservation-a");
  assert.equal(balances.accountSummary(accountA)?.reservedTokens, 0);
  assert.equal(balances.accountSummary(accountA)?.precision, "exact");
});

test("an unseeded first total and last-only evidence remain visibly uncertain instead of charging history or inventing a completion id", () => {
  const balances = ledger(root());
  balances.begin({ opaqueAccountId: accountA, reservationId: "reservation-a", estimatedTokens: 64 });
  balances.markDispatched("reservation-a");
  balances.bind("reservation-a", { threadId: "existing-thread", turnId: "turn-a" });
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "existing-thread", turnId: "turn-a", tokenUsage: usage(500, 50) }).addedTokens, 0);
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "existing-thread", turnId: "turn-a", tokenUsage: usage(507, 55) }).addedTokens, 12);
  assert.equal(balances.accountSummary(accountA)?.precision, "unknown", "the possibly historical first cumulative total is never silently treated as current work");

  balances.begin({ opaqueAccountId: accountB, reservationId: "reservation-b", estimatedTokens: 64 });
  balances.markDispatched("reservation-b");
  const lastOnly = { last: { inputTokens: 3, outputTokens: 4 } };
  assert.deepEqual(balances.observe({ opaqueAccountId: accountB, threadId: "thread-b", turnId: "turn-b", reservationId: "reservation-b", tokenUsage: lastOnly }), {
    addedTokens: 0, precision: "partial", reservationId: "reservation-b",
  });
  balances.settle("reservation-b");
  assert.equal(balances.accountSummary(accountB)?.completedTokens, 0);
  assert.equal(balances.accountSummary(accountB)?.precision, "unknown");
  assert.equal(balances.snapshot().observations.lastOnlyCount, 1);
  assert.equal(balances.snapshot().reservations.missingUsage, 1);
});

test("out-of-order totals never reduce or replay a counter, while later totals still add their positive delta", () => {
  const balances = ledger(root());
  balances.seedThreadBaseline({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: { inputTokens: 10, outputTokens: 10 } });
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: usage(20, 20) }).addedTokens, 20);
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: usage(15, 15) }).addedTokens, 0);
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: usage(23, 21) }).addedTokens, 4);
  assert.equal(balances.accountSummary(accountA)?.completedTokens, 24);
  assert.equal(balances.snapshot().observations.outOfOrderTotalCount, 1);
  assert.equal(balances.accountSummary(accountA)?.precision, "partial");
});

test("restart recovery retains possibly dispatched reservations as uncertain and persists the baseline and counters", () => {
  const stateRoot = root();
  const first = ledger(stateRoot);
  first.begin({ opaqueAccountId: accountA, reservationId: "reservation-a", estimatedTokens: 80 });
  first.markDispatched("reservation-a");
  first.bind("reservation-a", { threadId: "thread-a", turnId: "turn-a" });
  first.begin({ opaqueAccountId: accountB, reservationId: "reservation-b", estimatedTokens: 80 });
  const restarted = ledger(stateRoot);
  assert.deepEqual(restarted.recover(), { uncertainReservations: 1 });
  assert.equal(restarted.accountSummary(accountA)?.reservedTokens, 80, "recovery does not release a possible provider write");
  assert.equal(restarted.accountSummary(accountB)?.reservedTokens, 0, "a durable pre-dispatch reservation proves the provider write never occurred");
  assert.equal(restarted.reservationForThread({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "turn-a" }), "reservation-a");
  assert.equal(restarted.reservationForThread({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "other-turn" }), null);
  assert.equal(JSON.stringify(restarted.snapshot()).includes("reservation-a"), false, "owner-private recovery correlations never enter status projections");
  assert.equal(restarted.accountSummary(accountA)?.precision, "unknown");
  assert.equal(restarted.snapshot().uncertainReservationCount, 1);
  assert.equal(restarted.snapshot().baseline.startedAt, "2024-08-30T06:40:00.000Z");
  assert.equal(statSync(join(stateRoot, TOKEN_BALANCE_FILE_V1)).mode & 0o077, 0, "the durable ledger remains owner-private");
});

test("a terminal request with no trustworthy total retains a conservative estimate until late deltas repay it", () => {
  const balances = ledger(root());
  balances.begin({ opaqueAccountId: accountA, reservationId: "reservation-a", estimatedTokens: 100 });
  balances.markDispatched("reservation-a");
  balances.bind("reservation-a", { threadId: "thread-a", turnId: "turn-a" });
  balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "turn-a", reservationId: "reservation-a", tokenUsage: null });
  balances.settle("reservation-a");
  assert.equal(balances.accountSummary(accountA)?.reservedTokens, 0);
  assert.equal(balances.accountSummary(accountA)?.unreportedTokens, 100, "settled missing usage is distinct from pending reservations");
  assert.equal(balances.accountSummary(accountA)?.estimatedTokens, 100, "missing measured usage remains a conservative durable debit");
  assert.equal(balances.accountSummary(accountA)?.sharePercent, null, "no measured tokens is not presented as a 0% share");
  assert.deepEqual(balances.choose([accountA, accountB]), { opaqueAccountId: accountB, projectedTokens: 0, precision: "exact" });

  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "turn-a", reservationId: "reservation-a", tokenUsage: usage(10, 10) }).addedTokens, 0);
  assert.equal(balances.observe({ opaqueAccountId: accountA, threadId: "thread-a", turnId: "turn-a", reservationId: "reservation-a", tokenUsage: usage(30, 30) }).addedTokens, 40);
  assert.equal(balances.accountSummary(accountA)?.completedTokens, 40);
  assert.equal(balances.accountSummary(accountA)?.unreportedTokens, 60);
  assert.equal(balances.accountSummary(accountA)?.estimatedTokens, 100, "late actual usage replaces the matching part of the conservative debit without double charging");
});

test("terminalized restart ambiguity keeps a debt without permanently consuming an active reservation slot", () => {
  const stateRoot = root();
  const first = ledger(stateRoot);
  first.begin({ opaqueAccountId: accountA, reservationId: "reservation-a", estimatedTokens: 80 });
  first.markDispatched("reservation-a");
  const recovered = ledger(stateRoot);
  assert.deepEqual(recovered.recover(), { uncertainReservations: 1 });
  assert.deepEqual(recovered.terminalizeUncertainAfterRecovery(), { terminalized: 1 });
  assert.equal(recovered.snapshot().reservations.active, 0);
  assert.equal(recovered.accountSummary(accountA)?.reservedTokens, 0);
  assert.equal(recovered.accountSummary(accountA)?.unreportedTokens, 80);
  assert.equal(recovered.accountSummary(accountA)?.precision, "unknown");
  assert.doesNotThrow(() => recovered.begin({ opaqueAccountId: accountB, reservationId: "next-reservation", estimatedTokens: 80 }));
  recovered.markDispatched("next-reservation");

  const repeated = ledger(stateRoot);
  assert.deepEqual(repeated.recover(), { uncertainReservations: 1 });
  assert.deepEqual(repeated.terminalizeUncertainAfterRecovery(), { terminalized: 1 });
  assert.deepEqual(repeated.recover(), { uncertainReservations: 0 });
  assert.deepEqual(repeated.terminalizeUncertainAfterRecovery(), { terminalized: 0 });
});

test("more than 128 recovered missing completions stay bounded without letting unrelated work erase their debt", () => {
  const balances = ledger(root());
  for (let index = 0; index < 129; index += 1) {
    const reservationId = `recovery-${index}`;
    balances.begin({ opaqueAccountId: accountA, reservationId, estimatedTokens: 1 });
    balances.markDispatched(reservationId);
    balances.bind(reservationId, { threadId: `debt-thread-${index}`, turnId: `turn-${index}` });
    assert.deepEqual(balances.recover(), { uncertainReservations: 1 });
    assert.deepEqual(balances.terminalizeUncertainAfterRecovery(), { terminalized: 1 });
  }
  assert.equal(balances.snapshot().reservations.active, 0);
  assert.equal(balances.accountSummary(accountA)?.unreportedTokens, 129);
  assert.equal(balances.reservationForThread({ opaqueAccountId: accountA, threadId: "debt-thread-0", turnId: "turn-0" }), null, "the oldest terminal record is folded into bounded thread debt");
  assert.doesNotThrow(() => balances.begin({ opaqueAccountId: accountB, reservationId: "post-recovery", estimatedTokens: 1 }));

  balances.seedThreadBaseline({ opaqueAccountId: accountA, threadId: "unrelated-thread", tokenUsage: { inputTokens: 0, outputTokens: 0 } });
  balances.observe({ opaqueAccountId: accountA, threadId: "unrelated-thread", tokenUsage: usage(1, 1) });
  assert.equal(balances.accountSummary(accountA)?.unreportedTokens, 129, "unrelated new work cannot erase unknown historical debt");

  balances.observe({ opaqueAccountId: accountA, threadId: "debt-thread-0", tokenUsage: usage(0, 0) });
  balances.observe({ opaqueAccountId: accountA, threadId: "debt-thread-0", tokenUsage: usage(1, 1) });
  assert.equal(balances.accountSummary(accountA)?.unreportedTokens, 128, "only a later total from the folded thread replaces its conservative debt");
});

test("historical removed accounts remain visible but cannot participate in a new selection", () => {
  const stateRoot = root();
  const initial = ledger(stateRoot);
  initial.seedThreadBaseline({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: { inputTokens: 0, outputTokens: 0 } });
  initial.observe({ opaqueAccountId: accountA, threadId: "thread-a", tokenUsage: usage(4, 5) });
  const reconfigured = ledger(stateRoot, [{ opaqueAccountId: accountB, included: true }, { opaqueAccountId: accountC, included: true }]);
  assert.equal(reconfigured.accountSummary(accountA)?.completedTokens, 9);
  assert.equal(reconfigured.accountSummary(accountA)?.included, false);
  assert.deepEqual(reconfigured.choose([accountA, accountB, accountC]), { opaqueAccountId: accountB, projectedTokens: 0, precision: "exact" });
  assert.throws(() => reconfigured.begin({ opaqueAccountId: accountA, estimatedTokens: 1 }), /not currently included/);
  reconfigured.setAccounts([{ opaqueAccountId: accountA, included: true }, { opaqueAccountId: accountC, included: true }]);
  assert.equal(reconfigured.accountSummary(accountA)?.included, true);
  assert.deepEqual(reconfigured.choose([accountA, accountB, accountC]), { opaqueAccountId: accountC, projectedTokens: 0, precision: "exact" });
});

test("corrupt or non-private durable state fails closed", () => {
  const stateRoot = root();
  const path = join(stateRoot, TOKEN_BALANCE_FILE_V1);
  writeFileSync(path, "{not-json}\n", { mode: 0o600 });
  assert.throws(() => ledger(stateRoot), /corrupt/);
  writeFileSync(path, JSON.stringify({ version: 1 }) + "\n", { mode: 0o600 });
  chmodSync(path, 0o644);
  assert.throws(() => ledger(stateRoot), /unsafe private file/);
});

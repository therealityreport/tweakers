import assert from "node:assert/strict";
import test from "node:test";
import { assertIndependentTweakersRuntimeReadyExpectation, assertIndependentTweakersRuntimeReadyReceipt,
  verifyRuntimeReadyReceiptBinding, type IndependentTweakersRuntimeReadyExpectation } from "../src/runtime-ready-receipt";

const hash = "a".repeat(64);
const repair = {repairId: "11111111-1111-4111-8111-111111111111", headSha256: hash, intentSha256: "b".repeat(64), authorityReceiptSha256: "c".repeat(64)};
function expectation(): IndependentTweakersRuntimeReadyExpectation {
  return {schemaVersion: 6, kind: "tweakers-independent-runtime-ready-expectation", operationId: "original-operation", promotionId: "original-promotion",
    runtimeRepair: {...repair}, activePromotionReceiptSha256: hash, appRoot: "/Applications/Tweakers.app", bundleId: "com.therealityreport.tweakers",
    appAsarHeaderHash: hash, runtimeFingerprint: hash, appUserDataRoot: "/Users/fixture/Tweakers/app-data", codexHomeRoot: "/Users/fixture/Tweakers/codex-home",
    accountsBrokerRoot: "/Users/fixture/Tweakers/broker", brokerAuthorityExpectation: {globalRootState: "valid-v3", configSha256: hash},
    appearanceExpectation: {status: "normal", normalized: true}, expectedTweakIds: [], createdAt: "2026-10-12T15:00:00.000Z"};
}
function receipt(wanted = expectation()) {
  const {createdAt: _createdAt, expectedTweakIds, appearanceExpectation, kind: _kind, ...binding} = wanted;
  return {...binding, kind: "tweakers-independent-runtime-ready", pid: 42, processStartToken: "Mon Oct 12 11:00:00 2026",
    appearance: appearanceExpectation, mainInitialized: true, preloadInitialized: true, settingsMounted: true,
    sharedHistoryBrokerState: "connected", initializedTweakIds: expectedTweakIds, observedAt: "2026-10-12T15:00:01.000Z"};
}

test("schema6 readiness binds exact head, intent and signed authority while preserving every legacy readiness gate", () => {
  const wanted = expectation(), ready = receipt(wanted);
  assertIndependentTweakersRuntimeReadyExpectation(wanted);
  assertIndependentTweakersRuntimeReadyReceipt(ready);
  verifyRuntimeReadyReceiptBinding(wanted, ready, 42, ready.processStartToken);
  for (const key of ["repairId", "headSha256", "intentSha256", "authorityReceiptSha256"] as const) {
    const changed = {...ready, runtimeRepair: {...repair, [key]: key === "repairId" ? "22222222-2222-4222-8222-222222222222" : "d".repeat(64)}};
    assert.throws(() => verifyRuntimeReadyReceiptBinding(wanted, changed, 42, ready.processStartToken), /does not match/);
  }
  for (const change of [{pid: 43}, {settingsMounted: false}, {sharedHistoryBrokerState: "blocked"}, {runtimeFingerprint: "d".repeat(64)}]) {
    assert.throws(() => verifyRuntimeReadyReceiptBinding(wanted, {...ready, ...change}, 42, ready.processStartToken));
  }
});

test("schema5 is explicit legacy and rejects repair keys; schema6 requires a complete exact binding", () => {
  const wanted = expectation(), ready = receipt(wanted);
  const {runtimeRepair: _repair, ...legacy} = wanted;
  assertIndependentTweakersRuntimeReadyExpectation({...legacy, schemaVersion: 5});
  for (const invalid of [{...wanted, schemaVersion: 5}, {...wanted, runtimeRepair: null}, {...legacy, schemaVersion: 6},
    {...wanted, runtimeRepair: {...repair, unknown: true}}, {...wanted, runtimeRepair: {...repair, headSha256: hash.toUpperCase()}}]) {
    assert.throws(() => assertIndependentTweakersRuntimeReadyExpectation(invalid));
  }
  assert.throws(() => assertIndependentTweakersRuntimeReadyReceipt({...ready, schemaVersion: 5}));
  assert.throws(() => assertIndependentTweakersRuntimeReadyReceipt({...ready, runtimeRepair: undefined}));
  assert.throws(() => verifyRuntimeReadyReceiptBinding({...legacy, schemaVersion: 5}, ready, 42, ready.processStartToken));
});

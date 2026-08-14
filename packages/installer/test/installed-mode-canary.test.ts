import assert from "node:assert/strict";
import test from "node:test";
import {
  adjudicateInstalledModeCanary,
  assertInstalledModeCanaryPass,
  isInstalledModeCanaryReceipt,
} from "../src/installed-mode-canary";

const SHA = (character: string) => character.repeat(64);

function input() {
  return {
    transactionId: "installed-canary-1",
    attempt: 1,
    preflightReceiptSha256: SHA("a"),
    activeBackendReceiptSha256: SHA("b"),
    environment: {
      uiFeatures: "off" as const,
      mcpSafetyProvider: "managed-turn-idle" as const,
      recoveryState: "normal-protected" as const,
    },
    fixture: {
      tokenFree: true,
      modelFree: true,
      completedIdleFleetTornDown: true,
      busyMailboxFleetPreserved: true,
      freshRespawnObserved: true,
      attachedUiOwnedSignalCount: 0,
      latencyMs: [12, 15],
      cpuSamples: [0.1, 0.2],
      rssBytes: [1024, 2048],
    },
    startedAt: "2026-08-12T19:00:00.000Z",
    completedAt: "2026-08-12T19:01:00.000Z",
  };
}

test("installed canary requires token-free, model-free managed safety and zero attached-tree signals", () => {
  const receipt = adjudicateInstalledModeCanary(input());

  assert.equal(receipt.verdict, "PASS");
  assert.equal(isInstalledModeCanaryReceipt(receipt), true);
  assert.doesNotThrow(() => assertInstalledModeCanaryPass(receipt, {
    transactionId: "installed-canary-1",
    attempt: 1,
    preflightReceiptSha256: SHA("a"),
    activeBackendReceiptSha256: SHA("b"),
  }));
});

test("installed canary preserves failure distinctions rather than fabricating a pass", () => {
  const receipt = adjudicateInstalledModeCanary({
    ...input(),
    fixture: {
      ...input().fixture,
      tokenFree: false,
      busyMailboxFleetPreserved: false,
      attachedUiOwnedSignalCount: 1,
    },
  });

  assert.equal(receipt.verdict, "FAIL");
  assert.match(receipt.reason ?? "", /fixture-requires-token/);
  assert.match(receipt.reason ?? "", /busy-mailbox-preservation-not-observed/);
  assert.match(receipt.reason ?? "", /attached-ui-owned-signal-observed/);
  assert.throws(() => assertInstalledModeCanaryPass(receipt, {
    transactionId: receipt.transactionId,
    attempt: receipt.attempt,
    preflightReceiptSha256: receipt.preflightReceiptSha256,
    activeBackendReceiptSha256: receipt.activeBackendReceiptSha256,
  }), /did not pass/);
});

test("installed canary receipt digest rejects post-adjudication tampering", () => {
  const receipt = adjudicateInstalledModeCanary(input());
  assert.equal(isInstalledModeCanaryReceipt({ ...receipt, verdict: "FAIL" }), false);
  assert.equal(isInstalledModeCanaryReceipt({
    ...receipt,
    environment: { ...receipt.environment, mcpSafetyProvider: "official-bundled-degraded" },
  }), false);
});

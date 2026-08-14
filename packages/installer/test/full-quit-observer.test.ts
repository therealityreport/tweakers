import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFullQuitObservationPass,
  observeFullQuit,
  prepareFullQuitObservation,
} from "../src/full-quit-observer";

const SHA = "a".repeat(64);

function authority() {
  return prepareFullQuitObservation({
    transactionId: "full-quit-1",
    desktop: {
      pid: 400,
      kernelStart: "kernel-start-400",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      executableSha256: SHA,
      parentPid: 1,
    },
    expectedAppPath: "/Applications/ChatGPT.app",
    expectedAppSha256: "b".repeat(64),
    preparedAt: "2026-08-12T19:00:00.000Z",
    expiresAt: "2026-08-12T20:00:00.000Z",
    nonce: "full-quit-nonce-0001",
  });
}

test("full quit observation accepts direct exit plus child reparent/exit without signals", () => {
  const prepared = authority();
  const receipt = observeFullQuit(prepared, {
    initial: [
      prepared.desktop,
      {
        pid: 401,
        kernelStart: "kernel-start-401",
        executablePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        executableSha256: "c".repeat(64),
        parentPid: 400,
      },
    ],
    final: [{
      pid: 401,
      kernelStart: "kernel-start-401",
      executablePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      executableSha256: "c".repeat(64),
      parentPid: 1,
    }],
    observedAt: "2026-08-12T19:01:00.000Z",
  });

  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.attachedUiOwnedSignalCount, 0);
  assert.doesNotThrow(() => assertFullQuitObservationPass(receipt, prepared));
});

test("full quit observation fails if target remains, a child stays attached, or any signal is claimed", () => {
  const prepared = authority();
  const receipt = observeFullQuit(prepared, {
    initial: [prepared.desktop],
    final: [prepared.desktop],
    observedAt: "2026-08-12T19:01:00.000Z",
    attachedUiOwnedSignalCount: 1,
  });

  assert.equal(receipt.verdict, "FAIL");
  assert.match(receipt.reason ?? "", /target-still-running/);
  assert.match(receipt.reason ?? "", /attached-ui-owned-signal-observed/);
  assert.throws(() => assertFullQuitObservationPass(receipt, prepared), /did not pass/);
});

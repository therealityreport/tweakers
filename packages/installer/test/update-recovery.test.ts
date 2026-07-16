import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_UPDATE_RECOVERY_STATE,
  isUpdateRecoveryV2Enabled,
  transition,
  type UpdateRecoveryState,
} from "../src/update-recovery/index";

test("update recovery follows the held happy path through promotion", () => {
  let state: UpdateRecoveryState = INITIAL_UPDATE_RECOVERY_STATE;

  let result = transition(state, { type: "watcherPassStarted" });
  assert.deepEqual(result, { state: "updateDetected", actions: ["notifyUpdateDetected"] });
  state = result.state;

  result = transition(state, { type: "updateModeStaleOrAbsent" });
  assert.deepEqual(result, { state: "buildingCandidate", actions: ["buildCandidate"] });
  state = result.state;

  result = transition(state, { type: "candidateValidated" });
  assert.deepEqual(result, { state: "recovering", actions: [] });
  state = result.state;

  result = transition(state, { type: "appRunning" });
  assert.deepEqual(result, { state: "held", actions: [] });
  state = result.state;

  result = transition(state, { type: "appClosed" });
  assert.deepEqual(result, { state: "promoting", actions: ["reenterInstall"] });
  state = result.state;

  result = transition(state, { type: "promoteSucceeded" });
  assert.deepEqual(result, { state: "promoted", actions: [] });
});

test("a fresh update mode pauses recovery and an intact patch ends it", () => {
  assert.deepEqual(transition("updateDetected", { type: "updateModeFresh" }), {
    state: "paused",
    actions: ["notifyUpdatePaused"],
  });
  assert.deepEqual(transition("updateDetected", { type: "hashMatchesPatched" }), {
    state: "patchIntact",
    actions: [],
  });
});

test("unavailable signing defers recovery until signing becomes available", () => {
  const expectedDeferred = {
    state: "signingDeferred",
    actions: ["writeDeferredMarker", "notifySigningDeferred"],
  };
  assert.deepEqual(transition("updateDetected", { type: "signingUnavailable" }), expectedDeferred);
  assert.deepEqual(transition("buildingCandidate", { type: "signingUnavailable" }), expectedDeferred);
  assert.deepEqual(transition("signingDeferred", { type: "signingAvailable" }), {
    state: "buildingCandidate",
    actions: ["buildCandidate"],
  });
});

test("candidate invalidation retries only when the retry policy allows it", () => {
  assert.deepEqual(
    transition("buildingCandidate", { type: "candidateInvalid", reason: "health check failed" }),
    { state: "invalidated", actions: ["reportInvalidated"] },
  );
  assert.deepEqual(transition("invalidated", { type: "invalidatedRetryAllowed" }), {
    state: "buildingCandidate",
    actions: ["buildCandidate"],
  });
  assert.deepEqual(transition("invalidated", { type: "invalidatedRetryExhausted" }), {
    state: "invalidated",
    actions: [],
  });
});

test("a validated candidate promotes immediately when the app is already closed", () => {
  assert.deepEqual(transition("buildingCandidate", { type: "candidateValidated" }), {
    state: "recovering",
    actions: [],
  });
  assert.deepEqual(transition("recovering", { type: "appClosed" }), {
    state: "promoting",
    actions: ["promote"],
  });
});

test("a held candidate coordinates only confirmed official update drift", () => {
  assert.deepEqual(transition("held", { type: "confirmedOfficialDrift" }), {
    state: "coordinatedQuit",
    actions: ["quitCodex", "reenterInstall"],
  });
  assert.deepEqual(transition("held", { type: "unconfirmedDrift" }), {
    state: "held",
    actions: ["waitForCodexClose"],
  });
  assert.deepEqual(transition("held", { type: "appRunning" }), {
    state: "held",
    actions: ["waitForCodexClose"],
  });
});

test("a coordinated quit re-enters only after the app closes", () => {
  assert.deepEqual(transition("coordinatedQuit", { type: "appRunning" }), {
    state: "held",
    actions: ["waitForCodexClose"],
  });
  assert.deepEqual(transition("coordinatedQuit", { type: "appClosed" }), {
    state: "promoting",
    actions: ["reenterInstall"],
  });
});

test("failed promotion rolls back into degraded recovery", () => {
  assert.deepEqual(transition("promoting", { type: "promoteFailed", reason: "health check failed" }), {
    state: "degraded",
    actions: ["rollback"],
  });
});

test("an unhandled state and event pair is a no-op self-loop", () => {
  assert.doesNotThrow(() => transition("promoted", { type: "signingUnavailable" }));
  assert.deepEqual(transition("promoted", { type: "signingUnavailable" }), {
    state: "promoted",
    actions: [],
  });
});

test("update recovery v2 defaults on and exact 0 remains the rollback switch", () => {
  assert.equal(isUpdateRecoveryV2Enabled({ TWEAKERS_UPDATE_RECOVERY_V2: "1" }), true);
  assert.equal(isUpdateRecoveryV2Enabled({ TWEAKERS_UPDATE_RECOVERY_V2: "true" }), true);
  assert.equal(isUpdateRecoveryV2Enabled({ TWEAKERS_UPDATE_RECOVERY_V2: "0" }), false);
  assert.equal(isUpdateRecoveryV2Enabled({}), true);
});

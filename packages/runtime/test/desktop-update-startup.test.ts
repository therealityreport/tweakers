import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopUpdateStartupReconciler,
  type DesktopUpdateStartupEvent,
} from "../src/desktop-update-startup";

test("startup reconcile waits for a visible window, launches once, and cannot be scheduled twice", () => {
  const timers: Array<() => void> = [];
  const events: DesktopUpdateStartupEvent[] = [];
  let probes = 0;
  let launches = 0;
  const reconciler = createDesktopUpdateStartupReconciler({
    windowReady: () => {
      probes += 1;
      return probes >= 3;
    },
    launch: () => {
      launches += 1;
    },
    setTimer: (callback) => {
      timers.push(callback);
    },
    onEvent: (event) => events.push(event),
  }, { maxAttempts: 4, retryMs: 1 });

  assert.equal(reconciler.schedule(), true);
  assert.equal(reconciler.schedule(), false);
  while (timers.length > 0) timers.shift()?.();

  assert.equal(launches, 1);
  assert.deepEqual(events, [{
    event: "desktop-update-startup-reconcile",
    result: "submitted",
    attempts: 3,
  }]);
});

test("startup reconcile stops after its bounded window-proof retries", () => {
  const timers: Array<() => void> = [];
  const events: DesktopUpdateStartupEvent[] = [];
  const reconciler = createDesktopUpdateStartupReconciler({
    windowReady: () => false,
    launch: () => assert.fail("no window proof must not launch reconcile"),
    setTimer: (callback) => {
      timers.push(callback);
    },
    onEvent: (event) => events.push(event),
  }, { maxAttempts: 2, retryMs: 1 });

  reconciler.schedule();
  while (timers.length > 0) timers.shift()?.();

  assert.deepEqual(events, [{
    event: "desktop-update-startup-reconcile",
    result: "window-unavailable",
    attempts: 2,
  }]);
});

test("startup launcher failures are captured as diagnostics instead of escaping", () => {
  const timers: Array<() => void> = [];
  const events: DesktopUpdateStartupEvent[] = [];
  const error = Object.assign(new Error("launchctl denied"), {
    code: "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED",
  });
  const reconciler = createDesktopUpdateStartupReconciler({
    windowReady: () => true,
    launch: () => {
      throw error;
    },
    setTimer: (callback) => {
      timers.push(callback);
    },
    onEvent: (event) => events.push(event),
  });

  assert.doesNotThrow(() => {
    reconciler.schedule();
    timers.shift()?.();
  });
  assert.deepEqual(events, [{
    event: "desktop-update-startup-reconcile",
    result: "failed",
    attempts: 1,
    error: "launchctl denied",
    errorCode: "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED",
  }]);
});

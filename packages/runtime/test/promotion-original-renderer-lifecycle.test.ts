import assert from "node:assert/strict";
import test from "node:test";
import { createPromotionOriginalRendererMountLifecycle } from "../src/preload/promotion-original-renderer-lifecycle";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void; timeoutMs: number }>();
  const scheduledTimeouts: number[] = [];
  return {
    scheduler: {
      set(callback: () => void, timeoutMs: number): unknown {
        const id = nextId++;
        scheduledTimeouts.push(timeoutMs);
        timers.set(id, { at: now + timeoutMs, callback, timeoutMs });
        return id;
      },
      clear(handle: unknown): void {
        timers.delete(handle as number);
      },
    },
    advance(timeoutMs: number): void {
      const target = now + timeoutMs;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    scheduledTimeouts,
    timerCount(): number {
      return timers.size;
    },
  };
}

test("original renderer preload buffers an early mount until window load without starting a clock", () => {
  const clock = fakeClock();
  const events: string[] = [];
  const lifecycle = createPromotionOriginalRendererMountLifecycle({
    scheduler: clock.scheduler,
    timeoutMs: 55_000,
    onMounted: () => events.push("mounted"),
    onTimeout: () => events.push("timeout"),
  });

  assert.equal(lifecycle.phase(), "loading");
  assert.equal(clock.timerCount(), 0, "authorization alone cannot start the mount clock");
  assert.equal(lifecycle.mountObserved(), true);
  assert.deepEqual(events, [], "success cannot be emitted before load");
  assert.equal(clock.timerCount(), 0);
  assert.equal(lifecycle.mountObserved(), false, "repeated observations are one-shot");

  assert.equal(lifecycle.windowLoaded(), true);
  assert.deepEqual(events, ["mounted"]);
  assert.equal(lifecycle.phase(), "settled");
  assert.equal(clock.timerCount(), 0);
  assert.equal(lifecycle.windowLoaded(), false);
  assert.equal(lifecycle.mountObserved(), false);
  assert.deepEqual(events, ["mounted"], "repeated signals cannot emit twice");
});

test("original renderer preload grants exactly 55 seconds after load and cannot be extended", () => {
  const clock = fakeClock();
  const events: string[] = [];
  const lifecycle = createPromotionOriginalRendererMountLifecycle({
    scheduler: clock.scheduler,
    timeoutMs: 55_000,
    onMounted: () => events.push("mounted"),
    onTimeout: () => events.push("timeout"),
  });

  assert.equal(lifecycle.windowLoaded(), true);
  assert.deepEqual(clock.scheduledTimeouts, [55_000]);
  clock.advance(54_999);
  assert.deepEqual(events, []);
  assert.equal(lifecycle.windowLoaded(), false, "repeated load cannot rearm the deadline");
  assert.deepEqual(clock.scheduledTimeouts, [55_000]);
  assert.equal(lifecycle.mountObserved(), true);
  assert.deepEqual(events, ["mounted"]);
  assert.equal(clock.timerCount(), 0);
  clock.advance(1);
  assert.deepEqual(events, ["mounted"]);
});

test("original renderer preload timeout is exact and remains terminal", () => {
  const clock = fakeClock();
  const events: string[] = [];
  const lifecycle = createPromotionOriginalRendererMountLifecycle({
    scheduler: clock.scheduler,
    timeoutMs: 55_000,
    onMounted: () => events.push("mounted"),
    onTimeout: () => events.push("timeout"),
  });

  lifecycle.windowLoaded();
  clock.advance(54_999);
  assert.deepEqual(events, []);
  clock.advance(1);
  assert.deepEqual(events, ["timeout"]);
  assert.equal(lifecycle.phase(), "settled");
  assert.equal(lifecycle.mountObserved(), false);
  assert.equal(lifecycle.windowLoaded(), false);
  assert.deepEqual(events, ["timeout"], "late signals cannot replace an exact timeout");
});

test("original renderer preload settlement cancels the active post-load timer", () => {
  const clock = fakeClock();
  const events: string[] = [];
  const lifecycle = createPromotionOriginalRendererMountLifecycle({
    scheduler: clock.scheduler,
    timeoutMs: 55_000,
    onMounted: () => events.push("mounted"),
    onTimeout: () => events.push("timeout"),
  });

  lifecycle.windowLoaded();
  assert.equal(clock.timerCount(), 1);
  lifecycle.settle();
  lifecycle.settle();
  assert.equal(clock.timerCount(), 0);
  clock.advance(55_000);
  assert.deepEqual(events, []);
});

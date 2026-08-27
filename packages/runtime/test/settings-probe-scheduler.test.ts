import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  SettingsProbeScheduler,
  type SettingsProbeOutcome,
} from "../src/preload/settings-probe-scheduler";

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, { dueAt: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.nowMs + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  pendingTimerCount(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = next[1].dueAt;
      next[1].callback();
    }
    this.nowMs = target;
  }
}

function schedulerFor(
  clock: FakeClock,
  probe: () => SettingsProbeOutcome,
): SettingsProbeScheduler {
  return new SettingsProbeScheduler({
    probe,
    now: () => clock.nowMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

test("missing Settings runs a bounded ten-probe burst and becomes dormant", () => {
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = schedulerFor(clock, () => {
    probes += 1;
    return "missing";
  });

  scheduler.request({ immediate: true });
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    scheduler.request();
    clock.advance(10);
  }

  assert.equal(probes, 10);
  assert.equal(scheduler.metrics().dormant, true);
  assert.equal(clock.pendingTimerCount(), 0);
  assert.ok(scheduler.metrics().coalescedRequestCount > 0);
  scheduler.stop();
  assert.equal(scheduler.metrics().activeTimerCount, 0);
});

test("ten thousand irrelevant mutations do not probe after dormancy", () => {
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = schedulerFor(clock, () => {
    probes += 1;
    return "missing";
  });

  scheduler.request({ immediate: true });
  clock.advance(10_000);
  assert.equal(probes, 10);
  for (let index = 0; index < 10_000; index += 1) {
    scheduler.recordFilteredMutation();
    scheduler.request();
  }
  clock.advance(10_000);
  assert.equal(probes, 10);
  assert.equal(scheduler.metrics().filteredMutationCount, 10_000);
  assert.equal(scheduler.metrics().dormant, true);
  assert.equal(clock.pendingTimerCount(), 0);
  assert.equal(scheduler.metrics().backoffEventCount, 1);
  scheduler.stop();
  assert.equal(scheduler.metrics().activeTimerCount, 0);
});

test("navigation wakes a dormant scheduler exactly once", () => {
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = schedulerFor(clock, () => {
    probes += 1;
    return "missing";
  });

  scheduler.request({ immediate: true });
  clock.advance(10_000);
  assert.equal(scheduler.metrics().dormant, true);
  const beforeNavigation = probes;
  scheduler.request({ immediate: true, resetBackoff: true, wake: true });
  assert.equal(probes, beforeNavigation + 1);
  assert.equal(scheduler.metrics().wakeCount, 1);
  assert.equal(scheduler.metrics().dormant, false);
  assert.equal(scheduler.metrics().currentBackoffMs, 250);
  scheduler.stop();
});

test("a found Settings surface stops idle polling and coalesces update storms", () => {
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = schedulerFor(clock, () => {
    probes += 1;
    return "found";
  });

  scheduler.request({ immediate: true });
  clock.advance(5_000);
  assert.equal(probes, 1, "found surfaces do not poll while quiet");
  for (let index = 0; index < 100; index += 1) scheduler.request();
  clock.advance(0);
  assert.equal(probes, 2, "the first mutation after a quiet period is handled immediately");
  for (let index = 0; index < 100; index += 1) scheduler.request();
  clock.advance(99);
  assert.equal(probes, 2);
  clock.advance(1);
  assert.equal(probes, 3, "follow-up mutations are coalesced into one scoped update");
  scheduler.stop();
});

test("rejected candidates use the same bounded miss backoff", () => {
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = schedulerFor(clock, () => {
    probes += 1;
    return "rejected";
  });

  scheduler.request({ immediate: true });
  clock.advance(1_000);
  assert.equal(probes, 5);
  assert.equal(scheduler.metrics().lastOutcome, "rejected");
  scheduler.stop();
});

test("a thrown probe clears scheduler state and retries with bounded missing backoff", () => {
  const clock = new FakeClock();
  let probes = 0;
  const errors: unknown[] = [];
  const scheduler = new SettingsProbeScheduler({
    probe: () => {
      probes += 1;
      if (probes === 1) throw new Error("sidebar replaced during probe");
      return "found";
    },
    now: () => clock.nowMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onProbeError: (error) => errors.push(error),
  });

  scheduler.request({ immediate: true });
  assert.equal(scheduler.metrics().lastOutcome, "missing");
  assert.equal(scheduler.metrics().consecutiveMisses, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /sidebar replaced during probe/);
  clock.advance(249);
  assert.equal(probes, 1);
  clock.advance(1);
  assert.equal(probes, 2, "the retry runs after the thrown probe");
  assert.equal(scheduler.metrics().lastOutcome, "found");
  assert.equal(clock.pendingTimerCount(), 0, "a recovered found surface stays quiet");
  scheduler.stop();
});

test("a detached sidebar root triggers one immediate reinjection without history", () => {
  const injectorSource = readFileSync(
    resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
    "utf8",
  );
  const observerStart = injectorSource.indexOf("function scopeSettingsObserver");
  const observerEnd = injectorSource.indexOf("function publishSettingsInjectorDiagnostics", observerStart);
  assert.ok(observerStart >= 0 && observerEnd > observerStart, "observer source range exists");
  const observer = injectorSource.slice(observerStart, observerEnd);
  assert.match(observer, /const target = sidebarRoot \?\? document\.documentElement/);
  assert.match(observer, /if \(sidebarRoot\.isConnected\) return/);
  assert.match(observer, /state\.sidebarRoot = null/);
  assert.match(observer, /mutationRecordsContainRemovedRoot\(records, sidebarRoot\)/);
  assert.match(observer, /request\(\{ immediate: true, resetBackoff: true, wake: true \}\)/);

  const clock = new FakeClock();
  let injections = 0;
  let sidebarRoot = { isConnected: true };
  const scheduler = schedulerFor(clock, () => {
    injections += 1;
    return "found";
  });
  const onDocumentMutation = (): void => {
    if (!sidebarRoot.isConnected) {
      sidebarRoot = { isConnected: true };
      scheduler.request({ immediate: true, resetBackoff: true, wake: true });
    }
  };

  scheduler.request({ immediate: true });
  sidebarRoot.isConnected = false;
  onDocumentMutation();
  onDocumentMutation();
  assert.equal(injections, 2, "the replacement causes one reinjection without navigation");
  assert.equal(scheduler.metrics().wakeCount, 1);
  assert.equal(clock.pendingTimerCount(), 0, "the found replacement leaves no duplicate timer");
  scheduler.stop();
});

test("injector filters ordinary document mutations and wakes for Settings markers", () => {
  const injectorSource = readFileSync(
    resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
    "utf8",
  );
  const observerStart = injectorSource.indexOf("function scopeSettingsObserver");
  const observerEnd = injectorSource.indexOf("function publishSettingsInjectorDiagnostics", observerStart);
  const observer = injectorSource.slice(observerStart, observerEnd);
  assert.match(observer, /mutationRecordsContainSettingsMarkers\(records\)/);
  assert.match(observer, /recordFilteredMutation\(records\.length\)/);
  assert.match(observer, /node instanceof Element && node\.matches\("\[data-settings-panel-slug\]"\)/);
  assert.match(observer, /node instanceof DocumentFragment/);
  assert.match(observer, /node\.querySelector\("\[data-settings-panel-slug\]"\)/);
});

test("replacement sentinel ignores unrelated mutations after sidebar detachment", () => {
  const injectorSource = readFileSync(
    resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
    "utf8",
  );
  const observerStart = injectorSource.indexOf("function scopeSettingsObserver");
  const observerEnd = injectorSource.indexOf("function publishSettingsInjectorDiagnostics", observerStart);
  const observer = injectorSource.slice(observerStart, observerEnd);
  assert.match(observer, /new MutationObserver\(\(records\) => \{/);
  assert.match(observer, /if \(sidebarRoot\.isConnected\) return;/);
  assert.match(observer, /if \(!mutationRecordsContainRemovedRoot\(records, sidebarRoot\)\) return;/);
  assert.match(observer, /function mutationRecordsContainRemovedRoot\(records: MutationRecord\[], root: Node\)/);
  assert.match(observer, /node === root \|\| \(node instanceof Node && node\.contains\(root\)\)/);
});

test("explicit Settings page opening wakes the scheduler", () => {
  const injectorSource = readFileSync(
    resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
    "utf8",
  );
  const start = injectorSource.indexOf("export function openRegisteredPage");
  const end = injectorSource.indexOf("export function setListedTweaks", start);
  const body = injectorSource.slice(start, end);
  assert.match(body, /request\(\{ immediate: true, resetBackoff: true, wake: true \}\)/);
});

test("stop cancels timers and prevents future probes", () => {
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = schedulerFor(clock, () => {
    probes += 1;
    return "missing";
  });

  scheduler.request({ immediate: true });
  scheduler.stop();
  clock.advance(10_000);
  scheduler.request({ immediate: true });
  assert.equal(probes, 1);
  assert.equal(scheduler.metrics().activeTimerCount, 0);

  const injectorSource = readFileSync(
    resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
    "utf8",
  );
  const start = injectorSource.indexOf("export function stopSettingsInjector");
  const end = injectorSource.indexOf("function onNav", start);
  const stopBody = injectorSource.slice(start, end);
  assert.match(stopBody, /settlePendingRegisteredPageOpen/);
  assert.match(stopBody, /state\.probeScheduler\?\.stop\(\)/);
  assert.match(stopBody, /state\.observer\?\.disconnect\(\)/);
  assert.match(stopBody, /state\.replacementObserver\?\.disconnect\(\)/);
  assert.match(stopBody, /clearTimeout\(state\.settingsSurfaceHideTimer\)/);
});

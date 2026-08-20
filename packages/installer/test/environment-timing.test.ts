import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentTiming,
  EnvironmentTimingRecorder,
  summarizeEnvironmentTiming,
  type EnvironmentTimingClock,
} from "../src/environment-timing";

test("timing recorder persists ISO boundaries while calculating elapsed time monotonically", () => {
  let monotonic = 10;
  let wall = 0;
  const clock: EnvironmentTimingClock = {
    monotonicMs: () => monotonic,
    nowIso: () => `2026-08-18T00:00:0${wall++}.000Z`,
  };
  const recorder = new EnvironmentTimingRecorder(clock);
  let timing = recorder.start(createEnvironmentTiming("2026-08-18T00:00:00.000Z"), "preparation");
  monotonic = 47;
  timing = recorder.complete(timing, "preparation");

  assert.deepEqual(timing.phases.preparation, {
    startedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:01.000Z",
    durationMs: 37,
  });
  assert.equal(timing.approvalAt, "2026-08-18T00:00:00.000Z");
});

test("benchmark summaries retain failed terminal samples and use empirical percentiles", () => {
  const summary = summarizeEnvironmentTiming([
    { direction: "chatgpt->tweakers", durationMs: 10, phase: "committed" },
    { direction: "chatgpt->tweakers", durationMs: 20, phase: "failed" },
    { direction: "chatgpt->tweakers", durationMs: 30, phase: "committed" },
    { direction: "chatgpt->tweakers", durationMs: 40, phase: "rolled-back" },
  ]);
  assert.deepEqual(summary["chatgpt->tweakers"], {
    count: 4,
    p50Ms: 20,
    empiricalP95Ms: 40,
    maxMs: 40,
    failures: 2,
  });
});

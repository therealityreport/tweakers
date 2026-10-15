import assert from "node:assert/strict";
import test from "node:test";
import { createTweakLifecycleBarrier, type TweakLifecycleAcknowledgement } from "../src/tweak-lifecycle-barrier";

const acknowledgement = (instanceToken: string, overrides: Partial<TweakLifecycleAcknowledgement> = {}): TweakLifecycleAcknowledgement => ({
  operationId: "operation", phase: "shutdown", instanceToken, ok: true, ...overrides,
});

test("barrier accepts only operation, phase and generation-bound acknowledgements", async () => {
  const barrier = createTweakLifecycleBarrier({ operationId: "operation", phase: "shutdown", expectedInstanceTokens: ["main:1", "renderer:7:document:3"] });
  assert.equal(barrier.acknowledge(acknowledgement("main:1", { operationId: "old" })), false);
  assert.equal(barrier.acknowledge(acknowledgement("main:1", { phase: "activate" })), false);
  assert.equal(barrier.acknowledge(acknowledgement("renderer:7:document:2")), false);
  assert.equal(barrier.acknowledge(acknowledgement("main:1")), true);
  assert.equal(barrier.acknowledge(acknowledgement("main:1")), false);
  assert.equal(barrier.acknowledge(acknowledgement("renderer:7:document:3")), true);
  await barrier.completion;
  assert.equal(barrier.acknowledge(acknowledgement("renderer:7:document:3")), false);
});

test("matching failed acknowledgement rejects the operation", async () => {
  const barrier = createTweakLifecycleBarrier({ operationId: "operation", phase: "shutdown", expectedInstanceTokens: ["renderer"] });
  assert.equal(barrier.acknowledge(acknowledgement("renderer", { ok: false, error: "cleanup pending" })), true);
  await assert.rejects(barrier.completion, /cleanup pending/);
});

test("navigation or destruction invalidates a required instance while peers are pending", async () => {
  const barrier = createTweakLifecycleBarrier({ operationId: "operation", phase: "shutdown", expectedInstanceTokens: ["renderer", "main"] });
  barrier.acknowledge(acknowledgement("renderer"));
  barrier.invalidate("unknown");
  barrier.invalidate("renderer", "navigation");
  await assert.rejects(barrier.completion, /invalidated.*navigation/);
});

test("timeout identifies pending instances and cannot accept a late ack", async () => {
  const barrier = createTweakLifecycleBarrier({ operationId: "operation", phase: "shutdown", expectedInstanceTokens: ["main", "renderer"], timeoutMs: 5 });
  barrier.acknowledge(acknowledgement("main"));
  await assert.rejects(barrier.completion, /pending: renderer/);
  assert.equal(barrier.acknowledge(acknowledgement("renderer")), false);
});

test("empty participant set completes and cancellation fails a pending set", async () => {
  await createTweakLifecycleBarrier({ operationId: "operation", phase: "activate", expectedInstanceTokens: [] }).completion;
  const barrier = createTweakLifecycleBarrier({ operationId: "operation", phase: "activate", expectedInstanceTokens: ["main"] });
  barrier.cancel("sender failed");
  await assert.rejects(barrier.completion, /sender failed/);
});

test("barrier rejects duplicate participants and invalid bounded-timeout inputs", () => {
  const options = { operationId: "operation", phase: "shutdown" as const, expectedInstanceTokens: ["main"] };
  assert.throws(() => createTweakLifecycleBarrier({ ...options, expectedInstanceTokens: ["main", "main"] }), /unique/);
  assert.throws(() => createTweakLifecycleBarrier({ ...options, expectedInstanceTokens: [""] }), /nonempty/);
  for (const timeoutMs of [NaN, Infinity, 0, -1]) assert.throws(() => createTweakLifecycleBarrier({ ...options, timeoutMs }), /positive/);
});

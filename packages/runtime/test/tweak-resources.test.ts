import test from "node:test";
import assert from "node:assert/strict";
import { TweakResources } from "../src/tweak-resources";

test("activation aborts immediately and awaits reverse-order cleanup even after failure", async () => {
  const scope = new TweakResources();
  const events: string[] = [];
  let release!: () => void;
  scope.add(() => { events.push("first"); });
  scope.add(() => { throw new Error("broken cleanup"); });
  scope.add(async () => { await new Promise<void>(resolve => { release = resolve; }); events.push("last"); });
  const closing = scope.close();
  assert.equal(scope.signal.aborted, true);
  assert.throws(() => scope.add(() => {}), /ended/);
  assert.equal(scope.close(), closing);
  await Promise.resolve();
  assert.deepEqual(events, ["first"]);
  release();
  await assert.rejects(closing, AggregateError);
  assert.deepEqual(events, ["first", "last"]);
});

test("manual disposal and host teardown dispose a registration only once", async () => {
  const scope = new TweakResources();
  let count = 0;
  const dispose = scope.add(() => { count++; });
  await dispose();
  await dispose();
  await scope.close();
  assert.equal(count, 1);
});


test("host teardown waits for manually initiated cleanup still in progress", async () => {
  const scope = new TweakResources();
  let release!: () => void;
  const dispose = scope.add(() => new Promise<void>(resolve => { release = resolve; }));
  void dispose();
  const closing = scope.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});

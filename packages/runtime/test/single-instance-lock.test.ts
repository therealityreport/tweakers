import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");

test("runtime requests a single instance and focuses the primary window", () => {
  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /app\.on\("second-instance"/);
});

test("single-instance locking is guarded away from the health-check probe", () => {
  const guardIndex = mainSource.indexOf("if (!healthCheckOnly) {");
  const lockIndex = mainSource.indexOf("app.requestSingleInstanceLock()");

  assert.ok(guardIndex >= 0, "missing health-check exemption guard");
  assert.ok(lockIndex > guardIndex, "single-instance lock must be inside the exemption guard");

  const lockOccurrences = mainSource.match(/app\.requestSingleInstanceLock\(\)/g) ?? [];
  assert.equal(lockOccurrences.length, 1, "single-instance lock must not be duplicated outside the guard");
});

test("single-instance caveats document installer launches and injected ordering", () => {
  assert.match(mainSource, /installer-side launches|not the primary fix|belt-and-/i);
  assert.match(mainSource, /evaluation order[\s\S]*OpenAI's own entrypoint[\s\S]*not guaranteed/i);
});

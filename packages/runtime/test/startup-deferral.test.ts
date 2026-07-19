import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");

test("main tweak discovery is deferred off synchronous module evaluation", () => {
  assert.match(mainSource, /setImmediate\(\(\) => \{[\s\S]*?loadTweaksInitially\(tweakLifecycleDeps\)/);
  assert.doesNotMatch(mainSource, /^loadAllMainTweaks\(\);$/m);
});

test("managed Codex CLI bootstrap remains synchronous before tweak deferral", () => {
  const bootstrap = mainSource.indexOf("applyManagedCodexCliLaneAtBootstrap(");
  const deferral = mainSource.indexOf("setImmediate(() => {");
  assert.ok(bootstrap >= 0, "missing synchronous managed-lane bootstrap");
  assert.ok(deferral >= 0, "missing deferred tweak load");
  assert.ok(bootstrap < deferral, "managed lane must remain before tweak deferral");
});

test("Sparkle restore prefers an APFS clone and keeps the ditto fallback", () => {
  assert.match(mainSource, /cp["'\s,\]]/);
  assert.match(mainSource, /execFileSync\("\/bin\/cp", \["-Rc"/);
  assert.match(mainSource, /renameSync\(staged, appRoot\)/);
  assert.match(mainSource, /execFileSync\("ditto"/);
});

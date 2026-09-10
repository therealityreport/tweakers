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

test("the runtime never stages, restores, or prepares the official app for Sparkle", () => {
  assert.doesNotMatch(mainSource, /prepareSignedCodexForSparkleInstall|restorePristineCodexApp/);
  assert.doesNotMatch(mainSource, /execFileSync\("\/bin\/cp"|execFileSync\("ditto"/);
  assert.doesNotMatch(mainSource, /update-chatgpt(?:-reconcile|-resume|-cancel)?/);
});

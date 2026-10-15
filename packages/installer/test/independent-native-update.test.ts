import assert from "node:assert/strict";
import test from "node:test";
import { scanIndependentNativeUpdateFromWatcher } from "../src/independent-native-update.js";
import type { DoctorIndependentInputs } from "../src/doctor-independent.js";

const source = {nativeIdentity: "native-generation", installedIdentity: "installed-generation",
  nativeBuild: "20157", nativeVersion: "native-version", build: "20156"} as DoctorIndependentInputs;
test("native update watcher submits one settled build signal through the sealed review flow", async () => {
  const calls: string[] = [];
  const result = await scanIndependentNativeUpdateFromWatcher("fixture-root", {
    enabled: () => true, inputs: () => source,
    async settle() {calls.push("settle");},
    async submit(root, build) {calls.push(`${root}:${build}`);},
  });
  assert.deepEqual(calls, ["settle", "fixture-root:20157"]);
  assert.deepEqual(result, {status: "deferred", reason: "independent-doctor-review"});
});
test("native update watcher preserves disabled automatic updates without source or worker activity", async () => {
  const result = await scanIndependentNativeUpdateFromWatcher("fixture-root", {
    enabled: () => false, inputs() {throw new Error("source must remain unread");},
    async settle() {throw new Error("unexpected settle");}, async submit() {throw new Error("unexpected submit");},
  });
  assert.equal(result.status, "skipped");
});
test("native update watcher skips unchanged builds and waits for changing bundles", async () => {
  for (const same of [true, false]) {
    let reads = 0;
    const result = await scanIndependentNativeUpdateFromWatcher("fixture-root", {
      enabled: () => true,
      inputs: () => same ? {...source, nativeBuild: source.build} : reads++ === 0 ? source : {...source, nativeIdentity: "new-generation"},
      async settle() {}, async submit() {throw new Error("unsettled source must not dispatch");},
    });
    assert.deepEqual(result, same ? {status: "skipped", reason: "native-update-current"}
      : {status: "deferred", reason: "native-update-still-changing"});
  }
});
test("native update watcher retains worker errors for the existing watcher failure receipt", async () => {
  await assert.rejects(scanIndependentNativeUpdateFromWatcher("fixture-root", {
    enabled: () => true, inputs: () => source, async settle() {},
    async submit() {throw new Error("local Manager component unavailable");},
  }), /local Manager component unavailable/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  RENDERER_PATCH_SET_GENERATION,
  RendererPatchDeclined,
  rendererPatchRetryWarranted,
  runOptionalRendererPatch,
  summarizeRendererPatches,
  type RendererPatchRecord,
} from "../src/renderer-patch-outcome";
import { describeRendererPatchCoverage } from "../src/commands/status";

test("an applied optional patch is recorded as applied", () => {
  const outcome = runOptionalRendererPatch("renderer.model-selection", () => ({
    status: "patched",
    scannedFiles: 12,
    relativePath: "webview/assets/app.js",
    strategy: "new-draft-explicit-selection",
  }));
  assert.equal(outcome.status, "patched");
  assert.equal(outcome.scannedFiles, 12);
  assert.equal(outcome.strategy, "new-draft-explicit-selection");
  assert.equal(outcome.reasonCode, undefined);
});

test("optional drift becomes a recorded skip, not a thrown transaction", () => {
  const outcome = runOptionalRendererPatch("renderer.inactive-thread-retention", () => {
    throw new RendererPatchDeclined({
      reasonCode: "layout-drift",
      relativePath: "webview/assets/app-initial-BYOVlUBL.js",
      message: "policy layout changed; refusing an unverified renderer change",
    });
  });
  assert.equal(outcome.status, "skipped-drift");
  assert.equal(outcome.reasonCode, "layout-drift");
  assert.equal(outcome.relativePath, "webview/assets/app-initial-BYOVlUBL.js");
  assert.match(outcome.detail ?? "", /refusing an unverified renderer change/);
});

test("a bare Error from an optional patcher is still fatal", () => {
  // Without this the whole design is a lie: the helper must not decay into a
  // blanket try/catch that swallows our own bugs.
  assert.throws(
    () =>
      runOptionalRendererPatch("renderer.model-selection", () => {
        throw new Error("boom");
      }),
    /boom/,
  );
});

test("an ambiguity Error from an optional patcher is still fatal", () => {
  assert.throws(
    () =>
      runOptionalRendererPatch("renderer.inactive-thread-retention", () => {
        throw new Error("matched 2 renderer files; refusing an ambiguous renderer change");
      }),
    /ambiguous renderer change/,
  );
});

test("a TypeError in our own matcher is still fatal", () => {
  assert.throws(
    () =>
      runOptionalRendererPatch("renderer.model-selection", () => {
        throw new TypeError("undefined is not a function");
      }),
    TypeError,
  );
});

test("records serialize identically regardless of evaluation order", () => {
  const a = summarizeRendererPatches([
    { id: "renderer.model-selection", status: "patched", scannedFiles: 3 },
    { id: "renderer.inactive-thread-retention", status: "skipped-drift", scannedFiles: 0 },
  ]);
  const b = summarizeRendererPatches([
    { id: "renderer.inactive-thread-retention", status: "skipped-drift", scannedFiles: 0 },
    { id: "renderer.model-selection", status: "patched", scannedFiles: 3 },
  ]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.generation, RENDERER_PATCH_SET_GENERATION);
});

test("coverage is green only when every optional patch applied", () => {
  const record: RendererPatchRecord = {
    schemaVersion: 1,
    generation: 1,
    patches: [
      { id: "renderer.model-selection", status: "patched", scannedFiles: 3 },
      { id: "renderer.inactive-thread-retention", status: "already-patched", scannedFiles: 3 },
    ],
  };
  const report = describeRendererPatchCoverage(record, "26.803.61601");
  assert.ok(report);
  assert.equal(report.tone, "green");
  assert.match(report.label, /2 of 2 optional tweaks active/);
});

test("a skipped patch renders yellow and names itself", () => {
  const report = describeRendererPatchCoverage(
    {
      schemaVersion: 1,
      generation: 1,
      patches: [
        { id: "renderer.model-selection", status: "patched", scannedFiles: 3 },
        {
          id: "renderer.inactive-thread-retention",
          status: "skipped-drift",
          scannedFiles: 0,
          reasonCode: "layout-drift",
        },
      ],
    },
    "26.803.61601",
  );
  assert.ok(report);
  assert.equal(report.tone, "yellow");
  assert.match(report.label, /1 of 2 optional tweaks active/);
  assert.match(report.label, /inactive-thread-retention \(skipped-drift on 26\.803\.61601\)/);
});

test("not-applicable renders yellow, because it is indistinguishable from a lost site", () => {
  const report = describeRendererPatchCoverage(
    {
      schemaVersion: 1,
      generation: 1,
      patches: [{ id: "renderer.model-selection", status: "not-applicable", scannedFiles: 4469 }],
    },
    null,
  );
  assert.ok(report);
  assert.equal(report.tone, "yellow");
});

test("an absent record renders nothing at all", () => {
  // A payload built before this accounting never claimed anything; warning
  // about it would be a false alarm rather than news.
  assert.equal(describeRendererPatchCoverage(null, "26.803.61601"), null);
  assert.equal(
    describeRendererPatchCoverage({ schemaVersion: 1, generation: 1, patches: [] }, null),
    null,
  );
});

test("repair re-arms only a stale degraded record", () => {
  const degraded = (generation: number): RendererPatchRecord => ({
    schemaVersion: 1,
    generation,
    patches: [
      { id: "renderer.inactive-thread-retention", status: "skipped-drift", scannedFiles: 0 },
    ],
  });
  const healthy: RendererPatchRecord = {
    schemaVersion: 1,
    generation: RENDERER_PATCH_SET_GENERATION,
    patches: [{ id: "renderer.model-selection", status: "patched", scannedFiles: 3 }],
  };

  assert.equal(rendererPatchRetryWarranted(degraded(RENDERER_PATCH_SET_GENERATION - 1)), true);
  // Already tried by this generation — retrying would loop the watcher.
  assert.equal(rendererPatchRetryWarranted(degraded(RENDERER_PATCH_SET_GENERATION)), false);
  assert.equal(rendererPatchRetryWarranted(healthy), false);
  assert.equal(rendererPatchRetryWarranted(null), false);
});

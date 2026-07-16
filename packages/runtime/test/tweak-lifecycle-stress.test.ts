import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { discoverTweaks } from "../src/tweak-discovery";
import {
  createTweakLifecycleJournal,
  lifecycleRecordKey,
  recoverInterruptedTweaks,
  runWithStartupTimeout,
  type TweakLifecycleStatus,
} from "../src/tweak-lifecycle";

test("40-entry lifecycle stress: deterministic discovery and isolated outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-lifecycle-stress-"));
  try {
    const specs = [
      ...Array.from({ length: 30 }, (_, index) => ({ dir: `ready-${String(index).padStart(2, "0")}`, id: `co.test.ready-${index}`, kind: "ready" })),
      ...Array.from({ length: 3 }, (_, index) => ({ dir: `disabled-${index}`, id: `co.test.disabled-${index}`, kind: "disabled" })),
      ...Array.from({ length: 2 }, (_, index) => ({ dir: `failing-${index}`, id: `co.test.failing-${index}`, kind: "failing" })),
      ...Array.from({ length: 2 }, (_, index) => ({ dir: `timed-out-${index}`, id: `co.test.timed-out-${index}`, kind: "timed_out" })),
      { dir: "duplicate-a", id: "co.test.duplicate", kind: "duplicate" },
      { dir: "duplicate-b", id: "co.test.duplicate", kind: "duplicate" },
      { dir: "interrupted", id: "co.test.interrupted", kind: "interrupted" },
    ] as const;
    assert.equal(specs.length, 40);

    // Create in reverse order to prove discovery sorts independently of
    // creation/filesystem enumeration order.
    for (const spec of [...specs].reverse()) {
      const dir = join(root, spec.dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({
        id: spec.id,
        name: spec.dir,
        version: "1.0.0",
        githubRepo: "example/stress",
        scope: "renderer",
      }));
      writeFileSync(join(dir, "index.js"), "module.exports={start(){}};\n");
    }

    const discovered = discoverTweaks(root);
    assert.equal(discovered.length, 40);
    assert.deepEqual(
      discovered.map((entry) => basename(entry.dir)),
      discovered.map((entry) => basename(entry.dir)).toSorted((a, b) => a.localeCompare(b)),
    );

    const duplicateIds = new Set(
      discovered
        .map((entry) => entry.manifest.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index),
    );
    const outcomes = new Map<string, TweakLifecycleStatus | "duplicate">();
    let continuedAfterFailure = false;
    const failureFirst = specs.find((spec) => spec.dir === "failing-0")!;
    const laterReady = specs.find((spec) => spec.dir === "ready-29")!;
    const executionSpecs = [failureFirst, laterReady, ...specs.filter((spec) => spec !== failureFirst && spec !== laterReady)];
    for (const spec of executionSpecs) {
      if (duplicateIds.has(spec.id)) {
        outcomes.set(spec.dir, "duplicate");
        continue;
      }
      if (spec.kind === "disabled") {
        outcomes.set(spec.dir, "disabled");
        continue;
      }
      if (spec.kind === "interrupted") continue;
      try {
        const result = await runWithStartupTimeout(
          () => spec.kind === "failing"
            ? Promise.reject(new Error("synthetic failure"))
            : spec.kind === "timed_out"
              ? new Promise<void>(() => {})
              : Promise.resolve(),
          100,
        );
        outcomes.set(spec.dir, result.status === "timed_out" ? "timed_out" : "ready");
      } catch {
        outcomes.set(spec.dir, "failed");
        continuedAfterFailure = true;
      }
    }

    const journal = createTweakLifecycleJournal("interrupted-attempt", 111, "before");
    journal.records[lifecycleRecordKey("renderer", "co.test.interrupted")] = {
      id: "co.test.interrupted",
      process: "renderer",
      status: "starting",
      attemptId: "interrupted-attempt",
      updatedAt: "before",
      // Second consecutive interruption — the first alone only retries.
      interruptedAttempts: 1,
    };
    const recovered = recoverInterruptedTweaks(journal, "after");
    outcomes.set("interrupted", recovered.records["renderer:co.test.interrupted"]!.status);

    const count = (status: TweakLifecycleStatus | "duplicate") =>
      [...outcomes.values()].filter((value) => value === status).length;
    assert.equal(count("ready"), 30);
    assert.equal(count("disabled"), 3);
    assert.equal(count("failed"), 2);
    assert.equal(count("timed_out"), 2);
    assert.equal(count("duplicate"), 2);
    assert.equal(count("quarantined"), 1);
    assert.equal(continuedAfterFailure, true);
    assert.equal(outcomes.get("ready-29"), "ready", "later siblings still start after failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

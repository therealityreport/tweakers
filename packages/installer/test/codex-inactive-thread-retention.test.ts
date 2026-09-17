import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_INACTIVE_THREAD_RETENTION_MARKER,
  patchCodexInactiveThreadRetentionInExtractedApp,
  patchCodexInactiveThreadRetentionSource,
} from "../src/codex-inactive-thread-retention";
import { RendererPatchDeclined } from "../src/renderer-patch-outcome";

interface PolicyShape {
  /** Minified binding names, which churn on every desktop rebuild. */
  ttl?: string;
  check?: string;
  cache?: string;
  policy?: string;
  ttlSeconds?: string;
  checkMs?: string;
  cacheLimit?: string;
}

/**
 * Mirrors the real renderer: a policy declaration whose names are minified,
 * plus the telemetry call that names those bindings in wire-visible keys.
 */
function policyFixture(shape: PolicyShape = {}): string {
  const ttl = shape.ttl ?? "zjn";
  const check = shape.check ?? "Bjn";
  const cache = shape.cache ?? "Vjn";
  const policy = shape.policy ?? "Hjn";
  const ttlSeconds = shape.ttlSeconds ?? "3600";
  const checkMs = shape.checkMs ?? "15e3";
  const cacheLimit = shape.cacheLimit ?? "4";
  return [
    `const ${ttl}=${ttlSeconds}*1e3,${check}=${checkMs},${cache}=${cacheLimit},${policy}=class {`,
    "  activeThreadSafeguard(e){return e.active||e.inProgress||e.isFollower}",
    "  evaluate(t,i,r){",
    "    return this.log(`inactive_thread_unsubscribe_candidates_evaluated`,{safe:{candidateCount:t.length," +
      `conversationIdsToUnsubscribe:i,maxInactiveOwnerThreads:${cache},overage:r,ttlMs:${ttl}},sensitive:{}}),i`,
    "  }",
    '  unsubscribe(){this.emit("inactive_thread_unsubscribed");return this.invoke("thread/unsubscribe")}',
    "};",
  ].join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("bounds TTL and owner cache while preserving safeguards", () => {
  const original = policyFixture();
  const patched = patchCodexInactiveThreadRetentionSource(original);
  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "telemetry-key-discovery");
  assert.deepEqual(patched.observed, { ttlSeconds: 3600, ownerCache: 4 });
  assert.match(patched.source, /zjn=60\*1e3,Bjn=15e3,Vjn=0\/\*__tweaker_inactive_thread_retention__\*\//);
  assert.match(patched.source, /activeThreadSafeguard\(e\)\{return e\.active\|\|e\.inProgress\|\|e\.isFollower\}/);
  // The telemetry call itself must be untouched — it is the anchor.
  assert.match(patched.source, /inactive_thread_unsubscribe_candidates_evaluated/);
});

test("is idempotent through the marker, not through value inference", () => {
  const first = patchCodexInactiveThreadRetentionSource(policyFixture());
  assert.ok(first);
  const second = patchCodexInactiveThreadRetentionSource(first.source);
  assert.ok(second);
  assert.equal(second.changed, false);
  assert.equal(second.strategy, "already-patched");
  assert.equal(second.source, first.source);
});

test("a bundle legitimately shipping the bounded values is still treated as unpatched", () => {
  // No marker ⇒ upstream chose these values; we still stamp our own edit.
  const upstream = policyFixture({ ttlSeconds: "60", cacheLimit: "0" });
  assert.ok(!upstream.includes(CODEX_INACTIVE_THREAD_RETENTION_MARKER));
  const patched = patchCodexInactiveThreadRetentionSource(upstream);
  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "telemetry-key-discovery");
  assert.ok(patched.source.includes(CODEX_INACTIVE_THREAD_RETENTION_MARKER));
});

test("tracks renamed minified bindings across desktop rebuilds", () => {
  // 6321 shipped zjn/Vjn; 6396 renamed them to jjn/Njn with identical shape.
  // Both resolve through the telemetry anchor.
  const renamed = policyFixture({ ttl: "jjn", check: "Mjn", cache: "Njn", policy: "Pjn" });
  const patched = patchCodexInactiveThreadRetentionSource(renamed);
  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.match(patched.source, /jjn=60\*1e3,Mjn=15e3,Njn=0\/\*__tweaker_inactive_thread_retention__\*\//);
});

test("absorbs value and interval churn the pinned matcher rejected", () => {
  for (const shape of [
    { ttlSeconds: "7200" },
    { cacheLimit: "6" },
    { checkMs: "2e4" },
    { ttl: "$a", check: "$b", cache: "$c", policy: "$d" },
  ] satisfies PolicyShape[]) {
    const patched = patchCodexInactiveThreadRetentionSource(policyFixture(shape));
    assert.ok(patched, `expected a patch for ${JSON.stringify(shape)}`);
    assert.equal(patched.changed, true, `expected a change for ${JSON.stringify(shape)}`);
  }
});

test("ignores renderer files that do not carry the policy", () => {
  assert.equal(patchCodexInactiveThreadRetentionSource("export const value=1;"), null);
  // The old declaration shape alone is not enough — without the telemetry
  // anchor there is nothing to verify against.
  assert.equal(
    patchCodexInactiveThreadRetentionSource("const zjn=3600*1e3,Bjn=15e3,Vjn=4,Hjn=class {};"),
    null,
  );
});

test("declines layout drift without writing any bytes", () => {
  // Anchor present, but the payload no longer names its bindings.
  const drifted = policyFixture().replace("ttlMs:zjn", "ttlMs:this.ttl()");
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(drifted),
    (error: unknown) =>
      error instanceof RendererPatchDeclined && error.reasonCode === "layout-drift",
  );
});

test("declines when a discovered binding is no longer a plain numeric assignment", () => {
  const computed = policyFixture().replace("const zjn=3600*1e3", "const zjn=readTtl()");
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(computed),
    (error: unknown) =>
      error instanceof RendererPatchDeclined && error.reasonCode === "layout-drift",
  );
});

test("a decline leaves the file byte-identical", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-retention-decline-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    const drifted = policyFixture().replace("ttlMs:zjn", "ttlMs:this.ttl()");
    const assetPath = join(assetsDir, "app-initial-Biw83Aiz.js");
    writeFileSync(assetPath, drifted);
    const before = sha256(readFileSync(assetPath, "utf8"));

    assert.throws(
      () => patchCodexInactiveThreadRetentionInExtractedApp(appDir),
      (error: unknown) => error instanceof RendererPatchDeclined,
    );
    assert.equal(sha256(readFileSync(assetPath, "utf8")), before);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("ambiguity still fails the build", () => {
  // Two anchors in one file: we can no longer tell which policy is live.
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(`${policyFixture()}\n${policyFixture({ ttl: "qqn" })}`),
    (error: unknown) => error instanceof Error && !(error instanceof RendererPatchDeclined),
  );
});

test("a binding assigned more than once still fails the build", () => {
  const reassigned = `${policyFixture()}\nzjn=99;`;
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(reassigned),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof RendererPatchDeclined) &&
      /assigned 2 times/.test(error.message),
  );
});

test("a marker attached to an unbounded policy still fails the build", () => {
  const lying = policyFixture().replace("Vjn=4", `Vjn=4/*${CODEX_INACTIVE_THREAD_RETENTION_MARKER}*/`);
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(lying),
    (error: unknown) =>
      error instanceof Error && !(error instanceof RendererPatchDeclined) && /unbounded/.test(error.message),
  );
});

test("never binds a decoy ttlMs outside the telemetry window", () => {
  const decoy = `const other=1;const cfg={ttlMs:other};\n${policyFixture()}`;
  const patched = patchCodexInactiveThreadRetentionSource(decoy);
  assert.ok(patched);
  assert.match(patched.source, /zjn=60\*1e3/);
  assert.match(patched.source, /const cfg=\{ttlMs:other\}/);
});

test("extracted-app discovery patches exactly one renderer asset", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-inactive-thread-retention-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "app.js"), policyFixture());
    writeFileSync(join(assetsDir, "unrelated.js"), "export const value=1;");

    const first = patchCodexInactiveThreadRetentionInExtractedApp(appDir);
    assert.equal(first.status, "patched");
    assert.equal(first.relativePath, join("webview", "assets", "app.js"));
    assert.equal(first.scannedFiles, 2);
    assert.match(first.detail ?? "", /bounded upstream ttl 3600s and owner cache 4/);
    assert.match(readFileSync(join(assetsDir, "app.js"), "utf8"), /zjn=60\*1e3,Bjn=15e3,Vjn=0/);

    const second = patchCodexInactiveThreadRetentionInExtractedApp(appDir);
    assert.equal(second.status, "already-patched");
    assert.equal(second.relativePath, first.relativePath);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("extracted-app discovery rejects two verified renderer assets", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-inactive-thread-retention-ambiguous-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "one.js"), policyFixture());
    writeFileSync(join(assetsDir, "two.js"), policyFixture());
    assert.throws(
      () => patchCodexInactiveThreadRetentionInExtractedApp(appDir),
      /matched 2 renderer files/,
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("no policy anywhere reports not-applicable", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-retention-absent-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "app.js"), "export const value=1;");
    const result = patchCodexInactiveThreadRetentionInExtractedApp(appDir);
    assert.equal(result.status, "not-applicable");
    assert.equal(result.scannedFiles, 1);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("Doctor data-only repair locates a renamed retention event without granting code edits", async () => {
  const { validateDoctorPatchRepair, applyDoctorPatchRepairs } = await import("../src/doctor-patch-repair.js");
  const anchor = "inactive_thread_retention_candidates_evaluated";
  const source = policyFixture().replace("inactive_thread_unsubscribe_candidates_evaluated", anchor);
  const repair = {version: 1 as const, patchId: "inactive-thread-retention-patch" as const, path: "webview/assets/retention.js", sourceSha256: `sha256:${sha256(source)}`, telemetryAnchor: anchor};
  assert.equal(patchCodexInactiveThreadRetentionSource(source), null);
  assert.deepEqual(validateDoctorPatchRepair(repair, source), repair);
  assert.throws(() => validateDoctorPatchRepair({...repair, executable: "disableChecks()"}, source), /scope/);
  assert.throws(() => validateDoctorPatchRepair({...repair, path: "webview/../config.js"}, source), /scope/);
  assert.throws(() => validateDoctorPatchRepair({...repair, patchId: "accounts-native-patch"}, source), /scope/);
  assert.throws(() => validateDoctorPatchRepair(repair, source + "\n"), /binding/);
  const bait = "const wrongTTL=3600*1e3,wrongCache=4;\n" + source.replace("{safe:{candidateCount", "{other:{ttlMs:wrongTTL,maxInactiveOwnerThreads:wrongCache},safe:{candidateCount");
  assert.throws(() => validateDoctorPatchRepair({...repair, sourceSha256: `sha256:${sha256(bait)}`}, bait), /exact telemetry binding/);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-repair-adapter-")));
  try {
    mkdirSync(join(root, "webview/assets"), {recursive: true}); writeFileSync(join(root, repair.path), source);
    applyDoctorPatchRepairs(root, [repair]);
    const result = patchCodexInactiveThreadRetentionInExtractedApp(root, new Map([[repair.path, anchor]]));
    assert.equal(result.status, "already-patched");
    assert.match(readFileSync(join(root, repair.path), "utf8"), /activeThreadSafeguard\(e\)\{return e\.active\|\|e\.inProgress\|\|e\.isFollower\}/);
    assert.throws(() => applyDoctorPatchRepairs(root, [repair]), /binding/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("Doctor repair attempts are bounded, retained, reused and never replay interrupted requests", async () => {
  const asar = (await import("@electron/asar")).default;
  const { repairDoctorConflict } = await import("../src/doctor-repair.js");
  const { writeDoctorPrivateJson, readDoctorPrivateJson } = await import("../src/doctor-store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-repair-loop-")));
  try {
    const source = policyFixture().replace("inactive_thread_unsubscribe_candidates_evaluated", "inactive_thread_retention_candidates_evaluated");
    const input = join(root, "source"); mkdirSync(join(input, "webview/assets"), {recursive: true}); writeFileSync(join(input, "webview/assets/retention.js"), source);
    const packagePath = join(root, "app.asar"); await asar.createPackage(input, packagePath);
    const request = {jobRoot: root, binding: "fixed-inputs", conflictId: "inactive-thread-retention-patch", failure: "anchor missing", asarPath: packagePath, reviewerBinary: "/exact/codex", model: "configured", effort: "high"};
    let calls = 0;
    const rejected = {execute: async () => { calls++; throw new Error("Invalid selector"); }};
    const failed = await repairDoctorConflict(request, rejected);
    assert.equal(calls, 2); assert.equal(failed.attempts.length, 2); assert.match(failed.summary, /exhausted/);
    await repairDoctorConflict(request, rejected); assert.equal(calls, 2);
    const repaired = await repairDoctorConflict({...request, binding: "changed-source-inputs"}, {execute: async data => {
      calls++; writeDoctorPrivateJson(data.outputPath, {version: 1, patchId: "inactive-thread-retention-patch", path: "webview/assets/retention.js", sourceSha256: `sha256:${sha256(source)}`, telemetryAnchor: "inactive_thread_retention_candidates_evaluated"});
      return {run: {status: 0}, observed: {inputTokens: 1, outputTokens: 1}, adapterIdentity: "cli-v1" as const};
    }});
    assert.equal(repaired.repairs.length, 1);
    await repairDoctorConflict({...request, binding: "changed-source-inputs"}, rejected); assert.equal(calls, 3);
    const statePath = join(root, "repairs/state.json");
    const state = readDoctorPrivateJson(statePath) as {version: 1; attempts: Array<Record<string, unknown>>};
    state.attempts.push({binding: "interrupted", conflictId: request.conflictId, attempt: 1, status: "reserved", evidence: join(root, "repairs/attempt-4.json"), summary: "reserved"}); writeDoctorPrivateJson(statePath, state);
    const interrupted = await repairDoctorConflict({...request, binding: "interrupted"}, rejected);
    assert.match(interrupted.summary, /interrupted/); assert.equal(calls, 3);
    const exhausted = await repairDoctorConflict({...request, binding: "another-input"}, rejected);
    assert.match(exhausted.summary, /four-execution/); assert.equal(calls, 3);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("Doctor repair recovers a terminal retained attempt without replaying it", async () => {
  const asar = (await import("@electron/asar")).default;
  const { repairDoctorConflict } = await import("../src/doctor-repair.js");
  const { reserveDoctorReviewRequest, recordDoctorReviewUsage, readDoctorReviewUsage } = await import("../src/doctor-review-budget.js");
  const { writeDoctorPrivateJson, readDoctorPrivateJson } = await import("../src/doctor-store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-repair-recovery-")));
  try {
    const source = policyFixture().replace("inactive_thread_unsubscribe_candidates_evaluated", "inactive_thread_retention_candidates_evaluated");
    const input = join(root, "source");
    mkdirSync(join(input, "webview/assets"), { recursive: true });
    writeFileSync(join(input, "webview/assets/retention.js"), source);
    const asarPath = join(root, "app.asar");
    await asar.createPackage(input, asarPath);
    const request = { jobRoot: root, binding: "recovery-inputs", conflictId: "inactive-thread-retention-patch", failure: "anchor missing", asarPath,
      reviewerBinary: "/exact/codex", model: "configured", effort: "high" };
    const repairRoot = join(root, "repairs"), outputPath = join(repairRoot, "attempt-1.json");
    const reservation = reserveDoctorReviewRequest(repairRoot, request.binding, 1, {
      evidenceFingerprint: request.binding, outputPath, eventsPath: `${outputPath}.events.json`, questionIds: [request.conflictId],
    });
    recordDoctorReviewUsage(repairRoot, request.binding, reservation, { inputTokens: 7, outputTokens: 3 });
    writeDoctorPrivateJson(`${outputPath}.events.json`, {
      status: 1,
      stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }),
    });
    writeDoctorPrivateJson(join(repairRoot, "state.json"), {
      version: 1,
      attempts: [{ binding: request.binding, conflictId: request.conflictId, attempt: 1, status: "reserved", evidence: outputPath, summary: "reserved" }],
    });

    let dispatches = 0;
    const recovered = await repairDoctorConflict(request, { execute: async data => {
      dispatches += 1;
      writeDoctorPrivateJson(data.outputPath, { version: 1, patchId: request.conflictId, path: "webview/assets/retention.js",
        sourceSha256: `sha256:${sha256(source)}`, telemetryAnchor: "inactive_thread_retention_candidates_evaluated" });
      return { run: { status: 0 }, observed: { inputTokens: 1, outputTokens: 1 }, adapterIdentity: "cli-v1" as const };
    }});
    assert.equal(dispatches, 1, "the recovered terminal request must not be replayed");
    assert.equal(recovered.repairs.length, 1, "one corrective execution remains after the recovered rejection");
    assert.deepEqual(recovered.usage, { inputTokens: 7, outputTokens: 3 });
    const rejected = (readDoctorPrivateJson(join(repairRoot, "state.json")) as { attempts: Array<{ status: string }> }).attempts;
    assert.deepEqual(rejected.map(attempt => attempt.status), ["rejected", "completed"]);
    assert.equal(readDoctorReviewUsage(repairRoot, request.binding).requests.length, 1, "recovery must reuse the persisted ledger reservation");

    await repairDoctorConflict(request, { execute: async () => { dispatches += 1; throw new Error("should not dispatch a completed recovery"); }});
    assert.equal(dispatches, 1, "the corrective success is reused without redispatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Doctor repair reuses a recovered successful attempt without dispatch", async () => {
  const asar = (await import("@electron/asar")).default;
  const { repairDoctorConflict } = await import("../src/doctor-repair.js");
  const { reserveDoctorReviewRequest, recordDoctorReviewUsage } = await import("../src/doctor-review-budget.js");
  const { writeDoctorPrivateJson } = await import("../src/doctor-store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-repair-recovered-success-")));
  try {
    const source = policyFixture().replace("inactive_thread_unsubscribe_candidates_evaluated", "inactive_thread_retention_candidates_evaluated");
    const input = join(root, "source");
    mkdirSync(join(input, "webview/assets"), { recursive: true });
    writeFileSync(join(input, "webview/assets/retention.js"), source);
    const asarPath = join(root, "app.asar");
    await asar.createPackage(input, asarPath);
    const request = { jobRoot: root, binding: "recovered-success-inputs", conflictId: "inactive-thread-retention-patch", failure: "anchor missing", asarPath,
      reviewerBinary: "/exact/codex", model: "configured", effort: "high" };
    const repairRoot = join(root, "repairs"), outputPath = join(repairRoot, "attempt-1.json");
    const reservation = reserveDoctorReviewRequest(repairRoot, request.binding, 1, {
      evidenceFingerprint: request.binding, outputPath, eventsPath: `${outputPath}.events.json`, questionIds: [request.conflictId],
    });
    recordDoctorReviewUsage(repairRoot, request.binding, reservation, { inputTokens: 5, outputTokens: 2 });
    writeDoctorPrivateJson(outputPath, { version: 1, patchId: request.conflictId, path: "webview/assets/retention.js",
      sourceSha256: `sha256:${sha256(source)}`, telemetryAnchor: "inactive_thread_retention_candidates_evaluated" });
    writeDoctorPrivateJson(`${outputPath}.events.json`, {
      status: 0,
      stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }),
    });
    writeDoctorPrivateJson(join(repairRoot, "state.json"), {
      version: 1,
      attempts: [{ binding: request.binding, conflictId: request.conflictId, attempt: 1, status: "reserved", evidence: outputPath, summary: "reserved" }],
    });

    let dispatches = 0;
    const result = await repairDoctorConflict(request, { execute: async () => { dispatches += 1; throw new Error("recovery should be reused"); }});
    assert.equal(dispatches, 0);
    assert.equal(result.repairs.length, 1);
    assert.match(result.summary, /Reused exact-input verified repair/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

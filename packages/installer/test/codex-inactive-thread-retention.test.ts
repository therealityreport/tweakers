import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

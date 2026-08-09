import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  patchCodexInactiveThreadRetentionInExtractedApp,
  patchCodexInactiveThreadRetentionSource,
} from "../src/codex-inactive-thread-retention";

function policyFixture(): string {
  return [
    "const zjn=3600*1e3,Bjn=15e3,Vjn=4,Hjn=class {",
    "  activeThreadSafeguard(e){return e.active||e.inProgress||e.isFollower}",
    '  schedule(){this.emit("inactive_thread_unsubscribe_check_scheduled")}',
    '  unsubscribe(){this.emit("inactive_thread_unsubscribed");return this.invoke("thread/unsubscribe")}',
    "  maxInactiveOwnerThreads=Vjn;",
    "};",
    "export const maxInactiveOwnerThreads=Vjn;",
  ].join("\n");
}

test("inactive-thread retention patch bounds TTL and owner cache while preserving safeguards", () => {
  const original = policyFixture();
  const patched = patchCodexInactiveThreadRetentionSource(original);
  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "bounded-local-policy");
  assert.match(patched.source, /zjn=60\*1e3,Bjn=15e3,Vjn=0,Hjn=class/);
  assert.match(patched.source, /activeThreadSafeguard\(e\)\{return e\.active\|\|e\.inProgress\|\|e\.isFollower\}/);
  assert.equal(
    patched.source.replace(/zjn=60\*1e3,Bjn=15e3,Vjn=0,Hjn=class/, ""),
    original.replace(/zjn=3600\*1e3,Bjn=15e3,Vjn=4,Hjn=class/, ""),
  );
});

test("inactive-thread retention patch is idempotent", () => {
  const first = patchCodexInactiveThreadRetentionSource(policyFixture());
  assert.ok(first);
  const second = patchCodexInactiveThreadRetentionSource(first.source);
  assert.ok(second);
  assert.equal(second.changed, false);
  assert.equal(second.strategy, "already-patched");
  assert.equal(second.source, first.source);
});

test("inactive-thread retention patch ignores unrelated renderer code", () => {
  assert.equal(patchCodexInactiveThreadRetentionSource("const zjn=3600*1e3,Bjn=15e3,Vjn=4,Hjn=class {};"), null);
});

test("inactive-thread retention patch rejects ambiguous policies", () => {
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(`${policyFixture()}\n${policyFixture()}`),
    /matched multiple renderer initializers/,
  );
});

test("inactive-thread retention patch rejects policy drift", () => {
  const drifted = policyFixture().replace("zjn=3600*1e3", "zjn=1800*1e3");
  assert.throws(
    () => patchCodexInactiveThreadRetentionSource(drifted),
    /layout changed/,
  );
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

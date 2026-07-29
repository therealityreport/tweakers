import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stagePatchedCandidateRuntimeArtifact } from "../src/commands/install";

test("candidate runtime artifact preserves the validated source and atomically replaces only its receipt destination", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-candidate-runtime-"));
  try {
    const candidateRuntime = join(root, "candidate-build", "runtime");
    const receiptRuntime = join(root, "receipt", "requested-runtime");
    mkdirSync(candidateRuntime, { recursive: true });
    mkdirSync(receiptRuntime, { recursive: true });
    writeFileSync(join(candidateRuntime, "main.js"), "validated runtime");
    writeFileSync(join(receiptRuntime, "main.js"), "old runtime");
    writeFileSync(join(receiptRuntime, "stale.js"), "stale");

    stagePatchedCandidateRuntimeArtifact(candidateRuntime, receiptRuntime);

    assert.equal(readFileSync(join(candidateRuntime, "main.js"), "utf8"), "validated runtime");
    assert.equal(readFileSync(join(receiptRuntime, "main.js"), "utf8"), "validated runtime");
    assert.equal(existsSync(join(receiptRuntime, "stale.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate runtime artifact rejects non-absolute, nested, and missing paths before replacing anything", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-candidate-runtime-invalid-"));
  try {
    const candidateRuntime = join(root, "candidate", "runtime");
    const receiptRuntime = join(root, "receipt", "runtime");
    mkdirSync(candidateRuntime, { recursive: true });
    mkdirSync(receiptRuntime, { recursive: true });
    writeFileSync(join(receiptRuntime, "keep.js"), "keep");

    assert.throws(
      () => stagePatchedCandidateRuntimeArtifact("relative/runtime", receiptRuntime),
      /exact absolute path/,
    );
    assert.throws(
      () => stagePatchedCandidateRuntimeArtifact(candidateRuntime, join(candidateRuntime, "nested")),
      /disjoint paths/,
    );
    assert.throws(
      () => stagePatchedCandidateRuntimeArtifact(join(root, "missing"), receiptRuntime),
      /runtime is missing/,
    );
    assert.equal(readFileSync(join(receiptRuntime, "keep.js"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patched candidate build stages its runtime after signature validation and before deleting build scratch", () => {
  const source = readFileSync(join(process.cwd(), "packages", "installer", "src", "commands", "install.ts"), "utf8");
  const signatureIndex = source.indexOf("if (!candidateSignature.ok)");
  const stageIndex = source.indexOf("stagePatchedCandidateRuntimeArtifact(join(candidateUserRoot, \"runtime\"), destinationRuntime)");
  const cleanupIndex = source.indexOf("rmSync(candidateUserRoot, { recursive: true, force: true });", stageIndex);
  assert.ok(signatureIndex >= 0, "candidate signature validation must exist");
  assert.ok(stageIndex > signatureIndex, "runtime must be staged only after the candidate validates");
  assert.ok(cleanupIndex > stageIndex, "runtime must be staged before the disposable build root is deleted");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decideRuntimeFingerprintRepair,
  computeRuntimeFingerprint,
  readRuntimeFingerprint,
} from "../src/runtime-fingerprint";

const FIXTURE_FINGERPRINT = "8ae9a8787f4db77dd61d6c23087b8941b303d3cf2f75dcc1864a169f9604c179";

test("runtime fingerprint decisions preserve the cheap current fast path", () => {
  assert.deepEqual(
    decideRuntimeFingerprintRepair({ expected: "same", active: "same", appRunning: true }),
    { action: "current", expected: "same", active: "same" },
  );
});

test("runtime fingerprint mismatch is held while the app is running", () => {
  assert.deepEqual(
    decideRuntimeFingerprintRepair({ expected: "new", active: "old", appRunning: true }),
    { action: "pending", expected: "new", active: "old" },
  );
});

test("runtime fingerprint mismatch requests verified repair while closed", () => {
  assert.deepEqual(
    decideRuntimeFingerprintRepair({ expected: "new", active: "old", appRunning: false }),
    { action: "repair", expected: "new", active: "old" },
  );
});

test("missing runtime fingerprints retain the bounded heavy-verification fallback", () => {
  assert.equal(
    decideRuntimeFingerprintRepair({ expected: null, active: "old", appRunning: false }).action,
    "unknown",
  );
});

test("missing active runtime bytes request repair when a verified expected runtime exists", () => {
  assert.deepEqual(
    decideRuntimeFingerprintRepair({ expected: "verified", active: null, appRunning: false }),
    { action: "repair", expected: "verified", active: null },
  );
  assert.deepEqual(
    decideRuntimeFingerprintRepair({ expected: "verified", active: null, appRunning: true }),
    { action: "pending", expected: "verified", active: null },
  );
});

test("runtime tree fingerprint matches the packaging algorithm and excludes its receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-runtime-fingerprint-"));
  try {
    writeFileSync(join(root, "main.js"), "console.log(\"ok\");\n");
    writeFileSync(join(root, "runtime-fingerprint.json"), "this receipt is excluded");

    assert.deepEqual(computeRuntimeFingerprint(root), {
      fingerprint: FIXTURE_FINGERPRINT,
      fileCount: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime fingerprint reader verifies schema, file count, and actual bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-runtime-fingerprint-"));
  try {
    writeValidRuntime(root);
    assert.equal(readRuntimeFingerprint(root), FIXTURE_FINGERPRINT);

    writeFileSync(join(root, "runtime-fingerprint.json"), JSON.stringify({
      schemaVersion: 1,
      fingerprint: FIXTURE_FINGERPRINT,
      fileCount: 2,
    }));
    assert.equal(readRuntimeFingerprint(root), null);

    writeFileSync(join(root, "runtime-fingerprint.json"), JSON.stringify({
      schemaVersion: 2,
      fingerprint: FIXTURE_FINGERPRINT,
      fileCount: 1,
    }));
    assert.equal(readRuntimeFingerprint(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime fingerprint reader rejects modified or missing packaged bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-runtime-fingerprint-"));
  try {
    writeValidRuntime(root);
    writeFileSync(join(root, "main.js"), "tampered\n");
    assert.equal(readRuntimeFingerprint(root), null);

    writeValidRuntime(root);
    unlinkSync(join(root, "main.js"));
    assert.equal(readRuntimeFingerprint(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeValidRuntime(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "main.js"), "console.log(\"ok\");\n");
  writeFileSync(join(root, "runtime-fingerprint.json"), JSON.stringify({
    schemaVersion: 1,
    fingerprint: FIXTURE_FINGERPRINT,
    fileCount: 1,
  }));
}

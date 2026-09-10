import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decideRuntimeFingerprintRepair,
  computeRuntimeFingerprint,
  readRuntimeFingerprint,
} from "../src/runtime-fingerprint";
import { assertAccountsTransferRuntimeCompatible, prepareAccountsTransferRecovery, readAccountsSourceRetirementReaderVersion, readAccountsTransferReaderVersion } from "../src/accounts-transfer-compatibility";
import { verifyAccountsTransferRecovery } from "../../runtime/src/account-router/transfer-recovery";
import { installManagedRuntime, managedSourceRoot } from "../src/managed-runtime";

const FIXTURE_FINGERPRINT = "8ae9a8787f4db77dd61d6c23087b8941b303d3cf2f75dcc1864a169f9604c179";

test("Accounts format protection refuses downgrade and corrupt evidence without changing state", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-transfer-compatibility-"));
  try {
    const runtime = join(root, "runtime");
    const broker = join(root, "broker");
    writeValidRuntime(runtime);
    mkdirSync(broker);
    assert.doesNotThrow(() => assertAccountsTransferRuntimeCompatible(runtime, [broker]));
    const marker = join(broker, "native-transfer.minimum-runtime.json");
    const bytes = JSON.stringify({ version: 1, minimumTransferVersion: 2 });
    writeFileSync(marker, bytes);
    assert.throws(() => assertAccountsTransferRuntimeCompatible(runtime, [broker]), /requires runtime reader v2/);
    assert.equal(readFileSync(marker, "utf8"), bytes);
    writeFileSync(marker, "corrupt");
    assert.throws(() => assertAccountsTransferRuntimeCompatible(runtime, [broker]), /corrupt/);
    unlinkSync(marker);
    writeFileSync(join(broker, "native-catalog.v2.json"), "{}");
    assert.throws(() => assertAccountsTransferRuntimeCompatible(runtime, [broker]), /requires runtime reader v2/, "deleting the marker cannot permit downgrade over v2 state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Accounts recovery binds the verified reader and validation receipt to a separate retained tree", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-transfer-recovery-"));
  try {
    const runtime = join(root, "runtime");
    const recovery = join(root, "recovery");
    mkdirSync(join(runtime, "account-router"), { recursive: true });
    writeFileSync(join(runtime, "account-router", "native-transfer.js"), `exports.ACCOUNTS_TRANSFER_READER_VERSION=2;exports.inspectNativeTransferCompatibilityV2=(marker,reader)=>({state:reader>=(marker?2:1)?'compatible':'incompatible'});`);
    writeFileSync(join(runtime, "account-router", "native-source-retirement.js"), retirementReaderSource());
    writeFileSync(join(runtime, "unrelated-reader-helper.js"), "original\n");
    writeFileSync(join(runtime, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(runtime) }));
    assert.equal(readAccountsTransferReaderVersion(runtime), 2);
    assert.equal(readAccountsSourceRetirementReaderVersion(runtime), 2);
    prepareAccountsTransferRecovery({ runtimeRoot: runtime, recoveryRoot: recovery, validation: { version: 1, checks: [{ command: "native transfer compatibility checks", exitCode: 0, outputSha256: "a".repeat(64) }] } });
    const receipt = JSON.parse(readFileSync(join(runtime, "accounts-transfer-recovery.v1.json"), "utf8"));
    const validation = JSON.parse(readFileSync(join(recovery, "accounts-transfer-validation.v1.json"), "utf8"));
    assert.equal(receipt.sourceRuntimeFingerprint, validation.sourceRuntimeFingerprint);
    assert.equal(receipt.sourceRuntimeFileCount, validation.sourceRuntimeFileCount);
    assert.match(receipt.sourceRuntimeFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(readRuntimeFingerprint(runtime));
    assert.ok(readRuntimeFingerprint(recovery));
    assert.equal(verifyAccountsTransferRecovery(runtime), true);
    const changedHelper = join(runtime, "unrelated-reader-helper.js");
    writeFileSync(changedHelper, "tampered\n");
    writeFileSync(join(runtime, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(runtime) }));
    assert.equal(verifyAccountsTransferRecovery(runtime), false, "a recomputed runtime fingerprint cannot bless source drift after recovery preparation");
    writeFileSync(changedHelper, "original\n");
    writeFileSync(join(runtime, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(runtime) }));
    assert.equal(verifyAccountsTransferRecovery(runtime), true);
    const retirementModule = join(recovery, "account-router", "native-source-retirement.js");
    writeFileSync(retirementModule, `${retirementReaderSource()}\n// tampered`);
    writeFileSync(join(recovery, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(recovery) }));
    assert.equal(verifyAccountsTransferRecovery(runtime), false, "a recomputed recovery fingerprint cannot bless a changed retirement reader");
    writeFileSync(retirementModule, retirementReaderSource());
    writeFileSync(join(recovery, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(recovery) }));
    assert.equal(verifyAccountsTransferRecovery(runtime), true);
    writeFileSync(join(recovery, "accounts-transfer-validation.v1.json"), "{}");
    assert.equal(verifyAccountsTransferRecovery(runtime), false, "changed validation evidence holds new transfer preparation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source-retirement journals require the current store reader without a minimum marker", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-retirement-compatibility-"));
  try {
    const runtime = join(root, "runtime");
    const broker = join(root, "broker");
    mkdirSync(join(broker, "native-source-retirements.v2"), { recursive: true });
    writeAccountsReaderRuntime(runtime, 2, false);
    assert.throws(() => assertAccountsTransferRuntimeCompatible(runtime, [broker]), /source-retirement journals require runtime reader v2/);
    writeAccountsReaderRuntime(runtime, 2, true);
    assert.doesNotThrow(() => assertAccountsTransferRuntimeCompatible(runtime, [broker]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed runtime replacement refuses an older bundled Accounts reader before changing current", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-transfer-gate-"));
  try {
    const userRoot = join(root, "user");
    const sourceRoot = join(root, "source");
    const current = managedSourceRoot(userRoot);
    const broker = join(userRoot, "tweak-data", "co.tweakers.account-switcher");
    mkdirSync(broker, { recursive: true });
    writeFileSync(join(broker, "native-transfer.minimum-runtime.json"), JSON.stringify({ version: 1, minimumTransferVersion: 2 }));
    writeAccountsReaderRuntime(join(current, "packages", "installer", "assets", "runtime"), 2);
    writeAccountsReaderRuntime(join(sourceRoot, "packages", "installer", "assets", "runtime"), 1);

    assert.throws(() => installManagedRuntime(sourceRoot, userRoot), /requires runtime reader v2/);
    assert.equal(readAccountsTransferReaderVersion(join(current, "packages", "installer", "assets", "runtime")), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

function writeAccountsReaderRuntime(root: string, version: 1 | 2, retirement = version === 2): void {
  mkdirSync(join(root, "account-router"), { recursive: true });
  const source = version === 2
    ? "exports.ACCOUNTS_TRANSFER_READER_VERSION=2;exports.inspectNativeTransferCompatibilityV2=(marker,reader)=>({state:reader>=(marker?2:1)?'compatible':'incompatible'});"
    : "exports.ACCOUNTS_TRANSFER_READER_VERSION=1;";
  writeFileSync(join(root, "account-router", "native-transfer.js"), source);
  if (retirement) writeFileSync(join(root, "account-router", "native-source-retirement.js"), retirementReaderSource());
  writeFileSync(join(root, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(root) }));
}

function retirementReaderSource(): string {
  return "exports.ACCOUNTS_SOURCE_RETIREMENT_READER_VERSION=2;exports.inspectNativeSourceRetirementCompatibilityV2=(candidateVersion)=>({state:candidateVersion===2?'compatible':'incompatible',minimumVersion:2});";
}

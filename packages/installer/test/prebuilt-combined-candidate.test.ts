import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPreparedPrebuiltCombinedCandidateEvidence,
  capturePreparedPrebuiltCombinedCandidateEvidence,
  resolvePrebuiltCombinedCandidateCliInput,
  validatePrebuiltCombinedCandidate,
  type AcceptedPrebuiltCodexBuildReceipt,
  type PrebuiltCombinedCandidateInput,
  type PrebuiltCombinedCandidateValidationDependencies,
} from "../src/prebuilt-combined-candidate";

const HASH = {
  installer: "1".repeat(64),
  binary: "2".repeat(64),
  receipt: "3".repeat(64),
  runtime: "4".repeat(64),
  runtimeDocument: "5".repeat(64),
  sourceApp: "6".repeat(64),
  candidateApp: "7".repeat(64),
  lkgApp: "8".repeat(64),
  backup: "9".repeat(64),
  testReceipt: "a".repeat(64),
  cargoLock: "b".repeat(64),
  diff: "c".repeat(64),
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prebuilt-combined-"));
  const binaryPath = join(root, "codex");
  const receiptPath = join(root, "accepted-build.json");
  const runtimeRoot = join(root, "runtime");
  const sourceAppRoot = join(root, "ChatGPT.app");
  mkdirSync(runtimeRoot);
  mkdirSync(sourceAppRoot);
  writeFileSync(binaryPath, "accepted-binary");
  writeFileSync(join(runtimeRoot, "runtime-fingerprint.json"), "{}\n");
  const receipt: AcceptedPrebuiltCodexBuildReceipt = {
    schemaVersion: 1,
    kind: "tweakers-prebuilt-codex-build",
    status: "accepted",
    acceptedAt: "2026-07-30T20:00:00.000Z",
    source: {
      commit: "d".repeat(40),
      tree: "e".repeat(40),
      cargoLockSha256: HASH.cargoLock,
      reviewedDiffSha256: HASH.diff,
    },
    build: {
      command: "cargo build --locked --release --package codex-cli --bin codex",
      toolchain: "rustc 1.88.0 (fixture)",
      architecture: "arm64",
    },
    tests: [{
      name: "codex lifecycle receipt suite",
      command: "cargo test --locked lifecycle_receipt",
      receiptSha256: HASH.testReceipt,
      status: "passed",
    }],
    binary: {
      path: binaryPath,
      sha256: HASH.binary,
      version: "0.146.0-alpha.3.1",
      architecture: "arm64",
    },
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const input: PrebuiltCombinedCandidateInput = {
    transactionId: "combined-canary-001",
    binaryPath,
    expectedBinarySha256: HASH.binary,
    expectedVersion: receipt.binary.version,
    expectedArchitecture: "arm64",
    receiptPath,
    expectedReceiptSha256: sha256(receiptPath),
    expectedRuntimeFingerprint: HASH.runtime,
    expectedRuntimeFileCount: 209,
    expectedRuntimeDocumentSha256: HASH.runtimeDocument,
    expectedSourceAppFingerprint: HASH.sourceApp,
    expectedBundleId: "com.openai.codex",
  };
  const dependencies: Partial<PrebuiltCombinedCandidateValidationDependencies> = {
    fingerprintFile: (path) => {
      if (path === receiptPath) return sha256(path);
      if (path === binaryPath) return HASH.binary;
      if (path === join(runtimeRoot, "runtime-fingerprint.json")) return HASH.runtimeDocument;
      return sha256(path);
    },
    probeVersion: () => receipt.binary.version,
    probeArchitecture: () => "arm64",
    sourceAppFingerprint: () => HASH.sourceApp,
    sourceAppBundleId: () => "com.openai.codex",
    runtimeEvidence: () => ({ fingerprint: HASH.runtime, fileCount: 209 }),
  };
  return { root, binaryPath, receiptPath, runtimeRoot, sourceAppRoot, receipt, input, dependencies };
}

test("accepted receipt, binary, runtime, source app, and transaction ID produce one stable payload identity", () => {
  const f = fixture();
  try {
    const context = {
      installerPayloadHash: HASH.installer,
      runtimeRoot: f.runtimeRoot,
      sourceAppRoot: f.sourceAppRoot,
      now: new Date("2026-07-30T21:00:00.000Z"),
    };
    const first = validatePrebuiltCombinedCandidate(f.input, context, f.dependencies);
    const second = validatePrebuiltCombinedCandidate(f.input, context, f.dependencies);
    assert.equal(first.payloadIdentity, second.payloadIdentity);
    assert.match(first.payloadIdentity, /^[a-f0-9]{64}$/);
    assert.equal(first.acceptedBuildReceipt.sha256, f.input.expectedReceiptSha256);
    assert.equal(first.acceptedBuildReceipt.sourceCommit, f.receipt.source.commit);
    assert.equal(first.acceptedBuildReceipt.sourceTree, f.receipt.source.tree);
    assert.equal(first.acceptedBuildReceipt.cargoLockSha256, HASH.cargoLock);
    assert.deepEqual(first.acceptedBuildReceipt.testEvidence, [{
      name: f.receipt.tests[0]!.name,
      command: f.receipt.tests[0]!.command,
      receiptSha256: HASH.testReceipt,
    }]);

    const changedTransaction = validatePrebuiltCombinedCandidate(
      { ...f.input, transactionId: "combined-canary-002" },
      context,
      f.dependencies,
    );
    assert.notEqual(changedTransaction.payloadIdentity, first.payloadIdentity);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("receipt, binary, version, architecture, runtime, and source-app mismatches fail closed", () => {
  const f = fixture();
  try {
    const context = {
      installerPayloadHash: HASH.installer,
      runtimeRoot: f.runtimeRoot,
      sourceAppRoot: f.sourceAppRoot,
      now: new Date("2026-07-30T21:00:00.000Z"),
    };
    assert.throws(() => validatePrebuiltCombinedCandidate(
      { ...f.input, expectedReceiptSha256: "f".repeat(64) },
      context,
      f.dependencies,
    ), /receipt digest/);
    assert.throws(() => validatePrebuiltCombinedCandidate(
      { ...f.input, expectedBinarySha256: "f".repeat(64) },
      context,
      f.dependencies,
    ), /binary digest/);
    assert.throws(() => validatePrebuiltCombinedCandidate(
      { ...f.input, expectedVersion: "0.146.0-alpha.3.2" },
      context,
      f.dependencies,
    ), /binary version/);
    assert.throws(() => validatePrebuiltCombinedCandidate(
      { ...f.input, expectedRuntimeFileCount: 208 },
      context,
      f.dependencies,
    ), /runtime fingerprint or file count/);
    assert.throws(() => validatePrebuiltCombinedCandidate(
      { ...f.input, expectedSourceAppFingerprint: "f".repeat(64) },
      context,
      f.dependencies,
    ), /Source app fingerprint/);
    assert.throws(() => validatePrebuiltCombinedCandidate(
      f.input,
      context,
      { ...f.dependencies, probeArchitecture: () => null },
    ), /binary architecture/);

    const link = join(f.root, "codex-link");
    symlinkSync(f.binaryPath, link);
    assert.throws(() => validatePrebuiltCombinedCandidate(
      { ...f.input, binaryPath: link },
      context,
      f.dependencies,
    ), /regular non-symlink file/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("prepare and promote CLI actions require the same complete caller-owned evidence", () => {
  const options = {
    app: "/Applications/ChatGPT.app",
    transaction: "combined-canary-001",
    binary: "/private/tmp/codex",
    "binary-sha256": HASH.binary,
    "codex-version": "0.146.0-alpha.3.1",
    architecture: "arm64",
    receipt: "/private/tmp/accepted-build.json",
    "receipt-sha256": HASH.receipt,
    "runtime-fingerprint": HASH.runtime,
    "runtime-files": "209",
    "runtime-document-sha256": HASH.runtimeDocument,
    "source-app-fingerprint": HASH.sourceApp,
    "bundle-id": "com.openai.codex",
  };
  const prepare = resolvePrebuiltCombinedCandidateCliInput("prepare", options);
  const promote = resolvePrebuiltCombinedCandidateCliInput("promote", options);
  assert.equal(prepare.candidateOnly, true);
  assert.equal(promote.candidateOnly, false);
  assert.equal(prepare.uiFeatures, "on");
  assert.equal(resolvePrebuiltCombinedCandidateCliInput("prepare", {
    ...options,
    "ui-features": "off",
  }).uiFeatures, "off");
  assert.deepEqual(prepare.input, promote.input);
  assert.throws(
    () => resolvePrebuiltCombinedCandidateCliInput("promote", { ...options, transaction: undefined }),
    /--transaction/,
  );
  assert.throws(
    () => resolvePrebuiltCombinedCandidateCliInput("stage", options),
    /prepare or promote/,
  );
  assert.throws(
    () => resolvePrebuiltCombinedCandidateCliInput("prepare", { ...options, "ui-features": "disabled" }),
    /UI features must be off or on/,
  );
});

test("prepared candidate evidence binds embedded backend, reviewed runtime, candidate app, and rollback roots", () => {
  const f = fixture();
  try {
    const authority = validatePrebuiltCombinedCandidate(f.input, {
      installerPayloadHash: HASH.installer,
      runtimeRoot: f.runtimeRoot,
      sourceAppRoot: f.sourceAppRoot,
      now: new Date("2026-07-30T21:00:00.000Z"),
    }, f.dependencies);
    const candidateRoot = join(f.root, "candidate.app");
    const candidateRuntimeRoot = join(f.root, "candidate-runtime");
    const lastKnownGoodRoot = join(f.root, "last-known-good.app");
    const lastKnownGoodRuntimeRoot = join(f.root, "last-known-good-runtime");
    const signedBackupRoot = join(f.root, "backup", "Codex.app");
    const signedBackupMarker = join(f.root, "last-known-good-backup.json");
    for (const path of [
      join(candidateRoot, "Contents", "Resources"),
      candidateRuntimeRoot,
      lastKnownGoodRoot,
      lastKnownGoodRuntimeRoot,
      signedBackupRoot,
    ]) mkdirSync(path, { recursive: true });
    const embedded = join(candidateRoot, "Contents", "Resources", "codex");
    writeFileSync(embedded, "accepted-binary");
    writeFileSync(join(candidateRuntimeRoot, "runtime-fingerprint.json"), "{}\n");
    writeFileSync(join(lastKnownGoodRuntimeRoot, "runtime-fingerprint.json"), "{}\n");
    writeFileSync(signedBackupMarker, '{"schemaVersion":1,"existed":true}\n');
    let embeddedDigest = HASH.binary;
    const dependencies: Partial<PrebuiltCombinedCandidateValidationDependencies> = {
      fingerprintFile: (path) => {
        if (path === embedded) return embeddedDigest;
        if (path.endsWith("runtime-fingerprint.json")) return HASH.runtimeDocument;
        return sha256(path);
      },
      probeVersion: () => authority.backend.version,
      probeArchitecture: () => "arm64",
      sourceAppBundleId: () => "com.openai.codex",
      sourceAppFingerprint: (path) => {
        if (path === candidateRoot) return HASH.candidateApp;
        if (path === lastKnownGoodRoot) return HASH.lkgApp;
        if (path === signedBackupRoot) return HASH.backup;
        return HASH.sourceApp;
      },
      runtimeEvidence: (path) => path === candidateRuntimeRoot
        ? { fingerprint: HASH.runtime, fileCount: 209 }
        : { fingerprint: "e".repeat(64), fileCount: 177 },
      verifyCandidateApp: () => true,
      verifyLastKnownGoodApp: () => true,
      verifySignedBackup: () => true,
    };
    const paths = {
      candidateRoot,
      candidateRuntimeRoot,
      lastKnownGoodRoot,
      lastKnownGoodRuntimeRoot,
      signedBackupRoot,
      signedBackupMarker,
    };
    const prepared = capturePreparedPrebuiltCombinedCandidateEvidence(
      authority,
      paths,
      dependencies,
    );
    assert.equal(prepared.candidateAppFingerprint, HASH.candidateApp);
    assert.equal(prepared.embeddedBackendSha256, HASH.binary);
    assert.deepEqual(prepared.stagedRuntime, { fingerprint: HASH.runtime, fileCount: 209 });
    assert.equal(prepared.rollback.lastKnownGoodAppFingerprint, HASH.lkgApp);
    assert.equal(prepared.rollback.signedBackupFingerprint, HASH.backup);
    assert.doesNotThrow(() => assertPreparedPrebuiltCombinedCandidateEvidence(
      authority,
      prepared,
      paths,
      dependencies,
    ));

    embeddedDigest = "f".repeat(64);
    assert.throws(() => assertPreparedPrebuiltCombinedCandidateEvidence(
      authority,
      prepared,
      paths,
      dependencies,
    ), /backend does not match/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

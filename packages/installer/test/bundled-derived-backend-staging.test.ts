import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUNDLED_DERIVED_VERSION_PROBE_TIMEOUT_MS,
  bundledDerivedBackendPath,
  bundledDerivedCodeModeHostPath,
  stageBundledDerivedBackendInsideApp,
  type BundledDerivedBackendArtifact,
} from "../src/commands/install";

test("freshly copied bundled-derived backends receive a bounded macOS first-run allowance", () => {
  assert.equal(BUNDLED_DERIVED_VERSION_PROBE_TIMEOUT_MS, 60_000);
});

function companionFixture(root: string): ReturnType<typeof fixture> {
  const result = fixture(root);
  result.artifact.version = "0.153.4";
  const binaryPath = join(root, "codex-source", "codex-code-mode-host");
  const receiptPath = join(root, "codex-source", "helper-receipt.json");
  writeFileSync(binaryPath, "matching-code-mode-helper");
  const receipt = {
    schemaVersion: 1, kind: "codex-code-mode-host-companion",
    backend: { version: result.artifact.version, sha256: result.artifact.fingerprint },
    helper: { binaryPath, version: result.artifact.version, sha256: sha256("matching-code-mode-helper") },
    provenance: { repository: "openai/codex", releaseTag: "rust-v0.153.4", commit: "a".repeat(40),
      archiveSha256: "b".repeat(64), teamIdentifier: "2DC432GLL2", assetName: "codex-code-mode-host-aarch64-apple-darwin.tar.gz" },
  };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  result.artifact.codeModeHost = { binaryPath, fingerprint: receipt.helper.sha256, receiptPath,
    receiptSha256: sha256(readFileSync(receiptPath, "utf8")) };
  return result;
}

test("retained code-mode generations stage their receipt-bound helper in the flat layout", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-code-mode-stage-"));
  try {
    const { app, artifact } = companionFixture(root);
    const originalReceipt = readFileSync(artifact.codeModeHost!.receiptPath, "utf8");
    stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => artifact.version, verifyHelperSignature: () => true });
    assert.equal(readFileSync(bundledDerivedBackendPath(app), "utf8"), "derived-backend");
    assert.equal(readFileSync(bundledDerivedCodeModeHostPath(app), "utf8"), "matching-code-mode-helper");
    assert.equal(readFileSync(artifact.codeModeHost!.receiptPath, "utf8"), originalReceipt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing required helper refuses the retained backend before copying", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-code-mode-missing-"));
  try {
    const { app, artifact } = fixture(root);
    artifact.version = "0.153.4";
    let copies = 0;
    assert.throws(() => stageBundledDerivedBackendInsideApp(app, artifact, {
      readVersion: () => artifact.version, copy: () => { copies++; },
    }), /requires a receipt-bound code-mode helper/);
    assert.equal(copies, 0);
    assert.equal(readFileSync(bundledDerivedBackendPath(app), "utf8"), "stock-backend");
    assert.equal(existsSync(bundledDerivedCodeModeHostPath(app)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a companion for a different backend or helper cannot replace candidate files", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-code-mode-pair-"));
  try {
    const { app, artifact } = companionFixture(root);
    const helper = artifact.codeModeHost!;
    const receipt = JSON.parse(readFileSync(helper.receiptPath, "utf8"));
    receipt.backend.sha256 = "0".repeat(64);
    writeFileSync(helper.receiptPath, JSON.stringify(receipt));
    helper.receiptSha256 = sha256(readFileSync(helper.receiptPath, "utf8"));
    assert.throws(() => stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => artifact.version, verifyHelperSignature: () => true }), /does not match the backend\/helper pair/);
    receipt.backend.sha256 = artifact.fingerprint;
    writeFileSync(helper.receiptPath, JSON.stringify(receipt));
    helper.receiptSha256 = sha256(readFileSync(helper.receiptPath, "utf8"));
    writeFileSync(helper.binaryPath, "a-helper-from-another-generation");
    assert.throws(() => stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => artifact.version, verifyHelperSignature: () => true }), /helper fingerprint does not match/);
    assert.equal(readFileSync(bundledDerivedBackendPath(app), "utf8"), "stock-backend");
    assert.equal(existsSync(bundledDerivedCodeModeHostPath(app)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changed helper receipts and invalid signatures fail before writes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-code-mode-receipt-"));
  try {
    const { app, artifact } = companionFixture(root);
    const helper = artifact.codeModeHost!;
    assert.throws(() => stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => artifact.version, verifyHelperSignature: () => false }), /helper signature is invalid/);
    writeFileSync(helper.receiptPath, readFileSync(helper.receiptPath, "utf8") + "\n");
    assert.throws(() => stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => artifact.version, verifyHelperSignature: () => true }), /receipt or fingerprint changed/);
    assert.equal(readFileSync(bundledDerivedBackendPath(app), "utf8"), "stock-backend");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corruption during helper copy leaves both existing executables unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-code-mode-copy-"));
  try {
    const { app, artifact } = companionFixture(root);
    writeFileSync(bundledDerivedCodeModeHostPath(app), "previous-helper");
    assert.throws(() => stageBundledDerivedBackendInsideApp(app, artifact, {
      readVersion: () => artifact.version, verifyHelperSignature: () => true,
      copy: (source, destination) => source === artifact.codeModeHost!.binaryPath
        ? writeFileSync(destination, "corrupt-helper") : copyFileSync(source, destination),
    }), /Staged code-mode helper fingerprint does not match/);
    assert.equal(readFileSync(bundledDerivedBackendPath(app), "utf8"), "stock-backend");
    assert.equal(readFileSync(bundledDerivedCodeModeHostPath(app), "utf8"), "previous-helper");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source-build companions use the existing derived receipt digests", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-code-mode-source-"));
  try {
    const { app, artifact } = companionFixture(root);
    const helper = artifact.codeModeHost!;
    writeFileSync(helper.receiptPath, JSON.stringify({ schemaVersion: 2, channel: "bundled", phase: "canary-passed", version: artifact.version,
      source: { repository: "openai/codex", checkoutCommit: "c".repeat(40) },
      candidateBinary: { version: artifact.version, digests: [
        { algorithm: "sha256", scope: "derived candidate binary", value: artifact.fingerprint },
        { algorithm: "sha256", scope: "derived candidate code-mode helper", value: helper.fingerprint },
      ] } }));
    helper.receiptSha256 = sha256(readFileSync(helper.receiptPath, "utf8"));
    stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => artifact.version, verifyHelperSignature: () => true });
    assert.equal(readFileSync(bundledDerivedCodeModeHostPath(app), "utf8"), "matching-code-mode-helper");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(root: string): { app: string; artifact: BundledDerivedBackendArtifact } {
  const app = join(root, "candidate.app");
  const binaryPath = join(root, "codex-source", "codex");
  const receiptPath = join(root, "codex-source", "receipt.json");
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(binaryPath, ".."), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "codex"), "stock-backend");
  writeFileSync(binaryPath, "derived-backend");
  writeFileSync(receiptPath, "{}\n");
  return {
    app,
    artifact: {
      binaryPath,
      version: "0.145.0-alpha.18",
      fingerprint: sha256("derived-backend"),
      receiptPath,
      transactionId: "bundled-derived-1",
    },
  };
}

test("bundled-derived backend is embedded and rechecked before candidate signing", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-bundled-derived-stage-"));
  try {
    const { app, artifact } = fixture(root);
    const staged = stageBundledDerivedBackendInsideApp(app, artifact, {
      readVersion: () => artifact.version,
    });
    assert.equal(staged, bundledDerivedBackendPath(app));
    assert.equal(readFileSync(staged, "utf8"), "derived-backend");

    const source = readFileSync(
      join(process.cwd(), "packages", "installer", "src", "commands", "install.ts"),
      "utf8",
    );
    const stageIndex = source.indexOf("stageBundledDerivedBackendInsideApp(codex.appRoot");
    const signIndex = source.indexOf("signCodexApp(codex.appRoot", stageIndex);
    assert.ok(stageIndex >= 0, "bundled-derived staging call must exist");
    assert.ok(signIndex > stageIndex, "bundled-derived backend must be embedded before final app signing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled-derived staging rejects fingerprint and version mismatches", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-bundled-derived-mismatch-"));
  try {
    const { app, artifact } = fixture(root);
    assert.throws(
      () => stageBundledDerivedBackendInsideApp(app, { ...artifact, fingerprint: "0".repeat(64) }, {
        readVersion: () => artifact.version,
      }),
      /fingerprint does not match/,
    );
    assert.throws(
      () => stageBundledDerivedBackendInsideApp(app, artifact, { readVersion: () => "0.144.6" }),
      /version does not match/,
    );
    assert.throws(
      () => stageBundledDerivedBackendInsideApp(app, artifact, {
        readVersion: () => artifact.version,
        copy: (_source, destination) => writeFileSync(destination, "changed-after-validation"),
      }),
      /Staged bundled-derived backend fingerprint does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled-derived staging rejects external-volume paths", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-bundled-derived-volume-"));
  try {
    const { app, artifact } = fixture(root);
    assert.throws(
      () => stageBundledDerivedBackendInsideApp(app, {
        ...artifact,
        binaryPath: "/Volumes/HardDrive/codex",
      }),
      /internal storage/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

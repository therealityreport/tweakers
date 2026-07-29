import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bundledDerivedBackendPath,
  stageBundledDerivedBackendInsideApp,
  type BundledDerivedBackendArtifact,
} from "../src/commands/install";

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

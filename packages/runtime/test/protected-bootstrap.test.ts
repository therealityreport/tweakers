import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyProtectedBootstrapEnvironment,
  armProtectedUpdateQuarantine,
  assertProtectedUpdateQuarantine,
  createAppliedPendingLaunchGrant,
  isAppliedPendingLaunchGrantV1,
  isProtectedBootstrapPreflightReceipt,
  runProtectedBootstrapPreflight,
  type AppliedPendingLaunchGrantV1,
} from "../src/protected-bootstrap";

const DIGEST = "a".repeat(64);
const ISSUED = "2026-08-12T19:00:00.000Z";
const NOW = "2026-08-12T19:01:00.000Z";

function fixture(): { root: string; backend: string; grant: AppliedPendingLaunchGrantV1 } {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-bootstrap-"));
  const backend = join(root, "codex");
  writeFileSync(backend, "managed backend");
  const grant = createAppliedPendingLaunchGrant({
    transactionId: "protected-test-1",
    attempt: 1,
    issuedAt: ISSUED,
    expiresAt: "2026-08-12T20:00:00.000Z",
    authoritySha256: DIGEST,
    acceptedBuildReceiptSha256: "b".repeat(64),
    environment: {
      schemaVersion: 2,
      uiFeatures: "off",
      mcpSafetyProvider: "managed-turn-idle",
      recoveryState: "normal-protected",
    },
    identity: {
      appPath: join(root, "ChatGPT.app"),
      appContentsSha256: "c".repeat(64),
      appAsarSha256: "d".repeat(64),
      asarHeaderSha256: "e".repeat(64),
      loaderPath: `${join(root, "ChatGPT.app", "Contents", "Resources", "app.asar")}/protected-loader.cjs`,
      loaderSha256: createHash("sha256").update("loader").digest("hex"),
      metadataSha256: createHash("sha256").update("metadata").digest("hex"),
      runtimeMainPath: join(root, "runtime", "main.js"),
      runtimeMainSha256: "5".repeat(64),
      backendPath: backend,
      backendSha256: "2".repeat(64),
      backendVersion: "0.147.0-alpha.6.5",
      backendArchitecture: "arm64",
      signatureReceiptSha256: createHash("sha256").update("signature").digest("hex"),
      policyDigest: createHash("sha256").update(JSON.stringify({ schemaVersion: 2, provider: "managed-turn-idle", uiFeatures: "off" })).digest("hex"),
    },
    nonce: "test-nonce-0000001",
  });
  return { root, backend, grant };
}

test("shared quarantine guard blocks autonomous updates only after the loader arms valid pre-main authority", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-quarantine-"));
  try {
    const markerFile = join(root, "transactions", "protected", "protected-quarantine-1", "update-quarantine.json");
    mkdirSync(join(root, "transactions", "protected", "protected-quarantine-1"), { recursive: true });
    assert.doesNotThrow(() => assertProtectedUpdateQuarantine({ authorityRoot: root, route: "Sparkle" }));
    const marker = armProtectedUpdateQuarantine({
      transactionId: "protected-quarantine-1",
      attempt: 1,
      preflightReceiptSha256: DIGEST,
      armedAt: NOW,
    }, (next) => writeFileSync(markerFile, JSON.stringify(next)));
    assert.equal(marker.normalLaunchBlockedUntilFreshAuthority, true);
    assert.throws(
      () => assertProtectedUpdateQuarantine({ authorityRoot: root, route: "Sparkle" }),
      /blocks Sparkle; fresh protected authority is required/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function dependencies(consumed: AppliedPendingLaunchGrantV1[] = []) {
  return {
    now: () => NOW,
    sha256File: (path: string) => path.endsWith("/codex") ? "2".repeat(64)
      : path.endsWith("app.asar") ? "d".repeat(64) : "5".repeat(64),
    probeVersion: () => "0.147.0-alpha.6.5",
    probeArchitecture: () => "arm64" as const,
    fingerprintAppContents: () => "c".repeat(64),
    readAsarHeader: () => "e".repeat(64),
    readAsarEntry: (_path: string, entry: string) => Buffer.from(entry === "protected-loader.cjs" ? "loader" : "metadata"),
    readSignature: () => "signature",
    consumeGrant: (_expected: AppliedPendingLaunchGrantV1, next: AppliedPendingLaunchGrantV1) => {
      consumed.push(next);
      return true;
    },
    emit: () => undefined,
  };
}

test("pre-main bootstrap accepts only immutable pending authority and binds the managed in-bundle backend", () => {
  const f = fixture();
  try {
    const consumed: AppliedPendingLaunchGrantV1[] = [];
    const receipt = runProtectedBootstrapPreflight({
      grant: f.grant,
      expectedTransactionId: f.grant.transactionId,
      expectedAttempt: 1,
      desktop: { pid: 77, kernelStart: "kernel-start-77" },
    }, dependencies(consumed));

    assert.equal(receipt.verdict, "PASS");
    assert.equal(isProtectedBootstrapPreflightReceipt(receipt), true);
    assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.backend?.path, f.backend);
    assert.equal(consumed.length, 1);
    assert.deepEqual(consumed[0]?.consumedBy, {
      desktopPid: 77,
      desktopKernelStart: "kernel-start-77",
      consumedAt: NOW,
    });
    assert.deepEqual(
      applyProtectedBootstrapEnvironment(receipt, { CODEX_CLI_PATH: "/official/bundled/codex", KEEP: "yes" }),
      { CODEX_CLI_PATH: f.backend, KEEP: "yes" },
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("pre-main bootstrap refuses post-main receipt fields without consuming a grant", () => {
  const f = fixture();
  try {
    const malicious = { ...f.grant, installedCanary: { verdict: "PASS" } };
    const consumed: AppliedPendingLaunchGrantV1[] = [];
    const receipt = runProtectedBootstrapPreflight({
      grant: malicious,
      expectedTransactionId: f.grant.transactionId,
      expectedAttempt: 1,
      desktop: { pid: 77, kernelStart: "kernel-start-77" },
    }, dependencies(consumed));

    assert.equal(receipt.verdict, "FAIL");
    assert.match(receipt.reason ?? "", /post-main field installedCanary/);
    assert.equal(consumed.length, 0);
    assert.equal(isAppliedPendingLaunchGrantV1(malicious), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("pre-main bootstrap does not silently select an official backend on a mismatch", () => {
  const f = fixture();
  try {
    const receipt = runProtectedBootstrapPreflight({
      grant: f.grant,
      expectedTransactionId: f.grant.transactionId,
      expectedAttempt: 1,
      desktop: { pid: 77, kernelStart: "kernel-start-77" },
    }, {
      ...dependencies(),
      sha256File: () => "0".repeat(64),
    });
    assert.equal(receipt.verdict, "FAIL");
    assert.equal(isProtectedBootstrapPreflightReceipt(receipt), true);
    assert.match(receipt.reason ?? "", /managed-backend-digest-mismatch/);
    assert.throws(
      () => applyProtectedBootstrapEnvironment(receipt, { CODEX_CLI_PATH: "/official/bundled/codex" }),
      /must not load/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("preflight receipt digest binds pre-main facts and rejects post-emission tampering", () => {
  const f = fixture();
  try {
    const receipt = runProtectedBootstrapPreflight({
      grant: f.grant,
      expectedTransactionId: f.grant.transactionId,
      expectedAttempt: 1,
      desktop: { pid: 77, kernelStart: "kernel-start-77" },
    }, dependencies());
    assert.equal(isProtectedBootstrapPreflightReceipt({
      ...receipt,
      backend: { ...receipt.backend!, sha256: "0".repeat(64) },
    }), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("production preflight probes the exact backend version and architecture without injected test evidence", () => {
  const f = fixture();
  try {
    const executablePath = process.execPath;
    const grant = {
      ...f.grant,
      identity: {
        ...f.grant.identity,
        backendPath: executablePath,
        backendVersion: process.version,
      },
    };
    const receipt = runProtectedBootstrapPreflight({
      grant,
      expectedTransactionId: f.grant.transactionId,
      expectedAttempt: f.grant.attempt,
      desktop: { pid: 42, kernelStart: "kernel-start" },
      now: "2026-08-12T18:00:01.000Z",
    }, {
      sha256File: (path: string) => path === executablePath ? f.grant.identity.backendSha256
        : path.endsWith("app.asar") ? "d".repeat(64) : "5".repeat(64),
      fingerprintAppContents: () => "c".repeat(64),
      readAsarHeader: () => "e".repeat(64),
      readAsarEntry: (_path: string, entry: string) => Buffer.from(entry === "protected-loader.cjs" ? "loader" : "metadata"),
      readSignature: () => "signature",
    });
    assert.equal(receipt.verdict, "PASS");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy pristine is the only degraded recovery mapping and cannot be normal protected", () => {
  const f = fixture();
  try {
    assert.throws(() => createAppliedPendingLaunchGrant({
      ...f.grant,
      environment: {
        schemaVersion: 2,
        uiFeatures: "off",
        mcpSafetyProvider: "official-bundled-degraded",
        recoveryState: "normal-protected",
      },
    }), /allowed provider\/recovery pairing/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

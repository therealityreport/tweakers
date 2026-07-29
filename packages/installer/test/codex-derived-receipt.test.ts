import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexDerivedLabel,
  createCodexResolutionCycle,
  isCodexDerivedReceipt,
  linkCodexReceiptSupersession,
  observeCodexReleaseAfterFreeze,
  readCodexDerivedReceipt,
  recordCodexResolutionCheckpoint,
  resolutionEvidenceFromCycle,
  transitionCodexDerivedReceipt,
  writeCodexDerivedReceipt,
  type CodexDerivedReceipt,
  type CodexResolutionCheckpoint,
} from "../src/codex-derived-receipt.ts";

const t1 = "2026-07-19T12:00:00.000Z";
const t2 = "2026-07-19T12:01:00.000Z";
const t3 = "2026-07-19T12:02:00.000Z";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

test("derived labels always disclose the selected channel", () => {
  assert.equal(codexDerivedLabel("bundled", "0.145.0-alpha.18"), "0.145.0-alpha.18 · desktop-bundled-derived");
  assert.equal(codexDerivedLabel("stable", "0.144.6"), "0.144.6 · stable-derived");
  assert.equal(codexDerivedLabel("edge", "0.145.0-alpha.18"), "0.145.0-alpha.18 · edge-derived");
});

test("R1, R2, and in-window R3 freeze an unchanged tag and peeled commit", () => {
  const r1 = checkpoint("R1", "0.144.6", commitA, t1);
  const r2 = checkpoint("R2", "0.144.6", commitA, t2);
  const r3 = checkpoint("R3", "0.144.6", commitA, t3);
  const active = recordCodexResolutionCheckpoint(createCodexResolutionCycle(r1), r2);
  const frozen = recordCodexResolutionCheckpoint(active, r3, {
    restartWindow: { opensAt: t2, closesAt: "2026-07-19T12:10:00.000Z" },
    now: t3,
  });
  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.frozenAt, t3);
  assert.equal(frozen.checkpoints.length, 3);
  const evidence = resolutionEvidenceFromCycle(frozen, "2022-11-28");
  assert.equal(evidence.peeledCommit, commitA);
  assert.equal(evidence.checkpoints.map((item) => item.name).join(","), "R1,R2,R3");
});

test("tag drift, version regression, and R3 outside the restart window fail closed", () => {
  const initial = createCodexResolutionCycle(checkpoint("R1", "0.144.6", commitA, t1));
  assert.throws(() => recordCodexResolutionCheckpoint(
    initial,
    checkpoint("R2", "0.144.6", commitB, t2),
  ), /tag drift/);
  assert.throws(() => recordCodexResolutionCheckpoint(
    initial,
    checkpoint("R2", "0.144.5", commitA, t2),
  ), /moved backward/);
  const atR2 = recordCodexResolutionCheckpoint(initial, checkpoint("R2", "0.144.6", commitA, t2));
  assert.throws(() => recordCodexResolutionCheckpoint(
    atR2,
    checkpoint("R3", "0.144.6", commitA, t3),
    { restartWindow: { opensAt: t1, closesAt: t2 }, now: t3 },
  ), /outside the approved restart window/);
});

test("a newer release supersedes before freeze but becomes next-cycle advisory after freeze", () => {
  const initial = createCodexResolutionCycle(checkpoint("R1", "0.144.6", commitA, t1));
  const superseded = recordCodexResolutionCheckpoint(
    initial,
    checkpoint("R2", "0.144.7", commitB, t2),
  );
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededBy?.normalizedVersion, "0.144.7");

  const atR2 = recordCodexResolutionCheckpoint(initial, checkpoint("R2", "0.144.6", commitA, t2));
  const frozen = recordCodexResolutionCheckpoint(atR2, checkpoint("R3", "0.144.6", commitA, t3), {
    restartWindow: { opensAt: t2, closesAt: "2026-07-19T12:10:00.000Z" },
    now: t3,
  });
  const deferred = observeCodexReleaseAfterFreeze(
    frozen,
    checkpoint("R1", "0.144.7", commitB, "2026-07-19T12:03:00.000Z"),
  );
  assert.equal(deferred.status, "frozen");
  assert.equal(deferred.newerAvailable?.normalizedVersion, "0.144.7");
  assert.equal(deferred.supersededBy, null);
});

test("receipt validation, atomic persistence, and v1-compatible reading", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-derived-receipt-"));
  try {
    const receipt = validReceipt();
    const file = join(root, "nested", "receipt.json");
    assert.equal(isCodexDerivedReceipt(receipt), true);
    writeCodexDerivedReceipt(file, receipt);
    assert.deepEqual(readCodexDerivedReceipt(file), receipt);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);

    const v1 = {
      schemaVersion: 1,
      kind: "codex-derived",
      transactionId: "legacy-one",
      phase: "completed",
      version: "0.144.5",
      tag: "rust-v0.144.5",
      commit: commitA,
      createdAt: t1,
      updatedAt: t2,
    } as const;
    const legacyFile = join(root, "legacy.json");
    writeFileSync(legacyFile, `${JSON.stringify(v1)}\n`);
    assert.deepEqual(readCodexDerivedReceipt(legacyFile), v1);

    assert.throws(() => writeCodexDerivedReceipt(file, {
      ...receipt,
      label: "quiet-alpha",
    }), /invalid Codex derived receipt/);
    assert.equal(isCodexDerivedReceipt({ ...receipt, phase: "canary-passed", canary: null }), false);
    assert.equal(isCodexDerivedReceipt({
      ...receipt,
      source: { ...receipt.source, treeDigest: { ...receipt.source.treeDigest, value: null } },
    }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt transitions enforce legal promotion, watcher merge, 24-hour soak, and completed-only current publication", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-derived-transitions-"));
  try {
    const receiptFile = join(root, "codex-source", "receipts", "tx-old.json");
    writeCodexDerivedReceipt(receiptFile, {
      ...validReceipt(),
      phase: "canary-passed",
      canary: canaryReference(),
    });
    const promoting = transitionCodexDerivedReceipt({ receiptFile, to: "promoting", now: "2026-07-19T12:03:00.000Z" });
    assert.equal(promoting.phase, "promoting");
    const promoted = transitionCodexDerivedReceipt({
      receiptFile,
      to: "promoted",
      now: "2026-07-19T12:04:00.000Z",
      watcher: { expectedFingerprintUpdatedAt: "2026-07-19T12:04:00.000Z" },
    });
    assert.equal(promoted.watcher.expectedFingerprintUpdatedAt, "2026-07-19T12:04:00.000Z");
    transitionCodexDerivedReceipt({ receiptFile, to: "soaking", now: "2026-07-19T12:05:00.000Z" });
    assert.throws(() => transitionCodexDerivedReceipt({
      receiptFile,
      to: "completed",
      now: "2026-07-20T12:03:59.000Z",
    }), /full 24-hour soak/);
    assert.equal(readCodexDerivedReceipt(join(root, "codex-source", "current-stable.json")), null);
    const completed = transitionCodexDerivedReceipt({
      receiptFile,
      to: "completed",
      now: "2026-07-20T12:04:00.000Z",
    });
    assert.equal(completed.phase, "completed");
    assert.deepEqual(readCodexDerivedReceipt(join(root, "codex-source", "current-stable.json")), completed);
    assert.throws(() => transitionCodexDerivedReceipt({ receiptFile, to: "promoting" }), /Illegal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt rollback and failure transitions fail closed and record terminal timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-derived-rollback-"));
  try {
    const receiptFile = join(root, "codex-source", "receipts", "tx-old.json");
    writeCodexDerivedReceipt(receiptFile, {
      ...validReceipt(),
      phase: "canary-passed",
      canary: canaryReference(),
    });
    assert.throws(() => transitionCodexDerivedReceipt({ receiptFile, to: "failed" }), /requires an error/);
    const failed = transitionCodexDerivedReceipt({ receiptFile, to: "failed", error: "promotion proof failed", now: t3 });
    assert.equal(failed.error, "promotion proof failed");
    transitionCodexDerivedReceipt({ receiptFile, to: "rolling-back", now: "2026-07-19T12:03:00.000Z" });
    const rolledBack = transitionCodexDerivedReceipt({
      receiptFile,
      to: "rolled-back",
      now: "2026-07-19T12:04:00.000Z",
    });
    assert.equal(rolledBack.rolledBackAt, "2026-07-19T12:04:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt supersession creates reciprocal pointers only for a higher version in-channel", () => {
  const oldReceipt = validReceipt();
  const newReceipt = {
    ...validReceipt(),
    transactionId: "tx-new",
    version: "0.144.7",
    label: "0.144.7 · stable-derived",
    source: {
      ...validReceipt().source,
      checkoutCommit: commitB,
    },
    candidateBinary: {
      ...validReceipt().candidateBinary,
      version: "0.144.7",
    },
    resolution: {
      ...validReceipt().resolution,
      resolvedTag: "rust-v0.144.7",
      normalizedVersion: "0.144.7",
      peeledCommit: commitB,
      checkpoints: validReceipt().resolution.checkpoints.map((item) => ({
        ...item,
        resolvedTag: "rust-v0.144.7",
        normalizedVersion: "0.144.7",
        peeledCommit: commitB,
      })),
    },
  } satisfies CodexDerivedReceipt;
  const linked = linkCodexReceiptSupersession(oldReceipt, newReceipt, t3);
  assert.equal(linked.older.phase, "superseded");
  assert.equal(linked.older.supersededBy, "tx-new");
  assert.equal(linked.newer.supersedes, oldReceipt.transactionId);
  assert.throws(() => linkCodexReceiptSupersession(newReceipt, oldReceipt, t3), /higher semantic-version/);
});

function checkpoint(
  name: CodexResolutionCheckpoint["name"],
  version: string,
  commit: string,
  checkedAt: string,
): CodexResolutionCheckpoint {
  return {
    name,
    channel: "stable",
    endpoint: "https://api.github.com/repos/openai/codex/releases/latest",
    resolvedTag: `rust-v${version}`,
    normalizedVersion: version,
    peeledCommit: commit,
    checkedAt,
    etag: `etag-${name}`,
    responseBodySha256: "1".repeat(64),
    tagObjectShas: [],
  };
}

function validReceipt(): CodexDerivedReceipt {
  const r1 = checkpoint("R1", "0.144.6", commitA, t1);
  const r2 = checkpoint("R2", "0.144.6", commitA, t2);
  const r3 = checkpoint("R3", "0.144.6", commitA, t3);
  const digest = (scope: string) => ({ algorithm: "sha256" as const, value: "d".repeat(64), scope });
  const artifact = {
    source: "official GitHub tag commit",
    platform: "darwin",
    architecture: "arm64",
    version: "0.144.6",
    digests: [digest("binary")],
    signature: null,
  };
  return {
    schemaVersion: 2,
    kind: "codex-derived",
    transactionId: "tx-old",
    phase: "prepared",
    channel: "stable",
    version: "0.144.6",
    label: "0.144.6 · stable-derived",
    resolution: {
      endpoint: r1.endpoint,
      requestedApiVersion: "2022-11-28",
      resolvedTag: r1.resolvedTag,
      normalizedVersion: r1.normalizedVersion,
      peeledCommit: r1.peeledCommit,
      checkedAt: r1.checkedAt,
      etag: r1.etag,
      responseBodySha256: r1.responseBodySha256 ?? null,
      tagObjectShas: [],
      checkpoints: [r1, r2, r3],
      restartWindow: { opensAt: t2, closesAt: "2026-07-19T12:10:00.000Z" },
      frozenAt: t3,
    },
    source: {
      repository: "openai/codex",
      checkoutCommit: commitA,
      archiveDigest: null,
      treeDigest: digest("source tree"),
      patchSeriesDigest: digest("patch series"),
      toolchainDigests: [digest("toolchain")],
      lockfileDigests: [digest("Cargo.lock")],
    },
    dependencies: [{
      name: "chrome-devtools-mcp",
      version: "resolved-at-release-prep",
      integrity: "sha512-example",
      entrypoint: "build/src/bin.js",
      contentDigests: [digest("dependency")],
    }],
    frontendControl: {
      ...artifact,
      source: "currently installed desktop frontend at test time",
      version: "test-time-version",
      bundleId: "com.openai.codex",
      build: "test-time-build",
      embeddedBackendVersion: "test-time-backend",
      embeddedBackendDigests: [digest("embedded backend")],
    },
    controlBinary: artifact,
    candidateBinary: { ...artifact, source: "stable-derived candidate" },
    watcher: {
      previousFingerprints: { app: "old" },
      promotedFingerprints: { app: "new" },
      pauseTokenDigest: digest("watcher pause token"),
      expectedFingerprintUpdatedAt: null,
      rearmedAt: null,
      wasEnabled: true,
    },
    supersedes: null,
    supersededBy: null,
    error: null,
    createdAt: t1,
    updatedAt: t3,
    promotedAt: null,
    soakCompletedAt: null,
    rolledBackAt: null,
  };
}

function canaryReference() {
  return {
    schemaVersion: 1 as const,
    kind: "codex-source-canary-reference" as const,
    sidecarPath: "/Users/test/codex-source/canary-evidence.json",
    sidecarSha256: "c".repeat(64),
    candidatePath: "/Users/test/codex-source/codex",
    candidateSha256: "d".repeat(64),
    startedAt: t2,
    completedAt: t3,
  };
}

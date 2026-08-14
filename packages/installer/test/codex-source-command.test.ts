import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_SOURCE_CARGO_JOBS,
  assertInternalStoragePath,
  bundledDerivedCandidateAppPathForReceipt,
  codexSource,
  codexSourceCargoEnvironment,
  codexSourceTransactionPaths,
  createGitHubJsonFetcher,
  createProductionCodexSourceBuildAdapter,
  freezeCodexSourceCandidate,
  prepareCodexSourceCandidate,
  readValidatedBundledDerivedArtifact,
  selectLastKnownGoodCodexSourceFallback,
  selectLastKnownGoodBundledFallback,
  type CodexSourceBuildEvidence,
} from "../src/commands/codex-source.ts";
import type { CodexDerivedReceipt, CodexResolutionCheckpoint } from "../src/codex-derived-receipt.ts";

const published = "2026-07-19T12:00:00.000Z";
const commit = "a".repeat(40);
const digest = (scope: string) => ({ algorithm: "sha256" as const, value: "d".repeat(64), scope });

test("source-derived Cargo work is thermally bounded while preserving its environment", () => {
  const env = codexSourceCargoEnvironment({
    PATH: "/example/bin",
    CARGO_BUILD_JOBS: "10",
  });

  assert.equal(env.PATH, "/example/bin");
  assert.equal(CODEX_SOURCE_CARGO_JOBS, "2");
  assert.equal(env.CARGO_BUILD_JOBS, "2");
});

test("CLI source resolution defaults to the exact installed desktop-bundled backend", async () => {
  const output: string[] = [];
  const result = await codexSource("resolve", { json: true }, {
    root: () => "/tmp/tweakers-codex-source-test",
    probeBundledVersion: () => "0.145.0-alpha.18",
    fetchJson: async (request) => {
      assert.equal(request.url.endsWith("/releases/tags/rust-v0.145.0-alpha.18"), true);
      return { status: 200, data: release("rust-v0.145.0-alpha.18", true) };
    },
    resolveTag: async (tag) => ({ tag, refSha: commit, tagObjectShas: [], peeledCommit: commit }),
    fetchNpmVersions: async () => ["0.145.0-alpha.18", "0.145.0-alpha.24"],
    now: () => published,
    print: (value) => output.push(value),
  });
  assert.equal(result?.kind, "codex-source-resolution");
  if (!result || result.kind !== "codex-source-resolution") return;
  assert.equal(result.channel, "bundled");
  assert.equal(result.checkpoint.resolvedTag, "rust-v0.145.0-alpha.18");
  assert.equal(result.npm.status, "corroborated");
  assert.equal(JSON.parse(output[0]!).channel, "bundled");
});

test("GitHub transport records exact body digest, ETag, and allowlisted next-page Link", async () => {
  const body = JSON.stringify([release("rust-v0.145.0-alpha.18", true)]);
  const fetcher = createGitHubJsonFetcher((async () => new Response(body, {
    status: 200,
    headers: {
      ETag: "edge-etag",
      Link: '<https://api.github.com/repos/openai/codex/releases?per_page=100&page=2>; rel="next"',
    },
  })) as typeof fetch);
  const response = await fetcher({ url: "https://api.github.com/repos/openai/codex/releases?per_page=100", headers: {} });
  assert.equal(response.etag, "edge-etag");
  assert.equal(response.bodySha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(response.nextUrl, "https://api.github.com/repos/openai/codex/releases?per_page=100&page=2");
});

test("R1/R2 prepare and in-window R3 freeze keep the bundled tag commit exact", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-source-orchestration-"));
  try {
    const times = [
      "2026-07-19T12:00:00.000Z",
      "2026-07-19T12:01:00.000Z",
      "2026-07-19T12:01:30.000Z",
      "2026-07-19T12:02:00.000Z",
      "2026-07-19T12:02:30.000Z",
    ];
    let time = 0;
    const common = {
      fetchJson: async () => ({ status: 200, data: release("rust-v0.145.0-alpha.18", true) }),
      resolveTag: async (tag: string) => ({ tag, refSha: commit, tagObjectShas: [], peeledCommit: commit }),
      fetchNpmVersions: async () => ["0.145.0-alpha.18", "0.145.0-alpha.24"],
      now: () => times[Math.min(time++, times.length - 1)]!,
    };
    const prepared = await prepareCodexSourceCandidate({
      bundledVersion: "0.145.0-alpha.18",
      sourceRoot: join(root, "source"),
      transactionId: "tx-bundled",
    }, {
      ...common,
      checkoutSource: ({ peeledCommit }) => peeledCommit,
      verifySourceCommit: () => commit,
      buildSource: async () => buildEvidence(),
    });
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const frozen = await freezeCodexSourceCandidate({
      candidate: prepared.candidate,
      restartWindow: {
        opensAt: "2026-07-19T12:00:00.000Z",
        closesAt: "2026-07-19T12:10:00.000Z",
      },
      watcher: {
        previousFingerprints: {},
        promotedFingerprints: {},
        pauseTokenDigest: null,
        expectedFingerprintUpdatedAt: null,
        rearmedAt: null,
        wasEnabled: true,
      },
      receiptFile: join(root, "codex-source", "receipts", "tx-bundled.json"),
    }, common);
    assert.equal(frozen.status, "frozen");
    if (frozen.status !== "frozen") return;
    assert.equal(frozen.receipt.label, "0.145.0-alpha.18 · desktop-bundled-derived");
    assert.deepEqual(frozen.receipt.resolution.checkpoints.map((item) => item.name), ["R1", "R2", "R3"]);
    assert.equal(frozen.receipt.source.checkoutCommit, commit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fallback ignores standalone stable and edge receipts and requires desktop version match", () => {
  const bundled = receipt("bundled", "0.145.0-alpha.18", "completed");
  const stable = receipt("stable", "0.144.6", "completed");
  const edge = receipt("edge", "0.145.0-alpha.24", "completed");
  assert.equal(selectLastKnownGoodBundledFallback([stable, edge, bundled], "0.145.0-alpha.18")?.transactionId, "tx-bundled");
  assert.equal(selectLastKnownGoodBundledFallback([stable, edge, bundled], "0.145.0-alpha.24"), null);
});

test("edge fallback rejects completed alpha and bundled receipts and selects completed stable", () => {
  const stable = receipt("stable", "0.144.6", "completed");
  const stableAlpha = receipt("stable", "0.145.0-alpha.18", "completed");
  const edgeAlpha = receipt("edge", "0.145.0-alpha.24", "completed");
  const bundledAlpha = receipt("bundled", "0.145.0-alpha.18", "completed");

  assert.equal(
    selectLastKnownGoodCodexSourceFallback(
      [stableAlpha, edgeAlpha, bundledAlpha, stable],
      "edge",
      "0.145.0-alpha.18",
    )?.transactionId,
    "tx-stable",
  );
  assert.equal(
    selectLastKnownGoodCodexSourceFallback([stableAlpha, edgeAlpha, bundledAlpha], "edge"),
    null,
  );
});

test("bundled-derived consumption resolves the exact candidate app the build writes", () => {
  const root = "/Users/example/Library/Application Support/Tweakers";
  const receiptFile = join(root, "codex-source", "receipts", "tx-bundled.json");
  const resolved = bundledDerivedCandidateAppPathForReceipt(receiptFile, "tx-bundled");
  assert.equal(resolved, codexSourceTransactionPaths(root, "tx-bundled").candidateApp);
  assert.equal(resolved, join(root, "codex-source", "transactions", "tx-bundled", "candidate", "ChatGPT.app"));
});

test("a prepared build receipt cannot be consumed before its isolated canary passes", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-source-canary-gate-"));
  try {
    const receiptFile = join(root, "receipt.json");
    writeFileSync(receiptFile, `${JSON.stringify(receipt("bundled", "0.145.0-alpha.18", "prepared"))}\n`);
    assert.throws(
      () => readValidatedBundledDerivedArtifact(receiptFile),
      /isolated canary must pass first/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a frozen source receipt cannot be consumed after its restart window expires", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-source-expired-window-"));
  try {
    const receiptFile = join(root, "codex-source", "receipts", "tx-bundled.json");
    mkdirSync(join(root, "codex-source", "receipts"), { recursive: true });
    writeFileSync(receiptFile, `${JSON.stringify(receipt("bundled", "0.145.0-alpha.18", "canary-passed"))}\n`, {
      flag: "wx",
    });
    assert.throws(
      () => readValidatedBundledDerivedArtifact(receiptFile, "2026-07-19T14:00:00.000Z"),
      /outside its frozen restart window/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all source/build/receipt paths reject external volumes", () => {
  assert.throws(() => assertInternalStoragePath("/Volumes/HardDrive/codex", "Codex source"), /internal storage/);
  assert.doesNotThrow(() => assertInternalStoragePath("/Users/example/Library/Application Support/Tweakers/codex-source"));
  const internalPatch = fileURLToPath(import.meta.url);
  assert.throws(() => createProductionCodexSourceBuildAdapter({
    transactionRoot: "/Users/example/Library/Application Support/Tweakers",
    transactionId: "external-patch",
    frontendSourceApp: "/Applications/ChatGPT.app",
    finalUserRoot: "/Users/example/Library/Application Support/Tweakers",
    patchSeries: ["/Volumes/HardDrive/on-demand.patch"],
    dependencies: [],
  }), /internal storage/);
  assert.throws(() => createProductionCodexSourceBuildAdapter({
    transactionRoot: "/Users/example/Library/Application Support/Tweakers",
    transactionId: "external-frontend",
    frontendSourceApp: "/Volumes/HardDrive/ChatGPT.app",
    finalUserRoot: "/Users/example/Library/Application Support/Tweakers",
    patchSeries: [internalPatch],
    dependencies: [],
  }), /internal storage/);
});

function release(tag: string, prerelease: boolean) {
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: published,
    html_url: `https://github.com/openai/codex/releases/tag/${tag}`,
  };
}

function buildEvidence(): CodexSourceBuildEvidence {
  const artifact = {
    source: "official GitHub tag commit",
    platform: "darwin",
    architecture: "arm64",
    version: "0.145.0-alpha.18",
    digests: [digest("derived candidate binary")],
    signature: null,
  };
  return {
    source: {
      repository: "openai/codex",
      checkoutCommit: commit,
      archiveDigest: null,
      treeDigest: digest("patched source tree"),
      patchSeriesDigest: digest("patch series"),
      toolchainDigests: [digest("rustc")],
      lockfileDigests: [digest("Cargo.lock")],
    },
    dependencies: [],
    frontendControl: {
      ...artifact,
      source: "currently installed desktop frontend at test time",
      version: "26.715.31925",
      bundleId: "com.openai.codex",
      build: "26.715.31925",
      embeddedBackendVersion: "0.145.0-alpha.18",
      embeddedBackendDigests: [digest("desktop bundled backend")],
    },
    controlBinary: { ...artifact, source: "currently installed desktop frontend bundled backend" },
    candidateBinary: artifact,
  };
}

function receipt(
  channel: CodexDerivedReceipt["channel"],
  version: string,
  phase: CodexDerivedReceipt["phase"],
): CodexDerivedReceipt {
  const base = buildEvidence();
  const checkpoint: CodexResolutionCheckpoint = {
    name: "R1",
    channel,
    endpoint: "https://api.github.com/repos/openai/codex/releases/tags/example",
    resolvedTag: `rust-v${version}`,
    normalizedVersion: version,
    peeledCommit: commit,
    checkedAt: published,
    etag: null,
    responseBodySha256: null,
    tagObjectShas: [],
  };
  const checkpoints = (["R1", "R2", "R3"] as const).map((name) => ({ ...checkpoint, name }));
  return {
    schemaVersion: 2,
    kind: "codex-derived",
    transactionId: `tx-${channel}`,
    phase,
    channel,
    version,
    label: channel === "bundled" ? `${version} · desktop-bundled-derived` : `${version} · ${channel}-derived`,
    resolution: {
      endpoint: checkpoint.endpoint,
      requestedApiVersion: "2022-11-28",
      resolvedTag: checkpoint.resolvedTag,
      normalizedVersion: version,
      peeledCommit: commit,
      checkedAt: published,
      etag: null,
      responseBodySha256: null,
      tagObjectShas: [],
      checkpoints,
      restartWindow: { opensAt: published, closesAt: "2026-07-19T13:00:00.000Z" },
      frozenAt: published,
    },
    source: { ...base.source, checkoutCommit: commit },
    dependencies: [],
    frontendControl: base.frontendControl,
    controlBinary: base.controlBinary,
    candidateBinary: { ...base.candidateBinary, version },
    canary: ["canary-passed", "promoting", "promoted", "soaking", "completed"].includes(phase) ? {
      schemaVersion: 1,
      kind: "codex-source-canary-reference",
      sidecarPath: "/Users/test/codex-source/canary-evidence.json",
      sidecarSha256: "c".repeat(64),
      candidatePath: "/Users/test/codex-source/codex",
      candidateSha256: "d".repeat(64),
      startedAt: published,
      completedAt: published,
    } : null,
    watcher: {
      previousFingerprints: {}, promotedFingerprints: {}, pauseTokenDigest: null,
      expectedFingerprintUpdatedAt: null, rearmedAt: null, wasEnabled: true,
    },
    supersedes: null,
    supersededBy: null,
    error: null,
    createdAt: published,
    updatedAt: published,
    promotedAt: phase === "completed" ? published : null,
    soakCompletedAt: phase === "completed" ? published : null,
    rolledBackAt: null,
  };
}

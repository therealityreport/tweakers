import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptCodexBuild,
  reviewCodexBuild,
  type CodexBuildAttestationDependencies,
} from "../src/commands/codex-build-attestation.ts";
import {
  CODEX_SOURCE_BUILD_COMMAND,
  CODEX_SOURCE_RUST_TEST_COMMAND,
  codexSourceTransactionPaths,
} from "../src/commands/codex-source.ts";
import {
  codexDerivedLabel,
  writeCodexDerivedReceipt,
  type CodexDerivedReceipt,
} from "../src/codex-derived-receipt.ts";
import {
  validatePrebuiltCombinedCandidate,
  type PrebuiltCombinedCandidateValidationDependencies,
} from "../src/prebuilt-combined-candidate.ts";

const NOW = "2026-09-02T20:00:00.000Z";
const VERSION = "0.152.1";
const TRANSACTION = "accepted-build-fixture";
const RUSTC = "rustc 1.89.0 (fixture)\nbinary: rustc\ncommit-hash: fixture\n";
const CARGO = "cargo 1.89.0 (fixture)\n";
const REQUIRED_TESTS = [
  "connection_manager::tests::deferred_shutdown_does_not_ignite_never_started_servers",
  "connection_manager::tests::cancelled_startup_never_reaches_the_transport",
  "connection_manager::tests::shutdown_continues_after_caller_is_aborted",
  "connection_manager::tests::capture_binding_exposes_cached_tools_before_startup",
  "connection_manager::tests::cancelling_startup_does_not_disable_a_ready_client",
  "connection_manager::tests::shutdown_cancels_pending_tool_listing",
];

interface Fixture {
  root: string;
  receiptPath: string;
  sourceRoot: string;
  binaryPath: string;
  rustStdout: string;
  reviewManifest: string;
  acceptedRoot: string;
  deps: Partial<CodexBuildAttestationDependencies>;
  receipt: CodexDerivedReceipt;
  cleanup(): void;
}

test("review and explicit hash-bound owner acceptance issue a strict accepted backend pair", () => {
  const fixture = createFixture();
  try {
    const reviewed = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    assert.equal(reviewed.liveMutation, false);
    assert.match(reviewed.reviewManifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(reviewed.reviewManifestPath, fixture.reviewManifest);

    const accepted = acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, fixture.deps);
    assert.equal(accepted.liveMutation, false);
    assert.equal(accepted.acceptedBinarySha256, sha256(fixture.binaryPath));
    assert.match(accepted.acceptedReceiptSha256, /^[a-f0-9]{64}$/);
    assert.match(accepted.acceptanceRecordSha256, /^[a-f0-9]{64}$/);
    const receipt = JSON.parse(readFileSync(accepted.acceptedReceiptPath, "utf8")) as {
      kind: string;
      source: { commit: string; tree: string; cargoLockSha256: string; reviewedDiffSha256: string };
      build: { command: string; toolchain: string; architecture: string };
      tests: Array<{ status: string; receiptSha256: string }>;
      binary: { path: string; sha256: string; version: string; architecture: string };
    };
    assert.equal(receipt.kind, "tweakers-prebuilt-codex-build");
    assert.equal(receipt.source.commit, fixture.receipt.source.checkoutCommit);
    assert.equal(receipt.source.tree, fixture.receipt.source.treeDigest.value);
    assert.equal(receipt.source.cargoLockSha256, fixture.receipt.rustLifecycleTests?.cargoLockSha256);
    assert.equal(receipt.source.reviewedDiffSha256, fixture.receipt.source.reviewedDiffDigest?.value);
    assert.equal(receipt.build.command, CODEX_SOURCE_BUILD_COMMAND.join(" "));
    assert.match(receipt.build.toolchain, /rustc 1\.89\.0[\s\S]*cargo 1\.89\.0/);
    assert.equal(receipt.build.architecture, "arm64");
    assert.equal(receipt.tests.length, 2);
    assert.equal(receipt.tests.every((entry) => entry.status === "passed"), true);
    assert.equal(receipt.binary.path, accepted.acceptedBinaryPath);
    assert.equal(receipt.binary.sha256, sha256(fixture.binaryPath));
    assert.equal(receipt.binary.version, VERSION);
    assert.equal(receipt.binary.architecture, "arm64");

    const replay = acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, fixture.deps);
    assert.deepEqual(replay, accepted, "an exact acceptance replay is idempotent");
  } finally {
    fixture.cleanup();
  }
});

const receiptMutationCases: Array<{
  name: string;
  expected: RegExp;
  mutate(fixture: Fixture, value: Record<string, any>): Partial<CodexBuildAttestationDependencies> | void;
}> = [
  {
    name: "wrong source commit",
    expected: /checkout commit|tag does not peel/,
    mutate: (_fixture, value) => {
      const wrong = "f".repeat(40);
      value.source.checkoutCommit = wrong;
      value.resolution.peeledCommit = wrong;
      for (const checkpoint of value.resolution.checkpoints) checkpoint.peeledCommit = wrong;
      value.rustLifecycleTests.sourceCommit = wrong;
    },
  },
  {
    name: "wrong source-tree hash",
    expected: /source-tree hash/,
    mutate: (_fixture, value) => {
      value.source.treeDigest.value = "1".repeat(64);
      value.rustLifecycleTests.patchedTreeSha256 = "1".repeat(64);
    },
  },
  {
    name: "wrong reviewed-diff hash",
    expected: /applied-diff hash/,
    mutate: (_fixture, value) => { value.source.reviewedDiffDigest.value = "2".repeat(64); },
  },
  {
    name: "wrong Cargo.lock hash",
    expected: /Cargo\.lock hash/,
    mutate: (_fixture, value) => {
      value.source.lockfileDigests[0].value = "3".repeat(64);
      value.rustLifecycleTests.cargoLockSha256 = "3".repeat(64);
    },
  },
  {
    name: "wrong toolchain",
    expected: /toolchain differs/,
    mutate: (_fixture, value) => { value.source.toolchainDigests[0].value = "4".repeat(64); },
  },
  {
    name: "wrong build command",
    expected: /locked Codex release build command/,
    mutate: (_fixture, value) => { value.source.buildCommand = ["cargo", "build", "--release"]; },
  },
  {
    name: "wrong architecture",
    expected: /arm64 macOS build/,
    mutate: (_fixture, value) => { value.candidateBinary.architecture = "x86_64"; },
  },
  {
    name: "wrong backend hash",
    expected: /backend hash differs/,
    mutate: (fixture) => { writeFileSync(fixture.binaryPath, "mutated backend\n"); },
  },
  {
    name: "backend version mismatch",
    expected: /backend version differs/,
    mutate: () => ({ probeBinaryVersion: () => "0.152.2" }),
  },
  {
    name: "missing test evidence",
    expected: /Rust lifecycle test evidence/,
    mutate: (_fixture, value) => { delete value.rustLifecycleTests; },
  },
  {
    name: "failed required test evidence",
    expected: /Rust lifecycle test evidence/,
    mutate: (_fixture, value) => { value.rustLifecycleTests.passedTests = REQUIRED_TESTS.slice(1); },
  },
];

for (const scenario of receiptMutationCases) {
  test(`issuer fails closed for ${scenario.name}`, () => {
    const fixture = createFixture();
    try {
      const value = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as Record<string, any>;
      const overrides = scenario.mutate(fixture, value) ?? {};
      if (scenario.name !== "wrong backend hash" && scenario.name !== "backend version mismatch") {
        writeFileSync(fixture.receiptPath, `${JSON.stringify(value, null, 2)}\n`);
      }
      assert.throws(() => reviewCodexBuild({
        transactionId: TRANSACTION,
        derivedReceiptPath: fixture.receiptPath,
      }, { ...fixture.deps, ...overrides }), scenario.expected);
    } finally {
      fixture.cleanup();
    }
  });
}

test("mutated evidence after review cannot be accepted", () => {
  const fixture = createFixture();
  try {
    const reviewed = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    writeFileSync(fixture.rustStdout, "mutated after review\n");
    assert.throws(() => acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, fixture.deps), /test output changed/);
  } finally {
    fixture.cleanup();
  }
});

test("failed managed MCP integration evidence cannot be reviewed", () => {
  const fixture = createFixture();
  try {
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as Record<string, any>;
    const sidecar = JSON.parse(readFileSync(receipt.canary.sidecarPath, "utf8")) as Record<string, any>;
    const observed = JSON.parse(readFileSync(sidecar.sourceFile, "utf8")) as Record<string, any>;
    observed.status = "failed";
    writeFileSync(sidecar.sourceFile, `${JSON.stringify(observed, null, 2)}\n`);
    sidecar.sourceSha256 = sha256(sidecar.sourceFile);
    writeFileSync(receipt.canary.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    receipt.canary.sidecarSha256 = sha256(receipt.canary.sidecarPath);
    writeFileSync(fixture.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.throws(() => reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps), /integration canary does not prove/);
  } finally {
    fixture.cleanup();
  }
});

test("a checkout with a substituted upstream repository cannot be reviewed", () => {
  const fixture = createFixture();
  try {
    git(["remote", "set-url", "origin", "https://github.com/example/codex.git"], fixture.sourceRoot);
    assert.throws(() => reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps), /exact official OpenAI Codex repository URL/);
  } finally {
    fixture.cleanup();
  }
});

test("symlinked derived receipts and backends are rejected", () => {
  for (const target of ["receipt", "backend"] as const) {
    const fixture = createFixture();
    try {
      const selected = target === "receipt" ? fixture.receiptPath : fixture.binaryPath;
      const real = `${selected}.real`;
      renameSync(selected, real);
      symlinkSync(real, selected);
      assert.throws(() => reviewCodexBuild({
        transactionId: TRANSACTION,
        derivedReceiptPath: fixture.receiptPath,
      }, fixture.deps), /regular non-symlink file/);
    } finally {
      fixture.cleanup();
    }
  }
});

test("unsupported storage and acceptance without the exact review hash are rejected", () => {
  assert.throws(() => reviewCodexBuild({
    transactionId: TRANSACTION,
    derivedReceiptPath: `/Volumes/External/codex-source/receipts/${TRANSACTION}.json`,
  }), /internal storage/);

  const fixture = createFixture();
  try {
    const reviewed = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    assert.throws(() => acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: "f".repeat(64),
    }, fixture.deps), /not bound to the exact reviewed manifest/);
  } finally {
    fixture.cleanup();
  }
});

test("new acceptance authority rejects the archived codex-plusplus data root", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "archived-root-")));
  const receipt = join(parent, "codex-plusplus", "codex-source", "receipts", `${TRANSACTION}.json`);
  try {
    mkdirSync(join(parent, "codex-plusplus", "codex-source", "receipts"), { recursive: true });
    writeFileSync(receipt, "{}\n");
    assert.throws(() => reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: receipt,
    }), /archived codex-plusplus data root/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("different existing accepted artifacts cannot be overwritten", () => {
  const fixture = createFixture();
  try {
    const reviewed = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    writeFileSync(join(fixture.acceptedRoot, "accepted-build.json"), "{}\n", { mode: 0o600 });
    assert.throws(() => acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, fixture.deps), /Accepted-build receipt schema is invalid|overwrite/);
  } finally {
    fixture.cleanup();
  }
});

test("atomic review publication failure leaves no authority and recovers on retry", () => {
  const fixture = createFixture();
  let fail = true;
  try {
    assert.throws(() => reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, {
      ...fixture.deps,
      fault: (point) => {
        if (fail && point === "review-manifest:after-temp-fsync") {
          fail = false;
          throw new Error("simulated atomic publication failure");
        }
      },
    }), /simulated atomic publication failure/);
    assert.equal(existsSync(fixture.reviewManifest), false);
    assert.equal(
      existsSync(join(fixture.acceptedRoot, "accepted-build.json")),
      false,
      "a failed review never creates acceptance authority",
    );
    const recovered = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    assert.equal(existsSync(recovered.reviewManifestPath), true);
  } finally {
    fixture.cleanup();
  }
});

test("atomic acceptance publication failure leaves no receipt and recovers without replacing the reviewed binary", () => {
  const fixture = createFixture();
  let fail = true;
  try {
    const reviewed = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    assert.throws(() => acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, {
      ...fixture.deps,
      fault: (point) => {
        if (fail && point === "accepted-receipt:after-temp-fsync") {
          fail = false;
          throw new Error("simulated accepted-receipt publication failure");
        }
      },
    }), /simulated accepted-receipt publication failure/);
    assert.equal(existsSync(join(fixture.acceptedRoot, "codex")), true);
    assert.equal(existsSync(join(fixture.acceptedRoot, "accepted-build.json")), false);
    const recovered = acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, fixture.deps);
    assert.equal(existsSync(recovered.acceptedReceiptPath), true);
  } finally {
    fixture.cleanup();
  }
});

test("the independent strict candidate validator rejects every accepted-receipt leaf mutation", () => {
  const fixture = createFixture();
  try {
    const reviewed = reviewCodexBuild({
      transactionId: TRANSACTION,
      derivedReceiptPath: fixture.receiptPath,
    }, fixture.deps);
    const accepted = acceptCodexBuild({
      reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256,
    }, fixture.deps);
    const runtimeRoot = join(fixture.root, "reviewed-runtime");
    const sourceAppRoot = join(fixture.root, "ChatGPT.app");
    mkdirSync(runtimeRoot);
    mkdirSync(sourceAppRoot);
    writeFileSync(join(runtimeRoot, "runtime-fingerprint.json"), "{}\n");
    const originalBytes = readFileSync(accepted.acceptedReceiptPath);
    const original = JSON.parse(originalBytes.toString("utf8")) as Record<string, any>;
    const input = {
      transactionId: "strict-consumer-fixture",
      binaryPath: accepted.acceptedBinaryPath,
      expectedBinarySha256: accepted.acceptedBinarySha256,
      expectedVersion: VERSION,
      expectedArchitecture: "arm64" as const,
      receiptPath: accepted.acceptedReceiptPath,
      expectedReceiptSha256: accepted.acceptedReceiptSha256,
      expectedRuntimeFingerprint: "7".repeat(64),
      expectedRuntimeFileCount: 10,
      expectedRuntimeDocumentSha256: "8".repeat(64),
      expectedSourceAppFingerprint: "9".repeat(64),
      expectedBundleId: "com.openai.codex" as const,
    };
    const dependencies: Partial<PrebuiltCombinedCandidateValidationDependencies> = {
      fingerprintFile: (path) => {
        if (path === join(runtimeRoot, "runtime-fingerprint.json")) return "8".repeat(64);
        return sha256(path);
      },
      probeVersion: () => VERSION,
      probeArchitecture: () => "arm64",
      sourceAppFingerprint: () => "9".repeat(64),
      sourceAppBundleId: () => "com.openai.codex",
      runtimeEvidence: () => ({ fingerprint: "7".repeat(64), fileCount: 10 }),
    };
    assert.doesNotThrow(() => validatePrebuiltCombinedCandidate(input, {
      installerPayloadHash: "6".repeat(64), runtimeRoot, sourceAppRoot,
      now: new Date("2026-09-03T00:00:00.000Z"),
    }, dependencies));

    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.schemaVersion = 2; },
      (value) => { value.kind = "other"; },
      (value) => { value.status = "rejected"; },
      (value) => { value.acceptedAt = "2026-09-02T20:00:01.000Z"; },
      (value) => { value.source.commit = "e".repeat(40); },
      (value) => { value.source.tree = "e".repeat(64); },
      (value) => { value.source.cargoLockSha256 = "e".repeat(64); },
      (value) => { value.source.reviewedDiffSha256 = "e".repeat(64); },
      (value) => { value.build.command += " --features changed"; },
      (value) => { value.build.toolchain += " changed"; },
      (value) => { value.build.architecture = "x86_64"; },
      (value) => { value.tests[0].name += " changed"; },
      (value) => { value.tests[0].command += " changed"; },
      (value) => { value.tests[0].receiptSha256 = "e".repeat(64); },
      (value) => { value.tests[0].status = "failed"; },
      (value) => { value.binary.path += ".changed"; },
      (value) => { value.binary.sha256 = "e".repeat(64); },
      (value) => { value.binary.version = "0.152.2"; },
      (value) => { value.binary.architecture = "x86_64"; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(original);
      mutate(value);
      writeFileSync(accepted.acceptedReceiptPath, `${JSON.stringify(value, null, 2)}\n`);
      assert.throws(() => validatePrebuiltCombinedCandidate(input, {
        installerPayloadHash: "6".repeat(64), runtimeRoot, sourceAppRoot,
        now: new Date("2026-09-03T00:00:00.000Z"),
      }, dependencies), /receipt digest/);
      writeFileSync(accepted.acceptedReceiptPath, originalBytes);
    }
  } finally {
    fixture.cleanup();
  }
});

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-build-attestation-")));
  const paths = codexSourceTransactionPaths(root, TRANSACTION);
  mkdirSync(join(paths.sourceRoot, "codex-rs"), { recursive: true });
  writeFileSync(join(paths.sourceRoot, "codex-rs", "Cargo.lock"), "version = 4\n");
  writeFileSync(join(paths.sourceRoot, "source.txt"), "upstream\n");
  git(["init", "--quiet"], paths.sourceRoot);
  git(["config", "user.name", "Tweakers Test"], paths.sourceRoot);
  git(["config", "user.email", "test@example.invalid"], paths.sourceRoot);
  git(["remote", "add", "origin", "https://github.com/openai/codex.git"], paths.sourceRoot);
  git(["add", "."], paths.sourceRoot);
  git(["commit", "--quiet", "-m", "fixture upstream"], paths.sourceRoot);
  const commit = git(["rev-parse", "HEAD"], paths.sourceRoot).trim();
  git(["tag", `rust-v${VERSION}`], paths.sourceRoot);
  writeFileSync(join(paths.sourceRoot, "source.txt"), "upstream\nreviewed patch\n");
  git(["add", "source.txt"], paths.sourceRoot);

  const binaryPath = join(paths.candidateApp, "Contents", "Resources", "codex");
  mkdirSync(join(paths.candidateApp, "Contents", "Resources"), { recursive: true });
  writeFileSync(binaryPath, "fixture arm64 backend\n", { mode: 0o700 });
  const binarySha256 = sha256(binaryPath);
  const rustRoot = join(paths.root, "prepared", "rust-lifecycle-tests");
  const rustStdout = join(rustRoot, "cargo-test.stdout.log");
  const rustStderr = join(rustRoot, "cargo-test.stderr.log");
  mkdirSync(rustRoot, { recursive: true });
  writeFileSync(rustStdout, `${REQUIRED_TESTS.map((name) => `test ${name} ... ok`).join("\n")}\n`);
  writeFileSync(rustStderr, "");

  const observedPath = paths.canaryRunnerEvidenceFile;
  mkdirSync(join(paths.root, "canary-home"), { recursive: true });
  writeFileSync(observedPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "managed-mcp-observed-canary",
    status: "passed",
    transactionId: TRANSACTION,
    version: VERSION,
    candidate: { path: binaryPath, sha256: binarySha256 },
    lifecycle: { starts: true, tools: true, cleanup: true },
    startedAt: NOW,
    completedAt: NOW,
  }, null, 2)}\n`);
  mkdirSync(join(paths.root, "candidate"), { recursive: true });
  writeFileSync(paths.canaryEvidenceFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: "codex-source-canary-evidence",
    transactionId: TRANSACTION,
    sourceFile: observedPath,
    sourceSha256: sha256(observedPath),
    version: VERSION,
    candidatePath: binaryPath,
    candidateSha256: binarySha256,
  }, null, 2)}\n`);

  const treeSha256 = digestTrackedSource(paths.sourceRoot);
  const reviewedDiffSha256 = sha256Text(git([
    "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-color", commit, "--",
  ], paths.sourceRoot));
  const cargoLockSha256 = sha256(join(paths.sourceRoot, "codex-rs", "Cargo.lock"));
  const checkpoint = (name: "R1" | "R2" | "R3") => ({
    name,
    channel: "bundled" as const,
    endpoint: `https://api.github.com/repos/openai/codex/releases/tags/rust-v${VERSION}`,
    resolvedTag: `rust-v${VERSION}`,
    normalizedVersion: VERSION,
    peeledCommit: commit,
    checkedAt: NOW,
    etag: null,
    responseBodySha256: null,
    tagObjectShas: [],
  });
  const artifact = (source: string) => ({
    source,
    platform: "darwin",
    architecture: "arm64",
    version: VERSION,
    digests: [{ algorithm: "sha256" as const, value: binarySha256, scope: "derived candidate binary" }],
    signature: null,
  });
  const receipt: CodexDerivedReceipt = {
    schemaVersion: 2,
    kind: "codex-derived",
    transactionId: TRANSACTION,
    phase: "canary-passed",
    channel: "bundled",
    version: VERSION,
    label: codexDerivedLabel("bundled", VERSION),
    resolution: {
      endpoint: checkpoint("R3").endpoint,
      requestedApiVersion: "2022-11-28",
      resolvedTag: `rust-v${VERSION}`,
      normalizedVersion: VERSION,
      peeledCommit: commit,
      checkedAt: NOW,
      etag: null,
      responseBodySha256: null,
      tagObjectShas: [],
      checkpoints: [checkpoint("R1"), checkpoint("R2"), checkpoint("R3")],
      restartWindow: { opensAt: "2026-09-02T19:55:00.000Z", closesAt: "2026-09-02T20:05:00.000Z" },
      frozenAt: NOW,
    },
    source: {
      repository: "openai/codex",
      checkoutCommit: commit,
      archiveDigest: null,
      treeDigest: { algorithm: "sha256", value: treeSha256, scope: "patched source tree" },
      patchSeriesDigest: { algorithm: "sha256", value: sha256Text("reviewed patch series"), scope: "patch series" },
      reviewedDiffDigest: { algorithm: "sha256", value: reviewedDiffSha256, scope: "reviewed applied diff" },
      buildCommand: CODEX_SOURCE_BUILD_COMMAND,
      toolchainDigests: [
        { algorithm: "sha256", value: sha256Text(RUSTC), scope: "rustc -vV" },
        { algorithm: "sha256", value: sha256Text(CARGO), scope: "cargo -V" },
      ],
      lockfileDigests: [{ algorithm: "sha256", value: cargoLockSha256, scope: "Cargo.lock" }],
    },
    dependencies: [],
    frontendControl: {
      ...artifact("currently installed desktop frontend at test time"),
      bundleId: "com.openai.codex",
      build: "7579",
      embeddedBackendVersion: VERSION,
      embeddedBackendDigests: [{ algorithm: "sha256", value: binarySha256, scope: "desktop bundled backend" }],
    },
    controlBinary: artifact("currently installed desktop frontend bundled backend"),
    candidateBinary: artifact("official GitHub tag commit"),
    rustLifecycleTests: {
      schemaVersion: 1,
      kind: "codex-rust-lifecycle-tests",
      sourceCommit: commit,
      patchedTreeSha256: treeSha256,
      cargoLockSha256,
      command: CODEX_SOURCE_RUST_TEST_COMMAND,
      exitCode: 0,
      passedTests: REQUIRED_TESTS,
      stdoutFile: rustStdout,
      stdoutSha256: sha256(rustStdout),
      stderrFile: rustStderr,
      stderrSha256: sha256(rustStderr),
      candidateBinarySha256: binarySha256,
      startedAt: NOW,
      completedAt: NOW,
    },
    canary: {
      schemaVersion: 1,
      kind: "codex-source-canary-reference",
      sidecarPath: paths.canaryEvidenceFile,
      sidecarSha256: sha256(paths.canaryEvidenceFile),
      candidatePath: binaryPath,
      candidateSha256: binarySha256,
      startedAt: NOW,
      completedAt: NOW,
    },
    watcher: {
      previousFingerprints: {},
      promotedFingerprints: {},
      pauseTokenDigest: null,
      expectedFingerprintUpdatedAt: null,
      rearmedAt: null,
      wasEnabled: false,
    },
    supersedes: null,
    supersededBy: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    promotedAt: null,
    soakCompletedAt: null,
    rolledBackAt: null,
  };
  writeCodexDerivedReceipt(paths.receiptFile, receipt);
  const acceptedRoot = join(root, "codex-source", "accepted", TRANSACTION);
  const deps: Partial<CodexBuildAttestationDependencies> = {
    now: () => NOW,
    effectiveUid: () => process.getuid?.() ?? 0,
    username: () => "fixture-owner",
    probeBinaryVersion: () => VERSION,
    probeBinaryArchitecture: () => "arm64",
    probeToolchain: () => ({ rustc: RUSTC, cargo: CARGO }),
  };
  return {
    root,
    receiptPath: paths.receiptFile,
    sourceRoot: paths.sourceRoot,
    binaryPath,
    rustStdout,
    reviewManifest: join(acceptedRoot, "review-manifest.json"),
    acceptedRoot,
    deps,
    receipt,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mutateReceipt(fixture: Fixture, mutate: (value: Record<string, any>) => void): void {
  const value = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as Record<string, any>;
  mutate(value);
  writeFileSync(fixture.receiptPath, `${JSON.stringify(value, null, 2)}\n`);
}

function digestTrackedSource(sourceRoot: string): string {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], sourceRoot)
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(sourceRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

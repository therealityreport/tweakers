import { verifyV8BuildInputs, OBSERVED_RUST_OVERRIDES, UNOBSERVED_ORIGINAL_RUST_KEYS } from "../src/qualified-rust-evidence.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  acceptCodexBuild,
  reviewCodexBuild,
  type CodexBuildAttestationDependencies,
} from "../src/commands/codex-build-attestation.ts";
import {
  CODEX_SOURCE_BUILD_COMMAND,
  CODEX_SOURCE_RUST_TEST_COMMAND,
  CODEX_SOURCE_REQUIRED_RUST_TESTS,
  codexSourceTransactionPaths,
  inspectRustSourceIdentity,
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

import { computeRuntimeFingerprint } from "../src/runtime-fingerprint.ts";

const SIGNATURE = { identity: "fixture-signing", teamIdentifier: null, designatedRequirement: null };
const NOW = "2026-09-02T20:00:00.000Z";
const VERSION = "0.152.1";
const TRANSACTION = "accepted-build-fixture";
const RUSTC = "rustc 1.89.0 (fixture)\nbinary: rustc\ncommit-hash: fixture\n";
const CARGO = "cargo 1.89.0 (fixture)\n";
const REQUIRED_TESTS = [...CODEX_SOURCE_REQUIRED_RUST_TESTS];

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

test("review and acceptance reject helper posture despite matching backend signature evidence", () => {
  const fixture = createFixture();
  try {
    const rejected = { ...fixture.deps, verifyCodeModeHostPosture: () => false };
    assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath }, rejected), /helper signing posture/);
    assert.equal(existsSync(fixture.reviewManifest), false);
    const reviewed = reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath }, fixture.deps);
    assert.throws(() => acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256 }, rejected), /helper signing posture/);
    assert.equal(existsSync(join(fixture.acceptedRoot, "accepted-build.json")), false);
  } finally { fixture.cleanup(); }
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
    name: "missing helper closure",
    expected: /backend\/helper resource closure/,
    mutate: (_fixture, value) => { delete value.backendClosure; },
  },
  {
    name: "changed helper bytes",
    expected: /helper fingerprint/,
    mutate: (_fixture, value) => { writeFileSync(value.backendClosure.codeModeHost.path, "other helper"); },
  },
  {
    name: "missing generated runtime evidence",
    expected: /generated runtime evidence/,
    mutate: (_fixture, value) => { delete value.generatedRuntime; },
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
    }, fixture.deps), /Accepted-build receipt schema|Accepted-build receipt.*invalid|overwrite/);
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
      expectedRuntimeFingerprint: original.runtime.fingerprint,
      expectedRuntimeFileCount: original.runtime.fileCount,
      expectedRuntimeDocumentSha256: original.runtime.documentSha256,
      expectedSourceAppFingerprint: "9".repeat(64),
      expectedBundleId: "com.openai.codex" as const,
    };
    const dependencies: Partial<PrebuiltCombinedCandidateValidationDependencies> = {
      fingerprintFile: (path) => {
        if (path === join(runtimeRoot, "runtime-fingerprint.json")) return original.runtime.documentSha256;
        return sha256(path);
      },
      probeVersion: () => VERSION,
      probeArchitecture: () => "arm64",
      verifyBackendSignature: () => true,
      verifyCodeModeHostPosture: () => true,
      sourceAppFingerprint: () => "9".repeat(64),
      sourceAppBundleId: () => "com.openai.codex",
      runtimeEvidence: () => ({ fingerprint: original.runtime.fingerprint, fileCount: original.runtime.fileCount }),
    };
    assert.doesNotThrow(() => validatePrebuiltCombinedCandidate(input, {
      installerPayloadHash: "6".repeat(64), runtimeRoot, sourceAppRoot,
      now: new Date("2026-09-03T00:00:00.000Z"),
    }, dependencies));

    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => { value.schemaVersion = 1; },
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

test("compiled R1/R2 source acceptance records source proof without claiming managed or installed canary", () => {
  const fixture = createFixture();
  try {
    const candidatePath = prepareCompileOnlyFixture(fixture);
    rmSync(join(fixture.root, "codex-source", "transactions", TRANSACTION, "candidate", "ChatGPT.app"), { recursive: true });
    const reviewed = reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: candidatePath }, fixture.deps);
    const manifest = JSON.parse(readFileSync(reviewed.reviewManifestPath, "utf8"));
    assert.deepEqual(manifest.verification, { level: "source-verified", installedAcceptance: "required" });
    assert.equal(manifest.buildEvidence.kind, "prepared-source");
    assert.equal(manifest.tests.length, 1);
    assert.equal(existsSync(join(fixture.acceptedRoot, "test-evidence", "managed-mcp-canary.json")), false);
    const accepted = acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath,
      acceptedManifestSha256: reviewed.reviewManifestSha256 }, fixture.deps);
    const receipt = JSON.parse(readFileSync(accepted.acceptedReceiptPath, "utf8"));
    assert.deepEqual(receipt.verification, manifest.verification);
    assert.equal(receipt.tests.some((value: {name: string}) => value.name.includes("canary")), false);
  } finally { fixture.cleanup(); }
});

for (const scenario of [
  { name: "missing helper", mutate: (value: Record<string, any>) => { delete value.evidence.backendClosure; }, expected: /closure/ },
  { name: "missing runtime", mutate: (value: Record<string, any>) => { delete value.evidence.generatedRuntime; }, expected: /runtime/ },
  { name: "missing patch inputs", mutate: (value: Record<string, any>) => { delete value.evidence.source.patchSeriesFiles; }, expected: /patch inputs/ },
  { name: "changed patch digest", mutate: (value: Record<string, any>) => { value.evidence.source.patchSeriesDigest.value = "f".repeat(64); }, expected: /patch-series/ },
  { name: "missing credential proofs", mutate: (value: Record<string, any>) => { value.evidence.rustLifecycleTests.passedTests = REQUIRED_TESTS.slice(0,6); }, expected: /lifecycle test/ },
  { name: "historical lifecycle names", mutate: (value: Record<string, any>) => { value.evidence.rustLifecycleTests.passedTests[0] = "connection_manager::tests::deferred_shutdown_does_not_ignite_never_started_servers"; }, expected: /lifecycle test/ },
  { name: "output path outside transaction", mutate: (value: Record<string, any>) => { value.evidence.compiledBackend.binaryPath += ".other"; }, expected: /output paths/ },
  { name: "missing R2", mutate: (value: Record<string, any>) => { value.cycle.checkpoints.pop(); }, expected: /R1\/R2/ },
]) {
  test(`compile-only review rejects ${scenario.name}`, () => {
    const fixture = createFixture();
    try {
      const path = prepareCompileOnlyFixture(fixture);
      const candidate = JSON.parse(readFileSync(path, "utf8"));
      scenario.mutate(candidate);
      writeFileSync(path, JSON.stringify(candidate));
      assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: path }, fixture.deps), scenario.expected);
    } finally { fixture.cleanup(); }
  });
}

test("compile-only review rejects noncanonical and ambiguous evidence routes", () => {
  const fixture = createFixture();
  try {
    const path = prepareCompileOnlyFixture(fixture);
    const copy = join(fixture.root, "candidate.json");
    copyFileSync(path, copy);
    assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: copy }, fixture.deps), /canonical/);
    assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: path,
      derivedReceiptPath: fixture.receiptPath }, fixture.deps), /exactly one/);
  } finally { fixture.cleanup(); }
});

for (const kind of ["prepared-source", "frozen-derived"] as const) {
  test(`durable authority review and acceptance preserve the original ${kind} source`, () => {
    const fixture = createFixture();
    try {
      const durable = durableAuthorityFixture(fixture);
      const candidatePath = kind === "prepared-source" ? prepareCompileOnlyFixture(fixture) : undefined;
      const reviewed = reviewCodexBuild({ transactionId: TRANSACTION,
        ...(candidatePath ? { sourceCandidatePath: candidatePath } : { derivedReceiptPath: fixture.receiptPath }),
        acceptedAuthorityUserRoot: durable.root }, durable.deps);
      const acceptedRoot = join(durable.root, "codex-source", "accepted", TRANSACTION);
      assert.equal(reviewed.reviewManifestPath, join(acceptedRoot, "review-manifest.json"));
      assert.equal(existsSync(fixture.acceptedRoot), false, "no authority is issued at the private source origin");
      const manifest = JSON.parse(readFileSync(reviewed.reviewManifestPath, "utf8"));
      assert.equal(manifest.buildEvidence.path, candidatePath ?? fixture.receiptPath);
      assert.equal(manifest.source.root, fixture.sourceRoot);
      assert.equal(manifest.binary.acceptedPath, join(acceptedRoot, "codex"));
      assert.ok(manifest.tests.every((entry: {path: string}) => entry.path.startsWith(`${acceptedRoot}/test-evidence/`)));
      const accepted = acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath,
        acceptedManifestSha256: reviewed.reviewManifestSha256 }, durable.deps);
      const receipt = JSON.parse(readFileSync(accepted.acceptedReceiptPath, "utf8"));
      assert.equal(receipt.schemaVersion, 2);
      assert.equal(receipt.binary.path, join(acceptedRoot, "codex"));
      assert.equal(receipt.closure.codeModeHost.path, join(acceptedRoot, "codex-code-mode-host"));
      assert.equal(sha256(receipt.binary.path), receipt.binary.sha256);
      assert.equal(sha256(receipt.closure.codeModeHost.path), receipt.closure.codeModeHost.sha256);
      assert.equal(existsSync(manifest.binary.sourcePath), true);
      assert.equal(existsSync(fixture.rustStdout), true);
      const retainedTemporaryNames = assertDurableTemporaryEvidence(acceptedRoot);
      assert.deepEqual(acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath,
        acceptedManifestSha256: reviewed.reviewManifestSha256 }, durable.deps), accepted);
      assert.deepEqual(assertDurableTemporaryEvidence(acceptedRoot), retainedTemporaryNames,
        "exact acceptance replay retains existing temporary evidence without allocating new copies");
    } finally { fixture.cleanup(); }
  });
}

for (const scenario of ["arbitrary root", "relative root", "external root", "missing root", "nonprivate root",
  "foreign owner", "linked root", "linked descendant", "nonprivate descendant"] as const) {
  test(`durable authority rejects ${scenario} before destination allocation`, () => {
    const fixture = createFixture();
    try {
      const durable = durableAuthorityFixture(fixture);
      let requested = durable.root;
      let deps = durable.deps;
      let redirected: string | null = null;
      if (scenario === "arbitrary root") requested = join(fixture.root, "unapproved-authority");
      if (scenario === "relative root") requested = "relative-authority";
      if (scenario === "external root") requested = "/Volumes/External/Tweakers";
      if (scenario === "missing root") rmSync(durable.root, { recursive: true });
      if (scenario === "nonprivate root") chmodSync(durable.root, 0o755);
      if (scenario === "foreign owner") deps = { ...deps, effectiveUid: () => (process.getuid?.() ?? 0) + 1 };
      if (scenario === "linked root") {
        redirected = `${durable.root}.real`;
        renameSync(durable.root, redirected);
        symlinkSync(redirected, durable.root);
      }
      if (scenario === "linked descendant") {
        redirected = join(fixture.root, "redirected-storage");
        mkdirSync(redirected, { mode: 0o700 });
        symlinkSync(redirected, join(durable.root, "codex-source"));
      }
      if (scenario === "nonprivate descendant") {
        mkdirSync(join(durable.root, "codex-source"), { mode: 0o700 });
        chmodSync(join(durable.root, "codex-source"), 0o755);
      }
      assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath,
        acceptedAuthorityUserRoot: requested }, deps), /canonical|owner-private|linked|foreign-owned|ENOENT/);
      assert.equal(existsSync(join(durable.root, "codex-source", "accepted", TRANSACTION)), false);
      if (redirected) assert.equal(existsSync(join(redirected, "accepted")), false);
      assert.equal(existsSync(fixture.acceptedRoot), false);
    } finally { fixture.cleanup(); }
  });
}

for (const scenario of ["binary destination", "test destination", "copied manifest", "source drift", "linked destination after review"] as const) {
  test(`durable acceptance rejects ${scenario} without issuing a pair`, () => {
    const fixture = createFixture();
    try {
      const durable = durableAuthorityFixture(fixture);
      const candidatePath = prepareCompileOnlyFixture(fixture);
      const reviewed = reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: candidatePath,
        acceptedAuthorityUserRoot: durable.root }, durable.deps);
      let manifestPath = reviewed.reviewManifestPath;
      let digest = reviewed.reviewManifestSha256;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (scenario === "binary destination" || scenario === "test destination") {
        if (scenario === "binary destination") manifest.binary.acceptedPath = join(fixture.acceptedRoot, "codex");
        else manifest.tests[0].path = join(fixture.acceptedRoot, "test-evidence", "rust-lifecycle.json");
        writeFileSync(manifestPath, JSON.stringify(manifest));
        digest = sha256(manifestPath);
      }
      if (scenario === "copied manifest") {
        manifestPath = join(fixture.root, "copied-review-manifest.json");
        copyFileSync(reviewed.reviewManifestPath, manifestPath);
        chmodSync(manifestPath, 0o600);
      }
      if (scenario === "source drift") writeFileSync(join(fixture.sourceRoot, "source.txt"), "unreviewed source drift\n");
      if (scenario === "linked destination after review") {
        const acceptedRoot = join(durable.root, "codex-source", "accepted", TRANSACTION);
        renameSync(acceptedRoot, `${acceptedRoot}.retained`);
        symlinkSync(`${acceptedRoot}.retained`, acceptedRoot);
      }
      assert.throws(() => acceptCodexBuild({ reviewManifestPath: manifestPath,
        acceptedManifestSha256: digest }, durable.deps), /changed|directory|source|linked/);
      assert.equal(existsSync(join(durable.root, "codex-source", "accepted", TRANSACTION, "accepted-build.json")), false);
      assert.equal(existsSync(join(durable.root, "codex-source", "accepted", TRANSACTION, "codex")), false);
      assert.equal(existsSync(fixture.acceptedRoot), false);
    } finally { fixture.cleanup(); }
  });
}

function durableAuthorityFixture(fixture: Fixture): { root: string; deps: Partial<CodexBuildAttestationDependencies> } {
  const root = join(fixture.root, "durable-manager");
  mkdirSync(root, { mode: 0o700 });
  return { root, deps: { ...fixture.deps, canonicalAcceptedAuthorityUserRoot: () => root } };
}

function assertDurableTemporaryEvidence(acceptedRoot: string): string[] {
  const names = readdirSync(acceptedRoot).filter(name => name.endsWith(".tmp")).sort();
  for (const [file, mode] of [["review-manifest.json", 0o600], ["codex", 0o700],
    ["codex-code-mode-host", 0o700], ["accepted-build.json", 0o600], ["acceptance.json", 0o600]] as const) {
    const temporaryName = names.find(name => name.startsWith(`.${file}.`));
    assert.ok(temporaryName, `${file} retains its private temporary hard link`);
    const published = join(acceptedRoot, file);
    const temporary = join(acceptedRoot, temporaryName);
    const publishedStatus = statSync(published);
    const temporaryStatus = statSync(temporary);
    assert.equal(sha256(temporary), sha256(published), `${file} temporary bytes match publication`);
    assert.equal(temporaryStatus.mode & 0o777, mode, `${file} temporary remains private`);
    assert.equal(temporaryStatus.dev, publishedStatus.dev);
    assert.equal(temporaryStatus.ino, publishedStatus.ino, `${file} temporary is the published inode`);
    assert.ok(temporaryStatus.nlink >= 2, `${file} retains both hard links`);
  }
  return names;
}

test("durable authority rejects an ancestor replaced before immutable publication", () => {
  const fixture = createFixture();
  try {
    const durable = durableAuthorityFixture(fixture);
    const redirected = join(fixture.root, "unapproved-storage");
    mkdirSync(redirected, { mode: 0o700 });
    let replaced = false;
    assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath,
      acceptedAuthorityUserRoot: durable.root }, { ...durable.deps, fault: point => {
        if (point !== "review-manifest:after-temp-fsync") return;
        replaced = true;
        renameSync(durable.root, `${durable.root}.retained`);
        symlinkSync(redirected, durable.root);
      } }), /linked|noncanonical|identity changed/);
    assert.equal(replaced, true);
    assert.equal(existsSync(join(redirected, "codex-source")), false, "no publication follows the replacement");
  } finally { fixture.cleanup(); }
});

test("explicit durable authority rejects source-default root without allocation or mode changes", () => {
  const fixture = createFixture();
  try {
    const sourceDirectories = [fixture.root, join(fixture.root, "codex-source"), join(fixture.root, "codex-source", "transactions")];
    const modes = sourceDirectories.map(path => statSync(path).mode);
    assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath,
      acceptedAuthorityUserRoot: fixture.root }, { ...fixture.deps, canonicalAcceptedAuthorityUserRoot: () => fixture.root }), /distinct source root/);
    assert.equal(existsSync(fixture.acceptedRoot), false);
    assert.deepEqual(sourceDirectories.map(path => statSync(path).mode), modes);
  } finally { fixture.cleanup(); }
});

for (const action of ["write", "copy"] as const) for (const replacement of ["symlink", "real directory"] as const) {
  test(`durable ${action} failure preserves original temporary and ${replacement} cleanup sentinel`, () => {
    const fixture = createFixture();
    try {
      const durable = durableAuthorityFixture(fixture);
      const acceptedRoot = join(durable.root, "codex-source", "accepted", TRANSACTION);
      const faultPoint = action === "write" ? "review-manifest:after-temp-fsync" : "accepted-binary:after-temp-fsync";
      const prefix = action === "write" ? ".review-manifest.json." : ".codex.";
      // Writer cases replace the authority; copier cases replace only the
      // destination parent, proving both retained directory identities matter.
      const replacedDirectory = action === "write" ? durable.root : acceptedRoot;
      const retainedRoot = `${replacedDirectory}.retained`;
      const replacementRoot = replacement === "symlink" ? join(fixture.root, "replacement-storage") : replacedDirectory;
      let relativeTemporary: string | null = null;
      let originalSha256: string | null = null;
      const faultDeps = { ...durable.deps, fault: (point: string) => {
        if (point !== faultPoint) return;
        const temporaryName = readdirSync(acceptedRoot).find(name => name.startsWith(prefix) && name.endsWith(".tmp"));
        assert.ok(temporaryName);
        const temporary = join(acceptedRoot, temporaryName);
        relativeTemporary = relative(replacedDirectory, temporary);
        originalSha256 = sha256(temporary);
        renameSync(replacedDirectory, retainedRoot);
        mkdirSync(replacementRoot, { mode: 0o700 });
        if (replacement === "symlink") symlinkSync(replacementRoot, replacedDirectory);
        const sentinel = join(replacementRoot, relativeTemporary);
        mkdirSync(dirname(sentinel), { recursive: true, mode: 0o700 });
        writeFileSync(sentinel, "replacement cleanup sentinel", { mode: 0o600 });
      } };
      if (action === "write") {
        assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath,
          acceptedAuthorityUserRoot: durable.root }, faultDeps), /identity changed/);
      } else {
        const reviewed = reviewCodexBuild({ transactionId: TRANSACTION, derivedReceiptPath: fixture.receiptPath,
          acceptedAuthorityUserRoot: durable.root }, durable.deps);
        assert.throws(() => acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath,
          acceptedManifestSha256: reviewed.reviewManifestSha256 }, faultDeps), /identity changed/);
      }
      assert.ok(relativeTemporary, "fault must replace the original authority after temporary creation");
      assert.equal(readFileSync(join(replacementRoot, relativeTemporary), "utf8"), "replacement cleanup sentinel");
      assert.equal(sha256(join(retainedRoot, relativeTemporary)), originalSha256, "original temporary evidence survives failure");
      const retainedAcceptedRoot = action === "write" ? join(retainedRoot, "codex-source", "accepted", TRANSACTION) : retainedRoot;
      assert.equal(existsSync(join(retainedAcceptedRoot, "accepted-build.json")), false);
    } finally { fixture.cleanup(); }
  });
}

function prepareCompileOnlyFixture(fixture: Fixture): string {
  const paths = codexSourceTransactionPaths(fixture.root, TRANSACTION);
  const binaryPath = join(paths.sourceRoot, "codex-rs", "target", "release", "codex");
  const helperPath = join(paths.sourceRoot, "codex-rs", "target", "release", "codex-code-mode-host");
  mkdirSync(join(paths.sourceRoot, "codex-rs", "target", "release"), { recursive: true });
  copyFileSync(fixture.binaryPath, binaryPath);
  copyFileSync(fixture.receipt.backendClosure!.codeModeHost.path, helperPath);
  const evidence = { source: fixture.receipt.source, dependencies: fixture.receipt.dependencies,
    frontendControl: fixture.receipt.frontendControl, controlBinary: fixture.receipt.controlBinary,
    candidateBinary: fixture.receipt.candidateBinary, rustLifecycleTests: fixture.receipt.rustLifecycleTests,
    compiledBackend: { binaryPath, codeModeHostPath: helperPath },
    backendClosure: { ...fixture.receipt.backendClosure!, codeModeHost: { ...fixture.receipt.backendClosure!.codeModeHost, path: helperPath } },
    generatedRuntime: fixture.receipt.generatedRuntime };
  const checkpoints = fixture.receipt.resolution.checkpoints.slice(0, 2);
  writeFileSync(paths.candidateStateFile, JSON.stringify({ schemaVersion: 1, kind: "codex-source-candidate",
    transactionId: TRANSACTION, channel: "bundled", bundledVersion: VERSION, sourceRoot: paths.sourceRoot,
    cycle: { status: "active", channel: "bundled", candidate: checkpoints[1], checkpoints,
      restartWindow: null, frozenAt: null, supersededBy: null, newerAvailable: null },
    evidence, createdAt: NOW, updatedAt: NOW }));
  return paths.candidateStateFile;
}

function createFixture(qualifiedV8 = false): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-build-attestation-")));
  const paths = codexSourceTransactionPaths(root, TRANSACTION);
  mkdirSync(join(paths.sourceRoot, "codex-rs"), { recursive: true });
  writeFileSync(join(paths.sourceRoot, "codex-rs", "Cargo.lock"), "version = 4\n");
  writeFileSync(join(paths.sourceRoot, "source.txt"), "upstream\n");
  // Match the upstream checkout: compiled Cargo outputs do not enter source-tree authority.
  writeFileSync(join(paths.sourceRoot, ".gitignore"), "codex-rs/target/\n");
  if (qualifiedV8) {
    const { anchor } = qualifiedV8FixtureBytes();
    mkdirSync(join(paths.sourceRoot, "third_party", "v8"), { recursive: true });
    writeFileSync(join(paths.sourceRoot, "third_party", "v8", "rusty_v8_150_4_0_release_manifests.sha256"), anchor);
    writeFileSync(join(paths.sourceRoot, "codex-rs", "Cargo.toml"), `version = "${VERSION}"\nv8 = "=150.4.0"\n`);
  }
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
  const helperPath = join(paths.candidateApp, "Contents/Resources/codex-code-mode-host");
  writeFileSync(helperPath, "fixture matching helper", { mode: 0o700 });
  const runtimeRoot = join(paths.root, "candidate/runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "main.js"), "fixture runtime");
  const runtime = computeRuntimeFingerprint(runtimeRoot);
  writeFileSync(join(runtimeRoot, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...runtime }));
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
  const patchFile = join(paths.root, "reviewed.patch");
  writeFileSync(patchFile, "reviewed patch series");
  const patchSeriesDigest = createHash("sha256").update("0\0").update(readFileSync(patchFile)).update("\0").digest("hex");
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
    signature: SIGNATURE,
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
      patchSeriesDigest: { algorithm: "sha256", value: patchSeriesDigest, scope: "patch series" },
      patchSeriesFiles: [{ path: patchFile, sha256: sha256(patchFile) }],
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
    candidateBinary: { ...artifact("official GitHub tag commit"), digests: [
      { algorithm: "sha256", value: binarySha256, scope: "derived candidate binary" },
      { algorithm: "sha256", value: sha256(helperPath), scope: "derived candidate code-mode helper" },
    ] },
    backendClosure: { codeModeHost: { path: helperPath, sha256: sha256(helperPath), architecture: "arm64", signature: SIGNATURE }, resources: [] },
    generatedRuntime: { sourceRoot: runtimeRoot, ...runtime, documentSha256: sha256(join(runtimeRoot, "runtime-fingerprint.json")) },
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
    probeSignature: () => SIGNATURE,
    verifyCodeModeHostPosture: () => true,
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

test("compile-only review cannot authorize qualified test origin without official V8 provenance", () => {
  const fixture = createFixture();
  try {
    const path = prepareCompileOnlyFixture(fixture);
    const candidate = JSON.parse(readFileSync(path, "utf8"));
    const rust = candidate.evidence.rustLifecycleTests;
    const counts = [1, 4, 1, 1, 13, 1, 6, 10, 1]; let offset = 0;
    writeFileSync(rust.stdoutFile, counts.map(n => {
      const names = REQUIRED_TESTS.slice(offset, offset += n).map(name => `test ${name} ... ok`).join("\n");
      return `${names}\ntest result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`;
    }).join("\n"));
    delete rust.startedAt; delete rust.completedAt;
    rust.schemaVersion = 2; rust.stdoutSha256 = sha256(rust.stdoutFile);
    rust.origin = { kind: "lead-qualified-prior-transaction", userRoot: fixture.root, transactionId: "prior",
      qualification: { path: join(fixture.root, "codex-source", "qualifications", "prior.json"), sha256: "1".repeat(64) },
      timing: { kind: "bounded-execution-window", notBefore: NOW, notAfter: NOW },
      observations: { kind: "partially-observed-original-environment" as const, observedOverrides: OBSERVED_RUST_OVERRIDES,
        unobservedOriginalKeys: UNOBSERVED_ORIGINAL_RUST_KEYS, testLibFingerprints: Array.from({ length: 9 }, (_, i) => ({ package: `shape-${i}`, testExecutable: `shape-${i}`, fingerprint: { path: `/private/shape-${i}.json`, sha256: "1".repeat(64) } })) }, priorToolchain: { rustc: RUSTC, rustcInfo: { path: join(fixture.root, "prior", ".rustc_info.json"), sha256: "1".repeat(64) }, cargo: null } };
    writeFileSync(path, JSON.stringify(candidate));
    assert.throws(() => reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: path }, fixture.deps), /qualified|V8/i);
    assert.equal(existsSync(fixture.reviewManifest), false);
  } finally { fixture.cleanup(); }
});


function qualifiedV8FixtureBytes() {
  const names = ["rusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.sha256",
    "librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz", "src_binding_ptrcomp_sandbox_release_aarch64-apple-darwin.rs"];
  const archive = "fixture exact archive", binding = "fixture exact binding";
  const manifest = `${sha256Text(archive)}  ${names[1]}\n${sha256Text(binding)}  ${names[2]}\n`;
  return { names, archive, binding, manifest, anchor: `${sha256Text(manifest)}  ${names[0]}\n` };
}

/** Entire real qualification/receipt chain; only existing signature/toolchain fixture seams are used. */
function prepareQualifiedCompileOnlyFixture(fixture: Fixture): string {
  const path = prepareCompileOnlyFixture(fixture);
  const candidate = JSON.parse(readFileSync(path, "utf8"));
  const source = inspectRustSourceIdentity(fixture.sourceRoot, candidate.evidence.source.patchSeriesFiles.map((f: {path: string}) => f.path));
  const prior = "qualified-prior", priorRoot = join(fixture.root, "codex-source", "transactions", prior);
  mkdirSync(priorRoot, { recursive: true, mode: 0o700 });
  cpSync(fixture.sourceRoot, join(priorRoot, "source"), { recursive: true });
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: sha256(path) };
  };
  const artifact = (name: string, value: unknown) => write(join(fixture.root, "qualified-origin", name),
    typeof value === "string" ? value : JSON.stringify(value));
  const counts = [1, 4, 1, 1, 13, 1, 6, 10, 1]; let offset = 0;
  const stdoutText = counts.map(n => `${REQUIRED_TESTS.slice(offset, offset += n).map(name => `test ${name} ... ok`).join("\n")}\ntest result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`).join("\n");
  const packages = ["codex-app-server", "codex-app-server-protocol", "codex-config", "codex-core", "codex-core-plugins", "codex-home", "codex-mcp", "codex-rmcp-client", "codex-secrets"];
  const fingerprints = packages.map((pkg, i) => {
    const suffix = i.toString(16).padStart(16, "0"), crate = pkg.replace(/-/g, "_");
    return { package: pkg, testExecutable: `${crate}-${suffix}`, fingerprint: write(join(priorRoot, "source", "codex-rs", "target", "debug", ".fingerprint", `${pkg}-${suffix}`, `test-lib-${crate}.json`),
      '{"rustc":2179919275645516985,"profile":5829779523522457634,"config":8247474407144887393,"rustflags":[],"compile_kind":0}') };
  });
  const stderrText = fingerprints.map(f => `     Running unittests src/lib.rs (target/debug/deps/${f.testExecutable})`).join("\n") + "\n";
  const stdout = write(join(priorRoot, "prepared", "rust-lifecycle-tests", "cargo-test.stdout.log"), stdoutText);
  const stderr = write(join(priorRoot, "prepared", "rust-lifecycle-tests", "cargo-test.stderr.log"), stderrText);
  const rustcInfo = write(join(priorRoot, "source", "codex-rs", "target", ".rustc_info.json"),
    JSON.stringify({ outputs: { rustc: { success: true, code: 0, stdout: RUSTC } } }));
  const wrapperLog = artifact("wrapper.log", "HTTP Error 404: Not Found\nwarning: build failed, waiting for other jobs to finish...\n");
  const preflightData = { transactionId: prior, userRoot: fixture.root, at: NOW, patches: source.patches };
  const preflight = artifact("preflight.json", preflightData);
  const invocation = artifact("invocation.json", { records: [
    { record: { timestamp: NOW, payload: { type: "custom_tool_call", call_id: "fixture-call", input: "scripts/local-work.mjs packages/installer/src/cli.ts codex-source --build-only --transaction-id pf.transactionId pf.userRoot CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0" } } },
    { record: { payload: { item: { aggregated_output: JSON.stringify(preflightData), exit_code: 0 } } } },
    { record: { payload: { type: "custom_tool_call_output", call_id: "fixture-call", output: [{ text: JSON.stringify({ transactionId: prior, session_id: 1 }) }] } } },
  ] });
  const failure = artifact("failure.json", { kind: "lead-observed-source-build-failure", transactionId: prior, sourceCommit: source.commit,
    buildExitCode: 1, liveMutation: false, candidateStateExists: false, failurePhase: "release-helper-v8-download",
    requiredRustTestResults: { observedProductionFlowAdvancedToReleaseBuild: true, structuredReceiptProduced: false, passedCount: 38, namedPassedTests: REQUIRED_TESTS },
    artifacts: Object.fromEntries([stdout, stderr, wrapperLog].map(f => [f.path, { sha256: f.sha256 }])) });
  const timing = { kind: "bounded-execution-window", notBefore: NOW, notAfter: NOW };
  const priorToolchain = { rustc: RUSTC, rustcInfo, cargo: null };
  const observations = { kind: "partially-observed-original-environment", observedOverrides: OBSERVED_RUST_OVERRIDES,
    unobservedOriginalKeys: UNOBSERVED_ORIGINAL_RUST_KEYS, testLibFingerprints: fingerprints };
  const qualification = write(join(fixture.root, "codex-source", "qualifications", `${prior}.json`), JSON.stringify({
    schemaVersion: 1, kind: "lead-qualified-codex-rust-tests", userRoot: fixture.root, priorTransactionId: prior,
    source, command: CODEX_SOURCE_RUST_TEST_COMMAND, timing, priorToolchain, observations,
    execution: { kind: "frozen-runner-advanced-to-release", runner: artifact("runner.ts", "fixture frozen runner"), invocation, wrapperLog, failure, preflight },
    logs: { stdout, stderr },
  }));
  const rust = candidate.evidence.rustLifecycleTests;
  writeFileSync(rust.stdoutFile, stdoutText); writeFileSync(rust.stderrFile, stderrText);
  delete rust.startedAt; delete rust.completedAt; rust.schemaVersion = 2;
  rust.passedTests = [...REQUIRED_TESTS].sort();
  rust.stdoutSha256 = stdout.sha256; rust.stderrSha256 = stderr.sha256;
  rust.origin = { kind: "lead-qualified-prior-transaction", userRoot: fixture.root, transactionId: prior,
    qualification, timing, priorToolchain, observations };
  const v8 = qualifiedV8FixtureBytes(), v8Root = join(fixture.root, "verified-v8");
  const files = [write(join(v8Root, v8.names[0]!), v8.manifest), write(join(v8Root, v8.names[1]!), v8.archive), write(join(v8Root, v8.names[2]!), v8.binding)];
  const verification = write(join(v8Root, "verification.json"), JSON.stringify({ schemaVersion: 1, kind: "verified-upstream-v8-build-inputs",
    upstreamCommit: source.commit, releaseUrl: "https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0", nativeMutation: false,
    trustAnchor: { sha256: sha256Text(v8.anchor), manifestSha256: files[0]!.sha256 }, files,
    overrides: { RUSTY_V8_ARCHIVE: files[1]!.path, RUSTY_V8_SRC_BINDING_PATH: files[2]!.path } }));
  candidate.evidence.source.v8BuildInputs = verifyV8BuildInputs({ verificationPath: verification.path, acceptVerificationSha256: verification.sha256 }, fixture.sourceRoot, source.commit);
  writeFileSync(path, JSON.stringify(candidate));
  return path;
}

for (const verifierEnvironment of ["empty Cargo environment", "changed Cargo environment and config"] as const) {
  test(`qualified review and accept validate immutable origin under ${verifierEnvironment}`, () => {
    const fixture = createFixture(true);
    const keys = [...Object.keys(OBSERVED_RUST_OVERRIDES), ...UNOBSERVED_ORIGINAL_RUST_KEYS, "CARGO_HOME"];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      const candidatePath = prepareQualifiedCompileOnlyFixture(fixture);
      for (const key of keys) delete process.env[key];
      if (verifierEnvironment === "changed Cargo environment and config") {
        process.env.RUSTFLAGS = "--cfg=verifier_only";
        process.env.CARGO_PROFILE_DEV_DEBUG = "2";
        process.env.CARGO_HOME = join(fixture.root, "verifier-cargo-home");
        mkdirSync(process.env.CARGO_HOME, { mode: 0o700 });
        writeFileSync(join(process.env.CARGO_HOME, "config.toml"), '[build]\nrustflags = ["--cfg=verifier_only"]\n');
      }
      const reviewed = reviewCodexBuild({ transactionId: TRANSACTION, sourceCandidatePath: candidatePath }, fixture.deps);
      const accepted = acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath, acceptedManifestSha256: reviewed.reviewManifestSha256 }, fixture.deps);
      assert.equal(accepted.acceptedBinarySha256, sha256(fixture.binaryPath));
      assert.equal(existsSync(accepted.acceptedReceiptPath), true);
      const manifest = JSON.parse(readFileSync(reviewed.reviewManifestPath, "utf8"));
      const retained = JSON.parse(readFileSync(manifest.tests[0].path, "utf8"));
      assert.equal(retained.origin.priorToolchain.cargo, null);
      assert.deepEqual(retained.origin.observations.unobservedOriginalKeys, UNOBSERVED_ORIGINAL_RUST_KEYS);
      const qualification = JSON.parse(readFileSync(retained.origin.qualification.path, "utf8"));
      writeFileSync(qualification.logs.stdout.path, "mutated original proof");
      assert.throws(() => acceptCodexBuild({ reviewManifestPath: reviewed.reviewManifestPath, acceptedManifestSha256: reviewed.reviewManifestSha256 }, fixture.deps), /accepted SHA/);
    } finally {
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      fixture.cleanup();
    }
  });
}

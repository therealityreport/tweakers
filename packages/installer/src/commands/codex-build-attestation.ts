import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CODEX_DERIVED_RECEIPT_SCHEMA_VERSION,
  readCodexDerivedReceipt,
  type CodexDerivedReceipt,
  type CodexRustLifecycleTestEvidence,
} from "../codex-derived-receipt.js";
import { CODEX_RELEASE_REPOSITORY, parseCodexReleaseTag } from "../codex-source-release.js";
import { assertInternalStoragePath } from "../internal-storage.js";
import type { AcceptedPrebuiltCodexBuildReceipt, PrebuiltCodexArchitecture } from "../prebuilt-combined-candidate.js";
import {
  CODEX_SOURCE_BUILD_COMMAND,
  CODEX_SOURCE_RUST_TEST_COMMAND,
  codexSourceTransactionPaths,
} from "./codex-source.js";

const CODEX_GIT_URL = "https://github.com/openai/codex.git" as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const REQUIRED_RUST_LIFECYCLE_TESTS = [
  "connection_manager::tests::deferred_shutdown_does_not_ignite_never_started_servers",
  "connection_manager::tests::cancelled_startup_never_reaches_the_transport",
  "connection_manager::tests::shutdown_continues_after_caller_is_aborted",
  "connection_manager::tests::capture_binding_exposes_cached_tools_before_startup",
  "connection_manager::tests::cancelling_startup_does_not_disable_a_ready_client",
  "connection_manager::tests::shutdown_cancels_pending_tool_listing",
] as const;

export type CodexBuildAttestationAction = "review" | "accept";

export interface CodexBuildAttestationCliOptions {
  transaction?: string;
  derivedReceipt?: string;
  "derived-receipt"?: string;
  reviewManifest?: string;
  "review-manifest"?: string;
  acceptReviewedManifestSha256?: string;
  "accept-reviewed-manifest-sha256"?: string;
  json?: boolean;
}

export interface CodexBuildReviewManifest {
  schemaVersion: 1;
  kind: "tweakers-codex-build-review";
  transactionId: string;
  reviewedAt: string;
  owner: {
    uid: number;
    username: string;
  };
  derivedReceipt: {
    path: string;
    sha256: string;
  };
  upstream: {
    repository: typeof CODEX_GIT_URL;
    tag: string;
    commit: string;
  };
  source: {
    root: string;
    treeSha256: string;
    patchSeriesSha256: string;
    reviewedDiffSha256: string;
    cargoLockPath: string;
    cargoLockSha256: string;
  };
  build: {
    command: string;
    argv: readonly string[];
    toolchain: string;
    rustc: string;
    cargo: string;
    architecture: PrebuiltCodexArchitecture;
  };
  tests: readonly CodexBuildReviewTestReceipt[];
  binary: {
    sourcePath: string;
    acceptedPath: string;
    sha256: string;
    version: string;
    architecture: PrebuiltCodexArchitecture;
  };
}

export interface CodexBuildReviewTestReceipt {
  name: "codex Rust lifecycle tests" | "managed MCP integration canary";
  command: string;
  path: string;
  sha256: string;
  status: "passed";
}

export interface CodexBuildReviewResult {
  schemaVersion: 1;
  kind: "tweakers-codex-build-review-result";
  transactionId: string;
  reviewManifestPath: string;
  reviewManifestSha256: string;
  acceptedBinaryPath: string;
  liveMutation: false;
}

export interface CodexBuildAcceptanceResult {
  schemaVersion: 1;
  kind: "tweakers-codex-build-acceptance-result";
  transactionId: string;
  reviewManifestPath: string;
  reviewManifestSha256: string;
  acceptedReceiptPath: string;
  acceptedReceiptSha256: string;
  acceptedBinaryPath: string;
  acceptedBinarySha256: string;
  acceptanceRecordPath: string;
  acceptanceRecordSha256: string;
  liveMutation: false;
}

interface CodexBuildAcceptanceRecord {
  schemaVersion: 1;
  kind: "tweakers-codex-build-acceptance";
  transactionId: string;
  acceptedAt: string;
  acceptedBy: {
    uid: number;
    username: string;
  };
  reviewManifest: {
    path: string;
    sha256: string;
  };
  acceptedReceipt: {
    path: string;
    sha256: string;
  };
  backend: {
    path: string;
    sha256: string;
    version: string;
    architecture: PrebuiltCodexArchitecture;
  };
}

export interface CodexBuildAttestationDependencies {
  now(): string;
  effectiveUid(): number | null;
  username(): string;
  git(args: readonly string[], cwd: string): string;
  probeBinaryVersion(path: string): string;
  probeBinaryArchitecture(path: string): PrebuiltCodexArchitecture | null;
  probeToolchain(): { rustc: string; cargo: string };
  /** Test-only deterministic fault seam; production never supplies it. */
  fault?(point: string): void;
}

interface InspectedBuild {
  receipt: CodexDerivedReceipt;
  receiptPath: string;
  receiptSha256: string;
  transactionId: string;
  owner: CodexBuildReviewManifest["owner"];
  upstream: CodexBuildReviewManifest["upstream"];
  source: CodexBuildReviewManifest["source"];
  build: CodexBuildReviewManifest["build"];
  binary: CodexBuildReviewManifest["binary"];
  rustEvidenceBytes: Buffer;
  canaryEvidenceBytes: Buffer;
}

interface AttestationPaths {
  userRoot: string;
  transactionRoot: string;
  evidenceRoot: string;
  rustEvidence: string;
  canaryEvidence: string;
  reviewManifest: string;
  acceptedBinary: string;
  acceptedReceipt: string;
  acceptanceRecord: string;
}

const defaultDependencies: CodexBuildAttestationDependencies = {
  now: () => new Date().toISOString(),
  effectiveUid: () => process.getuid?.() ?? null,
  username: () => userInfo().username,
  git: runGit,
  probeBinaryVersion,
  probeBinaryArchitecture,
  probeToolchain: () => ({
    rustc: execFileSync("rustc", ["-vV"], { encoding: "utf8", timeout: 10_000 }),
    cargo: execFileSync("cargo", ["-V"], { encoding: "utf8", timeout: 10_000 }),
  }),
};

export function codexBuildAttestation(
  rawAction: string,
  options: CodexBuildAttestationCliOptions = {},
  dependencyOverrides: Partial<CodexBuildAttestationDependencies> = {},
): CodexBuildReviewResult | CodexBuildAcceptanceResult {
  const action = parseAction(rawAction);
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  const result = action === "review"
    ? reviewCodexBuild({
        transactionId: requireOption(options.transaction, "--transaction"),
        derivedReceiptPath: requireOption(
          options.derivedReceipt ?? options["derived-receipt"],
          "--derived-receipt",
        ),
      }, deps)
    : acceptCodexBuild({
        reviewManifestPath: requireOption(
          options.reviewManifest ?? options["review-manifest"],
          "--review-manifest",
        ),
        acceptedManifestSha256: requireOption(
          options.acceptReviewedManifestSha256 ?? options["accept-reviewed-manifest-sha256"],
          "--accept-reviewed-manifest-sha256",
        ),
      }, deps);
  console.log(options.json === false ? JSON.stringify(result, null, 2) : JSON.stringify(result));
  return result;
}

export function reviewCodexBuild(
  input: { transactionId: string; derivedReceiptPath: string },
  dependencyOverrides: Partial<CodexBuildAttestationDependencies> = {},
): CodexBuildReviewResult {
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  requireTransactionId(input.transactionId);
  const receiptPath = requireExactInternalFile(input.derivedReceiptPath, "Derived build receipt");
  const paths = attestationPathsForReceipt(receiptPath, input.transactionId);
  ensureOwnerPrivateDirectory(paths.transactionRoot, deps);
  ensureOwnerPrivateDirectory(paths.evidenceRoot, deps);
  const inspected = inspectDerivedBuild(receiptPath, input.transactionId, paths, deps);

  writeImmutableFile(paths.rustEvidence, inspected.rustEvidenceBytes, 0o600, deps, "rust-evidence");
  writeImmutableFile(paths.canaryEvidence, inspected.canaryEvidenceBytes, 0o600, deps, "canary-evidence");
  const tests = reviewTestReceipts(paths, inspected);

  let reviewedAt = deps.now();
  if (existsSync(paths.reviewManifest)) {
    reviewedAt = readReviewManifest(paths.reviewManifest).reviewedAt;
  }
  requireTimestamp(reviewedAt, "Review timestamp");
  const reviewObservedAt = deps.now();
  requireTimestamp(reviewObservedAt, "Current review timestamp");
  if (Date.parse(reviewedAt) > Date.parse(reviewObservedAt)) {
    throw new Error("Review timestamp cannot be in the future");
  }
  const manifest = createReviewManifest(inspected, tests, reviewedAt);
  const bytes = jsonBytes(manifest);
  writeImmutableFile(paths.reviewManifest, bytes, 0o600, deps, "review-manifest");
  const persisted = readReviewManifest(paths.reviewManifest);
  if (!isDeepStrictEqual(persisted, manifest)) {
    throw new Error("Existing review manifest conflicts with the freshly verified build evidence");
  }
  return {
    schemaVersion: 1,
    kind: "tweakers-codex-build-review-result",
    transactionId: input.transactionId,
    reviewManifestPath: paths.reviewManifest,
    reviewManifestSha256: sha256File(paths.reviewManifest),
    acceptedBinaryPath: paths.acceptedBinary,
    liveMutation: false,
  };
}

export function acceptCodexBuild(
  input: { reviewManifestPath: string; acceptedManifestSha256: string },
  dependencyOverrides: Partial<CodexBuildAttestationDependencies> = {},
): CodexBuildAcceptanceResult {
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  requireSha256(input.acceptedManifestSha256, "Explicitly accepted review-manifest SHA-256");
  const manifestPath = requireExactInternalFile(input.reviewManifestPath, "Build review manifest");
  const manifestSha256 = sha256File(manifestPath);
  if (manifestSha256 !== input.acceptedManifestSha256.toLowerCase()) {
    throw new Error("Release-owner acceptance is not bound to the exact reviewed manifest SHA-256");
  }
  const manifest = readReviewManifest(manifestPath);
  const paths = attestationPathsForReceipt(manifest.derivedReceipt.path, manifest.transactionId);
  if (manifestPath !== paths.reviewManifest) {
    throw new Error("Build review manifest is outside its derived transaction acceptance directory");
  }
  ensureOwnerPrivateDirectory(paths.transactionRoot, deps);
  ensureOwnerPrivateDirectory(paths.evidenceRoot, deps);
  const owner = currentOwner(deps);
  if (!isDeepStrictEqual(manifest.owner, owner)) {
    throw new Error("Build review manifest belongs to a different local release owner");
  }

  const inspected = inspectDerivedBuild(manifest.derivedReceipt.path, manifest.transactionId, paths, deps);
  writeImmutableFile(paths.rustEvidence, inspected.rustEvidenceBytes, 0o600, deps, "rust-evidence");
  writeImmutableFile(paths.canaryEvidence, inspected.canaryEvidenceBytes, 0o600, deps, "canary-evidence");
  const expectedManifest = createReviewManifest(
    inspected,
    reviewTestReceipts(paths, inspected),
    manifest.reviewedAt,
  );
  if (!isDeepStrictEqual(manifest, expectedManifest)) {
    throw new Error("Build evidence changed after the reviewed manifest was issued");
  }

  copyImmutableFile(inspected.binary.sourcePath, paths.acceptedBinary, 0o700, deps, "accepted-binary");
  if (sha256File(paths.acceptedBinary) !== inspected.binary.sha256
    || deps.probeBinaryVersion(paths.acceptedBinary) !== inspected.binary.version
    || deps.probeBinaryArchitecture(paths.acceptedBinary) !== "arm64") {
    throw new Error("Owner-private accepted backend copy does not match the reviewed binary");
  }

  const acceptedAt = existingAcceptedAt(paths.acceptedReceipt) ?? deps.now();
  requireTimestamp(acceptedAt, "Acceptance timestamp");
  const acceptanceObservedAt = deps.now();
  requireTimestamp(acceptanceObservedAt, "Current acceptance timestamp");
  if (Date.parse(acceptedAt) > Date.parse(acceptanceObservedAt)) {
    throw new Error("Acceptance timestamp cannot be in the future");
  }
  const acceptedReceipt = createAcceptedReceipt(manifest, acceptedAt);
  writeImmutableFile(paths.acceptedReceipt, jsonBytes(acceptedReceipt), 0o600, deps, "accepted-receipt");
  const persistedAccepted = readAcceptedReceipt(paths.acceptedReceipt);
  if (!isDeepStrictEqual(persistedAccepted, acceptedReceipt)) {
    throw new Error("Existing accepted-build receipt conflicts with the exact reviewed manifest");
  }
  const acceptedReceiptSha256 = sha256File(paths.acceptedReceipt);
  const acceptanceRecord: CodexBuildAcceptanceRecord = {
    schemaVersion: 1,
    kind: "tweakers-codex-build-acceptance",
    transactionId: manifest.transactionId,
    acceptedAt,
    acceptedBy: owner,
    reviewManifest: { path: manifestPath, sha256: manifestSha256 },
    acceptedReceipt: { path: paths.acceptedReceipt, sha256: acceptedReceiptSha256 },
    backend: {
      path: paths.acceptedBinary,
      sha256: manifest.binary.sha256,
      version: manifest.binary.version,
      architecture: "arm64",
    },
  };
  writeImmutableFile(paths.acceptanceRecord, jsonBytes(acceptanceRecord), 0o600, deps, "acceptance-record");
  const persistedRecord = readJsonFile(paths.acceptanceRecord, "Acceptance record") as unknown;
  if (!isDeepStrictEqual(persistedRecord, acceptanceRecord)) {
    throw new Error("Existing acceptance record conflicts with the exact reviewed decision");
  }

  return {
    schemaVersion: 1,
    kind: "tweakers-codex-build-acceptance-result",
    transactionId: manifest.transactionId,
    reviewManifestPath: manifestPath,
    reviewManifestSha256: manifestSha256,
    acceptedReceiptPath: paths.acceptedReceipt,
    acceptedReceiptSha256,
    acceptedBinaryPath: paths.acceptedBinary,
    acceptedBinarySha256: sha256File(paths.acceptedBinary),
    acceptanceRecordPath: paths.acceptanceRecord,
    acceptanceRecordSha256: sha256File(paths.acceptanceRecord),
    liveMutation: false,
  };
}

function inspectDerivedBuild(
  receiptPath: string,
  transactionId: string,
  paths: AttestationPaths,
  deps: CodexBuildAttestationDependencies,
): InspectedBuild {
  const exactReceipt = requireExactInternalFile(receiptPath, "Derived build receipt");
  const readable = readCodexDerivedReceipt(exactReceipt);
  if (!readable || readable.schemaVersion !== CODEX_DERIVED_RECEIPT_SCHEMA_VERSION) {
    throw new Error("Accepted-build review requires a schema-v2 codex-derived receipt");
  }
  const receipt = readable;
  if (receipt.transactionId !== transactionId || receipt.phase !== "canary-passed"
    || receipt.channel !== "bundled" || receipt.error !== null || receipt.supersededBy !== null) {
    throw new Error("Derived build is not the exact green, frozen bundled transaction requested for review");
  }
  if (receipt.source.repository !== CODEX_RELEASE_REPOSITORY
    || receipt.source.checkoutCommit !== receipt.resolution.peeledCommit
    || receipt.version !== receipt.resolution.normalizedVersion
    || !parseCodexReleaseTag(receipt.resolution.resolvedTag)) {
    throw new Error("Derived build does not identify the exact official OpenAI Codex release");
  }
  const tag = receipt.resolution.resolvedTag;
  if (receipt.resolution.checkpoints.some((checkpoint) =>
    checkpoint.resolvedTag !== tag
    || checkpoint.peeledCommit !== receipt.source.checkoutCommit
    || checkpoint.normalizedVersion !== receipt.version
  )) {
    throw new Error("Derived build release identity changed across R1, R2, or R3");
  }

  const sourcePaths = codexSourceTransactionPaths(paths.userRoot, transactionId);
  const sourceRoot = requireExactInternalDirectory(sourcePaths.sourceRoot, "Patched Codex source checkout");
  if (deps.git(["remote", "get-url", "origin"], sourceRoot).trim() !== CODEX_GIT_URL) {
    throw new Error("Patched source checkout does not use the exact official OpenAI Codex repository URL");
  }
  if (deps.git(["rev-parse", "HEAD"], sourceRoot).trim().toLowerCase()
    !== receipt.source.checkoutCommit.toLowerCase()) {
    throw new Error("Patched source checkout commit differs from the derived receipt");
  }
  if (deps.git(["rev-parse", `refs/tags/${tag}^{commit}`], sourceRoot).trim().toLowerCase()
    !== receipt.source.checkoutCommit.toLowerCase()) {
    throw new Error("Selected Codex tag does not peel to the reviewed source commit");
  }
  if (deps.git(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-color"], sourceRoot).length !== 0) {
    throw new Error("Patched source checkout has unstaged changes after the frozen build");
  }
  const treeSha256 = digestTrackedSource(sourceRoot, deps);
  if (receipt.source.treeDigest.algorithm !== "sha256"
    || receipt.source.treeDigest.scope !== "patched source tree"
    || receipt.source.treeDigest.value.toLowerCase() !== treeSha256) {
    throw new Error("Patched source-tree hash differs from the derived receipt");
  }
  const reviewedDiffSha256 = sha256Text(deps.git([
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-color",
    receipt.source.checkoutCommit,
    "--",
  ], sourceRoot));
  if (!receipt.source.reviewedDiffDigest
    || receipt.source.reviewedDiffDigest.algorithm !== "sha256"
    || receipt.source.reviewedDiffDigest.scope !== "reviewed applied diff"
    || receipt.source.reviewedDiffDigest.value.toLowerCase() !== reviewedDiffSha256) {
    throw new Error("Reviewed applied-diff hash differs from the derived receipt");
  }
  if (receipt.source.patchSeriesDigest.algorithm !== "sha256"
    || receipt.source.patchSeriesDigest.scope !== "patch series") {
    throw new Error("Derived receipt lacks the exact reviewed patch-series hash");
  }
  const cargoLockPath = requireExactInternalFile(join(sourceRoot, "codex-rs", "Cargo.lock"), "Cargo.lock");
  const cargoLockSha256 = sha256File(cargoLockPath);
  const lockDigest = exactNamedSha256(receipt.source.lockfileDigests, "Cargo.lock", "Cargo.lock");
  if (lockDigest !== cargoLockSha256) throw new Error("Cargo.lock hash differs from the derived receipt");
  if (JSON.stringify(receipt.source.buildCommand) !== JSON.stringify(CODEX_SOURCE_BUILD_COMMAND)) {
    throw new Error("Derived receipt does not record the exact locked Codex release build command");
  }

  const toolchain = deps.probeToolchain();
  if (exactNamedSha256(receipt.source.toolchainDigests, "rustc -vV", "Rust toolchain") !== sha256Text(toolchain.rustc)
    || exactNamedSha256(receipt.source.toolchainDigests, "cargo -V", "Cargo toolchain") !== sha256Text(toolchain.cargo)) {
    throw new Error("Locked Rust toolchain differs from the derived build evidence");
  }
  const toolchainText = `rustc:\n${toolchain.rustc.trim()}\n\ncargo:\n${toolchain.cargo.trim()}`;

  const expectedBinary = join(sourcePaths.candidateApp, "Contents", "Resources", "codex");
  const binaryPath = requireExactInternalFile(expectedBinary, "Frozen source-derived backend");
  if (!receipt.canary || receipt.canary.candidatePath !== binaryPath) {
    throw new Error("Derived canary is not bound to the frozen source-derived backend path");
  }
  const binarySha256 = sha256File(binaryPath);
  const candidateDigest = exactNamedSha256(receipt.candidateBinary.digests, "derived candidate binary", "Candidate binary");
  if (candidateDigest !== binarySha256 || receipt.canary.candidateSha256 !== binarySha256) {
    throw new Error("Frozen backend hash differs across the receipt, canary, and file");
  }
  const binaryVersion = deps.probeBinaryVersion(binaryPath);
  if (binaryVersion !== receipt.version || receipt.candidateBinary.version !== binaryVersion) {
    throw new Error("Frozen backend version differs from the derived receipt");
  }
  const architecture = deps.probeBinaryArchitecture(binaryPath);
  if (architecture !== "arm64" || receipt.candidateBinary.architecture !== architecture
    || receipt.candidateBinary.platform !== "darwin") {
    throw new Error("Frozen backend is not the exact arm64 macOS build recorded by the derived receipt");
  }

  const rustEvidence = assertRustEvidence(receipt.rustLifecycleTests, receipt, binarySha256);
  const canaryEvidenceBytes = assertCanaryEvidence(receipt, binaryPath, binarySha256);
  const owner = currentOwner(deps);
  return {
    receipt,
    receiptPath: exactReceipt,
    receiptSha256: sha256File(exactReceipt),
    transactionId,
    owner,
    upstream: { repository: CODEX_GIT_URL, tag, commit: receipt.source.checkoutCommit },
    source: {
      root: sourceRoot,
      treeSha256,
      patchSeriesSha256: receipt.source.patchSeriesDigest.value.toLowerCase(),
      reviewedDiffSha256,
      cargoLockPath,
      cargoLockSha256,
    },
    build: {
      command: CODEX_SOURCE_BUILD_COMMAND.join(" "),
      argv: CODEX_SOURCE_BUILD_COMMAND,
      toolchain: toolchainText,
      rustc: toolchain.rustc,
      cargo: toolchain.cargo,
      architecture: "arm64",
    },
    binary: {
      sourcePath: binaryPath,
      acceptedPath: paths.acceptedBinary,
      sha256: binarySha256,
      version: binaryVersion,
      architecture: "arm64",
    },
    rustEvidenceBytes: jsonBytes(rustEvidence),
    canaryEvidenceBytes,
  };
}

function assertRustEvidence(
  evidence: CodexRustLifecycleTestEvidence | undefined,
  receipt: CodexDerivedReceipt,
  binarySha256: string,
): CodexRustLifecycleTestEvidence {
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== "codex-rust-lifecycle-tests"
    || evidence.sourceCommit !== receipt.source.checkoutCommit
    || evidence.patchedTreeSha256 !== receipt.source.treeDigest.value
    || evidence.cargoLockSha256 !== exactNamedSha256(receipt.source.lockfileDigests, "Cargo.lock", "Cargo.lock")
    || JSON.stringify(evidence.command) !== JSON.stringify(CODEX_SOURCE_RUST_TEST_COMMAND)
    || evidence.exitCode !== 0 || evidence.candidateBinarySha256 !== binarySha256
    || !validTimestamp(evidence.startedAt) || !validTimestamp(evidence.completedAt)
    || Date.parse(evidence.startedAt) > Date.parse(evidence.completedAt)
    || REQUIRED_RUST_LIFECYCLE_TESTS.some((name) => !evidence.passedTests.includes(name))) {
    throw new Error("Derived receipt lacks complete successful Rust lifecycle test evidence");
  }
  const stdout = requireExactInternalFile(evidence.stdoutFile, "Rust test stdout receipt");
  const stderr = requireExactInternalFile(evidence.stderrFile, "Rust test stderr receipt");
  if (sha256File(stdout) !== evidence.stdoutSha256 || sha256File(stderr) !== evidence.stderrSha256) {
    throw new Error("Rust lifecycle test output changed after the derived build was frozen");
  }
  return evidence;
}

function assertCanaryEvidence(receipt: CodexDerivedReceipt, binaryPath: string, binarySha256: string): Buffer {
  const reference = receipt.canary;
  if (!reference) throw new Error("Derived receipt lacks managed MCP integration canary evidence");
  const sidecar = requireExactInternalFile(reference.sidecarPath, "Managed MCP integration canary receipt");
  const bytes = readFileSync(sidecar);
  if (sha256(bytes) !== reference.sidecarSha256) {
    throw new Error("Managed MCP integration canary receipt changed after freeze");
  }
  const value = parseJson(bytes, "Managed MCP integration canary receipt");
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "codex-source-canary-evidence"
    || value.transactionId !== receipt.transactionId || value.version !== receipt.version
    || value.candidatePath !== binaryPath || value.candidateSha256 !== binarySha256
    || typeof value.sourceFile !== "string" || typeof value.sourceSha256 !== "string") {
    throw new Error("Managed MCP integration canary is not bound to the derived build");
  }
  const sourceFile = requireExactInternalFile(value.sourceFile, "Managed MCP observed canary evidence");
  const sourceBytes = readFileSync(sourceFile);
  if (sha256(sourceBytes) !== value.sourceSha256) {
    throw new Error("Managed MCP observed canary evidence changed after validation");
  }
  const observed = parseJson(sourceBytes, "Managed MCP observed canary evidence");
  if (!isRecord(observed) || observed.schemaVersion !== 1 || observed.kind !== "managed-mcp-observed-canary"
    || observed.status !== "passed" || observed.transactionId !== receipt.transactionId
    || observed.version !== receipt.version || !isRecord(observed.candidate)
    || observed.candidate.path !== binaryPath || observed.candidate.sha256 !== binarySha256
    || !isRecord(observed.lifecycle) || Object.keys(observed.lifecycle).length === 0
    || Object.values(observed.lifecycle).some((entry) => entry !== true)
    || !validTimestamp(observed.startedAt) || !validTimestamp(observed.completedAt)
    || Date.parse(observed.startedAt) > Date.parse(observed.completedAt)) {
    throw new Error("Managed MCP integration canary does not prove every required gate passed");
  }
  return bytes;
}

function createReviewManifest(
  inspected: InspectedBuild,
  tests: readonly CodexBuildReviewTestReceipt[],
  reviewedAt: string,
): CodexBuildReviewManifest {
  return {
    schemaVersion: 1,
    kind: "tweakers-codex-build-review",
    transactionId: inspected.transactionId,
    reviewedAt,
    owner: inspected.owner,
    derivedReceipt: { path: inspected.receiptPath, sha256: inspected.receiptSha256 },
    upstream: inspected.upstream,
    source: inspected.source,
    build: inspected.build,
    tests,
    binary: inspected.binary,
  };
}

function reviewTestReceipts(paths: AttestationPaths, inspected: InspectedBuild): readonly CodexBuildReviewTestReceipt[] {
  return [
    {
      name: "codex Rust lifecycle tests",
      command: CODEX_SOURCE_RUST_TEST_COMMAND.join(" "),
      path: paths.rustEvidence,
      sha256: sha256File(paths.rustEvidence),
      status: "passed",
    },
    {
      name: "managed MCP integration canary",
      command: `tweaker codex-source canary-pass --transaction-id ${inspected.transactionId}`,
      path: paths.canaryEvidence,
      sha256: sha256File(paths.canaryEvidence),
      status: "passed",
    },
  ];
}

function createAcceptedReceipt(
  manifest: CodexBuildReviewManifest,
  acceptedAt: string,
): AcceptedPrebuiltCodexBuildReceipt {
  return {
    schemaVersion: 1,
    kind: "tweakers-prebuilt-codex-build",
    status: "accepted",
    acceptedAt,
    source: {
      commit: manifest.upstream.commit,
      tree: manifest.source.treeSha256,
      cargoLockSha256: manifest.source.cargoLockSha256,
      reviewedDiffSha256: manifest.source.reviewedDiffSha256,
    },
    build: {
      command: manifest.build.command,
      toolchain: manifest.build.toolchain,
      architecture: "arm64",
    },
    tests: manifest.tests.map((test) => ({
      name: test.name,
      command: test.command,
      receiptSha256: test.sha256,
      status: "passed" as const,
    })),
    binary: {
      path: manifest.binary.acceptedPath,
      sha256: manifest.binary.sha256,
      version: manifest.binary.version,
      architecture: "arm64",
    },
  };
}

function attestationPathsForReceipt(receiptPath: string, transactionId: string): AttestationPaths {
  requireTransactionId(transactionId);
  const exactReceipt = resolve(receiptPath);
  if (!isAbsolute(receiptPath) || exactReceipt !== receiptPath
    || basename(exactReceipt) !== `${transactionId}.json`
    || basename(dirname(exactReceipt)) !== "receipts"
    || basename(dirname(dirname(exactReceipt))) !== "codex-source") {
    throw new Error("Derived receipt must use the canonical codex-source receipt path for its transaction");
  }
  const userRoot = dirname(dirname(dirname(exactReceipt)));
  if (basename(userRoot) === "codex-plusplus") {
    throw new Error("New accepted-build authority cannot be issued from the archived codex-plusplus data root");
  }
  const transactionRoot = join(userRoot, "codex-source", "accepted", transactionId);
  const evidenceRoot = join(transactionRoot, "test-evidence");
  return {
    userRoot,
    transactionRoot,
    evidenceRoot,
    rustEvidence: join(evidenceRoot, "rust-lifecycle.json"),
    canaryEvidence: join(evidenceRoot, "managed-mcp-canary.json"),
    reviewManifest: join(transactionRoot, "review-manifest.json"),
    acceptedBinary: join(transactionRoot, "codex"),
    acceptedReceipt: join(transactionRoot, "accepted-build.json"),
    acceptanceRecord: join(transactionRoot, "acceptance.json"),
  };
}

function ensureOwnerPrivateDirectory(path: string, deps: CodexBuildAttestationDependencies): void {
  assertInternalStoragePath(path, "Build attestation directory");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`Build attestation directory must be a real canonical directory: ${path}`);
  }
  const uid = deps.effectiveUid();
  if (uid === null || status.uid !== uid) {
    throw new Error("Build attestation directory is not owned by the current release owner");
  }
  chmodSync(path, 0o700);
}

function currentOwner(deps: CodexBuildAttestationDependencies): CodexBuildReviewManifest["owner"] {
  const uid = deps.effectiveUid();
  const username = deps.username();
  if (uid === null || !Number.isSafeInteger(uid) || uid < 0 || !username || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error("Local release-owner identity is unavailable");
  }
  return { uid, username };
}

function assertOwnerPrivateFile(path: string, deps: CodexBuildAttestationDependencies, label: string): void {
  const status = lstatSync(path);
  const uid = deps.effectiveUid();
  if (!status.isFile() || status.isSymbolicLink() || uid === null || status.uid !== uid
    || (status.mode & 0o077) !== 0) {
    throw new Error(`${label} must be an owner-private regular file: ${path}`);
  }
}

function writeImmutableFile(
  path: string,
  bytes: Buffer,
  mode: number,
  deps: CodexBuildAttestationDependencies,
  faultLabel: string,
): void {
  assertInternalStoragePath(path, "Immutable build attestation artifact");
  if (existsSync(path)) {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Existing immutable artifact is not a regular file: ${path}`);
    }
    assertOwnerPrivateFile(path, deps, "Existing immutable artifact");
    if (!readFileSync(path).equals(bytes)) {
      throw new Error(`Refusing to overwrite an immutable artifact with different contents: ${path}`);
    }
    return;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, mode);
    deps.fault?.(`${faultLabel}:after-temp-fsync`);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!existsSync(path) || !readFileSync(path).equals(bytes)) throw error;
    }
    fsyncDirectory(dirname(path));
    assertOwnerPrivateFile(path, deps, "Published immutable artifact");
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best-effort cleanup after the primary failure */ }
    }
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function copyImmutableFile(
  source: string,
  destination: string,
  mode: number,
  deps: CodexBuildAttestationDependencies,
  faultLabel: string,
): void {
  const exactSource = requireExactInternalFile(source, "Reviewed backend source");
  if (existsSync(destination)) {
    requireExactInternalFile(destination, "Accepted backend");
    assertOwnerPrivateFile(destination, deps, "Existing accepted backend");
    if (sha256File(destination) !== sha256File(exactSource)) {
      throw new Error(`Refusing to overwrite an accepted backend with different contents: ${destination}`);
    }
    return;
  }
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  try {
    copyFileSync(exactSource, temporary, 1);
    chmodSync(temporary, mode);
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    deps.fault?.(`${faultLabel}:after-temp-fsync`);
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination) || sha256File(destination) !== sha256File(exactSource)) throw error;
    }
    fsyncDirectory(dirname(destination));
    assertOwnerPrivateFile(destination, deps, "Published accepted backend");
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readReviewManifest(path: string): CodexBuildReviewManifest {
  const value = readJsonFile(path, "Build review manifest");
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "tweakers-codex-build-review"
    || !TRANSACTION_ID_RE.test(String(value.transactionId)) || !validTimestamp(value.reviewedAt)
    || !isRecord(value.owner) || !Number.isSafeInteger(value.owner.uid) || typeof value.owner.username !== "string"
    || !isRecord(value.derivedReceipt) || typeof value.derivedReceipt.path !== "string"
    || !SHA256_RE.test(String(value.derivedReceipt.sha256))
    || !isRecord(value.upstream) || value.upstream.repository !== CODEX_GIT_URL
    || typeof value.upstream.tag !== "string" || typeof value.upstream.commit !== "string"
    || !isRecord(value.source) || !isRecord(value.build) || !Array.isArray(value.tests)
    || !isRecord(value.binary)) {
    throw new Error("Build review manifest schema is invalid");
  }
  return value as unknown as CodexBuildReviewManifest;
}

function readAcceptedReceipt(path: string): AcceptedPrebuiltCodexBuildReceipt {
  const value = readJsonFile(path, "Accepted-build receipt");
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "tweakers-prebuilt-codex-build"
    || value.status !== "accepted" || !validTimestamp(value.acceptedAt)
    || !isRecord(value.source) || !isRecord(value.build) || !Array.isArray(value.tests)
    || !isRecord(value.binary)) {
    throw new Error("Accepted-build receipt schema is invalid");
  }
  return value as unknown as AcceptedPrebuiltCodexBuildReceipt;
}

function existingAcceptedAt(path: string): string | null {
  if (!existsSync(path)) return null;
  return readAcceptedReceipt(requireExactInternalFile(path, "Existing accepted-build receipt")).acceptedAt;
}

function readJsonFile(path: string, label: string): unknown {
  const exact = requireExactInternalFile(path, label);
  const bytes = readFileSync(exact);
  if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) throw new Error(`${label} size is invalid`);
  return parseJson(bytes, label);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function requireExactInternalFile(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) throw new Error(`${label} path must be exact and absolute`);
  assertInternalStoragePath(exact, label);
  if (!existsSync(exact)) throw new Error(`${label} is missing at ${exact}`);
  const status = lstatSync(exact);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return exact;
}

function requireExactInternalDirectory(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) throw new Error(`${label} path must be exact and absolute`);
  assertInternalStoragePath(exact, label);
  if (!existsSync(exact)) throw new Error(`${label} is missing at ${exact}`);
  const status = lstatSync(exact);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return exact;
}

function exactNamedSha256(
  values: readonly { algorithm: "sha256" | "sha512"; value: string; scope: string }[],
  scope: string,
  label: string,
): string {
  const matches = values.filter((value) => value.algorithm === "sha256" && value.scope === scope);
  if (matches.length !== 1 || !SHA256_RE.test(matches[0]!.value.toLowerCase())) {
    throw new Error(`${label} evidence must contain one exact SHA-256 digest`);
  }
  return matches[0]!.value.toLowerCase();
}

function digestTrackedSource(sourceRoot: string, deps: CodexBuildAttestationDependencies): string {
  const files = deps.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], sourceRoot)
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(sourceRoot, file);
    const status = lstatSync(path);
    hash.update(file);
    hash.update("\0");
    if (status.isSymbolicLink() || status.isFile()) hash.update(readFileSync(path));
    else throw new Error(`Patched source contains unsupported tracked entry: ${relative(sourceRoot, path)}`);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function probeBinaryVersion(path: string): string {
  const output = execFileSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024,
  }).trim();
  const version = /^codex-cli (.+)$/.exec(output)?.[1];
  if (!version) throw new Error("Reviewed backend returned an invalid version");
  return version;
}

function probeBinaryArchitecture(path: string): PrebuiltCodexArchitecture | null {
  const result = spawnSync("/usr/bin/file", ["-b", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return result.status === 0 && /arm64|aarch64/i.test(result.stdout ?? "") ? "arm64" : null;
}

function parseAction(value: string): CodexBuildAttestationAction {
  if (value === "review" || value === "accept") return value;
  throw new Error("Codex build attestation action must be review or accept");
}

function requireOption(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Codex build attestation requires ${flag}`);
  return value;
}

function requireTransactionId(value: string): void {
  if (!TRANSACTION_ID_RE.test(value)) throw new Error("Codex build attestation transaction ID is invalid");
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_RE.test(value.toLowerCase())) throw new Error(`${label} is invalid`);
}

function requireTimestamp(value: string, label: string): void {
  if (!validTimestamp(value)) throw new Error(`${label} is invalid`);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function sha256Text(value: string): string {
  return sha256(Buffer.from(value));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

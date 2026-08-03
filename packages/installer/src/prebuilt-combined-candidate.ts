import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeveloperIdSignedBackup, verifySignature } from "./codesign.js";
import { fingerprintAppContents } from "./environment-profile.js";
import { assertInternalStoragePath } from "./internal-storage.js";
import { locateCodex } from "./platform.js";
import {
  readRuntimeFingerprintEvidence,
  RUNTIME_FINGERPRINT_FILE,
  type RuntimeTreeFingerprint,
} from "./runtime-fingerprint.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_OBJECT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TRANSACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_RECEIPT_BYTES = 64 * 1024;

export type PrebuiltCodexArchitecture = "arm64";
export type PrebuiltCombinedCandidateAction = "prepare" | "promote";

export interface PrebuiltCombinedCandidateInput {
  transactionId: string;
  binaryPath: string;
  expectedBinarySha256: string;
  expectedVersion: string;
  expectedArchitecture: PrebuiltCodexArchitecture;
  receiptPath: string;
  expectedReceiptSha256: string;
  expectedRuntimeFingerprint: string;
  expectedRuntimeFileCount: number;
  expectedRuntimeDocumentSha256: string;
  expectedSourceAppFingerprint: string;
  expectedBundleId: "com.openai.codex" | "com.openai.codex.beta";
}

export interface PrebuiltCombinedCandidateCliOptions {
  app?: string;
  transaction?: string;
  binary?: string;
  binarySha256?: string;
  "binary-sha256"?: string;
  codexVersion?: string;
  "codex-version"?: string;
  architecture?: string;
  receipt?: string;
  receiptSha256?: string;
  "receipt-sha256"?: string;
  runtimeFingerprint?: string;
  "runtime-fingerprint"?: string;
  runtimeFiles?: number | string;
  "runtime-files"?: number | string;
  runtimeDocumentSha256?: string;
  "runtime-document-sha256"?: string;
  sourceAppFingerprint?: string;
  "source-app-fingerprint"?: string;
  bundleId?: string;
  "bundle-id"?: string;
}

export interface AcceptedPrebuiltCodexBuildReceipt {
  schemaVersion: 1;
  kind: "tweakers-prebuilt-codex-build";
  status: "accepted";
  acceptedAt: string;
  source: {
    commit: string;
    tree: string;
    cargoLockSha256: string;
    reviewedDiffSha256: string;
  };
  build: {
    command: string;
    toolchain: string;
    architecture: PrebuiltCodexArchitecture;
  };
  tests: Array<{
    name: string;
    command: string;
    receiptSha256: string;
    status: "passed";
  }>;
  binary: {
    path: string;
    sha256: string;
    version: string;
    architecture: PrebuiltCodexArchitecture;
  };
}

export interface PrebuiltCombinedCandidateAuthority {
  schemaVersion: 1;
  transactionId: string;
  payloadIdentity: string;
  installerPayloadHash: string;
  acceptedBuildReceipt: {
    path: string;
    sha256: string;
    acceptedAt: string;
    sourceCommit: string;
    sourceTree: string;
    cargoLockSha256: string;
    reviewedDiffSha256: string;
    buildCommand: string;
    toolchain: string;
    testEvidence: Array<{
      name: string;
      command: string;
      receiptSha256: string;
    }>;
  };
  backend: {
    sourcePath: string;
    sha256: string;
    version: string;
    architecture: PrebuiltCodexArchitecture;
  };
  runtime: {
    sourceRoot: string;
    fingerprint: string;
    fileCount: number;
    documentSha256: string;
  };
  sourceApp: {
    path: string;
    bundleId: "com.openai.codex" | "com.openai.codex.beta";
    contentsFingerprint: string;
  };
}

export interface PrebuiltRollbackEvidence {
  lastKnownGoodAppFingerprint: string;
  lastKnownGoodRuntime: RuntimeTreeFingerprint;
  signedBackupFingerprint: string;
  signedBackupMarkerSha256: string;
}

export interface PreparedPrebuiltCombinedCandidateEvidence {
  candidateAppFingerprint: string;
  embeddedBackendSha256: string;
  embeddedBackendVersion: string;
  stagedRuntime: RuntimeTreeFingerprint;
  stagedRuntimeDocumentSha256: string;
  rollback: PrebuiltRollbackEvidence;
}

export interface PrebuiltCandidateEvidencePaths {
  candidateRoot: string;
  candidateRuntimeRoot: string;
  lastKnownGoodRoot: string;
  lastKnownGoodRuntimeRoot: string;
  signedBackupRoot: string;
  signedBackupMarker: string;
}

export interface PrebuiltCombinedCandidateValidationDependencies {
  fingerprintFile(path: string): string;
  probeVersion(path: string): string | null;
  probeArchitecture(path: string): PrebuiltCodexArchitecture | null;
  sourceAppFingerprint(path: string): string;
  sourceAppBundleId(path: string): string | null;
  runtimeEvidence(path: string): RuntimeTreeFingerprint | null;
  verifyCandidateApp(path: string): boolean;
  verifyLastKnownGoodApp(path: string): boolean;
  verifySignedBackup(path: string): boolean;
}

const defaultDependencies: PrebuiltCombinedCandidateValidationDependencies = {
  fingerprintFile: sha256RegularFile,
  probeVersion: probeCodexCliVersion,
  probeArchitecture: probeCodexArchitecture,
  sourceAppFingerprint: fingerprintAppContents,
  sourceAppBundleId: (path) => locateCodex(path).bundleId,
  runtimeEvidence: readRuntimeFingerprintEvidence,
  verifyCandidateApp: (path) => verifySignature(path).ok,
  verifyLastKnownGoodApp: (path) => verifySignature(path).ok,
  verifySignedBackup: isDeveloperIdSignedBackup,
};

export function resolvePrebuiltCombinedCandidateCliInput(
  action: string,
  options: PrebuiltCombinedCandidateCliOptions,
): {
  action: PrebuiltCombinedCandidateAction;
  app?: string;
  candidateOnly: boolean;
  input: PrebuiltCombinedCandidateInput;
} {
  if (action !== "prepare" && action !== "promote") {
    throw new Error("Prebuilt combined candidate action must be prepare or promote");
  }
  const runtimeFiles = Number(options.runtimeFiles ?? options["runtime-files"]);
  if (!Number.isSafeInteger(runtimeFiles) || runtimeFiles <= 0) {
    throw new Error("Prebuilt combined candidate runtime file count is invalid");
  }
  const architecture = options.architecture;
  if (architecture !== "arm64") {
    throw new Error("Prebuilt combined candidates require the arm64 architecture");
  }
  const bundleId = options.bundleId ?? options["bundle-id"];
  if (bundleId !== "com.openai.codex" && bundleId !== "com.openai.codex.beta") {
    throw new Error("Prebuilt combined candidate bundle ID is unsupported");
  }
  return {
    action,
    app: options.app,
    candidateOnly: action === "prepare",
    input: {
      transactionId: requireCliValue(options.transaction, "--transaction"),
      binaryPath: requireCliValue(options.binary, "--binary"),
      expectedBinarySha256: requireCliValue(
        options.binarySha256 ?? options["binary-sha256"],
        "--binary-sha256",
      ),
      expectedVersion: requireCliValue(
        options.codexVersion ?? options["codex-version"],
        "--codex-version",
      ),
      expectedArchitecture: architecture,
      receiptPath: requireCliValue(options.receipt, "--receipt"),
      expectedReceiptSha256: requireCliValue(
        options.receiptSha256 ?? options["receipt-sha256"],
        "--receipt-sha256",
      ),
      expectedRuntimeFingerprint: requireCliValue(
        options.runtimeFingerprint ?? options["runtime-fingerprint"],
        "--runtime-fingerprint",
      ),
      expectedRuntimeFileCount: runtimeFiles,
      expectedRuntimeDocumentSha256: requireCliValue(
        options.runtimeDocumentSha256 ?? options["runtime-document-sha256"],
        "--runtime-document-sha256",
      ),
      expectedSourceAppFingerprint: requireCliValue(
        options.sourceAppFingerprint ?? options["source-app-fingerprint"],
        "--source-app-fingerprint",
      ),
      expectedBundleId: bundleId,
    },
  };
}

export function validatePrebuiltCombinedCandidate(
  input: PrebuiltCombinedCandidateInput,
  context: {
    installerPayloadHash: string;
    runtimeRoot: string;
    sourceAppRoot: string;
    now?: Date;
  },
  dependencyOverrides: Partial<PrebuiltCombinedCandidateValidationDependencies> = {},
): PrebuiltCombinedCandidateAuthority {
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  requireTransactionId(input.transactionId);
  requireSha256(input.expectedBinarySha256, "Expected prebuilt binary SHA-256");
  requireSha256(input.expectedReceiptSha256, "Expected accepted-build receipt SHA-256");
  requireSha256(input.expectedRuntimeFingerprint, "Expected runtime fingerprint");
  requireSha256(input.expectedRuntimeDocumentSha256, "Expected runtime document SHA-256");
  requireSha256(input.expectedSourceAppFingerprint, "Expected source app fingerprint");
  requireSha256(context.installerPayloadHash, "Installer payload hash");
  if (!VERSION_RE.test(input.expectedVersion)) {
    throw new Error("Expected prebuilt Codex version is invalid");
  }
  if (input.expectedArchitecture !== "arm64") {
    throw new Error("Prebuilt combined candidates require the arm64 architecture");
  }
  if (!Number.isSafeInteger(input.expectedRuntimeFileCount) || input.expectedRuntimeFileCount <= 0) {
    throw new Error("Expected runtime file count is invalid");
  }

  const binaryPath = requireExactInternalFile(input.binaryPath, "Prebuilt Codex binary");
  const receiptPath = requireExactInternalFile(input.receiptPath, "Accepted-build receipt");
  const runtimeRoot = requireExactInternalDirectory(context.runtimeRoot, "Reviewed runtime");
  const sourceAppRoot = requireExactInternalDirectory(context.sourceAppRoot, "Source app");
  const receiptSha256 = deps.fingerprintFile(receiptPath);
  if (receiptSha256 !== input.expectedReceiptSha256.toLowerCase()) {
    throw new Error("Accepted-build receipt digest does not match the caller-recorded digest");
  }
  const receipt = readAcceptedBuildReceipt(receiptPath, context.now ?? new Date());
  if (receipt.binary.path !== binaryPath) {
    throw new Error("Accepted-build receipt binary path does not match the exact requested binary");
  }
  const binarySha256 = deps.fingerprintFile(binaryPath);
  if (
    binarySha256 !== input.expectedBinarySha256.toLowerCase()
    || receipt.binary.sha256 !== binarySha256
  ) {
    throw new Error("Prebuilt Codex binary digest does not match its accepted-build receipt");
  }
  const version = deps.probeVersion(binaryPath);
  if (version !== input.expectedVersion || receipt.binary.version !== version) {
    throw new Error("Prebuilt Codex binary version does not match its accepted-build receipt");
  }
  const architecture = deps.probeArchitecture(binaryPath);
  if (
    architecture !== input.expectedArchitecture
    || receipt.binary.architecture !== architecture
    || receipt.build.architecture !== architecture
  ) {
    throw new Error("Prebuilt Codex binary architecture does not match its accepted-build receipt");
  }

  const runtime = deps.runtimeEvidence(runtimeRoot);
  if (
    runtime === null
    || runtime.fingerprint !== input.expectedRuntimeFingerprint.toLowerCase()
    || runtime.fileCount !== input.expectedRuntimeFileCount
  ) {
    throw new Error("Reviewed runtime fingerprint or file count does not match the caller-recorded evidence");
  }
  const runtimeDocument = requireExactInternalFile(
    join(runtimeRoot, RUNTIME_FINGERPRINT_FILE),
    "Reviewed runtime fingerprint document",
  );
  const runtimeDocumentSha256 = deps.fingerprintFile(runtimeDocument);
  if (runtimeDocumentSha256 !== input.expectedRuntimeDocumentSha256.toLowerCase()) {
    throw new Error("Reviewed runtime fingerprint document digest does not match");
  }

  const sourceAppFingerprint = deps.sourceAppFingerprint(sourceAppRoot);
  if (sourceAppFingerprint !== input.expectedSourceAppFingerprint.toLowerCase()) {
    throw new Error("Source app fingerprint does not match the caller-recorded fingerprint");
  }
  const sourceBundleId = deps.sourceAppBundleId(sourceAppRoot);
  if (sourceBundleId !== input.expectedBundleId) {
    throw new Error("Source app bundle ID does not match the required identity");
  }

  const authorityWithoutIdentity: Omit<PrebuiltCombinedCandidateAuthority, "payloadIdentity"> = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    installerPayloadHash: context.installerPayloadHash.toLowerCase(),
    acceptedBuildReceipt: {
      path: receiptPath,
      sha256: receiptSha256,
      acceptedAt: receipt.acceptedAt,
      sourceCommit: receipt.source.commit,
      sourceTree: receipt.source.tree,
      cargoLockSha256: receipt.source.cargoLockSha256,
      reviewedDiffSha256: receipt.source.reviewedDiffSha256,
      buildCommand: receipt.build.command,
      toolchain: receipt.build.toolchain,
      testEvidence: receipt.tests.map(({ name, command, receiptSha256: digest }) => ({
        name,
        command,
        receiptSha256: digest,
      })),
    },
    backend: {
      sourcePath: binaryPath,
      sha256: binarySha256,
      version,
      architecture,
    },
    runtime: {
      sourceRoot: runtimeRoot,
      fingerprint: runtime.fingerprint,
      fileCount: runtime.fileCount,
      documentSha256: runtimeDocumentSha256,
    },
    sourceApp: {
      path: sourceAppRoot,
      bundleId: input.expectedBundleId,
      contentsFingerprint: sourceAppFingerprint,
    },
  };
  return {
    ...authorityWithoutIdentity,
    payloadIdentity: combinedPayloadIdentity(authorityWithoutIdentity),
  };
}

export function capturePreparedPrebuiltCombinedCandidateEvidence(
  authority: PrebuiltCombinedCandidateAuthority,
  paths: PrebuiltCandidateEvidencePaths,
  dependencyOverrides: Partial<PrebuiltCombinedCandidateValidationDependencies> = {},
): PreparedPrebuiltCombinedCandidateEvidence {
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  const candidateRoot = requireExactInternalDirectory(paths.candidateRoot, "Prepared candidate app");
  if (!deps.verifyCandidateApp(candidateRoot)) {
    throw new Error("Prepared candidate app failed strict signature verification");
  }
  if (deps.sourceAppBundleId(candidateRoot) !== authority.sourceApp.bundleId) {
    throw new Error("Prepared candidate app changed the required bundle ID");
  }
  const candidateAppFingerprint = deps.sourceAppFingerprint(candidateRoot);
  requireSha256(candidateAppFingerprint, "Prepared candidate app fingerprint");

  const embeddedBackend = requireExactInternalFile(
    join(candidateRoot, "Contents", "Resources", "codex"),
    "Prepared candidate backend",
  );
  const embeddedBackendSha256 = deps.fingerprintFile(embeddedBackend);
  const embeddedBackendVersion = deps.probeVersion(embeddedBackend);
  if (
    embeddedBackendSha256 !== authority.backend.sha256
    || embeddedBackendVersion !== authority.backend.version
    || deps.probeArchitecture(embeddedBackend) !== authority.backend.architecture
  ) {
    throw new Error("Prepared candidate backend does not match the accepted prebuilt backend");
  }

  const candidateRuntimeRoot = requireExactInternalDirectory(
    paths.candidateRuntimeRoot,
    "Prepared candidate runtime",
  );
  const stagedRuntime = deps.runtimeEvidence(candidateRuntimeRoot);
  if (
    stagedRuntime === null
    || stagedRuntime.fingerprint !== authority.runtime.fingerprint
    || stagedRuntime.fileCount !== authority.runtime.fileCount
  ) {
    throw new Error("Prepared candidate runtime does not match the reviewed runtime");
  }
  const stagedRuntimeDocumentSha256 = deps.fingerprintFile(requireExactInternalFile(
    join(candidateRuntimeRoot, RUNTIME_FINGERPRINT_FILE),
    "Prepared candidate runtime fingerprint document",
  ));
  if (stagedRuntimeDocumentSha256 !== authority.runtime.documentSha256) {
    throw new Error("Prepared candidate runtime document does not match the reviewed runtime");
  }

  return {
    candidateAppFingerprint,
    embeddedBackendSha256,
    embeddedBackendVersion,
    stagedRuntime,
    stagedRuntimeDocumentSha256,
    rollback: capturePrebuiltRollbackEvidence(paths, deps),
  };
}

export function assertPreparedPrebuiltCombinedCandidateEvidence(
  authority: PrebuiltCombinedCandidateAuthority,
  expected: PreparedPrebuiltCombinedCandidateEvidence,
  paths: PrebuiltCandidateEvidencePaths,
  dependencyOverrides: Partial<PrebuiltCombinedCandidateValidationDependencies> = {},
): void {
  const observed = capturePreparedPrebuiltCombinedCandidateEvidence(
    authority,
    paths,
    dependencyOverrides,
  );
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("Prepared combined candidate evidence drifted after preparation");
  }
}

export function capturePrebuiltRollbackEvidence(
  paths: Pick<
    PrebuiltCandidateEvidencePaths,
    "lastKnownGoodRoot" | "lastKnownGoodRuntimeRoot" | "signedBackupRoot" | "signedBackupMarker"
  >,
  dependencyOverrides: Partial<PrebuiltCombinedCandidateValidationDependencies> = {},
): PrebuiltRollbackEvidence {
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  const lastKnownGoodRoot = requireExactInternalDirectory(
    paths.lastKnownGoodRoot,
    "Last-known-good app",
  );
  if (!deps.verifyLastKnownGoodApp(lastKnownGoodRoot)) {
    throw new Error("Last-known-good app failed strict signature verification");
  }
  const lastKnownGoodAppFingerprint = deps.sourceAppFingerprint(lastKnownGoodRoot);
  requireSha256(lastKnownGoodAppFingerprint, "Last-known-good app fingerprint");

  const lastKnownGoodRuntimeRoot = requireExactInternalDirectory(
    paths.lastKnownGoodRuntimeRoot,
    "Last-known-good runtime",
  );
  const lastKnownGoodRuntime = deps.runtimeEvidence(lastKnownGoodRuntimeRoot);
  if (lastKnownGoodRuntime === null) {
    throw new Error("Last-known-good runtime fingerprint evidence is invalid");
  }

  const signedBackupRoot = requireExactInternalDirectory(
    paths.signedBackupRoot,
    "Last-known-good signed backup",
  );
  if (!deps.verifySignedBackup(signedBackupRoot)) {
    throw new Error("Last-known-good signed backup is not a valid Developer ID app");
  }
  const signedBackupFingerprint = deps.sourceAppFingerprint(signedBackupRoot);
  requireSha256(signedBackupFingerprint, "Last-known-good signed backup fingerprint");

  const marker = requireExactInternalFile(
    paths.signedBackupMarker,
    "Last-known-good signed backup marker",
  );
  const markerValue = JSON.parse(readFileSync(marker, "utf8")) as unknown;
  if (
    !plainRecord(markerValue)
    || !exactKeys(markerValue, ["schemaVersion", "existed"])
    || markerValue.schemaVersion !== 1
    || markerValue.existed !== true
  ) {
    throw new Error("Last-known-good signed backup marker is invalid");
  }
  return {
    lastKnownGoodAppFingerprint,
    lastKnownGoodRuntime,
    signedBackupFingerprint,
    signedBackupMarkerSha256: deps.fingerprintFile(marker),
  };
}

function readAcceptedBuildReceipt(
  receiptPath: string,
  now: Date,
): AcceptedPrebuiltCodexBuildReceipt {
  const status = lstatSync(receiptPath);
  if (status.size <= 0 || status.size > MAX_RECEIPT_BYTES) {
    throw new Error("Accepted-build receipt size is invalid");
  }
  const value = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
  if (!validAcceptedBuildReceipt(value)) {
    throw new Error("Accepted-build receipt schema or evidence is invalid");
  }
  const acceptedAt = Date.parse(value.acceptedAt);
  if (!Number.isFinite(acceptedAt) || acceptedAt > now.getTime()) {
    throw new Error("Accepted-build receipt timestamp is invalid");
  }
  return value;
}

function validAcceptedBuildReceipt(value: unknown): value is AcceptedPrebuiltCodexBuildReceipt {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "kind", "status", "acceptedAt", "source", "build", "tests", "binary",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "tweakers-prebuilt-codex-build"
    || value.status !== "accepted"
    || typeof value.acceptedAt !== "string"
    || !plainRecord(value.source)
    || !exactKeys(value.source, ["commit", "tree", "cargoLockSha256", "reviewedDiffSha256"])
    || typeof value.source.commit !== "string"
    || !GIT_OBJECT_RE.test(value.source.commit)
    || typeof value.source.tree !== "string"
    || !GIT_OBJECT_RE.test(value.source.tree)
    || typeof value.source.cargoLockSha256 !== "string"
    || !SHA256_RE.test(value.source.cargoLockSha256)
    || typeof value.source.reviewedDiffSha256 !== "string"
    || !SHA256_RE.test(value.source.reviewedDiffSha256)
    || !plainRecord(value.build)
    || !exactKeys(value.build, ["command", "toolchain", "architecture"])
    || !boundedText(value.build.command, 4_096)
    || !boundedText(value.build.toolchain, 1_024)
    || value.build.architecture !== "arm64"
    || !Array.isArray(value.tests)
    || value.tests.length === 0
    || value.tests.length > 64
    || !plainRecord(value.binary)
    || !exactKeys(value.binary, ["path", "sha256", "version", "architecture"])
    || typeof value.binary.path !== "string"
    || typeof value.binary.sha256 !== "string"
    || !SHA256_RE.test(value.binary.sha256)
    || typeof value.binary.version !== "string"
    || !VERSION_RE.test(value.binary.version)
    || value.binary.architecture !== "arm64"
  ) return false;
  return value.tests.every((entry) => (
    plainRecord(entry)
    && exactKeys(entry, ["name", "command", "receiptSha256", "status"])
    && boundedText(entry.name, 256)
    && boundedText(entry.command, 4_096)
    && typeof entry.receiptSha256 === "string"
    && SHA256_RE.test(entry.receiptSha256)
    && entry.status === "passed"
  ));
}

function combinedPayloadIdentity(
  authority: Omit<PrebuiltCombinedCandidateAuthority, "payloadIdentity">,
): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: authority.schemaVersion,
    transactionId: authority.transactionId,
    installerPayloadHash: authority.installerPayloadHash,
    acceptedBuildReceipt: authority.acceptedBuildReceipt,
    backend: authority.backend,
    runtime: authority.runtime,
    sourceApp: authority.sourceApp,
  })).digest("hex");
}

function requireCliValue(value: string | undefined, flag: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Prebuilt combined candidate requires ${flag}`);
  }
  return value;
}

function requireTransactionId(value: string): void {
  if (!TRANSACTION_ID_RE.test(value)) {
    throw new Error("Prebuilt combined candidate transaction ID is invalid");
  }
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_RE.test(value.toLowerCase())) {
    throw new Error(`${label} is invalid`);
  }
}

function requireExactInternalFile(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) {
    throw new Error(`${label} path must be exact and absolute`);
  }
  assertInternalStoragePath(exact, label);
  if (!existsSync(exact)) throw new Error(`${label} is missing at ${exact}`);
  const status = lstatSync(exact);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return exact;
}

function requireExactInternalDirectory(path: string, label: string): string {
  const exact = resolve(path);
  if (!isAbsolute(path) || exact !== path) {
    throw new Error(`${label} path must be exact and absolute`);
  }
  assertInternalStoragePath(exact, label);
  if (!existsSync(exact)) throw new Error(`${label} is missing at ${exact}`);
  const status = lstatSync(exact);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return exact;
}

function sha256RegularFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probeCodexCliVersion(path: string): string | null {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\s+/).at(-1) ?? null;
}

function probeCodexArchitecture(path: string): PrebuiltCodexArchitecture | null {
  const result = spawnSync("/usr/bin/file", ["-b", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return result.status === 0 && /arm64|aarch64/i.test(result.stdout ?? "") ? "arm64" : null;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

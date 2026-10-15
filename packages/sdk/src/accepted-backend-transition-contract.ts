/** Pure serialized contract shared by the installer and runtime initialization gate. */
export interface AcceptedTransitionSignatureV1 {
  identity: string;
  teamIdentifier: string | null;
  designatedRequirement: string | null;
}

export interface PrebuiltCombinedCandidateAuthorityV1 {
  schemaVersion: 1;
  transactionId: string;
  payloadIdentity: string;
  installerPayloadHash: string;
  acceptedBuildReceipt: {
    path: string; sha256: string; acceptedAt: string; sourceCommit: string; sourceTree: string;
    cargoLockSha256: string; reviewedDiffSha256: string; patchSeriesSha256: string;
    upstream: { repository: "https://github.com/openai/codex.git"; tag: string; commit: string };
    verification: { level: "source-verified" | "isolated-canary"; installedAcceptance: "required" };
    buildCommand: string; toolchain: string;
    testEvidence: Array<{ name: string; command: string; receiptSha256: string }>;
  };
  backend: { sourcePath: string; sha256: string; version: string; architecture: "arm64"; signature: AcceptedTransitionSignatureV1 };
  closure: {
    codeModeHost: { path: string; sha256: string; architecture: "arm64"; signature: AcceptedTransitionSignatureV1 };
    resources: readonly { relativePath: string; sourcePath: string; sha256: string }[];
  };
  runtime: { sourceRoot: string; fingerprint: string; fileCount: number; documentSha256: string };
  sourceApp: { path: string; bundleId: "com.openai.codex" | "com.openai.codex.beta"; contentsFingerprint: string };
}

export interface AcceptedSharedNativeBackendTransitionLaneV1 {
  version: 1;
  identity: { target: string; userRoot: string; brokerRoot: string };
  authority: PrebuiltCombinedCandidateAuthorityV1;
  priorRegistrationFingerprint: `sha256:${string}`;
  priorResolverBinarySha256: string;
}

/** Supplied native bytes have vendor provenance, never a local build receipt. */
export interface OfficialBundledCandidateAuthorityV2 {
  schemaVersion: 2;
  kind: "official-bundled";
  transactionId: string;
  payloadIdentity: string;
  installerPayloadHash: string;
  backend: { sourcePath: string; sha256: string; version: string; architecture: "arm64"; certificateSha1: string };
  closure: {
    kind: "official-bundled"; sourceAppRoot: string;
    resourceRelativePath: "Contents/Resources/codex-cli";
    resourceTree: { sha256: string; entries: number; bytes: string };
    backend: { relativePath: "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"; sha256: string; certificateSha1: string };
    codeModeHost: { relativePath: "Contents/Resources/codex-cli/bin/codex-code-mode-host"; sha256: string; certificateSha1: string };
  };
  nativePackage: { relativePath: "Contents/Resources/codex-cli/codex-package.json"; sha256: string; layoutVersion: 1; version: string; target: "aarch64-apple-darwin" };
  runtime: { sourceRoot: string; fingerprint: string; fileCount: number; documentSha256: string; adapterVersion: "official-bundled-adapter-v1" };
  sourceApp: { path: string; bundleId: "com.openai.codex" | "com.openai.codex.beta"; contentsFingerprint: string; treeSeal: { sha256: string; entries: number; bytes: string } };
}
export interface AcceptedSharedNativeBackendTransitionLaneV2 {
  version: 2;
  resolverProtocol: "official-bundled-v1";
  identity: AcceptedSharedNativeBackendTransitionLaneV1["identity"];
  authority: OfficialBundledCandidateAuthorityV2;
  priorRegistrationFingerprint: `sha256:${string}`;
  priorResolverBinarySha256: string;
}
export type AcceptedSharedNativeBackendTransitionLane = AcceptedSharedNativeBackendTransitionLaneV1 | AcceptedSharedNativeBackendTransitionLaneV2;
export interface AcceptedBackendTransitionJournalBinding {
  lane: AcceptedSharedNativeBackendTransitionLane;
  operationId: string;
}

export interface AcceptedBackendTransitionJournalBindingV1 {
  lane: AcceptedSharedNativeBackendTransitionLaneV1;
  operationId: string;
}

export interface AcceptedBackendTransitionContractDependencies {
  isCanonicalAbsolutePath(path: string): boolean;
  sha256(text: string): string;
}

/** Keep the producer's property order: existing signed payload identities depend on it. */
export function acceptedCombinedPayloadText(
  authority: Omit<PrebuiltCombinedCandidateAuthorityV1, "payloadIdentity">,
): string {
  return JSON.stringify({
    schemaVersion: authority.schemaVersion,
    transactionId: authority.transactionId,
    installerPayloadHash: authority.installerPayloadHash,
    acceptedBuildReceipt: authority.acceptedBuildReceipt,
    backend: authority.backend,
    closure: authority.closure,
    runtime: authority.runtime,
    sourceApp: authority.sourceApp,
  });
}

export function acceptedOfficialBundledPayloadText(authority: Omit<OfficialBundledCandidateAuthorityV2, "payloadIdentity">): string {
  return JSON.stringify({ schemaVersion: authority.schemaVersion, kind: authority.kind, transactionId: authority.transactionId,
    installerPayloadHash: authority.installerPayloadHash, backend: authority.backend, closure: authority.closure,
    nativePackage: authority.nativePackage, runtime: authority.runtime, sourceApp: authority.sourceApp });
}

type RecordValue = Record<string, unknown>;
function requireContract(condition: unknown): asserts condition {
  if (!condition) throw new Error("Accepted backend transition contract is invalid");
}
function object(value: unknown, keys: readonly string[]): RecordValue {
  requireContract(value !== null && typeof value === "object" && !Array.isArray(value));
  requireContract(Object.keys(value).sort().join(",") === [...keys].sort().join(","));
  return value as RecordValue;
}
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function gitObject(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
function path(value: unknown, deps: AcceptedBackendTransitionContractDependencies): void {
  requireContract(text(value, 4096) && deps.isCanonicalAbsolutePath(value));
}
function signature(value: unknown): void {
  const s = object(value, ["identity", "teamIdentifier", "designatedRequirement"]);
  requireContract(text(s.identity, 1024)
    && (s.teamIdentifier === null || text(s.teamIdentifier, 256))
    && (s.designatedRequirement === null || text(s.designatedRequirement, 4096)));
}

export function assertAcceptedSharedNativeBackendTransitionContract(
  value: unknown,
  deps: AcceptedBackendTransitionContractDependencies,
): asserts value is AcceptedSharedNativeBackendTransitionLane {
  if (value !== null && typeof value === "object" && (value as RecordValue).version === 2) {
    assertOfficialBundledLane(value, deps); return;
  }
  const lane = object(value, ["version", "identity", "authority", "priorRegistrationFingerprint", "priorResolverBinarySha256"]);
  requireContract(lane.version === 1 && typeof lane.priorRegistrationFingerprint === "string"
    && /^sha256:[a-f0-9]{64}$/.test(lane.priorRegistrationFingerprint) && hash(lane.priorResolverBinarySha256));
  const identity = object(lane.identity, ["target", "userRoot", "brokerRoot"]);
  for (const p of Object.values(identity)) path(p, deps);
  const authority = object(lane.authority, ["schemaVersion", "transactionId", "payloadIdentity", "installerPayloadHash", "acceptedBuildReceipt", "backend", "closure", "runtime", "sourceApp"]);
  requireContract(authority.schemaVersion === 1 && typeof authority.transactionId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.transactionId)
    && hash(authority.payloadIdentity) && hash(authority.installerPayloadHash));
  const receipt = object(authority.acceptedBuildReceipt, ["path", "sha256", "acceptedAt", "sourceCommit", "sourceTree", "cargoLockSha256", "reviewedDiffSha256", "upstream", "patchSeriesSha256", "verification", "buildCommand", "toolchain", "testEvidence"]);
  path(receipt.path, deps);
  requireContract(hash(receipt.sha256) && typeof receipt.acceptedAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(receipt.acceptedAt)
    && Number.isFinite(Date.parse(receipt.acceptedAt)) && gitObject(receipt.sourceCommit) && gitObject(receipt.sourceTree)
    && hash(receipt.cargoLockSha256) && hash(receipt.reviewedDiffSha256) && hash(receipt.patchSeriesSha256)
    && text(receipt.buildCommand, 4096) && text(receipt.toolchain, 1024));
  const upstream = object(receipt.upstream, ["repository", "tag", "commit"]);
  requireContract(upstream.repository === "https://github.com/openai/codex.git" && upstream.commit === receipt.sourceCommit);
  const verification = object(receipt.verification, ["level", "installedAcceptance"]);
  requireContract((verification.level === "source-verified" || verification.level === "isolated-canary")
    && verification.installedAcceptance === "required");
  requireContract(Array.isArray(receipt.testEvidence) && receipt.testEvidence.length > 0 && receipt.testEvidence.length <= 64);
  for (const test of receipt.testEvidence) {
    const t = object(test, ["name", "command", "receiptSha256"]);
    requireContract(text(t.name, 256) && text(t.command, 4096) && hash(t.receiptSha256));
  }
  const backend = object(authority.backend, ["sourcePath", "sha256", "version", "architecture", "signature"]);
  path(backend.sourcePath, deps);
  requireContract(hash(backend.sha256) && backend.sha256 !== lane.priorResolverBinarySha256 && backend.architecture === "arm64"
    && typeof backend.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(backend.version)
    && upstream.tag === `rust-v${backend.version}`);
  signature(backend.signature);
  const closure = object(authority.closure, ["codeModeHost", "resources"]);
  const helper = object(closure.codeModeHost, ["path", "sha256", "architecture", "signature"]);
  path(helper.path, deps);requireContract(hash(helper.sha256) && helper.architecture === "arm64");signature(helper.signature);
  requireContract(Array.isArray(closure.resources) && closure.resources.length <= 1024);
  const resourcePaths = new Set<string>();
  for (const resource of closure.resources) {
    const r = object(resource, ["relativePath", "sourcePath", "sha256"]);
    requireContract(text(r.relativePath, 4096) && !r.relativePath.includes("\\")
      && r.relativePath.split("/").every(part => part !== "" && part !== "." && part !== "..")
      && !["codex", "codex-code-mode-host", "app.asar", "tweakers"].includes(r.relativePath.split("/")[0]!)
      && !resourcePaths.has(r.relativePath) && hash(r.sha256));
    resourcePaths.add(r.relativePath);path(r.sourcePath, deps);
  }
  const runtime = object(authority.runtime, ["sourceRoot", "fingerprint", "fileCount", "documentSha256"]);
  path(runtime.sourceRoot, deps);
  requireContract(hash(runtime.fingerprint) && hash(runtime.documentSha256) && Number.isSafeInteger(runtime.fileCount) && Number(runtime.fileCount) > 0);
  const sourceApp = object(authority.sourceApp, ["path", "bundleId", "contentsFingerprint"]);
  path(sourceApp.path, deps);
  requireContract((sourceApp.bundleId === "com.openai.codex" || sourceApp.bundleId === "com.openai.codex.beta") && hash(sourceApp.contentsFingerprint));
  requireContract(deps.sha256(acceptedCombinedPayloadText(authority as unknown as PrebuiltCombinedCandidateAuthorityV1)) === authority.payloadIdentity);
}

export function assertAcceptedBackendTransitionJournalBindingContract(
  value: unknown,
  deps: AcceptedBackendTransitionContractDependencies,
): asserts value is AcceptedBackendTransitionJournalBinding {
  const binding = object(value, ["lane", "operationId"]);
  requireContract(typeof binding.operationId === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(binding.operationId));
  assertAcceptedSharedNativeBackendTransitionContract(binding.lane, deps);
}

function treeSeal(value: unknown): void {
  const seal = object(value, ["sha256", "entries", "bytes"]);
  requireContract(hash(seal.sha256) && Number.isSafeInteger(seal.entries) && Number(seal.entries) > 0
    && typeof seal.bytes === "string" && /^\d+$/.test(seal.bytes));
}
function assertOfficialBundledLane(value: unknown, deps: AcceptedBackendTransitionContractDependencies): void {
  const lane = object(value, ["version", "resolverProtocol", "identity", "authority", "priorRegistrationFingerprint", "priorResolverBinarySha256"]);
  requireContract(lane.version === 2 && lane.resolverProtocol === "official-bundled-v1"
    && typeof lane.priorRegistrationFingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(lane.priorRegistrationFingerprint)
    && hash(lane.priorResolverBinarySha256));
  const identity = object(lane.identity, ["target", "userRoot", "brokerRoot"]);
  for (const p of Object.values(identity)) path(p, deps);
  const a = object(lane.authority, ["schemaVersion", "kind", "transactionId", "payloadIdentity", "installerPayloadHash", "backend", "closure", "nativePackage", "runtime", "sourceApp"]);
  requireContract(a.schemaVersion === 2 && a.kind === "official-bundled" && typeof a.transactionId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.transactionId) && hash(a.payloadIdentity) && hash(a.installerPayloadHash));
  const source = object(a.sourceApp, ["path", "bundleId", "contentsFingerprint", "treeSeal"]);
  path(source.path, deps); treeSeal(source.treeSeal);
  requireContract((source.bundleId === "com.openai.codex" || source.bundleId === "com.openai.codex.beta") && hash(source.contentsFingerprint));
  const backend = object(a.backend, ["sourcePath", "sha256", "version", "architecture", "certificateSha1"]);
  path(backend.sourcePath, deps);
  requireContract(hash(backend.sha256) && backend.architecture === "arm64"
    && typeof backend.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(backend.version)
    && typeof backend.certificateSha1 === "string" && /^[A-F0-9]{40}$/.test(backend.certificateSha1));
  const closure = object(a.closure, ["kind", "sourceAppRoot", "resourceRelativePath", "resourceTree", "backend", "codeModeHost"]);
  requireContract(closure.kind === "official-bundled" && closure.sourceAppRoot === source.path && closure.resourceRelativePath === "Contents/Resources/codex-cli");
  treeSeal(closure.resourceTree);
  const native = object(closure.backend, ["relativePath", "sha256", "certificateSha1"]);
  const helper = object(closure.codeModeHost, ["relativePath", "sha256", "certificateSha1"]);
  requireContract(native.relativePath === "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
    && helper.relativePath === "Contents/Resources/codex-cli/bin/codex-code-mode-host"
    && native.sha256 === backend.sha256 && native.certificateSha1 === backend.certificateSha1
    && backend.sourcePath === `${source.path}/${native.relativePath}`);
  for (const binding of [native, helper]) requireContract(hash(binding.sha256) && typeof binding.certificateSha1 === "string" && /^[A-F0-9]{40}$/.test(binding.certificateSha1));
  const pkg = object(a.nativePackage, ["relativePath", "sha256", "layoutVersion", "version", "target"]);
  requireContract(pkg.relativePath === "Contents/Resources/codex-cli/codex-package.json" && hash(pkg.sha256)
    && pkg.layoutVersion === 1 && pkg.version === backend.version && pkg.target === "aarch64-apple-darwin");
  const runtime = object(a.runtime, ["sourceRoot", "fingerprint", "fileCount", "documentSha256", "adapterVersion"]);
  path(runtime.sourceRoot, deps);
  requireContract(hash(runtime.fingerprint) && hash(runtime.documentSha256) && Number.isSafeInteger(runtime.fileCount)
    && Number(runtime.fileCount) > 0 && runtime.adapterVersion === "official-bundled-adapter-v1");
  requireContract(deps.sha256(acceptedOfficialBundledPayloadText(a as unknown as OfficialBundledCandidateAuthorityV2)) === a.payloadIdentity);
}

import { createHash } from "node:crypto";
import { assertAcceptedSharedNativeBackendTransitionContract, acceptedOfficialBundledPayloadText,
  type OfficialBundledCandidateAuthorityV2, type AcceptedSharedNativeBackendTransitionLaneV2 } from "@therealityreport/tweakers-sdk";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertAcceptedBackendClosure,
  readAcceptedBuildReceipt,
  validatePrebuiltCombinedCandidate,
  type PrebuiltCombinedCandidateAuthority,
  type PrebuiltCombinedCandidateInput,
} from "./prebuilt-combined-candidate.js";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";
import { assertAcceptedAccountsRecoveryRuntime } from "./accounts-transfer-compatibility.js";
import { packagedRuntimeAssetsRoot } from "./commands/install.js";
import { captureOfficialBundledBackendClosure, assertOfficialBundledBackendClosure, NATIVE_CODEX_BACKEND,
  NATIVE_CODEX_CLI_ROOT, type NativeBundledBackendSignaturePort } from "./native-bundled-backend.js";
import { sealOfficialSourceTree } from "./official-source-registration.js";
import { fingerprintAppContents } from "./environment-profile.js";
import { readPlist } from "./plist.js";
import { assertOpenAIDeveloperIdSourceTrust, signatureInfo, verifySignature } from "./codesign.js";

export class ForwardBackendTransitionRecoveryRequired extends Error {
  readonly code = "TWEAKERS_BACKEND_TRANSITION_FORWARD_RECOVERY_REQUIRED";
  constructor(readonly journalPath: string, cause?: unknown) {
    super(`Accepted backend transition requires forward recovery at ${journalPath}`, { cause });
  }
}

export interface AcceptedBackendTransitionJournalBindingV1 {
  lane: AcceptedSharedNativeBackendTransitionLaneV1;
  operationId: string;
}
export type { AcceptedSharedNativeBackendTransitionLaneV2, OfficialBundledCandidateAuthorityV2 };
export type AcceptedSharedNativeBackendTransitionLane = AcceptedSharedNativeBackendTransitionLaneV1 | AcceptedSharedNativeBackendTransitionLaneV2;
export interface AcceptedBackendTransitionJournalBinding { lane: AcceptedSharedNativeBackendTransitionLane; operationId: string }

interface BackendTransitionIntentV1 {
  version: 1; journalPath: string; preparedJournalBytes: string; preparedJournalSha256: string;
  plan: unknown; planFingerprint: string;
}

/** The immutable prepared journal is the binding signed by the existing resolver CAS. */
export class AcceptedBackendTransitionJournal {
  readonly #root: string;
  constructor(readonly input: { journalPath: string; buildRoot: string; promotionId: string;
    binding: AcceptedBackendTransitionJournalBinding; port?: SharedNativeBackendTransitionPort; beforePhase?: () => void;
    nativeSignatures?: NativeBundledBackendSignaturePort }) {
    this.#root = join(input.buildRoot, "accepted-backend-transition");
    assertAcceptedSharedNativeBackendTransitionShape(input.binding.lane);
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.binding.operationId)) throw new Error("Backend transition requires its exact manager operation");
  }
  private port(): SharedNativeBackendTransitionPort { return this.input.port ?? sharedNativeBackendTransitionPort(); }
  private intent(): BackendTransitionIntentV1 {
    const intent = JSON.parse(readPrivateFile(join(this.#root, "intent.json")).toString("utf8")) as BackendTransitionIntentV1;
    if (Object.keys(intent).sort().join(",") !== "journalPath,plan,planFingerprint,preparedJournalBytes,preparedJournalSha256,version"
      || intent.version !== 1 || intent.journalPath !== this.input.journalPath
      || typeof intent.preparedJournalBytes !== "string" || digest(intent.preparedJournalBytes) !== intent.preparedJournalSha256
      || !/^sha256:[a-f0-9]{64}$/.test(intent.planFingerprint)) throw new Error("Backend transition immutable intent changed");
    const prepared = JSON.parse(intent.preparedJournalBytes);
    const current = JSON.parse(readPrivateFile(this.input.journalPath).toString("utf8"));
    if (prepared.phase !== "prepared" || prepared.id !== this.input.promotionId || prepared.buildRoot !== this.input.buildRoot
      || prepared.target !== this.input.binding.lane.identity.target || prepared.userRoot !== this.input.binding.lane.identity.userRoot
      || !isDeepStrictEqual(prepared.acceptedBackendTransition, this.input.binding)
      || !isDeepStrictEqual(prepared, { ...current, phase: "prepared" })) throw new Error("Backend transition journal closure changed");
    assertOfficialTransitionPlanProtocol(this.input.binding.lane, intent.plan);
    return intent;
  }
  prepare(): void {
    assertAcceptedSharedNativeBackendTransitionPrior(this.input.binding.lane, this.port());
    const bytes = readPrivateFile(this.input.journalPath).toString("utf8");
    const journal = JSON.parse(bytes);
    const app = journal.entries.find((entry: {name: string}) => entry.name === "app");
    const runtime = journal.entries.find((entry: {name: string}) => entry.name === "runtime");
    if (!app || !runtime || journal.phase !== "prepared") throw new Error("Backend transition lacks prepared artifact identities");
    assertAcceptedSharedNativeBackendTransitionClosure(this.input.binding.lane, app.source, runtime.source, this.input.nativeSignatures);
    const preparedJournalSha256 = digest(bytes);
    const result = this.port().prepareSharedNativeResolverTransitionAtRootV1({ stateRoot: this.input.binding.lane.identity.brokerRoot,
      expectedRegistrationFingerprint: this.input.binding.lane.priorRegistrationFingerprint,
      resolverBinarySha256: this.input.binding.lane.authority.backend.sha256,
      ...(this.input.binding.lane.version === 2 ? { resolverProtocol: this.input.binding.lane.resolverProtocol } : {}),
      repairBinding: { operationId: this.input.binding.operationId, promotionId: this.input.promotionId,
        journalSha256: preparedJournalSha256, priorRepairFingerprint: null,
        appFingerprintSha256: app.desired.sha256, runtimeFingerprintSha256: runtime.desired.sha256 } });
    if (result.state !== "prepared" || !result.plan || !result.fingerprint) throw new Error(`Backend transition plan refused: ${result.reason ?? result.state}`);
    assertOfficialTransitionPlanProtocol(this.input.binding.lane, result.plan);
    const intent: BackendTransitionIntentV1 = {version: 1, journalPath: this.input.journalPath, preparedJournalBytes: bytes,
      preparedJournalSha256, plan: result.plan, planFingerprint: result.fingerprint};
    mkdirSync(this.#root, { mode: 0o700 });
    if (realpathSync(this.#root) !== this.#root) throw new Error("Backend transition intent directory is linked");
    writeImmutablePrivateFile(join(this.#root, "intent.json"), `${JSON.stringify(intent)}\n`);
    this.execute("validate");
  }
  execute(action: "validate" | "begin"): void {
    if (action !== "validate" && action !== "begin") throw new Error("Publication and finish require promoted closure verification");
    this.executePhase(action);
  }
  private executePhase(action: "validate" | "begin" | "publish" | "finish", promoted?: {appRoot: string; runtimeRoot: string}): void {
    const intent = this.intent();
    this.input.beforePhase?.();
    if (action !== "validate" && this.input.binding.lane.version === 2) {
      const journal = JSON.parse(intent.preparedJournalBytes);
      if (action !== "begin" && !promoted) throw new Error("Official backend transition requires promoted closure identities");
      assertAcceptedSharedNativeBackendTransitionClosure(this.input.binding.lane,
        promoted?.appRoot ?? journal.entries.find((entry: {name: string}) => entry.name === "app").source,
        promoted?.runtimeRoot ?? journal.entries.find((entry: {name: string}) => entry.name === "runtime").source, this.input.nativeSignatures);
    }
    const result = this.port().executeSharedNativeResolverTransitionAtRootV1({stateRoot: this.input.binding.lane.identity.brokerRoot,
      plan: intent.plan, expectedPlanFingerprint: intent.planFingerprint, action});
    const expected = {validate: "validated", begin: "begun", publish: "published", finish: "finished"}[action];
    const app = JSON.parse(intent.preparedJournalBytes).entries.find((entry: {name: string}) => entry.name === "app");
    const runtime = JSON.parse(intent.preparedJournalBytes).entries.find((entry: {name: string}) => entry.name === "runtime");
    if (result.state !== expected || result.priorFingerprint !== this.input.binding.lane.priorRegistrationFingerprint
      || result.priorResolverBinarySha256 !== this.input.binding.lane.priorResolverBinarySha256
      || result.resolverBinarySha256 !== this.input.binding.lane.authority.backend.sha256
      || !isDeepStrictEqual(result.binding, {operationId: this.input.binding.operationId, promotionId: this.input.promotionId,
        journalSha256: intent.preparedJournalSha256, priorRepairFingerprint: null,
        appFingerprintSha256: app.desired.sha256, runtimeFingerprintSha256: runtime.desired.sha256})) {
      throw new Error(`Backend transition ${action} refused: ${result.reason ?? "binding changed"}`);
    }
    if (action === "begin" && !existsSync(join(this.#root, "begun"))) writeImmutablePrivateFile(join(this.#root, "begun"), `${intent.planFingerprint}\n`);
  }
  assertRollbackAllowed(): void {
    const transition = join(this.input.binding.lane.identity.brokerRoot, "shared-native-mode-transition.v1.json");
    if (existsSync(join(this.#root, "begun")) || existsSync(transition)) throw new ForwardBackendTransitionRecoveryRequired(this.input.journalPath);
    try { assertAcceptedSharedNativeBackendTransitionPrior(this.input.binding.lane, this.port()); }
    catch (error) { throw new ForwardBackendTransitionRecoveryRequired(this.input.journalPath, error); }
  }
  finishPromoted(appRoot: string, runtimeRoot: string): void {
    this.intent();
    assertAcceptedSharedNativeBackendTransitionClosure(this.input.binding.lane, appRoot, runtimeRoot, this.input.nativeSignatures);
    this.executePhase("publish", {appRoot, runtimeRoot});
    // Recheck all promoted components and immutable journal after publication, before launch admission is reopened.
    assertAcceptedSharedNativeBackendTransitionClosure(this.input.binding.lane, appRoot, runtimeRoot, this.input.nativeSignatures);
    this.executePhase("finish", {appRoot, runtimeRoot});
  }
  assertCommitReady(appRoot: string, runtimeRoot: string): void {
    this.intent();
    assertAcceptedSharedNativeBackendTransitionClosure(this.input.binding.lane, appRoot, runtimeRoot, this.input.nativeSignatures);
    this.executePhase("finish", {appRoot, runtimeRoot});
  }
}

function digest(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
function assertOfficialTransitionPlanProtocol(lane: AcceptedSharedNativeBackendTransitionLane, plan: unknown): void {
  if (lane.version !== 2) return;
  const value = plan as {document?: {resolverProtocol?: unknown; resolverBinarySha256?: unknown}} | null;
  if (value?.document?.resolverProtocol !== lane.resolverProtocol || value.document.resolverBinarySha256 !== lane.authority.backend.sha256) {
    throw new Error("Official backend transition plan did not bind the explicit resolver protocol and bytes");
  }
}
function readPrivateFile(path: string): Buffer {
  if (realpathSync(path) !== resolve(path)) throw new Error("Backend transition evidence path is linked");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const a = fstatSync(fd);
    if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o077) !== 0) throw new Error("Backend transition evidence is not owner-private");
    const bytes = readFileSync(fd), b = fstatSync(fd), c = lstatSync(path);
    if (a.ino !== b.ino || a.dev !== b.dev || a.ctimeMs !== b.ctimeMs || a.mtimeMs !== b.mtimeMs || a.size !== b.size
      || a.ino !== c.ino || a.dev !== c.dev || c.isSymbolicLink()) throw new Error("Backend transition evidence changed during read");
    return bytes;
  } finally { closeSync(fd); }
}
function writeImmutablePrivateFile(path: string, bytes: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(resolve(path, ".."), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export interface AcceptedSharedNativeBackendTransitionRequestV1 {
  version: 1;
  prebuilt: PrebuiltCombinedCandidateInput;
  priorRegistrationFingerprint: `sha256:${string}`;
  priorResolverBinarySha256: string;
}

export interface OfficialBundledCandidateInputV2 {
  transactionId: string;
  expectedSourceAppFingerprint: string;
  expectedBundleId: "com.openai.codex" | "com.openai.codex.beta";
  expectedBackendSha256: string;
  expectedVersion: string;
  expectedArchitecture: "arm64";
  expectedRuntimeFingerprint: string;
  expectedRuntimeFileCount: number;
  expectedRuntimeDocumentSha256: string;
}
export interface AcceptedSharedNativeBackendTransitionRequestV2 {
  version: 2;
  officialBundled: OfficialBundledCandidateInputV2;
  priorRegistrationFingerprint: `sha256:${string}`;
  priorResolverBinarySha256: string;
}
export type AcceptedSharedNativeBackendTransitionRequest = AcceptedSharedNativeBackendTransitionRequestV1 | AcceptedSharedNativeBackendTransitionRequestV2;

/** Signed candidate receipt data. This is an expectation, never a bypass flag. */
export interface AcceptedSharedNativeBackendTransitionLaneV1 {
  version: 1;
  identity: { target: string; userRoot: string; brokerRoot: string };
  authority: PrebuiltCombinedCandidateAuthority;
  priorRegistrationFingerprint: `sha256:${string}`;
  priorResolverBinarySha256: string;
}

export function assertAcceptedSharedNativeBackendTransitionRequestBinding(request: AcceptedSharedNativeBackendTransitionRequest,
  lane: AcceptedSharedNativeBackendTransitionLane): void {
  assertAcceptedSharedNativeBackendTransitionShape(lane);
  if (lane.version === 2) {
    const expected: OfficialBundledCandidateInputV2 = { transactionId: lane.authority.transactionId,
      expectedSourceAppFingerprint: lane.authority.sourceApp.contentsFingerprint, expectedBundleId: lane.authority.sourceApp.bundleId,
      expectedBackendSha256: lane.authority.backend.sha256, expectedVersion: lane.authority.backend.version,
      expectedArchitecture: lane.authority.backend.architecture, expectedRuntimeFingerprint: lane.authority.runtime.fingerprint,
      expectedRuntimeFileCount: lane.authority.runtime.fileCount, expectedRuntimeDocumentSha256: lane.authority.runtime.documentSha256 };
    if (request.version !== 2 || Object.keys(request).sort().join(",") !== "officialBundled,priorRegistrationFingerprint,priorResolverBinarySha256,version"
      || !isDeepStrictEqual(request.officialBundled, expected) || request.priorRegistrationFingerprint !== lane.priorRegistrationFingerprint
      || request.priorResolverBinarySha256 !== lane.priorResolverBinarySha256) throw new Error("Backend transition request differs from sealed official candidate authority");
    return;
  }
  const expected: PrebuiltCombinedCandidateInput = {transactionId: lane.authority.transactionId,
    binaryPath: lane.authority.backend.sourcePath, expectedBinarySha256: lane.authority.backend.sha256,
    expectedVersion: lane.authority.backend.version, expectedArchitecture: lane.authority.backend.architecture,
    receiptPath: lane.authority.acceptedBuildReceipt.path, expectedReceiptSha256: lane.authority.acceptedBuildReceipt.sha256,
    expectedRuntimeFingerprint: lane.authority.runtime.fingerprint, expectedRuntimeFileCount: lane.authority.runtime.fileCount,
    expectedRuntimeDocumentSha256: lane.authority.runtime.documentSha256,
    expectedSourceAppFingerprint: lane.authority.sourceApp.contentsFingerprint, expectedBundleId: lane.authority.sourceApp.bundleId};
  if (request.version !== 1 || !isDeepStrictEqual(request.prebuilt, expected)
    || request.priorRegistrationFingerprint !== lane.priorRegistrationFingerprint
    || request.priorResolverBinarySha256 !== lane.priorResolverBinarySha256) throw new Error("Backend transition request differs from sealed candidate authority");
}

export interface SharedNativeBackendTransitionPort {
  readSharedNativeModeAtRootV1(input: {stateRoot: string}): {state: string; reason?: string; fingerprint?: string; document?: {resolverBinarySha256: string; resolverProtocol?: string}};
  prepareSharedNativeResolverTransitionAtRootV1(input: {
    stateRoot: string; expectedRegistrationFingerprint: string; resolverBinarySha256: string;
    resolverProtocol?: "official-bundled-v1";
    repairBinding: { operationId: string; promotionId: string; journalSha256: string;
      priorRepairFingerprint: null; appFingerprintSha256: string; runtimeFingerprintSha256: string };
  }): { state: string; reason?: string; priorFingerprint?: string; priorResolverBinarySha256?: string;
    plan?: unknown; fingerprint?: string };
  executeSharedNativeResolverTransitionAtRootV1(input: {
    stateRoot: string; plan: unknown; expectedPlanFingerprint: string;
    action: "validate" | "begin" | "publish" | "finish";
  }): { state: string; reason?: string; binding?: unknown; priorFingerprint?: string;
    resolverBinarySha256?: string; priorResolverBinarySha256?: string };
}

export function sharedNativeBackendTransitionPort(runtimeRoot = packagedRuntimeAssetsRoot()): SharedNativeBackendTransitionPort {
  const runtime = readRuntimeFingerprintEvidence(runtimeRoot);
  if (!runtime) throw new Error("Backend transition requires a verified generated runtime");
  return createRequire(import.meta.url)(join(runtimeRoot, "account-router", "shared-native-mode.js"));
}

export function sealAcceptedSharedNativeBackendTransition(input: {
  request: AcceptedSharedNativeBackendTransitionRequest;
  identity: AcceptedSharedNativeBackendTransitionLane["identity"];
  installerPayloadHash: string; runtimeRoot: string; sourceAppRoot: string;
  port?: SharedNativeBackendTransitionPort;
}): AcceptedSharedNativeBackendTransitionLane {
  const request = input.request;
  if (request?.version === 2) return sealOfficialBundledTransition(input as typeof input & {request: AcceptedSharedNativeBackendTransitionRequestV2});
  if (!request || request.version !== 1 || Object.keys(request).sort().join(",") !== "prebuilt,priorRegistrationFingerprint,priorResolverBinarySha256,version") throw new Error("Invalid accepted backend transition request");
  const lane: AcceptedSharedNativeBackendTransitionLaneV1 = {
    version: 1, identity: input.identity,
    authority: validatePrebuiltCombinedCandidate(request.prebuilt, input),
    priorRegistrationFingerprint: request.priorRegistrationFingerprint,
    priorResolverBinarySha256: request.priorResolverBinarySha256,
  };
  assertAcceptedSharedNativeBackendTransitionShape(lane);
  assertAcceptedSharedNativeBackendTransitionPrior(lane, input.port ?? sharedNativeBackendTransitionPort(input.runtimeRoot));
  return lane;
}

export function assertAcceptedSharedNativeBackendTransitionShape(value: unknown): asserts value is AcceptedSharedNativeBackendTransitionLane {
  assertAcceptedSharedNativeBackendTransitionContract(value, {
    isCanonicalAbsolutePath: path => isAbsolute(path) && resolve(path) === path,
    sha256: digest,
  });
}

export function assertAcceptedSharedNativeBackendTransitionPrior(
  lane: AcceptedSharedNativeBackendTransitionLane,
  port = sharedNativeBackendTransitionPort(),
): void {
  assertAcceptedSharedNativeBackendTransitionShape(lane);
  const result = port.readSharedNativeModeAtRootV1({ stateRoot: lane.identity.brokerRoot });
  if (result.state !== "ready" || result.fingerprint !== lane.priorRegistrationFingerprint
    || result.document?.resolverBinarySha256 !== lane.priorResolverBinarySha256) {
    throw new Error(`Signed prior backend registration changed: ${result.reason ?? "identity mismatch"}`);
  }
}

/** Shared receipt/closure validators remain the only accepted-build authority. */
export function assertAcceptedSharedNativeBackendTransitionClosure(
  lane: AcceptedSharedNativeBackendTransitionLane, appRoot: string, runtimeRoot: string, nativeSignatures?: NativeBundledBackendSignaturePort,
): void {
  assertAcceptedSharedNativeBackendTransitionPairClosure(lane, appRoot, nativeSignatures);
  assertAcceptedAccountsRecoveryRuntime(runtimeRoot, lane.authority.runtime);
  if (lane.version === 2) assertOfficialBundledAdapterRuntime(runtimeRoot);
}

/** A runtime-only repair retains the same independently accepted executable pair. */
export function assertAcceptedSharedNativeBackendTransitionPairClosure(
  lane: AcceptedSharedNativeBackendTransitionLane, appRoot: string, nativeSignatures?: NativeBundledBackendSignaturePort,
): void {
  assertAcceptedSharedNativeBackendTransitionShape(lane);
  if (lane.version === 2) {
    assertOfficialBundledBackendClosure(appRoot, lane.authority.closure, nativeSignatures);
    assertOfficialNativePackage(appRoot, lane.authority);
    return;
  }
  const authority = lane.authority;
  const receiptPath = authority.acceptedBuildReceipt.path;
  if (sha256File(receiptPath) !== authority.acceptedBuildReceipt.sha256) throw new Error("Accepted transition receipt changed");
  const receipt = readAcceptedBuildReceipt(receiptPath, new Date());
  if (!isDeepStrictEqual(receipt.binary, { path: authority.backend.sourcePath, sha256: authority.backend.sha256,
      version: authority.backend.version, architecture: authority.backend.architecture, signature: authority.backend.signature })) {
    throw new Error("Accepted transition backend differs from its accepted build receipt");
  }
  if (receipt.acceptedAt !== authority.acceptedBuildReceipt.acceptedAt
    || receipt.source.commit !== authority.acceptedBuildReceipt.sourceCommit
    || receipt.source.tree !== authority.acceptedBuildReceipt.sourceTree
    || receipt.source.cargoLockSha256 !== authority.acceptedBuildReceipt.cargoLockSha256
    || receipt.source.reviewedDiffSha256 !== authority.acceptedBuildReceipt.reviewedDiffSha256
    || receipt.build.command !== authority.acceptedBuildReceipt.buildCommand
    || receipt.build.toolchain !== authority.acceptedBuildReceipt.toolchain
    || !isDeepStrictEqual(receipt.tests.map(({status: _status, ...test}) => test), authority.acceptedBuildReceipt.testEvidence)
    || !isDeepStrictEqual(receipt.closure, authority.closure)
    || !isDeepStrictEqual({ ...receipt.runtime, sourceRoot: authority.runtime.sourceRoot }, authority.runtime)
    || !isDeepStrictEqual(receipt.upstream, authority.acceptedBuildReceipt.upstream)
    || receipt.source.patchSeriesSha256 !== authority.acceptedBuildReceipt.patchSeriesSha256
    || !isDeepStrictEqual(receipt.verification, authority.acceptedBuildReceipt.verification)) {
    throw new Error("Accepted transition authority differs from its accepted build receipt");
  }
  assertAcceptedBackendClosure(receipt);
  const embedded = { ...receipt, binary: { ...receipt.binary, path: join(appRoot, "Contents", "Resources", "codex") },
    closure: { ...receipt.closure, codeModeHost: { ...receipt.closure.codeModeHost,
      path: join(appRoot, "Contents", "Resources", "codex-code-mode-host") },
    resources: receipt.closure.resources.map(resource => ({ ...resource, sourcePath: join(appRoot, "Contents", "Resources", resource.relativePath) })) } };
  assertAcceptedBackendClosure(embedded);
}

function sha256File(path: string): string {
  const status = existsSync(path) ? lstatSync(path) : null;
  if (!status?.isFile() || status.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Backend transition evidence path is missing or linked");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertOfficialBundledSourceTrust(sourceAppRoot: string): void {
  if (realpathSync(sourceAppRoot) !== sourceAppRoot || !lstatSync(sourceAppRoot).isDirectory()) throw new Error("Official transition source is linked or missing");
  const assessment = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", sourceAppRoot], {
    encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assertOpenAIDeveloperIdSourceTrust({ signature: signatureInfo(sourceAppRoot), strictVerification: verifySignature(sourceAppRoot),
    gatekeeper: { ok: assessment.status === 0, output: assessment.stderr ?? assessment.stdout ?? "" } });
}

function assertOfficialBundledAdapterRuntime(runtimeRoot: string): void {
  const adapterPath = join(runtimeRoot, "account-router", "official-bundled-adapter.js");
  sha256File(adapterPath);
  const adapter = createRequire(import.meta.url)(adapterPath);
  if (adapter.OFFICIAL_BUNDLED_ADAPTER_VERSION_V1 !== "official-bundled-adapter-v1") throw new Error("Official backend transition requires the generated official adapter capability");
  if (adapter.OFFICIAL_BUNDLED_ADAPTER_READY_V1 !== true) throw new Error("Local official backend adapter is not ready: full shared plugin behavior remains held; no candidate or resolver transition can be admitted.");
}

function readOfficialNativePackage(appRoot: string): OfficialBundledCandidateAuthorityV2["nativePackage"] {
  const relativePath = `${NATIVE_CODEX_CLI_ROOT}/codex-package.json` as const;
  const path = join(appRoot, relativePath), sha256 = sha256File(path);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.layoutVersion !== 1 || value.target !== "aarch64-apple-darwin" || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.version)
    || value.variant !== "codex" || value.entrypoint !== "bin/codex" || value.resourcesDir !== "codex-resources" || value.pathDir !== "codex-path") {
    throw new Error("Official bundled native package metadata is incompatible");
  }
  return { relativePath, sha256, layoutVersion: 1, version: value.version, target: "aarch64-apple-darwin" };
}

function assertOfficialNativePackage(appRoot: string, authority: OfficialBundledCandidateAuthorityV2): void {
  if (!isDeepStrictEqual(readOfficialNativePackage(appRoot), authority.nativePackage)) throw new Error("Official bundled native package metadata changed");
}

/** Only source verification and supplied-byte evidence can produce this lane. */
function sealOfficialBundledTransition(input: {
  request: AcceptedSharedNativeBackendTransitionRequestV2; identity: AcceptedSharedNativeBackendTransitionLane["identity"];
  installerPayloadHash: string; runtimeRoot: string; sourceAppRoot: string; port?: SharedNativeBackendTransitionPort;
}): AcceptedSharedNativeBackendTransitionLaneV2 {
  if (Object.keys(input.request).sort().join(",") !== "officialBundled,priorRegistrationFingerprint,priorResolverBinarySha256,version") throw new Error("Invalid official backend transition request");
  assertOfficialBundledSourceTrust(input.sourceAppRoot);
  const sourceBefore = sealOfficialSourceTree(input.sourceAppRoot);
  const closure = captureOfficialBundledBackendClosure(input.sourceAppRoot);
  if (!closure) throw new Error("Official backend transition requires the native bundled closure");
  const nativePackage = readOfficialNativePackage(input.sourceAppRoot);
  const runtime = readRuntimeFingerprintEvidence(input.runtimeRoot);
  if (!runtime) throw new Error("Official backend transition requires a verified generated runtime");
  const bare: Omit<OfficialBundledCandidateAuthorityV2, "payloadIdentity"> = {
    schemaVersion: 2, kind: "official-bundled", transactionId: input.request.officialBundled.transactionId,
    installerPayloadHash: input.installerPayloadHash,
    backend: { sourcePath: join(input.sourceAppRoot, NATIVE_CODEX_BACKEND), sha256: closure.backend.sha256,
      version: nativePackage.version, architecture: "arm64", certificateSha1: closure.backend.certificateSha1 },
    closure: { ...closure, backend: { ...closure.backend, relativePath: NATIVE_CODEX_BACKEND },
      codeModeHost: { ...closure.codeModeHost, relativePath: "Contents/Resources/codex-cli/bin/codex-code-mode-host" } },
    nativePackage,
    runtime: { sourceRoot: input.runtimeRoot, ...runtime, documentSha256: sha256File(join(input.runtimeRoot, "runtime-fingerprint.json")),
      adapterVersion: "official-bundled-adapter-v1" },
    sourceApp: { path: input.sourceAppRoot, bundleId: readPlist(join(input.sourceAppRoot, "Contents", "Info.plist")).CFBundleIdentifier as "com.openai.codex" | "com.openai.codex.beta",
      contentsFingerprint: fingerprintAppContents(input.sourceAppRoot), treeSeal: sourceBefore },
  };
  const lane: AcceptedSharedNativeBackendTransitionLaneV2 = { version: 2, resolverProtocol: "official-bundled-v1", identity: input.identity,
    authority: { ...bare, payloadIdentity: digest(acceptedOfficialBundledPayloadText(bare)) },
    priorRegistrationFingerprint: input.request.priorRegistrationFingerprint, priorResolverBinarySha256: input.request.priorResolverBinarySha256 };
  assertAcceptedSharedNativeBackendTransitionRequestBinding(input.request, lane);
  assertAcceptedSharedNativeBackendTransitionClosure(lane, input.sourceAppRoot, input.runtimeRoot);
  if (!isDeepStrictEqual(sourceBefore, sealOfficialSourceTree(input.sourceAppRoot))) throw new Error("Official source changed while sealing transition authority");
  assertAcceptedSharedNativeBackendTransitionPrior(lane, input.port ?? sharedNativeBackendTransitionPort(input.runtimeRoot));
  return lane;
}

/** Read-only review input. Hash or protocol changes use the ordinary reviewed transition. */
/** Verified installed source selection also exists when the resolver already
 * uses the supplied pair. That case grants no new backend transition. */
export function prepareOfficialBundledBackendSourceSelection(input: {
  sourceAppRoot: string; brokerRoot: string; runtimeRoot: string; transactionId: string; port?: SharedNativeBackendTransitionPort;
}): { sourceAppFingerprint: string; request?: AcceptedSharedNativeBackendTransitionRequestV2 } | undefined {
  const port = input.port ?? sharedNativeBackendTransitionPort(input.runtimeRoot);
  const initialPrior = port.readSharedNativeModeAtRootV1({ stateRoot: input.brokerRoot });
  if (initialPrior.state === "absent") return undefined;
  if (initialPrior.state !== "ready" || !initialPrior.document || !/^sha256:[a-f0-9]{64}$/.test(initialPrior.fingerprint ?? "")
    || !/^[a-f0-9]{64}$/.test(initialPrior.document.resolverBinarySha256)) throw new Error(`Signed prior backend registration unavailable: ${initialPrior.reason ?? initialPrior.state}`);
  assertOfficialBundledSourceTrust(input.sourceAppRoot);
  const sourceBefore = sealOfficialSourceTree(input.sourceAppRoot);
  const closure = captureOfficialBundledBackendClosure(input.sourceAppRoot);
  if (!closure) throw new Error("Official transition review requires the native bundled closure");
  const nativePackage = readOfficialNativePackage(input.sourceAppRoot);
  const runtime = readRuntimeFingerprintEvidence(input.runtimeRoot);
  if (!runtime) throw new Error("Official transition review requires a verified generated runtime");
  const runtimeDocumentSha256 = sha256File(join(input.runtimeRoot, "runtime-fingerprint.json"));
  assertAcceptedAccountsRecoveryRuntime(input.runtimeRoot, { ...runtime, documentSha256: runtimeDocumentSha256 });
  assertOfficialBundledAdapterRuntime(input.runtimeRoot);
  const sourceFingerprint = fingerprintAppContents(input.sourceAppRoot);
  const bundleId = readPlist(join(input.sourceAppRoot, "Contents", "Info.plist")).CFBundleIdentifier;
  if ((bundleId !== "com.openai.codex" && bundleId !== "com.openai.codex.beta")
    || !isDeepStrictEqual(sourceBefore, sealOfficialSourceTree(input.sourceAppRoot))) throw new Error("Official transition review source changed");
  const prior = port.readSharedNativeModeAtRootV1({ stateRoot: input.brokerRoot });
  if (prior.state !== "ready" || !prior.document || !/^sha256:[a-f0-9]{64}$/.test(prior.fingerprint ?? "")
    || prior.fingerprint !== initialPrior.fingerprint || !isDeepStrictEqual(prior.document, initialPrior.document)
    || !/^[a-f0-9]{64}$/.test(prior.document.resolverBinarySha256)) throw new Error(`Signed prior backend registration unavailable: ${prior.reason ?? prior.state}`);
  if (prior.document.resolverProtocol === "official-bundled-v1" && prior.document.resolverBinarySha256 === closure.backend.sha256) return { sourceAppFingerprint: sourceFingerprint };
  return { sourceAppFingerprint: sourceFingerprint, request: { version: 2, officialBundled: { transactionId: input.transactionId, expectedSourceAppFingerprint: sourceFingerprint,
    expectedBundleId: bundleId, expectedBackendSha256: closure.backend.sha256, expectedVersion: nativePackage.version, expectedArchitecture: "arm64",
    expectedRuntimeFingerprint: runtime.fingerprint, expectedRuntimeFileCount: runtime.fileCount, expectedRuntimeDocumentSha256: runtimeDocumentSha256 },
    priorRegistrationFingerprint: prior.fingerprint as `sha256:${string}`, priorResolverBinarySha256: prior.document.resolverBinarySha256 } };
}

export function prepareOfficialBundledBackendTransitionRequest(input: Parameters<typeof prepareOfficialBundledBackendSourceSelection>[0]): AcceptedSharedNativeBackendTransitionRequestV2 | undefined {
  return prepareOfficialBundledBackendSourceSelection(input)?.request;
}

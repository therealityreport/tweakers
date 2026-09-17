import { prepareProbedAccountsTransferRecovery } from "../accounts-transfer-compatibility.js";
import type { DoctorPatchRepairV1 } from "../doctor-patch-repair.js";
import kleur from "kleur";
import {
  chmodSync,
  cpSync,
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readHeaderHash } from "../asar.js";
import {
  DEFAULT_LOCAL_SIGNING_IDENTITY,
  assertOpenAIDeveloperIdSourceTrust,
  codeSigningCertificateLeafHash,
  findExistingPreparedSigningIdentity,
  signCandidateReceiptResourceBundle,
  signatureInfo,
  verifyCandidateReceiptResourceBundle,
  verifySignature,
  type PreparedSigningIdentity,
} from "../codesign.js";
import { install, installerPayloadHash, packagedRuntimeAssetsRoot, stageBundledTweaks, type BundledDerivedBackendArtifact } from "./install.js";
import { validatePrebuiltCombinedCandidate, type PrebuiltCombinedCandidateInput } from "../prebuilt-combined-candidate.js";
import { cloneAppTree } from "../transaction.js";
import { readPlist, writePlist } from "../plist.js";
import { assertResourceAsarIntegrity } from "../integrity.js";
import {
  acquireSealedInactiveEnvironmentModeSourceLease,
  assertSealedInactiveEnvironmentModeSource,
  environmentModeCachePaths,
  type EnvironmentModePairReceipt,
} from "../environment-mode-cache.js";
import {
  acquireRegisteredOfficialSourceLease,
  readRegisteredOfficialSource,
} from "../official-source-registration.js";
import { acquireProcessLock, processAlive, type ProcessLock } from "../process-lock.js";
import { userPaths, type UserPaths } from "../paths.js";
import {
  canonicalTweakersManagerRoot,
  publishTweakersManagerDescriptor,
} from "../manager-descriptor.js";
import {
  resolveSealedManagerRuntimeAssets,
  verifySealedManagerRuntimeAssets,
} from "../manager-runtime-assets.js";
import {
  bootstrapCanonicalManagerEnvironmentSnapshot,
  type CanonicalManagerEnvironmentPublication,
} from "../environment-profile.js";
import {
  TWEAKERS_VARIANT_BUNDLE_ID,
  REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS,
  TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
  TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
  TWEAKERS_VARIANT_DOCK_ICON_FILES,
  TWEAKERS_VARIANT_ICON_FILE,
  TWEAKERS_VARIANT_ICON_SOURCE,
  TWEAKERS_VARIANT_NAME,
  TWEAKERS_VARIANT_PNG_SOURCE,
  TWEAKERS_VARIANT_PRODUCT_NAME,
  TWEAKERS_VARIANT_USER_DATA_CONFIG,
  TWEAKERS_VARIANT_URL_SCHEME,
  TWEAKERS_ORIGINAL_EXECUTABLE,
  assertNoResidualOpenAIRuntimeIdentities,
  defaultTweakersAccountsBrokerRoot,
  defaultTweakersVariantIdentity,
} from "../macos-variant.js";
import {
  assertCandidatePackageExistingDirectory,
  assertCandidatePackageParentAnchor,
  assertCandidatePackagePathsDisjoint,
  assertCandidatePackageScratchAnchor,
  closeCandidatePackageParentAnchor,
  closeCandidatePackageScratchAnchor,
  createCandidatePackageScratch,
  openCandidatePackageParentAnchor,
  projectCandidatePackagePath,
  publishCandidatePackageExclusively,
  retainCandidatePackageEvidence,
  type CandidatePackagePathIdentity,
  type CandidatePackagePathProjection,
  type CandidatePackageParentAnchor,
  type CandidatePackageScratchAnchor,
} from "../candidate-package-filesystem.js";
import { readRuntimeFingerprintEvidence } from "../runtime-fingerprint.js";
import { accountsTransferBrokerRoots, assertAccountsTransferRuntimeCompatible, prepareAccountsTransferRecovery, type AccountsTransferValidationEvidence } from "../accounts-transfer-compatibility.js";
import {
  assertIndependentTweakersAccountsRegistration,
  type IndependentTweakersBrokerAuthorityExpectation,
} from "../account-router-status.js";

const REQUIRED_TWEAKERS_TWEAKS = new Set(REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS);

function verifiedVariantBackend(options: CreateVariantOptions, sourceAppRoot: string): BundledDerivedBackendArtifact | undefined {
  if (options.retainRegisteredBackend) return verifiedRegisteredBackendForUpstreamCandidate(options, sourceAppRoot);
  if (options.baselineMaintenance) return verifiedBaselineMaintenance(options, sourceAppRoot).backend;
  if (!options.prebuiltBackend) return undefined;
  const accepted = validatePrebuiltCombinedCandidate(options.prebuiltBackend, {
    installerPayloadHash: installerPayloadHash(),
    runtimeRoot: packagedRuntimeAssetsRoot(),
    sourceAppRoot,
  });
  return {
    binaryPath: accepted.backend.sourcePath,
    version: accepted.backend.version,
    fingerprint: accepted.backend.sha256,
    receiptPath: accepted.acceptedBuildReceipt.path,
    transactionId: accepted.transactionId,
  };
}

/** Carry the exact signed, registered resolver into a separately reviewed upstream candidate. */
function verifiedRegisteredBackendForUpstreamCandidate(options: CreateVariantOptions, source: string): BundledDerivedBackendArtifact {
  const binding = options.retainRegisteredBackend;
  const app = "/Applications/Tweakers.app";
  const variantRoot = join(canonicalTweakersManagerRoot(), "variants", "tweakers");
  const brokerRoot = defaultTweakersAccountsBrokerRoot();
  if (!binding || !(options.candidateOnly || options["candidate-only"]) || options.baselineMaintenance || options.prebuiltBackend
    || (options.app && options.app !== app) || (options.userRoot && options.userRoot !== variantRoot)
    || (options["user-root"] && options["user-root"] !== variantRoot)
    || (options.userData && options.userData !== join(variantRoot, "app-data"))
    || (options["user-data"] && options["user-data"] !== join(variantRoot, "app-data"))) throw new Error("Invalid retained registered backend candidate binding");
  assertFingerprint(binding.installedFingerprint, "Installed registered backend app");
  assertFingerprint(binding.sourceFingerprint, "Reviewed upstream source");
  if (!fingerprintsMatch(binding.installedFingerprint, fingerprintVariantGeneration(app)) || !verifySignature(app).ok
    || !fingerprintsMatch(binding.sourceFingerprint, fingerprintVariantGeneration(source))) throw new Error("Registered backend app or upstream source changed");
  assertOfficialSource(source, {});
  const statePath = join(variantRoot, "state.json");
  const registrationPath = join(brokerRoot, "shared-native-mode.v1.json");
  assertPrivateRegularFile(statePath, "Installed registered backend state");
  assertPrivateRegularFile(registrationPath, "Installed shared native registration");
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (!isSha256(binding.installedStateSha256) || !isSha256(binding.registrationSha256) || !isSha256(binding.backendSha256)
    || hash(statePath) !== binding.installedStateSha256 || hash(registrationPath) !== binding.registrationSha256) throw new Error("Registered backend state or registration changed");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (readPlist(join(app, "Contents", "Info.plist")).CFBundleIdentifier !== TWEAKERS_VARIANT_BUNDLE_ID
    || state.appRoot !== app || state.patchedAsarHash !== readHeaderHash(join(app, "Contents", "Resources", "app.asar")).headerHash) throw new Error("Installed registered backend identity changed");
  verifyCreatedVariant(app, statePath, join(variantRoot, "app-data"), join(variantRoot, "codex-home"), brokerRoot, {}, true);
  assertRegisteredSharedNativeBackend(app, brokerRoot);
  const binaryPath = join(app, "Contents", "Resources", "codex");
  if (hash(binaryPath) !== binding.backendSha256) throw new Error("Registered backend bytes changed");
  const probe = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 10_000, env: {} });
  const version = probe.stdout?.trim().match(/^codex-cli (\S+)$/)?.[1];
  if (probe.status !== 0 || !version) throw new Error("Registered backend version unavailable");
  return { binaryPath, version, fingerprint: binding.backendSha256, receiptPath: statePath, transactionId: "retained-registered-upstream-candidate", preserveSignature: true };
}

/** Maintenance is not an upstream update: prove the exact original source and retain the signed backend bytes. */
function verifiedBaselineMaintenance(options: CreateVariantOptions, source: string): { backend: BundledDerivedBackendArtifact; receipt?: TweakersVariantCandidateReceipt } {
  const binding = options.baselineMaintenance;
  const app = "/Applications/Tweakers.app", root = canonicalTweakersManagerRoot();
  const variantRoot = join(root, "variants", "tweakers");
  if (!binding || (options.app && options.app !== app) || options.prebuiltBackend) throw new Error("Invalid baseline maintenance binding");
  assertFingerprint(binding.installedFingerprint, "Installed maintenance baseline");
  if (!fingerprintsMatch(binding.installedFingerprint, fingerprintVariantGeneration(app)) || !verifySignature(app).ok) throw new Error("Installed maintenance baseline changed");
  const statePath = join(variantRoot, "state.json");
  assertPrivateRegularFile(statePath, "Installed maintenance state");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const installedInfo = readPlist(join(app, "Contents", "Info.plist")), sourceInfo = readPlist(join(source, "Contents", "Info.plist"));
  if (installedInfo.CFBundleIdentifier !== TWEAKERS_VARIANT_BUNDLE_ID || state.appRoot !== app
    || state.patchedAsarHash !== readHeaderHash(join(app, "Contents", "Resources", "app.asar")).headerHash
    || state.originalAsarHash !== readHeaderHash(join(source, "Contents", "Resources", "app.asar")).headerHash
    || sourceInfo.CFBundleShortVersionString !== installedInfo.CFBundleShortVersionString
    || sourceInfo.CFBundleVersion !== installedInfo.CFBundleVersion) throw new Error("Maintenance cannot change the installed upstream baseline");
  assertOfficialSource(source, {});
  verifyCreatedVariant(app, statePath, join(variantRoot, "app-data"), join(variantRoot, "codex-home"), defaultTweakersAccountsBrokerRoot(), {}, true);
  const binaryPath = join(app, "Contents", "Resources", "codex");
  const versionProbe = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 10_000, env: {} });
  const version = versionProbe.stdout?.trim().match(/^codex-cli (\S+)$/)?.[1];
  if (versionProbe.status !== 0 || !version) throw new Error("Installed maintenance backend version is unavailable");
  const backend: BundledDerivedBackendArtifact = { binaryPath, version, fingerprint: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"), receiptPath: statePath, transactionId: "retained-installed-baseline", preserveSignature: true };
  if (!binding.candidatePackage) return { backend };
  const candidatePackage = resolve(binding.candidatePackage);
  const expected = binding.candidateReceipt;
  if (!expected) throw new Error("Maintenance requires the exact prepared receipt");
  const receipt = verifyTweakersVariantCandidateReceipt(candidatePackage, { expectedPackageRoot: candidatePackage,
    expectedObservedPackageRoot: candidatePackage, expectedSigningIdentityHash: state.signingIdentityHash,
    expectedTransactionId: expected.id, expectedSource: expected.source, expectedIdentity: expected.identity });
  const candidateInfo = readPlist(join(candidatePackage, "Tweakers.app", "Contents", "Info.plist"));
  const candidateState = JSON.parse(readFileSync(join(candidatePackage, "state.json"), "utf8"));
  if (candidateInfo.CFBundleVersion !== installedInfo.CFBundleVersion
    || candidateInfo.CFBundleShortVersionString !== installedInfo.CFBundleShortVersionString
    || candidateState.originalAsarHash !== state.originalAsarHash) throw new Error("Maintenance candidate changed the installed upstream baseline");
  if (receipt.source.path !== source || receipt.identity.appTarget !== app || receipt.identity.userRoot !== variantRoot
    || receipt.identity.appUserDataRoot !== join(variantRoot, "app-data") || receipt.identity.codexHomeRoot !== join(variantRoot, "codex-home")
    || receipt.identity.accountsBrokerRoot !== defaultTweakersAccountsBrokerRoot()
    || !fingerprintsMatch(receipt.source.fingerprint, fingerprintVariantGeneration(source))
    || createHash("sha256").update(readFileSync(join(candidatePackage, "Tweakers.app", "Contents", "Resources", "codex"))).digest("hex") !== backend.fingerprint) throw new Error("Maintenance candidate changed its baseline or backend");
  return { backend, receipt };
}

/** A future refresh must not replace a registered resolver with the stock backend. */
function assertRegisteredSharedNativeBackend(candidate: string, accountsBrokerRoot: string): void {
  const registration = join(accountsBrokerRoot, "shared-native-mode.v1.json");
  const transition = join(accountsBrokerRoot, "shared-native-mode-transition.v1.json");
  if (existsSync(transition)) throw new Error("Shared native mode recovery must finish before another Tweakers refresh.");
  if (!existsSync(registration)) return;
  const stat = lstatSync(registration);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe shared native registration.");
  const document = JSON.parse(readFileSync(registration, "utf8")) as { resolverBinarySha256?: unknown };
  const expected = document.resolverBinarySha256;
  const backend = join(candidate, "Contents", "Resources", "codex");
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)
    || !existsSync(backend) || lstatSync(backend).isSymbolicLink()
    || createHash("sha256").update(readFileSync(backend)).digest("hex") !== expected) {
    throw new Error("This candidate does not contain the registered shared native backend. Prepare a compatible backend transition before refreshing Tweakers.");
  }
}

export interface CreateVariantOptions {
  /** Internal, candidate-only, data-only verified repair adapters. */
  doctorPatchRepairs?: DoctorPatchRepairV1[];
  /** Frozen configuration captured by Doctor, sealed into the candidate receipt. */
  doctorConfiguration?: Record<string, unknown>;
  /** Explicit candidate-only UI setting, sealed into its configuration artifact. */
  doctorTitlebarEnabled?: boolean;
  source?: string;
  app?: string;
  /** Build a private, inspectable package and deliberately stop before promotion. */
  candidateOnly?: boolean;
  /** Doctor-only disposable home. Never valid for installation or promotion. */
  doctorPreviewHome?: string;
  "candidate-only"?: boolean;
  /** Required private package root for --candidate-only. It must not exist yet. */
  output?: string;
  /** Source-validated retained recovery artifact, prepared before candidate sealing. */
  accountsTransferRecovery?: { root: string; validation: AccountsTransferValidationEvidence };
  doctorAccountsRecoveryRoot?: string;
  /** Internal accepted-build input, verified against this exact official source and runtime. */
  prebuiltBackend?: PrebuiltCombinedCandidateInput;
  /** Internal post-change maintenance only: exact installed app, unchanged upstream and backend. */
  baselineMaintenance?: { installedFingerprint: VariantGenerationFingerprint; candidatePackage?: string; candidateReceipt?: TweakersVariantCandidateReceipt };
  /** Internal candidate-only upstream update; normal Doctor approval is still required for promotion. */
  retainRegisteredBackend?: { installedFingerprint: VariantGenerationFingerprint; sourceFingerprint: VariantGenerationFingerprint;
    installedStateSha256: string; registrationSha256: string; backendSha256: string };

  userRoot?: string;
  "user-root"?: string;
  userData?: string;
  "user-data"?: string;
  refresh?: boolean;
  /**
   * Internal manager-only mode. It retains the promotion journal and its
   * compensating rollback until the freshly reopened derived app writes an
   * operation-bound runtime-ready receipt. It is deliberately not exposed by
   * the CLI.
   */
  deferRuntimeReadyCommit?: boolean;
  /** Required with deferRuntimeReadyCommit; generated by the prepared manager action. */
  runtimeReadyOperationId?: string;
}

interface RuntimeRepairResolverPort {
  executeSharedNativeResolverTransitionAtRootV1(input: {
    stateRoot: string; plan: unknown; expectedPlanFingerprint: string; action: "validate" | "begin" | "publish" | "finish";
  }): { state: string; reason?: string; priorFingerprint?: string; fingerprint?: string;
    priorResolverBinarySha256?: string; resolverBinarySha256?: string; binding?: unknown };
}

interface CreateVariantDeps {
  /** Existing-test seam; production loads the hash-bound staged runtime port. */
  runtimeRepairResolverPort?: RuntimeRepairResolverPort;
  platform?: () => NodeJS.Platform;
  home?: () => string;
  defaultSource?: () => string;
  cloneApp?: typeof cloneAppTree;
  installApp?: typeof install;
  stageTweaks?: typeof stageBundledTweaks;
  signature?: typeof signatureInfo;
  verify?: typeof verifySignature;
  /** Test-only replacement for production's complete Resources/*.asar proof. */
  verifyResourceAsarIntegrity?: (appRoot: string) => void;
  gatekeeper?: (path: string) => { ok: boolean; output: string };
  archiveApp?: (path: string, archivePath: string) => void;
  id?: () => string;
  /** Test-only hook for simulating a filesystem failure at a promotion edge. */
  fault?: (point: string) => void;
  /** Test-only hook that simulates abrupt process termination after a durable journal phase. */
  crashAfterJournalPhase?: (phase: string) => boolean;
  /** Injectable exact-target process check; a running target is never stopped by this command. */
  targetProcessRunning?: (target: string) => boolean;
  /**
   * Manager-only cutover seam. Candidate construction and static validation
   * finish while the installed target may remain open; the manager then
   * quiesces that exact target immediately before the final process gate and
   * promotion. Ordinary CLI callers do not supply this hook.
   */
  beforePromotion?: (input: {
    target: string;
    candidate: string;
    userRoot: string;
  }) => void | Promise<void>;
  /** Test-only fault seam for the post-commit, non-rollbackable challenge cleanup. */
  removeRuntimeReadyExpectation?: (userRoot: string) => void;
  /**
   * Test seam for an existing variant-transaction lock owner. Production uses
   * a non-mutating PID liveness probe and treats every indeterminate result as
   * live rather than taking over the lock.
   */
  variantTransactionLockOwnerAlive?: (pid: number) => boolean;
  /** Test-only observer for completed fsync boundaries. */
  onDurableBoundary?: (path: string) => void;
  /** Test-only default-source root; production stays on the canonical cache root. */
  environmentRoot?: () => string;
  /** Test-only read-only sealed source seam. It must never mutate the cache. */
  sealedSourceReader?: (paths: ReturnType<typeof environmentModeCachePaths>) => EnvironmentModePairReceipt;
  /** Candidate-only selection seam; production calls the read-only identity reader. */
  existingSigningIdentity?: () => PreparedSigningIdentity;
  /** Private-fixture receipt-signature seam; production uses strict macOS codesign. */
  candidateReceiptSignature?: CandidateReceiptSignatureAdapter;
  /** Test-only official app root; production always uses /Applications/ChatGPT.app. */
  officialAppPath?: () => string;
  /** Deterministic private-fixture race seam immediately before publication. */
  beforeCandidatePublication?: (paths: { output: string; scratch: string; failedScratch: string }) => void;
  /** Deterministic private-fixture race seam immediately before failed-evidence retention. */
  beforeCandidateFailureRetention?: (paths: { scratch: string; failedScratch: string }) => void;
  /** Deterministic private-fixture drift seam after scratch anchoring and before clone. */
  afterCandidateScratchCreated?: (paths: { scratch: string; outputParent: string }) => void;
  /** Test-only canonical global manager-root override. Production derives it from the target home. */
  managerRoot?: () => string;
  /** Source authority root; the sealed manager binds its canonical root explicitly. */
  environmentAuthoritySourceRoot?: () => string;
  /** Test-only resolver proving the sealed source is bound to that exact authority root. */
  sealedDefaultSourceResolver?: (environmentRoot: string) => string;
  /**
   * Manager-only authority for independent Tweakers refreshes. When present,
   * this path is the sole source authority: no live app, mode-cache, explicit
   * source, or default resolver may substitute for its immutable receipt.
   */
  registeredOfficialSourceAuthorityRoot?: () => string;
  /** Exact manager-prepared registered source binding. */
  registeredOfficialSourceBinding?: () => { generationId: string; receiptDigest: string };
  /**
   * Test-only sealed manager publisher. Candidate-only packaging never calls
   * this seam; independent promotion must publish the canonical global root.
   */
  publishManagerDescriptor?: (options: { userRoot: string }) => {
    restoreOnFailure(): void;
  };
  /**
   * Test-only manager environment bootstrap. Production validates the legacy
   * authority and materializes a canonical manager-owned snapshot.
   */
  bootstrapManagerEnvironment?: (options: { sourceRoot: string; destinationRoot: string }) =>
    CanonicalManagerEnvironmentPublication;
}

interface CandidateReceiptSignatureAdapter {
  sign(bundlePath: string, preparedIdentity: PreparedSigningIdentity): void;
  verify(bundlePath: string, expectedSigningIdentityHash: string): void;
  certificateLeafHash(path: string): string;
}

const VARIANT_CANDIDATE_RECEIPT_BUNDLE_PATH = join("receipt", "TweakersCandidateReceipt.bundle");
const VARIANT_CANDIDATE_RECEIPT_JSON_PATH = join(
  VARIANT_CANDIDATE_RECEIPT_BUNDLE_PATH,
  "Contents",
  "Resources",
  "variant-candidate-receipt.json",
);
const VARIANT_CANDIDATE_RECEIPT_BUNDLE_IDENTIFIER = "co.tweakers.candidate-receipt";
const VARIANT_CANDIDATE_RECEIPT_VERSION = 2 as const;
const VARIANT_CANDIDATE_ARTIFACT_PATHS = {
  app: "Tweakers.app",
  runtime: "runtime",
  tweaks: "tweaks",
  state: "state.json",
  config: "config.json",
} as const;

/**
 * A one-use, manager-owned launch grant for an independent Tweakers refresh.
 * The runtime never treats this as success evidence: it must write the paired
 * runtime-ready receipt only after main, preload, and every bundled tweak have
 * initialized.  Both files live below the exact isolated variant root, never
 * below the official ChatGPT profile or an arbitrary caller-selected path.
 */
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE = "runtime-ready-expectation.json";
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_RECEIPT_FILE = "runtime-ready.json";
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION = 5 as const;
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND = "tweakers-independent-runtime-ready" as const;
export const INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND = "tweakers-independent-runtime-ready-expectation" as const;

export interface IndependentTweakersRuntimeReadyExpectation {
  schemaVersion: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION;
  kind: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND;
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  appRoot: string;
  bundleId: typeof TWEAKERS_VARIANT_BUNDLE_ID;
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: IndependentTweakersBrokerAuthorityExpectation;
  /**
   * The manager requires the independent window to have a verified Actual
   * Size observation before it can accept a startup receipt. This is a fixed
   * contract rather than a best-effort diagnostics field, so the runtime
   * receipt must bind it exactly.
   */
  appearanceExpectation: IndependentTweakersRuntimeReadyAppearanceBinding;
  expectedTweakIds: readonly string[];
  createdAt: string;
}

export interface IndependentTweakersRuntimeReadyAppearanceBinding {
  status: "normal";
  normalized: true;
}

export interface IndependentTweakersRuntimeReadyReceipt {
  schemaVersion: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION;
  kind: typeof INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND;
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  pid: number;
  processStartToken: string;
  appRoot: string;
  bundleId: typeof TWEAKERS_VARIANT_BUNDLE_ID;
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: IndependentTweakersBrokerAuthorityExpectation;
  appearance: IndependentTweakersRuntimeReadyAppearanceBinding;
  mainInitialized: true;
  preloadInitialized: true;
  settingsMounted: true;
  sharedHistoryBrokerState: "connected" | "blocked";
  initializedTweakIds: readonly string[];
  observedAt: string;
}

/**
 * The manager holds this object (and its exact transaction lock) across the
 * short relaunch/proof interval. It can commit only after verifyRuntimeReady
 * accepts a freshly written receipt. Any failure uses rollback while the
 * durable journal is still uncommitted.
 */
export interface DeferredTweakersVariantRefresh {
  readonly target: string;
  readonly userRoot: string;
  readonly runtimeReadyExpectation: IndependentTweakersRuntimeReadyExpectation;
  verifyRuntimeReady(value: unknown, pid: number, processStartToken: string): void;
  commit(): void;
  rollback(): void;
  /** Release the lease while retaining the provisional generation for forward repair. */
  retain(): void;
}

export interface TweakersVariantCandidateReceipt {
  version: typeof VARIANT_CANDIDATE_RECEIPT_VERSION;
  kind: "tweakers-variant-candidate";
  id: string;
  packageRoot: string;
  packageIdentity: Pick<CandidatePackagePathIdentity, "dev" | "ino">;
  source: {
    path: string;
    physicalPath: string;
    rootIdentity: CandidatePackagePathIdentity;
    fingerprint: VariantGenerationFingerprint;
    sealed: {
      receiptDigest: string;
      generationId: string;
      inactiveAppPath: string;
      inactiveSeal: string;
    } | null;
  };
  identity: {
    appTarget: string;
    userRoot: string;
    appUserDataRoot: string;
    codexHomeRoot: string;
    accountsBrokerRoot: string;
  };
  signingIdentityHash: string;
  artifacts: Record<keyof typeof VARIANT_CANDIDATE_ARTIFACT_PATHS, VariantGenerationFingerprint>;
}

export interface TweakersVariantCandidateReceiptVerificationOptions {
  expectedSigningIdentityHash: string;
  expectedTransactionId: string;
  /** The final caller-owned package path recorded in the signed claim. */
  expectedPackageRoot: string;
  /** The physical package path currently being inspected (scratch before publication or output afterwards). */
  expectedObservedPackageRoot: string;
  expectedSource: TweakersVariantCandidateReceipt["source"];
  expectedIdentity: TweakersVariantCandidateReceipt["identity"];
  officialAppPath?: string;
  signature?: CandidateReceiptSignatureAdapter;
  /** Test-only replacement for production's complete Resources/*.asar proof. */
  verifyResourceAsarIntegrity?: (appRoot: string) => void;
}

export function resolveDefaultTweakersVariantSource(environmentRoot = userPaths().root): string {
  const receipt = assertSealedInactiveEnvironmentModeSource(environmentModeCachePaths(environmentRoot));
  return resolve(receipt.roles.inactive.appPath);
}

export async function refreshTweakersVariant(
  options: CreateVariantOptions = {},
  deps: CreateVariantDeps = {},
): Promise<void | DeferredTweakersVariantRefresh> {
  return createTweakersVariant({ ...options, refresh: true }, deps);
}

/**
 * Manager-only independent refresh entrypoint.  Unlike the ordinary refresh,
 * this deliberately leaves the durable replacement journal uncommitted until
 * the caller has reopened the exact derived app and supplied operation-bound
 * readiness evidence.  Do not use this for a CLI command: its returned handle
 * holds the exact-target transaction lock until commit or rollback.
 */
export async function prepareDeferredTweakersVariantRefresh(
  options: CreateVariantOptions,
  deps: CreateVariantDeps = {},
): Promise<DeferredTweakersVariantRefresh> {
  if (!options.runtimeReadyOperationId) {
    throw new Error("Deferred independent Tweakers refresh requires a manager operation ID.");
  }
  const result = await createTweakersVariant({
    ...options,
    refresh: true,
    deferRuntimeReadyCommit: true,
  }, deps);
  if (!result) {
    throw new Error("Deferred independent Tweakers refresh completed without a runtime-ready transaction handle.");
  }
  return result;
}

export async function createTweakersVariant(
  options: CreateVariantOptions = {},
  deps: CreateVariantDeps = {},
): Promise<void | DeferredTweakersVariantRefresh> {
  if ((deps.platform ?? platform)() !== "darwin") {
    throw new Error("A separate Tweakers app is currently supported only on macOS.");
  }

  const candidateOnly = options.candidateOnly === true || options["candidate-only"] === true;
  if (options.doctorPreviewHome) {
    const home = resolve(options.doctorPreviewHome), jobs = join(canonicalTweakersManagerRoot(), "doctor", "jobs");
    if (!candidateOnly || options.refresh || !home.startsWith(`${jobs}/`) || !/\/previews\/[a-f0-9-]{36}\/home$/.test(home)
      || !options.userRoot || !resolve(options.userRoot).startsWith(`${home}/`) || !options.app || !resolve(options.app).startsWith(`${home}/`)
      || options.retainRegisteredBackend || options.prebuiltBackend || options.baselineMaintenance) throw new Error("Doctor preview requires disposable candidate-only identities");
    assertNoSymlinkPathWithin(jobs, home, "Doctor preview home");
  }
  if ((options.doctorPatchRepairs || options.doctorConfiguration) && !candidateOnly) throw new Error("Doctor inputs require isolated candidate preparation");
  if (options.doctorTitlebarEnabled !== undefined && (!candidateOnly || typeof options.doctorTitlebarEnabled !== "boolean")) throw new Error("Titlebar override requires candidate-only preparation");
  if (options.retainRegisteredBackend && (!candidateOnly || options.baselineMaintenance || options.prebuiltBackend)) {
    throw new Error("Retaining the registered backend requires an exclusive candidate-only request");
  }
  if (candidateOnly) {
    if (options.refresh === true) {
      throw new Error("A candidate-only variant cannot refresh or promote an installed Tweakers app.");
    }
    return createTweakersVariantCandidateOnly(options, deps);
  }
  if (options.output !== undefined) {
    throw new Error("--output is valid only with create-variant --candidate-only.");
  }

  const environmentAuthoritySourceRoot = resolve((deps.environmentAuthoritySourceRoot ?? (() => userPaths().root))());
  const registeredOfficialSourceRoot = deps.registeredOfficialSourceAuthorityRoot === undefined
    ? null
    : resolve(deps.registeredOfficialSourceAuthorityRoot());
  if (registeredOfficialSourceRoot !== null && (options.source !== undefined || deps.defaultSource !== undefined || deps.sealedDefaultSourceResolver !== undefined)) {
    throw new Error("Manager-owned independent Tweakers refresh cannot override its registered official source.");
  }
  const registeredSourceStatus = registeredOfficialSourceRoot === null
    ? null
    : readRegisteredOfficialSource(registeredOfficialSourceRoot);
  if (registeredSourceStatus !== null
    && (registeredSourceStatus.state !== "ready" || registeredSourceStatus.artifactPath === null)) {
    throw new Error(registeredSourceStatus.problem ?? "The manager has no current sealed official source for independent Tweakers refresh.");
  }
  const sourceUsesSealedEnvironmentMode = registeredOfficialSourceRoot === null
    && options.source === undefined && deps.defaultSource === undefined;
  const sealedEnvironmentRoot = sourceUsesSealedEnvironmentMode ? environmentAuthoritySourceRoot : null;
  const source = resolve(registeredSourceStatus?.artifactPath ?? options.source ?? (
    deps.defaultSource?.()
      ?? (deps.sealedDefaultSourceResolver ?? resolveDefaultTweakersVariantSource)(environmentAuthoritySourceRoot)
  ));
  const target = resolve(options.app ?? "/Applications/Tweakers.app");
  const userRoot = resolve(
    options.userRoot
      ?? options["user-root"]
      ?? join(homedir(), "Library", "Application Support", "Tweakers", "variants", "tweakers"),
  );
  const appUserDataRoot = resolve(
    options.userData
      ?? options["user-data"]
      ?? join(userRoot, "app-data"),
  );
  // Manager status is rooted globally and observes this independent state at
  // `variants/tweakers/state.json`. Never publish a manager under the
  // variant-specific root selected above.
  const managerRoot = resolve((deps.managerRoot ?? (() => canonicalTweakersManagerRoot((deps.home ?? homedir)())))());
  const codexHomeRoot = join(userRoot, "codex-home");
  const accountsBrokerRoot = defaultTweakersAccountsBrokerRoot((deps.home ?? homedir)());
  const refresh = options.refresh === true;
  // Every production independent refresh consumes the exact Doctor-reviewed
  // package; callers cannot bypass review by using the old rebuild command.
  let reviewed: { receipt: TweakersVariantCandidateReceipt; candidatePackage: string; revalidate(): void } | null = null;
  if (refresh && target === "/Applications/Tweakers.app") {
    if (options.baselineMaintenance) {
      const check = () => verifiedBaselineMaintenance(options, source);
      const checked = check();
      if (!checked.receipt || !options.baselineMaintenance.candidatePackage) throw new Error("Baseline maintenance requires a verified candidate package");
      reviewed = { receipt: checked.receipt, candidatePackage: options.baselineMaintenance.candidatePackage,
        revalidate() { if (JSON.stringify(check().receipt) !== JSON.stringify(checked.receipt)) throw new Error("Baseline maintenance candidate changed"); } };
    } else {
      const { consumeDoctorCandidateApproval, verifyDoctorCandidate } = await import("../doctor-approval.js");
      const { assertDoctorAdoptionReady } = await import("../doctor-adoption.js");
      const { doctorImplementationScopes } = await import("../doctor-implementation.js");
      const checked = consumeDoctorCandidateApproval(managerRoot, options.runtimeReadyOperationId);
      reviewed = { receipt: checked.receipt, candidatePackage: checked.job.candidatePackage!, revalidate() {
        if (doctorImplementationScopes().promotion !== checked.promotionFingerprint) throw new Error("Promotion implementation changed before cutover");
        const fresh = verifyDoctorCandidate(managerRoot);
        if (assertDoctorAdoptionReady(managerRoot, fresh.job).fingerprint !== checked.adoptionFingerprint || fresh.job.id !== checked.job.id || JSON.stringify(fresh.receipt) !== JSON.stringify(checked.receipt)) throw new Error("Reviewed candidate changed before promotion");
      } };
    }
  }
  if (reviewed && (reviewed.receipt.source.path !== source || reviewed.receipt.identity.userRoot !== userRoot
    || reviewed.receipt.identity.appUserDataRoot !== appUserDataRoot)) throw new Error("Reviewed candidate target or source changed");
  const deferRuntimeReadyCommit = options.deferRuntimeReadyCommit === true;
  if (deferRuntimeReadyCommit && !refresh) {
    throw new Error("Deferred runtime-ready commit is valid only for an independent Tweakers refresh.");
  }
  if (deferRuntimeReadyCommit && !options.runtimeReadyOperationId) {
    throw new Error("Deferred independent Tweakers refresh requires a manager operation ID.");
  }
  if (options.runtimeReadyOperationId !== undefined) assertVariantPromotionId(options.runtimeReadyOperationId);
  const id = (deps.id ?? randomUUID)();
  const candidate = join(dirname(target), `.${basename(target)}.candidate-${id}.app`);
  const buildRoot = join(userRoot, "builds", id);
  const buildPaths = variantBuildPaths(buildRoot);

  if (source === target) throw new Error("The Tweakers variant target must differ from the official source app.");
  if (target === "/Applications/ChatGPT.app") {
    throw new Error("Refusing to create a variant at /Applications/ChatGPT.app. The official app remains untouched.");
  }
  if (!target.endsWith(".app")) throw new Error("The Tweakers variant target must be a macOS .app bundle.");
  if (!existsSync(source)) throw new Error(`Official ChatGPT source not found: ${source}`);
  const transactionLock = acquireVariantPromotionLock(userRoot, target, deps);
  let retainTransactionLock = false;
  try {
    assertNoSymlinkPathWithin(userRoot, variantPromotionJournalRoot(userRoot), "Variant promotion journal root");
    recoverInterruptedTweakersVariantPromotions(userRoot, target, deps);
    if (existsSync(candidate)) throw new Error(`Variant candidate already exists: ${candidate}`);
    if (existsSync(target) && !refresh) {
      throw new Error(`Variant target already exists: ${target}. Use refresh-variant to replace it atomically.`);
    }
    if (existsSync(buildRoot)) throw new Error(`Variant build root already exists: ${buildRoot}`);
    mkdirSync(dirname(target), { recursive: true });
    assertNoSymlinkPathWithin(userRoot, buildRoot, "Variant build root");
    ensurePrivateDirectory(buildRoot, deps);
    if (isPathWithin(userRoot, appUserDataRoot)) {
      assertNoSymlinkPathWithin(userRoot, appUserDataRoot, "Variant app-data root");
    } else {
      assertNoSymlinkAtPath(appUserDataRoot, "Variant app-data root");
    }
    mkdirSync(appUserDataRoot, { recursive: true, mode: 0o700 });
    assertNoSymlinkPathWithin(userRoot, codexHomeRoot, "Variant Codex home root");
    mkdirSync(codexHomeRoot, { recursive: true, mode: 0o700 });
    const nativeUserDataLink = linkNativeUserData(appUserDataRoot, (deps.home ?? homedir)());

    const previousHome = process.env.TWEAKERS_HOME;
    process.env.TWEAKERS_HOME = userRoot;
    let promotion: VariantPromotion | null = null;
    let beforePromotionFailed = false;
    let managerPublication: { restoreOnFailure(): void } | null = null;
    let managerEnvironmentPublication: CanonicalManagerEnvironmentPublication | null = null;
    try {
      let sealedSourceLease: ReturnType<typeof acquireSealedInactiveEnvironmentModeSourceLease> | null = null;
      let registeredSourceLease: ReturnType<typeof acquireRegisteredOfficialSourceLease> | null = null;
      try {
        if (registeredOfficialSourceRoot !== null) {
          registeredSourceLease = acquireRegisteredOfficialSourceLease(registeredOfficialSourceRoot);
          if (resolve(registeredSourceLease.receipt.artifact.appPath) !== source) {
            throw new Error("The manager registered official source changed before the Tweakers candidate was cloned.");
          }
          const expected = deps.registeredOfficialSourceBinding?.();
          if (expected !== undefined && (expected.generationId !== registeredSourceLease.pointer.generationId
            || expected.receiptDigest !== registeredSourceLease.receiptDigest)) {
            throw new Error("The manager registered official source does not match the prepared independent refresh.");
          }
        } else if (sourceUsesSealedEnvironmentMode) {
          sealedSourceLease = acquireSealedInactiveEnvironmentModeSourceLease(
            environmentModeCachePaths(sealedEnvironmentRoot!),
          );
          if (resolve(sealedSourceLease.receipt.roles.inactive.appPath) !== source) {
            throw new Error("The sealed inactive ChatGPT source changed before the Tweakers candidate was cloned.");
          }
        }
        assertOfficialSource(source, deps);
        (deps.cloneApp ?? cloneAppTree)(reviewed ? join(reviewed.candidatePackage, "Tweakers.app") : source, candidate);
        if (registeredOfficialSourceRoot !== null) {
          const after = readRegisteredOfficialSource(registeredOfficialSourceRoot);
          if (after.state !== "ready"
            || after.generationId !== registeredSourceLease!.pointer.generationId
            || after.receiptDigest !== registeredSourceLease!.receiptDigest) {
            throw new Error(after.problem ?? "The manager registered official source changed while the Tweakers candidate was cloned.");
          }
        }
      } finally {
        sealedSourceLease?.release();
        registeredSourceLease?.release();
      }
      if (reviewed) {
        for (const [name, destination] of [["runtime", buildPaths.runtime], ["tweaks", buildPaths.tweaks], ["state.json", buildPaths.stateFile], ["config.json", buildPaths.configFile]] as const) {
          const key = name === "state.json" ? "state" : name === "config.json" ? "config" : name;
          copyReviewedVariantArtifact(join(reviewed.candidatePackage, name), destination, reviewed.receipt.artifacts[key]);
        }
        if (fingerprintVariantGeneration(candidate).sha256 !== reviewed.receipt.artifacts.app.sha256) throw new Error("Copied Doctor candidate changed");
      } else {
      await (deps.installApp ?? install)({
        app: candidate,
        fuse: false,
        watcher: false,
        localSigning: true,
        macAppIdentity: defaultTweakersVariantIdentity(appUserDataRoot, userRoot, accountsBrokerRoot),
        candidateContext: { paths: buildPaths, finalUserRoot: userRoot,
          ...((options.prebuiltBackend || options.baselineMaintenance) ? { bundledDerivedBackend: verifiedVariantBackend(options, source) } : {}) },
      });
      (deps.stageTweaks ?? stageBundledTweaks)(buildPaths.tweaks, buildPaths.runtime);
      }
      if (options.accountsTransferRecovery && !reviewed) prepareAccountsTransferRecovery({ runtimeRoot: buildPaths.runtime, recoveryRoot: options.accountsTransferRecovery.root, validation: options.accountsTransferRecovery.validation });
      assertAccountsTransferRuntimeCompatible(buildPaths.runtime, [accountsBrokerRoot]);
      assertRegisteredSharedNativeBackend(candidate, accountsBrokerRoot);
      verifyCreatedVariant(
        candidate,
        buildPaths.stateFile,
        appUserDataRoot,
        codexHomeRoot,
        accountsBrokerRoot,
        deps,
        reviewed !== null,
        reviewed ? target : candidate,
      );
      if (!reviewed) prepareFinalVariantState(buildPaths, userRoot, target, id, deps);
      reviewed?.revalidate();
      // Revalidate canonical official identity before the callback may close Tweakers.
      assertNoSymlinkPathWithin((deps.home ?? homedir)(), managerRoot, "Canonical manager root");
      managerEnvironmentPublication = (
        deps.bootstrapManagerEnvironment ?? bootstrapCanonicalManagerEnvironmentSnapshot
      )({
        sourceRoot: environmentAuthoritySourceRoot,
        destinationRoot: managerRoot,
      });
      try {
        await deps.beforePromotion?.({ target, candidate, userRoot });
      } catch (error) {
        beforePromotionFailed = true;
        throw error;
      }
      // The native-account activation coordinator publishes the registration
      // at this boundary, after staging and before either app is promoted.
      assertIndependentTweakersAccountsRegistration(accountsBrokerRoot);
      assertTargetNotRunning(target, deps);
      if (reviewed) {
        // Nothing may rewrite the sealed choices between review and promotion.
        for (const [key, path] of [["app", candidate], ["runtime", buildPaths.runtime], ["tweaks", buildPaths.tweaks], ["state", buildPaths.stateFile], ["config", buildPaths.configFile]] as const) {
          if (!fingerprintsMatch(fingerprintVariantGeneration(path), reviewed.receipt.artifacts[key])) throw new Error(`Reviewed staged ${key} changed before promotion`);
        }
        reviewed.revalidate();
      }
      promotion = new VariantPromotion({
        build: buildPaths,
        userRoot,
        target,
        candidate,
        id,
        deps,
      });
      promotion.promote();
      verifyCreatedVariant(
        target,
        join(userRoot, "state.json"),
        appUserDataRoot,
        codexHomeRoot,
        accountsBrokerRoot,
        deps,
        true,
      );
      managerPublication = publishManagerAfterVariantPromotion(managerRoot, deps);
      // Keep manager publication inside the promotion's compensating window:
      // a later failure restores both variant state and the previous manager
      // descriptor before the transaction is committed.
      deps.fault?.("promotion:manager:published");
      if (deferRuntimeReadyCommit) {
        const runtimeReadyExpectation = stageIndependentTweakersRuntimeReadyExpectation({
          userRoot,
          operationId: options.runtimeReadyOperationId!,
          promotionId: id,
          target,
          appUserDataRoot,
          codexHomeRoot,
          accountsBrokerRoot,
          deps,
        });
        retainTransactionLock = true;
        let settled = false;
        let runtimeReadyVerified = false;
        const release = (): void => {
          if (!settled) return;
          transactionLock.release();
        };
        const rollback = (): void => {
          if (settled) throw new Error("Deferred independent Tweakers refresh was already finalized.");
          const rollbackErrors: unknown[] = [];
          try {
            clearIndependentTweakersRuntimeReadyEvidence(userRoot);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (managerPublication !== null) {
            try { managerPublication.restoreOnFailure(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
          }
          if (managerEnvironmentPublication !== null) {
            try { managerEnvironmentPublication.restoreOnFailure(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
          }
          rollbackErrors.push(...promotion!.rollback());
          if (nativeUserDataLink.created) {
            try { unlinkSync(nativeUserDataLink.path); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
          }
          settled = true;
          release();
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              rollbackErrors,
              "Independent Tweakers runtime-ready verification failed and its compensating rollback was incomplete.",
            );
          }
        };
        return {
          target,
          userRoot,
          runtimeReadyExpectation,
          verifyRuntimeReady(value: unknown, pid: number, processStartToken: string): void {
            if (settled) throw new Error("Deferred independent Tweakers refresh was already finalized.");
            verifyIndependentTweakersRuntimeReadyReceipt(runtimeReadyExpectation, value, pid, processStartToken);
            assertIndependentTweakersRuntimeReadyExpectationAt(userRoot, runtimeReadyExpectation);
            runtimeReadyVerified = true;
          },
          commit(): void {
            if (settled) throw new Error("Deferred independent Tweakers refresh was already finalized.");
            if (!runtimeReadyVerified) {
              throw new Error("Deferred independent Tweakers refresh requires accepted runtime-ready evidence before commit.");
            }
            try {
              promotion!.commit();
            } catch (error) {
              try {
                rollback();
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  "Independent Tweakers promotion could not commit after runtime-ready verification and rollback was incomplete.",
                );
              }
              throw error;
            }
            // The runtime-ready challenge must survive the entire provisional
            // app:promoted interval. A manager interruption after verification
            // can therefore relaunch the exact journal-bound generation and
            // obtain the same proof again. Only a durably committed promotion
            // makes the one-use challenge removable. Cleanup failure cannot
            // re-enter compensating rollback after the promotion is committed;
            // the exact stale challenge is harmless and the next staged
            // operation clears it before publishing its own expectation.
            try {
              (deps.removeRuntimeReadyExpectation ?? removeIndependentTweakersRuntimeReadyExpectation)(userRoot);
            } catch (error) {
              console.warn(kleur.yellow(
                `Independent Tweakers committed, but its stale runtime-ready challenge could not be removed: ${String((error as Error)?.message ?? error)}`,
              ));
            }
            settled = true;
            release();
          },
          rollback,
          retain() { if (settled) return; settled = true; release(); },
        };
      }
      promotion.commit();
    } catch (error) {
      if (error instanceof SimulatedVariantProcessDeath) {
        // The hook models process death: keep the durable owner record so a
        // later process, not this stack unwinding, performs stale recovery.
        retainTransactionLock = true;
        throw error;
      }
      const rollbackErrors: unknown[] = [];
      if (managerPublication !== null) {
        try {
          managerPublication.restoreOnFailure();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (managerEnvironmentPublication !== null) {
        try {
          managerEnvironmentPublication.restoreOnFailure();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      rollbackErrors.push(...(promotion?.rollback() ?? []));
      if (existsSync(candidate)) {
        try {
          (deps.archiveApp ?? renameSync)(candidate, join(buildRoot, "failed-candidate.app"));
        } catch (archiveError) {
          rollbackErrors.push(archiveError);
        }
      }
      if (nativeUserDataLink.created) unlinkSync(nativeUserDataLink.path);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Variant promotion failed and its automatic rollback was incomplete. Retained generations are available for recovery.",
        );
      }
      if (beforePromotionFailed && promotion === null) {
        throw new VariantPrePromotionAbortedError(error);
      }
      throw error;
    } finally {
      if (previousHome === undefined) delete process.env.TWEAKERS_HOME;
      else process.env.TWEAKERS_HOME = previousHome;
    }
  } finally {
    if (!retainTransactionLock) transactionLock.release();
  }

  console.log(kleur.green().bold(`✓ ${TWEAKERS_VARIANT_NAME}.app ${refresh ? "refreshed" : "created"}.`));
  console.log(`  App:      ${kleur.cyan(target)}`);
  console.log(`  State:    ${kleur.cyan(userRoot)}`);
  console.log(`  App data: ${kleur.cyan(appUserDataRoot)}`);
  console.log(`  Login:    ${kleur.cyan(codexHomeRoot)}`);
  console.log(`  Broker:   ${kleur.cyan(accountsBrokerRoot)} (manager-global)`);
  console.log("  Watcher:  disabled (the official ChatGPT app remains untouched)");
}

/** Emitted only after an aborted manager cutover hook unwinds without restoration errors. */
export class VariantPrePromotionAbortedError extends Error {
  constructor(cause: unknown) {
    super("Independent Tweakers cutover was cancelled before promotion; candidate staging was recovered", { cause });
    this.name = "VariantPrePromotionAbortedError";
  }
}

function publishManagerAfterVariantPromotion(
  managerRoot: string,
  deps: CreateVariantDeps,
): { restoreOnFailure(): void } {
  if (deps.publishManagerDescriptor) return deps.publishManagerDescriptor({ userRoot: managerRoot });
  const sealedRuntime = resolveSealedManagerRuntimeAssets();
  if (sealedRuntime !== null) {
    // A refresh invoked by the fixed native launcher is already executing
    // from a descriptor-published, target-sealed generation. Re-publishing
    // that same manager from relative package assets is both redundant and
    // invalid outside a checkout. Verify its bound runtime, then leave the
    // existing descriptor untouched so a concurrent newer publisher also
    // cannot be overwritten during variant promotion or rollback.
    verifySealedManagerRuntimeAssets(sealedRuntime);
    return { restoreOnFailure() {} };
  }
  return publishTweakersManagerDescriptor({ userRoot: managerRoot });
}

/**
 * Build a self-contained derived-app payload without touching the target app
 * or any of the identity paths embedded in the app.  In particular, this is
 * not a variant-promotion transaction: it has no transaction lock, recovery,
 * native-data symlink, state-root write, app quit, or target replacement.
 */
async function createTweakersVariantCandidateOnly(
  options: CreateVariantOptions,
  deps: CreateVariantDeps,
): Promise<void> {
  if (!options.output) {
    throw new Error("create-variant --candidate-only requires an explicit --output package root.");
  }

  const sourceUsesSealedEnvironmentMode = options.source === undefined && deps.defaultSource === undefined;
  const sealedEnvironmentRoot = sourceUsesSealedEnvironmentMode
    ? (deps.environmentRoot ?? (() => userPaths().root))()
    : null;
  const initialSealedReceipt = sourceUsesSealedEnvironmentMode
    ? readCandidateSealedSource(sealedEnvironmentRoot!, deps)
    : null;
  const source = resolve(options.source ?? deps.defaultSource?.() ?? initialSealedReceipt!.roles.inactive.appPath);
  if (options.retainRegisteredBackend) verifiedRegisteredBackendForUpstreamCandidate(options, source);
  const target = resolve(options.app ?? "/Applications/Tweakers.app");
  const userRoot = resolve(
    options.userRoot
      ?? options["user-root"]
      ?? join(homedir(), "Library", "Application Support", "Tweakers", "variants", "tweakers"),
  );
  const appUserDataRoot = resolve(
    options.userData
      ?? options["user-data"]
      ?? join(userRoot, "app-data"),
  );
  const codexHomeRoot = join(userRoot, "codex-home");
  const accountsBrokerRoot = defaultTweakersAccountsBrokerRoot(options.doctorPreviewHome ?? (deps.home ?? homedir)());
  const output = resolve(options.output);
  const id = (deps.id ?? randomUUID)();
  assertVariantPromotionId(id);
  const outputParent = dirname(output);
  const scratch = join(outputParent, `.${basename(output)}.candidate-${id}`);
  const failedScratch = join(outputParent, `.${basename(output)}.candidate-failed-${id}`);
  const candidate = join(scratch, VARIANT_CANDIDATE_ARTIFACT_PATHS.app);
  const candidatePaths = variantBuildPaths(scratch);

  const preflight = assertCandidateOutputRoot(
    output,
    outputParent,
    scratch,
    failedScratch,
    source,
    target,
    userRoot,
    appUserDataRoot,
    codexHomeRoot,
    accountsBrokerRoot,
    resolve(deps.officialAppPath?.() ?? "/Applications/ChatGPT.app"),
  );
  const preparedSigningIdentity = deps.existingSigningIdentity?.() ?? findExistingPreparedSigningIdentity();
  if (preparedSigningIdentity.created
    || preparedSigningIdentity.name !== DEFAULT_LOCAL_SIGNING_IDENTITY
    || !/^[A-Fa-f0-9]{40}$/.test(preparedSigningIdentity.hash)) {
    throw new Error("Candidate-only preparation requires one exact preexisting Tweakers Local Signing identity.");
  }
  const receiptSignature = candidateReceiptSignatureAdapter(deps);

  let parentAnchor: CandidatePackageParentAnchor | null = null;
  let currentPackage: CandidatePackageScratchAnchor | null = null;
  let retainedByPublication = false;
  try {
    parentAnchor = openCandidatePackageParentAnchor(preflight.outputParent, "Candidate output parent");
    currentPackage = createCandidatePackageScratch(scratch, parentAnchor);
    deps.afterCandidateScratchCreated?.({ scratch, outputParent });
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);

    const sourceBefore = captureCandidateSourceSnapshot(
      source,
      sourceUsesSealedEnvironmentMode,
      sealedEnvironmentRoot,
      deps,
      initialSealedReceipt,
    );
    assertOfficialSource(source, deps);
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);
    (deps.cloneApp ?? cloneAppTree)(source, candidate);
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);
    if (!fingerprintsMatch(sourceBefore.public.fingerprint, fingerprintVariantGeneration(candidate))) {
      throw new Error("Candidate source drift: the raw clone does not equal the sealed source fingerprint.");
    }
    const sourceAfter = captureCandidateSourceSnapshot(
      source,
      sourceUsesSealedEnvironmentMode,
      sealedEnvironmentRoot,
      deps,
    );
    assertCandidateSourceSnapshotMatches(sourceBefore, sourceAfter);
    assertOfficialSource(source, deps);

    await (deps.installApp ?? install)({
      app: candidate,
      fuse: false,
      watcher: false,
      localSigning: true,
      candidateOnly: true,
      preparedSigningIdentity,
      macAppIdentity: defaultTweakersVariantIdentity(appUserDataRoot, userRoot, accountsBrokerRoot),
      // This is an embedded runtime identity string only. install() uses
      // candidateContext paths for every filesystem mutation in this mode.
      candidateContext: { paths: candidatePaths, finalUserRoot: userRoot, doctorPatchRepairs: options.doctorPatchRepairs,
        ...((options.prebuiltBackend || options.baselineMaintenance || options.retainRegisteredBackend) ? { bundledDerivedBackend: verifiedVariantBackend(options, source) } : {}) },
    });
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);
    (deps.stageTweaks ?? stageBundledTweaks)(candidatePaths.tweaks, candidatePaths.runtime);
    if (options.doctorAccountsRecoveryRoot) prepareProbedAccountsTransferRecovery(candidatePaths.runtime, options.doctorAccountsRecoveryRoot);
    if (options.accountsTransferRecovery) prepareAccountsTransferRecovery({ runtimeRoot: candidatePaths.runtime, recoveryRoot: options.accountsTransferRecovery.root, validation: options.accountsTransferRecovery.validation });
    assertAccountsTransferRuntimeCompatible(candidatePaths.runtime, [accountsBrokerRoot]);
    assertRegisteredSharedNativeBackend(candidate, accountsBrokerRoot);
    if (options.retainRegisteredBackend) {
      verifiedRegisteredBackendForUpstreamCandidate(options, source);
      const installedState = JSON.parse(readFileSync(join(canonicalTweakersManagerRoot(), "variants", "tweakers", "state.json"), "utf8"));
      const candidateState = JSON.parse(readFileSync(candidatePaths.stateFile, "utf8"));
      if (candidateState.signingIdentityHash !== installedState.signingIdentityHash) throw new Error("Retained backend candidate signing identity changed");
    }
    verifyCreatedVariant(
      candidate,
      candidatePaths.stateFile,
      appUserDataRoot,
      codexHomeRoot,
      accountsBrokerRoot,
      deps,
      false,
    );
    prepareCandidateOnlyVariantState(candidatePaths, target, id, deps, options.doctorTitlebarEnabled);
    if (options.doctorConfiguration) {
      const config = structuredClone(options.doctorConfiguration);
      if (options.doctorTitlebarEnabled !== undefined) (config.tweaks as Record<string, {enabled: boolean}>)["co.tweakers.titlebar-controls"]!.enabled = options.doctorTitlebarEnabled;
      writeJsonAtomic(candidatePaths.configFile, config, id, deps, "candidate-only:frozen-config");
      const state = JSON.parse(readFileSync(candidatePaths.stateFile, "utf8"));
      state.doctorConfigurationSha256 = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      writeJsonAtomic(candidatePaths.stateFile, state, id, deps, "candidate-only:frozen-config-binding");
    }
    verifyCreatedVariant(
      candidate,
      candidatePaths.stateFile,
      appUserDataRoot,
      codexHomeRoot,
      accountsBrokerRoot,
      deps,
      true,
      target,
    );
    assertCandidateAppSigningIdentity(candidate, candidatePaths.stateFile, preparedSigningIdentity.hash, receiptSignature);
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);

    const receipt = createTweakersVariantCandidateReceipt({
      id,
      output,
      packageIdentity: { dev: currentPackage.dev, ino: currentPackage.ino },
      source: sourceBefore.public,
      target,
      userRoot,
      appUserDataRoot,
      codexHomeRoot,
      accountsBrokerRoot,
      signingIdentityHash: preparedSigningIdentity.hash,
      candidatePaths,
    });
    writeTweakersVariantCandidateReceipt(scratch, receipt, preparedSigningIdentity, receiptSignature, deps);
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);
    verifyTweakersVariantCandidateReceipt(scratch, candidateReceiptVerificationOptions({
      receipt,
      expectedObservedPackageRoot: scratch,
      officialAppPath: preflight.official.path,
      signature: receiptSignature,
      ...(deps.verifyResourceAsarIntegrity
        ? { verifyResourceAsarIntegrity: deps.verifyResourceAsarIntegrity }
        : {}),
    }));

    // The output may appear at this exact boundary. The anchored helper uses
    // RENAME_EXCL, so a raced destination remains untouched.
    deps.beforeCandidatePublication?.({ output, scratch, failedScratch });
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);
    const publication = publishCandidatePackageExclusively({
      source: currentPackage,
      destination: output,
      retentionDestination: failedScratch,
      parent: parentAnchor,
    });
    if (publication === "destination-exists") {
      throw new Error(`Candidate output already exists and will not be replaced: ${output}`);
    }
    if (publication === "retained") {
      retainedByPublication = true;
      throw new Error("Candidate package publication detected visible-parent drift and retained private evidence.");
    }
    currentPackage = { ...currentPackage, path: output, name: basename(output) };
    verifyTweakersVariantCandidateReceipt(output, candidateReceiptVerificationOptions({
      receipt,
      expectedObservedPackageRoot: output,
      officialAppPath: preflight.official.path,
      signature: receiptSignature,
      ...(deps.verifyResourceAsarIntegrity
        ? { verifyResourceAsarIntegrity: deps.verifyResourceAsarIntegrity }
        : {}),
    }));
  } catch (error) {
    // Preserve private evidence through the held descriptor only. A raced
    // failed destination is untouched and the original source remains in its
    // private sibling rather than being deleted or overwritten.
    if (!retainedByPublication && parentAnchor && currentPackage) {
      try {
        deps.beforeCandidateFailureRetention?.({ scratch: currentPackage.path, failedScratch });
        retainCandidatePackageEvidence({
          source: currentPackage,
          destination: failedScratch,
          parent: parentAnchor,
        });
      } catch {
        // The original error is actionable. Never fall back to path-following
        // retention or deletion when the anchored route cannot retain it.
      }
    }
    throw error;
  } finally {
    if (currentPackage) closeCandidatePackageScratchAnchor(currentPackage);
    if (parentAnchor) closeCandidatePackageParentAnchor(parentAnchor);
  }

  console.log(kleur.green().bold("✓ Tweakers candidate package prepared."));
  console.log(`  Package:  ${kleur.cyan(output)}`);
  console.log(`  Receipt:  ${kleur.cyan(join(output, VARIANT_CANDIDATE_RECEIPT_JSON_PATH))}`);
  console.log(`  Target:   ${kleur.cyan(target)} (identity only; not modified)`);
  console.log("  Promotion: not performed; use the established refresh transaction after separate approval.");
}

function assertCandidateOutputRoot(
  output: string,
  outputParent: string,
  scratch: string,
  failedScratch: string,
  source: string,
  target: string,
  userRoot: string,
  appUserDataRoot: string,
  codexHomeRoot: string,
  accountsBrokerRoot: string,
  officialAppPath: string,
): {
  output: CandidatePackagePathProjection;
  outputParent: CandidatePackagePathProjection;
  scratch: CandidatePackagePathProjection;
  failedScratch: CandidatePackagePathProjection;
  source: CandidatePackagePathProjection;
  target: CandidatePackagePathProjection;
  official: CandidatePackagePathProjection;
} {
  if (!isAbsolute(output) || resolve(output) !== output || output.endsWith(".app")) {
    throw new Error("Candidate output must be an exact absolute package directory, not an .app bundle path.");
  }
  if (!target.endsWith(".app")) throw new Error("The Tweakers variant target must be a macOS .app bundle.");
  const outputProjection = projectCandidatePackagePath(output, "candidate output");
  const parentProjection = projectCandidatePackagePath(outputParent, "candidate output parent");
  const scratchProjection = projectCandidatePackagePath(scratch, "candidate scratch");
  const failedProjection = projectCandidatePackagePath(failedScratch, "candidate failed scratch");
  const sourceProjection = projectCandidatePackagePath(source, "sealed candidate source");
  const targetProjection = projectCandidatePackagePath(target, "candidate target");
  const officialProjection = projectCandidatePackagePath(officialAppPath, "official ChatGPT app");
  assertCandidatePackageExistingDirectory(parentProjection, "Candidate output parent");
  assertCandidatePackageExistingDirectory(sourceProjection, "Candidate source");
  assertCandidatePackageExistingDirectory(officialProjection, "Official ChatGPT app");
  for (const [label, projection] of [
    ["Candidate output", outputProjection],
    ["Candidate scratch", scratchProjection],
    ["Candidate failed scratch", failedProjection],
  ] as const) {
    if (projection.finalIdentity !== null) throw new Error(`${label} already exists and will not be replaced: ${projection.path}`);
    if (projection.existingAncestor !== parentProjection.path || projection.unresolvedTail.length !== 1) {
      throw new Error(`${label} must be a direct child of one real owner-private output parent.`);
    }
  }
  assertCandidatePackagePathsDisjoint(sourceProjection, targetProjection, "candidate source", "candidate target");
  assertCandidatePackagePathsDisjoint(targetProjection, officialProjection, "candidate target", "official ChatGPT app");
  for (const [label, identityPath] of [
    ["installed target", target],
    ["production user root", userRoot],
    ["production app-data root", appUserDataRoot],
    ["production Codex home", codexHomeRoot],
    ["production Accounts broker", accountsBrokerRoot],
    ["sealed source", source],
    ["official ChatGPT app", officialAppPath],
  ] as const) {
    const identityProjection = identityPath === target
      ? targetProjection
      : identityPath === source
        ? sourceProjection
        : identityPath === officialAppPath
          ? officialProjection
          : projectCandidatePackagePath(identityPath, label);
    for (const [candidateLabel, candidateProjection] of [
      ["Candidate output", outputProjection],
      ["Candidate scratch", scratchProjection],
      ["Candidate failed scratch", failedProjection],
    ] as const) {
      try {
        assertCandidatePackagePathsDisjoint(candidateProjection, identityProjection, candidateLabel, label);
      } catch {
        throw new Error(`Candidate output must be physically disjoint from the ${label}; it is identity-only in candidate mode.`);
      }
    }
  }
  return {
    output: outputProjection,
    outputParent: parentProjection,
    scratch: scratchProjection,
    failedScratch: failedProjection,
    source: sourceProjection,
    target: targetProjection,
    official: officialProjection,
  };
}

interface CandidateSourceSnapshot {
  public: TweakersVariantCandidateReceipt["source"];
  sealedReceiptBytes: Buffer | null;
}

function readCandidateSealedSource(
  environmentRoot: string,
  deps: CreateVariantDeps,
): EnvironmentModePairReceipt {
  const paths = environmentModeCachePaths(resolve(environmentRoot));
  return (deps.sealedSourceReader ?? assertSealedInactiveEnvironmentModeSource)(paths);
}

/**
 * Observe a sealed source without acquiring its production cache lease. The
 * pre/post snapshots turn concurrent source changes into a fail-closed error
 * rather than a cache mutation.
 */
function captureCandidateSourceSnapshot(
  source: string,
  sourceUsesSealedEnvironmentMode: boolean,
  sealedEnvironmentRoot: string | null,
  deps: CreateVariantDeps,
  suppliedReceipt?: EnvironmentModePairReceipt | null,
): CandidateSourceSnapshot {
  const projection = projectCandidatePackagePath(source, "candidate source snapshot");
  assertCandidatePackageExistingDirectory(projection, "Candidate source");
  if (!projection.finalIdentity) throw new Error("Candidate source root identity is unavailable.");
  let sealed: TweakersVariantCandidateReceipt["source"]["sealed"] = null;
  let sealedReceiptBytes: Buffer | null = null;
  if (sourceUsesSealedEnvironmentMode) {
    const receipt = suppliedReceipt ?? readCandidateSealedSource(sealedEnvironmentRoot!, deps);
    if (resolve(receipt.roles.inactive.appPath) !== source
      || resolve(receipt.paths.inactiveAppPath) !== source) {
      throw new Error("Candidate source drift: the sealed inactive role no longer identifies the selected source.");
    }
    try {
      sealedReceiptBytes = readFileSync(receipt.paths.currentFile);
    } catch {
      throw new Error("Candidate source drift: the sealed environment receipt is unreadable.");
    }
    sealed = {
      receiptDigest: createHash("sha256").update(sealedReceiptBytes).digest("hex"),
      generationId: receipt.generationId,
      inactiveAppPath: source,
      inactiveSeal: receipt.seals.inactiveApp.sealDigest,
    };
  }
  return {
    public: {
      path: source,
      physicalPath: projection.physicalPath,
      rootIdentity: projection.finalIdentity,
      fingerprint: fingerprintVariantGeneration(source),
      sealed,
    },
    sealedReceiptBytes,
  };
}

function assertCandidateSourceSnapshotMatches(before: CandidateSourceSnapshot, after: CandidateSourceSnapshot): void {
  if ((before.sealedReceiptBytes === null) !== (after.sealedReceiptBytes === null)
    || (before.sealedReceiptBytes !== null && after.sealedReceiptBytes !== null
      && !before.sealedReceiptBytes.equals(after.sealedReceiptBytes))
    || JSON.stringify(before.public) !== JSON.stringify(after.public)) {
    throw new Error("Candidate source drift: sealed source evidence changed while the candidate was being prepared.");
  }
}

function candidateReceiptSignatureAdapter(deps: CreateVariantDeps): CandidateReceiptSignatureAdapter {
  return deps.candidateReceiptSignature ?? {
    sign: (bundlePath, preparedIdentity) => signCandidateReceiptResourceBundle(bundlePath, preparedIdentity),
    verify: (bundlePath, expectedSigningIdentityHash) => verifyCandidateReceiptResourceBundle(bundlePath, expectedSigningIdentityHash),
    certificateLeafHash: (path) => codeSigningCertificateLeafHash(path),
  };
}

function normalizedCandidateSigningHash(value: string, label: string): string {
  if (!/^[A-Fa-f0-9]{40}$/.test(value)) throw new Error(`${label} must be an exact certificate leaf hash.`);
  return value.toUpperCase();
}

function assertCandidateAppSigningIdentity(
  candidate: string,
  stateFile: string,
  expectedSigningIdentityHash: string,
  signature: CandidateReceiptSignatureAdapter,
): void {
  const expected = normalizedCandidateSigningHash(expectedSigningIdentityHash, "Prepared signing identity hash");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  if (state.signingMode !== "local-identity"
    || state.signingIdentity !== DEFAULT_LOCAL_SIGNING_IDENTITY
    || typeof state.signingIdentityHash !== "string"
    || normalizedCandidateSigningHash(state.signingIdentityHash, "Candidate state signing identity hash") !== expected) {
    throw new Error("Candidate state signing identity does not match the externally prepared identity.");
  }
  if (normalizedCandidateSigningHash(signature.certificateLeafHash(candidate), "Candidate app certificate leaf hash") !== expected) {
    throw new Error("Candidate app certificate leaf hash does not match the externally prepared identity.");
  }
}

function candidateReceiptVerificationOptions(input: {
  receipt: TweakersVariantCandidateReceipt;
  expectedObservedPackageRoot: string;
  officialAppPath: string;
  signature: CandidateReceiptSignatureAdapter;
  verifyResourceAsarIntegrity?: (appRoot: string) => void;
}): TweakersVariantCandidateReceiptVerificationOptions {
  return {
    expectedSigningIdentityHash: input.receipt.signingIdentityHash,
    expectedTransactionId: input.receipt.id,
    expectedPackageRoot: input.receipt.packageRoot,
    expectedObservedPackageRoot: input.expectedObservedPackageRoot,
    expectedSource: input.receipt.source,
    expectedIdentity: input.receipt.identity,
    officialAppPath: input.officialAppPath,
    signature: input.signature,
    ...(input.verifyResourceAsarIntegrity
      ? { verifyResourceAsarIntegrity: input.verifyResourceAsarIntegrity }
      : {}),
  };
}

function prepareCandidateOnlyVariantState(
  paths: UserPaths,
  target: string,
  id: string,
  deps: CreateVariantDeps,
  titlebarEnabled?: boolean,
): void {
  const state = JSON.parse(readFileSync(paths.stateFile, "utf8")) as Record<string, unknown>;
  state.appRoot = target;
  state.watcher = "none";
  writeJsonAtomic(paths.stateFile, state, id, deps, "candidate-only:state");
  // Candidate-only preparation must not read production config: those values
  // are identity inputs only, never a source of mutable live state.
  enableAllBundledTweaks(paths.configFile, null, paths.tweaks, id, deps);
  if (titlebarEnabled !== undefined) {
    const config = JSON.parse(readFileSync(paths.configFile, "utf8"));
    config.tweaks["co.tweakers.titlebar-controls"].enabled = titlebarEnabled;
    writeJsonAtomic(paths.configFile, config, id, deps, "candidate-only:titlebar");
  }
}

function createTweakersVariantCandidateReceipt(input: {
  id: string;
  output: string;
  packageIdentity: Pick<CandidatePackagePathIdentity, "dev" | "ino">;
  source: TweakersVariantCandidateReceipt["source"];
  target: string;
  userRoot: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  signingIdentityHash: string;
  candidatePaths: UserPaths;
}): TweakersVariantCandidateReceipt {
  return {
    version: VARIANT_CANDIDATE_RECEIPT_VERSION,
    kind: "tweakers-variant-candidate",
    id: input.id,
    packageRoot: input.output,
    packageIdentity: input.packageIdentity,
    source: input.source,
    identity: {
      appTarget: input.target,
      userRoot: input.userRoot,
      appUserDataRoot: input.appUserDataRoot,
      codexHomeRoot: input.codexHomeRoot,
      accountsBrokerRoot: input.accountsBrokerRoot,
    },
    signingIdentityHash: normalizedCandidateSigningHash(input.signingIdentityHash, "Prepared signing identity hash"),
    artifacts: {
      app: fingerprintVariantGeneration(join(input.candidatePaths.root, VARIANT_CANDIDATE_ARTIFACT_PATHS.app)),
      runtime: fingerprintVariantGeneration(input.candidatePaths.runtime),
      tweaks: fingerprintVariantGeneration(input.candidatePaths.tweaks),
      state: fingerprintVariantGeneration(input.candidatePaths.stateFile),
      config: fingerprintVariantGeneration(input.candidatePaths.configFile),
    },
  };
}

function writeTweakersVariantCandidateReceipt(
  packageRoot: string,
  receipt: TweakersVariantCandidateReceipt,
  preparedSigningIdentity: PreparedSigningIdentity,
  signature: CandidateReceiptSignatureAdapter,
  deps: Pick<CreateVariantDeps, "onDurableBoundary">,
): void {
  const bundleRoot = join(packageRoot, VARIANT_CANDIDATE_RECEIPT_BUNDLE_PATH);
  const contents = join(bundleRoot, "Contents");
  const resources = join(contents, "Resources");
  ensurePrivateDirectory(join(packageRoot, "receipt"), deps);
  ensurePrivateDirectory(bundleRoot, deps);
  ensurePrivateDirectory(contents, deps);
  ensurePrivateDirectory(resources, deps);
  const infoPath = join(contents, "Info.plist");
  writePlist(infoPath, {
    CFBundleIdentifier: VARIANT_CANDIDATE_RECEIPT_BUNDLE_IDENTIFIER,
    CFBundleName: "Tweakers Candidate Receipt",
    CFBundlePackageType: "BNDL",
    CFBundleShortVersionString: String(VARIANT_CANDIDATE_RECEIPT_VERSION),
    CFBundleVersion: String(VARIANT_CANDIDATE_RECEIPT_VERSION),
  });
  chmodSync(infoPath, 0o600);
  fsyncPath(infoPath, deps);
  const receiptPath = join(packageRoot, VARIANT_CANDIDATE_RECEIPT_JSON_PATH);
  writePrivateJsonAtomic(receiptPath, receipt, deps);
  fsyncPath(resources, deps);
  fsyncPath(contents, deps);
  signature.sign(bundleRoot, preparedSigningIdentity);
  fsyncGeneration(bundleRoot, deps);
  assertCandidateReceiptBundleLayout(packageRoot);
}

/**
 * Inspect a prepared package only with caller-owned transaction, package,
 * identity, and exact certificate-hash expectations. Legacy loose receipts
 * are deliberately not an authorization format.
 */
export function verifyTweakersVariantCandidateReceipt(
  output: string,
  options: TweakersVariantCandidateReceiptVerificationOptions,
): TweakersVariantCandidateReceipt {
  const packageRoot = resolve(output);
  if (!options || resolve(options.expectedObservedPackageRoot) !== packageRoot) {
    throw new Error("Candidate receipt verifier requires the exact caller-owned observed package root.");
  }
  if (!isCanonicalAbsolutePath(options.expectedPackageRoot)
    || !isCanonicalAbsolutePath(options.expectedObservedPackageRoot)
    || !isCanonicalAbsolutePath(options.officialAppPath ?? "/Applications/ChatGPT.app")) {
    throw new Error("Candidate receipt verifier received an inexact trusted path input.");
  }
  assertPrivateDirectory(packageRoot, "Candidate package root");
  const packageProjection = projectCandidatePackagePath(packageRoot, "candidate receipt package root");
  assertCandidatePackageExistingDirectory(packageProjection, "Candidate receipt package root");
  if (!packageProjection.finalIdentity) throw new Error("Candidate receipt package root identity is unavailable.");
  if (existsNoFollow(join(packageRoot, "variant-candidate-receipt.json"))
    || existsNoFollow(join(packageRoot, "variant-candidate-receipt.sha256"))) {
    throw new Error("Legacy loose candidate receipts are not authorization evidence.");
  }
  const { bundlePath, receiptPath } = assertCandidateReceiptBundleLayout(packageRoot);
  const signature = options.signature ?? candidateReceiptSignatureAdapter({});
  const expectedSigningIdentityHash = normalizedCandidateSigningHash(
    options.expectedSigningIdentityHash,
    "Expected signing identity hash",
  );
  signature.verify(bundlePath, expectedSigningIdentityHash);
  if (normalizedCandidateSigningHash(signature.certificateLeafHash(bundlePath), "Receipt bundle certificate leaf hash")
    !== expectedSigningIdentityHash) {
    throw new Error("Candidate receipt bundle leaf hash does not match the caller-owned expected signing identity hash.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    throw new Error("Candidate receipt is not valid JSON.");
  }
  const receipt = assertTweakersVariantCandidateReceipt(raw, options.expectedPackageRoot);
  if (receipt.id !== options.expectedTransactionId
    || receipt.packageRoot !== options.expectedPackageRoot
    || receipt.packageIdentity.dev !== packageProjection.finalIdentity.dev
    || receipt.packageIdentity.ino !== packageProjection.finalIdentity.ino
    || normalizedCandidateSigningHash(receipt.signingIdentityHash, "Candidate receipt signing identity hash") !== expectedSigningIdentityHash
    || JSON.stringify(receipt.source) !== JSON.stringify(options.expectedSource)
    || JSON.stringify(receipt.identity) !== JSON.stringify(options.expectedIdentity)) {
    throw new Error("Candidate receipt does not match the caller-owned transaction, package, source, or identity expectations.");
  }
  assertCandidateTargetIsNotOfficial(receipt.identity.appTarget, options.officialAppPath ?? "/Applications/ChatGPT.app");
  const appPath = join(packageRoot, VARIANT_CANDIDATE_ARTIFACT_PATHS.app);
  if (normalizedCandidateSigningHash(signature.certificateLeafHash(appPath), "Candidate app certificate leaf hash")
    !== expectedSigningIdentityHash) {
    throw new Error("Candidate app certificate leaf hash does not match the caller-owned expected signing identity hash.");
  }
  for (const [name, relativePath] of Object.entries(VARIANT_CANDIDATE_ARTIFACT_PATHS) as Array<[
    keyof typeof VARIANT_CANDIDATE_ARTIFACT_PATHS,
    string,
  ]>) {
    assertFingerprintAt(join(packageRoot, relativePath), receipt.artifacts[name], `candidate ${name}`);
  }
  assertCandidateReceiptSemanticBindings(
    packageRoot,
    receipt,
    expectedSigningIdentityHash,
    options.verifyResourceAsarIntegrity,
  );
  return receipt;
}

function assertTweakersVariantCandidateReceipt(
  value: unknown,
  expectedPackageRoot: string,
): TweakersVariantCandidateReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Candidate receipt must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "artifacts,id,identity,kind,packageIdentity,packageRoot,signingIdentityHash,source,version"
    || record.version !== VARIANT_CANDIDATE_RECEIPT_VERSION
    || record.kind !== "tweakers-variant-candidate"
    || typeof record.id !== "string") {
    throw new Error("Candidate receipt has an unsupported shape.");
  }
  assertVariantPromotionId(record.id);
  if (record.packageRoot !== expectedPackageRoot) {
    throw new Error("Candidate receipt is bound to a different output package root.");
  }
  const packageIdentity = assertCandidateReceiptRecord(record.packageIdentity, "Candidate receipt package identity", ["dev", "ino"]);
  assertCandidatePathIdentity(packageIdentity, "Candidate receipt package identity", false);
  const source = assertCandidateReceiptRecord(record.source, "Candidate receipt source", [
    "fingerprint", "path", "physicalPath", "rootIdentity", "sealed",
  ]);
  if (typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path) {
    throw new Error("Candidate receipt source path must be exact and absolute.");
  }
  if (typeof source.physicalPath !== "string" || !isAbsolute(source.physicalPath) || resolve(source.physicalPath) !== source.physicalPath) {
    throw new Error("Candidate receipt source physical path must be exact and absolute.");
  }
  assertCandidatePathIdentity(
    assertCandidateReceiptRecord(source.rootIdentity, "Candidate receipt source root identity", ["ctimeMs", "dev", "ino"]),
    "Candidate receipt source root identity",
    true,
  );
  assertFingerprint(source.fingerprint, "Candidate receipt source fingerprint");
  let sealed: TweakersVariantCandidateReceipt["source"]["sealed"] = null;
  if (source.sealed !== null) {
    const sealedRecord = assertCandidateReceiptRecord(source.sealed, "Candidate receipt sealed source", [
      "generationId", "inactiveAppPath", "inactiveSeal", "receiptDigest",
    ]);
    if (typeof sealedRecord.receiptDigest !== "string" || !/^[a-f0-9]{64}$/.test(sealedRecord.receiptDigest)
      || typeof sealedRecord.generationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sealedRecord.generationId)
      || sealedRecord.inactiveAppPath !== source.path
      || typeof sealedRecord.inactiveSeal !== "string" || !/^[a-f0-9]{64}$/.test(sealedRecord.inactiveSeal)) {
      throw new Error("Candidate receipt sealed source evidence is invalid.");
    }
    sealed = {
      receiptDigest: sealedRecord.receiptDigest,
      generationId: sealedRecord.generationId,
      inactiveAppPath: sealedRecord.inactiveAppPath as string,
      inactiveSeal: sealedRecord.inactiveSeal,
    };
  }
  const identity = assertCandidateReceiptRecord(record.identity, "Candidate receipt identity", [
    "accountsBrokerRoot", "appTarget", "appUserDataRoot", "codexHomeRoot", "userRoot",
  ]);
  for (const key of ["appTarget", "userRoot", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot"] as const) {
    if (typeof identity[key] !== "string" || !isAbsolute(identity[key] as string)
      || resolve(identity[key] as string) !== identity[key]) {
      throw new Error(`Candidate receipt identity ${key} must be exact and absolute.`);
    }
  }
  if (typeof identity.appTarget !== "string" || !identity.appTarget.endsWith(".app")) {
    throw new Error("Candidate receipt target must be a macOS .app bundle path.");
  }
  if (typeof record.signingIdentityHash !== "string") {
    throw new Error("Candidate receipt signing identity hash is invalid.");
  }
  const signingIdentityHash = normalizedCandidateSigningHash(record.signingIdentityHash, "Candidate receipt signing identity hash");
  const artifacts = assertCandidateReceiptRecord(record.artifacts, "Candidate receipt artifacts", [
    "app", "config", "runtime", "state", "tweaks",
  ]);
  for (const name of Object.keys(VARIANT_CANDIDATE_ARTIFACT_PATHS) as Array<keyof typeof VARIANT_CANDIDATE_ARTIFACT_PATHS>) {
    assertFingerprint(artifacts[name], `Candidate receipt ${name} fingerprint`);
  }
  return {
    version: VARIANT_CANDIDATE_RECEIPT_VERSION,
    kind: "tweakers-variant-candidate",
    id: record.id,
    packageRoot: expectedPackageRoot,
    packageIdentity: { dev: packageIdentity.dev as number, ino: packageIdentity.ino as number },
    source: {
      path: source.path,
      physicalPath: source.physicalPath,
      rootIdentity: source.rootIdentity as CandidatePackagePathIdentity,
      fingerprint: source.fingerprint as VariantGenerationFingerprint,
      sealed,
    },
    identity: {
      appTarget: identity.appTarget as string,
      userRoot: identity.userRoot as string,
      appUserDataRoot: identity.appUserDataRoot as string,
      codexHomeRoot: identity.codexHomeRoot as string,
      accountsBrokerRoot: identity.accountsBrokerRoot as string,
    },
    signingIdentityHash,
    artifacts: {
      app: artifacts.app as VariantGenerationFingerprint,
      runtime: artifacts.runtime as VariantGenerationFingerprint,
      tweaks: artifacts.tweaks as VariantGenerationFingerprint,
      state: artifacts.state as VariantGenerationFingerprint,
      config: artifacts.config as VariantGenerationFingerprint,
    },
  };
}

function assertCandidatePathIdentity(
  value: Record<string, unknown>,
  label: string,
  includeCtime: boolean,
): void {
  const keys = includeCtime ? ["ctimeMs", "dev", "ino"] : ["dev", "ino"];
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")
    || typeof value.dev !== "number" || !Number.isSafeInteger(value.dev) || value.dev < 0
    || typeof value.ino !== "number" || !Number.isSafeInteger(value.ino) || value.ino < 0
    || (includeCtime && (typeof value.ctimeMs !== "number" || !Number.isFinite(value.ctimeMs) || value.ctimeMs < 0))) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCandidateReceiptBundleLayout(packageRoot: string): { bundlePath: string; receiptPath: string } {
  const receiptDirectory = join(packageRoot, "receipt");
  const bundlePath = join(packageRoot, VARIANT_CANDIDATE_RECEIPT_BUNDLE_PATH);
  const contents = join(bundlePath, "Contents");
  const resources = join(contents, "Resources");
  const codeSignature = join(contents, "_CodeSignature");
  const receiptPath = join(packageRoot, VARIANT_CANDIDATE_RECEIPT_JSON_PATH);
  const assertDirectoryNames = (path: string, expected: readonly string[], label: string): void => {
    const projection = projectCandidatePackagePath(path, label);
    assertCandidatePackageExistingDirectory(projection, label);
    const actual = readdirSync(path).sort();
    if (actual.join(",") !== [...expected].sort().join(",")) {
      throw new Error(`${label} has an unexpected layout.`);
    }
  };
  const assertRegular = (path: string, label: string): void => {
    const stat = lstatOrNull(path);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  };
  assertDirectoryNames(receiptDirectory, ["TweakersCandidateReceipt.bundle"], "Candidate receipt directory");
  assertDirectoryNames(bundlePath, ["Contents"], "Candidate receipt bundle");
  assertDirectoryNames(contents, ["Info.plist", "Resources", "_CodeSignature"], "Candidate receipt bundle Contents");
  assertDirectoryNames(resources, ["variant-candidate-receipt.json"], "Candidate receipt Resources");
  const codeSignatureNames = readdirSync(codeSignature).sort();
  const resourceOnlyLayout = ["CodeResources"];
  // Current macOS codesign stores the detached signature components beside
  // CodeResources when a bundle intentionally has no Mach-O executable. Keep
  // accepting the older resource-only form for already prepared candidates,
  // but accept no other files in this authority-bearing directory.
  const detachedResourceLayout = ["CodeDirectory", "CodeRequirements", "CodeResources", "CodeSignature"];
  if (codeSignatureNames.join(",") !== resourceOnlyLayout.join(",")
    && codeSignatureNames.join(",") !== detachedResourceLayout.join(",")) {
    throw new Error("Candidate receipt code signature has an unexpected layout.");
  }
  assertRegular(join(contents, "Info.plist"), "Candidate receipt Info.plist");
  assertRegular(receiptPath, "Candidate receipt JSON");
  for (const name of codeSignatureNames) {
    assertRegular(join(codeSignature, name), `Candidate receipt ${name}`);
  }
  const info = readPlist(join(contents, "Info.plist"));
  if (info.CFBundleIdentifier !== VARIANT_CANDIDATE_RECEIPT_BUNDLE_IDENTIFIER
    || info.CFBundlePackageType !== "BNDL"
    || info.CFBundleVersion !== String(VARIANT_CANDIDATE_RECEIPT_VERSION)) {
    throw new Error("Candidate receipt resource bundle identity is invalid.");
  }
  return { bundlePath, receiptPath };
}

function assertCandidateTargetIsNotOfficial(target: string, officialAppPath: string): void {
  const targetProjection = projectCandidatePackagePath(target, "candidate receipt target");
  const officialProjection = projectCandidatePackagePath(officialAppPath, "official ChatGPT app");
  assertCandidatePackageExistingDirectory(officialProjection, "Official ChatGPT app");
  try {
    assertCandidatePackagePathsDisjoint(targetProjection, officialProjection, "candidate receipt target", "official ChatGPT app");
  } catch {
    throw new Error("Candidate receipt target is an official-app physical alias or overlap.");
  }
}

function assertCandidateReceiptSemanticBindings(
  packageRoot: string,
  receipt: TweakersVariantCandidateReceipt,
  expectedSigningIdentityHash: string,
  verifyIntegrity?: (appRoot: string) => void,
): void {
  const app = join(packageRoot, VARIANT_CANDIDATE_ARTIFACT_PATHS.app);
  (verifyIntegrity ?? ((appRoot: string) => {
    assertResourceAsarIntegrity({
      resourcesDir: join(appRoot, "Contents", "Resources"),
      metaPath: join(appRoot, "Contents", "Info.plist"),
      platform: "darwin",
    });
  }))(app);
  const plist = readPlist(join(app, "Contents", "Info.plist"));
  const environment = plist.LSEnvironment && typeof plist.LSEnvironment === "object" && !Array.isArray(plist.LSEnvironment)
    ? plist.LSEnvironment as Record<string, unknown>
    : null;
  const urlTypes = Array.isArray(plist.CFBundleURLTypes) ? plist.CFBundleURLTypes : [];
  const expectedUrlType = urlTypes.length === 1 && urlTypes[0] && typeof urlTypes[0] === "object"
    ? urlTypes[0] as Record<string, unknown>
    : null;
  if (plist.CFBundleIdentifier !== TWEAKERS_VARIANT_BUNDLE_ID
    || plist.CFBundleName !== TWEAKERS_VARIANT_NAME
    || plist.CFBundleDisplayName !== TWEAKERS_VARIANT_NAME
    || plist.CrProductDirName !== TWEAKERS_VARIANT_PRODUCT_NAME
    || plist.BundleSigningBaseName !== TWEAKERS_VARIANT_NAME
    || plist.CFBundleIconFile !== TWEAKERS_VARIANT_ICON_FILE
    || plist.CFBundleIconName !== undefined
    || plist.CodexAppIconBaseName !== undefined
    || plist.NSDockTilePlugIn !== undefined
    || !expectedUrlType
    || expectedUrlType.CFBundleURLName !== TWEAKERS_VARIANT_NAME
    || JSON.stringify(expectedUrlType.CFBundleURLSchemes) !== JSON.stringify([TWEAKERS_VARIANT_URL_SCHEME])
    || !environment
    || environment.CODEX_ELECTRON_USER_DATA_PATH !== receipt.identity.appUserDataRoot
    || environment.CODEX_HOME !== receipt.identity.codexHomeRoot
    || environment.CODEX_SQLITE_HOME !== receipt.identity.codexHomeRoot
    || environment.TWEAKERS_ACCOUNTS_BROKER_ROOT !== receipt.identity.accountsBrokerRoot
    || environment.TWEAKER_ACCOUNTS_BROKER_ROOT !== receipt.identity.accountsBrokerRoot
    || environment.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== "1"
    || environment.TWEAKERS_DERIVED_VARIANT !== "1") {
    throw new Error("Candidate receipt app plist or launch-environment binding is inconsistent.");
  }
  assertTweakersLauncherBindings(app, plist, receipt.identity);
  assertNoResidualOpenAIRuntimeIdentities(app);
  const state = JSON.parse(readFileSync(join(packageRoot, VARIANT_CANDIDATE_ARTIFACT_PATHS.state), "utf8")) as Record<string, unknown>;
  if (state.appRoot !== receipt.identity.appTarget
    || state.watcher !== "none"
    || state.codexBundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || state.signingMode !== "local-identity"
    || state.signingIdentity !== DEFAULT_LOCAL_SIGNING_IDENTITY
    || typeof state.signingIdentityHash !== "string"
    || normalizedCandidateSigningHash(state.signingIdentityHash, "Candidate state signing identity hash")
      !== normalizedCandidateSigningHash(expectedSigningIdentityHash, "Expected signing identity hash")) {
    throw new Error("Candidate receipt staged state binding is inconsistent.");
  }
  const config = JSON.parse(readFileSync(join(packageRoot, VARIANT_CANDIDATE_ARTIFACT_PATHS.config), "utf8")) as Record<string, unknown>;
  const frozenConfiguration = state.doctorConfigurationSha256 !== undefined;
  if (frozenConfiguration && state.doctorConfigurationSha256 !== createHash("sha256").update(JSON.stringify(config)).digest("hex")) throw new Error("Candidate frozen configuration binding changed");
  if ((!frozenConfiguration && Object.keys(config).sort().join(",") !== "tweaks") || !config.tweaks || typeof config.tweaks !== "object" || Array.isArray(config.tweaks)) {
    throw new Error("Candidate-only config is not derived from a null live configuration.");
  }
  const tweaks = config.tweaks as Record<string, unknown>;
  if (!frozenConfiguration && Object.keys(tweaks).sort().join(",") !== [...REQUIRED_TWEAKERS_TWEAKS].sort().join(",")) {
    throw new Error("Candidate-only config does not contain exactly the bundled tweak map.");
  }
  for (const id of REQUIRED_TWEAKERS_TWEAKS) {
    const setting = tweaks[id];
    if (!setting || typeof setting !== "object" || Array.isArray(setting)
      || (!frozenConfiguration && Object.keys(setting as Record<string, unknown>).sort().join(",") !== "enabled")
      || ((setting as Record<string, unknown>).enabled !== true && !(id === "co.tweakers.titlebar-controls" && (setting as Record<string, unknown>).enabled === false))) {
      throw new Error(`Candidate-only config does not enable bundled tweak ${id}.`);
    }
  }
}

function assertCandidateReceiptRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...expectedKeys].sort().join(",")) {
    throw new Error(`${label} has an unsupported shape.`);
  }
  return value as Record<string, unknown>;
}

function assertOfficialSource(source: string, deps: CreateVariantDeps): void {
  const signature = (deps.signature ?? signatureInfo)(source);
  const verified = (deps.verify ?? verifySignature)(source);
  const gatekeeper = (deps.gatekeeper ?? assessGatekeeper)(source);
  assertOpenAIDeveloperIdSourceTrust({
    signature,
    strictVerification: verified,
    gatekeeper,
  });
}

function assessGatekeeper(path: string): { ok: boolean; output: string } {
  const result = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function variantBuildPaths(root: string): UserPaths {
  return {
    root,
    runtime: join(root, "runtime"),
    tweaks: join(root, "tweaks"),
    backup: join(root, "backup"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    updateModeFile: join(root, "update-mode.json"),
    selfUpdateStateFile: join(root, "self-update-state.json"),
    binDir: join(root, "bin"),
    logDir: join(root, "log"),
    transactionRoot: join(root, "transactions", "app-install"),
    transactionStateFile: join(root, "transactions", "app-install.json"),
  };
}

function prepareFinalVariantState(
  build: UserPaths,
  userRoot: string,
  target: string,
  id: string,
  deps: CreateVariantDeps,
): void {
  const state = JSON.parse(readFileSync(build.stateFile, "utf8")) as Record<string, unknown>;
  state.appRoot = target;
  state.watcher = "none";
  writeJsonAtomic(build.stateFile, state, id, deps, "state:prepare:state");
  enableAllBundledTweaks(build.configFile, join(userRoot, "config.json"), build.tweaks, id, deps);
}

function enableAllBundledTweaks(
  configFile: string,
  currentConfigFile: string | null,
  tweaksRoot: string,
  id: string,
  deps: CreateVariantDeps,
): void {
  let config: Record<string, unknown> = {};
  if (currentConfigFile !== null && existsSync(currentConfigFile)) {
    try { config = JSON.parse(readFileSync(currentConfigFile, "utf8")) as Record<string, unknown>; } catch { config = {}; }
  }
  const existing = config.tweaks && typeof config.tweaks === "object" && !Array.isArray(config.tweaks)
    ? config.tweaks as Record<string, unknown>
    : {};
  for (const entry of readdirSync(tweaksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(tweaksRoot, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown };
      if (typeof manifest.id !== "string") continue;
      const prior = existing[manifest.id];
      existing[manifest.id] = {
        ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior as Record<string, unknown> : {}),
        enabled: true,
      };
    } catch {
      // Catalog validation rejects invalid bundled manifests before promotion.
    }
  }
  config.tweaks = existing;
  writeJsonAtomic(configFile, config, id, deps, "state:prepare:config");
}

function writeJsonAtomic(
  file: string,
  value: unknown,
  id: string,
  deps: CreateVariantDeps,
  faultPrefix: string,
): void {
  deps.fault?.(`${faultPrefix}:mkdir`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.${id}.tmp`;
  deps.fault?.(`${faultPrefix}:write`);
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsyncPath(staging, deps);
  deps.fault?.(`${faultPrefix}:rename`);
  renameSync(staging, file);
  fsyncRenameParents(staging, file, deps);
}

const LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION = 2 as const;
const VARIANT_PROMOTION_JOURNAL_VERSION = 3 as const;
const VARIANT_PROMOTION_LOCK_VERSION = 1 as const;
const VARIANT_PROMOTION_NAMES = ["runtime", "tweaks", "state.json", "config.json", "app"] as const;
const VARIANT_IMMUTABLE_PROMOTION_NAMES = ["runtime", "tweaks", "state.json", "app"] as const;

interface VariantPromotionOptions {
  build: UserPaths;
  userRoot: string;
  target: string;
  candidate: string;
  id: string;
  deps: CreateVariantDeps;
}

type VariantPromotionName = typeof VARIANT_PROMOTION_NAMES[number];
type VariantPromotionJournalVersion = typeof LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION | typeof VARIANT_PROMOTION_JOURNAL_VERSION;
type VariantGenerationKind = "file" | "directory";

interface VariantGenerationFingerprint {
  kind: VariantGenerationKind;
  mode: number;
  sha256: string;
}

interface VariantPromotionJournalEntry {
  name: VariantPromotionName;
  source: string;
  destination: string;
  archive: string;
  failed: string;
  hadDestination: boolean;
  desired: VariantGenerationFingerprint;
  previous: VariantGenerationFingerprint | null;
}

interface VariantPromotionActiveReceipt {
  version: VariantPromotionJournalVersion;
  id: string;
  userRoot: string;
  target: string;
  entries: Array<{
    name: VariantPromotionName;
    path: string;
    fingerprint: VariantGenerationFingerprint;
  }>;
}

interface VariantPromotionActiveReceiptEntry {
  source: string;
  destination: string;
  archive: string;
  failed: string;
  hadDestination: boolean;
  desired: VariantGenerationFingerprint;
  previous: VariantGenerationFingerprint | null;
  expected: VariantPromotionActiveReceipt;
}

interface VariantPromotionJournal {
  version: VariantPromotionJournalVersion;
  id: string;
  userRoot: string;
  target: string;
  candidate: string;
  buildRoot: string;
  phase: string;
  entries: VariantPromotionJournalEntry[];
  activeReceipt: VariantPromotionActiveReceiptEntry;
}

/**
 * The process-lock projection provides cross-process exclusion. This private
 * companion record binds that otherwise PID-only projection to exactly one
 * owner root and app target, so stale recovery never silently adopts another
 * variant's transaction.
 */
interface VariantPromotionLockRecord {
  version: typeof VARIANT_PROMOTION_LOCK_VERSION;
  userRoot: string;
  target: string;
  pid: number;
  ownerId: string;
}

interface VariantPromotionLockLease {
  release(): void;
}

interface VariantPromotionArtifact {
  label: string;
  source: string;
  destination: string;
  archive: string;
  failed: string;
  hadDestination: boolean;
  desired: VariantGenerationFingerprint;
  previous: VariantGenerationFingerprint | null;
}

class SimulatedVariantProcessDeath extends Error {
  constructor(phase: string) {
    super(`simulated process death after durable variant-promotion phase ${phase}`);
  }
}

function variantPromotionJournalRoot(userRoot: string): string {
  return join(userRoot, "transactions", "variant-promotion");
}

function variantPromotionTransactionsRoot(userRoot: string): string {
  return join(userRoot, "transactions");
}

function variantPromotionLockPath(userRoot: string): string {
  return join(variantPromotionTransactionsRoot(userRoot), "variant-promotion.lock");
}

function variantPromotionLockRecordPath(userRoot: string): string {
  return `${variantPromotionLockPath(userRoot)}.record`;
}

function variantPromotionLockClaimsPath(userRoot: string): string {
  return `${variantPromotionLockPath(userRoot)}.claims`;
}

function variantPromotionJournalPath(userRoot: string, id: string): string {
  return join(variantPromotionJournalRoot(userRoot), `${id}.json`);
}

function variantPromotionActiveReceiptPath(userRoot: string): string {
  return join(variantPromotionJournalRoot(userRoot), "active.json");
}

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function assertVariantPromotionId(id: unknown): asserts id is string {
  if (typeof id !== "string"
    || id === "active"
    || id === "."
    || id === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || basename(id) !== id) {
    throw new Error("Variant promotion journal has an invalid transaction ID.");
  }
}

function assertVariantPromotionLockRecord(
  value: unknown,
  userRoot: string,
  target: string,
): asserts value is VariantPromotionLockRecord {
  assertExactObjectKeys(value, ["version", "userRoot", "target", "pid", "ownerId"], "Variant transaction lock");
  const record = value as Record<string, unknown>;
  if (record.version !== VARIANT_PROMOTION_LOCK_VERSION
    || typeof record.userRoot !== "string"
    || typeof record.target !== "string"
    || typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.ownerId !== "string") {
    throw new Error("Variant transaction lock has an unsupported schema.");
  }
  assertVariantPromotionId(record.ownerId);
  if (!isCanonicalAbsolutePath(record.userRoot)
    || !isCanonicalAbsolutePath(record.target)
    || record.userRoot !== resolve(userRoot)
    || record.target !== resolve(target)) {
    throw new Error("Variant transaction lock does not match its exact user root and target binding.");
  }
}

function readVariantPromotionLockRecord(
  path: string,
  userRoot: string,
  target: string,
): VariantPromotionLockRecord {
  assertPrivateRegularFile(path, "Variant transaction lock record");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Variant transaction lock record is corrupt: ${path}`);
  }
  assertVariantPromotionLockRecord(value, userRoot, target);
  return value as VariantPromotionLockRecord;
}

function recordsMatch(left: VariantPromotionLockRecord, right: VariantPromotionLockRecord): boolean {
  return left.version === right.version
    && left.userRoot === right.userRoot
    && left.target === right.target
    && left.pid === right.pid
    && left.ownerId === right.ownerId;
}

function readVariantPromotionLockProjection(path: string): number | null {
  if (!existsNoFollow(path)) return null;
  assertPrivateRegularFile(path, "Variant transaction lock projection");
  const raw = readFileSync(path, "utf8");
  if (!/^[1-9][0-9]*\n$/.test(raw)) {
    throw new Error(`Variant transaction lock projection is corrupt: ${path}`);
  }
  const pid = Number(raw.slice(0, -1));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Variant transaction lock projection has an invalid owner: ${path}`);
  }
  return pid;
}

function variantTransactionLockOwnerIsAlive(pid: number, deps: CreateVariantDeps): boolean {
  const probe = deps.variantTransactionLockOwnerAlive ?? processAlive;
  let alive: unknown;
  try {
    alive = probe(pid);
  } catch {
    throw new Error("Unable to prove whether the existing variant transaction lock owner is stale.");
  }
  if (typeof alive !== "boolean") {
    throw new Error("Variant transaction lock liveness probe returned an invalid result.");
  }
  return alive;
}

function inspectExistingVariantPromotionLock(
  userRoot: string,
  target: string,
  deps: CreateVariantDeps,
): VariantPromotionLockRecord | null {
  const lockPath = variantPromotionLockPath(userRoot);
  const recordPath = variantPromotionLockRecordPath(userRoot);
  const projection = readVariantPromotionLockProjection(lockPath);
  if (!existsNoFollow(recordPath)) {
    if (projection !== null) {
      throw new Error("Variant transaction lock is incomplete and cannot be safely recovered.");
    }
    return null;
  }
  const record = readVariantPromotionLockRecord(recordPath, userRoot, target);
  if (projection !== null && projection !== record.pid) {
    throw new Error("Variant transaction lock projection does not match its owner-private record.");
  }
  if (projection === null && variantTransactionLockOwnerIsAlive(record.pid, deps)) {
    throw new Error("Variant transaction lock record has a live owner without its exclusive projection.");
  }
  return record;
}

/**
 * Acquire a no-follow, owner-private variant transaction lease. The generic
 * process lock supplies a bakery-election stale-owner recovery protocol; the
 * adjacent record supplies the exact root/target binding that a PID alone
 * cannot express. Candidate work cannot begin until both are durable.
 */
function acquireVariantPromotionLock(
  userRoot: string,
  target: string,
  deps: CreateVariantDeps,
): VariantPromotionLockLease {
  const resolvedRoot = resolve(userRoot);
  const resolvedTarget = resolve(target);
  const transactionsRoot = variantPromotionTransactionsRoot(resolvedRoot);
  const lockPath = variantPromotionLockPath(resolvedRoot);
  const recordPath = variantPromotionLockRecordPath(resolvedRoot);
  const claimsPath = variantPromotionLockClaimsPath(resolvedRoot);

  ensurePrivateDirectory(resolvedRoot, deps);
  assertNoSymlinkPathWithin(resolvedRoot, transactionsRoot, "Variant transaction lock root");
  ensurePrivateDirectory(transactionsRoot, deps);
  assertNoSymlinkPathWithin(resolvedRoot, lockPath, "Variant transaction lock projection");
  assertNoSymlinkAtPath(recordPath, "Variant transaction lock record");
  assertNoSymlinkPathWithin(resolvedRoot, claimsPath, "Variant transaction lock claims");
  const priorRecord = inspectExistingVariantPromotionLock(resolvedRoot, resolvedTarget, deps);

  let processLock: ProcessLock;
  try {
    processLock = acquireProcessLock(lockPath, {
      onContended: () => new Error("A Tweakers variant transaction is already active for this owner-private root."),
    });
  } catch (error) {
    throw error;
  }

  try {
    assertNoSymlinkPathWithin(resolvedRoot, lockPath, "Variant transaction lock projection");
    assertNoSymlinkAtPath(recordPath, "Variant transaction lock record");
    assertNoSymlinkPathWithin(resolvedRoot, claimsPath, "Variant transaction lock claims");
    assertPrivateRegularFile(lockPath, "Variant transaction lock projection");
    assertPrivateDirectory(claimsPath, "Variant transaction lock claims");
    if (priorRecord !== null) {
      if (variantTransactionLockOwnerIsAlive(priorRecord.pid, deps)) {
        throw new Error("Variant transaction lock owner became live before stale recovery could begin.");
      }
      const currentPrior = readVariantPromotionLockRecord(recordPath, resolvedRoot, resolvedTarget);
      if (!recordsMatch(priorRecord, currentPrior)) {
        throw new Error("Variant transaction lock record changed during stale recovery.");
      }
      unlinkSync(recordPath);
      fsyncPath(transactionsRoot, deps);
    }
    const record: VariantPromotionLockRecord = {
      version: VARIANT_PROMOTION_LOCK_VERSION,
      userRoot: resolvedRoot,
      target: resolvedTarget,
      pid: process.pid,
      ownerId: randomUUID(),
    };
    writePrivateJsonAtomic(recordPath, record, deps);
    const durableRecord = readVariantPromotionLockRecord(recordPath, resolvedRoot, resolvedTarget);
    if (!recordsMatch(record, durableRecord)) {
      throw new Error("Variant transaction lock record did not persist its exact owner binding.");
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        let releaseError: unknown = null;
        try {
          const current = readVariantPromotionLockRecord(recordPath, resolvedRoot, resolvedTarget);
          if (!recordsMatch(record, current)) {
            throw new Error("Variant transaction lock record changed before its owner released the lease.");
          }
          unlinkSync(recordPath);
          fsyncPath(transactionsRoot, deps);
        } catch (error) {
          releaseError = error;
        } finally {
          try {
            releaseVariantPromotionProcessLock(processLock, transactionsRoot, claimsPath, deps);
          } catch (error) {
            releaseError ??= error;
          }
        }
        if (releaseError !== null) throw releaseError;
      },
    };
  } catch (error) {
    try {
      releaseVariantPromotionProcessLock(processLock, transactionsRoot, claimsPath, deps);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Variant transaction lock setup failed and its exclusive projection could not be durably released.",
      );
    }
    throw error;
  }
}

function releaseVariantPromotionProcessLock(
  processLock: ProcessLock,
  transactionsRoot: string,
  claimsPath: string,
  deps: Pick<CreateVariantDeps, "onDurableBoundary">,
): void {
  processLock.release();
  // The underlying bakery lock fsyncs its PID projection, but its unlink is a
  // directory operation. Persist both the projection parent and ticket-removal
  // directory before another command can rely on this release after a crash.
  fsyncPath(claimsPath, deps);
  fsyncPath(transactionsRoot, deps);
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function existsNoFollow(path: string): boolean {
  return lstatOrNull(path) !== null;
}

function isPathWithin(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

/** Reject a symlink anywhere below an already private owner root before following a durable path. */
function assertNoSymlinkPathWithin(root: string, path: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const suffix = relative(resolvedRoot, resolvedPath);
  if (suffix === "") return;
  if (!isPathWithin(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} escapes its owner-private root: ${path}`);
  }
  let current = resolvedRoot;
  for (const segment of suffix.split("/")) {
    current = join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlinked path component: ${current}`);
    }
    if (current !== resolvedPath && !stat.isDirectory()) {
      throw new Error(`${label} has a non-directory path component: ${current}`);
    }
  }
}

function assertNoSymlinkAtPath(path: string, label: string): void {
  if (lstatOrNull(path)?.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
}

function permissionBits(stat: { mode: number | bigint }): number {
  return Number(stat.mode) & 0o777;
}

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatOrNull(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a private non-symlink directory: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  if ((permissionBits(stat) & 0o077) !== 0) {
    throw new Error(`${label} must not be group- or world-accessible: ${path}`);
  }
}

function ensurePrivateDirectory(path: string, deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {}): void {
  if (!isCanonicalAbsolutePath(path)) throw new Error(`Private variant path must be exact and absolute: ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatOrNull(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private variant path is not a directory: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`Private variant path is not owned by the current user: ${path}`);
  }
  if ((permissionBits(stat) & 0o077) !== 0) chmodSync(path, 0o700);
  assertPrivateDirectory(path, "Variant private directory");
  fsyncPath(path, deps);
}

function assertPrivateRegularFile(path: string, label: string): void {
  const stat = lstatOrNull(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  if ((permissionBits(stat) & 0o077) !== 0) {
    throw new Error(`${label} must not be group- or world-accessible: ${path}`);
  }
}

function assertMissingOrPrivateRegularFile(path: string, label: string): void {
  if (!existsNoFollow(path)) return;
  assertPrivateRegularFile(path, label);
}

function fsyncPath(path: string, deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {}): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  deps.onDurableBoundary?.(path);
}

function fsyncRenameParents(
  source: string,
  destination: string,
  deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {},
): void {
  const parents = new Set([dirname(resolve(source)), dirname(resolve(destination))]);
  for (const parent of parents) fsyncPath(parent, deps);
}

function durableRename(
  source: string,
  destination: string,
  deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {},
): void {
  renameSync(source, destination);
  fsyncRenameParents(source, destination, deps);
}

function writePrivateJsonAtomic(
  path: string,
  value: unknown,
  deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {},
): void {
  writePrivateTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, deps);
}

function writePrivateTextAtomic(
  path: string,
  value: string,
  deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {},
): void {
  const parent = dirname(path);
  assertPrivateDirectory(parent, "Variant private file parent");
  const staging = `${path}.tmp`;
  assertMissingOrPrivateRegularFile(staging, "Variant private JSON staging file");
  assertMissingOrPrivateRegularFile(path, "Variant private JSON file");
  writeFileSync(staging, value, { mode: 0o600 });
  if ((permissionBits(lstatSync(staging)) & 0o077) !== 0) chmodSync(staging, 0o600);
  assertPrivateRegularFile(staging, "Variant private JSON staging file");
  fsyncPath(staging, deps);
  durableRename(staging, path, deps);
  assertPrivateRegularFile(path, "Variant private JSON file");
}

function independentTweakersRuntimeReadyExpectationPath(userRoot: string): string {
  return join(resolve(userRoot), INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE);
}

export function independentTweakersRuntimeReadyReceiptPath(userRoot: string): string {
  return join(resolve(userRoot), INDEPENDENT_TWEAKERS_RUNTIME_READY_RECEIPT_FILE);
}

function stageIndependentTweakersRuntimeReadyExpectation(input: {
  userRoot: string;
  operationId: string;
  promotionId: string;
  target: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  deps: CreateVariantDeps;
}): IndependentTweakersRuntimeReadyExpectation {
  assertPrivateDirectory(input.userRoot, "Independent Tweakers runtime-ready root");
  assertVariantPromotionId(input.operationId);
  assertVariantPromotionId(input.promotionId);
  const runtime = readRuntimeFingerprintEvidence(join(input.userRoot, "runtime"));
  if (!runtime) {
    throw new Error("Independent Tweakers promotion has no valid active runtime fingerprint for launch readiness.");
  }
  const activePromotionReceipt = join(input.userRoot, "builds", input.promotionId, "active-receipt.json");
  assertPrivateRegularFile(activePromotionReceipt, "Independent Tweakers staged active promotion receipt");
  const activePromotionReceiptSha256 = fingerprintVariantGeneration(activePromotionReceipt).sha256;
  const brokerAuthorityExpectation = assertIndependentTweakersAccountsRegistration(input.accountsBrokerRoot);
  const expectation: IndependentTweakersRuntimeReadyExpectation = {
    schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
    kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND,
    operationId: input.operationId,
    promotionId: input.promotionId,
    activePromotionReceiptSha256,
    appRoot: resolve(input.target),
    bundleId: TWEAKERS_VARIANT_BUNDLE_ID,
    appAsarHeaderHash: readHeaderHash(join(input.target, "Contents", "Resources", "app.asar")).headerHash.toLowerCase(),
    runtimeFingerprint: runtime.fingerprint.toLowerCase(),
    appUserDataRoot: resolve(input.appUserDataRoot),
    codexHomeRoot: resolve(input.codexHomeRoot),
    accountsBrokerRoot: resolve(input.accountsBrokerRoot),
    brokerAuthorityExpectation,
    appearanceExpectation: { status: "normal", normalized: true },
    expectedTweakIds: expectedEnabledCandidateTweaks(join(input.userRoot, "config.json")),
    createdAt: new Date().toISOString(),
  };
  assertIndependentTweakersRuntimeReadyExpectation(expectation);
  clearIndependentTweakersRuntimeReadyEvidence(input.userRoot);
  writePrivateJsonAtomic(independentTweakersRuntimeReadyExpectationPath(input.userRoot), expectation, input.deps);
  return expectation;
}

/**
 * Read only a regular owner-private receipt at the exact variant root.  A
 * malformed receipt deliberately reaches the verifier as data; it is never
 * ignored as though the app had simply not become ready.
 */
export function readIndependentTweakersRuntimeReadyReceipt(userRoot: string): unknown | null {
  const path = independentTweakersRuntimeReadyReceiptPath(userRoot);
  if (!existsNoFollow(path)) return null;
  assertPrivateRegularFile(path, "Independent Tweakers runtime-ready receipt");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Independent Tweakers runtime-ready receipt is not valid JSON.");
  }
}

export function verifyIndependentTweakersRuntimeReadyReceipt(
  expectation: IndependentTweakersRuntimeReadyExpectation,
  value: unknown,
  expectedPid: number,
  expectedProcessStartToken: string,
): asserts value is IndependentTweakersRuntimeReadyReceipt {
  assertIndependentTweakersRuntimeReadyExpectation(expectation);
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new Error("Independent Tweakers runtime-ready verification requires an exact new main PID.");
  }
  if (!isProcessStartToken(expectedProcessStartToken)) {
    throw new Error("Independent Tweakers runtime-ready verification requires an exact process start token.");
  }
  assertIndependentTweakersRuntimeReadyReceipt(value);
  const receipt = value as IndependentTweakersRuntimeReadyReceipt;
  const currentBrokerAuthority = assertIndependentTweakersAccountsRegistration(expectation.accountsBrokerRoot);
  if (receipt.operationId !== expectation.operationId
    || receipt.promotionId !== expectation.promotionId
    || receipt.activePromotionReceiptSha256 !== expectation.activePromotionReceiptSha256
    || receipt.pid !== expectedPid
    || receipt.processStartToken !== expectedProcessStartToken
    || receipt.appRoot !== expectation.appRoot
    || receipt.bundleId !== expectation.bundleId
    || receipt.appAsarHeaderHash.toLowerCase() !== expectation.appAsarHeaderHash.toLowerCase()
    || receipt.runtimeFingerprint.toLowerCase() !== expectation.runtimeFingerprint.toLowerCase()
    || receipt.appUserDataRoot !== expectation.appUserDataRoot
    || receipt.codexHomeRoot !== expectation.codexHomeRoot
    || receipt.accountsBrokerRoot !== expectation.accountsBrokerRoot
    || !sameBrokerAuthorityExpectation(receipt.brokerAuthorityExpectation, expectation.brokerAuthorityExpectation)
    || !sameBrokerAuthorityExpectation(currentBrokerAuthority, expectation.brokerAuthorityExpectation)
    || !sameRuntimeReadyAppearanceBinding(receipt.appearance, expectation.appearanceExpectation)
    || receipt.mainInitialized !== true
    || receipt.preloadInitialized !== true
    || receipt.settingsMounted !== true
    || expectation.brokerAuthorityExpectation.globalRootState !== "valid-v3"
    || receipt.sharedHistoryBrokerState !== "connected"
    || !sameSortedStringSet(receipt.initializedTweakIds, expectation.expectedTweakIds)) {
    throw new Error("Independent Tweakers runtime-ready receipt does not match the prepared operation, broker authority, appearance requirement, derived-app identity, or complete tweak set.");
  }
}

function assertIndependentTweakersRuntimeReadyExpectationAt(
  userRoot: string,
  expected: IndependentTweakersRuntimeReadyExpectation,
): void {
  const path = independentTweakersRuntimeReadyExpectationPath(userRoot);
  assertPrivateRegularFile(path, "Independent Tweakers runtime-ready expectation");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Independent Tweakers runtime-ready expectation is not valid JSON.");
  }
  assertIndependentTweakersRuntimeReadyExpectation(value);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Independent Tweakers runtime-ready expectation changed before its receipt was accepted.");
  }
}

function removeIndependentTweakersRuntimeReadyExpectation(userRoot: string): void {
  const path = independentTweakersRuntimeReadyExpectationPath(userRoot);
  assertPrivateRegularFile(path, "Independent Tweakers runtime-ready expectation");
  unlinkSync(path);
  fsyncPath(resolve(userRoot));
}

function clearIndependentTweakersRuntimeReadyEvidence(userRoot: string): void {
  const root = resolve(userRoot);
  assertPrivateDirectory(root, "Independent Tweakers runtime-ready root");
  let removed = false;
  for (const [path, label] of [
    [independentTweakersRuntimeReadyExpectationPath(root), "Independent Tweakers runtime-ready expectation"],
    [independentTweakersRuntimeReadyReceiptPath(root), "Independent Tweakers runtime-ready receipt"],
  ] as const) {
    if (!existsNoFollow(path)) continue;
    assertPrivateRegularFile(path, label);
    unlinkSync(path);
    removed = true;
  }
  if (removed) fsyncPath(root);
}

function assertIndependentTweakersRuntimeReadyExpectation(
  value: unknown,
): asserts value is IndependentTweakersRuntimeReadyExpectation {
  assertExactObjectKeys(value, [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
    "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt",
  ], "Independent Tweakers runtime-ready expectation");
  const expectation = value as Record<string, unknown>;
  if (expectation.schemaVersion !== INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION
    || expectation.kind !== INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND
    || typeof expectation.operationId !== "string"
    || typeof expectation.promotionId !== "string"
    || !isSha256(expectation.activePromotionReceiptSha256)
    || !isCanonicalAbsolutePath(String(expectation.appRoot ?? ""))
    || expectation.bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || !isSha256(expectation.appAsarHeaderHash)
    || !isSha256(expectation.runtimeFingerprint)
    || !isCanonicalAbsolutePath(String(expectation.appUserDataRoot ?? ""))
    || !isCanonicalAbsolutePath(String(expectation.codexHomeRoot ?? ""))
    || !isCanonicalAbsolutePath(String(expectation.accountsBrokerRoot ?? ""))
    || !isIndependentTweakersBrokerAuthorityExpectation(expectation.brokerAuthorityExpectation)
    || !isIndependentTweakersRuntimeReadyAppearanceBinding(expectation.appearanceExpectation)
    || !isSupportedEnabledTweakSet(expectation.expectedTweakIds)
    || !isValidRfc3339(expectation.createdAt)) {
    throw new Error("Independent Tweakers runtime-ready expectation has an invalid schema.");
  }
  assertVariantPromotionId(expectation.operationId);
  assertVariantPromotionId(expectation.promotionId);
}

function assertIndependentTweakersRuntimeReadyReceipt(
  value: unknown,
): asserts value is IndependentTweakersRuntimeReadyReceipt {
  assertExactObjectKeys(value, [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "pid", "processStartToken", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
    "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "mainInitialized", "preloadInitialized",
    "appearance", "settingsMounted", "sharedHistoryBrokerState", "initializedTweakIds", "observedAt",
  ], "Independent Tweakers runtime-ready receipt");
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION
    || receipt.kind !== INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND
    || typeof receipt.operationId !== "string"
    || typeof receipt.promotionId !== "string"
    || !isSha256(receipt.activePromotionReceiptSha256)
    || !Number.isSafeInteger(receipt.pid) || (receipt.pid as number) <= 0
    || !isProcessStartToken(receipt.processStartToken)
    || !isCanonicalAbsolutePath(String(receipt.appRoot ?? ""))
    || receipt.bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || !isSha256(receipt.appAsarHeaderHash)
    || !isSha256(receipt.runtimeFingerprint)
    || !isCanonicalAbsolutePath(String(receipt.appUserDataRoot ?? ""))
    || !isCanonicalAbsolutePath(String(receipt.codexHomeRoot ?? ""))
    || !isCanonicalAbsolutePath(String(receipt.accountsBrokerRoot ?? ""))
    || !isIndependentTweakersBrokerAuthorityExpectation(receipt.brokerAuthorityExpectation)
    || !isIndependentTweakersRuntimeReadyAppearanceBinding(receipt.appearance)
    || receipt.mainInitialized !== true
    || receipt.preloadInitialized !== true
    || receipt.settingsMounted !== true
    || !["connected", "blocked"].includes(String(receipt.sharedHistoryBrokerState ?? ""))
    || !isSupportedEnabledTweakSet(receipt.initializedTweakIds)
    || !isValidRfc3339(receipt.observedAt)) {
    throw new Error("Independent Tweakers runtime-ready receipt has an invalid schema.");
  }
  assertVariantPromotionId(receipt.operationId);
  assertVariantPromotionId(receipt.promotionId);
}

function isIndependentTweakersBrokerAuthorityExpectation(
  value: unknown,
): value is IndependentTweakersBrokerAuthorityExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  return Object.keys(authority).sort().join("\0") === ["configSha256", "globalRootState"].join("\0")
    && ((authority.globalRootState === "absent" && authority.configSha256 === null)
      || (authority.globalRootState === "valid-v3" && isSha256(authority.configSha256)));
}

function isIndependentTweakersRuntimeReadyAppearanceBinding(
  value: unknown,
): value is IndependentTweakersRuntimeReadyAppearanceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const appearance = value as Record<string, unknown>;
  return Object.keys(appearance).sort().join("\0") === ["normalized", "status"].join("\0")
    && appearance.status === "normal"
    && appearance.normalized === true;
}

function sameRuntimeReadyAppearanceBinding(
  left: IndependentTweakersRuntimeReadyAppearanceBinding,
  right: IndependentTweakersRuntimeReadyAppearanceBinding,
): boolean {
  return left.status === right.status && left.normalized === right.normalized;
}

function sameBrokerAuthorityExpectation(
  left: IndependentTweakersBrokerAuthorityExpectation,
  right: IndependentTweakersBrokerAuthorityExpectation,
): boolean {
  return left.globalRootState === right.globalRootState && left.configSha256 === right.configSha256;
}

function isProcessStartToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameSortedStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
    && value.length === expected.length
    && [...value].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isValidRfc3339(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function writeVariantPromotionJournal(
  path: string,
  journal: VariantPromotionJournal,
  deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {},
): void {
  writePrivateJsonAtomic(path, journal, deps);
}

/** Preserve the sealed package's directory modes and literal link targets. */
export function copyReviewedVariantArtifact(source: string, destination: string, expected: VariantGenerationFingerprint): void {
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true });
  preserveCopiedDirectoryModes(source, destination);
  if (!fingerprintsMatch(fingerprintVariantGeneration(destination), expected)) throw new Error(`Copied candidate artifact changed: ${basename(source)}`);
}

function preserveCopiedDirectoryModes(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return;
  const destinationStat = lstatSync(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) throw new Error("Copied artifact directory identity changed");
  for (const name of readdirSync(source)) preserveCopiedDirectoryModes(join(source, name), join(destination, name));
  chmodSync(destination, permissionBits(sourceStat));
}

/** A deterministic no-follow hash for the staged immutable variant generations. */
export function fingerprintVariantGeneration(path: string): VariantGenerationFingerprint {
  const root = lstatOrNull(path);
  if (!root || root.isSymbolicLink()) {
    throw new Error(`Variant generation root must be present and non-symlinked: ${path}`);
  }
  const kind: VariantGenerationKind = root.isFile() ? "file" : root.isDirectory() ? "directory" : (() => {
    throw new Error(`Variant generation root has an unsupported type: ${path}`);
  })();
  const hash = createHash("sha256");
  hash.update("tweakers-variant-generation-v2\0");
  const visit = (entryPath: string, name: string): void => {
    const stat = lstatSync(entryPath);
    const mode = permissionBits(stat);
    hash.update(name).update("\0").update(String(mode)).update("\0");
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of readdirSync(entryPath, { withFileTypes: true }).sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ))) {
        visit(join(entryPath, entry.name), name ? `${name}/${entry.name}` : entry.name);
      }
      return;
    }
    if (stat.isFile()) {
      hash.update("file\0").update(readFileSync(entryPath));
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(readlinkSync(entryPath));
      return;
    }
    throw new Error(`Variant generation contains an unsupported entry: ${entryPath}`);
  };
  visit(path, "");
  return { kind, mode: permissionBits(root), sha256: hash.digest("hex") };
}

function assertFingerprint(value: unknown, label: string): asserts value is VariantGenerationFingerprint {
  if (!value || typeof value !== "object") throw new Error(`${label} is not an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "kind,mode,sha256"
    || (record.kind !== "file" && record.kind !== "directory")
    || typeof record.mode !== "number"
    || !Number.isInteger(record.mode)
    || record.mode < 0
    || record.mode > 0o777
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`${label} is invalid.`);
  }
}

function fingerprintsMatch(left: VariantGenerationFingerprint, right: VariantGenerationFingerprint): boolean {
  return left.kind === right.kind && left.mode === right.mode && left.sha256 === right.sha256;
}

function assertFingerprintAt(path: string, expected: VariantGenerationFingerprint, label: string): void {
  const actual = fingerprintVariantGeneration(path);
  if (!fingerprintsMatch(actual, expected)) {
    throw new Error(`Variant promotion ${label} fingerprint changed: ${path}`);
  }
}

function fsyncGeneration(path: string, deps: Pick<CreateVariantDeps, "onDurableBoundary">): void {
  const visit = (entryPath: string): void => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      fsyncPath(entryPath, deps);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Variant generation contains an unsupported entry: ${entryPath}`);
    for (const entry of readdirSync(entryPath, { withFileTypes: true })) visit(join(entryPath, entry.name));
    fsyncPath(entryPath, deps);
  };
  visit(path);
}

function expectedPromotionEntries(userRoot: string, target: string, id: string): Array<Pick<VariantPromotionJournalEntry,
  "name" | "source" | "destination" | "archive" | "failed">> {
  const resolvedRoot = resolve(userRoot);
  const resolvedTarget = resolve(target);
  const buildRoot = join(resolvedRoot, "builds", id);
  const archiveRoot = join(resolvedRoot, "previous", id);
  const failedRoot = join(buildRoot, "failed-promotion");
  return [
    {
      name: "runtime",
      source: join(buildRoot, "runtime"),
      destination: join(resolvedRoot, "runtime"),
      archive: join(archiveRoot, "state", "runtime"),
      failed: join(failedRoot, "state", "runtime"),
    },
    {
      name: "tweaks",
      source: join(buildRoot, "tweaks"),
      destination: join(resolvedRoot, "tweaks"),
      archive: join(archiveRoot, "state", "tweaks"),
      failed: join(failedRoot, "state", "tweaks"),
    },
    {
      name: "state.json",
      source: join(buildRoot, "state.json"),
      destination: join(resolvedRoot, "state.json"),
      archive: join(archiveRoot, "state", "state.json"),
      failed: join(failedRoot, "state", "state.json"),
    },
    {
      name: "config.json",
      source: join(buildRoot, "config.json"),
      destination: join(resolvedRoot, "config.json"),
      archive: join(archiveRoot, "state", "config.json"),
      failed: join(failedRoot, "state", "config.json"),
    },
    {
      name: "app",
      source: join(dirname(resolvedTarget), `.${basename(resolvedTarget)}.candidate-${id}.app`),
      destination: resolvedTarget,
      archive: join(archiveRoot, "app", basename(resolvedTarget)),
      failed: join(failedRoot, "app", basename(resolvedTarget)),
    },
  ];
}

function expectedActiveReceiptEntry(userRoot: string, id: string): Pick<VariantPromotionActiveReceiptEntry,
  "source" | "destination" | "archive" | "failed"> {
  const root = resolve(userRoot);
  const buildRoot = join(root, "builds", id);
  return {
    source: join(buildRoot, "active-receipt.json"),
    destination: variantPromotionActiveReceiptPath(root),
    archive: join(root, "previous", id, "active-receipt.json"),
    failed: join(buildRoot, "failed-promotion", "active-receipt.json"),
  };
}

function variantPromotionPhaseIsKnown(phase: string): boolean {
  if (["prepared", "promoting", "active:archive-planned", "active:archived", "active:promote-planned", "active:promoted", "committed", "recovered"].includes(phase)) {
    return true;
  }
  return VARIANT_PROMOTION_NAMES.some((name) => (
    phase === `${name}:archive-planned`
    || phase === `${name}:archived`
    || phase === `${name}:promote-planned`
    || phase === `${name}:promoted`
  ));
}

function assertExactObjectKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} has an unexpected schema.`);
  }
}

function activeReceiptEquals(
  actual: unknown,
  expected: VariantPromotionActiveReceipt,
): actual is VariantPromotionActiveReceipt {
  try {
    assertExactObjectKeys(actual, ["version", "id", "userRoot", "target", "entries"], "Variant active receipt");
    const receipt = actual as Record<string, unknown>;
    if (receipt.version !== expected.version
      || receipt.id !== expected.id
      || receipt.userRoot !== expected.userRoot
      || receipt.target !== expected.target
      || !Array.isArray(receipt.entries)
      || receipt.entries.length !== expected.entries.length) return false;
    return receipt.entries.every((entry, index) => {
      const wanted = expected.entries[index]!;
      assertExactObjectKeys(entry, ["name", "path", "fingerprint"], "Variant active receipt generation");
      const record = entry as Record<string, unknown>;
      assertFingerprint(record.fingerprint, "Variant active receipt generation fingerprint");
      const fingerprint = record.fingerprint as VariantGenerationFingerprint;
      return record.name === wanted.name
        && record.path === wanted.path
        && fingerprintsMatch(fingerprint, wanted.fingerprint);
    });
  } catch {
    return false;
  }
}

function expectedActiveReceipt(journal: Pick<VariantPromotionJournal,
  "version" | "id" | "userRoot" | "target" | "entries">): VariantPromotionActiveReceipt {
  const immutableNames = new Set<string>(VARIANT_IMMUTABLE_PROMOTION_NAMES);
  return {
    version: journal.version,
    id: journal.id,
    userRoot: journal.userRoot,
    target: journal.target,
    entries: journal.entries
      .filter((entry) => journal.version === LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION || immutableNames.has(entry.name))
      .map((entry) => ({
      name: entry.name,
      path: entry.destination,
      fingerprint: entry.desired,
      })),
  };
}

function assertVariantPromotionJournal(
  value: unknown,
  userRoot: string,
  expectedTarget?: string,
): asserts value is VariantPromotionJournal {
  assertExactObjectKeys(value, [
    "version", "id", "userRoot", "target", "candidate", "buildRoot", "phase", "entries", "activeReceipt",
  ], "Variant promotion journal");
  const journal = value as Record<string, unknown>;
  if ((journal.version !== VARIANT_PROMOTION_JOURNAL_VERSION
      && journal.version !== LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION)
    || typeof journal.id !== "string"
    || typeof journal.userRoot !== "string"
    || typeof journal.target !== "string"
    || typeof journal.candidate !== "string"
    || typeof journal.buildRoot !== "string"
    || typeof journal.phase !== "string"
    || !Array.isArray(journal.entries)) {
    throw new Error("Variant promotion journal has an unsupported schema.");
  }
  assertVariantPromotionId(journal.id);
  if (!isCanonicalAbsolutePath(journal.userRoot)
    || !isCanonicalAbsolutePath(journal.target)
    || !isCanonicalAbsolutePath(journal.candidate)
    || !isCanonicalAbsolutePath(journal.buildRoot)
    || journal.userRoot !== resolve(userRoot)
    || (expectedTarget !== undefined && journal.target !== resolve(expectedTarget))
    || !variantPromotionPhaseIsKnown(journal.phase)) {
    throw new Error("Variant promotion journal does not match its exact recovery binding.");
  }
  if (journal.buildRoot !== join(journal.userRoot, "builds", journal.id)
    || journal.candidate !== join(dirname(journal.target), `.${basename(journal.target)}.candidate-${journal.id}.app`)) {
    throw new Error("Variant promotion journal candidate or build root is unexpected.");
  }
  const expectedEntries = expectedPromotionEntries(journal.userRoot, journal.target, journal.id);
  if (journal.entries.length !== expectedEntries.length) {
    throw new Error("Variant promotion journal is missing a required replacement entry.");
  }
  for (const [index, expected] of expectedEntries.entries()) {
    const entry = journal.entries[index];
    assertExactObjectKeys(entry, ["name", "source", "destination", "archive", "failed", "hadDestination", "desired", "previous"], "Variant promotion entry");
    const record = entry as Record<string, unknown>;
    if (record.name !== expected.name
      || record.source !== expected.source
      || record.destination !== expected.destination
      || record.archive !== expected.archive
      || record.failed !== expected.failed
      || typeof record.hadDestination !== "boolean") {
      throw new Error("Variant promotion journal contains an unexpected replacement path.");
    }
    assertFingerprint(record.desired, "Variant promotion desired fingerprint");
    if (record.previous !== null) assertFingerprint(record.previous, "Variant promotion previous fingerprint");
    if ((record.hadDestination && record.previous === null) || (!record.hadDestination && record.previous !== null)) {
      throw new Error("Variant promotion journal destination history is inconsistent.");
    }
  }
  const typedJournal = value as unknown as VariantPromotionJournal;
  const expectedReceiptEntry = expectedActiveReceiptEntry(typedJournal.userRoot, typedJournal.id);
  assertExactObjectKeys(typedJournal.activeReceipt, [
    "source", "destination", "archive", "failed", "hadDestination", "desired", "previous", "expected",
  ], "Variant promotion active receipt entry");
  const active = typedJournal.activeReceipt as unknown as Record<string, unknown>;
  if (active.source !== expectedReceiptEntry.source
    || active.destination !== expectedReceiptEntry.destination
    || active.archive !== expectedReceiptEntry.archive
    || active.failed !== expectedReceiptEntry.failed
    || typeof active.hadDestination !== "boolean") {
    throw new Error("Variant promotion journal active receipt paths are unexpected.");
  }
  assertFingerprint(active.desired, "Variant promotion active receipt fingerprint");
  if (active.previous !== null) assertFingerprint(active.previous, "Variant promotion previous active receipt fingerprint");
  if ((active.hadDestination && active.previous === null) || (!active.hadDestination && active.previous !== null)) {
    throw new Error("Variant promotion journal active receipt history is inconsistent.");
  }
  if (!activeReceiptEquals(active.expected, expectedActiveReceipt(typedJournal))) {
    throw new Error("Variant promotion journal active receipt does not seal its exact generation set.");
  }
}

function assertJournalFilesystemPathsAreNoFollow(journal: VariantPromotionJournal): void {
  assertPrivateDirectory(journal.userRoot, "Variant promotion user root");
  assertNoSymlinkPathWithin(
    journal.userRoot,
    variantPromotionJournalRoot(journal.userRoot),
    "Variant promotion journal root",
  );
  assertNoSymlinkPathWithin(journal.userRoot, journal.buildRoot, "Variant promotion build root");
  for (const entry of journal.entries) {
    const ownerPaths = entry.name === "app"
      ? [entry.archive, entry.failed]
      : [entry.source, entry.destination, entry.archive, entry.failed];
    for (const path of ownerPaths) {
      assertNoSymlinkPathWithin(journal.userRoot, path, `Variant promotion ${entry.name} path`);
    }
  }
  for (const path of [
    journal.activeReceipt.source,
    journal.activeReceipt.destination,
    journal.activeReceipt.archive,
    journal.activeReceipt.failed,
  ]) {
    assertNoSymlinkPathWithin(journal.userRoot, path, "Variant promotion active receipt path");
  }
  assertNoSymlinkAtPath(journal.candidate, "Variant promotion candidate");
  assertNoSymlinkAtPath(journal.target, "Variant promotion target");
}

function assertArtifactPresent(path: string, expected: VariantGenerationFingerprint, label: string): void {
  if (!existsNoFollow(path)) throw new Error(`Variant promotion ${label} is missing: ${path}`);
  assertFingerprintAt(path, expected, label);
}

function ensureDestinationParent(path: string, deps: Pick<CreateVariantDeps, "onDurableBoundary">): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const stat = lstatOrNull(parent);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Variant promotion destination parent is unsafe: ${parent}`);
  }
  fsyncPath(parent, deps);
}

function moveNewGenerationAside(entry: VariantPromotionArtifact, deps: Pick<CreateVariantDeps, "onDurableBoundary">): void {
  if (!existsNoFollow(entry.destination)) return;
  // config.json is deliberately excluded from the committed active receipt:
  // the running Settings surface may update its cached check timestamps. A
  // pre-commit failure must still be able to retain that owner-private mutable
  // file as failed evidence and restore the journaled prior config. All other
  // promoted artifacts remain byte-for-byte immutable through recovery.
  if (entry.label === "config.json") {
    assertPrivateRegularFile(entry.destination, "Variant promotion mutable config destination before recovery");
  } else {
    assertArtifactPresent(entry.destination, entry.desired, `${entry.label} destination before recovery`);
  }
  if (existsNoFollow(entry.failed)) {
    throw new Error(`Variant promotion recovery found conflicting failed output for ${entry.label}.`);
  }
  ensurePrivateDirectory(dirname(entry.failed), deps);
  durableRename(entry.destination, entry.failed, deps);
  if (entry.label === "config.json") {
    assertPrivateRegularFile(entry.failed, "Variant promotion mutable config failed recovery copy");
  } else {
    assertArtifactPresent(entry.failed, entry.desired, `${entry.label} failed recovery copy`);
  }
}

function restoreVariantPromotionArtifact(
  entry: VariantPromotionArtifact,
  deps: Pick<CreateVariantDeps, "onDurableBoundary">,
): void {
  const sourceExists = existsNoFollow(entry.source);
  const destinationExists = existsNoFollow(entry.destination);
  const archiveExists = existsNoFollow(entry.archive);
  const failedExists = existsNoFollow(entry.failed);
  if (sourceExists) assertArtifactPresent(entry.source, entry.desired, `${entry.label} staged source`);
  if (failedExists) {
    if (entry.label === "config.json") {
      assertPrivateRegularFile(entry.failed, "Variant promotion mutable config failed recovery copy");
    } else {
      assertArtifactPresent(entry.failed, entry.desired, `${entry.label} failed recovery copy`);
    }
  }
  if (!entry.hadDestination) {
    if (sourceExists && destinationExists) {
      throw new Error(`Variant promotion recovery found both staged and live generations for ${entry.label}.`);
    }
    if (destinationExists) moveNewGenerationAside(entry, deps);
    if (!sourceExists && !destinationExists && !failedExists) {
      throw new Error(`Variant promotion recovery cannot locate the new ${entry.label} generation.`);
    }
    return;
  }

  if (entry.previous === null) throw new Error(`Variant promotion ${entry.label} is missing its prior fingerprint.`);
  if (archiveExists) assertArtifactPresent(entry.archive, entry.previous, `${entry.label} archive`);
  if (!archiveExists) {
    // Recovery itself is a sequence of durable renames. If an interruption
    // happens after the new generation was retained but after the prior
    // archive was restored, the destination is already correct and `failed`
    // is expected to coexist with it. Conversely, an untouched pre-promotion
    // entry has its new generation at `source`. Accept exactly either of those
    // two journaled layouts and reject duplicates or missing generations.
    if (destinationExists && sourceExists !== failedExists) {
      assertArtifactPresent(entry.destination, entry.previous, `${entry.label} untouched destination`);
      return;
    }
    throw new Error(`Variant promotion recovery cannot locate the prior ${entry.label} generation.`);
  }
  if (destinationExists) {
    if (sourceExists) {
      throw new Error(`Variant promotion recovery found conflicting generations for ${entry.label}.`);
    }
    moveNewGenerationAside(entry, deps);
  }
  ensureDestinationParent(entry.destination, deps);
  durableRename(entry.archive, entry.destination, deps);
  assertArtifactPresent(entry.destination, entry.previous, `${entry.label} restored destination`);
}

function activeArtifact(journal: VariantPromotionJournal): VariantPromotionArtifact {
  return {
    label: "active receipt",
    ...journal.activeReceipt,
  };
}

function recoverVariantPromotionJournal(
  journal: VariantPromotionJournal,
  deps: Pick<CreateVariantDeps, "onDurableBoundary"> = {},
): void {
  if (existsNoFollow(join(journal.buildRoot, "runtime-repair"))) {
    throw new Error("Unresolved forward runtime repair requires its exact repair operation; rollback is held.");
  }
  const runtime = journal.entries.find((entry) => entry.name === "runtime")!;
  const recoveryRuntime = existsNoFollow(runtime.archive) ? runtime.archive : runtime.destination;
  assertAccountsTransferRuntimeCompatible(recoveryRuntime, accountsTransferBrokerRoots(journal.userRoot, journal.target));
  restoreVariantPromotionArtifact(activeArtifact(journal), deps);
  for (const entry of [...journal.entries].reverse()) {
    restoreVariantPromotionArtifact({ label: entry.name, ...entry }, deps);
  }
}

function journalIdFromFileName(name: string): string | null {
  if (!name.endsWith(".json") || name === "active.json") return null;
  const id = name.slice(0, -".json".length);
  try {
    assertVariantPromotionId(id);
    return id;
  } catch {
    return null;
  }
}

function isExpectedJournalTemporaryFile(name: string): boolean {
  if (name === "active.json.tmp") return true;
  const id = name.endsWith(".json.tmp") ? name.slice(0, -".json.tmp".length) : null;
  if (id === null) return false;
  try {
    assertVariantPromotionId(id);
    return true;
  } catch {
    return false;
  }
}

/** Complete only the exact promoted generation; also handles interrupted receipt renames. */
function commitPromotedVariantJournal(journal: VariantPromotionJournal, path: string, deps: CreateVariantDeps): void {
  assertJournalFilesystemPathsAreNoFollow(journal);
  const assertGenerations = () => {
    for (const entry of journal.entries) assertArtifactPresent(entry.destination, entry.desired, `${entry.name} active generation`);
  };
  const phase = (value: string) => {
    journal.phase = value;
    writeVariantPromotionJournal(path, journal, deps);
    if (deps.crashAfterJournalPhase?.(value)) throw new SimulatedVariantProcessDeath(value);
  };
  assertGenerations();
  const entry = activeArtifact(journal);
  if (existsNoFollow(entry.source)) {
    assertArtifactPresent(entry.source, entry.desired, "staged active receipt before commit");
    if (entry.hadDestination && !existsNoFollow(entry.archive)) {
      if (!entry.previous) throw new Error("Missing prior active receipt fingerprint");
      assertArtifactPresent(entry.destination, entry.previous, "active receipt before archive");
      phase("active:archive-planned");
      ensurePrivateDirectory(dirname(entry.archive), deps);
      durableRename(entry.destination, entry.archive, deps);
      phase("active:archived");
    }
    if (entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, "archived active receipt");
    if (existsNoFollow(entry.destination)) throw new Error("Conflicting active receipt during commit");
    phase("active:promote-planned");
    ensurePrivateDirectory(dirname(entry.failed), deps);
    durableRename(entry.source, entry.destination, deps);
    phase("active:promoted");
  }
  assertArtifactPresent(entry.destination, entry.desired, "published active receipt");
  if (entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, "retained prior active receipt");
  assertGenerations();
  phase("committed");
}

export interface CombinedTweakersAppRepair {
  /** Fully staged and signed disposable app; this API never patches a live bundle. */
  sourceAppRoot: string;
  expectedSourceAppFingerprint: VariantGenerationFingerprint;
  expectedResolverBinarySha256: string;
  resolverPlan: unknown;
  expectedResolverPlanFingerprint: string;
}

export interface DeferredTweakersRuntimeRepairOptions {
  userRoot: string;
  target: string;
  pendingPromotionId: string;
  expectedJournalSha256: string;
  operationId: string;
  sourceRuntimeRoot: string;
  expectedSourceRuntimeFingerprint: VariantGenerationFingerprint;
  /** Raw SHA256 of the preceding immutable intent, required for a new attempt. */
  expectedPriorRepairFingerprint?: string;
  combinedApp?: CombinedTweakersAppRepair;
}

export interface DeferredTweakersRuntimeRepair {
  readonly target: string;
  readonly userRoot: string;
  readonly runtimeReadyExpectation: IndependentTweakersRuntimeReadyExpectation;
  verifyRuntimeReady(value: unknown, pid: number, processStartToken: string): void;
  commit(): void;
  /** Release ownership while retaining the forward generation and its recovery intent. */
  retain(): void;
}

interface RuntimeRepairIntent {
  version: 1 | 2;
  request: string;
  journal: string;
  receipt: string;
  expectation: string;
  createdAt: string;
  priorRepairFingerprint?: string | null;
}

export interface TweakersRuntimeRepairHead {
  version: 1 | 2;
  operationId: string;
  /** Raw SHA256 of the immutable intent bytes, not a generation-tree hash. */
  fingerprint: string;
}

interface RuntimeRepairNode extends TweakersRuntimeRepairHead {
  root: string;
  intent: RuntimeRepairIntent;
  prior: string | null;
}

/** Read the immutable repair chain, including the original in-place v1 attempt. */
function readRuntimeRepairChain(input: {
  userRoot: string; target: string; pendingPromotionId: string;
}): RuntimeRepairNode[] {
  const { userRoot, target, pendingPromotionId } = input;
  if (!isCanonicalAbsolutePath(userRoot) || !isCanonicalAbsolutePath(target)) throw new Error("Runtime repair requires canonical absolute paths");
  assertVariantPromotionId(pendingPromotionId);
  assertPrivateDirectory(userRoot, "Runtime repair user root");
  const root = join(userRoot, "builds", pendingPromotionId, "runtime-repair");
  assertNoSymlinkPathWithin(userRoot, root, "Runtime repair chain");
  if (!existsNoFollow(root)) return [];
  assertPrivateDirectory(root, "Runtime repair chain");
  const nodes: RuntimeRepairNode[] = [];
  const readNode = (nodeRoot: string, operationId?: string) => {
    const path = join(nodeRoot, "intent.json");
    if (!existsNoFollow(path)) return; // Unpublished private staging has never changed live state.
    assertPrivateRegularFile(path, "Runtime repair chain intent");
    const bytes = readFileSync(path, "utf8");
    const intent: RuntimeRepairIntent = JSON.parse(bytes);
    assertExactObjectKeys(intent, ["version", "request", "journal", "receipt", "expectation", "createdAt",
      ...(operationId === undefined ? [] : ["priorRepairFingerprint"])], "Runtime repair chain intent");
    if (intent.version !== (operationId === undefined ? 1 : 2)
      || typeof intent.request !== "string" || typeof intent.journal !== "string"
      || typeof intent.receipt !== "string" || typeof intent.expectation !== "string"
      || typeof intent.createdAt !== "string" || !Number.isFinite(Date.parse(intent.createdAt))) throw new Error("Invalid runtime repair chain intent");
    const request = JSON.parse(intent.request);
    assertVariantPromotionId(request.operationId);
    if (request.userRoot !== userRoot || request.target !== target || request.pendingPromotionId !== pendingPromotionId
      || (operationId !== undefined && request.operationId !== operationId)
      || createHash("sha256").update(intent.journal).digest("hex") !== request.expectedJournalSha256) throw new Error("Runtime repair chain target or journal binding changed");
    const journal = JSON.parse(intent.journal);
    assertVariantPromotionJournal(journal, userRoot, target);
    if (journal.id !== pendingPromotionId || journal.phase !== "app:promoted") throw new Error("Runtime repair chain requires a provisional journal");
    const prior = operationId === undefined ? null : intent.priorRepairFingerprint;
    if (prior !== null && (typeof prior !== "string" || !isSha256(prior))) throw new Error("Invalid runtime repair prior fingerprint");
    if (operationId !== undefined && (request.expectedPriorRepairFingerprint ?? null) !== prior) throw new Error("Runtime repair prior request binding changed");
    nodes.push({ version: intent.version, operationId: request.operationId,
      fingerprint: createHash("sha256").update(bytes).digest("hex"), root: nodeRoot, intent, prior: prior! });
  };
  readNode(root);
  const operations = join(root, "operations");
  assertNoSymlinkPathWithin(userRoot, operations, "Runtime repair operations");
  if (existsNoFollow(operations)) {
    assertPrivateDirectory(operations, "Runtime repair operations");
    const entries = readdirSync(operations, { withFileTypes: true });
    if (entries.length > 128) throw new Error("Runtime repair chain exceeds its bounded history");
    for (const entry of entries) {
      assertVariantPromotionId(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe runtime repair operation directory");
      const nodeRoot = join(operations, entry.name);
      assertPrivateDirectory(nodeRoot, "Runtime repair operation");
      readNode(nodeRoot, entry.name);
    }
  }
  const result: RuntimeRepairNode[] = [];
  let prior: string | null = null;
  while (result.length < nodes.length) {
    const children = nodes.filter((node) => node.prior === prior);
    if (children.length !== 1) throw new Error("Runtime repair chain is forked or disconnected");
    const node = children[0]!;
    if (result.some((seen) => seen.operationId === node.operationId)) throw new Error("Duplicate runtime repair operation");
    result.push(node);
    prior = node.fingerprint;
  }
  return result;
}

/** Discover the exact previous-intent fingerprint required for a successive repair. */
export function readTweakersRuntimeRepairHead(input: {
  userRoot: string; target: string; pendingPromotionId: string;
}): TweakersRuntimeRepairHead | null {
  const node = readRuntimeRepairChain(input).at(-1);
  return node ? { version: node.version, operationId: node.operationId, fingerprint: node.fingerprint } : null;
}

/**
 * Forward-only repair of an exact provisional app. The immutable intent is
 * written before the first live rename; retries replay only that same request.
 * No failure path restores an app built for an earlier account-state protocol.
 */
export function prepareDeferredTweakersRuntimeRepair(
  options: DeferredTweakersRuntimeRepairOptions,
  deps: CreateVariantDeps = {},
): DeferredTweakersRuntimeRepair {
  const { userRoot, target, pendingPromotionId, operationId, sourceRuntimeRoot } = options;
  for (const path of [userRoot, target, sourceRuntimeRoot]) {
    if (!isCanonicalAbsolutePath(path)) throw new Error("Runtime repair requires canonical absolute paths");
  }
  assertVariantPromotionId(pendingPromotionId);
  assertVariantPromotionId(operationId);
  if (!isSha256(options.expectedJournalSha256)) throw new Error("Runtime repair requires an exact journal hash");
  if (options.expectedPriorRepairFingerprint !== undefined && !isSha256(options.expectedPriorRepairFingerprint)) throw new Error("Invalid expected prior runtime repair fingerprint");
  assertFingerprint(options.expectedSourceRuntimeFingerprint, "Runtime repair source fingerprint");
  if (options.expectedSourceRuntimeFingerprint.kind !== "directory"
    || sourceRuntimeRoot === userRoot || isPathWithin(userRoot, sourceRuntimeRoot)
    || isPathWithin(sourceRuntimeRoot, userRoot) || sourceRuntimeRoot === target
    || isPathWithin(target, sourceRuntimeRoot)) throw new Error("Runtime repair source must be an independent runtime directory");
  assertNoSymlinkPathWithin(dirname(sourceRuntimeRoot), sourceRuntimeRoot, "Runtime repair source");
  assertArtifactPresent(sourceRuntimeRoot, options.expectedSourceRuntimeFingerprint, "runtime repair source");
  const sourceEvidence = readRuntimeFingerprintEvidence(sourceRuntimeRoot);
  if (!sourceEvidence) throw new Error("Runtime repair source has no valid runtime manifest");
  const brokerRoot = defaultTweakersAccountsBrokerRoot((deps.home ?? homedir)());
  assertAccountsTransferRuntimeCompatible(sourceRuntimeRoot, [brokerRoot]);
  const combined = options.combinedApp;
  const resolverPort = combined ? deps.runtimeRepairResolverPort
    ?? createRequire(import.meta.url)(join(sourceRuntimeRoot, "account-router", "shared-native-mode.js")) as RuntimeRepairResolverPort : null;
  const resolverAction = (action: "validate" | "begin" | "publish" | "finish") => {
    if (!combined || !resolverPort || typeof resolverPort.executeSharedNativeResolverTransitionAtRootV1 !== "function") throw new Error("Combined repair resolver port unavailable");
    const result = resolverPort.executeSharedNativeResolverTransitionAtRootV1({ stateRoot: brokerRoot,
      plan: combined.resolverPlan, expectedPlanFingerprint: combined.expectedResolverPlanFingerprint, action });
    const expectedState = { validate: "validated", begin: "begun", publish: "published", finish: "finished" }[action];
    const binding = { operationId, promotionId: pendingPromotionId, journalSha256: options.expectedJournalSha256,
      priorRepairFingerprint: options.expectedPriorRepairFingerprint ?? null,
      appFingerprintSha256: combined.expectedSourceAppFingerprint.sha256,
      runtimeFingerprintSha256: options.expectedSourceRuntimeFingerprint.sha256 };
    if (result.state !== expectedState || result.resolverBinarySha256 !== combined.expectedResolverBinarySha256
      || !result.binding || Object.entries(binding).some(([key, value]) => (result.binding as Record<string, unknown>)[key] !== value)) {
      throw new Error(`Combined repair resolver transition rejected: ${result.reason ?? "binding mismatch"}`);
    }
    return result;
  };
  const backendHash = (appRoot: string): string => {
    const path = join(appRoot, "Contents", "Resources", "codex");
    assertNoSymlinkPathWithin(appRoot, path, "Combined repair embedded backend");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Combined repair backend must be a regular file");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  if (combined) {
    assertFingerprint(combined.expectedSourceAppFingerprint, "Combined repair source app fingerprint");
    if (combined.expectedSourceAppFingerprint.kind !== "directory" || !isCanonicalAbsolutePath(combined.sourceAppRoot)
      || combined.sourceAppRoot === target || isPathWithin(target, combined.sourceAppRoot)
      || isPathWithin(combined.sourceAppRoot, target) || combined.sourceAppRoot === userRoot
      || isPathWithin(userRoot, combined.sourceAppRoot) || isPathWithin(combined.sourceAppRoot, userRoot)
      || !isSha256(combined.expectedResolverBinarySha256) || !/^sha256:[a-f0-9]{64}$/.test(combined.expectedResolverPlanFingerprint)) throw new Error("Invalid combined repair candidate binding");
    assertNoSymlinkAtPath(combined.sourceAppRoot, "Combined repair candidate");
    assertArtifactPresent(combined.sourceAppRoot, combined.expectedSourceAppFingerprint, "combined repair signed source app");
    if (backendHash(combined.sourceAppRoot) !== combined.expectedResolverBinarySha256) throw new Error("Combined repair signed backend fingerprint mismatch");
    verifyCreatedVariant(combined.sourceAppRoot, join(userRoot, "state.json"), join(userRoot, "app-data"),
      join(userRoot, "codex-home"), brokerRoot, deps, true, target);
    const state = JSON.parse(readFileSync(join(userRoot, "state.json"), "utf8"));
    assertCandidateAppSigningIdentity(combined.sourceAppRoot, join(userRoot, "state.json"), state.signingIdentityHash, candidateReceiptSignatureAdapter(deps));
    resolverAction("validate");
  }
  const lease = acquireVariantPromotionLock(userRoot, target, deps);
  let returned = false;
  try {
    assertTargetNotRunning(target, deps);
    const journalPath = variantPromotionJournalPath(userRoot, pendingPromotionId);
    assertNoSymlinkPathWithin(userRoot, journalPath, "Runtime repair journal");
    assertPrivateRegularFile(journalPath, "Runtime repair journal");
    const buildRoot = join(userRoot, "builds", pendingPromotionId);
    const chainRoot = join(buildRoot, "runtime-repair");
    const chain = readRuntimeRepairChain(options);
    const head = chain.at(-1);
    const existing = chain.find((node) => node.operationId === operationId);
    if (existing && existing !== head) throw new Error("Runtime repair operation was superseded by a newer attempt");
    if (!existing && (options.expectedPriorRepairFingerprint ?? null) !== (head?.fingerprint ?? null)) {
      throw new Error("Runtime repair requires the exact prior repair fingerprint");
    }
    const repairRoot = existing?.root ?? join(chainRoot, "operations", operationId);
    assertNoSymlinkPathWithin(userRoot, repairRoot, "Runtime repair evidence");
    const intentPath = join(repairRoot, "intent.json");
    const nextRuntime = join(repairRoot, "next-runtime");
    const priorRuntime = join(repairRoot, "prior-runtime");
    const priorApp = join(repairRoot, "prior-app.app");
    const nextApp = join(repairRoot, "next-app.app");
    const expectationPath = independentTweakersRuntimeReadyExpectationPath(userRoot);
    const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    const fileHash = (bytes: string) => createHash("sha256")
      .update("tweakers-variant-generation-v2\0").update("\0").update("384\0file\0").update(bytes).digest("hex");
    const request = JSON.stringify({ userRoot, target, pendingPromotionId, expectedJournalSha256: options.expectedJournalSha256,
      operationId, sourceRuntimeRoot, expectedSourceRuntimeFingerprint: options.expectedSourceRuntimeFingerprint,
      ...(options.expectedPriorRepairFingerprint === undefined ? {} : { expectedPriorRepairFingerprint: options.expectedPriorRepairFingerprint }),
      ...(combined ? { combinedApp: combined } : {}) });
    let intent: RuntimeRepairIntent;
    if (existsNoFollow(intentPath)) {
      assertPrivateRegularFile(intentPath, "Runtime repair intent");
      intent = JSON.parse(readFileSync(intentPath, "utf8"));
      assertExactObjectKeys(intent, ["version", "request", "journal", "receipt", "expectation", "createdAt",
        ...(intent.version === 2 ? ["priorRepairFingerprint"] : [])], "Runtime repair intent");
      if ((intent.version !== 1 && intent.version !== 2) || intent.request !== request || typeof intent.journal !== "string"
        || typeof intent.receipt !== "string" || typeof intent.expectation !== "string"
        || typeof intent.createdAt !== "string" || !Number.isFinite(Date.parse(intent.createdAt))) {
        throw new Error("Runtime repair intent does not match the exact request");
      }
    } else {
      const journalBytes = readFileSync(journalPath, "utf8");
      if (hash(journalBytes) !== options.expectedJournalSha256) throw new Error("Runtime repair journal drift");
      const journal = JSON.parse(journalBytes);
      assertVariantPromotionJournal(journal, userRoot, target);
      assertJournalFilesystemPathsAreNoFollow(journal);
      if (journal.id !== pendingPromotionId || journal.phase !== "app:promoted") throw new Error("Runtime repair requires an app:promoted transaction");
      for (const entry of journal.entries) assertArtifactPresent(entry.destination, entry.desired, `${entry.name} before runtime repair`);
      assertArtifactPresent(journal.activeReceipt.source, journal.activeReceipt.desired, "staged receipt before runtime repair");
      assertPrivateRegularFile(expectationPath, "Runtime repair old challenge");
      intent = { version: 2, priorRepairFingerprint: head?.fingerprint ?? null, request, journal: journalBytes,
        receipt: readFileSync(journal.activeReceipt.source, "utf8"), expectation: readFileSync(expectationPath, "utf8"), createdAt: new Date().toISOString() };
    }
    if (hash(intent.journal) !== options.expectedJournalSha256) throw new Error("Runtime repair original journal hash changed");
    const original: VariantPromotionJournal = JSON.parse(intent.journal);
    assertVariantPromotionJournal(original, userRoot, target);
    assertJournalFilesystemPathsAreNoFollow(original);
    if (original.id !== pendingPromotionId || original.phase !== "app:promoted"
      || fileHash(intent.receipt) !== original.activeReceipt.desired.sha256
      || !activeReceiptEquals(JSON.parse(intent.receipt), original.activeReceipt.expected)) throw new Error("Runtime repair original receipt binding failed");
    const oldExpectation: IndependentTweakersRuntimeReadyExpectation = JSON.parse(intent.expectation);
    assertIndependentTweakersRuntimeReadyExpectation(oldExpectation);
    if (oldExpectation.promotionId !== pendingPromotionId || oldExpectation.operationId === operationId
      || oldExpectation.activePromotionReceiptSha256 !== original.activeReceipt.desired.sha256
      || oldExpectation.appRoot !== target || oldExpectation.appUserDataRoot !== join(userRoot, "app-data")
      || oldExpectation.codexHomeRoot !== join(userRoot, "codex-home") || oldExpectation.accountsBrokerRoot !== brokerRoot
      || oldExpectation.appAsarHeaderHash !== readHeaderHash(join(combined && existsNoFollow(priorApp) ? priorApp : target, "Contents", "Resources", "app.asar")).headerHash.toLowerCase()) {
      throw new Error("Runtime repair old challenge binding failed");
    }
    const predecessor = existing ? chain.at(-2) : head;
    if (predecessor) {
      const predecessorRequest = JSON.parse(predecessor.intent.request);
      if (oldExpectation.operationId !== predecessor.operationId
        || !fingerprintsMatch(original.entries.find((entry) => entry.name === "runtime")!.desired,
          predecessorRequest.expectedSourceRuntimeFingerprint)) throw new Error("Prior runtime repair is not fully prepared; resume its exact operation first");
    }
    const runtime = original.entries.find((entry) => entry.name === "runtime")!;
    const app = original.entries.find((entry) => entry.name === "app")!;
    if (combined) {
      const oldAppRoot = existsNoFollow(priorApp) ? priorApp : target;
      assertArtifactPresent(oldAppRoot, app.desired, "retained provisional app");
      if (backendHash(oldAppRoot) !== resolverAction("validate").priorResolverBinarySha256) throw new Error("Combined repair prior backend does not match signed registration");
      assertArtifactPresent(join(combined.sourceAppRoot, "Contents", "Resources", "app.asar"),
        fingerprintVariantGeneration(join(oldAppRoot, "Contents", "Resources", "app.asar")), "combined repair unchanged desktop archive");
    }
    for (const entry of original.entries.filter((entry) => entry.name !== "runtime" && !(combined && entry.name === "app"))) {
      assertArtifactPresent(entry.destination, entry.desired, `${entry.name} during runtime repair`);
    }
    const oldRoot = existsNoFollow(priorRuntime) ? priorRuntime : runtime.destination;
    assertArtifactPresent(oldRoot, runtime.desired, "retained provisional runtime");
    if (readRuntimeFingerprintEvidence(oldRoot)?.fingerprint.toLowerCase() !== oldExpectation.runtimeFingerprint) {
      throw new Error("Runtime repair old runtime challenge drift");
    }
    const repaired: VariantPromotionJournal = JSON.parse(intent.journal);
    repaired.entries.find((entry) => entry.name === "runtime")!.desired = options.expectedSourceRuntimeFingerprint;
    if (combined) repaired.entries.find((entry) => entry.name === "app")!.desired = combined.expectedSourceAppFingerprint;
    repaired.activeReceipt.expected = expectedActiveReceipt(repaired);
    const receiptBytes = `${JSON.stringify(repaired.activeReceipt.expected, null, 2)}\n`;
    repaired.activeReceipt.desired = { kind: "file", mode: 0o600, sha256: fileHash(receiptBytes) };
    const expectation: IndependentTweakersRuntimeReadyExpectation = {
      ...oldExpectation, operationId, activePromotionReceiptSha256: repaired.activeReceipt.desired.sha256,
      runtimeFingerprint: sourceEvidence.fingerprint.toLowerCase(), createdAt: intent.createdAt,
    };
    assertIndependentTweakersRuntimeReadyExpectation(expectation);
    const current = JSON.parse(readFileSync(journalPath, "utf8"));
    const currentPhase = current.phase;
    const comparable = { ...current, phase: "app:promoted" };
    if (JSON.stringify(current) !== JSON.stringify(original)
      && (JSON.stringify(comparable) !== JSON.stringify(repaired)
        || !["app:promoted", "active:archive-planned", "active:archived", "active:promote-planned", "active:promoted"].includes(currentPhase))) {
      throw new Error("Runtime repair pending journal drift");
    }
    assertPrivateRegularFile(expectationPath, "Runtime repair current challenge");
    const currentExpectation = readFileSync(expectationPath, "utf8");
    if (currentExpectation !== intent.expectation && JSON.stringify(JSON.parse(currentExpectation)) !== JSON.stringify(expectation)) {
      throw new Error("Runtime repair challenge drift");
    }
    if (existsNoFollow(original.activeReceipt.source)) {
      assertPrivateRegularFile(original.activeReceipt.source, "Runtime repair current staged receipt");
      const currentReceipt = readFileSync(original.activeReceipt.source, "utf8");
      if (currentReceipt !== intent.receipt && currentReceipt !== receiptBytes) throw new Error("Runtime repair staged receipt drift");
    } else if (!String(currentPhase).startsWith("active:")) throw new Error("Runtime repair staged receipt is missing");
    const active = original.activeReceipt;
    if (!String(currentPhase).startsWith("active:")) {
      if (active.hadDestination) assertArtifactPresent(active.destination, active.previous!, "prior active receipt during repair");
      else if (existsNoFollow(active.destination)) throw new Error("Unexpected active receipt during repair");
    }
    ensurePrivateDirectory(chainRoot, deps);
    if (repairRoot !== chainRoot) ensurePrivateDirectory(join(chainRoot, "operations"), deps);
    ensurePrivateDirectory(repairRoot, deps);
    if (!existsNoFollow(intentPath)) {
      if (readTweakersRuntimeRepairHead(options)?.fingerprint !== head?.fingerprint) throw new Error("Runtime repair prior changed before publication");
      deps.fault?.("runtime-repair:before-intent-publication");
      writePrivateJsonAtomic(intentPath, intent, deps);
      deps.fault?.("runtime-repair:intent-published");
    }
    const intentBytes = readFileSync(intentPath, "utf8");
    const assertIntent = () => {
      assertPrivateRegularFile(intentPath, "Runtime repair intent");
      if (readFileSync(intentPath, "utf8") !== intentBytes) throw new Error("Runtime repair intent drift");
      if (readTweakersRuntimeRepairHead(options)?.fingerprint !== hash(intentBytes)) throw new Error("Runtime repair chain changed during operation");
    };
    if (combined) {
      resolverAction("begin");
      deps.fault?.("runtime-repair:resolver-blocked");
      if (!existsNoFollow(priorApp)) {
        if (existsNoFollow(nextApp) && !fingerprintsMatch(fingerprintVariantGeneration(nextApp), combined.expectedSourceAppFingerprint)) {
          assertIntent();
          durableRename(nextApp, join(repairRoot, `incomplete-app-${randomUUID()}.app`), deps);
        }
        if (!existsNoFollow(nextApp)) {
          cpSync(combined.sourceAppRoot, nextApp, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
          preserveCopiedDirectoryModes(combined.sourceAppRoot, nextApp);
          fsyncGeneration(nextApp, deps);
        }
        assertArtifactPresent(nextApp, combined.expectedSourceAppFingerprint, "staged combined app");
        assertArtifactPresent(combined.sourceAppRoot, combined.expectedSourceAppFingerprint, "combined source app before swap");
        assertIntent(); assertTargetNotRunning(target, deps);
        durableRename(target, priorApp, deps);
        deps.fault?.("runtime-repair:old-app-retained");
      }
      if (!existsNoFollow(target)) {
        assertArtifactPresent(nextApp, combined.expectedSourceAppFingerprint, "combined app before promotion");
        assertIntent();
        durableRename(nextApp, target, deps);
        deps.fault?.("runtime-repair:new-app-promoted");
      }
      assertArtifactPresent(target, combined.expectedSourceAppFingerprint, "combined repaired app");
    }
    if (!existsNoFollow(priorRuntime)) {
      if (existsNoFollow(nextRuntime)
        && !fingerprintsMatch(fingerprintVariantGeneration(nextRuntime), options.expectedSourceRuntimeFingerprint)) {
        // A killed copy may leave a partial staging tree. Retain it as
        // evidence and retry only from the independently hash-bound source.
        assertIntent();
        durableRename(nextRuntime, join(repairRoot, `incomplete-copy-${randomUUID()}`), deps);
      }
      if (!existsNoFollow(nextRuntime)) {
        cpSync(sourceRuntimeRoot, nextRuntime, { recursive: true, dereference: false, errorOnExist: true, force: false });
        fsyncGeneration(nextRuntime, deps);
      }
      assertArtifactPresent(nextRuntime, options.expectedSourceRuntimeFingerprint, "staged repair runtime");
      assertArtifactPresent(sourceRuntimeRoot, options.expectedSourceRuntimeFingerprint, "runtime repair source before swap");
      assertIntent();
      assertTargetNotRunning(target, deps);
      durableRename(runtime.destination, priorRuntime, deps);
      deps.fault?.("runtime-repair:old-runtime-retained");
    }
    if (!existsNoFollow(runtime.destination)) {
      assertArtifactPresent(nextRuntime, options.expectedSourceRuntimeFingerprint, "repair runtime before promotion");
      assertIntent();
      durableRename(nextRuntime, runtime.destination, deps);
      deps.fault?.("runtime-repair:new-runtime-promoted");
    }
    assertArtifactPresent(runtime.destination, options.expectedSourceRuntimeFingerprint, "repaired runtime");
    assertIntent();
    if (combined) {
      resolverAction("publish");
      deps.fault?.("runtime-repair:resolver-published");
    }
    if (!String(currentPhase).startsWith("active:")) {
      writePrivateJsonAtomic(repaired.activeReceipt.source, repaired.activeReceipt.expected, deps);
      assertArtifactPresent(repaired.activeReceipt.source, repaired.activeReceipt.desired, "repaired staged receipt");
      writeVariantPromotionJournal(journalPath, repaired, deps);
    } else repaired.phase = currentPhase;
    if (JSON.stringify(JSON.parse(currentExpectation)) !== JSON.stringify(expectation)) {
      const oldReceipt = independentTweakersRuntimeReadyReceiptPath(userRoot);
      if (existsNoFollow(oldReceipt)) {
        assertPrivateRegularFile(oldReceipt, "Runtime repair stale readiness receipt");
        unlinkSync(oldReceipt);
        fsyncPath(userRoot, deps);
      }
      // Atomic replacement keeps either the original or repaired challenge
      // readable if the owner dies at a durability boundary.
      writePrivateJsonAtomic(expectationPath, expectation, deps);
    }
    if (combined) {
      assertIntent();
      resolverAction("finish");
      deps.fault?.("runtime-repair:resolver-finished");
    }
    let settled = false;
    let verified = false;
    const assertPending = () => {
      if (settled) throw new Error("Runtime repair was already finalized");
      assertIntent();
      if (JSON.stringify(JSON.parse(readFileSync(journalPath, "utf8"))) !== JSON.stringify(repaired)) throw new Error("Runtime repair journal changed before commit");
      assertIndependentTweakersRuntimeReadyExpectationAt(userRoot, expectation);
      if (combined) {
        resolverAction("finish");
        if (backendHash(target) !== combined.expectedResolverBinarySha256) throw new Error("Combined repaired backend changed before commit");
      }
      for (const entry of repaired.entries) assertArtifactPresent(entry.destination, entry.desired, `${entry.name} repaired generation`);
    };
    returned = true;
    return {
      target, userRoot, runtimeReadyExpectation: expectation,
      verifyRuntimeReady(value, pid, processStartToken) {
        assertPending();
        verifyIndependentTweakersRuntimeReadyReceipt(expectation, value, pid, processStartToken);
        verified = true;
      },
      commit() {
        assertPending();
        if (!verified) throw new Error("Runtime repair requires accepted fresh runtime-ready evidence before commit");
        commitPromotedVariantJournal(repaired, journalPath, deps);
        settled = true;
        try { removeIndependentTweakersRuntimeReadyExpectation(userRoot); } finally { lease.release(); }
      },
      retain() { if (settled) return; settled = true; lease.release(); },
    };
  } finally {
    if (!returned) lease.release();
  }
}

/** Recover an interrupted variant promotion only when its exact target is supplied by the caller. */
export function recoverInterruptedTweakersVariantPromotions(
  userRoot: string,
  expectedTarget?: string,
  deps: Pick<CreateVariantDeps, "onDurableBoundary" | "targetProcessRunning"> = {},
): void {
  const resolvedRoot = resolve(userRoot);
  const root = variantPromotionJournalRoot(resolvedRoot);
  if (!existsNoFollow(root)) return;
  assertPrivateDirectory(resolvedRoot, "Variant promotion user root");
  assertNoSymlinkPathWithin(resolvedRoot, root, "Variant promotion journal root");
  assertPrivateDirectory(root, "Variant promotion journal root");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name === "active.json") {
      assertPrivateRegularFile(path, "Variant promotion active receipt");
      continue;
    }
    if (isExpectedJournalTemporaryFile(entry.name)) {
      assertPrivateRegularFile(path, "Variant promotion journal staging file");
      continue;
    }
    const id = journalIdFromFileName(entry.name);
    if (!id || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Variant promotion journal root contains an unexpected entry: ${entry.name}`);
    }
    assertPrivateRegularFile(path, "Variant promotion journal");
    let journal: unknown;
    try {
      journal = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new Error(`Variant promotion journal is corrupt: ${path}`);
    }
    assertVariantPromotionJournal(journal, resolvedRoot, expectedTarget);
    assertJournalFilesystemPathsAreNoFollow(journal);
    if (journal.id !== id) throw new Error("Variant promotion journal file name does not match its transaction ID.");
    if (journal.phase === "committed" || journal.phase === "recovered") continue;
    if (expectedTarget === undefined) {
      throw new Error("An interrupted variant promotion requires an exact target path before recovery.");
    }
    assertTargetNotRunning(expectedTarget, deps);
    recoverVariantPromotionJournal(journal, deps);
    journal.phase = "recovered";
    writeVariantPromotionJournal(path, journal, deps);
  }
}

function isExactTargetAppProcessRunning(target: string): boolean {
  const result = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to inspect the exact Tweakers target process before promotion.");
  }
  const exactRoot = `${resolve(target)}/`;
  return `${result.stdout ?? ""}`.split("\n").some((line) => line.trimStart().startsWith(exactRoot));
}

function assertTargetNotRunning(target: string, deps: CreateVariantDeps): void {
  if ((deps.targetProcessRunning ?? isExactTargetAppProcessRunning)(target)) {
    throw new Error("Refusing variant promotion while the exact Tweakers target app or helper process is running.");
  }
}

/**
 * Durable write-ahead journal for the only paths that turn a validated
 * candidate into the active derived app. The journal is sealed before the
 * first live rename; active receipt publication occurs before `committed`, so
 * a newly swapped app never starts with an old generation of state.
 */
class VariantPromotion {
  readonly #archiveRoot: string;
  readonly #failedRoot: string;
  readonly #journalPath: string;
  readonly #journal: VariantPromotionJournal;
  #committed = false;

  constructor(private readonly options: VariantPromotionOptions) {
    assertVariantPromotionId(options.id);
    this.#archiveRoot = join(options.userRoot, "previous", options.id);
    this.#failedRoot = join(options.build.root, "failed-promotion");
    this.#journalPath = variantPromotionJournalPath(options.userRoot, options.id);
    assertNoSymlinkPathWithin(options.userRoot, this.#journalPath, "Variant promotion journal path");
    ensurePrivateDirectory(variantPromotionJournalRoot(options.userRoot), options.deps);
    const entries = this.entries();
    for (const entry of entries) {
      fsyncGeneration(entry.source, options.deps);
      assertFingerprintAt(entry.source, entry.desired, `${entry.name} staged source`);
    }
    const base = {
      version: VARIANT_PROMOTION_JOURNAL_VERSION,
      id: options.id,
      userRoot: resolve(options.userRoot),
      target: resolve(options.target),
      candidate: resolve(options.candidate),
      buildRoot: resolve(options.build.root),
      phase: "prepared",
      entries,
    } satisfies Omit<VariantPromotionJournal, "activeReceipt">;
    const receipt = expectedActiveReceipt(base);
    const activePaths = expectedActiveReceiptEntry(base.userRoot, base.id);
    writePrivateJsonAtomic(activePaths.source, receipt, options.deps);
    const activeReceipt: VariantPromotionActiveReceiptEntry = {
      ...activePaths,
      hadDestination: existsNoFollow(activePaths.destination),
      desired: fingerprintVariantGeneration(activePaths.source),
      previous: existsNoFollow(activePaths.destination)
        ? fingerprintVariantGeneration(activePaths.destination)
        : null,
      expected: receipt,
    };
    this.#journal = { ...base, activeReceipt };
    assertVariantPromotionJournal(this.#journal, options.userRoot, options.target);
    assertJournalFilesystemPathsAreNoFollow(this.#journal);
    this.persistPhase("prepared");
  }

  promote(): void {
    assertJournalFilesystemPathsAreNoFollow(this.#journal);
    assertTargetNotRunning(this.options.target, this.options.deps);
    assertAccountsTransferRuntimeCompatible(this.options.build.runtime, accountsTransferBrokerRoots(this.options.userRoot, this.options.candidate));
    for (const [point, path] of [
      ["promotion:prepare:archive", this.#archiveRoot],
      ["promotion:prepare:failed", this.#failedRoot],
    ] as const) {
      this.options.deps.fault?.(`${point}:mkdir`);
      ensurePrivateDirectory(path, this.options.deps);
    }
    this.persistPhase("promoting");
    for (const entry of this.#journal.entries) this.replace(entry);
  }

  commit(): void {
    commitPromotedVariantJournal(this.#journal, this.#journalPath, this.options.deps);
    this.#committed = true;
  }

  rollback(): unknown[] {
    if (this.#committed) return [];
    try {
      assertJournalFilesystemPathsAreNoFollow(this.#journal);
      assertTargetNotRunning(this.options.target, this.options.deps);
      recoverVariantPromotionJournal(this.#journal, this.options.deps);
      this.persistPhase("recovered");
      return [];
    } catch (error) {
      return [error];
    }
  }

  private entries(): VariantPromotionJournalEntry[] {
    return expectedPromotionEntries(this.options.userRoot, this.options.target, this.options.id).map((entry) => {
      if (!existsNoFollow(entry.source)) throw new Error(`Variant build is missing ${entry.name}`);
      const hadDestination = existsNoFollow(entry.destination);
      return {
        ...entry,
        hadDestination,
        desired: fingerprintVariantGeneration(entry.source),
        previous: hadDestination ? fingerprintVariantGeneration(entry.destination) : null,
      };
    });
  }

  private replace(entry: VariantPromotionJournalEntry): void {
    assertArtifactPresent(entry.source, entry.desired, `${entry.name} staged source before promotion`);
    if (entry.hadDestination) {
      if (entry.previous === null) throw new Error(`Variant promotion ${entry.name} is missing its prior fingerprint.`);
      assertArtifactPresent(entry.destination, entry.previous, `${entry.name} active destination before archive`);
      this.persistPhase(`${entry.name}:archive-planned`);
      this.options.deps.fault?.(`promotion:${entry.name}:archive:mkdir`);
      ensurePrivateDirectory(dirname(entry.archive), this.options.deps);
      this.options.deps.fault?.(`promotion:${entry.name}:archive:rename`);
      durableRename(entry.destination, entry.archive, this.options.deps);
      assertArtifactPresent(entry.archive, entry.previous, `${entry.name} archived generation`);
      this.persistPhase(`${entry.name}:archived`);
    }
    this.persistPhase(`${entry.name}:promote-planned`);
    this.options.deps.fault?.(`promotion:${entry.name}:promote:destination-mkdir`);
    ensureDestinationParent(entry.destination, this.options.deps);
    this.options.deps.fault?.(`promotion:${entry.name}:promote:failed-mkdir`);
    ensurePrivateDirectory(dirname(entry.failed), this.options.deps);
    this.options.deps.fault?.(`promotion:${entry.name}:promote:rename`);
    durableRename(entry.source, entry.destination, this.options.deps);
    assertArtifactPresent(entry.destination, entry.desired, `${entry.name} promoted generation`);
    this.persistPhase(`${entry.name}:promoted`);
  }

  private persistPhase(phase: string): void {
    if (!variantPromotionPhaseIsKnown(phase)) throw new Error(`Variant promotion phase is invalid: ${phase}`);
    this.#journal.phase = phase;
    writeVariantPromotionJournal(this.#journalPath, this.#journal, this.options.deps);
    if (this.options.deps.crashAfterJournalPhase?.(phase)) {
      throw new SimulatedVariantProcessDeath(phase);
    }
  }
}

function linkNativeUserData(appUserDataRoot: string, home: string): { created: boolean; path: string } {
  const nativeUserData = join(home, "Library", "Application Support", TWEAKERS_VARIANT_PRODUCT_NAME);
  mkdirSync(dirname(nativeUserData), { recursive: true });
  if (!existsSync(nativeUserData) && !isSymlink(nativeUserData)) {
    symlinkSync(appUserDataRoot, nativeUserData);
    return { created: true, path: nativeUserData };
  }
  if (isSymlink(nativeUserData) && resolve(readlinkSync(nativeUserData)) === resolve(appUserDataRoot)) {
    return { created: false, path: nativeUserData };
  }
  throw new Error(
    `Native user-data path already exists and does not point at the isolated app-data root: ${nativeUserData}`,
  );
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function verifyCreatedVariant(
  target: string,
  stateFile: string,
  expectedAppUserDataRoot: string,
  expectedCodexHomeRoot: string,
  expectedAccountsBrokerRoot: string,
  deps: CreateVariantDeps,
  expectEnabled: boolean,
  expectedStateAppRoot = target,
): void {
  const verified = (deps.verify ?? verifySignature)(target);
  if (!verified.ok) throw new Error(`Created variant failed signature verification: ${verified.output}`);
  (deps.verifyResourceAsarIntegrity ?? ((appRoot: string) => {
    assertResourceAsarIntegrity({
      resourcesDir: join(appRoot, "Contents", "Resources"),
      metaPath: join(appRoot, "Contents", "Info.plist"),
      platform: "darwin",
    });
  }))(target);
  const plist = readPlist(join(target, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== TWEAKERS_VARIANT_BUNDLE_ID) {
    throw new Error("Created variant did not receive the isolated Tweakers bundle identifier.");
  }
  if (plist.CFBundleName !== TWEAKERS_VARIANT_NAME || plist.CFBundleDisplayName !== TWEAKERS_VARIANT_NAME) {
    throw new Error("Created variant did not receive the Tweakers display identity.");
  }
  if (plist.CrProductDirName !== TWEAKERS_VARIANT_PRODUCT_NAME) {
    throw new Error("Created variant did not receive an isolated Chromium product identity.");
  }
  if (plist.BundleSigningBaseName !== TWEAKERS_VARIANT_NAME) {
    throw new Error("Created variant did not receive an isolated signing base identity.");
  }
  const declaredExecutable = typeof plist.CFBundleExecutable === "string" ? plist.CFBundleExecutable : "";
  const launchEnvironment = plist.LSEnvironment && typeof plist.LSEnvironment === "object"
    && !Array.isArray(plist.LSEnvironment)
    ? plist.LSEnvironment as Record<string, unknown>
    : {};
  if (!declaredExecutable
    || launchEnvironment.CODEX_ELECTRON_USER_DATA_PATH !== expectedAppUserDataRoot
    || launchEnvironment.CODEX_HOME !== expectedCodexHomeRoot
    || launchEnvironment.CODEX_SQLITE_HOME !== expectedCodexHomeRoot
    || launchEnvironment.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== "1"
    || launchEnvironment.TWEAKERS_ACCOUNTS_BROKER_ROOT !== expectedAccountsBrokerRoot
    || launchEnvironment.TWEAKER_ACCOUNTS_BROKER_ROOT !== expectedAccountsBrokerRoot
    || launchEnvironment.TWEAKERS_DERIVED_VARIANT !== "1") {
    throw new Error("Created variant did not preserve Electron with the pre-singleton isolated app-data environment.");
  }
  assertTweakersLauncherBindings(target, plist, {
    appUserDataRoot: expectedAppUserDataRoot,
    codexHomeRoot: expectedCodexHomeRoot,
    accountsBrokerRoot: expectedAccountsBrokerRoot,
  });
  if (plist.CFBundleIconFile !== TWEAKERS_VARIANT_ICON_FILE
    || plist.CFBundleIconName !== undefined
    || plist.CodexAppIconBaseName !== undefined
    || plist.NSDockTilePlugIn !== undefined
    || !existsSync(join(target, "Contents", "Resources", TWEAKERS_VARIANT_ICON_FILE))
    || !readFileSync(join(target, "Contents", "Resources", TWEAKERS_VARIANT_ICON_FILE))
      .equals(readFileSync(TWEAKERS_VARIANT_ICON_SOURCE))) {
    throw new Error("Created variant did not receive the original Tweakers app icon.");
  }
  for (const name of TWEAKERS_VARIANT_DOCK_ICON_FILES) {
    const path = join(target, "Contents", "Resources", name);
    if (!existsSync(path) || !readFileSync(path).equals(readFileSync(TWEAKERS_VARIANT_PNG_SOURCE))) {
      throw new Error(`Created variant did not replace the runtime Dock icon: ${name}`);
    }
  }
  const schemes = Array.isArray(plist.CFBundleURLTypes)
    ? plist.CFBundleURLTypes.flatMap((entry) => entry && typeof entry === "object" && Array.isArray((entry as { CFBundleURLSchemes?: unknown }).CFBundleURLSchemes)
      ? (entry as { CFBundleURLSchemes: unknown[] }).CFBundleURLSchemes
      : [])
    : [];
  if (!schemes.includes(TWEAKERS_VARIANT_URL_SCHEME)
    || plist.SUEnableAutomaticChecks !== false
    || plist.SUAutomaticallyUpdate !== false) {
    throw new Error("Created variant URL or updater identity is not isolated.");
  }
  assertNoResidualOpenAIRuntimeIdentities(target);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
    appRoot?: unknown;
    watcher?: unknown;
    signingMode?: unknown;
    signingIdentity?: unknown;
  };
  if (resolve(String(state.appRoot ?? "")) !== resolve(expectedStateAppRoot)
    || state.watcher !== "none"
    || state.signingMode !== "local-identity"
    || state.signingIdentity !== DEFAULT_LOCAL_SIGNING_IDENTITY) {
    throw new Error("Created variant state is not isolated, locally signed, or unexpectedly owns a watcher.");
  }
  const stateRoot = dirname(stateFile);
  const bundled = bundledTweakIds(join(stateRoot, "tweaks"));
  if (bundled.size !== REQUIRED_TWEAKERS_TWEAKS.size
    || [...REQUIRED_TWEAKERS_TWEAKS].some((id) => !bundled.has(id))) {
    throw new Error("Created variant does not contain the complete bundled tweak set.");
  }
  if (expectEnabled) {
    const config = JSON.parse(readFileSync(join(stateRoot, "config.json"), "utf8")) as { tweaks?: Record<string, { enabled?: unknown }> };
    if ([...REQUIRED_TWEAKERS_TWEAKS].some((id) => config.tweaks?.[id]?.enabled !== true && !(id === "co.tweakers.titlebar-controls" && config.tweaks?.[id]?.enabled === false))) {
      throw new Error("Created variant did not enable every bundled tweak.");
    }
  }
}

function assertTweakersLauncherBindings(
  appRoot: string,
  plist: Record<string, unknown>,
  expected: Pick<TweakersVariantCandidateReceipt["identity"], "appUserDataRoot" | "codexHomeRoot" | "accountsBrokerRoot">,
): void {
  const declared = typeof plist.CFBundleExecutable === "string" ? plist.CFBundleExecutable : "";
  if (!declared || declared === "." || declared === ".." || basename(declared) !== declared
    || declared === TWEAKERS_ORIGINAL_EXECUTABLE
    || plist.TweakersOriginalExecutable !== TWEAKERS_ORIGINAL_EXECUTABLE) {
    throw new Error("Tweakers launcher executable topology is invalid.");
  }
  const macos = join(appRoot, "Contents", "MacOS");
  const launcher = join(macos, declared);
  const original = join(macos, TWEAKERS_ORIGINAL_EXECUTABLE);
  const launcherStat = lstatOrNull(launcher);
  const originalStat = lstatOrNull(original);
  const currentUid = process.getuid?.();
  for (const [path, stat, label] of [
    [launcher, launcherStat, "Tweakers app launcher"],
    [original, originalStat, "Preserved Tweakers Electron executable"],
  ] as const) {
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || (permissionBits(stat) & 0o111) === 0
      || stat.nlink !== 1 || (currentUid !== undefined && stat.uid !== currentUid)) {
      throw new Error(`${label} is missing or unsafe: ${path}`);
    }
  }
  if (launcherStat!.dev === originalStat!.dev && launcherStat!.ino === originalStat!.ino) {
    throw new Error("Tweakers launcher and preserved Electron executable must be distinct files.");
  }

  const resources = join(appRoot, "Contents", "Resources");
  const configs = [
    [TWEAKERS_VARIANT_USER_DATA_CONFIG, expected.appUserDataRoot],
    [TWEAKERS_VARIANT_CODEX_HOME_CONFIG, expected.codexHomeRoot],
    [TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG, expected.accountsBrokerRoot],
  ] as const;
  for (const [relativePath, expectedPath] of configs) {
    const path = join(resources, relativePath);
    assertPrivateRegularFile(path, `Tweakers launcher configuration ${relativePath}`);
    if (readFileSync(path, "utf8") !== `${expectedPath}\n`) {
      throw new Error(`Tweakers launcher configuration is not bound to the expected path: ${relativePath}`);
    }
  }
}

function bundledTweakIds(root: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, entry.name, "manifest.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string") ids.add(parsed.id);
  }
  return ids;
}

/** Re-seal one supported UI setting in an already verified disposable candidate. */
export function setDoctorCandidateTitlebarEnabled(packageRoot: string, expected: TweakersVariantCandidateReceipt, enabled: boolean): TweakersVariantCandidateReceipt {
  const jobs = join(canonicalTweakersManagerRoot(), "doctor", "jobs");
  if (!packageRoot.startsWith(`${jobs}/`) || !/^[a-f0-9-]{36}\/candidate$/.test(packageRoot.slice(jobs.length + 1)) || typeof enabled !== "boolean") throw new Error("Titlebar setting requires an owned Doctor candidate");
  const signing = findExistingPreparedSigningIdentity();
  const verify = (receipt: TweakersVariantCandidateReceipt) => verifyTweakersVariantCandidateReceipt(packageRoot, { expectedSigningIdentityHash: signing.hash,
    expectedTransactionId: receipt.id, expectedPackageRoot: packageRoot, expectedObservedPackageRoot: packageRoot, expectedSource: receipt.source, expectedIdentity: receipt.identity });
  if (JSON.stringify(verify(expected)) !== JSON.stringify(expected)) throw new Error("Candidate changed before applying its titlebar setting");
  const configPath = join(packageRoot, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
  config.tweaks["co.tweakers.titlebar-controls"].enabled = enabled;
  writePrivateJsonAtomic(configPath, config, {});
  const statePath = join(packageRoot, "state.json"), state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.doctorConfigurationSha256 !== undefined) {
    state.doctorConfigurationSha256 = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    writePrivateJsonAtomic(statePath, state, {});
  }
  const receipt = { ...expected, artifacts: { ...expected.artifacts, config: fingerprintVariantGeneration(configPath), state: fingerprintVariantGeneration(statePath) } };
  writeTweakersVariantCandidateReceipt(packageRoot, receipt, signing, candidateReceiptSignatureAdapter({}), {});
  return verify(receipt);
}

function isSupportedEnabledTweakSet(value: unknown): boolean {
  return sameSortedStringSet(value, [...REQUIRED_TWEAKERS_TWEAKS]) || sameSortedStringSet(value, [...REQUIRED_TWEAKERS_TWEAKS].filter(id => id !== "co.tweakers.titlebar-controls"));
}
function expectedEnabledCandidateTweaks(configPath: string): string[] {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return [...REQUIRED_TWEAKERS_TWEAKS].filter(id => id !== "co.tweakers.titlebar-controls" || config.tweaks?.[id]?.enabled !== false).sort();
}

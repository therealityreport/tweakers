import { assertHistoricalManagerAdmission } from "../manager-historical-continuations.js";
import { authenticateSettledAcceptedRuntimeRepairPromotion, authenticateSupersededAcceptedRuntimeRepairPromotion, readAuthenticatedAcceptedRuntimeRepair } from "../accepted-runtime-repair.js";
import { INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE, INDEPENDENT_TWEAKERS_RUNTIME_READY_RECEIPT_FILE, INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION, INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND, INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND, assertIndependentTweakersRuntimeReadyExpectation, assertIndependentTweakersRuntimeReadyReceipt, sameRuntimeReadyAppearanceBinding, sameBrokerAuthorityExpectation, isProcessStartToken, sameSortedStringSet, isSha256, isValidRfc3339, verifyRuntimeReadyReceiptBinding, type IndependentTweakersRuntimeReadyExpectation, type IndependentTweakersRuntimeReadyAppearanceBinding, type IndependentTweakersRuntimeReadyReceipt } from "../runtime-ready-receipt.js";
export { INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE, INDEPENDENT_TWEAKERS_RUNTIME_READY_RECEIPT_FILE, INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION, INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND, INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND, type IndependentTweakersRuntimeReadyExpectation, type IndependentTweakersRuntimeReadyAppearanceBinding, type IndependentTweakersRuntimeReadyReceipt } from "../runtime-ready-receipt.js";
import { observeExactTargetProcesses as targetProcesses } from "../process-observation.js";
import { createManagerRecoveryBinding, persistManagerRecoveryBinding, persistManagerRuntimeAcceptance, persistRequiredManagerRuntimeAcceptance, readManagerRetainedPromotionEvidence, managerOperationRecoveryIsVerified, settleVerifiedManagerRecoveryOperations } from "../manager-recovery-evidence.js";
import { parseManagerStrictJsonObject } from "../manager-strict-json.js";
import { isManagerOperationId, ManagerOperationStore } from "../manager-operation-store.js";
import { fingerprintVariantGeneration, type VariantGenerationFingerprint } from "../variant-generation.js";
import { captureOfficialBundledBackendClosure, bindConsumedOfficialBundledBackendClosure, assertOfficialBundledBackendSigningClosure, NATIVE_CODEX_BACKEND } from "../native-bundled-backend.js";
export { fingerprintVariantGeneration } from "../variant-generation.js";
import { prepareInstalledMetadataRepair, recordInstalledMetadataRepair, verifyInstalledMetadataRepair, type InstalledMetadataRepairBinding } from "../installed-metadata-repair.js";
import { withLifecycleLock, lifecycleLockFile, assertLifecycleReceiptsIdle } from "../lifecycle-lock.js";
import { prepareLocalArtifactSlot } from "../artifact-retirement.js";
import { consumePreparedOfficialSource } from "../official-source-registration.js";
import { withLocalOperation,updateLocalOperationPhase } from "../local-operation.js";
import { assertLocalExecutionPath, inspectLocalArtifactCapacity, bindLocalArtifactPromotion, reconcileLocalArtifactPromotion, relocateLocalArtifactReservation, reserveLocalArtifact, reconcileArtifactDeviceIdentities, publishLocalArtifactSnapshot, readReservations } from "../local-artifacts.js";
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
import { install, installerPayloadHash, packagedRuntimeAssetsRoot, stageBundledTweaks, validateBundledDerivedCodeModeHost, type BundledDerivedBackendArtifact, type BundledDerivedCodeModeHostArtifact } from "./install.js";
import { validatePrebuiltCombinedCandidate, type PrebuiltCombinedCandidateInput } from "../prebuilt-combined-candidate.js";
import { sealAcceptedSharedNativeBackendTransition, assertAcceptedSharedNativeBackendTransitionShape,
  assertAcceptedSharedNativeBackendTransitionPrior, assertAcceptedSharedNativeBackendTransitionClosure,
  type AcceptedSharedNativeBackendTransitionRequest, type AcceptedSharedNativeBackendTransitionLane,
  type SharedNativeBackendTransitionPort, type AcceptedBackendTransitionJournalBinding,
  sharedNativeBackendTransitionPort,
  AcceptedBackendTransitionJournal, ForwardBackendTransitionRecoveryRequired } from "../shared-native-backend-transition.js";
import { cloneAppTree } from "../transaction.js";
import { readPlist, writePlist } from "../plist.js";
import { assertResourceAsarIntegrity } from "../integrity.js";
import { resolveMacElectronFrameworkBinary } from "../platform.js";
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
  canonicalNativeSourceBinding,
  type CanonicalManagerEnvironmentPublication,
  type CanonicalOfficialSourceBinding,
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
import { reconcileVariantLaunchServices } from "../macos-app-identity.js";
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
import { computeRuntimeFingerprint, readRuntimeFingerprintEvidence } from "../runtime-fingerprint.js";
import { accountsTransferBrokerRoots, verifyProbedAccountsTransferRecovery, assertAccountsTransferRuntimeCompatible, prepareAccountsTransferRecovery, type AccountsTransferValidationEvidence } from "../accounts-transfer-compatibility.js";
import {
  assertIndependentTweakersAccountsRegistration,
  type IndependentTweakersBrokerAuthorityExpectation,
} from "../account-router-status.js";

const REQUIRED_TWEAKERS_TWEAKS = new Set(REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS);

function verifiedVariantBackend(options: CreateVariantOptions, sourceAppRoot: string): BundledDerivedBackendArtifact | undefined {
  if (options.retainRegisteredBackend) return verifiedRegisteredBackendForUpstreamCandidate(options, sourceAppRoot);
  if (options.baselineMaintenance) return verifiedBaselineMaintenance(options, sourceAppRoot).backend;
  if (options.acceptedBackendTransition?.version === 2) return undefined;
  const prebuilt = options.acceptedBackendTransition?.version === 1 ? options.acceptedBackendTransition.prebuilt : options.prebuiltBackend;
  if (!prebuilt) return undefined;
  const accepted = validatePrebuiltCombinedCandidate(prebuilt, {
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
    preserveSignature: Boolean(signatureInfo(accepted.backend.sourcePath).teamIdentifier),
    codeModeHost: { binaryPath: accepted.closure.codeModeHost.path,
      fingerprint: accepted.closure.codeModeHost.sha256, receiptPath: accepted.acceptedBuildReceipt.path,
      receiptSha256: accepted.acceptedBuildReceipt.sha256, resources: accepted.closure.resources },
  };
}

/** Carry the exact signed, registered resolver into a separately reviewed upstream candidate. */
function verifiedRegisteredBackendForUpstreamCandidate(options: CreateVariantOptions, source: string, consumed=false): BundledDerivedBackendArtifact {
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
    || (!consumed && !fingerprintsMatch(binding.sourceFingerprint, fingerprintVariantGeneration(source)))) throw new Error("Registered backend app or upstream source changed");
  if(!consumed)assertOfficialSource(source, {});
  else if(!options.consumePreparedSource)throw new Error("Unbound consumed source");
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
  verifyCreatedVariant(app, statePath, join(variantRoot, "app-data"), join(variantRoot, "codex-home"), brokerRoot, {}, "configured", app, true);
  assertRegisteredSharedNativeBackend(app, brokerRoot);
  const binaryPath = join(app, "Contents", "Resources", "codex");
  if (hash(binaryPath) !== binding.backendSha256) throw new Error("Registered backend bytes changed");
  const probe = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 10_000, env: {} });
  const version = probe.stdout?.trim().match(/^codex-cli (\S+)$/)?.[1];
  if (probe.status !== 0 || !version) throw new Error("Registered backend version unavailable");
  const artifact: BundledDerivedBackendArtifact = { binaryPath, version, fingerprint: binding.backendSha256, receiptPath: statePath,
    transactionId: "retained-registered-upstream-candidate", preserveSignature: true, ...(binding.codeModeHost ? { codeModeHost: binding.codeModeHost } : {}) };
  validateBundledDerivedCodeModeHost(artifact);
  return artifact;
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
  verifyCreatedVariant(app, statePath, join(variantRoot, "app-data"), join(variantRoot, "codex-home"), defaultTweakersAccountsBrokerRoot(), {}, "configured", app, true);
  const binaryPath = join(app, "Contents", "Resources", "codex");
  const versionProbe = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 10_000, env: {} });
  const version = versionProbe.stdout?.trim().match(/^codex-cli (\S+)$/)?.[1];
  if (versionProbe.status !== 0 || !version) throw new Error("Installed maintenance backend version is unavailable");
  const backend: BundledDerivedBackendArtifact = { binaryPath, version, fingerprint: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"), receiptPath: statePath,
    transactionId: "retained-installed-baseline", preserveSignature: true, ...(binding.codeModeHost ? { codeModeHost: binding.codeModeHost } : {}) };
  validateBundledDerivedCodeModeHost(backend);
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

export interface OrdinarySharedNativeBackendBinding {
  registrationFingerprint: string;
  resolverBinarySha256: string;
  resolverProtocol: "official-bundled-v1" | "shared-native-overlay-v1";
}
type RegistrationReadPort = Pick<SharedNativeBackendTransitionPort, "readSharedNativeModeAtRootV1">;

function presentWithoutFollowing(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** Authenticate source, account, roots and signature before trusting resolver metadata. */
export function captureRegisteredSharedNativeBackend(accountsBrokerRoot: string, port?: RegistrationReadPort): OrdinarySharedNativeBackendBinding | null {
  const registration = join(accountsBrokerRoot, "shared-native-mode.v1.json");
  const transition = join(accountsBrokerRoot, "shared-native-mode-transition.v1.json");
  if (presentWithoutFollowing(transition)) throw new Error("Shared native mode recovery must finish before another Tweakers refresh.");
  if (!presentWithoutFollowing(registration)) return null;
  const result = (port ?? sharedNativeBackendTransitionPort()).readSharedNativeModeAtRootV1({stateRoot: accountsBrokerRoot});
  if (result.state !== "ready" || !/^sha256:[a-f0-9]{64}$/.test(result.fingerprint ?? "")
    || !/^[a-f0-9]{64}$/.test(result.document?.resolverBinarySha256 ?? "")
    || !["official-bundled-v1", "shared-native-overlay-v1"].includes(result.document?.resolverProtocol ?? "")) {
    throw new Error("Shared native registration could not be authenticated against its source, account and roots.");
  }
  return {registrationFingerprint: result.fingerprint!, resolverBinarySha256: result.document!.resolverBinarySha256,
    resolverProtocol: result.document!.resolverProtocol as OrdinarySharedNativeBackendBinding["resolverProtocol"]};
}

/** Ordinary refresh preserves the exact authenticated registration reviewed with its candidate. */
export function assertRegisteredSharedNativeBackend(candidate: string, accountsBrokerRoot: string,
  options: {port?: RegistrationReadPort; expected?: OrdinarySharedNativeBackendBinding | null} = {}): OrdinarySharedNativeBackendBinding | null {
  const binding = captureRegisteredSharedNativeBackend(accountsBrokerRoot, options.port);
  if (Object.hasOwn(options, "expected") && JSON.stringify(binding) !== JSON.stringify(options.expected)) {
    throw new Error("Reviewed shared native registration changed before promotion.");
  }
  if (!binding) return null;
  const expected = binding.resolverBinarySha256;
  const backend = binding.resolverProtocol === "official-bundled-v1"
    ? join(candidate, NATIVE_CODEX_BACKEND) : join(candidate, "Contents", "Resources", "codex");
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)
    || !existsSync(backend) || lstatSync(backend).isSymbolicLink()
    || createHash("sha256").update(readFileSync(backend)).digest("hex") !== expected) {
    throw new Error("This candidate does not contain the registered shared native backend. Prepare a compatible backend transition before refreshing Tweakers.");
  }
  return binding;
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
  /** Internal Doctor path: the reserved downloaded app becomes the candidate. */
  consumePreparedSource?: {root:string};
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
  /** Candidate-only input. Promotion derives this authority only from its Doctor-reviewed signed receipt. */
  acceptedBackendTransition?: AcceptedSharedNativeBackendTransitionRequest;
  /** Internal post-change maintenance only: exact installed app, unchanged upstream and backend. */
  baselineMaintenance?: { installedFingerprint: VariantGenerationFingerprint; candidatePackage?: string; candidateReceipt?: TweakersVariantCandidateReceipt;
    codeModeHost?: BundledDerivedCodeModeHostArtifact };
  /** Internal candidate-only upstream update; normal Doctor approval is still required for promotion. */
  retainRegisteredBackend?: { installedFingerprint: VariantGenerationFingerprint; sourceFingerprint: VariantGenerationFingerprint;
    installedStateSha256: string; registrationSha256: string; backendSha256: string; codeModeHost?: BundledDerivedCodeModeHostArtifact };

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
  /** Test seams for the retained-promotion coordinator; production derives immutable Manager evidence. */
  retainedPromotionEvidence?: typeof readManagerRetainedPromotionEvidence;
  persistRetainedAcceptance?: typeof persistRequiredManagerRuntimeAcceptance;
  observeRetainedProcess?: (target: string) => {pid: number; startedAtRaw: string | null; visibleWindow: boolean} | null;
  settleRetainedPromotion?: (root: string, operationId: string) => boolean;
  backendTransitionPort?: SharedNativeBackendTransitionPort;
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
  /** Post-commit LaunchServices cleanup seam; production only touches /Applications/Tweakers.app. */
  reconcileAppRegistration?: (appRoot: string) => void;
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
  /** Synchronous assertion that the caller currently holds closed desktop and
   * broker admission. Required before production deferred rollback compensation. */
  beforeRollback?: () => void;
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
  bootstrapManagerEnvironment?: (options: {
    sourceRoot: string;
    destinationRoot: string;
    expectedOfficialSource?: CanonicalOfficialSourceBinding;
  }) =>
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
/**
 * The manager holds this object (and its exact transaction lock) across the
 * short relaunch/proof interval. It can commit only after verifyRuntimeReady
 * accepts a freshly written receipt. A commit failure retains the uncommitted
 * journal until the caller retains it or performs an admitted rollback.
 */
export interface DeferredTweakersVariantRefresh {
  /** Derived only from a sealed accepted-transition journal; never a caller option. */
  readonly recoveryMode?: "forward-only";
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
  acceptedBackendTransition?: AcceptedSharedNativeBackendTransitionLane;
  ordinarySharedNativeBackend?: OrdinarySharedNativeBackendBinding | null;
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
  const operationRoot = deps.home ? join(canonicalTweakersManagerRoot(deps.home()), "local-operation") : undefined;
  return withLocalOperation("create-variant", () => createTweakersVariantOwned(options, deps), operationRoot, (result, settle) => {
    if (!result) return false;
    // retain() durably hands recovery to the existing transaction journal. It
    // ends execution ownership, not recovery ownership or artifact retention.
    for (const method of ["commit", "rollback", "retain"] as const) {
      const original = result[method].bind(result);
      result[method] = () => { original(); settle(); };
    }
    return true;
  });
}
async function createTweakersVariantOwned(
  options: CreateVariantOptions,
  deps: CreateVariantDeps,
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
  const acceptedBackendTransition = reviewed?.receipt.acceptedBackendTransition;
  const ordinarySharedNativeBackend = acceptedBackendTransition ? undefined : reviewed
    ? reviewed.receipt.ordinarySharedNativeBackend ?? null
    : captureRegisteredSharedNativeBackend(accountsBrokerRoot, deps.backendTransitionPort);
  if (options.acceptedBackendTransition) throw new Error("Accepted backend transition input is candidate-only; promotion requires its Doctor approval");
  if (acceptedBackendTransition && (!deferRuntimeReadyCommit || !options.runtimeReadyOperationId)) throw new Error("Accepted backend transition requires deferred installed acceptance and its manager operation");
  if (deferRuntimeReadyCommit && !refresh) {
    throw new Error("Deferred runtime-ready commit is valid only for an independent Tweakers refresh.");
  }
  if (deferRuntimeReadyCommit && !options.runtimeReadyOperationId) {
    throw new Error("Deferred independent Tweakers refresh requires a manager operation ID.");
  }
  if (options.runtimeReadyOperationId !== undefined) assertVariantPromotionId(options.runtimeReadyOperationId);
  const id = (deps.id ?? randomUUID)();
  const candidate = reviewed ? join(reviewed.candidatePackage, "Tweakers.app") : join(dirname(target), `.${basename(target)}.candidate-${id}.app`);
  const buildRoot = join(userRoot, "builds", id);
  const buildPaths = variantBuildPaths(buildRoot);

  if (source === target) throw new Error("The Tweakers variant target must differ from the official source app.");
  if (target === "/Applications/ChatGPT.app") {
    throw new Error("Refusing to create a variant at /Applications/ChatGPT.app. The official app remains untouched.");
  }
  if (!target.endsWith(".app")) throw new Error("The Tweakers variant target must be a macOS .app bundle.");
  if (!reviewed && !existsSync(source)) throw new Error(`Official ChatGPT source not found: ${source}`);
  const transactionLock = acquireVariantPromotionLock(userRoot, target, deps);
  let retainTransactionLock = false;
  try {
    assertNoSymlinkPathWithin(userRoot, variantPromotionJournalRoot(userRoot), "Variant promotion journal root");
    assertHistoricalManagerAdmission(managerRoot);
    recoverInterruptedTweakersVariantPromotions(userRoot, target, deps);
    if (!reviewed && existsSync(candidate)) throw new Error(`Variant candidate already exists: ${candidate}`);
    if (existsSync(target) && !refresh) {
      throw new Error(`Variant target already exists: ${target}. Use refresh-variant to replace it atomically.`);
    }
    if (existsSync(buildRoot)) throw new Error(`Variant build root already exists: ${buildRoot}`);
    mkdirSync(dirname(target), { recursive: true });
    assertNoSymlinkPathWithin(userRoot, buildRoot, "Variant build root");
    if(!reviewed)assertLocalExecutionPath(source);
    else assertLocalExecutionPath(candidate);
    if (reviewed) {
      const capacity = inspectLocalArtifactCapacity(managerRoot, target);
      if (capacity.blockers.length || capacity.occupied > 2 || !capacity.paths.includes(resolve(candidate))) {
        throw new Error(`Reviewed candidate cannot be promoted until local artifacts are reconciled (${capacity.occupied}/2)`);
      }
      // The sealed app is consumed by the existing rename journal; never clone it
      // into a third application slot. Fail before cutover for unsupported paths.
      assertPromotionCandidatePath(userRoot, target, id, candidate);
    } else {await prepareLocalArtifactSlot(managerRoot,target);reserveLocalArtifact(managerRoot, target, [candidate, join(buildRoot, "failed-candidate.app")]);}
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
    let registeredOfficialEnvironmentBinding: CanonicalOfficialSourceBinding | undefined;
    let registeredSourceOriginalPath: string | undefined;
    try {
      let sealedSourceLease: ReturnType<typeof acquireSealedInactiveEnvironmentModeSourceLease> | null = null;
      let registeredSourceLease: ReturnType<typeof acquireRegisteredOfficialSourceLease> | null = null;
      try {
        if (registeredOfficialSourceRoot !== null) {
          registeredSourceLease = acquireRegisteredOfficialSourceLease(registeredOfficialSourceRoot);
          if (resolve(registeredSourceLease.receipt.artifact.appPath) !== source) {
            throw new Error("The manager registered official source changed before the Tweakers candidate was cloned.");
          }
          registeredSourceOriginalPath = registeredSourceLease.receipt.source.appPath;
          registeredOfficialEnvironmentBinding = {
            version: registeredSourceLease.receipt.source.version,
            build: registeredSourceLease.receipt.source.build,
            teamIdentifier: registeredSourceLease.receipt.source.trust.teamIdentifier,
            designatedRequirement: registeredSourceLease.receipt.source.trust.designatedRequirement,
          };
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
        if(!reviewed)assertOfficialSource(source, deps);
        if (!reviewed) (deps.cloneApp ?? cloneAppTree)(source, candidate);
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
      const officialBundledBackend = (options.prebuiltBackend || options.baselineMaintenance)
        ? undefined : captureOfficialBundledBackendClosure(source);
      await (deps.installApp ?? install)({
        app: candidate,
        fuse: false,
        watcher: false,
        localSigning: true,
        macAppIdentity: defaultTweakersVariantIdentity(appUserDataRoot, userRoot, accountsBrokerRoot),
        candidateContext: { paths: buildPaths, finalUserRoot: userRoot,
          ...(officialBundledBackend ? { officialBundledBackend } : {}),
          ...((options.prebuiltBackend || options.baselineMaintenance) ? { bundledDerivedBackend: verifiedVariantBackend(options, source) } : {}) },
      });
      if (officialBundledBackend) assertOfficialBundledBackendSigningClosure(candidate, officialBundledBackend);
      (deps.stageTweaks ?? stageBundledTweaks)(buildPaths.tweaks, buildPaths.runtime);
      }
      if (options.accountsTransferRecovery && !reviewed) prepareAccountsTransferRecovery({ runtimeRoot: buildPaths.runtime, recoveryRoot: options.accountsTransferRecovery.root, validation: options.accountsTransferRecovery.validation });
      assertAccountsTransferRuntimeCompatible(buildPaths.runtime, [accountsBrokerRoot]);
      if (acceptedBackendTransition) {
        assertAcceptedSharedNativeBackendTransitionPrior(acceptedBackendTransition, deps.backendTransitionPort);
        assertAcceptedSharedNativeBackendTransitionClosure(acceptedBackendTransition, candidate, buildPaths.runtime);
      } else assertRegisteredSharedNativeBackend(candidate, accountsBrokerRoot, {port: deps.backendTransitionPort, expected: ordinarySharedNativeBackend});
      verifyCreatedVariant(
        candidate,
        buildPaths.stateFile,
        appUserDataRoot,
        codexHomeRoot,
        accountsBrokerRoot,
        deps,
        reviewed ? "configured" : false,
        reviewed ? target : candidate,
      );
      if (!reviewed) prepareFinalVariantState(buildPaths, userRoot, target, id, deps);
      reviewed?.revalidate();
      // Revalidate canonical official identity before the callback may close Tweakers.
      assertNoSymlinkPathWithin((deps.home ?? homedir)(), managerRoot, "Canonical manager root");
      if (registeredOfficialSourceRoot !== null) {
        const registered = readRegisteredOfficialSource(registeredOfficialSourceRoot);
        if (registeredOfficialEnvironmentBinding === undefined
          || registered.state !== "ready"
          || registered.generationId !== registeredSourceStatus!.generationId
          || registered.receiptDigest !== registeredSourceStatus!.receiptDigest
          || registered.version !== registeredOfficialEnvironmentBinding.version
          || registered.build !== registeredOfficialEnvironmentBinding.build) {
          throw new Error(registered.problem ?? "The manager registered official source changed before environment reconciliation.");
        }
      }
      managerEnvironmentPublication = (
        deps.bootstrapManagerEnvironment ?? bootstrapCanonicalManagerEnvironmentSnapshot
      )({
        sourceRoot: environmentAuthoritySourceRoot,
        destinationRoot: managerRoot,
        ...(registeredOfficialEnvironmentBinding === undefined
          ? {}
          : { expectedOfficialSource: canonicalNativeSourceBinding(registeredSourceOriginalPath!, registeredOfficialEnvironmentBinding) }),
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
        artifactRoot: managerRoot,
        userRoot,
        target,
        candidate,
        id,
        deps,
        ...(acceptedBackendTransition ? { acceptedBackendTransition: {lane: acceptedBackendTransition, operationId: options.runtimeReadyOperationId!} } : {}),
        ...(!acceptedBackendTransition ? {beforeCutover: () => assertRegisteredSharedNativeBackend(candidate, accountsBrokerRoot,
          {port: deps.backendTransitionPort, expected: ordinarySharedNativeBackend})} : {}),
        beforePublication: (journal) => {
          assertHistoricalManagerAdmission(managerRoot, journal.id);
          if (!options.runtimeReadyOperationId || !isManagerOperationId(options.runtimeReadyOperationId)) return;
          const record = new ManagerOperationStore(managerRoot).read(options.runtimeReadyOperationId);
          if (!record) return; // Direct CLI recovery uses its own exact journal binding.
          if (record.phase !== "consumed" || record.actionId !== "refresh.independent") throw new Error("Manager promotion requires its consumed refresh operation");
          const runtime = readRuntimeFingerprintEvidence(buildPaths.runtime);
          if (!runtime) throw new Error("Manager promotion has no verified runtime fingerprint");
          persistManagerRecoveryBinding(managerRoot, createManagerRecoveryBinding({
            managerRoot, operationId: record.operationId, journal, runtimeFingerprint: runtime.fingerprint,
            receiptRefs: record.receiptRefs,
            dependencyPaths: [buildPaths.root, join(userRoot, "previous", id)],
          }));
        },
      });
      promotion.promote();

      verifyCreatedVariant(
        target,
        join(userRoot, "state.json"),
        appUserDataRoot,
        codexHomeRoot,
        accountsBrokerRoot,
        deps,
        "configured",
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
          promotion!.assertRollbackAllowed();
          assertDeferredTweakersVariantRollbackAdmission(target, deps);
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
          ...(acceptedBackendTransition ? { recoveryMode: "forward-only" as const } : {}),
          target,
          userRoot,
          runtimeReadyExpectation,
          verifyRuntimeReady(value: unknown, pid: number, processStartToken: string): void {
            if (settled) throw new Error("Deferred independent Tweakers refresh was already finalized.");
            verifyIndependentTweakersRuntimeReadyReceipt(runtimeReadyExpectation, value, pid, processStartToken);
            assertIndependentTweakersRuntimeReadyExpectationAt(userRoot, runtimeReadyExpectation);
            persistManagerRuntimeAcceptance(managerRoot, runtimeReadyExpectation, value, pid, processStartToken);
            runtimeReadyVerified = true;
          },
          commit(): void {
            if (settled) throw new Error("Deferred independent Tweakers refresh was already finalized.");
            if (!runtimeReadyVerified) {
              throw new Error("Deferred independent Tweakers refresh requires accepted runtime-ready evidence before commit.");
            }
            // A commit failure can occur while the freshly verified app is
            // running. Preserve publication and readiness evidence; the caller
            // owns retention or rollback after acquiring current admission.
            promotion!.commit();
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
      try { promotion?.assertRollbackAllowed(); }
      catch (forwardError) {
        // No app, manager, or environment compensation is safe after resolver begin.
        retainTransactionLock = false;
        throw new ForwardBackendTransitionRecoveryRequired(promotion!.journalPath, new AggregateError([error, forwardError]));
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
      if (!reviewed && existsSync(candidate)) {
        try {
          const failedCandidate = join(buildRoot, "failed-candidate.app");
          (deps.archiveApp ?? renameSync)(candidate, failedCandidate);
          relocateLocalArtifactReservation(managerRoot, candidate, failedCandidate);
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
    assertLocalExecutionPath(source);
    if(!options.consumePreparedSource){const artifactRoot=canonicalTweakersManagerRoot((deps.home ?? homedir)());await prepareLocalArtifactSlot(artifactRoot,target);reserveLocalArtifact(artifactRoot, target, [candidate, join(output, "Tweakers.app"), join(failedScratch, "Tweakers.app")]);}
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
    if (options.acceptedBackendTransition && (options.prebuiltBackend || options.retainRegisteredBackend || options.baselineMaintenance)) {
      throw new Error("Accepted backend transition cannot combine with another backend authority");
    }
    if (options.acceptedBackendTransition && (target !== "/Applications/Tweakers.app"
      || userRoot !== join(canonicalTweakersManagerRoot((deps.home ?? homedir)()), "variants", "tweakers"))) {
      throw new Error("Accepted backend transition requires the canonical installed Tweakers identity");
    }
    const acceptedBackendTransition = options.acceptedBackendTransition ? sealAcceptedSharedNativeBackendTransition({
      request: options.acceptedBackendTransition, identity: { target, userRoot, brokerRoot: accountsBrokerRoot },
      installerPayloadHash: installerPayloadHash(), runtimeRoot: packagedRuntimeAssetsRoot(), sourceAppRoot: source,
      ...(deps.backendTransitionPort ? { port: deps.backendTransitionPort } : {}),
    }) : undefined;
    const ordinarySharedNativeBackend = acceptedBackendTransition ? undefined : captureRegisteredSharedNativeBackend(accountsBrokerRoot, deps.backendTransitionPort);
    const backend=options.acceptedBackendTransition?.version === 2 ? undefined : verifiedVariantBackend(options,source);
    let officialBundledBackend = backend ? undefined : captureOfficialBundledBackendClosure(source);
    const sourceAfter = captureCandidateSourceSnapshot(source,sourceUsesSealedEnvironmentMode,sealedEnvironmentRoot,deps);
    assertCandidateSourceSnapshotMatches(sourceBefore, sourceAfter);
    if(options.consumePreparedSource) {
      if(resolve(options.consumePreparedSource.root)!==canonicalTweakersManagerRoot((deps.home??homedir)()))throw new Error("Prepared source manager root mismatch");
      consumePreparedOfficialSource(options.consumePreparedSource.root,source,candidate,[join(output,"Tweakers.app"),join(failedScratch,"Tweakers.app")]);
    } else (deps.cloneApp ?? cloneAppTree)(source,candidate);
    assertCandidatePackageScratchAnchor(currentPackage,parentAnchor);
    const allocatedCandidateFingerprint = fingerprintVariantGeneration(candidate);
    if(!fingerprintsMatch(sourceBefore.public.fingerprint,allocatedCandidateFingerprint))throw new Error("Candidate source drift during allocation");
    if (options.consumePreparedSource && officialBundledBackend) {
      officialBundledBackend = bindConsumedOfficialBundledBackendClosure(officialBundledBackend, candidate, sourceBefore.public.fingerprint, undefined, allocatedCandidateFingerprint);
    }
    if(!options.consumePreparedSource){assertCandidateSourceSnapshotMatches(sourceBefore,captureCandidateSourceSnapshot(source,sourceUsesSealedEnvironmentMode,sealedEnvironmentRoot,deps));assertOfficialSource(source,deps);}

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
        ...(officialBundledBackend ? { officialBundledBackend } : {}),
        ...((options.prebuiltBackend || options.acceptedBackendTransition || options.baselineMaintenance || options.retainRegisteredBackend) ? { bundledDerivedBackend: backend } : {}) },
    });
    if (officialBundledBackend) assertOfficialBundledBackendSigningClosure(candidate, officialBundledBackend);
    assertCandidatePackageScratchAnchor(currentPackage, parentAnchor);
    (deps.stageTweaks ?? stageBundledTweaks)(candidatePaths.tweaks, candidatePaths.runtime);
    if (options.doctorAccountsRecoveryRoot) prepareProbedAccountsTransferRecovery(candidatePaths.runtime, options.doctorAccountsRecoveryRoot);
    if (options.accountsTransferRecovery) prepareAccountsTransferRecovery({ runtimeRoot: candidatePaths.runtime, recoveryRoot: options.accountsTransferRecovery.root, validation: options.accountsTransferRecovery.validation });
    assertAccountsTransferRuntimeCompatible(candidatePaths.runtime, [accountsBrokerRoot]);
    if (acceptedBackendTransition) {
      assertAcceptedSharedNativeBackendTransitionPrior(acceptedBackendTransition, deps.backendTransitionPort);
      assertAcceptedSharedNativeBackendTransitionClosure(acceptedBackendTransition, candidate, candidatePaths.runtime);
    } else assertRegisteredSharedNativeBackend(candidate, accountsBrokerRoot, {port: deps.backendTransitionPort, expected: ordinarySharedNativeBackend});
    if (options.retainRegisteredBackend) {
      verifiedRegisteredBackendForUpstreamCandidate(options, source,!!options.consumePreparedSource);
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
      options.doctorConfiguration ? "configured" : true,
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
      ...(acceptedBackendTransition ? { acceptedBackendTransition } : {}),
      ...(ordinarySharedNativeBackend === undefined ? {} : {ordinarySharedNativeBackend}),
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
  configureBundledTweaks(paths.configFile, null, paths.tweaks, id, deps);
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
  acceptedBackendTransition?: AcceptedSharedNativeBackendTransitionLane;
  ordinarySharedNativeBackend?: OrdinarySharedNativeBackendBinding | null;
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
    ...(input.acceptedBackendTransition ? { acceptedBackendTransition: input.acceptedBackendTransition } : {}),
    ...(input.ordinarySharedNativeBackend === undefined ? {} : {ordinarySharedNativeBackend: input.ordinarySharedNativeBackend}),
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
  if (receipt.acceptedBackendTransition) assertAcceptedSharedNativeBackendTransitionClosure(receipt.acceptedBackendTransition, appPath, join(packageRoot, "runtime"));
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
  if (Object.keys(record).filter(key => !["acceptedBackendTransition", "ordinarySharedNativeBackend"].includes(key)).sort().join(",") !== "artifacts,id,identity,kind,packageIdentity,packageRoot,signingIdentityHash,source,version"
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
  if (record.acceptedBackendTransition !== undefined) {
    if (Object.hasOwn(record, "ordinarySharedNativeBackend")) throw new Error("Candidate has conflicting backend authority");
    assertAcceptedSharedNativeBackendTransitionShape(record.acceptedBackendTransition);
    const lane = record.acceptedBackendTransition;
    if (lane.identity.target !== identity.appTarget || lane.identity.userRoot !== identity.userRoot
      || lane.identity.brokerRoot !== identity.accountsBrokerRoot) throw new Error("Candidate backend transition identity differs from candidate identity");
  }
  if (Object.hasOwn(record, "ordinarySharedNativeBackend") && record.ordinarySharedNativeBackend !== null) {
    const binding = assertCandidateReceiptRecord(record.ordinarySharedNativeBackend, "Candidate shared native registration",
      ["registrationFingerprint", "resolverBinarySha256", "resolverProtocol"]);
    if (typeof binding.registrationFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(binding.registrationFingerprint)
      || typeof binding.resolverBinarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(binding.resolverBinarySha256)
      || !["official-bundled-v1", "shared-native-overlay-v1"].includes(binding.resolverProtocol as string)) {
      throw new Error("Candidate shared native registration authority is invalid");
    }
  }
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
    ...(record.acceptedBackendTransition ? { acceptedBackendTransition: record.acceptedBackendTransition as AcceptedSharedNativeBackendTransitionLane } : {}),
    ...(Object.hasOwn(record, "ordinarySharedNativeBackend") ? {ordinarySharedNativeBackend: record.ordinarySharedNativeBackend as OrdinarySharedNativeBackendBinding | null} : {}),
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
      electronBinary: resolveMacElectronFrameworkBinary(appRoot),
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
      || (frozenConfiguration
        ? typeof (setting as Record<string, unknown>).enabled !== "boolean"
        : (setting as Record<string, unknown>).enabled !== true && !(id === "co.tweakers.titlebar-controls" && (setting as Record<string, unknown>).enabled === false))) {
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
  configureBundledTweaks(build.configFile, join(userRoot, "config.json"), build.tweaks, id, deps);
}

function configureBundledTweaks(
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
      const priorSettings = prior && typeof prior === "object" && !Array.isArray(prior)
        ? prior as Record<string, unknown> : {};
      existing[manifest.id] = {
        ...priorSettings,
        enabled: typeof priorSettings.enabled === "boolean" ? priorSettings.enabled : true,
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
  acceptedBackendTransition?: AcceptedBackendTransitionJournalBinding;
  beforePublication?: (journal: VariantPromotionJournal) => void;
  beforeCutover?: () => void;
  artifactRoot:string;
  build: UserPaths;
  userRoot: string;
  target: string;
  candidate: string;
  id: string;
  deps: CreateVariantDeps;
}

type VariantPromotionName = typeof VARIANT_PROMOTION_NAMES[number];
type VariantPromotionJournalVersion = typeof LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION | typeof VARIANT_PROMOTION_JOURNAL_VERSION;

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
  acceptedBackendTransition?: AcceptedBackendTransitionJournalBinding;
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
  const lines = raw.split("\n");
  if (!/^[1-9][0-9]*$/.test(lines[0] ?? "")
    || !((lines.length === 2 && lines[1] === "") || (lines.length === 3 && lines[2] === ""))) {
    throw new Error(`Variant transaction lock projection is corrupt: ${path}`);
  }
  if (lines.length === 3) {
    let metadata: unknown;
    try { metadata = JSON.parse(lines[1]!); } catch { throw new Error(`Variant transaction lock projection is corrupt: ${path}`); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || (metadata as {version?:unknown}).version !== 2
      || typeof (metadata as {token?:unknown}).token !== "string"
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test((metadata as {token:string}).token)
      || !((metadata as {startedAt?:unknown}).startedAt === null || typeof (metadata as {startedAt?:unknown}).startedAt === "string")) {
      throw new Error(`Variant transaction lock projection is corrupt: ${path}`);
    }
  }
  const pid = Number(lines[0]);
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
  const activePromotionReceiptSha256 = readRuntimeReadyPromotionReceiptSha256(input);
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

/** A receipt rename can precede its durable phase; accept only this journal's exact receipt. */
export function readRuntimeReadyPromotionReceiptSha256(input: {userRoot: string; target: string; promotionId: string}): string {
  const journalPath = variantPromotionJournalPath(input.userRoot, input.promotionId);
  assertPrivateRegularFile(journalPath, "Runtime-ready promotion journal");
  const journal: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
  assertVariantPromotionJournal(journal, input.userRoot, input.target);
  if (journal.id !== input.promotionId || journal.phase === "recovered") throw new Error("Runtime-ready promotion journal identity differs");
  assertJournalFilesystemPathsAreNoFollow(journal);
  const entry = journal.activeReceipt;
  const receiptPath = existsNoFollow(entry.source) ? entry.source : entry.destination;
  assertPrivateRegularFile(receiptPath, "Runtime-ready exact active promotion receipt");
  assertArtifactPresent(receiptPath, entry.desired, "runtime-ready active receipt");
  if (!activeReceiptEquals(JSON.parse(readFileSync(receiptPath, "utf8")), entry.expected)) throw new Error("Runtime-ready active receipt identity differs from journal");
  if (receiptPath === entry.destination && entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, "runtime-ready retained prior active receipt");
  return entry.desired.sha256;
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
  expectation: IndependentTweakersRuntimeReadyExpectation, value: unknown,
  expectedPid: number, expectedProcessStartToken: string,
): asserts value is IndependentTweakersRuntimeReadyReceipt {
  verifyRuntimeReadyReceiptBinding(expectation, value, expectedPid, expectedProcessStartToken);
  const authority = assertIndependentTweakersAccountsRegistration(expectation.accountsBrokerRoot);
  if (!sameBrokerAuthorityExpectation(authority, expectation.brokerAuthorityExpectation)) {
    throw new Error("Independent Tweakers runtime-ready broker authority changed before acceptance.");
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
  if (JSON.stringify(value) !== JSON.stringify(expected)
    || !sameSortedStringSet(expected.expectedTweakIds, expectedEnabledCandidateTweaks(join(userRoot, "config.json")))) {
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

function expectedPromotionEntries(userRoot: string, target: string, id: string, candidate?: string): Array<Pick<VariantPromotionJournalEntry,
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
      source: candidate ?? join(dirname(resolvedTarget), `.${basename(resolvedTarget)}.candidate-${id}.app`),
      destination: resolvedTarget,
      archive: join(archiveRoot, "app", basename(resolvedTarget)),
      failed: join(failedRoot, "app", basename(resolvedTarget)),
    },
  ];
}

function assertPromotionCandidatePath(userRoot: string, target: string, id: string, candidate: string): void {
  if (candidate === join(dirname(target), `.${basename(target)}.candidate-${id}.app`)) return;
  const managerRoot = dirname(dirname(userRoot));
  const suffix = relative(join(managerRoot, "doctor", "jobs"), candidate);
  if (userRoot !== join(managerRoot, "variants", "tweakers")
    || !/^[a-f0-9-]{36}\/candidate\/Tweakers\.app$/.test(suffix)) {
    throw new Error("Variant promotion candidate is outside its exact managed staging paths");
  }
  assertNoSymlinkPathWithin(managerRoot, candidate, "Reviewed promotion candidate");
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

/** Strict, read-only census for historical reconciliation. Labels alone are not proof. */
export function inspectTerminalVariantPromotionEvidence(
  userRoot: string,
  target: string,
  documents: readonly { name: string; rawText: string }[],
  activeRawText: string,
): { activeId: string; activeReceiptSha256: string; journals: { id: string; version: number; phase: string; sha256: string }[] } {
  const journals = documents.map(document => {
    const value = parseManagerStrictJsonObject(document.rawText, { maxBytes: 1024 * 1024, label: "Historical promotion journal" });
    assertVariantPromotionJournal(value, userRoot, target);
    if (document.name !== `${value.id}.json` || !["committed", "recovered"].includes(value.phase)) {
      throw new Error("Historical census contains an unbound or nonterminal promotion journal");
    }
    return { journal: value, rawText: document.rawText };
  });
  if (journals.length === 0 || new Set(journals.map(item => item.journal.id)).size !== journals.length) {
    throw new Error("Historical promotion census is empty or repeats an identity");
  }
  const active = parseManagerStrictJsonObject(activeRawText, { maxBytes: 1024 * 1024, label: "Historical active receipt" });
  const current = journals.find(item => item.journal.id === active.id);
  if (!current || current.journal.phase !== "committed" || !activeReceiptEquals(active, expectedActiveReceipt(current.journal))) {
    throw new Error("Historical active receipt is not exactly linked to a committed promotion");
  }
  return {
    activeId: current.journal.id,
    activeReceiptSha256: createHash("sha256").update(activeRawText).digest("hex"),
    journals: journals.map(({ journal, rawText }) => ({ id: journal.id, version: journal.version, phase: journal.phase,
      sha256: createHash("sha256").update(rawText).digest("hex") })),
  };
}

function assertVariantPromotionJournal(
  value: unknown,
  userRoot: string,
  expectedTarget?: string,
): asserts value is VariantPromotionJournal {
  assertExactObjectKeys(value, [
    "version", "id", "userRoot", "target", "candidate", "buildRoot", "phase", "entries", "activeReceipt",
    ...((value as VariantPromotionJournal)?.acceptedBackendTransition ? ["acceptedBackendTransition"] : []),
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
  if (journal.acceptedBackendTransition !== undefined) {
    const binding = journal.acceptedBackendTransition as AcceptedBackendTransitionJournalBinding;
    assertExactObjectKeys(binding, ["lane", "operationId"], "Backend transition journal binding");
    assertAcceptedSharedNativeBackendTransitionShape(binding.lane);
    if (!isManagerOperationId(binding.operationId) || binding.lane.identity.target !== journal.target
      || binding.lane.identity.userRoot !== journal.userRoot) throw new Error("Backend transition journal identity changed");
  }
  if (!isCanonicalAbsolutePath(journal.userRoot)
    || !isCanonicalAbsolutePath(journal.target)
    || !isCanonicalAbsolutePath(journal.candidate)
    || !isCanonicalAbsolutePath(journal.buildRoot)
    || journal.userRoot !== resolve(userRoot)
    || (expectedTarget !== undefined && journal.target !== resolve(expectedTarget))
    || !variantPromotionPhaseIsKnown(journal.phase)) {
    throw new Error("Variant promotion journal does not match its exact recovery binding.");
  }
  if (journal.buildRoot !== join(journal.userRoot, "builds", journal.id)) {
    throw new Error("Variant promotion journal candidate or build root is unexpected.");
  }
  assertPromotionCandidatePath(journal.userRoot, journal.target, journal.id, journal.candidate);
  const expectedEntries = expectedPromotionEntries(journal.userRoot, journal.target, journal.id, journal.candidate);
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
  deps: Pick<CreateVariantDeps, "onDurableBoundary" | "backendTransitionPort"> = {},
): void {
  backendTransitionJournal(journal, deps)?.assertRollbackAllowed();
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

function backendTransitionJournal(journal: VariantPromotionJournal, deps: Pick<CreateVariantDeps, "backendTransitionPort"> = {}, beforePhase?: () => void): AcceptedBackendTransitionJournal | undefined {
  return journal.acceptedBackendTransition ? new AcceptedBackendTransitionJournal({
    journalPath: variantPromotionJournalPath(journal.userRoot, journal.id), buildRoot: journal.buildRoot,
    promotionId: journal.id, binding: journal.acceptedBackendTransition,
    ...(deps.backendTransitionPort ? {port: deps.backendTransitionPort} : {}),
    ...(beforePhase ? {beforePhase} : {}),
  }) : undefined;
}

/** Idempotent forward replay of exactly the immutable prepared generations. */
function replayAcceptedBackendTransition(journal: VariantPromotionJournal, deps: CreateVariantDeps): void {
  const admission = () => assertAcceptedBackendTransitionResumeAdmission(journal.target, deps);
  const transition = backendTransitionJournal(journal, deps, admission);
  if (!transition) throw new Error("Forward replay requires accepted backend transition authority");
  assertJournalFilesystemPathsAreNoFollow(journal);
  admission();
  for (const entry of journal.entries) {
    if (existsNoFollow(entry.source)) {
      assertArtifactPresent(entry.source, entry.desired, `${entry.name} forward source before begin`);
      if (existsNoFollow(entry.destination)) assertArtifactPresent(entry.destination, entry.previous!, `${entry.name} forward prior before begin`);
    } else assertArtifactPresent(entry.destination, entry.desired, `${entry.name} forward destination before begin`);
    if (existsNoFollow(entry.archive)) assertArtifactPresent(entry.archive, entry.previous!, `${entry.name} forward archive before begin`);
  }
  transition.execute("validate");
  transition.execute("begin");
  const phase = (value: string) => { admission(); journal.phase = value;
    writeVariantPromotionJournal(variantPromotionJournalPath(journal.userRoot, journal.id), journal, deps);
    if (deps.crashAfterJournalPhase?.(value)) throw new SimulatedVariantProcessDeath(value); };
  for (const entry of journal.entries) {
    if (existsNoFollow(entry.failed)) throw new Error("Forward replay found an app-only rollback generation");
    const source = existsNoFollow(entry.source), destination = existsNoFollow(entry.destination), archive = existsNoFollow(entry.archive);
    if (!source) {
      assertArtifactPresent(entry.destination, entry.desired, `${entry.name} forward destination`);
      if (entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, `${entry.name} forward archive`);
      else if (archive) throw new Error("Forward replay found an unexpected prior archive");
      continue;
    }
    assertArtifactPresent(entry.source, entry.desired, `${entry.name} forward source`);
    if (entry.hadDestination) {
      if (archive) { assertArtifactPresent(entry.archive, entry.previous!, `${entry.name} forward archive`);
        if (destination) throw new Error("Forward replay found conflicting source and destination generations"); }
      else { assertArtifactPresent(entry.destination, entry.previous!, `${entry.name} prior forward destination`);
        phase(`${entry.name}:archive-planned`); ensurePrivateDirectory(dirname(entry.archive), deps);
        admission();
        durableRename(entry.destination, entry.archive, deps); phase(`${entry.name}:archived`); }
    } else if (destination || archive) throw new Error("Forward replay found an unexpected destination generation");
    phase(`${entry.name}:promote-planned`); ensureDestinationParent(entry.destination, deps);
    admission();
    durableRename(entry.source, entry.destination, deps); assertArtifactPresent(entry.destination, entry.desired, `${entry.name} forward promoted`);
    phase(`${entry.name}:promoted`);
  }
  // Includes every artifact, not just resolver bytes, before finish removes launch blocking.
  for (const entry of journal.entries) assertArtifactPresent(entry.destination, entry.desired, `${entry.name} forward active generation`);
  transition.finishPromoted(journal.target, join(journal.userRoot, "runtime"));
  phase("app:promoted");
}

export function resumeDeferredAcceptedBackendTransition(input: {
  userRoot: string; target: string; promotionId: string; operationId: string; expectedJournalSha256: string;
}, deps: CreateVariantDeps = {}): DeferredTweakersVariantRefresh {
  const {userRoot, target, promotionId, operationId} = input;
  if (resolve(userRoot) !== userRoot || resolve(target) !== target || !isManagerOperationId(operationId)) throw new Error("Invalid forward recovery identity");
  assertVariantPromotionId(promotionId);
  assertAcceptedBackendTransitionResumeAdmission(target, deps);
  const journalPath = variantPromotionJournalPath(userRoot, promotionId);
  assertPrivateRegularFile(journalPath, "Forward recovery journal");
  const raw = readFileSync(journalPath, "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== input.expectedJournalSha256) throw new Error("Forward recovery journal changed");
  const journal: unknown = JSON.parse(raw);
  assertVariantPromotionJournal(journal, userRoot, target);
  if (journal.id !== promotionId || !journal.acceptedBackendTransition || journal.acceptedBackendTransition.operationId !== operationId
    || ["committed", "recovered"].includes(journal.phase)) throw new Error("Forward recovery operation differs from accepted transition");
  const lease = acquireVariantPromotionLock(userRoot, target, deps);
  try {
    const artifactRoot = resolve(deps.managerRoot?.() ?? canonicalTweakersManagerRoot((deps.home ?? homedir)()));
    assertHistoricalManagerAdmission(artifactRoot, promotionId);
    const capacity = inspectLocalArtifactCapacity(artifactRoot, target);
    if (capacity.blockers.length || capacity.occupied > capacity.limit) throw new Error("Forward recovery requires reconciled local artifact capacity");
    replayAcceptedBackendTransition(journal, deps);
    assertAcceptedBackendTransitionResumeAdmission(target, deps);
    const expected = stageIndependentTweakersRuntimeReadyExpectation({userRoot, operationId, promotionId, target,
      appUserDataRoot: join(userRoot, "app-data"), codexHomeRoot: join(userRoot, "codex-home"),
      accountsBrokerRoot: journal.acceptedBackendTransition.lane.identity.brokerRoot, deps});
    let verified = false, settled = false;
    return {target, userRoot, recoveryMode: "forward-only", runtimeReadyExpectation: expected,
      verifyRuntimeReady(value, pid, token) { if (settled) throw new Error("Forward recovery is settled");
        verifyIndependentTweakersRuntimeReadyReceipt(expected, value, pid, token);
        assertIndependentTweakersRuntimeReadyExpectationAt(userRoot, expected);
        persistManagerRuntimeAcceptance(resolve(deps.managerRoot?.() ?? canonicalTweakersManagerRoot((deps.home ?? homedir)())), expected, value, pid, token);
        verified = true; },
      commit() { if (settled || !verified) throw new Error("Forward recovery requires installed runtime acceptance");
        commitPromotedVariantJournal(journal, journalPath, deps); settled = true; lease.release(); },
      rollback() { throw new ForwardBackendTransitionRecoveryRequired(journalPath); },
      retain() { if (!settled) { settled = true; lease.release(); } },
    };
  } catch (error) { lease.release(); throw new ForwardBackendTransitionRecoveryRequired(journalPath, error); }
}

/** The trusted recovery owner must retain both admission leases throughout replay. */
export function assertAcceptedBackendTransitionResumeAdmission(target: string,
  deps: Pick<CreateVariantDeps, "beforeRollback" | "targetProcessRunning">): void {
  if (typeof deps.beforeRollback !== "function") throw new Error("Forward recovery requires current closed desktop and broker admission.");
  const assertion: unknown = deps.beforeRollback();
  if (assertion !== undefined) throw new Error("Forward recovery admission must be a synchronous assertion.");
  const running = deps.targetProcessRunning ? deps.targetProcessRunning(target) : targetProcesses(target).length > 0;
  if (running !== false) throw new Error("Forward recovery requires the exact desktop and helpers to be closed with known process state.");
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

/** Finalize a retained ordinary promotion whose original process became ready after timeout.
 * This never launches, stops, replaces, or replays an app/backend generation. */
export async function acceptRetainedIndependentRuntimeReady(input: {
  operationId: string; expectedPid: number; expectedProcessStartToken: string; expectedJournalSha256: string;
}, deps: CreateVariantDeps = {}): Promise<{operationId: string; promotionId: string}> {
  if (!isManagerOperationId(input.operationId) || !Number.isSafeInteger(input.expectedPid) || input.expectedPid <= 0
    || !isProcessStartToken(input.expectedProcessStartToken) || !isSha256(input.expectedJournalSha256))
    throw new Error("Invalid retained runtime acceptance identity");
  const root = resolve(deps.managerRoot?.() ?? canonicalTweakersManagerRoot((deps.home ?? homedir)()));
  const readEvidence = deps.retainedPromotionEvidence ?? readManagerRetainedPromotionEvidence;
  const observe = deps.observeRetainedProcess ?? (await import("../alerts.js")).observeCodexMainProcess;
  return withLocalOperation("accept retained runtime readiness", () => withLifecycleLock(lifecycleLockFile(root), "accept retained runtime readiness", async () => {
    const evidence = readEvidence(root, input.operationId), {binding} = evidence;
    if (evidence.journalSha256 !== input.expectedJournalSha256 || evidence.acceptedBackendTransition
      || existsNoFollow(join(root, "transactions", "manager-recovery-bindings", `${input.operationId}.runtime-repair-head.json`)))
      throw new Error("Retained acceptance requires the exact ordinary promotion");
    const lease = acquireVariantPromotionLock(binding.userRoot, binding.target, deps);
    try {
      const current = readEvidence(root, input.operationId);
      if (current.journalSha256 !== input.expectedJournalSha256) throw new Error("Retained promotion changed while acquiring ownership");
      assertPrivateRegularFile(binding.journal.path, "Retained promotion journal");
      const journal: unknown = JSON.parse(readFileSync(binding.journal.path, "utf8"));
      assertVariantPromotionJournal(journal, binding.userRoot, binding.target);
      if (journal.id !== binding.promotionId || journal.acceptedBackendTransition
        || !["app:promoted", "active:archive-planned", "active:archived", "active:promote-planned", "active:promoted", "committed"].includes(journal.phase))
        throw new Error("Retained promotion is not a complete ordinary generation");
      assertJournalFilesystemPathsAreNoFollow(journal);
      const assertProcess = () => {
        const actual = observe(binding.target);
        if (!actual || actual.pid !== input.expectedPid || actual.startedAtRaw !== input.expectedProcessStartToken || !actual.visibleWindow)
          throw new Error("Retained runtime process identity changed");
      };
      const settle = (assertCurrent: () => void) => {
        if (deps.settleRetainedPromotion) {
          if (!deps.settleRetainedPromotion(root, input.operationId)) throw new Error("Retained promotion settlement failed");
        } else {
          if (!managerOperationRecoveryIsVerified(root, input.operationId)) throw new Error("Retained promotion has no durable runtime acceptance");
          settleVerifiedManagerRecoveryOperations(root, undefined, undefined, {}, {operationId: input.operationId, beforeSettlement: assertCurrent});
          if (new ManagerOperationStore(root).read(input.operationId)?.phase !== "completed") throw new Error("Retained promotion settlement failed");
        }
      };
      assertProcess();
      const path = independentTweakersRuntimeReadyExpectationPath(binding.userRoot);
      assertPrivateRegularFile(path, "Retained runtime-ready expectation");
      const expected: unknown = JSON.parse(readFileSync(path, "utf8"));
      assertIndependentTweakersRuntimeReadyExpectation(expected);
      if (expected.schemaVersion !== INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION
        || expected.operationId !== input.operationId || expected.promotionId !== journal.id || expected.appRoot !== binding.target
        || expected.runtimeFingerprint !== binding.generation.runtimeFingerprint
        || expected.activePromotionReceiptSha256 !== binding.generation.activeReceiptSha256)
        throw new Error("Retained runtime expectation differs from its operation binding");
      const receipt = readIndependentTweakersRuntimeReadyReceipt(binding.userRoot);
      const assertReady = () => {
        assertProcess();
        assertIndependentTweakersRuntimeReadyExpectationAt(binding.userRoot, expected);
        if (JSON.stringify(readIndependentTweakersRuntimeReadyReceipt(binding.userRoot)) !== JSON.stringify(receipt)
          || readRuntimeReadyPromotionReceiptSha256({userRoot: binding.userRoot, target: binding.target, promotionId: journal.id}) !== expected.activePromotionReceiptSha256)
          throw new Error("Retained runtime readiness evidence changed");
        verifyIndependentTweakersRuntimeReadyReceipt(expected, receipt, input.expectedPid, input.expectedProcessStartToken);
      };
      assertReady();
      if (journal.phase === "committed") {
        settle(assertReady);
        return {operationId: input.operationId, promotionId: journal.id};
      }
      for (const entry of journal.entries) {
        assertArtifactPresent(entry.destination, entry.desired, `${entry.name} retained active generation`);
        if (entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, `${entry.name} retained rollback generation`);
      }
      assertReady();
      (deps.persistRetainedAcceptance ?? persistRequiredManagerRuntimeAcceptance)(root, expected, receipt, input.expectedPid, input.expectedProcessStartToken);
      commitPromotedVariantJournal(journal, binding.journal.path, deps, assertReady);
      settle(assertReady);
      // Keep the original challenge as recovery evidence; the next normal update owns its cleanup.
      return {operationId: input.operationId, promotionId: journal.id};
    } finally { lease.release(); }
  }));
}

/** Complete only the exact promoted generation; also handles interrupted receipt renames. */
function commitPromotedVariantJournal(journal: VariantPromotionJournal, path: string, deps: CreateVariantDeps, beforeMutation?: () => void): void {
  backendTransitionJournal(journal, deps)?.assertCommitReady(journal.target, join(journal.userRoot, "runtime"));
  assertJournalFilesystemPathsAreNoFollow(journal);
  const assertGenerations = () => {
    for (const entry of journal.entries) assertArtifactPresent(entry.destination, entry.desired, `${entry.name} active generation`);
  };
  const phase = (value: string) => {
    beforeMutation?.();
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
      beforeMutation?.();
      durableRename(entry.destination, entry.archive, deps);
      phase("active:archived");
    }
    if (entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, "archived active receipt");
    if (existsNoFollow(entry.destination)) throw new Error("Conflicting active receipt during commit");
    phase("active:promote-planned");
    ensurePrivateDirectory(dirname(entry.failed), deps);
    beforeMutation?.();
    durableRename(entry.source, entry.destination, deps);
    phase("active:promoted");
  }
  assertArtifactPresent(entry.destination, entry.desired, "published active receipt");
  if (entry.hadDestination) assertArtifactPresent(entry.archive, entry.previous!, "retained prior active receipt");
  assertGenerations();
  phase("committed");
  reconcilePromotedAppRegistration(journal, deps);
  scheduleGenerationRetentionAfterPromotion(journal, deps);
}

/**
 * Best-effort post-commit retention of superseded generations. It is deferred
 * until this promotion's lifecycle and operation owners finish; it never
 * affects the commit and never runs for test or non-canonical roots.
 */
function scheduleGenerationRetentionAfterPromotion(journal: VariantPromotionJournal, deps: CreateVariantDeps): void {
  if (deps.reconcileAppRegistration || resolve(journal.target) !== INDEPENDENT_TWEAKERS_TARGET) return;
  try {
    const root = resolve(journal.userRoot, "..", "..");
    void import("../generation-retention.js")
      .then((retention) => retention.scheduleGenerationRetention(root, "variant promotion committed"))
      .catch(() => { /* Retention never affects the committed promotion. */ });
  } catch { /* Retention never affects the committed promotion. */ }
}

const INDEPENDENT_TWEAKERS_TARGET = "/Applications/Tweakers.app";

/**
 * Best-effort post-commit identity cleanup. Stale LaunchServices entries for
 * retired candidates share the live bundle identifier and can make the Dock
 * show the wrong copy or the upstream ChatGPT icon. Never affects the commit.
 */
function reconcilePromotedAppRegistration(journal: VariantPromotionJournal, deps: CreateVariantDeps): void {
  const app = journal.entries.find((entry) => entry.name === "app");
  if (!app) return;
  try {
    if (deps.reconcileAppRegistration) {
      deps.reconcileAppRegistration(app.destination);
      return;
    }
    if ((deps.platform?.() ?? process.platform) !== "darwin" || resolve(app.destination) !== INDEPENDENT_TWEAKERS_TARGET) return;
    const result = reconcileVariantLaunchServices({ appRoot: app.destination, bundleId: TWEAKERS_VARIANT_BUNDLE_ID });
    // The embedded Manager shares one identifier across every retired runtime
    // generation; stale copies keep the pre-rename "Tweakers Doctor" name.
    const manager = reconcileVariantLaunchServices({
      appRoot: join(app.destination, "Contents", "Resources", "tweakers", "native", "Tweakers Manager.app"),
      bundleId: `${TWEAKERS_VARIANT_BUNDLE_ID}.doctor`,
    });
    const failed = [...result.failed, ...manager.failed];
    if (failed.length) console.warn(kleur.yellow(`Tweakers app registration cleanup was incomplete: ${failed.map((failure) => failure.path).join(", ")}`));
  } catch (error) {
    console.warn(kleur.yellow(`Tweakers app registration cleanup was skipped: ${String((error as Error)?.message ?? error)}`));
  }
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
      join(userRoot, "codex-home"), brokerRoot, deps, "configured", target);
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
    const initialJournal: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
    assertVariantPromotionJournal(initialJournal, userRoot, target);
    if (initialJournal.acceptedBackendTransition) throw new ForwardBackendTransitionRecoveryRequired(journalPath);
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
      for (const entry of journal.entries) {
        if (entry.name === "config.json") assertPrivateRegularFile(entry.destination, "Runtime repair mutable configuration");
        else assertArtifactPresent(entry.destination, entry.desired, `${entry.name} before runtime repair`);
      }
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
      // Settings remain mutable during provisional operation, just as at commit.
      // The fresh challenge below binds the restored/current enabled tweak set.
      if (entry.name === "config.json") {
        assertPrivateRegularFile(entry.destination, "Runtime repair mutable configuration");
        continue;
      }
      assertArtifactPresent(entry.destination, entry.desired, `${entry.name} during runtime repair`);
    }
    const oldRoot = existsNoFollow(priorRuntime) ? priorRuntime : runtime.destination;
    assertArtifactPresent(oldRoot, runtime.desired, "retained provisional runtime");
    if (readRuntimeFingerprintEvidence(oldRoot)?.fingerprint.toLowerCase() !== oldExpectation.runtimeFingerprint) {
      throw new Error("Runtime repair old runtime challenge drift");
    }
    const repaired: VariantPromotionJournal = JSON.parse(intent.journal);
    // Bind the current private settings into this repair, so further settings
    // changes still fail closed before acceptance rather than using stale flags.
    const repairedConfig = repaired.entries.find((entry) => entry.name === "config.json");
    if (repairedConfig) repairedConfig.desired = fingerprintVariantGeneration(repairedConfig.destination);
    repaired.entries.find((entry) => entry.name === "runtime")!.desired = options.expectedSourceRuntimeFingerprint;
    if (combined) repaired.entries.find((entry) => entry.name === "app")!.desired = combined.expectedSourceAppFingerprint;
    repaired.activeReceipt.expected = expectedActiveReceipt(repaired);
    const receiptBytes = `${JSON.stringify(repaired.activeReceipt.expected, null, 2)}\n`;
    repaired.activeReceipt.desired = { kind: "file", mode: 0o600, sha256: fileHash(receiptBytes) };
    const expectation: IndependentTweakersRuntimeReadyExpectation = {
      ...oldExpectation, operationId, activePromotionReceiptSha256: repaired.activeReceipt.desired.sha256,
      runtimeFingerprint: sourceEvidence.fingerprint.toLowerCase(), createdAt: intent.createdAt,
      expectedTweakIds: expectedEnabledCandidateTweaks(join(userRoot, "config.json")),
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
    if (combined) {
      const artifactRoot = resolve(deps.managerRoot?.() ?? canonicalTweakersManagerRoot((deps.home ?? homedir)()));
      const capacity = inspectLocalArtifactCapacity(artifactRoot, target);
      if (capacity.blockers.length || capacity.occupied > 2) throw new Error("Combined repair app capacity requires reconciliation before staging");
      // A prepared source is already a local copy. A second staging copy needs
      // its own free slot; never let a repair bypass the two-copy admission rule.
      if (!existsNoFollow(priorApp) && !existsNoFollow(nextApp)) {
        reserveLocalArtifact(artifactRoot, target, [nextApp]);
      }
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
        preserveCopiedDirectoryModes(sourceRuntimeRoot, nextRuntime);
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
        persistManagerRuntimeAcceptance(dirname(dirname(userRoot)), expectation, value, pid, processStartToken);
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
/** Retain failed readiness evidence without leaving its old challenge active. */
function archiveRecoveredRuntimeReadyEvidence(journal: VariantPromotionJournal, deps: Pick<CreateVariantDeps, "onDurableBoundary">): void {
  for (const name of [INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE, INDEPENDENT_TWEAKERS_RUNTIME_READY_RECEIPT_FILE]) {
    const path = join(journal.userRoot, name);
    if (!existsNoFollow(path)) continue;
    assertPrivateRegularFile(path, "Recovered runtime-ready evidence");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.promotionId !== journal.id) continue;
    if (name === INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_FILE) assertIndependentTweakersRuntimeReadyExpectation(value);
    else assertIndependentTweakersRuntimeReadyReceipt(value);
    if (value.appRoot !== journal.target || value.activePromotionReceiptSha256 !== journal.activeReceipt.desired.sha256) {
      throw new Error("Recovered runtime-ready evidence has a different generation binding");
    }
    for (const entry of [...journal.entries, { name: "active receipt", ...journal.activeReceipt }]) {
      if (entry.name === "config.json") continue; // User settings remain mutable.
      if (entry.previous) assertArtifactPresent(entry.destination, entry.previous, `${entry.name} recovered generation`);
      else if (existsNoFollow(entry.destination)) throw new Error("Recovered generation unexpectedly remains installed");
    }
    const archiveRoot = join(journal.buildRoot, "failed-promotion");
    ensurePrivateDirectory(archiveRoot, deps);
    const archive = join(archiveRoot, name);
    if (existsNoFollow(archive)) throw new Error("Recovered runtime-ready archive already exists");
    durableRename(path, archive, deps);
  }
}

export function recoverInterruptedTweakersVariantPromotions(
  userRoot: string,
  expectedTarget?: string,
  deps: Pick<CreateVariantDeps, "onDurableBoundary" | "targetProcessRunning" | "managerRoot" | "home" | "backendTransitionPort"> = {},
  expectedTransactionID?: string,
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
    if (expectedTransactionID !== undefined && journal.id !== expectedTransactionID) continue;
    if (journal.phase === "committed") continue;
    if(journal.phase==="app:promoted"&&journal.acceptedBackendTransition
      &&(authenticateSupersededAcceptedRuntimeRepairPromotion(resolvedRoot,journal.id,journal.acceptedBackendTransition.operationId)
        ||authenticateSettledAcceptedRuntimeRepairPromotion(resolvedRoot,journal.id,journal.acceptedBackendTransition.operationId)))continue;
    if (journal.phase === "recovered") {
      if (expectedTarget !== undefined) {
        assertTargetNotRunning(expectedTarget, deps);
        archiveRecoveredRuntimeReadyEvidence(journal, deps);
      }
      continue;
    }
    if (expectedTarget === undefined) {
      throw new Error("An interrupted variant promotion requires an exact target path before recovery.");
    }
    assertTargetNotRunning(expectedTarget, deps);
    if (journal.acceptedBackendTransition) {
      try { backendTransitionJournal(journal, deps)!.assertRollbackAllowed(); }
      catch (error) { throw new ForwardBackendTransitionRecoveryRequired(path, error); }
    }
    recoverVariantPromotionJournal(journal, deps);
    const artifactRoot=resolve(deps.managerRoot?.()??canonicalTweakersManagerRoot((deps.home??homedir)()));
    if(existsSync(join(artifactRoot,"local-artifact-reservations.json")))reconcileLocalArtifactPromotion(artifactRoot,variantPromotionJournalPath(userRoot,journal.id),journal.entries.find(e=>e.name==="app")!,fingerprintVariantGeneration);
    journal.phase = "recovered";
    writeVariantPromotionJournal(path, journal, deps);
    archiveRecoveredRuntimeReadyEvidence(journal, deps);
  }
}

/**
 * Chromium's crash reporter daemonizes (parent pid 1) and can outlive the app
 * by hours. Once no other process runs from the target, those detached
 * reporters are the only thing left and would block every promotion. Retire
 * them politely; anything else still running keeps promotion refused.
 */
function isExactTargetAppProcessRunning(target: string): boolean {
  const crashReporter = /\/Helpers\/(?:browser_)?crashpad_handler(?:\s|$)/;
  let running = targetProcesses(target);
  const orphanedReporters = running.filter((entry) => entry.ppid === 1 && crashReporter.test(entry.command));
  if (orphanedReporters.length === 0 || orphanedReporters.length !== running.length) return running.length > 0;
  for (const reporter of orphanedReporters) { try { process.kill(reporter.pid, "SIGTERM"); } catch { /* already gone */ } }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    running = targetProcesses(target);
    if (running.length === 0) return false;
    spawnSync("/bin/sleep", ["0.2"]);
  }
  return targetProcesses(target).length > 0;
}

function assertTargetNotRunning(target: string, deps: CreateVariantDeps): void {
  if ((deps.targetProcessRunning ?? isExactTargetAppProcessRunning)(target)) {
    throw new Error("Refusing variant promotion while the exact Tweakers target app or helper process is running.");
  }
}

/** Compensation must not clear evidence or publications until current admission
 * and a read-only census prove the exact desktop and helpers are closed. */
export function assertDeferredTweakersVariantRollbackAdmission(
  target: string,
  deps: Pick<CreateVariantDeps, "beforeRollback" | "targetProcessRunning"> = {},
): void {
  if (resolve(target) === INDEPENDENT_TWEAKERS_TARGET) {
    if (typeof deps.beforeRollback !== "function") {
      throw new Error("Production deferred Tweakers rollback requires current closed desktop and broker admission.");
    }
    const assertion: unknown = deps.beforeRollback();
    if (assertion !== undefined) {
      throw new Error("Deferred Tweakers rollback admission must be a synchronous assertion.");
    }
  }
  const running = deps.targetProcessRunning
    ? deps.targetProcessRunning(target)
    : targetProcesses(target).length > 0;
  if (running !== false) {
    throw new Error("Refusing deferred rollback while the exact Tweakers target app or helper process is running or its state is unknown.");
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
  get journalPath(): string { return this.#journalPath; }
  assertRollbackAllowed(): void { backendTransitionJournal(this.#journal, this.options.deps)?.assertRollbackAllowed(); }

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
      ...(options.acceptedBackendTransition ? {acceptedBackendTransition: options.acceptedBackendTransition} : {}),
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
    options.beforePublication?.(this.#journal);
    backendTransitionJournal(this.#journal, options.deps)?.prepare();
    updateLocalOperationPhase("promotion prepared",this.#journalPath);
    bindLocalArtifactPromotion(options.artifactRoot,this.#journalPath,this.#journal.entries.find(e=>e.name==="app")!);
  }

  promote(): void {
    assertJournalFilesystemPathsAreNoFollow(this.#journal);
    assertTargetNotRunning(this.options.target, this.options.deps);
    this.options.beforeCutover?.();
    if (this.#journal.acceptedBackendTransition) for (const entry of this.#journal.entries) {
      assertArtifactPresent(entry.source, entry.desired, `${entry.name} staged generation before resolver begin`);
    }
    backendTransitionJournal(this.#journal, this.options.deps)?.execute("begin");
    this.options.deps.fault?.("backend-transition:begun");
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
    if (this.#journal.acceptedBackendTransition) for (const entry of this.#journal.entries) {
      assertArtifactPresent(entry.destination, entry.desired, `${entry.name} active generation before resolver finish`);
    }
    backendTransitionJournal(this.#journal, this.options.deps)?.finishPromoted(this.options.target, join(this.options.userRoot, "runtime"));
    this.options.deps.fault?.("backend-transition:finished");
    reconcileLocalArtifactPromotion(this.options.artifactRoot,this.#journalPath,this.#journal.entries.find(e=>e.name==="app")!,fingerprintVariantGeneration);
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
      reconcileLocalArtifactPromotion(this.options.artifactRoot,this.#journalPath,this.#journal.entries.find(e=>e.name==="app")!,fingerprintVariantGeneration);
      return [];
    } catch (error) {
      return [error];
    }
  }

  private entries(): VariantPromotionJournalEntry[] {
    return expectedPromotionEntries(this.options.userRoot, this.options.target, this.options.id, this.options.candidate).map((entry) => {
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
  expectEnabled: boolean | "configured",
  expectedStateAppRoot = target,
  allowLegacyUnusedDictionarySeal = false,
): void {
  const verified = (deps.verify ?? verifySignature)(target);
  if (!verified.ok) throw new Error(`Created variant failed signature verification: ${verified.output}`);
  (deps.verifyResourceAsarIntegrity ?? ((appRoot: string) => {
    assertResourceAsarIntegrity({
      resourcesDir: join(appRoot, "Contents", "Resources"),
      metaPath: join(appRoot, "Contents", "Info.plist"),
      platform: "darwin",
      electronBinary: resolveMacElectronFrameworkBinary(appRoot),
    }, { allowLegacyUnusedSlot: allowLegacyUnusedDictionarySeal });
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
    if ([...REQUIRED_TWEAKERS_TWEAKS].some((id) => expectEnabled === "configured"
      ? typeof config.tweaks?.[id]?.enabled !== "boolean"
      : config.tweaks?.[id]?.enabled !== true && !(id === "co.tweakers.titlebar-controls" && config.tweaks?.[id]?.enabled === false))) {
      throw new Error(expectEnabled === "configured" ? "Installed fallback has invalid tweak settings." : "Created variant did not enable every bundled tweak.");
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
  return Array.isArray(value) && new Set(value).size === value.length
    && value.every(id => typeof id === "string" && (REQUIRED_TWEAKERS_TWEAKS as ReadonlySet<string>).has(id));
}
function expectedEnabledCandidateTweaks(configPath: string): string[] {
  assertPrivateRegularFile(configPath, "Independent Tweakers configuration");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)
    || !config.tweaks || typeof config.tweaks !== "object" || Array.isArray(config.tweaks)) {
    throw new Error("Independent Tweakers configuration is invalid.");
  }
  return [...REQUIRED_TWEAKERS_TWEAKS].filter(id => {
    const setting = config.tweaks[id];
    if (!setting || typeof setting !== "object" || Array.isArray(setting)
      || typeof setting.enabled !== "boolean") {
      throw new Error("Independent Tweakers enabled tweak configuration is invalid.");
    }
    return setting?.enabled !== false;
  }).sort();
}

/** A committed installation must independently prove the recovery closure before its older rollback retires. */
export function verifyInstalledVariantFallback(root:string):{id:string;fingerprints:unknown;recoveryVerified:true} {
  return verifyInstalledVariantFallbackWithRepair(root);
}

function verifyInstalledVariantFallbackWithRepair(root: string, prepareRepair?: { root: string }): {id:string;fingerprints:unknown;recoveryVerified:true} {
  if(root!==canonicalTweakersManagerRoot())throw new Error("Fallback verification requires the canonical manager root");
  const variant=join(root,"variants/tweakers"),app="/Applications/Tweakers.app";
  const receipt=JSON.parse(readFileSync(join(variant,"transactions/variant-promotion/active.json"),"utf8"));
  if(receipt.version===4) {
    const originalPath=join(variant,"transactions","variant-promotion",`${receipt.id}.json`);
    assertPrivateRegularFile(originalPath,"Installed repair original promotion journal");
    const original=JSON.parse(readFileSync(originalPath,"utf8"));
    assertVariantPromotionJournal(original,variant,app);
    if(original.id!==receipt.id||original.phase!=="app:promoted"||!original.acceptedBackendTransition
      ||!authenticateSettledAcceptedRuntimeRepairPromotion(variant,original.id,original.acceptedBackendTransition.operationId))
      throw new Error("Installed repaired fallback is not committed and settled");
    const child=readAuthenticatedAcceptedRuntimeRepair(original.acceptedBackendTransition.operationId);
    if(!child||child.phase!=="committed"||JSON.stringify(child.effectiveActiveReceipt)!==JSON.stringify(receipt))
      throw new Error("Installed repaired fallback receipt differs from authenticated child");
  }
  if((receipt.version!==3&&receipt.version!==4)||receipt.userRoot!==variant||receipt.target!==app||!Array.isArray(receipt.entries))throw new Error("Installed fallback has no committed generation receipt");
  const expected=new Map([["app",app],["runtime",join(variant,"runtime")],["tweaks",join(variant,"tweaks")],["state.json",join(variant,"state.json")]]);
  if(receipt.entries.length!==expected.size)throw new Error("Incomplete installed fallback receipt");
  const fingerprints = [];
  for(const entry of receipt.entries){
    if(expected.get(entry.name)!==entry.path)throw new Error("Fallback receipt path changed");
    expected.delete(entry.name);assertLocalExecutionPath(entry.path);assertFingerprint(entry.fingerprint,"Installed fallback");
    const actual = fingerprintVariantGeneration(entry.path);
    if(!fingerprintsMatch(actual,entry.fingerprint)) {
      if(entry.name!=="app")throw new Error(`Variant promotion Installed fallback fingerprint changed: ${entry.path}`);
      const binding: InstalledMetadataRepairBinding = {root,variantRoot:variant,target:app,promotionId:receipt.id,original:entry.fingerprint,inode:lstatSync(app).ino};
      if(prepareRepair) {
        // Publication below repeats this projection after signature/runtime/recovery verification.
        prepareInstalledMetadataRepair(binding,prepareRepair.root);
      } else if(!fingerprintsMatch(actual,verifyInstalledMetadataRepair(binding)))throw new Error("Installed metadata repair fingerprint changed");
    }
    fingerprints.push({...entry,fingerprint:actual});
  }
  // An installed fallback retains user toggle choices; fresh-install defaults
  // are not an integrity requirement. The complete signed payload is checked.
  verifyCreatedVariant(app,join(variant,"state.json"),join(variant,"app-data"),join(variant,"codex-home"),defaultTweakersAccountsBrokerRoot(),{},"configured",app,true);
  const state=JSON.parse(readFileSync(join(variant,"state.json"),"utf8"));
  assertCandidateAppSigningIdentity(app,join(variant,"state.json"),state.signingIdentityHash,candidateReceiptSignatureAdapter({}));
  assertAccountsTransferRuntimeCompatible(join(variant,"runtime"),[defaultTweakersAccountsBrokerRoot()]);
  if(!verifyProbedAccountsTransferRecovery(join(variant,"runtime")))throw new Error("Installed fallback recovery dependencies do not verify");
  return {id:receipt.id,fingerprints,recoveryVerified:true};
}

/** Recover a completed alias repair without changing the original promotion receipts. */
export async function recordInstalledVariantMetadataRepair(root: string, repairRoot: string): Promise<void> {
  if(root!==canonicalTweakersManagerRoot())throw new Error("Metadata repair requires the canonical manager root");
  await withLocalOperation("verify installed alias repair", async () => {
    const variant=join(root,"variants/tweakers"),target="/Applications/Tweakers.app";
    const lock=acquireVariantPromotionLock(variant,target,{});
    try {
      const receipt=JSON.parse(readFileSync(join(variant,"transactions/variant-promotion/active.json"),"utf8"));
      const app=receipt.entries?.find((entry: {name:string})=>entry.name==="app");
      if(!app)throw new Error("Installed app has no promotion fingerprint");
      const reservation=readReservations(root).find(entry=>entry.state==="installed"&&entry.paths.length===1&&entry.paths[0]===target
        &&entry.transactionRef===join(variant,"transactions/variant-promotion",`${receipt.id}.json`));
      if(!reservation?.generationIdentity||!reservation.generationFingerprint||!fingerprintsMatch(reservation.generationFingerprint as VariantGenerationFingerprint,app.fingerprint))throw new Error("Metadata repair has no original installed artifact identity");
      recordInstalledMetadataRepair({root,variantRoot:variant,target,promotionId:receipt.id,original:app.fingerprint,inode:reservation.generationIdentity.ino},repairRoot,
        ()=>{verifyInstalledVariantFallbackWithRepair(root,{root:repairRoot});});
      verifyInstalledVariantFallback(root);
    } finally {lock.release();}
  });
}

/** Reconcile a remount only after installation and any metadata repair verify. */
export async function reconcileInstalledVariantArtifactIdentity(root: string): Promise<string[]> {
  if(root!==canonicalTweakersManagerRoot())throw new Error("Artifact reconciliation requires the canonical manager root");
  return withLocalOperation("reconcile verified installed artifact identity",async()=>{
    const variant=join(root,"variants/tweakers"),target="/Applications/Tweakers.app";
    const lock=acquireVariantPromotionLock(variant,target,{});
    try {
      verifyInstalledVariantFallback(root);
      const receipt=JSON.parse(readFileSync(join(variant,"transactions/variant-promotion/active.json"),"utf8"));
      const changed=reconcileArtifactDeviceIdentities(root,fingerprintVariantGeneration,(path,original)=>{
        if(path!==target)throw new Error("Metadata repair is only valid for the installed app");
        assertFingerprint(original,"Artifact original fingerprint");
        return verifyInstalledMetadataRepair({root,variantRoot:variant,target,promotionId:receipt.id,original,inode:lstatSync(target).ino});
      });
      publishLocalArtifactSnapshot(root,inspectLocalArtifactCapacity(root,target));
      return changed;
    } finally {lock.release();}
  });
}

/** A retained authenticated repair is history, not permission to accept a new generation. */
export function assertTweakRefreshHistorySettled(
  userRoot: string,
  journal: { id: string; phase: string; acceptedBackendTransition?: { operationId: string } },
  authenticateHistorical: (root: string, promotionId: string, operationId: string) => boolean = (root, promotionId, operationId) =>
    authenticateSupersededAcceptedRuntimeRepairPromotion(root, promotionId, operationId)
      || authenticateSettledAcceptedRuntimeRepairPromotion(root, promotionId, operationId),
): void {
  if (["committed", "recovered"].includes(journal.phase)) return;
  if (journal.phase === "app:promoted" && journal.acceptedBackendTransition
    && authenticateHistorical(userRoot, journal.id, journal.acceptedBackendTransition.operationId)) return;
  throw new Error("Pending variant promotion must finish before a tweak refresh");
}

export function assertTweakRefreshHistoryDocumentSettled(
  userRoot: string,
  target: string,
  document: { name: string; rawText: string },
): void {
  const journal = parseManagerStrictJsonObject(document.rawText, { maxBytes: 1024 * 1024, label: "Tweak refresh promotion journal" });
  assertVariantPromotionJournal(journal, userRoot, target);
  assertJournalFilesystemPathsAreNoFollow(journal);
  if (document.name !== `${journal.id}.json`) throw new Error("Tweak refresh journal file name does not match its transaction ID");
  assertTweakRefreshHistorySettled(userRoot, journal);
}

/** Publish only a reviewed tweak payload while retaining the exact verified app and runtime. */
export async function promoteVerifiedTweakRefresh(input: {
  managerRoot: string; sourceTweaks: string; expectedTweaksFingerprint: VariantGenerationFingerprint;
  settingsRepair?: { sourceRuntime: string; files: Array<{
    name: "preload.js" | "preload/settings-injector.js" | "preload/settings-injector.js.map";
    before: VariantGenerationFingerprint; after: VariantGenerationFingerprint;
  }> };
}): Promise<{ id: string; target: string; rollback: string }> {
  const root = input.managerRoot, target = "/Applications/Tweakers.app";
  if (root !== canonicalTweakersManagerRoot()) throw new Error("Tweak refresh requires the canonical manager root");
  assertFingerprint(input.expectedTweaksFingerprint, "Reviewed tweak payload");
  assertLocalExecutionPath(input.sourceTweaks);
  assertFingerprintAt(input.sourceTweaks, input.expectedTweaksFingerprint, "Reviewed tweak payload");
  const variant = join(root, "variants/tweakers");
  validateTweakRefreshOwners(join(variant, "tweaks"), input.sourceTweaks);
  return withLocalOperation("promote verified tweak-only generation", async () => withLifecycleLock(lifecycleLockFile(root), "promote verified tweak-only generation", async () => {
    assertLifecycleReceiptsIdle(root);
    const lock = acquireVariantPromotionLock(variant, target, {});
    let promotion: VariantPromotion | null = null;
    try {
      assertTargetNotRunning(target, {});
      for (const name of readdirSync(variantPromotionJournalRoot(variant))) {
        if (name === "active.json") continue;
        const path = join(variantPromotionJournalRoot(variant), name);
        assertPrivateRegularFile(path, "Variant promotion journal");
        assertTweakRefreshHistoryDocumentSettled(variant, target, { name, rawText: readFileSync(path, "utf8") });
      }
      const fallback = verifyInstalledVariantFallback(root);
      if (input.settingsRepair) {
        const names = input.settingsRepair.files.map(file => file.name).sort();
        if (JSON.stringify(names) !== JSON.stringify(["preload.js", "preload/settings-injector.js", "preload/settings-injector.js.map"])) throw new Error("Settings repair requires the exact compiled preload payload");
        assertLocalExecutionPath(input.settingsRepair.sourceRuntime);
        for (const file of input.settingsRepair.files) {
          assertFingerprintAt(join(variant, "runtime", file.name), file.before, "Reviewed settings preimage");
          assertFingerprintAt(join(input.settingsRepair.sourceRuntime, file.name), file.after, "Reviewed settings repair");
        }
      }
      await prepareLocalArtifactSlot(root, target);
      if (JSON.stringify(verifyInstalledVariantFallback(root)) !== JSON.stringify(fallback)) throw new Error("Installed fallback changed during preparation");
      const id = randomUUID(), build = variantBuildPaths(join(variant, "builds", id));
      const candidate = join(dirname(target), `.${basename(target)}.candidate-${id}.app`);
      reserveLocalArtifact(root, target, [candidate, join(build.root, "failed-promotion/app/Tweakers.app")]);
      ensurePrivateDirectory(build.root, {});
      for (const [source, destination] of [
        [target, candidate], [join(variant, "runtime"), build.runtime],
        [join(variant, "state.json"), build.stateFile], [join(variant, "config.json"), build.configFile],
      ]) copyReviewedVariantArtifact(source!, destination!, fingerprintVariantGeneration(source!));
      copyReviewedVariantArtifact(input.sourceTweaks, build.tweaks, input.expectedTweaksFingerprint);
      for (const file of input.settingsRepair?.files ?? []) {
        const source = join(input.settingsRepair!.sourceRuntime, file.name);
        const destination = join(build.runtime, file.name);
        assertFingerprintAt(destination, file.before, "Settings candidate preimage");
        unlinkSync(destination);
        copyReviewedVariantArtifact(source, destination, file.after);
      }
      if (input.settingsRepair) {
        unlinkSync(join(build.runtime, "accounts-transfer-recovery.v1.json"));
        writeFileSync(join(build.runtime, "runtime-fingerprint.json"), `${JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(build.runtime) }, null, 2)}\n`);
        if (!readRuntimeFingerprintEvidence(build.runtime)) throw new Error("Settings repair runtime fingerprint did not verify");
        prepareProbedAccountsTransferRecovery(build.runtime, join(root, "accounts-recovery", id));
      }
      if (!verifyProbedAccountsTransferRecovery(build.runtime)) throw new Error("Candidate recovery dependencies did not verify");
      assertFingerprintAt(input.sourceTweaks, input.expectedTweaksFingerprint, "Reviewed tweak payload before promotion");
      if (JSON.stringify(verifyInstalledVariantFallback(root)) !== JSON.stringify(fallback)) throw new Error("Installed fallback changed before promotion");
      verifyCreatedVariant(candidate, build.stateFile, join(variant, "app-data"), join(variant, "codex-home"), defaultTweakersAccountsBrokerRoot(), {}, "configured", target);
      promotion = new VariantPromotion({ artifactRoot: root, build, userRoot: variant, target, candidate, id, deps: {} });
      promotion.promote();
      verifyCreatedVariant(target, join(variant, "state.json"), join(variant, "app-data"), join(variant, "codex-home"), defaultTweakersAccountsBrokerRoot(), {}, "configured");
      promotion.commit();
      return { id, target, rollback: join(variant, "previous", id, "app/Tweakers.app") };
    } catch (error) {
      const rollbackErrors = promotion?.rollback() ?? [];
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Tweak refresh rollback requires recovery");
      throw error;
    } finally { lock.release(); }
  }));
}

/** Undo only the exact committed UI refresh after failed installed acceptance. */
export async function rollbackVerifiedUiRefresh(id: string, expectedJournalSha256: string): Promise<void> {
  assertVariantPromotionId(id);
  if (!isSha256(expectedJournalSha256)) throw new Error("Rollback requires an exact journal hash");
  const root = canonicalTweakersManagerRoot(), variant = join(root, "variants/tweakers"), target = "/Applications/Tweakers.app";
  await withLocalOperation("restore verified UI fallback", async () => withLifecycleLock(lifecycleLockFile(root), "restore verified UI fallback", async () => {
    assertLifecycleReceiptsIdle(root);
    const lock = acquireVariantPromotionLock(variant, target, {});
    try {
      assertTargetNotRunning(target, {});
      const path = variantPromotionJournalPath(variant, id), bytes = readFileSync(path);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedJournalSha256) throw new Error("Rollback journal changed");
      const journal = JSON.parse(bytes.toString());
      assertVariantPromotionJournal(journal, variant, target);
      assertJournalFilesystemPathsAreNoFollow(journal);
      if (journal.phase !== "committed") throw new Error("Rollback requires the exact committed refresh");
      for (const entry of journal.entries) {
        assertFingerprintAt(entry.destination, entry.desired, "Rejected active generation");
        if (!entry.previous) throw new Error("Rollback has no prior generation");
        assertFingerprintAt(entry.archive, entry.previous, "Retained fallback generation");
      }
      assertFingerprintAt(journal.activeReceipt.destination, journal.activeReceipt.desired, "Current receipt");
      const runtime = journal.entries.find(entry => entry.name === "runtime")!;
      if (!verifyProbedAccountsTransferRecovery(runtime.archive)) throw new Error("Retained recovery dependencies do not verify");
      recoverVariantPromotionJournal(journal);
      journal.phase = "recovered";
      writeVariantPromotionJournal(path, journal, {});
      reconcileLocalArtifactPromotion(root, path, journal.entries.find(entry => entry.name === "app")!, fingerprintVariantGeneration);
      verifyInstalledVariantFallback(root);
    } finally { lock.release(); }
  }));
}

export function validateTweakRefreshOwners(current: string, source: string): void {
  const owners = (root: string): string[] => readdirSync(root).filter(name => !name.startsWith(".")).map(name => {
    const path = join(root, name);
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Tweak refresh requires regular owned folders");
    const manifestPath = join(path, "manifest.json");
    if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) throw new Error("Unsafe tweak refresh manifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.id !== "string" || typeof manifest.version !== "string") throw new Error("Invalid tweak refresh manifest");
    return `${name}\0${manifest.id}`;
  }).sort();
  if (JSON.stringify(owners(current)) !== JSON.stringify(owners(source))) throw new Error("Tweak refresh cannot change installed owners");
}

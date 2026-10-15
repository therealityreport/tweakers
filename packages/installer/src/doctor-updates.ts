import { doctorBaselineNeedsCliContextUpgrade } from "./doctor-baseline.js";
import { sealAcceptedSharedNativeBackendTransition, prepareOfficialBundledBackendSourceSelection, sharedNativeBackendTransitionPort,
  type AcceptedSharedNativeBackendTransitionRequest } from "./shared-native-backend-transition.js";
import { installerPayloadHash } from "./commands/install.js";
import { withLocalOperation, readLocalOperation } from "./local-operation.js";
import { doctorImplementationScopes, sameDoctorCandidateImplementation, verifyDoctorImplementationAssets, findDoctorConstructionScopeEquivalence, type DoctorImplementationScopes } from "./doctor-implementation.js";
import type { DoctorPatchRepairV1 } from "./doctor-patch-repair.js";
import { DOCTOR_CORE_CHECKS, compatibilityFingerprint, doctorConfigurationFingerprint, makeDoctorCompatibility } from "./doctor-compatibility.js";
import { probeDesktopAppcast, type DesktopAppcastProbeResult } from "./desktop-appcast-probe.js";
import { prepareOfficialUpdateSource } from "./official-update-download.js";
import { createEnvironmentSelection, fingerprintAppContents, type EnvironmentProfileRecord } from "./environment-profile.js";
import { changeReportFingerprint, saveDoctorChangeReport } from "./doctor-adoption.js";
import { spawn } from "node:child_process";
import { acquireProcessLock } from "./process-lock.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statfsSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalTweakersManagerRoot, tweakersManagerDescriptorPaths, verifyRetainedTweakersManagerGeneration, parseTweakersManagerTargetSeal, TWEAKERS_MANAGER_LAUNCHER_NAME, TWEAKERS_MANAGER_SEAL_NAME } from "./manager-descriptor.js";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import type { ManagerResolvedExecutableIdentityV1 } from "./manager-contract.js";
import { targetUserHome } from "./ownership.js";
import { findExistingPreparedSigningIdentity } from "./codesign.js";
import { packagedRuntimeAssetsRoot } from "./commands/install.js";
import { createTweakersVariant, fingerprintVariantGeneration, verifyTweakersVariantCandidateReceipt, reconcileInstalledVariantArtifactIdentity, type TweakersVariantCandidateReceipt } from "./commands/create-variant.js";
import { readReservations } from "./local-artifacts.js";
import { retireSupersededDoctorSource } from "./artifact-retirement.js";
import { findRetainedOfficialSourceForDoctor, readRegisteredOfficialSource, registerOfficialSourceEvidence, preparedOfficialSourceDigest, stableOfficialSourceCandidateDigest, canReuseRegisteredSourceEvidence } from "./official-source-registration.js";
import { collectDoctorSourceEvidence, compareDoctorSourceEvidence } from "./doctor-evidence.js";
import { DOCTOR_APP, DOCTOR_NATIVE_APP, doctorBundleIdentity, readDoctorIndependentInputs } from "./doctor-independent.js";
import { doctorDigest, doctorDirectory, isDoctorSuppliedNativeSourcePolicyV1, readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson, writeDoctorUpdateJob, type DoctorUpdateJobV1, type DoctorSuppliedNativeSourcePolicyV1 } from "./doctor-store.js";
import type { DoctorChangeReportV1, DoctorFindingV1 } from "@therealityreport/tweakers-sdk";
import type { ReviewDoctorSourceChangesResult } from "./doctor-review.js";
import { collectDoctorValidation, doctorPatchImplementationFingerprint, type DoctorValidationReport } from "./doctor-validation.js";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";
import { assertAcceptedAccountsRecoveryRuntime } from "./accounts-transfer-compatibility.js";

const jobRoot = (root: string, id: string) => join(doctorDirectory(root), "jobs", id);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

const OPERATION_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** The installation submission owns its job independently of the newest scan. */
export function readSubmittedDoctorUpdateJob(root: string): { operationId: string; jobId: string; job: DoctorUpdateJobV1 } | null {
  const submitted = readDoctorPrivateJson(join(doctorDirectory(root), "update-operation.json")) as { operationId?: unknown; jobId?: unknown } | null;
  if (submitted === null) return null;
  if (typeof submitted.operationId !== "string" || !OPERATION_UUID.test(submitted.operationId)
    || typeof submitted.jobId !== "string" || !OPERATION_UUID.test(submitted.jobId)) throw new Error("Submitted Doctor installation identity is invalid");
  const job = readDoctorPrivateJson(join(jobRoot(root, submitted.jobId), "job.json")) as DoctorUpdateJobV1 | null;
  if (!job || job.schemaVersion !== 1 || job.id !== submitted.jobId || !job.result || !Array.isArray(job.findings)) throw new Error("Submitted Doctor installation job is missing or invalid");
  return { operationId: submitted.operationId, jobId: submitted.jobId, job };
}

export interface DoctorUpstreamCurrencyV1 {
  version: 1; jobId: string; checkedAt: string;
  state: "current" | "update-available" | "unavailable";
  installedVersion: string | null; installedBuild: string | null;
  latestVersion: string | null; latestBuild: string | null;
}
/** Release currency is source metadata, never installation/startup acceptance. */
export function readDoctorUpstreamCurrency(root: string): DoctorUpstreamCurrencyV1 | null {
  const value = readDoctorPrivateJson(join(doctorDirectory(root), "upstream-currency.json")) as DoctorUpstreamCurrencyV1 | null;
  if (!value) return null;
  if (value.version !== 1 || !OPERATION_UUID.test(value.jobId) || !Number.isFinite(Date.parse(value.checkedAt))
    || !["current", "update-available", "unavailable"].includes(value.state)
    || ![value.installedVersion, value.installedBuild, value.latestVersion, value.latestBuild].every(field => field === null || typeof field === "string")) throw new Error("Doctor upstream currency evidence is invalid");
  return value;
}

export function recordDoctorUpstreamCurrency(root: string, input: {
  jobId: string; probe: DesktopAppcastProbeResult; installedVersion: string | null; installedBuild: string | null;
}): void {
  if (!OPERATION_UUID.test(input.jobId)) throw new Error("Doctor upstream currency job identity is invalid");
  const currency: DoctorUpstreamCurrencyV1 = { version: 1, jobId: input.jobId, checkedAt: new Date().toISOString(),
    state: input.probe.state === "current" || input.probe.state === "update-available" ? input.probe.state : "unavailable",
    installedVersion: input.installedVersion, installedBuild: input.installedBuild,
    latestVersion: input.probe.latestMarketingVersion ?? null, latestBuild: input.probe.latestBuild ?? null };
  writeDoctorPrivateJson(join(doctorDirectory(root), "upstream-currency.json"), currency);
  writeDoctorPrivateJson(join(jobRoot(root, input.jobId), "upstream-currency.json"), currency);
}

/** A signed native bundle is an update source only for the selected production release. */
export function selectDoctorProductionSource(latest: DesktopAppcastProbeResult, native: { version: string | null; build: string | null }): "native" | "download" | "current" | "unavailable" {
  if (latest.state === "current") return "current";
  if (latest.state !== "update-available" || !latest.enclosureUrl || !latest.latestBuild || !latest.latestMarketingVersion) return "unavailable";
  return native.build === latest.latestBuild && native.version === latest.latestMarketingVersion ? "native" : "download";
}

export function assertDoctorAcceptedNativeFrontend(request: AcceptedSharedNativeBackendTransitionRequest, fingerprint: string | undefined): void {
  const expected = request.version === 2 ? request.officialBundled?.expectedSourceAppFingerprint : request.prebuilt?.expectedSourceAppFingerprint;
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || fingerprint !== expected) throw new Error("Accepted backend repair native frontend differs from the exact pinned pristine source; no app allocation is authorized.");
}

/** Appcast currency is advisory while repairing an explicitly pinned backend pair. */
export function selectDoctorProductionSourceForRequest(latest: DesktopAppcastProbeResult,
  native: {version: string | null; build: string | null}, request?: AcceptedSharedNativeBackendTransitionRequest,
  nativeFrontendFingerprint?: string, localRuntimeRefresh = false): ReturnType<typeof selectDoctorProductionSource> {
  if (!request) {
    // A local runtime repair still uses the exact current stable native release
    // and the ordinary candidate review. It creates no resolver transition.
    if(localRuntimeRefresh&&latest.state==="current"&&latest.enclosureUrl&&latest.latestBuild&&latest.latestMarketingVersion
      &&native.build===latest.latestBuild&&native.version===latest.latestMarketingVersion)return "native";
    return selectDoctorProductionSource(latest, native);
  }
  assertDoctorAcceptedNativeFrontend(request, nativeFrontendFingerprint);
  return "native";
}

export function assertDoctorSuppliedNativeSource(policy: DoctorSuppliedNativeSourcePolicyV1,
  native: { nativeIdentity: string | null; nativeVersion: string | null; nativeBuild: string | null }, fingerprint: string,
  resumeOrigin?: "native" | "download"): void {
  if (!isDoctorSuppliedNativeSourcePolicyV1(policy) || native.nativeIdentity !== policy.nativeIdentity
    || native.nativeVersion !== policy.nativeVersion || native.nativeBuild !== policy.nativeBuild
    || fingerprint !== policy.sourceAppFingerprint || resumeOrigin !== undefined && resumeOrigin !== "native") {
    throw new Error("Verified supplied native source changed or is incompatible; no app allocation is authorized. Scan again.");
  }
}

export function assertDoctorSuppliedNativeResume(policy: DoctorSuppliedNativeSourcePolicyV1,
  priorPolicy: DoctorSuppliedNativeSourcePolicyV1 | undefined, sourceOrigin: "native" | "download" | undefined): void {
  if (!isDoctorSuppliedNativeSourcePolicyV1(policy) || !isDoctorSuppliedNativeSourcePolicyV1(priorPolicy)
    || sourceOrigin !== "native" || doctorDigest(priorPolicy) !== doctorDigest(policy)) {
    throw new Error("A downloaded or differently bound job cannot resume as supplied native source; start a fresh scan.");
  }
}

/** Called only after production inspection verified the complete native source. */
export function doctorSuppliedNativePolicyFromInspection(selection: { sourceAppFingerprint: string } | undefined,
  native: { nativeIdentity: string | null; nativeVersion: string | null; nativeBuild: string | null }): DoctorSuppliedNativeSourcePolicyV1 {
  if (!selection) throw new Error("Verified supplied native source registration is missing; Doctor cannot substitute a downloaded feed release. Restore the native source registration and scan again.");
  const policy = { version: 1 as const, nativeIdentity: native.nativeIdentity!, nativeVersion: native.nativeVersion!,
    nativeBuild: native.nativeBuild!, sourceAppFingerprint: selection.sourceAppFingerprint };
  if (!isDoctorSuppliedNativeSourcePolicyV1(policy)) throw new Error("Verified supplied native source inspection has no exact native tuple");
  return policy;
}

/** Explicit inspected native authority is independent of advisory feed currency. */
export function selectDoctorSuppliedNativeSource(policy: DoctorSuppliedNativeSourcePolicyV1,
  native: { nativeIdentity: string | null; nativeVersion: string | null; nativeBuild: string | null }, fingerprint: string,
  installed: { version: string | null; build: string | null }, localRuntimeRefresh: boolean, transition = false): "native" | "current" {
  assertDoctorSuppliedNativeSource(policy, native, fingerprint);
  return transition || localRuntimeRefresh || installed.version !== policy.nativeVersion || installed.build !== policy.nativeBuild ? "native" : "current";
}

/** The installed runtime has recovery additions, so compare its authenticated
 * source binding rather than its post-install directory fingerprint. */
export function doctorInstalledRuntimeNeedsRefresh(installedRoot:string,sourceRoot:string):boolean {
  const source=readRuntimeFingerprintEvidence(sourceRoot);
  if(!source)throw new Error("Local runtime refresh requires verified sealed source bytes");
  try {
    assertAcceptedAccountsRecoveryRuntime(installedRoot,{...source,
      documentSha256:createHash("sha256").update(readFileSync(join(sourceRoot,"runtime-fingerprint.json"))).digest("hex")});
    return false;
  }catch{return true;}
}

interface DoctorCandidateInputs {
  fingerprint?: string;
  implementationScopes?: DoctorImplementationScopes;
  candidateReceiptFingerprint?: string;
  sourceFingerprint?: ReturnType<typeof fingerprintVariantGeneration>;
  configurationFingerprint?: string;
  patchRepairs?: DoctorPatchRepairV1[];
  acceptedBackendTransition?: AcceptedSharedNativeBackendTransitionRequest;
}
function retainedConstructionMatches(root: string, job: DoctorUpdateJobV1, scopes: DoctorImplementationScopes): boolean {
  if (job.implementationScopes?.version !== 1 || job.implementationScopes.payload !== scopes.payload) return false;
  if (job.implementationScopes.construction === scopes.construction) return true;
  if (job.candidatePackage !== join(jobRoot(root, job.id), "candidate") || !job.candidateReceipt || !existsSync(job.candidatePackage)) return false;
  const inputs = readDoctorPrivateJson(join(jobRoot(root, job.id), "candidate-inputs.json")) as DoctorCandidateInputs | null;
  if (inputs?.implementationScopes?.construction !== job.implementationScopes.construction
    || inputs.implementationScopes.payload !== scopes.payload || !inputs.sourceFingerprint || !inputs.configurationFingerprint
    || inputs.fingerprint !== doctorDigest({sourceFingerprint: inputs.sourceFingerprint, configurationFingerprint: inputs.configurationFingerprint,
      construction: job.implementationScopes.construction, patchRepairs: inputs.patchRepairs,
      ...(inputs.acceptedBackendTransition ? {acceptedBackendTransition: inputs.acceptedBackendTransition} : {})})
    || inputs.candidateReceiptFingerprint !== doctorDigest(job.candidateReceipt)) return false;
  const equivalence = findDoctorConstructionScopeEquivalence(job.implementationScopes, scopes);
  if (!equivalence) return false;
  writeDoctorPrivateJson(join(jobRoot(root, job.id), "candidate-scope-migration-request.json"), {
    version: 1, jobId: job.id, previousJob: job, originalInputsFingerprint: doctorDigest(inputs), equivalence,
  });
  return true;
}

interface DoctorAcceptedWorkerDependencies {
  canonicalManagerRoot: typeof canonicalTweakersManagerRoot;
  verifyGeneration: typeof verifyRetainedTweakersManagerGeneration;
  implementationScopes: typeof doctorImplementationScopes;
  nodeIdentity(): {path: string; sha256: string};
}

/** Scopes belong to the exact sealed worker, including its pinned Node identity. */
function acceptedDoctorWorkerScopes(root: string, executable: ManagerResolvedExecutableIdentityV1,
  overrides: Partial<DoctorAcceptedWorkerDependencies> = {}): DoctorImplementationScopes {
  const deps: DoctorAcceptedWorkerDependencies = {
    canonicalManagerRoot: canonicalTweakersManagerRoot,
    verifyGeneration: verifyRetainedTweakersManagerGeneration,
    implementationScopes: doctorImplementationScopes,
    nodeIdentity: () => { const path = realpathSync(process.execPath);
      return {path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex")}; },
    ...overrides,
  };
  if (root !== deps.canonicalManagerRoot()) throw new Error("Accepted Doctor worker requires the canonical Manager root");
  const paths = tweakersManagerDescriptorPaths(root), generationId = basename(dirname(executable.path ?? ""));
  const launcher = join(paths.generationsRoot, generationId, TWEAKERS_MANAGER_LAUNCHER_NAME);
  if (executable.state !== "resolved" || !/^[a-f0-9]{64}$/.test(generationId)
    || executable.path !== launcher || !/^[a-f0-9]{64}$/.test(executable.sha256)) throw new Error("Accepted Doctor worker launcher identity is invalid");
  const assertLauncher = (): void => {
    const stat = lstatSync(launcher);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(launcher) !== launcher
      || createHash("sha256").update(readFileSync(launcher)).digest("hex") !== executable.sha256) throw new Error("Accepted Doctor worker launcher identity changed");
  };
  assertLauncher();
  const verified = deps.verifyGeneration(generationId);
  if (verified.generationId !== generationId) throw new Error("Accepted Doctor worker verified a different generation");
  const managedId = basename(resolve(verified.moduleRoot, "../../.."));
  if (!/^[a-f0-9]{64}$/.test(managedId) || !/^[a-f0-9]{64}$/.test(basename(verified.runtimeRoot))
    || verified.moduleRoot !== join(paths.managerRoot, "managed-runtime-generations", managedId, "packages", "installer", "dist")
    || dirname(verified.runtimeRoot) !== join(paths.managerRoot, "runtime-generations")) throw new Error("Accepted Doctor worker scopes are outside the verified Manager generation");
  const sealPath = join(dirname(launcher), TWEAKERS_MANAGER_SEAL_NAME);
  const assertSealAndNode = (): void => {
    const stat = lstatSync(sealPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(sealPath) !== sealPath) throw new Error("Accepted Doctor worker target seal changed");
    const bytes = readFileSync(sealPath);
    if (createHash("sha256").update(bytes).digest("hex") !== verified.sealSha256) throw new Error("Accepted Doctor worker target seal changed");
    const seal = parseTweakersManagerTargetSeal(bytes.toString("utf8")), node = deps.nodeIdentity();
    if (seal.generationId !== generationId || seal.launcherSha256 !== executable.sha256
      || node.path !== seal.nodePath || node.sha256 !== seal.nodeSha256) throw new Error("Accepted Doctor worker requires the exact sealed Node and launcher identity");
  };
  assertSealAndNode();
  const scopes = deps.implementationScopes(verified.moduleRoot, verified.runtimeRoot);
  assertLauncher(); assertSealAndNode();
  return scopes;
}

/** Only a deliberate scan or consumed available-update signal calls this; status never does. */
export async function startDoctorUpdateScan(root: string, executable: ManagerResolvedExecutableIdentityV1, force = false, deps: { inputs?: typeof readDoctorIndependentInputs; registeredSource?: typeof readRegisteredOfficialSource; spawn?: typeof spawn; trigger?: "manual" | "available_update"; availableUpdateBuild?: string; resumeOnly?: boolean; acceptedBackendTransition?: AcceptedSharedNativeBackendTransitionRequest; acceptedWorker?: Partial<DoctorAcceptedWorkerDependencies> } = {}): Promise<void> {
  const activeOperation = readLocalOperation();
  if (activeOperation?.state === "running") {
    if (deps.acceptedBackendTransition) throw new Error("Accepted backend replacement requires an idle Doctor scan; retry after current work completes.");
    const prior = readDoctorUpdateJob(root);
    if (prior && activeOperation.kind === `doctor:${prior.id}` && prior.result.state === "checking") {
      if (deps.trigger !== "available_update" || deps.availableUpdateBuild && deps.availableUpdateBuild !== prior.availableUpdateBuild) {
        writeDoctorPrivateJson(join(doctorDirectory(root), "queued-update.json"), {schemaVersion:1,trigger:deps.trigger ?? "manual",availableUpdateBuild:deps.availableUpdateBuild});
      }
      return; // Attach to existing work without fingerprinting mutating outputs.
    }
    // Conflicting callers wait under the shared operation lease below.
  }
  return withLocalOperation("doctor dispatch", async () => {
  const input = (deps.inputs ?? readDoctorIndependentInputs)(root);
  if (!input.nativeIdentity) throw new Error("Native Codex source is unavailable");
  const dir = doctorDirectory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lease = acquireProcessLock(join(dir, "scan-dispatch.lock"));
  try {
    let prior = readDoctorUpdateJob(root);
    const retainedRequest = prior?.nativeIdentity === input.nativeIdentity && prior.installedIdentity === input.installedIdentity
      ? prior.acceptedBackendTransition : undefined;
    // Production scans select the supplied native pair. Injected input fixtures
    // never inspect the operator's native bundle or account registration.
    const nativeSelection = deps.inputs || deps.acceptedBackendTransition ? undefined
      : prepareOfficialBundledBackendSourceSelection({sourceAppRoot: DOCTOR_NATIVE_APP, brokerRoot: input.brokerRoot,
        runtimeRoot: packagedRuntimeAssetsRoot(), transactionId: retainedRequest?.version === 2
          ? retainedRequest.officialBundled.transactionId : randomUUID()});
    const suppliedNativeSourcePolicy = !deps.inputs && !deps.acceptedBackendTransition
      ? doctorSuppliedNativePolicyFromInspection(nativeSelection, input) : undefined;
    if (suppliedNativeSourcePolicy) assertDoctorSuppliedNativeSource(suppliedNativeSourcePolicy, readDoctorIndependentInputs(root), fingerprintAppContents(DOCTOR_NATIVE_APP));
    const transitionRequest = deps.acceptedBackendTransition ?? nativeSelection?.request ?? retainedRequest;
    if (deps.resumeOnly && suppliedNativeSourcePolicy) assertDoctorSuppliedNativeResume(suppliedNativeSourcePolicy, prior?.suppliedNativeSourcePolicy, prior?.sourceOrigin);
    const baselineIdentity = doctorDigest({ version: input.version, build: input.build, originalAsarHash: input.originalAsarHash });
    const implementationScopes = transitionRequest
      ? acceptedDoctorWorkerScopes(root, executable, deps.acceptedWorker)
      : doctorImplementationScopes();
    let recoveringRetainedCandidate = false;
    // A failed empty scan must not strand its immediate predecessor's signed
    // candidate. This only selects evidence for the worker's full revalidation;
    // no historical approval, receipt, or source binding is accepted here.
    if (prior?.result.state !== "checking" && prior?.predecessorId && /^[a-f0-9-]{36}$/.test(prior.predecessorId)
      && !prior.sourcePath && !prior.sourceGenerationId && !prior.sourceReceiptDigest
      && !prior.candidatePackage && !prior.candidateReceipt
      && prior.nativeIdentity === input.nativeIdentity && prior.installedIdentity === input.installedIdentity
      && prior.baselineIdentity === baselineIdentity) {
      const retained = readDoctorPrivateJson(join(dir, "jobs", prior.predecessorId, "job.json")) as DoctorUpdateJobV1 | null;
      const source = (deps.registeredSource ?? readRegisteredOfficialSource)(root);
      if (retained?.schemaVersion === 1 && retained.id === prior.predecessorId
        && retained.supersededBy === prior.id && ["compatible", "fixes_required", "review_required"].includes(retained.result?.state)
        && source.state === "ready" && source.generationId === retained.sourceGenerationId
        && source.receiptDigest === retained.sourceReceiptDigest && source.artifactPath === retained.sourcePath
        && source.sourceDigest === retained.result.sourceFingerprint
        && retained.nativeIdentity === input.nativeIdentity && retained.installedIdentity === input.installedIdentity
        && doctorDigest(retained.suppliedNativeSourcePolicy ?? null) === doctorDigest(suppliedNativeSourcePolicy ?? null)
        && (!suppliedNativeSourcePolicy || retained.sourceOrigin === "native")
        && retained.baselineIdentity === baselineIdentity && retained.implementationScopes?.version === 1
        && retainedConstructionMatches(root, retained, implementationScopes)
        && retained.candidatePackage === join(dir, "jobs", retained.id, "candidate")
        && retained.candidateReceipt && existsSync(retained.candidatePackage)) {
        writeDoctorPrivateJson(join(dir, "jobs", prior.id, "job.json"), {...prior, supersededBy: retained.id});
        prior = {...retained, supersededBy: undefined};
        recoveringRetainedCandidate = true;
      }
    }
    const same = prior?.nativeIdentity === input.nativeIdentity && (prior.baselineIdentity ? prior.baselineIdentity === baselineIdentity : prior.installedIdentity === input.installedIdentity)
      && doctorDigest(prior?.acceptedBackendTransition ?? null) === doctorDigest(transitionRequest ?? null)
      && doctorDigest(prior?.suppliedNativeSourcePolicy ?? null) === doctorDigest(suppliedNativeSourcePolicy ?? null)
      && (!suppliedNativeSourcePolicy || prior?.sourceOrigin === "native");
    const implementationChanged = !sameDoctorCandidateImplementation(prior?.implementationScopes, implementationScopes) || prior?.installedIdentity !== input.installedIdentity;
    // Changed verification requires new evidence, not another desktop copy.
    // Construction inputs and the receipt are still verified by the worker.
    const reverifyCandidate = same && prior?.installedIdentity === input.installedIdentity
      && prior?.implementationScopes?.version === 1
      && retainedConstructionMatches(root, prior, implementationScopes)
      && (recoveringRetainedCandidate || prior.implementationScopes.construction !== implementationScopes.construction || prior.implementationScopes.verification !== implementationScopes.verification)
      && !!prior.candidatePackage && !!prior.candidateReceipt && existsSync(prior.candidatePackage);
    const needsPolicyMigration = prior?.compatibilityPolicyVersion !== 1;
    const running = prior?.result.state === "checking" && (alive(prior.pid) || Date.now() - Date.parse(prior.updatedAt) < 30_000);
    if (deps.trigger === "available_update" && deps.availableUpdateBuild && same && prior?.availableUpdateBuild === deps.availableUpdateBuild && !needsPolicyMigration && !implementationChanged && !recoveringRetainedCandidate) return;
    if (running) {
      if (deps.acceptedBackendTransition) throw new Error("Accepted backend replacement requires an idle Doctor scan; retry after current work completes.");
      if (!same || deps.availableUpdateBuild && deps.availableUpdateBuild !== prior?.availableUpdateBuild) writeDoctorPrivateJson(join(dir, "queued-update.json"), { schemaVersion: 1, trigger: deps.trigger ?? "manual", availableUpdateBuild: deps.availableUpdateBuild });
      return;
    }
    const interrupted = same && prior && (prior.result.state === "checking" || prior.result.phase === "review_incomplete");
    if (same && !force && !interrupted && !implementationChanged && !needsPolicyMigration && !recoveringRetainedCandidate) return;
    if (deps.resumeOnly && !same) throw new Error("The reviewed inputs changed; use Check for updates before resuming.");
    if (prior && needsPolicyMigration) writeDoctorPrivateJson(join(dir, "jobs", prior.id, "historical-review-job.json"), prior);
    const now = new Date().toISOString();
    const reusePrior = same && prior !== null && (!implementationChanged || reverifyCandidate);
    const id = reusePrior && prior ? prior.id : randomUUID();
    if (prior && !reusePrior) {
      prior.supersededBy = id;
      writeDoctorPrivateJson(join(dir, "jobs", prior.id, "job.json"), prior);
    }
    const job: DoctorUpdateJobV1 = reusePrior && prior ? { ...prior, baselineIdentity, installedIdentity: input.installedIdentity, runtimeFingerprint: input.runtimeFingerprint,
      implementationScopes, resumeOnly: reverifyCandidate || deps.resumeOnly === true || prior.resumeOnly === true, workflowVersion: 2, trigger: deps.trigger ?? "manual", pid: process.pid,
      reviewResultDigest: reverifyCandidate ? undefined : prior.reviewResultDigest,
      candidateQuickIdentity: reverifyCandidate ? undefined : prior.candidateQuickIdentity,
      lastCompletedResult: reverifyCandidate ? undefined : prior.result.state === "checking" ? prior.lastCompletedResult : prior.result,
      findings: [], result: { ...prior.result, candidateFingerprint: reverifyCandidate ? null : prior.result.candidateFingerprint, compatibility: undefined, review: undefined, execution: undefined, state: "checking", phase: "resuming", progress: "Resuming verified update evidence…", usage: null, handoff: null, reviewFingerprint: null } } : {
      schemaVersion: 1, workflowVersion: 2, trigger: deps.trigger ?? "manual", id, ...(prior ? { predecessorId: prior.id } : {}), pid: process.pid, startedAt: now, updatedAt: now,
      nativeIdentity: input.nativeIdentity, installedIdentity: input.installedIdentity, baselineIdentity, runtimeFingerprint: input.runtimeFingerprint,
      sourceGenerationId: null, sourceReceiptDigest: null, sourcePath: null, baselinePath: null, candidatePackage: null, candidateReceipt: null,
      result: { state: "checking", phase: "settling", candidateId: id, sourceFingerprint: null, tweakersFingerprint: input.runtimeFingerprint,
        candidateFingerprint: null, reviewFingerprint: null, progress: "Waiting for a stable native Codex update…", usage: null, handoff: null }, findings: [] };
    job.implementationScopes = implementationScopes;
    job.acceptedBackendTransition = transitionRequest;
    job.suppliedNativeSourcePolicy = suppliedNativeSourcePolicy;
    if (suppliedNativeSourcePolicy) job.sourceOrigin = "native";
    job.compatibilityPolicyVersion = 1;
    job.availableUpdateBuild = deps.availableUpdateBuild ?? job.availableUpdateBuild;
    writeDoctorUpdateJob(root, job);
    const child = (deps.spawn ?? spawn)(executable.path, ["doctor-run", "--request-id", id, "--json"], { detached: true, stdio: "ignore", env: {} });
    child.on("error", () => { const latest = readDoctorUpdateJob(root); if (latest?.id === id) { latest.result.state = "review_required"; latest.result.phase = "worker_unavailable"; latest.result.progress = "The managed review worker could not start."; writeDoctorUpdateJob(root, latest); } });
    child.unref();
  } finally { lease.release(); }
  });
}

export function configuredDoctorReviewModel(home = targetUserHome()): { model?: string; effort?: string } {
  const path = join(home, ".codex", "config.toml");
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Codex model configuration is unavailable");
  const parsed = getStaticTOMLValue(parseTOML(readFileSync(path, "utf8"))) as Record<string, unknown>;
  const model = parsed.model, effort = parsed.model_reasoning_effort;
  if (model !== undefined && (typeof model !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(model))) throw new Error("Configured Codex model is invalid");
  if (effort !== undefined && (typeof effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))) throw new Error("Configured Codex reasoning effort is invalid");
  return { ...(typeof model === "string" ? { model } : {}), ...(typeof effort === "string" ? { effort } : {}) };
}
function assertJobInputs(root: string, job: DoctorUpdateJobV1): void {
  const input = readDoctorIndependentInputs(root);
  if (job.suppliedNativeSourcePolicy) assertDoctorSuppliedNativeSource(job.suppliedNativeSourcePolicy, input, fingerprintAppContents(DOCTOR_NATIVE_APP), job.sourceOrigin);
  if ((job.workflowVersion !== 2 && input.nativeIdentity !== job.nativeIdentity) || input.installedIdentity !== job.installedIdentity || !sameDoctorCandidateImplementation(job.implementationScopes, doctorImplementationScopes())
    || readDoctorUpdateJob(root)?.id !== job.id) throw new Error("Doctor update inputs changed; scan again");
}
function totalTreeBytes(path: string): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return Buffer.byteLength(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error("Unsupported source artifact while estimating candidate storage");
  return readdirSync(path).reduce((bytes, name) => bytes + totalTreeBytes(join(path, name)), 0);
}
export async function runDoctorUpdateJob(root: string, id: string, executable: ManagerResolvedExecutableIdentityV1): Promise<void> {
  return withLocalOperation(`doctor:${id}`, () => runDoctorUpdateJobOwned(root, id, executable));
}
async function runDoctorUpdateJobOwned(root: string, id: string, executable: ManagerResolvedExecutableIdentityV1): Promise<void> {
  const job = readDoctorUpdateJob(root);
  if (!job || job.id !== id || job.result.state !== "checking") throw new Error("Doctor review job is stale");
  const workerLease = acquireProcessLock(join(doctorDirectory(root), `worker-${id}.lock`));
  job.pid = process.pid;
  writeDoctorUpdateJob(root, job); // Claim execution before source validation can take time.
  const phase = (name: string, progress: string) => { assertJobInputs(root, job); job.result.phase = name; job.result.progress = progress; writeDoctorUpdateJob(root, job); };
  try {
    verifyDoctorImplementationAssets();
    const installedReservation=readReservations(root).find(entry=>entry.state==="installed"&&entry.paths.length===1&&entry.paths[0]===DOCTOR_APP);
    if(installedReservation?.generationIdentity&&lstatSync(DOCTOR_APP).dev!==installedReservation.generationIdentity.dev) {
      await reconcileInstalledVariantArtifactIdentity(root);
    }
    const input = readDoctorIndependentInputs(root);
    if (job.suppliedNativeSourcePolicy) assertDoctorSuppliedNativeSource(job.suppliedNativeSourcePolicy, input, fingerprintAppContents(DOCTOR_NATIVE_APP), job.sourceOrigin);
    const baseline = findRetainedOfficialSourceForDoctor(root, { version: input.version, build: input.build, originalAsarHash: input.originalAsarHash });
    job.baselinePath = baseline.baselinePath;
    const requireSpace = (additionalBytes: number, stage: string) => {
      const space = statfsSync(root);
      if (space.bavail * space.bsize < 20 * 1024 ** 3 + additionalBytes) {
        throw new Error(`Insufficient disk space for ${stage} and the 20 GiB reserve. Completed review evidence is retained.`);
      }
    };
    // Reusing a retained source does not need another candidate-sized allocation.
    // Check the larger allocation immediately before its own stage instead.
    requireSpace(1024 ** 3, "comparison evidence");
    let preparedSourcePath: string | undefined;
    let first: string | null;
    const existingSource = readRegisteredOfficialSource(root);
    if (job.resumeOnly) {
      if (job.suppliedNativeSourcePolicy) assertDoctorSuppliedNativeResume(job.suppliedNativeSourcePolicy, job.suppliedNativeSourcePolicy, job.sourceOrigin);
      if (job.suppliedNativeSourcePolicy) assertDoctorSuppliedNativeSource(job.suppliedNativeSourcePolicy, input, fingerprintAppContents(DOCTOR_NATIVE_APP), job.sourceOrigin);
      if (job.acceptedBackendTransition) assertDoctorAcceptedNativeFrontend(job.acceptedBackendTransition, fingerprintAppContents(DOCTOR_NATIVE_APP));
      if (existingSource.state !== "ready" || existingSource.generationId !== job.sourceGenerationId
        || existingSource.receiptDigest !== job.sourceReceiptDigest || existingSource.sourceDigest !== job.result.sourceFingerprint
        || existingSource.artifactPath !== job.sourcePath) throw new Error("Retained source changed; use Check for updates to prepare a current comparison.");
      if (job.suppliedNativeSourcePolicy && (existingSource.version !== job.suppliedNativeSourcePolicy.nativeVersion
        || existingSource.build !== job.suppliedNativeSourcePolicy.nativeBuild)) throw new Error("Retained source does not match the supplied native policy");
      phase("resuming", "Reusing the exact retained update source; checking cached evidence…");
      first = existingSource.sourceDigest;
    } else {
    phase("discovering", "Checking stable release metadata once…");
    const latest = await probeDesktopAppcast({ appPath: DOCTOR_NATIVE_APP, baseline: { marketingVersion: input.version, build: input.build } });
    recordDoctorUpstreamCurrency(root, { jobId: id, probe: latest, installedVersion: input.version, installedBuild: input.build });
    const localRuntimeRefresh = doctorInstalledRuntimeNeedsRefresh(join(root,"variants","tweakers","runtime"),packagedRuntimeAssetsRoot());
    const selection = job.suppliedNativeSourcePolicy ? selectDoctorSuppliedNativeSource(job.suppliedNativeSourcePolicy, input,
      fingerprintAppContents(DOCTOR_NATIVE_APP), { version: input.version, build: input.build }, localRuntimeRefresh, !!job.acceptedBackendTransition)
      : selectDoctorProductionSourceForRequest(latest, { version: input.nativeVersion, build: input.nativeBuild },
      job.acceptedBackendTransition, job.acceptedBackendTransition ? fingerprintAppContents(DOCTOR_NATIVE_APP) : undefined,
      localRuntimeRefresh);
    if (selection === "current" || selection === "unavailable") {
      job.result.state = "review_required"; job.result.phase = selection === "current" ? "current" : "discovery_unavailable";
      job.result.progress = selection === "current" ? job.suppliedNativeSourcePolicy
        ? "Tweakers matches the installed native Codex bundle. No model tokens were used."
        : "Tweakers already uses the newest stable upstream build. No model tokens were used." : "Release metadata is unavailable. Check again when connected; no model tokens were used.";
      writeDoctorUpdateJob(root, job); return;
    }
    if (job.suppliedNativeSourcePolicy) {
      await retireSupersededDoctorSource(root, DOCTOR_APP, job.suppliedNativeSourcePolicy.nativeBuild, { suppliedNativeJobId: job.id });
    } else if (!job.acceptedBackendTransition) {
      if (!latest.enclosureUrl || !latest.latestBuild || !latest.latestMarketingVersion) throw new Error("Selected production release metadata is incomplete");
      await retireSupersededDoctorSource(root, DOCTOR_APP, latest.latestBuild);
    }
    if (selection === "download") {
      if (!latest.enclosureUrl || !latest.latestBuild || !latest.latestMarketingVersion) throw new Error("Selected production release metadata is incomplete");
      if (existingSource.state === "ready" && (existingSource.constructionState !== "consumed" || !!job.candidatePackage && !!job.candidateReceipt && existsSync(job.candidatePackage)) && existingSource.build === latest.latestBuild && existingSource.version === latest.latestMarketingVersion) {
        first = existingSource.sourceDigest;
      } else {
        requireSpace(1024 ** 3 + totalTreeBytes(DOCTOR_NATIVE_APP) * 3 + (latest.enclosureLength ?? 0), "download and source staging");
        phase("downloading", "Downloading and verifying the candidate without changing either installed app…");
        const selection = createEnvironmentSelection({ profile: { selectedDesktopPath: DOCTOR_NATIVE_APP, selectedDesktopBundleId: "com.openai.codex", releaseProfile: "stable" } as EnvironmentProfileRecord,
          appExperience: "chatgpt", requestedAt: new Date().toISOString() });
        preparedSourcePath = await prepareOfficialUpdateSource({ selection, latest: { marketingVersion: latest.latestMarketingVersion, build: latest.latestBuild },
          enclosureUrl: latest.enclosureUrl, enclosureLength: latest.enclosureLength, workRoot: join(jobRoot(root, id), "upstream") });
        first = preparedOfficialSourceDigest(root, preparedSourcePath);
      }
      job.sourceOrigin = "download";
    } else {
      phase("settling", "Verifying the native bundle is stable and signed…");
      first = stableOfficialSourceCandidateDigest();
      await delay(1500);
      if (!first || stableOfficialSourceCandidateDigest() !== first) throw new Error("Native Codex is still changing; check again after its update finishes");
      const settled=readDoctorIndependentInputs(root);
      if (job.suppliedNativeSourcePolicy) {
        assertDoctorSuppliedNativeSource(job.suppliedNativeSourcePolicy, settled, fingerprintAppContents(DOCTOR_NATIVE_APP), job.sourceOrigin);
      } else if (job.acceptedBackendTransition) {
        assertDoctorAcceptedNativeFrontend(job.acceptedBackendTransition, fingerprintAppContents(DOCTOR_NATIVE_APP));
        if (!input.nativeBuild || !input.nativeVersion || settled.nativeBuild !== input.nativeBuild || settled.nativeVersion !== input.nativeVersion) throw new Error("Accepted backend repair pinned native source changed during verification");
        await retireSupersededDoctorSource(root, DOCTOR_APP, input.nativeBuild);
      } else if(settled.nativeBuild!==latest.latestBuild||settled.nativeVersion!==latest.latestMarketingVersion)throw new Error("Native Codex no longer matches the selected production release; check again");
      job.sourceOrigin = "native";
    }
    }
    if (!first) throw new Error("Source signature or integrity could not be verified");
    if (job.suppliedNativeSourcePolicy) assertDoctorSuppliedNativeSource(job.suppliedNativeSourcePolicy, readDoctorIndependentInputs(root), fingerprintAppContents(DOCTOR_NATIVE_APP), job.sourceOrigin);
    if (job.acceptedBackendTransition) assertDoctorAcceptedNativeFrontend(job.acceptedBackendTransition, fingerprintAppContents(DOCTOR_NATIVE_APP));
    phase("registering", "Retaining the exact verified upstream source…");
    const constructionSourcePath = job.suppliedNativeSourcePolicy && !job.resumeOnly ? DOCTOR_NATIVE_APP
      : preparedSourcePath ?? (!job.resumeOnly && job.sourceOrigin === "native" ? DOCTOR_NATIVE_APP : undefined);
    if (job.suppliedNativeSourcePolicy && preparedSourcePath) throw new Error("Supplied native source cannot use downloaded construction bytes");
    const matchesSourceEvidence = canReuseRegisteredSourceEvidence(existingSource, first, constructionSourcePath);
    const upgradeCliContext = matchesSourceEvidence && !!existingSource.baselinePath
      && doctorBaselineNeedsCliContextUpgrade(existingSource.baselinePath);
    if (upgradeCliContext) {
      if (existingSource.constructionState === "consumed" || !existingSource.artifactPath || !existsSync(existingSource.artifactPath)) {
        throw new Error("The archived CLI lacks its signed launch context. Restore the verified original source before upgrading this baseline.");
      }
      if (!job.suppliedNativeSourcePolicy && existingSource.artifactPath !== DOCTOR_NATIVE_APP) preparedSourcePath = existingSource.artifactPath;
    }
    const reuseSourceEvidence = matchesSourceEvidence && !upgradeCliContext;
    if (!reuseSourceEvidence) {
      requireSpace(1024 ** 3 + totalTreeBytes(preparedSourcePath ?? DOCTOR_NATIVE_APP), "retained source registration");
    }
    const registered = reuseSourceEvidence ? existingSource
      : await registerOfficialSourceEvidence({ root, operationId: id, expectedSourceDigest: first, managerExecutable: executable, ...(preparedSourcePath ? { preparedSourcePath } : {}) });
    const source = readRegisteredOfficialSource(root);
    if (source.state !== "ready" || !source.artifactPath || source.generationId !== registered.generationId || source.receiptDigest !== registered.receiptDigest) throw new Error("Source registration did not verify");
    if (job.suppliedNativeSourcePolicy && (source.version !== job.suppliedNativeSourcePolicy.nativeVersion
      || source.build !== job.suppliedNativeSourcePolicy.nativeBuild)) throw new Error("Registered source differs from the supplied native policy");
    if (job.result.sourceFingerprint && job.result.sourceFingerprint !== source.sourceDigest) {
      writeDoctorPrivateJson(join(jobRoot(root, id), "source-history", `${job.result.sourceFingerprint.replace(/^sha256:/, "")}.json`), { ...job, supersededBy: `${id}:${source.sourceDigest}` });
      job.lastCompletedResult = undefined;
    }
    job.sourcePath = source.artifactPath; job.sourceGenerationId = source.generationId; job.sourceReceiptDigest = source.receiptDigest;
    job.result.sourceFingerprint = source.sourceDigest;
    if (job.trigger !== "manual" && job.lastCompletedResult?.phase === "candidate_verified" && job.lastCompletedResult.sourceFingerprint === source.sourceDigest) {
      const pending = job.result;
      job.result = job.lastCompletedResult;
      writeDoctorUpdateJob(root, job);
      try {
        (await import("./doctor-approval.js")).verifyDoctorCandidate(root, job);
        return; // Valid exact candidate and evidence: no extraction, rebuild, or paid review.
      } catch {
        job.result = pending;
        phase("comparing", "Regenerating missing or changed candidate evidence…");
      }
    }
    const packet = jobRoot(root, id);
    mkdirSync(packet, { recursive: true, mode: 0o700 });
    const evidenceRoot = join(packet, "evidence");
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    phase("comparing", "Comparing shipped frontend, helpers, backend, and exact app-server schemas…");
    const before = await collectDoctorSourceEvidence(job.baselinePath, join(evidenceRoot, "before"));
    const after = await collectDoctorSourceEvidence(source.baselinePath ?? job.sourcePath, join(evidenceRoot, "after"));
    const baseComparison = compareDoctorSourceEvidence(before, after);
    const comparison = baseComparison;
    writeDoctorPrivateJson(join(evidenceRoot, "comparison.json"), comparison);
    const configurationFingerprint = doctorConfigurationFingerprint(input.variantRoot);
    const doctorConfiguration = existsSync(join(input.variantRoot, "config.json"))
      ? JSON.parse(readFileSync(join(input.variantRoot, "config.json"), "utf8")) : undefined;
    const accountsEnabled = doctorConfiguration?.tweaker?.safeMode !== true
      && doctorConfiguration?.tweaks?.["co.tweakers.account-switcher"]?.enabled !== false;
    if (doctorConfigurationFingerprint(input.variantRoot) !== configurationFingerprint) throw new Error("Tweak configuration changed before compatibility validation");
    // Keep optional historical explanations and explicit intent, but do not generate
    // a whole-release questionnaire on the update's critical path.
    const prior = readDoctorPrivateJson(join(packet, "changes.json"), { maxBytes: 128 * 1024 * 1024 }) as DoctorChangeReportV1 | null;
    const changes: DoctorChangeReportV1 = prior && prior.beforeFingerprint === before.fingerprint && prior.afterFingerprint === after.fingerprint
      && prior.fingerprint === changeReportFingerprint(prior) ? { ...prior, comparisonFingerprint: comparison.fingerprint, candidateFingerprint: null,
        implementationFingerprint: job.implementationScopes!.construction, reviewProgress: undefined } : {
        schemaVersion: 1, jobId: id, beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint,
        comparisonFingerprint: comparison.fingerprint, implementationFingerprint: job.implementationScopes!.construction, candidateFingerprint: null,
        changes: [], coverage: {total: comparison.changes.length, classified: 0, unresolved: comparison.changes.length},
        limitations: ["Upstream changelog generation is optional and does not determine compatibility."], fingerprint: "" };
    saveDoctorChangeReport(root, job, changes);
    job.result.review = undefined;
    job.result.compatibility = undefined;
    const registrationPath = join(input.brokerRoot, "shared-native-mode.v1.json");
    const signedResolver = existsSync(registrationPath)
      ? sharedNativeBackendTransitionPort().readSharedNativeModeAtRootV1({stateRoot: input.brokerRoot}) : null;
    if (signedResolver && signedResolver.state !== "ready") throw new Error(`Signed backend registration is unavailable: ${signedResolver.reason ?? signedResolver.state}`);
    const retainLegacyResolver = !!signedResolver && signedResolver.document?.resolverProtocol !== "official-bundled-v1";
    // A replacement uses the already collected current-native interfaces and accepted source pair.
    // The extra installed-resolver comparison applies only when retaining that old resolver.
    if (job.acceptedBackendTransition) sealAcceptedSharedNativeBackendTransition({request: job.acceptedBackendTransition,
      identity: {target: DOCTOR_APP, userRoot: input.variantRoot, brokerRoot: input.brokerRoot},
      installerPayloadHash: installerPayloadHash(), runtimeRoot: packagedRuntimeAssetsRoot(), sourceAppRoot: job.sourcePath!});
    const retainedBackendPreflight = !job.acceptedBackendTransition && retainLegacyResolver && (input.build !== after.build || input.version !== after.version)
      ? await collectDoctorSourceEvidence(DOCTOR_APP, join(packet, "registered-backend-preflight")) : undefined;
    phase("checking", "Checking the patch and app-server interfaces Tweakers uses…");
    let validation = await collectDoctorValidation({ before, after, comparison, outputRoot: join(packet, "review", "validation"),
      tweakersSourceRoot: packagedRuntimeAssetsRoot(), compatibilityOnly: true, accountsEnabled, retainedBackendPreflight });
    const requiredChecks = ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity",
      "window-services-patch", "inactive-thread-retention-patch", "accounts-native-patch",
      ...validation.checks.filter(c => c.id === "model-selection-patch" || c.id === "billing-analytics-patch").map(c => c.id)];
    if (retainedBackendPreflight) requiredChecks.push("retained-backend-upstream-compatibility");
    job.result.compatibility = makeDoctorCompatibility({ implementationScopes: job.implementationScopes,validation, configurationFingerprint, requiredChecks, candidateFingerprint: null});
    const patchRepairs: DoctorPatchRepairV1[] = [];
    const repairAttempts: NonNullable<typeof job.result.compatibility>["repairs"] = [];
    for (const check of job.result.compatibility.checks.filter(c => c.outcome === "conflict")) {
      check.nextAction = "Automatic model repair is disabled until token policy is agreed. Inspect this failed check and its retained evidence; no model request was sent.";
    }
    if (patchRepairs.length) {
      validation = await collectDoctorValidation({before, after, comparison, outputRoot: join(packet, "review", "validation"),
        tweakersSourceRoot: packagedRuntimeAssetsRoot(), compatibilityOnly: true, accountsEnabled, patchRepairs, retainedBackendPreflight});
      job.result.compatibility = makeDoctorCompatibility({ implementationScopes: job.implementationScopes,validation, configurationFingerprint, requiredChecks, candidateFingerprint: null, repairs: repairAttempts});
    } else {
      job.result.compatibility.repairs = repairAttempts;
      job.result.compatibility.fingerprint = compatibilityFingerprint(job.result.compatibility);
    }
    if (job.result.compatibility.checks.some(c => c.outcome !== "passed")) {
      job.result.state = job.result.compatibility.status === "conflict" ? "fixes_required" : "review_required";
      job.result.phase = "needs_attention";
      job.result.progress = job.result.compatibility.checks.some(c => c.id === "retained-backend-upstream-compatibility" && c.outcome !== "passed")
        ? accountsEnabled
          ? "This update needs a compatible retained backend. The installed backend does not pass the new desktop interface checks; no candidate was built."
          : "Accounts is off, so its UI hooks are not required. The app still uses a previously registered backend, which does not pass the new desktop interface checks. A verified backend transition is required; saved accounts and chats have not been changed."
        : "Compatibility checks need attention. Optional upstream explanations do not block this update.";
      job.findings = job.result.compatibility.checks.filter(c => c.outcome !== "passed").map(c => ({id: `compatibility.${c.id}`, stage: "compatibility", severity: "error",
        reason: c.outcome, title: c.owner, detail: `${c.observed}\nNext: ${c.nextAction}`, evidence: c.evidence}));
      writeDoctorUpdateJob(root, job); return;
    }
    phase("applying_patches", "Applying patches to a disposable candidate and verifying its package…");
    const output = join(packet, "candidate"), signing = findExistingPreparedSigningIdentity();
    const retainedCandidateInputs = readDoctorPrivateJson(join(packet, "candidate-inputs.json")) as DoctorCandidateInputs | null;
    const sourceFingerprint = existsSync(job.sourcePath)?fingerprintVariantGeneration(job.sourcePath):retainedCandidateInputs?.sourceFingerprint;
    if(!sourceFingerprint)throw new Error("Consumed source has no completed candidate binding; reconcile interrupted construction before retrying");
    // The builder owns all writes under output. It performs patch coverage,
    // backend resolver, ASAR, signature and candidate receipt verification.
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const retainRegisteredBackend = !job.acceptedBackendTransition && retainLegacyResolver ? {
      installedFingerprint: fingerprintVariantGeneration(DOCTOR_APP), sourceFingerprint,
      installedStateSha256: hash(join(input.variantRoot, "state.json")),
      registrationSha256: hash(registrationPath), backendSha256: hash(join(DOCTOR_APP, "Contents", "Resources", "codex")),
    } : undefined;
    const expectedIdentity = { appTarget: DOCTOR_APP, userRoot: input.variantRoot, appUserDataRoot: join(input.variantRoot, "app-data"),
      codexHomeRoot: join(input.variantRoot, "codex-home"), accountsBrokerRoot: input.brokerRoot };
    const verifyPackage = () => {
      const raw = readDoctorPrivateJson(join(output, "receipt", "TweakersCandidateReceipt.bundle", "Contents", "Resources", "variant-candidate-receipt.json")) as TweakersVariantCandidateReceipt;
      if (!raw || raw.source.path !== job.sourcePath || raw.source.physicalPath !== (existsSync(job.sourcePath!)?realpathSync(job.sourcePath!):job.sourcePath)
        || doctorDigest(raw.source.fingerprint) !== doctorDigest(sourceFingerprint)) throw new Error("Candidate source does not match the reviewed source");
      return verifyTweakersVariantCandidateReceipt(output, { expectedSigningIdentityHash: signing.hash, expectedTransactionId: raw.id,
        expectedPackageRoot: output, expectedObservedPackageRoot: output, expectedSource: raw.source, expectedIdentity });
    };
    const laneInput = job.acceptedBackendTransition ? {acceptedBackendTransition: job.acceptedBackendTransition} : {};
    const candidateInputFingerprint = doctorDigest({sourceFingerprint, configurationFingerprint, construction: job.implementationScopes!.construction, patchRepairs, ...laneInput});
    let receipt: TweakersVariantCandidateReceipt | null = null;
    let scopeEquivalence: ReturnType<typeof findDoctorConstructionScopeEquivalence> = null;
    if (retainedCandidateInputs?.fingerprint !== candidateInputFingerprint && retainedCandidateInputs?.implementationScopes) {
      const oldConstruction = retainedCandidateInputs.implementationScopes.construction;
      // Rebind exactly the current source/config/repairs to the immutable old
      // input record before considering code equivalence. A stored migration
      // request alone is never authority: validate the historical seal again.
      if (retainedCandidateInputs.fingerprint === doctorDigest({sourceFingerprint, configurationFingerprint, construction: oldConstruction, patchRepairs, ...laneInput})) {
        scopeEquivalence = findDoctorConstructionScopeEquivalence(retainedCandidateInputs.implementationScopes, job.implementationScopes!);
      }
    }
    if ((retainedCandidateInputs?.fingerprint === candidateInputFingerprint || scopeEquivalence) && job.candidatePackage === output && job.candidateReceipt && existsSync(output)) {
      try {
        const retained = verifyPackage();
        if (doctorDigest(retained) === doctorDigest(job.candidateReceipt) && doctorDigest(retained) === retainedCandidateInputs?.candidateReceiptFingerprint) receipt = retained;
      } catch (error) { throw new Error(`Retained candidate integrity failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!receipt && (job.candidatePackage || existsSync(output) || readdirSync(packet).some(name => name.startsWith("candidate-retained-")))) {
      throw new Error("Retained candidate inputs are unverified or changed. Preserve the candidate and reconcile its scoped construction evidence before retrying; no rebuild was started.");
    }
    if (!receipt) {
      if (source.constructionState === "consumed" && !existsSync(job.sourcePath)) throw new Error("The source slot was consumed by an earlier candidate. Reconcile that candidate before preparing another; historical baseline evidence remains available.");
      requireSpace(1024 ** 3 + totalTreeBytes(job.sourcePath) * 3, "candidate preparation and rollback");
      // Keep failed or interrupted staging for diagnosis, never overwrite its receipt.
      if (existsSync(output)) renameSync(output, join(packet, `candidate-retained-${randomUUID()}`));
      await createTweakersVariant({ source: job.sourcePath, app: DOCTOR_APP, userRoot: input.variantRoot, candidateOnly: true, output, doctorPatchRepairs: patchRepairs,
        ...(job.sourcePath!==DOCTOR_NATIVE_APP?{consumePreparedSource:{root}}:{}),
        doctorAccountsRecoveryRoot: join(packet, `accounts-recovery-${randomUUID()}`),
        doctorConfiguration,
        ...laneInput,
        ...(retainRegisteredBackend ? { retainRegisteredBackend } : {}) });
      receipt = verifyPackage();
      writeDoctorPrivateJson(join(packet, "candidate-inputs.json"), {version: 1, fingerprint: candidateInputFingerprint, implementationScopes: job.implementationScopes, sourceFingerprint, configurationFingerprint, patchRepairs, ...laneInput, candidateReceiptFingerprint: doctorDigest(receipt)});
    }
    assertJobInputs(root, job);
    if (scopeEquivalence) writeDoctorPrivateJson(join(packet, "candidate-scope-equivalence.json"), {
      version: 1, verifiedAt: new Date().toISOString(), originalInputsFingerprint: doctorDigest(retainedCandidateInputs),
      candidateReceiptFingerprint: doctorDigest(receipt), currentInputFingerprint: candidateInputFingerprint, equivalence: scopeEquivalence,
    });
    job.candidateQuickIdentity = doctorBundleIdentity(join(output, "Tweakers.app"));
    job.candidatePackage = output; job.candidateReceipt = receipt; job.result.candidateFingerprint = doctorDigest(receipt);
    changes.candidateFingerprint = job.result.candidateFingerprint;
    (await import("./doctor-overrides.js")).addDoctorTitlebarOptions(changes, job, join(input.variantRoot, "config.json"));
    saveDoctorChangeReport(root, job, changes);
    if (doctorConfigurationFingerprint(input.variantRoot) !== configurationFingerprint) throw new Error("Tweak configuration changed during candidate preparation");
    phase("checking", "Verifying the exact candidate backend and runtime interfaces…");
    const candidateEvidence = await collectDoctorSourceEvidence(join(output, "Tweakers.app"), join(packet, "candidate-evidence"));
    const retainedBackendBaseline = retainRegisteredBackend && input.build === after.build && input.version === after.version
      ? {evidence: await collectDoctorSourceEvidence(DOCTOR_APP, join(packet, "installed-backend-baseline")), originalAsarHeaderHash: input.originalAsarHash!}
      : undefined;
    assertJobInputs(root, job);
    validation = await collectDoctorValidation({before, after, comparison, candidateEvidence, outputRoot: join(packet, "review", "validation"),
      tweakersSourceRoot: join(output, "runtime"), compatibilityOnly: true, accountsEnabled, patchRepairs, retainedBackendBaseline, retainedBackendPreflight});
    if (retainedBackendBaseline) requiredChecks.push("retained-backend-baseline");
    job.result.compatibility = makeDoctorCompatibility({ implementationScopes: job.implementationScopes, validation, configurationFingerprint, requiredChecks: [...new Set([...DOCTOR_CORE_CHECKS, ...requiredChecks])], candidateFingerprint: job.result.candidateFingerprint, repairs: repairAttempts });
    if (job.result.compatibility.status !== "passed") {
      job.result.state = job.result.compatibility.status === "conflict" ? "fixes_required" : "review_required";
      job.result.phase = "needs_attention"; job.result.progress = "The sealed candidate has unresolved compatibility checks; the installed variant remains active.";
      job.findings = job.result.compatibility.checks.filter(c => c.outcome !== "passed").map(c => ({id: `compatibility.${c.id}`, stage: "compatibility", severity: "error",
        reason: c.outcome, title: c.owner, detail: c.observed, evidence: c.evidence}));
      writeDoctorUpdateJob(root, job); return;
    }
    writeDoctorPrivateJson(join(packet, "compatibility.json"), job.result.compatibility);
    job.result.reviewFingerprint = job.result.compatibility.fingerprint;
    job.result.state = "compatible"; job.result.phase = "candidate_verified";
    job.result.progress = "Ready to install. Required compatibility and candidate checks passed.";
    writeDoctorUpdateJob(root, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update review failed";
    const candidateFailure = job.result.phase === "applying_patches";
    job.result.state = candidateFailure ? "fixes_required" : "review_required";
    job.result.phase = "needs_attention";
    if (job.result.compatibility) {
      job.result.compatibility.status = "verification_unavailable";
      job.result.compatibility.binding.candidateFingerprint = null;
      job.result.compatibility.checks.push({id: candidateFailure ? "candidate-construction" : "verification-execution", owner: candidateFailure ? "Candidate builder" : "Compatibility verification",
        outcome: "verification_unavailable", expected: "Complete candidate construction and required verification", observed: message,
        evidence: [], nextAction: "Inspect retained diagnostics and retry after resolving the reported failure"});
      job.result.compatibility.fingerprint = compatibilityFingerprint(job.result.compatibility);
    }
    job.result.progress = message;
    job.result.handoff = `Tweakers Manager · Doctor ${job.id}\nNative source: ${job.sourceGenerationId ?? "unverified"}\nRuntime: ${job.runtimeFingerprint}\n${message}\nInspect the owned evidence packet, implement the required compatibility fixes, and rerun Doctor. Do not promote this candidate.`;
    job.result.candidateFingerprint = null;
    job.findings.push({ id: "independent.update.check", stage: candidateFailure ? "candidate" : "compatibility", severity: "warning",
      reason: job.result.phase, title: candidateFailure ? "Candidate construction unavailable" : "Verification is incomplete", detail: message, evidence: [] });
    if (readDoctorUpdateJob(root)?.id === id) writeDoctorUpdateJob(root, job);
  } finally {
    workerLease.release();
    // Worker locks are unique per job; drop the now-empty claims directory so
    // every check does not leave another one behind. rmdir fails if non-empty.
    try { rmdirSync(join(doctorDirectory(root), `worker-${id}.lock.claims`)); } catch { /* still claimed or already gone */ }
    const finished = readDoctorUpdateJob(root);
    if (finished?.id === id && finished.result.state !== "checking" && finished.result.phase !== "current") {
      const notification = { jobId: id, source: finished.result.sourceFingerprint, candidate: finished.result.candidateFingerprint, phase: finished.result.phase, progress: finished.result.progress };
      const path = join(doctorDirectory(root), "last-notification.json");
      if (doctorDigest(readDoctorPrivateJson(path)) !== doctorDigest(notification)) {
        const { showNotification } = await import("./alerts.js");
        showNotification({ title: finished.result.phase === "candidate_verified" ? "Tweakers update is ready" : "Tweakers update needs attention", message: finished.result.progress.slice(0, 280) });
        writeDoctorPrivateJson(path, notification);
      }
    }
    // Best effort: superseded generations are retired after this Doctor
    // operation releases its lease; failure never changes the job result.
    void import("./generation-retention.js")
      .then((retention) => retention.scheduleGenerationRetention(root, "doctor job completed"))
      .catch(() => { /* Retention never affects Doctor results. */ });
    // Only consume a request that actually arrived while this job was running.
    // Completion itself never discovers a new release.
    const queuedPath = join(doctorDirectory(root), "queued-update.json");
    const queued = readDoctorPrivateJson(queuedPath) as { schemaVersion?: number; trigger?: "manual" | "available_update"; availableUpdateBuild?: string } | null;
    if (queued?.schemaVersion === 1 && ["manual", "available_update"].includes(queued.trigger ?? "")) {
      unlinkSync(queuedPath);
      await startDoctorUpdateScan(root, executable, true, { trigger: queued.trigger, availableUpdateBuild: queued.availableUpdateBuild });
    }
  }
}

/** Keep update blockers visible without flooding either UI with one row per bundle member. */
export function doctorReviewFindings(review: ReviewDoctorSourceChangesResult, artifact: string): DoctorFindingV1[] {
  const groups = new Map<string, NonNullable<ReviewDoctorSourceChangesResult["findings"]>>();
  for (const finding of review.findings ?? []) {
    if (finding.disposition === "compatible") continue;
    const key = JSON.stringify([finding.disposition, finding.summary, finding.requiredChecks, finding.proposedFixes]);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].map((members, index) => {
    const first = members[0]!;
    const paths = [...new Set(members.flatMap(member => member.path ? member.path.split("\n") : []))];
    return {
      id: `independent.update.review.${index + 1}`, stage: "compatibility", severity: "warning",
      reason: first.disposition,
      title: first.id.startsWith("validation.") ? `Compatibility check: ${first.requiredChecks[0] ?? "incomplete"}`
        : first.disposition === "fixes_required" ? "Compatibility needs a source fix" : "Compatibility evidence needs attention",
      detail: [first.summary, paths.length ? `Affected entries: ${paths.length}.` : "",
        first.requiredChecks.length ? `Required checks:\n${first.requiredChecks.map(check => `• ${check}`).join("\n")}` : "",
        first.proposedFixes.length ? `Proposed fixes:\n${first.proposedFixes.map(fix => `• ${fix}`).join("\n")}` : "",
        paths.length > 8 ? `Showing eight affected paths; the complete list is in the review evidence.` : "",
      ].filter(Boolean).join("\n\n"),
      evidence: [...paths.slice(0, 8), artifact],
    };
  });
}

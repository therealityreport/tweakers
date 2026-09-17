import { doctorImplementationScopes, sameDoctorCandidateImplementation, verifyDoctorImplementationAssets } from "./doctor-implementation.js";
import type { DoctorPatchRepairV1 } from "./doctor-patch-repair.js";
import { DOCTOR_CORE_CHECKS, compatibilityFingerprint, doctorConfigurationFingerprint, makeDoctorCompatibility } from "./doctor-compatibility.js";
import { probeDesktopAppcast } from "./desktop-appcast-probe.js";
import { prepareOfficialUpdateSource } from "./official-update-download.js";
import { createEnvironmentSelection, type EnvironmentProfileRecord } from "./environment-profile.js";
import { changeReportFingerprint, saveDoctorChangeReport } from "./doctor-adoption.js";
import { spawn } from "node:child_process";
import { acquireProcessLock } from "./process-lock.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statfsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import type { ManagerResolvedExecutableIdentityV1 } from "./manager-contract.js";
import { targetUserHome } from "./ownership.js";
import { findExistingPreparedSigningIdentity } from "./codesign.js";
import { packagedRuntimeAssetsRoot } from "./commands/install.js";
import { createTweakersVariant, fingerprintVariantGeneration, verifyTweakersVariantCandidateReceipt, type TweakersVariantCandidateReceipt } from "./commands/create-variant.js";
import { findRetainedOfficialSourceForDoctor, readRegisteredOfficialSource, registerStableOfficialSource, preparedOfficialSourceDigest, stableOfficialSourceCandidateDigest } from "./official-source-registration.js";
import { collectDoctorSourceEvidence, compareDoctorSourceEvidence } from "./doctor-evidence.js";
import { DOCTOR_APP, DOCTOR_NATIVE_APP, doctorBundleIdentity, readDoctorIndependentInputs } from "./doctor-independent.js";
import { doctorDigest, doctorDirectory, readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson, writeDoctorUpdateJob, type DoctorUpdateJobV1 } from "./doctor-store.js";
import type { DoctorChangeReportV1, DoctorFindingV1 } from "@therealityreport/tweakers-sdk";
import type { ReviewDoctorSourceChangesResult } from "./doctor-review.js";
import { collectDoctorValidation, doctorPatchImplementationFingerprint, type DoctorValidationReport } from "./doctor-validation.js";

const jobRoot = (root: string, id: string) => join(doctorDirectory(root), "jobs", id);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** Only a deliberate scan or consumed available-update signal calls this; status never does. */
export function startDoctorUpdateScan(root: string, executable: ManagerResolvedExecutableIdentityV1, force = false, deps: { inputs?: typeof readDoctorIndependentInputs; spawn?: typeof spawn; trigger?: "manual" | "available_update"; availableUpdateBuild?: string; resumeOnly?: boolean } = {}): void {
  const input = (deps.inputs ?? readDoctorIndependentInputs)(root);
  if (!input.nativeIdentity) throw new Error("Native Codex source is unavailable");
  const dir = doctorDirectory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lease = acquireProcessLock(join(dir, "scan-dispatch.lock"));
  try {
    const prior = readDoctorUpdateJob(root);
    const baselineIdentity = doctorDigest({ version: input.version, build: input.build, originalAsarHash: input.originalAsarHash });
    const same = prior?.nativeIdentity === input.nativeIdentity && (prior.baselineIdentity ? prior.baselineIdentity === baselineIdentity : prior.installedIdentity === input.installedIdentity);
    const implementationScopes = doctorImplementationScopes();
    const implementationChanged = !sameDoctorCandidateImplementation(prior?.implementationScopes, implementationScopes) || prior?.installedIdentity !== input.installedIdentity;
    const needsPolicyMigration = prior?.compatibilityPolicyVersion !== 1;
    const running = prior?.result.state === "checking" && (alive(prior.pid) || Date.now() - Date.parse(prior.updatedAt) < 30_000);
    if (deps.trigger === "available_update" && deps.availableUpdateBuild && same && prior?.availableUpdateBuild === deps.availableUpdateBuild && !needsPolicyMigration && !implementationChanged) return;
    if (running) {
      if (!same || deps.availableUpdateBuild && deps.availableUpdateBuild !== prior?.availableUpdateBuild) writeDoctorPrivateJson(join(dir, "queued-update.json"), { schemaVersion: 1, trigger: deps.trigger ?? "manual", availableUpdateBuild: deps.availableUpdateBuild });
      return;
    }
    const interrupted = same && prior && (prior.result.state === "checking" || prior.result.phase === "review_incomplete");
    if (same && !force && !interrupted && !implementationChanged && !needsPolicyMigration) return;
    if (deps.resumeOnly && !same) throw new Error("The reviewed inputs changed; use Check for updates before resuming.");
    if (prior && needsPolicyMigration) writeDoctorPrivateJson(join(dir, "jobs", prior.id, "historical-review-job.json"), prior);
    const now = new Date().toISOString();
    const id = same && prior ? prior.id : randomUUID();
    if (prior && !same) {
      prior.supersededBy = id;
      writeDoctorPrivateJson(join(dir, "jobs", prior.id, "job.json"), prior);
    }
    const job: DoctorUpdateJobV1 = same && prior ? { ...prior, baselineIdentity, installedIdentity: input.installedIdentity, runtimeFingerprint: input.runtimeFingerprint,
      implementationScopes, resumeOnly: deps.resumeOnly === true || prior.resumeOnly === true, workflowVersion: 2, trigger: deps.trigger ?? "manual", pid: process.pid,
      lastCompletedResult: prior.result.state === "checking" ? prior.lastCompletedResult : prior.result,
      findings: [], result: { ...prior.result, compatibility: undefined, state: "checking", phase: "resuming", progress: "Resuming verified update evidence…", usage: null, handoff: null, reviewFingerprint: null } } : {
      schemaVersion: 1, workflowVersion: 2, trigger: deps.trigger ?? "manual", id, ...(prior ? { predecessorId: prior.id } : {}), pid: process.pid, startedAt: now, updatedAt: now,
      nativeIdentity: input.nativeIdentity, installedIdentity: input.installedIdentity, baselineIdentity, runtimeFingerprint: input.runtimeFingerprint,
      sourceGenerationId: null, sourceReceiptDigest: null, sourcePath: null, baselinePath: null, candidatePackage: null, candidateReceipt: null,
      result: { state: "checking", phase: "settling", candidateId: id, sourceFingerprint: null, tweakersFingerprint: input.runtimeFingerprint,
        candidateFingerprint: null, reviewFingerprint: null, progress: "Waiting for a stable native Codex update…", usage: null, handoff: null }, findings: [] };
    job.implementationScopes = implementationScopes;
    job.compatibilityPolicyVersion = 1;
    job.availableUpdateBuild = deps.availableUpdateBuild ?? job.availableUpdateBuild;
    writeDoctorUpdateJob(root, job);
    const child = (deps.spawn ?? spawn)(executable.path, ["doctor-run", "--request-id", id, "--json"], { detached: true, stdio: "ignore", env: {} });
    child.on("error", () => { const latest = readDoctorUpdateJob(root); if (latest?.id === id) { latest.result.state = "review_required"; latest.result.phase = "worker_unavailable"; latest.result.progress = "The managed review worker could not start."; writeDoctorUpdateJob(root, latest); } });
    child.unref();
  } finally { lease.release(); }
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
  const job = readDoctorUpdateJob(root);
  if (!job || job.id !== id || job.result.state !== "checking") throw new Error("Doctor review job is stale");
  const workerLease = acquireProcessLock(join(doctorDirectory(root), `worker-${id}.lock`));
  job.pid = process.pid;
  writeDoctorUpdateJob(root, job); // Claim execution before source validation can take time.
  const phase = (name: string, progress: string) => { assertJobInputs(root, job); job.result.phase = name; job.result.progress = progress; writeDoctorUpdateJob(root, job); };
  try {
    verifyDoctorImplementationAssets();
    const input = readDoctorIndependentInputs(root);
    const baseline = findRetainedOfficialSourceForDoctor(root, { version: input.version, build: input.build, originalAsarHash: input.originalAsarHash });
    job.baselinePath = baseline.receipt.artifact.appPath;
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
      if (existingSource.state !== "ready" || existingSource.generationId !== job.sourceGenerationId
        || existingSource.receiptDigest !== job.sourceReceiptDigest || existingSource.sourceDigest !== job.result.sourceFingerprint
        || existingSource.artifactPath !== job.sourcePath) throw new Error("Retained source changed; use Check for updates to prepare a current comparison.");
      phase("resuming", "Reusing the exact retained update source; checking cached evidence…");
      first = existingSource.sourceDigest;
    } else {
    phase("discovering", "Checking stable release metadata once…");
    const latest = await probeDesktopAppcast({ appPath: DOCTOR_NATIVE_APP, baseline: { marketingVersion: input.version, build: input.build } });
    if (latest.state === "update-available" && latest.enclosureUrl && latest.latestBuild && latest.latestMarketingVersion) {
      if (existingSource.state === "ready" && existingSource.build === latest.latestBuild && existingSource.version === latest.latestMarketingVersion) {
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
      if (!input.nativeBuild || BigInt(input.nativeBuild) <= BigInt(input.build)) {
        job.result.state = "review_required"; job.result.phase = latest.state === "current" ? "current" : "discovery_unavailable";
        job.result.progress = latest.state === "current" ? "Tweakers already uses the newest stable upstream build. No model tokens were used." : "Release metadata is unavailable. Check again when connected; no model tokens were used.";
        writeDoctorUpdateJob(root, job); return;
      }
      phase("settling", "Verifying the native bundle is stable and signed…");
      first = stableOfficialSourceCandidateDigest();
      await delay(1500);
      if (!first || stableOfficialSourceCandidateDigest() !== first) throw new Error("Native Codex is still changing; check again after its update finishes");
      job.sourceOrigin = "native";
    }
    }
    if (!first) throw new Error("Source signature or integrity could not be verified");
    phase("registering", "Retaining the exact verified upstream source…");
    if (!(existingSource.state === "ready" && existingSource.sourceDigest === first)) {
      requireSpace(1024 ** 3 + totalTreeBytes(preparedSourcePath ?? DOCTOR_NATIVE_APP), "retained source registration");
    }
    const registered = existingSource.state === "ready" && existingSource.sourceDigest === first ? existingSource
      : registerStableOfficialSource({ root, operationId: id, expectedSourceDigest: first, managerExecutable: executable, ...(preparedSourcePath ? { preparedSourcePath } : {}) });
    const source = readRegisteredOfficialSource(root);
    if (source.state !== "ready" || !source.artifactPath || source.generationId !== registered.generationId || source.receiptDigest !== registered.receiptDigest) throw new Error("Source registration did not verify");
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
    const after = await collectDoctorSourceEvidence(job.sourcePath, join(evidenceRoot, "after"));
    const baseComparison = compareDoctorSourceEvidence(before, after);
    const comparison = baseComparison;
    writeDoctorPrivateJson(join(evidenceRoot, "comparison.json"), comparison);
    const configurationFingerprint = doctorConfigurationFingerprint(input.variantRoot);
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
    phase("checking", "Checking the patch and app-server interfaces Tweakers uses…");
    let validation = await collectDoctorValidation({ before, after, comparison, outputRoot: join(packet, "review", "validation"),
      tweakersSourceRoot: packagedRuntimeAssetsRoot(), compatibilityOnly: true });
    const requiredChecks = ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity",
      "window-services-patch", "inactive-thread-retention-patch", "accounts-native-patch",
      ...validation.checks.filter(c => c.id === "model-selection-patch").map(c => c.id)];
    job.result.compatibility = makeDoctorCompatibility({ implementationScopes: job.implementationScopes,validation, configurationFingerprint, requiredChecks, candidateFingerprint: null});
    const patchRepairs: DoctorPatchRepairV1[] = [];
    const repairAttempts: NonNullable<typeof job.result.compatibility>["repairs"] = [];
    for (const check of job.result.compatibility.checks.filter(c => c.outcome === "conflict")) {
      check.nextAction = "Automatic model repair is disabled until token policy is agreed. Inspect this failed check and its retained evidence; no model request was sent.";
    }
    if (patchRepairs.length) {
      validation = await collectDoctorValidation({before, after, comparison, outputRoot: join(packet, "review", "validation"),
        tweakersSourceRoot: packagedRuntimeAssetsRoot(), compatibilityOnly: true, patchRepairs});
      job.result.compatibility = makeDoctorCompatibility({ implementationScopes: job.implementationScopes,validation, configurationFingerprint, requiredChecks, candidateFingerprint: null, repairs: repairAttempts});
    } else {
      job.result.compatibility.repairs = repairAttempts;
      job.result.compatibility.fingerprint = compatibilityFingerprint(job.result.compatibility);
    }
    if (job.result.compatibility.checks.some(c => c.outcome !== "passed")) {
      job.result.state = job.result.compatibility.status === "conflict" ? "fixes_required" : "review_required";
      job.result.phase = "needs_attention";
      job.result.progress = "Compatibility checks need attention. Optional upstream explanations do not block this update.";
      job.findings = job.result.compatibility.checks.filter(c => c.outcome !== "passed").map(c => ({id: `compatibility.${c.id}`, stage: "compatibility", severity: "error",
        reason: c.outcome, title: c.owner, detail: `${c.observed}\nNext: ${c.nextAction}`, evidence: c.evidence}));
      writeDoctorUpdateJob(root, job); return;
    }
    phase("applying_patches", "Applying patches to a disposable candidate and verifying its package…");
    const output = join(packet, "candidate"), signing = findExistingPreparedSigningIdentity();
    const sourceFingerprint = fingerprintVariantGeneration(job.sourcePath);
    // The builder owns all writes under output. It performs patch coverage,
    // backend resolver, ASAR, signature and candidate receipt verification.
    const registrationPath = join(input.brokerRoot, "shared-native-mode.v1.json");
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const retainRegisteredBackend = existsSync(registrationPath) ? {
      installedFingerprint: fingerprintVariantGeneration(DOCTOR_APP), sourceFingerprint,
      installedStateSha256: hash(join(input.variantRoot, "state.json")),
      registrationSha256: hash(registrationPath), backendSha256: hash(join(DOCTOR_APP, "Contents", "Resources", "codex")),
    } : undefined;
    const expectedIdentity = { appTarget: DOCTOR_APP, userRoot: input.variantRoot, appUserDataRoot: join(input.variantRoot, "app-data"),
      codexHomeRoot: join(input.variantRoot, "codex-home"), accountsBrokerRoot: input.brokerRoot };
    const verifyPackage = () => {
      const raw = readDoctorPrivateJson(join(output, "receipt", "TweakersCandidateReceipt.bundle", "Contents", "Resources", "variant-candidate-receipt.json")) as TweakersVariantCandidateReceipt;
      if (!raw || raw.source.path !== job.sourcePath || raw.source.physicalPath !== realpathSync(job.sourcePath!)
        || doctorDigest(raw.source.fingerprint) !== doctorDigest(sourceFingerprint)) throw new Error("Candidate source does not match the reviewed source");
      return verifyTweakersVariantCandidateReceipt(output, { expectedSigningIdentityHash: signing.hash, expectedTransactionId: raw.id,
        expectedPackageRoot: output, expectedObservedPackageRoot: output, expectedSource: raw.source, expectedIdentity });
    };
    const candidateInputFingerprint = doctorDigest({sourceFingerprint, configurationFingerprint, construction: job.implementationScopes!.construction, patchRepairs});
    const retainedCandidateInputs = readDoctorPrivateJson(join(packet, "candidate-inputs.json")) as {fingerprint?: string; candidateReceiptFingerprint?: string} | null;
    let receipt: TweakersVariantCandidateReceipt | null = null;
    if (retainedCandidateInputs?.fingerprint === candidateInputFingerprint && job.candidatePackage === output && job.candidateReceipt && existsSync(output)) {
      try {
        const retained = verifyPackage();
        if (doctorDigest(retained) === doctorDigest(job.candidateReceipt) && doctorDigest(retained) === retainedCandidateInputs.candidateReceiptFingerprint) receipt = retained;
      } catch (error) { throw new Error(`Retained candidate integrity failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!receipt && (job.candidatePackage || existsSync(output) || readdirSync(packet).some(name => name.startsWith("candidate-retained-")))) {
      throw new Error("Retained candidate inputs are unverified or changed. Preserve the candidate and reconcile its scoped construction evidence before retrying; no rebuild was started.");
    }
    if (!receipt) {
      requireSpace(1024 ** 3 + totalTreeBytes(job.sourcePath) * 3, "candidate preparation and rollback");
      // Keep failed or interrupted staging for diagnosis, never overwrite its receipt.
      if (existsSync(output)) renameSync(output, join(packet, `candidate-retained-${randomUUID()}`));
      await createTweakersVariant({ source: job.sourcePath, app: DOCTOR_APP, userRoot: input.variantRoot, candidateOnly: true, output, doctorPatchRepairs: patchRepairs,
        doctorAccountsRecoveryRoot: join(packet, `accounts-recovery-${randomUUID()}`),
        doctorConfiguration: existsSync(join(input.variantRoot, "config.json")) ? JSON.parse(readFileSync(join(input.variantRoot, "config.json"), "utf8")) : undefined,
        ...(retainRegisteredBackend ? { retainRegisteredBackend } : {}) });
      receipt = verifyPackage();
      writeDoctorPrivateJson(join(packet, "candidate-inputs.json"), {version: 1, fingerprint: candidateInputFingerprint, implementationScopes: job.implementationScopes, sourceFingerprint, configurationFingerprint, patchRepairs, candidateReceiptFingerprint: doctorDigest(receipt)});
    }
    assertJobInputs(root, job);
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
      tweakersSourceRoot: join(output, "runtime"), compatibilityOnly: true, patchRepairs, retainedBackendBaseline});
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
    job.result.handoff = `Tweakers Doctor ${job.id}\nNative source: ${job.sourceGenerationId ?? "unverified"}\nRuntime: ${job.runtimeFingerprint}\n${message}\nInspect the owned evidence packet, implement the required compatibility fixes, and rerun Doctor. Do not promote this candidate.`;
    job.result.candidateFingerprint = null;
    job.findings.push({ id: "independent.update.check", stage: candidateFailure ? "candidate" : "compatibility", severity: "warning",
      reason: job.result.phase, title: candidateFailure ? "Candidate construction unavailable" : "Verification is incomplete", detail: message, evidence: [] });
    if (readDoctorUpdateJob(root)?.id === id) writeDoctorUpdateJob(root, job);
  } finally {
    workerLease.release();
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
    // Only consume a request that actually arrived while this job was running.
    // Completion itself never discovers a new release.
    const queuedPath = join(doctorDirectory(root), "queued-update.json");
    const queued = readDoctorPrivateJson(queuedPath) as { schemaVersion?: number; trigger?: "manual" | "available_update"; availableUpdateBuild?: string } | null;
    if (queued?.schemaVersion === 1 && ["manual", "available_update"].includes(queued.trigger ?? "")) {
      unlinkSync(queuedPath);
      startDoctorUpdateScan(root, executable, true, { trigger: queued.trigger, availableUpdateBuild: queued.availableUpdateBuild });
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

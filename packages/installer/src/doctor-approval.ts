import { doctorImplementationScopes, sameDoctorCandidateImplementation, verifyDoctorImplementationAssets } from "./doctor-implementation.js";
import { assertDoctorCompatibility, doctorConfigurationFingerprint, readCompatibilityRecord } from "./doctor-compatibility.js";
import { acquireProcessLock } from "./process-lock.js";
import { assertDoctorAdoptionReady, changeReportFingerprint } from "./doctor-adoption.js";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOCTOR_APP, doctorBundleIdentity, inspectIndependentDoctor, readDoctorIndependentInputs } from "./doctor-independent.js";
import { doctorDigest, doctorDirectory, readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson, type DoctorUpdateJobV1 } from "./doctor-store.js";
import { readRegisteredOfficialSource, readRegisteredOfficialSourceStatusProjection } from "./official-source-registration.js";
import { verifyTweakersVariantCandidateReceipt, type TweakersVariantCandidateReceipt } from "./commands/create-variant.js";
import { canPrepareDoctorCandidate, doctorPatchImplementationFingerprint, doctorValidationReportFingerprint, type DoctorValidationReport } from "./doctor-validation.js";
import type { DoctorChangeReportV1 } from "@therealityreport/tweakers-sdk";
import type { ReviewDoctorSourceChangesResult } from "./doctor-review.js";

/** A completed review phase alone is never approval evidence. */
export function assertDoctorReviewReady(review: ReviewDoctorSourceChangesResult, validation: DoctorValidationReport, currentPatchFingerprint: string): void {
  const coverage = review?.coverage;
  if (review?.state !== "compatible" || !coverage || ![coverage.totalChanges, coverage.totalUnits, coverage.completedUnits, coverage.reusedUnits, coverage.missingEvidenceSides]
    .every(value => Number.isSafeInteger(value) && value >= 0)
    || coverage.completedUnits !== coverage.totalUnits || coverage.reusedUnits > coverage.completedUnits || coverage.missingEvidenceSides !== 0
    || !Array.isArray(review.findings) || review.findings.some(finding => finding.disposition !== "compatible")) {
    throw new Error("Doctor review has incomplete source coverage or unresolved findings");
  }
  const required = ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity"];
  if (!validation || validation.schemaVersion !== 1 || !validation.binding || !Array.isArray(validation.checks)
    || new Set(validation.checks.map(check => check.id)).size !== validation.checks.length
    || validation.checks.some(check => check.state !== "passed") || !required.every(id => validation.checks.some(check => check.id === id))
    || validation.fingerprint !== review.validationFingerprint || doctorValidationReportFingerprint(validation) !== validation.fingerprint
    || validation.binding.tweakersFingerprint !== currentPatchFingerprint) {
    throw new Error("Doctor compatibility checks are missing, incomplete, changed, or from a different Tweakers implementation");
  }
}

export interface DoctorApprovalV1 {
  schemaVersion: 1;
  promotionFingerprint: string;
  operationId: string;
  expiresAt: string;
  reportFingerprint: string;
  jobFingerprint: string;
  jobId: string;
  candidateFingerprint: string;
  adoptionFingerprint: string;
}
export function verifyDoctorCandidate(root: string, job = readDoctorUpdateJob(root), deep = true): { job: DoctorUpdateJobV1; receipt: TweakersVariantCandidateReceipt } {
  return verifyCandidateBinding(root, job, deep, false);
}
/** Verifies a disposable candidate for settings/preview work; never authorizes promotion. */
export function verifyDoctorPreparedCandidate(root: string, job = readDoctorUpdateJob(root)): { job: DoctorUpdateJobV1; receipt: TweakersVariantCandidateReceipt } {
  return verifyCandidateBinding(root, job, true, true);
}
function verifyCandidateBinding(root: string, job: DoctorUpdateJobV1 | null, deep: boolean, preparationOnly: boolean): { job: DoctorUpdateJobV1; receipt: TweakersVariantCandidateReceipt } {
  if (!job || (job.result.state !== "compatible" && !(preparationOnly && job.result.state === "review_required")) || job.result.phase !== "candidate_verified" || !job.candidatePackage
    || !job.candidateReceipt || !job.result.reviewFingerprint || !job.result.candidateFingerprint) throw new Error("Open Tweakers Doctor: a compatible review and verified candidate are required");
  if (deep) verifyDoctorImplementationAssets();
  const input = readDoctorIndependentInputs(root);
  if (input.installedIdentity !== job.installedIdentity || (job.workflowVersion !== 2 && input.nativeIdentity !== job.nativeIdentity) || !sameDoctorCandidateImplementation(job.implementationScopes, doctorImplementationScopes())) throw new Error("Doctor approval inputs changed");
  const registered = deep ? readRegisteredOfficialSource(root) : readRegisteredOfficialSourceStatusProjection(root);
  if (registered.state !== "ready" || registered.generationId !== job.sourceGenerationId || registered.receiptDigest !== job.sourceReceiptDigest
    || registered.artifactPath !== job.sourcePath) throw new Error("Doctor reviewed source changed");
  const expected = job.candidateReceipt as TweakersVariantCandidateReceipt;
  if (resolve(job.candidatePackage) !== join(doctorDirectory(root), "jobs", job.id, "candidate")
    || expected.identity.appTarget !== DOCTOR_APP || expected.identity.userRoot !== input.variantRoot
    || expected.identity.appUserDataRoot !== join(input.variantRoot, "app-data") || expected.identity.codexHomeRoot !== join(input.variantRoot, "codex-home")
    || expected.identity.accountsBrokerRoot !== input.brokerRoot || expected.source.path !== job.sourcePath
    || doctorDigest(expected) !== job.result.candidateFingerprint) throw new Error("Doctor candidate binding is invalid");
  const base = join(doctorDirectory(root), "jobs", job.id);
  const validation = readDoctorPrivateJson(join(base, "review", "validation", "doctor-validation.json")) as DoctorValidationReport | null;
  const compatibility = readCompatibilityRecord(join(base, "compatibility.json"));
  if (!validation || !compatibility || compatibility.fingerprint !== job.result.reviewFingerprint
    || doctorDigest(compatibility) !== doctorDigest(job.result.compatibility)) throw new Error("Run current compatibility checks before installing this historical candidate");
  if (!sameDoctorCandidateImplementation(compatibility.implementationScopes, doctorImplementationScopes())) throw new Error("Candidate implementation scopes require current verification");
  assertDoctorCompatibility(compatibility, validation, doctorConfigurationFingerprint(input.variantRoot), job.result.candidateFingerprint!);
  if (deep) {
    const packet = existsSync(join(base, "evidence")) ? join(base, "evidence") : base;
    const before = readDoctorPrivateJson(join(packet, "before", "doctor-source-evidence.json")) as { fingerprint?: string } | null;
    const after = readDoctorPrivateJson(join(packet, "after", "doctor-source-evidence.json")) as { fingerprint?: string } | null;
    const comparison = readDoctorPrivateJson(join(packet, "comparison.json")) as { fingerprint?: string } | null;
    if (before?.fingerprint !== validation.binding.beforeFingerprint || after?.fingerprint !== validation.binding.afterFingerprint
      || comparison?.fingerprint !== validation.binding.comparisonFingerprint) throw new Error("Compatibility checks refer to different source evidence");
  }
  if (!job.candidateQuickIdentity || doctorBundleIdentity(join(job.candidatePackage, "Tweakers.app")) !== job.candidateQuickIdentity) throw new Error("Doctor candidate app identity changed");
  if (!deep) return { job, receipt: expected };
  const receipt = verifyTweakersVariantCandidateReceipt(job.candidatePackage, { expectedSigningIdentityHash: expected.signingIdentityHash,
    expectedTransactionId: expected.id, expectedPackageRoot: job.candidatePackage, expectedObservedPackageRoot: job.candidatePackage,
    expectedSource: expected.source, expectedIdentity: expected.identity });
  if (doctorDigest(receipt) !== job.result.candidateFingerprint) throw new Error("Doctor candidate changed");
  return { job, receipt };
}
export async function approveDoctorCandidate(root: string, operationId: string, reportFingerprint: string): Promise<DoctorApprovalV1> {
  const lock = acquireProcessLock(join(doctorDirectory(root), "candidate-mutation.lock"));
  try {
  const currentReport = await inspectIndependentDoctor(root);
  if (currentReport.fingerprint !== reportFingerprint || !currentReport.actions.some(action => action.id === "update" && action.enabled)) throw new Error("Doctor findings changed. Refresh before approving installation.");
  const { job } = verifyDoctorCandidate(root);
  const adoption = assertDoctorAdoptionReady(root, job);
  if (currentReport.update.candidateId !== job.id || currentReport.update.candidateFingerprint !== job.result.candidateFingerprint || currentReport.adoption?.fingerprint !== adoption.fingerprint) throw new Error("Doctor candidate or decisions changed during approval");
  const approval: DoctorApprovalV1 = { schemaVersion: 1, promotionFingerprint: doctorImplementationScopes().promotion, operationId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    reportFingerprint, adoptionFingerprint: adoption.fingerprint, jobFingerprint: doctorDigest(job), jobId: job.id, candidateFingerprint: job.result.candidateFingerprint! };
  writeDoctorPrivateJson(join(doctorDirectory(root), "approval.json"), approval);
  return approval;
  } finally { lock.release(); }
}
export function consumeDoctorCandidateApproval(root: string, operationId: string | undefined): { job: DoctorUpdateJobV1; receipt: TweakersVariantCandidateReceipt; adoptionFingerprint: string; promotionFingerprint: string } {
  const path = join(doctorDirectory(root), "approval.json");
  const approval = readDoctorPrivateJson(path) as DoctorApprovalV1 | null;
  if (!operationId || !approval || approval.schemaVersion !== 1 || approval.operationId !== operationId || Date.parse(approval.expiresAt) <= Date.now()
    || !Number.isFinite(Date.parse(approval.expiresAt))) throw new Error("Open Tweakers Doctor and approve the reviewed candidate before refreshing independent Tweakers");
  if (approval.promotionFingerprint !== doctorImplementationScopes().promotion) throw new Error("Doctor promotion implementation changed; approve the verified candidate again");
  const checked = verifyDoctorCandidate(root);
  const adoption = assertDoctorAdoptionReady(root, checked.job);
  if (approval.adoptionFingerprint !== adoption.fingerprint || approval.jobFingerprint !== doctorDigest(checked.job) || approval.jobId !== checked.job.id
    || approval.candidateFingerprint !== checked.job.result.candidateFingerprint) throw new Error("Doctor candidate approval is stale");
  unlinkSync(path);
  return { ...checked, adoptionFingerprint: adoption.fingerprint, promotionFingerprint: approval.promotionFingerprint };
}
export function cancelDoctorCandidateApproval(root: string, operationId: string): void {
  const path = join(doctorDirectory(root), "approval.json");
  if (!existsSync(path)) return;
  const approval = readDoctorPrivateJson(path) as DoctorApprovalV1 | null;
  if (approval?.operationId === operationId) unlinkSync(path);
}

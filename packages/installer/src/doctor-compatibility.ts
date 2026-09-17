import type { DoctorImplementationScopes } from "./doctor-implementation.js";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DoctorCompatibilityV1 } from "@therealityreport/tweakers-sdk";
import { doctorDigest, readDoctorPrivateJson } from "./doctor-store.js";
import { doctorPatchImplementationFingerprint, doctorValidationReportFingerprint, type DoctorValidationReport } from "./doctor-validation.js";

export const DOCTOR_COMPATIBILITY_POLICY = 1;
export const DOCTOR_CORE_CHECKS = ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity",
  "window-services-patch", "inactive-thread-retention-patch", "accounts-native-patch", "candidate-source-bytes", "candidate-accounts-recovery", "candidate-backend-protocol-smoke", "app-server-schema-contracts", "app-server-adapter-contracts"];

/** Includes disabled manifests too: adding/enabling a tweak must invalidate approval. */
export function doctorConfigurationFingerprint(root: string): string {
  const records: Array<[string, string | null]> = [];
  const add = (path: string, name: string) => {
    if (!existsSync(path)) { records.push([name, null]); return; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || realpathSync(path) !== resolve(path)) throw new Error(`Unsafe update configuration: ${name}`);
    records.push([name, createHash("sha256").update(readFileSync(path)).digest("hex")]);
  };
  add(join(root, "config.json"), "config.json");
  const tweaks = join(root, "tweaks");
  if (existsSync(tweaks)) for (const name of readdirSync(tweaks).sort()) {
    const dir = join(tweaks, name);
    if (lstatSync(dir).isSymbolicLink()) throw new Error("Tweak directory must not be a symlink during update verification");
    if (lstatSync(dir).isDirectory()) add(join(dir, "manifest.json"), `tweaks/${name}/manifest.json`);
  }
  return doctorDigest(records);
}
export function compatibilityFingerprint(value: Omit<DoctorCompatibilityV1, "fingerprint"> | DoctorCompatibilityV1): string {
  const { fingerprint: _, ...body } = value as DoctorCompatibilityV1;
  return doctorDigest(body);
}
export function makeDoctorCompatibility(input: {
  validation: DoctorValidationReport; configurationFingerprint: string; requiredChecks: string[];
  implementationScopes?: DoctorImplementationScopes;
  candidateFingerprint: string | null; repairs?: DoctorCompatibilityV1["repairs"];
}): DoctorCompatibilityV1 {
  const { validation } = input;
  if (validation.fingerprint !== doctorValidationReportFingerprint(validation)) throw new Error("Compatibility validation fingerprint changed");
  const checks = input.requiredChecks.map(id => {
    const matches = validation.checks.filter(c => c.id === id);
    const c = matches.length === 1 ? matches[0] : undefined;
    return { id, owner: c?.scope ?? id, outcome: c?.state === "passed" ? "passed" as const : c?.state === "failed" ? "conflict" as const : "verification_unavailable" as const,
      expected: "Required candidate compatibility check passes", observed: c?.summary ?? "Required check is missing or duplicated",
      evidence: c?.artifacts ?? [], nextAction: c?.state === "passed" ? "none" : c?.state === "failed" ? "Inspect the failing patch or interface and rerun its check" : "Provide the missing verification evidence" };
  });
  const body: Omit<DoctorCompatibilityV1, "fingerprint"> = { version: 1, policyVersion: DOCTOR_COMPATIBILITY_POLICY,
    ...(input.implementationScopes ? { implementationScopes: input.implementationScopes } : {}),
    status: checks.some(c => c.outcome === "conflict") ? "conflict" : checks.some(c => c.outcome !== "passed") || !input.candidateFingerprint ? "verification_unavailable" : "passed",
    binding: { ...validation.binding, configurationFingerprint: input.configurationFingerprint, candidateFingerprint: input.candidateFingerprint, validationFingerprint: validation.fingerprint },
    checks, repairs: input.repairs ?? [], postInstallChecks: ["operation-bound-runtime-ready", "accounts-broker-readiness", "variant-identity"] };
  return { ...body, fingerprint: compatibilityFingerprint(body) };
}
export function assertDoctorCompatibility(value: DoctorCompatibilityV1 | undefined, validation: DoctorValidationReport, configurationFingerprint: string, candidateFingerprint: string): void {
  if (!value || value.version !== 1 || value.policyVersion !== DOCTOR_COMPATIBILITY_POLICY || value.status !== "passed"
    || value.fingerprint !== compatibilityFingerprint(value) || !value.checks.length || new Set(value.checks.map(c => c.id)).size !== value.checks.length
    || DOCTOR_CORE_CHECKS.some(id => !value.checks.some(c => c.id === id))
    || validation.checks.some(c => c.id === "model-selection-patch" && !value.checks.some(v => v.id === c.id))
    || validation.retainedBackendBaselineFingerprint && !value.checks.some(c => c.id === "retained-backend-baseline")
    || value.checks.some(c => c.outcome !== "passed") || value.binding.configurationFingerprint !== configurationFingerprint
    || value.binding.candidateFingerprint !== candidateFingerprint || value.binding.validationFingerprint !== validation.fingerprint
    || validation.fingerprint !== doctorValidationReportFingerprint(validation)
    || value.binding.tweakersFingerprint !== doctorPatchImplementationFingerprint()
    || Object.keys(validation.binding).some(key => value.binding[key as keyof DoctorValidationReport["binding"]] !== validation.binding[key as keyof DoctorValidationReport["binding"]])) throw new Error("Candidate compatibility evidence is missing, incomplete, or changed; check the update again");
  for (const c of value.checks) if (validation.checks.filter(v => v.id === c.id).length !== 1 || !validation.checks.some(v => v.id === c.id && v.state === "passed")) throw new Error(`Compatibility check ${c.id} is no longer valid`);
}
export function readCompatibilityRecord(path: string): DoctorCompatibilityV1 | undefined {
  return (readDoctorPrivateJson(path) ?? undefined) as DoctorCompatibilityV1 | undefined;
}

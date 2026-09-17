import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoctorChangeReportV1 } from "@therealityreport/tweakers-sdk";
import { doctorDigest, type DoctorUpdateJobV1 } from "./doctor-store.js";

export const TITLEBAR_CHANGE_ID = "tweakers.titlebar-controls";
const TWEAK_ID = "co.tweakers.titlebar-controls";
export function titlebarOverrideEnabled(id: string): boolean {
  if (id !== `${TWEAK_ID}:enabled` && id !== `${TWEAK_ID}:disabled`) throw new Error("Unsupported override adapter");
  return id.endsWith(":enabled");
}
export function titlebarOverrideFingerprint(job: DoctorUpdateJobV1, id: string): string {
  titlebarOverrideEnabled(id);
  if (!job.candidatePackage || !job.result.candidateFingerprint) throw new Error("Override candidate is unavailable");
  const manifest = JSON.parse(readFileSync(join(job.candidatePackage, "tweaks", "titlebar-controls", "manifest.json"), "utf8"));
  if (manifest.id !== TWEAK_ID || manifest.scope !== "renderer") throw new Error("Titlebar tweak identity changed");
  const entry = readFileSync(join(job.candidatePackage, "tweaks", "titlebar-controls", "index.js"), "utf8");
  return doctorDigest({ adapter: 1, id, manifest, entry, source: job.result.sourceFingerprint, runtime: job.implementationScopes?.construction ?? job.runtimeFingerprint });
}
export function addDoctorTitlebarOptions(report: DoctorChangeReportV1, job: DoctorUpdateJobV1, installedConfigPath: string): void {
  if (!job.candidatePackage) return;
  const after = JSON.parse(readFileSync(join(job.candidatePackage, "config.json"), "utf8")).tweaks?.[TWEAK_ID]?.enabled !== false;
  let before: boolean | null = null;
  try { const v = JSON.parse(readFileSync(installedConfigPath, "utf8")).tweaks?.[TWEAK_ID]?.enabled; if (typeof v === "boolean") before = v; } catch { /* Unknown is visible. */ }
  const overrides = [true, false].map(enabled => { const id = `${TWEAK_ID}:${enabled ? "enabled" : "disabled"}`; return { id, label: `${enabled ? "Enable" : "Disable"} Titlebar Controls`, verificationFingerprint: titlebarOverrideFingerprint(job, id) }; });
  const change = { id: TITLEBAR_CHANGE_ID, area: "Tweakers adaptation", title: "Titlebar Controls setting", before: before === null ? "Installed setting could not be verified." : `Titlebar Controls is ${before ? "enabled" : "disabled"}.`,
    after: `The candidate has Titlebar Controls ${after ? "enabled" : "disabled"}. A selected setting must be checked in the isolated preview before installation.`,
    status: "inferred_from_code" as const, technicalOnly: false, evidence: [{ artifact: "Tweakers configuration", path: "config.json", beforeSha256: null, afterSha256: null, kind: "static" as const, detail: "Signed candidate configuration and bundled tweak identity; not native interaction evidence." }], dependencies: [], compatibility: [], overrides };
  report.changes = [...report.changes.filter(c => c.id !== TITLEBAR_CHANGE_ID), change];
}
export function verifyDoctorTitlebarSelection(job: DoctorUpdateJobV1, overrideId: string, verificationFingerprint: string): void {
  if (titlebarOverrideFingerprint(job, overrideId) !== verificationFingerprint) throw new Error("Override compatibility evidence changed");
  const config = JSON.parse(readFileSync(join(job.candidatePackage!, "config.json"), "utf8"));
  if (config.tweaks?.[TWEAK_ID]?.enabled !== titlebarOverrideEnabled(overrideId)) throw new Error("Selected titlebar setting is not applied to the candidate");
}

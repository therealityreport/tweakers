import type { DoctorChangeReportV1, DoctorChangelogEntryV1 } from "@therealityreport/tweakers-sdk";
import { doctorDigest } from "./doctor-store.js";

export const CHANGELOG_CATEGORIES = ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"] as const;
export function changelogEntryId(entry: Omit<DoctorChangelogEntryV1, "id">): string {
  return `changelog:${doctorDigest(entry).replace("sha256:", "")}`;
}
export function validateDoctorChangelog(report: DoctorChangeReportV1): void {
  const log = report.changelog;
  if (!log) return; // Legacy is readable; adoption enforces the incomplete migration.
  if (log.schemaVersion !== 1 || !Array.isArray(log.entries) || !Array.isArray(log.unresolved)) throw new Error("Invalid changelog contract");
  const groups = new Map(report.changes.map(c => [c.id, c]));
  const ids = new Set<string>();
  for (const entry of log.entries) {
    const { id, ...body } = entry;
    if (id !== changelogEntryId(body) || ids.has(id) || !CHANGELOG_CATEGORIES.includes(entry.category)
      || ![entry.title, entry.workflow, entry.before, entry.after].every(s => typeof s === "string" && s.trim().length > 0)
      || entry.before === entry.after || !["upstream", "tweakers"].includes(entry.origin)
      || !["inferred_from_code", "observed", "documented_upstream"].includes(entry.status)
      || !Array.isArray(entry.analysisGroupIds) || !entry.analysisGroupIds.length || entry.analysisGroupIds.some(id => !groups.has(id))
      || !Array.isArray(entry.dependencies) || entry.dependencies.some(id => !groups.has(id))
      || entry.decisionDependencies !== undefined && (!Array.isArray(entry.decisionDependencies) || entry.decisionDependencies.some(id => !groups.has(id)))
      || !Array.isArray(entry.limitations) || entry.limitations.some(x => typeof x !== "string")
      || !Array.isArray(entry.evidenceReferences) || !entry.evidenceReferences.length) throw new Error("Invalid behavioral changelog entry");
    for (const ref of entry.evidenceReferences) {
      const matches = entry.analysisGroupIds.flatMap(groupId => groups.get(groupId)!.evidence.map((evidence, index) => ({id: `${groupId}:evidence:${index}`, evidence})));
      const match = matches.find(m => m.id === ref.id && doctorDigest(m.evidence) === ref.sha256);
      if (!match || (entry.status === "observed" && match.evidence.kind !== "native_interaction")
        || (entry.status === "documented_upstream" && match.evidence.kind !== "upstream_documentation")) throw new Error("Changelog claim lacks bound evidence of its stated kind");
    }
    ids.add(id);
  }
  if (log.unresolved.some(g => !groups.has(g.groupId) || typeof g.reason !== "string" || !g.reason.trim())) throw new Error("Invalid unresolved changelog finding");
}
/** One decision covers shared evidence groups and explicitly inseparable choices.
 * Interfaces must disclose this scope, including sibling entries, before sending it. */
export function changelogDecisionGroups(report: DoctorChangeReportV1, id: string): string[] {
  const entry = report.changelog?.entries.find(e => e.id === id);
  if (!entry && !report.changes.some(c => c.id === id)) return [];
  const ids = new Set(entry ? [...entry.analysisGroupIds, ...(entry.decisionDependencies ?? [])] : [id]);
  let changed = true;
  while (changed) {
    const size = ids.size;
    for (const sibling of report.changelog?.entries ?? []) {
      if ([...sibling.analysisGroupIds, ...(sibling.decisionDependencies ?? [])].some(id => ids.has(id))) {
        for (const id of [...sibling.analysisGroupIds, ...(sibling.decisionDependencies ?? [])]) ids.add(id);
      }
    }
    changed = size !== ids.size;
  }
  return [...ids].sort();
}

import { validateDoctorChangelog, changelogDecisionGroups } from "./doctor-changelog.js";
import { TITLEBAR_CHANGE_ID, verifyDoctorTitlebarSelection } from "./doctor-overrides.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorActionRequestV1, DoctorAdoptionReviewV1, DoctorChangeReportV1 } from "@therealityreport/tweakers-sdk";
import { acquireProcessLock } from "./process-lock.js";
import { doctorDigest, doctorDirectory, readDoctorPrivateJson, readDoctorUpdateJob, writeDoctorPrivateJson, type DoctorUpdateJobV1 } from "./doctor-store.js";

const hash = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
export function changeReportFingerprint(report: DoctorChangeReportV1): string {
  const { fingerprint: _, reviewProgress: _progress, ...body } = report;
  return doctorDigest(body);
}
function packet(root: string, job: DoctorUpdateJobV1): string { return join(doctorDirectory(root), "jobs", job.id); }
export function saveDoctorChangeReport(root: string, job: DoctorUpdateJobV1, report: DoctorChangeReportV1): void {
  const lock = acquireProcessLock(join(doctorDirectory(root), "adoption.lock"));
  try { saveChangeReportLocked(root, job, report); } finally { lock.release(); }
}
function saveChangeReportLocked(root: string, job: DoctorUpdateJobV1, report: DoctorChangeReportV1): void {
  const path = join(packet(root, job), "changes.json");
  const old = readDoctorPrivateJson(path, { maxBytes: 128 * 1024 * 1024 }) as DoctorChangeReportV1 | null;
  let prior = old;
  let priorPacket = packet(root, job);
  let predecessor = job.predecessorId;
  const visited = new Set([job.id]);
  while (!prior && predecessor) {
    if (!/^[a-f0-9-]{36}$/.test(predecessor) || visited.has(predecessor) || visited.size > 128) throw new Error("Update predecessor history is invalid; preserve existing adoption intent");
    visited.add(predecessor);
    priorPacket = join(doctorDirectory(root), "jobs", predecessor);
    // Most historical technical reports have no adoption intent. Do not load
    // their potentially huge inventories merely to discover that fact.
    const intent = readDoctorPrivateJson(join(priorPacket, "decisions.json")) as SavedDecisions | null;
    if (intent) {
      prior = readDoctorPrivateJson(join(priorPacket, "changes.json"), { maxBytes: 128 * 1024 * 1024 }) as DoctorChangeReportV1 | null;
      if (!prior) throw new Error("Historical adoption intent has missing report evidence; restore it before continuing");
    }
    if (!prior) {
      const ancestor = readDoctorPrivateJson(join(priorPacket, "job.json")) as DoctorUpdateJobV1 | null;
      if (!ancestor || ancestor.id !== predecessor) throw new Error("Update predecessor evidence is missing; restore it before continuing");
      predecessor = ancestor.predecessorId;
    }
  }
  const previous = prior ? readDoctorPrivateJson(join(priorPacket, "decisions.json")) as SavedDecisions | null : null;
  let inherited: SavedDecisions | null = null;
  if (prior && previous && prior.fingerprint === changeReportFingerprint(prior)
    && prior.beforeFingerprint === report.beforeFingerprint && prior.afterFingerprint === report.afterFingerprint
    && previous.beforeFingerprint === report.beforeFingerprint && previous.afterFingerprint === report.afterFingerprint) {
    const preserved = previous.decisions.filter(d => d.choice === "preserve" || d.choice === "override");
    // A regrouped change cannot silently erase a refusal. Keep its original evidence as a separate review item.
    for (const d of preserved) {
      if (!report.changes.some(c => c.id === d.changeId)) {
        const original = prior.changes.find(c => c.id === d.changeId);
        if (!original) throw new Error("Preservation request has lost its evidence");
        report.changes.push({ ...original, title: `Preservation request: ${original.title}`, status: "unknown", technicalOnly: false, dependencies: [], overrides: [] });
      }
    }
    const unchangedDecisions = previous.decisions.filter(d => {
      if (d.choice === "preserve" || d.choice === "override" || previous.reportFingerprint !== prior!.fingerprint) return false;
      if (prior!.candidateFingerprint !== report.candidateFingerprint || prior!.implementationFingerprint !== report.implementationFingerprint) return false;
      const before = prior!.changes.find(c => c.id === d.changeId), after = report.changes.find(c => c.id === d.changeId);
      if (!before || !after || doctorDigest(before) !== doctorDigest(after)) return false;
      const coupled = (value: DoctorChangeReportV1) => {
        const ids = new Set([d.changeId]);
        let expanded = true;
        while (expanded) { expanded = false; for (const item of value.changes) {
          if (ids.has(item.id) || item.dependencies.some(id => ids.has(id))) {
            for (const id of [item.id, ...item.dependencies]) if (!ids.has(id)) { ids.add(id); expanded = true; }
          }
        } }
        return { changes: value.changes.filter(item => ids.has(item.id)).sort((a, b) => a.id.localeCompare(b.id)),
          unresolved: (value.changelog?.unresolved ?? []).filter(item => ids.has(item.groupId)).sort((a, b) => a.groupId.localeCompare(b.groupId)) };
      };
      if (doctorDigest(coupled(prior!)) !== doctorDigest(coupled(report))) return false;
      return doctorDigest(prior!.changelog?.entries.filter(e => e.analysisGroupIds.includes(d.changeId)) ?? [])
        === doctorDigest(report.changelog?.entries.filter(e => e.analysisGroupIds.includes(d.changeId)) ?? []);
    });
    inherited = { schemaVersion: 1, reportFingerprint: "", beforeFingerprint: report.beforeFingerprint, afterFingerprint: report.afterFingerprint,
      deferred: previous.deferred, decisions: [...preserved, ...unchangedDecisions], observations: previous.observations.filter(o => unchangedDecisions.some(d => d.changeId === o.changeId)) };
  }
  report.fingerprint = changeReportFingerprint(report);
  validateChangeReport(report, job);
  if (old && old.fingerprint !== report.fingerprint) writeDoctorPrivateJson(join(packet(root, job), "change-history", `${old.fingerprint.replace("sha256:", "")}.json`), old);
  if (inherited && previous?.reportFingerprint !== report.fingerprint) {
    inherited.reportFingerprint = report.fingerprint;
    writeDoctorPrivateJson(join(packet(root, job), "decisions.json"), inherited);
  }
  // Publish the report only after inherited refusals are durable. An interrupted
  // write must never expose a successor without its preservation/defer intent.
  writeDoctorPrivateJson(path, report);
}
function validateChangeReport(report: DoctorChangeReportV1, job: DoctorUpdateJobV1): void {
  if (!report || report.schemaVersion !== 1 || report.jobId !== job.id || !hash(report.fingerprint)
    || report.fingerprint !== changeReportFingerprint(report) || !hash(report.beforeFingerprint) || !hash(report.afterFingerprint)
    || !hash(report.comparisonFingerprint)
    || !(hash(report.implementationFingerprint) || /^[a-f0-9]{64}$/.test(report.implementationFingerprint))
    || !Array.isArray(report.changes) || !Array.isArray(report.limitations) || !report.coverage
    || ![report.coverage.total, report.coverage.classified, report.coverage.unresolved].every(n => Number.isSafeInteger(n) && n >= 0)
    || report.coverage.classified + report.coverage.unresolved !== report.coverage.total) throw new Error("Update change report is invalid or changed");
  if (report.changelog) validateDoctorChangelog(report);
  const ids = new Set(report.changes.map(c => c.id));
  if (ids.size !== report.changes.length) throw new Error("Duplicate update change IDs");
  for (const c of report.changes) {
    if (!c.id || !["observed", "inferred_from_code", "documented_upstream", "unknown"].includes(c.status)
      || !Array.isArray(c.dependencies) || c.dependencies.some(id => !ids.has(id)) || !Array.isArray(c.overrides)
      || !Array.isArray(c.evidence) || !Array.isArray(c.compatibility) || typeof c.technicalOnly !== "boolean"
      || ![c.title, c.before, c.after, c.area].every(v => typeof v === "string")) throw new Error("Update change entry is invalid");
  }
}
interface SavedDecisions {
  schemaVersion: 1;
  reportFingerprint: string;
  deferred: boolean;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  decisions: DoctorAdoptionReviewV1["decisions"];
  observations: DoctorAdoptionReviewV1["observations"];
}
function readSaved(root: string, job: DoctorUpdateJobV1, report: DoctorChangeReportV1): SavedDecisions {
  const raw = readDoctorPrivateJson(join(packet(root, job), "decisions.json")) as SavedDecisions | null;
  if (!raw || raw.reportFingerprint !== report.fingerprint) {
    // Acceptance is candidate-specific; a deliberate refusal remains attached to the upstream pair.
    const samePair = raw?.beforeFingerprint === report.beforeFingerprint && raw?.afterFingerprint === report.afterFingerprint;
    return { schemaVersion: 1, reportFingerprint: report.fingerprint, beforeFingerprint: report.beforeFingerprint, afterFingerprint: report.afterFingerprint,
      deferred: samePair ? raw.deferred === true : false,
      decisions: samePair && Array.isArray(raw.decisions) ? raw.decisions.filter(d => (d.choice === "preserve" || d.choice === "override") && report.changes.some(c => c.id === d.changeId)) : [], observations: [] };
  }
  if (raw.schemaVersion !== 1 || typeof raw.deferred !== "boolean" || !Array.isArray(raw.decisions) || !Array.isArray(raw.observations)
    || new Set(raw.decisions.map(d => d.changeId)).size !== raw.decisions.length
    || raw.decisions.some(d => !report.changes.some(c => c.id === d.changeId) || !["accept", "acknowledge_unknown", "preserve", "override"].includes(d.choice))) throw new Error("Saved adoption decisions are invalid");
  return raw;
}
export function readDoctorAdoption(root: string, job = readDoctorUpdateJob(root)): DoctorAdoptionReviewV1 | null {
  if (!job) return null;
  const report = readDoctorPrivateJson(join(packet(root, job), "changes.json"), {maxBytes: 128 * 1024 * 1024}) as DoctorChangeReportV1 | null;
  if (!report) return null;
  validateChangeReport(report, job);
  const saved = readSaved(root, job, report);
  const blockers: string[] = [];
  const compatibilityWorkflow = job.compatibilityPolicyVersion === 1 || job.result.compatibility?.version === 1;
  if (!compatibilityWorkflow && !report.changelog) blockers.push("This historical report needs a behavioral changelog review before installation.");
  for (const gap of compatibilityWorkflow ? [] : report.changelog?.unresolved ?? []) {
    const group = report.changes.find(c => c.id === gap.groupId)!;
    const decision = saved.decisions.find(d => d.changeId === gap.groupId);
    if (!(group.unknownPolicy === "acknowledgment" && decision?.choice === "acknowledge_unknown")) blockers.push(`Unresolved change: ${gap.reason}`);
  }
  for (const change of report.changes) {
    const decision = saved.decisions.find(d => d.changeId === change.id);
    if (!compatibilityWorkflow && change.status === "unknown" && (change.unknownPolicy !== "acknowledgment" || decision?.choice !== "acknowledge_unknown")) blockers.push(`${change.title}: unknown behavior requires ${change.unknownPolicy === "acknowledgment" ? "explicit acknowledgment" : "required evidence"}.`);
    if (decision?.choice === "preserve") blockers.push(`${change.title}: preservation patch requested and not implemented.`);
    else if (decision?.choice === "override") {
      // No arbitrary setting writes or candidate mutation. Only registered, proven adapters can be enabled.
      try {
        const adapter = change.overrides.find(o => o.id === decision.overrideId);
        if (change.id !== TITLEBAR_CHANGE_ID || !adapter || !decision.overrideId) throw new Error("No verified adapter");
        verifyDoctorTitlebarSelection(job, decision.overrideId, adapter.verificationFingerprint);
        if (!saved.observations.some(o => o.changeId === change.id && o.outcome === "matches")) blockers.push(`${change.title}: verify the selected setting in the isolated preview and record its interaction outcome.`);
      } catch { blockers.push(`${change.title}: selected override lacks current candidate verification.`); }
    } else if (!compatibilityWorkflow && !decision && (!change.technicalOnly || change.status === "unknown")) blockers.push(`${change.title}: awaiting your decision${change.status === "unknown" ? " on unknown behavior" : ""}.`);
  }
  if (!report.candidateFingerprint || report.candidateFingerprint !== job.result.candidateFingerprint) blockers.push("The report is not bound to a verified candidate yet.");
  if (saved.deferred) blockers.unshift("You deferred this update.");
  const state = job.supersededBy ? "superseded" : saved.deferred ? "deferred" : saved.decisions.some(d => d.choice === "preserve") ? "preservation_required" : blockers.length ? "review_required" : "ready";
  const result: DoctorAdoptionReviewV1 = { schemaVersion: 1, state, report, decisions: saved.decisions, observations: saved.observations, blockers, fingerprint: "" };
  result.fingerprint = doctorDigest({ ...result, fingerprint: undefined });
  return result;
}
export function assertDoctorAdoptionReady(root: string, job: DoctorUpdateJobV1): DoctorAdoptionReviewV1 {
  const review = readDoctorAdoption(root, job);
  if (!review || review.state !== "ready") throw new Error("Review Update Changes and resolve adoption decisions before installing");
  const base = packet(root, job);
  const comparison = readDoctorPrivateJson(join(existsSync(join(base, "evidence")) ? join(base, "evidence") : base, "comparison.json")) as { fingerprint?: string; beforeFingerprint?: string; afterFingerprint?: string } | null;
  if (comparison?.fingerprint !== review.report.comparisonFingerprint || comparison.beforeFingerprint !== review.report.beforeFingerprint
    || comparison.afterFingerprint !== review.report.afterFingerprint || review.report.implementationFingerprint !== (job.implementationScopes?.construction ?? job.runtimeFingerprint)) throw new Error("Adoption report source binding changed");
  return review;
}
export function applyDoctorAdoptionAction(root: string, request: DoctorActionRequestV1): void {
  const lock = acquireProcessLock(join(doctorDirectory(root), "adoption.lock"));
  try {
    const job = readDoctorUpdateJob(root), review = readDoctorAdoption(root, job);
    if (!job || !review || job.supersededBy) throw new Error("No current update change report");
    const payload = request.action === "decide" ? request.decision : request.observation;
    if (!payload || payload.reportFingerprint !== review.report.fingerprint) throw new Error("Update change report changed. Refresh before deciding.");
    const saved = readSaved(root, job, review.report);
    if (request.action === "observe" && request.observation) {
      const o = request.observation;
      if (!review.report.changes.some(c => c.id === o.changeId)) throw new Error("Unknown update change");
      saved.observations = [...saved.observations.filter(x => x.changeId !== o.changeId), { changeId: o.changeId, before: o.before, after: o.after, conditions: o.conditions, outcome: o.outcome, recordedAt: new Date().toISOString(), source: "user_manual" }];
      // Manual testimony stays distinct from machine-verified native evidence; invalidate that change's decision.
      saved.decisions = saved.decisions.filter(d => d.changeId !== o.changeId || d.choice === "preserve" || d.choice === "override");
    } else if (request.decision) {
      const d = request.decision;
      if (d.choice === "extend_budget") throw new Error("Allowance changes must use the manager action interface");
      if (d.choice === "defer" || d.choice === "resume") saved.deferred = d.choice === "defer";
      else {
        const acknowledged = (id: string) => review.report.changes.find(c => c.id === id)?.unknownPolicy === "acknowledgment"
          && saved.decisions.some(d => d.changeId === id && d.choice === "acknowledge_unknown");
        const targetIds = d.choice === "accept_explained"
          ? [...new Set((review.report.changelog?.entries ?? []).map(e => changelogDecisionGroups(review.report, e.id))
            .filter(ids => ids.every(id => review.report.changes.find(c => c.id === id)?.status !== "unknown" || acknowledged(id))).flat())]
            .filter(id => !saved.decisions.some(d => d.changeId === id))
          : changelogDecisionGroups(review.report, d.changeId ?? "");
        const selected = review.report.changes.filter(c => targetIds.includes(c.id));
        if (!selected.length && d.choice !== "accept_explained") throw new Error("Unknown update change");
        if (d.choice === "acknowledge_unknown" && !selected.some(c => c.status === "unknown")) throw new Error("Required evidence gaps cannot be acknowledged away");
        for (const c of selected) {
          if ((d.choice === "accept" || d.choice === "accept_explained") && c.status === "unknown") {
            if (!acknowledged(c.id)) throw new Error("Unknown behavior requires explicit acknowledgment, not acceptance");
            continue; // Keep the explicit acknowledgment; never turn it into acceptance.
          }
          if (d.choice === "acknowledge_unknown") {
            if (c.status !== "unknown") continue; // Acknowledging an unknown is not acceptance of its explained siblings.
            if (c.unknownPolicy !== "acknowledgment") throw new Error("Required evidence gaps cannot be acknowledged away");
          }
          if (d.choice === "override") {
            const adapter = c.overrides.find(o => o.id === d.overrideId);
            if (c.id !== TITLEBAR_CHANGE_ID || !adapter || !d.overrideId) throw new Error("No candidate-verified override adapter is available");
            verifyDoctorTitlebarSelection(job, d.overrideId, adapter.verificationFingerprint);
          }
          saved.decisions = [...saved.decisions.filter(x => x.changeId !== c.id), { changeId: c.id, choice: d.choice === "override" ? "override" : d.choice === "preserve" ? "preserve" : d.choice === "acknowledge_unknown" ? "acknowledge_unknown" : "accept", ...(d.choice === "override" ? { overrideId: d.overrideId } : {}) }];
        }
      }
    } else throw new Error("Missing adoption decision");
    if (readDoctorUpdateJob(root)?.id !== job.id || readDoctorAdoption(root, job)?.report.fingerprint !== payload.reportFingerprint) throw new Error("Update changed during decision");
    const revision = doctorDigest(saved).replace("sha256:", "");
    writeDoctorPrivateJson(join(packet(root, job), "decision-history", `${revision}.json`), saved);
    writeDoctorPrivateJson(join(packet(root, job), "decisions.json"), saved);
  } finally { lock.release(); }
}

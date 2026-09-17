import { changelogEntryId, validateDoctorChangelog } from "./doctor-changelog.js";
import { changeReportFingerprint } from "./doctor-adoption.js";
import asar from "@electron/asar";
import type { DoctorChangeReportV1, DoctorChangeV1, DoctorChangelogEntryV1, DoctorReviewWorkV1 } from "@therealityreport/tweakers-sdk";
import { parse } from "acorn";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type {
  DoctorSourceChange,
  DoctorSourceComparison,
  DoctorSourceEvidence,
  DoctorSourceRename,
  DoctorSourceSha256,
} from "./doctor-evidence.js";
import { doctorDigest, readDoctorPrivateJson, writeDoctorPrivateJson } from "./doctor-store.js";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_AST_SOURCE_BYTES = 32 * 1024 * 1024;
const ANALYSIS_BATCH_ENTRIES = 16;
const MAX_BATCH_SOURCE_BYTES = MAX_SOURCE_BYTES * ANALYSIS_BATCH_ENTRIES * 2;
const MAX_AST_NODES = 2_000_000;
export const DOCTOR_ANALYSIS_IMPLEMENTATION_VERSION = 6;
const ANALYSIS_VERSION = DOCTOR_ANALYSIS_IMPLEMENTATION_VERSION;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const JAVASCRIPT = /\.(?:[cm]?js|jsx)$/i;

export interface BuildDoctorChangeReportInput {
  before: DoctorSourceEvidence;
  after: DoctorSourceEvidence;
  comparison: DoctorSourceComparison;
  jobId: string;
  implementationFingerprint: string;
  checkpointDirectory?: string;
}

export interface RefreshDoctorChangeReportClassificationsInput {
  report: DoctorChangeReportV1;
  before: DoctorSourceEvidence;
  after: DoctorSourceEvidence;
  comparison: DoctorSourceComparison;
  checkpointDirectory?: string;
}

interface CodeIndex {
  messages: string[];
  imports: string[];
  identifiers: string[];
  importBindings: string[];
  exports: string[];
  routes: string[];
  calls: string[];
  labels: string[];
  handlers: string[];
  renderConditions: string[];
  settings: string[];
  styles: string[];
  backendCalls: string[];
}

interface ReadResult {
  bytes: Buffer | null;
  problem: string | null;
}

interface ReadBudget {
  bytes: number;
  limit: number;
}

interface IndexResult {
  index: CodeIndex | null;
  units: CodeUnit[];
  problem: string | null;
}

interface SourceRange {
  offset: number;
  bytes: number;
}

interface CodeUnit {
  identity: string;
  kind: string;
  ordinal: number;
  range: SourceRange;
  sha256: DoctorSourceSha256;
  index: CodeIndex;
}

interface AnalyzedEntry {
  key: string;
  artifact: DoctorSourceChange["artifact"];
  area: string;
  relevance: "relevant" | "irrelevant" | "unresolved";
  beforePath: string | null;
  afterPath: string | null;
  beforeSha256: DoctorSourceSha256 | null;
  afterSha256: DoctorSourceSha256 | null;
  change: DoctorSourceChange["change"] | "renamed" | "structural_rename";
  semanticEquivalent: boolean;
  reason: string;
  requiredChecks: string[];
  beforeIndex: CodeIndex | null;
  afterIndex: CodeIndex | null;
  beforeUnits: CodeUnit[];
  afterUnits: CodeUnit[];
  beforeRange: SourceRange | null;
  afterRange: SourceRange | null;
  beforeFocus: SourceRange | null;
  afterFocus: SourceRange | null;
  beforeSourceBytes: number | null;
  afterSourceBytes: number | null;
  coverageCount: number;
  coverageKey: string;
  binaryEvidence: boolean;
  readProblems: string[];
}

interface ChangeGroup {
  key: string;
  entries: AnalyzedEntry[];
  area: string;
  route: string | null;
  subject: string;
  id: string;
}

interface ReviewDescriptor {
  work: DoctorReviewWorkV1;
  groupingKey: string;
}

/**
 * Builds a deterministic, evidence-only description of a Doctor source
 * comparison. Adoption decisions and native observations are intentionally
 * outside this function.
 */
export async function buildDoctorChangeReport({
  before,
  after,
  comparison,
  jobId,
  implementationFingerprint,
  checkpointDirectory,
}: BuildDoctorChangeReportInput): Promise<DoctorChangeReportV1> {
  const limitations = new Set<string>([
    "No exact GitHub revision or release mapping was proven from the supplied bundle evidence.",
    "No native application behavior was observed; this report describes extracted artifact and code evidence only.",
    "Tweakers adaptation and compatibility remain separate from upstream changes and require independent verification.",
  ]);
  const inputsBound = comparison.beforeFingerprint === before.fingerprint
    && comparison.afterFingerprint === after.fingerprint
    && SHA256.test(before.fingerprint)
    && SHA256.test(after.fingerprint)
    && SHA256.test(comparison.fingerprint);
  if (!inputsBound) limitations.add("The comparison fingerprints do not bind the supplied before and after evidence; all entries remain unresolved.");
  for (const problem of comparison.unresolvedEvidence) limitations.add(`Comparison evidence is incomplete: ${problem}`);

  const work = [
    ...comparison.changes.map((change) => ({ key: sourceChangeKey(change), priority: analysisWorkPriority(change.relevance, change.area),
      analyze: (budget: ReadBudget) => analyzeChange(change, before, after, budget, inputsBound) })),
    ...comparison.renamedIdenticalArtifacts.map((rename) => ({ key: sourceRenameKey(rename), priority: analysisWorkPriority(rename.relevance, rename.area),
      analyze: (budget: ReadBudget) => analyzeRename(rename, before, after, budget, inputsBound) })),
  ].sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
  const rawEntries: AnalyzedEntry[] = [];
  for (let start = 0; start < work.length; start += ANALYSIS_BATCH_ENTRIES) {
    const items = work.slice(start, start + ANALYSIS_BATCH_ENTRIES);
    const checkpointKey = doctorDigest({ analysisVersion: ANALYSIS_VERSION, beforeFingerprint: before.fingerprint,
      afterFingerprint: after.fingerprint, comparisonFingerprint: comparison.fingerprint, entries: items.map((item) => item.key) });
    const cached = checkpointDirectory ? readAnalysisCheckpoint(checkpointDirectory, checkpointKey) : null;
    if (cached) { rawEntries.push(...cached); continue; }
    const budget: ReadBudget = { bytes: 0, limit: MAX_BATCH_SOURCE_BYTES };
    const analyzed = items.map((item) => item.analyze(budget));
    rawEntries.push(...analyzed);
    if (checkpointDirectory && analyzed.every((entry) => entry.readProblems.length === 0)) {
      writeAnalysisCheckpoint(checkpointDirectory, checkpointKey, analyzed);
    }
  }
  const entries = pairStructuralRenames(rawEntries).flatMap(splitAnalysisUnits);
  for (const entry of entries) {
    for (const problem of entry.readProblems) limitations.add(`Source evidence unavailable for ${displayPath(entry)}: ${problem}`);
  }

  const groups = groupEntries(entries);
  const pathOwners = changedPathOwners(groups);
  const changes = groups.map((group) => buildChange(group, pathOwners));
  const wording = deterministicWordingChanges(groups, changes);
  const classified = classifiedInputCount(entries);
  const total = comparison.changes.length + comparison.renamedIdenticalArtifacts.length;
  const payload: Omit<DoctorChangeReportV1, "fingerprint"> = {
    schemaVersion: 1,
    analysisVersion: 2,
    analysisImplementationVersion: ANALYSIS_VERSION,
    jobId,
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    comparisonFingerprint: comparison.fingerprint,
    implementationFingerprint,
    candidateFingerprint: null,
    changes,
    sourceVersions: { before: {version: before.version, build: before.build}, after: {version: after.version, build: after.build} },
    changelog: { schemaVersion: 1, entries: wording, unresolved: changes.filter(c => c.reviewWork?.kind !== "internal").map(c => ({ groupId: c.id, reason: c.reviewWork?.question ?? "Behavior-level explanation has not been completed." })) },
    coverage: { total, classified: Math.min(total, classified), unresolved: Math.max(0, total - classified) },
    limitations: [...limitations].sort(),
  };
  return { ...payload, fingerprint: doctorDigest(payload) };
}

/**
 * Refresh deterministic grouping and dispositions without invalidating raw
 * version-6 analysis checkpoints. Model work is retained only for unchanged,
 * evidence-identical group IDs; report-bound overrides are intentionally not
 * copied across the refreshed fingerprint.
 */
export async function refreshDoctorChangeReportClassifications({
  report,
  before,
  after,
  comparison,
  checkpointDirectory,
}: RefreshDoctorChangeReportClassificationsInput): Promise<DoctorChangeReportV1> {
  if (report.fingerprint !== changeReportFingerprint(report) || report.schemaVersion !== 1 || report.analysisVersion !== 2
    || report.analysisImplementationVersion !== ANALYSIS_VERSION || report.candidateFingerprint !== null
    || report.beforeFingerprint !== before.fingerprint || report.afterFingerprint !== after.fingerprint
    || report.comparisonFingerprint !== comparison.fingerprint
    || comparison.beforeFingerprint !== before.fingerprint || comparison.afterFingerprint !== after.fingerprint) {
    throw new Error("The retained change report is not exactly bound to the supplied version-6 evidence and comparison.");
  }
  const refreshed = await buildDoctorChangeReport({ before, after, comparison, jobId: report.jobId,
    implementationFingerprint: report.implementationFingerprint, checkpointDirectory });
  const retainedById = new Map(report.changes.map(change => [change.id, change]));
  const preservedIds = new Set<string>();
  const preservedDispositionIds = new Set<string>();
  for (const change of refreshed.changes) {
    const retained = retainedById.get(change.id);
    if (!retained || doctorDigest(retained.evidence) !== doctorDigest(change.evidence)) continue;
    preservedIds.add(change.id);
    if (retained.explanation) change.explanation = retained.explanation;
    const retainedDisposition = doctorDigest({ reviewWork: retained.reviewWork, status: retained.status,
      technicalOnly: retained.technicalOnly });
    const refreshedDisposition = doctorDigest({ reviewWork: change.reviewWork, status: change.status,
      technicalOnly: change.technicalOnly });
    if (retainedDisposition !== refreshedDisposition) continue;
    preservedDispositionIds.add(change.id);
    if (retained.unknownPolicy) change.unknownPolicy = retained.unknownPolicy;
  }
  const retainedModelEntries = report.changelog?.entries.filter(entry => entry.method === "model"
    && entry.analysisGroupIds.every(id => preservedIds.has(id))
    && entry.dependencies.every(id => retainedById.has(id) && refreshed.changes.some(change => change.id === id))
    && (entry.decisionDependencies ?? []).every(id => retainedById.has(id) && refreshed.changes.some(change => change.id === id))) ?? [];
  refreshed.changelog!.entries = [...new Map([...refreshed.changelog!.entries, ...retainedModelEntries]
    .map(entry => [entry.id, entry])).values()];
  const retainedReasons = new Map((report.changelog?.unresolved ?? []).filter(item => preservedDispositionIds.has(item.groupId))
    .map(item => [item.groupId, item.reason]));
  refreshed.changelog!.unresolved = refreshed.changelog!.unresolved.map(item => ({ ...item,
    reason: retainedReasons.get(item.groupId) ?? item.reason }));
  refreshed.reviewProgress = report.reviewProgress;
  refreshed.fingerprint = changeReportFingerprint(refreshed) as DoctorSourceSha256;
  validateDoctorChangelog(refreshed);
  return refreshed;
}

function deterministicWordingChanges(groups: ChangeGroup[], changes: DoctorChangeV1[]): DoctorChangelogEntryV1[] {
  const result: DoctorChangelogEntryV1[] = [], seen = new Set<string>();
  const changesById = new Map(changes.map((change) => [change.id, change]));
  for (const group of groups) {
    const change = changesById.get(group.id)!;
    for (const source of group.entries) {
      if (source.readProblems.length || !source.beforeIndex || !source.afterIndex || source.beforeSha256 === source.afterSha256) continue;
      const left = new Map<string,string>(source.beforeIndex.messages.map(x => JSON.parse(x)));
      const right = new Map<string,string>(source.afterIndex.messages.map(x => JSON.parse(x)));
      for (const [key, before] of left) {
        const after = right.get(key);
        if (!after || before === after) continue;
        const identity = JSON.stringify([key,before,after]);
        if (seen.has(identity)) continue;
        const evidence = entryEvidence(source)[0]!;
        const index = change.evidence.findIndex(e => doctorDigest(e) === doctorDigest(evidence));
        if (index < 0) continue;
        const body: Omit<DoctorChangelogEntryV1,"id"> = {
          method: "deterministic_text", category: "Changed", title: `Wording: “${before}” → “${after}”`,
          workflow: group.route ? `Screen ${group.route}` : "App wording · screen not verified",
          before: `The bundled message reads “${before}”.`, after: `The same message now reads “${after}”.`,
          status: "inferred_from_code", origin: "upstream",
          evidenceReferences: [{id: `${group.id}:evidence:${index}`, sha256: doctorDigest(evidence)}],
          limitations: [`Matched message ID: ${key}.`, "Code inference only. Visibility, active locale and server rollout were not tested."],
          dependencies: [...change.dependencies], analysisGroupIds: [group.id],
        };
        result.push({...body,id:changelogEntryId(body)}); seen.add(identity);
      }
    }
  }
  return result;
}

function analyzeChange(
  change: DoctorSourceChange,
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
  budget: ReadBudget,
  inputsBound: boolean,
): AnalyzedEntry {
  const left = change.beforeSha256 && inputsBound ? readEvidenceBytes(before, change.artifact, change.path, change.beforeSha256, budget) : { bytes: null, problem: null };
  const right = change.afterSha256 && inputsBound ? readEvidenceBytes(after, change.artifact, change.path, change.afterSha256, budget) : { bytes: null, problem: null };
  const archiveWrapper = change.artifact === "shipped_file" && change.path.toLowerCase() === "contents/resources/app.asar";
  const knownOpaque = change.artifact === "shipped_file" && (change.path.endsWith("/Resources/codex") || change.path.endsWith("/bin/node") || change.path.includes(".framework/") && !extname(change.path));
  const inspectionProblem = (problem: string | null) => (archiveWrapper || knownOpaque) && problem?.includes("per-file analysis limit") ? null : problem;
  const beforeAnalysis = left.bytes ? indexJavaScript(change.path, left.bytes) : { index: null, units: [], problem: null };
  const afterAnalysis = right.bytes ? indexJavaScript(change.path, right.bytes) : { index: null, units: [], problem: null };
  return {
    key: sourceChangeKey(change), artifact: change.artifact, area: change.area, relevance: change.relevance,
    beforePath: change.beforeSha256 ? change.path : null, afterPath: change.afterSha256 ? change.path : null,
    beforeSha256: change.beforeSha256, afterSha256: change.afterSha256, change: change.change,
    semanticEquivalent: change.semanticEquivalent,
    reason: change.reason, requiredChecks: [...change.requiredChecks].sort(),
    beforeIndex: beforeAnalysis.index,
    afterIndex: afterAnalysis.index,
    beforeUnits: beforeAnalysis.units, afterUnits: afterAnalysis.units,
    beforeRange: null, afterRange: null, beforeFocus: null, afterFocus: null, coverageCount: 1,
    coverageKey: sourceChangeKey(change),
    beforeSourceBytes: left.bytes?.byteLength ?? null, afterSourceBytes: right.bytes?.byteLength ?? null,
    binaryEvidence: knownOpaque && (left.problem?.includes("per-file analysis limit") === true || right.problem?.includes("per-file analysis limit") === true) || [left.bytes, right.bytes].some((bytes) => bytes !== null && !isTextBytes(bytes)),
    readProblems: [inputsBound ? null : "the comparison fingerprints do not bind the supplied evidence", inspectionProblem(left.problem), inspectionProblem(right.problem),
      beforeAnalysis.problem ? `before ${beforeAnalysis.problem}` : null, afterAnalysis.problem ? `after ${afterAnalysis.problem}` : null]
      .filter((value): value is string => value !== null),
  };
}

function analyzeRename(
  rename: DoctorSourceRename,
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
  budget: ReadBudget,
  inputsBound: boolean,
): AnalyzedEntry {
  const left = inputsBound ? readEvidenceBytes(before, rename.artifact, rename.fromPath, rename.sha256, budget) : { bytes: null, problem: null };
  const right = inputsBound ? readEvidenceBytes(after, rename.artifact, rename.toPath, rename.sha256, budget) : { bytes: null, problem: null };
  return {
    key: sourceRenameKey(rename), artifact: rename.artifact, area: rename.area, relevance: rename.relevance,
    beforePath: rename.fromPath, afterPath: rename.toPath, beforeSha256: rename.sha256, afterSha256: rename.sha256,
    change: "renamed", reason: rename.reason, requiredChecks: [...rename.requiredChecks].sort(),
    semanticEquivalent: false,
    beforeIndex: left.bytes ? indexJavaScript(rename.fromPath, left.bytes).index : null,
    afterIndex: right.bytes ? indexJavaScript(rename.toPath, right.bytes).index : null,
    beforeUnits: [], afterUnits: [], beforeRange: null, afterRange: null, beforeFocus: null, afterFocus: null, coverageCount: 1,
    coverageKey: sourceRenameKey(rename),
    beforeSourceBytes: left.bytes?.byteLength ?? null, afterSourceBytes: right.bytes?.byteLength ?? null,
    binaryEvidence: [left.bytes, right.bytes].some((bytes) => bytes !== null && !isTextBytes(bytes)),
    readProblems: [inputsBound ? null : "the comparison fingerprints do not bind the supplied evidence", left.problem, right.problem]
      .filter((value): value is string => value !== null),
  };
}

function pairStructuralRenames(entries: AnalyzedEntry[]): AnalyzedEntry[] {
  const removed = entries.filter((entry) => entry.change === "removed" && entry.beforeIndex);
  const added = entries.filter((entry) => entry.change === "added" && entry.afterIndex);
  const candidates: Array<{ removed: AnalyzedEntry; added: AnalyzedEntry; score: number }> = [];
  const stemKey = (entry: AnalyzedEntry, side: "before" | "after") => `${entry.artifact}:${entry.area}:${normalizedStem((side === "before" ? entry.beforePath : entry.afterPath)!)}`;
  const stemCounts = (entries: AnalyzedEntry[], side: "before" | "after") => {
    const counts = new Map<string, number>();
    for (const entry of entries) { const key = stemKey(entry, side); counts.set(key, (counts.get(key) ?? 0) + 1); }
    return counts;
  };
  const removedStems = stemCounts(removed, "before"), addedStems = stemCounts(added, "after");
  // Index useful anchors first. Comparing every removed bundle with every added bundle is quadratic.
  const anchors = (entry: AnalyzedEntry, side: "before" | "after") => {
    const index = side === "before" ? entry.beforeIndex! : entry.afterIndex!;
    const path = side === "before" ? entry.beforePath! : entry.afterPath!;
    return [`stem:${normalizedStem(path)}`, ...index.routes.filter(x => x.length > 3).map(x => `route:${x}`),
      ...index.exports.filter(x => x.length > 3 && x !== "default").map(x => `export:${x}`)].map(x => `${entry.artifact}:${entry.area}:${x}`);
  };
  const byAnchor = new Map<string, AnalyzedEntry[]>();
  for (const entry of added) for (const anchor of anchors(entry, "after")) {
    const values = byAnchor.get(anchor) ?? []; values.push(entry); byAnchor.set(anchor, values);
  }
  for (const left of removed) {
    const possible = new Set(anchors(left, "before").flatMap(anchor => byAnchor.get(anchor) ?? []));
    for (const right of possible) {
      const score = structuralSimilarity(left.beforeIndex!, right.afterIndex!);
      const sameStem = stemKey(left, "before") === stemKey(right, "after");
      const namedPair = sameStem && removedStems.get(stemKey(left, "before")) === 1
        && addedStems.get(stemKey(right, "after")) === 1
        && sharesStableAnchors(left.beforeIndex!, right.afterIndex!);
      if (score >= 0.9 || namedPair) candidates.push({ removed: left, added: right, score: namedPair ? 2 + score : score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.removed.key.localeCompare(b.removed.key) || a.added.key.localeCompare(b.added.key));
  const ties = new Map<string, number>();
  for (const candidate of candidates) for (const key of [`left:${candidate.removed.key}:${candidate.score}`, `right:${candidate.added.key}:${candidate.score}`]) ties.set(key, (ties.get(key) ?? 0) + 1);
  const usedRemoved = new Set<string>(), usedAdded = new Set<string>();
  const paired: AnalyzedEntry[] = [];
  for (const candidate of candidates) {
    if (usedRemoved.has(candidate.removed.key) || usedAdded.has(candidate.added.key)) continue;
    const tiedLeft = (ties.get(`left:${candidate.removed.key}:${candidate.score}`) ?? 0) > 1;
    const tiedRight = (ties.get(`right:${candidate.added.key}:${candidate.score}`) ?? 0) > 1;
    if (tiedLeft || tiedRight) continue;
    usedRemoved.add(candidate.removed.key); usedAdded.add(candidate.added.key);
    paired.push({
      ...candidate.removed,
      key: `structural:${candidate.removed.key}:${candidate.added.key}`,
      afterPath: candidate.added.afterPath,
      afterSha256: candidate.added.afterSha256,
      afterIndex: candidate.added.afterIndex,
      afterUnits: candidate.added.afterUnits,
      afterSourceBytes: candidate.added.afterSourceBytes,
      change: "structural_rename",
      coverageCount: candidate.removed.coverageCount + candidate.added.coverageCount,
      coverageKey: `structural:${candidate.removed.coverageKey}:${candidate.added.coverageKey}`,
      semanticEquivalent: false,
      reason: "Removed and added JavaScript artifacts have a unique structural correspondence or a unique bundle name supported by parsed dependency/message anchors; behavioral equivalence was not established.",
      requiredChecks: [...new Set([...candidate.removed.requiredChecks, ...candidate.added.requiredChecks])].sort(),
      readProblems: [...candidate.removed.readProblems, ...candidate.added.readProblems],
    });
  }
  return entries.filter((entry) => !usedRemoved.has(entry.key) && !usedAdded.has(entry.key)).concat(paired).sort((a, b) => a.key.localeCompare(b.key));
}

function splitAnalysisUnits(entry: AnalyzedEntry): AnalyzedEntry[] {
  if (!entry.beforeUnits.length || !entry.afterUnits.length || entry.change === "renamed" || entry.semanticEquivalent) return [entry];
  const pairs = pairUnits(entry.beforeUnits, entry.afterUnits);
  if (!pairs) return [entry];
  if (pairs.some(({ left, right }) => !left || !right)) return [entry];
  const changed = pairs.filter(({ left, right }) => left?.sha256 !== right?.sha256)
    .sort((a, b) => a.left!.range.offset - b.left!.range.offset);
  if (!changed.length) return [entry];
  if (entry.beforeSourceBytes === null || entry.afterSourceBytes === null
    || changed.some((pair, index) => index > 0 && pair.right!.range.offset <= changed[index - 1]!.right!.range.offset)) return [entry];
  const beforeRanges = partitionRanges(changed.map((pair) => pair.left!), entry.beforeSourceBytes);
  const afterRanges = partitionRanges(changed.map((pair) => pair.right!), entry.afterSourceBytes);
  if (!beforeRanges || !afterRanges) return [entry];
  return changed.map(({ identity, left, right }, index) => {
    return {
      ...entry,
      key: `unit:${entry.key}:${digest(identity)}`,
      beforeIndex: left ? withDependencyContext(left.index, entry.beforeIndex, entry.beforeUnits) : null,
      afterIndex: right ? withDependencyContext(right.index, entry.afterIndex, entry.afterUnits) : null,
      beforeUnits: [],
      afterUnits: [],
      beforeRange: beforeRanges[index]!,
      afterRange: afterRanges[index]!,
      beforeFocus: left?.range ?? null,
      afterFocus: right?.range ?? null,
      coverageCount: entry.coverageCount,
      reason: `${entry.reason}; deterministic top-level syntax unit ${identity} changed`,
    };
  });
}

function partitionRanges(units: CodeUnit[], sourceBytes: number): SourceRange[] | null {
  if (!units.length || !Number.isSafeInteger(sourceBytes) || sourceBytes < 1) return null;
  const ranges = units.map((unit, index) => {
    const offset = index === 0 ? 0 : unit.range.offset;
    const end = index + 1 < units.length ? units[index + 1]!.range.offset : sourceBytes;
    return { offset, bytes: end - offset };
  });
  return ranges.every((range) => range.bytes > 0 && range.offset >= 0 && range.offset + range.bytes <= sourceBytes) ? ranges : null;
}

function withDependencyContext(unit: CodeIndex, file: CodeIndex | null, units: CodeUnit[]): CodeIndex {
  const referenced = new Set(unit.identifiers);
  const visited = new Set<CodeUnit>();
  let added = true;
  while (added) { added = false; for (const local of units) {
    const names = local.identity.slice(local.identity.indexOf(":") + 1).split(",").filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
    if (!visited.has(local) && names.some(name => referenced.has(name))) {
      visited.add(local); added = true;
      for (const name of local.index.identifiers) referenced.add(name);
    }
  } }
  const boundSources = new Set((file?.importBindings ?? []).map(binding => (JSON.parse(binding) as string[])[1]));
  const sideEffects = (file?.imports ?? []).filter(source => !boundSources.has(source));
  const usedImports = (file?.importBindings ?? []).flatMap(binding => {
    const [local, source] = JSON.parse(binding) as [string, string];
    return referenced.has(local) ? [source] : [];
  });
  return { ...unit, imports: [...new Set([...sideEffects, ...usedImports, ...unit.imports])].sort() };
}

function uniqueUnits(units: CodeUnit[]): Map<string, CodeUnit> | null {
  const result = new Map<string, CodeUnit>();
  for (const unit of units) {
    if (result.has(unit.identity)) return null;
    result.set(unit.identity, unit);
  }
  return result;
}

function pairUnits(beforeUnits: CodeUnit[], afterUnits: CodeUnit[]): Array<{ identity: string; left: CodeUnit | null; right: CodeUnit | null }> | null {
  const before = uniqueUnits(beforeUnits), after = uniqueUnits(afterUnits);
  if (!before || !after) return null;
  const pairs: Array<{ identity: string; left: CodeUnit | null; right: CodeUnit | null }> = [];
  const usedBefore = new Set<CodeUnit>(), usedAfter = new Set<CodeUnit>();
  for (const identity of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(identity), right = after.get(identity);
    if (!left || !right) continue;
    usedBefore.add(left); usedAfter.add(right); pairs.push({ identity, left, right });
  }
  for (const left of beforeUnits.filter((unit) => !usedBefore.has(unit))) {
    const right = afterUnits.find((unit) => !usedAfter.has(unit) && unit.ordinal === left.ordinal && unit.kind === left.kind);
    if (!right) continue;
    usedBefore.add(left); usedAfter.add(right);
    pairs.push({ identity: `${left.kind}:ordinal:${left.ordinal}`, left, right });
  }
  for (const left of beforeUnits.filter((unit) => !usedBefore.has(unit))) pairs.push({ identity: `removed:${left.identity}`, left, right: null });
  for (const right of afterUnits.filter((unit) => !usedAfter.has(unit))) pairs.push({ identity: `added:${right.identity}`, left: null, right });
  return pairs.sort((a, b) => a.identity.localeCompare(b.identity));
}

function groupEntries(entries: AnalyzedEntry[]): ChangeGroup[] {
  const buckets = new Map<string, AnalyzedEntry[]>();
  for (const entry of entries) {
    const key = reviewDescriptor([entry]).groupingKey;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry); buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, members]) => {
    const sorted = [...members].sort((a, b) => a.key.localeCompare(b.key));
    const routes = [...new Set(sorted.flatMap((entry) => [...(entry.beforeIndex?.routes ?? []), ...(entry.afterIndex?.routes ?? [])]))].sort();
    const route = routes.length === 1 ? routes[0]! : null;
    const subjects = [...new Set(sorted.map(moduleSubject))].sort();
    const subject = listValues(subjects, 3);
    return { key, entries: sorted, area: sorted[0]!.area, route, subject,
      id: `change-${digest({ key, members: sorted.map((entry) => entry.key) }).slice(7, 23)}` };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function buildChange(group: ChangeGroup, pathOwners: Map<string, Set<string>>): DoctorChangeV1 {
  const descriptor = reviewDescriptor(group.entries);
  const states = group.entries.map(classifyEntry);
  const status = descriptor.work.kind === "internal" ? "observed"
    : descriptor.work.kind === "evidence_needed" || descriptor.work.kind === "observation_limit" ? "unknown"
      : states.includes("unknown") ? "unknown" : states.includes("code") ? "inferred_from_code" : "observed";
  const evidence = group.entries.flatMap((entry) => entryEvidence(entry));
  const actual = summarizeActualChanges(group.entries);
  const dependencies = [...new Set(group.entries.flatMap((entry) => inferredDependencies(entry, pathOwners)))]
    .filter((id) => id !== group.id).sort();
  return {
    reviewWork: descriptor.work,
    unknownPolicy: descriptor.work.kind === "evidence_needed" ? "blocking" : initialUnknownPolicy(status, group.entries),
    id: group.id,
    area: group.route ? `workflow:${group.route}` : group.area,
    title: descriptor.work.question,
    before: actual.before,
    after: actual.after,
    status,
    technicalOnly: descriptor.work.kind === "internal",
    evidence,
    dependencies,
    compatibility: [...new Set(group.entries.flatMap((entry) => entry.requiredChecks))].sort(),
    overrides: [],
  };
}

function reviewDescriptor(entries: AnalyzedEntry[]): ReviewDescriptor {
  const areas = [...new Set(entries.map((entry) => entry.area))].sort();
  const area = areas.length === 1 ? areas[0]! : "multiple areas";
  const indexes = entries.flatMap((entry) => [entry.beforeIndex, entry.afterIndex]).filter((value): value is CodeIndex => value !== null);
  const values = (key: keyof CodeIndex) => [...new Set(indexes.flatMap((index) => index[key]))].sort();
  const routes = values("routes");
  const messages = values("messages").map((value) => JSON.parse(value)[0] as string);
  const labels = values("labels"), handlers = values("handlers"), settings = values("settings");
  const backendCalls = values("backendCalls"), styles = values("styles");
  const conditions = values("renderConditions").filter(meaningfulCondition);
  const subjects = [...new Set(entries.map(moduleSubject))].sort();
  const specificHandlers = handlers.filter(specificHandler);
  const specificSettings = settings.filter(specificSetting);
  const backendAnchors = [...new Set(backendCalls.map((value) => value.replace(/\(.*/, "").split(".").at(-1)!).filter(Boolean))].sort();
  const interactionContext = [...new Set([
    ...values("exports").filter(meaningfulSymbol).map((value) => `export:${value}`),
    ...values("calls").map((value) => value.split(".").at(-1)!).filter(meaningfulCall).map((value) => `call:${value}`),
    ...conditions.map((value) => `condition:${value}`),
  ])].sort();
  const behaviorAnchor = routes.length ? { type: "route", values: routes, text: `routes ${listValues(routes, 4)}` }
    : messages.length ? { type: "message", values: messageNamespaces(messages), text: `message families ${listValues(messageNamespaces(messages), 4)}` }
      : backendAnchors.length ? { type: "backend", values: backendAnchors, text: `backend calls ${listValues(backendAnchors, 4)}` }
        : specificHandlers.length ? { type: "handler", values: specificHandlers, text: `handlers ${listValues(specificHandlers, 4)}` }
          : specificSettings.length ? { type: "setting", values: specificSettings.map((value) => value.split("=")[0]!), text: `settings ${listValues(specificSettings, 4)}` }
            : labels.length ? { type: "label", values: subjects, text: `user-facing labels in ${listValues(subjects, 3)}` }
              : handlers.length ? { type: "interaction", values: [...subjects, ...interactionContext],
                text: `UI interactions in ${listValues(subjects, 3)}${interactionContext.length ? ` with ${listValues(interactionContext, 3)}` : ""}` }
                : styles.length ? { type: "style", values: subjects, text: `rendered styles in ${listValues(subjects, 3)}` }
                  : conditions.length ? { type: "condition", values: subjects, text: `render conditions in ${listValues(subjects, 3)}` }
                    : null;
  const hasReadProblem = entries.some((entry) => entry.readProblems.length > 0);
  if (hasReadProblem) {
    const unsupportedSyntax = entries.some((entry) => entry.readProblems.some((problem) => /parse|AST|JavaScript exceeds|UTF-8/i.test(problem)));
    const reasonCode = unsupportedSyntax ? "unsupported_syntax" : "source_unavailable";
    const problems = [...new Set(entries.flatMap((entry) => entry.readProblems))].sort();
    const paths = [...new Set(entries.map(displayPath))].sort();
    return { work: { version: 1, kind: "evidence_needed", reasonCode,
      question: `What changed in ${areaLabel(area)} after recovering ${listValues(paths, 2)}? Current limit: ${listValues(problems, 2)}.` },
      groupingKey: `evidence:${reasonCode}:${area}:${digest(problems)}` };
  }
  const identical = entries.every((entry) => entry.change === "renamed" && entry.beforeSha256 === entry.afterSha256);
  const packaging = entries.every((entry) => entry.semanticEquivalent || entry.change === "renamed"
    || ["signature_metadata", "packaging", "package_metadata"].includes(entry.area)
    || (entry.artifact === "shipped_file" && (entry.beforePath ?? entry.afterPath)?.toLowerCase() === "contents/resources/app.asar"));
  if (identical || packaging) {
    const reasonCode = identical ? "identical_content" : "packaging";
    return { work: { version: 1, kind: "internal", reasonCode,
      question: identical ? "Which artifact paths changed while their exact content stayed identical?"
        : `Which supported ${areaLabel(area)} packaging details changed?` },
      groupingKey: `internal:${reasonCode}:${area}` };
  }
  if (entries.some((entry) => entry.binaryEvidence)) {
    const paths = [...new Set(entries.map(displayPath))].sort();
    return { work: { version: 1, kind: "observation_limit", reasonCode: "opaque_binary",
      question: `What observable behavior changed for ${listValues(paths, 3)}? Static inspection cannot interpret its opaque bytes.` },
      groupingKey: `observation:opaque_binary:${area}` };
  }
  if (entries.every((entry) => entry.area === "schema" && entry.beforeSha256 && entry.afterSha256)) {
    return { work: { version: 1, kind: "behavior", reasonCode: "changed_behavior",
      question: "What backend contract behavior changed in the generated app-server schema?" },
      groupingKey: "behavior:schema:generated-app-server" };
  }
  if (behaviorAnchor) {
    const changedMessageIds = [...new Set(entries.flatMap(entry => {
      const before = new Map((entry.beforeIndex?.messages ?? []).map(value => JSON.parse(value) as [string, string]));
      return (entry.afterIndex?.messages ?? []).flatMap(value => { const [id, text] = JSON.parse(value) as [string, string]; return before.has(id) && before.get(id) !== text ? [id] : []; });
    }))].sort();
    const family = workflowFamily(entries, [...routes, ...messageNamespaces(messages)]);
    const aspect = ["message", "label"].includes(behaviorAnchor.type) ? "wording"
      : ["handler", "interaction", "style", "condition"].includes(behaviorAnchor.type) ? "controls and appearance"
        : behaviorAnchor.type === "backend" ? "backend interactions" : behaviorAnchor.type === "setting" ? "settings" : "navigation";
    return { work: { version: 1, kind: "behavior", reasonCode: "changed_behavior",
      question: `What changed in ${family} ${aspect}?` },
      groupingKey: `behavior:${area}:${family}:${aspect}${changedMessageIds.length ? `:${digest(changedMessageIds)}` : ""}` };
  }
  return { work: { version: 1, kind: "evidence_needed", reasonCode: "unclassified_change",
    question: `What behavior changed for ${listValues(subjects, 3)}? The full source is hash-bound, but no supported behavior anchor was found.` },
    groupingKey: `evidence:unclassified_change:${area}` };
}

function workflowFamily(entries: AnalyzedEntry[], anchors: string[]): string {
  const context = [...entries.map(moduleSubject), ...anchors].join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const families: Array<[string, RegExp]> = [
    ["accounts and sign-in", /account|auth|login|sign.?in|profile/], ["composer", /composer|prompt.?input|attachment|upload/],
    ["sidebar", /sidebar|navigation.?rail/], ["settings", /settings|preferences|configuration/],
    ["projects and workspaces", /project|workspace|worktree/], ["conversation", /conversation|thread|chat.?message|transcript/],
    ["plugins and tools", /plugin|connector|mcp|tool.?call/], ["files and previews", /file|artifact|preview|document/],
    ["terminal and commands", /terminal|command|shell|shortcut/], ["browser and computer use", /browser|computer|desktop.?input/],
    ["voice", /voice|audio|speech|microphone/], ["charts and visualizations", /chart|visualization|plot|graph|drag.?point/],
    ["window and titlebar", /window|titlebar|fullscreen|zoom/], ["notifications", /notification|toast|alert/],
    ["updates and startup", /update|startup|bootstrap|preload/], ["tasks and scheduling", /task|schedule|automation/],
    ["search", /search|filter/], ["shared icons", /icon|lucide/],
  ];
  return families.find(([,pattern]) => pattern.test(context))?.[0] ?? "shared interface";
}

function meaningfulCondition(value: string): boolean {
  const words = value.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  return words.some((word) => word.length >= 4 && !/^(?:true|false|null|this)$/i.test(word));
}

function specificHandler(value: string): boolean {
  if (/^(?:onClick|onChange|onSubmit|onOpen|onClose|onFocus|onBlur|callback|handler)$/i.test(value)) return false;
  return /^(?:on[A-Z][A-Za-z0-9]{4,}|[A-Za-z][A-Za-z0-9_.]*(?:Handler|Callback))$/.test(value);
}

function specificSetting(value: string): boolean {
  const key = value.split("=")[0]!;
  if (/^(?:enabled|disabled|config|configure|setting|settings|preference|feature)$/i.test(key.split(".").at(-1)!)) return false;
  return key.length >= 5 && meaningfulSymbol(key);
}

function meaningfulSymbol(value: string): boolean {
  const words = value.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  return words.some((word) => word.length >= 5 && !/^(?:default|exports?|module|object|prototype|constructor)$/i.test(word));
}

function meaningfulCall(value: string): boolean {
  return value.length >= 5 && !/^(?:createElement|jsx|jsxs|useMemo|useCallback|useEffect|useState|defineProperty|require)$/i.test(value);
}

function messageNamespaces(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.split(/[.:/]/).filter(Boolean).slice(0, 2).join(".") || id))].sort();
}

function initialUnknownPolicy(status: DoctorChangeV1["status"], entries: AnalyzedEntry[]): DoctorChangeV1["unknownPolicy"] {
  if (status !== "unknown") return undefined;
  if (entries.some((entry) => entry.readProblems.length > 0)) return "blocking";
  return entries.some((entry) => entry.requiredChecks.length > 0 || entry.relevance === "relevant")
    ? "blocking"
    : "acknowledgment";
}

function summarizeActualChanges(entries: AnalyzedEntry[]): { before: string; after: string } {
  const beforePaths = entries.map((entry) => entry.beforePath).filter((value): value is string => value !== null);
  const afterPaths = entries.map((entry) => entry.afterPath).filter((value): value is string => value !== null);
  const beforeIndex = combineIndexes(entries.map((entry) => entry.beforeIndex));
  const afterIndex = combineIndexes(entries.map((entry) => entry.afterIndex));
  return {
    before: sideSummary(beforePaths, beforeIndex, "Before"),
    after: sideSummary(afterPaths, afterIndex, "After"),
  };
}

function sideSummary(paths: string[], index: CodeIndex | null, label: string): string {
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length === 0) return `${label}: no artifact existed at the compared path.`;
  const parts = [`${label}: ${listValues(uniquePaths, 4)}.`];
  if (index?.routes.length) parts.push(`Extracted route references: ${listValues(index.routes, 6)}.`);
  if (index?.exports.length) parts.push(`Extracted exports: ${listValues(index.exports, 6)}.`);
  if (index?.imports.length) parts.push(`Extracted imports: ${listValues(index.imports, 6)}.`);
  if (index?.calls.length) parts.push(`Extracted calls: ${listValues(index.calls, 6)}.`);
  return parts.join(" ");
}

function entryEvidence(entry: AnalyzedEntry): DoctorChangeV1["evidence"] {
  const isArchiveContainer = entry.artifact === "shipped_file"
    && (entry.beforePath ?? entry.afterPath)?.toLowerCase() === "contents/resources/app.asar";
  const detail = isArchiveContainer
    ? `The parent app.asar inventory digest changed; member-level evidence, rather than the raw archive bytes, describes possible behavior changes; inventory change: ${entry.change}.`
    : entry.semanticEquivalent
    ? "Semantic hashes match after bundle-reference normalization; this is packaging evidence only and does not establish behavioral equivalence."
    : entry.change === "renamed"
    ? "The before and after inventories record an identical byte digest at different paths."
    : entry.change === "structural_rename"
      ? "A unique high-overlap import/export/route/call index links the removed and added JavaScript artifacts; this does not establish behavioral equivalence."
      : `${entry.reason}; inventory change: ${entry.change}.`;
  return [{
    kind: "static",
    artifact: entry.artifact,
    path: entry.beforePath && entry.afterPath && entry.beforePath !== entry.afterPath
      ? `${entry.beforePath} -> ${entry.afterPath}`
      : entry.beforePath ?? entry.afterPath ?? "unknown",
    beforeSha256: entry.beforeSha256,
    afterSha256: entry.afterSha256,
    beforeRange: entry.beforeRange,
    afterRange: entry.afterRange,
    beforeFocus: validFocus(entry.beforeFocus, entry.beforeRange, entry.beforeSourceBytes),
    afterFocus: validFocus(entry.afterFocus, entry.afterRange, entry.afterSourceBytes),
    beforeSourceBytes: entry.beforeSourceBytes,
    afterSourceBytes: entry.afterSourceBytes,
    detail,
  }];
}

function validFocus(focus: SourceRange | null, membership: SourceRange | null, sourceBytes: number | null): SourceRange | null {
  if (!focus || !membership || sourceBytes === null) return null;
  const focusEnd = focus.offset + focus.bytes;
  const membershipEnd = membership.offset + membership.bytes;
  return Number.isSafeInteger(focus.offset) && Number.isSafeInteger(focus.bytes) && focus.bytes > 0
    && focus.offset >= membership.offset && focusEnd <= membershipEnd && focusEnd <= sourceBytes ? focus : null;
}

function classifyEntry(entry: AnalyzedEntry): "code" | "observed" | "unknown" {
  if (entry.relevance === "unresolved" || entry.readProblems.length > 0) return "unknown";
  if (entry.change === "added" || entry.change === "removed") return "unknown";
  if (entry.semanticEquivalent) return "observed";
  if (entry.beforeIndex && entry.afterIndex && indexesDiffer(entry.beforeIndex, entry.afterIndex)) return "code";
  if (entry.change === "renamed" && entry.beforeSha256 === entry.afterSha256) return "observed";
  if (entry.binaryEvidence) return "unknown";
  if (entry.artifact === "schema" && entry.beforeSha256 && entry.afterSha256) return "observed";
  if (["packaging", "signature_metadata", "static_assets", "localization", "package_metadata"].includes(entry.area)) return "observed";
  return "unknown";
}

function classifiedInputCount(entries: AnalyzedEntry[]): number {
  const records = new Map<string, { count: number; complete: boolean }>();
  for (const entry of entries) {
    const record = records.get(entry.coverageKey) ?? { count: entry.coverageCount, complete: true };
    record.count = Math.max(record.count, entry.coverageCount);
    record.complete = record.complete && classifyEntry(entry) !== "unknown";
    records.set(entry.coverageKey, record);
  }
  return [...records.values()].reduce((count, record) => count + (record.complete ? record.count : 0), 0);
}

function changedPathOwners(groups: ChangeGroup[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const group of groups) for (const entry of group.entries) {
    for (const path of [entry.beforePath, entry.afterPath]) {
      if (!path) continue;
      const key = `${entry.artifact}:${path}`;
      const owners = result.get(key) ?? new Set<string>();
      owners.add(group.id); result.set(key, owners);
    }
  }
  return result;
}

function inferredDependencies(entry: AnalyzedEntry, owners: Map<string, Set<string>>): string[] {
  const ids = new Set<string>();
  if (entry.artifact === "asar_member") {
    for (const archive of owners.get("shipped_file:Contents/Resources/app.asar") ?? []) ids.add(archive);
  }
  for (const [path, index] of [[entry.beforePath, entry.beforeIndex], [entry.afterPath, entry.afterIndex]] as const) {
    if (!path || !index) continue;
    for (const imported of index.imports) {
      if (!imported.startsWith(".")) continue;
      const base = posix.normalize(posix.join(posix.dirname(path), imported));
      for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, posix.join(base, "index.js")]) {
        for (const owner of owners.get(`${entry.artifact}:${candidate}`) ?? []) ids.add(owner);
      }
    }
  }
  return [...ids];
}

function analysisWorkPriority(relevance: AnalyzedEntry["relevance"], area: string): number {
  const relevancePriority = relevance === "relevant" ? 0 : relevance === "unresolved" ? 1 : 2;
  const areaPriority = ["frontend", "preload", "main", "backend", "schema"].indexOf(area);
  return relevancePriority * 100 + (areaPriority < 0 ? 50 : areaPriority);
}

function moduleSubject(entry: AnalyzedEntry): string {
  const paths = [entry.beforePath, entry.afterPath].filter((value): value is string => value !== null);
  if (paths.some((path) => path.toLowerCase() === "contents/resources/app.asar")) return "the app.asar container";
  const normalized = [...new Set(paths.map((path) => normalizedModulePath(path)))].sort();
  return normalized.length === 0 ? `${entry.area} inventory` : listValues(normalized, 2);
}

function normalizedModulePath(path: string): string {
  const directory = posix.dirname(path);
  const extension = extname(path);
  const stem = normalizedStem(path);
  return directory === "." ? `${stem}${extension}` : `${directory}/${stem}${extension}`;
}

function chunked<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

function readAnalysisCheckpoint(directory: string, key: DoctorSourceSha256): AnalyzedEntry[] | null {
  const file = analysisCheckpointPath(directory, key);
  try {
    const value = readDoctorPrivateJson(file, { maxBytes: 64 * 1024 * 1024 });
    if (!value || typeof value !== "object") return null;
    const envelope = value as { schemaVersion?: unknown; analysisVersion?: unknown; key?: unknown; entries?: unknown; fingerprint?: unknown };
    if (envelope.schemaVersion !== 1 || envelope.analysisVersion !== ANALYSIS_VERSION || envelope.key !== key
      || !Array.isArray(envelope.entries) || !envelope.entries.every(validAnalyzedEntry)) return null;
    const payload = { schemaVersion: 1, analysisVersion: ANALYSIS_VERSION, key, entries: envelope.entries };
    return envelope.fingerprint === doctorDigest(payload) ? envelope.entries as AnalyzedEntry[] : null;
  } catch { return null; }
}

function writeAnalysisCheckpoint(directory: string, key: DoctorSourceSha256, entries: AnalyzedEntry[]): void {
  const payload = { schemaVersion: 1, analysisVersion: ANALYSIS_VERSION, key, entries };
  writeDoctorPrivateJson(analysisCheckpointPath(directory, key), { ...payload, fingerprint: doctorDigest(payload) });
}

function analysisCheckpointPath(directory: string, key: DoctorSourceSha256): string {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error("Doctor analysis checkpoint directory must be an exact absolute path");
  return join(directory, `analysis-v${ANALYSIS_VERSION}-${key.slice("sha256:".length)}.json`);
}

function validAnalyzedEntry(value: unknown): value is AnalyzedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AnalyzedEntry>;
  return typeof entry.key === "string"
    && ["shipped_file", "asar_member", "schema"].includes(entry.artifact ?? "")
    && typeof entry.area === "string"
    && ["relevant", "irrelevant", "unresolved"].includes(entry.relevance ?? "")
    && ["added", "removed", "modified", "renamed", "structural_rename"].includes(entry.change ?? "")
    && typeof entry.semanticEquivalent === "boolean"
    && typeof entry.reason === "string"
    && Array.isArray(entry.requiredChecks) && entry.requiredChecks.every((item) => typeof item === "string")
    && Array.isArray(entry.beforeUnits) && entry.beforeUnits.every(validCodeUnit)
    && Array.isArray(entry.afterUnits) && entry.afterUnits.every(validCodeUnit)
    && validIndex(entry.beforeIndex) && validIndex(entry.afterIndex)
    && validRange(entry.beforeRange) && validRange(entry.afterRange)
    && validRange(entry.beforeFocus) && validRange(entry.afterFocus)
    && validNullableByteCount(entry.beforeSourceBytes) && validNullableByteCount(entry.afterSourceBytes)
    && Number.isSafeInteger(entry.coverageCount) && entry.coverageCount! >= 0
    && typeof entry.coverageKey === "string"
    && typeof entry.binaryEvidence === "boolean"
    && Array.isArray(entry.readProblems) && entry.readProblems.every((item) => typeof item === "string")
    && validNullablePath(entry.beforePath) && validNullablePath(entry.afterPath)
    && validNullableSha(entry.beforeSha256) && validNullableSha(entry.afterSha256);
}

function validCodeUnit(value: unknown): value is CodeUnit {
  if (!value || typeof value !== "object") return false;
  const unit = value as Partial<CodeUnit>;
  return typeof unit.identity === "string" && typeof unit.kind === "string" && Number.isSafeInteger(unit.ordinal) && unit.ordinal! >= 0
    && SHA256.test(unit.sha256 ?? "") && validRange(unit.range) && unit.range !== null && validIndex(unit.index) && unit.index !== null;
}

function validIndex(value: unknown): value is CodeIndex | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<CodeIndex>;
  return [index.messages, index.imports, index.identifiers, index.importBindings, index.exports, index.routes, index.calls, index.labels, index.handlers,
    index.renderConditions, index.settings, index.styles, index.backendCalls]
    .every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

function validRange(value: unknown): value is SourceRange | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<SourceRange>;
  return Number.isSafeInteger(range.offset) && range.offset! >= 0 && Number.isSafeInteger(range.bytes) && range.bytes! > 0;
}

function validNullablePath(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function validNullableSha(value: unknown): value is DoctorSourceSha256 | null { return value === null || (typeof value === "string" && SHA256.test(value)); }
function validNullableByteCount(value: unknown): value is number | null { return value === null || (Number.isSafeInteger(value) && (value as number) >= 0); }

function readEvidenceBytes(
  evidence: DoctorSourceEvidence,
  artifact: DoctorSourceChange["artifact"],
  path: string,
  expectedSha256: DoctorSourceSha256,
  budget: ReadBudget,
): ReadResult {
  if (!safeRelativePath(path)) return { bytes: null, problem: "the evidence path is unsafe" };
  const descriptor = artifact === "asar_member"
    ? evidence.asar.members.find((entry) => entry.path === path)
    : artifact === "schema"
      ? evidence.schemas.files.find((entry) => entry.path === path)
      : evidence.shippedFiles.find((entry) => entry.path === path);
  if (!descriptor) return { bytes: null, problem: "the path is absent from the bound inventory" };
  const descriptorSha256 = "rawSha256" in descriptor ? descriptor.rawSha256 : descriptor.sha256;
  if (descriptorSha256 !== expectedSha256) return { bytes: null, problem: "the comparison digest does not match the bound inventory" };
  const expectedBytes = descriptor.bytes;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_SOURCE_BYTES) {
    return { bytes: null, problem: `the source exceeds the ${MAX_SOURCE_BYTES}-byte per-file analysis limit` };
  }
  if (budget.bytes + expectedBytes > budget.limit) return { bytes: null, problem: "the deterministic analysis batch byte limit was exhausted" };
  if ("kind" in descriptor && descriptor.kind !== "file") return { bytes: null, problem: "symbolic-link content is not parsed as source" };
  try {
    let bytes: Buffer;
    if (artifact === "asar_member") {
      const archive = exactChild(evidence.appPath, evidence.asar.path);
      const archiveStat = lstatSync(archive);
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) return { bytes: null, problem: "the ASAR evidence path is not a regular file" };
      bytes = Buffer.from(asar.extractFile(archive, path));
    } else {
      const root = artifact === "schema"
        ? (evidence.schemas as DoctorSourceEvidence["schemas"] & { root?: string | null }).root
        : evidence.appPath;
      if (!root) return { bytes: null, problem: "the schema output root is unavailable" };
      if (!isAbsolute(root) || resolve(root) !== root) return { bytes: null, problem: "the evidence root is not an exact absolute path" };
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { bytes: null, problem: "the evidence root is not a regular directory" };
      const source = exactChild(root, path);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) return { bytes: null, problem: "the source identity or size changed" };
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        bytes = readFileSync(fd);
        const after = fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          return { bytes: null, problem: "the shipped source changed during inspection" };
        }
      } finally { closeSync(fd); }
    }
    if (bytes.byteLength !== expectedBytes) return { bytes: null, problem: "the extracted byte count does not match the evidence inventory" };
    if (digest(bytes) !== expectedSha256) return { bytes: null, problem: "the extracted digest does not match the evidence inventory" };
    budget.bytes += bytes.byteLength;
    return { bytes, problem: null };
  } catch (error) {
    return { bytes: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

function indexJavaScript(path: string, bytes: Buffer): IndexResult {
  if (!JAVASCRIPT.test(path)) return { index: null, units: [], problem: null };
  if (bytes.byteLength > MAX_AST_SOURCE_BYTES) {
    return { index: null, units: [], problem: `JavaScript exceeds the ${MAX_AST_SOURCE_BYTES}-byte full-AST analysis range; partial syntax was not treated as complete evidence` };
  }
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return { index: null, units: [], problem: "JavaScript is not valid UTF-8" }; }
  let root: unknown;
  try { root = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
  catch {
    try { root = parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true }); }
    catch { return { index: null, units: [], problem: "JavaScript could not be parsed as a complete module or script" }; }
  }
  try {
    const statements = root && typeof root === "object" ? arrayField(root as Record<string, unknown>, "body") : [];
    const body = statements.flatMap(node => stringField(node, "type") === "VariableDeclaration"
      && arrayField(node, "declarations").length > 1 ? arrayField(node, "declarations") : [node]);
    const positioned = body.flatMap((node, ordinal) => {
      const start = typeof node.start === "number" ? node.start : null;
      const end = typeof node.end === "number" ? node.end : null;
      if (start === null || end === null || start < 0 || end <= start || end > source.length) return [];
      return [{ node, ordinal, start, end }];
    });
    const offsets = utf8BoundaryOffsets(source, positioned.flatMap(({ start, end }) => [start, end]));
    const sourceBytes = Buffer.from(source);
    const units = positioned.map(({ node, ordinal, start, end }) => {
      const offset = offsets.get(start)!;
      const byteEnd = offsets.get(end)!;
      const unitBytes = sourceBytes.subarray(offset, byteEnd);
      return { identity: topLevelUnitIdentity(node, ordinal), kind: stringField(node, "type") ?? "Unknown", ordinal,
        range: { offset, bytes: byteEnd - offset }, sha256: digest(unitBytes), index: buildCodeIndex(node) };
    });
    return { index: combineIndexes(units.map(unit => unit.index)), units, problem: null };
  } catch (error) {
    return { index: null, units: [], problem: error instanceof Error && error.message === "AST node limit exceeded"
      ? `JavaScript exceeds the ${MAX_AST_NODES}-node AST analysis limit`
      : `JavaScript indexing failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function utf8BoundaryOffsets(source: string, boundaries: number[]): Map<number, number> {
  const result = new Map<number, number>();
  let codeUnitOffset = 0;
  let byteOffset = 0;
  for (const boundary of [...new Set(boundaries)].sort((left, right) => left - right)) {
    byteOffset += Buffer.byteLength(source.slice(codeUnitOffset, boundary));
    codeUnitOffset = boundary;
    result.set(boundary, byteOffset);
  }
  return result;
}

function buildCodeIndex(root: unknown): CodeIndex {
  const imports = new Set<string>(), exports = new Set<string>(), routes = new Set<string>(), calls = new Set<string>();
  const identifiers = new Set<string>(), importBindings = new Set<string>();
  const labels = new Set<string>(), handlers = new Set<string>(), renderConditions = new Set<string>();
  const settings = new Set<string>(), styles = new Set<string>(), backendCalls = new Set<string>();
  const messages = new Map<string, string[]>();
  let nodes = 0;
  walk(root, (node) => {
    nodes += 1;
    if (nodes > MAX_AST_NODES) throw new Error("AST node limit exceeded");
    const type = stringField(node, "type");
    if (type === "Identifier") { const name = identifierName(node); if (name) identifiers.add(name); }
    if (type === "ImportDeclaration") {
      const source = literalString(field(node, "source"));
      if (source) for (const specifier of arrayField(node, "specifiers")) {
        const local = identifierName(field(specifier, "local"));
        if (local) importBindings.add(JSON.stringify([local, source]));
      }
    }
    if (type === "ImportDeclaration" || type === "ExportAllDeclaration") addStringLiteral(imports, field(node, "source"));
    if (type === "ImportExpression") addStringLiteral(imports, field(node, "source"));
    if (type === "ExportDefaultDeclaration") exports.add("default");
    if (type === "ExportNamedDeclaration") {
      for (const specifier of arrayField(node, "specifiers")) {
        const name = identifierName(field(specifier, "exported"));
        if (name) exports.add(name);
      }
      for (const name of declarationNames(field(node, "declaration"))) exports.add(name);
      addStringLiteral(imports, field(node, "source"));
    }
    if (type === "ObjectExpression") {
      const properties = arrayField(node, "properties");
      const value = (key: string) => {
        const matches = properties.filter(p => field(p, "computed") !== true && (identifierName(field(p, "key")) ?? literalString(field(p, "key"))) === key);
        return matches.length === 1 ? literalString(field(matches[0], "value")) : null;
      };
      const id = value("id"), message = value("defaultMessage");
      if (id && message && id.length <= 200 && message.length <= 200 && !/[\r\n]/.test(message)) {
        messages.set(id, [...(messages.get(id) ?? []), message]);
      }
      for (const property of properties) {
        if (field(property, "computed") === true) continue;
        const key = identifierName(field(property, "key")) ?? literalString(field(property, "key"));
        if (!key) continue;
        const literal = literalString(field(property, "value"));
        if (/^(?:label|title|placeholder|description|tooltip|aria-label|emptyText)$/i.test(key) && literal) addBounded(labels, `${key}=${literal}`);
        if (/^on[A-Z]|(?:Handler|Callback)$/i.test(key)) addBounded(handlers, key);
        if (/^(?:className|class|variant|size|color|layout)$/i.test(key) && literal) addBounded(styles, `${key}=${literal}`);
        if (/(?:setting|preference|config|feature|enabled|disabled|permission|notification)/i.test(key)) {
          addBounded(settings, literal ? `${key}=${literal}` : key);
        }
      }
    }
    if (["IfStatement", "ConditionalExpression", "LogicalExpression"].includes(type ?? "")) {
      const condition = expressionName(field(node, type === "IfStatement" ? "test" : "left"));
      if (condition) addBounded(renderConditions, condition);
    }
    if (type !== "CallExpression") return;
    const callee = calleeName(field(node, "callee"));
    if (callee) calls.add(callee);
    const args = arrayField(node, "arguments");
    if (callee === "require" || callee === "import") addStringLiteral(imports, args[0]);
    const route = literalString(args[0]);
    if (route && route.startsWith("/") && /(?:^|\.)(?:get|post|put|patch|delete|use|route|navigate|registerRoute)$/.test(callee ?? "")) routes.add(route);
    if (callee && (/(?:^|\.)(?:fetch|request|invoke|rpc|send|postMessage|query|mutate)$/.test(callee)
      || /(?:api|client|http|server|router)\.(?:get|post|put|patch|delete)$/i.test(callee))) {
      addBounded(backendCalls, route ? `${callee}(${route})` : callee);
    }
    if (callee && /(?:setting|preference|config|featureFlag|storage)/i.test(callee)) {
      addBounded(settings, route ? `${callee}(${route})` : callee);
    }
  });
  return { messages: [...messages].filter(([,texts]) => texts.length === 1).map(([id,texts]) => JSON.stringify([id,texts[0]])).sort(),
    imports: [...imports].sort(), identifiers: [...identifiers].sort(), importBindings: [...importBindings].sort(), exports: [...exports].sort(), routes: [...routes].sort(), calls: [...calls].sort(),
    labels: [...labels].sort(), handlers: [...handlers].sort(), renderConditions: [...renderConditions].sort(),
    settings: [...settings].sort(), styles: [...styles].sort(), backendCalls: [...backendCalls].sort() };
}

function topLevelUnitIdentity(node: Record<string, unknown>, ordinal: number): string {
  const type = stringField(node, "type") ?? "Unknown";
  const declaration = field(node, "declaration");
  const names = [...new Set([...declarationNames(node), ...declarationNames(declaration)])].sort();
  if (names.length) return `${type}:${names.join(",")}`;
  const source = literalString(field(node, "source"));
  if (source) return `${type}:source:${source}`;
  if (type === "ExportDefaultDeclaration") return `${type}:default`;
  return `${type}:ordinal:${ordinal}`;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  // Minified expression chains can be deeply nested without being large. Avoid
  // treating a JavaScript call-stack overflow as an exhausted node allowance.
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) { for (let i = current.length - 1; i >= 0; i--) pending.push(current[i]); continue; }
    const node = current as Record<string, unknown>;
    if (typeof node.type === "string") visit(node);
    const children = Object.entries(node);
    for (let i = children.length - 1; i >= 0; i--) {
      const [key, child] = children[i]!;
      if (key !== "start" && key !== "end" && key !== "loc" && child && typeof child === "object") pending.push(child);
    }
  }
}

function sharesStableAnchors(left: CodeIndex, right: CodeIndex): boolean {
  const anchors = (index: CodeIndex) => new Set([
    ...index.imports.map(v => `dependency:${normalizedDependency(v)}`),
    ...index.routes.map(v => `route:${v}`),
    ...index.messages.map(v => `message:${JSON.parse(v)[0]}`),
  ]);
  const a = anchors(left), b = anchors(right);
  const shared = [...a].filter(v => b.has(v)).length;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
}

function structuralSimilarity(left: CodeIndex, right: CodeIndex): number {
  const a = new Set([...left.imports.map((v) => `i:${normalizedDependency(v)}`), ...left.exports.map((v) => `e:${v}`), ...left.routes.map((v) => `r:${v}`), ...left.calls.map((v) => `c:${v}`)]);
  const b = new Set([...right.imports.map((v) => `i:${normalizedDependency(v)}`), ...right.exports.map((v) => `e:${v}`), ...right.routes.map((v) => `r:${v}`), ...right.calls.map((v) => `c:${v}`)]);
  if (Math.min(a.size, b.size) < 3) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function combineIndexes(values: Array<CodeIndex | null>): CodeIndex | null {
  const present = values.filter((value): value is CodeIndex => value !== null);
  if (!present.length) return null;
  const merge = (key: keyof CodeIndex) => [...new Set(present.flatMap((value) => value[key]))].sort();
  return { messages: merge("messages"), imports: merge("imports"), identifiers: merge("identifiers"), importBindings: merge("importBindings"), exports: merge("exports"), routes: merge("routes"), calls: merge("calls"),
    labels: merge("labels"), handlers: merge("handlers"), renderConditions: merge("renderConditions"), settings: merge("settings"),
    styles: merge("styles"), backendCalls: merge("backendCalls") };
}

function indexesDiffer(left: CodeIndex, right: CodeIndex): boolean {
  return canonicalJson(left) !== canonicalJson(right);
}

function declarationNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  const type = stringField(node, "type");
  if (type === "FunctionDeclaration" || type === "ClassDeclaration") return [identifierName(field(node, "id"))].filter((v): v is string => !!v);
  if (type === "VariableDeclaration") return arrayField(node, "declarations").flatMap((declaration) => patternNames(field(declaration, "id")));
  if (type === "VariableDeclarator") return patternNames(field(node, "id"));
  return [];
}

function patternNames(value: unknown): string[] {
  const name = identifierName(value);
  if (name) return [name];
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  if (stringField(node, "type") === "RestElement") return patternNames(field(node, "argument"));
  return [...arrayField(node, "properties"), ...arrayField(node, "elements")].flatMap((child) => patternNames(field(child, "value") ?? child));
}

function calleeName(value: unknown): string | null {
  const direct = identifierName(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (stringField(node, "type") !== "MemberExpression" || field(node, "computed") === true) return null;
  const object = calleeName(field(node, "object"));
  const property = identifierName(field(node, "property"));
  return object && property ? `${object}.${property}` : null;
}

function expressionName(value: unknown): string | null {
  const direct = calleeName(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  const type = stringField(node, "type");
  if (type === "UnaryExpression") {
    const nested = expressionName(field(node, "argument"));
    return nested ? `${String(field(node, "operator") ?? "")}${nested}` : null;
  }
  if (type === "CallExpression") return calleeName(field(node, "callee"));
  return null;
}

function addBounded(output: Set<string>, value: string): void {
  if (value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value)) output.add(value);
}

function addStringLiteral(output: Set<string>, value: unknown): void { const text = literalString(value); if (text) output.add(text); }
function isTextBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}
function literalString(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  return stringField(node, "type") === "Literal" && typeof node.value === "string" ? node.value : null;
}
function identifierName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (stringField(node, "type") === "Identifier" && typeof node.name === "string") return node.name;
  if (stringField(node, "type") === "Literal" && typeof node.value === "string") return node.value;
  return null;
}
function field(node: Record<string, unknown>, key: string): unknown { return node[key]; }
function stringField(node: Record<string, unknown>, key: string): string | null { return typeof node[key] === "string" ? node[key] : null; }
function arrayField(node: Record<string, unknown>, key: string): Array<Record<string, unknown>> { return Array.isArray(node[key]) ? node[key].filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : []; }

function sourceChangeKey(change: DoctorSourceChange): string { return `change:${digest({ artifact: change.artifact, path: change.path, change: change.change, before: change.beforeSha256, after: change.afterSha256 })}`; }
function sourceRenameKey(rename: DoctorSourceRename): string { return `rename:${digest({ artifact: rename.artifact, from: rename.fromPath, to: rename.toPath, sha256: rename.sha256 })}`; }
function digest(value: Buffer | unknown): DoctorSourceSha256 { return `sha256:${createHash("sha256").update(Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex")}`; }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function safeRelativePath(path: string): boolean { return path.length > 0 && !isAbsolute(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
function exactChild(root: string, local: string): string {
  const candidate = resolve(root, ...local.split("/"));
  const prefix = resolve(root) + sep;
  if (!candidate.startsWith(prefix)) throw new Error("Evidence path escapes its app root");
  return candidate;
}
function normalizedStem(path: string): string { return basename(path, extname(path)).replace(/-[a-f0-9]{8,64}$/i, "-HASH"); }
function normalizedDependency(path: string): string { return `${posix.dirname(path)}/${normalizedStem(path)}${extname(path)}`; }
function intersects(left: string[], right: string[]): boolean { const values = new Set(left); return right.some((value) => values.has(value)); }
function listValues(values: string[], limit: number): string { return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} (+${values.length - limit} more)`; }
function displayPath(entry: AnalyzedEntry): string { return entry.beforePath && entry.afterPath && entry.beforePath !== entry.afterPath ? `${entry.beforePath} -> ${entry.afterPath}` : entry.beforePath ?? entry.afterPath ?? "unknown"; }
function areaLabel(area: string): string { return area.split("_").map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(" "); }

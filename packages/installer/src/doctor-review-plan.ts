import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { DoctorChangeReportV1, DoctorChangeV1 } from "@therealityreport/tweakers-sdk";
import type { DoctorSourceRequiredCheck, DoctorSourceSha256 } from "./doctor-evidence.js";
import type { DoctorSourceChange, DoctorSourceComparison, DoctorSourceRename } from "./doctor-evidence.js";
import type { DoctorSourceReviewInput, ReviewTarget } from "./doctor-review.js";

/** Limits apply to one review request, never to the coverage of the whole update. */
export const DOCTOR_REVIEW_CHUNK_BYTES = 4 * 1024;
export const DOCTOR_REVIEW_BATCH_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_TEXT_BYTES = 512 * 1024 * 1024;

/** Validation owns observed checks; model units own the remaining interface assessment. */
export const DOCTOR_CHECK_OWNERS: Record<DoctorSourceRequiredCheck, { observed: string[]; review: string }> = {
  "frontend-patch-compatibility": { observed: ["inactive-thread-retention-patch", "accounts-native-patch"], review: "renderer patches and settings injection" },
  "static-asset-integrity": { observed: ["before-source-bytes", "after-source-bytes"], review: "asset references and consumers" },
  "localization-resource-compatibility": { observed: ["before-source-bytes", "after-source-bytes"], review: "locale keys and native menu consumers" },
  "preload-bridge-compatibility": { observed: [], review: "preload APIs and their consumers" },
  "main-process-patch-compatibility": { observed: ["window-services-patch"], review: "main-process hook interactions" },
  "helper-and-desktop-shell-compatibility": { observed: [], review: "helper launch and lifecycle interfaces" },
  "native-module-abi-compatibility": { observed: ["binary-metadata"], review: "native ABI and runtime loading; structural evidence alone is insufficient" },
  "bundled-executable-compatibility": { observed: ["binary-metadata"], review: "executable interfaces and lifecycle; structural evidence alone is insufficient" },
  "plugin-runtime-compatibility": { observed: [], review: "plugin discovery and runtime interfaces" },
  "package-metadata-integrity": { observed: ["before-asar-package-integrity", "after-asar-package-integrity"], review: "package metadata consumers" },
  "backend-version-and-app-server-compatibility": { observed: ["before-backend-protocol-smoke", "after-backend-protocol-smoke", "app-server-schema-contracts", "app-server-adapter-contracts", "app-server-behavior-coverage"], review: "backend adapter interfaces beyond the recorded smoke requests" },
  "generated-app-server-schema-compatibility": { observed: ["app-server-schema-contracts", "app-server-adapter-contracts", "app-server-behavior-coverage"], review: "schema changes and protocol adapter consumers" },
  "asar-integrity-and-package-identity": { observed: ["before-asar-package-integrity", "after-asar-package-integrity"], review: "package integration across changed members" },
};

export interface DoctorReviewDocument {
  id: string;
  changeId: string;
  artifact: ReviewTarget["artifact"];
  side: "before" | "after";
  path: string;
  sha256: DoctorSourceSha256;
  bytes: number;
  kind: "text" | "binary" | "archive" | "missing";
  /** Complete, hash-verified text, retained privately for cross-chunk inspection. */
  file: string | null;
}
export interface DoctorReviewPart {
  documentId: string;
  offset: number;
  bytes: number;
  sha256: DoctorSourceSha256;
}
export interface DoctorReviewUnit {
  id: string;
  kind: "source" | "binary" | "integration";
  area: string;
  ownership: string | null;
  changeIds: string[];
  parts: DoctorReviewPart[];
  documentIds: string[];
  /** An integration decision is made only after every source unit completed. */
  dependsOn: string[];
  requiredChecks: string[];
  implementation?: boolean;
  packageIntegration?: boolean;
}

/** Review all executing JavaScript implementation bytes before assessing upstream changes. */
export function includeDoctorImplementationReview(
  plan: DoctorReviewPlan,
  input: DoctorSourceReviewInput,
  sources: Array<{ path: string; sha256: DoctorSourceSha256; bytes: number }>,
): void {
  const targets: ReviewTarget[] = sources.map(source => ({
    changeId: `implementation-${reviewDigest([source.path, source.sha256]).slice(7)}`,
    artifact: "shipped_file", path: source.path, change: "added", beforeSha256: null, afterSha256: source.sha256,
    area: "main", relevance: "relevant", tweakersOwnership: "Exact executing Tweakers implementation", requiredChecks: [], reason: "Implementation source used by compatibility review",
  }));
  const implementation = prepareDoctorReviewPlan({ ...input, outputRoot: join(input.outputRoot, "implementation"),
    comparison: { ...input.comparison, requiredChecks: [] } }, targets, plan.binding.tweakers, target => readFileSync(target.path));
  plan.blockers.push(...implementation.blockers);
  plan.documents.push(...implementation.documents);
  const units: DoctorReviewUnit[] = implementation.units.map(unit => ({ ...unit, area: "implementation", changeIds: [], implementation: true }));
  const dependedOn = new Set(units.flatMap(unit => unit.dependsOn));
  let roots = units.filter(unit => !dependedOn.has(unit.id));
  while (roots.length > 1) {
    const next: DoctorReviewUnit[] = [];
    for (let index = 0; index < roots.length; index += 8) {
      const children = roots.slice(index, index + 8);
      next.push({ id: reviewDigest(["implementation-integration", children.map(unit => unit.id)]).slice(7),
        kind: "integration", area: "implementation", ownership: "Exact executing Tweakers implementation", changeIds: [],
        documentIds: [], parts: [], dependsOn: children.map(unit => unit.id), requiredChecks: [], implementation: true });
    }
    units.push(...next);
    roots = next;
  }
  if (!roots.length) plan.blockers.push({ changeId: "implementation", path: input.tweakersSourceRoot, reason: "No complete Tweakers implementation units are available." });
  for (const unit of plan.units) unit.dependsOn.push(...roots.map(root => root.id));
  plan.units = [...units, ...plan.units];
  const { fingerprint: _fingerprint, ...payload } = plan;
  plan.fingerprint = reviewDigest(payload);
}
export interface DoctorReviewPlan {
  schemaVersion: 2;
  binding: { before: string; after: string; comparison: string; tweakers: string; protocol: string };
  inventoryCount: number;
  targets: ReviewTarget[];
  documents: DoctorReviewDocument[];
  units: DoctorReviewUnit[];
  blockers: Array<{ changeId: string; path: string; reason: string }>;
  fingerprint: DoctorSourceSha256;
}

export interface DoctorGroupedReviewPlan {
  schemaVersion: 3;
  fingerprint: DoctorSourceSha256;
  groups: Array<{
    id: string;
    changeIds: string[];
    membershipFingerprint: DoctorSourceSha256;
    change: DoctorChangeV1;
    eligible: boolean;
    blockers: string[];
    reasonCodes: Array<"missing_membership" | "invalid_membership" | "opaque_behavior">;
  }>;
  unresolvedChangeIds: string[];
  blockers: string[];
}

/** Model explanations are review outputs, not inputs to regrouping or cache identity. */
export function doctorChangeAnalysisFingerprint(report: DoctorChangeReportV1): DoctorSourceSha256 {
  const { fingerprint: _fingerprint, changelog: _changelog, reviewProgress: _reviewProgress, changes, ...body } = report;
  return reviewDigest({ ...body, changes: changes.map(({ explanation: _explanation, ...change }) => change) });
}

interface OriginalChangeMembership {
  id: string;
  artifact: DoctorSourceChange["artifact"];
  beforePath: string | null;
  afterPath: string | null;
  beforeSha256: DoctorSourceSha256 | null;
  afterSha256: DoctorSourceSha256 | null;
  kind: DoctorSourceChange["change"] | "renamed";
}

/**
 * Maps the complete comparison inventory onto deterministic change-report
 * groups. This planner only establishes evidence membership; it does not read
 * source bytes, invoke a reviewer, or make a compatibility decision.
 */
export function prepareDoctorGroupedReviewPlan(
  report: DoctorChangeReportV1,
  comparison: DoctorSourceComparison,
): DoctorGroupedReviewPlan {
  const originals = [
    ...comparison.changes.map(changeMembership),
    ...comparison.renamedIdenticalArtifacts.map(renameMembership),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const assignments = new Map<number, OriginalChangeMembership[]>();
  const blockersByGroup = new Map<number, string[]>();
  const unresolved = new Set<string>();
  const blockers: string[] = [];

  if (report.comparisonFingerprint !== comparison.fingerprint) {
    blockers.push("The change report does not bind to this comparison fingerprint.");
    for (let index = 0; index < report.changes.length; index += 1) {
      addGroupBlocker(blockersByGroup, index, "The group belongs to a different comparison fingerprint.");
    }
  }

  const duplicateOriginalIds = duplicateValues(originals.map(original => original.id));
  for (const id of duplicateOriginalIds) {
    unresolved.add(id);
    blockers.push(`Comparison change ${id} is duplicated and cannot be assigned exactly once.`);
  }
  const duplicateGroupIds = duplicateValues(report.changes.map(change => change.id));
  for (const id of duplicateGroupIds) {
    blockers.push(`Change-report group ${id} is duplicated.`);
    report.changes.forEach((change, index) => {
      if (change.id === id) addGroupBlocker(blockersByGroup, index, "The change-report group ID is duplicated.");
    });
  }

  const evidenceIndex = new Map<string, Array<{ groupIndex: number; evidenceIndex: number }>>();
  const membershipKey = (artifact: string, side: string, path: string, hash: string) => JSON.stringify([artifact, side, path, hash]);
  report.changes.forEach((change, groupIndex) => change.evidence.forEach((evidence, index) => {
    const paths = evidencePathSides(evidence.path);
    for (const side of ["before", "after"] as const) {
      const hash = side === "before" ? evidence.beforeSha256 : evidence.afterSha256;
      if (hash === null) continue;
      const key = membershipKey(evidence.artifact, side, paths[side], hash);
      const matches = evidenceIndex.get(key) ?? [];
      matches.push({ groupIndex, evidenceIndex: index }); evidenceIndex.set(key, matches);
    }
  }));
  for (const original of originals) {
    if (duplicateOriginalIds.has(original.id)) continue;
    const side = original.beforeSha256 !== null ? "before" : "after";
    const key = membershipKey(original.artifact, side, side === "before" ? original.beforePath! : original.afterPath!,
      side === "before" ? original.beforeSha256! : original.afterSha256!);
    const matches = (evidenceIndex.get(key) ?? []).filter(match =>
      evidenceMatchesOriginal(report.changes[match.groupIndex]!.evidence[match.evidenceIndex]!, original));
    const hasRanges = matches.some(match => {
      const evidence = report.changes[match.groupIndex]!.evidence[match.evidenceIndex]!;
      return evidence.beforeRange != null || evidence.afterRange != null;
    });
    const rangedPartition = matches.length > 0 && ["before", "after"].every(side => {
      const expected = side === "before" ? original.beforeSha256 : original.afterSha256;
      if (expected === null) return true;
      const ranges = matches.map(match => report.changes[match.groupIndex]!.evidence[match.evidenceIndex]![side === "before" ? "beforeRange" : "afterRange"]);
      if (ranges.some(range => !range || !Number.isSafeInteger(range.offset) || range.offset < 0
        || !Number.isSafeInteger(range.bytes) || range.bytes <= 0 || !Number.isSafeInteger(range.offset + range.bytes))) return false;
      const lengths = matches.map(match => report.changes[match.groupIndex]!.evidence[match.evidenceIndex]![side === "before" ? "beforeSourceBytes" : "afterSourceBytes"]);
      const length = lengths[0];
      if (!Number.isSafeInteger(length) || !length || lengths.some(value => value !== length)) return false;
      const sorted = ranges.map(range => range!).sort((a, b) => a.offset - b.offset);
      return sorted[0]!.offset === 0
        && sorted.at(-1)!.offset + sorted.at(-1)!.bytes === length
        && sorted.every((range, index) => index === 0 || sorted[index - 1]!.offset + sorted[index - 1]!.bytes === range.offset);
    });
    if ((matches.length === 1 && !hasRanges) || rangedPartition) {
      for (const match of matches) {
        const members = assignments.get(match.groupIndex) ?? [];
        if (!members.some(member => member.id === original.id)) members.push(original);
        assignments.set(match.groupIndex, members);
      }
      continue;
    }
    unresolved.add(original.id);
    if (matches.length === 0) {
      blockers.push(`Comparison change ${original.id} has no exact change-report evidence match.`);
    } else {
      blockers.push(`Comparison change ${original.id} has ${matches.length} change-report evidence matches and is ambiguous.`);
      for (const match of matches) addGroupBlocker(blockersByGroup, match.groupIndex, `Ambiguous evidence also matches comparison change ${original.id}.`);
    }
  }

  const groups = report.changes.map((change, index) => {
    const members = [...(assignments.get(index) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    const groupBlockers = [...(blockersByGroup.get(index) ?? [])];
    const hasPairedText = change.evidence.some(e => e.beforeSha256 && e.afterSha256
      && /\.(?:[cm]?[jt]sx?|css|json)(?:$| -> )/.test(e.path));
    if (change.status === "unknown" && !hasPairedText) {
      groupBlockers.push("The deterministic change analysis left this group unknown.");
      blockers.push(`Change-report group ${change.id} remains unknown and is not eligible for model review.`);
    }
    if (members.length === 0) {
      groupBlockers.push("No comparison change maps exactly to this change-report group.");
      blockers.push(`Change-report group ${change.id} has no exact comparison membership.`);
    }
    const changeIds = members.map(member => member.id);
    const membershipFingerprint = reviewDigest(members.map(member => ({
      id: member.id,
      artifact: member.artifact,
      kind: member.kind,
      beforePath: member.beforePath,
      afterPath: member.afterPath,
      beforeSha256: member.beforeSha256,
      afterSha256: member.afterSha256,
    })));
    return {
      id: change.id,
      changeIds,
      membershipFingerprint,
      change,
      eligible: groupBlockers.length === 0,
      blockers: [...new Set(groupBlockers)].sort(),
      reasonCodes: [ ...(members.length === 0 ? ["missing_membership" as const] : []), ...(groupBlockers.length && members.length > 0 ? [change.status === "unknown" && !hasPairedText && !(blockersByGroup.get(index)?.length) ? "opaque_behavior" as const : "invalid_membership" as const] : []) ],
    };
  });
  const unresolvedChangeIds = [...unresolved].sort();
  const uniqueBlockers = [...new Set(blockers)].sort();
  const fingerprint = reviewDigest({
    schemaVersion: 3,
    reportFingerprint: doctorChangeAnalysisFingerprint(report),
    comparisonFingerprint: comparison.fingerprint,
    groupedMembership: groups.map(group => ({
      id: group.id,
      changeIds: group.changeIds,
      membershipFingerprint: group.membershipFingerprint,
      eligible: group.eligible,
      blockers: group.blockers,
    })),
    unresolvedChangeIds,
    blockers: uniqueBlockers,
  });
  return { schemaVersion: 3, fingerprint, groups, unresolvedChangeIds, blockers: uniqueBlockers };
}

function changeMembership(change: DoctorSourceChange): OriginalChangeMembership {
  return {
    id: `change-${canonicalDigest({ artifact: change.artifact, path: change.path, change: change.change, before: change.beforeSha256, after: change.afterSha256 }).slice(7)}`,
    artifact: change.artifact,
    beforePath: change.beforeSha256 === null ? null : change.path,
    afterPath: change.afterSha256 === null ? null : change.path,
    beforeSha256: change.beforeSha256,
    afterSha256: change.afterSha256,
    kind: change.change,
  };
}

function renameMembership(rename: DoctorSourceRename): OriginalChangeMembership {
  return {
    id: `change-${canonicalDigest({ artifact: rename.artifact, from: rename.fromPath, to: rename.toPath, change: "renamed", sha256: rename.sha256 }).slice(7)}`,
    artifact: rename.artifact,
    beforePath: rename.fromPath,
    afterPath: rename.toPath,
    beforeSha256: rename.sha256,
    afterSha256: rename.sha256,
    kind: "renamed",
  };
}

function evidenceMatchesOriginal(
  evidence: DoctorChangeV1["evidence"][number],
  original: OriginalChangeMembership,
): boolean {
  if (evidence.artifact !== original.artifact) return false;
  const paths = evidencePathSides(evidence.path);
  if (original.kind === "renamed") {
    return paths.renamed
      && paths.before === original.beforePath
      && paths.after === original.afterPath
      && evidence.beforeSha256 === original.beforeSha256
      && evidence.afterSha256 === original.afterSha256;
  }
  if (original.kind === "modified") {
    return !paths.renamed
      && paths.before === original.beforePath
      && paths.after === original.afterPath
      && evidence.beforeSha256 === original.beforeSha256
      && evidence.afterSha256 === original.afterSha256;
  }
  if (original.kind === "removed") {
    return paths.before === original.beforePath
      && evidence.beforeSha256 === original.beforeSha256
      && ((evidence.afterSha256 === null && !paths.renamed) || (evidence.afterSha256 !== null && paths.renamed));
  }
  return paths.after === original.afterPath
    && evidence.afterSha256 === original.afterSha256
    && ((evidence.beforeSha256 === null && !paths.renamed) || (evidence.beforeSha256 !== null && paths.renamed));
}

function evidencePathSides(path: string): { before: string; after: string; renamed: boolean } {
  const separator = " -> ";
  const split = path.indexOf(separator);
  if (split < 0 || path.indexOf(separator, split + separator.length) >= 0) return { before: path, after: path, renamed: false };
  return { before: path.slice(0, split), after: path.slice(split + separator.length), renamed: true };
}

function addGroupBlocker(blockers: Map<number, string[]>, index: number, blocker: string): void {
  blockers.set(index, [...(blockers.get(index) ?? []), blocker]);
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function canonicalDigest(value: unknown): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Doctor grouped review received a non-JSON value");
}

export function reviewDigest(value: unknown): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * One candidate-pair allowance survives regrouping, model changes, manager
 * rebuilds, and resumed jobs. Exact analysis inputs belong in checkpoint keys,
 * not in the durable spend boundary.
 */
export function doctorReviewBudgetBinding(input: Pick<DoctorSourceReviewInput, "before" | "after">): DoctorSourceSha256 {
  return reviewDigest({ policy: 3, before: input.before.fingerprint, after: input.after.fingerprint });
}
export function reviewBytesDigest(value: Buffer): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Review evidence directory is not owner-private");
}

/** Keep hash-renamed counterparts together without declaring their code equivalent. */
function family(target: ReviewTarget): string {
  const name = target.path.replace(/-[a-f0-9]{8,}(?=\.[cm]?js$)/i, "-<build>")
    .replace(/-[A-Za-z0-9_-]{8}(?=\.[cm]?js$)/, "-<build>");
  return JSON.stringify([target.artifact, target.area, target.tweakersOwnership, name]);
}

export function prepareDoctorReviewPlan(
  input: DoctorSourceReviewInput,
  targets: ReviewTarget[],
  tweakersFingerprint: string,
  read: (target: ReviewTarget, side: "before" | "after") => Buffer,
): DoctorReviewPlan {
  const directory = join(input.outputRoot, "sources");
  exactPrivateDirectory(directory);
  const documents: DoctorReviewDocument[] = [];
  const blockers: DoctorReviewPlan["blockers"] = [];
  const partsByDocument = new Map<string, DoctorReviewPart[]>();
  for (const check of new Set([...input.comparison.requiredChecks, ...targets.flatMap(target => target.requiredChecks)])) {
    if (!Object.hasOwn(DOCTOR_CHECK_OWNERS, check) || !targets.some(target => target.requiredChecks.includes(check))) {
      blockers.push({ changeId: "check-owner", path: check, reason: "A required compatibility check has no mapped validation and review owner." });
    }
  }
  let retainedBytes = 0;
  for (const target of targets) {
    if (target.relevance === "unresolved" || !target.tweakersOwnership) {
      blockers.push({ changeId: target.changeId, path: target.path, reason: "Resolve the affected Tweakers integration owner before model review." });
    }
    for (const side of ["before", "after"] as const) {
      const expected = side === "before" ? target.beforeSha256 : target.afterSha256;
      if (expected === null) continue;
      const path = target.change === "renamed" ? target.path.split(" -> ")[side === "before" ? 0 : 1]! : target.path;
      const document: DoctorReviewDocument = {
        id: `${target.changeId}-${side}`, changeId: target.changeId, artifact: target.artifact, side, path,
        sha256: expected, bytes: 0, kind: "missing", file: null,
      };
      documents.push(document);
      try {
        const bytes = read(target, side);
        if (reviewBytesDigest(bytes) !== expected) throw new Error("Source bytes do not match the recorded SHA-256.");
        document.bytes = bytes.byteLength;
        if (target.artifact === "shipped_file" && path === "Contents/Resources/app.asar") {
          document.kind = "archive";
          continue;
        }
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { document.kind = "binary"; continue; }
        if (text.includes("\u0000")) { document.kind = "binary"; continue; }
        if (bytes.length > MAX_TEXT_BYTES || retainedBytes + bytes.length > MAX_RETAINED_TEXT_BYTES) {
          throw new Error("Complete text exceeds the evidence-storage limit; split collection before review. No partial excerpt was accepted.");
        }
        document.kind = "text";
        document.file = join(directory, expected.slice(7) + ".txt");
        // Content-addressed files permit deduplication, but existing bytes are always rechecked.
        try {
          const stat = lstatSync(document.file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
            || reviewBytesDigest(readFileSync(document.file)) !== expected) throw new Error("Stored source evidence changed.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          writeFileSync(document.file, bytes, { flag: "wx", mode: 0o600 });
        }
        retainedBytes += bytes.length;
        const parts: DoctorReviewPart[] = [];
        for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0);) {
          let end = Math.min(offset + DOCTOR_REVIEW_CHUNK_BYTES, bytes.length);
          // A chunk must be complete UTF-8, including when a multibyte character crosses the bound.
          while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
          const chunk = bytes.subarray(offset, end);
          parts.push({ documentId: document.id, offset, bytes: chunk.length, sha256: reviewBytesDigest(chunk) });
          if (end === bytes.length) break;
          offset = end;
        }
        partsByDocument.set(document.id, parts);
      } catch (error) {
        document.kind = "missing";
        document.file = null;
        blockers.push({ changeId: target.changeId, path, reason: error instanceof Error ? error.message : "Complete source evidence is unavailable." });
      }
    }
  }
  const groups = new Map<string, ReviewTarget[]>();
  for (const target of targets) {
    const key = family(target);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const byChange = new Map<string, DoctorReviewDocument[]>();
  for (const doc of documents) byChange.set(doc.changeId, [...(byChange.get(doc.changeId) ?? []), doc]);
  const units: DoctorReviewUnit[] = [];
  for (const [key, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const docs = members.flatMap(member => byChange.get(member.changeId) ?? []);
    const parts = docs.flatMap(doc => partsByDocument.get(doc.id) ?? []);
    const base = {
      area: members[0]!.area, ownership: members[0]!.tweakersOwnership,
      changeIds: members.map(member => member.changeId),
      documentIds: docs.map(doc => doc.id),
      requiredChecks: [...new Set(members.flatMap(member => member.requiredChecks))].sort(),
    };
    const sourceUnits: DoctorReviewUnit[] = [];
    // Each group has its own budget; a large main bundle cannot starve helpers or later groups.
    for (let index = 0; index < parts.length; index += 2) {
      const selected = parts.slice(index, index + 2);
      sourceUnits.push({ ...base, id: reviewDigest([key, selected]).slice(7), kind: "source", parts: selected, dependsOn: [] });
    }
    if (docs.some(doc => doc.kind === "binary" || doc.kind === "archive")) {
      sourceUnits.push({ ...base, id: reviewDigest([key, "binary", docs.map(doc => doc.sha256)]).slice(7), kind: "binary", parts: [], dependsOn: [] });
    }
    units.push(...sourceUnits);
    // Bounded fan-in also applies to whole-module synthesis; a large bundle cannot
    // produce a single unbounded summary prompt after its source chunks finish.
    let level = sourceUnits;
    while (level.length > 1) {
      const next: DoctorReviewUnit[] = [];
      for (let index = 0; index < level.length; index += 8) {
        const children = level.slice(index, index + 8);
        const unit: DoctorReviewUnit = { ...base, id: reviewDigest([key, "integration", children.map(unit => unit.id)]).slice(7), kind: "integration", parts: [], dependsOn: children.map(unit => unit.id) };
        next.push(unit);
      }
      units.push(...next);
      level = next;
    }
  }
  // Distinct files and ownership areas must also meet in a package-level review.
  if (units.length) {
    const dependedOn = new Set(units.flatMap(unit => unit.dependsOn));
    let roots = units.filter(unit => !dependedOn.has(unit.id));
    do {
      const next: DoctorReviewUnit[] = [];
      for (let index = 0; index < roots.length; index += 8) {
        const children = roots.slice(index, index + 8);
        next.push({ id: reviewDigest(["package-integration", children.map(unit => unit.id)]).slice(7),
          kind: "integration", area: "package_integration", ownership: "Whole-package Tweakers compatibility", changeIds: [],
          documentIds: [], parts: [], dependsOn: children.map(unit => unit.id), requiredChecks: [...new Set(children.flatMap(unit => unit.requiredChecks))], packageIntegration: true });
      }
      units.push(...next); roots = next;
    } while (roots.length > 1);
  }
  const payload = {
    schemaVersion: 2 as const,
    binding: { before: input.before.fingerprint, after: input.after.fingerprint, comparison: input.comparison.fingerprint, tweakers: tweakersFingerprint, protocol: "doctor-bounded-review-v2" },
    inventoryCount: input.comparison.changes.length + input.comparison.renamedIdenticalArtifacts.length,
    targets, documents, units, blockers,
  };
  return { ...payload, fingerprint: reviewDigest(payload) };
}

export function doctorReviewUnitEvidence(plan: DoctorReviewPlan, unit: DoctorReviewUnit): {
  documents: DoctorReviewDocument[]; chunks: Array<DoctorReviewPart & { text: string }>;
} {
  const documents = unit.documentIds.map(id => {
    const doc = plan.documents.find(value => value.id === id);
    if (!doc) throw new Error("Review unit refers to an unknown document");
    return doc;
  });
  const chunks = unit.parts.map(part => {
    const doc = documents.find(value => value.id === part.documentId);
    if (!doc?.file || basename(doc.file) !== `${doc.sha256.slice(7)}.txt`) throw new Error("Review chunk document is unavailable");
    const stat = lstatSync(doc.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || realpathSync(doc.file) !== resolve(doc.file)) throw new Error("Review chunk path changed");
    const all = readFileSync(doc.file);
    if (all.length !== doc.bytes || reviewBytesDigest(all) !== doc.sha256) throw new Error("Review source document changed");
    const bytes = all.subarray(part.offset, part.offset + part.bytes);
    if (bytes.length !== part.bytes || reviewBytesDigest(bytes) !== part.sha256) throw new Error("Review chunk content changed");
    return { ...part, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  });
  return { documents, chunks };
}

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DoctorSourceEvidence, DoctorSourceSha256 } from "./doctor-evidence.js";

/** This comparison is explanatory evidence only; it never establishes compatibility. */
export const DOCTOR_UPSTREAM_ANALYZER_VERSION = 1;
const OWNER = "openai";
const REPOSITORY = "codex";
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPOSITORY}`;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_FILES = 120;
const MAX_PATCH_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const FULL_REVISION = /^[a-f0-9]{40}$/i;
const RELEVANT_PATH = /(?:app[._-]?server|protocol|auth|config|exec)/i;

export interface DoctorBackendRevisionMapping {
  revision: string;
  executableSha256: DoctorSourceSha256;
  versionEvidence: string;
  commitUrl: string;
}

export interface DoctorBackendSourceChange {
  path: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "unknown";
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  /** Immutable GitHub blob URL pinned to the captured official revision. */
  sourceUrl: string;
  patch: string | null;
  patchState: "complete" | "truncated" | "missing";
  patchSha256: DoctorSourceSha256 | null;
  sha256: DoctorSourceSha256;
}

export type DoctorBackendSourceComparison =
  | { status: "not_attempted"; reason: string }
  | {
    schemaVersion: 1;
    status: "unavailable";
    analyzerVersion: number;
    reason: string;
    before: DoctorBackendRevisionMapping | null;
    after: DoctorBackendRevisionMapping | null;
  }
  | {
    schemaVersion: 1;
    status: "verified";
    analyzerVersion: number;
    before: DoctorBackendRevisionMapping;
    after: DoctorBackendRevisionMapping;
    compareUrl: string;
    changes: DoctorBackendSourceChange[];
    comparedFileCount: number;
    truncated: boolean;
    digest: DoctorSourceSha256;
  };

export interface DoctorUpstreamTransportResponse {
  status: number;
  text(): Promise<string>;
}

export interface DoctorUpstreamDependencies {
  fetch(url: string, options: { signal: AbortSignal; headers: Record<string, string> }): Promise<DoctorUpstreamTransportResponse>;
}

const DEFAULT_DEPENDENCIES: DoctorUpstreamDependencies = {
  async fetch(url, options) {
    const response = await fetch(url, options);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("official response exceeds the upstream evidence limit");
    const text = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
    return { status: response.status, text: async () => text };
  },
};

let dependencies: DoctorUpstreamDependencies = DEFAULT_DEPENDENCIES;

/** Test seam for bounded official-source requests. */
export function setDoctorUpstreamDependenciesForTest(replacement: Partial<DoctorUpstreamDependencies>): () => void {
  const previous = dependencies;
  dependencies = { ...DEFAULT_DEPENDENCIES, ...replacement };
  return () => { dependencies = previous; };
}

export async function collectDoctorUpstreamContext(
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
  cacheRoot: string,
): Promise<DoctorBackendSourceComparison> {
  const beforeMapping = revisionMapping(before);
  const afterMapping = revisionMapping(after);
  if (!beforeMapping || !afterMapping) {
    return unavailable("The captured bundled CLI metadata does not contain full immutable official revisions for both sides.", beforeMapping, afterMapping);
  }
  if (!isAbsolute(cacheRoot) || resolve(cacheRoot) !== cacheRoot || !safeCacheRoot(cacheRoot)) {
    return unavailable("The private upstream evidence cache root is not an exact absolute path.", beforeMapping, afterMapping);
  }
  const identity = digest({ analyzerVersion: DOCTOR_UPSTREAM_ANALYZER_VERSION, before: beforeMapping, after: afterMapping });
  const cached = readCached(cacheRoot, identity);
  if (cached) return cached;

  try {
    // GitHub verifies each exact SHA independently before it is retained as source evidence.
    const verifiedBefore = await verifyCommit(beforeMapping);
    const verifiedAfter = await verifyCommit(afterMapping);
    if (!verifiedBefore || !verifiedAfter) {
      return unavailable("The captured full revision is absent from the official openai/codex commit API.", beforeMapping, afterMapping);
    }
    const compareUrl = `${API_ROOT}/compare/${beforeMapping.revision}...${afterMapping.revision}`;
    const compare = await getJson(compareUrl);
    if (!compare || !Array.isArray(compare.files) || !compareBindsRevisions(compare, beforeMapping.revision, afterMapping.revision)) {
      return unavailable("The official GitHub comparison response was unavailable or invalid.", beforeMapping, afterMapping);
    }
    const files = compare.files as unknown[];
    const limited = files.slice(0, MAX_FILES);
    const selected = limited.flatMap(file => parseRelevantFile(file, beforeMapping.revision, afterMapping.revision)).sort((left, right) => left.path.localeCompare(right.path));
    const truncated = files.length > MAX_FILES || files.length >= MAX_FILES || compare.files_truncated === true;
    const body = {
      schemaVersion: 1 as const,
      status: "verified" as const,
      analyzerVersion: DOCTOR_UPSTREAM_ANALYZER_VERSION,
      before: beforeMapping,
      after: afterMapping,
      compareUrl,
      changes: selected,
      comparedFileCount: limited.length,
      truncated,
    };
    const result: DoctorBackendSourceComparison = { ...body, digest: digest(body) };
    writeCached(cacheRoot, identity, result);
    return result;
  } catch (error) {
    return unavailable(`Official upstream comparison unavailable: ${errorMessage(error)}`, beforeMapping, afterMapping);
  }
}

function revisionMapping(evidence: DoctorSourceEvidence): DoctorBackendRevisionMapping | null {
  const versionEvidence = evidence.backend.version;
  if (versionEvidence && /\b(?:custom|dirty|local|dev)\b/i.test(versionEvidence)) return null;
  const revisions = [...(versionEvidence?.matchAll(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/ig) ?? [])].map(match => match[0]!.toLowerCase());
  const revision = revisions.length === 1 ? revisions[0]! : null;
  if (!revision || versionEvidence === null || !FULL_REVISION.test(revision) || evidence.backend.sha256 === null) return null;
  return { revision, executableSha256: evidence.backend.sha256, versionEvidence, commitUrl: `${API_ROOT}/commits/${revision}` };
}

async function verifyCommit(mapping: DoctorBackendRevisionMapping): Promise<boolean> {
  const commit = await getJson(mapping.commitUrl);
  return isRecord(commit) && typeof commit.sha === "string" && commit.sha.toLowerCase() === mapping.revision;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await dependencies.fetch(url, { signal: controller.signal, headers: { accept: "application/vnd.github+json", "user-agent": "Tweakers-Doctor-Upstream" } });
    if (response.status !== 200) return null;
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return null;
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } finally { clearTimeout(timer); }
}

function parseRelevantFile(value: unknown, beforeRevision: string, afterRevision: string): DoctorBackendSourceChange[] {
  if (!isRecord(value) || typeof value.filename !== "string" || !RELEVANT_PATH.test(value.filename)) return [];
  const status = typeof value.status === "string" && ["added", "removed", "modified", "renamed", "copied"].includes(value.status)
    ? value.status as DoctorBackendSourceChange["status"] : "unknown";
  const patch = boundedPatch(value.patch);
  const revision = status === "removed" ? beforeRevision : afterRevision;
  const body = { path: value.filename, status, previousPath: typeof value.previous_filename === "string" ? value.previous_filename : null,
    additions: safeNumber(value.additions), deletions: safeNumber(value.deletions),
    sourceUrl: immutableSourceUrl(revision, value.filename), patch: patch.text, patchState: patch.state,
    patchSha256: patch.text === null ? null : digest(patch.text) };
  return [{ ...body, sha256: digest(body) }];
}

function unavailable(reason: string, before: DoctorBackendRevisionMapping | null, after: DoctorBackendRevisionMapping | null): DoctorBackendSourceComparison {
  return { schemaVersion: 1, status: "unavailable", analyzerVersion: DOCTOR_UPSTREAM_ANALYZER_VERSION, reason, before, after };
}

function readCached(cacheRoot: string, identity: DoctorSourceSha256): DoctorBackendSourceComparison | null {
  try {
    const path = join(cacheRoot, `${identity.slice(7)}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * MAX_RESPONSE_BYTES || (stat.mode & 0o077) !== 0) return null;
    const candidate: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isVerified(candidate)) return null;
    const { digest: savedDigest, ...body } = candidate;
    if (savedDigest !== digest(body) || cacheIdentity(candidate) !== identity) return null;
    return candidate;
  } catch { return null; }
}

function writeCached(cacheRoot: string, identity: DoctorSourceSha256, result: DoctorBackendSourceComparison): void {
  if (result.status !== "verified") return;
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const target = join(cacheRoot, `${identity.slice(7)}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function isVerified(value: unknown): value is Extract<DoctorBackendSourceComparison, { status: "verified" }> {
  return isRecord(value) && value.schemaVersion === 1 && value.status === "verified" && typeof value.digest === "string"
    && isRecord(value.before) && isRecord(value.after) && Array.isArray(value.changes) && value.changes.every(validCachedChange);
}

function cacheIdentity(result: Extract<DoctorBackendSourceComparison, { status: "verified" }>): DoctorSourceSha256 {
  return digest({ analyzerVersion: result.analyzerVersion, before: result.before, after: result.after });
}

function safeCacheRoot(cacheRoot: string): boolean {
  try {
    if (!existsSync(cacheRoot)) return true;
    const stat = lstatSync(cacheRoot);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch { return false; }
}

function compareBindsRevisions(compare: Record<string, unknown>, before: string, after: string): boolean {
  return optionalRevisionMatches(compare, "base_commit", before)
    && optionalRevisionMatches(compare, "head_commit", after)
    && optionalRevisionMatches(compare, "commit", after);
}

function nestedSha(value: unknown): string | null {
  return isRecord(value) && typeof value.sha === "string" && FULL_REVISION.test(value.sha) ? value.sha.toLowerCase() : null;
}

function optionalRevisionMatches(compare: Record<string, unknown>, key: string, expected: string): boolean {
  return compare[key] === undefined || nestedSha(compare[key]) === expected;
}

function validCachedChange(value: unknown): boolean {
  if (!isRecord(value) || typeof value.patchState !== "string") return false;
  if (value.patch === null) return value.patchState === "missing" && value.patchSha256 === null;
  return typeof value.patch === "string" && (value.patchState === "complete" || value.patchState === "truncated")
    && value.patchSha256 === digest(value.patch);
}

function immutableSourceUrl(revision: string, filename: string): string {
  return `https://github.com/${OWNER}/${REPOSITORY}/blob/${revision}/${filename.split("/").map(encodeURIComponent).join("/")}`;
}

function boundedPatch(value: unknown): { text: string | null; state: DoctorBackendSourceChange["patchState"] } {
  if (typeof value !== "string") return { text: null, state: "missing" };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_PATCH_BYTES) return { text: value, state: "complete" };
  return { text: bytes.subarray(0, MAX_PATCH_BYTES).toString("utf8"), state: "truncated" };
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error("official response exceeds the upstream evidence limit");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function digest(value: unknown): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new Error("Upstream evidence is not JSON");
}
function safeNumber(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

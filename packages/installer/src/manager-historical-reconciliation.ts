import { assertIndependentTweakersRuntimeReadyExpectation, assertIndependentTweakersRuntimeReadyReceipt } from "./runtime-ready-receipt.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalManagerJson, type TweakersManagerPreparedOperationV1 } from "./manager-contract.js";
import { isManagerOperationId, parsePreparedOperation } from "./manager-operation-store.js";
import { assertManagerExactObjectKeys, isManagerJsonObject, parseManagerStrictJsonObject } from "./manager-strict-json.js";

/** Physical proof validation and holding the admission locks belong to the issuer. */
export const HISTORICAL_MANAGER_PROOF_NAMES = [
  "terminal-promotion-and-active-linkage", "verified-fallback-and-config",
  "process-and-job-cessation", "all-admission-locks",
] as const;
export type HistoricalManagerProofName = typeof HISTORICAL_MANAGER_PROOF_NAMES[number];
export type HistoricalReconciliationTextRead = { state: "missing" } | { state: "present"; text: string } | { state: "unreadable"; problem: string };
export interface HistoricalManagerObservedOperation { record: TweakersManagerPreparedOperationV1; rawText: string }
export interface HistoricalManagerIssuanceBaseline { activeReceiptSha256: string; fallbackId: string; configSha256: string }
export interface HistoricalManagerReconciliationInput {
  batchId: string;
  createdAt: string;
  operations: HistoricalManagerObservedOperation[];
  evidenceDocuments: { name: HistoricalManagerProofName; rawText: string }[];
  issuanceBaseline: HistoricalManagerIssuanceBaseline;
}
export interface HistoricalManagerReconciliationManifest {
  version: 1; kind: "tweakers-manager-historical-unresolved"; batchId: string; root: string; createdAt: string;
  operationHashes: { operationId: string; rawSha256: string; sidecarSha256: string }[];
  evidenceHashes: { name: HistoricalManagerProofName; sha256: string }[];
  issuanceBaseline: HistoricalManagerIssuanceBaseline;
}
export interface HistoricalManagerReconciliationInspection {
  classifiedOperationIds: string[];
  revision: string;
  evidence: { batchId: string; manifestSha256: string; operationIds: string[]; issuanceBaseline: HistoricalManagerIssuanceBaseline }[];
  problems: string[];
}
const MAX_BYTES = 64 * 1024;
const MAX_OPERATIONS = 64;
const HEX = /^[a-f0-9]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value: unknown) => canonicalManagerJson(value) + "\n";
const base = (root: string) => join(root, "transactions", "manager-historical-reconciliation");
const batch = (root: string, id: string) => join(base(root), "batches", id);
const sidecarPath = (root: string, id: string) => join(base(root), "operations", `${id}.json`);
const originalPath = (root: string, id: string) => join(root, "transactions", "manager-operations", `${id}.json`);
const bindingPath = (root: string, id: string) => join(root, "transactions", "manager-recovery-bindings", `${id}.json`);

/** Does not settle recovery or write the original operation. Publish the completion seal last. */
export function publishHistoricalManagerReconciliation(root: string, input: HistoricalManagerReconciliationInput): { batchId: string; manifestSha256: string } {
  assertRoot(root); assertId(input.batchId); assertTime(input.createdAt); assertBaseline(input.issuanceBaseline);
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MAX_OPERATIONS) throw new Error("Historical operation allowlist is invalid");
  const operations = [...input.operations].sort((a, b) => a.record.operationId.localeCompare(b.record.operationId));
  if (new Set(operations.map(o => o.record.operationId)).size !== operations.length) throw new Error("Historical operation allowlist repeats an identity");
  const writes = new Map<string, string>();
  const operationHashes = operations.map(observed => {
    const record = validateObserved(observed, input.createdAt);
    const original = safeRead(root, originalPath(root, record.operationId));
    if (original.state !== "present" || original.text !== observed.rawText) throw new Error("Historical original operation changed or is unavailable");
    if (safeRead(root, bindingPath(root, record.operationId)).state !== "missing") throw new Error("Historical operation has recovery binding evidence");
    const rawSha256 = digest(observed.rawText);
    const sidecar = json({ version: 1, kind: "tweakers-manager-historical-operation", root, batchId: input.batchId,
      operationId: record.operationId, rawSha256, moduleIdentity: record.moduleIdentity, receiptRefs: record.receiptRefs, outcome: "unknown" });
    writes.set(join(batch(root, input.batchId), "records", `${record.operationId}.json`), observed.rawText);
    writes.set(sidecarPath(root, record.operationId), sidecar);
    return { operationId: record.operationId, rawSha256, sidecarSha256: digest(sidecar) };
  });
  if (!Array.isArray(input.evidenceDocuments) || input.evidenceDocuments.length !== HISTORICAL_MANAGER_PROOF_NAMES.length) throw new Error("Historical proof documents are incomplete");
  const evidenceHashes = HISTORICAL_MANAGER_PROOF_NAMES.map(name => {
    const matches = input.evidenceDocuments.filter(document => document.name === name);
    if (matches.length !== 1) throw new Error("Historical proof documents repeat or omit a required name");
    const rawText = matches[0]!.rawText; validateProof(rawText);
    writes.set(join(batch(root, input.batchId), "evidence", `${name}.json`), rawText);
    return { name, sha256: digest(rawText) };
  });
  const manifest: HistoricalManagerReconciliationManifest = { version: 1, kind: "tweakers-manager-historical-unresolved",
    batchId: input.batchId, root, createdAt: input.createdAt, operationHashes, evidenceHashes, issuanceBaseline: input.issuanceBaseline };
  const manifestText = json(manifest), manifestSha256 = digest(manifestText);
  writes.set(join(batch(root, input.batchId), "manifest.json"), manifestText);
  const sealPath = join(batch(root, input.batchId), "complete.json");
  const seal = json({ version: 1, kind: "tweakers-manager-historical-completion", batchId: input.batchId, manifestSha256 });
  // Refuse mismatches before publishing any member of a new or resumed batch.
  for (const [path, text] of [...writes, [sealPath, seal] as [string, string]]) {
    assertBounded(text); const existing = safeRead(root, path);
    if (existing.state === "unreadable" || existing.state === "present" && existing.text !== text) throw new Error("Historical evidence is unsafe or immutable bytes differ");
  }
  for (const [path, text] of writes) immutableWrite(root, path, text);
  // Recheck the original inputs after evidence publication and before completion.
  for (const observed of operations) {
    const current = safeRead(root, originalPath(root, observed.record.operationId));
    if (current.state !== "present" || current.text !== observed.rawText || safeRead(root, bindingPath(root, observed.record.operationId)).state !== "missing") throw new Error("Historical operation drifted before completion");
  }
  immutableWrite(root, sealPath, seal);
  return { batchId: input.batchId, manifestSha256 };
}

/** Read-only. A single changed member invalidates the entire batch. Live-generation changes are irrelevant. */
export function inspectHistoricalManagerReconciliation(root: string, observedOperations: HistoricalManagerObservedOperation[], dependencies: {
  readText?: (path: string) => HistoricalReconciliationTextRead;
  readDirectory?: (path: string) => { state: "missing" } | { state: "present"; entries: readonly string[] } | { state: "unreadable"; problem: string };
} = {}): HistoricalManagerReconciliationInspection {
  assertRoot(root);
  // Existing installations without reconciliation evidence retain their old
  // status behavior, including callers using an OS path alias for a test root.
  if (!dependencies.readText) {
    try { lstatSync(base(root)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { classifiedOperationIds: [], revision: "missing", evidence: [], problems: [] };
      return { classifiedOperationIds: [], revision: "unreadable", evidence: [], problems: ["Historical evidence root is unreadable"] };
    }
  }
  const reads = new Map<string, string>();
  const read = (path: string): HistoricalReconciliationTextRead => {
    let result: HistoricalReconciliationTextRead;
    try { result = dependencies.readText ? dependencies.readText(path) : safeRead(root, path); }
    catch { result = { state: "unreadable", problem: "Historical evidence read failed" }; }
    if (result.state === "present" && Buffer.byteLength(result.text, "utf8") > MAX_BYTES) result = { state: "unreadable", problem: "Historical evidence exceeds its read limit" };
    reads.set(path, result.state === "present" ? digest(result.text) : result.state);
    return result;
  };
  const required = (path: string): string => { const result = read(path); if (result.state !== "present") throw new Error("Historical evidence is missing or unreadable"); return result.text; };
  const observed = new Map<string, HistoricalManagerObservedOperation>();
  const problems: string[] = [], batchIds = new Set<string>();
  for (const operation of observedOperations) {
    try {
      const id = operation.record.operationId; assertId(id);
      if (observed.has(id)) throw new Error("Historical observation repeats an identity");
      assertBounded(operation.rawText);
      observed.set(id, operation); reads.set(`observed:${id}`, digest(json({ rawSha256: digest(operation.rawText), record: operation.record })));
      const result = read(sidecarPath(root, id));
      if (result.state === "missing") continue;
      if (result.state !== "present") throw new Error("Historical sidecar is unreadable");
      const sidecar = parseSidecar(result.text, root, id); batchIds.add(String(sidecar.batchId));
    } catch { problems.push("Historical operation observation or sidecar is invalid"); }
  }
  // Discover preserved batches independently of current originals. Deleting an
  // original or an entire operation directory must never erase its guard.
  for (const [path, type] of [[join(base(root), "operations"), "operations"], [join(base(root), "batches"), "batches"]] as const) {
    try {
      let names: readonly string[];
      if (dependencies.readDirectory) {
        const result = dependencies.readDirectory(path);
        if (result.state === "missing") continue;
        if (result.state !== "present") throw new Error("Historical inventory unreadable");
        names = result.entries;
      } else {
        try { safeDirectory(path, true); names = readdirSync(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      }
      if (names.length > MAX_OPERATIONS) throw new Error("Historical inventory exceeds limit");
      reads.set(`inventory:${path}`, digest(json([...names].sort())));
      for (const name of names) {
        if (type === "operations") {
          if (!name.endsWith(".json")) throw new Error("Historical sidecar filename invalid");
          const id = name.slice(0, -5); assertId(id);
          if (!observed.has(id)) throw new Error("Historical original disappeared");
        } else { assertId(name); batchIds.add(name); }
      }
    } catch { problems.push("Historical evidence inventory is invalid or an original is missing"); }
  }
  const evidence: HistoricalManagerReconciliationInspection["evidence"] = [];
  for (const batchId of [...batchIds].sort()) {
    try {
      const dir = batch(root, batchId), manifestText = required(join(dir, "manifest.json"));
      const manifest = parseManifest(manifestText, root, batchId);
      const manifestSha256 = digest(manifestText), seal = parse(required(join(dir, "complete.json")));
      exact(seal, ["version", "kind", "batchId", "manifestSha256"]);
      if (seal.version !== 1 || seal.kind !== "tweakers-manager-historical-completion" || seal.batchId !== batchId || seal.manifestSha256 !== manifestSha256) throw new Error("Historical completion seal is invalid");
      for (const entry of manifest.operationHashes) {
        const member = observed.get(entry.operationId);
        if (!member) throw new Error("Historical batch member is absent from current observations");
        const record = validateObserved(member, manifest.createdAt);
        const retained = required(join(dir, "records", `${entry.operationId}.json`));
        if (digest(retained) !== entry.rawSha256 || retained !== member.rawText || required(originalPath(root, entry.operationId)) !== retained) throw new Error("Historical raw operation drifted");
        const text = required(sidecarPath(root, entry.operationId)), sidecar = parseSidecar(text, root, entry.operationId);
        if (digest(text) !== entry.sidecarSha256 || sidecar.batchId !== batchId || sidecar.rawSha256 !== entry.rawSha256
          || canonicalManagerJson(sidecar.moduleIdentity) !== canonicalManagerJson(record.moduleIdentity)
          || canonicalManagerJson(sidecar.receiptRefs) !== canonicalManagerJson(record.receiptRefs)) throw new Error("Historical sidecar identity drifted");
        if (read(bindingPath(root, entry.operationId)).state !== "missing") throw new Error("Historical operation gained recovery evidence");
      }
      for (const filename of ["runtime-ready-expectation.json", "runtime-ready.json"]) {
        const live = read(join(root, "variants", "tweakers", filename));
        if (live.state === "unreadable") throw new Error("Current publication evidence is unreadable");
        if (live.state === "present") {
          const receipt = parse(live.text);
          if (filename === "runtime-ready-expectation.json") assertIndependentTweakersRuntimeReadyExpectation(receipt);
          else assertIndependentTweakersRuntimeReadyReceipt(receipt);
          if (manifest.operationHashes.some(entry => entry.operationId === receipt.operationId)) {
            throw new Error("Historical operation has current publication evidence");
          }
        }
      }
      for (const document of manifest.evidenceHashes) {
        const text = required(join(dir, "evidence", `${document.name}.json`));
        validateProof(text); if (digest(text) !== document.sha256) throw new Error("Historical proof bytes drifted");
      }
      evidence.push({ batchId, manifestSha256, operationIds: manifest.operationHashes.map(entry => entry.operationId), issuanceBaseline: manifest.issuanceBaseline });
    } catch { problems.push(`Historical batch ${batchId} is incomplete, invalid, or changed`); }
  }
  return { classifiedOperationIds: evidence.flatMap(item => item.operationIds).sort(),
    revision: `sha256:${digest(json([...reads].sort(([a], [b]) => a.localeCompare(b))))}`, evidence, problems };
}

function validateObserved(observed: HistoricalManagerObservedOperation, classifiedAt: string): TweakersManagerPreparedOperationV1 {
  assertTime(classifiedAt); validateProof(observed.rawText);
  const record = parsePreparedOperation(parse(observed.rawText), observed.record.operationId);
  if (canonicalManagerJson(record) !== canonicalManagerJson(observed.record) || record.actionId !== "refresh.independent"
    || record.phase !== "recovery-required" || record.consumedAt === null || record.recoveryRequiredAt === null || !record.error) throw new Error("Historical operation is not eligible");
  const created = Date.parse(record.createdAt), consumed = Date.parse(record.consumedAt), recovered = Date.parse(record.recoveryRequiredAt), classified = Date.parse(classifiedAt);
  if (!(created <= consumed && consumed <= recovered && recovered <= classified)) throw new Error("Historical operation chronology is invalid");
  if (record.timing) for (const phase of Object.values(record.timing.phases)) {
    for (const time of [phase.startedAt, phase.completedAt]) if (time !== null && (Date.parse(time) < consumed || Date.parse(time) > recovered)) throw new Error("Historical timing chronology is invalid");
    if (phase.startedAt !== null && phase.completedAt !== null && Date.parse(phase.startedAt) > Date.parse(phase.completedAt)) throw new Error("Historical timing chronology is invalid");
  }
  return record;
}
function parseManifest(text: string, root: string, batchId: string): HistoricalManagerReconciliationManifest {
  const value = parse(text); exact(value, ["version", "kind", "batchId", "root", "createdAt", "operationHashes", "evidenceHashes", "issuanceBaseline"]);
  if (value.version !== 1 || value.kind !== "tweakers-manager-historical-unresolved" || value.batchId !== batchId || value.root !== root) throw new Error("Historical manifest identity is invalid");
  assertTime(value.createdAt); assertBaseline(value.issuanceBaseline);
  if (!Array.isArray(value.operationHashes) || value.operationHashes.length === 0 || value.operationHashes.length > MAX_OPERATIONS) throw new Error("Historical operation hashes are invalid");
  const ids = new Set<string>();
  for (const entry of value.operationHashes) {
    if (!isManagerJsonObject(entry)) throw new Error("Historical operation hash is invalid");
    exact(entry, ["operationId", "rawSha256", "sidecarSha256"]); assertId(entry.operationId); assertHash(entry.rawSha256); assertHash(entry.sidecarSha256);
    if (ids.has(String(entry.operationId))) throw new Error("Historical operation hash repeats an identity"); ids.add(String(entry.operationId));
  }
  if (!Array.isArray(value.evidenceHashes) || value.evidenceHashes.length !== HISTORICAL_MANAGER_PROOF_NAMES.length) throw new Error("Historical proof hashes are invalid");
  for (const [index, entry] of value.evidenceHashes.entries()) {
    if (!isManagerJsonObject(entry)) throw new Error("Historical proof hash is invalid");
    exact(entry, ["name", "sha256"]); if (entry.name !== HISTORICAL_MANAGER_PROOF_NAMES[index]) throw new Error("Historical proof names are invalid"); assertHash(entry.sha256);
  }
  return value as unknown as HistoricalManagerReconciliationManifest;
}
function parseSidecar(text: string, root: string, operationId: string): Record<string, unknown> {
  const value = parse(text); exact(value, ["version", "kind", "root", "batchId", "operationId", "rawSha256", "moduleIdentity", "receiptRefs", "outcome"]);
  if (value.version !== 1 || value.kind !== "tweakers-manager-historical-operation" || value.root !== root || value.operationId !== operationId || value.outcome !== "unknown") throw new Error("Historical sidecar identity is invalid");
  assertId(value.batchId); assertHash(value.rawSha256); return value;
}
function assertBaseline(value: unknown): asserts value is HistoricalManagerIssuanceBaseline {
  if (!isManagerJsonObject(value)) throw new Error("Historical issuance baseline is invalid");
  exact(value, ["activeReceiptSha256", "fallbackId", "configSha256"]); assertHash(value.activeReceiptSha256); assertHash(value.configSha256); assertId(value.fallbackId);
}
function validateProof(text: string): void {
  const value = parse(text);
  const visit = (item: unknown, depth: number): void => {
    if (depth > 16) throw new Error("Historical proof nesting exceeds its limit");
    if (typeof item === "string" && /\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(item)) throw new Error("Historical proof must be redacted");
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (/^(password|secret|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|cookie)$/i.test(key) && child !== null && child !== "[REDACTED]") throw new Error("Historical proof must be redacted");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
function parse(text: string): Record<string, unknown> {
  assertBounded(text);
  return parseManagerStrictJsonObject(Buffer.from(text, "utf8"), { maxBytes: MAX_BYTES, label: "Historical evidence" });
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void { assertManagerExactObjectKeys(value, keys, "Historical evidence"); }
function assertHash(value: unknown): void { if (typeof value !== "string" || !HEX.test(value)) throw new Error("Historical SHA256 is invalid"); }
function assertId(value: unknown): asserts value is string { if (typeof value !== "string" || !isManagerOperationId(value)) throw new Error("Historical identity is invalid"); }
function assertTime(value: unknown): asserts value is string { if (typeof value !== "string" || !TIME.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Historical timestamp is invalid"); }
function assertRoot(root: string): void { if (root !== resolve(root) || !root.startsWith("/") || root === "/") throw new Error("Historical root must be an exact absolute path"); }
function assertBounded(text: string): void {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES || Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("Historical evidence exceeds its byte limit or is invalid UTF-8");
}
function safeDirectory(path: string, privateDirectory = false): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid?.() || (stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) throw new Error("Historical parent path is unsafe");
}
function parents(root: string, path: string, create = false): void {
  assertRoot(root); if (!path.startsWith(root + "/")) throw new Error("Historical path escapes root");
  safeDirectory(root);
  let current = root;
  for (const part of dirname(path).slice(root.length + 1).split("/")) {
    current = join(current, part);
    if (create) { try { mkdirSync(current, { mode: 0o700 }); fsyncDir(dirname(current)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    safeDirectory(current, current === base(root) || current.startsWith(base(root) + "/"));
  }
}
function safeRead(root: string, path: string): HistoricalReconciliationTextRead {
  let fd: number | undefined;
  try {
    parents(root, path);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error("Historical file is unsafe");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new Error("Historical file changed during read");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.nlink !== 1 || after.uid !== process.getuid?.() || (after.mode & 0o077) !== 0) throw new Error("Historical file changed during read");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); assertBounded(text); return { state: "present", text };
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable", problem: "Historical path is unsafe or unreadable" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function fsyncDir(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function immutableWrite(root: string, path: string, text: string): void {
  parents(root, path, true);
  const existing = safeRead(root, path);
  if (existing.state === "present" && existing.text === text) return;
  if (existing.state !== "missing") throw new Error("Historical evidence immutable bytes differ or path is unsafe");
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, path);
  }
  catch (error) {
    const raced = safeRead(root, path);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || raced.state !== "present" || raced.text !== text) throw error;
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fsyncDir(dirname(path));
  }
}

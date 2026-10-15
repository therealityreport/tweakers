import type { AcceptedBackendTransitionContractDependencies, AcceptedTransitionSignatureV1 } from "./accepted-backend-transition-contract.js";

/** Serialized, pure contracts. Filesystem custody and signatures are checked by the caller. */
export interface AcceptedRuntimeRepairFileRefV1 { path: string; sha256: string }
export interface AcceptedRuntimeRepairOriginSnapshotV1 {
  sourcePath: string; sourceSha256AtCapture: string; snapshot: AcceptedRuntimeRepairFileRefV1;
}
export interface AcceptedRuntimeRepairAcceptanceSourceV1 {
  version: 1; kind: "tweakers-accepted-runtime-repair-acceptance-source";
  sourcePath: string; sourceSha256AtCapture: string; snapshot: AcceptedRuntimeRepairFileRefV1;
}
export interface AcceptedRuntimeRepairConsumedApprovalV1 {
  version: 1; kind: "tweakers-doctor-runtime-repair-approval";
  operationId: string; repairId: string; jobId: string; reportFingerprint: string;
  authoritySha256: string; workerGenerationId: string; promotionFingerprint: string;
  approvedAt: string; expiresAt: string;
}
export interface AcceptedRuntimeRepairGenerationV1 { kind: "file" | "directory"; mode: number; sha256: string }
export interface AcceptedRuntimeRepairRuntimeAuthorityV1 {
  sourceRoot: string; fingerprint: string; fileCount: number; documentSha256: string;
}
export interface AcceptedRuntimeRepairWorkerCustodyV1 {
  generationId: string; launcherPath: string; launcherSha256: string; sealSha256: string;
  nodePath: string; nodeSha256: string;
  implementationScopes: { version: 1; construction: string; verification: string; promotion: string; payload: string };
}
export interface AcceptedRuntimeRepairReadyBindingV1 {
  repairId: string; headSha256: string; intentSha256: string; authorityReceiptSha256: string;
}
export interface AcceptedRuntimeRepairOriginalCustodyV1 {
  version: 1; kind: "tweakers-accepted-runtime-repair-original-custody";
  operationId: string; promotionId: string; trustedLeafSha1: string;
  originalWorker: AcceptedRuntimeRepairWorkerCustodyV1;
  originalCandidateReceipt: {
    bundlePath: string; bundleGeneration: AcceptedRuntimeRepairGenerationV1;
    json: AcceptedRuntimeRepairFileRefV1; id: string; signingIdentityHash: string;
  };
  unchanged: {
    app: AcceptedRuntimeRepairGenerationV1; tweaks: AcceptedRuntimeRepairGenerationV1;
    state: AcceptedRuntimeRepairGenerationV1; config: AcceptedRuntimeRepairGenerationV1;
    priorActiveReceipt: AcceptedRuntimeRepairGenerationV1;
  };
  originalAcceptedBaseline: AcceptedRuntimeRepairRuntimeAuthorityV1;
  priorRuntime: AcceptedRuntimeRepairGenerationV1;
}
export interface AcceptedRuntimeRepairHeadV1 {
  version: 1; kind: "tweakers-accepted-runtime-repair-head";
  operationId: string; promotionId: string; repairId: string; intentSha256: string; prior: null;
}
export interface DoctorRuntimeRepairAuthorityV1 {
  version: 1; kind: "tweakers-doctor-accepted-runtime-repair";
  operationId: string; promotionId: string; repairId: string; expectedPriorHeadSha256: null;
  originals: {
    operation: AcceptedRuntimeRepairOriginSnapshotV1; recoveryBinding: AcceptedRuntimeRepairFileRefV1;
    journal: AcceptedRuntimeRepairOriginSnapshotV1; expectation: AcceptedRuntimeRepairOriginSnapshotV1;
    preparedCasIntent: AcceptedRuntimeRepairFileRefV1; custody: AcceptedRuntimeRepairFileRefV1;
    acceptedBuildReceipt: AcceptedRuntimeRepairFileRefV1;
  };
  completedCas: {
    planFingerprint: string; prior: AcceptedRuntimeRepairFileRefV1; completed: AcceptedRuntimeRepairFileRefV1;
    currentRegistration: AcceptedRuntimeRepairFileRefV1; resolverSha256: string;
  };
  originalWorker: AcceptedRuntimeRepairWorkerCustodyV1; authorizedWorker: AcceptedRuntimeRepairWorkerCustodyV1;
  review: {
    jobId: string; reportFingerprint: string; validationFingerprint: string; candidateFingerprint: string;
    adoptionFingerprint: string; promotionFingerprint: string;
  };
  originalTrustedLeafSha1: string;
  unchanged: {
    app: AcceptedRuntimeRepairGenerationV1; backendSha256: string; helperSha256: string;
    backendSignature: AcceptedTransitionSignatureV1; helperSignature: AcceptedTransitionSignatureV1;
    resources: readonly { relativePath: string; sourcePath: string; sha256: string }[];
    tweaks: AcceptedRuntimeRepairGenerationV1; state: AcceptedRuntimeRepairGenerationV1;
    config: AcceptedRuntimeRepairGenerationV1; priorActiveReceipt: AcceptedRuntimeRepairGenerationV1;
  };
  priorRuntime: AcceptedRuntimeRepairGenerationV1;
  originalAcceptedBaseline: AcceptedRuntimeRepairRuntimeAuthorityV1;
  repairedBaseline: AcceptedRuntimeRepairRuntimeAuthorityV1;
  repairedRuntime: { generation: AcceptedRuntimeRepairGenerationV1; evidence: AcceptedRuntimeRepairRuntimeAuthorityV1 };
  recovery: { root: string; generation: AcceptedRuntimeRepairGenerationV1; markerSha256: string; validationSha256: string };
  sourceDelta: {
    originalSourceVerification: AcceptedRuntimeRepairFileRefV1; repairedSourceVerification: AcceptedRuntimeRepairFileRefV1;
    reviewedDelta: AcceptedRuntimeRepairFileRefV1; changedGeneratedFiles: readonly AcceptedRuntimeRepairFileRefV1[];
  };
  createdAt: string;
}
export interface AcceptedRuntimeRepairIntentV1 {
  version: 1; kind: "tweakers-accepted-runtime-repair-intent";
  operationId: string; promotionId: string; repairId: string; prior: null;
  authority: DoctorRuntimeRepairAuthorityV1;
  authorityReceipt: { bundleGeneration: AcceptedRuntimeRepairGenerationV1; jsonSha256: string };
  consumedApproval: AcceptedRuntimeRepairFileRefV1; effectiveJournal: AcceptedRuntimeRepairFileRefV1;
  effectiveActiveReceipt: AcceptedRuntimeRepairFileRefV1; createdAt: string;
}
export interface AcceptedRuntimeRepairPredecessorV1 {
  repairId: string; headSha256: string; intentSha256: string; authorityReceiptSha256: string;
}
export type AcceptedRuntimeRepairHeadV2 = Omit<AcceptedRuntimeRepairHeadV1, "version" | "prior"> & {
  version: 2; prior: AcceptedRuntimeRepairPredecessorV1;
};
export type DoctorRuntimeRepairAuthorityV2 = Omit<DoctorRuntimeRepairAuthorityV1, "version" | "expectedPriorHeadSha256"> & {
  version: 2; expectedPriorHeadSha256: string;
  predecessor: { binding: AcceptedRuntimeRepairPredecessorV1; publication: AcceptedRuntimeRepairFileRefV1;
    challenge: AcceptedRuntimeRepairOriginSnapshotV1; installedRuntime: AcceptedRuntimeRepairGenerationV1 };
};
export type AcceptedRuntimeRepairIntentV2 = Omit<AcceptedRuntimeRepairIntentV1, "version" | "prior" | "authority"> & {
  version: 2; prior: AcceptedRuntimeRepairPredecessorV1; authority: DoctorRuntimeRepairAuthorityV2;
};
export type AcceptedRuntimeRepairHead = AcceptedRuntimeRepairHeadV1 | AcceptedRuntimeRepairHeadV2;
export type DoctorRuntimeRepairAuthority = DoctorRuntimeRepairAuthorityV1 | DoctorRuntimeRepairAuthorityV2;
export type AcceptedRuntimeRepairIntent = AcceptedRuntimeRepairIntentV1 | AcceptedRuntimeRepairIntentV2;
const predecessor: Check = value => { record(value, {repairId: uuid, headSha256: hash, intentSha256: hash, authorityReceiptSha256: hash}); };
export const ACCEPTED_RUNTIME_REPAIR_PHASES = [
  "prepared", "runtime:archive-planned", "runtime:archived", "runtime:promote-planned", "runtime:promoted",
  "challenge:published", "acceptance:verified", "active:archive-planned", "active:archived",
  "active:promote-planned", "active:promoted", "committed",
] as const;
export interface AcceptedRuntimeRepairPublicationV1 {
  version: 1; kind: "tweakers-accepted-runtime-repair-publication";
  operationId: string; promotionId: string; repairId: string; intentSha256: string;
  phase: typeof ACCEPTED_RUNTIME_REPAIR_PHASES[number];
}

type Value = Record<string, unknown>;
type Check = (value: unknown) => void;
function requireContract(condition: unknown): asserts condition {
  if (!condition) throw new Error("Accepted runtime repair contract is invalid");
}
function record(value: unknown, shape: Record<string, Check>): Value {
  requireContract(value !== null && typeof value === "object" && !Array.isArray(value));
  requireContract(Object.keys(value).sort().join("\0") === Object.keys(shape).sort().join("\0"));
  const result = value as Value;
  for (const [key, check] of Object.entries(shape)) check(result[key]);
  return result;
}
const literal = (wanted: unknown): Check => value => requireContract(value === wanted);
const hash: Check = value => requireContract(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
const fingerprint: Check = value => requireContract(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value));
const uuid: Check = value => requireContract(typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value));
const boundedText = (max: number): Check => value => requireContract(typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"));
const timestamp: Check = value => requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
const generation: Check = value => { record(value, {
  kind: item => requireContract(item === "file" || item === "directory"),
  mode: item => requireContract(Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 0o777), sha256: hash,
}); };
const signature: Check = value => { record(value, {
  identity: boundedText(1024), teamIdentifier: item => { if (item !== null) boundedText(256)(item); },
  designatedRequirement: item => { if (item !== null) boundedText(4096)(item); },
}); };
function checks(deps: AcceptedBackendTransitionContractDependencies) {
  const path: Check = value => { boundedText(4096)(value); requireContract(deps.isCanonicalAbsolutePath(value as string)); };
  const file: Check = value => { record(value, { path, sha256: hash }); };
  const origin: Check = value => { record(value, { sourcePath: path, sourceSha256AtCapture: hash, snapshot: file }); };
  const runtime: Check = value => { record(value, {
    sourceRoot: path, fingerprint: hash, documentSha256: hash,
    fileCount: item => requireContract(Number.isSafeInteger(item) && Number(item) > 0),
  }); };
  const worker: Check = value => { record(value, {
    generationId: hash, launcherPath: path, launcherSha256: hash, sealSha256: hash, nodePath: path, nodeSha256: hash,
    implementationScopes: item => { record(item, { version: literal(1), construction: fingerprint, verification: fingerprint, promotion: fingerprint, payload: fingerprint }); },
  }); };
  const resources: Check = value => {
    requireContract(Array.isArray(value) && value.length <= 1024);
    const seen = new Set<string>();
    for (const item of value) {
      const resource = record(item, { relativePath: boundedText(4096), sourcePath: path, sha256: hash });
      const name = resource.relativePath as string;
      requireContract(!name.includes("\\") && name.split("/").every(part => part !== "" && part !== "." && part !== "..")
        && !["codex", "codex-code-mode-host", "app.asar", "tweakers"].includes(name.split("/")[0]!) && !seen.has(name));
      seen.add(name);
    }
  };
  return { path, file, origin, runtime, worker, resources };
}
export function assertAcceptedRuntimeRepairReadyBindingContract(value: unknown): asserts value is AcceptedRuntimeRepairReadyBindingV1 {
  record(value, { repairId: uuid, headSha256: hash, intentSha256: hash, authorityReceiptSha256: hash });
}
/** The caller still validates the readiness record's remaining known fields. */
export function assertAcceptedRuntimeRepairReadinessVersionContract<T>(value: T): asserts value is T & Record<string, unknown> & (
  { schemaVersion: 5; runtimeRepair?: never } | { schemaVersion: 6; runtimeRepair: AcceptedRuntimeRepairReadyBindingV1 }) {
  requireContract(value !== null && typeof value === "object" && !Array.isArray(value));
  const item = value as Value;
  if (item.schemaVersion === 5) requireContract(!Object.hasOwn(item, "runtimeRepair"));
  else {
    requireContract(item.schemaVersion === 6 && Object.hasOwn(item, "runtimeRepair"));
    assertAcceptedRuntimeRepairReadyBindingContract(item.runtimeRepair);
  }
}
/** Shared by the real runtime receipt producer and focused protocol cases. */
export function acceptedRuntimeRepairReadinessFields(value: unknown):
  { schemaVersion: 5 } | { schemaVersion: 6; runtimeRepair: AcceptedRuntimeRepairReadyBindingV1 } {
  assertAcceptedRuntimeRepairReadinessVersionContract(value);
  if (value.schemaVersion === 5) return { schemaVersion: 5 };
  return { schemaVersion: 6, runtimeRepair: { ...value.runtimeRepair } };
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  requireContract(value !== undefined && typeof value === "object");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Value)[key])}`).join(",")}}`;
}
/** JSON.parse accepts repeated keys. Durable repair authority must not. */
export function parseAcceptedRuntimeRepairJson(text: string): unknown {
  requireContract(typeof text === "string" && text.length <= 32 * 1024 * 1024);
  const parsed: unknown = JSON.parse(text);
  let offset = 0, nodes = 0;
  const whitespace = (): void => { while (/[\x20\t\r\n]/.test(text[offset] ?? "!")) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === "\\") offset++;
      else if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error("Accepted runtime repair JSON string is incomplete");
  };
  const value = (depth: number): void => {
    requireContract(depth <= 128 && ++nodes <= 100_000); whitespace();
    const first = text[offset];
    if (first === "{") {
      offset++; whitespace(); const keys = new Set<string>();
      if (text[offset] === "}") { offset++; return; }
      for (;;) {
        requireContract(text[offset] === '"'); const key = string(); requireContract(!keys.has(key)); keys.add(key);
        whitespace(); requireContract(text[offset++] === ":"); value(depth + 1); whitespace();
        if (text[offset] === "}") { offset++; return; }
        requireContract(text[offset++] === ","); whitespace();
      }
    }
    if (first === "[") {
      offset++; whitespace(); if (text[offset] === "]") { offset++; return; }
      for (;;) { value(depth + 1); whitespace(); if (text[offset] === "]") { offset++; return; } requireContract(text[offset++] === ","); }
    }
    if (first === '"') { string(); return; }
    const start = offset; while (offset < text.length && !/[\x20\t\r\n,}\]]/.test(text[offset]!)) offset++;
    requireContract(offset > start);
    const scalar = JSON.parse(text.slice(start, offset)) as unknown;
    requireContract(typeof scalar !== "number" || Number.isFinite(scalar));
  };
  value(0); whitespace(); requireContract(offset === text.length); return parsed;
}
/** Preserve every original operation field except the maintained final settlement projection. */
export function assertAcceptedRuntimeRepairOriginalOperationProjection(snapshot: unknown, current: unknown): void {
  requireContract(snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
    && current !== null && typeof current === "object" && !Array.isArray(current));
  const before = snapshot as Value, after = current as Value;
  requireContract(before.phase === "recovery-required" && before.actionId === "refresh.independent"
    && typeof before.consumedAt === "string" && typeof before.recoveryRequiredAt === "string"
    && Number.isFinite(Date.parse(before.recoveryRequiredAt)));
  timestamp(before.consumedAt); timestamp(before.recoveryRequiredAt);
  requireContract(Date.parse(before.recoveryRequiredAt as string) >= Date.parse(before.consumedAt as string));
  if (after.phase === "recovery-required") requireContract(canonicalJson(before) === canonicalJson(after));
  else {
    timestamp(after.completedAt);
    requireContract(after.phase === "completed" && after.cancelledAt === null && after.failedAt === null
      && after.recoveryRequiredAt === null && after.outcome === "verified-installation-accepted" && after.error === null
      && Date.parse(after.completedAt as string) >= Date.parse(before.recoveryRequiredAt));
    requireContract(canonicalJson(after) === canonicalJson({ ...before, phase: "completed", cancelledAt: null,
      completedAt: after.completedAt, failedAt: null, recoveryRequiredAt: null, outcome: "verified-installation-accepted", error: null }));
  }
}

/** A signed supersession preserves failure evidence and never grants acceptance. */
export function supersededNativeReplacementOperationProjection(snapshot: unknown, at: string): Record<string, unknown> {
  requireContract(snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot));
  const before = snapshot as Value;
  requireContract(before.phase === "recovery-required" && before.actionId === "refresh.independent");
  timestamp(before.consumedAt); timestamp(before.recoveryRequiredAt); timestamp(at);
  requireContract(Date.parse(before.recoveryRequiredAt as string) >= Date.parse(before.consumedAt as string)
    && Date.parse(at) >= Date.parse(before.recoveryRequiredAt as string));
  return { ...before, phase: "failed", failedAt: at, recoveryRequiredAt: null, outcome: "superseded-for-official-bundled-replacement" };
}

export const NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1 = "631275551276127985A524ACF1F469BF5164D50D";
export function assertAcceptedRuntimeRepairHeadContract(value: unknown): asserts value is AcceptedRuntimeRepairHead {
  const version = (value as {version?:unknown})?.version;
  record(value, { version: literal(version === 2 ? 2 : 1), kind: literal("tweakers-accepted-runtime-repair-head"), operationId: uuid, promotionId: uuid, repairId: uuid, intentSha256: hash, prior: version === 2 ? predecessor : literal(null) });
  const head = value as AcceptedRuntimeRepairHead;
  requireContract(head.version !== 2 || head.repairId !== head.prior.repairId);
}
export function assertAcceptedRuntimeRepairOriginalCustodyContract(value: unknown, deps: AcceptedBackendTransitionContractDependencies): asserts value is AcceptedRuntimeRepairOriginalCustodyV1 {
  const { path, file, worker, runtime } = checks(deps);
  const leaf: Check = item => requireContract(typeof item === "string" && /^[A-F0-9]{40}$/.test(item));
  record(value, {
    version: literal(1), kind: literal("tweakers-accepted-runtime-repair-original-custody"), operationId: uuid, promotionId: uuid,
    trustedLeafSha1: leaf, originalWorker: worker,
    originalCandidateReceipt: item => { record(item, { bundlePath: path, bundleGeneration: generation, json: file, id: uuid, signingIdentityHash: leaf }); },
    unchanged: item => { record(item, { app: generation, tweaks: generation, state: generation, config: generation, priorActiveReceipt: generation }); },
    originalAcceptedBaseline: runtime, priorRuntime: generation,
  });
}
export function assertAcceptedRuntimeRepairAcceptanceSourceContract(value: unknown, deps: AcceptedBackendTransitionContractDependencies): asserts value is AcceptedRuntimeRepairAcceptanceSourceV1 {
  const { path, file } = checks(deps);
  record(value, { version: literal(1), kind: literal("tweakers-accepted-runtime-repair-acceptance-source"), sourcePath: path, sourceSha256AtCapture: hash, snapshot: file });
}
export function assertAcceptedRuntimeRepairConsumedApprovalContract(value: unknown): asserts value is AcceptedRuntimeRepairConsumedApprovalV1 {
  record(value, { version: literal(1), kind: literal("tweakers-doctor-runtime-repair-approval"), operationId: uuid, repairId: uuid, jobId: uuid,
    reportFingerprint: fingerprint, authoritySha256: hash, workerGenerationId: hash, promotionFingerprint: fingerprint,
    approvedAt: timestamp, expiresAt: timestamp });
  const approval = value as AcceptedRuntimeRepairConsumedApprovalV1;
  requireContract(Date.parse(approval.expiresAt) > Date.parse(approval.approvedAt));
}
export function assertDoctorRuntimeRepairAuthorityContract(value: unknown, deps: AcceptedBackendTransitionContractDependencies): asserts value is DoctorRuntimeRepairAuthority {
  const { path, file, origin, runtime, worker, resources } = checks(deps);
  const version = (value as {version?:unknown})?.version;
  record(value, {
    version: literal(version === 2 ? 2 : 1), kind: literal("tweakers-doctor-accepted-runtime-repair"), operationId: uuid, promotionId: uuid, repairId: uuid, expectedPriorHeadSha256: version === 2 ? hash : literal(null),
    ...(version === 2 ? {predecessor: (item:unknown) => {record(item,{binding:predecessor,publication:file,challenge:origin,installedRuntime:generation});}} : {}),
    originals: item => { record(item, { operation: origin, recoveryBinding: file, journal: origin, expectation: origin, preparedCasIntent: file, custody: file, acceptedBuildReceipt: file }); },
    completedCas: item => { record(item, { planFingerprint: fingerprint, prior: file, completed: file, currentRegistration: file, resolverSha256: hash }); },
    originalWorker: worker, authorizedWorker: worker,
    review: item => { record(item, { jobId: uuid, reportFingerprint: fingerprint, validationFingerprint: fingerprint, candidateFingerprint: fingerprint, adoptionFingerprint: fingerprint, promotionFingerprint: fingerprint }); },
    originalTrustedLeafSha1: item => requireContract(typeof item === "string" && /^[A-F0-9]{40}$/.test(item)),
    unchanged: item => { record(item, { app: generation, backendSha256: hash, helperSha256: hash, backendSignature: signature, helperSignature: signature, resources, tweaks: generation, state: generation, config: generation, priorActiveReceipt: generation }); },
    priorRuntime: generation, originalAcceptedBaseline: runtime, repairedBaseline: runtime,
    repairedRuntime: item => { record(item, { generation, evidence: runtime }); },
    recovery: item => { record(item, { root: path, generation, markerSha256: hash, validationSha256: hash }); },
    sourceDelta: item => { record(item, {
      originalSourceVerification: file, repairedSourceVerification: file, reviewedDelta: file,
      changedGeneratedFiles: files => {
        requireContract(Array.isArray(files) && files.length > 0 && files.length <= 2048);
        const seen = new Set<string>();
        for (const entry of files) { file(entry); const name = (entry as AcceptedRuntimeRepairFileRefV1).path; requireContract(!seen.has(name)); seen.add(name); }
      },
    }); }, createdAt: timestamp,
  });
  const authority = value as DoctorRuntimeRepairAuthority;
  if (authority.version === 2) requireContract(authority.repairId !== authority.predecessor.binding.repairId
    && authority.expectedPriorHeadSha256 === authority.predecessor.binding.headSha256);
}
export function assertAcceptedRuntimeRepairIntentContract(value: unknown, deps: AcceptedBackendTransitionContractDependencies): asserts value is AcceptedRuntimeRepairIntent {
  const { file } = checks(deps);
  const version = (value as {version?:unknown})?.version;
  const intent = record(value, {
    version: literal(version === 2 ? 2 : 1), kind: literal("tweakers-accepted-runtime-repair-intent"), operationId: uuid, promotionId: uuid, repairId: uuid, prior: version === 2 ? predecessor : literal(null),
    authority: item => assertDoctorRuntimeRepairAuthorityContract(item, deps),
    authorityReceipt: item => { record(item, { bundleGeneration: generation, jsonSha256: hash }); },
    consumedApproval: file, effectiveJournal: file, effectiveActiveReceipt: file, createdAt: timestamp,
  });
  const authority = intent.authority as DoctorRuntimeRepairAuthority;
  requireContract(intent.version === authority.version);
  if (authority.version === 2) requireContract(canonicalJson(intent.prior) === canonicalJson(authority.predecessor.binding));
  requireContract(intent.operationId === authority.operationId && intent.promotionId === authority.promotionId && intent.repairId === authority.repairId);
  requireContract(Date.parse(intent.createdAt as string) >= Date.parse(authority.createdAt));
}
export function assertAcceptedRuntimeRepairPublicationContract(value: unknown): asserts value is AcceptedRuntimeRepairPublicationV1 {
  record(value, { version: literal(1), kind: literal("tweakers-accepted-runtime-repair-publication"), operationId: uuid, promotionId: uuid, repairId: uuid, intentSha256: hash,
    phase: item => requireContract((ACCEPTED_RUNTIME_REPAIR_PHASES as readonly unknown[]).includes(item)),
  });
}

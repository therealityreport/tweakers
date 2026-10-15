import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAcceptedRuntimeRepairHeadContract,
  assertAcceptedRuntimeRepairIntentContract,
  assertAcceptedRuntimeRepairPublicationContract,
  assertAcceptedRuntimeRepairReadinessVersionContract,
  assertAcceptedRuntimeRepairOriginalOperationProjection,
  parseAcceptedRuntimeRepairJson,
  acceptedRuntimeRepairReadinessFields,
  type AcceptedRuntimeRepairIntentV1,
} from "@therealityreport/tweakers-sdk";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const id = "00000000-0000-4000-8000-000000000001";
const promotion = "00000000-0000-4000-8000-000000000002";
const repair = "00000000-0000-4000-8000-000000000003";
const h = "a".repeat(64);
const fingerprint = `sha256:${h}`;
const deps = { isCanonicalAbsolutePath: (path: string) => isAbsolute(path) && resolve(path) === path,
  sha256: (text: string) => createHash("sha256").update(text).digest("hex") };
const file = { path: "/fixture/evidence.json", sha256: h };
const generation = { kind: "directory" as const, mode: 0o700, sha256: h };
const runtime = { sourceRoot: "/fixture/runtime", fingerprint: h, fileCount: 1, documentSha256: h };
const signature = { identity: "fixture signer", teamIdentifier: null, designatedRequirement: null };
const worker = { generationId: h, launcherPath: "/fixture/launcher", launcherSha256: h, sealSha256: h,
  nodePath: "/fixture/node", nodeSha256: h,
  implementationScopes: { version: 1 as const, construction: fingerprint, verification: fingerprint, promotion: fingerprint, payload: fingerprint } };
function intent(): AcceptedRuntimeRepairIntentV1 {
  const origin = { sourcePath: file.path, sourceSha256AtCapture: h, snapshot: file };
  return {
    version: 1, kind: "tweakers-accepted-runtime-repair-intent", operationId: id, promotionId: promotion, repairId: repair, prior: null,
    authority: {
      version: 1, kind: "tweakers-doctor-accepted-runtime-repair", operationId: id, promotionId: promotion, repairId: repair, expectedPriorHeadSha256: null,
      originals: { operation: origin, recoveryBinding: file, journal: origin, expectation: origin, preparedCasIntent: file, custody: file, acceptedBuildReceipt: file },
      completedCas: { planFingerprint: fingerprint, prior: file, completed: file, currentRegistration: file, resolverSha256: h },
      originalWorker: worker, authorizedWorker: worker,
      review: { jobId: repair, reportFingerprint: fingerprint, validationFingerprint: fingerprint, candidateFingerprint: fingerprint, adoptionFingerprint: fingerprint, promotionFingerprint: fingerprint },
      originalTrustedLeafSha1: "B".repeat(40),
      unchanged: { app: generation, backendSha256: h, helperSha256: h, backendSignature: signature, helperSignature: signature, resources: [],
        tweaks: generation, state: generation, config: generation, priorActiveReceipt: generation },
      priorRuntime: generation, originalAcceptedBaseline: runtime, repairedBaseline: runtime, repairedRuntime: { generation, evidence: runtime },
      recovery: { root: "/fixture/recovery", generation, markerSha256: h, validationSha256: h },
      sourceDelta: { originalSourceVerification: file, repairedSourceVerification: file, reviewedDelta: file, changedGeneratedFiles: [file] },
      createdAt: "2026-10-12T00:00:00.000Z",
    },
    authorityReceipt: { bundleGeneration: generation, jsonSha256: h }, consumedApproval: file,
    effectiveJournal: file, effectiveActiveReceipt: file, createdAt: "2026-10-12T00:00:00.000Z",
  };
}

test("accepted runtime repair serialized single-child authority rejects malformed nested custody and cross bindings", () => {
  const serialized = JSON.parse(JSON.stringify(intent()));
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairIntentContract(serialized, deps));
  const mutations: Array<(value: any) => void> = [
    v => { v.prior = { repairId: repair }; }, v => { v.authority.expectedPriorHeadSha256 = h; },
    v => { v.authority.operationId = promotion; }, v => { v.authority.repairId = id; },
    v => { v.authority.unchanged.backendSignature.extra = true; },
    v => { v.authority.originalWorker.implementationScopes.extra = true; },
    v => { v.authority.originals.journal.snapshot.path = "/fixture/../journal.json"; },
    v => { v.authority.originalTrustedLeafSha1 = h; },
    v => { v.authority.repairedRuntime.generation.mode = 0o1777; },
    v => { v.authority.sourceDelta.changedGeneratedFiles = [file, file]; },
    v => { v.authority.unchanged.resources = [{ relativePath: "../codex", sourcePath: file.path, sha256: h }]; },
    v => { v.authority.originalAcceptedBaseline.fileCount = 0; },
    v => { v.authorityReceipt.extra = true; }, v => { v.consumedApproval = null; },
    v => { v.createdAt = "2026-10-11T23:59:59.000Z"; },
  ];
  for (const mutate of mutations) { const value = JSON.parse(JSON.stringify(intent())); mutate(value); assert.throws(() => assertAcceptedRuntimeRepairIntentContract(value, deps)); }
});

test("accepted runtime repair single initial head and publication preserve exact operation identifiers", () => {
  const head = { version: 1, kind: "tweakers-accepted-runtime-repair-head", operationId: id, promotionId: promotion, repairId: repair, intentSha256: h, prior: null };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairHeadContract(head));
  assert.throws(() => assertAcceptedRuntimeRepairHeadContract({ ...head, prior: { repairId: id, headSha256: h } }));
  assert.throws(() => assertAcceptedRuntimeRepairHeadContract({ ...head, successor: repair }));
  const publication = { version: 1, kind: "tweakers-accepted-runtime-repair-publication", operationId: id, promotionId: promotion, repairId: repair, intentSha256: h, phase: "challenge:published" };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairPublicationContract(publication));
  assert.throws(() => assertAcceptedRuntimeRepairPublicationContract({ ...publication, phase: "ready" }));
});

test("accepted runtime repair readiness schema5 forbids repair and schema6 requires all four exact bindings", () => {
  const binding = { repairId: repair, headSha256: h, intentSha256: h, authorityReceiptSha256: h };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairReadinessVersionContract({ schemaVersion: 5 }));
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairReadinessVersionContract({ schemaVersion: 6, runtimeRepair: binding }));
  assert.deepEqual(acceptedRuntimeRepairReadinessFields({ schemaVersion: 5 }), { schemaVersion: 5 });
  const produced = acceptedRuntimeRepairReadinessFields({ schemaVersion: 6, runtimeRepair: binding });
  assert.deepEqual(produced, { schemaVersion: 6, runtimeRepair: binding });
  assert.notEqual(produced.schemaVersion === 6 ? produced.runtimeRepair : null, binding);
  for (const value of [{ schemaVersion: 5, runtimeRepair: binding }, { schemaVersion: 6 }, { schemaVersion: 6, runtimeRepair: null },
    { schemaVersion: 6, runtimeRepair: { ...binding, headSha256: "bad" } }, { schemaVersion: 6, runtimeRepair: { ...binding, extra: true } }]) {
    assert.throws(() => assertAcceptedRuntimeRepairReadinessVersionContract(value));
  }
});

test("accepted runtime repair settlement preserves original failure snapshot and every unrelated authority field", () => {
  const snapshot = { operationId: id, actionId: "refresh.independent", phase: "recovery-required", consumedAt: "2026-10-12T00:00:00.000Z",
    recoveryRequiredAt: "2026-10-12T00:01:00.000Z", completedAt: null, failedAt: null, cancelledAt: null,
    outcome: null, error: { message: "original readiness failure" }, moduleIdentity: { path: file.path, sha256: h }, parameters: { target: "/fixture/app" } };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairOriginalOperationProjection(snapshot, structuredClone(snapshot)));
  const completed = { ...snapshot, phase: "completed", recoveryRequiredAt: null, error: null, outcome: "verified-installation-accepted", completedAt: "2026-10-12T00:02:00.000Z" };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairOriginalOperationProjection(snapshot, completed));
  assert.equal(snapshot.error.message, "original readiness failure");
  for (const invalid of [{ ...completed, phase: "consumed" }, { ...completed, completedAt: "2026-10-12T00:00:00.000Z" },
    { ...completed, moduleIdentity: { ...completed.moduleIdentity, sha256: "b".repeat(64) } },
    { ...completed, parameters: { target: "/other/app" } }, { ...completed, extra: true },
    { ...snapshot, error: null }]) assert.throws(() => assertAcceptedRuntimeRepairOriginalOperationProjection(snapshot, invalid));
});
test("accepted runtime repair JSON refuses duplicate escaped nested keys and unbounded values", () => {
  assert.deepEqual(parseAcceptedRuntimeRepairJson('{"valid":[1,true,null,{"a":"value"}]}'), { valid: [1, true, null, { a: "value" }] });
  for (const text of ['{"prior":null,"prior":{}}', '{"authority":{"repairId":"one","repair\\u0049d":"two"}}', '[1e999]', '{"a":1,}', '['.repeat(129) + '0' + ']'.repeat(129)]) {
    assert.throws(() => parseAcceptedRuntimeRepairJson(text));
  }
});

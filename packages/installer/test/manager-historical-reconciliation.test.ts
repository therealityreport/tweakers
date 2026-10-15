import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TweakersManagerPreparedOperationV1 } from "../src/manager-contract.js";
import { ManagerOperationStore } from "../src/manager-operation-store.js";
import { HISTORICAL_MANAGER_PROOF_NAMES, inspectHistoricalManagerReconciliation, publishHistoricalManagerReconciliation,
  type HistoricalManagerReconciliationInput, type HistoricalReconciliationTextRead } from "../src/manager-historical-reconciliation.js";

const batchId = "22222222-2222-4222-8222-222222222222";
const ids = ["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"];
function record(operationId: string): TweakersManagerPreparedOperationV1 {
  return { schemaVersion: 1, kind: "tweakers-manager-operation", managerId: "com.thomashulihan.tweakers", protocolVersion: 1,
    operationId, preparedRequestId: operationId, actionId: "refresh.independent",
    moduleIdentity: { state: "resolved", path: "/missing/historical/Tweakers Manager Launcher", sha256: "a".repeat(64) },
    boundStateToken: `sha256:${"b".repeat(64)}`, parameters: {}, parametersSha256: `sha256:${"c".repeat(64)}`, impact: "restart-app",
    createdAt: "2026-09-03T00:00:00.000Z", expiresAt: "2026-09-03T00:05:00.000Z", phase: "recovery-required",
    consumedAt: "2026-09-03T00:00:01.000Z", cancelledAt: null, completedAt: null, failedAt: null,
    recoveryRequiredAt: "2026-09-03T00:00:02.000Z", stateTokenInputsSha256: `sha256:${"d".repeat(64)}`,
    receiptChronologyRevision: `sha256:${"e".repeat(64)}`, receiptSnapshot: [], receiptRefs: ["independent-tweakers-patch:1.0.0"],
    outcome: null, error: "Historical outcome is unknown" };
}
function fixture(count = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-historical-test-")));
  const store = new ManagerOperationStore(root);
  const operations = ids.slice(0, count).map(id => { const value = record(id); store.create(value); return { record: value, rawText: readFileSync(store.file(id), "utf8") }; });
  const input: HistoricalManagerReconciliationInput = { batchId, createdAt: "2026-10-11T00:00:00.000Z", operations,
    issuanceBaseline: { activeReceiptSha256: "a".repeat(64), fallbackId: "44444444-4444-4444-8444-444444444444", configSha256: "b".repeat(64) },
    evidenceDocuments: HISTORICAL_MANAGER_PROOF_NAMES.map(name => ({ name, rawText: JSON.stringify({ proofName: name, observations: "Reviewed locked issuer snapshot" }) + "\n" })) };
  const base = join(root, "transactions", "manager-historical-reconciliation");
  const batch = join(base, "batches", batchId);
  const original = (id: string) => store.file(id);
  const sidecar = (id: string) => join(base, "operations", `${id}.json`);
  const evidence = (name = HISTORICAL_MANAGER_PROOF_NAMES[0]) => join(batch, "evidence", `${name}.json`);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const inspect = () => inspectHistoricalManagerReconciliation(root, operations);
  const publish = () => publishHistoricalManagerReconciliation(root, input);
  return { root, input, operations, base, batch, original, sidecar, evidence, cleanup, inspect, publish };
}
function write(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); }

test("complete evidence classifies unknown outcomes without changing strict v1 records", () => {
  const f = fixture();
  try {
    const before = f.operations.map(operation => readFileSync(f.original(operation.record.operationId), "utf8"));
    const issued = f.publish(), inspection = f.inspect();
    assert.deepEqual(inspection.classifiedOperationIds, ids);
    assert.deepEqual(inspection.problems, []);
    assert.equal(inspection.evidence[0]!.manifestSha256, issued.manifestSha256);
    assert.deepEqual(inspection.evidence[0]!.issuanceBaseline, f.input.issuanceBaseline);
    for (const [index, id] of ids.entries()) {
      assert.equal(readFileSync(f.original(id), "utf8"), before[index]);
      assert.equal(JSON.parse(readFileSync(f.original(id), "utf8")).phase, "recovery-required");
      assert.equal(JSON.parse(readFileSync(f.sidecar(id), "utf8")).outcome, "unknown");
      assert.equal(lstatSync(f.sidecar(id)).mode & 0o777, 0o600);
    }
    assert.equal(lstatSync(f.base).mode & 0o777, 0o700);
    assert.deepEqual(f.publish(), issued, "same exact bytes are idempotent");
    assert.equal(f.inspect().revision, inspection.revision);
    assert.throws(() => publishHistoricalManagerReconciliation(f.root, { ...f.input, createdAt: "2026-10-11T00:00:01.000Z" }), /immutable/);
  } finally { f.cleanup(); }
});

test("missing sidecars are unclassified and status does not create evidence directories", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.inspect().classifiedOperationIds, []);
    assert.deepEqual(f.inspect().problems, []);
    assert.throws(() => lstatSync(f.base), { code: "ENOENT" });
  } finally { f.cleanup(); }
});

test("partial or corrupt batches classify no member", () => {
  for (const member of ["complete.json", "manifest.json", "records/11111111-1111-4111-8111-111111111111.json"]) {
    const f = fixture();
    try {
      f.publish(); unlinkSync(join(f.batch, member));
      assert.deepEqual(f.inspect().classifiedOperationIds, [], member);
      assert.equal(f.inspect().problems.length > 0, true);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    f.publish(); write(join(f.batch, "complete.json"), "{broken");
    assert.deepEqual(f.inspect().classifiedOperationIds, []);
  } finally { f.cleanup(); }
});

test("raw record, retained proof, retained record and sidecar drift invalidate the entire batch", () => {
  for (const target of ["original", "proof", "retained", "sidecar"] as const) {
    const f = fixture();
    try {
      f.publish(); const before = f.inspect();
      const path = target === "original" ? f.original(ids[0]!) : target === "proof" ? f.evidence()
        : target === "sidecar" ? f.sidecar(ids[0]!) : join(f.batch, "records", `${ids[0]}.json`);
      write(path, readFileSync(path, "utf8") + " ");
      const after = f.inspect(); assert.deepEqual(after.classifiedOperationIds, [], target);
      assert.notEqual(after.revision, before.revision, target);
    } finally { f.cleanup(); }
  }
});

test("new own binding evidence or unreadable binding invalidates all batch members", () => {
  const f = fixture();
  try {
    f.publish(); const path = join(f.root, "transactions", "manager-recovery-bindings", `${ids[0]}.json`);
    write(path, "{not-even-valid-binding");
    assert.deepEqual(f.inspect().classifiedOperationIds, []);
    unlinkSync(path); symlinkSync(f.original(ids[0]!), path);
    assert.deepEqual(f.inspect().classifiedOperationIds, []);
  } finally { f.cleanup(); }
});

test("all current batch records must be observed exactly, including their parsed identity", () => {
  const f = fixture();
  try {
    f.publish();
    assert.deepEqual(inspectHistoricalManagerReconciliation(f.root, f.operations.slice(0, 1)).classifiedOperationIds, []);
    const changed = f.operations.map((operation, index) => index ? operation : { ...operation, record: { ...operation.record, error: "changed" } });
    assert.deepEqual(inspectHistoricalManagerReconciliation(f.root, changed).classifiedOperationIds, []);
  } finally { f.cleanup(); }
});

test("later live receipt, app generation and config changes do not change historical classification", () => {
  const f = fixture();
  try {
    f.publish(); const before = f.inspect();
    write(join(f.root, "variants", "tweakers", "transactions", "variant-promotion", "active.json"), "new live receipt");
    write(join(f.root, "variants", "tweakers", "config.json"), "new current config");
    assert.deepEqual(f.inspect(), before);
  } finally { f.cleanup(); }
});

test("issuer rejects ineligible identities, changed raw bytes, chronology and missing proofs", () => {
  const f = fixture(1);
  try {
    for (const input of [
      { ...f.input, batchId: "../escape" },
      { ...f.input, createdAt: "2026-09-03T00:00:01.000Z" },
      { ...f.input, operations: [...f.operations, ...f.operations] },
      { ...f.input, operations: [{ ...f.operations[0]!, rawText: f.operations[0]!.rawText + " " }] },
      { ...f.input, evidenceDocuments: f.input.evidenceDocuments.slice(1) },
      { ...f.input, evidenceDocuments: f.input.evidenceDocuments.map((document, index) => index ? document : { ...document, rawText: '{"accessToken":"secret-value"}' }) },
    ]) assert.throws(() => publishHistoricalManagerReconciliation(f.root, input));
    const wrong = { ...record(ids[0]!), actionId: "refresh.injected" as const };
    write(f.original(ids[0]!), JSON.stringify(wrong));
    assert.throws(() => publishHistoricalManagerReconciliation(f.root, { ...f.input, operations: [{ record: wrong, rawText: JSON.stringify(wrong) }] }), /eligible/);
  } finally { f.cleanup(); }
});

test("strict manifest schemas and duplicate nested JSON keys cannot be accepted", () => {
  const f = fixture();
  try {
    f.publish();
    const files = new Map<string, string>();
    const readText = (path: string): HistoricalReconciliationTextRead => {
      if (files.has(path)) return { state: "present", text: files.get(path)! };
      try { return { state: "present", text: readFileSync(path, "utf8") }; } catch { return { state: "missing" }; }
    };
    files.set(join(f.batch, "manifest.json"), readFileSync(join(f.batch, "manifest.json"), "utf8").replace('"version":1', '"version":1,"version":1'));
    assert.deepEqual(inspectHistoricalManagerReconciliation(f.root, f.operations, { readText }).classifiedOperationIds, []);
    files.clear(); files.set(f.evidence(), '{"nested":{"id":1,"id":2}}');
    assert.deepEqual(inspectHistoricalManagerReconciliation(f.root, f.operations, { readText }).classifiedOperationIds, []);
  } finally { f.cleanup(); }
});

test("unsafe parents, symlinks, hardlinks and public evidence files fail closed", () => {
  for (const unsafe of ["parent", "symlink", "hardlink", "mode"] as const) {
    const f = fixture();
    try {
      if (unsafe === "parent") {
        chmodSync(join(f.root, "transactions"), 0o777);
        assert.throws(f.publish, /unsafe|unavailable/);
      } else {
        f.publish(); const path = f.evidence(), bytes = readFileSync(path, "utf8");
        if (unsafe === "mode") chmodSync(path, 0o644);
        else {
          unlinkSync(path); const other = join(f.root, "other-proof.json"); write(other, bytes);
          if (unsafe === "symlink") symlinkSync(other, path); else linkSync(other, path);
        }
        assert.deepEqual(f.inspect().classifiedOperationIds, [], unsafe);
        assert.throws(f.publish, /unsafe/);
      }
    } finally { f.cleanup(); }
  }
});

test("status separates historical unknowns from active work and reblocks on proof drift", async () => {
  const { createTweakersManagerStatusSnapshot, managerStatusPaths } = await import("../src/manager-status.js");
  const f = fixture();
  try {
    const snapshot = () => createTweakersManagerStatusSnapshot({ paths: managerStatusPaths(f.root), executable: { state: "unresolved", reason: "fixture" } });
    assert.equal(snapshot().status.operations.state, "malformed");
    f.publish();
    const classified = snapshot();
    assert.equal(classified.status.operations.state, "valid");
    assert.equal(classified.status.operations.preparedCount, 0);
    assert.match(classified.status.operations.problem!, /2 inactive historical.*unknown/);
    const extra = record("55555555-5555-4555-8555-555555555555");
    new ManagerOperationStore(f.root).create(extra);
    assert.equal(snapshot().status.operations.activeOperationId, extra.operationId);
    assert.equal(snapshot().status.operations.preparedCount, 1);
    write(f.evidence(), readFileSync(f.evidence(), "utf8") + " ");
    assert.equal(snapshot().status.operations.state, "malformed");
    assert.notEqual(snapshot().stateToken, classified.stateToken);
  } finally { f.cleanup(); }
});

test("classified consumed history cannot execute again", async () => {
  const { TweakersManagerActionAdapter } = await import("../src/manager-action-adapter.js");
  const f = fixture(1);
  try {
    f.publish();
    const adapter = new TweakersManagerActionAdapter({ userRoot: () => f.root });
    await assert.rejects(adapter.execute({ operationId: ids[0]!, executable: f.operations[0]!.record.moduleIdentity }),
      (error: any) => error.code === "operation_consumed");
    assert.equal(readFileSync(f.original(ids[0]!), "utf8"), f.operations[0]!.rawText);
  } finally { f.cleanup(); }
});

test("orphaned originals remain blocked even when the entire operation store is gone", async () => {
  const { createTweakersManagerStatusSnapshot, managerStatusPaths } = await import("../src/manager-status.js");
  const f = fixture();
  try {
    f.publish();
    for (const id of ids) unlinkSync(f.original(id));
    assert.equal(inspectHistoricalManagerReconciliation(f.root, []).problems.length > 0, true);
    const status = () => createTweakersManagerStatusSnapshot({ paths: managerStatusPaths(f.root), executable: { state: "unresolved", reason: "fixture" } });
    assert.equal(status().status.operations.state, "malformed");
    rmSync(dirname(f.original(ids[0]!)), { recursive: true });
    assert.equal(status().status.operations.state, "malformed");
  } finally { f.cleanup(); }
});

test("new current publication evidence for an old operation reblocks it", () => {
  for (const filename of ["runtime-ready.json", "runtime-ready-expectation.json"]) {
    const f = fixture();
    try {
      f.publish();
      write(join(f.root, "variants", "tweakers", filename), JSON.stringify({ operationId: ids[0] }));
      assert.deepEqual(f.inspect().classifiedOperationIds, []);
      assert.equal(f.inspect().problems.length > 0, true);
    } finally { f.cleanup(); }
  }
});

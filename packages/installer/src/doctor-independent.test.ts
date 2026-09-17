import { doctorImplementationScopes } from "./doctor-implementation.js";
import { changelogEntryId, validateDoctorChangelog, changelogDecisionGroups } from "./doctor-changelog.js";
import { doctorDigest } from "./doctor-store.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createTweakersVariant } from "./commands/create-variant.js";
import { startDoctorUpdateScan, doctorReviewFindings } from "./doctor-updates.js";
import { inspectIndependentDoctor, parseDoctorAction, type DoctorIndependentInputs } from "./doctor-independent.js";
import { consumeDoctorCandidateApproval, assertDoctorReviewReady } from "./doctor-approval.js";
import { canPrepareDoctorCandidate, doctorValidationReportFingerprint, type DoctorValidationReport } from "./doctor-validation.js";
import type { ReviewDoctorSourceChangesResult } from "./doctor-review.js";
import { doctorDirectory, readDoctorUpdateJob, writeDoctorPrivateJson, writeDoctorUpdateJob } from "./doctor-store.js";
import { collectDoctorUpstreamContext, setDoctorUpstreamDependenciesForTest } from "./doctor-upstream.js";
import type { DoctorSourceEvidence } from "./doctor-evidence.js";

const fingerprint: `sha256:${string}` = `sha256:${"a".repeat(64)}`;

test("update approval requires complete coverage and intact checks from the executing implementation", () => {
  const validation: DoctorValidationReport = {
    schemaVersion: 1, fingerprint,
    binding: { beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: fingerprint },
    checks: ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity"].map(id => ({ id, state: "passed", summary: "Observed fixture check", artifacts: [], commands: [], scope: "fixture" })),
  };
  validation.fingerprint = doctorValidationReportFingerprint(validation);
  const review: ReviewDoctorSourceChangesResult = { state: "compatible", fingerprint, usage: null, handoff: null, summary: "Completed fixture review",
    validationFingerprint: validation.fingerprint, coverage: { totalChanges: 3, totalUnits: 5, completedUnits: 5, reusedUnits: 0, missingEvidenceSides: 0 }, findings: [] };
  assert.doesNotThrow(() => assertDoctorReviewReady(review, validation, fingerprint));
  assert.throws(() => assertDoctorReviewReady({ ...review, coverage: { ...review.coverage!, completedUnits: 4 } }, validation, fingerprint), /coverage/);
  assert.throws(() => assertDoctorReviewReady({ ...review, coverage: undefined }, validation, fingerprint), /coverage/);
  assert.throws(() => assertDoctorReviewReady(review, validation, `sha256:${"b".repeat(64)}`), /different Tweakers implementation/);
  const changed = structuredClone(validation);
  changed.checks[0]!.summary = "Altered check evidence";
  assert.throws(() => assertDoctorReviewReady(review, changed, fingerprint), /changed/);
  changed.checks[0]!.state = "unsupported";
  changed.fingerprint = doctorValidationReportFingerprint(changed);
  assert.throws(() => assertDoctorReviewReady({ ...review, validationFingerprint: changed.fingerprint }, changed, fingerprint), /incomplete/);
});

test("disposable candidate preparation keeps explanation gaps separate from installation approval", () => {
  const binding = { beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: fingerprint };
  const validation: DoctorValidationReport = { schemaVersion: 1, fingerprint, binding,
    checks: ["evidence-binding", "before-source-bytes", "after-source-bytes", "before-asar-package-integrity", "after-asar-package-integrity"].map(id => ({ id, state: "passed", summary: "Exact source", artifacts: [], commands: [], scope: "source" })) };
  validation.fingerprint = doctorValidationReportFingerprint(validation);
  const review: ReviewDoctorSourceChangesResult = { state: "review_required", fingerprint, usage: null, handoff: null, summary: "Behavior needs observation", validationFingerprint: validation.fingerprint, findings: [] };
  assert.equal(canPrepareDoctorCandidate(review, validation, binding, ["static-asset-integrity"]), true);
  assert.throws(() => assertDoctorReviewReady(review, validation, fingerprint), /incomplete/);
  assert.equal(canPrepareDoctorCandidate(review, validation, binding, ["unknown-check"]), false);
  assert.equal(canPrepareDoctorCandidate(review, validation, binding, ["frontend-patch-compatibility"]), false);
  assert.equal(canPrepareDoctorCandidate(review, validation, { ...binding, afterFingerprint: `sha256:${"b".repeat(64)}` }, []), false);
  assert.equal(canPrepareDoctorCandidate({ ...review, state: "fixes_required" }, validation, binding, []), false);
  for (const state of ["failed", "unsupported"] as const) {
    const changed = structuredClone(validation); changed.checks[0]!.state = state; changed.fingerprint = doctorValidationReportFingerprint(changed);
    assert.equal(canPrepareDoctorCandidate({ ...review, validationFingerprint: changed.fingerprint }, changed, binding, []), false);
  }
  const changed = structuredClone(validation); changed.checks[0]!.summary = "drift";
  assert.equal(canPrepareDoctorCandidate(review, changed, binding, []), false);
});

test("review blockers are grouped for display while preserving the complete evidence reference", () => {
  const review: ReviewDoctorSourceChangesResult = { state: "review_required", fingerprint, summary: "Incomplete", usage: null, handoff: null,
    findings: Array.from({ length: 12 }, (_, index) => ({ id: `change-${index}`, changeId: `change-${index}`, disposition: "review_required", artifact: "asar_member",
      path: `webview/assets/source-${index}.js`, change: "modified", beforeSha256: fingerprint, afterSha256: fingerprint,
      summary: "Interface evidence is incomplete", proposedFixes: [], requiredChecks: ["frontend-patch-compatibility"] })) };
  const findings = doctorReviewFindings(review, "/private/review/bounded-review-result.json");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.stage, "compatibility");
  assert.match(findings[0]!.detail, /Affected entries: 12/);
  assert.match(findings[0]!.detail, /complete list/);
  assert.ok(findings[0]!.evidence.includes("/private/review/bounded-review-result.json"));
  assert.match(findings[0]!.detail, /frontend-patch-compatibility/);
});
test("independent diagnosis stays read-only for missing target and unhealthy broker", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-inspection-")));
  try {
    const missing = await inspectIndependentDoctor(join(root, "missing"));
    assert.equal(missing.target.kind, "independent");
    assert.equal(missing.health.state, "blocked");
    assert.ok(missing.actions.every(action => !action.enabled));
    assert.deepEqual(readdirSync(root), []);
    const input: DoctorIndependentInputs = { root, variantRoot: join(root, "variant"), runtimeRoot: join(root, "runtime"), brokerRoot: join(root, "broker"),
      version: "1", build: "10", nativeVersion: "2", nativeBuild: "20", installedIdentity: fingerprint, nativeIdentity: fingerprint, runtimeFingerprint: fingerprint, originalAsarHash: "b".repeat(64) };
    const deps: NonNullable<Parameters<typeof inspectIndependentDoctor>[1]> = {
      inputs: () => input,
      storage: () => ({ inspectNativeStorageIdentitiesAtRoot: () => ({ state: "repairable", reason: "legacy_device_changed", fingerprint, legacyVolumeUnproven: true }),
        repairNativeStorageIdentitiesAtRoot: async () => { throw new Error("Diagnosis must not repair"); } }),
      accounts: async () => ({ broker: { state: "unavailable" } }) as never,
      liveHealth: () => ({ state: "stale" }) as never,
    };
    const report = await inspectIndependentDoctor(root, deps);
    assert.equal(report.health.state, "blocked");
    assert.equal(report.update.state, "not_checked");
    assert.equal(report.target.nativeBuild, "20");
    assert.equal(report.actions.find(action => action.id === "repair")?.enabled, true);
    assert.equal(report.actions.find(action => action.id === "update")?.enabled, false);
    assert.match(report.findings.find(finding => finding.stage === "storage")!.detail, /cannot prove the previous volume UUID/);
    assert.deepEqual(readdirSync(root), []);
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const job: import("./doctor-store.js").DoctorUpdateJobV1 = { schemaVersion: 1, workflowVersion: 2, trigger: "manual", id,
      pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nativeIdentity: fingerprint, installedIdentity: fingerprint, runtimeFingerprint: "changed-runtime", sourceGenerationId: null, sourceReceiptDigest: null, sourcePath: null,
      baselinePath: null, candidatePackage: null, candidateReceipt: null, findings: [], result: { state: "checking", phase: "comparing", candidateId: id,
        sourceFingerprint: null, tweakersFingerprint: fingerprint, candidateFingerprint: null, reviewFingerprint: null, progress: "Comparing", usage: null, handoff: null } };
    writeDoctorUpdateJob(root, job);
    const stale = await inspectIndependentDoctor(root, deps);
    assert.equal(stale.update.state, "review_required");
    assert.equal(stale.actions.find(action => action.id === "scan")?.enabled, false, "customization changes do not permit duplicate dispatch while the previous worker still runs");
    assert.equal(stale.update.execution?.status, "action_required", "customization changes require revalidation without discarding upstream evidence");
    job.runtimeFingerprint = fingerprint; job.implementationScopes = doctorImplementationScopes(); job.pid = 2147483647;
    writeDoctorUpdateJob(root, job);
    const interrupted = await inspectIndependentDoctor(root, deps);
    assert.equal(interrupted.update.execution?.status, "action_required", "a missing worker cannot appear to be running");
    assert.match(interrupted.update.progress!, /interrupted/);
    job.result.phase = "resuming";
    writeDoctorUpdateJob(root, job);
    const running = await inspectIndependentDoctor(root, deps);
    assert.equal(running.update.state, "checking", "a fresh detached handoff remains visible as running");
    assert.equal(running.actions.find(action => action.id === "scan")?.enabled, false, "active checks cannot be submitted again");
    assert.match(running.actions.find(action => action.id === "scan")!.blockers.join(" "), /already running/);
    job.updatedAt = new Date(Date.now() - 31_000).toISOString();
    writeDoctorPrivateJson(join(root, "doctor", "update.json"), job);
    assert.match((await inspectIndependentDoctor(root, deps)).update.progress!, /interrupted/, "a missing launcher cannot remain running indefinitely");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Doctor actions reject altered targets and malformed reports", () => {
  assert.equal(parseDoctorAction({ schemaVersion: 1, action: "repair", fingerprint }).action, "repair");
  for (const value of [null, [], { schemaVersion: 1, action: "quit", fingerprint }, { schemaVersion: 1, action: "update", fingerprint: "stale" },
    { schemaVersion: 1, action: "repair", fingerprint, app: "/tmp/other.app" }]) assert.throws(() => parseDoctorAction(value));
});

test("refresh requires an unexpired operation-bound Doctor approval before inspecting a candidate", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-approval-")));
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    assert.throws(() => consumeDoctorCandidateApproval(root, operationId), /approve the reviewed candidate/);
    for (const expiresAt of ["invalid", "2000-01-01T00:00:00.000Z"]) {
      writeDoctorPrivateJson(join(doctorDirectory(root), "approval.json"), { schemaVersion: 1, operationId, expiresAt });
      assert.throws(() => consumeDoctorCandidateApproval(root, operationId), /approve the reviewed candidate/);
    }
    writeDoctorPrivateJson(join(doctorDirectory(root), "approval.json"), { schemaVersion: 1, operationId: "other", expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.throws(() => consumeDoctorCandidateApproval(root, operationId), /approve the reviewed candidate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("duplicate watcher scans coalesce and unavailable worker cannot approve an update", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-dispatch-")));
  let launches = 0;
  const worker = Object.assign(new EventEmitter(), { unref() {} });
  const input: DoctorIndependentInputs = { root, variantRoot: join(root, "variant"), runtimeRoot: join(root, "runtime"), brokerRoot: join(root, "broker"),
    version: "1", build: "10", nativeVersion: "2", nativeBuild: "20", installedIdentity: fingerprint, nativeIdentity: fingerprint, runtimeFingerprint: fingerprint, originalAsarHash: "b".repeat(64) };
  const deps = { inputs: () => input, spawn: (() => { launches++; return worker; }) as never };
  const executable = { state: "resolved" as const, path: "/fixture/manager", sha256: "a".repeat(64) };
  try {
    startDoctorUpdateScan(root, executable, false, deps);
    const id = readDoctorUpdateJob(root)!.id;
    startDoctorUpdateScan(root, executable, false, deps);
    startDoctorUpdateScan(root, executable, true, deps);
    assert.equal(launches, 1);
    assert.equal(readDoctorUpdateJob(root)!.id, id);
    worker.emit("error", new Error("offline"));
    assert.equal(readDoctorUpdateJob(root)!.result.state, "review_required");
    assert.equal(readDoctorUpdateJob(root)!.result.candidateFingerprint, null);
    // An unchanged completed negative review is retained by the automatic watcher.
    startDoctorUpdateScan(root, executable, false, deps);
    assert.equal(launches, 1);
    const completed = readDoctorUpdateJob(root)!;
    completed.result.handoff = "Old exhausted allowance";
    completed.result.usage = { inputTokens: 123, outputTokens: 45 };
    completed.result.reviewFingerprint = fingerprint;
    writeDoctorUpdateJob(root, completed);
    startDoctorUpdateScan(root, executable, true, { ...deps, resumeOnly: true });
    const resumed = readDoctorUpdateJob(root)!;
    assert.equal(resumed.resumeOnly, true);
    assert.equal(resumed.result.handoff, null);
    assert.equal(resumed.result.usage, null);
    assert.equal(resumed.result.reviewFingerprint, null);
    assert.equal(resumed.lastCompletedResult!.handoff, "Old exhausted allowance");
    worker.emit("error", new Error("offline"));
    startDoctorUpdateScan(root, executable, true, deps);
    assert.equal(readDoctorUpdateJob(root)!.resumeOnly, true, "manual retry preserves the recovery's exact source instead of discovering another release");
    assert.equal(readDoctorUpdateJob(root)!.id, id);
    worker.emit("error", new Error("offline"));
    const job = readDoctorUpdateJob(root)!;
    job.nativeIdentity = `sha256:${"b".repeat(64)}`;
    writeDoctorUpdateJob(root, job);
    startDoctorUpdateScan(root, executable, false, deps);
    assert.equal(launches, 4);
    assert.notEqual(readDoctorUpdateJob(root)!.id, id);
    assert.notEqual(readDoctorUpdateJob(root)!.resumeOnly, true, "a genuinely new job may discover its source");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("the existing independent refresh entry point cannot rebuild around Doctor approval", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-refresh-gate-")));
  try {
    await assert.rejects(createTweakersVariant({ source: join(root, "missing-source.app"), app: "/Applications/Tweakers.app", userRoot: join(root, "variant"), refresh: true }, {
      platform: () => "darwin", managerRoot: () => root, home: () => root,
    }), /approve the reviewed candidate/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adoption decisions persist, unknown changes require explicit acknowledgment and changed reports revoke readiness", async () => {
  const { saveDoctorChangeReport, readDoctorAdoption, applyDoctorAdoptionAction, assertDoctorAdoptionReady } = await import("./doctor-adoption.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-adoption-")));
  try {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runtimeFingerprint = "a".repeat(64); // Production manager fingerprints are unprefixed SHA-256.
    const job: import("./doctor-store.js").DoctorUpdateJobV1 = { schemaVersion: 1, id, pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nativeIdentity: fingerprint, installedIdentity: fingerprint, runtimeFingerprint, sourceGenerationId: null, sourceReceiptDigest: null, sourcePath: null,
      baselinePath: null, candidatePackage: null, candidateReceipt: null, findings: [], result: { state: "compatible", phase: "candidate_verified", candidateId: id,
        sourceFingerprint: fingerprint, tweakersFingerprint: fingerprint, candidateFingerprint: fingerprint, reviewFingerprint: fingerprint, progress: "fixture", usage: null, handoff: null } };
    writeDoctorUpdateJob(root, job);
    const change = (id: string, status: "unknown" | "inferred_from_code") => ({ id, area: "frontend", title: id, before: "Old", after: "New", status, unknownPolicy: "acknowledgment" as const, technicalOnly: false, evidence: [], dependencies: [], compatibility: [], overrides: [] });
    const report: import("@therealityreport/tweakers-sdk").DoctorChangeReportV1 = { schemaVersion: 1, jobId: id, beforeFingerprint: fingerprint, afterFingerprint: fingerprint,
      comparisonFingerprint: fingerprint, implementationFingerprint: runtimeFingerprint, candidateFingerprint: fingerprint,
      changes: [change("sidebar", "inferred_from_code"), change("opaque", "unknown")], coverage: { total: 2, classified: 1, unresolved: 1 }, limitations: [], fingerprint: "" };
    saveDoctorChangeReport(root, job, report);
    assert.match(readDoctorAdoption(root)!.blockers.join(" "), /historical report needs/);
    const staticEvidence = { artifact: "asar_member", path: "sidebar.js", beforeSha256: fingerprint, afterSha256: `sha256:${"b".repeat(64)}`, kind: "static" as const, detail: "Sidebar button moved" };
    report.changes[0]!.evidence = [staticEvidence];
    const entry = { category: "Changed" as const, title: "Sidebar button moved", workflow: "Sidebar", before: "Button in footer", after: "Button in header", status: "inferred_from_code" as const, origin: "upstream" as const,
      evidenceReferences: [{ id: "sidebar:evidence:0", sha256: doctorDigest(staticEvidence) }], limitations: ["Not tested in app"], dependencies: [], analysisGroupIds: ["sidebar"] };
    report.changelog = { schemaVersion: 1, entries: [{ ...entry, id: changelogEntryId(entry) }], unresolved: [{ groupId: "opaque", reason: "Native behavior unavailable" }] };
    saveDoctorChangeReport(root, job, report);
    writeDoctorPrivateJson(join(doctorDirectory(root), "jobs", id, "comparison.json"), { fingerprint, beforeFingerprint: fingerprint, afterFingerprint: fingerprint });
    const decide = (choice: NonNullable<import("@therealityreport/tweakers-sdk").DoctorActionRequestV1["decision"]>["choice"], changeId = "*") =>
      applyDoctorAdoptionAction(root, { schemaVersion: 1, action: "decide", fingerprint, decision: { reportFingerprint: report.fingerprint, changeId, choice } });
    assert.throws(() => assertDoctorAdoptionReady(root, job), /decisions/);
    decide("accept_explained");
    assert.deepEqual(readDoctorAdoption(root)!.decisions.map(d => d.changeId), ["sidebar"]);
    assert.equal(readDoctorAdoption(root)!.state, "review_required");
    decide("preserve", "opaque");
    decide("accept_explained");
    assert.equal(readDoctorAdoption(root)!.state, "preservation_required");
    applyDoctorAdoptionAction(root, { schemaVersion: 1, action: "observe", fingerprint, observation: { reportFingerprint: report.fingerprint, changeId: "opaque", before: "Unknown", after: "Unknown", conditions: "Manual comparison unavailable", outcome: "unavailable" } });
    decide("accept_explained");
    assert.equal(readDoctorAdoption(root)!.state, "preservation_required");
    assert.throws(() => decide("accept", "opaque"), /explicit acknowledgment/);
    decide("acknowledge_unknown", "opaque");
    assert.equal(assertDoctorAdoptionReady(root, job).state, "ready");
    report.changelog!.unresolved[0]!.reason = "Account switching has not been observed under the new backend.";
    saveDoctorChangeReport(root, job, report);
    assert.equal(readDoctorAdoption(root)!.state, "review_required", "a changed unknown requires a fresh acknowledgment");
    assert.ok(!readDoctorAdoption(root)!.decisions.some(d => d.changeId === "opaque"));
    decide("acknowledge_unknown", "opaque");
    assert.equal(assertDoctorAdoptionReady(root, job).state, "ready");
    report.changes[0]!.dependencies = ["opaque"];
    assert.deepEqual(changelogDecisionGroups(report, report.changelog!.entries[0]!.id), ["sidebar"], "informational imports do not expand a choice");
    report.changelog!.entries[0]!.decisionDependencies = ["opaque"];
    { const { id, ...body } = report.changelog!.entries[0]!; report.changelog!.entries[0]!.id = changelogEntryId(body); }
    saveDoctorChangeReport(root, job, report);
    assert.throws(() => decide("accept", report.changelog!.entries[0]!.id), /explicit acknowledgment/);
    decide("accept_explained");
    assert.equal(readDoctorAdoption(root)!.decisions.length, 0);
    decide("acknowledge_unknown", report.changelog!.entries[0]!.id);
    assert.deepEqual(readDoctorAdoption(root)!.decisions, [{changeId: "opaque", choice: "acknowledge_unknown"}]);
    decide("accept", report.changelog!.entries[0]!.id);
    assert.equal(readDoctorAdoption(root)!.state, "ready");
    assert.equal(readDoctorAdoption(root)!.decisions.find(d => d.changeId === "opaque")!.choice, "acknowledge_unknown");
    report.changes[0]!.dependencies = [];
    delete report.changelog!.entries[0]!.decisionDependencies;
    { const { id, ...body } = report.changelog!.entries[0]!; report.changelog!.entries[0]!.id = changelogEntryId(body); }
    saveDoctorChangeReport(root, job, report);
    decide("acknowledge_unknown", "opaque");
    decide("accept", "sidebar");
    decide("defer");
    assert.equal(readDoctorAdoption(root)!.state, "deferred");
    decide("resume");
    assert.equal(readDoctorAdoption(root)!.state, "ready");
    assert.throws(() => decide("override", "sidebar"), /override adapter/);
    applyDoctorAdoptionAction(root, { schemaVersion: 1, action: "observe", fingerprint, observation: { reportFingerprint: report.fingerprint, changeId: "sidebar", before: "Old layout", after: "New layout", conditions: "Same account, theme and window", outcome: "differs" } });
    assert.equal(readDoctorAdoption(root)!.state, "review_required");
    assert.equal(readDoctorAdoption(root)!.observations[0]!.source, "user_manual");
    assert.equal(readDoctorAdoption(root)!.report.changes[0]!.status, "inferred_from_code");
    decide("accept", "sidebar");
    decide("preserve", "opaque");
    decide("defer");
    const old = report.fingerprint;
    report.candidateFingerprint = `sha256:${"b".repeat(64)}`;
    saveDoctorChangeReport(root, job, report);
    assert.deepEqual(readDoctorAdoption(root)!.decisions, [{ changeId: "opaque", choice: "preserve" }]);
    assert.equal(readDoctorAdoption(root)!.state, "deferred");
    assert.throws(() => applyDoctorAdoptionAction(root, { schemaVersion: 1, action: "decide", fingerprint, decision: { reportFingerprint: old, changeId: "sidebar", choice: "accept" } }), /changed/);
    assert.throws(() => assertDoctorAdoptionReady(root, job), /decisions/);
    const successor = { ...job, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", predecessorId: job.id, runtimeFingerprint: `sha256:${"c".repeat(64)}` };
    writeDoctorUpdateJob(root, successor);
    const interrupted = successor;
    // An oversized historical diagnostic without decisions must not hide an older refusal.
    writeDoctorPrivateJson(join(root, "doctor", "jobs", interrupted.id, "changes.json"), { legacyDiagnostic: "x".repeat(17 * 1024 * 1024) });
    const following = { ...successor, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", predecessorId: interrupted.id };
    writeDoctorUpdateJob(root, following);
    const regrouped = { ...report, jobId: following.id, implementationFingerprint: successor.runtimeFingerprint, changes: [change("regrouped", "unknown")], changelog: { schemaVersion: 1 as const, entries: [], unresolved: [{groupId: "regrouped", reason: "Regrouped evidence needs review"}] } };
    saveDoctorChangeReport(root, following, regrouped);
    const inherited = readDoctorAdoption(root)!;
    assert.equal(inherited.state, "deferred");
    assert.ok(inherited.report.changes.some(c => c.id === "opaque" && c.title.startsWith("Preservation request:")));
    assert.deepEqual(inherited.decisions, [{ changeId: "opaque", choice: "preserve" }]);
    rmSync(join(root, "doctor", "jobs", following.id, "changes.json"));
    const missingIntentEvidence = { ...following, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", predecessorId: following.id };
    writeDoctorUpdateJob(root, missingIntentEvidence);
    assert.throws(() => saveDoctorChangeReport(root, missingIntentEvidence, { ...regrouped, jobId: missingIntentEvidence.id }), /adoption intent has missing report evidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new upstream scans queue during a worker and interrupted same-source scans keep their job identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-queue-")));
  const worker = new EventEmitter() as EventEmitter & { unref(): void }; worker.unref = () => {};
  let launches = 0;
  const input: DoctorIndependentInputs = { root, variantRoot: root, runtimeRoot: root, brokerRoot: root, version: "1", build: "10", nativeVersion: "2", nativeBuild: "20",
    installedIdentity: fingerprint, nativeIdentity: fingerprint, runtimeFingerprint: fingerprint, originalAsarHash: "b".repeat(64) };
  const deps = { inputs: () => input, spawn: (() => { launches++; return worker; }) as never };
  const executable = { state: "resolved" as const, path: "/fixture/manager", sha256: "a".repeat(64) };
  try {
    startDoctorUpdateScan(root, executable, false, deps);
    const first = readDoctorUpdateJob(root)!;
    input.nativeIdentity = `sha256:${"b".repeat(64)}`;
    startDoctorUpdateScan(root, executable, false, deps);
    assert.equal(launches, 1);
    assert.equal(readDoctorUpdateJob(root)!.id, first.id);
    const { result } = first;
    result.state = "review_required"; result.phase = "review_incomplete";
    writeDoctorUpdateJob(root, first);
    startDoctorUpdateScan(root, executable, false, deps);
    const second = readDoctorUpdateJob(root)!;
    assert.notEqual(second.id, first.id);
    second.result.state = "review_required"; second.result.phase = "review_incomplete";
    writeDoctorUpdateJob(root, second);
    startDoctorUpdateScan(root, executable, false, deps);
    assert.equal(readDoctorUpdateJob(root)!.id, second.id);
    assert.equal(launches, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("preview preparation cannot use an active home or a promotion mode", async () => {
  for (const options of [
    { candidateOnly: true, doctorPreviewHome: "/Users/active", userRoot: "/Users/active/profile", app: "/Applications/Tweakers.app" },
    { refresh: true, doctorPreviewHome: "/Users/active" },
  ]) {
    await assert.rejects(createTweakersVariant(options, { platform: () => "darwin" }), /preview requires disposable candidate-only identities/);
  }
});

test("review budget survives restart, counts interrupted requests, and rejects oversized packets", async () => {
  const { reserveDoctorReviewRequest, recordDoctorReviewUsage } = await import("./doctor-review-budget.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-budget-")));
  try {
    assert.throws(() => reserveDoctorReviewRequest(root, "pair", 32769), /32 KiB/);
    const interrupted = reserveDoctorReviewRequest(root, "pair", 1000);
    assert.throws(() => reserveDoctorReviewRequest(root, "pair", 1000), /usage is unavailable/);
    recordDoctorReviewUsage(root, "pair", interrupted, { inputTokens: 20_000, outputTokens: 100 });
    for (let i = 0; i < 3; i++) {
      const id = reserveDoctorReviewRequest(root, "pair", 1000);
      recordDoctorReviewUsage(root, "pair", id, { inputTokens: 100, outputTokens: 10 });
    }
    const fifth = reserveDoctorReviewRequest(root, "pair", 1000);
    recordDoctorReviewUsage(root, "pair", fifth, { inputTokens: 100, outputTokens: 10 });
    const exhausted = reserveDoctorReviewRequest(root, "another-pair", 1000);
    recordDoctorReviewUsage(root, "another-pair", exhausted, { inputTokens: 100_000, outputTokens: 100 });
    assert.ok(reserveDoctorReviewRequest(root, "another-pair", 1000), "historical token ceilings no longer stop automatic completion");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("legacy watcher entrypoint performs no discovery or scan", async () => {
  const { scanIndependentDoctorFromWatcher } = await import("./doctor-actions.js");
  assert.doesNotThrow(() => scanIndependentDoctorFromWatcher());
});

test("explicit allowance extension preserves usage and cannot forgive missing usage", async () => {
  const { reserveDoctorReviewRequest, recordDoctorReviewUsage, extendDoctorReviewAllowance, readDoctorReviewUsage } = await import("./doctor-review-budget.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-allowance-")));
  try {
    const id = reserveDoctorReviewRequest(root, "pair", 1000, { configuredModel: "configured", stage: "change_explanation" });
    assert.throws(() => extendDoctorReviewAllowance(root, "pair", fingerprint), /missing request usage/);
    recordDoctorReviewUsage(root, "pair", id, { inputTokens: 100000, outputTokens: 10, model: "actual", cachedInputTokens: 200 });
    extendDoctorReviewAllowance(root, "pair", fingerprint);
    assert.ok(reserveDoctorReviewRequest(root, "pair", 1000));
    const ledger = readDoctorReviewUsage(root, "pair");
    assert.equal(ledger.requests[0]!.usage!.inputTokens, 100000);
    assert.equal(ledger.requests[0]!.actualModel, "actual");
    assert.equal(ledger.requests[0]!.metadata!.configuredModel, "configured");
    assert.equal(ledger.extensions!.length, 1);
    assert.equal(ledger.schemaVersion, 2);
    assert.equal(ledger.policy?.mode, "finish_automatically");
    const pending = ledger.requests.at(-1)!;
    recordDoctorReviewUsage(root, "pair", pending.id, { inputTokens: 1, outputTokens: 1 });
    for (let i = 0; i < 2; i++) {
      const attempt = reserveDoctorReviewRequest(root, "pair", 1000, { evidenceFingerprint: "same-packet", configuredModel: `model-${i}` });
      recordDoctorReviewUsage(root, "pair", attempt, { inputTokens: 1, outputTokens: 1 });
    }
    assert.throws(() => reserveDoctorReviewRequest(root, "pair", 1000, { evidenceFingerprint: "same-packet", configuredModel: "another-model" }), /initial and corrective/);
    assert.ok(reserveDoctorReviewRequest(root, "pair", 1000, { evidenceFingerprint: "unrelated-packet" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("changelog validates evidence kinds and couples sibling claims without treating legacy reports as migrated", () => {
  const evidence = { artifact: "asar_member", path: "ui.js", beforeSha256: fingerprint, afterSha256: fingerprint, kind: "static" as const, detail: "Paired static code" };
  const group = { id: "ui", area: "frontend", title: "UI", before: "old", after: "new", status: "inferred_from_code" as const, technicalOnly: false, evidence: [evidence], dependencies: ["backend"], compatibility: [], overrides: [] };
  const report: import("@therealityreport/tweakers-sdk").DoctorChangeReportV1 = { schemaVersion: 1, jobId: "fixture", beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, implementationFingerprint: fingerprint, candidateFingerprint: fingerprint, changes: [group, { ...group, id: "backend", dependencies: [], evidence: [] }], coverage: {total: 2, classified: 2, unresolved: 0}, limitations: [], fingerprint };
  assert.doesNotThrow(() => validateDoctorChangelog(report));
  assert.equal(report.changelog, undefined);
  const claim = { category: "Changed" as const, title: "Composer placement", workflow: "Composer", before: "Below messages", after: "Docked at bottom", status: "inferred_from_code" as const, origin: "upstream" as const, evidenceReferences: [{id: "ui:evidence:0", sha256: doctorDigest(evidence)}], limitations: ["Not exercised"], dependencies: ["backend"], analysisGroupIds: ["ui"] };
  report.changelog = {schemaVersion: 1, entries: [{...claim, id: changelogEntryId(claim)}], unresolved: []};
  assert.doesNotThrow(() => validateDoctorChangelog(report));
  assert.deepEqual(changelogDecisionGroups(report, report.changelog.entries[0]!.id), ["ui"], "shared imports remain informational");
  const coupled = { ...claim, decisionDependencies: ["backend"] };
  report.changelog.entries = [{ ...coupled, id: changelogEntryId(coupled) }];
  assert.deepEqual(changelogDecisionGroups(report, report.changelog.entries[0]!.id), ["backend", "ui"]);
  const observed = {...claim, status: "observed" as const};
  report.changelog.entries = [{...observed, id: changelogEntryId(observed)}];
  assert.throws(() => validateDoctorChangelog(report), /stated kind/);
  report.changelog.entries = [{...claim, after: "Invented", id: changelogEntryId(claim)}];
  assert.throws(() => validateDoctorChangelog(report), /Invalid behavioral/);
});

test("Doctor accepts a fingerprint-bound reconnect action without arbitrary account paths", () => {
  assert.deepEqual(parseDoctorAction({ schemaVersion: 1, action: "reconnect", fingerprint }), { schemaVersion: 1, action: "reconnect", fingerprint });
  assert.throws(() => parseDoctorAction({ schemaVersion: 1, action: "reconnect", fingerprint, authHome: "/tmp/untrusted" }));
});

test("upstream context requires full captured revisions, verifies official commits, filters bounded compare files, and reuses valid cache", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-upstream-")));
  const beforeRevision = "1".repeat(40);
  const afterRevision = "2".repeat(40);
  const source = (revision: string, executable: string): DoctorSourceEvidence => ({
    schemaVersion: 1, kind: "tweakers-doctor-source-evidence", appPath: "/fixture/Codex.app", version: "1", build: "1",
    backend: { path: "Contents/Resources/codex", version: revision, sha256: `sha256:${executable}` },
    shippedFiles: [], asar: { path: "Contents/Resources/app.asar", sha256: fingerprint, members: [] },
    schemas: { state: "complete", command: [], files: [], fingerprint, problem: null }, complete: true, unresolvedEvidence: [], fingerprint, artifact: "doctor-source-evidence.json",
  });
  let requests = 0;
  const restore = setDoctorUpstreamDependenciesForTest({
    async fetch(url) {
      requests++;
      const body = url.includes("/compare/")
        ? { base_commit: { sha: beforeRevision }, head_commit: { sha: afterRevision }, files: [
          { filename: "codex-rs/app-server/protocol.rs", status: "modified", additions: 2, deletions: 1, patch: "@@ protocol\n-old\n+new" },
          { filename: "codex-rs/auth.rs", status: "modified", additions: 1, deletions: 1 },
          { filename: "codex-rs/config.rs", status: "modified", additions: 20000, deletions: 0, patch: "x".repeat(20 * 1024) },
          { filename: "README.md", status: "modified", additions: 1, deletions: 0 },
        ] }
        : { sha: url.endsWith(beforeRevision) ? beforeRevision : afterRevision };
      return { status: 200, text: async () => JSON.stringify(body) };
    },
  });
  try {
    const before = source(beforeRevision, "a".repeat(64));
    const after = source(afterRevision, "b".repeat(64));
    const result = await collectDoctorUpstreamContext(before, after, root);
    assert.equal(result.status, "verified");
    if (result.status === "verified") {
      assert.equal(result.changes.length, 3);
      assert.equal(result.changes[0]!.path, "codex-rs/app-server/protocol.rs");
      assert.equal(result.before.revision, beforeRevision);
      assert.equal(result.changes.find(change => change.path.endsWith("auth.rs"))!.patchState, "missing");
      assert.equal(result.changes.find(change => change.path.endsWith("config.rs"))!.patchState, "truncated");
      assert.match(result.changes[0]!.sourceUrl, new RegExp(afterRevision));
    }
    assert.equal(requests, 3);
    assert.equal((await collectDoctorUpstreamContext(before, after, root)).status, "verified");
    assert.equal(requests, 3, "validated private cache avoids another network request");
    const initialCache = readdirSync(root).find(file => file.endsWith(".json"))!;
    const unavailable = await collectDoctorUpstreamContext(source(`${beforeRevision} ${afterRevision}`, "c".repeat(64)), after, root);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(requests, 3, "ambiguous metadata never guesses an upstream revision");
    const alternate = await collectDoctorUpstreamContext(before, source(afterRevision, "c".repeat(64)), root);
    assert.equal(alternate.status, "verified");
    assert.equal(requests, 6);
    const cacheFiles = readdirSync(root).filter(file => file.endsWith(".json")).sort();
    writeFileSync(join(root, initialCache), readFileSync(join(root, cacheFiles.find(file => file !== initialCache)!)));
    assert.equal((await collectDoctorUpstreamContext(before, after, root)).status, "verified");
    assert.equal(requests, 9, "a valid cache result for another executable identity is not reused");
    writeFileSync(join(root, initialCache), "{broken");
    assert.equal((await collectDoctorUpstreamContext(before, after, root)).status, "verified");
    assert.equal(requests, 12, "corrupt cache content is discarded");
    const offlineRestore = setDoctorUpstreamDependenciesForTest({ async fetch() { throw new Error("offline"); } });
    try {
      assert.equal((await collectDoctorUpstreamContext(source(beforeRevision, "e".repeat(64)), after, root)).status, "unavailable");
    } finally { offlineRestore(); }
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("compatibility readiness ignores optional 17/70 coverage but binds every required check and configuration", async () => {
  const { DOCTOR_CORE_CHECKS, makeDoctorCompatibility, assertDoctorCompatibility, compatibilityFingerprint } = await import("./doctor-compatibility.js");
  const { doctorPatchImplementationFingerprint } = await import("./doctor-validation.js");
  const validation: DoctorValidationReport = {schemaVersion: 1, fingerprint,
    binding: {beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: doctorPatchImplementationFingerprint()},
    checks: DOCTOR_CORE_CHECKS.map(id => ({id, state: "passed", summary: "Verified check", artifacts: [], commands: [], scope: id}))};
  validation.fingerprint = doctorValidationReportFingerprint(validation);
  const compatibility = makeDoctorCompatibility({validation, configurationFingerprint: fingerprint, requiredChecks: DOCTOR_CORE_CHECKS, candidateFingerprint: fingerprint});
  assert.equal(compatibility.status, "passed");
  assert.doesNotThrow(() => assertDoctorCompatibility(compatibility, validation, fingerprint, fingerprint));
  assert.throws(() => assertDoctorCompatibility(undefined, validation, fingerprint, fingerprint), /missing/);
  assert.throws(() => assertDoctorCompatibility(compatibility, validation, "changed-config", fingerprint), /changed/);
  assert.throws(() => assertDoctorCompatibility(compatibility, validation, fingerprint, "changed-candidate"), /changed/);
  const missing = structuredClone(compatibility); missing.checks.pop(); missing.fingerprint = compatibilityFingerprint(missing);
  assert.throws(() => assertDoctorCompatibility(missing, validation, fingerprint, fingerprint), /incomplete/);
  const retained = structuredClone(validation);
  retained.retainedBackendBaselineFingerprint = fingerprint;
  retained.checks.push({id: "retained-backend-baseline", state: "passed", summary: "Verified installed backend", artifacts: [], commands: [], scope: "maintenance"});
  retained.fingerprint = doctorValidationReportFingerprint(retained);
  const omittedBaseline = makeDoctorCompatibility({validation: retained, configurationFingerprint: fingerprint, requiredChecks: DOCTOR_CORE_CHECKS, candidateFingerprint: fingerprint});
  assert.throws(() => assertDoctorCompatibility(omittedBaseline, retained, fingerprint, fingerprint), /incomplete/);
  const completeBaseline = makeDoctorCompatibility({validation: retained, configurationFingerprint: fingerprint, requiredChecks: [...DOCTOR_CORE_CHECKS, "retained-backend-baseline"], candidateFingerprint: fingerprint});
  assert.doesNotThrow(() => assertDoctorCompatibility(completeBaseline, retained, fingerprint, fingerprint));
  for (const state of ["failed", "unsupported"] as const) {
    const failed = structuredClone(validation); failed.checks[0]!.state = state; failed.fingerprint = doctorValidationReportFingerprint(failed);
    const blocked = makeDoctorCompatibility({validation: failed, configurationFingerprint: fingerprint, requiredChecks: DOCTOR_CORE_CHECKS, candidateFingerprint: fingerprint});
    assert.equal(blocked.status, state === "failed" ? "conflict" : "verification_unavailable");
    assert.throws(() => assertDoctorCompatibility(blocked, failed, fingerprint, fingerprint), /incomplete/);
  }
});

test("compatibility jobs keep a legacy 17/70 behavioral report optional while retaining defer and preservation", async () => {
  const { saveDoctorChangeReport, readDoctorAdoption, applyDoctorAdoptionAction } = await import("./doctor-adoption.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-compatibility-adoption-")));
  try {
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const job: import("./doctor-store.js").DoctorUpdateJobV1 = {
      schemaVersion: 1, id, pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nativeIdentity: fingerprint, installedIdentity: fingerprint, runtimeFingerprint: "a".repeat(64), sourceGenerationId: null, sourceReceiptDigest: null, sourcePath: null,
      baselinePath: null, candidatePackage: null, candidateReceipt: null, findings: [],
      result: {
        state: "compatible", phase: "candidate_verified", candidateId: id, sourceFingerprint: fingerprint, tweakersFingerprint: fingerprint,
        candidateFingerprint: fingerprint, reviewFingerprint: fingerprint, progress: "Candidate compatibility passed.", usage: null, handoff: null,
        compatibility: {
          version: 1, policyVersion: 1, status: "passed", fingerprint,
          binding: { beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: fingerprint, configurationFingerprint: fingerprint, candidateFingerprint: fingerprint, validationFingerprint: fingerprint },
          checks: [{ id: "candidate", owner: "fixture", outcome: "passed", expected: "Pass", observed: "Passed", evidence: [], nextAction: "none" }], repairs: [], postInstallChecks: [],
        },
      },
    };
    writeDoctorUpdateJob(root, job);
    const report: import("@therealityreport/tweakers-sdk").DoctorChangeReportV1 = {
      schemaVersion: 1, jobId: id, beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint,
      implementationFingerprint: job.runtimeFingerprint, candidateFingerprint: fingerprint,
      changes: [{ id: "legacy-unknown", area: "legacy", title: "Legacy unknown behavior", before: "Before", after: "After", status: "unknown", technicalOnly: false, evidence: [], dependencies: [], compatibility: [], overrides: [] }],
      coverage: { total: 70, classified: 17, unresolved: 53 }, limitations: ["Legacy behavioral review is incomplete"], fingerprint: "",
      reviewProgress: { version: 1, policy: "finish_automatically", stage: "action_required", files: { total: 70, accounted: 17 }, questions: { total: 70, completed: 17, reused: 0 }, entries: 17, limitations: 53 },
    };
    saveDoctorChangeReport(root, job, report);
    let adoption = readDoctorAdoption(root)!;
    assert.equal(adoption.state, "ready");
    assert.deepEqual(adoption.blockers, []);
    const verifiedResult = job.result;
    job.compatibilityPolicyVersion = 1;
    job.result = { ...verifiedResult, state: "checking", phase: "resuming", candidateFingerprint: null, compatibility: undefined };
    writeDoctorUpdateJob(root, job);
    const resuming = readDoctorAdoption(root)!;
    assert.equal(resuming.state, "review_required");
    assert.deepEqual(resuming.blockers, ["The report is not bound to a verified candidate yet."]);
    job.result = verifiedResult;
    writeDoctorUpdateJob(root, job);
    const decide = (choice: "defer" | "resume" | "preserve", changeId = "*") => applyDoctorAdoptionAction(root, {
      schemaVersion: 1, action: "decide", fingerprint,
      decision: { reportFingerprint: adoption.report.fingerprint, changeId, choice },
    });
    decide("preserve", "legacy-unknown");
    adoption = readDoctorAdoption(root)!;
    assert.equal(adoption.state, "preservation_required");
    decide("defer");
    adoption = readDoctorAdoption(root)!;
    assert.equal(adoption.state, "deferred");
    decide("resume");
    assert.equal(readDoctorAdoption(root)!.state, "preservation_required");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only an exact Accounts preflight failure with no started work can be retired by a deliberate healthy retry", async () => {
  const { isAccountsRecoveryPreflightFailure } = await import("./doctor-independent.js");
  const operation = { actionId: "refresh.independent", phase: "recovery-required", error: "Independent Tweakers refresh requires a source-bound validated Accounts recovery receipt in the sealed runtime.",
    timing: { phases: Object.fromEntries(["source-validation", "apfs-clone", "patch-stage", "sign", "verify", "quiesce-promote", "runtime-ready-wait"].map(key => [key, { state: "skipped", startedAt: null, completedAt: null }])) } } as any;
  assert.equal(isAccountsRecoveryPreflightFailure(operation), true);
  assert.equal(isAccountsRecoveryPreflightFailure({ ...operation, error: "Unknown failure" }), false);
  assert.equal(isAccountsRecoveryPreflightFailure({ ...operation, timing: { phases: {} } }), false);
  operation.timing.phases["patch-stage"].startedAt = "2026-09-16T18:00:00Z";
  assert.equal(isAccountsRecoveryPreflightFailure(operation), false);
});

test("completed installation presentation requires the exact active candidate app and runtime receipts", async () => {
  const { completedCandidateMatchesActiveReceipt } = await import("./doctor-independent.js");
  const variant = "/fixture/variants/tweakers";
  const candidate = { identity: { appTarget: "/Applications/Tweakers.app", userRoot: variant }, artifacts: { app: { sha256: "a" }, runtime: { sha256: "b" } } };
  const active = { version: 3, target: "/Applications/Tweakers.app", userRoot: variant, entries: [{ name: "app", path: "/Applications/Tweakers.app", fingerprint: candidate.artifacts.app }, { name: "runtime", path: variant + "/runtime", fingerprint: candidate.artifacts.runtime }] };
  assert.equal(completedCandidateMatchesActiveReceipt(candidate, active, variant, candidate.artifacts), true);
  assert.equal(completedCandidateMatchesActiveReceipt(candidate, { ...active, target: "/Applications/ChatGPT.app" }, variant, candidate.artifacts), false);
  assert.equal(completedCandidateMatchesActiveReceipt(candidate, { ...active, entries: [active.entries[0]] }, variant, candidate.artifacts), false);
  assert.equal(completedCandidateMatchesActiveReceipt({ ...candidate, artifacts: { ...candidate.artifacts, runtime: { sha256: "changed" } } }, active, variant, candidate.artifacts), false);
  assert.equal(completedCandidateMatchesActiveReceipt(candidate, active, variant, { ...candidate.artifacts, runtime: { sha256: "changed-live-bytes" } }), false);
});


test("candidate override advances the retained receipt binding without changing construction inputs", async () => {
  const { recordDoctorCandidateOverride, readDoctorPrivateJson } = await import("./doctor-store.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-override-inputs-")));
  try {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const path = join(doctorDirectory(root), "jobs", id, "candidate-inputs.json");
    writeDoctorPrivateJson(path, {version: 1, fingerprint, candidateReceiptFingerprint: fingerprint});
    const next = `sha256:${"b".repeat(64)}`;
    recordDoctorCandidateOverride(root, id, fingerprint, next, "co.tweakers.titlebar-controls:disabled");
    const inputs = readDoctorPrivateJson(path) as {fingerprint: string; candidateReceiptFingerprint: string; overrides: unknown[]};
    assert.equal(inputs.fingerprint, fingerprint);
    assert.equal(inputs.candidateReceiptFingerprint, next);
    assert.equal(inputs.overrides.length, 1);
    assert.throws(() => recordDoctorCandidateOverride(root, id, fingerprint, next, "stale"), /changed/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

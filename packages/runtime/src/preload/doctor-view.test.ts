import assert from "node:assert/strict";
import test from "node:test";
import {
  createDoctorController,
  changelogDecisionGroups,
  compatibilityPresentation,
  isCompatibilityWorkflowInProgress,
  doctorPresentation,
  type DoctorActionRequestV1,
  type DoctorReportV1,
} from "./doctor-view";

const fingerprint = `sha256:${"a".repeat(64)}`;

function blockedBrokerReport(overrides: Partial<DoctorReportV1> = {}): DoctorReportV1 {
  return {
    schemaVersion: 1,
    kind: "tweakers-independent-doctor",
    generatedAt: "2026-09-10T12:00:00.000Z",
    fingerprint,
    target: {
      kind: "independent",
      appPath: "/Applications/Tweakers.app",
      version: "1.0.0",
      build: "100",
      runtimeRoot: "/Library/Application Support/Tweakers/runtime",
      brokerRoot: null,
      nativeAppPath: "/Applications/ChatGPT.app",
      nativeVersion: "1.2.3",
      nativeBuild: "456",
    },
    health: { state: "blocked", broker: "missing" },
    update: {
      state: "fixes_required",
      phase: "broker-validation",
      candidateId: "candidate-1",
      sourceFingerprint: null,
      tweakersFingerprint: null,
      candidateFingerprint: null,
      reviewFingerprint: null,
      progress: "Repair the broker before reviewing the update.",
      usage: { inputTokens: 120, outputTokens: 30 },
      handoff: "Broker registration is missing.",
    },
    findings: [{
      id: "broker-missing",
      stage: "broker",
      severity: "error",
      reason: "missing",
      title: "Broker is unavailable",
      detail: "The independent broker could not be reached.",
      evidence: ["broker=missing"],
    }],
    actions: [
      { id: "scan", label: "Scan", enabled: true, blockers: [] },
      { id: "repair", label: "Repair", enabled: true, blockers: [] },
      { id: "retry", label: "Retry", enabled: false, blockers: ["Repair the broker first."] },
      { id: "update", label: "Update", enabled: false, blockers: ["Broker health is blocked."] },
    ],
    ...overrides,
  };
}

test("Doctor presentation keeps blocked health separate from blocked update state", () => {
  const presentation = doctorPresentation(blockedBrokerReport());
  assert.equal(presentation.healthLabel, "Blocked");
  assert.equal(presentation.healthTone, "error");
  assert.equal(presentation.updateLabel, "Fixes required");
  assert.deepEqual(presentation.installationFindings.map((finding) => finding.id), ["broker-missing"]);
  assert.deepEqual(presentation.compatibilityFindings, []);
  assert.deepEqual(presentation.actionBlockers, [
    { action: "retry", blockers: ["Repair the broker first."] },
    { action: "update", blockers: ["Broker health is blocked."] },
  ]);
});

test("Doctor presentation keeps a healthy installation separate from an unresolved compatibility review", () => {
  const report = blockedBrokerReport({
    health: { state: "healthy", broker: "ready" },
    update: {
      ...blockedBrokerReport().update,
      state: "review_required",
      phase: "review_complete",
      progress: "The candidate still needs compatibility decisions.",
    },
    findings: [
      {
        id: "source-change",
        stage: "compatibility",
        severity: "warning",
        reason: "review-required",
        title: "Source compatibility is unresolved",
        detail: "Affected files: app.asar. Required checks: frontend patch compatibility.",
        evidence: ["app.asar changed"],
      },
      {
        id: "candidate-check",
        stage: "candidate",
        severity: "error",
        reason: "check-required",
        title: "Candidate checks are required",
        detail: "Required checks: signed candidate identity.",
        evidence: ["candidate=candidate-1"],
      },
    ],
    actions: [
      { id: "scan", label: "Scan", enabled: true, blockers: [] },
      { id: "repair", label: "Repair", enabled: false, blockers: ["No installation repair is needed."] },
      { id: "retry", label: "Retry", enabled: true, blockers: [] },
      { id: "update", label: "Update", enabled: false, blockers: ["Compatibility remains unresolved."] },
    ],
  });

  const presentation = doctorPresentation(report);
  assert.equal(presentation.healthLabel, "Healthy");
  assert.equal(presentation.healthTone, "ok");
  assert.equal(presentation.updateLabel, "Review finished—compatibility unresolved");
  assert.deepEqual(presentation.installationFindings, []);
  assert.deepEqual(presentation.compatibilityFindings.map((finding) => finding.id), [
    "source-change",
    "candidate-check",
  ]);
  assert.deepEqual(presentation.actionBlockers, [
    { action: "repair", blockers: ["No installation repair is needed."] },
    { action: "update", blockers: ["Compatibility remains unresolved."] },
  ]);
});

test("Doctor presents compatibility evidence as the installation decision", () => {
  const report = blockedBrokerReport({
    health: { state: "healthy", broker: "ready" },
    update: {
      ...blockedBrokerReport().update,
      state: "compatible",
      phase: "candidate_verified",
      compatibility: {
        version: 1,
        policyVersion: 1,
        status: "passed",
        fingerprint,
        binding: { beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: fingerprint, configurationFingerprint: fingerprint, candidateFingerprint: fingerprint, validationFingerprint: fingerprint },
        checks: [{ id: "patches", owner: "runtime", outcome: "passed", expected: "Patch check passes", observed: "Passed", evidence: ["validation.json"], nextAction: "none" }],
        repairs: [],
        postInstallChecks: ["operation-bound-runtime-ready"],
      },
    },
  });
  assert.equal(doctorPresentation(report).updateLabel, "Ready to install");
  assert.deepEqual(compatibilityPresentation(report.update), {
    label: "Ready to install",
    summary: "All required compatibility checks passed.",
    passedChecks: 1,
    totalChecks: 1,
    actionableChecks: [],
  });
  for (const phase of ["promotion_failed", "stale"]) {
    const failed = { ...report.update, state: "review_required" as const, phase };
    assert.equal(doctorPresentation({ ...report, update: failed }).updateLabel, "Needs attention");
    assert.equal(compatibilityPresentation(failed).label, "Compatibility passed");
    assert.doesNotMatch(compatibilityPresentation(failed).summary, /Ready to install/);
  }
  assert.equal(doctorPresentation({ ...report, update: { ...report.update, phase: "updating" } }).updateLabel, "Installing update");
  assert.equal(doctorPresentation({ ...report, update: { ...report.update, phase: "installed" } }).updateLabel, "Update installed");
});

test("Doctor keeps successful compatibility evidence compact and treats a null candidate as in progress", () => {
  const update = {
    ...blockedBrokerReport().update,
    state: "checking" as const,
    phase: "checking",
    compatibility: {
      version: 1 as const, policyVersion: 1 as const, status: "verification_unavailable" as const, fingerprint,
      binding: { beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: fingerprint, configurationFingerprint: fingerprint, candidateFingerprint: null, validationFingerprint: fingerprint },
      checks: [
        { id: "passed", owner: "runtime", outcome: "passed" as const, expected: "Pass", observed: "Passed", evidence: Array.from({ length: 1000 }, (_, index) => `evidence-${index}`), nextAction: "none" },
        { id: "unavailable", owner: "native", outcome: "verification_unavailable" as const, expected: "Observe", observed: "Unavailable", evidence: ["one"], nextAction: "Retry" },
      ], repairs: [], postInstallChecks: [],
    },
  };
  const presentation = compatibilityPresentation(update);
  assert.equal(presentation.label, "Verification in progress");
  assert.equal(presentation.passedChecks, 1);
  assert.equal(presentation.totalChecks, 2);
  assert.deepEqual(presentation.actionableChecks.map((check) => check.id), ["unavailable"]);
});

test("Doctor keeps a resuming policy migration in compatibility checking before its record exists", () => {
  const update = { ...blockedBrokerReport().update, state: "checking" as const, phase: "resuming" };
  assert.equal(isCompatibilityWorkflowInProgress(update), true);
  assert.equal(doctorPresentation(blockedBrokerReport({ update })).updateLabel, "Checking compatibility");
});

test("Doctor rejects malformed compatibility evidence before rendering", async () => {
  const report = blockedBrokerReport({
    update: {
      ...blockedBrokerReport().update,
      compatibility: {
        version: 1, policyVersion: 1, status: "conflict", fingerprint,
        binding: { beforeFingerprint: fingerprint, afterFingerprint: fingerprint, comparisonFingerprint: fingerprint, tweakersFingerprint: fingerprint, configurationFingerprint: fingerprint, candidateFingerprint: null, validationFingerprint: fingerprint },
        checks: [{ id: "patches", owner: "runtime", outcome: "conflict", expected: "Pass", observed: "Failed", evidence: [], nextAction: "Repair" }],
        repairs: [], postInstallChecks: [],
      },
    },
  });
  report.update.compatibility!.checks[0]!.evidence = [42 as unknown as string];
  const controller = createDoctorController({ status: async () => report, action: async () => report, onChange: () => undefined, isMounted: () => true });
  await controller.refresh();
  assert.equal(controller.snapshot.error, "Doctor status could not be loaded. Try scanning again.");
  controller.dispose();
});

test("Doctor actions use the exact visible fingerprint and disabled actions cannot fire", async () => {
  const requests: DoctorActionRequestV1[] = [];
  const report = blockedBrokerReport();
  const controller = createDoctorController({
    status: async () => report,
    action: async (request) => {
      requests.push(request);
      return { ...report, fingerprint: `sha256:${"b".repeat(64)}` };
    },
    onChange: () => undefined,
    isMounted: () => true,
  });

  await controller.refresh();
  assert.equal(await controller.perform("update"), false);
  assert.equal(requests.length, 0);
  assert.equal(await controller.perform("repair"), true);
  assert.deepEqual(requests, [{ schemaVersion: 1, action: "repair", fingerprint }]);
  controller.dispose();
});

test("Doctor leaves checking reports for an explicit refresh", async () => {
  let statusCalls = 0;
  const checking = blockedBrokerReport({
    update: { ...blockedBrokerReport().update, state: "checking" },
  });
  const controller = createDoctorController({
    status: async () => {
      statusCalls += 1;
      return checking;
    },
    action: async () => checking,
    onChange: () => undefined,
    isMounted: () => true,
  });

  await controller.refresh();
  assert.equal(statusCalls, 1);
  controller.dispose();
  assert.equal(statusCalls, 1);
});

test("Doctor accepts a cited optional explanation and rejects malformed citations", async () => {
  const cited = blockedBrokerReport({
    adoption: {
      schemaVersion: 1,
      state: "review_required",
      report: {
        fingerprint,
        limitations: [],
        coverage: { total: 1, classified: 1, unresolved: 0 },
        changes: [{
          id: "change-1", area: "runtime", title: "Example change", before: "Before", after: "After",
          status: "observed", technicalOnly: false, evidence: [], dependencies: [], compatibility: [], overrides: [],
          explanation: {
            summary: "A bounded explanation.",
            evidenceReferences: [{ id: "evidence-1", sha256: fingerprint }],
            sourceReferences: [{ path: "src/example.ts", sha256: fingerprint }],
          },
        }],
      },
      decisions: [], observations: [], blockers: [], fingerprint,
    },
  });
  const controller = createDoctorController({
    status: async () => cited,
    action: async () => cited,
    onChange: () => undefined,
    isMounted: () => true,
  });
  await controller.refresh();
  assert.equal(controller.snapshot.report?.adoption?.report.changes[0]?.explanation?.summary, "A bounded explanation.");
  controller.dispose();

  const invalid = structuredClone(cited);
  invalid.adoption!.report.changes[0]!.explanation!.sourceReferences[0]!.sha256 = "not-a-sha";
  const rejected = createDoctorController({
    status: async () => invalid,
    action: async () => invalid,
    onChange: () => undefined,
    isMounted: () => true,
  });
  await rejected.refresh();
  assert.equal(rejected.snapshot.error, "Doctor status could not be loaded. Try scanning again.");
  rejected.dispose();
});

test("Doctor changelog decisions disclose the same closure for entry and technical group IDs", () => {
  const report = {
    changes: [
      { id: "group-a", area: "runtime", title: "A", before: "a", after: "b", status: "observed" as const, technicalOnly: false, dependencies: ["group-b"], evidence: [], compatibility: [], overrides: [] },
      { id: "group-b", area: "runtime", title: "B", before: "a", after: "b", status: "observed" as const, technicalOnly: false, dependencies: [], evidence: [], compatibility: [], overrides: [] },
      { id: "group-c", area: "runtime", title: "C", before: "a", after: "b", status: "observed" as const, technicalOnly: false, dependencies: [], evidence: [], compatibility: [], overrides: [] },
    ],
    changelog: {
      schemaVersion: 1 as const,
      entries: [
        { id: "entry-a", category: "Changed" as const, title: "A", workflow: "Use A", before: "a", after: "b", status: "inferred_from_code" as const, origin: "tweakers" as const, evidenceReferences: [], limitations: [], dependencies: [], decisionDependencies: [] as string[], analysisGroupIds: ["group-a"] },
        { id: "entry-c", category: "Fixed" as const, title: "C", workflow: "Use C", before: "a", after: "b", status: "observed" as const, origin: "upstream" as const, evidenceReferences: [], limitations: [], dependencies: ["group-b"], decisionDependencies: [] as string[], analysisGroupIds: ["group-c"] },
      ],
      unresolved: [],
    },
  };
  assert.deepEqual(changelogDecisionGroups(report, "entry-a"), ["group-a"], "imports do not force unrelated decisions");
  report.changelog.entries[0]!.decisionDependencies = ["group-b"];
  report.changelog.entries[1]!.decisionDependencies = ["group-b"];
  assert.deepEqual(changelogDecisionGroups(report, "entry-a"), ["group-a", "group-b", "group-c"]);
  assert.deepEqual(changelogDecisionGroups(report, "group-a"), ["group-a", "group-b", "group-c"]);
});

import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { applyReviewedRetainedBackend20156, collectDoctorProtocolCoverage, matchesReviewedRetainedBackend20156, REVIEWED_RETAINED_BACKEND_20156 as pins } from "../src/doctor-protocol";
import type { DoctorSourceEvidence } from "../src/doctor-evidence";
import { setDoctorValidationDependenciesForTest, validateRetainedDoctorBackend } from "../src/doctor-validation";

const packet = process.env.TWEAKERS_TEST_20156_PACKET ?? join(process.env.HOME ?? "", "Library/Application Support/Tweakers/doctor/jobs/161d40fd-ba04-4b64-98a8-4eab4d83f58c");
const upstreamPath = join(packet, "evidence/after/doctor-source-evidence.json"), retainedPath = join(packet, "registered-backend-preflight/doctor-source-evidence.json");
const available = existsSync(upstreamPath) && existsSync(retainedPath);
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Retained fixture canonical JSON received a non-JSON value");
}

function retainedEvidenceFingerprint(evidence: DoctorSourceEvidence): DoctorSourceEvidence["fingerprint"] {
  // Match the collector/validator identity payload; appPath locates bytes but is not source identity.
  const payload = {
    schemaVersion: evidence.schemaVersion, kind: evidence.kind,
    ...(evidence.baselineFingerprint ? { baselineFingerprint: evidence.baselineFingerprint } : {}),
    version: evidence.version, build: evidence.build, backend: evidence.backend,
    shippedFiles: evidence.shippedFiles, asar: evidence.asar,
    schemas: { state: evidence.schemas.state, files: evidence.schemas.files,
      fingerprint: evidence.schemas.fingerprint, problem: evidence.schemas.problem },
    complete: evidence.complete, unresolvedEvidence: evidence.unresolvedEvidence,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function evidence(): [DoctorSourceEvidence, DoctorSourceEvidence] {
  const upstream: DoctorSourceEvidence = JSON.parse(readFileSync(upstreamPath, "utf8"));
  let retained: DoctorSourceEvidence = JSON.parse(readFileSync(retainedPath, "utf8"));
  const retainedApp = process.env.TWEAKERS_TEST_20156_RETAINED_APP;
  if (retainedApp !== undefined) {
    assert.ok(isAbsolute(retainedApp) && resolve(retainedApp) === retainedApp, "retained fixture app must be an exact absolute path");
    assert.equal(realpathSync(retainedApp), retainedApp, "retained fixture app must be canonical");
    assert.equal(statSync(retainedApp).isDirectory(), true, "retained fixture app must be an existing directory");
    assert.equal(retainedEvidenceFingerprint(retained), retained.fingerprint, "saved retained evidence identity must verify before rebinding");
    retained = structuredClone(retained);
    retained.appPath = retainedApp;
    retained.fingerprint = retainedEvidenceFingerprint(retained);
  }
  return [upstream, retained];
}

test("reviewed 20156 retained backend accepts only the four known differences after initialization proof", { skip: !available }, () => {
  const [upstream, retained] = evidence(), coverage = collectDoctorProtocolCoverage(upstream, retained);
  assert.equal(coverage.interfaces.filter(item => item.status === "incompatible").length, 4);
  assert.equal(applyReviewedRetainedBackend20156(coverage, upstream, retained, false, false), coverage);
  const reviewed = applyReviewedRetainedBackend20156(coverage, upstream, retained, false, true);
  assert.ok(reviewed.interfaces.every(item => item.status === "compatible"));
  assert.notEqual(reviewed.fingerprint, coverage.fingerprint);
  const unrelated = structuredClone(coverage);
  unrelated.interfaces.find(item => item.method === "thread/list")!.status = "incompatible";
  assert.equal(applyReviewedRetainedBackend20156(unrelated, upstream, retained, false, true).interfaces.find(item => item.method === "thread/list")!.status, "incompatible");
  const changedKnown = structuredClone(coverage);
  changedKnown.interfaces.find(item => item.method === "initialize")!.reasons.push("lost required field");
  assert.equal(applyReviewedRetainedBackend20156(changedKnown, upstream, retained, false, true), changedKnown);
});

test("20156 profile rejects changed source, backend version, schema inventory and stale binding", { skip: !available }, () => {
  const [upstream, retained] = evidence(), coverage = collectDoctorProtocolCoverage(upstream, retained);
  for (const mutate of [
    (u: DoctorSourceEvidence, _r: DoctorSourceEvidence) => { u.asar.sha256 = "sha256:changed"; },
    (_u: DoctorSourceEvidence, r: DoctorSourceEvidence) => { r.backend.version = "0.159.0"; },
    (_u: DoctorSourceEvidence, r: DoctorSourceEvidence) => { r.backend.sha256 = "sha256:changed"; },
    (_u: DoctorSourceEvidence, r: DoctorSourceEvidence) => { r.schemas.files[0]!.sha256 = "sha256:changed"; },
    (u: DoctorSourceEvidence, _r: DoctorSourceEvidence) => { u.asar.members.find(item => item.path === pins.routingPath)!.rawSha256 = "sha256:changed"; },
    (u: DoctorSourceEvidence, _r: DoctorSourceEvidence) => { u.fingerprint = "sha256:changed"; },
  ]) {
    const u = structuredClone(upstream), r = structuredClone(retained); mutate(u, r);
    assert.equal(applyReviewedRetainedBackend20156(coverage, u, r, false, true), coverage);
  }
});

test("20156 candidate must preserve reviewed callers and the byte-identical registered backend", { skip: !available }, () => {
  const [upstream, retained] = evidence();
  const candidate = { ...retained, build: upstream.build, version: upstream.version, asar: structuredClone(upstream.asar) };
  const renderer = candidate.asar.members.find(item => item.path === pins.rendererPath)!;
  renderer.rawSha256 = pins.candidateRendererSha256;
  assert.equal(matchesReviewedRetainedBackend20156(upstream, candidate, true), true);
  renderer.rawSha256 = "sha256:changed";
  assert.equal(matchesReviewedRetainedBackend20156(upstream, candidate, true), false);
  const routing = candidate.asar.members.find(item => item.path === pins.routingPath)!;
  for (const [routingHash, rendererHash] of [
    [pins.candidateAccountsRoutingSha256, pins.candidateAccountsRendererSha256],
    [pins.candidateSealedAccountsRoutingSha256, pins.candidateSealedAccountsRendererSha256],
    [pins.candidateRetentionV2RoutingSha256, pins.candidateRetentionV2RendererSha256],
    [pins.candidateAccountsRetentionV2RoutingSha256, pins.candidateAccountsRetentionV2RendererSha256],
    [pins.candidateSealedAccountsRetentionV2RoutingSha256, pins.candidateSealedAccountsRetentionV2RendererSha256],
  ]) {
    routing.rawSha256 = routingHash!; renderer.rawSha256 = rendererHash!;
    assert.equal(matchesReviewedRetainedBackend20156(upstream, candidate, true), true);
    routing.rawSha256 = "sha256:changed";
    assert.equal(matchesReviewedRetainedBackend20156(upstream, candidate, true), false);
    routing.rawSha256 = routingHash!; renderer.rawSha256 = "sha256:changed";
    assert.equal(matchesReviewedRetainedBackend20156(upstream, candidate, true), false);
  }
  assert.equal(matchesReviewedRetainedBackend20156(upstream, retained, true), false);
});

test("20156 preflight remains blocked when the isolated initialization probe fails", { skip: !available }, async () => {
  const [upstream, retained] = evidence(), output = realpathSync(mkdtempSync(join(tmpdir(), "retained-20156-test-")));
  let calls = 0;
  const restore = setDoctorValidationDependenciesForTest({
    async probeBackend(_executable, environment, cwd, profile) {
      calls++;
      assert.equal(profile, true);
      assert.equal(environment.CODEX_HOME, cwd);
      assert.notEqual(environment.HOME, process.env.HOME);
      return { state: "failed", summary: "initialization rejected", command: { argv: [], exitCode: 1, stdout: "", stderr: "rejected" } };
    },
  });
  try {
    assert.equal((await validateRetainedDoctorBackend(upstream, retained, output)).state, "failed");
    assert.equal(calls, 1);
  } finally {
    restore();
    const trash = process.env.HOME && join(process.env.HOME, ".Trash");
    if (trash && existsSync(trash)) renameSync(output, join(realpathSync(trash), output.split("/").at(-1)!));
  }
});

test("retained verification refuses an app-contained output before probes or writes", { skip: !available }, async () => {
  const [upstream, retained] = evidence();
  const output = join(retained.appPath, "rejected-doctor-evidence");
  let calls = 0;
  const restore = setDoctorValidationDependenciesForTest({ async probeBackend() { calls++; throw new Error("must not execute"); } });
  try {
    assert.equal(existsSync(output), false);
    await assert.rejects(validateRetainedDoctorBackend(upstream, retained, output), /outside app bundles/);
    assert.equal(calls, 0);
    assert.equal(existsSync(output), false);
  } finally { restore(); }
});

test("retained verification rejects a nonexistent output beneath an app symlink", { skip: !available }, async () => {
  const [upstream, retained] = evidence(), root = realpathSync(mkdtempSync(join(tmpdir(), "retained-alias-test-")));
  const alias = join(root, "app-link"), output = join(alias, "rejected-doctor-alias-evidence");
  symlinkSync(retained.appPath, alias);
  let calls = 0;
  const restore = setDoctorValidationDependenciesForTest({ async probeBackend() { calls++; throw new Error("must not execute"); } });
  try {
    assert.equal(existsSync(output), false);
    await assert.rejects(validateRetainedDoctorBackend(upstream, retained, output), /outside app bundles/);
    assert.equal(calls, 0);
    assert.equal(existsSync(output), false);
  } finally {
    restore();
    const trash = process.env.HOME && join(process.env.HOME, ".Trash");
    if (trash && existsSync(trash)) renameSync(root, join(realpathSync(trash), root.split("/").at(-1)!));
  }
});

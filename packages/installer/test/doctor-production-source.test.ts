import assert from "node:assert/strict";
import test from "node:test";
import { assertDoctorSuppliedNativeResume, assertDoctorSuppliedNativeSource, doctorSuppliedNativePolicyFromInspection, selectDoctorProductionSource, selectDoctorProductionSourceForRequest, selectDoctorSuppliedNativeSource } from "../src/doctor-updates.js";
import { isDoctorSuppliedNativeSourcePolicyV1, readDoctorUpdateJob, writeDoctorPrivateJson, type DoctorSuppliedNativeSourcePolicyV1 } from "../src/doctor-store.js";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopAppcastProbeResult } from "../src/desktop-appcast-probe.js";

const latest: DesktopAppcastProbeResult = {
  state: "update-available", latestMarketingVersion: "26.1007.21159", latestBuild: "20052",
  enclosureUrl: "https://persistent.oaistatic.com/codex-app-prod/20052.zip", enclosureLength: 100,
  feedUrl: "https://persistent.oaistatic.com/codex-app-prod/appcast.xml", detail: "selected production release",
};
const native = { version: "26.1007.21159", build: "20052" };

test("Doctor uses native bytes only for an exact production release match", () => {
  assert.equal(selectDoctorProductionSource(latest, native), "native");
  assert.equal(selectDoctorProductionSource(latest, { ...native, build: "20053" }), "download");
  assert.equal(selectDoctorProductionSource(latest, { ...native, build: "10954" }), "download");
  assert.equal(selectDoctorProductionSource(latest, { ...native, version: "preview" }), "download");
  assert.equal(selectDoctorProductionSource(latest, { version: null, build: null }), "download");
});

test("newer signed native bytes cannot replace missing production metadata", () => {
  assert.equal(selectDoctorProductionSource({ ...latest, state: "unavailable", latestMarketingVersion: null, latestBuild: null, enclosureUrl: null }, native), "unavailable");
  assert.equal(selectDoctorProductionSource({ ...latest, state: "unavailable" }, native), "unavailable");
  for (const key of ["latestMarketingVersion", "latestBuild", "enclosureUrl"] as const) {
    assert.equal(selectDoctorProductionSource({ ...latest, [key]: null }, native), "unavailable");
  }
});

test("a current production result never stages an independently newer native build", () => {
  assert.equal(selectDoctorProductionSource({ ...latest, state: "current", latestBuild: "10954", latestMarketingVersion: "26.917.71314" }, native), "current");
  assert.equal(selectDoctorProductionSource({ ...latest, state: "current" }, native), "current");
});

test("Doctor reviews a changed local runtime on the same current native release without a backend transition",()=>{
  const current={...latest,state:"current" as const};
  assert.equal(selectDoctorProductionSourceForRequest(current,native,undefined,undefined,true),"native");
  assert.equal(selectDoctorProductionSourceForRequest(current,native,undefined,undefined,false),"current");
  assert.equal(selectDoctorProductionSourceForRequest(current,{...native,build:"20053"},undefined,undefined,true),"current");
  assert.equal(selectDoctorProductionSourceForRequest({...current,state:"unavailable"},native,undefined,undefined,true),"unavailable");
  for(const key of ["enclosureUrl","latestBuild","latestMarketingVersion"] as const)
    assert.equal(selectDoctorProductionSourceForRequest({...current,[key]:null},native,undefined,undefined,true),"current");
});

const nativePolicy: DoctorSuppliedNativeSourcePolicyV1 = { version: 1, nativeIdentity: `sha256:${"a".repeat(64)}`,
  nativeVersion: "26.1011.20156", nativeBuild: "20156", sourceAppFingerprint: "b".repeat(64) };
const nativeInputs = { nativeIdentity: nativePolicy.nativeIdentity, nativeVersion: nativePolicy.nativeVersion, nativeBuild: nativePolicy.nativeBuild };

test("production inspection binds same-native source without inventing a transition and holds missing authority", () => {
  const selection = { sourceAppFingerprint: nativePolicy.sourceAppFingerprint };
  const policy = doctorSuppliedNativePolicyFromInspection(selection, nativeInputs);
  assert.deepEqual(policy, nativePolicy);
  assert.equal("request" in selection, false);
  assert.throws(() => doctorSuppliedNativePolicyFromInspection(undefined, nativeInputs), /cannot substitute a downloaded feed/);
  assert.throws(() => doctorSuppliedNativePolicyFromInspection(selection, { ...nativeInputs, nativeBuild: null }), /no exact native tuple/);
  assert.throws(() => doctorSuppliedNativePolicyFromInspection({ sourceAppFingerprint: "unverified" }, nativeInputs), /no exact native tuple/);
  assert.throws(() => assertDoctorSuppliedNativeSource(policy, { ...nativeInputs, nativeIdentity: `sha256:${"f".repeat(64)}` }, selection.sourceAppFingerprint), /no app allocation/);
});

test("verified supplied native runtime repair selects 20156 independently of feed 20324, while ordinary policy downloads", () => {
  const feed = { ...latest, latestMarketingVersion: "26.1012.20324", latestBuild: "20324" };
  const tuple = { version: nativeInputs.nativeVersion, build: nativeInputs.nativeBuild };
  assert.equal(selectDoctorProductionSource(feed, tuple), "download");
  assert.equal(selectDoctorSuppliedNativeSource(nativePolicy, nativeInputs, nativePolicy.sourceAppFingerprint, tuple, true), "native");
  assert.equal(selectDoctorProductionSource({ ...feed, state: "unavailable" }, tuple), "unavailable");
  assert.equal(selectDoctorSuppliedNativeSource(nativePolicy, nativeInputs, nativePolicy.sourceAppFingerprint, tuple, false), "current");
});

test("completed native update binds the new native tuple rather than an independently newer feed", () => {
  const updated = { ...nativePolicy, nativeIdentity: `sha256:${"c".repeat(64)}`, nativeVersion: "26.1012.20324", nativeBuild: "20324", sourceAppFingerprint: "d".repeat(64) };
  const installed = { version: nativePolicy.nativeVersion, build: nativePolicy.nativeBuild };
  const inputs = { nativeIdentity: updated.nativeIdentity, nativeVersion: updated.nativeVersion, nativeBuild: updated.nativeBuild };
  assert.equal(selectDoctorSuppliedNativeSource(updated, inputs, updated.sourceAppFingerprint, installed, false), "native");
  assert.throws(() => selectDoctorSuppliedNativeSource(nativePolicy, inputs, updated.sourceAppFingerprint, installed, false), /source changed/);
});

test("supplied native checks reject identity, version, build and frontend drift before allocation", () => {
  assert.doesNotThrow(() => assertDoctorSuppliedNativeSource(nativePolicy, nativeInputs, nativePolicy.sourceAppFingerprint));
  for (const changed of [{ ...nativeInputs, nativeIdentity: `sha256:${"e".repeat(64)}` }, { ...nativeInputs, nativeVersion: "other" }, { ...nativeInputs, nativeBuild: "20324" }]) {
    assert.throws(() => assertDoctorSuppliedNativeSource(nativePolicy, changed, nativePolicy.sourceAppFingerprint), /no app allocation/);
  }
  assert.throws(() => assertDoctorSuppliedNativeSource(nativePolicy, nativeInputs, "f".repeat(64)), /no app allocation/);
});

test("downloaded, missing-policy and mismatched-policy resumes cannot become native", () => {
  assert.doesNotThrow(() => assertDoctorSuppliedNativeResume(nativePolicy, { ...nativePolicy }, "native"));
  assert.throws(() => assertDoctorSuppliedNativeResume(nativePolicy, nativePolicy, "download"), /cannot resume/);
  assert.throws(() => assertDoctorSuppliedNativeResume(nativePolicy, undefined, "native"), /cannot resume/);
  assert.throws(() => assertDoctorSuppliedNativeResume(nativePolicy, { ...nativePolicy, nativeBuild: "20324" }, "native"), /cannot resume/);
});

test("optional supplied-native evidence validates syntax and origin while old jobs remain readable", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-native-policy-"))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = new Date().toISOString(), path = join(root, "doctor", "update.json");
  const job = { schemaVersion: 1, workflowVersion: 2, trigger: "manual", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", pid: 0,
    startedAt: now, updatedAt: now, nativeIdentity: nativePolicy.nativeIdentity, installedIdentity: "installed", runtimeFingerprint: "runtime",
    result: { state: "review_required", phase: "current" }, findings: [] };
  writeDoctorPrivateJson(path, job); assert.equal(readDoctorUpdateJob(root)!.suppliedNativeSourcePolicy, undefined);
  writeDoctorPrivateJson(path, { ...job, sourceOrigin: "native", suppliedNativeSourcePolicy: nativePolicy });
  assert.deepEqual(readDoctorUpdateJob(root)!.suppliedNativeSourcePolicy, nativePolicy);
  for (const invalid of [undefined, null, { ...nativePolicy, sourceAppFingerprint: "bad" }, { ...nativePolicy, nativeBuild: "unknown" }, { ...nativePolicy, alternateSource: "feed" }]) {
    assert.equal(isDoctorSuppliedNativeSourcePolicyV1(invalid), false);
  }
  for (const mutation of [{ sourceOrigin: "download" }, { nativeIdentity: `sha256:${"f".repeat(64)}` }, { suppliedNativeSourcePolicy: { ...nativePolicy, sourceAppFingerprint: "bad" } }]) {
    writeDoctorPrivateJson(path, { ...job, sourceOrigin: "native", suppliedNativeSourcePolicy: nativePolicy, ...mutation });
    assert.throws(() => readDoctorUpdateJob(root), /invalid/);
  }
});

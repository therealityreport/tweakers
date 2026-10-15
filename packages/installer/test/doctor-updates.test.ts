import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSubmittedDoctorUpdateJob, readDoctorUpstreamCurrency, recordDoctorUpstreamCurrency, startDoctorUpdateScan,
  selectDoctorProductionSourceForRequest, assertDoctorAcceptedNativeFrontend } from "../src/doctor-updates.js";
import type { AcceptedSharedNativeBackendTransitionRequestV1, AcceptedSharedNativeBackendTransitionRequestV2 } from "../src/shared-native-backend-transition.js";
import type { ManagerResolvedExecutableIdentityV1 } from "../src/manager-contract.js";
import { readDoctorUpdateJob, writeDoctorPrivateJson } from "../src/doctor-store.js";
import type { DesktopAppcastProbeResult } from "../src/desktop-appcast-probe.js";

const priorId = "11111111-1111-4111-8111-111111111111";
const newerId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const pinnedFrontend = "a".repeat(64);
const native = {version: "26.1007.30912", build: "20156"};
const acceptedRequest = {version: 1, prebuilt: {expectedSourceAppFingerprint: pinnedFrontend}} as AcceptedSharedNativeBackendTransitionRequestV1;

test("official supplied-backend repair pins the current native frontend without a custom build receipt", () => {
  const request = {version: 2, officialBundled: {expectedSourceAppFingerprint: pinnedFrontend}} as AcceptedSharedNativeBackendTransitionRequestV2;
  const latest = {state: "current"} as DesktopAppcastProbeResult;
  assert.equal(selectDoctorProductionSourceForRequest(latest, native, request, pinnedFrontend), "native");
  assert.throws(() => selectDoctorProductionSourceForRequest(latest, native, request, "b".repeat(64)), /no app allocation/);
});

test("explicit same-desktop backend repair enters native verification despite current appcast currency", () => {
  const latest = {state: "current", latestMarketingVersion: native.version, latestBuild: native.build} as DesktopAppcastProbeResult;
  assert.equal(selectDoctorProductionSourceForRequest(latest, native, acceptedRequest, pinnedFrontend), "native");
});

test("ordinary current and unavailable Doctor scans retain their terminal source selection", () => {
  for (const state of ["current", "unavailable"] as const) {
    const latest = {state} as DesktopAppcastProbeResult;
    assert.equal(selectDoctorProductionSourceForRequest(latest, native), state);
  }
});

test("newer or unavailable appcast metadata cannot switch an exact accepted repair to another source", () => {
  const newer = {state: "update-available", latestMarketingVersion: "26.1011.40000", latestBuild: "20200",
    enclosureUrl: "https://example.invalid/newer.dmg"} as DesktopAppcastProbeResult;
  assert.equal(selectDoctorProductionSourceForRequest(newer, native), "download", "ordinary update selection still selects the newer release");
  assert.equal(selectDoctorProductionSourceForRequest(newer, native, acceptedRequest, pinnedFrontend), "native");
  assert.equal(selectDoctorProductionSourceForRequest({state: "unavailable"} as DesktopAppcastProbeResult,
    native, acceptedRequest, pinnedFrontend), "native");
});

test("accepted native frontend drift rejects before verification or app allocation and rechecks remain strict", () => {
  const latest = {state: "current"} as DesktopAppcastProbeResult;
  for (const observed of [undefined, "missing", "b".repeat(64)]) {
    const effects: string[] = [];
    assert.throws(() => {
      selectDoctorProductionSourceForRequest(latest, native, acceptedRequest, observed);
      effects.push("signed-native-verification", "app-allocation");
    }, /differs from the exact pinned pristine source/);
    assert.deepEqual(effects, []);
  }
  assert.doesNotThrow(() => assertDoctorAcceptedNativeFrontend(acceptedRequest, pinnedFrontend));
  assert.throws(() => assertDoctorAcceptedNativeFrontend(acceptedRequest, "b".repeat(64)), /no app allocation/);
});

test("busy Doctor rejects an explicit backend replacement without dropping its request into the ordinary queue", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-busy-backend-")));
  const priorPreload = process.env.TWEAKERS_TEST_ROOT_PRELOAD, priorRoot = process.env.TWEAKERS_TEST_FALLBACK_ROOT;
  try {
    process.env.TWEAKERS_TEST_ROOT_PRELOAD = "active"; process.env.TWEAKERS_TEST_FALLBACK_ROOT = root;
    mkdirSync(join(root, "local-operation"), {mode: 0o700});
    writeFileSync(join(root, "local-operation", "operation.json"), JSON.stringify({version: 1, id: operationId, pid: process.pid,
      kind: "doctor:busy", startedAt: new Date().toISOString(), state: "running"}), {mode: 0o600});
    let readInputs = false, spawned = false;
    await assert.rejects(startDoctorUpdateScan(root, {} as ManagerResolvedExecutableIdentityV1, true, {
      acceptedBackendTransition: {version: 1} as AcceptedSharedNativeBackendTransitionRequestV1,
      inputs() {readInputs = true; throw new Error("unexpected input probe");},
      spawn() {spawned = true; throw new Error("unexpected worker");},
    }), /requires an idle Doctor scan/);
    assert.equal(readInputs, false); assert.equal(spawned, false);
    assert.equal(existsSync(join(root, "doctor", "queued-update.json")), false);
  } finally {
    if (priorPreload === undefined) delete process.env.TWEAKERS_TEST_ROOT_PRELOAD; else process.env.TWEAKERS_TEST_ROOT_PRELOAD = priorPreload;
    if (priorRoot === undefined) delete process.env.TWEAKERS_TEST_FALLBACK_ROOT; else process.env.TWEAKERS_TEST_FALLBACK_ROOT = priorRoot;
    rmSync(root, {recursive: true, force: true});
  }
});

test("submitted installation keeps its exact prior job after a newer scan", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-submitted-job-")));
  try {
    const prior = { schemaVersion: 1, id: priorId, result: { state: "compatible", phase: "candidate_verified" }, candidateReceipt: { identity: "prior-candidate" }, findings: [] };
    writeDoctorPrivateJson(join(root, "doctor", "jobs", priorId, "job.json"), prior);
    writeDoctorPrivateJson(join(root, "doctor", "update-operation.json"), { operationId, jobId: priorId });
    writeDoctorPrivateJson(join(root, "doctor", "update.json"), { ...prior, id: newerId, result: { state: "checking", phase: "discovering" } });
    const submitted = readSubmittedDoctorUpdateJob(root);
    assert.equal(submitted?.jobId, priorId);
    assert.equal(submitted?.operationId, operationId);
    assert.deepEqual(submitted?.job.candidateReceipt, prior.candidateReceipt);
    writeDoctorPrivateJson(join(root, "doctor", "update-operation.json"), { operationId, jobId: "../../unrelated" });
    assert.throws(() => readSubmittedDoctorUpdateJob(root), /identity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upstream currency survives new scan state without asserting installation acceptance", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-upstream-currency-")));
  try {
    const probe = { state: "current", latestMarketingVersion: "26.1009", latestBuild: "10009" } as DesktopAppcastProbeResult;
    recordDoctorUpstreamCurrency(root, { jobId: priorId, probe, installedVersion: "26.1009", installedBuild: "10009" });
    writeDoctorPrivateJson(join(root, "doctor", "update.json"), { schemaVersion: 1, id: newerId, result: { state: "review_required", phase: "promotion_failed" } });
    const currency = readDoctorUpstreamCurrency(root);
    assert.equal(currency?.state, "current");
    assert.equal(currency?.jobId, priorId);
    assert.equal(currency?.latestBuild, "10009");
    assert.equal("installed" in currency!, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


import { createTweakersManagerGenerationId, serializeTweakersManagerTargetSeal, tweakersManagerDescriptorPaths,
  TWEAKERS_MANAGER_LAUNCHER_NAME, TWEAKERS_MANAGER_SEAL_NAME } from "../src/manager-descriptor.js";
import { TWEAKERS_MANAGER_ID, MANAGER_PROTOCOL_VERSION } from "../src/manager-contract.js";
import { sameDoctorCandidateImplementation } from "../src/doctor-implementation.js";

function acceptedWorkerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-accepted-worker-")));
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const nodePath = join(root, "fixture-node"), launcherBytes = "fixture sealed launcher";
  writeFileSync(nodePath, "fixture pinned Node", {mode: 0o700});
  const sealInput = {managerId: TWEAKERS_MANAGER_ID, protocolVersion: MANAGER_PROTOCOL_VERSION,
    launcherSha256: hash(launcherBytes), nodePath, nodeSha256: hash(readFileSync(nodePath)),
    managerSha256: "b".repeat(64), managedRuntimeFingerprint: "c".repeat(64)};
  const generationId = createTweakersManagerGenerationId(sealInput), paths = tweakersManagerDescriptorPaths(root);
  const generationRoot = join(paths.generationsRoot, generationId), launcher = join(generationRoot, TWEAKERS_MANAGER_LAUNCHER_NAME);
  mkdirSync(generationRoot, {recursive: true, mode: 0o700});
  writeFileSync(launcher, launcherBytes, {mode: 0o500});
  const sealPath = join(generationRoot, TWEAKERS_MANAGER_SEAL_NAME);
  writeFileSync(sealPath, serializeTweakersManagerTargetSeal({...sealInput, generationId}), {mode: 0o600});
  const verified = {generationId, sealSha256: hash(readFileSync(sealPath)),
    moduleRoot: join(paths.managerRoot, "managed-runtime-generations", sealInput.managedRuntimeFingerprint, "packages", "installer", "dist"),
    runtimeRoot: join(paths.managerRoot, "runtime-generations", "d".repeat(64))};
  const scopes = {version: 1 as const, construction: `sha256:${"1".repeat(64)}`, verification: `sha256:${"2".repeat(64)}`,
    promotion: `sha256:${"3".repeat(64)}`, payload: `sha256:${"4".repeat(64)}`};
  const seenRoots: Array<[string | undefined, string | undefined]> = [], verifiedIds: string[] = [];
  let spawned = 0;
  const worker = Object.assign(new EventEmitter(), {unref() {}});
  const deps = { acceptedBackendTransition: acceptedRequest,
    inputs: () => ({root, variantRoot: root, runtimeRoot: verified.runtimeRoot, brokerRoot: join(root, "accounts-broker"),
      version: "1", build: "1", nativeVersion: native.version, nativeBuild: native.build,
      installedIdentity: `sha256:${pinnedFrontend}`, nativeIdentity: `sha256:${pinnedFrontend}`,
      runtimeFingerprint: scopes.payload, originalAsarHash: pinnedFrontend}),
    spawn: ((path: string, args: string[], options: {env?: object}) => {
      assert.equal(path, launcher); assert.equal(args[0], "doctor-run"); assert.deepEqual(options.env, {});
      spawned++; return worker;
    }) as unknown as typeof import("node:child_process").spawn,
    acceptedWorker: {
      canonicalManagerRoot: () => root,
      verifyGeneration: (id: string) => {verifiedIds.push(id); return verified;},
      implementationScopes: (moduleRoot?: string, runtimeRoot?: string) => {seenRoots.push([moduleRoot, runtimeRoot]); return scopes;},
      nodeIdentity: () => ({path: nodePath, sha256: hash(readFileSync(nodePath))}),
    },
  };
  const executable: ManagerResolvedExecutableIdentityV1 = {state: "resolved", path: launcher, sha256: sealInput.launcherSha256};
  const priorPreload = process.env.TWEAKERS_TEST_ROOT_PRELOAD, priorRoot = process.env.TWEAKERS_TEST_FALLBACK_ROOT;
  process.env.TWEAKERS_TEST_ROOT_PRELOAD = "active"; process.env.TWEAKERS_TEST_FALLBACK_ROOT = root;
  return {root, executable, deps, verified, scopes, seenRoots, verifiedIds, launcher, nodePath, sealPath,
    spawned: () => spawned, cleanup: () => {
      if (priorPreload === undefined) delete process.env.TWEAKERS_TEST_ROOT_PRELOAD; else process.env.TWEAKERS_TEST_ROOT_PRELOAD = priorPreload;
      if (priorRoot === undefined) delete process.env.TWEAKERS_TEST_FALLBACK_ROOT; else process.env.TWEAKERS_TEST_FALLBACK_ROOT = priorRoot;
      rmSync(root, {recursive: true, force: true});
    }};
}

test("accepted Doctor dispatch records scopes from the exact verified worker generation", async () => {
  const f = acceptedWorkerFixture(); try {
    await startDoctorUpdateScan(f.root, f.executable, true, f.deps);
    const job = readDoctorUpdateJob(f.root);
    assert.deepEqual(job?.implementationScopes, f.scopes);
    assert.deepEqual(f.verifiedIds, [f.verified.generationId]);
    assert.deepEqual(f.seenRoots, [[f.verified.moduleRoot, f.verified.runtimeRoot]]);
    assert.equal(f.spawned(), 1);
    assert.deepEqual(job?.acceptedBackendTransition, acceptedRequest);
    assert.equal(sameDoctorCandidateImplementation(job?.implementationScopes, {...f.scopes, payload: `sha256:${"5".repeat(64)}`}), false,
      "worker input mismatch remains a rejection");
  } finally {f.cleanup();}
});

for (const scenario of ["unknown launcher", "foreign root", "foreign launcher", "launcher hash mismatch", "linked launcher",
  "unknown generation", "different generation", "foreign verified roots", "Node path mismatch", "Node hash mismatch", "seal drift", "launcher drift"] as const) {
  test(`accepted Doctor dispatch rejects ${scenario} before job publication or spawn`, async () => {
    const f = acceptedWorkerFixture(); try {
      if (scenario === "unknown launcher") f.executable.state = "unresolved" as never;
      if (scenario === "foreign root") f.deps.acceptedWorker.canonicalManagerRoot = () => join(f.root, "foreign");
      if (scenario === "foreign launcher") f.executable.path = join(f.root, TWEAKERS_MANAGER_LAUNCHER_NAME);
      if (scenario === "launcher hash mismatch") f.executable.sha256 = "a".repeat(64);
      if (scenario === "linked launcher") {rmSync(f.launcher); symlinkSync(f.nodePath, f.launcher);}
      if (scenario === "unknown generation") f.deps.acceptedWorker.verifyGeneration = () => {throw new Error("Unknown retained generation");};
      if (scenario === "different generation") f.deps.acceptedWorker.verifyGeneration = () => ({...f.verified, generationId: "f".repeat(64)});
      if (scenario === "foreign verified roots") f.deps.acceptedWorker.verifyGeneration = () => ({...f.verified, moduleRoot: join(f.root, "foreign", "dist")});
      if (scenario === "Node path mismatch") f.deps.acceptedWorker.nodeIdentity = () => ({path: join(f.root, "other-node"), sha256: "a".repeat(64)});
      if (scenario === "Node hash mismatch") f.deps.acceptedWorker.nodeIdentity = () => ({path: f.nodePath, sha256: "a".repeat(64)});
      if (scenario === "seal drift" || scenario === "launcher drift") {
        f.deps.acceptedWorker.implementationScopes = () => {
          if (scenario === "launcher drift") chmodSync(f.launcher, 0o700);
          writeFileSync(scenario === "seal drift" ? f.sealPath : f.launcher, "changed after verification"); return f.scopes;
        };
      }
      await assert.rejects(startDoctorUpdateScan(f.root, f.executable, true, f.deps), /Accepted Doctor worker|Unknown retained generation/);
      assert.equal(f.spawned(), 0); assert.equal(readDoctorUpdateJob(f.root), null);
      assert.equal(existsSync(join(f.root, "doctor", "update.json")), false);
    } finally {f.cleanup();}
  });
}


test("ordinary Doctor dispatch retains local scopes without consulting accepted-worker dependencies", async () => {
  const f = acceptedWorkerFixture(); try {
    const {acceptedBackendTransition: _request, ...ordinary} = f.deps;
    ordinary.acceptedWorker.verifyGeneration = () => {throw new Error("ordinary dispatch must not inspect a replacement generation");};
    await startDoctorUpdateScan(f.root, f.executable, true, ordinary);
    assert.equal(f.spawned(), 1); assert.deepEqual(f.verifiedIds, []); assert.deepEqual(f.seenRoots, []);
    assert.equal(readDoctorUpdateJob(f.root)?.acceptedBackendTransition, undefined);
  } finally {f.cleanup();}
});

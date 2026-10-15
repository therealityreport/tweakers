import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDoctorNativeDownloadRetirementJob, doctorDownloadSourceIsSuperseded, readArtifactRetentionPolicy } from "../src/artifact-retirement";
import type { DoctorUpdateJobV1, DoctorSuppliedNativeSourcePolicyV1 } from "../src/doctor-store";

function suppliedNativeRetirementFixture() {
  const policy: DoctorSuppliedNativeSourcePolicyV1 = { version: 1, nativeIdentity: `sha256:${"a".repeat(64)}`,
    nativeVersion: "26.1011.20156", nativeBuild: "20156", sourceAppFingerprint: "b".repeat(64) };
  const job = { schemaVersion: 1, workflowVersion: 2, trigger: "manual", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    nativeIdentity: policy.nativeIdentity, sourceOrigin: "native", suppliedNativeSourcePolicy: policy,
    result: { state: "checking" } } as DoctorUpdateJobV1;
  return { policy, job, selection: { job, jobId: job.id,
    native: { nativeIdentity: policy.nativeIdentity, nativeVersion: policy.nativeVersion, nativeBuild: policy.nativeBuild },
    frontendFingerprint: policy.sourceAppFingerprint } };
}

test("newer disposable download is excluded only by an exact currently checking supplied-native job", () => {
  const f = suppliedNativeRetirementFixture(), newer = { build: "20324", version: "26.1012.20324" };
  assert.equal(doctorDownloadSourceIsSuperseded(newer, "20156"), false);
  assert.equal(doctorDownloadSourceIsSuperseded(newer, "20156", f.selection), true);
  assert.equal(doctorDownloadSourceIsSuperseded({ build: "20156", version: f.policy.nativeVersion }, "20156", f.selection), false);
  assert.equal(doctorDownloadSourceIsSuperseded({ build: "20156", version: "different-version" }, "20156", f.selection), true);
  assert.equal(doctorDownloadSourceIsSuperseded({ build: "20052", version: "old" }, "20156"), true);
  assert.equal(doctorDownloadSourceIsSuperseded({ build: "20156", version: "same" }, "20156"), false);
});

test("missing, downloaded, completed, superseded and differently bound jobs cannot waive download ordering", () => {
  const f = suppliedNativeRetirementFixture(), newer = { build: "20324", version: "newer" };
  const invalidJobs = [null, { ...f.job, sourceOrigin: "download" }, { ...f.job, workflowVersion: undefined },
    { ...f.job, result: { state: "compatible" } }, { ...f.job, suppliedNativeSourcePolicy: undefined },
    { ...f.job, suppliedNativeSourcePolicy: { ...f.policy, sourceAppFingerprint: "invalid" } },
    { ...f.job, nativeIdentity: `sha256:${"c".repeat(64)}` }, { ...f.job, supersededBy: "another-job" },
    { ...f.job, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }];
  for (const job of invalidJobs) assert.throws(() => doctorDownloadSourceIsSuperseded(newer, "20156", { ...f.selection, job: job as DoctorUpdateJobV1 | null }), /unverified/);
  assert.throws(() => doctorDownloadSourceIsSuperseded(newer, "20324", f.selection), /unverified/);
});

test("native identity, tuple and frontend changes revoke retirement authority before a move", () => {
  const f = suppliedNativeRetirementFixture();
  assert.deepEqual(assertDoctorNativeDownloadRetirementJob(f.job, f.job.id, "20156", f.selection.native, f.policy.sourceAppFingerprint), f.policy);
  for (const native of [{ ...f.selection.native, nativeIdentity: `sha256:${"d".repeat(64)}` },
    { ...f.selection.native, nativeVersion: "changed" }, { ...f.selection.native, nativeBuild: "20324" }]) {
    assert.throws(() => assertDoctorNativeDownloadRetirementJob(f.job, f.job.id, "20156", native, f.policy.sourceAppFingerprint), /unverified/);
  }
  assert.throws(() => assertDoctorNativeDownloadRetirementJob(f.job, f.job.id, "20156", f.selection.native, "e".repeat(64)), /unverified/);
});

test("retention defaults to Trash and supports explicit archival and legacy settings", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-retention-policy-"));
  try {
    assert.equal(readArtifactRetentionPolicy(root).archiveVolume, "/Volumes/SHOWS DB");
    assert.equal(readArtifactRetentionPolicy(root).retireTo, "trash");
    assert.equal(readArtifactRetentionPolicy(root).allowTrashFallback, true);
    const policy = { archiveVolume: "/Volumes/Archive", archiveVolumeUUID: null, allowTrashFallback: false };
    writeFileSync(join(root, "artifact-retention.json"), JSON.stringify(policy));
    assert.deepEqual(readArtifactRetentionPolicy(root), { ...policy, retireTo: "trash" });
    writeFileSync(join(root, "artifact-retention.json"), JSON.stringify({ retireTo: "archive" }));
    assert.equal(readArtifactRetentionPolicy(root).retireTo, "archive");
    for (const retireTo of [null, false, "delete", "", 1]) {
      writeFileSync(join(root, "artifact-retention.json"), JSON.stringify({ retireTo }));
      assert.throws(() => readArtifactRetentionPolicy(root), /Invalid artifact retention/);
    }
    writeFileSync(join(root, "artifact-retention.json"), JSON.stringify({ ...policy, archiveVolume: "/tmp/archive" }));
    assert.throws(() => readArtifactRetentionPolicy(root), /Invalid artifact retention/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retention settings never follow a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-retention-link-"));
  try {
    writeFileSync(join(root, "other.json"), "{}");
    symlinkSync("other.json", join(root, "artifact-retention.json"));
    assert.throws(() => readArtifactRetentionPolicy(root), /Unsafe artifact retention/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Two-version generation retention (fixture trees; never the live root).
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applyGenerationRetention, planGenerationRetention, type GenerationRetentionPlan } from "../src/generation-retention";
import { createTweakersManagerGenerationId, serializeTweakersManagerTargetSeal } from "../src/manager-descriptor";
import { acquireProcessLock } from "../src/process-lock";
import { sealArchiveTree } from "../src/doctor-baseline";
import { sealOfficialSourceTree } from "../src/official-source-registration";

const MANAGER_ID = "com.thomashulihan.tweakers";
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const writeJson = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };

function retentionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-generation-retention-")));
  const trashRoot = join(root, "Trash"); mkdirSync(trashRoot);
  const descriptorRoot = join(root, "menu-bar-descriptors");
  const manager = join(root, "managers", MANAGER_ID);
  const generation = (seed: string) => {
    const runtime = hex(`runtime-${seed}`), managed = hex(`managed-${seed}`);
    const bundle = `//# TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1=${runtime}\n//# TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1=${managed}\n`;
    const base = { managerId: MANAGER_ID, protocolVersion: 1, launcherSha256: hex("launcher"), nodePath: "/usr/local/bin/node",
      nodeSha256: hex("node"), managerSha256: createHash("sha256").update(bundle).digest("hex"), managedRuntimeFingerprint: managed } as const;
    const generationId = createTweakersManagerGenerationId(base);
    const dir = join(manager, "generations", generationId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "manager.mjs"), bundle);
    writeFileSync(join(dir, "target.seal"), serializeTweakersManagerTargetSeal({ ...base, generationId }));
    writeFileSync(join(dir, "Tweakers Manager Launcher"), "launcher");
    for (const [family, id] of [["runtime-generations", runtime], ["managed-runtime-generations", managed]] as const) {
      mkdirSync(join(manager, family, id, "lib"), { recursive: true, mode: 0o700 });
      writeFileSync(join(manager, family, id, "lib", "index.js"), `export const id = "${id}";\n`);
      symlinkSync("lib/index.js", join(manager, family, id, "entry.js"));
    }
    return { generationId, runtimeFingerprint: runtime, managedRuntimeFingerprint: managed, sealSha256: hex(`seal-${seed}`) };
  };
  const current = generation("current"), previous = generation("previous"), old = generation("old");
  writeJson(join(manager, "previous-generation.json"), { version: 1, current, previous });
  writeJson(join(descriptorRoot, `${MANAGER_ID}.json`), { executable: join(manager, "generations", current.generationId, "Tweakers Manager Launcher") });

  const doctor = join(root, "doctor"), jobs = join(doctor, "jobs"), baselines = join(root, "official-source", "baselines");
  const J = { old: uuid(1), previous: uuid(2), current: uuid(3), staleChecking: uuid(4), liveChecking: uuid(5), unreadable: uuid(6), installed: uuid(7), rollback: uuid(8) };
  const B = { previous: uuid(21), current: uuid(22), old: uuid(23) };
  for (const id of Object.values(B)) { mkdirSync(join(baselines, id), { recursive: true, mode: 0o700 }); writeFileSync(join(baselines, id, "baseline.json"), "{}"); }
  const job = (id: string, fields: Record<string, unknown>) => writeJson(join(jobs, id, "job.json"), { id, result: { state: "review_required" }, ...fields });
  job(J.old, { baselinePath: join(baselines, B.old) });
  job(J.previous, { predecessorId: J.old, baselinePath: join(baselines, B.previous) });
  job(J.current, { predecessorId: J.previous, baselinePath: join(baselines, B.current), runtimeFingerprint: old.runtimeFingerprint });
  job(J.staleChecking, { result: { state: "checking" } });
  job(J.liveChecking, { result: { state: "checking" } });
  mkdirSync(join(jobs, J.unreadable), { recursive: true }); writeFileSync(join(jobs, J.unreadable, "job.json"), "{not json");
  for (const id of [J.installed, J.rollback]) { mkdirSync(join(jobs, id, "candidate"), { recursive: true }); writeFileSync(join(jobs, id, "candidate", "state.json"), "{}"); }
  writeJson(join(doctor, "update.json"), { id: J.current, predecessorId: J.previous, baselinePath: join(baselines, B.current), result: { state: "review_required" } });
  mkdirSync(join(doctor, "analysis-checkpoints", hex("checkpoint"), ), { recursive: true }); writeFileSync(join(doctor, "analysis-checkpoints", hex("checkpoint"), "a.json"), "{}");

  const variant = join(root, "variants", "tweakers"), promotions = join(variant, "transactions", "variant-promotion");
  const P = { old: uuid(31), rollback: uuid(32), current: uuid(33) };
  for (const id of Object.values(P)) for (const family of ["previous", "builds"]) { mkdirSync(join(variant, family, id, "state"), { recursive: true }); writeFileSync(join(variant, family, id, "state", "x"), id); }
  writeJson(join(promotions, "active.json"), { version: 3, id: P.current });
  writeJson(join(promotions, `${P.current}.json`), { id: P.current, phase: "committed", candidate: join(jobs, J.installed, "candidate", "Tweakers.app"), activeReceipt: { hadDestination: true } });
  writeJson(join(promotions, `${P.rollback}.json`), { id: P.rollback, phase: "committed", candidate: join(jobs, J.rollback, "candidate", "Tweakers.app") });
  writeJson(join(promotions, `${P.old}.json`), { id: P.old, phase: "committed", candidate: join(jobs, J.old, "candidate", "Tweakers.app") });
  writeJson(join(variant, "previous", P.current, "active-receipt.json"), { version: 3, id: P.rollback });
  const options = { descriptorRoot, trashRoot, processCommands: () => [] as string[] };
  return { root, manager, doctor, jobs, baselines, variant, current, previous, old, J, B, P, options };
}
const decisions = (plan: GenerationRetentionPlan, family: string) => Object.fromEntries(plan.entries.filter(entry => entry.family === family).map(entry => [entry.name, entry.decision]));

test("generation retention keeps current + previous, referenced, locked and checking entries", () => {
  const f = retentionFixture();
  const worker = acquireProcessLock(join(f.doctor, `worker-${f.J.liveChecking}.lock`));
  try {
    const plan = planGenerationRetention(f.root, f.options);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(decisions(plan, "manager-generations"), { [f.current.generationId]: "keep", [f.previous.generationId]: "keep", [f.old.generationId]: "retire" });
    // The current Doctor job references the old runtime fingerprint, which pins it.
    assert.deepEqual(decisions(plan, "manager-runtime-generations"), { [f.current.runtimeFingerprint]: "keep", [f.previous.runtimeFingerprint]: "keep", [f.old.runtimeFingerprint]: "keep" });
    assert.deepEqual(decisions(plan, "manager-managed-runtime-generations"), { [f.current.managedRuntimeFingerprint]: "keep", [f.previous.managedRuntimeFingerprint]: "keep", [f.old.managedRuntimeFingerprint]: "retire" });
    assert.deepEqual(decisions(plan, "doctor-jobs"), {
      [f.J.old]: "retire", [f.J.previous]: "keep", [f.J.current]: "keep", [f.J.staleChecking]: "ambiguous",
      [f.J.liveChecking]: "keep", [f.J.unreadable]: "ambiguous", [f.J.installed]: "keep", [f.J.rollback]: "keep",
    });
    assert.deepEqual(decisions(plan, "official-source-baselines"), { [f.B.previous]: "keep", [f.B.current]: "keep", [f.B.old]: "retire" });
    for (const family of ["variant-previous", "variant-builds"]) assert.deepEqual(decisions(plan, family), { [f.P.old]: "retire", [f.P.rollback]: "keep", [f.P.current]: "keep" });
    assert.deepEqual(Object.values(decisions(plan, "doctor-analysis-checkpoints")), ["retire"]);
    const live = plan.entries.find(entry => entry.name === f.J.liveChecking)!;
    assert.match(live.reasons.join(";"), /live Doctor worker lock/);
    // A running process pins what it executes from.
    const running = planGenerationRetention(f.root, { ...f.options, processCommands: () => [`node ${join(f.manager, "generations", f.old.generationId, "manager.mjs")}`] });
    assert.equal(decisions(running, "manager-generations")[f.old.generationId], "keep");
    const stale = join(f.jobs, f.J.staleChecking, "job.json");
    writeJson(stale, { result: { state: "checking" }, supersededBy: f.J.current, pid: 2147483647 });
    assert.equal(decisions(planGenerationRetention(f.root, f.options), "doctor-jobs")[f.J.staleChecking], "retire");
    writeJson(stale, { result: { state: "checking" }, supersededBy: f.J.current, pid: process.pid });
    assert.equal(decisions(planGenerationRetention(f.root, f.options), "doctor-jobs")[f.J.staleChecking], "ambiguous");
  } finally { worker.release(); rmSync(f.root, { recursive: true, force: true }); }
});

test("generation retention retains a whole family when its references are unreadable", async () => {
  const f = retentionFixture();
  try {
    writeFileSync(join(f.manager, "previous-generation.json"), "{truncated");
    writeFileSync(join(f.variant, "transactions", "variant-promotion", "active.json"), "{truncated");
    const plan = planGenerationRetention(f.root, f.options);
    for (const family of ["manager-generations", "manager-runtime-generations", "manager-managed-runtime-generations", "variant-previous", "variant-builds", "doctor-jobs"]) {
      assert.ok(plan.families[family as keyof typeof plan.families].blocked, `${family} should be blocked`);
      assert.ok(plan.entries.filter(entry => entry.family === family).every(entry => entry.decision !== "retire"), `${family} must not retire anything`);
    }
    assert.match(plan.families["manager-generations"].blocked!, /previous-generation\.json is unreadable/);
    const trashRoot = f.options.trashRoot;
    const result = await applyGenerationRetention(f.root, plan, { ...f.options, trashRoot, assertArchive: () => { throw new Error("archive offline"); } });
    assert.ok(result.retired.every(row => !row.family.startsWith("manager-") && !row.family.startsWith("variant-") && row.family !== "doctor-jobs"));
    assert.ok(existsSync(join(f.manager, "generations", f.old.generationId)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Trash policy retires eligible generations without probing or creating archives", async () => {
  const f = retentionFixture();
  try {
    writeJson(join(f.root, "artifact-retention.json"), { retireTo: "trash", allowTrashFallback: false });
    let probes = 0;
    const archiveRoot = join(f.root, "must-not-exist");
    const plan = planGenerationRetention(f.root, f.options);
    const result = await applyGenerationRetention(f.root, plan, { ...f.options, archiveRoot, assertArchive: () => { probes++; throw new Error("archive must not be accessed"); } });
    assert.equal(probes, 0);
    assert.equal(existsSync(archiveRoot), false);
    assert.equal(result.retired.length, plan.entries.filter(entry => entry.decision === "retire").length);
    assert.deepEqual(result.skipped, []);
    for (const row of result.retired) {
      assert.equal(row.kind, "trash");
      assert.ok(existsSync(row.destination) && !existsSync(row.path));
      const receipt = JSON.parse(readFileSync(row.receipt, "utf8"));
      assert.equal(receipt.destinationKind, "trash");
      assert.equal(receipt.archiveSHA256, null);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("generation retention falls back to recoverable Trash when the archive is unavailable", async () => {
  const f = retentionFixture();
  try {
    writeJson(join(f.root, "artifact-retention.json"), { retireTo: "archive" });
    const trashRoot = f.options.trashRoot;
    const plan = planGenerationRetention(f.root, f.options);
    const result = await applyGenerationRetention(f.root, plan, { ...f.options, trashRoot, assertArchive: () => { throw new Error("archive offline"); } });
    const retiredNames = result.retired.map(row => row.name).sort();
    const expected = plan.entries.filter(entry => entry.decision === "retire").map(entry => entry.name).sort();
    assert.deepEqual(retiredNames, expected);
    assert.deepEqual(result.skipped, []);
    for (const row of result.retired) {
      assert.equal(row.kind, "trash");
      assert.ok(!existsSync(row.path) && existsSync(row.destination));
      const receipt = JSON.parse(readFileSync(row.receipt, "utf8"));
      assert.equal(receipt.phase, "retired"); assert.equal(receipt.destinationKind, "trash"); assert.match(receipt.archiveUnavailable, /archive offline/);
    }
    assert.ok(existsSync(join(f.manager, "generations", f.current.generationId)) && existsSync(join(f.manager, "generations", f.previous.generationId)));
    assert.ok(existsSync(join(f.jobs, f.J.staleChecking)) && existsSync(join(f.jobs, f.J.unreadable)));
    assert.equal(readdirSync(trashRoot).length, expected.length);
    assert.ok(existsSync(join(f.doctor, "adoption-history", `${f.J.old}.json`)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("generation retention archives with a verified tree seal before moving the original intact to Trash", async () => {
  const f = retentionFixture();
  try {
    writeJson(join(f.root, "artifact-retention.json"), { retireTo: "archive" });
    const archiveRoot = join(f.root, "archive-volume");
    const path = join(f.manager, "managed-runtime-generations", f.old.managedRuntimeFingerprint);
    if (process.platform === "darwin") execFileSync("/usr/bin/xattr", ["-w", "com.tweakers.retention-test", "retained metadata", path]);
    const seal = sealOfficialSourceTree(path);
    const plan = planGenerationRetention(f.root, f.options);
    const narrowed = { ...plan, entries: plan.entries.filter(entry => entry.path === path || entry.decision !== "retire") };
    const result = await applyGenerationRetention(f.root, narrowed, { ...f.options, archiveRoot, assertArchive: () => {}, processCommands: () => ["/usr/bin/unrelated"] });
    assert.equal(result.retired.length, 1, JSON.stringify(result.skipped));
    const [row] = result.retired;
    assert.equal(row!.kind, "archive");
    assert.equal(row!.destination, join(archiveRoot, "manager-managed-runtime-generations", `${f.old.managedRuntimeFingerprint}.tar`));
    assert.deepEqual(sealArchiveTree(row!.destination, f.old.managedRuntimeFingerprint), seal);
    assert.ok(!existsSync(path));
    const receipt = JSON.parse(readFileSync(row!.receipt, "utf8"));
    assert.equal(receipt.phase, "retired"); assert.match(receipt.archiveSHA256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.restorationVerified, true);
    assert.equal(join(receipt.localTrashDestination, ".."), f.options.trashRoot);
    assert.deepEqual(sealOfficialSourceTree(receipt.localTrashDestination), seal);
    if (process.platform === "darwin") {
      assert.equal(receipt.restorationFilesystem, "APFS-noexec");
      assert.match(receipt.metadataSHA256, /^[a-f0-9]{64}$/);
    }
    // Everything else stays until a later plan authorizes it.
    assert.ok(existsSync(join(f.manager, "generations", f.old.generationId)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("archive retirement preserves an artifact that gains a running consumer during verification", async () => {
  const f = retentionFixture();
  try {
    writeJson(join(f.root, "artifact-retention.json"), { retireTo: "archive" });
    const path = join(f.manager, "managed-runtime-generations", f.old.managedRuntimeFingerprint);
    let scans = 0;
    const options = { ...f.options, processCommands: () => ++scans >= 4 ? [`node ${join(f.manager, "generations", f.old.generationId, "manager.mjs")}`] : [] };
    const plan = planGenerationRetention(f.root, options);
    const narrowed = { ...plan, entries: plan.entries.filter(entry => entry.path === path || entry.decision !== "retire") };
    const result = await applyGenerationRetention(f.root, narrowed, { ...options, archiveRoot: join(f.root, "archive-volume"), assertArchive: () => {} });
    assert.equal(result.retired.length, 0);
    assert.ok(existsSync(path));
    assert.match(result.skipped[0]?.reason ?? "", /consumer|referenced|eligibility/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("archive retirement detects source changes during the final eligibility scan", async () => {
  const f = retentionFixture();
  try {
    writeJson(join(f.root, "artifact-retention.json"), { retireTo: "archive" });
    const path = join(f.manager, "managed-runtime-generations", f.old.managedRuntimeFingerprint);
    let scans = 0;
    const options = { ...f.options, processCommands: () => {
      if (++scans === 3) writeFileSync(join(path, "new-file"), "changed during eligibility");
      return [];
    } };
    const plan = planGenerationRetention(f.root, options);
    const narrowed = { ...plan, entries: plan.entries.filter(entry => entry.path === path || entry.decision !== "retire") };
    const result = await applyGenerationRetention(f.root, narrowed, { ...options, archiveRoot: join(f.root, "archive-volume"), assertArchive: () => {} });
    assert.equal(result.retired.length, 0);
    assert.equal(readFileSync(join(path, "new-file"), "utf8"), "changed during eligibility");
    assert.match(result.skipped[0]?.reason ?? "", /changed during retirement/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("historical archival preserves dangling and external links without following them", async () => {
  const f = retentionFixture();
  try {
    writeJson(join(f.root, "artifact-retention.json"), { retireTo: "archive" });
    const path = join(f.manager, "managed-runtime-generations", f.old.managedRuntimeFingerprint);
    const { openSync, ftruncateSync, closeSync } = await import("node:fs");
    const sparse = openSync(join(path, "old-metrics.pma"), "w");
    try { ftruncateSync(sparse, 8 * 1024 ** 2); } finally { closeSync(sparse); }
    symlinkSync("missing-cookie", join(path, "SingletonCookie"));
    symlinkSync("/tmp/nonexistent-historical-socket", join(path, "SingletonSocket"));
    const plan = planGenerationRetention(f.root, f.options);
    const narrowed = { ...plan, entries: plan.entries.filter(entry => entry.path === path || entry.decision !== "retire") };
    const result = await applyGenerationRetention(f.root, narrowed, { ...f.options, archiveRoot: join(f.root, "archive-volume"), assertArchive: () => {} });
    assert.equal(result.retired.length, 1, JSON.stringify(result.skipped));
    assert.ok(!existsSync(path));
    assert.equal(JSON.parse(readFileSync(result.retired[0]!.receipt, "utf8")).restorationVerified, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("Doctor retirement retains compact adoption continuity and refuses changed history", async () => {
  const { preserveDoctorAdoptionHistory, readDoctorAdoptionRecord } = await import("../src/doctor-adoption-history.js");
  const { writeDoctorPrivateJson } = await import("../src/doctor-store.js");
  const f = retentionFixture();
  try {
    const base = join(f.jobs, f.J.old);
    writeDoctorPrivateJson(join(base, "job.json"), { id: f.J.old, predecessorId: null, largeDiagnostic: "x".repeat(1024 * 1024) });
    writeDoctorPrivateJson(join(base, "changes.json"), { unrelatedDiagnostic: "x".repeat(1024 * 1024) });
    preserveDoctorAdoptionHistory(f.root, f.J.old);
    const saved = join(f.doctor, "adoption-history", `${f.J.old}.json`);
    assert.ok(readFileSync(saved).length < 1024);
    rmSync(base, { recursive: true });
    assert.deepEqual(readDoctorAdoptionRecord(f.root, f.J.old, "job.json"), { id: f.J.old, predecessorId: null });
    assert.equal(readDoctorAdoptionRecord(f.root, f.J.old, "decisions.json"), null);
    const body = JSON.parse(readFileSync(saved, "utf8"));
    body.job.predecessorId = f.J.previous;
    writeDoctorPrivateJson(saved, body);
    assert.throws(() => readDoctorAdoptionRecord(f.root, f.J.old, "job.json"), /history is invalid/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

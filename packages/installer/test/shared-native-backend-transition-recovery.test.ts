import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import * as prebuilt from "../src/prebuilt-combined-candidate.ts";
import * as compatibility from "../src/accounts-transfer-compatibility.ts";
import { computeRuntimeFingerprint, readRuntimeFingerprintEvidence } from "../src/runtime-fingerprint.ts";
import type { AcceptedSharedNativeBackendTransitionLaneV1 } from "../src/shared-native-backend-transition.ts";

// --experimental-test-module-mocks is required. Only existing signature,
// posture and architecture fixture seams are replaced. Receipt parsing, byte
// hashes, path checks and maintained recovery preparation/verifier remain real.
const closureMock = mock.module(new URL("../src/prebuilt-combined-candidate.ts", import.meta.url).href, {
  namedExports: { ...prebuilt, assertAcceptedBackendClosure: (receipt: Parameters<typeof prebuilt.assertAcceptedBackendClosure>[0]) =>
    prebuilt.assertAcceptedBackendClosure(receipt, { verifyBackendSignature: () => true,
      verifyCodeModeHostPosture: () => true, probeArchitecture: () => "arm64" }) },
});
const { assertAcceptedSharedNativeBackendTransitionClosure } = await import("../src/shared-native-backend-transition.ts");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const shaFile = (path: string) => sha(readFileSync(path));
const documentPath = (runtime: string) => join(runtime, "runtime-fingerprint.json");
const markerPath = (runtime: string) => join(runtime, "accounts-transfer-recovery.v1.json");
function publish(runtime: string) {
  chmodSync(documentPath(runtime), 0o600);
  writeFileSync(documentPath(runtime), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(runtime) }) + "\n");
}
function mutate(path: string, bytes: string) { chmodSync(path, 0o600); writeFileSync(path, bytes); }
function fixture(instrumentVerification = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "accepted-recovery-closure-")));
  const runtime = join(root, "runtime"), recovery = join(root, "recovery"), candidate = join(root, "candidate.app");
  cpSync(fileURLToPath(new URL("../assets/runtime", import.meta.url)), runtime, { recursive: true });
  // Stock candidate allocation is private; cpSync otherwise imports the public asset-root mode.
  chmodSync(runtime, 0o700);
  const sentinel = join(root, "verifier-executed");
  if (instrumentVerification) {
    const module = join(runtime, "account-router", "transfer-recovery.js");
    mutate(module, readFileSync(module, "utf8") + `\nconst realVerify=exports.verifyAccountsTransferRecovery;exports.verifyAccountsTransferRecovery=(root)=>{const ok=realVerify(root);require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed');const p=require('node:path').join(root,'accounts-transfer-recovery.v1.json');const bytes=require('node:fs').readFileSync(p);require('node:fs').writeFileSync(p,bytes);return ok;};\n`);
    publish(runtime);
  }
  const baseline = readRuntimeFingerprintEvidence(runtime)!;
  assert.ok(baseline, "fixture uses a real complete generated runtime");
  const signature = { identity: "fixture-signing", teamIdentifier: null, designatedRequirement: null };
  const binary = join(root, "codex"), host = join(root, "codex-code-mode-host");
  writeFileSync(binary, "accepted-backend"); writeFileSync(host, "accepted-helper");
  const resources = join(candidate, "Contents", "Resources"); mkdirSync(resources, { recursive: true });
  cpSync(binary, join(resources, "codex")); cpSync(host, join(resources, "codex-code-mode-host"));
  const receipt: prebuilt.AcceptedPrebuiltCodexBuildReceipt = {
    schemaVersion: 2, kind: "tweakers-prebuilt-codex-build", status: "accepted", acceptedAt: "2026-01-01T00:00:00Z",
    verification: { level: "source-verified", installedAcceptance: "required" },
    upstream: { repository: "https://github.com/openai/codex.git", tag: "rust-v0.162.0-alpha.17.2", commit: "a".repeat(40) },
    source: { commit: "a".repeat(40), tree: "b".repeat(40), cargoLockSha256: "c".repeat(64), reviewedDiffSha256: "d".repeat(64), patchSeriesSha256: "e".repeat(64) },
    build: { command: "cargo build --locked --release", toolchain: "fixture", architecture: "arm64" },
    tests: [{ name: "required source tests", command: "cargo test --locked", receiptSha256: "f".repeat(64), status: "passed" }],
    binary: { path: binary, sha256: shaFile(binary), version: "0.162.0-alpha.17.2", architecture: "arm64", signature },
    closure: { codeModeHost: { path: host, sha256: shaFile(host), architecture: "arm64", signature }, resources: [] },
    runtime: { sourceRoot: runtime, ...baseline, documentSha256: shaFile(documentPath(runtime)) },
  };
  const receiptPath = join(root, "accepted.json"); writeFileSync(receiptPath, JSON.stringify(receipt));
  const bare: Omit<prebuilt.PrebuiltCombinedCandidateAuthority, "payloadIdentity"> = {
    schemaVersion: 1, transactionId: "fixture-accepted", installerPayloadHash: "1".repeat(64),
    acceptedBuildReceipt: { path: receiptPath, sha256: shaFile(receiptPath), acceptedAt: receipt.acceptedAt,
      sourceCommit: receipt.source.commit, sourceTree: receipt.source.tree, cargoLockSha256: receipt.source.cargoLockSha256,
      reviewedDiffSha256: receipt.source.reviewedDiffSha256, patchSeriesSha256: receipt.source.patchSeriesSha256,
      upstream: receipt.upstream, verification: receipt.verification, buildCommand: receipt.build.command, toolchain: receipt.build.toolchain,
      testEvidence: receipt.tests.map(({ status: _status, ...evidence }) => evidence) },
    backend: { sourcePath: binary, sha256: receipt.binary.sha256, version: receipt.binary.version, architecture: "arm64", signature },
    closure: receipt.closure, runtime: receipt.runtime,
    sourceApp: { path: candidate, bundleId: "com.openai.codex", contentsFingerprint: "2".repeat(64) },
  };
  const authority = { ...bare, payloadIdentity: prebuilt.combinedPayloadIdentity(bare) };
  const lane: AcceptedSharedNativeBackendTransitionLaneV1 = { version: 1, authority,
    identity: { target: candidate, userRoot: join(root, "variant"), brokerRoot: join(root, "broker") },
    priorRegistrationFingerprint: `sha256:${"3".repeat(64)}`, priorResolverBinarySha256: "4".repeat(64) };
  const lastKnownGoodRoot = join(root, "last-good"), signedBackupRoot = join(root, "signed-backup"), signedBackupMarker = join(root, "backup.json");
  mkdirSync(lastKnownGoodRoot); mkdirSync(signedBackupRoot); writeFileSync(signedBackupMarker, JSON.stringify({ schemaVersion: 1, existed: true }));
  const paths = { candidateRoot: candidate, candidateRuntimeRoot: runtime, lastKnownGoodRoot,
    lastKnownGoodRuntimeRoot: runtime, signedBackupRoot, signedBackupMarker };
  const deps: Partial<prebuilt.PrebuiltCombinedCandidateValidationDependencies> = {
    probeVersion: () => receipt.binary.version, probeArchitecture: () => "arm64", verifyBackendSignature: () => true,
    verifyCodeModeHostPosture: () => true, verifyCandidateApp: () => true, verifyLastKnownGoodApp: () => true,
    verifySignedBackup: () => true, sourceAppBundleId: () => "com.openai.codex", sourceAppFingerprint: () => "5".repeat(64),
  };
  const prepare = () => compatibility.prepareProbedAccountsTransferRecovery(runtime, recovery);
  const closure = () => assertAcceptedSharedNativeBackendTransitionClosure(lane, candidate, runtime);
  const capture = () => prebuilt.capturePreparedPrebuiltCombinedCandidateEvidence(authority, paths, deps);
  return { root, runtime, recovery, sentinel, receipt, receiptPath, authority, lane, candidate, paths, deps, prepare, closure, capture };
}
function using(action: (f: ReturnType<typeof fixture>) => void, instrument = false) {
  const f = fixture(instrument); try { action(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

test("accepted closure preserves the exact unchanged baseline branch", () => using(f => {
  assert.doesNotThrow(f.closure);
  const observed = f.capture();
  assert.deepEqual(observed.stagedRuntime, readRuntimeFingerprintEvidence(f.runtime));
  assert.equal(observed.stagedRuntimeDocumentSha256, f.authority.runtime.documentSha256);
}));

test("accepted closure permits genuine maintained Accounts recovery and prepared evidence keeps the full tree", () => using(f => {
  const receiptBytes = readFileSync(f.receiptPath); const original = structuredClone(f.authority);
  f.prepare();
  assert.equal(compatibility.verifyProbedAccountsTransferRecovery(f.runtime), true);
  assert.doesNotThrow(f.closure);
  const observed = f.capture();
  assert.deepEqual(observed.stagedRuntime, readRuntimeFingerprintEvidence(f.runtime));
  assert.equal(observed.stagedRuntime.fileCount, f.authority.runtime.fileCount + 1);
  assert.notEqual(observed.stagedRuntime.fingerprint, f.authority.runtime.fingerprint);
  assert.equal(observed.stagedRuntimeDocumentSha256, shaFile(documentPath(f.runtime)));
  assert.notEqual(observed.stagedRuntimeDocumentSha256, f.authority.runtime.documentSha256);
  assert.doesNotThrow(() => prebuilt.assertPreparedPrebuiltCombinedCandidateEvidence(f.authority, observed, f.paths, f.deps));
  assert.deepEqual(f.authority, original); assert.deepEqual(readFileSync(f.receiptPath), receiptBytes);
}));

test("prepared evidence permits genuine maintained recovery without replacing the complete final identity", () => using(f => {
  f.prepare();
  const observed = f.capture();
  assert.deepEqual(observed.stagedRuntime, readRuntimeFingerprintEvidence(f.runtime));
  assert.equal(observed.stagedRuntime.fileCount, f.authority.runtime.fileCount + 1);
  assert.notEqual(observed.stagedRuntime.fingerprint, f.authority.runtime.fingerprint);
  assert.equal(observed.stagedRuntimeDocumentSha256, shaFile(documentPath(f.runtime)));
  assert.doesNotThrow(() => prebuilt.assertPreparedPrebuiltCombinedCandidateEvidence(f.authority, observed, f.paths, f.deps));
}));

for (const kind of ["unrelated-module", "extra-root", "nested-lookalike", "missing-baseline-file"] as const) {
  test(`accepted closure rejects ${kind} even with regenerated complete documents and recovery claims`, () => using(f => {
    f.prepare();
    if (kind === "unrelated-module") {
      const module = join(f.runtime, "account-router", "transfer-recovery.js");
      mutate(module, readFileSync(module, "utf8") + `\nrequire('node:fs').writeFileSync(${JSON.stringify(f.sentinel)},'unsafe execution');\n`);
    } else if (kind === "extra-root") writeFileSync(join(f.runtime, "extra.js"), "extra");
    else if (kind === "nested-lookalike") writeFileSync(join(f.runtime, "account-router", "accounts-transfer-recovery.v1.json"), "{}");
    else rmSync(join(f.runtime, "account-router", "native-transfer.js"));
    const marker = JSON.parse(readFileSync(markerPath(f.runtime), "utf8"));
    marker.sourceRuntimeFingerprint = f.authority.runtime.fingerprint;
    marker.sourceRuntimeFileCount = f.authority.runtime.fileCount;
    writeFileSync(markerPath(f.runtime), JSON.stringify(marker)); publish(f.runtime);
    assert.throws(f.closure, /generated runtime changed/);
    assert.throws(f.capture, /generated runtime changed/);
    assert.equal(existsSync(f.sentinel), false, "baseline binding must reject before candidate code is loaded");
  }));
}
for (const kind of ["linked-runtime", "linked-module", "linked-directory", "linked-marker", "linked-document", "nonregular-module", "nonregular-marker", "nonregular-document"] as const) {
  test(`accepted closure rejects ${kind} before executing runtime code`, () => using(f => {
    f.prepare();
    const target = kind === "linked-runtime" ? f.runtime : kind.endsWith("marker") ? markerPath(f.runtime) : kind.endsWith("document") ? documentPath(f.runtime)
      : kind === "linked-directory" ? join(f.runtime, "account-router") : join(f.runtime, "account-router", "transfer-recovery.js");
    const outside = join(f.root, "outside"); cpSync(target, outside, { recursive: true });
    rmSync(target, { recursive: true });
    if (kind.startsWith("nonregular")) mkdirSync(target); else symlinkSync(outside, target);
    assert.throws(f.closure, /generated runtime changed/);
    assert.throws(f.capture);
  }));
}
for (const kind of ["missing-recovery", "validation-tamper", "recovery-module-tamper", "source-claims", "noncanonical-document", "surplus-document-field"] as const) {
  test(`accepted closure rejects ${kind} in recovery evidence`, () => using(f => {
    f.prepare();
    if (kind === "missing-recovery") rmSync(f.recovery, { recursive: true });
    else if (kind === "validation-tamper") mutate(join(f.recovery, "accounts-transfer-validation.v1.json"), "{}\n");
    else if (kind === "recovery-module-tamper") {
      const module = join(f.recovery, "account-router", "native-transfer.js"); mutate(module, readFileSync(module, "utf8") + "\n// changed\n"); publish(f.recovery);
    } else if (kind === "source-claims") {
      const marker = JSON.parse(readFileSync(markerPath(f.runtime), "utf8")); marker.sourceRuntimeFingerprint = "6".repeat(64);
      writeFileSync(markerPath(f.runtime), JSON.stringify(marker)); publish(f.runtime);
    } else {
      const document = JSON.parse(readFileSync(documentPath(f.runtime), "utf8"));
      if (kind === "surplus-document-field") document.generatedAt = "2026-01-01T00:00:00Z";
      mutate(documentPath(f.runtime), JSON.stringify(document, null, 2) + "\n");
    }
    assert.throws(f.closure);
    assert.throws(f.capture);
  }));
}


for (const file of ["account-router/transfer-recovery.js", "accounts-transfer-validation.v1.json", "runtime-fingerprint.json"]) {
  test(`accepted closure rejects linked recovery entry ${file}`, () => using(f => {
    f.prepare();
    const target = join(f.recovery, file), outside = join(f.root, "outside");
    cpSync(target, outside); rmSync(target); symlinkSync(outside, target);
    assert.throws(f.closure); assert.throws(f.capture);
  }));
}

test("accepted closure refuses verification-time evidence changes after a genuine maintained verification", () => using(f => {
  f.prepare();
  assert.throws(f.closure, /evidence changed during verification/);
  assert.equal(readFileSync(f.sentinel, "utf8"), "executed", "a valid bound baseline reaches the maintained verifier");
}, true));

test("prepared full recovery identity rejects later marker drift even when its new semantics remain valid", () => using(f => {
  f.prepare(); const observed = f.capture();
  const marker = JSON.parse(readFileSync(markerPath(f.runtime), "utf8")); marker.verifiedAt = "2026-01-01T00:00:00Z";
  writeFileSync(markerPath(f.runtime), JSON.stringify(marker)); publish(f.runtime);
  assert.equal(compatibility.verifyProbedAccountsTransferRecovery(f.runtime), true);
  assert.throws(() => prebuilt.assertPreparedPrebuiltCombinedCandidateEvidence(f.authority, observed, f.paths, f.deps), /drifted after preparation/);
}));

test("an accepted baseline already containing a recovery marker cannot be rederived as a marker addition", () => using(f => {
  f.prepare();
  const acceptedRuntime = { ...readRuntimeFingerprintEvidence(f.runtime)!, documentSha256: shaFile(documentPath(f.runtime)) };
  const marker = JSON.parse(readFileSync(markerPath(f.runtime), "utf8")); marker.verifiedAt = "2026-01-01T00:00:00Z";
  writeFileSync(markerPath(f.runtime), JSON.stringify(marker)); publish(f.runtime);
  assert.throws(() => compatibility.assertAcceptedAccountsRecoveryRuntime(f.runtime, acceptedRuntime), /only the root recovery marker/);
}));

test("prepared recovery fallback cannot accept caller-supplied baseline projection as full observed evidence", () => using(f => {
  f.prepare();
  assert.throws(() => prebuilt.capturePreparedPrebuiltCombinedCandidateEvidence(f.authority, f.paths, {
    ...f.deps, runtimeEvidence: () => ({ fingerprint: f.authority.runtime.fingerprint, fileCount: f.authority.runtime.fileCount }),
  }), /observations differ/);
}));


test("accepted closure refuses actual SHOWS archive recovery before traversal or candidate execution", {
  skip: !existsSync("/Volumes/SHOWS DB") && "The actual archive is unavailable; no synthetic mount or archive write is permitted",
}, () => using(f => {
  f.prepare();
  const marker = JSON.parse(readFileSync(markerPath(f.runtime), "utf8"));
  marker.recoveryRuntimeRoot = "/Volumes/SHOWS DB";
  writeFileSync(markerPath(f.runtime), JSON.stringify(marker)); publish(f.runtime);
  assert.throws(f.closure, /Archive storage cannot execute Tweakers or provide active runtime dependencies/);
  assert.throws(f.capture, /Archive storage cannot execute Tweakers or provide active runtime dependencies/);
  assert.equal(existsSync(f.sentinel), false, "policy refusal precedes the instrumented verifier");
}, true));

test("accepted closure refuses public recovery root without changing candidate baseline privacy", () => using(f => {
  f.prepare(); chmodSync(f.recovery, 0o755);
  assert.throws(f.closure, /recovery root must be owner-private/);
  assert.throws(f.capture, /recovery root must be owner-private/);
  assert.equal(existsSync(f.sentinel), false, "privacy refusal precedes the instrumented verifier");
}, true));

test("accepted recovery closure and full prepared evidence survive candidate-to-installed runtime rename", () => using(f => {
  f.prepare(); const prepared = f.capture();
  const recoveryRoot = JSON.parse(readFileSync(markerPath(f.runtime), "utf8")).recoveryRuntimeRoot;
  const installed = join(f.root, "installed-runtime"); renameSync(f.runtime, installed);
  assert.equal(JSON.parse(readFileSync(markerPath(installed), "utf8")).recoveryRuntimeRoot, recoveryRoot);
  assert.equal(compatibility.verifyProbedAccountsTransferRecovery(installed), true);
  assert.doesNotThrow(() => assertAcceptedSharedNativeBackendTransitionClosure(f.lane, f.candidate, installed));
  const paths = { ...f.paths, candidateRuntimeRoot: installed, lastKnownGoodRuntimeRoot: installed };
  const observed = prebuilt.capturePreparedPrebuiltCombinedCandidateEvidence(f.authority, paths, f.deps);
  assert.deepEqual(observed.stagedRuntime, prepared.stagedRuntime);
  assert.equal(observed.stagedRuntimeDocumentSha256, prepared.stagedRuntimeDocumentSha256);
  assert.doesNotThrow(() => prebuilt.assertPreparedPrebuiltCombinedCandidateEvidence(f.authority, prepared, paths, f.deps));
}));


function completeBaselineEntries(root: string): Map<string, { bytes: Buffer | null; mode: number }> {
  const entries = new Map<string, { bytes: Buffer | null; mode: number }>();
  const walk = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const name = prefix + entry.name, file = join(directory, entry.name);
      if (name === "runtime-fingerprint.json" || name === "accounts-transfer-recovery.v1.json"
        || name === "accounts-transfer-validation.v1.json") continue;
      entries.set(name, { bytes: entry.isDirectory() ? null : readFileSync(file), mode: lstatSync(file).mode & 0o777 });
      if (entry.isDirectory()) walk(file, name + "/");
    }
  };
  walk(root); return entries;
}

test("public source produces public recovery and derived closure refuses it before verifier execution", () => using(f => {
  chmodSync(f.runtime, 0o755);
  const originalBaseline = completeBaselineEntries(f.runtime);
  const authorityBefore = structuredClone(f.authority);
  f.prepare();
  assert.equal(lstatSync(f.runtime).mode & 0o777, 0o755, "maintained preparation does not change the source root");
  assert.equal(lstatSync(f.recovery).mode & 0o777, 0o755, "maintained copy preserves the public source mode");
  assert.deepEqual(completeBaselineEntries(f.runtime), originalBaseline, "source bytes and child modes remain unchanged");
  assert.deepEqual(completeBaselineEntries(f.recovery), originalBaseline, "copied baseline bytes and child modes are unchanged");
  assert.throws(f.closure, /recovery root must be owner-private/);
  assert.throws(f.capture, /recovery root must be owner-private/);
  assert.equal(existsSync(f.sentinel), false, "guard refuses public recovery before the instrumented verifier executes");
  assert.deepEqual(f.authority, authorityBefore, "the accepted authority remains immutable");
}, true));

test.after(() => closureMock.restore());

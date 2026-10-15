import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CODEX_SOURCE_REQUIRED_RUST_TESTS, CODEX_SOURCE_RUST_TEST_COMMAND } from "../src/commands/codex-source.ts";
import { parseExactRustProof, qualificationPath, qualifiedRustShape, readQualifiedRustTests, revalidateQualifiedRustTests, verifyV8BuildInputs,
  OBSERVED_RUST_OVERRIDES, UNOBSERVED_ORIGINAL_RUST_KEYS, assertCurrentRustReuseEnvironment, assertNoUnreviewedCargoConfig, validateRetainedTestFingerprints,
  type EvidenceFile, type QualifiedRustTestQualification, type RustSourceIdentity } from "../src/qualified-rust-evidence.ts";
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const required = CODEX_SOURCE_REQUIRED_RUST_TESTS;
function greenLog() {
  const counts = [1, 4, 1, 1, 13, 1, 6, 10, 1]; let offset = 0;
  return counts.map(n => {
    const tests = required.slice(offset, offset += n).map(name => `test ${name} ... ok`).join("\n");
    return `${tests}\ntest result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.00s\n`;
  }).join("\n");
}
test("qualified Rust proofs require each exact name once and nine complete green packages", () => {
  const log = greenLog(); assert.equal(parseExactRustProof(log, "", required).length, 38);
  for (const invalid of [log + `test ${required[0]} ... ok\n`, log.replace(`${required[0]} ... ok`, `${required[0]} ... ignored`),
    log.replace(/0 failed/, "1 failed"), log.replace(/0 ignored/, "1 ignored"), log.replace(/test result: ok[^\n]+\n/, ""),
    log.replace(`test ${required[0]} ... ok\n`, ""), log + "error: cargo failed\n"]) {
    assert.throws(() => parseExactRustProof(invalid, "", required), /exactly 38/);
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rust-qualified-"))), prior = "prior-tx";
  const write = (path: string, bytes: string): EvidenceFile => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); return { path, sha256: sha(bytes) }; };
  const artifact = (name: string, data: unknown) => write(join(root, name), typeof data === "string" ? data : JSON.stringify(data));
  const priorRoot = join(root, "codex-source", "transactions", prior);
  const source: RustSourceIdentity = { commit: "a".repeat(40), tag: "rust-v0.162.0-alpha.17.2", treeSha256: "b".repeat(64), reviewedDiffSha256: "c".repeat(64), cargoLockSha256: "d".repeat(64), patchSeriesSha256: "e".repeat(64), patches: [] };
  const rustc = "rustc 1.95.0\ncommit-hash: abc\n";
  const rustcInfo = write(join(priorRoot, "source", "codex-rs", "target", ".rustc_info.json"), JSON.stringify({ outputs: { one: { success: true, code: 0, stdout: rustc } } }));
  const stdout = write(join(priorRoot, "prepared", "rust-lifecycle-tests", "cargo-test.stdout.log"), greenLog());
  const packages = ["codex-app-server", "codex-app-server-protocol", "codex-config", "codex-core", "codex-core-plugins", "codex-home", "codex-mcp", "codex-rmcp-client", "codex-secrets"];
  const fingerprints = packages.map((pkg, i) => {
    const suffix = i.toString(16).padStart(16, "0"), crate = pkg.replace(/-/g, "_");
    return { package: pkg, testExecutable: `${crate}-${suffix}`, fingerprint: write(join(priorRoot, "source", "codex-rs", "target", "debug", ".fingerprint", `${pkg}-${suffix}`, `test-lib-${crate}.json`),
      '{"rustc":2179919275645516985,"profile":5829779523522457634,"config":8247474407144887393,"rustflags":[],"compile_kind":0}') };
  });
  const stderr = write(join(priorRoot, "prepared", "rust-lifecycle-tests", "cargo-test.stderr.log"), fingerprints.map(f => `     Running unittests src/lib.rs (target/debug/deps/${f.testExecutable})`).join("\n") + "\n");
  const timing = { kind: "bounded-execution-window" as const, notBefore: "2026-10-12T03:09:22.271Z", notAfter: "2026-10-12T03:21:58.252Z" };
  const currentEnvironment = { ...OBSERVED_RUST_OVERRIDES };
  const runner = artifact("runner.ts", "frozen executed source");
  const wrapperLog = artifact("wrapper.log", "HTTP Error 404: Not Found\nwarning: build failed, waiting for other jobs to finish...\n");
  const preflightData = { transactionId: prior, userRoot: root, at: timing.notBefore, patches: [] };
  const preflight = artifact("preflight.json", preflightData);
  const invocation = artifact("invocation.json", { records: [
    { record: { timestamp: "2026-10-12T03:09:58.765Z", payload: { type: "custom_tool_call", call_id: "call", input: "scripts/local-work.mjs packages/installer/src/cli.ts codex-source --build-only --transaction-id pf.transactionId pf.userRoot CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0" } } },
    { record: { payload: { item: { aggregated_output: JSON.stringify(preflightData), exit_code: 0 } } } },
    { record: { payload: { type: "custom_tool_call_output", call_id: "call", output: [{ text: JSON.stringify({ transactionId: prior, session_id: 1 }) }] } } },
  ] });
  const failure = artifact("failure.json", { kind: "lead-observed-source-build-failure", transactionId: prior, sourceCommit: source.commit,
    buildExitCode: 1, liveMutation: false, candidateStateExists: false, failurePhase: "release-helper-v8-download", requiredRustTestResults: { observedProductionFlowAdvancedToReleaseBuild: true, structuredReceiptProduced: false, passedCount: 38, namedPassedTests: required },
    artifacts: Object.fromEntries([stdout, stderr, wrapperLog].map(f => [f.path, { sha256: f.sha256 }])) });
  const q: QualifiedRustTestQualification = { schemaVersion: 1, kind: "lead-qualified-codex-rust-tests", userRoot: root, priorTransactionId: prior,
    source, command: CODEX_SOURCE_RUST_TEST_COMMAND, timing, priorToolchain: { rustc, rustcInfo, cargo: null },
    observations: { kind: "partially-observed-original-environment", observedOverrides: OBSERVED_RUST_OVERRIDES, unobservedOriginalKeys: UNOBSERVED_ORIGINAL_RUST_KEYS, testLibFingerprints: fingerprints },
    execution: { kind: "frozen-runner-advanced-to-release", runner, invocation, wrapperLog, failure, preflight }, logs: { stdout, stderr } };
  const seal = () => write(qualificationPath(root, prior), JSON.stringify(q));
  const invoke = () => { const sealed = seal(); return readQualifiedRustTests({ userRoot: root, reuse: { transactionId: prior, acceptQualificationSha256: sealed.sha256 },
    source, rustc, command: CODEX_SOURCE_RUST_TEST_COMMAND, requiredTests: required, successorSourceRoot: join(root, "successor", "source"), currentEnvironment, inspectPriorSource: () => source }); };
  return { root, prior, source, q, seal, invoke, write, artifact, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test("qualified import preserves unknown Cargo and bounded timing, and reads old transaction without writes", () => {
  const f = fixture(); try { const before = readFileSync(f.q.logs.stdout.path); const result = f.invoke();
    assert.equal(result.passedTests.length, 38); assert.equal(result.qualification.priorToolchain.cargo, null);
    assert.equal(result.qualification.timing.kind, "bounded-execution-window"); assert.deepEqual(readFileSync(f.q.logs.stdout.path), before);
    assert.equal("startedAt" in result.qualification, false);
  } finally { f.cleanup(); }
});
test("qualified import rejects unaccepted hash, source/toolchain/environment drift and foreign transaction", () => {
  const f = fixture(); try {
    const accepted = f.seal(); const base = { userRoot: f.root, reuse: { transactionId: f.prior, acceptQualificationSha256: accepted.sha256 }, source: f.source,
      rustc: f.q.priorToolchain.rustc, command: CODEX_SOURCE_RUST_TEST_COMMAND, requiredTests: required, successorSourceRoot: join(f.root, "successor", "source"), currentEnvironment: { ...OBSERVED_RUST_OVERRIDES }, inspectPriorSource: () => f.source };
    for (const overrides of [{ reuse: { ...base.reuse, acceptQualificationSha256: "0".repeat(64) } }, { source: { ...f.source, cargoLockSha256: "f".repeat(64) } },
      { rustc: "other rustc" }, { currentEnvironment: {} }, { reuse: { ...base.reuse, transactionId: "foreign" } },
      { inspectPriorSource: () => ({ ...f.source, treeSha256: "f".repeat(64) }) }]) assert.throws(() => readQualifiedRustTests({ ...base, ...overrides }));
  } finally { f.cleanup(); }
});
test("qualified authority rejects public qualification files and symlinked logs", () => {
  const f = fixture(); try {
    const sealed = f.seal(); chmodSync(sealed.path, 0o644);
    assert.throws(() => readQualifiedRustTests({ userRoot: f.root, reuse: { transactionId: f.prior, acceptQualificationSha256: sealed.sha256 }, source: f.source, rustc: f.q.priorToolchain.rustc, command: CODEX_SOURCE_RUST_TEST_COMMAND, requiredTests: required, successorSourceRoot: join(f.root, "successor", "source"), currentEnvironment: { ...OBSERVED_RUST_OVERRIDES }, inspectPriorSource: () => f.source }), /Unsafe evidence/);
    chmodSync(sealed.path, 0o600); const original = f.q.logs.stdout.path; const alternate = f.artifact("alternate.log", greenLog());
    rmSync(original); symlinkSync(alternate.path, original); assert.throws(f.invoke, /canonical/);
  } finally { f.cleanup(); }
});
test("qualified schema rejects invented exact times and a fabricated original Cargo version", () => {
  const f = fixture(); try { const r = f.invoke(); const evidence = { schemaVersion: 2, kind: "codex-rust-lifecycle-tests", sourceCommit: f.source.commit,
    patchedTreeSha256: f.source.treeSha256, cargoLockSha256: f.source.cargoLockSha256, command: f.q.command, exitCode: 0, passedTests: r.passedTests,
    stdoutFile: f.q.logs.stdout.path, stdoutSha256: f.q.logs.stdout.sha256, stderrFile: f.q.logs.stderr.path, stderrSha256: f.q.logs.stderr.sha256, candidateBinarySha256: "1".repeat(64),
    origin: { kind: "lead-qualified-prior-transaction", userRoot: f.root, transactionId: f.prior, qualification: r.reference, timing: f.q.timing, priorToolchain: f.q.priorToolchain, observations: f.q.observations } };
    assert.equal(qualifiedRustShape(evidence), true); assert.equal(qualifiedRustShape({ ...evidence, startedAt: f.q.timing.notBefore }), false);
    assert.equal(qualifiedRustShape({ ...evidence, origin: { ...evidence.origin,
      environment: Object.fromEntries(UNOBSERVED_ORIGINAL_RUST_KEYS.map(key => [key, null])) } }), false);
    assert.equal(qualifiedRustShape({ ...evidence, origin: { ...evidence.origin, priorToolchain: { ...f.q.priorToolchain, cargo: "cargo 1.95" } } }), false);
  } finally { f.cleanup(); }
});
test("official V8 chain requires both exact manifest entries and pinned source trust", () => {
  const f = fixture(); try {
    const dir = join(f.root, "v8"), source = join(f.root, "source");
    const names = ["rusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.sha256", "librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz", "src_binding_ptrcomp_sandbox_release_aarch64-apple-darwin.rs"];
    const archive = f.write(join(dir, names[1]!), "archive"), binding = f.write(join(dir, names[2]!), "binding");
    const manifest = f.write(join(dir, names[0]!), `${archive.sha256}  ${names[1]}\n${binding.sha256}  ${names[2]}\n`);
    const anchor = f.write(join(source, "third_party", "v8", "rusty_v8_150_4_0_release_manifests.sha256"), `${manifest.sha256}  ${names[0]}\n`);
    f.write(join(source, "codex-rs", "Cargo.toml"), 'v8 = "=150.4.0"');
    const record = { schemaVersion: 1, kind: "verified-upstream-v8-build-inputs", upstreamCommit: f.source.commit,
      releaseUrl: "https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0", nativeMutation: false,
      trustAnchor: { ...anchor, manifestSha256: manifest.sha256 }, files: [manifest, archive, binding], overrides: { RUSTY_V8_ARCHIVE: archive.path, RUSTY_V8_SRC_BINDING_PATH: binding.path } };
    const seal = () => f.write(join(dir, "verification.json"), JSON.stringify(record));
    let v = seal(); assert.equal(verifyV8BuildInputs({ verificationPath: v.path, acceptVerificationSha256: v.sha256 }, source, f.source.commit, () => readFileSync(anchor.path, "utf8")).archive.sha256, archive.sha256);
    record.files.pop(); v = seal(); assert.throws(() => verifyV8BuildInputs({ verificationPath: v.path, acceptVerificationSha256: v.sha256 }, source, f.source.commit, () => readFileSync(anchor.path, "utf8")));
    record.files.push(binding); record.releaseUrl = "https://arbitrary.example/v150.4.0"; v = seal();
    assert.throws(() => verifyV8BuildInputs({ verificationPath: v.path, acceptVerificationSha256: v.sha256 }, source, f.source.commit, () => readFileSync(anchor.path, "utf8")));
  } finally { f.cleanup(); }
});

test("qualified observations reject invented original unset environment and stale failure-field alias", () => {
  const f = fixture(); try {
    assert.deepEqual(f.invoke().qualification.observations.unobservedOriginalKeys, UNOBSERVED_ORIGINAL_RUST_KEYS);
    Object.assign(f.q, { environment: Object.fromEntries(UNOBSERVED_ORIGINAL_RUST_KEYS.map(key => [key, null])) });
    assert.throws(f.invoke, /input identity/); delete (f.q as unknown as Record<string, unknown>).environment;
    const failure = JSON.parse(readFileSync(f.q.execution.failure.path, "utf8"));
    delete failure.requiredRustTestResults.observedProductionFlowAdvancedToReleaseBuild;
    failure.requiredRustTestResults.observedProductionFlowAdvancedToRelease = true;
    f.q.execution.failure = f.write(f.q.execution.failure.path, JSON.stringify(failure));
    assert.throws(f.invoke, /qualification is incomplete/);
  } finally { f.cleanup(); }
});

test("retained test fingerprints reject missing, modified and foreign executable facts", () => {
  const f = fixture(); try {
    const priorRoot = join(f.root, "codex-source", "transactions", f.prior);
    const files = f.q.observations.testLibFingerprints;
    const stderr = readFileSync(f.q.logs.stderr.path, "utf8");
    assert.doesNotThrow(() => validateRetainedTestFingerprints(files, priorRoot, stderr));
    assert.throws(() => validateRetainedTestFingerprints(files.slice(1), priorRoot, stderr), /nine/);
    assert.throws(() => validateRetainedTestFingerprints([{ ...files[0]!, testExecutable: "foreign-0000000000000000" }, ...files.slice(1)], priorRoot, stderr), /Foreign/);
    const first = files[0]!, original = readFileSync(first.fingerprint.path, "utf8");
    f.write(first.fingerprint.path, `${original}\n`);
    assert.throws(() => validateRetainedTestFingerprints(files, priorRoot, stderr), /accepted SHA/);
    rmSync(first.fingerprint.path);
    assert.throws(() => validateRetainedTestFingerprints(files, priorRoot, stderr));
    for (const changed of [original.replace('"rustflags":[]', '"rustflags":["--cfg=changed"]'),
      original.replace('"compile_kind":0', '"compile_kind":1'), original.replace('2179919275645516985', '2179919275645516986')]) {
      const fingerprint = f.write(first.fingerprint.path, changed);
      assert.throws(() => validateRetainedTestFingerprints([{ ...first, fingerprint }, ...files.slice(1)], priorRoot, stderr), /inconsistent/);
    }
  } finally { f.cleanup(); }
});

test("qualified observations hold on effective Cargo config outside the reviewed source", () => {
  const f = fixture(); try {
    const config = f.write(join(f.root, ".cargo", "config.toml"), '[build]\nrustflags = ["--cfg=unreviewed"]\n');
    assert.throws(() => assertNoUnreviewedCargoConfig(join(f.root, "successor", "source")), error =>
      error instanceof Error && error.message.includes("ancestor Cargo config") && error.message.includes(config.path));
    assert.throws(f.invoke, /ancestor Cargo config/);
  } finally { f.cleanup(); }
});

test("qualified successor rejects every unknown current compiler/target override", () => {
  assert.doesNotThrow(() => assertCurrentRustReuseEnvironment({ ...OBSERVED_RUST_OVERRIDES }));
  for (const key of [...UNOBSERVED_ORIGINAL_RUST_KEYS, "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS", "CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER", "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER"]) {
    assert.throws(() => assertCurrentRustReuseEnvironment({ ...OBSERVED_RUST_OVERRIDES, [key]: "" }), /rejects current/);
  }
});

test("official V8 chain rejects patched trust anchor even with self-consistent replacement manifest", () => {
  const f = fixture(); try {
    const dir = join(f.root, "v8"), source = join(f.root, "source");
    const names = ["rusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.sha256", "librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz", "src_binding_ptrcomp_sandbox_release_aarch64-apple-darwin.rs"];
    const archive = f.write(join(dir, names[1]!), "altered archive"), binding = f.write(join(dir, names[2]!), "binding");
    const manifest = f.write(join(dir, names[0]!), `${archive.sha256}  ${names[1]}\n${binding.sha256}  ${names[2]}\n`);
    const anchor = f.write(join(source, "third_party", "v8", "rusty_v8_150_4_0_release_manifests.sha256"), `${manifest.sha256}  ${names[0]}\n`);
    f.write(join(source, "codex-rs", "Cargo.toml"), 'v8 = "=150.4.0"');
    const verification = f.write(join(dir, "verification.json"), JSON.stringify({ schemaVersion: 1, kind: "verified-upstream-v8-build-inputs", upstreamCommit: f.source.commit,
      releaseUrl: "https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0", nativeMutation: false,
      trustAnchor: { ...anchor, manifestSha256: manifest.sha256 }, files: [manifest, archive, binding], overrides: { RUSTY_V8_ARCHIVE: archive.path, RUSTY_V8_SRC_BINDING_PATH: binding.path } }));
    assert.throws(() => verifyV8BuildInputs({ verificationPath: verification.path, acceptVerificationSha256: verification.sha256 }, source, f.source.commit,
      () => `${"0".repeat(64)}  ${names[0]}\n`), /unpatched upstream/);
  } finally { f.cleanup(); }
});


test("immutable qualified revalidation ignores verifier Cargo environment and config while build admission stays strict", () => {
  const f = fixture();
  const keys = [...Object.keys(OBSERVED_RUST_OVERRIDES), ...UNOBSERVED_ORIGINAL_RUST_KEYS, "CARGO_HOME"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const sealed = f.seal();
    const input = { userRoot: f.root, reuse: { transactionId: f.prior, acceptQualificationSha256: sealed.sha256 },
      source: f.source, rustc: f.q.priorToolchain.rustc, command: CODEX_SOURCE_RUST_TEST_COMMAND,
      requiredTests: required, inspectPriorSource: () => f.source };
    for (const key of keys) delete process.env[key];
    assert.equal(revalidateQualifiedRustTests(input).passedTests.length, 38);
    assert.throws(() => readQualifiedRustTests({ ...input, successorSourceRoot: join(f.root, "successor", "source") }), /rejects current/);
    process.env.RUSTFLAGS = "--cfg=verifier_only";
    process.env.CARGO_PROFILE_DEV_DEBUG = "2";
    process.env.CARGO_HOME = join(f.root, "verifier-cargo-home");
    f.write(join(process.env.CARGO_HOME, "config.toml"), '[build]\nrustflags = ["--cfg=verifier_only"]\n');
    assert.equal(revalidateQualifiedRustTests(input).passedTests.length, 38);
    assert.throws(() => readQualifiedRustTests({ ...input, successorSourceRoot: join(f.root, "successor", "source") }), /rejects current/);
    assert.throws(() => readQualifiedRustTests({ ...input, successorSourceRoot: join(f.root, "successor", "source"),
      currentEnvironment: { ...OBSERVED_RUST_OVERRIDES } }), /user Cargo config/);
    writeFileSync(f.q.logs.stdout.path, "mutated origin");
    assert.throws(() => revalidateQualifiedRustTests(input), /accepted SHA/);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    f.cleanup();
  }
});

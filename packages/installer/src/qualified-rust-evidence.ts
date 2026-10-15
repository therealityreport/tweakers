import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";

export interface EvidenceFile { path: string; sha256: string }
export interface RustReuseInput { transactionId: string; acceptQualificationSha256: string }
export interface VerifiedV8Input { verificationPath: string; acceptVerificationSha256: string }
export interface RustSourceIdentity {
  commit: string; tag: string; treeSha256: string; reviewedDiffSha256: string; cargoLockSha256: string;
  patchSeriesSha256: string; patches: readonly EvidenceFile[];
}
export const UNOBSERVED_ORIGINAL_RUST_KEYS = ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC", "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER", "RUSTUP_TOOLCHAIN", "CARGO_BUILD_TARGET", "CARGO_TARGET_DIR"] as const;
export const OBSERVED_RUST_OVERRIDES = { CARGO_BUILD_JOBS: "2", CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0", CARGO_INCREMENTAL: "0" } as const;
export interface RetainedTestLibFingerprint { package: string; testExecutable: string; fingerprint: EvidenceFile }
export interface QualifiedRustObservations {
  kind: "partially-observed-original-environment";
  observedOverrides: typeof OBSERVED_RUST_OVERRIDES;
  unobservedOriginalKeys: typeof UNOBSERVED_ORIGINAL_RUST_KEYS;
  testLibFingerprints: readonly RetainedTestLibFingerprint[];
}
export interface QualifiedRustTestQualification {
  schemaVersion: 1; kind: "lead-qualified-codex-rust-tests"; userRoot: string; priorTransactionId: string;
  source: RustSourceIdentity; command: readonly string[];
  timing: { kind: "bounded-execution-window"; notBefore: string; notAfter: string };
  priorToolchain: { rustc: string; rustcInfo: EvidenceFile; cargo: null };
  /** Retained passing behavior with explicitly incomplete original environment observation. */
  observations: QualifiedRustObservations;
  execution: { kind: "frozen-runner-advanced-to-release"; runner: EvidenceFile; invocation: EvidenceFile;
    wrapperLog: EvidenceFile; failure: EvidenceFile; preflight: EvidenceFile };
  logs: { stdout: EvidenceFile; stderr: EvidenceFile };
}
export interface QualifiedRustTestEvidence {
  schemaVersion: 2; kind: "codex-rust-lifecycle-tests";
  sourceCommit: string; patchedTreeSha256: string; cargoLockSha256: string;
  command: readonly string[]; exitCode: 0; passedTests: readonly string[];
  stdoutFile: string; stdoutSha256: string; stderrFile: string; stderrSha256: string;
  candidateBinarySha256: string;
  origin: { kind: "lead-qualified-prior-transaction"; userRoot: string; transactionId: string;
    qualification: EvidenceFile; timing: QualifiedRustTestQualification["timing"];
    priorToolchain: QualifiedRustTestQualification["priorToolchain"]; observations: QualifiedRustObservations };
}
export interface VerifiedV8BuildEvidence {
  schemaVersion: 1; kind: "verified-upstream-v8-build-inputs";
  version: "150.4.0"; profile: "ptrcomp_sandbox_release"; target: "aarch64-apple-darwin";
  verification: EvidenceFile; archive: EvidenceFile; binding: EvidenceFile; manifest: EvidenceFile;
  trustAnchorSha256: string;
}
const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const id = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const time = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const ref = (x: unknown): x is EvidenceFile => record(x) && typeof x.path === "string" && isAbsolute(x.path) && hash(x.sha256);

/** Read-only no-follow access; none of the qualification's paths are executable routes. */
export function readEvidenceFile(file: EvidenceFile, privateFile = false): Buffer {
  if (!ref(file) || resolve(file.path) !== file.path || realpathSync(file.path) !== file.path) throw new Error("Evidence path is not canonical");
  for (let p = dirname(file.path); ; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022) !== 0
      || (s.uid !== 0 && s.uid !== userInfo().uid)) throw new Error("Unsafe evidence ancestry");
    if (p === dirname(p)) break;
  }
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd), named = lstatSync(file.path);
    if (!s.isFile() || s.uid !== userInfo().uid || named.dev !== s.dev || named.ino !== s.ino
      || (s.mode & 0o022) !== 0 || (privateFile && (s.mode & 0o077) !== 0)) throw new Error("Unsafe evidence file");
    const bytes = readFileSync(fd);
    if (digest(bytes) !== file.sha256) throw new Error("Evidence bytes differ from accepted SHA-256");
    if (realpathSync(file.path) !== file.path || lstatSync(file.path).ino !== s.ino) throw new Error("Evidence identity changed during read");
    return bytes;
  } finally { closeSync(fd); }
}
export function qualificationPath(userRoot: string, transactionId: string): string {
  if (!id(transactionId) || !isAbsolute(userRoot) || resolve(userRoot) !== userRoot || realpathSync(userRoot) !== userRoot) throw new Error("Invalid qualification root/transaction");
  return join(userRoot, "codex-source", "qualifications", `${transactionId}.json`);
}
/** Reject name-only green output, ignored proofs, duplicates and partial package execution. */
export function parseExactRustProof(stdout: string, stderr: string, required: readonly string[]): readonly string[] {
  const text = `${stdout}\n${stderr}`;
  const names = [...text.matchAll(/^test\s+(\S+)\s+\.\.\.\s+ok\s*$/gm)].map(m => m[1]!).sort();
  const summaries = [...stdout.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; \d+ filtered out; finished in .+$/gm)];
  if (required.length !== 38 || new Set(required).size !== required.length || new Set(names).size !== names.length
    || !same(names, [...required].sort()) || summaries.length !== 9
    || summaries.some(m => m[2] !== "0" || m[3] !== "0" || m[4] !== "0")
    || summaries.reduce((n, m) => n + Number(m[1]), 0) !== required.length
    || /^test\s+\S+\s+\.\.\.\s+(?:FAILED|ignored)/m.test(text)
    || /^(?:error:|test result: FAILED|failures:)/m.test(text)) throw new Error("Rust logs lack exactly 38 successful proofs and nine green package summaries");
  return names;
}
export function qualifiedRustShape(x: unknown): x is QualifiedRustTestEvidence {
  return record(x) && x.schemaVersion === 2 && x.kind === "codex-rust-lifecycle-tests"
    && /^[a-f0-9]{40}$/.test(x.sourceCommit) && hash(x.patchedTreeSha256) && hash(x.cargoLockSha256)
    && hash(x.candidateBinarySha256) && x.exitCode === 0 && Array.isArray(x.command)
    && x.command.every((s: unknown) => typeof s === "string") && Array.isArray(x.passedTests)
    && x.passedTests.every((s: unknown) => typeof s === "string") && ref({ path: x.stdoutFile, sha256: x.stdoutSha256 })
    && ref({ path: x.stderrFile, sha256: x.stderrSha256 }) && record(x.origin)
    && x.origin.kind === "lead-qualified-prior-transaction" && id(x.origin.transactionId)
    && typeof x.origin.userRoot === "string" && ref(x.origin.qualification)
    && record(x.origin.timing) && x.origin.timing.kind === "bounded-execution-window"
    && time(x.origin.timing.notBefore) && time(x.origin.timing.notAfter)
    && Date.parse(x.origin.timing.notBefore) <= Date.parse(x.origin.timing.notAfter)
    && observationsShape(x.origin.observations)
    && !("environment" in x.origin)
    && record(x.origin.priorToolchain) && x.origin.priorToolchain.cargo === null
    && typeof x.origin.priorToolchain.rustc === "string" && ref(x.origin.priorToolchain.rustcInfo)
    && !("startedAt" in x) && !("completedAt" in x);
}
function observationsShape(x: unknown): x is QualifiedRustObservations {
  return record(x) && x.kind === "partially-observed-original-environment"
    && same(Object.keys(x).sort(), ["kind", "observedOverrides", "testLibFingerprints", "unobservedOriginalKeys"].sort())
    && same(x.observedOverrides, OBSERVED_RUST_OVERRIDES) && same(x.unobservedOriginalKeys, UNOBSERVED_ORIGINAL_RUST_KEYS)
    && Array.isArray(x.testLibFingerprints) && x.testLibFingerprints.length === 9
    && x.testLibFingerprints.every((f: unknown) => record(f) && typeof f.package === "string"
      && typeof f.testExecutable === "string" && ref(f.fingerprint));
}
/** This constrains the successor; it does not reconstruct the original inherited environment. */
export function assertCurrentRustReuseEnvironment(env: NodeJS.ProcessEnv): void {
  if (!same(Object.fromEntries(Object.keys(OBSERVED_RUST_OVERRIDES).map(key => [key, env[key]])), OBSERVED_RUST_OVERRIDES)
    || UNOBSERVED_ORIGINAL_RUST_KEYS.some(key => env[key] !== undefined)
    || Object.keys(env).some(key => /^CARGO_TARGET_.+_(?:RUSTFLAGS|LINKER|RUNNER)$/.test(key) && env[key] !== undefined)) {
    throw new Error("Qualified observation import rejects current compiler/wrapper/toolchain/target overrides");
  }
}
/** Cargo configs outside the reviewed source tree require separate factual review. */
export function assertNoUnreviewedCargoConfig(sourceRoot: string): void {
  for (let p = dirname(sourceRoot); ; p = dirname(p)) {
    for (const name of ["config", "config.toml"]) {
      const path = join(p, ".cargo", name);
      if (existsSync(path)) throw new Error(`Qualified observations require review of effective ancestor Cargo config: ${path}`);
    }
    if (p === dirname(p)) break;
  }
  for (const name of ["config", "config.toml"]) {
    const path = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), name);
    if (existsSync(path)) throw new Error(`Qualified observations require review of effective user Cargo config: ${path}`);
  }
}
const TEST_PACKAGES = ["codex-app-server", "codex-app-server-protocol", "codex-config", "codex-core", "codex-core-plugins",
  "codex-home", "codex-mcp", "codex-rmcp-client", "codex-secrets"] as const;
export function validateRetainedTestFingerprints(files: readonly RetainedTestLibFingerprint[], priorRoot: string, stderr: string): void {
  const executables = [...stderr.matchAll(/^\s*Running unittests src\/lib\.rs \(target\/debug\/deps\/([^()\s]+)\)\s*$/gm)].map(m => m[1]!);
  if (files.length !== 9 || executables.length !== 9 || new Set(executables).size !== 9
    || !same(files.map(f => f.package).sort(), [...TEST_PACKAGES].sort())) throw new Error("Expected nine exact retained test-lib fingerprints");
  let coherent: readonly string[] | undefined;
  for (const f of files) {
    const crate = f.package.replace(/-/g, "_");
    const suffix = new RegExp(`^${crate}-([a-f0-9]{16})$`).exec(f.testExecutable)?.[1];
    const expected = join(priorRoot, "source", "codex-rs", "target", "debug", ".fingerprint", `${f.package}-${suffix}`, `test-lib-${crate}.json`);
    if (!suffix || !executables.includes(f.testExecutable) || f.fingerprint.path !== expected) throw new Error("Foreign test executable/fingerprint path");
    const bytes = readEvidenceFile(f.fingerprint).toString("utf8"), data = JSON.parse(bytes);
    // Cargo stores u64 facts. Keep their exact decimal bytes rather than rounded JS numbers.
    const identity = ["rustc", "profile", "config"].map(key => {
      const matches = [...bytes.matchAll(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g"))];
      if (matches.length !== 1) throw new Error("Missing exact fingerprint numeric identity");
      return matches[0]![1]!;
    });
    if (!same(data.rustflags, []) || data.compile_kind !== 0 || (coherent && !same(identity, coherent))) throw new Error("Retained test fingerprint observations are inconsistent");
    coherent = identity;
  }
}

export interface QualifiedRustRevalidationInput {
  userRoot: string; reuse: RustReuseInput; source: RustSourceIdentity; rustc: string;
  command: readonly string[]; requiredTests: readonly string[];
  inspectPriorSource(root: string): RustSourceIdentity;
}

/** Admission before a fresh successor may skip Rust execution. All current build guards apply. */
export function readQualifiedRustTests(input: QualifiedRustRevalidationInput & {
  successorSourceRoot: string; currentEnvironment?: NodeJS.ProcessEnv;
}): ReturnType<typeof revalidateQualifiedRustTests> {
  assertCurrentRustReuseEnvironment(input.currentEnvironment ?? { ...process.env, CARGO_BUILD_JOBS: "2" });
  assertNoUnreviewedCargoConfig(join(input.userRoot, "codex-source", "transactions", input.reuse.transactionId, "source"));
  assertNoUnreviewedCargoConfig(input.successorSourceRoot);
  return revalidateQualifiedRustTests(input);
}

/** Read only the immutable accepted origin; this API neither executes nor admits a build. */
export function revalidateQualifiedRustTests(input: QualifiedRustRevalidationInput): {
  qualification: QualifiedRustTestQualification; reference: EvidenceFile;
  stdout: Buffer; stderr: Buffer; passedTests: readonly string[];
} {
  const reference = { path: qualificationPath(input.userRoot, input.reuse.transactionId), sha256: input.reuse.acceptQualificationSha256 };
  const qualificationDirectory = lstatSync(dirname(reference.path));
  if (qualificationDirectory.uid !== userInfo().uid || (qualificationDirectory.mode & 0o077) !== 0) throw new Error("Qualification directory must already be owner-private");
  const q = JSON.parse(readEvidenceFile(reference, true).toString("utf8")) as QualifiedRustTestQualification;
  const priorRoot = join(input.userRoot, "codex-source", "transactions", input.reuse.transactionId);
  if (q.schemaVersion !== 1 || q.kind !== "lead-qualified-codex-rust-tests" || q.userRoot !== input.userRoot
    || q.priorTransactionId !== input.reuse.transactionId || !same(q.source, input.source)
    || !same(q.source, input.inspectPriorSource(join(priorRoot, "source"))) || !same(q.command, input.command)
    || !q.timing || q.timing.kind !== "bounded-execution-window" || !time(q.timing.notBefore) || !time(q.timing.notAfter)
    || Date.parse(q.timing.notBefore) > Date.parse(q.timing.notAfter)
    || !q.priorToolchain || q.priorToolchain.cargo !== null || q.priorToolchain.rustc !== input.rustc
    || q.priorToolchain.rustcInfo.path !== join(priorRoot, "source", "codex-rs", "target", ".rustc_info.json")
    || "environment" in q || !observationsShape(q.observations)) throw new Error("Qualified Rust input identity differs from successor");
  const rustInfo = JSON.parse(readEvidenceFile(q.priorToolchain.rustcInfo).toString("utf8"));
  const outputs = Object.values(rustInfo.outputs ?? {}).filter((o: any) => o.success === true && o.code === 0
    && typeof o.stdout === "string" && o.stdout.startsWith("rustc ") && o.stdout.includes("\ncommit-hash: ")) as { stdout: string }[];
  if (outputs.length !== 1 || outputs[0]!.stdout !== input.rustc) throw new Error("Prior exact rustc cannot be reconstructed");
  if (!q.execution || q.execution.kind !== "frozen-runner-advanced-to-release") throw new Error("Qualification lacks executed runner evidence");
  const runner = readEvidenceFile(q.execution.runner);
  const invocation = JSON.parse(readEvidenceFile(q.execution.invocation).toString("utf8"));
  const failure = JSON.parse(readEvidenceFile(q.execution.failure).toString("utf8"));
  const preflight = JSON.parse(readEvidenceFile(q.execution.preflight).toString("utf8"));
  const wrapper = readEvidenceFile(q.execution.wrapperLog).toString("utf8");
  const invocationRecords = invocation.records;
  const call = Array.isArray(invocationRecords) ? invocationRecords.find((r: any) => r.record?.payload?.type === "custom_tool_call")?.record : null;
  const callText = call?.payload?.input;
  const launched = Array.isArray(invocationRecords) ? invocationRecords.some((r: any) => r.record?.payload?.type === "custom_tool_call_output"
    && r.record.payload.call_id === call?.payload?.call_id && r.record.payload.output?.some((o: any) => {
      try { const v = JSON.parse(o.text); return v.transactionId === q.priorTransactionId && Number.isInteger(v.session_id); } catch { return false; }
    })) : false;
  const embeddedPreflight = Array.isArray(invocationRecords) ? invocationRecords.some((r: any) => {
    try { return same(JSON.parse(r.record?.payload?.item?.aggregated_output), preflight) && r.record.payload.item.exit_code === 0; } catch { return false; }
  }) : false;
  if (!runner.length || typeof callText !== "string" || !launched || !embeddedPreflight
    || !["scripts/local-work.mjs", "packages/installer/src/cli.ts", "codex-source", "--build-only", "--transaction-id", "pf.transactionId", "pf.userRoot"].every(token => callText.includes(token))
    || !time(call?.timestamp) || Date.parse(call.timestamp) < Date.parse(q.timing.notBefore) || Date.parse(call.timestamp) > Date.parse(q.timing.notAfter)
    || Object.entries(q.observations.observedOverrides).some(([key, value]) => value !== null && key !== "CARGO_BUILD_JOBS" && !callText.includes(`${key}=${value}`))
    || failure.kind !== "lead-observed-source-build-failure" || failure.transactionId !== q.priorTransactionId
    || failure.sourceCommit !== q.source.commit || failure.buildExitCode !== 1 || failure.failurePhase !== "release-helper-v8-download"
    || failure.requiredRustTestResults?.observedProductionFlowAdvancedToReleaseBuild !== true
    || failure.requiredRustTestResults?.structuredReceiptProduced !== false
    || failure.requiredRustTestResults?.passedCount !== 38 || failure.liveMutation !== false || failure.candidateStateExists !== false
    || !Array.isArray(preflight.patches) || !same(preflight.patches.map((p: EvidenceFile) => ({ path: p.path, sha256: p.sha256 })), q.source.patches)
    || preflight.transactionId !== q.priorTransactionId
    || preflight.userRoot !== q.userRoot || preflight.at !== q.timing.notBefore
    || !/HTTP (?:Error )?404|404: Not Found/.test(wrapper) || !/warning: build failed, waiting for other jobs to finish/.test(wrapper)) throw new Error("Original execution/failure qualification is incomplete");
  if (q.logs.stdout.path !== join(priorRoot, "prepared", "rust-lifecycle-tests", "cargo-test.stdout.log")
    || q.logs.stderr.path !== join(priorRoot, "prepared", "rust-lifecycle-tests", "cargo-test.stderr.log")) throw new Error("Qualification logs are outside prior canonical transaction");
  for (const artifact of [q.execution.wrapperLog, q.logs.stdout, q.logs.stderr]) {
    if (failure.artifacts?.[artifact.path]?.sha256 !== artifact.sha256) throw new Error("Failure evidence does not bind original log bytes");
  }
  const stdout = readEvidenceFile(q.logs.stdout), stderr = readEvidenceFile(q.logs.stderr);
  validateRetainedTestFingerprints(q.observations.testLibFingerprints, priorRoot, stderr.toString("utf8"));
  const passedTests = parseExactRustProof(stdout.toString("utf8"), stderr.toString("utf8"), input.requiredTests);
  if (!same([...failure.requiredRustTestResults.namedPassedTests].sort(), passedTests)) throw new Error("Failure's named results differ from logs");
  return { qualification: q, reference, stdout, stderr, passedTests };
}

export function v8EvidenceShape(x: unknown): x is VerifiedV8BuildEvidence {
  return record(x) && x.schemaVersion === 1 && x.kind === "verified-upstream-v8-build-inputs"
    && x.version === "150.4.0" && x.profile === "ptrcomp_sandbox_release" && x.target === "aarch64-apple-darwin"
    && ref(x.verification) && ref(x.archive) && ref(x.binding) && ref(x.manifest) && hash(x.trustAnchorSha256);
}
/** Use the pinned upstream CI trust chain, never a mirror or archive-only override. */
export function verifyV8BuildInputs(input: VerifiedV8Input, sourceRoot: string, commit: string,
  git: (args: readonly string[], cwd: string) => string = (args, cwd) => execFileSync("git", [...args], { cwd, encoding: "utf8" }),
): VerifiedV8BuildEvidence {
  const verification = { path: input.verificationPath, sha256: input.acceptVerificationSha256 };
  const v = JSON.parse(readEvidenceFile(verification).toString("utf8"));
  const name = "ptrcomp_sandbox_release_aarch64-apple-darwin";
  const names = [`rusty_v8_${name}.sha256`, `librusty_v8_${name}.a.gz`, `src_binding_${name}.rs`];
  if (v.schemaVersion !== 1 || v.kind !== "verified-upstream-v8-build-inputs" || v.upstreamCommit !== commit
    || v.releaseUrl !== "https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0"
    || !Array.isArray(v.files) || v.files.length !== 3 || v.nativeMutation !== false) throw new Error("V8 provenance is not the pinned official sandbox pair");
  const files = names.map(n => v.files.find((f: EvidenceFile) => f.path === join(dirname(verification.path), n)) as EvidenceFile);
  if (files.some(f => !ref(f))) throw new Error("V8 pair paths do not match its evidence directory");
  const anchorPath = join(sourceRoot, "third_party", "v8", "rusty_v8_150_4_0_release_manifests.sha256");
  const anchor = readEvidenceFile({ path: anchorPath, sha256: v.trustAnchor?.sha256 }).toString("utf8");
  const unpatchedAnchor = git(["show", `${commit}:third_party/v8/rusty_v8_150_4_0_release_manifests.sha256`], sourceRoot);
  if (anchor !== unpatchedAnchor || digest(unpatchedAnchor) !== v.trustAnchor.sha256) throw new Error("Patched V8 anchor differs from pinned unpatched upstream commit");
  const expected = anchor.split(/\r?\n/).filter(l => l.endsWith(`  ${names[0]}`));
  if (expected.length !== 1 || expected[0]!.split("  ")[0] !== files[0]!.sha256
    || v.trustAnchor.manifestSha256 !== files[0]!.sha256) throw new Error("V8 checksum manifest differs from pinned trust anchor");
  const manifest = readEvidenceFile(files[0]!).toString("utf8").replace(/\r/g, "");
  const lines = manifest.trimEnd().split("\n");
  if (!same(lines, files.slice(1).map((f, i) => `${f.sha256}  ${names[i + 1]}`))) throw new Error("V8 manifest must bind exactly archive and binding");
  files.slice(1).forEach(f => readEvidenceFile(f));
  if (v.overrides?.RUSTY_V8_ARCHIVE !== files[1]!.path || v.overrides?.RUSTY_V8_SRC_BINDING_PATH !== files[2]!.path
    || !/=150\.4\.0/.test(readFileSync(join(sourceRoot, "codex-rs", "Cargo.toml"), "utf8"))) throw new Error("V8 override/version identity differs");
  return { schemaVersion: 1, kind: "verified-upstream-v8-build-inputs", version: "150.4.0", profile: "ptrcomp_sandbox_release",
    target: "aarch64-apple-darwin", verification, manifest: files[0]!, archive: files[1]!, binding: files[2]!, trustAnchorSha256: v.trustAnchor.sha256 };
}

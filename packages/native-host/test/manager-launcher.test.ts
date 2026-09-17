import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const managerId = "com.thomashulihan.tweakers";
const launcherName = "Tweakers Manager Launcher";
const launcherSource = join(process.cwd(), "packages/native-host/assets", launcherName);
const adHocLauncherSource = join(process.cwd(), "packages/native-host/dist", launcherName);
const launcherImplementation = join(process.cwd(), "packages/native-host/src/tweakers_manager_launcher.mm");
const buildScript = join(process.cwd(), "packages/native-host/scripts/build.mjs");
const requestId = "01234567-89ab-4cde-8fab-0123456789ab";
const managedRuntimeMarker = "TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function generationId(input: {
  launcherSha256: string;
  nodePath: string;
  nodeSha256: string;
  managerSha256: string;
  managedRuntimeFingerprint: string;
}): string {
  const preimage = [
    "TWEAKERS_MANAGER_GENERATION_V1",
    `manager-id=${managerId}`,
    "protocol-version=1",
    `launcher-sha256=${input.launcherSha256}`,
    `node-path=${input.nodePath}`,
    `node-sha256=${input.nodeSha256}`,
    `manager-sha256=${input.managerSha256}`,
    `managed-runtime-fingerprint=${input.managedRuntimeFingerprint}`,
    "",
  ].join("\n");
  return createHash("sha256").update(preimage).digest("hex");
}

function seal(input: {
  generationId: string;
  launcherSha256: string;
  nodePath: string;
  nodeSha256: string;
  managerSha256: string;
  managedRuntimeFingerprint: string;
}): string {
  return [
    "TWEAKERS_MANAGER_TARGET_SEAL_V1",
    `manager-id=${managerId}`,
    "protocol-version=1",
    `generation-id=${input.generationId}`,
    `launcher-sha256=${input.launcherSha256}`,
    `node-path=${input.nodePath}`,
    `node-sha256=${input.nodeSha256}`,
    `manager-sha256=${input.managerSha256}`,
    `managed-runtime-fingerprint=${input.managedRuntimeFingerprint}`,
    "",
  ].join("\n");
}

function mkdir0700(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function stageGeneration(
  managerSource: string,
  options: {
    adHocSignLauncher?: boolean;
    launcherSource?: string;
    managedRuntimeFingerprint?: string;
    onSandboxCreated?: (sandbox: string) => void;
  } = {},
) {
  const sandbox = mkdtempSync(join(process.cwd(), ".tweakers-manager-launcher-test-"));
  try {
    options.onSandboxCreated?.(sandbox);
    chmodSync(sandbox, 0o700);
    const userRoot = join(sandbox, "user-root");
    const managers = join(userRoot, "managers");
    const managerRoot = join(managers, managerId);
    const generations = join(managerRoot, "generations");
    const managedRuntimeGenerations = join(managerRoot, "managed-runtime-generations");
    const pending = join(generations, "pending");
    const managedRuntimeFingerprint = options.managedRuntimeFingerprint ?? "a".repeat(64);
    for (const directory of [userRoot, managers, managerRoot, generations, managedRuntimeGenerations, pending]) mkdir0700(directory);
    mkdir0700(join(managedRuntimeGenerations, managedRuntimeFingerprint));

    const launcher = join(pending, launcherName);
    const manager = join(pending, "manager.mjs");
    copyFileSync(options.launcherSource ?? launcherSource, launcher);
    chmodSync(launcher, 0o500);
    writeFileSync(manager, `${managerSource.trimEnd()}\n//# ${managedRuntimeMarker}=${managedRuntimeFingerprint}\n`, { mode: 0o400 });
    chmodSync(manager, 0o400);
    if (options.adHocSignLauncher) {
      const signed = spawnSync("codesign", ["--force", "--sign", "-", launcher], { encoding: "utf8" });
      if (signed.status !== 0) throw new Error(`could not ad-hoc sign test launcher: ${signed.stderr}`);
      chmodSync(launcher, 0o500);
    }

    const nodePath = realpathSync(process.execPath);
    const launcherSha256 = sha256(launcher);
    const managerSha256 = sha256(manager);
    const nodeSha256 = sha256(nodePath);
    const id = generationId({ launcherSha256, nodePath, nodeSha256, managerSha256, managedRuntimeFingerprint });
    const generation = join(generations, id);
    renameSync(pending, generation);
    const targetSeal = join(generation, "target.seal");
    writeFileSync(targetSeal, seal({ generationId: id, launcherSha256, nodePath, nodeSha256, managerSha256, managedRuntimeFingerprint }), { mode: 0o400 });
    chmodSync(targetSeal, 0o400);
    return {
      sandbox,
      managers,
      managerRoot,
      generations,
      managedRuntimeGenerations,
      managedRuntimeFingerprint,
      generation,
      launcher: join(generation, launcherName),
      manager: join(generation, "manager.mjs"),
      targetSeal,
      nodePath,
      id,
    };
  } catch (error) {
    rmSync(sandbox, { recursive: true, force: true });
    throw error;
  }
}

function invoke(
  launcher: string,
  args = ["status", "--request-id", requestId, "--json"],
  env: NodeJS.ProcessEnv = process.env,
  input?: string | Buffer,
) {
  return spawnSync(launcher, args, {
    encoding: "utf8",
    env,
    ...(input === undefined ? {} : { input }),
  });
}

function processGroup(pid: number): string {
  return execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

function writeReadonlyFile(path: string, contents: string): void {
  chmodSync(path, 0o600);
  writeFileSync(path, contents, { mode: 0o400 });
  chmodSync(path, 0o400);
}

const reportingManager = `
import { execFileSync } from "node:child_process";
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  dyld: process.env.DYLD_LIBRARY_PATH ?? null,
  path: process.env.PATH ?? null,
  pgid: execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim(),
}));
`;

test("manager launcher staging removes its sandbox when setup fails", () => {
  let sandbox = "";
  const missingLauncher = join(tmpdir(), `tweakers-missing-manager-launcher-${process.pid}-${Date.now()}`);
  assert.throws(
    () => stageGeneration(reportingManager, {
      launcherSource: missingLauncher,
      onSandboxCreated: (path) => { sandbox = path; },
    }),
    /ENOENT/,
  );
  assert.notEqual(sandbox, "");
  assert.equal(existsSync(sandbox), false);
});

test("native host build rejects a malformed manager signing policy before compilation", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "tweakers-native-host-policy-test-"));
  try {
    const scripts = join(sandbox, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "build.mjs"), readFileSync(buildScript, "utf8"));
    const policy = JSON.parse(readFileSync(join(process.cwd(), "packages/native-host/manager-signing-policy.json"), "utf8")) as Record<string, unknown>;
    policy.certificateLeafSha1 = "not-a-sha1";
    writeFileSync(join(sandbox, "manager-signing-policy.json"), JSON.stringify(policy));

    const result = spawnSync(process.execPath, [join(scripts, "build.mjs")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /manager-signing-policy\.json is malformed or internally inconsistent/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native launcher keeps only the fixed split refresh lanes in its action allowlist", () => {
  const source = readFileSync(launcherImplementation, "utf8");
  const actionValidator = /bool IsSupportedAction\(const char \*value\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  const actions = [...actionValidator.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(actions, [
    "environment.cancel",
    "environment.recover",
    "environment.switch",
    "repair.run",
    "self-update.run",
    "refresh.injected",
    "refresh.independent",
    "official-source.register",
    "app.restart-runtime-proof",
  ]);
  assert.doesNotMatch(actionValidator, /refresh\.full/);
  assert.doesNotMatch(actionValidator, /desktop-update/);
  const build = readFileSync(buildScript, "utf8");
  assert.match(build, /-DTWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS=1/);

  const invocationStart = source.indexOf("bool ValidateInvocation(int argc, char *const argv[], InvocationKind *kind)");
  const invocationEnd = source.indexOf("\nbool ValidatePrivilegeBoundary", invocationStart);
  const invocationValidator = invocationStart < 0 || invocationEnd < 0 ? "" : source.slice(invocationStart, invocationEnd);
  assert.match(invocationValidator, /argc == 5 && std::strcmp\(argv\[1\], "status"\) == 0/);
  assert.match(invocationValidator, /argc == 5 && std::strcmp\(argv\[1\], "official-source-registration"\) == 0/);
  assert.doesNotMatch(invocationValidator, /desktop-update-recovery/);
  assert.doesNotMatch(source, /kDesktopUpdateRecovery/);
  assert.match(invocationValidator, /argc == 13 && std::strcmp\(argv\[1\], "prepare"\) == 0/);
  assert.match(invocationValidator, /std::strcmp\(argv\[6\], "--action"\) == 0 && IsSupportedAction\(argv\[7\]\)/);
  assert.match(invocationValidator, /argc == 7 && \(std::strcmp\(argv\[1\], "execute"\) == 0 \|\| std::strcmp\(argv\[1\], "cancel"\) == 0\)/);
  assert.match(invocationValidator, /only fixed v1 manager protocol argv shapes are supported/);
  const sealParserStart = source.indexOf("bool ParseSeal(const std::string &contents, Seal *seal)");
  const sealParserEnd = source.indexOf("\nbool ValidateManagerManagedRuntimeFingerprintMarker", sealParserStart);
  const sealParser = sealParserStart < 0 || sealParserEnd < 0 ? "" : source.slice(sealParserStart, sealParserEnd);
  assert.match(sealParser, /lines\.size\(\) != 9/);
  assert.match(sealParser, /"managed-runtime-fingerprint="/);
  assert.match(sealParser, /!IsHexLower64\(values\[7\]\)/);
  assert.match(source, /managed-runtime-fingerprint=" \+ seal\.managedRuntimeFingerprint/);
  assert.match(source, /managed-runtime-generations/);
  assert.match(source, /managed-runtime fingerprint does not bind its target seal/);
});

test("manager launcher enforces the fixed seal layout and runs only sealed fixed-protocol requests", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(launcherSource), true, "manager launcher must be built before tests");
  const staged = stageGeneration(reportingManager);
  try {
    assert.equal(readFileSync(staged.targetSeal, "utf8"), seal({
      generationId: staged.id,
      launcherSha256: sha256(staged.launcher),
      nodePath: staged.nodePath,
      nodeSha256: sha256(staged.nodePath),
      managerSha256: sha256(staged.manager),
      managedRuntimeFingerprint: staged.managedRuntimeFingerprint,
    }));
    assert.equal(statSync(staged.generation).mode & 0o7777, 0o700);
    assert.equal(statSync(staged.launcher).mode & 0o7777, 0o500);
    assert.equal(statSync(staged.manager).mode & 0o7777, 0o400);
    assert.equal(statSync(staged.targetSeal).mode & 0o7777, 0o400);

    const environment = { ...process.env, NODE_OPTIONS: "--trace-warnings", DYLD_LIBRARY_PATH: "/attacker/dyld", PATH: "/attacker/bin" };
    const result = invoke(staged.launcher, undefined, environment);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { argv: string[]; nodeOptions: string | null; dyld: string | null; path: string | null; pgid: string };
    assert.deepEqual(output.argv, ["status", "--request-id", requestId, "--json"]);
    assert.equal(output.nodeOptions, null);
    assert.equal(output.dyld, null);
    assert.equal(output.path, null);
    assert.equal(output.pgid, processGroup(process.pid));

    const registration = invoke(staged.launcher, ["official-source-registration", "--request-id", requestId, "--json"], environment);
    assert.equal(registration.status, 0, registration.stderr);
    const registrationOutput = JSON.parse(registration.stdout) as { argv: string[]; nodeOptions: string | null; dyld: string | null; path: string | null; pgid: string };
    assert.deepEqual(registrationOutput.argv, ["official-source-registration", "--request-id", requestId, "--json"]);
    assert.equal(registrationOutput.nodeOptions, null);
    assert.equal(registrationOutput.dyld, null);
    assert.equal(registrationOutput.path, null);
    assert.equal(registrationOutput.pgid, processGroup(process.pid));

    for (const section of ["overview", "updates", "doctor"]) {
      const args = ["manager-open", "--request-id", requestId, "--section", section, "--json"];
      const opened = invoke(staged.launcher, args, environment);
      assert.equal(opened.status, 0, opened.stderr);
      assert.deepEqual(JSON.parse(opened.stdout).argv, args);
      assert.equal(JSON.parse(opened.stdout).nodeOptions, null);
    }

    const retiredRecovery = invoke(staged.launcher, ["desktop-update-recovery", "--request-id", requestId, "--json"], environment);
    assert.equal(retiredRecovery.status, 64, retiredRecovery.stderr);
    assert.equal(retiredRecovery.stdout, "");
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("manager launcher accepts the current seal and rejects legacy, malformed, and mismatched managed-runtime bindings", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration(reportingManager);
  try {
    const valid = invoke(staged.launcher);
    assert.equal(valid.status, 0, valid.stderr);

    const currentSeal = readFileSync(staged.targetSeal, "utf8");
    writeReadonlyFile(
      staged.targetSeal,
      currentSeal.replace(`managed-runtime-fingerprint=${staged.managedRuntimeFingerprint}\n`, ""),
    );
    let result = invoke(staged.launcher);
    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /target seal has an invalid header or record count/i);

    writeReadonlyFile(
      staged.targetSeal,
      currentSeal.replace(
        `managed-runtime-fingerprint=${staged.managedRuntimeFingerprint}`,
        `managed-runtime-fingerprint=${"A".repeat(64)}`,
      ),
    );
    result = invoke(staged.launcher);
    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /target seal has an invalid fixed value/i);

    const changedFingerprint = "b".repeat(64);
    mkdir0700(join(staged.managedRuntimeGenerations, changedFingerprint));
    const changedGenerationId = generationId({
      launcherSha256: sha256(staged.launcher),
      nodePath: staged.nodePath,
      nodeSha256: sha256(staged.nodePath),
      managerSha256: sha256(staged.manager),
      managedRuntimeFingerprint: changedFingerprint,
    });
    const changedGeneration = join(staged.generations, changedGenerationId);
    renameSync(staged.generation, changedGeneration);
    const changedSeal = seal({
      generationId: changedGenerationId,
      launcherSha256: sha256(join(changedGeneration, launcherName)),
      nodePath: staged.nodePath,
      nodeSha256: sha256(staged.nodePath),
      managerSha256: sha256(join(changedGeneration, "manager.mjs")),
      managedRuntimeFingerprint: changedFingerprint,
    });
    const changedLauncher = join(changedGeneration, launcherName);
    writeReadonlyFile(join(changedGeneration, "target.seal"), changedSeal);
    result = invoke(changedLauncher);
    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /managed-runtime fingerprint does not bind its target seal/i);
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("manager launcher rejects malformed fixed-protocol argv before spawning Node", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration(reportingManager);
  try {
    for (const args of [
      [],
      ["manager-open", "--request-id", requestId, "--json"],
      ["manager-open", "--request-id", requestId, "--section", "install", "--json"],
      ["manager-open", "--request-id", requestId, "--section", "overview", "--json", "extra"],
      ["prepare", "--request-id", requestId, "--json"],
      ["execute", "--request-id", requestId, "--json"],
      ["cancel", "--request-id", requestId, "--json"],
      ["status", "--request-id", requestId.toUpperCase(), "--json"],
      ["status", "--json", "--request-id", requestId],
      ["status", "--request-id", requestId, "--json", "extra"],
      ["official-source-registration", "--request-id", requestId.toUpperCase(), "--json"],
      ["official-source-registration", "--json", "--request-id", requestId],
      ["official-source-registration", "--request-id", requestId, "--json", "extra"],
      ["desktop-update-recovery", "--request-id", requestId.toUpperCase(), "--json"],
      ["desktop-update-recovery", "--json", "--request-id", requestId],
      ["desktop-update-recovery", "--request-id", requestId, "--json", "extra"],
    ]) {
      const result = invoke(staged.launcher, args);
      assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("manager launcher fails closed on manager symlink, unsafe ancestor, and digest drift", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration(reportingManager);
  try {
    rmSync(staged.manager);
    symlinkSync("/dev/null", staged.manager);
    let result = invoke(staged.launcher);
    assert.equal(result.status, 70);
    assert.match(result.stderr, /unsafe managed file/i);

    rmSync(staged.manager);
    writeFileSync(staged.manager, reportingManager, { mode: 0o400 });
    chmodSync(staged.manager, 0o400);
    chmodSync(staged.generations, 0o770);
    result = invoke(staged.launcher);
    assert.equal(result.status, 70);
    assert.match(result.stderr, /unsafe managed directory|unsafe ancestor/i);
    chmodSync(staged.generations, 0o700);

    chmodSync(staged.manager, 0o700);
    writeFileSync(staged.manager, `${reportingManager}\n// changed`);
    chmodSync(staged.manager, 0o400);
    result = invoke(staged.launcher);
    assert.equal(result.status, 70);
    assert.match(result.stderr, /digest mismatch/i);
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("manager launcher propagates the sealed manager exit code", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration("process.exit(37);\n");
  try {
    const result = invoke(staged.launcher);
    assert.equal(result.status, 37, result.stderr);
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("manager launcher rejects a self-digest-matching launcher with an ad-hoc signature", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration(reportingManager, { adHocSignLauncher: true });
  try {
    const result = invoke(staged.launcher);
    assert.equal(result.status, 70);
    assert.match(result.stderr, /signature|designated requirement/i);
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("ordinary build is credential-free while release promotion requires the exact signing policy", { skip: process.platform !== "darwin" }, () => {
  const script = readFileSync(buildScript, "utf8");
  const source = readFileSync(launcherImplementation, "utf8");
  assert.match(script, /releaseManagerLauncher \? findExactManagerLauncherIdentity\(\) : "-"/);
  assert.match(script, /certificateLeafSha1/);
  assert.match(script, /--verify[\s\S]*--strict/);
  assert.match(source, /SecStaticCodeCheckValidity/);
  assert.match(source, /getuid\(\)\s*!=\s*geteuid\(\)/);
  assert.match(source, /getgid\(\)\s*!=\s*getegid\(\)/);
  const nodeValidator = /bool IsSafeNodeFile\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(nodeValidator, /file\.st_nlink\s*!=\s*1/);
  assert.match(nodeValidator, /S_ISUID\s*\|\s*S_ISGID/);
  assert.match(source, /posix_spawn\(/);
  assert.match(source, /enum class InvocationKind/);
  assert.match(source, /childArguments\.push_back\(argv\[index\]\)/);
  assert.match(source, /only fixed v1 manager protocol argv shapes are supported/);
  assert.ok(source.includes('find_first_of("\\r\\n\\0", 0, 3)'));
  assert.doesNotMatch(source, /posix_spawnp|system\s*\(|spawnp/);

  const strings = spawnSync("strings", [launcherSource], { encoding: "utf8" });
  assert.equal(strings.status, 0, strings.stderr);
  assert.doesNotMatch(strings.stdout, /posix_spawnp|system\s*\(/);

  assert.equal(existsSync(adHocLauncherSource), true, "ordinary native-host build must produce an ad-hoc manager launcher before tests");
  const adHoc = spawnSync("codesign", ["-d", "--verbose=4", adHocLauncherSource], { encoding: "utf8" });
  assert.equal(adHoc.status, 0, `${adHoc.stdout}\n${adHoc.stderr}`);
  assert.doesNotMatch(`${adHoc.stdout}\n${adHoc.stderr}`, /^Authority=/m);

  const inspected = spawnSync("codesign", ["-d", "-r-", "--verbose=4", launcherSource], { encoding: "utf8" });
  assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
  const details = `${inspected.stdout}\n${inspected.stderr}`;
  assert.match(details, /^Authority=Tweakers Local Signing$/m);
  assert.match(details, /^designated => .*identifier "com\.therealityreport\.tweakers\.manager-launcher"/m);
});

test("signed manager admits only the fixed desktop handoff and bounded activation arguments", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration(reportingManager);
  try {
    for (const command of ["portable-desktop-prelaunch-v1", "portable-desktop-handoff-official-v1", "portable-desktop-handoff-tweakers-v1"]) {
      const accepted = invoke(staged.launcher, [command]);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.deepEqual(JSON.parse(accepted.stdout).argv, [command]);
      assert.equal(invoke(staged.launcher, [command, "--path", "/tmp/untrusted"]).status, 64);
    }
    const activation = ["native-history-activation-run-v1", "--operation-id", requestId,
      "--context-bytes", "65536", "--context-sha256", `sha256:${"a".repeat(64)}`];
    const accepted = invoke(staged.launcher, activation);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout).argv, activation);
    for (const count of ["0", "-1", "65537", "01", "not-a-number"]) {
      const invalid = [...activation]; invalid[4] = count;
      assert.equal(invoke(staged.launcher, invalid).status, 64);
    }
    const wrongScope = [...activation]; wrongScope[1] = "--launcher-root";
    assert.equal(invoke(staged.launcher, wrongScope).status, 64);
  } finally { rmSync(staged.sandbox, { recursive: true, force: true }); }
});

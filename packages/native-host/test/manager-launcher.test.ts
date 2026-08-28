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
import { join } from "node:path";
import test from "node:test";

const managerId = "com.thomashulihan.tweakers";
const launcherName = "Tweakers Manager Launcher";
const launcherSource = join(process.cwd(), "packages/native-host/assets", launcherName);
const adHocLauncherSource = join(process.cwd(), "packages/native-host/dist", launcherName);
const launcherImplementation = join(process.cwd(), "packages/native-host/src/tweakers_manager_launcher.mm");
const buildScript = join(process.cwd(), "packages/native-host/scripts/build.mjs");
const requestId = "01234567-89ab-4cde-8fab-0123456789ab";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function generationId(input: {
  launcherSha256: string;
  nodePath: string;
  nodeSha256: string;
  managerSha256: string;
}): string {
  const preimage = [
    "TWEAKERS_MANAGER_GENERATION_V1",
    `manager-id=${managerId}`,
    "protocol-version=1",
    `launcher-sha256=${input.launcherSha256}`,
    `node-path=${input.nodePath}`,
    `node-sha256=${input.nodeSha256}`,
    `manager-sha256=${input.managerSha256}`,
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
    "",
  ].join("\n");
}

function mkdir0700(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function stageGeneration(managerSource: string, options: { adHocSignLauncher?: boolean } = {}) {
  const sandbox = mkdtempSync(join(process.cwd(), ".tweakers-manager-launcher-test-"));
  chmodSync(sandbox, 0o700);
  const userRoot = join(sandbox, "user-root");
  const managers = join(userRoot, "managers");
  const managerRoot = join(managers, managerId);
  const generations = join(managerRoot, "generations");
  const pending = join(generations, "pending");
  for (const directory of [userRoot, managers, managerRoot, generations, pending]) mkdir0700(directory);

  const launcher = join(pending, launcherName);
  const manager = join(pending, "manager.mjs");
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o500);
  writeFileSync(manager, managerSource, { mode: 0o400 });
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
  const id = generationId({ launcherSha256, nodePath, nodeSha256, managerSha256 });
  const generation = join(generations, id);
  renameSync(pending, generation);
  const targetSeal = join(generation, "target.seal");
  writeFileSync(targetSeal, seal({ generationId: id, launcherSha256, nodePath, nodeSha256, managerSha256 }), { mode: 0o400 });
  chmodSync(targetSeal, 0o400);
  return { sandbox, managers, managerRoot, generations, generation, launcher: join(generation, launcherName), manager: join(generation, "manager.mjs"), targetSeal, nodePath, id };
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

test("manager launcher enforces the fixed seal layout and runs only sealed fixed-protocol status", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(launcherSource), true, "manager launcher must be built before tests");
  const staged = stageGeneration(reportingManager);
  try {
    assert.equal(readFileSync(staged.targetSeal, "utf8"), seal({
      generationId: staged.id,
      launcherSha256: sha256(staged.launcher),
      nodePath: staged.nodePath,
      nodeSha256: sha256(staged.nodePath),
      managerSha256: sha256(staged.manager),
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
  } finally {
    rmSync(staged.sandbox, { recursive: true, force: true });
  }
});

test("manager launcher rejects actions and malformed status argv before spawning Node", { skip: process.platform !== "darwin" }, () => {
  const staged = stageGeneration(reportingManager);
  try {
    for (const args of [
      [],
      ["prepare", "--request-id", requestId, "--json"],
      ["execute", "--request-id", requestId, "--json"],
      ["cancel", "--request-id", requestId, "--json"],
      ["status", "--request-id", requestId.toUpperCase(), "--json"],
      ["status", "--json", "--request-id", requestId],
      ["status", "--request-id", requestId, "--json", "extra"],
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
  assert.match(source, /only the fixed v1 status manager argv shape is supported/);
  assert.doesNotMatch(source, /posix_spawnp|system\s*\(|spawnp/);

  const strings = spawnSync("strings", [launcherSource], { encoding: "utf8" });
  assert.equal(strings.status, 0, strings.stderr);
  assert.doesNotMatch(strings.stdout, /environment\.cancel|desktop-update\.resume|prepare input/);

  const adHoc = spawnSync("codesign", ["-d", "--verbose=4", adHocLauncherSource], { encoding: "utf8" });
  assert.equal(adHoc.status, 0, `${adHoc.stdout}\n${adHoc.stderr}`);
  assert.doesNotMatch(`${adHoc.stdout}\n${adHoc.stderr}`, /^Authority=/m);

  const inspected = spawnSync("codesign", ["-d", "-r-", "--verbose=4", launcherSource], { encoding: "utf8" });
  assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
  const details = `${inspected.stdout}\n${inspected.stderr}`;
  assert.match(details, /^Authority=Tweakers Local Signing$/m);
  assert.match(details, /^designated => .*identifier "com\.therealityreport\.tweakers\.manager-launcher"/m);
});

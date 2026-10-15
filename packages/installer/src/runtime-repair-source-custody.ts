import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { userInfo } from "node:os";
import { readRuntimeFingerprintEvidence } from "./runtime-fingerprint.js";

export const RUNTIME_REPAIR_SOURCE_CUSTODY_FILE = "runtime-repair-source-custody.json";
export const RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY = "runtime-repair-source-evidence";

/** Closed reviewed source scope; generated changes require an actual compiler map. */
export const REVIEWED_RUNTIME_REPAIR_SOURCE_PATHS = [
  "packages/sdk/src/accepted-backend-transition-contract.ts", "packages/sdk/src/accepted-runtime-repair-contract.ts", "packages/sdk/src/index.ts",
  "packages/runtime/src/accepted-runtime-repair-bootstrap.ts", "packages/runtime/src/desktop-update-startup.ts", "packages/runtime/src/main.ts",
  "packages/runtime/src/account-router/transfer-recovery.ts", "packages/runtime/src/account-router/native-transfer.ts", "packages/runtime/src/account-router/native-source-retirement.ts",
  "packages/installer/src/accepted-runtime-repair.ts", "packages/installer/src/runtime-repair-source-custody.ts",
  "packages/installer/src/shared-native-backend-transition.ts", "packages/installer/src/prebuilt-combined-candidate.ts",
  "packages/installer/src/commands/create-variant.ts", "packages/installer/src/runtime-ready-receipt.ts",
  "packages/installer/src/manager-recovery-evidence.ts", "packages/installer/src/manager-action-adapter.ts",
  "packages/installer/src/manager-historical-continuations.ts", "packages/installer/src/generation-retention.ts",
  "packages/installer/src/doctor-updates.ts", "packages/installer/src/doctor-approval.ts", "packages/installer/src/doctor-store.ts",
  "packages/installer/src/doctor-implementation.ts", "packages/installer/src/cli.ts", "packages/installer/src/manager-cli.ts",
  "packages/installer/scripts/copy-assets.mjs", "scripts/verify-runtime-repair-source.mjs",
] as const;

export interface RuntimeRepairSourceFile { relativePath: string; mode: number; sha256: string }
export interface RuntimeRepairGeneratedFile extends RuntimeRepairSourceFile {
  sealedMode: 0o400 | 0o500;
  mappingKind: "tsc-source-map" | "esbuild-source-map" | "paired-tsc-declaration";
  sourceInputs: Array<{relativeSourcePath: string; sha256: string}>;
}
export interface RuntimeRepairSourceCheckReceiptV1 {
  version: 1; kind: "tweakers-runtime-repair-source-checks"; checkoutRoot: string;
  sourceFiles: RuntimeRepairSourceFile[]; inputIdentity: string;
  node: {path: string; sha256: string; version: string};
  dependencyIdentity: string; environmentIdentity: string;
  inputSnapshots: {before: {relativePath: string; sha256: string}; after: {relativePath: string; sha256: string}};
  checks: Array<{command: string; argv: string[]; cwd: string; startedAt: string; completedAt: string; exitCode: 0;
    stdout: {relativePath: string; sha256: string}; stderr: {relativePath: string; sha256: string}}>;
}

/** No caller-selected command, scope, successful result or output directory. */
export const RUNTIME_REPAIR_FIXED_CHECKS: readonly (readonly string[])[] = [
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/installer/tsconfig.json"],
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/runtime/tsconfig.json"],
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/sdk/tsconfig.json"],
  ["--import", "./scripts/test-root-preload.mjs", "--import", "tsx", "--test", "--test-concurrency=2", "--test-name-pattern=accepted runtime repair|schema6|schema5 is explicit",
    "packages/installer/test/accepted-runtime-repair.test.ts", "packages/installer/test/runtime-repair-source-custody.test.ts",
    "packages/installer/test/runtime-ready-receipt.test.ts", "packages/runtime/test/accepted-runtime-repair-contract.test.ts",
    "packages/installer/test/manager-historical-continuations.test.ts",
    "packages/installer/test/manager-action-adapter.test.ts", "packages/installer/test/manager-cli.test.ts",
    "packages/installer/test/generation-retention.test.ts",
    "packages/runtime/test/accepted-runtime-repair-bootstrap.test.ts", "packages/runtime/test/desktop-update-startup.test.ts"],
  ["--test", "scripts/verify-runtime-repair-source.test.mjs"],
];
export interface RuntimeRepairSourceCustodyV1 {
  version: 1; kind: "tweakers-runtime-repair-source-custody";
  checkReceipt: {relativePath: string; sha256: string}; sourceFiles: RuntimeRepairSourceFile[];
  packagedRuntime: {fingerprint: string; fileCount: number; documentSha256: string};
  generatedFiles: RuntimeRepairGeneratedFile[];
}

const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const requireCustody: (condition: unknown, reason: string) => asserts condition = (condition: unknown, reason: string): void => { if (!condition) throw new Error(`Runtime repair source custody: ${reason}`); };
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value: unknown, names: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === names.sort().join(","));
function safeRelative(path: string): boolean { return typeof path === "string" && path.length > 0 && path.length < 4096
  && !path.includes("\\") && !path.includes("\0") && path.split("/").every(part => part !== "" && part !== "." && part !== ".."); }

/** Actual map path resolution, including standard tsc maps without sourcesContent. */
export function runtimeRepairCompilerMapInputs(checkoutRoot: string, outputPath: string, mapBytes: Buffer,
  sourceFiles: readonly RuntimeRepairSourceFile[], bundleMap = false): Array<{relativeSourcePath: string; sha256: string}> {
  requireCustody(checkoutRoot === realpathSync(checkoutRoot) && outputPath.startsWith(checkoutRoot + "/"), "foreign compiler output");
  const map = JSON.parse(mapBytes.toString("utf8"));
  requireCustody(map.version === 3 && Array.isArray(map.sources) && map.sources.length > 0 && map.sources.length < 4096
    && (map.sourceRoot === undefined || map.sourceRoot === "") && (map.sourcesContent === undefined
      || Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length), "invalid compiler map");
  const result = new Map<string, string>(), seen = new Set<string>();
  for (let index = 0; index < map.sources.length; index++) {
    const input = map.sources[index];
    requireCustody(typeof input === "string" && !isAbsolute(input) && !input.includes("\0") && !input.includes("\\") && !/^[a-z]+:/i.test(input), "foreign map source");
    const path = resolve(dirname(outputPath), input);
    const relativeSourcePath = relative(checkoutRoot, path);
    requireCustody(path.startsWith(checkoutRoot + "/") && safeRelative(relativeSourcePath), "unresolved or foreign map source");
    requireCustody(!seen.has(relativeSourcePath), "duplicate map source"); seen.add(relativeSourcePath);
    // Published dependency bundles can embed upstream TypeScript that npm does
    // not ship. Retain its map bytes for the full old/new bundle comparison,
    // but grant no source input or package-path authority for that absent leaf.
    if (lstatSync(path, {throwIfNoEntry: false}) === undefined) {
      requireCustody(bundleMap && relativeSourcePath.startsWith("node_modules/")
        && typeof map.sourcesContent?.[index] === "string", "unresolved or foreign map source");
      continue;
    }
    requireCustody(realpathSync(path) === path, "unresolved or foreign map source");
    const expected = sourceFiles.find(file => file.relativePath === relativeSourcePath);
    requireCustody(expected && expected.sha256 === hash(readRuntimeRepairCustodyFile(path)), "stale map source");
    if (map.sourcesContent !== undefined) requireCustody(typeof map.sourcesContent[index] === "string"
      && hash(map.sourcesContent[index]) === expected!.sha256, "map sourcesContent differs from current source");
    requireCustody(!result.has(relativeSourcePath), "duplicate map source");
    result.set(relativeSourcePath, expected!.sha256);
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([relativeSourcePath, sha256]) => ({relativeSourcePath, sha256}));
}

/** A build-owned complete inventory; callers cannot select source directories. */
export function collectRuntimeRepairSourceInputs(checkoutRoot: string): RuntimeRepairSourceFile[] {
  requireCustody(realpathSync(checkoutRoot) === checkoutRoot, "checkout is not canonical");
  const output: RuntimeRepairSourceFile[] = [];
  const visit = (path: string, emittedPrerequisite = false): void => {
    const status = lstatSync(path), relativePath = relative(checkoutRoot, path);
    requireCustody(!status.isSymbolicLink(), `linked source ${relativePath}`);
    if (status.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name === ".DS_Store" || (!emittedPrerequisite && ["node_modules", "dist", "assets", ".git"].includes(name))) continue;
        visit(join(path, name), emittedPrerequisite);
      }
    } else { requireCustody(status.isFile(), `nonregular source ${relativePath}`); output.push({relativePath, mode: status.mode & 0o777, sha256: hash(readRuntimeRepairCustodyFile(path))}); }
  };
  for (const path of ["packages/installer/src", "packages/installer/test", "packages/installer/scripts", "packages/runtime/src", "packages/runtime/test", "packages/runtime/scripts",
    "packages/sdk/src", "packages/sdk/test", "packages/sdk/dist", "scripts", "bin", "tweaks", "store", "package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.tests.json",
    ...["installer", "runtime", "sdk"].flatMap(name => [`packages/${name}/package.json`, `packages/${name}/tsconfig.json`])]) visit(join(checkoutRoot, path), path === "packages/sdk/dist");
  // Bundled compiler maps can identify actual dependency source leaves. npm
  // workspace directory links are already covered by the explicit sources.
  const dependencies = (path: string): void => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      const target = realpathSync(path);
      requireCustody(target.startsWith(checkoutRoot + "/"), "foreign dependency source");
      if (target.startsWith(join(checkoutRoot, "packages") + "/")) return;
      requireCustody(lstatSync(target).isFile(), "linked dependency source directory");
      return;
    }
    if (status.isDirectory()) {
      for (const child of readdirSync(path).sort()) if (child !== ".cache" && child !== ".DS_Store") dependencies(join(path, child));
    } else if (/\.(?:[cm]?js|ts|json)$/.test(path) && status.isFile()) {
      output.push({relativePath: relative(checkoutRoot, path), mode: status.mode & 0o777, sha256: hash(readRuntimeRepairCustodyFile(path))});
    }
  };
  dependencies(join(checkoutRoot, "node_modules"));
  return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function runtimeRepairSourceInputIdentity(files: readonly RuntimeRepairSourceFile[]): string { return hash(JSON.stringify(files)); }
export function runtimeRepairSourceEnvironmentIdentity(): string {
  return hash(JSON.stringify({platform: process.platform, arch: process.arch,
    environment: Object.fromEntries(["PATH", "NODE_OPTIONS", "NODE_PATH", "LANG", "LC_ALL", "TZ", "TS_NODE_PROJECT"]
      .map(key => [key, process.env[key] ?? null]))}));
}

/** Actual installed dependency bytes, including executable/link ownership. */
export function runtimeRepairDependencyIdentity(checkoutRoot: string): string {
  const digest = createHash("sha256"), root = realpathSync(checkoutRoot);
  // Tests and tsc consume the installed workspace package's emitted main/types.
  // Bind the actual resolution plus every emitted SDK leaf; source hashes alone
  // cannot identify the generation used by those commands.
  const sdkLink = join(root, "node_modules", "@therealityreport", "tweakers-sdk"), sdkRoot = join(root, "packages", "sdk");
  requireCustody(realpathSync(sdkLink) === sdkRoot && realpathSync(sdkRoot) === sdkRoot, "SDK workspace resolution changed");
  const packageBytes = readRuntimeRepairCustodyFile(join(sdkRoot, "package.json"));
  const sdkPackage = JSON.parse(packageBytes.toString("utf8"));
  requireCustody(sdkPackage.name === "@therealityreport/tweakers-sdk" && sdkPackage.main === "dist/index.js"
    && sdkPackage.types === "dist/index.d.ts" && sdkPackage.exports === undefined, "SDK package entry resolution changed");
  const sdkDist = join(sdkRoot, "dist");
  requireCustody(realpathSync(sdkDist) === sdkDist && lstatSync(sdkDist).isDirectory(), "SDK emitted prerequisite is linked or missing");
  digest.update("sdk-workspace-resolution\0").update(relative(root, sdkRoot)).update(packageBytes);
  const emitted = (path: string): void => {
    const status = lstatSync(path);
    requireCustody(!status.isSymbolicLink(), "linked SDK emitted prerequisite");
    digest.update(relative(root, path)).update(String(status.mode & 0o777));
    if (status.isDirectory()) for (const name of readdirSync(path).sort()) emitted(join(path, name));
    else { requireCustody(status.isFile(), "nonregular SDK emitted prerequisite"); digest.update(readRuntimeRepairCustodyFile(path)); }
  };
  for (const entry of [sdkPackage.main, sdkPackage.types]) requireCustody(lstatSync(join(sdkRoot, entry)).isFile(), "SDK package entry missing");
  emitted(sdkDist);
  const visit = (path: string): void => {
    const status = lstatSync(path), name = relative(root, path);
    digest.update(name).update(String(status.mode & 0o777));
    if (status.isSymbolicLink()) {
      const target = realpathSync(path);
      requireCustody(target.startsWith(root + "/"), "foreign dependency link");
      digest.update(readlinkSync(path));
      if (status.isDirectory()) throw new Error("Unexpected linked directory status");
      // Workspace sources and emitted prerequisites have their own custody.
      if (target.startsWith(join(root, "packages") + "/")) return;
      requireCustody(lstatSync(target).isFile(), "linked external dependency directory");
      digest.update(relative(root, target)).update(readRuntimeRepairCustodyFile(target));
    } else if (status.isDirectory()) {
      for (const child of readdirSync(path).sort()) if (child !== ".cache" && child !== ".DS_Store") visit(join(path, child));
    } else { requireCustody(status.isFile(), "nonregular dependency"); digest.update(readRuntimeRepairCustodyFile(path)); }
  };
  visit(join(root, "node_modules"));
  return digest.digest("hex");
}

export function runtimeRepairSourceCheckCache(checkoutRoot: string): string {
  requireCustody(checkoutRoot === realpathSync(checkoutRoot), "noncanonical verification checkout");
  const home = userInfo().homedir;
  requireCustody(home === realpathSync(home), "OS account home is not canonical");
  return join(home, "Library", "Caches", "Tweakers", "verification", hash(checkoutRoot), "runtime-repair-source");
}

export function assertRuntimeRepairSourceCheckReceipt(value: unknown): asserts value is RuntimeRepairSourceCheckReceiptV1 {
  requireCustody(exactKeys(value, ["version", "kind", "checkoutRoot", "sourceFiles", "inputIdentity", "node", "dependencyIdentity", "environmentIdentity", "inputSnapshots", "checks"]), "check receipt keys");
  const record = value as unknown as RuntimeRepairSourceCheckReceiptV1;
  requireCustody(record.version === 1 && record.kind === "tweakers-runtime-repair-source-checks" && isAbsolute(record.checkoutRoot)
    && resolve(record.checkoutRoot) === record.checkoutRoot && Array.isArray(record.sourceFiles) && isHash(record.inputIdentity)
    && runtimeRepairSourceInputIdentity(record.sourceFiles) === record.inputIdentity, "check source identity");
  assertSourceInventory(record.sourceFiles);
  requireCustody(exactKeys(record.node, ["path", "sha256", "version"]) && isAbsolute(record.node.path) && isHash(record.node.sha256)
    && typeof record.node.version === "string" && record.node.version.length < 100, "node identity");
  requireCustody(isHash(record.dependencyIdentity) && isHash(record.environmentIdentity) && Array.isArray(record.checks) && record.checks.length === RUNTIME_REPAIR_FIXED_CHECKS.length, "missing fixed checks");
  for (const [index, check] of record.checks.entries()) {
    requireCustody(exactKeys(check, ["command", "argv", "cwd", "startedAt", "completedAt", "exitCode", "stdout", "stderr"])
      && check.command === record.node.path && Array.isArray(check.argv) && check.argv.every(arg => typeof arg === "string" && !arg.includes("\0"))
      && check.cwd === record.checkoutRoot
      && JSON.stringify(check.argv) === JSON.stringify(RUNTIME_REPAIR_FIXED_CHECKS[index])
      && check.exitCode === 0 && Number.isFinite(Date.parse(check.startedAt)) && Date.parse(check.completedAt) >= Date.parse(check.startedAt), "check execution proof");
    for (const [stream, ref] of [["stdout", check.stdout], ["stderr", check.stderr]] as const) requireCustody(exactKeys(ref, ["relativePath", "sha256"])
      && new RegExp(`^logs/[a-f0-9-]{36}/${index}\\.${stream}\\.log$`).test(ref.relativePath)
      && isHash(ref.sha256), "check log reference");
  }
  requireCustody(new Set(record.checks.flatMap(check => [check.stdout, check.stderr]).map(ref => ref.relativePath.split("/")[1])).size === 1, "checks are not one fixed run");
  requireCustody(exactKeys(record.inputSnapshots, ["before", "after"]), "input snapshots absent");
  const runId = record.checks[0]!.stdout.relativePath.split("/")[1];
  for (const side of ["before", "after"] as const) {
    const ref = record.inputSnapshots[side];
    requireCustody(exactKeys(ref, ["relativePath", "sha256"]) && ref.relativePath === `logs/${runId}/inputs-${side}.json` && isHash(ref.sha256), "input snapshot reference");
  }
}

function verifyInputSnapshots(root: string, checks: RuntimeRepairSourceCheckReceiptV1): void {
  const expected = {sourceFiles:checks.sourceFiles,inputIdentity:checks.inputIdentity,dependencyIdentity:checks.dependencyIdentity,
    environmentIdentity:checks.environmentIdentity,node:checks.node};
  let previous: Buffer | undefined;
  for (const side of ["before", "after"] as const) {
    const ref = checks.inputSnapshots[side], raw = readRuntimeRepairCustodyFile(join(root, ref.relativePath));
    requireCustody(hash(raw) === ref.sha256 && JSON.stringify(JSON.parse(raw.toString("utf8"))) === JSON.stringify(expected), "actual input snapshot differs from checks");
    if (previous) requireCustody(previous.equals(raw), "inputs changed during checks");
    previous = raw;
  }
}

function assertSourceInventory(files: RuntimeRepairSourceFile[]): void {
  let previous = "";
  for (const file of files) {
    requireCustody(exactKeys(file, ["relativePath", "mode", "sha256"]) && safeRelative(file.relativePath) && isHash(file.sha256)
      && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777 && (previous === "" || previous.localeCompare(file.relativePath) < 0), "source inventory is not exact and sorted");
    previous = file.relativePath;
  }
}

/** This fixed data file is meaningful only inside an independently verified sealed generation. */
export function readRuntimeRepairSourceCustody(moduleRoot: string): RuntimeRepairSourceCustodyV1 {
  const raw = readRuntimeRepairCustodyFile(join(moduleRoot, RUNTIME_REPAIR_SOURCE_CUSTODY_FILE));
  const value = JSON.parse(raw.toString("utf8"));
  requireCustody(exactKeys(value, ["version", "kind", "checkReceipt", "sourceFiles", "packagedRuntime", "generatedFiles"])
    && value.version === 1 && value.kind === "tweakers-runtime-repair-source-custody", "shipped record schema");
  const record = value as unknown as RuntimeRepairSourceCustodyV1;
  assertSourceInventory(record.sourceFiles);
  requireCustody(exactKeys(record.checkReceipt, ["relativePath", "sha256"]) && record.checkReceipt.relativePath === `${RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY}/checks.json`
    && isHash(record.checkReceipt.sha256), "fixed check receipt path");
  const checkBytes = readRuntimeRepairCustodyFile(join(moduleRoot, record.checkReceipt.relativePath));
  requireCustody(hash(checkBytes) === record.checkReceipt.sha256, "check receipt changed");
  const checks = JSON.parse(checkBytes.toString("utf8")); assertRuntimeRepairSourceCheckReceipt(checks);
  requireCustody(JSON.stringify(checks.sourceFiles) === JSON.stringify(record.sourceFiles), "source/check inventories differ");
  for (const check of checks.checks) for (const ref of [check.stdout, check.stderr]) {
    requireCustody(hash(readRuntimeRepairCustodyFile(join(moduleRoot, RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY, ref.relativePath))) === ref.sha256, "retained raw check log differs");
  }
  verifyInputSnapshots(join(moduleRoot, RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY), checks);
  requireCustody(exactKeys(record.packagedRuntime, ["fingerprint", "fileCount", "documentSha256"]) && isHash(record.packagedRuntime.fingerprint)
    && isHash(record.packagedRuntime.documentSha256) && Number.isSafeInteger(record.packagedRuntime.fileCount) && record.packagedRuntime.fileCount > 0, "runtime identity");
  requireCustody(Array.isArray(record.generatedFiles) && record.generatedFiles.length > 0 && record.generatedFiles.length < 8192, "generated mapping absent");
  const seen = new Set<string>();
  for (const file of record.generatedFiles) {
    requireCustody(exactKeys(file, ["relativePath", "mode", "sha256", "sealedMode", "mappingKind", "sourceInputs"])
      && safeRelative(file.relativePath) && isHash(file.sha256) && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777
      && file.sealedMode === ((file.mode & 0o100) ? 0o500 : 0o400) && ["tsc-source-map", "esbuild-source-map", "paired-tsc-declaration"].includes(file.mappingKind)
      && !seen.has(file.relativePath) && Array.isArray(file.sourceInputs) && file.sourceInputs.length > 0, "generated mapping invalid");
    seen.add(file.relativePath);
    const managedRoot = resolve(moduleRoot, "../../.."), outputPath = join(managedRoot, file.relativePath);
    requireCustody(hash(readRuntimeRepairCustodyFile(outputPath)) === file.sha256 && (lstatSync(outputPath).mode & 0o777) === file.sealedMode, "sealed generated output changed");
    for (const input of file.sourceInputs) requireCustody(exactKeys(input, ["relativeSourcePath", "sha256"])
      && record.sourceFiles.some(source => source.relativePath === input.relativeSourcePath && source.sha256 === input.sha256), "generated source input is not verified");
  }
  const runtime = join(resolve(moduleRoot, "../../.."), "packages", "installer", "assets", "runtime");
  const observed = readRuntimeFingerprintEvidence(runtime);
  requireCustody(observed?.fingerprint === record.packagedRuntime.fingerprint && observed.fileCount === record.packagedRuntime.fileCount
    && hash(readRuntimeRepairCustodyFile(join(runtime, "runtime-fingerprint.json"))) === record.packagedRuntime.documentSha256, "sealed packaged runtime changed");
  return record;
}

/** Build hook. Ordinary builds omit unavailable/stale repair custody. */
export function stageRuntimeRepairSourceCustody(checkoutRoot: string, managedRoot: string): boolean {
  const moduleRoot = join(managedRoot, "packages", "installer", "dist"), file = join(moduleRoot, RUNTIME_REPAIR_SOURCE_CUSTODY_FILE);
  const evidence = join(moduleRoot, RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY), cache = runtimeRepairSourceCheckCache(checkoutRoot);
  // These are exclusively newly staged generated paths, never installed authority.
  rmSync(file, {force: true}); rmSync(evidence, {recursive: true, force: true});
  if (!existsSync(join(cache, "checks.json"))) return false;
  let raw:Buffer,checks:RuntimeRepairSourceCheckReceiptV1;
  try {
    raw=readRuntimeRepairCustodyFile(join(cache,"checks.json"));
    const value:unknown=JSON.parse(raw.toString("utf8"));assertRuntimeRepairSourceCheckReceipt(value);checks=value;
  }catch{return false;} // An unusable check pointer grants no repair custody.
  if (checks.checkoutRoot !== checkoutRoot || checks.node.path !== realpathSync(process.execPath)
    || checks.node.sha256 !== hash(readRuntimeRepairCustodyFile(realpathSync(process.execPath))) || checks.node.version !== process.version
    || checks.inputIdentity !== runtimeRepairSourceInputIdentity(collectRuntimeRepairSourceInputs(checkoutRoot))
    || checks.dependencyIdentity !== runtimeRepairDependencyIdentity(checkoutRoot)
    || checks.environmentIdentity !== runtimeRepairSourceEnvironmentIdentity()) return false;
  try {
    for (const check of checks.checks) for (const ref of [check.stdout, check.stderr])
      requireCustody(hash(readRuntimeRepairCustodyFile(join(cache, ref.relativePath))) === ref.sha256, "check logs changed before build");
    verifyInputSnapshots(cache, checks);
  }catch{return false;} // Ordinary builds omit stale/missing retained evidence.
  const generatedFiles: RuntimeRepairGeneratedFile[] = [];
  const visit = (path: string, originalPath: string, copiedRuntimeAssets = false): void => {
    const status = lstatSync(path);
    requireCustody(!status.isSymbolicLink(), "linked generated output");
    if (status.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name), join(originalPath, name), copiedRuntimeAssets); return; }
    requireCustody(status.isFile(), "nonregular generated output");
    // Packaging also copies tweaks/support assets into runtime. A leaf without
    // a runtime/dist counterpart is not compiler output and earns no map grant;
    // the complete inventory still rejects any changed or new unmapped asset.
    if (copiedRuntimeAssets && !existsSync(originalPath)) return;
    let mapBytes: Buffer | undefined, mappingKind: RuntimeRepairGeneratedFile["mappingKind"] = "tsc-source-map";
    if (path.endsWith(".js.map")) mapBytes = readRuntimeRepairCustodyFile(originalPath);
    else if (path.endsWith(".js")) {
      const inline = /\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(readRuntimeRepairCustodyFile(originalPath).toString("utf8"));
      if (inline) { mapBytes = Buffer.from(inline[1]!, "base64"); mappingKind = "esbuild-source-map"; }
      else if (existsSync(originalPath + ".map")) mapBytes = readRuntimeRepairCustodyFile(originalPath + ".map");
    } else if (path.endsWith(".d.ts") && existsSync(originalPath.replace(/\.d\.ts$/, ".js.map"))) {
      mapBytes = readRuntimeRepairCustodyFile(originalPath.replace(/\.d\.ts$/, ".js.map")); mappingKind = "paired-tsc-declaration";
    }
    if (!mapBytes) return; // Unmapped output cannot be granted a repair delta.
    if (mappingKind !== "paired-tsc-declaration" && Array.isArray(JSON.parse(mapBytes.toString("utf8")).sourcesContent)) mappingKind = "esbuild-source-map";
    requireCustody(hash(readRuntimeRepairCustodyFile(path)) === hash(readRuntimeRepairCustodyFile(originalPath)), "staged output differs from compiler output");
    const mapOutput = originalPath.replace(/\.(?:d\.ts|js\.map)$/, ".js");
    generatedFiles.push({relativePath: relative(managedRoot, path), mode: status.mode & 0o777, sealedMode: status.mode & 0o100 ? 0o500 : 0o400,
      sha256: hash(readRuntimeRepairCustodyFile(path)), mappingKind,
      sourceInputs: runtimeRepairCompilerMapInputs(checkoutRoot, mapOutput, mapBytes, checks.sourceFiles, mappingKind === "esbuild-source-map")});
  };
  for (const pkg of ["installer", "sdk"]) visit(join(managedRoot, "packages", pkg, "dist"), join(checkoutRoot, "packages", pkg, "dist"));
  const sdkProjection = join(managedRoot, "node_modules", "@therealityreport", "tweakers-sdk", "dist");
  if (existsSync(sdkProjection)) visit(sdkProjection, join(checkoutRoot, "packages", "sdk", "dist"));
  visit(join(managedRoot, "packages", "installer", "assets", "runtime"), join(checkoutRoot, "packages", "runtime", "dist"), true);
  const runtime = join(managedRoot, "packages", "installer", "assets", "runtime"), observed = readRuntimeFingerprintEvidence(runtime);
  requireCustody(observed, "packaged runtime lacks its actual fingerprint");
  const record: RuntimeRepairSourceCustodyV1 = {version: 1, kind: "tweakers-runtime-repair-source-custody",
    checkReceipt: {relativePath: `${RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY}/checks.json`, sha256: hash(raw)}, sourceFiles: checks.sourceFiles,
    packagedRuntime: {fingerprint: observed!.fingerprint, fileCount: observed!.fileCount,
      documentSha256: hash(readRuntimeRepairCustodyFile(join(runtime, "runtime-fingerprint.json")))}, generatedFiles: generatedFiles.sort((a,b) => a.relativePath.localeCompare(b.relativePath))};
  mkdirSync(evidence, {mode: 0o700});
  writeFileSync(join(evidence, "checks.json"), raw, {mode: 0o600, flag: "wx"});
  for (const check of checks.checks) for (const ref of [check.stdout, check.stderr]) {
    mkdirSync(dirname(join(evidence, ref.relativePath)), {recursive: true, mode: 0o700});
    cpSync(join(cache, ref.relativePath), join(evidence, ref.relativePath));
  }
  for (const ref of [checks.inputSnapshots.before, checks.inputSnapshots.after]) cpSync(join(cache, ref.relativePath), join(evidence, ref.relativePath));
  writeFileSync(file, JSON.stringify(record) + "\n", {mode: 0o600, flag: "wx"});
  return true;
}

export function readRuntimeRepairCustodyFile(path: string): Buffer {
  requireCustody(realpathSync(path) === path, "linked custody file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd); requireCustody(a.isFile() && a.size <= 512 * 1024 * 1024 && a.uid === process.getuid?.(), "unsafe custody file");
    const bytes = readFileSync(fd), b = fstatSync(fd), c = lstatSync(path);
    requireCustody(a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs
      && a.dev === c.dev && a.ino === c.ino && !c.isSymbolicLink(), "custody changed during read"); return bytes;
  } finally { closeSync(fd); }
}

export interface RuntimeRepairReviewedGeneratedDeltaV1 {
  version: 1; kind: "tweakers-runtime-repair-reviewed-generated-delta";
  originalInventorySha256: string; repairedInventorySha256: string;
  changes: Array<{relativePath: string; before: RuntimeRepairSourceFile | null; after: RuntimeRepairSourceFile;
    sourceInputs: Array<{relativeSourcePath: string; sha256: string}>}>;
}

/** Complete byte inventory, with only the two fixed self-metadata exceptions. */
export function runtimeRepairManagedGeneratedInventory(root: string): RuntimeRepairSourceFile[] {
  const output: RuntimeRepairSourceFile[] = [];
  const walk = (path: string): void => {
    const name = relative(root, path), status = lstatSync(path);
    requireCustody(!status.isSymbolicLink() && status.uid === process.getuid?.() && (status.mode & 0o022) === 0, "unsafe emitted custody entry");
    if (name === "managed-runtime-fingerprint.json" || name === `packages/installer/dist/${RUNTIME_REPAIR_SOURCE_CUSTODY_FILE}`
      || name === `packages/installer/dist/${RUNTIME_REPAIR_SOURCE_EVIDENCE_DIRECTORY}`) return;
    if (status.isDirectory()) { for (const child of readdirSync(path).sort()) walk(join(path, child)); }
    else { requireCustody(status.isFile(), "nonregular emitted custody entry"); output.push({relativePath:name,mode:status.mode & 0o777,sha256:hash(readRuntimeRepairCustodyFile(path))}); }
  };
  walk(root); return output.sort((a,b) => a.relativePath.localeCompare(b.relativePath));
}

/** No directory grant: every changed emitted leaf needs its actual map group. */
export function reviewRuntimeRepairGeneratedDelta(originalRoot: string, repairedRoot: string,
  custody: RuntimeRepairSourceCustodyV1): RuntimeRepairReviewedGeneratedDeltaV1 {
  const before = runtimeRepairManagedGeneratedInventory(originalRoot), after = runtimeRepairManagedGeneratedInventory(repairedRoot);
  const old = new Map(before.map(file => [file.relativePath,file])), current = new Map(after.map(file => [file.relativePath,file]));
  for (const name of old.keys()) requireCustody(current.has(name), `unreviewed generated removal ${name}`);
  const changes: RuntimeRepairReviewedGeneratedDeltaV1["changes"] = [];
  const metadata = "packages/installer/assets/runtime/runtime-fingerprint.json";
  for (const file of after) {
    const previous = old.get(file.relativePath);
    if (previous && previous.mode === file.mode && previous.sha256 === file.sha256) continue;
    if (file.relativePath === metadata) {
      requireCustody(file.sha256 === custody.packagedRuntime.documentSha256 && previous !== undefined && previous.mode === file.mode, "runtime metadata is not exact build output");
      changes.push({relativePath:file.relativePath,before:previous,after:file,sourceInputs:[]}); continue;
    }
    const mapped = custody.generatedFiles.find(item => item.relativePath === file.relativePath);
    requireCustody(mapped && mapped.sha256 === file.sha256 && mapped.sealedMode === file.mode
      && mapped.sourceInputs.some(input => (REVIEWED_RUNTIME_REPAIR_SOURCE_PATHS as readonly string[]).includes(input.relativeSourcePath)),
      `unreviewed emitted change ${file.relativePath}`);
    if (mapped!.mappingKind === "esbuild-source-map") {
      requireCustody(previous, "new bundle lacks retained original source inputs");
      assertRuntimeRepairBundledSourceDelta(readRuntimeRepairCustodyFile(join(originalRoot,file.relativePath)),
        readRuntimeRepairCustodyFile(join(repairedRoot,file.relativePath)), file.relativePath,
        file.relativePath.endsWith(".js") && existsSync(join(originalRoot,file.relativePath+".map")) ? readRuntimeRepairCustodyFile(join(originalRoot,file.relativePath+".map")) : undefined,
        file.relativePath.endsWith(".js") && existsSync(join(repairedRoot,file.relativePath+".map")) ? readRuntimeRepairCustodyFile(join(repairedRoot,file.relativePath+".map")) : undefined);
    }
    changes.push({relativePath:file.relativePath,before:previous ?? null,after:file,sourceInputs:mapped!.sourceInputs});
  }
  requireCustody(changes.length > 0, "repair has no reviewed generated change");
  return {version:1,kind:"tweakers-runtime-repair-reviewed-generated-delta",originalInventorySha256:hash(JSON.stringify(before)),
    repairedInventorySha256:hash(JSON.stringify(after)),changes};
}

/** Inline esbuild maps retain original source bytes: enforce each changed input,
 * rather than granting a whole bundle because it contains one approved input. */
export function assertRuntimeRepairBundledSourceDelta(before: Buffer, after: Buffer, generatedPath: string, beforeExternalMap?: Buffer, afterExternalMap?: Buffer): void {
  generatedPath = generatedPath.replace(/\.js\.map$/, ".js");
  const mappedPath = generatedPath.startsWith("packages/installer/assets/runtime/")
    ? generatedPath.replace("packages/installer/assets/runtime/", "packages/runtime/dist/")
    : generatedPath;
  requireCustody(mappedPath.startsWith("packages/runtime/dist/") || mappedPath.startsWith("packages/installer/dist/")
    || mappedPath.startsWith("packages/sdk/dist/"), "unknown bundle output group");
  const inputs = (bytes: Buffer, external?: Buffer): Map<string,string> => {
    const inline = /\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(bytes.toString("utf8"));
    const raw = inline ? Buffer.from(inline[1]!,"base64") : external ?? bytes;
    const map = JSON.parse(raw.toString("utf8"));
    requireCustody(map.version === 3 && Array.isArray(map.sources) && Array.isArray(map.sourcesContent)
      && map.sources.length === map.sourcesContent.length && (map.sourceRoot === undefined || map.sourceRoot === ""), "incomplete retained bundle inputs");
    const result = new Map<string,string>();
    for (let index=0; index<map.sources.length; index++) {
      const source = map.sources[index], content = map.sourcesContent[index];
      requireCustody(typeof source === "string" && !isAbsolute(source) && !/^[a-z]+:/i.test(source) && typeof content === "string", "foreign retained bundle input");
      const name = relative("/fixed-checkout",resolve("/fixed-checkout",dirname(mappedPath),source));
      requireCustody(safeRelative(name) && !result.has(name), "ambiguous retained bundle input");
      result.set(name,hash(content));
    }
    return result;
  };
  const old = inputs(before,beforeExternalMap), current = inputs(after,afterExternalMap);
  for (const name of new Set([...old.keys(),...current.keys()])) {
    if (old.get(name) === current.get(name)) continue;
    requireCustody((REVIEWED_RUNTIME_REPAIR_SOURCE_PATHS as readonly string[]).includes(name), `unreviewed bundled source change ${name}`);
  }
}

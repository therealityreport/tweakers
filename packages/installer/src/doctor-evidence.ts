import asar from "@electron/asar";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { delimiter } from "node:path";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import plist from "plist";
import { readPlist } from "./plist.js";

import type { DoctorBackendSourceComparison } from "./doctor-upstream.js";

export type DoctorSourceSha256 = `sha256:${string}`;

export interface DoctorSourceFileEvidence {
  path: string;
  kind: "file" | "symlink";
  bytes: number;
  sha256: DoctorSourceSha256;
  linkTarget?: string;
}

export interface DoctorSourceAsarMemberEvidence {
  path: string;
  kind: "file" | "symlink";
  bytes: number;
  rawSha256: DoctorSourceSha256;
  semanticSha256: DoctorSourceSha256;
  unpacked: boolean;
  linkTarget?: string;
}

export interface DoctorSourceSchemaEvidence {
  state: "complete" | "missing_backend" | "generation_failed" | "invalid_output";
  command: readonly string[];
  /** Exact local collection root. It locates bytes but is not source identity. */
  root?: string;
  files: DoctorSourceFileEvidence[];
  fingerprint: DoctorSourceSha256 | null;
  problem: string | null;
}

export interface DoctorSourceEvidence {
  schemaVersion: 1;
  kind: "tweakers-doctor-source-evidence";
  collectorVersion?: number;
  appPath: string;
  version: string | null;
  build: string | null;
  backend: {
    path: "Contents/Resources/codex";
    version: string | null;
    sha256: DoctorSourceSha256 | null;
  };
  shippedFiles: DoctorSourceFileEvidence[];
  asar: {
    path: "Contents/Resources/app.asar";
    sha256: DoctorSourceSha256 | null;
    members: DoctorSourceAsarMemberEvidence[];
  };
  schemas: DoctorSourceSchemaEvidence;
  complete: boolean;
  unresolvedEvidence: string[];
  fingerprint: DoctorSourceSha256;
  artifact: "doctor-source-evidence.json";
}

export type DoctorSourceArea =
  | "frontend"
  | "static_assets"
  | "localization"
  | "preload"
  | "main"
  | "helpers"
  | "native_modules"
  | "desktop_executables"
  | "plugin_runtime"
  | "package_metadata"
  | "backend"
  | "schema"
  | "packaging"
  | "signature_metadata"
  | "unknown";

export type DoctorSourceRequiredCheck =
  | "frontend-patch-compatibility"
  | "static-asset-integrity"
  | "localization-resource-compatibility"
  | "preload-bridge-compatibility"
  | "main-process-patch-compatibility"
  | "helper-and-desktop-shell-compatibility"
  | "native-module-abi-compatibility"
  | "bundled-executable-compatibility"
  | "plugin-runtime-compatibility"
  | "package-metadata-integrity"
  | "backend-version-and-app-server-compatibility"
  | "generated-app-server-schema-compatibility"
  | "asar-integrity-and-package-identity";

export interface DoctorSourceChange {
  artifact: "shipped_file" | "asar_member" | "schema";
  path: string;
  change: "added" | "removed" | "modified";
  beforeSha256: DoctorSourceSha256 | null;
  afterSha256: DoctorSourceSha256 | null;
  semanticEquivalent: boolean;
  relevance: "relevant" | "irrelevant" | "unresolved";
  area: DoctorSourceArea;
  tweakersOwnership: string | null;
  requiredChecks: DoctorSourceRequiredCheck[];
  reason: string;
}

export interface DoctorSourceRename {
  artifact: "shipped_file" | "asar_member" | "schema";
  fromPath: string;
  toPath: string;
  sha256: DoctorSourceSha256;
  relevance: "relevant" | "irrelevant" | "unresolved";
  area: DoctorSourceArea;
  tweakersOwnership: string | null;
  requiredChecks: DoctorSourceRequiredCheck[];
  reason: string;
}

export interface DoctorSourceComparison {
  schemaVersion: 1;
  kind: "tweakers-doctor-source-comparison";
  beforeFingerprint: DoctorSourceSha256;
  afterFingerprint: DoctorSourceSha256;
  identical: boolean;
  complete: boolean;
  changes: DoctorSourceChange[];
  renamedIdenticalArtifacts: DoctorSourceRename[];
  requiredChecks: DoctorSourceRequiredCheck[];
  unresolvedEvidence: string[];
  backendSourceComparison: DoctorBackendSourceComparison;
  fingerprint: DoctorSourceSha256;
}

interface DoctorCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message?: string };
}

interface DoctorCommandOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export interface DoctorSourceEvidenceDependencies {
  run(command: string, args: readonly string[], options: DoctorCommandOptions): DoctorCommandResult;
}

const DEFAULT_DEPENDENCIES: DoctorSourceEvidenceDependencies = {
  run(command, args, options) {
    return spawnSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
      timeout: options.timeout,
    });
  },
};

let dependencies: DoctorSourceEvidenceDependencies = DEFAULT_DEPENDENCIES;
const DOCTOR_SOURCE_COLLECTOR_VERSION = 3;

/** Test seam. Production callers should use the two-argument collector. */
export function setDoctorSourceEvidenceDependenciesForTest(
  replacement: Partial<DoctorSourceEvidenceDependencies>,
): () => void {
  const previous = dependencies;
  dependencies = { ...DEFAULT_DEPENDENCIES, ...replacement };
  return () => { dependencies = previous; };
}

export async function collectDoctorSourceEvidence(
  appPath: string,
  outputRoot: string,
): Promise<DoctorSourceEvidence> {
  const appRoot = exactAbsolutePath(appPath, "Doctor app path");
  const artifactsRoot = exactAbsolutePath(outputRoot, "Doctor output root");
  if (sameOrInside(artifactsRoot, appRoot)) {
    throw new Error("Doctor output root must be outside the app bundle");
  }
  mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });

  const unresolvedEvidence: string[] = [];
  const info = readBundleVersion(appRoot, unresolvedEvidence);
  const shippedFiles = collectTreeInventory(appRoot, unresolvedEvidence, "app");
  // Reuse only complete, locally retained evidence after rehashing the entire app
  // inventory and generated schemas. Missing or changed bytes regenerate output.
  try {
    const cached = JSON.parse(readStableRegularFile(join(artifactsRoot, "doctor-source-evidence.json")).toString("utf8")) as DoctorSourceEvidence;
    const schemaRoot = join(artifactsRoot, "app-server-schema");
    if (cached.collectorVersion === DOCTOR_SOURCE_COLLECTOR_VERSION
      && cached.schemas?.root === schemaRoot) {
      const problems: string[] = [];
      const schemaFiles = collectTreeInventory(schemaRoot, problems, "schema", true);
      const schemaProblem = schemaInventoryProblem(schemaRoot, schemaFiles, problems);
      if (cached.complete && cached.appPath === appRoot
        && cached.version === info.version && cached.build === info.build && !unresolvedEvidence.length
        && cached.schemas.state === "complete" && cached.schemas.problem === null && schemaProblem === null
        && canonicalJson(cached.shippedFiles) === canonicalJson(shippedFiles)
        && canonicalJson(cached.schemas.files) === canonicalJson(schemaFiles)
        && cached.schemas.fingerprint === fingerprintInventory(schemaFiles)
        && cached.fingerprint === sha256(Buffer.from(canonicalJson(fingerprintPayload(cached))))) return cached;
    }
  } catch { /* Recover by rebuilding disposable evidence; never bless a partial cache. */ }

  const backendRelativePath = "Contents/Resources/codex" as const;
  const backendPath = join(appRoot, ...backendRelativePath.split("/"));
  let backendSha256: DoctorSourceSha256 | null = null;
  let backendVersion: string | null = null;
  if (isRegularFile(backendPath)) {
    try { backendSha256 = sha256(readFileSync(backendPath)); }
    catch (error) { unresolvedEvidence.push(`backend-unreadable:${errorMessage(error)}`); }
    const versionResult = dependencies.run(backendPath, ["--version"], {
      env: isolatedEnvironment(join(artifactsRoot, "schema-home"), join(artifactsRoot, "tmp")),
      timeout: 30_000,
    });
    if (versionResult.status === 0) {
      backendVersion = normalizeBackendVersion(`${versionResult.stdout ?? ""}${versionResult.stderr ?? ""}`);
      if (backendVersion === null) unresolvedEvidence.push("backend-version-output-empty");
    } else {
      unresolvedEvidence.push(`backend-version-unavailable:${commandProblem(versionResult)}`);
    }
  } else {
    unresolvedEvidence.push("backend-missing:Contents/Resources/codex");
  }

  const asarRelativePath = "Contents/Resources/app.asar" as const;
  const asarPath = join(appRoot, ...asarRelativePath.split("/"));
  let asarSha256: DoctorSourceSha256 | null = null;
  let asarMembers: DoctorSourceAsarMemberEvidence[] = [];
  if (isRegularFile(asarPath)) {
    try {
      const bytes = readFileSync(asarPath);
      asarSha256 = sha256(bytes);
      asarMembers = collectAsarInventory(asarPath);
    } catch (error) {
      unresolvedEvidence.push(`asar-unreadable:${errorMessage(error)}`);
    }
  } else {
    unresolvedEvidence.push("asar-missing:Contents/Resources/app.asar");
  }

  const schemas = collectSchemas(backendPath, backendSha256 !== null, artifactsRoot);
  if (schemas.state !== "complete") unresolvedEvidence.push(`schema-${schemas.state}:${schemas.problem ?? "unavailable"}`);

  const payload = {
    schemaVersion: 1 as const,
    kind: "tweakers-doctor-source-evidence" as const,
    collectorVersion: DOCTOR_SOURCE_COLLECTOR_VERSION,
    appPath: appRoot,
    version: info.version,
    build: info.build,
    backend: { path: backendRelativePath, version: backendVersion, sha256: backendSha256 },
    shippedFiles,
    asar: { path: asarRelativePath, sha256: asarSha256, members: asarMembers },
    schemas,
    complete: false,
    unresolvedEvidence: [...new Set(unresolvedEvidence)].sort(),
    artifact: "doctor-source-evidence.json" as const,
  };
  payload.complete = payload.unresolvedEvidence.length === 0
    && payload.version !== null
    && payload.build !== null
    && payload.backend.version !== null
    && payload.backend.sha256 !== null
    && payload.asar.sha256 !== null
    && payload.schemas.state === "complete";
  const fingerprint = sha256(Buffer.from(canonicalJson(fingerprintPayload(payload))));
  const evidence: DoctorSourceEvidence = { ...payload, fingerprint };
  writeJsonAtomically(join(artifactsRoot, evidence.artifact), evidence);
  return evidence;
}

export function compareDoctorSourceEvidence(
  before: DoctorSourceEvidence,
  after: DoctorSourceEvidence,
): DoctorSourceComparison {
  const changes: DoctorSourceChange[] = [];
  const renamedIdenticalArtifacts: DoctorSourceRename[] = [];
  compareInventory("shipped_file", before.shippedFiles, after.shippedFiles, changes, renamedIdenticalArtifacts);
  compareAsarMembers(before.asar.members, after.asar.members, changes, renamedIdenticalArtifacts);
  compareInventory("schema", before.schemas.files, after.schemas.files, changes, renamedIdenticalArtifacts);

  // Ownership classification stays on each change. Comparison completeness
  // records whether both inventories and their evidence were captured fully.
  const unresolvedEvidence = [
    ...before.unresolvedEvidence.map((problem) => `before:${problem}`),
    ...after.unresolvedEvidence.map((problem) => `after:${problem}`),
  ];
  const requiredChecks = [...new Set([
    ...changes.flatMap((change) => change.requiredChecks),
    ...renamedIdenticalArtifacts.flatMap((rename) => rename.requiredChecks),
  ])].sort() as DoctorSourceRequiredCheck[];
  const common = {
    schemaVersion: 1 as const,
    kind: "tweakers-doctor-source-comparison" as const,
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    identical: before.fingerprint === after.fingerprint,
    complete: before.complete && after.complete && unresolvedEvidence.length === 0,
    changes: changes.sort(changeOrder),
    renamedIdenticalArtifacts: renamedIdenticalArtifacts.sort(renameOrder),
    requiredChecks,
    unresolvedEvidence: [...new Set(unresolvedEvidence)].sort(),
    backendSourceComparison: {
      status: "not_attempted" as const,
      reason: "Desktop frontend source is not inferred from GitHub; backend tag comparison requires a separately verified exact tag.",
    },
  };
  return { ...common, fingerprint: sha256(Buffer.from(canonicalJson(common))) };
}

function collectSchemas(
  backendPath: string,
  backendExists: boolean,
  outputRoot: string,
): DoctorSourceSchemaEvidence {
  const schemaRoot = join(outputRoot, "app-server-schema");
  const schemaHome = join(outputRoot, "schema-home");
  const tempRoot = join(outputRoot, "tmp");
  prepareOwnedDirectory(schemaRoot);
  prepareOwnedDirectory(schemaHome);
  prepareOwnedDirectory(tempRoot);
  const command = [backendPath, "app-server", "generate-json-schema", "--experimental", "--out", schemaRoot] as const;
  if (!backendExists) {
    return { state: "missing_backend", command, root: schemaRoot, files: [], fingerprint: null, problem: "Bundled backend is missing" };
  }
  const result = dependencies.run(backendPath, command.slice(1), {
    env: isolatedEnvironment(schemaHome, tempRoot),
    timeout: 60_000,
  });
  if (result.status !== 0) {
    return { state: "generation_failed", command, root: schemaRoot, files: [], fingerprint: null, problem: commandProblem(result) };
  }
  const problems: string[] = [];
  const files = collectTreeInventory(schemaRoot, problems, "schema", true);
  const problem = schemaInventoryProblem(schemaRoot, files, problems);
  if (problem !== null) {
    return {
      state: "invalid_output",
      command,
      root: schemaRoot,
      files,
      fingerprint: files.length === 0 ? null : fingerprintInventory(files),
      problem,
    };
  }
  return { state: "complete", command, root: schemaRoot, files, fingerprint: fingerprintInventory(files), problem: null };
}

function collectTreeInventory(
  root: string,
  problems: string[],
  label: string,
  requireBoundRoot = false,
): DoctorSourceFileEvidence[] {
  const files: DoctorSourceFileEvidence[] = [];
  if (!existsSync(root)) {
    problems.push(`${label}-root-missing:${root}`);
    return files;
  }
  if (requireBoundRoot) {
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        problems.push(`${label}-root-unsafe:${root}`);
        return files;
      }
    } catch (error) {
      problems.push(`${label}-root-unreadable:${errorMessage(error)}`);
      return files;
    }
  }
  const visit = (directory: string): void => {
    let before;
    try {
      before = lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        problems.push(`${label}-directory-unsafe:${slashPath(relative(root, directory))}`);
        return;
      }
    } catch (error) {
      problems.push(`${label}-directory-unreadable:${slashPath(relative(root, directory))}:${errorMessage(error)}`);
      return;
    }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { problems.push(`${label}-directory-unreadable:${slashPath(relative(root, directory))}:${errorMessage(error)}`); return; }
    for (const entry of entries) {
      if (!safeInventoryName(entry.name)) {
        problems.push(`${label}-unsafe-entry:${slashPath(relative(root, directory))}:${entry.name}`);
        continue;
      }
      const path = join(directory, entry.name);
      const local = slashPath(relative(root, path));
      try {
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) {
          const bytes = readStableRegularFile(path);
          files.push({ path: local, kind: "file", bytes: bytes.byteLength, sha256: sha256(bytes) });
        } else if (entry.isSymbolicLink()) {
          const target = readlinkSync(path);
          files.push({ path: local, kind: "symlink", bytes: Buffer.byteLength(target), sha256: sha256(Buffer.from(`symlink:${target}`)), linkTarget: target });
        } else problems.push(`${label}-unsupported-entry:${local}`);
      } catch (error) {
        problems.push(`${label}-entry-unreadable:${local}:${errorMessage(error)}`);
      }
    }
    try {
      const after = lstatSync(directory);
      if (!sameFileIdentity(before, after)) problems.push(`${label}-directory-changed:${slashPath(relative(root, directory))}`);
    } catch (error) {
      problems.push(`${label}-directory-unreadable:${slashPath(relative(root, directory))}:${errorMessage(error)}`);
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function collectAsarInventory(asarPath: string): DoctorSourceAsarMemberEvidence[] {
  // Read the immutable archive header once and keep one descriptor open for
  // packed payloads. The general ASAR extraction helper opens the archive for
  // every member, which is needlessly expensive for a complete inventory.
  const raw = asar.getRawHeader(asarPath) as { header: DoctorAsarNode; headerSize: number };
  const entries: Array<{ path: string; node: DoctorAsarNode }> = [];
  collectDoctorAsarEntries(raw.header, "", entries);
  const knownReferences = new Map(entries.map(({ path }) => {
    const name = basename(path);
    return [name, canonicalHashedFilename(name)];
  }));
  const fd = openSync(asarPath, "r");
  try {
    return entries.map(({ path, node }) => {
      if (typeof node.link === "string") {
        const bytes = Buffer.from(`symlink:${node.link}`);
        return {
          path, kind: "symlink" as const, bytes: Buffer.byteLength(node.link), rawSha256: sha256(bytes),
          semanticSha256: sha256(bytes), unpacked: false, linkTarget: node.link,
        };
      }
      const bytes = readDoctorAsarMember(asarPath, fd, raw.headerSize, path, node);
      return {
        path,
        kind: "file" as const,
        bytes: bytes.byteLength,
        rawSha256: sha256(bytes),
        semanticSha256: semanticHash(path, bytes, knownReferences),
        unpacked: node.unpacked === true,
      };
    });
  } finally { closeSync(fd); }
}

interface DoctorAsarNode {
  files?: Record<string, DoctorAsarNode>;
  link?: string;
  unpacked?: boolean;
  offset?: string;
  size?: number;
}

function collectDoctorAsarEntries(
  node: DoctorAsarNode,
  parent: string,
  output: Array<{ path: string; node: DoctorAsarNode }>,
): void {
  if (node.files !== undefined) {
    for (const name of Object.keys(node.files).sort()) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error(`Invalid ASAR member name under ${parent || "/"}`);
      }
      const path = parent ? `${parent}/${name}` : name;
      collectDoctorAsarEntries(node.files[name]!, path, output);
    }
    return;
  }
  output.push({ path: parent, node });
}

function readDoctorAsarMember(
  asarPath: string,
  fd: number,
  headerSize: number,
  path: string,
  node: DoctorAsarNode,
): Buffer {
  if (!Number.isSafeInteger(node.size) || node.size! < 0) throw new Error(`Invalid ASAR member size for ${path}`);
  if (node.unpacked === true) return readFileSync(join(`${asarPath}.unpacked`, ...path.split("/")));
  if (typeof node.offset !== "string" || !/^\d+$/.test(node.offset)) throw new Error(`Invalid ASAR member offset for ${path}`);
  const offset = 8n + BigInt(headerSize) + BigInt(node.offset);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ASAR member offset exceeds safe range for ${path}`);
  const bytes = Buffer.alloc(node.size!);
  let read = 0;
  while (read < bytes.byteLength) {
    const count = readSync(fd, bytes, read, bytes.byteLength - read, Number(offset) + read);
    if (count === 0) break;
    read += count;
  }
  if (read !== bytes.byteLength) throw new Error(`Incomplete ASAR member payload for ${path}`);
  return bytes;
}

function compareInventory(
  artifact: "shipped_file" | "schema",
  before: DoctorSourceFileEvidence[],
  after: DoctorSourceFileEvidence[],
  changes: DoctorSourceChange[],
  renames: DoctorSourceRename[],
): void {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const removed = before.filter((entry) => !afterMap.has(entry.path));
  const added = after.filter((entry) => !beforeMap.has(entry.path));
  pairRenames(artifact, removed, added, (entry) => entry.sha256, changes, renames);
  for (const path of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
    const left = beforeMap.get(path);
    const right = afterMap.get(path);
    if (!left || !right || left.sha256 === right.sha256) continue;
    changes.push(classifiedChange(artifact, path, "modified", left.sha256, right.sha256, false));
  }
}

function compareAsarMembers(
  before: DoctorSourceAsarMemberEvidence[],
  after: DoctorSourceAsarMemberEvidence[],
  changes: DoctorSourceChange[],
  renames: DoctorSourceRename[],
): void {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  pairRenames(
    "asar_member",
    before.filter((entry) => !afterMap.has(entry.path)),
    after.filter((entry) => !beforeMap.has(entry.path)),
    (entry) => entry.rawSha256,
    changes,
    renames,
  );
  for (const path of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
    const left = beforeMap.get(path);
    const right = afterMap.get(path);
    if (!left || !right || left.rawSha256 === right.rawSha256) continue;
    changes.push(classifiedChange(
      "asar_member", path, "modified", left.rawSha256, right.rawSha256,
      left.semanticSha256 === right.semanticSha256,
    ));
  }
}

function pairRenames<T extends { path: string }>(
  artifact: "shipped_file" | "asar_member" | "schema",
  removed: T[],
  added: T[],
  digest: (entry: T) => DoctorSourceSha256,
  changes: DoctorSourceChange[],
  renames: DoctorSourceRename[],
): void {
  const available = new Set(added);
  for (const left of removed.sort((a, b) => a.path.localeCompare(b.path))) {
    const right = [...available].sort((a, b) => a.path.localeCompare(b.path)).find((entry) => digest(entry) === digest(left));
    if (!right) continue;
    available.delete(right);
    const classification = classifyArtifact(artifact, right.path, false);
    renames.push({ artifact, fromPath: left.path, toPath: right.path, sha256: digest(left), ...classification });
  }
  const renamedFrom = new Set(renames.filter((entry) => entry.artifact === artifact).map((entry) => entry.fromPath));
  const renamedTo = new Set(renames.filter((entry) => entry.artifact === artifact).map((entry) => entry.toPath));
  for (const entry of removed) {
    if (!renamedFrom.has(entry.path)) changes.push(classifiedChange(artifact, entry.path, "removed", digest(entry), null, false));
  }
  for (const entry of added) {
    if (!renamedTo.has(entry.path)) changes.push(classifiedChange(artifact, entry.path, "added", null, digest(entry), false));
  }
}

function classifiedChange(
  artifact: "shipped_file" | "asar_member" | "schema",
  path: string,
  change: DoctorSourceChange["change"],
  beforeSha256: DoctorSourceSha256 | null,
  afterSha256: DoctorSourceSha256 | null,
  semanticEquivalent: boolean,
): DoctorSourceChange {
  return { artifact, path, change, beforeSha256, afterSha256, semanticEquivalent, ...classifyArtifact(artifact, path, semanticEquivalent) };
}

function classifyArtifact(
  artifact: "shipped_file" | "asar_member" | "schema",
  path: string,
  semanticEquivalent: boolean,
): Pick<DoctorSourceChange, "relevance" | "area" | "tweakersOwnership" | "requiredChecks" | "reason"> {
  const lower = path.toLowerCase();
  if (artifact === "schema") return owned("schema", "Codex app-server protocol adapters", ["generated-app-server-schema-compatibility"], "Generated app-server schema changed");
  if (artifact === "asar_member") {
    if (semanticEquivalent) return { relevance: "irrelevant", area: "packaging", tweakersOwnership: null, requiredChecks: [], reason: "Raw content changed only by normalized content-hashed bundle filename references" };
    if (isLocaleResource(lower)) {
      return owned("localization", "Tweakers native menu and alert localization", ["localization-resource-compatibility"], "Codex locale resource changed");
    }
    if (lower.endsWith("/.codex-native-module-build.json")) {
      return owned("package_metadata", "Tweakers native module build configuration", ["package-metadata-integrity", "native-module-abi-compatibility"], "Native module build metadata changed");
    }
    if (isNativeModule(lower)) {
      return owned("native_modules", "Tweakers native module packaging and runtime loading", ["native-module-abi-compatibility"], "Codex native module changed");
    }
    if (isStaticAsset(lower)) {
      return owned("static_assets", "Tweakers renderer assets and packaged app presentation", ["static-asset-integrity"], "Codex static image or font asset changed");
    }
    if (lower.startsWith("webview/")) return owned("frontend", "Tweakers renderer patches and settings injection", ["frontend-patch-compatibility"], "Codex renderer artifact changed");
    if (/(^|\/)preload(?:[-./]|$)/.test(lower)) return owned("preload", "Tweakers preload bridge", ["preload-bridge-compatibility"], "Codex preload artifact changed");
    if (/(^|\/)\.vite\/build\/main[-.]|(^|\/)main[-.].*\.[cm]?js$/.test(lower) || lower === "package.json") {
      return owned("main", "Tweakers main-process patches and loader", ["main-process-patch-compatibility"], "Codex main-process artifact changed");
    }
    if (/\.[cm]?js$/.test(lower) || lower.includes("helper")) return owned("helpers", "Tweakers desktop helper integration", ["helper-and-desktop-shell-compatibility"], "Codex bundled helper artifact changed");
    return unresolved("ASAR member has no Tweakers compatibility ownership mapping");
  }
  if (lower === "contents/resources/codex") return owned("backend", "Tweakers bundled backend and app-server integration", ["backend-version-and-app-server-compatibility", "generated-app-server-schema-compatibility"], "Bundled Codex backend changed");
  if (lower === "contents/resources/app.asar" || lower === "contents/info.plist") {
    return owned("packaging", "Tweakers package identity and ASAR validation", ["asar-integrity-and-package-identity"], "Desktop package artifact changed");
  }
  if (lower.startsWith("contents/_codesignature/") || lower.endsWith("/coderesources")) {
    return { relevance: "irrelevant", area: "signature_metadata", tweakersOwnership: null, requiredChecks: [], reason: "Code-signing metadata is recorded but does not define a Tweakers source compatibility surface" };
  }
  if (isLocaleResource(lower)) {
    return owned("localization", "Tweakers native menu and alert localization", ["localization-resource-compatibility"], "Packaged locale resource changed");
  }
  if (isNativeModule(lower)) {
    return owned("native_modules", "Tweakers native module packaging and runtime loading", ["native-module-abi-compatibility"], "Packaged native module changed");
  }
  if (isStaticAsset(lower)) {
    return owned("static_assets", "Tweakers renderer assets and packaged app presentation", ["static-asset-integrity"], "Packaged static image or font asset changed");
  }
  if (isPackageMetadata(lower)) {
    return owned("package_metadata", "Tweakers package discovery and runtime configuration", ["package-metadata-integrity"], "Packaged runtime or plugin metadata changed");
  }
  if (lower === "contents/resources/third_party_notices.txt") {
    return owned("packaging", "Tweakers package notices", ["asar-integrity-and-package-identity"], "Bundled third-party notices changed");
  }
  if (/^contents\/resources\/cua_node\/lib\/node_modules\/@oai\/(?:cua|sky|cua-repl|browser-desktop)\//.test(lower)
    || lower === "contents/resources/cua_node/lib/node_modules/.bin/cua-repl"
    || lower === "contents/resources/cua_node/bin/setup.ps1"
    || lower === "contents/resources/artifact-template-picker/server.mjs") {
    return owned("helpers", "Tweakers desktop helper integration", ["helper-and-desktop-shell-compatibility"], "Bundled desktop helper source or launch script changed");
  }
  if (lower === "contents/resources/busy-bar.asar") {
    return owned("helpers", "Tweakers desktop helper packaging", ["helper-and-desktop-shell-compatibility", "asar-integrity-and-package-identity"], "Desktop helper archive changed");
  }
  if (lower.startsWith("contents/resources/plugins/")) {
    return owned("plugin_runtime", "Tweakers bundled plugin discovery and runtime integration", ["plugin-runtime-compatibility"], "Bundled plugin runtime changed");
  }
  if (isBundledExecutable(lower)) {
    return owned("desktop_executables", "Tweakers desktop shell and bundled executable integration", ["bundled-executable-compatibility"], "Bundled desktop executable changed");
  }
  if (lower.startsWith("contents/frameworks/") || lower.startsWith("contents/macos/")) {
    return owned("helpers", "Tweakers desktop shell and helper launch integration", ["helper-and-desktop-shell-compatibility"], "Desktop executable, framework, or helper changed");
  }
  return unresolved("Shipped file has no Tweakers compatibility ownership mapping");
}

function isStaticAsset(path: string): boolean {
  return path === "contents/resources/assets.car"
    || /\.(?:avif|eot|gif|icns|ico|jpe?g|otf|png|svg|ttf|webp|woff2?)$/.test(path);
}

function isLocaleResource(path: string): boolean {
  return /(^|\/)native-menu-locales\/[^/]+\.json$/.test(path);
}

function isNativeModule(path: string): boolean {
  return !path.startsWith("contents/frameworks/") && /\.(?:dylib|node|so)$/.test(path);
}

function isPackageMetadata(path: string): boolean {
  return path === "contents/resources/owl-app.ini"
    || path === "contents/resources/owl-electron-app.json"
    || path === "contents/resources/cua_node/manifest.json"
    || /^contents\/resources\/cua_node\/lib\/node_modules\/(?:\.package-map\.json|\.modules\.yaml|\.pnpm-workspace-state-v1\.json|\.pnpm\/lock\.yaml)$/.test(path)
    || /\.dsym\/contents\/info\.plist$/.test(path)
    || /\/plugins\/[^/]+\/\.codex-plugin\/plugin\.json$/.test(path)
    || path === "contents/resources/plugins/openai-bundled/.bundle-id";
}

function isBundledExecutable(path: string): boolean {
  return /^contents\/plugins\/[^/]+\/contents\/macos\//.test(path)
    || path === "contents/resources/codex_chronicle"
    || path === "contents/resources/codex-code-mode-host"
    || path === "contents/resources/rg"
    || path.startsWith("contents/resources/cua_node/bin/")
    || /^contents\/resources\/native\/[^/.]+$/.test(path)
    || path.endsWith("/node-pty/build/release/spawn-helper");
}

function owned(
  area: Exclude<DoctorSourceArea, "signature_metadata" | "unknown">,
  tweakersOwnership: string,
  requiredChecks: DoctorSourceRequiredCheck[],
  reason: string,
): Pick<DoctorSourceChange, "relevance" | "area" | "tweakersOwnership" | "requiredChecks" | "reason"> {
  return { relevance: "relevant", area, tweakersOwnership, requiredChecks, reason };
}

function unresolved(reason: string): Pick<DoctorSourceChange, "relevance" | "area" | "tweakersOwnership" | "requiredChecks" | "reason"> {
  return { relevance: "unresolved", area: "unknown", tweakersOwnership: null, requiredChecks: [], reason };
}

function readBundleVersion(appRoot: string, problems: string[]): { version: string | null; build: string | null } {
  const path = join(appRoot, "Contents", "Info.plist");
  try {
    const raw = readFileSync(path);
    let parsed: Record<string, unknown>;
    if (raw.subarray(0, 8).toString("ascii") === "bplist00") {
      const result = dependencies.run("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", path], {
        env: { PATH: "/usr/bin:/bin" }, timeout: 10_000,
      });
      if (result.status !== 0) throw new Error(commandProblem(result));
      parsed = plist.parse(result.stdout ?? "") as Record<string, unknown>;
    } else {
      // Reuse the repository's plist reader for ordinary XML fixtures/bundles.
      parsed = readPlist(path);
    }
    const version = nonEmptyString(parsed.CFBundleShortVersionString);
    const build = nonEmptyString(parsed.CFBundleVersion);
    if (version === null) problems.push("bundle-version-missing");
    if (build === null) problems.push("bundle-build-missing");
    return { version, build };
  } catch (error) {
    problems.push(`info-plist-unreadable:${errorMessage(error)}`);
    return { version: null, build: null };
  }
}

function semanticHash(path: string, bytes: Buffer, knownReferences: ReadonlyMap<string, string>): DoctorSourceSha256 {
  if (!/\.(?:[cm]?js|css|html|json|map|txt|md|svg|xml)$/i.test(path)) return sha256(bytes);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return sha256(bytes); }
  // Bundle references carry their own content hash in the basename. A single
  // lexical pass gives equivalent bundles the same semantic digest without
  // multiplying every source byte by the number of files in the archive.
  source = source.replace(
    /[A-Za-z0-9_.-]+\.(?:[cm]?js|css|html|json|map|wasm|node)\b/g,
    (filename) => knownReferences.get(filename) ?? filename,
  );
  return sha256(Buffer.from(source));
}

function canonicalHashedFilename(name: string): string {
  const extensionIndex = name.indexOf(".");
  if (extensionIndex <= 0) return name;
  const stem = name.slice(0, extensionIndex);
  const extension = name.slice(extensionIndex);
  const normalized = stem.split(/([_.-])/).map((segment) =>
    /^[A-Za-z0-9]{8,64}$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment) ? "HASH" : segment
  ).join("");
  return `${normalized}${extension}`;
}

function fingerprintPayload(payload: Omit<DoctorSourceEvidence, "fingerprint">): unknown {
  return {
    schemaVersion: payload.schemaVersion,
    kind: payload.kind,
    version: payload.version,
    build: payload.build,
    backend: payload.backend,
    shippedFiles: payload.shippedFiles,
    asar: payload.asar,
    schemas: {
      state: payload.schemas.state,
      files: payload.schemas.files,
      fingerprint: payload.schemas.fingerprint,
      problem: payload.schemas.problem,
    },
    complete: payload.complete,
    unresolvedEvidence: payload.unresolvedEvidence,
  };
}

function fingerprintInventory(files: DoctorSourceFileEvidence[]): DoctorSourceSha256 {
  return sha256(Buffer.from(canonicalJson(files)));
}

function isolatedEnvironment(home: string, tempRoot: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: home,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    TMPDIR: tempRoot,
  };
}

function prepareOwnedDirectory(path: string): void {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Doctor output path must not be a symlink: ${path}`);
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeJsonAtomically(path: string, value: unknown): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

function validInventoryJsonFile(root: string, file: DoctorSourceFileEvidence): boolean {
  if (file.kind !== "file" || !safeRelativeInventoryPath(file.path)) return false;
  try {
    const path = join(root, ...file.path.split("/"));
    if (!sameOrInside(path, root)) return false;
    const bytes = readStableRegularFile(path);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) return false;
    JSON.parse(bytes.toString("utf8"));
    return true;
  }
  catch { return false; }
}

function schemaInventoryProblem(
  root: string,
  files: DoctorSourceFileEvidence[],
  problems: string[],
): string | null {
  if (problems.length > 0) return problems[0]!;
  if (files.some((file) => file.kind === "symlink")) return "Schema generator emitted symbolic links";
  const jsonFiles = files.filter((file) => file.kind === "file" && file.path.endsWith(".json"));
  if (jsonFiles.length === 0) return "Schema generator emitted no JSON files";
  if (jsonFiles.some((file) => !validInventoryJsonFile(root, file))) return "Schema generator emitted invalid JSON";
  return null;
}

function readStableRegularFile(path: string): Buffer {
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("Evidence path is not a regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!sameFileIdentity(pathStat, before)) throw new Error("Evidence path changed before inspection");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameFileIdentity(before, after)) throw new Error("Evidence path changed during inspection");
    return bytes;
  } finally { closeSync(fd); }
}

function sameFileIdentity(
  before: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">,
  after: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">,
): boolean {
  return before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

function safeInventoryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function safeRelativeInventoryPath(path: string): boolean {
  return path !== "" && path.split("/").every(safeInventoryName);
}

function normalizeBackendVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^codex-cli\s+/, "").split(/\s+/).at(-1) ?? null;
}

function exactAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an exact absolute path`);
  return path;
}

function sameOrInside(child: string, parent: string): boolean {
  const local = relative(parent, child);
  return local === "" || (!local.startsWith(`..${sep}`) && local !== "..");
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); }
  catch { return false; }
}

function sha256(bytes: Buffer): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Doctor canonical JSON received a non-JSON value");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function commandProblem(result: DoctorCommandResult): string {
  return result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status ?? "unknown"}`;
}

function slashPath(path: string): string { return path.split(sep).join("/"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function changeOrder(a: DoctorSourceChange, b: DoctorSourceChange): number { return a.artifact.localeCompare(b.artifact) || a.path.localeCompare(b.path); }
function renameOrder(a: DoctorSourceRename, b: DoctorSourceRename): number { return a.artifact.localeCompare(b.artifact) || a.fromPath.localeCompare(b.fromPath) || a.toPath.localeCompare(b.toPath); }

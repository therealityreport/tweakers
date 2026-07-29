import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertInternalStoragePath } from "./internal-storage.js";
import { userPaths } from "./paths.js";

export const MANAGED_MCP_STAGE_SCHEMA_VERSION = 1 as const;

export interface ManagedMcpRouteEvidence {
  routeId: string;
  owner: string | null;
  profile: string | null;
  command: string;
  args: readonly string[];
  lifecycleScope: string | null;
}

export interface ManagedMcpPackageEvidence {
  name: string;
  version: string;
  integrity: string;
  packageDirectory: string;
  destination: string;
  disposition: "staged" | "reused" | "replaced";
  lockFile: string;
  lockSha256: string;
  catalogFile: string;
  catalogFileSha256: string;
  catalogDigestSha256: string;
  packageLockSha256: string;
  dependencyGraphDigestSha256: string;
  runtimeTreeDigestSha256: string;
  wrapperSha256: string;
  routes: readonly ManagedMcpRouteEvidence[];
}

export interface ManagedMcpStageEvidence {
  schemaVersion: typeof MANAGED_MCP_STAGE_SCHEMA_VERSION;
  managedRoot: string;
  stagedAt: string;
  packages: readonly ManagedMcpPackageEvidence[];
}

export interface StageCodexManagedMcpPackagesOptions {
  chromePluginRoot: string;
  playwrightPluginRoot: string;
  /** Test/canary override. Production callers should omit this and use userPaths().managedMcpRoot. */
  managedMcpRoot?: string;
  now?: () => string;
}

interface ReleasePackage {
  name: string;
  version: string;
  integrity: string;
  entrypoint: string;
  packageJsonSha256: string;
  entrypointSha256: string;
}

interface DependencyReceipt {
  path: string;
  name: string;
  version: string;
  integrity: string;
  resolved: string;
  packageJsonSha256: string;
}

interface PlaywrightProfile {
  owner: string;
  lifecycleScope: string;
  args: string[];
}

interface ManagedMcpReleaseLock {
  schemaVersion: number;
  package: ReleasePackage;
  dependencyGraph: {
    packages: DependencyReceipt[];
    digestSha256: string;
  };
  profiles?: Record<string, PlaywrightProfile>;
  catalog: {
    path: string;
    digestSha256: string;
  };
  runtime: {
    wrapper: string;
    managedRootEnvironment: string;
    packageDirectory: string;
    sourceCanaryRoot: string;
    treeDigestFormat: string;
    treeEntryCount: number;
    treeDigestSha256: string;
  };
  review: {
    policy: string;
    approvedVersion: string;
  };
}

interface VerifiedReleaseSource {
  pluginRoot: string;
  lockFile: string;
  lock: ManagedMcpReleaseLock;
  lockSha256: string;
  catalogFile: string;
  catalogFileSha256: string;
  catalogDigestSha256: string;
  runtimeRoot: string;
  packageLockSha256: string;
  runtimeTreeDigestSha256: string;
  wrapper: string;
  wrapperSha256: string;
  routes: ManagedMcpRouteEvidence[];
}

/**
 * Stages the reviewed Chrome DevTools and Playwright MCP release artifacts into
 * the installer-owned, versioned package store. This function never runs npm,
 * npx, or a package entrypoint and does not edit Codex configuration.
 */
export function stageCodexManagedMcpPackages(
  options: StageCodexManagedMcpPackagesOptions,
): ManagedMcpStageEvidence {
  const managedRoot = resolve(options.managedMcpRoot ?? userPaths().managedMcpRoot);
  assertInternalStoragePath(managedRoot, "Managed MCP package root");

  const sources = [
    verifyReleaseSource(options.chromePluginRoot, "release/chrome-devtools-mcp.lock.json", "chrome"),
    verifyReleaseSource(options.playwrightPluginRoot, "release/playwright-mcp.lock.json", "playwright"),
  ];
  const packages = sources.map((source) => stageVerifiedSource(source, managedRoot));

  return {
    schemaVersion: MANAGED_MCP_STAGE_SCHEMA_VERSION,
    managedRoot,
    stagedAt: (options.now ?? (() => new Date().toISOString()))(),
    packages,
  };
}

function verifyReleaseSource(
  pluginRootInput: string,
  lockRelativePath: string,
  routeKind: "chrome" | "playwright",
): VerifiedReleaseSource {
  const pluginRoot = resolve(pluginRootInput);
  assertInternalStoragePath(pluginRoot, "Managed MCP release source");
  const lockFile = resolveContained(pluginRoot, lockRelativePath, "release lock");
  const lockBytes = readRequiredFile(lockFile, "release lock");
  const lock = parseReleaseLock(lockBytes, lockFile);
  validateReleaseLock(lock, routeKind);

  const catalogFile = resolveContained(pluginRoot, lock.catalog.path, "catalog");
  const catalogBytes = readRequiredFile(catalogFile, "catalog");
  const catalog = parseJsonRecord(catalogBytes, catalogFile);
  const catalogDigestSha256 = verifyCatalog(pluginRoot, catalog, lock, routeKind);

  const runtimeRoot = resolveContained(pluginRoot, lock.runtime.sourceCanaryRoot, "release runtime");
  const packageLockFile = join(runtimeRoot, "package-lock.json");
  const packageLockBytes = readRequiredFile(packageLockFile, "runtime package lock");
  const packageLock = parseJsonRecord(packageLockBytes, packageLockFile);
  verifyRuntime(runtimeRoot, lock, packageLock);

  const wrapper = resolveContained(pluginRoot, lock.runtime.wrapper, "locked wrapper");
  const wrapperBytes = readRequiredFile(wrapper, "locked wrapper");
  rejectFloatingLaunchText(wrapperBytes.toString("utf8"), `wrapper ${wrapper}`);

  return {
    pluginRoot,
    lockFile,
    lock,
    lockSha256: sha256(lockBytes),
    catalogFile,
    catalogFileSha256: sha256(catalogBytes),
    catalogDigestSha256,
    runtimeRoot,
    packageLockSha256: sha256(packageLockBytes),
    runtimeTreeDigestSha256: lock.runtime.treeDigestSha256,
    wrapper,
    wrapperSha256: sha256(wrapperBytes),
    routes: routeEvidence(routeKind, pluginRoot, lock),
  };
}

function validateReleaseLock(lock: ManagedMcpReleaseLock, routeKind: "chrome" | "playwright"): void {
  if (lock.schemaVersion !== 1) throw new Error(`Unsupported managed MCP release lock schema ${lock.schemaVersion}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(lock.package.version)) {
    throw new Error(`Managed MCP package ${lock.package.name} must use an exact stable version`);
  }
  if (lock.review.policy !== "newest-non-prerelease-semver") {
    throw new Error(`Managed MCP package ${lock.package.name} was not prepared by the stable review policy`);
  }
  if (lock.review.approvedVersion !== lock.package.version) {
    throw new Error(`Managed MCP review version does not match ${lock.package.name}@${lock.package.version}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(lock.package.integrity)) {
    throw new Error(`Managed MCP package ${lock.package.name} lacks an exact sha512 integrity`);
  }
  if (!isSafeSegment(lock.runtime.packageDirectory)) {
    throw new Error(`Unsafe managed MCP package directory ${lock.runtime.packageDirectory}`);
  }
  if (lock.runtime.managedRootEnvironment !== "CODEX_MANAGED_MCP_ROOT") {
    throw new Error(`Managed MCP release lock must use CODEX_MANAGED_MCP_ROOT`);
  }
  if (lock.runtime.treeDigestFormat !== "sha256-json-path-kind-mode-content-v1") {
    throw new Error(`Managed MCP release lock uses an unsupported runtime tree digest format`);
  }
  if (!Number.isSafeInteger(lock.runtime.treeEntryCount) || lock.runtime.treeEntryCount < 1) {
    throw new Error(`Managed MCP release lock has an invalid runtime tree entry count`);
  }
  assertSafeRelativePath(lock.package.entrypoint, "package entrypoint");
  assertSafeRelativePath(lock.catalog.path, "catalog path");
  assertSafeRelativePath(lock.runtime.wrapper, "wrapper path");
  assertSafeRelativePath(lock.runtime.sourceCanaryRoot, "runtime path");
  rejectFloatingLaunchText(lock.runtime.wrapper, "locked wrapper path");

  if (routeKind === "playwright") {
    const profiles = lock.profiles ?? {};
    for (const name of ["general", "infographic"] as const) {
      const profile = profiles[name];
      if (!profile) throw new Error(`Playwright release lock is missing the ${name} logical profile`);
      if (profile.lifecycleScope !== "task") {
        throw new Error(`Playwright ${name} profile must be task scoped`);
      }
      rejectFloatingLaunchText(JSON.stringify(profile.args), `Playwright ${name} profile`);
    }
  }
}

function verifyCatalog(
  pluginRoot: string,
  catalog: Record<string, unknown>,
  lock: ManagedMcpReleaseLock,
  routeKind: "chrome" | "playwright",
): string {
  const catalogPackage = requireRecord(catalog.package, "catalog.package");
  if (catalogPackage.name !== lock.package.name || catalogPackage.version !== lock.package.version) {
    throw new Error(`Catalog identity does not match ${lock.package.name}@${lock.package.version}`);
  }

  let digest: string;
  if (routeKind === "chrome") {
    if (!Array.isArray(catalog.sources)) throw new Error("Chrome catalog sources are missing");
    const sources = catalog.sources.map((value, index) => {
      const source = requireRecord(value, `catalog.sources[${index}]`);
      const path = requireString(source.path, `catalog.sources[${index}].path`);
      const expected = requireSha256(source.sha256, `catalog.sources[${index}].sha256`);
      const file = resolveContained(pluginRoot, path, "catalog source");
      const actual = sha256(readRequiredFile(file, "catalog source"));
      if (actual !== expected) throw new Error(`Catalog source ${path} digest mismatch`);
      return { path, sha256: actual };
    });
    digest = digestJson({ sources, upstreamSurface: catalog.upstreamSurface });
  } else {
    if (JSON.stringify(catalog.profiles) !== JSON.stringify(lock.profiles)) {
      throw new Error("Playwright catalog profiles do not match the release lock");
    }
    digest = digestJson({ profiles: catalog.profiles, surface: catalog.surface });
  }

  if (digest !== lock.catalog.digestSha256) throw new Error("Managed MCP catalog digest does not match the release lock");
  if (catalog.digestSha256 !== undefined && catalog.digestSha256 !== digest) {
    throw new Error("Managed MCP catalog self-digest is invalid");
  }
  return digest;
}

function verifyRuntime(
  runtimeRoot: string,
  lock: ManagedMcpReleaseLock,
  packageLockInput?: Record<string, unknown>,
): void {
  const packageLockFile = join(runtimeRoot, "package-lock.json");
  const packageLock = packageLockInput ?? parseJsonRecord(readRequiredFile(packageLockFile, "runtime package lock"), packageLockFile);
  const packages = requireRecord(packageLock.packages, "package-lock.packages");
  const root = requireRecord(packages[""], "package-lock.packages root");
  const rootDependencies = requireRecord(root.dependencies, "package-lock root dependencies");
  if (rootDependencies[lock.package.name] !== lock.package.version) {
    throw new Error(`Runtime package lock does not pin ${lock.package.name}@${lock.package.version}`);
  }

  const runtimePackageFile = join(runtimeRoot, "package.json");
  const runtimePackage = parseJsonRecord(readRequiredFile(runtimePackageFile, "runtime package manifest"), runtimePackageFile);
  const manifestDependencies = requireRecord(runtimePackage.dependencies, "runtime package dependencies");
  if (manifestDependencies[lock.package.name] !== lock.package.version) {
    throw new Error(`Runtime package manifest does not pin ${lock.package.name}@${lock.package.version}`);
  }

  const dependencyReceipts = Object.entries(packages)
    .filter(([path, value]) => path.startsWith("node_modules/") && isRecord(value) && typeof value.version === "string")
    .map(([path, value]) => {
      assertSafeDependencyPath(path);
      const lockEntry = requireRecord(value, `package-lock ${path}`);
      const packageJsonFile = resolveContained(runtimeRoot, `${path}/package.json`, "dependency package manifest");
      const packageJsonBytes = readRequiredFile(packageJsonFile, "dependency package manifest");
      const packageJson = parseJsonRecord(packageJsonBytes, packageJsonFile);
      return {
        path,
        name: requireString(packageJson.name, `${path} package name`),
        version: requireString(lockEntry.version, `${path} version`),
        integrity: requireString(lockEntry.integrity, `${path} integrity`),
        resolved: requireString(lockEntry.resolved, `${path} resolved tarball`),
        packageJsonSha256: sha256(packageJsonBytes),
      } satisfies DependencyReceipt;
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

  if (digestJson(dependencyReceipts) !== lock.dependencyGraph.digestSha256) {
    throw new Error("Runtime dependency graph digest does not match the release lock");
  }
  if (JSON.stringify(dependencyReceipts) !== JSON.stringify(lock.dependencyGraph.packages)) {
    throw new Error("Runtime dependency graph does not exactly match the release lock");
  }

  const topLevelPath = `node_modules/${lock.package.name}`;
  const topLevel = requireRecord(packages[topLevelPath], `package-lock ${topLevelPath}`);
  if (topLevel.version !== lock.package.version || topLevel.integrity !== lock.package.integrity) {
    throw new Error(`Runtime package lock identity or integrity does not match ${lock.package.name}@${lock.package.version}`);
  }

  const packageRoot = resolveContained(runtimeRoot, topLevelPath, "managed package");
  const packageJsonFile = join(packageRoot, "package.json");
  const packageJsonBytes = readRequiredFile(packageJsonFile, "managed package manifest");
  const packageJson = parseJsonRecord(packageJsonBytes, packageJsonFile);
  if (packageJson.name !== lock.package.name || packageJson.version !== lock.package.version) {
    throw new Error(`Installed managed package does not match ${lock.package.name}@${lock.package.version}`);
  }
  verifySha256("managed package manifest", packageJsonBytes, lock.package.packageJsonSha256);
  const entrypoint = resolveContained(packageRoot, lock.package.entrypoint, "managed package entrypoint");
  verifySha256("managed package entrypoint", readRequiredFile(entrypoint, "managed package entrypoint"), lock.package.entrypointSha256);

  const runtimeTree = digestRuntimeTree(runtimeRoot);
  if (runtimeTree.entryCount !== lock.runtime.treeEntryCount) {
    throw new Error(`Runtime tree entry count mismatch: expected ${lock.runtime.treeEntryCount}, got ${runtimeTree.entryCount}`);
  }
  if (runtimeTree.digestSha256 !== lock.runtime.treeDigestSha256) {
    throw new Error(`Runtime tree digest mismatch: expected ${lock.runtime.treeDigestSha256}, got ${runtimeTree.digestSha256}`);
  }
}

function stageVerifiedSource(source: VerifiedReleaseSource, managedRoot: string): ManagedMcpPackageEvidence {
  const packageParent = join(managedRoot, source.lock.runtime.packageDirectory);
  const destination = join(packageParent, source.lock.package.version);
  const incoming = join(packageParent, `.${source.lock.package.version}.next-${process.pid}-${randomUUID()}`);
  const previous = join(packageParent, `.${source.lock.package.version}.previous-${process.pid}-${randomUUID()}`);
  mkdirSync(packageParent, { recursive: true });

  let previousMoved = false;
  let disposition: ManagedMcpPackageEvidence["disposition"] = "staged";
  try {
    cpSync(source.runtimeRoot, incoming, { recursive: true, verbatimSymlinks: true });
    verifyRuntime(incoming, source.lock);

    if (existsSync(destination)) {
      try {
        verifyRuntime(destination, source.lock);
        rmSync(incoming, { recursive: true, force: true });
        assertReleaseSourceUnchanged(source);
        return evidenceFor(source, destination, "reused");
      } catch {
        renameSync(destination, previous);
        previousMoved = true;
        disposition = "replaced";
      }
    }

    renameSync(incoming, destination);
    verifyRuntime(destination, source.lock);
    assertReleaseSourceUnchanged(source);
    if (previousMoved) rmSync(previous, { recursive: true, force: true });
    return evidenceFor(source, destination, disposition);
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    if (previousMoved) {
      rmSync(destination, { recursive: true, force: true });
      renameSync(previous, destination);
    }
    throw error;
  } finally {
    if (!previousMoved) rmSync(previous, { recursive: true, force: true });
  }
}

function evidenceFor(
  source: VerifiedReleaseSource,
  destination: string,
  disposition: ManagedMcpPackageEvidence["disposition"],
): ManagedMcpPackageEvidence {
  return {
    name: source.lock.package.name,
    version: source.lock.package.version,
    integrity: source.lock.package.integrity,
    packageDirectory: source.lock.runtime.packageDirectory,
    destination,
    disposition,
    lockFile: source.lockFile,
    lockSha256: source.lockSha256,
    catalogFile: source.catalogFile,
    catalogFileSha256: source.catalogFileSha256,
    catalogDigestSha256: source.catalogDigestSha256,
    packageLockSha256: source.packageLockSha256,
    dependencyGraphDigestSha256: source.lock.dependencyGraph.digestSha256,
    runtimeTreeDigestSha256: source.runtimeTreeDigestSha256,
    wrapperSha256: source.wrapperSha256,
    routes: source.routes,
  };
}

function routeEvidence(
  kind: "chrome" | "playwright",
  pluginRoot: string,
  lock: ManagedMcpReleaseLock,
): ManagedMcpRouteEvidence[] {
  const command = resolveContained(pluginRoot, lock.runtime.wrapper, "locked wrapper");
  if (kind === "chrome") {
    return [{
      routeId: "chrome-devtools/upstream-delegate",
      owner: null,
      profile: null,
      command,
      args: [],
      lifecycleScope: null,
    }];
  }
  return (["general", "infographic"] as const).map((profileName) => {
    const profile = lock.profiles?.[profileName];
    if (!profile) throw new Error(`Playwright release lock is missing the ${profileName} profile`);
    return {
      routeId: profile.owner,
      owner: profile.owner,
      profile: profileName,
      command,
      args: ["--profile", profileName],
      lifecycleScope: profile.lifecycleScope,
    };
  });
}

function assertReleaseSourceUnchanged(source: VerifiedReleaseSource): void {
  if (sha256(readRequiredFile(source.lockFile, "release lock")) !== source.lockSha256) {
    throw new Error(`Managed MCP release lock changed during staging: ${source.lockFile}`);
  }
  if (sha256(readRequiredFile(source.catalogFile, "catalog")) !== source.catalogFileSha256) {
    throw new Error(`Managed MCP catalog changed during staging: ${source.catalogFile}`);
  }
  if (sha256(readRequiredFile(join(source.runtimeRoot, "package-lock.json"), "runtime package lock")) !== source.packageLockSha256) {
    throw new Error(`Managed MCP runtime package lock changed during staging: ${source.runtimeRoot}`);
  }
  if (sha256(readRequiredFile(source.wrapper, "locked wrapper")) !== source.wrapperSha256) {
    throw new Error(`Managed MCP wrapper changed during staging: ${source.wrapper}`);
  }
  if (digestRuntimeTree(source.runtimeRoot).digestSha256 !== source.runtimeTreeDigestSha256) {
    throw new Error(`Managed MCP runtime tree changed during staging: ${source.runtimeRoot}`);
  }
}

function parseReleaseLock(bytes: Buffer, file: string): ManagedMcpReleaseLock {
  const value = parseJsonRecord(bytes, file);
  const packageValue = requireRecord(value.package, "release lock package");
  const dependencyGraph = requireRecord(value.dependencyGraph, "release lock dependency graph");
  const catalog = requireRecord(value.catalog, "release lock catalog");
  const runtime = requireRecord(value.runtime, "release lock runtime");
  const review = requireRecord(value.review, "release lock review");
  if (!Array.isArray(dependencyGraph.packages)) throw new Error(`Invalid dependency graph in ${file}`);

  const profiles = value.profiles === undefined
    ? undefined
    : Object.fromEntries(Object.entries(requireRecord(value.profiles, "release lock profiles")).map(([name, input]) => {
      const profile = requireRecord(input, `profile ${name}`);
      if (!Array.isArray(profile.args) || !profile.args.every((argument) => typeof argument === "string")) {
        throw new Error(`Invalid arguments for managed MCP profile ${name}`);
      }
      return [name, {
        owner: requireString(profile.owner, `profile ${name} owner`),
        lifecycleScope: requireString(profile.lifecycleScope, `profile ${name} lifecycle scope`),
        args: profile.args,
      }];
    }));

  return {
    schemaVersion: requireNumber(value.schemaVersion, "release lock schemaVersion"),
    package: {
      name: requireString(packageValue.name, "release package name"),
      version: requireString(packageValue.version, "release package version"),
      integrity: requireString(packageValue.integrity, "release package integrity"),
      entrypoint: requireString(packageValue.entrypoint, "release package entrypoint"),
      packageJsonSha256: requireSha256(packageValue.packageJsonSha256, "release package manifest digest"),
      entrypointSha256: requireSha256(packageValue.entrypointSha256, "release package entrypoint digest"),
    },
    dependencyGraph: {
      packages: dependencyGraph.packages.map((input, index) => {
        const dependency = requireRecord(input, `dependency ${index}`);
        return {
          path: requireString(dependency.path, `dependency ${index} path`),
          name: requireString(dependency.name, `dependency ${index} name`),
          version: requireString(dependency.version, `dependency ${index} version`),
          integrity: requireString(dependency.integrity, `dependency ${index} integrity`),
          resolved: requireString(dependency.resolved, `dependency ${index} resolved`),
          packageJsonSha256: requireSha256(dependency.packageJsonSha256, `dependency ${index} package digest`),
        };
      }),
      digestSha256: requireSha256(dependencyGraph.digestSha256, "dependency graph digest"),
    },
    profiles,
    catalog: {
      path: requireString(catalog.path, "catalog path"),
      digestSha256: requireSha256(catalog.digestSha256, "catalog digest"),
    },
    runtime: {
      wrapper: requireString(runtime.wrapper, "runtime wrapper"),
      managedRootEnvironment: requireString(runtime.managedRootEnvironment, "managed root environment"),
      packageDirectory: requireString(runtime.packageDirectory, "runtime package directory"),
      sourceCanaryRoot: requireString(runtime.sourceCanaryRoot, "runtime source canary root"),
      treeDigestFormat: requireString(runtime.treeDigestFormat, "runtime tree digest format"),
      treeEntryCount: requireNumber(runtime.treeEntryCount, "runtime tree entry count"),
      treeDigestSha256: requireSha256(runtime.treeDigestSha256, "runtime tree digest"),
    },
    review: {
      policy: requireString(review.policy, "review policy"),
      approvedVersion: requireString(review.approvedVersion, "review approved version"),
    },
  };
}

function resolveContained(root: string, relativePath: string, label: string): string {
  assertSafeRelativePath(relativePath, label);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error(`Unsafe ${label} path ${relativePath}`);
  return candidate;
}

function assertSafeRelativePath(path: string, label: string): void {
  if (!path || isAbsolute(path) || relative(".", path).startsWith("..") || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe ${label} path ${path}`);
  }
}

function assertSafeDependencyPath(path: string): void {
  if (!path.startsWith("node_modules/")) throw new Error(`Unsafe dependency path ${path}`);
  assertSafeRelativePath(path, "dependency");
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function rejectFloatingLaunchText(value: string, label: string): void {
  if (/(^|[\s/])npx(?:[\s/]|$)/i.test(value) || /@latest\b/i.test(value)) {
    throw new Error(`${label} contains a floating npx or @latest launch`);
  }
}

function readRequiredFile(path: string, label: string): Buffer {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  return readFileSync(path);
}

function verifySha256(label: string, bytes: Buffer, expected: string): void {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} digest mismatch: expected ${expected}, got ${actual}`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestRuntimeTree(root: string): { entryCount: number; digestSha256: string } {
  const entries: Array<
    | { path: string; type: "file"; mode: number; sha256: string }
    | { path: string; type: "symlink"; mode: number; target: string }
  > = [];
  const visit = (absolutePath: string): void => {
    const stat = lstatSync(absolutePath);
    const path = relative(root, absolutePath).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) visit(join(absolutePath, name));
      return;
    }
    if (stat.isFile()) {
      entries.push({ path, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(absolutePath)) });
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      if (isAbsolute(target)) {
        throw new Error(`Managed MCP runtime symlink ${path} must use a relative target: ${target}`);
      }
      const resolvedTarget = resolve(dirname(absolutePath), target);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
        throw new Error(`Managed MCP runtime symlink ${path} escapes the runtime root: ${target}`);
      }
      if (!existsSync(absolutePath)) throw new Error(`Managed MCP runtime symlink ${path} is broken: ${target}`);
      let actualTarget: string;
      try {
        actualTarget = realpathSync(absolutePath);
      } catch {
        throw new Error(`Managed MCP runtime symlink ${path} is broken: ${target}`);
      }
      const actualRoot = realpathSync(root);
      if (actualTarget !== actualRoot && !actualTarget.startsWith(`${actualRoot}${sep}`)) {
        throw new Error(`Managed MCP runtime symlink ${path} resolves outside the runtime root: ${target}`);
      }
      entries.push({ path, type: "symlink", mode: stat.mode & 0o7777, target });
      return;
    }
    throw new Error(`Managed MCP runtime contains unsupported filesystem entry ${path}`);
  };
  visit(root);
  return { entryCount: entries.length, digestSha256: digestJson(entries) };
}

function digestJson(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function parseJsonRecord(bytes: Buffer, file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return requireRecord(value, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected object for ${label}`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected string for ${label}`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected number for ${label}`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Expected sha256 digest for ${label}`);
  return digest;
}

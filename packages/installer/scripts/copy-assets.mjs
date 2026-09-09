// Copies the loader stub + bundled runtime/manager into installer/assets/
// so the published npm package can extract them at install time.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  publishGeneratedDirectorySync,
  removeGeneratedConflictCopies,
} from "../../../scripts/generated-assets.mjs";
import { syncTweaks } from "../../../scripts/sync-tweaks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..", "..", "..");

// Every source -> assets destination pair the installer package ships. The
// staging callback below must copy each pair explicitly; a pair that only
// rides along because a stale copy already sits in assets/ ships stale bytes.
const copies = [
  ["packages/loader/loader.cjs", "loader.cjs"],
  ["packages/runtime/dist", "runtime"],
  ["packages/mcp-lifecycle", "mcp-lifecycle"],
  ["packages/native-host/dist/Tweakers Swap Helper.app", "swap-helper/Tweakers Swap Helper.app"],
  ["packages/native-host/dist/Tweakers App Launcher", "app-launcher/Tweakers App Launcher"],
];

// The fixed launcher and its single-file manager must arrive together. A
// partial build must preserve the last complete pair instead of mixing fresh
// launcher bytes with an old bundle (or vice versa).
const managerCopies = [
  ["packages/native-host/assets/Tweakers Manager Launcher", "manager-launcher/Tweakers Manager Launcher"],
  ["packages/native-host/manager-signing-policy.json", "manager-launcher/signing-policy.json"],
  ["packages/installer/dist/manager.mjs", "manager-launcher/manager.mjs"],
];

// A sealed manager cannot use the installer's normal relative `assets/`
// lookup because it runs from an immutable manager generation. Keep every
// non-runtime file needed by a refresh inside the already fingerprinted
// runtime generation, without including manager.mjs itself (which would make
// the fingerprint self-referential).
const managerSupportCopies = [
  ["packages/loader/loader.cjs", "loader.cjs"],
  ["packages/installer/assets/protected-loader.cjs", "protected-loader.cjs"],
  ["packages/installer/assets/tweakers.icns", "tweakers.icns"],
  ["packages/installer/assets/tweakers.png", "tweakers.png"],
  ["packages/native-host/dist/Tweakers Swap Helper.app", "swap-helper/Tweakers Swap Helper.app"],
  ["packages/native-host/dist/Tweakers App Launcher", "app-launcher/Tweakers App Launcher"],
];

// This is intentionally kept in lockstep with
// src/managed-runtime.ts::MANAGER_MANAGED_RUNTIME_COPY_ALLOWLIST. The source
// tree is staged after TypeScript/runtime assets exist, but the manager bundle
// itself and this generated output are excluded to avoid a self-referential
// content address.
const managerManagedRuntimeCopies = [
  "package.json",
  "package-lock.json",
  "bin",
  "node_modules",
  "packages/installer/package.json",
  "packages/installer/dist",
  "packages/sdk/package.json",
  "packages/sdk/dist",
];
const MANAGED_RUNTIME_FINGERPRINT_FILE = "managed-runtime-fingerprint.json";

// The root workspace is intentionally not copied wholesale.  The sealed
// runtime needs the SDK package as an import dependency, but the installer is
// already projected explicitly below.  Following the installer workspace link
// here would re-enter assets/managed-runtime from the previous publication.
// Keep this list exact: an unexpected scoped workspace link must fail closed
// rather than becoming an unreviewed way to materialize arbitrary workspace
// content into a manager generation.
const workspacePackageTargets = new Map([
  ["tweakers-installer", "packages/installer"],
  ["tweakers-sdk", "packages/sdk"],
  ["tweakers-native-host", "packages/native-host"],
  ["tweakers-loader", "packages/loader"],
  ["tweakers-runtime", "packages/runtime"],
  ["tweakers-switcher", "packages/switcher"],
  ["tweakers-mcp-lifecycle", "packages/mcp-lifecycle"],
]);
const workspaceSdkPackage = "tweakers-sdk";

export function copyInstallerAssets(root = defaultRoot, { publicationDependencies, only } = {}) {
  if (only !== undefined) {
    if (only === "app-launcher") return copyAppLauncherAsset(root, publicationDependencies);
    if (only === "manager-launcher") return copyManagerLauncherAssets(root, publicationDependencies);
    if (only !== "mcp-lifecycle") {
      throw new Error(`Unsupported scoped installer asset copy: ${String(only)}`);
    }
    return copyMcpLifecycleAssets(root, publicationDependencies);
  }
  const out = resolve(root, "packages", "installer", "assets");
  const loaderSource = resolve(root, "packages", "loader", "loader.cjs");
  const runtimeSource = resolve(root, "packages", "runtime", "dist");
  const loaderAvailable = existsSync(loaderSource);
  const runtimeAvailable = existsSync(runtimeSource);
  const mcpLifecycleAvailable = existsSync(resolve(root, "packages", "mcp-lifecycle"));
  const managerAssetsAvailable = managerCopies.every(([relativeSource]) => existsSync(resolve(root, ...relativeSource.split("/"))));
  if (!managerAssetsAvailable) {
    throw new Error("Manager asset publication requires the canonical signed launcher and freshly built status bundle");
  }
  let tweakCount = 0;
  let fingerprint = null;
  let pendingCatalog = null;
  const publication = publishGeneratedDirectorySync(out, (stagedAssets) => {
    if (existsSync(out)) cpSync(out, stagedAssets, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      // This generation is rebuilt below. Copying its dependency tree only
      // to delete it wastes work and exposes staging to macOS cleanup races.
      filter: (source) => !runtimeAvailable || source !== join(out, "managed-runtime"),
    });
    else mkdirSync(stagedAssets, { recursive: true });

    // Copy every declared pair from its source. Runtime keeps its dedicated
    // branch below (tweak sync + fingerprint), so it is skipped here rather
    // than copied twice. Manager assets are handled as an inseparable pair
    // below; ordinary assets retain the historical missing-source behavior.
    for (const [relativeSource, destinationName] of copies) {
      if (destinationName === "runtime") continue;
      const source = resolve(root, ...relativeSource.split("/"));
      if (!existsSync(source)) continue;
      const staged = join(stagedAssets, destinationName);
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(dirname(staged), { recursive: true });
      cpSync(source, staged, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      if (lstatSync(staged).isDirectory()) sweepFinderJunk(staged);
    }

    if (managerAssetsAvailable) {
      const managerAssetRoot = join(stagedAssets, "manager-launcher");
      rmSync(managerAssetRoot, { recursive: true, force: true });
      for (const [relativeSource, destinationName] of managerCopies) {
        const source = resolve(root, ...relativeSource.split("/"));
        const staged = join(stagedAssets, destinationName);
        mkdirSync(dirname(staged), { recursive: true });
        cpSync(source, staged, {
          recursive: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        });
      }
    }

    const stagedRuntime = join(stagedAssets, "runtime");
    if (runtimeAvailable) {
      rmSync(stagedRuntime, { recursive: true, force: true });
      cpSync(runtimeSource, stagedRuntime, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      const synchronized = syncTweaks(root, {
        packagedRuntimeRoot: stagedRuntime,
        deferCatalogWrite: true,
      });
      tweakCount = synchronized.count;
      pendingCatalog = synchronized.pendingCatalog;
      stageManagerSupportAssets(root, stagedRuntime);
      writeFileSync(
        join(stagedRuntime, "package.json"),
        `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
      );
      fingerprint = writeRuntimeFingerprint(stagedRuntime);
      stageManagerManagedRuntimeAssets(root, stagedAssets);
    }

    // Mode switching now lives in the existing Menu Bar app. Remove this only
    // from the staged tree so a later publication failure rolls it back too.
    rmSync(resolve(stagedAssets, "switcher"), { recursive: true, force: true });
    removeGeneratedConflictCopies(stagedAssets);
  }, {
    ...publicationDependencies,
    companionFiles: () => pendingCatalog
      ? [{ destination: pendingCatalog.path, data: pendingCatalog.serialized }]
      : [],
  });

  if (!loaderAvailable) console.warn("[copy-assets] skip (missing): packages/loader/loader.cjs");
  else console.log("[copy-assets] packages/loader/loader.cjs -> assets/loader.cjs");
  if (!mcpLifecycleAvailable) console.warn("[copy-assets] skip (missing): packages/mcp-lifecycle");
  else console.log("[copy-assets] packages/mcp-lifecycle -> assets/mcp-lifecycle");
  if (!existsSync(resolve(root, "packages", "native-host", "dist", "Tweakers App Launcher"))) {
    console.warn("[copy-assets] skip (missing): packages/native-host/dist/Tweakers App Launcher");
  } else {
    console.log("[copy-assets] packages/native-host/dist/Tweakers App Launcher -> assets/app-launcher/Tweakers App Launcher");
  }
  console.log("[copy-assets] signed manager launcher + standalone manager bundle -> assets/manager-launcher");
  if (!runtimeAvailable) {
    console.warn("[copy-assets] skip (missing): packages/runtime/dist");
    return { runtimeCopied: false, tweakCount: 0, fingerprint: null, cleanupErrors: publication.cleanupErrors };
  }
  console.log("[copy-assets] packages/runtime/dist -> assets/runtime");
  console.log("[copy-assets] sealed-manager support files -> assets/runtime/.manager-support");
  console.log("[copy-assets] sealed manager managed-runtime source -> assets/managed-runtime");
  console.log(`[copy-assets] synchronized ${tweakCount} bundled tweak(s) + catalog via sync-tweaks`);
  console.log(`[copy-assets] wrote runtime fingerprint for ${fingerprint.fileCount} file(s)`);
  return { runtimeCopied: true, tweakCount, fingerprint, cleanupErrors: publication.cleanupErrors };
}

function stageManagerSupportAssets(root, stagedRuntime) {
  const supportRoot = join(stagedRuntime, ".manager-support");
  rmSync(supportRoot, { recursive: true, force: true });
  mkdirSync(supportRoot, { recursive: true });
  for (const [relativeSource, relativeDestination] of managerSupportCopies) {
    const source = resolve(root, ...relativeSource.split("/"));
    if (!existsSync(source)) {
      throw new Error(`Sealed manager support publication is missing ${relativeSource}`);
    }
    const destination = join(supportRoot, ...relativeDestination.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }
  sweepFinderJunk(supportRoot);
}

function stageManagerManagedRuntimeAssets(root, stagedAssets) {
  const destination = join(stagedAssets, "managed-runtime");
  rmSync(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(destination, { recursive: true });
  const rootPolicy = createManagedRuntimeCopyPolicy(root, destination);
  for (const relativeSource of managerManagedRuntimeCopies) {
    const source = resolve(root, ...relativeSource.split("/"));
    if (!existsSync(source)) continue;
    const target = join(destination, ...relativeSource.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    // A sealed manager generation deliberately permits only real files and
    // directories. Materialize source-local package links before sealing;
    // Node's cpSync({ dereference: true }) retains nested symlinks (notably
    // node_modules/.bin), so a recursive copy is required here.
    copyManagerManagedRuntimeTree(source, target, rootPolicy);
  }
  const stagedInstallerAssets = join(destination, "packages", "installer", "assets");
  mkdirSync(stagedInstallerAssets, { recursive: true });
  const stagedAssetsPolicy = createStagedAssetsCopyPolicy(stagedAssets, stagedInstallerAssets);
  for (const entry of readdirSync(stagedAssets, { withFileTypes: true })) {
    // Both manager.mjs and this output are intentionally outside the source
    // generation. The active runtime/support assets remain in scope.
    if (entry.name === "managed-runtime" || entry.name === "manager-launcher") continue;
    const source = join(stagedAssets, entry.name);
    const target = join(stagedInstallerAssets, entry.name);
    copyManagerManagedRuntimeTree(source, target, stagedAssetsPolicy);
  }
  rmSync(join(destination, "packages", "installer", "dist", "manager.mjs"), { force: true });
  rmSync(join(destination, "packages", "installer", "dist", "manager.mjs.map"), { force: true });
  assertMaterializedBinShims(rootPolicy);
  sweepFinderJunk(destination);
  normalizeManagerManagedRuntimeModes(destination);
  writeManagedRuntimeFingerprint(destination);
}

/**
 * Copy policy for source-project inputs.  Every materialized symlink must
 * resolve under one of these explicit source roots, apart from the one SDK
 * workspace projection handled below.  A broad "dereference" copy is unsafe:
 * npm workspace links can lead back into generated installer assets.
 */
function createManagedRuntimeCopyPolicy(root, destinationRoot) {
  const canonicalRoot = realpathSync(root);
  const sourceRoot = resolve(root);
  return {
    kind: "workspace-source",
    sourceRoot,
    canonicalRoot,
    destinationRoot: resolve(destinationRoot),
    lexicalNodeModulesRoot: resolve(sourceRoot, "node_modules"),
    lexicalInstallerDistRoot: resolve(sourceRoot, "packages", "installer", "dist"),
    lexicalSdkDistRoot: resolve(sourceRoot, "packages", "sdk", "dist"),
    lexicalAllowedRoots: [
      resolve(sourceRoot, "package.json"),
      resolve(sourceRoot, "package-lock.json"),
      resolve(sourceRoot, "bin"),
      resolve(sourceRoot, "node_modules"),
      resolve(sourceRoot, "packages", "installer", "package.json"),
      resolve(sourceRoot, "packages", "installer", "dist"),
      resolve(sourceRoot, "packages", "sdk", "package.json"),
      resolve(sourceRoot, "packages", "sdk", "dist"),
    ],
    allowedRoots: [
      resolve(canonicalRoot, "package.json"),
      resolve(canonicalRoot, "package-lock.json"),
      resolve(canonicalRoot, "bin"),
      resolve(canonicalRoot, "node_modules"),
      resolve(canonicalRoot, "packages", "installer", "package.json"),
      resolve(canonicalRoot, "packages", "installer", "dist"),
      resolve(canonicalRoot, "packages", "sdk", "package.json"),
      resolve(canonicalRoot, "packages", "sdk", "dist"),
    ],
    generatedInstallerAssetsRoot: resolve(canonicalRoot, "packages", "installer", "assets"),
    binShims: [],
  };
}

/**
 * Runtime/support assets are already inside the generated-assets transaction.
 * They may contain only links that remain inside that exact staged tree, and
 * must never re-enter the manager output that is being constructed.
 */
function createStagedAssetsCopyPolicy(stagedAssets, destinationRoot) {
  const canonicalStagedAssets = realpathSync(stagedAssets);
  return {
    kind: "staged-assets",
    sourceRoot: resolve(stagedAssets),
    canonicalRoot: canonicalStagedAssets,
    destinationRoot: resolve(destinationRoot),
    lexicalNodeModulesRoot: null,
    lexicalInstallerDistRoot: null,
    lexicalSdkDistRoot: null,
    lexicalAllowedRoots: [resolve(stagedAssets)],
    allowedRoots: [canonicalStagedAssets],
    generatedInstallerAssetsRoot: null,
    binShims: [],
  };
}

function isWithin(path, root) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !relation.startsWith(".."));
}

function sourceRelative(policy, source) {
  return relative(policy.sourceRoot, resolve(source)).replaceAll("\\", "/");
}

function hasPublishWorkspaceSegment(path) {
  return String(path).split(/[\\/]+/).some((segment) => segment.startsWith(".assets.publish-"));
}

function hasForbiddenPublishWorkspaceSegment(policy, target, { canonical = false } = {}) {
  if (policy.kind !== "staged-assets") return hasPublishWorkspaceSegment(target);
  const root = canonical ? policy.canonicalRoot : policy.sourceRoot;
  // The staging root is itself inside `.assets.publish-*`.  Only a generated
  // workspace reached below that root is unsafe; a contained relative link
  // must remain materializable as a physical sealed file.
  return hasPublishWorkspaceSegment(relative(root, target));
}

function assertLexicalSymlinkSource(policy, source) {
  if (policy.kind === "workspace-source" && !isWithin(source, policy.lexicalNodeModulesRoot)) {
    throw new Error(`Managed runtime symlink source must be inside node_modules: ${source}`);
  }
}

function assertApprovedLexicalSymlinkTarget(policy, lexicalTarget, source, { workspace = false, bin = false } = {}) {
  if (hasForbiddenPublishWorkspaceSegment(policy, lexicalTarget)) {
    throw new Error(`Managed runtime symlink targets a generated publication workspace: ${source}`);
  }
  if (workspace) return;
  const allowedRoots = bin && policy.kind === "workspace-source"
    ? [policy.lexicalNodeModulesRoot, policy.lexicalInstallerDistRoot, policy.lexicalSdkDistRoot]
    : policy.kind === "workspace-source"
      ? [policy.lexicalNodeModulesRoot]
      : policy.lexicalAllowedRoots;
  if (!allowedRoots.some((allowedRoot) => isWithin(lexicalTarget, allowedRoot))) {
    throw new Error(`Managed runtime symlink lexical target is outside approved roots: ${source}`);
  }
}

function assertAllowedManagedRuntimeSource(policy, canonicalSource, source) {
  if (policy.generatedInstallerAssetsRoot && isWithin(canonicalSource, policy.generatedInstallerAssetsRoot)) {
    throw new Error(`Managed runtime source may not materialize generated installer assets: ${source}`);
  }
  if (!policy.allowedRoots.some((allowedRoot) => isWithin(canonicalSource, allowedRoot))) {
    throw new Error(`Managed runtime symlink resolves outside approved roots: ${source}`);
  }

  if (policy.kind === "staged-assets") {
    const stagedRelative = relative(policy.canonicalRoot, canonicalSource).replaceAll("\\", "/");
    if (stagedRelative === "managed-runtime" || stagedRelative.startsWith("managed-runtime/")) {
      throw new Error(`Managed runtime source may not re-enter staged managed-runtime output: ${source}`);
    }
    if (stagedRelative === "manager-launcher" || stagedRelative.startsWith("manager-launcher/")) {
      throw new Error(`Managed runtime source may not re-enter staged manager bundle output: ${source}`);
    }
  }
}

function workspaceLinkName(policy, source) {
  if (policy.kind !== "workspace-source") return null;
  const sourcePath = resolve(source);
  const workspaceRoot = resolve(policy.sourceRoot, "node_modules", "@therealityreport");
  if (dirname(sourcePath) !== workspaceRoot) return null;
  return relative(workspaceRoot, sourcePath);
}

function copyWorkspaceSdkProjection(canonicalSdkRoot, target, policy, ancestry) {
  mkdirSync(target, { recursive: true });
  for (const entry of ["package.json", "dist"]) {
    const source = join(canonicalSdkRoot, entry);
    if (!existsSync(source)) {
      throw new Error(`Managed runtime SDK workspace projection is missing ${entry}`);
    }
    copyManagerManagedRuntimeTree(source, join(target, entry), {
      ...policy,
      allowedRoots: [canonicalSdkRoot],
    }, ancestry);
  }
}

function remapBinTarget(policy, canonicalSource, source) {
  const nodeModulesRoot = resolve(policy.canonicalRoot, "node_modules");
  const installerDistRoot = resolve(policy.canonicalRoot, "packages", "installer", "dist");
  const sdkDistRoot = resolve(policy.canonicalRoot, "packages", "sdk", "dist");
  const mappings = [
    [nodeModulesRoot, join(policy.destinationRoot, "node_modules")],
    [installerDistRoot, join(policy.destinationRoot, "packages", "installer", "dist")],
    [sdkDistRoot, join(policy.destinationRoot, "packages", "sdk", "dist")],
  ];
  for (const [sourceRoot, targetRoot] of mappings) {
    if (isWithin(canonicalSource, sourceRoot)) {
      return join(targetRoot, relative(sourceRoot, canonicalSource));
    }
  }
  throw new Error(`Managed runtime .bin symlink resolves outside approved executable roots: ${source}`);
}

function materializeBinShim(source, target, canonicalSource, policy) {
  const stagedTarget = remapBinTarget(policy, canonicalSource, source);
  const relativeTarget = relative(dirname(target), stagedTarget);
  // The sealed runtime's top-level package is CommonJS.  Use a CommonJS
  // launcher even when the target is ESM, then dynamic-import the remapped
  // physical file so its own relative imports and package scope stay intact.
  const shim = [
    "#!/usr/bin/env node",
    'const { resolve } = require("node:path");',
    'const { pathToFileURL } = require("node:url");',
    `import(pathToFileURL(resolve(__dirname, ${JSON.stringify(relativeTarget)})).href).catch((error) => {`,
    "  console.error(error);",
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shim, { mode: 0o700 });
  chmodSync(target, 0o700);
  policy.binShims.push({ source, target, stagedTarget });
}

function assertExecutableBinTarget(source, lexicalTarget) {
  let targetStat;
  try {
    targetStat = lstatSync(lexicalTarget);
  } catch (error) {
    throw new Error(`Managed runtime .bin symlink has an unreadable target: ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile() || (targetStat.mode & 0o100) === 0) {
    throw new Error(`Managed runtime .bin symlink must target a regular executable file: ${source}`);
  }
}

function assertMaterializedBinShims(policy) {
  for (const shim of policy.binShims) {
    let targetStat;
    try {
      targetStat = lstatSync(shim.stagedTarget);
    } catch (error) {
      throw new Error(`Managed runtime .bin shim target is missing after staging: ${shim.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || (targetStat.mode & 0o100) === 0) {
      throw new Error(`Managed runtime .bin shim target is not an executable regular file after staging: ${shim.source}`);
    }
  }
}

function isBinShim(policy, source) {
  if (policy.kind !== "workspace-source") return false;
  const relation = sourceRelative(policy, source);
  return /(^|\/)node_modules\/\.bin\/[^/]+$/.test(relation);
}

/**
 * Materialize the small, sealed manager source tree with a path-classified
 * traversal.  The ancestry set is intentionally branch-local: aliases may
 * legitimately materialize the same dependency twice, while links back to an
 * active ancestor are rejected as cycles.
 */
function copyManagerManagedRuntimeTree(source, target, policy, ancestry = new Set()) {
  const resolvedSource = resolve(source);
  let stat;
  try {
    stat = lstatSync(resolvedSource);
  } catch (error) {
    throw new Error(`Managed runtime source is unreadable: ${resolvedSource}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const directWorkspaceName = workspaceLinkName(policy, resolvedSource);
  if (directWorkspaceName !== null && !stat.isSymbolicLink()) {
    throw new Error(`Managed runtime workspace package must be an exact symlink: ${resolvedSource}`);
  }

  if (stat.isSymbolicLink()) {
    const workspaceName = directWorkspaceName;
    let rawTarget;
    try {
      rawTarget = readlinkSync(resolvedSource);
    } catch (error) {
      throw new Error(`Managed runtime source cannot read symlink target: ${resolvedSource}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isAbsolute(rawTarget)) {
      throw new Error(`Managed runtime source contains an absolute symlink: ${resolvedSource}`);
    }
    if (policy.kind === "workspace-source" && hasPublishWorkspaceSegment(rawTarget)) {
      throw new Error(`Managed runtime symlink targets a generated publication workspace: ${resolvedSource}`);
    }
    const lexicalTarget = resolve(dirname(resolvedSource), rawTarget);
    assertLexicalSymlinkSource(policy, resolvedSource);
    const binShim = isBinShim(policy, resolvedSource);
    assertApprovedLexicalSymlinkTarget(policy, lexicalTarget, resolvedSource, {
      workspace: workspaceName !== null,
      bin: binShim,
    });
    if (binShim) assertExecutableBinTarget(resolvedSource, lexicalTarget);
    let canonicalSource;
    try {
      canonicalSource = realpathSync(resolvedSource);
    } catch (error) {
      throw new Error(`Managed runtime source contains a dangling symlink: ${resolvedSource}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (hasForbiddenPublishWorkspaceSegment(policy, canonicalSource, { canonical: true })) {
      throw new Error(`Managed runtime symlink targets a generated publication workspace: ${resolvedSource}`);
    }

    if (workspaceName !== null) {
      const expectedRelative = workspacePackageTargets.get(workspaceName);
      if (!expectedRelative) {
        throw new Error(`Managed runtime source contains an unrecognized workspace symlink: ${resolvedSource}`);
      }
      const expectedTarget = resolve(policy.canonicalRoot, expectedRelative);
      const expectedLexicalTarget = resolve(policy.sourceRoot, expectedRelative);
      if (lexicalTarget !== expectedLexicalTarget || canonicalSource !== expectedTarget) {
        throw new Error(`Managed runtime workspace symlink target mismatch: ${resolvedSource}`);
      }
      if (workspaceName !== workspaceSdkPackage) return;
      if (ancestry.has(canonicalSource)) {
        throw new Error(`Managed runtime source contains a symlink cycle: ${resolvedSource}`);
      }
      copyWorkspaceSdkProjection(canonicalSource, target, policy, new Set([...ancestry, canonicalSource]));
      return;
    }

    assertAllowedManagedRuntimeSource(policy, canonicalSource, resolvedSource);
    if (ancestry.has(canonicalSource)) {
      throw new Error(`Managed runtime source contains a symlink cycle: ${resolvedSource}`);
    }
    if (binShim) {
      materializeBinShim(resolvedSource, target, canonicalSource, policy);
      return;
    }
    copyManagerManagedRuntimeTree(canonicalSource, target, policy, ancestry);
    return;
  }

  let canonicalSource;
  try {
    canonicalSource = realpathSync(resolvedSource);
  } catch (error) {
    throw new Error(`Managed runtime source is unreadable: ${resolvedSource}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertAllowedManagedRuntimeSource(policy, canonicalSource, resolvedSource);
  if (ancestry.has(canonicalSource)) {
    throw new Error(`Managed runtime source contains a directory cycle: ${resolvedSource}`);
  }
  const nextAncestry = new Set([...ancestry, canonicalSource]);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(resolvedSource).sort((left, right) => left.localeCompare(right))) {
      // Transaction workspaces are generated output, never source input.  The
      // policy also rejects a link into generated installer assets at any
      // depth, before it can reach a recursive prior generation.
      if (entry.startsWith(".assets.publish-")) continue;
      copyManagerManagedRuntimeTree(join(resolvedSource, entry), join(target, entry), policy, nextAncestry);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Managed runtime source contains unsupported special entry ${resolvedSource}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolvedSource, target, { preserveTimestamps: true });
}

/**
 * Manager generations are owner-only immutable trees. Normalize the staged
 * source to those same modes before fingerprinting so the content address is
 * stable across a developer checkout (normally 0644/0755) and its sealed
 * 0400/0500 generation.
 */
function normalizeManagerManagedRuntimeModes(directory) {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      normalizeManagerManagedRuntimeModes(path);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Managed runtime staging contains an unsupported entry: ${path}`);
    }
    chmodSync(path, (stat.mode & 0o100) !== 0 ? 0o500 : 0o400);
  }
}

export function writeManagedRuntimeFingerprint(runtimeRoot) {
  const allowlist = [
    "package.json",
    "package-lock.json",
    "bin",
    "node_modules",
    join("packages", "installer", "package.json"),
    join("packages", "installer", "dist"),
    join("packages", "installer", "assets"),
    join("packages", "sdk", "package.json"),
    join("packages", "sdk", "dist"),
  ];
  const hash = createHash("sha256");
  let fileCount = 0;
  const add = (type, relativePath, mode, payload) => {
    hash.update(`${type}\0${relativePath.replaceAll("\\", "/")}\0${(mode & 0o7777).toString(8)}\0${payload.length}\0`);
    hash.update(payload);
  };
  const visit = (path) => {
    const stat = lstatSync(path);
    const name = relative(runtimeRoot, path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      add("directory", name, stat.mode, Buffer.alloc(0));
      for (const entry of readdirSync(path).sort((left, right) => left.localeCompare(right))) {
        if (entry === ".DS_Store") continue;
        visit(join(path, entry));
      }
    } else if (stat.isFile()) {
      fileCount += 1;
      add("file", name, stat.mode, readFileSync(path));
    } else if (stat.isSymbolicLink()) {
      add("symlink", name, stat.mode, Buffer.from(readlinkSync(path), "utf8"));
    } else {
      throw new Error(`Managed runtime source contains unsupported special entry ${path}`);
    }
  };
  for (const relativePath of allowlist) {
    const path = join(runtimeRoot, relativePath);
    if (!existsSync(path)) {
      hash.update(`missing\0${relativePath.replaceAll("\\", "/")}\0`);
      continue;
    }
    visit(path);
  }
  const receipt = { schemaVersion: 1, fingerprint: hash.digest("hex"), fileCount };
  writeFileSync(join(runtimeRoot, MANAGED_RUNTIME_FINGERPRINT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Publish the final manager bundle after the full runtime asset pass. */
function copyManagerLauncherAssets(root, publicationDependencies = {}) {
  const destination = resolve(root, "packages", "installer", "assets", "manager-launcher");
  for (const [relativeSource] of managerCopies) {
    const source = resolve(root, ...relativeSource.split("/"));
    if (!existsSync(source) || !lstatSync(source).isFile()) {
      throw new Error(`Manager asset publication is missing ${relativeSource}`);
    }
  }
  const publication = publishGeneratedDirectorySync(destination, (staged) => {
    mkdirSync(staged, { recursive: true });
    for (const [relativeSource, destinationName] of managerCopies) {
      cpSync(
        resolve(root, ...relativeSource.split("/")),
        join(staged, destinationName.slice("manager-launcher/".length)),
        { verbatimSymlinks: true, preserveTimestamps: true },
      );
    }
    removeGeneratedConflictCopies(staged);
  }, publicationDependencies);
  console.log("[copy-assets] signed manager launcher + final runtime-bound manager bundle -> assets/manager-launcher (scoped transaction)");
  return {
    runtimeCopied: false,
    tweakCount: 0,
    fingerprint: null,
    scoped: "manager-launcher",
    cleanupErrors: publication.cleanupErrors,
  };
}

/** Publish only the independent launcher so source builds never restage runtime or manager bytes. */
function copyAppLauncherAsset(root, publicationDependencies = {}) {
  const source = resolve(root, "packages", "native-host", "dist", "Tweakers App Launcher");
  const destination = resolve(root, "packages", "installer", "assets", "app-launcher");
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error("Independent launcher asset publication requires packages/native-host/dist/Tweakers App Launcher");
  }
  const publication = publishGeneratedDirectorySync(destination, (staged) => {
    mkdirSync(staged, { recursive: true });
    cpSync(source, join(staged, "Tweakers App Launcher"), {
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    removeGeneratedConflictCopies(staged);
  }, publicationDependencies);
  console.log("[copy-assets] packages/native-host/dist/Tweakers App Launcher -> assets/app-launcher/Tweakers App Launcher (scoped transaction)");
  return {
    runtimeCopied: false,
    tweakCount: 0,
    fingerprint: null,
    scoped: "app-launcher",
    cleanupErrors: publication.cleanupErrors,
  };
}

/**
 * Publish only the lifecycle package subtree.  This deliberately uses the
 * generated-tree transaction at `assets/mcp-lifecycle`, not at `assets`, so a
 * scoped package refresh cannot observe, copy, remove, or replace runtime,
 * manager, catalog, loader, or tweak bytes.
 */
function copyMcpLifecycleAssets(root, publicationDependencies = {}) {
  const source = resolve(root, "packages", "mcp-lifecycle");
  const destination = resolve(root, "packages", "installer", "assets", "mcp-lifecycle");
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error("MCP lifecycle scoped asset copy requires packages/mcp-lifecycle");
  }
  const publication = publishGeneratedDirectorySync(destination, (staged) => {
    cpSync(source, staged, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    sweepFinderJunk(staged);
    removeGeneratedConflictCopies(staged);
  }, publicationDependencies);
  console.log("[copy-assets] packages/mcp-lifecycle -> assets/mcp-lifecycle (scoped transaction)");
  return {
    runtimeCopied: false,
    tweakCount: 0,
    fingerprint: null,
    scoped: "mcp-lifecycle",
    cleanupErrors: publication.cleanupErrors,
  };
}

// Physically remove Finder junk so shipped assets are clean.
function sweepFinderJunk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Python bytecode caches appear whenever the in-tree tests run without
      // -B; they must never ship or count toward staged-content equality.
      if (entry.name === "__pycache__") rmSync(path, { recursive: true, force: true });
      else sweepFinderJunk(path);
    } else if (entry.isFile() && (entry.name === ".DS_Store" || entry.name.endsWith(".pyc"))) rmSync(path);
  }
}

export function writeRuntimeFingerprint(runtimeRoot) {
  const fingerprintFile = "runtime-fingerprint.json";
  // Sweep before hashing so the fingerprint covers exactly the shipped bytes.
  sweepFinderJunk(runtimeRoot);
  const hash = createHash("sha256");
  let fileCount = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Junk skip must stay in lockstep with installer/src/runtime-fingerprint.ts
      // and runtime/src/watcher-health.ts.
      if (entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      const name = relative(runtimeRoot, path);
      if (name === fingerprintFile) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        fileCount += 1;
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(runtimeRoot);
  const receipt = { schemaVersion: 1, fingerprint: hash.digest("hex"), fileCount };
  writeFileSync(join(runtimeRoot, fingerprintFile), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (args.length === 0) copyInstallerAssets();
  else if (args.length === 2 && args[0] === "--only" && (args[1] === "mcp-lifecycle" || args[1] === "app-launcher" || args[1] === "manager-launcher")) {
    copyInstallerAssets(defaultRoot, { only: args[1] });
  } else {
    throw new Error("Usage: node packages/installer/scripts/copy-assets.mjs [--only mcp-lifecycle|app-launcher|manager-launcher]");
  }
}

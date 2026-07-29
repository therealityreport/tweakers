import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertInternalStoragePath } from "./internal-storage.js";

export const MANAGED_MCP_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const MANAGED_MCP_LIFECYCLE_FILE = "managed-mcp-lifecycle.v1.json" as const;
export const MANAGED_MCP_DECLARATIONS_FILE = "managed-mcp-declarations.v1.json" as const;

export type ManagedMcpLifecycle = "call" | "task";

export interface ManagedMcpLifecycleCatalogReference {
  path: string;
  sha256: string;
}

export interface ManagedMcpLifecycleEntry {
  owner: string;
  server: string;
  declarationFingerprint: string;
  lifecycle: ManagedMcpLifecycle;
  idleLeaseSec: number;
  catalog: ManagedMcpLifecycleCatalogReference;
  /** Promotion gate only. It never maps to the MCP config startup-required flag. */
  required: boolean;
}

export interface ManagedMcpLifecycleOverlay {
  schemaVersion: typeof MANAGED_MCP_LIFECYCLE_SCHEMA_VERSION;
  fleetFingerprint: string;
  entries: readonly ManagedMcpLifecycleEntry[];
}

export type ManagedMcpArtifactKind = "package" | "executable" | "plugin-entrypoint" | "plugin-bundle";

export interface ManagedMcpFleetManifestEntry extends Omit<ManagedMcpLifecycleEntry, "catalog"> {
  catalog: {
    /** Exact release-preparation source. It is copied into the prepared runtime. */
    path: string;
    sha256: string;
  };
  /** Exact effective stdio declaration used by Rust's mcp_catalog_fingerprint. */
  declaration: ManagedMcpEffectiveDeclaration;
}

export type ManagedMcpFingerprintSource =
  | { origin: "config" }
  | { origin: "plugin"; plugin_id: string; plugin_version: string | null }
  | { origin: "selected_plugin"; plugin_id: string; plugin_version: string | null }
  | { origin: "compatibility"; id: string }
  | { origin: "extension"; id: string };

export interface ManagedMcpEffectiveDeclaration {
  source: ManagedMcpFingerprintSource;
  environmentId: string;
  command: string;
  args: readonly string[];
  cwd: string | null;
  explicitEnv: Readonly<Record<string, string>>;
  inheritedEnvPolicy: readonly string[];
  inheritedEnv: readonly { name: string; source: string }[];
}

export interface ManagedMcpFleetArtifactInput {
  id: string;
  kind: ManagedMcpArtifactKind;
  sourcePath: string;
  version: string | null;
  integrity: string | null;
  /**
   * Null keeps an exact external artifact in place; otherwise copy into the managed runtime.
   * Package paths use packages/<packageDirectory>/<version>, beneath the
   * CODEX_MANAGED_MCP_ROOT contract at <CODEX_HOME>/managed-runtime/packages.
   */
  runtimeRelativePath: string | null;
}

export type ManagedMcpConfigRouteAction = "archive-shadow" | "replace-floating" | "retain-attested";

export interface ManagedMcpConfigRoutePlan {
  owner: "config";
  server: string;
  action: ManagedMcpConfigRouteAction;
  replacementOwner: string | null;
  /** Materialized from the verified config-owned fleet entry during preparation. */
  effectiveDeclaration?: ManagedMcpEffectiveDeclaration | null;
  applyOnlyDuringApprovedCutover: true;
}

export interface ManagedMcpConfigReconciliationPlan {
  schemaVersion: 1;
  feature: {
    table: "features";
    key: "mcp_on_demand";
    value: true;
  };
  routes: readonly ManagedMcpConfigRoutePlan[];
  applyOnlyDuringApprovedCutover: true;
  mutatesConfigDuringPreparation: false;
}

export interface ManagedMcpFleetManifest {
  schemaVersion: 1;
  inventoryComplete: true;
  enabledLocalStdioRouteCount: number;
  entries: readonly ManagedMcpFleetManifestEntry[];
  artifacts: readonly ManagedMcpFleetArtifactInput[];
  configReconciliation: ManagedMcpConfigReconciliationPlan;
}

export interface ManagedMcpCatalogEvidence {
  owner: string;
  server: string;
  path: string;
  sha256: string;
}

export interface ManagedMcpArtifactEvidence {
  id: string;
  kind: ManagedMcpArtifactKind;
  sourcePath: string;
  version: string | null;
  integrity: string | null;
  runtimeRelativePath: string | null;
  destination: string | null;
  digestFormat: "sha256-file-v1" | "sha256-json-path-kind-mode-content-v1";
  sha256: string;
  entryCount: number;
}

export interface ManagedMcpPreparedRuntimeEvidence {
  schemaVersion: 1;
  kind: "managed-mcp-prepared-runtime";
  runtimeRoot: string;
  /** Exact value to export as CODEX_MANAGED_MCP_ROOT after promotion. */
  managedPackageRoot: string;
  overlayFile: string;
  overlaySha256: string;
  fleetFingerprint: string;
  /** Original prepared fleet identity from which a relocated target was materialized. */
  sourceFleetFingerprint: string;
  runtimeTreeSha256: string;
  runtimeTreeEntryCount: number;
  catalogs: readonly ManagedMcpCatalogEvidence[];
  artifacts: readonly ManagedMcpArtifactEvidence[];
  requiredCoverage: readonly string[];
  configReconciliation: ManagedMcpConfigReconciliationPlan;
  preparedAt: string;
}

export interface PrepareManagedMcpLifecycleInput {
  manifestFile: string;
  runtimeRoot: string;
  seedPaths?: readonly {
    sourcePath: string;
    destinationRelativePath: string;
  }[];
  now?: () => string;
}

interface RequiredFleetRoute {
  ownerKind: "config" | "plugin";
  ownerId: string;
  server: string;
}

/** Logical coverage keys stay version-neutral; the prepared overlay retains exact plugin versions. */
export const REQUIRED_MANAGED_MCP_FLEET_ROUTES: readonly RequiredFleetRoute[] = [
  { ownerKind: "plugin", ownerId: "chrome-devtools", server: "chrome-devtools" },
  { ownerKind: "config", ownerId: "config", server: "playwright" },
  { ownerKind: "config", ownerId: "config", server: "headroom" },
  { ownerKind: "config", ownerId: "config", server: "node_repl" },
  { ownerKind: "plugin", ownerId: "infographic-docs", server: "infographic-preview-playwright" },
  { ownerKind: "plugin", ownerId: "build-ios-apps", server: "xcodebuildmcp" },
  { ownerKind: "plugin", ownerId: "pdfx", server: "pdfx" },
  { ownerKind: "plugin", ownerId: "pdfx", server: "pdfx-apps" },
  { ownerKind: "plugin", ownerId: "shadcn", server: "shadcn" },
  { ownerKind: "plugin", ownerId: "shadcn", server: "shadcn-apps" },
  { ownerKind: "plugin", ownerId: "shadcn", server: "iconify" },
  { ownerKind: "plugin", ownerId: "react-doctor", server: "react-doctor" },
  { ownerKind: "plugin", ownerId: "record-and-replay", server: "event-stream" },
  { ownerKind: "plugin", ownerId: "computer-use", server: "computer-use" },
  { ownerKind: "plugin", ownerId: "sites", server: "sites-design-picker" },
  { ownerKind: "plugin", ownerId: "codex-security", server: "codex-security" },
  { ownerKind: "plugin", ownerId: "creative-production", server: "creative_production_mcp" },
  { ownerKind: "plugin", ownerId: "data-analytics", server: "dataAnalyticsWidgets" },
  { ownerKind: "plugin", ownerId: "openai-developers", server: "openai-api-key-local-confirmation" },
  { ownerKind: "plugin", ownerId: "decodo", server: "decodo" },
] as const;

export const MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "__CF_USER_TEXT_ENCODING",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

export function prepareManagedMcpLifecycleRuntime(
  input: PrepareManagedMcpLifecycleInput,
): ManagedMcpPreparedRuntimeEvidence {
  const manifestFile = exactFile(input.manifestFile, "Managed MCP fleet manifest");
  const runtimeRoot = exactFuturePath(input.runtimeRoot, "Managed MCP prepared runtime");
  const manifestBytes = readFileSync(manifestFile);
  const manifest = parseManifest(manifestBytes, manifestFile);
  validateConfigReconciliation(manifest.configReconciliation, manifest.entries);
  const configReconciliation = materializeConfigReconciliation(manifest.configReconciliation, manifest.entries);
  validateConfigReconciliation(configReconciliation, manifest.entries, true);
  const canonicalSourceEntries = canonicalEntries(manifest.entries);
  assertRequiredFleetCoverage(canonicalSourceEntries);
  if (!canonicalSourceEntries.every((entry) => entry.required)) {
    throw new Error("Managed MCP inventory contains an unclassified enabled local stdio route");
  }
  assertPluginBundles(manifest);

  const incoming = `${runtimeRoot}.incoming-${process.pid}-${randomUUID()}`;
  const previous = `${runtimeRoot}.previous-${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(runtimeRoot), { recursive: true });
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(join(incoming, "catalogs"), { recursive: true });
  let previousMoved = false;
  try {
    const claimedDestinations: string[] = [
      "catalogs",
      MANAGED_MCP_LIFECYCLE_FILE,
      MANAGED_MCP_DECLARATIONS_FILE,
      "fleet-artifacts.v1.json",
      "config-reconciliation.v1.json",
    ];
    for (const seed of input.seedPaths ?? []) {
      const source = exactExistingPath(seed.sourcePath, "Managed MCP prepared runtime seed");
      assertSafeRelativePath(seed.destinationRelativePath, "prepared runtime seed destination");
      claimRuntimeDestination(claimedDestinations, seed.destinationRelativePath, "prepared runtime seed");
      const destination = resolve(incoming, seed.destinationRelativePath);
      if (destination !== incoming && !destination.startsWith(`${incoming}${sep}`)) {
        throw new Error(`Unsafe prepared runtime seed destination: ${seed.destinationRelativePath}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
    }
    const artifacts = stageAndAttestArtifacts(
      manifest.artifacts,
      incoming,
      runtimeRoot,
      claimedDestinations,
    );
    const artifactMappings = runtimeArtifactPathMappings(artifacts);
    const catalogs = canonicalSourceEntries.map((entry) => {
      const source = exactFile(entry.catalog.path, `MCP catalog ${entry.owner}/${entry.server}`);
      const sourceBytes = readFileSync(source);
      const actual = mcpSha256Digest(sourceBytes);
      if (actual !== entry.catalog.sha256) {
        throw new Error(`MCP catalog digest drift for ${entry.owner}/${entry.server}`);
      }
      const sourceDeclarationFingerprint = mcpCatalogFingerprint(entry, sourceBytes);
      if (sourceDeclarationFingerprint !== entry.declarationFingerprint) {
        throw new Error(
          `MCP declaration fingerprint drift for ${entry.owner}/${entry.server}: expected ${entry.declarationFingerprint}, got ${sourceDeclarationFingerprint}`,
        );
      }
      const declaration = rebaseEffectiveDeclaration(entry.declaration, artifactMappings);
      const materializedBytes = materializeCatalogBytes(entry.server, sourceBytes, declaration, artifactMappings);
      const relativePath = catalogDestination(entry);
      const destination = join(incoming, relativePath);
      writeFileSync(destination, materializedBytes, { flag: "wx", mode: 0o600 });
      return {
        owner: entry.owner,
        server: entry.server,
        path: join(runtimeRoot, relativePath),
        sha256: mcpSha256Digest(materializedBytes),
        declaration,
        bytes: materializedBytes,
      };
    });
    const entries = canonicalEntries(canonicalSourceEntries.map((entry) => {
      const catalog = catalogs.find((candidate) => candidate.owner === entry.owner && candidate.server === entry.server)!;
      const actualDeclarationFingerprint = mcpCatalogFingerprint(
        { server: entry.server, declaration: catalog.declaration },
        catalog.bytes,
      );
      return {
        owner: entry.owner,
        server: entry.server,
        declarationFingerprint: actualDeclarationFingerprint,
        lifecycle: entry.lifecycle,
        idleLeaseSec: entry.idleLeaseSec,
        catalog: { path: catalog.path, sha256: catalog.sha256 },
        required: entry.required,
      } satisfies ManagedMcpLifecycleEntry;
    }));
    const fleetFingerprint = digestCanonicalEntries(entries);
    const overlay: ManagedMcpLifecycleOverlay = {
      schemaVersion: MANAGED_MCP_LIFECYCLE_SCHEMA_VERSION,
      fleetFingerprint,
      entries,
    };
    const overlayFile = join(incoming, MANAGED_MCP_LIFECYCLE_FILE);
    atomicJsonWrite(overlayFile, overlay);
    atomicJsonWrite(join(incoming, MANAGED_MCP_DECLARATIONS_FILE), {
      schemaVersion: 1,
      entries: catalogs.map(({ owner, server, declaration }) => ({ owner, server, declaration })),
    });
    atomicJsonWrite(join(incoming, "fleet-artifacts.v1.json"), {
      schemaVersion: 1,
      manifestSha256: sha256(manifestBytes),
      managedPackageRoot: join(runtimeRoot, "packages"),
      artifacts,
    });
    atomicJsonWrite(join(incoming, "config-reconciliation.v1.json"), configReconciliation);
    if (existsSync(runtimeRoot)) {
      renameSync(runtimeRoot, previous);
      previousMoved = true;
    }
    renameSync(incoming, runtimeRoot);
    const finalOverlayFile = join(runtimeRoot, MANAGED_MCP_LIFECYCLE_FILE);
    const finalOverlay = readAndVerifyManagedMcpLifecycleOverlay(finalOverlayFile);
    const tree = digestTree(runtimeRoot);
    const prepared: ManagedMcpPreparedRuntimeEvidence = {
      schemaVersion: 1,
      kind: "managed-mcp-prepared-runtime",
      runtimeRoot,
      managedPackageRoot: join(runtimeRoot, "packages"),
      overlayFile: finalOverlayFile,
      overlaySha256: sha256(readFileSync(finalOverlayFile)),
      fleetFingerprint: finalOverlay.fleetFingerprint,
      sourceFleetFingerprint: finalOverlay.fleetFingerprint,
      runtimeTreeSha256: tree.sha256,
      runtimeTreeEntryCount: tree.entryCount,
      catalogs: finalOverlay.entries.map((entry) => ({
        owner: entry.owner,
        server: entry.server,
        path: entry.catalog.path,
        sha256: entry.catalog.sha256,
      })),
      artifacts,
      requiredCoverage: requiredCoverageKeys(finalOverlay.entries),
      configReconciliation,
      preparedAt: (input.now ?? (() => new Date().toISOString()))(),
    };
    assertManagedMcpPreparedRuntimeEvidence(prepared);
    rmSync(previous, { recursive: true, force: true });
    return prepared;
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    if (previousMoved && !existsSync(runtimeRoot)) renameSync(previous, runtimeRoot);
    throw error;
  } finally {
    if (!previousMoved) rmSync(previous, { recursive: true, force: true });
  }
}

export function readAndVerifyManagedMcpLifecycleOverlay(file: string): ManagedMcpLifecycleOverlay {
  const overlayFile = exactFile(file, "Managed MCP lifecycle overlay");
  const value = parseJson(readFileSync(overlayFile), overlayFile);
  if (!isRecord(value) || value.schemaVersion !== MANAGED_MCP_LIFECYCLE_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw new Error(`Invalid managed MCP lifecycle overlay at ${overlayFile}`);
  }
  const entries = canonicalEntries(value.entries.map((entry, index) => parseLifecycleEntry(entry, `overlay entry ${index}`)));
  const fingerprint = requireMcpSha256(value.fleetFingerprint, "fleet fingerprint");
  if (fingerprint !== digestCanonicalEntries(entries)) throw new Error("Managed MCP overlay fleet fingerprint drift");
  assertRequiredFleetCoverage(entries);
  const declarations = readRuntimeDeclarations(join(dirname(overlayFile), MANAGED_MCP_DECLARATIONS_FILE));
  for (const entry of entries) {
    if (!isAbsolute(entry.catalog.path) || resolve(entry.catalog.path) !== entry.catalog.path) {
      throw new Error(`Managed MCP catalog path must be exact and absolute: ${entry.catalog.path}`);
    }
    const catalogFile = exactFile(entry.catalog.path, "Managed MCP overlay catalog");
    const catalogBytes = readFileSync(catalogFile);
    if (mcpSha256Digest(catalogBytes) !== entry.catalog.sha256) {
      throw new Error(`Managed MCP overlay catalog drift for ${entry.owner}/${entry.server}`);
    }
    const declaration = declarations.find((candidate) => candidate.owner === entry.owner && candidate.server === entry.server);
    if (!declaration
      || mcpCatalogFingerprint({ server: entry.server, declaration: declaration.declaration }, catalogBytes)
        !== entry.declarationFingerprint) {
      throw new Error(`Managed MCP overlay declaration drift for ${entry.owner}/${entry.server}`);
    }
  }
  return { schemaVersion: MANAGED_MCP_LIFECYCLE_SCHEMA_VERSION, fleetFingerprint: fingerprint, entries };
}

/**
 * Rebind an already verified prepared overlay to an exact target runtime root.
 * Declaration fingerprints remain valid because Rust binds catalog content,
 * not the catalog's installation path. The fleet fingerprint is recomputed.
 */
export function rebaseManagedMcpLifecycleOverlay(
  sourceOverlayFile: string,
  targetRuntimeRootInput: string,
  destinationOverlayFileInput: string,
  options: { artifactDestinationOverrides?: Readonly<Record<string, string>> } = {},
): ManagedMcpLifecycleOverlay {
  const source = readAndVerifyManagedMcpLifecycleOverlay(sourceOverlayFile);
  const sourceRuntimeRoot = dirname(resolve(sourceOverlayFile));
  const targetRuntimeRoot = exactFuturePath(targetRuntimeRootInput, "Managed MCP target runtime");
  const destinationOverlayFile = exactFuturePath(destinationOverlayFileInput, "Managed MCP target overlay");
  const destinationRuntimeRoot = dirname(destinationOverlayFile);
  const declarations = readRuntimeDeclarations(join(sourceRuntimeRoot, MANAGED_MCP_DECLARATIONS_FILE));
  const sourceArtifacts = readRuntimeArtifactMetadata(sourceRuntimeRoot);
  const mappings = runtimeArtifactPathMappings(sourceArtifacts, targetRuntimeRoot, options.artifactDestinationOverrides);
  const entries = canonicalEntries(source.entries.map((entry) => {
    const local = relative(sourceRuntimeRoot, entry.catalog.path);
    assertSafeRelativePath(local, "rebased catalog path");
    const stagedCatalog = resolve(destinationRuntimeRoot, local);
    if (!existsSync(stagedCatalog)) {
      throw new Error(`Managed MCP rebased catalog drift for ${entry.owner}/${entry.server}`);
    }
    const sourceBytes = readFileSync(entry.catalog.path);
    if (mcpSha256Digest(sourceBytes) !== entry.catalog.sha256) {
      throw new Error(`Managed MCP source catalog drift for ${entry.owner}/${entry.server}`);
    }
    const sourceDeclaration = declarations.find((candidate) => candidate.owner === entry.owner && candidate.server === entry.server);
    if (!sourceDeclaration) throw new Error(`Managed MCP source declaration is missing for ${entry.owner}/${entry.server}`);
    const declaration = rebaseEffectiveDeclaration(sourceDeclaration.declaration, mappings);
    const materializedBytes = materializeCatalogBytes(entry.server, sourceBytes, declaration, mappings);
    atomicFileWrite(stagedCatalog, materializedBytes);
    const catalogSha256 = mcpSha256Digest(materializedBytes);
    return {
      ...entry,
      declarationFingerprint: mcpCatalogFingerprint({ server: entry.server, declaration }, materializedBytes),
      catalog: { path: join(targetRuntimeRoot, local), sha256: catalogSha256 },
    };
  }));
  const overlay: ManagedMcpLifecycleOverlay = {
    schemaVersion: MANAGED_MCP_LIFECYCLE_SCHEMA_VERSION,
    fleetFingerprint: digestCanonicalEntries(entries),
    entries,
  };
  atomicJsonWrite(join(destinationRuntimeRoot, MANAGED_MCP_DECLARATIONS_FILE), {
    schemaVersion: 1,
    entries: entries.map((entry) => {
      const sourceDeclaration = declarations.find((candidate) => candidate.owner === entry.owner && candidate.server === entry.server)!;
      return { owner: entry.owner, server: entry.server, declaration: rebaseEffectiveDeclaration(sourceDeclaration.declaration, mappings) };
    }),
  });
  atomicJsonWrite(destinationOverlayFile, overlay);
  rebaseManagedMcpArtifactMetadata(sourceRuntimeRoot, targetRuntimeRoot, destinationRuntimeRoot);
  rebaseManagedMcpConfigMetadata(destinationRuntimeRoot, mappings);
  return overlay;
}

/**
 * Install a receipt-bound prepared runtime at an isolated target and rebase
 * every absolute catalog, package-root, and artifact destination reference.
 * The target must not already exist; callers own any higher-level replacement.
 */
export function installManagedMcpPreparedRuntime(
  prepared: ManagedMcpPreparedRuntimeEvidence,
  targetRuntimeRootInput: string,
  optionsInput: {
    now?: () => string;
    artifactDestinationOverrides?: Readonly<Record<string, string>>;
  } | (() => string) = {},
): ManagedMcpPreparedRuntimeEvidence {
  const options = typeof optionsInput === "function" ? { now: optionsInput } : optionsInput;
  assertManagedMcpPreparedRuntimeEvidence(prepared);
  const targetRuntimeRoot = exactFuturePath(targetRuntimeRootInput, "Managed MCP installed runtime");
  if (existsSync(targetRuntimeRoot)) throw new Error(`Managed MCP installed runtime already exists: ${targetRuntimeRoot}`);
  mkdirSync(dirname(targetRuntimeRoot), { recursive: true });
  try {
    cpSync(prepared.runtimeRoot, targetRuntimeRoot, { recursive: true, verbatimSymlinks: true });
    const overlayFile = join(targetRuntimeRoot, MANAGED_MCP_LIFECYCLE_FILE);
    const overlay = rebaseManagedMcpLifecycleOverlay(prepared.overlayFile, targetRuntimeRoot, overlayFile, {
      artifactDestinationOverrides: options.artifactDestinationOverrides,
    });
    const tree = digestTree(targetRuntimeRoot);
    const installed: ManagedMcpPreparedRuntimeEvidence = {
      ...prepared,
      runtimeRoot: targetRuntimeRoot,
      managedPackageRoot: join(targetRuntimeRoot, "packages"),
      overlayFile,
      overlaySha256: sha256(readFileSync(overlayFile)),
      fleetFingerprint: overlay.fleetFingerprint,
      sourceFleetFingerprint: prepared.sourceFleetFingerprint,
      runtimeTreeSha256: tree.sha256,
      runtimeTreeEntryCount: tree.entryCount,
      catalogs: prepared.catalogs.map((catalog) => ({
        ...catalog,
        path: join(targetRuntimeRoot, relative(prepared.runtimeRoot, catalog.path)),
        sha256: overlay.entries.find((entry) => entry.owner === catalog.owner && entry.server === catalog.server)!.catalog.sha256,
      })),
      artifacts: prepared.artifacts.map((artifact) => ({
        ...artifact,
        destination: artifact.runtimeRelativePath === null
          ? null
          : join(targetRuntimeRoot, artifact.runtimeRelativePath),
      })),
      configReconciliation: readManagedMcpConfigReconciliation(targetRuntimeRoot),
      preparedAt: (options.now ?? (() => new Date().toISOString()))(),
    };
    assertManagedMcpPreparedRuntimeEvidence(installed);
    return installed;
  } catch (error) {
    rmSync(targetRuntimeRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Attest a manifest artifact or installed copy with the receipt digest format. */
export function attestManagedMcpArtifact(
  pathInput: string,
  kind: ManagedMcpArtifactKind,
): Pick<ManagedMcpArtifactEvidence, "digestFormat" | "sha256" | "entryCount"> {
  const path = exactExistingPath(pathInput, "Managed MCP artifact attestation");
  return attestArtifactPath(path, "Managed MCP artifact attestation", kind);
}

function rebaseManagedMcpArtifactMetadata(
  sourceRuntimeRoot: string,
  targetRuntimeRoot: string,
  destinationRuntimeRoot: string,
): void {
  const file = join(destinationRuntimeRoot, "fleet-artifacts.v1.json");
  if (!existsSync(file)) return;
  const value = parseJson(readFileSync(file), file);
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error("Invalid managed MCP artifact metadata during target rebase");
  }
  if (value.managedPackageRoot !== join(sourceRuntimeRoot, "packages")) {
    throw new Error("Managed MCP package root drift during target rebase");
  }
  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`Invalid rebased managed MCP artifact ${index}`);
    if (artifact.destination === null) return artifact;
    if (typeof artifact.runtimeRelativePath !== "string" || typeof artifact.destination !== "string") {
      throw new Error(`Invalid managed MCP artifact destination during target rebase ${index}`);
    }
    const expectedSource = join(sourceRuntimeRoot, artifact.runtimeRelativePath);
    if (artifact.destination !== expectedSource) {
      throw new Error(`Managed MCP artifact destination drift during target rebase ${index}`);
    }
    return { ...artifact, destination: join(targetRuntimeRoot, artifact.runtimeRelativePath) };
  });
  atomicJsonWrite(file, { ...value, managedPackageRoot: join(targetRuntimeRoot, "packages"), artifacts });
}

interface RuntimePathMapping {
  source: string;
  target: string;
}

interface RuntimeDeclarationRecord {
  owner: string;
  server: string;
  declaration: ManagedMcpEffectiveDeclaration;
}

function runtimeArtifactPathMappings(
  artifacts: readonly ManagedMcpArtifactEvidence[],
  targetRuntimeRoot?: string,
  overrides: Readonly<Record<string, string>> = {},
): RuntimePathMapping[] {
  const mappings = artifacts.flatMap((artifact) => {
    if (targetRuntimeRoot === undefined) {
      return artifact.destination === null ? [] : [{ source: artifact.sourcePath, target: artifact.destination }];
    }
    if (artifact.destination === null || artifact.runtimeRelativePath === null) return [];
    const target = overrides[artifact.id] ?? join(targetRuntimeRoot, artifact.runtimeRelativePath);
    if (!isAbsolute(target) || resolve(target) !== target) {
      throw new Error(`Managed MCP artifact override for ${artifact.id} must be exact and absolute`);
    }
    return [{ source: artifact.destination, target }];
  });
  return mappings.sort((left, right) => right.source.length - left.source.length);
}

function rebaseEffectiveDeclaration(
  declaration: ManagedMcpEffectiveDeclaration,
  mappings: readonly RuntimePathMapping[],
): ManagedMcpEffectiveDeclaration {
  return {
    ...declaration,
    command: rebaseRuntimeString(declaration.command, mappings),
    args: declaration.args.map((value) => rebaseRuntimeString(value, mappings)),
    cwd: declaration.cwd === null ? null : rebaseRuntimeString(declaration.cwd, mappings),
    explicitEnv: Object.fromEntries(Object.entries(declaration.explicitEnv).map(([key, value]) => [
      key,
      rebaseRuntimeString(value, mappings),
    ])),
    inheritedEnv: declaration.inheritedEnv.map((value) => ({
      ...value,
      source: rebaseRuntimeString(value.source, mappings),
    })),
  };
}

function materializeCatalogBytes(
  server: string,
  sourceBytes: Buffer,
  declaration: ManagedMcpEffectiveDeclaration,
  mappings: readonly RuntimePathMapping[],
): Buffer {
  const source = parseJson(sourceBytes, `catalog for ${server}`);
  if (!isRecord(source)) throw new Error(`MCP catalog for ${server} must be a JSON object`);
  const materialized = rebaseRuntimeValue(source, mappings) as Record<string, unknown>;
  delete materialized.identity_fingerprint;
  delete materialized.identityFingerprint;
  const withoutIdentity = Buffer.from(`${JSON.stringify(materialized, null, 2)}\n`);
  materialized.identity_fingerprint = mcpCatalogFingerprint({ server, declaration }, withoutIdentity);
  return Buffer.from(`${JSON.stringify(materialized, null, 2)}\n`);
}

function rebaseRuntimeValue(value: unknown, mappings: readonly RuntimePathMapping[]): unknown {
  if (typeof value === "string") return rebaseRuntimeString(value, mappings);
  if (Array.isArray(value)) return value.map((item) => rebaseRuntimeValue(item, mappings));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseRuntimeValue(item, mappings)]));
}

function rebaseRuntimeString(value: string, mappings: readonly RuntimePathMapping[]): string {
  let rebased = value;
  for (const mapping of mappings) rebased = rebased.split(mapping.source).join(mapping.target);
  return rebased;
}

function readRuntimeDeclarations(fileInput: string): RuntimeDeclarationRecord[] {
  const file = exactFile(fileInput, "Managed MCP runtime declarations");
  const value = parseJson(readFileSync(file), file);
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("Invalid managed MCP runtime declarations");
  }
  return value.entries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Invalid managed MCP runtime declaration ${index}`);
    const owner = requireString(entry.owner, `runtime declaration ${index} owner`);
    const server = requireString(entry.server, `runtime declaration ${index} server`);
    return {
      owner,
      server,
      declaration: parseEffectiveDeclaration(entry.declaration, owner, `runtime declaration ${owner}/${server}`),
    };
  });
}

function readRuntimeArtifactMetadata(runtimeRoot: string): ManagedMcpArtifactEvidence[] {
  const file = exactFile(join(runtimeRoot, "fleet-artifacts.v1.json"), "Managed MCP artifact metadata");
  const value = parseJson(readFileSync(file), file);
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error("Invalid managed MCP artifact metadata");
  }
  return value.artifacts as unknown as ManagedMcpArtifactEvidence[];
}

function rebaseManagedMcpConfigMetadata(runtimeRoot: string, mappings: readonly RuntimePathMapping[]): void {
  const file = exactFile(join(runtimeRoot, "config-reconciliation.v1.json"), "Managed MCP config reconciliation");
  const value = parseJson(readFileSync(file), file);
  atomicJsonWrite(file, rebaseRuntimeValue(value, mappings));
}

function readManagedMcpConfigReconciliation(runtimeRoot: string): ManagedMcpConfigReconciliationPlan {
  const file = exactFile(join(runtimeRoot, "config-reconciliation.v1.json"), "Managed MCP config reconciliation");
  const value = parseJson(readFileSync(file), file);
  if (!isRecord(value)) throw new Error("Invalid managed MCP config reconciliation");
  return value as unknown as ManagedMcpConfigReconciliationPlan;
}

export function assertManagedMcpPreparedRuntimeEvidence(
  evidence: ManagedMcpPreparedRuntimeEvidence,
): void {
  if (!managedMcpPreparedRuntimeEvidenceShapeIsValid(evidence)) {
    throw new Error("Invalid managed MCP prepared runtime evidence");
  }
  const runtimeRoot = exactDirectory(evidence.runtimeRoot, "Managed MCP prepared runtime");
  if (evidence.overlayFile !== join(runtimeRoot, MANAGED_MCP_LIFECYCLE_FILE)) {
    throw new Error("Managed MCP overlay is not at the prepared runtime contract path");
  }
  if (evidence.managedPackageRoot !== join(runtimeRoot, "packages")) {
    throw new Error("Managed MCP package root is not at managed-runtime/packages");
  }
  const overlay = readAndVerifyManagedMcpLifecycleOverlay(evidence.overlayFile);
  if (sha256(readFileSync(evidence.overlayFile)) !== evidence.overlaySha256) throw new Error("Managed MCP overlay receipt digest drift");
  if (overlay.fleetFingerprint !== evidence.fleetFingerprint) throw new Error("Managed MCP fleet receipt fingerprint drift");
  if (!/^sha256:[a-f0-9]{64}$/.test(evidence.sourceFleetFingerprint)) {
    throw new Error("Managed MCP source fleet fingerprint is invalid");
  }
  const tree = digestTree(runtimeRoot);
  if (tree.sha256 !== evidence.runtimeTreeSha256 || tree.entryCount !== evidence.runtimeTreeEntryCount) {
    throw new Error("Managed MCP prepared runtime tree drift");
  }
  if (JSON.stringify(requiredCoverageKeys(overlay.entries)) !== JSON.stringify(evidence.requiredCoverage)) {
    throw new Error("Managed MCP receipt required coverage drift");
  }
  const artifactDestinations: string[] = [];
  for (const artifact of evidence.artifacts) {
    const source = attestArtifactPath(
      exactExistingPath(artifact.sourcePath, `Managed MCP artifact receipt ${artifact.id}`),
      `Managed MCP artifact receipt ${artifact.id}`,
      artifact.kind,
    );
    if (source.sha256 !== artifact.sha256
      || source.entryCount !== artifact.entryCount
      || source.digestFormat !== artifact.digestFormat) {
      throw new Error(`Managed MCP artifact source drift for ${artifact.id}`);
    }
    if (artifact.runtimeRelativePath === null) {
      if (artifact.destination !== null) throw new Error(`External managed MCP artifact ${artifact.id} has a destination`);
      continue;
    }
    claimRuntimeDestination(artifactDestinations, artifact.runtimeRelativePath, `artifact receipt ${artifact.id}`);
    const expectedDestination = join(runtimeRoot, artifact.runtimeRelativePath);
    if (artifact.destination !== expectedDestination) throw new Error(`Managed MCP artifact destination drift for ${artifact.id}`);
    const copied = attestArtifactPath(
      exactExistingPath(expectedDestination, `Managed MCP artifact destination ${artifact.id}`),
      `Managed MCP artifact destination ${artifact.id}`,
      artifact.kind,
    );
    if (copied.sha256 !== artifact.sha256
      || copied.entryCount !== artifact.entryCount
      || copied.digestFormat !== artifact.digestFormat) {
      throw new Error(`Managed MCP artifact copied target drift for ${artifact.id}`);
    }
  }
  for (const catalog of evidence.catalogs) {
    const entry = overlay.entries.find((candidate) => candidate.owner === catalog.owner && candidate.server === catalog.server);
    if (!entry || catalog.path !== entry.catalog.path || catalog.sha256 !== entry.catalog.sha256) {
      throw new Error(`Managed MCP receipt catalog evidence drift for ${catalog.owner}/${catalog.server}`);
    }
  }
  validateConfigReconciliation(evidence.configReconciliation, overlay.entries, true);
}

export function managedMcpPreparedEvidenceIsValid(value: unknown): value is ManagedMcpPreparedRuntimeEvidence {
  if (!managedMcpPreparedRuntimeEvidenceShapeIsValid(value)) return false;
  try {
    assertManagedMcpPreparedRuntimeEvidence(value);
    return true;
  } catch {
    return false;
  }
}

/** Structural receipt validation; filesystem drift is checked separately at consumption time. */
export function managedMcpPreparedRuntimeEvidenceShapeIsValid(
  value: unknown,
): value is ManagedMcpPreparedRuntimeEvidence {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1
    || value.kind !== "managed-mcp-prepared-runtime"
    || typeof value.runtimeRoot !== "string"
    || typeof value.managedPackageRoot !== "string"
    || typeof value.overlayFile !== "string"
    || !/^[a-f0-9]{64}$/.test(String(value.overlaySha256))
    || !/^sha256:[a-f0-9]{64}$/.test(String(value.fleetFingerprint))
    || !/^sha256:[a-f0-9]{64}$/.test(String(value.sourceFleetFingerprint))
    || !/^[a-f0-9]{64}$/.test(String(value.runtimeTreeSha256))
    || !Number.isSafeInteger(value.runtimeTreeEntryCount)
    || (value.runtimeTreeEntryCount as number) < 1
    || !Array.isArray(value.catalogs)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.requiredCoverage)
    || typeof value.preparedAt !== "string"
    || Number.isNaN(Date.parse(value.preparedAt))
    || !isRecord(value.configReconciliation)
  ) return false;
  if (!value.catalogs.every((catalog) => isRecord(catalog)
    && typeof catalog.owner === "string"
    && typeof catalog.server === "string"
    && typeof catalog.path === "string"
    && /^sha256:[a-f0-9]{64}$/.test(String(catalog.sha256)))) return false;
  if (!value.artifacts.every((artifact) => isRecord(artifact)
    && typeof artifact.id === "string"
    && ["package", "executable", "plugin-entrypoint", "plugin-bundle"].includes(String(artifact.kind))
    && typeof artifact.sourcePath === "string"
    && (artifact.version === null || typeof artifact.version === "string")
    && (artifact.integrity === null || typeof artifact.integrity === "string")
    && (artifact.runtimeRelativePath === null || typeof artifact.runtimeRelativePath === "string")
    && (artifact.destination === null || typeof artifact.destination === "string")
    && ["sha256-file-v1", "sha256-json-path-kind-mode-content-v1"].includes(String(artifact.digestFormat))
    && /^[a-f0-9]{64}$/.test(String(artifact.sha256))
    && Number.isSafeInteger(artifact.entryCount)
    && (artifact.entryCount as number) > 0)) return false;
  if (JSON.stringify([...value.requiredCoverage].sort())
    !== JSON.stringify(REQUIRED_MANAGED_MCP_FLEET_ROUTES.map(requiredKey).sort())) return false;
  const plan = value.configReconciliation as Record<string, unknown>;
  const feature = isRecord(plan.feature) ? plan.feature : {};
  return plan.schemaVersion === 1
    && feature.table === "features"
    && feature.key === "mcp_on_demand"
    && feature.value === true
    && plan.applyOnlyDuringApprovedCutover === true
    && plan.mutatesConfigDuringPreparation === false
    && Array.isArray(plan.routes);
}

export function digestCanonicalEntries(entries: readonly ManagedMcpLifecycleEntry[]): string {
  return mcpSha256Fingerprint(canonicalEntries(entries));
}

/** Rust-compatible `mcp_sha256_fingerprint`: canonical JSON plus `sha256:` digest. */
export function mcpSha256Fingerprint(value: unknown): string {
  return mcpSha256Digest(Buffer.from(JSON.stringify(canonicalJson(value))));
}

/** Compute the exact Rust declaration/catalog identity for a manifest entry. */
export function mcpCatalogFingerprint(
  entry: Pick<ManagedMcpFleetManifestEntry, "server" | "declaration">,
  catalogBytes: Buffer,
): string {
  const catalog = parseJson(catalogBytes, `catalog for ${entry.server}`);
  if (!isRecord(catalog)) throw new Error(`MCP catalog for ${entry.server} must be a JSON object`);
  const catalogPayload = { ...catalog };
  delete catalogPayload.identity_fingerprint;
  delete catalogPayload.identityFingerprint;
  const declaration = entry.declaration;
  return mcpSha256Fingerprint({
    source: declaration.source,
    server_name: entry.server,
    environment_id: declaration.environmentId,
    command: declaration.command.trim(),
    args: declaration.args,
    cwd: declaration.cwd,
    explicit_env: declaration.explicitEnv,
    inherited_env_policy: declaration.inheritedEnvPolicy,
    inherited_env: [...declaration.inheritedEnv].sort((left, right) =>
      left.name.localeCompare(right.name) || left.source.localeCompare(right.source)
    ),
    catalog_digest: mcpSha256Fingerprint(catalogPayload),
  });
}

function parseManifest(bytes: Buffer, file: string): ManagedMcpFleetManifest {
  const value = parseJson(bytes, file);
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.artifacts)) {
    throw new Error(`Invalid managed MCP fleet manifest at ${file}`);
  }
  const entries = value.entries.map((entry, index) => parseManifestEntry(entry, `manifest entry ${index}`));
  const artifacts = value.artifacts.map((artifact, index) => parseArtifact(artifact, index));
  if (!isRecord(value.configReconciliation)) throw new Error("Managed MCP fleet manifest lacks config reconciliation data");
  if (value.inventoryComplete !== true
    || !Number.isSafeInteger(value.enabledLocalStdioRouteCount)
    || value.enabledLocalStdioRouteCount !== entries.length) {
    throw new Error("Managed MCP fleet manifest does not prove a complete enabled local stdio inventory");
  }
  return {
    schemaVersion: 1,
    inventoryComplete: true,
    enabledLocalStdioRouteCount: entries.length,
    entries,
    artifacts,
    configReconciliation: value.configReconciliation as unknown as ManagedMcpConfigReconciliationPlan,
  };
}

function parseManifestEntry(value: unknown, label: string): ManagedMcpFleetManifestEntry {
  const entry = parseLifecycleEntry(value, label);
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  return {
    ...entry,
    declaration: parseEffectiveDeclaration(value.declaration, entry.owner, label),
  };
}

function parseLifecycleEntry(value: unknown, label: string): ManagedMcpLifecycleEntry {
  if (!isRecord(value) || !isRecord(value.catalog)) throw new Error(`Invalid ${label}`);
  const owner = requireString(value.owner, `${label} owner`);
  if (!validOwner(owner)) throw new Error(`Invalid ${label} owner ${owner}`);
  const server = requireString(value.server, `${label} server`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(server)) throw new Error(`Invalid ${label} server ${server}`);
  const lifecycle = value.lifecycle;
  if (lifecycle !== "call" && lifecycle !== "task") throw new Error(`Invalid ${label} lifecycle`);
  const idleLeaseSec = value.idleLeaseSec;
  if (!Number.isSafeInteger(idleLeaseSec) || (idleLeaseSec as number) < 0 || (idleLeaseSec as number) > 3600) {
    throw new Error(`Invalid ${label} idle lease`);
  }
  if (lifecycle === "call" && idleLeaseSec !== 0) throw new Error(`${label} call lifecycle must use idleLeaseSec 0`);
  if (lifecycle === "task" && (idleLeaseSec as number) < 1) throw new Error(`${label} task lifecycle requires a positive idle lease`);
  if (typeof value.required !== "boolean") throw new Error(`Invalid ${label} required gate`);
  return {
    owner,
    server,
    declarationFingerprint: requireMcpSha256(value.declarationFingerprint, `${label} declaration fingerprint`),
    lifecycle,
    idleLeaseSec: idleLeaseSec as number,
    catalog: {
      path: requireString(value.catalog.path, `${label} catalog path`),
      sha256: requireMcpSha256(value.catalog.sha256, `${label} catalog digest`),
    },
    required: value.required,
  };
}

function parseEffectiveDeclaration(
  value: unknown,
  owner: string,
  label: string,
): ManagedMcpEffectiveDeclaration {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.explicitEnv)) {
    throw new Error(`Invalid ${label} effective declaration`);
  }
  const source = parseFingerprintSource(value.source, owner, label);
  const environmentId = requireString(value.environmentId, `${label} environment id`);
  const command = requireString(value.command, `${label} command`).trim();
  if (!isAbsolute(command) || resolve(command) !== command) throw new Error(`${label} command must be exact and absolute`);
  if (!Array.isArray(value.args) || !value.args.every((argument) => typeof argument === "string")) {
    throw new Error(`Invalid ${label} arguments`);
  }
  if (value.cwd !== null && typeof value.cwd !== "string") throw new Error(`Invalid ${label} cwd`);
  if (typeof value.cwd === "string" && (!isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd)) {
    throw new Error(`${label} cwd must be null or exact and absolute`);
  }
  const explicitEnv = Object.fromEntries(Object.entries(value.explicitEnv).map(([key, item]) => {
    if (typeof item !== "string") throw new Error(`Invalid ${label} explicit environment value for ${key}`);
    return [key, item];
  }));
  if (!Array.isArray(value.inheritedEnvPolicy)
    || JSON.stringify(value.inheritedEnvPolicy) !== JSON.stringify(MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY)) {
    throw new Error(`${label} inherited environment policy does not match the managed Rust runtime`);
  }
  if (!Array.isArray(value.inheritedEnv)) throw new Error(`Invalid ${label} inherited environment`);
  const inheritedEnv = value.inheritedEnv.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Invalid ${label} inherited environment ${index}`);
    return {
      name: requireString(item.name, `${label} inherited environment ${index} name`),
      source: requireString(item.source, `${label} inherited environment ${index} source`),
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
  return {
    source,
    environmentId,
    command,
    args: value.args,
    cwd: value.cwd as string | null,
    explicitEnv,
    inheritedEnvPolicy: MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY,
    inheritedEnv,
  };
}

function parseFingerprintSource(
  value: Record<string, unknown>,
  owner: string,
  label: string,
): ManagedMcpFingerprintSource {
  switch (value.origin) {
    case "config":
      if (owner !== "config") throw new Error(`${label} source does not match owner ${owner}`);
      return { origin: "config" };
    case "plugin": {
      const plugin_id = requireString(value.plugin_id, `${label} plugin id`);
      const plugin_version = value.plugin_version === null
        ? null
        : requireString(value.plugin_version, `${label} plugin version`);
      if (owner !== `plugin:${plugin_id}@${plugin_version ?? "unknown"}`) {
        throw new Error(`${label} plugin source does not match owner ${owner}`);
      }
      return { origin: "plugin", plugin_id, plugin_version };
    }
    case "selected_plugin": {
      const plugin_id = requireString(value.plugin_id, `${label} selected plugin id`);
      const plugin_version = value.plugin_version === null
        ? null
        : requireString(value.plugin_version, `${label} selected plugin version`);
      if (owner !== `selected_plugin:${plugin_id}@${plugin_version ?? "unknown"}`) {
        throw new Error(`${label} selected plugin source does not match owner ${owner}`);
      }
      return { origin: "selected_plugin", plugin_id, plugin_version };
    }
    case "compatibility": {
      const id = requireString(value.id, `${label} compatibility id`);
      if (owner !== `compatibility:${id}`) throw new Error(`${label} compatibility source does not match owner`);
      return { origin: "compatibility", id };
    }
    case "extension": {
      const id = requireString(value.id, `${label} extension id`);
      if (owner !== `extension:${id}`) throw new Error(`${label} extension source does not match owner`);
      return { origin: "extension", id };
    }
    default:
      throw new Error(`Invalid ${label} source origin`);
  }
}

function parseArtifact(value: unknown, index: number): ManagedMcpFleetArtifactInput {
  if (!isRecord(value)) throw new Error(`Invalid managed MCP artifact ${index}`);
  const kind = value.kind;
  if (kind !== "package" && kind !== "executable" && kind !== "plugin-entrypoint" && kind !== "plugin-bundle") {
    throw new Error(`Invalid managed MCP artifact kind ${String(kind)}`);
  }
  const integrity = value.integrity;
  if (integrity !== null && typeof integrity !== "string") throw new Error(`Invalid managed MCP artifact integrity ${index}`);
  if (kind === "package" && (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity))) {
    throw new Error(`Managed MCP package artifact ${index} requires exact sha512 integrity`);
  }
  const runtimeRelativePath = value.runtimeRelativePath === null
    ? null
    : requireString(value.runtimeRelativePath, `artifact ${index} runtime path`);
  if (runtimeRelativePath !== null) assertSafeRelativePath(runtimeRelativePath, `artifact ${index} runtime path`);
  if (kind === "package") {
    if (runtimeRelativePath === null) throw new Error(`Managed MCP package artifact ${index} requires a runtime destination`);
    const parts = runtimeRelativePath.split(/[\\/]/);
    if (parts.length !== 3 || parts[0] !== "packages" || parts[2] !== value.version) {
      throw new Error(`Managed MCP package artifact ${index} destination must be packages/<packageDirectory>/<version>`);
    }
  }
  if (kind === "plugin-bundle") {
    if (runtimeRelativePath === null) throw new Error(`Managed MCP plugin bundle artifact ${index} requires a runtime destination`);
    const parts = runtimeRelativePath.split(/[\\/]/);
    if (parts.length !== 3 || parts[0] !== "plugin-bundles" || parts[2] !== value.version) {
      throw new Error(`Managed MCP plugin bundle artifact ${index} destination must be plugin-bundles/<pluginId>/<version>`);
    }
  }
  return {
    id: requireSafeSegment(value.id, `artifact ${index} id`),
    kind,
    sourcePath: requireString(value.sourcePath, `artifact ${index} source`),
    version: value.version === null ? null : requireString(value.version, `artifact ${index} version`),
    integrity,
    runtimeRelativePath,
  };
}

function stageAndAttestArtifacts(
  inputs: readonly ManagedMcpFleetArtifactInput[],
  incomingRuntimeRoot: string,
  finalRuntimeRoot: string,
  claimedDestinations: string[],
): ManagedMcpArtifactEvidence[] {
  const ids = new Set<string>();
  return [...inputs].sort((left, right) => left.id.localeCompare(right.id)).map((input) => {
    if (ids.has(input.id)) throw new Error(`Duplicate managed MCP artifact ${input.id}`);
    ids.add(input.id);
    const sourcePath = exactExistingPath(input.sourcePath, `Managed MCP artifact ${input.id}`);
    const source = attestArtifactPath(sourcePath, `Managed MCP artifact ${input.id}`, input.kind);
    let destination: string | null = null;
    if (input.runtimeRelativePath !== null) {
      claimRuntimeDestination(claimedDestinations, input.runtimeRelativePath, `artifact ${input.id}`);
      const incomingDestination = resolve(incomingRuntimeRoot, input.runtimeRelativePath);
      mkdirSync(dirname(incomingDestination), { recursive: true });
      cpSync(sourcePath, incomingDestination, {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
      const copied = attestArtifactPath(incomingDestination, `Copied managed MCP artifact ${input.id}`, input.kind);
      if (copied.sha256 !== source.sha256 || copied.entryCount !== source.entryCount || copied.digestFormat !== source.digestFormat) {
        throw new Error(`Managed MCP artifact ${input.id} source/destination drift`);
      }
      destination = join(finalRuntimeRoot, input.runtimeRelativePath);
    }
    return {
      ...input,
      sourcePath,
      destination,
      ...source,
    };
  });
}

function attestArtifactPath(
  path: string,
  label: string,
  kind: ManagedMcpArtifactKind,
): Pick<ManagedMcpArtifactEvidence, "digestFormat" | "sha256" | "entryCount"> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  if (stat.isFile()) {
    return { digestFormat: "sha256-file-v1", sha256: sha256(readFileSync(path)), entryCount: 1 };
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a file or directory`);
  const tree = digestArtifactTree(path, kind === "package");
  return {
    digestFormat: "sha256-json-path-kind-mode-content-v1",
    sha256: tree.sha256,
    entryCount: tree.entryCount,
  };
}

function validateConfigReconciliation(
  plan: ManagedMcpConfigReconciliationPlan,
  entries: readonly ManagedMcpLifecycleEntry[],
  requireMaterializedDeclarations = false,
): void {
  if (
    plan.schemaVersion !== 1
    || plan.feature?.table !== "features"
    || plan.feature.key !== "mcp_on_demand"
    || plan.feature.value !== true
    || plan.applyOnlyDuringApprovedCutover !== true
    || plan.mutatesConfigDuringPreparation !== false
    || !Array.isArray(plan.routes)
  ) throw new Error("Invalid managed MCP config reconciliation plan");
  const expectedRoutes: Readonly<Record<string, ManagedMcpConfigRouteAction>> = {
    "chrome-devtools": "archive-shadow",
    "computer-use": "archive-shadow",
    playwright: "replace-floating",
    headroom: "retain-attested",
    node_repl: "retain-attested",
  };
  const planned = [...plan.routes].map((route) => {
    if (
      route.owner !== "config"
      || !(route.server in expectedRoutes)
      || !["archive-shadow", "replace-floating", "retain-attested"].includes(route.action)
      || route.applyOnlyDuringApprovedCutover !== true
      || (route.replacementOwner !== null && !validOwner(route.replacementOwner))
    ) throw new Error(`Invalid managed MCP config reconciliation route ${route.server}`);
    if (route.action !== expectedRoutes[route.server]) {
      throw new Error(`Managed MCP config reconciliation action is wrong for ${route.server}`);
    }
    if (route.action === "archive-shadow" && !route.replacementOwner) {
      throw new Error(`Archive-shadow route ${route.server} requires a verified replacement owner`);
    }
    if (route.replacementOwner && !entries.some((entry) => entry.owner === route.replacementOwner)) {
      throw new Error(`Config route ${route.server} replacement owner is not in the verified fleet`);
    }
    if (requireMaterializedDeclarations) {
      if (route.action === "archive-shadow") {
        if (route.effectiveDeclaration !== null) {
          throw new Error(`Archive-shadow route ${route.server} cannot retain a global declaration`);
        }
      } else {
        parseEffectiveDeclaration(route.effectiveDeclaration, "config", `config reconciliation ${route.server}`);
      }
    }
    return route.server;
  }).sort();
  const expectedServers = Object.keys(expectedRoutes).sort();
  if (new Set(planned).size !== planned.length || JSON.stringify(planned) !== JSON.stringify(expectedServers)) {
    throw new Error("Managed MCP config reconciliation must plan every global route exactly once");
  }
}

function materializeConfigReconciliation(
  plan: ManagedMcpConfigReconciliationPlan,
  entries: readonly ManagedMcpFleetManifestEntry[],
): ManagedMcpConfigReconciliationPlan {
  return {
    ...plan,
    routes: plan.routes.map((route) => {
      if (route.action === "archive-shadow") return { ...route, effectiveDeclaration: null };
      const entry = entries.find((candidate) => candidate.owner === "config" && candidate.server === route.server);
      if (!entry) throw new Error(`Config route ${route.server} lacks a verified effective declaration`);
      return { ...route, effectiveDeclaration: entry.declaration };
    }),
  };
}

function canonicalEntries<T extends ManagedMcpFleetManifestEntry | ManagedMcpLifecycleEntry>(entries: readonly T[]): T[] {
  const result = [...entries].sort((left, right) =>
    left.owner.localeCompare(right.owner) || left.server.localeCompare(right.server)
  );
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.owner === result[index]!.owner && result[index - 1]!.server === result[index]!.server) {
      throw new Error(`Duplicate managed MCP route ${result[index]!.owner}/${result[index]!.server}`);
    }
  }
  return result;
}

function assertRequiredFleetCoverage(entries: readonly ManagedMcpLifecycleEntry[]): void {
  const missing = REQUIRED_MANAGED_MCP_FLEET_ROUTES.filter((required) => !entries.some((entry) =>
    entry.required
    && entry.server === required.server
    && ownerMatches(entry.owner, required)
  ));
  if (missing.length > 0) {
    throw new Error(`Managed MCP fleet is missing promotion-required routes: ${missing.map(requiredKey).join(", ")}`);
  }
}

function assertPluginBundles(manifest: ManagedMcpFleetManifest): void {
  const pluginOwners = new Map<string, { pluginId: string; version: string }>();
  for (const entry of manifest.entries) {
    const match = /^(?:plugin|selected_plugin):([^@]+)@(.+)$/.exec(entry.owner);
    if (!match) continue;
    const [, pluginId, version] = match;
    const existing = pluginOwners.get(pluginId!);
    if (existing && existing.version !== version) throw new Error(`Managed MCP plugin ${pluginId} has conflicting versions`);
    pluginOwners.set(pluginId!, { pluginId: pluginId!, version: version! });
  }
  for (const { pluginId, version } of pluginOwners.values()) {
    const bundles = manifest.artifacts.filter((artifact) => artifact.kind === "plugin-bundle"
      && artifact.runtimeRelativePath === `plugin-bundles/${pluginId}/${version}`
      && artifact.version === version);
    if (bundles.length !== 1) {
      throw new Error(`Managed MCP fleet requires exactly one receipt-bound ${pluginId} plugin bundle`);
    }
    const bundle = exactDirectory(bundles[0]!.sourcePath, `${pluginId} plugin bundle`);
    exactFile(join(bundle, ".mcp.json"), `${pluginId} plugin route declaration`);
    if (pluginId === "chrome-devtools") {
      exactFile(join(bundle, "bin", "chrome-devtools-mcp-locked"), "Chrome DevTools locked wrapper");
    }
  }
}

function requiredCoverageKeys(entries: readonly ManagedMcpLifecycleEntry[]): string[] {
  assertRequiredFleetCoverage(entries);
  return REQUIRED_MANAGED_MCP_FLEET_ROUTES.map(requiredKey).sort();
}

function ownerMatches(owner: string, required: RequiredFleetRoute): boolean {
  if (required.ownerKind === "config") return owner === "config";
  return owner.startsWith(`plugin:${required.ownerId}@`) || owner.startsWith(`selected_plugin:${required.ownerId}@`);
}

function requiredKey(route: RequiredFleetRoute): string {
  return `${route.ownerKind}:${route.ownerId}/${route.server}`;
}

function validOwner(owner: string): boolean {
  if (owner === "config") return true;
  if (/^(compatibility|extension):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner)) return true;
  return /^(plugin|selected_plugin):[A-Za-z0-9][A-Za-z0-9._-]{0,127}@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(owner);
}

function catalogDestination(entry: ManagedMcpLifecycleEntry): string {
  const owner = entry.owner.replace(/[^A-Za-z0-9._-]+/g, "_");
  const server = entry.server.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `catalogs/${owner}--${server}--${entry.catalog.sha256.slice(7, 19)}.json`;
}

function digestTree(root: string): { entryCount: number; sha256: string } {
  const entries: Array<Record<string, string | number>> = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const local = relative(root, path).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (stat.isFile()) {
      entries.push({ path: local, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(path)) });
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = safeRelativeSymlinkTarget(root, path, local, "Managed MCP tree");
      entries.push({ path: local, type: "symlink", mode: stat.mode & 0o7777, target });
      return;
    }
    throw new Error(`Managed MCP tree contains unsupported entry ${local}`);
  };
  visit(root);
  return { entryCount: entries.length, sha256: sha256(Buffer.from(JSON.stringify(entries))) };
}

function digestArtifactTree(root: string, allowSafeRelativeSymlinks: boolean): { entryCount: number; sha256: string } {
  const entries: Array<Record<string, string | number>> = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const local = relative(root, path).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (stat.isSymbolicLink()) {
      if (!allowSafeRelativeSymlinks) throw new Error(`Managed MCP artifact tree contains symlink ${local}`);
      const target = safeRelativeSymlinkTarget(root, path, local, "Managed MCP package tree");
      entries.push({ path: local, type: "symlink", mode: stat.mode & 0o7777, target });
      return;
    }
    if (!stat.isFile()) throw new Error(`Managed MCP artifact tree contains unsupported entry ${local}`);
    entries.push({ path: local, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(path)) });
  };
  visit(root);
  return { entryCount: entries.length, sha256: sha256(Buffer.from(JSON.stringify(entries))) };
}

function safeRelativeSymlinkTarget(root: string, path: string, local: string, label: string): string {
  const target = readlinkSync(path);
  if (isAbsolute(target)) throw new Error(`${label} symlink ${local} must use a relative target`);
  const resolved = resolve(dirname(path), target);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} symlink ${local} escapes its root`);
  }
  if (!existsSync(path)) throw new Error(`${label} symlink ${local} is broken`);
  let actualTarget: string;
  try {
    actualTarget = realpathSync(path);
  } catch {
    throw new Error(`${label} symlink ${local} is broken`);
  }
  const actualRoot = realpathSync(root);
  if (actualTarget !== actualRoot && !actualTarget.startsWith(`${actualRoot}${sep}`)) {
    throw new Error(`${label} symlink ${local} resolves outside its root`);
  }
  return target;
}

function resolveContained(root: string, local: string, label: string): string {
  assertSafeRelativePath(local, label);
  const path = resolve(root, local);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Unsafe ${label} path ${local}`);
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  return path;
}

function assertSafeRelativePath(path: string, label: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Unsafe ${label}: ${path}`);
}

function claimRuntimeDestination(claimed: string[], path: string, label: string): void {
  assertSafeRelativePath(path, `${label} destination`);
  const normalized = path.split(/[\\/]/).filter((part) => part !== ".").join("/");
  if (!normalized) throw new Error(`${label} destination is empty`);
  const collision = claimed.find((existing) =>
    existing === normalized
    || existing.startsWith(`${normalized}/`)
    || normalized.startsWith(`${existing}/`)
  );
  if (collision) throw new Error(`${label} destination ${normalized} overlaps ${collision}`);
  claimed.push(normalized);
}

function exactFile(path: string, label: string): string {
  const exact = exactExistingPath(path, label);
  const stat = lstatSync(exact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return exact;
}

function exactDirectory(path: string, label: string): string {
  const exact = exactExistingPath(path, label);
  const stat = lstatSync(exact);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  return exact;
}

function exactExistingPath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || !existsSync(path)) throw new Error(`${label} path must be exact, absolute, and present`);
  assertInternalStoragePath(path, label);
  return path;
}

function exactFuturePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path).length === 0) throw new Error(`${label} path must be exact and absolute`);
  assertInternalStoragePath(path, label);
  return path;
}

function atomicJsonWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function atomicFileWrite(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function parseJson(bytes: Buffer, file: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected string for ${label}`);
  return value;
}

function requireSafeSegment(value: unknown, label: string): string {
  const segment = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) throw new Error(`Unsafe ${label}`);
  return segment;
}

function requireMcpSha256(value: unknown, label: string): string {
  const digest = requireString(value, label).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Expected sha256: digest for ${label}`);
  return digest;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mcpSha256Digest(bytes: Buffer): string {
  return `sha256:${sha256(bytes)}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

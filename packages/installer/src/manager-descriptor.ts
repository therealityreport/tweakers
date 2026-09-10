import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGER_PROTOCOL_VERSION, TWEAKERS_MANAGER_ID } from "./manager-contract.js";
import { targetUserHome, targetUserOwnership, type UserOwnership } from "./ownership.js";
import { explicitTweakersUserRoot } from "./paths.js";
import { readRuntimeFingerprintEvidence, type RuntimeTreeFingerprint } from "./runtime-fingerprint.js";
import {
  REQUIRED_SEALED_MANAGER_SUPPORT_FILES,
  SEALED_MANAGER_SUPPORT_DIRECTORY,
} from "./manager-runtime-assets.js";
import {
  readManagedRuntimeFingerprintEvidence,
  type ManagedRuntimeTreeFingerprint,
} from "./managed-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultAssetsRoot = resolve(here, "..", "assets", "manager-launcher");
const defaultRuntimeAssetsRoot = resolve(here, "..", "assets", "runtime");
const defaultManagedRuntimeAssetsRoot = resolve(here, "..", "assets", "managed-runtime");
const MANAGER_RUNTIME_FINGERPRINT_MARKER = "TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1";
const MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER = "TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1";

/** The descriptor is a publisher-owned declaration, never a host trust record. */
export const MANAGER_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const TWEAKERS_MANAGER_DISPLAY_NAME = "Tweakers" as const;
export const TWEAKERS_MANAGER_PUBLISHER = TWEAKERS_MANAGER_ID;
export const TWEAKERS_MANAGER_LAUNCHER_NAME = "Tweakers Manager Launcher" as const;
export const TWEAKERS_MANAGER_BUNDLE_NAME = "manager.mjs" as const;
export const TWEAKERS_MANAGER_SEAL_NAME = "target.seal" as const;
export const TWEAKERS_MANAGER_SEAL_HEADER = "TWEAKERS_MANAGER_TARGET_SEAL_V1" as const;
const PINNED_MANAGER_DESIGNATED_REQUIREMENT =
  'identifier "com.therealityreport.tweakers.manager-launcher" and certificate leaf = H"631275551276127985a524acf1f469bf5164d50d"';
const managerSigningPolicyPath = join(defaultAssetsRoot, "signing-policy.json");
// The sealed manager bundle is published without the source asset tree. Keep
// the exact requirement compiled into that bundle while still validating the
// policy file whenever the source/package layout provides it.
const managerSigningPolicy = existsSync(managerSigningPolicyPath)
  ? readManagerSigningPolicy(managerSigningPolicyPath)
  : { designatedRequirement: PINNED_MANAGER_DESIGNATED_REQUIREMENT };
// `codesign -d -r-` emits this exact canonical requirement for the fixed
// launcher built by native-host. Treat it as a single opaque value: accepting
// a substring would permit an attacker to append an `or` branch or another
// broader clause while retaining the expected identifier text.
export const TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT =
  managerSigningPolicy.designatedRequirement;

const MANAGER_DIRECTORY_MODE = 0o700;
const MANAGER_LAUNCHER_MODE = 0o500;
const MANAGER_DATA_MODE = 0o400;
const DESCRIPTOR_MODE = 0o600;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GENERATION_ID = /^[a-f0-9]{64}$/;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface TweakersManagerDescriptorV1 {
  schemaVersion: typeof MANAGER_DESCRIPTOR_SCHEMA_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  displayName: typeof TWEAKERS_MANAGER_DISPLAY_NAME;
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  executable: string;
  publisher: typeof TWEAKERS_MANAGER_PUBLISHER;
  updatedAt: string;
}

/**
 * Fixed line-oriented integrity manifest consumed by the native launcher.
 * Its exact serializer/parser contract deliberately avoids permissive JSON
 * interpretation in the security boundary.
 */
export interface TweakersManagerTargetSealV1 {
  managerId: typeof TWEAKERS_MANAGER_ID;
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  generationId: string;
  launcherSha256: string;
  nodePath: string;
  nodeSha256: string;
  managerSha256: string;
  managedRuntimeFingerprint: string;
}

export interface ManagerArtifactPaths {
  launcher: string;
  bundle: string;
  runtime: string;
  managedRuntime: string;
}

export interface TweakersManagerDescriptorPaths {
  userRoot: string;
  managerRoot: string;
  generationsRoot: string;
  descriptorRoot: string;
  descriptorFile: string;
}

export interface ManagerSigningEvidence {
  authority: string;
  designatedRequirement: string;
}

export interface PublishedTweakersManagerDescriptor {
  paths: TweakersManagerDescriptorPaths;
  generationId: string;
  generationRoot: string;
  launcher: string;
  bundle: string;
  runtime: string;
  managedRuntime: string;
  seal: string;
  descriptor: TweakersManagerDescriptorV1;
  signing: ManagerSigningEvidence;
  reusedGeneration: boolean;
  /**
   * Compensate a later promotion failure only while this exact descriptor is
   * still current. This deliberately refuses to overwrite a concurrent
   * publisher's descriptor.
   */
  restoreOnFailure(): void;
}

export interface ManagerDescriptorDependencies {
  /** Test-only injection; production always verifies the actual codesign evidence. */
  verifyLauncherSignature?: (path: string) => ManagerSigningEvidence;
  now?: () => Date | string;
  owner?: () => UserOwnership | null;
  nodePath?: () => string;
  beforeDescriptorPublish?: () => void;
  /** Test-only fault seam after descriptor publication and round-trip verification. */
  afterDescriptorPublish?: () => void;
}

export interface PublishTweakersManagerDescriptorOptions {
  /** Exact active Tweakers state root, never a checkout path. */
  userRoot: string;
  /** Test-only override; production resolves to Menu Bar's manager-descriptors directory. */
  descriptorRoot?: string;
  /** Test-only override; production uses installer assets/manager-launcher. */
  assets?: Partial<ManagerArtifactPaths>;
  dependencies?: ManagerDescriptorDependencies;
}

export interface RemoveTweakersManagerDescriptorOptions {
  userRoot: string;
  descriptorRoot?: string;
}

/**
 * Resolve only durable installation locations. There is intentionally no
 * checkout, PATH, `current` symlink, or descriptor-supplied launch target.
 */
export function tweakersManagerDescriptorPaths(
  userRoot: string,
  descriptorRoot = defaultDescriptorRoot(),
): TweakersManagerDescriptorPaths {
  const exactUserRoot = requireExactAbsolutePath(userRoot, "Tweakers manager user root");
  const exactDescriptorRoot = requireExactAbsolutePath(descriptorRoot, "Menu Bar manager descriptor root");
  const managerRoot = join(exactUserRoot, "managers", TWEAKERS_MANAGER_ID);
  return {
    userRoot: exactUserRoot,
    managerRoot,
    generationsRoot: join(managerRoot, "generations"),
    descriptorRoot: exactDescriptorRoot,
    descriptorFile: join(exactDescriptorRoot, `${TWEAKERS_MANAGER_ID}.json`),
  };
}

export function defaultManagerArtifactPaths(): ManagerArtifactPaths {
  return {
    launcher: join(defaultAssetsRoot, TWEAKERS_MANAGER_LAUNCHER_NAME),
    bundle: join(defaultAssetsRoot, TWEAKERS_MANAGER_BUNDLE_NAME),
    runtime: defaultRuntimeAssetsRoot,
    managedRuntime: defaultManagedRuntimeAssetsRoot,
  };
}

/**
 * The manager always owns its immutable generations under the current
 * Tweakers root. Independent app state is a child at `variants/tweakers`;
 * it is never itself a manager-generation root.
 */
export function canonicalTweakersManagerRoot(homeRoot = targetUserHome() || homedir()): string {
  const exactHome = requireExactAbsolutePath(resolve(homeRoot), "Tweakers manager home root");
  return join(exactHome, "Library", "Application Support", "Tweakers");
}

/**
 * A sealed launcher starts Node with an empty environment, so its ordinary
 * route is the canonical global root. Explicit CLI/test root bindings retain
 * precedence without reviving the archived on-disk fallback.
 */
export function resolveSealedTweakersManagerUserRoot(
  explicitRoot = explicitTweakersUserRoot(),
  homeRoot?: string,
): string {
  return explicitRoot ?? canonicalTweakersManagerRoot(homeRoot);
}

export function createTweakersManagerGenerationId(input: Omit<TweakersManagerTargetSealV1, "generationId">): string {
  const preimage = [
    "TWEAKERS_MANAGER_GENERATION_V1",
    `manager-id=${input.managerId}`,
    `protocol-version=${input.protocolVersion}`,
    `launcher-sha256=${input.launcherSha256}`,
    `node-path=${input.nodePath}`,
    `node-sha256=${input.nodeSha256}`,
    `manager-sha256=${input.managerSha256}`,
    `managed-runtime-fingerprint=${input.managedRuntimeFingerprint}`,
    "",
  ].join("\n");
  return sha256Text(preimage);
}

export function serializeTweakersManagerTargetSeal(seal: TweakersManagerTargetSealV1): string {
  assertTargetSeal(seal);
  return [
    TWEAKERS_MANAGER_SEAL_HEADER,
    `manager-id=${seal.managerId}`,
    `protocol-version=${seal.protocolVersion}`,
    `generation-id=${seal.generationId}`,
    `launcher-sha256=${seal.launcherSha256}`,
    `node-path=${seal.nodePath}`,
    `node-sha256=${seal.nodeSha256}`,
    `manager-sha256=${seal.managerSha256}`,
    `managed-runtime-fingerprint=${seal.managedRuntimeFingerprint}`,
    "",
  ].join("\n");
}

export function parseTweakersManagerTargetSeal(text: string): TweakersManagerTargetSealV1 {
  if (typeof text !== "string" || text.includes("\r") || !text.endsWith("\n")) {
    throw new Error("Tweakers manager target seal must be UTF-8 LF-terminated text");
  }
  const lines = text.split("\n");
  // The final empty string exists solely because the fixed format requires one LF.
  if (lines.length !== 10 || lines[9] !== "" || lines[0] !== TWEAKERS_MANAGER_SEAL_HEADER) {
    throw new Error("Tweakers manager target seal has an invalid fixed record count or header");
  }
  const values = [
    ["manager-id", lines[1]],
    ["protocol-version", lines[2]],
    ["generation-id", lines[3]],
    ["launcher-sha256", lines[4]],
    ["node-path", lines[5]],
    ["node-sha256", lines[6]],
    ["manager-sha256", lines[7]],
    ["managed-runtime-fingerprint", lines[8]],
  ].map(([key, line]) => {
    const prefix = `${key}=`;
    if (typeof line !== "string" || !line.startsWith(prefix)) {
      throw new Error(`Tweakers manager target seal is missing fixed ${key} record`);
    }
    return line.slice(prefix.length);
  });
  const seal: TweakersManagerTargetSealV1 = {
    managerId: values[0] as typeof TWEAKERS_MANAGER_ID,
    protocolVersion: Number(values[1]) as typeof MANAGER_PROTOCOL_VERSION,
    generationId: values[2]!,
    launcherSha256: values[3]!,
    nodePath: values[4]!,
    nodeSha256: values[5]!,
    managerSha256: values[6]!,
    managedRuntimeFingerprint: values[7]!,
  };
  assertTargetSeal(seal);
  return seal;
}

export function serializeTweakersManagerDescriptor(descriptor: TweakersManagerDescriptorV1): string {
  assertTweakersManagerDescriptor(descriptor);
  // Property order is deliberately stable so test fixtures and publisher bytes
  // are deterministic apart from the publisher-supplied timestamp.
  return `${JSON.stringify({
    schemaVersion: descriptor.schemaVersion,
    managerId: descriptor.managerId,
    displayName: descriptor.displayName,
    protocolVersion: descriptor.protocolVersion,
    executable: descriptor.executable,
    publisher: descriptor.publisher,
    updatedAt: descriptor.updatedAt,
  }, null, 2)}\n`;
}

export function parseTweakersManagerDescriptor(text: string): TweakersManagerDescriptorV1 {
  if (Buffer.byteLength(text, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Tweakers manager descriptor exceeds the 16 KiB limit");
  }
  assertNoDuplicateTopLevelJsonKeys(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Tweakers manager descriptor is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error("Tweakers manager descriptor must be a JSON object");
  }
  assertTweakersManagerDescriptor(parsed);
  return parsed;
}

export function assertTweakersManagerDescriptor(value: unknown): asserts value is TweakersManagerDescriptorV1 {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("Tweakers manager descriptor must be a JSON object");
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "displayName",
    "executable",
    "managerId",
    "protocolVersion",
    "publisher",
    "schemaVersion",
    "updatedAt",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Tweakers manager descriptor has unknown, missing, or duplicate schema keys");
  }
  if (value.schemaVersion !== MANAGER_DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error("Tweakers manager descriptor has an unsupported schemaVersion");
  }
  if (value.managerId !== TWEAKERS_MANAGER_ID || value.publisher !== TWEAKERS_MANAGER_PUBLISHER) {
    throw new Error("Tweakers manager descriptor has an unexpected manager or publisher identity");
  }
  if (value.displayName !== TWEAKERS_MANAGER_DISPLAY_NAME) {
    throw new Error("Tweakers manager descriptor has an unexpected display name");
  }
  if (value.protocolVersion !== MANAGER_PROTOCOL_VERSION) {
    throw new Error("Tweakers manager descriptor has an unsupported protocol version");
  }
  if (typeof value.executable !== "string") {
    throw new Error("Tweakers manager descriptor executable must be a string");
  }
  if (typeof value.updatedAt !== "string") {
    throw new Error("Tweakers manager descriptor updatedAt must be a string");
  }
  requireExactAbsolutePath(value.executable, "Tweakers manager descriptor executable");
  if (!RFC3339_TIMESTAMP.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Tweakers manager descriptor updatedAt must be RFC3339");
  }
}

/**
 * Build/reuse one immutable generation and publish its descriptor only after
 * the generation validates. The host's trust record is intentionally neither
 * read nor written here.
 */
export function publishTweakersManagerDescriptor(
  options: PublishTweakersManagerDescriptorOptions,
): PublishedTweakersManagerDescriptor {
  if (platform() !== "darwin") {
    throw new Error("Tweakers manager descriptor publication requires the signed macOS native launcher");
  }
  const dependencies = options.dependencies ?? {};
  const owner = (dependencies.owner ?? targetUserOwnership)();
  if (!owner || owner.uid === 0) {
    throw new Error("Tweakers manager descriptor publication requires one non-root target user");
  }
  const paths = tweakersManagerDescriptorPaths(options.userRoot, options.descriptorRoot);
  const assets = resolveManagerArtifactPaths(options.assets);
  assertSourceArtifact(assets.launcher, "Tweakers Manager Launcher");
  assertSourceArtifact(assets.bundle, "Tweakers manager bundle");
  const runtimeEvidence = assertSourceRuntimeArtifact(assets.runtime);
  const managedRuntimeEvidence = assertSourceManagedRuntimeArtifact(assets.managedRuntime);
  const compiledRuntimeFingerprint = readManagerBundleRuntimeFingerprint(assets.bundle);
  const compiledManagedRuntimeFingerprint = readManagerBundleManagedRuntimeFingerprint(assets.bundle);
  if (compiledRuntimeFingerprint !== runtimeEvidence.fingerprint) {
    throw new Error("Tweakers manager bundle and packaged runtime fingerprints do not match");
  }
  if (compiledManagedRuntimeFingerprint !== managedRuntimeEvidence.fingerprint) {
    throw new Error("Tweakers manager bundle and packaged managed-runtime fingerprints do not match");
  }
  const signing = (dependencies.verifyLauncherSignature ?? verifyTweakersManagerLauncherSignature)(assets.launcher);
  assertSigningEvidence(signing);

  ensureExistingSafeDirectory(paths.userRoot, owner, "Tweakers manager user root", false);
  const node = resolveNodeTarget((dependencies.nodePath ?? (() => process.execPath))(), owner);
  const launcherSha256 = sha256File(assets.launcher);
  const managerSha256 = sha256File(assets.bundle);
  const sealBase = {
    managerId: TWEAKERS_MANAGER_ID,
    protocolVersion: MANAGER_PROTOCOL_VERSION,
    launcherSha256,
    nodePath: node.path,
    nodeSha256: node.sha256,
    managerSha256,
    managedRuntimeFingerprint: managedRuntimeEvidence.fingerprint,
  } as const;
  const generationId = createTweakersManagerGenerationId(sealBase);
  const seal: TweakersManagerTargetSealV1 = { ...sealBase, generationId };

  const managerRoot = ensureManagedDirectory(join(paths.userRoot, "managers"), owner, "manager root");
  const managerIdRoot = ensureManagedDirectory(join(managerRoot, TWEAKERS_MANAGER_ID), owner, "manager identity root");
  const generationsRoot = ensureManagedDirectory(join(managerIdRoot, "generations"), owner, "manager generations root");
  const runtimeGenerationsRoot = ensureManagedDirectory(
    join(managerIdRoot, "runtime-generations"),
    owner,
    "manager runtime generations root",
  );
  const managedRuntimeGenerationsRoot = ensureManagedDirectory(
    join(managerIdRoot, "managed-runtime-generations"),
    owner,
    "manager managed-runtime generations root",
  );
  if (generationsRoot !== paths.generationsRoot) {
    throw new Error("Tweakers manager generation root resolution drifted");
  }
  const runtimeGenerationRoot = join(runtimeGenerationsRoot, runtimeEvidence.fingerprint);
  publishOrValidateRuntimeGeneration({
    source: assets.runtime,
    runtimeGenerationRoot,
    runtimeGenerationsRoot,
    owner,
    evidence: runtimeEvidence,
  });
  const managedRuntimeGenerationRoot = join(managedRuntimeGenerationsRoot, managedRuntimeEvidence.fingerprint);
  publishOrValidateManagedRuntimeGeneration({
    source: assets.managedRuntime,
    managedRuntimeGenerationRoot,
    managedRuntimeGenerationsRoot,
    owner,
    evidence: managedRuntimeEvidence,
  });
  const generationRoot = join(generationsRoot, generationId);
  const existing = existsSync(generationRoot);
  if (existing) {
    validateTweakersManagerGeneration({ generationRoot, paths, owner, seal, signing, node });
  } else {
    publishImmutableGeneration({ generationRoot, generationsRoot, owner, assets, seal, paths, signing, node });
  }
  // Re-read even a just-created generation; the descriptor must never point
  // at an unchecked object after a failed or concurrent publication attempt.
  validateTweakersManagerGeneration({ generationRoot, paths, owner, seal, signing, node });

  ensureDescriptorDirectory(paths.descriptorRoot, owner);
  const priorDescriptor = captureDescriptorSnapshot(paths.descriptorFile, owner);
  const descriptor: TweakersManagerDescriptorV1 = {
    schemaVersion: MANAGER_DESCRIPTOR_SCHEMA_VERSION,
    managerId: TWEAKERS_MANAGER_ID,
    displayName: TWEAKERS_MANAGER_DISPLAY_NAME,
    protocolVersion: MANAGER_PROTOCOL_VERSION,
    executable: join(generationRoot, TWEAKERS_MANAGER_LAUNCHER_NAME),
    publisher: TWEAKERS_MANAGER_PUBLISHER,
    updatedAt: normalizedNow(dependencies.now),
  };
  assertTweakersManagerDescriptor(descriptor);
  const descriptorText = serializeTweakersManagerDescriptor(descriptor);
  const restoreOnFailure = (): void => {
    restoreDescriptorSnapshot(paths.descriptorFile, priorDescriptor, descriptorText, owner);
  };
  try {
    dependencies.beforeDescriptorPublish?.();
    writeDescriptorAtomically(paths.descriptorFile, descriptorText, owner);
    const written = parseTweakersManagerDescriptor(readFileSync(paths.descriptorFile, "utf8"));
    if (serializeTweakersManagerDescriptor(written) !== descriptorText) {
      throw new Error("Tweakers manager descriptor did not round-trip after atomic publication");
    }
    dependencies.afterDescriptorPublish?.();
    return {
      paths,
      generationId,
      generationRoot,
      launcher: descriptor.executable,
      bundle: join(generationRoot, TWEAKERS_MANAGER_BUNDLE_NAME),
      runtime: runtimeGenerationRoot,
      managedRuntime: managedRuntimeGenerationRoot,
      seal: join(generationRoot, TWEAKERS_MANAGER_SEAL_NAME),
      descriptor,
      signing,
      reusedGeneration: existing,
      restoreOnFailure,
    };
  } catch (error) {
    try {
      restoreOnFailure();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Tweakers manager descriptor publication failed and its prior descriptor could not be safely restored.",
      );
    }
    throw error;
  }
}

/**
 * Disable discovery before anything else may remove Tweakers-owned artifacts.
 * This deliberately never reads, changes, or removes Menu Bar's trust record.
 */
export function removeTweakersManagerDescriptor(options: RemoveTweakersManagerDescriptorOptions): { removed: boolean; descriptorFile: string } {
  const paths = tweakersManagerDescriptorPaths(options.userRoot, options.descriptorRoot);
  if (!existsSync(paths.descriptorRoot)) return { removed: false, descriptorFile: paths.descriptorFile };
  const owner = targetUserOwnership();
  if (!owner || owner.uid === 0) {
    throw new Error("Tweakers manager descriptor removal requires one non-root target user");
  }
  // The publisher owns this directory. Validate it before unlinking so an
  // attacker cannot redirect uninstall through a symlinked host path.
  // This host-owned directory may predate Tweakers and use a safe, non-0700
  // mode such as 0755. Removal needs the same no-symlink, owner, and
  // non-writable-by-others protections, but must not block uninstall solely
  // because Tweakers did not create the directory.
  ensureExistingSafeDirectory(paths.descriptorRoot, owner, "Menu Bar manager descriptor directory", false);
  try {
    // lstat deliberately sees a dangling hostile symlink too. `existsSync`
    // would report that case as absent and leave discovery metadata behind.
    lstatSync(paths.descriptorFile);
  } catch (error) {
    if (isMissingPathError(error)) return { removed: false, descriptorFile: paths.descriptorFile };
    throw error;
  }
  // unlink removes a hostile symlink itself rather than following it. No
  // descriptor content is trusted at uninstall time.
  unlinkSync(paths.descriptorFile);
  if (existsSync(paths.descriptorRoot)) fsyncDirectory(paths.descriptorRoot);
  return { removed: true, descriptorFile: paths.descriptorFile };
}

export interface ValidateTweakersManagerGenerationInput {
  generationRoot: string;
  paths: TweakersManagerDescriptorPaths;
  owner: UserOwnership;
  seal: TweakersManagerTargetSealV1;
  signing: ManagerSigningEvidence;
  node: { path: string; sha256: string };
}

/** Exported for focused E6 owner/mode/realpath/ancestor tests. */
export function validateTweakersManagerGeneration(input: ValidateTweakersManagerGenerationInput): void {
  const exactGeneration = requireExactAbsolutePath(input.generationRoot, "Tweakers manager generation root");
  if (basename(exactGeneration) !== input.seal.generationId || dirname(exactGeneration) !== input.paths.generationsRoot) {
    throw new Error("Tweakers manager generation is not at its fixed immutable location");
  }
  assertSafeAncestors(exactGeneration, input.owner, "Tweakers manager generation");
  for (const [path, label] of [
    [join(input.paths.userRoot, "managers"), "manager root"],
    [input.paths.managerRoot, "manager identity root"],
    [input.paths.generationsRoot, "manager generations root"],
    [join(input.paths.managerRoot, "runtime-generations"), "manager runtime generations root"],
    [join(input.paths.managerRoot, "managed-runtime-generations"), "manager managed-runtime generations root"],
    [exactGeneration, "manager generation"],
  ] as const) {
    assertExactOwnedDirectory(path, input.owner, MANAGER_DIRECTORY_MODE, label);
  }
  const entries = readdirSync(exactGeneration).sort((left, right) => left.localeCompare(right));
  const expectedEntries = [TWEAKERS_MANAGER_BUNDLE_NAME, TWEAKERS_MANAGER_LAUNCHER_NAME, TWEAKERS_MANAGER_SEAL_NAME]
    .sort((left, right) => left.localeCompare(right));
  if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
    throw new Error("Tweakers manager generation has unexpected or missing files");
  }
  const launcher = join(exactGeneration, TWEAKERS_MANAGER_LAUNCHER_NAME);
  const bundle = join(exactGeneration, TWEAKERS_MANAGER_BUNDLE_NAME);
  const sealFile = join(exactGeneration, TWEAKERS_MANAGER_SEAL_NAME);
  assertExactOwnedRegularFile(launcher, input.owner, MANAGER_LAUNCHER_MODE, "Tweakers Manager Launcher");
  assertExactOwnedRegularFile(bundle, input.owner, MANAGER_DATA_MODE, "Tweakers manager bundle");
  assertExactOwnedRegularFile(sealFile, input.owner, MANAGER_DATA_MODE, "Tweakers manager target seal");
  if (sha256File(launcher) !== input.seal.launcherSha256) throw new Error("Tweakers Manager Launcher digest drifted");
  if (sha256File(bundle) !== input.seal.managerSha256) throw new Error("Tweakers manager bundle digest drifted");
  const runtimeFingerprint = readManagerBundleRuntimeFingerprint(bundle);
  validateRuntimeGeneration(
    join(input.paths.managerRoot, "runtime-generations", runtimeFingerprint),
    input.owner,
    { fingerprint: runtimeFingerprint, fileCount: null },
  );
  validateManagedRuntimeGeneration(
    join(input.paths.managerRoot, "managed-runtime-generations", input.seal.managedRuntimeFingerprint),
    input.owner,
    { fingerprint: input.seal.managedRuntimeFingerprint, fileCount: null },
  );
  const parsedSeal = parseTweakersManagerTargetSeal(readFileSync(sealFile, "utf8"));
  if (!sameTargetSeal(parsedSeal, input.seal)) throw new Error("Tweakers manager target seal drifted");
  const computedGeneration = createTweakersManagerGenerationId({
    managerId: parsedSeal.managerId,
    protocolVersion: parsedSeal.protocolVersion,
    launcherSha256: parsedSeal.launcherSha256,
    nodePath: parsedSeal.nodePath,
    nodeSha256: parsedSeal.nodeSha256,
    managerSha256: parsedSeal.managerSha256,
    managedRuntimeFingerprint: parsedSeal.managedRuntimeFingerprint,
  });
  if (computedGeneration !== parsedSeal.generationId) throw new Error("Tweakers manager target seal generation digest is invalid");
  if (parsedSeal.nodePath !== input.node.path || parsedSeal.nodeSha256 !== input.node.sha256) {
    throw new Error("Tweakers manager target seal node identity drifted");
  }
  // The existing seal binds the code bytes; the caller-provided signing
  // evidence proves the source/published launcher bears the stable identity.
  assertSigningEvidence(input.signing);
}

function publishImmutableGeneration(input: {
  generationRoot: string;
  generationsRoot: string;
  owner: UserOwnership;
  assets: ManagerArtifactPaths;
  seal: TweakersManagerTargetSealV1;
  paths: TweakersManagerDescriptorPaths;
  signing: ManagerSigningEvidence;
  node: { path: string; sha256: string };
}): void {
  const staging = join(input.generationsRoot, `.${input.seal.generationId}.staging-${randomUUID()}`);
  assertChildPath(input.generationsRoot, staging, "Tweakers manager staging generation");
  mkdirSync(staging, { mode: MANAGER_DIRECTORY_MODE });
  try {
    normalizeOwnedPath(staging, input.owner, MANAGER_DIRECTORY_MODE, "Tweakers manager staging generation");
    const launcher = join(staging, TWEAKERS_MANAGER_LAUNCHER_NAME);
    const bundle = join(staging, TWEAKERS_MANAGER_BUNDLE_NAME);
    const seal = join(staging, TWEAKERS_MANAGER_SEAL_NAME);
    copyImmutableArtifact(input.assets.launcher, launcher, input.owner, MANAGER_LAUNCHER_MODE, "Tweakers Manager Launcher");
    copyImmutableArtifact(input.assets.bundle, bundle, input.owner, MANAGER_DATA_MODE, "Tweakers manager bundle");
    // target.seal is intentionally written last inside the invisible staging
    // directory. The descriptor remains unpublished until after rename +
    // complete re-validation below.
    writePrivateFile(seal, serializeTweakersManagerTargetSeal(input.seal), input.owner, MANAGER_DATA_MODE);
    fsyncDirectory(staging);
    try {
      renameSync(staging, input.generationRoot);
    } catch (error) {
      if (!existsSync(input.generationRoot)) throw error;
      // Another publisher may have completed the same content-addressed
      // generation. Never overwrite it; validate it below instead.
    }
    fsyncDirectory(input.generationsRoot);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  validateTweakersManagerGeneration({
    generationRoot: input.generationRoot,
    paths: input.paths,
    owner: input.owner,
    seal: input.seal,
    signing: input.signing,
    node: input.node,
  });
}

function publishOrValidateRuntimeGeneration(input: {
  source: string;
  runtimeGenerationRoot: string;
  runtimeGenerationsRoot: string;
  owner: UserOwnership;
  evidence: RuntimeTreeFingerprint;
}): void {
  if (existsSync(input.runtimeGenerationRoot)) {
    validateRuntimeGeneration(input.runtimeGenerationRoot, input.owner, input.evidence);
    return;
  }
  const staging = join(
    input.runtimeGenerationsRoot,
    `.${input.evidence.fingerprint}.staging-${randomUUID()}`,
  );
  assertChildPath(input.runtimeGenerationsRoot, staging, "Tweakers manager runtime staging generation");
  mkdirSync(staging, { mode: MANAGER_DIRECTORY_MODE });
  try {
    normalizeOwnedPath(staging, input.owner, MANAGER_DIRECTORY_MODE, "Tweakers manager runtime staging generation");
    copyRuntimeTreeContents(input.source, staging, input.owner);
    fsyncDirectory(staging);
    try {
      renameSync(staging, input.runtimeGenerationRoot);
    } catch (error) {
      if (!existsSync(input.runtimeGenerationRoot)) throw error;
    }
    fsyncDirectory(input.runtimeGenerationsRoot);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  validateRuntimeGeneration(input.runtimeGenerationRoot, input.owner, input.evidence);
}

function publishOrValidateManagedRuntimeGeneration(input: {
  source: string;
  managedRuntimeGenerationRoot: string;
  managedRuntimeGenerationsRoot: string;
  owner: UserOwnership;
  evidence: ManagedRuntimeTreeFingerprint;
}): void {
  if (existsSync(input.managedRuntimeGenerationRoot)) {
    validateManagedRuntimeGeneration(input.managedRuntimeGenerationRoot, input.owner, input.evidence);
    return;
  }
  const staging = join(
    input.managedRuntimeGenerationsRoot,
    `.${input.evidence.fingerprint}.staging-${randomUUID()}`,
  );
  assertChildPath(input.managedRuntimeGenerationsRoot, staging, "Tweakers manager managed-runtime staging generation");
  mkdirSync(staging, { mode: MANAGER_DIRECTORY_MODE });
  try {
    normalizeOwnedPath(staging, input.owner, MANAGER_DIRECTORY_MODE, "Tweakers manager managed-runtime staging generation");
    copyRuntimeTreeContents(input.source, staging, input.owner);
    fsyncDirectory(staging);
    try {
      renameSync(staging, input.managedRuntimeGenerationRoot);
    } catch (error) {
      if (!existsSync(input.managedRuntimeGenerationRoot)) throw error;
    }
    fsyncDirectory(input.managedRuntimeGenerationsRoot);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  validateManagedRuntimeGeneration(input.managedRuntimeGenerationRoot, input.owner, input.evidence);
}

function copyRuntimeTreeContents(source: string, destination: string, owner: UserOwnership): void {
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const stat = lstatSync(from);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      mkdirSync(to, { mode: MANAGER_DIRECTORY_MODE });
      normalizeOwnedPath(to, owner, MANAGER_DIRECTORY_MODE, "Tweakers manager runtime directory");
      copyRuntimeTreeContents(from, to, owner);
      fsyncDirectory(to);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Tweakers manager runtime source contains an unsupported entry: ${from}`);
    }
    const mode = (stat.mode & 0o100) !== 0 ? MANAGER_LAUNCHER_MODE : MANAGER_DATA_MODE;
    copyImmutableArtifact(from, to, owner, mode, "Tweakers manager runtime file");
  }
}

function validateRuntimeGeneration(
  root: string,
  owner: UserOwnership,
  expected: { fingerprint: string; fileCount: number | null },
): void {
  if (basename(root) !== expected.fingerprint) {
    throw new Error("Tweakers manager runtime generation path does not match its fingerprint");
  }
  assertExactOwnedDirectory(root, owner, MANAGER_DIRECTORY_MODE, "Tweakers manager runtime generation");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        assertExactOwnedDirectory(path, owner, MANAGER_DIRECTORY_MODE, "Tweakers manager runtime directory");
        walk(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const stat = lstatSync(path);
        const mode = stat.mode & 0o7777;
        if ((mode !== MANAGER_DATA_MODE && mode !== MANAGER_LAUNCHER_MODE)
          || stat.uid !== owner.uid
          || stat.nlink !== 1
          || realpathSync(path) !== path) {
          throw new Error("Tweakers manager runtime file has an unsafe owner, mode, or identity");
        }
      } else {
        throw new Error("Tweakers manager runtime generation contains a symlink or unsupported entry");
      }
    }
  };
  walk(root);
  const evidence = readRuntimeFingerprintEvidence(root);
  if (evidence === null
    || evidence.fingerprint !== expected.fingerprint
    || (expected.fileCount !== null && evidence.fileCount !== expected.fileCount)) {
    throw new Error("Tweakers manager runtime generation failed its content fingerprint");
  }
}

function validateManagedRuntimeGeneration(
  root: string,
  owner: UserOwnership,
  expected: { fingerprint: string; fileCount: number | null },
): void {
  if (basename(root) !== expected.fingerprint) {
    throw new Error("Tweakers manager managed-runtime generation path does not match its fingerprint");
  }
  assertExactOwnedDirectory(root, owner, MANAGER_DIRECTORY_MODE, "Tweakers manager managed-runtime generation");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        assertExactOwnedDirectory(path, owner, MANAGER_DIRECTORY_MODE, "Tweakers manager managed-runtime directory");
        walk(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const stat = lstatSync(path);
        const mode = stat.mode & 0o7777;
        if ((mode !== MANAGER_DATA_MODE && mode !== MANAGER_LAUNCHER_MODE)
          || stat.uid !== owner.uid
          || stat.nlink !== 1
          || realpathSync(path) !== path) {
          throw new Error("Tweakers manager managed-runtime file has an unsafe owner, mode, or identity");
        }
      } else {
        throw new Error("Tweakers manager managed-runtime generation contains a symlink or unsupported entry");
      }
    }
  };
  walk(root);
  const evidence = readManagedRuntimeFingerprintEvidence(root);
  if (evidence === null
    || evidence.fingerprint !== expected.fingerprint
    || (expected.fileCount !== null && evidence.fileCount !== expected.fileCount)) {
    throw new Error("Tweakers manager managed-runtime generation failed its content fingerprint");
  }
}

function assertSourceRuntimeArtifact(path: string): RuntimeTreeFingerprint {
  const exact = requireExactAbsolutePath(path, "Tweakers manager runtime asset");
  if (!existsSync(exact)) throw new Error(`Tweakers manager runtime asset is missing: ${exact}`);
  const walk = (directory: string): void => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Tweakers manager runtime source must contain only real directories and regular files");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const childStat = lstatSync(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(child);
      else if (!entry.isFile() || entry.isSymbolicLink() || childStat.nlink !== 1) {
        throw new Error(`Tweakers manager runtime source contains an unsupported entry: ${child}`);
      }
    }
  };
  walk(exact);
  const supportRoot = join(exact, SEALED_MANAGER_SUPPORT_DIRECTORY);
  for (const relativePath of REQUIRED_SEALED_MANAGER_SUPPORT_FILES) {
    const file = join(supportRoot, relativePath);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      throw new Error(`Tweakers manager runtime source is missing support asset: ${relativePath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(file) !== file) {
      throw new Error(`Tweakers manager runtime support asset has an unsafe identity: ${relativePath}`);
    }
  }
  const evidence = readRuntimeFingerprintEvidence(exact);
  if (evidence === null) throw new Error("Tweakers manager runtime asset failed its packaged fingerprint");
  return evidence;
}

function assertSourceManagedRuntimeArtifact(path: string): ManagedRuntimeTreeFingerprint {
  const exact = requireExactAbsolutePath(path, "Tweakers manager managed-runtime asset");
  if (!existsSync(exact)) throw new Error(`Tweakers manager managed-runtime asset is missing: ${exact}`);
  const walk = (directory: string): void => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Tweakers manager managed-runtime source must contain only real directories and regular files");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const childStat = lstatSync(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(child);
      else if (!entry.isFile() || entry.isSymbolicLink() || childStat.nlink !== 1) {
        throw new Error(`Tweakers manager managed-runtime source contains an unsupported entry: ${child}`);
      }
    }
  };
  walk(exact);
  const evidence = readManagedRuntimeFingerprintEvidence(exact);
  if (evidence === null) throw new Error("Tweakers manager managed-runtime asset failed its packaged fingerprint");
  return evidence;
}

function readManagerBundleRuntimeFingerprint(bundle: string): string {
  return readSingleManagerBundleFingerprint(bundle, MANAGER_RUNTIME_FINGERPRINT_MARKER, "runtime");
}

function readManagerBundleManagedRuntimeFingerprint(bundle: string): string {
  return readSingleManagerBundleFingerprint(bundle, MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER, "managed-runtime");
}

function readSingleManagerBundleFingerprint(bundle: string, markerName: string, label: string): string {
  const text = readFileSync(bundle, "utf8");
  const marker = new RegExp(`(?:^|\\n)//# ${markerName}=([a-f0-9]{64})\\n`, "g");
  const matches = [...text.matchAll(marker)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(`Tweakers manager bundle has no unique sealed packaged ${label} fingerprint`);
  }
  return matches[0][1];
}

function resolveManagerArtifactPaths(override: Partial<ManagerArtifactPaths> | undefined): ManagerArtifactPaths {
  const defaults = defaultManagerArtifactPaths();
  return {
    launcher: requireExactAbsolutePath(override?.launcher ?? defaults.launcher, "Tweakers Manager Launcher asset"),
    bundle: requireExactAbsolutePath(override?.bundle ?? defaults.bundle, "Tweakers manager bundle asset"),
    runtime: requireExactAbsolutePath(override?.runtime ?? defaults.runtime, "Tweakers manager runtime asset"),
    managedRuntime: requireExactAbsolutePath(
      override?.managedRuntime ?? defaults.managedRuntime,
      "Tweakers manager managed-runtime asset",
    ),
  };
}

function resolveNodeTarget(candidate: string, owner: UserOwnership): { path: string; sha256: string } {
  const exact = requireExactAbsolutePath(candidate, "Node executable");
  let canonical: string;
  try {
    canonical = realpathSync(exact);
  } catch (error) {
    throw new Error(`Node executable cannot be canonicalized: ${errorMessage(error)}`);
  }
  if (!isAbsolute(canonical)) throw new Error("Node executable canonical path is not absolute");
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o7000) !== 0) {
    throw new Error("Node executable must be a non-symlink single-link regular file without writable or set-id bits");
  }
  if (stat.uid !== 0 && stat.uid !== owner.uid) {
    throw new Error("Node executable must be owned by root or the target user");
  }
  assertSafeAncestors(dirname(canonical), owner, "Node executable");
  return { path: canonical, sha256: sha256File(canonical) };
}

function verifyTweakersManagerLauncherSignature(path: string): ManagerSigningEvidence {
  if (platform() !== "darwin") throw new Error("Tweakers Manager Launcher signing can only be verified on macOS");
  const verify = spawnSync("codesign", ["--verify", "--strict", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (verify.status !== 0 || verify.error) {
    throw new Error(`Tweakers Manager Launcher signing verification failed: ${commandOutput(verify)}`);
  }
  const details = spawnSync("codesign", ["-dv", "--verbose=4", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const detailOutput = commandOutput(details);
  // The required Tweakers Local Signing identity is intentionally local and
  // self-signed, so its TeamIdentifier is expected to be `not set`. Only an
  // ad-hoc code directory is prohibited; the exact authority and designated
  // requirement below bind the accepted local identity.
  if (details.status !== 0 || /Signature=adhoc/i.test(detailOutput)) {
    throw new Error("Tweakers Manager Launcher must have the existing Tweakers Local Signing identity, not an ad-hoc signature");
  }
  const authority = /^Authority=(.+)$/m.exec(detailOutput)?.[1]?.trim() ?? "";
  if (authority !== "Tweakers Local Signing") {
    throw new Error("Tweakers Manager Launcher is not signed by Tweakers Local Signing");
  }
  const requirement = spawnSync("codesign", ["-d", "-r-", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const requirementOutput = commandOutput(requirement);
  const designatedRequirement = /^designated => (.+)$/m.exec(requirementOutput)?.[1]?.trim() ?? "";
  if (requirement.status !== 0 || !designatedRequirement) {
    throw new Error("Tweakers Manager Launcher has no designated requirement");
  }
  const evidence = { authority, designatedRequirement };
  assertSigningEvidence(evidence);
  return evidence;
}

function assertSigningEvidence(evidence: ManagerSigningEvidence): void {
  if (
    evidence.authority !== "Tweakers Local Signing"
    || evidence.designatedRequirement !== TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT
  ) {
    throw new Error("Tweakers Manager Launcher signing evidence is incomplete or has an unexpected identity");
  }
}

function ensureManagedDirectory(path: string, owner: UserOwnership, label: string): string {
  if (existsSync(path)) {
    assertExactOwnedDirectory(path, owner, MANAGER_DIRECTORY_MODE, label);
  } else {
    mkdirSync(path, { mode: MANAGER_DIRECTORY_MODE });
    normalizeOwnedPath(path, owner, MANAGER_DIRECTORY_MODE, label);
  }
  return path;
}

function ensureDescriptorDirectory(path: string, owner: UserOwnership): void {
  const parent = dirname(path);
  // Menu Bar may not have created its state directory yet. Create only the
  // fixed immediate parent under an already-safe application-support root;
  // never follow or repair a pre-existing host-owned path.
  if (existsSync(parent)) {
    ensureExistingSafeDirectory(parent, owner, "Menu Bar manager descriptor parent", false);
  } else {
    const grandparent = dirname(parent);
    ensureExistingSafeDirectory(grandparent, owner, "Menu Bar manager descriptor grandparent", false);
    try {
      mkdirSync(parent, { mode: MANAGER_DIRECTORY_MODE });
      normalizeOwnedPath(parent, owner, MANAGER_DIRECTORY_MODE, "Menu Bar manager descriptor parent");
    } catch (error) {
      // A concurrent publisher may have created the same fixed directory.
      // Validate it rather than changing its ownership or permissions.
      if (!existsSync(parent)) throw error;
      ensureExistingSafeDirectory(parent, owner, "Menu Bar manager descriptor parent", false);
    }
  }
  if (existsSync(path)) {
    assertExactOwnedDirectory(path, owner, MANAGER_DIRECTORY_MODE, "Menu Bar manager descriptor directory");
  } else {
    mkdirSync(path, { mode: MANAGER_DIRECTORY_MODE });
    normalizeOwnedPath(path, owner, MANAGER_DIRECTORY_MODE, "Menu Bar manager descriptor directory");
  }
  assertSafeAncestors(path, owner, "Menu Bar manager descriptor directory");
}

function ensureExistingSafeDirectory(path: string, owner: UserOwnership, label: string, exactMode: boolean): void {
  const exact = requireExactAbsolutePath(path, label);
  if (!existsSync(exact)) throw new Error(`${label} must already exist`);
  const stat = lstatSync(exact);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  if (stat.uid !== owner.uid) throw new Error(`${label} must be owned by the target user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
  if (exactMode && (stat.mode & 0o7777) !== MANAGER_DIRECTORY_MODE) {
    throw new Error(`${label} must have mode ${MANAGER_DIRECTORY_MODE.toString(8)}`);
  }
  assertSafeAncestors(exact, owner, label);
}

function normalizeOwnedPath(path: string, owner: UserOwnership, mode: number, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  ensureTargetOwnership(path, owner, label);
  chmodSync(path, mode);
  assertExactOwnedDirectory(path, owner, mode, label);
}

function copyImmutableArtifact(source: string, destination: string, owner: UserOwnership, mode: number, label: string): void {
  assertSourceArtifact(source, label);
  copyFileSync(source, destination);
  ensureTargetOwnership(destination, owner, label);
  chmodSync(destination, mode);
  assertExactOwnedRegularFile(destination, owner, mode, label);
  fsyncFile(destination);
}

function writePrivateFile(path: string, text: string, owner: UserOwnership, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeAll(fd, Buffer.from(text, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  ensureTargetOwnership(path, owner, "Tweakers manager private file");
  chmodSync(path, mode);
  assertExactOwnedRegularFile(path, owner, mode, "Tweakers manager private file");
}

function writeDescriptorAtomically(path: string, text: string, owner: UserOwnership): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${TWEAKERS_MANAGER_ID}.${randomUUID()}.tmp`);
  assertChildPath(directory, temporary, "Tweakers manager descriptor temporary path");
  try {
    const fd = openSync(temporary, "wx", DESCRIPTOR_MODE);
    try {
      writeAll(fd, Buffer.from(text, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    ensureTargetOwnership(temporary, owner, "Tweakers manager descriptor temporary file");
    chmodSync(temporary, DESCRIPTOR_MODE);
    assertExactOwnedRegularFile(temporary, owner, DESCRIPTOR_MODE, "Tweakers manager descriptor temporary file");
    renameSync(temporary, path);
    assertExactOwnedRegularFile(path, owner, DESCRIPTOR_MODE, "Tweakers manager descriptor");
    fsyncDirectory(directory);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

interface DescriptorSnapshot {
  text: string | null;
}

/**
 * Preserve only an exact publisher-owned descriptor. A descriptor is a
 * discovery record, so retaining its original bytes is required to undo a
 * failed outer promotion without interpreting a previous protocol version.
 */
function captureDescriptorSnapshot(path: string, owner: UserOwnership): DescriptorSnapshot {
  try {
    lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return { text: null };
    throw error;
  }
  assertExactOwnedRegularFile(path, owner, DESCRIPTOR_MODE, "Tweakers manager descriptor");
  return { text: readFileSync(path, "utf8") };
}

/**
 * Restore only when the descriptor remains either the old snapshot or the
 * exact bytes just published by this invocation. Any third state is a
 * concurrent or hostile change and must remain untouched for investigation.
 */
function restoreDescriptorSnapshot(
  path: string,
  prior: DescriptorSnapshot,
  publishedText: string,
  owner: UserOwnership,
): void {
  const current = captureDescriptorSnapshot(path, owner);
  if (current.text === prior.text) return;
  if (current.text !== publishedText) {
    throw new Error("Tweakers manager descriptor changed during publication; refusing to overwrite it during rollback");
  }
  if (prior.text === null) {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return;
  }
  writeDescriptorAtomically(path, prior.text, owner);
}

function assertSourceArtifact(path: string, label: string): void {
  const exact = requireExactAbsolutePath(path, `${label} asset`);
  if (!existsSync(exact)) throw new Error(`${label} asset is missing: ${exact}`);
  const stat = lstatSync(exact);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0) {
    throw new Error(`${label} asset must be a non-symlink single-link regular file without set-id bits`);
  }
}

function assertExactOwnedDirectory(path: string, owner: UserOwnership, mode: number, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real non-symlink directory`);
  }
  if (stat.uid !== owner.uid || (stat.mode & 0o7777) !== mode) {
    throw new Error(`${label} must have owner ${owner.uid} and mode ${mode.toString(8)}`);
  }
}

function assertExactOwnedRegularFile(path: string, owner: UserOwnership, mode: number, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real non-symlink single-link regular file`);
  }
  if (stat.uid !== owner.uid || (stat.mode & 0o7777) !== mode || (stat.mode & 0o7000) !== 0) {
    throw new Error(`${label} must have owner ${owner.uid}, mode ${mode.toString(8)}, and no set-id bits`);
  }
}

/** Root/user ownership plus no group/world writable ancestors protects replacement paths. */
function assertSafeAncestors(path: string, owner: UserOwnership, label: string): void {
  let current = path;
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} has a symlink or non-directory ancestor: ${current}`);
    if (stat.uid !== 0 && stat.uid !== owner.uid) throw new Error(`${label} has an ancestor with an unexpected owner: ${current}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} has a group/world writable ancestor: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensureTargetOwnership(path: string, owner: UserOwnership, label: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === 0) chownSync(path, owner.uid, owner.gid);
  const stat = lstatSync(path);
  if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
    throw new Error(`${label} must be owned by target uid/gid ${owner.uid}:${owner.gid}`);
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("Failed to write complete manager publication record");
    offset += written;
  }
}

function assertTargetSeal(seal: TweakersManagerTargetSealV1): void {
  if (seal.managerId !== TWEAKERS_MANAGER_ID || seal.protocolVersion !== MANAGER_PROTOCOL_VERSION) {
    throw new Error("Tweakers manager target seal has an unsupported protocol identity");
  }
  if (!GENERATION_ID.test(seal.generationId)) throw new Error("Tweakers manager target seal generation-id must be lowercase SHA-256");
  for (const [label, value] of [
    ["launcher", seal.launcherSha256],
    ["node", seal.nodeSha256],
    ["manager", seal.managerSha256],
    ["managed-runtime", seal.managedRuntimeFingerprint],
  ] as const) {
    if (!SHA256_HEX.test(value)) throw new Error(`Tweakers manager target seal ${label} digest must be lowercase SHA-256`);
  }
  if (!isAbsolute(seal.nodePath) || resolve(seal.nodePath) !== seal.nodePath || /[\r\n\0]/.test(seal.nodePath)) {
    throw new Error("Tweakers manager target seal node path must be an exact absolute single-line path");
  }
  const expectedGeneration = createTweakersManagerGenerationId({
    managerId: seal.managerId,
    protocolVersion: seal.protocolVersion,
    launcherSha256: seal.launcherSha256,
    nodePath: seal.nodePath,
    nodeSha256: seal.nodeSha256,
    managerSha256: seal.managerSha256,
    managedRuntimeFingerprint: seal.managedRuntimeFingerprint,
  });
  if (seal.generationId !== expectedGeneration) {
    throw new Error("Tweakers manager target seal generation-id does not bind its target identities");
  }
}

function sameTargetSeal(left: TweakersManagerTargetSealV1, right: TweakersManagerTargetSealV1): boolean {
  return left.managerId === right.managerId
    && left.protocolVersion === right.protocolVersion
    && left.generationId === right.generationId
    && left.launcherSha256 === right.launcherSha256
    && left.nodePath === right.nodePath
    && left.nodeSha256 === right.nodeSha256
    && left.managerSha256 === right.managerSha256
    && left.managedRuntimeFingerprint === right.managedRuntimeFingerprint;
}

function assertNoDuplicateTopLevelJsonKeys(text: string): void {
  // The descriptor schema is a flat object. This conservative tokenizer fails
  // closed if a quoted token followed by ':' repeats, including unusual JSON
  // that JSON.parse would otherwise quietly de-duplicate.
  const keys = new Set<string>();
  const keyPattern = /"((?:\\.|[^"\\])*)"\s*:/g;
  for (const match of text.matchAll(keyPattern)) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      throw new Error("Tweakers manager descriptor has an invalid JSON key escape");
    }
    if (keys.has(key)) throw new Error(`Tweakers manager descriptor repeats key ${JSON.stringify(key)}`);
    keys.add(key);
  }
}

function normalizedNow(now: (() => Date | string) | undefined): string {
  const value = now ? now() : new Date();
  const text = value instanceof Date ? value.toISOString() : value;
  if (!RFC3339_TIMESTAMP.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error("Tweakers manager descriptor clock must return RFC3339");
  }
  return text;
}

function requireExactAbsolutePath(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path)) {
    throw new Error(`${label} must be an exact absolute path without control characters`);
  }
  return path;
}

function assertChildPath(parent: string, child: string, label: string): void {
  const result = relative(parent, child);
  if (!result || result.startsWith("..") || isAbsolute(result)) {
    throw new Error(`${label} must be a child of its fixed parent`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function defaultDescriptorRoot(): string {
  const targetHome = targetUserHome() || homedir();
  return join(targetHome, "Library", "Application Support", "Menu Bar", "manager-descriptors");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readManagerSigningPolicy(path: string): { designatedRequirement: string } {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.managerId !== TWEAKERS_MANAGER_ID
    || parsed.protocolVersion !== MANAGER_PROTOCOL_VERSION
    || parsed.executableName !== TWEAKERS_MANAGER_LAUNCHER_NAME
    || parsed.identifier !== "com.therealityreport.tweakers.manager-launcher"
    || parsed.architecture !== "arm64"
    || parsed.certificateCommonName !== "Tweakers Local Signing"
    || typeof parsed.certificateLeafSha1 !== "string"
    || !/^[a-f0-9]{40}$/.test(parsed.certificateLeafSha1)
    || typeof parsed.designatedRequirement !== "string"
    || parsed.designatedRequirement !== `identifier "${parsed.identifier}" and certificate leaf = H"${parsed.certificateLeafSha1}"`) {
    throw new Error("Tweakers Manager signing policy is missing, malformed, or internally inconsistent");
  }
  return { designatedRequirement: parsed.designatedRequirement };
}

function commandOutput(result: ReturnType<typeof spawnSync>): string {
  return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}${result.error?.message ?? ""}`.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

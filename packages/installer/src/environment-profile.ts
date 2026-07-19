import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { signatureInfo, verifySignature, type SignatureInfo } from "./codesign.js";
import { userPaths } from "./paths.js";
import { locateCodexAtExactPath, type CodexInstall } from "./platform.js";
import { readPlist } from "./plist.js";

export const ENVIRONMENT_PROFILE_SCHEMA_VERSION = 1 as const;
export const OPENAI_TEAM_IDENTIFIER = "2DC432GLL2" as const;
export const STABLE_DESKTOP_PATH = "/Applications/ChatGPT.app" as const;
export const ALPHA_DESKTOP_PATH = "/Applications/ChatGPT (Beta).app" as const;

export type EnvironmentId = "stable" | "alpha";
export type AppExperience = "chatgpt" | "tweakers";
export type ReleaseProfile = "stable" | "alpha";
export type BackendLane = "official-bundled" | "bundled" | "managed-alpha";
export type LegacyBackendLane = "bundled" | "beta";

export type EnvironmentBackendChannel = "bundled" | "managed-alpha";

export interface EnvironmentAvailability {
  available: boolean;
  unavailableReasons: string[];
}

export interface EnvironmentProfileRecord {
  selectedDesktopPath: string;
  selectedDesktopBundleId: "com.openai.codex" | "com.openai.codex.beta";
  releaseProfile: ReleaseProfile;
  officialPath: string;
  officialBundleId: "com.openai.codex" | "com.openai.codex.beta";
  officialVersion: string | null;
  officialBuild: string | null;
  strictSignature: boolean;
  gatekeeper: boolean;
  teamIdentifier: string | null;
  designatedRequirement: string | null;
  signatureCheckedAt: string | null;
  officialBackendPath: string;
  officialBackendVersion: string | null;
  officialBackendFingerprint: string | null;
  backendPath: string;
  backendVersion: string | null;
  backendChannel: EnvironmentBackendChannel;
  backendFingerprint: string | null;
  pristineBackupPath: string;
  pristineBackupFingerprint: string | null;
  patchedPayloadPath: string;
  patchedPayloadFingerprint: string | null;
  backendInstallable: boolean;
  patchedPayloadBuildable: boolean;
  availability: Record<AppExperience, EnvironmentAvailability>;
  available: boolean;
  unavailableReasons: string[];
}

export interface EnvironmentSelection {
  selectedDesktopPath: string;
  selectedDesktopBundleId: "com.openai.codex" | "com.openai.codex.beta";
  releaseProfile: ReleaseProfile;
  appExperience: AppExperience;
  backendLane: BackendLane;
  requestedAt: string;
  appliedAt: string | null;
}

export interface EnvironmentProfileRegistry {
  schemaVersion: typeof ENVIRONMENT_PROFILE_SCHEMA_VERSION;
  selected: EnvironmentSelection | null;
  lastKnownWorkingSelection: EnvironmentSelection | null;
  profiles: Record<EnvironmentId, EnvironmentProfileRecord>;
}

export interface CreateEnvironmentProfileRegistryInput {
  stableDesktopPath: string;
  alphaDesktopPath: string;
  environmentRoot?: string;
  selected?: EnvironmentSelection | null;
  lastKnownWorkingSelection?: EnvironmentSelection | null;
  stableEvidence?: EnvironmentProfileEvidenceInput;
  alphaEvidence?: EnvironmentProfileEvidenceInput;
}

export interface EnvironmentProfileEvidenceInput {
  officialVersion?: string | null;
  officialBuild?: string | null;
  strictSignature?: boolean;
  gatekeeper?: boolean;
  teamIdentifier?: string | null;
  designatedRequirement?: string | null;
  signatureCheckedAt?: string | null;
  officialBackendPath?: string;
  officialBackendVersion?: string | null;
  officialBackendFingerprint?: string | null;
  backendPath?: string;
  backendVersion?: string | null;
  backendChannel?: EnvironmentBackendChannel;
  backendFingerprint?: string | null;
  pristineBackupPath?: string;
  pristineBackupFingerprint?: string | null;
  patchedPayloadPath?: string;
  patchedPayloadFingerprint?: string | null;
  backendInstallable?: boolean;
  patchedPayloadBuildable?: boolean;
  unavailableReasons?: string[];
}

export interface LegacyEnvironmentMigrationInput {
  legacyStateFile: string;
  registryFile: string;
  selectionFile: string;
  environmentRoot: string;
  stableDesktopPath?: string;
  alphaDesktopPath?: string;
  now?: string;
  stableEvidence?: EnvironmentProfileEvidenceInput;
  alphaEvidence?: EnvironmentProfileEvidenceInput;
}

export interface LegacyEnvironmentMigrationDeps {
  beforeCommit?: () => void;
  /** Test/recovery seam used to prove a process death between the two promotions. */
  afterRegistryCommit?: () => void;
  /** Test/recovery seam used to prove a process death after both promotions. */
  afterSelectionCommit?: () => void;
}

export interface LoadEnvironmentStateInput extends LegacyEnvironmentMigrationInput {}

export interface LoadEnvironmentStateDeps {
  /** Disable journal replay for pure observation callers. */
  recoverCommit?: boolean;
  inspectProfile?: (
    profile: EnvironmentProfileRecord,
    current: EnvironmentSelection,
  ) => EnvironmentProfileEvidenceInput;
}

export interface LoadedEnvironmentState {
  registry: EnvironmentProfileRegistry;
  current: EnvironmentSelection;
  migratedFromLegacy: boolean;
}

export interface CreateEnvironmentSelectionInput {
  profile: EnvironmentProfileRecord;
  appExperience: AppExperience;
  requestedAt?: string;
  appliedAt?: string | null;
}

export interface LegacyEnvironmentState {
  mode?: unknown;
}

export interface TrustCheckResult {
  ok: boolean;
  output: string;
}

export interface DesignatedRequirementResult extends TrustCheckResult {
  requirement: string | null;
}

export interface EnvironmentProfileValidationDeps {
  locateExact?: (path: string) => Pick<CodexInstall, "appRoot" | "bundleId">;
  verifyStrictSignature?: (path: string) => TrustCheckResult;
  signatureIdentity?: (path: string) => SignatureInfo;
  assessGatekeeper?: (path: string) => TrustCheckResult;
  designatedRequirement?: (path: string) => DesignatedRequirementResult;
}

export interface RegisterAlphaDesktopDeps extends EnvironmentProfileValidationDeps {
  exists?: typeof existsSync;
  readIdentity?: (path: string) => { version: string | null; build: string | null };
  readVersion?: (path: string) => string | null;
  fingerprintFile?: (path: string) => string;
  now?: () => string;
}

export interface ValidatedEnvironmentSelection {
  selection: EnvironmentSelection;
  trust: {
    strictSignature: TrustCheckResult;
    signatureIdentity: SignatureInfo;
    gatekeeper: TrustCheckResult;
    designatedRequirement: DesignatedRequirementResult;
  };
}

export function normalizeBackendLane(value: unknown): BackendLane | null {
  if (value === "official-bundled" || value === "bundled" || value === "managed-alpha") return value;
  if (value === "beta") return "managed-alpha";
  return null;
}

export function createEnvironmentProfileRegistry(
  input: CreateEnvironmentProfileRegistryInput,
): EnvironmentProfileRegistry {
  const environmentRoot = input.environmentRoot ?? userPaths().root;
  const registry: EnvironmentProfileRegistry = {
    schemaVersion: ENVIRONMENT_PROFILE_SCHEMA_VERSION,
    selected: input.selected ?? null,
    lastKnownWorkingSelection: input.lastKnownWorkingSelection ?? null,
    profiles: {
      stable: createEnvironmentProfileRecord({
        selectedDesktopPath: input.stableDesktopPath,
        selectedDesktopBundleId: "com.openai.codex",
        releaseProfile: "stable",
        environmentRoot,
        evidence: input.stableEvidence,
      }),
      alpha: createEnvironmentProfileRecord({
        selectedDesktopPath: input.alphaDesktopPath,
        selectedDesktopBundleId: "com.openai.codex.beta",
        releaseProfile: "alpha",
        environmentRoot,
        evidence: input.alphaEvidence,
      }),
    },
  };
  assertIsolatedEnvironmentArtifacts(registry);
  if (registry.selected !== null && !isEnvironmentSelection(registry.selected)) {
    throw new Error("Environment registry selected value is invalid");
  }
  if (registry.lastKnownWorkingSelection !== null && !isEnvironmentSelection(registry.lastKnownWorkingSelection)) {
    throw new Error("Environment registry last-known-working selection is invalid");
  }
  return registry;
}

function createEnvironmentProfileRecord(input: {
  selectedDesktopPath: string;
  selectedDesktopBundleId: EnvironmentProfileRecord["selectedDesktopBundleId"];
  releaseProfile: ReleaseProfile;
  environmentRoot: string;
  evidence?: EnvironmentProfileEvidenceInput;
}): EnvironmentProfileRecord {
  const channelRoot = join(input.environmentRoot, "environments", input.releaseProfile);
  const expectedBackendChannel: EnvironmentBackendChannel = input.releaseProfile === "stable"
    ? "bundled"
    : "managed-alpha";
  const backendChannel = input.evidence?.backendChannel ?? expectedBackendChannel;
  if (backendChannel !== expectedBackendChannel) {
    throw new Error(`${input.releaseProfile} backend channel must be ${expectedBackendChannel}`);
  }
  const officialBackendPath = join(input.selectedDesktopPath, "Contents", "Resources", "codex");
  const backendPath = input.releaseProfile === "stable"
    ? officialBackendPath
    : join(channelRoot, "backend", "codex");
  if (input.evidence?.officialBackendPath !== undefined
    && input.evidence.officialBackendPath !== officialBackendPath) {
    throw new Error(`${input.releaseProfile} official backend path must remain inside its exact desktop bundle`);
  }
  if (input.evidence?.backendPath !== undefined && input.evidence.backendPath !== backendPath) {
    throw new Error(`${input.releaseProfile} backend path must remain inside its isolated environment channel`);
  }
  const record: EnvironmentProfileRecord = {
    selectedDesktopPath: input.selectedDesktopPath,
    selectedDesktopBundleId: input.selectedDesktopBundleId,
    releaseProfile: input.releaseProfile,
    officialPath: input.selectedDesktopPath,
    officialBundleId: input.selectedDesktopBundleId,
    officialVersion: input.evidence?.officialVersion ?? null,
    officialBuild: input.evidence?.officialBuild ?? null,
    strictSignature: input.evidence?.strictSignature ?? false,
    gatekeeper: input.evidence?.gatekeeper ?? false,
    teamIdentifier: input.evidence?.teamIdentifier ?? null,
    designatedRequirement: input.evidence?.designatedRequirement ?? null,
    signatureCheckedAt: input.evidence?.signatureCheckedAt ?? null,
    officialBackendPath,
    officialBackendVersion: input.evidence?.officialBackendVersion
      ?? input.evidence?.backendVersion
      ?? null,
    officialBackendFingerprint: input.evidence?.officialBackendFingerprint
      ?? (input.releaseProfile === "stable" ? input.evidence?.backendFingerprint : null)
      ?? null,
    backendPath,
    backendVersion: input.evidence?.backendVersion ?? null,
    backendChannel,
    backendFingerprint: input.evidence?.backendFingerprint ?? null,
    pristineBackupPath: input.evidence?.pristineBackupPath ?? join(channelRoot, "pristine", "ChatGPT.app"),
    pristineBackupFingerprint: input.evidence?.pristineBackupFingerprint ?? null,
    patchedPayloadPath: input.evidence?.patchedPayloadPath ?? join(channelRoot, "patched", "ChatGPT.app"),
    patchedPayloadFingerprint: input.evidence?.patchedPayloadFingerprint ?? null,
    backendInstallable: input.evidence?.backendInstallable ?? false,
    patchedPayloadBuildable: input.evidence?.patchedPayloadBuildable ?? false,
    availability: {
      chatgpt: { available: false, unavailableReasons: [] },
      tweakers: { available: false, unavailableReasons: [] },
    },
    available: false,
    unavailableReasons: [],
  };
  record.availability = profileAvailability(record, input.evidence?.unavailableReasons ?? []);
  record.available = record.availability.chatgpt.available || record.availability.tweakers.available;
  record.unavailableReasons = record.available
    ? []
    : uniqueReasons([
      ...record.availability.chatgpt.unavailableReasons,
      ...record.availability.tweakers.unavailableReasons,
    ]);
  return record;
}

function profileAvailability(
  profile: EnvironmentProfileRecord,
  additional: string[],
): Record<AppExperience, EnvironmentAvailability> {
  const common: string[] = [];
  if (!profile.strictSignature
    || !profile.gatekeeper
    || profile.designatedRequirement === null
    || profile.teamIdentifier !== OPENAI_TEAM_IDENTIFIER
    || profile.signatureCheckedAt === null) {
    common.push("OpenAI desktop trust has not been verified");
  }
  if (profile.officialVersion === null || profile.officialBuild === null) {
    common.push("Desktop version or build is unknown");
  }
  const chatgpt = [...common];
  if (profile.officialBackendVersion === null || profile.officialBackendFingerprint === null) {
    chatgpt.push("Official bundled backend is unavailable");
  } else if (profile.releaseProfile === "alpha" && !isAlphaBackendVersion(profile.officialBackendVersion)) {
    chatgpt.push("Official Beta bundled backend is not an Alpha release");
  }
  const tweakers = [...common];
  if (profile.backendVersion === null || profile.backendFingerprint === null) {
    const backendCanBePrepared = profile.releaseProfile === "stable"
      ? profile.patchedPayloadBuildable
      : profile.backendInstallable;
    if (!backendCanBePrepared) {
      tweakers.push(profile.releaseProfile === "stable" ? "Bundled backend is unavailable" : "Managed alpha backend is unavailable");
    }
  } else if (profile.releaseProfile === "alpha" && !isAlphaBackendVersion(profile.backendVersion)) {
    tweakers.push("Managed alpha backend is not an Alpha release");
  }
  if (profile.patchedPayloadFingerprint === null && !profile.patchedPayloadBuildable) {
    tweakers.push("Patched payload is unavailable");
  }
  for (const reason of additional) {
    const trimmed = reason.trim();
    if (trimmed) {
      if (!chatgpt.includes(trimmed)) chatgpt.push(trimmed);
      if (!tweakers.includes(trimmed)) tweakers.push(trimmed);
    }
  }
  return {
    chatgpt: { available: chatgpt.length === 0, unavailableReasons: chatgpt },
    tweakers: { available: tweakers.length === 0, unavailableReasons: tweakers },
  };
}

function isAlphaBackendVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-alpha\.\d+$/.test(version.trim());
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

function profileArtifactLocations(profile: EnvironmentProfileRecord): EnvironmentProfileEvidenceInput {
  return {
    officialBackendPath: profile.officialBackendPath,
    backendPath: profile.backendPath,
    backendChannel: profile.backendChannel,
    pristineBackupPath: profile.pristineBackupPath,
    patchedPayloadPath: profile.patchedPayloadPath,
    backendInstallable: profile.backendInstallable,
    patchedPayloadBuildable: profile.patchedPayloadBuildable,
  };
}

function requestedProfileConfiguration(evidence?: EnvironmentProfileEvidenceInput): EnvironmentProfileEvidenceInput {
  if (!evidence) return {};
  return {
    ...(evidence.officialBackendPath !== undefined ? { officialBackendPath: evidence.officialBackendPath } : {}),
    ...(evidence.backendPath !== undefined ? { backendPath: evidence.backendPath } : {}),
    ...(evidence.backendChannel !== undefined ? { backendChannel: evidence.backendChannel } : {}),
    ...(evidence.pristineBackupPath !== undefined ? { pristineBackupPath: evidence.pristineBackupPath } : {}),
    ...(evidence.patchedPayloadPath !== undefined ? { patchedPayloadPath: evidence.patchedPayloadPath } : {}),
    ...(evidence.backendInstallable !== undefined ? { backendInstallable: evidence.backendInstallable } : {}),
    ...(evidence.patchedPayloadBuildable !== undefined ? { patchedPayloadBuildable: evidence.patchedPayloadBuildable } : {}),
  };
}

export function inspectEnvironmentProfile(
  profile: EnvironmentProfileRecord,
  _current: EnvironmentSelection,
  deps: {
    exists?: typeof existsSync;
    validateOfficial?: typeof validateOfficialEnvironmentProfile;
    readIdentity?: typeof readDesktopProfileIdentity;
    readVersion?: typeof readBinaryVersion;
    fingerprintFile?: typeof fingerprintFile;
    fingerprintApp?: typeof fingerprintAppContents;
  } = {},
): EnvironmentProfileEvidenceInput {
  const pathExists = deps.exists ?? existsSync;
  const validateOfficial = deps.validateOfficial ?? validateOfficialEnvironmentProfile;
  const readIdentity = deps.readIdentity ?? readDesktopProfileIdentity;
  const readVersion = deps.readVersion ?? readBinaryVersion;
  const hashFile = deps.fingerprintFile ?? fingerprintFile;
  const hashApp = deps.fingerprintApp ?? fingerprintAppContents;
  const now = new Date().toISOString();
  const evidence: EnvironmentProfileEvidenceInput = {
    ...profileArtifactLocations(profile),
    pristineBackupFingerprint: pathExists(profile.pristineBackupPath)
      ? hashApp(profile.pristineBackupPath)
      : null,
    patchedPayloadFingerprint: pathExists(profile.patchedPayloadPath)
      ? hashApp(profile.patchedPayloadPath)
      : null,
  };
  const trustFailures: string[] = [];
  let trusted = false;
  for (const trustSource of [...new Set([profile.officialPath, profile.pristineBackupPath])]) {
    if (!pathExists(trustSource)) {
      trustFailures.push(`${trustSource} is missing`);
      continue;
    }
    try {
      const trustSelection: EnvironmentSelection = {
        selectedDesktopPath: trustSource,
        selectedDesktopBundleId: profile.officialBundleId,
        releaseProfile: profile.releaseProfile,
        appExperience: "chatgpt",
        backendLane: "official-bundled",
        requestedAt: now,
        appliedAt: null,
      };
      const validated = validateOfficial(trustSelection);
      const identity = readIdentity(trustSource);
      const officialBackendSource = join(trustSource, "Contents", "Resources", "codex");
      evidence.officialVersion = identity.version;
      evidence.officialBuild = identity.build;
      evidence.strictSignature = validated.trust.strictSignature.ok;
      evidence.gatekeeper = validated.trust.gatekeeper.ok;
      evidence.teamIdentifier = validated.trust.signatureIdentity.teamIdentifier;
      evidence.designatedRequirement = validated.trust.designatedRequirement.requirement;
      evidence.signatureCheckedAt = now;
      evidence.officialBackendVersion = readVersion(officialBackendSource);
      evidence.officialBackendFingerprint = pathExists(officialBackendSource)
        ? hashFile(officialBackendSource)
        : null;
      trusted = true;
      break;
    } catch (error) {
      trustFailures.push(`${trustSource}: ${errorMessage(error)}`);
    }
  }
  if (!trusted) {
    evidence.unavailableReasons = [`Official desktop validation failed: ${trustFailures.join("; ")}`];
  }

  // Support-root executables are user-writable and therefore never run while
  // computing read-only status. Stable can inherit the trusted official
  // backend version only when the support payload's binary is byte-identical;
  // managed Alpha evidence is supplied by its signed manager receipt owner.
  evidence.backendVersion = null;
  evidence.backendFingerprint = null;
  if (profile.backendChannel === "bundled") {
    const backendSource = join(profile.patchedPayloadPath, "Contents", "Resources", "codex");
    if (pathExists(backendSource)) {
      const backendFingerprint = hashFile(backendSource);
      evidence.backendFingerprint = backendFingerprint;
      if (backendFingerprint === evidence.officialBackendFingerprint) {
        evidence.backendVersion = evidence.officialBackendVersion ?? null;
      }
    }
  }
  return evidence;
}

function readDesktopProfileIdentity(appRoot: string): { version: string | null; build: string | null } {
  try {
    const plist = readPlist(join(appRoot, "Contents", "Info.plist"));
    return {
      version: typeof plist.CFBundleShortVersionString === "string" ? plist.CFBundleShortVersionString : null,
      build: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : null,
    };
  } catch {
    return { version: null, build: null };
  }
}

function readBinaryVersion(binaryPath: string): string | null {
  if (!existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.split(/\s+/).at(-1) ?? null;
}

function fingerprintFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Canonical desktop-artifact digest used by both environment registration and
 * environment transactions. Symlink targets are part of the signed app tree,
 * so they must be represented consistently wherever a profile is verified.
 */
export function fingerprintAppContents(appRoot: string): string {
  const root = join(appRoot, "Contents");
  if (!existsSync(root)) return "missing";
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      hash.update(relative(root, path));
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
      else if (entry.isSymbolicLink()) hash.update(`symlink:${readlinkSync(path)}`);
    }
  };
  visit(root);
  return hash.digest("hex");
}

function assertSelectionUsesRegistry(
  selection: EnvironmentSelection,
  registry: EnvironmentProfileRegistry,
): void {
  const profile = registry.profiles[selection.releaseProfile];
  if (selection.selectedDesktopPath !== profile.officialPath
    || selection.selectedDesktopBundleId !== profile.officialBundleId) {
    throw new Error("Current environment selection does not match the recomputed registry");
  }
}

export function defaultEnvironmentProfileRegistry(environmentRoot = userPaths().root): EnvironmentProfileRegistry {
  return createEnvironmentProfileRegistry({
    stableDesktopPath: STABLE_DESKTOP_PATH,
    alphaDesktopPath: ALPHA_DESKTOP_PATH,
    environmentRoot,
  });
}

/** Validate and persist a user-selected official OpenAI Beta bundle without changing selection. */
export function registerAlphaDesktopProfile(
  registry: EnvironmentProfileRegistry,
  alphaDesktopPath: string,
  deps: RegisterAlphaDesktopDeps = {},
): EnvironmentProfileRegistry {
  if (!isAbsolute(alphaDesktopPath) || normalize(alphaDesktopPath) !== alphaDesktopPath || !/\.app$/i.test(alphaDesktopPath)) {
    throw new Error("OpenAI Beta app path must be an exact absolute .app path");
  }
  const existing = registry.profiles.alpha;
  const candidate: EnvironmentProfileRecord = {
    ...existing,
    selectedDesktopPath: alphaDesktopPath,
    officialPath: alphaDesktopPath,
    officialBackendPath: join(alphaDesktopPath, "Contents", "Resources", "codex"),
  };
  const selection: EnvironmentSelection = {
    selectedDesktopPath: alphaDesktopPath,
    selectedDesktopBundleId: "com.openai.codex.beta",
    releaseProfile: "alpha",
    appExperience: "chatgpt",
    backendLane: "official-bundled",
    requestedAt: deps.now?.() ?? new Date().toISOString(),
    appliedAt: null,
  };
  const validated = validateOfficialEnvironmentProfile(selection, deps);
  const identity = validated.trust.signatureIdentity;
  const backendPath = candidate.officialBackendPath;
  const readIdentity = deps.readIdentity ?? readDesktopProfileIdentity;
  const readVersion = deps.readVersion ?? readBinaryVersion;
  const fingerprint = deps.fingerprintFile ?? fingerprintFile;
  const pathExists = deps.exists ?? existsSync;
  const desktop = readIdentity(alphaDesktopPath);
  const backendVersion = readVersion(backendPath);
  const backendFingerprint = pathExists(backendPath) ? fingerprint(backendPath) : null;
  if (!backendVersion || !backendFingerprint || !isAlphaBackendVersion(backendVersion)) {
    throw new Error("OpenAI Beta bundled backend is missing or is not an Alpha release");
  }
  const evidence: EnvironmentProfileEvidenceInput = {
    ...profileArtifactLocations(existing),
    officialVersion: desktop.version,
    officialBuild: desktop.build,
    strictSignature: validated.trust.strictSignature.ok,
    gatekeeper: validated.trust.gatekeeper.ok,
    teamIdentifier: identity.teamIdentifier,
    designatedRequirement: validated.trust.designatedRequirement.requirement,
    signatureCheckedAt: deps.now?.() ?? new Date().toISOString(),
    officialBackendPath: backendPath,
    officialBackendVersion: backendVersion,
    officialBackendFingerprint: backendFingerprint,
  };
  const environmentRoot = dirname(dirname(dirname(dirname(existing.backendPath))));
  const next = createEnvironmentProfileRegistry({
    stableDesktopPath: registry.profiles.stable.officialPath,
    alphaDesktopPath,
    environmentRoot,
    selected: registry.selected,
    lastKnownWorkingSelection: registry.lastKnownWorkingSelection,
    stableEvidence: profileArtifactLocations(registry.profiles.stable),
    alphaEvidence: evidence,
  });
  return next;
}

export function resolveEnvironmentProfile(
  registry: EnvironmentProfileRegistry,
  releaseProfile: EnvironmentId,
): EnvironmentProfileRecord {
  const profile = registry.profiles[releaseProfile];
  if (!profile) throw new Error(`Unknown environment release profile: ${releaseProfile}`);
  return profile;
}

export function createEnvironmentSelection(
  input: CreateEnvironmentSelectionInput,
): EnvironmentSelection {
  const backendLane = deriveBackendLane(input.appExperience, input.profile.releaseProfile);
  return {
    selectedDesktopPath: input.profile.selectedDesktopPath,
    selectedDesktopBundleId: input.profile.selectedDesktopBundleId,
    releaseProfile: input.profile.releaseProfile,
    appExperience: input.appExperience,
    backendLane,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    appliedAt: input.appliedAt ?? null,
  };
}

export function deriveBackendLane(
  appExperience: AppExperience,
  releaseProfile: ReleaseProfile,
): BackendLane {
  return appExperience === "chatgpt"
    ? "official-bundled"
    : releaseProfile === "stable"
      ? "bundled"
      : "managed-alpha";
}

export function migrateLegacyEnvironmentSelection(
  legacy: LegacyEnvironmentState,
  registry: EnvironmentProfileRegistry = defaultEnvironmentProfileRegistry(),
  now = new Date().toISOString(),
): EnvironmentSelection {
  if (legacy.mode !== "chatgpt" && legacy.mode !== "tweakers") {
    throw new Error("Legacy environment state has no valid app mode");
  }
  return createEnvironmentSelection({
    profile: resolveEnvironmentProfile(registry, "stable"),
    appExperience: legacy.mode,
    requestedAt: now,
    appliedAt: now,
  });
}

/**
 * Read and recompute today's environment truth without publishing anything.
 * When schema-1 state does not exist, the current stable selection is derived
 * in memory from the legacy mode byte; callers persist only after a verified
 * commit via publishEnvironmentSelection.
 */
export function loadEnvironmentState(
  input: LoadEnvironmentStateInput,
  deps: LoadEnvironmentStateDeps = {},
): LoadedEnvironmentState {
  if (deps.recoverCommit !== false) {
    recoverEnvironmentDocumentCommit(input.registryFile, input.selectionFile);
  }
  const observedCommit = deps.recoverCommit === false
    ? readEnvironmentDocumentCommit(input.registryFile, input.selectionFile)
    : null;
  const stableDesktopPath = input.stableDesktopPath ?? STABLE_DESKTOP_PATH;
  const alphaDesktopPath = input.alphaDesktopPath ?? ALPHA_DESKTOP_PATH;
  const now = input.now ?? new Date().toISOString();
  const persistedRegistry = observedCommit?.registry
    ?? readEnvironmentProfileRegistry(input.registryFile);
  // A registered Alpha/Beta bundle is user-owned truth. Preserve its exact
  // absolute path across every recomputation; callers may provide the legacy
  // default only as the seed when no registry exists yet.
  const effectiveStableDesktopPath = persistedRegistry?.profiles.stable.officialPath ?? stableDesktopPath;
  const effectiveAlphaDesktopPath = persistedRegistry?.profiles.alpha.officialPath ?? alphaDesktopPath;
  const seed = persistedRegistry ?? createEnvironmentProfileRegistry({
    stableDesktopPath: effectiveStableDesktopPath,
    alphaDesktopPath: effectiveAlphaDesktopPath,
    environmentRoot: input.environmentRoot,
    stableEvidence: {
      ...requestedProfileConfiguration(input.stableEvidence),
      pristineBackupPath: join(input.environmentRoot, "backup", "Codex.app"),
      patchedPayloadPath: join(input.environmentRoot, "mode", "patched-payload", "ChatGPT.app"),
    },
    alphaEvidence: requestedProfileConfiguration(input.alphaEvidence),
  });
  const base = createEnvironmentProfileRegistry({
    stableDesktopPath: effectiveStableDesktopPath,
    alphaDesktopPath: effectiveAlphaDesktopPath,
    environmentRoot: input.environmentRoot,
    selected: seed.selected,
    lastKnownWorkingSelection: seed.lastKnownWorkingSelection,
    stableEvidence: {
      ...profileArtifactLocations(seed.profiles.stable),
      ...requestedProfileConfiguration(input.stableEvidence),
    },
    alphaEvidence: {
      ...profileArtifactLocations(seed.profiles.alpha),
      ...requestedProfileConfiguration(input.alphaEvidence),
    },
  });
  const persistedSelection = observedCommit?.selection
    ?? readEnvironmentSelection(input.selectionFile);
  if (persistedSelection !== null && persistedRegistry === null) {
    throw new Error("Environment selection exists without its profile registry");
  }
  if (persistedSelection !== null
    && (persistedRegistry!.selected === null || !environmentSelectionsMatch(persistedSelection, persistedRegistry!.selected))) {
    throw new Error("Environment selection does not match the profile registry selected value");
  }
  let current = persistedSelection;
  let migratedFromLegacy = false;
  if (current === null) {
    let legacy: LegacyEnvironmentState;
    try {
      legacy = JSON.parse(readFileSync(input.legacyStateFile, "utf8")) as LegacyEnvironmentState;
    } catch (error) {
      throw new Error(`Legacy environment state is unreadable at ${input.legacyStateFile}: ${errorMessage(error)}`);
    }
    current = migrateLegacyEnvironmentSelection(legacy, base, now);
    migratedFromLegacy = true;
  }

  const inspect = deps.inspectProfile ?? ((profile: EnvironmentProfileRecord) => inspectEnvironmentProfile(profile, current!));
  const stableEvidence = {
    ...profileArtifactLocations(base.profiles.stable),
    ...inspect(base.profiles.stable, current),
  };
  const alphaEvidence = {
    ...profileArtifactLocations(base.profiles.alpha),
    ...inspect(base.profiles.alpha, current),
  };
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: effectiveStableDesktopPath,
    alphaDesktopPath: effectiveAlphaDesktopPath,
    environmentRoot: input.environmentRoot,
    selected: current,
    lastKnownWorkingSelection: persistedRegistry?.lastKnownWorkingSelection ?? current,
    stableEvidence,
    alphaEvidence,
  });
  assertSelectionUsesRegistry(current, registry);
  return { registry, current, migratedFromLegacy };
}

function environmentSelectionsMatch(first: EnvironmentSelection, second: EnvironmentSelection): boolean {
  return first.selectedDesktopPath === second.selectedDesktopPath
    && first.selectedDesktopBundleId === second.selectedDesktopBundleId
    && first.releaseProfile === second.releaseProfile
    && first.appExperience === second.appExperience
    && first.backendLane === second.backendLane
    && first.requestedAt === second.requestedAt
    && first.appliedAt === second.appliedAt;
}

export function createRequestedEnvironmentSelection(
  registry: EnvironmentProfileRegistry,
  requested: { appExperience: AppExperience; releaseProfile: ReleaseProfile },
  requestedAt = new Date().toISOString(),
): EnvironmentSelection {
  const profile = resolveEnvironmentProfile(registry, requested.releaseProfile);
  const availability = profile.availability[requested.appExperience];
  if (!availability.available) {
    throw new Error(
      `${requested.releaseProfile}/${requested.appExperience} environment is unavailable: ${availability.unavailableReasons.join("; ")}`,
    );
  }
  return createEnvironmentSelection({
    profile,
    appExperience: requested.appExperience,
    requestedAt,
    appliedAt: null,
  });
}

/**
 * Create schema-1 environment state from the legacy mode byte without moving,
 * deleting, or rewriting any legacy state or artifact. Both new documents are
 * staged and validated before either final path is promoted; synchronous
 * promotion failures restore the exact bytes that were present beforehand.
 */
export function migrateLegacyEnvironmentFiles(
  input: LegacyEnvironmentMigrationInput,
  deps: LegacyEnvironmentMigrationDeps = {},
): { registry: EnvironmentProfileRegistry; selection: EnvironmentSelection } {
  recoverEnvironmentDocumentCommit(input.registryFile, input.selectionFile);
  const legacyBytes = readFileSync(input.legacyStateFile, "utf8");
  let legacy: LegacyEnvironmentState;
  try {
    legacy = JSON.parse(legacyBytes) as LegacyEnvironmentState;
  } catch (error) {
    throw new Error(`Legacy environment state is unreadable at ${input.legacyStateFile}: ${errorMessage(error)}`);
  }
  const now = input.now ?? new Date().toISOString();
  const stableDesktopPath = input.stableDesktopPath ?? STABLE_DESKTOP_PATH;
  const alphaDesktopPath = input.alphaDesktopPath ?? ALPHA_DESKTOP_PATH;
  const base = createEnvironmentProfileRegistry({
    stableDesktopPath,
    alphaDesktopPath,
    environmentRoot: input.environmentRoot,
    stableEvidence: {
      ...input.stableEvidence,
      // Point at the existing stores. Migration deliberately leaves their
      // bytes in place so old mode tooling remains a usable rollback path.
      pristineBackupPath: input.stableEvidence?.pristineBackupPath
        ?? join(input.environmentRoot, "backup", "Codex.app"),
      patchedPayloadPath: input.stableEvidence?.patchedPayloadPath
        ?? join(input.environmentRoot, "mode", "patched-payload", "ChatGPT.app"),
    },
    alphaEvidence: input.alphaEvidence,
  });
  const selection = migrateLegacyEnvironmentSelection(legacy, base, now);
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath,
    alphaDesktopPath,
    environmentRoot: input.environmentRoot,
    selected: selection,
    lastKnownWorkingSelection: selection,
    stableEvidence: {
      ...input.stableEvidence,
      pristineBackupPath: input.stableEvidence?.pristineBackupPath
        ?? join(input.environmentRoot, "backup", "Codex.app"),
      patchedPayloadPath: input.stableEvidence?.patchedPayloadPath
        ?? join(input.environmentRoot, "mode", "patched-payload", "ChatGPT.app"),
    },
    alphaEvidence: input.alphaEvidence,
  });
  commitEnvironmentDocumentsAtomically(input.registryFile, registry, input.selectionFile, selection, deps);
  return { registry, selection };
}

/**
 * Validate the selected desktop at its concrete path. There is intentionally
 * no discovery fallback: an unavailable or untrusted alpha desktop is a hard
 * failure, and stable follows the same trust contract.
 */
export function validateOfficialEnvironmentProfile(
  selection: EnvironmentSelection,
  deps: EnvironmentProfileValidationDeps = {},
): ValidatedEnvironmentSelection {
  if (!isEnvironmentSelection(selection)) {
    throw new Error("Official environment selection is invalid");
  }
  const appPath = selection.selectedDesktopPath;
  if (selection.backendLane !== deriveBackendLane(selection.appExperience, selection.releaseProfile)) {
    throw new Error("Environment selection backend lane does not match its app experience and release profile");
  }
  if (!isAbsolute(appPath) || normalize(appPath) !== appPath) {
    throw new Error(`Environment desktop path must be an exact absolute path: ${appPath}`);
  }

  const located = (deps.locateExact ?? locateCodexAtExactPath)(appPath);
  if (located.appRoot !== appPath) {
    throw new Error(`Environment desktop resolved to a different path: expected ${appPath}, got ${located.appRoot}`);
  }
  if (located.bundleId !== selection.selectedDesktopBundleId) {
    throw new Error(
      `Environment desktop bundle mismatch at ${appPath}: expected ${selection.selectedDesktopBundleId}, got ${located.bundleId ?? "unknown"}`,
    );
  }

  const strictSignature = (deps.verifyStrictSignature ?? verifySignature)(appPath);
  if (!strictSignature.ok) {
    throw new Error(`Environment desktop strict signature verification failed at ${appPath}: ${strictSignature.output}`);
  }

  const identity = (deps.signatureIdentity ?? signatureInfo)(appPath);
  if (!identity.ok || identity.adHoc || identity.teamIdentifier !== OPENAI_TEAM_IDENTIFIER) {
    throw new Error(
      `Environment desktop is not signed by OpenAI Team ${OPENAI_TEAM_IDENTIFIER} at ${appPath}`,
    );
  }
  if (!identity.authority.some((authority) => /^Developer ID Application: OpenAI\b/.test(authority))) {
    throw new Error(`Environment desktop is missing the OpenAI Developer ID authority at ${appPath}`);
  }

  const gatekeeper = (deps.assessGatekeeper ?? assessGatekeeper)(appPath);
  if (!gatekeeper.ok) {
    throw new Error(`Environment desktop failed Gatekeeper assessment at ${appPath}: ${gatekeeper.output}`);
  }

  const requirement = (deps.designatedRequirement ?? readDesignatedRequirement)(appPath);
  if (!requirement.ok || requirement.requirement === null || !requirementBindsSelection(requirement.requirement, selection)) {
    throw new Error(`Environment desktop designated requirement is not pinned to OpenAI at ${appPath}`);
  }

  return {
    selection,
    trust: {
      strictSignature,
      signatureIdentity: identity,
      gatekeeper,
      designatedRequirement: requirement,
    },
  };
}

/** @deprecated Use validateOfficialEnvironmentProfile for OpenAI-owned desktop trust. */
export const validateEnvironmentSelection = validateOfficialEnvironmentProfile;

function assessGatekeeper(appPath: string): TrustCheckResult {
  const result = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function readDesignatedRequirement(appPath: string): DesignatedRequirementResult {
  const result = spawnSync("codesign", ["-dr", "-", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const requirement = output.split(/\r?\n/).find((line) => line.trim().startsWith("designated =>"))?.trim() ?? null;
  return { ok: result.status === 0 && requirement !== null, requirement, output };
}

function requirementBindsSelection(
  requirement: string,
  selection: EnvironmentSelection,
): boolean {
  return requirement.includes(`identifier "${selection.selectedDesktopBundleId}"`)
    && requirement.includes("anchor apple generic")
    && new RegExp(`certificate leaf\\[subject\\.OU\\]\\s*=\\s*"?${OPENAI_TEAM_IDENTIFIER}"?`).test(requirement);
}

export function readEnvironmentProfileRegistry(
  file: string,
): EnvironmentProfileRegistry | null {
  const legacyFile = basename(file) === "environment-registry.json"
    ? join(dirname(file), "environment-profiles.json")
    : null;
  const sourceFile = existsSync(file) ? file : legacyFile && existsSync(legacyFile) ? legacyFile : null;
  if (sourceFile === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(sourceFile, "utf8"));
  } catch (error) {
    throw new Error(`Environment profile registry is unreadable at ${sourceFile}: ${errorMessage(error)}`);
  }
  if (!isEnvironmentProfileRegistry(value)) {
    throw new Error(`Environment profile registry is invalid at ${sourceFile}`);
  }
  return value;
}

export function writeEnvironmentProfileRegistry(
  file: string,
  registry: EnvironmentProfileRegistry,
): void {
  if (!isEnvironmentProfileRegistry(registry)) {
    throw new Error("Refusing to write an invalid environment profile registry");
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    fsyncDirectory(dirname(file));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

function commitEnvironmentDocumentsAtomically(
  registryFile: string,
  registry: EnvironmentProfileRegistry,
  selectionFile: string,
  selection: EnvironmentSelection,
  deps: LegacyEnvironmentMigrationDeps,
): void {
  if (!isEnvironmentProfileRegistry(registry) || !isEnvironmentSelection(selection)) {
    throw new Error("Refusing to migrate invalid environment state");
  }
  recoverEnvironmentDocumentCommit(registryFile, selectionFile);
  const registryBefore = existsSync(registryFile) ? readFileSync(registryFile) : null;
  const selectionBefore = existsSync(selectionFile) ? readFileSync(selectionFile) : null;
  const registryTemporary = stageJson(registryFile, registry);
  const selectionTemporary = stageJson(selectionFile, selection);
  const journalFile = environmentCommitJournalFile(registryFile);
  writeEnvironmentCommitJournal(journalFile, registryFile, registry, selectionFile, selection);
  let registryPromoted = false;
  let selectionPromoted = false;
  try {
    deps.beforeCommit?.();
    renameSync(registryTemporary, registryFile);
    registryPromoted = true;
    chmodSync(registryFile, 0o600);
    fsyncDirectory(dirname(registryFile));
    deps.afterRegistryCommit?.();
    renameSync(selectionTemporary, selectionFile);
    selectionPromoted = true;
    chmodSync(selectionFile, 0o600);
    fsyncDirectory(dirname(selectionFile));
    deps.afterSelectionCommit?.();
    rmSync(journalFile, { force: true });
    fsyncDirectory(dirname(registryFile));
  } catch (error) {
    let rollbackError: unknown = null;
    try {
      if (selectionPromoted) restoreExactBytes(selectionFile, selectionBefore);
      if (registryPromoted) restoreExactBytes(registryFile, registryBefore);
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    // The journal is removed only after a complete rollback is durable.  If
    // rollback itself fails, leave the journal in place so startup recovery
    // can still finish the intended pair instead of acknowledging a partial,
    // journal-less state.
    if (rollbackError === null) {
      rmSync(journalFile, { force: true });
      fsyncDirectory(dirname(journalFile));
    }
    throw error;
  } finally {
    rmSync(registryTemporary, { force: true });
    rmSync(selectionTemporary, { force: true });
  }
}

export interface EnvironmentCommitJournal {
  schemaVersion: 1;
  kind: "environment-state-commit";
  registryFile: string;
  selectionFile: string;
  registry: EnvironmentProfileRegistry;
  selection: EnvironmentSelection;
}

export function environmentCommitJournalFile(registryFile: string): string {
  return join(dirname(registryFile), "environment-state-commit.json");
}

/** Read and validate an interrupted document commit without replaying it. */
export function readEnvironmentDocumentCommit(
  registryFile: string,
  selectionFile: string,
): EnvironmentCommitJournal | null {
  const journalFile = environmentCommitJournalFile(registryFile);
  if (!existsSync(journalFile)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(journalFile, "utf8"));
  } catch (error) {
    throw new Error(`Environment state commit journal is unreadable at ${journalFile}: ${errorMessage(error)}`);
  }
  const journal = value as Partial<EnvironmentCommitJournal>;
  if (journal.schemaVersion !== 1
    || journal.kind !== "environment-state-commit"
    || journal.registryFile !== registryFile
    || journal.selectionFile !== selectionFile
    || !isEnvironmentProfileRegistry(journal.registry)
    || !isEnvironmentSelection(journal.selection)
    || journal.registry.selected === null
    || !environmentSelectionsMatch(journal.registry.selected, journal.selection)) {
    throw new Error(`Environment state commit journal is invalid at ${journalFile}`);
  }
  return journal as EnvironmentCommitJournal;
}

function writeEnvironmentCommitJournal(
  journalFile: string,
  registryFile: string,
  registry: EnvironmentProfileRegistry,
  selectionFile: string,
  selection: EnvironmentSelection,
): void {
  const journal: EnvironmentCommitJournal = {
    schemaVersion: 1,
    kind: "environment-state-commit",
    registryFile,
    selectionFile,
    registry,
    selection,
  };
  const staged = stageJson(journalFile, journal);
  renameSync(staged, journalFile);
  chmodSync(journalFile, 0o600);
  fsyncDirectory(dirname(journalFile));
}

/** Complete an interrupted registry+selection publication from its journal. */
export function recoverEnvironmentDocumentCommit(
  registryFile: string,
  selectionFile: string,
): boolean {
  const journalFile = environmentCommitJournalFile(registryFile);
  const journal = readEnvironmentDocumentCommit(registryFile, selectionFile);
  if (journal === null) return false;
  writeEnvironmentProfileRegistry(registryFile, journal.registry);
  writeEnvironmentSelection(selectionFile, journal.selection);
  const recoveredRegistry = readEnvironmentProfileRegistry(registryFile);
  const recoveredSelection = readEnvironmentSelection(selectionFile);
  if (recoveredRegistry === null || recoveredRegistry.selected === null || recoveredSelection === null
    || !environmentSelectionsMatch(recoveredRegistry.selected, recoveredSelection)) {
    throw new Error("Environment state commit journal recovery could not verify the published pair");
  }
  rmSync(journalFile, { force: true });
  fsyncDirectory(dirname(journalFile));
  return true;
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stageJson(file: string, value: object): string {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temporary;
}

function restoreExactBytes(file: string, bytes: Buffer | null): void {
  if (bytes === null) {
    rmSync(file, { force: true });
    fsyncDirectory(dirname(file));
    return;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.restore`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  fsyncDirectory(dirname(file));
}

export function readEnvironmentSelection(file: string): EnvironmentSelection | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Environment selection is unreadable at ${file}: ${errorMessage(error)}`);
  }
  const normalized = normalizeEnvironmentSelection(value);
  if (normalized === null) throw new Error(`Environment selection is invalid at ${file}`);
  return normalized;
}

export function writeEnvironmentSelection(file: string, selection: EnvironmentSelection): void {
  if (!isEnvironmentSelection(selection)) throw new Error("Refusing to write an invalid environment selection");
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    fsyncDirectory(dirname(file));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

/** Publish one verified selection to both schema-1 documents as one rollback-safe pair. */
export function publishEnvironmentSelection(
  registryFile: string,
  selectionFile: string,
  selection: EnvironmentSelection,
): EnvironmentProfileRegistry {
  recoverEnvironmentDocumentCommit(registryFile, selectionFile);
  const existing = readEnvironmentProfileRegistry(registryFile);
  if (existing === null) throw new Error(`Environment profile registry is missing at ${registryFile}`);
  const registry: EnvironmentProfileRegistry = {
    ...existing,
    selected: selection,
    lastKnownWorkingSelection: selection,
  };
  commitEnvironmentDocumentsAtomically(registryFile, registry, selectionFile, selection, {});
  return registry;
}

export function isEnvironmentSelection(value: unknown): value is EnvironmentSelection {
  if (!isRecord(value)) return false;
  if (value.appExperience !== "chatgpt" && value.appExperience !== "tweakers") return false;
  if (value.releaseProfile !== "stable" && value.releaseProfile !== "alpha") return false;
  const expectedBundle = value.releaseProfile === "stable" ? "com.openai.codex" : "com.openai.codex.beta";
  return typeof value.selectedDesktopPath === "string"
    && isAbsolute(value.selectedDesktopPath)
    && normalize(value.selectedDesktopPath) === value.selectedDesktopPath
    && value.selectedDesktopBundleId === expectedBundle
    && value.backendLane === deriveBackendLane(value.appExperience, value.releaseProfile)
    && typeof value.requestedAt === "string"
    && Number.isFinite(Date.parse(value.requestedAt))
    && (value.appliedAt === null
      || (typeof value.appliedAt === "string" && Number.isFinite(Date.parse(value.appliedAt))));
}

function normalizeEnvironmentSelection(value: unknown): EnvironmentSelection | null {
  if (!isRecord(value)) return null;
  const backendLane = normalizeBackendLane(value.backendLane);
  if (backendLane === null) return null;
  const normalized = { ...value, backendLane };
  return isEnvironmentSelection(normalized) ? normalized : null;
}

function isEnvironmentProfileRegistry(value: unknown): value is EnvironmentProfileRegistry {
  if (!isRecord(value) || value.schemaVersion !== ENVIRONMENT_PROFILE_SCHEMA_VERSION || !isRecord(value.profiles)) {
    return false;
  }
  if (value.selected !== null && !isEnvironmentSelection(value.selected)) return false;
  if (value.lastKnownWorkingSelection !== null && !isEnvironmentSelection(value.lastKnownWorkingSelection)) return false;
  if (!isEnvironmentProfileRecord(value.profiles.stable, "stable", "com.openai.codex")
    || !isEnvironmentProfileRecord(value.profiles.alpha, "alpha", "com.openai.codex.beta")) return false;
  try {
    assertIsolatedEnvironmentArtifacts(value as unknown as EnvironmentProfileRegistry);
    return true;
  } catch {
    return false;
  }
}

function isEnvironmentProfileRecord(
  value: unknown,
  releaseProfile: ReleaseProfile,
  bundleId: EnvironmentProfileRecord["selectedDesktopBundleId"],
): value is EnvironmentProfileRecord {
  return isRecord(value)
    && typeof value.selectedDesktopPath === "string"
    && isAbsolute(value.selectedDesktopPath)
    && normalize(value.selectedDesktopPath) === value.selectedDesktopPath
    && value.selectedDesktopBundleId === bundleId
    && value.releaseProfile === releaseProfile
    && value.officialPath === value.selectedDesktopPath
    && value.officialBundleId === bundleId
    && nullableNonEmpty(value.officialVersion)
    && nullableNonEmpty(value.officialBuild)
    && typeof value.strictSignature === "boolean"
    && typeof value.gatekeeper === "boolean"
    && nullableNonEmpty(value.teamIdentifier)
    && nullableNonEmpty(value.designatedRequirement)
    && nullableIso(value.signatureCheckedAt)
    && exactAbsolutePath(value.officialBackendPath)
    && nullableNonEmpty(value.officialBackendVersion)
    && nullableNonEmpty(value.officialBackendFingerprint)
    && exactAbsolutePath(value.backendPath)
    && nullableNonEmpty(value.backendVersion)
    && value.backendChannel === (releaseProfile === "stable" ? "bundled" : "managed-alpha")
    && nullableNonEmpty(value.backendFingerprint)
    && exactAbsolutePath(value.pristineBackupPath)
    && nullableNonEmpty(value.pristineBackupFingerprint)
    && exactAbsolutePath(value.patchedPayloadPath)
    && nullableNonEmpty(value.patchedPayloadFingerprint)
    && typeof value.backendInstallable === "boolean"
    && typeof value.patchedPayloadBuildable === "boolean"
    && isAvailabilityByExperience(value.availability)
    && typeof value.available === "boolean"
    && Array.isArray(value.unavailableReasons)
    && value.unavailableReasons.every((reason) => typeof reason === "string" && reason.trim().length > 0)
    && value.available === (value.unavailableReasons.length === 0);
}

function assertIsolatedEnvironmentArtifacts(registry: EnvironmentProfileRegistry): void {
  const stable = registry.profiles.stable;
  const alpha = registry.profiles.alpha;
  const stablePaths = [
    stable.officialPath,
    stable.officialBackendPath,
    stable.backendPath,
    stable.pristineBackupPath,
    stable.patchedPayloadPath,
  ];
  const alphaPaths = [
    alpha.officialPath,
    alpha.officialBackendPath,
    alpha.backendPath,
    alpha.pristineBackupPath,
    alpha.patchedPayloadPath,
  ];
  for (const stablePath of stablePaths) {
    for (const alphaPath of alphaPaths) {
      if (normalize(stablePath) === normalize(alphaPath)) {
        throw new Error(`Stable and Alpha must not share artifact path ${stablePath}`);
      }
    }
  }
}

function isAvailabilityByExperience(value: unknown): value is Record<AppExperience, EnvironmentAvailability> {
  if (!isRecord(value)) return false;
  return isEnvironmentAvailability(value.chatgpt) && isEnvironmentAvailability(value.tweakers);
}

function isEnvironmentAvailability(value: unknown): value is EnvironmentAvailability {
  return isRecord(value)
    && typeof value.available === "boolean"
    && Array.isArray(value.unavailableReasons)
    && value.unavailableReasons.every((reason) => typeof reason === "string" && reason.trim().length > 0)
    && value.available === (value.unavailableReasons.length === 0);
}

function exactAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value;
}

function nullableNonEmpty(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function nullableIso(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

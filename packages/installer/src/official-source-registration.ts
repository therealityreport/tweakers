/**
 * Immutable, manager-owned copies of the currently verified stable ChatGPT
 * application.  This authority is intentionally separate from the
 * environment-mode cache: a normal official-mode installation has no inactive
 * ChatGPT role, and an independent Tweakers rebuild must never borrow a live
 * app or a historical mode-switch payload as a substitute.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { readFileInAsar, readHeaderHash } from "./asar.js";
import {
  createEnvironmentProfileRegistry,
  createEnvironmentSelection,
  isEnvironmentSelectionHealthy,
  isPristineOpenAiRecoveryEnvironment,
  publishEnvironmentSnapshot,
  readEnvironmentDocumentCommit,
  readEnvironmentProfileRegistry,
  readEnvironmentSelection,
  validateOfficialEnvironmentProfile,
  type EnvironmentProfileEvidenceInput,
  type EnvironmentProfileRecord,
  type EnvironmentProfileRegistry,
  type EnvironmentSelection,
} from "./environment-profile.js";
import { isMacOsJunkName } from "./fs-copy.js";
import { TWEAKERS_MANAGER_ID, type ManagerResolvedExecutableIdentityV1 } from "./manager-contract.js";
import { parseManagerStrictJsonObject } from "./manager-strict-json.js";
import { readPlist } from "./plist.js";
import { acquireProcessLock, type ProcessLock } from "./process-lock.js";
import { STABLE_DESKTOP_PATH } from "./environment-profile.js";
import { cloneAppTree } from "./transaction.js";

export const OFFICIAL_SOURCE_SCHEMA_VERSION = 1 as const;
export const OFFICIAL_SOURCE_KIND = "tweakers-stable-official-source" as const;
export const OFFICIAL_SOURCE_POINTER_KIND = "tweakers-stable-official-source-current" as const;
export const OFFICIAL_SOURCE_TRANSACTION_KIND = "tweakers-stable-official-source-registration" as const;
export const OFFICIAL_SOURCE_APP_NAME = "ChatGPT.app" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface OfficialSourcePaths {
  root: string;
  sourceRoot: string;
  generationsRoot: string;
  stagingRoot: string;
  currentFile: string;
  lockFile: string;
  transactionFile: string;
  environmentRegistryFile: string;
  environmentSelectionFile: string;
}

export interface OfficialSourcePathIdentity {
  dev: number;
  ino: number;
  ctimeMs: number;
}

/** A normalized complete tree/stat seal.  It deliberately excludes Finder
 * junk because cloneAppTree excludes it too and Apple signatures do not cover
 * it. */
export interface OfficialSourceTreeSeal {
  sha256: string;
  entries: number;
  bytes: string;
}

export interface OfficialSourceTrust {
  strictSignature: true;
  gatekeeper: true;
  teamIdentifier: "2DC432GLL2";
  designatedRequirement: string;
  authorities: readonly string[];
}

export interface OfficialSourceObservation {
  appPath: string;
  physicalPath: string;
  rootIdentity: OfficialSourcePathIdentity;
  bundleId: "com.openai.codex";
  version: string;
  build: string;
  appAsarHeaderHash: string;
  marker: "absent";
  treeSeal: OfficialSourceTreeSeal;
  trust: OfficialSourceTrust;
}

export interface RegisteredOfficialSourceReceipt {
  schemaVersion: typeof OFFICIAL_SOURCE_SCHEMA_VERSION;
  kind: typeof OFFICIAL_SOURCE_KIND;
  generationId: string;
  operationId: string;
  registeredAt: string;
  source: OfficialSourceObservation;
  artifact: {
    appPath: string;
    physicalPath: string;
    rootIdentity: OfficialSourcePathIdentity;
    treeSeal: OfficialSourceTreeSeal;
  };
  manager: {
    id: typeof TWEAKERS_MANAGER_ID;
    executablePath: string;
    executableSha256: string;
  };
}

export interface OfficialSourceCurrentPointer {
  schemaVersion: typeof OFFICIAL_SOURCE_SCHEMA_VERSION;
  kind: typeof OFFICIAL_SOURCE_POINTER_KIND;
  generationId: string;
  receiptDigest: string;
  appPath: string;
  version: string;
  build: string;
  sourceDigest: string;
  publishedAt: string;
}

export interface OfficialSourceRegistrationTransaction {
  schemaVersion: typeof OFFICIAL_SOURCE_SCHEMA_VERSION;
  kind: typeof OFFICIAL_SOURCE_TRANSACTION_KIND;
  operationId: string;
  sourceDigest: string;
  generationId: string | null;
  receiptDigest: string | null;
  phase: "preparing" | "published" | "completed" | "recovery-required" | "failed";
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export type RegisteredOfficialSourceState = "missing" | "ready" | "stale" | "malformed" | "unreadable";

export interface RegisteredOfficialSourceStatus {
  state: RegisteredOfficialSourceState;
  generationId: string | null;
  receiptDigest: string | null;
  artifactPath: string | null;
  version: string | null;
  build: string | null;
  /** A fresh strict observation of the fixed live app, when one exists. */
  candidateDigest: string | null;
  sourceDigest: string | null;
  revision: string;
  problem: string | null;
}

export interface OfficialSourceMetadataProjection {
  appPath: string;
  physicalPath: string;
  rootIdentity: OfficialSourcePathIdentity;
  bundleId: "com.openai.codex";
  version: string;
  build: string;
  appAsarHeaderHash: string;
  marker: "absent";
}

export interface OfficialSourceStatusProjectionDependencies {
  /** Test seam only; production always reads exact bundle metadata itself. */
  observeMetadata?: (path: string, label: string) => OfficialSourceMetadataProjection;
}

export interface RegisteredOfficialSourceLease {
  readonly receipt: RegisteredOfficialSourceReceipt;
  readonly pointer: OfficialSourceCurrentPointer;
  readonly receiptDigest: string;
  release(): void;
}

export interface RegisterStableOfficialSourceInput {
  root: string;
  operationId: string;
  expectedSourceDigest: string;
  managerExecutable: ManagerResolvedExecutableIdentityV1;
}

export interface RegisterStableOfficialSourceResult {
  generationId: string;
  receiptDigest: string;
  sourceDigest: string;
  receiptRef: string;
}

export interface OfficialSourceRegistrationDeps {
  now?: () => string;
  id?: () => string;
  cloneApp?: typeof cloneAppTree;
  observe?: (path: string) => OfficialSourceObservation;
  /** Test-only clone observer. Production always verifies the clone with the
   * strict OpenAI signature and Gatekeeper probe. */
  observeClone?: (path: string) => OfficialSourceObservation;
  /** Test-only post-publication checker. Production always reopens and fully
   * validates the published pointer, receipt, artifact, and fixed live app. */
  readRegistered?: (root: string) => RegisteredOfficialSourceStatus;
  publishEnvironment?: typeof publishEnvironmentSnapshot;
  fault?: (point: string) => void;
}

interface OfficialSourcePublication {
  registryBefore: Buffer;
  selectionBefore: Buffer;
  registryPublished: Buffer;
  selectionPublished: Buffer;
  pointerBefore: Buffer | null;
  pointerPublished: Buffer;
}

export function officialSourcePaths(root: string): OfficialSourcePaths {
  const canonicalRoot = exactAbsolute(root, "Official-source root");
  const sourceRoot = join(canonicalRoot, "official-source");
  return {
    root: canonicalRoot,
    sourceRoot,
    generationsRoot: join(sourceRoot, "generations"),
    stagingRoot: join(sourceRoot, "staging"),
    currentFile: join(sourceRoot, "current.json"),
    lockFile: join(sourceRoot, "official-source.lock"),
    transactionFile: join(canonicalRoot, "transactions", "official-source-registration.json"),
    environmentRegistryFile: join(canonicalRoot, "environment-registry.json"),
    environmentSelectionFile: join(canonicalRoot, "environment-selection.json"),
  };
}

/**
 * Strictly observe the one allowed registration input.  This does not mutate
 * the app, invoke Sparkle, or consult mode-cache/desktop-update state.
 */
export function observeStableOfficialSource(path = STABLE_DESKTOP_PATH): OfficialSourceObservation {
  if (path !== STABLE_DESKTOP_PATH) {
    throw new Error(`Official source must be the fixed path ${STABLE_DESKTOP_PATH}`);
  }
  assertRealDirectory(path, "Official ChatGPT source");
  const physicalPath = realpathSync(path);
  if (physicalPath !== path) throw new Error("Official ChatGPT source must not resolve through a symlink");
  const plist = readPlist(join(path, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== "com.openai.codex") {
    throw new Error("Official ChatGPT source has an unexpected bundle identifier");
  }
  const version = nonEmpty(plist.CFBundleShortVersionString, "Official ChatGPT source version");
  const build = nonEmpty(plist.CFBundleVersion, "Official ChatGPT source build");
  assertNoTweakersMarker(path, plist);

  const selection = createEnvironmentSelection({
    profile: {
      selectedDesktopPath: STABLE_DESKTOP_PATH,
      selectedDesktopBundleId: "com.openai.codex",
      releaseProfile: "stable",
    } as EnvironmentProfileRecord,
    appExperience: "chatgpt",
    requestedAt: new Date(0).toISOString(),
    appliedAt: new Date(0).toISOString(),
  });
  const validated = validateOfficialEnvironmentProfile(selection);
  const asarPath = join(path, "Contents", "Resources", "app.asar");
  const asarHeader = readHeaderHash(asarPath).headerHash.toLowerCase();
  if (!SHA256.test(asarHeader)) throw new Error("Official ChatGPT app.asar header hash is invalid");
  const root = lstatSync(path);
  return {
    appPath: STABLE_DESKTOP_PATH,
    physicalPath,
    rootIdentity: pathIdentity(root, "Official ChatGPT source"),
    bundleId: "com.openai.codex",
    version,
    build,
    appAsarHeaderHash: asarHeader,
    marker: "absent",
    treeSeal: sealOfficialSourceTree(path),
    trust: {
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: validated.trust.designatedRequirement.requirement!,
      authorities: [...validated.trust.signatureIdentity.authority],
    },
  };
}

/** Read and fully verify the pointer, receipt, immutable artifact, and live
 * fixed source.  Any disagreement fails closed rather than falling back to a
 * mode cache or `/Applications/ChatGPT.app`. */
export function readRegisteredOfficialSource(root: string): RegisteredOfficialSourceStatus {
  const paths = officialSourcePaths(root);
  let candidate: OfficialSourceObservation | null = null;
  let candidateProblem: string | null = null;
  try { candidate = observeStableOfficialSource(); }
  catch (error) { candidateProblem = errorMessage(error); }
  const candidateDigest = candidate === null ? null : digestObservation(candidate);
  try {
    if (existsSync(paths.sourceRoot)) assertPrivateDirectory(paths.sourceRoot, "Official-source root");
    if (existsSync(paths.generationsRoot)) assertPrivateDirectory(paths.generationsRoot, "Official-source generations root");
  } catch (error) {
    return statusFailure("unreadable", null, null, null, null, null, candidateDigest, null, "unreadable", errorMessage(error));
  }
  let pointerBytes: Buffer | null;
  try { pointerBytes = readOptionalPrivateBytes(paths.currentFile, "Official-source current pointer"); }
  catch (error) {
    return statusFailure("unreadable", null, null, null, null, null, candidateDigest, null, "unreadable", errorMessage(error));
  }
  if (pointerBytes === null) {
    return {
      state: "missing", generationId: null, receiptDigest: null, artifactPath: null,
      version: null, build: null, candidateDigest, sourceDigest: null,
      revision: "missing", problem: candidateProblem,
    };
  }
  const revision = sha256Revision(pointerBytes);
  let pointer: OfficialSourceCurrentPointer;
  try { pointer = parsePointer(pointerBytes, paths); }
  catch (error) {
    return statusFailure("malformed", null, null, null, null, null, candidateDigest, null, revision, errorMessage(error));
  }
  const receiptPath = join(paths.generationsRoot, pointer.generationId, "receipt.json");
  let receiptBytes: Buffer | null;
  try { receiptBytes = readOptionalPrivateBytes(receiptPath, "Official-source receipt"); }
  catch (error) {
    return statusFailure("stale", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, candidateDigest, pointer.sourceDigest, revision, `Registered source receipt is unavailable: ${errorMessage(error)}`);
  }
  if (receiptBytes === null) {
    return statusFailure("stale", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, candidateDigest, pointer.sourceDigest, revision, "Registered source receipt is unavailable");
  }
  const receiptDigest = sha256(receiptBytes);
  let receipt: RegisteredOfficialSourceReceipt;
  try { receipt = parseReceipt(receiptBytes, paths, pointer.generationId); }
  catch (error) {
    return statusFailure("malformed", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, candidateDigest, pointer.sourceDigest, revision, errorMessage(error));
  }
  try {
    if (pointer.receiptDigest !== receiptDigest
      || pointer.appPath !== receipt.artifact.appPath
      || pointer.version !== receipt.source.version
      || pointer.build !== receipt.source.build
      || pointer.sourceDigest !== digestObservation(receipt.source)) {
      throw new Error("Official-source pointer does not match its immutable receipt");
    }
    assertRealDirectory(receipt.artifact.appPath, "Registered official-source artifact");
    if (realpathSync(receipt.artifact.appPath) !== receipt.artifact.physicalPath) {
      throw new Error("Registered official-source artifact physical path changed");
    }
    const artifactRoot = lstatSync(receipt.artifact.appPath);
    if (!samePathIdentity(pathIdentity(artifactRoot, "Registered official-source artifact"), receipt.artifact.rootIdentity)) {
      throw new Error("Registered official-source artifact root identity changed");
    }
    if (!sameSeal(sealOfficialSourceTree(receipt.artifact.appPath), receipt.artifact.treeSeal)) {
      throw new Error("Registered official-source artifact stat seal changed");
    }
    // Revalidate the immutable artifact independently.  It was copied from
    // the fixed source but must still carry the original OpenAI trust chain.
    assertCloneMatchesOfficialReceipt(receipt.artifact.appPath, receipt.source, receipt.artifact.treeSeal);
    if (candidate === null) throw new Error(candidateProblem ?? "The fixed official source cannot be revalidated");
    if (digestObservation(candidate) !== pointer.sourceDigest) {
      throw new Error("The fixed official ChatGPT source changed after registration");
    }
    return {
      state: "ready", generationId: pointer.generationId, receiptDigest, artifactPath: receipt.artifact.appPath,
      version: pointer.version, build: pointer.build, candidateDigest, sourceDigest: pointer.sourceDigest,
      revision, problem: null,
    };
  } catch (error) {
    return statusFailure("stale", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, candidateDigest, pointer.sourceDigest, revision, errorMessage(error));
  }
}

/**
 * Fast, read-only dashboard projection for a previously sealed source.
 *
 * Status is polled from Electron UI and must never rescan and re-sign-verify
 * two complete 1+ GiB app trees on the main thread. This projection therefore
 * validates the private pointer/receipt chain, exact roots, bundle metadata,
 * ASAR header, and absence of a Tweakers marker. The mutating refresh executor
 * still calls `acquireRegisteredOfficialSourceLease`, which performs the full
 * tree-seal, Developer ID, and Gatekeeper validation immediately before any
 * candidate bytes are used.
 */
export function readRegisteredOfficialSourceStatusProjection(
  root: string,
  dependencies: OfficialSourceStatusProjectionDependencies = {},
): RegisteredOfficialSourceStatus {
  const paths = officialSourcePaths(root);
  const observeMetadata = dependencies.observeMetadata ?? observeOfficialSourceMetadata;
  try {
    if (existsSync(paths.sourceRoot)) assertPrivateDirectory(paths.sourceRoot, "Official-source root");
    if (existsSync(paths.generationsRoot)) assertPrivateDirectory(paths.generationsRoot, "Official-source generations root");
  } catch (error) {
    return statusFailure("unreadable", null, null, null, null, null, null, null, "unreadable", errorMessage(error));
  }
  let pointerBytes: Buffer | null;
  try { pointerBytes = readOptionalPrivateBytes(paths.currentFile, "Official-source current pointer"); }
  catch (error) {
    return statusFailure("unreadable", null, null, null, null, null, null, null, "unreadable", errorMessage(error));
  }
  if (pointerBytes === null) {
    return {
      state: "missing", generationId: null, receiptDigest: null, artifactPath: null,
      version: null, build: null, candidateDigest: null, sourceDigest: null,
      revision: "missing", problem: null,
    };
  }
  const revision = sha256Revision(pointerBytes);
  let pointer: OfficialSourceCurrentPointer;
  try { pointer = parsePointer(pointerBytes, paths); }
  catch (error) {
    return statusFailure("malformed", null, null, null, null, null, null, null, revision, errorMessage(error));
  }
  const receiptPath = join(paths.generationsRoot, pointer.generationId, "receipt.json");
  let receiptBytes: Buffer | null;
  try { receiptBytes = readOptionalPrivateBytes(receiptPath, "Official-source receipt"); }
  catch (error) {
    return statusFailure("stale", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, null, pointer.sourceDigest, revision, `Registered source receipt is unavailable: ${errorMessage(error)}`);
  }
  if (receiptBytes === null) {
    return statusFailure("stale", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, null, pointer.sourceDigest, revision, "Registered source receipt is unavailable");
  }
  const receiptDigest = sha256(receiptBytes);
  let receipt: RegisteredOfficialSourceReceipt;
  try { receipt = parseReceipt(receiptBytes, paths, pointer.generationId); }
  catch (error) {
    return statusFailure("malformed", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, null, pointer.sourceDigest, revision, errorMessage(error));
  }
  try {
    if (pointer.receiptDigest !== receiptDigest
      || pointer.appPath !== receipt.artifact.appPath
      || pointer.version !== receipt.source.version
      || pointer.build !== receipt.source.build
      || pointer.sourceDigest !== digestObservation(receipt.source)) {
      throw new Error("Official-source pointer does not match its immutable receipt");
    }
    const artifact = observeMetadata(receipt.artifact.appPath, "Registered official-source artifact");
    if (artifact.physicalPath !== receipt.artifact.physicalPath
      || !samePathIdentity(artifact.rootIdentity, receipt.artifact.rootIdentity)
      || !sameProjectedMetadata(artifact, receipt.source)) {
      throw new Error("Registered official-source artifact metadata changed");
    }
    const live = observeMetadata(STABLE_DESKTOP_PATH, "Fixed official ChatGPT source");
    if (!sameProjectedMetadata(live, receipt.source)) {
      throw new Error("The fixed official ChatGPT source changed after registration");
    }
    return {
      state: "ready", generationId: pointer.generationId, receiptDigest, artifactPath: receipt.artifact.appPath,
      version: pointer.version, build: pointer.build, candidateDigest: pointer.sourceDigest, sourceDigest: pointer.sourceDigest,
      revision, problem: null,
    };
  } catch (error) {
    return statusFailure("stale", pointer.generationId, pointer.receiptDigest, pointer.appPath, pointer.version, pointer.build, null, pointer.sourceDigest, revision, errorMessage(error));
  }
}

function observeOfficialSourceMetadata(path: string, label: string): OfficialSourceMetadataProjection {
  assertRealDirectory(path, label);
  const physicalPath = realpathSync(path);
  if (physicalPath !== path) throw new Error(`${label} must not resolve through a symlink`);
  const plist = readPlist(join(path, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== "com.openai.codex") throw new Error(`${label} bundle ID changed`);
  assertNoTweakersMarker(path, plist);
  return {
    appPath: path,
    physicalPath,
    rootIdentity: pathIdentity(lstatSync(path), label),
    bundleId: "com.openai.codex",
    version: nonEmpty(plist.CFBundleShortVersionString, `${label} version`),
    build: nonEmpty(plist.CFBundleVersion, `${label} build`),
    appAsarHeaderHash: readHeaderHash(join(path, "Contents", "Resources", "app.asar")).headerHash.toLowerCase(),
    marker: "absent",
  };
}

function sameProjectedMetadata(
  projection: OfficialSourceMetadataProjection,
  sealed: OfficialSourceObservation,
): boolean {
  return projection.bundleId === sealed.bundleId
    && projection.version === sealed.version
    && projection.build === sealed.build
    && projection.appAsarHeaderHash === sealed.appAsarHeaderHash
    && projection.marker === sealed.marker;
}

/** Acquire the immutable source lease used by the independent refresh. The
 * complete validation happens after the lease is held and before cloning. */
export function acquireRegisteredOfficialSourceLease(root: string): RegisteredOfficialSourceLease {
  const paths = officialSourcePaths(root);
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("The manager official-source store is busy"),
  });
  try {
    const status = readRegisteredOfficialSource(paths.root);
    if (status.state !== "ready" || status.generationId === null || status.receiptDigest === null) {
      throw new Error(status.problem ?? "No current sealed official source is available");
    }
    const pointerBytes = readOptionalPrivateBytes(paths.currentFile, "Official-source current pointer");
    if (pointerBytes === null) throw new Error("The official-source current pointer disappeared while acquiring its lease");
    const pointer = parsePointer(pointerBytes, paths);
    const receiptBytes = readOptionalPrivateBytes(
      join(paths.generationsRoot, pointer.generationId, "receipt.json"),
      "Official-source receipt",
    );
    if (receiptBytes === null) throw new Error("The official-source receipt disappeared while acquiring its lease");
    const receipt = parseReceipt(receiptBytes, paths, pointer.generationId);
    const digest = sha256(receiptBytes);
    if (digest !== status.receiptDigest || digest !== pointer.receiptDigest) {
      throw new Error("The official-source receipt changed while acquiring its lease");
    }
    return { receipt, pointer, receiptDigest: digest, release: () => lock.release() };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Registration is a manager action.  It has no caller-selectable source, no
 * updater/network operation, and no mutation of `/Applications/ChatGPT.app`.
 */
export function registerStableOfficialSource(
  input: RegisterStableOfficialSourceInput,
  deps: OfficialSourceRegistrationDeps = {},
): RegisterStableOfficialSourceResult {
  const paths = officialSourcePaths(input.root);
  assertUuid(input.operationId, "Official-source registration operation ID");
  if (!SHA256.test(input.expectedSourceDigest)) throw new Error("Official-source registration requires a SHA-256 source binding");
  const now = assertTimestamp((deps.now ?? (() => new Date().toISOString()))(), "Official-source registration clock");
  const generationId = (deps.id ?? randomUUID)().toLowerCase();
  assertUuid(generationId, "Official-source generation ID");
  const lock = acquireProcessLock(paths.lockFile, {
    onContended: () => new Error("The manager official-source store is busy"),
  });
  let publication: OfficialSourcePublication | null = null;
  let observedSourceDigest: string | null = null;
  let publishedReceiptDigest: string | null = null;
  try {
    assertRegistrationEnvironment(paths);
    ensurePrivateDirectory(paths.sourceRoot);
    const observe = deps.observe ?? observeStableOfficialSource;
    const observeArtifact = deps.observeClone ?? observeClone;
    const readRegistered = deps.readRegistered ?? readRegisteredOfficialSource;
    const before = observe(STABLE_DESKTOP_PATH);
    const sourceDigest = digestObservation(before);
    observedSourceDigest = sourceDigest;
    if (sourceDigest !== input.expectedSourceDigest) {
      throw new Error("The fixed official ChatGPT source changed after manager preparation");
    }
    writeTransaction(paths.transactionFile, {
      schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
      kind: OFFICIAL_SOURCE_TRANSACTION_KIND,
      operationId: input.operationId,
      sourceDigest,
      generationId: null,
      receiptDigest: null,
      phase: "preparing",
      createdAt: now,
      updatedAt: now,
      error: null,
    });
    ensurePrivateDirectory(paths.generationsRoot);
    ensurePrivateDirectory(paths.stagingRoot);
    const stagingGeneration = join(paths.stagingRoot, generationId);
    const stagedApp = join(stagingGeneration, OFFICIAL_SOURCE_APP_NAME);
    if (existsSync(stagingGeneration) || existsSync(join(paths.generationsRoot, generationId))) {
      throw new Error("Official-source generation collision");
    }
    ensurePrivateDirectory(stagingGeneration);
    (deps.cloneApp ?? cloneAppTree)(STABLE_DESKTOP_PATH, stagedApp);
    const clone = observeArtifact(stagedApp);
    assertObservationContentMatches(before, clone, "The registered clone does not match the sealed official source");
    const after = observe(STABLE_DESKTOP_PATH);
    assertObservationContentMatches(before, after, "The fixed official ChatGPT source changed while it was being cloned");
    deps.fault?.("official-source:clone-verified");

    const receipt: RegisteredOfficialSourceReceipt = {
      schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
      kind: OFFICIAL_SOURCE_KIND,
      generationId,
      operationId: input.operationId,
      registeredAt: now,
      source: before,
      artifact: {
        appPath: join(paths.generationsRoot, generationId, OFFICIAL_SOURCE_APP_NAME),
        physicalPath: join(paths.generationsRoot, generationId, OFFICIAL_SOURCE_APP_NAME),
        rootIdentity: pathIdentity(lstatSync(stagedApp), "Staged official-source artifact"),
        treeSeal: clone.treeSeal,
      },
      manager: {
        id: TWEAKERS_MANAGER_ID,
        executablePath: input.managerExecutable.path,
        executableSha256: input.managerExecutable.sha256.replace(/^sha256:/, ""),
      },
    };
    // The final generation path is part of its signed-by-content receipt, but
    // the root inode belongs to staging before the exclusive promotion. A
    // same-filesystem rename preserves that inode; assert it again below.
    writePrivateJson(join(stagingGeneration, "receipt.json"), receipt);
    fsyncTree(stagingGeneration);
    renameSync(stagingGeneration, join(paths.generationsRoot, generationId));
    fsyncDirectory(paths.generationsRoot);
    const publishedReceiptPath = join(paths.generationsRoot, generationId, "receipt.json");
    const publishedReceiptBytes = readFileSync(publishedReceiptPath);
    const receiptDigest = sha256(publishedReceiptBytes);
    publishedReceiptDigest = receiptDigest;
    const publishedReceipt = parseReceipt(publishedReceiptBytes, paths, generationId);
    assertCloneMatchesOfficialReceipt(
      publishedReceipt.artifact.appPath,
      before,
      publishedReceipt.artifact.treeSeal,
      observeArtifact,
    );
    deps.fault?.("official-source:generation-published");

    // A durable published-generation receipt makes an interrupted publication
    // observable and fail-closed. It is never a selected source by itself;
    // only the final current pointer may select it.
    writeTransaction(paths.transactionFile, {
      schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
      kind: OFFICIAL_SOURCE_TRANSACTION_KIND,
      operationId: input.operationId,
      sourceDigest,
      generationId,
      receiptDigest,
      phase: "published",
      createdAt: now,
      updatedAt: now,
      error: null,
    });

    const registryBefore = readFileSync(paths.environmentRegistryFile);
    const selectionBefore = readFileSync(paths.environmentSelectionFile);
    const pointerBefore = readOptionalPrivateBytes(paths.currentFile, "Official-source current pointer");
    const { registry, selection } = refreshedCanonicalEnvironment(paths, before, now);
    (deps.publishEnvironment ?? publishEnvironmentSnapshot)(
      paths.environmentRegistryFile,
      paths.environmentSelectionFile,
      registry,
      selection,
    );
    const registryPublished = readFileSync(paths.environmentRegistryFile);
    const selectionPublished = readFileSync(paths.environmentSelectionFile);

    const pointer: OfficialSourceCurrentPointer = {
      schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
      kind: OFFICIAL_SOURCE_POINTER_KIND,
      generationId,
      receiptDigest,
      appPath: publishedReceipt.artifact.appPath,
      version: before.version,
      build: before.build,
      sourceDigest,
      publishedAt: now,
    };
    publication = {
      registryBefore,
      selectionBefore,
      registryPublished,
      selectionPublished,
      pointerBefore,
      pointerPublished: privateJsonBytes(pointer),
    };
    deps.fault?.("official-source:environment-published");
    writePrivateJson(paths.currentFile, pointer);
    deps.fault?.("official-source:pointer-published");
    const ready = readRegistered(paths.root);
    if (ready.state !== "ready" || ready.generationId !== generationId || ready.receiptDigest !== receiptDigest) {
      throw new Error(ready.problem ?? "Published official-source receipt did not revalidate");
    }
    writeTransaction(paths.transactionFile, {
      schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
      kind: OFFICIAL_SOURCE_TRANSACTION_KIND,
      operationId: input.operationId,
      sourceDigest,
      generationId,
      receiptDigest,
      phase: "completed",
      createdAt: now,
      updatedAt: now,
      error: null,
    });
    publication = null;
    return { generationId, receiptDigest, sourceDigest, receiptRef: `official-source:${generationId}:${receiptDigest}` };
  } catch (error) {
    let terminalError: unknown = error;
    let restored = true;
    if (publication !== null) {
      try {
        restoreOfficialSourcePublication(paths, publication);
      } catch (restoreError) {
        restored = false;
        terminalError = new AggregateError(
          [error, restoreError],
          "Official-source publication failed and its coupled environment/pointer rollback was incomplete.",
        );
      }
    }
    // Preserve any staged/generation evidence.  The terminal transaction makes
    // it visible without ever selecting it as a source.
    const prior = readTransactionOrNull(paths.transactionFile);
    const timestamp = (deps.now ?? (() => new Date().toISOString()))();
    try {
      writeTransaction(paths.transactionFile, {
        schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
        kind: OFFICIAL_SOURCE_TRANSACTION_KIND,
        operationId: input.operationId,
        sourceDigest: prior?.sourceDigest ?? observedSourceDigest ?? input.expectedSourceDigest,
        generationId: prior?.generationId ?? (publishedReceiptDigest === null ? null : generationId),
        receiptDigest: prior?.receiptDigest ?? publishedReceiptDigest,
        phase: restored ? "failed" : "recovery-required",
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
        error: errorMessage(terminalError),
      });
    } catch { /* retain the original failure; a receipt-write failure stays fail-closed */ }
    throw terminalError;
  } finally {
    lock.release();
  }
}

/** This is intentionally public so the manager action can bind its prepared
 * receipt target to an exact fresh source observation without any mutation. */
export function stableOfficialSourceCandidateDigest(): string | null {
  try { return digestObservation(observeStableOfficialSource()); }
  catch { return null; }
}

function observeClone(path: string): OfficialSourceObservation {
  assertRealDirectory(path, "Staged official-source artifact");
  const physicalPath = realpathSync(path);
  if (physicalPath !== path) throw new Error("Staged official-source artifact must not resolve through a symlink");
  const plist = readPlist(join(path, "Contents", "Info.plist"));
  if (plist.CFBundleIdentifier !== "com.openai.codex") throw new Error("Staged official-source artifact bundle ID changed");
  assertNoTweakersMarker(path, plist);
  const version = nonEmpty(plist.CFBundleShortVersionString, "Staged official-source artifact version");
  const build = nonEmpty(plist.CFBundleVersion, "Staged official-source artifact build");
  // The clone must preserve the genuine Developer ID signature.  Unlike the
  // live source this validation accepts its immutable generation path.
  const cloneSelection = createEnvironmentSelection({
    profile: { selectedDesktopPath: path, selectedDesktopBundleId: "com.openai.codex", releaseProfile: "stable" } as EnvironmentProfileRecord,
    appExperience: "chatgpt",
    requestedAt: new Date(0).toISOString(),
    appliedAt: new Date(0).toISOString(),
  });
  const validated = validateOfficialEnvironmentProfile(cloneSelection);
  const asarHeader = readHeaderHash(join(path, "Contents", "Resources", "app.asar")).headerHash.toLowerCase();
  return {
    appPath: path,
    physicalPath,
    rootIdentity: pathIdentity(lstatSync(path), "Staged official-source artifact"),
    bundleId: "com.openai.codex",
    version,
    build,
    appAsarHeaderHash: asarHeader,
    marker: "absent",
    treeSeal: sealOfficialSourceTree(path),
    trust: {
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: validated.trust.designatedRequirement.requirement!,
      authorities: [...validated.trust.signatureIdentity.authority],
    },
  };
}

function assertCloneMatchesOfficialReceipt(
  path: string,
  source: OfficialSourceObservation,
  expectedSeal: OfficialSourceTreeSeal,
  observer: (path: string) => OfficialSourceObservation = observeClone,
): void {
  const clone = observer(path);
  assertObservationContentMatches(source, clone, "Registered official-source artifact no longer matches its receipt");
  if (!sameSeal(clone.treeSeal, expectedSeal)) throw new Error("Registered official-source artifact stat seal changed");
}

function assertObservationContentMatches(left: OfficialSourceObservation, right: OfficialSourceObservation, message: string): void {
  const comparable = (value: OfficialSourceObservation) => ({
    bundleId: value.bundleId,
    version: value.version,
    build: value.build,
    appAsarHeaderHash: value.appAsarHeaderHash,
    marker: value.marker,
    treeSeal: value.treeSeal,
    trust: value.trust,
  });
  if (canonicalJson(comparable(left)) !== canonicalJson(comparable(right))) throw new Error(message);
}

function assertRegistrationEnvironment(paths: OfficialSourcePaths): void {
  if (readEnvironmentDocumentCommit(paths.environmentRegistryFile, paths.environmentSelectionFile) !== null) {
    throw new Error("Canonical manager environment has an unfinished state commit");
  }
  const registry = readEnvironmentProfileRegistry(paths.environmentRegistryFile);
  const selection = readEnvironmentSelection(paths.environmentSelectionFile);
  if (registry === null || selection === null || registry.selected === null || registry.lastKnownWorkingSelection === null) {
    throw new Error("Canonical manager environment registration requires a complete selection pair");
  }
  if (!sameSelection(registry.selected, selection) || !sameSelection(registry.lastKnownWorkingSelection, selection)
    || selection.selectedDesktopPath !== STABLE_DESKTOP_PATH
    || selection.selectedDesktopBundleId !== "com.openai.codex"
    || selection.releaseProfile !== "stable"
    || selection.appExperience !== "chatgpt"
    || selection.backendLane !== "official-bundled"
    || !isEnvironmentSelectionHealthy(selection)
    || !isPristineOpenAiRecoveryEnvironment(selection)) {
    throw new Error("Stable official-source registration requires verified normal ChatGPT mode");
  }
}

function refreshedCanonicalEnvironment(
  paths: OfficialSourcePaths,
  source: OfficialSourceObservation,
  now: string,
): { registry: EnvironmentProfileRegistry; selection: EnvironmentSelection } {
  const existing = readEnvironmentProfileRegistry(paths.environmentRegistryFile);
  const selection = readEnvironmentSelection(paths.environmentSelectionFile);
  if (existing === null || selection === null) throw new Error("Canonical manager environment disappeared during official-source registration");
  const stable = existing.profiles.stable;
  const alpha = existing.profiles.alpha;
  const stableEvidence: EnvironmentProfileEvidenceInput = {
    ...profileEvidence(stable),
    officialVersion: source.version,
    officialBuild: source.build,
    strictSignature: true,
    gatekeeper: true,
    teamIdentifier: source.trust.teamIdentifier,
    designatedRequirement: source.trust.designatedRequirement,
    signatureCheckedAt: now,
    officialBackendPath: join(STABLE_DESKTOP_PATH, "Contents", "Resources", "codex"),
    // These are separate capability surfaces. Do not carry a version/fingerprint
    // observed from an older ChatGPT build into the new official registration.
    officialBackendVersion: null,
    officialBackendFingerprint: null,
    backendVersion: null,
    backendFingerprint: null,
  };
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: STABLE_DESKTOP_PATH,
    alphaDesktopPath: alpha.officialPath,
    environmentRoot: paths.root,
    selected: selection,
    lastKnownWorkingSelection: selection,
    stableEvidence,
    alphaEvidence: profileEvidence(alpha),
  });
  if (!sameSelection(registry.selected!, selection) || !sameSelection(registry.lastKnownWorkingSelection!, selection)) {
    throw new Error("Official-source registration attempted to alter the canonical environment selection");
  }
  return { registry, selection };
}

function profileEvidence(profile: EnvironmentProfileRecord): EnvironmentProfileEvidenceInput {
  return {
    officialVersion: profile.officialVersion,
    officialBuild: profile.officialBuild,
    strictSignature: profile.strictSignature,
    gatekeeper: profile.gatekeeper,
    teamIdentifier: profile.teamIdentifier,
    designatedRequirement: profile.designatedRequirement,
    signatureCheckedAt: profile.signatureCheckedAt,
    officialBackendPath: profile.officialBackendPath,
    officialBackendVersion: profile.officialBackendVersion,
    officialBackendFingerprint: profile.officialBackendFingerprint,
    backendPath: profile.backendPath,
    backendVersion: profile.backendVersion,
    backendChannel: profile.backendChannel,
    backendFingerprint: profile.backendFingerprint,
    pristineBackupPath: profile.pristineBackupPath,
    pristineBackupFingerprint: profile.pristineBackupFingerprint,
    patchedPayloadPath: profile.patchedPayloadPath,
    patchedPayloadFingerprint: profile.patchedPayloadFingerprint,
    backendInstallable: profile.backendInstallable,
    patchedPayloadBuildable: profile.patchedPayloadBuildable,
    unavailableReasons: profile.unavailableReasons,
  };
}

function restorePublishedEnvironment(
  paths: OfficialSourcePaths,
  registryBefore: Buffer,
  selectionBefore: Buffer,
  registryPublished: Buffer,
  selectionPublished: Buffer,
): void {
  if (!readFileSync(paths.environmentRegistryFile).equals(registryPublished)
    || !readFileSync(paths.environmentSelectionFile).equals(selectionPublished)) {
    throw new Error("Official-source pointer publication failed after a concurrent environment update");
  }
  writeExactBytes(paths.environmentSelectionFile, selectionBefore);
  writeExactBytes(paths.environmentRegistryFile, registryBefore);
}

/** Restore only the exact documents this registration published.  A changed
 * byte sequence is concurrent ownership evidence, never permission to
 * overwrite another manager/environment writer. */
function restoreOfficialSourcePublication(paths: OfficialSourcePaths, publication: OfficialSourcePublication): void {
  const currentPointer = readOptionalPrivateBytes(paths.currentFile, "Official-source current pointer");
  if (sameBytes(currentPointer, publication.pointerPublished)) {
    writeExactBytes(paths.currentFile, publication.pointerBefore);
  } else if (!sameBytes(currentPointer, publication.pointerBefore)) {
    throw new Error("Official-source publication rollback found a concurrent current pointer");
  }
  restorePublishedEnvironment(
    paths,
    publication.registryBefore,
    publication.selectionBefore,
    publication.registryPublished,
    publication.selectionPublished,
  );
}

function parsePointer(bytes: Buffer, paths: OfficialSourcePaths): OfficialSourceCurrentPointer {
  const value = parseStrictObject(bytes, "official-source current pointer");
  assertKeys(value, ["appPath", "build", "generationId", "kind", "publishedAt", "receiptDigest", "schemaVersion", "sourceDigest", "version"], "official-source current pointer");
  if (value.schemaVersion !== OFFICIAL_SOURCE_SCHEMA_VERSION || value.kind !== OFFICIAL_SOURCE_POINTER_KIND) {
    throw new Error("Official-source current pointer has an unsupported schema");
  }
  const generationId = requiredUuid(value.generationId, "Official-source pointer generation ID");
  const receiptDigest = requiredSha(value.receiptDigest, "Official-source pointer receipt digest");
  const appPath = exactAbsoluteString(value.appPath, "Official-source pointer app path");
  const expectedAppPath = join(paths.generationsRoot, generationId, OFFICIAL_SOURCE_APP_NAME);
  if (appPath !== expectedAppPath) throw new Error("Official-source pointer app path is outside its generation");
  return {
    schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
    kind: OFFICIAL_SOURCE_POINTER_KIND,
    generationId,
    receiptDigest,
    appPath,
    version: nonEmpty(value.version, "Official-source pointer version"),
    build: nonEmpty(value.build, "Official-source pointer build"),
    sourceDigest: requiredSha(value.sourceDigest, "Official-source pointer source digest"),
    publishedAt: assertTimestamp(string(value.publishedAt, "Official-source pointer publishedAt"), "Official-source pointer publishedAt"),
  };
}

function parseReceipt(bytes: Buffer, paths: OfficialSourcePaths, expectedGenerationId?: string): RegisteredOfficialSourceReceipt {
  const value = parseStrictObject(bytes, "official-source receipt");
  assertKeys(value, ["artifact", "generationId", "kind", "manager", "operationId", "registeredAt", "schemaVersion", "source"], "official-source receipt");
  if (value.schemaVersion !== OFFICIAL_SOURCE_SCHEMA_VERSION || value.kind !== OFFICIAL_SOURCE_KIND) {
    throw new Error("Official-source receipt has an unsupported schema");
  }
  const generationId = requiredUuid(value.generationId, "Official-source receipt generation ID");
  if (expectedGenerationId !== undefined && generationId !== expectedGenerationId) throw new Error("Official-source receipt generation ID does not match its path");
  const source = parseObservation(record(value.source, "Official-source receipt source"), "source", STABLE_DESKTOP_PATH);
  const artifact = record(value.artifact, "Official-source receipt artifact");
  assertKeys(artifact, ["appPath", "physicalPath", "rootIdentity", "treeSeal"], "Official-source receipt artifact");
  const appPath = exactAbsoluteString(artifact.appPath, "Official-source receipt artifact path");
  const expectedAppPath = join(paths.generationsRoot, generationId, OFFICIAL_SOURCE_APP_NAME);
  if (appPath !== expectedAppPath) throw new Error("Official-source receipt artifact path is outside its generation");
  const physicalPath = exactAbsoluteString(artifact.physicalPath, "Official-source receipt artifact physical path");
  if (physicalPath !== appPath) throw new Error("Official-source receipt artifact physical path must be canonical");
  const manager = record(value.manager, "Official-source receipt manager");
  assertKeys(manager, ["executablePath", "executableSha256", "id"], "Official-source receipt manager");
  if (manager.id !== TWEAKERS_MANAGER_ID) throw new Error("Official-source receipt manager ID is invalid");
  return {
    schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
    kind: OFFICIAL_SOURCE_KIND,
    generationId,
    operationId: requiredUuid(value.operationId, "Official-source receipt operation ID"),
    registeredAt: assertTimestamp(string(value.registeredAt, "Official-source receipt registeredAt"), "Official-source receipt registeredAt"),
    source,
    artifact: {
      appPath,
      physicalPath,
      rootIdentity: parseIdentity(artifact.rootIdentity, "Official-source receipt artifact root identity"),
      treeSeal: parseSeal(artifact.treeSeal, "Official-source receipt artifact stat seal"),
    },
    manager: {
      id: TWEAKERS_MANAGER_ID,
      executablePath: exactAbsoluteString(manager.executablePath, "Official-source receipt manager executable path"),
      executableSha256: requiredSha(manager.executableSha256, "Official-source receipt manager executable digest"),
    },
  };
}

function parseObservation(value: Record<string, unknown>, label: string, expectedPath: string): OfficialSourceObservation {
  assertKeys(value, ["appAsarHeaderHash", "appPath", "build", "bundleId", "marker", "physicalPath", "rootIdentity", "treeSeal", "trust", "version"], `Official-source ${label}`);
  const appPath = exactAbsoluteString(value.appPath, `Official-source ${label} app path`);
  if (appPath !== expectedPath) throw new Error(`Official-source ${label} app path is not the fixed official path`);
  const physicalPath = exactAbsoluteString(value.physicalPath, `Official-source ${label} physical path`);
  if (physicalPath !== appPath) throw new Error(`Official-source ${label} physical path must be canonical`);
  if (value.bundleId !== "com.openai.codex" || value.marker !== "absent") throw new Error(`Official-source ${label} identity is invalid`);
  const trust = record(value.trust, `Official-source ${label} trust`);
  assertKeys(trust, ["authorities", "designatedRequirement", "gatekeeper", "strictSignature", "teamIdentifier"], `Official-source ${label} trust`);
  if (trust.strictSignature !== true || trust.gatekeeper !== true || trust.teamIdentifier !== "2DC432GLL2") {
    throw new Error(`Official-source ${label} trust is invalid`);
  }
  const authorities = arrayOfStrings(trust.authorities, `Official-source ${label} authorities`);
  if (!authorities.some((authority) => /^Developer ID Application: OpenAI\b/.test(authority) && authority.includes("(2DC432GLL2)"))) {
    throw new Error(`Official-source ${label} has no OpenAI Developer ID authority`);
  }
  return {
    appPath,
    physicalPath,
    rootIdentity: parseIdentity(value.rootIdentity, `Official-source ${label} root identity`),
    bundleId: "com.openai.codex",
    version: nonEmpty(value.version, `Official-source ${label} version`),
    build: nonEmpty(value.build, `Official-source ${label} build`),
    appAsarHeaderHash: requiredSha(value.appAsarHeaderHash, `Official-source ${label} app.asar header digest`),
    marker: "absent",
    treeSeal: parseSeal(value.treeSeal, `Official-source ${label} stat seal`),
    trust: {
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: nonEmpty(trust.designatedRequirement, `Official-source ${label} requirement`),
      authorities,
    },
  };
}

export function sealOfficialSourceTree(root: string): OfficialSourceTreeSeal {
  assertRealDirectory(root, "Official-source tree root");
  const lexicalRoot = resolve(root);
  const physicalRoot = realpathSync(root);
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0n;
  hash.update("tweakers-official-source-tree-v1\0");
  const visit = (path: string, name: string): void => {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o7777;
    hash.update(name).update("\0").update(String(mode)).update("\0").update(String(stat.uid)).update("\0").update(String(stat.gid)).update("\0");
    entries += 1;
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (isMacOsJunkName(entry.name)) continue;
        visit(join(path, entry.name), name ? `${name}/${entry.name}` : entry.name);
      }
      return;
    }
    if (stat.isFile()) {
      hash.update("file\0").update(String(stat.size)).update("\0");
      bytes += BigInt(stat.size);
      hash.update(readFileSync(path));
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      assertContainedRelativeSymlink(lexicalRoot, physicalRoot, path, target);
      hash.update("symlink\0").update(target).update("\0");
      return;
    }
    throw new Error(`Official-source tree has an unsupported entry: ${path}`);
  };
  visit(root, "");
  return { sha256: hash.digest("hex"), entries, bytes: bytes.toString() };
}

function assertContainedRelativeSymlink(
  lexicalRoot: string,
  physicalRoot: string,
  path: string,
  target: string,
): void {
  if (isAbsolute(target)) {
    throw new Error(`Official-source tree contains an absolute symlink: ${path}`);
  }

  // Check the normalized spelling first. A link that lexically leaves the
  // app tree is rejected even if a later symlink happens to point back in.
  const lexicalTarget = resolve(dirname(path), target);
  if (!isPathWithin(lexicalRoot, lexicalTarget)) {
    throw new Error(`Official-source tree contains an escaping symlink: ${path}`);
  }

  let physicalTarget: string;
  try {
    physicalTarget = realpathSync(lexicalTarget);
  } catch (error) {
    throw new Error(`Official-source tree symlink target is not resolvable: ${path}`, { cause: error });
  }
  if (!isPathWithin(physicalRoot, physicalTarget)) {
    throw new Error(`Official-source tree contains a symlink-chain escape: ${path}`);
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function digestObservation(observation: OfficialSourceObservation): string {
  return sha256(Buffer.from(canonicalJson({
    bundleId: observation.bundleId,
    version: observation.version,
    build: observation.build,
    appAsarHeaderHash: observation.appAsarHeaderHash,
    marker: observation.marker,
    treeSeal: observation.treeSeal,
    trust: observation.trust,
  }), "utf8"));
}

function assertNoTweakersMarker(app: string, plist: Record<string, unknown>): void {
  const environment = plist.LSEnvironment;
  if (plist.TweakersOriginalExecutable !== undefined
    || (environment !== null && typeof environment === "object" && !Array.isArray(environment)
      && Object.prototype.hasOwnProperty.call(environment, "TWEAKERS_DERIVED_VARIANT"))) {
    throw new Error("Official ChatGPT source carries a Tweakers app marker");
  }
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(readFileInAsar(join(app, "Contents", "Resources", "app.asar"), "package.json").toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("Official ChatGPT source app.asar package metadata is unreadable"); }
  if (pkg.main === "tweaker-loader.cjs" || pkg.main === "protected-loader.cjs"
    || Object.prototype.hasOwnProperty.call(pkg, "__tweaker")
    || Object.prototype.hasOwnProperty.call(pkg, "__tweakersProtected")) {
    throw new Error("Official ChatGPT source carries a Tweakers ASAR marker");
  }
}

function writeTransaction(path: string, value: OfficialSourceRegistrationTransaction): void {
  writePrivateJson(path, value);
}

function readTransactionOrNull(path: string): OfficialSourceRegistrationTransaction | null {
  if (!existsSync(path)) return null;
  try {
    const value = parseStrictObject(readFileSync(path), "official-source registration transaction");
    assertKeys(value, ["createdAt", "error", "generationId", "kind", "operationId", "phase", "receiptDigest", "schemaVersion", "sourceDigest", "updatedAt"], "official-source registration transaction");
    if (value.schemaVersion !== OFFICIAL_SOURCE_SCHEMA_VERSION || value.kind !== OFFICIAL_SOURCE_TRANSACTION_KIND) return null;
    const phase = value.phase;
    if (phase !== "preparing" && phase !== "published" && phase !== "completed" && phase !== "recovery-required" && phase !== "failed") return null;
    return {
      schemaVersion: OFFICIAL_SOURCE_SCHEMA_VERSION,
      kind: OFFICIAL_SOURCE_TRANSACTION_KIND,
      operationId: requiredUuid(value.operationId, "Official-source transaction operation ID"),
      sourceDigest: requiredSha(value.sourceDigest, "Official-source transaction source digest"),
      generationId: nullableUuid(value.generationId, "Official-source transaction generation ID"),
      receiptDigest: nullableSha(value.receiptDigest, "Official-source transaction receipt digest"),
      phase,
      createdAt: assertTimestamp(string(value.createdAt, "Official-source transaction createdAt"), "Official-source transaction createdAt"),
      updatedAt: assertTimestamp(string(value.updatedAt, "Official-source transaction updatedAt"), "Official-source transaction updatedAt"),
      error: nullableString(value.error, "Official-source transaction error"),
    };
  } catch { return null; }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = dirname(path);
  const temporary = join(parent, `.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const bytes = privateJsonBytes(value);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* no partial document */ }
    throw error;
  }
}

function privateJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function readOptionalPrivateBytes(path: string, label: string): Buffer | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} is group/world accessible`);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`${label} is not owned by the current user`);
  return readFileSync(path);
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function writeExactBytes(path: string, bytes: Buffer | null): void {
  if (bytes === null) {
    if (!existsSync(path)) return;
    const current = readOptionalPrivateBytes(path, "Official-source rollback target");
    if (current === null) return;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.${randomUUID()}.restore`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* no partial restore */ }
    throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Official-source directory is unsafe: ${path}`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
  assertPrivateDirectory(path, "Official-source directory");
  fsyncDirectory(path);
}

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} is group/world accessible`);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`${label} is not owned by the current user`);
}

function fsyncTree(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Official-source generation has an unsupported entry: ${path}`);
    for (const entry of readdirSync(path, { withFileTypes: true })) visit(join(path, entry.name));
    fsyncDirectory(path);
  };
  visit(root);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function pathIdentity(stat: Stats, label: string): OfficialSourcePathIdentity {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

function parseIdentity(value: unknown, label: string): OfficialSourcePathIdentity {
  const recordValue = record(value, label);
  assertKeys(recordValue, ["ctimeMs", "dev", "ino"], label);
  for (const key of ["dev", "ino", "ctimeMs"] as const) {
    if (typeof recordValue[key] !== "number" || !Number.isFinite(recordValue[key]) || recordValue[key] < 0) throw new Error(`${label} ${key} is invalid`);
  }
  return { dev: recordValue.dev as number, ino: recordValue.ino as number, ctimeMs: recordValue.ctimeMs as number };
}

function parseSeal(value: unknown, label: string): OfficialSourceTreeSeal {
  const recordValue = record(value, label);
  assertKeys(recordValue, ["bytes", "entries", "sha256"], label);
  if (!SHA256.test(string(recordValue.sha256, `${label} SHA-256`))
    || typeof recordValue.entries !== "number" || !Number.isSafeInteger(recordValue.entries) || recordValue.entries < 1
    || typeof recordValue.bytes !== "string" || !/^\d+$/.test(recordValue.bytes)) {
    throw new Error(`${label} is invalid`);
  }
  return { sha256: recordValue.sha256 as string, entries: recordValue.entries as number, bytes: recordValue.bytes as string };
}

function samePathIdentity(left: OfficialSourcePathIdentity, right: OfficialSourcePathIdentity): boolean {
  // macOS may attach or refresh provenance/MACL xattrs while Gatekeeper or
  // LaunchServices inspects a bundle. That changes directory ctime without
  // replacing the receipt-owned object or any signed/content-sealed bytes.
  // Device + inode prove the exact directory object; the independent tree
  // seal and OpenAI trust checks below continue to reject content, mode,
  // ownership, symlink, signature, or path substitution.
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSeal(left: OfficialSourceTreeSeal, right: OfficialSourceTreeSeal): boolean {
  return left.sha256 === right.sha256 && left.entries === right.entries && left.bytes === right.bytes;
}

function sameSelection(left: EnvironmentSelection, right: EnvironmentSelection): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function statusFailure(
  state: Exclude<RegisteredOfficialSourceState, "ready" | "missing">,
  generationId: string | null,
  receiptDigest: string | null,
  artifactPath: string | null,
  version: string | null,
  build: string | null,
  candidateDigest: string | null,
  sourceDigest: string | null,
  revision: string,
  problem: string,
): RegisteredOfficialSourceStatus {
  return { state, generationId, receiptDigest, artifactPath, version, build, candidateDigest, sourceDigest, revision, problem };
}

function parseStrictObject(bytes: Buffer, label: string): Record<string, unknown> {
  return parseManagerStrictJsonObject(bytes, { maxBytes: 128 * 1024, label });
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unsupported shape`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayOfStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) throw new Error(`${label} is invalid`);
  return [...value];
}

function exactAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || resolve(value) !== value) throw new Error(`${label} must be an exact absolute path`);
  return value;
}

function exactAbsoluteString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return exactAbsolute(value, label);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  const text = string(value, label).trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function requiredSha(value: unknown, label: string): string {
  const digest = string(value, label);
  if (!SHA256.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function nullableSha(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredSha(value, label);
}

function requiredUuid(value: unknown, label: string): string {
  const id = string(value, label);
  if (!UUID.test(id)) throw new Error(`${label} must be a lowercase UUID`);
  return id;
}

function nullableUuid(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredUuid(value, label);
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a lowercase UUID`);
}

function assertTimestamp(value: string, label: string): string {
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be RFC3339`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Revision(value: Buffer): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Official-source canonical JSON received a non-JSON value");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

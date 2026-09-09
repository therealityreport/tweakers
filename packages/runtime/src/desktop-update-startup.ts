import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface DesktopUpdateStartupEvent {
  event: "desktop-update-startup-reconcile";
  result: "submitted" | "window-unavailable" | "failed";
  attempts: number;
  error?: string;
  errorCode?: string;
}

export interface DesktopUpdateStartupDependencies {
  windowReady(): boolean;
  launch(): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  onEvent(event: DesktopUpdateStartupEvent): void;
}

export interface DesktopUpdateStartupOptions {
  maxAttempts?: number;
  retryMs?: number;
}

/**
 * Publish the runtime half of the manager-owned readiness challenge.
 *
 * The expectation deliberately remains in place after this atomic write. The
 * manager authenticates both files and is the sole owner allowed to remove the
 * expectation after accepting the receipt.
 */
export function publishIndependentTweakersRuntimeReadyReceipt(
  receiptPath: string,
  receipt: unknown,
  pid: number = process.pid,
): void {
  const temporary = `${receiptPath}.${pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, receiptPath);
}

export function desktopUpdateStartupEnabled(
  environment: NodeJS.ProcessEnv = process.env,
  identity: {
    bundleIdentifier?: string | null;
    appPath?: string | null;
    verifiedDerivedAppPath?: string | null;
  } = {},
): boolean {
  if (environment.TWEAKERS_DERIVED_VARIANT === "1") return false;
  if (identity.bundleIdentifier === "com.therealityreport.tweakers") return false;
  const appPath = identity.appPath ? resolve(identity.appPath) : null;
  const verified = identity.verifiedDerivedAppPath ? resolve(identity.verifiedDerivedAppPath) : null;
  if (appPath && verified && appPath === verified) return false;
  return appPath ? basename(appPath) !== "Tweakers.app" : true;
}

const LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION = 2 as const;
const VARIANT_PROMOTION_JOURNAL_VERSION = 3 as const;
const VARIANT_PROMOTION_NAMES = ["runtime", "tweaks", "state.json", "config.json", "app"] as const;
const VARIANT_IMMUTABLE_PROMOTION_NAMES = ["runtime", "tweaks", "state.json", "app"] as const;

type VariantPromotionName = typeof VARIANT_PROMOTION_NAMES[number];
type VariantPromotionJournalVersion = typeof LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION | typeof VARIANT_PROMOTION_JOURNAL_VERSION;
type VariantGenerationKind = "file" | "directory";

interface VariantGenerationFingerprint {
  kind: VariantGenerationKind;
  mode: number;
  sha256: string;
}

interface VariantActiveReceipt {
  version: VariantPromotionJournalVersion;
  id: string;
  userRoot: string;
  target: string;
  entries: Array<{
    name: VariantPromotionName;
    path: string;
    fingerprint: VariantGenerationFingerprint;
  }>;
}

interface VariantJournalEntry {
  name: VariantPromotionName;
  source: string;
  destination: string;
  archive: string;
  failed: string;
  hadDestination: boolean;
  desired: VariantGenerationFingerprint;
  previous: VariantGenerationFingerprint | null;
}

interface VariantActiveReceiptJournalEntry {
  source: string;
  destination: string;
  archive: string;
  failed: string;
  hadDestination: boolean;
  desired: VariantGenerationFingerprint;
  previous: VariantGenerationFingerprint | null;
  expected: VariantActiveReceipt;
}

interface VariantPromotionJournal {
  version: VariantPromotionJournalVersion;
  id: string;
  userRoot: string;
  target: string;
  candidate: string;
  buildRoot: string;
  phase: string;
  entries: VariantJournalEntry[];
  activeReceipt: VariantActiveReceiptJournalEntry;
}

/** Test seam for the early derived-variant bootstrap guard. */
export interface TweakersVariantBootstrapOptions {
  environment?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  /**
   * Electron's normal fs facade treats app.asar as a virtual directory. The
   * installed app passes original-fs here so the generation receipt is bound
   * to the physical archive bytes rather than Electron's unpacked view.
   */
  fileSystem?: TweakersVariantFilesystem;
}

export interface TweakersVariantFilesystem {
  existsSync(path: string): boolean;
  lstatSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number | bigint;
    uid?: number;
  };
  readFileSync(path: string): Buffer;
  readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string }>;
  readlinkSync(path: string): string;
}

const nodeVariantFilesystem: TweakersVariantFilesystem = {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
};

function permissionBits(stat: { mode: number | bigint }): number {
  return Number(stat.mode) & 0o777;
}

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function assertVariantPromotionId(id: unknown): asserts id is string {
  if (typeof id !== "string"
    || id === "active"
    || id === "."
    || id === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || basename(id) !== id) {
    throw new Error("Derived variant bootstrap found an invalid promotion transaction ID.");
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Derived variant bootstrap requires a non-symlink ${label}.`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`Derived variant bootstrap requires a current-user-owned ${label}.`);
  }
  if ((permissionBits(stat) & 0o077) !== 0) {
    throw new Error(`Derived variant bootstrap requires a private ${label}.`);
  }
}

function assertPrivateRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Derived variant bootstrap requires a regular non-symlink ${label}.`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`Derived variant bootstrap requires a current-user-owned ${label}.`);
  }
  if ((permissionBits(stat) & 0o077) !== 0) {
    throw new Error(`Derived variant bootstrap requires a private ${label}.`);
  }
}

function assertNoSymlinkPathWithin(root: string, path: string, label: string): void {
  const suffix = relative(resolve(root), resolve(path));
  if (suffix === "") return;
  if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) {
    throw new Error(`Derived variant bootstrap found a ${label} outside its owner-private root.`);
  }
  let current = resolve(root);
  for (const segment of suffix.split("/")) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Derived variant bootstrap found a symlinked ${label} path component.`);
    }
    if (current !== resolve(path) && !stat.isDirectory()) {
      throw new Error(`Derived variant bootstrap found a non-directory ${label} path component.`);
    }
  }
}

function assertExactObjectKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`Derived variant bootstrap found an invalid ${label} schema.`);
  }
}

function parseFingerprint(value: unknown, label: string): VariantGenerationFingerprint {
  assertExactObjectKeys(value, ["kind", "mode", "sha256"], label);
  if ((value.kind !== "file" && value.kind !== "directory")
    || typeof value.mode !== "number"
    || !Number.isInteger(value.mode)
    || value.mode < 0
    || value.mode > 0o777
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`Derived variant bootstrap found an invalid ${label}.`);
  }
  return {
    kind: value.kind,
    mode: value.mode,
    sha256: value.sha256,
  };
}

function fingerprintsMatch(left: VariantGenerationFingerprint, right: VariantGenerationFingerprint): boolean {
  return left.kind === right.kind && left.mode === right.mode && left.sha256 === right.sha256;
}

/** Mirrors the installer's immutable-generation digest without importing installer code at runtime. */
export function fingerprintTweakersVariantGeneration(
  path: string,
  fileSystem: TweakersVariantFilesystem = nodeVariantFilesystem,
): VariantGenerationFingerprint {
  if (!fileSystem.existsSync(path)) throw new Error(`Derived variant bootstrap generation is missing: ${path}`);
  const root = fileSystem.lstatSync(path);
  if (root.isSymbolicLink()) throw new Error(`Derived variant bootstrap generation root is a symlink: ${path}`);
  const kind: VariantGenerationKind = root.isFile() ? "file" : root.isDirectory() ? "directory" : (() => {
    throw new Error(`Derived variant bootstrap generation root has an unsupported type: ${path}`);
  })();
  const hash = createHash("sha256");
  hash.update("tweakers-variant-generation-v2\0");
  const visit = (entryPath: string, name: string): void => {
    const stat = fileSystem.lstatSync(entryPath);
    const mode = permissionBits(stat);
    hash.update(name).update("\0").update(String(mode)).update("\0");
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of fileSystem.readdirSync(entryPath, { withFileTypes: true }).sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ))) {
        visit(join(entryPath, entry.name), name ? `${name}/${entry.name}` : entry.name);
      }
      return;
    }
    if (stat.isFile()) {
      hash.update("file\0").update(fileSystem.readFileSync(entryPath));
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(fileSystem.readlinkSync(entryPath));
      return;
    }
    throw new Error(`Derived variant bootstrap generation contains an unsupported entry: ${entryPath}`);
  };
  visit(path, "");
  return { kind, mode: permissionBits(root), sha256: hash.digest("hex") };
}

function expectedPromotionEntries(userRoot: string, target: string, id: string): Array<Pick<VariantJournalEntry,
  "name" | "source" | "destination" | "archive" | "failed">> {
  const buildRoot = join(userRoot, "builds", id);
  const archiveRoot = join(userRoot, "previous", id);
  const failedRoot = join(buildRoot, "failed-promotion");
  return [
    {
      name: "runtime",
      source: join(buildRoot, "runtime"),
      destination: join(userRoot, "runtime"),
      archive: join(archiveRoot, "state", "runtime"),
      failed: join(failedRoot, "state", "runtime"),
    },
    {
      name: "tweaks",
      source: join(buildRoot, "tweaks"),
      destination: join(userRoot, "tweaks"),
      archive: join(archiveRoot, "state", "tweaks"),
      failed: join(failedRoot, "state", "tweaks"),
    },
    {
      name: "state.json",
      source: join(buildRoot, "state.json"),
      destination: join(userRoot, "state.json"),
      archive: join(archiveRoot, "state", "state.json"),
      failed: join(failedRoot, "state", "state.json"),
    },
    {
      name: "config.json",
      source: join(buildRoot, "config.json"),
      destination: join(userRoot, "config.json"),
      archive: join(archiveRoot, "state", "config.json"),
      failed: join(failedRoot, "state", "config.json"),
    },
    {
      name: "app",
      source: join(dirname(target), `.${basename(target)}.candidate-${id}.app`),
      destination: target,
      archive: join(archiveRoot, "app", basename(target)),
      failed: join(failedRoot, "app", basename(target)),
    },
  ];
}

function expectedActiveReceiptPaths(userRoot: string, id: string): Pick<VariantActiveReceiptJournalEntry,
  "source" | "destination" | "archive" | "failed"> {
  const buildRoot = join(userRoot, "builds", id);
  return {
    source: join(buildRoot, "active-receipt.json"),
    destination: join(userRoot, "transactions", "variant-promotion", "active.json"),
    archive: join(userRoot, "previous", id, "active-receipt.json"),
    failed: join(buildRoot, "failed-promotion", "active-receipt.json"),
  };
}

function knownPromotionPhase(phase: string): boolean {
  if (["prepared", "promoting", "active:archive-planned", "active:archived", "active:promote-planned", "active:promoted", "committed", "recovered"].includes(phase)) {
    return true;
  }
  return VARIANT_PROMOTION_NAMES.some((name) => (
    phase === `${name}:archive-planned`
    || phase === `${name}:archived`
    || phase === `${name}:promote-planned`
    || phase === `${name}:promoted`
  ));
}

function parseActiveReceipt(
  value: unknown,
  expected: Omit<VariantActiveReceipt, "entries"> & { entries: VariantActiveReceipt["entries"] },
): VariantActiveReceipt {
  assertExactObjectKeys(value, ["version", "id", "userRoot", "target", "entries"], "active receipt");
  if (value.version !== expected.version
    || value.id !== expected.id
    || value.userRoot !== expected.userRoot
    || value.target !== expected.target
    || !Array.isArray(value.entries)
    || value.entries.length !== expected.entries.length) {
    throw new Error("Derived variant bootstrap active receipt does not match its exact generation binding.");
  }
  const entries = value.entries.map((entry, index) => {
    const wanted = expected.entries[index]!;
    assertExactObjectKeys(entry, ["name", "path", "fingerprint"], "active receipt generation");
    if (entry.name !== wanted.name || entry.path !== wanted.path) {
      throw new Error("Derived variant bootstrap active receipt has an unexpected generation path.");
    }
    const fingerprint = parseFingerprint(entry.fingerprint, "active receipt generation fingerprint");
    if (!fingerprintsMatch(fingerprint, wanted.fingerprint)) {
      throw new Error("Derived variant bootstrap active receipt has a mismatched generation fingerprint.");
    }
    return { name: wanted.name, path: wanted.path, fingerprint };
  });
  return {
    version: expected.version,
    id: expected.id,
    userRoot: expected.userRoot,
    target: expected.target,
    entries,
  };
}

function parseJournal(value: unknown, userRoot: string, target: string): VariantPromotionJournal {
  assertExactObjectKeys(value, [
    "version", "id", "userRoot", "target", "candidate", "buildRoot", "phase", "entries", "activeReceipt",
  ], "promotion journal");
  if ((value.version !== VARIANT_PROMOTION_JOURNAL_VERSION
      && value.version !== LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION)
    || typeof value.id !== "string"
    || typeof value.userRoot !== "string"
    || typeof value.target !== "string"
    || typeof value.candidate !== "string"
    || typeof value.buildRoot !== "string"
    || typeof value.phase !== "string"
    || !Array.isArray(value.entries)) {
    throw new Error("Derived variant bootstrap found an unsupported promotion journal.");
  }
  assertVariantPromotionId(value.id);
  if (value.userRoot !== userRoot
    || value.target !== target
    || !isCanonicalAbsolutePath(value.userRoot)
    || !isCanonicalAbsolutePath(value.target)
    || !isCanonicalAbsolutePath(value.candidate)
    || !isCanonicalAbsolutePath(value.buildRoot)
    || value.buildRoot !== join(userRoot, "builds", value.id)
    || value.candidate !== join(dirname(target), `.${basename(target)}.candidate-${value.id}.app`)
    || !knownPromotionPhase(value.phase)) {
    throw new Error("Derived variant bootstrap journal path binding is invalid.");
  }
  const expectedEntries = expectedPromotionEntries(userRoot, target, value.id);
  if (value.entries.length !== expectedEntries.length) {
    throw new Error("Derived variant bootstrap journal generation count is invalid.");
  }
  const entries = value.entries.map((entry, index) => {
    const wanted = expectedEntries[index]!;
    assertExactObjectKeys(entry, ["name", "source", "destination", "archive", "failed", "hadDestination", "desired", "previous"], "promotion journal generation");
    if (entry.name !== wanted.name
      || entry.source !== wanted.source
      || entry.destination !== wanted.destination
      || entry.archive !== wanted.archive
      || entry.failed !== wanted.failed
      || typeof entry.hadDestination !== "boolean") {
      throw new Error("Derived variant bootstrap journal generation path is invalid.");
    }
    const desired = parseFingerprint(entry.desired, "promotion journal desired fingerprint");
    const previous = entry.previous === null ? null : parseFingerprint(entry.previous, "promotion journal prior fingerprint");
    if ((entry.hadDestination && previous === null) || (!entry.hadDestination && previous !== null)) {
      throw new Error("Derived variant bootstrap journal prior generation is invalid.");
    }
    return { ...wanted, hadDestination: entry.hadDestination, desired, previous };
  });
  const immutableNames = new Set<string>(VARIANT_IMMUTABLE_PROMOTION_NAMES);
  const expectedActive: VariantActiveReceipt = {
    version: value.version,
    id: value.id,
    userRoot,
    target,
    entries: entries
      .filter((entry) => value.version === LEGACY_VARIANT_PROMOTION_JOURNAL_VERSION || immutableNames.has(entry.name))
      .map((entry) => ({ name: entry.name, path: entry.destination, fingerprint: entry.desired })),
  };
  assertExactObjectKeys(value.activeReceipt, [
    "source", "destination", "archive", "failed", "hadDestination", "desired", "previous", "expected",
  ], "promotion journal active receipt");
  const activePaths = expectedActiveReceiptPaths(userRoot, value.id);
  if (value.activeReceipt.source !== activePaths.source
    || value.activeReceipt.destination !== activePaths.destination
    || value.activeReceipt.archive !== activePaths.archive
    || value.activeReceipt.failed !== activePaths.failed
    || typeof value.activeReceipt.hadDestination !== "boolean") {
    throw new Error("Derived variant bootstrap journal active receipt path is invalid.");
  }
  const activeDesired = parseFingerprint(value.activeReceipt.desired, "promotion journal active receipt fingerprint");
  const activePrevious = value.activeReceipt.previous === null
    ? null
    : parseFingerprint(value.activeReceipt.previous, "promotion journal prior active receipt fingerprint");
  if ((value.activeReceipt.hadDestination && activePrevious === null)
    || (!value.activeReceipt.hadDestination && activePrevious !== null)) {
    throw new Error("Derived variant bootstrap journal prior active receipt is invalid.");
  }
  parseActiveReceipt(value.activeReceipt.expected, expectedActive);
  return {
    version: value.version,
    id: value.id,
    userRoot,
    target,
    candidate: value.candidate,
    buildRoot: value.buildRoot,
    phase: value.phase,
    entries,
    activeReceipt: {
      ...activePaths,
      hadDestination: value.activeReceipt.hadDestination,
      desired: activeDesired,
      previous: activePrevious,
      expected: expectedActive,
    },
  };
}

interface ProvisionalRuntimeReadyBrokerAuthorityExpectation {
  globalRootState: "absent" | "valid-v3";
  configSha256: string | null;
}

interface ProvisionalRuntimeReadyExpectation {
  schemaVersion: 5;
  kind: "tweakers-independent-runtime-ready-expectation";
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  appRoot: string;
  bundleId: "com.therealityreport.tweakers";
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: ProvisionalRuntimeReadyBrokerAuthorityExpectation;
  appearanceExpectation: ProvisionalRuntimeReadyAppearanceBinding;
  expectedTweakIds: string[];
  createdAt: string;
}

interface ProvisionalRuntimeReadyAppearanceBinding {
  status: "normal";
  normalized: true;
}

function parseProvisionalRuntimeReadyExpectation(
  value: unknown,
  target: string,
): ProvisionalRuntimeReadyExpectation {
  assertExactObjectKeys(value, [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId",
    "appAsarHeaderHash", "runtimeFingerprint", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot",
    "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt",
  ], "runtime-ready expectation");
  const validId = (candidate: unknown): candidate is string => typeof candidate === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate);
  const validHash = (candidate: unknown): candidate is string => typeof candidate === "string"
    && /^[a-f0-9]{64}$/i.test(candidate);
  const validPath = (candidate: unknown): candidate is string => typeof candidate === "string"
    && isCanonicalAbsolutePath(candidate);
  assertExactObjectKeys(value.brokerAuthorityExpectation, ["globalRootState", "configSha256"], "runtime-ready broker authority expectation");
  const brokerAuthorityExpectation = value.brokerAuthorityExpectation;
  const validBrokerAuthorityExpectation = (brokerAuthorityExpectation.globalRootState === "absent"
    && brokerAuthorityExpectation.configSha256 === null)
    || (brokerAuthorityExpectation.globalRootState === "valid-v3"
      && typeof brokerAuthorityExpectation.configSha256 === "string"
      && /^[a-f0-9]{64}$/i.test(brokerAuthorityExpectation.configSha256));
  assertExactObjectKeys(value.appearanceExpectation, ["status", "normalized"], "runtime-ready appearance expectation");
  const appearanceExpectation = value.appearanceExpectation;
  const validAppearanceExpectation = appearanceExpectation.status === "normal"
    && appearanceExpectation.normalized === true;
  if (value.schemaVersion !== 5
    || value.kind !== "tweakers-independent-runtime-ready-expectation"
    || !validId(value.operationId)
    || !validId(value.promotionId)
    || !validHash(value.activePromotionReceiptSha256)
    || value.appRoot !== target
    || value.bundleId !== "com.therealityreport.tweakers"
    || !validHash(value.appAsarHeaderHash)
    || !validHash(value.runtimeFingerprint)
    || !validPath(value.appUserDataRoot)
    || !validPath(value.codexHomeRoot)
    || !validPath(value.accountsBrokerRoot)
    || !validBrokerAuthorityExpectation
    || !validAppearanceExpectation
    || !Array.isArray(value.expectedTweakIds)
    || value.expectedTweakIds.length === 0
    || value.expectedTweakIds.length > 128
    || new Set(value.expectedTweakIds).size !== value.expectedTweakIds.length
    || !value.expectedTweakIds.every((id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(id))
    || typeof value.createdAt !== "string"
    || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Derived variant bootstrap found an invalid runtime-ready expectation.");
  }
  return value as unknown as ProvisionalRuntimeReadyExpectation;
}

function assertProvisionalPendingGeneration(
  journal: VariantPromotionJournal,
  activePath: string | null,
  userRoot: string,
  target: string,
  fileSystem: TweakersVariantFilesystem,
): void {
  if (journal.phase !== "app:promoted") {
    throw new Error(`Derived variant bootstrap refuses pending promotion journal ${journal.id}.`);
  }
  const expectationPath = join(userRoot, "runtime-ready-expectation.json");
  if (!existsSync(expectationPath)) {
    throw new Error(`Derived variant bootstrap refuses pending promotion journal ${journal.id}.`);
  }
  assertNoSymlinkPathWithin(userRoot, expectationPath, "runtime-ready expectation");
  assertPrivateRegularFile(expectationPath, "derived variant runtime-ready expectation");
  let rawExpectation: unknown;
  try {
    rawExpectation = JSON.parse(readFileSync(expectationPath, "utf8")) as unknown;
  } catch {
    throw new Error("Derived variant bootstrap runtime-ready expectation is corrupt.");
  }
  const expectation = parseProvisionalRuntimeReadyExpectation(rawExpectation, target);
  if (expectation.promotionId !== journal.id) {
    throw new Error("Derived variant bootstrap runtime-ready expectation does not bind the pending promotion.");
  }

  assertPrivateRegularFile(journal.activeReceipt.source, "derived variant staged active receipt");
  let stagedActiveRaw: unknown;
  try {
    stagedActiveRaw = JSON.parse(readFileSync(journal.activeReceipt.source, "utf8")) as unknown;
  } catch {
    throw new Error("Derived variant bootstrap staged active receipt is corrupt.");
  }
  parseActiveReceipt(stagedActiveRaw, journal.activeReceipt.expected);
  const stagedActiveFingerprint = fingerprintTweakersVariantGeneration(journal.activeReceipt.source, fileSystem);
  if (!fingerprintsMatch(stagedActiveFingerprint, journal.activeReceipt.desired)
    || stagedActiveFingerprint.sha256 !== expectation.activePromotionReceiptSha256) {
    throw new Error("Derived variant bootstrap runtime-ready expectation does not bind the staged active receipt.");
  }

  if (journal.activeReceipt.hadDestination) {
    if (activePath === null || journal.activeReceipt.previous === null) {
      throw new Error("Derived variant bootstrap pending promotion lost its prior active receipt.");
    }
    const priorActiveFingerprint = fingerprintTweakersVariantGeneration(activePath, fileSystem);
    if (!fingerprintsMatch(priorActiveFingerprint, journal.activeReceipt.previous)) {
      throw new Error("Derived variant bootstrap pending promotion prior receipt changed.");
    }
  } else if (activePath !== null) {
    throw new Error("Derived variant bootstrap pending first promotion found an unexpected active receipt.");
  }

  for (const entry of journal.entries) {
    const actual = fingerprintTweakersVariantGeneration(entry.destination, fileSystem);
    if (!fingerprintsMatch(actual, entry.desired)) {
      throw new Error(`Derived variant bootstrap pending generation fingerprint mismatch: ${entry.name}`);
    }
  }
}

/**
 * Refuse a derived app before any tweak or app-server startup if its active
 * generation is not exactly committed and immutable. The broker calls this
 * after it has established the loader-provided user-root/runtime environment.
 */
export function assertTweakersVariantBootstrap(options: TweakersVariantBootstrapOptions = {}): void {
  const environment = options.environment ?? process.env;
  if (environment.TWEAKERS_DERIVED_VARIANT !== "1") return;
  const fileSystem = options.fileSystem ?? nodeVariantFilesystem;
  const userRoot = environment.TWEAKERS_USER_ROOT ?? environment.TWEAKER_USER_ROOT;
  const runtime = environment.TWEAKERS_RUNTIME ?? environment.TWEAKER_RUNTIME;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (!userRoot || !runtime || !resourcesPath
    || !isCanonicalAbsolutePath(userRoot)
    || !isCanonicalAbsolutePath(runtime)
    || !isCanonicalAbsolutePath(resourcesPath)) {
    throw new Error("Derived variant bootstrap is missing exact loader path bindings.");
  }
  const target = dirname(dirname(resourcesPath));
  if (runtime !== join(userRoot, "runtime") || !isCanonicalAbsolutePath(target)) {
    throw new Error("Derived variant bootstrap runtime binding does not match its user root.");
  }
  assertPrivateDirectory(userRoot, "derived variant user root");
  const journalRoot = join(userRoot, "transactions", "variant-promotion");
  assertNoSymlinkPathWithin(userRoot, journalRoot, "promotion journal");
  assertPrivateDirectory(journalRoot, "derived variant promotion journal root");
  const journals = new Map<string, VariantPromotionJournal>();
  let activePath: string | null = null;
  for (const entry of readdirSync(journalRoot, { withFileTypes: true })) {
    const path = join(journalRoot, entry.name);
    if (entry.name === "active.json") {
      assertPrivateRegularFile(path, "derived variant active receipt");
      activePath = path;
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json") || entry.name === "active.json") {
      throw new Error(`Derived variant bootstrap found an unexpected promotion journal entry: ${entry.name}`);
    }
    const id = entry.name.slice(0, -".json".length);
    assertVariantPromotionId(id);
    assertPrivateRegularFile(path, "derived variant promotion journal");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new Error(`Derived variant bootstrap found a corrupt promotion journal: ${entry.name}`);
    }
    const journal = parseJournal(raw, userRoot, target);
    if (journal.id !== id) throw new Error("Derived variant bootstrap journal filename does not match its transaction ID.");
    journals.set(journal.id, journal);
  }
  const pending = [...journals.values()].filter((journal) => journal.phase !== "committed" && journal.phase !== "recovered");
  if (pending.length > 0) {
    if (pending.length !== 1) {
      throw new Error("Derived variant bootstrap refuses multiple pending promotion journals.");
    }
    assertProvisionalPendingGeneration(pending[0]!, activePath, userRoot, target, fileSystem);
    return;
  }
  if (activePath === null) throw new Error("Derived variant bootstrap has no committed active generation receipt.");
  let activeRaw: unknown;
  try {
    activeRaw = JSON.parse(readFileSync(activePath, "utf8")) as unknown;
  } catch {
    throw new Error("Derived variant bootstrap active generation receipt is corrupt.");
  }
  assertExactObjectKeys(activeRaw, ["version", "id", "userRoot", "target", "entries"], "active receipt");
  const activeId = activeRaw.id;
  assertVariantPromotionId(activeId);
  const journal = journals.get(activeId);
  if (!journal || journal.phase !== "committed") {
    throw new Error("Derived variant bootstrap active receipt has no matching committed journal.");
  }
  const active = parseActiveReceipt(activeRaw, journal.activeReceipt.expected);
  const activeReceiptFingerprint = fingerprintTweakersVariantGeneration(activePath, fileSystem);
  if (!fingerprintsMatch(activeReceiptFingerprint, journal.activeReceipt.desired)) {
    throw new Error("Derived variant bootstrap active receipt fingerprint does not match its committed journal.");
  }
  for (const entry of active.entries) {
    // v2 receipts included mutable user preferences. Continue accepting an
    // already-committed v2 transaction, but never treat its config fingerprint
    // as an immutable startup gate. New v3 receipts omit config entirely.
    if (entry.name === "config.json") continue;
    const actual = fingerprintTweakersVariantGeneration(entry.path, fileSystem);
    if (!fingerprintsMatch(actual, entry.fingerprint)) {
      throw new Error(`Derived variant bootstrap generation fingerprint mismatch: ${entry.name}`);
    }
  }
}

/**
 * Schedule one bounded startup reconciliation after Electron is ready. A
 * missing visible window or launcher failure is diagnostic evidence only; it
 * must never abort the desktop app's module initialization.
 */
export function createDesktopUpdateStartupReconciler(
  dependencies: DesktopUpdateStartupDependencies,
  options: DesktopUpdateStartupOptions = {},
): { schedule(): boolean } {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 30));
  const retryMs = Math.max(0, Math.floor(options.retryMs ?? 1_000));
  let scheduled = false;

  const attempt = (attempts: number): void => {
    let ready = false;
    try {
      ready = dependencies.windowReady();
    } catch (error) {
      dependencies.onEvent({
        event: "desktop-update-startup-reconcile",
        result: "failed",
        attempts,
        ...errorEvidence(error),
      });
      return;
    }
    if (!ready) {
      if (attempts >= maxAttempts) {
        dependencies.onEvent({
          event: "desktop-update-startup-reconcile",
          result: "window-unavailable",
          attempts,
        });
        return;
      }
      dependencies.setTimer(() => attempt(attempts + 1), retryMs);
      return;
    }
    try {
      dependencies.launch();
      dependencies.onEvent({
        event: "desktop-update-startup-reconcile",
        result: "submitted",
        attempts,
      });
    } catch (error) {
      dependencies.onEvent({
        event: "desktop-update-startup-reconcile",
        result: "failed",
        attempts,
        ...errorEvidence(error),
      });
    }
  };

  return {
    schedule(): boolean {
      if (scheduled) return false;
      scheduled = true;
      dependencies.setTimer(() => attempt(1), 0);
      return true;
    },
  };
}

function errorEvidence(error: unknown): { error: string; errorCode?: string } {
  const record = error && typeof error === "object"
    ? error as { message?: unknown; code?: unknown }
    : null;
  return {
    error: typeof record?.message === "string" ? record.message : String(error),
    ...(typeof record?.code === "string" ? { errorCode: record.code } : {}),
  };
}

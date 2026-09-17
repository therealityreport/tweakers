/**
 * Code signing on macOS. After we mutate Info.plist or the Electron Framework
 * binary, the original signature is invalid. Re-signing with a stable local
 * identity keeps macOS privacy permissions attached to the patched app across
 * Tweakers repair runs on the same machine.
 *
 * `codesign --deep` does not reliably establish the required inside-out
 * signing order for every nested framework/helper, and it does not recurse
 * into `app.asar.unpacked` at all. Walk both locations first so every Mach-O
 * uses the same identity before the bundle wrappers and main app are signed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { readPlist, writePlist, type Plist } from "./plist.js";

export const DEFAULT_LOCAL_SIGNING_IDENTITY = "Tweakers Local Signing";
export const OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER = "2DC432GLL2";

export type SigningMode = "local-identity" | "adhoc";

export type SigningPosture = "strict" | "contained";

/**
 * strict = preserve the source's reviewed portable entitlements exactly.
 * contained = use the dedicated non-login keychain and add the one reviewed
 *              library-validation exception required by a no-Team-ID local
 *              identity to load its own re-signed Electron framework.
 */
export function resolveSigningPosture(
  explicit?: SigningPosture,
  env: NodeJS.ProcessEnv = process.env,
): SigningPosture {
  if (explicit === "strict" || explicit === "contained") return explicit;
  const raw = String(env.TWEAKERS_SIGNING_MODE ?? "").trim().toLowerCase();
  return raw === "strict" ? "strict" : "contained";
}

export interface CodeSigningResult {
  mode: SigningMode;
  identity: string;
  identityHash?: string;
  createdIdentity?: boolean;
}

export interface CodeSigningOptions {
  useLocalIdentity?: boolean;
  identityName?: string;
  preparedIdentity?: PreparedSigningIdentity | null;
  signingPosture?: SigningPosture;
  /** Exact installed backend whose signed bytes must remain registered during baseline maintenance. */
  retainedSignedBackend?: { sourcePath: string; sha256: string };
}

export interface PreparedSigningIdentity {
  name: string;
  hash: string;
  created: boolean;
  /** Dedicated keychain to pass directly to codesign without changing the user search list. */
  keychainPath?: string;
}

export interface SecurityCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface OpenAIDeveloperIdSourceTrustEvidence {
  signature: SignatureInfo;
  strictVerification: Pick<SecurityCommandResult, "status" | "stdout" | "stderr"> | { ok: boolean; output: string };
  gatekeeper: Pick<SecurityCommandResult, "status" | "stdout" | "stderr"> | { ok: boolean; output: string };
}

export type SecurityCommandRunner = (command: string, args: string[]) => SecurityCommandResult;

export interface UserKeychainPreferenceOptions {
  run?: SecurityCommandRunner;
}

function defaultSecurityRunner(command: string, args: string[]): SecurityCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

export interface RemoveLocalSigningIdentityOptions {
  identityName?: string;
  run?: SecurityCommandRunner;
  /** Injectable temp-cert writer for tests; returns a path to a PEM file. */
  writeTempCert?: (pem: string) => string;
}

const LOCKED_KEYCHAIN_SIGNING_ERROR =
  /User interaction is not allowed|errSecInternalComponent|keychain[^\n]*locked|locked[^\n]*keychain/i;

const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xfeedfacf, // 64-bit
  0xcffaedfe, // 64-bit LE
  0xcefaedfe, // 32-bit LE
  0xcafebabe, // FAT_MAGIC
  0xbebafeca, // FAT_CIGAM
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

export function signCodexApp(appRoot: string, opts: CodeSigningOptions = {}): CodeSigningResult | null {
  if (platform() !== "darwin") return null;

  const posture = resolveSigningPosture(opts.signingPosture);
  const useLocalIdentity = opts.useLocalIdentity !== false;
  const localIdentity = useLocalIdentity
    ? opts.preparedIdentity ?? ensureLocalSigningIdentity(opts.identityName ?? DEFAULT_LOCAL_SIGNING_IDENTITY, posture)
    : null;
  const signingIdentity = localIdentity?.hash ?? "-";
  const keychainArgs = codeSigningKeychainArgs(localIdentity);
  const expectedEntitlementsByTarget = new Map<string, Plist>();
  const portableSignature = localIdentity
    ? preparePortableSignature(appRoot, localIdentity.hash, posture)
    : null;
  if (portableSignature) expectedEntitlementsByTarget.set(appRoot, portableSignature.expectedEntitlements);

  // Step 1: pre-sign every nested Mach-O and code bundle inside-out with one
  // identity. Current desktop builds carry signed executables well beyond
  // Frameworks/app.asar.unpacked (notably Computer Use under Resources), so a
  // partial walk would leave OpenAI team-bound code inside the derived app.
  const nestedEntitlementsRoot = mkdtempSync(join(tmpdir(), "tweakers-nested-entitlements-"));
  const entitlementSequence = { value: 0 };
  try {
    for (const root of codeSigningWalkRoots(appRoot)) {
      walkAndSign(
        root,
        signingIdentity,
        keychainArgs,
        posture,
        nestedEntitlementsRoot,
        entitlementSequence,
        expectedEntitlementsByTarget,
      );
    }
    signNestedBundles(
      appRoot,
      signingIdentity,
      keychainArgs,
      posture,
      nestedEntitlementsRoot,
      entitlementSequence,
      expectedEntitlementsByTarget,
    );
  } finally {
    rmSync(nestedEntitlementsRoot, { recursive: true, force: true });
  }

  if (opts.retainedSignedBackend) {
    if (!localIdentity) throw new Error("Retaining an installed backend requires its exact local signing identity");
    restoreVerifiedSignedBackend(appRoot, opts.retainedSignedBackend, localIdentity.hash);
  }

  // Step 2: sign the outer bundle only after its nested code. `--deep` can
  // overwrite a deliberate child signature and obscure an unsafe entitlement,
  // so the final outer signing pass never delegates child traversal to
  // codesign.
  try {
    const args = [
      "--force",
      "--sign",
      signingIdentity,
      ...keychainArgs,
      "--preserve-metadata=flags",
      ...(portableSignature
        ? [
          "--entitlements",
          portableSignature.entitlementsPath,
          ...(portableSignature.requirement === null
            ? []
            : ["--requirements", `=${portableSignature.requirement}`]),
        ]
        : []),
      appRoot,
    ];
    execFileSync(
      "codesign",
      args,
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    // macOS applies an app bundle's final process entitlement set to its
    // declared CFBundleExecutable. A pre-Electron Tweakers wrapper is that
    // executable, so its earlier child-only contained expectation is no
    // longer authoritative after this final pass. Record the exact final
    // outer set instead of weakening the audit or re-signing the wrapper
    // afterwards (which would invalidate the outer bundle seal).
    if (portableSignature) {
      expectedEntitlementsByTarget.set(
        declaredAppExecutablePath(appRoot),
        portableSignature.expectedEntitlements,
      );
    }
  } finally {
    if (portableSignature) rmSync(portableSignature.tempRoot, { recursive: true, force: true });
  }

  if (localIdentity) auditLocallySignedApp(appRoot, localIdentity.name, expectedEntitlementsByTarget);

  return localIdentity
    ? {
        mode: "local-identity",
        identity: localIdentity.name,
        identityHash: localIdentity.hash,
        createdIdentity: localIdentity.created,
      }
    : { mode: "adhoc", identity: "-" };
}

/** Restore only certificate-pinned signed bytes before the outer bundle seal; never after signing. */
export function restoreVerifiedSignedBackend(appRoot: string, binding: { sourcePath: string; sha256: string }, signingIdentityHash: string,
  deps: { certificate?: typeof codeSigningCertificateLeafHash; verify?: typeof verifySignature; copy?: typeof copyFileSync } = {}): void {
  const source = binding.sourcePath, target = join(appRoot, "Contents", "Resources", "codex");
  if (!isAbsolute(source) || resolve(source) !== source || !/^[a-f0-9]{64}$/.test(binding.sha256)) throw new Error("Invalid retained backend binding");
  const sourceStat = lstatSync(source), targetStat = lstatSync(target);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("Retained backend must use physical regular files");
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sha(source) !== binding.sha256 || (deps.certificate ?? codeSigningCertificateLeafHash)(source).toUpperCase() !== signingIdentityHash.toUpperCase()
    || !(deps.verify ?? verifySignature)(source).ok) throw new Error("Retained backend signature or bytes changed");
  (deps.copy ?? copyFileSync)(source, target);
  if (sha(source) !== binding.sha256 || sha(target) !== binding.sha256 || !(deps.verify ?? verifySignature)(target).ok) throw new Error("Retained backend copy did not verify");
}

/**
 * These are bound either to the original Apple Team ID or to that team's
 * provisioning profile. They cannot be carried over to a locally signed app.
 */
const NON_PORTABLE_ENTITLEMENTS = new Set([
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
  "com.apple.security.application-groups",
  "keychain-access-groups",
  "com.apple.developer.aps-environment",
]);

/**
 * These entitlement keys have no embedded Team ID, application identifier,
 * keychain group, or provisioning-profile binding. Keep this list narrow: a
 * newly observed key must be reviewed rather than carried into the locally
 * signed derived app by default.
 */
export const PORTABLE_ENTITLEMENT_KEYS = new Set([
  "com.apple.security.app-sandbox",
  "com.apple.security.automation.apple-events",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.device.audio-input",
  "com.apple.security.device.camera",
  "com.apple.security.files.user-selected.read-write",
  "com.apple.security.get-task-allow",
  "com.apple.security.network.client",
  "com.apple.security.personal-information.addressbook",
  "com.apple.security.personal-information.calendars",
]);

function preparePortableSignature(appRoot: string, identityHash: string, posture: SigningPosture): {
  tempRoot: string;
  entitlementsPath: string;
  requirement: string | null;
  expectedEntitlements: Plist;
} {
  const info = readPlist(join(appRoot, "Contents", "Info.plist"));
  const identifier = String(info.CFBundleIdentifier ?? "");
  const signatureSource = portableOuterSignatureSource(appRoot, info);
  const requirementResult = spawnSync("codesign", ["-d", "-r-", signatureSource], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const originalRequirement = `${requirementResult.stdout ?? ""}${requirementResult.stderr ?? ""}`
    .split(/\r?\n/)
    .find((line) => line.startsWith("designated => "));
  // codesign still emits intact embedded entitlements after app.asar changes invalidate the seal.
  const sourceEntitlements = readEmbeddedEntitlements(signatureSource) ?? {};
  const expectedEntitlements = portableEntitlements(sourceEntitlements, posture);

  const tempRoot = mkdtempSync(join(tmpdir(), "tweakers-entitlements-"));
  const entitlementsPath = join(tempRoot, "portable.plist");
  writePlist(entitlementsPath, expectedEntitlements);
  return {
    tempRoot,
    entitlementsPath,
    requirement: originalRequirement && /^[A-Za-z0-9.-]+$/.test(identifier)
      ? stableDesignatedRequirement(originalRequirement, identifier, identityHash)
      : null,
    expectedEntitlements,
  };
}

/**
 * A derived Tweakers bundle can place a tiny pre-Electron launcher at the
 * declared executable path. The preserved upstream executable remains the
 * authority for the outer process's original requirement and entitlements.
 * A present but malformed marker must never fall back to the wrapper.
 */
function portableOuterSignatureSource(appRoot: string, info: Plist): string {
  const marker = info.TweakersOriginalExecutable;
  if (marker === undefined) return appRoot;
  if (typeof marker !== "string" || marker.length === 0 || marker.includes("/") || marker === "." || marker === "..") {
    throw new Error("Tweakers preserved executable marker is unsafe.");
  }
  const source = join(appRoot, "Contents", "MacOS", marker);
  if (!existsSync(source)) throw new Error(`Tweakers preserved executable is missing: ${source}`);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`Tweakers preserved executable is not a safe executable file: ${source}`);
  }
  return source;
}

/** Resolve the exact process binary that macOS re-signs with outer app entitlements. */
function declaredAppExecutablePath(appRoot: string): string {
  const info = readPlist(join(appRoot, "Contents", "Info.plist"));
  const executable = info.CFBundleExecutable;
  if (typeof executable !== "string" || executable.length === 0 || executable.includes("/")
      || executable === "." || executable === "..") {
    throw new Error("Tweakers declared executable is unsafe.");
  }
  const path = join(appRoot, "Contents", "MacOS", executable);
  if (!existsSync(path)) throw new Error(`Tweakers declared executable is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`Tweakers declared executable is not a safe executable file: ${path}`);
  }
  return path;
}

/**
 * Preserve only reviewed portable entitlements. Known OpenAI team,
 * application, keychain, and provisioning-bound keys are excluded from the
 * derived signature; an unknown key still fails closed rather than crossing
 * the source boundary unreviewed.
 */
export function portableEntitlements(entitlements: Plist, _posture: SigningPosture = "strict"): Plist {
  return portableProcessEntitlements(entitlements, _posture);
}

/**
 * Nested Electron helper processes use the same narrow contained-signing
 * exception as the outer app. Loadable libraries themselves receive no
 * process entitlements; portableEntitlementsForCode enforces that boundary.
 */
export function portableNestedEntitlements(
  entitlements: Plist,
  _posture: SigningPosture = "strict",
): Plist {
  return portableProcessEntitlements(entitlements, _posture);
}

/**
 * Audit an already-signed target. Team-bound keys are invalid here because
 * filtering is allowed only before signing; the final signature must contain
 * the returned portable set exactly.
 */
export function assertPortableEntitlements(entitlements: Plist): Plist {
  const portable: Plist = {};
  for (const [key, value] of Object.entries(entitlements)) {
    if (NON_PORTABLE_ENTITLEMENTS.has(key)) {
      throw new Error(`Non-portable team, application, keychain, or provisioning entitlement: ${key}`);
    }
    if (!PORTABLE_ENTITLEMENT_KEYS.has(key)) {
      throw new Error(`Unreviewed non-portable entitlement: ${key}`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`Portable entitlement must be a boolean: ${key}`);
    }
    portable[key] = value;
  }
  return portable;
}

function filterPortableEntitlements(entitlements: Plist): Plist {
  const portable: Plist = {};
  for (const [key, value] of Object.entries(entitlements)) {
    if (NON_PORTABLE_ENTITLEMENTS.has(key)) continue;
    if (!PORTABLE_ENTITLEMENT_KEYS.has(key)) {
      throw new Error(`Unreviewed non-portable entitlement: ${key}`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`Portable entitlement must be a boolean: ${key}`);
    }
    portable[key] = value;
  }
  return portable;
}

function portableProcessEntitlements(entitlements: Plist, posture: SigningPosture): Plist {
  const portable = filterPortableEntitlements(entitlements);
  if (posture !== "contained") return portable;

  const libraryValidation = portable["com.apple.security.cs.disable-library-validation"];
  if (libraryValidation !== undefined && libraryValidation !== true) {
    throw new Error("Contained local signing cannot override an explicit false library-validation entitlement.");
  }
  portable["com.apple.security.cs.disable-library-validation"] = true;
  return portable;
}

export function codeSigningWalkRoots(appRoot: string): string[] {
  return [join(appRoot, "Contents")];
}

const CODE_BUNDLE_SUFFIXES = [".app", ".xpc", ".framework", ".bundle", ".plugin", ".docktileplugin"];

/** `.dSYM` DWARF payloads may begin with a Mach-O magic but are debug data, not signable runtime code. */
export function isCodeSigningTraversalDirectory(name: string): boolean {
  return !name.endsWith(".dSYM");
}

/** SwiftPM also emits resource-only `.bundle` directories with no executable or signature. */
export function isNestedCodeBundle(path: string): boolean {
  if (!path.endsWith(".bundle")) {
    return CODE_BUNDLE_SUFFIXES.some((suffix) => path.endsWith(suffix));
  }
  for (const infoPath of [join(path, "Contents", "Info.plist"), join(path, "Resources", "Info.plist"), join(path, "Info.plist")]) {
    if (!existsSync(infoPath)) continue;
    try {
      const executable = readPlist(infoPath).CFBundleExecutable;
      return typeof executable === "string" && executable.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** Only MH_EXECUTE processes carry enforceable process entitlements after local signing. */
export function machOAcceptsProcessEntitlements(path: string): boolean {
  const inspected = spawnSync("file", ["-b", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (inspected.status !== 0 || inspected.error) {
    throw new Error(`Failed to inspect Mach-O file type for ${path}: ${String(inspected.stderr ?? inspected.error?.message ?? "unknown error").trim()}`);
  }
  const description = String(inspected.stdout ?? "").trim().toLowerCase();
  if (!description.includes("mach-o")) throw new Error(`Mach-O file type was not reported for ${path}: ${description}`);
  const loadable = description.includes("bundle") || description.includes("dynamically linked shared library");
  const executable = description.includes("executable");
  if (!loadable && !executable) throw new Error(`Unsupported Mach-O file type for ${path}: ${description}`);
  return executable && !loadable;
}

/**
 * Enumerate every nested code wrapper below `Contents`, deepest first. This
 * excludes SwiftPM resource-only `.bundle` wrappers: they have no executable
 * or source signature and are data belonging to their enclosing code object.
 */
function collectNestedCodeBundles(appRoot: string): string[] {
  const bundles: string[] = [];
  const visit = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const name of entries) {
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (!isCodeSigningTraversalDirectory(name)) continue;
      visit(path);
      if (isNestedCodeBundle(path)) bundles.push(path);
    }
  };
  visit(join(appRoot, "Contents"));
  return bundles.sort((left, right) => right.split("/").length - left.split("/").length || left.localeCompare(right));
}

function collectMachOFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const name of entries) {
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && isCodeSigningTraversalDirectory(name)) visit(path);
      else if (stat.isFile() && isMachO(path)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

/**
 * Final local-only audit. Each nested wrapper and Mach-O must pass strict
 * verification, identify as the selected local certificate, and carry no
 * entitlement outside the portable allowlist.
 */
function auditLocallySignedApp(
  appRoot: string,
  identityName: string,
  expectedEntitlementsByTarget: ReadonlyMap<string, Plist>,
): void {
  const targets = new Set([
    ...collectMachOFiles(join(appRoot, "Contents")),
    ...collectNestedCodeBundles(appRoot),
    appRoot,
  ]);
  const failures: string[] = [];
  for (const target of [...targets].sort()) {
    const strict = verifySignature(target);
    if (!strict.ok) {
      failures.push(`${target}: strict signature verification failed: ${strict.output}`);
      continue;
    }
    const signature = signatureInfo(target);
    if (!isLocallySignedWithIdentity(signature, identityName)) {
      failures.push(`${target}: not signed by local identity ${identityName}`);
      continue;
    }
    try {
      const expected = expectedEntitlementsByTarget.get(target);
      if (expected === undefined) {
        throw new Error("missing source-derived entitlement expectation");
      }
      const actual = assertPortableEntitlements(readEmbeddedEntitlements(target) ?? {});
      assertExactPortableEntitlements(expected, actual);
    } catch (error) {
      failures.push(`${target}: ${signingErrorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Tweakers local signing audit failed for ${failures.length} target${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
  }
}

/** A local certificate has no Apple TeamIdentifier; Authority is its binding. */
export function isLocallySignedWithIdentity(signature: SignatureInfo, identityName: string): boolean {
  return signature.ok && !signature.adHoc && signature.authority.includes(identityName);
}

/** Compare semantic entitlement dictionaries after both have passed the allowlist. */
export function assertExactPortableEntitlements(expected: Plist, actual: Plist): void {
  const expectedPortable = assertPortableEntitlements(expected);
  const actualPortable = assertPortableEntitlements(actual);
  const expectedCanonical = canonicalPortableEntitlements(expectedPortable);
  const actualCanonical = canonicalPortableEntitlements(actualPortable);
  if (expectedCanonical !== actualCanonical) {
    throw new Error(`Final portable entitlements did not match the source-derived expected set (expected ${expectedCanonical}, actual ${actualCanonical})`);
  }
}

function canonicalPortableEntitlements(entitlements: Plist): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(entitlements).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

export function stableDesignatedRequirement(
  originalRequirement: string,
  identifier: string,
  identityHash: string,
): string {
  const original = originalRequirement.replace(/^designated =>\s*/, "");
  return `designated => (${original}) or (identifier "${identifier}" and certificate leaf = H"${identityHash}")`;
}

export function adHocSign(appRoot: string): void {
  signCodexApp(appRoot, { useLocalIdentity: false });
}

export function prepareCodeSigning(opts: CodeSigningOptions = {}): PreparedSigningIdentity | null {
  if (platform() !== "darwin") return null;

  requireExecutable("codesign", "macOS codesign is required to re-sign Codex.app after patching.");
  if (opts.useLocalIdentity === false) return null;

  requireExecutable("security", "macOS security is required to find Tweakers's local signing identity.");

  const posture = resolveSigningPosture(opts.signingPosture);
  const identityName = opts.identityName ?? DEFAULT_LOCAL_SIGNING_IDENTITY;
  if (posture === "contained") {
    const containedKeychain = containedSigningKeychainPath();
    if (existsSync(containedKeychain)) {
      const contained = findCodeSigningIdentity(identityName, containedKeychain);
      if (contained) return { ...contained, created: false };
    }
  }
  const existing = findCodeSigningIdentity(identityName);
  if (existing) return { ...existing, created: false };

  requireExecutable("openssl", "macOS openssl is required to create Tweakers's local signing identity.");
  return createLocalSigningIdentity(identityName, posture);
}

/**
 * Select an already-provisioned local signing identity without ever creating,
 * importing, trusting, unlocking, or changing keychain state. Candidate-only
 * preparation uses this narrow reader so its private package is the first
 * mutable filesystem location in that flow.
 */
export function findExistingPreparedSigningIdentity(
  opts: Pick<CodeSigningOptions, "identityName" | "signingPosture"> = {},
): PreparedSigningIdentity {
  if (platform() !== "darwin") {
    throw new Error("An existing Tweakers Local Signing identity is available only on macOS.");
  }
  requireExecutable("codesign", "macOS codesign is required to sign a candidate receipt bundle.");
  requireExecutable("security", "macOS security is required to find Tweakers's existing local signing identity.");

  const identityName = opts.identityName ?? DEFAULT_LOCAL_SIGNING_IDENTITY;
  const posture = resolveSigningPosture(opts.signingPosture);
  if (posture === "contained") {
    const keychainPath = containedSigningKeychainPath();
    if (existsSync(keychainPath)) {
      const contained = findCodeSigningIdentities(identityName, keychainPath);
      if (contained.length === 1) return { ...contained[0]!, created: false, keychainPath };
      if (contained.length > 1) {
        throw new Error(`Tweakers Local Signing identity is ambiguous in the configured contained keychain: ${identityName}`);
      }
    }
  }
  const identities = findCodeSigningIdentities(identityName);
  if (identities.length === 0) {
    throw new Error(`An existing Tweakers Local Signing identity is required for candidate-only preparation: ${identityName}`);
  }
  if (identities.length !== 1) {
    throw new Error(`Tweakers Local Signing identity is ambiguous in the configured signing posture: ${identityName}`);
  }
  return { ...identities[0]!, created: false };
}

export const CANDIDATE_RECEIPT_BUNDLE_IDENTIFIER = "co.tweakers.candidate-receipt";
export const CANDIDATE_RECEIPT_SIGN_TIMEOUT_MS = 15_000;

function normalizedCertificateLeafHash(value: string, label: string): string {
  if (!/^[A-Fa-f0-9]{40}$/.test(value)) throw new Error(`${label} is not an exact SHA-1 certificate leaf hash.`);
  return value.toUpperCase();
}

/** Parse the only certificate fact that can satisfy an external leaf-hash pin. */
export function parseCertificateLeafHashRequirement(output: string): string | null {
  const match = /certificate\s+leaf\s*=\s*H"([A-Fa-f0-9]{40})"/i.exec(output);
  return match ? match[1]!.toUpperCase() : null;
}

/** Read the signed designated requirement; this never selects an identity. */
export function codeSigningCertificateLeafHash(path: string): string {
  const result = spawnSync("codesign", ["-d", "-r-", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CANDIDATE_RECEIPT_SIGN_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to read code-signing designated requirement: ${String(result.stderr ?? result.error ?? "codesign failed").trim()}`);
  }
  const leaf = parseCertificateLeafHashRequirement(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (!leaf) throw new Error("Code-signing designated requirement does not pin an exact certificate leaf hash.");
  return leaf;
}

/**
 * Sign a resource-only receipt bundle with an externally prepared identity.
 * No CMS, certificate-name lookup, or ordinary colocated digest participates
 * in this authenticity boundary.
 */
export function signCandidateReceiptResourceBundle(
  bundlePath: string,
  preparedIdentity: PreparedSigningIdentity,
  bundleIdentifier = CANDIDATE_RECEIPT_BUNDLE_IDENTIFIER,
): void {
  if (preparedIdentity.created || preparedIdentity.name !== DEFAULT_LOCAL_SIGNING_IDENTITY) {
    throw new Error("Candidate receipt signing requires one preexisting Tweakers Local Signing identity.");
  }
  const hash = normalizedCertificateLeafHash(preparedIdentity.hash, "Prepared signing identity hash");
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) throw new Error("Candidate receipt bundle identifier is invalid.");
  const result = spawnSync("codesign", [
    "--force",
    "--sign",
    hash,
    ...codeSigningKeychainArgs(preparedIdentity),
    "--requirements",
    `=designated => identifier "${bundleIdentifier}" and certificate leaf = H"${hash}"`,
    bundlePath,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CANDIDATE_RECEIPT_SIGN_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    const reason = String(result.stderr ?? result.error ?? "codesign failed").trim();
    const timeout = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw new Error(`Candidate receipt resource bundle signing ${timeout ? "timed out" : "failed"}: ${reason}`);
  }
  verifyCandidateReceiptResourceBundle(bundlePath, hash);
}

/** Strictly validate a receipt bundle against a caller-owned leaf-hash pin. */
export function verifyCandidateReceiptResourceBundle(bundlePath: string, expectedSigningIdentityHash: string): void {
  const expected = normalizedCertificateLeafHash(expectedSigningIdentityHash, "Expected signing identity hash");
  const result = spawnSync("codesign", ["--verify", "--strict", bundlePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CANDIDATE_RECEIPT_SIGN_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Candidate receipt resource bundle failed strict verification: ${String(result.stderr ?? result.error ?? "codesign failed").trim()}`);
  }
  const observed = codeSigningCertificateLeafHash(bundlePath);
  if (observed !== expected) {
    throw new Error("Candidate receipt resource bundle certificate leaf hash does not match the external expected signing identity hash.");
  }
}

export function removeLocalSigningIdentity(opts: RemoveLocalSigningIdentityOptions = {}): void {
  const identityName = opts.identityName ?? DEFAULT_LOCAL_SIGNING_IDENTITY;
  const run = opts.run ?? defaultSecurityRunner;

  // Remove the user-domain trust setting while the certificate still exists.
  // The original add-trusted-cert call used the user domain (no -d).
  try {
    const found = run("security", ["find-certificate", "-c", identityName, "-a", "-p"]);
    const pem = found.stdout.trim();
    if (found.status === 0 && pem) {
      const certPath = (opts.writeTempCert ?? writeTempPem)(pem);
      try {
        run("security", ["remove-trusted-cert", certPath]);
      } finally {
        if (!opts.writeTempCert) {
          try {
            rmSync(dirname(certPath), { recursive: true, force: true });
          } catch {
            // Best-effort cleanup must never fail uninstall.
          }
        }
      }
    }
  } catch {
    // Best-effort trust removal must never fail uninstall.
  }

  // delete-identity removes both the certificate and its private key.
  try {
    run("security", ["delete-identity", "-c", identityName]);
  } catch {
    // Best-effort cleanup: the identity may already be gone.
  }

  const containedKeychain = containedSigningKeychainPath();
  if (existsSync(containedKeychain)) {
    try {
      run("security", ["delete-keychain", containedKeychain]);
    } catch {
      // Best-effort cleanup: the contained keychain may already be gone.
    }
  }
}

function writeTempPem(pem: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tweakers-cert-"));
  const path = join(dir, "identity.pem");
  writeFileSync(path, pem);
  return path;
}

/**
 * Proves that the existing local identity can sign in the current process
 * context. Unlike prepareCodeSigning(), this probe never creates or imports an
 * identity: watcher repair must defer when the login keychain is unavailable.
 */
export function signingAvailable(opts: { identityName?: string } = {}): boolean {
  if (platform() !== "darwin") return false;

  const identityName = opts.identityName ?? DEFAULT_LOCAL_SIGNING_IDENTITY;
  const containedKeychain = containedSigningKeychainPath();
  const identity = existsSync(containedKeychain)
    ? findCodeSigningIdentity(identityName, containedKeychain) ?? findCodeSigningIdentity(identityName)
    : findCodeSigningIdentity(identityName);
  if (!identity) return false;

  const dir = mkdtempSync(join(tmpdir(), "tweakers-signing-probe-"));
  const scratch = join(dir, "probe");
  try {
    // codesign needs a real code object; a copied system Mach-O is small,
    // disposable, and exercises private-key access without touching its source.
    copyFileSync("/usr/bin/true", scratch);
    const result = spawnSync(
      "codesign",
      ["--sign", identity.hash, ...codeSigningKeychainArgs(identity), "--force", scratch],
      {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 750,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    if (LOCKED_KEYCHAIN_SIGNING_ERROR.test(output)) return false;
    return result.status === 0 && result.error === undefined;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walkAndSign(
  root: string,
  signingIdentity: string,
  keychainArgs: string[],
  posture: SigningPosture,
  entitlementsRoot: string,
  entitlementSequence: { value: number },
  expectedEntitlementsByTarget: Map<string, Plist>,
): void {
  const failures: string[] = [];
  walkAndSignInto(
    root,
    root,
    signingIdentity,
    keychainArgs,
    posture,
    entitlementsRoot,
    entitlementSequence,
    expectedEntitlementsByTarget,
    failures,
  );
  if (failures.length > 0) {
    throw new Error(
      `Failed to sign ${failures.length} Mach-O file${failures.length === 1 ? "" : "s"} under ${root}:\n${failures.map((failure) => `  ${failure}`).join("\n")}`,
    );
  }
}

function walkAndSignInto(
  root: string,
  current: string,
  signingIdentity: string,
  keychainArgs: string[],
  posture: SigningPosture,
  entitlementsRoot: string,
  entitlementSequence: { value: number },
  expectedEntitlementsByTarget: Map<string, Plist>,
  failures: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(current, name);
    if (!isInsideCodeSigningRoot(root, full)) continue;
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!isCodeSigningTraversalDirectory(name)) continue;
      walkAndSignInto(
        root,
        full,
        signingIdentity,
        keychainArgs,
        posture,
        entitlementsRoot,
        entitlementSequence,
        expectedEntitlementsByTarget,
        failures,
      );
      continue;
    }
    if (!st.isFile()) continue;
    if (!isMachO(full)) continue;
    try {
      const entitlements = portableEntitlementsForCode(
        full,
        posture,
        entitlementsRoot,
        entitlementSequence,
        expectedEntitlementsByTarget,
      );
      execFileSync(
        "codesign",
        [
          "--force",
          "--sign",
          signingIdentity,
          ...keychainArgs,
          "--preserve-metadata=flags",
          ...(entitlements ? ["--entitlements", entitlements] : []),
          full,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      failures.push(`${full}: ${signingErrorMessage(e)}`);
    }
  }
}

function signNestedBundles(
  appRoot: string,
  signingIdentity: string,
  keychainArgs: string[],
  posture: SigningPosture,
  entitlementsRoot: string,
  entitlementSequence: { value: number },
  expectedEntitlementsByTarget: Map<string, Plist>,
): void {
  const failures: string[] = [];
  for (const bundle of collectNestedCodeBundles(appRoot)) {
    try {
      const entitlements = portableEntitlementsForCode(
        bundle,
        posture,
        entitlementsRoot,
        entitlementSequence,
        expectedEntitlementsByTarget,
      );
      execFileSync("codesign", [
        "--force", "--sign", signingIdentity, ...keychainArgs, "--preserve-metadata=flags",
        ...(entitlements ? ["--entitlements", entitlements] : []), bundle,
      ], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      failures.push(`${bundle}: ${signingErrorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to sign ${failures.length} nested code bundle${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
  }
}

function portableEntitlementsForCode(
  code: string,
  posture: SigningPosture,
  root: string,
  sequence: { value: number },
  expectedEntitlementsByTarget: Map<string, Plist>,
): string {
  const sourceEntitlements = readEmbeddedEntitlements(code) ?? {};
  // codesign intentionally omits process entitlements from MH_DYLIB and
  // MH_BUNDLE outputs. Their effective permissions belong to the executable
  // process that loads them, so expecting the source's blanket metadata here
  // would make a valid locally signed candidate fail its exact audit.
  const stat = lstatSync(code);
  const acceptsProcessEntitlements = stat.isFile() && isMachO(code)
    ? machOAcceptsProcessEntitlements(code)
    : stat.isDirectory() && (code.endsWith(".app") || code.endsWith(".xpc"));
  const entitlements = acceptsProcessEntitlements
    ? portableNestedEntitlements(sourceEntitlements, posture)
    : {};
  expectedEntitlementsByTarget.set(code, entitlements);
  const id = sequence.value++;
  const portable = join(root, `${id}.portable.plist`);
  writePlist(portable, entitlements);
  return portable;
}

function readEmbeddedEntitlements(code: string): Plist | null {
  const extracted = spawnSync("codesign", ["-d", "--entitlements", ":-", code], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const xml = parseEmbeddedEntitlementsExtraction(extracted, code);
  if (xml === null) return null;
  const tempRoot = mkdtempSync(join(tmpdir(), "tweakers-read-entitlements-"));
  const path = join(tempRoot, "embedded.plist");
  try {
    writeFileSync(path, xml);
    return readPlist(path);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function parseEmbeddedEntitlementsExtraction(
  result: { status: number | null; stdout?: unknown; stderr?: unknown; error?: unknown },
  code: string,
): string | null {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const error = result.error instanceof Error ? result.error.message : String(result.error ?? "").trim();
  if (result.status !== 0 || error) {
    const detail = [stderr, stdout, error].filter(Boolean).join("\n");
    throw new Error(`Failed to extract embedded entitlements from ${code}${detail ? `: ${detail}` : ""}`);
  }
  if (!stdout) return null;
  if (!stdout.startsWith("<?xml") && !stdout.startsWith("<plist")) {
    throw new Error(`Embedded entitlement extraction returned non-plist output for ${code}`);
  }
  return stdout;
}

export function isInsideCodeSigningRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

function signingErrorMessage(e: unknown): string {
  const err = e as { stderr?: Buffer | string; message?: string };
  return String(err.stderr ?? err.message ?? e).trim() || "codesign failed";
}

function ensureLocalSigningIdentity(identityName: string, posture: SigningPosture): PreparedSigningIdentity {
  return prepareCodeSigning({ identityName, signingPosture: posture }) ?? (() => {
    throw new Error(`Local signing identity "${identityName}" is only available on macOS.`);
  })();
}

function findCodeSigningIdentity(
  identityName: string,
  keychainPath?: string,
): Omit<PreparedSigningIdentity, "created"> | null {
  return findCodeSigningIdentities(identityName, keychainPath)[0] ?? null;
}

function findCodeSigningIdentities(
  identityName: string,
  keychainPath?: string,
): Array<Omit<PreparedSigningIdentity, "created">> {
  const args = ["find-identity", "-v", "-p", "codesigning"];
  if (keychainPath) args.push(keychainPath);
  const result = spawnSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return parseCodeSigningIdentities(output)
    .filter((candidate) => candidate.name === identityName)
    .map((candidate) => ({ ...candidate, ...(keychainPath ? { keychainPath } : {}) }));
}

function createLocalSigningIdentity(identityName: string, posture: SigningPosture): PreparedSigningIdentity {
  const create = () => createLocalSigningIdentityUnprotected(identityName, posture);
  return posture === "contained" ? withRestoredUserKeychainPreferences(create) : create();
}

function createLocalSigningIdentityUnprotected(
  identityName: string,
  posture: SigningPosture,
): PreparedSigningIdentity {
  const dir = mkdtempSync(join(tmpdir(), "tweaker-signing-"));
  try {
    const configPath = join(dir, "openssl.cnf");
    const keyPath = join(dir, "identity.key");
    const certPath = join(dir, "identity.crt");
    const p12Path = join(dir, "identity.p12");
    const keychain = posture === "contained" ? ensureContainedSigningKeychain() : defaultUserKeychain();
    const p12Password = createPkcs12Password();

    writeFileSync(
      configPath,
      [
        "[req]",
        "distinguished_name=req_distinguished_name",
        "x509_extensions=v3_req",
        "prompt=no",
        "",
        "[req_distinguished_name]",
        `CN=${identityName}`,
        "",
        "[v3_req]",
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=codeSigning",
        "",
      ].join("\n"),
    );

    execFileSync("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-x509",
      "-sha256",
      "-days",
      "3650",
      "-nodes",
      "-config",
      configPath,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ], { stdio: "ignore" });

    execFileSyncRedacted("openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      keyPath,
      "-in",
      certPath,
      "-name",
      identityName,
      "-out",
      p12Path,
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1",
      "-passout",
      `pass:${p12Password}`,
    ], { stdio: ["ignore", "ignore", "pipe"] }, [p12Password]);

    execFileSyncRedacted("security", [
      "import",
      p12Path,
      "-k",
      keychain,
      "-P",
      p12Password,
      "-T",
      "/usr/bin/codesign",
    ], { stdio: ["ignore", "ignore", "pipe"] }, [p12Password]);

    if (posture === "contained") {
      execFileSync("security", [
        "add-trusted-cert",
        "-r",
        "trustRoot",
        "-p",
        "codeSign",
        "-k",
        keychain,
        certPath,
      ], { stdio: "ignore" });
    }
    // Strict relies on stableDesignatedRequirement plus quarantine clearing,
    // without a trusted root. If find-identity cannot see the untrusted identity
    // on a real device, the guarded run can flip to contained mode.

    const created = findCodeSigningIdentity(identityName, posture === "contained" ? keychain : undefined);
    if (!created) {
      throw new Error("created certificate was not found as a valid code signing identity");
    }
    return { ...created, created: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to create local signing identity "${identityName}": ${message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createPkcs12Password(): string {
  return randomBytes(24).toString("base64url");
}

export function containedSigningKeychainPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME && env.HOME.trim() ? env.HOME : homedir();
  return join(home, "Library", "Keychains", "tweakers-signing.keychain-db");
}

function ensureContainedSigningKeychain(): string {
  const keychain = containedSigningKeychainPath();
  const password = createPkcs12Password();

  try {
    execFileSyncRedacted(
      "security",
      ["create-keychain", "-p", password, keychain],
      { stdio: ["ignore", "ignore", "pipe"] },
      [password],
    );
  } catch (error) {
    if (!existsSync(keychain)) throw error;
  }

  execFileSync("security", ["set-keychain-settings", keychain], { stdio: "ignore" });
  execFileSyncRedacted(
    "security",
    ["unlock-keychain", "-p", password, keychain],
    { stdio: ["ignore", "ignore", "pipe"] },
    [password],
  );

  return keychain;
}

interface UserKeychainPreferences {
  searchList: string[];
  defaultKeychain: string | null;
}

/**
 * Contains any preference changes made implicitly by `security create-keychain`.
 * Restoration is attempted after both successful and failed actions, and the
 * final state is read back before returning. A pre-existing null default fails
 * closed before the action: choosing a replacement default requires separate
 * user authorization and must not be hidden inside disposable signing work.
 */
export function withRestoredUserKeychainPreferences<T>(
  action: () => T,
  opts: UserKeychainPreferenceOptions = {},
): T {
  const run = opts.run ?? defaultSecurityRunner;
  const before = readUserKeychainPreferences(run);
  const searchList = before.searchList;
  if (!before.defaultKeychain) {
    throw new Error(
      "Refusing contained signing because the user default keychain is null; choosing a replacement requires separate user authorization",
    );
  }
  const defaultKeychain = before.defaultKeychain;

  let value!: T;
  let actionFailed = false;
  let actionError: unknown;
  try {
    value = action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  let restoreError: unknown;
  try {
    restoreUserKeychainPreferences(run, { searchList, defaultKeychain });
  } catch (error) {
    restoreError = error;
  }

  if (actionFailed && restoreError) {
    throw new AggregateError(
      [actionError, restoreError],
      "Keychain action failed and user Keychain preferences could not be restored",
    );
  }
  if (actionFailed) throw actionError;
  if (restoreError) throw restoreError;
  return value;
}

function readUserKeychainPreferences(run: SecurityCommandRunner): UserKeychainPreferences {
  const list = runSecurity(run, ["list-keychains", "-d", "user"]);
  const searchList = parseKeychainList(list.stdout);
  if (searchList.length === 0) {
    throw new Error("Refusing Keychain mutation because the user keychain search list is empty");
  }
  const currentDefault = runSecurity(run, ["default-keychain", "-d", "user"]);
  return {
    searchList,
    defaultKeychain: parseDefaultKeychain(currentDefault.stdout),
  };
}

function restoreUserKeychainPreferences(
  run: SecurityCommandRunner,
  preferences: { searchList: string[]; defaultKeychain: string },
): void {
  const failures: unknown[] = [];
  try {
    runSecurity(run, ["list-keychains", "-d", "user", "-s", ...preferences.searchList]);
  } catch (error) {
    failures.push(error);
  }
  try {
    runSecurity(run, ["default-keychain", "-d", "user", "-s", preferences.defaultKeychain]);
  } catch (error) {
    failures.push(error);
  }

  try {
    const restored = readUserKeychainPreferences(run);
    if (!sameStringList(restored.searchList, preferences.searchList)) {
      failures.push(new Error("user keychain search list did not match its saved state after restoration"));
    }
    if (restored.defaultKeychain !== preferences.defaultKeychain) {
      failures.push(new Error("user default keychain was null or did not match its saved state after restoration"));
    }
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Failed to restore user Keychain preferences");
  }
}

function runSecurity(run: SecurityCommandRunner, args: string[]): SecurityCommandResult {
  const result = run("security", args);
  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(`security ${args[0]} failed${output ? `: ${output}` : ""}`);
  }
  return result;
}

function parseKeychainList(output: string): string[] {
  return [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function parseDefaultKeychain(output: string): string | null {
  const value = output.trim();
  if (!value || /^<?null>?$/i.test(value)) return null;
  const quoted = /^"([^"]+)"$/.exec(value);
  return quoted?.[1] ?? value;
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function codeSigningKeychainArgs(
  identity: Pick<PreparedSigningIdentity, "keychainPath"> | null | undefined,
): string[] {
  return identity?.keychainPath ? ["--keychain", identity.keychainPath] : [];
}

function execFileSyncRedacted(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2],
  redactions: string[],
): Buffer | string {
  try {
    return execFileSync(command, args, options);
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    let message = [err.stderr, err.stdout]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n");
    if (!message) message = err.message ?? String(e);
    for (const secret of redactions) {
      if (secret) message = message.split(secret).join("[redacted]");
    }
    throw new Error(`${command} failed: ${message}`);
  }
}

function defaultUserKeychain(): string {
  const result = spawnSync("security", ["default-keychain", "-d", "user"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !output) {
    throw new Error("could not determine the user default keychain");
  }
  return output.replace(/^"|"$/g, "");
}

function requireExecutable(command: string, message: string): void {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`[!] ${command} not installed\n\n${message}\nPaste this error into Codex if you need help.`);
  }
}

export function parseCodeSigningIdentities(output: string): Array<{ hash: string; name: string }> {
  const identities: Array<{ hash: string; name: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/.exec(line);
    if (!match) continue;
    identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

function isMachO(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    return isMachOMagic(header.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function isMachOMagic(magic: number): boolean {
  return MACHO_MAGICS.has(magic >>> 0);
}

export function verifySignature(appRoot: string): { ok: boolean; output: string } {
  if (platform() !== "darwin") return { ok: true, output: "(not macOS)" };
  try {
    const out = execFileSync("codesign", ["--verify", "--deep", "--strict", appRoot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    return { ok: false, output: String(err.stderr ?? e) };
  }
}

export interface SignatureInfo {
  ok: boolean;
  adHoc: boolean;
  teamIdentifier: string | null;
  authority: string[];
  output: string;
}

/**
 * The source boundary for a derived Tweakers bundle. A syntactically valid
 * signature is insufficient: the source must be strict-valid, Gatekeeper
 * accepted, and attributable to OpenAI's Developer ID certificate for its
 * fixed team identifier.
 */
export function assertOpenAIDeveloperIdSourceTrust(evidence: OpenAIDeveloperIdSourceTrustEvidence): void {
  const signature = evidence.signature;
  const strictVerification = signingCheckSucceeded(evidence.strictVerification);
  const gatekeeper = signingCheckSucceeded(evidence.gatekeeper);
  const hasOpenAIDeveloperIdAuthority = signature.authority.some((authority) =>
    /^Developer ID Application: OpenAI\b/.test(authority)
      && authority.includes(`(${OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER})`),
  );

  if (!signature.ok
    || signature.adHoc
    || signature.teamIdentifier !== OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER
    || !hasOpenAIDeveloperIdAuthority
    || !strictVerification
    || !gatekeeper) {
    throw new Error(
      `Refusing non-official source. Expected a strict-valid, Gatekeeper-accepted OpenAI Developer ID signature with team ${OPENAI_DEVELOPER_ID_TEAM_IDENTIFIER}.`,
    );
  }
}

function signingCheckSucceeded(
  check: Pick<SecurityCommandResult, "status"> | { ok: boolean },
): boolean {
  return "ok" in check ? check.ok === true : check.status === 0;
}

export function signatureInfo(appRoot: string): SignatureInfo {
  if (platform() !== "darwin") {
    return { ok: true, adHoc: false, teamIdentifier: null, authority: [], output: "(not macOS)" };
  }
  const result = spawnSync("codesign", ["-dv", "--verbose=4", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const info = parseSignatureInfo(output);
  return { ...info, ok: result.status === 0, output };
}

function parseSignatureInfo(output: string): SignatureInfo {
  const team = /^TeamIdentifier=(.*)$/m.exec(output)?.[1]?.trim() ?? null;
  const authority = [...output.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1].trim());
  return {
    ok: true,
    // A local certificate has no Apple TeamIdentifier, but is not ad hoc. The
    // two states must remain distinct so the local signing audit can require
    // its named Authority while the OpenAI source gate separately requires
    // the fixed Apple TeamIdentifier.
    adHoc: /Signature=adhoc/.test(output),
    teamIdentifier: team === "not set" ? null : team,
    authority,
    output,
  };
}

/**
 * True when the bundle is a genuine Developer ID–signed app — the requirement
 * for anything that serves as the pristine ChatGPT backup or a restore source.
 * (Lives beside signatureInfo so backup/transition modules can verify without
 * importing the install command module.)
 */
export function isDeveloperIdSignedBackup(appRoot: string): boolean {
  if (!existsSync(appRoot)) return false;
  const signature = signatureInfo(appRoot);
  return signature.ok
    && !signature.adHoc
    && signature.teamIdentifier !== null
    && signature.authority.some((authority) => /^Developer ID Application:/.test(authority));
}

/** Remove the macOS quarantine xattr so the modified app launches without prompt. */
export function clearQuarantine(appRoot: string): void {
  if (platform() !== "darwin") return;
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", appRoot], { stdio: "ignore" });
  } catch {
    /* no-op if not set */
  }
}

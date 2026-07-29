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
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { readPlist, writePlist, type Plist } from "./plist.js";

export const DEFAULT_LOCAL_SIGNING_IDENTITY = "Tweakers Local Signing";

export type SigningMode = "local-identity" | "adhoc";

export type SigningPosture = "strict" | "contained";

/**
 * strict  = Library Validation ON: omit disable-library-validation and do NOT
 *           add a trusted root. Relies on the pinned Designated Requirement.
 * contained = working fallback: keep disable-library-validation and add the
 *           cert as trusted, but ONLY inside a dedicated non-login keychain.
 * Default is "contained" until guarded real run #4 proves strict signing on a
 * live app. Set TWEAKERS_SIGNING_MODE=strict only for that guarded rollout.
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
  0xcafebabe, // fat
  0xcffaedfe, // 64-bit LE
  0xcefaedfe, // 32-bit LE
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
  const portableSignature = localIdentity
    ? preparePortableSignature(appRoot, localIdentity.hash, posture)
    : null;

  // Step 1: pre-sign every nested Mach-O inside-out with one identity before
  // the bundle-level pass re-signs the wrappers.
  for (const root of codeSigningWalkRoots(appRoot)) {
    walkAndSign(root, signingIdentity, keychainArgs);
  }

  // Step 2: sign the bundle itself with --deep (covers Frameworks, Helpers).
  try {
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", signingIdentity, ...keychainArgs, appRoot],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    if (portableSignature) {
      execFileSync(
        "codesign",
        [
          "--force",
          "--sign",
          signingIdentity,
          "--options",
          "runtime",
          "--entitlements",
          portableSignature.entitlementsPath,
          "--requirements",
          `=${portableSignature.requirement}`,
          ...keychainArgs,
          appRoot,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    }
  } finally {
    if (portableSignature) rmSync(portableSignature.tempRoot, { recursive: true, force: true });
  }

  return localIdentity
    ? {
        mode: "local-identity",
        identity: localIdentity.name,
        identityHash: localIdentity.hash,
        createdIdentity: localIdentity.created,
      }
    : { mode: "adhoc", identity: "-" };
}

/**
 * These are bound either to the original Apple Team ID or to that team's
 * provisioning profile. They cannot be carried over to a locally signed app.
 */
const NON_PORTABLE_ENTITLEMENTS = [
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
  "com.apple.security.application-groups",
  "keychain-access-groups",
  "com.apple.developer.aps-environment",
];

function preparePortableSignature(appRoot: string, identityHash: string, posture: SigningPosture): {
  tempRoot: string;
  entitlementsPath: string;
  requirement: string;
} | null {
  const info = readPlist(join(appRoot, "Contents", "Info.plist"));
  const identifier = String(info.CFBundleIdentifier ?? "");
  const requirementResult = spawnSync("codesign", ["-d", "-r-", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const originalRequirement = `${requirementResult.stdout ?? ""}${requirementResult.stderr ?? ""}`
    .split(/\r?\n/)
    .find((line) => line.startsWith("designated => "));
  if (!originalRequirement || !/^[A-Za-z0-9.-]+$/.test(identifier)) return null;

  const entitlementsResult = spawnSync("codesign", ["-d", "--entitlements", ":-", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // codesign still emits intact embedded entitlements after app.asar changes invalidate the seal.
  if (!entitlementsResult.stdout.trim()) return null;

  const tempRoot = mkdtempSync(join(tmpdir(), "tweakers-entitlements-"));
  const entitlementsPath = join(tempRoot, "portable.plist");
  const originalPath = join(tempRoot, "original.plist");
  writeFileSync(originalPath, entitlementsResult.stdout);
  const entitlements = portableEntitlements(readPlist(originalPath), posture);
  writePlist(entitlementsPath, entitlements);
  return {
    tempRoot,
    entitlementsPath,
    requirement: stableDesignatedRequirement(originalRequirement, identifier, identityHash),
  };
}

/**
 * Removes entitlements that require Apple's original Team ID or provisioning
 * profile. Strict signing keeps Library Validation enabled by omitting its
 * disable entitlement; contained fallback signing restores that entitlement
 * for launch compatibility.
 */
export function portableEntitlements(entitlements: Plist, posture: SigningPosture = "strict"): Plist {
  const portable = { ...entitlements };
  for (const key of NON_PORTABLE_ENTITLEMENTS) delete portable[key];
  delete portable["com.apple.security.cs.disable-library-validation"];
  if (posture === "contained") {
    portable["com.apple.security.cs.disable-library-validation"] = true;
  }
  return portable;
}

export function codeSigningWalkRoots(appRoot: string): string[] {
  const resources = join(appRoot, "Contents", "Resources");
  return [
    join(appRoot, "Contents", "Frameworks"),
    join(resources, "app.asar.unpacked"),
    // The Tweakers native host is a loose Mach-O staged outside Electron's
    // normal nested-code locations. `codesign --deep` does not reliably find
    // it, so include its directory in the explicit inside-out signing walk.
    join(resources, "tweakers", "native"),
  ];
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

function walkAndSign(root: string, signingIdentity: string, keychainArgs: string[]): void {
  const failures: string[] = [];
  walkAndSignInto(root, root, signingIdentity, keychainArgs, failures);
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
      walkAndSignInto(root, full, signingIdentity, keychainArgs, failures);
      continue;
    }
    if (!st.isFile()) continue;
    if (!isMachO(full)) continue;
    try {
      execFileSync(
        "codesign",
        [
          "--force",
          "--sign",
          signingIdentity,
          ...keychainArgs,
          "--preserve-metadata=entitlements,flags",
          full,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      failures.push(`${full}: ${signingErrorMessage(e)}`);
    }
  }
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
  const args = ["find-identity", "-v", "-p", "codesigning"];
  if (keychainPath) args.push(keychainPath);
  const result = spawnSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const identity = parseCodeSigningIdentities(output).find((candidate) => candidate.name === identityName);
  return identity ? { ...identity, ...(keychainPath ? { keychainPath } : {}) } : null;
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
  try {
    const fd = readFileSync(path, { flag: "r" }).subarray(0, 4);
    if (fd.length < 4) return false;
    const magic = fd.readUInt32BE(0);
    return MACHO_MAGICS.has(magic);
  } catch {
    return false;
  }
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
    adHoc: /Signature=adhoc/.test(output) || team === "not set",
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

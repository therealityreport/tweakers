import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readPlist, writePlist, type Plist } from "./plist.js";
import {
  TWEAKERS_VARIANT_USER_DATA_CONFIG,
  TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
  TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
} from "./macos-variant-bindings.js";
export {
  TWEAKERS_VARIANT_USER_DATA_CONFIG,
  TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
  TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
} from "./macos-variant-bindings.js";
import {
  resolveSealedManagerSupportAssets,
  verifySealedManagerSupportAssets,
} from "./manager-runtime-assets.js";

export const OPENAI_TEAM_ID = "2DC432GLL2";
export const TWEAKERS_VARIANT_BUNDLE_ID = "com.therealityreport.tweakers";
export const TWEAKERS_VARIANT_NAME = "Tweakers";
export const TWEAKERS_VARIANT_PRODUCT_NAME = "Tweakers Desktop";
export const TWEAKERS_VARIANT_ICON_FILE = "tweakers.icns";
/** The signed wrapper deliberately retains the source bundle's executable name. */
export const TWEAKERS_VARIANT_LAUNCHER_EXECUTABLE = "ChatGPT";
export const REQUIRED_INDEPENDENT_TWEAKERS_TWEAK_IDS = [
  "co.tweakers.account-switcher",
  "co.tweakers.appshots",
  "co.tweakers.developer-tools",
  "co.tweakers.followup",
  "co.tweakers.projects",
  "co.tweakers.shadcn-codex-ui",
  "co.tweakers.thread-summary-profiles",
  "co.tweakers.titlebar-controls",
  "co.tweakers.ui-improvements",
  "co.tweakers.usage-limit-resets-tracker",
  "co.tweakers.user-questions",
] as const;
const ordinaryInstallerAssetsRoot = fileURLToPath(new URL("../assets", import.meta.url));
const sealedManagerSupport = resolveSealedManagerSupportAssets();
const variantAssetsRoot = sealedManagerSupport?.root ?? ordinaryInstallerAssetsRoot;
export const TWEAKERS_VARIANT_ICON_SOURCE = join(variantAssetsRoot, "tweakers.icns");
export const TWEAKERS_VARIANT_PNG_SOURCE = join(variantAssetsRoot, "tweakers.png");
export const TWEAKERS_APP_LAUNCHER_SOURCE = join(
  variantAssetsRoot,
  "app-launcher",
  "Tweakers App Launcher",
);
export const TWEAKERS_ORIGINAL_EXECUTABLE = "Tweakers Electron";
const TWEAKERS_LAUNCHER_CONFIG_DIRECTORY = "tweakers";
export const TWEAKERS_VARIANT_DOCK_ICON_FILES = [
  "icon-chatgpt.png",
  "icon-codex-light.png",
  "icon-codex-dark-color.png",
] as const;
export const TWEAKERS_VARIANT_COMPUTER_USE_BUNDLE_ID = `${TWEAKERS_VARIANT_BUNDLE_ID}.computer-use`;
export const TWEAKERS_VARIANT_COMPUTER_USE_NAME = "Tweakers Computer Use";
export const TWEAKERS_VARIANT_URL_SCHEME = "tweakers";
export const TWEAKERS_ACCOUNTS_TWEAK_ID = "co.tweakers.account-switcher";

export interface MacAppIdentity {
  bundleId: string;
  displayName: string;
  /** Owl derives the Chromium profile and singleton identity from this value. */
  productName: string;
  urlScheme: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  /** One owner-private rendezvous shared by ChatGPT-with-Tweakers and Tweakers.app. */
  accountsBrokerRoot: string;
  iconSourcePath: string;
  pngSourcePath: string;
  /** Packaged native wrapper that delegates to the preserved Electron binary. */
  launcherSourcePath: string;
}

export function defaultTweakersAccountsBrokerRoot(homeRoot = homedir()): string {
  return join(
    resolve(homeRoot),
    "Library",
    "Application Support",
    "Tweakers",
    "tweak-data",
    TWEAKERS_ACCOUNTS_TWEAK_ID,
  );
}

export function defaultTweakersVariantIdentity(
  appUserDataRoot: string,
  stateRoot = dirname(appUserDataRoot),
  accountsBrokerRoot = defaultTweakersAccountsBrokerRoot(),
): MacAppIdentity {
  if (sealedManagerSupport !== null) verifySealedManagerSupportAssets(sealedManagerSupport);
  return {
    bundleId: TWEAKERS_VARIANT_BUNDLE_ID,
    displayName: TWEAKERS_VARIANT_NAME,
    productName: TWEAKERS_VARIANT_PRODUCT_NAME,
    urlScheme: TWEAKERS_VARIANT_URL_SCHEME,
    appUserDataRoot,
    codexHomeRoot: join(stateRoot, "codex-home"),
    accountsBrokerRoot,
    iconSourcePath: TWEAKERS_VARIANT_ICON_SOURCE,
    pngSourcePath: TWEAKERS_VARIANT_PNG_SOURCE,
    launcherSourcePath: TWEAKERS_APP_LAUNCHER_SOURCE,
  };
}

/**
 * Give a locally signed Tweakers copy its own LaunchServices identity. The
 * official OpenAI app must keep com.openai.codex and its original signature.
 */
export function applyMacAppIdentity(appRoot: string, identity: MacAppIdentity): string[] {
  const mainInfo = join(appRoot, "Contents", "Info.plist");
  if (!existsSync(mainInfo)) throw new Error(`Variant app is missing Info.plist: ${mainInfo}`);
  if (!existsSync(identity.iconSourcePath)) {
    throw new Error(`Variant app icon is missing: ${identity.iconSourcePath}`);
  }
  if (!existsSync(identity.pngSourcePath)) {
    throw new Error(`Variant Dock icon is missing: ${identity.pngSourcePath}`);
  }
  for (const [label, path] of [
    ["app data", identity.appUserDataRoot],
    ["Codex home", identity.codexHomeRoot],
    ["Accounts broker", identity.accountsBrokerRoot],
  ] as const) {
    assertExactAbsolutePath(path, `Variant ${label} path`);
  }

  const infoPaths = collectInfoPlists(join(appRoot, "Contents"));
  assertOpenAIRuntimeIdentitiesAreRewriteable(appRoot, infoPaths);

  const resources = join(appRoot, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  copyFileSync(identity.iconSourcePath, join(resources, TWEAKERS_VARIANT_ICON_FILE));
  for (const name of TWEAKERS_VARIANT_DOCK_ICON_FILES) {
    copyFileSync(identity.pngSourcePath, join(resources, name));
  }

  const changed: string[] = [];
  for (const path of infoPaths) {
    if (isProvenNonRuntimeDsymMetadata(appRoot, path)) continue;
    const value = readPlist(path);
    let dirty = false;
    const currentBundleId = typeof value.CFBundleIdentifier === "string" ? value.CFBundleIdentifier : null;
    if (path === mainInfo) {
      dirty = setValue(value, "CFBundleIdentifier", identity.bundleId) || dirty;
      dirty = setValue(value, "CFBundleName", identity.displayName) || dirty;
      dirty = setValue(value, "CFBundleDisplayName", identity.displayName) || dirty;
      // Keep Owl's native product/data identity distinct from the Tweakers
      // manager while LSEnvironment supplies the absolute profile path before
      // the packaged bootstrap requests Electron's single-instance lock.
      dirty = setValue(value, "CrProductDirName", identity.productName) || dirty;
      dirty = setValue(value, "BundleSigningBaseName", identity.displayName) || dirty;
      const launchEnvironment = value.LSEnvironment && typeof value.LSEnvironment === "object"
        && !Array.isArray(value.LSEnvironment)
        ? value.LSEnvironment as Record<string, unknown>
        : {};
      dirty = setValue(value, "LSEnvironment", {
        ...launchEnvironment,
        CODEX_ELECTRON_USER_DATA_PATH: identity.appUserDataRoot,
        CODEX_HOME: identity.codexHomeRoot,
        // A derived desktop must never become a second writer against the
        // official ~/.codex SQLite store. Shared conversation visibility is
        // supplied by the single Accounts broker; this is only a fail-closed
        // account-local fallback if broker startup is unavailable.
        CODEX_SQLITE_HOME: identity.codexHomeRoot,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
        TWEAKERS_ACCOUNTS_BROKER_ROOT: identity.accountsBrokerRoot,
        TWEAKER_ACCOUNTS_BROKER_ROOT: identity.accountsBrokerRoot,
        TWEAKERS_DERIVED_VARIANT: "1",
      }) || dirty;
      // The user-owned Tweakers/ShadGPT cloud-terminal artwork is a standalone
      // icns resource. Remove the upstream asset-catalog selector so macOS uses
      // this file rather than resolving the ChatGPT icon from Assets.car.
      dirty = deleteValue(value, "CFBundleIconName") || dirty;
      dirty = deleteValue(value, "CodexAppIconBaseName") || dirty;
      dirty = deleteValue(value, "NSDockTilePlugIn") || dirty;
      dirty = setValue(value, "CFBundleIconFile", TWEAKERS_VARIANT_ICON_FILE) || dirty;
      dirty = setValue(value, "CFBundleURLTypes", [{
        CFBundleURLName: identity.displayName,
        CFBundleURLSchemes: [identity.urlScheme],
      }]) || dirty;
      // A variant is refreshed by Tweakers from a verified official source; it
      // must never let Sparkle overwrite itself or contend with the official app.
      dirty = setValue(value, "SUEnableAutomaticChecks", false) || dirty;
      dirty = setValue(value, "SUAutomaticallyUpdate", false) || dirty;
    } else if (currentBundleId && isBundleIdentityOrDescendant(currentBundleId, "com.openai.codex")) {
      dirty = setValue(
        value,
        "CFBundleIdentifier",
        identity.bundleId + currentBundleId.slice("com.openai.codex".length),
      ) || dirty;
      dirty = rewriteNestedRuntimeNames(value) || dirty;
    } else if (currentBundleId && isBundleIdentityOrDescendant(currentBundleId, "com.openai.sky.CUAService")) {
      dirty = setValue(
        value,
        "CFBundleIdentifier",
        TWEAKERS_VARIANT_COMPUTER_USE_BUNDLE_ID
          + currentBundleId.slice("com.openai.sky.CUAService".length),
      ) || dirty;
      dirty = rewriteNestedRuntimeNames(value) || dirty;
      if (currentBundleId === "com.openai.sky.CUAService"
        || !hasRuntimeDisplayName(value)) {
        dirty = setValue(value, "CFBundleName", TWEAKERS_VARIANT_COMPUTER_USE_NAME) || dirty;
        dirty = setValue(value, "CFBundleDisplayName", TWEAKERS_VARIANT_COMPUTER_USE_NAME) || dirty;
      }
    }
    if (dirty) {
      writePlist(path, value);
      changed.push(path);
    }
  }
  assertNoResidualOpenAIRuntimeIdentities(appRoot);
  return changed;
}

/**
 * Restore the native launcher boundary after variant identity rewriting.
 *
 * The declared Electron executable remains the bundle entrypoint. Its original
 * bytes are retained under the fixed Tweakers Electron name, while the
 * packaged wrapper takes the declared name and receives only owner-readable
 * path configuration sealed by the final outer app signature.
 */
export function installMacAppLauncher(appRoot: string, identity: MacAppIdentity): void {
  assertExactAbsolutePath(appRoot, "Variant app root");
  assertRealDirectory(appRoot, "Variant app root");

  const contents = join(appRoot, "Contents");
  const infoPath = join(contents, "Info.plist");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  assertRealDirectory(contents, "Variant Contents directory");
  assertRealRegularFile(infoPath, "Variant Info.plist");
  assertRealDirectory(macos, "Variant MacOS directory");
  ensureRealDirectory(resources, "Variant Resources directory", 0o755, false);
  assertRealRegularExecutable(identity.launcherSourcePath, "Tweakers app launcher source");
  assertLauncherPathInputs(identity);

  const plist = readPlist(infoPath);
  const declaredExecutable = typeof plist.CFBundleExecutable === "string" ? plist.CFBundleExecutable : "";
  assertSimpleFileName(declaredExecutable, "CFBundleExecutable");
  if (declaredExecutable === TWEAKERS_ORIGINAL_EXECUTABLE) {
    throw new Error(`CFBundleExecutable collides with reserved original executable name: ${declaredExecutable}`);
  }

  const executable = join(macos, declaredExecutable);
  const originalExecutable = join(macos, TWEAKERS_ORIGINAL_EXECUTABLE);
  const marker = plist.TweakersOriginalExecutable;
  const alreadyInstalled = marker === TWEAKERS_ORIGINAL_EXECUTABLE;
  let plistChanged = false;
  if (marker !== undefined && !alreadyInstalled) {
    throw new Error("Variant launcher has an unsupported TweakersOriginalExecutable marker");
  }
  if (plist.LSAllowOtherExecutablesToCheckIn !== true) {
    // The signed wrapper is CFBundleExecutable, while the preserved Electron
    // binary checks in as a second executable inside the same app bundle.
    plist.LSAllowOtherExecutablesToCheckIn = true;
    plistChanged = true;
  }

  assertRealRegularExecutable(executable, "Declared Tweakers executable");
  if (alreadyInstalled) {
    assertRealRegularExecutable(originalExecutable, "Preserved Tweakers Electron executable");
  } else if (existsSync(originalExecutable)) {
    throw new Error(`Variant launcher collision: preserved executable already exists at ${originalExecutable}`);
  }

  const configDirectory = join(resources, TWEAKERS_LAUNCHER_CONFIG_DIRECTORY);
  ensureRealDirectory(configDirectory, "Tweakers launcher configuration directory", 0o700);
  const configPaths = [
    [join(resources, TWEAKERS_VARIANT_USER_DATA_CONFIG), identity.appUserDataRoot],
    [join(resources, TWEAKERS_VARIANT_CODEX_HOME_CONFIG), identity.codexHomeRoot],
    [join(resources, TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG), identity.accountsBrokerRoot],
  ] as const;
  for (const [path] of configPaths) assertSafeConfigDestination(path);

  const stagedLauncher = join(macos, `.tweakers-app-launcher-${randomUUID()}.tmp`);
  try {
    copyFileSync(identity.launcherSourcePath, stagedLauncher, constants.COPYFILE_EXCL);
    chmodSync(stagedLauncher, lstatSync(identity.launcherSourcePath).mode & 0o777);
    assertRealRegularExecutable(stagedLauncher, "Staged Tweakers app launcher");

    if (!alreadyInstalled) {
      // link(2) is exclusive at the destination, unlike rename(2), so an
      // unexpected preserved-name collision cannot overwrite a foreign file.
      linkSync(executable, originalExecutable);
    }
    renameSync(stagedLauncher, executable);
    if (!alreadyInstalled) {
      plist.TweakersOriginalExecutable = TWEAKERS_ORIGINAL_EXECUTABLE;
      plistChanged = true;
    }
    if (plistChanged) writePlist(infoPath, plist);
    for (const [path, value] of configPaths) writeOwnerOnlyPathConfig(path, value);
  } finally {
    if (existsSync(stagedLauncher)) unlinkSync(stagedLauncher);
  }
}

function assertLauncherPathInputs(identity: MacAppIdentity): void {
  for (const [label, path] of [
    ["app data", identity.appUserDataRoot],
    ["Codex home", identity.codexHomeRoot],
    ["Accounts broker", identity.accountsBrokerRoot],
  ] as const) {
    assertExactAbsolutePath(path, `Variant ${label} path`);
  }
}

function assertExactAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\r\n]/.test(path)) {
    throw new Error(`${label} must be exact and absolute: ${path}`);
  }
}

function assertSimpleFileName(name: string, label: string): void {
  if (!name || name === "." || name === ".." || basename(name) !== name) {
    throw new Error(`${label} must be one safe file name`);
  }
}

function assertRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

function ensureRealDirectory(path: string, label: string, mode: number, enforceMode = true): void {
  if (existsSync(path)) assertRealDirectory(path, label);
  else mkdirSync(path, { mode });
  if (enforceMode) chmodSync(path, mode);
}

function assertRealRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file: ${path}`);
  }
}

function assertRealRegularExecutable(path: string, label: string): void {
  assertRealRegularFile(path, label);
  if ((lstatSync(path).mode & 0o111) === 0) {
    throw new Error(`${label} must be executable: ${path}`);
  }
}

function assertSafeConfigDestination(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Tweakers launcher configuration file must be a real regular file: ${path}`);
    }
  } catch (error) {
    if (typeof error === "object" && error !== null
      && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function writeOwnerOnlyPathConfig(path: string, value: string): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${value}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  assertRealRegularFile(path, "Tweakers launcher configuration file");
  if ((lstatSync(path).mode & 0o777) !== 0o600) {
    throw new Error(`Tweakers launcher configuration file does not have owner-only permissions: ${path}`);
  }
}

/**
 * No unknown OpenAI runtime identifier may survive a derived bundle. dSYM
 * Info.plists are the sole allowed residue because they are symbol metadata,
 * not launchable bundle metadata, and the narrow path check proves that fact.
 */
export function assertNoResidualOpenAIRuntimeIdentities(appRoot: string): void {
  for (const path of collectInfoPlists(join(appRoot, "Contents"))) {
    if (isProvenNonRuntimeDsymMetadata(appRoot, path)) continue;
    const plist = readPlist(path);
    const bundleId = typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : "";
    if (bundleId.startsWith("com.openai.")) {
      throw new Error(`Derived variant retained an OpenAI runtime bundle identity at ${path}: ${bundleId}`);
    }
    for (const key of ["CFBundleName", "CFBundleDisplayName", "BundleSigningBaseName"] as const) {
      const value = plist[key];
      if (typeof value === "string" && /\b(?:ChatGPT|Codex|OpenAI)\b/.test(value)) {
        throw new Error(`Derived variant retained an OpenAI runtime name at ${path}: ${key}=${value}`);
      }
    }
  }
}

function assertOpenAIRuntimeIdentitiesAreRewriteable(appRoot: string, infoPaths: readonly string[]): void {
  for (const path of infoPaths) {
    if (isProvenNonRuntimeDsymMetadata(appRoot, path)) continue;
    const value = readPlist(path);
    const bundleId = typeof value.CFBundleIdentifier === "string" ? value.CFBundleIdentifier : "";
    if (!bundleId.startsWith("com.openai.")) continue;
    if (isBundleIdentityOrDescendant(bundleId, "com.openai.codex")
      || isBundleIdentityOrDescendant(bundleId, "com.openai.sky.CUAService")) continue;
    throw new Error(`Derived variant found an unrecognized OpenAI runtime bundle identity at ${path}: ${bundleId}`);
  }
}

function isBundleIdentityOrDescendant(bundleId: string, prefix: string): boolean {
  return bundleId === prefix || bundleId.startsWith(`${prefix}.`);
}

function rewriteNestedRuntimeNames(plist: Plist): boolean {
  let changed = false;
  for (const key of ["CFBundleName", "CFBundleDisplayName", "BundleSigningBaseName"] as const) {
    const current = plist[key];
    if (typeof current !== "string") continue;
    const rewritten = current.replace(/\b(?:ChatGPT|Codex|OpenAI)\b/g, TWEAKERS_VARIANT_NAME);
    changed = setValue(plist, key, rewritten) || changed;
  }
  return changed;
}

function hasRuntimeDisplayName(plist: Plist): boolean {
  return typeof plist.CFBundleName === "string" || typeof plist.CFBundleDisplayName === "string";
}

function collectInfoPlists(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "Info.plist") out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

function isProvenNonRuntimeDsymMetadata(appRoot: string, path: string): boolean {
  const segments = relative(appRoot, path).split("/");
  const dsymIndex = segments.findIndex((segment) => segment.endsWith(".dSYM"));
  return dsymIndex >= 0 && segments.slice(dsymIndex + 1).join("/") === "Contents/Info.plist";
}

function setValue(plist: Plist, key: string, value: unknown): boolean {
  if (JSON.stringify(plist[key]) === JSON.stringify(value)) return false;
  plist[key] = value;
  return true;
}

function deleteValue(plist: Plist, key: string): boolean {
  if (!(key in plist)) return false;
  delete plist[key];
  return true;
}

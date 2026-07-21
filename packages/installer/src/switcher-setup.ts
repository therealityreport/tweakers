/**
 * Menu Bar mode-coordinator metadata and legacy standalone cleanup.
 *
 * Mode controls now live in the existing Menu Bar app. The historical
 * `Tweakers Switcher.app` implementation remains below only as a temporary
 * compatibility seam for old installs and hermetic migration tests; current
 * production setup writes coordinator metadata and removes that second status
 * item. The legacy app formerly required four things, idempotently:
 *
 *   1. App copy   — installer assets → `<root>/bin/Tweakers Switcher.app`.
 *   2. CLI config — `<root>/switcher.json` with the argv prefix the binary
 *                   uses for mode changes and coordinated development
 *                   refreshes; the prebuilt binary carries no machine-specific
 *                   paths.
 *   3. Signature  — the per-machine local identity (contained posture, no
 *                   special entitlements). The shipped asset is only ad-hoc
 *                   signed because the local identity cannot leave the machine.
 *   4. LaunchAgent — com.therealityreport.tweakers.switcher with RunAtLoad and
 *                   KeepAlive={SuccessfulExit:false}: restart after a crash,
 *                   but a clean "Quit Switcher" (exit 0) stays quit.
 *
 * Every system side effect (codesign, launchctl, exact-app quit) flows through
 * injectable deps so tests stay hermetic; file operations run against
 * TWEAKERS_HOME.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeSigningKeychainArgs, prepareCodeSigning } from "./codesign.js";
import { managedCliPath } from "./managed-runtime.js";
import { chownForTargetUser, targetUserHome, targetUserOwnership } from "./ownership.js";
import { ensureUserPaths, userPaths } from "./paths.js";

const here = dirname(fileURLToPath(import.meta.url));

export const SWITCHER_LABEL = "com.therealityreport.tweakers.switcher";
export const SWITCHER_APP_NAME = "Tweakers Switcher.app";
export const SWITCHER_BINARY_NAME = "Tweakers Switcher";

export interface SwitcherInstallResult {
  installed: boolean;
  reason?: string;
}

export interface SwitcherRemovalResult {
  removed: boolean;
  reason?: string;
}

export interface SwitcherStatusResult {
  installed: boolean;
  reason?: string;
}

export interface ModeCoordinatorStatusResult {
  configured: boolean;
  source: "coordinator" | "switcher-compat" | "unavailable";
  reason?: string;
}

/** Injectable system side effects (repo convention — tests stay hermetic). */
export interface SwitcherSetupDeps {
  platform?: () => NodeJS.Platform;
  /** Prebuilt switcher app shipped in installer assets. */
  assetApp?: string;
  /** LaunchAgents directory (default ~/Library/LaunchAgents). */
  launchAgentsDir?: string;
  logPath?: string;
  copyApp?: (source: string, destination: string) => void;
  /** Signs the installed app copy with the per-machine local identity. */
  sign?: (appRoot: string) => void;
  /** Runs one launchctl invocation; a throw marks that step failed. */
  launchctl?: (args: string[]) => void;
  /** Reports whether the LaunchAgent label is currently loaded. */
  isAgentLoaded?: (label: string) => boolean;
  /** argv prefix the switcher binary uses for mode and refresh commands. */
  cliInvocation?: (userRoot: string) => string[];
  /** Gracefully quits only the retired standalone app, never Menu Bar. */
  quitApp?: (appRoot: string, binaryPath: string) => void;
}

/* ------------------------------------------------------------------------- */
/* paths                                                                     */
/* ------------------------------------------------------------------------- */

/** The prebuilt app the asset pipeline ships (copy-assets.mjs). */
export function switcherAssetApp(): string {
  return resolve(here, "..", "assets", "switcher", SWITCHER_APP_NAME);
}

export function installedSwitcherApp(userRoot: string): string {
  return join(userRoot, "bin", SWITCHER_APP_NAME);
}

export function installedSwitcherBinary(userRoot: string): string {
  return join(installedSwitcherApp(userRoot), "Contents", "MacOS", SWITCHER_BINARY_NAME);
}

/** Sidecar config the binary reads: which CLI runtime to spawn. */
export function switcherConfigFile(userRoot: string): string {
  return join(userRoot, "switcher.json");
}

/** Neutral metadata consumed by the existing Menu Bar Tweakers integration. */
export function modeCoordinatorConfigFile(userRoot: string): string {
  return join(userRoot, "coordinator.json");
}

export function switcherLaunchAgentPlist(launchAgentsDir: string): string {
  return join(launchAgentsDir, `${SWITCHER_LABEL}.plist`);
}

function defaultLaunchAgentsDir(): string {
  return join(targetUserHome(), "Library", "LaunchAgents");
}

function defaultLogPath(): string {
  return join(targetUserHome(), "Library", "Logs", "tweakers-switcher.log");
}

/* ------------------------------------------------------------------------- */
/* CLI invocation + config                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The argv prefix the switcher spawns. Prefer the managed runtime copy of the
 * CLI (it survives dev-checkout moves); fall back to whatever entry point is
 * running right now. Never bake either into the binary itself.
 */
export function resolveSwitcherCliInvocation(userRoot: string): string[] {
  const managed = managedCliPath(userRoot);
  const entry = process.argv[1] ? resolve(process.argv[1]) : null;
  const cli = existsSync(managed) ? managed : entry ?? managed;
  const nodeArgs = cli.endsWith(".ts") ? process.execArgv : [];
  return [process.execPath, ...nodeArgs, cli];
}

function writeCoordinatorConfig(configFile: string, value: object): void {
  const temporary = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configFile);
  chownForTargetUser(configFile);
}

/**
 * Keep the restart coordinator independent of any status-item app. The
 * neutral file is canonical; switcher.json remains a one-release compatibility
 * alias for Menu Bar 1.8 installations already in the field.
 */
export async function ensureModeCoordinatorConfigured(
  deps: Pick<SwitcherSetupDeps, "cliInvocation"> = {},
): Promise<{ configured: boolean; reason?: string }> {
  const paths = ensureUserPaths();
  try {
    const cli = (deps.cliInvocation ?? resolveSwitcherCliInvocation)(paths.root);
    const value = { schemaVersion: 1, cli, updatedAt: new Date().toISOString() };
    writeCoordinatorConfig(modeCoordinatorConfigFile(paths.root), value);
    writeCoordinatorConfig(switcherConfigFile(paths.root), value);
    return { configured: true };
  } catch (error) {
    return { configured: false, reason: `could not write restart coordinator metadata: ${errorMessage(error)}` };
  }
}

export function modeCoordinatorStatus(userRoot = userPaths().root): ModeCoordinatorStatusResult {
  for (const [file, source] of [
    [modeCoordinatorConfigFile(userRoot), "coordinator"],
    [switcherConfigFile(userRoot), "switcher-compat"],
  ] as const) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown; cli?: unknown };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cli) || parsed.cli.length === 0
        || !parsed.cli.every((entry) => typeof entry === "string" && entry.length > 0)
        || !existsSync(parsed.cli[0]!)) continue;
      return { configured: true, source };
    } catch {
      // Try the compatibility file before reporting unavailable.
    }
  }
  return {
    configured: false,
    source: "unavailable",
    reason: "restart coordinator metadata is missing or points to an unavailable Tweakers CLI",
  };
}

/* ------------------------------------------------------------------------- */
/* LaunchAgent                                                               */
/* ------------------------------------------------------------------------- */

/**
 * KeepAlive={SuccessfulExit:false} restarts the switcher only after an
 * UNsuccessful exit: a crash comes back, "Quit Switcher" (exit 0) stays quit.
 * Plain KeepAlive=true would turn Quit into a relaunch loop.
 *
 * TWEAKERS_HOME is baked into the agent's environment: launchd spawns the
 * switcher (and the CLI the switcher spawns inherits that environment) with a
 * minimal environment that never carries the user's shell overrides, so an
 * override-root install (TWEAKERS_HOME / TWEAKER_HOME) would otherwise
 * resolve a different root than the installer that set it up. Harmless for
 * default installs — the resolved root is the default one.
 */
export function renderSwitcherLaunchAgentPlist(binaryPath: string, logPath: string, userRoot: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SWITCHER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binaryPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TWEAKERS_HOME</key>
    <string>${xmlEscape(userRoot)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>`;
}

function launchdGuiDomain(): string | null {
  const uid = targetUserOwnership()?.uid ?? (typeof process.getuid === "function" ? process.getuid() : userInfo().uid);
  return typeof uid === "number" ? `gui/${uid}` : null;
}

function defaultLaunchctl(args: string[]): void {
  const owner = targetUserOwnership();
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (owner && currentUid === 0 && owner.uid !== 0) {
    execFileSync("launchctl", ["asuser", String(owner.uid), "launchctl", ...args], { stdio: "ignore" });
    return;
  }
  execFileSync("launchctl", args, { stdio: "ignore" });
}

/** Boot the agent (out first so a refresh reloads the new binary/plist). */
function loadSwitcherAgent(plistPath: string, run: (args: string[]) => void): void {
  const domain = launchdGuiDomain();
  if (domain) {
    try {
      run(["bootout", domain, plistPath]);
    } catch {
      // Not loaded yet — bootstrapping fresh is the normal case.
    }
    try {
      run(["bootstrap", domain, plistPath]);
      run(["enable", `${domain}/${SWITCHER_LABEL}`]);
      return;
    } catch {
      // Fall through to the legacy load path (matches watcher.ts behavior).
    }
  }
  try {
    run(["unload", plistPath]);
  } catch {
    // Not loaded yet.
  }
  run(["load", plistPath]);
}

function unloadSwitcherAgent(plistPath: string, run: (args: string[]) => void): void {
  const domain = launchdGuiDomain();
  if (domain) {
    try {
      run(["bootout", domain, plistPath]);
    } catch {
      // Already unloaded.
    }
  }
  try {
    run(["unload", plistPath]);
  } catch {
    // Already unloaded.
  }
}

function defaultIsAgentLoaded(label: string): boolean {
  const domain = launchdGuiDomain();
  const args = domain ? ["print", `${domain}/${label}`] : ["list", label];
  const result = spawnSync("launchctl", args, { stdio: "ignore" });
  return result.status === 0;
}

/* ------------------------------------------------------------------------- */
/* install / remove / status                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Legacy compatibility helper. Current production code must use
 * ensureModeCoordinatorConfigured and removeStandaloneSwitcher instead.
 * Ensure the historical menu-bar switcher app + LaunchAgent are installed and loaded.
 * Idempotent: re-running refreshes the app copy, CLI config, and plist, and
 * reloads the agent. Failures are reported as `{ installed: false, reason }` —
 * callers decide whether that is fatal (`mode chatgpt` refuses) or a warning
 * (`install()` promotion continues).
 */
export async function ensureSwitcherInstalled(deps: SwitcherSetupDeps = {}): Promise<SwitcherInstallResult> {
  if ((deps.platform ?? platform)() !== "darwin") {
    return { installed: false, reason: "the menu-bar switcher is only supported on macOS" };
  }
  const paths = ensureUserPaths();
  const asset = deps.assetApp ?? switcherAssetApp();
  if (!existsSync(join(asset, "Contents", "MacOS", SWITCHER_BINARY_NAME))) {
    return {
      installed: false,
      reason: `the switcher app asset is missing at ${asset} (rebuild with \`npm run build\`)`,
    };
  }

  const installedApp = installedSwitcherApp(paths.root);
  try {
    // Remove-then-copy so a refresh never leaves stale files inside the bundle.
    rmSync(installedApp, { recursive: true, force: true });
    mkdirSync(dirname(installedApp), { recursive: true });
    (deps.copyApp ?? defaultCopyApp)(asset, installedApp);
    chownForTargetUser(installedApp, { recursive: true });
  } catch (error) {
    return { installed: false, reason: `could not copy the switcher app: ${errorMessage(error)}` };
  }

  try {
    const cli = (deps.cliInvocation ?? resolveSwitcherCliInvocation)(paths.root);
    const value = { schemaVersion: 1, cli, updatedAt: new Date().toISOString() };
    writeCoordinatorConfig(modeCoordinatorConfigFile(paths.root), value);
    writeCoordinatorConfig(switcherConfigFile(paths.root), value);
  } catch (error) {
    return { installed: false, reason: `could not write the switcher CLI config: ${errorMessage(error)}` };
  }

  try {
    (deps.sign ?? signWithLocalIdentity)(installedApp);
  } catch (error) {
    return { installed: false, reason: `could not sign the switcher app: ${errorMessage(error)}` };
  }

  try {
    const launchAgentsDir = deps.launchAgentsDir ?? defaultLaunchAgentsDir();
    mkdirSync(launchAgentsDir, { recursive: true });
    const plistPath = switcherLaunchAgentPlist(launchAgentsDir);
    const logPath = deps.logPath ?? defaultLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(plistPath, renderSwitcherLaunchAgentPlist(installedSwitcherBinary(paths.root), logPath, paths.root));
    writeFileSync(logPath, "", { flag: "a" });
    chownForTargetUser(plistPath);
    chownForTargetUser(logPath);
    loadSwitcherAgent(plistPath, deps.launchctl ?? defaultLaunchctl);
  } catch (error) {
    return { installed: false, reason: `could not load the switcher LaunchAgent: ${errorMessage(error)}` };
  }

  return { installed: true };
}

/**
 * Remove the menu-bar switcher app + LaunchAgent. Idempotent: removing an
 * absent switcher reports `{ removed: false }` without touching launchd.
 */
export async function removeSwitcher(deps: SwitcherSetupDeps = {}): Promise<SwitcherRemovalResult> {
  const result = await removeStandaloneSwitcher(deps);
  const paths = userPaths();
  const coordinator = modeCoordinatorConfigFile(paths.root);
  const compatibility = switcherConfigFile(paths.root);
  const metadataExisted = existsSync(coordinator) || existsSync(compatibility);
  rmSync(coordinator, { force: true });
  rmSync(compatibility, { force: true });
  return result.removed || metadataExisted ? { removed: true } : result;
}

/**
 * Remove only the retired standalone status item. Coordinator metadata stays
 * available to the existing Menu Bar app during the compatibility window.
 */
export async function removeStandaloneSwitcher(deps: SwitcherSetupDeps = {}): Promise<SwitcherRemovalResult> {
  if ((deps.platform ?? platform)() !== "darwin") {
    return { removed: false, reason: "the menu-bar switcher is only supported on macOS" };
  }
  const paths = userPaths();
  const plistPath = switcherLaunchAgentPlist(deps.launchAgentsDir ?? defaultLaunchAgentsDir());
  const installedApp = installedSwitcherApp(paths.root);
  const binaryPath = installedSwitcherBinary(paths.root);
  const existed = existsSync(plistPath) || existsSync(installedApp);
  if (!existed) return { removed: false, reason: "the standalone menu-bar switcher is not installed" };

  if (existsSync(plistPath)) {
    unloadSwitcherAgent(plistPath, deps.launchctl ?? defaultLaunchctl);
  }
  try {
    (deps.quitApp ?? defaultQuitStandaloneSwitcher)(installedApp, binaryPath);
  } catch {
    // Removal remains idempotent. The exact installed process is targeted
    // again by the next migration cycle if graceful quit was unavailable.
  }
  rmSync(plistPath, { force: true });
  rmSync(installedApp, { recursive: true, force: true });
  return { removed: true };
}

/**
 * Read-only check for `tweaker mode status`: installed app copy + LaunchAgent
 * plist + loaded agent. Never installs anything (unlike ensureSwitcherInstalled).
 */
export async function switcherStatus(deps: SwitcherSetupDeps = {}): Promise<SwitcherStatusResult> {
  if ((deps.platform ?? platform)() !== "darwin") {
    return { installed: false, reason: "the menu-bar switcher is only supported on macOS" };
  }
  const paths = userPaths();
  if (!existsSync(installedSwitcherBinary(paths.root))) {
    return { installed: false, reason: "the switcher app is not installed (run `tweaker mode setup`)" };
  }
  const plistPath = switcherLaunchAgentPlist(deps.launchAgentsDir ?? defaultLaunchAgentsDir());
  if (!existsSync(plistPath)) {
    return { installed: false, reason: "the switcher LaunchAgent is not installed (run `tweaker mode setup`)" };
  }
  if (!(deps.isAgentLoaded ?? defaultIsAgentLoaded)(SWITCHER_LABEL)) {
    return { installed: false, reason: "the switcher LaunchAgent is not loaded (run `tweaker mode setup`)" };
  }
  return { installed: true };
}

/* ------------------------------------------------------------------------- */
/* default side effects                                                      */
/* ------------------------------------------------------------------------- */

function defaultCopyApp(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

/**
 * Per-machine local identity, contained posture, no special entitlements: a
 * plain deep re-sign of the tiny bundle is enough (signCodexApp's asar/helper
 * walking targets the patched ChatGPT.app, not this single-binary app).
 */
function signWithLocalIdentity(appRoot: string): void {
  const identity = prepareCodeSigning({});
  execFileSync("codesign", [
    "--force",
    "--deep",
    "--sign",
    identity?.hash ?? "-",
    ...codeSigningKeychainArgs(identity),
    appRoot,
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function defaultQuitStandaloneSwitcher(_appRoot: string, binaryPath: string): void {
  const escaped = binaryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const running = spawnSync("pgrep", ["-f", `^${escaped}$`], { encoding: "utf8" });
  if (running.status !== 0) return;
  try {
    execFileSync("osascript", ["-e", `tell application id \"com.therealityreport.tweakers.switcher\" to quit`], {
      stdio: "ignore",
    });
  } catch {
    for (const raw of (running.stdout ?? "").split(/\s+/)) {
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      }
    }
  }
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Main-process bootstrap. Loaded by the asar loader before Codex's own
 * main process code runs. We hook `BrowserWindow` so every window Codex
 * creates gets our preload script attached. We also stand up an IPC
 * channel for tweaks to talk to the main process.
 *
 * We are in CJS land here (matches Electron's main process and Codex's own
 * code). The renderer-side runtime is bundled separately into preload.js.
 */
import { app, BrowserView, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, Notification, session, shell, systemPreferences, webContents, type OpenDialogOptions } from "electron";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as extractTar, list as listTar } from "tar";
import chokidar from "chokidar";
import { discoverTweaks, type DiscoveredTweak } from "./tweak-discovery";
import { createDiskStorage, removeLegacyModeSwitcherState, type DiskStorage } from "./storage";
import {
  createMcpReconciler,
  userQuestionsMcpReceiptMatchesEnabledState,
} from "./mcp-reconciliation";
import { getAndPublishWatcherHealth, readRuntimeFingerprintEvidence } from "./watcher-health";
import {
  isMainProcessTweakScope,
  bindMainTweakStop,
  normalizeTweakStartupTimeoutMs,
  runWithStartupTimeout,
  reloadTweaks,
  setTweakEnabledAndReload,
  createTweakLifecycleJournal,
  lifecycleRecordKey,
  recoverInterruptedTweaks,
  loadTweaksInitially,
  type TweakLifecycleJournal,
  type TweakLifecycleRecord,
  type TweakLifecycleStatus,
  type TweakProcess,
} from "./tweak-lifecycle";
import { appendCappedLog } from "./logging";
import {
  getCdpStatus,
  getRuntimeCapabilities,
  getRuntimeInfo,
  listCdpTargets,
} from "./codex-runtime-probe";
import { NativeBridge, type NativeTweakContext } from "./native-bridge";
import { resolveRuntimeNativeHostPath } from "./native-host-path";
import type { TweakManifest } from "@therealityreport/tweakers-sdk";
import type {
  CodexRuntimeCapabilities,
  CodexRuntimeInfo,
  CodexViewCreateOptions,
  CodexViewRef,
  CodexWindowRef,
  NativeHelperLaunchOptions,
  NativeModuleLoadOptions,
  NativePanelCreateOptions,
  NativeViewAttachOptions,
  TweakPermission,
  CodexHotkeyRegistration,
  FrontmostWindowCapture,
  CodexPermissionStatus,
} from "@therealityreport/tweakers-sdk";
import {
  DEFAULT_TWEAK_STORE_INDEX_URL,
  normalizeGitHubRepo,
  normalizeStoreRegistry,
  shuffleStoreEntries,
  storeArchiveUrl,
  type TweakStorePublishSubmission,
  type TweakStoreEntry,
  type TweakStoreRegistry,
  type TweakStorePlatform,
  type TweakHealthRecord,
  deriveTweakStatus,
  isBundledStoreEntry,
  resolveBundledTweakPath,
} from "./tweak-store";
import { maybeStartBrowserUiServer } from "./browser-ui";
import { resolveLocalCliRuntime } from "./local-cli-runtime";
import { dispatchCrossTweakRead } from "./cross-tweak-read";
import { answerPromotionHealthRequest, hasAuthenticatedSessionCookie, hasAuthenticatedCodexToken, readCodexAuth } from "./promotion-health";
import {
  applyManagedCodexCliLaneAtBootstrap,
  createCodexCliManager,
  mutateCodexFeature,
  type ArchiveEntry,
  type CodexCliManagerDependencies,
} from "./codex-cli-manager";
import type { CodexCliLane } from "./codex-version-types";
import type {
  CodexReleaseCacheEntry,
  CodexVersionsSnapshot,
  GitHubCodexRelease,
} from "./codex-version-types";
import {
  buildCodexFeatureUnion,
  codexVersionChannel,
  compareCodexVersions,
  createCodexVersionService,
  isCodexDesktopUpdateNewer,
  parseCodexVersionTag,
  probeCodexDesktopVersion,
} from "./codex-version-service";
import {
  configureCodexSparkleBridge,
  getCodexSparkleBridge,
  type SparkleAppcastMetadata,
} from "./codex-sparkle-bridge";
import { installCodexAppServerParent } from "./codex-app-server-parent";
import {
  createCodexDesktopUpdateService,
  type CodexDesktopUpdateCheckResult,
  type CodexDesktopUpdateMetadata,
  type CodexDesktopUpdateTarget,
} from "./codex-desktop-update-service";
import { syncCodexDesktopUpdateMenuLabel as syncCodexDesktopUpdateMenu } from "./codex-desktop-update-menu";
import {
  activeVerifiedCodexDesktopProfileIdentity,
  codexDesktopUpdateTargetForProfile,
  createCapturedCodexDesktopProfileFeed,
  readCapturedCodexDesktopProfileFeed,
  safePersistedAppcastUrl,
  verifiedCodexDesktopProfileIdentity,
  type CapturedCodexDesktopProfileFeed,
} from "./codex-desktop-update-profile";

// Tweakers is the public name. Keep the Tweakers variables as compatibility
// aliases so existing patched apps and user data continue to boot.
const LEGACY_CONFIG_KEY = ["codex", "Plus", "Plus"].join("");
const LEGACY_USER_ROOT_ENV = ["CODEX", "PLUSPLUS", "USER_ROOT"].join("_");
const LEGACY_RUNTIME_ENV = ["CODEX", "PLUSPLUS", "RUNTIME"].join("_");
const LEGACY_MANUAL_UPDATE_ENV = ["CODEX", "PLUSPLUS", "MANUAL_UPDATE"].join("_");
const LEGACY_STORE_INDEX_ENV = ["CODEX", "PLUSPLUS", "STORE_INDEX_URL"].join("_");
const LEGACY_REMOTE_DEBUG_ENV = [["CODEX", "PP"].join(""), "REMOTE_DEBUG"].join("_");
const LEGACY_REMOTE_DEBUG_PORT_ENV = [["CODEX", "PP"].join(""), "REMOTE_DEBUG_PORT"].join("_");
const LEGACY_STORE_METADATA = [".codex", "pp-store.json"].join("");
const LEGACY_DATA_DIR = ["codex", "plusplus"].join("-");
const LEGACY_WINDOW_SERVICES_KEY = ["__codex", "pp_window_services__"].join("");
const userRoot = process.env.TWEAKERS_USER_ROOT
  ?? process.env.TWEAKER_USER_ROOT
  ?? process.env[LEGACY_USER_ROOT_ENV];
const runtimeDir = process.env.TWEAKERS_RUNTIME
  ?? process.env.TWEAKER_RUNTIME
  ?? process.env[LEGACY_RUNTIME_ENV];

if (!userRoot || !runtimeDir) {
  throw new Error(
    "Tweakers runtime started without a supported user-root/runtime environment",
  );
}

// Install before OpenAI's original main module loads and captures `spawn`.
// This keeps the locally signed desktop shell outside the native browser
// peer-authorizer's three-process ancestry window while preserving all of the
// native host's existing signature and identifier checks.
installCodexAppServerParent();

const PRELOAD_PATH = resolve(runtimeDir, "preload.js");
const TWEAKS_DIR = join(userRoot, "tweaks");
const LOG_DIR = join(userRoot, "log");
const LOG_FILE = join(LOG_DIR, "main.log");
const CONFIG_FILE = join(userRoot, "config.json");
const CODEX_CONFIG_FILE = join(homedir(), ".codex", "config.toml");
const INSTALLER_STATE_FILE = join(userRoot, "state.json");
const UPDATE_MODE_FILE = join(userRoot, "update-mode.json");
const SELF_UPDATE_STATE_FILE = join(userRoot, "self-update-state.json");
const MCP_SYNC_STATE_FILE = join(userRoot, "mcp-sync-state.json");
const ENVIRONMENT_SELECTION_FILE = join(userRoot, "environment-selection.json");
const ENVIRONMENT_REGISTRY_FILE = join(userRoot, "environment-registry.json");
const ENVIRONMENT_RUNTIME_PROOF_FILE = join(userRoot, "environment-runtime-proof.json");
const ENVIRONMENT_STATUS_TIMEOUT_MS = 60_000;
const ENVIRONMENT_PREPARE_TIMEOUT_MS = 15 * 60_000;
const ENVIRONMENT_ACTION_TIMEOUT_MS = 30_000;
const CLI_JSON_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TWEAK_CATALOG_FILE = join(runtimeDir, "catalog.json");
const TWEAK_BUNDLED_SOURCE_DIR = join(runtimeDir, "tweaks");
const TWEAK_LIFECYCLE_FILE = join(userRoot, "tweak-lifecycle.json");
const TWEAK_STARTUP_TIMEOUT_ENV = "TWEAKERS_TWEAK_STARTUP_TIMEOUT_MS";
const healthCheckOnly = process.env.TWEAKERS_HEALTH_CHECK_ONLY === "1";

// Candidate validation is a background bootstrap, not a second user-facing
// ChatGPT launch. Suppress LaunchServices/Dock activation before Electron is
// ready so installer probes never flash extra app icons or steal focus.
if (healthCheckOnly && process.platform === "darwin") {
  try { app.setActivationPolicy("prohibited"); } catch {}
  try { app.dock?.hide(); } catch {}
}
// [3d] requestSingleInstanceLock as defense-in-depth against duplicate launches.
//
// CAVEAT: this does NOT catch installer-side launches — the installer opens the
// app via `open`/LaunchServices, which can spawn or route independently of this
// process lock; the real duplicate-Dock-icon fix is the installer's single
// deterministic launch path (task 3a). And because this is injected code, our
// evaluation order relative to OpenAI's own entrypoint (and any single-instance
// handling it may already do) is NOT guaranteed. Treat this as belt-and-
// suspenders, not the primary fix. Skipped for the health-check probe, which is
// intentionally a short-lived second instance that must run and then exit.
if (!healthCheckOnly) {
  try {
    const gotSingleInstanceLock = app.requestSingleInstanceLock();
    if (!gotSingleInstanceLock) {
      app.quit();
    } else {
      app.on("second-instance", () => {
        const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
        const primary = windows.find((win) => !win.isMinimized()) ?? windows[0];
        if (!primary) return;
        if (primary.isMinimized()) primary.restore();
        primary.show();
        primary.focus();
      });
    }
  } catch (error) {
    log("warn", "single-instance lock setup failed", { message: (error as Error).message });
  }
}
const SIGNED_CODEX_BACKUP = join(userRoot, "backup", "Codex.app");
const TWEAKER_VERSION = "1.0.0";
const TWEAKER_REPO = "therealityreport/tweakers";
const TWEAK_STORE_INDEX_URL = process.env.TWEAKER_STORE_INDEX_URL
  ?? process.env[LEGACY_STORE_INDEX_ENV]
  ?? DEFAULT_TWEAK_STORE_INDEX_URL;
const CODEX_WINDOW_SERVICES_KEY = "__tweaker_window_services__";
const mainTweakReadHandlers = new Map<string, (...args: unknown[]) => unknown>();

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(TWEAKS_DIR, { recursive: true });
// One-time migration: the retired mode-switcher tweak persisted a soft
// vanilla mode; app modes are now real bundle swaps owned by the installer
// (`tweaker mode`). Drop the stale key so it can never gate tweaks again.
removeLegacyModeSwitcherState(userRoot);
const refreshStatusWatcher = chokidar.watch([
  SELF_UPDATE_STATE_FILE,
  join(userRoot, "refresh-state.json"),
  CONFIG_FILE,
], { ignoreInitial: true });
refreshStatusWatcher.on("all", () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("tweaker:refresh-status-changed");
});
app.once("will-quit", () => { void refreshStatusWatcher.close(); });

// Optional: enable Chrome DevTools Protocol on a TCP port so we can drive the
// running Codex from outside (curl http://localhost:<port>/json, attach via
// CDP WebSocket, take screenshots, evaluate in renderer, etc.). Codex's
// production build sets webPreferences.devTools=false, which kills the
// in-window DevTools shortcut, but `--remote-debugging-port` works regardless
// because it's a Chromium command-line switch processed before app init.
//
// Off by default. Set TWEAKER_REMOTE_DEBUG=1 (optionally TWEAKER_REMOTE_DEBUG_PORT)
// to turn it on. Must be appended before `app` becomes ready; we're at module
// top-level so that's fine.
if (process.env.TWEAKER_REMOTE_DEBUG === "1" || process.env[LEGACY_REMOTE_DEBUG_ENV] === "1") {
  const port = process.env.TWEAKER_REMOTE_DEBUG_PORT ?? process.env[LEGACY_REMOTE_DEBUG_PORT_ENV] ?? "9222";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  log("info", `remote debugging enabled on port ${port}`);
}

interface PersistedState {
  tweaker?: {
    autoUpdate?: boolean;
    safeMode?: boolean;
    updateChannel?: SelfUpdateChannel;
    updateRepo?: string;
    updateRef?: string;
    updateCheck?: TweakerUpdateCheck;
    /** Managed whole-backend selection. Absence preserves a user-owned override. */
    codexCliLane?: CodexCliLane;
    /** Installer-owned exact Alpha channel copy and immutable boot evidence. */
    codexCliPath?: string;
    codexCliVersion?: string;
    codexCliFingerprint?: string;
    /** Redacted validation failure from the most recent managed-lane bootstrap. */
    codexCliBootstrapFailure?: string;
    codexReleaseCache?: Partial<Record<CodexCliLane, CodexReleaseCacheEntry>>;
    codexAppcastCache?: {
      schemaVersion: 1;
      desktopVersion: string;
      marketingVersion: string;
      build: string;
      releaseUrl: string | null;
      /** Safe URL only: credentials, query, and fragment are never persisted. */
      feedUrl: string;
      checkedAt: string;
    };
    codexAppcastProfileCaches?: Partial<Record<"stable" | "alpha", {
      schemaVersion: 1;
      profile: "stable" | "alpha";
      identityKey: string;
      desktopVersion: string;
      marketingVersion: string;
      build: string;
      releaseUrl: string | null;
      /** Safe URL only: credentials, query, and fragment are never persisted. */
      feedUrl: string;
      checkedAt: string;
    }>>;
    /** Captures are profile/identity scoped. Native request headers are never persisted. */
    codexDesktopProfileFeeds?: Partial<Record<"stable" | "alpha", CapturedCodexDesktopProfileFeed>>;
    codexDesktopUpdateNotification?: {
      marketingVersion: string | null;
      build: string | null;
      notifiedAt: string;
    };
  };
  /** Per-tweak enable flags. Missing entries default to enabled. */
  tweaks?: Record<string, { enabled?: boolean }>;
  /** Cached GitHub release checks. Runtime never auto-installs updates. */
  tweakUpdateChecks?: Record<string, TweakUpdateCheck>;
  /** Last known load/health state for an installed tweak. */
  tweakHealth?: Record<string, TweakHealthRecord>;
}

interface TweakerUpdateCheck {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  updateAvailable: boolean;
  error?: string;
}

type SelfUpdateChannel = "stable" | "prerelease" | "custom";
type SelfUpdateStatus = "checking" | "up-to-date" | "updated" | "failed" | "disabled";

interface SelfUpdateState {
  checkedAt: string;
  completedAt?: string;
  status: SelfUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  targetRef: string | null;
  releaseUrl: string | null;
  repo: string;
  channel: SelfUpdateChannel;
  sourceRoot: string;
  installationSource?: InstallationSource;
  error?: string;
}

interface InstallationSource {
  kind: "github-source" | "homebrew" | "local-dev" | "source-archive" | "unknown";
  label: string;
  detail: string;
}

interface TweakUpdateCheck {
  checkedAt: string;
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  error?: string;
}

interface TweakVersionDriftRow {
  id: string;
  name: string;
  enabled: boolean;
  hasMcp: boolean;
  liveVersion: string | null;
  runtimeVersion: string | null;
  catalogVersion: string | null;
  status: "current" | "drift" | "missing";
  reason: string;
}

interface TweakHealthSnapshot {
  checkedAt: string;
  catalogCount: number;
  installedCount: number;
  enabledCount: number;
  liveDriftCount: number;
  runtimeDriftCount: number;
  missingLiveCount: number;
  missingRuntimeCount: number;
  mcpRestartRequired: boolean;
  rows: TweakVersionDriftRow[];
}

function readState(): PersistedState {
  try {
    const state = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PersistedState;
    const record = state as PersistedState & Record<string, unknown>;
    const legacy = record[LEGACY_CONFIG_KEY];
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      state.tweaker = {
        ...(legacy as NonNullable<PersistedState["tweaker"]>),
        ...(state.tweaker ?? {}),
      };
    }
    delete record[LEGACY_CONFIG_KEY];
    return state;
  } catch {
    return {};
  }
}
function writeState(s: PersistedState): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log("warn", "writeState failed:", String((e as Error).message));
  }
}

// The loader evaluates this module to completion before it requires OpenAI's
// original main entry. Apply the managed lane synchronously here so the
// backend resolver observes the final CODEX_CLI_PATH on its first import.
const bootstrapTweakerState = readState().tweaker;
const selectedManagedCli = bootstrapTweakerState?.codexCliPath
  && bootstrapTweakerState.codexCliVersion
  && bootstrapTweakerState.codexCliFingerprint
  ? {
      binaryPath: bootstrapTweakerState.codexCliPath,
      version: bootstrapTweakerState.codexCliVersion,
      fingerprint: bootstrapTweakerState.codexCliFingerprint,
    }
  : null;
const codexCliBootstrap = applyManagedCodexCliLaneAtBootstrap({
  lane: bootstrapTweakerState?.codexCliLane,
  home: homedir(),
  userRoot,
  env: process.env,
  selectedManagedCli,
  persistFailure: (message) => {
    const state = readState();
    state.tweaker ??= {};
    state.tweaker.codexCliBootstrapFailure = message;
    writeState(state);
  },
});
if (!healthCheckOnly) writeEnvironmentRuntimeProof();

const CODEX_RELEASE_API = "https://api.github.com/repos/openai/codex/releases?per_page=100";
const MAX_CODEX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const CODEX_APPCAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const codexAppcastMetadataByIdentity = new Map<string, SparkleAppcastMetadata>();

const codexVersionService = createCodexVersionService({
  currentVersion: TWEAKER_VERSION,
  now: Date.now,
  readReleaseCache: async (lane) => readState().tweaker?.codexReleaseCache?.[lane] ?? null,
  writeReleaseCache: async (lane, cache) => {
    const state = readState();
    state.tweaker ??= {};
    state.tweaker.codexReleaseCache ??= {};
    state.tweaker.codexReleaseCache[lane] = cache;
    writeState(state);
  },
  fetchReleases: async (signal) => {
    const response = await fetch(CODEX_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `tweakers/${TWEAKER_VERSION}`,
      },
      signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("GitHub returned an invalid release list");
    return value as GitHubCodexRelease[];
  },
  execFile: (binary, args, options) => execFileResult(binary, args, options.timeoutMs, options.maxOutputBytes),
});

const codexCliManager = createCodexCliManager({
  home: homedir(),
  userRoot,
  deps: createCodexCliManagerDependencies(),
});
codexCliManager.recover();

const CODEX_DESKTOP_UPDATE_CHANGED_CHANNEL = "tweaker:codex-desktop-update-changed";
let lastPublishedCodexDesktopUpdate: CodexDesktopUpdateCheckResult | null = null;
let originalSetApplicationMenu: typeof Menu.setApplicationMenu | null = null;

function desktopUpdateResultWithNativeState(
  result: CodexDesktopUpdateCheckResult,
): CodexDesktopUpdateCheckResult {
  const bridge = getCodexSparkleBridge();
  const sparkle = bridge.getSnapshot();
  return {
    ...result,
    installed: { ...result.installed },
    latest: { ...result.latest },
    nativeUpdateControlActive: bridge.nativeUpdateControlActive(),
    javaScriptUpdaterManagerAvailable: sparkle.available,
    javaScriptUpdaterManagerReason: sparkle.available
      ? null
      : "OpenAI's JavaScript updater manager did not initialize the native Sparkle bridge.",
  };
}

function publishCodexDesktopUpdateResult(result: CodexDesktopUpdateCheckResult): void {
  getCodexSparkleBridge().setSafeUpdateAvailable(result.status === "update-available");
  const published = desktopUpdateResultWithNativeState(result);
  lastPublishedCodexDesktopUpdate = published;
  broadcastCodexDesktopUpdateResult(published);
}

function selectedDesktopUpdateSetupResult(): CodexDesktopUpdateCheckResult | null {
  const target = selectedCodexDesktopUpdateTarget();
  if (target.available || !target.setupRequired) return null;
  return {
    schemaVersion: 1,
    status: "unavailable",
    profile: target.profile,
    installed: { marketingVersion: null, build: null },
    latest: { marketingVersion: null, build: null },
    checkedAt: new Date().toISOString(),
    reason: target.unavailableReason,
    retryRequested: false,
    updateAndReloadRequested: false,
    setupRequired: target.setupRequired,
  };
}

function broadcastCodexDesktopUpdateResult(result: CodexDesktopUpdateCheckResult): void {
  rebuildCodexDesktopUpdateMenu(result);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(CODEX_DESKTOP_UPDATE_CHANGED_CHANNEL, result);
  }
}

function syncCodexDesktopUpdateMenuBeforeAttach(
  menu: Electron.Menu,
  result: CodexDesktopUpdateCheckResult | null,
): void {
  syncCodexDesktopUpdateMenu(menu, result?.status === "update-available", () => {
    void requestCodexDesktopManualCheck("application-menu");
  }, !!result?.setupRequired);
}

function rebuildCodexDesktopUpdateMenu(result: CodexDesktopUpdateCheckResult): void {
  const applicationMenu = Menu.getApplicationMenu();
  if (!applicationMenu || !originalSetApplicationMenu) return;
  try {
    const template = applicationMenu.items.map(
      (item) => item as unknown as Electron.MenuItemConstructorOptions,
    );
    const rebuilt = Menu.buildFromTemplate(template);
    syncCodexDesktopUpdateMenuBeforeAttach(rebuilt, result);
    Reflect.apply(originalSetApplicationMenu, Menu, [rebuilt]);
  } catch (error) {
    log("warn", "desktop update menu rebuild failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function installCodexDesktopUpdateMenuReplay(): void {
  const setApplicationMenu = Menu.setApplicationMenu;
  originalSetApplicationMenu = setApplicationMenu;
  try {
    Menu.setApplicationMenu = function tweakerSetApplicationMenu(menu: Electron.Menu | null): void {
      if (menu) {
        syncCodexDesktopUpdateMenuBeforeAttach(
          menu,
          lastPublishedCodexDesktopUpdate ?? selectedDesktopUpdateSetupResult(),
        );
      }
      Reflect.apply(setApplicationMenu, Menu, [menu]);
    };
  } catch (error) {
    log("warn", "desktop update menu replay unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

installCodexDesktopUpdateMenuReplay();

const codexDesktopUpdateService = createCodexDesktopUpdateService({
  resolveTarget: async () => selectedCodexDesktopUpdateTarget(),
  refreshMetadata: refreshCodexDesktopUpdateMetadata,
  showDialog: async (options) => dialog.showMessageBox({
    type: options.type,
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
    defaultId: options.defaultId,
    cancelId: options.cancelId,
    noLink: options.noLink,
  }),
  startUpdateAndReload: startCodexDesktopUpdateTransaction,
  onResult: publishCodexDesktopUpdateResult,
});

async function requestCodexDesktopManualCheck(source: "application-menu" | "native-sparkle"): Promise<void> {
  const sparkle = getCodexSparkleBridge().getSnapshot();
  if (!sparkle.available) {
    log("warn", "desktop JavaScript updater manager unavailable; using Tweakers metadata service", {
      source,
      reason: sparkle.installPrerequisiteFailure,
    });
  }
  await codexDesktopUpdateService.checkAndPresent();
}

const PROACTIVE_DESKTOP_UPDATE_INITIAL_DELAY_MS = 15_000;
const PROACTIVE_DESKTOP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function scheduleProactiveDesktopUpdateChecks(): void {
  const schedule = (delay: number): void => {
    const timer = setTimeout(() => {
      void runProactiveDesktopUpdateCheck().then(
        () => schedule(PROACTIVE_DESKTOP_UPDATE_INTERVAL_MS),
        (error) => {
          log("warn", "proactive desktop update check failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          schedule(PROACTIVE_DESKTOP_UPDATE_INTERVAL_MS);
        },
      );
    }, delay);
    timer.unref?.();
  };
  schedule(PROACTIVE_DESKTOP_UPDATE_INITIAL_DELAY_MS);
}

async function runProactiveDesktopUpdateCheck(): Promise<void> {
  const result = await codexDesktopUpdateService.checkSilently();
  if (result.status !== "update-available") return;
  const state = readState();
  const prior = state.tweaker?.codexDesktopUpdateNotification;
  if (prior?.marketingVersion === result.latest.marketingVersion && prior.build === result.latest.build) return;
  if (!Notification.isSupported()) return;
  const version = result.latest.marketingVersion ?? "a newer version";
  const build = result.latest.build ? ` (build ${result.latest.build})` : "";
  new Notification({
    title: "ChatGPT Update Available",
    body: `${version}${build} is available. Use Check for Updates… or Update and Reload.`,
  }).show();
  state.tweaker ??= {};
  state.tweaker.codexDesktopUpdateNotification = {
    marketingVersion: result.latest.marketingVersion,
    build: result.latest.build,
    notifiedAt: new Date().toISOString(),
  };
  writeState(state);
}

function createCodexCliManagerDependencies(): CodexCliManagerDependencies {
  return {
    now: () => new Date(),
    operationId: randomUUID,
    resolveRelease: async () => {
      const lookup = await codexVersionService.fetchLatestRelease("beta", { force: true });
      const release = lookup.release;
      if (!release || !release.asset || release.error) {
        throw new Error(lookup.error ?? release?.error ?? "No installable Codex Beta release is available");
      }
      return {
        version: release.version,
        tag: release.tag,
        assetName: release.asset.name,
        assetUrl: release.asset.url,
        digest: release.asset.digest,
        architecture: "aarch64-apple-darwin",
      };
    },
    download: downloadManagedCodexArchive,
    listArchive: listManagedCodexArchive,
    extractArchive: async (archive, destination) => {
      await extractTar({ file: archive, cwd: destination, preservePaths: false, strict: true });
    },
    verifySignature: async (binary) => {
      if (process.platform !== "darwin") return false;
      try {
        await execFileResult("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary], 5_000, 64 * 1024);
        await execFileResult("/usr/bin/codesign", [
          "-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"",
          "--verify",
          binary,
        ], 5_000, 64 * 1024);
        return true;
      } catch {
        return false;
      }
    },
    probeVersion: async (binary) => (await execFileResult(binary, ["--version"], 5_000, 64 * 1024)).stdout.trim(),
    probeArchitecture: async (binary) => {
      const output = (await execFileResult("/usr/bin/file", ["-b", binary], 5_000, 64 * 1024)).stdout;
      if (/arm64|aarch64/i.test(output)) return "aarch64-apple-darwin";
      return "unsupported";
    },
  };
}

async function downloadManagedCodexArchive(
  release: { assetUrl: string },
  destination: string,
  onBytes?: (bytes: number) => void,
): Promise<{ bytes: number; digest: string }> {
  const response = await fetch(release.assetUrl, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Codex download returned ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_CODEX_DOWNLOAD_BYTES) throw new Error("Codex download exceeds maximum size");
  const digest = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_CODEX_DOWNLOAD_BYTES) {
        callback(new Error("Codex download exceeds maximum size"));
        return;
      }
      digest.update(chunk);
      onBytes?.(bytes);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(destination, { mode: 0o600 }));
  if (declaredLength > 0 && bytes !== declaredLength) throw new Error("Codex download length did not match Content-Length");
  return { bytes, digest: digest.digest("hex") };
}

async function listManagedCodexArchive(archive: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await listTar({
    file: archive,
    onentry: (entry) => {
      const type = entry.type === "File" || entry.type === "OldFile" ? "file"
        : entry.type === "Directory" ? "directory"
          : entry.type.toLowerCase();
      entries.push({ path: entry.path, type, ...(entry.linkpath ? { linkPath: entry.linkpath } : {}) });
    },
  });
  return entries;
}

function execFileResult(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(binary, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => {
      if (error) rejectPromise(error);
      else resolvePromise({ stdout, stderr });
    });
  });
}
function isTweakerAutoUpdateEnabled(): boolean {
  return readState().tweaker?.autoUpdate !== false;
}
function setTweakerAutoUpdate(enabled: boolean): void {
  const s = readState();
  s.tweaker ??= {};
  s.tweaker.autoUpdate = enabled;
  writeState(s);
}
function setTweakerUpdateConfig(config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}): void {
  const s = readState();
  s.tweaker ??= {};
  if (config.updateChannel) s.tweaker.updateChannel = config.updateChannel;
  if ("updateRepo" in config) s.tweaker.updateRepo = cleanOptionalString(config.updateRepo);
  if ("updateRef" in config) s.tweaker.updateRef = cleanOptionalString(config.updateRef);
  writeState(s);
}
function isTweakerSafeModeEnabled(): boolean {
  return readState().tweaker?.safeMode === true;
}

function isTweakEnabled(id: string): boolean {
  const s = readState();
  if (s.tweaker?.safeMode === true) return false;
  if (s.tweakHealth?.[id]?.status === "quarantined") return false;
  return s.tweaks?.[id]?.enabled !== false;
}
function setTweakEnabled(id: string, enabled: boolean): void {
  const s = readState();
  s.tweaks ??= {};
  s.tweaks[id] = { ...s.tweaks[id], enabled };
  writeState(s);
}

function tweakHealth(id: string): TweakHealthRecord | null {
  return readState().tweakHealth?.[id] ?? null;
}

function recordTweakHealth(id: string, status: TweakHealthRecord["status"], error?: unknown): TweakHealthRecord {
  const state = readState();
  state.tweakHealth ??= {};
  const record: TweakHealthRecord = {
    status,
    updatedAt: new Date().toISOString(),
    ...(error === undefined ? {} : { error: String(error) }),
  };
  state.tweakHealth[id] = record;
  writeState(state);
  return record;
}

function clearTweakHealth(id: string): void {
  const state = readState();
  if (!state.tweakHealth?.[id]) return;
  delete state.tweakHealth[id];
  if (Object.keys(state.tweakHealth).length === 0) delete state.tweakHealth;
  writeState(state);
}

function isTweakQuarantined(id: string): boolean {
  return tweakHealth(id)?.status === "quarantined";
}

function recoverTweak(id: string): Promise<true> {
  clearTweakHealth(id);
  return setTweakEnabledAndReload(id, true, tweakLifecycleDeps);
}

interface InstallerState {
  appRoot: string;
  codexVersion: string | null;
  codexBundleId?: "com.openai.codex" | "com.openai.codex.beta";
  sourceRoot?: string;
}

function readInstallerState(): InstallerState | null {
  try {
    return JSON.parse(readFileSync(INSTALLER_STATE_FILE, "utf8")) as InstallerState;
  } catch {
    return null;
  }
}

function readSelfUpdateState(): SelfUpdateState | null {
  try {
    return JSON.parse(readFileSync(SELF_UPDATE_STATE_FILE, "utf8")) as SelfUpdateState;
  } catch {
    return null;
  }
}
function writeSelfUpdateState(state: SelfUpdateState): void {
  try {
    writeFileSync(SELF_UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("warn", "writeSelfUpdateState failed:", String((e as Error).message));
  }
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isPathInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}\n`;
  try {
    appendCappedLog(LOG_FILE, line);
  } catch {}
  if (level === "error") console.error("[tweaker]", ...args);
}

const lifecycleAttemptId = randomUUID();
let lifecycleJournal: TweakLifecycleJournal;

function readTweakLifecycleJournal(): TweakLifecycleJournal {
  try {
    const parsed = JSON.parse(readFileSync(TWEAK_LIFECYCLE_FILE, "utf8")) as Partial<TweakLifecycleJournal>;
    if (parsed.schemaVersion !== 1 || !parsed.records || typeof parsed.records !== "object") {
      throw new Error("unsupported tweak lifecycle journal");
    }
    return {
      schemaVersion: 1,
      currentAttempt: parsed.currentAttempt && typeof parsed.currentAttempt === "object"
        ? parsed.currentAttempt as TweakLifecycleJournal["currentAttempt"]
        : null,
      records: parsed.records as Record<string, TweakLifecycleRecord>,
    };
  } catch {
    return createTweakLifecycleJournal("uninitialized", process.pid);
  }
}

function writeTweakLifecycleJournal(): void {
  try {
    writeFileSync(TWEAK_LIFECYCLE_FILE, JSON.stringify(lifecycleJournal, null, 2));
  } catch (error) {
    log("warn", "failed to persist tweak lifecycle journal:", String(error));
  }
}

function beginTweakLifecycleAttempt(): void {
  const before = readTweakLifecycleJournal();
  const previous = recoverInterruptedTweaks(before);
  lifecycleJournal = {
    ...previous,
    currentAttempt: {
      id: lifecycleAttemptId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
  };
  writeTweakLifecycleJournal();
  for (const [key, record] of Object.entries(previous.records)) {
    const beforeRecord = before.records[key];
    if (beforeRecord?.status !== "starting") continue;
    if (record.status === "quarantined") {
      recordTweakHealth(record.id, "quarantined", record.error);
      log("warn", `quarantined interrupted ${record.process} tweak: ${record.id} (${record.interruptedAttempts ?? "?"} consecutive interruptions)`);
    } else if (record.status === "failed") {
      log("info", `previous startup of ${record.process} tweak ${record.id} was interrupted; retrying this launch`);
    }
  }
}

function finishTweakLifecycleAttempt(): void {
  if (!lifecycleJournal.currentAttempt || lifecycleJournal.currentAttempt.id !== lifecycleAttemptId) return;
  lifecycleJournal = {
    ...lifecycleJournal,
    currentAttempt: {
      ...lifecycleJournal.currentAttempt,
      completedAt: new Date().toISOString(),
    },
  };
  writeTweakLifecycleJournal();
}

function recordTweakLifecycle(
  id: string,
  processName: TweakProcess,
  status: TweakLifecycleStatus,
  error?: unknown,
): TweakLifecycleRecord {
  const now = new Date().toISOString();
  const key = lifecycleRecordKey(processName, id);
  const previous = lifecycleJournal.records[key];
  const record: TweakLifecycleRecord = {
    id,
    process: processName,
    status,
    attemptId: lifecycleAttemptId,
    updatedAt: now,
    ...(status === "starting" ? { startedAt: now } : {}),
    ...(status === "ready" || status === "failed" || status === "timed_out" || status === "disabled" || status === "quarantined"
      ? { finishedAt: now }
      : {}),
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  };
  if (status === "starting" && previous?.startedAt) record.startedAt = previous.startedAt;
  // Carry the consecutive-interruption counter across the retry's "starting"
  // write so repeated interruptions can escalate to quarantine; any terminal
  // outcome (ready/failed/…) starts a fresh record and resets the counter.
  if (status === "starting" && previous?.interruptedAttempts) {
    record.interruptedAttempts = previous.interruptedAttempts;
  }
  lifecycleJournal = {
    ...lifecycleJournal,
    records: { ...lifecycleJournal.records, [key]: record },
  };
  writeTweakLifecycleJournal();

  // Keep the existing health/status contract in sync. A lifecycle failure is
  // per-tweak and therefore must never prevent sibling tweaks from loading.
  if (status === "failed" || status === "timed_out") {
    recordTweakHealth(id, "failed", error ?? status);
  } else if (status === "quarantined") {
    recordTweakHealth(id, "quarantined", error ?? "startup attempt was interrupted");
  } else if (status === "ready") {
    clearTweakHealth(id);
  }
  return record;
}

function lifecycleStartupTimeoutMs(): number {
  const raw = process.env[TWEAK_STARTUP_TIMEOUT_ENV];
  return normalizeTweakStartupTimeoutMs(raw === undefined ? undefined : Number(raw));
}

beginTweakLifecycleAttempt();

function installSparkleUpdateHook(): void {
  if (process.platform !== "darwin") return;

  const Module = require("node:module") as typeof import("node:module") & {
    _load?: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = Module._load;
  if (typeof originalLoad !== "function") return;

  Module._load = function tweakerModuleLoad(request: string, parent: unknown, isMain: boolean) {
    const loaded = originalLoad.apply(this, [request, parent, isMain]) as unknown;
    if (typeof request === "string" && /sparkle(?:\.node)?$/i.test(request)) {
      getCodexSparkleBridge().wrapExports(loaded);
    }
    return loaded;
  };
}

function restorePristineCodexApp(backup: string, appRoot: string): void {
  // Prefer an APFS clonefile (near-instant copy-on-write) over ditto's full
  // ~1.4 GB byte copy that stalled the Electron main thread. `cp -Rc` clones
  // on the same volume; clone into a sibling, then atomically rename into
  // place so the running bundle is swapped, not mutated underneath the live
  // process. Any failure (cross-volume, no clonefile support, etc.) falls
  // back to the exact previous behavior: a `ditto` overlay.
  const staged = `${appRoot}.tweakers-sparkle-restore`;
  try { rmSync(staged, { recursive: true, force: true }); } catch {}
  try {
    execFileSync("/bin/cp", ["-Rc", backup, staged], { stdio: "ignore" });
    rmSync(appRoot, { recursive: true, force: true });
    renameSync(staged, appRoot);
    return;
  } catch {
    try { rmSync(staged, { recursive: true, force: true }); } catch {}
  }
  execFileSync("ditto", [backup, appRoot], { stdio: "ignore" });
}

function prepareSignedCodexForSparkleInstall(): boolean {
  if (process.platform !== "darwin") return false;
  if (existsSync(UPDATE_MODE_FILE)) {
    log("info", "Sparkle update prep skipped; update mode already active");
    return true;
  }
  if (!existsSync(SIGNED_CODEX_BACKUP)) {
    log("warn", "Sparkle update prep skipped; signed Codex.app backup is missing");
    return false;
  }
  if (!isDeveloperIdSignedApp(SIGNED_CODEX_BACKUP)) {
    log("warn", "Sparkle update prep skipped; Codex.app backup is not Developer ID signed");
    return false;
  }

  const state = readInstallerState();
  const appRoot = state?.appRoot ?? inferMacAppRoot();
  if (!appRoot) {
    log("warn", "Sparkle update prep skipped; could not infer Codex.app path");
    return false;
  }

  const mode = {
    enabledAt: new Date().toISOString(),
    appRoot,
    codexVersion: state?.codexVersion ?? null,
  };
  try {
    restorePristineCodexApp(SIGNED_CODEX_BACKUP, appRoot);
    try {
      execFileSync("xattr", ["-dr", "com.apple.quarantine", appRoot], { stdio: "ignore" });
    } catch {}
    // Commit update mode only after the pristine bundle is fully restored.
    // An interrupted restore must never leave a marker that authorizes Sparkle.
    writeFileSync(UPDATE_MODE_FILE, JSON.stringify(mode, null, 2));
    log("info", "Restored signed Codex.app before Sparkle install", { appRoot });
    return true;
  } catch (e) {
    try { rmSync(UPDATE_MODE_FILE, { force: true }); } catch {}
    log("error", "Failed to restore signed Codex.app before Sparkle install", {
      message: (e as Error).message,
    });
    throw e;
  }
}

function codexDesktopInstallPrerequisiteFailure(): string | null {
  if (!existsSync(SIGNED_CODEX_BACKUP)) {
    return "The verified Developer ID signed Codex.app backup is missing. Refresh Tweakers before installing the desktop update.";
  }
  if (!isDeveloperIdSignedApp(SIGNED_CODEX_BACKUP)) {
    return "The Codex.app backup is not Developer ID signed. Refresh Tweakers before installing the desktop update.";
  }
  if (!(readInstallerState()?.appRoot ?? inferMacAppRoot())) {
    return "Tweakers could not determine the installed Codex.app location.";
  }
  return null;
}

function isDeveloperIdSignedApp(appRoot: string): boolean {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", appRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return (
    result.status === 0 &&
    /Authority=Developer ID Application:/.test(output) &&
    !/Signature=adhoc/.test(output) &&
    !/TeamIdentifier=not set/.test(output)
  );
}

function inferMacAppRoot(): string | null {
  const marker = ".app/Contents/MacOS/";
  const idx = process.execPath.indexOf(marker);
  return idx >= 0 ? process.execPath.slice(0, idx + ".app".length) : null;
}

function writeEnvironmentRuntimeProof(): void {
  try {
    const proofUserRoot = userRoot;
    if (!proofUserRoot) throw new Error("could not determine the Tweakers user root");
    const appRoot = inferMacAppRoot();
    if (!appRoot) throw new Error("could not infer the exact running app path");
    const state = readInstallerState();
    const bundleId = state?.codexBundleId ?? null;
    const binaryPath = codexCliBootstrap.binary
      ?? join(appRoot, "Contents", "Resources", "codex");
    if (!existsSync(binaryPath)) throw new Error(`selected backend is missing at ${binaryPath}`);
    const versionProbe = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (versionProbe.status !== 0) throw new Error("selected backend version probe failed");
    const version = `${versionProbe.stdout ?? ""}${versionProbe.stderr ?? ""}`.trim().split(/\s+/).at(-1) ?? null;
    if (!version) throw new Error("selected backend version is empty");
    const activeRuntimePath = join(proofUserRoot, "runtime");
    const activeRuntime = readRuntimeFingerprintEvidence(activeRuntimePath);
    if (!activeRuntime) throw new Error(`active runtime fingerprint is invalid at ${activeRuntimePath}`);
    const managedRuntimePath = join(
      proofUserRoot,
      "managed-runtime",
      "current",
      "packages",
      "installer",
      "assets",
      "runtime",
    );
    const managedRuntime = readRuntimeFingerprintEvidence(managedRuntimePath);
    if (!managedRuntime) throw new Error(`managed runtime fingerprint is invalid at ${managedRuntimePath}`);
    const managedSourceRuntimeHash = readManagedRuntimeSourceHash(proofUserRoot);
    const proof = {
      schemaVersion: 1,
      kind: "environment-runtime-proof",
      pid: process.pid,
      appRoot,
      bundleId,
      appExperience: "tweakers",
      releaseProfile: bundleId === "com.openai.codex.beta" ? "alpha" : "stable",
      backendLane: codexCliBootstrap.effectiveLane === "beta" ? "managed-alpha" : "bundled",
      binaryPath,
      backendVersion: version,
      backendFingerprint: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"),
      runtimePath: activeRuntimePath,
      runtimeFingerprint: activeRuntime.fingerprint,
      runtimeFileCount: activeRuntime.fileCount,
      managedRuntimePath,
      managedRuntimeFingerprint: managedRuntime.fingerprint,
      managedRuntimeFileCount: managedRuntime.fileCount,
      managedSourceRuntimeHash,
      observedAt: new Date().toISOString(),
    };
    const temporary = `${ENVIRONMENT_RUNTIME_PROOF_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, ENVIRONMENT_RUNTIME_PROOF_FILE);
  } catch (error) {
    // A failed startup must never leave a previous process's runtime proof
    // available for a transaction to mistake as current evidence.
    try { rmSync(ENVIRONMENT_RUNTIME_PROOF_FILE, { force: true }); } catch {}
    log("error", "environment runtime proof failed", { message: (error as Error).message });
  }
}

function readManagedRuntimeSourceHash(root: string): string | null {
  try {
    const provenance = JSON.parse(readFileSync(
      join(root, "managed-runtime", "current", ".tweakers-provenance.json"),
      "utf8",
    )) as { sourceRuntimeHash?: unknown };
    return typeof provenance.sourceRuntimeHash === "string"
      && /^[a-f0-9]{64}$/i.test(provenance.sourceRuntimeHash)
      ? provenance.sourceRuntimeHash
      : null;
  } catch {
    return null;
  }
}

// Surface unhandled errors from anywhere in the main process to our log.
process.on("uncaughtException", (e: Error & { code?: string }) => {
  log("error", "uncaughtException", { code: e.code, message: e.message, stack: e.stack });
});
process.on("unhandledRejection", (e) => {
  log("error", "unhandledRejection", { value: String(e) });
});

configureCodexSparkleBridge({
  requestManualCheck: async () => {
    await requestCodexDesktopManualCheck("native-sparkle");
  },
  requestBackgroundCheck: runProactiveDesktopUpdateCheck,
  requestInstall: startCodexDesktopUpdateTransaction,
  prepareForInstall: prepareSignedCodexForSparkleInstall,
  getInstallPrerequisite: codexDesktopInstallPrerequisiteFailure,
  onFeedCaptured: persistCapturedCodexDesktopProfileFeed,
  onNativeControlActivityChanged: () => {
    queueMicrotask(() => {
      if (!lastPublishedCodexDesktopUpdate) return;
      const published = desktopUpdateResultWithNativeState(lastPublishedCodexDesktopUpdate);
      if (published.nativeUpdateControlActive === lastPublishedCodexDesktopUpdate.nativeUpdateControlActive) return;
      lastPublishedCodexDesktopUpdate = published;
      broadcastCodexDesktopUpdateResult(published);
    });
  },
});
installSparkleUpdateHook();

interface LoadedMainTweak {
  stop?: () => void;
  storage: DiskStorage;
}

interface CodexWindowServices {
  createFreshWindow?: (route?: string) => Promise<Electron.BrowserWindow | null>;
  createFreshLocalWindow?: (route?: string) => Promise<Electron.BrowserWindow | null>;
  ensureHostWindow?: (hostId?: string) => Promise<Electron.BrowserWindow | null>;
  getPrimaryWindow?: (hostId?: string) => Electron.BrowserWindow | null;
  getContext?: (hostId: string) => { registerWindow?: (windowLike: CodexWindowLike) => void } | null;
  windowManager?: {
    createWindow?: (opts: Record<string, unknown>) => Promise<Electron.BrowserWindow | null>;
    getPrimaryWindow?: () => Electron.BrowserWindow | null;
    registerWindow?: (
      windowLike: CodexWindowLike,
      hostId: string,
      primary: boolean,
      appearance: string,
    ) => void;
    options?: {
      allowDevtools?: boolean;
      preloadPath?: string;
    };
  };
}

interface CodexWindowLike {
  id: number;
  webContents: Electron.WebContents;
  on(event: "closed", listener: () => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  isDestroyed?(): boolean;
  isFocused?(): boolean;
  focus?(): void;
  show?(): void;
  hide?(): void;
  getBounds?(): Electron.Rectangle;
  getContentBounds?(): Electron.Rectangle;
  getSize?(): [number, number];
  getContentSize?(): [number, number];
  setTitle?(title: string): void;
  getTitle?(): string;
  setRepresentedFilename?(filename: string): void;
  setDocumentEdited?(edited: boolean): void;
  setWindowButtonVisibility?(visible: boolean): void;
}

interface CodexCreateWindowOptions {
  route: string;
  hostId?: string;
  show?: boolean;
  appearance?: string;
  parentWindowId?: number;
  bounds?: Electron.Rectangle;
}

interface CodexCreateViewOptions {
  route: string;
  hostId?: string;
  appearance?: string;
}

type OwlViewAttachMode = "contentView" | "browserView";

interface ManagedOwlView {
  key: string;
  tweakId: string;
  id: string;
  view: Electron.BrowserView;
  parentWindowId: number | null;
  attachMode: OwlViewAttachMode | null;
  disposeBindings: Array<() => void>;
  disposed: boolean;
}

const tweakState = {
  discovered: [] as DiscoveredTweak[],
  loadedMain: new Map<string, LoadedMainTweak>(),
};
const mainIpcHandlerRegistrations = new Map<string, symbol>();

// Candidate health probes run from a disposable user root and must remain
// observational. In particular, they must never watch or reconcile the real
// ~/.codex/config.toml while validating a staged runtime.
const mcpReconciler = healthCheckOnly ? null : createMcpReconciler({
  configPath: CODEX_CONFIG_FILE,
  statePath: MCP_SYNC_STATE_FILE,
  getTweaks: () => mcpSyncTweaks(true),
  getOwnedTweaks: () => mcpSyncTweaks(false),
  onReceipt: (receipt) => {
    const summary = receipt.conflicts.length > 0
      ? receipt.conflicts.map((conflict) => (
        `${conflict.observedName} -> ${conflict.canonicalName} (${conflict.reason})`
      )).join(", ")
      : receipt.appliedNames.join(", ") || "none";
    log("info", `MCP reconciliation ${receipt.status}: ${summary}`);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("tweaker:mcp-sync-state-changed", receipt);
    }
  },
  onError: (error) => log("warn", "failed to reconcile Codex MCP config:", error),
});
let initialMcpReconciliationPending = true;

function mcpSyncTweaks(enabledOnly: boolean) {
  return tweakState.discovered
    .filter((tweak) => !enabledOnly || isTweakEnabled(tweak.manifest.id))
    .map((tweak) => ({
      dir: tweak.dir,
      dataDir: join(userRoot!, "tweak-data", tweak.manifest.id),
      manifest: tweak.manifest,
    }));
}

const nativeBridge = new NativeBridge(log, {
  nativeHostPath: resolveRuntimeNativeHostPath({
    resourcesPath: process.resourcesPath,
    runtimeDir,
    packaged: app.isPackaged,
    allowExternalDevelopmentFallback: app.isPackaged === false
      && (process.defaultApp === true || healthCheckOnly),
  }),
});
const owlViews = new Map<string, ManagedOwlView>();

const tweakLifecycleDeps = {
  logInfo: (message: string) => log("info", message),
  setTweakEnabled,
  stopAllMainTweaks,
  clearTweakModuleCache,
  loadAllMainTweaks,
  broadcastReload,
};

// 1. Hook every session so our preload runs in every renderer.
//
// We use Electron's modern `session.registerPreloadScript` API (added in
// Electron 35). The deprecated `setPreloads` path silently no-ops in some
// configurations (notably with sandboxed renderers), so registerPreloadScript
// is the only reliable way to inject into Codex's BrowserWindows.
function registerPreload(s: Electron.Session, label: string): void {
  if (healthCheckOnly) return;
  try {
    const reg = (s as unknown as {
      registerPreloadScript?: (opts: {
        type?: "frame" | "service-worker";
        id?: string;
        filePath: string;
      }) => string;
    }).registerPreloadScript;
    if (typeof reg === "function") {
      reg.call(s, { type: "frame", filePath: PRELOAD_PATH, id: "tweaker" });
      log("info", `preload registered (registerPreloadScript) on ${label}:`, PRELOAD_PATH);
      return;
    }
    // Fallback for older Electron versions.
    const existing = s.getPreloads();
    if (!existing.includes(PRELOAD_PATH)) {
      s.setPreloads([...existing, PRELOAD_PATH]);
    }
    log("info", `preload registered (setPreloads) on ${label}:`, PRELOAD_PATH);
  } catch (e) {
    if (e instanceof Error && e.message.includes("existing ID")) {
      log("info", `preload already registered on ${label}:`, PRELOAD_PATH);
      return;
    }
    log("error", `preload registration on ${label} failed:`, e);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

type PromotionProbeValue = "pass" | "fail" | "unknown";
const USER_QUESTIONS_TWEAK_ID = "co.tweakers.user-questions";
const USER_QUESTIONS_FOLDER = "user-questions";
const SANITIZED_PROMOTION_POLICY_FAILURES = new WeakSet<object>();

function assertPromotionProbeIsolation(): void {
  if (!healthCheckOnly) throw new Error("promotion probes require a one-shot health process");
  const candidateRequested = process.env.TWEAKERS_CANDIDATE_MCP_RECONCILIATION !== undefined;
  if (candidateRequested && !MCP_RUNTIME_PATHS.candidateIsolated) {
    throw new Error("candidate promotion probe did not resolve contained MCP paths");
  }
}

function promotionSurfaceHash(surface: PromotionSurfaceName): string {
  assertPromotionProbeIsolation();
  switch (surface) {
    case "app": return promotionAppHeaderHash();
    case "runtime": return fingerprintPromotionPath(runtimeDir!);
    case "tweakTree": return fingerprintPromotionPath(TWEAKS_DIR);
    case "tweakersConfig": return fingerprintPromotionPath(CONFIG_FILE);
    case "codexConfig": return fingerprintPromotionPath(CODEX_CONFIG_FILE);
    case "namespaceData": return fingerprintPromotionPath(join(userRoot!, "tweak-data", USER_QUESTIONS_TWEAK_ID));
    case "mainStorage": return fingerprintPromotionPath(join(userRoot!, "storage", `${USER_QUESTIONS_TWEAK_ID}.json`));
    case "policy": return promotionPolicySurfaceHash();
  }
}

function promotionPolicySurfaceHash(): string {
  try {
    return fingerprintPromotionPolicyPath(join(MCP_RUNTIME_PATHS.codexHome, ".codex-global-state.json"));
  } catch (error) {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      SANITIZED_PROMOTION_POLICY_FAILURES.add(error);
    }
    log("error", "promotion policy fingerprint failed", {
      surface: "policy",
      reason: promotionPolicyFingerprintFailureReason(error),
    });
    throw error;
  }
}

/** Parse only the bounded ASAR pickle header and hash the decoded JSON string. */
function promotionAppHeaderHash(): string {
  const archivePath = join(process.resourcesPath, "app.asar");
  // Electron's ordinary fs facade treats app.asar as a virtual directory.
  // Promotion proof needs the sealed archive bytes, so use the raw fs module.
  return hashRawAsarHeader(archivePath, originalFs);
}

/** Mode- and link-aware deterministic hash paired with install.ts. */
function fingerprintPromotionPath(path: string): string {
  if (!existsSync(path)) return "missing";
  const digest = createHash("sha256");
  const visit = (entryPath: string, name: string): void => {
    const stat = lstatSync(entryPath);
    digest.update(name).update("\0").update(String(stat.mode & 0o777)).update("\0");
    if (stat.isDirectory()) {
      digest.update("directory\0");
      for (const child of readdirSync(entryPath).sort()) {
        visit(join(entryPath, child), name ? `${name}/${child}` : child);
      }
      return;
    }
    if (stat.isFile()) {
      digest.update("file\0").update(readFileSync(entryPath));
      return;
    }
    if (stat.isSymbolicLink()) {
      digest.update("symlink\0").update(readlinkSync(entryPath));
      return;
    }
    throw new Error(`unsupported promotion surface entry: ${entryPath}`);
  };
  visit(path, "");
  return digest.digest("hex");
}

/** Exact payload hash paired with user-questions-source.ts (symlinks fail). */
function fingerprintUserQuestionsPath(path: string): string {
  const rootStat = lstatSync(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("User Questions source must be a real directory");
  }
  const digest = createHash("sha256");
  digest.update("directory\0").update(String(rootStat.mode & 0o777)).update("\0");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(directory, entry.name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) throw new Error(`User Questions source contains a symbolic link: ${entryPath}`);
      const name = relative(path, entryPath);
      digest.update(name).update("\0").update(String(entryStat.mode & 0o777)).update("\0");
      if (entryStat.isDirectory()) {
        digest.update("directory\0");
        visit(entryPath);
      } else if (entryStat.isFile()) {
        digest.update("file\0").update(readFileSync(entryPath));
      } else {
        throw new Error(`unsupported User Questions source entry: ${entryPath}`);
      }
    }
  };
  visit(path);
  return digest.digest("hex");
}

function requirePromotionModule(root: string, entrypoint: string): unknown {
  if (basename(entrypoint) !== entrypoint || !entrypoint.endsWith(".js")) {
    throw new Error("User Questions entrypoints must be direct JavaScript children");
  }
  const path = join(root, entrypoint);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) {
    throw new Error(`User Questions entrypoint is unsafe: ${entrypoint}`);
  }
  return require(path) as unknown;
}

function promotionSelfTest(run: () => boolean): PromotionProbeValue {
  try {
    return run() ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

function userQuestionsMcpConflictCount(): number {
  const stat = lstatSync(MCP_SYNC_STATE_FILE);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o600
    || stat.size > 256 * 1024
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) throw new Error("MCP reconciliation receipt is not owner-only");
  const receipt = readMcpSyncState(MCP_SYNC_STATE_FILE);
  if (!receipt || receipt.schemaVersion !== 2 || receipt.phase !== "complete") {
    throw new Error("MCP reconciliation receipt is incomplete");
  }
  const configBytes = existsSync(CODEX_CONFIG_FILE) ? readFileSync(CODEX_CONFIG_FILE) : Buffer.alloc(0);
  if (receipt.afterFingerprint !== createHash("sha256").update(configBytes).digest("hex")) {
    throw new Error("MCP reconciliation receipt does not bind the observed Codex config");
  }
  if (!userQuestionsMcpReceiptMatchesEnabledState(receipt, isTweakEnabled(USER_QUESTIONS_TWEAK_ID))) {
    throw new Error("MCP receipt does not prove the expected User Questions enabled state and policy");
  }
  return receipt.conflicts.length;
}

function promotionUserQuestionsHealth(rendererStorageSelfTest: HealthValue): UserQuestionsHealthObservation {
  assertPromotionProbeIsolation();
  const root = join(TWEAKS_DIR, USER_QUESTIONS_FOLDER);
  const manifestPath = join(root, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) {
    throw new Error("User Questions manifest is unsafe");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.id !== USER_QUESTIONS_TWEAK_ID) throw new Error("User Questions canonical identity is missing");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("User Questions version is invalid");
  }
  if (manifest.scope !== "main" && manifest.scope !== "both") throw new Error("User Questions main lifecycle is missing");
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!permissions.includes("ipc") || !permissions.includes("network")) {
    throw new Error("User Questions broker permissions are missing");
  }
  const mainEntrypoint = typeof manifest.main === "string" ? manifest.main : "index.js";
  const mcp = manifest.mcp && typeof manifest.mcp === "object" && !Array.isArray(manifest.mcp)
    ? manifest.mcp as Record<string, unknown>
    : null;
  const mcpArgs = mcp && Array.isArray(mcp.args) ? mcp.args : [];
  const mcpEntrypoint = mcpArgs.find((value): value is string => typeof value === "string" && value.endsWith(".js"));
  if (mcp?.command !== "node" || !mcpEntrypoint) throw new Error("User Questions MCP entrypoint is invalid");
  requirePromotionModule(root, mcpEntrypoint);

  const mainLifecycle = promotionSelfTest(() => {
    const lifecycle = requirePromotionModule(root, mainEntrypoint) as { start?: unknown; stop?: unknown };
    return typeof lifecycle.start === "function" && typeof lifecycle.stop === "function";
  });
  const brokerSelfTest = promotionSelfTest(() => {
    const broker = requirePromotionModule(root, "broker-protocol.js") as {
      requestFrame(id: string, method: string, payload: object): unknown;
      encodeFrame(frame: unknown): Buffer;
      decodeFrame(frame: Buffer): Record<string, unknown>;
    };
    const request = broker.requestFrame("promotion-health", "ping", { probe: true });
    const decoded = broker.decodeFrame(broker.encodeFrame(request));
    let rejectedMalformed = false;
    try { broker.decodeFrame(Buffer.from("{}\n")); } catch { rejectedMalformed = true; }
    return decoded.version === 1 && decoded.kind === "request" && decoded.id === "promotion-health"
      && decoded.method === "ping" && rejectedMalformed;
  });
  const schemaSelfTest = promotionSelfTest(() => {
    const schema = requirePromotionModule(root, "core.js") as {
      validateAskInput(value: unknown): { ok: boolean };
    };
    const valid = schema.validateAskInput({
      round_id: "promotion-health",
      questions: [{
        id: "choice",
        header: "Promotion health",
        question: "Does the native decision schema accept this round?",
        selection_mode: "single",
        options: [
          { id: "yes", label: "Yes (Recommended)", description: "Accept the canonical schema.", recommended: true },
          { id: "no", label: "No", description: "Reject the canonical schema." },
        ],
        allow_other: true,
      }],
    });
    const invalid = schema.validateAskInput({ round_id: "promotion-health", questions: [] });
    return valid.ok === true && invalid.ok === false;
  });
  return {
    id: USER_QUESTIONS_TWEAK_ID,
    version: manifest.version,
    payloadHash: fingerprintUserQuestionsPath(root),
    mainLifecycle,
    brokerSelfTest,
    schemaSelfTest,
    rendererStorageSelfTest,
    mcpConflictCount: userQuestionsMcpConflictCount(),
  };
}

async function runPromotionRendererProof(): Promise<PromotionRendererProofResult> {
  assertPromotionProbeIsolation();
  const nonce = randomUUID();
  const url = promotionRendererDocumentUrl(nonce);
  const tracker = createPromotionRendererProofTracker({ nonce, url, preloadPath: PRELOAD_PATH });
  const healthProtocol = session.defaultSession.protocol;
  let protocolHandlerInstalled = false;
  let proofWindow: Electron.BrowserWindow | null = null;
  let authorizationConsumed = false;
  let handshakeConsumed = false;
  let settleHandshake: (() => void) | null = null;
  let handshakeSettled = false;
  const handshake = new Promise<void>((resolvePromise) => {
    settleHandshake = () => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      resolvePromise();
    };
  });
  const onHandshake = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const windowAlive = proofWindow !== null && !proofWindow.isDestroyed() && !proofWindow.webContents.isDestroyed();
    const senderMatches = windowAlive && event.sender.id === proofWindow!.webContents.id;
    const frameMatches = senderMatches
      && event.senderFrame !== null
      && event.senderFrame === proofWindow!.webContents.mainFrame;
    const decision = validatePromotionRendererHandshake({
      windowAlive,
      senderMatches,
      frameMatches,
      senderUrl: event.senderFrame?.url ?? "",
      expectedUrl: url,
      authorizationConsumed,
      handshakeConsumed,
    }, payload, nonce);
    if (!decision.accepted) {
      log("warn", "promotion renderer lifecycle handshake rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    handshakeConsumed = true;
    tracker.rendererHandshake({
      webContentsId: event.sender.id,
      ...decision.observation,
    });
    log("info", "promotion renderer lifecycle handshake accepted", {
      webContentsId: event.sender.id,
      lifecycle: decision.observation.lifecycle,
      rendererStorageSelfTest: decision.observation.rendererStorageSelfTest,
    });
    settleHandshake?.();
  };
  const onAuthorization = (event: Electron.IpcMainEvent, payload: unknown): void => {
    let decision: ReturnType<typeof authorizePromotionRenderer>;
    let serializedResponse: string | null = null;
    try {
      const windowAlive = proofWindow !== null && !proofWindow.isDestroyed() && !proofWindow.webContents.isDestroyed();
      const senderMatches = windowAlive && event.sender.id === proofWindow!.webContents.id;
      const frameMatches = senderMatches
        && event.senderFrame !== null
        && event.senderFrame === proofWindow!.webContents.mainFrame;
      decision = authorizePromotionRenderer({
        windowAlive,
        senderMatches,
        frameMatches,
        senderUrl: event.senderFrame?.url ?? "",
        expectedUrl: url,
        consumed: authorizationConsumed,
      }, payload, nonce);
      if (decision.accepted) serializedResponse = JSON.stringify(decision.response);
    } catch {
      event.returnValue = null;
      log("warn", "promotion renderer authorization rejected", {
        webContentsId: event.sender.id,
        reason: "authorization exception",
      });
      return;
    }
    if (!decision.accepted) {
      event.returnValue = null;
      log("warn", "promotion renderer authorization rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    authorizationConsumed = true;
    event.returnValue = serializedResponse!;
    log("info", "promotion renderer authorization accepted", {
      webContentsId: event.sender.id,
    });
  };
  ipcMain.on(PROMOTION_RENDERER_AUTH_CHANNEL, onAuthorization);
  ipcMain.on(PROMOTION_RENDERER_IPC_CHANNEL, onHandshake);
  try {
    if (healthProtocol.isProtocolHandled(PROMOTION_RENDERER_SCHEME)) {
      throw new Error("health-only app protocol already has a handler");
    }
    healthProtocol.handle(
      PROMOTION_RENDERER_SCHEME,
      createPromotionRendererProtocolResponder(join(process.resourcesPath, "app.asar", "webview")),
    );
    protocolHandlerInstalled = true;
    log("info", "promotion renderer protocol handler installed", {
      scheme: PROMOTION_RENDERER_SCHEME,
      sessionIsDefault: true,
    });
    proofWindow = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    const proofWebContents = proofWindow.webContents;
    const preferences = (proofWebContents as unknown as {
      getLastWebPreferences?: () => { preload?: string };
    }).getLastWebPreferences?.();
    tracker.windowCreated({
      webContentsId: proofWebContents.id,
      url,
      preloadPath: preferences?.preload ?? null,
    });
    log("info", "promotion renderer load started", {
      webContentsId: proofWebContents.id,
      url,
      preloadRegistered: preferences?.preload === PRELOAD_PATH,
    });
    proofWebContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      tracker.didFailLoad({
        webContentsId: proofWebContents.id,
        errorCode,
        errorDescription,
        url: validatedURL,
      });
      log("warn", "promotion renderer did-fail-load", {
        webContentsId: proofWebContents.id,
        errorCode,
        errorDescription,
        url: validatedURL,
      });
      settleHandshake?.();
    });
    proofWebContents.on("render-process-gone", (_event, details) => {
      tracker.renderProcessGone({
        webContentsId: proofWebContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      log("warn", "promotion renderer process exited", {
        webContentsId: proofWebContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      settleHandshake?.();
    });
    const load = proofWindow.loadURL(url).then(() => {
      tracker.didFinishLoad({ webContentsId: proofWebContents.id, url: proofWebContents.getURL() });
      log("info", "promotion renderer load completed", {
        webContentsId: proofWebContents.id,
        url: proofWebContents.getURL(),
      });
    }).catch((error) => {
      const rejection = promotionRendererLoadRejection(error, url);
      tracker.didFailLoad({
        webContentsId: proofWebContents.id,
        ...rejection,
      });
      log("warn", "promotion renderer loadURL rejected", {
        webContentsId: proofWebContents.id,
        ...rejection,
      });
      settleHandshake?.();
    });
    await withTimeout(Promise.all([load, handshake]).then(() => undefined), 5_000).catch(() => undefined);
    const result = tracker.result();
    if (result.hostReady === "pass" && result.rendererStorageSelfTest === "pass") {
      log("info", "promotion renderer mount/handshake succeeded", {
        webContentsId: proofWebContents.id,
        hostReady: result.hostReady,
        rendererStorageSelfTest: result.rendererStorageSelfTest,
      });
    } else {
      log("warn", "promotion renderer mount/handshake incomplete", {
        webContentsId: proofWebContents.id,
        hostReady: result.hostReady,
        rendererStorageSelfTest: result.rendererStorageSelfTest,
      });
    }
    return result;
  } catch (error) {
    log("warn", "promotion renderer proof could not create its hidden window", {
      error: error instanceof Error ? error.message : String(error),
    });
    return tracker.result();
  } finally {
    ipcMain.removeListener(PROMOTION_RENDERER_AUTH_CHANNEL, onAuthorization);
    ipcMain.removeListener(PROMOTION_RENDERER_IPC_CHANNEL, onHandshake);
    if (proofWindow && !proofWindow.isDestroyed()) proofWindow.destroy();
    if (protocolHandlerInstalled) {
      try {
        healthProtocol.unhandle(PROMOTION_RENDERER_SCHEME);
        log("info", "promotion renderer protocol handler removed", { scheme: PROMOTION_RENDERER_SCHEME });
      } catch (error) {
        log("warn", "promotion renderer protocol handler cleanup failed", {
          scheme: PROMOTION_RENDERER_SCHEME,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

interface PromotionOriginalMainProbe {
  registerSession(targetSession: Electron.Session, label: string): void;
  run(): Promise<PromotionRendererProofResult>;
}

function createPromotionOriginalMainProbe(): PromotionOriginalMainProbe {
  const nonce = randomUUID();
  const tracker = createPromotionOriginalRendererProofTracker(nonce);
  const capturedWindows = new Set<Electron.BrowserWindow>();
  const registeredSessions = new Set<Electron.Session>();
  const preloadErrorWebContentsIds = new Set<number>();
  const windowCleanup = new Map<Electron.BrowserWindow, Array<() => void>>();
  let canonicalWindow: Electron.BrowserWindow | null = null;
  let canonicalBackgroundThrottlingPrevious: boolean | null = null;
  let authorizationConsumed = false;
  let loadObservedConsumed = false;
  let handshakeConsumed = false;
  let cleaningUp = false;
  let cleanupFinished = false;
  let lateWindowDuringCleanup = false;
  let settled = false;
  let deadlineController: ReturnType<typeof createPromotionOriginalRendererDeadlineController> | null = null;
  let settleProof: (() => void) | null = null;
  const proofSettled = new Promise<void>((resolvePromise) => {
    settleProof = resolvePromise;
  });
  const originalOpacitySetters = new WeakMap<
    Electron.BrowserWindow,
    (opacity: number) => void
  >();

  const settleIfComplete = (): void => {
    if (settled || !tracker.complete()) return;
    settled = true;
    deadlineController?.settle();
    settleProof?.();
  };
  const fail = (reason: string, webContentsId?: number): void => {
    tracker.fail(reason, webContentsId);
    log("warn", "promotion original renderer proof failed", {
      reason,
      webContentsId: webContentsId ?? null,
    });
    settleIfComplete();
  };
  const requireBackgroundThrottlingDisabled = (
    contents: Electron.WebContents,
    phase: string,
    configure = false,
  ): boolean => {
    const configured = configure
      ? disablePromotionOriginalRendererBackgroundThrottling(contents)
      : null;
    if (configured) canonicalBackgroundThrottlingPrevious = configured.previous;
    const checked = configured ?? verifyPromotionOriginalRendererBackgroundThrottlingDisabled(contents);
    log(checked.ok ? "info" : "warn", "promotion original renderer background throttling checked", {
      webContentsId: contents.id,
      previous: canonicalBackgroundThrottlingPrevious,
      observed: checked.observed,
      phase,
    });
    if (!checked.ok) {
      fail(configure
        ? "canonical renderer background throttling could not be disabled"
        : "canonical renderer background throttling was not disabled", contents.id);
    }
    return checked.ok;
  };
  deadlineController = createPromotionOriginalRendererDeadlineController({
    onTimeout: (phase) => {
      fail(phase === "startup"
        ? "promotion original renderer startup timed out"
        : phase === "load"
          ? "promotion original renderer load timed out"
          : "promotion original renderer mount timed out");
    },
  });
  const forceWindowTransparent = (window: Electron.BrowserWindow): boolean => {
    if (window.isDestroyed()) return false;
    try {
      const setOpacity = originalOpacitySetters.get(window)
        ?? ((opacity: number) => window.setOpacity(opacity));
      setOpacity(0);
      return window.getOpacity() === 0;
    } catch {
      return false;
    }
  };
  const hideWindow = (window: Electron.BrowserWindow): void => {
    if (window.isDestroyed()) return;
    forceWindowTransparent(window);
    try { window.setFocusable(false); } catch { /* Best effort; visibility is checked below. */ }
    try { window.hide(); } catch { /* Best effort; visibility is checked below. */ }
    try { window.blur(); } catch { /* Best effort; visibility is checked below. */ }
  };
  const suppressWindowOpacity = (
    window: Electron.BrowserWindow,
    removers: Array<() => void>,
  ): void => {
    const mutableWindow = window as unknown as {
      setOpacity: (opacity: number) => void;
    };
    const original = mutableWindow.setOpacity;
    if (typeof original !== "function") {
      fail("captured window opacity interception unavailable");
      return;
    }
    const setOriginalOpacity = (opacity: number): void => {
      original.call(window, opacity);
    };
    originalOpacitySetters.set(window, setOriginalOpacity);
    const suppressed = (_opacity: number): void => {
      setOriginalOpacity(0);
      log("info", "promotion original BrowserWindow opacity suppressed", {
        webContentsId: window.webContents.id,
      });
    };
    try {
      setOriginalOpacity(0);
      mutableWindow.setOpacity = suppressed;
    } catch {
      originalOpacitySetters.delete(window);
      fail("captured window opacity interception failed");
      return;
    }
    if (mutableWindow.setOpacity !== suppressed || !forceWindowTransparent(window)) {
      fail("captured window opacity interception did not stick");
      return;
    }
    removers.push(() => {
      if (mutableWindow.setOpacity === suppressed) mutableWindow.setOpacity = original;
      originalOpacitySetters.delete(window);
    });
  };
  type SuppressedWindowActivationMethod = "show" | "showInactive" | "focus" | "restore";
  const suppressWindowActivationMethod = (
    window: Electron.BrowserWindow,
    method: SuppressedWindowActivationMethod,
    removers: Array<() => void>,
  ): void => {
    const mutableWindow = window as unknown as Record<
      SuppressedWindowActivationMethod,
      (...args: unknown[]) => void
    >;
    const original = mutableWindow[method];
    if (typeof original !== "function") {
      fail(`captured window ${method} interception unavailable`);
      return;
    }
    const suppressed = (..._args: unknown[]): void => {
      log("info", "promotion original BrowserWindow activation suppressed", {
        webContentsId: window.webContents.id,
        method,
      });
      hideWindow(window);
    };
    try {
      mutableWindow[method] = suppressed;
    } catch {
      fail(`captured window ${method} interception failed`);
      return;
    }
    if (mutableWindow[method] !== suppressed) {
      fail(`captured window ${method} interception did not stick`);
      return;
    }
    removers.push(() => {
      // Do not overwrite an original-main replacement installed after ours.
      if (mutableWindow[method] === suppressed) mutableWindow[method] = original;
    });
  };
  const originalPreloadIsValid = (preloadPath: unknown): preloadPath is string => {
    if (typeof preloadPath !== "string" || !isAbsolute(preloadPath)) return false;
    const exactPath = resolve(preloadPath);
    if (preloadPath !== exactPath || exactPath === resolve(PROMOTION_HEALTH_PRELOAD_PATH)) return false;
    const originalAsarRoot = resolve(process.resourcesPath, "app.asar");
    const containedPath = relative(originalAsarRoot, exactPath);
    if (!containedPath || containedPath.startsWith("..") || isAbsolute(containedPath)) return false;
    try {
      return existsSync(exactPath) && lstatSync(exactPath).isFile();
    } catch {
      return false;
    }
  };
  const considerEligible = (
    window: Electron.BrowserWindow,
    url: string,
    isMainFrame: boolean,
  ): void => {
    const canonicalUrl = canonicalPromotionOriginalRendererUrl(url);
    if (!isMainFrame || canonicalUrl === null || window.isDestroyed()) return;
    const contents = window.webContents;
    const preferences = (contents as unknown as {
      getLastWebPreferences?: () => {
        sandbox?: boolean;
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        preload?: string;
      };
    }).getLastWebPreferences?.() ?? {};
    const originalPreloadValid = originalPreloadIsValid(preferences.preload);
    tracker.eligibleWindow({
      webContentsId: contents.id,
      url: canonicalUrl,
      isDefaultSession: contents.session === session.defaultSession,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation === true,
      nodeIntegration: preferences.nodeIntegration === true,
      originalPreloadValid,
    });
    const selectedId = tracker.summary().canonicalWebContentsId;
    if (selectedId === contents.id && canonicalWindow === null) {
      canonicalWindow = window;
      if (requireBackgroundThrottlingDisabled(contents, "selection", true)) {
        deadlineController.canonicalSelected();
      }
    }
    if (preloadErrorWebContentsIds.has(contents.id)) {
      tracker.preloadError(contents.id);
    }
    log("info", "promotion original renderer eligible window observed", {
      webContentsId: contents.id,
      url: promotionOriginalRendererLogUrl(canonicalUrl),
      sessionIsDefault: contents.session === session.defaultSession,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      originalPreloadPath: preferences.preload ?? null,
      originalPreloadValid,
      selected: selectedId === contents.id,
    });
    settleIfComplete();
  };
  const onBrowserWindowCreated = (_event: Electron.Event, window: Electron.BrowserWindow): void => {
    tracker.windowCaptured();
    capturedWindows.add(window);
    const contents = window.webContents;
    const initiallyVisible = window.isVisible();
    const removers: Array<() => void> = [];
    const listen = (
      emitter: NodeJS.EventEmitter,
      event: string,
      listener: (...args: any[]) => void,
    ): void => {
      emitter.on(event, listener);
      removers.push(() => emitter.removeListener(event, listener));
    };
    suppressWindowOpacity(window, removers);
    for (const method of ["show", "showInactive", "focus", "restore"] as const) {
      suppressWindowActivationMethod(window, method, removers);
    }
    if (cleaningUp) {
      lateWindowDuringCleanup = true;
      fail("BrowserWindow was created during promotion cleanup");
      hideWindow(window);
      try { window.destroy(); } catch { /* Cleanup fails below. */ }
      if (!window.isDestroyed()) fail("late promotion cleanup window could not be destroyed");
      windowCleanup.set(window, removers);
      if (cleanupFinished) app.exit(1);
      return;
    }
    listen(window, "show", () => {
      hideWindow(window);
      if (!cleaningUp) fail(`captured window ${contents.id} emitted show`);
    });
    listen(window, "ready-to-show", () => hideWindow(window));
    listen(window, "focus", () => {
      hideWindow(window);
      if (!cleaningUp) fail(`captured window ${contents.id} emitted focus`);
    });
    listen(window, "closed", () => {
      log("info", "promotion original BrowserWindow destroyed", {
        webContentsId: contents.id,
        cleanup: cleaningUp,
      });
      if (!cleaningUp && canonicalWindow === window) fail("canonical window was destroyed", contents.id);
    });
    listen(contents, "did-start-navigation", (
      _navigationEvent: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      log("info", "promotion original renderer navigation started", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(url),
        isMainFrame,
      });
      considerEligible(window, url, isMainFrame);
    });
    listen(contents, "did-navigate", (_navigationEvent: Electron.Event, url: string) => {
      log("info", "promotion original renderer navigation completed", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(url),
      });
      considerEligible(window, url, true);
    });
    listen(contents, "did-finish-load", () => {
      const url = contents.getURL();
      considerEligible(window, url, true);
      if (
        canonicalWindow === window
        && canonicalPromotionOriginalRendererUrl(url) !== null
        && !requireBackgroundThrottlingDisabled(contents, "did-finish-load")
      ) return;
      tracker.didFinishLoad(contents.id, url);
      if (canonicalWindow === window && canonicalPromotionOriginalRendererUrl(url) !== null) {
        deadlineController?.canonicalLoaded();
      }
      log("info", "promotion original renderer load completed", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(url),
      });
      settleIfComplete();
    });
    listen(contents, "dom-ready", () => {
      log("info", "promotion original renderer DOM ready", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(contents.getURL()),
        selected: canonicalWindow === window,
      });
    });
    listen(contents, "did-stop-loading", () => {
      log("info", "promotion original renderer stopped loading", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(contents.getURL()),
        selected: canonicalWindow === window,
      });
    });
    listen(contents, "preload-error", (
      _preloadEvent: Electron.Event,
      preloadPath: string,
      error: Error,
    ) => {
      preloadErrorWebContentsIds.add(contents.id);
      tracker.preloadError(contents.id);
      log("warn", "promotion original renderer preload failed", {
        webContentsId: contents.id,
        preloadPath,
        error: error instanceof Error ? error.message : String(error),
      });
      settleIfComplete();
    });
    listen(contents, "did-fail-load", (
      _loadEvent: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) considerEligible(window, validatedURL, true);
      log("warn", "promotion original renderer did-fail-load", {
        webContentsId: contents.id,
        errorCode,
        errorDescription,
        url: promotionOriginalRendererLogUrl(validatedURL),
        isMainFrame,
      });
      if (isMainFrame && canonicalWindow === window) fail("canonical renderer load failed", contents.id);
    });
    listen(contents, "did-fail-provisional-load", (
      _loadEvent: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      log("warn", "promotion original renderer did-fail-provisional-load", {
        webContentsId: contents.id,
        errorCode,
        errorDescription,
        url: promotionOriginalRendererLogUrl(validatedURL),
        isMainFrame,
        selected: canonicalWindow === window,
      });
      if (canonicalWindow === window && shouldFailPromotionOriginalRendererProvisionalLoad({
        isMainFrame,
        webContentsId: contents.id,
        canonicalWebContentsId: tracker.summary().canonicalWebContentsId,
      })) {
        fail("canonical renderer provisional load failed", contents.id);
      }
    });
    listen(contents, "render-process-gone", (_goneEvent: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      log("warn", "promotion original renderer process exited", {
        webContentsId: contents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      if (canonicalWindow === window) fail("canonical renderer process exited", contents.id);
    });
    windowCleanup.set(window, removers);
    if (initiallyVisible) fail(`captured window ${contents.id} was initially visible`);
    hideWindow(window);
    if (window.isVisible()) fail("captured window could not be hidden");
    log("info", "promotion original BrowserWindow captured and hidden", {
      webContentsId: contents.id,
      capturedWindowCount: tracker.summary().capturedWindowCount,
      initiallyVisible,
    });
  };
  const onAuthorization = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) considerEligible(owner, event.senderFrame?.url ?? "", event.senderFrame === event.sender.mainFrame);
    const windowAlive = canonicalWindow !== null
      && !canonicalWindow.isDestroyed()
      && !canonicalWindow.webContents.isDestroyed();
    const senderMatches = windowAlive && event.sender.id === canonicalWindow!.webContents.id;
    const frameMatches = senderMatches
      && event.senderFrame !== null
      && event.senderFrame === canonicalWindow!.webContents.mainFrame;
    const decision = authorizePromotionOriginalRenderer({
      windowAlive,
      windowHidden: windowAlive && !canonicalWindow!.isVisible(),
      senderMatches,
      frameMatches,
      senderUrl: event.senderFrame?.url ?? "",
      consumed: authorizationConsumed,
    }, payload, nonce);
    if (!decision.accepted) {
      event.returnValue = null;
      log("warn", "promotion original renderer authorization rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    if (process.platform === "darwin") {
      let rendererProcessId: number | null = null;
      let sandboxProcessVerified = false;
      try {
        rendererProcessId = event.sender.getOSProcessId();
        sandboxProcessVerified = hasUniqueSandboxedPromotionRendererProcess(
          app.getAppMetrics(),
          rendererProcessId,
        );
      } catch {
        sandboxProcessVerified = false;
      }
      if (!sandboxProcessVerified) {
        event.returnValue = null;
        log("warn", "promotion original renderer authorization rejected", {
          webContentsId: event.sender.id,
          reason: "sandbox process metric was not uniquely verified",
          rendererProcessId,
        });
        fail("canonical renderer sandbox process proof failed", event.sender.id);
        return;
      }
    }
    authorizationConsumed = true;
    tracker.authorization(event.sender.id);
    event.returnValue = JSON.stringify(decision.response);
    log("info", "promotion original renderer authorization accepted", {
      webContentsId: event.sender.id,
    });
    settleIfComplete();
  };
  const onHandshake = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const windowAlive = canonicalWindow !== null
      && !canonicalWindow.isDestroyed()
      && !canonicalWindow.webContents.isDestroyed();
    const senderMatches = windowAlive && event.sender.id === canonicalWindow!.webContents.id;
    const frameMatches = senderMatches
      && event.senderFrame !== null
      && event.senderFrame === canonicalWindow!.webContents.mainFrame;
    if (windowAlive && canonicalWindow!.isVisible()) {
      hideWindow(canonicalWindow!);
      if (canonicalWindow!.isVisible()) {
        fail("canonical renderer became visible and could not be re-hidden", event.sender.id);
        return;
      }
      log("info", "promotion original BrowserWindow delayed activation re-hidden", {
        webContentsId: event.sender.id,
      });
    }
    if (windowAlive && !forceWindowTransparent(canonicalWindow!)) {
      fail("canonical renderer transparency guard failed", event.sender.id);
      return;
    }
    const lifecycle = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).lifecycle
      : null;
    if (lifecycle === "renderer-load-observed") {
      const loadDecision = validatePromotionOriginalRendererLoadObserved({
        windowAlive,
        senderMatches,
        frameMatches,
        senderUrl: event.senderFrame?.url ?? "",
        expectedUrl: tracker.summary().canonicalUrl ?? "",
        authorizationConsumed,
        loadObservedConsumed,
        handshakeConsumed,
      }, payload, nonce);
      if (!loadDecision.accepted) {
        log("warn", "promotion original renderer load observation rejected", {
          webContentsId: event.sender.id,
          reason: loadDecision.reason,
        });
        return;
      }
      if (!requireBackgroundThrottlingDisabled(event.sender, "renderer-load-observed")) return;
      loadObservedConsumed = true;
      log("info", "promotion original renderer load observation accepted", {
        webContentsId: event.sender.id,
        url: promotionOriginalRendererLogUrl(loadDecision.observation.url),
        rendererSandboxed: loadDecision.observation.rendererSandboxed,
      });
      return;
    }
    if (lifecycle === "renderer-mount-timeout") {
      const timeoutDecision = validatePromotionOriginalRendererMountTimeout({
        windowAlive,
        senderMatches,
        frameMatches,
        senderUrl: event.senderFrame?.url ?? "",
        expectedUrl: tracker.summary().canonicalUrl ?? "",
        authorizationConsumed,
        loadObservedConsumed,
        handshakeConsumed,
      }, payload, nonce);
      if (!timeoutDecision.accepted) {
        log("warn", "promotion original renderer mount-timeout rejected", {
          webContentsId: event.sender.id,
          reason: timeoutDecision.reason,
        });
        return;
      }
      if (!requireBackgroundThrottlingDisabled(event.sender, "renderer-mount-timeout")) return;
      handshakeConsumed = true;
      log("warn", "promotion original renderer mount timed out", {
        webContentsId: event.sender.id,
        url: promotionOriginalRendererLogUrl(timeoutDecision.observation.url),
        rendererSandboxed: timeoutDecision.observation.rendererSandboxed,
      });
      fail("canonical renderer mount timed out", event.sender.id);
      return;
    }
    const decision = validatePromotionOriginalRendererHandshake({
      windowAlive,
      senderMatches,
      frameMatches,
      senderUrl: event.senderFrame?.url ?? "",
      expectedUrl: tracker.summary().canonicalUrl ?? "",
      authorizationConsumed,
      loadObservedConsumed,
      handshakeConsumed,
    }, payload, nonce);
    if (!decision.accepted) {
      log("warn", "promotion original renderer lifecycle handshake rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    if (!requireBackgroundThrottlingDisabled(event.sender, "renderer-mounted")) return;
    handshakeConsumed = true;
    tracker.rendererHandshake({ webContentsId: event.sender.id, ...decision.observation });
    log("info", "promotion original renderer mount handshake accepted", {
      webContentsId: event.sender.id,
      rendererSandboxed: decision.observation.rendererSandboxed,
      rendererStorageSelfTest: decision.observation.rendererStorageSelfTest,
    });
    settleIfComplete();
  };
  const registerSession = (targetSession: Electron.Session, label: string): void => {
    if (registeredSessions.has(targetSession)) return;
    try {
      targetSession.registerPreloadScript({
        type: "frame",
        id: "tweaker-promotion-health-original",
        filePath: PROMOTION_HEALTH_PRELOAD_PATH,
      });
      registeredSessions.add(targetSession);
      log("info", "promotion original preload registered", {
        label,
        path: PROMOTION_HEALTH_PRELOAD_PATH,
      });
    } catch (error) {
      fail(`promotion original preload registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const onSessionCreated = (createdSession: Electron.Session): void => {
    registerSession(createdSession, "session-created");
  };
  const onAppReady = (): void => {
    registerSession(session.defaultSession, "defaultSession-ready");
  };
  ipcMain.on(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL, onAuthorization);
  ipcMain.on(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, onHandshake);
  app.on("session-created", onSessionCreated);
  app.on("browser-window-created", onBrowserWindowCreated);
  // This listener is installed while the injected runtime is still being
  // evaluated, before the loader requires Codex's original main entry. Event
  // ordering therefore registers the default-session preload before any later
  // original-main ready listener can construct a BrowserWindow.
  app.once("ready", onAppReady);

  const cleanup = async (): Promise<boolean> => {
    cleaningUp = true;
    deadlineController.settle();
    ipcMain.removeListener(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL, onAuthorization);
    ipcMain.removeListener(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, onHandshake);
    app.removeListener("session-created", onSessionCreated);
    app.removeListener("ready", onAppReady);
    let success = true;
    // Destroy while activation methods are still suppressed. Restoring them
    // first would leave a small teardown window in which original-main code
    // could reveal or focus a probe window.
    for (const window of capturedWindows) {
      try {
        if (!window.isDestroyed()) window.destroy();
        if (!window.isDestroyed()) success = false;
      } catch {
        success = false;
      }
    }
    for (const removers of windowCleanup.values()) {
      for (const remove of removers) remove();
    }
    windowCleanup.clear();
    for (const registeredSession of registeredSessions) {
      try {
        registeredSession.unregisterPreloadScript("tweaker-promotion-health-original");
      } catch {
        success = false;
      }
    }
    const appServerCleanup = await codexAppServerParent.cleanupTrackedParents();
    if (appServerCleanup.failed > 0 || lateWindowDuringCleanup) success = false;
    log(success ? "info" : "warn", "promotion original renderer cleanup completed", {
      destroyedWindowCount: capturedWindows.size,
      registeredSessionCount: registeredSessions.size,
      lateWindowDuringCleanup,
      appServerCleanup,
      success,
    });
    tracker.cleanup(success);
    cleanupFinished = true;
    return success;
  };

  return {
    registerSession,
    async run() {
      await proofSettled;
      await cleanup();
      const result = tracker.result();
      log(result.hostReady === "pass" ? "info" : "warn", "promotion original renderer proof completed", {
        hostReady: result.hostReady,
        rendererStorageSelfTest: result.rendererStorageSelfTest,
        proofSummary: result.proofSummary ? {
          ...result.proofSummary,
          ...promotionOriginalRendererEvidenceUrl(result.proofSummary.canonicalUrl),
        } : undefined,
      });
      return result;
    },
  };
}

// Construct this controller during runtime evaluation, before the loader
// requires Codex's original main entry. It registers every capture/listener
// needed to observe the original protocol and original BrowserWindow.
const originalMainPromotionProbe = healthOriginalMain
  ? createPromotionOriginalMainProbe()
  : null;

const desktopUpdateStartupReconciler = createDesktopUpdateStartupReconciler({
  windowReady: () => BrowserWindow.getAllWindows().some((window) => (
    !window.isDestroyed() && window.isVisible()
  )),
  launch: () => {
    const cli = desktopUpdateCli();
    startInstalledCli(cli, ["update-chatgpt-reconcile", "--json"]);
  },
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  onEvent: (event) => {
    log(event.result === "submitted" ? "info" : "warn", event.event, event);
  },
});

app.whenReady().then(() => {
  log("info", "app ready fired");
  // A disposable health probe launches Codex's main process only far enough to
  // reach app.whenReady — the real Codex bootstrap never runs, so services the
  // normal session cookie read depends on may never settle and could hang. Bound
  // the whole receipt path and force-exit so the installer's probe can never
  // hang on us; a missing receipt fails safe (promotion is blocked, app intact).
  if (healthCheckOnly) {
    const watchdog = setTimeout(() => {
      log("warn", "health-check watchdog fired; exiting");
      app.exit(0);
    }, 8_000);
    watchdog.unref?.();
  } else {
    // Raw Sparkle scheduling stays disabled in the locally signed app. This
    // bounded metadata-only loop restores proactive update notification safely.
    scheduleProactiveDesktopUpdateChecks();
  }
  void answerPromotionHealthRequest(userRoot!, {
    authenticatedSession: async () => {
      // Check the Codex account token FIRST: it is a fast, synchronous file read
      // and is the real sign-in signal for the desktop app. The web session
      // cookie read below can stall in a bare health-probe launch, so only reach
      // for it (with a timeout) when no durable token is present.
      if (hasAuthenticatedCodexToken(readCodexAuth())) return "pass";
      try {
        const cookies = await withTimeout(session.defaultSession.cookies.get({}), 3_000);
        if (cookies && hasAuthenticatedSessionCookie(cookies)) return "pass";
      } catch {
        // No usable session signal; report unknown (fails safe).
      }
      return "unknown";
    },
    declaredPermission: (permission) => {
      if (process.platform !== "darwin") return "unknown";
      if (permission === "accessibility") return systemPreferences.isTrustedAccessibilityClient(false) ? "pass" : "fail";
      if (permission === "screen-recording") return systemPreferences.getMediaAccessStatus("screen") === "granted" ? "pass" : "fail";
      if (permission === "screen-capture") return systemPreferences.getMediaAccessStatus("screen") === "granted" ? "pass" : "fail";
      if (permission === "global-shortcut") return "pass";
      return "unknown";
    },
  }).then((answered) => {
    if (!answered) {
      // No pending request file is the normal case on an ordinary launch;
      // only a request that exists but fails validation deserves a warn.
      const requestPending = existsSync(join(userRoot!, "health", "request.json"));
      log(requestPending ? "warn" : "info", "promotion health request was absent or invalid");
    }
    if (healthCheckOnly) app.exit(0);
  }).catch((error) => {
    log("warn", "promotion health receipt failed", error);
    if (healthCheckOnly) app.exit(0);
  });
  if (!healthCheckOnly) {
    if (isTweakerSafeModeEnabled()) {
      log("warn", "safe mode is enabled; preload will not be registered");
    } else {
      registerPreload(session.defaultSession, "defaultSession");
      maybeStartBrowserUiServer({
        getWindowServices: getCodexWindowServices,
        log,
      });
    }
  }
});

if (!healthCheckOnly) {
  app.on("session-created", (s) => {
    if (isTweakerSafeModeEnabled()) return;
    registerPreload(s, "session-created");
  });
}

// DIAGNOSTIC: log every webContents creation. Useful for verifying our
// preload reaches every renderer Codex spawns.
app.on("web-contents-created", (_e, wc) => {
  try {
    const wp = (wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> })
      .getLastWebPreferences?.();
    log("info", "web-contents-created", {
      id: wc.id,
      type: wc.getType(),
      sessionIsDefault: wc.session === session.defaultSession,
      sandbox: wp?.sandbox,
      contextIsolation: wp?.contextIsolation,
    });
    wc.on("preload-error", (_ev, p, err) => {
      log("error", `wc ${wc.id} preload-error path=${p}`, String(err?.stack ?? err));
    });
  } catch (e) {
    log("error", "web-contents-created handler failed:", String((e as Error)?.stack ?? e));
  }
});

log("info", "main.ts evaluated; app.isReady=" + app.isReady());
if (isTweakerSafeModeEnabled()) {
  log("warn", "safe mode is enabled; tweaks will not be loaded");
}

// 2. Initial tweak discovery + main-scope load.
// Defer tweak discovery/load off the synchronous module-eval path so the loader
// can proceed to OpenAI's main entrypoint immediately. setImmediate runs after
// the current require chain unwinds but BEFORE Electron's `ready` event, which
// preserves the pre-ready execution context these main-scope tweaks already run
// in today (so BrowserWindow/main hooks are installed before any window opens),
// while removing the synchronous startup stall. MCP reconciliation is invoked
// inside loadAllMainTweaks, so it defers with it.
if (!healthCheckOnly) {
  setImmediate(() => {
    void loadTweaksInitially(tweakLifecycleDeps).catch((error) => {
      log("error", "failed initial main tweak load:", error);
    });
  });
}

app.on("will-quit", () => {
  void mcpReconciler?.close();
  stopAllMainTweaks();
  nativeBridge.disposeAll();
  disposeAllOwlViews();
  // Best-effort flush of any pending storage writes.
  for (const t of tweakState.loadedMain.values()) {
    try {
      t.storage.flush();
    } catch {}
  }
  finishTweakLifecycleAttempt();
});

// 3. IPC: expose tweak metadata + reveal-in-finder.
ipcMain.handle("tweaker:list-tweaks", async () => {
  await Promise.all(tweakState.discovered.map((t) => ensureTweakUpdateCheck(t)));
  const updateChecks = readState().tweakUpdateChecks ?? {};
  const catalog = readBundledTweakCatalog();
  const discoveredById = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const ids = [
    ...(catalog?.entries.map((entry) => entry.id) ?? []),
    ...tweakState.discovered.map((t) => t.manifest.id),
  ].filter((id, index, all) => all.indexOf(id) === index);
  return ids.map((id) => {
    const local = discoveredById.get(id);
    const catalogEntry = catalog?.entries.find((entry) => entry.id === id) ?? null;
    const manifest = local?.manifest ?? catalogEntry?.manifest;
    if (!manifest) return null;
    const installed = !!local;
    const enabled = installed && isTweakEnabled(id);
    const health = installed ? tweakHealth(id) : null;
    return {
      manifest,
      entry: local?.entry ?? "",
      dir: local?.dir ?? "",
      entryExists: !!local && existsSync(local.entry),
      installed,
      enabled,
      status: deriveTweakStatus({ installed, enabled, health }),
      health,
      catalog: catalogEntry,
      update: local ? updateChecks[id] ?? null : null,
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
});
ipcMain.handle("tweaker:get-tweaks-health", () => buildTweakHealthSnapshot());
ipcMain.on("tweaker:tweak-lifecycle", (_event, payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const value = payload as { id?: unknown; process?: unknown; status?: unknown; error?: unknown };
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value.id)) return;
  if (value.process !== "renderer" || typeof value.status !== "string") return;
  const status = value.status as TweakLifecycleStatus;
  if (![
    "starting",
    "ready",
    "failed",
    "timed_out",
    "disabled",
    "quarantined",
  ].includes(status)) return;
  recordTweakLifecycle(value.id, "renderer", status, value.error);
});
ipcMain.handle("tweaker:get-tweak-lifecycle", () => lifecycleJournal);
ipcMain.handle(
  "tweaker:cross-tweak-read",
  (_e, requester: unknown, target: unknown, action: unknown, message: unknown) =>
    dispatchCrossTweakRead(
      requester,
      target,
      action,
      message,
      (tweakId, channel) => mainTweakReadHandlers.get(`${tweakId}:${channel}`),
    ),
);

ipcMain.handle("tweaker:get-tweak-enabled", (_e, id: string) => isTweakEnabled(id));
ipcMain.handle("tweaker:set-tweak-enabled", async (_e, id: string, enabled: boolean) => {
  return setTweakEnabledAndReload(id, enabled, tweakLifecycleDeps);
});
ipcMain.handle("tweaker:recover-tweak", (_e, id: string) => recoverTweak(id));
ipcMain.handle("tweaker:clear-tweak-health", (_e, id: string) => {
  clearTweakHealth(id);
  return true;
});

function bundledCodexBinary(): string {
  return join(process.resourcesPath, "codex");
}

function selectedCodexLane(): CodexCliLane {
  return readState().tweaker?.codexCliLane ?? codexCliBootstrap.effectiveLane;
}

function codexReleaseIsNewer(latest: string | null, installed: string | null): boolean {
  if (!latest || !installed) return false;
  const latestVersion = parseCodexVersionTag(`rust-v${latest}`);
  const installedVersion = parseCodexVersionTag(`rust-v${installed}`);
  return !!latestVersion && !!installedVersion && compareCodexVersions(latestVersion, installedVersion) > 0;
}

function installedCodexDesktopVersion(): { installedMarketingVersion: string | null; installedBuild: string | null } {
  const root = readInstallerState()?.appRoot ?? inferMacAppRoot();
  let plistMarketingVersion: string | null = null;
  let plistBuild: string | null = null;
  try {
    if (root) {
      const plist = readFileSync(join(root, "Contents", "Info.plist"), "utf8");
      plistMarketingVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
      plistBuild = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
    }
  } catch {}
  let appVersion: string | null = null;
  try { appVersion = app.getVersion(); } catch {}
  return probeCodexDesktopVersion({
    appVersion,
    infoPlistMarketingVersion: plistMarketingVersion,
    infoPlistBuild: plistBuild,
    stateMarketingVersion: readInstallerState()?.codexVersion ?? null,
  });
}

function selectedCodexDesktopUpdateTarget(): CodexDesktopUpdateTarget {
  let profile: CodexDesktopUpdateTarget["profile"] = "stable";
  try {
    const selection = JSON.parse(readFileSync(ENVIRONMENT_SELECTION_FILE, "utf8")) as { releaseProfile?: unknown };
    if (selection.releaseProfile === "alpha") profile = "alpha";
  } catch {}
  const registry = readJsonDocument(ENVIRONMENT_REGISTRY_FILE);
  const identity = verifiedCodexDesktopProfileIdentity(registry, profile);
  const capturedFeed = identity
    ? readCapturedCodexDesktopProfileFeed(readState().tweaker?.codexDesktopProfileFeeds?.[profile], identity)
    : null;
  return codexDesktopUpdateTargetForProfile({ profile, identity, capturedFeed });
}

async function refreshCodexDesktopUpdateMetadata(
  target: CodexDesktopUpdateTarget,
): Promise<CodexDesktopUpdateMetadata> {
  if (!target.available || target.profile !== "stable") {
    if (!target.available) {
      throw new Error(target.unavailableReason ?? "The selected desktop update profile is unavailable");
    }
    if (!target.identityKey || !target.feedUrl) {
      throw new Error("The verified Alpha appcast capture is unavailable");
    }
  }
  const installed = installedCodexDesktopVersion();
  const cacheKey = installed.installedMarketingVersion
    ? `${installed.installedMarketingVersion}:${installed.installedBuild ?? ""}`
    : null;
  const memoryKey = codexDesktopAppcastMemoryKey(target);
  const cached = readPersistedCodexAppcast(target.profile, target.identityKey ?? null, cacheKey);
  const refreshed = target.profile === "alpha"
    ? await getCodexSparkleBridge().fetchProfileAppcastMetadata({
        identityKey: target.identityKey!,
        feedUrl: target.feedUrl!,
        fallbackFeedUrl: target.fallbackFeedUrl,
      })
    : await getCodexSparkleBridge().fetchAppcastMetadata();
  let metadata = refreshed;
  if (!refreshed.error && !refreshed.stale) {
    codexAppcastMetadataByIdentity.set(memoryKey, refreshed);
    persistCodexAppcast(target.profile, target.identityKey ?? "official-stable-default", cacheKey, refreshed);
  } else if (cached || codexAppcastMetadataByIdentity.has(memoryKey)) {
    metadata = {
      ...(codexAppcastMetadataByIdentity.get(memoryKey) ?? cached)!,
      stale: true,
      error: refreshed.error ?? "OpenAI appcast metadata could not be refreshed.",
    };
    codexAppcastMetadataByIdentity.set(memoryKey, metadata);
  }
  return {
    installed: {
      marketingVersion: installed.installedMarketingVersion,
      build: installed.installedBuild,
    },
    latest: {
      marketingVersion: metadata.marketingVersion || null,
      build: metadata.build || null,
    },
    checkedAt: metadata.checkedAt || new Date().toISOString(),
    stale: metadata.stale,
    error: metadata.error,
    updateAvailable: isCodexDesktopUpdateNewer(
      installed.installedMarketingVersion,
      installed.installedBuild,
      metadata.marketingVersion || null,
      metadata.build || null,
    ),
  };
}

function codexDesktopAppcastMemoryKey(target: CodexDesktopUpdateTarget): string {
  return `${target.profile}:${target.identityKey ?? "unverified"}`;
}

function safeAppcastCacheUrl(value: string | null): string | null {
  return safePersistedAppcastUrl(value);
}

function readPersistedCodexAppcast(
  profile: "stable" | "alpha",
  identityKey: string | null,
  desktopVersion: string | null,
): SparkleAppcastMetadata | null {
  if (!desktopVersion || !identityKey) return null;
  const state = readState().tweaker;
  const profileCache = state?.codexAppcastProfileCaches?.[profile];
  const cache = profileCache
    && profileCache.profile === profile
    && profileCache.identityKey === identityKey
    ? profileCache
    : profile === "stable" ? state?.codexAppcastCache : null;
  if (
    cache?.schemaVersion !== 1 ||
    cache.desktopVersion !== desktopVersion ||
    typeof cache.marketingVersion !== "string" || !cache.marketingVersion.trim() ||
    typeof cache.build !== "string" || !cache.build.trim() ||
    typeof cache.checkedAt !== "string" || !Number.isFinite(Date.parse(cache.checkedAt))
  ) return null;
  const feedUrl = safeAppcastCacheUrl(cache.feedUrl);
  if (!feedUrl) return null;
  const releaseUrl = cache.releaseUrl === null ? null : safeAppcastCacheUrl(cache.releaseUrl);
  if (cache.releaseUrl !== null && !releaseUrl) return null;
  return {
    marketingVersion: cache.marketingVersion,
    build: cache.build,
    releaseUrl,
    feedUrl,
    checkedAt: cache.checkedAt,
    stale: Date.now() - Date.parse(cache.checkedAt) >= CODEX_APPCAST_CACHE_TTL_MS,
    error: null,
  };
}

function persistCodexAppcast(
  profile: "stable" | "alpha",
  identityKey: string,
  desktopVersion: string | null,
  metadata: SparkleAppcastMetadata,
): void {
  if (!desktopVersion || metadata.error || metadata.stale) return;
  const feedUrl = safeAppcastCacheUrl(metadata.feedUrl);
  const releaseUrl = metadata.releaseUrl === null ? null : safeAppcastCacheUrl(metadata.releaseUrl);
  if (!feedUrl || (metadata.releaseUrl !== null && !releaseUrl)) return;
  if (!metadata.marketingVersion.trim() || !metadata.build.trim() || !Number.isFinite(Date.parse(metadata.checkedAt))) return;
  const state = readState();
  state.tweaker ??= {};
  state.tweaker.codexAppcastProfileCaches ??= {};
  state.tweaker.codexAppcastProfileCaches[profile] = {
    schemaVersion: 1,
    profile,
    identityKey,
    desktopVersion,
    marketingVersion: metadata.marketingVersion,
    build: metadata.build,
    releaseUrl,
    feedUrl,
    checkedAt: metadata.checkedAt,
  };
  if (profile === "stable") {
    state.tweaker.codexAppcastCache = {
      schemaVersion: 1,
      desktopVersion,
      marketingVersion: metadata.marketingVersion,
      build: metadata.build,
      releaseUrl,
      feedUrl,
      checkedAt: metadata.checkedAt,
    };
  }
  writeState(state);
}

function persistCapturedCodexDesktopProfileFeed(
  capture: { feedUrl: string | null; fallbackFeedUrl: string | null },
): void {
  const registry = readJsonDocument(ENVIRONMENT_REGISTRY_FILE);
  const selection = readJsonDocument(ENVIRONMENT_SELECTION_FILE);
  const identity = activeVerifiedCodexDesktopProfileIdentity(registry, selection, inferMacAppRoot());
  if (!identity) {
    log("warn", "ignored Sparkle feed capture without a matching verified desktop profile");
    return;
  }
  const feed = createCapturedCodexDesktopProfileFeed(identity, capture, new Date().toISOString());
  if (!feed) {
    log("warn", "ignored invalid Sparkle feed capture", { profile: identity.profile });
    return;
  }
  const state = readState();
  state.tweaker ??= {};
  state.tweaker.codexDesktopProfileFeeds ??= {};
  state.tweaker.codexDesktopProfileFeeds[identity.profile] = feed;
  writeState(state);
}

function readJsonDocument(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function terminalCodexFromLoginShell(): string | null {
  const shellPath = process.env.SHELL;
  if (!shellPath || !isAbsolute(shellPath)) return null;
  try {
    if (!existsSync(shellPath) || !statSync(shellPath).isFile()) return null;
    const result = spawnSync(shellPath, ["-lic", "command -v codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0) return null;
    return terminalCodexPathFromShellOutput(result.stdout ?? "", (path) => {
      try {
        return existsSync(path) && statSync(path).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
}

async function getCodexVersionsSnapshot(force: boolean): Promise<CodexVersionsSnapshot> {
  const selectedLane = selectedCodexLane();
  const desktopTarget = selectedCodexDesktopUpdateTarget();
  const bundledPath = bundledCodexBinary();
  const betaPath = codexCliManager.getSelectedBinary();
  const activeCliPath = codexCliBootstrap.binary ?? bundledPath;
  const installedDesktop = installedCodexDesktopVersion();
  const desktopCacheKey = installedDesktop.installedMarketingVersion
    ? `${installedDesktop.installedMarketingVersion}:${installedDesktop.installedBuild ?? ""}`
    : null;
  const persistedAppcast = readPersistedCodexAppcast(
    desktopTarget.profile,
    desktopTarget.identityKey ?? null,
    desktopCacheKey,
  );
  const desktopAppcastMemoryKey = codexDesktopAppcastMemoryKey(desktopTarget);
  if (!codexAppcastMetadataByIdentity.has(desktopAppcastMemoryKey) && persistedAppcast) {
    codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, persistedAppcast);
  }
  const [bundledProbe, betaProbe, activeCliProbe, bundledRelease, betaRelease, refreshedAppcast] = await Promise.all([
    codexVersionService.probeCli(bundledPath),
    betaPath ? codexVersionService.probeCli(betaPath) : Promise.resolve(null),
    codexVersionService.probeCli(activeCliPath),
    force
      ? codexVersionService.fetchLatestRelease("bundled", { force: true })
      : codexVersionService.readCachedRelease("bundled"),
    force
      ? codexVersionService.fetchLatestRelease("beta", { force: true })
      : codexVersionService.readCachedRelease("beta"),
    force && desktopTarget.available
      ? desktopTarget.profile === "alpha"
        ? getCodexSparkleBridge().fetchProfileAppcastMetadata({
            identityKey: desktopTarget.identityKey!,
            feedUrl: desktopTarget.feedUrl!,
            fallbackFeedUrl: desktopTarget.fallbackFeedUrl,
          })
        : getCodexSparkleBridge().fetchAppcastMetadata()
      : Promise.resolve(null),
  ]);
  if (refreshedAppcast) {
    if (!refreshedAppcast.error && !refreshedAppcast.stale) {
      codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, refreshedAppcast);
      persistCodexAppcast(
        desktopTarget.profile,
        desktopTarget.identityKey ?? "official-stable-default",
        desktopCacheKey,
        refreshedAppcast,
      );
    } else if (codexAppcastMetadataByIdentity.has(desktopAppcastMemoryKey) || persistedAppcast) {
      codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, {
        ...(codexAppcastMetadataByIdentity.get(desktopAppcastMemoryKey) ?? persistedAppcast)!,
        stale: true,
        error: refreshedAppcast.error ?? "Appcast metadata is unavailable.",
      });
    } else {
      codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, refreshedAppcast);
    }
  }
  const codexAppcastMetadata = codexAppcastMetadataByIdentity.get(desktopAppcastMemoryKey) ?? null;
  const features = buildCodexFeatureUnion(
    bundledProbe.features,
    betaProbe?.features ?? null,
    selectedLane,
  );
  const managerState = codexCliManager.getState();
  const sparkle = getCodexSparkleBridge().getSnapshot();
  const desktopUpdate = isCodexDesktopUpdateNewer(
    installedDesktop.installedMarketingVersion,
    installedDesktop.installedBuild,
    codexAppcastMetadata?.marketingVersion ?? null,
    codexAppcastMetadata?.build ?? null,
  );
  const bundledUpdate = codexReleaseIsNewer(bundledRelease?.release?.version ?? null, bundledProbe.version);
  const betaUpdate = codexReleaseIsNewer(betaRelease?.release?.version ?? null, betaProbe?.version ?? null);
  const errors: CodexVersionsSnapshot["errors"] = {};
  if (bundledProbe.error || bundledRelease?.error) errors.bundled = bundledProbe.error ?? bundledRelease?.error ?? undefined;
  if (betaProbe?.error || betaRelease?.error) errors.beta = betaProbe?.error ?? betaRelease?.error ?? undefined;
  if (!desktopTarget.available) {
    errors.desktop = desktopTarget.unavailableReason ?? "The selected desktop update profile is unavailable.";
  } else if (sparkle.lastError || codexAppcastMetadata?.error) {
    errors.desktop = sparkle.lastError ?? codexAppcastMetadata?.error ?? undefined;
  }
  const activeCliSource = codexCliBootstrap.userOverridePreserved
    ? "override"
    : codexCliBootstrap.effectiveLane === "beta"
      ? "managed-alpha"
      : "bundled";
  const lookupCheckedAt = [
    bundledRelease?.checkedAt,
    betaRelease?.checkedAt,
    codexAppcastMetadata?.checkedAt,
  ]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value));
  // A cache-first snapshot must report when its oldest contributing lookup
  // was actually checked. Stamping Date.now() here made an older cached alpha
  // release look freshly verified while a newer GitHub prerelease existed.
  const checkedAt = lookupCheckedAt.length > 0
    ? new Date(Math.min(...lookupCheckedAt)).toISOString()
    : new Date().toISOString();
  const managedAlphaVersion = managerState.current?.version ?? betaProbe?.version ?? null;

  return {
    schemaVersion: 1,
    checkedAt,
    fromCache: !force && !!(bundledRelease?.fromCache || betaRelease?.fromCache || codexAppcastMetadata),
    stale: !bundledRelease || !betaRelease || bundledRelease.stale || betaRelease.stale || codexAppcastMetadata?.stale === true,
    desktop: {
      installedMarketingVersion: installedDesktop.installedMarketingVersion,
      installedBuild: installedDesktop.installedBuild,
      latestMarketingVersion: codexAppcastMetadata?.marketingVersion ?? null,
      latestBuild: codexAppcastMetadata?.build ?? null,
      releaseUrl: codexAppcastMetadata?.releaseUrl ?? null,
      nativeUpdateLifecycle: sparkle.lifecycle,
      nativeUpdateActionable: sparkle.canInstall,
      nativeUpdatePrerequisiteError: sparkle.installPrerequisiteFailure,
      updateAvailable: desktopUpdate,
    },
    activeCli: {
      path: activeCliProbe.path,
      version: activeCliProbe.version,
      versionChannel: codexVersionChannel(activeCliProbe.version),
      available: activeCliProbe.available,
      lane: codexCliBootstrap.effectiveLane,
      source: activeCliSource,
      error: activeCliProbe.error,
    },
    cli: {
      bundled: {
        path: bundledProbe.path,
        version: bundledProbe.version,
        versionChannel: codexVersionChannel(bundledProbe.version),
        available: bundledProbe.available,
        release: bundledRelease?.release ?? null,
        error: bundledProbe.error ?? bundledRelease?.error ?? null,
        managedCurrentVersion: null,
        managedPreviousVersion: null,
      },
      beta: {
        path: betaProbe?.path ?? null,
        version: betaProbe?.version ?? null,
        versionChannel: codexVersionChannel(managedAlphaVersion),
        available: betaProbe?.available ?? false,
        release: betaRelease?.release ?? null,
        error: betaProbe?.error ?? betaRelease?.error ?? (betaPath ? null : "No managed Beta is installed"),
        managedCurrentVersion: managerState.current?.version ?? null,
        managedPreviousVersion: managerState.previous?.version ?? null,
      },
    },
    requestedLane: readState().tweaker?.codexCliLane ?? null,
    effectiveLane: codexCliBootstrap.effectiveLane,
    userOverridePreserved: codexCliBootstrap.userOverridePreserved,
    fallbackReason: codexCliBootstrap.error,
    restartRequired: false,
    features,
    installProgress: codexCliManager.getProgress(),
    errors,
    updateAvailable: desktopUpdate || bundledUpdate || betaUpdate,
  };
}

function assertNoIpcArguments(args: unknown[], channel: string): void {
  if (args.length !== 0) throw new Error(`${channel} does not accept arguments`);
}

function assertExactObjectKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label}`);
  }
}

type EnvironmentAppExperience = "chatgpt" | "tweakers";
type EnvironmentReleaseProfile = "stable" | "alpha";

function assertEnvironmentRequest(payload: unknown): asserts payload is {
  appExperience: EnvironmentAppExperience;
  releaseProfile: EnvironmentReleaseProfile;
} {
  assertExactObjectKeys(payload, ["appExperience", "releaseProfile"], "environment request");
  if ((payload.appExperience !== "chatgpt" && payload.appExperience !== "tweakers")
    || (payload.releaseProfile !== "stable" && payload.releaseProfile !== "alpha")) {
    throw new Error("Invalid environment request");
  }
}

function assertEnvironmentTransactionRequest(payload: unknown): asserts payload is { transactionId: string } {
  assertExactObjectKeys(payload, ["transactionId"], "environment transaction request");
  if (typeof payload.transactionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.transactionId)) {
    throw new Error("Invalid environment transaction request");
  }
}

async function ensureManagedAlphaEnvironmentBackend(): Promise<void> {
  let validation = await codexCliManager.validateCurrent();
  if (!validation.valid || !validation.binary) {
    await codexCliManager.installBeta();
    validation = await codexCliManager.validateCurrent();
  }
  if (!validation.valid || !validation.binary) {
    throw new Error(validation.error ?? "Managed Alpha installation did not produce a validated backend");
  }
}

ipcMain.handle("tweaker:get-codex-versions", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-codex-versions");
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:refresh-codex-versions", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "refresh-codex-versions");
  return getCodexVersionsSnapshot(true);
});

ipcMain.handle("tweaker:install-codex-beta", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "install-codex-beta");
  await codexCliManager.installBeta();
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:rollback-codex-beta", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "rollback-codex-beta");
  await codexCliManager.rollbackBeta();
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:set-codex-feature", async (_e, payload: unknown) => {
  assertExactObjectKeys(payload, ["lane", "name", "enabled"], "Codex feature request");
  const { lane, name, enabled } = payload;
  if ((lane !== "bundled" && lane !== "beta") || typeof name !== "string" || typeof enabled !== "boolean") {
    throw new Error("Invalid Codex feature request");
  }
  if (lane !== selectedCodexLane()) throw new Error("Features can only be changed for the selected Codex runtime");
  const binaryForLane = lane === "bundled" ? bundledCodexBinary() : codexCliManager.getSelectedBinary();
  if (!binaryForLane) throw new Error("The selected Codex runtime is not installed");
  await mutateCodexFeature({ lane, name, enabled }, {
    binaryPath: () => binaryForLane,
    inventory: async () => {
      const probe = await codexVersionService.probeCli(binaryForLane);
      if (!probe.available || !probe.features) throw new Error(probe.error ?? "Codex feature inventory is unavailable");
      return probe.features;
    },
    execFile: async (binary, args, options) => {
      await execFileResult(binary, args, options.timeout, 512 * 1024);
    },
  });
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:check-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "check-codex-desktop-update");
  return codexDesktopUpdateService.checkAndPresent();
});

ipcMain.handle("tweaker:get-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-codex-desktop-update");
  const snapshot = lastPublishedCodexDesktopUpdate ?? codexDesktopUpdateService.getSnapshot();
  const result = snapshot ?? selectedDesktopUpdateSetupResult();
  return result ? desktopUpdateResultWithNativeState(result) : null;
});

ipcMain.handle("tweaker:start-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "start-codex-desktop-update");
  startCodexDesktopUpdateTransaction();
  return { started: true, checkedAt: new Date().toISOString() };
});

ipcMain.handle("tweaker:get-codex-desktop-update-transaction", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-codex-desktop-update-transaction");
  return runInstalledCliJson(["update-chatgpt-status", "--json"]);
});

ipcMain.handle("tweaker:resume-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "resume-codex-desktop-update");
  const cli = desktopUpdateCli();
  startInstalledCli(cli, ["update-chatgpt-resume", "--json"]);
  return { started: true, checkedAt: new Date().toISOString() };
});

ipcMain.handle("tweaker:cancel-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "cancel-codex-desktop-update");
  return runInstalledCliJson(["update-chatgpt-cancel", "--json"]);
});

ipcMain.handle("tweaker:get-environment-status", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-environment-status");
  return runInstalledCliJson(
    ["environment", "status", "--observe", "--json"],
    ENVIRONMENT_STATUS_TIMEOUT_MS,
  );
});

// The native runtime owns the file chooser. Renderer code receives only the
// verified status/result, never an arbitrary filesystem path to validate.
ipcMain.handle("tweaker:choose-alpha-environment", async (event, ...args: unknown[]) => {
  assertNoIpcArguments(args, "choose-alpha-environment");
  const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
  const dialogOptions: OpenDialogOptions = {
    title: "Choose OpenAI Beta app",
    properties: ["openDirectory"],
  };
  const picked = owner
    ? await dialog.showOpenDialog(owner, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (picked.canceled || picked.filePaths.length !== 1) return { canceled: true };
  return runInstalledCliJson([
    "environment",
    "register-alpha",
    "--app-path",
    picked.filePaths[0],
    "--json",
  ], ENVIRONMENT_ACTION_TIMEOUT_MS);
});

ipcMain.handle("tweaker:get-environment-transaction", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-environment-transaction");
  const transaction = await runInstalledCliJson(
    ["environment", "transaction", "--json"],
    ENVIRONMENT_ACTION_TIMEOUT_MS,
  );
  return attachEnvironmentHelperDiagnostics(transaction);
});

ipcMain.handle("tweaker:prepare-environment", async (_e, payload: unknown) => {
  assertEnvironmentRequest(payload);
  await buildDevelopmentEnvironmentControlPlane();
  if (payload.appExperience === "tweakers" && payload.releaseProfile === "alpha") {
    await ensureManagedAlphaEnvironmentBackend();
  }
  return runInstalledCliJson([
    "environment",
    "prepare",
    "--app-experience",
    payload.appExperience,
    "--release-profile",
    payload.releaseProfile,
    "--json",
  ], ENVIRONMENT_PREPARE_TIMEOUT_MS);
});

ipcMain.handle("tweaker:commit-environment", async (_e, payload: unknown) => {
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "submit",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_ACTION_TIMEOUT_MS);
});

ipcMain.handle("tweaker:cancel-environment", async (_e, payload: unknown) => {
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "cancel",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_ACTION_TIMEOUT_MS);
});

ipcMain.handle("tweaker:rollback-environment", async (_e, payload: unknown) => {
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "rollback",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_PREPARE_TIMEOUT_MS);
});

// Recovery resolves a stranded receipt from live proof without replacing any
// bytes, so it is the safe action to offer in the UI; rollback stays available
// for callers that specifically want the recorded payload restored.
ipcMain.handle("tweaker:recover-environment", async (_e, payload: unknown) => {
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "recover",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_PREPARE_TIMEOUT_MS);
});

ipcMain.handle("tweaker:get-config", () => {
  const s = readState();
  const installerState = readInstallerState();
  const sourceRoot = installerState?.sourceRoot ?? fallbackSourceRoot();
  return {
    version: TWEAKER_VERSION,
    autoUpdate: s.tweaker?.autoUpdate !== false,
    safeMode: s.tweaker?.safeMode === true,
    updateChannel: s.tweaker?.updateChannel ?? "stable",
    updateRepo: s.tweaker?.updateRepo ?? TWEAKER_REPO,
    updateRef: s.tweaker?.updateRef ?? "",
    updateCheck: s.tweaker?.updateCheck ?? null,
    selfUpdate: readSelfUpdateState(),
    installationSource: describeInstallationSource(sourceRoot),
  };
});

ipcMain.handle("tweaker:set-auto-update", (_e, enabled: boolean) => {
  setTweakerAutoUpdate(!!enabled);
  return { autoUpdate: isTweakerAutoUpdateEnabled() };
});

ipcMain.handle("tweaker:set-update-config", (_e, config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}) => {
  setTweakerUpdateConfig(config);
  const s = readState();
  return {
    updateChannel: s.tweaker?.updateChannel ?? "stable",
    updateRepo: s.tweaker?.updateRepo ?? TWEAKER_REPO,
    updateRef: s.tweaker?.updateRef ?? "",
  };
});

ipcMain.handle("tweaker:check-tweaker-update", async (_e, force?: boolean) => {
  return ensureTweakerUpdateCheck(force === true);
});

ipcMain.handle("tweaker:run-tweaker-update", async () => {
  const sourceRoot = readInstallerState()?.sourceRoot ?? fallbackSourceRoot();
  if (!sourceRoot) {
    throw new Error("Tweakers source CLI was not found. Run the installer once, then try again.");
  }
  const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("Tweakers source CLI was not found. Run the installer once, then try again.");
  }
  const pending = markSelfUpdateStarted(sourceRoot);
  startInstalledCli(cli, ["update", "--watcher"]);
  return pending;
});

ipcMain.handle("tweaker:get-refresh-status", () => localRefreshStatus());
ipcMain.handle("tweaker:start-local-refresh", async (_e, requested?: "smart" | "development" | "stable") => {
  const status = await localRefreshStatus();
  if (!status.available) return { started: false, status };
  const cli = localRefreshCli(status);
  const appRoot = readInstallerState()?.appRoot;
  if (!appRoot || !existsSync(cli)) throw new Error("Tweakers refresh CLI is unavailable");
  startInstalledCli(cli, ["refresh-local", "--source", requested ?? "smart", "--app", appRoot]);
  return { started: true, status: { ...status, phase: "preparing" } };
});

ipcMain.handle("tweaker:get-watcher-health", () => getAndPublishWatcherHealth(userRoot!));
ipcMain.handle("tweaker:repair-auto-maintenance", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "repair-auto-maintenance");
  const cli = localRefreshCli();
  if (!existsSync(cli)) throw new Error("Tweakers maintenance CLI is unavailable");
  startInstalledCli(cli, ["watcher-run"]);
  return { started: true, checkedAt: new Date().toISOString() };
});
ipcMain.handle("tweaker:get-mcp-sync-state", () => mcpReconciler?.readState() ?? null);
ipcMain.handle("tweaker:repair-mcp", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "repair-mcp");
  if (!mcpReconciler) throw new Error("MCP repair is unavailable during a health-only probe");
  return mcpReconciler.reconcileNow("manual-repair");
});

ipcMain.handle("tweaker:get-tweak-store", async () => {
  const store = await fetchTweakStoreRegistry();
  const registry = store.registry;
  const installed = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const entries = shuffleStoreEntries(registry.entries, randomInt);
  return {
    ...registry,
    sourceUrl: TWEAK_STORE_INDEX_URL,
    fetchedAt: store.fetchedAt,
    entries: entries.map((entry) => {
      const local = installed.get(entry.id);
      const platform = storeEntryPlatformCompatibility(entry);
      const runtime = storeEntryRuntimeCompatibility(entry);
      return {
        ...entry,
        platform,
        runtime,
        installed: local
          ? {
              version: local.manifest.version,
              enabled: isTweakEnabled(local.manifest.id),
            }
          : null,
      };
    }),
  };
});

ipcMain.handle("tweaker:install-store-tweak", async (_e, id: string) => {
  const { registry } = await fetchTweakStoreRegistry();
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Tweak store entry not found: ${id}`);
  if (entry.available === false && !isBundledStoreEntry(entry)) {
    throw new Error(`${entry.manifest.name} is catalog metadata only and is not installable yet.`);
  }
  assertStoreEntryPlatformCompatible(entry);
  assertStoreEntryRuntimeCompatible(entry);
  await installStoreTweak(entry);
  await reloadTweaks("store-install", tweakLifecycleDeps);
  return { installed: entry.id };
});

ipcMain.handle("tweaker:prepare-tweak-store-submission", async (_e, repoInput: string) => {
  return prepareTweakStoreSubmission(repoInput);
});

// Sandboxed renderer preload can't use Node fs to read tweak source. Main
// reads it on the renderer's behalf. Path must live under tweaksDir for
// security — we refuse anything else.
ipcMain.handle("tweaker:read-tweak-source", (_e, entryPath: string) => {
  const resolved = resolve(entryPath);
  if (!isPathInside(TWEAKS_DIR, resolved)) {
    throw new Error("path outside tweaks dir");
  }
  return require("node:fs").readFileSync(resolved, "utf8");
});

/**
 * Read an arbitrary asset file from inside a tweak's directory and return it
 * as a `data:` URL. Used by the settings injector to render manifest icons
 * (the renderer is sandboxed; `file://` won't load).
 *
 * Security: caller passes `tweakDir` and `relPath`; we (1) require tweakDir
 * to live under TWEAKS_DIR, (2) resolve relPath against it and re-check the
 * result still lives under TWEAKS_DIR, (3) cap output size at 1 MiB.
 */
const ASSET_MAX_BYTES = 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
ipcMain.handle(
  "tweaker:read-tweak-asset",
  (_e, tweakDir: string, relPath: string) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = resolve(tweakDir);
    if (!isPathInside(TWEAKS_DIR, dir)) {
      throw new Error("tweakDir outside tweaks dir");
    }
    const full = resolve(dir, relPath);
    if (!isPathInside(dir, full) || full === dir) {
      throw new Error("path traversal");
    }
    const stat = fs.statSync(full);
    if (stat.size > ASSET_MAX_BYTES) {
      throw new Error(`asset too large (${stat.size} > ${ASSET_MAX_BYTES})`);
    }
    const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const buf = fs.readFileSync(full);
    return `data:${mime};base64,${buf.toString("base64")}`;
  },
);

// Sandboxed preload can't write logs to disk; forward to us via IPC.
ipcMain.on("tweaker:preload-log", (_e, level: "info" | "warn" | "error", msg: string) => {
  const lvl = level === "error" || level === "warn" ? level : "info";
  try {
    appendCappedLog(join(LOG_DIR, "preload.log"), `[${new Date().toISOString()}] [${lvl}] ${msg}\n`);
  } catch {}
});

// Sandbox-safe filesystem ops for renderer-scope tweaks. Each tweak gets
// a sandboxed dir under userRoot/tweak-data/<id>. Renderer side calls these
// over IPC instead of using Node fs directly.
ipcMain.handle("tweaker:tweak-fs", (_e, op: string, id: string, p: string, c?: string) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("bad tweak id");
  const dir = join(userRoot!, "tweak-data", id);
  mkdirSync(dir, { recursive: true });
  const full = resolve(dir, p);
  if (!isPathInside(dir, full) || full === dir) throw new Error("path traversal");
  const fs = require("node:fs") as typeof import("node:fs");
  switch (op) {
    case "read": return fs.readFileSync(full, "utf8");
    case "write": return fs.writeFileSync(full, c ?? "", "utf8");
    case "exists": return fs.existsSync(full);
    case "dataDir": return dir;
    default: throw new Error(`unknown op: ${op}`);
  }
});

ipcMain.handle("tweaker:user-paths", () => ({
  userRoot,
  runtimeDir,
  tweaksDir: TWEAKS_DIR,
  logDir: LOG_DIR,
}));

ipcMain.handle("tweaker:codex-runtime-info", () => currentRuntimeInfo());
ipcMain.handle("tweaker:codex-runtime-capabilities", () => currentRuntimeCapabilities());
ipcMain.handle("tweaker:codex-cdp-status", () => getCdpStatus());
ipcMain.handle("tweaker:codex-cdp-targets", () => listCdpTargets());
ipcMain.handle("tweaker:codex-window-create", (_e, opts: CodexCreateWindowOptions) => {
  return createCodexWindow(opts);
});
ipcMain.handle("tweaker:codex-window-primary", () => getPrimaryCodexWindowRef());
ipcMain.handle("tweaker:codex-window-focus", (_e, windowId: number) => focusCodexWindow(windowId));
ipcMain.handle("tweaker:codex-window-show", (_e, windowId: number) => showCodexWindow(windowId));
ipcMain.handle(
  "tweaker:codex-view-create",
  async (_e, tweakId: string, options: CodexViewCreateOptions) => {
    const tweak = assertTweakViewPermissionForId(tweakId);
    const ref = await createOwlView({ id: tweak.manifest.id, dir: tweak.dir }, options);
    return {
      id: ref.id,
      webContentsId: ref.webContentsId,
      parentWindowId: ref.parentWindowId,
    };
  },
);
ipcMain.handle(
  "tweaker:codex-view-call",
  (_e, tweakId: string, viewId: string, method: string, arg?: unknown, arg2?: unknown) => {
    assertTweakViewPermissionForId(tweakId);
    return callOwlView(tweakId, viewId, method, arg, arg2);
  },
);
ipcMain.handle("tweaker:codex-view-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  disposeOwlViewsForTweak(tweakId);
});
ipcMain.handle(
  "tweaker:native-load-module",
  (_e, tweakId: string, options: NativeModuleLoadOptions) => {
    const ref = nativeBridge.loadModule(tweakContext(tweakId, "native-module"), options);
    return { id: ref.id, kind: ref.kind };
  },
);
ipcMain.handle(
  "tweaker:native-module-request",
  (_e, tweakId: string, moduleId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-module");
    return nativeBridge.requestModule(tweakId, moduleId, method, payload, timeoutMs);
  },
);
ipcMain.handle("tweaker:native-module-dispose", (_e, tweakId: string, moduleId: string) => {
  assertTweakPermissionForId(tweakId, "native-module");
  return nativeBridge.disposeModule(tweakId, moduleId);
});
ipcMain.handle("tweaker:native-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  nativeBridge.disposeTweak(tweakId);
});
ipcMain.handle(
  "tweaker:native-create-panel",
  async (_e, tweakId: string, options: NativePanelCreateOptions) => {
    const ref = await nativeBridge.createPanel(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id, windowId: ref.windowId };
  },
);
ipcMain.handle(
  "tweaker:native-attach-view",
  async (_e, tweakId: string, options: NativeViewAttachOptions) => {
    const ref = await nativeBridge.attachView(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id };
  },
);
ipcMain.handle(
  "tweaker:native-instance-call",
  async (_e, tweakId: string, kind: "panel" | "view", instanceId: string, method: string, arg?: unknown) => {
    assertTweakPermissionForId(tweakId, "native-view");
    return nativeBridge.callInstance(tweakId, kind, instanceId, method, arg);
  },
);
ipcMain.handle(
  "tweaker:native-launch-helper",
  (_e, tweakId: string, options: NativeHelperLaunchOptions) => {
    const ref = nativeBridge.launchHelper(tweakContext(tweakId, "native-helper"), options);
    return { id: ref.id, pid: ref.pid };
  },
);
ipcMain.handle(
  "tweaker:native-helper-call",
  (_e, tweakId: string, helperId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-helper");
    return nativeBridge.callHelper(tweakId, helperId, method, payload, timeoutMs);
  },
);

ipcMain.handle("tweaker:reveal", (_e, p: string) => {
  shell.openPath(p).catch(() => {});
});

ipcMain.handle("tweaker:open-external", (_e, url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("only github.com links can be opened from tweak metadata");
  }
  shell.openExternal(parsed.toString()).catch(() => {});
});

ipcMain.handle("tweaker:copy-text", (_e, text: string) => {
  clipboard.writeText(String(text));
  return true;
});

// Manual force-reload trigger from the renderer (e.g. the "Force Reload"
// button on our injected Tweaks page). Bypasses the watcher debounce.
ipcMain.handle("tweaker:reload-tweaks", async () => {
  await reloadTweaks("manual", tweakLifecycleDeps);
  return { at: Date.now(), count: tweakState.discovered.length };
});

// 4. Filesystem watcher → debounced reload + broadcast.
//    We watch the tweaks dir for any change. On the first tick of inactivity
//    we stop main-side tweaks, clear their cached modules, re-discover, then
//    restart and broadcast `tweaker:tweaks-changed` to every renderer so it
//    can re-init its host.
const RELOAD_DEBOUNCE_MS = 250;
const DEV_PUBLISH_LOCK = join(TWEAKS_DIR, ".tweaker-dev-publishing");
const DEV_PUBLISH_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
let reloadTimer: NodeJS.Timeout | null = null;
function scheduleReload(reason: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void reloadTweaks(reason, tweakLifecycleDeps).catch((error) => {
      log("error", "failed to reload tweaks:", error);
    });
  }, RELOAD_DEBOUNCE_MS);
}

function devPublicationInProgress(): boolean {
  try {
    return Date.now() - statSync(DEV_PUBLISH_LOCK).mtimeMs < DEV_PUBLISH_LOCK_MAX_AGE_MS;
  } catch { return false; }
}

try {
  const watcher = chokidar.watch(TWEAKS_DIR, {
    ignoreInitial: true,
    // Wait for files to settle before triggering — guards against partially
    // written tweak files during editor saves / git checkouts.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    // Avoid eating CPU on huge node_modules trees inside tweak folders.
    ignored: (p) => p.includes(`${TWEAKS_DIR}/`) && /\/node_modules\//.test(p),
  });
  watcher.on("all", (event, path) => {
    if (devPublicationInProgress()) return;
    scheduleReload(`${event} ${path}`);
  });
  watcher.on("error", (e) => log("warn", "watcher error:", e));
  log("info", "watching", TWEAKS_DIR);
  app.on("will-quit", () => watcher.close().catch(() => {}));
} catch (e) {
  log("error", "failed to start watcher:", e);
}

// --- helpers ---

async function loadAllMainTweaks(): Promise<void> {
  if (healthCheckOnly) return;
  try {
    tweakState.discovered = discoverTweaks(TWEAKS_DIR);
    log(
      "info",
      `discovered ${tweakState.discovered.length} tweak(s):`,
      tweakState.discovered.map((t) => t.manifest.id).join(", "),
    );
  } catch (e) {
    log("error", "tweak discovery failed:", e);
    tweakState.discovered = [];
  }

  const mcpTrigger = initialMcpReconciliationPending ? "startup" : "tweak-reload";
  initialMcpReconciliationPending = false;
  let userQuestionsMcpReady = false;
  if (mcpReconciler) {
    try {
      const receipt = await mcpReconciler.reconcileNow(mcpTrigger);
      userQuestionsMcpReady = userQuestionsMcpReceiptMatchesEnabledState(receipt, true);
    } catch (error) {
      log("error", "MCP reconciliation failed before main tweak startup:", error);
    }
  }

  for (const t of tweakState.discovered) {
    if (!isMainProcessTweakScope(t.manifest.scope)) continue;
    if (!isTweakEnabled(t.manifest.id)) {
      recordTweakLifecycle(t.manifest.id, "main", isTweakQuarantined(t.manifest.id) ? "quarantined" : "disabled");
      log("info", `skipping disabled main tweak: ${t.manifest.id}`);
      continue;
    }
    if (t.manifest.id === "co.tweakers.user-questions" && !userQuestionsMcpReady) {
      const error = "canonical User Questions MCP reconciliation did not complete";
      recordTweakLifecycle(t.manifest.id, "main", "failed", error);
      recordTweakHealth(t.manifest.id, "failed", error);
      log("error", `skipping User Questions main migration: ${error}`);
      continue;
    }
    recordTweakLifecycle(t.manifest.id, "main", "starting");
    try {
      const mod = require(t.entry);
      const tweak = mod.default ?? mod;
      if (typeof tweak?.start === "function") {
        const storage = createDiskStorage(userRoot!, t.manifest.id);
        const startResult = tweak.start({
          manifest: t.manifest,
          process: "main",
          log: makeLogger(t.manifest.id),
          storage,
          ipc: makeMainIpc(t),
          fs: makeMainFs(t.manifest.id),
          codex: makeCodexApi(t),
        });
        tweakState.loadedMain.set(t.manifest.id, {
          // Bind stop() to the tweak object so main-scope cleanup that relies on
          // `this` works — mirrors the renderer host (preload/tweak-host.ts).
          stop: bindMainTweakStop(tweak),
          storage,
        });
        void runWithStartupTimeout(() => startResult, lifecycleStartupTimeoutMs()).then((result) => {
          if (result.status === "timed_out") {
            recordTweakLifecycle(t.manifest.id, "main", "timed_out", `startup exceeded ${lifecycleStartupTimeoutMs()}ms`);
            log("error", `tweak ${t.manifest.id} startup timed out`);
            return;
          }
          recordTweakLifecycle(t.manifest.id, "main", "ready");
          log("info", `started main tweak: ${t.manifest.id}`);
        }).catch((error) => {
          recordTweakLifecycle(t.manifest.id, "main", "failed", error);
          log("error", `tweak ${t.manifest.id} failed to start:`, error);
        });
      } else {
        recordTweakLifecycle(t.manifest.id, "main", "failed", "tweak has no start() function");
      }
    } catch (e) {
      recordTweakLifecycle(t.manifest.id, "main", "failed", e);
      recordTweakHealth(t.manifest.id, "failed", e instanceof Error ? e.message : e);
      log("error", `tweak ${t.manifest.id} failed to start:`, e);
    }
  }
}

function stopAllMainTweaks(): void {
  for (const [id, t] of tweakState.loadedMain) {
    try {
      t.stop?.();
      t.storage.flush();
      log("info", `stopped main tweak: ${id}`);
    } catch (e) {
      log("warn", `stop failed for ${id}:`, e);
    } finally {
      nativeBridge.disposeTweak(id);
      disposeOwlViewsForTweak(id);
    }
  }
  tweakState.loadedMain.clear();
}

function clearTweakModuleCache(): void {
  const rootSet = new Set<string>([TWEAKS_DIR, safeRealpath(TWEAKS_DIR)]);
  const entrySet = new Set<string>();
  for (const tweak of tweakState.discovered) {
    rootSet.add(tweak.dir);
    rootSet.add(safeRealpath(tweak.dir));
    entrySet.add(tweak.entry);
    entrySet.add(safeRealpath(tweak.entry));
  }

  const roots = [...rootSet];
  for (const key of Object.keys(require.cache)) {
    const realKey = safeRealpath(key);
    const isTweakModule =
      entrySet.has(key) ||
      entrySet.has(realKey) ||
      roots.some((root) => isPathInside(root, key) || isPathInside(root, realKey));
    if (isTweakModule) delete require.cache[key];
  }
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

async function ensureTweakerUpdateCheck(force = false): Promise<TweakerUpdateCheck> {
  const state = readState();
  const cached = state.tweaker?.updateCheck;
  const channel = state.tweaker?.updateChannel ?? "stable";
  const repo = state.tweaker?.updateRepo ?? TWEAKER_REPO;
  if (
    !force &&
    cached &&
    cached.currentVersion === TWEAKER_VERSION &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return cached;
  }

  const release = await fetchLatestRelease(repo, TWEAKER_VERSION, channel === "prerelease");
  const latestVersion = release.latestTag ? normalizeVersion(release.latestTag) : null;
  const check: TweakerUpdateCheck = {
    checkedAt: new Date().toISOString(),
    currentVersion: TWEAKER_VERSION,
    latestVersion,
    releaseUrl: release.releaseUrl ?? `https://github.com/${repo}/releases`,
    releaseNotes: release.releaseNotes,
    updateAvailable: latestVersion
      ? compareVersions(normalizeVersion(latestVersion), TWEAKER_VERSION) > 0
      : false,
    ...(release.error ? { error: release.error } : {}),
  };
  state.tweaker ??= {};
  state.tweaker.updateCheck = check;
  writeState(state);
  return check;
}

async function ensureTweakUpdateCheck(t: DiscoveredTweak): Promise<void> {
  const id = t.manifest.id;
  const repo = t.manifest.githubRepo;
  const state = readState();
  const cached = state.tweakUpdateChecks?.[id];
  if (
    cached &&
    cached.repo === repo &&
    cached.currentVersion === t.manifest.version &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return;
  }

  const next = await fetchLatestRelease(repo, t.manifest.version);
  const latestVersion = next.latestTag ? normalizeVersion(next.latestTag) : null;
  const check: TweakUpdateCheck = {
    checkedAt: new Date().toISOString(),
    repo,
    currentVersion: t.manifest.version,
    latestVersion,
    latestTag: next.latestTag,
    releaseUrl: next.releaseUrl,
    updateAvailable: latestVersion
      ? compareVersions(latestVersion, normalizeVersion(t.manifest.version)) > 0
      : false,
    ...(next.error ? { error: next.error } : {}),
  };
  state.tweakUpdateChecks ??= {};
  state.tweakUpdateChecks[id] = check;
  writeState(state);
}

async function fetchLatestRelease(
  repo: string,
  currentVersion: string,
  includePrerelease = false,
): Promise<{ latestTag: string | null; releaseUrl: string | null; releaseNotes: string | null; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const endpoint = includePrerelease ? "releases?per_page=20" : "releases/latest";
      const res = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": `tweaker/${currentVersion}`,
        },
        signal: controller.signal,
      });
      if (res.status === 404) {
        return { latestTag: `v${currentVersion}`, releaseUrl: null, releaseNotes: null };
      }
      if (!res.ok) {
        return { latestTag: null, releaseUrl: null, releaseNotes: null, error: `GitHub returned ${res.status}` };
      }
      const json = await res.json() as { tag_name?: string; html_url?: string; body?: string; draft?: boolean } | Array<{ tag_name?: string; html_url?: string; body?: string; draft?: boolean }>;
      const body = Array.isArray(json) ? json.find((release) => !release.draft) : json;
      if (!body) {
        return { latestTag: `v${currentVersion}`, releaseUrl: null, releaseNotes: null };
      }
      return {
        latestTag: body.tag_name ?? null,
        releaseUrl: body.html_url ?? `https://github.com/${repo}/releases`,
        releaseNotes: body.body ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return {
      latestTag: null,
      releaseUrl: null,
      releaseNotes: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

interface TweakStoreFetchResult {
  registry: TweakStoreRegistry;
  fetchedAt: string;
}

/**
 * The installer copies the repository catalog beside the generated runtime.
 * It is the local source of truth for the nine v4 entries; the network
 * registry can enrich it, but may never add entries outside this catalog.
 */
function readBundledTweakCatalog(): TweakStoreRegistry | null {
  try {
    if (!existsSync(TWEAK_CATALOG_FILE)) return null;
    return normalizeStoreRegistry(JSON.parse(readFileSync(TWEAK_CATALOG_FILE, "utf8")));
  } catch (error) {
    log("warn", "failed to read bundled Tweakers catalog:", String(error));
    return null;
  }
}

function buildTweakHealthSnapshot(): TweakHealthSnapshot {
  const catalog = readBundledTweakCatalog();
  const catalogEntries = catalog?.entries ?? [];
  const discoveredById = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const mcpState = mcpReconciler?.readState() as { restartRequired?: boolean } | null | undefined;
  const rows = catalogEntries.map((entry) => {
    const local = discoveredById.get(entry.id);
    const liveVersion = local?.manifest.version ?? readManifestVersion(join(TWEAKS_DIR, liveTweakFolder(entry), "manifest.json"));
    const runtimeVersion = readRuntimeTweakVersion(entry);
    const catalogVersion = entry.manifest.version ?? null;
    const liveMatches = liveVersion !== null && catalogVersion !== null && normalizeVersion(liveVersion) === normalizeVersion(catalogVersion);
    const runtimeMatches = runtimeVersion !== null && catalogVersion !== null && normalizeVersion(runtimeVersion) === normalizeVersion(catalogVersion);
    const hasMcp = Boolean((entry.manifest as TweakManifest & { mcp?: unknown }).mcp);
    const enabled = local ? isTweakEnabled(entry.id) : false;
    const status: TweakVersionDriftRow["status"] =
      liveVersion === null || runtimeVersion === null ? "missing" :
        liveMatches && runtimeMatches ? "current" : "drift";
    return {
      id: entry.id,
      name: entry.manifest.name,
      enabled,
      hasMcp,
      liveVersion,
      runtimeVersion,
      catalogVersion,
      status,
      reason: tweakVersionDriftReason({
        liveVersion,
        runtimeVersion,
        catalogVersion,
        liveMatches,
        runtimeMatches,
      }),
    };
  });
  const liveDriftCount = rows.filter((row) =>
    row.liveVersion !== null &&
    row.catalogVersion !== null &&
    normalizeVersion(row.liveVersion) !== normalizeVersion(row.catalogVersion)
  ).length;
  const runtimeDriftCount = rows.filter((row) =>
    row.runtimeVersion !== null &&
    row.catalogVersion !== null &&
    normalizeVersion(row.runtimeVersion) !== normalizeVersion(row.catalogVersion)
  ).length;
  return {
    checkedAt: new Date().toISOString(),
    catalogCount: catalogEntries.length,
    installedCount: tweakState.discovered.length,
    enabledCount: tweakState.discovered.filter((t) => isTweakEnabled(t.manifest.id)).length,
    liveDriftCount,
    runtimeDriftCount,
    missingLiveCount: rows.filter((row) => row.liveVersion === null).length,
    missingRuntimeCount: rows.filter((row) => row.runtimeVersion === null).length,
    mcpRestartRequired: mcpState?.restartRequired === true,
    rows,
  };
}

function liveTweakFolder(entry: TweakStoreEntry): string {
  if (entry.source?.kind === "bundled") return entry.source.path.split("/").pop() ?? entry.id;
  return entry.id;
}

function readRuntimeTweakVersion(entry: TweakStoreEntry): string | null {
  if (entry.source?.kind !== "bundled") return null;
  try {
    return readManifestVersion(join(resolveBundledTweakPath(runtimeDir!, entry), "manifest.json"));
  } catch {
    return null;
  }
}

function readManifestVersion(manifestPath: string): string | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<TweakManifest>;
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function tweakVersionDriftReason(input: {
  liveVersion: string | null;
  runtimeVersion: string | null;
  catalogVersion: string | null;
  liveMatches: boolean;
  runtimeMatches: boolean;
}): string {
  if (!input.catalogVersion) return "No catalog version is available.";
  if (!input.liveVersion) return "Live installed copy is missing.";
  if (!input.runtimeVersion) return "Bundled runtime copy is missing.";
  const stale: string[] = [];
  if (!input.liveMatches) stale.push(`live ${input.liveVersion}`);
  if (!input.runtimeMatches) stale.push(`runtime ${input.runtimeVersion}`);
  if (stale.length) return `${stale.join(" and ")} differs from latest stored ${input.catalogVersion}.`;
  return "Live and runtime copies match the latest stored version.";
}

function restrictRegistryToBundledCatalog(registry: TweakStoreRegistry): TweakStoreRegistry {
  const bundled = readBundledTweakCatalog();
  if (!bundled || bundled.entries.length === 0) return registry;
  const remote = new Map(registry.entries.map((entry) => [entry.id, entry]));
  return {
    ...bundled,
    // Prefer the bundled manifest/availability metadata. A remote entry may
    // only provide approved coordinates for an already-known catalog id.
    entries: bundled.entries.map((entry) => {
      const update = remote.get(entry.id);
      // Packaged entries are self-contained and must not be replaced by a
      // network response that silently turns them into an unpinned archive.
      return isBundledStoreEntry(entry) || entry.available === false ? entry : update ?? entry;
    }),
  };
}

interface StoreInstallMetadata {
  repo?: string;
  approvedCommitSha?: string;
  source?: { kind: "bundled" | "remote"; path?: string };
  installedAt: string;
  storeIndexUrl: string;
  files?: Record<string, string>;
}

interface StoreEntryPlatformCompatibility {
  current: NodeJS.Platform;
  supported: TweakStorePlatform[] | null;
  compatible: boolean;
  reason: string | null;
}

interface StoreEntryRuntimeCompatibility {
  current: string;
  required: string | null;
  compatible: boolean;
  reason: string | null;
}

class StoreTweakModifiedError extends Error {
  constructor(tweakName: string) {
    super(
      `${tweakName} has local source changes, so Tweakers can't auto-update it. Revert your local changes or reinstall the tweak manually.`,
    );
    this.name = "StoreTweakModifiedError";
  }
}

function storeEntryPlatformCompatibility(entry: TweakStoreEntry): StoreEntryPlatformCompatibility {
  const supported = entry.platforms ?? null;
  const compatible = !supported || supported.includes(process.platform as TweakStorePlatform);
  return {
    current: process.platform,
    supported,
    compatible,
    reason: compatible ? null : `${entry.manifest.name} is only available on ${formatStorePlatforms(supported)}.`,
  };
}

function assertStoreEntryPlatformCompatible(entry: TweakStoreEntry): void {
  const platform = storeEntryPlatformCompatibility(entry);
  if (!platform.compatible) {
    throw new Error(platform.reason ?? `${entry.manifest.name} is not available on this platform.`);
  }
}

function storeEntryRuntimeCompatibility(entry: TweakStoreEntry): StoreEntryRuntimeCompatibility {
  const required = cleanMinRuntime(entry.manifest.minRuntime);
  const compatible = !required || compareVersions(TWEAKER_VERSION, required) >= 0;
  return {
    current: TWEAKER_VERSION,
    required,
    compatible,
    reason: compatible || !required
      ? null
      : `${entry.manifest.name} requires Tweakers ${required} or newer.`,
  };
}

function assertStoreEntryRuntimeCompatible(entry: TweakStoreEntry): void {
  const runtime = storeEntryRuntimeCompatibility(entry);
  if (!runtime.compatible) {
    throw new Error(runtime.reason ?? `${entry.manifest.name} requires a newer Tweakers runtime.`);
  }
}

function cleanMinRuntime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = normalizeVersion(value.replace(/^>=?\s*/, ""));
  return VERSION_RE.test(version) ? version : null;
}

function formatStorePlatforms(platforms: TweakStorePlatform[] | null): string {
  if (!platforms || platforms.length === 0) return "supported platforms";
  return platforms.map((platform) => {
    if (platform === "darwin") return "macOS";
    if (platform === "win32") return "Windows";
    return "Linux";
  }).join(", ");
}

async function fetchTweakStoreRegistry(): Promise<TweakStoreFetchResult> {
  const fetchedAt = new Date().toISOString();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(TWEAK_STORE_INDEX_URL, {
        headers: {
          "Accept": "application/json",
          "User-Agent": `tweaker/${TWEAKER_VERSION}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`store returned ${res.status}`);
      return {
        registry: restrictRegistryToBundledCatalog(normalizeStoreRegistry(await res.json())),
        fetchedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // The hosted registry 404s while the repo/Pages is private; the bundled
    // catalog covers that. One warn per process, not one per launch fetch.
    if (!warnedStoreRegistryFetch) {
      warnedStoreRegistryFetch = true;
      log("warn", "failed to fetch tweak store registry (using bundled catalog):", error.message);
    }
    const fallback = readBundledTweakCatalog();
    if (fallback) return { registry: fallback, fetchedAt };
    throw error;
  }
}
let warnedStoreRegistryFetch = false;

async function installStoreTweak(entry: TweakStoreEntry): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "tweaker-store-tweak-"));
  const archive = join(work, "source.tar.gz");
  const extractDir = join(work, "extract");
  const target = join(TWEAKS_DIR, entry.id);
  const stagedTarget = join(work, "staged", entry.id);

  try {
    let source: string;
    if (entry.source?.kind === "bundled") {
      // The catalog path is constrained to `tweaks/<id>` by normalization;
      // resolving it here keeps traversal and cross-entry installs closed.
      const bundledPath = entry.source.path;
      if (typeof bundledPath !== "string") throw new Error(`bundled source for ${entry.id} is missing a path`);
      source = resolveBundledTweakPath(runtimeDir!, { ...entry, source: { kind: "bundled", path: bundledPath as string } });
      if (!existsSync(source) || !statSync(source).isDirectory()) {
        throw new Error(`bundled source for ${entry.id} is missing from the installer runtime`);
      }
      log("info", `installing bundled tweak ${entry.id} from ${source}`);
    } else {
      const url = storeArchiveUrl(entry);
      log("info", `installing store tweak ${entry.id} from ${entry.repo ?? "(unknown)"}@${entry.approvedCommitSha ?? "(unknown)"}`);
      const res = await fetch(url, {
        headers: { "User-Agent": `tweaker/${TWEAKER_VERSION}` },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      writeFileSync(archive, bytes);
      mkdirSync(extractDir, { recursive: true });
      extractTarArchive(archive, extractDir);
      source = findTweakRoot(extractDir) ?? "";
      if (!source) throw new Error("downloaded archive did not contain manifest.json");
    }
    validateStoreTweakSource(entry, source);
    rmSync(stagedTarget, { recursive: true, force: true });
    copyTweakSource(source, stagedTarget);
    const stagedFiles = hashTweakSource(stagedTarget);
    writeFileSync(
      join(stagedTarget, ".tweaker-store.json"),
      JSON.stringify(
        {
          ...(entry.repo ? { repo: entry.repo } : {}),
          ...(entry.approvedCommitSha ? { approvedCommitSha: entry.approvedCommitSha } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          installedAt: new Date().toISOString(),
          storeIndexUrl: TWEAK_STORE_INDEX_URL,
          files: stagedFiles,
        },
        null,
        2,
      ),
    );
    await assertStoreTweakCleanForAutoUpdate(entry, target, work);
    rmSync(target, { recursive: true, force: true });
    cpSync(stagedTarget, target, { recursive: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function prepareTweakStoreSubmission(repoInput: string): Promise<TweakStorePublishSubmission> {
  const repo = normalizeGitHubRepo(repoInput);
  const repoInfo = await fetchGithubJson<{ default_branch?: string }>(`https://api.github.com/repos/${repo}`);
  const defaultBranch = repoInfo.default_branch;
  if (!defaultBranch) throw new Error(`Could not resolve default branch for ${repo}`);

  const commit = await fetchGithubJson<{
    sha?: string;
    html_url?: string;
  }>(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(defaultBranch)}`);
  if (!commit.sha) throw new Error(`Could not resolve current commit for ${repo}`);

  const manifest = await fetchManifestAtCommit(repo, commit.sha).catch((e) => {
    log("warn", `could not read manifest for store submission ${repo}@${commit.sha}:`, e);
    return undefined;
  });

  return {
    repo,
    defaultBranch,
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? `https://github.com/${repo}/commit/${commit.sha}`,
    manifest: manifest
      ? {
          id: typeof manifest.id === "string" ? manifest.id : undefined,
          name: typeof manifest.name === "string" ? manifest.name : undefined,
          version: typeof manifest.version === "string" ? manifest.version : undefined,
          description: typeof manifest.description === "string" ? manifest.description : undefined,
          iconUrl: typeof manifest.iconUrl === "string" ? manifest.iconUrl : undefined,
        }
      : undefined,
  };
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `tweaker/${TWEAKER_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchManifestAtCommit(repo: string, commitSha: string): Promise<Partial<TweakManifest>> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commitSha}/manifest.json`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": `tweaker/${TWEAKER_VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`manifest fetch returned ${res.status}`);
  return await res.json() as Partial<TweakManifest>;
}

function extractTarArchive(archive: string, targetDir: string): void {
  const result = spawnSync("tar", ["-xzf", archive, "-C", targetDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed: ${result.stderr || result.stdout || result.status}`);
  }
}

function validateStoreTweakSource(entry: TweakStoreEntry, source: string): void {
  const manifestPath = join(source, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TweakManifest;
  if (manifest.id !== entry.manifest.id) {
    throw new Error(`downloaded tweak id ${manifest.id} does not match approved id ${entry.manifest.id}`);
  }
  const approvedRepo = entry.source?.kind === "remote" ? entry.source.repo : entry.repo;
  if (approvedRepo && manifest.githubRepo !== approvedRepo) {
    throw new Error(`downloaded tweak repo ${manifest.githubRepo} does not match approved repo ${approvedRepo}`);
  }
  if (manifest.version !== entry.manifest.version) {
    throw new Error(`downloaded tweak version ${manifest.version} does not match approved version ${entry.manifest.version}`);
  }
}

function findTweakRoot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  if (existsSync(join(dir, "manifest.json"))) return dir;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = findTweakRoot(child);
    if (found) return found;
  }
  return null;
}

function copyTweakSource(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(?:\.git|node_modules)(?:[/\\]|$)/.test(src),
  });
}

async function assertStoreTweakCleanForAutoUpdate(
  entry: TweakStoreEntry,
  target: string,
  work: string,
): Promise<void> {
  if (!existsSync(target)) return;
  const metadata = readStoreInstallMetadata(target);
  if (!metadata) return;
  if (metadata.repo !== entry.repo) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
  const currentFiles = hashTweakSource(target);
  const baselineFiles = metadata.files ?? await fetchBaselineStoreTweakHashes(metadata, work);
  if (!sameFileHashes(currentFiles, baselineFiles)) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
}

function readStoreInstallMetadata(target: string): StoreInstallMetadata | null {
  const currentPath = join(target, ".tweaker-store.json");
  const legacyPath = join(target, LEGACY_STORE_METADATA);
  const metadataPath = existsSync(currentPath) ? currentPath : legacyPath;
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<StoreInstallMetadata>;
    const bundled = parsed.source?.kind === "bundled";
    if (!bundled && (typeof parsed.repo !== "string" || typeof parsed.approvedCommitSha !== "string")) return null;
    return {
      ...(typeof parsed.repo === "string" ? { repo: parsed.repo } : {}),
      ...(typeof parsed.approvedCommitSha === "string" ? { approvedCommitSha: parsed.approvedCommitSha } : {}),
      ...(parsed.source ? { source: parsed.source } : {}),
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      storeIndexUrl: typeof parsed.storeIndexUrl === "string" ? parsed.storeIndexUrl : "",
      files: isHashRecord(parsed.files) ? parsed.files : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchBaselineStoreTweakHashes(
  metadata: StoreInstallMetadata,
  work: string,
): Promise<Record<string, string>> {
  if (!metadata.repo || !metadata.approvedCommitSha) {
    throw new Error("Could not verify local tweak changes before update: source baseline is not remote");
  }
  const baselineDir = join(work, "baseline");
  const archive = join(work, "baseline.tar.gz");
  const res = await fetch(`https://codeload.github.com/${metadata.repo}/tar.gz/${metadata.approvedCommitSha}`, {
    headers: { "User-Agent": `tweaker/${TWEAKER_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Could not verify local tweak changes before update: ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  mkdirSync(baselineDir, { recursive: true });
  extractTarArchive(archive, baselineDir);
  const source = findTweakRoot(baselineDir);
  if (!source) throw new Error("Could not verify local tweak changes before update: baseline manifest missing");
  return hashTweakSource(source);
}

function hashTweakSource(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  collectTweakFileHashes(root, root, out);
  return out;
}

function collectTweakFileHashes(root: string, dir: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules" || name === ".tweaker-store.json" || name === LEGACY_STORE_METADATA) continue;
    const full = join(dir, name);
    const rel = relative(root, full).split("\\").join("/");
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTweakFileHashes(root, full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
}

function sameFileHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (key !== bk[i] || a[key] !== b[key]) return false;
  }
  return true;
}

function isHashRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const av = VERSION_RE.exec(a);
  const bv = VERSION_RE.exec(b);
  if (!av || !bv) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(av[i]) - Number(bv[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function fallbackSourceRoot(): string | null {
  const candidates = [
    join(homedir(), ".tweaker", "source"),
    join(homedir(), `.${LEGACY_DATA_DIR}`, "source"),
    join(userRoot!, "source"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "packages", "installer", "dist", "cli.js"))) return candidate;
  }
  return null;
}

function describeInstallationSource(sourceRoot: string | null): InstallationSource {
  if (!sourceRoot) {
    return {
      kind: "unknown",
      label: "Unknown",
      detail: "Tweakers source location is not recorded yet.",
    };
  }
  const normalized = sourceRoot.replace(/\\/g, "/");
  if (/\/(?:Homebrew|homebrew)\/Cellar\/tweaker\//.test(normalized)
    || normalized.includes(`/${LEGACY_DATA_DIR.replace("-", "")}/`)) {
    return { kind: "homebrew", label: "Homebrew", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, ".git"))) {
    return { kind: "local-dev", label: "Local development checkout", detail: sourceRoot };
  }
  if (normalized.endsWith("/.tweaker/source")
    || normalized.includes("/.tweaker/source/")
    || normalized.endsWith(`/.${LEGACY_DATA_DIR}/source`)
    || normalized.includes(`/.${LEGACY_DATA_DIR}/source/`)) {
    return { kind: "github-source", label: "GitHub source installer", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, "package.json"))) {
    return { kind: "source-archive", label: "Source archive", detail: sourceRoot };
  }
  return { kind: "unknown", label: "Unknown", detail: sourceRoot };
}

function startInstalledCli(cli: string, args: string[]): void {
  if (process.platform === "darwin" && startInstalledCliWithLaunchd(cli, args)) {
    return;
  }
  const runtime = localCliRuntime(cli, args);
  const child = spawn(runtime.command, runtime.args, {
    cwd: resolve(dirname(cli), "..", "..", ".."),
    env: { ...runtime.env, TWEAKER_MANUAL_UPDATE: "1", [LEGACY_MANUAL_UPDATE_ENV]: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function startCodexDesktopUpdateTransaction(): void {
  const cli = desktopUpdateCli();
  startInstalledCli(cli, ["update-chatgpt", "--json"]);
}

function desktopUpdateCli(status?: LocalRefreshStatusValue): string {
  const cli = localRefreshCli(status);
  if (!existsSync(cli)) throw new Error("Tweakers desktop-update CLI is unavailable");
  return cli;
}

let environmentDevelopmentBuildInFlight: Promise<void> | null = null;

async function buildDevelopmentEnvironmentControlPlane(): Promise<void> {
  const status = await localRefreshStatus();
  if (status.source !== "development" || !status.developmentSourceRoot) return;
  if (environmentDevelopmentBuildInFlight) return environmentDevelopmentBuildInFlight;
  const sourceRoot = realpathSync(status.developmentSourceRoot);
  const packageFile = join(sourceRoot, "package.json");
  if (!existsSync(packageFile)) {
    throw new Error("The registered Tweakers development checkout is unavailable");
  }
  environmentDevelopmentBuildInFlight = new Promise<void>((resolvePromise, rejectPromise) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["run", "build"], {
      cwd: sourceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const capture = (chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      output = `${output}${chunk.toString()}`.slice(-8_000);
      if (outputBytes > 16 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(() => rejectPromise(new Error("Tweakers development build output exceeded the limit")));
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (code, signal) => finish(() => {
      if (code !== 0) {
        rejectPromise(new Error(
          `Tweakers development build failed with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}`
          + `${output.trim() ? `: ${output.trim()}` : ""}`,
        ));
        return;
      }
      const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
      if (!existsSync(cli)) {
        rejectPromise(new Error("Tweakers development build did not produce its installer CLI"));
        return;
      }
      resolvePromise();
    }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => rejectPromise(new Error("Tweakers development build timed out")));
    }, 10 * 60_000);
  }).finally(() => {
    environmentDevelopmentBuildInFlight = null;
  });
  return environmentDevelopmentBuildInFlight;
}

async function runInstalledCliJson(args: string[], timeoutMs = 10_000): Promise<unknown> {
  const status = await localRefreshStatus();
  const cli = desktopUpdateCli(status);
  const runtime = localCliRuntime(cli, args);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(runtime.command, runtime.args, {
      cwd: resolve(dirname(cli), "..", "..", ".."),
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > CLI_JSON_MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() => rejectPromise(new Error(`Tweakers CLI output exceeded the limit for ${args[0] ?? "command"}`)));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => rejectPromise(new Error(`Tweakers CLI timed out while running ${args[0] ?? "command"}`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (code) => finish(() => {
      let parsed: unknown;
      let parseFailed = false;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        parseFailed = true;
      }
      if (code !== 0) {
        // A durable receipt on stdout is the diagnosis; the non-zero exit only
        // says the action did not reach its success phase. Keep the receipt so
        // the renderer can surface why, rather than a generic failure.
        if (!parseFailed) {
          resolvePromise(parsed);
          return;
        }
        rejectPromise(new Error(stderr.trim() || `Tweakers CLI exited with status ${code ?? "unknown"}`));
        return;
      }
      if (parseFailed) {
        rejectPromise(new Error(`Tweakers CLI returned invalid JSON for ${args[0] ?? "command"}`));
        return;
      }
      resolvePromise(parsed);
    }));
  });
}

function attachEnvironmentHelperDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const transaction = value as Record<string, unknown>;
  const transactionId = typeof transaction.transactionId === "string" ? transaction.transactionId : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transactionId)) return value;
  const helperRoot = join(userRoot!, "transactions", "environment", transactionId);
  const label = `co.tweakers.environment.${transactionId}`;
  const readJson = (file: string): unknown => {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  };
  const readLogTail = (file: string): string => {
    try {
      const contents = readFileSync(file, "utf8");
      return contents.slice(-16 * 1024);
    } catch {
      return "";
    }
  };
  const submission = readJson(join(helperRoot, "commit-helper.json")) as Record<string, unknown> | null;
  let outcome = readJson(join(helperRoot, `${label}.outcome.json`)) as Record<string, unknown> | null;
  const ENVIRONMENT_HELPER_STALE_MS = 60_000;
  if (submission && outcome && (outcome.phase === "not-started" || outcome.phase === "running")) {
    const reference = outcome.phase === "running" ? outcome.startedAt : submission.submittedAt;
    const referenceTime = typeof reference === "string" ? Date.parse(reference) : Number.NaN;
    if (!Number.isFinite(referenceTime) || Date.now() - referenceTime >= ENVIRONMENT_HELPER_STALE_MS) {
      outcome = {
        ...outcome,
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: outcome.phase === "running"
          ? "Environment helper stopped before reporting an outcome. Retry or roll back the prepared transaction."
          : "Environment helper did not start. Retry the prepared transaction.",
      };
    }
  }
  return {
    ...transaction,
    helper: {
      submission,
      outcome,
      stdout: readLogTail(join(helperRoot, `${label}.stdout.log`)),
      stderr: readLogTail(join(helperRoot, `${label}.stderr.log`)),
    },
  };
}

interface LocalRefreshStatusValue {
  available: boolean;
  source: "development" | "stable" | "current";
  phase: string;
  developmentSourceRoot: string | null;
  detail: string;
  error: string | null;
  checkedAt: string;
}

// Renderer tweaks poll refresh status on DOM mutations, so this must never
// block the main process (a synchronous CLI spawn here froze the UI on
// hover) and must never spawn the Electron binary as a full second app —
// ELECTRON_RUN_AS_NODE is mandatory. Cache + in-flight dedupe absorb bursts.
let refreshStatusCache: { value: LocalRefreshStatusValue; at: number } | null = null;
let refreshStatusInFlight: Promise<LocalRefreshStatusValue> | null = null;
const REFRESH_STATUS_TTL_MS = 4_000;

function localRefreshStatus(): Promise<LocalRefreshStatusValue> {
  if (refreshStatusCache && Date.now() - refreshStatusCache.at < REFRESH_STATUS_TTL_MS) {
    return Promise.resolve(refreshStatusCache.value);
  }
  if (refreshStatusInFlight) return refreshStatusInFlight;
  refreshStatusInFlight = probeLocalRefreshStatus().then((value) => {
    refreshStatusCache = { value, at: Date.now() };
    return value;
  }).finally(() => { refreshStatusInFlight = null; });
  return refreshStatusInFlight;
}

function probeLocalRefreshStatus(): Promise<LocalRefreshStatusValue> {
  const cli = localRefreshCli();
  if (!existsSync(cli)) return Promise.resolve({
    available: false, source: "current", phase: "failed", developmentSourceRoot: null,
    detail: "Tweakers refresh CLI is unavailable", error: "refresh CLI missing", checkedAt: new Date().toISOString(),
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const runtime = localCliRuntime(cli, ["refresh-status"]);
    const child = spawn(runtime.command, runtime.args, {
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectPromise(new Error(stderr.trim() || "Could not read Tweakers refresh status"));
      try { resolvePromise(JSON.parse(stdout.trim()) as LocalRefreshStatusValue); }
      catch (error) { rejectPromise(error as Error); }
    });
  });
}

// The OpenAI-bundled renderer Node enforces Team-ID library validation and
// cannot load Tweakers' separately signed native swap module. Prefer the exact
// Node executable captured by the installed Tweakers CLI shim; retain the
// bundled renderer Node only as a compatibility fallback for native-free work.
function localCliRuntime(cli: string, args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TWEAKERS_HOME: userRoot!,
    TWEAKER_HOME: userRoot!,
    TWEAKERS_USER_ROOT: userRoot!,
    TWEAKER_USER_ROOT: userRoot!,
    [LEGACY_USER_ROOT_ENV]: userRoot!,
  };
  return resolveLocalCliRuntime({
    cli,
    args,
    userRoot: userRoot!,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    env,
  });
}

function localRefreshCli(status?: { source?: string; developmentSourceRoot?: string | null }): string {
  let developmentSourceRoot = status?.developmentSourceRoot ?? null;
  if (!developmentSourceRoot) {
    try {
      const section = readState().tweaker as { developmentSourceRoot?: unknown } | undefined;
      if (typeof section?.developmentSourceRoot === "string") developmentSourceRoot = section.developmentSourceRoot;
    } catch {}
  }
  if ((status?.source === "development" || !status) && developmentSourceRoot) {
    const cli = join(developmentSourceRoot, "packages", "installer", "dist", "cli.js");
    if (existsSync(cli)) return cli;
  }
  return join(userRoot!, "managed-runtime", "current", "packages", "installer", "dist", "cli.js");
}

// This launchd helper runs the installer CLI, which must outlive the app's own
// bundle swap AND the app's own termination. It deliberately avoids both
// app.relaunch() (cannot outlive replacing the running executable) and
// `launchctl submit` from the app process: LaunchServices records submitted
// jobs as the submitting application's "one-shot jobs" and the Dock's quit
// support UNLOADS them when that app terminates — which killed a coordinator
// mid-commit the moment it quit the app for cutover (observed 2026-07-29:
// `_LSForceQuitApplication: Unloading one-shot jobs for application "ChatGPT"`).
// A plist bootstrapped into the gui domain is a plain domain service with no
// application attribution, so it survives the app quitting; the per-PID label
// and EXIT trap's bootout + plist removal make the transient job self-remove.
function startInstalledCliWithLaunchd(cli: string, args: string[]): boolean {
  const label = `com.therealityreport.tweakers.patch-helper.${process.pid}.${Date.now()}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  const plistPath = join(tmpdir(), `${label}.plist`);
  // rm BEFORE bootout: booting out a running service SIGTERMs the very shell
  // executing this trap, so anything after bootout races signal delivery.
  const cleanup = `rm -f ${shellQuote(plistPath)}; launchctl bootout gui/${uid}/${label} >/dev/null 2>&1; true`;
  const runtime = localCliRuntime(cli, args);
  const command = [
    `trap ${shellQuote(cleanup)} EXIT`,
    `cd ${shellQuote(resolve(dirname(cli), "..", "..", ".."))}`,
    `TWEAKERS_HOME=${shellQuote(userRoot!)} TWEAKER_HOME=${shellQuote(userRoot!)} TWEAKERS_USER_ROOT=${shellQuote(userRoot!)} TWEAKER_USER_ROOT=${shellQuote(userRoot!)} ${LEGACY_USER_ROOT_ENV}=${shellQuote(userRoot!)} TWEAKER_MANUAL_UPDATE=1 ${LEGACY_MANUAL_UPDATE_ENV}=1 ELECTRON_RUN_AS_NODE=1 ${[runtime.command, ...runtime.args].map(shellQuote).join(" ")}`,
  ].join(" && ");
  const plist = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `  <key>Label</key><string>${label}</string>`,
    `  <key>ProgramArguments</key><array>`,
    `    <string>/bin/sh</string>`,
    `    <string>-c</string>`,
    `    <string>${xmlEscape(`${command} || true`)}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>AbandonProcessGroup</key><true/>`,
    `</dict></plist>`,
  ].join("\n");
  try {
    writeFileSync(plistPath, plist, { mode: 0o600 });
  } catch (error) {
    log("warn", `could not stage Tweakers patch helper plist: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const result = spawnSync(
    "launchctl",
    ["bootstrap", `gui/${uid}`, plistPath],
    {
      encoding: "utf8",
      stdio: "ignore",
    },
  );
  if (result.status === 0) return true;
  try {
    rmSync(plistPath, { force: true });
  } catch {
    // Best effort — a stale tmp plist is inert without its bootstrap.
  }
  log("warn", `launchctl bootstrap failed for Tweakers patch helper: ${result.error?.message ?? result.status}`);
  return false;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function markSelfUpdateStarted(sourceRoot: string): SelfUpdateState {
  const config = readState().tweaker;
  const channel = config?.updateChannel ?? "stable";
  const state: SelfUpdateState = {
    checkedAt: new Date().toISOString(),
    status: "checking",
    currentVersion: TWEAKER_VERSION,
    latestVersion: null,
    targetRef: config?.updateChannel === "custom" ? config.updateRef ?? null : null,
    releaseUrl: null,
    repo: config?.updateRepo ?? TWEAKER_REPO,
    channel,
    sourceRoot,
    installationSource: describeInstallationSource(sourceRoot),
  };
  writeSelfUpdateState(state);
  return state;
}

function broadcastReload(): void {
  const payload = {
    at: Date.now(),
    tweaks: tweakState.discovered.map((t) => t.manifest.id),
  };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send("tweaker:tweaks-changed", payload);
    } catch (e) {
      log("warn", "broadcast send failed:", e);
    }
  }
}

function makeLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => log("info", `[${scope}]`, ...a),
    info: (...a: unknown[]) => log("info", `[${scope}]`, ...a),
    warn: (...a: unknown[]) => log("warn", `[${scope}]`, ...a),
    error: (...a: unknown[]) => log("error", `[${scope}]`, ...a),
  };
}

function makeMainIpc(tweak: DiscoveredTweak) {
  const id = tweak.manifest.id;
  const ch = (c: string) => `tweaker:${id}:${c}`;
  const requireIpc = () => assertTweakPermission(tweak, "ipc");
  return {
    on: (c: string, h: (...args: unknown[]) => void) => {
      requireIpc();
      const wrapped = (_e: unknown, ...args: unknown[]) => h(...args);
      ipcMain.on(ch(c), wrapped);
      return () => ipcMain.removeListener(ch(c), wrapped as never);
    },
    send: (c: string, ...args: unknown[]) => {
      requireIpc();
      for (const wc of webContents.getAllWebContents()) {
        try { wc.send(ch(c), ...args); } catch {}
      }
    },
    sendToPrimary: (c: string, ...args: unknown[]) => {
      requireIpc();
      const win = getPrimaryCodexWindow();
      if (!win || win.isDestroyed()) return false;
      try {
        win.webContents.send(ch(c), ...args);
        return true;
      } catch {
        return false;
      }
    },
    sendToRenderer: (webContentsId: number, c: string, ...args: unknown[]) => {
      requireIpc();
      const target = ownedCodexRenderer(webContentsId);
      if (!target) return false;
      try {
        target.send(ch(c), ...args);
        return true;
      } catch {
        return false;
      }
    },
    invoke: (_c: string) => {
      throw new Error("ipc.invoke is renderer→main; main side uses handle");
    },
    handle: (c: string, handler: (...args: unknown[]) => unknown) => {
      requireIpc();
      const channel = ch(c);
      const registration = Symbol(channel);
      // Main tweaks are stopped and reloaded in place. Remove an old handler
      // before registering its replacement so a settings reload cannot fail
      // with Electron's "handler already registered" error.
      try { ipcMain.removeHandler(channel); } catch {}
      mainIpcHandlerRegistrations.set(channel, registration);
      const invokeHandler = async (...args: unknown[]) => handler(...args);
      ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => invokeHandler(...args));
      if (id === "co.tweakers.projects" && c === "projects") {
        mainTweakReadHandlers.set(`${id}:${c}`, invokeHandler);
      }
      return () => {
        if (mainIpcHandlerRegistrations.get(channel) !== registration) return;
        mainIpcHandlerRegistrations.delete(channel);
        if (mainTweakReadHandlers.get(`${id}:${c}`) === invokeHandler) mainTweakReadHandlers.delete(`${id}:${c}`);
        try { ipcMain.removeHandler(channel); } catch {}
      };
    },
    handleWithContext: (
      c: string,
      handler: (
        context: Readonly<{ sender: Readonly<{ webContentsId: number }> }>,
        ...args: unknown[]
      ) => unknown,
    ) => {
      requireIpc();
      const channel = ch(c);
      const registration = Symbol(channel);
      try { ipcMain.removeHandler(channel); } catch {}
      mainIpcHandlerRegistrations.set(channel, registration);
      mainTweakReadHandlers.delete(`${id}:${c}`);
      ipcMain.handle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
        const sender = ownedCodexRenderer(event.sender.id);
        if (!sender || sender !== event.sender) {
          throw new Error("IPC invoke sender is not an owned Codex renderer");
        }
        const context = Object.freeze({
          sender: Object.freeze({ webContentsId: sender.id }),
        });
        return handler(context, ...args);
      });
      return () => {
        if (mainIpcHandlerRegistrations.get(channel) !== registration) return;
        mainIpcHandlerRegistrations.delete(channel);
        try { ipcMain.removeHandler(channel); } catch {}
      };
    },
  };
}

function ownedCodexRenderer(webContentsId: number): Electron.WebContents | null {
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return null;
  const target = webContents.fromId(webContentsId);
  if (!target || target.isDestroyed()) return null;
  const owner = BrowserWindow.fromWebContents(target);
  if (!owner || owner.isDestroyed() || owner.webContents !== target) return null;
  return BrowserWindow.getAllWindows().some((window) => window === owner) ? target : null;
}

function makeMainFs(id: string) {
  const dir = join(userRoot!, "tweak-data", id);
  mkdirSync(dir, { recursive: true });
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  return {
    dataDir: dir,
    read: (p: string) => fs.readFile(join(dir, p), "utf8"),
    write: (p: string, c: string) => fs.writeFile(join(dir, p), c, "utf8"),
    exists: async (p: string) => {
      try {
        await fs.access(join(dir, p));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function currentRuntimeInfo(): CodexRuntimeInfo {
  const installerState = readInstallerState();
  return getRuntimeInfo({
    userRoot: userRoot!,
    runtimeDir: runtimeDir!,
    codexVersion: installerState?.codexVersion ?? null,
    channel: null,
    getWindowServices: getCodexWindowServices,
  });
}

function currentRuntimeCapabilities(): CodexRuntimeCapabilities {
  const installerState = readInstallerState();
  return getRuntimeCapabilities({
    userRoot: userRoot!,
    runtimeDir: runtimeDir!,
    codexVersion: installerState?.codexVersion ?? null,
    channel: null,
    getWindowServices: getCodexWindowServices,
    getNativeCapabilities: () => nativeBridge.getCapabilities(),
    getViewCapabilities: () => getOwlViewCapabilities(),
  });
}

function tweakContext(tweakId: string, permission?: TweakPermission): NativeTweakContext {
  const tweak = permission
    ? assertTweakPermissionForId(tweakId, permission)
    : tweakById(tweakId);
  return { id: tweak.manifest.id, dir: tweak.dir };
}

function tweakById(tweakId: string): DiscoveredTweak {
  assertTweakId(tweakId);
  const tweak = tweakState.discovered.find((item) => item.manifest.id === tweakId);
  if (!tweak) throw new Error(`unknown tweak: ${tweakId}`);
  if (!isTweakEnabled(tweakId)) throw new Error(`tweak is disabled: ${tweakId}`);
  return tweak;
}

function assertTweakPermissionForId(tweakId: string, permission: TweakPermission): DiscoveredTweak {
  const tweak = tweakById(tweakId);
  assertTweakPermission(tweak, permission);
  return tweak;
}

function assertTweakViewPermissionForId(tweakId: string): DiscoveredTweak {
  const tweak = tweakById(tweakId);
  assertTweakViewPermission(tweak);
  return tweak;
}

function assertTweakPermission(tweak: DiscoveredTweak, permission: TweakPermission): void {
  if (tweak.manifest.permissions?.includes(permission)) return;
  throw new Error(`tweak ${tweak.manifest.id} must declare ${permission} permission`);
}

function assertTweakViewPermission(tweak: DiscoveredTweak): void {
  if (
    tweak.manifest.permissions?.includes("codex-views") ||
    tweak.manifest.permissions?.includes("codex.views")
  ) {
    return;
  }
  throw new Error(`tweak ${tweak.manifest.id} must declare codex-views permission`);
}

function assertTweakId(tweakId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(tweakId)) throw new Error("bad tweak id");
}

function getPrimaryCodexWindow(): Electron.BrowserWindow | null {
  const services = getCodexWindowServices();
  const fromServices = typeof services?.getPrimaryWindow === "function"
    ? services.getPrimaryWindow("local")
    : null;
  if (fromServices && !fromServices.isDestroyed()) return fromServices;
  const fromManager = typeof services?.windowManager?.getPrimaryWindow === "function"
    ? services.windowManager.getPrimaryWindow.call(services.windowManager)
    : null;
  if (fromManager && !fromManager.isDestroyed()) return fromManager;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
}

function getPrimaryCodexWindowRef(): CodexWindowRef | null {
  const win = getPrimaryCodexWindow();
  if (!win || win.isDestroyed()) return null;
  return { windowId: win.id, webContentsId: win.webContents.id };
}

function focusCodexWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function showCodexWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  win.show();
  return true;
}

const APPLE_PRIVACY_PANES: Record<"screen-recording" | "accessibility" | "input-monitoring", string> = {
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "input-monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

const MAX_APPSHOT_PIXELS = 16_000_000;
const MAX_APPSHOT_BYTES = 20 * 1024 * 1024;
const DEFAULT_APPSHOT_TEXT_LIMIT = 100_000;

async function getCapturePermissionStatus(): Promise<CodexPermissionStatus> {
  if (process.platform !== "darwin") {
    return {
      screenRecording: "unknown",
      accessibility: "denied",
      inputMonitoring: "unknown",
      restartRequired: false,
    };
  }
  return {
    screenRecording: normalizeScreenStatus(systemPreferences.getMediaAccessStatus("screen")),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    inputMonitoring: "unknown",
    restartRequired: false,
  };
}

function normalizeScreenStatus(value: string): CodexPermissionStatus["screenRecording"] {
  if (value === "granted" || value === "denied" || value === "restricted" || value === "not-determined") return value;
  return "unknown";
}

async function openPermissionSettings(kind: "screen-recording" | "accessibility" | "input-monitoring"): Promise<void> {
  if (process.platform !== "darwin") return;
  await shell.openExternal(APPLE_PRIVACY_PANES[kind]);
}

async function captureFrontmostWindow(options: { includeAccessibilityText?: boolean; maxTextCharacters?: number } = {}): Promise<FrontmostWindowCapture> {
  const frontmost = await readFrontmostWindowInfo(Math.max(0, Math.min(options.maxTextCharacters ?? DEFAULT_APPSHOT_TEXT_LIMIT, DEFAULT_APPSHOT_TEXT_LIMIT)));
  const source = await findDesktopSourceForFrontmost(frontmost);
  if (!source) throw new Error("frontmost window was not available to Electron capture");
  const image = source.thumbnail.toPNG();
  if (image.length > MAX_APPSHOT_BYTES) throw new Error("frontmost window capture exceeded the AppShots byte limit");
  const size = source.thumbnail.getSize();
  if (size.width * size.height > MAX_APPSHOT_PIXELS) throw new Error("frontmost window capture exceeded the AppShots pixel limit");
  return {
    captureId: randomUUID(),
    capturedAt: new Date().toISOString(),
    app: {
      name: frontmost.appName || "Unknown",
      bundleIdentifier: frontmost.bundleIdentifier,
      pid: frontmost.pid,
    },
    window: {
      id: Number(source.id.replace(/^window:/, "").split(":")[0]) || 0,
      title: frontmost.windowTitle || source.name || null,
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
    },
    image: {
      mimeType: "image/png",
      dataBase64: image.toString("base64"),
      width: size.width,
      height: size.height,
      byteLength: image.length,
    },
    accessibility: options.includeAccessibilityText === false
      ? { status: "unavailable", text: null, characterCount: 0 }
      : frontmost.accessibility,
  };
}

interface FrontmostWindowInfo {
  appName: string;
  bundleIdentifier: string | null;
  pid: number;
  windowTitle: string | null;
  accessibility: FrontmostWindowCapture["accessibility"];
}

async function readFrontmostWindowInfo(maxTextCharacters: number): Promise<FrontmostWindowInfo> {
  if (process.platform !== "darwin") {
    return {
      appName: "Unknown",
      bundleIdentifier: null,
      pid: -1,
      windowTitle: null,
      accessibility: { status: "unavailable", text: null, characterCount: 0 },
    };
  }
  const script = `
set maxChars to ${Math.max(0, Math.floor(maxTextCharacters))}
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set appName to name of frontProc as text
  set appPid to unix id of frontProc as integer
  set winTitle to ""
  set axText to ""
  try
    set winTitle to name of front window of frontProc as text
  end try
  try
    set rawText to value of entire contents of front window of frontProc
    set oldDelims to AppleScript's text item delimiters
    set AppleScript's text item delimiters to linefeed
    set axText to rawText as text
    set AppleScript's text item delimiters to oldDelims
  end try
end tell
set bundleId to ""
try
  tell application "System Events" to set bundleId to bundle identifier of first application process whose frontmost is true
end try
if maxChars > 0 and length of axText > maxChars then set axText to text 1 thru maxChars of axText
return appName & linefeed & appPid & linefeed & bundleId & linefeed & winTitle & linefeed & axText
`;
  try {
    const { stdout } = await execFileResult("/usr/bin/osascript", ["-e", script], 3_000, 512 * 1024);
    const [appName = "Unknown", pidText = "-1", bundleIdentifier = "", windowTitle = "", ...textLines] = stdout.split(/\r?\n/);
    const text = normalizeAccessibilityText(textLines.join("\n"));
    const status = text ? (text.length >= maxTextCharacters && maxTextCharacters > 0 ? "truncated" : "captured") : "unavailable";
    return {
      appName: appName.trim() || "Unknown",
      bundleIdentifier: bundleIdentifier.trim() || null,
      pid: Number(pidText) || -1,
      windowTitle: windowTitle.trim() || null,
      accessibility: { status, text: text || null, characterCount: text.length },
    };
  } catch (error) {
    return {
      appName: "Unknown",
      bundleIdentifier: null,
      pid: -1,
      windowTitle: null,
      accessibility: {
        status: systemPreferences.isTrustedAccessibilityClient(false) ? "unavailable" : "permission-denied",
        text: null,
        characterCount: 0,
      },
    };
  }
}

function normalizeAccessibilityText(value: string): string {
  const lines = value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...new Set(lines)].join("\n");
}

async function findDesktopSourceForFrontmost(frontmost: FrontmostWindowInfo): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 4096, height: 4096 },
    fetchWindowIcons: false,
  });
  const title = compactSourceName(frontmost.windowTitle);
  const appName = compactSourceName(frontmost.appName);
  return sources.find((source) => title && compactSourceName(source.name).includes(title))
    ?? sources.find((source) => appName && compactSourceName(source.name).includes(appName))
    ?? sources.find((source) => !/ChatGPT|Codex/i.test(source.name))
    ?? sources[0]
    ?? null;
}

function compactSourceName(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function registerCaptureHotkey(
  tweak: DiscoveredTweak,
  options: { preferred?: "DoubleCommand"; fallbackAccelerator: string; suppressNativeAppshots?: boolean },
  listener: () => void,
): Promise<CodexHotkeyRegistration> {
  assertTweakPermission(tweak, "global-shortcut");
  const accelerator = typeof options.fallbackAccelerator === "string" && options.fallbackAccelerator.trim()
    ? options.fallbackAccelerator.trim()
    : "Command+Shift+2";
  await app.whenReady();
  if (!globalShortcut.register(accelerator, listener)) {
    throw new Error(`Could not register AppShots shortcut: ${accelerator}`);
  }
  return {
    active: "fallback",
    unregister: async () => {
      try { globalShortcut.unregister(accelerator); } catch {}
    },
  };
}

function getOwlViewCapabilities(): CodexRuntimeCapabilities["views"] {
  const parent = getPrimaryCodexWindow() ?? BrowserWindow.getFocusedWindow();
  const contentView = asRecord(parent)?.contentView;
  let sampleView: Electron.BrowserView | null = null;
  try {
    sampleView = new BrowserView({ webPreferences: { sandbox: true } });
  } catch {}
  const webContentsView = asRecord(sampleView)?.webContentsView;
  const privateViewTree = typeof asRecord(contentView)?.addChildView === "function" &&
    typeof asRecord(contentView)?.removeChildView === "function";
  const webContentsViewAvailable = Boolean(webContentsView) &&
    typeof asRecord(webContentsView)?.setBounds === "function";
  const privateAttach = privateViewTree && webContentsViewAvailable;
  const browserViewFallback = typeof asRecord(parent)?.addBrowserView === "function";
  try {
    if (sampleView && !sampleView.webContents.isDestroyed()) {
      sampleView.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {}
  return {
    create: privateAttach || browserViewFallback,
    privateViewTree: privateAttach,
    webContentsView: webContentsViewAvailable,
    browserViewFallback,
  };
}

async function createOwlView(
  ctx: NativeTweakContext,
  opts: CodexViewCreateOptions,
): Promise<CodexViewRef> {
  const id = assertBridgeId(opts.id ?? randomUUID(), "Codex view id");
  const key = owlViewKey(ctx.id, id);
  if (owlViews.has(key)) throw new Error(`Codex view already exists: ${ctx.id}:${id}`);

  const parent = typeof opts.parentWindowId === "number"
    ? BrowserWindow.fromId(opts.parentWindowId)
    : getPrimaryCodexWindow();
  if (!parent || isWindowDestroyed(parent)) {
    throw new Error("Codex view needs an active parent window");
  }

  const services = getCodexWindowServices();
  const windowManager = services?.windowManager;
  const route = opts.route === undefined ? null : normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const view = new BrowserView({
    webPreferences: {
      preload: opts.registerWithCodex === false ? undefined : windowManager?.options?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowManager?.options?.allowDevtools,
    },
  });

  if (opts.backgroundColor) {
    callObjectMethod(view, "setBackgroundColor", [opts.backgroundColor]);
    callObjectMethod(asRecord(view)?.webContentsView, "setBackgroundColor", [opts.backgroundColor]);
  }

  const managed: ManagedOwlView = {
    key,
    tweakId: ctx.id,
    id,
    view,
    parentWindowId: windowIdFor(parent),
    attachMode: null,
    disposeBindings: [],
    disposed: false,
  };
  owlViews.set(key, managed);

  try {
    if (route !== null && opts.registerWithCodex !== false && windowManager?.registerWindow) {
      const appearance = opts.appearance || "secondary";
      const windowLike = makeWindowLikeForView(view);
      windowManager.registerWindow(windowLike, hostId, false, appearance);
      services?.getContext?.(hostId)?.registerWindow?.(windowLike);
    }

    attachOwlView(managed, parent);
    if (opts.bounds) setOwlViewBounds(managed, opts.bounds);
    if (opts.visible === false) setOwlViewVisible(managed, false);

    if (route !== null) {
      await view.webContents.loadURL(codexAppUrl(route, hostId));
    } else if (opts.url) {
      await view.webContents.loadURL(normalizeOwlViewUrl(opts.url));
    } else {
      await view.webContents.loadURL("about:blank");
    }
  } catch (e) {
    disposeOwlView(managed);
    throw e;
  }

  log("info", `created Owl view ${ctx.id}:${id}`, {
    parentWindowId: managed.parentWindowId,
    webContentsId: view.webContents.id,
    attachMode: managed.attachMode,
  });
  return owlViewRef(managed);
}

async function callOwlView(
  tweakId: string,
  id: string,
  method: string,
  arg?: unknown,
  arg2?: unknown,
): Promise<unknown> {
  const view = owlViewFor(tweakId, id);
  if (method === "setBounds") return setOwlViewBounds(view, arg as Electron.Rectangle);
  if (method === "setVisible") return setOwlViewVisible(view, Boolean(arg));
  if (method === "bringToFront") return bringOwlViewToFront(view);
  if (method === "loadRoute") {
    const route = normalizeCodexRoute(String(arg));
    const hostId = typeof arg2 === "string" && arg2 ? arg2 : "local";
    return view.view.webContents.loadURL(codexAppUrl(route, hostId));
  }
  if (method === "loadUrl") return view.view.webContents.loadURL(normalizeOwlViewUrl(String(arg)));
  if (method === "dispose") return disposeOwlViewById(tweakId, id);
  throw new Error(`unknown Codex view method: ${method}`);
}

function owlViewRef(view: ManagedOwlView): CodexViewRef {
  return {
    id: view.id,
    webContentsId: view.view.webContents.id,
    parentWindowId: view.parentWindowId,
    setBounds: (bounds) => Promise.resolve(setOwlViewBounds(view, bounds)),
    setVisible: (visible) => Promise.resolve(setOwlViewVisible(view, visible)),
    bringToFront: () => Promise.resolve(bringOwlViewToFront(view)),
    loadRoute: (route, hostId) => view.view.webContents.loadURL(codexAppUrl(normalizeCodexRoute(route), hostId || "local")).then(() => {}),
    loadUrl: (url) => view.view.webContents.loadURL(normalizeOwlViewUrl(url)).then(() => {}),
    dispose: () => Promise.resolve(disposeOwlViewById(view.tweakId, view.id)),
  };
}

function attachOwlView(view: ManagedOwlView, parent: Electron.BrowserWindow): void {
  const contentView = asRecord(parent)?.contentView;
  const webContentsView = asRecord(view.view)?.webContentsView;
  if (typeof asRecord(parent)?.addBrowserView === "function") {
    callObjectMethod(parent, "addBrowserView", [view.view]);
    view.attachMode = "browserView";
  } else if (
    typeof asRecord(contentView)?.addChildView === "function" &&
    webContentsView
  ) {
    try {
      addOwlChildView(parent, view.view);
      view.attachMode = "contentView";
    } catch (e) {
      log("warn", "Owl contentView attachment failed; falling back to BrowserView", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  if (!view.attachMode) {
    throw new Error("Owl view attachment is not available on this Codex window");
  }

  const dispose = () => disposeOwlViewById(view.tweakId, view.id);
  bindWindowEvent(parent, view, "closed", dispose);
  bindWindowEvent(parent, view, "close", dispose);
}

function bringOwlViewToFront(view: ManagedOwlView): void {
  if (view.disposed) return;
  const parent = view.parentWindowId === null ? null : BrowserWindow.fromId(view.parentWindowId);
  if (!parent || isWindowDestroyed(parent)) return;
  const contentView = asRecord(parent)?.contentView;
  const webContentsView = asRecord(view.view)?.webContentsView;
  if (view.attachMode === "contentView" && webContentsView) {
    try {
      if (typeof asRecord(parent)?.setTopBrowserView === "function") {
        callObjectMethod(parent, "setTopBrowserView", [view.view]);
      } else {
        callObjectMethod(contentView, "addChildView", [webContentsView]);
      }
      return;
    } catch (e) {
      log("warn", "Owl contentView bring-to-front failed", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  if (typeof asRecord(parent)?.setTopBrowserView === "function") {
    callObjectMethod(parent, "setTopBrowserView", [view.view]);
  }
}

function setOwlViewBounds(view: ManagedOwlView, bounds: Electron.Rectangle): void {
  assertBounds(bounds);
  callObjectMethod(view.view, "setBounds", [bounds]);
  callObjectMethod(asRecord(view.view)?.webContentsView, "setBounds", [bounds]);
}

function setOwlViewVisible(view: ManagedOwlView, visible: boolean): void {
  callObjectMethod(asRecord(view.view)?.webContentsView, "setVisible", [visible]);
}

function disposeOwlViewById(tweakId: string, id: string): void {
  const view = owlViews.get(owlViewKey(tweakId, id));
  if (!view) return;
  disposeOwlView(view);
}

function disposeOwlViewsForTweak(tweakId: string): void {
  for (const view of [...owlViews.values()]) {
    if (view.tweakId === tweakId) disposeOwlView(view);
  }
}

function disposeAllOwlViews(): void {
  for (const view of [...owlViews.values()]) disposeOwlView(view);
}

function disposeOwlView(view: ManagedOwlView): void {
  if (view.disposed) return;
  view.disposed = true;
  owlViews.delete(view.key);
  for (const dispose of view.disposeBindings.splice(0)) {
    try {
      dispose();
    } catch {}
  }
  const parent = view.parentWindowId === null ? null : BrowserWindow.fromId(view.parentWindowId);
  if (parent && !isWindowDestroyed(parent)) {
    try {
      if (view.attachMode === "contentView") {
        removeOwlChildView(parent, view.view);
      } else if (view.attachMode === "browserView") {
        callObjectMethod(parent, "removeBrowserView", [view.view]);
      }
    } catch (e) {
      log("warn", "Owl view detach failed during dispose", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  try {
    if (!view.view.webContents.isDestroyed()) {
      view.view.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {}
}

function owlViewFor(tweakId: string, id: string): ManagedOwlView {
  const view = owlViews.get(owlViewKey(tweakId, id));
  if (!view || view.disposed) throw new Error(`Codex view is not loaded: ${tweakId}:${id}`);
  return view;
}

function owlViewKey(tweakId: string, viewId: string): string {
  return `${tweakId}:${viewId}`;
}

function addOwlChildView(parent: Electron.BrowserWindow, child: Electron.BrowserView): void {
  const ownerWindow = asRecord(child)?.ownerWindow;
  if (ownerWindow && ownerWindow !== parent) {
    callObjectMethod(ownerWindow, "removeBrowserView", [child]);
  }

  callObjectMethod(asRecord(parent)?.contentView, "addChildView", [asRecord(child)?.webContentsView]);
  try {
    (child as unknown as { ownerWindow: Electron.BrowserWindow | null }).ownerWindow = parent;
  } catch {}
  callObjectMethod(asRecord(child.webContents), "_setOwnerWindow", [parent]);

  const browserViews = asRecord(parent)?._browserViews;
  if (Array.isArray(browserViews) && !browserViews.includes(child)) {
    browserViews.push(child);
  }
}

function removeOwlChildView(parent: Electron.BrowserWindow, child: Electron.BrowserView): void {
  callObjectMethod(asRecord(parent)?.contentView, "removeChildView", [asRecord(child)?.webContentsView]);
  try {
    (child as unknown as { ownerWindow: Electron.BrowserWindow | null }).ownerWindow = null;
  } catch {}

  const browserViews = asRecord(parent)?._browserViews;
  if (Array.isArray(browserViews)) {
    const index = browserViews.indexOf(child);
    if (index >= 0) browserViews.splice(index, 1);
  }
}

async function createCodexBrowserView(opts: CodexCreateViewOptions): Promise<unknown> {
  const services = getCodexWindowServices();
  const windowManager = services?.windowManager;
  if (!services || !windowManager?.registerWindow) {
    throw new Error(
      "Codex embedded view services are not available. Reinstall Tweakers 1.0.0 or later.",
    );
  }

  const route = normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const appearance = opts.appearance || "secondary";
  const view = new BrowserView({
    webPreferences: {
      preload: windowManager.options?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowManager.options?.allowDevtools,
    },
  });
  const windowLike = makeWindowLikeForView(view);
  windowManager.registerWindow(windowLike, hostId, false, appearance);
  services.getContext?.(hostId)?.registerWindow?.(windowLike);
  await view.webContents.loadURL(codexAppUrl(route, hostId));
  return view;
}

async function createCodexWindow(opts: CodexCreateWindowOptions): Promise<CodexWindowRef> {
  const services = getCodexWindowServices();
  if (!services) {
    throw new Error(
      "Codex window services are not available. Reinstall Tweakers 1.0.0 or later.",
    );
  }

  const route = normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const parent = typeof opts.parentWindowId === "number"
    ? BrowserWindow.fromId(opts.parentWindowId)
    : BrowserWindow.getFocusedWindow();
  const createWindow = services.windowManager?.createWindow;

  let win: Electron.BrowserWindow | null | undefined;
  if (typeof createWindow === "function") {
    win = await createWindow.call(services.windowManager, {
      initialRoute: route,
      hostId,
      show: opts.show !== false,
      appearance: opts.appearance || "secondary",
      parent,
    });
  } else if (hostId === "local" && typeof services.createFreshWindow === "function") {
    win = await services.createFreshWindow(route);
  } else if (hostId === "local" && typeof services.createFreshLocalWindow === "function") {
    win = await services.createFreshLocalWindow(route);
  } else if (typeof services.ensureHostWindow === "function") {
    win = await services.ensureHostWindow(hostId);
  }

  if (!win || win.isDestroyed()) {
    throw new Error("Codex did not return a window for the requested route");
  }

  if (opts.bounds) {
    win.setBounds(opts.bounds);
  }
  if (parent && !parent.isDestroyed()) {
    try {
      win.setParentWindow(parent);
    } catch {}
  }
  if (opts.show !== false) {
    win.show();
  }

  return {
    windowId: win.id,
    webContentsId: win.webContents.id,
  };
}

function makeCodexApi(tweak: DiscoveredTweak) {
  const ctx = (): NativeTweakContext => ({ id: tweak.manifest.id, dir: tweak.dir });
  return {
    runtime: {
      getInfo: async () => currentRuntimeInfo(),
      getCapabilities: async () => currentRuntimeCapabilities(),
    },
    windows: {
      create: createCodexWindow,
      getPrimary: async () => getPrimaryCodexWindowRef(),
      focus: async (windowId: number) => focusCodexWindow(windowId),
      show: async (windowId: number) => showCodexWindow(windowId),
    },
    views: {
      create: async (options: CodexViewCreateOptions) => {
        assertTweakViewPermission(tweak);
        return createOwlView(ctx(), options);
      },
    },
    cdp: {
      getStatus: async () => getCdpStatus(),
      listTargets: async () => listCdpTargets(),
    },
    native: {
      loadModule: async (options: NativeModuleLoadOptions) => {
        assertTweakPermission(tweak, "native-module");
        return nativeBridge.loadModule(ctx(), options);
      },
      createPanel: async (options: NativePanelCreateOptions) => {
        assertTweakPermission(tweak, "native-view");
        return nativeBridge.createPanel(ctx(), options);
      },
      attachView: async (options: NativeViewAttachOptions) => {
        assertTweakPermission(tweak, "native-view");
        return nativeBridge.attachView(ctx(), options);
      },
      launchHelper: async (options: NativeHelperLaunchOptions) => {
        assertTweakPermission(tweak, "native-helper");
        return nativeBridge.launchHelper(ctx(), options);
      },
    },
    refresh: {
      getStatus: async () => localRefreshStatus(),
      start: async (source?: "smart" | "development" | "stable") => {
        const status = await localRefreshStatus();
        if (!status.available) return { started: false, status };
        const cli = localRefreshCli(status);
        const appRoot = readInstallerState()?.appRoot;
        if (!appRoot || !existsSync(cli)) throw new Error("Tweakers refresh CLI is unavailable");
        startInstalledCli(cli, ["refresh-local", "--source", source ?? "smart", "--app", appRoot]);
        return { started: true, status: { ...status, phase: "preparing" } };
      },
      onStatusChanged: () => () => {},
    },
    capture: {
      getPermissionStatus: async () => {
        assertTweakPermission(tweak, "screen-capture");
        return getCapturePermissionStatus();
      },
      requestAccessibility: async () => {
        assertTweakPermission(tweak, "accessibility");
        return process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(true) : false;
      },
      openPermissionSettings: async (kind: "screen-recording" | "accessibility" | "input-monitoring") => {
        if (kind === "screen-recording") assertTweakPermission(tweak, "screen-capture");
        if (kind === "accessibility") assertTweakPermission(tweak, "accessibility");
        if (kind === "input-monitoring") assertTweakPermission(tweak, "global-shortcut");
        return openPermissionSettings(kind);
      },
      captureFrontmostWindow: async (options?: { includeAccessibilityText?: boolean; maxTextCharacters?: number }) => {
        assertTweakPermission(tweak, "screen-capture");
        if (options?.includeAccessibilityText !== false) assertTweakPermission(tweak, "accessibility");
        return captureFrontmostWindow(options);
      },
    },
    hotkeys: {
      registerCaptureHotkey: (options: { preferred?: "DoubleCommand"; fallbackAccelerator: string; suppressNativeAppshots?: boolean }, listener: () => void) =>
        registerCaptureHotkey(tweak, options, listener),
    },
    createBrowserView: createCodexBrowserView,
    createWindow: createCodexWindow,
  };
}

function makeWindowLikeForView(view: Electron.BrowserView): CodexWindowLike {
  const viewBounds = () => view.getBounds();
  return {
    id: view.webContents.id,
    webContents: view.webContents,
    on: (event: "closed", listener: () => void) => {
      if (event === "closed") {
        view.webContents.once("destroyed", listener);
      } else {
        view.webContents.on(event, listener);
      }
      return view;
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.once(event as "destroyed", listener);
      return view;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.off(event as "destroyed", listener);
      return view;
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.removeListener(event as "destroyed", listener);
      return view;
    },
    isDestroyed: () => view.webContents.isDestroyed(),
    isFocused: () => view.webContents.isFocused(),
    focus: () => view.webContents.focus(),
    show: () => {},
    hide: () => {},
    getBounds: viewBounds,
    getContentBounds: viewBounds,
    getSize: () => {
      const b = viewBounds();
      return [b.width, b.height];
    },
    getContentSize: () => {
      const b = viewBounds();
      return [b.width, b.height];
    },
    setTitle: () => {},
    getTitle: () => "",
    setRepresentedFilename: () => {},
    setDocumentEdited: () => {},
    setWindowButtonVisibility: () => {},
  };
}

function codexAppUrl(route: string, hostId: string): string {
  const url = new URL("app://-/index.html");
  url.searchParams.set("hostId", hostId);
  if (route !== "/") url.searchParams.set("initialRoute", route);
  return url.toString();
}

function normalizeOwlViewUrl(url: string): string {
  if (typeof url !== "string" || url.includes("\n") || url.includes("\r")) {
    throw new Error("Owl view URL must be a string without control characters");
  }
  const parsed = new URL(url);
  if (!["http:", "https:", "app:", "file:", "data:", "about:"].includes(parsed.protocol)) {
    throw new Error(`unsupported Owl view URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function getCodexWindowServices(): CodexWindowServices | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  const services = globals[CODEX_WINDOW_SERVICES_KEY] ?? globals[LEGACY_WINDOW_SERVICES_KEY];
  return services && typeof services === "object" ? (services as CodexWindowServices) : null;
}

function normalizeCodexRoute(route: string): string {
  if (typeof route !== "string" || !route.startsWith("/")) {
    throw new Error("Codex route must be an absolute app route");
  }
  if (route.includes("://") || route.includes("\n") || route.includes("\r")) {
    throw new Error("Codex route must not include a protocol or control characters");
  }
  return route;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function callObjectMethod(target: unknown, method: string, args: unknown[]): unknown {
  const fn = asRecord(target)?.[method];
  if (typeof fn !== "function") return undefined;
  return fn.apply(target, args);
}

function isWindowDestroyed(win: Electron.BrowserWindow | null | undefined): boolean {
  if (!win) return true;
  const fn = asRecord(win)?.isDestroyed;
  if (typeof fn !== "function") return false;
  try {
    return Boolean(fn.call(win));
  } catch {
    return true;
  }
}

function windowIdFor(win: Electron.BrowserWindow | null | undefined): number | null {
  const id = asRecord(win)?.id;
  return typeof id === "number" ? id : null;
}

function bindWindowEvent(
  win: Electron.BrowserWindow,
  view: ManagedOwlView,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  const on = asRecord(win)?.on;
  const off = asRecord(win)?.off;
  if (typeof on !== "function") return;
  on.call(win, event, listener);
  view.disposeBindings.push(() => {
    if (typeof off === "function") off.call(win, event, listener);
    else callObjectMethod(win, "removeListener", [event, listener]);
  });
}

function assertBridgeId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} may only contain letters, numbers, dots, underscores, and dashes`);
  }
  return value;
}

function assertBounds(bounds: Electron.Rectangle): void {
  const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("bounds must contain finite x, y, width, and height numbers");
  }
  if (bounds.width < 0 || bounds.height < 0) {
    throw new Error("bounds width and height must be non-negative");
  }
}

// Touch BrowserWindow to keep its import — older Electron lint rules.
void BrowserWindow;

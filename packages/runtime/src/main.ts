/**
 * Main-process bootstrap. Loaded by the asar loader before Codex's own
 * main process code runs. We hook `BrowserWindow` so every window Codex
 * creates gets our preload script attached. We also stand up an IPC
 * channel for tweaks to talk to the main process.
 *
 * We are in CJS land here (matches Electron's main process and Codex's own
 * code). The renderer-side runtime is bundled separately into preload.js.
 */
import { app, BrowserView, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, session, shell, systemPreferences, webContents } from "electron";
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
import { switchAppMode } from "./app-mode";
import { syncManagedMcpServers } from "./mcp-sync";
import { getWatcherHealth } from "./watcher-health";
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

// Tweakers is the public name. Keep the Tweakers variables as compatibility
// aliases so existing patched apps and user data continue to boot.
const userRoot = process.env.TWEAKERS_USER_ROOT ?? process.env.CODEX_PLUSPLUS_USER_ROOT;
const runtimeDir = process.env.TWEAKERS_RUNTIME ?? process.env.CODEX_PLUSPLUS_RUNTIME;

if (!userRoot || !runtimeDir) {
  throw new Error(
    "Tweakers runtime started without TWEAKERS_USER_ROOT/RUNTIME (or legacy CODEX_PLUS_PLUS aliases) envs",
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
const CODEX_PLUSPLUS_VERSION = "1.0.0";
const CODEX_PLUSPLUS_REPO = "therealityreport/tweakers";
const TWEAK_STORE_INDEX_URL = process.env.CODEX_PLUSPLUS_STORE_INDEX_URL ?? DEFAULT_TWEAK_STORE_INDEX_URL;
const CODEX_WINDOW_SERVICES_KEY = "__codexpp_window_services__";
const mainTweakReadHandlers = new Map<string, (...args: unknown[]) => unknown>();

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(TWEAKS_DIR, { recursive: true });
// One-time migration: the retired mode-switcher tweak persisted a soft
// vanilla mode; app modes are now real bundle swaps owned by the installer
// (`tweakers mode`). Drop the stale key so it can never gate tweaks again.
removeLegacyModeSwitcherState(userRoot);
const refreshStatusWatcher = chokidar.watch([
  SELF_UPDATE_STATE_FILE,
  join(userRoot, "refresh-state.json"),
  CONFIG_FILE,
], { ignoreInitial: true });
refreshStatusWatcher.on("all", () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("codexpp:refresh-status-changed");
});
app.once("will-quit", () => { void refreshStatusWatcher.close(); });

// Optional: enable Chrome DevTools Protocol on a TCP port so we can drive the
// running Codex from outside (curl http://localhost:<port>/json, attach via
// CDP WebSocket, take screenshots, evaluate in renderer, etc.). Codex's
// production build sets webPreferences.devTools=false, which kills the
// in-window DevTools shortcut, but `--remote-debugging-port` works regardless
// because it's a Chromium command-line switch processed before app init.
//
// Off by default. Set CODEXPP_REMOTE_DEBUG=1 (optionally CODEXPP_REMOTE_DEBUG_PORT)
// to turn it on. Must be appended before `app` becomes ready; we're at module
// top-level so that's fine.
if (process.env.CODEXPP_REMOTE_DEBUG === "1") {
  const port = process.env.CODEXPP_REMOTE_DEBUG_PORT ?? "9222";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  log("info", `remote debugging enabled on port ${port}`);
}

interface PersistedState {
  codexPlusPlus?: {
    autoUpdate?: boolean;
    safeMode?: boolean;
    updateChannel?: SelfUpdateChannel;
    updateRepo?: string;
    updateRef?: string;
    updateCheck?: CodexPlusPlusUpdateCheck;
    /** Managed whole-backend selection. Absence preserves a user-owned override. */
    codexCliLane?: CodexCliLane;
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
  };
  /** Per-tweak enable flags. Missing entries default to enabled. */
  tweaks?: Record<string, { enabled?: boolean }>;
  /** Cached GitHub release checks. Runtime never auto-installs updates. */
  tweakUpdateChecks?: Record<string, TweakUpdateCheck>;
  /** Last known load/health state for an installed tweak. */
  tweakHealth?: Record<string, TweakHealthRecord>;
}

interface CodexPlusPlusUpdateCheck {
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

function readState(): PersistedState {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PersistedState;
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
const codexCliBootstrap = applyManagedCodexCliLaneAtBootstrap({
  lane: readState().codexPlusPlus?.codexCliLane,
  home: homedir(),
  env: process.env,
  persistFailure: (message) => {
    const state = readState();
    state.codexPlusPlus ??= {};
    state.codexPlusPlus.codexCliBootstrapFailure = message;
    writeState(state);
  },
});

const CODEX_RELEASE_API = "https://api.github.com/repos/openai/codex/releases?per_page=100";
const MAX_CODEX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const CODEX_APPCAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let codexLaneChangedThisProcess = false;
let codexAppcastMetadata: SparkleAppcastMetadata | null = null;

const codexVersionService = createCodexVersionService({
  currentVersion: CODEX_PLUSPLUS_VERSION,
  now: Date.now,
  readReleaseCache: async (lane) => readState().codexPlusPlus?.codexReleaseCache?.[lane] ?? null,
  writeReleaseCache: async (lane, cache) => {
    const state = readState();
    state.codexPlusPlus ??= {};
    state.codexPlusPlus.codexReleaseCache ??= {};
    state.codexPlusPlus.codexReleaseCache[lane] = cache;
    writeState(state);
  },
  fetchReleases: async (signal) => {
    const response = await fetch(CODEX_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `tweakers/${CODEX_PLUSPLUS_VERSION}`,
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
  deps: createCodexCliManagerDependencies(),
});
codexCliManager.recover();

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
function isCodexPlusPlusAutoUpdateEnabled(): boolean {
  return readState().codexPlusPlus?.autoUpdate !== false;
}
function setCodexPlusPlusAutoUpdate(enabled: boolean): void {
  const s = readState();
  s.codexPlusPlus ??= {};
  s.codexPlusPlus.autoUpdate = enabled;
  writeState(s);
}
function setCodexPlusPlusUpdateConfig(config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}): void {
  const s = readState();
  s.codexPlusPlus ??= {};
  if (config.updateChannel) s.codexPlusPlus.updateChannel = config.updateChannel;
  if ("updateRepo" in config) s.codexPlusPlus.updateRepo = cleanOptionalString(config.updateRepo);
  if ("updateRef" in config) s.codexPlusPlus.updateRef = cleanOptionalString(config.updateRef);
  writeState(s);
}
function isCodexPlusPlusSafeModeEnabled(): boolean {
  return readState().codexPlusPlus?.safeMode === true;
}

function isTweakEnabled(id: string): boolean {
  const s = readState();
  if (s.codexPlusPlus?.safeMode === true) return false;
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

function recoverTweak(id: string): true {
  clearTweakHealth(id);
  return setTweakEnabledAndReload(id, true, tweakLifecycleDeps);
}

interface InstallerState {
  appRoot: string;
  codexVersion: string | null;
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
  if (level === "error") console.error("[codex-plusplus]", ...args);
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

  Module._load = function codexPlusPlusModuleLoad(request: string, parent: unknown, isMain: boolean) {
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

// Surface unhandled errors from anywhere in the main process to our log.
process.on("uncaughtException", (e: Error & { code?: string }) => {
  log("error", "uncaughtException", { code: e.code, message: e.message, stack: e.stack });
});
process.on("unhandledRejection", (e) => {
  log("error", "unhandledRejection", { value: String(e) });
});

configureCodexSparkleBridge({
  prepareForInstall: prepareSignedCodexForSparkleInstall,
  getInstallPrerequisite: codexDesktopInstallPrerequisiteFailure,
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

const nativeBridge = new NativeBridge(log, {
  nativeHostPath: join(runtimeDir, "native", "codexpp_native_host.node"),
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
  try {
    const reg = (s as unknown as {
      registerPreloadScript?: (opts: {
        type?: "frame" | "service-worker";
        id?: string;
        filePath: string;
      }) => string;
    }).registerPreloadScript;
    if (typeof reg === "function") {
      reg.call(s, { type: "frame", filePath: PRELOAD_PATH, id: "codex-plusplus" });
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
  if (isCodexPlusPlusSafeModeEnabled()) {
    log("warn", "safe mode is enabled; preload will not be registered");
    return;
  }
  registerPreload(session.defaultSession, "defaultSession");
  maybeStartBrowserUiServer({
    getWindowServices: getCodexWindowServices,
    log,
  });
});

app.on("session-created", (s) => {
  if (isCodexPlusPlusSafeModeEnabled()) return;
  registerPreload(s, "session-created");
});

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
if (isCodexPlusPlusSafeModeEnabled()) {
  log("warn", "safe mode is enabled; tweaks will not be loaded");
}

// 2. Initial tweak discovery + main-scope load.
// Defer tweak discovery/load off the synchronous module-eval path so the loader
// can proceed to OpenAI's main entrypoint immediately. setImmediate runs after
// the current require chain unwinds but BEFORE Electron's `ready` event, which
// preserves the pre-ready execution context these main-scope tweaks already run
// in today (so BrowserWindow/main hooks are installed before any window opens),
// while removing the synchronous startup stall. syncMcpServersFromEnabledTweaks
// is invoked inside loadAllMainTweaks, so it defers with it.
setImmediate(() => loadAllMainTweaks());

app.on("will-quit", () => {
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
ipcMain.handle("codexpp:list-tweaks", async () => {
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
ipcMain.on("codexpp:tweak-lifecycle", (_event, payload: unknown) => {
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
ipcMain.handle("codexpp:get-tweak-lifecycle", () => lifecycleJournal);
ipcMain.handle(
  "codexpp:cross-tweak-read",
  (_e, requester: unknown, target: unknown, action: unknown, message: unknown) =>
    dispatchCrossTweakRead(
      requester,
      target,
      action,
      message,
      (tweakId, channel) => mainTweakReadHandlers.get(`${tweakId}:${channel}`),
    ),
);

ipcMain.handle("codexpp:get-tweak-enabled", (_e, id: string) => isTweakEnabled(id));
ipcMain.handle("codexpp:set-tweak-enabled", (_e, id: string, enabled: boolean) => {
  return setTweakEnabledAndReload(id, enabled, tweakLifecycleDeps);
});
ipcMain.handle("codexpp:recover-tweak", (_e, id: string) => recoverTweak(id));
ipcMain.handle("codexpp:clear-tweak-health", (_e, id: string) => {
  clearTweakHealth(id);
  return true;
});

function bundledCodexBinary(): string {
  return join(process.resourcesPath, "codex");
}

function selectedCodexLane(): CodexCliLane {
  return readState().codexPlusPlus?.codexCliLane ?? codexCliBootstrap.effectiveLane;
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

function safeAppcastCacheUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function readPersistedCodexAppcast(desktopVersion: string | null): SparkleAppcastMetadata | null {
  if (!desktopVersion) return null;
  const cache = readState().codexPlusPlus?.codexAppcastCache;
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
  desktopVersion: string | null,
  metadata: SparkleAppcastMetadata,
): void {
  if (!desktopVersion || metadata.error || metadata.stale) return;
  const feedUrl = safeAppcastCacheUrl(metadata.feedUrl);
  const releaseUrl = metadata.releaseUrl === null ? null : safeAppcastCacheUrl(metadata.releaseUrl);
  if (!feedUrl || (metadata.releaseUrl !== null && !releaseUrl)) return;
  if (!metadata.marketingVersion.trim() || !metadata.build.trim() || !Number.isFinite(Date.parse(metadata.checkedAt))) return;
  const state = readState();
  state.codexPlusPlus ??= {};
  state.codexPlusPlus.codexAppcastCache = {
    schemaVersion: 1,
    desktopVersion,
    marketingVersion: metadata.marketingVersion,
    build: metadata.build,
    releaseUrl,
    feedUrl,
    checkedAt: metadata.checkedAt,
  };
  writeState(state);
}

async function getCodexVersionsSnapshot(force: boolean): Promise<CodexVersionsSnapshot> {
  const selectedLane = selectedCodexLane();
  const betaPath = codexCliManager.getSelectedBinary();
  const installedDesktop = installedCodexDesktopVersion();
  const desktopCacheKey = installedDesktop.installedMarketingVersion
    ? `${installedDesktop.installedMarketingVersion}:${installedDesktop.installedBuild ?? ""}`
    : null;
  const persistedAppcast = readPersistedCodexAppcast(desktopCacheKey);
  if (!codexAppcastMetadata && persistedAppcast) codexAppcastMetadata = persistedAppcast;
  const [bundledProbe, betaProbe, bundledRelease, betaRelease, refreshedAppcast] = await Promise.all([
    codexVersionService.probeCli(bundledCodexBinary()),
    betaPath ? codexVersionService.probeCli(betaPath) : Promise.resolve(null),
    force
      ? codexVersionService.fetchLatestRelease("bundled", { force: true })
      : codexVersionService.readCachedRelease("bundled"),
    force
      ? codexVersionService.fetchLatestRelease("beta", { force: true })
      : codexVersionService.readCachedRelease("beta"),
    force ? getCodexSparkleBridge().fetchAppcastMetadata() : Promise.resolve(null),
  ]);
  if (refreshedAppcast) {
    if (!refreshedAppcast.error && !refreshedAppcast.stale) {
      codexAppcastMetadata = refreshedAppcast;
      persistCodexAppcast(desktopCacheKey, refreshedAppcast);
    } else if (codexAppcastMetadata || persistedAppcast) {
      codexAppcastMetadata = {
        ...(codexAppcastMetadata ?? persistedAppcast)!,
        stale: true,
        error: refreshedAppcast.error ?? "Appcast metadata is unavailable.",
      };
    } else {
      codexAppcastMetadata = refreshedAppcast;
    }
  }
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
  if (sparkle.lastError || codexAppcastMetadata?.error) {
    errors.desktop = sparkle.lastError ?? codexAppcastMetadata?.error ?? undefined;
  }

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
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
    cli: {
      bundled: {
        path: bundledProbe.path,
        version: bundledProbe.version,
        available: bundledProbe.available,
        release: bundledRelease?.release ?? null,
        error: bundledProbe.error ?? bundledRelease?.error ?? null,
        managedCurrentVersion: null,
        managedPreviousVersion: null,
      },
      beta: {
        path: betaProbe?.path ?? null,
        version: betaProbe?.version ?? null,
        available: betaProbe?.available ?? false,
        release: betaRelease?.release ?? null,
        error: betaProbe?.error ?? betaRelease?.error ?? (betaPath ? null : "No managed Beta is installed"),
        managedCurrentVersion: managerState.current?.version ?? null,
        managedPreviousVersion: managerState.previous?.version ?? null,
      },
    },
    requestedLane: readState().codexPlusPlus?.codexCliLane ?? null,
    effectiveLane: codexCliBootstrap.effectiveLane,
    userOverridePreserved: codexCliBootstrap.userOverridePreserved,
    fallbackReason: codexCliBootstrap.error,
    restartRequired: codexLaneChangedThisProcess,
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

ipcMain.handle("codexpp:get-codex-versions", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-codex-versions");
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("codexpp:refresh-codex-versions", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "refresh-codex-versions");
  return getCodexVersionsSnapshot(true);
});

ipcMain.handle("codexpp:set-codex-cli-lane", async (_e, payload: unknown) => {
  assertExactObjectKeys(payload, ["lane", "confirmOverride"], "Codex CLI lane request");
  const lane = payload.lane;
  const confirmOverride = payload.confirmOverride;
  if ((lane !== "bundled" && lane !== "beta") || typeof confirmOverride !== "boolean") {
    throw new Error("Invalid Codex CLI lane request");
  }
  if (codexCliBootstrap.requestedLane === null && codexCliBootstrap.userOverridePreserved && !confirmOverride) {
    throw new Error("Confirm replacing the existing CODEX_CLI_PATH override before selecting a managed runtime");
  }
  const state = readState();
  state.codexPlusPlus ??= {};
  state.codexPlusPlus.codexCliLane = lane;
  delete state.codexPlusPlus.codexCliBootstrapFailure;
  writeState(state);
  codexLaneChangedThisProcess = codexCliBootstrap.requestedLane === null
    ? true
    : lane !== codexCliBootstrap.effectiveLane;
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("codexpp:install-codex-beta", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "install-codex-beta");
  await codexCliManager.installBeta();
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("codexpp:rollback-codex-beta", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "rollback-codex-beta");
  await codexCliManager.rollbackBeta();
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("codexpp:set-codex-feature", async (_e, payload: unknown) => {
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

ipcMain.handle("codexpp:check-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "check-codex-desktop-update");
  // A patched app has a local signing identity. Calling Sparkle's raw manual
  // check from that process makes its XPC bootstrap relaunch ChatGPT as a
  // helper, producing transient duplicate Dock icons. The signed appcast is
  // sufficient for a read-only version check and keeps OpenAI's native manager
  // as the sole owner of background downloads and installation.
  return getCodexVersionsSnapshot(true);
});

ipcMain.handle("codexpp:install-codex-desktop-update", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "install-codex-desktop-update");
  if (!(await getCodexSparkleBridge().installUpdate())) {
    const reason = getCodexSparkleBridge().getSnapshot().installPrerequisiteFailure;
    throw new Error(reason ?? "Native Codex update installation is unavailable");
  }
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("codexpp:get-config", () => {
  const s = readState();
  const installerState = readInstallerState();
  const sourceRoot = installerState?.sourceRoot ?? fallbackSourceRoot();
  return {
    version: CODEX_PLUSPLUS_VERSION,
    autoUpdate: s.codexPlusPlus?.autoUpdate !== false,
    safeMode: s.codexPlusPlus?.safeMode === true,
    updateChannel: s.codexPlusPlus?.updateChannel ?? "stable",
    updateRepo: s.codexPlusPlus?.updateRepo ?? CODEX_PLUSPLUS_REPO,
    updateRef: s.codexPlusPlus?.updateRef ?? "",
    updateCheck: s.codexPlusPlus?.updateCheck ?? null,
    selfUpdate: readSelfUpdateState(),
    installationSource: describeInstallationSource(sourceRoot),
  };
});

ipcMain.handle("codexpp:set-auto-update", (_e, enabled: boolean) => {
  setCodexPlusPlusAutoUpdate(!!enabled);
  return { autoUpdate: isCodexPlusPlusAutoUpdateEnabled() };
});

ipcMain.handle("codexpp:set-update-config", (_e, config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}) => {
  setCodexPlusPlusUpdateConfig(config);
  const s = readState();
  return {
    updateChannel: s.codexPlusPlus?.updateChannel ?? "stable",
    updateRepo: s.codexPlusPlus?.updateRepo ?? CODEX_PLUSPLUS_REPO,
    updateRef: s.codexPlusPlus?.updateRef ?? "",
  };
});

ipcMain.handle("codexpp:check-codexpp-update", async (_e, force?: boolean) => {
  return ensureCodexPlusPlusUpdateCheck(force === true);
});

ipcMain.handle("codexpp:run-codexpp-update", async () => {
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

ipcMain.handle("codexpp:get-refresh-status", () => localRefreshStatus());
ipcMain.handle("codexpp:start-local-refresh", async (_e, requested?: "smart" | "development" | "stable") => {
  const status = await localRefreshStatus();
  if (!status.available) return { started: false, status };
  const cli = localRefreshCli(status);
  const appRoot = readInstallerState()?.appRoot;
  if (!appRoot || !existsSync(cli)) throw new Error("Tweakers refresh CLI is unavailable");
  startInstalledCli(cli, ["refresh-local", "--source", requested ?? "smart", "--app", appRoot]);
  return { started: true, status: { ...status, phase: "preparing" } };
});

// Switches /Applications/ChatGPT.app between the pristine official payload
// ("chatgpt") and the patched payload ("tweakers") by delegating to the
// installer CLI (`tweakers mode <target> --yes`), which quits the app, swaps
// bundles, and relaunches. The renderer confirms with the user BEFORE
// invoking this — the handler never prompts. launchd submission is mandatory
// (not a plain spawn) so the CLI survives this app quitting and the live
// bundle being swapped out from under it.
ipcMain.handle("codexpp:switch-app-mode", (_e, payload: unknown) => {
  return switchAppMode(payload, {
    // The injected runtime only ever runs inside the patched bundle; in
    // chatgpt mode nothing is injected, so the live mode here is fixed.
    currentMode: "tweakers",
    resolveCli: () => localRefreshCli(),
    cliExists: (cli) => existsSync(cli),
    startCliWithLaunchd: startInstalledCliWithLaunchd,
  });
});

ipcMain.handle("codexpp:get-watcher-health", () => getWatcherHealth(userRoot!));

ipcMain.handle("codexpp:get-tweak-store", async () => {
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

ipcMain.handle("codexpp:install-store-tweak", async (_e, id: string) => {
  const { registry } = await fetchTweakStoreRegistry();
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Tweak store entry not found: ${id}`);
  if (entry.available === false && !isBundledStoreEntry(entry)) {
    throw new Error(`${entry.manifest.name} is catalog metadata only and is not installable yet.`);
  }
  assertStoreEntryPlatformCompatible(entry);
  assertStoreEntryRuntimeCompatible(entry);
  await installStoreTweak(entry);
  reloadTweaks("store-install", tweakLifecycleDeps);
  return { installed: entry.id };
});

ipcMain.handle("codexpp:prepare-tweak-store-submission", async (_e, repoInput: string) => {
  return prepareTweakStoreSubmission(repoInput);
});

// Sandboxed renderer preload can't use Node fs to read tweak source. Main
// reads it on the renderer's behalf. Path must live under tweaksDir for
// security — we refuse anything else.
ipcMain.handle("codexpp:read-tweak-source", (_e, entryPath: string) => {
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
  "codexpp:read-tweak-asset",
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
ipcMain.on("codexpp:preload-log", (_e, level: "info" | "warn" | "error", msg: string) => {
  const lvl = level === "error" || level === "warn" ? level : "info";
  try {
    appendCappedLog(join(LOG_DIR, "preload.log"), `[${new Date().toISOString()}] [${lvl}] ${msg}\n`);
  } catch {}
});

// Sandbox-safe filesystem ops for renderer-scope tweaks. Each tweak gets
// a sandboxed dir under userRoot/tweak-data/<id>. Renderer side calls these
// over IPC instead of using Node fs directly.
ipcMain.handle("codexpp:tweak-fs", (_e, op: string, id: string, p: string, c?: string) => {
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

ipcMain.handle("codexpp:user-paths", () => ({
  userRoot,
  runtimeDir,
  tweaksDir: TWEAKS_DIR,
  logDir: LOG_DIR,
}));

ipcMain.handle("codexpp:codex-runtime-info", () => currentRuntimeInfo());
ipcMain.handle("codexpp:codex-runtime-capabilities", () => currentRuntimeCapabilities());
ipcMain.handle("codexpp:codex-cdp-status", () => getCdpStatus());
ipcMain.handle("codexpp:codex-cdp-targets", () => listCdpTargets());
ipcMain.handle("codexpp:codex-window-create", (_e, opts: CodexCreateWindowOptions) => {
  return createCodexWindow(opts);
});
ipcMain.handle("codexpp:codex-window-primary", () => getPrimaryCodexWindowRef());
ipcMain.handle("codexpp:codex-window-focus", (_e, windowId: number) => focusCodexWindow(windowId));
ipcMain.handle("codexpp:codex-window-show", (_e, windowId: number) => showCodexWindow(windowId));
ipcMain.handle(
  "codexpp:codex-view-create",
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
  "codexpp:codex-view-call",
  (_e, tweakId: string, viewId: string, method: string, arg?: unknown, arg2?: unknown) => {
    assertTweakViewPermissionForId(tweakId);
    return callOwlView(tweakId, viewId, method, arg, arg2);
  },
);
ipcMain.handle("codexpp:codex-view-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  disposeOwlViewsForTweak(tweakId);
});
ipcMain.handle(
  "codexpp:native-load-module",
  (_e, tweakId: string, options: NativeModuleLoadOptions) => {
    const ref = nativeBridge.loadModule(tweakContext(tweakId, "native-module"), options);
    return { id: ref.id, kind: ref.kind };
  },
);
ipcMain.handle(
  "codexpp:native-module-request",
  (_e, tweakId: string, moduleId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-module");
    return nativeBridge.requestModule(tweakId, moduleId, method, payload, timeoutMs);
  },
);
ipcMain.handle("codexpp:native-module-dispose", (_e, tweakId: string, moduleId: string) => {
  assertTweakPermissionForId(tweakId, "native-module");
  return nativeBridge.disposeModule(tweakId, moduleId);
});
ipcMain.handle("codexpp:native-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  nativeBridge.disposeTweak(tweakId);
});
ipcMain.handle(
  "codexpp:native-create-panel",
  async (_e, tweakId: string, options: NativePanelCreateOptions) => {
    const ref = await nativeBridge.createPanel(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id, windowId: ref.windowId };
  },
);
ipcMain.handle(
  "codexpp:native-attach-view",
  async (_e, tweakId: string, options: NativeViewAttachOptions) => {
    const ref = await nativeBridge.attachView(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id };
  },
);
ipcMain.handle(
  "codexpp:native-instance-call",
  async (_e, tweakId: string, kind: "panel" | "view", instanceId: string, method: string, arg?: unknown) => {
    assertTweakPermissionForId(tweakId, "native-view");
    return nativeBridge.callInstance(tweakId, kind, instanceId, method, arg);
  },
);
ipcMain.handle(
  "codexpp:native-launch-helper",
  (_e, tweakId: string, options: NativeHelperLaunchOptions) => {
    const ref = nativeBridge.launchHelper(tweakContext(tweakId, "native-helper"), options);
    return { id: ref.id, pid: ref.pid };
  },
);
ipcMain.handle(
  "codexpp:native-helper-call",
  (_e, tweakId: string, helperId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-helper");
    return nativeBridge.callHelper(tweakId, helperId, method, payload, timeoutMs);
  },
);

ipcMain.handle("codexpp:reveal", (_e, p: string) => {
  shell.openPath(p).catch(() => {});
});

ipcMain.handle("codexpp:open-external", (_e, url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("only github.com links can be opened from tweak metadata");
  }
  shell.openExternal(parsed.toString()).catch(() => {});
});

ipcMain.handle("codexpp:copy-text", (_e, text: string) => {
  clipboard.writeText(String(text));
  return true;
});

// Manual force-reload trigger from the renderer (e.g. the "Force Reload"
// button on our injected Tweaks page). Bypasses the watcher debounce.
ipcMain.handle("codexpp:reload-tweaks", () => {
  reloadTweaks("manual", tweakLifecycleDeps);
  return { at: Date.now(), count: tweakState.discovered.length };
});

// 4. Filesystem watcher → debounced reload + broadcast.
//    We watch the tweaks dir for any change. On the first tick of inactivity
//    we stop main-side tweaks, clear their cached modules, re-discover, then
//    restart and broadcast `codexpp:tweaks-changed` to every renderer so it
//    can re-init its host.
const RELOAD_DEBOUNCE_MS = 250;
const DEV_PUBLISH_LOCK = join(TWEAKS_DIR, ".codexpp-dev-publishing");
const DEV_PUBLISH_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
let reloadTimer: NodeJS.Timeout | null = null;
function scheduleReload(reason: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadTweaks(reason, tweakLifecycleDeps);
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

function loadAllMainTweaks(): void {
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

  syncMcpServersFromEnabledTweaks();

  for (const t of tweakState.discovered) {
    if (!isMainProcessTweakScope(t.manifest.scope)) continue;
    if (!isTweakEnabled(t.manifest.id)) {
      recordTweakLifecycle(t.manifest.id, "main", isTweakQuarantined(t.manifest.id) ? "quarantined" : "disabled");
      log("info", `skipping disabled main tweak: ${t.manifest.id}`);
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
          ipc: makeMainIpc(t.manifest.id),
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

function syncMcpServersFromEnabledTweaks(): void {
  try {
    const result = syncManagedMcpServers({
      configPath: CODEX_CONFIG_FILE,
      tweaks: tweakState.discovered.filter((t) => isTweakEnabled(t.manifest.id)),
    });
    if (result.changed) {
      log("info", `synced Codex MCP config: ${result.serverNames.join(", ") || "none"}`);
    }
    if (result.skippedServerNames.length > 0) {
      log(
        "info",
        `skipped Tweakers managed MCP server(s) already configured by user: ${result.skippedServerNames.join(", ")}`,
      );
    }
  } catch (e) {
    log("warn", "failed to sync Codex MCP config:", e);
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

async function ensureCodexPlusPlusUpdateCheck(force = false): Promise<CodexPlusPlusUpdateCheck> {
  const state = readState();
  const cached = state.codexPlusPlus?.updateCheck;
  const channel = state.codexPlusPlus?.updateChannel ?? "stable";
  const repo = state.codexPlusPlus?.updateRepo ?? CODEX_PLUSPLUS_REPO;
  if (
    !force &&
    cached &&
    cached.currentVersion === CODEX_PLUSPLUS_VERSION &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return cached;
  }

  const release = await fetchLatestRelease(repo, CODEX_PLUSPLUS_VERSION, channel === "prerelease");
  const latestVersion = release.latestTag ? normalizeVersion(release.latestTag) : null;
  const check: CodexPlusPlusUpdateCheck = {
    checkedAt: new Date().toISOString(),
    currentVersion: CODEX_PLUSPLUS_VERSION,
    latestVersion,
    releaseUrl: release.releaseUrl ?? `https://github.com/${repo}/releases`,
    releaseNotes: release.releaseNotes,
    updateAvailable: latestVersion
      ? compareVersions(normalizeVersion(latestVersion), CODEX_PLUSPLUS_VERSION) > 0
      : false,
    ...(release.error ? { error: release.error } : {}),
  };
  state.codexPlusPlus ??= {};
  state.codexPlusPlus.updateCheck = check;
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
          "User-Agent": `codex-plusplus/${currentVersion}`,
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
  const compatible = !required || compareVersions(CODEX_PLUSPLUS_VERSION, required) >= 0;
  return {
    current: CODEX_PLUSPLUS_VERSION,
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
          "User-Agent": `codex-plusplus/${CODEX_PLUSPLUS_VERSION}`,
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
  const work = mkdtempSync(join(tmpdir(), "codexpp-store-tweak-"));
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
        headers: { "User-Agent": `codex-plusplus/${CODEX_PLUSPLUS_VERSION}` },
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
      join(stagedTarget, ".codexpp-store.json"),
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
        "User-Agent": `codex-plusplus/${CODEX_PLUSPLUS_VERSION}`,
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
      "User-Agent": `codex-plusplus/${CODEX_PLUSPLUS_VERSION}`,
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
  const metadataPath = join(target, ".codexpp-store.json");
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
    headers: { "User-Agent": `codex-plusplus/${CODEX_PLUSPLUS_VERSION}` },
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
    if (name === ".git" || name === "node_modules" || name === ".codexpp-store.json") continue;
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
    join(homedir(), ".codex-plusplus", "source"),
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
  if (/\/(?:Homebrew|homebrew)\/Cellar\/codexplusplus\//.test(normalized)) {
    return { kind: "homebrew", label: "Homebrew", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, ".git"))) {
    return { kind: "local-dev", label: "Local development checkout", detail: sourceRoot };
  }
  if (normalized.endsWith("/.codex-plusplus/source") || normalized.includes("/.codex-plusplus/source/")) {
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
    env: { ...runtime.env, CODEX_PLUSPLUS_MANUAL_UPDATE: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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

// Recent ChatGPT builds no longer consistently honor ELECTRON_RUN_AS_NODE on
// their outer launcher. Prefer the bundled renderer Node binary so refresh
// status emits JSON instead of launching ChatGPT and printing "Opening in…".
function localCliRuntime(cli: string, args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const bundledNode = join(process.resourcesPath, "cua_node", "bin", "node");
  if (existsSync(bundledNode)) return { command: bundledNode, args: [cli, ...args], env: { ...process.env } };
  return { command: process.execPath, args: [cli, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

function localRefreshCli(status?: { source?: string; developmentSourceRoot?: string | null }): string {
  let developmentSourceRoot = status?.developmentSourceRoot ?? null;
  if (!developmentSourceRoot) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { codexPlusPlus?: { developmentSourceRoot?: unknown } };
      if (typeof config.codexPlusPlus?.developmentSourceRoot === "string") developmentSourceRoot = config.codexPlusPlus.developmentSourceRoot;
    } catch {}
  }
  if ((status?.source === "development" || !status) && developmentSourceRoot) {
    const cli = join(developmentSourceRoot, "packages", "installer", "dist", "cli.js");
    if (existsSync(cli)) return cli;
  }
  return join(userRoot!, "managed-runtime", "current", "packages", "installer", "dist", "cli.js");
}

// This launchd helper runs the installer CLI, which must outlive the app's own
// bundle swap. It deliberately uses launchctl submit instead of app.relaunch(),
// which cannot outlive replacing the running executable; the per-PID label and
// EXIT trap's launchctl remove/bootout make the transient job self-remove.
function startInstalledCliWithLaunchd(cli: string, args: string[]): boolean {
  const label = `com.therealityreport.tweakers.patch-helper.${process.pid}.${Date.now()}`;
  const cleanup = `launchctl remove ${label} >/dev/null 2>&1 || launchctl bootout gui/$(id -u)/${label} >/dev/null 2>&1 || true`;
  const runtime = localCliRuntime(cli, args);
  const command = [
    `trap ${shellQuote(cleanup)} EXIT`,
    `cd ${shellQuote(resolve(dirname(cli), "..", "..", ".."))}`,
    `CODEX_PLUSPLUS_MANUAL_UPDATE=1 ELECTRON_RUN_AS_NODE=1 ${[runtime.command, ...runtime.args].map(shellQuote).join(" ")}`,
  ].join(" && ");
  const result = spawnSync(
    "launchctl",
    [
      "submit",
      "-l",
      label,
      "--",
      "/bin/sh",
      "-c",
      `${command} || true`,
    ],
    {
      encoding: "utf8",
      stdio: "ignore",
    },
  );
  if (result.status === 0) return true;
  log("warn", `launchctl submit failed for Tweakers patch helper: ${result.error?.message ?? result.status}`);
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function markSelfUpdateStarted(sourceRoot: string): SelfUpdateState {
  const config = readState().codexPlusPlus;
  const channel = config?.updateChannel ?? "stable";
  const state: SelfUpdateState = {
    checkedAt: new Date().toISOString(),
    status: "checking",
    currentVersion: CODEX_PLUSPLUS_VERSION,
    latestVersion: null,
    targetRef: config?.updateChannel === "custom" ? config.updateRef ?? null : null,
    releaseUrl: null,
    repo: config?.updateRepo ?? CODEX_PLUSPLUS_REPO,
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
      wc.send("codexpp:tweaks-changed", payload);
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

function makeMainIpc(id: string) {
  const ch = (c: string) => `codexpp:${id}:${c}`;
  return {
    on: (c: string, h: (...args: unknown[]) => void) => {
      const wrapped = (_e: unknown, ...args: unknown[]) => h(...args);
      ipcMain.on(ch(c), wrapped);
      return () => ipcMain.removeListener(ch(c), wrapped as never);
    },
    send: (c: string, ...args: unknown[]) => {
      for (const wc of webContents.getAllWebContents()) {
        try { wc.send(ch(c), ...args); } catch {}
      }
    },
    sendToPrimary: (c: string, ...args: unknown[]) => {
      const win = getPrimaryCodexWindow();
      if (!win || win.isDestroyed()) return false;
      try {
        win.webContents.send(ch(c), ...args);
        return true;
      } catch {
        return false;
      }
    },
    invoke: (_c: string) => {
      throw new Error("ipc.invoke is renderer→main; main side uses handle");
    },
    handle: (c: string, handler: (...args: unknown[]) => unknown) => {
      const channel = ch(c);
      // Main tweaks are stopped and reloaded in place. Remove an old handler
      // before registering its replacement so a settings reload cannot fail
      // with Electron's "handler already registered" error.
      try { ipcMain.removeHandler(channel); } catch {}
      const invokeHandler = async (...args: unknown[]) => handler(...args);
      ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => invokeHandler(...args));
      if (id === "co.tweakers.projects" && c === "projects") {
        mainTweakReadHandlers.set(`${id}:${c}`, invokeHandler);
      }
      return () => {
        if (mainTweakReadHandlers.get(`${id}:${c}`) === invokeHandler) mainTweakReadHandlers.delete(`${id}:${c}`);
        try { ipcMain.removeHandler(channel); } catch {}
      };
    },
  };
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
  const services = (globalThis as unknown as Record<string, unknown>)[CODEX_WINDOW_SERVICES_KEY];
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

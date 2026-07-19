import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, relative } from "node:path";

type CheckStatus = "ok" | "warn" | "error";

export interface WatcherHealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface WatcherHealth {
  checkedAt: string;
  status: CheckStatus;
  title: string;
  summary: string;
  watcher: string;
  checks: WatcherHealthCheck[];
  latestCompletedCycle?: WatcherCycleReceipt;
}

interface InstallerState {
  appRoot?: string;
  version?: string;
  sourceRoot?: string;
  watcher?: "launchd" | "login-item" | "scheduled-task" | "systemd" | "none";
}

interface RuntimeConfig {
  tweaker?: {
    autoUpdate?: boolean;
  };
}
const LEGACY_CONFIG_KEY = ["codex", "Plus", "Plus"].join("");

interface SelfUpdateState {
  status?: "checking" | "up-to-date" | "updated" | "failed" | "disabled";
  completedAt?: string;
  checkedAt?: string;
  latestVersion?: string | null;
  error?: string;
}

const LAUNCHD_LABEL = "com.therealityreport.tweakers.watcher";
const WATCHER_LOG = join(homedir(), "Library", "Logs", "tweaker-watcher.log");
const LEGACY_WATCHER_LOG = join(homedir(), "Library", "Logs", "codex-plusplus-watcher.log");
const RUNTIME_FINGERPRINT_FILE = "runtime-fingerprint.json";
const WINDOWS_WATCHER_LOGON_TASK_NAME = "tweaker-watcher";
const WINDOWS_WATCHER_INTERVAL_TASK_NAME = "tweaker-watcher-interval";
const WINDOWS_LEGACY_LOGON_TASK_NAMES = ["codex-plusplus-watcher"];
const WINDOWS_LEGACY_INTERVAL_TASK_NAMES = [
  "tweaker-watcher-hourly",
  "tweaker-watcher-daily",
  "codex-plusplus-watcher-interval",
  "codex-plusplus-watcher-hourly",
  "codex-plusplus-watcher-daily",
];

export interface LaunchdLoadedState {
  loaded: boolean;
  running: boolean;
  lastExitCode: number | null;
  command?: string | null;
}

export interface WatcherCycleReceipt {
  schemaVersion: 1;
  cycleId: string;
  startedAt: string;
  completedAt: string;
  update: { status: "succeeded" | "failed" | "skipped" | "pending"; error: string | null };
  repair: { status: "succeeded" | "failed" | "skipped" | "pending"; error: string | null };
  outcome: "completed" | "failed";
  error: string | null;
}

interface AutoRepairState {
  schemaVersion?: number;
  latestCompletedCycle?: WatcherCycleReceipt;
}

export interface RuntimeFingerprintSet {
  generated: string | null;
  managed: string | null;
  active: string | null;
}

export interface RuntimeFingerprintHealth extends RuntimeFingerprintSet {
  status: "current" | "managed-pending" | "runtime-pending" | "unknown";
}

export function getWatcherHealth(userRoot: string): WatcherHealth {
  const checks: WatcherHealthCheck[] = [];
  const state = readJson<InstallerState>(join(userRoot, "state.json"));
  const config = normalizeRuntimeConfig(readJson<RuntimeConfig & Record<string, unknown>>(join(userRoot, "config.json")) ?? {});
  const selfUpdate = readJson<SelfUpdateState>(join(userRoot, "self-update-state.json"));

  checks.push({
    name: "Install state",
    status: state ? "ok" : "error",
    detail: state ? `Tweakers ${state.version ?? "(unknown version)"}` : "state.json is missing",
  });

  if (!state) return summarize("none", checks);

  const autoUpdate = config.tweaker?.autoUpdate !== false;
  checks.push({
    name: "Automatic refresh",
    status: autoUpdate ? "ok" : "warn",
    detail: autoUpdate ? "enabled" : "disabled in Tweakers config",
  });

  checks.push({
    name: "Watcher kind",
    status: state.watcher && state.watcher !== "none" ? "ok" : "error",
    detail: state.watcher ?? "none",
  });

  if (selfUpdate) {
    checks.push(selfUpdateCheck(selfUpdate));
  }

  const appRoot = state.appRoot ?? "";
  checks.push({
    name: "Codex app",
    status: appRoot && existsSync(appRoot) ? "ok" : "error",
    detail: appRoot || "missing appRoot in state",
  });

  switch (platform()) {
    case "darwin":
      checks.push(...checkLaunchdWatcher(appRoot));
      break;
    case "linux":
      checks.push(...checkSystemdWatcher(appRoot));
      break;
    case "win32":
      checks.push(...checkScheduledTaskWatcher());
      break;
    default:
      checks.push({
        name: "Platform watcher",
        status: "warn",
        detail: `unsupported platform: ${platform()}`,
      });
  }

  const autoRepairState = readJson<AutoRepairState>(join(userRoot, "auto-repair-state.json"));
  if (autoRepairState?.latestCompletedCycle) {
    checks.push(analyzeWatcherCycleReceipt(autoRepairState.latestCompletedCycle));
  } else {
    checks.push(watcherLogCheck());
  }

  const runtime = classifyRuntimeFingerprints({
    generated: readRuntimeFingerprint(
      state.sourceRoot ? join(state.sourceRoot, "packages", "installer", "assets", "runtime") : "",
    ),
    managed: readRuntimeFingerprint(join(userRoot, "managed-runtime", "current", "packages", "installer", "assets", "runtime")),
    active: readRuntimeFingerprint(join(userRoot, "runtime")),
  });
  checks.push({
    name: "Runtime assets",
    status: runtime.status === "current" ? "ok" : runtime.status === "unknown" ? "warn" : "warn",
    detail: runtime.status,
  });

  return summarize(state.watcher ?? "none", checks, autoRepairState?.latestCompletedCycle);
}

function normalizeRuntimeConfig(config: RuntimeConfig & Record<string, unknown>): RuntimeConfig {
  if (!config.tweaker) {
    const legacy = config[LEGACY_CONFIG_KEY];
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      config.tweaker = legacy as NonNullable<RuntimeConfig["tweaker"]>;
    }
  }
  return config;
}

function selfUpdateCheck(state: SelfUpdateState): WatcherHealthCheck {
  const at = state.completedAt ?? state.checkedAt ?? "unknown time";
  if (state.status === "failed") {
    if (/404|no (?:published |github )?release/i.test(state.error ?? "")) {
      return { name: "last Tweakers update", status: "ok", detail: `source checkout current ${at}; no published release yet` };
    }
    return {
      name: "last Tweakers update",
      status: "warn",
      detail: state.error ? `failed ${at}: ${state.error}` : `failed ${at}`,
    };
  }
  if (state.status === "disabled") {
    return { name: "last Tweakers update", status: "warn", detail: `skipped ${at}: automatic refresh disabled` };
  }
  if (state.status === "updated") {
    return { name: "last Tweakers update", status: "ok", detail: `updated ${at} to ${state.latestVersion ?? "new release"}` };
  }
  if (state.status === "up-to-date") {
    return { name: "last Tweakers update", status: "ok", detail: `up to date ${at}` };
  }
  return { name: "last Tweakers update", status: "warn", detail: `checking since ${at}` };
}

function checkLaunchdWatcher(appRoot: string): WatcherHealthCheck[] {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const plist = existsSync(plistPath) ? readFileSafe(plistPath) : "";
  return analyzeLaunchdWatcherDefinition({
    appRoot,
    plist,
    plistPath,
    loaded: readLaunchdLoadedState(),
  });
}

export function analyzeLaunchdWatcherDefinition(input: {
  appRoot: string;
  plist: string;
  plistPath: string;
  loaded: LaunchdLoadedState;
}): WatcherHealthCheck[] {
  const { appRoot, plist, plistPath, loaded } = input;
  const checks: WatcherHealthCheck[] = [];
  const asarPath = appRoot ? join(appRoot, "Contents", "Resources", "app.asar") : "";
  const currentCommand = plist.includes("TWEAKER_WATCHER=1")
    && (plist.includes(" watcher-run") || (
      plist.includes(" update --watcher --quiet") && plist.includes(" repair --watcher --quiet")
    ));
  const legacyCommand = plist.includes("CODEX_PLUSPLUS_WATCHER=1")
    && plist.includes(" update --watcher --quiet")
    && plist.includes(" repair --watcher --quiet");

  checks.push({ name: "launchd plist", status: plist ? "ok" : "error", detail: plistPath });
  if (plist) {
    checks.push({
      name: "launchd label",
      status: plist.includes(LAUNCHD_LABEL) ? "ok" : "error",
      detail: LAUNCHD_LABEL,
    });
    checks.push({
      name: "launchd trigger",
      status: asarPath && plist.includes(asarPath) ? "ok" : "error",
      detail: asarPath || "missing appRoot",
    });
    checks.push({
      name: "watcher command",
      status: currentCommand ? "ok" : legacyCommand ? "warn" : "error",
      detail: legacyCommand
        ? `${commandSummary(plist)} (legacy definition; watcher refresh pending)`
        : commandSummary(plist),
    });

    const cliPath = extractFirst(plist, /'([^']*packages\/installer\/dist\/cli\.js)'/);
    if (cliPath) {
      checks.push({ name: "repair CLI", status: existsSync(cliPath) ? "ok" : "error", detail: cliPath });
    }
  }

  const loadedStatus: CheckStatus = !loaded.loaded
    ? "error"
    : loaded.running || loaded.lastExitCode === 0
      ? "ok"
      : "warn";
  const loadedDetail = !loaded.loaded
    ? "launchctl cannot find the watcher"
    : loaded.running
      ? "service is running"
      : loaded.lastExitCode === 0
        ? "service is loaded and idle (last exit 0)"
        : `service is loaded and idle (last exit ${loaded.lastExitCode ?? "unknown"})`;
  checks.push({ name: "launchd loaded", status: loadedStatus, detail: loadedDetail });

  if (loaded.command && plist && !commandsMatch(plist, loaded.command)) {
    checks.push({
      name: "loaded watcher command",
      status: "warn",
      detail: "loaded launchd command differs from the plist on disk; watcher refresh pending",
    });
  }
  return checks;
}

function checkSystemdWatcher(appRoot: string): WatcherHealthCheck[] {
  const dir = join(homedir(), ".config", "systemd", "user");
  const service = join(dir, "tweaker-watcher.service");
  const timer = join(dir, "tweaker-watcher.timer");
  const pathUnit = join(dir, "tweaker-watcher.path");
  const expectedPath = appRoot ? join(appRoot, "resources", "app.asar") : "";
  const pathBody = existsSync(pathUnit) ? readFileSafe(pathUnit) : "";

  return [
    {
      name: "systemd service",
      status: existsSync(service) ? "ok" : "error",
      detail: service,
    },
    {
      name: "systemd timer",
      status: existsSync(timer) ? "ok" : "error",
      detail: timer,
    },
    {
      name: "systemd path",
      status: pathBody && expectedPath && pathBody.includes(expectedPath) ? "ok" : "error",
      detail: expectedPath || pathUnit,
    },
    {
      name: "path unit active",
      status: commandSucceeds("systemctl", ["--user", "is-active", "--quiet", "tweaker-watcher.path"]) ? "ok" : "warn",
      detail: "systemctl --user is-active tweaker-watcher.path",
    },
    {
      name: "timer active",
      status: commandSucceeds("systemctl", ["--user", "is-active", "--quiet", "tweaker-watcher.timer"]) ? "ok" : "warn",
      detail: "systemctl --user is-active tweaker-watcher.timer",
    },
  ];
}

function checkScheduledTaskWatcher(): WatcherHealthCheck[] {
  return analyzeScheduledTaskWatcher((name) => (
    commandSucceeds("schtasks.exe", ["/Query", "/TN", name])
    || commandSucceeds("schtasks.exe", ["/Query", "/TN", `\\${name}`])
  ));
}

export function analyzeScheduledTaskWatcher(taskExists: (name: string) => boolean): WatcherHealthCheck[] {
  const currentLogon = taskExists(WINDOWS_WATCHER_LOGON_TASK_NAME);
  const legacyLogon = currentLogon
    ? undefined
    : WINDOWS_LEGACY_LOGON_TASK_NAMES.find(taskExists);
  const currentInterval = taskExists(WINDOWS_WATCHER_INTERVAL_TASK_NAME);
  const legacyInterval = currentInterval
    ? undefined
    : WINDOWS_LEGACY_INTERVAL_TASK_NAMES.find(taskExists);

  return [
    {
      name: "logon task",
      status: currentLogon ? "ok" : legacyLogon ? "warn" : "error",
      detail: currentLogon
        ? WINDOWS_WATCHER_LOGON_TASK_NAME
        : legacyLogon
          ? `${legacyLogon} (legacy task; watcher refresh pending)`
          : `${WINDOWS_WATCHER_LOGON_TASK_NAME} is missing`,
    },
    {
      name: "interval task",
      status: currentInterval ? "ok" : "warn",
      detail: currentInterval
        ? WINDOWS_WATCHER_INTERVAL_TASK_NAME
        : legacyInterval
          ? `${legacyInterval} (legacy task; watcher refresh pending)`
          : `${WINDOWS_WATCHER_INTERVAL_TASK_NAME} is missing`,
    },
  ];
}

function watcherLogCheck(): WatcherHealthCheck {
  const path = existsSync(WATCHER_LOG) ? WATCHER_LOG : existsSync(LEGACY_WATCHER_LOG) ? LEGACY_WATCHER_LOG : null;
  if (!path) {
    return { name: "watcher log", status: "warn", detail: "no watcher log yet" };
  }
  const tail = readFileSafe(path).split(/\r?\n/).slice(-40).join("\n");
  const check = analyzeWatcherLogTail(tail);
  if (path === LEGACY_WATCHER_LOG && check.status === "ok") {
    return { ...check, status: "warn", detail: `${path} (legacy log; watcher refresh pending)` };
  }
  return check;
}

export function analyzeWatcherLogTail(tail: string): WatcherHealthCheck {
  const relevantTail = tail.replace(/^.*(?:404 Not Found|no (?:published |GitHub )?release found).*$/gim, "");
  const hasError = /✗ tweaker failed|tweaker failed|error|failed/i.test(relevantTail);
  const needsManualRepair =
    hasError &&
    /Cannot write to .*Codex.*\.app|App Management|file ownership|sudo (?:tweaker|tweakers) (?:install|repair)|EACCES|EPERM/i.test(relevantTail);
  return {
    name: "watcher log",
    status: hasError ? "warn" : "ok",
    detail: hasError
      ? needsManualRepair
        ? "auto-repair needs app permissions; run `tweaker repair` from Terminal"
        : "recent watcher log contains an error"
      : WATCHER_LOG,
  };
}

export function analyzeWatcherCycleReceipt(receipt: WatcherCycleReceipt): WatcherHealthCheck {
  if (receipt.repair.status === "succeeded") {
    return {
      name: "watcher cycle",
      status: "ok",
      detail: `repair completed ${receipt.completedAt}`,
    };
  }
  if (receipt.repair.status === "pending") {
    return {
      name: "watcher cycle",
      status: "warn",
      detail: receipt.repair.error
        ? `repair pending ${receipt.completedAt}: ${receipt.repair.error}`
        : `repair pending ${receipt.completedAt}`,
    };
  }
  if (receipt.repair.status === "skipped" && receipt.outcome === "completed") {
    return {
      name: "watcher cycle",
      status: "ok",
      detail: `repair not needed ${receipt.completedAt}`,
    };
  }
  return {
    name: "watcher cycle",
    status: "warn",
    detail: receipt.repair.error
      ? `repair failed ${receipt.completedAt}: ${receipt.repair.error}`
      : `watcher cycle failed ${receipt.completedAt}`,
  };
}

export function classifyRuntimeFingerprints(values: RuntimeFingerprintSet): RuntimeFingerprintHealth {
  const { generated, managed, active } = values;
  if (!generated) return { ...values, status: "unknown" };
  if (!managed) return { ...values, status: "managed-pending" };
  if (!active) {
    return { ...values, status: generated === managed ? "runtime-pending" : "managed-pending" };
  }
  if (generated === managed && managed === active) return { ...values, status: "current" };
  if (managed === active && generated !== managed) return { ...values, status: "managed-pending" };
  if (generated === managed && managed !== active) return { ...values, status: "runtime-pending" };
  return { ...values, status: "unknown" };
}

function summarize(
  watcher: string,
  checks: WatcherHealthCheck[],
  latestCompletedCycle?: WatcherCycleReceipt,
): WatcherHealth {
  const hasError = checks.some((c) => c.status === "error");
  const hasWarn = checks.some((c) => c.status === "warn");
  const status: CheckStatus = hasError ? "error" : hasWarn ? "warn" : "ok";
  const failed = checks.filter((c) => c.status === "error").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const title =
    status === "ok"
      ? "Auto-repair watcher is ready"
      : status === "warn"
        ? "Auto-repair watcher needs review"
        : "Auto-repair watcher is not ready";
  const summary =
    status === "ok"
      ? "Tweakers should automatically repair itself after Codex updates."
      : `${failed} failing check(s), ${warned} warning(s).`;

  return {
    checkedAt: new Date().toISOString(),
    status,
    title,
    summary,
    watcher,
    checks,
    latestCompletedCycle,
  };
}

function commandSucceeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function readLaunchdLoadedState(): LaunchdLoadedState {
  const output = commandOutput("launchctl", ["list", LAUNCHD_LABEL]);
  if (output === null) return { loaded: false, running: false, lastExitCode: null };
  const pidMatch = output.match(/["']?PID["']?\s*[=:]\s*(\d+)/i);
  const exitMatch = output.match(/["']?LastExitStatus["']?\s*[=:]\s*(-?\d+)/i);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const loadedDefinition = uid === null
    ? null
    : commandOutput("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]);
  return {
    loaded: true,
    running: Boolean(pidMatch && Number(pidMatch[1]) > 0),
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
    command: loadedDefinition ? parseLaunchdLoadedCommand(loadedDefinition) : null,
  };
}

export function parseLaunchdLoadedCommand(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /(?:watcher-run|update --watcher --quiet|repair --watcher --quiet)/.test(value));
  if (!line) return null;
  return line.replace(/^["']|["'],?$/g, "").trim();
}

function commandOutput(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function commandsMatch(plist: string, loadedCommand: string): boolean {
  const normalize = (value: string) => value.replace(/&(?:quot|apos|lt|gt|amp);/g, "").replace(/\s+/g, " ").trim();
  const expected = normalize(commandSummary(plist));
  const observed = normalize(loadedCommand);
  return expected.length > 0 && (observed.includes(expected) || expected.includes(observed));
}

function readRuntimeFingerprint(root: string): string | null {
  if (!root) return null;
  const value = readJson<{ schemaVersion?: number; fingerprint?: unknown; fileCount?: unknown }>(
    join(root, RUNTIME_FINGERPRINT_FILE),
  );
  if (
    value?.schemaVersion !== 1
    || typeof value.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/i.test(value.fingerprint)
    || !Number.isInteger(value.fileCount)
    || Number(value.fileCount) < 0
  ) return null;
  try {
    const actual = computeRuntimeFingerprint(root);
    return actual.fingerprint === value.fingerprint && actual.fileCount === value.fileCount
      ? actual.fingerprint
      : null;
  } catch {
    return null;
  }
}

function computeRuntimeFingerprint(runtimeRoot: string): { fingerprint: string; fileCount: number } {
  const hash = createHash("sha256");
  let fileCount = 0;

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(runtimeRoot, path);
      if (name === RUNTIME_FINGERPRINT_FILE) continue;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        fileCount += 1;
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };

  walk(runtimeRoot);
  return { fingerprint: hash.digest("hex"), fileCount };
}

function commandSummary(plist: string): string {
  const command = extractFirst(plist, /<string>([^<]*(?:watcher-run|update --watcher --quiet|repair --watcher --quiet)[^<]*)<\/string>/);
  return command ? unescapeXml(command).replace(/\s+/g, " ").trim() : "watcher command not found";
}

function extractFirst(source: string, pattern: RegExp): string | null {
  return source.match(pattern)?.[1] ?? null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

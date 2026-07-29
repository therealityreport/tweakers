/**
 * Watcher: a small process scheduled to run at user login that compares the
 * current Codex.app's asar hash against the patched hash we recorded at
 * install. If they don't match, Sparkle has updated Codex over our patch —
 * we either auto-`repair` or surface a notification, depending on user prefs.
 *
 * Implementation per OS:
 *   macOS:   ~/Library/LaunchAgents/com.tweaker.watcher.plist (launchd)
 *   Linux:   ~/.config/systemd/user/tweaker-watcher.service (systemd --user)
 *   Windows: Task Scheduler entry via schtasks.exe
 *
 * The watcher itself is just `tweaker repair --quiet` triggered on the
 * relevant event (app launch / login). The simplest cross-platform approach
 * is "run at login" + "run when Codex.app is modified" (FSEvents/inotify on
 * unix, but launchd's WatchPaths handles it on mac).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { chownForTargetUser, targetUserHome, targetUserOwnership } from "./ownership.js";
import { userPaths } from "./paths.js";
import { managedCliPath } from "./managed-runtime.js";
import { LEGACY_LAUNCHD_LABEL, LEGACY_WATCHER_ENV, LEGACY_WATCHER_STEM } from "./legacy-compat.js";

export type WatcherKind = "launchd" | "login-item" | "scheduled-task" | "systemd" | "none";

export interface WatcherPromotionSnapshot {
  schemaVersion: 1;
  kind: "watcher-promotion-snapshot";
  watcherKind: WatcherKind;
  configured: boolean;
  loaded: boolean;
  enabled: boolean;
  definitionPath: string | null;
  definitionDigest: string | null;
  capturedAt: string;
}

/** Capture the service state before a promotion mutates any live app bytes. */
export function captureWatcherPromotionSnapshot(): WatcherPromotionSnapshot {
  const capturedAt = new Date().toISOString();
  switch (platform()) {
    case "darwin": {
      const definitionPath = launchdPath();
      const configured = existsSync(definitionPath);
      return {
        schemaVersion: 1,
        kind: "watcher-promotion-snapshot",
        watcherKind: configured ? "launchd" : "none",
        configured,
        loaded: configured && launchdServiceLoaded(),
        enabled: configured && launchdServiceEnabled(),
        definitionPath: configured ? definitionPath : null,
        definitionDigest: configured ? fileDigest(definitionPath) : null,
        capturedAt,
      };
    }
    case "linux": {
      const definitionPath = systemdWatcherPath();
      const configured = existsSync(definitionPath);
      return {
        schemaVersion: 1,
        kind: "watcher-promotion-snapshot",
        watcherKind: configured ? "systemd" : "none",
        configured,
        loaded: configured && systemdUnitActive("tweaker-watcher.path"),
        enabled: configured && systemdUnitEnabled("tweaker-watcher.path"),
        definitionPath: configured ? definitionPath : null,
        definitionDigest: configured ? fileDigest(definitionPath) : null,
        capturedAt,
      };
    }
    case "win32": {
      const configured = windowsTaskExists(WINDOWS_WATCHER_LOGON_TASK_NAME)
        || windowsTaskExists(WINDOWS_WATCHER_INTERVAL_TASK_NAME);
      return {
        schemaVersion: 1,
        kind: "watcher-promotion-snapshot",
        watcherKind: configured ? "scheduled-task" : "none",
        configured,
        loaded: configured,
        enabled: configured,
        definitionPath: null,
        definitionDigest: null,
        capturedAt,
      };
    }
    default:
      return {
        schemaVersion: 1,
        kind: "watcher-promotion-snapshot",
        watcherKind: "none",
        configured: false,
        loaded: false,
        enabled: false,
        definitionPath: null,
        definitionDigest: null,
        capturedAt,
      };
  }
}

/** Stop triggers without deleting their definitions. Safe to repeat after a crash. */
export function pauseWatcherForPromotion(snapshot: WatcherPromotionSnapshot): void {
  if (!snapshot.configured) return;
  switch (snapshot.watcherKind) {
    case "launchd": {
      const path = snapshot.definitionPath ?? launchdPath();
      bootoutLaunchd(path);
      try { execLaunchctlForTargetUser(["unload", path]); } catch {}
      if (launchdServiceLoaded()) throw new Error("Watcher launchd service remained loaded after promotion pause");
      return;
    }
    case "systemd":
      for (const unit of ["tweaker-watcher.path", "tweaker-watcher.timer", "tweaker-watcher.service"]) {
        try { execFileSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" }); } catch {}
      }
      if (systemdUnitActive("tweaker-watcher.path")) {
        throw new Error("Watcher systemd path remained active after promotion pause");
      }
      return;
    case "scheduled-task":
      for (const name of currentWindowsWatcherTaskNames()) {
        try { execFileSync("schtasks.exe", ["/End", "/TN", name], { stdio: "ignore" }); } catch {}
        try { execFileSync("schtasks.exe", ["/Change", "/Disable", "/TN", name], { stdio: "ignore" }); } catch {}
      }
      return;
    case "login-item":
    case "none":
      return;
  }
}

/** Rebind triggers to the promoted app, restoring the prior loaded/enabled state. */
export function resumeWatcherAfterPromotion(
  appRoot: string,
  snapshot: WatcherPromotionSnapshot,
): WatcherKind {
  if (!snapshot.configured) return "none";
  switch (snapshot.watcherKind) {
    case "launchd": {
      const path = writeLaunchdDefinition(appRoot);
      const domain = launchdGuiDomain();
      if (snapshot.loaded) {
        if (!bootstrapLaunchd(path)) throw new Error("Could not reload watcher launchd service after promotion");
        if (!launchdServiceLoaded()) throw new Error("Watcher launchd service was not loaded after promotion resume");
      }
      if (domain && snapshot.enabled) {
        try { execFileSync("launchctl", ["enable", `${domain}/${LABEL}`], { stdio: "ignore" }); } catch {}
      } else if (domain) {
        try { execFileSync("launchctl", ["disable", `${domain}/${LABEL}`], { stdio: "ignore" }); } catch {}
      }
      return "launchd";
    }
    case "systemd": {
      writeSystemdDefinitions(appRoot);
      try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); } catch {}
      if (snapshot.enabled) {
        for (const unit of ["tweaker-watcher.service", "tweaker-watcher.timer", "tweaker-watcher.path"]) {
          try { execFileSync("systemctl", ["--user", "enable", unit], { stdio: "ignore" }); } catch {}
        }
      }
      if (snapshot.loaded) {
        for (const unit of ["tweaker-watcher.timer", "tweaker-watcher.path"]) {
          try { execFileSync("systemctl", ["--user", "start", unit], { stdio: "ignore" }); } catch {}
        }
        if (!systemdUnitActive("tweaker-watcher.path")) {
          throw new Error("Watcher systemd path was not active after promotion resume");
        }
      }
      return "systemd";
    }
    case "scheduled-task":
      installScheduledTask(appRoot);
      if (!snapshot.enabled) {
        for (const name of currentWindowsWatcherTaskNames()) {
          try { execFileSync("schtasks.exe", ["/Change", "/Disable", "/TN", name], { stdio: "ignore" }); } catch {}
        }
      }
      return "scheduled-task";
    case "login-item":
    case "none":
      return snapshot.watcherKind;
  }
}

export function installWatcher(appRoot: string): WatcherKind {
  switch (platform()) {
    case "darwin":
      return installLaunchd(appRoot);
    case "linux":
      return installSystemd(appRoot);
    case "win32":
      return installScheduledTask(appRoot);
    default:
      return "none";
  }
}

export function uninstallWatcher(): void {
  switch (platform()) {
    case "darwin":
      return uninstallLaunchd();
    case "linux":
      return uninstallSystemd();
    case "win32":
      return uninstallScheduledTask();
  }
}

const LABEL = "com.therealityreport.tweakers.watcher";
// WatchPaths (app.asar changes) + RunAtLoad (login) are the real repair
// triggers. StartInterval is only a coarse safety net so a missed FSEvent still
// self-heals within the hour instead of hammering the CLI every 5 minutes. This
// same value feeds the systemd timer (OnUnitActiveSec) and the schtasks /MO
// interval below, so keep it in whole minutes.
const WATCHER_INTERVAL_SECONDS = 60 * 60;
export const WINDOWS_WATCHER_LOGON_TASK_NAME = "tweaker-watcher";
export const WINDOWS_WATCHER_INTERVAL_TASK_NAME = "tweaker-watcher-interval";
const WINDOWS_WATCHER_RETIRED_TASK_NAMES = [
  "tweaker-watcher-hourly",
  "tweaker-watcher-daily",
];

function launchdPath(): string {
  return join(targetUserHome(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchdLogPath(): string {
  return join(targetUserHome(), "Library", "Logs", "tweaker-watcher.log");
}

function installLaunchd(appRoot: string): WatcherKind {
  const deferReload = isRunningFromWatcher();
  if (!deferReload) removeLegacyLaunchdWatcher();

  const plPath = writeLaunchdDefinition(appRoot);
  // A running watcher may refresh its plist on disk, but must never boot out
  // the service that owns the current cycle. The next non-watcher repair (or
  // login) loads the new definition; health reports this transition as pending.
  if (deferReload) return "launchd";
  if (!bootstrapLaunchd(plPath)) {
    try {
      execLaunchctlForTargetUser(["unload", plPath]);
    } catch {}
    execLaunchctlForTargetUser(["load", plPath]);
  }
  return "launchd";
}

function writeLaunchdDefinition(appRoot: string): string {
  const plPath = launchdPath();
  mkdirSync(dirname(plPath), { recursive: true });
  const logPath = launchdLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  // Trigger on login + when Codex.app's asar changes. Run this installed CLI
  // directly so auto-repair does not depend on npm availability. The CLI
  // throttles GitHub release checks, so this interval keeps app repair prompt.
  const repair = xmlEscape(watcherShellScript(logPath));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${repair}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${WATCHER_INTERVAL_SECONDS}</integer>
  <key>WatchPaths</key>
  <array>
    <string>${appRoot}/Contents/Resources/app.asar</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>120</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  </dict>
</plist>`;
  writeFileSync(plPath, xml);
  writeFileSync(logPath, "", { flag: "a" });
  chownForTargetUser(plPath);
  chownForTargetUser(logPath);
  return plPath;
}

export function isRunningFromWatcher(): boolean {
  return process.env.TWEAKER_WATCHER === "1"
    || process.env[LEGACY_WATCHER_ENV] === "1"
    || process.env.XPC_SERVICE_NAME === LABEL;
}

function uninstallLaunchd(): void {
  removeLegacyLaunchdWatcher();
  const plPath = launchdPath();
  if (!existsSync(plPath)) return;
  bootoutLaunchd(plPath);
  try {
    execLaunchctlForTargetUser(["unload", plPath]);
  } catch {}
  rmSync(plPath, { force: true });
}

function removeLegacyLaunchdWatcher(): void {
  const path = join(targetUserHome(), "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`);
  if (!existsSync(path)) return;
  bootoutLaunchd(path);
  try { execLaunchctlForTargetUser(["unload", path]); } catch {}
  rmSync(path, { force: true });
}

function bootstrapLaunchd(plPath: string): boolean {
  const domain = launchdGuiDomain();
  if (!domain) return false;
  bootoutLaunchd(plPath);
  try {
    execFileSync("launchctl", ["bootstrap", domain, plPath], { stdio: "ignore" });
    execFileSync("launchctl", ["enable", `${domain}/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bootoutLaunchd(plPath: string): void {
  const domain = launchdGuiDomain();
  if (!domain) return;
  try {
    execFileSync("launchctl", ["bootout", domain, plPath], { stdio: "ignore" });
  } catch {}
}

function launchdGuiDomain(): string | null {
  const uid = targetUserOwnership()?.uid ?? (typeof process.getuid === "function" ? process.getuid() : userInfo().uid);
  return typeof uid === "number" ? `gui/${uid}` : null;
}

function launchdServiceLoaded(): boolean {
  const domain = launchdGuiDomain();
  if (!domain) return false;
  try {
    execFileSync("launchctl", ["print", `${domain}/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function launchdServiceEnabled(): boolean {
  const domain = launchdGuiDomain();
  if (!domain) return false;
  try {
    const output = execFileSync("launchctl", ["print-disabled", domain], { encoding: "utf8" });
    const escaped = LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`[\"']?${escaped}[\"']?\\s*=>\\s*(true|false)`));
    return match?.[1] !== "true";
  } catch {
    return true;
  }
}

function execLaunchctlForTargetUser(args: string[]): void {
  const owner = targetUserOwnership();
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (owner && currentUid === 0 && owner.uid !== 0) {
    execFileSync("launchctl", ["asuser", String(owner.uid), "launchctl", ...args], {
      stdio: "ignore",
    });
    return;
  }
  execFileSync("launchctl", args, { stdio: "ignore" });
}

function installSystemd(appRoot: string): WatcherKind {
  const dir = writeSystemdDefinitions(appRoot);
  removeSystemdWatcherUnits(dir, LEGACY_WATCHER_STEM);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "tweaker-watcher.service"], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "enable", "--now", "tweaker-watcher.timer"], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "enable", "--now", "tweaker-watcher.path"], {
      stdio: "ignore",
    });
  } catch {
    /* systemd may not be available */
  }
  return "systemd";
}

function systemdWatcherDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function systemdWatcherPath(): string {
  return join(systemdWatcherDir(), "tweaker-watcher.path");
}

function writeSystemdDefinitions(appRoot: string): string {
  const dir = systemdWatcherDir();
  mkdirSync(dir, { recursive: true });
  const repair = shellSingleQuote(watcherShellScript());
  const unit = `[Unit]
Description=tweaker repair watcher

[Service]
Type=oneshot
ExecStart=/bin/sh -c ${repair}

[Install]
WantedBy=default.target
`;
  writeFileSync(join(dir, "tweaker-watcher.service"), unit);
  writeFileSync(join(dir, "tweaker-watcher.timer"), `[Unit]
Description=tweaker repair watcher interval

[Timer]
OnBootSec=5m
OnUnitActiveSec=${Math.round(WATCHER_INTERVAL_SECONDS / 60)}m
Persistent=true

[Install]
WantedBy=timers.target
`);
  writeFileSync(join(dir, "tweaker-watcher.path"), `[Unit]
Description=tweaker app.asar watcher

[Path]
PathChanged=${appRoot}/resources/app.asar

[Install]
WantedBy=default.target
`);
  return dir;
}

function systemdUnitActive(unit: string): boolean {
  try {
    execFileSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function systemdUnitEnabled(unit: string): boolean {
  try {
    execFileSync("systemctl", ["--user", "is-enabled", "--quiet", unit], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function uninstallSystemd(): void {
  const dir = join(homedir(), ".config", "systemd", "user");
  removeSystemdWatcherUnits(dir, "tweaker-watcher");
  removeSystemdWatcherUnits(dir, LEGACY_WATCHER_STEM);
}

function removeSystemdWatcherUnits(dir: string, stem: string): void {
  try {
    execFileSync("systemctl", ["--user", "disable", `${stem}.service`], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "disable", "--now", `${stem}.path`], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "disable", "--now", `${stem}.timer`], {
      stdio: "ignore",
    });
  } catch {}
  for (const suffix of ["service", "path", "timer"]) {
    rmSync(join(dir, `${stem}.${suffix}`), { force: true });
  }
}

function installScheduledTask(_appRoot: string): WatcherKind {
  // schtasks.exe creates a logon-trigger task. We pass the watcher command via /TR.
  const repair = windowsWatcherTaskCommand();
  try {
    for (const name of legacyWindowsWatcherTaskNames()) deleteScheduledTask(name);
    execFileSync("schtasks.exe", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      WINDOWS_WATCHER_LOGON_TASK_NAME,
      "/TR",
      repair,
    ]);
    deleteScheduledTask(WINDOWS_WATCHER_INTERVAL_TASK_NAME);
    execFileSync("schtasks.exe", [
      "/Create",
      "/F",
      "/SC",
      "MINUTE",
      "/MO",
      String(Math.round(WATCHER_INTERVAL_SECONDS / 60)),
      "/TN",
      WINDOWS_WATCHER_INTERVAL_TASK_NAME,
      "/TR",
      repair,
    ]);
    return "scheduled-task";
  } catch {
    return "none";
  }
}

function cliShellCommand(command: string, args: string[] = [], cli = managedCliPath(userPaths().root)): string {
  return [
    "TWEAKER_WATCHER=1",
    shellQuote(process.execPath),
    ...nodeExecArgsForCli(cli).map(shellQuote),
    shellQuote(cli),
    command,
    ...args,
  ].join(" ");
}

export function watcherShellScript(logPath?: string, cli = managedCliPath(userPaths().root)): string {
  const commands = [
    "sleep 3",
    `printf '\\n[%s] Tweakers watcher start\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    cliShellCommand("watcher-run", [], cli),
  ];
  if (logPath) commands.unshift(`touch ${shellSingleQuote(logPath)}`);
  return commands.join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function windowsCommand(command: string, args: string[] = []): string {
  const cli = managedCliPath(userPaths().root);
  return [
    windowsQuote(process.execPath),
    ...nodeExecArgsForCli(cli).map(windowsQuote),
    windowsQuote(cli),
    command,
    ...args,
  ].join(" ");
}

function nodeExecArgsForCli(cliPath: string): string[] {
  return cliPath.endsWith(".ts") ? process.execArgv : [];
}

function windowsWatcherTaskCommand(): string {
  const scriptPath = join(windowsTweakerDir(), "bin", "watcher.cmd");
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(
    scriptPath,
    [
      "@echo off",
      "set TWEAKER_WATCHER=1",
      `${windowsCommand("watcher-run")}`,
      "exit /b 0",
      "",
    ].join("\r\n"),
  );
  return windowsQuote(scriptPath);
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, `\\"`)}"`;
}

function windowsTweakerDir(): string {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "tweaker");
}

function uninstallScheduledTask(): void {
  for (const name of currentWindowsWatcherTaskNames()) deleteScheduledTask(name);
  for (const name of legacyWindowsWatcherTaskNames()) deleteScheduledTask(name);
}

export function currentWindowsWatcherTaskNames(): string[] {
  return [WINDOWS_WATCHER_LOGON_TASK_NAME, WINDOWS_WATCHER_INTERVAL_TASK_NAME];
}

export function legacyWindowsWatcherTaskNames(): string[] {
  return [
    ...WINDOWS_WATCHER_RETIRED_TASK_NAMES,
    ...["", "-interval", "-hourly", "-daily"].map((suffix) => `${LEGACY_WATCHER_STEM}${suffix}`),
  ];
}

function deleteScheduledTask(name: string): void {
  for (const taskName of [name, `\\${name}`]) {
    try {
      execFileSync("schtasks.exe", ["/End", "/TN", taskName], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("schtasks.exe", ["/Change", "/Disable", "/TN", taskName], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("schtasks.exe", ["/Delete", "/F", "/TN", taskName], {
        stdio: "ignore",
      });
    } catch {}
  }
}

function windowsTaskExists(name: string): boolean {
  try {
    execFileSync("schtasks.exe", ["/Query", "/TN", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

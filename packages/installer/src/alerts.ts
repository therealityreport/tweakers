import { execFileSync, spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readPlist } from "./plist.js";
import { CODEX_PLUSPLUS_VERSION } from "./version.js";
import { locateCodex } from "./platform.js";
import { getOpenReport, reportsMainProcessRunning, type OpenReport } from "./commands/debug.js";
import { isRunningFromWatcher } from "./watcher.js";

const CODEX_BUNDLE_ID = "com.openai.codex";
const CODEX_PLUSPLUS_REPO_URL = "https://github.com/therealityreport/tweakers";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
let alertExecFileSync: typeof execFileSync = execFileSync;

export function setAlertExecFileSyncForTest(exec: typeof execFileSync): () => void {
  const previous = alertExecFileSync;
  alertExecFileSync = exec;
  return () => {
    alertExecFileSync = previous;
  };
}

export function showPatchFailedAlert(errorMessage: string): void {
  if (isMacAppManagementError(errorMessage)) {
    showAppManagementPatchFailedAlert(errorMessage);
    return;
  }

  const title = "Tweakers could not patch Codex";
  const message =
    "Codex was updated, but Tweakers could not reapply itself automatically.\n\n" +
    `${errorMessage}\n\n` +
    "Run tweakers repair from Terminal after Codex finishes updating, or report this failure on GitHub.";
  if (isRunningFromWatcher()) {
    showNotification({ title, message: firstLine(message) });
    return;
  }

  const button = showAlert({
    title,
    message,
    buttons: ["Dismiss", "Report on GitHub"],
    defaultButton: "Dismiss",
    critical: true,
  });

  if (button === "Report on GitHub") {
    openUrl(buildPatchFailureIssueUrl(errorMessage));
  }
}

function showAppManagementPatchFailedAlert(errorMessage: string): void {
  const title = "Tweakers needs app repair";
  const message = 'Run "tweakers repair" in your terminal.';
  if (isRunningFromWatcher()) {
    showNotification({ title, message: firstLine(message) });
    return;
  }

  const button = showAlert({
    title,
    message,
    buttons: ["Dismiss", "Report Issue on GitHub"],
    defaultButton: "Dismiss",
    critical: true,
  });

  if (button === "Report Issue on GitHub") {
    openUrl(buildPatchFailureIssueUrl(errorMessage));
  }
}

export function showUpdateModePausedAlert(appRoot: string, codexVersion: string | null): void {
  if (platform() !== "darwin") return;

  showAlert({
    title: "Tweakers is waiting for Codex to update",
    message:
      "Tweakers is paused while Codex installs its update.\n\n" +
      `Current Codex: ${codexVersion ?? "unknown"}\n\n` +
      "After the update finishes, Tweakers will patch itself again.",
    buttons: ["OK"],
    defaultButton: "OK",
    timeoutSeconds: 20,
    iconPath: codexIconPath(appRoot),
  });
}

export function showCodexUpdateDetectedNotification(): void {
  if (platform() !== "darwin") return;

  showNotification({
    title: "Codex update detected",
    message: "Tweakers is checking the app, then it will patch itself.",
  });
}

export function promptRestartCodexAfterPatch(appRoot: string): void {
  if (platform() !== "darwin") return;

  const button = showAlert({
    title: "Tweakers needs to restart Codex",
    message:
      "Tweakers re-patched Codex on disk, but the open Codex window is still running the old app code.\n\n" +
      "Restart Codex now to finish loading Tweakers.",
    buttons: ["Later", "Quit and Restart Codex"],
    defaultButton: "Quit and Restart Codex",
    timeoutSeconds: 120,
    iconPath: codexIconPath(appRoot),
  });

  if (button !== "Quit and Restart Codex") return;
  quitAndRestartCodex(appRoot);
}

export function promptRestartCodexAfterRuntimeUpdate(appRoot: string, version: string): void {
  if (platform() !== "darwin") return;

  const button = showAlert({
    title: "Tweakers needs to restart Codex",
    message:
      `Tweakers updated its runtime to v${version}, but the open Codex window is still running the previous Tweakers code.\n\n` +
      "Restart Codex now to load the updated Tweakers runtime.",
    buttons: ["Later", "Quit and Restart Codex"],
    defaultButton: "Quit and Restart Codex",
    timeoutSeconds: 120,
    iconPath: codexIconPath(appRoot),
  });

  if (button !== "Quit and Restart Codex") return;
  quitAndRestartCodex(appRoot);
}

export function promptRestartCodexToRepatch(appRoot: string): boolean {
  if (platform() !== "darwin") return true;

  const button = showAlert({
    title: "Tweakers needs to restart Codex",
    message:
      "Codex is running without the latest Tweakers patch.\n\n" +
      "Tweakers needs to quit Codex, re-patch the app, then reopen it.",
    buttons: ["Later", "Restart and Re-Patch"],
    defaultButton: "Restart and Re-Patch",
    timeoutSeconds: 120,
    iconPath: codexIconPath(appRoot),
  });

  if (button !== "Restart and Re-Patch") return false;
  quitCodex(appRoot);
  return true;
}

/**
 * Interactive confirmation for `tweakers mode <target>` (skipped by --yes).
 * The copy discloses the TCC re-grant expectation: alternating signers on one
 * bundle id invalidates the other mode's Accessibility/Screen Recording grants.
 */
export function confirmModeSwitch(input: { target: "chatgpt" | "tweakers"; appRoot: string }): boolean {
  if (platform() !== "darwin") return false;
  const toChatgpt = input.target === "chatgpt";
  const confirmButton = toChatgpt ? "Switch to ChatGPT" : "Switch to Tweakers";
  const button = showAlert({
    title: toChatgpt ? "Switch to ChatGPT mode?" : "Switch to Tweakers mode?",
    message: toChatgpt
      ? "ChatGPT will quit and restart as the pristine official app.\n\n" +
        "Tweaks turn off; the Chrome-extension bridge turns back on.\n" +
        "macOS may ask you to re-grant permissions such as Accessibility and Screen Recording after the switch."
      : "ChatGPT will quit and restart with Tweakers enabled.\n\n" +
        "The Chrome-extension bridge stops working in Tweakers mode.\n" +
        "macOS may ask you to re-grant permissions such as Accessibility and Screen Recording after the switch.",
    buttons: ["Cancel", confirmButton],
    defaultButton: confirmButton,
    iconPath: codexIconPath(input.appRoot),
  });
  return button === confirmButton;
}

interface OpenCodexOptions {
  detached?: boolean;
  delayMs?: number;
}

export function openCodex(appRoot: string, opts: OpenCodexOptions = {}): void {
  if (platform() !== "darwin") return;
  const bundleId = codexBundleId(appRoot);
  if (opts.detached) {
    spawnDetachedReopen(appRoot, bundleId, opts.delayMs ?? 750);
    return;
  }

  reconcileLaunchServices(appRoot);
  try {
    alertExecFileSync("open", [appRoot], { stdio: "ignore" });
  } catch {}
}

function reconcileLaunchServices(appRoot: string): void {
  try {
    alertExecFileSync(LSREGISTER, ["-f", appRoot], { stdio: "ignore" });
  } catch {}
}

export function isCodexRunning(appRoot: string): boolean {
  try {
    return isCodexMainProcessRunning(appRoot);
  } catch {
    return false;
  }
}

function spawnDetachedReopen(appRoot: string, bundleId: string, delayMs: number): void {
  const child = spawn("osascript", ["-e", codexReopenScript(appRoot, bundleId, delayMs)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function codexReopenScript(appRoot: string, bundleId: string, delayMs: number): string {
  const delaySeconds = Math.max(0, delayMs) / 1000;
  const reconcileByPath = `${LSREGISTER} -f ${shellQuote(appRoot)}`;
  const openByPath = `/usr/bin/open ${shellQuote(appRoot)}`;
  return [
    `delay ${delaySeconds.toFixed(2)}`,
    "try",
    `do shell script ${appleScriptString(reconcileByPath)}`,
    "end try",
    `do shell script ${appleScriptString(openByPath)}`,
    "delay 0.50",
    "try",
    `tell application id ${appleScriptString(bundleId)} to activate`,
    "end try",
  ].join("\n");
}

interface AlertOptions {
  title: string;
  message: string;
  buttons?: string[];
  defaultButton?: string;
  critical?: boolean;
  timeoutSeconds?: number;
  iconPath?: string;
}

function showAlert(opts: AlertOptions): string | null {
  if (platform() !== "darwin") return null;

  return runAlertScript(alertScript(opts), opts);
}

function showNotification(opts: Pick<AlertOptions, "title" | "message">): void {
  try {
    alertExecFileSync(
      "osascript",
      [
        "-e",
        `display notification ${appleScriptString(opts.message)} with title ${appleScriptString(opts.title)}`,
      ],
      { stdio: "ignore" },
    );
  } catch {}
}

function alertScript(opts: AlertOptions): string {
  const buttons = opts.buttons ?? ["OK"];
  const defaultButton = opts.defaultButton ?? buttons.at(-1) ?? "OK";
  const lines = [
    `set alertTitle to system attribute "CODEXPP_ALERT_TITLE"`,
    `set alertMessage to system attribute "CODEXPP_ALERT_MESSAGE"`,
    `set alertButtons to {${buttons.map(appleScriptString).join(", ")}}`,
  ];
  if (opts.iconPath) {
    lines.push(
      `display dialog alertMessage with title alertTitle buttons alertButtons default button ${appleScriptString(defaultButton)} with icon POSIX file ${appleScriptString(opts.iconPath)}${opts.timeoutSeconds ? ` giving up after ${opts.timeoutSeconds}` : ""}`,
    );
  } else {
    lines.push(
      `display alert alertTitle message alertMessage buttons alertButtons default button ${appleScriptString(defaultButton)}${opts.critical ? " as critical" : ""}${opts.timeoutSeconds ? ` giving up after ${opts.timeoutSeconds}` : ""}`,
    );
  }
  return lines.join("\n");
}

function runAlertScript(script: string, opts: AlertOptions): string | null {
  try {
    const out = alertExecFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEXPP_ALERT_TITLE: opts.title,
        CODEXPP_ALERT_MESSAGE: opts.message,
      },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseAlertButton(out);
  } catch {
    return null;
  }
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? message;
}

function parseAlertButton(output: string): string | null {
  if (/gave up:true/.test(output)) return null;
  return output.match(/button returned:([^,\n]+)/)?.[1]?.trim() ?? null;
}

function codexIconPath(appRoot: string): string {
  return join(appRoot, "Contents", "Resources", "electron.icns");
}

function quitAndRestartCodex(appRoot: string): void {
  quitCodex(appRoot);
  openCodex(appRoot, { detached: true, delayMs: 750 });
}

export function quitCodex(appRoot: string): void {
  try {
    execFileSync("osascript", ["-e", `tell application id ${appleScriptString(codexBundleId(appRoot))} to quit`], {
      stdio: "ignore",
    });
  } catch {}

  const started = Date.now();
  while (Date.now() - started < 8_000 && isCodexMainProcessRunning(appRoot)) {
    try {
      execFileSync("sleep", ["0.5"], { stdio: "ignore" });
    } catch {
      break;
    }
  }

  if (isCodexMainProcessRunning(appRoot)) {
    terminateCodexMainProcess(appRoot);
    const terminatedAt = Date.now();
    while (Date.now() - terminatedAt < 3_000 && isCodexMainProcessRunning(appRoot)) {
      try {
        execFileSync("sleep", ["0.25"], { stdio: "ignore" });
      } catch {
        break;
      }
    }
  }
}

export function isCodexMainProcessRunning(appRoot: string): boolean {
  const report = codexOpenReport(appRoot);
  return report !== null && reportsMainProcessRunning(report);
}

function terminateCodexMainProcess(appRoot: string): void {
  const report = codexOpenReport(appRoot);
  if (!report?.pid || report.hasMainProcess === false) return;
  try {
    process.kill(report.pid, "SIGTERM");
  } catch {}
}

function codexOpenReport(appRoot: string): OpenReport | null {
  try {
    return getOpenReport(locateCodex(appRoot));
  } catch {
    return null;
  }
}

export function buildPatchFailureIssueUrl(errorMessage: string): string {
  const title = "Tweakers failed to patch Codex after update";
  const body = [
    "## Summary",
    "Tweakers could not reapply its patch after Codex updated.",
    "",
    "## Error",
    "```text",
    trimIssueError(errorMessage),
    "```",
    "",
    "## Environment",
    `- Platform: ${process.platform}`,
    `- Arch: ${process.arch}`,
    `- Node: ${process.version}`,
    "",
    "## Debugging context",
    "- Codex app path: ",
    "- Codex version shown in app, if known: ",
    "- Was Codex running during the update? ",
    "- Did rerunning `tweakers repair` change the result? ",
  ].join("\n");

  const params = new URLSearchParams({ title, body });
  return `${CODEX_PLUSPLUS_REPO_URL}/issues/new?${params.toString()}`;
}

export function buildCliFailureIssueUrl(command: string | undefined, errorMessage: string): string {
  const commandLabel = command?.trim() || "(unknown command)";
  const title = `Tweakers ${commandLabel} failed`;
  const body = [
    "## Summary",
    `\`tweakers ${commandLabel}\` failed.`,
    "",
    "## Command",
    "```text",
    `tweakers ${commandLabel}`,
    "```",
    "",
    "## Error",
    "```text",
    trimIssueError(errorMessage),
    "```",
    "",
    "## Environment",
    `- Tweakers: ${CODEX_PLUSPLUS_VERSION}`,
    `- Platform: ${process.platform}`,
    `- Arch: ${process.arch}`,
    `- Node: ${process.version}`,
    "",
    "## Debugging context",
    "- Codex app path, if shown: ",
    "- Install source: ",
    "- Did rerunning the command change the result? ",
    "- Any recent Codex or Tweakers update? ",
  ].join("\n");

  const params = new URLSearchParams({ title, body });
  return `${CODEX_PLUSPLUS_REPO_URL}/issues/new?${params.toString()}`;
}

function trimIssueError(errorMessage: string): string {
  const trimmed = errorMessage.trim() || "(empty error message)";
  const maxLength = 4000;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n... truncated ...`;
}

export function isMacAppManagementError(errorMessage: string): boolean {
  return /macOS App Management is blocking modification/.test(errorMessage);
}

function openUrl(url: string): void {
  if (platform() !== "darwin") return;
  try {
    execFileSync("open", [url], { stdio: "ignore" });
  } catch {}
}

function codexBundleId(appRoot: string): string {
  const info = join(appRoot, "Contents", "Info.plist");
  if (!existsSync(info)) return CODEX_BUNDLE_ID;
  try {
    const plist = readPlist(info);
    return typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : CODEX_BUNDLE_ID;
  } catch {
    return CODEX_BUNDLE_ID;
  }
}

function appleScriptString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

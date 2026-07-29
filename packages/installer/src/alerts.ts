import { execFileSync, spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { extractFile, listPackage } from "@electron/asar";
import { readPlist } from "./plist.js";
import { TWEAKER_VERSION } from "./version.js";
import { locateCodexAtExactPath, type CodexInstall } from "./platform.js";
import { getOpenReport, reportsMainProcessRunning, type OpenReport } from "./commands/debug.js";
import { isRunningFromWatcher } from "./watcher.js";

const CODEX_BUNDLE_ID = "com.openai.codex";
const TWEAKER_REPO_URL = "https://github.com/therealityreport/tweakers";
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
    "Run tweaker repair from Terminal after Codex finishes updating, or report this failure on GitHub.";
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
  const message = 'Run "tweaker repair" in your terminal.';
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

export const AUTOMATION_PERMISSION_GUIDANCE =
  "Open System Settings > Privacy & Security > Automation, then allow the app running Tweakers " +
  "(ChatGPT, Menu Bar, or Terminal) to control System Events.";

export type NativeUpdateHandoffFailureKind =
  | "unsupported_platform"
  | "process_not_proven"
  | "window_not_visible"
  | "automation_permission_denied"
  | "menu_item_not_found"
  | "menu_item_disabled"
  | "script_failed";

export type NativeUpdateHandoffResult =
  | { ok: true }
  | {
      ok: false;
      kind: NativeUpdateHandoffFailureKind;
      message: string;
      permissionGuidance: string | null;
    };

export function showUpdateModePausedAlert(
  appRoot: string,
  codexVersion: string | null,
  handoffFailure?: Exclude<NativeUpdateHandoffResult, { ok: true }>,
): void {
  if (platform() !== "darwin") return;

  const handoffDetail = handoffFailure
    ? `\n\nAutomatic handoff failed: ${handoffFailure.message}` +
      (handoffFailure.permissionGuidance ? `\n\n${handoffFailure.permissionGuidance}` : "")
    : "";

  showAlert({
    title: handoffFailure
      ? "ChatGPT's updater needs attention"
      : "Pristine ChatGPT is ready for its update",
    message:
      "Pristine ChatGPT is active, and OpenAI's native updater owns the installation.\n\n" +
      `Current ChatGPT desktop: ${codexVersion ?? "unknown"}\n\n` +
      "If the update window does not appear automatically, choose ChatGPT > Check for Updates..." +
      handoffDetail + "\n\n" +
      "After OpenAI's updater finishes, Tweakers can return to your selected environment.",
    buttons: ["OK"],
    defaultButton: "OK",
    timeoutSeconds: 20,
    iconPath: codexIconPath(appRoot),
  });
}

export interface RequestCodexNativeUpdateDeps {
  observe?: (appRoot: string) => CodexMainProcessObservation | null;
  exec?: typeof execFileSync;
  locale?: () => string;
  readLocaleMessages?: (appRoot: string, locale: string) => Record<string, unknown> | null;
}

/**
 * Ask the exact, already-verified official ChatGPT process to open its native
 * updater. The environment transaction supplies the PID it just committed, so
 * this can never fall through to another installed ChatGPT channel.
 */
export function requestCodexNativeUpdate(
  appRoot: string,
  expectedPid: number,
  deps: RequestCodexNativeUpdateDeps = {},
): NativeUpdateHandoffResult {
  if (platform() !== "darwin") {
    return nativeUpdateHandoffFailure(
      "unsupported_platform",
      "OpenAI's native desktop updater is available only on macOS.",
    );
  }
  const observed = (deps.observe ?? observeCodexMainProcess)(appRoot);
  if (observed === null || observed.pid !== expectedPid) {
    return nativeUpdateHandoffFailure(
      "process_not_proven",
      `The exact ChatGPT process ${expectedPid} could not be proven at ${appRoot}.`,
    );
  }
  if (!observed.visibleWindow) {
    return nativeUpdateHandoffFailure(
      "window_not_visible",
      "The exact ChatGPT process is running, but it does not have a visible window.",
    );
  }

  const bundleId = codexBundleId(appRoot);
  const locale = (deps.locale ?? preferredNativeMenuLocale)();
  const messages = (deps.readLocaleMessages ?? readNativeMenuLocaleMessages)(appRoot, locale);
  const candidateNames = nativeUpdateMenuCandidates(messages);
  const script = [
    'tell application "System Events"',
    `set targetProcesses to every application process whose unix id is ${expectedPid}`,
    'if (count of targetProcesses) is not 1 then error "exact process not found"',
    "set targetProcess to item 1 of targetProcesses",
    `if bundle identifier of targetProcess is not ${appleScriptString(bundleId)} then error "bundle mismatch"`,
    "set frontmost of targetProcess to true",
    `set candidateNames to {${candidateNames.map(appleScriptString).join(", ")}}`,
    "set appMenu to menu 1 of menu bar item 2 of menu bar 1 of targetProcess",
    "set updateItem to missing value",
    // Bulk name enumeration is reliable even when the menu has never been
    // opened; a `whose name is` filter against the same lazily-populated AX
    // tree is nondeterministic and produced false MENU_NOT_FOUND failures.
    "set itemNames to name of every menu item of appMenu",
    "repeat with itemIndex from 1 to count of itemNames",
    "set itemName to item itemIndex of itemNames",
    "if itemName is not missing value then",
    "repeat with candidateName in candidateNames",
    "if (itemName as text) is equal to (candidateName as text) then",
    "set updateItem to menu item itemIndex of appMenu",
    "exit repeat",
    "end if",
    "end repeat",
    "end if",
    "if updateItem is not missing value then exit repeat",
    "end repeat",
    "if updateItem is missing value then",
    "try",
    "if (count of menu items of appMenu) is at least 5 then",
    "set beforeItem to menu item 2 of appMenu",
    "set orderedItem to menu item 4 of appMenu",
    "set afterItem to menu item 5 of appMenu",
    "set beforeSubrole to value of attribute \"AXSubrole\" of beforeItem",
    "set afterSubrole to value of attribute \"AXSubrole\" of afterItem",
    "if beforeSubrole is \"AXSeparator\" and afterSubrole is \"AXSeparator\" then set updateItem to orderedItem",
    "end if",
    "end try",
    "end if",
    'if updateItem is missing value then error "TWEAKERS_MENU_NOT_FOUND" number 1708',
    'if enabled of updateItem is false then error "TWEAKERS_MENU_DISABLED" number 1709',
    "click updateItem",
    "end tell",
  ].join("\n");

  try {
    (deps.exec ?? alertExecFileSync)("osascript", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (error) {
    const detail = childProcessErrorText(error);
    if (isAutomationPermissionDenied(detail)) {
      return nativeUpdateHandoffFailure(
        "automation_permission_denied",
        "macOS denied Automation access while Tweakers tried to open ChatGPT's updater.",
        AUTOMATION_PERMISSION_GUIDANCE,
      );
    }
    if (/TWEAKERS_MENU_NOT_FOUND/i.test(detail)) {
      return nativeUpdateHandoffFailure(
        "menu_item_not_found",
        "ChatGPT's native update menu item could not be found.",
      );
    }
    if (/TWEAKERS_MENU_DISABLED/i.test(detail)) {
      return nativeUpdateHandoffFailure(
        "menu_item_disabled",
        "ChatGPT's native update menu item is currently disabled.",
      );
    }
    return nativeUpdateHandoffFailure(
      "script_failed",
      `ChatGPT's native update menu could not be opened${detail ? `: ${firstLine(detail)}` : "."}`,
    );
  }
}

function nativeUpdateHandoffFailure(
  kind: NativeUpdateHandoffFailureKind,
  message: string,
  permissionGuidance: string | null = null,
): Exclude<NativeUpdateHandoffResult, { ok: true }> {
  return { ok: false, kind, message, permissionGuidance };
}

function preferredNativeMenuLocale(): string {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en-US";
  const locale = raw.split(".", 1)[0]?.replace(/_/g, "-") ?? "en-US";
  return /^(?:C|POSIX)$/i.test(locale) ? "en-US" : locale;
}

function readNativeMenuLocaleMessages(appRoot: string, locale: string): Record<string, unknown> | null {
  const asarPath = join(appRoot, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) return null;
  try {
    const available = listPackage(asarPath, { isPack: false })
      .filter((entry) => /^\/native-menu-locales\/[^/]+\.json$/i.test(entry));
    const normalized = locale.toLowerCase();
    const language = normalized.split("-", 1)[0] ?? normalized;
    const match = available.find((entry) => entry.toLowerCase() === `/native-menu-locales/${normalized}.json`)
      ?? available.find((entry) => entry.toLowerCase().startsWith(`/native-menu-locales/${language}-`))
      ?? available.find((entry) => entry.toLowerCase() === `/native-menu-locales/${language}.json`);
    if (!match) return null;
    const parsed: unknown = JSON.parse(extractFile(asarPath, match.slice(1)).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nativeUpdateMenuCandidates(messages: Record<string, unknown> | null): string[] {
  const candidates: string[] = [];
  if (messages) {
    for (const [key, value] of Object.entries(messages)) {
      if (!/update/i.test(key) || typeof value !== "string") continue;
      const label = value.trim();
      if (!label || label.length > 80 || /[\r\n{}]/.test(label)) continue;
      candidates.push(label, label.replace(/\.\.\.$/, "…"), label.replace(/…$/, "..."));
    }
  }
  candidates.push("Update Available…", "Check for Updates…", "Update Available...", "Check for Updates...");
  return [...new Set(candidates)];
}

function childProcessErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? "");
  const withOutput = error as Error & { stderr?: unknown; stdout?: unknown; status?: unknown; code?: unknown };
  return [withOutput.message, withOutput.stderr, withOutput.stdout, withOutput.status, withOutput.code]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(String)
    .join("\n");
}

function isAutomationPermissionDenied(detail: string): boolean {
  return /(?:-1743|not authorized to send apple events|not allowed assistive access|automation access|accessibility access|not permitted to send apple events)/i.test(detail);
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
 * Interactive confirmation for `tweaker mode <target>` (skipped by --yes).
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

/** Open the exact app path and explicitly activate it before restart verification. */
export function openAndActivateCodex(appRoot: string): void {
  if (platform() !== "darwin") return;
  const bundleId = codexBundleId(appRoot);
  alertExecFileSync("osascript", ["-e", codexReopenScript(appRoot, bundleId, 0)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

export interface CodexMainProcessObservation {
  pid: number;
  visibleWindow: boolean;
}

export interface QuitCodexMainProcessDeps {
  observe?: (appRoot: string) => CodexMainProcessObservation | null;
  gracefulQuit?: (appRoot: string, expectedPid: number) => void;
  waitForExit?: (pid: number, timeoutMs: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

export function codexMainProcessObservationFromReport(
  report: OpenReport | null,
): CodexMainProcessObservation | null {
  if (!report?.pid || report.hasMainProcess === false) return null;
  // Reopen explicitly asks macOS to activate the app, but focus may move before
  // the verifier samples it. A proved visible window is sufficient restart
  // evidence; hidden or inaccessible window state still fails closed.
  return {
    pid: report.pid,
    visibleWindow: report.visibleWindow === true || report.status === "open",
  };
}

/** Observe the main process for one exact app path, including explicit window visibility. */
export function observeCodexMainProcess(
  appRoot: string,
  deps: {
    locateExact?: (path: string) => CodexInstall;
    getReport?: (install: CodexInstall) => OpenReport;
  } = {},
): CodexMainProcessObservation | null {
  return codexMainProcessObservationFromReport(codexOpenReport(appRoot, deps));
}

/**
 * Stop only the main PID previously observed for this exact app path. The PID
 * is rechecked before signaling so a different launch can never be mistaken
 * for the transaction's old process.
 */
export function quitCodexMainProcess(
  appRoot: string,
  expectedPid: number,
  deps: QuitCodexMainProcessDeps = {},
): void {
  const observe = deps.observe ?? observeCodexMainProcess;
  const waitForExit = deps.waitForExit ?? waitForProcessExit;
  const observed = observe(appRoot);
  if (observed === null || observed.pid !== expectedPid) {
    throw new Error(`Refusing to quit ${appRoot}: expected main PID ${expectedPid} is not current`);
  }
  (deps.gracefulQuit ?? gracefulQuitExactMainProcess)(appRoot, expectedPid);
  if (waitForExit(expectedPid, 8_000)) return;

  const beforeSignal = observe(appRoot);
  if (beforeSignal === null || beforeSignal.pid !== expectedPid) {
    throw new Error(`Refusing to signal ${appRoot}: expected main PID ${expectedPid} is no longer current`);
  }
  try {
    (deps.signal ?? ((pid, signal) => { process.kill(pid, signal); }))(expectedPid, "SIGTERM");
  } catch (error) {
    throw new Error(`Could not stop main PID ${expectedPid}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!waitForExit(expectedPid, 3_000)) {
    throw new Error(`Main PID ${expectedPid} did not exit after graceful quit and SIGTERM`);
  }
}

function gracefulQuitExactMainProcess(appRoot: string, expectedPid: number): void {
  const bundleId = codexBundleId(appRoot);
  const script = [
    'tell application "System Events"',
    `set targetProcesses to every application process whose unix id is ${expectedPid}`,
    "if (count of targetProcesses) is not 1 then error \"exact process not found\"",
    "set targetProcess to item 1 of targetProcesses",
    `if bundle identifier of targetProcess is not ${appleScriptString(bundleId)} then error \"bundle mismatch\"`,
    "tell targetProcess to quit",
    "end tell",
  ].join("\n");
  try {
    alertExecFileSync("osascript", ["-e", script], { stdio: "ignore" });
  } catch {
    // A rejected graceful request is not grounds to broaden the target. The
    // exact path/PID is revalidated before the bounded SIGTERM escalation.
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && processExists(pid)) {
    try { execFileSync("sleep", ["0.25"], { stdio: "ignore" }); } catch { break; }
  }
  return !processExists(pid);
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
    `set alertTitle to system attribute "TWEAKER_ALERT_TITLE"`,
    `set alertMessage to system attribute "TWEAKER_ALERT_MESSAGE"`,
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
        TWEAKER_ALERT_TITLE: opts.title,
        TWEAKER_ALERT_MESSAGE: opts.message,
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

function codexOpenReport(
  appRoot: string,
  deps: {
    locateExact?: (path: string) => CodexInstall;
    getReport?: (install: CodexInstall) => OpenReport;
  } = {},
): OpenReport | null {
  try {
    const install = (deps.locateExact ?? locateCodexAtExactPath)(appRoot);
    return (deps.getReport ?? getOpenReport)(install);
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
    "- Did rerunning `tweaker repair` change the result? ",
  ].join("\n");

  const params = new URLSearchParams({ title, body });
  return `${TWEAKER_REPO_URL}/issues/new?${params.toString()}`;
}

export function buildCliFailureIssueUrl(command: string | undefined, errorMessage: string): string {
  const commandLabel = command?.trim() || "(unknown command)";
  const title = `Tweakers ${commandLabel} failed`;
  const body = [
    "## Summary",
    `\`tweaker ${commandLabel}\` failed.`,
    "",
    "## Command",
    "```text",
    `tweaker ${commandLabel}`,
    "```",
    "",
    "## Error",
    "```text",
    trimIssueError(errorMessage),
    "```",
    "",
    "## Environment",
    `- Tweakers: ${TWEAKER_VERSION}`,
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
  return `${TWEAKER_REPO_URL}/issues/new?${params.toString()}`;
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

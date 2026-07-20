/**
 * `tweaker mode <chatgpt|tweakers|status|setup> [--json] [--yes]`
 *
 * /Applications/ChatGPT.app alternates between the pristine OpenAI
 * Developer-ID payload ("chatgpt" mode) and the patched contained-signed
 * payload ("tweakers" mode). A switch confirms, quits the app, performs ONE
 * atomic Contents swap via replaceAppBundlePreservingIdentity (the app path
 * is never absent), then relaunches.
 *
 * Locking: this command holds only its own `mode.lock`. It NEVER acquires the
 * transaction lock around the nested install() call (same-PID nested
 * acquisition self-destructs the lock — see process-lock.ts); direct fast-path
 * swaps take the transaction lock themselves, and the slow path lets install()
 * own it.
 */
import kleur from "kleur";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { ensureUserPaths, type UserPaths } from "../paths.js";
import { readState, writeState, type AppMode } from "../state.js";
import { locateCodex, type CodexInstall } from "../platform.js";
import {
  install,
  isDeveloperIdSignedBackup,
  isSwapRollbackFailure,
  isSwapValidationRollback,
  readAsarMarker,
  readCodexVersion,
  refreshLivePartialBackups,
  replaceAppBundlePreservingIdentity,
  spawnHiddenHealthProbe,
  type AsarMarker,
} from "./install.js";
import { waitForMacAppUpdateToSettle } from "./repair.js";
import { confirmModeSwitch, isCodexRunning, openCodex, quitCodex } from "../alerts.js";
import { signatureInfo, verifySignature } from "../codesign.js";
import { OPENAI_TEAM_ID } from "../macos-variant.js";
import { acquireProcessLock, isLockHeldByLiveOwner, processAlive } from "../process-lock.js";
import {
  compareDesktopVersionIdentity,
  desktopVersionIdentityEqual,
  type DesktopVersionComparison,
  type DesktopVersionIdentity,
} from "../desktop-version.js";
import {
  acquireTransactionLock,
  cloneAppTree,
  isTransactionLockHeld,
  readTransactionState,
  transactionLockFile,
  type TransactionPhase,
} from "../transaction.js";
import { isUpdateModeFresh, readUpdateMode } from "../update-mode.js";
import { assertLifecycleReceiptsIdle, lifecycleLockFile, withLifecycleLock } from "../lifecycle-lock.js";
import {
  clearModeTransition,
  modeDirectory,
  modeLockFile,
  modeTransitionFile,
  parkedPayloadApp,
  parkedPayloadRoot,
  payloadMetadataFile,
  readModeTransition,
  readPayloadMetadata,
  reconcileModeTransition,
  refreshPristineBackupStaged,
  writeModeTransition,
  writePayloadMetadata,
  type ModeTransitionJournal,
} from "../mode-transition.js";
import {
  ensureModeCoordinatorConfigured,
  ensureSwitcherInstalled,
  modeCoordinatorStatus,
  removeStandaloneSwitcher,
  switcherStatus,
} from "../switcher-setup.js";
import { readPlist } from "../plist.js";
import {
  environment,
  type EnvironmentCommandResult,
  type EnvironmentStatusResult,
} from "./environment.js";
import type { EnvironmentTransactionReceipt } from "../environment-transaction.js";

export interface ModeCommandOptions {
  json?: boolean;
  yes?: boolean;
  app?: string;
}

/**
 * Every real system side effect flows through these adapters so tests never
 * touch codesign/osascript/launchd or the native swap. Defaults are the
 * production implementations.
 */
export interface ModeCommandDeps {
  platform?: () => NodeJS.Platform;
  locate?: typeof locateCodex;
  readMarker?: typeof readAsarMarker;
  isAppRunning?: (appRoot: string) => boolean;
  quitApp?: (appRoot: string) => void;
  openApp?: (appRoot: string) => void;
  waitForSettle?: (appRoot: string) => Promise<void>;
  confirm?: typeof confirmModeSwitch;
  notify?: (title: string, message: string) => void;
  copyApp?: (source: string, destination: string) => void;
  swapDirectories?: (first: string, second: string) => void;
  verifyDeep?: typeof verifySignature;
  signature?: typeof signatureInfo;
  isDeveloperIdBackup?: (appRoot: string) => boolean;
  spawnHealthProbe?: (executable: string, userRoot: string) => void;
  ensureSwitcher?: typeof ensureSwitcherInstalled;
  switcherStatus?: typeof switcherStatus;
  ensureCoordinator?: typeof ensureModeCoordinatorConfigured;
  coordinatorStatus?: typeof modeCoordinatorStatus;
  removeStandaloneSwitcher?: typeof removeStandaloneSwitcher;
  installApp?: typeof install;
  environmentCommand?: typeof environment;
  /** @internal Keeps legacy bundle-swap unit fixtures reachable, never production CLI flow. */
  legacyModeEngineForTests?: boolean;
}

export async function mode(
  target: string | undefined,
  opts: ModeCommandOptions = {},
  deps: ModeCommandDeps = {},
): Promise<void> {
  if ((deps.platform ?? platform)() !== "darwin") {
    throw new Error("The Tweakers app mode toggle is currently supported only on macOS.");
  }
  switch (target) {
    case "status":
      return modeStatus(opts, deps);
    case "setup":
      return modeSetup(deps);
    case "chatgpt":
    case "tweakers":
      return runNotifiedSwitch(target, opts, deps);
    default:
      throw new Error(
        `Unknown mode target "${target ?? ""}".\nUse: tweaker mode <chatgpt|tweakers|status|setup>`,
      );
  }
}

/**
 * The switch flows run headless behind launchd (menu-bar switcher, in-app IPC)
 * where stdio is discarded, so EVERY refusal/error must surface as a
 * notification — lock contention, concurrent installer activity, backup
 * preconditions, switcher setup failure, all of it — not only the paths that
 * compose their own message. Flows that already notified are not notified
 * twice.
 */
async function runNotifiedSwitch(
  target: "chatgpt" | "tweakers",
  opts: ModeCommandOptions,
  deps: ModeCommandDeps,
): Promise<void> {
  const notify = deps.notify ?? showModeNotification;
  let notified = false;
  const notifyOnce: NonNullable<ModeCommandDeps["notify"]> = (title, message) => {
    notified = true;
    notify(title, message);
  };
  const wrapped: ModeCommandDeps = { ...deps, notify: notifyOnce };
  try {
    if (deps.legacyModeEngineForTests === true) {
      await withLifecycleLock(lifecycleLockFile(ensureUserPaths().root), `legacy mode switch to ${target}`, async () => {
        assertLifecycleReceiptsIdle(ensureUserPaths().root);
        if (target === "chatgpt") await switchToChatgpt(opts, wrapped);
        else await switchToTweakers(opts, wrapped);
      });
    } else {
      await switchEnvironmentExperience(target, opts, wrapped);
    }
  } catch (error) {
    if (!notified) {
      notifyOnce("Tweakers mode switch refused", errorMessage(error).split("\n")[0]);
    }
    throw error;
  }
}

/**
 * Compatibility adapter for `tweaker mode <target>`. Production mode changes
 * use the same durable Environment coordinator as Config: prepare every
 * prerequisite first, ask once, then prove a different PID and activated
 * visible window before reporting success. The old bundle-swap engine remains
 * reachable only through the explicit test seam above.
 */
async function switchEnvironmentExperience(
  target: "chatgpt" | "tweakers",
  opts: ModeCommandOptions,
  deps: ModeCommandDeps,
): Promise<void> {
  const runEnvironment = deps.environmentCommand ?? environment;
  const status = await runEnvironment("status", { observe: true, quiet: true });
  if (!isEnvironmentStatusResult(status)) {
    throw new Error("Environment status returned an invalid compatibility result");
  }
  if (status.observation?.transitionJournalPresent === true) {
    const paths = ensureUserPaths();
    const codex = (deps.locate ?? locateCodex)(status.selected.selectedDesktopPath);
    const readMarker = deps.readMarker ?? readAsarMarker;
    await withLifecycleLock(lifecycleLockFile(paths.root), "legacy mode transition reconciliation", async () => {
      reconcileAtEntry(paths, codex, readMarker(codex.asarPath), deps);
    });
  }
  if (opts.app !== undefined && opts.app !== status.selected.selectedDesktopPath) {
    throw new Error(
      `The requested app path ${opts.app} does not match the selected ${status.selected.releaseProfile} environment at ${status.selected.selectedDesktopPath}`,
    );
  }
  const observedExperience = status.observation?.appExperience ?? null;
  if (observedExperience === null) {
    throw new Error(
      `Cannot verify the live app experience at ${status.selected.selectedDesktopPath}; run tweaker repair before switching modes`,
    );
  }
  if (observedExperience !== status.selected.appExperience) {
    throw new Error(
      `Environment selection says ${status.selected.appExperience}, but the live app proves ${observedExperience}; run tweaker repair before switching modes`,
    );
  }
  if (status.selected.appExperience === target) {
    console.log(kleur.green(`Already in ${target === "chatgpt" ? "ChatGPT" : "Tweakers"} mode.`));
    return;
  }

  const prepared = await runEnvironment("prepare", {
    appExperience: target,
    releaseProfile: status.selected.releaseProfile,
    quiet: true,
  });
  const receipt = requirePreparedEnvironmentReceipt(prepared);
  const confirmed = opts.yes === true
    || (deps.confirm ?? confirmModeSwitch)({
      target,
      appRoot: receipt.requested.selectedDesktopPath,
    });
  if (!confirmed) {
    await runEnvironment("cancel", { transaction: receipt.transactionId, quiet: true });
    console.log(kleur.yellow("Mode switch cancelled."));
    return;
  }

  const committed = await runEnvironment("commit", {
    transaction: receipt.transactionId,
    quiet: true,
  });
  if (!isEnvironmentTransactionReceipt(committed) || committed.phase !== "committed") {
    const phase = isEnvironmentTransactionReceipt(committed) ? committed.phase : "invalid";
    const detail = isEnvironmentTransactionReceipt(committed) && committed.error
      ? `: ${committed.error}`
      : "";
    throw new Error(`Environment mode switch did not commit (phase ${phase})${detail}`);
  }
  console.log(kleur.green().bold(`✓ Switched to ${target === "chatgpt" ? "ChatGPT" : "Tweakers"} mode.`));
  console.log(
    kleur.dim(
      `  Restart verified: PID ${committed.oldMainPid} → ${committed.newMainPid}; activated window at ${committed.requested.selectedDesktopPath}`,
    ),
  );
}

function isEnvironmentStatusResult(value: EnvironmentCommandResult): value is EnvironmentStatusResult {
  return "selected" in value
    && value.schemaVersion === 1
    && value.selected !== null
    && (value.selected.releaseProfile === "stable" || value.selected.releaseProfile === "alpha")
    && (value.selected.appExperience === "chatgpt" || value.selected.appExperience === "tweakers");
}

function isEnvironmentTransactionReceipt(
  value: EnvironmentCommandResult,
): value is EnvironmentTransactionReceipt {
  return "kind" in value
    && value.kind === "environment"
    && "transactionId" in value
    && typeof value.transactionId === "string"
    && value.transactionId.length > 0;
}

function requirePreparedEnvironmentReceipt(
  value: EnvironmentCommandResult,
): EnvironmentTransactionReceipt {
  if (!isEnvironmentTransactionReceipt(value) || value.phase !== "prepared") {
    const phase = isEnvironmentTransactionReceipt(value) ? value.phase : "invalid";
    throw new Error(`Environment mode switch preparation did not complete (phase ${phase})`);
  }
  return value;
}

/* ------------------------------------------------------------------------- */
/* status / setup                                                            */
/* ------------------------------------------------------------------------- */

interface ModeStatusReport {
  mode: AppMode;
  modeSource: "live-marker" | "state-fallback" | "unverified";
  liveMarker: AsarMarker;
  parkedPayload: { present: boolean; baseVersion: string | null; parkedAt: string | null };
  backup: { present: boolean; developerIdValid: boolean; version: string | null };
  switcher: { installed: boolean; reason?: string };
  transition: { target: AppMode; phase: string; ownerPid: number } | null;
}

async function modeStatus(opts: ModeCommandOptions, deps: ModeCommandDeps): Promise<void> {
  const paths = ensureUserPaths();
  const state = readState(paths.stateFile);
  const locate = deps.locate ?? locateCodex;
  let codex: CodexInstall | null = null;
  try {
    codex = locate(opts.app ?? state?.appRoot);
  } catch {
    codex = null;
  }
  const readMarker = deps.readMarker ?? readAsarMarker;
  let marker: AsarMarker = "unreadable";
  if (codex) marker = readMarker(codex.asarPath);

  // Status is observation only. Interrupted-transition reconciliation mutates
  // app metadata, state, and parked payloads, so it runs only from a
  // lifecycle-locked switch or repair command.
  const current = state;
  const parkedApp = parkedPayloadApp(paths.root);
  const payloadMeta = readPayloadMetadata(payloadMetadataFile(paths.root));
  const parkedPresent = existsSync(join(parkedApp, "Contents"));
  const backup = join(paths.backup, "Codex.app");
  const backupPresent = existsSync(backup);
  const verifyBackup = deps.isDeveloperIdBackup ?? isDeveloperIdSignedBackup;
  // Compatibility JSON keeps the historical `switcher` key for Menu Bar 1.8,
  // but it now reports the shared restart coordinator rather than a second
  // status-item app.
  const coordinator = (deps.coordinatorStatus ?? modeCoordinatorStatus)();
  const journal = readModeTransition(modeTransitionFile(paths.root));
  const stateMode = current?.mode === "chatgpt" || current?.mode === "tweakers"
    ? current.mode
    : null;
  const observedMode = marker === "present"
    ? "tweakers"
    : marker === "absent"
      ? "chatgpt"
      : stateMode ?? "chatgpt";
  const report: ModeStatusReport = {
    mode: observedMode,
    modeSource: marker === "unreadable"
      ? stateMode === null ? "unverified" : "state-fallback"
      : "live-marker",
    liveMarker: marker,
    parkedPayload: {
      present: parkedPresent,
      baseVersion:
        payloadMeta?.baseVersion
        ?? (parkedPresent ? readCodexVersion(join(parkedApp, "Contents", "Info.plist")) : null),
      parkedAt: payloadMeta?.parkedAt ?? null,
    },
    backup: {
      present: backupPresent,
      developerIdValid: backupPresent && verifyBackup(backup),
      version: backupPresent ? readCodexVersion(join(backup, "Contents", "Info.plist")) : null,
    },
    switcher: {
      installed: coordinator.configured,
      ...(coordinator.reason ? { reason: coordinator.reason } : {}),
    },
    transition: journal ? { target: journal.target, phase: journal.phase, ownerPid: journal.ownerPid } : null,
  };

  if (opts.json) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log(kleur.bold("tweaker mode"));
  console.log(`  mode:          ${report.mode === "chatgpt" ? kleur.cyan("chatgpt") : kleur.green("tweakers")}${report.modeSource === "live-marker" ? "" : kleur.dim(` (${report.modeSource})`)}`);
  console.log(`  live marker:   ${report.liveMarker}`);
  console.log(`  parked payload: ${report.parkedPayload.present ? kleur.green(`present${report.parkedPayload.baseVersion ? ` (${report.parkedPayload.baseVersion})` : ""}`) : kleur.dim("none")}`);
  console.log(`  pristine backup: ${report.backup.present ? `${report.backup.developerIdValid ? kleur.green("Developer ID valid") : kleur.red("NOT Developer ID signed")}${report.backup.version ? ` (${report.backup.version})` : ""}` : kleur.red("missing")}`);
  console.log(`  mode controls: ${report.switcher.installed ? kleur.green("Menu Bar coordinator ready") : kleur.yellow(`unavailable${report.switcher.reason ? ` — ${report.switcher.reason}` : ""}`)}`);
  if (report.transition) {
    console.log(kleur.yellow(`  transition:    switch to ${report.transition.target} in progress (phase ${report.transition.phase}, PID ${report.transition.ownerPid})`));
  }
}

async function modeSetup(deps: ModeCommandDeps): Promise<void> {
  const coordinator = await (deps.ensureCoordinator ?? ensureModeCoordinatorConfigured)();
  if (!coordinator.configured) {
    throw new Error(`Menu Bar restart coordinator setup failed${coordinator.reason ? `: ${coordinator.reason}` : ""}.`);
  }
  await (deps.removeStandaloneSwitcher ?? removeStandaloneSwitcher)();
  console.log(kleur.green("Menu Bar restart coordinator configured."));
  console.log(kleur.dim("  Use the Tweakers tab in the existing Menu Bar app to switch modes."));
}

/* ------------------------------------------------------------------------- */
/* tweaker → chatgpt                                                        */
/* ------------------------------------------------------------------------- */

async function switchToChatgpt(opts: ModeCommandOptions, deps: ModeCommandDeps): Promise<void> {
  const paths = ensureUserPaths();
  const lock = acquireModeLock(paths);
  try {
    assertNoConcurrentInstallerActivity(paths);
    const locate = deps.locate ?? locateCodex;
    const codex = locate(opts.app ?? readState(paths.stateFile)?.appRoot);
    const readMarker = deps.readMarker ?? readAsarMarker;
    reconcileAtEntry(paths, codex, readMarker(codex.asarPath), deps);

    const state = readState(paths.stateFile);
    const marker = readMarker(codex.asarPath);
    if (marker === "unreadable") {
      throw new Error("Refusing to switch modes: the live app.asar is unreadable. Run `tweaker doctor` first.");
    }
    if (marker === "absent") {
      if (state && state.mode !== "chatgpt") writeState(paths.stateFile, { ...state, mode: "chatgpt" });
      console.log(kleur.green("Already in ChatGPT mode (the live app is unpatched)."));
      return;
    }
    // A switch that cannot record its outcome must not proceed: with no state
    // record, nothing persists mode="chatgpt" after the swap, and the watcher
    // would re-patch the deliberately pristine app as a "fresh install".
    if (!state) {
      throw new Error(
        "Refusing to switch to ChatGPT mode: the installer state file is missing or unreadable.\n" +
          "Without it the switch cannot record its outcome and the auto-repair watcher would re-patch the pristine app.\n" +
          "Run `tweaker doctor` first.",
      );
    }

    // Preconditions: never strand the user without a byte-identical way back.
    const backup = join(paths.backup, "Codex.app");
    const verifyBackup = deps.isDeveloperIdBackup ?? isDeveloperIdSignedBackup;
    if (!verifyBackup(backup)) {
      throw new Error(
        `Refusing to switch to ChatGPT mode: the pristine backup at ${backup} is missing or not Developer ID signed.\n` +
          "Run `tweaker repair` first so a fresh official update refreshes the backup.",
      );
    }
    const backupVersion = readCodexVersion(join(backup, "Contents", "Info.plist"));
    const backupBuild = readBundleBuild(backup);
    const liveVersion = readCodexVersion(codex.metaPath);
    const liveBuild = readBundleBuild(codex.appRoot);
    const backupComparedWithLive = compareOlderBundle(
      { version: backupVersion, build: backupBuild },
      { version: liveVersion, build: liveBuild },
    );
    if (backupComparedWithLive === "unknown") {
      throw new Error(
        "Refusing to switch to ChatGPT mode: the pristine backup and live app version/build could not be compared safely.",
      );
    }
    const backupComparedWithRecorded = backupVersion !== null && state.codexVersion !== null
      ? compareOlderBundle(
        { version: backupVersion, build: null },
        { version: state.codexVersion, build: null },
      )
      : "not-newer";
    if (backupComparedWithRecorded === "unknown") {
      throw new Error(
        "Refusing to switch to ChatGPT mode: the pristine backup and recorded app version could not be compared safely.",
      );
    }
    const backupIsOlderThanLive = backupComparedWithLive === "newer";
    const backupIsOlderThanRecorded = backupComparedWithRecorded === "newer";
    if (backupIsOlderThanLive || backupIsOlderThanRecorded) {
      const installedVersion = backupIsOlderThanLive ? liveVersion : state.codexVersion;
      const installedBuild = backupIsOlderThanLive ? liveBuild : null;
      const message =
        `the pristine backup (${bundleDisplay(backupVersion, backupBuild)}) is older than the installed app (${bundleDisplay(installedVersion, installedBuild)}); ` +
        "restoring it would downgrade the shared Chromium profile";
      (deps.notify ?? showModeNotification)("Tweakers mode switch refused", `Refusing to switch: ${message}.`);
      throw new Error(`Refusing to switch to ChatGPT mode: ${message}.`);
    }
    if (opts.yes !== true && !(deps.confirm ?? confirmModeSwitch)({ target: "chatgpt", appRoot: codex.appRoot })) {
      console.log(kleur.yellow("Mode switch cancelled."));
      return;
    }

    const staged = join(modeDirectory(paths.root), "staged-pristine.app");
    const parkedApp = parkedPayloadApp(paths.root);
    const journal: ModeTransitionJournal = {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "preparing",
      ownerPid: process.pid,
      stagedPath: staged,
      payloadPath: parkedApp,
      startedAt: new Date().toISOString(),
    };
    writeModeTransition(modeTransitionFile(paths.root), journal);

    try {
      (deps.quitApp ?? quitCodex)(codex.appRoot);
      if ((deps.isAppRunning ?? isCodexRunning)(codex.appRoot)) {
        throw new Error("ChatGPT did not quit; the mode switch was aborted.");
      }
      // Sparkle's Autoupdate helper can rewrite the bundle AFTER the main
      // process exits — wait for the bundle to settle before swapping.
      await (deps.waitForSettle ?? defaultWaitForSettle)(codex.appRoot);

      // Sparkle may have completed a native update during the settle wait. If
      // the patched bundle has become a newer, pristine, official OpenAI app,
      // keep those fresh bytes instead of immediately overwriting them with
      // the older backup that was validated before quit. Refresh the backup
      // from the observed app first; only a deeply valid OpenAI-signed copy is
      // ever adopted.
      const verifyDeep = deps.verifyDeep ?? verifySignature;
      const readSignature = deps.signature ?? signatureInfo;
      const settledVersion = readCodexVersion(codex.metaPath);
      const settledBuild = readBundleBuild(codex.appRoot);
      const settledBackupBuild = readBundleBuild(backup);
      const verifyOfficialPristine = (appRoot: string): boolean => {
        const signature = readSignature(appRoot);
        return safeReadMarker(readMarker, join(appRoot, "Contents", "Resources", "app.asar")) === "absent"
          && verifyDeep(appRoot).ok
          && signature.ok
          && !signature.adHoc
          && signature.teamIdentifier === OPENAI_TEAM_ID;
      };
      const settledIsOfficialPristine = verifyOfficialPristine(codex.appRoot);
      const settledComparison = settledIsOfficialPristine
        ? compareNewerBundle(
          { version: settledVersion, build: settledBuild },
          { versions: [backupVersion, state.codexVersion], build: settledBackupBuild },
        )
        : "not-newer";
      if (settledComparison === "unknown") {
        throw new Error(
          "Refusing to overwrite the settled official app because its version/build could not be compared safely.",
        );
      }
      if (settledIsOfficialPristine && settledComparison === "newer") {
        refreshPristineBackupStaged(codex.appRoot, backup, {
          verify: verifyOfficialPristine,
          copy: deps.copyApp ?? cloneAppTree,
        });
        // Every partial fallback must match the newly refreshed full backup.
        refreshLivePartialBackups(codex, backup, paths.backup);
        // A payload built against the pre-update app can never be reused.
        rmSync(parkedPayloadRoot(paths.root), { recursive: true, force: true });

        const latest = readState(paths.stateFile) ?? state;
        writeState(paths.stateFile, {
          ...latest,
          mode: "chatgpt",
          ...(settledVersion ? { codexVersion: settledVersion } : {}),
        });
        clearModeTransition(modeTransitionFile(paths.root));
        rmSync(staged, { recursive: true, force: true });
        (deps.openApp ?? defaultOpenApp)(codex.appRoot);

        console.log(kleur.green().bold("✓ Switched to ChatGPT mode."));
        console.log(
          `  Live app:       adopted pristine official ChatGPT update (team ${OPENAI_TEAM_ID})`
            + `${settledVersion ? ` (${settledVersion}${settledBuild ? `, build ${settledBuild}` : ""})` : ""}`,
        );
        console.log(`  Pristine backup: refreshed atomically from the updated live app.`);
        console.log(`  Parked payload: ${kleur.dim("discarded (built against the previous app)")}`);
        printTccReminder(paths.configFile);
        return;
      }

      // Stage the pristine restore, then ONE atomic swap: the swap itself
      // parks the outgoing patched Contents, so /Applications/ChatGPT.app is
      // never absent and a crash at any point leaves a launchable bundle.
      rmSync(staged, { recursive: true, force: true });
      (deps.copyApp ?? cloneAppTree)(backup, staged);
      writeModeTransition(modeTransitionFile(paths.root), { ...journal, phase: "swapping" });

      rmSync(parkedPayloadRoot(paths.root), { recursive: true, force: true });
      mkdirSync(parkedApp, { recursive: true });

      // Direct swaps take the transaction lock themselves (mode.lock alone
      // does not stop a watcher repair from starting a transaction mid-swap).
      const transactionLock = acquireTransactionLock(transactionLockFile(paths.transactionStateFile));
      try {
        replaceAppBundlePreservingIdentity(staged, codex.appRoot, {
          swapDirectories: deps.swapDirectories,
          validateDestination: (appRoot) =>
            verifyDeep(appRoot).ok && readSignature(appRoot).teamIdentifier === OPENAI_TEAM_ID,
          preserveOutgoing: join(parkedApp, "Contents"),
          onCleanupFailure: (path, error) => {
            console.warn(kleur.yellow(`Parked payload cleanup will be retried later (${path}): ${errorMessage(error)}`));
          },
        });
      } finally {
        transactionLock.release();
      }

      const parkedVersion = readCodexVersion(join(parkedApp, "Contents", "Info.plist"));
      writePayloadMetadata(payloadMetadataFile(paths.root), {
        schemaVersion: 1,
        baseVersion: parkedVersion ?? state?.codexVersion ?? null,
        baseBuild: readBundleBuild(parkedApp),
        patchedAsarHash: state?.patchedAsarHash ?? null,
        parkedAt: new Date().toISOString(),
      });

      const latest = readState(paths.stateFile);
      if (latest) writeState(paths.stateFile, { ...latest, mode: "chatgpt" });
      clearModeTransition(modeTransitionFile(paths.root));
      rmSync(staged, { recursive: true, force: true });

      (deps.openApp ?? defaultOpenApp)(codex.appRoot);

      const post = (deps.verifyDeep ?? verifySignature)(codex.appRoot);
      console.log(kleur.green().bold("✓ Switched to ChatGPT mode."));
      console.log(`  Live app:       pristine official ChatGPT (team ${OPENAI_TEAM_ID})${post.ok ? "" : kleur.red(" — post-swap signature verification FAILED")}`);
      console.log(`  Parked payload: ${kleur.cyan(parkedApp)}${parkedVersion ? ` (${parkedVersion})` : ""}`);
      printTccReminder(paths.configFile);
      return;
    } catch (error) {
      // The swap validates before committing and normally rolls back
      // atomically, so the live bundle is still launchable. Record OBSERVED
      // reality — never intent — then report keyed on what actually happened.
      const observed = safeReadMarker(readMarker, codex.asarPath);
      finalizeModeFromObservedMarker(paths, observed);
      if (observed === "unreadable" || isSwapRollbackFailure(error)) {
        // Unclassifiable end state, or the primitive's own rollback failed and
        // preserved evidence at the stable swap path. Leave the journal for
        // reconcileModeTransition — it classifies "blocked" and adopts swap
        // remnants; clearing it here would destroy exactly that record.
        (deps.notify ?? showModeNotification)(
          "Tweakers mode switch failed",
          "The switch to ChatGPT mode failed and the app could not be verified. Run `tweaker doctor` before switching again.",
        );
        console.error(kleur.red("Run `tweaker doctor` before switching modes again."));
        throw error;
      }
      clearModeTransition(modeTransitionFile(paths.root));
      rmSync(staged, { recursive: true, force: true });
      if (observed === "absent") {
        // The swap landed; only post-switch bookkeeping failed. Never report a
        // completed switch as "left in Tweakers mode".
        (deps.notify ?? showModeNotification)(
          "ChatGPT mode switch completed with warnings",
          `Switched to ChatGPT mode, but post-switch housekeeping failed: ${errorMessage(error).split("\n")[0]}`,
        );
      } else {
        (deps.notify ?? showModeNotification)(
          "Tweakers mode switch failed",
          "The switch to ChatGPT mode did not complete; the app was left in Tweakers mode.",
        );
      }
      (deps.openApp ?? defaultOpenApp)(codex.appRoot);
      throw error;
    }
  } finally {
    lock.release();
  }
}

/* ------------------------------------------------------------------------- */
/* chatgpt → tweakers                                                       */
/* ------------------------------------------------------------------------- */

async function switchToTweakers(opts: ModeCommandOptions, deps: ModeCommandDeps): Promise<void> {
  const paths = ensureUserPaths();
  const lock = acquireModeLock(paths);
  try {
    assertNoConcurrentInstallerActivity(paths);
    const locate = deps.locate ?? locateCodex;
    const codex = locate(opts.app ?? readState(paths.stateFile)?.appRoot);
    const readMarker = deps.readMarker ?? readAsarMarker;
    reconcileAtEntry(paths, codex, readMarker(codex.asarPath), deps);

    const state = readState(paths.stateFile);
    const marker = readMarker(codex.asarPath);
    if (marker === "unreadable") {
      throw new Error("Refusing to switch modes: the live app.asar is unreadable. Run `tweaker doctor` first.");
    }
    if (marker === "present") {
      if (state && state.mode !== "tweakers") writeState(paths.stateFile, { ...state, mode: "tweakers" });
      console.log(kleur.green("Already in Tweakers mode (the live app is patched)."));
      return;
    }

    if (opts.yes !== true && !(deps.confirm ?? confirmModeSwitch)({ target: "tweakers", appRoot: codex.appRoot })) {
      console.log(kleur.yellow("Mode switch cancelled."));
      return;
    }

    const parkedApp = parkedPayloadApp(paths.root);
    const outgoing = join(modeDirectory(paths.root), "outgoing-pristine.app");
    const journal: ModeTransitionJournal = {
      schemaVersion: 1,
      target: "tweakers",
      phase: "preparing",
      ownerPid: process.pid,
      stagedPath: outgoing,
      payloadPath: parkedApp,
      startedAt: new Date().toISOString(),
    };
    writeModeTransition(modeTransitionFile(paths.root), journal);

    let flowError: unknown = null;
    let usedFastPath = false;
    try {
      (deps.quitApp ?? quitCodex)(codex.appRoot);
      if ((deps.isAppRunning ?? isCodexRunning)(codex.appRoot)) {
        throw new Error("ChatGPT did not quit; the mode switch was aborted.");
      }
      await (deps.waitForSettle ?? defaultWaitForSettle)(codex.appRoot);
      // Fingerprint the live official version only AFTER the settle wait:
      // Sparkle installs pending updates after the main process exits.
      const liveVersion = readCodexVersion(codex.metaPath);
      const liveBuild = readBundleBuild(codex.appRoot);
      const payloadMeta = readPayloadMetadata(payloadMetadataFile(paths.root));
      const parkedPresent = existsSync(join(parkedApp, "Contents"));
      // An adopted or crash-orphaned park can lack payload.json; fall back to
      // the parked bundle's own Info.plist — exactly the version `mode status`
      // reports — so status and the fast path can never disagree.
      const parkedVersion = payloadMeta?.baseVersion
        ?? (parkedPresent ? readCodexVersion(join(parkedApp, "Contents", "Info.plist")) : null);
      const parkedBuild = payloadMeta?.baseBuild
        ?? (parkedPresent ? readBundleBuild(parkedApp) : null);
      const parkedMatchesLive = parkedPresent
        ? desktopVersionIdentityEqual(
          { marketingVersion: parkedVersion, build: parkedBuild },
          { marketingVersion: liveVersion, build: liveBuild },
        )
        : false;
      if (parkedPresent && parkedMatchesLive === null) {
        throw new Error(
          "Refusing to overwrite either app because the parked payload and live app version/build could not be compared safely.",
        );
      }

      let unusablePayload: string | null = null;
      if (parkedPresent && parkedMatchesLive === true) {
        // Fast path: swap the parked patched payload straight in.
        writeModeTransition(modeTransitionFile(paths.root), { ...journal, phase: "swapping" });
        rmSync(outgoing, { recursive: true, force: true });
        const verifyDeep = deps.verifyDeep ?? verifySignature;
        const transactionLock = acquireTransactionLock(transactionLockFile(paths.transactionStateFile));
        try {
          replaceAppBundlePreservingIdentity(parkedApp, codex.appRoot, {
            swapDirectories: deps.swapDirectories,
            validateDestination: (appRoot) =>
              verifyDeep(appRoot).ok
              && readMarker(join(appRoot, "Contents", "Resources", "app.asar")) === "present",
            preserveOutgoing: join(outgoing, "Contents"),
            onCleanupFailure: (path, error) => {
              console.warn(kleur.yellow(`Outgoing pristine cleanup will be retried later (${path}): ${errorMessage(error)}`));
            },
          });
          usedFastPath = true;
        } catch (error) {
          // A cleanly rolled-back validation failure proves the parked payload
          // unusable (the identical bytes would fail every retry): discard it
          // below and rebuild via the slow path in this same invocation.
          if (!isSwapValidationRollback(error)) throw error;
          unusablePayload = errorMessage(error);
        } finally {
          transactionLock.release();
        }
      }

      if (usedFastPath) {
        // The swap consumed the payload; discard the store copy immediately so
        // no failure below can leave a stale-but-version-matching store behind.
        rmSync(parkedPayloadRoot(paths.root), { recursive: true, force: true });
        // Refresh the pristine backup from the swapped-out official Contents
        // with the staged-verify-rename discipline (promoteVerifiedSignedBackup
        // semantics): the previous backup survives until the refreshed copy
        // has verified, and `outgoing` — potentially the only intact pristine
        // payload — is discarded only after that.
        const verifyBackup = deps.isDeveloperIdBackup ?? isDeveloperIdSignedBackup;
        const liveBackup = join(paths.backup, "Codex.app");
        if (!verifyBackup(outgoing)) {
          throw new Error(
            `post-switch backup refresh failed: the swapped-out app at ${outgoing} did not verify as Developer ID signed; the previous pristine backup was left unchanged.`,
          );
        }
        refreshPristineBackupStaged(outgoing, liveBackup, {
          verify: verifyBackup,
          copy: deps.copyApp ?? cloneAppTree,
        });
        // The full backup was refreshed, so the live-root partial backups are
        // refreshed with it (partials can never be older than the full backup).
        refreshLivePartialBackups(codex, liveBackup, paths.backup);
        rmSync(outgoing, { recursive: true, force: true });
        // One-shot hidden probe for a promotion-health receipt.
        (deps.spawnHealthProbe ?? spawnHiddenHealthProbe)(codex.executable, paths.root);
      } else {
        // Slow path: the parked payload is missing, stale, or unusable —
        // discard it and run the full install() transaction against the live
        // pristine app. install() owns the transaction lock (never here).
        if (existsSync(parkedPayloadRoot(paths.root))) {
          console.log(kleur.yellow(
            unusablePayload
              ? `Discarding unusable parked payload (${unusablePayload}); rebuilding a fresh one.`
              : `Discarding stale parked payload${payloadMeta?.baseVersion ? ` (built against ${payloadMeta.baseVersion}; live app is ${liveVersion ?? "unknown"})` : ""}.`,
          ));
          rmSync(parkedPayloadRoot(paths.root), { recursive: true, force: true });
        }
        await (deps.installApp ?? install)({ app: codex.appRoot, modeTransition: true });
      }
    } catch (error) {
      flowError = error;
    }

    // Derive the final mode from the OBSERVED end state, never from intent:
    // held/invalidated/rolled-back/degraded install outcomes leave the pristine
    // app live, so state.mode must stay "chatgpt".
    const observed = safeReadMarker(readMarker, codex.asarPath);
    finalizeModeFromObservedMarker(paths, observed);

    if (observed === "present" && flowError === null) {
      clearModeTransition(modeTransitionFile(paths.root));
      // Keep the existing Menu Bar coordinator metadata fresh. A control-
      // surface migration failure must never fail an otherwise valid switch.
      if (usedFastPath) await refreshModeControlsNonfatal(deps);
      (deps.openApp ?? defaultOpenApp)(codex.appRoot);
      console.log(kleur.green().bold("✓ Switched to Tweakers mode."));
      console.log(`  ${usedFastPath ? "Fast path: parked payload swapped in." : "Slow path: rebuilt and promoted a fresh patched payload."}`);
      printTccReminder(paths.configFile);
      return;
    }

    if (observed === "unreadable" || isSwapRollbackFailure(flowError)) {
      // Unclassifiable end state, or the swap primitive's own rollback failed
      // and preserved evidence at the stable swap path. Leave the journal for
      // reconcileModeTransition — it classifies "blocked" and adopts swap
      // remnants; clearing it here would destroy exactly that record.
      (deps.notify ?? showModeNotification)(
        "Tweakers mode switch failed",
        "The switch to Tweakers mode failed and the app could not be verified. Run `tweaker doctor` before switching again.",
      );
      console.error(kleur.red("Run `tweaker doctor` before switching modes again."));
      if (flowError !== null) throw flowError;
      throw new Error(
        "The switch to Tweakers mode could not be verified: the live app.asar is unreadable. Run `tweaker doctor`.",
      );
    }

    clearModeTransition(modeTransitionFile(paths.root));
    (deps.openApp ?? defaultOpenApp)(codex.appRoot);
    if (observed === "present") {
      // flowError is non-null here: the switch LANDED (the live app carries
      // the patch marker) but a post-switch housekeeping step failed. Never
      // claim ChatGPT mode when the switch landed.
      (deps.notify ?? showModeNotification)(
        "Tweakers mode switch completed with warnings",
        `Switched to Tweakers mode, but post-switch housekeeping failed: ${errorMessage(flowError).split("\n")[0]}`,
      );
      throw flowError;
    }
    (deps.notify ?? showModeNotification)(
      "Tweakers mode switch incomplete",
      "The switch to Tweakers mode did not complete; the app was relaunched in ChatGPT mode.",
    );
    if (flowError !== null) throw flowError;
    throw new Error(
      "The switch to Tweakers mode did not complete: the live app has no patch marker.\n" +
        "The pristine app was relaunched and the mode stays \"chatgpt\". Check `tweaker status`, then retry `tweaker mode tweakers`.",
    );
  } finally {
    lock.release();
  }
}

/* ------------------------------------------------------------------------- */
/* shared helpers                                                            */
/* ------------------------------------------------------------------------- */

function acquireModeLock(paths: UserPaths): { release(): void } {
  return acquireProcessLock(modeLockFile(paths.root), {
    onContended: (owner) =>
      new Error(
        owner === null
          ? "Another `tweaker mode` command is already running."
          : `Another \`tweaker mode\` command is already running (PID ${owner}).`,
      ),
  });
}

const ACTIVE_TRANSACTION_PHASES: TransactionPhase[] = [
  "buildingCandidate",
  "validatingCandidate",
  "promoting",
  "checkingHealth",
  "rollingBack",
];

function assertNoConcurrentInstallerActivity(paths: UserPaths): void {
  if (isTransactionLockHeld(transactionLockFile(paths.transactionStateFile))) {
    throw new Error("Refusing to switch modes: a Tweakers install transaction is running. Retry after it finishes.");
  }
  if (isLockHeldByLiveOwner(join(paths.root, "refresh-local.lock"))) {
    throw new Error("Refusing to switch modes: a Tweakers local refresh is running. Retry after it finishes.");
  }
  const transaction = readTransactionState(paths.transactionStateFile);
  if (
    transaction
    && transaction.ownerPid !== undefined
    && transaction.ownerPid !== process.pid
    && processAlive(transaction.ownerPid)
    && ACTIVE_TRANSACTION_PHASES.includes(transaction.phase)
  ) {
    throw new Error(
      `Refusing to switch modes: an install transaction is active (phase ${transaction.phase}, PID ${transaction.ownerPid}).`,
    );
  }
  const updateMode = readUpdateMode(paths.updateModeFile);
  if (updateMode && isUpdateModeFresh(updateMode)) {
    throw new Error(
      "Refusing to switch modes: the official ChatGPT updater is mid-flight (update mode is fresh).\n" +
        "Retry after the official update finishes.",
    );
  }
}

function reconcileAtEntry(paths: UserPaths, codex: CodexInstall, marker: AsarMarker, deps: ModeCommandDeps): void {
  const result = reconcileModeTransition(
    { root: paths.root, stateFile: paths.stateFile },
    { marker, appRoot: codex.appRoot },
    { log: (line) => console.log(kleur.dim(line)), isDeveloperIdBackup: deps.isDeveloperIdBackup },
  );
  if (result.action === "in-progress") {
    throw new Error(`Refusing to switch modes: another mode switch is in progress (PID ${result.ownerPid}).`);
  }
  if (result.action === "blocked") {
    throw new Error(
      `A previous mode switch could not be reconciled: ${result.reason}.\n` +
        "Run `tweaker doctor` and repair the app before switching modes.",
    );
  }
  if (result.action === "completed" || result.action === "rolled-back") {
    console.log(kleur.yellow(`Recovered an interrupted mode switch (${result.action}; now in ${result.mode} mode).`));
  }
}

async function refreshModeControlsNonfatal(deps: ModeCommandDeps): Promise<void> {
  try {
    const result = await (deps.ensureCoordinator ?? ensureModeCoordinatorConfigured)();
    if (!result.configured) {
      console.warn(kleur.yellow(`Menu Bar coordinator refresh failed${result.reason ? `: ${result.reason}` : ""}.`));
    }
    await (deps.removeStandaloneSwitcher ?? removeStandaloneSwitcher)();
  } catch (error) {
    console.warn(kleur.yellow(`Menu Bar coordinator refresh failed: ${errorMessage(error)}`));
  }
}

function finalizeModeFromObservedMarker(paths: UserPaths, observed: AsarMarker): void {
  if (observed === "unreadable") return;
  const state = readState(paths.stateFile);
  if (!state) return;
  const observedMode: AppMode = observed === "present" ? "tweakers" : "chatgpt";
  if (state.mode !== observedMode) writeState(paths.stateFile, { ...state, mode: observedMode });
}

function safeReadMarker(readMarker: typeof readAsarMarker, asarPath: string): AsarMarker {
  try {
    return readMarker(asarPath);
  } catch {
    return "unreadable";
  }
}

function readBundleBuild(appRoot: string): string | null {
  try {
    const plistPath = join(appRoot, "Contents", "Info.plist");
    if (!existsSync(plistPath)) return null;
    const value = readPlist(plistPath)["CFBundleVersion"];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Sparkle build numbers are authoritative when both sides provide valid
 * numeric values. Marketing versions are the fallback for older snapshots.
 */
function compareNewerBundle(
  candidate: { version: string | null; build: string | null },
  baseline: { versions: Array<string | null>; build: string | null },
): DesktopVersionComparison {
  if (candidate.build !== null || baseline.build !== null) {
    return compareDesktopVersionIdentity(
      { marketingVersion: null, build: baseline.build },
      { marketingVersion: null, build: candidate.build },
    );
  }
  const candidateVersion = candidate.version;
  if (!candidateVersion) return "unknown";
  const versions = baseline.versions.filter((version): version is string => version !== null);
  if (versions.length === 0) return "unknown";
  let advanced = false;
  for (const version of versions) {
    const forward = compareDesktopVersionIdentity(
      { marketingVersion: version, build: null },
      { marketingVersion: candidateVersion, build: null },
    );
    if (forward === "unknown") return "unknown";
    if (forward === "newer") {
      advanced = true;
      continue;
    }
    const reverse = compareDesktopVersionIdentity(
      { marketingVersion: candidateVersion, build: null },
      { marketingVersion: version, build: null },
    );
    if (reverse === "unknown") return "unknown";
    if (reverse === "newer") return "not-newer";
  }
  return advanced ? "newer" : "not-newer";
}

function compareOlderBundle(
  candidate: { version: string | null; build: string | null },
  baseline: { version: string | null; build: string | null },
): DesktopVersionComparison {
  return compareDesktopVersionIdentity(
    toDesktopVersionIdentity(candidate),
    toDesktopVersionIdentity(baseline),
  );
}

function bundleDisplay(version: string | null, build: string | null): string {
  const displayedVersion = version ?? "unknown version";
  return build ? `${displayedVersion}, build ${build}` : displayedVersion;
}

function toDesktopVersionIdentity(
  bundle: { version: string | null; build: string | null },
): DesktopVersionIdentity {
  return {
    marketingVersion: bundle.version,
    build: bundle.build,
  };
}

function defaultWaitForSettle(appRoot: string): Promise<void> {
  return waitForMacAppUpdateToSettle(appRoot, {});
}

function defaultOpenApp(appRoot: string): void {
  openCodex(appRoot, { detached: true });
}

function printTccReminder(configFile: string): void {
  const permissions = readRequiredMacPermissions(configFile);
  const listed = permissions.length > 0 ? permissions.join(", ") : "Accessibility / Screen Recording";
  console.log(kleur.dim(`  macOS permissions: switching signers can invalidate TCC grants — re-grant ${listed} if prompted.`));
}

function readRequiredMacPermissions(configFile: string): string[] {
  try {
    const value = JSON.parse(readFileSync(configFile, "utf8")) as { requiredMacPermissions?: unknown };
    if (!Array.isArray(value.requiredMacPermissions)) return [];
    return value.requiredMacPermissions.filter((permission): permission is string => typeof permission === "string");
  } catch {
    return [];
  }
}

function showModeNotification(title: string, message: string): void {
  try {
    const child = spawn(
      "osascript",
      ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Notification delivery is best-effort and must never fail the switch.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

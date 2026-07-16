import kleur from "kleur";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { install, readAsarMarker, readCodexVersion, runtimeAssetsMatch, stageAssets, stageBundledTweaks, type AsarMarker } from "./install.js";
import { ensureUserPaths } from "../paths.js";
import { readState, resolveMode, writeState, type InstallerState } from "../state.js";
import { reconcileModeTransition } from "../mode-transition.js";
import { locateCodex, type CodexInstall } from "../platform.js";
import { signatureInfo, signingAvailable, verifySignature } from "../codesign.js";
import { listProcesses, type ProcessInfo } from "./debug.js";
import { terminateStaleHelperProcesses } from "../orphans.js";
import { readDevTweaksRoot } from "../config.js";
import { reconcileDevTweaks } from "./dev-sync.js";
import { readHeaderHash } from "../asar.js";
import { CODEX_PLUSPLUS_VERSION, compareSemver } from "../version.js";
import { installWatcher } from "../watcher.js";
import { clearUpdateMode, isUpdateModeFresh, readUpdateMode, writeUpdateMode } from "../update-mode.js";
import { findSourceRoot } from "../source-root.js";
import {
  isCodexRunning,
  showCodexUpdateDetectedNotification,
  showUpdateModePausedAlert,
} from "../alerts.js";
import {
  archiveTransactionState,
  isTransactionLockHeld,
  readTransactionState,
  transactionLockFile,
} from "../transaction.js";
import { fileURLToPath } from "node:url";
import { clearDeferredRepair, readDeferredRepair, writeDeferredRepair } from "../deferred-repair.js";
import { isLockHeldByLiveOwner } from "../process-lock.js";

interface Opts {
  app?: string;
  quiet?: boolean;
  force?: boolean;
  localSigning?: boolean;
  watcher?: boolean;
}

export interface RepairDependencies {
  install?: typeof install;
  signingAvailable?: typeof signingAvailable;
  notifySigningUnavailable?: () => void;
  // Stat-guard seams (task 5a). Default to the real implementations below.
  statAsar?: (asarPath: string) => { size: number; mtimeMs: number } | null;
  readHeaderHash?: typeof readHeaderHash;
  runtimeAssetsMatch?: typeof runtimeAssetsMatch;
  listProcesses?: typeof listProcesses;
  waitForSettle?: (appRoot: string | undefined, opts: SettleOptions) => Promise<void>;
  /** Mode-guard seam: how the live patch marker is observed. */
  readAsarMarker?: typeof readAsarMarker;
}

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = findSourceRoot(here);
const SETTLE_TIMEOUT_MS = 120_000;
const WATCHER_SETTLE_TIMEOUT_MS = 15 * 60_000;
const SETTLE_SAMPLE_MS = 2_000;
const SETTLE_STABLE_SAMPLES = 2;
const WATCHER_RETRY_NOTICE_MS = 30_000;
const STAT_GUARD_HYGIENE_EVERY_N = 6;

/**
 * `repair` is essentially `install` rerun, but it preserves the user's
 * config + tweaks (which `install` already does) and refreshes the watcher
 * unless the prior install explicitly had no watcher. We re-derive everything from the
 * current Codex.app on disk; the new asar/plist/framework hashes will
 * differ from those in `state.json` after a Sparkle update, so we just
 * overwrite state.
 */
export async function repair(opts: Opts = {}, dependencies: RepairDependencies = {}): Promise<void> {
  // ChatGPT-mode guard — deliberately the FIRST statement, before the
  // transaction-block check, the stat guard, and update-mode handling, and it
  // applies to --force repairs too: while ChatGPT mode is active the official
  // app stays pristine, so every repair path (including a straggling
  // refresh-local promote) must no-op loudly instead of re-patching.
  if (repairStandsDownInChatgptMode(opts, dependencies)) return;
  const paths = ensureUserPaths();
  const deferredRepairFile = paths.deferredRepairFile ?? join(paths.root, "deferred-repair.json");
  const watcherRepair = isWatcherRepair(opts);
  const deferredRepair = watcherRepair ? null : readDeferredRepair(deferredRepairFile);
  const waitForSettle = dependencies.waitForSettle ?? waitForMacAppUpdateToSettle;

  // Never race an in-flight install/refresh transaction: a watcher pass fired
  // by WatchPaths mid-promotion must yield, not "recover" a live promotion.
  // Only watcher passes skip silently — a coordinated refresh legitimately
  // spawns `repair --force` as a child while holding the refresh lock, and a
  // manual repair should surface the lock error from install() instead.
  if (watcherRepair && isRepairBlockedByActiveTransaction(paths.root, paths.transactionStateFile)) {
    if (!opts.quiet) {
      console.log(kleur.yellow("Another Tweakers install/refresh is running; skipping this repair pass."));
    }
    return;
  }

  if (opts.force) {
    // `repair --force` is the documented recovery from a degraded promotion;
    // it must actually clear the blocked transaction record (evidence is
    // archived beside it, never deleted).
    const transaction = readTransactionState(paths.transactionStateFile);
    if (transaction && (
      transaction.phase === "degraded" ||
      transaction.rollbackAttempted ||
      transaction.phase === "invalidated" ||
      // Permanently non-promotable holds (explicit --candidate-only / ad-hoc)
      // must not dead-end a forced repair; archive and rebuild promotable.
      transaction.pendingReason === "explicit-candidate-only" ||
      transaction.pendingReason === "adhoc-never-promotes"
    )) {
      archiveTransactionState(paths.transactionStateFile, transaction);
      if (!opts.quiet) {
        console.log(kleur.yellow(`Cleared ${transaction.phase} install transaction (archived for inspection).`));
      }
    }
  }

  const state = readState(paths.stateFile);
  if (!state) {
    if (!opts.quiet) {
      console.warn(
        kleur.yellow("No prior install state found. Running fresh install instead."),
      );
    }
  }

  // Watcher steady-state fast path: if the live app.asar stat is byte-identical
  // to the stat recorded at the last confirmed-intact repair, nothing changed —
  // skip the settle-wait, header parse, runtime tree-hash, and process sweeps.
  // Run cleanup hygiene (stale-helper sweep + watcher refresh) only every Nth
  // pass so orphans are still reaped without paying ~8s every 5 minutes.
  const statAsar = dependencies.statAsar ?? statAsarFile;
  if (watcherRepair && !opts.force && state?.patchedAsarStat) {
    const appRoot = opts.app ?? state.appRoot;
    const asarPath = join(appRoot, "Contents", "Resources", "app.asar");
    const current = statAsar(asarPath);
    if (
      current &&
      current.size === state.patchedAsarStat.size &&
      current.mtimeMs === state.patchedAsarStat.mtimeMs
    ) {
      const passes = (state.watcherStatGuardPasses ?? 0) + 1;
      if (passes % STAT_GUARD_HYGIENE_EVERY_N === 0) {
        const watcher = refreshWatcher(state.watcher, appRoot, opts.quiet);
        cleanupStaleHelperGeneration(appRoot, opts, dependencies);
        syncDevTweaks(paths.tweaks, paths.configFile, opts);
        writeState(paths.stateFile, {
          ...state,
          watcher,
          sourceRoot,
          watcherStatGuardPasses: 0,
        });
      } else {
        writeState(paths.stateFile, {
          ...state,
          sourceRoot,
          watcherStatGuardPasses: passes,
        });
      }
      if (!opts.quiet) console.log(kleur.green("Patch intact (app.asar unchanged)."));
      return;
    }
  }

  let settledBeforeHashCheck = false;
  if (state && !opts.force && !deferredRepair) {
    announceCodexUpdateDetected(paths.updateModeFile, opts.app ?? state.appRoot);
    notifyUpdateModePaused(paths.updateModeFile, opts.app ?? state.appRoot);
    await waitForSettle(opts.app ?? state.appRoot, settleOptions(opts, paths.updateModeFile));
    settledBeforeHashCheck = true;
    const codex = locateCodex(opts.app ?? state.appRoot);
    const updateMode = readUpdateMode(paths.updateModeFile);
    if (updateMode) {
      const codexVersion = readCodexVersion(codex.metaPath);
      if (codexVersion === updateMode.codexVersion && isUpdateModeFresh(updateMode)) {
        const watcher = refreshWatcher(state.watcher, codex.appRoot, opts.quiet);
        writeState(paths.stateFile, { ...state, watcher, sourceRoot });
        if (!updateMode.notifiedAt) {
          showUpdateModePausedAlert(codex.appRoot, codexVersion);
          writeUpdateMode(paths.updateModeFile, {
            ...updateMode,
            notifiedAt: new Date().toISOString(),
          });
        }
        if (!opts.quiet) {
          console.log(kleur.yellow("Codex update mode is active; leaving signed app unpatched."));
        }
        return;
      }
      if (codexVersion === updateMode.codexVersion && !opts.quiet) {
        console.log(kleur.yellow("Codex update mode is stale; clearing it and repairing Tweakers."));
      }
      clearUpdateMode(paths.updateModeFile);
    }
    const readHeader = dependencies.readHeaderHash ?? readHeaderHash;
    const runtimeMatches = dependencies.runtimeAssetsMatch ?? runtimeAssetsMatch;
    const { headerHash } = readHeader(codex.asarPath);
    if (headerHash === state.patchedAsarHash) {
      const patchedAsarStat = statAsar(codex.asarPath) ?? state.patchedAsarStat;
      const watcher = refreshWatcher(state.watcher, codex.appRoot, opts.quiet);
      cleanupStaleHelperGeneration(codex.appRoot, opts, dependencies);
      syncDevTweaks(paths.tweaks, paths.configFile, opts);
      if (compareSemver(CODEX_PLUSPLUS_VERSION, state.version) > 0 || !runtimeMatches(paths.runtime)) {
        if (!isAutoUpdateEnabled(paths.configFile)) {
          if (!opts.quiet) console.log(kleur.yellow("Tweakers auto-update is disabled."));
          return;
        }
        if (isCodexRunning(codex.appRoot)) {
          if (!opts.quiet) console.log(kleur.yellow("Runtime update held until a later cycle observes Codex closed."));
          return;
        }
        stageAssets(paths.runtime);
        stageBundledTweaks(paths.tweaks, paths.runtime, {
          devTweaksRoot: readDevTweaksRoot(paths.configFile),
          log: opts.quiet ? undefined : (line) => console.log(kleur.dim(line)),
        });
        writeState(paths.stateFile, {
          ...state,
          watcher,
          version: CODEX_PLUSPLUS_VERSION,
          sourceRoot,
          runtimeUpdatedAt: new Date().toISOString(),
          patchedAsarStat,
          watcherStatGuardPasses: 0,
        });
        if (!opts.quiet) {
          console.log(
            kleur.green(`Updated Tweakers runtime ${state.version} → ${CODEX_PLUSPLUS_VERSION}.`),
          );
        }
        return;
      }
      writeState(paths.stateFile, {
        ...state,
        watcher,
        sourceRoot,
        patchedAsarStat,
        watcherStatGuardPasses: 0,
      });
      if (!opts.quiet) console.log(kleur.green("Patch already intact."));
      return;
    }
  }

  if (!settledBeforeHashCheck) {
    await waitForSettle(opts.app ?? state?.appRoot, settleOptions(opts, paths.updateModeFile));
  }

  let coordinatedQuit = false;
  let codexVersion = state?.codexVersion ?? null;
  try {
    const codex = locateCodex(opts.app ?? state?.appRoot);
    codexVersion = readCodexVersion(codex.metaPath);
    coordinatedQuit =
      settledBeforeHashCheck &&
      isConfirmedOfficialUpdateDrift({
        state,
        codex,
        watcherRepair,
        force: opts.force === true,
        updateModeFile: paths.updateModeFile,
      });
    if (isCodexRunning(codex.appRoot)) {
      if (!opts.quiet) {
        console.log(
          coordinatedQuit
            ? kleur.yellow("Codex update detected; Tweakers will quit and reopen Codex to apply the patch.")
            : kleur.yellow("Repair candidate will be built and held while Codex is running; Codex will not be prompted or quit."),
        );
      }
    }
  } catch {
    // install() will surface the real locate/preflight error below.
  }

  const localSigning = opts.localSigning ?? (state?.signingMode !== "adhoc");
  const canSign = dependencies.signingAvailable ?? signingAvailable;
  if (watcherRepair && localSigning && !canSign()) {
    const existing = readDeferredRepair(deferredRepairFile);
    if (!existing || existing.codexVersion !== codexVersion) {
      writeDeferredRepair(deferredRepairFile, {
        reason: "signing-unavailable",
        codexVersion,
        at: new Date().toISOString(),
      });
      (dependencies.notifySigningUnavailable ?? showSigningUnavailableNotification)();
    }
    return;
  }

  // Re-read the mode IMMEDIATELY before mutating: the settle wait above can
  // last up to 15 minutes, during which a `tweakers mode chatgpt` switch may
  // have completed. This closes the in-flight-watcher race.
  if (repairStandsDownInChatgptMode(opts, dependencies)) return;

  const runInstall = dependencies.install ?? install;
  await runInstall({
    app: opts.app ?? state?.appRoot,
    fuse: state?.fuseFlipped ?? true,
    resign: state?.resigned ?? true,
    localSigning: opts.localSigning ?? (state?.signingMode !== "adhoc"),
    watcher: state?.watcher === "none" ? false : true,
    watcherKind: state?.watcher,
    quiet: opts.quiet,
    coordinatedQuit,
  });
  syncDevTweaks(paths.tweaks, paths.configFile, opts);
  if (deferredRepair) clearDeferredRepair(deferredRepairFile);
  if (!opts.quiet) console.log(kleur.green("✓ Repair complete."));
}

/**
 * True when repair must stand down because ChatGPT mode owns the live app.
 *
 * Verifies REALITY, not intent: an interrupted mode transition (journal with a
 * dead owner) is reconciled first, then the effective mode is resolved from
 * the (possibly rewritten) state plus the live patch marker. A system with no
 * install state at all has no mode — `repair` remains the documented
 * fresh-install path there.
 */
function repairStandsDownInChatgptMode(opts: Opts, dependencies: RepairDependencies): boolean {
  const paths = ensureUserPaths();
  const state = readState(paths.stateFile);
  if (!state) return false;

  const readMarker = dependencies.readAsarMarker ?? readAsarMarker;
  const appRoot = opts.app ?? state.appRoot;
  let marker: AsarMarker = "unreadable";
  try {
    marker = readMarker(locateCodex(appRoot).asarPath);
  } catch {
    // A mid-update bundle can be briefly unreadable; an explicit state.mode
    // still decides below, and inference treats it as unpatched.
  }

  try {
    const reconciled = reconcileModeTransition(
      { root: paths.root, stateFile: paths.stateFile },
      { marker, appRoot },
      { log: opts.quiet ? undefined : (line) => console.log(kleur.dim(line)) },
    );
    if (reconciled.action === "in-progress") {
      console.log(kleur.yellow(`A Tweakers mode switch is in progress (PID ${reconciled.ownerPid}); skipping this repair.`));
      return true;
    }
  } catch {
    // Reconciliation is hygiene here; the mode resolution below still decides.
  }

  const current = readState(paths.stateFile) ?? state;
  if (resolveMode(current, marker === "present") !== "chatgpt") return false;
  if (current.mode === "chatgpt" && marker === "present") {
    // Reality mismatch without a journal: something patched the app outside
    // the mode machinery. Never patch further and never stay silent.
    console.warn(kleur.yellow("State says ChatGPT mode but the live app carries the Tweakers patch marker."));
    console.warn(kleur.yellow(`Run ${kleur.cyan("tweakers mode status")} and ${kleur.cyan("tweakers mode chatgpt")} to reconcile.`));
    return true;
  }
  console.log(kleur.yellow("ChatGPT mode is active; repair is standing down (the official app stays pristine)."));
  console.log(kleur.yellow(`Run ${kleur.cyan("tweakers mode tweakers")} to switch back to the patched app.`));
  return true;
}

function showSigningUnavailableNotification(): void {
  try {
    const child = spawn(
      "osascript",
      [
        "-e",
        'display notification "Codex updated — open Tweakers or run `tweakers repair` to re-enable your tweaks." with title "Tweakers repair deferred"',
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Notification delivery is best-effort and must never turn deferral into failure.
  }
}

/**
 * Dev-mode reconcile: when a source checkout is linked, ensure every valid
 * repo tweak folder is symlinked into the user tweaks dir. Runs on every
 * watcher pass; safe while Codex runs (tweak files hot-reload). Never a
 * repair blocker.
 */
function syncDevTweaks(tweaksDir: string, configFile: string, opts: Opts): void {
  if (platform() !== "darwin") return;
  const devTweaksRoot = readDevTweaksRoot(configFile);
  if (!devTweaksRoot || !existsSync(devTweaksRoot)) return;
  try {
    reconcileDevTweaks(
      tweaksDir,
      devTweaksRoot,
      opts.quiet ? undefined : (line) => console.log(kleur.dim(line)),
    );
  } catch {
    // Hygiene only.
  }
}

export const OFFICIAL_CODEX_BUNDLE_ID = "com.openai.codex";
const OPENAI_AUTHORITY_PATTERN = /^Developer ID Application: OpenAI\b/;

export interface OfficialUpdateDriftInput {
  state: InstallerState | null;
  codex: Pick<CodexInstall, "appRoot" | "bundleId" | "metaPath" | "platform">;
  watcherRepair: boolean;
  force: boolean;
  updateModeFile: string;
  /** Test seams. */
  readVersion?: (metaPath: string | null) => string | null;
  verifyAppSignature?: (appRoot: string) => { ok: boolean; adHoc: boolean; authority: string[] };
}

/**
 * A coordinated quit (watcher actively quits Codex to promote) is allowed only
 * for CONFIRMED official updates. All conditions must hold; anything unknown
 * — manual drift, resigned-by-something-else app, same-version tamper — holds
 * passively instead. The sixth condition (candidate validated) is structural:
 * the quit only fires inside install()'s `held` branch, which the transaction
 * reaches only after candidate validation passed.
 */
export function isConfirmedOfficialUpdateDrift(input: OfficialUpdateDriftInput): boolean {
  if (!input.watcherRepair) return false;
  if (input.force) return false;
  if (!input.state) return false;
  if (input.codex.bundleId !== OFFICIAL_CODEX_BUNDLE_ID) return false;

  const readVersion = input.readVersion ?? readCodexVersion;
  const currentVersion = readVersion(input.codex.metaPath);
  // Version/build must have actually changed; same-version hash drift alone
  // never triggers a quit.
  if (!currentVersion || !input.state.codexVersion || currentVersion === input.state.codexVersion) {
    return false;
  }

  const updateMode = readUpdateMode(input.updateModeFile);
  if (updateMode && isUpdateModeFresh(updateMode)) return true;

  if (input.codex.platform !== "darwin") return false;
  try {
    const verify =
      input.verifyAppSignature ??
      ((appRoot: string) => {
        const info = signatureInfo(appRoot);
        return { ok: info.ok && verifySignature(appRoot).ok, adHoc: info.adHoc, authority: info.authority };
      });
    const signature = verify(input.codex.appRoot);
    return signature.ok && !signature.adHoc && signature.authority.some((a) => OPENAI_AUTHORITY_PATTERN.test(a));
  } catch {
    return false;
  }
}

function announceCodexUpdateDetected(updateModeFile: string, appRoot: string): void {
  const updateMode = readUpdateMode(updateModeFile);
  if (!updateMode || updateMode.patchingNotifiedAt) return;

  try {
    const codex = locateCodex(appRoot);
    const codexVersion = readCodexVersion(codex.metaPath);
    if (!codexVersion || codexVersion === updateMode.codexVersion) return;
    showCodexUpdateDetectedNotification();
    writeUpdateMode(updateModeFile, {
      ...updateMode,
      patchingNotifiedAt: new Date().toISOString(),
    });
  } catch {
    // The app bundle may be mid-update. The settle wait below handles that path.
  }
}

function notifyUpdateModePaused(updateModeFile: string, fallbackAppRoot: string): void {
  const updateMode = readUpdateMode(updateModeFile);
  if (!updateMode || updateMode.notifiedAt || !isUpdateModeFresh(updateMode)) return;

  const appRoot = updateMode.appRoot || fallbackAppRoot;
  showUpdateModePausedAlert(appRoot, updateMode.codexVersion);
  writeUpdateMode(updateModeFile, {
    ...updateMode,
    notifiedAt: new Date().toISOString(),
  });
}

function isAutoUpdateEnabled(configFile: string): boolean {
  if (!existsSync(configFile)) return true;
  try {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as {
      codexPlusPlus?: { autoUpdate?: boolean };
    };
    return config.codexPlusPlus?.autoUpdate !== false;
  } catch {
    return true;
  }
}

export interface SettleOptions {
  quiet?: boolean;
  timeoutMs?: number;
  retryNoticeMs?: number;
}

function settleOptions(opts: Opts, updateModeFile: string): SettleOptions {
  const updateMode = readUpdateMode(updateModeFile);
  const watcherRetry = isWatcherRepair(opts) && updateMode !== null && isUpdateModeFresh(updateMode);
  return {
    quiet: opts.quiet,
    timeoutMs: watcherRetry ? WATCHER_SETTLE_TIMEOUT_MS : SETTLE_TIMEOUT_MS,
    retryNoticeMs: watcherRetry ? WATCHER_RETRY_NOTICE_MS : undefined,
  };
}

function isWatcherRepair(opts: Opts): boolean {
  return opts.watcher === true || process.env.CODEX_PLUSPLUS_WATCHER === "1";
}

/**
 * True when a live process holds the coordinated-refresh lock or the install
 * transaction lock. Stale locks (dead owners) do not block; the transaction
 * lock acquirer also reclaims stale locks itself.
 */
function isRepairBlockedByActiveTransaction(userRoot: string, transactionStateFile: string): boolean {
  const refreshLock = join(userRoot, "refresh-local.lock");
  return isLockHeldByLiveOwner(refreshLock)
    || isTransactionLockHeld(transactionLockFile(transactionStateFile));
}

/**
 * Normal-startup hygiene: on a watcher pass where the patch is intact, sweep
 * only STALE helper generations — bundle-owned PPID-1 processes that predate
 * the current main process (or all of them when no main process is running).
 * Active current-generation helpers are never touched.
 */
function cleanupStaleHelperGeneration(appRoot: string, opts: Opts, deps: RepairDependencies = {}): void {
  if (!isWatcherRepair(opts) || platform() !== "darwin") return;
  let mainStartedAt: string | null;
  try {
    const codex = locateCodex(appRoot);
    const scan = deps.listProcesses ?? listProcesses;
    const processes = scan();
    const main = mainCodexProcesses(codex.executable, processes);
    if (main.length === 0) {
      mainStartedAt = null;
    } else {
      const earliest = earliestByStart(main);
      // A running main whose start time we cannot read gives no generation
      // boundary — current-generation crashpad helpers also reparent to PPID 1,
      // so sweeping with null here could kill live helpers. Skip instead.
      if (!earliest.startedAt) return;
      mainStartedAt = earliest.startedAt;
    }
  } catch {
    // Unknown process state: fail safe, sweep nothing this cycle.
    return;
  }
  try {
    terminateStaleHelperProcesses(appRoot, {
      mainStartedAt,
      log: opts.quiet ? undefined : (line) => console.log(kleur.dim(line)),
    });
  } catch {
    // Cleanup is hygiene, never a repair blocker.
  }
}

function mainCodexProcesses(executable: string, processes: ProcessInfo[]): ProcessInfo[] {
  return processes.filter(
    (p) => p.command === executable || p.command.startsWith(`${executable} `),
  );
}

function earliestByStart(processes: ProcessInfo[]): ProcessInfo {
  return [...processes].sort((a, b) => {
    const at = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
    const bt = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.pid - b.pid;
  })[0];
}

export async function waitForMacAppUpdateToSettle(appRoot: string | undefined, opts: SettleOptions = {}): Promise<void> {
  if (platform() !== "darwin" || !appRoot) return;

  const paths = [
    join(appRoot, "Contents", "Info.plist"),
    join(appRoot, "Contents", "Resources", "app.asar"),
  ];

  let previous = bundleSnapshot(paths);
  let stableSamples = 0;
  let announced = previous.includes(":missing:");
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  let lastRetryNotice = started;
  if (announced && !opts.quiet) {
    console.log(kleur.dim("Waiting for Codex.app update files to appear..."));
  }

  while (Date.now() - started < timeoutMs) {
    await delay(SETTLE_SAMPLE_MS);
    const snapshot = bundleSnapshot(paths);
    if (!snapshot.includes(":missing:") && snapshot === previous && patchInputsReadable(appRoot)) {
      stableSamples += 1;
      if (stableSamples >= SETTLE_STABLE_SAMPLES) return;
    } else {
      stableSamples = 0;
      previous = snapshot;
      if (!opts.quiet && !announced) {
        console.log(kleur.dim("Waiting for Codex.app update files to settle..."));
        announced = true;
      }
    }
    if (
      opts.retryNoticeMs &&
      !opts.quiet &&
      Date.now() - started > SETTLE_TIMEOUT_MS &&
      Date.now() - lastRetryNotice >= opts.retryNoticeMs
    ) {
      console.log(kleur.dim("Codex.app still appears to be updating; retrying repair shortly..."));
      lastRetryNotice = Date.now();
    }
  }
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  throw new Error(`Codex.app still appears to be updating after ${minutes}m; retry repair after the update finishes.`);
}

function bundleSnapshot(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const st = statSync(p);
        return `${p}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${p}:missing:0`;
      }
    })
    .join("|");
}

function statAsarFile(asarPath: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(asarPath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function patchInputsReadable(appRoot: string): boolean {
  try {
    const codex = locateCodex(appRoot);
    if (!readCodexVersion(codex.metaPath)) return false;
    readHeaderHash(codex.asarPath);
    return true;
  } catch {
    return false;
  }
}

function refreshWatcher(
  previous: NonNullable<ReturnType<typeof readState>>["watcher"],
  appRoot: string,
  quiet?: boolean,
): NonNullable<ReturnType<typeof readState>>["watcher"] {
  if (previous === "none") return previous;
  try {
    return installWatcher(appRoot);
  } catch (e) {
    if (!quiet) console.warn(kleur.yellow(`Watcher refresh failed: ${(e as Error).message}`));
    return previous;
  }
}

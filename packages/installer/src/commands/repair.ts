import kleur from "kleur";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { install, readAsarMarker, readAsarPatchSchema, readCodexVersion, runtimeAssetsMatch, stageAssets, stageBundledTweaks, type AsarMarker, type AsarPatchSchema } from "./install.js";
import { ensureUserPaths, userPaths } from "../paths.js";
import { readState, resolveMode, writeState, type InstallerState } from "../state.js";
import { reconcileModeTransition } from "../mode-transition.js";
import { locateCodex, type CodexInstall } from "../platform.js";
import { signatureInfo, signingAvailable, verifySignature } from "../codesign.js";
import { listProcesses } from "./debug.js";
import { readConfigFile, readDevTweaksRoot } from "../config.js";
import { reconcileDevTweaks } from "./dev-sync.js";
import { readHeaderHash } from "../asar.js";
import { TWEAKER_VERSION, compareSemver } from "../version.js";
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
import { isLockHeldByLiveOwner, processAlive } from "../process-lock.js";
import {
  assertLifecycleReceiptsIdle,
  desktopReceiptBlocksLifecycle,
  environmentReceiptBlocksLifecycle,
  isLifecycleLockHeld,
  lifecycleLockFile,
  withLifecycleLock,
} from "../lifecycle-lock.js";
import { readDesktopUpdateReceipt } from "../desktop-update-transaction.js";
import { readEnvironmentTransactionReceipt } from "../environment-transaction.js";
import { formatCliShimResult, type CliShimResult } from "../cli-shim.js";
import { reconcileManagedCliShims } from "../managed-runtime.js";
import { LEGACY_WATCHER_ENV } from "../legacy-compat.js";
import { migrateLegacyTweakNamespaces } from "../tweak-namespace-migration.js";
import { decideRuntimeFingerprintRepair, readRuntimeFingerprint } from "../runtime-fingerprint.js";
import { updateAutoRepairState, type RuntimeRepairState } from "../auto-repair-state.js";
import {
  reconcileAdoptedMcpLifecycle,
  type McpLifecycleRepairResult,
} from "./mcp-lifecycle.js";
import { targetUserHome } from "../ownership.js";

interface Opts {
  app?: string;
  quiet?: boolean;
  force?: boolean;
  localSigning?: boolean;
  watcher?: boolean;
}

export interface AsarStatFingerprint {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  ctimeMs: number;
  headerHash: string;
}

type AsarStatObservation =
  Pick<AsarStatFingerprint, "size" | "mtimeMs">
  & Partial<Omit<AsarStatFingerprint, "size" | "mtimeMs">>;

export interface RepairDependencies {
  install?: typeof install;
  signingAvailable?: typeof signingAvailable;
  notifySigningUnavailable?: () => void;
  // Stat-guard seams (task 5a). Default to the real implementations below.
  statAsar?: (asarPath: string) => AsarStatObservation | null;
  readHeaderHash?: typeof readHeaderHash;
  runtimeAssetsMatch?: typeof runtimeAssetsMatch;
  listProcesses?: typeof listProcesses;
  waitForSettle?: (appRoot: string | undefined, opts: SettleOptions) => Promise<void>;
  /** Mode-guard seam: how the live patch marker is observed. */
  readAsarMarker?: typeof readAsarMarker;
  readAsarPatchSchema?: (asarPath: string) => AsarPatchSchema;
  /** Manual-only shim reconciliation seam; watcher repair never invokes it. */
  reconcileCliShims?: () => CliShimResult | void;
  readExpectedRuntimeFingerprint?: () => string | null;
  readActiveRuntimeFingerprint?: (runtimeRoot: string) => string | null;
  isAppRunning?: (appRoot: string) => boolean;
  stageAssets?: typeof stageAssets;
  stageBundledTweaks?: typeof stageBundledTweaks;
  now?: () => Date;
  /** Reconcile only after an explicit managed-adoption receipt exists. */
  reconcileMcpLifecycle?: () => McpLifecycleRepairResult | null;
}

export type RepairOutcome =
  | { status: "completed" }
  | { status: "deferred" | "skipped"; reason: string };

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
  await repairWithOutcome(opts, dependencies);
}

export async function repairWithOutcome(
  opts: Opts = {},
  dependencies: RepairDependencies = {},
): Promise<RepairOutcome> {
  const preliminaryPaths = userPaths();
  const watcherRepair = isWatcherRepair(opts);
  if (watcherRepair) {
    const block = classifyRepairTransactionBlock(
      preliminaryPaths.root,
      preliminaryPaths.transactionStateFile,
    );
    if (block.kind === "orphaned") {
      if (!opts.quiet) {
        console.log(kleur.yellow(
          `${block.receiptKind === "environment" ? "Environment transaction" : "Desktop update"} ${block.transactionId} `
          + `was left behind by exited PID ${block.ownerPid} (phase ${block.phase}); `
          + "check `tweaker update-chatgpt-status`, then `tweaker update-chatgpt-resume` if it is resumable, "
          + "or `tweaker update-chatgpt-cancel` (`tweaker environment recover` for an environment-only orphan) to recover.",
        ));
      }
      return { status: "deferred", reason: "orphaned-transaction" };
    }
    if (block.kind === "active") {
      if (!opts.quiet) {
        console.log(kleur.yellow("Another Tweakers lifecycle operation is active; skipping this repair pass."));
      }
      return { status: "deferred", reason: "active-transaction" };
    }
  }

  try {
    return await withLifecycleLock(
      lifecycleLockFile(preliminaryPaths.root),
      "repair",
      async () => {
        assertLifecycleReceiptsIdle(preliminaryPaths.root);
        const lifecycle = (dependencies.reconcileMcpLifecycle
          ?? (() => reconcileAdoptedMcpLifecycle({
            targetHome: targetUserHome(),
            userRoot: preliminaryPaths.root,
          })))();
        if (lifecycle?.status === "deferred" && !opts.quiet) {
          console.log(kleur.yellow(`MCP lifecycle repair deferred: ${lifecycle.reason ?? "status is not safely reloadable"}.`));
        }
        return repairWithLifecycle(opts, dependencies);
      },
    );
  } catch (error) {
    // A watcher may lose the race between its read-only preflight and lock
    // acquisition. Treat only lifecycle contention as a deferred pass; real
    // repair failures must remain visible.
    if (watcherRepair && isLifecycleContentionError(error)) {
      if (!opts.quiet) {
        console.log(kleur.yellow("Another Tweakers lifecycle operation is active; skipping this repair pass."));
      }
      return { status: "deferred", reason: "active-transaction" };
    }
    throw error;
  }
}

async function repairWithLifecycle(
  opts: Opts,
  dependencies: RepairDependencies,
): Promise<RepairOutcome> {
  // ChatGPT-mode guard — deliberately the FIRST statement, before the
  // transaction-block check, the stat guard, and update-mode handling, and it
  // applies to --force repairs too: while ChatGPT mode is active the official
  // app stays pristine, so every repair path (including a straggling
  // refresh-local promote) must no-op loudly instead of re-patching.
  if (repairStandsDownInChatgptMode(opts, dependencies)) {
    return { status: "skipped", reason: "chatgpt-mode" };
  }
  const paths = ensureUserPaths();
  const deferredRepairFile = paths.deferredRepairFile ?? join(paths.root, "deferred-repair.json");
  const watcherRepair = isWatcherRepair(opts);
  const appIsRunning = dependencies.isAppRunning ?? isCodexRunning;
  const deferredRepair = watcherRepair ? null : readDeferredRepair(deferredRepairFile);
  const waitForSettle = dependencies.waitForSettle ?? waitForMacAppUpdateToSettle;

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

  // Manual repair is also the recovery command for a healthy install whose
  // public CLI shims are missing. Reconcile before every manual fast path so
  // "Patch already intact" still repairs the command, but never do this from
  // the periodic watcher (or from the candidate install it delegates to).
  if (!watcherRepair) {
    const reconcileCliShims = dependencies.reconcileCliShims
      ?? (() => reconcileManagedCliShims(sourceRoot, paths.root, paths.binDir));
    const cliShims = reconcileCliShims();
    if (cliShims && !opts.quiet) console.log(formatCliShimResult(cliShims));
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
  // Run bounded watcher/tweak hygiene only every Nth pass. Process cleanup is
  // owned exclusively by the managed MCP lifecycle reaper.
  const statAsar = dependencies.statAsar ?? statAsarFile;
  if (watcherRepair && !opts.force && state?.patchedAsarStat) {
    const appRoot = opts.app ?? state.appRoot;
    const asarPath = join(appRoot, "Contents", "Resources", "app.asar");
    const current = statAsar(asarPath);
    if (asarFingerprintsMatch(current, state.patchedAsarStat)) {
      const passes = (state.watcherStatGuardPasses ?? 0) + 1;
      const expectedFingerprint = (dependencies.readExpectedRuntimeFingerprint
        ?? (() => readRuntimeFingerprint(packagedRuntimeRoot()))
      )();
      const activeFingerprint = (dependencies.readActiveRuntimeFingerprint ?? readRuntimeFingerprint)(paths.runtime);
      const fingerprintDecision = decideRuntimeFingerprintRepair({
        expected: expectedFingerprint,
        active: activeFingerprint,
        appRunning: appIsRunning(appRoot),
      });
      recordRuntimeRepairState(paths.root, {
        status: fingerprintDecision.action === "repair"
          ? "repairing"
          : fingerprintDecision.action,
        expectedFingerprint,
        activeFingerprint,
        checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        error: null,
      });

      if (fingerprintDecision.action === "pending") {
        if (!opts.quiet) console.log(kleur.yellow("Runtime update held until a later cycle observes ChatGPT closed."));
        return { status: "deferred", reason: "runtime-drift-app-running" };
      }
      const fullVerificationRequired = fingerprintDecision.action === "repair"
        || (fingerprintDecision.action === "unknown" && passes % STAT_GUARD_HYGIENE_EVERY_N === 0);
      if (fullVerificationRequired) {
        if (!opts.quiet) console.log(kleur.yellow("Runtime fingerprint requires a full repair verification."));
      } else if (passes % STAT_GUARD_HYGIENE_EVERY_N === 0) {
        const watcher = refreshWatcher(state.watcher, appRoot, opts.quiet);
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
      if (!fullVerificationRequired) {
        if (!opts.quiet) console.log(kleur.green("Patch intact (app.asar and runtime unchanged)."));
        return { status: "completed" };
      }
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
        return { status: "deferred", reason: "codex-update-mode" };
      }
      if (codexVersion === updateMode.codexVersion && !opts.quiet) {
        console.log(kleur.yellow("Codex update mode is stale; clearing it and repairing Tweakers."));
      }
      clearUpdateMode(paths.updateModeFile);
    }
    const readHeader = dependencies.readHeaderHash ?? readHeaderHash;
    const runtimeMatches = dependencies.runtimeAssetsMatch ?? runtimeAssetsMatch;
    const { headerHash } = readHeader(codex.asarPath);
    const patchSchema = (dependencies.readAsarPatchSchema ?? readAsarPatchSchema)(codex.asarPath);
    if (headerHash === state.patchedAsarHash && patchSchema !== "legacy") {
      if (!appIsRunning(codex.appRoot)) {
        migrateLegacyTweakNamespaces(paths.root, paths.configFile);
      }
      const patchedAsarStat = statAsar(codex.asarPath) ?? state.patchedAsarStat;
      const watcher = refreshWatcher(state.watcher, codex.appRoot, opts.quiet);
      syncDevTweaks(paths.tweaks, paths.configFile, opts);
      // Always complete the existing full-tree verification after the cheap
      // fingerprint gate requests repair. Do not let a version comparison
      // short-circuit the proof that active runtime bytes actually differ.
      const runtimeIsCurrent = runtimeMatches(paths.runtime);
      if (compareSemver(TWEAKER_VERSION, state.version) > 0 || !runtimeIsCurrent) {
        if (!isAutoUpdateEnabled(paths.configFile)) {
          if (!opts.quiet) console.log(kleur.yellow("Tweakers auto-update is disabled."));
          return { status: "skipped", reason: "auto-update-disabled" };
        }
        if (appIsRunning(codex.appRoot)) {
          recordRuntimeRepairState(paths.root, {
            status: "pending",
            expectedFingerprint: (dependencies.readExpectedRuntimeFingerprint
              ?? (() => readRuntimeFingerprint(packagedRuntimeRoot())))(),
            activeFingerprint: (dependencies.readActiveRuntimeFingerprint ?? readRuntimeFingerprint)(paths.runtime),
            checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            error: null,
          });
          if (!opts.quiet) console.log(kleur.yellow("Runtime update held until a later cycle observes Codex closed."));
          return { status: "deferred", reason: "runtime-drift-app-running" };
        }
        const expectedFingerprint = (dependencies.readExpectedRuntimeFingerprint
          ?? (() => readRuntimeFingerprint(packagedRuntimeRoot())))();
        try {
          (dependencies.stageAssets ?? stageAssets)(paths.runtime);
          (dependencies.stageBundledTweaks ?? stageBundledTweaks)(paths.tweaks, paths.runtime, {
            devTweaksRoot: readDevTweaksRoot(paths.configFile),
            log: opts.quiet ? undefined : (line) => console.log(kleur.dim(line)),
          });
        } catch (error) {
          recordRuntimeRepairState(paths.root, {
            status: "failed",
            expectedFingerprint,
            activeFingerprint: (dependencies.readActiveRuntimeFingerprint ?? readRuntimeFingerprint)(paths.runtime),
            checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const stagedActiveFingerprint = (dependencies.readActiveRuntimeFingerprint ?? readRuntimeFingerprint)(paths.runtime);
        if (expectedFingerprint !== null && stagedActiveFingerprint !== expectedFingerprint) {
          const error = "Runtime fingerprint did not match the packaged runtime after staging";
          recordRuntimeRepairState(paths.root, {
            status: "failed",
            expectedFingerprint,
            activeFingerprint: stagedActiveFingerprint,
            checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            error,
          });
          throw new Error(error);
        }
        recordRuntimeRepairState(paths.root, {
          status: expectedFingerprint === null || stagedActiveFingerprint === null ? "unknown" : "current",
          expectedFingerprint,
          activeFingerprint: stagedActiveFingerprint,
          checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          error: null,
        });
        writeState(paths.stateFile, {
          ...state,
          watcher,
          version: TWEAKER_VERSION,
          sourceRoot,
          runtimeUpdatedAt: new Date().toISOString(),
          patchedAsarStat,
          watcherStatGuardPasses: 0,
        });
        if (!opts.quiet) {
          console.log(
            kleur.green(`Updated Tweakers runtime ${state.version} → ${TWEAKER_VERSION}.`),
          );
        }
        return { status: "completed" };
      }
      writeState(paths.stateFile, {
        ...state,
        watcher,
        sourceRoot,
        patchedAsarStat,
        watcherStatGuardPasses: 0,
      });
      if (!opts.quiet) console.log(kleur.green("Patch already intact."));
      return { status: "completed" };
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
    if (appIsRunning(codex.appRoot)) {
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

  // In ChatGPT mode no repair is wanted at all, so never record a deferred
  // "signing-unavailable" repair (and its warning) for work that would stand
  // down anyway. The pre-mutation re-check below still closes the race.
  if (repairStandsDownInChatgptMode(opts, dependencies)) {
    return { status: "skipped", reason: "chatgpt-mode" };
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
    return { status: "deferred", reason: "signing-unavailable" };
  }

  // Re-read the mode IMMEDIATELY before mutating: the settle wait above can
  // last up to 15 minutes, during which a `tweaker mode chatgpt` switch may
  // have completed. This closes the in-flight-watcher race.
  if (repairStandsDownInChatgptMode(opts, dependencies)) {
    return { status: "skipped", reason: "chatgpt-mode" };
  }

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
    reconcileCliShims: false,
  });
  syncDevTweaks(paths.tweaks, paths.configFile, opts);
  if (deferredRepair) clearDeferredRepair(deferredRepairFile);
  if (!opts.quiet) console.log(kleur.green("✓ Repair complete."));
  return { status: "completed" };
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

  const reconciled = reconcileModeTransition(
    { root: paths.root, stateFile: paths.stateFile },
    { marker, appRoot },
    { log: opts.quiet ? undefined : (line) => console.log(kleur.dim(line)) },
  );
  if (reconciled.action === "in-progress") {
    console.log(kleur.yellow(`A Tweakers mode switch is in progress (PID ${reconciled.ownerPid}); skipping this repair.`));
    return true;
  }
  if (reconciled.action === "blocked") {
    throw new Error(`Interrupted Tweakers mode switch requires recovery: ${reconciled.reason}`);
  }

  const current = readState(paths.stateFile) ?? state;
  if (resolveMode(current, marker === "present") !== "chatgpt") return false;
  if (current.mode === "chatgpt" && marker === "present") {
    // Reality mismatch without a journal: something patched the app outside
    // the mode machinery. Never patch further and never stay silent.
    console.warn(kleur.yellow("State says ChatGPT mode but the live app carries the Tweakers patch marker."));
    console.warn(kleur.yellow(`Run ${kleur.cyan("tweaker mode status")} and ${kleur.cyan("tweaker mode chatgpt")} to reconcile.`));
    return true;
  }
  console.log(kleur.yellow("ChatGPT mode is active; repair is standing down (the official app stays pristine)."));
  console.log(kleur.yellow(`Run ${kleur.cyan("tweaker mode tweakers")} to switch back to the patched app.`));
  return true;
}

function showSigningUnavailableNotification(): void {
  try {
    const child = spawn(
      "osascript",
      [
        "-e",
        'display notification "Codex updated — open Tweakers or run `tweaker repair` to re-enable your tweaks." with title "Tweakers repair deferred"',
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
  const config = readConfigFile(configFile) as { tweaker?: { autoUpdate?: boolean } };
  return config.tweaker?.autoUpdate !== false;
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
  return opts.watcher === true
    || process.env.TWEAKER_WATCHER === "1"
    || process.env[LEGACY_WATCHER_ENV] === "1";
}

type RepairTransactionBlock =
  | { kind: "none" }
  | { kind: "active" }
  | {
    kind: "orphaned";
    receiptKind: "environment" | "desktop-update";
    transactionId: string;
    ownerPid: number;
    phase: string;
  };

/**
 * Classify what blocks a watcher repair pass. Short-lived locks are already
 * owner-liveness-aware; durable receipts are not, so a receipt whose blocking
 * predicate fires is further split by whether its recorded owner is alive:
 * a live owner is genuine contention ("active"), a dead one is an orphan the
 * watcher can name so the user (or UI) can run explicit recovery. Receipts
 * are read via the same exported predicates the lifecycle gate uses, so the
 * classifier can never drift from the gate. Unreadable receipts classify as
 * "active" — the conservative direction.
 */
function classifyRepairTransactionBlock(
  userRoot: string,
  transactionStateFile: string,
): RepairTransactionBlock {
  const refreshLock = join(userRoot, "refresh-local.lock");
  if (isLifecycleLockHeld(userRoot)
    || isLockHeldByLiveOwner(refreshLock)
    || isTransactionLockHeld(transactionLockFile(transactionStateFile))) {
    return { kind: "active" };
  }
  let orphan: RepairTransactionBlock | null = null;
  try {
    const environment = readEnvironmentTransactionReceipt(join(userRoot, "transactions", "environment.json"));
    if (environment && environmentReceiptBlocksLifecycle(environment) !== null) {
      if (environment.ownerPid === process.pid || processAlive(environment.ownerPid)) {
        return { kind: "active" };
      }
      orphan = {
        kind: "orphaned",
        receiptKind: "environment",
        transactionId: environment.transactionId,
        ownerPid: environment.ownerPid,
        phase: environment.phase,
      };
    }
    const desktop = readDesktopUpdateReceipt(join(userRoot, "transactions", "desktop-update.json"));
    if (desktop && desktopReceiptBlocksLifecycle(desktop) !== null) {
      if (desktop.ownerPid === process.pid || processAlive(desktop.ownerPid)) {
        return { kind: "active" };
      }
      orphan = {
        kind: "orphaned",
        receiptKind: "desktop-update",
        transactionId: desktop.transactionId,
        ownerPid: desktop.ownerPid,
        phase: desktop.phase,
      };
    }
  } catch {
    return { kind: "active" };
  }
  return orphan ?? { kind: "none" };
}

function isLifecycleContentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Another Tweakers lifecycle operation is active/i.test(message)
    || /Environment transaction .*finish or cancel/i.test(message)
    || /Desktop update .*resume or cancel/i.test(message)
    || /Desktop update .*recover it explicitly/i.test(message);
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

function statAsarFile(asarPath: string): AsarStatFingerprint | null {
  try {
    const st = statSync(asarPath);
    const { headerHash } = readHeaderHash(asarPath);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      dev: st.dev,
      ino: st.ino,
      ctimeMs: st.ctimeMs,
      headerHash,
    };
  } catch {
    return null;
  }
}

function asarFingerprintsMatch(
  current: AsarStatObservation | null,
  recorded: unknown,
): boolean {
  const left = completeAsarFingerprint(current);
  const right = completeAsarFingerprint(recorded);
  return left !== null
    && right !== null
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.ctimeMs === right.ctimeMs
    && left.headerHash === right.headerHash;
}

function completeAsarFingerprint(value: unknown): AsarStatFingerprint | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AsarStatFingerprint>;
  if (
    !isFingerprintNumber(candidate.size)
    || !isFingerprintNumber(candidate.mtimeMs)
    || !isFingerprintNumber(candidate.dev)
    || !isFingerprintNumber(candidate.ino)
    || !isFingerprintNumber(candidate.ctimeMs)
    || typeof candidate.headerHash !== "string"
    || !/^[a-f0-9]{64}$/i.test(candidate.headerHash)
  ) {
    return null;
  }
  return candidate as AsarStatFingerprint;
}

function isFingerprintNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function packagedRuntimeRoot(): string {
  const packaged = resolve(here, "..", "..", "assets", "runtime");
  return existsSync(packaged)
    ? packaged
    : resolve(here, "..", "..", "..", "runtime", "dist");
}

function recordRuntimeRepairState(userRoot: string, runtime: RuntimeRepairState): void {
  updateAutoRepairState(userRoot, (current) => ({
    ...(current ?? {}),
    schemaVersion: 1,
    checkedAt: runtime.checkedAt,
    runtime,
  }));
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

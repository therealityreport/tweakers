import kleur from "kleur";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, readdirSync, rmSync, copyFileSync, renameSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { locateCodex, type CodexInstall } from "../platform.js";
import { ensureUserPaths, type UserPaths } from "../paths.js";
import { backupOnce, patchAsar, readFileInAsar, readHeaderHash } from "../asar.js";
import { setIntegrity, getIntegrity } from "../integrity.js";
import { writeFuse } from "../fuses.js";
import { clearQuarantine, isDeveloperIdSignedBackup, prepareCodeSigning, signCodexApp, signatureInfo, verifySignature } from "../codesign.js";

// Re-export from its new home (codesign.ts) so existing importers keep working.
export { isDeveloperIdSignedBackup };
import { readPlist } from "../plist.js";
import { readState, writeState } from "../state.js";
import { installWatcher, type WatcherKind } from "../watcher.js";
import { CODEX_PLUSPLUS_VERSION } from "../version.js";
import { formatCliShimResult, installCliShims } from "../cli-shim.js";
import { findSourceRoot } from "../source-root.js";
import {
  CODEX_WINDOW_SERVICES_KEY,
  describeCodexWindowServicesSource,
  patchCodexWindowServicesSource,
  type CodexWindowServicesSourceDiagnostics,
} from "../codex-window-services.js";
import { chownForTargetUser, targetUserHome } from "../ownership.js";
import { getOpenReport, reportsMainProcessRunning, type OpenReport } from "./debug.js";
import { openCodex, quitCodex, showCodexUpdateDetectedNotification } from "../alerts.js";
import { terminateStaleHelperProcesses } from "../orphans.js";
import { runHeldPromotion } from "../watcher-held.js";
import { isSymlinkInto } from "../symlinks.js";
import {
  cloneAppTree,
  filesystemTransactionAdapters,
  generateProductionHealthReceipt,
  runInstallTransaction,
  readProductionHealthReceipt,
  type AppFingerprint,
  type NativeHealthProbeAdapter,
} from "../transaction.js";
import { migrateAutomatically } from "./migrate.js";
import { readDevTweaksRoot } from "../config.js";
import { ensureManagedRuntime } from "../managed-runtime.js";
import { reconcileDock, reconcileLaunchServices } from "../macos-app-identity.js";
import { applyMacAppIdentity, type MacAppIdentity } from "../macos-variant.js";
import { parkedPayloadRoot } from "../mode-transition.js";
import { ensureSwitcherInstalled } from "../switcher-setup.js";

interface Opts {
  app?: string;
  fuse?: boolean; // sade --no-fuse → fuse: false
  resign?: boolean;
  localSigning?: boolean;
  watcher?: boolean;
  watcherKind?: WatcherKind;
  quiet?: boolean;
  verbose?: boolean;
  candidateOnly?: boolean;
  /** Internal: a validated candidate intentionally held for the coordinated refresh flow. */
  candidateOnlyReason?: "explicit" | "coordinated-refresh";
  /** Watcher-only: confirmed official-update drift; actively quit Codex to promote instead of waiting passively. */
  coordinatedQuit?: boolean;
  /** Internal native probe bridge; tests inject fakes and production hosts provide the real bridge. */
  nativeHealthProbe?: NativeHealthProbeAdapter;
  /** macOS-only identity and user-data isolation for a separate Tweakers app. */
  macAppIdentity?: MacAppIdentity;
  /** Internal only: patch/sign a disposable candidate without global side effects. */
  candidateContext?: { paths: UserPaths; finalUserRoot: string };
  /**
   * Internal only: set by `tweakers mode tweakers` so the deliberate mode
   * switch may patch the live app while state.mode is still "chatgpt".
   */
  modeTransition?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(here, "..", "..", "assets");
const sourceRoot = findSourceRoot(here);

export function spawnHiddenHealthProbe(
  executable: string,
  userRoot: string,
  deps: { spawn?: typeof spawnSync } = {},
): ReturnType<typeof spawnSync> {
  const spawn = deps.spawn ?? spawnSync;
  // The disposable probe must never attach to the real Electron profile: the
  // owl fork resolves userData natively at startup, so a probe launched while
  // the same-productName app is running hits Chromium's process singleton and
  // is forwarded ("Opening in existing browser session.") before any JS —
  // including the health-receipt path — can run. An explicit throwaway
  // --user-data-dir sidesteps both the singleton and profile writes.
  return spawn(executable, [`--user-data-dir=${join(userRoot, "electron-user-data")}`], {
    env: {
      ...process.env,
      TWEAKERS_HEALTH_CHECK_ONLY: "1",
      TWEAKERS_HEALTH_USER_ROOT: userRoot,
      TWEAKERS_HEALTH_BACKGROUND: "1",
    },
    stdio: "ignore",
    timeout: 15_000,
  });
}

export async function install(opts: Opts = {}): Promise<void> {
  if (opts.candidateContext) return installCandidateInPlace(opts);
  if (opts.localSigning === false && opts.candidateOnly !== true) {
    throw new Error("Ad-hoc signing is allowed only with explicit --candidate-only and can never be promoted.");
  }

  const paths = ensureUserPaths();
  // Mutation-site mode guard: while ChatGPT mode is active the official app
  // stays pristine, so no caller (CLI, watcher repair, held promotion re-entry)
  // may patch it without the deliberate mode-switch flag. This is what closes
  // the watcher race — every promotion path re-enters install() and re-reads
  // the mode here.
  if (!opts.modeTransition && readState(paths.stateFile)?.mode === "chatgpt") {
    throw new Error(
      "Refusing to install while ChatGPT mode is active.\n" +
        "The app at the official path stays pristine in ChatGPT mode.\n" +
        `Run ${kleur.cyan("tweakers mode tweakers")} to switch back to the patched app.`,
    );
  }

  const codex = locateCodex(opts.app);
  const source = fingerprintCodex(codex);
  const payloadHash = installerPayloadHash();
  const candidateUserRoot = join(paths.transactionRoot, "candidate-user");
  const candidatePaths = transactionUserPaths(candidateUserRoot);
  const candidateSignedBackup = join(candidatePaths.backup, "Codex.app");
  const liveSignedBackup = join(paths.backup, "Codex.app");
  const signedBackupSnapshot = join(paths.transactionRoot, "last-known-good-backup");
  const signedBackupSnapshotState = join(paths.transactionRoot, "last-known-good-backup.json");
  const signedBackupWiring = createSignedBackupTransactionWiring({
    candidateBackup: candidateSignedBackup,
    liveBackup: liveSignedBackup,
    snapshot: signedBackupSnapshot,
    marker: signedBackupSnapshotState,
  });
  const nonLiveAppRoots = [
    join(paths.transactionRoot, "candidate.app"),
    join(paths.transactionRoot, "pristine.app"),
    join(paths.transactionRoot, "last-known-good.app"),
    candidateSignedBackup,
    liveSignedBackup,
    join(targetUserHome(), "Library", "Application Support", "Tweakers", "pristine-backup", "ChatGPT.app"),
    "/Volumes/ChatGPT Installer/ChatGPT.app",
  ];
  const reconcileMacRegistrations = (options: { garbageCollect: boolean }): void => {
    if (codex.platform !== "darwin") return;
    const launchServices = reconcileLaunchServices({
      appRoot: codex.appRoot,
      bundleId: opts.macAppIdentity?.bundleId ?? codex.bundleId ?? "com.openai.codex",
      nonLiveAppRoots,
      garbageCollect: options.garbageCollect,
    });
    if (launchServices.failed.length > 0 && !opts.quiet) {
      console.warn(kleur.yellow(`LaunchServices cleanup was incomplete: ${launchServices.failed.map((failure) => failure.path).join(", ")}`));
    }
  };
  const reconcileMacIdentityAfterPromotion = (): void => {
    reconcileMacRegistrations({ garbageCollect: true });
    try {
      reconcileDock({
        appRoot: codex.appRoot,
        bundleId: opts.macAppIdentity?.bundleId ?? codex.bundleId ?? "com.openai.codex",
        backupDir: paths.backup,
      });
    } catch (error) {
      if (!opts.quiet) console.warn(kleur.yellow(`Dock cleanup was skipped: ${errorMessage(error)}`));
    }
  };
  const requiredPermissions = requiredMacPermissions(paths.configFile);
  const candidateOnly = opts.candidateOnly === true;
  const signingMode = opts.localSigning === false ? "adhoc" : "local-identity";
  const adapters = filesystemTransactionAdapters({
    isAppRunning: (appRoot) => reportsMainProcessRunning(getOpenReport(locateCodex(appRoot))),
    buildCandidate: async (_pristineRoot, candidateRoot) => {
      await installCandidateInPlace({
        ...opts,
        app: candidateRoot,
        watcher: false,
        quiet: true,
        localSigning: signingMode === "local-identity",
        candidateContext: { paths: candidatePaths, finalUserRoot: paths.root },
      });
    },
    validateCandidate: (candidateRoot) => {
      try {
        const candidate = locateCodex(candidateRoot);
        if (candidate.platform === "darwin") {
          const signature = verifySignature(candidateRoot);
          if (!signature.ok) throw new Error(`candidate signature invalid: ${signature.output.trim().slice(0, 400)}`);
          if (!signedBackupWiring.validateCandidate()) throw new Error("candidate Developer-ID backup missing or unsigned");
        }
        const marker = readAsarMarker(candidate.asarPath);
        if (marker === "unreadable") throw new Error("candidate app.asar could not be read (corrupt or locked)");
        if (marker === "absent") throw new Error("patch marker absent from candidate app.asar (asar not patched)");
        return true;
      } finally {
        reconcileMacRegistrations({ garbageCollect: false });
      }
    },
    // A last-known-good snapshot may be a pristine app (taken right after an
    // official Codex update), so a restore is valid without the patch marker.
    validateRestoredApp: (appRoot) => {
      const restored = locateCodex(appRoot);
      // The candidate/LKG bytes were already deep-verified (codesign --verify
      // --deep --strict) before staging, and promotion is an atomic swap — so a
      // cheap identity check (codesign -dv) is sufficient here, not a second
      // full deep verify.
      return restored.platform === "darwin" ? signatureInfo(appRoot).ok : true;
    },
    probeCandidateHealth: ({ candidateRoot }) => {
      try {
        const candidate = locateCodex(candidateRoot);
        const expected = {
          app: fingerprintCodex(candidate),
          runtimeHash: hashDirectoryTree(candidatePaths.runtime),
          requiredPermissions,
        };
        const receiptFile = join(candidateUserRoot, "health", "promotion.json");
        writeHealthRequest(join(candidateUserRoot, "health", "request.json"), {
          schemaVersion: 1,
          requestedAt: new Date().toISOString(),
          ...expected,
        });
        const launched = spawnHiddenHealthProbe(candidate.executable, candidateUserRoot);
        if (launched.error || launched.status !== 0) {
          return { host: "unknown", session: "unknown", permissions: Object.fromEntries(requiredPermissions.map((permission) => [permission, "unknown" as const])) };
        }
        return readProductionHealthReceipt(receiptFile, expected);
      } finally {
        reconcileMacRegistrations({ garbageCollect: false });
      }
    },
    fingerprintApp: (appRoot) => fingerprintCodex(locateCodex(appRoot)),
    snapshotRuntime: (runtimeRoot, destination) => {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(runtimeRoot)) {
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(runtimeRoot, destination, { recursive: true, verbatimSymlinks: true });
      }
      signedBackupWiring.snapshotLive();
    },
    promoteCandidate: (candidateRoot, appRoot) => {
      // Verify and promote the pristine Developer-ID backup before mutating
      // the app. If a later app/runtime swap fails, restore backup continuity
      // immediately; the outer transaction owns app/runtime recovery.
      signedBackupWiring.promoteCandidate();
      try {
        replaceAppBundlePreservingIdentity(candidateRoot, appRoot, {
          validateDestination: (promotedRoot) => verifySignature(promotedRoot).ok,
          onCleanupFailure: (path, error) => {
            if (!opts.quiet) console.warn(kleur.yellow(`Old app payload cleanup will be retried on the next refresh (${path}): ${errorMessage(error)}`));
          },
        });
        replaceDirectory(candidatePaths.runtime, paths.runtime);
        reconcileMacIdentityAfterPromotion();
      } catch (error) {
        signedBackupWiring.restoreLive();
        throw error;
      }
    },
    restoreApp: (lastKnownGoodRoot, appRoot) => {
      replaceAppBundlePreservingIdentity(lastKnownGoodRoot, appRoot, {
        validateDestination: (restoredRoot) => verifySignature(restoredRoot).ok,
        onCleanupFailure: (path, error) => {
          if (!opts.quiet) console.warn(kleur.yellow(`Old app payload cleanup will be retried on the next refresh (${path}): ${errorMessage(error)}`));
        },
      });
      reconcileMacIdentityAfterPromotion();
    },
    restoreRuntime: (lastKnownGoodRuntimeRoot, runtimeRoot) => {
      if (existsSync(lastKnownGoodRuntimeRoot)) replaceDirectory(lastKnownGoodRuntimeRoot, runtimeRoot);
      else rmSync(runtimeRoot, { recursive: true, force: true });
      signedBackupWiring.restoreLive();
    },
    probeHealth: async () => {
      const expected = {
        app: fingerprintCodex(locateCodex(codex.appRoot)),
        runtimeHash: hashDirectoryTree(paths.runtime),
        requiredPermissions,
      };
      const receiptFile = join(paths.root, "health", "promotion.json");
      if (opts.nativeHealthProbe) {
        await generateProductionHealthReceipt(receiptFile, expected, opts.nativeHealthProbe);
      } else {
        // A separately identified variant may be unable to complete a normal
        // foreground launch while the official app owns OpenAI's shared
        // session. Validate the exact promoted bytes/runtime through the same
        // isolated one-shot probe used for the disposable candidate.
        if (opts.macAppIdentity) {
          spawnHiddenHealthProbe(locateCodex(codex.appRoot).executable, paths.root);
        }
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const observed = readProductionHealthReceipt(receiptFile, expected);
          if (observed.host !== "unknown" || observed.session !== "unknown") return observed;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return readProductionHealthReceipt(receiptFile, expected);
    },
    openApp: (appRoot) => {
      writeHealthRequest(join(paths.root, "health", "request.json"), {
        schemaVersion: 1,
        requestedAt: new Date().toISOString(),
        app: fingerprintCodex(locateCodex(appRoot)),
        runtimeHash: hashDirectoryTree(paths.runtime),
        requiredPermissions,
      });
      // Generate the promotion-health receipt with the hidden health-check
      // probe rather than a plain `open`. A normal launch of an app whose
      // instance is already running (a variant repaired while open, or the
      // official app relaunched mid-install) is forwarded to that instance and
      // never reaches our receipt path, leaving host health "unknown". The
      // health-check probe carries its own throwaway --user-data-dir, so it
      // gets a distinct singleton and always runs far enough to answer. The
      // user-visible relaunch is handled separately by the reopen-after-patch
      // path; this launch is only for the receipt.
      spawnHiddenHealthProbe(locateCodex(appRoot).executable, paths.root);
    },
  });

  const result = await runInstallTransaction({
    appRoot: codex.appRoot,
    runtimeRoot: paths.runtime,
    workRoot: paths.transactionRoot,
    stateFile: paths.transactionStateFile,
    source,
    payloadHash,
    requiredPermissions,
    candidateOnly,
    candidateOnlyReason: opts.candidateOnlyReason ?? "explicit",
    signingMode,
  }, adapters);

  if (result.status === "promoted") {
    // An older healthy transaction can predate full-app backup promotion. Its
    // validated candidate-user backup is still the authoritative repair source;
    // repair that continuity without touching or reopening the live app.
    if (codex.platform === "darwin" && !isDeveloperIdSignedBackup(liveSignedBackup)) {
      promoteVerifiedSignedBackup(candidateSignedBackup, liveSignedBackup);
    }
    // Every promotion refreshes the LIVE full backup (signedBackupWiring), so
    // the live-root partial backups must be refreshed with it — otherwise
    // uninstall's partial-restore fallback could one day write a years-old
    // asar/Info.plist into a current bundle (the exact Chromium-profile
    // downgrade the mode toggle refuses).
    if (codex.platform === "darwin" && isDeveloperIdSignedBackup(liveSignedBackup)) {
      try {
        refreshLivePartialBackups(codex, liveSignedBackup, paths.backup);
      } catch (error) {
        if (!opts.quiet) console.warn(kleur.yellow(`Live partial-backup refresh failed: ${errorMessage(error)}`));
      }
    }
    ensureManagedRuntime(sourceRoot, paths.root);
    const candidateState = readState(candidatePaths.stateFile);
    if (candidateState) {
      let watcher: WatcherKind = "none";
      if (opts.watcher !== false) {
        try {
          watcher = installWatcher(codex.appRoot);
        } catch (error) {
          if (!opts.quiet) console.warn(kleur.yellow(`Watcher install failed: ${errorMessage(error)}`));
        }
      }
      writeState(paths.stateFile, {
        ...candidateState,
        appRoot: codex.appRoot,
        watcher,
      });
    }
    // A promoted live app is by definition in Tweakers mode, and any parked
    // ChatGPT-mode payload predates this promotion (now stale) — discard it.
    finalizePromotedModeState(paths.stateFile, paths.root);
    // The menu-bar switcher rides along with every promotion (nonfatal): it is
    // the only in-GUI way back to Tweakers mode after a switch to ChatGPT
    // mode, but an app promotion must never fail over a menu-bar helper.
    if (codex.platform === "darwin") {
      try {
        const switcher = await ensureSwitcherInstalled();
        if (!switcher.installed && !opts.quiet) {
          console.warn(kleur.yellow(`Menu-bar switcher install skipped: ${switcher.reason ?? "unknown reason"}`));
        }
      } catch (error) {
        if (!opts.quiet) console.warn(kleur.yellow(`Menu-bar switcher install failed: ${errorMessage(error)}`));
      }
    }
    try {
      migrateAutomatically(paths.root, join(assetsDir, "runtime", "tweaks"));
    } catch (error) {
      // Migration never deletes or mutates its legacy input. Keep a successful
      // app promotion usable while reporting the isolated data item failure.
      if (!opts.quiet) console.warn(kleur.yellow(`Legacy Projects migration was skipped: ${errorMessage(error)}`));
    }
    try {
      // Candidate staging prunes the candidate root; the LIVE tweaks dir is
      // user data that promotion never replaces, so retired tweaks staged by
      // an older runtime survive there unless pruned here.
      pruneRetiredTweaks(paths.tweaks, { devTweaksRoot: readDevTweaksRoot(paths.configFile) });
    } catch (error) {
      if (!opts.quiet) console.warn(kleur.yellow(`Retired-tweak pruning was skipped: ${errorMessage(error)}`));
    }
  }

  // Every terminal status must produce one unambiguous final line. Failure
  // states throw so the CLI exits non-zero and `wrap` prints the reason —
  // never return silently (that was the "candidate-only exits quietly" bug).
  const liveAppRoot = codex.appRoot;
  switch (result.status) {
    case "promoted":
      if (!opts.quiet) {
        console.log(kleur.green().bold(`✓ Tweakers installed and promoted into ${liveAppRoot}.`));
        console.log(`  Launch Codex normally; the Tweaks tab appears in Settings.`);
        if (requiredPermissions.length === 0) {
          console.log(
            kleur.yellow(`  macOS permissions: not verified (requiredMacPermissions unset in config).`),
          );
        }
      }
      return;
    case "candidate-ready":
      if (!opts.quiet) {
        console.log(kleur.green().bold("✓ Candidate validated (candidate-only)."));
        console.log(`  The live app at ${kleur.cyan(liveAppRoot)} was not modified.`);
        console.log(`  Disposable candidate + backup live under ${kleur.cyan(paths.transactionRoot)}.`);
        console.log(`  To go live: rerun ${kleur.cyan("tweakers install")} without --candidate-only.`);
      }
      return;
    case "held":
      console.log(kleur.yellow().bold("• Candidate validated and held."));
      console.log(`  Codex is currently running, so the live app was not changed.`);
      if (process.env.CODEX_PLUSPLUS_WATCHER === "1") {
        return runHeldPromotion(
          {
            getReport: () => getOpenReport(locateCodex(liveAppRoot)),
            guardModeAllowsPromotion: () => {
              if (opts.modeTransition === true) return true;
              return readState(paths.stateFile)?.mode !== "chatgpt";
            },
            quitApp: () => quitCodex(liveAppRoot),
            cleanupOrphans: () => {
              terminateStaleHelperProcesses(liveAppRoot, {
                mainStartedAt: null,
                log: (line) => console.log(`  ${line}`),
              });
            },
            notifyUpdateQuit: () => showCodexUpdateDetectedNotification(),
            // Re-entry always drops coordinatedQuit so a relaunch race yields a
            // plain held + passive wait, never a second forced quit.
            reenter: () => install({ ...opts, coordinatedQuit: false }),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            log: (line) => console.log(`  ${line}`),
          },
          { coordinatedQuit: opts.coordinatedQuit === true },
        );
      }
      console.log(`  Quit Codex, then rerun ${kleur.cyan("tweakers install")} (or let the watcher promote it).`);
      return;
    case "rolled-back":
      throw new Error(
        `Promotion health check failed; rolled back to the last-known-good app and runtime ` +
          `(rollback ${result.state.rollbackResult ?? "attempted"}).\n` +
          `Reason: ${result.state.failure ?? "unknown"}\n` +
          `The live app at ${liveAppRoot} is the restored, working version.`,
      );
    case "blocked":
      throw new Error(
        `A previous promotion left the install in a degraded state and auto-recovery is blocked.\n` +
          `Reason: ${result.state.failure ?? "unknown"}\n` +
          `Quit Codex and run "tweakers repair --force", or restore from ${result.state.lastKnownGoodRoot}.`,
      );
    case "invalidated":
      throw new Error(formatInvalidatedInstallError(liveAppRoot, result.state.failure, result.state.pendingReason));
    default:
      throw new Error(`Install finished in an unexpected state: ${(result as { status: string }).status}`);
  }
}

async function installCandidateInPlace(opts: Opts): Promise<void> {
  const wantsFuseFlip = opts.fuse !== false;
  const resign = opts.resign !== false;
  let localSigning = opts.localSigning !== false;
  const wantWatcher = opts.watcher !== false;

  const step = makeStepper({ quiet: opts.quiet === true, verbose: opts.verbose === true });
  const codex = locateCodex(opts.app);
  const fuseFlip = shouldFlipElectronFuse(codex, wantsFuseFlip);
  const codexVersion = readCodexVersion(codex.metaPath);
  step(`Codex: ${kleur.cyan(codex.appRoot)}${codexVersion ? ` (${kleur.cyan(codexVersion)}, ${codex.channel})` : ` (${codex.channel})`}`);
  if (wantsFuseFlip && !fuseFlip) {
    step.detail("Skipping Electron fuse flip; Electron Framework binary was not found");
  }
  preflightSystemTools(codex.platform, resign, codex.metaPath !== null);
  const reopenAfterPatch = opts.candidateContext ? false : preflightAppClosed(codex, step);

  // Pre-flight every app-bundle target we will mutate so permission failures
  // surface before we patch app.asar or touch backups.
  preflightWritableTargets(codex, { fuseFlip });
  step.detail("Bundle writable");

  let preparedSigning: ReturnType<typeof prepareCodeSigning> = null;
  if (resign && codex.platform === "darwin") {
    try {
      preparedSigning = prepareCodeSigning({ useLocalIdentity: localSigning });
    } catch (e) {
      throw new Error(`Tweakers Local Signing is required for promotable candidates.\n${(e as Error).message}`);
    }
  }

  const paths = opts.candidateContext?.paths ?? ensureUserPaths();
  step.detail(`User dir: ${kleur.cyan(paths.root)}`);
  if (!opts.candidateContext) step(formatCliStep(formatCliShimResult(installCliShims(paths.binDir))));
  const launcher = opts.candidateContext ? null : installWindowsManagedAppLauncher(codex);
  if (launcher) step(`Installed patched Tweakers launcher${launcher.shortcutPaths.length === 1 ? "" : "s"}: ${launcher.shortcutPaths.map((p) => kleur.cyan(p)).join(", ")}`);

  // 1. Backup originals.
  const pristineAppBackup = codex.platform === "darwin" ? join(paths.backup, "Codex.app") : null;
  const backupAsar = join(paths.backup, "app.asar");
  const backupAsarUnpacked = join(paths.backup, "app.asar.unpacked");
  const backupPlist = codex.metaPath ? join(paths.backup, "Info.plist") : null;
  const backupFramework = join(paths.backup, "Electron Framework");
  let appBackupRefreshed = false;
  let appBackupRefreshedFromLiveApp = false;
  let appBackupSeededFromPreserved = false;
  if (pristineAppBackup) {
    appBackupRefreshed = backupUnpatchedApp(codex.appRoot, pristineAppBackup, {
      hasPatchMarker: hasCodexPlusPlusAsarMarker(codex.asarPath),
      step: step.detail,
    });
    appBackupRefreshedFromLiveApp = appBackupRefreshed;
    // When the live app is already patched (Tweakers re-signed it locally), it
    // can no longer serve as a Developer-ID backup source, so the candidate's
    // signed backup would be missing/unsigned and validation would fail — which
    // makes re-install on an already-patched app impossible. Seed it from the
    // preserved Developer-ID original in the real user dir instead.
    const finalUserRoot = opts.candidateContext?.finalUserRoot;
    if (!isDeveloperIdSignedBackup(pristineAppBackup) && finalUserRoot) {
      const preservedDevIdBackup = join(finalUserRoot, "backup", "Codex.app");
      if (isDeveloperIdSignedBackup(preservedDevIdBackup)) {
        cloneAppTree(preservedDevIdBackup, pristineAppBackup);
        appBackupRefreshed = true;
        appBackupSeededFromPreserved = true;
        step.detail("Seeded candidate signed backup from preserved Developer-ID original");
      }
    }
  }
  // A full-backup refresh must also refresh the copy-if-absent partial backups
  // (app.asar, Info.plist, Electron Framework) so partials can never be older
  // than the full backup. When the refresh came from the live pristine app the
  // partials re-copy from it below; a seed from the preserved Developer-ID
  // original refreshes them from that backup tree (the live app is patched).
  if (appBackupRefreshedFromLiveApp) {
    removePartialBackups({ backupAsar, backupAsarUnpacked, backupPlist, backupFramework });
  } else if (appBackupSeededFromPreserved && pristineAppBackup) {
    removePartialBackups({ backupAsar, backupAsarUnpacked, backupPlist, backupFramework });
    refreshPartialBackupsFromBackupApp(codex, pristineAppBackup, {
      backupAsar,
      backupAsarUnpacked,
      backupPlist,
      backupFramework,
    });
  }
  backupOnce(codex.asarPath, backupAsar);
  if (existsSync(`${codex.asarPath}.unpacked`)) {
    backupOnce(`${codex.asarPath}.unpacked`, backupAsarUnpacked);
  }
  if (codex.metaPath && backupPlist) backupOnce(codex.metaPath, backupPlist);
  if (fuseFlip) backupOnce(codex.electronBinary, backupFramework);
  step(appBackupRefreshed ? "Backup refreshed" : "Backup ready");

  const { headerHash: originalAsarHash } = readHeaderHash(codex.asarPath);

  // 2. Stage runtime + loader into the user dir.
  stageAssets(paths.runtime);
  step("Runtime staged");

  // 3. Patch app.asar entry point to require our loader.
  const originalEntry = await injectLoader(
    codex.asarPath,
    opts.candidateContext?.finalUserRoot ?? paths.root,
    step.detail,
    opts.macAppIdentity?.appUserDataRoot,
    opts.macAppIdentity?.displayName,
  );
  const { headerHash: patchedAsarHash } = readHeaderHash(codex.asarPath);
  step.detail(`Patched app.asar (entry was ${kleur.dim(originalEntry)})`);

  // 4. Update Info.plist hash so Electron's integrity check passes.
  if (codex.metaPath) {
    setIntegrity(codex, patchedAsarHash);
    step.detail(`Updated ElectronAsarIntegrity → ${kleur.dim(patchedAsarHash.slice(0, 12))}…`);
  }
  if (codex.platform === "darwin" && opts.macAppIdentity) {
    const changed = applyMacAppIdentity(codex.appRoot, opts.macAppIdentity);
    step.detail(`Applied isolated macOS app identity (${changed.length} plist${changed.length === 1 ? "" : "s"})`);
  }

  // 5. Belt-and-suspenders: flip the integrity validation fuse off.
  let fuseFlipped = false;
  if (fuseFlip) {
    try {
      const r = writeFuse(
        codex.electronBinary,
        "EnableEmbeddedAsarIntegrityValidation",
        "off",
      );
      step.detail(`Fuse EnableEmbeddedAsarIntegrityValidation: ${r.from} → ${r.to}`);
      fuseFlipped = true;
    } catch (e) {
      console.warn(kleur.yellow(`Fuse flip failed: ${(e as Error).message}`));
    }
  }
  step("App patched");

  // 6. Re-sign on macOS.
  let resigned = false;
  let signingMode: "local-identity" | "adhoc" | undefined;
  let signingIdentity: string | undefined;
  let signingIdentityHash: string | undefined;
  if (resign && codex.platform === "darwin") {
    clearQuarantine(codex.appRoot);
    const signing = signCodexApp(codex.appRoot, {
      useLocalIdentity: localSigning,
      preparedIdentity: preparedSigning,
    });
    resigned = true;
    signingMode = signing?.mode;
    signingIdentity = signing?.identity;
    signingIdentityHash = signing?.identityHash;
    if (signing?.mode === "local-identity") {
      step(
        `Signing: ${signing.createdIdentity ? "created local identity" : "local identity"} ${kleur.cyan(signing.identity)}`,
      );
    } else {
      step("Signing: ad-hoc");
    }
  }

  // 7. Auto-repair watcher.
  let watcher: WatcherKind = opts.watcherKind ?? "none";
  if (wantWatcher && !opts.candidateContext) {
    try {
      watcher = installWatcher(codex.appRoot);
      step(`Watcher: ${watcher}`);
    } catch (e) {
      console.warn(kleur.yellow(`Watcher install failed: ${(e as Error).message}`));
    }
  }

  // 8. Persist state.
  writeState(paths.stateFile, {
    version: CODEX_PLUSPLUS_VERSION,
    installedAt: new Date().toISOString(),
    appRoot: codex.appRoot,
    originalAsarHash,
    patchedAsarHash,
    codexVersion,
    codexChannel: codex.channel,
    codexBundleId: opts.macAppIdentity?.bundleId ?? codex.bundleId,
    fuseFlipped,
    resigned,
    signingMode,
    signingIdentity,
    signingIdentityHash,
    originalEntryPoint: originalEntry,
    watcher,
    sourceRoot,
  });
  if (!opts.candidateContext) chownForTargetUser(paths.root, { recursive: true });
  if (reopenAfterPatch) {
    openCodex(codex.appRoot, { detached: true, delayMs: 1_000 });
    step("Codex reopened");
  }

  if (!opts.quiet && !opts.candidateContext) {
    console.log();
    console.log(kleur.green().bold("✓ tweakers installed."));
    console.log(`  Tweaks: ${kleur.cyan(paths.tweaks)}`);
    console.log(`  Logs:   ${kleur.cyan(paths.logDir)}`);
    if (launcher) {
      console.log(`  Launch ${kleur.cyan("Tweakers")} from Start Menu or Desktop.`);
      console.log(`  Opening the Microsoft Store ${kleur.cyan("Codex")} app directly will launch the unpatched app.`);
    } else {
      console.log();
      console.log(`  Launch Codex normally; the Tweaks tab will appear in Settings.`);
      console.log();
    }
  }
}

interface PartialBackupTargets {
  backupAsar: string;
  backupAsarUnpacked: string;
  backupPlist: string | null;
  backupFramework: string;
}

function removePartialBackups(targets: PartialBackupTargets): void {
  rmSync(targets.backupAsar, { force: true });
  rmSync(targets.backupAsarUnpacked, { recursive: true, force: true });
  if (targets.backupPlist) rmSync(targets.backupPlist, { force: true });
  rmSync(targets.backupFramework, { recursive: true, force: true });
}

/**
 * Refresh the partial backups from a full pristine backup tree instead of the
 * (patched) live app, mapping each live-app path to its backup equivalent.
 */
function refreshPartialBackupsFromBackupApp(
  codex: Pick<CodexInstall, "appRoot" | "asarPath" | "metaPath" | "electronBinary">,
  backupApp: string,
  targets: PartialBackupTargets,
): void {
  const inBackup = (livePath: string) => join(backupApp, relative(codex.appRoot, livePath));
  const copyIfPresent = (from: string, to: string) => {
    if (!existsSync(from)) return;
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  };
  copyIfPresent(inBackup(codex.asarPath), targets.backupAsar);
  copyIfPresent(`${inBackup(codex.asarPath)}.unpacked`, targets.backupAsarUnpacked);
  if (codex.metaPath && targets.backupPlist) copyIfPresent(inBackup(codex.metaPath), targets.backupPlist);
  copyIfPresent(inBackup(codex.electronBinary), targets.backupFramework);
}

/**
 * Refresh the copy-if-absent partial backups (app.asar, Info.plist, Electron
 * Framework) sitting beside a full pristine backup, from that backup. Every
 * refresh of a root's FULL backup must run this for the same root: the
 * partials are consumed by uninstall's fallback restore, so they can never be
 * allowed to grow older than the full backup they sit next to.
 */
export function refreshLivePartialBackups(
  codex: Pick<CodexInstall, "appRoot" | "asarPath" | "metaPath" | "electronBinary">,
  backupApp: string,
  backupDir: string,
): void {
  const targets: PartialBackupTargets = {
    backupAsar: join(backupDir, "app.asar"),
    backupAsarUnpacked: join(backupDir, "app.asar.unpacked"),
    backupPlist: codex.metaPath ? join(backupDir, "Info.plist") : null,
    backupFramework: join(backupDir, "Electron Framework"),
  };
  // Removal first: an interruption leaves partials absent (restore then falls
  // back to the full backup), never stale.
  removePartialBackups(targets);
  refreshPartialBackupsFromBackupApp(codex, backupApp, targets);
}

function transactionUserPaths(root: string): UserPaths {
  return {
    root,
    runtime: join(root, "runtime"),
    tweaks: join(root, "tweaks"),
    backup: join(root, "backup"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    updateModeFile: join(root, "update-mode.json"),
    selfUpdateStateFile: join(root, "self-update-state.json"),
    binDir: join(root, "bin"),
    logDir: join(root, "log"),
    transactionRoot: join(root, "transactions", "app-install"),
    transactionStateFile: join(root, "transactions", "app-install.json"),
  };
}

function fingerprintCodex(codex: CodexInstall): AppFingerprint {
  const plist = codex.metaPath ? readPlist(codex.metaPath) : {};
  return {
    version: String(plist.CFBundleShortVersionString ?? readCodexVersion(codex.metaPath) ?? "unknown"),
    build: String(plist.CFBundleVersion ?? "unknown"),
    hash: readHeaderHash(codex.asarPath).headerHash,
  };
}

function requiredMacPermissions(configFile: string): string[] {
  try {
    const value = JSON.parse(readFileSync(configFile, "utf8")) as { requiredMacPermissions?: unknown };
    if (!Array.isArray(value.requiredMacPermissions)) return [];
    return [...new Set(value.requiredMacPermissions.filter((permission): permission is string => permission === "accessibility" || permission === "screen-recording"))].sort();
  } catch {
    return [];
  }
}

function writeHealthRequest(path: string, request: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A receipt must prove this launch, never a previous launch of the same build.
  rmSync(join(dirname(path), "promotion.json"), { force: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function hashDirectoryTree(root: string): string {
  if (!existsSync(root)) return "missing";
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      hash.update(name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
      else if (entry.isSymbolicLink()) hash.update("symlink");
    }
  };
  visit(root);
  return hash.digest("hex");
}

function installerPayloadHash(): string {
  const hash = createHash("sha256");
  for (const root of [resolve(here, ".."), assetsDir]) {
    hash.update(root === assetsDir ? "assets" : "installer");
    hash.update(hashDirectoryTree(root));
  }
  return hash.digest("hex");
}

function replaceDirectory(source: string, destination: string): void {
  const temporary = `${destination}.tweakers-replacement-${process.pid}`;
  const previous = `${destination}.tweakers-previous-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  cpSync(source, temporary, { recursive: true, verbatimSymlinks: true });
  if (existsSync(destination)) renameDirectory(destination, previous);
  try {
    renameDirectory(temporary, destination);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    if (existsSync(previous)) renameDirectory(previous, destination);
    throw error;
  }
}

interface AppBundleReplacementAdapters {
  swapDirectories?: (first: string, second: string) => void;
  removeDirectory?: (path: string) => void;
  validateDestination?: (appRoot: string) => boolean;
  onCleanupFailure?: (path: string, error: unknown) => void;
  /**
   * When set, the swapped-out Contents are renamed to this path instead of
   * being removed — but only after the promoted destination validated. A
   * failed validation still removes the incoming copy (it holds the rejected
   * bytes after the atomic rollback), and the rollback-failure path still
   * preserves the incoming copy as evidence exactly as before.
   */
  preserveOutgoing?: string;
}

export function replaceAppBundlePreservingIdentity(
  source: string,
  destination: string,
  adapters: AppBundleReplacementAdapters = {},
): void {
  const sourceContents = join(source, "Contents");
  const destinationContents = join(destination, "Contents");
  if (!existsSync(destination)) {
    replaceDirectory(source, destination);
    if (adapters.validateDestination && !adapters.validateDestination(destination)) {
      rmSync(destination, { recursive: true, force: true });
      throw new Error("Promoted app signature verification failed");
    }
    return;
  }
  if (!existsSync(sourceContents) || !existsSync(destinationContents)) {
    throw new Error("App bundle replacement requires source and destination Contents directories");
  }

  const swap = adapters.swapDirectories ?? atomicSwapDirectories;
  const remove = adapters.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  // A stable path makes cleanup debt recoverable: the next serialized
  // promotion removes any old payload left here before preparing its swap.
  const incoming = `${destination}.tweakers-contents-swap`;
  remove(incoming);
  cpSync(sourceContents, incoming, { recursive: true, verbatimSymlinks: true });
  let preserveIncoming = false;
  // Only true while `incoming` holds the swapped-out (previous) Contents; a
  // rolled-back validation failure flips it back so we never park rejected bytes.
  let incomingHoldsOutgoing = false;
  try {
    swap(incoming, destinationContents);
    incomingHoldsOutgoing = true;
    if (adapters.validateDestination && !adapters.validateDestination(destination)) {
      try {
        swap(incoming, destinationContents);
        incomingHoldsOutgoing = false;
      } catch (rollbackError) {
        preserveIncoming = true;
        throw new Error(`Promoted app signature verification failed and atomic rollback failed: ${errorMessage(rollbackError)}`);
      }
      throw new Error("Promoted app signature verification failed");
    }
  } finally {
    if (!preserveIncoming) {
      try {
        if (adapters.preserveOutgoing && incomingHoldsOutgoing) {
          moveDirectoryAcrossVolumes(incoming, adapters.preserveOutgoing);
        } else {
          remove(incoming);
        }
      } catch (error) {
        // The promoted app is already valid. Record the non-fatal cleanup debt;
        // the stable path above guarantees the next promotion retries it.
        adapters.onCleanupFailure?.(incoming, error);
      }
    }
  }
}

/**
 * A destination-validation failure whose atomic rollback SUCCEEDED: the live
 * bundle was restored byte-for-byte and no rejected bytes were parked. The
 * incoming payload is provably unusable (the identical bytes would fail every
 * retry), so callers may safely discard their copy of it.
 */
export function isSwapValidationRollback(error: unknown): boolean {
  return error instanceof Error && error.message === "Promoted app signature verification failed";
}

/**
 * A destination-validation failure whose atomic rollback ALSO failed: the live
 * bundle holds the rejected bytes and the outgoing Contents are preserved as
 * evidence at the stable swap path. Callers must leave recovery (journal,
 * remnant adoption) to reconcileModeTransition / the next promotion instead of
 * tidying up.
 */
export function isSwapRollbackFailure(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith("Promoted app signature verification failed and atomic rollback failed");
}

/** Rename with a copy fallback for cross-volume (EXDEV) destinations. */
function moveDirectoryAcrossVolumes(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    rmSync(source, { recursive: true, force: true });
  }
}

let nativeAppIdentityHost: { swapDirectories(first: string, second: string): void } | null = null;

function atomicSwapDirectories(first: string, second: string): void {
  if (process.platform !== "darwin") throw new Error("Atomic app bundle exchange is available only on macOS");
  if (!nativeAppIdentityHost) {
    const require = createRequire(import.meta.url);
    nativeAppIdentityHost = require(join(assetsDir, "runtime", "native", "codexpp_native_host.node")) as typeof nativeAppIdentityHost;
  }
  nativeAppIdentityHost!.swapDirectories(first, second);
}

function renameDirectory(source: string, destination: string): void {
  renameSync(source, destination);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readCodexVersion(metaPath: string | null): string | null {
  if (!metaPath || !existsSync(metaPath)) return null;
  try {
    const pl = readPlist(metaPath);
    return (pl["CFBundleShortVersionString"] as string) ?? null;
  } catch {
    return null;
  }
}

export function shouldFlipElectronFuse(
  codex: Pick<CodexInstall, "electronBinary">,
  requested: boolean,
): boolean {
  return requested && existsSync(codex.electronBinary);
}

export function shouldBackupUnpatchedApp(input: { hasPatchMarker: boolean; signature: ReturnType<typeof signatureInfo> }): boolean {
  if (input.hasPatchMarker) return false;
  return input.signature.ok;
}

export function backupUnpatchedApp(
  appRoot: string,
  backupPath: string,
  opts: { hasPatchMarker: boolean; step?: (msg: string) => void },
): boolean {
  const sig = signatureInfo(appRoot);
  if (!shouldBackupUnpatchedApp({ hasPatchMarker: opts.hasPatchMarker, signature: sig })) return false;

  cloneAppTree(appRoot, backupPath);
  opts.step?.(`Backed up unpatched Codex.app to ${kleur.cyan(backupPath)}`);
  return true;
}

interface SignedBackupPromotionAdapters {
  verifyDeveloperId?: (appRoot: string) => boolean;
  copyDirectory?: (source: string, destination: string) => void;
  renameDirectory?: (source: string, destination: string) => void;
  removeDirectory?: (path: string) => void;
}

export interface SignedBackupTransactionPaths {
  candidateBackup: string;
  liveBackup: string;
  snapshot: string;
  marker: string;
}

export interface SignedBackupTransactionWiring {
  validateCandidate(): boolean;
  snapshotLive(): void;
  promoteCandidate(): void;
  restoreLive(): void;
}

/** The exact backup lifecycle callbacks wired into the app install transaction. */
export function createSignedBackupTransactionWiring(
  paths: SignedBackupTransactionPaths,
  adapters: SignedBackupPromotionAdapters = {},
): SignedBackupTransactionWiring {
  const verify = adapters.verifyDeveloperId ?? isDeveloperIdSignedBackup;
  return {
    validateCandidate: () => verify(paths.candidateBackup),
    snapshotLive: () => snapshotSignedBackup(paths.liveBackup, paths.snapshot, paths.marker),
    promoteCandidate: () => promoteVerifiedSignedBackup(paths.candidateBackup, paths.liveBackup, adapters),
    restoreLive: () => restoreSignedBackupSnapshot(paths.liveBackup, paths.snapshot, paths.marker),
  };
}

/**
 * Promote the candidate context's pristine Codex.app into the live user root.
 * The candidate and staged copy are both verified before the old backup is
 * renamed, and every post-rename failure restores the old directory.
 */
export function promoteVerifiedSignedBackup(
  candidateBackup: string,
  liveBackup: string,
  adapters: SignedBackupPromotionAdapters = {},
): void {
  assertExactSignedBackupPath(candidateBackup);
  assertExactSignedBackupPath(liveBackup);
  const verify = adapters.verifyDeveloperId ?? isDeveloperIdSignedBackup;
  const copy = adapters.copyDirectory ?? ((source: string, destination: string) => {
    execFileSync("ditto", [source, destination], { stdio: "ignore" });
  });
  const rename = adapters.renameDirectory ?? renameDirectory;
  const remove = adapters.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  if (!verify(candidateBackup)) {
    throw new Error("Candidate Codex.app backup is not Developer ID signed; live backup was not modified.");
  }

  mkdirSync(dirname(liveBackup), { recursive: true });
  const incoming = `${liveBackup}.tweakers-incoming-${process.pid}`;
  const previous = `${liveBackup}.tweakers-previous-${process.pid}`;
  remove(incoming);
  remove(previous);
  try {
    copy(candidateBackup, incoming);
    if (!verify(incoming)) {
      throw new Error("Staged Codex.app backup failed Developer ID verification.");
    }
    const hadPrevious = existsSync(liveBackup);
    if (hadPrevious) rename(liveBackup, previous);
    try {
      rename(incoming, liveBackup);
      if (!verify(liveBackup)) {
        throw new Error("Promoted Codex.app backup failed Developer ID verification.");
      }
      remove(previous);
    } catch (error) {
      remove(liveBackup);
      if (hadPrevious && existsSync(previous)) rename(previous, liveBackup);
      throw error;
    }
  } finally {
    remove(incoming);
    // A successful promotion removes this above; after a failed restoration,
    // retain the previous path as evidence instead of deleting the only copy.
    if (existsSync(liveBackup)) remove(previous);
  }
}

export function snapshotSignedBackup(liveBackup: string, snapshot: string, marker: string): void {
  assertExactSignedBackupPath(liveBackup);
  mkdirSync(dirname(marker), { recursive: true });
  rmSync(snapshot, { recursive: true, force: true });
  // Absence of a marker means "snapshot not committed". Remove an older
  // transaction's marker before copying so an interruption cannot replay it.
  rmSync(marker, { force: true });
  const existed = existsSync(liveBackup);
  if (existed) cpSync(liveBackup, snapshot, { recursive: true, verbatimSymlinks: true });
  const temporary = `${marker}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, existed })}\n`, { mode: 0o600 });
  renameSync(temporary, marker);
}

export function restoreSignedBackupSnapshot(liveBackup: string, snapshot: string, marker: string): void {
  assertExactSignedBackupPath(liveBackup);
  let state: { schemaVersion?: unknown; existed?: unknown };
  try {
    state = JSON.parse(readFileSync(marker, "utf8")) as typeof state;
  } catch {
    // An interrupted transaction that never completed its snapshot must not
    // infer absence and delete a valid live backup.
    return;
  }
  if (state.schemaVersion !== 1 || typeof state.existed !== "boolean") return;
  if (!state.existed) {
    rmSync(liveBackup, { recursive: true, force: true });
    return;
  }
  if (!existsSync(snapshot)) throw new Error("Signed backup rollback snapshot is missing.");
  replaceDirectory(snapshot, liveBackup);
}

function assertExactSignedBackupPath(path: string): void {
  const absolute = resolve(path);
  if (basename(absolute) !== "Codex.app" || basename(dirname(absolute)) !== "backup") {
    throw new Error("Signed Codex.app backup path must be the exact app root under a backup directory.");
  }
}

/**
 * Post-promotion mode bookkeeping: record that the live app is now the patched
 * Tweakers payload and drop the (now stale) parked ChatGPT-mode payload.
 */
export function finalizePromotedModeState(stateFile: string, userRoot: string): void {
  const state = readState(stateFile);
  if (state && state.mode !== "tweakers") {
    writeState(stateFile, { ...state, mode: "tweakers" });
  }
  rmSync(parkedPayloadRoot(userRoot), { recursive: true, force: true });
}

export function hasCodexPlusPlusAsarMarker(asarPath: string): boolean {
  return readAsarMarker(asarPath) === "present";
}

export type AsarMarker = "present" | "absent" | "unreadable";

export function readAsarMarker(asarPath: string): AsarMarker {
  try {
    const pkg = JSON.parse(readFileInAsar(asarPath, "package.json").toString("utf8")) as {
      main?: unknown;
      __codexpp?: unknown;
    };
    return pkg.main === "codex-plusplus-loader.cjs" || typeof pkg.__codexpp === "object" ? "present" : "absent";
  } catch {
    return "unreadable";
  }
}

export function formatInvalidatedInstallError(liveAppRoot: string, failure?: string, pendingReason?: string): string {
  return `Candidate validation failed; the live app at ${liveAppRoot} was NOT modified.\n` +
    `Reason: ${failure ?? pendingReason ?? "candidate validation failed"}`;
}

/**
 * Replace app.asar's package.json `main` with our loader, copying the
 * loader.cjs into the asar so it can resolve. Returns the original entry path.
 */
async function injectLoader(
  asarPath: string,
  userRoot: string,
  step: (msg: string) => void = () => {},
  appUserDataRoot?: string,
  appDisplayName?: string,
): Promise<string> {
  let originalMain = "";
  await patchAsar(asarPath, (dir) => {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error("app.asar has no package.json — Codex layout changed?");
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    originalMain = String(pkg.main ?? "");
    if (!originalMain) throw new Error("app.asar package.json has no `main` field");

    // Preserve the original entry across repairs while refreshing isolated paths.
    if (pkg["__codexpp"]) originalMain = String(pkg["__codexpp"].originalMain);
    pkg["__codexpp"] = {
      originalMain,
      userRoot,
      loader: "codex-plusplus-loader.cjs",
      ...(appUserDataRoot ? { appUserDataRoot } : {}),
    };
    // The owl Electron fork resolves userData/singleton paths natively from
    // the asar's productName BEFORE any JS runs and ignores a later
    // app.setPath("userData"). A variant must therefore carry its own
    // product identity here, or it shares (and races) the official app's
    // profile at the Chromium layer no matter what the loader does.
    if (appDisplayName) {
      pkg.productName = appDisplayName;
    }
    pkg.main = "codex-plusplus-loader.cjs";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // Copy our loader stub into the asar root.
    const loaderSrc = join(assetsDir, "loader.cjs");
    if (!existsSync(loaderSrc)) {
      // Fall back to the in-repo path during development.
      const devLoader = resolve(here, "..", "..", "..", "..", "loader", "loader.cjs");
      if (!existsSync(devLoader)) {
        throw new Error(`loader.cjs not found at ${loaderSrc} or ${devLoader}`);
      }
      cpSync(devLoader, join(dir, "codex-plusplus-loader.cjs"));
    } else {
      cpSync(loaderSrc, join(dir, "codex-plusplus-loader.cjs"));
    }

    patchCodexWindowServices(dir, originalMain, step);
  });
  return originalMain;
}

interface CodexWindowServicesCandidateDiagnostic {
  relativePath: string;
  bytes: number;
  diagnostics: CodexWindowServicesSourceDiagnostics;
  parserError?: string;
}

function patchCodexWindowServices(
  appDir: string,
  originalMain: string,
  step: (msg: string) => void = () => {},
): void {
  const candidates = findCodexMainCandidates(appDir, originalMain);
  const candidateNames = candidates.map((p) => relative(appDir, p) || basename(p));
  step(
    `Scanning Codex window services hook candidates (${candidates.length}): ${
      candidateNames.length ? candidateNames.map((p) => kleur.dim(p)).join(", ") : kleur.yellow("none")
    }`,
  );
  const diagnostics: CodexWindowServicesCandidateDiagnostic[] = [];

  for (const mainPath of candidates) {
    const source = readFileSync(mainPath, "utf8");
    const relativePath = relative(appDir, mainPath) || basename(mainPath);
    const candidateDiagnostic: CodexWindowServicesCandidateDiagnostic = {
      relativePath,
      bytes: source.length,
      diagnostics: describeCodexWindowServicesSource(source, CODEX_WINDOW_SERVICES_KEY),
    };
    diagnostics.push(candidateDiagnostic);

    let patched: ReturnType<typeof patchCodexWindowServicesSource> = null;
    try {
      patched = patchCodexWindowServicesSource(source, CODEX_WINDOW_SERVICES_KEY);
    } catch (e) {
      candidateDiagnostic.parserError = (e as Error).message;
      continue;
    }

    if (patched) {
      if (patched.changed) writeFileSync(mainPath, patched.source);
      step(
        `Exposed Codex window services from ${kleur.dim(relativePath)} using ${kleur.cyan(patched.strategy)}${
          patched.serviceVar ? ` (${patched.serviceVar})` : ""
        }`,
      );
      return;
    }
  }

  throw new Error(formatWindowServicesHookFailure(originalMain, diagnostics));
}

export function findCodexMainCandidates(appDir: string, originalMain: string): string[] {
  const originalPath = resolve(appDir, originalMain);
  const out = existsSync(originalPath) ? [originalPath] : [];
  const buildDir = resolve(appDir, ".vite", "build");
  const roots: Array<{ dir: string; recursive: boolean }> = [
    { dir: appDir, recursive: false },
    { dir: buildDir, recursive: true },
  ];
  const originalDir = dirname(originalPath);
  if (originalDir !== appDir && !isSameOrInside(originalDir, buildDir)) {
    roots.push({ dir: originalDir, recursive: true });
  }

  const discovered = roots
    .flatMap((root) => collectJavaScriptFiles(root.dir, root.recursive))
    .sort((a, b) => {
      const rank = candidateRank(basename(a)) - candidateRank(basename(b));
      if (rank !== 0) return rank;
      const name = basename(a).localeCompare(basename(b));
      if (name !== 0) return name;
      return relative(appDir, a).localeCompare(relative(appDir, b));
    });

  const seen = new Set(out);
  for (const candidate of discovered) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function candidateRank(name: string): number {
  if (/^main(?:[-.].*)?\.js$/.test(name)) return 0;
  if (/^bootstrap(?:[-.].*)?\.js$/.test(name)) return 1;
  if (/^(app|desktop|src)(?:[-.].*)?\.js$/.test(name)) return 2;
  if (/preload|worker|service/i.test(name)) return 4;
  return 3;
}

function collectJavaScriptFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const target = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) out.push(...collectJavaScriptFiles(target, true));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(target);
      }
    }
  } catch {}
  return out;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

function formatWindowServicesHookFailure(
  originalMain: string,
  diagnostics: CodexWindowServicesCandidateDiagnostic[],
): string {
  const lines = [
    "Codex window services hook point not found.",
    "",
    "Tweakers could not identify Codex's main-process window services factory.",
    "This usually means Codex changed its bundled main-process layout or renamed the service object properties.",
    "",
    `Original entry point: ${originalMain}`,
    `Candidate files scanned: ${diagnostics.length}`,
  ];

  if (diagnostics.length === 0) {
    lines.push("No candidate files existed inside app.asar.");
    return lines.join("\n");
  }

  for (const candidate of diagnostics) {
    const fingerprints = candidate.diagnostics.matchedFingerprints;
    lines.push(
      "",
      `Candidate: ${candidate.relativePath}`,
      `  Bytes: ${candidate.bytes}`,
      `  Marker already present: ${candidate.diagnostics.hasMarker ? "yes" : "no"}`,
      `  Object factory calls: ${candidate.diagnostics.objectCalls}`,
      `  buildFlavor properties: ${candidate.diagnostics.buildFlavorProperties}`,
      `  Window-service fingerprints: ${fingerprints.length ? fingerprints.join(", ") : "none"}`,
    );
    if (candidate.parserError) {
      lines.push(`  Parser error: ${candidate.parserError}`);
    }
    if (candidate.diagnostics.snippet) {
      lines.push(`  Nearby source: ${candidate.diagnostics.snippet}`);
    }
  }

  return lines.join("\n");
}

export function stageAssets(runtimeDir: string): void {
  const src = join(assetsDir, "runtime");
  if (existsSync(src)) {
    replaceDirectory(src, runtimeDir);
    chownForTargetUser(runtimeDir, { recursive: true });
    return;
  }
  // Dev fallback: copy from the in-tree built runtime.
  const devSrc = resolve(here, "..", "..", "..", "..", "runtime", "dist");
  if (existsSync(devSrc)) {
    replaceDirectory(devSrc, runtimeDir);
    chownForTargetUser(runtimeDir, { recursive: true });
    return;
  }
  throw new Error(
    `Runtime assets not found. Expected at ${src} (built package) or ${devSrc} (dev).\n` +
      `Run \`npm run build\` from the workspace root.`,
  );
}

/**
 * Bundled tweaks retired from the catalog. The staging loop below only ever
 * ADDS folders, so without an explicit prune an upgraded install would keep
 * loading a retired tweak's staged copy forever (mode-switcher's stale copy
 * even rendered a second, non-functional App Mode control). Dev-mode symlinks
 * are the developer's live checkout and are left to dev-sync's sweep.
 */
const RETIRED_BUNDLED_TWEAKS = ["mode-switcher", "co.tweakers.mode-switcher"];

export function stageBundledTweaks(
  tweaksDir: string,
  runtimeDir: string,
  opts: { devTweaksRoot?: string | null; log?: (message: string) => void } = {},
): void {
  const catalog = JSON.parse(readFileSync(join(runtimeDir, "catalog.json"), "utf8")) as {
    entries?: Array<{ id?: unknown; source?: { kind?: unknown; path?: unknown } }>;
  };
  const devRoot = opts.devTweaksRoot ?? null;
  const devSnapshotFolders = readDevSnapshotFolders(join(tweaksDir, ".codexpp-dev-snapshot.json"));
  const bundledFolders = new Set<string>();
  for (const entry of catalog.entries ?? []) {
    if (entry.source?.kind !== "bundled" || typeof entry.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(entry.id)) continue;
    if (typeof entry.source.path !== "string" || !/^tweaks\/[a-zA-Z0-9._-]+$/.test(entry.source.path)) {
      throw new Error(`Bundled tweak path is invalid: ${entry.id}`);
    }
    const source = join(runtimeDir, entry.source.path);
    if (!existsSync(source)) throw new Error(`Bundled tweak source is missing: ${entry.id}`);
    const folder = basename(entry.source.path);
    bundledFolders.add(folder);
    const dest = join(tweaksDir, folder);
    // Dev-mode links into the configured source checkout are the live copies —
    // never replace them with the bundled snapshot. Arbitrary symlinks (any
    // other target) are still replaced, unchanged security posture.
    if (isRealDevSnapshotDirectory(dest, folder, devSnapshotFolders)) {
      opts.log?.(`kept validated dev snapshot for ${folder}`);
    } else if (devRoot !== null && isSymlinkInto(dest, devRoot)) {
      opts.log?.(`kept dev link for ${folder}`);
    } else {
      replaceDirectory(source, dest);
    }
    if (entry.id !== folder) {
      const idPath = join(tweaksDir, entry.id);
      if (devRoot === null || !isSymlinkInto(idPath, devRoot)) {
        rmSync(idPath, { recursive: true, force: true });
      }
    }
  }
  pruneSupersededProjectTweaks(tweaksDir, bundledFolders, { devTweaksRoot: devRoot, log: opts.log });
  pruneRetiredTweaks(tweaksDir, { devTweaksRoot: devRoot, log: opts.log });
  chownForTargetUser(tweaksDir, { recursive: true });
}

function pruneSupersededProjectTweaks(
  tweaksDir: string,
  currentFolders: ReadonlySet<string>,
  opts: { devTweaksRoot?: string | null; log?: (message: string) => void } = {},
): void {
  const devRoot = opts.devTweaksRoot ?? null;
  for (const entry of readdirSync(tweaksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || currentFolders.has(entry.name)) continue;
    const folder = join(tweaksDir, entry.name);
    if (devRoot !== null && isSymlinkInto(folder, devRoot)) continue;
    try {
      const manifestFile = join(folder, "manifest.json");
      const stat = lstatSync(manifestFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { githubRepo?: unknown };
      if (manifest.githubRepo !== "therealityreport/tweakers") continue;
    } catch {
      continue;
    }
    opts.log?.(`pruned superseded Tweakers folder ${entry.name}`);
    rmSync(folder, { recursive: true, force: true });
  }
}

export function pruneRetiredTweaks(
  tweaksDir: string,
  opts: { devTweaksRoot?: string | null; log?: (message: string) => void } = {},
): void {
  const devRoot = opts.devTweaksRoot ?? null;
  for (const retired of RETIRED_BUNDLED_TWEAKS) {
    const stale = join(tweaksDir, retired);
    if (devRoot !== null && isSymlinkInto(stale, devRoot)) {
      opts.log?.(`kept dev link for retired tweak ${retired}`);
      continue;
    }
    if (existsSync(stale)) opts.log?.(`pruned retired bundled tweak ${retired}`);
    rmSync(stale, { recursive: true, force: true });
  }
  // A dev-snapshot record naming a retired folder would make a later staging
  // pass keep whatever reappears at that path — scrub retired ids from it.
  const snapshotFile = join(tweaksDir, ".codexpp-dev-snapshot.json");
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile, "utf8")) as { folders?: unknown };
    if (Array.isArray(parsed.folders)) {
      const kept = parsed.folders.filter(
        (value) => typeof value === "string" && !RETIRED_BUNDLED_TWEAKS.includes(value),
      );
      if (kept.length !== parsed.folders.length) {
        writeFileSync(snapshotFile, `${JSON.stringify({ ...parsed, folders: kept }, null, 2)}\n`, "utf8");
      }
    }
  } catch {
    // No snapshot record (or unreadable) — nothing to scrub.
  }
}

function readDevSnapshotFolders(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { folders?: unknown };
    if (!Array.isArray(parsed.folders)) return new Set();
    return new Set(parsed.folders.filter((value): value is string =>
      typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value),
    ));
  } catch {
    return new Set();
  }
}

function isRealDevSnapshotDirectory(dest: string, folder: string, snapshotFolders: Set<string>): boolean {
  if (!snapshotFolders.has(folder)) return false;
  try {
    const stat = lstatSync(dest);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function runtimeAssetsMatch(runtimeDir: string): boolean {
  const packaged = join(assetsDir, "runtime");
  const source = existsSync(packaged)
    ? packaged
    : resolve(here, "..", "..", "..", "..", "runtime", "dist");
  return existsSync(source) && hashDirectoryTree(source) === hashDirectoryTree(runtimeDir);
}

interface Stepper {
  (msg: string): void;
  detail(msg: string): void;
}

function makeStepper(opts: { quiet?: boolean; verbose?: boolean } = {}): Stepper {
  let n = 1;
  const emit = (msg: string) => {
    if (!opts.quiet) console.log(`${kleur.dim(`[${n++}]`)} ${msg}`);
  };
  const step = emit as Stepper;
  step.detail = (msg: string) => {
    if (opts.verbose) emit(msg);
  };
  return step;
}

function formatCliStep(message: string): string {
  return message.replace(/^Installed CLI(?::)?/, "CLI");
}

export function preflightWritableTargets(
  codex: Pick<CodexInstall, "resourcesDir" | "asarPath" | "metaPath" | "electronBinary" | "platform">,
  opts: { fuseFlip: boolean },
): void {
  preflightWritableDirectory(codex.resourcesDir, codex.platform);
  preflightWritableFile(codex.asarPath, codex.platform);
  if (codex.metaPath) preflightWritableFile(codex.metaPath, codex.platform);
  if (opts.fuseFlip) preflightWritableFile(codex.electronBinary, codex.platform);
}

/**
 * Touch a probe file inside the app bundle to surface (and trigger) macOS
 * App Management TCC denials before we begin destructive work.
 */
function preflightWritableDirectory(targetDir: string, platform: string): void {
  const probe = join(targetDir, ".codexpp-write-probe");
  const copyProbe = join(targetDir, ".codexpp-copy-probe");
  try {
    const fd = openSync(probe, "w");
    closeSync(fd);
    copyFileSync(probe, copyProbe);
    unlinkSync(probe);
    unlinkSync(copyProbe);
  } catch (e) {
    try {
      unlinkSync(probe);
    } catch {}
    try {
      unlinkSync(copyProbe);
    } catch {}
    throw writableError(e, targetDir, platform);
  }
}

function preflightWritableFile(targetFile: string, platform: string): void {
  try {
    const fd = openSync(targetFile, "r+");
    closeSync(fd);
  } catch (e) {
    throw writableError(e, targetFile, platform);
  }
}

function writableError(e: unknown, target: string, platform: string): unknown {
  const err = e as NodeJS.ErrnoException;
  if (err.code !== "EPERM" && err.code !== "EACCES") return e;

  const isMac = platform === "darwin";
  const inWindowsApps =
    platform === "win32" && /\\WindowsApps\\/i.test(`${target}\\`);
  const msg =
    `Cannot write to ${target}.\n\n` +
    (isMac
      ? macAppManagementFix(target, err.code)
      : inWindowsApps
        ? `Windows Store installs live under WindowsApps and Windows is blocking the patch write.\n` +
          `Fix:\n` +
          `  1. Quit Codex completely\n` +
          `  2. Re-open PowerShell as Administrator\n` +
          `  3. Re-run this command.\n\n` +
          `If Administrator still cannot write here, this Store install is locked by Windows package protections.\n` +
          `Use a writable Codex install folder and rerun with --app pointing at it.\n`
        : `Check filesystem permissions for the Codex install folder.\n`) +
    `\nOriginal error: ${err.message}`;
  return new Error(msg);
}

function macAppManagementFix(target: string, code: string | undefined): string {
  const permissionSteps =
    `macOS App Management is blocking modification of ${target}.\n` +
    `Run "tweakers repair" in your terminal.\n`;
  const sudoFallback =
    code === "EACCES"
      ? `If Codex.app is root-owned and repair still cannot write to it, run "sudo tweakers repair".\n`
      : "";

  return permissionSteps + sudoFallback;
}

export function assertCodexNotRunning(
  codex: CodexInstall,
  open: OpenReport = getOpenReport(codex),
): void {
  if (!reportsMainProcessRunning(open)) return;

  throw new Error(formatCodexRunningError(codex, open));
}

export interface PrepareCodexForPatchingController {
  getOpenReport?: (codex: CodexInstall) => OpenReport;
  step?: (msg: string) => void;
}

export function prepareCodexForPatching(
  codex: CodexInstall,
  controller: PrepareCodexForPatchingController = {},
): boolean {
  const readOpenReport = controller.getOpenReport ?? getOpenReport;
  const open = readOpenReport(codex);
  if (!reportsMainProcessRunning(open)) return false;

  controller.step?.("Codex is running; live in-place patching is blocked");
  throw new Error(formatCodexRunningError(codex, open));
}

function formatCodexRunningError(codex: CodexInstall, open: OpenReport): string {
  const status = open.status === "unknown" ? "running" : open.status;
  const pid = open.pid === null ? "" : `\n  PID: ${open.pid}`;
  const openedAt = open.openedAt ?? open.openedAtRaw;
  const opened = openedAt ? `\n  Opened at: ${openedAt}` : "";
  const related = formatRelatedPids(open.relatedPids);
  const stuckCommand =
    codex.platform === "win32" && open.pid !== null
      ? `\nIf it is stuck, run:\n  Stop-Process -Id ${open.pid}\n`
      : "";

  return (
    `[!] Close Codex before patching\n\n` +
    `Codex is currently ${status}:\n` +
    `  ${codex.appName}\n` +
    `  ${codex.appRoot}${pid}${opened}${related}\n\n` +
    `Tweakers cannot safely patch app.asar while Codex is running. ` +
    `Changing the bundle underneath an active process can make lazy-loaded Codex surfaces crash until restart.\n\n` +
    `Quit Codex completely, then rerun this command from Terminal.\n` +
    stuckCommand
  );
}

function formatRelatedPids(pids: number[]): string {
  if (pids.length === 0) return "";
  const shown = pids.slice(0, 12).join(", ");
  const more = pids.length > 12 ? `, +${pids.length - 12} more` : "";
  return `\n  Related PIDs: ${shown}${more}`;
}

function preflightAppClosed(codex: CodexInstall, step: (msg: string) => void): boolean {
  return prepareCodexForPatching(codex, { step });
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

function installWindowsManagedAppLauncher(codex: CodexInstall): { shortcutPaths: string[] } | null {
  if (codex.platform !== "win32") return null;
  if (!/\\codex-plusplus\\store-apps\\/i.test(`${codex.appRoot.replace(/\//g, "\\")}\\`)) {
    return null;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const shimDir = join(localAppData, "Microsoft", "WindowsApps");
  mkdirSync(shimDir, { recursive: true });
  const commandPath = join(shimDir, "codex-plusplus-codex.cmd");
  writeFileSync(
    commandPath,
    `@echo off\r\nstart "" "${codex.executable}" %*\r\n`,
    "utf8",
  );
  const shortcutPaths = [commandPath];

  const startMenuRoot = process.env.APPDATA
    ? join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
    : null;
  if (!startMenuRoot) return { shortcutPaths };

  const startMenuShortcut = join(startMenuRoot, "Tweakers.lnk");
  if (createWindowsCodexShortcut(startMenuShortcut, codex.executable)) {
    shortcutPaths.push(startMenuShortcut);
  }
  const desktopShortcut = join(homedir(), "Desktop", "Tweakers.lnk");
  if (createWindowsCodexShortcut(desktopShortcut, codex.executable)) {
    shortcutPaths.push(desktopShortcut);
  }

  return { shortcutPaths };
}

function createWindowsCodexShortcut(shortcutPath: string, targetPath: string): boolean {
  try {
    mkdirSync(dirname(shortcutPath), { recursive: true });
    const script = [
      `$shortcutPath = '${escapePowerShellSingleQuotedString(shortcutPath)}'`,
      `$targetPath = '${escapePowerShellSingleQuotedString(targetPath)}'`,
      `$workingDirectory = '${escapePowerShellSingleQuotedString(dirname(targetPath))}'`,
      "$shell = New-Object -ComObject WScript.Shell",
      "$shortcut = $shell.CreateShortcut($shortcutPath)",
      "$shortcut.TargetPath = $targetPath",
      "$shortcut.WorkingDirectory = $workingDirectory",
      "$shortcut.IconLocation = \"$targetPath,0\"",
      "$shortcut.Save()",
    ].join("; ");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function preflightSystemTools(platform: string, resign: boolean, hasPlist: boolean): void {
  if (platform !== "darwin") return;
  if (resign) requireCommand("codesign", "macOS codesign is required to re-sign Codex.app after patching.");
  if (hasPlist) requireCommand("plutil", "macOS plutil is required to update Codex.app's Info.plist.");
}

function requireCommand(command: string, message: string): void {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`[!] ${command} not installed\n\n${message}\nPaste this error into Codex if you need help.`);
  }
}

/**
 * Mode-transition journal for the ChatGPT ⇄ Tweakers bundle swap.
 *
 * A switch writes `<root>/mode/transition.json` before its first mutation and
 * deletes it on completion, mirroring the install transaction's
 * `recoverInterruptedPromotion` discipline: on every `mode`/`repair`/watcher
 * entry, a journal whose owner PID is dead is reconciled — completed or rolled
 * back based on the OBSERVED bundle state (live patch marker + payload
 * presence) — before anything else runs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeveloperIdSignedBackup } from "./codesign.js";
import { readPlist } from "./plist.js";
import { processAlive } from "./process-lock.js";
import { readState, writeState, type AppMode } from "./state.js";
import { cloneAppTree } from "./transaction.js";
import type { AsarMarker } from "./commands/install.js";

export type ModeTransitionPhase = "preparing" | "swapping";

export interface ModeTransitionJournal {
  schemaVersion: 1;
  target: AppMode;
  phase: ModeTransitionPhase;
  ownerPid: number;
  /** Disposable staging copy consumed by the swap; safe to delete on recovery. */
  stagedPath: string | null;
  /** Parked-payload app root this transition parks into / swaps in from. */
  payloadPath: string | null;
  startedAt: string;
}

export interface ParkedPayloadMetadata {
  schemaVersion: 1;
  /** Official ChatGPT version the parked patched payload was built against. */
  baseVersion: string | null;
  baseBuild: string | null;
  patchedAsarHash: string | null;
  parkedAt: string;
}

export function modeDirectory(userRoot: string): string {
  return join(userRoot, "mode");
}

export function modeTransitionFile(userRoot: string): string {
  return join(modeDirectory(userRoot), "transition.json");
}

export function modeLockFile(userRoot: string): string {
  return join(userRoot, "mode.lock");
}

export function parkedPayloadRoot(userRoot: string): string {
  return join(modeDirectory(userRoot), "patched-payload");
}

export function parkedPayloadApp(userRoot: string): string {
  return join(parkedPayloadRoot(userRoot), "ChatGPT.app");
}

export function payloadMetadataFile(userRoot: string): string {
  return join(parkedPayloadRoot(userRoot), "payload.json");
}

export function readModeTransition(file: string): ModeTransitionJournal | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as ModeTransitionJournal;
    return value.schemaVersion === 1 && (value.target === "chatgpt" || value.target === "tweakers")
      ? value
      : null;
  } catch {
    return null;
  }
}

export function writeModeTransition(file: string, journal: ModeTransitionJournal): void {
  journal.ownerPid = process.pid;
  writeJsonAtomically(file, journal);
}

export function clearModeTransition(file: string): void {
  rmSync(file, { force: true });
}

export function readPayloadMetadata(file: string): ParkedPayloadMetadata | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as ParkedPayloadMetadata;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export function writePayloadMetadata(file: string, metadata: ParkedPayloadMetadata): void {
  writeJsonAtomically(file, metadata);
}

export interface ModeTransitionReconcileDeps {
  isProcessAlive?: (pid: number) => boolean;
  /** Developer ID verification used when adopting an interrupted switch's outgoing pristine copy. */
  isDeveloperIdBackup?: (appRoot: string) => boolean;
  log?: (line: string) => void;
}

/**
 * Refresh the pristine full-app backup using the staged-verify-rename
 * discipline of install.ts's promoteVerifiedSignedBackup: copy the source to
 * a sibling of the backup, verify Developer ID there, and only then swap it
 * in. The previous backup survives until the refreshed copy has verified, and
 * the source is never deleted here — callers discard it only after this
 * returns.
 */
export function refreshPristineBackupStaged(
  source: string,
  liveBackup: string,
  adapters: {
    verify?: (appRoot: string) => boolean;
    copy?: (source: string, destination: string) => void;
  } = {},
): void {
  const verify = adapters.verify ?? isDeveloperIdSignedBackup;
  const copy = adapters.copy ?? cloneAppTree;
  const remove = (path: string): void => rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(liveBackup), { recursive: true });
  const incoming = `${liveBackup}.tweakers-incoming-${process.pid}`;
  const previous = `${liveBackup}.tweakers-previous-${process.pid}`;
  remove(incoming);
  remove(previous);
  try {
    copy(source, incoming);
    if (!verify(incoming)) {
      throw new Error("Staged pristine backup failed Developer ID verification; the previous backup was left in place.");
    }
    const hadPrevious = existsSync(liveBackup);
    if (hadPrevious) renameSync(liveBackup, previous);
    try {
      renameSync(incoming, liveBackup);
      if (!verify(liveBackup)) {
        throw new Error("Refreshed pristine backup failed Developer ID verification.");
      }
      remove(previous);
    } catch (error) {
      remove(liveBackup);
      if (hadPrevious && existsSync(previous)) renameSync(previous, liveBackup);
      throw error;
    }
  } finally {
    remove(incoming);
    // After a failed restoration the previous path is evidence — only delete
    // it while a verified live backup exists.
    if (existsSync(liveBackup)) remove(previous);
  }
}

export type ModeTransitionReconcileResult =
  | { action: "none" }
  | { action: "in-progress"; ownerPid: number }
  | { action: "completed"; mode: AppMode }
  | { action: "rolled-back"; mode: AppMode }
  | { action: "blocked"; reason: string };

/**
 * Reconcile an interrupted mode transition. Only journals with a dead owner
 * are acted on; a live owner reports "in-progress" and an unreadable live
 * asar reports "blocked" (the interrupted switch cannot be classified without
 * repairing the app first). Completion/rollback is decided purely from the
 * observed live marker; `state.mode` is rewritten to match reality.
 */
export function reconcileModeTransition(
  paths: { root: string; stateFile: string },
  observed: { marker: AsarMarker; appRoot?: string },
  deps: ModeTransitionReconcileDeps = {},
): ModeTransitionReconcileResult {
  const file = modeTransitionFile(paths.root);
  const journal = readModeTransition(file);
  if (!journal) return { action: "none" };

  const alive = deps.isProcessAlive ?? processAlive;
  if (journal.ownerPid && journal.ownerPid !== process.pid && alive(journal.ownerPid)) {
    return { action: "in-progress", ownerPid: journal.ownerPid };
  }
  if (observed.marker === "unreadable") {
    return {
      action: "blocked",
      reason: "the live app.asar is unreadable, so the interrupted mode switch cannot be classified",
    };
  }

  const log = (line: string): void => deps.log?.(line);
  const observedMode: AppMode = observed.marker === "present" ? "tweakers" : "chatgpt";
  const completed = observedMode === journal.target;
  // Staging copies are disposable inputs — with one exception: a completed
  // switch TO tweakers whose owner died during post-swap housekeeping leaves
  // the swapped-out pristine official Contents at the staged path. That copy
  // is the freshest Developer-ID payload (and can be the ONLY intact one), so
  // it is adopted into the backup, never destroyed.
  if (journal.stagedPath) {
    const verifyBackup = deps.isDeveloperIdBackup ?? isDeveloperIdSignedBackup;
    if (journal.target === "tweakers" && completed && verifyBackup(journal.stagedPath)) {
      try {
        refreshPristineBackupStaged(journal.stagedPath, join(paths.root, "backup", "Codex.app"), {
          verify: verifyBackup,
        });
        rmSync(journal.stagedPath, { recursive: true, force: true });
        log("mode reconcile: refreshed the pristine backup from the interrupted switch's outgoing copy");
      } catch (error) {
        log(`mode reconcile: pristine-backup refresh failed (${errorMessage(error)}); kept the outgoing copy at ${journal.stagedPath}`);
      }
    } else {
      rmSync(journal.stagedPath, { recursive: true, force: true });
    }
  }
  const leftoverSwap = observed.appRoot ? `${observed.appRoot}.tweakers-contents-swap` : null;

  if (completed && journal.target === "chatgpt") {
    // The swap landed but the owner died before parking finished. The outgoing
    // patched Contents are still at the stable swap path — adopt them as the
    // parked payload instead of losing the fast path back.
    if (
      journal.payloadPath &&
      leftoverSwap &&
      existsSync(leftoverSwap) &&
      !existsSync(join(journal.payloadPath, "Contents"))
    ) {
      try {
        mkdirSync(journal.payloadPath, { recursive: true });
        renameSync(leftoverSwap, join(journal.payloadPath, "Contents"));
        // The dead owner never wrote payload.json; derive the metadata from
        // the adopted bundle so `mode status` and the fast path back agree on
        // its version.
        writePayloadMetadata(payloadMetadataFile(paths.root), {
          schemaVersion: 1,
          baseVersion: readAdoptedBundleValue(journal.payloadPath, "CFBundleShortVersionString"),
          baseBuild: readAdoptedBundleValue(journal.payloadPath, "CFBundleVersion"),
          patchedAsarHash: readState(paths.stateFile)?.patchedAsarHash ?? null,
          parkedAt: new Date().toISOString(),
        });
        log("mode reconcile: adopted the interrupted swap remnant as the parked payload");
      } catch {
        rmSync(leftoverSwap, { recursive: true, force: true });
      }
    } else if (leftoverSwap) {
      rmSync(leftoverSwap, { recursive: true, force: true });
    }
  } else {
    if (journal.target === "tweakers" && completed) {
      // The payload was consumed by the swap (or a slow-path install); whatever
      // remains in the store is stale.
      rmSync(parkedPayloadRoot(paths.root), { recursive: true, force: true });
    }
    if (journal.target === "chatgpt" && !completed) {
      // The live app still holds the patched payload; a partially created park
      // is garbage.
      rmSync(parkedPayloadRoot(paths.root), { recursive: true, force: true });
    }
    if (leftoverSwap) rmSync(leftoverSwap, { recursive: true, force: true });
  }

  const state = readState(paths.stateFile);
  if (state && state.mode !== observedMode) {
    writeState(paths.stateFile, { ...state, mode: observedMode });
  }
  clearModeTransition(file);
  log(`mode reconcile: interrupted switch to ${journal.target} ${completed ? "completed" : "rolled back"}; now in ${observedMode} mode`);
  return completed
    ? { action: "completed", mode: observedMode }
    : { action: "rolled-back", mode: observedMode };
}

/** CFBundle value from an adopted parked payload's Info.plist (null when unreadable). */
function readAdoptedBundleValue(payloadApp: string, key: string): string | null {
  try {
    const plistPath = join(payloadApp, "Contents", "Info.plist");
    if (!existsSync(plistPath)) return null;
    const value = readPlist(plistPath)[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJsonAtomically(file: string, value: object): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

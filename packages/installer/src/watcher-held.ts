/**
 * Watcher-side continuation for a "held" install transaction: the candidate
 * is validated but Codex was running, so the live app was not touched.
 *
 * Dependency-injected so tests exercise BEHAVIOR (report sequences, call
 * ordering, single re-entry) rather than source text. The real wiring lives
 * in install.ts's held branch.
 *
 * Invariants:
 *  - `reenter` is called exactly once per controller run.
 *  - The main app is never SIGKILLed here; a coordinated quit delegates to
 *    quitCodex (graceful AppleScript quit → bounded SIGTERM of the main pid),
 *    and if the main process survives that, we fall back to passive waiting.
 *  - Helper-only reports (`hasMainProcess === false`) never block promotion —
 *    that was the deadlock this module fixes.
 */
import { reportsMainProcessRunning, type OpenReport } from "./commands/debug.js";
import {
  isUpdateRecoveryV2Enabled,
  transition,
  type UpdateRecoveryState,
} from "./update-recovery/index.js";

/** Poll interval for the passive "wait for Codex to close" loops. */
const HELD_POLL_INTERVAL_MS = 500;

export interface HeldPromotionDeps {
  getReport(): OpenReport;
  /**
   * Mode guard: returning false stands the held promotion down (ChatGPT mode
   * owns the live app). Optional so legacy callers/tests are unaffected; the
   * real wiring in install.ts re-reads state.mode.
   */
  guardModeAllowsPromotion?(): boolean;
  /** Wraps quitCodex: graceful quit → 8s wait → SIGTERM main only → 3s wait. */
  quitApp(): void;
  /** Compatibility callback; production is observation-only and sends no signals. */
  cleanupOrphans(): void;
  /** Wraps showCodexUpdateDetectedNotification. */
  notifyUpdateQuit(): void;
  /** Wraps install({ ...opts, coordinatedQuit: false }). */
  reenter(): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /**
   * Test seam: overrides the update-recovery transition table so tests can
   * exercise entry events the current state machine does not define.
   * Production wiring leaves this unset, using the real state machine.
   */
  transitionImpl?: typeof transition;
}

export async function runHeldPromotion(
  deps: HeldPromotionDeps,
  opts: { coordinatedQuit: boolean },
): Promise<void> {
  if (deps.guardModeAllowsPromotion && !deps.guardModeAllowsPromotion()) {
    deps.log("ChatGPT mode is active; held promotion is standing down (the official app stays pristine).");
    return;
  }
  if (isUpdateRecoveryV2Enabled()) return runHeldPromotionV2(deps, opts);

  if (opts.coordinatedQuit) {
    deps.log("Confirmed Codex update: quitting Codex to promote the rebuilt candidate.");
    deps.notifyUpdateQuit();
    deps.quitApp();
    if (!reportsMainProcessRunning(deps.getReport())) {
      deps.cleanupOrphans();
      return deps.reenter();
    }
    deps.log("Codex did not exit within its shutdown window; waiting for it to close.");
  }

  deps.log("Watcher is waiting for Codex to close, then it will promote immediately.");
  while (reportsMainProcessRunning(deps.getReport())) {
    await deps.sleep(HELD_POLL_INTERVAL_MS);
  }
  deps.cleanupOrphans();
  return deps.reenter();
}

async function runHeldPromotionV2(
  deps: HeldPromotionDeps,
  opts: { coordinatedQuit: boolean },
): Promise<void> {
  let state: UpdateRecoveryState = "held";
  const step = deps.transitionImpl ?? transition;
  const driftDecision = step(state, {
    type: opts.coordinatedQuit ? "confirmedOfficialDrift" : "unconfirmedDrift",
  });
  state = driftDecision.state;
  const reentryAuthorized =
    !opts.coordinatedQuit || driftDecision.actions.includes("reenterInstall");

  if (driftDecision.actions.includes("quitCodex")) {
    deps.log("Confirmed Codex update: quitting Codex to promote the rebuilt candidate.");
    deps.notifyUpdateQuit();
    deps.quitApp();
    const postQuitDecision = step(state, {
      type: reportsMainProcessRunning(deps.getReport()) ? "appRunning" : "appClosed",
    });
    state = postQuitDecision.state;
    if (reentryAuthorized && postQuitDecision.actions.includes("reenterInstall")) {
      deps.cleanupOrphans();
      return deps.reenter();
    }
    deps.log("Codex did not exit within its shutdown window; waiting for it to close.");
  }

  deps.log("Watcher is waiting for Codex to close, then it will promote immediately.");
  while (true) {
    const waitDecision = step(state, {
      type: reportsMainProcessRunning(deps.getReport()) ? "appRunning" : "appClosed",
    });
    state = waitDecision.state;
    if (reentryAuthorized && waitDecision.actions.includes("reenterInstall")) {
      deps.cleanupOrphans();
      return deps.reenter();
    }
    if (waitDecision.actions.includes("waitForCodexClose")) {
      await deps.sleep(HELD_POLL_INTERVAL_MS);
      continue;
    }
    // Fallback: no iteration may complete without returning or yielding. An
    // entry event that never authorizes re-entry parks the machine in
    // "promoting" (actions [] / ["promote"], no waitForCodexClose), which
    // would otherwise busy-spin this loop at 100% CPU.
    await deps.sleep(HELD_POLL_INTERVAL_MS);
  }
}

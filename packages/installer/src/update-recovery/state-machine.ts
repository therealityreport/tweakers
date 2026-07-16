export type UpdateRecoveryState =
  | "idle"
  | "updateDetected"
  | "paused"
  | "patchIntact"
  | "signingDeferred"
  | "buildingCandidate"
  | "held"
  | "coordinatedQuit"
  | "promoting"
  | "promoted"
  | "invalidated"
  | "degraded"
  | "recovering";

export type UpdateRecoveryEvent =
  | { type: "watcherPassStarted" }
  | { type: "updateModeFresh" }
  | { type: "updateModeStaleOrAbsent" }
  | { type: "hashMatchesPatched" }
  | { type: "signingUnavailable" }
  | { type: "signingAvailable" }
  | { type: "confirmedOfficialDrift" }
  | { type: "unconfirmedDrift" }
  | { type: "candidateValidated" }
  | { type: "candidateInvalid"; reason: string }
  | { type: "appRunning" }
  | { type: "appClosed" }
  | { type: "promoteSucceeded" }
  | { type: "promoteFailed"; reason: string }
  | { type: "invalidatedRetryExhausted" }
  | { type: "invalidatedRetryAllowed" };

export type UpdateRecoveryAction =
  | "notifyUpdatePaused"
  | "notifyUpdateDetected"
  | "writeDeferredMarker"
  | "notifySigningDeferred"
  | "buildCandidate"
  | "quitCodex"
  | "reenterInstall"
  | "waitForCodexClose"
  | "promote"
  | "reportInvalidated"
  | "rollback";

export interface UpdateRecoveryTransition {
  state: UpdateRecoveryState;
  actions: UpdateRecoveryAction[];
}

export const INITIAL_UPDATE_RECOVERY_STATE: UpdateRecoveryState = "idle";

type UpdateRecoveryEventType = UpdateRecoveryEvent["type"];

interface TransitionSpec {
  state: UpdateRecoveryState;
  actions: readonly UpdateRecoveryAction[];
}

/**
 * Pure S/T orchestration table. Each entry names the audited step it models;
 * callers remain responsible for executing the returned actions when their
 * safety preconditions hold (for example, re-entry waits for appClosed).
 */
const TRANSITIONS: Record<
  UpdateRecoveryState,
  Partial<Record<UpdateRecoveryEventType, TransitionSpec>>
> = {
  idle: {
    /** S3: WatchPaths starts a watcher repair pass after Sparkle relaunches. */
    watcherPassStarted: { state: "updateDetected", actions: ["notifyUpdateDetected"] },
  },
  updateDetected: {
    /** S4: a fresh same-version update mode pauses watcher repair. */
    updateModeFresh: { state: "paused", actions: ["notifyUpdatePaused"] },
    /** S4: the expected patched hash means recovery is already complete. */
    hashMatchesPatched: { state: "patchIntact", actions: [] },
    /** Phase 1/T1: watcher signing failure records and reports a deferred repair. */
    signingUnavailable: {
      state: "signingDeferred",
      actions: ["writeDeferredMarker", "notifySigningDeferred"],
    },
    /** S4/T1: stale or absent update mode proceeds to candidate construction. */
    updateModeStaleOrAbsent: { state: "buildingCandidate", actions: ["buildCandidate"] },
  },
  paused: {},
  patchIntact: {},
  signingDeferred: {
    /** Phase 1/T1: a later signing-capable pass resumes candidate construction. */
    signingAvailable: { state: "buildingCandidate", actions: ["buildCandidate"] },
  },
  buildingCandidate: {
    /** Phase 1/T1: signing may become unavailable while candidate construction starts. */
    signingUnavailable: {
      state: "signingDeferred",
      actions: ["writeDeferredMarker", "notifySigningDeferred"],
    },
    /** T2: candidate validation failure latches this payload signature as invalidated. */
    candidateInvalid: { state: "invalidated", actions: ["reportInvalidated"] },
    /** T2/T3: a validated candidate advances to the live-app status decision. */
    candidateValidated: { state: "recovering", actions: [] },
  },
  held: {
    /** S5/T3: confirmed official drift permits one coordinated graceful quit and re-entry. */
    confirmedOfficialDrift: {
      state: "coordinatedQuit",
      actions: ["quitCodex", "reenterInstall"],
    },
    /** S5/T3: unconfirmed drift remains passive and waits for the main app to close. */
    unconfirmedDrift: { state: "held", actions: ["waitForCodexClose"] },
    /** T3: a still-running main app keeps the candidate held. */
    appRunning: { state: "held", actions: ["waitForCodexClose"] },
    /** T3: passive waiting completed, so the existing install flow re-enters once. */
    appClosed: { state: "promoting", actions: ["reenterInstall"] },
  },
  coordinatedQuit: {
    /** T3: a surviving main app falls back to the passive held wait. */
    appRunning: { state: "held", actions: ["waitForCodexClose"] },
    /** T3: completed coordinated shutdown permits the single install re-entry. */
    appClosed: { state: "promoting", actions: ["reenterInstall"] },
  },
  promoting: {
    /** T4: candidate promotion and health verification succeeded. */
    promoteSucceeded: { state: "promoted", actions: [] },
    /** T4: failed promotion requests rollback and enters degraded recovery. */
    promoteFailed: { state: "degraded", actions: ["rollback"] },
  },
  promoted: {},
  invalidated: {
    /** Phase 1/T2: the transaction retry policy permits another bounded build. */
    invalidatedRetryAllowed: { state: "buildingCandidate", actions: ["buildCandidate"] },
    /** Phase 1/T2: exhausted retries remain latched for this payload signature. */
    invalidatedRetryExhausted: { state: "invalidated", actions: [] },
  },
  degraded: {},
  recovering: {
    /** T3: a running app holds the validated candidate without touching the live app. */
    appRunning: { state: "held", actions: [] },
    /** T3/T4: a closed app permits immediate candidate promotion. */
    appClosed: { state: "promoting", actions: ["promote"] },
  },
};

export function transition(
  state: UpdateRecoveryState,
  event: UpdateRecoveryEvent,
): UpdateRecoveryTransition {
  const next = TRANSITIONS[state][event.type];
  if (!next) return { state, actions: [] };
  return { state: next.state, actions: [...next.actions] };
}

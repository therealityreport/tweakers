import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  acquireCurrentEnvironmentModePairWarmCommitLease,
  assertEnvironmentModePairWarmCommitMaterialized,
  environmentModePairReceiptDigest,
  type EnvironmentModeCacheContentsIdentity,
  type EnvironmentModeCacheOuterAppEvidence,
  type EnvironmentModeCachePaths,
  type EnvironmentModePairContentsExchangeProof,
  type EnvironmentModePairReceipt,
} from "./environment-mode-cache.js";
import {
  isEnvironmentSelection as isCanonicalEnvironmentSelection,
  type AppExperience,
  type EnvironmentSelection,
  type ReleaseProfile,
} from "./environment-profile.js";
import {
  createEnvironmentTiming,
  EnvironmentTimingRecorder,
  systemEnvironmentTimingClock,
  type EnvironmentTimingClock,
  type EnvironmentTimingEvidence,
} from "./environment-timing.js";

export const ENVIRONMENT_WARM_COMMIT_SCHEMA_VERSION = 1 as const;
export const ENVIRONMENT_WARM_COMMIT_KIND = "environment-warm-commit" as const;

export const ENVIRONMENT_WARM_COMMIT_PHASES = [
  "approved",
  "stale_requires_prepare",
  "watcher-paused",
  "source-stopped",
  /** Durable uncertainty marker for T5 before the one native exchange. */
  "exchange-intent",
  "exchanged",
  "projected",
  "reopened",
  "target-proven",
  "watcher-bound",
  "selection-published",
  "watcher-resumed",
  /** Durable cache transition after the target has also resumed watcher ownership. */
  "terminal-target-proven",
  /** Durable inverse-exchange safety boundary after a post-cutover failure. */
  "inverse-watcher-paused",
  /** The exact current target PID and its helpers were stopped before reversal. */
  "inverse-target-quiescent",
  /** Durable intent immediately before an in-function inverse Contents exchange. */
  "inverse-exchange-intent",
  /** T5 records the inverse native exchange before it can occur during recovery. */
  "recovery-exchange-intent",
  "exchange-reverted",
  "source-proven",
  "source-watcher-bound",
  "source-selection-published",
  "source-watcher-resumed",
  "terminal-source-proven",
  "official-update-adopted",
  "ready",
  "failed",
] as const;

export type EnvironmentWarmCommitPhase = typeof ENVIRONMENT_WARM_COMMIT_PHASES[number];

export interface EnvironmentWarmCommitStamp {
  phase: EnvironmentWarmCommitPhase;
  at: string;
  detail: string | null;
}

/**
 * Durable source-side binding for T5. The in-process projection restore
 * closure is intentionally not serializable, so recovery accepts only an
 * explicitly bound adapter whose returned projection re-proves these values.
 */
export interface EnvironmentWarmCommitSourceProjectionIdentity {
  appPath: string;
  appExperience: AppExperience;
  releaseProfile: ReleaseProfile;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  desktopArtifactDigest: string;
  asarHeaderDigest: string;
  signatureDigest: string;
  /** Exact pre-exchange source Contents inode; populated before watcher pause. */
  contentsDev: string | null;
  contentsIno: string | null;
  backendDigest: string | null;
  runtimeDigest: string | null;
  managedRuntimeDigest: string | null;
  nativeHostDigest: string | null;
  mcpEnabled: boolean;
}

/**
 * T5 consumes this journal if an owner dies after the native exchange. It is
 * intentionally an audit record, not a recovery coordinator: the only T4
 * reversal is the immediate in-function exchange-back below.
 */
export interface EnvironmentWarmCommitReceipt {
  schemaVersion: typeof ENVIRONMENT_WARM_COMMIT_SCHEMA_VERSION;
  kind: typeof ENVIRONMENT_WARM_COMMIT_KIND;
  transactionId: string;
  generationId: string;
  pairReceiptDigest: string;
  sourceAppPath: string;
  /** Present on all T5-written journals; older journals are readable but not recoverable post-cutover. */
  sourceProjection?: EnvironmentWarmCommitSourceProjectionIdentity | null;
  targetExperience: AppExperience;
  sourceMainPid: number | null;
  targetMainPid: number | null;
  phase: EnvironmentWarmCommitPhase;
  error: string | null;
  exchangeCount: number;
  /** Persisted before the initial native exchange so ambiguous intent remains recoverable. */
  exchangeBefore?: EnvironmentWarmCommitPreflightReady["exchangeBefore"] | null;
  /** Persisted before a recovery-only inverse exchange. */
  recoveryExchangeBefore?: EnvironmentWarmCommitPreflightReady["exchangeBefore"] | null;
  stamps: EnvironmentWarmCommitStamp[];
  timing: EnvironmentTimingEvidence;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface EnvironmentWarmCommitInput {
  transactionId: string;
  approvalAt: string;
  cachePaths: EnvironmentModeCachePaths;
}

/**
 * The source process is captured by the bounded cache-hit preflight. Later
 * operations receive only this exact PID and must reject drift rather than
 * expanding to path-wide process termination.
 */
export interface EnvironmentWarmCommitSourceProcess {
  appPath: string;
  pid: number;
  visibleWindow: boolean;
}

/** All values are re-observed without rebuilding or rehashing the full tree. */
export interface EnvironmentWarmCommitTargetIdentity {
  appPath: string;
  appExperience: AppExperience;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  version: string;
  build: string;
  asarHeaderDigest: string;
  signatureDigest: string;
  backendDigest: string;
  runtimeDigest: string;
  managedRuntimeDigest: string;
  nativeHostDigest: string;
}

/**
 * Bounded identity for the process that currently occupies the fixed outer
 * live app path after a forward exchange. It intentionally includes the
 * sealed mode/runtime evidence so a path match cannot terminate another app.
 */
export interface EnvironmentWarmCommitLiveTargetIdentity {
  appPath: string;
  appExperience: AppExperience;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  version: string;
  build: string;
  desktopArtifactDigest: string;
  asarHeaderDigest: string;
  signatureDigest: string;
  backendDigest: string | null;
  runtimeDigest: string | null;
  managedRuntimeDigest: string | null;
  tweakersLoaderActive: boolean;
  mcpEnabled: boolean;
}

export interface EnvironmentWarmCommitLiveTargetProcess extends EnvironmentWarmCommitLiveTargetIdentity {
  pid: number;
  visibleWindow: boolean;
}

export type EnvironmentWarmCommitLiveTargetObservation =
  | { state: "absent" }
  | { state: "exact"; process: EnvironmentWarmCommitLiveTargetProcess };

/** A stop operation must prove the exact main PID and its scoped helpers are gone. */
export interface EnvironmentWarmCommitExactTargetStopProof {
  pid: number | null;
  appPath: string;
  processStopped: true;
  helpersStopped: true;
}

export interface EnvironmentWarmCommitPreflightReady {
  state: "ready";
  source: EnvironmentWarmCommitSourceProcess;
  target: EnvironmentWarmCommitTargetIdentity;
  exchangeBefore: Pick<
    EnvironmentModePairContentsExchangeProof,
    "liveContentsBefore" | "inactiveContentsBefore" | "liveOuterBefore" | "inactiveOuterBefore"
  >;
}

export interface EnvironmentWarmCommitPreflightStale {
  state: "stale_requires_prepare";
  /** Bounded, user-safe classifier supplied by the prepared-pair owner. */
  reason: string;
}

export type EnvironmentWarmCommitPreflight =
  | EnvironmentWarmCommitPreflightReady
  | EnvironmentWarmCommitPreflightStale;

/** The target projection must expose an immediate exact restore operation. */
export interface EnvironmentWarmCommitProjection {
  selection: EnvironmentSelection;
  targetExpectedFingerprint: string;
  /** Restores the atomically replaced runtime/backend/state/MCP projection if the exchange is backed out. */
  restore(): void | Promise<void>;
}

export interface EnvironmentWarmCommitTargetProof {
  pid: number;
  visibleWindow: boolean;
  appPath: string;
  appExperience: AppExperience;
  bundleId: "com.openai.codex" | "com.openai.codex.beta";
  version: string;
  build: string;
  asarHeaderDigest: string;
  signatureDigest: string;
  selection: EnvironmentSelection;
  desktopArtifactDigest: string;
  backendDigest: string | null;
  runtimeDigest: string | null;
  managedRuntimeDigest: string | null;
  /** A pristine target must prove its dormant Tweakers loader cannot execute. */
  tweakersLoaderActive: boolean;
  /** The mode bridge is proven after reopen, never inferred from the projection write. */
  mcpEnabled: boolean;
}

/**
 * This interface is intentionally incapable of post-approval build, clone,
 * runtime-copy, canary, or full-tree hashing work. Every action is narrow and
 * receives the sealed pair or exact paths already bound during preparation.
 */
export interface EnvironmentWarmCommitDeps {
  now?: () => string;
  timingClock?: EnvironmentTimingClock;
  /** Performs only bounded identity/header/signature/backend/runtime checks. */
  preflight(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflight | Promise<EnvironmentWarmCommitPreflight>;
  /**
   * Runs the full prepared-pair validator only on a failed bounded preflight,
   * before watcher pause or process shutdown, and returns durable drift reasons.
   */
  classifyStaleBeforeCutover(
    pair: EnvironmentModePairReceipt,
    boundedReason: string,
  ): readonly string[] | Promise<readonly string[]>;
  pauseWatcher(input: {
    transactionId: string;
    sourceAppRoot: string;
    targetAppRoot: string;
    sourceExpectedFingerprint: string;
  }): void | Promise<void>;
  stopExactSource(input: EnvironmentWarmCommitSourceProcess): void | Promise<void>;
  /** Observes only the sealed target at the fixed live path; unexpected processes must reject. */
  observeExactLiveTarget(input: {
    pair: EnvironmentModePairReceipt;
    expected: EnvironmentWarmCommitLiveTargetIdentity;
    recordedMainPid: number | null;
  }): EnvironmentWarmCommitLiveTargetObservation | Promise<EnvironmentWarmCommitLiveTargetObservation>;
  /** Stops the observed exact PID (when present) and only its bound helpers, then proves both are gone. */
  stopExactLiveTarget(input: {
    pair: EnvironmentModePairReceipt;
    expected: EnvironmentWarmCommitLiveTargetIdentity;
    process: EnvironmentWarmCommitLiveTargetProcess | null;
  }): EnvironmentWarmCommitExactTargetStopProof | Promise<EnvironmentWarmCommitExactTargetStopProof>;
  /** Rechecks the source seal after shutdown for late updater/downgrade drift. */
  recheckSourceAfterShutdown(pair: EnvironmentModePairReceipt): void | Promise<void>;
  /** Calls the verified native `RENAME_SWAP` primitive directly on the two Contents directories. */
  exchangeContents(firstContents: string, secondContents: string): void | Promise<void>;
  captureExchangeProof(input: {
    pair: EnvironmentModePairReceipt;
    before: EnvironmentWarmCommitPreflightReady["exchangeBefore"];
  }): EnvironmentModePairContentsExchangeProof | Promise<EnvironmentModePairContentsExchangeProof>;
  /** Atomically projects runtime/current, backend lane, app state, and MCP mode before reopen. */
  projectTarget(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitProjection | Promise<EnvironmentWarmCommitProjection>;
  reopenTarget(appPath: string): void | Promise<void>;
  /** Proves a new visible PID plus target runtime and MCP mode after reopen. */
  proveTarget(input: {
    pair: EnvironmentModePairReceipt;
    oldMainPid: number;
    projection: EnvironmentWarmCommitProjection;
  }): EnvironmentWarmCommitTargetProof | Promise<EnvironmentWarmCommitTargetProof>;
  bindWatcherTarget(input: {
    pair: EnvironmentModePairReceipt;
    proof: EnvironmentWarmCommitTargetProof;
    targetExpectedFingerprint: string;
  }): void | Promise<void>;
  publishSelection(selection: EnvironmentSelection): void | Promise<void>;
  resumeWatcher(input: {
    transactionId: string;
    targetAppRoot: string;
    targetExpectedFingerprint: string;
  }): void | Promise<void>;
}

/**
 * Execute one prepared-pair warm cutover. The caller owns lifecycle authority
 * and updater quarantine; this adapter starts after those gates have passed.
 */
export async function commitPreparedEnvironmentModePairWarm(
  input: EnvironmentWarmCommitInput,
  deps: EnvironmentWarmCommitDeps,
): Promise<EnvironmentWarmCommitReceipt> {
  assertWarmCommitInput(input);
  const now = deps.now ?? (() => new Date().toISOString());
  const timing = new EnvironmentTimingRecorder(deps.timingClock ?? systemEnvironmentTimingClock);
  const lease = acquireCurrentEnvironmentModePairWarmCommitLease(input.cachePaths);
  const pair = lease.receipt;
  let activePair = pair;
  const journalFile = environmentWarmCommitJournalFile(pair);
  let receipt = createWarmCommitReceipt(input, pair, now());
  let exchanged = false;
  // The outer live path stays fixed, while this immutable role identifies the
  // incoming target bytes that occupy it after the forward Contents exchange.
  let inverseTargetRole: EnvironmentModePairReceipt["roles"]["inactive"] | null = null;
  let terminalTargetPrepared = false;
  let watcherPaused = false;
  let projection: EnvironmentWarmCommitProjection | null = null;
  try {
    if (input.transactionId !== pair.generationId) {
      throw new Error(
        `Environment warm commit transaction ${input.transactionId} is not bound to current generation ${pair.generationId}`,
      );
    }
    receipt = persistWarmCommitReceipt(journalFile, receipt);
    receipt = {
      ...receipt,
      timing: timing.completeInstant(receipt.timing, "approval-helper-launch"),
      updatedAt: now(),
    };
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    receipt = startTiming(receipt, timing, "cache-inspection", now);
    try {
      assertEnvironmentModePairWarmCommitMaterialized(input.cachePaths, pair);
    } catch (error) {
      receipt = completeTiming(receipt, timing, "cache-inspection", now);
      const reason = await classifyAndInvalidateStale(lease, deps, pair, errorMessage(error), now);
      return terminalStaleReceipt(journalFile, receipt, reason, now, timing);
    }
    const preflight = await deps.preflight(pair);
    receipt = completeTiming(receipt, timing, "cache-inspection", now);
    if (preflight.state === "stale_requires_prepare") {
      const reason = await classifyAndInvalidateStale(lease, deps, pair, preflight.reason, now);
      return terminalStaleReceipt(journalFile, receipt, reason, now, timing);
    }
    assertWarmCommitPreflight(pair, preflight);
    receipt = persistWarmCommitReceipt(journalFile, {
      ...receipt,
      sourceMainPid: preflight.source.pid,
      // This is durable before watcher pause. If the owner exits after the
      // intent stamp, T5 has the exact source-side inode/outer evidence needed
      // to distinguish an unchanged source from a completed native exchange.
      exchangeBefore: preflight.exchangeBefore,
      sourceProjection: receipt.sourceProjection === null || receipt.sourceProjection === undefined
        ? receipt.sourceProjection
        : {
          ...receipt.sourceProjection,
          contentsDev: preflight.exchangeBefore.liveContentsBefore.dev,
          contentsIno: preflight.exchangeBefore.liveContentsBefore.ino,
        },
      updatedAt: now(),
    });

    receipt = startTiming(receipt, timing, "watcher-pause", now);
    await deps.pauseWatcher({
      transactionId: input.transactionId,
      sourceAppRoot: pair.roles.live.appPath,
      targetAppRoot: pair.roles.live.appPath,
      sourceExpectedFingerprint: pair.roles.live.evidence.appDigest,
    });
    watcherPaused = true;
    receipt = completeTiming(receipt, timing, "watcher-pause", now);
    receipt = stamp(receipt, "watcher-paused", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    receipt = startTiming(receipt, timing, "quit", now);
    await deps.stopExactSource(preflight.source);
    receipt = completeTiming(receipt, timing, "quit", now);
    receipt = stamp(receipt, "source-stopped", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    // Sparkle may materialize an update while the app settles. Re-read the
    // complete stat seals after shutdown; any nested app/runtime change stops
    // before the one allowed exchange without rehashing prepared payloads.
    await deps.recheckSourceAfterShutdown(pair);
    // Do not accept a dependency's assertion alone: re-read every sealed
    // topology/stat tuple after shutdown, still without opening payload bytes
    // or calculating a content digest.
    assertEnvironmentModePairWarmCommitMaterialized(input.cachePaths, pair);

    const liveContents = join(pair.roles.live.appPath, "Contents");
    const inactiveContents = join(pair.paths.inactiveAppPath, "Contents");
    // T5 must be able to distinguish "never reached swap" from "may have
    // swapped but the process died before proof/pointer rotation". Persist
    // this intent before the sole native operation, never after it.
    receipt = stamp(receipt, "exchange-intent", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);
    receipt = startTiming(receipt, timing, "exchange-apply", now);
    await deps.exchangeContents(liveContents, inactiveContents);
    exchanged = true;
    inverseTargetRole = pair.roles.inactive;
    receipt = completeTiming({ ...receipt, exchangeCount: 1 }, timing, "exchange-apply", now);

    const exchangeProof = await deps.captureExchangeProof({ pair, before: preflight.exchangeBefore });
    const rotated = lease.completeContentsExchange(exchangeProof, now());
    activePair = rotated;
    receipt = stamp(receipt, "exchanged", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    receipt = startTiming(receipt, timing, "projection", now);
    projection = await deps.projectTarget(rotated);
    assertWarmCommitProjection(rotated, projection);
    receipt = completeTiming(receipt, timing, "projection", now);
    receipt = stamp(receipt, "projected", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    receipt = startTiming(receipt, timing, "reopen", now);
    await deps.reopenTarget(rotated.roles.live.appPath);
    receipt = completeTiming(receipt, timing, "reopen", now);
    receipt = stamp(receipt, "reopened", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    receipt = startTiming(receipt, timing, "readiness-proof", now);
    const proof = await deps.proveTarget({
      pair: rotated,
      oldMainPid: preflight.source.pid,
      projection,
    });
    assertWarmCommitTargetProof(rotated, preflight.source.pid, projection, proof);
    receipt = completeTiming(receipt, timing, "readiness-proof", now);
    receipt = stamp({ ...receipt, targetMainPid: proof.pid }, "target-proven", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    receipt = startTiming(receipt, timing, "watcher-publication", now);
    await deps.bindWatcherTarget({
      pair: rotated,
      proof,
      targetExpectedFingerprint: projection.targetExpectedFingerprint,
    });
    receipt = stamp(receipt, "watcher-bound", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    await deps.publishSelection(proof.selection);
    receipt = stamp(receipt, "selection-published", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    await deps.resumeWatcher({
      transactionId: input.transactionId,
      targetAppRoot: rotated.roles.live.appPath,
      targetExpectedFingerprint: projection.targetExpectedFingerprint,
    });
    watcherPaused = false;
    receipt = completeTiming(receipt, timing, "watcher-publication", now);
    receipt = stamp(receipt, "watcher-resumed", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    // This is intentionally after target proof, watcher bind, durable
    // selection publication, and watcher resume. A successful rotation may
    // become the next cache hit only at this terminal target boundary.
    lease.completeTerminalTargetProof();
    terminalTargetPrepared = true;
    receipt = stamp(receipt, "terminal-target-proven", now());
    receipt = persistWarmCommitReceipt(journalFile, receipt);

    return terminalReadyReceipt(journalFile, receipt, now, timing);
  } catch (error) {
    const failures = [errorMessage(error)];
    if (terminalTargetPrepared) {
      try {
        lease.revertTerminalTargetProof();
        terminalTargetPrepared = false;
      } catch (targetTransitionRevertError) {
        failures.push(`terminal target transition reversion failed: ${errorMessage(targetTransitionRevertError)}`);
      }
    }
    if (exchanged) {
      try {
        receipt = await quiesceWarmCommitInverseExchange(
          journalFile,
          receipt,
          activePair,
          inverseTargetRole ?? pair.roles.inactive,
          deps,
          now,
        );
        await deps.exchangeContents(
          join(pair.roles.live.appPath, "Contents"),
          join(pair.paths.inactiveAppPath, "Contents"),
        );
        receipt = stamp({ ...receipt, exchangeCount: receipt.exchangeCount + 1 }, "exchange-reverted", now());
        receipt = persistWarmCommitReceipt(journalFile, receipt);
      } catch (exchangeBackError) {
        failures.push(`immediate exchange-back failed: ${errorMessage(exchangeBackError)}`);
      }
    }
    if (projection !== null) {
      try {
        await projection.restore();
      } catch (restoreError) {
        failures.push(`projection restore failed: ${errorMessage(restoreError)}`);
      }
    }
    const exchangeWasIntended = receipt.stamps.some((entry) => entry.phase === "exchange-intent");
    if (!exchanged && !exchangeWasIntended && watcherPaused) {
      try {
        // Before exchange the source bytes are unchanged. Restore the exact
        // source app and its captured watcher snapshot so this failed attempt
        // cannot leave every later generation permanently blocked.
        await deps.reopenTarget(pair.roles.live.appPath);
        await deps.resumeWatcher({
          transactionId: input.transactionId,
          targetAppRoot: pair.roles.live.appPath,
          targetExpectedFingerprint: pair.roles.live.evidence.appDigest,
        });
        watcherPaused = false;
        receipt = stamp(receipt, "source-watcher-resumed", now());
        receipt = persistWarmCommitReceipt(journalFile, receipt);
      } catch (watcherRestoreError) {
        failures.push(`pre-exchange watcher restore failed: ${errorMessage(watcherRestoreError)}`);
      }
    }
    return terminalFailureReceipt(journalFile, receipt, failures.join("; "), now, timing);
  } finally {
    lease.release();
  }
}

async function classifyAndInvalidateStale(
  lease: ReturnType<typeof acquireCurrentEnvironmentModePairWarmCommitLease>,
  deps: EnvironmentWarmCommitDeps,
  pair: EnvironmentModePairReceipt,
  boundedReason: string,
  now: () => string,
): Promise<string> {
  let reasons: readonly string[];
  try {
    reasons = await deps.classifyStaleBeforeCutover(pair, boundedReason);
  } catch (error) {
    reasons = [`full-validator: ${errorMessage(error)}`];
  }
  lease.invalidateBeforeCutover(now());
  return [boundedReason, ...reasons].filter((reason, index, all) => all.indexOf(reason) === index).join("; ");
}

/** Derive the exact post-exchange process identity from the sealed role, never a path-wide query. */
export function environmentWarmCommitLiveTargetIdentity(
  pair: EnvironmentModePairReceipt,
  role: EnvironmentModePairReceipt["roles"]["live"] | EnvironmentModePairReceipt["roles"]["inactive"],
  liveAppPath = pair.roles.live.appPath,
): EnvironmentWarmCommitLiveTargetIdentity {
  const tweakers = role.experience === "tweakers";
  return {
    appPath: liveAppPath,
    appExperience: role.experience,
    bundleId: role.evidence.bundleId,
    version: role.evidence.version,
    build: role.evidence.build,
    desktopArtifactDigest: role.evidence.appDigest,
    asarHeaderDigest: role.evidence.asarHeaderDigest,
    signatureDigest: role.evidence.signature.signatureDigest,
    backendDigest: tweakers ? pair.tweakers.backend.digest : null,
    runtimeDigest: tweakers ? pair.tweakers.runtime.digest : null,
    managedRuntimeDigest: tweakers ? pair.tweakers.managedRuntime.digest : null,
    tweakersLoaderActive: tweakers,
    mcpEnabled: tweakers,
  };
}

/** Validate a narrow observation before it can influence a process stop. */
export function assertEnvironmentWarmCommitLiveTargetObservation(
  expected: EnvironmentWarmCommitLiveTargetIdentity,
  observation: EnvironmentWarmCommitLiveTargetObservation,
): EnvironmentWarmCommitLiveTargetProcess | null {
  if (!isRecord(observation) || (observation.state !== "absent" && observation.state !== "exact")) {
    throw new Error("Warm commit inverse target observation is invalid");
  }
  if (observation.state === "absent") return null;
  const process = observation.process;
  if (!isRecord(process)
    || !isPositiveInteger(process.pid)
    || process.visibleWindow !== true
    || !sameWarmCommitLiveTargetIdentity(expected, process)) {
    throw new Error("Warm commit inverse target observation did not bind the exact sealed live target");
  }
  return process;
}

/** Reject an inverse exchange unless the adapter proves its exact process and helpers stopped. */
export function assertEnvironmentWarmCommitExactTargetStopProof(
  expected: EnvironmentWarmCommitLiveTargetIdentity,
  process: EnvironmentWarmCommitLiveTargetProcess | null,
  proof: EnvironmentWarmCommitExactTargetStopProof,
): void {
  if (!isRecord(proof)
    || proof.appPath !== expected.appPath
    || proof.pid !== (process?.pid ?? null)
    || proof.processStopped !== true
    || proof.helpersStopped !== true) {
    throw new Error("Warm commit inverse target stop did not prove the exact PID and helpers are stopped");
  }
}

/**
 * This is the sole inverse-exchange gate shared by all in-function rollback
 * paths: pause the watcher again, stop only a freshly proved live target and
 * its helpers, re-observe absence, then durably record exchange intent.
 */
async function quiesceWarmCommitInverseExchange(
  journalFile: string,
  receipt: EnvironmentWarmCommitReceipt,
  pair: EnvironmentModePairReceipt,
  targetRole: EnvironmentModePairReceipt["roles"]["live"] | EnvironmentModePairReceipt["roles"]["inactive"],
  deps: EnvironmentWarmCommitDeps,
  now: () => string,
): Promise<EnvironmentWarmCommitReceipt> {
  const expected = environmentWarmCommitLiveTargetIdentity(pair, targetRole, pair.roles.live.appPath);
  await deps.pauseWatcher({
    transactionId: receipt.transactionId,
    sourceAppRoot: pair.roles.live.appPath,
    targetAppRoot: pair.roles.live.appPath,
    sourceExpectedFingerprint: expected.desktopArtifactDigest,
  });
  receipt = persistWarmCommitReceipt(
    journalFile,
    stamp(receipt, "inverse-watcher-paused", now(), "Watcher paused before inverse Contents exchange"),
  );
  const observed = assertEnvironmentWarmCommitLiveTargetObservation(
    expected,
    await deps.observeExactLiveTarget({
      pair,
      expected,
      recordedMainPid: receipt.targetMainPid,
    }),
  );
  const stopProof = await deps.stopExactLiveTarget({ pair, expected, process: observed });
  assertEnvironmentWarmCommitExactTargetStopProof(expected, observed, stopProof);
  const afterStop = assertEnvironmentWarmCommitLiveTargetObservation(
    expected,
    await deps.observeExactLiveTarget({
      pair,
      expected,
      recordedMainPid: observed?.pid ?? receipt.targetMainPid,
    }),
  );
  if (afterStop !== null) {
    throw new Error("Warm commit inverse target remained running after exact PID/helper stop");
  }
  receipt = persistWarmCommitReceipt(
    journalFile,
    stamp({
      ...receipt,
      targetMainPid: observed?.pid ?? receipt.targetMainPid,
    }, "inverse-target-quiescent", now(), observed === null
      ? "No exact live target PID was running; exact target helpers were stopped"
      : `Stopped exact live target PID ${observed.pid} and bound helpers`),
  );
  return persistWarmCommitReceipt(
    journalFile,
    stamp(receipt, "inverse-exchange-intent", now(), "Exact target quiesced before inverse Contents exchange"),
  );
}

/** Capture a Contents identity using no content reads. */
export function captureEnvironmentModeCacheContentsIdentity(path: string): EnvironmentModeCacheContentsIdentity {
  const exact = canonicalAbsolute(path, "Contents path");
  const stat = lstatSync(exact, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Warm commit Contents path is not a real directory: ${exact}`);
  }
  return { path: exact, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

/**
 * Default macOS outer-app capture. ACL and xattr bytes are reduced to separate
 * digests so journals retain continuity proof without persisting labels or
 * extended-attribute values. Tests may inject equivalent evidence directly.
 */
export function captureEnvironmentModeCacheOuterAppEvidence(path: string): EnvironmentModeCacheOuterAppEvidence {
  const exact = canonicalAbsolute(path, "outer app path");
  const stat = lstatSync(exact, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Warm commit outer app path is not a real directory: ${exact}`);
  }
  if (process.platform !== "darwin") {
    throw new Error("Warm commit outer app ACL/xattr evidence is available only on macOS");
  }
  return {
    path: exact,
    stat: {
      relativePath: "",
      type: "directory",
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mode: stat.mode.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      symlinkTarget: null,
    },
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    // `ls -led` starts with a mutable directory stat/header line. Hash only
    // ACL records so this evidence survives a native Contents exchange while
    // the independent inode/uid/gid/xattr/quarantine proofs stay strict.
    aclDigest: outerAppAclOnlyDigest(exact),
    xattrDigest: commandDigest("/usr/bin/xattr", ["-l", exact], "outer app xattr evidence"),
    quarantineDigest: optionalQuarantineDigest(exact),
  };
}

/** Persist a receipt by fsyncing the file and its parent directory. */
export function writeEnvironmentWarmCommitReceipt(file: string, receipt: EnvironmentWarmCommitReceipt): void {
  assertEnvironmentWarmCommitReceipt(receipt);
  const exact = canonicalAbsolute(file, "warm commit receipt path");
  mkdirSync(dirname(exact), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(exact),
    `.${basenameForTemporary(exact)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, exact);
    chmodSync(exact, 0o600);
    fsyncDirectory(dirname(exact));
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort for a journal temporary */ }
    }
  }
}

/** Read a validated journal without treating a missing journal as an error. */
export function readEnvironmentWarmCommitReceipt(file: string): EnvironmentWarmCommitReceipt | null {
  const exact = canonicalAbsolute(file, "warm commit receipt path");
  if (!existsSync(exact)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(exact, "utf8"));
  } catch (error) {
    throw new Error(`Environment warm commit receipt cannot be read: ${errorMessage(error)}`);
  }
  assertEnvironmentWarmCommitReceipt(parsed);
  return parsed;
}

/** Canonical, generation-bound journal location shared by commit and recovery. */
export function environmentWarmCommitJournalFile(pair: EnvironmentModePairReceipt): string {
  return join(pair.paths.generationRoot, "warm-commit.json");
}

function persistWarmCommitReceipt(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
): EnvironmentWarmCommitReceipt {
  writeEnvironmentWarmCommitReceipt(file, receipt);
  return receipt;
}

export function isEnvironmentWarmCommitReceipt(value: unknown): value is EnvironmentWarmCommitReceipt {
  try {
    assertEnvironmentWarmCommitReceipt(value);
    return true;
  } catch {
    return false;
  }
}

function createWarmCommitReceipt(
  input: EnvironmentWarmCommitInput,
  pair: EnvironmentModePairReceipt,
  createdAt: string,
): EnvironmentWarmCommitReceipt {
  assertIso(createdAt, "warm commit creation time");
  return {
    schemaVersion: ENVIRONMENT_WARM_COMMIT_SCHEMA_VERSION,
    kind: ENVIRONMENT_WARM_COMMIT_KIND,
    transactionId: input.transactionId,
    generationId: pair.generationId,
    pairReceiptDigest: pair.invalidation.receiptDigest,
    sourceAppPath: pair.roles.live.appPath,
    sourceProjection: sourceProjectionIdentity(pair),
    targetExperience: pair.roles.inactive.experience,
    sourceMainPid: null,
    targetMainPid: null,
    phase: "approved",
    error: null,
    exchangeCount: 0,
    exchangeBefore: null,
    recoveryExchangeBefore: null,
    stamps: [{ phase: "approved", at: createdAt, detail: null }],
    timing: createEnvironmentTiming(input.approvalAt),
    createdAt,
    updatedAt: createdAt,
    terminalAt: null,
  };
}

function sourceProjectionIdentity(
  pair: EnvironmentModePairReceipt,
): EnvironmentWarmCommitSourceProjectionIdentity {
  const source = pair.roles.live;
  const tweakers = source.experience === "tweakers";
  const contents = pair.seals.liveApp.entries.find((entry) => entry.relativePath === "Contents");
  if (contents === undefined || contents.type !== "directory") {
    throw new Error("Prepared environment mode pair lacks a sealed source Contents directory");
  }
  return {
    appPath: source.appPath,
    appExperience: source.experience,
    releaseProfile: pair.releaseProfile,
    bundleId: source.evidence.bundleId,
    desktopArtifactDigest: source.evidence.appDigest,
    asarHeaderDigest: source.evidence.asarHeaderDigest,
    signatureDigest: source.evidence.signature.signatureDigest,
    contentsDev: contents.dev,
    contentsIno: contents.ino,
    backendDigest: tweakers ? pair.tweakers.backend.digest : null,
    runtimeDigest: tweakers ? pair.tweakers.runtime.digest : null,
    managedRuntimeDigest: tweakers ? pair.tweakers.managedRuntime.digest : null,
    nativeHostDigest: tweakers ? pair.tweakers.nativeHost.digest : null,
    mcpEnabled: tweakers,
  };
}

function terminalStaleReceipt(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  reason: string,
  now: () => string,
  timing: EnvironmentTimingRecorder,
): EnvironmentWarmCommitReceipt {
  return terminalFailureLikeReceipt(file, stamp(receipt, "stale_requires_prepare", now(), reason), reason, now, timing);
}

function terminalFailureReceipt(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  error: string,
  now: () => string,
  timing: EnvironmentTimingRecorder,
): EnvironmentWarmCommitReceipt {
  return terminalFailureLikeReceipt(file, stamp(receipt, "failed", now(), error), error, now, timing);
}

function terminalFailureLikeReceipt(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  error: string,
  now: () => string,
  timing: EnvironmentTimingRecorder,
): EnvironmentWarmCommitReceipt {
  let terminal = startTiming({
    ...receipt,
    error,
    terminalAt: now(),
    updatedAt: now(),
  }, timing, "terminal-persist", now);
  writeEnvironmentWarmCommitReceipt(file, terminal);
  terminal = completeTiming(terminal, timing, "terminal-persist", now);
  writeEnvironmentWarmCommitReceipt(file, terminal);
  return terminal;
}

function terminalReadyReceipt(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  now: () => string,
  timing: EnvironmentTimingRecorder,
): EnvironmentWarmCommitReceipt {
  let terminal = startTiming({
    ...receipt,
    error: null,
    updatedAt: now(),
  }, timing, "terminal-persist", now);
  // Persist the fully proven but not-yet-terminal receipt first. An
  // interruption here cannot claim that a target became ready before its
  // terminal receipt and terminal fsync existed.
  writeEnvironmentWarmCommitReceipt(file, terminal);
  terminal = completeTiming(terminal, timing, "terminal-persist", now);
  terminal = {
    ...terminal,
    timing: timing.markReady(terminal.timing),
    updatedAt: now(),
  };
  terminal = stamp({
    ...terminal,
    phase: "ready",
    terminalAt: now(),
    updatedAt: now(),
  }, "ready", now());
  writeEnvironmentWarmCommitReceipt(file, terminal);
  return terminal;
}

function startTiming(
  receipt: EnvironmentWarmCommitReceipt,
  timing: EnvironmentTimingRecorder,
  phase: Parameters<EnvironmentTimingRecorder["start"]>[1],
  now: () => string,
): EnvironmentWarmCommitReceipt {
  return {
    ...receipt,
    timing: timing.start(receipt.timing, phase),
    updatedAt: now(),
  };
}

function completeTiming(
  receipt: EnvironmentWarmCommitReceipt,
  timing: EnvironmentTimingRecorder,
  phase: Parameters<EnvironmentTimingRecorder["complete"]>[1],
  now: () => string,
): EnvironmentWarmCommitReceipt {
  return {
    ...receipt,
    timing: timing.complete(receipt.timing, phase),
    updatedAt: now(),
  };
}

function stamp(
  receipt: EnvironmentWarmCommitReceipt,
  phase: EnvironmentWarmCommitPhase,
  at: string,
  detail: string | null = null,
): EnvironmentWarmCommitReceipt {
  assertIso(at, "warm commit stamp time");
  return {
    ...receipt,
    phase,
    stamps: [...receipt.stamps, { phase, at, detail }],
    updatedAt: at,
  };
}

function assertWarmCommitInput(input: EnvironmentWarmCommitInput): void {
  if (!isRecord(input)
    || !safeId(input.transactionId)
    || !validIso(input.approvalAt)
    || !isRecord(input.cachePaths)) {
    throw new Error("Environment warm commit input is invalid");
  }
}

function assertWarmCommitPreflight(
  pair: EnvironmentModePairReceipt,
  preflight: EnvironmentWarmCommitPreflightReady,
): void {
  if (!isPositiveInteger(preflight.source.pid)
    || preflight.source.appPath !== pair.roles.live.appPath
    || preflight.source.visibleWindow !== true) {
    throw new Error("Warm commit preflight did not capture an exact visible source main PID");
  }
  const target = pair.roles.inactive;
  if (preflight.target.appPath !== pair.paths.inactiveAppPath
    || preflight.target.appExperience !== target.experience
    || preflight.target.bundleId !== target.evidence.bundleId
    || preflight.target.version !== target.evidence.version
    || preflight.target.build !== target.evidence.build
    || preflight.target.asarHeaderDigest !== target.evidence.asarHeaderDigest
    || preflight.target.signatureDigest !== target.evidence.signature.signatureDigest
    || preflight.target.backendDigest !== pair.tweakers.backend.digest
    || preflight.target.runtimeDigest !== pair.tweakers.runtime.digest
    || preflight.target.managedRuntimeDigest !== pair.tweakers.managedRuntime.digest
    || preflight.target.nativeHostDigest !== pair.tweakers.nativeHost.digest) {
    throw new Error("Warm commit preflight target identity does not match the prepared pair");
  }
  if (environmentModePairReceiptDigest(pair) !== pair.invalidation.receiptDigest) {
    throw new Error("Warm commit preflight pair receipt digest is no longer valid");
  }
}

function assertWarmCommitProjection(
  pair: EnvironmentModePairReceipt,
  projection: EnvironmentWarmCommitProjection,
): void {
  if (!isRecord(projection)
    || !isCanonicalEnvironmentSelection(projection.selection)
    || !sha256(projection.targetExpectedFingerprint)
    || typeof projection.restore !== "function") {
    throw new Error("Warm commit projection is invalid or not rollback-restorable");
  }
  if (projection.selection.selectedDesktopPath !== pair.roles.live.appPath
    || projection.selection.releaseProfile !== pair.releaseProfile
    || projection.selection.appExperience !== pair.roles.live.experience
    || projection.selection.appliedAt !== null
    || projection.targetExpectedFingerprint !== pair.roles.live.evidence.appDigest) {
    throw new Error("Warm commit projection selection does not match the exchanged target");
  }
}

function assertWarmCommitTargetProof(
  pair: EnvironmentModePairReceipt,
  oldMainPid: number,
  projection: EnvironmentWarmCommitProjection,
  proof: EnvironmentWarmCommitTargetProof,
): void {
  if (!isPositiveInteger(proof.pid)
    || proof.pid === oldMainPid
    || proof.visibleWindow !== true
    || proof.appPath !== pair.roles.live.appPath
    || proof.appExperience !== pair.roles.live.experience
    || proof.bundleId !== pair.roles.live.evidence.bundleId
    || proof.version !== pair.roles.live.evidence.version
    || proof.build !== pair.roles.live.evidence.build
    || proof.asarHeaderDigest !== pair.roles.live.evidence.asarHeaderDigest
    || proof.signatureDigest !== pair.roles.live.evidence.signature.signatureDigest
    || !isCanonicalEnvironmentSelection(proof.selection)
    || proof.desktopArtifactDigest !== pair.roles.live.evidence.appDigest
    || proof.selection.selectedDesktopPath !== projection.selection.selectedDesktopPath
    || proof.selection.appExperience !== projection.selection.appExperience
    || proof.selection.releaseProfile !== projection.selection.releaseProfile
    || proof.selection.appliedAt === null) {
    throw new Error("Warm commit target proof did not establish a different visible target process");
  }
  if (pair.roles.live.experience === "tweakers") {
    if (proof.tweakersLoaderActive !== true
      || proof.mcpEnabled !== true
      || proof.backendDigest !== pair.tweakers.backend.digest
      || proof.runtimeDigest !== pair.tweakers.runtime.digest
      || proof.managedRuntimeDigest !== pair.tweakers.managedRuntime.digest) {
      throw new Error("Warm commit target proof did not establish the requested Tweakers runtime and MCP mode");
    }
  } else if (proof.tweakersLoaderActive !== false
    || proof.mcpEnabled !== false
    || proof.backendDigest !== null
    || proof.runtimeDigest !== null
    || proof.managedRuntimeDigest !== null) {
    throw new Error("Pristine ChatGPT target still exposes dormant Tweakers runtime or MCP state");
  }
}

function sameWarmCommitLiveTargetIdentity(
  expected: EnvironmentWarmCommitLiveTargetIdentity,
  observed: EnvironmentWarmCommitLiveTargetIdentity,
): boolean {
  return observed.appPath === expected.appPath
    && observed.appExperience === expected.appExperience
    && observed.bundleId === expected.bundleId
    && observed.version === expected.version
    && observed.build === expected.build
    && observed.desktopArtifactDigest === expected.desktopArtifactDigest
    && observed.asarHeaderDigest === expected.asarHeaderDigest
    && observed.signatureDigest === expected.signatureDigest
    && observed.backendDigest === expected.backendDigest
    && observed.runtimeDigest === expected.runtimeDigest
    && observed.managedRuntimeDigest === expected.managedRuntimeDigest
    && observed.tweakersLoaderActive === expected.tweakersLoaderActive
    && observed.mcpEnabled === expected.mcpEnabled;
}

function assertEnvironmentWarmCommitReceipt(value: unknown): asserts value is EnvironmentWarmCommitReceipt {
  if (!isRecord(value)
    || value.schemaVersion !== ENVIRONMENT_WARM_COMMIT_SCHEMA_VERSION
    || value.kind !== ENVIRONMENT_WARM_COMMIT_KIND
    || !safeId(value.transactionId)
    || !safeId(value.generationId)
    || !sha256(value.pairReceiptDigest)
    || !exactAbsolutePath(value.sourceAppPath)
    || !(value.sourceProjection === undefined || value.sourceProjection === null
      || isEnvironmentWarmCommitSourceProjectionIdentity(value.sourceProjection))
    || (value.targetExperience !== "chatgpt" && value.targetExperience !== "tweakers")
    || !(value.sourceMainPid === null || isPositiveInteger(value.sourceMainPid))
    || !(value.targetMainPid === null || isPositiveInteger(value.targetMainPid))
    || !(ENVIRONMENT_WARM_COMMIT_PHASES as readonly string[]).includes(value.phase as string)
    || !(value.error === null || typeof value.error === "string")
    || !Number.isInteger(value.exchangeCount)
    || value.exchangeCount < 0
    || !(value.exchangeBefore === undefined || value.exchangeBefore === null
      || isEnvironmentWarmCommitExchangeBefore(value.exchangeBefore))
    || !(value.recoveryExchangeBefore === undefined || value.recoveryExchangeBefore === null
      || isEnvironmentWarmCommitExchangeBefore(value.recoveryExchangeBefore))
    || !Array.isArray(value.stamps)
    || !value.stamps.every(isWarmCommitStamp)
    || !isTimingEvidence(value.timing)
    || !validIso(value.createdAt)
    || !validIso(value.updatedAt)
    || !(value.terminalAt === null || validIso(value.terminalAt))) {
    throw new Error("Environment warm commit receipt has an invalid schema");
  }
  if (value.phase === "ready" && value.timing.readyAt === null) {
    throw new Error("Environment warm commit ready receipt lacks readyAt evidence");
  }
  if ((value.phase === "failed" || value.phase === "stale_requires_prepare" || value.phase === "ready")
    && value.terminalAt === null) {
    throw new Error("Environment warm commit terminal receipt lacks terminalAt evidence");
  }
}

function isEnvironmentWarmCommitSourceProjectionIdentity(
  value: unknown,
): value is EnvironmentWarmCommitSourceProjectionIdentity {
  return isRecord(value)
    && exactAbsolutePath(value.appPath)
    && (value.appExperience === "chatgpt" || value.appExperience === "tweakers")
    && (value.releaseProfile === "stable" || value.releaseProfile === "alpha")
    && (value.bundleId === "com.openai.codex" || value.bundleId === "com.openai.codex.beta")
    && sha256(value.desktopArtifactDigest)
    && sha256(value.asarHeaderDigest)
    && sha256(value.signatureDigest)
    && (value.contentsDev === null || decimal(value.contentsDev))
    && (value.contentsIno === null || decimal(value.contentsIno))
    && (value.backendDigest === null || sha256(value.backendDigest))
    && (value.runtimeDigest === null || sha256(value.runtimeDigest))
    && (value.managedRuntimeDigest === null || sha256(value.managedRuntimeDigest))
    && (value.nativeHostDigest === null || sha256(value.nativeHostDigest))
    && typeof value.mcpEnabled === "boolean";
}

function isEnvironmentWarmCommitExchangeBefore(
  value: unknown,
): value is EnvironmentWarmCommitPreflightReady["exchangeBefore"] {
  return isRecord(value)
    && isEnvironmentModeCacheContentsIdentity(value.liveContentsBefore)
    && isEnvironmentModeCacheContentsIdentity(value.inactiveContentsBefore)
    && isEnvironmentModeCacheOuterAppEvidence(value.liveOuterBefore)
    && isEnvironmentModeCacheOuterAppEvidence(value.inactiveOuterBefore);
}

function isEnvironmentModeCacheContentsIdentity(value: unknown): value is EnvironmentModeCacheContentsIdentity {
  return isRecord(value)
    && exactAbsolutePath(value.path)
    && decimal(value.dev)
    && decimal(value.ino);
}

function isEnvironmentModeCacheOuterAppEvidence(value: unknown): value is EnvironmentModeCacheOuterAppEvidence {
  return isRecord(value)
    && exactAbsolutePath(value.path)
    && isRecord(value.stat)
    && value.stat.relativePath === ""
    && value.stat.type === "directory"
    && decimal(value.stat.dev)
    && decimal(value.stat.ino)
    && decimal(value.stat.size)
    && decimal(value.stat.mode)
    && decimal(value.stat.mtimeNs)
    && decimal(value.stat.ctimeNs)
    && value.stat.symlinkTarget === null
    && decimal(value.uid)
    && decimal(value.gid)
    && sha256(value.aclDigest)
    && sha256(value.xattrDigest)
    && sha256(value.quarantineDigest);
}

function isWarmCommitStamp(value: unknown): value is EnvironmentWarmCommitStamp {
  return isRecord(value)
    && (ENVIRONMENT_WARM_COMMIT_PHASES as readonly string[]).includes(value.phase as string)
    && validIso(value.at)
    && (value.detail === null || typeof value.detail === "string");
}

function isTimingEvidence(value: unknown): value is EnvironmentTimingEvidence {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !(value.approvalAt === null || validIso(value.approvalAt))
    || !(value.readyAt === null || validIso(value.readyAt))
    || !isRecord(value.phases)) return false;
  return Object.values(value.phases).every((phase) => isRecord(phase)
    && validIso(phase.startedAt)
    && (phase.completedAt === null || validIso(phase.completedAt))
    && (phase.durationMs === null || (typeof phase.durationMs === "number" && Number.isFinite(phase.durationMs) && phase.durationMs >= 0)));
}

function commandOutput(command: string, args: string[], label: string): Buffer {
  const result = spawnSync(command, args, { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message
      ?? Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString("utf8").trim()
      ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`Could not capture ${label}: ${detail}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function commandDigest(command: string, args: string[], label: string): string {
  return createHash("sha256").update(commandOutput(command, args, label)).digest("hex");
}

function outerAppAclOnlyDigest(path: string): string {
  return digestEnvironmentModeCacheOuterAppAclListing(
    commandOutput("/bin/ls", ["-led", path], "outer app ACL evidence"),
  );
}

/**
 * Canonicalize only macOS ACL records from `ls -led`. The first listing line
 * carries mode, ownership, size, timestamps, and the path—none survives a
 * legitimate Contents swap—so it is intentionally excluded. Continuations
 * are retained only after a numbered ACL record begins.
 */
export function digestEnvironmentModeCacheOuterAppAclListing(listing: Buffer | string): string {
  const lines = (typeof listing === "string" ? listing : listing.toString("utf8"))
    .replace(/\r\n/g, "\n")
    .split("\n");
  const aclLines: string[] = [];
  let inAcl = false;
  for (const line of lines) {
    if (/^\s*\d+:\s/.test(line)) {
      inAcl = true;
      aclLines.push(line.trimEnd());
    } else if (inAcl && /^\s+\S/.test(line)) {
      aclLines.push(line.trimEnd());
    }
  }
  return createHash("sha256")
    .update("macos-outer-app-acl-only-v1\n")
    .update(aclLines.join("\n"))
    .update("\n")
    .digest("hex");
}

/** `xattr -p` exits 1 when the attribute is absent; that absence is evidence. */
function optionalQuarantineDigest(path: string): string {
  const result = spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", path], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    const detail = result.error?.message
      ?? Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString("utf8").trim()
      ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`Could not capture outer app quarantine evidence: ${detail}`);
  }
  const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8");
  if (result.status === 1 && !/no such (?:xattr|attribute)/i.test(stderr)) {
    throw new Error(`Could not prove outer app quarantine absence: ${stderr.trim() || "xattr exited 1"}`);
  }
  return createHash("sha256")
    .update(`status:${result.status ?? "unknown"}\n`)
    .update(result.stdout ?? Buffer.alloc(0))
    .digest("hex");
}

function canonicalAbsolute(path: string, label: string): string {
  if (!exactAbsolutePath(path)) throw new Error(`${label} must be an exact absolute path: ${path}`);
  return path;
}

function exactAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && resolve(value) === value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertIso(value: unknown, label: string): asserts value is string {
  if (!validIso(value)) throw new Error(`${label} must be an ISO timestamp`);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basenameForTemporary(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

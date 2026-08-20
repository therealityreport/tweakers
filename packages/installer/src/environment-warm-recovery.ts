import { join } from "node:path";
import {
  acquireCurrentEnvironmentModePairRecoveryLease,
  readCurrentEnvironmentModePair,
  type EnvironmentModeCacheContentsIdentity,
  type EnvironmentModeCacheOuterAppEvidence,
  type EnvironmentModeCachePaths,
  type EnvironmentModePairContentsRoleObservation,
  type EnvironmentModePairReceipt,
} from "./environment-mode-cache.js";
import {
  isEnvironmentSelection,
  type EnvironmentSelection,
} from "./environment-profile.js";
import {
  environmentWarmCommitJournalFile,
  assertEnvironmentWarmCommitExactTargetStopProof,
  assertEnvironmentWarmCommitLiveTargetObservation,
  environmentWarmCommitLiveTargetIdentity,
  readEnvironmentWarmCommitReceipt,
  writeEnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitExactTargetStopProof,
  type EnvironmentWarmCommitLiveTargetIdentity,
  type EnvironmentWarmCommitLiveTargetObservation,
  type EnvironmentWarmCommitLiveTargetProcess,
  type EnvironmentWarmCommitPreflightReady,
  type EnvironmentWarmCommitProjection,
  type EnvironmentWarmCommitReceipt,
  type EnvironmentWarmCommitSourceProjectionIdentity,
  type EnvironmentWarmCommitTargetProof,
} from "./environment-warm-commit.js";

/**
 * T5 recovery is a bounded, default-off coordinator seam. It does not build,
 * clone, hash, or replace payloads. The only permitted native mutation is an
 * inverse Contents exchange after exact inode-role proof.
 */
export interface RecoverEnvironmentModePairWarmInput {
  cachePaths: EnvironmentModeCachePaths;
  /** Optional caller binding; a mismatch is rejected before any side effect. */
  transactionId?: string;
}

export interface EnvironmentWarmRecoveryOfficialUpdate {
  state: "unchanged" | "newer_verified_official";
  /** Required only for the verified-newer branch. */
  selection?: EnvironmentSelection;
}

export interface EnvironmentWarmRecoveryOfficialAdoption {
  pid: number;
  visibleWindow: boolean;
  selection: EnvironmentSelection;
}

export interface EnvironmentWarmRecoveryDeps {
  now?: () => string;
  /** Pause the live watcher before every recovery-only inverse Contents exchange. */
  pauseWatcher(input: {
    transactionId: string;
    sourceAppRoot: string;
    targetAppRoot: string;
    sourceExpectedFingerprint: string;
  }): void | Promise<void>;
  /** Observes only the exact sealed target currently at the fixed live outer path. */
  observeExactLiveTarget(input: {
    pair: EnvironmentModePairReceipt;
    expected: EnvironmentWarmCommitLiveTargetIdentity;
    recordedMainPid: number | null;
  }): EnvironmentWarmCommitLiveTargetObservation | Promise<EnvironmentWarmCommitLiveTargetObservation>;
  /** Stops the exact target PID (when present) plus its bound helpers and proves both stopped. */
  stopExactLiveTarget(input: {
    pair: EnvironmentModePairReceipt;
    expected: EnvironmentWarmCommitLiveTargetIdentity;
    process: EnvironmentWarmCommitLiveTargetProcess | null;
  }): EnvironmentWarmCommitExactTargetStopProof | Promise<EnvironmentWarmCommitExactTargetStopProof>;
  /**
   * Mandatory updater oracle. A `newer_verified_official` result prevents
   * every exchange and causes cache invalidation before the official app is
   * adopted/reopened by the bound adapter.
   */
  checkForVerifiedNewerOfficial(input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
  }): EnvironmentWarmRecoveryOfficialUpdate | Promise<EnvironmentWarmRecoveryOfficialUpdate>;
  /** Retains, adopts, and reopens the verified official app without copying cache bytes. */
  adoptVerifiedNewerOfficial(input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
    update: EnvironmentWarmRecoveryOfficialUpdate;
  }): EnvironmentWarmRecoveryOfficialAdoption | Promise<EnvironmentWarmRecoveryOfficialAdoption>;
  /** Captured immediately before a recovery-only inverse exchange. */
  captureExchangeBefore(pair: EnvironmentModePairReceipt): EnvironmentWarmCommitPreflightReady["exchangeBefore"]
    | Promise<EnvironmentWarmCommitPreflightReady["exchangeBefore"]>;
  /** Captured immediately after a recovery-only inverse exchange. */
  captureExchangeProof(input: {
    pair: EnvironmentModePairReceipt;
    before: EnvironmentWarmCommitPreflightReady["exchangeBefore"];
  }): {
    liveContentsAfter: EnvironmentModeCacheContentsIdentity;
    inactiveContentsAfter: EnvironmentModeCacheContentsIdentity;
    liveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
    inactiveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
  } | Promise<{
    liveContentsAfter: EnvironmentModeCacheContentsIdentity;
    inactiveContentsAfter: EnvironmentModeCacheContentsIdentity;
    liveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
    inactiveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
  }>;
  exchangeContents(firstContents: string, secondContents: string): void | Promise<void>;
  /** Restores exactly the runtime, state, and MCP projection bound by the journal identity. */
  restoreSource(input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
    source: EnvironmentWarmCommitSourceProjectionIdentity;
  }): EnvironmentWarmCommitProjection | Promise<EnvironmentWarmCommitProjection>;
  /** Observation makes reopen conditional rather than creating a duplicate source process. */
  observeSource(input: {
    pair: EnvironmentModePairReceipt;
    projection: EnvironmentWarmCommitProjection;
  }): EnvironmentWarmCommitTargetProof | null | Promise<EnvironmentWarmCommitTargetProof | null>;
  reopenSource(appPath: string): void | Promise<void>;
  proveSource(input: {
    pair: EnvironmentModePairReceipt;
    projection: EnvironmentWarmCommitProjection;
  }): EnvironmentWarmCommitTargetProof | null | Promise<EnvironmentWarmCommitTargetProof | null>;
  /** Target publication is allowed only after a fresh complete target proof. */
  proveTarget(input: {
    pair: EnvironmentModePairReceipt;
    journal: EnvironmentWarmCommitReceipt;
  }): EnvironmentWarmCommitTargetProof | null | Promise<EnvironmentWarmCommitTargetProof | null>;
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

const TARGET_TERMINAL_CANDIDATE_PHASES = new Set<EnvironmentWarmCommitReceipt["phase"]>([
  "target-proven",
  "watcher-bound",
  "selection-published",
  "watcher-resumed",
  "terminal-target-proven",
  "ready",
]);

/**
 * Recover one schema-v2 warm journal. Success is only a freshly proved source
 * or target (or a verified newer official adoption); all other states retain
 * their journal and generation intact for a later bounded recovery attempt.
 */
export async function recoverEnvironmentModePairWarm(
  input: RecoverEnvironmentModePairWarmInput,
  deps: EnvironmentWarmRecoveryDeps,
): Promise<EnvironmentWarmCommitReceipt> {
  assertRecoveryInput(input);
  assertRecoveryDeps(deps);
  const now = deps.now ?? (() => new Date().toISOString());
  const initialPairLease = acquireCurrentEnvironmentModePairRecoveryLease(input.cachePaths, currentGenerationFromJournal(input));
  let journalFile: string | null = null;
  let journal: EnvironmentWarmCommitReceipt | null = null;
  try {
    let pair = initialPairLease.receipt;
    journalFile = environmentWarmCommitJournalFile(pair);
    journal = readEnvironmentWarmCommitReceipt(journalFile);
    if (journal === null) {
      throw new Error("Environment mode cache has no warm commit journal to recover");
    }
    assertJournalBinding(input, pair, journal);

    // A completely terminal target journal needs no further mutation when its
    // pair is already a reusable grant. It is history, not a recovery owner.
    if (journal.phase === "ready" && pair.pin.state === "prepared") return journal;
    // A stale pre-cutover journal never paused or replaced the source. Its
    // released grant is terminal history; a later prepare must start v2 fresh.
    if (journal.phase === "stale_requires_prepare" && pair.pin.state === "stale_requires_prepare") return journal;
    // Cache invalidation and official adoption were durably recorded, but the
    // process died before the terminal stale fsync. No adapter or exchange is
    // needed (or permitted) to finish that journal publication.
    if (journal.phase === "official-update-adopted" && pair.pin.state === "stale_requires_prepare") {
      return finishStaleRecovery(journalFile, journal, now(),
        "Verified newer official app was already adopted; prepare a fresh v2 pair");
    }

    // Every nonterminal branch, including target publication and official
    // adoption, must first bind the injected adapter to durable source facts.
    // A damaged source journal can never be used as a reason to mutate cache
    // metadata, exchange Contents, or publish another projection.
    const source = requireSourceProjection(journal, pair);
    const pairAlreadyStale = pair.pin.state === "stale_requires_prepare";

    const officialUpdate = await deps.checkForVerifiedNewerOfficial({ pair, journal });
    assertOfficialUpdate(officialUpdate);
    if (officialUpdate.state === "newer_verified_official") {
      const updatedPair = pairAlreadyStale
        ? pair
        : initialPairLease.invalidateForVerifiedOfficialUpdate(now());
      const adopted = await deps.adoptVerifiedNewerOfficial({ pair: updatedPair, journal, update: officialUpdate });
      assertOfficialAdoption(adopted, officialUpdate.selection!);
      journal = persistStamp(journalFile, journal, "official-update-adopted", now(),
        "Verified newer official app retained and adopted; a fresh v2 prepare is required");
      return finishStaleRecovery(journalFile, journal, now(), "Verified newer official app adopted; prepare a fresh v2 pair");
    }

    if (pairAlreadyStale) {
      throw recoverableFailure(journalFile, journal,
        "Warm recovery cache grant is already stale; source or target exchange is prohibited until a fresh v2 prepare", now);
    }

    let contents = initialPairLease.observeContentsRoles();
    if (contents.state === "ambiguous") {
      throw recoverableFailure(journalFile, journal,
        "Warm recovery cannot prove exact Contents inode roles; generation retained for manual recovery", now);
    }

    if (TARGET_TERMINAL_CANDIDATE_PHASES.has(journal.phase)
      && contents.state === "as-recorded"
      && pair.roles.live.experience === journal.targetExperience) {
      const target = await deps.proveTarget({ pair, journal });
      if (target !== null) {
        assertRecoveredProof(pair, target);
        return publishTerminalTarget(initialPairLease, journalFile, journal, pair, target, deps, now);
      }
    }

    const sourceLocation = locatePhysicalSource(pair, contents, source);
    if (sourceLocation === "inactive") {
      journal = await quiesceRecoveryInverseExchange(
        journalFile,
        journal,
        pair,
        physicalLiveTargetRole(pair, source),
        deps,
        now,
      );
      journal = await persistRecoveryExchangeIntent(journalFile, journal, pair, contents, deps, now);
      await deps.exchangeContents(
        join(pair.roles.live.appPath, "Contents"),
        join(pair.paths.inactiveAppPath, "Contents"),
      );
      const proof = await deps.captureExchangeProof({ pair, before: journal.recoveryExchangeBefore! });
      assertRecoveryExchangeProof(pair, proof);
      contents = initialPairLease.observeContentsRoles();
      if (contents.state === "as-recorded" && contents.live.dev === source.contentsDev && contents.live.ino === source.contentsIno) {
        pair = initialPairLease.reconcileRecordedContents();
      } else if (contents.state === "swapped" && contents.live.dev === source.contentsDev && contents.live.ino === source.contentsIno) {
        pair = initialPairLease.reconcileSwappedContents(now());
      } else {
        throw recoverableFailure(journalFile, journal,
          "Recovery inverse exchange did not place the exact source in the live slot", now);
      }
      journal = persistStamp(journalFile, journal, "exchange-reverted", now());
    } else if (sourceLocation === "live" && contents.state === "swapped") {
      // T4 can have exchanged back in-process before its owner exits. Its
      // cache receipt still names target roles, so recover the metadata only
      // after exact inode proof; no second native exchange occurs.
      pair = initialPairLease.reconcileSwappedContents(now());
      journal = persistStamp(journalFile, journal, "exchange-reverted", now(), "Recovered prior inverse exchange");
    }

    if (!roleMatchesSourceProjection(pair.roles.live, source)) {
      throw recoverableFailure(journalFile, journal,
        "Warm recovery source projection does not occupy the proved live slot", now);
    }
    const projection = await deps.restoreSource({ pair, journal, source });
    assertSourceProjection(pair, source, projection);
    let proof = await deps.observeSource({ pair, projection });
    if (proof === null) {
      await deps.reopenSource(pair.roles.live.appPath);
      proof = await deps.proveSource({ pair, projection });
    }
    if (proof === null) {
      throw recoverableFailure(journalFile, journal,
        "Warm recovery could not reopen and prove the source environment", now);
    }
    assertRecoveredProof(pair, proof);
    journal = persistStamp(journalFile, journal, "source-proven", now());
    await deps.bindWatcherTarget({ pair, proof, targetExpectedFingerprint: projection.targetExpectedFingerprint });
    journal = persistStamp(journalFile, journal, "source-watcher-bound", now());
    await deps.publishSelection(proof.selection);
    journal = persistStamp(journalFile, journal, "source-selection-published", now());
    await deps.resumeWatcher({
      transactionId: journal.transactionId,
      targetAppRoot: pair.roles.live.appPath,
      targetExpectedFingerprint: projection.targetExpectedFingerprint,
    });
    journal = persistStamp(journalFile, journal, "source-watcher-resumed", now());
    initialPairLease.completeTerminalRecovery();
    journal = persistStamp(journalFile, journal, "terminal-source-proven", now());
    return finishReadyRecovery(journalFile, journal, now());
  } catch (error) {
    // Every bound adapter is allowed to fail, but it may never erase the
    // durable oracle that tells a later recovery where source bytes reside.
    // Preserve the last stamped phase and generation, adding only the error.
    if (journalFile !== null && journal !== null) {
      try {
        writeEnvironmentWarmCommitReceipt(journalFile, {
          ...journal,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: now(),
        });
      } catch {
        // The original journal remains intact if its error annotation itself
        // cannot be persisted; never substitute an inferred state.
      }
    }
    throw error;
  } finally {
    initialPairLease.release();
  }
}

function currentGenerationFromJournal(input: RecoverEnvironmentModePairWarmInput): string {
  const current = readCurrentEnvironmentModePair(input.cachePaths);
  if (current === null) {
    throw new Error("Environment mode cache has no current generation to recover");
  }
  return current.generationId;
}

async function publishTerminalTarget(
  lease: ReturnType<typeof acquireCurrentEnvironmentModePairRecoveryLease>,
  journalFile: string,
  journal: EnvironmentWarmCommitReceipt,
  pair: EnvironmentModePairReceipt,
  proof: EnvironmentWarmCommitTargetProof,
  deps: EnvironmentWarmRecoveryDeps,
  now: () => string,
): Promise<EnvironmentWarmCommitReceipt> {
  await deps.bindWatcherTarget({
    pair,
    proof,
    targetExpectedFingerprint: pair.roles.live.evidence.appDigest,
  });
  journal = persistStamp(journalFile, journal, "watcher-bound", now(), "Recovery target watcher binding");
  await deps.publishSelection(proof.selection);
  journal = persistStamp(journalFile, journal, "selection-published", now(), "Recovery target selection publication");
  await deps.resumeWatcher({
    transactionId: journal.transactionId,
    targetAppRoot: pair.roles.live.appPath,
    targetExpectedFingerprint: pair.roles.live.evidence.appDigest,
  });
  journal = persistStamp(journalFile, journal, "watcher-resumed", now(), "Recovery target watcher resume");
  lease.completeTerminalRecovery();
  journal = persistStamp(journalFile, journal, "terminal-target-proven", now(), "Recovery target terminal proof");
  return finishReadyRecovery(journalFile, journal, now());
}

async function persistRecoveryExchangeIntent(
  journalFile: string,
  journal: EnvironmentWarmCommitReceipt,
  pair: EnvironmentModePairReceipt,
  contents: EnvironmentModePairContentsRoleObservation,
  deps: EnvironmentWarmRecoveryDeps,
  now: () => string,
): Promise<EnvironmentWarmCommitReceipt> {
  const before = await deps.captureExchangeBefore(pair);
  assertExchangeBeforeMatchesContents(pair, before, contents);
  return persistStamp(journalFile, {
    ...journal,
    recoveryExchangeBefore: before,
    updatedAt: now(),
  }, "recovery-exchange-intent", now());
}

/**
 * Recovery has no in-process watcher state to trust. Before its only inverse
 * exchange it pauses the watcher again, stops only a freshly proved exact
 * target and its helpers, verifies absence, then durably records intent.
 */
async function quiesceRecoveryInverseExchange(
  journalFile: string,
  journal: EnvironmentWarmCommitReceipt,
  pair: EnvironmentModePairReceipt,
  targetRole: EnvironmentModePairReceipt["roles"]["live"] | EnvironmentModePairReceipt["roles"]["inactive"],
  deps: EnvironmentWarmRecoveryDeps,
  now: () => string,
): Promise<EnvironmentWarmCommitReceipt> {
  const expected = environmentWarmCommitLiveTargetIdentity(pair, targetRole, pair.roles.live.appPath);
  await deps.pauseWatcher({
    transactionId: journal.transactionId,
    sourceAppRoot: pair.roles.live.appPath,
    targetAppRoot: pair.roles.live.appPath,
    sourceExpectedFingerprint: expected.desktopArtifactDigest,
  });
  journal = persistStamp(
    journalFile,
    journal,
    "inverse-watcher-paused",
    now(),
    "Watcher paused before recovery inverse Contents exchange",
  );
  const observed = assertEnvironmentWarmCommitLiveTargetObservation(
    expected,
    await deps.observeExactLiveTarget({
      pair,
      expected,
      recordedMainPid: journal.targetMainPid,
    }),
  );
  const stopProof = await deps.stopExactLiveTarget({ pair, expected, process: observed });
  assertEnvironmentWarmCommitExactTargetStopProof(expected, observed, stopProof);
  const afterStop = assertEnvironmentWarmCommitLiveTargetObservation(
    expected,
    await deps.observeExactLiveTarget({
      pair,
      expected,
      recordedMainPid: observed?.pid ?? journal.targetMainPid,
    }),
  );
  if (afterStop !== null) {
    throw recoverableFailure(
      journalFile,
      journal,
      "Warm recovery inverse target remained running after exact PID/helper stop",
      now,
    );
  }
  journal = persistStamp(journalFile, {
    ...journal,
    targetMainPid: observed?.pid ?? journal.targetMainPid,
  }, "inverse-target-quiescent", now(), observed === null
    ? "No exact live target PID was running; exact target helpers were stopped"
    : `Stopped exact live target PID ${observed.pid} and bound helpers`);
  return persistStamp(
    journalFile,
    journal,
    "inverse-exchange-intent",
    now(),
    "Exact target quiesced before recovery inverse Contents exchange",
  );
}

function locatePhysicalSource(
  pair: EnvironmentModePairReceipt,
  contents: EnvironmentModePairContentsRoleObservation,
  source: EnvironmentWarmCommitSourceProjectionIdentity,
): "live" | "inactive" {
  void pair;
  if (source.contentsDev === null || source.contentsIno === null) {
    throw new Error("Warm recovery journal lacks a durable pre-exchange source Contents identity");
  }
  if (contents.live.dev === source.contentsDev && contents.live.ino === source.contentsIno) return "live";
  if (contents.inactive.dev === source.contentsDev && contents.inactive.ino === source.contentsIno) return "inactive";
  throw new Error("Warm recovery could not locate the exact source Contents inode in either slot");
}

/** The only non-source sealed role must be the process currently at the live outer path. */
function physicalLiveTargetRole(
  pair: EnvironmentModePairReceipt,
  source: EnvironmentWarmCommitSourceProjectionIdentity,
): EnvironmentModePairReceipt["roles"]["live"] | EnvironmentModePairReceipt["roles"]["inactive"] {
  const candidates = [pair.roles.live, pair.roles.inactive]
    .filter((role) => !roleMatchesSourceProjection(role, source));
  if (candidates.length !== 1) {
    throw new Error("Warm recovery could not bind one exact target role before inverse exchange");
  }
  return candidates[0]!;
}

function requireSourceProjection(
  journal: EnvironmentWarmCommitReceipt,
  pair: EnvironmentModePairReceipt,
): EnvironmentWarmCommitSourceProjectionIdentity {
  const source = journal.sourceProjection;
  if (source === null || source === undefined) {
    throw new Error("Warm recovery journal lacks durable source projection identity; cache generation was retained");
  }
  const matchingRoles = [pair.roles.live, pair.roles.inactive]
    .filter((role) => roleMatchesSourceProjection(role, source));
  if (source.appPath !== journal.sourceAppPath
    || source.releaseProfile !== pair.releaseProfile
    || source.contentsDev === null
    || source.contentsIno === null
    || matchingRoles.length !== 1) {
    throw new Error("Warm recovery journal source projection identity does not bind the sealed pair");
  }
  assertSourceProjectionArtifacts(pair, source);
  return source;
}

/** Bind source runtime/MCP fields to the immutable pair, not just its app role. */
function assertSourceProjectionArtifacts(
  pair: EnvironmentModePairReceipt,
  source: EnvironmentWarmCommitSourceProjectionIdentity,
): void {
  const tweakers = source.appExperience === "tweakers";
  if ((tweakers && (
    source.backendDigest !== pair.tweakers.backend.digest
    || source.runtimeDigest !== pair.tweakers.runtime.digest
    || source.managedRuntimeDigest !== pair.tweakers.managedRuntime.digest
    || source.nativeHostDigest !== pair.tweakers.nativeHost.digest
    || source.mcpEnabled !== true
  )) || (!tweakers && (
    source.backendDigest !== null
    || source.runtimeDigest !== null
    || source.managedRuntimeDigest !== null
    || source.nativeHostDigest !== null
    || source.mcpEnabled !== false
  ))) {
    throw new Error("Warm recovery journal source projection runtime and MCP identity does not bind the sealed pair");
  }
}

function roleMatchesSourceProjection(
  role: EnvironmentModePairReceipt["roles"]["live"] | EnvironmentModePairReceipt["roles"]["inactive"],
  source: EnvironmentWarmCommitSourceProjectionIdentity,
): boolean {
  return role.experience === source.appExperience
    && role.evidence.bundleId === source.bundleId
    && role.evidence.appDigest === source.desktopArtifactDigest
    && role.evidence.asarHeaderDigest === source.asarHeaderDigest
    && role.evidence.signature.signatureDigest === source.signatureDigest;
}

function assertJournalBinding(
  input: RecoverEnvironmentModePairWarmInput,
  pair: EnvironmentModePairReceipt,
  journal: EnvironmentWarmCommitReceipt,
): void {
  if (input.transactionId !== undefined && input.transactionId !== journal.transactionId) {
    throw new Error(`Environment warm recovery transaction mismatch: expected ${input.transactionId}, found ${journal.transactionId}`);
  }
  // `sourceAppPath` is the fixed outer live bundle path. It must not be used
  // to infer which slot has source Contents after a role rotation; that comes
  // only from sourceProjection's sealed inode and digest evidence below.
  if (journal.generationId !== pair.generationId
    || journal.sourceAppPath !== pair.roles.live.appPath) {
    throw new Error("Environment warm recovery journal does not bind the sealed pair generation");
  }
}

function assertRecoveryInput(input: RecoverEnvironmentModePairWarmInput): void {
  if (input === null || typeof input !== "object" || input.cachePaths === null || typeof input.cachePaths !== "object"
    || (input.transactionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.transactionId))) {
    throw new Error("Environment warm recovery input is invalid");
  }
}

function assertRecoveryDeps(deps: EnvironmentWarmRecoveryDeps): void {
  if (deps === null || typeof deps !== "object"
    || (deps.now !== undefined && typeof deps.now !== "function")
    || ![
      "checkForVerifiedNewerOfficial",
      "adoptVerifiedNewerOfficial",
      "pauseWatcher",
      "observeExactLiveTarget",
      "stopExactLiveTarget",
      "captureExchangeBefore",
      "captureExchangeProof",
      "exchangeContents",
      "restoreSource",
      "observeSource",
      "reopenSource",
      "proveSource",
      "proveTarget",
      "bindWatcherTarget",
      "publishSelection",
      "resumeWatcher",
    ].every((name) => typeof (deps as unknown as Record<string, unknown>)[name] === "function")) {
    throw new Error("Environment warm recovery requires a complete explicitly bound persistent recovery adapter");
  }
}

function assertOfficialUpdate(value: EnvironmentWarmRecoveryOfficialUpdate): void {
  if (value === null || typeof value !== "object"
    || (value.state !== "unchanged" && value.state !== "newer_verified_official")
    || (value.state === "newer_verified_official" && !isEnvironmentSelection(value.selection))) {
    throw new Error("Environment warm recovery official updater oracle returned an invalid result");
  }
}

function assertOfficialAdoption(
  adoption: EnvironmentWarmRecoveryOfficialAdoption,
  expected: EnvironmentSelection,
): void {
  if (adoption === null || typeof adoption !== "object"
    || !Number.isInteger(adoption.pid) || adoption.pid <= 0
    || adoption.visibleWindow !== true
    || !isEnvironmentSelection(adoption.selection)
    || adoption.selection.selectedDesktopPath !== expected.selectedDesktopPath
    || adoption.selection.appExperience !== "chatgpt"
    || adoption.selection.appliedAt === null) {
    throw new Error("Environment warm recovery did not prove adoption of the verified newer official app");
  }
}

function assertSourceProjection(
  pair: EnvironmentModePairReceipt,
  source: EnvironmentWarmCommitSourceProjectionIdentity,
  projection: EnvironmentWarmCommitProjection,
): void {
  const live = pair.roles.live;
  if (live.appPath !== source.appPath
    || live.experience !== source.appExperience
    || live.evidence.bundleId !== source.bundleId
    || live.evidence.appDigest !== source.desktopArtifactDigest
    || live.evidence.asarHeaderDigest !== source.asarHeaderDigest
    || live.evidence.signature.signatureDigest !== source.signatureDigest
    || projection.selection.selectedDesktopPath !== source.appPath
    || projection.selection.selectedDesktopBundleId !== source.bundleId
    || projection.selection.releaseProfile !== source.releaseProfile
    || projection.selection.appExperience !== source.appExperience
    || projection.selection.appliedAt !== null
    || projection.targetExpectedFingerprint !== source.desktopArtifactDigest
    || typeof projection.restore !== "function") {
    throw new Error("Warm recovery adapter returned a source projection that does not match the durable source identity");
  }
}

function assertRecoveredProof(pair: EnvironmentModePairReceipt, proof: EnvironmentWarmCommitTargetProof): void {
  const live = pair.roles.live;
  if (!Number.isInteger(proof.pid) || proof.pid <= 0
    || proof.visibleWindow !== true
    || proof.appPath !== live.appPath
    || proof.appExperience !== live.experience
    || proof.bundleId !== live.evidence.bundleId
    || proof.version !== live.evidence.version
    || proof.build !== live.evidence.build
    || proof.asarHeaderDigest !== live.evidence.asarHeaderDigest
    || proof.signatureDigest !== live.evidence.signature.signatureDigest
    || proof.desktopArtifactDigest !== live.evidence.appDigest
    || !isEnvironmentSelection(proof.selection)
    || proof.selection.selectedDesktopPath !== live.appPath
    || proof.selection.appExperience !== live.experience
    || proof.selection.releaseProfile !== pair.releaseProfile
    || proof.selection.appliedAt === null) {
    throw new Error("Warm recovery proof did not establish the exact visible sealed environment");
  }
  if (live.experience === "tweakers") {
    if (proof.tweakersLoaderActive !== true || proof.mcpEnabled !== true
      || proof.backendDigest !== pair.tweakers.backend.digest
      || proof.runtimeDigest !== pair.tweakers.runtime.digest
      || proof.managedRuntimeDigest !== pair.tweakers.managedRuntime.digest) {
      throw new Error("Warm recovery proof did not establish the Tweakers runtime and MCP projection");
    }
  } else if (proof.tweakersLoaderActive !== false || proof.mcpEnabled !== false
    || proof.backendDigest !== null || proof.runtimeDigest !== null || proof.managedRuntimeDigest !== null) {
    throw new Error("Warm recovery pristine source/target still exposes Tweakers runtime or MCP state");
  }
}

function assertExchangeBeforeMatchesContents(
  pair: EnvironmentModePairReceipt,
  before: EnvironmentWarmCommitPreflightReady["exchangeBefore"],
  contents: EnvironmentModePairContentsRoleObservation,
): void {
  const livePath = join(pair.roles.live.appPath, "Contents");
  const inactivePath = join(pair.paths.inactiveAppPath, "Contents");
  if (before.liveContentsBefore.path !== livePath
    || before.inactiveContentsBefore.path !== inactivePath
    || before.liveContentsBefore.dev !== contents.live.dev
    || before.liveContentsBefore.ino !== contents.live.ino
    || before.inactiveContentsBefore.dev !== contents.inactive.dev
    || before.inactiveContentsBefore.ino !== contents.inactive.ino
    || before.liveOuterBefore.path !== pair.roles.live.appPath
    || before.inactiveOuterBefore.path !== pair.paths.inactiveAppPath) {
    throw new Error("Warm recovery exchange evidence does not bind the current exact Contents roles");
  }
}

function assertRecoveryExchangeProof(
  pair: EnvironmentModePairReceipt,
  proof: {
    liveContentsAfter: EnvironmentModeCacheContentsIdentity;
    inactiveContentsAfter: EnvironmentModeCacheContentsIdentity;
    liveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
    inactiveOuterAfter: EnvironmentModeCacheOuterAppEvidence;
  },
): void {
  const livePath = join(pair.roles.live.appPath, "Contents");
  const inactivePath = join(pair.paths.inactiveAppPath, "Contents");
  if (proof.liveContentsAfter.path !== livePath || proof.inactiveContentsAfter.path !== inactivePath
    || proof.liveOuterAfter.path !== pair.roles.live.appPath
    || proof.inactiveOuterAfter.path !== pair.paths.inactiveAppPath) {
    throw new Error("Warm recovery exchange proof does not bind the pair paths");
  }
}

function persistStamp(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  phase: EnvironmentWarmCommitReceipt["phase"],
  at: string,
  detail: string | null = null,
): EnvironmentWarmCommitReceipt {
  const next: EnvironmentWarmCommitReceipt = {
    ...receipt,
    phase,
    stamps: [...receipt.stamps, { phase, at, detail }],
    updatedAt: at,
  };
  writeEnvironmentWarmCommitReceipt(file, next);
  return next;
}

function finishReadyRecovery(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  at: string,
): EnvironmentWarmCommitReceipt {
  const next: EnvironmentWarmCommitReceipt = {
    ...receipt,
    phase: "ready",
    error: null,
    terminalAt: at,
    updatedAt: at,
    timing: { ...receipt.timing, readyAt: at },
    stamps: [...receipt.stamps, { phase: "ready", at, detail: "Recovery terminal fsync" }],
  };
  writeEnvironmentWarmCommitReceipt(file, next);
  return next;
}

function finishStaleRecovery(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  at: string,
  error: string,
): EnvironmentWarmCommitReceipt {
  const next: EnvironmentWarmCommitReceipt = {
    ...receipt,
    phase: "stale_requires_prepare",
    error,
    terminalAt: at,
    updatedAt: at,
    stamps: [...receipt.stamps, { phase: "stale_requires_prepare", at, detail: error }],
  };
  writeEnvironmentWarmCommitReceipt(file, next);
  return next;
}

function recoverableFailure(
  file: string,
  receipt: EnvironmentWarmCommitReceipt,
  error: string,
  now: () => string,
): Error {
  writeEnvironmentWarmCommitReceipt(file, { ...receipt, error, updatedAt: now() });
  return new Error(error);
}

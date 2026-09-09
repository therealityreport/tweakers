import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  NATIVE_HISTORY_ACTIVATION_KIND,
  NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX,
  NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND,
  nativeHistoryActivationPaths,
  nativeHistoryActivationCancelledBeforeApply,
  quiesceExactApp,
  observeNativeHistoryActivationBroker,
  parseNativeHistoryActivationManagerInvocation,
  runNativeHistoryActivation,
  type NativeHistoryActivationContextV1,
  type NativeHistoryActivationCoordinatorDependencies,
  type NativeHistoryActivationJournalV1,
  type NativeHistoryActivationPreparedIndependent,
} from "../src/native-history-activation";
import { VariantPrePromotionAbortedError } from "../src/commands/create-variant";
import type { ProcessInfo, OpenReport } from "../src/commands/debug";
import { canonicalJson } from "../src/account-history-adoption";
import { routerControlSocketPath } from "../src/account-router-status";
import type { EnvironmentTransactionReceipt } from "../src/environment-transaction";

function activationFixture(t: { after: (callback: () => void) => void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "native-activation-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const managerRoot = join(home, "Library", "Application Support", "Tweakers");
  const operationId = "12345678-1234-4234-8234-123456789012";
  const hash = "a".repeat(64);
  const fingerprint = `sha256:${hash}`;
  const now = "2026-09-05T12:00:00.000Z";
  const identity = { device: 1, inode: 2, uid: process.getuid?.() ?? 501, mode: 0o700 };
  const userRoot = join(managerRoot, "variants", "tweakers");
  const generationRoot = join(managerRoot, "managers", hash);
  const file = (name: string) => ({ path: join(generationRoot, name), bytes: 1, sha256: hash });
  const paths = nativeHistoryActivationPaths(managerRoot, operationId);
  const context: NativeHistoryActivationContextV1 = {
    version: 1, kind: NATIVE_HISTORY_ACTIVATION_KIND, operationId, managerRoot,
    operationRoot: paths.operationRoot, approvedAt: now, preparedAt: now,
    apps: { chatgpt: "/Applications/ChatGPT.app", tweakers: "/Applications/Tweakers.app" },
    manager: {
      generationId: hash, generationRoot, managerBundle: file("manager.mjs"), targetSeal: file("target-seal.json"),
      launcher: file("launcher"), node: file("node"),
      runtime: { root: join(generationRoot, "runtime"), fingerprint: hash, brokerHost: file("runtime/account-router/broker-host.js") },
      managedRuntime: { root: join(generationRoot, "managed-runtime"), fingerprint: hash },
    },
    source: { generationId: operationId, receiptDigest: hash, sourceDigest: hash, revision: fingerprint },
    environment: {
      registryFile: join(managerRoot, "environment-registry.json"), registryRevision: fingerprint,
      selectionFile: join(managerRoot, "environment-selection.json"), selectionRevision: fingerprint,
    },
    tweakers: { appPath: "/Applications/Tweakers.app", appIdentity: identity, userRoot,
      stateFile: join(userRoot, "state.json"), stateRevision: fingerprint },
    roots: {
      legacyRouterRoot: join(home, "legacy"), sourceCodexRoot: join(home, "native"), sourceSqliteRoot: join(home, "native"),
      secondaryCodexRoot: join(userRoot, "codex-home"), secondarySqliteRoot: join(userRoot, "codex-home"),
      globalRoot: join(managerRoot, "tweak-data", "co.tweakers.account-switcher"),
      legacyConfigFingerprint: fingerprint, legacyConfigGeneration: 1,
      legacyRouterIdentity: identity, sourceCodexIdentity: identity, sourceSqliteIdentity: identity,
      secondaryCodexIdentity: identity, secondarySqliteIdentity: identity,
    },
    registration: { issuedAt: now, registrationFingerprint: fingerprint, globalRootAbsent: true, reservationAbsent: true },
    runner: { kind: "launchd-one-shot", label: `${NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX}.${operationId}`,
      plistPath: join(home, "Library", "LaunchAgents", `${NATIVE_HISTORY_ACTIVATION_LAUNCHD_LABEL_PREFIX}.${operationId}.plist`) },
  };
  mkdirSync(context.roots.sourceCodexRoot, { recursive: true });
  const history = join(context.roots.sourceCodexRoot, "history.jsonl");
  writeFileSync(history, "original conversation history\n");
  const events: string[] = [];
  const journals: NativeHistoryActivationJournalV1[] = [];
  const registration = { registrationFingerprint: fingerprint, globalRoot: identity, reservation: identity };
  const rootHash = createHash("sha256").update(context.roots.globalRoot).digest("hex").slice(0, 24);
  const broker = { pid: 123, processStartToken: "test-broker-start", parentPid: 1, parentProcessStartToken: "test-launchd",
    brokerHostPath: context.manager.runtime.brokerHost.path, brokerHostSha256: hash,
    socketPath: join("/tmp", `arc-${process.getuid?.() ?? "local"}`, `${rootHash}-accounts-broker.v1.sock`), configSha256: hash };
  const independent = {
    deferred: {
      userRoot, commit: () => { events.push("independent.commit"); }, rollback: () => { events.push("independent.rollback"); },
    },
    previousTweakers: { pid: 100, processStartToken: "old-tweakers" },
  } as unknown as NativeHistoryActivationPreparedIndependent;
  const dependencies: NativeHistoryActivationCoordinatorDependencies = {
    now: () => now,
    verifyContext: () => { events.push("verify"); },
    readJournal: () => null,
    writeJournal: (_context, journal) => { journals.push(structuredClone(journal)); },
    prepareInjected: async (_context, beforeApply) => {
      events.push("injected.prepare");
      return {
        commit: async () => {
          events.push("injected.commit");
          await beforeApply();
          events.push("injected.applied");
          return { transactionId: operationId, phase: "committed", applied: {}, newMainPid: 120 } as EnvironmentTransactionReceipt;
        },
        cancel: async () => { events.push("injected.cancel"); },
        rollback: async () => { events.push("injected.rollback"); },
        restoreBeforeRegistration: async () => { events.push("injected.rollback"); },
      };
    },
    prepareIndependent: async (_context, beforePromotion) => {
      events.push("independent.prepare");
      await beforePromotion();
      events.push("independent.promote");
      return independent;
    },
    finalWriterCensus: () => { events.push("writers.idle"); return true; },
    quiesceInjectedBeforeRegistration: async () => { events.push("injected.helpers.close"); },
    postPublicationWriterCensus: () => { events.push("writers.post-publication-idle"); return true; },
    prepareOfflineAccountContinuity: async () => { events.push("continuity.prepare"); },
    quiesceVerifiedInjected: async () => { events.push("injected.close"); },
    applyNativeHistory: () => { events.push("register"); return registration; },
    inspectPublishedRegistration: () => null,
    reopenAndProveIndependent: async () => { events.push("independent.verify"); },
    observeBroker: () => {
      events.push("broker.observe");
      return context.activationScope === "tweakers-only"
        ? { ...broker, brokerHostPath: join(userRoot, "runtime", "account-router", "broker-host.js") }
        : broker;
    },
    stopBroker: async () => { events.push("broker.stop"); },
    stopParticipatingApps: async () => { events.push("apps.stop"); },
    archiveRegistration: () => {
      events.push("registration.archive");
      return { archiveRoot: paths.archive, globalRootArchive: join(paths.archive, "global-root"), reservationArchive: join(paths.archive, "native-setup-reservation") };
    },
    reopenPreviousTweakers: async () => { events.push("previous.reopen"); },
  };
  return { context, events, journals, dependencies, broker, registration, independent,
    assertHistoryUnchanged: () => assert.equal(readFileSync(history, "utf8"), "original conversation history\n") };
}

function writePrivateFixtureFile(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Builds the exact bootstrap layout expected by the production inspector. */
function writePublishedRegistrationFixture(f: ReturnType<typeof activationFixture>): { secret: Buffer; configSha256: string } {
  const { context } = f;
  const secret = Buffer.alloc(32, 7);
  const accountA = `ar_${"a".repeat(43)}`;
  const accountB = `ar_${"b".repeat(43)}`;
  mkdirSync(context.roots.legacyRouterRoot, { recursive: true, mode: 0o700 });
  mkdirSync(context.roots.secondaryCodexRoot, { recursive: true, mode: 0o700 });
  writePrivateFixtureFile(join(context.roots.legacyRouterRoot, "control-secret.v1"), secret);
  const config = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation: 2,
    protocolFingerprint: context.registration.registrationFingerprint,
    primaryOpaqueAccountId: accountA,
    accounts: [
      { opaqueAccountId: accountA, included: true, weight: 50, capabilityFingerprint: context.registration.registrationFingerprint, label: "First" },
      { opaqueAccountId: accountB, included: true, weight: 50, capabilityFingerprint: context.registration.registrationFingerprint, label: "Second" },
    ],
    updatedAt: context.registration.issuedAt,
    fingerprint: "",
  };
  config.fingerprint = `sha256:${createHash("sha256").update(canonicalJson({
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    policy: config.policy,
    generation: config.generation,
    protocolFingerprint: config.protocolFingerprint,
    primaryOpaqueAccountId: config.primaryOpaqueAccountId,
    accounts: config.accounts,
  })).digest("hex")}`;
  const sourceUnsigned = {
    version: 1,
    kind: "account-router-native-history-source",
    mode: "in_place",
    protocolFingerprint: config.protocolFingerprint,
    accountSetFingerprint: `sha256:${createHash("sha256").update(canonicalJson([accountA, accountB])).digest("hex")}`,
    metadataAccountId: accountA,
    accounts: [
      {
        opaqueAccountId: accountA,
        codexHome: context.roots.sourceCodexRoot,
        sqliteHome: context.roots.sourceSqliteRoot,
        codexHomeIdentity: context.roots.sourceCodexIdentity,
        sqliteHomeIdentity: context.roots.sourceSqliteIdentity,
        authIdentityHmac: `hmac-sha256:${"a".repeat(64)}`,
      },
      {
        opaqueAccountId: accountB,
        codexHome: context.roots.secondaryCodexRoot,
        sqliteHome: context.roots.secondarySqliteRoot,
        codexHomeIdentity: context.roots.secondaryCodexIdentity,
        sqliteHomeIdentity: context.roots.secondarySqliteIdentity,
        authIdentityHmac: `hmac-sha256:${"b".repeat(64)}`,
      },
    ],
    issuedAt: context.registration.issuedAt,
  };
  const source = {
    ...sourceUnsigned,
    signature: `hmac-sha256:${createHmac("sha256", secret)
      .update(`account-router:native-history-source:v1\0${canonicalJson(sourceUnsigned)}`).digest("hex")}`,
  };
  const registrationFingerprint = `sha256:${createHash("sha256")
    .update(canonicalJson({ config, source })).digest("hex")}`;
  context.registration = { ...context.registration, registrationFingerprint };
  const root = context.roots.globalRoot;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(`${root}.native-setup-reservation`, { recursive: true, mode: 0o700 });
  writePrivateFixtureFile(join(root, "control-secret.v1"), secret);
  writePrivateFixtureFile(join(root, "account-router-config.json"), `${JSON.stringify(config)}\n`);
  writePrivateFixtureFile(join(root, "native-history-source.v1.json"), `${JSON.stringify(source)}\n`);
  writePrivateFixtureFile(join(root, "canonical-history.v1.json"), `${JSON.stringify({ version: 1, conversations: [] })}\n`);
  writePrivateFixtureFile(join(root, "native-history-setup.v1.json"), `${JSON.stringify({
    version: 1,
    registrationFingerprint,
    mode: "in_place",
    createdAt: context.registration.issuedAt,
  })}\n`);
  return {
    secret,
    configSha256: createHash("sha256").update(readFileSync(join(root, "account-router-config.json"))).digest("hex"),
  };
}

test("native activation argv accepts only a bounded operation-bound capability", () => {
  const argv = [NATIVE_HISTORY_ACTIVATION_MANAGER_RUN_COMMAND, "--operation-id", "12345678-1234-4234-8234-123456789012",
    "--context-bytes", "1024", "--context-sha256", `sha256:${"a".repeat(64)}`];
  assert.equal(parseNativeHistoryActivationManagerInvocation(argv).contextBytes, 1024);
  for (const invalid of [argv.slice(0, -1), [...argv, "--apply"], argv.map((v) => v === "1024" ? "65537" : v),
    argv.map((v) => v === "--operation-id" ? "--context-path" : v)]) {
    assert.throws(() => parseNativeHistoryActivationManagerInvocation(invalid));
  }
});

test("activation prepares both candidates before registration and requires both runtime proofs before commit", async (t) => {
  const f = activationFixture(t);
  const result = await runNativeHistoryActivation(f.context, f.dependencies);
  assert.equal(result.phase, "committed");
  assert.deepEqual(f.events, ["verify", "injected.prepare", "independent.prepare", "injected.commit", "injected.helpers.close", "writers.idle", "register", "continuity.prepare",
    "independent.promote", "injected.applied", "broker.observe", "injected.close", "independent.verify", "broker.observe", "independent.commit"]);
  f.assertHistoryUnchanged();
});

test("context drift fails before candidate construction or account publication", async (t) => {
  const f = activationFixture(t);
  f.dependencies.verifyContext = () => { throw new Error("source identity changed"); };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /source identity changed/);
  assert.equal(f.events.includes("register"), false);
  assert.equal(f.events.includes("injected.prepare"), false);
  f.assertHistoryUnchanged();
});

test("independent candidate failure cancels preparation without publishing a registration", async (t) => {
  const f = activationFixture(t);
  f.dependencies.prepareIndependent = async () => { throw new Error("candidate invalid"); };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /candidate invalid/);
  assert.equal(f.events.includes("register"), false);
  assert.equal(f.events.includes("injected.commit"), false);
  assert.equal(f.events.includes("injected.cancel"), true);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
  f.assertHistoryUnchanged();
});

test("a rejected final census recovers the cancelled environment after a proven independent pre-promotion abort", async (t) => {
  const f = activationFixture(t);
  f.dependencies.prepareIndependent = async (_context, beforePromotion, capture) => {
    capture(f.independent.previousTweakers);
    try { await beforePromotion(); } catch (error) { throw new VariantPrePromotionAbortedError(error); }
    return f.independent;
  };
  f.dependencies.finalWriterCensus = () => false;
  const original = f.dependencies.prepareInjected!;
  f.dependencies.prepareInjected = async (...args) => ({ ...await original(...args),
    rollback: async () => { throw new Error("post-publication rollback must not accept cancellation"); },
    restoreBeforeRegistration: async () => { f.events.push("cancelled.source.proven"); },
  });
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /final writer census/);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
  assert.deepEqual(f.journals.at(-1)?.previousTweakers, f.independent.previousTweakers);
  assert.equal(f.events.includes("register"), false);
  assert.ok(f.events.indexOf("previous.reopen") > f.events.indexOf("cancelled.source.proven"));
  f.assertHistoryUnchanged();
});

test("an unproven abort after independent app capture remains recovery-required and retains its cause", async (t) => {
  const f = activationFixture(t);
  f.dependencies.prepareIndependent = async (_context, beforePromotion, capture) => {
    capture(null);
    try { await beforePromotion(); } catch { throw new Error("candidate archive failed"); }
    return f.independent;
  };
  f.dependencies.finalWriterCensus = () => false;
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /recovery/);
  assert.equal(f.journals.at(-1)?.phase, "recovery-required");
  assert.match(f.journals.at(-1)!.error!, /candidate archive failed/);
  assert.equal(f.journals.at(-1)?.previousTweakers, null);
  assert.equal(f.events.includes("injected.rollback"), false);
  assert.equal(f.events.includes("previous.reopen"), false);
});

test("pre-publication cancellation eligibility rejects evidence that cutover or rollback began", () => {
  const receipt = { transactionId: "operation", phase: "cancelled", attempt: 0, prepared: {}, applied: null,
    newMainPid: null, committedAt: null, rolledBackAt: null } as EnvironmentTransactionReceipt;
  assert.equal(nativeHistoryActivationCancelledBeforeApply(receipt, "operation"), true);
  for (const patch of [{ transactionId: "other" }, { phase: "failed" }, { attempt: 1 }, { prepared: null }, { applied: {} },
    { newMainPid: 123 }, { committedAt: "now" }, { rolledBackAt: "now" }, { applyProgress: "rollback:started" }]) {
    assert.equal(nativeHistoryActivationCancelledBeforeApply({ ...receipt, ...patch } as EnvironmentTransactionReceipt, "operation"), false);
  }
});

function helperReport(processes: ProcessInfo[], main = false): OpenReport {
  return { status: processes.length ? "background" : "closed", pid: processes[0]?.pid ?? null,
    relatedPids: processes.map((process) => process.pid), hasMainProcess: main,
    openedAt: null, openedAtRaw: processes[0]?.startedAtRaw ?? null, detail: null };
}

test("activation helper shutdown stops captured helpers only and rejects a newly opened main process", async () => {
  const helper: ProcessInfo = { pid: 22, ppid: 1, startedAtRaw: "old-helper", startedAt: null, command: "/Applications/ChatGPT.app/Contents/helper" };
  let live = [helper];
  const signals: [number, NodeJS.Signals][] = [];
  await quiesceExactApp("/Applications/ChatGPT.app", null, {
    processes: () => live, report: helperReport,
    signal: (pid, signal) => { signals.push([pid, signal]); live = []; },
  });
  assert.deepEqual(signals, [[22, "SIGTERM"]]);
  await assert.rejects(quiesceExactApp("/Applications/ChatGPT.app", null, {
    processes: () => [helper], report: (snapshot) => helperReport(snapshot, true),
    signal: () => { assert.fail("must not signal a newly opened main process"); },
  }), /main process changed/);
});

test("activation helper shutdown never signals a reused PID and refuses unknown residual processes", async () => {
  let observations = 0;
  const old: ProcessInfo = { pid: 22, ppid: 1, startedAtRaw: "old", startedAt: null, command: "helper" };
  await assert.rejects(quiesceExactApp("/Applications/ChatGPT.app", null, {
    processes: () => [++observations === 1 ? old : { ...old, startedAtRaw: "new" }],
    report: helperReport,
    signal: () => { assert.fail("must not signal a reused PID"); },
  }), /could not prove.*helper quiescence/);
});

test("activation helper shutdown accepts an exit during signaling only when fresh observations prove absence", async () => {
  for (const code of ["ESRCH", "EPERM"]) {
    let live: ProcessInfo[] = [{ pid: 22, ppid: 1, startedAtRaw: "helper-start", startedAt: null, command: "helper" }];
    const shutdown = quiesceExactApp("/Applications/ChatGPT.app", null, {
      processes: () => live, report: helperReport,
      signal: () => { live = []; throw Object.assign(new Error(code), { code }); },
    });
    if (code === "ESRCH") await shutdown;
    else await assert.rejects(shutdown, /EPERM/);
  }
});

test("failed live proof stops participants and archives only registration before restoring prior apps", async (t) => {
  const f = activationFixture(t);
  f.dependencies.reopenAndProveIndependent = async () => { throw new Error("connection unavailable"); };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /connection unavailable/);
  const stopped = f.events.indexOf("apps.stop");
  const brokerStopped = f.events.indexOf("broker.stop");
  const archived = f.events.indexOf("registration.archive");
  assert.ok(stopped >= 0 && brokerStopped > stopped && archived > brokerStopped);
  assert.ok(f.events.indexOf("injected.rollback") > archived);
  assert.ok(f.events.indexOf("previous.reopen") > archived);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
  f.assertHistoryUnchanged();
});

test("Tweakers-only activation commits without preparing, stopping or changing native Codex", async (t) => {
  const f = activationFixture(t);
  f.context.activationScope = "tweakers-only";
  f.dependencies.prepareInjected = async () => { throw new Error("native Codex preparation is forbidden"); };
  f.dependencies.quiesceInjectedBeforeRegistration = async () => { throw new Error("native Codex shutdown is forbidden"); };
  f.dependencies.quiesceVerifiedInjected = async () => { throw new Error("native Codex shutdown is forbidden"); };
  const result = await runNativeHistoryActivation(f.context, f.dependencies);
  assert.equal(result.phase, "committed");
  assert.equal(f.events.some((event) => event.startsWith("injected.")), false);
  assert.ok(f.events.indexOf("register") > f.events.indexOf("writers.idle"));
  assert.ok(f.events.indexOf("independent.promote") > f.events.indexOf("continuity.prepare"));
  assert.ok(f.events.indexOf("independent.commit") > f.events.indexOf("independent.verify"));
  f.assertHistoryUnchanged();
});

test("Tweakers-only failed live proof recovers registration and independent app without an injected transaction", async (t) => {
  const f = activationFixture(t);
  f.context.activationScope = "tweakers-only";
  f.dependencies.reopenAndProveIndependent = async () => { throw new Error("independent proof failed"); };
  f.dependencies.stopParticipatingApps = async (context) => {
    assert.equal(context.activationScope, "tweakers-only");
    f.events.push("tweakers.stop");
  };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /independent proof failed/);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
  assert.equal(f.events.some((event) => event.startsWith("injected.")), false);
  assert.ok(f.events.indexOf("registration.archive") > f.events.indexOf("tweakers.stop"));
  assert.ok(f.events.indexOf("independent.rollback") > f.events.indexOf("registration.archive"));
  assert.ok(f.events.indexOf("previous.reopen") > f.events.indexOf("independent.rollback"));
  f.assertHistoryUnchanged();
});

test("a journal failure after independent commit preserves registration and the committed app", async (t) => {
  const f = activationFixture(t);
  f.context.activationScope = "tweakers-only";
  const write = f.dependencies.writeJournal!;
  f.dependencies.writeJournal = (context, journal) => {
    if (journal.phase === "committed") throw new Error("fixture journal write failed");
    write(context, journal);
  };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /committed; activation journal recovery/);
  assert.equal(f.events.includes("independent.commit"), true);
  assert.equal(f.events.includes("registration.archive"), false);
  assert.equal(f.events.includes("independent.rollback"), false);
  assert.equal(f.events.includes("previous.reopen"), false);
  assert.equal(f.journals.at(-1)?.phase, "recovery-required");
  assert.ok(f.journals.at(-1)?.registration);
  f.assertHistoryUnchanged();
});

test("independent cutover wrappers retain the underlying account-preparation failure", async (t) => {
  const f = activationFixture(t);
  f.context.activationScope = "tweakers-only";
  f.dependencies.prepareOfflineAccountContinuity = async () => {
    throw new Error("Independent cutover recovered", { cause: new Error("invalid native transfer account") });
  };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /Independent cutover recovered/);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
  assert.match(f.journals.at(-1)?.error ?? "", /invalid native transfer account/);
  f.assertHistoryUnchanged();
});

test("uncertain broker ownership preserves registration and never reopens old writers", async (t) => {
  const f = activationFixture(t);
  f.dependencies.reopenAndProveIndependent = async () => { throw new Error("connection unavailable"); };
  f.dependencies.stopBroker = async () => { throw new Error("broker identity changed"); };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /recovery/);
  assert.equal(f.events.includes("registration.archive"), false);
  assert.equal(f.events.includes("previous.reopen"), false);
  assert.equal(f.events.includes("injected.rollback"), false);
  assert.equal(f.journals.at(-1)?.phase, "recovery-required");
  f.assertHistoryUnchanged();
});

test("a publication failure distinguishes absent, reservation-only, and proven-published registration evidence", async (t) => {
  const absent = activationFixture(t);
  absent.dependencies.applyNativeHistory = () => { absent.events.push("register.failed.absent"); throw new Error("publish failed"); };
  await assert.rejects(runNativeHistoryActivation(absent.context, absent.dependencies), /publish failed/);
  assert.equal(absent.events.includes("injected.rollback"), true);
  assert.equal(absent.events.includes("registration.archive"), false);
  assert.equal(absent.journals.at(-1)?.phase, "rolled-back");

  const reservationOnly = activationFixture(t);
  mkdirSync(`${reservationOnly.context.roots.globalRoot}.native-setup-reservation`, { recursive: true, mode: 0o700 });
  reservationOnly.dependencies.applyNativeHistory = () => { reservationOnly.events.push("register.failed.reservation"); throw new Error("publish failed"); };
  await assert.rejects(runNativeHistoryActivation(reservationOnly.context, reservationOnly.dependencies), /ambiguous/);
  assert.equal(reservationOnly.events.includes("injected.rollback"), false);
  assert.equal(reservationOnly.events.includes("injected.cancel"), false);
  assert.equal(reservationOnly.events.includes("previous.reopen"), false);
  assert.equal(reservationOnly.journals.at(-1)?.phase, "recovery-required");

  const published = activationFixture(t);
  published.dependencies.applyNativeHistory = () => { published.events.push("register.failed.published"); throw new Error("publish failed"); };
  published.dependencies.inspectPublishedRegistration = () => published.registration;
  await assert.rejects(runNativeHistoryActivation(published.context, published.dependencies), /publish failed/);
  assert.equal(published.events.includes("registration.archive"), true);
  assert.equal(published.events.includes("injected.rollback"), true);
  assert.equal(published.journals.at(-1)?.phase, "rolled-back");
});

test("a changed broker identity after independent runtime proof retains registration for recovery", async (t) => {
  const f = activationFixture(t);
  const changed = { ...f.broker, processStartToken: "reused-broker-start" };
  let observations = 0;
  f.dependencies.observeBroker = () => {
    f.events.push("broker.observe");
    observations += 1;
    return observations === 1 ? f.broker : changed;
  };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /rollback was incomplete/);
    assert.match(String(error.errors[1]), /identity changed/);
    return true;
  });
  assert.equal(f.events.includes("registration.archive"), false);
  assert.equal(f.events.includes("injected.rollback"), false);
  assert.equal(f.events.includes("previous.reopen"), false);
  assert.equal(f.journals.at(-1)?.phase, "recovery-required");
});

test("a nonterminal journal cannot be replayed and a malformed committed journal is rejected", async (t) => {
  const f = activationFixture(t);
  const base = {
    version: 1 as const,
    kind: "native-history-activation-journal" as const,
    operationId: f.context.operationId,
    attemptStartedAt: f.context.registration.issuedAt,
    updatedAt: f.context.registration.issuedAt,
    registrationFingerprint: null,
    registration: null,
    broker: null,
    archive: null,
    error: null,
  };
  f.dependencies.readJournal = () => ({ ...base, phase: "prepared" });
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /already started/);
  assert.equal(f.events.length, 0);

  const malformed = activationFixture(t);
  malformed.dependencies.readJournal = () => ({ ...base, operationId: malformed.context.operationId, phase: "committed" });
  await assert.rejects(runNativeHistoryActivation(malformed.context, malformed.dependencies), /committed journal/);
  assert.equal(malformed.events.length, 0);
});

test("partial archive, archive journal, and post-publication census failures suppress restoration", async (t) => {
  const archiveFailure = activationFixture(t);
  archiveFailure.dependencies.reopenAndProveIndependent = async () => { throw new Error("runtime proof failed"); };
  archiveFailure.dependencies.archiveRegistration = () => {
    archiveFailure.events.push("registration.archive.partial");
    throw new Error("reservation rename failed");
  };
  await assert.rejects(runNativeHistoryActivation(archiveFailure.context, archiveFailure.dependencies), /recovery/);
  assert.equal(archiveFailure.events.includes("injected.rollback"), false);
  assert.equal(archiveFailure.events.includes("previous.reopen"), false);
  assert.equal(archiveFailure.journals.at(-1)?.phase, "recovery-required");

  const censusFailure = activationFixture(t);
  censusFailure.dependencies.reopenAndProveIndependent = async () => { throw new Error("runtime proof failed"); };
  censusFailure.dependencies.postPublicationWriterCensus = () => {
    censusFailure.events.push("writers.post-publication-busy");
    return false;
  };
  await assert.rejects(runNativeHistoryActivation(censusFailure.context, censusFailure.dependencies), /recovery/);
  assert.equal(censusFailure.events.includes("registration.archive"), false);
  assert.equal(censusFailure.events.includes("injected.rollback"), false);
  assert.equal(censusFailure.events.includes("previous.reopen"), false);

  const journalFailure = activationFixture(t);
  journalFailure.dependencies.reopenAndProveIndependent = async () => { throw new Error("runtime proof failed"); };
  const write = journalFailure.dependencies.writeJournal!;
  journalFailure.dependencies.writeJournal = (context, journal) => {
    write(context, journal);
    if (journal.archive !== null) throw new Error("archive journal write failed");
  };
  await assert.rejects(runNativeHistoryActivation(journalFailure.context, journalFailure.dependencies), /recovery/);
  assert.equal(journalFailure.events.includes("injected.rollback"), false);
  assert.equal(journalFailure.events.includes("previous.reopen"), false);
});

test("an injected commit that started but never committed rolls back after registration", async (t) => {
  const f = activationFixture(t);
  f.dependencies.prepareInjected = async (_context, beforeApply) => ({
    commit: async () => {
      f.events.push("injected.commit.invalid");
      await beforeApply();
      return { transactionId: f.context.operationId, phase: "failed", applied: {}, newMainPid: 1,
        error: "Offline account continuity requires idle apps: native-history-writer; PIDs 123" } as unknown as EnvironmentTransactionReceipt;
    },
    cancel: async () => { f.events.push("injected.cancel"); },
    rollback: async () => { f.events.push("injected.rollback"); },
  });
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /did not prove a committed.*native-history-writer; PIDs 123/);
  assert.equal(f.events.includes("injected.rollback"), true);
  assert.equal(f.events.includes("injected.cancel"), false);
  assert.equal(f.events.includes("registration.archive"), true);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
  assert.match(f.journals.at(-1)?.error ?? "", /native-history-writer; PIDs 123/);
});

test("independent rollback failure prevents injected rollback and reopening old writers", async (t) => {
  const f = activationFixture(t);
  f.dependencies.reopenAndProveIndependent = async () => { throw new Error("runtime proof failed"); };
  f.independent.deferred.rollback = () => {
    f.events.push("independent.rollback.failed");
    throw new Error("independent restore failed");
  };
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /recovery/);
  assert.equal(f.events.includes("registration.archive"), true);
  assert.equal(f.events.includes("injected.rollback"), false);
  assert.equal(f.events.includes("previous.reopen"), false);
  assert.equal(f.journals.at(-1)?.phase, "recovery-required");
});

test("production registration inspection accepts only the exact signed temporary bootstrap", async (t) => {
  const f = activationFixture(t);
  writePublishedRegistrationFixture(f);
  f.dependencies.applyNativeHistory = () => { throw new Error("publisher returned late failure"); };
  delete f.dependencies.inspectPublishedRegistration;
  await assert.rejects(runNativeHistoryActivation(f.context, f.dependencies), /publisher returned late failure/);
  assert.equal(f.events.includes("registration.archive"), true);
  assert.equal(f.events.includes("injected.rollback"), true);
  assert.equal(f.journals.at(-1)?.phase, "rolled-back");
});

test("production broker proof binds the private socket, sealed argv, config digest, and app ancestry", async (t) => {
  const f = activationFixture(t);
  const { configSha256 } = writePublishedRegistrationFixture(f);
  const socketPath = routerControlSocketPath(f.context.roots.globalRoot, "accounts-broker.v1.sock");
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, () => resolvePromise());
  });
  chmodSync(socketPath, 0o600);
  try {
    const configPath = join(f.context.roots.globalRoot, "account-router-config.json");
    const brokerHost = f.context.manager.runtime.brokerHost.path;
    const appServer = join(dirname(brokerHost), "broker-app-server.js");
    const tail = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT app-server";
    const identity = observeNativeHistoryActivationBroker(f.context, {
      verifyRuntime: () => {},
      socketOwnerPids: () => [301],
      participatingAppPids: () => [100],
      processes: () => [
        { pid: 1, ppid: 0, processStartToken: "system-start", command: "/sbin/launchd" },
        { pid: 301, ppid: 300, processStartToken: "broker-start", command: `/sealed/node ${brokerHost} --config ${configPath} --state-root ${f.context.roots.globalRoot} -- ${tail}` },
        { pid: 300, ppid: 100, processStartToken: "bridge-start", command: `/sealed/node ${appServer} --config ${configPath} --state-root ${f.context.roots.globalRoot} -- ${tail}` },
        { pid: 100, ppid: 1, processStartToken: "desktop-start", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
      ],
    });
    assert.equal(identity.pid, 301);
    assert.equal(identity.socketPath, socketPath);
    assert.equal(identity.configSha256, configSha256);
    assert.equal(identity.parentPid, 300);
    for (const invalidParent of [-1, 0.5, "0"]) {
      assert.throws(() => observeNativeHistoryActivationBroker(f.context, {
        verifyRuntime: () => {},
        socketOwnerPids: () => [301],
        participatingAppPids: () => [100],
        processes: () => [
          { pid: 1, ppid: invalidParent as number, processStartToken: "system-start", command: "/sbin/launchd" },
        ],
      }), /broker process census is unavailable/);
    }
    assert.throws(() => observeNativeHistoryActivationBroker(f.context, {
      verifyRuntime: () => {},
      socketOwnerPids: () => [301],
      participatingAppPids: () => [100],
      processes: () => [
        { pid: 301, ppid: 300, processStartToken: "broker-start", command: `/sealed/node --require /tmp/foreign ${brokerHost} --config ${configPath} --state-root ${f.context.roots.globalRoot} -- ${tail}` },
        { pid: 300, ppid: 100, processStartToken: "bridge-start", command: `/sealed/node ${appServer} --config ${configPath} --state-root ${f.context.roots.globalRoot} -- ${tail}` },
        { pid: 100, ppid: 1, processStartToken: "desktop-start", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
      ],
    }), /unsafe broker process command/);
    f.context.activationScope = "tweakers-only";
    const installedBrokerHost = join(f.context.tweakers.userRoot, "runtime", "account-router", "broker-host.js");
    const installedAppServer = join(dirname(installedBrokerHost), "broker-app-server.js");
    const installedProcesses = [
      { pid: 1, ppid: 0, processStartToken: "system-start", command: "/sbin/launchd" },
      { pid: 301, ppid: 300, processStartToken: "broker-start", command: `/sealed/node ${installedBrokerHost} --config ${configPath} --state-root ${f.context.roots.globalRoot} -- ${tail}` },
      { pid: 300, ppid: 200, processStartToken: "bridge-start", command: `/sealed/node ${installedAppServer} --config ${configPath} --state-root ${f.context.roots.globalRoot} -- ${tail}` },
      { pid: 200, ppid: 1, processStartToken: "tweakers-start", command: "/Applications/Tweakers.app/Contents/MacOS/Tweakers Electron" },
      { pid: 100, ppid: 1, processStartToken: "native-start", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
    ];
    const installedDependencies = {
      verifyRuntime: () => {},
      socketOwnerPids: () => [301],
      participatingAppPids: () => [200],
      processes: () => installedProcesses,
    };
    assert.equal(observeNativeHistoryActivationBroker(f.context, installedDependencies).brokerHostPath, installedBrokerHost);
    assert.throws(() => observeNativeHistoryActivationBroker(f.context, {
      ...installedDependencies, participatingAppPids: () => [100],
    }), /no participating app ancestry/);
    assert.throws(() => observeNativeHistoryActivationBroker(f.context, {
      ...installedDependencies,
      processes: () => installedProcesses.map((entry) => ({
        ...entry, command: entry.command.replace(installedBrokerHost, brokerHost),
      })),
    }), /exact sealed broker argv/);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
});

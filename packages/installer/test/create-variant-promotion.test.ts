import assert from "node:assert/strict";
import asar from "@electron/asar";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readPlist, writePlist } from "../src/plist";
import {
  TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
  TWEAKERS_VARIANT_BUNDLE_ID,
  TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
  TWEAKERS_VARIANT_DOCK_ICON_FILES,
  TWEAKERS_VARIANT_ICON_FILE,
  TWEAKERS_VARIANT_ICON_SOURCE,
  TWEAKERS_VARIANT_PNG_SOURCE,
  TWEAKERS_VARIANT_PRODUCT_NAME,
  TWEAKERS_VARIANT_USER_DATA_CONFIG,
  TWEAKERS_ORIGINAL_EXECUTABLE,
  type MacAppIdentity,
} from "../src/macos-variant";
import {
  createTweakersVariant,
  INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND,
  INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
  INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
  prepareDeferredTweakersVariantRefresh,
  prepareDeferredTweakersRuntimeRepair,
  readTweakersRuntimeRepairHead,
  fingerprintVariantGeneration,
  recoverInterruptedTweakersVariantPromotions,
  refreshTweakersVariant,
  verifyIndependentTweakersRuntimeReadyReceipt,
  verifyTweakersVariantCandidateReceipt,
  VariantPrePromotionAbortedError,
} from "../src/commands/create-variant";
import type { UserPaths } from "../src/paths";
import type { EnvironmentModePairReceipt } from "../src/environment-mode-cache";
import { managerStatusPaths } from "../src/manager-status";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint";
import { assertTweakersVariantBootstrap } from "../../runtime/src/desktop-update-startup";

const BUNDLED_TWEAK_IDS = [
  "co.tweakers.account-switcher",
  "co.tweakers.appshots",
  "co.tweakers.developer-tools",
  "co.tweakers.followup",
  "co.tweakers.projects",
  "co.tweakers.shadcn-codex-ui",
  "co.tweakers.thread-summary-profiles",
  "co.tweakers.titlebar-controls",
  "co.tweakers.ui-improvements",
  "co.tweakers.usage-limit-resets-tracker",
  "co.tweakers.user-questions",
];

test("runtime-ready proof binds process identity, Settings mount, exact broker authority, Actual Size, and the complete tweak set", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brokerRoot = join(root, "broker");
  const authority = writeRuntimeReadyBroker(brokerRoot);
  const hash = "a".repeat(64);
  const expectation = {
    schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
    kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND,
    operationId: "runtime-proof",
    promotionId: "promotion-proof",
    activePromotionReceiptSha256: hash,
    appRoot: "/Applications/Tweakers.app",
    bundleId: TWEAKERS_VARIANT_BUNDLE_ID,
    appAsarHeaderHash: hash,
    runtimeFingerprint: hash,
    appUserDataRoot: "/Users/fixture/Library/Application Support/Tweakers/variants/tweakers/app-data",
    codexHomeRoot: "/Users/fixture/Library/Application Support/Tweakers/variants/tweakers/codex-home",
    accountsBrokerRoot: brokerRoot,
    brokerAuthorityExpectation: authority,
    appearanceExpectation: { status: "normal" as const, normalized: true as const },
    expectedTweakIds: BUNDLED_TWEAK_IDS,
    createdAt: "2026-09-03T12:00:00.000Z",
  } as const;
  const receipt = {
    schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
    kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
    operationId: expectation.operationId,
    promotionId: expectation.promotionId,
    activePromotionReceiptSha256: expectation.activePromotionReceiptSha256,
    pid: 513,
    processStartToken: "Thu Sep  3 08:00:00 2026",
    appRoot: expectation.appRoot,
    bundleId: expectation.bundleId,
    appAsarHeaderHash: hash,
    runtimeFingerprint: hash,
    appUserDataRoot: expectation.appUserDataRoot,
    codexHomeRoot: expectation.codexHomeRoot,
    accountsBrokerRoot: expectation.accountsBrokerRoot,
    brokerAuthorityExpectation: expectation.brokerAuthorityExpectation,
    appearance: expectation.appearanceExpectation,
    mainInitialized: true,
    preloadInitialized: true,
    settingsMounted: true,
    sharedHistoryBrokerState: "connected" as const,
    initializedTweakIds: [...BUNDLED_TWEAK_IDS].reverse(),
    observedAt: "2026-09-03T12:00:01.000Z",
  } as const;

  assert.doesNotThrow(() => verifyIndependentTweakersRuntimeReadyReceipt(
    expectation,
    receipt,
    receipt.pid,
    receipt.processStartToken,
  ));
  assert.throws(
    () => verifyIndependentTweakersRuntimeReadyReceipt(expectation, { ...receipt, sharedHistoryBrokerState: "blocked" }, receipt.pid, receipt.processStartToken),
    /broker authority/,
  );
  assert.throws(
    () => verifyIndependentTweakersRuntimeReadyReceipt(expectation, receipt, receipt.pid, "different-start"),
    /does not match the prepared operation/,
  );
  assert.throws(
    () => verifyIndependentTweakersRuntimeReadyReceipt(expectation, { ...receipt, settingsMounted: false }, receipt.pid, receipt.processStartToken),
    /invalid schema/,
  );
  for (const appearance of [
    undefined,
    { status: "needs_attention", normalized: true },
    { status: "not_observed", normalized: true },
    { status: "error", normalized: true },
    { status: "normal", normalized: false },
  ]) {
    assert.throws(
      () => verifyIndependentTweakersRuntimeReadyReceipt(
        expectation,
        { ...receipt, appearance },
        receipt.pid,
        receipt.processStartToken,
      ),
      /invalid schema/,
    );
  }
  assert.throws(
    () => verifyIndependentTweakersRuntimeReadyReceipt(
      expectation,
      { ...receipt, initializedTweakIds: BUNDLED_TWEAK_IDS.slice(1) },
      receipt.pid,
      receipt.processStartToken,
    ),
    /invalid schema/,
  );
});

test("runtime-ready proof requires the prepared global-v3 broker connection and rejects byte drift", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-broker-v3-"));
  try {
    const brokerRoot = join(root, "broker");
    mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
    const config = runtimeReadyBrokerV3Config();
    const configBytes = `${JSON.stringify(config)}\n`;
    writeFileSync(join(brokerRoot, "account-router-config.json"), configBytes, { mode: 0o600 });
    writeFileSync(join(brokerRoot, "control-secret.v1"), Buffer.alloc(32, 17), { mode: 0o600 });
    const hash = "a".repeat(64);
    const expectation = {
      schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
      kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_EXPECTATION_KIND,
      operationId: "runtime-v3-proof",
      promotionId: "promotion-v3-proof",
      activePromotionReceiptSha256: hash,
      appRoot: join(root, "Tweakers.app"),
      bundleId: TWEAKERS_VARIANT_BUNDLE_ID,
      appAsarHeaderHash: hash,
      runtimeFingerprint: hash,
      appUserDataRoot: join(root, "app-data"),
      codexHomeRoot: join(root, "codex-home"),
      accountsBrokerRoot: brokerRoot,
      brokerAuthorityExpectation: {
        globalRootState: "valid-v3" as const,
        configSha256: createHash("sha256").update(configBytes).digest("hex"),
      },
      appearanceExpectation: { status: "normal" as const, normalized: true as const },
      expectedTweakIds: BUNDLED_TWEAK_IDS,
      createdAt: "2026-09-04T12:00:00.000Z",
    } as const;
    const receipt = {
      schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
      kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
      operationId: expectation.operationId,
      promotionId: expectation.promotionId,
      activePromotionReceiptSha256: hash,
      pid: 513,
      processStartToken: "Thu Sep  4 12:00:00 2026",
      appRoot: expectation.appRoot,
      bundleId: expectation.bundleId,
      appAsarHeaderHash: hash,
      runtimeFingerprint: hash,
      appUserDataRoot: expectation.appUserDataRoot,
      codexHomeRoot: expectation.codexHomeRoot,
      accountsBrokerRoot: brokerRoot,
      brokerAuthorityExpectation: expectation.brokerAuthorityExpectation,
      appearance: expectation.appearanceExpectation,
      mainInitialized: true,
      preloadInitialized: true,
      settingsMounted: true,
      sharedHistoryBrokerState: "connected" as const,
      initializedTweakIds: BUNDLED_TWEAK_IDS,
      observedAt: "2026-09-04T12:00:01.000Z",
    } as const;
    assert.doesNotThrow(() => verifyIndependentTweakersRuntimeReadyReceipt(
      expectation, receipt, receipt.pid, receipt.processStartToken,
    ));
    assert.throws(
      () => verifyIndependentTweakersRuntimeReadyReceipt(expectation, { ...receipt, sharedHistoryBrokerState: "blocked" }, receipt.pid, receipt.processStartToken),
      /broker authority/,
    );
    writeFileSync(join(brokerRoot, "account-router-config.json"), `\n${configBytes}`, { mode: 0o600 });
    assert.throws(
      () => verifyIndependentTweakersRuntimeReadyReceipt(expectation, receipt, receipt.pid, receipt.processStartToken),
      /broker authority/,
      "a byte-level config change between prepare and receipt must fail",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing registration stops promotion before replacing the existing app or publishing its manager", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-missing-accounts-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createFixture(root, "missing-accounts");
  const before = activeGenerationSnapshot(fixture);
  const brokerRoot = join(root, "Library", "Application Support", "Tweakers", "tweak-data", "co.tweakers.account-switcher");
  rmSync(brokerRoot, { recursive: true });
  const promotions: string[] = [];
  await assert.rejects(refreshTweakersVariant({
    source: fixture.source, app: fixture.target, userRoot: fixture.userRoot,
  }, {
    ...fixture.deps,
    fault: (point) => { promotions.push(point); },
  }), /Shared account setup is incomplete/);
  assert.deepEqual(activeGenerationSnapshot(fixture), before);
  assert.equal(promotions.some((point) => point.startsWith("promotion:")), false);
  assert.equal(existsSync(brokerRoot), false);
});

test("activation can stage a candidate before registration but must publish registration before promotion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-staged-accounts-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createFixture(root, "staged-accounts");
  const brokerRoot = join(root, "Library", "Application Support", "Tweakers", "tweak-data", "co.tweakers.account-switcher");
  rmSync(brokerRoot, { recursive: true });
  let prepared = false;
  await withoutVariantStatusOutput(() => refreshTweakersVariant({
    source: fixture.source, app: fixture.target, userRoot: fixture.userRoot,
  }, {
    ...fixture.deps,
    beforePromotion: ({ candidate }) => {
      assert.equal(readFileSync(join(candidate, "Contents", "MacOS", "ChatGPT"), "utf8"), "candidate-launcher");
      assert.equal(existsSync(join(fixture.target, "old-app")), true);
      assert.equal(existsSync(brokerRoot), false);
      writeRuntimeReadyBroker(brokerRoot);
      prepared = true;
    },
  }));
  assert.equal(prepared, true);
  assertNewActiveGeneration(fixture, "staged-accounts");
});

test("verified runtime-ready evidence keeps its challenge through the pre-commit interruption window", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-interruption-"));
  try {
    const fixture = createFixture(root, "runtime-ready-interruption");
    const oldGeneration = activeGenerationSnapshot(fixture);
    const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      runtimeReadyOperationId: "manager-operation",
    }, {
      ...fixture.deps,
      installApp: installRuntimeReadyCandidateFixture,
    }));
    const expectation = deferred.runtimeReadyExpectation;
    assert.deepEqual(expectation.appearanceExpectation, { status: "normal", normalized: true });
    const expectationPath = join(fixture.userRoot, "runtime-ready-expectation.json");
    const receipt = {
      schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
      kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
      operationId: expectation.operationId,
      promotionId: expectation.promotionId,
      activePromotionReceiptSha256: expectation.activePromotionReceiptSha256,
      pid: 513,
      processStartToken: "Thu Sep  3 08:00:00 2026",
      appRoot: expectation.appRoot,
      bundleId: expectation.bundleId,
      appAsarHeaderHash: expectation.appAsarHeaderHash,
      runtimeFingerprint: expectation.runtimeFingerprint,
      appUserDataRoot: expectation.appUserDataRoot,
      codexHomeRoot: expectation.codexHomeRoot,
      accountsBrokerRoot: expectation.accountsBrokerRoot,
      brokerAuthorityExpectation: expectation.brokerAuthorityExpectation,
      appearance: expectation.appearanceExpectation,
      mainInitialized: true,
      preloadInitialized: true,
      settingsMounted: true,
      sharedHistoryBrokerState: "connected" as const,
      initializedTweakIds: [...expectation.expectedTweakIds],
      observedAt: "2026-09-03T12:00:01.000Z",
    };

    deferred.verifyRuntimeReady(receipt, receipt.pid, receipt.processStartToken);

    assert.equal(existsSync(expectationPath), true, "verification alone must not consume the manager challenge");
    assert.doesNotThrow(() => assertTweakersVariantBootstrap({
      environment: {
        TWEAKERS_DERIVED_VARIANT: "1",
        TWEAKERS_USER_ROOT: fixture.userRoot,
        TWEAKERS_RUNTIME: join(fixture.userRoot, "runtime"),
      },
      resourcesPath: join(fixture.target, "Contents", "Resources"),
    }), "the exact provisional generation remains launchable after a manager interruption");

    deferred.rollback();
    assert.equal(existsSync(expectationPath), false);
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forward runtime repair retains the provisional app, resumes a swap, and requires fresh readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-repair-"));
  try {
    const fixture = createFixture(root, "forward-repair");
    const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
      source: fixture.source, app: fixture.target, userRoot: fixture.userRoot, runtimeReadyOperationId: "old-operation",
    }, { ...fixture.deps, installApp: installRuntimeReadyCandidateFixture }));
    const oldExpectation = deferred.runtimeReadyExpectation;
    deferred.retain();
    const journalPath = join(fixture.userRoot, "transactions", "variant-promotion", "forward-repair.json");
    const originalJournal = readFileSync(journalPath);
    const appBefore = fingerprintVariantGeneration(fixture.target);
    const sourceRuntimeRoot = join(root, "repaired-runtime");
    cpSync(join(fixture.userRoot, "runtime"), sourceRuntimeRoot, { recursive: true });
    writeFileSync(join(sourceRuntimeRoot, "main.js"), "fixed startup handshake\n");
    writeFileSync(join(sourceRuntimeRoot, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(sourceRuntimeRoot) }));
    const options = {
      userRoot: fixture.userRoot, target: fixture.target, pendingPromotionId: "forward-repair",
      expectedJournalSha256: createHash("sha256").update(originalJournal).digest("hex"), operationId: "repair-operation",
      sourceRuntimeRoot, expectedSourceRuntimeFingerprint: fingerprintVariantGeneration(sourceRuntimeRoot),
    };
    assert.throws(() => prepareDeferredTweakersRuntimeRepair({ ...options, expectedJournalSha256: "a".repeat(64) }, fixture.deps), /journal drift/);
    assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, { ...fixture.deps, targetProcessRunning: () => true }), /target app.*running/);
    writeFileSync(join(sourceRuntimeRoot, "drift"), "unexpected");
    assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, fixture.deps), /fingerprint/);
    rmSync(join(sourceRuntimeRoot, "drift"));
    assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, {
      ...fixture.deps, fault(point) { if (point === "runtime-repair:old-runtime-retained") throw new Error("interrupted swap"); },
    }), /interrupted swap/);
    assert.equal(existsSync(join(fixture.userRoot, "runtime")), false);
    const repairRoot = join(fixture.userRoot, "builds", "forward-repair", "runtime-repair", "operations", "repair-operation");
    assert.equal(existsSync(join(repairRoot, "prior-runtime", "main.js")), true);
    assert.equal(existsSync(join(repairRoot, "next-runtime", "main.js")), true);
    assert.throws(() => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps), /forward runtime repair/);
    assert.throws(() => prepareDeferredTweakersRuntimeRepair({ ...options, operationId: "different-operation" }, fixture.deps), /prior repair fingerprint/);
    const repaired = prepareDeferredTweakersRuntimeRepair(options, fixture.deps);
    assert.deepEqual(fingerprintVariantGeneration(fixture.target), appBefore);
    assert.equal(readFileSync(join(fixture.userRoot, "runtime", "main.js"), "utf8"), "fixed startup handshake\n");
    assert.throws(() => repaired.commit(), /accepted fresh runtime-ready/);
    const expectation = repaired.runtimeReadyExpectation;
    assert.notEqual(expectation.runtimeFingerprint, oldExpectation.runtimeFingerprint);
    assert.notEqual(expectation.activePromotionReceiptSha256, oldExpectation.activePromotionReceiptSha256);
    const receipt = {
      ...expectation, kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND, pid: 515,
      processStartToken: "Thu Sep  3 08:00:01 2026", appearance: expectation.appearanceExpectation,
      mainInitialized: true, preloadInitialized: true, settingsMounted: true, sharedHistoryBrokerState: "connected",
      initializedTweakIds: [...expectation.expectedTweakIds], observedAt: "2026-09-03T12:00:02.000Z",
    } as Record<string, unknown>;
    delete receipt.appearanceExpectation; delete receipt.expectedTweakIds; delete receipt.createdAt;
    assert.throws(() => repaired.verifyRuntimeReady({ ...receipt, operationId: oldExpectation.operationId }, 515, receipt.processStartToken as string), /receipt/);
    repaired.verifyRuntimeReady(receipt, 515, receipt.processStartToken as string);
    repaired.commit();
    assert.equal(readJournalPhase(fixture, "forward-repair"), "committed");
    assert.deepEqual(fingerprintVariantGeneration(fixture.target), appBefore);
    assert.equal(existsSync(join(repairRoot, "prior-runtime", "main.js")), true);
    assert.equal(existsSync(join(repairRoot, "intent.json")), true);
    assert.equal(existsSync(join(fixture.userRoot, "runtime-ready-expectation.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("successive runtime repairs chain legacy and v2 evidence without overwriting prior generations", async () => {
  for (const legacy of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-successive-repair-"));
    try {
      const fixture = createFixture(root, "successive-repair");
      const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
        source: fixture.source, app: fixture.target, userRoot: fixture.userRoot, runtimeReadyOperationId: "original-operation",
      }, { ...fixture.deps, installApp: installRuntimeReadyCandidateFixture }));
      deferred.retain();
      const journalPath = join(fixture.userRoot, "transactions", "variant-promotion", "successive-repair.json");
      const appBefore = fingerprintVariantGeneration(fixture.target);
      const firstSource = join(root, "first-runtime");
      cpSync(join(fixture.userRoot, "runtime"), firstSource, { recursive: true });
      writeFileSync(join(firstSource, "main.js"), "first repair\n");
      writeFileSync(join(firstSource, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(firstSource) }));
      const binding = { userRoot: fixture.userRoot, target: fixture.target, pendingPromotionId: "successive-repair" };
      const firstOptions = { ...binding, operationId: "first-repair", sourceRuntimeRoot: firstSource,
        expectedJournalSha256: createHash("sha256").update(readFileSync(journalPath)).digest("hex"),
        expectedSourceRuntimeFingerprint: fingerprintVariantGeneration(firstSource) };
      const first = prepareDeferredTweakersRuntimeRepair(firstOptions, fixture.deps);
      const firstExpectation = first.runtimeReadyExpectation;
      first.retain();
      const chainRoot = join(fixture.userRoot, "builds", "successive-repair", "runtime-repair");
      let firstRoot = join(chainRoot, "operations", "first-repair");
      if (legacy) {
        // Reproduce the already-shipped v1 layout before testing its import.
        const intent = JSON.parse(readFileSync(join(firstRoot, "intent.json"), "utf8"));
        intent.version = 1; delete intent.priorRepairFingerprint;
        writeFileSync(join(firstRoot, "intent.json"), `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
        for (const name of readdirSync(firstRoot)) renameSync(join(firstRoot, name), join(chainRoot, name));
        rmSync(join(chainRoot, "operations"), { recursive: true });
        firstRoot = chainRoot;
      }
      const priorIntentBytes = readFileSync(join(firstRoot, "intent.json"));
      const priorRuntimeFingerprint = fingerprintVariantGeneration(join(firstRoot, "prior-runtime"));
      const priorHead = readTweakersRuntimeRepairHead(binding)!;
      assert.equal(priorHead.version, legacy ? 1 : 2);
      assert.equal(priorHead.fingerprint, createHash("sha256").update(priorIntentBytes).digest("hex"));
      const secondSource = join(root, "second-runtime");
      cpSync(firstSource, secondSource, { recursive: true });
      writeFileSync(join(secondSource, "main.js"), "second repair\n");
      writeFileSync(join(secondSource, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(secondSource) }));
      const secondOptions = { ...binding, operationId: "second-repair", sourceRuntimeRoot: secondSource,
        expectedJournalSha256: createHash("sha256").update(readFileSync(journalPath)).digest("hex"),
        expectedSourceRuntimeFingerprint: fingerprintVariantGeneration(secondSource), expectedPriorRepairFingerprint: priorHead.fingerprint };
      assert.throws(() => prepareDeferredTweakersRuntimeRepair({ ...secondOptions, expectedPriorRepairFingerprint: "0".repeat(64) }, fixture.deps), /prior repair fingerprint/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(secondOptions, { ...fixture.deps, targetProcessRunning: () => true }), /target app.*running/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(secondOptions, {
        ...fixture.deps, fault(point) { if (point === "runtime-repair:before-intent-publication") throw new Error("intent publication interrupted"); },
      }), /intent publication interrupted/);
      assert.throws(() => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps), /forward runtime repair/);
      assert.equal(readTweakersRuntimeRepairHead(binding)?.fingerprint, priorHead.fingerprint);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(secondOptions, {
        ...fixture.deps, fault(point) { if (point === "runtime-repair:old-runtime-retained") throw new Error("second swap interrupted"); },
      }), /second swap interrupted/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(firstOptions, fixture.deps), /superseded/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair({ ...secondOptions, expectedPriorRepairFingerprint: "1".repeat(64) }, fixture.deps), /exact request/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair({ ...secondOptions, expectedJournalSha256: "2".repeat(64) }, fixture.deps), /exact request/);
      const second = prepareDeferredTweakersRuntimeRepair(secondOptions, fixture.deps);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(secondOptions, fixture.deps), /transaction.*active/);
      const secondRoot = join(chainRoot, "operations", "second-repair");
      assert.deepEqual(fingerprintVariantGeneration(join(secondRoot, "prior-runtime")), firstOptions.expectedSourceRuntimeFingerprint);
      assert.deepEqual(readFileSync(join(firstRoot, "intent.json")), priorIntentBytes);
      assert.deepEqual(fingerprintVariantGeneration(join(firstRoot, "prior-runtime")), priorRuntimeFingerprint);
      assert.throws(() => second.commit(), /accepted fresh runtime-ready/);
      const expectation = second.runtimeReadyExpectation;
      const receipt: Record<string, unknown> = { ...expectation, kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
        pid: 516, processStartToken: "Thu Sep  3 08:00:03 2026", appearance: expectation.appearanceExpectation,
        mainInitialized: true, preloadInitialized: true, settingsMounted: true, sharedHistoryBrokerState: "connected",
        initializedTweakIds: [...expectation.expectedTweakIds], observedAt: "2026-09-03T12:00:04.000Z" };
      delete receipt.appearanceExpectation; delete receipt.expectedTweakIds; delete receipt.createdAt;
      assert.throws(() => second.verifyRuntimeReady({ ...receipt, operationId: firstExpectation.operationId }, 516, receipt.processStartToken as string), /receipt/);
      second.verifyRuntimeReady(receipt, 516, receipt.processStartToken as string);
      second.commit();
      assert.deepEqual(fingerprintVariantGeneration(fixture.target), appBefore);
      assert.equal(readJournalPhase(fixture, "successive-repair"), "committed");
      assert.deepEqual(readFileSync(join(firstRoot, "intent.json")), priorIntentBytes);
      assert.deepEqual(fingerprintVariantGeneration(join(firstRoot, "prior-runtime")), priorRuntimeFingerprint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("combined forward repair resumes app, runtime and resolver transitions before fresh acceptance", async () => {
  for (const interrupted of ["resolver-blocked", "old-app-retained", "new-app-promoted", "old-runtime-retained", "resolver-published", "resolver-finished"]) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-combined-repair-"));
    try {
      const fixture = createFixture(root, "combined-repair");
      const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
        source: fixture.source, app: fixture.target, userRoot: fixture.userRoot, runtimeReadyOperationId: "initial-operation",
      }, { ...fixture.deps, installApp: async (options) => {
        await installRuntimeReadyCandidateFixture(options);
        const statePath = options.candidateContext!.paths.stateFile;
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        state.signingIdentityHash = fixture.signingHash;
        writeFileSync(statePath, `${JSON.stringify(state)}\n`);
        writeFileSync(join(options.app!, "Contents", "Resources", "codex"), "original backend\n", { mode: 0o755 });
        const framework = join(options.app!, "Contents", "Frameworks", "RepairFixture.framework");
        mkdirSync(join(framework, "Versions", "A"), { recursive: true });
        writeFileSync(join(framework, "Versions", "A", "RepairFixture"), "framework fixture\n");
        symlinkSync("A", join(framework, "Versions", "Current"));
        symlinkSync("Versions/Current/RepairFixture", join(framework, "RepairFixture"));
      } }));
      const oldExpectation = deferred.runtimeReadyExpectation;
      deferred.retain();
      const journalPath = join(fixture.userRoot, "transactions", "variant-promotion", "combined-repair.json");
      let priorRepairFingerprint: string | undefined;
      if (interrupted === "resolver-blocked") {
        const earlierSource = join(root, "earlier-runtime");
        cpSync(join(fixture.userRoot, "runtime"), earlierSource, { recursive: true });
        writeFileSync(join(earlierSource, "main.js"), "earlier runtime repair\n");
        writeFileSync(join(earlierSource, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(earlierSource) }));
        const earlier = prepareDeferredTweakersRuntimeRepair({ userRoot: fixture.userRoot, target: fixture.target,
          pendingPromotionId: "combined-repair", operationId: "earlier-operation", sourceRuntimeRoot: earlierSource,
          expectedSourceRuntimeFingerprint: fingerprintVariantGeneration(earlierSource),
          expectedJournalSha256: createHash("sha256").update(readFileSync(journalPath)).digest("hex") }, fixture.deps);
        earlier.retain();
        priorRepairFingerprint = readTweakersRuntimeRepairHead({ userRoot: fixture.userRoot, target: fixture.target, pendingPromotionId: "combined-repair" })!.fingerprint;
      }
      const oldApp = fingerprintVariantGeneration(fixture.target);
      const oldRuntime = fingerprintVariantGeneration(join(fixture.userRoot, "runtime"));
      const sourceRuntimeRoot = join(root, "next-runtime");
      const sourceAppRoot = join(root, "next-app.app");
      cpSync(join(fixture.userRoot, "runtime"), sourceRuntimeRoot, { recursive: true });
      cpSync(fixture.target, sourceAppRoot, { recursive: true, verbatimSymlinks: true });
      chmodSync(join(sourceAppRoot, "Contents", "Resources", "tweakers"), 0o700);
      writeFileSync(join(sourceRuntimeRoot, "main.js"), "combined runtime\n");
      writeFileSync(join(sourceRuntimeRoot, "runtime-fingerprint.json"), JSON.stringify({ schemaVersion: 1, ...computeRuntimeFingerprint(sourceRuntimeRoot) }));
      writeFileSync(join(sourceAppRoot, "Contents", "Resources", "codex"), "optimized backend\n");
      const resolverSha = createHash("sha256").update("optimized backend\n").digest("hex");
      const priorResolverSha = createHash("sha256").update("original backend\n").digest("hex");
      const operationId = "combined-operation";
      const options = { userRoot: fixture.userRoot, target: fixture.target, pendingPromotionId: "combined-repair", operationId,
        ...(priorRepairFingerprint ? { expectedPriorRepairFingerprint: priorRepairFingerprint } : {}),
        expectedJournalSha256: createHash("sha256").update(readFileSync(journalPath)).digest("hex"),
        sourceRuntimeRoot, expectedSourceRuntimeFingerprint: fingerprintVariantGeneration(sourceRuntimeRoot),
        combinedApp: { sourceAppRoot, expectedSourceAppFingerprint: fingerprintVariantGeneration(sourceAppRoot),
          expectedResolverBinarySha256: resolverSha, resolverPlan: { fixture: "signed-plan" }, expectedResolverPlanFingerprint: `sha256:${"a".repeat(64)}` } };
      const binding = { operationId, promotionId: options.pendingPromotionId, journalSha256: options.expectedJournalSha256,
        priorRepairFingerprint: priorRepairFingerprint ?? null, appFingerprintSha256: options.combinedApp.expectedSourceAppFingerprint.sha256,
        runtimeFingerprintSha256: options.expectedSourceRuntimeFingerprint.sha256 };
      let blocked = false; let published = false; let completed = false; let registrationDrift = false;
      const deps = { ...fixture.deps, runtimeRepairResolverPort: {
        executeSharedNativeResolverTransitionAtRootV1(input: { action: "validate" | "begin" | "publish" | "finish" }) {
          if (registrationDrift) return { state: "blocked", reason: "resolver CAS mismatch" };
          if (input.action === "begin" && !completed) blocked = true;
          if (input.action === "publish") { assert.ok(blocked || completed); published = true; }
          if (input.action === "finish") { assert.ok(published); blocked = false; completed = true; }
          return { state: { validate: "validated", begin: "begun", publish: "published", finish: "finished" }[input.action],
            binding, priorResolverBinarySha256: priorResolverSha, resolverBinarySha256: resolverSha };
        },
      } };
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, { ...deps, targetProcessRunning: () => true }), /target app.*running/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, { ...deps, verify: () => ({ ok: false, output: "bad candidate signature" }) }), /signature/);
      assert.throws(() => prepareDeferredTweakersRuntimeRepair({ ...options, combinedApp: { ...options.combinedApp, expectedResolverBinarySha256: "0".repeat(64) } }, deps), /backend fingerprint/);
      registrationDrift = true;
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, deps), /resolver CAS mismatch/);
      registrationDrift = false;
      assert.throws(() => prepareDeferredTweakersRuntimeRepair(options, { ...deps,
        fault(point) { if (point === `runtime-repair:${interrupted}`) throw new Error("combined interruption"); },
      }), /combined interruption/);
      assert.equal(blocked, interrupted !== "resolver-finished");
      assert.throws(() => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps), /forward runtime repair/);
      const repair = prepareDeferredTweakersRuntimeRepair(options, deps);
      assert.equal(blocked, false); assert.equal(published, true);
      const repairRoot = join(fixture.userRoot, "builds", "combined-repair", "runtime-repair", "operations", operationId);
      assert.deepEqual(fingerprintVariantGeneration(join(repairRoot, "prior-app.app")), oldApp);
      assert.deepEqual(fingerprintVariantGeneration(join(repairRoot, "prior-runtime")), oldRuntime);
      assert.deepEqual(fingerprintVariantGeneration(fixture.target), options.combinedApp.expectedSourceAppFingerprint);
      assert.equal(lstatSync(join(fixture.target, "Contents", "Resources", "tweakers")).mode & 0o777, 0o700);
      assert.equal(readlinkSync(join(fixture.target, "Contents", "Frameworks", "RepairFixture.framework", "Versions", "Current")), "A");
      assert.equal(readlinkSync(join(fixture.target, "Contents", "Frameworks", "RepairFixture.framework", "RepairFixture")), "Versions/Current/RepairFixture");
      assert.throws(() => repair.commit(), /accepted fresh runtime-ready/);
      const expectation = repair.runtimeReadyExpectation;
      const receipt: Record<string, unknown> = { ...expectation, kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
        pid: 518, processStartToken: "Thu Sep  3 08:00:03 2026", appearance: expectation.appearanceExpectation,
        mainInitialized: true, preloadInitialized: true, settingsMounted: true, sharedHistoryBrokerState: "connected",
        initializedTweakIds: [...expectation.expectedTweakIds], observedAt: "2026-09-03T12:00:04.000Z" };
      delete receipt.appearanceExpectation; delete receipt.expectedTweakIds; delete receipt.createdAt;
      assert.throws(() => repair.verifyRuntimeReady({ ...receipt, activePromotionReceiptSha256: oldExpectation.activePromotionReceiptSha256 }, 518, receipt.processStartToken as string), /receipt/);
      repair.verifyRuntimeReady(receipt, 518, receipt.processStartToken as string);
      repair.commit();
      assert.equal(readJournalPhase(fixture, "combined-repair"), "committed");
      assert.deepEqual(fingerprintVariantGeneration(fixture.target), options.combinedApp.expectedSourceAppFingerprint);
      assert.deepEqual(fingerprintVariantGeneration(join(repairRoot, "prior-app.app")), oldApp);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("runtime-ready commit is impossible before verification and removes the challenge only after durable commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-commit-"));
  try {
    const fixture = createFixture(root, "runtime-ready-commit");
    const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      runtimeReadyOperationId: "manager-operation",
    }, {
      ...fixture.deps,
      installApp: installRuntimeReadyCandidateFixture,
    }));
    assert.throws(() => deferred.commit(), /requires accepted runtime-ready evidence/);
    const expectation = deferred.runtimeReadyExpectation;
    const receipt = {
      schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
      kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
      operationId: expectation.operationId,
      promotionId: expectation.promotionId,
      activePromotionReceiptSha256: expectation.activePromotionReceiptSha256,
      pid: 514,
      processStartToken: "Thu Sep  3 08:00:01 2026",
      appRoot: expectation.appRoot,
      bundleId: expectation.bundleId,
      appAsarHeaderHash: expectation.appAsarHeaderHash,
      runtimeFingerprint: expectation.runtimeFingerprint,
      appUserDataRoot: expectation.appUserDataRoot,
      codexHomeRoot: expectation.codexHomeRoot,
      accountsBrokerRoot: expectation.accountsBrokerRoot,
      brokerAuthorityExpectation: expectation.brokerAuthorityExpectation,
      appearance: expectation.appearanceExpectation,
      mainInitialized: true,
      preloadInitialized: true,
      settingsMounted: true,
      sharedHistoryBrokerState: "connected" as const,
      initializedTweakIds: [...expectation.expectedTweakIds],
      observedAt: "2026-09-03T12:00:02.000Z",
    };
    deferred.verifyRuntimeReady(receipt, receipt.pid, receipt.processStartToken);
    assert.equal(existsSync(join(fixture.userRoot, "runtime-ready-expectation.json")), true);

    deferred.commit();

    assert.equal(readJournalPhase(fixture, "runtime-ready-commit"), "committed");
    assert.equal(existsSync(join(fixture.userRoot, "runtime-ready-expectation.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-commit expectation cleanup failure never rolls back the committed generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-cleanup-"));
  try {
    const fixture = createFixture(root, "runtime-ready-cleanup");
    const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      runtimeReadyOperationId: "manager-operation",
    }, {
      ...fixture.deps,
      installApp: installRuntimeReadyCandidateFixture,
      removeRuntimeReadyExpectation: () => {
        throw new Error("simulated post-commit cleanup failure");
      },
    }));
    const expectation = deferred.runtimeReadyExpectation;
    const receipt = {
      schemaVersion: INDEPENDENT_TWEAKERS_RUNTIME_READY_SCHEMA_VERSION,
      kind: INDEPENDENT_TWEAKERS_RUNTIME_READY_KIND,
      operationId: expectation.operationId,
      promotionId: expectation.promotionId,
      activePromotionReceiptSha256: expectation.activePromotionReceiptSha256,
      pid: 515,
      processStartToken: "Thu Sep  3 08:00:02 2026",
      appRoot: expectation.appRoot,
      bundleId: expectation.bundleId,
      appAsarHeaderHash: expectation.appAsarHeaderHash,
      runtimeFingerprint: expectation.runtimeFingerprint,
      appUserDataRoot: expectation.appUserDataRoot,
      codexHomeRoot: expectation.codexHomeRoot,
      accountsBrokerRoot: expectation.accountsBrokerRoot,
      brokerAuthorityExpectation: expectation.brokerAuthorityExpectation,
      appearance: expectation.appearanceExpectation,
      mainInitialized: true,
      preloadInitialized: true,
      settingsMounted: true,
      sharedHistoryBrokerState: "connected" as const,
      initializedTweakIds: [...expectation.expectedTweakIds],
      observedAt: "2026-09-03T12:00:03.000Z",
    };
    deferred.verifyRuntimeReady(receipt, receipt.pid, receipt.processStartToken);

    let warning = "";
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => { warning = values.map(String).join(" "); };
    try {
      assert.doesNotThrow(() => deferred.commit());
    } finally {
      console.warn = originalWarn;
    }

    assert.match(warning, /stale runtime-ready challenge could not be removed/);
    assert.equal(readJournalPhase(fixture, "runtime-ready-cleanup"), "committed");
    assert.equal(existsSync(join(fixture.userRoot, "runtime-ready-expectation.json")), true);
    assertNewActiveGeneration(fixture, "runtime-ready-cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface CandidateInstallOptions {
  app?: string;
  macAppIdentity?: MacAppIdentity;
  candidateContext?: { paths: UserPaths };
  preparedSigningIdentity?: { hash: string };
}

interface PromotionFixture {
  source: string;
  target: string;
  userRoot: string;
  managerRoot: string;
  managerPublications: string[];
  managerEnvironmentBootstraps: Array<{ sourceRoot: string; destinationRoot: string }>;
  officialApp: string;
  signingHash: string;
  deps: Parameters<typeof refreshTweakersVariant>[1];
}

type Snapshot =
  | { type: "file"; mode: number; bytes: string }
  | { type: "symlink"; mode: number; target: string }
  | { type: "directory"; mode: number; entries: Record<string, Snapshot> };

function stageBundledTweaksFixture(root: string): void {
  for (const id of BUNDLED_TWEAK_IDS) {
    const tweak = join(root, id);
    mkdirSync(tweak, { recursive: true });
    writeFileSync(join(tweak, "manifest.json"), `${JSON.stringify({ id })}\n`);
  }
}

function installCandidateFixture(options: CandidateInstallOptions): void {
  const candidate = options.app!;
  const paths = options.candidateContext!.paths;
  const identity = options.macAppIdentity!;
  mkdirSync(paths.runtime, { recursive: true });
  writeFileSync(join(paths.runtime, "main.js"), "fixture runtime\n");
  const runtimeFingerprint = computeRuntimeFingerprint(paths.runtime);
  writeFileSync(join(paths.runtime, "runtime-fingerprint.json"), `${JSON.stringify({
    schemaVersion: 1,
    ...runtimeFingerprint,
  })}\n`);
  mkdirSync(paths.tweaks, { recursive: true });
  mkdirSync(join(candidate, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(candidate, "Contents", "MacOS"), { recursive: true });
  writePlist(join(candidate, "Contents", "Info.plist"), {
    CFBundleIdentifier: TWEAKERS_VARIANT_BUNDLE_ID,
    CFBundleName: "Tweakers",
    CFBundleDisplayName: "Tweakers",
    CFBundleExecutable: "ChatGPT",
    CrProductDirName: TWEAKERS_VARIANT_PRODUCT_NAME,
    BundleSigningBaseName: "Tweakers",
    TweakersOriginalExecutable: TWEAKERS_ORIGINAL_EXECUTABLE,
    LSEnvironment: {
      CODEX_ELECTRON_USER_DATA_PATH: identity.appUserDataRoot,
      CODEX_HOME: identity.codexHomeRoot,
      CODEX_SQLITE_HOME: identity.codexHomeRoot,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      TWEAKERS_ACCOUNTS_BROKER_ROOT: identity.accountsBrokerRoot,
      TWEAKER_ACCOUNTS_BROKER_ROOT: identity.accountsBrokerRoot,
      TWEAKERS_DERIVED_VARIANT: "1",
    },
    CFBundleIconFile: TWEAKERS_VARIANT_ICON_FILE,
    CFBundleURLTypes: [{ CFBundleURLName: "Tweakers", CFBundleURLSchemes: ["tweakers"] }],
    SUEnableAutomaticChecks: false,
    SUAutomaticallyUpdate: false,
  });
  writeFileSync(join(candidate, "Contents", "MacOS", "ChatGPT"), "candidate-launcher", { mode: 0o755 });
  writeFileSync(join(candidate, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE), "candidate-electron", { mode: 0o755 });
  const launcherConfig = join(candidate, "Contents", "Resources", "tweakers");
  mkdirSync(launcherConfig, { recursive: true, mode: 0o700 });
  chmodSync(launcherConfig, 0o700);
  for (const [relativePath, value] of [
    [TWEAKERS_VARIANT_USER_DATA_CONFIG, identity.appUserDataRoot],
    [TWEAKERS_VARIANT_CODEX_HOME_CONFIG, identity.codexHomeRoot],
    [TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG, identity.accountsBrokerRoot],
  ] as const) {
    const path = join(candidate, "Contents", "Resources", relativePath);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  writeFileSync(
    join(candidate, "Contents", "Resources", TWEAKERS_VARIANT_ICON_FILE),
    readFileSync(TWEAKERS_VARIANT_ICON_SOURCE),
  );
  for (const name of TWEAKERS_VARIANT_DOCK_ICON_FILES) {
    writeFileSync(join(candidate, "Contents", "Resources", name), readFileSync(TWEAKERS_VARIANT_PNG_SOURCE));
  }
  writeFileSync(paths.stateFile, `${JSON.stringify({
    appRoot: candidate,
    watcher: "none",
    signingMode: "local-identity",
    signingIdentity: "Tweakers Local Signing",
    signingIdentityHash: options.preparedSigningIdentity?.hash,
    codexBundleId: TWEAKERS_VARIANT_BUNDLE_ID,
  })}\n`);
}

async function installRuntimeReadyCandidateFixture(options: CandidateInstallOptions): Promise<void> {
  installCandidateFixture(options);
  await asar.createPackage(
    options.candidateContext!.paths.runtime,
    join(options.app!, "Contents", "Resources", "app.asar"),
  );
}

function createFixture(root: string, id = "crash-fixture"): PromotionFixture {
  const source = join(root, "ChatGPT.app");
  const target = join(root, "Tweakers.app");
  const managerRoot = join(root, "Library", "Application Support", "Tweakers");
  writeRuntimeReadyBroker(join(managerRoot, "tweak-data", "co.tweakers.account-switcher"));
  const userRoot = join(managerRoot, "variants", "tweakers");
  const officialApp = join(root, "Official ChatGPT.app");
  const signingHash = "A".repeat(40);
  const signedReceiptBytes: Buffer[] = [];
  const managerPublications: string[] = [];
  const managerEnvironmentBootstraps: Array<{ sourceRoot: string; destinationRoot: string }> = [];
  mkdirSync(join(source, "Contents"), { recursive: true });
  writePlist(join(source, "Contents", "Info.plist"), { CFBundleIdentifier: "com.openai.codex" });
  mkdirSync(join(officialApp, "Contents"), { recursive: true });
  mkdirSync(target, { recursive: true });
  mkdirSync(join(userRoot, "runtime"), { recursive: true });
  mkdirSync(join(userRoot, "tweaks"), { recursive: true });
  writeFileSync(join(target, "old-app"), "old-app\n");
  writeFileSync(join(userRoot, "runtime", "old-runtime"), "old-runtime\n");
  writeFileSync(join(userRoot, "tweaks", "old-tweaks"), "old-tweaks\n");
  writeFileSync(join(userRoot, "state.json"), `${JSON.stringify({ appRoot: target, marker: "old-state" })}\n`);
  writeFileSync(join(userRoot, "config.json"), `${JSON.stringify({ marker: "old-config" })}\n`);
  return {
    source,
    target,
    userRoot,
    managerRoot,
    managerPublications,
    managerEnvironmentBootstraps,
    officialApp,
    signingHash,
    deps: {
      platform: () => "darwin",
      home: () => root,
      id: () => id,
      targetProcessRunning: () => false,
      signature: () => ({
        ok: true,
        adHoc: false,
        teamIdentifier: "2DC432GLL2",
        authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
        output: "",
      }),
      verify: () => ({ ok: true, output: "" }),
      verifyResourceAsarIntegrity: () => {},
      gatekeeper: () => ({ ok: true, output: "accepted" }),
      cloneApp: (sourcePath, candidate) => cpSync(sourcePath, candidate, { recursive: true }),
      installApp: async (options) => installCandidateFixture(options),
      stageTweaks: (tweaks) => stageBundledTweaksFixture(tweaks),
      existingSigningIdentity: () => ({ name: "Tweakers Local Signing", hash: signingHash, created: false }),
      officialAppPath: () => officialApp,
      candidateReceiptSignature: {
        sign: (bundlePath: string) => {
          const receiptPath = join(bundlePath, "Contents", "Resources", "variant-candidate-receipt.json");
          signedReceiptBytes.push(readFileSync(receiptPath));
          mkdirSync(join(bundlePath, "Contents", "_CodeSignature"), { recursive: true });
          writeFileSync(join(bundlePath, "Contents", "_CodeSignature", "CodeResources"), "fixture-signature\n");
        },
        verify: (bundlePath: string, expectedHash: string) => {
          const current = readFileSync(join(bundlePath, "Contents", "Resources", "variant-candidate-receipt.json"));
          if (expectedHash !== signingHash || !signedReceiptBytes.some((signed) => signed.equals(current))) {
            throw new Error("fixture receipt bundle strict verification failed");
          }
        },
        certificateLeafHash: () => signingHash,
      },
      managerRoot: () => managerRoot,
      environmentAuthoritySourceRoot: () => root,
      bootstrapManagerEnvironment: ({ sourceRoot, destinationRoot }) => {
        managerEnvironmentBootstraps.push({ sourceRoot, destinationRoot });
        return {
          sourceRoot,
          destinationRoot,
          registryFile: join(destinationRoot, "environment-registry.json"),
          selectionFile: join(destinationRoot, "environment-selection.json"),
          bootstrapped: true,
          restoreOnFailure: () => {},
        };
      },
      publishManagerDescriptor: ({ userRoot: publishedRoot }) => {
        managerPublications.push(publishedRoot);
        return { restoreOnFailure: () => {} };
      },
    },
  };
}

function candidateVerificationOptions(output: string, fixture: PromotionFixture): Parameters<typeof verifyTweakersVariantCandidateReceipt>[1] {
  const receiptPath = join(
    output,
    "receipt",
    "TweakersCandidateReceipt.bundle",
    "Contents",
    "Resources",
    "variant-candidate-receipt.json",
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    id: string;
    packageRoot: string;
    source: unknown;
    identity: unknown;
  };
  return {
    expectedSigningIdentityHash: fixture.signingHash,
    expectedTransactionId: receipt.id,
    expectedPackageRoot: receipt.packageRoot,
    expectedObservedPackageRoot: output,
    expectedSource: receipt.source as never,
    expectedIdentity: receipt.identity as never,
    officialAppPath: fixture.officialApp,
    verifyResourceAsarIntegrity: () => {},
    signature: (fixture.deps as {
      candidateReceiptSignature: Parameters<typeof verifyTweakersVariantCandidateReceipt>[1]["signature"];
    }).candidateReceiptSignature,
  };
}

function sealedCandidateSourceReceipt(
  source: string,
  currentFile: string,
  generationId: string,
  inactiveSeal = "b".repeat(64),
): EnvironmentModePairReceipt {
  return {
    generationId,
    paths: { currentFile, inactiveAppPath: source },
    roles: { inactive: { appPath: source } },
    seals: { inactiveApp: { sealDigest: inactiveSeal } },
  } as unknown as EnvironmentModePairReceipt;
}

function writeRuntimeReadyBroker(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(runtimeReadyBrokerV3Config())}\n`;
  writeFileSync(join(root, "account-router-config.json"), bytes, { mode: 0o600 });
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 17), { mode: 0o600 });
  return { globalRootState: "valid-v3" as const, configSha256: createHash("sha256").update(bytes).digest("hex") };
}

function runtimeReadyBrokerV3Config() {
  const account = {
    opaqueAccountId: `ar_${"a".repeat(43)}`,
    included: true,
    weight: 1,
    capabilityFingerprint: `sha256:${"b".repeat(64)}`,
    label: "Alpha",
  };
  const canonical = {
    schemaVersion: 3,
    mode: "quota_aware",
    policy: "quota_aware_v2",
    generation: 1,
    protocolFingerprint: "sha256:76eed5b646961d042d9037eb1d2c9df12a4edc71ef18580b8c99cd5176bd4f10",
    primaryOpaqueAccountId: account.opaqueAccountId,
    accounts: [account],
  };
  return {
    ...canonical,
    fingerprint: `sha256:${createHash("sha256").update(runtimeReadyCanonicalJson(canonical), "utf8").digest("hex")}`,
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function runtimeReadyCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(runtimeReadyCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${runtimeReadyCanonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshot(path: string): Snapshot {
  const stat = lstatSync(path);
  const mode = stat.mode & 0o777;
  if (stat.isFile()) {
    return { type: "file", mode, bytes: readFileSync(path).toString("base64") };
  }
  if (stat.isSymbolicLink()) return { type: "symlink", mode, target: readlinkSync(path) };
  assert.ok(stat.isDirectory(), `unsupported fixture entry: ${path}`);
  const entries: Record<string, Snapshot> = {};
  for (const entry of readdirSync(path).sort()) entries[entry] = snapshot(join(path, entry));
  return { type: "directory", mode, entries };
}

function activeGenerationSnapshot(fixture: PromotionFixture): Record<string, Snapshot | null> {
  return {
    app: snapshot(fixture.target),
    runtime: snapshot(join(fixture.userRoot, "runtime")),
    tweaks: snapshot(join(fixture.userRoot, "tweaks")),
    state: snapshot(join(fixture.userRoot, "state.json")),
    config: snapshot(join(fixture.userRoot, "config.json")),
    activeReceipt: existsSync(join(fixture.userRoot, "transactions", "variant-promotion", "active.json"))
      ? snapshot(join(fixture.userRoot, "transactions", "variant-promotion", "active.json"))
      : null,
  };
}

function readJournalPhase(fixture: PromotionFixture, id = "crash-fixture"): string {
  return (JSON.parse(readFileSync(join(fixture.userRoot, "transactions", "variant-promotion", `${id}.json`), "utf8")) as {
    phase: string;
  }).phase;
}

function assertNewActiveGeneration(fixture: PromotionFixture, id = "crash-fixture"): void {
  assert.equal(readFileSync(join(fixture.target, "Contents", "MacOS", "ChatGPT"), "utf8"), "candidate-launcher");
  assert.equal(
    readFileSync(join(fixture.target, "Contents", "MacOS", TWEAKERS_ORIGINAL_EXECUTABLE), "utf8"),
    "candidate-electron",
  );
  assert.equal(readFileSync(join(fixture.userRoot, "state.json"), "utf8").includes('"marker":"old-state"'), false);
  assert.equal(readJournalPhase(fixture, id), "committed");
  assert.doesNotThrow(() => {
    assertTweakersVariantBootstrap({
      environment: {
        TWEAKERS_DERIVED_VARIANT: "1",
        TWEAKERS_USER_ROOT: fixture.userRoot,
        TWEAKERS_RUNTIME: join(fixture.userRoot, "runtime"),
      },
      resourcesPath: join(fixture.target, "Contents", "Resources"),
    });
  });
}

async function withoutVariantStatusOutput<T>(action: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await action();
  } finally {
    console.log = original;
  }
}

async function refreshFixture(fixture: PromotionFixture): Promise<void> {
  await withoutVariantStatusOutput(() => refreshTweakersVariant({
    source: fixture.source,
    app: fixture.target,
    userRoot: fixture.userRoot,
  }, fixture.deps));
}

async function establishCommittedFixture(root: string): Promise<PromotionFixture> {
  const fixture = createFixture(root, "prior-generation");
  await refreshFixture(fixture);
  return {
    ...fixture,
    deps: {
      ...fixture.deps,
      id: () => "crash-fixture",
    },
  };
}

function variantTransactionLockPaths(fixture: PromotionFixture): { projection: string; record: string } {
  const projection = join(fixture.userRoot, "transactions", "variant-promotion.lock");
  return { projection, record: `${projection}.record` };
}

async function waitForFixtureLockOwner(
  fixture: PromotionFixture,
  ownerId = "fixture-lock-owner",
): Promise<ReturnType<typeof spawn>> {
  const { projection, record } = variantTransactionLockPaths(fixture);
  const child = spawn(process.execPath, [
    "--eval",
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const [projection, record, userRoot, target, ownerId] = process.argv.slice(1);",
      "fs.mkdirSync(path.dirname(projection), { recursive: true, mode: 0o700 });",
      'fs.writeFileSync(projection, `${process.pid}\\n`, { mode: 0o600 });',
      'fs.writeFileSync(record, `${JSON.stringify({ version: 1, userRoot, target, pid: process.pid, ownerId })}\\n`, { mode: 0o600 });',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
    projection,
    record,
    fixture.userRoot,
    fixture.target,
    ownerId,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!output.includes("ready\n")) reject(new Error(`fixture lock owner exited before ready (${code ?? signal})`));
    });
  });
  return child;
}

async function stopFixtureLockOwner(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

test("every durable promotion journal phase recovers deterministically without changing the old active generation", async () => {
  const discoveryRoot = mkdtempSync(join(tmpdir(), "tweakers-variant-phase-discovery-"));
  let phases: string[] = [];
  try {
    const discovery = createFixture(discoveryRoot, "prior-generation");
    await refreshFixture(discovery);
    await withoutVariantStatusOutput(() => refreshTweakersVariant({
      source: discovery.source,
      app: discovery.target,
      userRoot: discovery.userRoot,
    }, {
      ...discovery.deps,
      id: () => "phase-discovery",
      crashAfterJournalPhase: (phase) => {
        phases.push(phase);
        return false;
      },
    }));
    phases = [...new Set(phases)];
    assert.ok(phases.includes("prepared"));
    assert.ok(phases.includes("runtime:promoted"));
    assert.ok(phases.includes("app:promoted"));
    assert.ok(phases.includes("active:archive-planned"));
    assert.ok(phases.includes("active:archived"));
    assert.ok(phases.includes("active:promoted"));
    assert.ok(phases.includes("committed"));
  } finally {
    rmSync(discoveryRoot, { recursive: true, force: true });
  }

  for (const phase of phases) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-variant-phase-recovery-"));
    try {
      const fixture = await establishCommittedFixture(root);
      const oldGeneration = activeGenerationSnapshot(fixture);
      await assert.rejects(
        refreshTweakersVariant({
          source: fixture.source,
          app: fixture.target,
          userRoot: fixture.userRoot,
        }, {
          ...fixture.deps,
          crashAfterJournalPhase: (observed) => observed === phase,
        }),
        new RegExp(`simulated process death after durable variant-promotion phase ${phase}`),
      );
      recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps);
      if (phase === "committed") assertNewActiveGeneration(fixture);
      else {
        assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration, phase);
        assert.equal(readJournalPhase(fixture), "recovered", phase);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("deferred rollback retains runtime-mutated config and restores the prior committed config", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-config-recovery-"));
  try {
    const fixture = createFixture(root, "runtime-ready-config-recovery");
    const oldGeneration = activeGenerationSnapshot(fixture);
    const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      runtimeReadyOperationId: "manager-operation",
    }, {
      ...fixture.deps,
      installApp: installRuntimeReadyCandidateFixture,
    }));
    const mutated = `${JSON.stringify({ marker: "runtime-mutated-config" })}\n`;
    writeFileSync(join(fixture.userRoot, "config.json"), mutated, { mode: 0o600 });

    deferred.rollback();

    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
    assert.equal(readJournalPhase(fixture, "runtime-ready-config-recovery"), "recovered");
    assert.equal(
      readFileSync(join(
        fixture.userRoot,
        "builds",
        "runtime-ready-config-recovery",
        "failed-promotion",
        "state",
        "config.json",
      ), "utf8"),
      mutated,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion recovery resumes after interruption between retaining the failed app and restoring its archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-partial-recovery-resume-"));
  try {
    const fixture = createFixture(root, "partial-recovery-resume");
    const oldGeneration = activeGenerationSnapshot(fixture);
    let interruptRecovery = false;
    let interrupted = false;
    const deferred = await withoutVariantStatusOutput(() => prepareDeferredTweakersVariantRefresh({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      runtimeReadyOperationId: "manager-operation",
    }, {
      ...fixture.deps,
      installApp: installRuntimeReadyCandidateFixture,
      onDurableBoundary(path) {
        if (interruptRecovery && !interrupted && path === dirname(fixture.target)) {
          interrupted = true;
          throw new Error("simulated recovery interruption after app retain rename");
        }
      },
    }));
    interruptRecovery = true;

    assert.throws(
      () => deferred.rollback(),
      /compensating rollback was incomplete/,
    );
    assert.equal(interrupted, true);

    recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps);
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
    assert.equal(readJournalPhase(fixture, "partial-recovery-resume"), "recovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery refuses traversal records and journal-root symlinks without touching a generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-journal-rejection-"));
  try {
    const fixture = createFixture(root);
    const oldGeneration = activeGenerationSnapshot(fixture);
    await assert.rejects(
      refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, {
        ...fixture.deps,
        crashAfterJournalPhase: (phase) => phase === "prepared",
      }),
      /simulated process death/,
    );
    const journalPath = join(fixture.userRoot, "transactions", "variant-promotion", "crash-fixture.json");
    const originalJournal = readFileSync(journalPath, "utf8");
    const journal = JSON.parse(originalJournal) as { entries: Array<{ destination: string }> };
    journal.entries[0]!.destination = join(root, "outside-runtime");
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    assert.throws(
      () => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps),
      /unexpected replacement path/,
    );
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);

    writeFileSync(journalPath, "{corrupt", { mode: 0o600 });
    assert.throws(
      () => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps),
      /journal is corrupt/,
    );
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);

    writeFileSync(journalPath, originalJournal, { mode: 0o600 });
    const sibling = join(root, "sibling.json");
    writeFileSync(sibling, "{}", { mode: 0o600 });
    symlinkSync(sibling, join(fixture.userRoot, "transactions", "variant-promotion", "symlink.json"));
    assert.throws(
      () => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps),
      /unexpected entry/,
    );
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);

    rmSync(join(fixture.userRoot, "transactions", "variant-promotion", "symlink.json"), { force: true });
    const transactions = join(fixture.userRoot, "transactions");
    const relocatedTransactions = join(root, "relocated-transactions");
    renameSync(transactions, relocatedTransactions);
    symlinkSync(relocatedTransactions, transactions);
    assert.throws(
      () => recoverInterruptedTweakersVariantPromotions(fixture.userRoot, fixture.target, fixture.deps),
      /symlinked path component/,
    );
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the injectable exact-target preflight refuses promotion before its journal or live generation changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-running-target-"));
  try {
    const fixture = createFixture(root);
    const oldGeneration = activeGenerationSnapshot(fixture);
    await assert.rejects(
      refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, {
        ...fixture.deps,
        targetProcessRunning: (target) => target === fixture.target,
      }),
      /exact Tweakers target app or helper process is running/,
    );
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
    assert.equal(existsSync(join(fixture.userRoot, "transactions", "variant-promotion")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager quiescence runs only after candidate validation and immediately before the target gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-late-quiesce-"));
  try {
    const fixture = createFixture(root, "late-quiesce");
    const events: string[] = [];
    await withoutVariantStatusOutput(() => refreshTweakersVariant({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
    }, {
      ...fixture.deps,
      installApp: async (options) => {
        events.push("candidate-install");
        installCandidateFixture(options);
      },
      verifyResourceAsarIntegrity: () => {
        events.push("candidate-verified");
      },
      beforePromotion: ({ target, candidate, userRoot }) => {
        assert.equal(target, fixture.target);
        assert.equal(candidate, join(dirname(fixture.target), ".Tweakers.app.candidate-late-quiesce.app"));
        assert.equal(userRoot, fixture.userRoot);
        events.push("quiesce");
      },
      targetProcessRunning: () => {
        events.push("target-gate");
        return false;
      },
    }));

    assert.ok(events.indexOf("candidate-install") < events.indexOf("quiesce"));
    assert.ok(events.indexOf("candidate-verified") < events.indexOf("quiesce"));
    assert.equal(events[events.indexOf("quiesce") + 1], "target-gate");
    assertNewActiveGeneration(fixture, "late-quiesce");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted manager cutover proves pre-promotion recovery only after candidate archival succeeds", async (t) => {
  for (const archiveFails of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-variant-abort-proof-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = createFixture(root, "abort-proof");
    const oldGeneration = activeGenerationSnapshot(fixture);
    const cause = new Error("final writer census was not idle");
    await assert.rejects(refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, {
      ...fixture.deps,
      beforePromotion: () => { throw cause; },
      ...(archiveFails ? { archiveApp: () => { throw new Error("archive unavailable"); } } : {}),
    }), (error: unknown) => {
      if (archiveFails) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error instanceof VariantPrePromotionAbortedError, false);
      } else {
        assert.ok(error instanceof VariantPrePromotionAbortedError);
        assert.equal(error.cause, cause);
      }
      return true;
    });
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
  }
});

test("candidate build failure never invokes manager quiescence", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-no-early-quiesce-"));
  try {
    const fixture = createFixture(root, "no-early-quiesce");
    const oldGeneration = activeGenerationSnapshot(fixture);
    let quiesceCalls = 0;
    await assert.rejects(
      refreshTweakersVariant({
        source: fixture.source,
        app: fixture.target,
        userRoot: fixture.userRoot,
      }, {
        ...fixture.deps,
        installApp: async () => {
          throw new Error("simulated candidate validation failure");
        },
        beforePromotion: () => {
          quiesceCalls += 1;
        },
      }),
      /simulated candidate validation failure/,
    );
    assert.equal(quiesceCalls, 0);
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the owner-private transaction lock serializes concurrent refresh entries before a second candidate mutates", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-lock-concurrent-"));
  try {
    const fixture = createFixture(root, "lock-first");
    const oldGeneration = activeGenerationSnapshot(fixture);
    let markFirstInstall!: () => void;
    let allowFirstInstall!: () => void;
    const firstAtInstall = new Promise<void>((resolve) => { markFirstInstall = resolve; });
    const continueFirst = new Promise<void>((resolve) => { allowFirstInstall = resolve; });
    const first = withoutVariantStatusOutput(() => refreshTweakersVariant({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
    }, {
      ...fixture.deps,
      installApp: async (options) => {
        markFirstInstall();
        await continueFirst;
        installCandidateFixture(options);
      },
    }));
    await firstAtInstall;

    let secondCloneCount = 0;
    await assert.rejects(
      refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, {
        ...fixture.deps,
        id: () => "lock-second",
        cloneApp: (_source, candidate) => {
          secondCloneCount += 1;
          mkdirSync(candidate, { recursive: true });
        },
      }),
      /variant transaction is already active/,
    );
    assert.equal(secondCloneCount, 0, "the rejected contender never reached candidate creation");
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration, "the active generation stays untouched while held");
    assert.equal(existsSync(variantTransactionLockPaths(fixture).projection), true);
    assert.equal(existsSync(variantTransactionLockPaths(fixture).record), true);

    allowFirstInstall();
    await first;
    assertNewActiveGeneration(fixture, "lock-first");
    assert.equal(existsSync(variantTransactionLockPaths(fixture).projection), false);
    assert.equal(existsSync(variantTransactionLockPaths(fixture).record), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live cross-process owner blocks mutation, then a dead exact-bound owner is reclaimed safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-lock-cross-process-"));
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const fixture = createFixture(root, "lock-reclaimed");
    const oldGeneration = activeGenerationSnapshot(fixture);
    child = await waitForFixtureLockOwner(fixture);
    let cloneCount = 0;
    await assert.rejects(
      refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, {
        ...fixture.deps,
        cloneApp: (_source, candidate) => {
          cloneCount += 1;
          mkdirSync(candidate, { recursive: true });
        },
      }),
      /variant transaction is already active/,
    );
    assert.equal(cloneCount, 0, "the parent process refuses before clone while a child owns the lock");
    assert.deepEqual(activeGenerationSnapshot(fixture), oldGeneration);

    await stopFixtureLockOwner(child);
    child = null;
    await refreshFixture(fixture);
    assertNewActiveGeneration(fixture, "lock-reclaimed");
    assert.equal(existsSync(variantTransactionLockPaths(fixture).projection), false);
    assert.equal(existsSync(variantTransactionLockPaths(fixture).record), false);
  } finally {
    if (child !== null) await stopFixtureLockOwner(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt, foreign, and symlinked transaction-lock records fail closed before clone", async () => {
  const cases = ["corrupt", "foreign", "symlink"] as const;
  for (const kind of cases) {
    const root = mkdtempSync(join(tmpdir(), `tweakers-variant-lock-${kind}-`));
    try {
      const fixture = createFixture(root, `lock-${kind}`);
      const { projection, record } = variantTransactionLockPaths(fixture);
      mkdirSync(join(fixture.userRoot, "transactions"), { recursive: true, mode: 0o700 });
      if (kind === "corrupt") {
        writeFileSync(projection, `${process.pid}\n`, { mode: 0o600 });
        writeFileSync(record, "{corrupt", { mode: 0o600 });
      } else if (kind === "foreign") {
        writeFileSync(record, `${JSON.stringify({
          version: 1,
          userRoot: fixture.userRoot,
          target: join(root, "other-target.app"),
          pid: Number.MAX_SAFE_INTEGER,
          ownerId: "foreign-owner",
        })}\n`, { mode: 0o600 });
      } else {
        const outside = join(root, "outside-record.json");
        writeFileSync(outside, "{}\n", { mode: 0o600 });
        symlinkSync(outside, record);
      }
      let cloneCount = 0;
      await assert.rejects(
        refreshTweakersVariant({ source: fixture.source, app: fixture.target, userRoot: fixture.userRoot }, {
          ...fixture.deps,
          cloneApp: (_source, candidate) => {
            cloneCount += 1;
            mkdirSync(candidate, { recursive: true });
          },
        }),
        /transaction lock (?:record is corrupt|does not match|record must not be a symlink)/,
      );
      assert.equal(cloneCount, 0, `${kind} lock record must fail before clone`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("candidate-only packages a bound Tweakers identity without mutating production identity paths", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-only-")));
  try {
    const fixture = createFixture(root, "candidate-only");
    const productionAppData = join(fixture.userRoot, "app-data");
    const productionCodexHome = join(fixture.userRoot, "codex-home");
    const output = join(root, "private-candidate-package");
    const nativeDataLink = join(root, "Library", "Application Support", TWEAKERS_VARIANT_PRODUCT_NAME);
    const promotionJournal = join(fixture.userRoot, "transactions", "variant-promotion");
    mkdirSync(productionAppData, { recursive: true });
    mkdirSync(productionCodexHome, { recursive: true });
    mkdirSync(promotionJournal, { recursive: true });
    writeFileSync(join(productionAppData, "live-profile"), "live-profile\n");
    writeFileSync(join(productionCodexHome, "live-login"), "live-login\n");
    writeFileSync(join(promotionJournal, "must-not-be-recovered"), "live-transaction\n");
    const targetBefore = snapshot(fixture.target);
    const userRootBefore = snapshot(fixture.userRoot);
    let targetProcessChecks = 0;

    await withoutVariantStatusOutput(() => createTweakersVariant({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      userData: productionAppData,
      candidateOnly: true,
      output,
    }, {
      ...fixture.deps,
      targetProcessRunning: () => {
        targetProcessChecks += 1;
        return false;
      },
    }));

    assert.deepEqual(snapshot(fixture.target), targetBefore, "candidate-only must not replace the target app");
    assert.deepEqual(snapshot(fixture.userRoot), userRootBefore, "candidate-only must not write the production user root");
    assert.deepEqual(fixture.managerPublications, [], "candidate-only must not publish a manager descriptor");
    assert.deepEqual(
      fixture.managerEnvironmentBootstraps,
      [],
      "candidate-only must not publish canonical manager environment state",
    );
    assert.equal(existsSync(nativeDataLink), false, "candidate-only must not create Tweakers Desktop native-data link");
    assert.equal(targetProcessChecks, 0, "candidate-only must not inspect or operate on an installed target process");
    assert.equal(existsSync(join(output, "Tweakers.app")), true);
    assert.equal(existsSync(join(output, "runtime")), true);
    assert.equal(existsSync(join(output, "tweaks")), true);
    assert.equal(existsSync(join(output, "state.json")), true);
    assert.equal(existsSync(join(output, "config.json")), true);

    const receipt = verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture));
    assert.equal(receipt.packageRoot, output);
    assert.equal(receipt.source.path, fixture.source);
    assert.deepEqual(receipt.identity, {
      appTarget: fixture.target,
      userRoot: fixture.userRoot,
      appUserDataRoot: productionAppData,
      codexHomeRoot: productionCodexHome,
      accountsBrokerRoot: join(root, "Library", "Application Support", "Tweakers", "tweak-data", "co.tweakers.account-switcher"),
    });
    assert.equal(
      JSON.parse(readFileSync(join(output, "state.json"), "utf8")).appRoot,
      fixture.target,
      "the staged state is bound to the intended target identity, not the disposable package path",
    );
    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8")) as {
      tweaks?: Record<string, { enabled?: boolean }>;
    };
    for (const id of BUNDLED_TWEAK_IDS) assert.equal(config.tweaks?.[id]?.enabled, true, id);

    writeFileSync(join(output, "runtime", "receipt-tamper"), "tampered\n");
    assert.throws(
      () => verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture)),
      /candidate runtime fingerprint changed/,
      "the receipt must fail closed if a staged payload changes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion preserves mutable preferences and account/login homes outside the immutable receipt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-preserved-state-")));
  try {
    const fixture = createFixture(root, "preserved-state");
    const preservedConfig = {
      marker: "user-preferences",
      display: { density: "compact", accent: "violet" },
      tweaks: {
        "co.tweakers.account-switcher": {
          enabled: false,
          preferredAccount: "saved-account",
        },
        "example.third-party": {
          enabled: false,
          privateSetting: "keep-me",
        },
      },
    };
    writeFileSync(join(fixture.userRoot, "config.json"), `${JSON.stringify(preservedConfig)}\n`, { mode: 0o600 });
    const preservedRoots = [
      join(fixture.userRoot, "app-data"),
      join(fixture.userRoot, "codex-home"),
      join(fixture.userRoot, "tweak-data", "co.tweakers.account-switcher"),
    ];
    for (const [index, path] of preservedRoots.entries()) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(path, "sentinel"), `preserved-${index}\n`, { mode: 0o600 });
    }
    const preservedSnapshots = preservedRoots.map((path) => snapshot(path));

    await refreshFixture(fixture);

    const config = JSON.parse(readFileSync(join(fixture.userRoot, "config.json"), "utf8")) as {
      marker?: string;
      display?: Record<string, unknown>;
      tweaks?: Record<string, Record<string, unknown>>;
    };
    assert.equal(config.marker, preservedConfig.marker);
    assert.deepEqual(config.display, preservedConfig.display);
    assert.equal(config.tweaks?.["co.tweakers.account-switcher"]?.preferredAccount, "saved-account");
    assert.equal(config.tweaks?.["example.third-party"]?.privateSetting, "keep-me");
    assert.equal(config.tweaks?.["example.third-party"]?.enabled, false);
    for (const id of BUNDLED_TWEAK_IDS) assert.equal(config.tweaks?.[id]?.enabled, true, id);
    preservedRoots.forEach((path, index) => assert.deepEqual(snapshot(path), preservedSnapshots[index], path));

    const activeReceipt = JSON.parse(readFileSync(
      join(fixture.userRoot, "transactions", "variant-promotion", "active.json"),
      "utf8",
    )) as { version: number; entries: Array<{ name: string }> };
    assert.equal(activeReceipt.version, 3);
    assert.deepEqual(activeReceipt.entries.map((entry) => entry.name), ["runtime", "tweaks", "state.json", "app"]);
    assertNewActiveGeneration(fixture, "preserved-state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful independent promotion publishes the manager from the canonical global Tweakers root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-manager-bootstrap-")));
  try {
    const fixture = createFixture(root, "manager-bootstrap-success");
    const descriptor = join(root, "manager-descriptor.json");
    let publishedRoot: string | null = null;
    await withoutVariantStatusOutput(() => refreshTweakersVariant({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
    }, {
      ...fixture.deps,
      publishManagerDescriptor: ({ userRoot }) => {
        publishedRoot = userRoot;
        writeFileSync(descriptor, `${JSON.stringify({
          executable: join(userRoot, "managers", "co.therealityreport.tweakers", "generations", "fixture", "Tweakers Manager Launcher"),
        })}\n`, { mode: 0o600 });
        return { restoreOnFailure: () => {} };
      },
    }));

    assert.equal(publishedRoot, fixture.managerRoot);
    assert.deepEqual(fixture.managerEnvironmentBootstraps, [{
      sourceRoot: root,
      destinationRoot: fixture.managerRoot,
    }]);
    assert.equal(
      managerStatusPaths(fixture.managerRoot).independentStateFile,
      join(fixture.userRoot, "state.json"),
      "manager status must observe the independent state below the global root",
    );
    const published = JSON.parse(readFileSync(descriptor, "utf8")) as { executable: string };
    assert.ok(published.executable.startsWith(`${fixture.managerRoot}/managers/`));
    assert.ok(!published.executable.startsWith(`${fixture.userRoot}/`));
    assertNewActiveGeneration(fixture, "manager-bootstrap-success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure after independent manager publication restores the prior descriptor and active generation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-manager-rollback-")));
  try {
    const fixture = createFixture(root, "manager-bootstrap-rollback");
    const descriptor = join(root, "manager-descriptor.json");
    const priorDescriptor = '{"executable":"/legacy/manager"}\n';
    const publishedDescriptor = `${JSON.stringify({
      executable: join(fixture.managerRoot, "managers", "co.therealityreport.tweakers", "generations", "new", "Tweakers Manager Launcher"),
    })}\n`;
    writeFileSync(descriptor, priorDescriptor, { mode: 0o600 });
    const priorGeneration = activeGenerationSnapshot(fixture);
    let restores = 0;
    let environmentRestores = 0;

    await assert.rejects(
      refreshTweakersVariant({
        source: fixture.source,
        app: fixture.target,
        userRoot: fixture.userRoot,
      }, {
        ...fixture.deps,
        bootstrapManagerEnvironment: ({ sourceRoot, destinationRoot }) => ({
          sourceRoot,
          destinationRoot,
          registryFile: join(destinationRoot, "environment-registry.json"),
          selectionFile: join(destinationRoot, "environment-selection.json"),
          bootstrapped: true,
          restoreOnFailure: () => {
            environmentRestores += 1;
          },
        }),
        publishManagerDescriptor: ({ userRoot }) => {
          assert.equal(userRoot, fixture.managerRoot);
          writeFileSync(descriptor, publishedDescriptor, { mode: 0o600 });
          return {
            restoreOnFailure: () => {
              restores += 1;
              assert.equal(readFileSync(descriptor, "utf8"), publishedDescriptor);
              writeFileSync(descriptor, priorDescriptor, { mode: 0o600 });
            },
          };
        },
        fault: (point) => {
          if (point === "promotion:manager:published") throw new Error("injected manager publication follow-up failure");
        },
      }),
      /injected manager publication follow-up failure/,
    );

    assert.equal(restores, 1);
    assert.equal(environmentRestores, 1);
    assert.equal(readFileSync(descriptor, "utf8"), priorDescriptor);
    assert.deepEqual(activeGenerationSnapshot(fixture), priorGeneration);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate-only refuses existing output and rolls a failed private build aside without production mutation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-failure-")));
  try {
    const fixture = createFixture(root, "candidate-failure");
    const output = join(root, "candidate-package");
    mkdirSync(output, { recursive: true });
    let clones = 0;
    await assert.rejects(
      createTweakersVariant({
        source: fixture.source,
        app: fixture.target,
        userRoot: fixture.userRoot,
        candidateOnly: true,
        output,
      }, {
        ...fixture.deps,
        cloneApp: () => {
          clones += 1;
        },
      }),
      /Candidate output already exists and will not be replaced/,
    );
    assert.equal(clones, 0, "existing output must fail before clone");

    rmSync(output, { recursive: true, force: true });
    const productionBefore = snapshot(fixture.userRoot);
    const targetBefore = snapshot(fixture.target);
    await assert.rejects(
      createTweakersVariant({
        source: fixture.source,
        app: fixture.target,
        userRoot: fixture.userRoot,
        candidateOnly: true,
        output,
      }, {
        ...fixture.deps,
        installApp: async () => {
          throw new Error("injected candidate preparation failure");
        },
      }),
      /injected candidate preparation failure/,
    );
    assert.equal(existsSync(output), false, "failed preparation must leave the requested output absent");
    assert.equal(existsSync(join(root, ".candidate-package.candidate-failed-candidate-failure")), true,
      "failed private evidence is retained aside instead of replacing output or deleting artifacts");
    assert.deepEqual(snapshot(fixture.userRoot), productionBefore, "failed preparation must not write production state");
    assert.deepEqual(snapshot(fixture.target), targetBefore, "failed preparation must not change the installed target");
    assert.equal(existsSync(join(root, "Library", "Application Support", TWEAKERS_VARIANT_PRODUCT_NAME)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate-only default sealed source observes the cache read-only on success and clone failure", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-sealed-default-")));
  try {
    const fixture = createFixture(root, "candidate-sealed-default");
    const environmentRoot = join(root, "sealed-environment");
    const currentFile = join(environmentRoot, "current.json");
    mkdirSync(environmentRoot, { mode: 0o700 });
    writeFileSync(currentFile, '{"generation":"source-a"}\n', { mode: 0o600 });
    const sealed = sealedCandidateSourceReceipt(fixture.source, currentFile, "source-a");
    const cacheBefore = snapshot(environmentRoot);
    const output = join(root, "sealed-default-output");
    let reads = 0;

    await withoutVariantStatusOutput(() => createTweakersVariant({
      app: fixture.target,
      userRoot: fixture.userRoot,
      candidateOnly: true,
      output,
    }, {
      ...fixture.deps,
      environmentRoot: () => environmentRoot,
      sealedSourceReader: () => {
        reads += 1;
        return sealed;
      },
    }));

    assert.equal(reads, 2, "the sealed source is observed before and after clone without a lease");
    assert.deepEqual(snapshot(environmentRoot), cacheBefore, "candidate-only never writes the sealed environment cache");

    const failingOutput = join(root, "sealed-default-clone-failure");
    await assert.rejects(
      createTweakersVariant({
        app: fixture.target,
        userRoot: fixture.userRoot,
        candidateOnly: true,
        output: failingOutput,
      }, {
        ...fixture.deps,
        id: () => "candidate-sealed-default-failure",
        environmentRoot: () => environmentRoot,
        sealedSourceReader: () => {
          reads += 1;
          return sealed;
        },
        cloneApp: () => {
          throw new Error("injected raw clone failure");
        },
      }),
      /injected raw clone failure/,
    );
    assert.equal(existsSync(failingOutput), false);
    assert.equal(reads, 3, "a clone failure never retries through a cache-mutating source route");
    assert.deepEqual(snapshot(environmentRoot), cacheBefore, "clone failure leaves the sealed environment cache byte-for-byte unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoted sealed source resolution stays bound to the manager authority when a legacy root differs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-source-authority-")));
  try {
    const fixture = createFixture(root, "source-authority");
    const canonicalAuthorityRoot = join(root, "canonical-manager-root");
    const legacyCompatibilityRoot = join(root, "legacy-codex-plusplus-root");
    let observedAuthorityRoot: string | null = null;

    await assert.rejects(
      createTweakersVariant({
        app: fixture.target,
        userRoot: fixture.userRoot,
      }, {
        ...fixture.deps,
        environmentRoot: () => legacyCompatibilityRoot,
        environmentAuthoritySourceRoot: () => canonicalAuthorityRoot,
        sealedDefaultSourceResolver: (environmentRoot) => {
          observedAuthorityRoot = environmentRoot;
          return fixture.source;
        },
      }),
      /Variant target already exists/,
    );

    assert.notEqual(canonicalAuthorityRoot, legacyCompatibilityRoot);
    assert.equal(observedAuthorityRoot, canonicalAuthorityRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate-only rejects sealed-source generation and seal drift before install or publication", async () => {
  for (const drift of ["generation", "seal"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `tweakers-variant-candidate-source-${drift}-`)));
    try {
      const fixture = createFixture(root, `candidate-source-${drift}`);
      const environmentRoot = join(root, "sealed-environment");
      const currentFile = join(environmentRoot, "current.json");
      mkdirSync(environmentRoot, { mode: 0o700 });
      writeFileSync(currentFile, '{"generation":"source-a"}\n', { mode: 0o600 });
      const sourceA = sealedCandidateSourceReceipt(fixture.source, currentFile, "source-a");
      const sourceB = drift === "generation"
        ? sealedCandidateSourceReceipt(fixture.source, currentFile, "source-b")
        : sealedCandidateSourceReceipt(fixture.source, currentFile, "source-a", "c".repeat(64));
      const cacheBefore = snapshot(environmentRoot);
      const productionBefore = activeGenerationSnapshot(fixture);
      const output = join(root, "candidate-output");
      let reads = 0;
      let installs = 0;
      let publications = 0;

      await assert.rejects(
        createTweakersVariant({
          app: fixture.target,
          userRoot: fixture.userRoot,
          candidateOnly: true,
          output,
        }, {
          ...fixture.deps,
          environmentRoot: () => environmentRoot,
          sealedSourceReader: () => {
            reads += 1;
            return reads === 1 ? sourceA : sourceB;
          },
          installApp: async (options) => {
            installs += 1;
            installCandidateFixture(options);
          },
          beforeCandidatePublication: () => {
            publications += 1;
          },
        }),
        /Candidate source drift: sealed source evidence changed/,
        drift,
      );
      assert.equal(reads, 2, drift);
      assert.equal(installs, 0, drift);
      assert.equal(publications, 0, drift);
      assert.equal(existsSync(output), false, drift);
      assert.equal(existsSync(join(root, `.candidate-output.candidate-failed-candidate-source-${drift}`)), true, drift);
      assert.deepEqual(snapshot(environmentRoot), cacheBefore, drift);
      assert.deepEqual(activeGenerationSnapshot(fixture), productionBefore, drift);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("candidate-only exclusive publication and failed-evidence races never overwrite a sibling", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-races-")));
  try {
    const fixture = createFixture(root, "candidate-publication-race");
    const output = join(root, "candidate-output");
    const failed = join(root, ".candidate-output.candidate-failed-candidate-publication-race");
    const targetBefore = snapshot(fixture.target);
    const userRootBefore = snapshot(fixture.userRoot);
    let racedOutputIdentity: { dev: number; ino: number } | null = null;

    await assert.rejects(
      createTweakersVariant({
        source: fixture.source,
        app: fixture.target,
        userRoot: fixture.userRoot,
        candidateOnly: true,
        output,
      }, {
        ...fixture.deps,
        beforeCandidatePublication: ({ output: racedOutput }) => {
          mkdirSync(racedOutput, { mode: 0o700 });
          writeFileSync(join(racedOutput, "raced-sentinel"), "raced output\n", { mode: 0o600 });
          const stat = statSync(racedOutput);
          racedOutputIdentity = { dev: stat.dev, ino: stat.ino };
        },
      }),
      /Candidate output already exists and will not be replaced/,
    );
    const outputStat = statSync(output);
    assert.deepEqual({ dev: outputStat.dev, ino: outputStat.ino }, racedOutputIdentity);
    assert.equal(readFileSync(join(output, "raced-sentinel"), "utf8"), "raced output\n");
    assert.equal(existsSync(failed), true, "the source package is retained in its private failed sibling");
    assert.deepEqual(snapshot(fixture.target), targetBefore);
    assert.deepEqual(snapshot(fixture.userRoot), userRootBefore);

    const failedOutput = join(root, "candidate-retention-output");
    const failedScratch = join(root, ".candidate-retention-output.candidate-candidate-failure-race");
    const racedFailed = join(root, ".candidate-retention-output.candidate-failed-candidate-failure-race");
    let racedFailedIdentity: { dev: number; ino: number } | null = null;
    await assert.rejects(
      createTweakersVariant({
        source: fixture.source,
        app: fixture.target,
        userRoot: fixture.userRoot,
        candidateOnly: true,
        output: failedOutput,
      }, {
        ...fixture.deps,
        id: () => "candidate-failure-race",
        installApp: async () => {
          throw new Error("injected candidate preparation failure");
        },
        beforeCandidateFailureRetention: ({ failedScratch: racedRetention }) => {
          mkdirSync(racedRetention, { mode: 0o700 });
          writeFileSync(join(racedRetention, "raced-sentinel"), "raced failed evidence\n", { mode: 0o600 });
          const stat = statSync(racedRetention);
          racedFailedIdentity = { dev: stat.dev, ino: stat.ino };
        },
      }),
      /injected candidate preparation failure/,
    );
    const failedStat = statSync(racedFailed);
    assert.deepEqual({ dev: failedStat.dev, ino: failedStat.ino }, racedFailedIdentity);
    assert.equal(readFileSync(join(racedFailed, "raced-sentinel"), "utf8"), "raced failed evidence\n");
    assert.equal(existsSync(failedScratch), true, "the original scratch remains instead of overwriting raced failed evidence");
    assert.equal(existsSync(failedOutput), false);
    assert.deepEqual(snapshot(fixture.target), targetBefore);
    assert.deepEqual(snapshot(fixture.userRoot), userRootBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate receipts reject a forged signed-envelope claim, loose hashes, and a different leaf pin", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-receipt-forgery-")));
  try {
    const fixture = createFixture(root, "candidate-receipt-forgery");
    const output = join(root, "candidate-output");
    await withoutVariantStatusOutput(() => createTweakersVariant({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      candidateOnly: true,
      output,
    }, fixture.deps));

    const receiptPath = join(
      output,
      "receipt",
      "TweakersCandidateReceipt.bundle",
      "Contents",
      "Resources",
      "variant-candidate-receipt.json",
    );
    const originalReceiptBytes = readFileSync(receiptPath);
    const receipt = JSON.parse(originalReceiptBytes.toString("utf8")) as { identity: { appTarget: string } };
    receipt.identity.appTarget = join(root, "forged-target.app");
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    assert.throws(
      () => verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture)),
      /fixture receipt bundle strict verification failed/,
    );

    writeFileSync(join(output, "variant-candidate-receipt.sha256"), "forged ordinary digest\n", { mode: 0o600 });
    assert.throws(
      () => verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture)),
      /Legacy loose candidate receipts are not authorization evidence/,
    );
    rmSync(join(output, "variant-candidate-receipt.sha256"), { force: true });
    writeFileSync(receiptPath, originalReceiptBytes, { mode: 0o600 });

    const signature = (fixture.deps as {
      candidateReceiptSignature: Parameters<typeof verifyTweakersVariantCandidateReceipt>[1]["signature"];
    }).candidateReceiptSignature!;
    assert.throws(
      () => verifyTweakersVariantCandidateReceipt(output, {
        ...candidateVerificationOptions(output, fixture),
        signature: {
          ...signature,
          certificateLeafHash: () => "B".repeat(40),
        },
      }),
      /leaf hash/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate receipts accept the exact detached resource signature layout emitted by current macOS codesign", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-detached-signature-")));
  try {
    const fixture = createFixture(root, "candidate-detached-signature");
    const signature = fixture.deps.candidateReceiptSignature!;
    const originalSign = signature.sign;
    signature.sign = (bundlePath, identity) => {
      originalSign(bundlePath, identity);
      const codeSignature = join(bundlePath, "Contents", "_CodeSignature");
      writeFileSync(join(codeSignature, "CodeDirectory"), "fixture-code-directory\n");
      writeFileSync(join(codeSignature, "CodeRequirements"), "fixture-code-requirements\n");
      writeFileSync(join(codeSignature, "CodeSignature"), "fixture-cms-signature\n");
    };
    const output = join(root, "candidate-output");

    await withoutVariantStatusOutput(() => createTweakersVariant({
      source: fixture.source,
      app: fixture.target,
      userRoot: fixture.userRoot,
      candidateOnly: true,
      output,
    }, fixture.deps));

    assert.doesNotThrow(() =>
      verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture))
    );
    writeFileSync(
      join(output, "receipt", "TweakersCandidateReceipt.bundle", "Contents", "_CodeSignature", "unexpected"),
      "not codesign metadata\n",
    );
    assert.throws(
      () => verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture)),
      /Candidate receipt code signature has an unexpected layout/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate-only rejects official-app aliases at preparation and receipt verification while allowing an absent identity target", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-variant-candidate-official-alias-")));
  try {
    const fixture = createFixture(root, "candidate-official-alias");
    const alias = join(root, "OfficialAlias.app");
    const preflightOutput = join(root, "preflight-output");
    const officialBefore = snapshot(fixture.officialApp);
    let clones = 0;
    symlinkSync(fixture.officialApp, alias);

    await assert.rejects(
      createTweakersVariant({
        source: fixture.source,
        app: alias,
        userRoot: fixture.userRoot,
        candidateOnly: true,
        output: preflightOutput,
      }, {
        ...fixture.deps,
        cloneApp: () => {
          clones += 1;
        },
      }),
      /candidate-path-symlink-refused/,
    );
    assert.equal(clones, 0);
    assert.equal(existsSync(preflightOutput), false);
    assert.deepEqual(snapshot(fixture.officialApp), officialBefore);

    const absentTarget = join(root, "candidate-identity", "Tweakers.app");
    const output = join(root, "candidate-output");
    await withoutVariantStatusOutput(() => createTweakersVariant({
      source: fixture.source,
      app: absentTarget,
      userRoot: fixture.userRoot,
      candidateOnly: true,
      output,
    }, fixture.deps));
    assert.equal(existsSync(absentTarget), false, "candidate-only treats a disjoint target as identity-only");

    const receiptPath = join(
      output,
      "receipt",
      "TweakersCandidateReceipt.bundle",
      "Contents",
      "Resources",
      "variant-candidate-receipt.json",
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { identity: { appTarget: string } };
    receipt.identity.appTarget = alias;
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    const signature = (fixture.deps as {
      candidateReceiptSignature: NonNullable<Parameters<typeof verifyTweakersVariantCandidateReceipt>[1]["signature"]>;
    }).candidateReceiptSignature;
    signature.sign(join(output, "receipt", "TweakersCandidateReceipt.bundle"), {
      name: "Tweakers Local Signing",
      hash: fixture.signingHash,
      created: false,
    });
    assert.throws(
      () => verifyTweakersVariantCandidateReceipt(output, candidateVerificationOptions(output, fixture)),
      /candidate-path-symlink-refused|official-app physical alias/,
    );
    assert.deepEqual(snapshot(fixture.officialApp), officialBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

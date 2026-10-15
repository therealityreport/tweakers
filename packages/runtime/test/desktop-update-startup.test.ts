import assert from "node:assert/strict";
import asar from "@electron/asar";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import {
  assertTweakersVariantBootstrap,
  createDesktopUpdateStartupReconciler,
  desktopUpdateStartupEnabled,
  fingerprintTweakersVariantGeneration,
  publishIndependentTweakersRuntimeReadyReceipt,
  type DesktopUpdateStartupEvent,
} from "../src/desktop-update-startup";
import {
  combinedPayloadIdentity,
  validatePrebuiltCombinedCandidate,
  type AcceptedPrebuiltCodexBuildReceipt,
} from "../../installer/src/prebuilt-combined-candidate";
import { assertAcceptedSharedNativeBackendTransitionShape } from "../../installer/src/shared-native-backend-transition";
import { acceptedOfficialBundledPayloadText, type AcceptedBackendTransitionJournalBindingV1,
  type OfficialBundledCandidateAuthorityV2 } from "../../sdk/src/accepted-backend-transition-contract";
import type { AcceptedRuntimeRepairBootstrapProjection } from "../src/accepted-runtime-repair-bootstrap";

const promotionNames = ["runtime", "tweaks", "state.json", "config.json", "app"] as const;
const immutablePromotionNames = ["runtime", "tweaks", "state.json", "app"] as const;

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test("runtime-ready publication preserves the manager-owned expectation", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-runtime-ready-publish-"));
  try {
    const expectationPath = join(root, "runtime-ready-expectation.json");
    const receiptPath = join(root, "runtime-ready.json");
    const expectation = { operationId: "manager-owned-challenge", promotionId: "promotion-a" };
    const receipt = { operationId: expectation.operationId, mainInitialized: true };
    writePrivateJson(expectationPath, expectation);
    const expectationBytes = readFileSync(expectationPath);

    publishIndependentTweakersRuntimeReadyReceipt(receiptPath, receipt, 513);

    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt);
    assert.deepEqual(readFileSync(expectationPath), expectationBytes);
    assert.equal(existsSync(`${receiptPath}.513.tmp`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Accepted backend transitions are journaled only under the managed Manager
 * layout with UUID transaction ids; superseded-history reads fail closed otherwise. */
const ACCEPTED_TRANSITION_JOURNAL_ID = "4f2c9b7e-3d1a-4e8b-9c6f-5a7d2e1b0c38";

function derivedVariantBootstrapFixture(root: string, version: 2 | 3 = 3, managed = false, id = "bootstrap-fixture"): {
  userRoot: string;
  target: string;
  resourcesPath: string;
  environment: NodeJS.ProcessEnv;
  journalPath: string;
  activePath: string;
  stagedActivePath: string;
} {
  const userRoot = managed ? join(root, "manager", "variants", "tweakers") : join(root, "state");
  const target = join(root, "Tweakers.app");
  const resourcesPath = join(target, "Contents", "Resources");
  const journalRoot = join(userRoot, "transactions", "variant-promotion");
  const activePath = join(journalRoot, "active.json");
  const buildRoot = join(userRoot, "builds", id);
  const archiveRoot = join(userRoot, "previous", id);
  const failedRoot = join(buildRoot, "failed-promotion");
  mkdirSync(join(target, "Contents", "Resources"), { recursive: true });
  // Keep an app.asar boundary in the fixture. In Electron this path is
  // virtualized by the ordinary fs facade; the production call supplies
  // original-fs so the bundle is fingerprinted as the physical archive.
  mkdirSync(join(target, "Contents", "Resources", "app.asar"), { recursive: true });
  writeFileSync(join(target, "Contents", "Resources", "app.asar", "package.json"), "{}\n");
  mkdirSync(join(userRoot, "runtime"), { recursive: true, mode: 0o700 });
  mkdirSync(join(userRoot, "tweaks"), { recursive: true, mode: 0o700 });
  mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  chmodSync(userRoot, 0o700);
  chmodSync(join(userRoot, "transactions"), 0o700);
  chmodSync(journalRoot, 0o700);
  writeFileSync(join(target, "Contents", "Resources", "marker"), "new-app");
  writeFileSync(join(userRoot, "runtime", "marker"), "new-runtime");
  writeFileSync(join(userRoot, "tweaks", "marker"), "new-tweaks");
  writeFileSync(join(userRoot, "state.json"), "new-state\n");
  writeFileSync(join(userRoot, "config.json"), "new-config\n");

  const destinations = {
    runtime: join(userRoot, "runtime"),
    tweaks: join(userRoot, "tweaks"),
    "state.json": join(userRoot, "state.json"),
    "config.json": join(userRoot, "config.json"),
    app: target,
  } as const;
  const active = {
    version,
    id,
    userRoot,
    target,
    entries: (version === 2 ? promotionNames : immutablePromotionNames).map((name) => ({
      name,
      path: destinations[name],
      fingerprint: fingerprintTweakersVariantGeneration(destinations[name]),
    })),
  };
  writePrivateJson(activePath, active);
  const stagedActivePath = join(buildRoot, "active-receipt.json");
  writePrivateJson(stagedActivePath, active);
  const journalPath = join(journalRoot, `${id}.json`);
  const journal = {
    version,
    id,
    userRoot,
    target,
    candidate: join(dirname(target), `.${target.slice(target.lastIndexOf("/") + 1)}.candidate-${id}.app`),
    buildRoot,
    phase: "committed",
    entries: promotionNames.map((name) => ({
      name,
      source: name === "app" ? join(dirname(target), `.${target.slice(target.lastIndexOf("/") + 1)}.candidate-${id}.app`) : join(buildRoot, name),
      destination: destinations[name],
      archive: name === "app" ? join(archiveRoot, "app", "Tweakers.app") : join(archiveRoot, "state", name),
      failed: name === "app" ? join(failedRoot, "app", "Tweakers.app") : join(failedRoot, "state", name),
      hadDestination: false,
      desired: fingerprintTweakersVariantGeneration(destinations[name]),
      previous: null,
    })),
    activeReceipt: {
      source: join(buildRoot, "active-receipt.json"),
      destination: activePath,
      archive: join(archiveRoot, "active-receipt.json"),
      failed: join(failedRoot, "active-receipt.json"),
      hadDestination: false,
      desired: fingerprintTweakersVariantGeneration(activePath),
      previous: null,
      expected: active,
    },
  };
  writePrivateJson(journalPath, journal);
  return {
    userRoot,
    target,
    resourcesPath,
    environment: {
      TWEAKERS_DERIVED_VARIANT: "1",
      TWEAKERS_USER_ROOT: userRoot,
      TWEAKERS_RUNTIME: join(userRoot, "runtime"),
    },
    journalPath,
    activePath,
    stagedActivePath,
  };
}

function markFixtureProvisionallyPromoted(fixture: ReturnType<typeof derivedVariantBootstrapFixture>): void {
  const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8")) as {
    id: string;
    phase: string;
  };
  journal.phase = "app:promoted";
  writePrivateJson(fixture.journalPath, journal);
  rmSync(fixture.activePath);
  const hash = "a".repeat(64);
  writePrivateJson(join(fixture.userRoot, "runtime-ready-expectation.json"), {
    schemaVersion: 5,
    kind: "tweakers-independent-runtime-ready-expectation",
    operationId: "runtime-proof",
    promotionId: journal.id,
    activePromotionReceiptSha256: fingerprintTweakersVariantGeneration(fixture.stagedActivePath).sha256,
    appRoot: fixture.target,
    bundleId: "com.therealityreport.tweakers",
    appAsarHeaderHash: hash,
    runtimeFingerprint: hash,
    appUserDataRoot: join(fixture.userRoot, "app-data"),
    codexHomeRoot: join(fixture.userRoot, "codex-home"),
    accountsBrokerRoot: join(fixture.userRoot, "accounts-broker"),
    brokerAuthorityExpectation: {
      globalRootState: "absent",
      configSha256: null,
    },
    appearanceExpectation: {
      status: "normal",
      normalized: true,
    },
    expectedTweakIds: ["co.tweakers.account-switcher"],
    createdAt: "2026-09-03T12:00:00.000Z",
  });
}

/** Use the maintained authority producer, not a truncated bootstrap-only lane. */
function producedAcceptedTransition(
  root: string,
  fixture: ReturnType<typeof derivedVariantBootstrapFixture>,
): AcceptedBackendTransitionJournalBindingV1 {
  const source = join(root, "accepted-transition-producer");
  const runtimeRoot = join(source, "runtime"), sourceAppRoot = join(source, "ChatGPT.app");
  mkdirSync(runtimeRoot, { recursive: true });mkdirSync(sourceAppRoot);
  const binaryPath = join(source, "codex"), helperPath = join(source, "codex-code-mode-host");
  const receiptPath = join(source, "accepted-build.json"), documentPath = join(runtimeRoot, "runtime-fingerprint.json");
  writeFileSync(binaryPath, "accepted-backend");writeFileSync(helperPath, "accepted-helper");writeFileSync(documentPath, "{}\n");
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const signature = { identity: "fixture-signing", teamIdentifier: null, designatedRequirement: null };
  const receipt: AcceptedPrebuiltCodexBuildReceipt = {
    schemaVersion: 2, kind: "tweakers-prebuilt-codex-build", status: "accepted", acceptedAt: "2026-10-12T07:23:35.880Z",
    verification: { level: "source-verified", installedAcceptance: "required" },
    upstream: { repository: "https://github.com/openai/codex.git", tag: "rust-v0.162.0-alpha.17.2", commit: "d".repeat(40) },
    source: { commit: "d".repeat(40), tree: "e".repeat(40), cargoLockSha256: "a".repeat(64), reviewedDiffSha256: "b".repeat(64), patchSeriesSha256: "c".repeat(64) },
    build: { command: "cargo build --locked --release --package codex-cli --bin codex --package codex-code-mode-host --bin codex-code-mode-host", toolchain: "fixture-rustc", architecture: "arm64" },
    tests: [{ name: "lifecycle", command: "cargo test --locked --lib lifecycle", receiptSha256: "f".repeat(64), status: "passed" }],
    binary: { path: binaryPath, sha256: digest(binaryPath), version: "0.162.0-alpha.17.2", architecture: "arm64", signature },
    closure: { codeModeHost: { path: helperPath, sha256: digest(helperPath), architecture: "arm64", signature }, resources: [] },
    runtime: { sourceRoot: runtimeRoot, fingerprint: "1".repeat(64), fileCount: 428, documentSha256: digest(documentPath) },
  };
  writePrivateJson(receiptPath, receipt);
  const authority = validatePrebuiltCombinedCandidate({
    transactionId: "b54072f1-75be-474e-9076-653cf4e325b6", binaryPath, receiptPath,
    expectedBinarySha256: receipt.binary.sha256, expectedReceiptSha256: digest(receiptPath), expectedVersion: receipt.binary.version,
    expectedArchitecture: "arm64", expectedRuntimeFingerprint: receipt.runtime.fingerprint,
    expectedRuntimeFileCount: receipt.runtime.fileCount, expectedRuntimeDocumentSha256: receipt.runtime.documentSha256,
    expectedSourceAppFingerprint: "2".repeat(64), expectedBundleId: "com.openai.codex",
  }, { installerPayloadHash: "3".repeat(64), runtimeRoot, sourceAppRoot, now: new Date("2026-10-12T08:00:00Z") }, {
    fingerprintFile: digest, probeVersion: () => receipt.binary.version, probeArchitecture: () => "arm64",
    verifyBackendSignature: () => true, verifyCodeModeHostPosture: () => true,
    sourceAppFingerprint: () => "2".repeat(64), sourceAppBundleId: () => "com.openai.codex",
    runtimeEvidence: () => ({ fingerprint: receipt.runtime.fingerprint, fileCount: receipt.runtime.fileCount }),
  });
  const lane = { version: 1 as const, identity: { target: fixture.target, userRoot: fixture.userRoot, brokerRoot: join(fixture.userRoot, "accounts-broker") },
    authority, priorRegistrationFingerprint: `sha256:${"4".repeat(64)}` as const, priorResolverBinarySha256: "5".repeat(64) };
  assertAcceptedSharedNativeBackendTransitionShape(lane);
  // Independent golden serialization protects existing signed identities against reordered payload keys.
  assert.equal(authority.payloadIdentity, createHash("sha256").update(JSON.stringify({
    schemaVersion: authority.schemaVersion, transactionId: authority.transactionId, installerPayloadHash: authority.installerPayloadHash,
    acceptedBuildReceipt: authority.acceptedBuildReceipt, backend: authority.backend, closure: authority.closure,
    runtime: authority.runtime, sourceApp: authority.sourceApp,
  })).digest("hex"));
  return { lane, operationId: "6bc2dbac-894a-46cd-a2ae-bfcd1f6796b1" };
}

async function replaceFixtureAppAsarWithPhysicalArchive(
  fixture: ReturnType<typeof derivedVariantBootstrapFixture>,
  root: string,
): Promise<void> {
  const appAsar = join(fixture.resourcesPath, "app.asar");
  const source = join(root, "physical-asar-source");
  rmSync(appAsar, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"physical-fixture","main":"main.js"}\n');
  writeFileSync(join(source, "main.js"), 'module.exports = "physical";\n');
  const output = await asar.createPackageWithOptions(source, appAsar, { globOptions: { dot: true } });
  await finished(output);

  const active = JSON.parse(readFileSync(fixture.activePath, "utf8")) as {
    entries: Array<{ name: string; fingerprint: ReturnType<typeof fingerprintTweakersVariantGeneration> }>;
  };
  const appActive = active.entries.find((entry) => entry.name === "app");
  assert.ok(appActive);
  appActive.fingerprint = fingerprintTweakersVariantGeneration(fixture.target);
  writePrivateJson(fixture.activePath, active);
  writePrivateJson(fixture.stagedActivePath, active);

  const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8")) as {
    entries: Array<{ name: string; desired: ReturnType<typeof fingerprintTweakersVariantGeneration> }>;
    activeReceipt: {
      desired: ReturnType<typeof fingerprintTweakersVariantGeneration>;
      expected: unknown;
    };
  };
  const appJournal = journal.entries.find((entry) => entry.name === "app");
  assert.ok(appJournal);
  appJournal.desired = fingerprintTweakersVariantGeneration(fixture.target);
  journal.activeReceipt.expected = active;
  journal.activeReceipt.desired = fingerprintTweakersVariantGeneration(fixture.stagedActivePath);
  writePrivateJson(fixture.journalPath, journal);
}

test("derived Tweakers variants do not schedule desktop update reconciliation", () => {
  assert.equal(desktopUpdateStartupEnabled({ TWEAKERS_DERIVED_VARIANT: "1" }), false);
  assert.equal(desktopUpdateStartupEnabled({ TWEAKERS_DERIVED_VARIANT: "0" }), true);
  assert.equal(desktopUpdateStartupEnabled({}), true);
  assert.equal(desktopUpdateStartupEnabled({}, {
    bundleIdentifier: "com.therealityreport.tweakers",
    appPath: "/Applications/Derived Copy.app",
  }), false);
  assert.equal(desktopUpdateStartupEnabled({}, {
    appPath: "/Applications/Tweakers.app",
  }), false);
  assert.equal(desktopUpdateStartupEnabled({}, {
    appPath: "/Applications/Derived Copy.app",
    verifiedDerivedAppPath: "/Applications/Derived Copy.app",
  }), false);
  assert.equal(desktopUpdateStartupEnabled({}, {
    bundleIdentifier: "com.openai.chat",
    appPath: "/Applications/ChatGPT.app",
  }), true);
});

test("derived variant bootstrap keeps mutable tweak preferences outside the immutable receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-mutable-config-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    writeFileSync(join(fixture.userRoot, "config.json"), "user-updated-config\n");
    assert.doesNotThrow(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 receipts remain readable without freezing mutable config", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-legacy-config-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root, 2);
    writeFileSync(join(fixture.userRoot, "config.json"), "legacy-user-updated-config\n");
    assert.doesNotThrow(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    });

    writeFileSync(join(fixture.userRoot, "runtime", "marker"), "tampered-runtime");
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /generation fingerprint mismatch: runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived variant bootstrap requires a committed, exact immutable generation", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-bootstrap-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    assert.doesNotThrow(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    });

    writeFileSync(join(fixture.userRoot, "runtime", "marker"), "tampered-runtime");
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /generation fingerprint mismatch: runtime/);

    writeFileSync(join(fixture.userRoot, "runtime", "marker"), "new-runtime");
    const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8")) as { phase: string };
    journal.phase = "promoting";
    writePrivateJson(fixture.journalPath, journal);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /refuses pending promotion journal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived variant bootstrap admits only the exact operation-bound app-promoted generation before commit", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-provisional-bootstrap-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    markFixtureProvisionallyPromoted(fixture);
    assert.doesNotThrow(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    });

    const expectationPath = join(fixture.userRoot, "runtime-ready-expectation.json");
    const expectation = JSON.parse(readFileSync(expectationPath, "utf8")) as Record<string, unknown>;
    expectation.brokerAuthorityExpectation = {
      globalRootState: "valid-v3",
      configSha256: "B".repeat(64),
    };
    writePrivateJson(expectationPath, expectation);
    assert.doesNotThrow(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    });

    expectation.brokerAuthorityExpectation = {
      globalRootState: "absent",
      configSha256: "B".repeat(64),
    };
    writePrivateJson(expectationPath, expectation);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /invalid runtime-ready expectation/);

    expectation.brokerAuthorityExpectation = {
      globalRootState: "valid-v3",
      configSha256: "B".repeat(64),
      unexpected: true,
    };
    writePrivateJson(expectationPath, expectation);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /invalid runtime-ready broker authority expectation schema/);

    expectation.brokerAuthorityExpectation = {
      globalRootState: "absent",
      configSha256: null,
    };
    for (const appearanceExpectation of [
      undefined,
      { status: "needs_attention", normalized: true },
      { status: "not_observed", normalized: true },
      { status: "error", normalized: true },
      { status: "normal", normalized: false },
    ]) {
      expectation.appearanceExpectation = appearanceExpectation;
      writePrivateJson(expectationPath, expectation);
      assert.throws(() => {
        assertTweakersVariantBootstrap({
          environment: fixture.environment,
          resourcesPath: fixture.resourcesPath,
        });
      }, /invalid runtime-ready (appearance expectation|expectation)/);
    }
    expectation.appearanceExpectation = {
      status: "normal",
      normalized: true,
    };
    expectation.unexpected = true;
    writePrivateJson(expectationPath, expectation);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /invalid runtime-ready expectation schema/);
    delete expectation.unexpected;
    writePrivateJson(expectationPath, expectation);

    const expectationBytes = readFileSync(expectationPath);
    rmSync(expectationPath);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /refuses pending promotion journal/);
    writeFileSync(expectationPath, expectationBytes, { mode: 0o600 });

    const stagedActiveBytes = readFileSync(fixture.stagedActivePath);
    appendFileSync(fixture.stagedActivePath, "\n");
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /does not bind the staged active receipt/);
    writeFileSync(fixture.stagedActivePath, stagedActiveBytes, { mode: 0o600 });

    const reboundExpectation = JSON.parse(readFileSync(expectationPath, "utf8")) as { promotionId: string };
    reboundExpectation.promotionId = "another-promotion";
    writePrivateJson(expectationPath, reboundExpectation);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /does not bind the pending promotion/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived generation hashing accepts the physical filesystem adapter at an app.asar boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-physical-fs-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    const paths: string[] = [];
    const physicalFs = {
      existsSync(path: string) { paths.push(path); return existsSync(path); },
      lstatSync(path: string) { paths.push(path); return lstatSync(path); },
      readFileSync(path: string) { paths.push(path); return readFileSync(path); },
      readdirSync(path: string, options: { withFileTypes: true }) { paths.push(path); return readdirSync(path, options); },
      readlinkSync(path: string) { paths.push(path); return readlinkSync(path); },
    };
    assert.doesNotThrow(() => assertTweakersVariantBootstrap({
      environment: fixture.environment,
      resourcesPath: fixture.resourcesPath,
      fileSystem: physicalFs,
    }));
    assert.ok(paths.some((path) => path.endsWith("/Contents/Resources/app.asar")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived bootstrap fingerprints a real physical app.asar archive and rejects byte tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-real-asar-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    await replaceFixtureAppAsarWithPhysicalArchive(fixture, root);
    assert.equal(lstatSync(join(fixture.resourcesPath, "app.asar")).isFile(), true);
    assert.doesNotThrow(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    });

    appendFileSync(join(fixture.resourcesPath, "app.asar"), Buffer.from("tampered"));
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /generation fingerprint mismatch: app/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived variant bootstrap rejects a journal path record outside its exact transaction roots", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-bootstrap-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8")) as {
      entries: Array<{ destination: string }>;
    };
    journal.entries[0]!.destination = join(root, "outside-runtime");
    writePrivateJson(fixture.journalPath, journal);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /journal generation path is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived variant bootstrap rejects a symlinked journal ancestor and traversal transaction ID", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-bootstrap-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    const transactions = join(fixture.userRoot, "transactions");
    const relocatedTransactions = join(root, "relocated-transactions");
    renameSync(transactions, relocatedTransactions);
    symlinkSync(relocatedTransactions, transactions);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /symlinked promotion journal path component/);

    rmSync(transactions, { force: true });
    renameSync(relocatedTransactions, transactions);
    const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8")) as { id: string };
    journal.id = "..";
    writePrivateJson(fixture.journalPath, journal);
    assert.throws(() => {
      assertTweakersVariantBootstrap({
        environment: fixture.environment,
        resourcesPath: fixture.resourcesPath,
      });
    }, /invalid promotion transaction ID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconcile waits for a visible window, launches once, and cannot be scheduled twice", () => {
  const timers: Array<() => void> = [];
  const events: DesktopUpdateStartupEvent[] = [];
  let probes = 0;
  let launches = 0;
  const reconciler = createDesktopUpdateStartupReconciler({
    windowReady: () => {
      probes += 1;
      return probes >= 3;
    },
    launch: () => {
      launches += 1;
    },
    setTimer: (callback) => {
      timers.push(callback);
    },
    onEvent: (event) => events.push(event),
  }, { maxAttempts: 4, retryMs: 1 });

  assert.equal(reconciler.schedule(), true);
  assert.equal(reconciler.schedule(), false);
  while (timers.length > 0) timers.shift()?.();

  assert.equal(launches, 1);
  assert.deepEqual(events, [{
    event: "desktop-update-startup-reconcile",
    result: "submitted",
    attempts: 3,
  }]);
});

test("startup reconcile stops after its bounded window-proof retries", () => {
  const timers: Array<() => void> = [];
  const events: DesktopUpdateStartupEvent[] = [];
  const reconciler = createDesktopUpdateStartupReconciler({
    windowReady: () => false,
    launch: () => assert.fail("no window proof must not launch reconcile"),
    setTimer: (callback) => {
      timers.push(callback);
    },
    onEvent: (event) => events.push(event),
  }, { maxAttempts: 2, retryMs: 1 });

  reconciler.schedule();
  while (timers.length > 0) timers.shift()?.();

  assert.deepEqual(events, [{
    event: "desktop-update-startup-reconcile",
    result: "window-unavailable",
    attempts: 2,
  }]);
});

test("startup launcher failures are captured as diagnostics instead of escaping", () => {
  const timers: Array<() => void> = [];
  const events: DesktopUpdateStartupEvent[] = [];
  const error = Object.assign(new Error("launchctl denied"), {
    code: "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED",
  });
  const reconciler = createDesktopUpdateStartupReconciler({
    windowReady: () => true,
    launch: () => {
      throw error;
    },
    setTimer: (callback) => {
      timers.push(callback);
    },
    onEvent: (event) => events.push(event),
  });

  assert.doesNotThrow(() => {
    reconciler.schedule();
    timers.shift()?.();
  });
  assert.deepEqual(events, [{
    event: "desktop-update-startup-reconcile",
    result: "failed",
    attempts: 1,
    error: "launchctl denied",
    errorCode: "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED",
  }]);
});


test("Doctor candidate bootstrap preserves exact path binding after staging is consumed", () => {
  for (const provisional of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-doctor-bootstrap-"));
    try {
      const fixture = derivedVariantBootstrapFixture(root, 3, true);
      if (provisional) markFixtureProvisionallyPromoted(fixture);
      const candidate = join(root, "manager", "doctor", "jobs", "1ce0c611-1b13-42d5-a3ba-5a95c8e9c54e", "candidate", "Tweakers.app");
      const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
      journal.candidate = candidate;
      const app = journal.entries.find((entry: {name: string}) => entry.name === "app");
      app.source = candidate;
      const check = () => assertTweakersVariantBootstrap({environment: fixture.environment, resourcesPath: fixture.resourcesPath});
      writePrivateJson(fixture.journalPath, journal);
      assert.doesNotThrow(check);
      mkdirSync(dirname(candidate), {recursive: true});
      assert.doesNotThrow(check);
      app.source = candidate + ".other";
      writePrivateJson(fixture.journalPath, journal);
      assert.throws(check, /generation path is invalid/);
      for (const invalid of [candidate.replace("1ce0c611-1b13-42d5-a3ba-5a95c8e9c54e", "------------------------------------"), candidate.replace("/candidate/", "/candidate/../candidate/")]) {
        journal.candidate = app.source = invalid;
        writePrivateJson(fixture.journalPath, journal);
        assert.throws(check, /path binding is invalid/);
      }
      journal.candidate = app.source = candidate;
      writePrivateJson(fixture.journalPath, journal);
      const doctor = join(root, "manager", "doctor");
      renameSync(doctor, doctor + "-moved");
      symlinkSync(doctor + "-moved", doctor);
      assert.throws(check, /symlinked promotion candidate/);
    } finally { rmSync(root, {recursive: true, force: true}); }
  }
});

test("accepted backend producer journals bootstrap provisionally and after commit without rebinding history", () => {
  for (const provisional of [false, true]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "accepted-transition-bootstrap-")));
    try {
      const fixture = derivedVariantBootstrapFixture(root, 3, true, ACCEPTED_TRANSITION_JOURNAL_ID);
      const binding = producedAcceptedTransition(root, fixture);
      if (provisional) {
        markFixtureProvisionallyPromoted(fixture);
        const path = join(fixture.userRoot, "runtime-ready-expectation.json");
        const expectation = JSON.parse(readFileSync(path, "utf8"));
        expectation.operationId = binding.operationId;
        writePrivateJson(path, expectation);
      }
      const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
      journal.acceptedBackendTransition = binding;
      writePrivateJson(fixture.journalPath, journal);
      const historical = JSON.parse(JSON.stringify({ ...journal, phase: "committed", acceptedBackendTransition: {
        ...binding, operationId: "0d9fcb3a-1a57-4e0d-9ae4-18ac8b9622c8",
      } }).replaceAll(ACCEPTED_TRANSITION_JOURNAL_ID, "0a5a1d2e-7c3b-4f61-9d48-2b6c8e1f0a93"));
      writePrivateJson(join(dirname(fixture.journalPath), `${historical.id}.json`), historical);
      assert.doesNotThrow(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }));
      if (!provisional) assert.equal(existsSync(join(fixture.userRoot, "runtime-ready-expectation.json")), false);
      // Admitting transition metadata must not weaken the materialized generation guard.
      appendFileSync(join(fixture.userRoot, "runtime", "marker"), "tamper");
      assert.throws(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }), /generation fingerprint mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("official supplied-backend journal admits exact bootstrap and retains generation and root guards", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-transition-bootstrap-")));
  try {
    const fixture = derivedVariantBootstrapFixture(root, 3, true, ACCEPTED_TRANSITION_JOURNAL_ID);
    const legacy = producedAcceptedTransition(root, fixture);
    const source = legacy.lane.authority.sourceApp.path;
    const backendPath = "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" as const;
    const helperPath = "Contents/Resources/codex-cli/bin/codex-code-mode-host" as const;
    const seal = {sha256: "1".repeat(64), entries: 4, bytes: "100"};
    const bare: Omit<OfficialBundledCandidateAuthorityV2, "payloadIdentity"> = {
      schemaVersion: 2, kind: "official-bundled", transactionId: "official-bootstrap", installerPayloadHash: "2".repeat(64),
      backend: {sourcePath: join(source, backendPath), sha256: "3".repeat(64), version: "0.162.0-alpha.17.2", architecture: "arm64", certificateSha1: "A".repeat(40)},
      closure: {kind: "official-bundled", sourceAppRoot: source, resourceRelativePath: "Contents/Resources/codex-cli", resourceTree: seal,
        backend: {relativePath: backendPath, sha256: "3".repeat(64), certificateSha1: "A".repeat(40)},
        codeModeHost: {relativePath: helperPath, sha256: "4".repeat(64), certificateSha1: "B".repeat(40)}},
      nativePackage: {relativePath: "Contents/Resources/codex-cli/codex-package.json", sha256: "5".repeat(64), layoutVersion: 1, version: "0.162.0-alpha.17.2", target: "aarch64-apple-darwin"},
      runtime: {...legacy.lane.authority.runtime, adapterVersion: "official-bundled-adapter-v1"},
      sourceApp: {...legacy.lane.authority.sourceApp, treeSeal: seal},
    };
    const binding = {operationId: legacy.operationId, lane: {version: 2 as const, resolverProtocol: "official-bundled-v1" as const,
      identity: legacy.lane.identity, priorRegistrationFingerprint: legacy.lane.priorRegistrationFingerprint,
      priorResolverBinarySha256: legacy.lane.priorResolverBinarySha256,
      authority: {...bare, payloadIdentity: createHash("sha256").update(acceptedOfficialBundledPayloadText(bare)).digest("hex")}}};
    const journal = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
    writePrivateJson(fixture.journalPath, {...journal, acceptedBackendTransition: binding});
    assert.doesNotThrow(() => assertTweakersVariantBootstrap({environment: fixture.environment, resourcesPath: fixture.resourcesPath}));
    writePrivateJson(fixture.journalPath, {...journal, acceptedBackendTransition: {...binding, lane: {...binding.lane,
      identity: {...binding.lane.identity, target: join(root, "foreign.app")}}}});
    assert.throws(() => assertTweakersVariantBootstrap({environment: fixture.environment, resourcesPath: fixture.resourcesPath}), /bind its journal/);
    writePrivateJson(fixture.journalPath, {...journal, acceptedBackendTransition: binding});
    appendFileSync(join(fixture.userRoot, "runtime", "marker"), "tamper");
    assert.throws(() => assertTweakersVariantBootstrap({environment: fixture.environment, resourcesPath: fixture.resourcesPath}), /generation fingerprint mismatch/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("accepted runtime repair schema6 uses exact producer journal projection provisionally and after commit", () => {
  for (const committed of [false, true]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "accepted-runtime-repair-projection-")));
    try {
      const fixture = derivedVariantBootstrapFixture(root, 3, true, ACCEPTED_TRANSITION_JOURNAL_ID);
      const configPath = join(fixture.userRoot, "config.json"), originalConfigBytes = readFileSync(configPath);
      chmodSync(configPath, 0o600);
      const binding = producedAcceptedTransition(root, fixture);
      markFixtureProvisionallyPromoted(fixture);
      const original = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
      original.entries.find((entry: any) => entry.name === "config.json").desired = fingerprintTweakersVariantGeneration(configPath);
      original.acceptedBackendTransition = binding;
      original.activeReceipt.hadDestination = true;
      original.activeReceipt.previous = fingerprintTweakersVariantGeneration(fixture.stagedActivePath);
      writePrivateJson(fixture.activePath, original.activeReceipt.expected);
      writePrivateJson(fixture.journalPath, original);
      appendFileSync(join(fixture.userRoot, "runtime", "marker"), "repaired-runtime");
      const repaired = fingerprintTweakersVariantGeneration(join(fixture.userRoot, "runtime"));
      const repairId = "00000000-0000-4000-8000-000000000003", hash = "a".repeat(64);
      const childRoot = join(fixture.userRoot, "builds", original.id, "runtime-repair", "accepted", "operations", repairId);
      mkdirSync(childRoot, { recursive: true, mode: 0o700 });
      const readyBinding = { repairId, headSha256: hash, intentSha256: hash, authorityReceiptSha256: hash };
      const effectiveActive = { ...original.activeReceipt.expected, version: 4,
        runtimeRepair: { repairId, authorityReceiptSha256: hash },
        entries: original.activeReceipt.expected.entries.map((entry: any) => entry.name === "runtime" ? { ...entry, fingerprint: repaired } : entry) };
      const source = join(childRoot, "effective-active-receipt.json");
      writePrivateJson(source, effectiveActive);
      const desired = fingerprintTweakersVariantGeneration(source);
      const effectiveJournal = { ...original, phase: "committed",
        entries: original.entries.map((entry: any) => entry.name === "runtime" ? { ...entry, desired: repaired } : entry),
        activeReceipt: { ...original.activeReceipt, source, archive: join(childRoot, "prior-active-receipt.json"),
          failed: join(childRoot, "failed-active-receipt.json"), desired, expected: effectiveActive } };
      const projection = { head: { operationId: binding.operationId, promotionId: original.id, repairId },
        intent: { authority: { repairedRuntime: { generation: repaired, evidence: { fingerprint: hash } } } },
        phase: committed ? "committed" : "challenge:published", runtimeRepair: readyBinding,
        originalJournal: original, effectiveJournal, effectiveActiveReceipt: effectiveActive, childRoot,
        originalOperationCompleted: false,
      } as unknown as AcceptedRuntimeRepairBootstrapProjection;
      const path = join(fixture.userRoot, "runtime-ready-expectation.json");
      const expectation = { ...JSON.parse(readFileSync(path, "utf8")), schemaVersion: 6, operationId: binding.operationId,
        accountsBrokerRoot: binding.lane.identity.brokerRoot, activePromotionReceiptSha256: desired.sha256, runtimeRepair: readyBinding };
      writePrivateJson(path, expectation);
      if (committed) { writePrivateJson(fixture.activePath, effectiveActive); rmSync(path); }
      const options = { environment: fixture.environment, resourcesPath: fixture.resourcesPath, runtimeRepairVerifier: () => projection };
      assert.equal(assertTweakersVariantBootstrap(options)?.phase, projection.phase);
      const wrongEffective = structuredClone(projection);
      // Replace only the projected runtime generation; shared original receipt objects remain valid.
      (wrongEffective.effectiveJournal as any).entries = (wrongEffective.effectiveJournal as any).entries.map((entry: any) =>
        entry.name === "runtime" ? { ...entry, desired: { ...entry.desired, sha256: "b".repeat(64) } } : entry);
      assert.throws(() => assertTweakersVariantBootstrap({ ...options, runtimeRepairVerifier: () => wrongEffective }), /projection changed/);
      if (!committed) {
        writePrivateJson(path, { ...expectation, runtimeRepair: { ...readyBinding, headSha256: "b".repeat(64) } });
        assert.throws(() => assertTweakersVariantBootstrap(options), /readiness challenge changed/);
        writePrivateJson(path, expectation);
      }
      writePrivateJson(join(fixture.userRoot, "config.json"), { tweaker: { autoUpdate: false }, tweaks: { "com.example.tweak": { enabled: false } } });
      assert.throws(() => assertTweakersVariantBootstrap(options), /generation changed/);
      if (committed) {
        projection.originalOperationCompleted = true;
        assert.equal(assertTweakersVariantBootstrap(options)?.phase, "committed");
        writePrivateJson(join(fixture.userRoot, "config.json"), { tweaks: { "com.example.tweak": { enabled: "forged" } } });
        assert.throws(() => assertTweakersVariantBootstrap(options), /toggle is malformed/);
        writePrivateJson(join(fixture.userRoot, "config.json"), { tweaks: { "com.example.tweak": { enabled: true } } });
      } else {
        projection.originalOperationCompleted = true;
        assert.throws(() => assertTweakersVariantBootstrap(options), /generation changed/);
        projection.originalOperationCompleted = false;
        // Restore its exact original fixture bytes before the independent tweak check.
        writeFileSync(configPath, originalConfigBytes);
      }
      appendFileSync(join(fixture.userRoot, "tweaks", "marker"), "tamper");
      assert.throws(() => assertTweakersVariantBootstrap(options), /generation changed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("accepted backend bootstrap rejects present null and malformed known nested authority even with recomputed payload hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "accepted-transition-malformed-"));
  try {
    const fixture = derivedVariantBootstrapFixture(root);
    const binding = producedAcceptedTransition(root, fixture);
    const original = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
    const rehash = (mutate: (b: AcceptedBackendTransitionJournalBindingV1) => void) => (b: AcceptedBackendTransitionJournalBindingV1): unknown => {
      mutate(b);b.lane.authority.payloadIdentity = combinedPayloadIdentity(b.lane.authority);return b;
    };
    const mutations: Array<[string, (b: AcceptedBackendTransitionJournalBindingV1) => unknown]> = [
      ["present null", () => null],
      ["unknown binding key", b => ({ ...b, unexpected: true })],
      ["unknown lane key", b => ({ ...b, lane: { ...b.lane, unexpected: true } })],
      ["lane version", b => ({ ...b, lane: { ...b.lane, version: 2 } })],
      ["non UUID operation", b => ({ ...b, operationId: "runtime-proof" })],
      ["noncanonical identity", b => ({ ...b, lane: { ...b.lane, identity: { ...b.lane.identity, brokerRoot: "/tmp/../broker" } } })],
      ["unknown receipt key", rehash(b => { Object.assign(b.lane.authority.acceptedBuildReceipt, { unexpected: true }); })],
      ["unknown signature key", rehash(b => { Object.assign(b.lane.authority.backend.signature, { unexpected: true }); })],
      ["unknown helper key", rehash(b => { Object.assign(b.lane.authority.closure.codeModeHost, { unexpected: true }); })],
      ["unknown runtime key", rehash(b => { Object.assign(b.lane.authority.runtime, { unexpected: true }); })],
      ["unknown source app key", rehash(b => { Object.assign(b.lane.authority.sourceApp, { unexpected: true }); })],
      ["unknown test evidence key", rehash(b => { Object.assign(b.lane.authority.acceptedBuildReceipt.testEvidence[0]!, { status: "passed" }); })],
      ["wrong helper architecture", rehash(b => { Object.assign(b.lane.authority.closure.codeModeHost, { architecture: "x64" }); })],
      ["noncanonical receipt path", rehash(b => { b.lane.authority.acceptedBuildReceipt.path = "/tmp/../accepted-build.json"; })],
      ["traversal resource", rehash(b => { b.lane.authority.closure.resources = [{ relativePath: "../resource", sourcePath: "/tmp/resource", sha256: "a".repeat(64) }]; })],
      ["unchanged backend", b => ({ ...b, lane: { ...b.lane, priorResolverBinarySha256: b.lane.authority.backend.sha256 } })],
      ["invalid upstream", rehash(b => { b.lane.authority.acceptedBuildReceipt.upstream.tag = "rust-v0.1.0"; })],
      ["payload tamper", b => { b.lane.authority.runtime.fileCount++;return b; }],
    ];
    for (const [label, mutate] of mutations) {
      writePrivateJson(fixture.journalPath, { ...original, acceptedBackendTransition: mutate(structuredClone(binding)) });
      assert.throws(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }), /accepted backend transition|Accepted backend transition/, label);
    }
    writePrivateJson(fixture.journalPath, { ...original, acceptedBackendTransition: binding, unknownJournalField: true });
    assert.throws(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }), /invalid promotion journal schema/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted backend provisional bootstrap binds journal identity and the current operation and broker", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "accepted-transition-cross-binding-")));
  try {
    const fixture = derivedVariantBootstrapFixture(root, 3, true, ACCEPTED_TRANSITION_JOURNAL_ID);
    const binding = producedAcceptedTransition(root, fixture);
    markFixtureProvisionallyPromoted(fixture);
    const expectationPath = join(fixture.userRoot, "runtime-ready-expectation.json");
    const expectation = JSON.parse(readFileSync(expectationPath, "utf8"));
    expectation.operationId = binding.operationId;writePrivateJson(expectationPath, expectation);
    const original = JSON.parse(readFileSync(fixture.journalPath, "utf8"));
    for (const field of ["target", "userRoot"] as const) {
      const changed = structuredClone(binding);changed.lane.identity[field] += "-other";
      writePrivateJson(fixture.journalPath, { ...original, acceptedBackendTransition: changed });
      assert.throws(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }), /does not bind its journal/);
    }
    for (const changed of [
      { ...binding, operationId: "0d9fcb3a-1a57-4e0d-9ae4-18ac8b9622c8" },
      { ...binding, lane: { ...binding.lane, identity: { ...binding.lane.identity, brokerRoot: binding.lane.identity.brokerRoot + "-other" } } },
    ]) {
      writePrivateJson(fixture.journalPath, { ...original, acceptedBackendTransition: changed });
      assert.throws(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }), /does not bind its runtime-ready expectation/);
    }
    writePrivateJson(fixture.journalPath, { ...original, acceptedBackendTransition: binding });
    expectation.promotionId = "other-promotion";writePrivateJson(expectationPath, expectation);
    assert.throws(() => assertTweakersVariantBootstrap({ environment: fixture.environment, resourcesPath: fixture.resourcesPath }), /does not bind the pending promotion/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

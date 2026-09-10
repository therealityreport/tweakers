import assert from "node:assert/strict";
import asar from "@electron/asar";
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

function derivedVariantBootstrapFixture(root: string, version: 2 | 3 = 3): {
  userRoot: string;
  target: string;
  resourcesPath: string;
  environment: NodeJS.ProcessEnv;
  journalPath: string;
  activePath: string;
  stagedActivePath: string;
} {
  const userRoot = join(root, "state");
  const target = join(root, "Tweakers.app");
  const resourcesPath = join(target, "Contents", "Resources");
  const id = "bootstrap-fixture";
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

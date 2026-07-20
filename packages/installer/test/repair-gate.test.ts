import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isConfirmedOfficialUpdateDrift,
  OFFICIAL_CODEX_BUNDLE_ID,
  repair,
  repairWithOutcome,
  type AsarStatFingerprint,
  type OfficialUpdateDriftInput,
} from "../src/commands/repair";
import { readDeferredRepair, writeDeferredRepair } from "../src/deferred-repair";
import { ensureUserPaths } from "../src/paths";
import { readState, writeState, type InstallerState } from "../src/state";
import { transactionLockFile } from "../src/transaction";
import { readAutoRepairState } from "../src/auto-repair-state";
import { lifecycleLockFile } from "../src/lifecycle-lock";
import { acquireProcessLock } from "../src/process-lock";

const APP = "/Applications/ChatGPT.app";
const PATCHED_HEADER_HASH = "a".repeat(64);
const REPLACEMENT_HEADER_HASH = "b".repeat(64);

function state(partial: Partial<InstallerState> = {}): InstallerState {
  return {
    codexVersion: "26.707.41301",
    ...partial,
  } as InstallerState;
}

function makeInput(overrides: Partial<OfficialUpdateDriftInput> = {}): OfficialUpdateDriftInput {
  return {
    state: state(),
    codex: {
      appRoot: APP,
      bundleId: OFFICIAL_CODEX_BUNDLE_ID,
      metaPath: `${APP}/Contents/Info.plist`,
      platform: "darwin",
    },
    watcherRepair: true,
    force: false,
    updateModeFile: join(tmpdir(), "tweaker-nonexistent-update-mode.json"),
    readVersion: () => "26.707.51957",
    verifyAppSignature: () => ({
      ok: true,
      adHoc: false,
      authority: ["Developer ID Application: OpenAI, L.L.C. (TEAMID)", "Developer ID Certification Authority"],
    }),
    ...overrides,
  };
}

test("all conditions true → coordinated quit eligible", () => {
  assert.equal(isConfirmedOfficialUpdateDrift(makeInput()), true);
});

test("repair owns the shared lifecycle lease before any fast-path mutation", async () => {
  await withTweakersHome(async (root) => {
    const lock = acquireProcessLock(lifecycleLockFile(root));
    let reconciled = 0;
    let installed = 0;
    try {
      await assert.rejects(
        repairWithOutcome({ quiet: true }, {
          reconcileCliShims: () => { reconciled += 1; },
          install: async () => { installed += 1; },
        }),
        /Another Tweakers lifecycle operation is active/i,
      );
      const watcher = await repairWithOutcome({ watcher: true, quiet: true }, {
        reconcileCliShims: () => { reconciled += 1; },
        install: async () => { installed += 1; },
      });
      assert.deepEqual(watcher, { status: "deferred", reason: "active-transaction" });
      assert.equal(reconciled, 0);
      assert.equal(installed, 0);
    } finally {
      lock.release();
    }
  });
});

test("non-watcher execution → passive hold", () => {
  assert.equal(isConfirmedOfficialUpdateDrift(makeInput({ watcherRepair: false })), false);
});

test("--force → passive hold", () => {
  assert.equal(isConfirmedOfficialUpdateDrift(makeInput({ force: true })), false);
});

test("missing prior state → passive hold", () => {
  assert.equal(isConfirmedOfficialUpdateDrift(makeInput({ state: null })), false);
});

test("wrong bundle id → passive hold", () => {
  const input = makeInput();
  input.codex = { ...input.codex, bundleId: "com.example.other" };
  assert.equal(isConfirmedOfficialUpdateDrift(input), false);
});

test("same version (hash-only tamper) → passive hold", () => {
  assert.equal(
    isConfirmedOfficialUpdateDrift(makeInput({ readVersion: () => "26.707.41301" })),
    false,
  );
});

test("unreadable current or recorded version → passive hold", () => {
  assert.equal(isConfirmedOfficialUpdateDrift(makeInput({ readVersion: () => null })), false);
  assert.equal(
    isConfirmedOfficialUpdateDrift(makeInput({ state: state({ codexVersion: null }) })),
    false,
  );
});

test("bad signature and no fresh update-mode marker → passive hold", () => {
  const noOpenAI = makeInput({
    verifyAppSignature: () => ({ ok: true, adHoc: false, authority: ["Developer ID Application: Someone Else"] }),
  });
  assert.equal(isConfirmedOfficialUpdateDrift(noOpenAI), false);

  const adHoc = makeInput({
    verifyAppSignature: () => ({ ok: true, adHoc: true, authority: [] }),
  });
  assert.equal(isConfirmedOfficialUpdateDrift(adHoc), false);

  const broken = makeInput({
    verifyAppSignature: () => ({ ok: false, adHoc: false, authority: ["Developer ID Application: OpenAI"] }),
  });
  assert.equal(isConfirmedOfficialUpdateDrift(broken), false);

  const throwing = makeInput({
    verifyAppSignature: () => {
      throw new Error("codesign unavailable");
    },
  });
  assert.equal(isConfirmedOfficialUpdateDrift(throwing), false);
});

test("fresh update-mode marker substitutes for the signature check; stale does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "tweaker-update-mode-"));
  try {
    const file = join(dir, "update-mode.json");
    const badSignature = () => ({ ok: false, adHoc: true, authority: [] as string[] });

    writeFileSync(
      file,
      JSON.stringify({ codexVersion: "26.707.51957", appRoot: APP, enabledAt: new Date().toISOString() }),
    );
    assert.equal(
      isConfirmedOfficialUpdateDrift(makeInput({ updateModeFile: file, verifyAppSignature: badSignature })),
      true,
    );

    writeFileSync(
      file,
      JSON.stringify({
        codexVersion: "26.707.51957",
        appRoot: APP,
        enabledAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      }),
    );
    assert.equal(
      isConfirmedOfficialUpdateDrift(makeInput({ updateModeFile: file, verifyAppSignature: badSignature })),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withTweakersHome(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-repair-gate-"));
  const previous = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

interface RepairFixture {
  appRoot: string;
  asarPath: string;
  asarStat: AsarStatFingerprint;
}

function makeRepairFixture(root: string): RepairFixture {
  const appRoot = join(root, "Codex.app");
  const resources = join(appRoot, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "app.asar"), "test asar");
  writeFileSync(
    join(appRoot, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Codex</string>
  <key>CFBundleExecutable</key><string>Codex</string>
  <key>CFBundleIdentifier</key><string>com.openai.codex</string>
  <key>CFBundleShortVersionString</key><string>26.707.41301</string>
</dict></plist>`,
  );
  const asarPath = join(resources, "app.asar");
  const { size, mtimeMs, dev, ino, ctimeMs } = statSync(asarPath);
  return {
    appRoot,
    asarPath,
    asarStat: { size, mtimeMs, dev, ino, ctimeMs, headerHash: PATCHED_HEADER_HASH },
  };
}

function seedRepairState(
  root: string,
  fixture: RepairFixture,
  watcherStatGuardPasses = 0,
  patchedAsarStat: { size: number; mtimeMs: number } = fixture.asarStat,
): void {
  writeState(
    join(root, "state.json"),
    state({
      appRoot: fixture.appRoot,
      patchedAsarHash: PATCHED_HEADER_HASH,
      patchedAsarStat,
      watcher: "none",
      watcherStatGuardPasses,
      // Explicit Tweakers mode: these fixtures model existing patched installs,
      // and the fixture asar is plain text (marker reads as unreadable), so the
      // ChatGPT-mode guard would otherwise infer chatgpt and stand down.
      mode: "tweakers",
    }),
  );
}

async function assertFingerprintFallsThrough(
  root: string,
  fixture: RepairFixture,
  current: AsarStatFingerprint,
): Promise<void> {
  seedRepairState(root, fixture);
  let settles = 0;
  let installs = 0;

  await repair({ watcher: true, quiet: true }, {
    statAsar: () => current,
    readExpectedRuntimeFingerprint: () => "same",
    readActiveRuntimeFingerprint: () => "same",
    waitForSettle: async () => { settles += 1; },
    readHeaderHash: () => ({ headerHash: REPLACEMENT_HEADER_HASH, header: {} }),
    signingAvailable: () => true,
    install: async () => { installs += 1; },
  });

  assert.ok(settles >= 1);
  assert.equal(installs, 1);
}

test("watcher repair yields while a local refresh holds the lock", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    writeFileSync(join(root, "refresh-local.lock"), "1\n");
    const counts = { stats: 0, headers: 0, settles: 0, installs: 0 };

    await repair(
      { watcher: true, quiet: true },
      {
        statAsar: () => {
          counts.stats += 1;
          return { ...fixture.asarStat, mtimeMs: fixture.asarStat.mtimeMs + 1 };
        },
        readHeaderHash: () => {
          counts.headers += 1;
          return { headerHash: "changed", header: {} };
        },
        waitForSettle: async () => {
          counts.settles += 1;
        },
        signingAvailable: () => true,
        install: async () => {
          counts.installs += 1;
        },
        reconcileCliShims: () => assert.fail("watcher repair must not reconcile public CLI shims"),
      },
    );

    assert.deepEqual(counts, { stats: 0, headers: 0, settles: 0, installs: 0 });
  });
});

test("watcher repair yields while an install transaction lock is held", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    const paths = ensureUserPaths();
    writeFileSync(transactionLockFile(paths.transactionStateFile), "1\n");
    const counts = { stats: 0, headers: 0, settles: 0, installs: 0 };

    await repair(
      { watcher: true, quiet: true },
      {
        statAsar: () => {
          counts.stats += 1;
          return { ...fixture.asarStat, mtimeMs: fixture.asarStat.mtimeMs + 1 };
        },
        readHeaderHash: () => {
          counts.headers += 1;
          return { headerHash: "changed", header: {} };
        },
        waitForSettle: async () => {
          counts.settles += 1;
        },
        signingAvailable: () => true,
        install: async () => {
          counts.installs += 1;
        },
      },
    );

    assert.deepEqual(counts, { stats: 0, headers: 0, settles: 0, installs: 0 });
  });
});

test("unchanged asar without verified active runtime bytes enters repair instead of using the fast path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    const counts = { header: 0, tree: 0, settle: 0, processes: 0, installs: 0 };

    await repair(
      { watcher: true, quiet: true },
      {
        statAsar: () => fixture.asarStat,
        readHeaderHash: () => {
          counts.header += 1;
          return { headerHash: PATCHED_HEADER_HASH, header: {} };
        },
        runtimeAssetsMatch: () => {
          counts.tree += 1;
          return true;
        },
        waitForSettle: async () => {
          counts.settle += 1;
        },
        listProcesses: () => {
          counts.processes += 1;
          return [];
        },
        install: async () => {
          counts.installs += 1;
        },
      },
    );

    assert.equal(counts.header, 1);
    assert.equal(counts.tree, 1);
    assert.equal(counts.settle, 1);
    assert.equal(counts.processes, 1);
    assert.equal(counts.installs, 0);
    assert.equal(readState(join(root, "state.json"))?.watcherStatGuardPasses, 0);
  });
});

test("unchanged asar plus equal runtime fingerprint preserves the zero-tree fast path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    let treeChecks = 0;

    await repair({ watcher: true, quiet: true }, {
      statAsar: () => fixture.asarStat,
      readExpectedRuntimeFingerprint: () => "same",
      readActiveRuntimeFingerprint: () => "same",
      isAppRunning: () => true,
      runtimeAssetsMatch: () => {
        treeChecks += 1;
        return true;
      },
    });

    assert.equal(treeChecks, 0);
    assert.equal(readAutoRepairState(root)?.runtime?.status, "current");
  });
});

test("legacy size-and-mtime-only asar fingerprints fall through to full verification", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture, 0, {
      size: fixture.asarStat.size,
      mtimeMs: fixture.asarStat.mtimeMs,
    });
    let settles = 0;
    let installs = 0;

    await repair({ watcher: true, quiet: true }, {
      statAsar: () => fixture.asarStat,
      readExpectedRuntimeFingerprint: () => "same",
      readActiveRuntimeFingerprint: () => "same",
      waitForSettle: async () => { settles += 1; },
      readHeaderHash: () => ({ headerHash: REPLACEMENT_HEADER_HASH, header: {} }),
      signingAvailable: () => true,
      install: async () => { installs += 1; },
    });

    assert.ok(settles >= 1);
    assert.equal(installs, 1);
  });
});

test("malformed asar fingerprints fall through to full verification", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    const malformed = { ...fixture.asarStat, headerHash: "not-a-sha256-digest" };
    seedRepairState(root, fixture, 0, malformed);
    let settles = 0;
    let installs = 0;

    await repair({ watcher: true, quiet: true }, {
      statAsar: () => malformed,
      readExpectedRuntimeFingerprint: () => "same",
      readActiveRuntimeFingerprint: () => "same",
      waitForSettle: async () => { settles += 1; },
      readHeaderHash: () => ({ headerHash: REPLACEMENT_HEADER_HASH, header: {} }),
      signingAvailable: () => true,
      install: async () => { installs += 1; },
    });

    assert.ok(settles >= 1);
    assert.equal(installs, 1);
  });
});

test("same-size atomic asar replacement changes inode and bypasses the fast path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    await assertFingerprintFallsThrough(root, fixture, {
      ...fixture.asarStat,
      ino: fixture.asarStat.ino + 1,
    });
  });
});

test("same-size asar replacement across devices bypasses the fast path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    await assertFingerprintFallsThrough(root, fixture, {
      ...fixture.asarStat,
      dev: fixture.asarStat.dev + 1,
    });
  });
});

test("same-size asar repack changes ctime and bypasses the fast path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    await assertFingerprintFallsThrough(root, fixture, {
      ...fixture.asarStat,
      ctimeMs: fixture.asarStat.ctimeMs + 1,
    });
  });
});

test("same-size in-place asar modification changes its header hash and bypasses the fast path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    await assertFingerprintFallsThrough(root, fixture, {
      ...fixture.asarStat,
      headerHash: REPLACEMENT_HEADER_HASH,
    });
  });
});

test("unchanged asar plus runtime drift records pending while the app is running", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    let settles = 0;
    let installs = 0;

    const outcome = await repairWithOutcome({ watcher: true, quiet: true }, {
      statAsar: () => fixture.asarStat,
      readExpectedRuntimeFingerprint: () => "new",
      readActiveRuntimeFingerprint: () => "old",
      isAppRunning: () => true,
      waitForSettle: async () => { settles += 1; },
      install: async () => { installs += 1; },
    });

    assert.equal(settles, 0);
    assert.equal(installs, 0);
    assert.deepEqual(outcome, { status: "deferred", reason: "runtime-drift-app-running" });
    assert.deepEqual(readAutoRepairState(root)?.runtime, {
      status: "pending",
      expectedFingerprint: "new",
      activeFingerprint: "old",
      checkedAt: readAutoRepairState(root)?.runtime?.checkedAt,
      error: null,
    });
  });
});

test("unchanged asar plus runtime drift stages verified assets after the app closes", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    let treeChecks = 0;
    let staged = 0;

    await repair({ watcher: true, quiet: true }, {
      statAsar: () => fixture.asarStat,
      readExpectedRuntimeFingerprint: () => "new",
      readActiveRuntimeFingerprint: () => staged > 0 ? "new" : "old",
      isAppRunning: () => false,
      waitForSettle: async () => {},
      readHeaderHash: () => ({ headerHash: PATCHED_HEADER_HASH, header: {} }),
      readAsarPatchSchema: () => "current",
      runtimeAssetsMatch: () => {
        treeChecks += 1;
        return false;
      },
      stageAssets: () => { staged += 1; },
      stageBundledTweaks: () => {},
      listProcesses: () => [],
    });

    assert.equal(treeChecks, 1);
    assert.equal(staged, 1);
    assert.equal(readAutoRepairState(root)?.runtime?.status, "current");
  });
});

test("runtime staging without portable fingerprints remains unknown rather than falsely current", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture, 5);
    let staged = 0;

    await repair({ watcher: true, quiet: true }, {
      statAsar: () => fixture.asarStat,
      readExpectedRuntimeFingerprint: () => null,
      readActiveRuntimeFingerprint: () => null,
      isAppRunning: () => false,
      waitForSettle: async () => {},
      readHeaderHash: () => ({ headerHash: PATCHED_HEADER_HASH, header: {} }),
      readAsarPatchSchema: () => "current",
      runtimeAssetsMatch: () => false,
      stageAssets: () => { staged += 1; },
      stageBundledTweaks: () => {},
      listProcesses: () => [],
    });

    assert.equal(staged, 1);
    assert.deepEqual(readAutoRepairState(root)?.runtime, {
      status: "unknown",
      expectedFingerprint: null,
      activeFingerprint: null,
      checkedAt: readAutoRepairState(root)?.runtime?.checkedAt,
      error: null,
    });
  });
});

test("failed runtime staging keeps drift pending with an actionable receipt", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);

    await assert.rejects(
      repair({ watcher: true, quiet: true }, {
        statAsar: () => fixture.asarStat,
        readExpectedRuntimeFingerprint: () => "new",
        readActiveRuntimeFingerprint: () => "old",
        isAppRunning: () => false,
        waitForSettle: async () => {},
        readHeaderHash: () => ({ headerHash: PATCHED_HEADER_HASH, header: {} }),
        readAsarPatchSchema: () => "current",
        runtimeAssetsMatch: () => false,
        stageAssets: () => { throw new Error("atomic replacement failed"); },
        stageBundledTweaks: () => {},
        listProcesses: () => [],
      }),
      /atomic replacement failed/,
    );

    assert.equal(readAutoRepairState(root)?.runtime?.status, "failed");
    assert.equal(readAutoRepairState(root)?.runtime?.activeFingerprint, "old");
    assert.match(readAutoRepairState(root)?.runtime?.error ?? "", /atomic replacement failed/);
  });
});

test("sixth unchanged asar pass without fingerprints runs bounded heavy verification", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture, 5);
    const counts = { header: 0, tree: 0, settle: 0, processes: 0 };

    await repair(
      { watcher: true, quiet: true },
      {
        statAsar: () => fixture.asarStat,
        readHeaderHash: () => {
          counts.header += 1;
          return { headerHash: PATCHED_HEADER_HASH, header: {} };
        },
        runtimeAssetsMatch: () => {
          counts.tree += 1;
          return true;
        },
        waitForSettle: async () => {
          counts.settle += 1;
        },
        listProcesses: () => {
          counts.processes += 1;
          return [];
        },
      },
    );

    assert.equal(counts.processes, 1);
    assert.equal(counts.header, 1);
    assert.equal(counts.tree, 1);
    assert.equal(counts.settle, 1);
    assert.equal(readState(join(root, "state.json"))?.watcherStatGuardPasses, 0);
  });
});

test("changed asar stat falls through to the normal repair path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    let settles = 0;
    let installs = 0;
    let delegatedReconcile: boolean | undefined;

    await repair(
      { watcher: true, quiet: true },
      {
        statAsar: () => ({ ...fixture.asarStat, mtimeMs: fixture.asarStat.mtimeMs + 1 }),
        waitForSettle: async () => {
          settles += 1;
        },
        readHeaderHash: () => ({ headerHash: "changed", header: {} }),
        signingAvailable: () => true,
        reconcileCliShims: () => assert.fail("unblocked watcher repair must not reconcile public CLI shims"),
        install: async (options) => {
          installs += 1;
          delegatedReconcile = options.reconcileCliShims;
        },
      },
    );

    assert.ok(settles >= 1);
    assert.equal(installs, 1);
    assert.equal(delegatedReconcile, false);
  });
});

test("watcher defers repair when local signing is unavailable", async () => {
  await withTweakersHome(async (root) => {
    let installs = 0;
    let notifications = 0;
    const dependencies = {
      install: async () => { installs += 1; },
      signingAvailable: () => false,
      notifySigningUnavailable: () => { notifications += 1; },
    };

    await repair({ watcher: true, quiet: true }, dependencies);
    await repair({ watcher: true, quiet: true }, dependencies);

    assert.equal(installs, 0);
    assert.equal(notifications, 1);
    const markerPath = join(root, "deferred-repair.json");
    const marker = readDeferredRepair(markerPath);
    assert.equal(marker?.reason, "signing-unavailable");
    assert.ok(marker?.codexVersion === null || typeof marker?.codexVersion === "string");
    assert.match(marker?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);
  });
});

test("watcher proceeds when local signing is available", async () => {
  await withTweakersHome(async (root) => {
    let installs = 0;
    let notifications = 0;

    await repair(
      { watcher: true, quiet: true },
      {
        install: async () => { installs += 1; },
        signingAvailable: () => true,
        notifySigningUnavailable: () => { notifications += 1; },
      },
    );

    assert.equal(installs, 1);
    assert.equal(notifications, 0);
    assert.equal(existsSync(join(root, "deferred-repair.json")), false);
  });
});

test("interactive repair clears a deferred marker after install succeeds", async () => {
  await withTweakersHome(async (root) => {
    const markerPath = join(root, "deferred-repair.json");
    writeDeferredRepair(markerPath, {
      reason: "signing-unavailable",
      codexVersion: "26.707.51957",
      at: "2026-07-14T18:00:00.000Z",
    });
    let installs = 0;

    await repair(
      { quiet: true },
      {
        install: async () => { installs += 1; },
        signingAvailable: () => true,
        notifySigningUnavailable: () => assert.fail("interactive repair must not notify"),
        reconcileCliShims: () => {},
      },
    );

    assert.equal(installs, 1);
    assert.equal(readDeferredRepair(markerPath), null);
  });
});

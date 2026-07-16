import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isConfirmedOfficialUpdateDrift,
  OFFICIAL_CODEX_BUNDLE_ID,
  repair,
  type OfficialUpdateDriftInput,
} from "../src/commands/repair";
import { readDeferredRepair, writeDeferredRepair } from "../src/deferred-repair";
import { ensureUserPaths } from "../src/paths";
import { readState, writeState, type InstallerState } from "../src/state";
import { transactionLockFile } from "../src/transaction";

const APP = "/Applications/ChatGPT.app";

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
    updateModeFile: join(tmpdir(), "codexpp-nonexistent-update-mode.json"),
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
  const dir = mkdtempSync(join(tmpdir(), "codexpp-update-mode-"));
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
  asarStat: { size: number; mtimeMs: number };
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
  const { size, mtimeMs } = statSync(asarPath);
  return { appRoot, asarPath, asarStat: { size, mtimeMs } };
}

function seedRepairState(
  root: string,
  fixture: RepairFixture,
  watcherStatGuardPasses = 0,
): void {
  writeState(
    join(root, "state.json"),
    state({
      appRoot: fixture.appRoot,
      patchedAsarHash: "patched",
      patchedAsarStat: fixture.asarStat,
      watcher: "none",
      watcherStatGuardPasses,
      // Explicit Tweakers mode: these fixtures model existing patched installs,
      // and the fixture asar is plain text (marker reads as unreadable), so the
      // ChatGPT-mode guard would otherwise infer chatgpt and stand down.
      mode: "tweakers",
    }),
  );
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

test("unchanged asar watcher pass skips all heavy repair work", async () => {
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
          return { headerHash: "patched", header: {} };
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

    assert.equal(counts.header, 0);
    assert.equal(counts.tree, 0);
    assert.equal(counts.settle, 0);
    assert.equal(counts.processes, 0);
    assert.equal(counts.installs, 0);
    assert.equal(readState(join(root, "state.json"))?.watcherStatGuardPasses, 1);
  });
});

test("sixth unchanged asar watcher pass runs hygiene without an osascript scan", async () => {
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
          return { headerHash: "patched", header: {} };
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
    assert.equal(counts.header, 0);
    assert.equal(counts.tree, 0);
    assert.equal(counts.settle, 0);
    assert.equal(readState(join(root, "state.json"))?.watcherStatGuardPasses, 0);
  });
});

test("changed asar stat falls through to the normal repair path", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedRepairState(root, fixture);
    let settles = 0;
    let installs = 0;

    await repair(
      { watcher: true, quiet: true },
      {
        statAsar: () => ({ ...fixture.asarStat, mtimeMs: fixture.asarStat.mtimeMs + 1 }),
        waitForSettle: async () => {
          settles += 1;
        },
        readHeaderHash: () => ({ headerHash: "changed", header: {} }),
        signingAvailable: () => true,
        install: async () => {
          installs += 1;
        },
      },
    );

    assert.ok(settles >= 1);
    assert.equal(installs, 1);
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
      },
    );

    assert.equal(installs, 1);
    assert.equal(readDeferredRepair(markerPath), null);
  });
});

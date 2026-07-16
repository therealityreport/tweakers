import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repair } from "../src/commands/repair";
import { finalizePromotedModeState, install, refreshLivePartialBackups, type AsarMarker } from "../src/commands/install";
import { refreshLocal } from "../src/commands/refresh-local";
import { cleanupModeArtifacts, shouldSkipRestoreForChatgptMode } from "../src/commands/uninstall";
import { updateCodex } from "../src/commands/update-codex";
import { describeChatgptModeAsar } from "../src/commands/status";
import { runHeldPromotion, type HeldPromotionDeps } from "../src/watcher-held";
import { readState, writeState, type InstallerState } from "../src/state";
import { modeTransitionFile, parkedPayloadRoot, readModeTransition } from "../src/mode-transition";

/** A PID that cannot exist on macOS (pid_max is 99999). */
const DEAD_PID = 987654;

async function withTweakersHome(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mode-awareness-"));
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
  const appRoot = join(root, "ChatGPT.app");
  const resources = join(appRoot, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "app.asar"), "test asar");
  writeFileSync(
    join(appRoot, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>ChatGPT</string>
  <key>CFBundleExecutable</key><string>ChatGPT</string>
  <key>CFBundleIdentifier</key><string>com.openai.codex</string>
  <key>CFBundleShortVersionString</key><string>26.707.41301</string>
</dict></plist>`,
  );
  const asarPath = join(resources, "app.asar");
  const { size, mtimeMs } = statSync(asarPath);
  return { appRoot, asarPath, asarStat: { size, mtimeMs } };
}

function seedState(root: string, fixture: RepairFixture, partial: Partial<InstallerState> = {}): void {
  writeState(join(root, "state.json"), {
    version: "1.0.0",
    installedAt: "2026-07-01T00:00:00.000Z",
    appRoot: fixture.appRoot,
    originalAsarHash: "original",
    patchedAsarHash: "patched",
    codexVersion: "26.707.41301",
    fuseFlipped: false,
    resigned: true,
    originalEntryPoint: "main.js",
    watcher: "none",
    patchedAsarStat: fixture.asarStat,
    ...partial,
  });
}

interface RepairCounters {
  stats: number;
  headers: number;
  settles: number;
  installs: number;
}

function repairDeps(counters: RepairCounters, overrides: Record<string, unknown> = {}) {
  return {
    statAsar: (asarPath: string) => {
      counters.stats += 1;
      const { size, mtimeMs } = statSync(asarPath);
      return { size, mtimeMs: mtimeMs + 1 };
    },
    readHeaderHash: () => {
      counters.headers += 1;
      return { headerHash: "changed", header: {} };
    },
    waitForSettle: async () => {
      counters.settles += 1;
    },
    signingAvailable: () => true,
    install: async () => {
      counters.installs += 1;
    },
    ...overrides,
  };
}

async function captureWarn(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return lines;
}

/* ------------------------------------------------------------------------- */
/* repair guard                                                              */
/* ------------------------------------------------------------------------- */

test("repair stands down FIRST in ChatGPT mode — before the stat guard, settle wait, and install", async () => {
  for (const opts of [
    { watcher: true, quiet: true },
    { quiet: true },
    { force: true, quiet: true },
  ]) {
    await withTweakersHome(async (root) => {
      const fixture = makeRepairFixture(root);
      // patchedAsarStat matches, so a non-guarded watcher pass WOULD hit the
      // stat guard — statAsar staying at 0 proves the mode guard ran first.
      seedState(root, fixture, { mode: "chatgpt" });
      const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

      await repair(opts, repairDeps(counters, { readAsarMarker: (): AsarMarker => "absent" }));

      assert.deepEqual(counters, { stats: 0, headers: 0, settles: 0, installs: 0 });
    });
  }
});

test("repair re-reads the mode immediately before runInstall (closes the settle-wait race)", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, { mode: "tweakers" });
    const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

    await repair(
      { quiet: true },
      repairDeps(counters, {
        readAsarMarker: (): AsarMarker => "absent",
        waitForSettle: async () => {
          counters.settles += 1;
          // A mode switch completes during the (up to 15 minute) settle wait.
          const state = readState(join(root, "state.json"));
          assert.ok(state);
          writeState(join(root, "state.json"), { ...state, mode: "chatgpt" });
        },
      }),
    );

    assert.ok(counters.settles >= 1);
    assert.equal(counters.installs, 0);
  });
});

test("repair proceeds normally in Tweakers mode and when inference says tweakers", async () => {
  for (const seed of [
    { mode: "tweakers" as const, marker: "absent" as AsarMarker }, // post-update drift: must re-patch
    { mode: undefined, marker: "present" as AsarMarker }, // legacy install, patched app
  ]) {
    await withTweakersHome(async (root) => {
      const fixture = makeRepairFixture(root);
      seedState(root, fixture, { mode: seed.mode });
      const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

      await repair({ quiet: true }, repairDeps(counters, { readAsarMarker: () => seed.marker }));

      assert.equal(counters.installs, 1);
    });
  }
});

test("repair stands down via bootstrap inference: missing mode + unpatched app", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, {});
    const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

    await repair({ quiet: true }, repairDeps(counters, { readAsarMarker: (): AsarMarker => "absent" }));

    assert.deepEqual(counters, { stats: 0, headers: 0, settles: 0, installs: 0 });
  });
});

test("repair reconciles a mode/marker mismatch through the journal instead of exiting silently", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    // State claims chatgpt but the live app is patched; the dead-owner journal
    // explains it (an interrupted switch to chatgpt that rolled back).
    seedState(root, fixture, { mode: "chatgpt" });
    mkdirSync(join(root, "mode"), { recursive: true });
    writeFileSync(
      modeTransitionFile(root),
      JSON.stringify({
        schemaVersion: 1,
        target: "chatgpt",
        phase: "swapping",
        ownerPid: DEAD_PID,
        stagedPath: null,
        payloadPath: null,
        startedAt: "2026-07-14T00:00:00.000Z",
      }),
    );
    const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

    await repair({ quiet: true }, repairDeps(counters, { readAsarMarker: (): AsarMarker => "present" }));

    // Reconciliation rewrote reality (mode=tweakers), so repair proceeded.
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.equal(counters.installs, 1);
  });
});

test("repair warns loudly on a mode/marker mismatch without a journal and does not patch", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, { mode: "chatgpt" });
    const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

    const warnings = await captureWarn(() =>
      repair({ quiet: true }, repairDeps(counters, { readAsarMarker: (): AsarMarker => "present" })),
    );

    assert.equal(counters.installs, 0);
    assert.ok(warnings.some((line) => /patch marker/.test(line)));
    assert.ok(warnings.some((line) => /tweakers mode status/.test(line)));
  });
});

test("repair skips while a mode switch is in progress (live journal owner)", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, { mode: "tweakers" });
    mkdirSync(join(root, "mode"), { recursive: true });
    writeFileSync(
      modeTransitionFile(root),
      JSON.stringify({
        schemaVersion: 1,
        target: "chatgpt",
        phase: "swapping",
        ownerPid: 1, // launchd: alive and never this process
        stagedPath: null,
        payloadPath: null,
        startedAt: "2026-07-14T00:00:00.000Z",
      }),
    );
    const counters: RepairCounters = { stats: 0, headers: 0, settles: 0, installs: 0 };

    await repair({ quiet: true }, repairDeps(counters, { readAsarMarker: (): AsarMarker => "present" }));

    assert.equal(counters.installs, 0);
    assert.notEqual(readModeTransition(modeTransitionFile(root)), null);
  });
});

/* ------------------------------------------------------------------------- */
/* install guard                                                             */
/* ------------------------------------------------------------------------- */

test("install refuses in ChatGPT mode without the modeTransition flag", async () => {
  await withTweakersHome(async (root) => {
    writeState(join(root, "state.json"), {
      version: "1.0.0",
      installedAt: "2026-07-01T00:00:00.000Z",
      appRoot: join(root, "ChatGPT.app"),
      originalAsarHash: "original",
      patchedAsarHash: "patched",
      codexVersion: "26.1.0",
      fuseFlipped: false,
      resigned: true,
      originalEntryPoint: "main.js",
      watcher: "none",
      mode: "chatgpt",
    });

    await assert.rejects(() => install({}), /Refusing to install while ChatGPT mode is active/);
    await assert.rejects(() => install({}), /tweakers mode tweakers/);
  });
});

test("install wires the mode machinery: modeTransition bypass, promote finalization, held guard", () => {
  const source = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");
  // The refusal is skipped only for the deliberate mode switch.
  assert.match(source, /!opts\.modeTransition && readState\(paths\.stateFile\)\?\.mode === "chatgpt"/);
  // Promotion records tweakers mode and discards the stale parked payload.
  assert.match(source, /finalizePromotedModeState\(paths\.stateFile, paths\.root\);/);
  // The held-promotion continuation re-checks the mode at entry.
  assert.match(source, /guardModeAllowsPromotion: \(\) => \{/);
});

test("refreshLivePartialBackups replaces stale partials from the full backup", async () => {
  await withTweakersHome(async (root) => {
    const appRoot = join(root, "ChatGPT.app");
    // Live paths only matter for relative mapping into the backup tree.
    const codex = {
      appRoot,
      asarPath: join(appRoot, "Contents", "Resources", "app.asar"),
      metaPath: join(appRoot, "Contents", "Info.plist"),
      electronBinary: join(appRoot, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"),
    };
    const backupDir = join(root, "backup");
    const backupApp = join(backupDir, "Codex.app");
    mkdirSync(join(backupApp, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(backupApp, "Contents", "Resources", "app.asar"), "fresh-asar");
    writeFileSync(join(backupApp, "Contents", "Info.plist"), "fresh-plist");
    // Stale legacy-era partials sitting beside the (newer) full backup.
    writeFileSync(join(backupDir, "app.asar"), "stale-asar");
    writeFileSync(join(backupDir, "Info.plist"), "stale-plist");
    mkdirSync(join(backupDir, "Electron Framework"), { recursive: true });
    writeFileSync(join(backupDir, "Electron Framework", "bin"), "stale-framework");

    refreshLivePartialBackups(codex, backupApp, backupDir);

    assert.equal(readFileSync(join(backupDir, "app.asar"), "utf8"), "fresh-asar");
    assert.equal(readFileSync(join(backupDir, "Info.plist"), "utf8"), "fresh-plist");
    // Absent from the full backup ⇒ the stale partial is removed, never left
    // to grow older than the full backup.
    assert.equal(existsSync(join(backupDir, "Electron Framework")), false);
  });
});

test("install refreshes the LIVE-root partial backups whenever a promotion refreshes the live full backup", () => {
  const source = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");
  // Promoted branch: partials refresh from the newly promoted live backup.
  assert.match(
    source,
    /if \(result\.status === "promoted"\) \{[\s\S]*?refreshLivePartialBackups\(codex, liveSignedBackup, paths\.backup\)/,
  );
});

test("finalizePromotedModeState records tweakers mode and discards the parked payload", async () => {
  await withTweakersHome(async (root) => {
    const stateFile = join(root, "state.json");
    writeState(stateFile, {
      version: "1.0.0",
      installedAt: "2026-07-01T00:00:00.000Z",
      appRoot: join(root, "ChatGPT.app"),
      originalAsarHash: "original",
      patchedAsarHash: "patched",
      codexVersion: "26.1.0",
      fuseFlipped: false,
      resigned: true,
      originalEntryPoint: "main.js",
      watcher: "none",
      mode: "chatgpt",
    });
    mkdirSync(join(parkedPayloadRoot(root), "ChatGPT.app"), { recursive: true });

    finalizePromotedModeState(stateFile, root);

    assert.equal(readState(stateFile)?.mode, "tweakers");
    assert.equal(existsSync(parkedPayloadRoot(root)), false);
  });
});

/* ------------------------------------------------------------------------- */
/* held promotion guard                                                      */
/* ------------------------------------------------------------------------- */

test("held promotion stands down when the mode guard denies it", async () => {
  const lines: string[] = [];
  let reentered = false;
  const deps: HeldPromotionDeps = {
    getReport: () => {
      throw new Error("must not inspect processes when standing down");
    },
    guardModeAllowsPromotion: () => false,
    quitApp: () => {
      throw new Error("must not quit when standing down");
    },
    cleanupOrphans: () => {},
    notifyUpdateQuit: () => {},
    reenter: async () => {
      reentered = true;
    },
    sleep: async () => {},
    log: (line) => lines.push(line),
  };

  await runHeldPromotion(deps, { coordinatedQuit: true });

  assert.equal(reentered, false);
  assert.ok(lines.some((line) => /ChatGPT mode/.test(line)));
});

/* ------------------------------------------------------------------------- */
/* refresh-local guard                                                       */
/* ------------------------------------------------------------------------- */

test("refreshLocal refuses loudly in ChatGPT mode", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, { mode: "chatgpt" });

    await assert.rejects(
      () => refreshLocal({ app: fixture.appRoot }),
      /Refusing to refresh the local app while ChatGPT mode is active/,
    );
  });
});

test("refreshLocal refuses via inference when the app is unpatched and mode is absent", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, {});

    await assert.rejects(
      () => refreshLocal({ app: fixture.appRoot }),
      /Refusing to refresh the local app while ChatGPT mode is active/,
    );
  });
});

/* ------------------------------------------------------------------------- */
/* uninstall mode handling                                                   */
/* ------------------------------------------------------------------------- */

test("uninstall skips the restore only for ChatGPT mode without a live marker", () => {
  const state = { mode: "chatgpt" } as InstallerState;
  assert.equal(shouldSkipRestoreForChatgptMode(state, false), true);
  // A marker despite ChatGPT mode is a reality mismatch — restore normally.
  assert.equal(shouldSkipRestoreForChatgptMode(state, true), false);
  assert.equal(shouldSkipRestoreForChatgptMode({ mode: "tweakers" } as InstallerState, true), false);
  // Inference: modeless + unpatched behaves as chatgpt.
  assert.equal(shouldSkipRestoreForChatgptMode(null, false), true);
  assert.equal(shouldSkipRestoreForChatgptMode(null, true), false);
});

test("uninstall cleanup removes the parked payload and transition journal unconditionally", async () => {
  await withTweakersHome(async (root) => {
    mkdirSync(join(parkedPayloadRoot(root), "ChatGPT.app", "Contents"), { recursive: true });
    writeFileSync(modeTransitionFile(root), "{}");

    cleanupModeArtifacts(root);

    assert.equal(existsSync(parkedPayloadRoot(root)), false);
    assert.equal(existsSync(modeTransitionFile(root)), false);
  });
});

test("uninstall wires the mode cleanup and switcher removal", () => {
  const source = readFileSync(new URL("../src/commands/uninstall.ts", import.meta.url), "utf8");
  assert.match(source, /shouldSkipRestoreForChatgptMode\(state, hasPatchMarker\)/);
  assert.match(source, /cleanupModeArtifacts\(paths\.root\);/);
  assert.match(source, /await removeSwitcher\(\);/);
});

/* ------------------------------------------------------------------------- */
/* update-chatgpt guards                                                     */
/* ------------------------------------------------------------------------- */

test("update-chatgpt is a no-op in ChatGPT mode and refuses in Tweakers mode", async () => {
  await withTweakersHome(async (root) => {
    const fixture = makeRepairFixture(root);
    seedState(root, fixture, { mode: "chatgpt" });

    // ChatGPT mode: Sparkle updates natively — nothing to restore, no throw.
    await updateCodex({ app: fixture.appRoot });
    assert.equal(readFileSync(fixture.asarPath, "utf8"), "test asar");

    seedState(root, fixture, { mode: "tweakers" });
    await assert.rejects(
      () => updateCodex({ app: fixture.appRoot }),
      /Refusing to run update-chatgpt in Tweakers mode/,
    );
    await assert.rejects(() => updateCodex({ app: fixture.appRoot }), /tweakers mode chatgpt/);
  });
});

/* ------------------------------------------------------------------------- */
/* status / doctor pristine reporting                                        */
/* ------------------------------------------------------------------------- */

test("status/doctor report green pristine in ChatGPT mode with the parked payload version", () => {
  const state = { originalAsarHash: "original", patchedAsarHash: "patched" };
  const pristine = describeChatgptModeAsar({
    headerHash: "original",
    state,
    markerPresent: false,
    parkedPayloadVersion: "26.1.0",
    payloadPatchedAsarHash: "patched",
  });
  assert.equal(pristine.tone, "green");
  assert.match(pristine.label, /pristine \(ChatGPT mode; parked payload: 26\.1\.0\)/);

  const noPayload = describeChatgptModeAsar({
    headerHash: "original",
    state,
    markerPresent: false,
    parkedPayloadVersion: null,
    payloadPatchedAsarHash: null,
  });
  assert.match(noPayload.label, /parked payload: none/);
});

test("status/doctor flag a patched live app in ChatGPT mode and reserve drift for neither payload", () => {
  const state = { originalAsarHash: "original", patchedAsarHash: "patched" };

  const patched = describeChatgptModeAsar({
    headerHash: "patched",
    state,
    markerPresent: true,
    parkedPayloadVersion: "26.1.0",
    payloadPatchedAsarHash: "patched",
  });
  assert.equal(patched.tone, "red");
  assert.match(patched.label, /tweakers mode status/);

  // An official update in ChatGPT mode matches neither payload but is NOT drift.
  const updated = describeChatgptModeAsar({
    headerHash: "new-official",
    state,
    markerPresent: false,
    parkedPayloadVersion: "26.1.0",
    payloadPatchedAsarHash: "patched",
  });
  assert.equal(updated.tone, "yellow");
  assert.doesNotMatch(updated.label, /drift/);
  assert.match(updated.label, /official update/);
});

test("pruneRetiredTweaks removes staged retired tweaks and scrubs the dev-snapshot record", async () => {
  await withTweakersHome(async (root) => {
    const { pruneRetiredTweaks } = await import("../src/commands/install");
    const { symlinkSync } = await import("node:fs");
    const tweaksDir = join(root, "tweaks");
    mkdirSync(join(tweaksDir, "mode-switcher"), { recursive: true });
    writeFileSync(join(tweaksDir, "mode-switcher", "index.js"), "// retired\n");
    mkdirSync(join(tweaksDir, "user-questions"), { recursive: true });
    writeFileSync(
      join(tweaksDir, ".codexpp-dev-snapshot.json"),
      `${JSON.stringify({ folders: ["mode-switcher", "user-questions"] })}\n`,
    );

    pruneRetiredTweaks(tweaksDir);

    assert.equal(existsSync(join(tweaksDir, "mode-switcher")), false, "retired staged copy is pruned");
    assert.equal(existsSync(join(tweaksDir, "user-questions")), true, "active tweaks stay");
    const snapshot = JSON.parse(readFileSync(join(tweaksDir, ".codexpp-dev-snapshot.json"), "utf8")) as {
      folders: string[];
    };
    assert.deepEqual(snapshot.folders, ["user-questions"], "snapshot record no longer names the retired folder");

    // A dev symlink into the configured dev root is the developer's live
    // checkout — pruning must leave it alone.
    const devRoot = join(root, "dev-src");
    mkdirSync(join(devRoot, "mode-switcher"), { recursive: true });
    symlinkSync(join(devRoot, "mode-switcher"), join(tweaksDir, "mode-switcher"));
    pruneRetiredTweaks(tweaksDir, { devTweaksRoot: devRoot });
    assert.equal(existsSync(join(tweaksDir, "mode-switcher")), true, "dev link kept");
  });
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mode, type ModeCommandDeps } from "../src/commands/mode";
import {
  replaceAppBundlePreservingIdentity,
  stageAppBundleReplacement,
  type AsarMarker,
} from "../src/commands/install";
import { readState, resolveMode, writeState, type InstallerState } from "../src/state";
import {
  modeTransitionFile,
  parkedPayloadApp,
  parkedPayloadRoot,
  payloadMetadataFile,
  readModeTransition,
  readPayloadMetadata,
  reconcileModeTransition,
  writePayloadMetadata,
} from "../src/mode-transition";
import { ensureUserPaths } from "../src/paths";
import { transactionLockFile } from "../src/transaction";
import type { EnvironmentCommandResult } from "../src/commands/environment";

/** A PID that cannot exist on macOS (pid_max is 99999). */
const DEAD_PID = 987654;

async function withTweakersHome(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mode-toggle-"));
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

function plistXml(version: string, build = `${version}.9999`): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>ChatGPT</string>
  <key>CFBundleExecutable</key><string>ChatGPT</string>
  <key>CFBundleIdentifier</key><string>com.openai.codex</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
</dict></plist>`;
}

/** Builds a minimal .app tree; the asar body doubles as the marker signal. */
function makeApp(appPath: string, opts: { version: string; build?: string; asar: string }): void {
  const resources = join(appPath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(appPath, "Contents", "MacOS", "ChatGPT"), "#!/bin/sh\n");
  writeFileSync(join(resources, "app.asar"), opts.asar);
  writeFileSync(join(appPath, "Contents", "Info.plist"), plistXml(opts.version, opts.build));
}

function appAsar(appPath: string): string {
  return join(appPath, "Contents", "Resources", "app.asar");
}

/** Fixture asars carry the marker in their body ("patched..." ⇒ present). */
function readMarkerByContent(asarPath: string): AsarMarker {
  try {
    return readFileSync(asarPath, "utf8").includes("patched") ? "present" : "absent";
  } catch {
    return "unreadable";
  }
}

/** Test double for the native renameatx_np Contents exchange. */
function jsSwapDirectories(first: string, second: string): void {
  const temp = `${second}.tweakers-test-swap`;
  renameSync(second, temp);
  renameSync(first, second);
  renameSync(temp, first);
}

function seedState(root: string, partial: Partial<InstallerState>): void {
  writeState(join(root, "state.json"), {
    version: "1.0.0",
    installedAt: "2026-07-01T00:00:00.000Z",
    appRoot: "",
    originalAsarHash: "original-hash",
    patchedAsarHash: "patched-hash",
    codexVersion: "26.1.0",
    fuseFlipped: false,
    resigned: true,
    originalEntryPoint: "main.js",
    watcher: "none",
    ...partial,
  });
}

function makeDeps(overrides: Partial<ModeCommandDeps> = {}): { deps: ModeCommandDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ModeCommandDeps = {
    platform: () => "darwin",
    readMarker: readMarkerByContent,
    isAppRunning: () => false,
    quitApp: () => {
      calls.push("quit");
    },
    openApp: () => {
      calls.push("open");
    },
    waitForSettle: async () => {
      calls.push("settle");
    },
    confirm: () => true,
    notify: (title) => {
      calls.push(`notify:${title}`);
    },
    swapDirectories: jsSwapDirectories,
    verifyDeep: () => ({ ok: true, output: "" }),
    signature: () => ({
      ok: true,
      adHoc: false,
      teamIdentifier: "2DC432GLL2",
      authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
      output: "",
    }),
    isDeveloperIdBackup: (appRoot) => existsSync(join(appRoot, "Contents")),
    spawnHealthProbe: () => {
      calls.push("probe");
    },
    ensureSwitcher: async () => {
      calls.push("ensure-switcher");
      return { installed: true };
    },
    switcherStatus: async () => ({ installed: false, reason: "test stub" }),
    ensureCoordinator: async () => {
      calls.push("ensure-coordinator");
      return { configured: true };
    },
    coordinatorStatus: () => ({ configured: false, source: "unavailable", reason: "test stub" }),
    removeStandaloneSwitcher: async () => {
      calls.push("remove-standalone");
      return { removed: true };
    },
    installApp: async () => {
      calls.push("install");
    },
    legacyModeEngineForTests: true,
    ...overrides,
  };
  return { deps, calls };
}

/**
 * Seed a journal owned by ANOTHER process: writeModeTransition (correctly)
 * stamps ownerPid with process.pid, so foreign journals are written raw.
 */
function seedForeignJournal(root: string, journal: Record<string, unknown>): void {
  const file = modeTransitionFile(root);
  mkdirSync(join(root, "mode"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
}

async function captureLog(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

function compatibilityEnvironmentResult(
  phase: "status" | "prepared" | "committed" | "cancelled",
): EnvironmentCommandResult {
  const source = {
    selectedDesktopPath: "/Applications/ChatGPT.app",
    selectedDesktopBundleId: "com.openai.codex",
    releaseProfile: "stable",
    appExperience: "tweakers",
    backendLane: "bundled",
    requestedAt: "2026-07-16T00:00:00.000Z",
    appliedAt: "2026-07-16T00:01:00.000Z",
  };
  const requested = {
    ...source,
    appExperience: "chatgpt",
    backendLane: "official-bundled",
    requestedAt: "2026-07-16T00:02:00.000Z",
    appliedAt: phase === "committed" ? "2026-07-16T00:03:00.000Z" : null,
  };
  if (phase === "status") {
    return {
      schemaVersion: 1,
      selected: source,
      channels: { stable: {}, alpha: {} },
      observation: {
        appExperience: source.appExperience,
        selectionDrift: false,
        lifecycleContended: false,
        commitJournalPresent: false,
        transitionJournalPresent: false,
        transaction: null,
        freshness: "current",
      },
    } as unknown as EnvironmentCommandResult;
  }
  return {
    schemaVersion: 1,
    kind: "environment",
    transactionId: "mode-compatibility-1",
    phase,
    error: null,
    ownerPid: process.pid,
    source,
    requested,
    prepared: {},
    applied: phase === "committed" ? {} : null,
    oldMainPid: 101,
    newMainPid: phase === "committed" ? 202 : null,
    attempt: phase === "committed" ? 1 : 0,
    createdAt: "2026-07-16T00:02:00.000Z",
    updatedAt: "2026-07-16T00:03:00.000Z",
    committedAt: phase === "committed" ? "2026-07-16T00:03:00.000Z" : null,
    rolledBackAt: null,
    cancelledAt: phase === "cancelled" ? "2026-07-16T00:03:00.000Z" : null,
  } as unknown as EnvironmentCommandResult;
}

/* ------------------------------------------------------------------------- */
/* bootstrap inference                                                       */
/* ------------------------------------------------------------------------- */

test("resolveMode: explicit repair intent wins while legacy state is inferred", () => {
  const base = { mode: undefined } as unknown as InstallerState;
  assert.equal(resolveMode({ ...base, mode: "chatgpt" }, true), "chatgpt");
  assert.equal(resolveMode({ ...base, mode: "tweakers" }, false), "tweakers");
  assert.equal(resolveMode(base, true), "tweakers");
  assert.equal(resolveMode(base, false), "chatgpt");
  assert.equal(resolveMode(null, false), "chatgpt");
  assert.equal(resolveMode(null, true), "tweakers");
});

test("production mode compatibility prepares before one confirmation and commits through Environment", async () => {
  await withTweakersHome(async () => {
    const sequence: string[] = [];
    const { deps, calls } = makeDeps({
      legacyModeEngineForTests: false,
      environmentCommand: async (action, options) => {
        sequence.push(`${action}:${options.quiet === true ? "quiet" : "loud"}:${options.observe === true ? "observe" : "mutate"}`);
        if (action === "status") return compatibilityEnvironmentResult("status");
        if (action === "prepare") return compatibilityEnvironmentResult("prepared");
        if (action === "commit") return compatibilityEnvironmentResult("committed");
        throw new Error(`unexpected environment action ${action}`);
      },
      confirm: ({ target, appRoot }) => {
        sequence.push(`confirm:${target}:${appRoot}`);
        return true;
      },
    });

    await mode("chatgpt", {}, deps);

    assert.deepEqual(sequence, [
      "status:quiet:observe",
      "prepare:quiet:mutate",
      "confirm:chatgpt:/Applications/ChatGPT.app",
      "commit:quiet:mutate",
    ]);
    assert.equal(calls.includes("quit"), false);
    assert.equal(calls.includes("open"), false);
  });
});

test("production mode records approval immediately before its environment commit", async () => {
  await withTweakersHome(async () => {
    const observed: Array<{ action: string; approvalAt?: string }> = [];
    const { deps } = makeDeps({
      legacyModeEngineForTests: false,
      now: () => "2026-08-18T12:00:00.000Z",
      environmentCommand: async (action, options) => {
        observed.push({ action, approvalAt: options.approvalAt });
        if (action === "status") return compatibilityEnvironmentResult("status");
        if (action === "prepare") return compatibilityEnvironmentResult("prepared");
        if (action === "commit") return compatibilityEnvironmentResult("committed");
        throw new Error(`unexpected environment action ${action}`);
      },
    });

    await mode("chatgpt", {}, deps);
    assert.deepEqual(observed.map(({ action, approvalAt }) => ({ action, approvalAt })), [
      { action: "status", approvalAt: undefined },
      { action: "prepare", approvalAt: undefined },
      { action: "commit", approvalAt: "2026-08-18T12:00:00.000Z" },
    ]);
  });
});

test("production mode keeps the chatgpt/tweakers command names while carrying a v2 generation through confirmation and warm commit", async () => {
  await withTweakersHome(async () => {
    const sequence: string[] = [];
    const { deps } = makeDeps({
      legacyModeEngineForTests: false,
      now: () => "2026-08-18T12:00:00.000Z",
      environmentCommand: async (action, options) => {
        if (action === "status") {
          sequence.push("status");
          return compatibilityEnvironmentResult("status");
        }
        if (action === "prepare") {
          sequence.push(`prepare:${options.appExperience}:${options.releaseProfile}`);
          return {
            state: "ready",
            receipt: { generationId: "mode-v2-generation" },
          } as unknown as EnvironmentCommandResult;
        }
        if (action === "commit") {
          sequence.push(`commit:${options.transaction}:${options.approvalAt}`);
          return {
            kind: "environment-warm-commit",
            transactionId: "mode-v2-generation",
            phase: "ready",
            sourceMainPid: 101,
            targetMainPid: 202,
            error: null,
          } as unknown as EnvironmentCommandResult;
        }
        throw new Error(`unexpected environment action ${action}`);
      },
      confirm: ({ target, appRoot }) => {
        sequence.push(`confirm:${target}:${appRoot}`);
        return true;
      },
    });

    await mode("chatgpt", {}, deps);

    assert.deepEqual(sequence, [
      "status",
      "prepare:chatgpt:stable",
      "confirm:chatgpt:/Applications/ChatGPT.app",
      "commit:mode-v2-generation:2026-08-18T12:00:00.000Z",
    ]);
  });
});

test("production mode reconciles a persisted-selection and live-marker drift from live truth", async () => {
  await withTweakersHome(async () => {
    const status = compatibilityEnvironmentResult("status") as Extract<
      EnvironmentCommandResult,
      { selected: unknown }
    >;
    status.observation = {
      ...status.observation!,
      appExperience: "chatgpt",
      selectionDrift: true,
    };
    const republished: Array<{ from: string; to: string }> = [];
    const { deps } = makeDeps({
      legacyModeEngineForTests: false,
      environmentCommand: async (action) => {
        if (action === "status") return status;
        throw new Error(`unexpected environment action ${action}`);
      },
      republishSelection: (selected, liveExperience) => {
        republished.push({ from: selected.appExperience, to: liveExperience });
        return { ...selected, appExperience: liveExperience, appliedAt: "2026-08-20T17:00:00.000Z" };
      },
    });

    // The live bytes prove chatgpt while the stale publication says tweakers:
    // the switch republishes from live truth and then recognizes the target
    // as already live instead of dead-ending on "run tweaker repair".
    await mode("chatgpt", {}, deps);
    assert.deepEqual(republished, [{ from: "tweakers", to: "chatgpt" }]);
  });
});

test("production mode cancellation closes the prepared receipt without restarting", async () => {
  await withTweakersHome(async () => {
    const sequence: string[] = [];
    const { deps, calls } = makeDeps({
      legacyModeEngineForTests: false,
      environmentCommand: async (action) => {
        sequence.push(action);
        if (action === "status") return compatibilityEnvironmentResult("status");
        if (action === "prepare") return compatibilityEnvironmentResult("prepared");
        if (action === "cancel") return compatibilityEnvironmentResult("cancelled");
        throw new Error(`unexpected environment action ${action}`);
      },
      confirm: () => {
        sequence.push("confirm");
        return false;
      },
    });

    await mode("chatgpt", {}, deps);

    assert.deepEqual(sequence, ["status", "prepare", "confirm", "cancel"]);
    assert.equal(calls.includes("quit"), false);
    assert.equal(calls.includes("open"), false);
  });
});

/* ------------------------------------------------------------------------- */
/* swap primitive: preserveOutgoing                                          */
/* ------------------------------------------------------------------------- */

test("preserveOutgoing parks the swapped-out Contents after a validated swap", async () => {
  await withTweakersHome(async (root) => {
    const source = join(root, "source.app");
    const destination = join(root, "dest.app");
    const parked = join(root, "parked", "ChatGPT.app");
    makeApp(source, { version: "26.1.0", asar: "pristine-asar" });
    makeApp(destination, { version: "26.1.0", asar: "patched-asar" });

    replaceAppBundlePreservingIdentity(source, destination, {
      swapDirectories: jsSwapDirectories,
      validateDestination: () => true,
      preserveOutgoing: join(parked, "Contents"),
    });

    assert.equal(readFileSync(appAsar(destination), "utf8"), "pristine-asar");
    assert.equal(readFileSync(appAsar(parked), "utf8"), "patched-asar");
    assert.equal(existsSync(`${destination}.tweakers-contents-swap`), false);
  });
});

test("a pre-staged replacement cuts over without copying source Contents after shutdown", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-prestaged-swap-"));
  try {
    const source = join(root, "Source.app");
    const destination = join(root, "ChatGPT.app");
    makeApp(source, { version: "26.1.0", asar: "prepared-patched" });
    makeApp(destination, { version: "26.1.0", asar: "running-official" });

    const incoming = stageAppBundleReplacement(source, destination);
    assert.equal(readFileSync(join(incoming, "Resources", "app.asar"), "utf8"), "prepared-patched");

    // Mutating the original fixture after staging proves cutover consumes the
    // already-staged bytes instead of opening another copy window.
    writeFileSync(appAsar(source), "changed-after-staging");
    replaceAppBundlePreservingIdentity(source, destination, {
      preStagedIncoming: true,
      swapDirectories: jsSwapDirectories,
    });

    assert.equal(readFileSync(appAsar(destination), "utf8"), "prepared-patched");
    assert.equal(existsSync(incoming), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserveOutgoing never parks rejected bytes when validation fails and rolls back", async () => {
  await withTweakersHome(async (root) => {
    const source = join(root, "source.app");
    const destination = join(root, "dest.app");
    const parked = join(root, "parked", "ChatGPT.app");
    makeApp(source, { version: "26.1.0", asar: "pristine-asar" });
    makeApp(destination, { version: "26.1.0", asar: "patched-asar" });

    assert.throws(
      () =>
        replaceAppBundlePreservingIdentity(source, destination, {
          swapDirectories: jsSwapDirectories,
          validateDestination: () => false,
          preserveOutgoing: join(parked, "Contents"),
        }),
      /signature verification failed/,
    );

    assert.equal(readFileSync(appAsar(destination), "utf8"), "patched-asar");
    assert.equal(existsSync(join(parked, "Contents")), false);
    assert.equal(existsSync(`${destination}.tweakers-contents-swap`), false);
  });
});

test("preserveOutgoing keeps the rollback-failure evidence path intact", async () => {
  await withTweakersHome(async (root) => {
    const source = join(root, "source.app");
    const destination = join(root, "dest.app");
    const parked = join(root, "parked", "ChatGPT.app");
    makeApp(source, { version: "26.1.0", asar: "pristine-asar" });
    makeApp(destination, { version: "26.1.0", asar: "patched-asar" });

    let swaps = 0;
    assert.throws(
      () =>
        replaceAppBundlePreservingIdentity(source, destination, {
          swapDirectories: (first, second) => {
            swaps += 1;
            if (swaps > 1) throw new Error("injected rollback failure");
            jsSwapDirectories(first, second);
          },
          validateDestination: () => false,
          preserveOutgoing: join(parked, "Contents"),
        }),
      /atomic rollback failed/,
    );

    // The incoming path is evidence (it holds the outgoing Contents) — it must
    // survive, and nothing may be parked.
    assert.equal(existsSync(`${destination}.tweakers-contents-swap`), true);
    assert.equal(existsSync(join(parked, "Contents")), false);
  });
});

/* ------------------------------------------------------------------------- */
/* tweaker → chatgpt                                                        */
/* ------------------------------------------------------------------------- */

test("mode chatgpt: happy path parks the patched payload and restores pristine", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps({
      swapDirectories: (first, second) => {
        assert.equal(existsSync(app), true);
        jsSwapDirectories(first, second);
        // The app path is never absent: Contents exists right after each swap.
        assert.equal(existsSync(join(app, "Contents")), true);
      },
    });

    await mode("chatgpt", { yes: true, app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "pristine-asar");
    // The parked payload exists and still carries the patch marker.
    const parked = parkedPayloadApp(root);
    assert.equal(readFileSync(appAsar(parked), "utf8"), "patched-asar");
    assert.equal(readMarkerByContent(appAsar(parked)), "present");
    const payload = readPayloadMetadata(payloadMetadataFile(root));
    assert.equal(payload?.baseVersion, "26.1.0");
    assert.equal(payload?.baseBuild, "26.1.0.9999");
    assert.equal(payload?.patchedAsarHash, "patched-hash");
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.includes("quit"));
    assert.ok(calls.includes("settle"));
    assert.ok(calls.includes("open"));
    // The retired standalone status item is no longer a switching dependency.
    assert.equal(calls.includes("ensure-switcher"), false);
  });
});

test("mode chatgpt: runs exactly two deep verifications, none after the swap", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    let deepVerifications = 0;
    let deepVerificationsAtSwap = -1;
    const { deps } = makeDeps({
      verifyDeep: () => {
        deepVerifications += 1;
        return { ok: true, output: "" };
      },
      swapDirectories: (first, second) => {
        deepVerificationsAtSwap = deepVerifications;
        jsSwapDirectories(first, second);
      },
    });

    await mode("chatgpt", { yes: true, app }, deps);

    // Only the swap's validateDestination deep-verifies: the settled-bundle
    // official-pristine check short-circuits on the patch marker before its
    // deep verification, and the post-open console line reuses the swap's
    // result via the cheap identity read instead of another full-bundle walk.
    assert.equal(deepVerifications, 1);
    assert.equal(deepVerifications - deepVerificationsAtSwap, 1, "the single deep verification belongs to the swap itself");
  });
});

test("mode chatgpt: adopts a newer official update that lands during the settle wait", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "official-backup-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    // Any old parked payload and its metadata were built against the app that
    // Sparkle is replacing, so adoption must invalidate both.
    const staleParked = parkedPayloadApp(root);
    makeApp(staleParked, { version: "26.1.0", asar: "patched-stale-asar" });
    writePayloadMetadata(payloadMetadataFile(root), {
      schemaVersion: 1,
      baseVersion: "26.1.0",
      baseBuild: "26.1.0.9999",
      patchedAsarHash: "patched-hash",
      parkedAt: "2026-07-13T00:00:00.000Z",
    });

    const { deps, calls } = makeDeps({
      waitForSettle: async () => {
        rmSync(app, { recursive: true, force: true });
        makeApp(app, { version: "26.2.0", asar: "official-updated-asar" });
      },
      swapDirectories: () => {
        assert.fail("an official update that lands during settle must not be overwritten by the old backup");
      },
    });

    await mode("chatgpt", { yes: true, app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "official-updated-asar");
    assert.equal(readFileSync(appAsar(backup), "utf8"), "official-updated-asar");
    assert.equal(readFileSync(join(root, "backup", "app.asar"), "utf8"), "official-updated-asar");
    assert.equal(existsSync(parkedPayloadRoot(root)), false);
    assert.equal(readPayloadMetadata(payloadMetadataFile(root)), null);
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(readState(join(root, "state.json"))?.codexVersion, "26.2.0");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.includes("open"));
  });
});

test("mode chatgpt: does not adopt newer marketing text with an older Sparkle build", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", build: "5440", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", build: "5440", asar: "official-backup-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    let swaps = 0;
    const { deps } = makeDeps({
      waitForSettle: async () => {
        rmSync(app, { recursive: true, force: true });
        makeApp(app, { version: "26.2.0", build: "5307", asar: "official-conflicting-asar" });
      },
      swapDirectories: (first, second) => {
        swaps += 1;
        jsSwapDirectories(first, second);
      },
    });

    await mode("chatgpt", { yes: true, app }, deps);

    assert.equal(swaps, 1);
    assert.equal(readFileSync(appAsar(app), "utf8"), "official-backup-asar");
    assert.equal(readFileSync(appAsar(backup), "utf8"), "official-backup-asar");
    assert.equal(readFileSync(appAsar(parkedPayloadApp(root)), "utf8"), "official-conflicting-asar");
  });
});

test("mode chatgpt: does not adopt untrusted or invalid replacements from the settle wait", async () => {
  for (const rejection of ["wrong-team", "invalid-signature"] as const) {
    await withTweakersHome(async (root) => {
      const app = join(root, "Applications", "ChatGPT.app");
      makeApp(app, { version: "26.1.0", asar: "patched-asar" });
      const backup = join(root, "backup", "Codex.app");
      makeApp(backup, { version: "26.1.0", asar: "official-backup-asar" });
      seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

      const isReplacement = (appRoot: string): boolean => {
        try {
          return readFileSync(appAsar(appRoot), "utf8") === "settled-replacement-asar";
        } catch {
          return false;
        }
      };
      let swaps = 0;
      const { deps } = makeDeps({
        waitForSettle: async () => {
          rmSync(app, { recursive: true, force: true });
          makeApp(app, { version: "26.2.0", asar: "settled-replacement-asar" });
        },
        verifyDeep: (appRoot) => ({
          ok: !(rejection === "invalid-signature" && isReplacement(appRoot)),
          output: "",
        }),
        signature: (appRoot) => ({
          ok: true,
          adHoc: false,
          teamIdentifier: rejection === "wrong-team" && isReplacement(appRoot) ? "NOTOPENAI" : "2DC432GLL2",
          authority: ["Developer ID Application: Test"],
          output: "",
        }),
        swapDirectories: (first, second) => {
          swaps += 1;
          jsSwapDirectories(first, second);
        },
      });

      await mode("chatgpt", { yes: true, app }, deps);

      assert.equal(swaps, 1, `${rejection}: fallback swap must run`);
      assert.equal(readFileSync(appAsar(app), "utf8"), "official-backup-asar", `${rejection}: live app`);
      assert.equal(readFileSync(appAsar(backup), "utf8"), "official-backup-asar", `${rejection}: backup`);
      assert.equal(
        readFileSync(appAsar(parkedPayloadApp(root)), "utf8"),
        "settled-replacement-asar",
        `${rejection}: unchanged swap path parks the rejected outgoing bundle`,
      );
      assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt", rejection);
      assert.equal(readModeTransition(modeTransitionFile(root)), null, rejection);
    });
  }
});

test("mode chatgpt: does not depend on the retired standalone switcher", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps({
      ensureSwitcher: async () => ({ installed: false, reason: "asset missing" }),
    });
    await mode("chatgpt", { yes: true, app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "pristine-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.equal(calls.includes("ensure-switcher"), false);
  });
});

test("mode chatgpt: refuses a Chromium profile downgrade with an alert", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "25.0.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps();
    await assert.rejects(() => mode("chatgpt", { yes: true, app }, deps), /downgrade the shared Chromium profile/);

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.some((call) => call.startsWith("notify:")));
    // The flow already notified; the top-level wrapper must not double-notify.
    assert.equal(calls.filter((call) => call.startsWith("notify:")).length, 1);
    assert.equal(calls.includes("quit"), false);
  });
});

test("mode chatgpt: refuses a same-marketing-version build downgrade", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", build: "5440", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", build: "5307", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps();
    await assert.rejects(
      () => mode("chatgpt", { yes: true, app }, deps),
      /pristine backup \(26\.1\.0, build 5307\) is older than the installed app \(26\.1\.0, build 5440\)/,
    );

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.some((call) => call.startsWith("notify:")));
    assert.equal(calls.includes("quit"), false);
  });
});

test("mode chatgpt: refuses newer marketing text when the pristine backup build is older", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", build: "5440", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.2.0", build: "5307", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps();
    await assert.rejects(
      () => mode("chatgpt", { yes: true, app }, deps),
      /pristine backup \(26\.2\.0, build 5307\) is older than the installed app \(26\.1\.0, build 5440\)/,
    );

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.some((call) => call.startsWith("notify:")));
    assert.equal(calls.includes("quit"), false);
  });
});

test("mode chatgpt: refuses when the pristine backup is missing or unsigned", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });

    const { deps } = makeDeps();
    await assert.rejects(() => mode("chatgpt", { yes: true, app }, deps), /missing or not Developer ID signed/);
    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
  });
});

test("mode chatgpt: cancelled confirmation leaves everything untouched", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });

    const { deps, calls } = makeDeps({ confirm: () => false });
    await mode("chatgpt", { app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.equal(calls.includes("quit"), false);
  });
});

test("mode chatgpt: already unpatched is a loud no-op that records the mode", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });

    const { deps, calls } = makeDeps();
    const lines = await captureLog(() => mode("chatgpt", { yes: true, app }, deps));

    assert.ok(lines.some((line) => /Already in ChatGPT mode/.test(line)));
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(calls.includes("quit"), false);
  });
});

/* ------------------------------------------------------------------------- */
/* chatgpt → tweakers                                                       */
/* ------------------------------------------------------------------------- */

function seedParkedPayload(root: string, opts: { version: string; asar?: string }): void {
  makeApp(parkedPayloadApp(root), { version: opts.version, asar: opts.asar ?? "patched-asar" });
  writePayloadMetadata(payloadMetadataFile(root), {
    schemaVersion: 1,
    baseVersion: opts.version,
    baseBuild: `${opts.version}.9999`,
    patchedAsarHash: "patched-hash",
    parkedAt: "2026-07-13T00:00:00.000Z",
  });
}

test("mode tweakers: fast path swaps the version-matched payload in and refreshes the backup", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar-v2" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.0.0", asar: "pristine-asar-v1" });
    // Stale live-root partial backup: the full-backup refresh must refresh it
    // too (partials can never be older than the full backup).
    writeFileSync(join(root, "backup", "app.asar"), "stale-partial-asar");
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps({
      installApp: async () => {
        assert.fail("the fast path must not run install()");
      },
    });

    await mode("tweakers", { yes: true, app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    // The backup was refreshed from the swapped-out pristine Contents.
    assert.equal(readFileSync(appAsar(backup), "utf8"), "pristine-asar-v2");
    // The live-root partial backups were refreshed with the full backup.
    assert.equal(readFileSync(join(root, "backup", "app.asar"), "utf8"), "pristine-asar-v2");
    // The outgoing copy is deleted only after the refreshed backup verified.
    assert.equal(existsSync(join(root, "mode", "outgoing-pristine.app")), false);
    // The consumed payload store is discarded.
    assert.equal(existsSync(parkedPayloadRoot(root)), false);
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.includes("probe"));
    assert.ok(calls.includes("open"));
    // The fast path refreshes shared Menu Bar coordinator metadata and retires
    // any leftover second status item.
    assert.ok(calls.includes("ensure-coordinator"));
    assert.ok(calls.includes("remove-standalone"));
    assert.equal(calls.includes("ensure-switcher"), false);
  });
});

test("mode tweakers: a failing Menu Bar coordinator refresh never fails the fast-path switch", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "pristine-asar" });
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps } = makeDeps({
      ensureCoordinator: async () => {
        throw new Error("injected coordinator failure");
      },
    });
    await mode("tweakers", { yes: true, app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
  });
});

test("mode tweakers: an adopted payload without payload.json still takes the fast path", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    // Adopted / crash-orphaned park: bundle present, payload.json missing.
    makeApp(parkedPayloadApp(root), { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps } = makeDeps({
      installApp: async () => {
        assert.fail("the Info.plist version fallback must keep the fast path");
      },
    });

    await mode("tweakers", { yes: true, app }, deps);

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
  });
});

test("mode tweakers: same marketing version with a different build cannot use the parked fast path", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", build: "200", asar: "pristine-asar" });
    makeApp(parkedPayloadApp(root), {
      version: "26.1.0",
      build: "100",
      asar: "patched-stale-asar",
    });
    writePayloadMetadata(payloadMetadataFile(root), {
      schemaVersion: 1,
      baseVersion: "26.1.0",
      baseBuild: "100",
      patchedAsarHash: "patched-hash",
      parkedAt: "2026-07-13T00:00:00.000Z",
    });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    let installs = 0;
    const { deps } = makeDeps({
      installApp: async () => {
        installs += 1;
        assert.equal(existsSync(parkedPayloadRoot(root)), false);
        writeFileSync(appAsar(app), "patched-rebuilt-asar");
      },
    });

    await mode("tweakers", { yes: true, app }, deps);

    assert.equal(installs, 1);
    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-rebuilt-asar");
  });
});

test("mode tweakers: malformed parked build preserves both apps and fails closed", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", build: "200", asar: "pristine-asar" });
    makeApp(parkedPayloadApp(root), {
      version: "26.1.0",
      build: "not-a-build",
      asar: "patched-unknown-asar",
    });
    writePayloadMetadata(payloadMetadataFile(root), {
      schemaVersion: 1,
      baseVersion: "26.1.0",
      baseBuild: "not-a-build",
      patchedAsarHash: "patched-hash",
      parkedAt: "2026-07-13T00:00:00.000Z",
    });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps } = makeDeps({
      installApp: async () => {
        assert.fail("unknown payload identity must not rebuild over either app");
      },
    });

    await assert.rejects(
      () => mode("tweakers", { yes: true, app }, deps),
      /could not be compared safely/,
    );

    assert.equal(readFileSync(appAsar(app), "utf8"), "pristine-asar");
    assert.equal(
      readFileSync(appAsar(parkedPayloadApp(root)), "utf8"),
      "patched-unknown-asar",
    );
  });
});

test("mode tweakers: fast-path backup refresh keeps the previous backup until the staged copy verifies", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar-v2" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.0.0", asar: "pristine-asar-v1" });
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps({
      // The staged sibling copy fails Developer ID verification.
      isDeveloperIdBackup: (appRoot) =>
        !appRoot.includes(".tweakers-incoming") && existsSync(join(appRoot, "Contents")),
    });

    await assert.rejects(
      () => mode("tweakers", { yes: true, app }, deps),
      /Staged pristine backup failed Developer ID verification/,
    );

    // The switch itself LANDED; only housekeeping failed — and is reported so.
    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.ok(calls.includes("notify:Tweakers mode switch completed with warnings"));
    // The previous Developer-ID backup survived untouched.
    assert.equal(readFileSync(appAsar(backup), "utf8"), "pristine-asar-v1");
    // The outgoing pristine copy is KEPT (it may be the only intact payload).
    assert.equal(existsSync(join(root, "mode", "outgoing-pristine.app", "Contents")), true);
    // The consumed payload store is still discarded.
    assert.equal(existsSync(parkedPayloadRoot(root)), false);
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.includes("open"));
  });
});

test("mode tweakers: fast-path backup copy failure never destroys the previous backup", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar-v2" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.0.0", asar: "pristine-asar-v1" });
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps({
      copyApp: () => {
        throw new Error("injected copy failure: disk full");
      },
    });

    await assert.rejects(() => mode("tweakers", { yes: true, app }, deps), /disk full/);

    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    // Old backup intact, outgoing copy kept for the next attempt.
    assert.equal(readFileSync(appAsar(backup), "utf8"), "pristine-asar-v1");
    assert.equal(existsSync(join(root, "mode", "outgoing-pristine.app", "Contents")), true);
    assert.ok(calls.includes("notify:Tweakers mode switch completed with warnings"));
  });
});

test("mode tweakers: fast-path validation failure discards the unusable payload and falls back to the slow path", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const installs: string[] = [];
    const { deps } = makeDeps({
      // Deep verification rejects the swapped-in payload: the swap rolls back
      // atomically, proving the parked bytes unusable.
      verifyDeep: () => ({ ok: false, output: "corrupt" }),
      installApp: async (opts) => {
        installs.push(`install:modeTransition=${opts?.modeTransition === true}`);
        assert.equal(existsSync(parkedPayloadRoot(root)), false, "unusable payload must be discarded before install()");
        writeFileSync(appAsar(app), "patched-asar");
      },
    });

    await mode("tweakers", { yes: true, app }, deps);

    assert.deepEqual(installs, ["install:modeTransition=true"]);
    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("mode tweakers: a failed atomic rollback leaves the journal for the reconciler", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    let swaps = 0;
    const { deps, calls } = makeDeps({
      verifyDeep: () => ({ ok: false, output: "corrupt" }),
      swapDirectories: (first, second) => {
        swaps += 1;
        if (swaps > 1) throw new Error("injected rollback failure");
        jsSwapDirectories(first, second);
      },
    });

    await assert.rejects(() => mode("tweakers", { yes: true, app }, deps), /atomic rollback failed/);

    // The journal survives: reconcileModeTransition owns this end state
    // (blocked classification / swap-remnant adoption).
    assert.notEqual(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.some((call) => call.startsWith("notify:")));
    // No relaunch of an unverifiable bundle.
    assert.equal(calls.includes("open"), false);
  });
});

test("mode chatgpt: refuses when the installer state cannot record the outcome", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.1.0", asar: "pristine-asar" });
    // No state.json: a switch that cannot persist mode="chatgpt" would let the
    // watcher re-patch the pristine app as a "fresh install".

    const { deps, calls } = makeDeps();
    await assert.rejects(
      () => mode("chatgpt", { yes: true, app }, deps),
      /state file is missing or unreadable/,
    );

    // Refused BEFORE any mutation.
    assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
    assert.equal(calls.includes("quit"), false);
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.some((call) => call.startsWith("notify:")));
  });
});

test("mode tweakers: stale parked payload is discarded and the slow path installs", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    seedParkedPayload(root, { version: "25.0.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const calls: string[] = [];
    const { deps } = makeDeps({
      installApp: async (opts) => {
        calls.push(`install:modeTransition=${opts?.modeTransition === true}`);
        assert.equal(existsSync(parkedPayloadRoot(root)), false, "stale payload must be discarded before install()");
        writeFileSync(appAsar(app), "patched-asar");
      },
    });

    await mode("tweakers", { yes: true, app }, deps);

    assert.deepEqual(calls, ["install:modeTransition=true"]);
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("mode tweakers: non-promoting install outcome keeps chatgpt, relaunches pristine, and alerts", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    // A held/candidate-ready outcome returns without patching.
    const { deps, calls } = makeDeps({ installApp: async () => {} });
    await assert.rejects(() => mode("tweakers", { yes: true, app }, deps), /did not complete/);

    assert.equal(readFileSync(appAsar(app), "utf8"), "pristine-asar");
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.includes("open"));
    assert.ok(calls.some((call) => call.startsWith("notify:")));
  });
});

test("mode tweakers: a throwing install (rolled back) keeps chatgpt and rethrows", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps, calls } = makeDeps({
      installApp: async () => {
        throw new Error("injected: promotion health check failed; rolled back");
      },
    });
    await assert.rejects(() => mode("tweakers", { yes: true, app }, deps), /rolled back/);

    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
    assert.ok(calls.includes("open"));
    assert.ok(calls.some((call) => call.startsWith("notify:")));
  });
});

test("mode tweakers: already patched is a loud no-op that records the mode", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "chatgpt" });

    const { deps, calls } = makeDeps();
    const lines = await captureLog(() => mode("tweakers", { yes: true, app }, deps));

    assert.ok(lines.some((line) => /Already in Tweakers mode/.test(line)));
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(calls.includes("quit"), false);
  });
});

/* ------------------------------------------------------------------------- */
/* lock interleaving + platform refusals                                      */
/* ------------------------------------------------------------------------- */

test("mode switches refuse while installer activity or the official updater is live", async () => {
  const cases: Array<{ name: string; seed: (root: string) => void; expect: RegExp }> = [
    {
      name: "transaction lock",
      seed: (root) => {
        const paths = ensureUserPaths();
        writeFileSync(transactionLockFile(paths.transactionStateFile), "1\n");
      },
      expect: /install transaction is running/,
    },
    {
      name: "refresh-local lock",
      seed: (root) => {
        writeFileSync(join(root, "refresh-local.lock"), "1\n");
      },
      expect: /local refresh is running/,
    },
    {
      name: "active transaction state",
      seed: (root) => {
        const file = join(root, "transactions", "app-install.json");
        mkdirSync(join(root, "transactions"), { recursive: true });
        writeFileSync(file, JSON.stringify({ schemaVersion: 1, phase: "promoting", ownerPid: 1 }));
      },
      expect: /install transaction is active/,
    },
    {
      name: "fresh update-mode",
      seed: (root) => {
        writeFileSync(
          join(root, "update-mode.json"),
          JSON.stringify({ enabledAt: new Date().toISOString(), appRoot: "/tmp/x", codexVersion: "26.1.0" }),
        );
      },
      expect: /official ChatGPT updater is mid-flight/,
    },
  ];

  for (const { seed, expect } of cases) {
    await withTweakersHome(async (root) => {
      const app = join(root, "Applications", "ChatGPT.app");
      makeApp(app, { version: "26.1.0", asar: "patched-asar" });
      seedState(root, { appRoot: app, mode: "tweakers" });
      seed(root);
      const { deps, calls } = makeDeps();
      await assert.rejects(() => mode("chatgpt", { yes: true, app }, deps), expect);
      assert.equal(calls.includes("quit"), false);
      assert.equal(readFileSync(appAsar(app), "utf8"), "patched-asar");
      // Refusals run headless behind launchd — every one must notify.
      assert.ok(calls.some((call) => call.startsWith("notify:")), "refusal must surface a notification");
    });
  }
});

test("mode refuses on non-macOS platforms", async () => {
  const { deps } = makeDeps({ platform: () => "linux" });
  await assert.rejects(() => mode("chatgpt", { yes: true }, deps), /only on macOS/);
  await assert.rejects(() => mode("status", {}, deps), /only on macOS/);
});

test("mode rejects unknown targets", async () => {
  const { deps } = makeDeps();
  await assert.rejects(() => mode("wat", {}, deps), /Unknown mode target/);
});

/* ------------------------------------------------------------------------- */
/* mode setup                                                                */
/* ------------------------------------------------------------------------- */

test("mode setup configures Menu Bar controls and retires the standalone status item", async () => {
  await withTweakersHome(async () => {
    const { deps, calls } = makeDeps();
    const lines = await captureLog(() => mode("setup", {}, deps));

    assert.deepEqual(calls, ["ensure-coordinator", "remove-standalone"]);
    assert.ok(lines.some((line) => /Menu Bar restart coordinator configured/.test(line)));
    assert.ok(lines.some((line) => /existing Menu Bar app/.test(line)));
  });
});

test("mode setup fails loudly when coordinator metadata cannot be configured", async () => {
  await withTweakersHome(async () => {
    const { deps } = makeDeps({
      ensureCoordinator: async () => ({ configured: false, reason: "metadata write refused" }),
    });
    await assert.rejects(
      () => mode("setup", {}, deps),
      /Menu Bar restart coordinator setup failed: metadata write refused/,
    );
  });
});

/* ------------------------------------------------------------------------- */
/* interrupted-transition reconciliation                                     */
/* ------------------------------------------------------------------------- */

test("reconcile: dead-owner switch to chatgpt completes and adopts the swap remnant as payload", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "pristine-asar" });
    // Crash between swap and park: the outgoing patched Contents sit at the
    // stable swap path.
    const leftover = `${app}.tweakers-contents-swap`;
    mkdirSync(join(leftover, "Resources"), { recursive: true });
    writeFileSync(join(leftover, "Resources", "app.asar"), "patched-asar");
    writeFileSync(join(leftover, "Info.plist"), plistXml("26.1.0"));
    const staged = join(root, "mode", "staged-pristine.app");
    mkdirSync(staged, { recursive: true });
    seedState(root, { appRoot: app, mode: "tweakers" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "swapping",
      ownerPid: DEAD_PID,
      stagedPath: staged,
      payloadPath: parkedPayloadApp(root),
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = reconcileModeTransition(
      { root, stateFile: join(root, "state.json") },
      { marker: "absent", appRoot: app },
      { isProcessAlive: () => false },
    );

    assert.deepEqual(result, { action: "completed", mode: "chatgpt" });
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
    assert.equal(readFileSync(join(parkedPayloadApp(root), "Contents", "Resources", "app.asar"), "utf8"), "patched-asar");
    // The adopt writes payload.json from the adopted bundle so the fast path
    // back and `mode status` agree on the payload's version.
    const adoptedMeta = readPayloadMetadata(payloadMetadataFile(root));
    assert.equal(adoptedMeta?.baseVersion, "26.1.0");
    assert.equal(adoptedMeta?.baseBuild, "26.1.0.9999");
    assert.equal(adoptedMeta?.patchedAsarHash, "patched-hash");
    assert.equal(existsSync(staged), false);
    assert.equal(existsSync(leftover), false);
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("reconcile: dead-owner completed switch to tweaker adopts the outgoing pristine copy into the backup", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.0.0", asar: "pristine-asar-v1" });
    // Owner died between the swap and the backup refresh: the swapped-out
    // pristine official app sits at the staged path — the freshest (and
    // possibly only intact) Developer-ID payload.
    const outgoing = join(root, "mode", "outgoing-pristine.app");
    makeApp(outgoing, { version: "26.1.0", asar: "pristine-asar-v2" });
    mkdirSync(join(parkedPayloadApp(root), "Contents"), { recursive: true });
    seedState(root, { appRoot: app, mode: "chatgpt" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "tweakers",
      phase: "swapping",
      ownerPid: DEAD_PID,
      stagedPath: outgoing,
      payloadPath: parkedPayloadApp(root),
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = reconcileModeTransition(
      { root, stateFile: join(root, "state.json") },
      { marker: "present", appRoot: app },
      { isProcessAlive: () => false, isDeveloperIdBackup: (appRoot) => existsSync(join(appRoot, "Contents")) },
    );

    assert.deepEqual(result, { action: "completed", mode: "tweakers" });
    // The backup was refreshed from the outgoing copy, not destroyed with it.
    assert.equal(readFileSync(appAsar(backup), "utf8"), "pristine-asar-v2");
    assert.equal(existsSync(outgoing), false);
    // The consumed payload store is still discarded.
    assert.equal(existsSync(parkedPayloadRoot(root)), false);
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("reconcile: an unverifiable outgoing copy is discarded, never adopted into the backup", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.0.0", asar: "pristine-asar-v1" });
    const outgoing = join(root, "mode", "outgoing-pristine.app");
    makeApp(outgoing, { version: "26.1.0", asar: "tampered-asar" });
    seedState(root, { appRoot: app, mode: "chatgpt" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "tweakers",
      phase: "swapping",
      ownerPid: DEAD_PID,
      stagedPath: outgoing,
      payloadPath: parkedPayloadApp(root),
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = reconcileModeTransition(
      { root, stateFile: join(root, "state.json") },
      { marker: "present", appRoot: app },
      { isProcessAlive: () => false, isDeveloperIdBackup: () => false },
    );

    assert.deepEqual(result, { action: "completed", mode: "tweakers" });
    assert.equal(readFileSync(appAsar(backup), "utf8"), "pristine-asar-v1");
    assert.equal(existsSync(outgoing), false);
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("reconcile: dead-owner switch that never landed rolls back to the source mode", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    mkdirSync(parkedPayloadApp(root), { recursive: true });
    seedState(root, { appRoot: app, mode: "chatgpt" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "preparing",
      ownerPid: DEAD_PID,
      stagedPath: join(root, "mode", "staged-pristine.app"),
      payloadPath: parkedPayloadApp(root),
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = reconcileModeTransition(
      { root, stateFile: join(root, "state.json") },
      { marker: "present", appRoot: app },
      { isProcessAlive: () => false },
    );

    assert.deepEqual(result, { action: "rolled-back", mode: "tweakers" });
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    // A partially created park is garbage while the live app is still patched.
    assert.equal(existsSync(parkedPayloadRoot(root)), false);
    assert.equal(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("reconcile: a live owner reports in-progress and blocks new switches", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "swapping",
      ownerPid: DEAD_PID,
      stagedPath: null,
      payloadPath: null,
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = reconcileModeTransition(
      { root, stateFile: join(root, "state.json") },
      { marker: "present", appRoot: app },
      { isProcessAlive: () => true },
    );
    assert.deepEqual(result, { action: "in-progress", ownerPid: DEAD_PID });
    assert.notEqual(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("reconcile: an unreadable live asar blocks classification and keeps the journal", async () => {
  await withTweakersHome(async (root) => {
    seedState(root, { appRoot: join(root, "x.app"), mode: "tweakers" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "swapping",
      ownerPid: DEAD_PID,
      stagedPath: null,
      payloadPath: null,
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = reconcileModeTransition(
      { root, stateFile: join(root, "state.json") },
      { marker: "unreadable" },
      { isProcessAlive: () => false },
    );
    assert.equal(result.action, "blocked");
    assert.notEqual(readModeTransition(modeTransitionFile(root)), null);
  });
});

test("mode status reports a stale journal without mutating transition or state", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "chatgpt" }); // mismatch: journal explains it
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "preparing",
      ownerPid: DEAD_PID,
      stagedPath: null,
      payloadPath: null,
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const { deps } = makeDeps();
    const lines = await captureLog(() => mode("status", { json: true, app }, deps));
    const report = JSON.parse(lines.at(-1) ?? "{}") as {
      mode: string;
      modeSource: string;
      transition: unknown;
    };

    assert.equal(report.mode, "tweakers");
    assert.equal(report.modeSource, "live-marker");
    assert.deepEqual(report.transition, {
      target: "chatgpt",
      phase: "preparing",
      ownerPid: DEAD_PID,
    });
    assert.notEqual(readModeTransition(modeTransitionFile(root)), null);
    assert.equal(readState(join(root, "state.json"))?.mode, "chatgpt");
  });
});

test("malformed mode transition journals fail closed", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });
    mkdirSync(join(root, "mode"), { recursive: true });
    writeFileSync(modeTransitionFile(root), "{not-json\n");

    assert.throws(
      () => readModeTransition(modeTransitionFile(root)),
      /journal is unreadable/i,
    );
    assert.throws(
      () => reconcileModeTransition(
        { root, stateFile: join(root, "state.json") },
        { marker: "present", appRoot: app },
      ),
      /journal is unreadable/i,
    );
    const { deps } = makeDeps();
    await assert.rejects(
      () => mode("status", { json: true, app }, deps),
      /journal is unreadable/i,
    );
    assert.equal(readState(join(root, "state.json"))?.mode, "tweakers");
    assert.equal(readFileSync(modeTransitionFile(root), "utf8"), "{not-json\n");
  });
});

test("mode transition recovery rejects paths outside its private mode root", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });
    const outside = join(root, "must-not-delete.app");
    makeApp(outside, { version: "26.1.0", asar: "evidence" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "swapping",
      ownerPid: DEAD_PID,
      stagedPath: outside,
      payloadPath: parkedPayloadApp(root),
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    assert.throws(
      () => reconcileModeTransition(
        { root, stateFile: join(root, "state.json") },
        { marker: "present", appRoot: app },
        { isProcessAlive: () => false },
      ),
      /journal is invalid/i,
    );
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(modeTransitionFile(root)), true);
  });
});

test("mode switch entry refuses while another switch is in progress", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app, mode: "tweakers" });
    seedForeignJournal(root, {
      schemaVersion: 1,
      target: "chatgpt",
      phase: "swapping",
      ownerPid: 1, // launchd: alive and never this process
      stagedPath: null,
      payloadPath: null,
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    const { deps, calls } = makeDeps();
    await assert.rejects(() => mode("chatgpt", { yes: true, app }, deps), /another mode switch is in progress/);
    assert.equal(calls.includes("quit"), false);
  });
});

/* ------------------------------------------------------------------------- */
/* mode status report                                                        */
/* ------------------------------------------------------------------------- */

test("mode status --json keeps the compatibility switcher key backed by coordinator status", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.2.0", asar: "pristine-asar" });
    const backup = join(root, "backup", "Codex.app");
    makeApp(backup, { version: "26.2.0", asar: "pristine-asar" });
    seedParkedPayload(root, { version: "26.1.0" });
    seedState(root, { appRoot: app, mode: "chatgpt", codexVersion: "26.1.0" });

    const { deps } = makeDeps({
      coordinatorStatus: () => ({ configured: true, source: "coordinator" }),
    });
    const lines = await captureLog(() => mode("status", { json: true, app }, deps));
    const report = JSON.parse(lines.at(-1) ?? "{}") as {
      mode: string;
      modeSource: string;
      liveMarker: string;
      parkedPayload: { present: boolean; baseVersion: string | null };
      backup: { present: boolean; developerIdValid: boolean; version: string | null };
      switcher: { installed: boolean };
      transition: unknown;
    };

    assert.equal(report.mode, "chatgpt");
    assert.equal(report.modeSource, "live-marker");
    assert.equal(report.liveMarker, "absent");
    assert.deepEqual(report.parkedPayload, { present: true, baseVersion: "26.1.0", parkedAt: "2026-07-13T00:00:00.000Z" });
    assert.equal(report.backup.present, true);
    assert.equal(report.backup.developerIdValid, true);
    assert.equal(report.backup.version, "26.2.0");
    assert.equal(report.switcher.installed, true);
    assert.equal(report.transition, null);
  });
});

test("mode status reports live ChatGPT when persisted Tweakers state is stale", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.3.0", asar: "pristine-asar" });
    seedState(root, { appRoot: app, mode: "tweakers", codexVersion: "26.2.0" });

    const { deps } = makeDeps();
    const lines = await captureLog(() => mode("status", { json: true, app }, deps));
    const report = JSON.parse(lines.at(-1) ?? "{}") as {
      mode: string;
      modeSource: string;
      liveMarker: string;
    };

    assert.equal(report.mode, "chatgpt");
    assert.equal(report.modeSource, "live-marker");
    assert.equal(report.liveMarker, "absent");
  });
});

test("mode status infers the mode when state has no mode field", async () => {
  await withTweakersHome(async (root) => {
    const app = join(root, "Applications", "ChatGPT.app");
    makeApp(app, { version: "26.1.0", asar: "patched-asar" });
    seedState(root, { appRoot: app });

    const { deps } = makeDeps();
    const lines = await captureLog(() => mode("status", { json: true, app }, deps));
    const report = JSON.parse(lines.at(-1) ?? "{}") as { mode: string; modeSource: string };

    assert.equal(report.mode, "tweakers");
    assert.equal(report.modeSource, "live-marker");
  });
});

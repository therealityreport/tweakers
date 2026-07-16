import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  dedupeDockPreferences,
  reconcileDock,
  reconcileLaunchServices,
  targetGuiCommand,
} from "../src/macos-app-identity";
import plist from "plist";
import { replaceAppBundlePreservingIdentity } from "../src/commands/install";

const BUNDLE_ID = "com.openai.codex";
const APP_ROOT = "/Applications/ChatGPT.app";

test("app promotion preserves the live app root identity and completely replaces Contents", () => {
  withTempDir((root) => {
    const live = join(root, "ChatGPT.app");
    const candidate = join(root, "candidate.app");
    mkdirSync(join(live, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(candidate, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(live, "Contents", "Resources", "old.txt"), "old");
    writeFileSync(join(candidate, "Contents", "Resources", "new.txt"), "new");
    const inode = statSync(live).ino;

    replaceAppBundlePreservingIdentity(candidate, live, { swapDirectories: testSwapDirectories });

    assert.equal(statSync(live).ino, inode);
    assert.equal(existsSync(join(live, "Contents", "Resources", "old.txt")), false);
    assert.equal(readFileSync(join(live, "Contents", "Resources", "new.txt"), "utf8"), "new");
    assert.equal(existsSync(candidate), true, "promotion must retain the validated candidate");
  });
});

test("first installation creates the complete app when no live root exists", () => {
  withTempDir((root) => {
    const live = join(root, "ChatGPT.app");
    const candidate = join(root, "candidate.app");
    mkdirSync(join(candidate, "Contents"), { recursive: true });
    writeFileSync(join(candidate, "Contents", "Info.plist"), "candidate");

    replaceAppBundlePreservingIdentity(candidate, live);

    assert.equal(readFileSync(join(live, "Contents", "Info.plist"), "utf8"), "candidate");
  });
});

test("failed Contents promotion restores the original app payload", () => {
  withTempDir((root) => {
    const live = join(root, "ChatGPT.app");
    const candidate = join(root, "candidate.app");
    mkdirSync(join(live, "Contents"), { recursive: true });
    mkdirSync(join(candidate, "Contents"), { recursive: true });
    writeFileSync(join(live, "Contents", "version"), "live");
    writeFileSync(join(candidate, "Contents", "version"), "candidate");
    assert.throws(() => replaceAppBundlePreservingIdentity(candidate, live, {
      swapDirectories: () => { throw new Error("injected promotion failure"); },
    }), /injected promotion failure/);

    assert.equal(readFileSync(join(live, "Contents", "version"), "utf8"), "live");
  });
});

test("failed final signature validation atomically restores the original app payload", () => {
  withTempDir((root) => {
    const live = join(root, "ChatGPT.app");
    const candidate = join(root, "candidate.app");
    mkdirSync(join(live, "Contents"), { recursive: true });
    mkdirSync(join(candidate, "Contents"), { recursive: true });
    writeFileSync(join(live, "Contents", "version"), "live");
    writeFileSync(join(candidate, "Contents", "version"), "candidate");

    assert.throws(() => replaceAppBundlePreservingIdentity(candidate, live, {
      swapDirectories: testSwapDirectories,
      validateDestination: () => false,
    }), /signature verification failed/);

    assert.equal(readFileSync(join(live, "Contents", "version"), "utf8"), "live");
  });
});

test("old-payload cleanup failure does not roll back the committed app", () => {
  withTempDir((root) => {
    const live = join(root, "ChatGPT.app");
    const candidate = join(root, "candidate.app");
    mkdirSync(join(live, "Contents"), { recursive: true });
    mkdirSync(join(candidate, "Contents"), { recursive: true });
    writeFileSync(join(live, "Contents", "version"), "live");
    writeFileSync(join(candidate, "Contents", "version"), "candidate");

    const cleanupFailures: Array<{ path: string; error: unknown }> = [];
    replaceAppBundlePreservingIdentity(candidate, live, {
      swapDirectories: testSwapDirectories,
      removeDirectory: (path) => {
        if (existsSync(path)) throw new Error("injected cleanup failure");
        rmSync(path, { recursive: true, force: true });
      },
      onCleanupFailure: (path, error) => cleanupFailures.push({ path, error }),
    });

    assert.equal(readFileSync(join(live, "Contents", "version"), "utf8"), "candidate");
    assert.equal(cleanupFailures.length, 1);
    assert.equal(cleanupFailures[0]?.path, `${live}.tweakers-contents-swap`);
    assert.match(String(cleanupFailures[0]?.error), /injected cleanup failure/);
    assert.equal(existsSync(`${live}.tweakers-contents-swap`), true, "cleanup debt must remain at the stable retry path");
  });
});

test("Dock reconciliation keeps one pinned Codex entry and removes Codex recents only", () => {
  const notes = dockTile("com.apple.Notes", "file:///System/Applications/Notes.app/", 1);
  const firstCodex = dockTile(BUNDLE_ID, "file:///Applications/ChatGPT.app/", 2);
  const duplicateCodex = dockTile(BUNDLE_ID, "file:///Applications/ChatGPT.app/", 3);
  const chromeRecent = dockTile("com.google.Chrome", "file:///Applications/Google%20Chrome.app/", 4);
  const result = dedupeDockPreferences({
    "persistent-apps": [notes, firstCodex, duplicateCodex],
    "recent-apps": [dockTile(BUNDLE_ID, "file:///Applications/ChatGPT.app/", 5), chromeRecent],
    "persistent-others": [{ untouched: true }],
  }, { appRoot: APP_ROOT, bundleId: BUNDLE_ID });

  assert.equal(result.changed, true);
  assert.deepEqual(result.preferences["persistent-apps"], [notes, firstCodex]);
  assert.deepEqual(result.preferences["recent-apps"], [chromeRecent]);
  assert.deepEqual(result.preferences["persistent-others"], [{ untouched: true }]);
  assert.equal(result.removedPersistent, 1);
  assert.equal(result.removedRecent, 1);

  const repeated = dedupeDockPreferences(result.preferences, { appRoot: APP_ROOT, bundleId: BUNDLE_ID });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.preferences, result.preferences);
});

test("Dock reconciliation preserves the first target position but uses the canonical live tile", () => {
  const notes = dockTile("com.apple.Notes", "file:///System/Applications/Notes.app/", 1);
  const stale = dockTile(BUNDLE_ID, "file:///tmp/candidate.app/", 2);
  const chrome = dockTile("com.google.Chrome", "file:///Applications/Google%20Chrome.app/", 3);
  const canonical = dockTile(BUNDLE_ID, "file:///Applications/ChatGPT.app/", 4);
  const result = dedupeDockPreferences({
    "persistent-apps": [notes, stale, chrome, canonical],
    "recent-apps": [],
  }, { appRoot: APP_ROOT, bundleId: BUNDLE_ID });

  assert.deepEqual(result.preferences["persistent-apps"], [notes, canonical, chrome]);
});

test("Dock reconciliation rebuilds a stale-only pinned target for the canonical live app", () => {
  const stale = dockTile(BUNDLE_ID, "file:///tmp/candidate.app/", 1);
  const result = dedupeDockPreferences({
    "persistent-apps": [stale],
    "recent-apps": [],
  }, { appRoot: APP_ROOT, bundleId: BUNDLE_ID });
  const tile = result.preferences["persistent-apps"]?.[0] as Record<string, unknown>;
  const data = tile["tile-data"] as Record<string, unknown>;
  const fileData = data["file-data"] as Record<string, unknown>;

  assert.equal(fileData["_CFURLString"], "file:///Applications/ChatGPT.app/");
  assert.equal(data.book, undefined, "Dock must rebuild the bookmark for the canonical app path");
  assert.equal(result.changed, true);
});

test("Dock reconciliation removes Codex recents even when no Codex item is pinned", () => {
  const chrome = dockTile("com.google.Chrome", "file:///Applications/Google%20Chrome.app/", 1);
  const result = dedupeDockPreferences({
    "persistent-apps": [],
    "recent-apps": [dockTile(BUNDLE_ID, "file:///tmp/candidate.app/", 2), chrome],
  }, { appRoot: APP_ROOT, bundleId: BUNDLE_ID });

  assert.deepEqual(result.preferences["recent-apps"], [chrome]);
  assert.equal(result.removedRecent, 1);
});

test("LaunchServices cleanup unregisters only verified non-live Codex bundles then registers the canonical app", () => {
  const calls: string[][] = [];
  const candidate = "/tmp/candidate.app";
  const unrelated = "/tmp/unrelated.app";
  const missing = "/tmp/missing.app";

  const result = reconcileLaunchServices({
    appRoot: APP_ROOT,
    bundleId: BUNDLE_ID,
    nonLiveAppRoots: [candidate, unrelated, missing, APP_ROOT, candidate],
  }, {
    platform: "darwin",
    exists: (path) => path !== missing,
    bundleIdentifier: (path) => path === unrelated ? "com.example.unrelated" : BUNDLE_ID,
    run: (_command, args) => { calls.push(args); },
  });

  assert.deepEqual(calls, [
    ["-u", candidate],
    ["-f", APP_ROOT],
  ]);
  assert.deepEqual(result.unregistered, [candidate]);
  assert.deepEqual(result.skipped.sort(), [APP_ROOT, missing, unrelated].sort());
  assert.equal(result.registeredCanonical, true);
  assert.equal(result.garbageCollected, false);
});

test("LaunchServices cleanup is idempotent when a non-live bundle is already unregistered", () => {
  const candidate = "/tmp/candidate.app";
  const result = reconcileLaunchServices({
    appRoot: APP_ROOT,
    bundleId: BUNDLE_ID,
    nonLiveAppRoots: [candidate],
  }, {
    platform: "darwin",
    exists: () => true,
    bundleIdentifier: () => BUNDLE_ID,
    run: (_command, args) => {
      if (args[0] === "-u") {
        throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("failed to scan: -10814\n") });
      }
    },
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, [candidate]);
  assert.equal(result.registeredCanonical, true);
});

test("LaunchServices performs garbage collection only when the final promotion requests it", () => {
  const calls: string[][] = [];
  const result = reconcileLaunchServices({
    appRoot: APP_ROOT,
    bundleId: BUNDLE_ID,
    nonLiveAppRoots: [],
    garbageCollect: true,
  }, {
    platform: "darwin",
    exists: () => true,
    bundleIdentifier: () => BUNDLE_ID,
    run: (_command, args) => { calls.push(args); },
  });

  assert.deepEqual(calls, [["-f", APP_ROOT], ["-gc"]]);
  assert.equal(result.garbageCollected, true);
});

test("Dock reconciliation backs up preferences before import and does not restart Dock after import failure", () => {
  withTempDir((root) => {
    const home = join(root, "home");
    const preferencesDir = join(home, "Library", "Preferences");
    const backupDir = join(root, "backup");
    mkdirSync(preferencesDir, { recursive: true });
    writeFileSync(join(preferencesDir, "com.apple.dock.plist"), "stale-on-disk-copy");
    const exported = plist.build({
      "persistent-apps": [
        dockTile(BUNDLE_ID, "file:///Applications/ChatGPT.app/", 1),
        dockTile(BUNDLE_ID, "file:///Applications/ChatGPT.app/", 2),
      ],
      "recent-apps": [],
    } as plist.PlistValue);
    const calls: string[] = [];

    assert.throws(() => reconcileDock({
      appRoot: APP_ROOT,
      bundleId: BUNDLE_ID,
      backupDir,
      now: new Date("2026-07-13T22:00:00.000Z"),
    }, {
      platform: "darwin",
      home,
      run: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "defaults" && args[0] === "export") return exported;
        if (command === "defaults" && args[0] === "import") throw new Error("injected import failure");
        return "";
      },
    }), /injected import failure/);

    const backup = join(backupDir, "com.apple.dock.before-codex-dedupe.2026-07-13T22-00-00-000Z.plist");
    assert.equal(readFileSync(backup, "utf8"), exported);
    assert.equal(calls.some((call) => call === "killall Dock"), false);
  });
});

test("macOS per-user commands enter the target GUI domain and uid under sudo", () => {
  const invocation = targetGuiCommand("defaults", ["export", "com.apple.dock", "-"], {
    currentUid: 0,
    targetUid: 501,
    home: "/Users/example",
  });

  assert.equal(invocation.command, "launchctl");
  assert.deepEqual(invocation.args, [
    "asuser", "501", "/usr/bin/sudo", "-u", "#501", "/usr/bin/env", "HOME=/Users/example",
    "defaults", "export", "com.apple.dock", "-",
  ]);
  assert.equal(invocation.env.HOME, "/Users/example");
});

test("macOS per-user commands run directly for the current GUI user", () => {
  const invocation = targetGuiCommand("killall", ["Dock"], {
    currentUid: 501,
    targetUid: 501,
    home: "/Users/example",
  });

  assert.equal(invocation.command, "killall");
  assert.deepEqual(invocation.args, ["Dock"]);
});

function dockTile(bundleId: string, url: string, guid: number): Record<string, unknown> {
  return {
    GUID: guid,
    "tile-data": {
      "bundle-identifier": bundleId,
      "file-data": { "_CFURLString": url },
      book: Buffer.from(`bookmark-${guid}`),
    },
    "tile-type": "file-tile",
  };
}

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweakers-app-identity-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function testSwapDirectories(first: string, second: string): void {
  const temporary = `${first}.test-swap`;
  renameSync(first, temporary);
  renameSync(second, first);
  renameSync(temporary, second);
}

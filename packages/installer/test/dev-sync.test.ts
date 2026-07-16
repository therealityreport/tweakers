import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearLegacyDevMode, reconcileDevTweaks, resolveDevSyncSourceRoot, runDevSyncCycle, shouldIgnoreDevWatchPath } from "../src/commands/dev-sync";
import { readConfigFile, readDevTweaksRoot, updateConfigFile } from "../src/config";
import { isSymlinkInto } from "../src/symlinks";

function fixture(): { root: string; repoTweaks: string; liveTweaks: string } {
  const root = mkdtempSync(join(tmpdir(), "codexpp-dev-sync-"));
  const repoTweaks = join(root, "repo", "tweaks");
  const liveTweaks = join(root, "live", "tweaks");
  mkdirSync(repoTweaks, { recursive: true });
  mkdirSync(liveTweaks, { recursive: true });
  return { root, repoTweaks, liveTweaks };
}

function writeTweak(dir: string, folder: string, id: string): string {
  const tweakDir = join(dir, folder);
  mkdirSync(tweakDir, { recursive: true });
  writeFileSync(
    join(tweakDir, "manifest.json"),
    JSON.stringify({ id, name: folder, version: "0.1.0", githubRepo: "example/repo", scope: "main" }),
  );
  writeFileSync(join(tweakDir, "index.js"), "module.exports = {};\n");
  return tweakDir;
}

test("reconcile links valid repo tweak folders by basename", () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "followup", "co.tweakers.followup");
    writeTweak(f.repoTweaks, "co.example.same-name", "co.example.same-name");

    const result = reconcileDevTweaks(f.liveTweaks, f.repoTweaks);

    assert.deepEqual(result.linked.sort(), ["co.example.same-name", "followup"]);
    assert.ok(result.changed);
    for (const folder of ["followup", "co.example.same-name"]) {
      const link = join(f.liveTweaks, folder);
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readlinkSync(link), join(f.repoTweaks, folder));
    }
    // Folder ≠ id never produces an id-named second entry (double-load guard).
    assert.ok(!existsSync(join(f.liveTweaks, "co.tweakers.followup")));
    // Reload marker at the tweaks-dir root, not through a link.
    assert.ok(existsSync(join(f.liveTweaks, ".codexpp-dev-reload")));
    assert.ok(!existsSync(join(f.repoTweaks, "followup", ".codexpp-dev-reload")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reconcile removes a leftover id-named dev link for the same source", () => {
  const f = fixture();
  try {
    const source = writeTweak(f.repoTweaks, "followup", "co.tweakers.followup");
    symlinkSync(source, join(f.liveTweaks, "co.tweakers.followup"), "dir");

    const result = reconcileDevTweaks(f.liveTweaks, f.repoTweaks);

    assert.ok(result.changed);
    assert.ok(!existsSync(join(f.liveTweaks, "co.tweakers.followup")));
    assert.ok(lstatSync(join(f.liveTweaks, "followup")).isSymbolicLink());
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reconcile replaces a staged real-dir copy with a repo symlink", () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "ui-improvements", "co.tweakers.ui-improvements");
    // Staged bundled copy with local edits.
    writeTweak(f.liveTweaks, "ui-improvements", "co.tweakers.ui-improvements");
    writeFileSync(join(f.liveTweaks, "ui-improvements", "local-edit.js"), "// edited live\n");

    const logs: string[] = [];
    const result = reconcileDevTweaks(f.liveTweaks, f.repoTweaks, (m) => logs.push(m));

    assert.ok(result.linked.includes("ui-improvements"));
    assert.ok(lstatSync(join(f.liveTweaks, "ui-improvements")).isSymbolicLink());
    assert.ok(logs.some((m) => m.includes("repo is canonical")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reconcile sweeps dangling links and skips invalid manifests", () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "keeper", "keeper");
    // Invalid: manifest missing entry file.
    mkdirSync(join(f.repoTweaks, "broken"), { recursive: true });
    writeFileSync(
      join(f.repoTweaks, "broken", "manifest.json"),
      JSON.stringify({ id: "broken", name: "b", version: "1.0.0", githubRepo: "example/repo" }),
    );
    // Dangling link to a deleted repo tweak.
    symlinkSync(join(f.repoTweaks, "deleted-tweak"), join(f.liveTweaks, "deleted-tweak"), "dir");
    // Foreign symlink (not into repo) must be untouched.
    const foreignTarget = join(f.root, "elsewhere");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, join(f.liveTweaks, "foreign"), "dir");

    const result = reconcileDevTweaks(f.liveTweaks, f.repoTweaks);

    assert.deepEqual(result.removedStale, ["deleted-tweak"]);
    assert.deepEqual(result.skippedInvalid, ["broken"]);
    assert.ok(!existsSync(join(f.liveTweaks, "broken")));
    assert.ok(lstatSync(join(f.liveTweaks, "foreign")).isSymbolicLink());
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reconcile is idempotent", () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "followup", "co.tweakers.followup");
    assert.ok(reconcileDevTweaks(f.liveTweaks, f.repoTweaks).changed);

    const markerBefore = readFileSync(join(f.liveTweaks, ".codexpp-dev-reload"), "utf8");
    const second = reconcileDevTweaks(f.liveTweaks, f.repoTweaks);

    assert.equal(second.changed, false);
    assert.deepEqual(second.linked, []);
    assert.equal(readFileSync(join(f.liveTweaks, ".codexpp-dev-reload"), "utf8"), markerBefore);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("config helpers preserve unknown keys and read devTweaksRoot", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-config-"));
  try {
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ tweakUpdateChecks: { x: 1 }, codexPlusPlus: { autoUpdate: true } }));

    updateConfigFile(file, (config) => {
      const section = (config.codexPlusPlus ??= {}) as Record<string, unknown>;
      section.devTweaksRoot = "/repo/tweaks";
    });

    const config = readConfigFile(file);
    assert.deepEqual(config.tweakUpdateChecks, { x: 1 });
    assert.equal((config.codexPlusPlus as Record<string, unknown>).autoUpdate, true);
    assert.equal(readDevTweaksRoot(file), "/repo/tweaks");

    updateConfigFile(file, (c) => {
      delete ((c.codexPlusPlus ?? {}) as Record<string, unknown>).devTweaksRoot;
    });
    assert.equal(readDevTweaksRoot(file), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSymlinkInto matches only links resolving inside the root", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-symlinks-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "tweak"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });

    symlinkSync(join(repo, "tweak"), join(root, "inside"), "dir");
    symlinkSync(join(root, "other"), join(root, "outside"), "dir");
    symlinkSync(join(repo, "gone"), join(root, "dangling"), "dir");
    mkdirSync(join(root, "realdir"));
    // Sibling-prefix attack: /root/repo-evil must not match root /root/repo.
    mkdirSync(join(root, "repo-evil"), { recursive: true });
    symlinkSync(join(root, "repo-evil"), join(root, "sibling"), "dir");

    assert.equal(isSymlinkInto(join(root, "inside"), repo), true);
    assert.equal(isSymlinkInto(join(root, "outside"), repo), false);
    assert.equal(isSymlinkInto(join(root, "dangling"), repo), true); // dangling but INTO root — still a dev link
    assert.equal(isSymlinkInto(join(root, "realdir"), repo), false);
    assert.equal(isSymlinkInto(join(root, "missing"), repo), false);
    assert.equal(isSymlinkInto(join(root, "sibling"), repo), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validated dev sync publishes built tweaks without symlinking the checkout", async () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "followup", "co.tweakers.followup");
    mkdirSync(join(f.repoTweaks, "non-tweak-fixture"));
    await runDevSyncCycle({
      sourceRoot: join(f.root, "repo"),
      liveTweaks: f.liveTweaks,
      build: async (sourceRoot) => {
        const built = join(sourceRoot, "packages", "installer", "assets", "runtime", "tweaks", "followup");
        mkdirSync(built, { recursive: true });
        writeFileSync(join(built, "manifest.json"), JSON.stringify({ id: "co.tweakers.followup" }));
        writeFileSync(join(built, "index.js"), "module.exports = { built: true };\n");
      },
    });

    const live = join(f.liveTweaks, "followup");
    assert.equal(lstatSync(live).isSymbolicLink(), false);
    assert.match(readFileSync(join(live, "index.js"), "utf8"), /built: true/);
    assert.ok(existsSync(join(f.liveTweaks, ".codexpp-dev-reload")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("managed CLI dev sync uses the registered development checkout", () => {
  const f = fixture();
  try {
    const managedRoot = join(f.root, "managed-runtime", "current");
    const configFile = join(f.root, "config.json");
    mkdirSync(join(managedRoot, "tweaks"), { recursive: true });
    mkdirSync(join(f.root, "repo", "packages", "installer"), { recursive: true });
    writeFileSync(join(f.root, "repo", "package.json"), "{}");
    updateConfigFile(configFile, (config) => {
      config.codexPlusPlus = { developmentSourceRoot: join(f.root, "repo") };
    });

    assert.equal(resolveDevSyncSourceRoot(configFile, managedRoot), join(f.root, "repo"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("failed dev sync leaves the last working live runtime untouched", async () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "followup", "co.tweakers.followup");
    const live = writeTweak(f.liveTweaks, "followup", "co.tweakers.followup");
    writeFileSync(join(live, "index.js"), "module.exports = { working: true };\n");

    await assert.rejects(
      runDevSyncCycle({
        sourceRoot: join(f.root, "repo"),
        liveTweaks: f.liveTweaks,
        build: async () => { throw new Error("build failed"); },
      }),
      /build failed/,
    );

    assert.match(readFileSync(join(live, "index.js"), "utf8"), /working: true/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dev snapshot removes stale managed tweaks and preserves unrelated user tweaks", async () => {
  const f = fixture();
  try {
    writeTweak(f.repoTweaks, "current", "co.example.current");
    const builtRoot = join(f.root, "repo", "packages", "installer", "assets", "runtime", "tweaks");
    await runDevSyncCycle({
      sourceRoot: join(f.root, "repo"),
      liveTweaks: f.liveTweaks,
      build: async () => {
        writeTweak(builtRoot, "stale", "co.example.stale");
        writeTweak(builtRoot, "current", "co.example.current");
      },
    });
    writeTweak(f.liveTweaks, "user-owned", "com.user.owned");

    await runDevSyncCycle({
      sourceRoot: join(f.root, "repo"),
      liveTweaks: f.liveTweaks,
      build: async () => {
        rmSync(builtRoot, { recursive: true, force: true });
        writeTweak(builtRoot, "current", "co.example.current");
      },
    });

    assert.equal(existsSync(join(f.liveTweaks, "stale")), false);
    assert.equal(existsSync(join(f.liveTweaks, "current")), true);
    assert.equal(existsSync(join(f.liveTweaks, "user-owned")), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("snapshot mode clears legacy source symlinks so repair cannot bypass validation", () => {
  const f = fixture();
  try {
    const source = writeTweak(f.repoTweaks, "followup", "co.tweakers.followup");
    symlinkSync(source, join(f.liveTweaks, "followup"), "dir");
    const configFile = join(f.root, "config.json");
    writeFileSync(configFile, JSON.stringify({ codexPlusPlus: { devTweaksRoot: f.repoTweaks } }));

    clearLegacyDevMode(configFile, f.liveTweaks);

    assert.equal(readDevTweaksRoot(configFile), null);
    assert.equal(existsSync(join(f.liveTweaks, "followup")), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("development watcher ignores its own generated build output", () => {
  assert.equal(shouldIgnoreDevWatchPath("packages/runtime/dist/main.js"), true);
  assert.equal(shouldIgnoreDevWatchPath("packages/native-host/dist/addon.node"), true);
  assert.equal(shouldIgnoreDevWatchPath("packages/installer/assets/runtime/main.js"), true);
  assert.equal(shouldIgnoreDevWatchPath("node_modules/example/index.js"), true);
  assert.equal(shouldIgnoreDevWatchPath("tweaks/followup/index.js"), false);
});

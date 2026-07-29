import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { copyInstallerAssets } from "../packages/installer/scripts/copy-assets.mjs";
import { findGeneratedConflictCopies } from "./generated-assets.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tweakers-copy-assets-"));
  mkdirSync(join(root, "packages", "loader"), { recursive: true });
  mkdirSync(join(root, "packages", "runtime", "dist"), { recursive: true });
  mkdirSync(join(root, "packages", "installer", "assets", "runtime", "tweaks", "stale"), { recursive: true });
  mkdirSync(join(root, "tweaks", "alpha"), { recursive: true });
  mkdirSync(join(root, "store"), { recursive: true });
  writeFileSync(join(root, "packages", "loader", "loader.cjs"), "loader\n");
  writeFileSync(join(root, "packages", "installer", "assets", "loader.cjs"), "old loader\n");
  chmodSync(join(root, "packages", "installer", "assets", "loader.cjs"), 0o710);
  writeFileSync(join(root, "packages", "runtime", "dist", "main.js"), "runtime\n");
  chmodSync(join(root, "packages", "runtime", "dist", "main.js"), 0o750);
  writeFileSync(join(root, "packages", "installer", "assets", "runtime", "stale.js"), "stale\n");
  writeFileSync(join(root, "packages", "installer", "assets", "runtime", "main.js"), "old\n");
  writeFileSync(join(root, "packages", "installer", "assets", "runtime", "main 2.js"), "conflict\n");
  writeFileSync(join(root, "tweaks", "alpha", "manifest.json"), JSON.stringify({
    id: "com.example.alpha",
    name: "alpha",
    version: "0.1.0",
    githubRepo: "example/alpha",
    scope: "renderer",
  }));
  writeFileSync(join(root, "tweaks", "alpha", "index.js"), "module.exports = {};\n");
  writeFileSync(join(root, "store", "index.json"), `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`);
  return root;
}

function snapshot(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else rows.push([relative(root, path), statSync(path).mode & 0o777, readFileSync(path).toString("base64")]);
    }
  };
  visit(root);
  return rows;
}

test("copy-assets reconciles deterministic output while preserving unchanged destination inodes", () => {
  const root = fixture();
  const runtime = join(root, "packages", "installer", "assets", "runtime");
  try {
    const originalRuntimeInode = statSync(runtime).ino;
    const originalTweaksInode = statSync(join(runtime, "tweaks")).ino;
    const first = copyInstallerAssets(root);
    assert.equal(first.runtimeCopied, true);
    assert.equal(first.tweakCount, 1);
    assert.equal(readFileSync(join(runtime, "main.js"), "utf8"), "runtime\n");
    assert.equal(statSync(join(runtime, "main.js")).mode & 0o777, 0o750);
    assert.equal(readFileSync(join(runtime, "tweaks", "alpha", "index.js"), "utf8"), "module.exports = {};\n");
    assert.deepEqual(findGeneratedConflictCopies(runtime), []);
    assert.equal(readdirSync(runtime).includes("stale.js"), false);
    assert.equal(readdirSync(join(runtime, "tweaks")).includes("stale"), false);
    assert.equal(statSync(runtime).ino, originalRuntimeInode);
    assert.equal(statSync(join(runtime, "tweaks")).ino, originalTweaksInode);

    const before = snapshot(runtime);
    const stableInodes = {
      runtime: statSync(runtime).ino,
      tweaks: statSync(join(runtime, "tweaks")).ino,
      alpha: statSync(join(runtime, "tweaks", "alpha")).ino,
      alphaIndex: statSync(join(runtime, "tweaks", "alpha", "index.js")).ino,
      main: statSync(join(runtime, "main.js")).ino,
      loader: statSync(join(root, "packages", "installer", "assets", "loader.cjs")).ino,
    };
    const second = copyInstallerAssets(root);
    assert.deepEqual(second.fingerprint, first.fingerprint);
    assert.deepEqual(snapshot(runtime), before);
    assert.deepEqual({
      runtime: statSync(runtime).ino,
      tweaks: statSync(join(runtime, "tweaks")).ino,
      alpha: statSync(join(runtime, "tweaks", "alpha")).ino,
      alphaIndex: statSync(join(runtime, "tweaks", "alpha", "index.js")).ino,
      main: statSync(join(runtime, "main.js")).ino,
      loader: statSync(join(root, "packages", "installer", "assets", "loader.cjs")).ino,
    }, stableInodes);
    assert.deepEqual(findGeneratedConflictCopies(runtime), []);
    assert.equal(snapshot(runtime).some(([name]) => name.includes(" 2")), false);

    writeFileSync(join(root, "packages", "runtime", "dist", "main.js"), "changed runtime\n");
    chmodSync(join(root, "packages", "runtime", "dist", "main.js"), 0o750);
    copyInstallerAssets(root);
    assert.equal(readFileSync(join(runtime, "main.js"), "utf8"), "changed runtime\n");
    assert.notEqual(statSync(join(runtime, "main.js")).ino, stableInodes.main);
    assert.equal(statSync(runtime).ino, stableInodes.runtime);
    assert.equal(statSync(join(runtime, "tweaks")).ino, stableInodes.tweaks);
    assert.equal(statSync(join(runtime, "tweaks", "alpha")).ino, stableInodes.alpha);
    assert.equal(statSync(join(runtime, "tweaks", "alpha", "index.js")).ino, stableInodes.alphaIndex);
    assert.equal(statSync(join(root, "packages", "installer", "assets", "loader.cjs")).ino, stableInodes.loader);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed runtime publication leaves both prior runtime content and the source catalog unchanged", () => {
  const root = fixture();
  const runtime = join(root, "packages", "installer", "assets", "runtime");
  const catalogPath = join(root, "store", "index.json");
  try {
    const priorRuntime = snapshot(runtime);
    const priorCatalog = readFileSync(catalogPath, "utf8");
    const loaderPath = join(root, "packages", "installer", "assets", "loader.cjs");
    const priorLoader = {
      data: readFileSync(loaderPath, "utf8"),
      mode: statSync(loaderPath).mode & 0o777,
      inode: statSync(loaderPath).ino,
    };
    assert.throws(() => copyInstallerAssets(root, {
      publicationDependencies: {
        afterMutation: ({ path }) => {
          if (path === join(runtime, "main.js")) throw new Error("simulated runtime publication failure");
        },
      },
    }), /simulated runtime publication failure/);
    assert.deepEqual(snapshot(runtime), priorRuntime);
    assert.equal(readFileSync(catalogPath, "utf8"), priorCatalog);
    assert.deepEqual({
      data: readFileSync(loaderPath, "utf8"),
      mode: statSync(loaderPath).mode & 0o777,
      inode: statSync(loaderPath).ino,
    }, priorLoader);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a catalog publication failure rolls loader, runtime, and catalog back together", () => {
  const root = fixture();
  const runtime = join(root, "packages", "installer", "assets", "runtime");
  const loaderPath = join(root, "packages", "installer", "assets", "loader.cjs");
  const catalogPath = join(root, "store", "index.json");
  try {
    const priorRuntime = snapshot(runtime);
    const priorLoader = [readFileSync(loaderPath, "utf8"), statSync(loaderPath).mode & 0o777, statSync(loaderPath).ino];
    const priorCatalog = [readFileSync(catalogPath, "utf8"), statSync(catalogPath).mode & 0o777, statSync(catalogPath).ino];
    assert.throws(() => copyInstallerAssets(root, {
      publicationDependencies: {
        afterMutation: ({ operation }) => {
          if (operation === "replace-companion") throw new Error("simulated catalog publication failure");
        },
      },
    }), /simulated catalog publication failure/);
    assert.deepEqual(snapshot(runtime), priorRuntime);
    assert.deepEqual([readFileSync(loaderPath, "utf8"), statSync(loaderPath).mode & 0o777, statSync(loaderPath).ino], priorLoader);
    assert.deepEqual([readFileSync(catalogPath, "utf8"), statSync(catalogPath).mode & 0o777, statSync(catalogPath).ino], priorCatalog);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets returns the exact private root when post-commit cleanup fails", () => {
  const root = fixture();
  try {
    const result = copyInstallerAssets(root, {
      publicationDependencies: {
        cleanupWorkspace: () => { throw new Error("simulated caller cleanup failure"); },
        onCleanupError: () => {},
      },
    });
    assert.equal(result.runtimeCopied, true);
    assert.equal(result.cleanupErrors.length, 1);
    assert.match(result.cleanupErrors[0].workspace, /\.assets\.publish-/);
    assert.equal(result.cleanupErrors[0].message, "simulated caller cleanup failure");
    assert.equal(existsSync(result.cleanupErrors[0].workspace), true);
    rmSync(result.cleanupErrors[0].workspace, { recursive: true, force: true });
    assert.equal(existsSync(result.cleanupErrors[0].workspace), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

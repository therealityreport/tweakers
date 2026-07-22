import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverCanonicalTweaks, syncTweaks, synchronizedCatalog } from "./sync-tweaks.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tweakers-sync-"));
  mkdirSync(join(root, "tweaks"), { recursive: true });
  mkdirSync(join(root, "store"), { recursive: true });
  mkdirSync(join(root, "packages", "installer", "assets", "runtime", "tweaks"), { recursive: true });
  return root;
}

function writeTweak(root, folder, id, version = "0.1.0", manifestExtras = {}) {
  const dir = join(root, "tweaks", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: folder, version, githubRepo: "example/repo", scope: "renderer", ...manifestExtras }));
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

test("manifest folders synchronize catalog and packaged assets deterministically", () => {
  const root = fixture();
  try {
    writeTweak(root, "alpha", "com.example.alpha", "0.2.0", { mcp: { command: "node", args: ["mcp-server.js"] } });
    mkdirSync(join(root, "tweaks", "fixture-only"));
    writeFileSync(join(root, "store", "index.json"), JSON.stringify({ schemaVersion: 1, entries: [
      { id: "com.example.alpha", available: false, source: { kind: "bundled", path: "old" }, manifest: {}, approvedAt: "2026-01-01", approvedBy: "reviewer" },
      { id: "com.example.deleted", source: { kind: "bundled", path: "tweaks/deleted" }, manifest: {} },
      { id: "com.external.kept", source: { kind: "github", repo: "x/y" }, manifest: { id: "com.external.kept" } },
    ] }, null, 2) + "\n");

    const result = syncTweaks(root, { now: "2026-07-12T00:00:00.000Z" });
    assert.equal(result.count, 1);
    const catalog = JSON.parse(readFileSync(join(root, "store", "index.json"), "utf8"));
    assert.deepEqual(catalog.entries.map((entry) => entry.id), ["com.example.alpha", "com.external.kept"]);
    const alpha = catalog.entries[0];
    assert.equal(alpha.available, false);
    assert.equal(alpha.approvedBy, "reviewer");
    assert.equal(alpha.source.path, "tweaks/alpha");
    assert.equal(alpha.manifest.version, "0.2.0");
    assert.deepEqual(alpha.manifest.mcp, { command: "node", args: ["mcp-server.js"] });
    assert.doesNotThrow(() => syncTweaks(root, { check: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sync:tweaks reconciles exact generated content without replacing unchanged runtime paths", () => {
  const root = fixture();
  const runtime = join(root, "packages", "installer", "assets", "runtime");
  try {
    writeTweak(root, "alpha", "com.example.alpha");
    writeFileSync(join(root, "store", "index.json"), `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`);
    writeFileSync(join(runtime, "main.js"), "preserved runtime\n");
    writeFileSync(join(runtime, "main 2.js"), "FileProvider conflict\n");
    writeFileSync(join(runtime, "main 10.js"), "multi-digit FileProvider conflict\n");
    writeFileSync(join(root, "packages", "installer", "assets", "outside.js"), "outside canonical\n");
    writeFileSync(join(root, "packages", "installer", "assets", "outside 2.js"), "outside conflict\n");
    mkdirSync(join(runtime, "tweaks", "stale"), { recursive: true });
    writeFileSync(join(runtime, "tweaks", "stale", "index.js"), "stale bundled tweak\n");
    const originalRuntimeInode = statSync(runtime).ino;
    const originalMainInode = statSync(join(runtime, "main.js")).ino;

    assert.throws(() => syncTweaks(root, { check: true }), /packaged-assets/);
    const result = syncTweaks(root, { now: "2026-07-12T00:00:00.000Z" });
    assert.equal(result.changed, true);
    assert.equal(readFileSync(join(runtime, "main.js"), "utf8"), "preserved runtime\n");
    assert.equal(existsSync(join(runtime, "main 2.js")), false);
    assert.equal(existsSync(join(runtime, "main 10.js")), false);
    assert.equal(readFileSync(join(root, "packages", "installer", "assets", "outside 2.js"), "utf8"), "outside conflict\n");
    assert.equal(existsSync(join(runtime, "tweaks", "stale")), false);
    assert.equal(existsSync(join(runtime, "tweaks", "alpha", "index.js")), true);
    assert.equal(statSync(runtime).ino, originalRuntimeInode);
    assert.equal(statSync(join(runtime, "main.js")).ino, originalMainInode);
    assert.doesNotThrow(() => syncTweaks(root, { check: true }));

    const stableTweaksInode = statSync(join(runtime, "tweaks")).ino;
    const stableAlphaInode = statSync(join(runtime, "tweaks", "alpha")).ino;
    const oldIndexInode = statSync(join(runtime, "tweaks", "alpha", "index.js")).ino;
    assert.equal(syncTweaks(root).changed, false);
    assert.equal(statSync(runtime).ino, originalRuntimeInode);
    assert.equal(statSync(join(runtime, "main.js")).ino, originalMainInode);
    assert.equal(statSync(join(runtime, "tweaks")).ino, stableTweaksInode);
    assert.equal(statSync(join(runtime, "tweaks", "alpha")).ino, stableAlphaInode);
    assert.equal(statSync(join(runtime, "tweaks", "alpha", "index.js")).ino, oldIndexInode);

    writeFileSync(join(root, "tweaks", "alpha", "index.js"), "module.exports = { changed: true };\n");
    assert.equal(syncTweaks(root).changed, true);
    assert.equal(statSync(runtime).ino, originalRuntimeInode);
    assert.equal(statSync(join(runtime, "main.js")).ino, originalMainInode);
    assert.equal(statSync(join(runtime, "tweaks")).ino, stableTweaksInode);
    assert.equal(statSync(join(runtime, "tweaks", "alpha")).ino, stableAlphaInode);
    assert.notEqual(statSync(join(runtime, "tweaks", "alpha", "index.js")).ino, oldIndexInode);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sync:tweaks rolls generated output and the canonical catalog back as one transaction", () => {
  const root = fixture();
  const runtime = join(root, "packages", "installer", "assets", "runtime");
  const catalogPath = join(root, "store", "index.json");
  try {
    writeTweak(root, "alpha", "com.example.alpha");
    writeFileSync(catalogPath, `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`);
    writeFileSync(join(runtime, "main.js"), "prior runtime\n");
    mkdirSync(join(runtime, "tweaks", "stale"), { recursive: true });
    writeFileSync(join(runtime, "tweaks", "stale", "index.js"), "prior stale\n");
    const priorCatalog = [readFileSync(catalogPath, "utf8"), statSync(catalogPath).mode & 0o777, statSync(catalogPath).ino];
    const priorMainInode = statSync(join(runtime, "main.js")).ino;

    assert.throws(() => syncTweaks(root, {
      publicationDependencies: {
        afterMutation: ({ operation }) => {
          if (operation === "replace-companion") throw new Error("simulated direct catalog failure");
        },
      },
    }), /simulated direct catalog failure/);

    assert.deepEqual([readFileSync(catalogPath, "utf8"), statSync(catalogPath).mode & 0o777, statSync(catalogPath).ino], priorCatalog);
    assert.equal(readFileSync(join(runtime, "main.js"), "utf8"), "prior runtime\n");
    assert.equal(statSync(join(runtime, "main.js")).ino, priorMainInode);
    assert.equal(readFileSync(join(runtime, "tweaks", "stale", "index.js"), "utf8"), "prior stale\n");
    assert.equal(existsSync(join(runtime, "tweaks", "alpha")), false);
    assert.equal(existsSync(join(runtime, "catalog.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovery rejects duplicate ids and invalid declared tweaks", () => {
  const root = fixture();
  try {
    writeTweak(root, "one", "com.example.same");
    writeTweak(root, "two", "com.example.same");
    assert.throws(() => discoverCanonicalTweaks(root), /duplicate tweak id/);
    rmSync(join(root, "tweaks", "two"), { recursive: true, force: true });
    rmSync(join(root, "tweaks", "one", "index.js"));
    assert.throws(() => discoverCanonicalTweaks(root), /entry is unsafe or missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog synchronization adds new bundled entries with stable defaults", () => {
  const root = fixture();
  try {
    writeTweak(root, "new", "com.example.new");
    const catalog = synchronizedCatalog(root, { entries: [] }, "2026-07-12T00:00:00.000Z");
    assert.equal(catalog.entries[0].approvedAt, "2026-07-12T00:00:00.000Z");
    assert.equal(catalog.entries[0].approvedBy, "tweakers");
    assert.equal(catalog.entries[0].available, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovery rejects entry traversal and symlinks escaping a tweak", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "outside.js"), "module.exports = {};\n");
    writeTweak(root, "unsafe", "com.example.unsafe");
    writeFileSync(join(root, "tweaks", "unsafe", "manifest.json"), JSON.stringify({
      id: "com.example.unsafe", name: "unsafe", version: "0.1.0", githubRepo: "example/repo", main: "../../outside.js",
    }));
    assert.throws(() => discoverCanonicalTweaks(root), /unsafe or missing/);
    writeFileSync(join(root, "tweaks", "unsafe", "manifest.json"), JSON.stringify({
      id: "com.example.unsafe", name: "unsafe", version: "0.1.0", githubRepo: "example/repo",
    }));
    symlinkSync(join(root, "outside.js"), join(root, "tweaks", "unsafe", "outside-link.js"));
    assert.throws(() => discoverCanonicalTweaks(root), /symlink escapes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

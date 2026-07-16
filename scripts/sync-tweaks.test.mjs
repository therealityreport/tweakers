import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

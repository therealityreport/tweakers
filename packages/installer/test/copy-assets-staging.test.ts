import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyInstallerAssets } from "../scripts/copy-assets.mjs";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * Recursive content digest of a tree: relative path -> sha256 (or symlink
 * target). Deliberately ignores inodes and timestamps so only actual bytes
 * count, and skips .DS_Store/__pycache__/*.pyc to match the packaging junk
 * rule in copy-assets.mjs sweepFinderJunk.
 */
function hashTree(root: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink()) rows[name] = `link:${readlinkSync(path)}`;
      else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) rows[name] = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  visit(root);
  return rows;
}

/** Minimal buildable repo fixture mirroring scripts/copy-assets.test.mjs. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tweakers-copy-assets-staging-"));
  mkdirSync(join(root, "packages", "loader"), { recursive: true });
  mkdirSync(join(root, "packages", "runtime", "dist"), { recursive: true });
  mkdirSync(join(root, "packages", "installer", "assets"), { recursive: true });
  mkdirSync(join(root, "tweaks", "alpha"), { recursive: true });
  mkdirSync(join(root, "store"), { recursive: true });
  writeFileSync(join(root, "packages", "loader", "loader.cjs"), "loader\n");
  writeFileSync(join(root, "packages", "runtime", "dist", "main.js"), "runtime\n");
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

function addMcpLifecycleSource(root: string): string {
  const source = join(root, "packages", "mcp-lifecycle");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, "templates", "deep"), { recursive: true });
  writeFileSync(join(source, "manifest.json"), `${JSON.stringify({ schemaVersion: 2 })}\n`);
  writeFileSync(join(source, "scripts", "install.sh"), "#!/bin/sh\necho fresh\n");
  writeFileSync(join(source, "templates", "deep", "config.json"), "{\"fresh\":true}\n");
  writeFileSync(join(source, ".DS_Store"), "finder junk");
  return source;
}

function addStaleShippedAssets(root: string): string {
  const shipped = join(root, "packages", "installer", "assets", "mcp-lifecycle");
  mkdirSync(join(shipped, "scripts"), { recursive: true });
  // Same path, different bytes: exactly the divergence that used to ride
  // along silently because the pre-existing assets dir was cpSync'd forward.
  writeFileSync(join(shipped, "manifest.json"), `${JSON.stringify({ schemaVersion: 1 })}\n`);
  writeFileSync(join(shipped, "scripts", "install.sh"), "#!/bin/sh\necho stale\n");
  writeFileSync(join(shipped, "stale-only.json"), "left over from an old publication\n");
  writeFileSync(join(root, "packages", "installer", "assets", "loader.cjs"), "old loader\n");
  return shipped;
}

test("copy-assets restages mcp-lifecycle and loader from source, replacing stale shipped bytes", () => {
  const root = fixture();
  try {
    const source = addMcpLifecycleSource(root);
    const shipped = addStaleShippedAssets(root);

    const result = copyInstallerAssets(root);
    assert.equal(result.runtimeCopied, true);

    // Content equality, file by file, hash by hash — not inode identity.
    assert.deepEqual(hashTree(shipped), hashTree(source));
    // The stale ride-along file and Finder junk must not ship.
    assert.equal(existsSync(join(shipped, "stale-only.json")), false);
    assert.equal(existsSync(join(shipped, ".DS_Store")), false);
    assert.equal(readFileSync(join(shipped, "scripts", "install.sh"), "utf8"), "#!/bin/sh\necho fresh\n");
    // The loader pair is copied from source too, not carried forward stale.
    assert.equal(readFileSync(join(root, "packages", "installer", "assets", "loader.cjs"), "utf8"), "loader\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets preserves committed mcp-lifecycle assets when the source is missing", () => {
  const root = fixture();
  try {
    const shipped = addStaleShippedAssets(root);
    const before = hashTree(shipped);

    const result = copyInstallerAssets(root);
    assert.equal(result.runtimeCopied, true);
    // Mirrors the runtime rule: a missing source must never delete the
    // committed generated asset (e.g. after a partial clean).
    assert.deepEqual(hashTree(shipped), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shipped mcp-lifecycle assets are content-identical to packages/mcp-lifecycle", () => {
  const source = join(repoRoot, "packages", "mcp-lifecycle");
  const shipped = join(repoRoot, "packages", "installer", "assets", "mcp-lifecycle");
  assert.ok(existsSync(source), "packages/mcp-lifecycle is missing");
  assert.ok(
    existsSync(shipped),
    "packages/installer/assets/mcp-lifecycle is missing — run the installer copy-assets script",
  );
  // Recursive hash compare so source edits that never went through
  // copy-assets fail CI instead of silently shipping stale assets.
  assert.deepEqual(
    hashTree(shipped),
    hashTree(source),
    "packages/installer/assets/mcp-lifecycle diverges from packages/mcp-lifecycle — rerun `npm run copy-assets --workspace @therealityreport/tweakers-installer`",
  );
});

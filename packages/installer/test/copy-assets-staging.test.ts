import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyInstallerAssets } from "../scripts/copy-assets.mjs";
import { readManagedRuntimeFingerprintEvidence } from "../src/managed-runtime";

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
  mkdirSync(join(root, "packages", "installer", "dist"), { recursive: true });
  mkdirSync(join(root, "packages", "native-host", "assets"), { recursive: true });
  mkdirSync(join(root, "packages", "native-host", "dist", "Tweakers Swap Helper.app", "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(root, "tweaks", "alpha"), { recursive: true });
  mkdirSync(join(root, "store"), { recursive: true });
  writeFileSync(join(root, "packages", "loader", "loader.cjs"), "loader\n");
  writeFileSync(join(root, "packages", "runtime", "dist", "main.js"), "runtime\n");
  writeFileSync(join(root, "packages", "installer", "assets", "protected-loader.cjs"), "protected loader\n");
  writeFileSync(join(root, "packages", "installer", "assets", "tweakers.icns"), "icon\n");
  writeFileSync(join(root, "packages", "installer", "assets", "tweakers.png"), "png\n");
  writeFileSync(join(root, "packages", "native-host", "dist", "Tweakers App Launcher"), "app launcher\n");
  writeFileSync(join(root, "packages", "native-host", "dist", "Tweakers Swap Helper.app", "Contents", "MacOS", "Tweakers Swap Helper"), "swap helper\n");
  writeFileSync(
    join(root, "packages", "native-host", "assets", "Tweakers Manager Launcher"),
    "signed fixture launcher\n",
  );
  writeFileSync(
    join(root, "packages", "native-host", "manager-signing-policy.json"),
    '{"schemaVersion":1}\n',
  );
  writeExecutable(join(root, "packages", "installer", "dist", "manager.mjs"), "export const statusOnly = true;\n");
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

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

/**
 * Reproduce npm's root-workspace topology.  In particular, the installer
 * symlink resolves to a package that already has generated assets; this is
 * the exact shape that used to recurse into the prior managed runtime.
 */
function addManagedRuntimeNodeModuleTopology(root: string): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@therealityreport"), { recursive: true });
  mkdirSync(join(root, "node_modules", "fixture-dependency", "bin"), { recursive: true });
  mkdirSync(join(root, "packages", "sdk", "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"private":true,"type":"commonjs"}\n');
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeExecutable(join(root, "bin", "tweaker.js"), "#!/usr/bin/env node\nconsole.log('root cli');\n");
  writeFileSync(join(root, "packages", "installer", "package.json"), '{"type":"module"}\n');
  writeExecutable(
    join(root, "packages", "installer", "dist", "cli.js"),
    "#!/usr/bin/env node\nimport { help } from './help.js';\nif (process.argv.includes('--help')) console.log(help);\n",
  );
  writeFileSync(join(root, "packages", "installer", "dist", "help.js"), "export const help = 'fixture CLI help';\n");
  writeFileSync(join(root, "packages", "sdk", "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "packages", "sdk", "dist", "index.js"), "export const sdk = true;\n");
  writeExecutable(join(root, "node_modules", "fixture-dependency", "bin", "fixture-tool.js"), "#!/usr/bin/env node\nconsole.log('external tool');\n");

  const scoped = join(root, "node_modules", "@therealityreport");
  symlinkSync("../../packages/installer", join(scoped, "tweakers-installer"));
  symlinkSync("../../packages/sdk", join(scoped, "tweakers-sdk"));
  symlinkSync("fixture-dependency", join(root, "node_modules", "fixture-alias-one"));
  symlinkSync("fixture-dependency", join(root, "node_modules", "fixture-alias-two"));
  symlinkSync("../@therealityreport/tweakers-installer/dist/cli.js", join(root, "node_modules", ".bin", "tweaker"));
  symlinkSync("../fixture-dependency/bin/fixture-tool.js", join(root, "node_modules", ".bin", "fixture-tool"));

  // This is a prior generated payload.  It is reachable only through the
  // installer workspace self-link and must never appear in the next tree.
  mkdirSync(join(root, "packages", "installer", "assets", "managed-runtime", "old-generation"), { recursive: true });
  writeFileSync(join(root, "packages", "installer", "assets", "managed-runtime", "old-generation", "sentinel.txt"), "must not recurse\n");
}

function assertOnlyRegularManagedRuntimeEntries(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `managed runtime retained symlink ${path}`);
      assert.equal(stat.isFIFO() || stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice(), false, `managed runtime retained special file ${path}`);
      if (stat.isDirectory()) visit(path);
      else assert.equal(stat.isFile(), true, `managed runtime retained unsupported entry ${path}`);
    }
  };
  visit(root);
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

test("copy-assets stages a deterministic non-self-referential manager managed-runtime tree", () => {
  const root = fixture();
  try {
    addManagedRuntimeNodeModuleTopology(root);
    copyInstallerAssets(root);
    const managedRuntimeRoot = join(root, "packages", "installer", "assets", "managed-runtime");
    const first = readManagedRuntimeFingerprintEvidence(managedRuntimeRoot);
    assert.ok(first, "first managed-runtime staging must be fingerprinted");
    assert.equal(existsSync(join(managedRuntimeRoot, "packages", "installer", "dist", "manager.mjs")), false);
    assert.equal(existsSync(join(managedRuntimeRoot, "packages", "installer", "assets", "manager-launcher")), false);
    assert.equal(existsSync(join(managedRuntimeRoot, "node_modules", "@therealityreport", "tweakers-installer")), false);
    assert.equal(existsSync(join(managedRuntimeRoot, "node_modules", "@therealityreport", "tweakers-sdk", "package.json")), true);
    assert.equal(existsSync(join(managedRuntimeRoot, "node_modules", "@therealityreport", "tweakers-sdk", "dist", "index.js")), true);
    assert.equal(existsSync(join(managedRuntimeRoot, "node_modules", "fixture-alias-one", "bin", "fixture-tool.js")), true);
    assert.equal(existsSync(join(managedRuntimeRoot, "node_modules", "fixture-alias-two", "bin", "fixture-tool.js")), true);
    assert.equal(existsSync(join(managedRuntimeRoot, "packages", "installer", "assets", "managed-runtime", "old-generation", "sentinel.txt")), false);
    assert.equal(existsSync(join(managedRuntimeRoot, "packages", "installer", "assets", "manager-launcher")), false);
    assertOnlyRegularManagedRuntimeEntries(managedRuntimeRoot);

    // The former .bin symlink is a physical shim whose target is remapped to
    // the explicitly projected installer dist tree; the relative import from
    // cli.js proves it does not rely on the source checkout.
    assert.equal(
      execFileSync(join(managedRuntimeRoot, "node_modules", ".bin", "tweaker"), ["--help"], { encoding: "utf8" }).trim(),
      "fixture CLI help",
    );

    copyInstallerAssets(root);
    const second = readManagedRuntimeFingerprintEvidence(managedRuntimeRoot);
    assert.ok(second, "second managed-runtime staging must be fingerprinted");
    assert.deepEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets rejects unsafe lexical managed-runtime links before publishing and preserves the prior assets tree", () => {
  const root = fixture();
  const external = join(root, "outside-managed-runtime-source");
  try {
    addManagedRuntimeNodeModuleTopology(root);
    copyInstallerAssets(root);
    const assets = join(root, "packages", "installer", "assets");
    const before = hashTree(assets);
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "outside.js"), "outside\n");
    symlinkSync("../outside-managed-runtime-source", join(root, "node_modules", "outside-link"));

    assert.throws(() => copyInstallerAssets(root), /lexical target is outside approved roots/);
    assert.deepEqual(hashTree(assets), before, "failed staging must not publish a partial asset tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets rejects absolute links even when they point inside node_modules", () => {
  const root = fixture();
  try {
    addManagedRuntimeNodeModuleTopology(root);
    copyInstallerAssets(root);
    const assets = join(root, "packages", "installer", "assets");
    const before = hashTree(assets);
    symlinkSync(join(root, "node_modules", "fixture-dependency"), join(root, "node_modules", "absolute-contained"));

    assert.throws(() => copyInstallerAssets(root), /contains an absolute symlink/);
    assert.deepEqual(hashTree(assets), before, "absolute-link rejection must preserve the prior published assets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets rejects workspace target mismatches, dangling links, directory cycles, and special files", () => {
  const cases: Array<{ name: string; prepare: (root: string) => void; expected: RegExp }> = [
    {
      name: "workspace target mismatch",
      prepare: (root) => {
        const link = join(root, "node_modules", "@therealityreport", "tweakers-sdk");
        rmSync(link, { force: true });
        const external = join(root, "not-sdk");
        mkdirSync(external, { recursive: true });
        symlinkSync("../../not-sdk", link);
      },
      expected: /workspace symlink target mismatch/,
    },
    {
      name: "workspace package replaced with a physical directory",
      prepare: (root) => {
        const path = join(root, "node_modules", "@therealityreport", "tweakers-sdk");
        rmSync(path, { force: true });
        mkdirSync(path, { recursive: true });
      },
      expected: /workspace package must be an exact symlink/,
    },
    {
      name: "dangling ordinary link",
      prepare: (root) => symlinkSync("missing-target", join(root, "node_modules", "dangling-link")),
      expected: /dangling symlink/,
    },
    {
      name: "directory cycle through an ancestor",
      prepare: (root) => {
        mkdirSync(join(root, "node_modules", "cycle-package"), { recursive: true });
        symlinkSync("..", join(root, "node_modules", "cycle-package", "back"));
      },
      expected: /symlink cycle/,
    },
    {
      name: "special FIFO entry",
      prepare: (root) => execFileSync("mkfifo", [join(root, "node_modules", "unsupported.fifo")]),
      expected: /unsupported special entry/,
    },
    {
      name: "ordinary root bin symlink",
      prepare: (root) => symlinkSync("../node_modules/fixture-dependency/bin/fixture-tool.js", join(root, "bin", "unsafe-link")),
      expected: /symlink source must be inside node_modules/,
    },
    {
      name: "installer dist symlink",
      prepare: (root) => symlinkSync("cli.js", join(root, "packages", "installer", "dist", "unsafe-link.js")),
      expected: /symlink source must be inside node_modules/,
    },
    {
      name: "SDK dist symlink",
      prepare: (root) => symlinkSync("index.js", join(root, "packages", "sdk", "dist", "unsafe-link.js")),
      expected: /symlink source must be inside node_modules/,
    },
    {
      name: "SDK package manifest symlink",
      prepare: (root) => {
        const packageJson = join(root, "packages", "sdk", "package.json");
        writeFileSync(join(root, "packages", "sdk", "alternate-package.json"), '{"type":"module"}\n');
        rmSync(packageJson, { force: true });
        symlinkSync("alternate-package.json", packageJson);
      },
      expected: /symlink source must be inside node_modules/,
    },
    {
      name: "nested SDK dist symlink",
      prepare: (root) => {
        const nested = join(root, "packages", "sdk", "dist", "nested");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "source.js"), "export const nested = true;\n");
        symlinkSync("source.js", join(nested, "unsafe-link.js"));
      },
      expected: /symlink source must be inside node_modules/,
    },
    {
      name: ".bin directory target",
      prepare: (root) => symlinkSync("../fixture-dependency/bin", join(root, "node_modules", ".bin", "directory-target")),
      expected: /\.bin symlink must target a regular executable file/,
    },
  ];
  for (const scenario of cases) {
    const root = fixture();
    try {
      addManagedRuntimeNodeModuleTopology(root);
      scenario.prepare(root);
      assert.throws(() => copyInstallerAssets(root), scenario.expected, scenario.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("copy-assets materializes a contained relative staged-assets link as a physical sealed file", () => {
  const root = fixture();
  try {
    const lifecycle = addMcpLifecycleSource(root);
    symlinkSync("manifest.json", join(lifecycle, "contained-manifest-link"));

    copyInstallerAssets(root);
    const copied = join(
      root,
      "packages",
      "installer",
      "assets",
      "managed-runtime",
      "packages",
      "installer",
      "assets",
      "mcp-lifecycle",
      "contained-manifest-link",
    );
    assert.equal(lstatSync(copied).isSymbolicLink(), false);
    assert.equal(readFileSync(copied, "utf8"), readFileSync(join(lifecycle, "manifest.json"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets rejects a staged-assets link that re-enters managed-runtime output", () => {
  const root = fixture();
  try {
    const lifecycle = addMcpLifecycleSource(root);
    // This source link survives the ordinary lifecycle copy verbatim and then
    // resolves inside the generated-assets transaction.  It must still be
    // rejected before it can re-enter managed-runtime from that second copy.
    symlinkSync("../managed-runtime", join(lifecycle, "reenter-managed-runtime"));
    assert.throws(() => copyInstallerAssets(root), /may not re-enter staged managed-runtime output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets rejects aliases into generated publication workspaces before publishing", () => {
  const root = fixture();
  try {
    addManagedRuntimeNodeModuleTopology(root);
    copyInstallerAssets(root);
    const assets = join(root, "packages", "installer", "assets");
    const before = hashTree(assets);
    mkdirSync(join(root, "node_modules", ".assets.publish-fixture"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".assets.publish-fixture", "payload.js"), "generated\n");
    symlinkSync(".assets.publish-fixture", join(root, "node_modules", "published-alias"));

    assert.throws(() => copyInstallerAssets(root), /generated publication workspace/);
    assert.deepEqual(hashTree(assets), before, "generated-workspace rejection must preserve prior assets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy-assets verifies every materialized .bin target remains executable after manager exclusions", () => {
  const root = fixture();
  try {
    addManagedRuntimeNodeModuleTopology(root);
    copyInstallerAssets(root);
    const assets = join(root, "packages", "installer", "assets");
    const before = hashTree(assets);
    symlinkSync(
      "../@therealityreport/tweakers-installer/dist/manager.mjs",
      join(root, "node_modules", ".bin", "removed-manager"),
    );

    assert.throws(() => copyInstallerAssets(root), /\.bin shim target is missing after staging/);
    assert.deepEqual(hashTree(assets), before, "missing remapped .bin target must preserve prior assets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped MCP lifecycle copy transaction cannot touch runtime, manager, catalog, loader, or tweaks", () => {
  const root = fixture();
  try {
    const source = addMcpLifecycleSource(root);
    const shipped = addStaleShippedAssets(root);
    const protectedPaths = [
      join(root, "packages", "installer", "assets", "runtime"),
      join(root, "packages", "installer", "assets", "manager-launcher"),
      join(root, "packages", "installer", "assets", "loader.cjs"),
      join(root, "store", "index.json"),
      join(root, "tweaks", "alpha"),
    ];
    mkdirSync(protectedPaths[0], { recursive: true });
    mkdirSync(protectedPaths[1], { recursive: true });
    writeFileSync(join(protectedPaths[0], "sentinel.js"), "runtime before\n");
    writeFileSync(join(protectedPaths[1], "sentinel.mjs"), "manager before\n");
    const snapshotProtected = () => [
      hashTree(protectedPaths[0]),
      hashTree(protectedPaths[1]),
      readFileSync(protectedPaths[2], "utf8"),
      readFileSync(protectedPaths[3], "utf8"),
      hashTree(protectedPaths[4]),
    ];
    const before = snapshotProtected();

    const result = copyInstallerAssets(root, { only: "mcp-lifecycle" });

    assert.equal(result.scoped, "mcp-lifecycle");
    assert.deepEqual(hashTree(shipped), hashTree(source));
    assert.deepEqual(snapshotProtected(), before);
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

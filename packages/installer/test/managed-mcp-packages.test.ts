import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stageCodexManagedMcpPackages } from "../src/managed-mcp-packages.ts";

test("stages exact Chrome and shared Playwright runtimes with receipt-ready route evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-mcp-"));
  try {
    const fleet = createFleet(root);
    const managedRoot = join(root, "internal", "managed-mcp");
    const first = stageCodexManagedMcpPackages({
      ...fleet,
      managedMcpRoot: managedRoot,
      now: () => "2026-07-19T20:00:00.000Z",
    });

    assert.equal(first.schemaVersion, 1);
    assert.equal(first.managedRoot, managedRoot);
    assert.equal(first.stagedAt, "2026-07-19T20:00:00.000Z");
    assert.deepEqual(first.packages.map((value) => value.disposition), ["staged", "staged"]);
    assert.equal(first.packages.every((value) => /^[a-f0-9]{64}$/.test(value.lockSha256)), true);
    assert.equal(first.packages.every((value) => value.integrity.startsWith("sha512-")), true);
    assert.equal(first.packages.every((value) => /^[a-f0-9]{64}$/.test(value.runtimeTreeDigestSha256)), true);

    const chrome = first.packages.find((value) => value.name === "chrome-devtools-mcp");
    const playwright = first.packages.find((value) => value.name === "@playwright/mcp");
    assert.ok(chrome);
    assert.ok(playwright);
    assert.equal(existsSync(join(chrome.destination, "node_modules", "chrome-devtools-mcp", "cli.js")), true);
    assert.equal(existsSync(join(playwright.destination, "node_modules", "@playwright", "mcp", "cli.js")), true);
    const chromeBin = join(chrome.destination, "node_modules", ".bin", "chrome-devtools-mcp");
    const playwrightBin = join(playwright.destination, "node_modules", ".bin", "playwright-mcp");
    assert.equal(lstatSync(chromeBin).isSymbolicLink(), true);
    assert.equal(readlinkSync(chromeBin), "../chrome-devtools-mcp/cli.js");
    assert.equal(lstatSync(playwrightBin).isSymbolicLink(), true);
    assert.equal(readlinkSync(playwrightBin), "../@playwright/mcp/cli.js");
    assert.deepEqual(chrome.routes.map((route) => route.routeId), ["chrome-devtools/upstream-delegate"]);
    assert.deepEqual(playwright.routes.map((route) => route.profile), ["general", "infographic"]);
    assert.deepEqual(playwright.routes.map((route) => route.args), [
      ["--profile", "general"],
      ["--profile", "infographic"],
    ]);
    assert.equal(JSON.stringify(first).includes("npx"), false);
    assert.equal(JSON.stringify(first).includes("@latest"), false);

    const second = stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot });
    assert.deepEqual(second.packages.map((value) => value.disposition), ["reused", "reused"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomically replaces a corrupt version directory without leaving swap directories", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-mcp-repair-"));
  try {
    const fleet = createFleet(root);
    const managedRoot = join(root, "managed-mcp");
    const first = stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot });
    const chrome = first.packages[0];
    const manifest = join(chrome.destination, "node_modules", "chrome-devtools-mcp", "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "chrome-devtools-mcp", version: "0.0.0" }));

    const repaired = stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot });
    assert.equal(repaired.packages[0].disposition, "replaced");
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "1.6.0");
    assert.deepEqual(readdirSync(join(managedRoot, "chrome-devtools-mcp")).filter((name) => name.startsWith(".")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replaces a reused runtime when a non-entrypoint imported module is tampered", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-mcp-tree-tamper-"));
  try {
    const fleet = createFleet(root);
    const managedRoot = join(root, "managed-mcp");
    const first = stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot });
    const helper = join(first.packages[0].destination, "node_modules", "chrome-devtools-mcp", "lib", "helper.js");
    writeFileSync(helper, "export const fixture = 'tampered';\n");

    const repaired = stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot });
    assert.equal(repaired.packages[0].disposition, "replaced");
    assert.equal(readFileSync(helper, "utf8"), "export const fixture = 'trusted';\n");
    assert.equal(repaired.packages[1].disposition, "reused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on catalog drift before touching a valid managed package", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-mcp-catalog-"));
  try {
    const fleet = createFleet(root);
    const managedRoot = join(root, "managed-mcp");
    const first = stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot });
    const destinationManifest = join(first.packages[0].destination, "node_modules", "chrome-devtools-mcp", "package.json");
    const before = readFileSync(destinationManifest);
    const catalog = join(fleet.chromePluginRoot, "release", "chrome-devtools-mcp.catalog.json");
    const value = JSON.parse(readFileSync(catalog, "utf8"));
    value.upstreamSurface.tools = [];
    writeJson(catalog, value);

    assert.throws(
      () => stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: managedRoot }),
      /catalog digest/i,
    );
    assert.deepEqual(readFileSync(destinationManifest), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects lock integrity disagreement and floating launch wrappers", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-mcp-lock-"));
  try {
    const fleet = createFleet(root);
    const chromeLockFile = join(fleet.chromePluginRoot, "release", "chrome-devtools-mcp.lock.json");
    const lock = JSON.parse(readFileSync(chromeLockFile, "utf8"));
    lock.package.integrity = `sha512-${Buffer.from("different-integrity").toString("base64")}`;
    writeJson(chromeLockFile, lock);
    assert.throws(
      () => stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: join(root, "managed-mcp") }),
      /identity or integrity/i,
    );

    const restored = createFleet(join(root, "replacement"));
    writeFileSync(join(restored.chromePluginRoot, "bin", "chrome-devtools-mcp-locked"), "#!/bin/sh\nnpx chrome-devtools-mcp@latest\n");
    assert.throws(
      () => stageCodexManagedMcpPackages({ ...restored, managedMcpRoot: join(root, "managed-mcp-2") }),
      /floating npx or @latest/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses external-volume managed roots before reading plugin sources", () => {
  assert.throws(
    () => stageCodexManagedMcpPackages({
      chromePluginRoot: "/missing/chrome",
      playwrightPluginRoot: "/missing/playwright",
      managedMcpRoot: "/Volumes/HardDrive/managed-mcp",
    }),
    /internal storage/i,
  );
});

test("refuses external-volume plugin release sources", () => {
  assert.throws(
    () => stageCodexManagedMcpPackages({
      chromePluginRoot: "/Volumes/HardDrive/chrome-devtools",
      playwrightPluginRoot: "/missing/playwright",
      managedMcpRoot: "/Users/example/Library/Application Support/Tweakers/managed-mcp",
    }),
    /internal storage/i,
  );
});

test("rejects a runtime symlink whose target escapes the attested tree", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-managed-mcp-symlink-escape-"));
  try {
    const fleet = createFleet(root);
    const runtimeRoot = join(fleet.chromePluginRoot, "release", "runtime");
    const link = join(runtimeRoot, "node_modules", ".bin", "escape");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync("../../../../../../not-in-managed-mcp-runtime.js", link);
    const lockFile = join(fleet.chromePluginRoot, "release", "chrome-devtools-mcp.lock.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    const tree = digestRuntimeTree(runtimeRoot);
    lock.runtime.treeEntryCount = tree.entryCount;
    lock.runtime.treeDigestSha256 = tree.digestSha256;
    writeJson(lockFile, lock);

    assert.throws(
      () => stageCodexManagedMcpPackages({ ...fleet, managedMcpRoot: join(root, "managed-mcp") }),
      /symlink .* escapes the runtime root/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFleet(root: string): { chromePluginRoot: string; playwrightPluginRoot: string } {
  const chromePluginRoot = join(root, "chrome-devtools");
  const playwrightPluginRoot = join(root, "infographic-docs");
  createReleaseFixture({
    pluginRoot: chromePluginRoot,
    lockName: "chrome-devtools-mcp.lock.json",
    catalogName: "chrome-devtools-mcp.catalog.json",
    packageName: "chrome-devtools-mcp",
    packageVersion: "1.6.0",
    packageDirectory: "chrome-devtools-mcp",
    kind: "chrome",
  });
  createReleaseFixture({
    pluginRoot: playwrightPluginRoot,
    lockName: "playwright-mcp.lock.json",
    catalogName: "playwright-mcp.catalog.json",
    packageName: "@playwright/mcp",
    packageVersion: "0.0.78",
    packageDirectory: "playwright-mcp",
    kind: "playwright",
  });
  return { chromePluginRoot, playwrightPluginRoot };
}

function createReleaseFixture(input: {
  pluginRoot: string;
  lockName: string;
  catalogName: string;
  packageName: string;
  packageVersion: string;
  packageDirectory: string;
  kind: "chrome" | "playwright";
}): void {
  const releaseRoot = join(input.pluginRoot, "release");
  const runtimeRoot = join(releaseRoot, "runtime");
  const packagePath = `node_modules/${input.packageName}`;
  const packageRoot = join(runtimeRoot, ...packagePath.split("/"));
  const wrapperName = input.kind === "chrome" ? "chrome-devtools-mcp-locked" : "playwright-mcp-locked";
  const wrapperPath = join(input.pluginRoot, "bin", wrapperName);
  const integrity = `sha512-${Buffer.from(`${input.packageName}@${input.packageVersion}`).toString("base64")}`;
  const resolved = `https://registry.npmjs.test/${input.packageName}/-/${input.packageVersion}.tgz`;
  const packageJson = Buffer.from(`${JSON.stringify({ name: input.packageName, version: input.packageVersion })}\n`);
  const entrypoint = Buffer.from("import './lib/helper.js';\nprocess.stdout.write('fixture');\n");
  const helper = Buffer.from("export const fixture = 'trusted';\n");

  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), packageJson);
  writeFileSync(join(packageRoot, "cli.js"), entrypoint);
  writeFile(join(packageRoot, "lib", "helper.js"), helper);
  const binaryRoot = join(runtimeRoot, "node_modules", ".bin");
  mkdirSync(binaryRoot, { recursive: true });
  symlinkSync(
    input.kind === "chrome" ? "../chrome-devtools-mcp/cli.js" : "../@playwright/mcp/cli.js",
    join(binaryRoot, input.kind === "chrome" ? "chrome-devtools-mcp" : "playwright-mcp"),
  );
  writeFileSync(wrapperPath, "#!/usr/bin/env node\nprocess.stdout.write('locked');\n");
  writeJson(join(runtimeRoot, "package.json"), {
    name: `${input.packageDirectory}-managed-runtime`,
    private: true,
    version: "0.0.0",
    dependencies: { [input.packageName]: input.packageVersion },
  });
  writeJson(join(runtimeRoot, "package-lock.json"), {
    name: `${input.packageDirectory}-managed-runtime`,
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [input.packageName]: input.packageVersion } },
      [packagePath]: { version: input.packageVersion, resolved, integrity },
    },
  });

  const dependency = {
    path: packagePath,
    name: input.packageName,
    version: input.packageVersion,
    integrity,
    resolved,
    packageJsonSha256: sha256(packageJson),
  };
  const profiles = input.kind === "playwright" ? {
    general: { owner: "global:playwright/general-isolated", lifecycleScope: "task", args: ["--isolated"] },
    infographic: {
      owner: "plugin:infographic-docs/infographic-preview-playwright",
      lifecycleScope: "task",
      args: ["--headless", "--browser", "chrome"],
    },
  } : undefined;

  let catalog: Record<string, unknown>;
  if (input.kind === "chrome") {
    const sourcePath = "tools/catalog-source.json";
    const sourceBytes = Buffer.from("{}\n");
    writeFile(join(input.pluginRoot, sourcePath), sourceBytes);
    const sources = [{ path: sourcePath, sha256: sha256(sourceBytes) }];
    const upstreamSurface = { tools: [{ name: "fixture_tool" }] };
    catalog = {
      schemaVersion: 1,
      package: { name: input.packageName, version: input.packageVersion },
      kind: "deterministic-local-route-catalog",
      sources,
      upstreamSurface,
      digestSha256: digestJson({ sources, upstreamSurface }),
    };
  } else {
    const surface = { tools: [{ name: "browser_fixture" }] };
    catalog = {
      schemaVersion: 1,
      package: { name: input.packageName, version: input.packageVersion },
      kind: "deterministic-managed-mcp-catalog",
      profiles,
      surface,
      digestSha256: digestJson({ profiles, surface }),
    };
  }
  const catalogPath = join(releaseRoot, input.catalogName);
  writeJson(catalogPath, catalog);
  const runtimeTree = digestRuntimeTree(runtimeRoot);

  writeJson(join(releaseRoot, input.lockName), {
    schemaVersion: 1,
    package: {
      name: input.packageName,
      version: input.packageVersion,
      integrity,
      entrypoint: "cli.js",
      packageJsonSha256: sha256(packageJson),
      entrypointSha256: sha256(entrypoint),
    },
    dependencyGraph: {
      packages: [dependency],
      digestSha256: digestJson([dependency]),
    },
    ...(profiles ? { profiles } : {}),
    catalog: {
      path: `release/${input.catalogName}`,
      digestSha256: catalog.digestSha256,
    },
    runtime: {
      wrapper: `bin/${wrapperName}`,
      managedRootEnvironment: "CODEX_MANAGED_MCP_ROOT",
      packageDirectory: input.packageDirectory,
      sourceCanaryRoot: "release/runtime",
      treeDigestFormat: "sha256-json-path-kind-mode-content-v1",
      treeEntryCount: runtimeTree.entryCount,
      treeDigestSha256: runtimeTree.digestSha256,
    },
    review: {
      policy: "newest-non-prerelease-semver",
      approvedVersion: input.packageVersion,
    },
  });
}

function writeFile(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestJson(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function digestRuntimeTree(root: string): { entryCount: number; digestSha256: string } {
  const entries: Array<
    | { path: string; type: "file"; mode: number; sha256: string }
    | { path: string; type: "symlink"; mode: number; target: string }
  > = [];
  const visit = (absolutePath: string): void => {
    const stat = lstatSync(absolutePath);
    const path = absolutePath.slice(root.length + 1).split("/").join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) visit(join(absolutePath, name));
    } else if (stat.isFile()) {
      entries.push({ path, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(absolutePath)) });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path, type: "symlink", mode: stat.mode & 0o7777, target: readlinkSync(absolutePath) });
    } else {
      throw new Error(`Unsupported fixture entry ${path}`);
    }
  };
  visit(root);
  return { entryCount: entries.length, digestSha256: digestJson(entries) };
}

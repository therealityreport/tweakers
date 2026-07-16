#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { discoverCanonicalTweaks } from "./sync-tweaks.mjs";

export function catalogEntries(catalog) {
  if (!catalog || !Array.isArray(catalog.entries)) {
    throw new Error("catalog must contain an entries array");
  }
  return catalog.entries.map((entry, index) => {
    const manifest = entry?.manifest ?? entry;
    if (!manifest || typeof manifest.id !== "string" || typeof manifest.name !== "string") {
      throw new Error(`entry ${index} must contain string id and name metadata`);
    }
    return { id: manifest.id, name: manifest.name };
  });
}

export function assertAllowedCatalog(catalog) {
  const entries = catalogEntries(catalog);
  const actual = new Map();
  for (const entry of entries) {
    if (actual.has(entry.id)) throw new Error(`duplicate catalog id: ${entry.id}`);
    actual.set(entry.id, entry.name);
  }
  return entries;
}

export function assertBundledCatalogSources(catalog) {
  assertAllowedCatalog(catalog);
  for (const entry of catalog.entries) {
    const id = entry?.manifest?.id ?? entry?.id;
    const source = entry?.source;
    if (source?.kind !== "bundled") continue;
    if (!source || source.kind !== "bundled" || typeof source.path !== "string" || !/^tweaks\/[A-Za-z0-9._-]+$/.test(source.path)) {
      throw new Error(`catalog entry ${id} must use a safe bundled source path`);
    }
  }
  return true;
}

export function assertCanonicalSourceParity(catalog, root = resolve(process.cwd())) {
  assertBundledCatalogSources(catalog);
  const canonical = discoverCanonicalTweaks(root);
  const byId = new Map(canonical.map((tweak) => [tweak.manifest.id, tweak]));
  const catalogBundled = catalog.entries.filter((entry) => entry.source?.kind === "bundled");
  assert.deepEqual(catalogBundled.map((entry) => entry.manifest.id).sort(), [...byId.keys()].sort(), "catalog bundled ids must exactly match canonical manifest folders");
  const sourceRoot = resolve(root, "tweaks");
  for (const entry of catalogBundled) {
    const id = entry.manifest.id;
    const expected = byId.get(id);
    if (!expected || entry.source.path !== expected.sourcePath) throw new Error(`catalog/source path mismatch for ${id}`);
    const sourceDir = resolve(root, entry.source.path);
    if (!sourceDir.startsWith(`${sourceRoot}/`) || !existsSync(sourceDir)) {
      throw new Error(`missing canonical tweak source for ${id}: ${entry.source.path}`);
    }
    const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
    if (manifest.id !== id || JSON.stringify(expected.manifest) !== JSON.stringify(entry.manifest)) {
      throw new Error(`catalog/source manifest mismatch for ${id}`);
    }
    const entryPath = manifest.main ? join(sourceDir, manifest.main) : join(sourceDir, "index.js");
    if (!existsSync(entryPath)) throw new Error(`canonical tweak source is missing an entry for ${id}`);
  }

  const packagedRoot = resolve(root, "packages/installer/assets/runtime/tweaks");
  if (!existsSync(packagedRoot)) return true;
  const expectedIds = canonical.map((tweak) => tweak.folder).sort();
  const actualIds = readdirSync(packagedRoot).filter((name) => statSync(join(packagedRoot, name)).isDirectory()).sort();
  assert.deepEqual(actualIds, expectedIds, "packaged runtime tweak ids must exactly match the catalog");
  for (const tweak of canonical) {
    assertTreeEqual(tweak.sourceDir, resolve(packagedRoot, tweak.folder), tweak.manifest.id);
  }
  return true;
}

function assertTreeEqual(source, packaged, id) {
  const sourceFiles = treeFiles(source);
  const packagedFiles = treeFiles(packaged);
  assert.deepEqual(packagedFiles, sourceFiles, `packaged source file list differs for ${id}`);
  for (const file of sourceFiles) {
    const sourceHash = createHash("sha256").update(readFileSync(join(source, file))).digest("hex");
    const packagedHash = createHash("sha256").update(readFileSync(join(packaged, file))).digest("hex");
    assert.equal(packagedHash, sourceHash, `packaged source differs for ${id}/${file}`);
  }
}

function treeFiles(root, prefix = "") {
  const files = [];
  for (const name of readdirSync(root).sort()) {
    if (name === "node_modules" || name === ".git" || name === "test" || name === "tests") continue;
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) files.push(...treeFiles(abs, rel));
    else files.push(rel);
  }
  return files.sort();
}

function fixtureCatalog(entries = [{ id: "com.example.one", name: "One" }]) {
  return { entries: entries.map((manifest) => ({ manifest, source: { kind: "bundled", path: `tweaks/${manifest.id}` } })) };
}

export function runSelfTest() {
  assert.doesNotThrow(() => assertAllowedCatalog(fixtureCatalog()));
  assert.throws(() => assertAllowedCatalog(fixtureCatalog([{ id: "com.example.one", name: "One" }, { id: "com.example.one", name: "Duplicate" }])), /duplicate/);
  assert.throws(() => assertBundledCatalogSources({ entries: [{ manifest: { id: "com.example.one", name: "One" }, source: { kind: "bundled", path: "../escape" } }] }), /safe bundled source path/);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    console.log("tweak catalog discovery self-test passed");
  } else if (process.argv[2]) {
    const catalogPath = resolve(process.argv[2]);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    assertCanonicalSourceParity(catalog, resolve(dirname(catalogPath), ".."));
    console.log(`tweak catalog parity passed: ${process.argv[2]}`);
  } else {
    console.error("usage: node scripts/check-tweak-catalog.mjs --self-test | <catalog.json>");
    process.exitCode = 2;
  }
}

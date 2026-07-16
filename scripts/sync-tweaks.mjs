import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FIELDS = ["id", "name", "version", "githubRepo", "description", "author", "homepage", "iconUrl", "tags", "scope", "main", "minRuntime", "permissions", "mcp", "mcpServer"];

export function discoverCanonicalTweaks(root) {
  const tweaksRoot = join(root, "tweaks");
  const seen = new Set();
  const tweaks = [];
  for (const folder of readdirSync(tweaksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const sourceDir = join(tweaksRoot, folder);
    const manifestPath = join(sourceDir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const field of ["id", "name", "version", "githubRepo"]) {
      if (typeof manifest[field] !== "string" || !manifest[field].trim()) throw new Error(`${folder}: manifest.${field} is required`);
    }
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(manifest.id)) throw new Error(`${folder}: invalid reverse-DNS id ${manifest.id}`);
    if (seen.has(manifest.id)) throw new Error(`duplicate tweak id: ${manifest.id}`);
    seen.add(manifest.id);
    const entry = manifest.main ?? ["index.js", "index.cjs", "index.mjs"].find((name) => existsSync(join(sourceDir, name)));
    if (!entry || typeof entry !== "string" || isAbsolute(entry) || unsafeRelative(entry)) throw new Error(`${folder}: manifest entry is unsafe or missing`);
    const entryPath = resolve(sourceDir, entry);
    if (!inside(sourceDir, entryPath) || !existsSync(entryPath) || !lstatSync(entryPath).isFile()) throw new Error(`${folder}: manifest entry is unsafe or missing`);
    validateSourceTree(sourceDir, folder);
    const relativeSource = relative(root, sourceDir);
    if (relativeSource.startsWith("..") || relativeSource.split(sep).includes("..")) throw new Error(`${folder}: unsafe source path`);
    tweaks.push({ folder, sourceDir, sourcePath: relativeSource.replaceAll(sep, "/"), manifest: pickManifest(manifest) });
  }
  return tweaks;
}

export function synchronizedCatalog(root, catalog, now = new Date().toISOString()) {
  const tweaks = discoverCanonicalTweaks(root);
  const existing = new Map((catalog.entries ?? []).map((entry) => [entry.id, entry]));
  const nonBundled = (catalog.entries ?? []).filter((entry) => entry.source?.kind !== "bundled");
  const bundled = tweaks.map((tweak) => {
    const previous = existing.get(tweak.manifest.id) ?? {};
    return {
      ...previous,
      id: tweak.manifest.id,
      available: previous.available ?? true,
      source: { kind: "bundled", path: tweak.sourcePath },
      manifest: tweak.manifest,
      approvedAt: previous.approvedAt ?? now,
      approvedBy: previous.approvedBy ?? "tweakers",
    };
  });
  return { ...catalog, entries: [...nonBundled, ...bundled].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function syncTweaks(root, { check = false, now } = {}) {
  const catalogPath = join(root, "store", "index.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const nextCatalog = synchronizedCatalog(root, catalog, now);
  const serialized = JSON.stringify(nextCatalog, null, 2) + "\n";
  const packagedRoot = join(root, "packages", "installer", "assets", "runtime", "tweaks");
  const expected = discoverCanonicalTweaks(root);
  const staleCatalog = readFileSync(catalogPath, "utf8") !== serialized;
  const stalePackage = !packageMatches(expected, packagedRoot);
  if (check) {
    if (staleCatalog || stalePackage) throw new Error(`tweak synchronization is stale:${staleCatalog ? " catalog" : ""}${stalePackage ? " packaged-assets" : ""}`);
    return { changed: false, count: expected.length };
  }
  if (staleCatalog) writeFileSync(catalogPath, serialized, "utf8");
  rmSync(packagedRoot, { recursive: true, force: true });
  mkdirSync(packagedRoot, { recursive: true });
  for (const tweak of expected) cpSync(tweak.sourceDir, join(packagedRoot, tweak.folder), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !path.split(/[\\/]/).some((part) => [".git", "node_modules", "test", "tests"].includes(part)),
  });
  writeFileSync(join(root, "packages", "installer", "assets", "runtime", "catalog.json"), serialized, "utf8");
  return { changed: staleCatalog || stalePackage, count: expected.length };
}

function pickManifest(manifest) {
  return Object.fromEntries(MANIFEST_FIELDS.filter((field) => manifest[field] !== undefined).map((field) => [field, manifest[field]]));
}

function packageMatches(tweaks, packagedRoot) {
  if (!existsSync(packagedRoot)) return false;
  const actual = readdirSync(packagedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(tweaks.map((tweak) => tweak.folder).sort())) return false;
  return tweaks.every((tweak) => treeFingerprint(tweak.sourceDir) === treeFingerprint(join(packagedRoot, tweak.folder)));
}

function treeFingerprint(root) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", "test", "tests"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const name = relative(root, path).replaceAll(sep, "/");
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) rows.push(`${name}\0symlink:${readlinkSync(path)}`);
      else if (entry.isFile()) rows.push(`${name}\0${readFileSync(path).toString("base64")}`);
    }
  };
  visit(root);
  return rows.join("\n");
}

function validateSourceTree(root, folder) {
  const canonicalRoot = realpathSync(root);
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "test", "tests"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try { target = realpathSync(path); } catch { throw new Error(`${folder}: broken symlink ${relative(root, path)}`); }
        if (!inside(canonicalRoot, target)) throw new Error(`${folder}: symlink escapes tweak source: ${relative(root, path)}`);
      } else if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
}

function unsafeRelative(path) {
  return path.split(/[\\/]/).some((part) => part === "..");
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = syncTweaks(root, { check: process.argv.includes("--check") });
  console.log(`tweak synchronization ${result.changed ? "updated" : "current"}: ${result.count} tweak(s)`);
}

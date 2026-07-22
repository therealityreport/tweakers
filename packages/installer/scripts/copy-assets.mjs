// Copies the loader stub + bundled runtime/manager into installer/assets/
// so the published npm package can extract them at install time.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  publishGeneratedDirectorySync,
  removeGeneratedConflictCopies,
} from "../../../scripts/generated-assets.mjs";
import { syncTweaks } from "../../../scripts/sync-tweaks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..", "..", "..");

export function copyInstallerAssets(root = defaultRoot, { publicationDependencies } = {}) {
  const out = resolve(root, "packages", "installer", "assets");
  const loaderSource = resolve(root, "packages", "loader", "loader.cjs");
  const runtimeSource = resolve(root, "packages", "runtime", "dist");
  const loaderAvailable = existsSync(loaderSource);
  const runtimeAvailable = existsSync(runtimeSource);
  let tweakCount = 0;
  let fingerprint = null;
  let pendingCatalog = null;
  const publication = publishGeneratedDirectorySync(out, (stagedAssets) => {
    if (existsSync(out)) cpSync(out, stagedAssets, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    else mkdirSync(stagedAssets, { recursive: true });

const copies = [
  ["packages/loader/loader.cjs", "loader.cjs"],
  ["packages/runtime/dist", "runtime"],
  ["packages/mcp-lifecycle", "mcp-lifecycle"],
];

    const stagedRuntime = join(stagedAssets, "runtime");
    if (runtimeAvailable) {
      rmSync(stagedRuntime, { recursive: true, force: true });
      cpSync(runtimeSource, stagedRuntime, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      const synchronized = syncTweaks(root, {
        packagedRuntimeRoot: stagedRuntime,
        deferCatalogWrite: true,
      });
      tweakCount = synchronized.count;
      pendingCatalog = synchronized.pendingCatalog;
      writeFileSync(
        join(stagedRuntime, "package.json"),
        `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
      );
      fingerprint = writeRuntimeFingerprint(stagedRuntime);
    }

    // Mode switching now lives in the existing Menu Bar app. Remove this only
    // from the staged tree so a later publication failure rolls it back too.
    rmSync(resolve(stagedAssets, "switcher"), { recursive: true, force: true });
    removeGeneratedConflictCopies(stagedAssets);
  }, {
    ...publicationDependencies,
    companionFiles: () => pendingCatalog
      ? [{ destination: pendingCatalog.path, data: pendingCatalog.serialized }]
      : [],
  });

  if (!loaderAvailable) console.warn("[copy-assets] skip (missing): packages/loader/loader.cjs");
  else console.log("[copy-assets] packages/loader/loader.cjs -> assets/loader.cjs");
  if (!runtimeAvailable) {
    console.warn("[copy-assets] skip (missing): packages/runtime/dist");
    return { runtimeCopied: false, tweakCount: 0, fingerprint: null, cleanupErrors: publication.cleanupErrors };
  }
  console.log("[copy-assets] packages/runtime/dist -> assets/runtime");
  console.log(`[copy-assets] synchronized ${tweakCount} bundled tweak(s) + catalog via sync-tweaks`);
  console.log(`[copy-assets] wrote runtime fingerprint for ${fingerprint.fileCount} file(s)`);
  return { runtimeCopied: true, tweakCount, fingerprint, cleanupErrors: publication.cleanupErrors };
}

export function writeRuntimeFingerprint(runtimeRoot) {
  const fingerprintFile = "runtime-fingerprint.json";
  // Physically remove Finder junk before hashing so shipped assets are clean.
  const sweepJunk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) sweepJunk(path);
      else if (entry.isFile() && entry.name === ".DS_Store") rmSync(path);
    }
  };
  sweepJunk(runtimeOut);
  const hash = createHash("sha256");
  let fileCount = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Junk skip must stay in lockstep with installer/src/runtime-fingerprint.ts
      // and runtime/src/watcher-health.ts.
      if (entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      const name = relative(runtimeRoot, path);
      if (name === fingerprintFile) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        fileCount += 1;
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(runtimeRoot);
  const receipt = { schemaVersion: 1, fingerprint: hash.digest("hex"), fileCount };
  writeFileSync(join(runtimeRoot, fingerprintFile), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) copyInstallerAssets();

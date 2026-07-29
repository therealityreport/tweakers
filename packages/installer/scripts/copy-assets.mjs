// Copies the loader stub + bundled runtime/manager into installer/assets/
// so the published npm package can extract them at install time.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncTweaks } from "../../../scripts/sync-tweaks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const out = resolve(here, "..", "assets");

mkdirSync(out, { recursive: true });

const copies = [
  ["packages/loader/loader.cjs", "loader.cjs"],
  ["packages/runtime/dist", "runtime"],
  ["packages/mcp-lifecycle", "mcp-lifecycle"],
];

// Mode switching now lives in the existing Menu Bar app. Prune the retired
// standalone status-item asset so a rebuild cannot reinstall a second icon.
rmSync(resolve(out, "switcher"), { recursive: true, force: true });

for (const [from, to] of copies) {
  const src = resolve(root, from);
  const dest = resolve(out, to);
  // A missing source must leave committed generated assets untouched after a
  // clean build on a platform that cannot produce that source.
  if (!existsSync(src)) {
    console.warn(`[copy-assets] skip (missing): ${from}`);
    continue;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-assets] ${from} -> assets/${to}`);
}

// Bundle the canonical tweaks + synchronized catalog beside the generated
// runtime. sync-tweaks.mjs is the single writer for this generated tree: it
// discovers every manifest-bearing folder under tweaks/, so a new tweak can
// never be silently dropped by a stale hardcoded id list (the old bundledIds
// array here and sync-tweaks used to fight over the same output files).
const { count } = syncTweaks(root);
console.log(`[copy-assets] synchronized ${count} bundled tweak(s) + catalog via sync-tweaks`);

const runtimeOut = resolve(out, "runtime");
if (existsSync(runtimeOut)) {
  // Installer is an ESM package while runtime is compiled as CommonJS. Keep
  // the copied runtime's module boundary explicit so the headless MCP helper
  // can execute directly with Node from inside installer/assets/runtime.
  writeFileSync(
    join(runtimeOut, "package.json"),
    `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
  );
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
      const name = relative(runtimeOut, path);
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
  visit(runtimeOut);
  writeFileSync(
    join(runtimeOut, fingerprintFile),
    `${JSON.stringify({ schemaVersion: 1, fingerprint: hash.digest("hex"), fileCount }, null, 2)}\n`,
  );
  console.log(`[copy-assets] wrote runtime fingerprint for ${fileCount} file(s)`);
}

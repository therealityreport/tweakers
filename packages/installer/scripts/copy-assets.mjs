// Copies the loader stub + bundled runtime/manager into installer/assets/
// so the published npm package can extract them at install time.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncTweaks } from "../../../scripts/sync-tweaks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const out = resolve(here, "..", "assets");

mkdirSync(out, { recursive: true });

const copies = [
  ["packages/loader/loader.cjs", "loader.cjs"],
  ["packages/runtime/dist", "runtime"],
  // Prebuilt (ad-hoc signed) menu-bar switcher; `tweakers mode setup` copies it
  // to the user root and re-signs it with the per-machine local identity.
  ["packages/switcher/dist/Tweakers Switcher.app", "switcher/Tweakers Switcher.app"],
];

for (const [from, to] of copies) {
  const src = resolve(root, from);
  const dest = resolve(out, to);
  // A missing source must leave the committed asset untouched: the prebuilt
  // switcher legitimately has no dist on non-darwin hosts (its build script
  // exits 0 without output) and after `npm run clean` — deleting the
  // destination first would silently strip the checked-in asset from the tree.
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

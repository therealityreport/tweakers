import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userPaths } from "../paths.js";
import {
  defaultLegacyMigrationRoots,
  migrateLegacyProjects,
  type LegacyMigrationReport,
} from "../legacy-migration.js";

export interface MigrateOptions {
  apply?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  legacyRoot?: string;
  "legacy-root"?: string;
  targetRoot?: string;
  "target-root"?: string;
  canonicalTweaksRoot?: string;
}

export function migrate(options: MigrateOptions = {}): LegacyMigrationReport[] {
  const apply = options.apply === true && options.dryRun !== true && options["dry-run"] !== true;
  // `migrate` defaults to a dry run, so resolving defaults must not create the
  // target directory as a side effect.
  const targetRoot = resolve(options.targetRoot ?? options["target-root"] ?? userPaths().root);
  const canonicalTweaksRoot = resolve(
    options.canonicalTweaksRoot ?? fileURLToPath(new URL("../../assets/runtime/tweaks", import.meta.url)),
  );
  const explicit = options.legacyRoot ?? options["legacy-root"];
  const roots = explicit ? [resolve(explicit)] : defaultLegacyMigrationRoots(homedir()).filter(existsSync);
  if (roots.length === 0) {
    console.log("No legacy Tweakers roots found; nothing to migrate.");
    return [];
  }
  const reports = [migrateLegacyProjects({
    apply,
    legacyRoots: roots,
    targetRoot,
    canonicalTweaksRoot,
  })];
  for (const report of reports) console.log(JSON.stringify(report));
  if (!apply) console.log("Dry run only. Re-run with --apply to write the planned migration.");
  return reports;
}

/** Automatic install path. It is intentionally no-op unless a distinct legacy root exists. */
export function migrateAutomatically(targetRoot: string, canonicalTweaksRoot: string): LegacyMigrationReport[] {
  const roots = defaultLegacyMigrationRoots(homedir())
    .filter((legacyRoot) => existsSync(legacyRoot) && resolve(legacyRoot) !== resolve(targetRoot));
  return roots.length === 0 ? [] : [migrateLegacyProjects({ apply: true, legacyRoots: roots, targetRoot, canonicalTweaksRoot })];
}

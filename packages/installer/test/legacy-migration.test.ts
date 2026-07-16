import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { CANONICAL_TWEAK_DIRS, migrateLegacyProjects } from "../src/legacy-migration.js";

const repoRoot = resolve(process.cwd());
const fixture = JSON.parse(readFileSync(
  join(repoRoot, "packages/runtime/test/fixtures/legacy-projects-github-accounts.json"),
  "utf8",
));

test("production migration dry-run/apply is exact-catalog, selective, source-preserving, and idempotent", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-product-migration-"));
  const legacyRoot = join(temp, "legacy");
  const targetRoot = join(temp, "target");
  const canonicalRoot = join(temp, "canonical");
  try {
    for (const name of CANONICAL_TWEAK_DIRS) {
      const dir = join(canonicalRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: name }));
      writeFileSync(join(dir, "index.js"), `module.exports=${JSON.stringify({ canonical: name })};\n`);
    }
    for (const name of fixture.legacyRoots) {
      const dir = join(legacyRoot, "tweaks", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.js"), `module.exports=${JSON.stringify({ legacy: name })};\n`);
    }
    mkdirSync(join(legacyRoot, "state"), { recursive: true });
    writeFileSync(join(legacyRoot, "state", "co.tweakers.projects.json"), JSON.stringify(fixture.legacyProjects));
    writeFileSync(join(legacyRoot, "state", "co.tweakers.github-accounts.json"), JSON.stringify(fixture.legacyGithubAccounts));
    const sourceBefore = treeDigest(legacyRoot);

    const dryRun = migrateLegacyProjects({ legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.equal(existsSync(targetRoot), false, "dry-run must not write");
    const applied = migrateLegacyProjects({ apply: true, legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.deepEqual(applied.counts, dryRun.counts, "dry-run and apply planned counts match");
    assert.deepEqual(applied.counts, {
      catalogEntries: CANONICAL_TWEAK_DIRS.length,
      codeCopies: CANONICAL_TWEAK_DIRS.length,
      stateMerges: 1,
      // github-accounts, the unallowlisted tweak, and the retired mode-switcher.
      excludedLegacyRoots: 3,
      targetQuarantines: 0,
      unchanged: 0,
    });
    assert.equal(treeDigest(legacyRoot), sourceBefore, "legacy source stays byte-for-byte unchanged");

    const installed = readdirSync(join(targetRoot, "tweaks")).sort();
    assert.deepEqual(installed, [...CANONICAL_TWEAK_DIRS].sort());
    assert.equal(installed.includes("co.tweakers.github-accounts"), false);
    assert.equal(installed.includes("co.example.unallowlisted-code"), false);
    assert.match(readFileSync(join(targetRoot, "tweaks", CANONICAL_TWEAK_DIRS[0], "index.js"), "utf8"), /canonical/);

    const stateFile = join(targetRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json");
    const projects = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(projects.nodes[0].type, "project");
    assert.match(projects.nodes[0].connections.github, /^gh:[a-f0-9]{24}$/);
    assert.equal("accounts" in projects, false, "account records and credentials are not duplicated into Projects");
    assert.equal(statSync(stateFile).mode & 0o077, 0);

    const secondDryRun = migrateLegacyProjects({ legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.deepEqual(secondDryRun.counts, {
      catalogEntries: CANONICAL_TWEAK_DIRS.length,
      codeCopies: 0,
      stateMerges: 0,
      // github-accounts, the unallowlisted tweak, and the retired mode-switcher.
      excludedLegacyRoots: 3,
      targetQuarantines: 0,
      unchanged: CANONICAL_TWEAK_DIRS.length + 1,
    });
    const secondApply = migrateLegacyProjects({ apply: true, legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.deepEqual(secondApply.counts, secondDryRun.counts);
    assert.equal(treeDigest(legacyRoot), sourceBefore);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("dirty targets reconcile to exact canonical trees and quarantine extras", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-dirty-target-"));
  try {
    const legacyRoot = join(temp, "legacy");
    const targetRoot = join(temp, "target");
    const canonicalRoot = join(temp, "canonical");
    mkdirSync(legacyRoot, { recursive: true });
    for (const name of CANONICAL_TWEAK_DIRS) {
      mkdirSync(join(canonicalRoot, name), { recursive: true });
      writeFileSync(join(canonicalRoot, name, "index.js"), `// canonical ${name}\n`);
    }
    mkdirSync(join(targetRoot, "tweaks", CANONICAL_TWEAK_DIRS[0]), { recursive: true });
    chmodSync(join(targetRoot, "tweaks"), 0o700);
    writeFileSync(join(targetRoot, "tweaks", CANONICAL_TWEAK_DIRS[0], "stale.js"), "credential-bearing stale executable");
    mkdirSync(join(targetRoot, "tweaks", "better-browser-agent"), { recursive: true });
    writeFileSync(join(targetRoot, "tweaks", "better-browser-agent", "index.js"), "// excluded");

    const planned = migrateLegacyProjects({ legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.equal(planned.counts.targetQuarantines, 2);
    const applied = migrateLegacyProjects({ apply: true, legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.deepEqual(applied.counts, planned.counts);
    assert.deepEqual(readdirSync(join(targetRoot, "tweaks")).sort(), [...CANONICAL_TWEAK_DIRS].sort());
    assert.equal(existsSync(join(targetRoot, "tweaks", CANONICAL_TWEAK_DIRS[0], "stale.js")), false);
    assert.equal(readdirSync(join(targetRoot, "migration-backup")).length, 1);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("symlinked target root and permission drift are quarantined without following links", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-unsafe-target-"));
  try {
    const legacyRoot = join(temp, "legacy");
    const targetRoot = join(temp, "target");
    const canonicalRoot = join(temp, "canonical");
    const external = join(temp, "external");
    mkdirSync(legacyRoot, { recursive: true });
    for (const name of CANONICAL_TWEAK_DIRS) {
      mkdirSync(join(canonicalRoot, name), { recursive: true });
      writeFileSync(join(canonicalRoot, name, "index.js"), `// ${name}\n`);
      mkdirSync(join(external, name), { recursive: true });
      writeFileSync(join(external, name, "index.js"), `// ${name}\n`);
    }
    mkdirSync(targetRoot, { recursive: true });
    symlinkSync(external, join(targetRoot, "tweaks"));
    const planned = migrateLegacyProjects({ legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.equal(planned.counts.targetQuarantines, 1);
    migrateLegacyProjects({ apply: true, legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.equal(statSync(join(targetRoot, "tweaks")).isDirectory(), true);
    assert.equal(readFileSync(join(external, CANONICAL_TWEAK_DIRS[0], "index.js"), "utf8"), `// ${CANONICAL_TWEAK_DIRS[0]}\n`);

    const driftFile = join(targetRoot, "tweaks", CANONICAL_TWEAK_DIRS[0], "index.js");
    chmodSync(driftFile, 0o777);
    const drift = migrateLegacyProjects({ legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.equal(drift.counts.codeCopies, 1);
    assert.equal(drift.counts.targetQuarantines, 1);
    migrateLegacyProjects({ apply: true, legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.equal(statSync(driftFile).mode & 0o777, 0o600);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("multi-root migration uses one deterministic plan and strips hostile connection data", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-multi-root-"));
  try {
    const roots = [join(temp, "legacy-a"), join(temp, "legacy-b")];
    const targetRoot = join(temp, "target");
    const canonicalRoot = join(temp, "canonical");
    for (const name of CANONICAL_TWEAK_DIRS) {
      mkdirSync(join(canonicalRoot, name), { recursive: true });
      writeFileSync(join(canonicalRoot, name, "index.js"), `// ${name}\n`);
    }
    for (const [index, root] of roots.entries()) {
      mkdirSync(join(root, "state"), { recursive: true });
      writeFileSync(join(root, "state", "co.tweakers.projects.json"), JSON.stringify({ schemaVersion: 1, nodes: [{
        id: "shared", name: index === 0 ? "First root wins" : "Second root",
        projectPath: `/workspace/${index}`,
        connections: { environment: index === 0 ? "environment:default" : { token: "secret" }, modal: "token=secret" },
      }] }));
      writeFileSync(join(root, "state", "co.tweakers.github-accounts.json"), JSON.stringify({
        accounts: [{ id: `account-${index}`, login: `user-${index}`, token: "must-not-copy" }], assignments: { shared: `account-${index}` },
      }));
    }
    const dryRun = migrateLegacyProjects({ legacyRoots: roots, targetRoot, canonicalTweaksRoot: canonicalRoot });
    const applied = migrateLegacyProjects({ apply: true, legacyRoots: roots, targetRoot, canonicalTweaksRoot: canonicalRoot });
    assert.deepEqual(applied.counts, dryRun.counts);
    const state = JSON.parse(readFileSync(join(targetRoot, "tweak-data", "co.tweakers.projects", "projects-v1.json"), "utf8"));
    assert.equal(state.nodes[0].name, "First root wins");
    assert.equal(state.nodes[0].connections.environment, "environment:default");
    assert.equal("modal" in state.nodes[0].connections, false);
    assert.equal(JSON.stringify(state).includes("must-not-copy"), false);
    assert.equal(JSON.stringify(state).includes("token"), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("invalid legacy project graphs stop the state item before writes", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-invalid-graph-"));
  try {
    const legacyRoot = join(temp, "legacy");
    const targetRoot = join(temp, "target");
    const canonicalRoot = join(temp, "canonical");
    for (const name of CANONICAL_TWEAK_DIRS) {
      mkdirSync(join(canonicalRoot, name), { recursive: true });
      writeFileSync(join(canonicalRoot, name, "index.js"), "// canonical\n");
    }
    mkdirSync(join(legacyRoot, "state"), { recursive: true });
    writeFileSync(join(legacyRoot, "state", "co.tweakers.projects.json"), JSON.stringify({ schemaVersion: 1, nodes: [
      { id: "a", type: "group", name: "A", parentId: "b" },
      { id: "b", type: "group", name: "B", parentId: "a" },
    ] }));
    assert.throws(() => migrateLegacyProjects({ apply: true, legacyRoot, targetRoot, canonicalTweaksRoot: canonicalRoot }), /Cyclic/);
    assert.equal(existsSync(targetRoot), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("production migration rejects a bundle that is not the exact canonical contract", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-bad-bundle-"));
  try {
    const canonicalRoot = join(temp, "canonical");
    mkdirSync(join(canonicalRoot, CANONICAL_TWEAK_DIRS[0]), { recursive: true });
    assert.throws(() => migrateLegacyProjects({
      legacyRoot: join(temp, "legacy"), targetRoot: join(temp, "target"), canonicalTweaksRoot: canonicalRoot,
    }), new RegExp(`exactly the ${CANONICAL_TWEAK_DIRS.length} approved`));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("built migrate CLI is a real dry-run command and does not create its target", () => {
  const temp = mkdtempSync(join(tmpdir(), "tweakers-migrate-cli-"));
  try {
    const legacyRoot = join(temp, "legacy");
    const targetRoot = join(temp, "target");
    mkdirSync(join(legacyRoot, "tweaks", "co.tweakers.github-accounts"), { recursive: true });
    const result = spawnSync(process.execPath, [
      join(repoRoot, "packages/installer/dist/cli.js"), "migrate", "--dry-run",
      "--legacy-root", legacyRoot, "--target-root", targetRoot,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"mode":"dry-run"/);
    assert.match(result.stdout, /Dry run only/);
    assert.equal(existsSync(targetRoot), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of walk(root)) {
    hash.update(file);
    hash.update(readFileSync(join(root, file)));
  }
  return hash.digest("hex");
}

function walk(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().flatMap((name) => {
    const full = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? walk(full, relative) : [relative];
  });
}

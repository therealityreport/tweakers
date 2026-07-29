import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_ALIASES = [
  "TWEAKER_HOME",
  "TWEAKERS_HOME",
  "TWEAKERS_USER_ROOT",
  "TWEAKER_USER_ROOT",
  "CODEX_PLUSPLUS_USER_ROOT",
  "CODEX_PLUSPLUS_HOME",
] as const;

test("test preload prevents inherited root aliases from capturing unscoped writes", () => {
  const sentinelRoot = mkdtempSync(join(tmpdir(), "tweakers-test-inherited-root-"));
  try {
    const env = { ...process.env };
    for (const name of ROOT_ALIASES) env[name] = sentinelRoot;

    const script = `
      const { existsSync } = await import("node:fs");
      const { ensureUserPaths } = await import(${JSON.stringify(
        pathToFileURL(resolve("packages/installer/src/paths.ts")).href,
      )});
      const { writeState } = await import(${JSON.stringify(
        pathToFileURL(resolve("packages/installer/src/state.ts")).href,
      )});
      const paths = ensureUserPaths();
      writeState(paths.stateFile, {
        version: "test",
        installedAt: "2026-07-21T00:00:00.000Z",
        appRoot: "/test/ChatGPT.app",
        originalAsarHash: "original",
        patchedAsarHash: "patched",
        codexVersion: "test",
        fuseFlipped: false,
        resigned: false,
        originalEntryPoint: "main.js",
        watcher: "none"
      });
      console.log(JSON.stringify({
        root: paths.root,
        stateExists: existsSync(paths.stateFile),
        aliasesPresent: ${JSON.stringify(ROOT_ALIASES)}.filter((name) => process.env[name] !== undefined)
      }));
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("scripts/test-root-preload.mjs")).href,
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim()) as {
      root: string;
      stateExists: boolean;
      aliasesPresent: string[];
    };
    assert.notEqual(report.root, sentinelRoot);
    const relativeToTemp = relative(resolve(tmpdir()), resolve(report.root));
    assert.equal(isAbsolute(relativeToTemp), false);
    assert.equal(relativeToTemp === ".." || relativeToTemp.startsWith(`..${sep}`), false);
    assert.match(report.root, /tweakers-test-guard-/);
    assert.equal(report.stateExists, true);
    assert.deepEqual(report.aliasesPresent, []);
    assert.equal(existsSync(join(sentinelRoot, "state.json")), false);
    assert.equal(existsSync(report.root), false, "child preload must remove its fallback root on normal exit");
  } finally {
    rmSync(sentinelRoot, { recursive: true, force: true });
  }
});

test("explicit TWEAKERS_HOME remains authoritative after the preload", async () => {
  const explicitRoot = mkdtempSync(join(tmpdir(), "tweakers-test-explicit-root-"));
  const previous = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = explicitRoot;
  try {
    const { userPaths } = await import("../src/paths.js");
    assert.equal(userPaths().root, explicitRoot);
  } finally {
    if (previous === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = previous;
    rmSync(explicitRoot, { recursive: true, force: true });
  }
});

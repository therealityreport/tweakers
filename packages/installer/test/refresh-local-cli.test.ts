import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));

function runCli(args: string[]) {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-refresh-cli-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, TWEAKERS_HOME: userRoot },
  });
  rmSync(userRoot, { recursive: true, force: true });
  return result;
}

test("refresh-local CLI exposes the explicit development worktree option", () => {
  const result = runCli(["refresh-local", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--development-root/);
  assert.match(result.stdout, /requires --source development/);
});

test("refresh-local CLI forwards --development-root to early source validation", () => {
  const wrongSource = runCli([
    "refresh-local",
    "--source", "stable",
    "--development-root", repositoryRoot,
  ]);
  assert.equal(wrongSource.status, 1);
  assert.match(wrongSource.stderr, /--development-root is valid only with --source development/);

  const relative = runCli([
    "refresh-local",
    "--source", "development",
    "--development-root", "relative/repo",
  ]);
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /--development-root must be an exact absolute path/);
});

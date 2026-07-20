import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("update-chatgpt-reconcile --json exposes the explicit idle result", () => {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-update-reconcile-cli-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "update-chatgpt-reconcile", "--json"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, TWEAKERS_HOME: userRoot },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      transactionId: null,
      phase: "idle",
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

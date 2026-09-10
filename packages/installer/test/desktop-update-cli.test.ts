import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("CLI exposes only read-only official-update history diagnostics", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /update-chatgpt-status\s+Print read-only historical desktop update transaction status/);
  for (const command of [
    "update-chatgpt",
    "update-codex",
    "update-chatgpt-resume",
    "update-chatgpt-reconcile",
    "update-chatgpt-cancel",
  ]) {
    assert.doesNotMatch(result.stdout, new RegExp(`^\\s+${command}\\s`, "m"));
  }
});

test("retired official-update command is rejected before any handler can run", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-retired-update-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "update-chatgpt", "--json"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, TWEAKERS_HOME: userRoot },
        timeout: 10_000,
      },
    );

    assert.notEqual(result.status, 0);
    assert.equal(result.signal, null);
    assert.doesNotMatch(result.stdout, /schemaVersion|transactionId/);
    assert.doesNotMatch(result.stderr, /native updater|official update initiated|Downloading/);
    assert.equal(existsSync(join(userRoot, "transactions")), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

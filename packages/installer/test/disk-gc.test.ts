import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installTransactionSweepDirectories,
  runInstallTransaction,
  sweepStaleTempDirs,
} from "../src/transaction";
import { pruneParkedPatchedApps } from "../src/commands/update-codex";

type Health = {
  host: "pass" | "fail" | "unknown";
  session: "pass" | "fail" | "unknown";
  permissions: Record<string, "pass" | "fail" | "unknown">;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tweaker-disk-gc-"));
  return {
    root,
    appRoot: join(root, "app"),
    runtimeRoot: join(root, "runtime"),
    workRoot: join(root, "work"),
    stateFile: join(root, "transaction-state.json"),
  };
}

function clean(root: string) {
  rmSync(root, { recursive: true, force: true });
}

test("a healthy transaction GCs pristine + candidate and keeps last-known-good", async () => {
  const f = fixture();
  try {
    const allRemovedPaths: string[] = [];
    const healthyGcPaths: string[] = [];
    let healthObserved = false;
    const health: Health = {
      host: "pass",
      session: "pass",
      permissions: { accessibility: "pass" },
    };
    const result = await runInstallTransaction({
      appRoot: f.appRoot,
      runtimeRoot: f.runtimeRoot,
      workRoot: f.workRoot,
      stateFile: f.stateFile,
      source: { version: "1.0.0", build: "fixture", hash: "fixture-hash" },
      requiredPermissions: ["accessibility"],
      now: new Date("2026-07-10T12:00:00.000Z"),
    }, {
      isAppRunning: () => false,
      copyApp: () => {},
      removeApp: (path: string) => {
        allRemovedPaths.push(path);
        if (healthObserved) healthyGcPaths.push(path);
      },
      buildCandidate: () => {},
      validateCandidate: () => true,
      probeCandidateHealth: () => health,
      fingerprintApp: () => ({ version: "1.0.0", build: "fixture", hash: "fixture-hash" }),
      isAppComplete: () => true,
      snapshotRuntime: () => {},
      promoteCandidate: () => {},
      restoreApp: () => {},
      restoreRuntime: () => {},
      probeHealth: () => {
        healthObserved = true;
        return health;
      },
      openApp: () => {},
    });

    assert.equal(result.status, "promoted");
    assert.deepEqual(healthyGcPaths, [result.state.pristineRoot, result.state.candidateRoot]);
    assert.ok(allRemovedPaths.includes(result.state.pristineRoot));
    assert.ok(allRemovedPaths.includes(result.state.candidateRoot));
    assert.equal(healthyGcPaths.includes(result.state.lastKnownGoodRoot), false);
    assert.equal(healthyGcPaths.includes(result.state.lastKnownGoodRuntimeRoot), false);
  } finally {
    clean(f.root);
  }
});

test("sweepStaleTempDirs removes only dead-PID temp dirs older than 24h", () => {
  const now = Date.parse("2026-07-14T16:00:00.000Z");
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const work = "/work";
  const names = [
    "Codex.app.tweakers-previous-4242",
    "Codex.app.tweakers-incoming-777",
    ".next-4242",
    ".previous-9999",
    "some-real-dir",
  ];
  const expected = [
    join(work, "Codex.app.tweakers-previous-4242"),
    join(work, ".next-4242"),
  ];
  const removed: string[] = [];
  const removedPaths = sweepStaleTempDirs([work], {
    readdir: () => names,
    entryMtimeMs: (path) => path.endsWith("4242") || path.endsWith("777")
      ? now - 48 * 60 * 60 * 1000
      : now - 60 * 60 * 1000,
    isProcessAlive: (pid) => pid === 777,
    removeDir: (path) => removed.push(path),
    now,
    maxAgeMs,
  });

  assert.deepEqual(removedPaths, expected);
  assert.deepEqual(removed, expected);
});

test("candidate-only sweeping cannot mutate the source app parent", () => {
  const input = {
    appRoot: "/preserved/OpenAI/ChatGPT.app",
    runtimeRoot: "/private/tmp/candidate/runtime",
    workRoot: "/private/tmp/candidate/transactions/app-install",
  };
  assert.deepEqual(installTransactionSweepDirectories({ ...input, candidateOnly: true }), [
    "/private/tmp/candidate",
    "/private/tmp/candidate/transactions/app-install",
  ]);
  assert.deepEqual(installTransactionSweepDirectories({ ...input, signingMode: "adhoc" }), [
    "/private/tmp/candidate",
    "/private/tmp/candidate/transactions/app-install",
  ]);
  assert.deepEqual(installTransactionSweepDirectories(input), [
    "/preserved/OpenAI",
    "/private/tmp/candidate",
    "/private/tmp/candidate/transactions/app-install",
  ]);
});

test("pruneParkedPatchedApps keeps only the newest parked copy", () => {
  const backup = "/backup";
  const names = [
    "Codex.app",
    "Codex.app.patched-20260101T000000",
    "Codex.app.patched-20260714T120000",
    "Codex.app.patched-20260714T153000",
    "app.asar",
  ];
  const expected = [
    join(backup, "Codex.app.patched-20260101T000000"),
    join(backup, "Codex.app.patched-20260714T120000"),
  ];
  const removed: string[] = [];

  const removedPaths = pruneParkedPatchedApps(backup, 1, {
    readdir: () => names,
    removeDir: (path) => removed.push(path),
  });

  assert.deepEqual(removedPaths, expected);
  assert.deepEqual(removed, expected);
});

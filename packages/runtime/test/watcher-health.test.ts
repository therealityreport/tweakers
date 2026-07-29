import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeLaunchdWatcherDefinition,
  analyzeScheduledTaskWatcher,
  analyzeWatcherCycleReceipt,
  analyzeWatcherLogTail,
  classifyRuntimeFingerprints,
  getWatcherHealth,
  parseLaunchdLoadedCommand,
  publishWatcherHealthSnapshot,
  readRuntimeFingerprintEvidence,
} from "../src/watcher-health";

const FIXTURE_FINGERPRINT = "8ae9a8787f4db77dd61d6c23087b8941b303d3cf2f75dcc1864a169f9604c179";

test("watcher health reports missing install state as not ready", () => {
  withTempDir((root) => {
    const health = getWatcherHealth(root);

    assert.equal(health.status, "error");
    assert.equal(health.watcher, "none");
    assert.equal(health.checks[0]?.name, "Install state");
    assert.equal(health.checks[0]?.status, "error");
  });
});

test("watcher health warns when automatic refresh is disabled", () => {
  withTempDir((root) => {
    writeFileSync(
      join(root, "state.json"),
      JSON.stringify({ version: "0.1.2", watcher: "none", appRoot: "/missing" }),
    );
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ tweaker: { autoUpdate: false } }),
    );

    const health = getWatcherHealth(root);

    assert.equal(
      health.checks.find((check) => check.name === "Automatic refresh")?.status,
      "warn",
    );
    assert.equal(
      health.checks.find((check) => check.name === "Watcher kind")?.status,
      "error",
    );
  });
});

test("Windows watcher health recognizes the current logon and interval tasks", () => {
  const tasks = new Set(["tweaker-watcher", "tweaker-watcher-interval"]);
  const checks = analyzeScheduledTaskWatcher((name) => tasks.has(name));

  assert.deepEqual(checks, [
    { name: "logon task", status: "ok", detail: "tweaker-watcher" },
    { name: "interval task", status: "ok", detail: "tweaker-watcher-interval" },
  ]);
});

test("Windows watcher health keeps documented legacy task names visible during refresh", () => {
  const tasks = new Set(["codex-plusplus-watcher", "tweaker-watcher-hourly"]);
  const checks = analyzeScheduledTaskWatcher((name) => tasks.has(name));

  assert.equal(checks[0]?.status, "warn");
  assert.match(checks[0]?.detail ?? "", /codex-plusplus-watcher.*refresh pending/i);
  assert.equal(checks[1]?.status, "warn");
  assert.match(checks[1]?.detail ?? "", /tweaker-watcher-hourly.*refresh pending/i);
});

test("Windows watcher health recognizes every documented legacy periodic task name", () => {
  for (const task of [
    "tweaker-watcher-hourly",
    "tweaker-watcher-daily",
    "codex-plusplus-watcher-interval",
    "codex-plusplus-watcher-hourly",
    "codex-plusplus-watcher-daily",
  ]) {
    const checks = analyzeScheduledTaskWatcher((name) => name === "tweaker-watcher" || name === task);
    assert.equal(checks[0]?.status, "ok");
    assert.equal(checks[1]?.status, "warn");
    assert.match(checks[1]?.detail ?? "", new RegExp(task));
  }
});

test("Windows watcher health reports missing current and legacy tasks", () => {
  const checks = analyzeScheduledTaskWatcher(() => false);

  assert.equal(checks[0]?.status, "error");
  assert.match(checks[0]?.detail ?? "", /tweaker-watcher is missing/i);
  assert.equal(checks[1]?.status, "warn");
  assert.match(checks[1]?.detail ?? "", /tweaker-watcher-interval is missing/i);
});

test("watcher log health points privileged repair failures to terminal repair", () => {
  const check = analyzeWatcherLogTail(`
✗ tweaker failed
Cannot write to /Applications/Codex.app/Contents/Info.plist.

macOS App Management or file ownership is blocking modification of /Applications/Codex.app/Contents/Info.plist.
Fix:
  Open Terminal and run: tweaker repair
`);

  assert.equal(check.name, "watcher log");
  assert.equal(check.status, "warn");
  assert.equal(check.detail, "auto-repair needs app permissions; run `tweaker repair` from Terminal");
});

test("legacy launchd definitions remain usable but report a pending refresh", () => {
  const checks = analyzeLaunchdWatcherDefinition({
    appRoot: "/Applications/ChatGPT.app",
    plist: `
      <string>com.therealityreport.tweakers.watcher</string>
      <string>CODEX_PLUSPLUS_WATCHER=1 tweaker update --watcher --quiet --no-repair; tweaker repair --watcher --quiet</string>
      <string>/Applications/ChatGPT.app/Contents/Resources/app.asar</string>
      <string>/Users/test/Library/Logs/codex-plusplus-watcher.log</string>
    `,
    plistPath: "/Users/test/Library/LaunchAgents/com.therealityreport.tweakers.watcher.plist",
    loaded: { loaded: true, running: false, lastExitCode: 0 },
  });

  assert.equal(checks.find((check) => check.name === "watcher command")?.status, "warn");
  assert.match(checks.find((check) => check.name === "watcher command")?.detail ?? "", /refresh pending/i);
  assert.equal(checks.find((check) => check.name === "launchd loaded")?.status, "ok");
});

test("a loaded idle launchd service with exit zero is healthy", () => {
  const checks = analyzeLaunchdWatcherDefinition({
    appRoot: "/Applications/ChatGPT.app",
    plist: `
      <string>com.therealityreport.tweakers.watcher</string>
      <string>TWEAKER_WATCHER=1 tweaker watcher-run</string>
      <string>/Applications/ChatGPT.app/Contents/Resources/app.asar</string>
    `,
    plistPath: "/tmp/watcher.plist",
    loaded: { loaded: true, running: false, lastExitCode: 0 },
  });

  assert.equal(checks.find((check) => check.name === "launchd loaded")?.status, "ok");
  assert.match(checks.find((check) => check.name === "launchd loaded")?.detail ?? "", /idle/i);
});

test("an idle launchd service with unknown exit status needs review", () => {
  const checks = analyzeLaunchdWatcherDefinition({
    appRoot: "/Applications/ChatGPT.app",
    plist: `
      <string>com.therealityreport.tweakers.watcher</string>
      <string>TWEAKER_WATCHER=1 tweaker watcher-run</string>
      <string>/Applications/ChatGPT.app/Contents/Resources/app.asar</string>
    `,
    plistPath: "/tmp/watcher.plist",
    loaded: { loaded: true, running: false, lastExitCode: null },
  });

  assert.equal(checks.find((check) => check.name === "launchd loaded")?.status, "warn");
  assert.match(checks.find((check) => check.name === "launchd loaded")?.detail ?? "", /unknown/i);
});

test("launchd health warns when the loaded legacy command differs from the current plist", () => {
  const loadedCommand = parseLaunchdLoadedCommand(`
    com.therealityreport.tweakers.watcher = {
      arguments = {
        /bin/sh
        -c
        CODEX_PLUSPLUS_WATCHER=1 tweaker update --watcher --quiet --no-repair; tweaker repair --watcher --quiet
      }
      LastExitStatus = 0
    }
  `);
  assert.match(loadedCommand ?? "", /CODEX_PLUSPLUS_WATCHER=1/);

  const checks = analyzeLaunchdWatcherDefinition({
    appRoot: "/Applications/ChatGPT.app",
    plist: `
      <string>com.therealityreport.tweakers.watcher</string>
      <string>TWEAKER_WATCHER=1 tweaker watcher-run</string>
      <string>/Applications/ChatGPT.app/Contents/Resources/app.asar</string>
    `,
    plistPath: "/tmp/watcher.plist",
    loaded: { loaded: true, running: false, lastExitCode: 0, command: loadedCommand },
  });

  assert.equal(checks.find((check) => check.name === "loaded watcher command")?.status, "warn");
  assert.match(checks.find((check) => check.name === "loaded watcher command")?.detail ?? "", /refresh pending/i);
});

test("the latest successful watcher receipt clears an older log failure", () => {
  const check = analyzeWatcherCycleReceipt({
    schemaVersion: 1,
    cycleId: "cycle-2",
    startedAt: "2026-07-17T00:01:00.000Z",
    completedAt: "2026-07-17T00:01:05.000Z",
    update: { status: "failed", error: "network unavailable" },
    repair: { status: "succeeded", error: null },
    outcome: "completed",
    error: null,
  });

  assert.equal(check.status, "ok");
  assert.match(check.detail, /repair completed/i);
});

test("deferred watcher repair remains pending and needs review", () => {
  const check = analyzeWatcherCycleReceipt({
    schemaVersion: 1,
    cycleId: "cycle-pending",
    startedAt: "2026-07-17T00:01:00.000Z",
    completedAt: "2026-07-17T00:01:05.000Z",
    update: { status: "succeeded", error: null },
    repair: { status: "pending", error: "runtime-drift-app-running" },
    outcome: "completed",
    error: null,
  });

  assert.equal(check.status, "warn");
  assert.match(check.detail, /repair pending/i);
  assert.match(check.detail, /runtime-drift-app-running/);
});

test("a genuine skipped watcher repair remains healthy", () => {
  const check = analyzeWatcherCycleReceipt({
    schemaVersion: 1,
    cycleId: "cycle-skipped",
    startedAt: "2026-07-17T00:01:00.000Z",
    completedAt: "2026-07-17T00:01:05.000Z",
    update: { status: "succeeded", error: null },
    repair: { status: "skipped", error: "chatgpt-mode" },
    outcome: "completed",
    error: null,
  });

  assert.equal(check.status, "ok");
  assert.match(check.detail, /repair not needed/i);
});

test("runtime fingerprint health distinguishes source, managed, and active drift", () => {
  assert.equal(classifyRuntimeFingerprints({ generated: "same", managed: "same", active: "same" }).status, "current");
  assert.equal(classifyRuntimeFingerprints({ generated: "new", managed: "old", active: "old" }).status, "managed-pending");
  assert.equal(classifyRuntimeFingerprints({ generated: "new", managed: "new", active: "old" }).status, "runtime-pending");
  assert.equal(classifyRuntimeFingerprints({ generated: null, managed: "new", active: "old" }).status, "unknown");
});

test("runtime fingerprint evidence includes the verified digest and file count", () => {
  withTempDir((root) => {
    const runtime = join(root, "runtime");
    writeValidRuntime(runtime);

    assert.deepEqual(readRuntimeFingerprintEvidence(runtime), {
      fingerprint: FIXTURE_FINGERPRINT,
      fileCount: 1,
    });

    writeFileSync(join(runtime, "main.js"), "tampered\n");
    assert.equal(readRuntimeFingerprintEvidence(runtime), null);
  });
});

test("watcher runtime health verifies generated, managed, and active bytes before comparison", () => {
  withTempDir((root) => {
    const sourceRoot = join(root, "source");
    const generated = join(sourceRoot, "packages", "installer", "assets", "runtime");
    const managed = join(root, "managed-runtime", "current", "packages", "installer", "assets", "runtime");
    const active = join(root, "runtime");
    for (const runtimeRoot of [generated, managed, active]) writeValidRuntime(runtimeRoot);
    writeFileSync(join(root, "state.json"), JSON.stringify({
      version: "1.0.0",
      watcher: "none",
      appRoot: "/missing",
      sourceRoot,
    }));

    assert.equal(runtimeAssetStatus(root), "current");

    writeFileSync(join(active, "main.js"), "tampered\n");
    assert.equal(runtimeAssetStatus(root), "runtime-pending");
    writeValidRuntime(active);

    writeFileSync(join(managed, "main.js"), "tampered\n");
    assert.equal(runtimeAssetStatus(root), "managed-pending");
    writeValidRuntime(managed);

    writeFileSync(join(generated, "main.js"), "tampered\n");
    assert.equal(runtimeAssetStatus(root), "unknown");
    writeValidRuntime(generated);

    unlinkSync(join(active, "main.js"));
    assert.equal(runtimeAssetStatus(root), "runtime-pending");
  });
});

test("watcher health prefers a completed cycle receipt over sticky historical log text", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "state.json"), JSON.stringify({ version: "1.0.0", watcher: "none", appRoot: "/missing" }));
    writeFileSync(join(root, "auto-repair-state.json"), JSON.stringify({
      schemaVersion: 1,
      latestCompletedCycle: {
        schemaVersion: 1,
        cycleId: "cycle-ok",
        startedAt: "2026-07-17T00:00:00.000Z",
        completedAt: "2026-07-17T00:00:01.000Z",
        update: { status: "succeeded", error: null },
        repair: { status: "succeeded", error: null },
        outcome: "completed",
        error: null,
      },
    }));

    const health = getWatcherHealth(root);
    assert.equal(health.checks.find((check) => check.name === "watcher cycle")?.status, "ok");
  });
});

test("watcher registry probes are hermetic through injected home and launchd seams", () => {
  withTempDir((root) => {
    const home = join(root, "home");
    const launchAgents = join(home, "Library", "LaunchAgents");
    const lifecycle = join(home, ".codex", "tmp");
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(lifecycle, { recursive: true });
    for (const label of [
      "com.therealityreport.tweakers.watcher",
      "com.thomashulihan.codex-mcp-idle-reaper",
      "com.thomashulihan.codex-mcp-guard",
    ]) {
      writeFileSync(join(launchAgents, `${label}.plist`), label);
    }
    const generatedAt = Date.now() / 1_000;
    writeFileSync(join(lifecycle, "codex-mcp-lifecycle-status.json"), JSON.stringify({
      schema_version: 2,
      generated_at: generatedAt,
      cleanup_policy_version: "strict-detached-v3",
      job: { ok: true },
    }));
    writeFileSync(join(lifecycle, "codex-mcp-guard-status.json"), JSON.stringify({
      schema_version: 1,
      generated_at: generatedAt,
      policy_version: "notification-only-v1",
      job: { ok: true },
    }));

    const seenLabels: string[] = [];
    const health = getWatcherHealth(root, {
      homeDirectory: home,
      platformKind: "darwin",
      launchdState(label) {
        seenLabels.push(label);
        return { loaded: true, running: false, lastExitCode: 0 };
      },
    });
    const reaper = health.watchers.find((watcher) => watcher.id === "mcp-lifecycle-reaper");
    const guard = health.watchers.find((watcher) => watcher.id === "mcp-pressure-guard");

    assert.equal(reaper?.status, "ok");
    assert.equal(reaper?.statusSchemaVersion, 2);
    assert.equal(guard?.status, "ok");
    assert.equal(guard?.authority, "notification-only");
    assert.deepEqual(seenLabels.sort(), [
      "com.therealityreport.tweakers.watcher",
      "com.thomashulihan.codex-mcp-guard",
      "com.thomashulihan.codex-mcp-idle-reaper",
    ]);
  });
});

test("watcher status documents require a supported schema, timestamp, and boolean job result", () => {
  withTempDir((root) => {
    const home = join(root, "home");
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    for (const label of [
      "com.therealityreport.tweakers.watcher",
      "com.thomashulihan.codex-mcp-idle-reaper",
      "com.thomashulihan.codex-mcp-guard",
    ]) {
      writeFileSync(join(launchAgents, `${label}.plist`), label);
    }
    const generatedAt = Date.now() / 1_000;
    const invalidDocuments = [
      [{ schema_version: 2, job: { ok: true } }, /timestamp missing or invalid/i],
      [{ schema_version: 2, generated_at: Number.MAX_VALUE, job: { ok: true } }, /timestamp missing or invalid/i],
      [{ schema_version: 2, generated_at: generatedAt, job: null }, /job missing or invalid/i],
      [{ generated_at: generatedAt, job: { ok: true } }, /schema missing or invalid/i],
    ] as const;
    for (const [reaperDocument, expectedError] of invalidDocuments) {
      const health = getWatcherHealth(root, {
        homeDirectory: home,
        platformKind: "darwin",
        launchdState: () => ({ loaded: true, running: false, lastExitCode: 0 }),
        readJsonDocument(path) {
          return path.endsWith("codex-mcp-lifecycle-status.json")
            ? reaperDocument
            : { schema_version: 1, generated_at: generatedAt, job: { ok: true } };
        },
      });
      const reaper = health.watchers.find((watcher) => watcher.id === "mcp-lifecycle-reaper");
      assert.equal(reaper?.status, "error");
      assert.match(reaper?.error ?? "", expectedError);
    }
  });
});

test("watcher health publication is atomic, redacted, and preserves last-known-good", () => {
  withTempDir((root) => {
    const home = join(root, "home");
    const userRoot = join(home, "Library", "Application Support", "codex-plusplus");
    const launchAgents = join(home, "Library", "LaunchAgents");
    const lifecycle = join(home, ".codex", "tmp");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(lifecycle, { recursive: true });
    for (const label of [
      "com.therealityreport.tweakers.watcher",
      "com.thomashulihan.codex-mcp-idle-reaper",
      "com.thomashulihan.codex-mcp-guard",
    ]) {
      writeFileSync(join(launchAgents, `${label}.plist`), label);
    }
    const generatedAt = Date.now() / 1_000;
    const completedAt = new Date(generatedAt * 1_000).toISOString();
    writeFileSync(join(userRoot, "state.json"), JSON.stringify({
      version: "1.0.0",
      watcher: "launchd",
      appRoot: "/missing",
    }));
    writeFileSync(join(userRoot, "auto-repair-state.json"), JSON.stringify({
      schemaVersion: 1,
      latestCompletedCycle: {
        schemaVersion: 1,
        cycleId: "cycle-ok",
        startedAt: completedAt,
        completedAt,
        update: { status: "succeeded", error: null },
        repair: { status: "succeeded", error: null },
        outcome: "completed",
        error: null,
      },
    }));
    writeFileSync(join(lifecycle, "codex-mcp-lifecycle-status.json"), JSON.stringify({
      schema_version: 2,
      generated_at: generatedAt,
      cleanup_policy_version: "strict-detached-v3",
      job: { ok: true },
    }));
    writeFileSync(join(lifecycle, "codex-mcp-guard-status.json"), JSON.stringify({
      schema_version: 1,
      generated_at: generatedAt,
      policy_version: "notification-only-v1",
      job: { ok: true },
    }));

    const health = getWatcherHealth(userRoot, {
      homeDirectory: home,
      platformKind: "darwin",
      launchdState: () => ({ loaded: true, running: false, lastExitCode: 0 }),
    });
    assert.equal(health.watchers.every((watcher) => watcher.status === "ok"), true);
    const published = publishWatcherHealthSnapshot(userRoot, health);
    assert.equal(published.schema, "tweakers.health.v1");
    assert.equal(published.watchers[0]?.installedPath.startsWith("~/"), true);

    const currentPath = join(userRoot, "watcher-health.json");
    const lastKnownGoodPath = join(userRoot, "watcher-health.last-known-good.json");
    const originalLastKnownGood = readFileSync(lastKnownGoodPath, "utf8");
    assert.equal(statSync(currentPath).mode & 0o777, 0o600);
    assert.equal(statSync(lastKnownGoodPath).mode & 0o777, 0o600);

    writeFileSync(join(userRoot, "auto-repair-state.json"), JSON.stringify({
      schemaVersion: 1,
      latestCompletedCycle: {
        schemaVersion: 1,
        cycleId: "cycle-failed",
        startedAt: completedAt,
        completedAt,
        update: { status: "succeeded", error: null },
        repair: { status: "failed", error: "/Users/another-user/private --token=hidden" },
        outcome: "failed",
        error: null,
      },
    }));
    const failedRepairHealth = getWatcherHealth(userRoot, {
      homeDirectory: home,
      platformKind: "darwin",
      launchdState: () => ({ loaded: true, running: false, lastExitCode: 0 }),
    });
    const failedRepair = failedRepairHealth.watchers.find((watcher) => watcher.id === "tweakers-repair");
    assert.equal(failedRepair?.status, "error");
    assert.match(failedRepair?.error ?? "", /repair failed|hidden/i);
    publishWatcherHealthSnapshot(userRoot, failedRepairHealth);
    assert.equal(readFileSync(lastKnownGoodPath, "utf8"), originalLastKnownGood);

    publishWatcherHealthSnapshot(userRoot, {
      ...health,
      checkedAt: new Date(Date.now() + 1_000).toISOString(),
      watchers: health.watchers.map((watcher, index) => index === 0
        ? {
            ...watcher,
            status: "error",
            error: `/Users/another-user/private --token sk-proj-supersecret`,
            policyVersion: `${home}/policy Bearer secret ${"x".repeat(600)}`,
          }
        : watcher),
    });
    const current = readFileSync(currentPath, "utf8");
    assert.match(current, /"status": "error"/);
    assert.doesNotMatch(current, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(current, /\/Users\/another-user/);
    assert.doesNotMatch(current, /supersecret/);
    assert.doesNotMatch(current, /Bearer secret/);
    assert.doesNotMatch(current, new RegExp("x".repeat(513)));
    assert.equal(readFileSync(lastKnownGoodPath, "utf8"), originalLastKnownGood);
  });
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweaker-watcher-health-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeValidRuntime(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "main.js"), "console.log(\"ok\");\n");
  writeFileSync(join(root, "runtime-fingerprint.json"), JSON.stringify({
    schemaVersion: 1,
    fingerprint: FIXTURE_FINGERPRINT,
    fileCount: 1,
  }));
}

function runtimeAssetStatus(root: string): string | undefined {
  return getWatcherHealth(root).checks.find((check) => check.name === "Runtime assets")?.detail;
}

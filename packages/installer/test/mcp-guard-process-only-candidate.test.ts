import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  installMcpLifecyclePackage,
  readMcpLifecycleManifest,
  type McpLifecycleCommandRunner,
} from "../src/mcp-lifecycle-install";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const bundledRoot = join(repoRoot, "packages", "installer", "assets", "mcp-lifecycle");
const NO_PLIST_LINT: McpLifecycleCommandRunner = {
  run: () => ({ available: false, status: null, stdout: "", stderr: "" }),
};

test("bundled Guard candidate installs process-only bytes and passes the no-task-data audit", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mcp-guard-candidate-"));
  try {
    const home = join(root, "target-home");
    const transactionRoot = join(home, "transaction");
    const result = installMcpLifecyclePackage({
      sourceRoot: bundledRoot,
      targetHome: home,
      temporaryRoot: transactionRoot,
      commands: NO_PLIST_LINT,
      labelInstances: () => 0,
    });

    assert.equal(result.status, "installed");
    const installedGuard = join(home, ".codex", "bin", "codex-mcp-guard.py");
    assert.equal(existsSync(installedGuard), true);
    const manifest = readMcpLifecycleManifest(bundledRoot);
    const guard = manifest.assets.find((asset) => asset.id === "guard");
    const lifecycleModule = manifest.assets.find((asset) => asset.id === "lifecycle-module");
    assert.ok(guard);
    assert.ok(lifecycleModule);
    assert.equal(createHash("sha256").update(readFileSync(installedGuard)).digest("hex"), guard.source_sha256);
    const installedLifecycleModule = join(home, ".codex", "lib", "codex_mcp_lifecycle.py");
    assert.equal(existsSync(installedLifecycleModule), true);
    assert.equal(
      createHash("sha256").update(readFileSync(installedLifecycleModule)).digest("hex"),
      lifecycleModule.source_sha256,
    );
    assert.match(readFileSync(installedLifecycleModule, "utf8"), /^PRODUCER_VERSION = "0\.6\.0"$/m);

    const installedPlist = readFileSync(
      join(home, "Library", "LaunchAgents", "com.thomashulihan.codex-mcp-guard.plist"),
      "utf8",
    );
    assert.match(installedPlist, /<string>--scope<\/string>\s*<string>process-only<\/string>\s*<string>--quiet<\/string>/);
    assert.match(installedPlist, /<key>CODEX_MCP_LIFECYCLE_STATE_DIR<\/key>\s*<string>[^<]+\/.codex\/tmp<\/string>/);
    assert.doesNotMatch(installedPlist, /CODEX_GUARD_[A-Z_]*WARN|COMPUTER_USE_WARN/);

    const processFixture = join(root, "process.json");
    const lifecycleFixture = join(root, "lifecycle.json");
    writeFileSync(processFixture, JSON.stringify({ processes: [] }));
    writeFileSync(lifecycleFixture, JSON.stringify({
      schema_version: 2,
      matcher_registry_version: "mcp-family-descriptors-v6",
      generated_at: 1_000,
      job: { ok: true, mode: "status", error: null },
      counts: {},
      trees: [],
    }));
    const audit = spawnSync("python3", [
      "-B",
      join(bundledRoot, "scripts", "audit_guard_file_access.py"),
      "--candidate", installedGuard,
      "--state-dir", join(home, ".codex", "tmp"),
      "--process-fixture", processFixture,
      "--lifecycle-fixture", lifecycleFixture,
      "--now", "1000",
    ], { encoding: "utf8" });
    assert.equal(audit.status, 0, `${audit.stdout}\n${audit.stderr}`);
    const report = JSON.parse(audit.stdout) as Record<string, unknown>;
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.signals, []);
    assert.deepEqual(report.subprocesses, []);
    assert.deepEqual(report.candidate, {
      schemaVersion: 3,
      taskDataAccess: "none",
      mutationCapabilities: [],
      matcher: {
        expected: "mcp-family-descriptors-v6",
        observed: "mcp-family-descriptors-v6",
        freshness: "fresh",
      },
      producerVersion: "0.6.0",
      state: "healthy",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

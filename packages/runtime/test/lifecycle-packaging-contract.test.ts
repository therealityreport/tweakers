import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import {
  TWEAK_LIFECYCLE_STATUSES,
  createTweakLifecycleJournal,
  recoverInterruptedTweaks,
  runWithStartupTimeout,
} from "../src/tweak-lifecycle";
import { normalizeStoreRegistry, resolveBundledTweakPath } from "../src/tweak-store";

const root = resolve(process.cwd());

test("lifecycle helper exposes all six runtime states and quarantines interrupted starts", () => {
  assert.deepEqual(TWEAK_LIFECYCLE_STATUSES, [
    "starting",
    "ready",
    "failed",
    "timed_out",
    "disabled",
    "quarantined",
  ]);
  // A first interruption is retryable (a whole-app restart racing the load
  // loop is not the tweak's fault); repeated interruptions quarantine.
  const journal = createTweakLifecycleJournal("attempt-1", 123);
  journal.records["renderer:broken"] = {
    id: "broken",
    process: "renderer",
    status: "starting",
    attemptId: "attempt-1",
    updatedAt: "now",
  };
  const recovered = recoverInterruptedTweaks(journal, "later");
  assert.equal(recovered.records["renderer:broken"]?.status, "failed");
  assert.equal(recovered.records["renderer:broken"]?.interruptedAttempts, 1);
  assert.equal(recovered.currentAttempt?.completedAt, "later");

  const again = createTweakLifecycleJournal("attempt-2", 124);
  again.records["renderer:broken"] = {
    id: "broken",
    process: "renderer",
    status: "starting",
    attemptId: "attempt-2",
    updatedAt: "now",
    interruptedAttempts: 1,
  };
  const quarantined = recoverInterruptedTweaks(again, "later");
  assert.equal(quarantined.records["renderer:broken"]?.status, "quarantined");
  assert.equal(quarantined.records["renderer:broken"]?.interruptedAttempts, 2);
});

test("startup timeout is bounded and allows the caller to continue", async () => {
  const result = await runWithStartupTimeout(() => new Promise<void>(() => {}), 100);
  assert.equal(result.status, "timed_out");
});

test("catalog entries point to exact bundled source folders", () => {
  const catalog = JSON.parse(readFileSync(resolve(root, "store/index.json"), "utf8"));
  const registry = normalizeStoreRegistry(catalog);
  assert.equal(registry.entries.length, 12);
  for (const entry of registry.entries) {
    assert.equal(entry.source?.kind, "bundled");
    assert.equal(entry.source?.kind === "bundled" && entry.source.path.startsWith("tweaks/"), true);
    const source = resolveBundledTweakPath(root, entry);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(resolve(source, "manifest.json")), true);
    assert.equal(existsSync(resolve(source, "index.js")), true);
  }
});

test("installer assets contain the same twelve canonical tweak folders", () => {
  const catalog = JSON.parse(readFileSync(resolve(root, "store/index.json"), "utf8"));
  const packagedRoot = resolve(root, "packages/installer/assets/runtime/tweaks");
  const sourceIds = catalog.entries.map((entry: { source: { path: string } }) => entry.source.path.split("/").at(-1)).sort();
  const packagedIds = readdirSync(packagedRoot).filter((id) => statSync(resolve(packagedRoot, id)).isDirectory()).sort();
  assert.equal(sourceIds.length, 12);
  assert.deepEqual(packagedIds, sourceIds);
});

test("installer assets contain the MCP reconciler and a generated runtime fingerprint", () => {
  const packagedRoot = resolve(root, "packages/installer/assets/runtime");
  assert.equal(existsSync(resolve(packagedRoot, "mcp-reconciliation.js")), true);

  const fingerprint = JSON.parse(
    readFileSync(resolve(packagedRoot, "runtime-fingerprint.json"), "utf8"),
  ) as { schemaVersion?: unknown; fingerprint?: unknown; fileCount?: unknown };
  assert.equal(fingerprint.schemaVersion, 1);
  assert.match(String(fingerprint.fingerprint), /^[0-9a-f]{64}$/);
  assert.equal(Number.isInteger(fingerprint.fileCount) && Number(fingerprint.fileCount) > 0, true);
  assert.deepEqual(runtimeFingerprint(packagedRoot), {
    fingerprint: fingerprint.fingerprint,
    fileCount: fingerprint.fileCount,
  });

  const main = readFileSync(resolve(packagedRoot, "main.js"), "utf8");
  assert.match(main, /createMcpReconciler/);
  assert.match(main, /tweaker:get-mcp-sync-state/);
  assert.match(main, /tweaker:repair-mcp/);
  assert.doesNotMatch(main, /syncManagedMcpServers\(\{\s*configPath:/);
});

function runtimeFingerprint(runtimeRoot: string): { fingerprint: string; fileCount: number } {
  const hash = createHash("sha256");
  let fileCount = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(runtimeRoot, path);
      if (name === "runtime-fingerprint.json") continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        fileCount += 1;
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(runtimeRoot);
  return { fingerprint: hash.digest("hex"), fileCount };
}

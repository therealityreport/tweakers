import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageCodexManagedMcpPackages } from "../src/managed-mcp-packages.ts";
import {
  assertManagedMcpPreparedRuntimeEvidence,
  prepareManagedMcpLifecycleRuntime,
} from "../src/managed-mcp-lifecycle.ts";

/**
 * Validates the machine-local authored managed MCP release inputs (produced by
 * scripts/author-managed-mcp-release.mjs) with the real release verifiers.
 * Skips cleanly when the authored artifacts are not present on this machine.
 */
const authoredRoot = process.env.TWEAKERS_AUTHORED_MCP_ROOT
  ?? join(homedir(), "Library", "Application Support", "codex-plusplus", "managed-mcp-release");
const chromePluginRoot = join(authoredRoot, "chrome-devtools");
const playwrightPluginRoot = join(authoredRoot, "playwright");
const manifestFile = join(authoredRoot, "fleet", "managed-mcp-fleet.v1.json");
const authored = existsSync(join(chromePluginRoot, "release", "chrome-devtools-mcp.lock.json"))
  && existsSync(join(playwrightPluginRoot, "release", "playwright-mcp.lock.json"))
  && existsSync(manifestFile);

test("authored release roots stage through the real managed MCP package verifier", { skip: !authored }, () => {
  const scratch = mkdtempSync(join(authoredRoot, "validation", "test-"));
  try {
    const evidence = stageCodexManagedMcpPackages({
      chromePluginRoot,
      playwrightPluginRoot,
      managedMcpRoot: join(scratch, "managed-mcp"),
    });
    assert.equal(evidence.schemaVersion, 1);
    const names = evidence.packages.map((value) => value.name).sort();
    assert.deepEqual(names, ["@playwright/mcp", "chrome-devtools-mcp"]);
    assert.equal(evidence.packages.every((value) => value.integrity.startsWith("sha512-")), true);
    assert.equal(evidence.packages.every((value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)), true);
    assert.equal(JSON.stringify(evidence).includes("npx"), false);
    assert.equal(JSON.stringify(evidence).includes("@latest"), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("authored fleet manifest passes the real lifecycle preparation validator", { skip: !authored }, () => {
  const scratch = mkdtempSync(join(authoredRoot, "validation", "test-fleet-"));
  try {
    const prepared = prepareManagedMcpLifecycleRuntime({
      manifestFile,
      runtimeRoot: join(scratch, "managed-runtime"),
    });
    assertManagedMcpPreparedRuntimeEvidence(prepared);
    assert.equal(prepared.requiredCoverage.length, 20);
    assert.equal(prepared.catalogs.length >= 20, true);
    assert.equal(prepared.configReconciliation.feature.key, "mcp_on_demand");
    assert.equal(prepared.configReconciliation.mutatesConfigDuringPreparation, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

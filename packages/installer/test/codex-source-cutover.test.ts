import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertInstalledManagedMcpStatus,
  reconcileCodexSourceLiveConfig,
} from "../src/codex-source-cutover.ts";
import type {
  ManagedMcpConfigReconciliationPlan,
  ManagedMcpLifecycleOverlay,
} from "../src/managed-mcp-lifecycle.ts";

test("approved config reconciliation archives both shadow routes and preserves unrelated capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-source-config-cutover-"));
  const file = join(root, "config.toml");
  try {
    writeFileSync(file, [
      "model = \"gpt-5\"",
      "",
      "[features]",
      "plugins = true",
      "mcp_on_demand = false",
      "",
      "[mcp_servers.chrome-devtools]",
      "command = \"npx\"",
      "",
      "[mcp_servers.computer-use]",
      "enabled = false",
      "command = \"old-computer-use\"",
      "",
      "[mcp_servers.computer-use.env]",
      "TOKEN = \"preserved-only-in-snapshot\"",
      "",
      "[mcp_servers.playwright]",
      "command = \"npx\"",
      "args = [\"@latest\"]",
      "",
      "[mcp_servers.unrelated]",
      "url = \"https://example.test/mcp\"",
      "",
    ].join("\n"));
    reconcileCodexSourceLiveConfig(file, plan());
    const text = readFileSync(file, "utf8");
    assert.match(text, /\[features\][\s\S]*mcp_on_demand = true/);
    assert.doesNotMatch(text, /mcp_servers\.chrome-devtools/);
    assert.doesNotMatch(text, /mcp_servers\.computer-use/);
    assert.doesNotMatch(text, /@latest|command = "npx"/);
    assert.match(text, /\[mcp_servers\.unrelated\][\s\S]*https:\/\/example\.test\/mcp/);
    assert.match(text, /\[mcp_servers\."playwright"\][\s\S]*\/managed\/playwright/);
    assert.match(text, /\[mcp_servers\."headroom"\]/);
    assert.match(text, /\[mcp_servers\."node_repl"\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed verifier consumes exact CLI snake_case and exact receipt route identities", () => {
  const overlay: ManagedMcpLifecycleOverlay = {
    schemaVersion: 1,
    fleetFingerprint: `sha256:${"f".repeat(64)}`,
    entries: [
      {
        owner: "config",
        server: "headroom",
        declarationFingerprint: `sha256:${"1".repeat(64)}`,
        lifecycle: "call",
        idleLeaseSec: 0,
        catalog: { path: "/managed/headroom.json", sha256: `sha256:${"a".repeat(64)}` },
        required: true,
      },
      {
        owner: "plugin:chrome-devtools@1.0.0",
        server: "chrome-devtools",
        declarationFingerprint: `sha256:${"2".repeat(64)}`,
        lifecycle: "task",
        idleLeaseSec: 300,
        catalog: { path: "/managed/chrome.json", sha256: `sha256:${"b".repeat(64)}` },
        required: true,
      },
    ],
  };
  const rows = overlay.entries.map((entry) => ({
    name: entry.server,
    owner: entry.owner,
    lifecycle: entry.lifecycle === "call" ? "on_demand_call" : "on_demand_task",
    lifecycle_state: "dormant",
    catalog_digest: entry.catalog.sha256,
    reason: null,
    enabled: true,
    transport: { type: "stdio", command: "/managed/route" },
  }));
  assert.doesNotThrow(() => assertInstalledManagedMcpStatus(rows, overlay));
  assert.throws(
    () => assertInstalledManagedMcpStatus(rows.map(({ lifecycle_state, catalog_digest, ...row }) => ({
      ...row,
      lifecycleState: lifecycle_state,
      catalogDigest: catalog_digest,
    })), overlay),
    /exact dormant on-demand CLI evidence/,
  );
  assert.throws(
    () => assertInstalledManagedMcpStatus(rows.map((row, index) => index === 0
      ? { ...row, owner: "config-drift" }
      : row), overlay),
    /route identity drift/,
  );
  assert.throws(
    () => assertInstalledManagedMcpStatus([...rows, { ...rows[0], name: "unexpected" }], overlay),
    /route set differs/,
  );
});

function plan(): ManagedMcpConfigReconciliationPlan {
  const declaration = (command: string) => ({
    source: { kind: "config" as const, name: "config.toml" },
    environmentId: "local",
    command,
    args: [],
    cwd: null,
    explicitEnv: {},
    inheritedEnvPolicy: [],
    inheritedEnv: [],
  });
  return {
    schemaVersion: 1,
    feature: { table: "features", key: "mcp_on_demand", value: true },
    routes: [
      { owner: "config", server: "chrome-devtools", action: "archive-shadow", replacementOwner: "plugin:chrome-devtools@1.0.0", effectiveDeclaration: null, applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "computer-use", action: "archive-shadow", replacementOwner: "plugin:computer-use@1.0.0", effectiveDeclaration: null, applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "playwright", action: "replace-floating", replacementOwner: null, effectiveDeclaration: declaration("/managed/playwright"), applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "headroom", action: "retain-attested", replacementOwner: null, effectiveDeclaration: declaration("/managed/headroom"), applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "node_repl", action: "retain-attested", replacementOwner: null, effectiveDeclaration: declaration("/managed/node-repl"), applyOnlyDuringApprovedCutover: true },
    ],
    applyOnlyDuringApprovedCutover: true,
    mutatesConfigDuringPreparation: false,
  };
}

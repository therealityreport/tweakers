import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintPromotionCodexConfigPath } from "../src/promotion-policy.ts";

// Shared with packages/runtime/test/promotion-codex-config.test.ts. The golden
// digest binds the installer and runtime twins to one implementation: if either
// side's canonicalization drifts, its golden assertion fails.
const FIXTURE = [
  "[mcp_servers.example]",
  'command = "/usr/local/bin/example"',
  "enabled = false",
  "",
  "[marketplaces.openai-bundled]",
  'last_updated = "2026-08-09T00:49:47Z"',
  'source_type = "local"',
  "",
].join("\n");

const GOLDEN = "0d443c74dde121a702f6d093db2d85a98ab3a7d604b5a716531ec726e6263ef8";

test("codex config fingerprint ignores boot-stamped last_updated churn", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-config-fingerprint-"));
  try {
    const file = join(root, "config.toml");
    writeFileSync(file, FIXTURE);
    const before = fingerprintPromotionCodexConfigPath(file);
    assert.equal(before, GOLDEN);
    writeFileSync(file, FIXTURE.replace("2026-08-09T00:49:47Z", "2026-08-09T01:30:49Z"));
    assert.equal(fingerprintPromotionCodexConfigPath(file), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex config fingerprint still changes when a substantive key changes", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-config-fingerprint-"));
  try {
    const file = join(root, "config.toml");
    writeFileSync(file, FIXTURE);
    const before = fingerprintPromotionCodexConfigPath(file);
    writeFileSync(file, FIXTURE.replace("enabled = false", "enabled = true"));
    assert.notEqual(fingerprintPromotionCodexConfigPath(file), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex config fingerprint reports missing files as missing", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-config-fingerprint-"));
  try {
    assert.equal(fingerprintPromotionCodexConfigPath(join(root, "config.toml")), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preflightRouterHomes, sanitizedChildEnvironment } from "../../src/account-router/app-server-mux";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;
const config: RouterConfig = {
  schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
  accounts: [
    { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
    { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
  ], updatedAt: "2026-08-19T12:00:00Z",
};

test("preflight fails closed for missing isolated homes and does not create an account tree", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-preflight-"));
  assert.equal(preflightRouterHomes(config, root), false);
  assert.equal(require("node:fs").existsSync(join(root, "accounts")), false);
});

test("account children inherit only operational environment values", () => {
  const env = sanitizedChildEnvironment("/private/a", "/private/sqlite", {
    PATH: "/usr/bin", LANG: "en_US.UTF-8", OPENAI_API_KEY: "not-forwarded", COOKIE: "not-forwarded", NODE_OPTIONS: "not-forwarded", CODEX_HOME: "/global",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", LANG: "en_US.UTF-8", CODEX_HOME: "/private/a", CODEX_SQLITE_HOME: "/private/sqlite" });
});

test("preflight refuses a staged disable or unresolved durable correlation", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-state-preflight-"));
  for (const account of [accountA, accountB]) {
    mkdirSync(join(root, "accounts", account, "codex-home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "accounts", account, "sqlite-home"), { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 1), { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  writeFileSync(join(root, "router-state.json"), JSON.stringify({ stagedDisable: { reasonCode: "protocol_drift" }, correlations: [], pendingThreadOwners: {} }), { mode: 0o600 });
  chmodSync(join(root, "router-state.json"), 0o600);
  assert.equal(preflightRouterHomes(config, root), false);
});

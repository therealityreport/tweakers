import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMuxCliShutdown, preflightRouterHomes, sanitizedChildEnvironment } from "../../src/account-router/app-server-mux";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { createInitialRouterState } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig, type RouterConfigV2 } from "../../src/account-router/types";
import { publishHistoryAdoptionEvidence } from "./history-adoption-fixtures";

const accountA = `ar_${"A".repeat(43)}` as const;
const accountB = `ar_${"B".repeat(43)}` as const;
const config: RouterConfig = {
  schemaVersion: 1, mode: "balanced", protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
  accounts: [
    { opaqueAccountId: accountA, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` },
    { opaqueAccountId: accountB, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}` },
  ], updatedAt: "2026-08-19T12:00:00Z",
};

function opaque(secret: Buffer, raw: string): `ar_${string}` {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`, "utf8").digest("base64url")}`;
}

function stagedIdentityHomes(root: string, secret: Buffer): RouterConfigV2 {
  const accounts = [
    { opaqueAccountId: opaque(secret, "account-a"), raw: "account-a" },
    { opaqueAccountId: opaque(secret, "account-b"), raw: "account-b" },
  ];
  for (const account of accounts) {
    const home = join(root, "accounts", account.opaqueAccountId, "codex-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "accounts", account.opaqueAccountId, "sqlite-home"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account.raw, refresh_token: "test-only" } }), { mode: 0o600 });
    chmodSync(join(home, "auth.json"), 0o600);
    writeFileSync(join(home, "config.toml"), "", { mode: 0o600 });
    chmodSync(join(home, "config.toml"), 0o600);
  }
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2, mode: "quota_aware", policy: "quota_aware_v1", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accounts[0].opaqueAccountId,
    accounts: [
      { opaqueAccountId: accounts[0].opaqueAccountId, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}`, label: "Account 1" },
      { opaqueAccountId: accounts[1].opaqueAccountId, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Account 2" },
    ], updatedAt: "2026-08-31T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

test("preflight fails closed for missing isolated homes and does not create an account tree", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-preflight-"));
  assert.equal(preflightRouterHomes(config, root), false);
  assert.equal(require("node:fs").existsSync(join(root, "accounts")), false);
});

test("preflight binds each private auth identity and empty child config to its exact configured home", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-auth-preflight-"));
  const secret = Buffer.alloc(32, 9);
  writeFileSync(join(root, "control-secret.v1"), secret, { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const candidate = stagedIdentityHomes(root, secret);
  publishHistoryAdoptionEvidence({ root, config: candidate, secret });
  assert.equal(preflightRouterHomes(candidate, root), true);
  const [first, second] = candidate.accounts;
  const firstAuth = join(root, "accounts", first.opaqueAccountId, "codex-home", "auth.json");
  const secondAuth = join(root, "accounts", second.opaqueAccountId, "codex-home", "auth.json");
  const firstConfig = join(root, "accounts", first.opaqueAccountId, "codex-home", "config.toml");
  const savedFirst = readFileSync(firstAuth);
  const savedSecond = readFileSync(secondAuth);

  writeFileSync(firstAuth, savedSecond, { mode: 0o600 });
  assert.equal(preflightRouterHomes(candidate, root), false, "swapped exact auth snapshots cannot select the mux");
  writeFileSync(firstAuth, savedFirst, { mode: 0o600 }); chmodSync(firstAuth, 0o600);
  chmodSync(firstAuth, 0o644);
  assert.equal(preflightRouterHomes(candidate, root), false, "a permissive auth file is not owner-private");
  chmodSync(firstAuth, 0o600);
  unlinkSync(firstAuth);
  symlinkSync(secondAuth, firstAuth);
  assert.equal(preflightRouterHomes(candidate, root), false, "auth symlinks are never followed");
  unlinkSync(firstAuth);
  writeFileSync(firstAuth, savedFirst, { mode: 0o600 }); chmodSync(firstAuth, 0o600);
  writeFileSync(firstConfig, "model = 'untrusted'", { mode: 0o600 });
  assert.equal(preflightRouterHomes(candidate, root), false, "post-stage custom child config falls back direct");
  writeFileSync(firstConfig, "", { mode: 0o600 }); chmodSync(firstConfig, 0o600);
  writeFileSync(firstAuth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "wrong-account", refresh_token: "test-only" } }), { mode: 0o600 });
  assert.equal(preflightRouterHomes(candidate, root), false, "mismatched HMAC identity falls back direct");
});

test("account children inherit only operational environment values", () => {
  const env = sanitizedChildEnvironment("/private/a", "/private/sqlite", {
    PATH: "/usr/bin", LANG: "en_US.UTF-8", OPENAI_API_KEY: "not-forwarded", COOKIE: "not-forwarded", NODE_OPTIONS: "not-forwarded", CODEX_HOME: "/global",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", LANG: "en_US.UTF-8", CODEX_HOME: "/private/a", CODEX_SQLITE_HOME: "/private/sqlite" });
});

test("EOF and signals share one idempotent mux cleanup without recursively closing input", () => {
  let muxStops = 0;
  let controls = 0;
  let pauses = 0;
  let forceSchedules = 0;
  const shutdown = createMuxCliShutdown(
    { shutdown: () => { muxStops += 1; } },
    () => { controls += 1; },
    () => { pauses += 1; },
    () => { forceSchedules += 1; },
  );
  shutdown(); // stdin/readline EOF
  shutdown(); // then SIGTERM must be a no-op
  assert.deepEqual({ muxStops, controls, pauses, forceSchedules }, { muxStops: 1, controls: 1, pauses: 1, forceSchedules: 1 });
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

test("preflight preserves direct fallback when a legacy router state is incompatible with a v2 candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-v2-state-preflight-"));
  for (const account of [accountA, accountB]) {
    mkdirSync(join(root, "accounts", account, "codex-home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "accounts", account, "sqlite-home"), { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(root, "control-secret.v1"), Buffer.alloc(32, 1), { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const legacy: RouterConfig = { ...config, accounts: [
    { ...config.accounts[0], weight: 2 },
    { ...config.accounts[1], weight: 3 },
  ] };
  writeFileSync(join(root, "router-state.json"), JSON.stringify(createInitialRouterState(legacy)), { mode: 0o600 });
  chmodSync(join(root, "router-state.json"), 0o600);
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2, mode: "quota_aware", policy: "quota_aware_v1", generation: 1,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: accountA,
    accounts: [
      { ...config.accounts[0], label: "Account 1" },
      { ...config.accounts[1], label: "Account 2" },
    ], updatedAt: "2026-08-31T12:00:00.000Z",
  };
  const candidate: RouterConfigV2 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  assert.equal(preflightRouterHomes(candidate, root), false);
});

test("preflight falls back direct after a crash leaves a reservation ambiguous", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-reservation-preflight-"));
  const secret = Buffer.alloc(32, 17);
  writeFileSync(join(root, "control-secret.v1"), secret, { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const candidate = stagedIdentityHomes(root, secret);
  publishHistoryAdoptionEvidence({ root, config: candidate, secret });
  const state = createInitialRouterState(candidate);
  state.reservations.push({
    reservationId: "rs_crash-after-thread-bind",
    opaqueAccountId: candidate.accounts[0].opaqueAccountId,
    estimatedCost: 10,
    state: "stranded_ambiguous",
    epoch: state.epoch,
  });
  writeFileSync(join(root, "router-state.json"), JSON.stringify(state), { mode: 0o600 });
  chmodSync(join(root, "router-state.json"), 0o600);
  assert.equal(preflightRouterHomes(candidate, root), false, "direct/manual recovery owns a crash-ambiguous reservation");
});

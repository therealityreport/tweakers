import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMuxCliShutdown,
  ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY,
  ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE,
  ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY,
  ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE,
  materializeSharedPluginsIntoAccount,
  materializeSharedSkillsIntoAccount,
  preflightRouterHomes,
  routerChildSqliteHome,
  sharedSkillsManifestForSource,
  sharedPluginChildArgs,
  sharedPluginsHomeMatches,
  sharedPluginsManifestForSource,
  sanitizedChildEnvironment,
} from "../../src/account-router/app-server-mux";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { createInitialRouterState } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfig, type RouterConfigV2, type RouterConfigV3 } from "../../src/account-router/types";
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

function stagedIdentityHomesV3(root: string, secret: Buffer): RouterConfigV3 {
  const v2 = stagedIdentityHomes(root, secret);
  const draft: Omit<RouterConfigV3, "fingerprint"> = {
    ...v2,
    schemaVersion: 3,
    policy: "quota_aware_v2",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

function installSharedSkills(
  root: string,
  codexHomes: readonly string[],
  trustedRoots: readonly { path: string; device: number; inode: number; uid: number; mode: number }[] = [],
): void {
  const source = join(root, ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY);
  const sourceDirectory = join(source, "fixture");
  const sourceFile = join(sourceDirectory, "SKILL.md");
  mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(sourceFile, "fixture shared skill\n", { mode: 0o600 });
  const manifest = sharedSkillsManifestForSource(source, trustedRoots);
  assert.ok(manifest, "fixture shared Skills source must be valid before sealing");
  writeFileSync(join(root, ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  chmodSync(sourceFile, 0o400);
  chmodSync(sourceDirectory, 0o500);
  chmodSync(source, 0o500);
  for (const codexHome of codexHomes) {
    assert.equal(materializeSharedSkillsIntoAccount(root, codexHome), true);
  }
}

function installSharedPlugins(
  root: string,
  codexHomes: readonly string[],
  files: readonly (readonly [string, string])[] = [],
): void {
  const source = join(root, ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY);
  const registry = join(source, "cache", "fixture-registry");
  const packageNameRoot = join(registry, "fixture-plugin");
  const packageRoot = join(packageNameRoot, "0.1.0");
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, "package.json"), "{\"name\":\"fixture-plugin\"}\n", { mode: 0o600 });
  for (const [name, contents] of files) writeFileSync(join(packageRoot, name), contents, { mode: 0o600 });
  const manifest = sharedPluginsManifestForSource(source);
  assert.ok(manifest, "fixture shared plugin source must validate before sealing");
  writeFileSync(join(root, ACCOUNT_ROUTER_SHARED_PLUGINS_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  chmodSync(join(packageRoot, "package.json"), 0o400);
  for (const [name] of files) chmodSync(join(packageRoot, name), 0o400);
  chmodSync(packageRoot, 0o500); chmodSync(packageNameRoot, 0o500); chmodSync(registry, 0o500); chmodSync(join(source, "cache"), 0o500); chmodSync(source, 0o500);
  for (const codexHome of codexHomes) assert.equal(materializeSharedPluginsIntoAccount(root, codexHome), true);
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

test("v3 preflight requires sealed Skills and plugin sources with exact read-only account projections", () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-v3-shared-skills-"));
  const secret = Buffer.alloc(32, 23);
  writeFileSync(join(root, "control-secret.v1"), secret, { mode: 0o600 });
  chmodSync(join(root, "control-secret.v1"), 0o600);
  const candidate = stagedIdentityHomesV3(root, secret);
  publishHistoryAdoptionEvidence({ root, config: candidate, secret });
  const homes = candidate.accounts.map((account) => join(root, "accounts", account.opaqueAccountId, "codex-home"));
  assert.equal(preflightRouterHomes(candidate, root), false, "v3 cannot advertise a Skills list without a sealed source");
  installSharedSkills(root, homes, [{ path: "/private/trusted-skills", device: 1, inode: 2, uid: process.getuid?.() ?? 0, mode: 0o700 }]);
  assert.equal(preflightRouterHomes(candidate, root), false, "Skills alone cannot advertise unavailable plugin definitions");
  installSharedPlugins(root, homes);
  assert.equal(preflightRouterHomes(candidate, root), true);

  for (const home of homes) {
    assert.equal(sharedPluginsHomeMatches(root, home), true);
    assert.equal(readFileSync(join(home, "config.toml"), "utf8"), "", "plugin enablement never writes account config");
  }
  const childArgs = sharedPluginChildArgs(root, ["-c", "plugins.untrusted@registry.enabled=true", "app-server"]);
  assert.deepEqual(childArgs, ["-c", "plugins.fixture-plugin@fixture-registry.enabled=true", "app-server"]);

  const manifestPath = join(root, ACCOUNT_ROUTER_SHARED_SKILLS_MANIFEST_FILE);
  const savedManifest = readFileSync(manifestPath, "utf8");
  const malformed = JSON.parse(savedManifest) as { trustedRoots: Array<{ path: string }> };
  malformed.trustedRoots[0]!.path = "relative-untrusted-root";
  writeFileSync(manifestPath, JSON.stringify(malformed), { mode: 0o600 });
  assert.equal(preflightRouterHomes(candidate, root), false, "runtime rejects malformed trusted-root provenance without reopening any external path");
  writeFileSync(manifestPath, savedManifest, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  assert.equal(preflightRouterHomes(candidate, root), true);

  const pluginDefinition = join(root, ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", "0.1.0", "package.json");
  chmodSync(pluginDefinition, 0o600);
  writeFileSync(pluginDefinition, "{\"name\":\"drifted\"}\n", { mode: 0o600 });
  assert.equal(preflightRouterHomes(candidate, root), false, "plugin package drift cannot start any child");

  const mismatched = join(homes[1]!, "skills", "fixture", "SKILL.md");
  chmodSync(mismatched, 0o600);
  writeFileSync(mismatched, "different account-only definition\n", { mode: 0o600 });
  assert.equal(preflightRouterHomes(candidate, root), false, "one account copy may not drift from the manager source");
  chmodSync(join(homes[1]!, "skills", "fixture"), 0o700);
  unlinkSync(mismatched);
  symlinkSync(join(root, ACCOUNT_ROUTER_SHARED_SKILLS_DIRECTORY, "fixture", "SKILL.md"), mismatched);
  assert.equal(preflightRouterHomes(candidate, root), false, "symlinked Skills copies are not materializations");
});

test("v3 plugin preflight matches migration filename policy", () => {
  const ordinaryFiles = [
    ["cookie.js", "export const cookie = true;\n"],
    ["cookies.js", "export const cookies = true;\n"],
    ["simpleClientCredentials.js", "export const clientCredentials = true;\n"],
    ["generate_secret.js", "export const generate = true;\n"],
    ["secret-redaction.md", "# Redaction guidance\n"],
    ["cookie-bite.svg", "<svg />\n"],
  ] as const;

  const prepare = (credentialName?: string, credentialDirectory = false): { root: string; candidate: RouterConfigV3 } => {
    const root = mkdtempSync(join(tmpdir(), "account-router-v3-plugin-policy-"));
    const secret = Buffer.alloc(32, 31);
    writeFileSync(join(root, "control-secret.v1"), secret, { mode: 0o600 });
    chmodSync(join(root, "control-secret.v1"), 0o600);
    const candidate = stagedIdentityHomesV3(root, secret);
    publishHistoryAdoptionEvidence({ root, config: candidate, secret });
    const homes = candidate.accounts.map((account) => join(root, "accounts", account.opaqueAccountId, "codex-home"));
    installSharedSkills(root, homes);
    installSharedPlugins(root, homes, ordinaryFiles);

    if (credentialName) {
      const packageRoot = join(root, ACCOUNT_ROUTER_SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", "0.1.0");
      chmodSync(packageRoot, 0o700);
      const credentialPath = join(packageRoot, credentialName);
      if (credentialDirectory) mkdirSync(credentialPath, { mode: 0o700 });
      else {
        writeFileSync(credentialPath, "credential fixture\n", { mode: 0o600 });
        chmodSync(credentialPath, 0o400);
      }
      chmodSync(packageRoot, 0o500);
    }
    return { root, candidate };
  };

  const permitted = prepare();
  assert.equal(preflightRouterHomes(permitted.candidate, permitted.root), true, "migration-permitted keyword-named static files survive v3 preflight");

  for (const name of [".env.production.local", "secret.json", "api_key.json", "state.sqlite"]) {
    const fixture = prepare(name);
    assert.equal(preflightRouterHomes(fixture.candidate, fixture.root), false, `${name} remains a protected exact credential container`);
  }
  for (const name of ["credentials", ".env.local", "state.sqlite"]) {
    const fixture = prepare(name, true);
    assert.equal(preflightRouterHomes(fixture.candidate, fixture.root), false, `${name}/ remains a protected exact credential container directory`);
  }
});

test("account children inherit only operational environment values", () => {
  const env = sanitizedChildEnvironment("/private/a", "/private/sqlite", {
    PATH: "/usr/bin", LANG: "en_US.UTF-8", OPENAI_API_KEY: "not-forwarded", COOKIE: "not-forwarded", NODE_OPTIONS: "not-forwarded", CODEX_HOME: "/global",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", LANG: "en_US.UTF-8", CODEX_HOME: "/private/a", CODEX_SQLITE_HOME: "/private/sqlite" });
});

test("derived router children preserve only an exact remote-control disable guard", () => {
  const disabled = sanitizedChildEnvironment("/private/a", "/private/sqlite", {
    PATH: "/usr/bin",
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
  });
  assert.equal(disabled.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");

  for (const value of ["0", "true", "disabled"]) {
    const env = sanitizedChildEnvironment("/private/a", "/private/sqlite", {
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: value,
    });
    assert.equal(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, undefined);
  }
});

test("derived router children share only the explicit task database root", () => {
  assert.equal(routerChildSqliteHome("/private/account-a", "/Users/test/.codex"), "/Users/test/.codex");
  assert.equal(routerChildSqliteHome("/private/account-a", null), "/private/account-a/sqlite-home");
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

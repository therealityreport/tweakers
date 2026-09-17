import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1,
  DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
  abortUnpublishedSharedSourceRebase,
  bootstrapAccountContinuity,
  bootstrapSharedPluginsManifest,
  captureIdleAccountChangesBeforeSpawn,
  captureUnmaterializedNativeChangesBeforeSpawn,
  isAccountScopedCapabilityMutationV1,
  loadAccountContinuitySharedSourceProvenanceV1,
  loadAccountCapabilityOverrides,
  loadAccountConfigOverrides,
  loadSharedAccountBase,
  loadSharedPluginsManifestV1,
  observeExistingNativeAccountContinuity,
  prepareAccountConfigBeforeSpawn,
  publishPrimarySharedBaseAfterExit,
  publishPrimaryPluginInventoryAfterExit,
  rebaseAccountContinuitySharedSource,
  validateAccountContinuityMaterialization,
  type AccountContinuityAccountV1,
} from "../../src/account-router/account-continuity";
import type { OpaqueAccountId } from "../../src/account-router/types";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfigV3 } from "../../src/account-router/types";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { nativeHistoryAccountSetFingerprintV1, nativeHistoryAuthIdentityHmacV1, readAndPreflightNativeHistorySourceStaticV1, signNativeHistorySourceV1 } from "../../src/account-router/native-history";
import { prepareSharedNativeResolverTransitionV1, executeSharedNativeResolverTransitionV1, executeSharedNativeResolverTransitionAtRootV1, prepareSharedNativeModeV1, publishSharedNativeModeV1, readSharedNativeModeV1, recoverSharedNativeModeV1, SHARED_NATIVE_MODE_FILE_V1, SHARED_NATIVE_MODE_TRANSITION_FILE_V1 } from "../../src/account-router/shared-native-mode";

const ACCOUNT_A = (`ar_${"a".repeat(43)}`) as OpaqueAccountId;
const ACCOUNT_B = (`ar_${"b".repeat(43)}`) as OpaqueAccountId;

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function privateWrite(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function makePrivateTreeWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) makePrivateTreeWritable(join(path, entry));
    chmodSync(path, 0o700);
  } else {
    chmodSync(path, 0o600);
  }
}

function removePrivateTree(path: string): void {
  makePrivateTreeWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function fixture(t: test.TestContext): {
  stateRoot: string;
  primary: AccountContinuityAccountV1;
  secondary: AccountContinuityAccountV1;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "account-continuity-")));
  chmodSync(root, 0o700);
  t.after(() => removePrivateTree(root));
  const stateRoot = privateDirectory(join(root, "state"));
  const primaryHome = privateDirectory(join(root, "primary-home"));
  const secondaryHome = privateDirectory(join(root, "secondary-home"));
  privateWrite(primaryHome + "/config.toml", [
    "# primary policy comment",
    'model = "gpt-primary"',
    'model_reasoning_effort = "high"',
    'developer_instructions = "Keep tests focused."',
    "",
    "[features]",
    "enabled = true",
    "",
    "[projects.\"/tmp/project\"]",
    "trust_level = \"trusted\"",
    "",
    "[cli_auth_credentials_store]",
    'kind = "keychain"',
    "",
  ].join("\n"));
  privateWrite(join(primaryHome, "AGENTS.md"), "Primary instructions\n");
  privateWrite(secondaryHome + "/config.toml", "# account B local file\n\n");
  return {
    stateRoot,
    primary: { opaqueAccountId: ACCOUNT_A, codexHome: primaryHome },
    secondary: { opaqueAccountId: ACCOUNT_B, codexHome: secondaryHome },
  };
}

function evidence() {
  return { accountChildAbsent: true as const, nativeWriterCensus: () => "zero" as const };
}

test("bootstrap preserves account-local settings, materializes shared policy, and captures idle external edits", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const bootstrap = bootstrapAccountContinuity({
    stateRoot,
    primaryOpaqueAccountId: ACCOUNT_A,
    accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    apply: true,
    now: () => "2026-09-05T12:00:00.000Z",
  });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  assert.ok(bootstrap.shared);
  assert.ok(bootstrap.plugins);

  const shared = loadSharedAccountBase(stateRoot);
  const plugins = loadSharedPluginsManifestV1(stateRoot);
  assert.ok(shared);
  assert.ok(plugins);
  const firstPrepare = prepareAccountConfigBeforeSpawn({
    stateRoot,
    account: secondary,
    shared,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    plugins,
    writeEvidence: evidence(),
    apply: true,
  });
  assert.equal(firstPrepare.state, "ready", firstPrepare.reason);
  assert.equal(firstPrepare.written, true);
  const materialized = readFileSync(join(secondary.codexHome, "config.toml"), "utf8");
  assert.match(materialized, /model = "gpt-primary"/);
  assert.match(materialized, /model_reasoning_effort = "high"/);
  assert.match(materialized, /\[features\]/);
  assert.doesNotMatch(materialized, /\[cli_auth_credentials_store\]/, "local credential-store configuration remains in the primary only");
  assert.equal(readFileSync(join(secondary.codexHome, "AGENTS.md"), "utf8"), "Primary instructions\n");

  privateWrite(join(secondary.codexHome, "config.toml"), [
    "# external app kept this comment",
    'model = "gpt-secondary-external"',
    'model_reasoning_effort = "medium"',
    "",
    "[features]",
    "enabled = false",
    "",
  ].join("\n"));
  const idle = captureIdleAccountChangesBeforeSpawn({
    stateRoot,
    account: secondary,
    shared,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    plugins,
    writeEvidence: evidence(),
    apply: true,
  });
  assert.equal(idle.state, "captured", idle.reason);
  assert.ok(idle.configOverrides);
  assert.ok(idle.capabilityOverrides);
  assert.equal(loadAccountConfigOverrides(stateRoot, secondary)?.fingerprint, idle.configOverrides?.fingerprint);
  assert.equal(loadAccountCapabilityOverrides(stateRoot, secondary)?.fingerprint, idle.capabilityOverrides?.fingerprint);

  const secondPrepare = prepareAccountConfigBeforeSpawn({
    stateRoot,
    account: secondary,
    shared,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    plugins,
    configOverrides: idle.configOverrides,
    capabilityOverrides: idle.capabilityOverrides,
    writeEvidence: evidence(),
    apply: true,
  });
  assert.equal(secondPrepare.state, "ready", secondPrepare.reason);
  assert.match(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), /gpt-secondary-external/);
});

test("primary idle capture advances an immutable shared generation only after an exact-base check", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const bootstrap = bootstrapAccountContinuity({
    stateRoot,
    primaryOpaqueAccountId: ACCOUNT_A,
    accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    apply: true,
  });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot);
  const plugins = loadSharedPluginsManifestV1(stateRoot);
  assert.ok(shared);
  assert.ok(plugins);
  const primaryPrepare = prepareAccountConfigBeforeSpawn({
    stateRoot,
    account: primary,
    shared,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    plugins,
    writeEvidence: evidence(),
    apply: true,
  });
  assert.equal(primaryPrepare.state, "ready", primaryPrepare.reason);
  privateWrite(join(primary.codexHome, "config.toml"), 'model = "gpt-primary-external"\nmodel_verbosity = "high"\n');

  const idle = captureIdleAccountChangesBeforeSpawn({
    stateRoot,
    account: primary,
    shared,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    plugins,
    primary: true,
    writeEvidence: evidence(),
    apply: true,
  });
  assert.equal(idle.state, "captured", idle.reason);
  assert.ok(idle.proposedSharedConfig);
  assert.ok(idle.proposedSharedCapabilities);
  const published = publishPrimarySharedBaseAfterExit({
    stateRoot,
    prior: shared,
    proposedConfig: idle.proposedSharedConfig,
    proposedCapabilities: idle.proposedSharedCapabilities,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    apply: true,
  });
  assert.equal(published.state, "published");
  assert.equal(published.shared?.config.generation, shared.config.generation + 1);
  assert.equal((published.shared?.config.tree.model as { value?: string })?.value, "gpt-primary-external");
  assert.equal(publishPrimarySharedBaseAfterExit({
    stateRoot,
    prior: shared,
    proposedConfig: idle.proposedSharedConfig,
    proposedCapabilities: idle.proposedSharedCapabilities,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    apply: false,
  }).state, "blocked", "a stale primary snapshot cannot overwrite the newer base");
});

test("account-scoped capability mutations are explicit and idle capture refuses an absent-child proof gap", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const bootstrap = bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot);
  const plugins = loadSharedPluginsManifestV1(stateRoot);
  assert.ok(shared);
  assert.ok(plugins);
  const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, plugins, writeEvidence: evidence(), apply: true });
  assert.equal(prepared.state, "ready", prepared.reason);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "edited-outside-broker"\n');
  const missingLease = captureIdleAccountChangesBeforeSpawn({
    stateRoot,
    account: secondary,
    shared,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    plugins,
    writeEvidence: { accountChildAbsent: false, nativeWriterCensus: () => "zero" },
    apply: true,
  });
  assert.equal(missingLease.state, "blocked");
  assert.equal(isAccountScopedCapabilityMutationV1("plugin/install"), true);
  assert.equal(ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1.has("mcpServer/oauth/login" as never), false);
  assert.equal(isAccountScopedCapabilityMutationV1("mcpServer/oauth/login"), false);
});

test("materialization overlays regular skill siblings without following an account-local linked child", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateDirectory(join(primary.codexHome, "skills"));
  privateWrite(join(primary.codexHome, "skills", "shared.md"), "Shared skill\n");
  const bootstrap = bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot);
  const plugins = loadSharedPluginsManifestV1(stateRoot);
  assert.ok(shared);
  assert.ok(plugins);

  const externalSkill = privateDirectory(join(secondary.codexHome, "external-skill"));
  privateWrite(join(externalSkill, "SKILL.md"), "External local skill\n");
  privateDirectory(join(secondary.codexHome, "skills"));
  const localLink = join(secondary.codexHome, "skills", "external");
  symlinkSync(externalSkill, localLink);

  const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, plugins, writeEvidence: evidence(), apply: true });
  assert.equal(prepared.state, "ready", prepared.reason);
  assert.equal(readFileSync(join(secondary.codexHome, "skills", "shared.md"), "utf8"), "Shared skill\n");
  assert.equal(lstatSync(localLink).isSymbolicLink(), true, "the local linked skill remains a link");
  assert.equal(readFileSync(join(externalSkill, "SKILL.md"), "utf8"), "External local skill\n");
});

test("materialization preserves an existing linked capability root as the local override", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateDirectory(join(primary.codexHome, "skills"));
  privateWrite(join(primary.codexHome, "skills", "shared.md"), "Shared skill\n");
  const bootstrap = bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot);
  const plugins = loadSharedPluginsManifestV1(stateRoot);
  assert.ok(shared);
  assert.ok(plugins);

  const externalSkills = privateDirectory(join(secondary.codexHome, "external-skills"));
  privateWrite(join(externalSkills, "external.md"), "External capability root\n");
  const linkedRoot = join(secondary.codexHome, "skills");
  symlinkSync(externalSkills, linkedRoot);
  const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, plugins, writeEvidence: evidence(), apply: true });
  assert.equal(prepared.state, "ready", prepared.reason);
  assert.equal(lstatSync(linkedRoot).isSymbolicLink(), true, "the external root is never replaced");
  assert.equal(readFileSync(join(externalSkills, "external.md"), "utf8"), "External capability root\n");
});

test("native plugin inventory copies active packages, inherits updates, and preserves local edits", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8") + '\n[plugins."tool@test"]\nenabled = true\n');
  const installVersion = (version: string, content: string) => {
    const root = privateDirectory(join(primary.codexHome, "plugins", "cache", "test", "tool", version));
    privateWrite(join(root, "SKILL.md"), content);
    privateWrite(join(root, "run.sh"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "run.sh"), 0o700);
    symlinkSync("SKILL.md", join(root, "reference.md"));
    return root;
  };
  installVersion("0.1.0", "First plugin\n");
  installVersion("0.0.9", "Inactive plugin\n");
  symlinkSync("0.1.0", join(primary.codexHome, "plugins", "cache", "test", "tool", "local"));
  const bootstrap = bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot)!;
  let plugins = loadSharedPluginsManifestV1(stateRoot)!;
  assert.equal(plugins.plugins[0]?.version, "0.1.0", "native resolver ignores local symlink aliases");
  const prepare = () => prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true });
  assert.equal(prepare().state, "ready");
  const secondaryName = join(secondary.codexHome, "plugins", "cache", "test", "tool");
  assert.equal(lstatSync(secondaryName).isSymbolicLink(), false);
  assert.equal(readFileSync(join(secondaryName, "0.1.0", "reference.md"), "utf8"), "First plugin\n");
  assert.equal(lstatSync(join(secondaryName, "0.1.0", "run.sh")).mode & 0o700, 0o700);
  installVersion("0.2.0", "Updated plugin\n");
  plugins = publishPrimaryPluginInventoryAfterExit({ stateRoot, account: primary, prior: plugins, writeEvidence: evidence() })!;
  assert.ok(plugins); assert.equal(plugins.generation, 2);
  assert.equal(prepare().state, "ready");
  assert.equal(readFileSync(join(secondaryName, "0.2.0", "SKILL.md"), "utf8"), "Updated plugin\n");
  privateWrite(join(secondaryName, "0.2.0", "SKILL.md"), "Account's local edit\n");
  installVersion("0.3.0", "Later plugin\n");
  plugins = publishPrimaryPluginInventoryAfterExit({ stateRoot, account: primary, prior: plugins, writeEvidence: evidence() })!;
  assert.equal(prepare().state, "ready");
  assert.equal(readFileSync(join(secondaryName, "0.2.0", "SKILL.md"), "utf8"), "Account's local edit\n");
});

test("primary linked skills supply immutable defaults without changing the linked source", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const skill = privateDirectory(join(stateRoot, "source-skill"));
  privateWrite(join(skill, "SKILL.md"), "Explicitly installed linked skill\n");
  privateDirectory(join(primary.codexHome, "skills"));
  symlinkSync(skill, join(primary.codexHome, "skills", "linked"));
  const bootstrap = bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) {
    const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true });
    assert.equal(prepared.state, "ready", prepared.reason);
  }
  assert.equal(lstatSync(join(primary.codexHome, "skills", "linked")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(secondary.codexHome, "skills", "linked", "SKILL.md"), "utf8"), "Explicitly installed linked skill\n");
  assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), "Explicitly installed linked skill\n");
});

test("a failed second materialization restores files even when an earlier receipt exists", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  let shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const input = (account: AccountContinuityAccountV1) => ({ stateRoot, account, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true as const });
  for (const account of [primary, secondary]) assert.equal(prepareAccountConfigBeforeSpawn(input(account)).state, "ready");
  const before = readFileSync(join(secondary.codexHome, "config.toml"), "utf8");
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8").replace('model = "gpt-primary"', 'model = "gpt-new-primary"'));
  const captured = captureIdleAccountChangesBeforeSpawn({ ...input(primary), primary: true });
  assert.equal(captured.state, "captured", captured.reason);
  const published = publishPrimarySharedBaseAfterExit({ stateRoot, prior: shared, proposedConfig: captured.proposedSharedConfig!, proposedCapabilities: captured.proposedSharedCapabilities!, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.ok(published.shared); shared = published.shared;
  const failed = prepareAccountConfigBeforeSpawn({ ...input(secondary), faultAt: "after_config" });
  assert.equal(failed.state, "blocked");
  assert.equal(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), before);
  const retried = prepareAccountConfigBeforeSpawn(input(secondary));
  assert.equal(retried.state, "ready", retried.reason);
  assert.match(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), /gpt-new-primary/);
});


test("MCP and model provider definitions inherit while credentials stay local", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const source = `
model_provider = "portable"
[model_providers.portable]
name = "Portable provider"
base_url = "https://example.test/v1"
env_key = "PORTABLE_PROVIDER_KEY"
wire_api = "responses"
[model_providers.portable.http_headers]
Authorization = "Bearer fixture-provider-secret"
[mcp_servers.safe]
command = "node"
args = ["server.js", "--mode", "read"]
[mcp_servers.password]
command = "server"
[mcp_servers.password.env]
DATABASE_PASSWORD = "fixture-password"
[mcp_servers.inline]
command = "server"
env = { API_KEY = "fixture-inline-key", REGION = "us" }
[mcp_servers.url]
url = "https://fixture:fixture-password@example.test/mcp"
startup_timeout_sec = 10
[mcp_servers.query]
url = "https://example.test/mcp?api_key=fixture-query-key"
[mcp_servers.args]
command = "server"
args = ["--api-key", "fixture-argument-key"]
`;
  privateWrite(join(primary.codexHome, "config.toml"), source);
  const bootstrap = bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(bootstrap.state, "ready", bootstrap.reason);
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const sharedText = JSON.stringify(shared.config.tree);
  for (const secret of ["fixture-password", "fixture-inline-key", "fixture-query-key", "fixture-argument-key", "fixture-provider-secret"]) assert.equal(sharedText.includes(secret), false);
  const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true });
  assert.equal(prepared.state, "ready", prepared.reason);
  const target = readFileSync(join(secondary.codexHome, "config.toml"), "utf8");
  assert.match(target, /server\.js/);
  assert.match(target, /model_provider = "portable"/);
  assert.match(target, /PORTABLE_PROVIDER_KEY/);
  assert.match(target, /https:\/\/example\.test\/v1/);
  assert.equal(target.includes("fixture-"), false);
  assert.equal(target.includes("[mcp_servers.url]"), false, "removing credentials must not create an invalid partial server");
  assert.equal(readFileSync(join(primary.codexHome, "config.toml"), "utf8"), source);
});

test("native baseline records only an exact existing home and preserves a valid receipt", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!;
  const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(primary.codexHome);
  const input = { stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true };
  const configPath = join(primary.codexHome, "config.toml");
  const agentsPath = join(primary.codexHome, "AGENTS.md");
  const config = readFileSync(configPath); const agents = readFileSync(agentsPath);
  const before = [primary.codexHome, configPath, agentsPath].map((path) => lstatSync(path));
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_A);
  const privateBefore = readdirSync(accountRoot);
  const dry = observeExistingNativeAccountContinuity(input);
  assert.equal(dry.state, "ready", dry.reason);
  assert.equal(dry.written, false);
  assert.deepEqual(readdirSync(accountRoot), privateBefore);
  const applied = observeExistingNativeAccountContinuity({ ...input, apply: true });
  assert.equal(applied.state, "ready", applied.reason);
  assert.equal(applied.written, false, "native artifacts were observed, never written");
  const receiptPath = join(accountRoot, "config-materialization.v1.json");
  const receipt = readFileSync(receiptPath);
  const receiptStat = lstatSync(receiptPath);
  assert.equal(validateAccountContinuityMaterialization(stateRoot, ACCOUNT_A), true);
  assert.equal(observeExistingNativeAccountContinuity({ ...input, apply: true }).state, "ready");
  assert.deepEqual(readFileSync(receiptPath), receipt);
  assert.equal(lstatSync(receiptPath).ino, receiptStat.ino);
  assert.deepEqual(readFileSync(configPath), config);
  assert.deepEqual(readFileSync(agentsPath), agents);
  [primary.codexHome, configPath, agentsPath].forEach((path, index) => {
    const after = lstatSync(path);
    assert.equal(after.ino, before[index]!.ino);
    assert.equal(after.mode, before[index]!.mode);
    assert.equal(after.mtimeMs, before[index]!.mtimeMs);
    assert.equal(after.ctimeMs, before[index]!.ctimeMs);
  });
  privateWrite(configPath, `${config.toString()}\n# native edit\n`);
  assert.equal(observeExistingNativeAccountContinuity({ ...input, apply: true }).state, "would_write");
  assert.deepEqual(readFileSync(receiptPath), receipt);
});

test("native baseline leaves pending inheritance and recovery unpublished", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(secondary.codexHome);
  const input = { stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, apply: true };
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_B);
  const before = readdirSync(accountRoot);
  const config = readFileSync(join(secondary.codexHome, "config.toml"));
  const pending = observeExistingNativeAccountContinuity(input);
  assert.equal(pending.state, "would_write", pending.reason);
  assert.deepEqual(readdirSync(accountRoot), before);
  assert.deepEqual(readFileSync(join(secondary.codexHome, "config.toml")), config);
  privateWrite(join(accountRoot, "plugin-projection-intent.v1.json"), "{}");
  const recovery = observeExistingNativeAccountContinuity(input);
  assert.equal(recovery.state, "blocked");
  assert.match(recovery.reason!, /recovery/);
  assert.equal(readdirSync(accountRoot).includes("config-materialization.v1.json"), false);
});

test("native baseline rejects identity, input and observation drift without publishing", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(primary.codexHome);
  const input = { stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, apply: true };
  assert.equal(observeExistingNativeAccountContinuity({ ...input, nativeHomeIdentity: { device: identity.dev, inode: identity.ino + 1 } }).state, "blocked");
  assert.equal(observeExistingNativeAccountContinuity({ ...input, nativeBindingPreflight: () => false }).state, "blocked");
  assert.equal(observeExistingNativeAccountContinuity({ ...input, account: { ...primary, accountStateRoot: primary.codexHome } }).state, "blocked");
  assert.equal(observeExistingNativeAccountContinuity({ ...input, shared: { ...shared, fingerprint: `sha256:${"0".repeat(64)}` } }).state, "blocked");
  let observations = 0;
  const drift = observeExistingNativeAccountContinuity({ ...input, nativeBindingPreflight: () => {
    if (++observations === 2) privateWrite(join(primary.codexHome, "AGENTS.md"), "Native changed during observation\n");
    return true;
  } });
  assert.equal(drift.state, "blocked", drift.reason);
  assert.match(drift.reason!, /changed during observation/);
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_A);
  assert.equal(readdirSync(accountRoot).includes("config-materialization.v1.json"), false);
  privateWrite(join(accountRoot, "config-materialization.v1.json"), "{}");
  assert.match(observeExistingNativeAccountContinuity(input).reason!, /invalid native materialization receipt/);
});

test("native baseline detects plugin changes and private recovery during observation", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const packageRoot = privateDirectory(join(primary.codexHome, "plugins", "cache", "test", "tool", "0.1.0"));
  privateWrite(join(packageRoot, "SKILL.md"), "Original plugin\n");
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8") + '\n[plugins."tool@test"]\nenabled = true\n');
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(primary.codexHome);
  const input = { stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, apply: true };
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_A);
  const stateBefore = [stateRoot, accountRoot, join(accountRoot, "capability-override-files"), join(stateRoot, "shared-account-config")].map((path) => lstatSync(path));
  const dry = observeExistingNativeAccountContinuity({ ...input, apply: false });
  assert.equal(dry.state, "ready", dry.reason);
  [stateRoot, accountRoot, join(accountRoot, "capability-override-files"), join(stateRoot, "shared-account-config")].forEach((path, index) => {
    assert.equal(lstatSync(path).ctimeMs, stateBefore[index]!.ctimeMs, "dry observation must not chmod private directories");
  });
  let observations = 0;
  const drift = observeExistingNativeAccountContinuity({ ...input, nativeBindingPreflight: () => {
    if (++observations === 2) privateWrite(join(packageRoot, "SKILL.md"), "Changed native plugin\n");
    return true;
  } });
  assert.equal(drift.state, "blocked", drift.reason);
  assert.match(drift.reason!, /changed during observation/);
  assert.equal(readdirSync(accountRoot).includes("config-materialization.v1.json"), false);
  observations = 0;
  const recovery = observeExistingNativeAccountContinuity({ ...input, nativeBindingPreflight: () => {
    if (++observations === 2) privateWrite(join(accountRoot, "config-materialization-intent.v1.json"), "null");
    return true;
  } });
  assert.equal(recovery.state, "blocked");
  assert.match(recovery.reason!, /recovery/);
  assert.equal(readdirSync(accountRoot).includes("config-materialization.v1.json"), false);
});

test("first native capture preserves enrollment edits and deletions while missing defaults still inherit", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "original-native"\n[features]\nenabled = false\n');
  privateWrite(join(secondary.codexHome, "AGENTS.md"), "Original native instructions\n");
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(secondary.codexHome);
  const input = { stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, writeEvidence: evidence(), apply: true };
  privateWrite(join(secondary.codexHome, "config.toml"), '# Native edits before the first launch\nmodel = "edited-native"\n');
  renameSync(join(secondary.codexHome, "AGENTS.md"), join(secondary.codexHome, "instructions-preserved.txt"));
  const nativeBefore = readFileSync(join(secondary.codexHome, "config.toml"));
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_B);
  const metadataBefore = readdirSync(accountRoot).map((name) => [name, lstatSync(join(accountRoot, name)).ctimeMs]);
  const dry = captureUnmaterializedNativeChangesBeforeSpawn({ ...input, apply: false });
  assert.equal(dry.state, "captured", dry.reason);
  assert.deepEqual(readdirSync(accountRoot).map((name) => [name, lstatSync(join(accountRoot, name)).ctimeMs]), metadataBefore);
  const captured = captureUnmaterializedNativeChangesBeforeSpawn(input);
  assert.equal(captured.state, "captured", captured.reason);
  assert.deepEqual(readFileSync(join(secondary.codexHome, "config.toml")), nativeBefore);
  assert.equal(readdirSync(accountRoot).includes("config-materialization.v1.json"), false);
  assert.ok(captured.configOverrides?.operations.some((op) => op.op === "delete" && op.path.join(".") === "features"));
  assert.ok(captured.capabilityOverrides?.operations.some((op) => op.op === "delete" && op.relativePath === "AGENTS.md"));
  const retried = captureUnmaterializedNativeChangesBeforeSpawn(input);
  assert.equal(retried.state, "unchanged", retried.reason);
  assert.equal(retried.configOverrides?.fingerprint, captured.configOverrides?.fingerprint);
  const prepared = prepareAccountConfigBeforeSpawn(input);
  assert.equal(prepared.state, "ready", prepared.reason);
  const actual = readFileSync(join(secondary.codexHome, "config.toml"), "utf8");
  assert.match(actual, /edited-native/);
  assert.match(actual, /model_reasoning_effort = "high"/, "originally absent default still inherits");
  assert.doesNotMatch(actual, /\[features\]/);
  assert.equal(readdirSync(secondary.codexHome).includes("AGENTS.md"), false);
  assert.equal(loadSharedAccountBase(stateRoot)?.fingerprint, shared.fingerprint);
});

test("shared native reference mode preserves homes and recovers exact signed copy retirement", async (t) => {
  for (const scenario of ["clean", "after_intent", "after_abort", "after_publication", "unrelated", "tampered", "root_drift"] as const) {
    await t.test(scenario, (t) => {
      const original = fixture(t);
      const stateRoot = original.stateRoot;
      const secret = Buffer.alloc(32, 91);
      const rawAccounts = ["shared-native-fixture-a", "shared-native-fixture-b"];
      const accounts = [original.primary, original.secondary].map((account, index) => ({
        ...account,
        opaqueAccountId: `ar_${createHmac("sha256", secret).update(`account-router:v1:${rawAccounts[index]}`).digest("base64url")}` as OpaqueAccountId,
      }));
      const [primary, secondary] = accounts as [AccountContinuityAccountV1, AccountContinuityAccountV1];
      const draft: Omit<RouterConfigV3, "fingerprint"> = {
        schemaVersion: 3, mode: "quota_aware", policy: "quota_aware_v2", generation: 1,
        protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, primaryOpaqueAccountId: primary.opaqueAccountId,
        accounts: accounts.map((account) => ({ opaqueAccountId: account.opaqueAccountId, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}` })),
        updatedAt: "2026-09-09T14:00:00.000Z",
      };
      const config: RouterConfigV3 = { ...draft, fingerprint: routerConfigFingerprint(draft) };
      const sourceAccounts = accounts.map((account, index) => {
        privateWrite(join(account.codexHome, "auth.json"), JSON.stringify({ tokens: { account_id: rawAccounts[index] } }));
        const sqliteHome = privateDirectory(join(account.codexHome, "..", `sqlite-${index}`));
        const homeStat = lstatSync(account.codexHome); const sqliteStat = lstatSync(sqliteHome);
        return { opaqueAccountId: account.opaqueAccountId, codexHome: account.codexHome, sqliteHome,
          codexHomeIdentity: { device: homeStat.dev, inode: homeStat.ino, uid: homeStat.uid, mode: homeStat.mode & 0o7777 },
          sqliteHomeIdentity: { device: sqliteStat.dev, inode: sqliteStat.ino, uid: sqliteStat.uid, mode: sqliteStat.mode & 0o7777 },
          authIdentityHmac: nativeHistoryAuthIdentityHmacV1(rawAccounts[index]!, secret) };
      }).sort((a, b) => a.opaqueAccountId.localeCompare(b.opaqueAccountId));
      const source = signNativeHistorySourceV1({ version: 1, kind: "account-router-native-history-source", mode: "in_place",
        protocolFingerprint: config.protocolFingerprint, accountSetFingerprint: nativeHistoryAccountSetFingerprintV1(accounts.map((a) => a.opaqueAccountId)),
        metadataAccountId: secondary.opaqueAccountId, accounts: sourceAccounts, issuedAt: "2026-09-09T14:00:00.000Z" }, secret);
      privateWrite(join(stateRoot, "native-history-source.v1.json"), JSON.stringify(source));
      const native = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
      assert.equal(native.state, "ready"); if (native.state !== "ready") return;
      const context = { stateRoot, binding: native.binding, secret };
      assert.equal(readSharedNativeModeV1(context).state, "absent");
      assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: primary.opaqueAccountId,
        accounts, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
      const priorShared = loadSharedAccountBase(stateRoot)!; const priorPlugins = loadSharedPluginsManifestV1(stateRoot)!;
      const overlay = privateDirectory(join(stateRoot, "shared-native-overlay"));
      privateWrite(join(overlay, "AGENTS.md"), "Tweakers overlay\n");
      const writeEvidence = Object.fromEntries(accounts.map((a) => [a.opaqueAccountId, evidence()]));
      let expectedRebaseIntentFingerprint: `sha256:${string}` | null = null;
      const rebasePath = join(stateRoot, "shared-account-config", "shared-source-rebase-intent.v1.json");
      if (scenario.startsWith("after_")) {
        for (const account of accounts) assert.equal(prepareAccountConfigBeforeSpawn({ stateRoot, account, shared: priorShared, plugins: priorPlugins,
          schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true }).state, "ready");
        const pending = rebaseAccountContinuitySharedSource({ stateRoot, primaryOpaqueAccountId: primary.opaqueAccountId,
          sharedSourceOpaqueAccountId: secondary.opaqueAccountId, accounts, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
          priorShared, priorPlugins, accountWriteEvidence: writeEvidence, apply: true, faultAt: "after_sidecars" });
        assert.equal(pending.state, "blocked"); assert.match(pending.reason!, /after sidecars/);
        expectedRebaseIntentFingerprint = JSON.parse(readFileSync(rebasePath, "utf8")).fingerprint;
      }
      const preserved = [join(stateRoot, "native-history-source.v1.json"), ...accounts.flatMap((a) => [join(a.codexHome, "auth.json"), join(a.codexHome, "config.toml")])]
        .map((path) => ({ path, bytes: readFileSync(path), inode: lstatSync(path).ino }));
      const staging = privateDirectory(join(stateRoot, "retained-partial-plugin-staging"));
      privateWrite(join(staging, "partial.txt"), "Retain partial plugin evidence\n");
      const prepareInput = { ...context, overlayPath: overlay, expectedSourceFingerprint: native.binding.sourceDocumentFingerprint,
        expectedRebaseIntentFingerprint, resolverBinarySha256: "b".repeat(64) };
      if (scenario === "unrelated") {
        const pendingPath = join(stateRoot, "accounts", primary.opaqueAccountId, "plugin-projection-intent.v1.json");
        privateWrite(pendingPath, "{}");
        assert.equal(prepareSharedNativeModeV1(prepareInput).state, "blocked");
        assert.equal(readdirSync(stateRoot).includes(SHARED_NATIVE_MODE_TRANSITION_FILE_V1), false);
        return;
      }
      const prepared = prepareSharedNativeModeV1(prepareInput);
      assert.equal(prepared.state, "prepared", prepared.state === "blocked" ? prepared.reason : undefined);
      if (prepared.state !== "prepared") return;
      if (scenario === "tampered") {
        const changed = structuredClone(prepared.plan); changed.document.resolverBinarySha256 = "c".repeat(64);
        assert.equal(publishSharedNativeModeV1({ ...context, plan: changed, expectedPlanFingerprint: prepared.fingerprint }).state, "blocked");
      }
      const publication = publishSharedNativeModeV1({ ...context, plan: prepared.plan, expectedPlanFingerprint: prepared.fingerprint,
        accountWriteEvidence: writeEvidence, ...(scenario.startsWith("after_") ? { faultAt: scenario as "after_intent" | "after_abort" | "after_publication" } : {}) });
      if (scenario.startsWith("after_")) {
        assert.equal(publication.state, "blocked"); assert.equal(readSharedNativeModeV1(context).state, "blocked");
        assert.equal(recoverSharedNativeModeV1({ ...context, expectedTransitionFingerprint: `sha256:${"0".repeat(64)}`, accountWriteEvidence: writeEvidence }).state, "blocked");
        if (scenario === "after_intent") {
          assert.equal(recoverSharedNativeModeV1({ ...context, expectedTransitionFingerprint: prepared.fingerprint,
            accountWriteEvidence: Object.fromEntries(accounts.map((a) => [a.opaqueAccountId, { accountChildAbsent: true }])) }).state, "blocked");
        }
        const recovered = recoverSharedNativeModeV1({ ...context, expectedTransitionFingerprint: prepared.fingerprint, accountWriteEvidence: writeEvidence });
        assert.equal(recovered.state, "published", recovered.state === "blocked" ? recovered.reason : undefined);
        if (recovered.state === "published") context.binding = recovered.binding;
        assert.equal(recoverSharedNativeModeV1({ ...context, expectedTransitionFingerprint: prepared.fingerprint, accountWriteEvidence: writeEvidence }).state, "published");
      } else {
        assert.equal(publication.state, "published", publication.state === "blocked" ? publication.reason : undefined);
        if (publication.state === "published") context.binding = publication.binding;
      }
      const ready = readSharedNativeModeV1(context);
      assert.equal(ready.state, "ready", ready.state === "blocked" ? ready.reason : undefined);
      if (ready.state !== "ready") return;
      assert.deepEqual(ready.environment, { TWEAKERS_NATIVE_BASE_ROOT: secondary.codexHome, TWEAKERS_OVERLAY_ROOT: overlay });
      assert.equal(ready.document.resolverBinarySha256, "b".repeat(64));
      assert.equal(loadSharedAccountBase(stateRoot)!.fingerprint, priorShared.fingerprint);
      assert.equal(loadSharedPluginsManifestV1(stateRoot)!.fingerprint, priorPlugins.fingerprint);
      for (const item of preserved) { assert.deepEqual(readFileSync(item.path), item.bytes); assert.equal(lstatSync(item.path).ino, item.inode); }
      assert.equal(readFileSync(join(staging, "partial.txt"), "utf8"), "Retain partial plugin evidence\n");
      assert.equal(publishSharedNativeModeV1({ ...context, plan: prepared.plan, expectedPlanFingerprint: prepared.fingerprint }).state, "published");
      privateWrite(join(secondary.codexHome, "config.toml"), "# Native settings may change independently\n");
      assert.equal(readSharedNativeModeV1(context).state, "ready");
      if (scenario === "tampered") {
        const path = join(stateRoot, SHARED_NATIVE_MODE_FILE_V1); const registration = JSON.parse(readFileSync(path, "utf8"));
        registration.resolverBinarySha256 = "c".repeat(64); privateWrite(path, JSON.stringify(registration));
        const conflictingBytes = readFileSync(path);
        assert.equal(readSharedNativeModeV1(context).state, "blocked");
        assert.equal(publishSharedNativeModeV1({ ...context, plan: prepared.plan, expectedPlanFingerprint: prepared.fingerprint }).state, "blocked");
        assert.deepEqual(readFileSync(path), conflictingBytes);
      }
      if (scenario === "root_drift") {
        renameSync(overlay, overlay + "-retained"); privateDirectory(overlay);
        assert.equal(readSharedNativeModeV1(context).state, "blocked");
      }
      if (scenario === "clean") {
        const originalModeBytes = readFileSync(join(stateRoot, SHARED_NATIVE_MODE_FILE_V1));
        const current = readSharedNativeModeV1(context);
        assert.equal(current.state, "ready"); if (current.state !== "ready") return;
        const repairBinding = { operationId: "combined-repair", promotionId: "pending-promotion", journalSha256: "a".repeat(64),
          priorRepairFingerprint: "b".repeat(64), appFingerprintSha256: "c".repeat(64), runtimeFingerprintSha256: "d".repeat(64) };
        assert.equal(prepareSharedNativeResolverTransitionV1({ ...context, expectedRegistrationFingerprint: `sha256:${"0".repeat(64)}`,
          resolverBinarySha256: "e".repeat(64), repairBinding }).state, "blocked");
        const next = prepareSharedNativeResolverTransitionV1({ ...context, expectedRegistrationFingerprint: current.fingerprint,
          resolverBinarySha256: "e".repeat(64), repairBinding });
        assert.equal(next.state, "prepared"); if (next.state !== "prepared") return;
        const input = { ...context, plan: next.plan, expectedPlanFingerprint: next.fingerprint };
        const changed = structuredClone(next.plan); changed.document.resolverBinarySha256 = "f".repeat(64);
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, plan: changed, action: "begin" }).state, "blocked");
        const canonical = (value: unknown): string => {
          if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
          if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
          return JSON.stringify(value);
        };
        const wrongFields = structuredClone(next.plan);
        wrongFields.document.retiredCopyState.priorSharedFingerprint = `sha256:${"9".repeat(64)}`;
        const { signature: _documentSignature, ...documentUnsigned } = wrongFields.document;
        wrongFields.document.signature = `hmac-sha256:${createHmac("sha256", secret).update("shared-native-mode:v1\0" + canonical(documentUnsigned)).digest("hex")}`;
        const { signature: _planSignature, ...planUnsigned } = wrongFields;
        wrongFields.signature = `hmac-sha256:${createHmac("sha256", secret).update("shared-native-resolver-transition:v1\0" + canonical(planUnsigned)).digest("hex")}`;
        const rejected = executeSharedNativeResolverTransitionV1({ ...input, plan: wrongFields, action: "begin" });
        assert.equal(rejected.state, "blocked"); if (rejected.state === "blocked") assert.match(rejected.reason, /only the resolver/);
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "begin" }).state, "begun");
        assert.deepEqual(readFileSync(join(stateRoot, SHARED_NATIVE_MODE_FILE_V1)), originalModeBytes);
        assert.equal(readSharedNativeModeV1(context).state, "blocked");
        assert.equal(recoverSharedNativeModeV1({ ...context, expectedTransitionFingerprint: next.fingerprint }).state, "blocked");
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "finish" }).state, "blocked");
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "begin" }).state, "begun");
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "publish" }).state, "published");
        assert.equal(readSharedNativeModeV1(context).state, "blocked");
        assert.deepEqual(readFileSync(join(stateRoot, `shared-native-resolver-prior-${next.fingerprint.slice(7)}.json`)), originalModeBytes);
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "publish" }).state, "published");
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "finish" }).state, "finished");
        assert.equal(executeSharedNativeResolverTransitionV1({ ...input, action: "finish" }).state, "finished");
        const updated = readSharedNativeModeV1(context);
        assert.equal(updated.state, "ready"); if (updated.state !== "ready") return;
        assert.equal(updated.document.resolverBinarySha256, "e".repeat(64));
        const { signature: _beforeSignature, resolverBinarySha256: _beforeResolver, ...beforeFields } = current.document;
        const { signature: _afterSignature, resolverBinarySha256: _afterResolver, ...afterFields } = updated.document;
        assert.deepEqual(afterFields, beforeFields);
        privateWrite(join(stateRoot, "control-secret.v1"), secret.toString("binary"));
        privateWrite(join(stateRoot, "account-router-config.json"), JSON.stringify(config));
        assert.equal(executeSharedNativeResolverTransitionAtRootV1({ stateRoot, plan: next.plan, expectedPlanFingerprint: next.fingerprint, action: "validate" }).state, "validated");
        for (const item of preserved) assert.deepEqual(readFileSync(item.path), item.path.endsWith("config.toml") && item.path.startsWith(secondary.codexHome) ? Buffer.from("# Native settings may change independently\n") : item.bytes);
        privateWrite(join(stateRoot, "accounts", primary.opaqueAccountId, "native-initial-capture-intent.v1.json"), "{}");
        assert.equal(readSharedNativeModeV1(context).state, "blocked");
      }
    });
  }
});

test("first native capture accepts a newer shared generation with the recorded schema", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "original"\n');
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  let shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true });
  assert.equal(prepared.state, "ready", prepared.reason);
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8").replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "medium"'));
  const capture = captureIdleAccountChangesBeforeSpawn({ stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), primary: true, apply: true });
  assert.equal(capture.state, "captured", capture.reason);
  const published = publishPrimarySharedBaseAfterExit({ stateRoot, prior: shared, proposedConfig: capture.proposedSharedConfig!, proposedCapabilities: capture.proposedSharedCapabilities!, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.equal(published.state, "published", published.reason);
  shared = loadSharedAccountBase(stateRoot)!;
  const identity = lstatSync(secondary.codexHome);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "changed-after-bootstrap"\n');
  const input = { stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, writeEvidence: evidence(), apply: true };
  const captured = captureUnmaterializedNativeChangesBeforeSpawn(input);
  assert.equal(captured.state, "captured", captured.reason);
  assert.equal(prepareAccountConfigBeforeSpawn(input).state, "ready");
  const actual = readFileSync(join(secondary.codexHome, "config.toml"), "utf8");
  assert.match(actual, /changed-after-bootstrap/);
  assert.match(actual, /model_reasoning_effort = "medium"/);
});

test("first native capture recovers exact partial sidecar pairs and preserves retry tombstones", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "old"\n[features]\nenabled = false\n');
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(secondary.codexHome);
  const input = { stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, writeEvidence: evidence(), apply: true };
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_B);
  for (const captureFaultAt of ["after_intent", "after_config", "after_capabilities"] as const) {
    privateWrite(join(secondary.codexHome, "config.toml"), `model = "${captureFaultAt}"\n`);
    const failed = captureUnmaterializedNativeChangesBeforeSpawn({ ...input, captureFaultAt });
    assert.equal(failed.state, "blocked");
    assert.match(failed.reason!, /injected/);
    const before = readFileSync(join(secondary.codexHome, "config.toml"));
    assert.equal(captureUnmaterializedNativeChangesBeforeSpawn({ ...input, apply: false }).state, "blocked");
    assert.equal(prepareAccountConfigBeforeSpawn(input).state, "blocked", "ordinary materialization cannot bypass private recovery");
    const recovered = captureUnmaterializedNativeChangesBeforeSpawn(input);
    assert.equal(recovered.state, "captured", recovered.reason);
    assert.deepEqual(readFileSync(join(secondary.codexHome, "config.toml")), before);
    assert.equal(readdirSync(accountRoot).includes("native-initial-capture-intent.v1.json"), false);
    assert.ok(recovered.configOverrides?.operations.some((op) => op.op === "delete" && op.path.join(".") === "features"));
  }
  assert.equal(prepareAccountConfigBeforeSpawn(input).state, "ready");
  assert.doesNotMatch(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), /\[features\]/);
});

test("first native capture blocks busy homes, identity drift and ambiguous private recovery", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  const identity = lstatSync(secondary.codexHome);
  const input = { stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, writeEvidence: evidence(), apply: true };
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "native-change"\n');
  const accountRoot = join(stateRoot, "accounts", ACCOUNT_B);
  const before = readdirSync(accountRoot).map((name) => [name, lstatSync(join(accountRoot, name)).ctimeMs]);
  assert.equal(captureUnmaterializedNativeChangesBeforeSpawn({ ...input, writeEvidence: { accountChildAbsent: true, nativeWriterCensus: () => "running" } }).state, "blocked");
  assert.equal(captureUnmaterializedNativeChangesBeforeSpawn({ ...input, nativeHomeIdentity: { device: identity.dev, inode: identity.ino + 1 } }).state, "blocked");
  let checked = 0;
  assert.equal(captureUnmaterializedNativeChangesBeforeSpawn({ ...input, nativeBindingPreflight: () => ++checked < 2 }).state, "blocked");
  assert.deepEqual(readdirSync(accountRoot).map((name) => [name, lstatSync(join(accountRoot, name)).ctimeMs]), before);
  assert.equal(captureUnmaterializedNativeChangesBeforeSpawn({ ...input, captureFaultAt: "after_config" }).state, "blocked");
  privateWrite(join(accountRoot, "config-overrides.v1.json"), readFileSync(join(stateRoot, "accounts", ACCOUNT_A, "config-overrides.v1.json"), "utf8"));
  const ambiguous = captureUnmaterializedNativeChangesBeforeSpawn(input);
  assert.equal(ambiguous.state, "blocked");
  assert.equal(readdirSync(accountRoot).includes("native-initial-capture-intent.v1.json"), true);
  assert.equal(readdirSync(accountRoot).includes("native-initial-capture-receipt.v1.json"), false);
});

test("native observation ignores unsafe unshared plugins while retaining shared-package drift checks", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const relevant = privateDirectory(join(primary.codexHome, "plugins", "cache", "test", "shared", "0.1.0"));
  privateWrite(join(relevant, "SKILL.md"), "Shared plugin\n");
  const unrelated = privateDirectory(join(primary.codexHome, "plugins", "cache", "test", "disabled", "0.1.0"));
  privateWrite(join(unrelated, "SKILL.md"), "Disabled local plugin\n");
  chmodSync(join(unrelated, "SKILL.md"), 0o666);
  const unrelatedRegistry = privateDirectory(join(primary.codexHome, "plugins", "cache", "local-registry"));
  chmodSync(unrelatedRegistry, 0o777);
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8") + '\n[plugins."shared@test"]\nenabled = true\n[plugins."disabled@test"]\nenabled = false\n');
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!; const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  assert.deepEqual(plugins.plugins.map((plugin) => plugin.id), ["shared@test"]);
  const identity = lstatSync(primary.codexHome);
  const input = { stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: identity.dev, inode: identity.ino }, nativeBindingPreflight: () => true, apply: true };
  const unrelatedBefore = lstatSync(join(unrelated, "SKILL.md"));
  const registryBefore = lstatSync(unrelatedRegistry);
  const observed = observeExistingNativeAccountContinuity(input);
  assert.equal(observed.state, "ready", observed.reason);
  assert.equal(lstatSync(join(unrelated, "SKILL.md")).ctimeMs, unrelatedBefore.ctimeMs);
  assert.equal(lstatSync(unrelatedRegistry).ctimeMs, registryBefore.ctimeMs);
  assert.equal(readFileSync(join(unrelated, "SKILL.md"), "utf8"), "Disabled local plugin\n");
  const receiptPath = join(stateRoot, "accounts", ACCOUNT_A, "config-materialization.v1.json");
  const receiptBefore = readFileSync(receiptPath);
  let observations = 0;
  const drift = observeExistingNativeAccountContinuity({ ...input, nativeBindingPreflight: () => {
    if (++observations === 2) privateWrite(join(relevant, "SKILL.md"), "Shared plugin changed during observation\n");
    return true;
  } });
  assert.equal(drift.state, "blocked", drift.reason);
  assert.match(drift.reason!, /changed during observation/);
  chmodSync(join(relevant, "SKILL.md"), 0o666);
  const unsafeRelevant = observeExistingNativeAccountContinuity(input);
  assert.equal(unsafeRelevant.state, "blocked");
  assert.match(unsafeRelevant.reason!, /unsafe plugin package entry/);
  assert.deepEqual(readFileSync(receiptPath), receiptBefore);
});


test("additive provider sharing preserves legacy receipts and existing account-local provider values", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  const primaryText = 'model_provider = "primary-provider"\n[model_providers.custom]\nbase_url = "https://primary.example.test/v1"\nenv_key = "PRIMARY_KEY"\n[marketplaces.local]\nsource = "/primary/bundled-marketplace"\n';
  const secondaryText = 'model_provider = "local-provider"\n[model_providers.custom]\nbase_url = "https://secondary.example.test/v1"\nenv_key = "SECONDARY_KEY"\n[marketplaces.local]\nsource = "/secondary/bundled-marketplace"\n';
  privateWrite(join(primary.codexHome, "config.toml"), primaryText);
  privateWrite(join(secondary.codexHome, "config.toml"), secondaryText);
  const legacy = { ...DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, alwaysLocalTopLevel: [...DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1.alwaysLocalTopLevel!, "model_provider", "model_providers", "marketplaces"] };
  assert.equal(bootstrapAccountContinuity({ stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary], schema: legacy, apply: true }).state, "ready");
  let shared = loadSharedAccountBase(stateRoot)!;
  const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) {
    assert.equal(prepareAccountConfigBeforeSpawn({ stateRoot, account, shared, plugins, schema: legacy, writeEvidence: evidence(), apply: true }).state, "ready");
  }
  const upgraded = prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true });
  assert.equal(upgraded.state, "ready", upgraded.reason);
  assert.equal(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), secondaryText);
  assert.equal(loadSharedAccountBase(stateRoot)!.config.schemaFingerprint, legacy.schemaFingerprint);
  privateWrite(join(primary.codexHome, "config.toml"), primaryText.replace("primary-provider", "updated-provider"));
  const captured = captureIdleAccountChangesBeforeSpawn({ stateRoot, account: primary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, primary: true, writeEvidence: evidence(), apply: true });
  assert.equal(captured.state, "captured", captured.reason);
  const published = publishPrimarySharedBaseAfterExit({ stateRoot, prior: shared, proposedConfig: captured.proposedSharedConfig!, proposedCapabilities: captured.proposedSharedCapabilities!, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true });
  assert.ok(published.shared); shared = published.shared;
  const prepared = prepareAccountConfigBeforeSpawn({ stateRoot, account: secondary, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true });
  assert.equal(prepared.state, "ready", prepared.reason);
  assert.equal(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), secondaryText);
});

test("separate shared source supplies plural marketplaces, capabilities and plugin inventory without moving routing primary", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), [
    'model = "native-default"',
    '[marketplaces.native]',
    'source = "/Applications/Codex.app/Contents/Resources/bundled-marketplace"',
    '[marketplaces.private]',
    'authorization = "fixture-secret"',
    '[cli_auth_credentials_store]',
    'kind = "native-keychain"',
    '[plugins."native@test"]',
    "enabled = true",
    "",
  ].join("\n"));
  privateWrite(join(secondary.codexHome, "AGENTS.md"), "Native donor instructions\n");
  const plugin = privateDirectory(join(secondary.codexHome, "plugins", "cache", "test", "native", "1.0.0"));
  privateWrite(join(plugin, "SKILL.md"), "Native plugin\n");
  const boot = bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, sharedSourceOpaqueAccountId: ACCOUNT_B,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  });
  assert.equal(boot.state, "ready", boot.reason);
  assert.equal((boot.shared?.config.tree.model as { value?: string })?.value, "native-default");
  assert.deepEqual(boot.plugins?.plugins.map((entry) => entry.id), ["native@test"]);
  assert.equal(JSON.stringify(boot.shared?.config.tree).includes("fixture-secret"), false);
  const provenance = loadAccountContinuitySharedSourceProvenanceV1(stateRoot);
  assert.equal(provenance.state, "ready", provenance.reason);
  assert.equal(provenance.primaryOpaqueAccountId, ACCOUNT_A);
  assert.equal(provenance.sharedSourceOpaqueAccountId, ACCOUNT_B);
  const prepared = prepareAccountConfigBeforeSpawn({
    stateRoot, account: primary, shared: boot.shared!, plugins: loadSharedPluginsManifestV1(stateRoot)!,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  });
  assert.equal(prepared.state, "ready", prepared.reason);
  const primaryText = readFileSync(join(primary.codexHome, "config.toml"), "utf8");
  assert.match(primaryText, /bundled-marketplace/);
  assert.equal(primaryText.includes("fixture-secret"), false);
  assert.match(primaryText, /kind = "keychain"/, "routing primary keeps its credential store");
  assert.equal(readFileSync(join(primary.codexHome, "AGENTS.md"), "utf8"), "Primary instructions\n", "explicit account capability stays local");
});

test("legacy bootstrap provenance records primary as the historical shared donor", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const receiptPath = join(stateRoot, "shared-account-config", "bootstrap-receipt.v1.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  delete receipt.sharedSourceOpaqueAccountId;
  receipt.version = 1;
  privateWrite(receiptPath, `${JSON.stringify(receipt)}\n`);
  const provenance = loadAccountContinuitySharedSourceProvenanceV1(stateRoot);
  assert.equal(provenance.state, "ready", provenance.reason);
  assert.equal(provenance.legacy, true);
  assert.equal(provenance.sharedSourceOpaqueAccountId, ACCOUNT_A);
  const currentShared = loadSharedAccountBase(stateRoot)!;
  const currentPlugins = loadSharedPluginsManifestV1(stateRoot)!;
  const routingPrimaryChanged = rebaseAccountContinuitySharedSource({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_B, sharedSourceOpaqueAccountId: ACCOUNT_A,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared: currentShared, priorPlugins: currentPlugins,
  });
  assert.equal(routingPrimaryChanged.state, "ready", routingPrimaryChanged.reason);
  assert.equal(routingPrimaryChanged.sharedGeneration, currentShared.config.generation, "an already-correct donor is idempotent across routing-primary changes");
});

test("shared plugin publication requires an exact recovery candidate before preserving an unpublished pre-cache generation", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const prior = loadSharedPluginsManifestV1(stateRoot)!;
  const candidate = bootstrapSharedPluginsManifest(stateRoot, secondary.codexHome, 2, false)!;
  const tag = candidate.fingerprint.slice("sha256:".length, "sha256:".length + 16);
  const generations = join(stateRoot, "shared-account-config", "plugin-generations");
  const stagingName = `.staging-2-${tag}`;
  privateDirectory(join(generations, stagingName));
  const before = readdirSync(generations).sort();
  assert.equal(bootstrapSharedPluginsManifest(stateRoot, secondary.codexHome, 2, true, prior.fingerprint), null,
    "unbound publication cannot adopt or preserve an existing unpublished path");
  assert.deepEqual(readdirSync(generations).sort(), before);
  const recovered = bootstrapSharedPluginsManifest(stateRoot, secondary.codexHome, 2, true, prior.fingerprint, candidate.fingerprint);
  assert.equal(recovered?.fingerprint, candidate.fingerprint);
  assert.ok(readdirSync(generations).includes(`.interrupted-2-${tag}`), "the empty interrupted staging root remains recoverable");
  assert.equal(loadSharedPluginsManifestV1(stateRoot)?.fingerprint, candidate.fingerprint);
});

test("existing-state donor rebase previews then preserves captured edits and deletions while advancing both generations", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "native-default"\nmodel_reasoning_effort = "medium"\n');
  privateWrite(join(secondary.codexHome, "AGENTS.md"), "Native instructions\n");
  const plugin = privateDirectory(join(secondary.codexHome, "plugins", "cache", "test", "native", "1.0.0"));
  privateWrite(join(plugin, "SKILL.md"), "Native plugin\n");
  privateWrite(join(plugin, "README.md"), "Second immutable plugin file\n");
  privateWrite(join(secondary.codexHome, "config.toml"), readFileSync(join(secondary.codexHome, "config.toml"), "utf8") + '\n[plugins."native@test"]\nenabled = true\n');
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const priorShared = loadSharedAccountBase(stateRoot)!;
  const priorPlugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) assert.equal(prepareAccountConfigBeforeSpawn({
    stateRoot, account, shared: priorShared, plugins: priorPlugins,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).state, "ready");
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8").replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
  renameSync(join(primary.codexHome, "AGENTS.md"), join(primary.codexHome, "deleted-instructions.txt"));
  const input = {
    stateRoot, primaryOpaqueAccountId: ACCOUNT_B, sharedSourceOpaqueAccountId: ACCOUNT_B,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared, priorPlugins, accountWriteEvidence: { [ACCOUNT_A]: evidence() },
  };
  const noLeasePreview = rebaseAccountContinuitySharedSource({ ...input, accountWriteEvidence: undefined });
  assert.equal(noLeasePreview.state, "ready", noLeasePreview.reason);
  const preview = rebaseAccountContinuitySharedSource(input);
  assert.equal(preview.state, "ready", preview.reason);
  assert.equal(preview.sharedGeneration, 2);
  assert.equal(preview.pluginGeneration, 2);
  assert.equal((preview.shared?.config.tree.model as { value?: string })?.value, "native-default");
  assert.deepEqual(preview.plugins?.plugins.map((entry) => entry.id), ["native@test"]);
  assert.ok(preview.configOverrides?.[ACCOUNT_A]?.operations.some((operation) => operation.op === "set"
    && operation.path.join(".") === "model_reasoning_effort" && "value" in operation && operation.value.type === "string" && operation.value.value === "low"));
  assert.ok(preview.capabilityOverrides?.[ACCOUNT_A]?.operations.some((operation) => operation.op === "delete" && operation.relativePath === "AGENTS.md"));
  assert.equal(loadSharedAccountBase(stateRoot)?.config.generation, 1, "preview is read-only");
  const publishedGeneration = join(stateRoot, "shared-account-config", "plugin-generations", "1");
  const publishedManifestBefore = readFileSync(join(publishedGeneration, "manifest.v1.json"));
  const generationOneCandidate = bootstrapSharedPluginsManifest(stateRoot, secondary.codexHome, 1, false)!;
  assert.equal(bootstrapSharedPluginsManifest(stateRoot, secondary.codexHome, 1, true, priorPlugins.fingerprint, generationOneCandidate.fingerprint), null,
    "a donor change cannot replace a published generation");
  assert.deepEqual(readFileSync(join(publishedGeneration, "manifest.v1.json")), publishedManifestBefore);
  assert.equal(loadSharedPluginsManifestV1(stateRoot)?.fingerprint, priorPlugins.fingerprint);

  const interrupted = rebaseAccountContinuitySharedSource({ ...input, apply: true, faultAt: "during_plugins", now: () => "2026-09-09T12:00:00.000Z" });
  assert.equal(interrupted.state, "blocked");
  assert.match(interrupted.reason!, /plugin publication failed/);
  const pluginGenerations = join(stateRoot, "shared-account-config", "plugin-generations");
  const staging = readdirSync(pluginGenerations).find((name) => name.startsWith(".staging-2-"));
  assert.ok(staging, "the interrupted copy remains identifiable and outside the final generation path");
  assert.equal(readdirSync(pluginGenerations).includes("2"), false);
  assert.match(prepareAccountConfigBeforeSpawn({
    stateRoot, account: primary, shared: priorShared, plugins: priorPlugins,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).reason!, /rebase recovery/);
  const capturedConfig = loadAccountConfigOverrides(stateRoot, primary)!;
  const capturedCapabilities = loadAccountCapabilityOverrides(stateRoot, primary)!;

  symlinkSync("test", join(pluginGenerations, staging!, "cache", "unexpected-registry"));
  const unsafeResume = rebaseAccountContinuitySharedSource({
    ...input, priorShared: loadSharedAccountBase(stateRoot)!, priorPlugins: loadSharedPluginsManifestV1(stateRoot)!, apply: true,
  });
  assert.equal(unsafeResume.state, "blocked");
  assert.equal(readdirSync(pluginGenerations).includes(staging!), true, "unsafe unpublished bytes are not renamed or deleted");
  assert.equal(loadSharedPluginsManifestV1(stateRoot)?.fingerprint, priorPlugins.fingerprint);
  rmSync(join(pluginGenerations, staging!, "cache", "unexpected-registry"));

  const donorConfigBeforeDrift = readFileSync(join(secondary.codexHome, "config.toml"));
  privateWrite(join(secondary.codexHome, "config.toml"), donorConfigBeforeDrift.toString("utf8").replace('model = "native-default"', 'model = "drifted-default"'));
  const driftedResume = rebaseAccountContinuitySharedSource({
    ...input, priorShared: loadSharedAccountBase(stateRoot)!, priorPlugins: loadSharedPluginsManifestV1(stateRoot)!, apply: true,
  });
  assert.equal(driftedResume.state, "blocked");
  assert.match(driftedResume.reason!, /recovery inputs changed/);
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)?.fingerprint, capturedConfig.fingerprint);
  assert.equal(loadAccountCapabilityOverrides(stateRoot, primary)?.fingerprint, capturedCapabilities.fingerprint);
  privateWrite(join(secondary.codexHome, "config.toml"), donorConfigBeforeDrift.toString("utf8"));

  const applied = rebaseAccountContinuitySharedSource({
    ...input,
    priorShared: loadSharedAccountBase(stateRoot)!,
    priorPlugins: loadSharedPluginsManifestV1(stateRoot)!,
    apply: true,
    now: () => "2026-09-09T12:00:00.000Z",
  });
  assert.equal(applied.state, "ready", applied.reason);
  assert.equal(loadSharedAccountBase(stateRoot)?.config.generation, 2);
  assert.equal(loadSharedPluginsManifestV1(stateRoot)?.generation, 2);
  assert.ok(readdirSync(pluginGenerations).some((name) => name.startsWith(".interrupted-2-")), "the partial copy is preserved for bounded cleanup");
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)?.fingerprint, capturedConfig.fingerprint, "recovery keeps the journaled override");
  assert.equal(loadAccountCapabilityOverrides(stateRoot, primary)?.fingerprint, capturedCapabilities.fingerprint, "recovery keeps the journaled capability override");
  assert.equal(loadAccountContinuitySharedSourceProvenanceV1(stateRoot).sharedSourceOpaqueAccountId, ACCOUNT_B);
  const donorIdentity = lstatSync(secondary.codexHome);
  const observedDonor = observeExistingNativeAccountContinuity({
    stateRoot, account: secondary, shared: applied.shared!, plugins: applied.plugins!, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    nativeHomeIdentity: { device: donorIdentity.dev, inode: donorIdentity.ino }, nativeBindingPreflight: () => true,
  });
  assert.equal(observedDonor.state, "ready", observedDonor.reason);
  const idempotent = rebaseAccountContinuitySharedSource({
    ...input, priorShared: applied.shared!, priorPlugins: applied.plugins!,
  });
  assert.equal(idempotent.state, "ready", idempotent.reason);
  assert.equal(idempotent.sharedGeneration, 2);
});

test("shared-source rebase recovery refuses target artifact edits made after the journaled capture", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "native-default"\n');
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const priorShared = loadSharedAccountBase(stateRoot)!;
  const priorPlugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) assert.equal(prepareAccountConfigBeforeSpawn({
    stateRoot, account, shared: priorShared, plugins: priorPlugins,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).state, "ready");
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8").replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"'));
  const input = {
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, sharedSourceOpaqueAccountId: ACCOUNT_B,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared, priorPlugins, accountWriteEvidence: { [ACCOUNT_A]: evidence() }, apply: true as const,
  };
  const interrupted = rebaseAccountContinuitySharedSource({ ...input, faultAt: "after_intent" });
  assert.equal(interrupted.state, "blocked");
  assert.match(interrupted.reason!, /injected shared-source rebase fault/);
  const capturedSidecar = loadAccountConfigOverrides(stateRoot, primary)!;
  privateWrite(join(primary.codexHome, "config.toml"), readFileSync(join(primary.codexHome, "config.toml"), "utf8").replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "medium"'));
  privateWrite(join(primary.codexHome, "AGENTS.md"), "Edited after interrupted rebase\n");
  const resumed = rebaseAccountContinuitySharedSource({
    ...input,
    priorShared: loadSharedAccountBase(stateRoot)!,
    priorPlugins: loadSharedPluginsManifestV1(stateRoot)!,
  });
  assert.equal(resumed.state, "blocked");
  assert.match(resumed.reason!, /artifacts changed after donor capture/);
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)?.fingerprint, capturedSidecar.fingerprint, "stale rebase sidecars were not published");
  assert.match(readFileSync(join(primary.codexHome, "config.toml"), "utf8"), /model_reasoning_effort = "medium"/);
  assert.match(prepareAccountConfigBeforeSpawn({
    stateRoot, account: primary, shared: priorShared, plugins: priorPlugins,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).reason!, /rebase recovery/);
});

test("stale unpublished donor rebase restores only its journaled sidecars and retains resumable evidence", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "native-before"\n[plugins."native@test"]\nenabled = true\n');
  const plugin = privateDirectory(join(secondary.codexHome, "plugins", "cache", "test", "native", "1.0.0"));
  privateWrite(join(plugin, "SKILL.md"), "Native plugin\n");
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const priorShared = loadSharedAccountBase(stateRoot)!;
  const priorPlugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) assert.equal(prepareAccountConfigBeforeSpawn({
    stateRoot, account, shared: priorShared, plugins: priorPlugins,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).state, "ready");
  const rebase = {
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, sharedSourceOpaqueAccountId: ACCOUNT_B,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared, priorPlugins, accountWriteEvidence: { [ACCOUNT_A]: evidence() }, apply: true as const,
  };
  assert.equal(rebaseAccountContinuitySharedSource({ ...rebase, faultAt: "during_plugins" }).state, "blocked");
  const sharedRoot = join(stateRoot, "shared-account-config");
  const intentPath = join(sharedRoot, "shared-source-rebase-intent.v1.json");
  const intentBytes = readFileSync(intentPath);
  const intent = JSON.parse(intentBytes.toString("utf8"));
  const targetBefore = readFileSync(join(primary.codexHome, "config.toml"));
  const targetSidecar = loadAccountConfigOverrides(stateRoot, primary)!.fingerprint;
  privateWrite(join(secondary.codexHome, "config.toml"), 'model = "native-after"\n[plugins."native@test"]\nenabled = true\n');
  assert.match(rebaseAccountContinuitySharedSource(rebase).reason!, /recovery inputs changed/);
  const recovery = {
    stateRoot, accounts: [primary, secondary], expectedIntentFingerprint: intent.fingerprint,
    accountWriteEvidence: { [ACCOUNT_A]: evidence() },
  };
  assert.equal(abortUnpublishedSharedSourceRebase({ ...recovery, expectedIntentFingerprint: `sha256:${"0".repeat(64)}` }).state, "blocked");
  assert.equal(abortUnpublishedSharedSourceRebase({ ...recovery, accountWriteEvidence: undefined, apply: true }).state, "blocked");
  privateWrite(join(primary.codexHome, "config.toml"), `${targetBefore.toString("utf8")}\n# concurrent target edit\n`);
  assert.match(abortUnpublishedSharedSourceRebase({ ...recovery, apply: true }).reason!, /artifacts changed/);
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)!.fingerprint, targetSidecar);
  privateWrite(join(primary.codexHome, "config.toml"), targetBefore.toString("utf8"));
  const preview = abortUnpublishedSharedSourceRebase(recovery);
  assert.equal(preview.state, "would_abort", preview.reason);
  assert.deepEqual(readFileSync(intentPath), intentBytes);
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)!.fingerprint, targetSidecar);
  const interrupted = abortUnpublishedSharedSourceRebase({ ...recovery, apply: true, faultAt: "after_sidecars" });
  assert.match(interrupted.reason!, /injected unpublished rebase recovery fault/);
  assert.deepEqual(readFileSync(intentPath), intentBytes);
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)!.fingerprint, intent.accounts[0].beforeConfig.fingerprint);
  const recovered = abortUnpublishedSharedSourceRebase({ ...recovery, apply: true });
  assert.equal(recovered.state, "aborted", recovered.reason);
  assert.deepEqual(readFileSync(join(sharedRoot, recovered.archiveFile!)), intentBytes);
  assert.deepEqual(readFileSync(join(primary.codexHome, "config.toml")), targetBefore);
  assert.match(readFileSync(join(secondary.codexHome, "config.toml"), "utf8"), /native-after/);
  assert.equal(loadSharedAccountBase(stateRoot)!.fingerprint, priorShared.fingerprint);
  assert.equal(loadSharedPluginsManifestV1(stateRoot)!.fingerprint, priorPlugins.fingerprint);
  assert.equal(abortUnpublishedSharedSourceRebase({ ...recovery, apply: true }).state, "absent");
  const fresh = rebaseAccountContinuitySharedSource(rebase);
  assert.equal(fresh.state, "ready", fresh.reason);
  assert.equal((fresh.shared!.config.tree.model as { value: string }).value, "native-after");
});

test("unpublished rebase recovery refuses a transaction after either global manifest is published", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const priorShared = loadSharedAccountBase(stateRoot)!;
  const priorPlugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) assert.equal(prepareAccountConfigBeforeSpawn({
    stateRoot, account, shared: priorShared, plugins: priorPlugins,
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).state, "ready");
  assert.equal(rebaseAccountContinuitySharedSource({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, sharedSourceOpaqueAccountId: ACCOUNT_B,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared, priorPlugins, accountWriteEvidence: { [ACCOUNT_A]: evidence() }, apply: true, faultAt: "after_plugins",
  }).state, "blocked");
  const intentPath = join(stateRoot, "shared-account-config", "shared-source-rebase-intent.v1.json");
  const bytes = readFileSync(intentPath);
  const sidecar = loadAccountConfigOverrides(stateRoot, primary)!.fingerprint;
  const result = abortUnpublishedSharedSourceRebase({
    stateRoot, accounts: [primary, secondary], expectedIntentFingerprint: JSON.parse(bytes.toString("utf8")).fingerprint,
    accountWriteEvidence: { [ACCOUNT_A]: evidence() }, apply: true,
  });
  assert.match(result.reason!, /published or changed/);
  assert.deepEqual(readFileSync(intentPath), bytes);
  assert.equal(loadAccountConfigOverrides(stateRoot, primary)!.fingerprint, sidecar);
});

test("shared-source preview rejects a dangling enabled donor plugin without publishing", (t) => {
  const { stateRoot, primary, secondary } = fixture(t);
  assert.equal(bootstrapAccountContinuity({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, accounts: [primary, secondary],
    schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, apply: true,
  }).state, "ready");
  const shared = loadSharedAccountBase(stateRoot)!;
  const plugins = loadSharedPluginsManifestV1(stateRoot)!;
  for (const account of [primary, secondary]) assert.equal(prepareAccountConfigBeforeSpawn({
    stateRoot, account, shared, plugins, schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, writeEvidence: evidence(), apply: true,
  }).state, "ready");
  privateWrite(join(secondary.codexHome, "config.toml"), readFileSync(join(secondary.codexHome, "config.toml"), "utf8") + '\n[plugins."broken@test"]\nenabled = true\n');
  const broken = privateDirectory(join(secondary.codexHome, "plugins", "cache", "test", "broken", "1.0.0"));
  symlinkSync("missing.md", join(broken, "SKILL.md"));
  const preview = rebaseAccountContinuitySharedSource({
    stateRoot, primaryOpaqueAccountId: ACCOUNT_A, sharedSourceOpaqueAccountId: ACCOUNT_B,
    accounts: [primary, secondary], schema: DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
    priorShared: shared, priorPlugins: plugins, accountWriteEvidence: { [ACCOUNT_A]: evidence() },
  });
  assert.equal(preview.state, "blocked");
  assert.match(preview.reason!, /plugin inventory/);
  assert.equal(loadSharedAccountBase(stateRoot)?.fingerprint, shared.fingerprint);
});

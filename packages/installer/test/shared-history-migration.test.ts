import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE,
  ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
  adoptAccountHistory,
  OFFICIAL_CODEX_DATABASES,
  createHistoryAdoptionIntent,
  createHistoryAdoptionAliases,
  historyAdoptionIntentFingerprint,
  historyAdoptionReceiptFingerprint,
  inspectCompletedLegacyV2HistoryAdoption,
  routerConfigFingerprint,
  sha256Fingerprint,
  type HistoryAdoptionCensus,
  type HistoryAdoptionCensusInput,
  type HistoryAdoptionSqliteAdapter,
  type HistoryAdoptionSqliteRow,
} from "../src/account-history-adoption.ts";
import {
  CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1,
  CANONICAL_HISTORY_MAX_BYTES_V1,
  CANONICAL_HISTORY_MAX_CONVERSATIONS_V1,
  CANONICAL_HISTORY_MIGRATION_EVIDENCE_MAX_BYTES_V1,
  CANONICAL_HISTORY_FILE,
  CANONICAL_HISTORY_MIGRATION_SOURCES_FILE,
  SHARED_HISTORY_CAPACITY_PROJECTION_FILE,
  SHARED_HISTORY_CAPACITY_RECEIPT_FILE,
  SHARED_PLUGINS_DIRECTORY,
  SHARED_PLUGINS_MANIFEST_FILE,
  SHARED_HISTORY_ROLLBACK_VIEWER_FILE,
  SharedHistoryMigrationCrash,
  exportSharedHistoryRollback,
  inspectSharedHistoryCapacityReceipt,
  inspectSharedHistoryRollback,
  migrateSharedHistoryV2ToGlobalV3,
  prepareSharedHistoryAdoption,
  preflightCanonicalHistoryStore,
  recoverSharedHistoryMigration,
  sharedHistoryMigrationCommand,
  type SharedHistoryMigrationInput,
  type SharedHistoryMigrationPhase,
} from "../src/shared-history-migration.ts";
import {
  CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1 as RUNTIME_CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1,
  CANONICAL_HISTORY_MAX_BYTES_V1 as RUNTIME_CANONICAL_HISTORY_MAX_BYTES_V1,
  CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 as RUNTIME_CANONICAL_HISTORY_MAX_CONVERSATIONS_V1,
  CanonicalHistoryStoreV1,
  preflightCanonicalHistoryStore as runtimePreflightCanonicalHistoryStore,
} from "../../runtime/src/account-router/canonical-history.ts";

const OWNER = `ar_${"a".repeat(43)}` as const;
const OTHER = `ar_${"b".repeat(43)}` as const;
const THREAD_A = "01a05546-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_B = "01a05547-cf93-7383-96ed-dc76ce3d1b3c";
const TURN_A = "turn-fixture-a";
const FIXTURE_TIME = "2026-09-02T01:00:00.000Z";
const STARTED_AT = "2026-09-02T01:01:00.000Z";
const COMPLETED_AT = "2026-09-02T01:02:00.000Z";
const TRANSACTION_ID = "shared-history-fixture-tx";
const CHATGPT_APP_PATH = "/synthetic/ChatGPT.app";
const TWEAKERS_APP_PATH = "/synthetic/Tweakers.app";
const FIXTURE_PLUGIN_VERSION = "0.1.0";

class SyntheticSqlite implements HistoryAdoptionSqliteAdapter {
  readonly rows = new Map<string, HistoryAdoptionSqliteRow[]>();

  backup(source: string, destination: string): void {
    copyFileSync(source, destination);
    const rows = this.rows.get(source);
    if (rows) this.rows.set(destination, structuredClone(rows));
  }

  integrityCheck(): "ok" { return "ok"; }

  readThreads(path: string): readonly HistoryAdoptionSqliteRow[] {
    return structuredClone(this.rows.get(path) ?? []);
  }

  rewriteThreadRolloutPaths(path: string, updates: readonly HistoryAdoptionSqliteRow[]): void {
    const rows = structuredClone(this.rows.get(path) ?? []);
    const byId = new Map(updates.map((row) => [row.id, row.rolloutPath]));
    for (const row of rows) if (byId.has(row.id)) row.rolloutPath = byId.get(row.id) ?? null;
    this.rows.set(path, rows);
    writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
  }
}

class MigrationFixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-shared-history-")));
  readonly routerRoot = join(this.root, "legacy-router");
  readonly accountsRoot = join(this.routerRoot, "accounts");
  readonly legacyCodexRoot = join(this.root, "legacy-codex");
  readonly legacySqliteRoot = join(this.root, "legacy-sqlite");
  readonly legacyDefinitionsRoot = join(this.root, "legacy-definitions");
  readonly globalRoot = join(this.root, "global-v3");
  readonly rollbackRoot = join(this.root, "rollback-export");
  readonly sharedSkillsTrustedRoot = join(this.root, "trusted-shared-skills");
  readonly planSkillsTrustedRoot = join(this.root, "trusted-plan-skills");
  readonly pluginSkillsTrustedRoot = join(this.root, "trusted-plugin-skills");
  readonly sourceRollout = join(this.legacyCodexRoot, "sessions", "fixture.jsonl");
  readonly sourceSkillsRoot = join(this.legacyCodexRoot, "skills");
  readonly sourceSkill = join(this.sourceSkillsRoot, "fixture-skill", "SKILL.md");
  readonly sourcePluginRoot = join(this.legacyCodexRoot, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION);
  readonly definitionsSkill = join(this.legacyDefinitionsRoot, "skills", "fixture-skill", "SKILL.md");
  readonly definitionsPluginRoot = join(this.legacyDefinitionsRoot, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION);
  readonly sharedPluginInventory = join(this.root, "shared-plugin-inventory.v1.json");
  readonly capacityReviewRoot = join(this.root, "capacity-review");
  readonly sourceState = join(this.legacySqliteRoot, "state_5.sqlite");
  readonly sqlite = new SyntheticSqlite();
  readonly controlSecret = Buffer.alloc(32, 7);
  sharedSkillsRoots: string[];
  private adoptionSequence = 0;

  constructor(mode: "complete" | "unsafe" = "complete") {
    privateDirectory(this.root);
    for (const path of [
      this.routerRoot,
      this.accountsRoot,
      this.legacyCodexRoot,
      this.legacySqliteRoot,
      this.sharedSkillsTrustedRoot,
      this.planSkillsTrustedRoot,
      this.pluginSkillsTrustedRoot,
    ]) privateDirectory(path);
    this.sharedSkillsRoots = [this.sharedSkillsTrustedRoot];
    this.writeRouter();
    this.writeOwnerHome();
    this.writeTranscript(mode);
    this.writeSkills();
    this.writePlugins();
    this.writeDatabases();
  }

  get ownerRoot(): string { return join(this.accountsRoot, OWNER); }
  get ownerCodexHome(): string { return join(this.ownerRoot, "codex-home"); }
  get ownerSqliteHome(): string { return join(this.ownerRoot, "sqlite-home"); }
  get ownerAuth(): string { return join(this.ownerCodexHome, "auth.json"); }
  get otherRoot(): string { return join(this.accountsRoot, OTHER); }
  get otherCodexHome(): string { return join(this.otherRoot, "codex-home"); }
  get otherCopyRollout(): string { return join(this.otherCodexHome, "sessions", "copy.jsonl"); }
  get aliasesFile(): string { return join(this.routerRoot, ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE); }

  input(transactionId = TRANSACTION_ID): SharedHistoryMigrationInput {
    return {
      legacyRouterRoot: this.routerRoot,
      legacyCodexRoot: this.legacyCodexRoot,
      legacySqliteRoot: this.legacySqliteRoot,
      globalRoot: this.globalRoot,
      appPath: CHATGPT_APP_PATH,
      tweakersAppPath: TWEAKERS_APP_PATH,
      sharedSkillsRoots: [...this.sharedSkillsRoots],
      sharedPluginInventory: this.sharedPluginInventory,
      transactionId,
    };
  }

  removeLegacyAdoptionPrerequisites(): void {
    rmSync(join(this.routerRoot, "history-adoption-intent.v1.json"));
    rmSync(join(this.routerRoot, "router-state.json"));
  }

  migrate(
    apply: boolean,
    beforePhase?: (phase: SharedHistoryMigrationPhase) => void,
    census: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus = () => idleCensus(),
    inputOverrides: Partial<SharedHistoryMigrationInput> = {},
  ) {
    const dependencies = this.migrationDependencies(census, beforePhase);
    if (!apply) return migrateSharedHistoryV2ToGlobalV3({ ...this.input(), ...inputOverrides, apply: false }, dependencies);
    this.prepareAdoption(census, beforePhase, inputOverrides);
    const projectionOutputRoot = inputOverrides.projectionOutputRoot ?? this.capacityReviewRoot;
    const preview = migrateSharedHistoryV2ToGlobalV3({
      ...this.input(),
      ...inputOverrides,
      apply: false,
      projectionOutputRoot,
      capacityReceiptPath: undefined,
    }, dependencies);
    assert.equal(preview.status, "dry-run");
    assert.equal(preview.capacity?.withinCapacity, true);
    return migrateSharedHistoryV2ToGlobalV3({
      ...this.input(),
      ...inputOverrides,
      apply: true,
      projectionOutputRoot: undefined,
      capacityReceiptPath: join(projectionOutputRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
    }, dependencies);
  }

  prepareAdoption(
    census: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus = () => idleCensus(),
    beforePhase?: (phase: SharedHistoryMigrationPhase) => void,
    inputOverrides: Partial<SharedHistoryMigrationInput> = {},
  ) {
    const input = { ...this.input(), ...inputOverrides };
    return prepareSharedHistoryAdoption({
      legacyRouterRoot: input.legacyRouterRoot,
      legacyCodexRoot: input.legacyCodexRoot,
      legacySqliteRoot: input.legacySqliteRoot,
      appPath: input.appPath,
      tweakersAppPath: input.tweakersAppPath,
    }, this.migrationDependencies(census, beforePhase));
  }

  capacityPreview(
    inputOverrides: Partial<SharedHistoryMigrationInput> = {},
    outputRoot = this.capacityReviewRoot,
    census: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus = () => idleCensus(),
  ) {
    return migrateSharedHistoryV2ToGlobalV3({
      ...this.input(),
      ...inputOverrides,
      apply: false,
      projectionOutputRoot: outputRoot,
      capacityReceiptPath: undefined,
    }, this.migrationDependencies(census));
  }

  migrationDependencies(
    census: (input: HistoryAdoptionCensusInput) => HistoryAdoptionCensus,
    beforePhase?: (phase: SharedHistoryMigrationPhase) => void,
  ) {
    return {
      census,
      adoptionDependencies: {
        sqlite: this.sqlite,
        census,
        now: () => FIXTURE_TIME,
        randomId: () => `adoption-${String(++this.adoptionSequence).padStart(8, "0")}`,
      },
      now: () => COMPLETED_AT,
      randomId: () => TRANSACTION_ID,
      beforePhase,
      // This is the independently-owned runtime parser, not the migration's
      // local mirror. It proves a candidate is consumable by canonical reads.
      preflightCanonicalHistoryStore: runtimePreflightCanonicalHistoryStore,
    };
  }

  completeLegacyAdoption() {
    return adoptAccountHistory({
      sourceCodexRoot: this.legacyCodexRoot,
      sourceSqliteRoot: this.legacySqliteRoot,
      routerRoot: this.routerRoot,
      appPath: CHATGPT_APP_PATH,
      apply: true,
      requireLegacyV2: true,
    }, {
      sqlite: this.sqlite,
      census: () => idleCensus(),
      now: () => FIXTURE_TIME,
      randomId: () => `adoption-${String(++this.adoptionSequence).padStart(8, "0")}`,
    });
  }

  combineLegacySources(): void {
    for (const name of OFFICIAL_CODEX_DATABASES) {
      copyFileSync(join(this.legacySqliteRoot, name), join(this.legacyCodexRoot, name));
    }
    const rows = this.sqlite.rows.get(this.sourceState);
    if (rows) this.sqlite.rows.set(join(this.legacyCodexRoot, "state_5.sqlite"), structuredClone(rows));
  }

  /**
   * SQLite-only rows are valid legacy history members. They become bounded
   * receipt-only/partial conversations without creating thousands of files,
   * which keeps the capacity regressions focused on the canonical document.
   */
  addReceiptOnlyThreads(count: number, start = 1): void {
    const rows = structuredClone(this.sqlite.rows.get(this.sourceState) ?? []);
    for (let offset = 0; offset < count; offset += 1) {
      const tail = (start + offset).toString(16).padStart(12, "0");
      rows.push({ id: `00000000-0000-4000-8000-${tail}`, rolloutPath: null });
    }
    this.sqlite.rows.set(this.sourceState, rows);
  }

  addCrossAccountCopy(): void {
    privateDirectory(join(this.otherCodexHome, "sessions"));
    writePrivate(this.otherCopyRollout, rolloutFixtureText(THREAD_B));
  }

  writeSignedCrossAccountAlias(overrides: Partial<{
    copyOperationId: string;
    sourceOpaqueAccountId: typeof OWNER;
    sourceNativeThreadId: string;
    sourceRolloutSha256: `sha256:${string}`;
    copyOpaqueAccountId: typeof OTHER;
    copyNativeThreadId: string;
    copyRolloutSha256: `sha256:${string}`;
    portableTranscriptDigest: `sha256:${string}`;
  }> = {}, proofOverrides: Partial<{
    protocolFingerprint: `sha256:${string}`;
    poolFingerprint: `sha256:${string}`;
    intentFingerprint: `sha256:${string}`;
    adoptionReceiptFingerprint: `sha256:${string}`;
    createdAt: string;
  }> = {}): void {
    const proof = inspectCompletedLegacyV2HistoryAdoption(this.routerRoot);
    const sourceText = readFileSync(this.sourceRollout);
    const copyText = readFileSync(this.otherCopyRollout);
    const alias = createHistoryAdoptionAliases({
      protocolFingerprint: proofOverrides.protocolFingerprint ?? proof.intent.protocolFingerprint,
      poolFingerprint: proofOverrides.poolFingerprint ?? proof.intent.poolFingerprint,
      intentFingerprint: proofOverrides.intentFingerprint ?? historyAdoptionIntentFingerprint(proof.intent),
      adoptionReceiptFingerprint: proofOverrides.adoptionReceiptFingerprint ?? historyAdoptionReceiptFingerprint(proof.receipt),
      createdAt: proofOverrides.createdAt ?? COMPLETED_AT,
      aliases: [{
        copyOperationId: "offline-copy-fixture-0001",
        sourceOpaqueAccountId: OWNER,
        sourceNativeThreadId: THREAD_A,
        sourceRolloutSha256: sha256Fingerprint(sourceText),
        copyOpaqueAccountId: OTHER,
        copyNativeThreadId: THREAD_B,
        copyRolloutSha256: sha256Fingerprint(copyText),
        portableTranscriptDigest: portableFixtureTranscriptDigest(),
        ...overrides,
      }],
    }, this.controlSecret);
    writePrivate(this.aliasesFile, JSON.stringify(alias));
  }

  dispose(): void {
    this.controlSecret.fill(0);
    makeFixtureTreeWritable(this.root);
    rmSync(this.root, { recursive: true, force: true });
  }

  private writeRouter(): void {
    const accounts = [
      { opaqueAccountId: OWNER, included: true as const, weight: 1, capabilityFingerprint: `sha256:${"c".repeat(64)}` as const, label: "Account A" },
      { opaqueAccountId: OTHER, included: true as const, weight: 1, capabilityFingerprint: `sha256:${"d".repeat(64)}` as const, label: "Account B" },
    ] as const;
    const bare = {
      schemaVersion: 2 as const,
      mode: "quota_aware" as const,
      policy: "quota_aware_v1" as const,
      generation: 1,
      protocolFingerprint: ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
      primaryOpaqueAccountId: OWNER,
      accounts,
    };
    const config = { ...bare, fingerprint: routerConfigFingerprint(bare), updatedAt: FIXTURE_TIME };
    writePrivate(join(this.routerRoot, "control-secret.v1"), this.controlSecret);
    writePrivate(join(this.routerRoot, "account-router-config.json"), JSON.stringify(config));
    writePrivate(join(this.routerRoot, "history-adoption-intent.v1.json"), JSON.stringify(createHistoryAdoptionIntent({
      protocolFingerprint: config.protocolFingerprint,
      accountOpaqueIds: [OWNER, OTHER],
      configGeneration: config.generation,
      configFingerprint: config.fingerprint,
      legacyOwnerOpaqueAccountId: OWNER,
      createdAt: FIXTURE_TIME,
    }, Buffer.alloc(32, 7))));
    writePrivate(join(this.routerRoot, "router-state.json"), JSON.stringify(routerState(config)));
  }

  private writeOwnerHome(): void {
    for (const path of [this.ownerRoot, this.ownerCodexHome, this.ownerSqliteHome]) privateDirectory(path);
    writePrivate(this.ownerAuth, "{\"access_token\":\"OWNER_PRIVATE_TOKEN\"}");
    writePrivate(join(this.ownerCodexHome, "config.toml"), "");
    for (const path of [this.otherRoot, this.otherCodexHome, join(this.otherRoot, "sqlite-home")]) privateDirectory(path);
    writePrivate(join(this.otherCodexHome, "auth.json"), "{\"access_token\":\"OTHER_PRIVATE_TOKEN\"}");
    writePrivate(join(this.otherCodexHome, "config.toml"), "");
  }

  private writeTranscript(mode: "complete" | "unsafe"): void {
    privateDirectory(join(this.legacyCodexRoot, "sessions"));
    writePrivate(this.sourceRollout, rolloutFixtureText(THREAD_A, mode));
    writePrivate(join(this.legacyCodexRoot, "session_index.jsonl"), "{}\n");
  }

  private writeSkills(): void {
    privateDirectory(join(this.sourceSkillsRoot, "fixture-skill"));
    writePrivate(this.sourceSkill, "---\nname: Fixture Skill\n---\nSafe shared definition.\n");
  }

  private writePlugins(): void {
    privateDirectory(this.sourcePluginRoot);
    writePrivate(join(this.sourcePluginRoot, "package.json"), "{\"name\":\"fixture-plugin\"}\n");
    writePrivate(join(this.sourcePluginRoot, "plugin-definition.json"), "{\"safe\":true}\n");
    this.writePluginInventory(["fixture-plugin@fixture-registry"]);
  }

  writePluginInventory(pluginIds: readonly string[], version = FIXTURE_PLUGIN_VERSION): void {
    writePrivate(this.sharedPluginInventory, JSON.stringify({ version: 1, plugins: pluginIds.map((pluginId) => ({ pluginId, version })) }));
  }

  writeSeparateDefinitionsRoot(): void {
    privateDirectory(join(this.legacyDefinitionsRoot, "skills", "fixture-skill"));
    privateDirectory(this.definitionsPluginRoot);
    writePrivate(this.definitionsSkill, "---\nname: Separate Fixture Skill\n---\nDefinition-root source only.\n");
    writePrivate(join(this.definitionsPluginRoot, "package.json"), "{\"name\":\"fixture-plugin\",\"source\":\"definitions-root\"}\n");
    writePrivate(join(this.definitionsPluginRoot, "plugin-definition.json"), "{\"source\":\"definitions-root\"}\n");
  }

  addTrustedLinkedSkills(): void {
    privateDirectory(join(this.planSkillsTrustedRoot, "draft-plan"));
    writePrivate(join(this.planSkillsTrustedRoot, "draft-plan", "SKILL.md"), "trusted plan skill\n");
    privateDirectory(join(this.pluginSkillsTrustedRoot, "subagent-routing", "references"));
    writePrivate(join(this.pluginSkillsTrustedRoot, "subagent-routing", "SKILL.md"), "trusted routing skill\n");
    writePrivate(join(this.pluginSkillsTrustedRoot, "subagent-routing", "references", "policy.md"), "trusted routing policy\n");
    symlinkSync(join(this.planSkillsTrustedRoot, "draft-plan", "SKILL.md"), join(this.sourceSkillsRoot, "linked-plan.md"));
    symlinkSync(join(this.pluginSkillsTrustedRoot, "subagent-routing"), join(this.sourceSkillsRoot, "subagent-routing"));
    this.sharedSkillsRoots = [this.planSkillsTrustedRoot, this.pluginSkillsTrustedRoot];
  }

  private writeDatabases(): void {
    for (const name of OFFICIAL_CODEX_DATABASES) writePrivate(join(this.legacySqliteRoot, name), name === "state_5.sqlite" ? "[]" : `${name}\n`);
    this.sqlite.rows.set(this.sourceState, [{ id: THREAD_A, rolloutPath: this.sourceRollout }]);
  }
}

test("real rollout envelopes become canonical portable turns and survive synthetic owner-home loss", () => withFixture((fixture) => {
  const sourceBefore = readFileSync(fixture.sourceRollout, "utf8");
  const dryRun = fixture.migrate(false);
  assert.equal(dryRun.status, "adoption-required");
  assert.equal(existsSync(fixture.globalRoot), false);

  const migrated = fixture.migrate(true);
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.conversationCount, 1);
  assert.equal(runtimePreflightCanonicalHistoryStore(fixture.globalRoot).state, "ready");
  assert.deepEqual(preflightCanonicalHistoryStore(fixture.globalRoot), {
    version: 1,
    fileName: CANONICAL_HISTORY_FILE,
    state: "ready",
    conversationCount: 1,
    segmentCount: 1,
  });
  assert.equal(readFileSync(fixture.sourceRollout, "utf8"), sourceBefore, "legacy source is immutable");

  const canonicalText = readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_FILE), "utf8");
  const canonical = JSON.parse(canonicalText) as { conversations: Array<{ title: string | null; availability: string; publicThreadId: string; segments: Array<{ turns: Array<{ nativeTurnId: string | null; nativeItemIds: string[]; state: string; phase: string; portableTranscript: { items: unknown[] } | null }> }> }> };
  const conversation = canonical.conversations[0]!;
  const turn = conversation.segments[0]!.turns[0]!;
  assert.equal(conversation.title, null, "raw session titles lack signed title provenance");
  assert.equal(conversation.availability, "complete");
  assert.match(conversation.publicThreadId, /^lh_[A-Za-z0-9_-]{16,128}$/);
  assert.equal(turn.nativeTurnId, TURN_A);
  assert.deepEqual(turn.nativeItemIds, ["item-user", "item-assistant"]);
  assert.equal(turn.state, "committed");
  assert.equal(turn.phase, "committed");
  assert.deepEqual(turn.portableTranscript?.items, [
    { kind: "user", text: "Fixture user text" },
    { kind: "assistant", text: "Fixture assistant text" },
  ]);
  assert.doesNotMatch(canonicalText, /OWNER_PRIVATE_TOKEN|OTHER_PRIVATE_TOKEN|access_token/);

  const publishedOwnerAuth = join(fixture.globalRoot, "accounts", OWNER, "codex-home", "auth.json");
  assert.equal(readFileSync(publishedOwnerAuth, "utf8"), "{\"access_token\":\"OWNER_PRIVATE_TOKEN\"}");
  assert.equal(statSync(join(fixture.globalRoot, "accounts", OWNER)).mode & 0o777, 0o700);
  assert.equal(statSync(publishedOwnerAuth).mode & 0o777, 0o600);
  const publishedOtherAuth = join(fixture.globalRoot, "accounts", OTHER, "codex-home", "auth.json");
  assert.equal(readFileSync(publishedOtherAuth, "utf8"), "{\"access_token\":\"OTHER_PRIVATE_TOKEN\"}");
  assert.equal(statSync(join(fixture.globalRoot, "accounts", OTHER)).mode & 0o777, 0o700);
  assert.equal(statSync(publishedOtherAuth).mode & 0o777, 0o600);

  const sharedSkills = join(fixture.globalRoot, "shared-skills");
  const sharedManifest = JSON.parse(readFileSync(join(fixture.globalRoot, "shared-skills.v1.json"), "utf8")) as { fingerprint: string };
  assert.match(sharedManifest.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(sharedSkills, "fixture-skill", "SKILL.md"), "utf8"), readFileSync(fixture.sourceSkill, "utf8"));
  for (const account of [OWNER, OTHER]) {
    const accountSkill = join(fixture.globalRoot, "accounts", account, "codex-home", "skills", "fixture-skill", "SKILL.md");
    assert.equal(readFileSync(accountSkill, "utf8"), readFileSync(join(sharedSkills, "fixture-skill", "SKILL.md"), "utf8"));
    assert.equal(statSync(accountSkill).mode & 0o777, 0o400, "account materializations are read-only");
  }
  assert.equal(statSync(join(sharedSkills, "fixture-skill")).mode & 0o777, 0o500, "manager source is read-only");

  const sharedPlugins = join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY);
  const pluginManifest = JSON.parse(readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_MANIFEST_FILE), "utf8")) as { fingerprint: string; inventoryFingerprint: string; exclusionsFingerprint: string; packages: Array<{ pluginId: string; version: string }> };
  assert.match(pluginManifest.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(pluginManifest.inventoryFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(pluginManifest.exclusionsFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(migrated.sharedPluginInventoryFingerprint, pluginManifest.inventoryFingerprint);
  assert.equal(migrated.sharedPluginExclusionsFingerprint, pluginManifest.exclusionsFingerprint);
  assert.deepEqual(pluginManifest.packages.map((entry) => entry.pluginId), ["fixture-plugin@fixture-registry"]);
  assert.deepEqual(pluginManifest.packages.map((entry) => entry.version), [FIXTURE_PLUGIN_VERSION]);
  assert.deepEqual(migrated.sharedPluginPackages, [{ pluginId: "fixture-plugin@fixture-registry", version: FIXTURE_PLUGIN_VERSION }]);
  assert.equal(readFileSync(join(sharedPlugins, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "package.json"), "utf8"), "{\"name\":\"fixture-plugin\"}\n");
  assert.doesNotMatch(readFileSync(join(fixture.globalRoot, "accounts", OWNER, "codex-home", "config.toml"), "utf8"), /mcp_servers|fixture-plugin/);
  for (const account of [OWNER, OTHER]) {
    const cache = join(fixture.globalRoot, "accounts", account, "codex-home", "plugins", "cache");
    assert.equal(lstatSync(cache).isSymbolicLink(), true, "each child projects one cache instead of copying it");
    assert.equal(realpathSync(cache), realpathSync(join(sharedPlugins, "cache")));
  }

  const immutableSnapshot = join(fixture.root, `.global-v3.shared-history-pre-migration-${TRANSACTION_ID}`, "accounts", OWNER, "codex-home", "sessions", "fixture.jsonl");
  assert.equal(readFileSync(immutableSnapshot, "utf8"), readFileSync(join(fixture.globalRoot, "accounts", OWNER, "codex-home", "sessions", "fixture.jsonl"), "utf8"));

  // The test simulates a presently unavailable account home with a reversible
  // rename. Canonical list/read must use only the global document afterwards.
  const publishedOwnerRoot = join(fixture.globalRoot, "accounts", OWNER);
  renameSync(publishedOwnerRoot, `${publishedOwnerRoot}.unavailable`);
  const core = new CanonicalHistoryStoreV1(fixture.globalRoot, () => Date.parse(COMPLETED_AT), (size) => Buffer.alloc(size, 1), () => `lh_${"z".repeat(43)}`);
  const listed = core.logicalList();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, "Shared conversation");
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(THREAD_A));
  const logical = core.logicalRead(conversation.publicThreadId);
  assert.deepEqual(logical?.turns[0]?.items, turn.portableTranscript?.items);
  assert.doesNotMatch(JSON.stringify(logical), new RegExp(THREAD_A));

  const rollback = inspectSharedHistoryRollback(fixture.globalRoot);
  assert.equal(rollback.requiresBrokerWriteStop, true);
  assert.equal(rollback.legacySqliteFlattened, false);
  const exported = exportSharedHistoryRollback({ globalRoot: fixture.globalRoot, outputRoot: fixture.rollbackRoot, transactionId: "rollback-fixture-tx" });
  assert.equal(exported.status, "exported");
  assert.deepEqual(readdirSync(fixture.rollbackRoot).sort(), [CANONICAL_HISTORY_FILE, SHARED_HISTORY_ROLLBACK_VIEWER_FILE]);
  assert.doesNotMatch(readFileSync(join(fixture.rollbackRoot, CANONICAL_HISTORY_FILE), "utf8"), /OWNER_PRIVATE_TOKEN|OTHER_PRIVATE_TOKEN|access_token/);
  assert.doesNotMatch(readFileSync(join(fixture.rollbackRoot, SHARED_HISTORY_ROLLBACK_VIEWER_FILE), "utf8"), /OWNER_PRIVATE_TOKEN|OTHER_PRIVATE_TOKEN|accounts|sqlite/);
}));

test("prepare-adoption and capacity preview emit only the exact private review projection", () => withFixture((fixture) => {
  fixture.removeLegacyAdoptionPrerequisites();
  const prepared = fixture.prepareAdoption();
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.importedThreadCount, 1);
  assert.equal(existsSync(fixture.globalRoot), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-candidate-${TRANSACTION_ID}`)), false);

  const preview = fixture.capacityPreview();
  assert.equal(preview.status, "dry-run");
  assert.equal(preview.nextAction, "apply-offline-migration");
  assert.equal(preview.capacity?.withinCapacity, true);
  assert.doesNotMatch(JSON.stringify(preview), /hmac-sha256/);
  const capacity = preview.capacity!;
  const receiptPath = join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE);
  const projectionPath = join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_PROJECTION_FILE);
  assert.deepEqual(readdirSync(fixture.capacityReviewRoot).sort(), [
    SHARED_HISTORY_CAPACITY_PROJECTION_FILE,
    SHARED_HISTORY_CAPACITY_RECEIPT_FILE,
  ].sort());

  const projectionBytes = readFileSync(projectionPath);
  const projection = JSON.parse(projectionBytes.toString("utf8")) as unknown;
  const expectedSnapshot = Buffer.from(`${JSON.stringify(projection)}\n`, "utf8");
  const journal = Buffer.from(`${JSON.stringify({
    version: 1,
    digest: sha256Fingerprint(JSON.stringify(projection)),
    document: projection,
  })}\n`, "utf8");
  assert.deepEqual(projectionBytes, expectedSnapshot);
  assert.deepEqual(capacity.projection.snapshot, {
    bytes: projectionBytes.byteLength,
    sha256: sha256Fingerprint(projectionBytes),
  });
  assert.deepEqual(capacity.projection.journal, {
    bytes: journal.byteLength,
    sha256: sha256Fingerprint(journal),
  });

  const inspection = inspectSharedHistoryCapacityReceipt({
    legacyRouterRoot: fixture.routerRoot,
    legacyCodexRoot: fixture.legacyCodexRoot,
    legacySqliteRoot: fixture.legacySqliteRoot,
    legacyDefinitionsRoot: fixture.legacyCodexRoot,
    sharedSkillsRoots: fixture.sharedSkillsRoots,
    sharedPluginInventory: fixture.sharedPluginInventory,
    capacityReceiptPath: receiptPath,
  }, {
    adoptionDependencies: fixture.migrationDependencies(() => idleCensus()).adoptionDependencies,
  });
  assert.equal(inspection.receipt.path, receiptPath);
  assert.equal(inspection.roots.definitions.path, fixture.legacyCodexRoot);
  assert.deepEqual(inspection.sources.definitionsRoot, inspection.roots.definitions);

  const applied = migrateSharedHistoryV2ToGlobalV3({
    ...fixture.input(),
    apply: true,
    capacityReceiptPath: receiptPath,
  }, fixture.migrationDependencies(() => idleCensus()));
  assert.equal(applied.status, "migrated");
  assert.deepEqual(readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_FILE)), projectionBytes);
  const evidence = readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_MIGRATION_SOURCES_FILE));
  assert.deepEqual(capacity.projection.sourceEvidence, {
    bytes: evidence.byteLength,
    sha256: sha256Fingerprint(evidence),
  });
  expectedSnapshot.fill(0);
  journal.fill(0);
}));

test("apply requires a fresh external capacity receipt before any global artifact", () => withFixture((fixture) => {
  const dependencies = fixture.migrationDependencies(() => idleCensus());
  fixture.prepareAdoption();
  assert.throws(
    () => migrateSharedHistoryV2ToGlobalV3({ ...fixture.input(), apply: true }, dependencies),
    /shared-history-capacity-receipt-required/,
  );
  assert.equal(existsSync(fixture.globalRoot), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-candidate-${TRANSACTION_ID}`)), false);

  const preview = fixture.capacityPreview();
  assert.equal(preview.capacity?.withinCapacity, true);
  const receiptPath = join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE);
  assert.throws(
    () => migrateSharedHistoryV2ToGlobalV3({
      ...fixture.input(),
      apply: true,
      capacityReceiptPath: join(fixture.routerRoot, "capacity-receipt.json"),
    }, dependencies),
    /candidate-path-overlap/,
  );

  writePrivate(join(fixture.routerRoot, "capacity-receipt-stale-canary"), "stale");
  assert.throws(
    () => inspectSharedHistoryCapacityReceipt({
      legacyRouterRoot: fixture.routerRoot,
      legacyCodexRoot: fixture.legacyCodexRoot,
      legacySqliteRoot: fixture.legacySqliteRoot,
      legacyDefinitionsRoot: fixture.legacyCodexRoot,
      sharedSkillsRoots: fixture.sharedSkillsRoots,
      sharedPluginInventory: fixture.sharedPluginInventory,
      capacityReceiptPath: receiptPath,
    }, { adoptionDependencies: dependencies.adoptionDependencies }),
    /shared-history-capacity-receipt-router-manifest-mismatch/,
  );
  assert.throws(
    () => migrateSharedHistoryV2ToGlobalV3({
      ...fixture.input(),
      apply: true,
      capacityReceiptPath: receiptPath,
    }, dependencies),
    /shared-history-capacity-receipt-stale/,
  );
  assert.equal(existsSync(fixture.globalRoot), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-candidate-${TRANSACTION_ID}`)), false);
}));

test("installer capacity limits mirror the runtime contract", () => {
  assert.equal(CANONICAL_HISTORY_MAX_BYTES_V1, RUNTIME_CANONICAL_HISTORY_MAX_BYTES_V1);
  assert.equal(CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1, RUNTIME_CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1);
  assert.equal(CANONICAL_HISTORY_MAX_CONVERSATIONS_V1, RUNTIME_CANONICAL_HISTORY_MAX_CONVERSATIONS_V1);
});

test("over-conversation-capacity preview remains read-only and reports capacity-exceeded", () => withFixture((fixture) => {
  fixture.addReceiptOnlyThreads(CANONICAL_HISTORY_MAX_CONVERSATIONS_V1);
  assert.equal(fixture.prepareAdoption().status, "prepared");
  const preview = fixture.capacityPreview();
  assert.equal(preview.status, "dry-run");
  assert.equal(preview.nextAction, "capacity-exceeded");
  assert.equal(preview.capacity?.withinCapacity, false);
  assert.equal(preview.capacity?.counts.conversations, CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 + 1);
  assert.equal(preview.capacity?.reviewOutput, null);
  assert.equal(existsSync(fixture.capacityReviewRoot), false);
  assert.equal(existsSync(fixture.globalRoot), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-candidate-${TRANSACTION_ID}`)), false);
}));

test("candidate verification accepts source evidence above 2 MiB through the 16 MiB installer cap", () => withFixture((fixture) => {
  fixture.addReceiptOnlyThreads(7_500);
  const migrated = fixture.migrate(true);
  assert.equal(migrated.status, "migrated");
  const evidence = readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_MIGRATION_SOURCES_FILE));
  assert.ok(evidence.byteLength > 2 * 1024 * 1024);
  assert.ok(evidence.byteLength <= CANONICAL_HISTORY_MIGRATION_EVIDENCE_MAX_BYTES_V1);
  assert.deepEqual(migrated.capacity?.projection.sourceEvidence, {
    bytes: evidence.byteLength,
    sha256: sha256Fingerprint(evidence),
  });
}));

test("shared Skills source drift, symlink escapes, and pre-existing account trees fail closed", () => withFixture((fixture) => {
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "candidate-canonicalized") writePrivate(fixture.sourceSkill, "changed after copy\n");
  }), /legacy-shared-skills-source-changed-during-migration/);
  assert.equal(existsSync(fixture.globalRoot), false);
}));

test("a separate definitions root supplies only Skills and manifest-selected plugin packages", () => withFixture((fixture) => {
  fixture.writeSeparateDefinitionsRoot();
  const canaries = [
    ["auth.json", "DEFINITIONS_AUTH_CANARY"],
    ["config.toml", "DEFINITIONS_CONFIG_CANARY"],
    ["state_5.sqlite", "DEFINITIONS_SQLITE_CANARY"],
  ] as const;
  for (const [name, text] of canaries) writePrivate(join(fixture.legacyDefinitionsRoot, name), text);
  const observed: HistoryAdoptionCensusInput[] = [];
  const migrated = fixture.migrate(true, undefined, (input) => {
    observed.push({ appPath: input.appPath, protectedPaths: [...input.protectedPaths] });
    return idleCensus();
  }, { legacyDefinitionsRoot: fixture.legacyDefinitionsRoot });

  assert.equal(migrated.status, "migrated");
  const migrationObserved = observed.filter((input) => input.protectedPaths.includes(fixture.legacyDefinitionsRoot));
  assert.equal(
    migrationObserved.every((input) => JSON.stringify(input.protectedPaths) === JSON.stringify([
      fixture.legacyCodexRoot,
      fixture.legacySqliteRoot,
      fixture.accountsRoot,
      fixture.routerRoot,
      fixture.legacyDefinitionsRoot,
      join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
    ])),
    true,
    "capacity-gated migration censuses protect the original definitions source and the external receipt without changing normalized adoption roots",
  );
  assert.equal(migrationObserved.length, 4, "prepare-adoption censes only its own Codex/SQLite/router roots");
  assert.equal(
    readFileSync(join(fixture.globalRoot, "shared-skills", "fixture-skill", "SKILL.md"), "utf8"),
    readFileSync(fixture.definitionsSkill, "utf8"),
  );
  assert.equal(
    readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "plugin-definition.json"), "utf8"),
    "{\"source\":\"definitions-root\"}\n",
  );
  for (const [name, text] of canaries) {
    assert.equal(readFileSync(join(fixture.legacyDefinitionsRoot, name), "utf8"), text, `${name} remains an untouched source sibling`);
    assert.equal(existsSync(join(fixture.globalRoot, name)), false, `${name} is never copied into the global root`);
    assert.equal(existsSync(join(fixture.globalRoot, "shared-skills", name)), false, `${name} is never copied as a shared Skill`);
  }
}));

test("definitions roots must be canonical owner-controlled directories disjoint from migration artifacts", () => withFixture((fixture) => {
  fixture.writeSeparateDefinitionsRoot();
  const alias = join(fixture.root, "legacy-definitions-alias");
  symlinkSync(fixture.legacyDefinitionsRoot, alias);
  assert.throws(
    () => fixture.migrate(false, undefined, undefined, { legacyDefinitionsRoot: alias }),
    /candidate-path-symlink-refused/,
  );

  chmodSync(fixture.legacyDefinitionsRoot, 0o777);
  assert.throws(
    () => fixture.migrate(false, undefined, undefined, { legacyDefinitionsRoot: fixture.legacyDefinitionsRoot }),
    /legacy-definitions-root-not-owner-controlled-directory/,
  );
  chmodSync(fixture.legacyDefinitionsRoot, 0o700);
  assert.throws(
    () => fixture.migrate(false, undefined, undefined, { legacyDefinitionsRoot: fixture.root }),
    /candidate-path-overlap/,
  );
}));

test("definition source content and root identity are revalidated before publication", () => withFixture((fixture) => {
  fixture.writeSeparateDefinitionsRoot();
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "candidate-canonicalized") writePrivate(fixture.definitionsSkill, "changed definition source\n");
  }, undefined, { legacyDefinitionsRoot: fixture.legacyDefinitionsRoot }), /legacy-shared-skills-source-changed-during-migration/);
  assert.equal(existsSync(fixture.globalRoot), false);
}, "complete"));

test("definition root replacement after the scan is rejected even when its allowlisted content matches", () => withFixture((fixture) => {
  fixture.writeSeparateDefinitionsRoot();
  const replacement = join(fixture.root, "legacy-definitions-replacement");
  privateDirectory(join(replacement, "skills", "fixture-skill"));
  privateDirectory(join(replacement, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION));
  writePrivate(join(replacement, "skills", "fixture-skill", "SKILL.md"), readFileSync(fixture.definitionsSkill, "utf8"));
  writePrivate(join(replacement, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "package.json"), "{\"name\":\"fixture-plugin\",\"source\":\"definitions-root\"}\n");
  writePrivate(join(replacement, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "plugin-definition.json"), "{\"source\":\"definitions-root\"}\n");
  const retired = join(fixture.root, "legacy-definitions-retired");
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase !== "candidate-canonicalized") return;
    renameSync(fixture.legacyDefinitionsRoot, retired);
    renameSync(replacement, fixture.legacyDefinitionsRoot);
  }, undefined, { legacyDefinitionsRoot: fixture.legacyDefinitionsRoot }), /legacy-definitions-root-changed-during-migration/);
  assert.equal(existsSync(fixture.globalRoot), false);
}));

test("receipt inspection rejects a same-content definitions-root replacement before apply", () => withFixture((fixture) => {
  fixture.writeSeparateDefinitionsRoot();
  assert.equal(fixture.prepareAdoption(undefined, undefined, {
    legacyDefinitionsRoot: fixture.legacyDefinitionsRoot,
  }).status, "prepared");
  const preview = fixture.capacityPreview({ legacyDefinitionsRoot: fixture.legacyDefinitionsRoot });
  assert.equal(preview.capacity?.withinCapacity, true);
  const replacement = join(fixture.root, "legacy-definitions-receipt-replacement");
  privateDirectory(join(replacement, "skills", "fixture-skill"));
  privateDirectory(join(replacement, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION));
  writePrivate(join(replacement, "skills", "fixture-skill", "SKILL.md"), readFileSync(fixture.definitionsSkill, "utf8"));
  writePrivate(join(replacement, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "package.json"), "{\"name\":\"fixture-plugin\",\"source\":\"definitions-root\"}\n");
  writePrivate(join(replacement, "plugins", "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "plugin-definition.json"), "{\"source\":\"definitions-root\"}\n");
  const retired = join(fixture.root, "legacy-definitions-receipt-retired");
  renameSync(fixture.legacyDefinitionsRoot, retired);
  renameSync(replacement, fixture.legacyDefinitionsRoot);
  const receiptPath = join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE);
  const dependencies = fixture.migrationDependencies(() => idleCensus());
  const inspectionInput = {
    legacyRouterRoot: fixture.routerRoot,
    legacyCodexRoot: fixture.legacyCodexRoot,
    legacySqliteRoot: fixture.legacySqliteRoot,
    legacyDefinitionsRoot: fixture.legacyDefinitionsRoot,
    sharedSkillsRoots: fixture.sharedSkillsRoots,
    sharedPluginInventory: fixture.sharedPluginInventory,
    capacityReceiptPath: receiptPath,
  };
  assert.throws(
    () => inspectSharedHistoryCapacityReceipt(inspectionInput, { adoptionDependencies: dependencies.adoptionDependencies }),
    /shared-history-capacity-receipt-definitions-root-mismatch/,
  );
  assert.throws(
    () => migrateSharedHistoryV2ToGlobalV3({
      ...fixture.input(),
      legacyDefinitionsRoot: fixture.legacyDefinitionsRoot,
      apply: true,
      capacityReceiptPath: receiptPath,
    }, dependencies),
    /shared-history-capacity-receipt-stale/,
  );
  assert.equal(existsSync(fixture.globalRoot), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false);
}));

test("shared plugin migration copies only explicit inventory packages and ignores unselected unsafe cache entries", () => withFixture((fixture) => {
  const ignored = join(fixture.legacyCodexRoot, "plugins", "cache", "unenabled-registry", "unenabled-plugin");
  privateDirectory(ignored);
  symlinkSync(fixture.sourceSkill, join(ignored, "outside-link"));
  assert.equal(fixture.migrate(true).status, "migrated", "an unenabled external cache link is never selected or copied");
}));

test("shared plugin migration traverses only the inventory-selected exact version", () => withFixture((fixture) => {
  const packageNameRoot = dirname(fixture.sourcePluginRoot);
  const obsolete = join(packageNameRoot, "0.0.9");
  privateDirectory(obsolete);
  writePrivate(join(obsolete, "package.json"), "{\"name\":\"obsolete\"}\n");
  symlinkSync(fixture.sourceSkill, join(packageNameRoot, "local"));

  assert.equal(fixture.migrate(true).status, "migrated");
  const sealedNameRoot = join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin");
  assert.deepEqual(readdirSync(sealedNameRoot), [FIXTURE_PLUGIN_VERSION]);
  assert.equal(existsSync(join(sealedNameRoot, "local")), false);
  assert.equal(existsSync(join(sealedNameRoot, "0.0.9")), false);
}));

test("shared plugin migration admits owner-owned 0664 source files but seals every output path", () => withFixture((fixture) => {
  const sourceFile = join(fixture.sourcePluginRoot, "package.json");
  chmodSync(sourceFile, 0o664);
  assert.equal(fixture.migrate(true).status, "migrated");

  const source = join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY);
  const cache = join(source, "cache");
  const registry = join(cache, "fixture-registry");
  const packageRoot = join(registry, "fixture-plugin", FIXTURE_PLUGIN_VERSION);
  assert.equal(statSync(join(packageRoot, "package.json")).mode & 0o7777, 0o400);
  for (const directory of [source, cache, registry, packageRoot]) {
    assert.equal(statSync(directory).mode & 0o7777, 0o500, directory);
  }
}));

test("shared plugin migration refuses world-writable or set-id source files", () => withFixture((fixture) => {
  chmodSync(join(fixture.sourcePluginRoot, "package.json"), 0o666);
  assert.throws(() => fixture.migrate(false), /shared-plugin-file-unsafe/);
}));

test("shared plugin migration excludes only the exact zero-byte transient lock with receipt evidence", () => withFixture((fixture) => {
  const lock = join(fixture.sourcePluginRoot, ".venv", ".lock");
  privateDirectory(dirname(lock));
  writePrivate(lock, "");
  chmodSync(lock, 0o666);

  assert.equal(fixture.migrate(true).status, "migrated");
  const manifest = JSON.parse(readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_MANIFEST_FILE), "utf8")) as {
    packages: Array<{ excludedFiles: Array<{ path: string; bytes: number; sha256: string; reason: string }> }>;
  };
  assert.deepEqual(manifest.packages[0]?.excludedFiles, [{
    path: ".venv/.lock",
    bytes: 0,
    sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    reason: "transient-lock",
  }]);
  assert.equal(existsSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, ".venv", ".lock")), false);
}));

test("shared plugin migration rejects nonempty or symlinked transient-lock variants", () => withFixture((fixture) => {
  const lock = join(fixture.sourcePluginRoot, ".venv", ".lock");
  privateDirectory(dirname(lock));
  writePrivate(lock, "not a transient lock\n");
  chmodSync(lock, 0o666);
  assert.throws(() => fixture.migrate(false), /shared-plugin-transient-lock-unsafe/);
}));

test("shared plugin migration rejects a transient-lock symlink even when it resolves inside the selected version", () => withFixture((fixture) => {
  const lock = join(fixture.sourcePluginRoot, ".venv", ".lock");
  privateDirectory(dirname(lock));
  const target = join(fixture.sourcePluginRoot, "empty-lock-target");
  writePrivate(target, "");
  symlinkSync(target, lock);
  assert.throws(() => fixture.migrate(false), /shared-plugin-transient-lock-unsafe/);
}));

test("shared plugin migration rejects an inventory-selected cache symlink outside its package", () => withFixture((fixture) => {
  symlinkSync(fixture.sourceSkill, join(fixture.sourcePluginRoot, "outside-link"));
  assert.throws(() => fixture.migrate(true), /shared-plugin-symlink-target-untrusted/);
}));

test("shared plugin migration excludes exact credential-container bytes while retaining ordinary keyword-named files", () => withFixture((fixture) => {
  const credential = join(fixture.sourcePluginRoot, ".env.production.local");
  const exactCredential = join(fixture.sourcePluginRoot, "token.json");
  const secretCredential = join(fixture.sourcePluginRoot, "secret.json");
  const ordinaryStaticFiles = [
    ["cookie.js", "export const cookie = true;\n"],
    ["cookies.js", "export const cookies = true;\n"],
    ["simpleClientCredentials.js", "export const clientCredentials = true;\n"],
    ["generate_secret.js", "export const generate = true;\n"],
    ["secret-redaction.md", "# Redaction guidance\n"],
    ["cookie-bite.svg", "<svg aria-label=\"cookie-bite\"/>\n"],
  ] as const;
  const pluginConfig = join(fixture.sourcePluginRoot, ".codex", "config.toml");
  privateDirectory(dirname(pluginConfig));
  writePrivate(pluginConfig, "[features]\nhooks = true\n");
  writePrivate(credential, "TEST_ONLY_PLUGIN_TOKEN=do-not-materialize\n");
  writePrivate(exactCredential, "TEST_ONLY_TOKEN=do-not-materialize\n");
  writePrivate(secretCredential, "TEST_ONLY_SECRET=do-not-materialize\n");
  for (const [path, contents] of ordinaryStaticFiles) writePrivate(join(fixture.sourcePluginRoot, path), contents);
  const result = fixture.migrate(true);
  assert.equal(result.status, "migrated");
  const manifest = JSON.parse(readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_MANIFEST_FILE), "utf8")) as {
    exclusionsFingerprint: string;
    packages: Array<{ excludedFiles: Array<{ path: string; bytes: number; sha256: string; reason: string }> }>;
  };
  assert.equal(result.sharedPluginExclusionsFingerprint, manifest.exclusionsFingerprint);
  assert.deepEqual(manifest.packages[0]?.excludedFiles.map((entry) => entry.path), [".env.production.local", "secret.json", "token.json"]);
  assert.deepEqual(manifest.packages[0]?.excludedFiles.map((entry) => entry.reason), ["credential", "credential", "credential"]);
  assert.equal(existsSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, ".env.production.local")), false);
  assert.equal(existsSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "token.json")), false);
  assert.equal(existsSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, "secret.json")), false);
  for (const [path, contents] of ordinaryStaticFiles) {
    assert.equal(readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, path), "utf8"), contents);
  }
  assert.equal(readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_DIRECTORY, "cache", "fixture-registry", "fixture-plugin", FIXTURE_PLUGIN_VERSION, ".codex", "config.toml"), "utf8"), "[features]\nhooks = true\n");
  assert.doesNotMatch(readFileSync(join(fixture.globalRoot, SHARED_PLUGINS_MANIFEST_FILE), "utf8"), /TEST_ONLY_PLUGIN_TOKEN/);
}));

test("shared plugin migration rejects credential-container directories and links, invalid package config, and excluded-source drift", () => withFixture((fixture) => {
  privateDirectory(join(fixture.sourcePluginRoot, "credentials"));
  assert.throws(() => fixture.migrate(false), /shared-plugin-credential-directory-refused/);
}));

test("shared plugin migration rejects credential-container links and invalid package config", () => withFixture((fixture) => {
  const localTarget = join(fixture.sourcePluginRoot, "ordinary.txt");
  writePrivate(localTarget, "ordinary static package file\n");
  symlinkSync(localTarget, join(fixture.sourcePluginRoot, ".env.example"));
  assert.throws(() => fixture.migrate(false), /shared-plugin-credential-symlink-refused/);
}));

test("shared plugin migration rejects any package config outside the narrow feature-hook grammar", () => withFixture((fixture) => {
  const pluginConfig = join(fixture.sourcePluginRoot, ".codex", "config.toml");
  privateDirectory(dirname(pluginConfig));
  writePrivate(pluginConfig, "[mcp_servers]\nunsafe = true\n");
  assert.throws(() => fixture.migrate(false), /shared-plugin-config-not-approved/);
}));

test("shared plugin migration rechecks excluded credential metadata before publish", () => withFixture((fixture) => {
  const credential = join(fixture.sourcePluginRoot, ".env.example");
  writePrivate(credential, "EXAMPLE_TOKEN=first\n");
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "candidate-canonicalized") writePrivate(credential, "EXAMPLE_TOKEN=changed\n");
  }), /legacy-shared-plugins-source-changed-during-migration/);
}));

test("shared plugin migration requires a strict owner-private normalized effective-plugin inventory", () => withFixture((fixture) => {
  writePrivate(join(fixture.legacyCodexRoot, "config.toml"), "[plugins.\"stale@alias\"]\nenabled = true\n");
  fixture.writePluginInventory(["fixture-plugin@fixture-registry", "missing@fixture-registry"]);
  assert.throws(() => fixture.migrate(false), /legacy-shared-plugin-package-missing-or-unsafe/);

  fixture.writePluginInventory(["fixture-plugin@fixture-registry", "fixture-plugin@fixture-registry"]);
  assert.throws(() => fixture.migrate(false), /invalid-shared-plugin-inventory/);

  writePrivate(fixture.sharedPluginInventory, JSON.stringify({ version: 1, plugins: [{ pluginId: "fixture-plugin@fixture-registry", version: "../escape" }] }));
  assert.throws(() => fixture.migrate(false), /invalid-shared-plugin-inventory/);

  fixture.writePluginInventory(["fixture-plugin@fixture-registry"], "missing-version");
  assert.throws(() => fixture.migrate(false), /legacy-shared-plugin-package-missing-or-unsafe/);

  writePrivate(fixture.sharedPluginInventory, JSON.stringify({ version: 1, plugins: [{ pluginId: "fixture-plugin@fixture-registry", version: FIXTURE_PLUGIN_VERSION }], unexpected: true }));
  assert.throws(() => fixture.migrate(false), /invalid-shared-plugin-inventory/);

  fixture.writePluginInventory(["fixture-plugin@fixture-registry"]);
  chmodSync(fixture.sharedPluginInventory, 0o644);
  assert.throws(() => fixture.migrate(false), /shared-plugin-inventory-not-owner-private-regular-file/);

  fixture.writePluginInventory(["fixture-plugin@fixture-registry"]);
  chmodSync(fixture.root, 0o755);
  assert.equal(fixture.migrate(false).status, "adoption-required", "a private inventory can be supplied from an owner-controlled readable parent");
  chmodSync(fixture.root, 0o700);

  const alias = join(fixture.root, "shared-plugin-inventory-alias.json");
  symlinkSync(fixture.sharedPluginInventory, alias);
  assert.throws(() => migrateSharedHistoryV2ToGlobalV3({ ...fixture.input(), sharedPluginInventory: alias }), /invalid-shared-plugin-inventory/);
}));

test("shared plugin inventory drift is bound into the journal and stops publication", () => withFixture((fixture) => {
  const replacement = join(fixture.legacyCodexRoot, "plugins", "cache", "fixture-registry", "replacement-plugin", FIXTURE_PLUGIN_VERSION);
  privateDirectory(replacement);
  writePrivate(join(replacement, "package.json"), "{\"name\":\"replacement-plugin\"}\n");
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "candidate-canonicalized") fixture.writePluginInventory(["replacement-plugin@fixture-registry"]);
  }), /legacy-shared-plugins-source-changed-during-migration/);
  assert.equal(existsSync(fixture.globalRoot), false);
}));

test("shared Skills migration flattens only exact trusted leaf and directory links into identical read-only copies", () => withFixture((fixture) => {
  fixture.addTrustedLinkedSkills();
  symlinkSync(fixture.sourceSkill, join(fixture.sourceSkillsRoot, "internal-alias.md"));
  const result = fixture.migrate(true);
  assert.equal(result.status, "migrated");
  assert.deepEqual(result.sharedSkillsTrustedRoots, [fixture.planSkillsTrustedRoot, fixture.pluginSkillsTrustedRoot].sort());
  assert.match(result.sharedSkillsTrustedRootsFingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
  const manifest = JSON.parse(readFileSync(join(fixture.globalRoot, "shared-skills.v1.json"), "utf8")) as {
    trustedRoots: Array<{ path: string }>;
    trustedRootsFingerprint: string;
  };
  assert.deepEqual(manifest.trustedRoots.map((root) => root.path), [fixture.planSkillsTrustedRoot, fixture.pluginSkillsTrustedRoot].sort());
  assert.equal(manifest.trustedRootsFingerprint, result.sharedSkillsTrustedRootsFingerprint);
  for (const account of [OWNER, OTHER]) {
    const home = join(fixture.globalRoot, "accounts", account, "codex-home", "skills");
    assert.equal(readFileSync(join(home, "linked-plan.md"), "utf8"), "trusted plan skill\n");
    assert.equal(readFileSync(join(home, "internal-alias.md"), "utf8"), readFileSync(fixture.sourceSkill, "utf8"));
    assert.equal(readFileSync(join(home, "subagent-routing", "SKILL.md"), "utf8"), "trusted routing skill\n");
    assert.equal(lstatSync(join(home, "linked-plan.md")).isSymbolicLink(), false);
    assert.equal(lstatSync(join(home, "subagent-routing")).isSymbolicLink(), false);
  }
}));

test("shared Skills migration rejects a link outside its explicit trusted roots", () => withFixture((fixture) => {
  const unlisted = join(fixture.root, "unlisted-skills");
  privateDirectory(unlisted);
  writePrivate(join(unlisted, "SKILL.md"), "not approved\n");
  symlinkSync(join(unlisted, "SKILL.md"), join(fixture.sourceSkillsRoot, "unlisted.md"));
  assert.throws(() => fixture.migrate(true), /shared-skills-symlink-target-untrusted/);
}));

test("shared Skills migration rejects trusted-root symlink chains that resolve outside the declared root", () => withFixture((fixture) => {
  const unlisted = join(fixture.root, "unlisted-skills");
  privateDirectory(unlisted);
  writePrivate(join(unlisted, "SKILL.md"), "not approved\n");
  const trusted = fixture.sharedSkillsTrustedRoot;
  symlinkSync(unlisted, join(trusted, "escaping-link"));
  symlinkSync(join(trusted, "escaping-link"), join(fixture.sourceSkillsRoot, "escaping.md"));
  assert.throws(() => fixture.migrate(true), /shared-skills-symlink-target-untrusted/);
}));

test("shared Skills migration rejects directory-link cycles", () => withFixture((fixture) => {
  symlinkSync(fixture.sourceSkillsRoot, join(fixture.sourceSkillsRoot, "cycle"));
  assert.throws(() => fixture.migrate(true), /shared-skills-directory-cycle/);
}));

test("shared Skills migration rejects group-writable trusted roots before following their links", () => withFixture((fixture) => {
  const trusted = fixture.sharedSkillsTrustedRoot;
  chmodSync(trusted, 0o775);
  symlinkSync(join(trusted, "SKILL.md"), join(fixture.sourceSkillsRoot, "unsafe-root.md"));
  assert.throws(() => fixture.migrate(true), /shared-skills-trusted-root-unsafe/);
}));

test("shared Skills migration refuses credential-shaped source files", () => withFixture((fixture) => {
  writePrivate(join(fixture.sourceSkillsRoot, "fixture-skill", "oauth.json"), "{\"access_token\":\"not-copyable\"}");
  assert.throws(() => fixture.migrate(true), /unsafe-shared-skills-path/);
}));

test("shared Skills migration refuses a pre-existing account-local skills tree instead of overwriting it", () => withFixture((fixture) => {
  privateDirectory(join(fixture.otherCodexHome, "skills"));
  writePrivate(join(fixture.otherCodexHome, "skills", "untrusted.md"), "not the manager source");
  assert.throws(() => fixture.migrate(true), /candidate-account-shared-skills-already-exists/);
}));

test("unsafe or incomplete persisted envelopes remain visibly partial and never fabricate a complete empty transcript", () => withFixture((fixture) => {
  const result = fixture.migrate(true);
  assert.equal(result.status, "migrated");
  const canonical = JSON.parse(readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_FILE), "utf8")) as { conversations: Array<{ availability: string; segments: Array<{ state: string; turns: unknown[] }> }> };
  assert.equal(canonical.conversations[0]?.availability, "partial");
  assert.equal(canonical.conversations[0]?.segments[0]?.state, "committed");
  assert.deepEqual(canonical.conversations[0]?.segments[0]?.turns, []);
}, "unsafe"));

test("equal cross-account rollouts remain separate without a signed copy proof", () => withFixture((fixture) => {
  fixture.addCrossAccountCopy();
  const migrated = fixture.migrate(true);
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.conversationCount, 2);
  assert.equal(migrated.segmentCount, 2);
  assert.equal(existsSync(fixture.aliasesFile), false, "ordinary adoption never fabricates an alias artifact");
  const canonical = JSON.parse(readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_FILE), "utf8")) as {
    conversations: Array<{ rootNativeThreadId: string; segments: Array<{ opaqueAccountId: string; nativeThreadId: string }> }>;
  };
  assert.deepEqual(canonical.conversations.map((conversation) => conversation.rootNativeThreadId).sort(), [THREAD_A, THREAD_B]);
  assert.deepEqual(canonical.conversations.map((conversation) => conversation.segments[0]?.opaqueAccountId).sort(), [OWNER, OTHER]);
  assert.equal(canonical.conversations.every((conversation) => conversation.segments.length === 1), true);
}));

test("a receipt-bound signed cross-account copy becomes one canonical conversation with a private physical alias", () => withFixture((fixture) => {
  fixture.addCrossAccountCopy();
  assert.equal(fixture.completeLegacyAdoption().status, "adopted");
  fixture.writeSignedCrossAccountAlias();
  const migrated = fixture.migrate(true);
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.conversationCount, 1);
  assert.equal(migrated.segmentCount, 1);

  const canonicalText = readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_FILE), "utf8");
  const canonical = JSON.parse(canonicalText) as {
    conversations: Array<{ publicThreadId: string; rootNativeThreadId: string; segments: Array<{ opaqueAccountId: string; nativeThreadId: string }> }>;
  };
  const conversation = canonical.conversations[0]!;
  assert.equal(conversation.rootNativeThreadId, THREAD_A);
  assert.equal(conversation.segments.length, 1);
  assert.equal(conversation.segments[0]?.opaqueAccountId, OWNER);
  assert.equal(conversation.segments[0]?.nativeThreadId, THREAD_A);
  assert.doesNotMatch(canonicalText, new RegExp(THREAD_B));
  assert.doesNotMatch(canonicalText, /offline-copy-fixture-0001/);

  const privateEvidence = JSON.parse(readFileSync(join(fixture.globalRoot, CANONICAL_HISTORY_MIGRATION_SOURCES_FILE), "utf8")) as {
    references: Array<{ physicalAliases: Array<{ copyOperationId: string; opaqueAccountId: string; nativeThreadId: string }> }>;
  };
  assert.deepEqual(privateEvidence.references[0]?.physicalAliases.map((alias) => ({
    copyOperationId: alias.copyOperationId,
    opaqueAccountId: alias.opaqueAccountId,
    nativeThreadId: alias.nativeThreadId,
  })), [{
    copyOperationId: "offline-copy-fixture-0001",
    opaqueAccountId: OTHER,
    nativeThreadId: THREAD_B,
  }]);
  const core = new CanonicalHistoryStoreV1(fixture.globalRoot, () => Date.parse(COMPLETED_AT), (size) => Buffer.alloc(size, 1), () => `lh_${"z".repeat(43)}`);
  assert.doesNotMatch(JSON.stringify(core.logicalList()), new RegExp(`${THREAD_B}|offline-copy-fixture-0001`));
  assert.doesNotMatch(JSON.stringify(core.logicalRead(conversation.publicThreadId)), new RegExp(`${THREAD_B}|offline-copy-fixture-0001`));
}));

test("forged signed proof headers or members fail before migration journal work", () => {
  const cases: ReadonlyArray<readonly [string, Parameters<MigrationFixture["writeSignedCrossAccountAlias"]>[0], Parameters<MigrationFixture["writeSignedCrossAccountAlias"]>[1], RegExp]> = [
    ["receipt", {}, { adoptionReceiptFingerprint: `sha256:${"0".repeat(64)}` }, /history-adoption-aliases-proof-mismatch/],
    ["owner member", { sourceNativeThreadId: THREAD_B }, {}, /history-adoption-aliases-member-unproven/],
  ];
  for (const [label, recordOverrides, proofOverrides, expected] of cases) withFixture((fixture) => {
    fixture.addCrossAccountCopy();
    assert.equal(fixture.completeLegacyAdoption().status, "adopted", label);
    fixture.writeSignedCrossAccountAlias(recordOverrides, proofOverrides);
    assert.throws(() => fixture.migrate(true), expected, label);
    assert.equal(existsSync(fixture.globalRoot), false, label);
    assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false, label);
    assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-candidate-${TRANSACTION_ID}`)), false, label);
  });
});

test("a signed alias whose snapshot member, hash, or transcript digest diverges is quarantined before publication", () => {
  const cases: ReadonlyArray<readonly [string, Parameters<MigrationFixture["writeSignedCrossAccountAlias"]>[0], RegExp]> = [
    ["source digest", { sourceRolloutSha256: `sha256:${"0".repeat(64)}` }, /history-adoption-aliases-snapshot-digest-mismatch/],
    ["copy digest", { copyRolloutSha256: `sha256:${"0".repeat(64)}` }, /history-adoption-aliases-snapshot-digest-mismatch/],
    ["portable transcript digest", { portableTranscriptDigest: `sha256:${"0".repeat(64)}` }, /history-adoption-aliases-snapshot-digest-mismatch/],
    ["copy member", { copyNativeThreadId: "01a05548-cf93-7383-96ed-dc76ce3d1b3c" }, /history-adoption-aliases-snapshot-member-missing/],
  ];
  for (const [label, overrides, expected] of cases) withFixture((fixture) => {
    fixture.addCrossAccountCopy();
    assert.equal(fixture.completeLegacyAdoption().status, "adopted", label);
    fixture.writeSignedCrossAccountAlias(overrides);
    assert.throws(() => fixture.migrate(true), expected, label);
    assert.equal(existsSync(fixture.globalRoot), false, label);
    assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false, label);
    assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-quarantine-${TRANSACTION_ID}`)), false, label);
  });
});

test("a publication collision retains the fully verified candidate as private evidence", () => withFixture((fixture) => {
  const result = fixture.migrate(true, (phase) => {
    if (phase !== "candidate-preflight-ready") return;
    privateDirectory(fixture.globalRoot);
    writePrivate(join(fixture.globalRoot, "unrelated-owner-root"), "collision");
  });
  assert.equal(result.status, "collision-quarantined");
  assert.equal(readFileSync(join(fixture.globalRoot, "unrelated-owner-root"), "utf8"), "collision");
  const retained = join(fixture.root, `.global-v3.shared-history-quarantine-${TRANSACTION_ID}`, CANONICAL_HISTORY_FILE);
  assert.equal(runtimePreflightCanonicalHistoryStore(join(fixture.root, `.global-v3.shared-history-quarantine-${TRANSACTION_ID}`)).state, "ready");
  assert.doesNotMatch(readFileSync(retained, "utf8"), /OWNER_PRIVATE_TOKEN|access_token/);
}));

test("migration-owned first census blocks active legacy writers even when v2 adoption has a valid receipt", () => {
  const activeCensuses: ReadonlyArray<readonly [string, HistoryAdoptionCensus]> = [
    ["desktop app", { ...idleCensus(), app: "running" }],
    ["app-server", { ...idleCensus(), appServer: "running" }],
    ["open protected file", { ...idleCensus(), openFileCount: 1 }],
  ];
  for (const [label, observed] of activeCensuses) withFixture((fixture) => {
    assert.equal(fixture.completeLegacyAdoption().status, "adopted", label);
    let censusCalls = 0;
    assert.throws(() => fixture.migrate(true, undefined, () => {
      censusCalls += 1;
      return observed;
    }), /migration-legacy-layout-not-idle/, label);
    assert.equal(censusCalls, 2, label);
    assert.equal(existsSync(fixture.globalRoot), false, label);
    assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false, label);
    assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-candidate-${TRANSACTION_ID}`)), false, label);
  });
});

test("one exact canonical legacy root may supply both histories and SQLite without duplicate census paths", () => withFixture((fixture) => {
  fixture.combineLegacySources();
  const observedInputs: HistoryAdoptionCensusInput[] = [];
  const migrated = fixture.migrate(true, undefined, (input) => {
    observedInputs.push({ appPath: input.appPath, protectedPaths: [...input.protectedPaths] });
    return idleCensus();
  }, { legacySqliteRoot: fixture.legacyCodexRoot });
  assert.equal(migrated.status, "migrated");
  assert.equal(observedInputs.length > 0, true);
  const adoptionProtectedPaths = [
    fixture.legacyCodexRoot,
    fixture.accountsRoot,
    fixture.routerRoot,
  ];
  const migrationProtectedPaths = [
    ...adoptionProtectedPaths,
    join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
  ];
  assert.equal(observedInputs.every((input) => {
    const serialized = JSON.stringify(input.protectedPaths);
    return serialized === JSON.stringify(adoptionProtectedPaths)
      || serialized === JSON.stringify(migrationProtectedPaths);
  }), true);
}));

test("shared source allowance does not relax router or source nesting guards", () => withFixture((fixture) => {
  assert.throws(() => migrateSharedHistoryV2ToGlobalV3({
    ...fixture.input(),
    legacyCodexRoot: fixture.routerRoot,
    legacySqliteRoot: fixture.routerRoot,
  }), /candidate-path-overlap/);
  assert.throws(() => migrateSharedHistoryV2ToGlobalV3({
    ...fixture.input(),
    legacySqliteRoot: join(fixture.legacyCodexRoot, "sessions"),
  }), /candidate-path-overlap/);
}));

test("a running Tweakers desktop blocks initial v2 adoption materialization before its first write", () => withFixture((fixture) => {
  fixture.removeLegacyAdoptionPrerequisites();
  const observedInputs: HistoryAdoptionCensusInput[] = [];
  assert.throws(() => fixture.migrate(true, undefined, (input) => {
    observedInputs.push({ appPath: input.appPath, protectedPaths: [...input.protectedPaths] });
    return input.appPath === TWEAKERS_APP_PATH ? { ...idleCensus(), app: "running" } : idleCensus();
  }), /history-adoption-initialization-layout-not-idle/);
  assert.deepEqual(observedInputs, [
    {
      appPath: CHATGPT_APP_PATH,
      protectedPaths: [fixture.legacyCodexRoot, fixture.legacySqliteRoot, fixture.accountsRoot, fixture.routerRoot],
    },
    {
      appPath: TWEAKERS_APP_PATH,
      protectedPaths: [fixture.legacyCodexRoot, fixture.legacySqliteRoot, fixture.accountsRoot, fixture.routerRoot],
    },
  ]);
  assert.equal(existsSync(join(fixture.routerRoot, "history-adoption-initialization.v1.json")), false);
  assert.equal(existsSync(join(fixture.routerRoot, "history-adoption-intent.v1.json")), false);
  assert.equal(existsSync(join(fixture.routerRoot, "router-state.json")), false);
  assert.equal(existsSync(fixture.globalRoot), false);
}));

test("migration-owned publication census refuses a late Tweakers activation and retains candidate evidence", () => withFixture((fixture) => {
  assert.equal(fixture.completeLegacyAdoption().status, "adopted");
  const observedInputs: HistoryAdoptionCensusInput[] = [];
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase !== "candidate-preflight-ready") return;
    privateDirectory(fixture.globalRoot);
    writePrivate(join(fixture.globalRoot, "unrelated-owner-root"), "incumbent");
  }, (input) => {
    observedInputs.push({ appPath: input.appPath, protectedPaths: [...input.protectedPaths] });
    return observedInputs.length === 4 ? { ...idleCensus(), app: "running" } : idleCensus();
  }), /migration-legacy-layout-not-idle/);
  assert.deepEqual(observedInputs.map((input) => input.appPath), [
    CHATGPT_APP_PATH,
    TWEAKERS_APP_PATH,
    CHATGPT_APP_PATH,
    TWEAKERS_APP_PATH,
  ]);
  assert.equal(readFileSync(join(fixture.globalRoot, "unrelated-owner-root"), "utf8"), "incumbent");
  assert.equal(existsSync(join(fixture.globalRoot, CANONICAL_HISTORY_FILE)), false);
  const retainedRoot = join(fixture.root, `.global-v3.shared-history-quarantine-${TRANSACTION_ID}`);
  assert.equal(runtimePreflightCanonicalHistoryStore(retainedRoot).state, "ready");
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), true);
}));

test("the migration applies one composite two-desktop census to every initialization, adoption, and publication boundary", () => withFixture((fixture) => {
  fixture.removeLegacyAdoptionPrerequisites();
  const observedInputs: HistoryAdoptionCensusInput[] = [];
  const migrated = fixture.migrate(true, undefined, (input) => {
    observedInputs.push({ appPath: input.appPath, protectedPaths: [...input.protectedPaths] });
    return idleCensus();
  });
  assert.equal(migrated.status, "migrated");
  assert.deepEqual(observedInputs.map((input) => input.appPath), [
    CHATGPT_APP_PATH, TWEAKERS_APP_PATH,
    CHATGPT_APP_PATH, TWEAKERS_APP_PATH,
    CHATGPT_APP_PATH, TWEAKERS_APP_PATH,
    CHATGPT_APP_PATH, TWEAKERS_APP_PATH,
    CHATGPT_APP_PATH, TWEAKERS_APP_PATH,
    CHATGPT_APP_PATH, TWEAKERS_APP_PATH,
  ]);
  const adoptionProtectedPaths = [
    fixture.legacyCodexRoot,
    fixture.legacySqliteRoot,
    fixture.accountsRoot,
    fixture.routerRoot,
  ];
  const migrationProtectedPaths = [
    ...adoptionProtectedPaths,
    join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
  ];
  assert.equal(observedInputs.every((input) => {
    const serialized = JSON.stringify(input.protectedPaths);
    return serialized === JSON.stringify(adoptionProtectedPaths)
      || serialized === JSON.stringify(migrationProtectedPaths);
  }), true);
}));

test("a receipt-backed migration observes both exact desktop paths at each migration-owned census before publish", () => withFixture((fixture) => {
  assert.equal(fixture.completeLegacyAdoption().status, "adopted");
  const observedInputs: HistoryAdoptionCensusInput[] = [];
  const migrated = fixture.migrate(true, undefined, (input) => {
    observedInputs.push({ appPath: input.appPath, protectedPaths: [...input.protectedPaths] });
    return idleCensus();
  });
  assert.equal(migrated.status, "migrated");
  assert.deepEqual(observedInputs, [
    {
      appPath: CHATGPT_APP_PATH,
      protectedPaths: [
        fixture.legacyCodexRoot,
        fixture.legacySqliteRoot,
        fixture.accountsRoot,
        fixture.routerRoot,
        join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
      ],
    },
    {
      appPath: TWEAKERS_APP_PATH,
      protectedPaths: [
        fixture.legacyCodexRoot,
        fixture.legacySqliteRoot,
        fixture.accountsRoot,
        fixture.routerRoot,
        join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
      ],
    },
    {
      appPath: CHATGPT_APP_PATH,
      protectedPaths: [
        fixture.legacyCodexRoot,
        fixture.legacySqliteRoot,
        fixture.accountsRoot,
        fixture.routerRoot,
        join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
      ],
    },
    {
      appPath: TWEAKERS_APP_PATH,
      protectedPaths: [
        fixture.legacyCodexRoot,
        fixture.legacySqliteRoot,
        fixture.accountsRoot,
        fixture.routerRoot,
        join(fixture.capacityReviewRoot, SHARED_HISTORY_CAPACITY_RECEIPT_FILE),
      ],
    },
  ]);
}));

test("duplicate primary and Tweakers desktop paths fail before any census or migration write", () => withFixture((fixture) => {
  let censusCalls = 0;
  assert.throws(() => migrateSharedHistoryV2ToGlobalV3({
    ...fixture.input(),
    tweakersAppPath: CHATGPT_APP_PATH,
    apply: true,
  }, {
    census: () => {
      censusCalls += 1;
      return idleCensus();
    },
  }), /duplicate-desktop-app-path/);
  assert.equal(censusCalls, 0);
  assert.equal(existsSync(fixture.globalRoot), false);
  assert.equal(existsSync(join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`)), false);
}));

test("normal runtime startup has no installer migration entrypoint", () => {
  for (const source of [
    "packages/runtime/src/account-router/broker-host.ts",
    "packages/runtime/src/account-router/canonical-history.ts",
    "packages/runtime/src/codex-app-server-parent.ts",
  ]) {
    const text = readFileSync(join(process.cwd(), source), "utf8");
    assert.doesNotMatch(text, /shared-history-migration|migrateSharedHistoryV2ToGlobalV3|sharedHistoryMigrationCommand/, source);
  }
});

test("every durable migration boundary recovers without resuming a partial transaction", () => {
  const phases: readonly SharedHistoryMigrationPhase[] = [
    "journal-prepared",
    "legacy-adoption-complete",
    "pre-migration-snapshot-created",
    "candidate-copied",
    "candidate-canonicalized",
    "candidate-preflight-ready",
    "published",
  ];
  for (const phase of phases) withFixture((fixture) => {
    assert.throws(() => fixture.migrate(true, (current) => {
      if (current === phase) throw new SharedHistoryMigrationCrash(current);
    }), SharedHistoryMigrationCrash, phase);
    const journal = join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`);
    assert.equal(existsSync(journal), true, phase);
    const recovered = recoverSharedHistoryMigration(fixture.input());
    assert.equal(recovered.status, phase === "published" ? "already-published" : "recovered", phase);
    assert.equal(existsSync(fixture.globalRoot), phase === "published", phase);
  });
});

test("v2 journals bind the resolved definitions root and reject recovery with a different root", () => withFixture((fixture) => {
  fixture.writeSeparateDefinitionsRoot();
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "journal-prepared") throw new SharedHistoryMigrationCrash(phase);
  }, undefined, { legacyDefinitionsRoot: fixture.legacyDefinitionsRoot }), SharedHistoryMigrationCrash);
  const journalPath = join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
  assert.equal(journal.version, 2);
  assert.equal(journal.legacyDefinitionsRoot, fixture.legacyDefinitionsRoot);
  assert.throws(
    () => recoverSharedHistoryMigration(fixture.input()),
    /invalid-shared-history-migration-journal/,
  );
}));

test("strict v1 journals recover only through their implicit legacy CODEX_HOME definitions binding", () => withFixture((fixture) => {
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "journal-prepared") throw new SharedHistoryMigrationCrash(phase);
  }), SharedHistoryMigrationCrash);
  const journalPath = join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
  journal.version = 1;
  delete journal.legacyDefinitionsRoot;
  writePrivate(journalPath, `${JSON.stringify(journal)}\n`);

  const recovered = recoverSharedHistoryMigration(fixture.input());
  assert.equal(recovered.status, "recovered");
  const upgraded = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.legacyDefinitionsRoot, fixture.legacyCodexRoot);
}));

test("a v1 journal with a changed key is never silently interpreted as a v2 binding", () => withFixture((fixture) => {
  assert.throws(() => fixture.migrate(true, (phase) => {
    if (phase === "journal-prepared") throw new SharedHistoryMigrationCrash(phase);
  }), SharedHistoryMigrationCrash);
  const journalPath = join(fixture.root, `.global-v3.shared-history-migration-${TRANSACTION_ID}.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
  journal.version = 1;
  writePrivate(journalPath, `${JSON.stringify(journal)}\n`);
  assert.throws(
    () => recoverSharedHistoryMigration(fixture.input()),
    /invalid-shared-history-migration-journal/,
  );
}));

test("operator CLI has no root defaults and requires an explicit apply flag", () => withFixture((fixture) => {
  const printed: string[] = [];
  const migrationCalls: SharedHistoryMigrationInput[] = [];
  const recoveryCalls: SharedHistoryMigrationInput[] = [];
  const fakeResult = {
    status: "dry-run" as const,
    transactionId: null,
    sourceFingerprint: null,
    candidateFingerprint: null,
    conversationCount: 0,
    segmentCount: 0,
    sharedSkillsFingerprint: null,
    sharedSkillsTrustedRoots: [],
    sharedSkillsTrustedRootsFingerprint: null,
    sharedPluginsFingerprint: null,
    sharedPluginInventoryFingerprint: null,
    sharedPluginExclusionsFingerprint: null,
    sharedPluginIds: [],
    sharedPluginPackages: [],
    nextAction: "apply-offline-migration" as const,
  };
  const base = {
    legacyRouterRoot: fixture.routerRoot,
    legacyCodexRoot: fixture.legacyCodexRoot,
    legacySqliteRoot: fixture.legacySqliteRoot,
    globalRoot: fixture.globalRoot,
    app: CHATGPT_APP_PATH,
    tweakersApp: TWEAKERS_APP_PATH,
    sharedSkillsRoot: [fixture.sharedSkillsTrustedRoot, fixture.planSkillsTrustedRoot],
    sharedPluginInventory: fixture.sharedPluginInventory,
  };
  const dependencies = {
    migrate: (input: SharedHistoryMigrationInput) => { migrationCalls.push(input); return fakeResult; },
    recover: (input: SharedHistoryMigrationInput) => { recoveryCalls.push(input); return fakeResult; },
    print: (line: string) => printed.push(line),
  };
  sharedHistoryMigrationCommand("preview", base, dependencies);
  sharedHistoryMigrationCommand("apply", base, dependencies);
  sharedHistoryMigrationCommand("apply", {
    ...base,
    apply: true,
    capacityReceipt: join(fixture.root, "capacity-receipt.json"),
  }, dependencies);
  sharedHistoryMigrationCommand("recover", { ...base, transaction: TRANSACTION_ID }, dependencies);
  assert.equal(migrationCalls[0]?.apply, false);
  assert.equal(migrationCalls[1]?.apply, false);
  assert.equal(migrationCalls[2]?.apply, true);
  assert.equal(migrationCalls[2]?.capacityReceiptPath, join(fixture.root, "capacity-receipt.json"));
  assert.deepEqual(migrationCalls.map((input) => input.tweakersAppPath), [TWEAKERS_APP_PATH, TWEAKERS_APP_PATH, TWEAKERS_APP_PATH]);
  assert.deepEqual(recoveryCalls.map((input) => input.tweakersAppPath), [TWEAKERS_APP_PATH]);
  assert.deepEqual(migrationCalls.map((input) => input.sharedSkillsRoots), [
    [fixture.sharedSkillsTrustedRoot, fixture.planSkillsTrustedRoot],
    [fixture.sharedSkillsTrustedRoot, fixture.planSkillsTrustedRoot],
    [fixture.sharedSkillsTrustedRoot, fixture.planSkillsTrustedRoot],
  ]);
  assert.deepEqual(migrationCalls.map((input) => input.sharedPluginInventory), [
    fixture.sharedPluginInventory,
    fixture.sharedPluginInventory,
    fixture.sharedPluginInventory,
  ]);
  assert.deepEqual(migrationCalls.map((input) => input.legacyDefinitionsRoot), [undefined, undefined, undefined]);
  sharedHistoryMigrationCommand("preview", {
    ...base,
    legacyDefinitionsRoot: fixture.legacyCodexRoot,
  }, dependencies);
  assert.equal(migrationCalls.at(-1)?.legacyDefinitionsRoot, fixture.legacyCodexRoot);
  assert.doesNotMatch(printed.join("\n"), new RegExp(fixture.routerRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(() => sharedHistoryMigrationCommand("preview", { globalRoot: fixture.globalRoot }, dependencies), /--legacy-router-root/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, legacyRouterRoot: "relative" }, dependencies), /--legacy-router-root must be an exact absolute path/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, tweakersApp: undefined }, dependencies), /--tweakers-app/);
  assert.throws(() => sharedHistoryMigrationCommand("recover", { ...base, tweakersApp: undefined, transaction: TRANSACTION_ID }, dependencies), /--tweakers-app/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, tweakersApp: "relative" }, dependencies), /--tweakers-app must be an exact absolute path/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, sharedSkillsRoot: undefined }, dependencies), /--shared-skills-root must be supplied at least once/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, sharedSkillsRoot: "relative" }, dependencies), /--shared-skills-root must be an exact absolute path/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, sharedPluginInventory: undefined }, dependencies), /--shared-plugin-inventory/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, sharedPluginInventory: "relative" }, dependencies), /--shared-plugin-inventory must be an exact absolute path/);
  assert.throws(() => sharedHistoryMigrationCommand("preview", { ...base, legacyDefinitionsRoot: "relative" }, dependencies), /--legacy-definitions-root must be an exact absolute path/);
}));

function withFixture(run: (fixture: MigrationFixture) => void, mode: "complete" | "unsafe" = "complete"): void {
  const fixture = new MigrationFixture(mode);
  try { run(fixture); }
  finally { fixture.dispose(); }
}

function routerState(config: { protocolFingerprint: string; accounts: readonly { opaqueAccountId: string; weight: number }[] }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolFingerprint: config.protocolFingerprint,
    epoch: 1,
    threadOwners: {},
    pendingThreadOwners: {},
    ledger: Object.fromEntries(config.accounts.map((account) => [account.opaqueAccountId, {
      completedInputTokens: 0,
      completedOutputTokens: 0,
      reservedRequestCost: 0,
      weight: account.weight,
      assignedThreadCount: 0,
    }])),
    reservations: [],
    accountEligibility: { [OWNER]: "validating", [OTHER]: "validating" },
    correlations: [],
    stagedDisable: null,
  };
}

function idleCensus(): HistoryAdoptionCensus {
  return { app: "idle", main: "idle", appServer: "idle", openFileCount: 0, observedAt: FIXTURE_TIME };
}

function rolloutFixtureText(threadId: string, mode: "complete" | "unsafe" = "complete"): string {
  const unsafeUser = mode === "unsafe"
    ? { text_elements: [{ type: "text", text: "Fixture user text" }, { type: "attachment", ref: "https://example.invalid/fixture" }] }
    : { message: "Fixture user text" };
  const lines = [
    { type: "session_meta", payload: { id: threadId, timestamp: FIXTURE_TIME, title: "Fixture transcript" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: TURN_A, started_at: STARTED_AT } },
    { type: "turn_context", payload: { turn_id: TURN_A } },
    { type: "event_msg", payload: { type: "user_message", turn_id: TURN_A, item_id: "item-user", ...unsafeUser } },
    { type: "response_item", payload: { turn_id: TURN_A, item: { type: "message", role: "user", id: "item-user", content: [{ type: "input_text", text: "Fixture user text" }] } } },
    { type: "event_msg", payload: { type: "agent_message", turn_id: TURN_A, message: { id: "item-assistant", text: "Fixture assistant text" } } },
    { type: "response_item", payload: { turn_id: TURN_A, item: { type: "message", role: "assistant", id: "item-assistant", content: [{ type: "output_text", text: "Fixture assistant text" }] } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: TURN_A, completed_at: COMPLETED_AT, duration: 1 } },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function portableFixtureTranscriptDigest(): `sha256:${string}` {
  return sha256Fingerprint(JSON.stringify([[
    { kind: "user", text: "Fixture user text" },
    { kind: "assistant", text: "Fixture assistant text" },
  ]]));
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function makeFixtureTreeWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeFixtureTreeWritable(join(path, name));
    return;
  }
  chmodSync(path, 0o600);
}

function writePrivate(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

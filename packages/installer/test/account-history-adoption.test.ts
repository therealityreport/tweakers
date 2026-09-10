import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACCOUNT_HISTORY_ADOPTION_INITIALIZATION_JOURNAL_FILE,
  ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE,
  ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE,
  ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
  CODEX_HISTORY_ARTIFACTS,
  OFFICIAL_CODEX_DATABASES,
  adoptAccountHistory,
  canonicalJson,
  createHistoryAdoptionAliases,
  createHistoryAdoptionIntent,
  createHistoryAdoptionOwners,
  createHistoryAdoptionReceipt,
  historyAdoptionCensusInput,
  historyAdoptionPoolFingerprint,
  historyAdoptionReceiptFingerprint,
  historyAdoptionIntentFingerprint,
  historyAdoptionProcessCensus,
  historyAdoptionThreadOwnersFingerprint,
  inspectCompletedLegacyV2HistoryAdoption,
  initializeMissingLegacyV2HistoryAdoption,
  parseHistoryAdoptionIntent,
  parseHistoryAdoptionAliases,
  parseHistoryAdoptionReceipt,
  routerConfigFingerprint,
  type HistoryAdoptionCensus,
  type HistoryAdoptionPhase,
  type HistoryAdoptionSqliteAdapter,
  type HistoryAdoptionSqliteRow,
  verifyHistoryAdoptionIntent,
  verifyHistoryAdoptionAliases,
  verifyHistoryAdoptionReceipt,
} from "../src/account-history-adoption";

const OWNER = `ar_${"a".repeat(43)}` as const;
const OTHER = `ar_${"b".repeat(43)}` as const;
const THREAD_A = "01a05546-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_B = "01a05547-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_C = "01a05548-cf93-7383-96ed-dc76ce3d1b3c";
const THREAD_D = "01a05549-cf93-7383-96ed-dc76ce3d1b3c";
const FIXED_TIME = "2026-08-31T12:00:00.000Z";

class SyntheticSqlite implements HistoryAdoptionSqliteAdapter {
  readonly backupCalls: Array<{ source: string; destination: string }> = [];
  readonly integrityCalls: string[] = [];
  readonly rewriteCalls: Array<{ path: string; updates: readonly HistoryAdoptionSqliteRow[] }> = [];
  readonly rows = new Map<string, HistoryAdoptionSqliteRow[]>();
  readonly broken = new Set<string>();

  backup(source: string, destination: string): void {
    this.backupCalls.push({ source, destination });
    copyFileSync(source, destination);
    const rows = this.rows.get(source);
    if (rows) this.rows.set(destination, structuredClone(rows));
  }

  integrityCheck(path: string): "ok" {
    this.integrityCalls.push(path);
    if (this.broken.has(path)) throw new Error("synthetic integrity failure");
    return "ok";
  }

  readThreads(path: string): readonly HistoryAdoptionSqliteRow[] {
    return structuredClone(this.rows.get(path) ?? []);
  }

  rewriteThreadRolloutPaths(path: string, updates: readonly HistoryAdoptionSqliteRow[]): void {
    this.rewriteCalls.push({ path, updates: structuredClone(updates) });
    const rows = structuredClone(this.rows.get(path) ?? []);
    const byId = new Map(updates.map((update) => [update.id, update.rolloutPath]));
    for (const row of rows) if (byId.has(row.id)) row.rolloutPath = byId.get(row.id) ?? null;
    this.rows.set(path, rows);
    writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
  }
}

class Fixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "tweaker-account-history-")));
  readonly routerRoot = join(this.root, "router");
  readonly accountsRoot = join(this.routerRoot, "accounts");
  readonly sourceCodexRoot = join(this.root, "legacy-codex");
  readonly sourceSqliteRoot = join(this.root, "legacy-sqlite");
  readonly sqlite = new SyntheticSqlite();
  readonly secret = Buffer.alloc(32, 7);
  private sequence = 0;
  census: HistoryAdoptionCensus = idleCensus();

  constructor() {
    for (const directory of [this.routerRoot, this.accountsRoot, this.sourceCodexRoot, this.sourceSqliteRoot]) privateDirectory(directory);
    this.writeRouterFiles();
    this.writeOwnerHome();
    this.writeHistory();
    this.writeDatabases();
  }

  get ownerRoot(): string { return join(this.accountsRoot, OWNER); }
  get ownerCodexHome(): string { return join(this.ownerRoot, "codex-home"); }
  get ownerSqliteHome(): string { return join(this.ownerRoot, "sqlite-home"); }
  get configFile(): string { return join(this.routerRoot, "account-router-config.json"); }
  get stateFile(): string { return join(this.routerRoot, "router-state.json"); }
  get intentFile(): string { return join(this.routerRoot, "history-adoption-intent.v1.json"); }
  get receiptFile(): string { return join(this.routerRoot, "history-adoption-receipt.v1.json"); }
  get ownersFile(): string { return join(this.routerRoot, ACCOUNT_HISTORY_ADOPTION_OWNERS_FILE); }
  get sourceStateFile(): string { return join(this.sourceSqliteRoot, "state_5.sqlite"); }
  get sourceRollout(): string { return join(this.sourceCodexRoot, "sessions", "primary.jsonl"); }

  config(): ReturnType<Fixture["configValue"]> {
    return JSON.parse(readFileSync(this.configFile, "utf8")) as ReturnType<Fixture["configValue"]>;
  }

  run(apply = true, beforePhase?: (phase: HistoryAdoptionPhase) => void) {
    return adoptAccountHistory({
      sourceCodexRoot: this.sourceCodexRoot,
      sourceSqliteRoot: this.sourceSqliteRoot,
      routerRoot: this.routerRoot,
      appPath: "/synthetic/ChatGPT.app",
      apply,
    }, {
      sqlite: this.sqlite,
      census: () => structuredClone(this.census),
      now: () => FIXED_TIME,
      randomId: () => this.nextId(),
      beforePhase,
    });
  }

  snapshot(...roots: string[]): string {
    return shaTree(roots.length === 0 ? [this.sourceCodexRoot, this.sourceSqliteRoot, this.routerRoot] : roots);
  }

  setRows(rows: HistoryAdoptionSqliteRow[]): void {
    this.sqlite.rows.set(this.sourceStateFile, structuredClone(rows));
    writeFileSync(this.sourceStateFile, JSON.stringify(rows), { mode: 0o600 });
  }

  dispose(): void {
    this.secret.fill(0);
    rmSync(this.root, { recursive: true, force: true });
  }

  private writeRouterFiles(): void {
    writeFileSync(join(this.routerRoot, "control-secret.v1"), this.secret, { mode: 0o600 });
    const config = this.configValue();
    writeFileSync(this.configFile, JSON.stringify(config), { mode: 0o600 });
    const intent = createHistoryAdoptionIntent({
      protocolFingerprint: config.protocolFingerprint,
      accountOpaqueIds: [OWNER, OTHER],
      configGeneration: config.generation,
      configFingerprint: config.fingerprint,
      legacyOwnerOpaqueAccountId: OWNER,
      createdAt: FIXED_TIME,
    }, this.secret);
    writeFileSync(this.intentFile, JSON.stringify(intent), { mode: 0o600 });
    writeFileSync(this.stateFile, JSON.stringify(routerState(config)), { mode: 0o600 });
  }

  private configValue() {
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
    return {
      ...bare,
      fingerprint: routerConfigFingerprint(bare),
      updatedAt: FIXED_TIME,
    };
  }

  private writeOwnerHome(): void {
    privateDirectory(this.ownerRoot);
    privateDirectory(this.ownerCodexHome);
    privateDirectory(this.ownerSqliteHome);
    writeFileSync(join(this.ownerCodexHome, "auth.json"), "{\"opaque\":true}", { mode: 0o600 });
    writeFileSync(join(this.ownerCodexHome, "config.toml"), "", { mode: 0o600 });
  }

  private writeHistory(): void {
    privateDirectory(join(this.sourceCodexRoot, "sessions"));
    writeFileSync(this.sourceRollout, `${JSON.stringify({ type: "session_meta", payload: { id: THREAD_A } })}\n{"event":true}\n`, { mode: 0o600 });
    writeFileSync(join(this.sourceCodexRoot, "session_index.jsonl"), "{}\n", { mode: 0o600 });
  }

  private writeDatabases(): void {
    for (const name of OFFICIAL_CODEX_DATABASES) {
      const file = join(this.sourceSqliteRoot, name);
      writeFileSync(file, name === "state_5.sqlite" ? JSON.stringify([{ id: THREAD_A, rolloutPath: this.sourceRollout }]) : `${name}-bytes`, { mode: 0o600 });
    }
    this.sqlite.rows.set(this.sourceStateFile, [{ id: THREAD_A, rolloutPath: this.sourceRollout }]);
  }

  private nextId(): string {
    this.sequence += 1;
    return `${String(this.sequence).padStart(8, "0")}-0000-0000-0000-000000000000`;
  }
}

test("intent, receipt, and owners artifacts are strict, HMAC bound, and canonical", () => {
  const secret = Buffer.alloc(32, 3);
  try {
    const intent = createHistoryAdoptionIntent({
      protocolFingerprint: ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT,
      accountOpaqueIds: [OTHER, OWNER],
      configGeneration: 1,
      configFingerprint: `sha256:${"e".repeat(64)}`,
      legacyOwnerOpaqueAccountId: OWNER,
      createdAt: FIXED_TIME,
    }, secret);
    assert.equal(intent.poolFingerprint, historyAdoptionPoolFingerprint(intent.protocolFingerprint, [OWNER, OTHER]));
    assert.equal(verifyHistoryAdoptionIntent(parseHistoryAdoptionIntent(Buffer.from(JSON.stringify(intent))), secret), true);
    assert.equal(verifyHistoryAdoptionIntent({ ...intent, configGeneration: 2 }, secret), false);
    assert.throws(() => parseHistoryAdoptionIntent(Buffer.from(JSON.stringify({ ...intent, extra: true }))), /invalid-history-adoption-intent/);

    const threadOwnersFingerprint = historyAdoptionThreadOwnersFingerprint([THREAD_A], OWNER);
    const receipt = createHistoryAdoptionReceipt({
      protocolFingerprint: intent.protocolFingerprint,
      poolFingerprint: intent.poolFingerprint,
      intentFingerprint: `sha256:${"f".repeat(64)}`,
      legacyOwnerOpaqueAccountId: OWNER,
      sourceFingerprint: `sha256:${"1".repeat(64)}`,
      destinationFingerprint: `sha256:${"2".repeat(64)}`,
      databases: OFFICIAL_CODEX_DATABASES.map((name) => ({ name, present: false, sha256: null, bytes: 0, integrity: null })),
      histories: CODEX_HISTORY_ARTIFACTS.map((name) => ({ name, present: false, sha256: null, bytes: 0, fileCount: 0 })),
      importedThreadCount: 1,
      threadOwnersFingerprint,
      backupFingerprint: `sha256:${"3".repeat(64)}`,
      adoptedAt: FIXED_TIME,
    }, secret);
    assert.equal(verifyHistoryAdoptionReceipt(parseHistoryAdoptionReceipt(Buffer.from(JSON.stringify(receipt))), secret), true);
    assert.equal(verifyHistoryAdoptionReceipt({ ...receipt, sourceFingerprint: `sha256:${"4".repeat(64)}` }, secret), false);

    const manyIds = Array.from({ length: 2_200 }, (_, index) => `${index.toString(16).padStart(8, "0")}-0000-7000-9000-000000000000`);
    const owners = createHistoryAdoptionOwners({
      protocolFingerprint: intent.protocolFingerprint,
      poolFingerprint: intent.poolFingerprint,
      legacyOwnerOpaqueAccountId: OWNER,
      threadIds: manyIds,
      threadOwnersFingerprint: historyAdoptionThreadOwnersFingerprint(manyIds, OWNER),
      adoptedAt: FIXED_TIME,
    }, secret);
    assert.equal(owners.threadIds.length, manyIds.length);
    assert.equal(Buffer.byteLength(JSON.stringify(owners), "utf8") > 64 * 1024, true, "owners evidence is bounded at router-state scale, not receipt scale");
  } finally {
    secret.fill(0);
  }
});

test("dry run performs zero writes and only returns redacted adoption evidence", () => withFixture((fixture) => {
  const before = fixture.snapshot();
  const result = fixture.run(false);
  assert.equal(result.status, "dry-run");
  assert.equal(result.nextAction, "review-and-apply");
  assert.equal(fixture.snapshot(), before);
  assert.deepEqual(readdirSync(fixture.accountsRoot).sort(), [OWNER]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(OWNER));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.sourceCodexRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));

test("a signed legacy intent-only layout previews without writes, then journals and publishes only deterministic state", () => withFixture((fixture) => {
  rmSync(fixture.stateFile);
  const originalIntent = JSON.parse(readFileSync(fixture.intentFile, "utf8"));
  const beforePreview = fixture.snapshot();
  let previewCensuses = 0;
  const preview = initializeMissingLegacyV2HistoryAdoption({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceSqliteRoot,
    routerRoot: fixture.routerRoot,
    appPath: "/synthetic/ChatGPT.app",
  }, {
    census: () => {
      previewCensuses += 1;
      return idleCensus();
    },
    now: () => FIXED_TIME,
  });
  assert.equal(preview.status, "initialization-required");
  assert.equal(preview.intentFingerprint, historyAdoptionIntentFingerprint(originalIntent));
  assert.equal(preview.nextAction, "apply-offline-initialization");
  assert.equal(previewCensuses, 0);
  assert.equal(fixture.snapshot(), beforePreview);

  let applyCensuses = 0;
  const phases: string[] = [];
  const initialized = initializeMissingLegacyV2HistoryAdoption({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceSqliteRoot,
    routerRoot: fixture.routerRoot,
    appPath: "/synthetic/ChatGPT.app",
    apply: true,
  }, {
    census: () => {
      applyCensuses += 1;
      return idleCensus();
    },
    now: () => FIXED_TIME,
    beforePhase: (phase) => phases.push(phase),
  });
  assert.equal(initialized.status, "initialized");
  assert.equal(initialized.nextAction, "continue-adoption");
  assert.equal(applyCensuses, 2);
  assert.deepEqual(phases, ["initialization-journal-prepared", "initialization-router-state-published", "initialization-complete"]);
  const journal = JSON.parse(readFileSync(join(fixture.routerRoot, "history-adoption-initialization.v1.json"), "utf8")) as { intent: unknown };
  assert.deepEqual(journal.intent, originalIntent);
  assert.equal(existsSync(fixture.stateFile), true);
  assert.equal(fixture.run(true).status, "adopted");
}));

test("every durable initialization boundary recovers from the committed disk layout without duplicate mutation", () => {
  const faultPhases = [
    "initialization-journal-prepared",
    "initialization-intent-published",
    "initialization-router-state-published",
    "initialization-complete",
  ] as const;

  for (const faultPhase of faultPhases) withFixture((fixture) => {
    rmSync(fixture.intentFile);
    rmSync(fixture.stateFile);
    const configBefore = readFileSync(fixture.configFile);
    const immutableBefore = fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot, fixture.ownerRoot);
    const observed: string[] = [];

    assert.throws(() => initializeMissingLegacyV2HistoryAdoption({
      sourceCodexRoot: fixture.sourceCodexRoot,
      sourceSqliteRoot: fixture.sourceSqliteRoot,
      routerRoot: fixture.routerRoot,
      appPath: "/synthetic/ChatGPT.app",
      apply: true,
    }, {
      census: () => idleCensus(),
      now: () => FIXED_TIME,
      beforePhase: (phase) => {
        observed.push(phase);
        if (phase === faultPhase) throw new Error(`synthetic initialization crash ${faultPhase}`);
      },
    }), /synthetic initialization crash/);

    assert.equal(observed.includes(faultPhase), true, faultPhase);
    assert.equal(existsSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_INITIALIZATION_JOURNAL_FILE)), true, faultPhase);
    assert.deepEqual(readFileSync(fixture.configFile), configBefore, faultPhase);
    assert.equal(fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot, fixture.ownerRoot), immutableBefore, faultPhase);
    assert.deepEqual(readdirSync(fixture.accountsRoot).sort(), [OWNER], faultPhase);

    // A fresh call has no in-memory state from the interrupted initializer;
    // it must rebuild solely from the journal and committed configuration.
    const recovered = initializeMissingLegacyV2HistoryAdoption({
      sourceCodexRoot: fixture.sourceCodexRoot,
      sourceSqliteRoot: fixture.sourceSqliteRoot,
      routerRoot: fixture.routerRoot,
      appPath: "/synthetic/ChatGPT.app",
      apply: true,
    }, { census: () => idleCensus(), now: () => FIXED_TIME });
    assert.equal(recovered.status === "initialized" || recovered.status === "ready", true, faultPhase);
    assert.deepEqual(JSON.parse(readFileSync(fixture.stateFile, "utf8")), routerState(fixture.config()), faultPhase);
    assert.equal(fixture.run(false).status, "dry-run", faultPhase);

    const retry = initializeMissingLegacyV2HistoryAdoption({
      sourceCodexRoot: fixture.sourceCodexRoot,
      sourceSqliteRoot: fixture.sourceSqliteRoot,
      routerRoot: fixture.routerRoot,
      appPath: "/synthetic/ChatGPT.app",
      apply: true,
    }, { census: () => idleCensus(), now: () => FIXED_TIME });
    assert.equal(retry.status, "ready", faultPhase);
    assert.deepEqual(readFileSync(fixture.configFile), configBefore, faultPhase);
    assert.equal(fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot, fixture.ownerRoot), immutableBefore, faultPhase);
    assert.deepEqual(readdirSync(fixture.accountsRoot).sort(), [OWNER], faultPhase);
  });
});

test("initialization restart rejects a journal when its committed config bytes have drifted", () => withFixture((fixture) => {
  rmSync(fixture.intentFile);
  rmSync(fixture.stateFile);
  assert.throws(() => initializeMissingLegacyV2HistoryAdoption({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceSqliteRoot,
    routerRoot: fixture.routerRoot,
    appPath: "/synthetic/ChatGPT.app",
    apply: true,
  }, {
    census: () => idleCensus(),
    now: () => FIXED_TIME,
    beforePhase: (phase) => {
      if (phase === "initialization-journal-prepared") throw new Error("synthetic initialization crash");
    },
  }), /synthetic initialization crash/);

  const config = fixture.config();
  writeFileSync(fixture.configFile, JSON.stringify({ ...config, updatedAt: "2026-08-31T12:00:01.000Z" }), { mode: 0o600 });
  assert.throws(() => initializeMissingLegacyV2HistoryAdoption({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceSqliteRoot,
    routerRoot: fixture.routerRoot,
    appPath: "/synthetic/ChatGPT.app",
    apply: true,
  }, { census: () => idleCensus(), now: () => FIXED_TIME }), /history-adoption-initialization-config-mismatch/);
  assert.equal(existsSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_INITIALIZATION_JOURNAL_FILE)), true);
  assert.equal(existsSync(fixture.intentFile), false);
  assert.equal(existsSync(fixture.stateFile), false);
}));

test("intent-only initialization fails closed for incomplete, tampered, drifting, or newly evidenced layouts", () => {
  const inputFor = (fixture: Fixture, apply = false) => ({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceSqliteRoot,
    routerRoot: fixture.routerRoot,
    appPath: "/synthetic/ChatGPT.app",
    apply,
  });
  const dependencies = { census: () => idleCensus(), now: () => FIXED_TIME };

  withFixture((fixture) => {
    rmSync(fixture.intentFile);
    assert.throws(() => initializeMissingLegacyV2HistoryAdoption(inputFor(fixture), dependencies), /history-adoption-initialization-incomplete-without-journal/);
  });
  withFixture((fixture) => {
    rmSync(fixture.stateFile);
    const intent = JSON.parse(readFileSync(fixture.intentFile, "utf8")) as Record<string, unknown>;
    writeFileSync(fixture.intentFile, JSON.stringify({ ...intent, hmac: `hmac-sha256:${"0".repeat(64)}` }), { mode: 0o600 });
    assert.throws(() => initializeMissingLegacyV2HistoryAdoption(inputFor(fixture), dependencies), /history-adoption-intent-hmac-invalid/);
  });
  withFixture((fixture) => {
    rmSync(fixture.stateFile);
    let censuses = 0;
    assert.throws(() => initializeMissingLegacyV2HistoryAdoption(inputFor(fixture, true), {
      census: () => {
        censuses += 1;
        if (censuses === 2) {
          const config = fixture.config();
          writeFileSync(fixture.configFile, JSON.stringify({ ...config, updatedAt: "2026-08-31T12:00:01.000Z" }), { mode: 0o600 });
        }
        return idleCensus();
      },
      now: () => FIXED_TIME,
    }), /history-adoption-initialization-config-changed-before-journal/);
    assert.equal(existsSync(join(fixture.routerRoot, "history-adoption-initialization.v1.json")), false);
  });
  withFixture((fixture) => {
    rmSync(fixture.stateFile);
    let censuses = 0;
    assert.throws(() => initializeMissingLegacyV2HistoryAdoption(inputFor(fixture, true), {
      census: () => {
        censuses += 1;
        if (censuses === 2) {
          const intent = JSON.parse(readFileSync(fixture.intentFile, "utf8"));
          writeFileSync(fixture.intentFile, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
        }
        return idleCensus();
      },
      now: () => FIXED_TIME,
    }), /history-adoption-initialization-intent-changed-before-journal/);
    assert.equal(existsSync(join(fixture.routerRoot, "history-adoption-initialization.v1.json")), false);
  });
  withFixture((fixture) => {
    rmSync(fixture.stateFile);
    let censuses = 0;
    assert.throws(() => initializeMissingLegacyV2HistoryAdoption(inputFor(fixture, true), {
      census: () => {
        censuses += 1;
        if (censuses === 2) writeFileSync(fixture.ownersFile, "unexpected adoption evidence", { mode: 0o600 });
        return idleCensus();
      },
      now: () => FIXED_TIME,
    }), /history-adoption-initialization-intent-only-layout-invalid/);
    assert.equal(existsSync(join(fixture.routerRoot, "history-adoption-initialization.v1.json")), false);
  });
});

test("history adoption census roots retain order while deduplicating the exact shared source root", () => withFixture((fixture) => {
  assert.deepEqual(historyAdoptionCensusInput({
    sourceCodexRoot: fixture.sourceCodexRoot,
    sourceSqliteRoot: fixture.sourceCodexRoot,
    routerRoot: fixture.routerRoot,
    appPath: "/synthetic/ChatGPT.app",
  }).protectedPaths, [
    fixture.sourceCodexRoot,
    fixture.accountsRoot,
    fixture.routerRoot,
  ]);
}));

test("process census ignores exactly the installer PID while another matching PID still blocks", () => {
  const appPath = "/Applications/ChatGPT.app";
  const selfPid = 41001;
  const self = `${selfPid} /usr/local/bin/tweaker adopt-account-history --app ${appPath} --app-server`;
  assert.deepEqual(historyAdoptionProcessCensus(self, appPath, selfPid), {
    app: "idle",
    main: "idle",
    appServer: "idle",
  });

  const otherPid = 41002;
  const other = `${otherPid} ${appPath}/Contents/MacOS/ChatGPT --codex-app-server`;
  assert.deepEqual(historyAdoptionProcessCensus(`${self}\n${other}`, appPath, selfPid), {
    app: "running",
    main: "running",
    appServer: "running",
  });
});

test("apply refuses a live app, router, or protected open file before any write", () => {
  for (const census of [
    { ...idleCensus(), app: "running" as const },
    { ...idleCensus(), main: "running" as const },
    { ...idleCensus(), appServer: "running" as const },
    { ...idleCensus(), openFileCount: 1 },
  ]) withFixture((fixture) => {
    fixture.census = census;
    const before = fixture.snapshot();
    assert.throws(() => fixture.run(true), /app-or-router-not-idle/);
    assert.equal(fixture.snapshot(), before);
    assert.equal(readdirSync(fixture.accountsRoot).filter((name) => name.startsWith(".history-adoption")).length, 0);
  });
});

test("only the allowlisted histories and six database backups are adopted; WAL is never copied", () => withFixture((fixture) => {
  writeFileSync(join(fixture.sourceCodexRoot, "auth.json"), "not copied", { mode: 0o600 });
  privateDirectory(join(fixture.sourceCodexRoot, "plugins"));
  writeFileSync(join(fixture.sourceCodexRoot, "plugins", "private.json"), "not copied", { mode: 0o600 });
  writeFileSync(join(fixture.sourceSqliteRoot, "state_5.sqlite-wal"), "wal is not copied", { mode: 0o600 });
  writeFileSync(join(fixture.sourceSqliteRoot, "state_5.sqlite-shm"), "shm is not copied", { mode: 0o600 });
  const sourceBefore = fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot);
  const result = fixture.run(true);
  assert.equal(result.status, "adopted");
  assert.equal(fixture.sqlite.backupCalls.length, OFFICIAL_CODEX_DATABASES.length);
  assert.equal(fixture.sqlite.backupCalls.some((call) => /-(?:wal|shm)$/.test(call.source)), false);
  assert.equal(existsSync(join(fixture.ownerCodexHome, "auth.json")), true);
  assert.equal(existsSync(join(fixture.ownerCodexHome, "plugins")), false);
  assert.equal(existsSync(join(fixture.ownerCodexHome, "sessions", "primary.jsonl")), true);
  assert.equal(existsSync(join(fixture.ownerSqliteHome, "state_5.sqlite-wal")), false);
  assert.equal(fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot), sourceBefore);
}));

test("source symlinks, hardlinks, and rollout path escapes fail closed before candidate creation", () => {
  const scenarios: Array<(fixture: Fixture) => void> = [
    (fixture) => symlinkSync(fixture.sourceRollout, join(fixture.sourceCodexRoot, "sessions", "escape.jsonl")),
    (fixture) => linkSync(fixture.sourceRollout, join(fixture.sourceCodexRoot, "sessions", "hardlink.jsonl")),
    (fixture) => fixture.setRows([{ id: THREAD_A, rolloutPath: join(fixture.root, "outside.jsonl") }]),
  ];
  for (const mutate of scenarios) withFixture((fixture) => {
    mutate(fixture);
    const before = fixture.snapshot();
    assert.throws(() => fixture.run(true), /history-symlink-refused|history-file-not-private-regular|rollout-path-escape-refused/);
    assert.equal(fixture.snapshot(), before);
    assert.equal(readdirSync(fixture.accountsRoot).filter((name) => name.startsWith(".history-adoption")).length, 0);
  });
});

test("all six databases are integrity checked and state rollout paths are rewritten only in the candidate", () => withFixture((fixture) => {
  const sourceBefore = readFileSync(fixture.sourceStateFile, "utf8");
  const result = fixture.run(true);
  assert.equal(result.status, "adopted");
  for (const name of OFFICIAL_CODEX_DATABASES) {
    assert.equal(fixture.sqlite.integrityCalls.some((path) => path.endsWith(name) && path.startsWith(fixture.sourceSqliteRoot)), true, name);
    assert.equal(fixture.sqlite.integrityCalls.filter((path) => path.endsWith(name)).length >= 4, true, `${name} source and candidate integrity`);
  }
  assert.equal(fixture.sqlite.rewriteCalls.length, 1);
  // The synthetic adapter tracks the candidate pathname before its atomic
  // directory rename; the update itself must target the final owner path.
  assert.equal(fixture.sqlite.rewriteCalls[0]?.updates[0]?.rolloutPath, join(fixture.ownerCodexHome, "sessions", "primary.jsonl"));
  assert.equal(readFileSync(fixture.sourceStateFile, "utf8"), sourceBefore);
}));

test("tampered intent and owner/pool changes are refused without exposing private IDs", () => {
  withFixture((fixture) => {
    const intent = JSON.parse(readFileSync(fixture.intentFile, "utf8")) as Record<string, unknown>;
    intent.hmac = "hmac-sha256:" + "0".repeat(64);
    writeFileSync(fixture.intentFile, JSON.stringify(intent), { mode: 0o600 });
    assert.throws(() => fixture.run(true), /history-adoption-intent-hmac-invalid/);
  });
  withFixture((fixture) => {
    const config = fixture.config() as Record<string, unknown>;
    const accounts = config.accounts as Array<Record<string, unknown>>;
    accounts[0] = { ...accounts[0], opaqueAccountId: OTHER };
    writeFileSync(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
    const before = fixture.snapshot();
    assert.throws(() => fixture.run(true), /invalid-router-config|history-adoption-intent-does-not-match-current-pool/);
    assert.equal(fixture.snapshot(), before);
  });
});

test("a pre-existing thread owner collision is refused before any candidate or state write", () => withFixture((fixture) => {
  const state = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as Record<string, unknown>;
  state.threadOwners = { [THREAD_A]: OTHER };
  writeFileSync(fixture.stateFile, JSON.stringify(state), { mode: 0o600 });
  const before = fixture.snapshot();
  assert.throws(() => fixture.run(true), /history-adoption-thread-owner-collision/);
  assert.equal(fixture.snapshot(), before);
}));

test("receipt is published last, retained backup/source remain unchanged, and exact rerun is idempotent", () => withFixture((fixture) => {
  const events: string[] = [];
  const sourceBefore = fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot);
  const ownerBefore = fixture.snapshot(fixture.ownerRoot);
  const result = fixture.run(true, (phase) => events.push(phase));
  assert.equal(result.status, "adopted");
  assert.equal(events.at(-1), "before-receipt-publication");
  assert.equal(existsSync(fixture.receiptFile), true);
  assert.equal(existsSync(fixture.ownersFile), true);
  assert.equal(fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot), sourceBefore);
  const backups = readdirSync(fixture.accountsRoot).filter((name) => name.startsWith(".history-adoption-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fixture.snapshot(join(fixture.accountsRoot, backups[0])), ownerBefore);
  const afterFirst = fixture.snapshot();
  fixture.census = { ...idleCensus(), app: "running" };
  const rerun = fixture.run(true);
  assert.equal(rerun.status, "already-adopted");
  assert.equal(fixture.snapshot(), afterFirst);
}));

test("completed v2 proof is HMAC-bound and refuses any non-v2 router configuration", () => withFixture((fixture) => {
  const adopted = fixture.run(true);
  assert.equal(adopted.status, "adopted");
  const proof = inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot);
  assert.equal(proof.legacyOwnerOpaqueAccountId, OWNER);
  assert.deepEqual(proof.owners.threadIds, [THREAD_A]);
  assert.equal(proof.receipt.importedThreadCount, 1);

  const v2 = fixture.config();
  const config = {
    ...v2,
    schemaVersion: 3 as const,
    policy: "quota_aware_v2" as const,
  };
  config.fingerprint = routerConfigFingerprint(config);
  writeFileSync(fixture.configFile, JSON.stringify(config), { mode: 0o600 });
  assert.throws(() => inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot), /legacy-v2-config-required/);
}));

test("optional alias provenance is canonical, receipt-bound, and never inferred from a copy-like record", () => withFixture((fixture) => {
  assert.equal(fixture.run(true).status, "adopted");
  const completed = inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot);
  assert.equal(completed.aliases, null);
  const aliases = createHistoryAdoptionAliases({
    protocolFingerprint: completed.intent.protocolFingerprint,
    poolFingerprint: completed.intent.poolFingerprint,
    intentFingerprint: historyAdoptionIntentFingerprint(completed.intent),
    adoptionReceiptFingerprint: historyAdoptionReceiptFingerprint(completed.receipt),
    createdAt: FIXED_TIME,
    aliases: [{
      copyOperationId: "offline-copy-fixture-0001",
      sourceOpaqueAccountId: OWNER,
      sourceNativeThreadId: THREAD_A,
      sourceRolloutSha256: `sha256:${"1".repeat(64)}`,
      copyOpaqueAccountId: OTHER,
      copyNativeThreadId: THREAD_B,
      copyRolloutSha256: `sha256:${"2".repeat(64)}`,
      portableTranscriptDigest: `sha256:${"3".repeat(64)}`,
    }],
  }, fixture.secret);
  assert.equal(verifyHistoryAdoptionAliases(parseHistoryAdoptionAliases(Buffer.from(JSON.stringify(aliases))), fixture.secret), true);
  assert.equal(verifyHistoryAdoptionAliases({ ...aliases, adoptionReceiptFingerprint: `sha256:${"4".repeat(64)}` }, fixture.secret), false);
  writeFileSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE), JSON.stringify(aliases), { mode: 0o600 });
  assert.deepEqual(inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot).aliases, aliases);

  const cyclic = [
    aliases.aliases[0]!,
    {
      ...aliases.aliases[0]!,
      copyOperationId: "offline-copy-fixture-0002",
      sourceOpaqueAccountId: OTHER,
      sourceNativeThreadId: THREAD_B,
      sourceRolloutSha256: `sha256:${"4".repeat(64)}`,
      copyOpaqueAccountId: OWNER,
      copyNativeThreadId: THREAD_A,
      copyRolloutSha256: `sha256:${"5".repeat(64)}`,
    },
  ];
  assert.throws(() => createHistoryAdoptionAliases({
    protocolFingerprint: completed.intent.protocolFingerprint,
    poolFingerprint: completed.intent.poolFingerprint,
    intentFingerprint: historyAdoptionIntentFingerprint(completed.intent),
    adoptionReceiptFingerprint: historyAdoptionReceiptFingerprint(completed.receipt),
    createdAt: FIXED_TIME,
    aliases: cyclic,
  }, fixture.secret), /invalid-history-adoption-aliases/);

  writeFileSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE), JSON.stringify({
    ...aliases,
    hmac: `hmac-sha256:${"0".repeat(64)}`,
  }), { mode: 0o600 });
  assert.throws(() => inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot), /history-adoption-aliases-hmac-invalid/);
}));

test("alias records reject forged receipt or members plus malformed ordering and graph edges", () => withFixture((fixture) => {
  assert.equal(fixture.run(true).status, "adopted");
  const completed = inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot);
  const baseRecord = {
    copyOperationId: "offline-copy-fixture-0001",
    sourceOpaqueAccountId: OWNER,
    sourceNativeThreadId: THREAD_A,
    sourceRolloutSha256: `sha256:${"1".repeat(64)}` as const,
    copyOpaqueAccountId: OTHER,
    copyNativeThreadId: THREAD_B,
    copyRolloutSha256: `sha256:${"2".repeat(64)}` as const,
    portableTranscriptDigest: `sha256:${"3".repeat(64)}` as const,
  };
  const create = (records: readonly typeof baseRecord[], receiptFingerprint = historyAdoptionReceiptFingerprint(completed.receipt)) =>
    createHistoryAdoptionAliases({
      protocolFingerprint: completed.intent.protocolFingerprint,
      poolFingerprint: completed.intent.poolFingerprint,
      intentFingerprint: historyAdoptionIntentFingerprint(completed.intent),
      adoptionReceiptFingerprint: receiptFingerprint,
      aliases: records,
      createdAt: FIXED_TIME,
    }, fixture.secret);

  const valid = create([baseRecord]);
  const forgedReceipt = create([baseRecord], `sha256:${"4".repeat(64)}` as const);
  writeFileSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE), JSON.stringify(forgedReceipt), { mode: 0o600 });
  assert.throws(() => inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot), /history-adoption-aliases-proof-mismatch/);

  const forgedMember = create([{ ...baseRecord, sourceNativeThreadId: THREAD_B }]);
  writeFileSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE), JSON.stringify(forgedMember), { mode: 0o600 });
  assert.throws(() => inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot), /history-adoption-aliases-member-unproven/);

  const second = {
    ...baseRecord,
    copyOperationId: "offline-copy-fixture-0002",
    sourceNativeThreadId: THREAD_C,
    sourceRolloutSha256: `sha256:${"4".repeat(64)}` as const,
    copyNativeThreadId: THREAD_D,
    copyRolloutSha256: `sha256:${"5".repeat(64)}` as const,
    portableTranscriptDigest: `sha256:${"6".repeat(64)}` as const,
  };
  const ordered = create([baseRecord, second]);
  assert.throws(() => parseHistoryAdoptionAliases(Buffer.from(JSON.stringify({
    ...ordered,
    aliases: [...ordered.aliases].reverse(),
  }))), /invalid-history-adoption-aliases/);
  assert.throws(() => create([{ ...baseRecord, copyOperationId: "too-short" }]), /invalid-history-adoption-aliases/);
  assert.throws(() => create([baseRecord, { ...second, copyOperationId: baseRecord.copyOperationId }]), /invalid-history-adoption-aliases/);
  assert.throws(() => create([baseRecord, { ...second, sourceNativeThreadId: THREAD_A }]), /invalid-history-adoption-aliases/);
  assert.throws(() => create([baseRecord, {
    ...second,
    sourceOpaqueAccountId: OTHER,
    sourceNativeThreadId: THREAD_B,
    copyOpaqueAccountId: OWNER,
    copyNativeThreadId: THREAD_A,
  }]), /invalid-history-adoption-aliases/);

  writeFileSync(join(fixture.routerRoot, ACCOUNT_HISTORY_ADOPTION_ALIASES_FILE), JSON.stringify(valid), { mode: 0o600 });
  assert.deepEqual(inspectCompletedLegacyV2HistoryAdoption(fixture.routerRoot).aliases, valid);
}));

test("every publication-boundary failure restores owner/router state and retains failed candidates", () => {
  const phases: HistoryAdoptionPhase[] = [
    "after-candidate-created",
    "after-owner-backup",
    "after-owner-promoted",
    "after-router-state-backup",
    "after-router-state-promoted",
    "after-owners-manifest-published",
    "before-receipt-publication",
  ];
  for (const phase of phases) withFixture((fixture) => {
    const sourceBefore = fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot);
    const ownerBefore = fixture.snapshot(fixture.ownerRoot);
    const stateBefore = readFileSync(fixture.stateFile, "utf8");
    assert.throws(() => fixture.run(true, (current) => {
      if (current === phase) throw new Error(`synthetic failure ${phase}`);
    }), /unexpected-history-adoption-failure/);
    assert.equal(fixture.snapshot(fixture.sourceCodexRoot, fixture.sourceSqliteRoot), sourceBefore, phase);
    assert.equal(fixture.snapshot(fixture.ownerRoot), ownerBefore, phase);
    assert.equal(readFileSync(fixture.stateFile, "utf8"), stateBefore, phase);
    assert.equal(existsSync(fixture.receiptFile), false, phase);
    assert.equal(readdirSync(fixture.accountsRoot).some((name) => name.startsWith(".history-adoption-failed-")), true, phase);
  });
});

function withFixture(run: (fixture: Fixture) => void): void {
  const fixture = new Fixture();
  try { run(fixture); }
  finally { fixture.dispose(); }
}

function routerState(config: ReturnType<Fixture["configValue"]>) {
  const ledger = Object.fromEntries(config.accounts.map((account) => [account.opaqueAccountId, {
    completedInputTokens: 0,
    completedOutputTokens: 0,
    reservedRequestCost: 0,
    weight: account.weight,
    assignedThreadCount: 0,
  }]));
  return {
    schemaVersion: 1,
    protocolFingerprint: config.protocolFingerprint,
    epoch: 1,
    threadOwners: {},
    pendingThreadOwners: {},
    ledger,
    reservations: [],
    accountEligibility: { [OWNER]: "validating", [OTHER]: "validating" },
    correlations: [],
    stagedDisable: null,
  };
}

function idleCensus(): HistoryAdoptionCensus {
  return { app: "idle", main: "idle", appServer: "idle", openFileCount: 0, observedAt: FIXED_TIME };
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function shaTree(roots: readonly string[]): string {
  const entries: Array<{ root: number; path: string; bytes: string }> = [];
  const visit = (rootIndex: number, root: string, local: string): void => {
    for (const name of readdirSync(root).sort()) {
      const target = join(root, name);
      const next = local ? `${local}/${name}` : name;
      if (existsSync(target) && readdirIfDirectory(target)) {
        visit(rootIndex, target, next);
      } else {
        entries.push({ root: rootIndex, path: next, bytes: readFileSync(target).toString("base64") });
      }
    }
  };
  roots.forEach((root, index) => visit(index, root, ""));
  return createHash("sha256").update(canonicalJson(entries), "utf8").digest("hex");
}

function readdirIfDirectory(path: string): boolean {
  try { readdirSync(path); return true; }
  catch { return false; }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectNativeTransferCompatibilityV2,
  NativeTransferCoordinatorV1,
  Sqlite3NativeCatalogDbV1,
  probeNativeTransferCapabilityV1,
  readCommittedNativeThreadInventoryV1,
  type NativeCatalogCursorV1,
  type NativeCatalogDbV1,
  type NativeProjectionInsertV1,
  type NativeThreadRowV1,
  type NativeThreadRowPageV1,
  type NativeThreadsSchemaV1,
  type NativeTransferCoordinatorOptionsV1,
} from "../../src/account-router/native-transfer";
import type { OpaqueAccountId } from "../../src/account-router/types";

const ACCOUNT_A = ("ar_" + "a".repeat(43)) as OpaqueAccountId;
const ACCOUNT_B = ("ar_" + "b".repeat(43)) as OpaqueAccountId;
const ACCOUNT_C = ("ar_" + "c".repeat(43)) as OpaqueAccountId;
const THREAD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const schema: NativeThreadsSchemaV1 = {
  columns: [
    ["id", "text"], ["rollout_path", "text"], ["created_at", "text"], ["updated_at", "text"],
    ["source", "text"], ["model_provider", "text"], ["cwd", "text"], ["title", "text"],
    ["sandbox_policy", "text"], ["approval_mode", "text"], ["history_mode", "text"], ["archived", "integer"],
    ["updated_at_ms", "integer"], ["preview", "text"],
  ].map(([name, affinity]) => ({ name: name!, affinity: affinity as "text" | "integer", notNull: false, hasDefault: true, primaryKey: name === "id" })),
};

interface Fixture {
  root: string;
  stateRoot: string;
  sourceHome: string;
  targetHome: string;
  sourceSqlite: string;
  targetSqlite: string;
  sourceRollout: string;
  db: FakeDb;
  coordinator: NativeTransferCoordinatorV1;
}

class FakeDb implements NativeCatalogDbV1 {
  readonly rows = new Map<string, Map<string, NativeThreadRowV1>>();

  inspectSchema(_dbPath: string): Promise<NativeThreadsSchemaV1> {
    return Promise.resolve(schema);
  }

  async scanEligibleRows(dbPath: string, after?: NativeCatalogCursorV1): Promise<NativeThreadRowPageV1> {
    const rows = [...(this.rows.get(dbPath)?.values() ?? [])]
      .sort((left, right) => (left.updatedAtMs ?? 0) - (right.updatedAtMs ?? 0) || left.threadId.localeCompare(right.threadId))
      .filter((row) => !after || (row.updatedAtMs ?? 0) > after.updatedAtMs
        || ((row.updatedAtMs ?? 0) === after.updatedAtMs && row.threadId > after.threadId));
    return { rows: rows.map(cloneRow), nextCursor: null };
  }

  async readExact(dbPath: string, threadId: string): Promise<NativeThreadRowV1 | null> {
    const row = this.rows.get(dbPath)?.get(threadId);
    return row ? cloneRow(row) : null;
  }

  async insertProjection(input: NativeProjectionInsertV1): Promise<"inserted" | "already_exact" | "conflict"> {
    const target = this.rows.get(input.targetDbPath) ?? new Map<string, NativeThreadRowV1>();
    this.rows.set(input.targetDbPath, target);
    const existing = target.get(input.source.threadId);
    const projected = rowWithPath(input.source, input.targetPath);
    if (existing) return equalRow(existing, projected) ? "already_exact" : "conflict";
    target.set(input.source.threadId, projected);
    return "inserted";
  }
}

function fixture(mode: "paginated" | "legacy" = "legacy", options: Pick<NativeTransferCoordinatorOptionsV1, "catalogThreadCensus" | "exactThreadCensus"> = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-transfer-test-")));
  chmodSync(root, 0o700);
  const stateRoot = privateDirectory(join(root, "state"));
  const sourceHome = privateDirectory(join(root, "source-home"));
  const targetHome = privateDirectory(join(root, "target-home"));
  const sourceSqlite = privateDirectory(join(root, "source-sqlite"));
  const targetSqlite = privateDirectory(join(root, "target-sqlite"));
  const sourceDir = privateDirectory(join(sourceHome, "sessions", "2026", "09", "05"));
  const sourceRollout = join(sourceDir, "rollout-2026-09-05-" + THREAD_ID + ".jsonl");
  privateFile(sourceRollout, "fixture rollout\n");
  const db = new FakeDb();
  const sourceDb = join(sourceSqlite, "state_5.sqlite");
  const targetDb = join(targetSqlite, "state_5.sqlite");
  db.rows.set(sourceDb, new Map([[THREAD_ID, nativeRow(sourceRollout, mode)]]));
  db.rows.set(targetDb, new Map());
  const coordinator = new NativeTransferCoordinatorV1({
    stateRoot,
    accounts: [
      { accountId: ACCOUNT_A, codexHome: sourceHome, sqliteHome: sourceSqlite },
      { accountId: ACCOUNT_B, codexHome: targetHome, sqliteHome: targetSqlite },
    ],
    primaryAccountId: ACCOUNT_A,
    db,
    capabilityProbe: async () => ({ state: "ready", writerLockProtocol: "shared_thread_writer_locks_v1", paginatedHistory: true }),
    bindingPreflight: () => true,
    writerCensus: () => true,
    exactThreadCensus: () => "clear",
    ...options,
  });
  return { root, stateRoot, sourceHome, targetHome, sourceSqlite, targetSqlite, sourceRollout, db, coordinator };
}

function nativeRow(path: string, historyMode: "paginated" | "legacy"): NativeThreadRowV1 {
  const values = {
    id: THREAD_ID,
    rollout_path: path,
    created_at: "2026-09-05T12:00:00.000Z",
    updated_at: "2026-09-05T12:00:01.000Z",
    source: "desktop",
    model_provider: "openai",
    cwd: "/private/workspace",
    title: "Fixture",
    sandbox_policy: "workspace-write",
    approval_mode: "on-request",
    history_mode: historyMode,
    archived: 0,
    updated_at_ms: 1,
    preview: "private fixture",
  };
  return { threadId: THREAD_ID, rolloutPath: path, historyMode, archived: 0, updatedAt: values.updated_at, updatedAtMs: 1, values };
}

function rowWithPath(source: NativeThreadRowV1, path: string): NativeThreadRowV1 {
  return {
    ...source,
    rolloutPath: path,
    values: { ...source.values, rollout_path: path },
  };
}

function cloneRow(row: NativeThreadRowV1): NativeThreadRowV1 {
  return { ...row, values: { ...row.values } };
}

function equalRow(left: NativeThreadRowV1, right: NativeThreadRowV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function privateFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function ready(fixture: Fixture): Promise<void> {
  assert.equal((await fixture.coordinator.probeCapability()).state, "ready");
  assert.equal(fixture.coordinator.provisionSharedWriterLocks().state, "ready");
}

test("shared writer-lock projection is an exact relative symlink and drift fails closed", async () => {
  const value = fixture();
  await ready(value);
  const primary = join(value.sourceHome, "thread-writer-locks");
  const secondary = join(value.targetHome, "thread-writer-locks");
  assert.equal(lstatSync(primary).isDirectory(), true);
  assert.equal(lstatSync(secondary).isSymbolicLink(), true);
  assert.equal(readlinkSync(secondary), "../source-home/thread-writer-locks");
  assert.equal(value.coordinator.preflightSharedWriterLocks().state, "ready");

  // A relative link with the wrong target never gets repaired implicitly.
  rmSync(secondary);
  symlinkSync("../source-home", secondary, "dir");
  assert.equal(value.coordinator.preflightSharedWriterLocks().state, "collision");
});

test("native mode-0755 writer-lock directories remain valid under a sealed account home", async () => {
  const value = fixture();
  assert.equal((await value.coordinator.probeCapability()).state, "ready");
  const primary = join(value.sourceHome, "thread-writer-locks");
  mkdirSync(primary, { mode: 0o755 });
  chmodSync(primary, 0o755);
  assert.equal(value.coordinator.provisionSharedWriterLocks().state, "ready");
  assert.equal(value.coordinator.preflightSharedWriterLocks().state, "ready");

  const conversion = fixture();
  assert.equal((await conversion.coordinator.probeCapability()).state, "ready");
  const secondary = join(conversion.targetHome, "thread-writer-locks");
  mkdirSync(secondary, { mode: 0o755 });
  chmodSync(secondary, 0o755);
  assert.equal(conversion.coordinator.convertOfflineWriterLockDirectory(ACCOUNT_B, {
    offlinePreflight: () => true,
  }).state, "ready");
  assert.equal(lstatSync(secondary).isSymbolicLink(), true);
  assert.equal(conversion.coordinator.preflightSharedWriterLocks().state, "ready");
});

test("an idle secondary can join an existing live primary lock namespace without changing the primary", async () => {
  for (const scenario of ["ready", "busy-secondary", "missing-primary", "primary-drift", "absent-secondary"] as const) {
    const f = fixture();
    const primary = join(f.sourceHome, "thread-writer-locks");
    const secondary = join(f.targetHome, "thread-writer-locks");
    if (scenario !== "missing-primary") privateDirectory(primary);
    if (scenario !== "absent-secondary") privateDirectory(secondary);
    const before = scenario === "missing-primary" ? null : lstatSync(primary);
    const coordinator = new NativeTransferCoordinatorV1({
      stateRoot: f.stateRoot,
      accounts: [
        { accountId: ACCOUNT_A, codexHome: f.sourceHome, sqliteHome: f.sourceSqlite },
        { accountId: ACCOUNT_B, codexHome: f.targetHome, sqliteHome: f.targetSqlite },
      ],
      primaryAccountId: ACCOUNT_A, db: f.db,
      capabilityProbe: async () => ({ state: "ready", writerLockProtocol: "shared_thread_writer_locks_v1", paginatedHistory: true }),
      bindingPreflight: () => true,
      writerCensus: () => false,
    });
    await coordinator.probeCapability();
    assert.equal(coordinator.convertOfflineWriterLockDirectory(ACCOUNT_B, { offlinePreflight: () => true }).state, "busy");
    let calls = 0;
    const result = coordinator.convertIdleSecondaryWriterLockDirectory(ACCOUNT_B, { offlinePreflight: () => {
      calls++;
      if (scenario === "primary-drift" && calls === 2) {
        renameSync(primary, primary + ".retained");
        privateDirectory(primary);
      }
      return scenario !== "busy-secondary";
    } });
    if (scenario === "ready" || scenario === "absent-secondary") {
      assert.equal(result.state, "ready");
      assert.equal(lstatSync(primary).ino, before!.ino);
      assert.equal(lstatSync(secondary).isSymbolicLink(), true);
      assert.equal(realpathSync(secondary), primary);
    } else {
      assert.notEqual(result.state, "ready");
      assert.equal(lstatSync(secondary).isDirectory(), true);
      if (scenario === "missing-primary") assert.throws(() => lstatSync(primary), { code: "ENOENT" });
    }
  }
});

test("native mode-0644 state_5.sqlite is accepted only directly below a sealed SQLite home", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-transfer-sqlite-mode-")));
  chmodSync(root, 0o700);
  const sqliteHome = privateDirectory(join(root, "sqlite-home"));
  const databasePath = join(sqliteHome, "state_5.sqlite");
  execFileSync("/usr/bin/sqlite3", [databasePath, "CREATE TABLE threads (id TEXT);"], { stdio: "ignore" });
  chmodSync(databasePath, 0o644);
  const database = new Sqlite3NativeCatalogDbV1();
  assert.equal((await database.inspectSchema(databasePath)).columns[0]?.name, "id");
  chmodSync(sqliteHome, 0o755);
  assert.equal((await database.inspectSchema(databasePath)).columns[0]?.name, "id", "native existing home mode is retained");

  const unexpectedPath = join(sqliteHome, "other.sqlite");
  execFileSync("/usr/bin/sqlite3", [unexpectedPath, "CREATE TABLE threads (id TEXT);"], { stdio: "ignore" });
  chmodSync(unexpectedPath, 0o644);
  await assert.rejects(database.inspectSchema(unexpectedPath), /native sqlite path is unsafe/);

  chmodSync(databasePath, 0o664);
  await assert.rejects(database.inspectSchema(databasePath), /native sqlite path is unsafe/);
});

test("co-located native account homes support idle secondary locks and catalog reads without sharing homes between accounts", async () => {
  const f = fixture();
  chmodSync(f.sourceHome, 0o755);
  chmodSync(f.targetHome, 0o755);
  privateDirectory(join(f.sourceHome, "thread-writer-locks"));
  privateDirectory(join(f.targetHome, "thread-writer-locks"));
  f.db.rows.set(join(f.sourceHome, "state_5.sqlite"), f.db.rows.get(join(f.sourceSqlite, "state_5.sqlite"))!);
  f.db.rows.set(join(f.targetHome, "state_5.sqlite"), new Map());
  const options = {
    stateRoot: f.stateRoot, primaryAccountId: ACCOUNT_A, db: f.db,
    accounts: [
      { accountId: ACCOUNT_A, codexHome: f.sourceHome, sqliteHome: f.sourceHome },
      { accountId: ACCOUNT_B, codexHome: f.targetHome, sqliteHome: f.targetHome },
    ],
    capabilityProbe: async () => ({ state: "ready" as const, writerLockProtocol: "shared_thread_writer_locks_v1" as const, paginatedHistory: true as const }),
    bindingPreflight: () => true, writerCensus: () => false,
  };
  const coordinator = new NativeTransferCoordinatorV1(options);
  await coordinator.probeCapability();
  const inode = lstatSync(join(f.sourceHome, "thread-writer-locks")).ino;
  assert.equal(coordinator.convertIdleSecondaryWriterLockDirectory(ACCOUNT_B, { offlinePreflight: () => true }).state, "ready");
  assert.deepEqual(await coordinator.reconcileCatalog({ project: false }), { state: "ready", scanned: 1, projected: 0, collisions: 0 });
  assert.equal(lstatSync(join(f.sourceHome, "thread-writer-locks")).ino, inode);
  assert.equal(lstatSync(f.sourceHome).mode & 0o777, 0o755);
  assert.throws(() => new NativeTransferCoordinatorV1({ ...options, accounts: [options.accounts[0]!,
    { accountId: ACCOUNT_B, codexHome: f.sourceHome, sqliteHome: f.sourceHome }] }), /account homes are invalid/);
  chmodSync(f.sourceHome, 0o775);
  assert.equal(coordinator.preflightSharedWriterLocks().state, "unavailable", "other-user write permission remains unsafe");
  chmodSync(f.sourceHome, 0o755);
  chmodSync(f.stateRoot, 0o755);
  assert.throws(() => new NativeTransferCoordinatorV1(options), /catalog state root is unsafe/);
});

test("account extension accepts additions only and provisions the new absent lock projection", async () => {
  const value = fixture();
  await ready(value);
  const thirdHome = privateDirectory(join(value.root, "third-home"));
  const thirdSqlite = privateDirectory(join(value.root, "third-sqlite"));
  assert.deepEqual(value.coordinator.updateAccounts([
    { accountId: ACCOUNT_A, codexHome: value.sourceHome, sqliteHome: value.sourceSqlite },
    { accountId: ACCOUNT_B, codexHome: value.targetHome, sqliteHome: value.targetSqlite },
    { accountId: ACCOUNT_C, codexHome: thirdHome, sqliteHome: thirdSqlite },
  ]), { state: "ready", addedAccountIds: [ACCOUNT_C] });
  assert.equal(value.coordinator.provisionSharedWriterLocks().state, "ready");
  assert.equal(lstatSync(join(thirdHome, "thread-writer-locks")).isSymbolicLink(), true);
  assert.deepEqual(value.coordinator.updateAccounts([
    { accountId: ACCOUNT_A, codexHome: value.sourceHome, sqliteHome: value.sourceSqlite },
    { accountId: ACCOUNT_B, codexHome: value.targetHome, sqliteHome: value.targetSqlite },
  ]), { state: "unavailable", reason: "account_set_invalid" });
});

test("legacy rows preserve their mode while catalog projection creates an exact hard link", async () => {
  const value = fixture("legacy");
  await ready(value);
  const reconciled = await value.coordinator.reconcileCatalog();
  assert.deepEqual(reconciled, { state: "ready", scanned: 1, projected: 1, collisions: 0 });
  const targetPath = join(value.targetHome, "sessions", "2026", "09", "05", "rollout-2026-09-05-" + THREAD_ID + ".jsonl");
  const sourceIdentity = lstatSync(value.sourceRollout);
  const targetIdentity = lstatSync(targetPath);
  assert.equal(sourceIdentity.dev, targetIdentity.dev);
  assert.equal(sourceIdentity.ino, targetIdentity.ino);
  assert.equal((await value.db.readExact(join(value.targetSqlite, "state_5.sqlite"), THREAD_ID))?.historyMode, "legacy");
  assert.equal(value.coordinator.isCommittedProjection(THREAD_ID, ACCOUNT_B), true);

  const inventory = readCommittedNativeThreadInventoryV1({ stateRoot: value.stateRoot });
  assert.equal(inventory.state, "ready");
  if (inventory.state === "ready") assert.deepEqual(inventory.threadIds, [THREAD_ID]);
});

test("native mode-0755 session trees and mode-0644 rollouts preserve catalog projection and same-ID proof", async () => {
  const value = fixture();
  chmodSync(value.sourceHome, 0o755);
  chmodSync(value.targetHome, 0o755);
  const sourceTree = [
    join(value.sourceHome, "sessions"),
    join(value.sourceHome, "sessions", "2026"),
    join(value.sourceHome, "sessions", "2026", "09"),
    join(value.sourceHome, "sessions", "2026", "09", "05"),
  ];
  const targetTree = [
    join(value.targetHome, "sessions"),
    join(value.targetHome, "sessions", "2026"),
    join(value.targetHome, "sessions", "2026", "09"),
    join(value.targetHome, "sessions", "2026", "09", "05"),
  ];
  mkdirSync(targetTree.at(-1)!, { recursive: true, mode: 0o755 });
  for (const path of [...sourceTree, ...targetTree]) chmodSync(path, 0o755);
  chmodSync(value.sourceRollout, 0o644);

  await ready(value);
  assert.deepEqual(await value.coordinator.reconcileCatalog(), {
    state: "ready", scanned: 1, projected: 1, collisions: 0,
  });
  const targetPath = join(value.targetHome, "sessions", "2026", "09", "05", "rollout-2026-09-05-" + THREAD_ID + ".jsonl");
  const source = lstatSync(value.sourceRollout);
  const target = lstatSync(targetPath);
  assert.equal(source.mode & 0o777, 0o644);
  assert.equal(target.mode & 0o777, 0o644);
  assert.equal(source.dev, target.dev);
  assert.equal(source.ino, target.ino);

  const prepared = await value.coordinator.prepareSameThreadTransfer({
    operationId: "native-native-mode-transfer",
    threadId: THREAD_ID,
    sourceAccountId: ACCOUNT_A,
    targetAccountId: ACCOUNT_B,
  });
  assert.equal(prepared.state, "ready");
  if (prepared.state !== "ready") return;
  value.coordinator.markResumeDispatching(prepared.operationId);
  assert.deepEqual(value.coordinator.settleResume(prepared.operationId, {
    thread: { id: THREAD_ID, path: prepared.targetPath },
  }), {
    state: "proved",
    operationId: prepared.operationId,
    accountId: ACCOUNT_B,
    threadId: THREAD_ID,
    path: prepared.targetPath,
  });
});

test("existing target path with a different inode is retained and cataloged as a collision", async () => {
  const value = fixture();
  await ready(value);
  const targetDir = privateDirectory(join(value.targetHome, "sessions", "2026", "09", "05"));
  const targetPath = join(targetDir, "rollout-2026-09-05-" + THREAD_ID + ".jsonl");
  privateFile(targetPath, "unowned target\n");
  const original = lstatSync(targetPath);

  const reconciled = await value.coordinator.reconcileCatalog();
  assert.equal(reconciled.state, "collision");
  const after = lstatSync(targetPath);
  assert.equal(after.ino, original.ino);
  assert.equal(after.size, original.size);
  assert.equal(value.coordinator.ownerForThread(THREAD_ID), null);
  const catalogPath = join(value.stateRoot, "native-catalog.v1.json");
  const catalogBefore = lstatSync(catalogPath, { bigint: true });
  assert.equal((await value.coordinator.reconcileCatalog()).state, "collision");
  assert.equal(lstatSync(catalogPath, { bigint: true }).mtimeNs, catalogBefore.mtimeNs,
    "unchanged collision observations do not rewrite the complete catalog every poll");
});

test("same-ID preparation settles only an exact resume response and only target_resumed is recoverable", async () => {
  const value = fixture();
  await ready(value);
  assert.equal((await value.coordinator.reconcileCatalog()).state, "ready");
  const operationId = "native-transfer-1";
  const prepared = await value.coordinator.prepareSameThreadTransfer({
    operationId,
    threadId: THREAD_ID,
    sourceAccountId: ACCOUNT_A,
    targetAccountId: ACCOUNT_B,
  });
  assert.equal(prepared.state, "ready");
  if (prepared.state !== "ready") return;
  value.coordinator.markResumeDispatching(operationId);
  assert.deepEqual(value.coordinator.settleResume(operationId, { thread: { id: THREAD_ID, path: prepared.targetPath } }), {
    state: "proved", operationId, accountId: ACCOUNT_B, threadId: THREAD_ID, path: prepared.targetPath,
  });
  assert.equal(value.coordinator.pendingWriterCommits().length, 1);
  assert.deepEqual(value.coordinator.reconcileRemoteWriter(new Map([
    [ACCOUNT_A, []], [ACCOUNT_B, [{ threadId: THREAD_ID, path: prepared.targetPath }]],
  ])), { state: "busy", updatedThreadIds: [], collisionThreadIds: [] });
  value.coordinator.commitWriter(operationId);
  assert.deepEqual(value.coordinator.pendingWriterCommits(), []);
  assert.equal(value.coordinator.ownerForThread(THREAD_ID), ACCOUNT_B);
});

test("provenance-only scans work before lock provisioning while a nonempty journal blocks cold restoration", async () => {
  const value = fixture();
  assert.equal((await value.coordinator.probeCapability()).state, "ready");
  assert.deepEqual(await value.coordinator.reconcileCatalog({ project: false }), {
    state: "ready", scanned: 1, projected: 0, collisions: 0,
  });
  const initial = readCommittedNativeThreadInventoryV1({ stateRoot: value.stateRoot });
  assert.equal(initial.state, "ready");
  privateFile(join(value.stateRoot, "native-catalog.v1.journal.jsonl"), "{\"incomplete\":true}\n");
  assert.deepEqual(readCommittedNativeThreadInventoryV1({ stateRoot: value.stateRoot }), {
    state: "unavailable", reason: "journal_ambiguous",
  });
});

test("unverifiable catalog rows share an asynchronous census without reusing it for writes", { timeout: 5_000 }, async () => {
  for (const outcome of ["clear", "conflict", "unknown", "repaired"] as const) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const batchStarted = new Promise<void>((resolve) => { started = resolve; });
    let batchCalls = 0;
    const f = fixture("paginated", {
      exactThreadCensus: () => { throw new Error("catalog diagnostics must not perform per-row synchronous scans"); },
      catalogThreadCensus: async (ids) => {
        batchCalls += 1;
        assert.equal(ids.length, 33);
        started();
        await held;
        return new Map(ids.map((id) => [id, outcome === "repaired" ? "clear" : outcome]));
      },
    });
    try {
      await ready(f);
      const rows = f.db.rows.get(join(f.sourceSqlite, "state_5.sqlite"))!;
      const missingPaths: string[] = [];
      for (let i = 0; i < 33; i += 1) {
        const id = `unavailable-thread-${i}`;
        const path = f.sourceRollout.replace(THREAD_ID, id);
        const row = nativeRow(path, "paginated");
        rows.set(id, { ...row, threadId: id, values: { ...row.values, id } });
        missingPaths.push(path);
      }
      const pending = f.coordinator.reconcileCatalog({ project: false });
      await batchStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (outcome === "repaired") for (const path of missingPaths) privateFile(path, "repaired during observation\n");
      release();
      const result = await pending;
      assert.equal(batchCalls, 1);
      assert.deepEqual(result, { state: outcome === "clear" ? "collision" : "ready", scanned: 34, projected: 0, collisions: outcome === "clear" ? 33 : 0 });
      assert.equal(f.coordinator.ownerForThread("unavailable-thread-0"), null, "unverified rows never gain an owner");
      const transfer = await f.coordinator.prepareSameThreadTransfer({ operationId: `batch-${outcome}`, threadId: THREAD_ID,
        sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B });
      assert.notEqual(transfer.state, "ready", "a prior clear observation cannot replace the fresh write census");
    } finally { release(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("runtime probe rejects unknown inputs and requires an observed private writer lock", async () => {
  assert.deepEqual(await probeNativeTransferCapabilityV1({ command: "", args: [] }), {
    state: "unsupported", reason: "invalid_probe_input",
  });
  const missingLockProgram = [
    "const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});",
    "rl.on('line',(line)=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='thread/start')result={thread:{id:'probe-thread',historyMode:'paginated'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});",
  ].join("");
  assert.deepEqual(await probeNativeTransferCapabilityV1({
    command: process.execPath,
    args: ["-e", missingLockProgram, "app-server"],
    timeoutMs: 2_000,
  }), { state: "unsupported", reason: "writer_lock_missing" });

  const readyProgram = [
    "const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});",
    "if(!process.env.CODEX_HOME||process.env.CODEX_SQLITE_HOME!==process.env.CODEX_HOME||process.env.HOME!==process.env.CODEX_HOME||process.cwd()!==process.env.CODEX_HOME)throw Error('probe homes are not isolated');",
    "rl.on('line',(line)=>{const m=JSON.parse(line);if(!m.id)return;let response={jsonrpc:'2.0',id:m.id,result:{}};",
    "if(m.method==='initialize'&&(!(m.params?.clientInfo?.name==='tweakers-native-transfer-probe')||m.params?.capabilities?.experimentalApi!==true))response={jsonrpc:'2.0',id:m.id,error:{code:-32600,message:'bad initialize'}};",
    "if(m.method==='thread/start'){const d=path.join(process.env.CODEX_HOME,'thread-writer-locks');fs.mkdirSync(d,{recursive:true,mode:0o755});fs.chmodSync(d,0o755);fs.writeFileSync(path.join(d,'probe-thread.lock'),'',{mode:0o644});response={jsonrpc:'2.0',id:m.id,result:{thread:{id:'probe-thread',historyMode:'paginated'}}};}",
    "process.stdout.write(JSON.stringify(response)+'\\n');});",
  ].join("");
  assert.deepEqual(await probeNativeTransferCapabilityV1({
    command: process.execPath,
    args: ["-e", readyProgram, "app-server"],
    timeoutMs: 2_000,
  }), { state: "ready", writerLockProtocol: "shared_thread_writer_locks_v1", paginatedHistory: true });
  let spawns = 0;
  assert.deepEqual(await probeNativeTransferCapabilityV1({
    command: "/fixture/codex",
    args: ["-c", "features.code_mode_host=true", "app-server", "-c", 'mcp_servers.codex_app={url="http://private-app-socket"}'],
    cwd: process.cwd(), timeoutMs: 2_000,
    spawn: ((command, args, options) => {
      spawns += 1;
      assert.equal(command, "/fixture/codex");
      assert.deepEqual(args, ["app-server"], "the capability probe never reuses desktop overrides");
      const env = options!.env!;
      assert.notEqual(env.HOME, process.env.HOME);
      assert.deepEqual(Object.keys(env).sort(), ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_FILE", "SSL_CERT_DIR"]
        .filter(key => typeof process.env[key] === "string")
        .concat(["HOME", "TMPDIR", "TMP", "TEMP", "CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED"]).sort());
      return spawn(process.execPath, ["-e", readyProgram, "app-server"], options);
    }) as typeof spawn,
  }), { state: "ready", writerLockProtocol: "shared_thread_writer_locks_v1", paginatedHistory: true });
  assert.equal(spawns, 1);
});

test("paginated catalog mirroring refuses writes while read-only ownership aggregation remains available", async (t) => {
  const f = fixture("paginated"); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await ready(f);
  assert.deepEqual(await f.coordinator.reconcileCatalog(), { state: "unsupported", reason: "paginated_catalog_mirroring_refused" });
  assert.equal(f.db.rows.get(join(f.targetSqlite, "state_5.sqlite"))!.size, 0);
  assert.equal((await f.coordinator.reconcileCatalog({ project: false })).state, "ready");
  assert.equal(f.coordinator.ownerForThread(THREAD_ID), ACCOUNT_A);
});

test("v2 paginated A-B-A preserves edited streams and filtered rows, refuses drift, and keeps v1 recovery artifacts", async (t) => {
  const f = fixture("paginated"); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const sourceDb = join(f.sourceSqlite, "state_5.sqlite");
  const targetDb = join(f.targetSqlite, "state_5.sqlite");
  const sourceHistory = join(f.sourceSqlite, "thread_history_1.sqlite");
  const targetHistory = join(f.targetSqlite, "thread_history_1.sqlite");
  const unrelated = "11111111-2222-3333-4444-555555555555";
  for (const path of [sourceDb, targetDb]) {
    execFileSync("/usr/bin/sqlite3", [path, "CREATE TABLE threads (" + schema.columns.map((column) => column.name + " " + column.affinity + (column.primaryKey ? " PRIMARY KEY" : "")).join(",") + ");"]);
    chmodSync(path, 0o600);
  }
  const source = nativeRow(f.sourceRollout, "paginated");
  execFileSync("/usr/bin/sqlite3", [sourceDb, "INSERT INTO threads (" + Object.keys(source.values).join(",") + ") VALUES (" + Object.values(source.values).map((value) => value === null ? "NULL" : typeof value === "number" ? String(value) : "'" + String(value).replaceAll("'", "''") + "'").join(",") + ");"]);
  const historySchema = "CREATE TABLE _sqlx_migrations (\n    version BIGINT PRIMARY KEY,\n    description TEXT NOT NULL,\n    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    success BOOLEAN NOT NULL,\n    checksum BLOB NOT NULL,\n    execution_time BIGINT NOT NULL\n);\nCREATE TABLE thread_history_projection_state (\n    thread_id TEXT PRIMARY KEY,\n    next_rollout_byte_offset INTEGER NOT NULL,\n    next_rollout_ordinal INTEGER NOT NULL\n);\nCREATE TABLE thread_items (\n    thread_id TEXT NOT NULL,\n    turn_id TEXT NOT NULL,\n    item_id TEXT NOT NULL,\n    rollout_ordinal INTEGER NOT NULL,\n    created_at_ms INTEGER NOT NULL,\n    item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0,\n    PRIMARY KEY (thread_id, turn_id, item_id)\n);\nCREATE TABLE thread_realtime_items (\n    thread_id TEXT NOT NULL,\n    item_id TEXT NOT NULL,\n    rollout_ordinal INTEGER NOT NULL,\n    created_at_ms INTEGER NOT NULL,\n    item_type TEXT NOT NULL,\n    item_json TEXT NOT NULL,\n    PRIMARY KEY (thread_id, item_id)\n);\nCREATE TABLE thread_turns (\n    thread_id TEXT NOT NULL,\n    turn_id TEXT NOT NULL,\n    rollout_ordinal INTEGER NOT NULL,\n    status TEXT NOT NULL,\n    error_json TEXT,\n    started_at INTEGER,\n    completed_at INTEGER,\n    duration_ms INTEGER,\n    first_user_item_id TEXT,\n    final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER,\n    PRIMARY KEY (thread_id, turn_id)\n);\nCREATE INDEX idx_thread_items_by_turn_page\n    ON thread_items(thread_id, turn_id, rollout_ordinal);\nCREATE INDEX idx_thread_items_by_turn_updated_page\n    ON thread_items(thread_id, turn_id, updated_at_ordinal);\nCREATE UNIQUE INDEX idx_thread_items_page\n    ON thread_items(thread_id, rollout_ordinal);\nCREATE INDEX idx_thread_items_updated_page\n    ON thread_items(thread_id, updated_at_ordinal);\nCREATE INDEX idx_thread_items_user_messages\n    ON thread_items(thread_id, rollout_ordinal)\n    WHERE item_type = 'userMessage';\nCREATE INDEX idx_thread_realtime_items_boundary\n    ON thread_realtime_items(thread_id, rollout_ordinal)\n    WHERE item_type IN ('realtime_session_started', 'realtime_session_closed');\nCREATE UNIQUE INDEX idx_thread_realtime_items_page\n    ON thread_realtime_items(thread_id, rollout_ordinal);\nCREATE INDEX idx_thread_turns_end_page\n    ON thread_turns(thread_id, rollout_end_ordinal, turn_id)\n    WHERE rollout_end_ordinal IS NOT NULL;\nCREATE UNIQUE INDEX idx_thread_turns_page\n    ON thread_turns(thread_id, rollout_ordinal);\nCREATE TRIGGER thread_realtime_items_projection_cleanup\n    AFTER DELETE ON thread_history_projection_state\nBEGIN\n    DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id;\nEND;\nINSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (1,'thread history',1,X'2AD9A4AB17DF511FB73F03337133DE94A172DC0A1F5729B5EF61FE106DB03D1A43BDB5978B0CB7D7BC74071D3CA34A92',0);\nINSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (2,'thread items item type',1,X'AE61DBC1A6422530AA93914DBCAC363A0238B86AE1A9D77EB041C75330E1283A0FCF93A043DEEEFCD6FD2C4037694BC4',0);\nINSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (3,'turn rollout positions',1,X'A51DA2A11DF7760D8F8CAB221E82B36CE8C0A30F16D44F3602E7F0FBC622CA72F1C3E3ECF22A194E12C2222BDCB51AFE',0);\nINSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (4,'thread items updated at ordinal',1,X'65F33B171BD3AAFE9D24728B2CA6A5C720A3AB54AED472998F8ACF7489F0D35B2DFD12258A2D17BE993BF17098B5E50C',0);\nINSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (5,'thread realtime items',1,X'2FDAD8E361DC1F828AFACF10BD2EB1F511B02DEEF7FA234A9C412D0211DE126D1CFAD54B175C9C3A9731548F9084B437',0);\nINSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (6,'thread turn ends',1,X'02ED82D375ADB58B5C0C09E0154F3331D507CEA7AF446D12324E5653CDBA9A91F84AFD38CF2A29F33030614689DEB9DE',0);\n";
  for (const path of [sourceHistory, targetHistory]) {
    execFileSync("/usr/bin/sqlite3", [path, historySchema]); chmodSync(path, 0o600);
  }
  execFileSync("/usr/bin/sqlite3", [sourceHistory, `INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status) VALUES ('${THREAD_ID}','turn-original',0,'completed'); INSERT INTO thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json) VALUES ('${THREAD_ID}','turn-original','item-original',0,1,'original item'); INSERT INTO thread_history_projection_state VALUES ('${THREAD_ID}',${lstatSync(f.sourceRollout).size},1); INSERT INTO thread_realtime_items VALUES ('${THREAD_ID}','realtime-original',0,1,'realtime_session_started','original realtime');`]);
  execFileSync("/usr/bin/sqlite3", [targetHistory, `INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status) VALUES ('${unrelated}','private',0,'completed');`]);
  const db = new Sqlite3NativeCatalogDbV1();
  let pauseSnapshotReceipt: string | null = null;
  let sourceOffline = true;
  let leaseHeld = false;
  let targetWriterProved = false;
  let leaseSupported = true;
  let externalWriter = false;
  const options: NativeTransferCoordinatorOptionsV1 = { accountOfflinePreflight: () => sourceOffline && !(pauseSnapshotReceipt && existsSync(pauseSnapshotReceipt)), acquirePreparationLease: (directory, threadId) => {
    if (!leaseSupported) return { state: "unavailable" };
    if (leaseHeld || externalWriter) return { state: "busy" };
    const path = join(directory, threadId + ".lock");
    if (!existsSync(path)) privateFile(path, "");
    const stat = lstatSync(path);
    leaseHeld = true;
    return { state: "ready", lease: { dev: String(stat.dev), ino: String(stat.ino), isHeld: () => leaseHeld,
      release: () => { leaseHeld = false; } } };
  }, resumedWriterLockProof: () => targetWriterProved, stateRoot: f.stateRoot, accounts: [
    { accountId: ACCOUNT_A, codexHome: f.sourceHome, sqliteHome: f.sourceSqlite },
    { accountId: ACCOUNT_B, codexHome: f.targetHome, sqliteHome: f.targetSqlite },
  ], primaryAccountId: ACCOUNT_A, db, capabilityProbe: async () => ({ state: "ready", writerLockProtocol: "shared_thread_writer_locks_v1", paginatedHistory: true }), bindingPreflight: () => true, writerCensus: () => true, exactThreadCensus: () => "clear", recoveryCompatibilityPreflight: () => true };
  let coordinator = new NativeTransferCoordinatorV1(options);
  await coordinator.probeCapability(); assert.equal(coordinator.provisionSharedWriterLocks().state, "ready");
  const reconciled = await coordinator.reconcileCatalog({ project: false });
  assert.equal(reconciled.state, "ready", JSON.stringify(reconciled));
  const legacyDocument = JSON.parse(readFileSync(join(f.stateRoot, "native-catalog.v1.json"), "utf8"));
  legacyDocument.threads[unrelated] = { ...structuredClone(legacyDocument.threads[THREAD_ID]), threadId: unrelated };
  legacyDocument.threads[unrelated].projections[ACCOUNT_A].targetPath = join(f.sourceHome, "sessions", "missing-unrelated.jsonl");
  const originalV1 = JSON.stringify(legacyDocument);
  privateFile(join(f.stateRoot, "native-catalog.v1.json"), originalV1);
  const legacyCanonical = JSON.stringify(legacyDocument, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  const legacyJournal = JSON.stringify({ version: 1, digest: "sha256:" + createHash("sha256").update(legacyCanonical).digest("hex"), document: legacyDocument });
  privateFile(join(f.stateRoot, "native-catalog.v1.journal.jsonl"), legacyJournal);
  execFileSync("/usr/bin/sqlite3", [sourceDb, `UPDATE threads SET preview='ordinary edit after v1 catalog' WHERE id='${THREAD_ID}';`]);
  coordinator = new NativeTransferCoordinatorV1(options);
  assert.equal(await coordinator.sourceProjectionReady(THREAD_ID, ACCOUNT_A), true);
  const incompatibleRecovery = new NativeTransferCoordinatorV1({ ...options, recoveryCompatibilityPreflight: () => false });
  assert.equal((await incompatibleRecovery.prepareSameThreadTransfer({ operationId: "no-recovery", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B })).state, "unsupported");
  assert.equal(existsSync(join(f.stateRoot, "native-transfer.minimum-runtime.json")), false);
  assert.equal(readFileSync(join(f.stateRoot, "native-catalog.v1.json"), "utf8"), originalV1);
  leaseSupported = false;
  assert.equal((await coordinator.prepareSameThreadTransfer({ operationId: "missing-lease", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B })).state, "unsupported");
  leaseSupported = true; externalWriter = true;
  assert.equal((await coordinator.prepareSameThreadTransfer({ operationId: "external-writer", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B })).state, "busy");
  assert.equal(await db.readExact(targetDb, THREAD_ID), null, "missing or occupied native lease leaves target untouched");
  externalWriter = false;
  execFileSync("/usr/bin/sqlite3", [targetHistory, "CREATE TABLE unreviewed_migration (id TEXT);"]);
  assert.equal((await coordinator.prepareSameThreadTransfer({ operationId: "v2-first", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B })).state, "unsupported");
  assert.equal(await db.readExact(targetDb, THREAD_ID), null, "unreviewed schema does not publish a target row");
  execFileSync("/usr/bin/sqlite3", [targetHistory, "DROP TABLE unreviewed_migration;"]);
  const refresh = db.refreshProjection.bind(db);
  let raceOnce = true;
  db.refreshProjection = async (input) => {
    assert.equal(leaseHeld, true, "native writer lease covers target publication");
    await refresh(input);
    if (raceOnce) {
      raceOnce = false;
      appendFileSync(f.sourceRollout, "concurrent preserved write\n");
      execFileSync("/usr/bin/sqlite3", [sourceHistory, `UPDATE thread_history_projection_state SET next_rollout_byte_offset=${lstatSync(f.sourceRollout).size} WHERE thread_id='${THREAD_ID}';`]);
    }
  };
  const changedDuringPublication = await coordinator.prepareSameThreadTransfer({ operationId: "v2-first", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B });
  assert.equal(changedDuringPublication.state, "busy", "source mutation during publication never authorizes resume");
  assert.equal(coordinator.ownerForThread(THREAD_ID), ACCOUNT_A);
  assert.match(readFileSync(f.sourceRollout, "utf8"), /concurrent preserved write/);
  coordinator = new NativeTransferCoordinatorV1(options);
  assert.deepEqual((await coordinator.recoverInterruptedTransfers(new Map([[ACCOUNT_A, []], [ACCOUNT_B, []]]))).heldOperationIds, ["v2-first"], "unprobed locks cannot release an orphan");
  await coordinator.probeCapability();
  assert.deepEqual((await coordinator.recoverInterruptedTransfers(new Map([[ACCOUNT_A, []], [ACCOUNT_B, []]]))).settledOperationIds, ["v2-first"], "preparing orphan is released without replay");
  const first = await coordinator.prepareSameThreadTransfer({ operationId: "v2-first-recovered", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B });
  assert.equal(first.state, "ready", "selected owner migrates despite ordinary metadata edit and unrelated stale provenance"); if (first.state !== "ready") return;
  leaseHeld = false;
  assert.equal(await coordinator.revalidatePrepared(first.operationId), false, "lost preparation lease cannot authorize dispatch");
  leaseHeld = true;
  assert.equal(await coordinator.revalidatePrepared(first.operationId), true);
  assert.equal(leaseHeld, true, "preparation retains the exclusive lease");
  coordinator.markResumeDispatching(first.operationId);
  const probeRestart = new NativeTransferCoordinatorV1(options); await probeRestart.probeCapability();
  assert.deepEqual((await probeRestart.recoverInterruptedTransfers(new Map([[ACCOUNT_A, []], [ACCOUNT_B, []]]))).heldOperationIds, [first.operationId], "crash after warmup dispatch remains held because resume could succeed after lease release");
  const lockedProbe = { error: { code: -32600, message: `thread ${THREAD_ID} already has an active writer` } };
  assert.equal(await coordinator.confirmPreparationProbeBlocked(first.operationId, { error: { code: -32600, message: "unrelated error" } }), false);
  leaseHeld = false; assert.equal(await coordinator.confirmPreparationProbeBlocked(first.operationId, lockedProbe), false); leaseHeld = true;
  const beforeProbePreview = execFileSync("/usr/bin/sqlite3", [sourceDb, `SELECT preview FROM threads WHERE id='${THREAD_ID}';`], { encoding: "utf8" }).trim();
  execFileSync("/usr/bin/sqlite3", [sourceDb, `UPDATE threads SET preview='changed during warmup' WHERE id='${THREAD_ID}';`]);
  assert.equal(await coordinator.confirmPreparationProbeBlocked(first.operationId, lockedProbe), false, "changed generation cannot clear dispatched probe");
  execFileSync("/usr/bin/sqlite3", [sourceDb, `UPDATE threads SET preview='${beforeProbePreview.replaceAll("'", "''")}' WHERE id='${THREAD_ID}';`]);
  assert.equal(await coordinator.confirmPreparationProbeBlocked(first.operationId, lockedProbe), true);
  assert.equal(await coordinator.revalidatePrepared(first.operationId), true);
  coordinator.markResumeDispatching(first.operationId);
  assert.equal(coordinator.releasePreparationLeaseForResume(first.operationId), true);
  assert.equal(leaseHeld, false);
  assert.equal(await coordinator.revalidateResumedGeneration(first.operationId), false, "target must prove exact native writer ownership");
  targetWriterProved = true;
  const lockPath = join(f.sourceHome, "thread-writer-locks", THREAD_ID + ".lock");
  const savedLockPath = lockPath + ".retained";
  renameSync(lockPath, savedLockPath); privateFile(lockPath, "");
  assert.equal(await coordinator.revalidateResumedGeneration(first.operationId), false, "a replacement writer inode cannot prove transfer");
  rmSync(lockPath); renameSync(savedLockPath, lockPath);
  assert.equal(await coordinator.revalidateResumedGeneration(first.operationId), true);
  assert.equal(coordinator.settleResume(first.operationId, { thread: { id: THREAD_ID, path: first.targetPath } }).state, "proved");
  coordinator = new NativeTransferCoordinatorV1(options);
  assert.equal(coordinator.pendingWriterCommits().length, 1, "proved resume survives restart without replay");
  coordinator.commitWriter(first.operationId);
  assert.equal(coordinator.ownerForThread(THREAD_ID), ACCOUNT_B);
  assert.equal(coordinator.canEnableRemote(ACCOUNT_A), false, "remote cannot resume a transferred-away projection");
  const retirementIndexPath = join(f.stateRoot, "native-source-retirements.v2", "index.json");
  const retirementIndexBytes = readFileSync(retirementIndexPath);
  for (const corrupt of [true, false]) {
    if (corrupt) writeFileSync(retirementIndexPath, "invalid json"); else rmSync(retirementIndexPath);
    assert.equal(coordinator.hasPendingSourceRetirement(THREAD_ID), true, "missing or corrupt committed evidence holds continuation");
    assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_B), false);
    assert.equal(coordinator.canEnableRemote(ACCOUNT_B), false);
    privateFile(retirementIndexPath, retirementIndexBytes.toString());
  }
  assert.equal(coordinator.canEnableRemote(ACCOUNT_B), false, "pending retirement holds current target remote");
  await coordinator.probeCapability();
  assert.equal(coordinator.reconcileRemoteWriter(new Map([[ACCOUNT_A, [{ threadId: THREAD_ID }]], [ACCOUNT_B, []]])).state, "busy");
  for (const path of [sourceDb, targetDb]) execFileSync("/usr/bin/sqlite3", [path, "ALTER TABLE threads ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0; ALTER TABLE threads ADD COLUMN project_id TEXT; ALTER TABLE threads ADD COLUMN thread_section_id TEXT; ALTER TABLE threads ADD COLUMN section_position INTEGER; ALTER TABLE threads ADD COLUMN section_entered_at_ms INTEGER;"]);
  execFileSync("/usr/bin/sqlite3", [sourceDb, "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('source-private-project','Private project'); CREATE TABLE thread_sections(id TEXT PRIMARY KEY,name TEXT); INSERT INTO thread_sections VALUES('source-private-section','Private section');"]);
  execFileSync("/usr/bin/sqlite3", [sourceDb, `UPDATE threads SET thread_section_id='source-private-section',section_position=7,section_entered_at_ms=12345,is_pinned=1,project_id='source-private-project' WHERE id='${THREAD_ID}';`]);
  const sourceUnrelated = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
  const sourceUnrelatedPath = join(f.sourceHome, "sessions", "2026", "09", "05", sourceUnrelated + ".jsonl");
  privateFile(sourceUnrelatedPath, "unrelated source history\n");
  execFileSync("/usr/bin/sqlite3", [sourceDb, `INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,history_mode,archived) SELECT '${sourceUnrelated}','${sourceUnrelatedPath}',created_at,updated_at,source,model_provider,cwd,'unrelated source',sandbox_policy,approval_mode,history_mode,archived FROM threads WHERE id='${THREAD_ID}';`]);
  execFileSync("/usr/bin/sqlite3", [sourceHistory, `INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status) VALUES ('${sourceUnrelated}','private-source',0,'completed');`]);
  const unrelatedSourceRow = await db.readExact(sourceDb, sourceUnrelated);
  const unrelatedSourceHistory = await db.readHistorySnapshot(sourceHistory, [sourceUnrelated]);
  mkdirSync(join(f.sourceHome, "archived_sessions"), { mode: 0o700 });
  const archive = join(f.sourceHome, "archived_sessions", THREAD_ID + ".jsonl");
  privateFile(archive, readFileSync(f.sourceRollout, "utf8"));
  sourceOffline = false;
  assert.deepEqual(await coordinator.retireSourceProjection(first.operationId), { state: "held" });
  assert.equal(existsSync(f.sourceRollout), true, "resident source cannot be retired");
  sourceOffline = true;
  const compressed = archive + ".gz"; privateFile(compressed, "unsupported compressed selected stream");
  assert.deepEqual(await coordinator.retireSourceProjection(first.operationId), { state: "held" });
  assert.equal(existsSync(f.sourceRollout), true); rmSync(compressed);
  const unsafeLink = join(f.sourceHome, "archived_sessions", THREAD_ID + "_99999999-aaaa-4bbb-8ccc-dddddddddddd.jsonl");
  symlinkSync(f.sourceRollout, unsafeLink);
  assert.deepEqual(await coordinator.retireSourceProjection(first.operationId), { state: "held" });
  assert.equal(existsSync(f.sourceRollout), true); rmSync(unsafeLink);
  const retirementRoot = join(f.stateRoot, "native-source-retirements.v2", createHash("sha256").update(first.operationId).digest("hex"));
  pauseSnapshotReceipt = join(retirementRoot, "receipt.json");
  assert.deepEqual(await coordinator.retireSourceProjection(first.operationId), { state: "held" }, "interruption after snapshot intent leaves source intact");
  assert.equal(existsSync(f.sourceRollout), true);
  assert.equal(coordinator.hasPendingSourceRetirement(THREAD_ID), true);
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_B), false, "remote target cannot bypass pending retirement");
  pauseSnapshotReceipt = null;
  mkdirSync(join(retirementRoot, "snapshots"), { mode: 0o700 });
  const partialSnapshot = join(retirementRoot, "snapshots", ".0000.jsonl.partial-interrupted");
  privateFile(partialSnapshot, "truncated");
  const deleteRetiredRows = db.compareAndDeleteRetirementRows.bind(db);
  let retirementDeleteStage = 0;
  db.compareAndDeleteRetirementRows = async (...args) => {
    retirementDeleteStage += 1;
    if (retirementDeleteStage === 1) execFileSync("/usr/bin/sqlite3", [sourceDb, `UPDATE threads SET is_pinned=0 WHERE id='${THREAD_ID}';`]);
    await deleteRetiredRows(...args);
    if (retirementDeleteStage === 2) throw new Error("simulated interruption after row transaction committed");
  };
  assert.deepEqual(await coordinator.retireSourceProjection(first.operationId), { state: "held" }, "a full UI-metadata change prevents deletion after stream moves");
  assert.equal(existsSync(f.sourceRollout), false);
  assert.equal(existsSync(archive), false);
  assert.notEqual(await db.readExact(sourceDb, THREAD_ID), null);
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_A), false);
  execFileSync("/usr/bin/sqlite3", [sourceDb, `UPDATE threads SET is_pinned=1 WHERE id='${THREAD_ID}';`]);
  coordinator = new NativeTransferCoordinatorV1(options); await coordinator.probeCapability();
  assert.deepEqual(coordinator.pendingSourceRetirements().map((operation) => operation.operationId), [first.operationId]);
  assert.deepEqual((await coordinator.recoverSourceRetirements()).heldOperationIds, [first.operationId], "an interrupted row transaction stays held until absence is verified");
  assert.equal(await db.readExact(sourceDb, THREAD_ID), null);
  coordinator = new NativeTransferCoordinatorV1(options); await coordinator.probeCapability();
  assert.deepEqual((await coordinator.recoverSourceRetirements()).retiredOperationIds, [first.operationId]);
  assert.deepEqual(coordinator.pendingSourceRetirements(), []);
  assert.equal(coordinator.isCommittedProjection(THREAD_ID, ACCOUNT_A), false);
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_A), true);
  assert.equal(coordinator.canEnableRemote(ACCOUNT_A), false, "sync eligibility never opens from a saved receipt alone");
  assert.equal(readFileSync(partialSnapshot, "utf8"), "truncated", "interrupted copy is retained without poisoning atomic publication");
  const retiredReceipt = JSON.parse(readFileSync(join(retirementRoot, "receipt.json"), "utf8")).receipt;
  assert.equal(retiredReceipt.rows.row.is_pinned, 1); assert.equal(retiredReceipt.rows.row.project_id, "source-private-project");
  for (let index = 0; index < retiredReceipt.files.length; index += 1) {
    const snapshot = join(retirementRoot, "snapshots", String(index).padStart(4, "0") + ".jsonl");
    assert.notEqual(lstatSync(snapshot).ino, retiredReceipt.files[index].identity.ino, "retained snapshots cannot share the live target inode");
    assert.equal(readFileSync(snapshot, "utf8"), readFileSync(first.targetPath, "utf8"));
  }
  privateFile(f.sourceRollout, "unexpected rediscovered source projection\n");
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_A), false, "a new selected path invalidates fresh eligibility");
  rmSync(f.sourceRollout);
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_A), true);
  assert.deepEqual(await db.readExact(sourceDb, sourceUnrelated), unrelatedSourceRow);
  assert.deepEqual(await db.readHistorySnapshot(sourceHistory, [sourceUnrelated]), unrelatedSourceHistory);
  assert.equal(coordinator.ownerForThread(THREAD_ID), ACCOUNT_B);
  assert.equal((await coordinator.prepareSameThreadTransfer({ operationId: "v2-first", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B })).state, "busy", "a committed continuation is never replayed");
  const linkId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const edit = join(f.targetHome, "sessions", "2026", "09", "05", THREAD_ID + "_" + linkId + ".jsonl");
  privateFile(edit, "edited continuation\n");
  execFileSync("/usr/bin/sqlite3", [targetDb, `UPDATE threads SET rollout_path='${edit}', preview='edited' WHERE id='${THREAD_ID}';`]);
  execFileSync("/usr/bin/sqlite3", [targetHistory, `INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status) VALUES ('${linkId}','turn-edit',0,'completed'); INSERT INTO thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json) VALUES ('${linkId}','turn-edit','item-edit',0,1,'edited item'); INSERT INTO thread_history_projection_state VALUES ('${linkId}',${lstatSync(edit).size},2); INSERT INTO thread_realtime_items VALUES ('${linkId}','realtime-edit',0,1,'realtime_session_closed','edited realtime');`]);
  assert.equal((await coordinator.reconcileCatalog({ project: false })).state, "ready");
  const beforeReturnIndex = readFileSync(retirementIndexPath);
  for (const corrupt of [true, false]) {
    if (corrupt) writeFileSync(retirementIndexPath, "invalid json"); else rmSync(retirementIndexPath);
    const blockedReturn = await coordinator.prepareSameThreadTransfer({ operationId: "v2-return", threadId: THREAD_ID, sourceAccountId: ACCOUNT_B, targetAccountId: ACCOUNT_A });
    assert.notEqual(blockedReturn.state, "ready", "return cannot infer empty local values from unavailable prior evidence");
    assert.equal(await db.readExact(sourceDb, THREAD_ID), null);
    privateFile(retirementIndexPath, beforeReturnIndex.toString());
  }
  const locked = spawn("/usr/bin/sqlite3", [sourceHistory], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (locked.exitCode === null) locked.kill(); });
  const lockReady = new Promise<void>((resolve, reject) => { locked.stdout.once("data", () => resolve()); locked.once("error", reject); });
  locked.stdin.write("BEGIN IMMEDIATE; SELECT 'locked';\n");
  await lockReady;
  let preparations = 0;
  const replace = db.replaceHistorySnapshot.bind(db);
  db.replaceHistorySnapshot = async (...args) => { preparations += 1; return replace(...args); };
  const blocked = await coordinator.prepareSameThreadTransfer({ operationId: "v2-return", threadId: THREAD_ID, sourceAccountId: ACCOUNT_B, targetAccountId: ACCOUNT_A });
  assert.equal(blocked.state, "unavailable");
  assert.equal(preparations, 3, "lock contention retries preparation only three times");
  assert.equal(coordinator.ownerForThread(THREAD_ID), ACCOUNT_B);
  const lockClosed = new Promise<void>((resolve) => locked.once("close", () => resolve()));
  locked.stdin.end("ROLLBACK;\n.quit\n"); await lockClosed;
  execFileSync("/usr/bin/sqlite3", [sourceDb, "DELETE FROM projects WHERE id='source-private-project';"]);
  assert.equal((await coordinator.prepareSameThreadTransfer({ operationId: "v2-return", threadId: THREAD_ID, sourceAccountId: ACCOUNT_B, targetAccountId: ACCOUNT_A })).state, "unavailable", "missing local project reference cannot silently lose or reassign metadata");
  assert.equal(await db.readExact(sourceDb, THREAD_ID), null);
  execFileSync("/usr/bin/sqlite3", [sourceDb, "INSERT INTO projects VALUES('source-private-project','Private project');"]);
  coordinator = new NativeTransferCoordinatorV1(options); await coordinator.probeCapability();
  assert.deepEqual((await coordinator.recoverInterruptedTransfers(new Map([[ACCOUNT_A, []], [ACCOUNT_B, []]]))).settledOperationIds, ["v2-return"]);
  const second = await coordinator.prepareSameThreadTransfer({ operationId: "v2-return-recovered", threadId: THREAD_ID, sourceAccountId: ACCOUNT_B, targetAccountId: ACCOUNT_A });
  assert.equal(second.state, "ready"); if (second.state !== "ready") return;
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_A), false, "return preparation invalidates the older retirement receipt");
  assert.equal(coordinator.isCommittedProjection(THREAD_ID, ACCOUNT_A), true);
  assert.equal(readFileSync(second.targetPath, "utf8"), "edited continuation\n");
  assert.equal(lstatSync(second.targetPath).ino, lstatSync(edit).ino);
  assert.equal((await db.readExact(sourceDb, THREAD_ID))!.rolloutPath, second.targetPath);
  const restoredLocal = JSON.parse(execFileSync("/usr/bin/sqlite3", [sourceDb, `SELECT json_object('pin',is_pinned,'project',project_id,'section',thread_section_id,'position',section_position,'entered',section_entered_at_ms) FROM threads WHERE id='${THREAD_ID}';`], { encoding: "utf8" }));
  assert.deepEqual(restoredLocal, { pin: 1, project: "source-private-project", section: "source-private-section", position: 7, entered: 12345 }, "return keeps target-local UI fields from its own frozen snapshot");
  const copied = await db.readHistorySnapshot(sourceHistory, [THREAD_ID, linkId]);
  assert.equal(copied.rows.thread_turns!.length, 2);
  assert.equal(copied.rows.thread_items!.length, 2);
  assert.equal(copied.rows.thread_realtime_items!.length, 2);
  assert.equal(execFileSync("/usr/bin/sqlite3", [targetHistory, `SELECT turn_id FROM thread_turns WHERE thread_id='${unrelated}';`], { encoding: "utf8" }).trim(), "private");
  assert.equal(await coordinator.revalidatePrepared(second.operationId), true);
  coordinator.markResumeDispatching(second.operationId);
  assert.equal(coordinator.releasePreparationLeaseForResume(second.operationId), true);
  assert.equal(await coordinator.revalidateResumedGeneration(second.operationId), true);
  assert.equal(coordinator.settleResume(second.operationId, { thread: { id: THREAD_ID, path: second.targetPath } }).state, "proved");
  coordinator.commitWriter(second.operationId);
  assert.equal(coordinator.ownerForThread(THREAD_ID), ACCOUNT_A);
  assert.deepEqual(await coordinator.retireSourceProjection(first.operationId), { state: "held" }, "a historical outgoing operation never retires the current owner after return");
  assert.ok(!coordinator.pendingSourceRetirements().some((operation) => operation.operationId === first.operationId));
  db.compareAndDeleteRetirementRows = deleteRetiredRows;
  assert.deepEqual(await coordinator.retireSourceProjection(second.operationId), { state: "retired" });
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_B), true);
  assert.equal(existsSync(join(retirementRoot, "receipt.json")), true, "old source snapshots remain retained after return");
  assert.equal(coordinator.canEnableRemote(ACCOUNT_A), true, "verified return restores safe remote enablement");
  assert.equal(coordinator.canEnableRemote(ACCOUNT_B), false);
  const thirdHome = privateDirectory(join(f.root, "third-home"));
  const thirdSqlite = privateDirectory(join(f.root, "third-sqlite"));
  execFileSync("/usr/bin/sqlite3", [join(thirdSqlite, "state_5.sqlite"), execFileSync("/usr/bin/sqlite3", [sourceDb, ".schema threads"], { encoding: "utf8" })]);
  execFileSync("/usr/bin/sqlite3", [join(thirdSqlite, "thread_history_1.sqlite"), historySchema]);
  chmodSync(join(thirdSqlite, "state_5.sqlite"), 0o600); chmodSync(join(thirdSqlite, "thread_history_1.sqlite"), 0o600);
  options.accounts = [...options.accounts, { accountId: ACCOUNT_C, codexHome: thirdHome, sqliteHome: thirdSqlite }];
  assert.equal(coordinator.updateAccounts(options.accounts).state, "ready");
  assert.equal(coordinator.provisionSharedWriterLocks().state, "ready");
  const outboundThird = await coordinator.prepareSameThreadTransfer({ operationId: "v2-third-account", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_C });
  assert.equal(outboundThird.state, "ready"); if (outboundThird.state !== "ready") return;
  coordinator.markResumeDispatching(outboundThird.operationId); assert.equal(coordinator.releasePreparationLeaseForResume(outboundThird.operationId), true);
  assert.equal(await coordinator.revalidateResumedGeneration(outboundThird.operationId), true);
  assert.equal(coordinator.settleResume(outboundThird.operationId, { thread: { id: THREAD_ID, path: outboundThird.targetPath } }).state, "proved");
  coordinator.commitWriter(outboundThird.operationId);
  assert.deepEqual(await coordinator.retireSourceProjection(outboundThird.operationId), { state: "retired" });
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_B), true, "an earlier retired B remains safe after the owner advances to C");
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_A), true);
  const returnThird = await coordinator.prepareSameThreadTransfer({ operationId: "v2-third-return", threadId: THREAD_ID, sourceAccountId: ACCOUNT_C, targetAccountId: ACCOUNT_A });
  assert.equal(returnThird.state, "ready"); if (returnThird.state !== "ready") return;
  coordinator.markResumeDispatching(returnThird.operationId); assert.equal(coordinator.releasePreparationLeaseForResume(returnThird.operationId), true);
  assert.equal(await coordinator.revalidateResumedGeneration(returnThird.operationId), true);
  assert.equal(coordinator.settleResume(returnThird.operationId, { thread: { id: THREAD_ID, path: returnThird.targetPath } }).state, "proved");
  coordinator.commitWriter(returnThird.operationId);
  assert.deepEqual(await coordinator.retireSourceProjection(returnThird.operationId), { state: "retired" });
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_B), true);
  assert.equal(await coordinator.verifyRemoteEligibility(ACCOUNT_C), true);
  assert.ok(!coordinator.pendingSourceRetirements().some((operation) => operation.sourceAccountId === ACCOUNT_A));
  const third = await coordinator.prepareSameThreadTransfer({ operationId: "v2-drift", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B });
  assert.equal(third.state, "ready"); if (third.state !== "ready") return;
  coordinator.releasePreparationLease(third.operationId); // Simulates process exit releasing its OS lease.
  coordinator = new NativeTransferCoordinatorV1(options); await coordinator.probeCapability();
  assert.deepEqual((await coordinator.recoverInterruptedTransfers(new Map([[ACCOUNT_A, []], [ACCOUNT_B, [{ threadId: THREAD_ID }]], [ACCOUNT_C, []]]))).heldOperationIds, ["v2-drift"], "loaded target cannot be released");
  assert.deepEqual((await coordinator.recoverInterruptedTransfers(new Map([[ACCOUNT_A, []], [ACCOUNT_B, []], [ACCOUNT_C, []]]))).settledOperationIds, ["v2-drift"], "prepared orphan is released without replay");
  const drift = await coordinator.prepareSameThreadTransfer({ operationId: "v2-drift-recovered", threadId: THREAD_ID, sourceAccountId: ACCOUNT_A, targetAccountId: ACCOUNT_B });
  assert.equal(drift.state, "ready"); if (drift.state !== "ready") return;
  execFileSync("/usr/bin/sqlite3", [sourceHistory, `UPDATE thread_items SET item_json='concurrent item edit' WHERE thread_id='${linkId}';`]);
  assert.equal(await coordinator.revalidatePrepared(drift.operationId), false, "history-only edits invalidate generation");
  coordinator.markResumeDispatching(drift.operationId);
  assert.equal(coordinator.releasePreparationLeaseForResume(drift.operationId), true);
  assert.equal(await coordinator.revalidateResumedGeneration(drift.operationId), false, "native resume changes cannot bypass strict generation verification");
  assert.equal(coordinator.settleResume(drift.operationId, { thread: { id: THREAD_ID, path: drift.targetPath } }).state, "ambiguous", "unverified resume cannot commit owner");
  appendFileSync(second.targetPath, "new write\n");
  assert.equal(await coordinator.revalidatePrepared(drift.operationId), false, "same inode append invalidates generation");
  assert.equal(await coordinator.sourceProjectionReady(THREAD_ID, ACCOUNT_A), false, "lagging projection refuses release");
  assert.equal(readFileSync(join(f.stateRoot, "native-catalog.v1.json"), "utf8"), originalV1);
  assert.equal(readFileSync(join(f.stateRoot, "native-catalog.v1.journal.jsonl"), "utf8"), legacyJournal);
  const marker = JSON.parse(readFileSync(join(f.stateRoot, "native-transfer.minimum-runtime.json"), "utf8"));
  assert.equal(inspectNativeTransferCompatibilityV2(marker, 1).state, "incompatible");
  assert.equal(inspectNativeTransferCompatibilityV2(marker, 2).state, "compatible");
  assert.equal(new NativeTransferCoordinatorV1(options).ownerForThread(THREAD_ID), ACCOUNT_A, "prepared transfer does not commit ownership");
  privateFile(join(f.stateRoot, "native-transfer.minimum-runtime.json"), JSON.stringify({ version: 1, minimumTransferVersion: 3 }));
  assert.throws(() => new NativeTransferCoordinatorV1(options), /incompatible/);
  assert.equal(JSON.parse(readFileSync(join(f.stateRoot, "native-transfer.minimum-runtime.json"), "utf8")).minimumTransferVersion, 3, "future reader requirements are never downgraded");
});
